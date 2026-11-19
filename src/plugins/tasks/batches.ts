// Review batches (验收批次, docs/collaboration.md「验收批次」): tasks one reviewer reviews together once every one of them is
// submitted, and one ship merges together. A task outside a batch never reaches the rules here; inside one, readiness of
// in-batch dependencies is model.ts's versions(), and the task actions call batchSnapshot / batchTransitions below.
import { createHash, randomUUID } from 'node:crypto';
import { actorKey, canonical, MIN_ID_PREFIX, personName, required } from '../../core/collaboration.ts';
import type { Assignment, CollaborationActor, Merge, Review, Submission, Task, TaskChange } from '../../core/collaboration-types.ts';
import type { PluginActionContext, PluginQuery, PluginRefContext } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import type { HubEvent } from '../../core/types.ts';
import { refuseHidden } from './actions.ts';
import { approvedResult, eligible, fail, memberName, missingRoleNames, participantKeys, resolveTaskRef, taskDependencyEvaluation, taskOf } from './model.ts';
import {
  batchTaskRows, collaborationRecord, collaborationRecords, nextBatchNumber, saveCollaborationRecord, saveCollaborationTask, saveTaskBatch,
  taskBatch, taskBatchIdByNumber, taskBatches, type TaskBatch,
} from './store.ts';
import { batchMergedOnTarget } from './ship.ts';
import { takeWatches, taskEnd, watchNoticeBody } from './watches.ts';

export type { TaskBatch };
export const BATCH_ACTIONS = ['batch.create', 'batch.add', 'batch.remove', 'batch.cancel', 'batch.merge', 'batch.shipped', 'batch.ship_failed'];

const BATCH_NUMBER = /^B([1-9]\d*)$/i;
const BATCH_REF_FORMS = 'refer to a batch as B<number> (e.g. B3), its full ID, or a unique prefix of its ID of at least 8 characters; get_batch lists them';

/** A batch reference in this cluster as the full batch ID: B3 by number, otherwise a full ID or a unique 8+ character prefix. */
export function resolveBatchRef(store: Store, clusterId: string, ref: unknown): string {
  if (typeof ref !== 'string' || !ref.trim()) return fail('INVALID_REQUEST', `batchId is required; ${BATCH_REF_FORMS}`);
  const number = BATCH_NUMBER.exec(ref.trim());
  if (number) {
    const id = Number.isSafeInteger(Number(number[1])) ? taskBatchIdByNumber(store, clusterId, Number(number[1])) : null;
    return id ?? fail('OUT_OF_SCOPE', `there is no batch ${ref} in this cluster; ${BATCH_REF_FORMS}`);
  }
  const matches = store.idsMatching('task_batches', clusterId, ref, MIN_ID_PREFIX);
  if (matches.includes(ref)) return ref;
  if (matches.length === 1) return matches[0];
  return fail('OUT_OF_SCOPE', `unknown batch in this cluster: ${ref}; ${BATCH_REF_FORMS}`);
}

export const batchLabel = (batch: Pick<TaskBatch, 'number' | 'title'>) => `批次 B${batch.number}【${batch.title}】`;
const taskLabel = (task: Pick<Task, 'number' | 'title'>) => `#${task.number}【${task.title}】`;

/** Upstream before downstream along the in-batch dependencies; ties (and anything left over) by task number. */
export function dependencyOrder(tasks: Task[]): Task[] {
  const inBatch = new Set(tasks.map((task) => task.id));
  const pending = [...tasks].sort((x, y) => x.number - y.number);
  const out: Task[] = [];
  const placed = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex((task) => task.dependencyIds.every((id) => !inBatch.has(id) || placed.has(id)));
    const [next] = pending.splice(index < 0 ? 0 : index, 1);   // a cycle cannot be saved; never stall on one anyway
    out.push(next);
    placed.add(next.id);
  }
  return out;
}

/**
 * submitted: in review with a submission made against the current dependency versions and definition; approved: completed
 * with a valid result; missing: anything else (not started, working, sent back, or a submission an upstream's new one voided).
 */
export type BatchItemState = 'cancelled' | 'missing' | 'submitted' | 'approved' | 'merged';
export interface BatchItem { task: Task; state: BatchItemState; submission: Submission | null }

