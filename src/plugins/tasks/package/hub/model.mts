// What a task is worth right now: dependency versions, whether a result is still valid, the display projection.
// Shared by the actions, the queries, the ship ticket and the background checks.
import { host } from './host.mts';
import { collaborationRecord, collaborationRecords, collaborationTask, collaborationTaskIdByNumber, collaborationTasks } from './store.mts';
import { selfReviewBound } from './takeover.mts';
import type { Assignment, Review, Store, Submission, Task } from './types.mts';

const NEXT_STEP: Record<string, string> = {
  APPROVAL_REQUIRED: '; ask the user to approve it',
  DEPENDENCY_CYCLE: '; remove the dependency that leads back to this task',
  DEPENDENCIES_CHANGED: '; read each dependency approvedSubmissionId with get_task_context and pass them as expectedDependencyVersions',
  DEPENDENCIES_NOT_READY: '; check the dependencies with get_task_context and wait for them to complete; a reviewer can reject a submission made against an older version',
  MERGE_NOT_VERIFIED: '; run the ship command from get_task, or pass the merge commit ship made',
  REVIEW_NOT_INDEPENDENT: '; choose a reviewer who did not work on this task, or ask the user to review',
  ROLE_REQUIRED: '; ask the user or the coordinator to grant the missing roles (manage_roles), or choose a member who holds them',
  STALE_ASSIGNMENT: '; read the current assignmentId with get_task and retry, or assign the task to yourself if it has no executor',
  STALE_REVISION: '; read the current revision with get_task and retry with it as expectedRevision',
  STALE_SUBMISSION: '; read latestSubmissionId and the status with get_task; only the latest submission of a task in review can be reviewed',
  STOP_CONFIRMATION_REQUIRED: '; available paths: the assignee finishes and submits, the user retries this with confirmStopped: true after checking the work stopped, or the enabled coordinator, if any, cancels it (needs cancelReopen) or hands it off (needs recovery)',
  TASK_ALREADY_CLAIMED: '; read its state with get_task, choose another pending task from list_tasks, or ask the assignee to release it',
};
export const fail = (code: string, message: string): never => {
  throw new (host().collaboration.CollaborationError)(code, message + (NEXT_STEP[code] ?? ''));
};

export const participantKeys = (assignments: Assignment[]): string[] =>
  [...new Set(assignments.flatMap((a) => [a.actorKey, ...(a.formerActorKeys ?? [])]))];

export const memberName = (store: Pick<Store, 'getMember'>, memberId: string): string =>
  store.getMember(memberId, { includeRemoved: true })?.name ?? memberId;

export function taskOf(store: Pick<Store, 'db'>, clusterId: string, taskId: unknown): Task {
  const task = typeof taskId === 'string' ? collaborationTask(store, clusterId, taskId) : null;
  if (!task) return fail('OUT_OF_SCOPE', 'unknown task in this cluster; list_tasks shows task IDs');
  return task;
}

const taskRefForms = () =>
  `refer to a task as #number (e.g. #12), its full ID, or a unique prefix of its ID of at least ${host().collaboration.MIN_ID_PREFIX} characters; list_tasks shows numbers and IDs`;

export function resolveTaskRef<T>(store: Pick<Store, 'db' | 'idsMatching'>, clusterId: string, ref: T): T {
  if (typeof ref !== 'string') return ref;
  const minPrefix = host().collaboration.MIN_ID_PREFIX;
  if (ref.startsWith('#')) {
    const number = /^#[1-9]\d*$/.test(ref) ? Number(ref.slice(1)) : NaN;
    if (!Number.isSafeInteger(number)) return fail('OUT_OF_SCOPE', `unknown task in this cluster: ${ref} is not a task number; ${taskRefForms()}`);
    const id = collaborationTaskIdByNumber(store, clusterId, number);
    if (id === null) return fail('OUT_OF_SCOPE', `unknown task in this cluster: there is no task ${ref}; ${taskRefForms()}`);
    return id as T;
  }
  const matches = store.idsMatching('collaboration_tasks', clusterId, ref, minPrefix);
  if (matches.includes(ref)) return ref;
  if (matches.length === 1) return matches[0] as T;
  return fail('OUT_OF_SCOPE', `unknown task in this cluster: prefix ${ref} matched ${matches.length} items (a prefix needs at least ${minPrefix} characters); ${taskRefForms()}`);
}

