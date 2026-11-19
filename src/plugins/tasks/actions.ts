// The task lifecycle and message links: every action this plugin registers runs here, inside the
// command's transaction. The core has already done the actor, idempotency and sourceEventId checks and resolved the refs.
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { actorKey, canonical, CollaborationError, personName, required, strings } from '../../core/collaboration.ts';
import { MAX_FILES_PER_MESSAGE } from '../../core/files.ts';
import { gitRepositoryPathSync, gitSync, sameRepositoryPath } from '../../core/projects.ts';
import type {
  Approval, Assignment, Attention, CollaborationActor, CollaborationResult, CoordinatorPermission, Merge, Review,
  CollaborationCommand, Submission, Takeover, TakeoverBasis, Task, TaskChange, TaskChangeField, TaskCloseKind, TaskCloseReason, TaskPriority,
  TaskSummary,
} from '../../core/collaboration-types.ts';
import type { Collaboration } from '../../core/collaboration.ts';
import type { PluginActionContext, PluginRefContext } from '../../core/plugin.ts';
import type { Store, StoredMember } from '../../core/store.ts';
import type { HubEvent, SystemMessageKind } from '../../core/types.ts';
import { allTasks, completionValid, displayTask, eligible, fail, memberName, missingRoleNames, participantKeys, resolveTaskRef, shipState, taskDependencyEvaluation, taskOf, versions } from './model.ts';
import { batchLabel, batchSnapshot, batchTransitions, checkJoin, refuseEarlyReview, resolveBatchRef } from './batches.ts';
import { decideBranchLink } from './branch-link.ts';
import { announceLibrary, applyTaskLabels } from './labels.ts';
import { noticeBody } from './notices.ts';
import { allowsTaskRoles, requireTaskPermission, taskPermissions } from './permissions.ts';
import { mergedOnTarget, shipRunner } from './ship.ts';
import { authoriseSelfReview, selfReviewBound, selfReviewHolder, takeoverRecords } from './takeover.ts';
import { runWatchAction, takeWatches, taskEnd, watchNoticeBody, type TaskEnd } from './watches.ts';
import {
  collaborationLinkCount, collaborationLinkedMessageIds, collaborationRecord, collaborationRecords, deleteCollaborationTask,
  linkCollaborationMessage, nextTaskNumber, saveCollaborationRecord, saveCollaborationTask, saveTaskBatch, taskBatch, unlinkCollaborationMessage,
  batchTaskRows,
} from './store.ts';

const priority = (value: unknown): TaskPriority => {
  if (value !== 'low' && value !== 'normal' && value !== 'high') return fail('INVALID_REQUEST', 'priority must be low, normal or high');
  return value;
};
const boolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') return fail('INVALID_REQUEST', field + ' must be boolean');
  return value;
};
const commitSha = (value: unknown, mandatory: boolean): string | null => {
  if ((value === undefined || value === null) && !mandatory) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value)) return fail('INVALID_REQUEST', 'commitSha must be 7-40 hexadecimal characters');
  return value.toLowerCase();
};
const STORED_REPOSITORY_GONE = 'the task\'s linked repository is no longer at its path; clear the link with gitBranch null to use your own folder, or ask the user to choose the repository on the page';
const reviewReason = (value: unknown, mandatory: boolean): string => {
  if (mandatory) return required(value, 'reason', 50_000);
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 50_000) return fail('INVALID_REQUEST', 'reason must be at most 50000 characters');
  return value.trim();
};

/** Task fields recorded in an event's `changes` (docs/collaboration-api.md). */
const CHANGE_FIELDS: TaskChangeField[] = ['title', 'scope', 'acceptance', 'priority', 'labels', 'reviewer',
  'executeRoleIds', 'reviewRoleIds', 'dependencyIds', 'requiresApproval', 'mergeRequired', 'fileIds', 'gitBranch'];
/** A recorded change may carry at most this many UTF-8 bytes per text value; longer values are cut and flagged. */
const MAX_CHANGE_TEXT_BYTES = 20_000;
/** Cut a string to the byte limit on a character boundary (a multi-byte character is never split). */
const capChangeString = (value: string): { value: string; truncated: boolean } => {
  if (Buffer.byteLength(value, 'utf8') <= MAX_CHANGE_TEXT_BYTES) return { value, truncated: false };
  let out = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > MAX_CHANGE_TEXT_BYTES) break;
    out += character;
    used += size;
  }
  return { value: out, truncated: true };
};
const snapshot = (task: Task | null): Record<TaskChangeField, unknown> => ({
  title: task ? task.title : null,
  scope: task ? task.scope : null,
  acceptance: task ? task.acceptance : null,
  priority: task ? task.priority : null,
  labels: task ? [...task.labels] : [],
  reviewer: task ? structuredClone(task.reviewer) : null,
  executeRoleIds: task ? [...task.executeRoleIds] : [],
  reviewRoleIds: task ? [...task.reviewRoleIds] : [],
  dependencyIds: task ? [...task.dependencyIds] : [],
  requiresApproval: task?.requiresApproval ?? false,
  mergeRequired: task?.mergeRequired ?? false,
  fileIds: task ? [...task.fileIds] : [],
  gitBranch: task?.gitBranch ?? null,
});
/** Cut over-long text anywhere in a value, reporting whether anything was cut. */
const capChangeText = (value: unknown): { value: unknown; truncated: boolean } => {
  let truncated = false;
  const cap = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const capped = capChangeString(item);
      truncated ||= capped.truncated;
      return capped.value;
    }
    if (Array.isArray(item)) return item.map(cap);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, cap(inner)]));
    return item;
  };
  return { value: cap(value), truncated };
};
/** Fields that actually changed between two tasks (create: before = the empty definition). */
const taskChanges = (store: Store, before: Task | null, after: Task): TaskChange[] => {
  const from = snapshot(before), to = snapshot(after);
  const changes: TaskChange[] = [];
  for (const field of CHANGE_FIELDS) {
    if (canonical(from[field]) === canonical(to[field])) continue;
    const beforeValue = capChangeText(from[field]), afterValue = capChangeText(to[field]);
    changes.push({ field, before: beforeValue.value, after: afterValue.value,
      ...(beforeValue.truncated || afterValue.truncated ? { truncated: true } : {}),
      ...(field === 'fileIds' ? { fileNames: Object.fromEntries([...(before?.fileIds ?? []), ...after.fileIds].map((id) => [id, store.getFile(id)?.name ?? id])) } : {}) });
  }
  return changes;
};

/**
 * A hidden member cannot be given work (docs/cluster-members.md「隐身」). The user and the coordinator, who see hidden
 * members, are told why; anyone else gets the same answer as for a name that matches no member.
 */
export function refuseHidden(store: Store, clusterId: string, actor: CollaborationActor, actorId: string, memberId: string): void {
  if (!store.getMember(memberId)?.hiddenAt) return;
  const policy = store.coordinator?.policy(clusterId);
  if (actor.kind === 'user' || (policy?.enabled && policy.memberId === actorId)) {
    fail('FORBIDDEN', `${memberName(store, memberId)} is hidden and cannot be given a task; show it again first or choose another member`);
  }
  fail('OUT_OF_SCOPE', 'unknown member in this cluster; list_agents shows each memberId and name');
}

function reviewerOf(collaboration: Collaboration, clusterId: string, value: unknown, hidden: (id: string) => void = () => {}): CollaborationActor {
  if (value && typeof value === 'object' && (value as CollaborationActor).kind === 'user') return { kind: 'user' };
  if (value && typeof value === 'object' && (value as CollaborationActor).kind === 'self') return { kind: 'self' };
  if (value && typeof value === 'object' && (value as CollaborationActor).kind === 'member') {
    const member = collaboration.member(clusterId, (value as { memberId?: unknown }).memberId);
    hidden(member.id);
    return { kind: 'member', memberId: member.id };
  }
  return fail('INVALID_REQUEST', 'reviewer must be the user, a member or self');
}

/** A definition's attachments: distinct stored files of this cluster, as many as one message may carry. */
function taskFileIds(store: Store, clusterId: string, value: unknown): string[] {
  if (Array.isArray(value) && value.length > MAX_FILES_PER_MESSAGE) return fail('INVALID_REQUEST', `fileIds must list at most ${MAX_FILES_PER_MESSAGE} files`);
  const ids = strings(value, 'fileIds');
  for (const id of ids) if (store.getFile(id)?.clusterId !== clusterId) return fail('OUT_OF_SCOPE', 'unknown file; use a file ID from this cluster');
  return ids;
}

/** Every task of the cluster that lists this task as a dependency; a deleted task must not leave them dangling. */
const dependents = (store: Store, clusterId: string, taskId: string): Task[] =>
  [...allTasks(store, clusterId)].filter((task) => task.dependencyIds.includes(taskId));

function checkDependencies(store: Store, clusterId: string, taskId: string, ids: string[]): void {
  const visit = (id: string, seen: Set<string>): void => {
    if (id === taskId) return fail('DEPENDENCY_CYCLE', 'task dependencies form a cycle');
    if (seen.has(id)) return;
    seen.add(id);
    const dependency = taskOf(store, clusterId, id);
    for (const parent of dependency.dependencyIds) visit(parent, seen);
  };
  for (const id of ids) visit(id, new Set());
}

/** The coordinator coordinates: it cannot be given a task or work on one. */
function refuseCoordinator(store: Store, clusterId: string, memberId: string): void {
  const policy = store.coordinator?.policy(clusterId);
  if (policy?.enabled && policy.memberId === memberId) fail('FORBIDDEN', `${memberName(store, memberId)} is the coordinator and cannot execute tasks; assign another member instead`);
}

function executor(store: Store, actor: CollaborationActor, actorId: string, task: Task, assignmentId: unknown): Assignment {
  if (actor.kind !== 'member') return fail('FORBIDDEN', 'only the assigned member can report work; release or hand off the task instead');
  refuseCoordinator(store, task.clusterId, actorId);
  const assignment = collaborationRecords<Assignment>(store, task.id, 'assignment').find((a) => a.id === assignmentId);
  if (!assignment || task.currentAssignmentId !== assignment.id || assignment.endedAt || assignment.memberId !== actorId) {
    return fail('STALE_ASSIGNMENT', 'the assignment is no longer active for this member');
  }
  return assignment;
}

const CLOSE_KINDS: TaskCloseKind[] = ['not_planned', 'duplicate', 'superseded', 'other'];
const RELATED_KINDS: TaskCloseKind[] = ['duplicate', 'superseded'];
/** task.cancel's closeReason: left out it is other; duplicate and superseded name another task of this cluster. */
function closeReasonOf(store: Store, clusterId: string, taskId: string, command: CollaborationCommand): TaskCloseReason {
  const kind = command.closeReason ?? 'other';
  if (!CLOSE_KINDS.includes(kind)) return fail('INVALID_REQUEST', 'closeReason must be not_planned, duplicate, superseded or other');
  if (!RELATED_KINDS.includes(kind)) {
    if (command.relatedTaskId != null) return fail('INVALID_REQUEST', 'relatedTaskId is only accepted with closeReason duplicate or superseded');
    return { kind };
  }
  if (command.relatedTaskId == null) return fail('INVALID_REQUEST', `relatedTaskId is required when closeReason is ${kind}`);
  const related = taskOf(store, clusterId, command.relatedTaskId);
  if (related.id === taskId) return fail('INVALID_REQUEST', 'relatedTaskId must name another task, not the one being cancelled');
  return { kind, taskId: related.id };
}