/** Where a batch stands. Computed from the tasks every time: nothing about progress is stored. */
export function batchView(store: Store, batch: TaskBatch, evaluation = taskDependencyEvaluation(store, batch.clusterId)) {
  const items: BatchItem[] = dependencyOrder(batchTaskRows(store, batch.clusterId, batch.id)).map((task) => {
    const submission = collaborationRecord<Submission>(store, task.id, 'submission', task.latestSubmissionId) ?? null;
    let state: BatchItemState = 'missing';
    if (task.status === 'cancelled') state = 'cancelled';
    else if ((task.status === 'completed' || task.status === 'merged') && evaluation.completionValid(task)) state = task.status === 'merged' ? 'merged' : 'approved';
    else if (task.status === 'review' && submission) {
      const current = evaluation.versions(task);
      if (current && submission.definitionVersion === task.definitionVersion && canonical(current) === canonical(submission.dependencyVersions)) state = 'submitted';
    }
    return { task, state, submission };
  });
  const live = items.filter((item) => item.state !== 'cancelled');
  const active = !batch.cancelledAt && live.length > 0;
  const done = (item: BatchItem) => item.state === 'approved' || item.state === 'merged';
  return { batch, items, live, missing: live.filter((item) => item.state === 'missing'),
    complete: active && live.every((item) => item.state !== 'missing'),
    approved: active && live.every(done),
    merged: active && live.every((item) => item.state === 'merged') };
}
export type BatchView = ReturnType<typeof batchView>;

export function batchSnapshot(store: Store, clusterId: string, batchId: string | undefined | null): { complete: boolean; approved: boolean } | null {
  const batch = batchId ? taskBatch(store, clusterId, batchId) : null;
  if (!batch) return null;
  const view = batchView(store, batch);
  return { complete: view.complete, approved: view.approved };
}

const STATE_TEXT: Record<string, string> = { pending: '待开工', working: '正在做', review: '待验收', completed: '已通过', merged: '已合并', cancelled: '已取消' };
/** Why a task keeps its batch from being complete, in the words of a refusal or a page. */
export function missingText(item: BatchItem): string {
  const { task } = item;
  const why = task.status === 'review' ? '提交基于前置的旧版本，要重新提交'
    : task.status === 'completed' ? '通过的结果基于前置的旧版本，要重新提交' : STATE_TEXT[task.status] ?? task.status;
  return `#${task.number} ${why}`;
}

/** The approved results a batch ship merges, in dependency order, and who runs it; null unless every live task awaits its merge. */
export function batchShipState(store: Store, clusterId: string, batchId: string) {
  const batch = taskBatch(store, clusterId, batchId);
  if (!batch || batch.cancelledAt) return null;
  const view = batchView(store, batch);
  if (!view.live.length || !view.live.every((item) => item.state === 'approved')) return null;
  const tasks: NonNullable<ReturnType<typeof approvedResult>>[] = [];
  for (const { task } of view.live) {
    const result = approvedResult(store, task);
    if (!result) return null;
    tasks.push(result);
  }
  // The member reviewer runs it when it approved every task; otherwise (the user approved, in its place or as the batch's
  // reviewer) the executor of the last task in dependency order, whose branch is usually the one that holds the others.
  const reviewer = batch.reviewer.kind === 'member' ? batch.reviewer.memberId : null;
  const runner = reviewer && tasks.every((task) => task.reviewer === reviewer && !task.self) ? reviewer : tasks.at(-1)!.executorId;
  const digest = createHash('sha256').update(canonical(tasks.map((task) => [task.task.id, task.submission.id, task.commitSha]))).digest('hex');
  return { batch, tasks, runner, digest, cwds: [...new Set(tasks.flatMap((task) => task.cwds))] };
}
export type BatchShipState = NonNullable<ReturnType<typeof batchShipState>>;

/**
 * Called in the same transaction after a change to one of the batch's tasks (or to the batch): wakes the reviewer once when
 * the batch has just become complete with something to review, and the ship runner once when every task has just been
 * approved. `before` is the snapshot taken before the change, so a retry, a racing submit or a cancel in the same
 * transaction order cannot produce a second notice: only the change that crosses the line does.
 */