export function* allTasks(store: Pick<Store, 'db'>, clusterId: string): Generator<Task> {
  let cursor: string | null = null;
  do {
    const page: { tasks: Task[]; nextCursor: string | null } = collaborationTasks(store, clusterId, 100, cursor ?? undefined);
    yield* page.tasks;
    cursor = page.nextCursor;
  } while (cursor);
}

export function eligible(store: Pick<Store, 'collaborationMemberRoles'>, clusterId: string, memberId: string, roleIds: string[]): boolean {
  const roles = store.collaborationMemberRoles(clusterId).find((m) => m.memberId === memberId)?.roleIds ?? [];
  return roleIds.every((role) => roles.includes(role));
}

type DependencyTask = Pick<Task, 'id' | 'clusterId' | 'dependencyIds'> & { batchId?: string | null };
type Versions = Record<string, string>;
type EvaluationEntry = { task?: Task | null; latestSubmission?: Submission | null; versions?: Versions | null; completionValid?: boolean; sameOriginIds?: Set<string> | null };

interface ApprovedChain {
  target: Submission;
  origin: Submission;
  originReview: Review;
  originReviewIndex: number;
  originAssignment: Assignment;
  hops: NonNullable<Submission['shipFix']>[];
  chainIds: Set<string>;
  shipFix: boolean;
  takenOver: boolean;
}

function resolveApprovedChain(store: Store, task: Task, targetSubmissionId: string | null | undefined): ApprovedChain | null {
  if (!targetSubmissionId) return null;
  const submissions = collaborationRecords<Submission>(store, task.id, 'submission');
  const target = submissions.find((s) => s.id === targetSubmissionId);
  if (!target) return null;
  const hops: NonNullable<Submission['shipFix']>[] = [];
  const chainIds = new Set<string>([target.id]);
  const visited = new Set<string>([target.id]);
  let cursor = target;
  while (cursor.shipFix) {
    hops.push(cursor.shipFix);
    const base = submissions.find((s) => s.id === cursor.shipFix!.baseSubmissionId);
    if (!base || visited.has(base.id)) return null;
    visited.add(base.id);
    chainIds.add(base.id);
    cursor = base;
  }
  const origin = cursor;
  const reviews = collaborationRecords<Review>(store, task.id, 'review');
  const assignments = collaborationRecords<Assignment>(store, task.id, 'assignment');
  const originReviewIndex = reviews.findLastIndex((r) => r.submissionId === origin.id && r.verdict === 'approve');
  const originAssignment = assignments.find((a) => a.id === origin.assignmentId);
  if (originReviewIndex < 0 || !originAssignment) return null;
  const originReview = reviews[originReviewIndex];
  const takenOver = collaborationRecords(store, task.id, 'takeover').length > 0;
  if (hops.length > 0) {
    const { actorKey } = host().collaboration;
    if (originReview.reviewer.kind === 'user') return null;
    for (const hop of hops) {
      if (hop.originSubmissionId !== origin.id) return null;
      if (originReview.self === true) {
        if (task.reviewer.kind !== 'self') return null;
        if (originReview.reviewer.kind !== 'member' || originReview.reviewer.memberId !== originAssignment.memberId) return null;
        if (hop.runnerId !== originAssignment.memberId) return null;
        if (takenOver && selfReviewBound(store, task.id, hop.runnerId) !== true) return null;
      } else {
        if (originReview.reviewer.kind !== 'member' || task.reviewer.kind !== 'member' || task.reviewer.memberId !== originReview.reviewer.memberId) return null;
        if (hop.runnerId !== originReview.reviewer.memberId) return null;
        const reviewerMember = store.getMember(originReview.reviewer.memberId, { includeRemoved: true });
        if (!reviewerMember || reviewerMember.id === originAssignment.memberId || origin.contributorKeys.includes(actorKey(reviewerMember))) return null;
      }
    }
  }
  return { target, origin, originReview, originReviewIndex, originAssignment, hops, chainIds, shipFix: hops.length > 0, takenOver };
}