/** Every later check, the event and any suggestion see full IDs, whichever form the caller used. */
export function resolveTaskRefs({ store, clusterId, command, collaboration }: PluginRefContext) {
  const { action } = command;
  const out = { ...command };
  const task = (ref: string) => resolveTaskRef(store, clusterId, ref);
  const message = (ref: string, unknown: string) => collaboration.resolveId('messages', clusterId, ref, unknown);
  if (action.startsWith('task.') && action !== 'task.create') out.taskId = task(command.taskId as string);
  if (action === 'task.create' || action === 'task.edit' || action === 'task.takeover') {
    if (Array.isArray(command.dependencyIds) && action !== 'task.takeover') out.dependencyIds = command.dependencyIds.map(task);
    if (command.reviewer?.kind === 'member') out.reviewer = { kind: 'member', memberId: collaboration.memberRef(clusterId, command.reviewer.memberId) };
  }
  if (action === 'task.create' && command.originMessageId) out.originMessageId = message(command.originMessageId, 'unknown source message');
  if (action === 'task.create' && command.batchId != null) out.batchId = resolveBatchRef(store, clusterId, command.batchId);
  if (action === 'task.submit' && Array.isArray(command.evidenceMessageIds)) {
    out.evidenceMessageIds = command.evidenceMessageIds.map((id) => message(id, 'unknown evidence message'));
  }
  if (action === 'task.assign' || action === 'task.nominate' || action === 'task.handoff' || (action === 'task.create' && command.memberId !== undefined)) out.memberId = collaboration.memberRef(clusterId, command.memberId);
  if (action === 'message.link') {
    if (command.messageId) out.messageId = message(command.messageId, 'unknown message');
    if (Array.isArray(command.taskIds)) out.taskIds = command.taskIds.map(task);
    if (Array.isArray(command.removeTaskIds)) out.removeTaskIds = command.removeTaskIds.map(task);
  }
  if (action === 'task.cancel' && typeof command.relatedTaskId === 'string' && RELATED_KINDS.includes(command.closeReason!)) out.relatedTaskId = task(command.relatedTaskId);
  return out;
}