export function batchTransitions(ctx: Pick<PluginActionContext, 'store' | 'clusterId' | 'actorId' | 'now' | 'notice'>, batchId: string | undefined | null,
  before: { complete: boolean; approved: boolean } | null, event: HubEvent): string[] {
  const { store, clusterId, actorId } = ctx;
  const batch = batchId ? taskBatch(store, clusterId, batchId) : null;
  if (!batch || batch.cancelledAt) return [];
  const view = batchView(store, batch);
  const woken: string[] = [];
  const submitted = view.live.filter((item) => item.state === 'submitted');
  if (view.complete && !before?.complete && submitted.length) {
    batch.notified = { at: ctx.now, eventId: event.seq, submissions: submitted.map((item) => ({ taskId: item.task.id, submissionId: item.submission!.id })) };
    saveTaskBatch(store, batch);
    const reviewer = batch.reviewer.kind === 'member' ? batch.reviewer.memberId : null;
    const who = reviewer ? ` ${personName(store, clusterId, reviewer)} ` : '用户';
    const lines = view.live.map(({ task, state, submission }) => {
      const commit = submission?.commitSha ? `提交 ${submission.commitSha.slice(0, 7)}` : '没有提交号';
      if (state !== 'submitted') return `- ${taskLabel(task)}${STATE_TEXT[task.status]}：${commit}（没有新提交）`;
      const last = collaborationRecords<Review>(store, task.id, 'review').at(-1);
      return `- ${taskLabel(task)}待验收：${commit}（新提交${last ? `，上一轮${last.verdict === 'reject' ? '退回' : '通过'}` : ''}）`;
    });
    const recipients = reviewer && reviewer !== actorId ? [reviewer] : [];
    woken.push(...recipients);
    ctx.notice(event, { systemKind: 'task', recipients, retain: true,
      body: [`${batchLabel(batch)}的任务都已提交，请${who}一起验收：每个任务各自给结论（task_action review），全部通过后一次 ship 合并整批，事件 ${event.seq}。`, ...lines].join('\n') });
  }
  if (view.approved && !before?.approved && !view.merged) {
    const state = batchShipState(store, clusterId, batch.id);
    if (state && state.runner !== actorId) {
      woken.push(state.runner);
      ctx.notice(event, { systemKind: 'task', recipients: [state.runner], retain: true,
        body: `${batchLabel(batch)}的 ${state.tasks.length} 个任务都已验收通过，请 ${personName(store, clusterId, state.runner)} 用 get_batch 取批次 ship 命令并运行（一次合并整批，检查只跑一遍），事件 ${event.seq}。` });
    }
  }
  return woken;
}

/** The batch a member reviewer may review this task in: complete now, or this very submission was in the last complete notice. */
export function refuseEarlyReview(store: Store, task: Task): void {
  const batch = task.batchId ? taskBatch(store, task.clusterId, task.batchId) : null;
  if (!batch) return;
  if (batch.notified?.submissions.some((item) => item.taskId === task.id && item.submissionId === task.latestSubmissionId)) return;
  const view = batchView(store, batch);
  if (view.complete) return;
  fail('BATCH_INCOMPLETE', `${batchLabel(batch)} is not complete yet; you are woken once every task of it is submitted. Still missing: ${view.missing.map(missingText).join('、')}`);
}

/** Whether this review task waits for its batch: its member reviewer has nothing to do yet (stalled and idle reminders skip it). */
export function waitsForBatch(store: Store, task: Pick<Task, 'id' | 'clusterId' | 'status'> & { batchId?: string | null }): boolean {
  if (task.status !== 'review' || !task.batchId) return false;
  try { refuseEarlyReview(store, taskOf(store, task.clusterId, task.id)); return false; } catch { return true; }
}

/**
 * The rules for a task joining a batch (at creation or with batch.add): the batch takes tasks until its first review, the
 * task has not started, needs a merge, is in no other batch and is not self-reviewed; the batch's reviewer becomes its
 * reviewer and must be independent of it and hold its review roles.
 */