export function taskDependencyEvaluation(store: Store, clusterId: string) {
  const entries = new Map<string, EvaluationEntry>();
  function entryFor(taskId: string): EvaluationEntry {
    let entry = entries.get(taskId);
    if (!entry) entries.set(taskId, entry = {});
    return entry;
  }

  function sameOriginIds(depTask: Task): Set<string> | null {
    const entry = entryFor(depTask.id);
    if (entry.sameOriginIds !== undefined) return entry.sameOriginIds;
    entry.task = depTask;
    const targetSubmissionId = depTask.status === 'merged'
      ? (depTask.mergedSubmissionId ?? depTask.approvedSubmissionId)
      : depTask.approvedSubmissionId;
    const chain = resolveApprovedChain(store, depTask, targetSubmissionId);
    entry.sameOriginIds = chain ? chain.chainIds : null;
    return entry.sameOriginIds;
  }

  function versionsMatch(task: Pick<Task, 'status' | 'batchId'>, recorded: Versions, current: Versions): boolean {
    const curEntries = Object.entries(current);
    if (Object.keys(recorded).length !== curEntries.length) return false;
    for (const [depId, curVer] of curEntries) {
      if (recorded[depId] === curVer) continue;
      if (!task.batchId || (task.status !== 'completed' && task.status !== 'merged')) return false;
      const entry = entryFor(depId);
      if (entry.task === undefined) entry.task = collaborationTask(store, clusterId, depId);
      const depTask = entry.task;
      if (!depTask || depTask.batchId !== task.batchId || (depTask.status !== 'completed' && depTask.status !== 'merged')) return false;
      const allowed = sameOriginIds(depTask);
      if (!allowed || !allowed.has(recorded[depId]) || !allowed.has(curVer)) return false;
    }
    return true;
  }

  function versions(task: DependencyTask): Versions | null {
    if (task.clusterId !== clusterId) throw new Error('task belongs to a different cluster');
    const entry = entryFor(task.id);
    if (entry.versions !== undefined) return entry.versions;
    entry.versions = null;
    const result: Versions = {};
    for (const id of task.dependencyIds) {
      const dependency = entryFor(id);
      if (dependency.task === undefined) dependency.task = collaborationTask(store, clusterId, id);
      const upstream = dependency.task;
      if (upstream && task.batchId && upstream.batchId === task.batchId) {
        if (!upstream.latestSubmissionId || !['review', 'completed', 'merged'].includes(upstream.status)) return null;
        const current = versions(upstream);
        if (current === null) return null;
        if (dependency.latestSubmission === undefined) {
          dependency.latestSubmission = collaborationRecord<Submission>(store, upstream.id, 'submission', upstream.latestSubmissionId) ?? null;
        }
        const submitted = dependency.latestSubmission;
        if (!submitted || submitted.definitionVersion !== upstream.definitionVersion
          || !versionsMatch(upstream, submitted.dependencyVersions, current)) return null;
        result[id] = upstream.latestSubmissionId;
        continue;
      }
      if (!upstream || (upstream.mergeRequired && upstream.status !== 'merged') || !completionValid(upstream)) return null;
      result[id] = upstream.approvedSubmissionId!;
    }
    entry.versions = result;
    return result;
  }

  function completionValid(task: Task): boolean {
    if (task.clusterId !== clusterId) throw new Error('task belongs to a different cluster');
    const entry = entryFor(task.id);
    if (entry.completionValid !== undefined) return entry.completionValid;
    entry.task = task;
    if (!['completed', 'merged'].includes(task.status) || !task.approvedSubmissionId) {
      entry.completionValid = false;
      return false;
    }
    const targetSubmissionId = task.status === 'merged' ? (task.mergedSubmissionId ?? task.approvedSubmissionId) : task.approvedSubmissionId;
    const submission = collaborationRecord<Submission>(store, task.id, 'submission', targetSubmissionId);
    if (submission?.shipFix && !resolveApprovedChain(store, task, targetSubmissionId)) {
      entry.completionValid = false;
      return false;
    }
    const current = versions(task);
    entry.completionValid = !!submission && submission.definitionVersion === task.definitionVersion && current !== null
      && versionsMatch(task, submission.dependencyVersions, current);
    return entry.completionValid;
  }

  return { versions, completionValid, versionsMatch };
}

export function versions(store: Store, task: Task): Versions | null {
  return taskDependencyEvaluation(store, task.clusterId).versions(task);
}

export function completionValid(store: Store, task: Task): boolean {
  return taskDependencyEvaluation(store, task.clusterId).completionValid(task);
}