export function runTaskAction(ctx: PluginActionContext): Partial<CollaborationResult> & Record<string, unknown> {
  const { store, actor, actorId, clusterId, command, now, collaboration } = ctx;
  const action = command.action;
  const manualMark = action === 'task.mark_completed' || action === 'task.mark_merged';
  if (manualMark && actor.kind !== 'user') return fail('FORBIDDEN', 'only the user can manually mark a task completed or merged');
  const out: Partial<CollaborationResult> = {};
  let changes: TaskChange[] = [];
  let task: Task | undefined;
  let deleted: CollaborationResult['deleted'];
  let deletedMessageIds: string[] = [];
  let previousExecutor: string | null = null;
  let staleTaskNotices: { memberId: string; actions: string[] } | null = null;
  let wasDependencyReady = false;
  let approvalRequired = false;
  const recipients = new Set<string>();
  // Info recipients get the notice in their unread list but no delivery/wake (K2 notification tiers).
  const infoOnly = new Set<string>();
  let suggest = false;
  let labelsCreated = false;   // task.create / task.edit added labels to the library
  let stoppedMemberId: string | undefined;
  let closeReason: TaskCloseReason | undefined;
  const management = (permission: CoordinatorPermission, ordinaryAllowed = false) => { suggest = ctx.management(permission, ordinaryAllowed); };
  const member = (id: unknown): StoredMember => collaboration.member(clusterId, id);
  const roleIds = (value: unknown, field: string) => collaboration.roleIds(clusterId, value, field);
  const reviewer = (value: unknown) => reviewerOf(collaboration, clusterId, value, (id) => refuseHidden(store, clusterId, actor, actorId, id));
  const isEligible = (id: string, roles: string[]) => eligible(store, clusterId, id, roles);
  const missing = (id: string, roles: string[]) => missingRoleNames(store, clusterId, id, roles).join(', ');
  const permissions = taskPermissions(store, clusterId);
  const requireGroupRole = (id: string, field: Parameters<typeof requireTaskPermission>[3]) =>
    requireTaskPermission(store, clusterId, id, field, permissions);
  const records = <T>(kind: string) => collaborationRecords<T>(store, task!.id, kind);
  const save = (kind: string, record: { id: string }) => saveCollaborationRecord(store, task!.id, kind, record);
  const newAssignment = (): Assignment => ({ id: randomUUID(), taskId: task!.id, memberId: actorId, actorKey: actorKey(member(actorId)),
    acceptedAt: now, startedAt: null, endedAt: null, endReason: null, dependencyVersions: {} });
  // ---- reviewer takeover (docs/collaboration.md「验收者接手」): the records are the source of truth ----
  const takenOver = () => takeoverRecords(store, task!.id).length > 0;
  /** Appends a takeover-style record and the task's display mark together, so the two cannot disagree. */
  const recordTakeover = (draft: Pick<Takeover, 'fromMemberId' | 'toMemberId' | 'reviewFrom' | 'reviewTo' | 'basis'> & Partial<Pick<Takeover, 'previousStatus'>>) => {
    const record: Takeover = { id: randomUUID(), taskId: task!.id, action, by: actorId, previousStatus: task!.status, ...draft,
      previousRejected: records<Review>('review').at(-1)?.verdict === 'reject', createdAt: now };
    if (!suggest) save('takeover', record);
    task!.takeover = { recordId: record.id, memberId: record.toMemberId, basis: record.basis, at: now };
    out.takeover = record;
  };
  /**
   * The one writer of task.reviewer after creation (task.edit, task.takeover). On a taken-over task the enabled
   * coordinator cannot be named (it cannot review), and a switch to self goes through the rule and binds self review to
   * the executor. `takeover` is task.takeover's own record, already authorised there.
   */
  const setReviewer = (next: CollaborationActor, takeover?: Parameters<typeof recordTakeover>[0]) => {
    const policy = store.coordinator?.policy(clusterId);
    if (next.kind === 'member' && policy?.enabled && policy.memberId === next.memberId && (takeover || takenOver())) {
      fail('FORBIDDEN', `${memberName(store, next.memberId)} is the coordinator and cannot review; name the user or another member`);
    }
    let binding = takeover;
    if (!binding && next.kind === 'self' && task!.reviewer.kind !== 'self' && takenOver()) {
      const executorId = task!.assignedMemberId;
      if (!executorId) fail('INVALID_STATE', 'self review on a taken-over task is bound to its executor; assign the executor first');
      binding = { fromMemberId: executorId, toMemberId: executorId!, reviewFrom: task!.reviewer, reviewTo: next,
        basis: authoriseSelfReview(store, clusterId, actor, 'switching this taken-over task to self review') };
    }
    if (binding) recordTakeover(binding);
    task!.reviewer = next;
  };
  /**
   * A taken-over task whose self review is bound to someone else gets a new executor: the rule must authorise self
   * review for the new one (it is recorded), or the change is refused. Nothing switches the review mode by itself.
   */
  const rebindSelf = (id: string) => {
    if (task!.reviewer.kind !== 'self' || !takenOver()) return;
    const holder = selfReviewHolder(store, task!.id);
    if (holder === id) return;
    const basis = authoriseSelfReview(store, clusterId, actor, `giving this task to ${memberName(store, id)} (its self review is authorised for `
      + `${holder ? memberName(store, holder) : 'nobody'}; to hand it over without that, first have the user or the coordinator change the reviewer to the user or a member)`);
    recordTakeover({ fromMemberId: task!.assignedMemberId, toMemberId: id, reviewFrom: task!.reviewer, reviewTo: task!.reviewer, basis });
  };
  /** Who may be this task's executor; the reviewer never is (docs/collaboration.md, roles). */
  const checkExecutor = (id: string) => {
    refuseHidden(store, clusterId, actor, actorId, id);
    refuseCoordinator(store, clusterId, id);
    requireGroupRole(id, 'executeRoleIds');
    if (!isEligible(id, task!.executeRoleIds)) fail('ROLE_REQUIRED', `${memberName(store, id)} lacks roles: ${missing(id, task!.executeRoleIds)}`);
    if (task!.reviewer.kind === 'member' && task!.reviewer.memberId === id) {
      fail('REVIEW_NOT_INDEPENDENT', `${memberName(store, id)} is the task reviewer, so they cannot execute it; for the reviewer to do the work, use task_action takeover instead (the reviewer becomes the executor and you choose who reviews after it)`);
    }
    rebindSelf(id);
  };
  /** The executor cannot start yet, so an assignment only informs them: the dependency-ready notice wakes them later. */
  const waitsOnDependencies = () => versions(store, task!) === null;
  const approve = (verdict: unknown) => {
    if (actor.kind !== 'user') return fail('FORBIDDEN', 'only the user can approve a proposal; ask the user to approve it');
    if (!task || task.proposalState !== 'proposed' || task.status !== 'pending') {
      return fail('INVALID_STATE', 'task is not awaiting approval');
    }
    if (verdict !== 'approve' && verdict !== 'reject') return fail('INVALID_REQUEST', 'verdict is required');
    const approval: Approval = { id: randomUUID(), taskId: task.id, verdict,
      reason: reviewReason(command.reason, verdict === 'reject'), definitionVersion: task.definitionVersion, createdAt: now };
    save('approval', approval);
    if (verdict === 'approve') { task.proposalState = 'active'; approvalRequired = false; }
    // Who must act is woken: the executor after an approval; the creator after a rejection or when nobody is lined up
    // to start. A creator who only needs to know stays info-only.
    const owners = verdict === 'approve' && task.assignedMemberId ? [task.assignedMemberId] : [];
    for (const id of owners) { recipients.add(id); infoOnly.delete(id); }
    recipients.add(task.createdBy);
    if (owners.length && !owners.includes(task.createdBy)) infoOnly.add(task.createdBy); else infoOnly.delete(task.createdBy);
    out.approval = approval;
  };
  if (action === 'task.watch' || action === 'task.unwatch') return runWatchAction(ctx);
  // Where the task stood before this action, and who brought it to an end: a watcher who did is not told (watches.ts).
  let endBefore: TaskEnd | null = null;
  let endedBy = actorId;
  if (action.startsWith('task.') && action !== 'task.create') {
    task = taskOf(store, clusterId, command.taskId);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== task.revision) {
      return fail('STALE_REVISION', 'task revision changed');
    }
    endBefore = taskEnd(store, task);
  }
  // A task in a review batch: where the batch stood before this change, so afterEvent tells only the change that completes
  // it (batches.ts batchTransitions). Read in this transaction, so concurrent submits or a cancel cannot both cross the line.
  const batchId = task?.batchId ?? (action === 'task.create' && typeof command.batchId === 'string' ? command.batchId : undefined);
  const batchBefore = batchSnapshot(store, clusterId, batchId);
  let leftBatch: string | undefined;
  if (action === 'task.create') {
    management('taskPlanning', true);
    const coordinator = store.coordinator?.policy(clusterId);
    const coordinatorBypass = coordinator?.enabled && coordinator.memberId === actorId && coordinator.taskPlanningRoleBypass === true;
    if (actor.kind === 'member' && !coordinatorBypass) {
      requireGroupRole(actorId, 'createRoleIds');
    }
    if (command.reviewer !== undefined || command.reviewRoleIds !== undefined) management('reviewerManagement', true);
    if (command.memberId !== undefined) management('assignment', true);
    const id = randomUUID();
    const dependencyIds = strings(command.dependencyIds, 'dependencyIds');
    checkDependencies(store, clusterId, id, dependencyIds);
    if (command.originMessageId && store.getMessage(command.originMessageId)?.clusterId !== clusterId) return fail('OUT_OF_SCOPE', 'unknown source message');
    task = { id, number: 0 /* taken when saved, below */, clusterId, title: required(command.title, 'title', 500), scope: required(command.scope, 'scope'),
      acceptance: required(command.acceptance, 'acceptance'), priority: priority(command.priority ?? 'normal'),
      createdBy: actorId, originMessageId: command.originMessageId ?? null,
      status: 'pending', proposalState: 'active', revision: 1, definitionVersion: 1,
      requiresApproval: boolean(command.requiresApproval === undefined ? false : command.requiresApproval, 'requiresApproval'),
      mergeRequired: boolean(command.mergeRequired === undefined ? true : command.mergeRequired, 'mergeRequired'), mergedCommitSha: null, mergedSubmissionId: null,
      reviewer: command.reviewer ? reviewer(command.reviewer) : { kind: 'user' },
      executeRoleIds: roleIds(command.executeRoleIds, 'executeRoleIds'),
      reviewRoleIds: roleIds(command.reviewRoleIds, 'reviewRoleIds'),
      labels: applyTaskLabels(store, clusterId, actorId, strings(command.labels, 'labels'), [], { write: !suggest, now, check: true,
        onCreated: () => { labelsCreated = true; } }),
      dependencyIds, fileIds: taskFileIds(store, clusterId, command.fileIds),
      currentAssignmentId: null, latestSubmissionId: null, approvedSubmissionId: null, assignedMemberId: null,
      dependenciesReady: true, dependenciesChanged: false, completionValid: false, createdAt: now, updatedAt: now };
    if (batchId) {
      // Created in a review batch: it takes the batch's reviewer (docs/collaboration.md「验收批次」).
      const batch = taskBatch(store, clusterId, batchId) ?? fail('OUT_OF_SCOPE', 'unknown batch in this cluster; get_batch lists them');
      const policy = store.coordinator?.policy(clusterId);
      if (actor.kind === 'member' && !(policy?.enabled && policy.memberId === actorId) && batch.createdBy !== actorId) {
        return fail('FORBIDDEN', `only the batch creator, the user or the coordinator can add tasks to ${batchLabel(batch)}`);
      }
      if (command.reviewer !== undefined && canonical(task.reviewer) !== canonical(batch.reviewer)) {
        return fail('INVALID_REQUEST', 'a task in a batch is reviewed by the batch reviewer; leave reviewer out');
      }
      task.reviewer = structuredClone(batch.reviewer);
      checkJoin(store, batch, task);
      task.batchId = batch.id;
      if (!suggest) {
        batch.notified = null;   // the old ready notice did not include this task
        saveTaskBatch(store, batch);
      }
    }
    if (task.reviewer.kind === 'member') {
      if (!task.batchId) requireGroupRole(task.reviewer.memberId, 'reviewRoleIds');
      if (!isEligible(task.reviewer.memberId, task.reviewRoleIds)) {
        return fail('ROLE_REQUIRED', `reviewer ${memberName(store, task.reviewer.memberId)} lacks roles: ${missing(task.reviewer.memberId, task.reviewRoleIds)}`);
      }
    }
    if (task.requiresApproval) { task.proposalState = 'proposed'; approvalRequired = true; }
    if (command.memberId !== undefined) {
      task.assignedMemberId = command.memberId === null ? null : member(command.memberId).id;
      if (task.assignedMemberId) { checkExecutor(task.assignedMemberId); recipients.add(task.assignedMemberId); if (waitsOnDependencies()) infoOnly.add(task.assignedMemberId); }
    } else {
      // Nobody named: the creator does it when they can.
      if (actor.kind === 'member' && !(coordinator?.enabled && coordinator.memberId === actorId) && isEligible(actorId, task.executeRoleIds)
        && allowsTaskRoles(store, clusterId, actorId, permissions.executeRoleIds)
        && !(task.reviewer.kind === 'member' && task.reviewer.memberId === actorId)) task.assignedMemberId = actorId;
    }
    changes = taskChanges(store, null, task);
  } else if (action === 'task.edit' && task) {
    const hasEditableFields = command.reviewer !== undefined || command.reviewRoleIds !== undefined
      || command.title !== undefined || command.priority !== undefined || command.labels !== undefined || command.scope !== undefined
      || command.acceptance !== undefined || command.executeRoleIds !== undefined || command.dependencyIds !== undefined
      || command.proposalState !== undefined || command.requiresApproval !== undefined || command.mergeRequired !== undefined
      || command.fileIds !== undefined;
    if (!hasEditableFields) return fail('INVALID_REQUEST', 'no editable fields were provided');
    // Every task of a batch has the batch's reviewer and needs a merge; to change either, the task leaves the batch first.
    if (task.batchId && ((command.reviewer !== undefined && canonical(command.reviewer) !== canonical(task.reviewer)) || command.mergeRequired === false)) {
      const batch = taskBatch(store, clusterId, task.batchId);
      return fail('INVALID_STATE', `the task is in ${batch ? batchLabel(batch) : 'a review batch'}, whose tasks all have its reviewer and need a merge; remove it from the batch (batch remove, before its work starts) or cancel the batch first`);
    }
    const unstarted = task.status === 'pending';
    const reviewerEdit = command.reviewer !== undefined || command.reviewRoleIds !== undefined;
    const metaOnly = !reviewerEdit && command.scope === undefined && command.acceptance === undefined
      && command.executeRoleIds === undefined && command.dependencyIds === undefined && command.proposalState === undefined
      && command.requiresApproval === undefined && command.mergeRequired === undefined && command.fileIds === undefined;
    const creator = task.createdBy === actorId;
    const policy = store.coordinator?.policy(clusterId);
    // An ordinary member (not the user, not the enabled coordinator) gets the specific reason; the others keep ctx.management's.
    const ordinary = actor.kind === 'member' && !(policy?.enabled && policy.memberId === actorId);
    const allow = (permission: CoordinatorPermission, allowed: boolean, reason: string) => {
      if (ordinary && !allowed) fail('FORBIDDEN', reason);
      management(permission, allowed);
    };
    // The creator may move the review elsewhere until the first review record (any verdict, self included);
    // after that only the user or the coordinator may.
    const reviewed = records<Review>('review').length > 0;
    if (reviewerEdit) {
      allow('reviewerManagement', creator && !reviewed, !creator
        ? 'only the task creator, the user or the coordinator can change the reviewer; ask one of them'
        : 'the task already has a review; ask the user or the coordinator to change the reviewer, or, if the reviewer should do the work, use task_action takeover');
    }
    // Title, priority and labels are bookkeeping: any member may tidy them while the task is not finished.
    if (command.title !== undefined || command.priority !== undefined || command.labels !== undefined || command.scope !== undefined || command.acceptance !== undefined
      || command.executeRoleIds !== undefined || command.dependencyIds !== undefined || command.proposalState !== undefined
      || command.requiresApproval !== undefined || command.mergeRequired !== undefined || command.fileIds !== undefined) {
      const finished = ['completed', 'merged', 'cancelled'].includes(task.status);
      allow('taskPlanning', creator || (metaOnly && !finished), metaOnly
        ? 'the task is finished; ask its creator, the user or the coordinator to edit it'
        : 'only the task creator, the user or the coordinator can change these fields; any member may edit the title, priority and labels of an unfinished task');
    }
    // Who reviews does not change the work, so reviewer fields neither need stopped work nor void a pending submission.
    if (reviewerEdit && !unstarted && task.status !== 'working' && task.status !== 'review') return fail('INVALID_STATE', 'task is already closed; reopen it first');
    const beforeEdit = structuredClone(task);
    if (command.title !== undefined) task.title = required(command.title, 'title', 500);
    if (command.priority !== undefined) task.priority = priority(command.priority);
    if (command.labels !== undefined) {
      task.labels = applyTaskLabels(store, clusterId, actorId, strings(command.labels, 'labels'), task.labels, { write: !suggest, now, check: 'changed',
        onCreated: () => { labelsCreated = true; } });
    }
    if (command.scope !== undefined) task.scope = required(command.scope, 'scope');
    if (command.mergeRequired !== undefined) task.mergeRequired = boolean(command.mergeRequired, 'mergeRequired');
    if (command.acceptance !== undefined) task.acceptance = required(command.acceptance, 'acceptance');
    if (command.fileIds !== undefined) task.fileIds = taskFileIds(store, clusterId, command.fileIds);
    if (command.executeRoleIds !== undefined) task.executeRoleIds = roleIds(command.executeRoleIds, 'executeRoleIds');
    if (command.reviewRoleIds !== undefined) task.reviewRoleIds = roleIds(command.reviewRoleIds, 'reviewRoleIds');
    if (command.reviewer !== undefined) setReviewer(reviewer(command.reviewer));
    // Once a result is waiting for review, self review could approve the executor's own pending submission;
    // switch the reviewer before submitting, not after (docs/collaboration.md).
    if (command.reviewer !== undefined && task.reviewer.kind === 'self' && task.status === 'review') {
      return fail('INVALID_STATE', 'a task in review cannot switch to self review');
    }
    // Self review lets the executor approve their own result, so once work starts only the user or the coordinator may choose it.
    if (command.reviewer !== undefined && task.reviewer.kind === 'self' && !unstarted && ordinary) {
      return fail('FORBIDDEN', 'work has started, so the creator cannot switch the task to self review; ask the user or the coordinator');
    }
    if (command.dependencyIds !== undefined) {
      const ids = strings(command.dependencyIds, 'dependencyIds'); checkDependencies(store, clusterId, task.id, ids); task.dependencyIds = ids;
    }
    if (task.reviewer.kind === 'member' && !isEligible(task.reviewer.memberId, task.reviewRoleIds)) return fail('ROLE_REQUIRED', `reviewer ${memberName(store, task.reviewer.memberId)} lacks roles: ${missing(task.reviewer.memberId, task.reviewRoleIds)}`);
    if (command.reviewer !== undefined && task.reviewer.kind === 'member') {
      if (canonical(task.reviewer) !== canonical(beforeEdit.reviewer)) requireGroupRole(task.reviewer.memberId, 'reviewRoleIds');
      const key = actorKey(member(task.reviewer.memberId));
      if (task.assignedMemberId === task.reviewer.memberId || participantKeys(records<Assignment>('assignment')).includes(key)) {
        return fail('REVIEW_NOT_INDEPENDENT', `reviewer ${memberName(store, task.reviewer.memberId)} participated in the task`);
      }
    }
    if (task.assignedMemberId && !isEligible(task.assignedMemberId, task.executeRoleIds)) return fail('ROLE_REQUIRED', `assignee ${memberName(store, task.assignedMemberId)} lacks roles: ${missing(task.assignedMemberId, task.executeRoleIds)}`);
    if (command.requiresApproval !== undefined) {
      const enabled = boolean(command.requiresApproval, 'requiresApproval');
      if (!enabled && actor.kind !== 'user') return fail('FORBIDDEN', 'only the user can disable approval');
      if (enabled !== task.requiresApproval) {
        if (['completed', 'merged', 'cancelled'].includes(task.status)) return fail('INVALID_STATE', 'task is already closed');
        if (enabled && (task.status !== 'pending' || task.currentAssignmentId)) return fail('INVALID_STATE', 'enable approval before assignment');
        task.requiresApproval = enabled;
        task.proposalState = enabled ? 'proposed' : 'active';
      }
    }
    changes = taskChanges(store, beforeEdit, task);
    const definitionChanged = changes.some((change) => ['scope', 'acceptance', 'executeRoleIds', 'dependencyIds', 'mergeRequired', 'fileIds'].includes(change.field));
    if (definitionChanged && !unstarted) return fail('INVALID_STATE', 'stop work before changing its definition; release or hand off the task first');
    if (definitionChanged) {
      task.definitionVersion++;
      if (task.requiresApproval) task.proposalState = 'proposed';
    }
    approvalRequired = beforeEdit.proposalState !== 'proposed' && task.proposalState === 'proposed';
    // The people who must act on this change: the executor and a member reviewer.
    // The coordinator is added/dropped by the notification-boundary rules below, like every other action.
    if (changes.length) {
      if (task.assignedMemberId) recipients.add(task.assignedMemberId);
      if (task.reviewer.kind === 'member') recipients.add(task.reviewer.memberId);
      if (beforeEdit.reviewer.kind === 'member') recipients.add(beforeEdit.reviewer.memberId);
      // 知会：只改标题/优先级/标签时不唤醒；被换下的旧验收者也只留未读。
      const onlyMeta = changes.every((change) => ['title', 'priority', 'labels', 'requiresApproval'].includes(change.field));
      if (onlyMeta) for (const id of recipients) infoOnly.add(id);
      // The user lifting the gate is the go-ahead for whoever is lined up to start.
      if (beforeEdit.proposalState === 'proposed' && task.proposalState === 'active') {
        if (task.assignedMemberId) infoOnly.delete(task.assignedMemberId);
      }
      if (beforeEdit.reviewer.kind === 'member'
        && (task.reviewer.kind !== 'member' || task.reviewer.memberId !== beforeEdit.reviewer.memberId)) {
        infoOnly.add(beforeEdit.reviewer.memberId);
      }
    }
    if (command.proposalState !== undefined) {
      if (command.proposalState !== 'active') return fail('FORBIDDEN', 'only the user can approve a proposal; ask the user to approve it');
      approve('approve');
    }
  } else if (action === 'task.approve' && task) {
    approve(command.verdict);
  } else if ((action === 'task.assign' || action === 'task.nominate' || action === 'task.claim') && task) {
    // nominate and claim are the deprecated names of assigning someone and assigning yourself; older clients still send them.
    const claim = action === 'task.claim';
    if (claim && actor.kind !== 'member') return fail('FORBIDDEN', 'only a member can claim a task; assign a member instead');
    const target = claim ? actorId : command.memberId === null ? null : member(command.memberId).id;
    // Anyone able to may pick up a task nobody holds; handing it to somebody else is for the creator, coordinator or user.
    const pickingUp = actor.kind === 'member' && target === actorId && (!task.assignedMemberId || task.assignedMemberId === actorId);
    if (claim && !pickingUp) return fail('FORBIDDEN', `${memberName(store, task.assignedMemberId ?? '')} is this task's executor; ask that member, the task creator, the coordinator or the user to change it`);
    if (!claim) management('assignment', pickingUp || task.createdBy === actorId);
    if (task.proposalState === 'proposed') return fail('APPROVAL_REQUIRED', 'task requires user approval');
    if (task.status !== 'pending' || (claim && task.currentAssignmentId)) return fail('TASK_ALREADY_CLAIMED', 'task is not available');
    if (target) checkExecutor(target);
    previousExecutor = task.assignedMemberId;
    if (target !== previousExecutor) {
      // Only an old 'accepted' task still has an unstarted assignment here; the new executor gets their own on start.
      const stale = records<Assignment>('assignment').find((a) => a.id === task!.currentAssignmentId);
      if (stale && !suggest) { stale.endedAt = now; stale.endReason = 'reassigned'; save('assignment', stale); }
      task.currentAssignmentId = null;
    }
    task.assignedMemberId = target;
    if (target) { recipients.add(target); if (waitsOnDependencies()) infoOnly.add(target); }
    if (previousExecutor && previousExecutor !== target) { recipients.add(previousExecutor); infoOnly.add(previousExecutor); }
    if (claim) {   // a session that still calls claim passes this assignment to start and submit
      out.assignment = newAssignment(); save('assignment', out.assignment); task.currentAssignmentId = out.assignment.id;
    }
  } else if (action === 'task.start' && task) {
    if (task.proposalState === 'proposed') return fail('APPROVAL_REQUIRED', 'task requires user approval');
    if (actor.kind !== 'member') return fail('FORBIDDEN', 'only the assigned member can report work; release or hand off the task instead');
    refuseCoordinator(store, clusterId, actorId);
    if (task.assignedMemberId !== actorId) return fail('STALE_ASSIGNMENT', 'this task is not assigned to you');
    // Optional in the new flow; a session still passing one must hold the current assignment.
    if (command.assignmentId !== undefined && command.assignmentId !== task.currentAssignmentId) return fail('STALE_ASSIGNMENT', 'the assignment is no longer active for this member');
    if (task.status !== 'pending') return fail('INVALID_STATE', 'task has already started; check its status with get_task');
    requireGroupRole(actorId, 'executeRoleIds');
    if (!isEligible(actorId, task.executeRoleIds)) return fail('ROLE_REQUIRED', `${memberName(store, actorId)} lacks roles: ${missing(actorId, task.executeRoleIds)}`);
    const current = versions(store, task);
    if (!current) return fail('DEPENDENCIES_NOT_READY', 'dependencies are not ready');
    // An old 'accepted' task or a claim already has its assignment; everything else gets its first one now.
    const assignment = records<Assignment>('assignment').find((a) => a.id === task!.currentAssignmentId) ?? newAssignment();
    assignment.startedAt = now; assignment.dependencyVersions = current; save('assignment', assignment);
    task.currentAssignmentId = assignment.id; task.status = 'working'; out.assignment = assignment;
  } else if (action === 'task.submit' && task) {
    let assignment: Assignment;
    let resubmission = false;
    if (task.status === 'completed' && !completionValid(store, task) && actor.kind === 'member') {
      refuseCoordinator(store, clusterId, actorId);
      const approved = records<Submission>('submission').find((s) => s.id === task!.approvedSubmissionId);
      const prior = approved && records<Assignment>('assignment').find((a) => a.id === approved.assignmentId);
      if (!approved || command.assignmentId !== approved.assignmentId) return fail('STALE_ASSIGNMENT', 'only the approved assignment can resubmit');
      if (!prior || prior.actorKey !== actorKey(member(actorId))) return fail('STALE_ASSIGNMENT', 'only the prior executor can resubmit');
      requireGroupRole(actorId, 'executeRoleIds');  // a new assignment, unlike submit on work already started
      if (!isEligible(actorId, task.executeRoleIds)) return fail('ROLE_REQUIRED', `${memberName(store, actorId)} lacks roles: ${missing(actorId, task.executeRoleIds)}`);
      const current = versions(store, task);
      if (!current) return fail('DEPENDENCIES_NOT_READY', 'dependencies are not ready');
      assignment = { id: randomUUID(), taskId: task.id, memberId: actorId, actorKey: prior.actorKey,
        acceptedAt: now, startedAt: now, endedAt: null, endReason: null, dependencyVersions: current };
      save('assignment', assignment);
      task.currentAssignmentId = assignment.id; task.assignedMemberId = actorId; task.approvedSubmissionId = null; task.status = 'working';
      out.assignment = assignment;
      resubmission = true;
    } else assignment = executor(store, actor, actorId, task, command.assignmentId);
    if (task.status !== 'working' && task.status !== 'review') return fail('INVALID_STATE', 'task is not working or awaiting review; start it first and check its status with get_task');
    const current = versions(store, task);
    if (!current) return fail('DEPENDENCIES_NOT_READY', 'dependencies are not ready');
    const declared = command.expectedDependencyVersions;
    if ((resubmission || canonical(assignment.dependencyVersions) !== canonical(current)) && declared === undefined) {
      return fail('DEPENDENCIES_CHANGED', 'declare the current dependency versions after reviewing them');
    }
    if (declared !== undefined && (!declared || typeof declared !== 'object' || Array.isArray(declared)
      || Object.values(declared).some((value) => typeof value !== 'string') || canonical(declared) !== canonical(current))) {
      return fail('DEPENDENCIES_CHANGED', 'declared dependency versions do not match the current versions');
    }
    const evidenceMessageIds = strings(command.evidenceMessageIds, 'evidenceMessageIds');
    const evidenceFileIds = strings(command.evidenceFileIds, 'evidenceFileIds');
    for (const id of evidenceMessageIds) if (store.getMessage(id)?.clusterId !== clusterId) return fail('OUT_OF_SCOPE', 'unknown evidence message');
    for (const id of evidenceFileIds) if (store.getFile(id)?.clusterId !== clusterId) return fail('OUT_OF_SCOPE', 'unknown evidence file; use a file ID from this cluster, or cite messages instead');
    const contributorKeys = participantKeys(records<Assignment>('assignment'));
    const submission: Submission = { id: randomUUID(), taskId: task.id, assignmentId: assignment.id,
      commitSha: commitSha(command.commitSha, task.mergeRequired),
      definitionVersion: task.definitionVersion, summary: required(command.summary, 'summary'), evidenceMessageIds, evidenceFileIds,
      contributorKeys, dependencyVersions: current, createdAt: now };
    save('submission', submission);
    task.latestSubmissionId = submission.id; out.submission = submission;
    // The automatic branch link (branch-link.ts): git was read before this transaction; a refusal below rolls it back too.
    const linkBefore = task.gitBranch ? { ...task.gitBranch } : null;
    const branchLink = decideBranchLink(task, ctx.prepared, actorId, submission.commitSha, store.getMember(actorId)?.cwd ?? null);
    if (branchLink) out.gitBranch = branchLink;
    if (canonical(linkBefore) !== canonical(task.gitBranch ?? null)) changes = [{ field: 'gitBranch', before: linkBefore, after: task.gitBranch ?? null }];
    if (task.reviewer.kind === 'self') {
      // SELF-BINDING CHECK: on a taken-over task, only the executor the latest record authorised may approve its own result.
      const bound = selfReviewBound(store, task.id, actorId);
      if (bound === false) {
        const holder = selfReviewHolder(store, task.id);
        return fail('FORBIDDEN', `self review on this taken-over task is authorised for ${holder ? memberName(store, holder) : 'nobody'}, not for you; ask the user to hand it to you on the page or to change the reviewer to the user or a member`);
      }
      // The executor's own summary is the review record; submission and completion commit in one transaction.
      const review: Review = { id: randomUUID(), taskId: task.id, submissionId: submission.id, reviewer: actor,
        verdict: 'approve', reason: submission.summary, self: true, createdAt: now,
        // The self review of the member who took the task over from its review: ship's Reviewed-by line says so.
        ...(bound === true ? { takeover: true as const } : {}) };
      save('review', review);
      assignment.endedAt = now; assignment.endReason = 'approved'; save('assignment', assignment);
      task.status = 'completed'; task.approvedSubmissionId = submission.id; task.currentAssignmentId = null; task.assignedMemberId = null;
      out.review = review;
    } else {
      task.status = 'review';
      // In a batch the reviewer is woken once, when the whole batch is submitted (batchTransitions); this one is only unread.
      if (task.reviewer.kind === 'member') { recipients.add(task.reviewer.memberId); if (task.batchId) infoOnly.add(task.reviewer.memberId); }
    }
  } else if (action === 'task.review' && task) {
    if (task.status !== 'review' || !task.latestSubmissionId || task.latestSubmissionId !== command.submissionId) return fail('STALE_SUBMISSION', 'submission is not the latest');
    if (actor.kind === 'member') {
      const policy = store.coordinator?.policy(clusterId);
      if (policy?.enabled && policy.memberId === actorId) return fail('FORBIDDEN', `${memberName(store, actorId)} is the coordinator and cannot review; the designated reviewer or the user reviews instead`);
      if (task.reviewer.kind !== 'member' || task.reviewer.memberId !== actorId) return fail('FORBIDDEN', `only the designated reviewer (${task.reviewer.kind === 'member' ? memberName(store, task.reviewer.memberId) : 'user'}) can review; ask that reviewer, or have the reviewer changed with task_action edit`);
      requireGroupRole(actorId, 'reviewRoleIds');
      if (!isEligible(actorId, task.reviewRoleIds)) return fail('ROLE_REQUIRED', `reviewer ${memberName(store, task.reviewer.memberId)} lacks roles: ${missing(task.reviewer.memberId, task.reviewRoleIds)}`);
      // A member reviews a batch once it is complete; the user, the authority, may review any time.
      refuseEarlyReview(store, task);
    }
    if (task.batchId) {
      const batch = taskBatch(store, clusterId, task.batchId);
      if (batch && !batch.reviewedAt) { batch.reviewedAt = now; saveTaskBatch(store, batch); }   // no task joins after this
    }
    const submission = records<Submission>('submission').find((s) => s.id === command.submissionId)!;
    if (actor.kind === 'member' && submission.contributorKeys.includes(actorKey(member(actorId)))) return fail('REVIEW_NOT_INDEPENDENT', `${memberName(store, actorId)} participated in the result, so they cannot review it`);
    if (command.verdict !== 'approve' && command.verdict !== 'reject') return fail('INVALID_REQUEST', 'verdict is required');
    if (command.verdict === 'approve') {
      const current = versions(store, task);
      if (!current || canonical(current) !== canonical(submission.dependencyVersions) || submission.definitionVersion !== task.definitionVersion) {
        return fail('DEPENDENCIES_NOT_READY', 'submission dependencies or definition changed');
      }
    }
    const review: Review = { id: randomUUID(), taskId: task.id, submissionId: submission.id, reviewer: actor,
      verdict: command.verdict, reason: reviewReason(command.reason, command.verdict === 'reject' || actor.kind === 'member'), createdAt: now };
    save('review', review);
    const previousOwner = task.assignedMemberId;
    if (previousOwner) recipients.add(previousOwner);
    if (review.verdict === 'approve') {
      if (previousOwner) infoOnly.add(previousOwner);
      const assignment = records<Assignment>('assignment').find((a) => a.id === task!.currentAssignmentId)!;
      assignment.endedAt = now; assignment.endReason = 'approved'; save('assignment', assignment);
      task.status = 'completed'; task.approvedSubmissionId = submission.id; task.currentAssignmentId = null; task.assignedMemberId = null;
    } else task.status = 'working';
    out.review = review;
  } else if (action === 'task.set_git_branch' && task) {
    if (actor.kind !== 'user' && (actor.kind !== 'member' || task.assignedMemberId !== actorId)) {
      return fail('FORBIDDEN', 'only the user or current executor can change the task Git branch');
    }
    const before = { ...task };
    const link = command.gitBranch;
    if (link === null) delete task.gitBranch;
    else {
      if (!link || typeof link !== 'object' || Array.isArray(link)) return fail('INVALID_REQUEST', 'gitBranch must be an object or null');
      if (actor.kind !== 'user' && link.repositoryPath !== undefined) {
        return fail('FORBIDDEN', 'only the user can choose a local repository path');
      }
      // The executor names no path: the task's linked repository, or with no link its own folder.
      const stored = actor.kind === 'user' ? undefined : task.gitBranch?.repositoryPath;
      const path = actor.kind === 'user' ? required(link.repositoryPath, 'repositoryPath') : stored ?? member(actorId).cwd;
      if (!isAbsolute(path)) return fail('INVALID_REQUEST', 'repositoryPath must be an absolute local path');
      const branch = required(link.branch, 'branch', 1024);
      if (branch.startsWith('-') || branch === 'HEAD') return fail('INVALID_REQUEST', 'branch must be a valid Git branch name');
      // shortcut: two bounded Git reads run while saving a link; move resolution before the transaction if saves become slow.
      let repositoryPath: string;
      try { repositoryPath = gitRepositoryPathSync(path); }
      catch { return fail('INVALID_REQUEST', stored ? STORED_REPOSITORY_GONE : 'could not resolve a local Git repository at repositoryPath'); }
      // git also finds a repository upward from a plain directory: the stored path must still be the linked repository,
      // not a parent one the executor never chose.
      if (stored && !sameRepositoryPath(repositoryPath, stored)) return fail('INVALID_REQUEST', STORED_REPOSITORY_GONE);
      try { gitSync(path, 'check-ref-format', `refs/heads/${branch}`); }
      catch { return fail('INVALID_REQUEST', 'branch must be a valid Git branch name'); }
      task.gitBranch = { repositoryPath, branch };
    }
    changes = taskChanges(store, before, task);
  } else if (manualMark && task) {
    const markingMerged = action === 'task.mark_merged';
    const valid = completionValid(store, task);
    const alreadyMarked = markingMerged ? task.status === 'merged' && valid : task.status === 'merged' || valid;
    if (alreadyMarked) return fail('INVALID_STATE', 'task already has this or a later valid status');
    const assignment = collaborationRecord<Assignment>(store, task.id, 'assignment', task.currentAssignmentId);
    if (assignment?.startedAt && !assignment.endedAt && command.confirmStopped !== true) {
      return fail('STOP_CONFIRMATION_REQUIRED', 'confirm the executor has stopped before ending the active assignment');
    }
    const reason = reviewReason(command.reason, false);
    const sha = markingMerged ? commitSha(command.commitSha, false) : null;
    wasDependencyReady = valid && (!task.mergeRequired || task.status === 'merged');
    if (task.status === 'review' && task.reviewer.kind === 'member') {
      staleTaskNotices = { memberId: task.reviewer.memberId, actions: ['task.submit', 'task.edit'] };
    } else if (markingMerged && valid && task.status === 'completed') {
      const state = shipState(store, clusterId, task.id);
      const runner = state && shipRunner(state);
      if (runner) staleTaskNotices = { memberId: runner, actions: ['task.review'] };
    }
    const status = markingMerged ? 'merged' : 'completed';
    if (!valid) {
      const note = reason || (markingMerged ? '用户手动标记为已合并' : '用户手动标记为已完成');
      const submission: Submission = { id: randomUUID(), taskId: task.id, assignmentId: null, definitionVersion: task.definitionVersion,
        summary: note, commitSha: null, evidenceMessageIds: [], evidenceFileIds: [], contributorKeys: [],
        dependencyVersions: versions(store, task) ?? {}, createdAt: now, manual: true };
      const review: Review = { id: randomUUID(), taskId: task.id, submissionId: submission.id, reviewer: actor,
        verdict: 'approve', reason: note, createdAt: now, manual: true };
      save('submission', submission); save('review', review);
      task.latestSubmissionId = submission.id; task.approvedSubmissionId = submission.id;
      out.submission = submission; out.review = review;
    }
    if (assignment && !assignment.endedAt) {
      assignment.endedAt = now; assignment.endReason = 'user marked ' + status; save('assignment', assignment);
    }
    previousExecutor = task.assignedMemberId;
    const attached = [previousExecutor, task.reviewer.kind === 'member' ? task.reviewer.memberId : null];
    for (const id of attached) if (id) { recipients.add(id); infoOnly.add(id); }
    task.currentAssignmentId = null; task.assignedMemberId = null; task.status = status;
    delete task.closeReason;
    if (markingMerged) {
      const merge: Merge = { id: randomUUID(), taskId: task.id, submissionId: task.approvedSubmissionId!,
        commitSha: sha, reason, recordedBy: actor, createdAt: now, manual: true };
      save('merge', merge);
      task.mergedSubmissionId = merge.submissionId; task.mergedCommitSha = merge.commitSha; out.merge = merge;
    }
  } else if (action === 'task.merge' && task) {
    management('taskPlanning', true);
    if (task.batchId) return fail('INVALID_STATE', 'the task is in a review batch, which is merged as a whole: run the batch ship command from get_batch, or record a landed batch merge with manage_batch merge');
    if (task.status !== 'completed' || !completionValid(store, task) || !task.mergeRequired) return fail('INVALID_STATE', 'task has no valid completed result awaiting merge');
    const sha = commitSha(command.commitSha, true)!;
    const merge: Merge = { id: randomUUID(), taskId: task.id, commitSha: sha,
      submissionId: task.approvedSubmissionId!, reason: reviewReason(command.reason, false), recordedBy: actor, createdAt: now };
    if (!suggest) {
      // The way out when ship landed but could not report: only what git shows counts, as for a ship report.
      const state = shipState(store, clusterId, task.id);
      if (!state || !mergedOnTarget(state.cwds, sha, state.commitSha)) {
        return fail('MERGE_NOT_VERIFIED', `${sha} is not on the target branch with the reviewed commit as its second parent`);
      }
      save('merge', merge);
      task.status = 'merged'; task.mergedCommitSha = merge.commitSha; task.mergedSubmissionId = merge.submissionId;
      out.merge = merge;
    }
  } else if ((action === 'task.shipped' || action === 'task.ship_failed') && task) {
    if (actor.kind !== 'system') return fail('FORBIDDEN', 'only a verified ship report can record this; run the ship command');
    if (task.batchId) return fail('INVALID_STATE', 'the task is in a review batch, which is merged as a whole');
    if (task.status !== 'completed' || !completionValid(store, task) || !task.mergeRequired || command.submissionId !== task.approvedSubmissionId) {
      return fail('INVALID_STATE', 'task has no valid completed result awaiting merge');
    }
    if (action === 'task.shipped') {
      const state = shipState(store, clusterId, task.id);   // read while the task still awaits its merge
      endedBy = (state && shipRunner(state)) ?? actorId;
      const merge: Merge = { id: randomUUID(), taskId: task.id, commitSha: commitSha(command.commitSha, true)!,
        submissionId: task.approvedSubmissionId!, reason: reviewReason(command.reason, false), recordedBy: actor, createdAt: now };
      save('merge', merge);
      task.status = 'merged'; task.mergedCommitSha = merge.commitSha; task.mergedSubmissionId = merge.submissionId;
      out.merge = merge;
    } else {
      // As a reopen, but back to the executor: they merge main into the branch or fix the check, then resubmit.
      required(command.reason, 'reason');
      const state = shipState(store, clusterId, task.id);   // read while the task still awaits its merge
      const ranShip = state ? shipRunner(state) : null;
      const approved = records<Submission>('submission').find((s) => s.id === task!.approvedSubmissionId)!;
      const runner = records<Assignment>('assignment').find((a) => a.id === approved.assignmentId)?.memberId;
      task.approvedSubmissionId = null; task.status = 'pending';
      task.assignedMemberId = runner && store.getMember(runner)?.clusterId === clusterId ? runner : null;
      if (task.assignedMemberId) recipients.add(task.assignedMemberId);
      // An executor who ran ship themself saw its output in that turn. The actor is the system, so the usual
      // "not the actor" rule does not cover them.
      if (task.assignedMemberId && task.assignedMemberId === ranShip) infoOnly.add(task.assignedMemberId);
      if (task.reviewer.kind === 'member') { recipients.add(task.reviewer.memberId); infoOnly.add(task.reviewer.memberId); }
    }
  } else if (['task.release', 'task.cancel', 'task.handoff', 'task.reopen'].includes(action) && task) {
    const assignment = records<Assignment>('assignment').find((a) => a.id === task!.currentAssignmentId);
    // The current executor may give back or hand off their own task. Their declaration is the stop confirmation;
    // anyone else still needs the user to confirm a started execution has stopped.
    const holder = assignment?.memberId ?? task.assignedMemberId;
    const selfExecutor = actor.kind === 'member' && holder === actorId && !assignment?.endedAt;
    if (action === 'task.release') {
      if (actor.kind !== 'user' && !selfExecutor) return fail('FORBIDDEN', 'only the assignee or user can release; ask one of them, or hand off the task if you hold the recovery permission');
    } else if (action === 'task.cancel') management('cancelReopen', task.status === 'pending' && task.createdBy === actorId);
    else if (action === 'task.handoff') { if (!selfExecutor) management('recovery'); }
    else management('cancelReopen', task.reviewer.kind === 'member' && task.reviewer.memberId === actorId);
    if (assignment && command.assignmentId !== assignment.id) return fail('STALE_ASSIGNMENT', 'assignment changed');
    // management() above already checked the coordinator's permission and generation.
    const coordinator = store.coordinator?.policy(clusterId);
    const coordinatorStops = (action === 'task.cancel' || action === 'task.handoff') && coordinator?.enabled === true && coordinator.memberId === actorId;
    const executorStops = selfExecutor && !!assignment?.startedAt && !suggest;
    if (assignment?.startedAt && !coordinatorStops && !executorStops && (actor.kind !== 'user' || command.confirmStopped !== true)) {
      return fail('STOP_CONFIRMATION_REQUIRED', 'only the user can confirm the execution has stopped');
    }
    if (assignment?.startedAt && coordinatorStops && !suggest) stoppedMemberId = assignment.memberId;
    if (action === 'task.reopen' && !['completed', 'merged', 'cancelled'].includes(task.status)) return fail('INVALID_STATE', 'only completed, merged or cancelled tasks can reopen; use release, cancel or handoff on an open task');
    if (action !== 'task.reopen' && ['completed', 'merged', 'cancelled'].includes(task.status)) return fail('INVALID_STATE', 'task is already closed; reopen it first');
    if (action === 'task.cancel') closeReason = closeReasonOf(store, clusterId, task.id, command);
    const reason = action === 'task.cancel' && actor.kind === 'user' && closeReason?.kind !== 'other'
      && (command.reason === undefined || (typeof command.reason === 'string' && !command.reason.trim()))
      ? '' : required(command.reason, 'reason');
    let nominee: StoredMember | null = null;
    if (action === 'task.handoff') {
      if (task.proposalState === 'proposed') return fail('APPROVAL_REQUIRED', 'task requires user approval');
      nominee = member(command.memberId);
      checkExecutor(nominee.id);
    }
    if (!suggest && assignment) {
      assignment.endedAt = now; assignment.endReason = reason || null; save('assignment', assignment);
    }
    previousExecutor = task.assignedMemberId;
    task.currentAssignmentId = null; task.assignedMemberId = nominee?.id ?? null; task.approvedSubmissionId = null;
    task.mergedCommitSha = null; task.mergedSubmissionId = null;
    task.status = action === 'task.cancel' ? 'cancelled' : 'pending';
    if (closeReason) task.closeReason = closeReason; else delete task.closeReason;
    if (nominee) recipients.add(nominee.id);
    // Whoever had the task and its member reviewer should hear about a release/cancel/reopen/handoff.
    if (holder) recipients.add(holder);
    if (task.reviewer.kind === 'member') recipients.add(task.reviewer.memberId);
    // 知会：重开或取消只告诉验收者，不唤醒。
    if ((action === 'task.reopen' || action === 'task.cancel') && task.reviewer.kind === 'member') {
      infoOnly.add(task.reviewer.memberId);
    }
    // An executor handing back its own work tells the coordinator without waking them; a reviewer only needs the
    // unread note. The new nominee above stays a wake recipient.
    if (selfExecutor && coordinator?.enabled && coordinator.memberId !== actorId) {
      recipients.add(coordinator.memberId); infoOnly.add(coordinator.memberId);
    }
    if (selfExecutor && task.reviewer.kind === 'member') infoOnly.add(task.reviewer.memberId);
    if (stoppedMemberId) infoOnly.delete(stoppedMemberId);
  } else if (action === 'task.takeover' && task) {
    // The reviewer becomes the executor and the review moves elsewhere (docs/collaboration.md「验收者接手」). Started by the
    // executor (hands the task to its reviewer), the reviewer (takes it), the user, or the coordinator under the same rules.
    if (task.reviewer.kind !== 'member') {
      return fail('INVALID_STATE', `only a task reviewed by a member can be taken over by its reviewer; this task is reviewed by ${task.reviewer.kind === 'self' ? 'its executor (self review)' : 'the user'}`);
    }
    const reviewerId = task.reviewer.memberId;
    const policy = store.coordinator?.policy(clusterId);
    const coordinatorActs = policy?.enabled === true && policy.memberId === actorId;
    if (actor.kind === 'member' && !coordinatorActs && task.assignedMemberId !== actorId && reviewerId !== actorId) {
      return fail('FORBIDDEN', 'only the task executor, its reviewer, the user or the coordinator can hand a task over to its reviewer');
    }
    management('recovery', true);
    management('reviewerManagement', true);
    if (task.proposalState === 'proposed') return fail('APPROVAL_REQUIRED', 'task requires user approval');
    if (task.status === 'completed') return fail('INVALID_STATE', 'the result is already approved; nothing is left to take over (reopen the task first if more work is needed)');
    if (!['pending', 'working', 'review'].includes(task.status)) return fail('INVALID_STATE', 'task is already closed; reopen it first');
    const reviewerMember = store.getMember(reviewerId);
    if (reviewerMember?.clusterId !== clusterId) {
      return fail('INVALID_STATE', `the reviewer ${memberName(store, reviewerId)} is no longer in this cluster; change the reviewer instead`);
    }
    refuseHidden(store, clusterId, actor, actorId, reviewerId);
    refuseCoordinator(store, clusterId, reviewerId);
    requireGroupRole(reviewerId, 'executeRoleIds');
    if (!isEligible(reviewerId, task.executeRoleIds)) return fail('ROLE_REQUIRED', `${memberName(store, reviewerId)} lacks roles: ${missing(reviewerId, task.executeRoleIds)}`);
    // What reviews after the takeover: the user unless the caller names a member or self review.
    const next = command.reviewer === undefined ? { kind: 'user' as const } : reviewer(command.reviewer);
    const assignments = records<Assignment>('assignment');
    let basis: TakeoverBasis = actor.kind === 'user' ? 'user' : 'user_review';
    if (next.kind === 'member') {
      requireGroupRole(next.memberId, 'reviewRoleIds');
      if (next.memberId === reviewerId) return fail('REVIEW_NOT_INDEPENDENT', `${memberName(store, reviewerId)} is taking the task over, so they cannot also review it`);
      if (next.memberId === task.assignedMemberId || participantKeys(assignments).includes(actorKey(member(next.memberId)))) {
        return fail('REVIEW_NOT_INDEPENDENT', `${memberName(store, next.memberId)} worked on this task, so they cannot review it`);
      }
      if (!isEligible(next.memberId, task.reviewRoleIds)) return fail('ROLE_REQUIRED', `reviewer ${memberName(store, next.memberId)} lacks roles: ${missing(next.memberId, task.reviewRoleIds)}`);
      if (actor.kind !== 'user') basis = 'named_member';
    } else if (next.kind === 'self') {
      // No independent review is left: only the user's own action or the user's setting for this cluster may allow it.
      basis = authoriseSelfReview(store, clusterId, actor, 'a takeover with self review');
    }
    const before = structuredClone(task);
    const current = assignments.find((a) => a.id === task!.currentAssignmentId);
    previousExecutor = task.assignedMemberId;
    // The review moves away from the batch reviewer, so the task leaves its batch and goes on as an ordinary task.
    if (task.batchId) { leftBatch = task.batchId; delete task.batchId; }
    if (current && !current.endedAt && !suggest) { current.endedAt = now; current.endReason = 'reviewer takeover'; save('assignment', current); }
    task.assignedMemberId = reviewerId;
    task.currentAssignmentId = null;
    if (before.status !== 'pending') {
      // The work goes on where it stood: the new assignment keeps the versions the work was started against, so a
      // dependency change since then still has to be declared on submit.
      const assignment: Assignment = { id: randomUUID(), taskId: task.id, memberId: reviewerId, actorKey: actorKey(reviewerMember),
        acceptedAt: now, startedAt: now, endedAt: null, endReason: null, dependencyVersions: current?.dependencyVersions ?? versions(store, task) ?? {} };
      if (!suggest) save('assignment', assignment);
      task.currentAssignmentId = assignment.id; task.status = 'working'; out.assignment = assignment;
    }
    // A result waiting for review is superseded, as a new submission would supersede it; the reviewer's call to review it is stale.
    if (before.status === 'review') { task.latestSubmissionId = null; staleTaskNotices = { memberId: reviewerId, actions: ['task.submit', 'task.edit'] }; }
    setReviewer(next, { fromMemberId: previousExecutor, toMemberId: reviewerId, reviewFrom: before.reviewer, reviewTo: next, basis,
      previousStatus: before.status });
    changes = taskChanges(store, before, task);
    // Who hears: the old executor (woken when it may still be working, to stop), the reviewer now executing (woken
    // unless it waits on dependencies), a member reviewing next and the creator (both only told).
    if (previousExecutor && previousExecutor !== reviewerId) {
      recipients.add(previousExecutor);
      if (before.status !== 'working') infoOnly.add(previousExecutor);
    }
    recipients.add(reviewerId);
    if (task.status === 'pending' && waitsOnDependencies()) infoOnly.add(reviewerId);
    if (next.kind === 'member') { recipients.add(next.memberId); infoOnly.add(next.memberId); }
    if (store.getMember(task.createdBy)?.clusterId === clusterId && !recipients.has(task.createdBy)) { recipients.add(task.createdBy); infoOnly.add(task.createdBy); }
  } else if (action === 'task.delete' && task) {
    // Permanent removal is a user-only, web-only action (the MCP task_action tool does not offer it). Only a task
    // that is already cancelled may go; anything still depending on it would be left with a dangling dependency.
    if (actor.kind !== 'user') return fail('FORBIDDEN', 'only the user can delete a task');
    if (task.status !== 'cancelled') return fail('INVALID_STATE', 'only cancelled tasks can be deleted');
    const blocking = dependents(store, clusterId, task.id);
    if (blocking.length) return fail('TASK_HAS_DEPENDENTS', 'dependent tasks: '
      + blocking.map((item) => `${item.title}（${item.id}）`).join('、'));
    deleted = { id: task.id, title: task.title, linkedMessageCount: collaborationLinkCount(store, task.id) };
    deletedMessageIds = collaborationLinkedMessageIds(store, task.id);
    deleteCollaborationTask(store, task.id);
    out.deleted = deleted;
    // The task row is gone: clear it so the save below cannot recreate the task.
    task = undefined;
  } else if (action === 'task.attention' && task) {
    management('knowledgeCommunication', task.assignedMemberId === actorId);
    const target = command.targetMemberId ? member(command.targetMemberId).id : null;
    const attention: Attention = { id: randomUUID(), taskId: task.id, kind: required(command.kind, 'kind', 100),
      question: required(command.question, 'question'), targetMemberId: target, createdBy: actorId, createdAt: now, resolvedAt: null, resolution: null };
    if (!suggest) save('attention', attention);
    out.attention = attention;
    if (target) recipients.add(target);
  } else if (action === 'task.resolve_attention' && task) {
    const attention = records<Attention>('attention').find((a) => a.id === command.attentionId);
    if (!attention || attention.resolvedAt) return fail('OUT_OF_SCOPE', 'unknown unresolved attention; get_task_context lists the unresolved ones');
    management('knowledgeCommunication', actorId === attention.createdBy || actorId === attention.targetMemberId);
    attention.resolution = required(command.resolution, 'resolution'); attention.resolvedAt = now;
    if (!suggest) save('attention', attention);
    out.attention = attention;
  } else if (action === 'task.summary' && task) {
    management('knowledgeCommunication', true);
    const sourceMessageIds = strings(command.sourceMessageIds, 'sourceMessageIds');
    for (const id of sourceMessageIds) if (store.getMessage(id)?.clusterId !== clusterId) return fail('OUT_OF_SCOPE', 'unknown source message; use full message IDs from read_messages');
    if (!Number.isSafeInteger(command.throughEventId) || command.throughEventId! < 0
      || (command.throughEventId! !== 0 && !store.eventInCluster(clusterId, command.throughEventId!))) {
      return fail('INVALID_REQUEST', 'invalid summary event cursor; pass an event seq from get_task as throughEventId, or 0');
    }
    const summary: TaskSummary & { id: string } = { id: randomUUID(), taskId: task.id, author: actorId,
      content: required(command.summary, 'summary'), throughEventId: command.throughEventId!, sourceMessageIds, updatedAt: now };
    if (!suggest) save('summary', summary);
  } else if (action === 'message.link') {
    const message = command.messageId && store.getMessage(command.messageId);
    if (!message || message.clusterId !== clusterId) return fail('OUT_OF_SCOPE', 'unknown message');
    const add = strings(command.taskIds, 'taskIds'); const remove = strings(command.removeTaskIds, 'removeTaskIds');
    for (const id of [...add, ...remove]) taskOf(store, clusterId, id);
    if (remove.length) required(command.reason, 'reason');
    const ordinary = (!remove.length || message.from === actorId)
      && (!add.length || message.from === actorId || add.every((id) => taskOf(store, clusterId, id).assignedMemberId === actorId));
    management('knowledgeCommunication', ordinary);
    if (!suggest) {
      for (const id of add) linkCollaborationMessage(store, message.id, id, actorId);
      for (const id of remove) unlinkCollaborationMessage(store, message.id, id);
    }
    out.messageId = message.id;
  }

  if (suggest) {
    delete out.attention; task = undefined;
  } else if (task) {
    // The number is taken in the command's transaction, so a failure later in the command gives it back; a suggestion
    // never gets here, and a retried operationId replays its stored result before the action runs.
    if (action === 'task.create') task.number = nextTaskNumber(store, clusterId);
    else { task.revision++; task.updatedAt = now; }
    saveCollaborationTask(store, task);
    if (action === 'task.create' && task.originMessageId) linkCollaborationMessage(store, task.originMessageId, task.id, actorId);
    if (action === 'task.submit' && out.submission) {
      for (const id of out.submission.evidenceMessageIds) linkCollaborationMessage(store, id, task.id, actorId);
    }
    out.task = displayTask(store, task);
  }

  ctx.outcome.payload = (suggested) => ({ action, ...(task ? { taskId: task.id } : deleted ? { taskId: deleted.id } : {}), ...(out.messageId ? { messageId: out.messageId } : {}),
    ...(command.memberId ? { memberId: command.memberId } : {}),
    ...(typeof command.reason === 'string' && command.reason.trim() ? { reason: command.reason } : {}), ...(closeReason ? { closeReason } : {}),
    ...(command.paused !== undefined ? { paused: command.paused } : {}),
    ...(out.review ? { verdict: out.review.verdict } : {}), ...(out.approval ? { approvalVerdict: out.approval.verdict } : {}),
    ...(out.merge ? { commitSha: out.merge.commitSha } : {}), ...(out.attention ? { question: out.attention.question } : {}),
    ...(command.mode !== undefined ? { mode: command.mode, enabled: command.enabled } : {}),
    ...(command.instructionId !== undefined ? { instructionId: command.instructionId } : {}),
    ...(command.instructionText !== undefined ? { instructionText: command.instructionText } : {}),
    ...(changes.length ? { changes } : {}),
    ...(out.takeover ? { takeover: { action: out.takeover.action, by: out.takeover.by, fromMemberId: out.takeover.fromMemberId, toMemberId: out.takeover.toMemberId,
      reviewFrom: out.takeover.reviewFrom, reviewTo: out.takeover.reviewTo, basis: out.takeover.basis,
      previousStatus: out.takeover.previousStatus, previousRejected: out.takeover.previousRejected } } : {}),
    ...(command.sourceEventId !== undefined ? { sourceEventId: command.sourceEventId } : {}),
    ...(command.taskIds ? { taskIds: command.taskIds } : {}), ...(command.removeTaskIds ? { removeTaskIds: command.removeTaskIds } : {}),
    ...(deletedMessageIds.length ? { messageIds: deletedMessageIds } : {}),
    ...(stoppedMemberId ? { coordinatorConfirmedStop: stoppedMemberId } : {}),
    ...(action === 'task.create' && task?.batchId ? { batchId: task.batchId } : {}), ...(leftBatch ? { leftBatchId: leftBatch } : {}),
    ...(suggested ? { suggested: true } : {}) });

  ctx.outcome.afterEvent = (event) => {
    if (!suggest && task && previousExecutor && previousExecutor !== task.assignedMemberId) {
      const target = task.assignedMemberId ? `${memberName(store, task.assignedMemberId)}（${task.assignedMemberId}）` : '已清除';
      const reason = `分配被事件 ${event.seq} 取代：${target}`;
      // task.nominate: notices queued before the upgrade.
      const deliveries = [...['task.create', 'task.assign', 'task.nominate', 'task.handoff'].flatMap((name) =>
        store.supersedeEventNotices(clusterId, previousExecutor!, name, { taskId: task!.id, memberId: previousExecutor! }, reason)),
      // A takeover that made them the executor woke them as the taker.
      ...store.supersedeEventNotices(clusterId, previousExecutor!, 'task.takeover', { taskId: task!.id, 'takeover.toMemberId': previousExecutor! }, reason)];
      ctx.deliveriesChanged(deliveries.map((delivery) => store.appendEvent(clusterId, delivery.memberId, 'delivery', { delivery, sourceEventId: event.seq })));
    }
    if (task && staleTaskNotices) {
      const { memberId, actions } = staleTaskNotices;
      const deliveries = actions.flatMap((name) => store.supersedeEventNotices(clusterId, memberId, name,
        { taskId: task!.id }, `任务状态被事件 ${event.seq} 取代`));
      ctx.deliveriesChanged(deliveries.map((delivery) => store.appendEvent(clusterId, memberId, 'delivery', { delivery, sourceEventId: event.seq })));
    }
    const policy = store.coordinator?.policy(clusterId);
    const merged = action === 'task.merge' || action === 'task.shipped';
    const manualReady = manualMark && !wasDependencyReady && out.task?.completionValid
      && (!task?.mergeRequired || task.status === 'merged');
    // A normal finish (approve, self submit, merge, ship) stays in the chat record through retainHistory below.
    const coordinatorNotice = ['task.attention', 'task.release', 'task.handoff', 'task.reopen'].includes(action);
    if (!suggest && policy?.enabled && policy.memberId !== actorId && coordinatorNotice) recipients.add(policy.memberId);
    const ready: { task: Task; memberId: string }[] = [];
    if (!suggest && task && (action === 'task.reopen' || merged || manualReady
      || (action === 'task.review' && out.review?.verdict === 'approve' && !task.mergeRequired)
      || (action === 'task.submit' && out.review?.self === true && !task.mergeRequired))) {
      const tasks = [...allTasks(store, clusterId)];
      const evaluation = taskDependencyEvaluation(store, clusterId);
      const affected = new Set([task.id]);
      // A merge invalidates nothing; only the owners it makes ready (dependency_ready below) have work to do.
      const tell = (id: string) => { recipients.add(id); if (merged || manualMark) infoOnly.add(id); };
      let changed = true;
      while (changed) {
        changed = false;
        for (const dependent of tasks) if (!affected.has(dependent.id) && dependent.dependencyIds.some((id) => affected.has(id))) {
          affected.add(dependent.id); changed = true;
          // A task awaiting approval cannot start: its owner hears when the user decides, not before.
          if (dependent.proposalState === 'proposed') continue;
          const latest = collaborationRecords<Assignment>(store, dependent.id, 'assignment').at(-1);
          const owner = dependent.assignedMemberId;
          const previousOwner = latest?.memberId;
          if (action !== 'task.reopen' && ['pending', 'working'].includes(dependent.status)
            && owner && evaluation.versions(dependent) !== null) {
            ready.push({ task: dependent, memberId: owner });
            if (previousOwner && previousOwner !== owner) tell(previousOwner);
          } else if (previousOwner) tell(previousOwner);
          if (['review', 'completed', 'merged'].includes(dependent.status) && dependent.reviewer.kind === 'member') {
            tell(dependent.reviewer.memberId);
          }
        }
      }
    }
    // An approval whose ship falls to someone other than the approver has to wake that member, or the task sits unmerged.
    const toShip = !suggest && task && action === 'task.review' && out.review?.verdict === 'approve' ? shipState(store, clusterId, task.id) : null;
    const shipBy = toShip ? shipRunner(toShip) : null;
    const shipWake = shipBy !== null && shipBy !== actorId;
    if (shipWake) { recipients.add(shipBy); infoOnly.delete(shipBy); }
    // A self-reviewed completion and a merge often have nobody to tell; the chat still records them, naming nobody.
    let retainHistory = manualMark || (action === 'task.set_git_branch' && changes.length > 0) || (!suggest && !!out.takeover)
      || (!suggest && (merged || (action === 'task.submit' && out.review?.self === true)));
    if (policy?.enabled && action.startsWith('task.') && !coordinatorNotice && !out.approval) {
      retainHistory ||= !suggest && policy.memberId !== actorId && store.getMember(policy.memberId)?.clusterId === clusterId
        && (recipients.has(policy.memberId) || ['task.create', 'task.claim', 'task.submit', 'task.review', 'task.merge', 'task.shipped'].includes(action));
      recipients.delete(policy.memberId);
    }
    recipients.delete(actorId);
    // Info-tier events still reach the people attached to the task as unread (no delivery, no turn): another member's
    // start or submission is something they can read later, not a reason to wake them. The reviewer of a submission
    // stays a wake recipient (the submit branch added it).
    // A self-review submission is a normal finish: it stays in the chat record and names nobody (the r1 rule). A
    // submission for the user to accept still tells the attached members as unread, even though no member reviews it.
    if (!suggest && task && (action === 'task.start' || (action === 'task.submit' && task.reviewer.kind !== 'self'))) {
      const attached = (id: string | null | undefined) => {
        if (!id || id === actorId || !store.getMember(id)) return;
        recipients.add(id); infoOnly.add(id);
      };
      attached(task.createdBy);
      if (task.reviewer.kind === 'member') attached(task.reviewer.memberId);
      if (policy?.enabled) attached(policy.memberId);
      // A reviewer who is now the coordinator cannot review (the Hub refuses it), so the review would wake them for
      // nothing: they keep the submission as unread like any other attached member.
      const coordinatorId = policy?.enabled ? policy.memberId : null;
      if (action === 'task.submit' && task.reviewer.kind === 'member' && task.reviewer.memberId !== coordinatorId && !task.batchId) {
        infoOnly.delete(task.reviewer.memberId);
      }
    }
    // Awaiting approval, nothing is delivered: the entry notice names nobody and edits only stay in the chat record.
    if (approvalRequired || (action === 'task.edit' && task?.proposalState === 'proposed')) recipients.clear();
    // A normal edit that reached nobody still leaves its record in the group chat (no delivery, no wake).
    const editHistory = action === 'task.edit' && changes.length > 0 && recipients.size === 0;
    const woken = new Set<string>();   // who this event already wakes: a watch notice to them only adds to their unread
    if (!suggest && (recipients.size || retainHistory || editHistory || approvalRequired)) {
      for (const id of recipients) if (!infoOnly.has(id)) woken.add(id);
      const body = approvalRequired && task ? `任务${task.number ? ` #${task.number}` : ''}【${task.title}】等待用户批准，事件 ${event.seq}。` : noticeBody(store, clusterId, event, action, task, shipWake);
      // Its kind decides the chat category (src/core/system-kinds.js): a failure or something sent back is a warning.
      const systemKind: SystemMessageKind = action === 'task.ship_failed' ? 'ship_failed'
        : (action === 'task.review' && out.review?.verdict === 'reject') || out.approval?.verdict === 'reject' ? 'task_rejected'
        : action === 'task.attention' ? 'task_attention'
          : out.takeover?.reviewTo.kind === 'self' ? 'review_downgraded' : task ? 'task' : 'settings';
      ctx.notice(event, { ...notice(event, task), systemKind, body, recipients: [...recipients], wake: [...recipients].filter((id) => !infoOnly.has(id)),
        retain: retainHistory || editHistory || approvalRequired });
    }
    for (const item of ready) {
      if (policy?.enabled && item.memberId === policy.memberId) continue;
      woken.add(item.memberId);
      ctx.notice(event, { ...notice(event, item.task), systemKind: 'task', recipients: [item.memberId],
        body: `前置依赖已就绪：任务${item.task.number ? ` #${item.task.number}` : ''}「${item.task.title}」（${item.task.id}），事件 ${event.seq}。请查看任务上下文。` });
    }
    // In a batch a submission is the new version of its in-batch dependents (model.ts versions): the owner of each direct
    // dependent hears that it can build on it now, or that a result built on the old one must be submitted again.
    if (!suggest && task?.batchId && action === 'task.submit' && out.submission) {
      const evaluation = taskDependencyEvaluation(store, clusterId);
      const commit = out.submission.commitSha ? `提交 ${out.submission.commitSha.slice(0, 7)}` : '没有提交号';
      const base = `${commit}${task.gitBranch ? `，分支 ${task.gitBranch.branch}` : ''}`;
      for (const dependent of batchTaskRows(store, clusterId, task.batchId)) {
        if (!dependent.dependencyIds.includes(task.id) || dependent.proposalState === 'proposed') continue;
        const approved = collaborationRecord<Submission>(store, dependent.id, 'submission', dependent.approvedSubmissionId);
        const owner = dependent.assignedMemberId
          ?? (approved && collaborationRecords<Assignment>(store, dependent.id, 'assignment').find((a) => a.id === approved.assignmentId)?.memberId);
        if (!owner || owner === actorId || (policy?.enabled && owner === policy.memberId)) continue;
        const canStart = ['pending', 'working'].includes(dependent.status) && evaluation.versions(dependent) !== null;
        if (!canStart && !['review', 'completed'].includes(dependent.status)) continue;
        woken.add(owner);
        const label = `任务 #${dependent.number}「${dependent.title}」（${dependent.id}）`;
        ctx.notice(event, { ...notice(event, dependent), systemKind: 'task', recipients: [owner], body: canStart
          ? `前置依赖已就绪（批次内，按已提交的结果）：任务 #${task.number}【${task.title}】已提交（${base}），${label}可以在它上面继续；已开工的提交时用 expectedDependencyVersions 声明新版本，事件 ${event.seq}。get_task 的 dependencies 写着要基于的提交。`
          : `批次内的前置任务 #${task.number}【${task.title}】有新提交（${base}），${label}的结果基于旧版本，要在新版本上重新提交（用 get_task_context 读版本，按 expectedDependencyVersions 声明），事件 ${event.seq}。` });
      }
    }
    // The batch crossing a line in this change: complete (the reviewer, once) or fully approved (the ship runner, once).
    if (!suggest) for (const id of batchTransitions(ctx, batchId ?? task?.batchId, batchBefore, event)) woken.add(id);
    // Watches end at the task's end, once (watches.ts), all in one ordinary task notice. The one who ended it and a hidden
    // watcher are not told; a watcher this event already wakes only finds it unread.
    const ended = !suggest && task && !endBefore ? taskEnd(store, task) : null;
    const told = ended ? takeWatches(store, task!.id)
      .filter((watch) => watch.memberId !== endedBy && !store.getMember(watch.memberId)?.hiddenAt) : [];
    if (ended && told.length) {
      const ids = told.map((watch) => watch.memberId);
      ctx.notice(event, { ...notice(event, task), systemKind: 'task', recipients: ids, wake: ids.filter((id) => !woken.has(id)),
        body: watchNoticeBody(task!, ended, event.seq, told.map((watch) => ({ name: personName(store, clusterId, watch.memberId), note: watch.note }))) });
    }
    // Last: its seq follows every event above, and it is published after them, so live pages never drop it as old.
    if (labelsCreated) announceLibrary(ctx, action);
  };
  return out;
}

/**
 * What ties a notice to its task. Only link an event the web event API can open for this message's task: a collaboration
 * event whose payload names the same task. Dependency-ready notices point at the upstream task's event, so they carry no
 * link (docs/collaboration-api.md).
 */
function notice(event: HubEvent, task: Task | undefined) {
  if (!task) return {};
  return { taskId: task.id, ...((event.payload as { taskId?: unknown }).taskId === task.id ? { collabEventId: event.seq } : {}),
    taskStamp: { taskId: task.id, revision: task.revision, submissionId: task.latestSubmissionId } };
}

/** A move refused: this member still has to review work that conversation did. */
export function refuseRebinding(store: Store, member: StoredMember, target: { harness: string; workerSessionId: string }): void {
  const key = actorKey(target);
  const conflicts = [...allTasks(store, member.clusterId)].filter((task) => !['completed', 'merged', 'cancelled'].includes(task.status)
    && task.reviewer.kind === 'member' && task.reviewer.memberId === member.id
    && participantKeys(collaborationRecords<Assignment>(store, task.id, 'assignment')).includes(key));
  if (conflicts.length) {
    throw new CollaborationError('REVIEW_NOT_INDEPENDENT', `${member.name} still has to review work that conversation did; change the reviewer first: ${conflicts.map((task) => `「${task.title}」(${task.id})`).join(', ')}`);
  }
}

/**
 * A member moved to another conversation (inside Hub.rebindMember's transaction). Its assignments here, ended ones too,
 * now name the new conversation and remember the old one, so neither can review this member's work, even if the old one
 * joins later as another member. Task revisions stay: nothing about the work changed.
 */
export function moveAssignments(store: Store, clusterId: string, memberId: string, oldKey: string, newKey: string): void {
  for (const task of allTasks(store, clusterId)) {
    let worked = false;   // a reviewer moved off some contributor's conversation did not work on it: its new conversation stays independent
    for (const assignment of collaborationRecords<Assignment>(store, task.id, 'assignment')) {
      if (assignment.memberId !== memberId) continue;
      worked = true;
      assignment.formerActorKeys = [...new Set([...(assignment.formerActorKeys ?? []), assignment.actorKey])].filter((key) => key !== newKey);
      assignment.actorKey = newKey;
      saveCollaborationRecord(store, task.id, 'assignment', assignment);
    }
    if (!worked || task.status !== 'review') continue;
    const undecided = collaborationRecords<Submission>(store, task.id, 'submission').find((s) => s.id === task.latestSubmissionId);
    if (undecided?.contributorKeys.includes(oldKey) && !undecided.contributorKeys.includes(newKey)) {
      undecided.contributorKeys.push(newKey);
      saveCollaborationRecord(store, task.id, 'submission', undecided);
    }
  }
}