export function checkJoin(store: Store, batch: TaskBatch, task: Task): void {
  if (batch.cancelledAt) fail('INVALID_STATE', `${batchLabel(batch)} is cancelled; create a new batch`);
  if (batch.reviewedAt) fail('INVALID_STATE', `${batchLabel(batch)} already has a review, so no task can join it now; create a new batch`);
  if (task.batchId) fail('INVALID_STATE', task.batchId === batch.id ? 'the task is already in this batch' : 'the task is in another batch; remove it there first (batch remove)');
  if (task.status !== 'pending') fail('INVALID_STATE', 'only a task whose work has not started can join a batch');
  if (!task.mergeRequired) fail('INVALID_REQUEST', 'every task in a batch needs a merge (mergeRequired true); a task with no code to merge stays outside batches');
  if (task.reviewer.kind === 'self') fail('INVALID_STATE', 'a self-review task cannot join a batch; change its reviewer first');
  if (batch.reviewer.kind === 'member') {
    const id = batch.reviewer.memberId;
    const member = store.getMember(id);
    if (member?.clusterId !== batch.clusterId) fail('INVALID_STATE', `the batch reviewer ${memberName(store, id)} is no longer in this cluster; cancel the batch and create a new one`);
    if (task.assignedMemberId === id || participantKeys(collaborationRecords<Assignment>(store, task.id, 'assignment')).includes(actorKey(member!))) {
      fail('REVIEW_NOT_INDEPENDENT', `the batch reviewer ${memberName(store, id)} works on this task, so it cannot join the batch`);
    }
    if (!eligible(store, batch.clusterId, id, task.reviewRoleIds)) {
      fail('ROLE_REQUIRED', `the batch reviewer ${memberName(store, id)} lacks roles: ${missingRoleNames(store, batch.clusterId, id, task.reviewRoleIds).join(', ')}`);
    }
  }
}

/** Who may change which tasks are in a batch: the user, the coordinator (taskPlanning), or the member who created the batch and the task. */
const arrangerAllowed = (ctx: PluginActionContext, batch: TaskBatch, task?: Task) =>
  ctx.actor.kind === 'member' && ctx.actorId === batch.createdBy && (!task || task.createdBy === ctx.actorId);

function batchReviewer(ctx: PluginActionContext, value: unknown): TaskBatch['reviewer'] {
  const { store, clusterId, actor, actorId, collaboration } = ctx;
  const reviewer = value as CollaborationActor | undefined;
  if (reviewer?.kind === 'user') return { kind: 'user' };
  if (reviewer?.kind !== 'member') return fail('INVALID_REQUEST', 'reviewer must be the user or a member; a batch is never self-reviewed');
  const member = collaboration.member(clusterId, (reviewer as { memberId?: unknown }).memberId);
  refuseHidden(store, clusterId, actor, actorId, member.id);
  const policy = store.coordinator?.policy(clusterId);
  if (policy?.enabled && policy.memberId === member.id) fail('FORBIDDEN', `${member.name} is the coordinator and cannot review; name the user or another member`);
  return { kind: 'member', memberId: member.id };
}

/** Every later check and the event see full IDs. */
export function resolveBatchRefs({ store, clusterId, command, collaboration }: PluginRefContext) {
  const out = { ...command };
  if (command.action !== 'batch.create') out.batchId = resolveBatchRef(store, clusterId, command.batchId);
  if (typeof command.taskId === 'string') out.taskId = resolveTaskRef(store, clusterId, command.taskId);
  if (command.reviewer?.kind === 'member') out.reviewer = { kind: 'member', memberId: collaboration.memberRef(clusterId, command.reviewer.memberId) };
  return out;
}

/** The tasks a check failure sends back: those no other live task of the batch depends on (the ends of its chains). */
function batchEnds(tasks: Task[]): Task[] {
  return tasks.filter((task) => !tasks.some((other) => other.dependencyIds.includes(task.id)));
}

const sha = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value)) return fail('INVALID_REQUEST', 'commitSha must be 7-40 hexadecimal characters');
  return value.toLowerCase();
};