function roleRef(store: Pick<Store, 'collaborationRoles'>, clusterId: string, roleId: string): { id: string; name: string } {
  const role = store.collaborationRoles(clusterId).find((item) => item.id === roleId);
  return { id: roleId, name: role?.name ?? `已删除角色（${roleId}）` };
}

export function missingRoleNames(store: Pick<Store, 'collaborationRoles' | 'collaborationMemberRoles'>, clusterId: string, memberId: string, roleIds: string[]): string[] {
  const held = new Set(store.collaborationMemberRoles(clusterId).find((m) => m.memberId === memberId)?.roleIds ?? []);
  return roleIds.filter((id) => !held.has(id)).map((id) => roleRef(store, clusterId, id).name);
}

export function displayTask(store: Store, task: Task, evaluation = taskDependencyEvaluation(store, task.clusterId)): Task {
  const current = evaluation.versions(task);
  const submission = collaborationRecord<Submission>(store, task.id, 'submission', task.latestSubmissionId);
  const assignment = submission?.dependencyVersions == null
    ? collaborationRecord<Assignment>(store, task.id, 'assignment', task.currentAssignmentId)
    : undefined;
  const consumed = submission?.dependencyVersions ?? (assignment?.startedAt ? assignment.dependencyVersions : null);
  return { ...task, priority: task.priority ?? 'normal', dependenciesReady: current !== null,
    dependenciesChanged: !!consumed && (!current || !evaluation.versionsMatch(task, consumed, current)),
    completionValid: evaluation.completionValid(task),
    ...(submission?.manual && submission.id === task.approvedSubmissionId ? { manualCompletion: true } : {}),
    executeRoles: task.executeRoleIds.map((id) => roleRef(store, task.clusterId, id)),
    reviewRoles: task.reviewRoleIds.map((id) => roleRef(store, task.clusterId, id)) };
}

export function shipState(store: Store, clusterId: string, taskId: string) {
  const task = collaborationTask(store, clusterId, taskId);
  return task && !task.batchId ? approvedResult(store, task) : null;
}

export function approvedResult(store: Store, task: Task) {
  if (task.status !== 'completed' || !task.mergeRequired || !completionValid(store, task)) return null;
  const chain = resolveApprovedChain(store, task, task.approvedSubmissionId);
  const commitSha = chain?.target.commitSha;
  if (!chain || !commitSha) return null;
  const { actorKey } = host().collaboration;
  const { target, origin, originReview, originReviewIndex, originAssignment, hops, shipFix, takenOver } = chain;
  const executor = store.getMember(originAssignment.memberId, { includeRemoved: true });
  const reviewerMember = originReview.reviewer.kind === 'member' ? store.getMember(originReview.reviewer.memberId, { includeRemoved: true }) : null;
  const fixerCwds = hops.map((hop) => store.getMember(hop.runnerId, { includeRemoved: true })?.cwd);
  const cwds = [...new Set([executor?.cwd, reviewerMember?.cwd, ...fixerCwds].filter((cwd): cwd is string => !!cwd))];
  return { task, submission: target, commitSha, round: originReviewIndex + 1, self: originReview.self === true, takeover: originReview.takeover === true, shipFix,
    executorId: originAssignment.memberId, reviewer: originReview.reviewer.kind === 'member' ? originReview.reviewer.memberId : 'user',
    reviewerName: originReview.reviewer.kind === 'member' ? memberName(store, originReview.reviewer.memberId) : 'user',
    takenOver,
    independent: !reviewerMember || (reviewerMember.id !== originAssignment.memberId && !origin.contributorKeys.includes(actorKey(reviewerMember))),
    cwds };
}

export function canShipFixTask(store: Store, task: Task, actorId: string): boolean {
  if (task.status !== 'completed' || !task.mergeRequired || task.batchId) return false;
  const approved = approvedResult(store, task);
  if (!approved || approved.reviewer === 'user') return false;
  if (task.reviewer.kind === 'member') {
    return task.reviewer.memberId === actorId && approved.reviewer === actorId && !approved.self && approved.independent;
  }
  if (task.reviewer.kind === 'self') {
    return approved.self === true && approved.reviewer === actorId && approved.executorId === actorId
      && (!approved.takenOver || selfReviewBound(store, task.id, actorId) === true);
  }
  return false;
}