/** batch.* (docs/collaboration.md「验收批次」). Runs inside the command's transaction, like the task actions. */
export function runBatchAction(ctx: PluginActionContext): Record<string, unknown> {
  const { store, actor, actorId, clusterId, command, now } = ctx;
  const action = command.action;
  let suggest = false;
  const management = (permission: Parameters<PluginActionContext['management']>[0], ordinaryAllowed = false) => {
    if (ctx.management(permission, ordinaryAllowed)) suggest = true;
  };
  const out: Record<string, unknown> = {};
  const saved: Task[] = [];   // tasks this action changed, saved with a new revision below
  const recipients = new Set<string>();
  const infoOnly = new Set<string>();
  const changes: TaskChange[] = [];
  let task: Task | undefined;
  let body: (event: HubEvent) => string = () => '';
  let systemKind: 'task' | 'ship_failed' = 'task';
  let mergedTasks: Task[] = [];
  let shipRunner: string | null = null;
  const save = (item: Task) => { if (!saved.includes(item)) saved.push(item); };
  const info = (id: string | null | undefined) => { if (id) { recipients.add(id); infoOnly.add(id); } };
  const wake = (id: string | null | undefined) => { if (id) { recipients.add(id); infoOnly.delete(id); } };

  let batch: TaskBatch;
  if (action === 'batch.create') {
    management('taskPlanning', true);
    management('reviewerManagement', true);
    batch = { id: randomUUID(), clusterId, number: 0 /* taken when saved, below */, title: required(command.title, 'title', 200),
      reviewer: batchReviewer(ctx, command.reviewer), createdBy: actorId, createdAt: now, cancelledAt: null, reviewedAt: null, notified: null, shipFailure: null };
  } else {
    batch = taskBatch(store, clusterId, command.batchId!) ?? fail('OUT_OF_SCOPE', `unknown batch in this cluster; ${BATCH_REF_FORMS}`);
  }
  const before = action === 'batch.create' ? null : batchSnapshot(store, clusterId, batch.id);
  const reviewerId = batch.reviewer.kind === 'member' ? batch.reviewer.memberId : null;
  if (action === 'batch.add' || action === 'batch.remove') {
    task = taskOf(store, clusterId, command.taskId);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== task.revision) return fail('STALE_REVISION', 'task revision changed; read the current revision with get_task and retry with it as expectedRevision');
  }

  if (action === 'batch.create') {
    body = (event) => `${batchLabel(batch)}已创建（验收者 ${reviewerId ? personName(store, clusterId, reviewerId) : '用户'}，建单人 ${personName(store, clusterId, actorId)}），事件 ${event.seq}。`;
    info(reviewerId);
  } else if (action === 'batch.add' && task) {
    const reviewerChanges = canonical(task.reviewer) !== canonical(batch.reviewer);
    const reviewed = collaborationRecords<Review>(store, task.id, 'review').length > 0;
    management('taskPlanning', arrangerAllowed(ctx, batch, task));
    // Joining sets the task's reviewer, so the reviewer rule of task.edit applies too (docs/collaboration.md).
    if (reviewerChanges) management('reviewerManagement', arrangerAllowed(ctx, batch, task) && !reviewed);
    checkJoin(store, batch, task);
    batch.notified = null;   // the old ready notice did not include this task
    const previous = structuredClone(task.reviewer);
    task.batchId = batch.id;
    task.reviewer = structuredClone(batch.reviewer);
    if (reviewerChanges) changes.push({ field: 'reviewer', before: previous, after: task.reviewer });
    save(task);
    info(task.assignedMemberId); info(reviewerId);
    if (previous.kind === 'member' && previous.memberId !== reviewerId) info(previous.memberId);
    const joined = task;
    body = (event) => `任务 ${taskLabel(joined)}加入了${batchLabel(batch)}${reviewerChanges ? `，验收者改为 ${reviewerId ? personName(store, clusterId, reviewerId) : '用户'}` : ''}，事件 ${event.seq}。`;
  } else if (action === 'batch.remove' && task) {
    management('taskPlanning', arrangerAllowed(ctx, batch, task));
    if (task.batchId !== batch.id) return fail('INVALID_STATE', 'the task is not in this batch');
    if (task.status !== 'pending' && task.status !== 'cancelled') return fail('INVALID_STATE', 'a task leaves its batch only before its work starts (or once cancelled); cancel the batch to release started tasks');
    delete task.batchId;
    save(task);
    info(task.assignedMemberId); info(reviewerId);
    const left = task;
    body = (event) => `任务 ${taskLabel(left)}移出了${batchLabel(batch)}，事件 ${event.seq}。`;
  } else if (action === 'batch.cancel') {
    management('cancelReopen', actor.kind === 'member' && batch.createdBy === actorId);
    if (batch.cancelledAt) return fail('INVALID_STATE', 'the batch is already cancelled');
    if (batchView(store, batch).merged) return fail('INVALID_STATE', 'the batch is already merged; there is nothing to cancel');
    const reason = required(command.reason, 'reason');
    batch.cancelledAt = now;
    const released = batchTaskRows(store, clusterId, batch.id);
    for (const item of released) { delete item.batchId; save(item); info(item.assignedMemberId); }
    // A task waiting in review is an ordinary task from now on: its member reviewer must hear it, or it would sit unseen.
    const waiting = released.filter((item) => item.status === 'review');
    if (waiting.length) wake(reviewerId); else info(reviewerId);
    body = (event) => `${batchLabel(batch)}已取消（原因：${reason}），其中的任务回到普通任务：${released.map((item) => `#${item.number}`).join('、') || '无'}`
      + `${waiting.length ? `；等 ${reviewerId ? personName(store, clusterId, reviewerId) : '用户'} 验收的任务：${waiting.map((item) => `#${item.number}`).join('、')}` : ''}，事件 ${event.seq}。`;
  } else if (action === 'batch.merge' || action === 'batch.shipped') {
    if (action === 'batch.shipped' && actor.kind !== 'system') return fail('FORBIDDEN', 'only a verified ship report can record this; run the batch ship command');
    if (action === 'batch.merge') management('taskPlanning', true);
    const state = batchShipState(store, clusterId, batch.id) ?? fail('INVALID_STATE', 'the batch has no fully approved result awaiting its merge');
    const commit = sha(command.commitSha);
    if (action === 'batch.shipped' && canonical(state.tasks.map((item) => ({ taskId: item.task.id, submissionId: item.submission.id }))) !== canonical(command.batchSubmissions)) {
      return fail('INVALID_STATE', 'the batch changed since the ship ticket was checked');
    }
    // The way out when ship landed but could not report: only what git shows counts, as for a ship report.
    if (action === 'batch.merge' && !suggest && !batchMergedOnTarget(state.cwds, commit, state.tasks.map((item) => item.commitSha))) {
      return fail('MERGE_NOT_VERIFIED', `${commit} is not on the target branch with every reviewed commit of the batch merged by it`);
    }
    shipRunner = state.runner;
    for (const item of state.tasks) {
      const merge: Merge = { id: randomUUID(), taskId: item.task.id, commitSha: commit, submissionId: item.submission.id,
        reason: typeof command.reason === 'string' ? command.reason.slice(0, 50_000) : '', recordedBy: actor, createdAt: now };
      if (!suggest) saveCollaborationRecord(store, item.task.id, 'merge', merge);
      item.task.status = 'merged'; item.task.mergedCommitSha = commit; item.task.mergedSubmissionId = merge.submissionId;
      save(item.task);
    }
    mergedTasks = state.tasks.map((item) => item.task);
    body = (event) => `${batchLabel(batch)}已合并（提交 ${commit.slice(0, 7)}）：${mergedTasks.map((item) => `#${item.number}`).join('、')}，事件 ${event.seq}。`;
  } else if (action === 'batch.ship_failed') {
    if (actor.kind !== 'system') return fail('FORBIDDEN', 'only a verified ship report can record this; run the batch ship command');
    const state = batchShipState(store, clusterId, batch.id) ?? fail('INVALID_STATE', 'the batch has no fully approved result awaiting its merge');
    if (canonical(state.tasks.map((item) => ({ taskId: item.task.id, submissionId: item.submission.id }))) !== canonical(command.batchSubmissions)) {
      return fail('INVALID_STATE', 'the batch changed since the ship ticket was checked');
    }
    const kind = command.failure?.kind;
    if (kind !== 'conflict' && kind !== 'checks') return fail('INVALID_REQUEST', 'failure.kind must be conflict or checks');
    required(command.reason, 'reason');
    // A conflict is the branch that did not merge; a failed check cannot be pinned on one task, so the tasks whose branches
    // end the batch's chains go back: their branches hold the combined work the checks ran on.
    const live = state.tasks.map((item) => item.task);
    const returned = kind === 'conflict' ? live.filter((item) => item.id === command.failure?.taskId) : batchEnds(live);
    if (!returned.length) return fail('INVALID_REQUEST', 'failure.taskId must name a task of the batch');
    for (const item of returned) {
      const approved = collaborationRecord<Submission>(store, item.id, 'submission', item.approvedSubmissionId);
      const executor = approved && collaborationRecords<Assignment>(store, item.id, 'assignment').find((a) => a.id === approved.assignmentId)?.memberId;
      item.approvedSubmissionId = null; item.status = 'pending';
      item.assignedMemberId = executor && store.getMember(executor)?.clusterId === clusterId ? executor : null;
      // The member who ran ship saw its output in that turn; the actor is the system, so "not the actor" does not cover them.
      if (item.assignedMemberId === state.runner) info(item.assignedMemberId); else wake(item.assignedMemberId);
      save(item);
    }
    info(reviewerId);
    batch.shipFailure = { kind, taskIds: returned.map((item) => item.id), at: now, eventId: 0 };
    systemKind = 'ship_failed';
    const list = returned.map((item) => `#${item.number}`).join('、');
    body = (event) => `${batchLabel(batch)}合并失败：${kind === 'conflict' ? `任务 ${list} 的分支有合并冲突，已退回它的执行者` : `合并前检查未通过，无法归到单个任务，已退回批次末端的任务 ${list}`}，其余任务保持通过，事件 ${event.seq}。`;
  } else {
    return fail('INVALID_REQUEST', 'unsupported batch action');
  }

  if (!suggest) {
    if (action === 'batch.create') batch.number = nextBatchNumber(store, clusterId);
    saveTaskBatch(store, batch);
    for (const item of saved) { item.revision++; item.updatedAt = now; saveCollaborationTask(store, item); }
  }
  out.batch = batch;
  if (task) out.task = task;

  ctx.outcome.payload = (suggested) => ({ action, batchId: batch.id,
    ...(task ? { taskId: task.id } : saved.length ? { taskIds: saved.map((item) => item.id) } : {}),
    ...(changes.length ? { changes } : {}),
    ...(typeof command.reason === 'string' && command.reason.trim() ? { reason: command.reason } : {}),
    ...(command.commitSha && (action === 'batch.merge' || action === 'batch.shipped') ? { commitSha: String(command.commitSha).toLowerCase() } : {}),
    ...(action === 'batch.ship_failed' ? { failure: { kind: command.failure!.kind, ...(command.failure!.taskId ? { taskId: command.failure!.taskId } : {}) } } : {}),
    ...(command.sourceEventId !== undefined ? { sourceEventId: command.sourceEventId } : {}),
    ...(suggested ? { suggested: true } : {}) });

  ctx.outcome.afterEvent = (event) => {
    if (suggest) return;
    if (batch.shipFailure && action === 'batch.ship_failed') { batch.shipFailure.eventId = event.seq; saveTaskBatch(store, batch); }
    const policy = store.coordinator?.policy(clusterId);
    if (policy?.enabled) recipients.delete(policy.memberId);   // normal progress does not wake the coordinator
    recipients.delete(actorId);
    const woken = new Set([...recipients].filter((id) => !infoOnly.has(id)));
    ctx.notice(event, { systemKind, body: body(event), recipients: [...recipients], wake: [...woken], retain: true,
      ...(task ? { taskId: task.id, collabEventId: event.seq } : {}) });
    for (const id of batchTransitions(ctx, batch.id, before, event)) woken.add(id);
    if (!mergedTasks.length) return;
    // A merge makes ready the tasks outside the batch that waited for it, and ends the merged tasks' watches.
    const evaluation = taskDependencyEvaluation(store, clusterId);
    const mergedIds = new Set(mergedTasks.map((item) => item.id));
    const told = new Set<string>();
    for (const dependent of allClusterTasks(store, clusterId)) {
      if (dependent.batchId === batch.id || !dependent.dependencyIds.some((id) => mergedIds.has(id)) || dependent.proposalState === 'proposed') continue;
      const owner = dependent.assignedMemberId;
      if (!owner || !['pending', 'working'].includes(dependent.status) || evaluation.versions(dependent) === null || told.has(dependent.id)) continue;
      if (policy?.enabled && owner === policy.memberId) continue;
      told.add(dependent.id); woken.add(owner);
      ctx.notice(event, { systemKind: 'task', recipients: [owner], taskId: dependent.id, taskStamp: { taskId: dependent.id, revision: dependent.revision, submissionId: dependent.latestSubmissionId },
        body: `前置依赖已就绪：任务 #${dependent.number}「${dependent.title}」（${dependent.id}），事件 ${event.seq}。请查看任务上下文。` });
    }
    for (const item of mergedTasks) {
      const ended = taskEnd(store, item);
      const watchers = ended ? takeWatches(store, item.id).filter((watch) => watch.memberId !== shipRunner && !store.getMember(watch.memberId)?.hiddenAt) : [];
      if (!ended || !watchers.length) continue;
      const ids = watchers.map((watch) => watch.memberId);
      ctx.notice(event, { systemKind: 'task', recipients: ids, wake: ids.filter((id) => !woken.has(id)), taskId: item.id,
        body: watchNoticeBody(item, ended, event.seq, watchers.map((watch) => ({ name: personName(store, clusterId, watch.memberId), note: watch.note }))) });
    }
  };
  return out;
}

function allClusterTasks(store: Store, clusterId: string): Task[] {
  return store.db.prepare('SELECT id FROM collaboration_tasks WHERE cluster_id = ? ORDER BY rowid').all(clusterId)
    .map((row) => taskOf(store, clusterId, String(row.id)));
}

/** One batch as get_batch and the page read it. */
export function batchSummary(store: Store, batch: TaskBatch, view = batchView(store, batch)) {
  const evaluation = taskDependencyEvaluation(store, batch.clusterId);
  const count = (states: BatchItemState[]) => view.live.filter((item) => states.includes(item.state)).length;
  return {
    id: batch.id, number: batch.number, title: batch.title, reviewer: batch.reviewer, createdBy: batch.createdBy, createdAt: batch.createdAt,
    cancelledAt: batch.cancelledAt, reviewedAt: batch.reviewedAt, shipFailure: batch.shipFailure,
    total: view.live.length, submitted: count(['submitted', 'approved', 'merged']), approved: count(['approved', 'merged']),
    complete: view.complete, allApproved: view.approved, merged: view.merged,
    missing: view.missing.map(missingText),
    tasks: view.items.map(({ task, state, submission }) => ({ id: task.id, number: task.number, title: task.title, status: task.status, state,
      assignedMemberId: task.assignedMemberId, dependencyIds: task.dependencyIds, commitSha: submission?.commitSha ?? null,
      branch: task.gitBranch?.branch ?? null, dependenciesReady: evaluation.versions(task) !== null })),
  };
}

/** The `batch` query: one batch (batchId) or every batch of the cluster, newest first (cancelled ones only with includeClosed). */
export const batchQuery: PluginQuery = ({ store, clusterId, query }) => {
  const q = query as typeof query & { batchId?: string };
  if (q.batchId !== undefined) {
    const batch = taskBatch(store, clusterId, resolveBatchRef(store, clusterId, q.batchId))!;
    return { batch: batchSummary(store, batch) } as never;
  }
  const batches = taskBatches(store, clusterId).filter((batch) => query.includeClosed || !batch.cancelledAt);
  return { batches: batches.map((batch) => batchSummary(store, batch)) } as never;
};

/**
 * A dependency in the same batch as the task, with a current submission: the branch and commit to build on
 * (get_task, get_task_context). Branch is the upstream's linked Git branch, when its executor linked one.
 */
export function batchBase(store: Store, task: Task, upstream: Task): { submissionId: string; commitSha: string | null; branch: string | null } | null {
  if (!task.batchId || upstream.batchId !== task.batchId || !upstream.latestSubmissionId) return null;
  if (!['review', 'completed', 'merged'].includes(upstream.status)) return null;
  const submission = collaborationRecord<Submission>(store, upstream.id, 'submission', upstream.latestSubmissionId);
  return { submissionId: upstream.latestSubmissionId, commitSha: submission?.commitSha ?? null, branch: upstream.gitBranch?.branch ?? null };
}
