import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import type { CollaborationActor, CollaborationCommand, Task, TaskResult, Submission } from '../src/core/collaboration-types.ts';
import { collaborationRecords, collaborationTasks, saveCollaborationRecord, saveCollaborationTask } from '../src/plugins/tasks/package/hub/store.mts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';

const user: CollaborationActor = { kind: 'user' };
const member = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
const a = member('a'), b = member('b'), coordinator = member('coord');
function fixture(t: TestContext) {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, ['a', 'b', 'coord'].map((id) => ({
    id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null,
  })));
  const hub = new Hub({ store, nativeAdapters: {} });
  t.after(async () => { await hub.close(); store.close(); });
  let serial = 0;
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
    hub.collaboration.command(actor, 'c', { ...command, operationId: 'op-' + ++serial });
  const create = (extra: Partial<CollaborationCommand> = {}, actor = user) => send(actor, {
    action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done', ...extra,
  }).task!;
  const query = (taskId: string, cursor?: string, limit?: number) =>
    hub.collaboration.query(user, 'c', { kind: 'task', taskId, cursor, limit }) as TaskResult;
  const act = (actor: CollaborationActor, task: Task, command: Partial<CollaborationCommand> & { action: CollaborationCommand['action'] }) =>
    send(actor, { taskId: task.id, expectedRevision: query(task.id).task.revision, ...command });
  const start = (task: Task) => {
    const claim = act(a, task, { action: 'task.claim' });
    return act(a, task, { action: 'task.start', assignmentId: claim.assignment!.id }).task!;
  };
  const evidence = hub.sendFromUser('c', 'proof');
  const submit = (task: Task, extra: Partial<CollaborationCommand> = {}) => act(a, task, {
    action: 'task.submit', assignmentId: query(task.id).task.currentAssignmentId!, summary: 'result',
    evidenceMessageIds: [evidence.id], commitSha: 'ABCDEF0', ...extra,
  });
  const complete = (task: Task, sha = 'abcdef0') => {
    start(task); const result = submit(task, { commitSha: sha });
    return act(user, task, { action: 'task.review', submissionId: result.submission!.id, verdict: 'approve' }).task!;
  };
  /** What a ship report records; task.merge itself needs a real merge in git (test/ship.test.ts). */
  const shipped = (task: Task, commitSha: string, reason = 'ship') =>
    act({ kind: 'system' }, task, { action: 'task.shipped', submissionId: query(task.id).task.approvedSubmissionId!, commitSha, reason });
  return { store, hub, send, create, query, act, start, submit, complete, shipped };
}
const code = (expected: string) => (error: unknown) => !!error && (error as { code?: string }).code === expected;

test('approval gates nominations, claims and starts, binds actual definitions, and records user decisions', (t) => {
  const f = fixture(t);
  const task = f.create({ requiresApproval: true }, a);
  assert.equal(task.mergeRequired, true);
  assert.equal(task.proposalState, 'proposed');
  const notice = f.store.listMessages('c', 100).at(-1)!;
  assert.match(notice.body, /等待用户批准/);
  assert.deepEqual(notice.mentions, []);
  for (const action of ['task.nominate', 'task.claim', 'task.start'] as const) {
    assert.throws(() => f.act(a, task, { action, memberId: 'a' }), code('APPROVAL_REQUIRED'));
  }
  assert.throws(() => f.act(a, task, { action: 'task.approve', verdict: 'approve' }), code('FORBIDDEN'));
  assert.throws(() => f.act(user, task, { action: 'task.approve', verdict: 'reject' }), code('INVALID_REQUEST'));
  f.act(user, task, { action: 'task.approve', verdict: 'reject', reason: 'explain scope' });
  f.act(user, task, { action: 'task.edit', proposalState: 'active' });
  const approved = f.query(task.id);
  assert.deepEqual(approved.approvals.map((record) => [record.verdict, record.definitionVersion]), [['reject', 1], ['approve', 1]]);
  f.act(a, task, { action: 'task.claim' });
  f.act(a, task, { action: 'task.edit', scope: task.scope, labels: ['planned'] });
  assert.equal(f.query(task.id).task.definitionVersion, 1);
  assert.equal(f.query(task.id).task.proposalState, 'active');
  const edited = f.act(a, task, { action: 'task.edit', scope: 'changed' }).task!;
  assert.equal(edited.definitionVersion, 2);
  assert.equal(edited.proposalState, 'proposed');
  assert.ok(edited.currentAssignmentId, 'accepted assignment is retained');
  assert.throws(() => f.act(a, task, { action: 'task.start', assignmentId: edited.currentAssignmentId! }), code('APPROVAL_REQUIRED'));
  f.act(user, task, { action: 'task.approve', verdict: 'approve' });
  f.act(a, task, { action: 'task.start', assignmentId: edited.currentAssignmentId! });
  f.act(a, task, { action: 'task.edit', scope: 'changed', labels: ['working'] });
  assert.equal(f.query(task.id).task.definitionVersion, 2, 'same-value definition fields also work after starting');
  assert.throws(() => f.act(a, task, { action: 'task.edit', mergeRequired: false }), code('INVALID_STATE'));
});

test('approval toggle permissions, cancellation and legacy approval never bypass the gate', (t) => {
  const f = fixture(t), task = f.create({}, a);
  assert.equal(task.requiresApproval, false);
  assert.throws(() => f.act(b, task, { action: 'task.edit', requiresApproval: true }), code('FORBIDDEN'));
  f.act(a, task, { action: 'task.edit', requiresApproval: true });
  assert.throws(() => f.act(a, task, { action: 'task.edit', requiresApproval: false }), code('FORBIDDEN'));
  const disabled = f.act(user, task, { action: 'task.edit', requiresApproval: false });
  assert.equal(disabled.task!.proposalState, 'active');
  assert.equal(f.query(task.id).approvals.length, 0, 'disabling is audited as an edit, not an approval');
  assert.deepEqual((f.store.getEvent(disabled.eventId)!.payload as any).changes, [{ field: 'requiresApproval', before: true, after: false }]);
  f.act(user, task, { action: 'task.edit', requiresApproval: true });
  f.act(user, task, { action: 'task.cancel', reason: 'paused design' });
  assert.equal(f.query(task.id).task.proposalState, 'proposed');
  for (const command of [{ action: 'task.approve', verdict: 'approve' }, { action: 'task.edit', proposalState: 'active' },
    { action: 'task.edit', requiresApproval: false }] as const) assert.throws(() => f.act(user, task, command), code('INVALID_STATE'));
  f.act(user, task, { action: 'task.reopen', reason: 'resume design' });
  assert.equal(f.query(task.id).task.proposalState, 'proposed');
  f.act(user, task, { action: 'task.approve', verdict: 'approve' });
  f.act(a, task, { action: 'task.claim' });
  f.act(user, task, { action: 'task.edit', requiresApproval: false });
  assert.throws(() => f.act(user, task, { action: 'task.edit', requiresApproval: true }), code('INVALID_STATE'));
});

test('submission SHA, supersession and global review rounds keep every reviewed version traceable', (t) => {
  const f = fixture(t), task = f.create({ reviewer: b });
  f.start(task);
  assert.throws(() => f.submit(task, { commitSha: undefined }), code('INVALID_REQUEST'));
  assert.throws(() => f.submit(task, { commitSha: 'not-a-sha' }), code('INVALID_REQUEST'));
  const first = f.submit(task).submission!;
  assert.equal(first.commitSha, 'abcdef0');
  const second = f.submit(task, { commitSha: '1234567' }).submission!;
  assert.throws(() => f.act(b, task, { action: 'task.review', submissionId: first.id, verdict: 'approve', reason: 'old' }), code('STALE_SUBMISSION'));
  assert.throws(() => f.act(b, task, { action: 'task.review', submissionId: second.id, verdict: 'approve' }), code('INVALID_REQUEST'));
  assert.throws(() => f.act(b, task, { action: 'task.review', submissionId: second.id, verdict: 'approve', reason: 'x'.repeat(50_001) }), code('INVALID_REQUEST'));
  f.act(b, task, { action: 'task.review', submissionId: second.id, verdict: 'reject', reason: 'fix' });
  const third = f.submit(task, { commitSha: '7654321' }).submission!;
  f.act(b, task, { action: 'task.review', submissionId: third.id, verdict: 'approve', reason: 'x'.repeat(50_000) });
  assert.throws(() => f.submit(task), code('STALE_ASSIGNMENT'));
  f.act(b, task, { action: 'task.reopen', reason: 'resolve conflict' });
  assert.equal(f.query(task.id).task.approvedSubmissionId, null);
  f.start(task); const fourth = f.submit(task, { commitSha: 'fedcba0' }).submission!;
  f.act(user, task, { action: 'task.review', submissionId: fourth.id, verdict: 'approve' });
  const page2 = f.query(task.id, '1', 1), page3 = f.query(task.id, '2', 1);
  assert.deepEqual(page2.reviews.map((r) => [r.round, r.commitSha]), [[2, '7654321']]);
  assert.deepEqual(page3.reviews.map((r) => [r.round, r.commitSha]), [[3, 'fedcba0']]);
  assert.deepEqual(f.query(task.id).submissions.map((s) => s.superseded), [true, true, true, false]);
  assert.ok(collaborationRecords<any>(f.store, task.id, 'review').every((r) => !('round' in r) && !('commitSha' in r)));
  assert.ok(collaborationRecords<Submission>(f.store, task.id, 'submission').every((s) => !('superseded' in s)));
});

test('merge gates dependency readiness, not completion validity, and reopen preserves merge history', (t) => {
  const f = fixture(t), upstream = f.create({ reviewer: b }), downstream = f.create({ dependencyIds: [upstream.id] });
  f.act(user, downstream, { action: 'task.nominate', memberId: 'a' });
  const completed = f.complete(upstream);
  assert.equal(completed.completionValid, true);
  assert.equal(f.query(downstream.id).task.dependenciesReady, false);
  assert.ok(!f.store.listMessages('c', 100).some((m) => m.body.includes('前置依赖已就绪')));
  f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' });
  const merged = f.shipped(upstream, 'ABCDEF1', 'merged main');
  assert.equal(merged.task!.status, 'merged');
  assert.equal(merged.task!.completionValid, true);
  assert.equal(merged.task!.mergedCommitSha, 'abcdef1');
  assert.equal(merged.task!.mergedSubmissionId, completed.approvedSubmissionId);
  assert.equal(f.query(downstream.id).task.dependenciesReady, true);
  const messages = f.store.listMessages('c', 100);
  assert.ok(messages.some((m) => m.mentions.includes('a') && m.body.includes('前置依赖已就绪')));
  const mergeRecord = messages.find((m) => m.body.includes('已合并（提交 abcdef1）'));
  assert.ok(mergeRecord && !mergeRecord.mentions.includes('coord'), 'the group keeps the merge record without telling the coordinator');
  assert.throws(() => f.act(b, upstream, { action: 'task.merge', commitSha: 'abcdef2' }), code('INVALID_STATE'));
  const childComplete = f.complete(downstream);
  f.shipped(downstream, 'aaaaaaa');
  f.act(b, upstream, { action: 'task.reopen', reason: 'new revision' });
  const reopened = f.query(upstream.id);
  assert.equal(reopened.task.approvedSubmissionId, null);
  assert.equal(reopened.task.mergedCommitSha, null);
  assert.equal(reopened.task.mergedSubmissionId, null);
  assert.equal(reopened.merges[0].submissionId, completed.approvedSubmissionId);
  assert.equal(f.query(downstream.id).task.completionValid, false);
  assert.equal(f.query(downstream.id).task.approvedSubmissionId, childComplete.approvedSubmissionId);
  assert.throws(() => f.submit(downstream), code('STALE_ASSIGNMENT'), 'merged results must reopen, including invalidated ones');
});

test('merge respects coordinator generation, permission and suggest mode; approval is always user only', (t) => {
  const f = fixture(t), task = f.complete(f.create());
  const persistedNothing = () => {
    const current = f.query(task.id);
    assert.deepEqual([current.task.status, current.task.mergedCommitSha, current.task.mergedSubmissionId, current.merges], ['completed', null, null, []]);
  };
  let policy = f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute', permissions: { taskPlanning: false } }).coordinator!;
  assert.throws(() => f.act(coordinator, task, { action: 'task.merge', commitSha: 'abcdef1' }), code('STALE_POLICY'));
  persistedNothing();
  assert.throws(() => f.act(coordinator, task, { action: 'task.merge', commitSha: 'abcdef1', generation: policy.generation }), code('FORBIDDEN'));
  persistedNothing();
  policy = f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'suggest' }).coordinator!;
  assert.ok(f.act(coordinator, task, { action: 'task.merge', commitSha: 'abcdef1', generation: policy.generation }).suggestion);
  persistedNothing();
  policy = f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }).coordinator!;
  assert.throws(() => f.act(coordinator, task, { action: 'task.merge', commitSha: 'abcdef1', generation: policy.generation }), code('MERGE_NOT_VERIFIED'), 'allowed, but git does not show it');
  const proposed = f.create({ requiresApproval: true });
  assert.throws(() => f.act(coordinator, proposed, { action: 'task.approve', verdict: 'approve', generation: policy.generation }), code('FORBIDDEN'));
  const ordinary = f.create();
  f.act(coordinator, ordinary, { action: 'task.edit', requiresApproval: true, generation: policy.generation });
  assert.equal(f.query(ordinary.id).task.proposalState, 'proposed');
  assert.throws(() => f.act(coordinator, ordinary, { action: 'task.edit', requiresApproval: false, generation: policy.generation }), code('FORBIDDEN'));
  const nonmerge = f.complete(f.create({ mergeRequired: false }));
  assert.throws(() => f.act(user, nonmerge, { action: 'task.merge', commitSha: 'abcdef1' }), code('INVALID_STATE'));
});

test('approval and merge history participate in the shared cursor even when other records are shorter', (t) => {
  const f = fixture(t), task = f.create({ requiresApproval: true });
  for (let i = 0; i < 3; i++) f.act(user, task, { action: 'task.approve', verdict: 'reject', reason: 'revise' });
  assert.equal(f.query(task.id, undefined, 1).nextCursor, '1');
  assert.equal(f.query(task.id, '1', 1).nextCursor, '2');
  assert.equal(f.query(task.id, '2', 1).nextCursor, null);
  assert.equal(f.query(task.id, '2', 1).approvals.length, 1);
  // Exercise merge-only cursor contribution without manufacturing task state transitions.
  for (let i = 0; i < 4; i++) saveCollaborationRecord(f.store, task.id, 'merge', { id: 'historic-merge-' + i });
  assert.equal(f.query(task.id, '2', 1).nextCursor, '3');
  assert.equal(f.query(task.id, '3', 1).merges.length, 1);
});

test('the merge window actions are gone and an old window row is neither read nor removed', (t) => {
  const f = fixture(t);
  f.store.db.prepare('INSERT INTO merge_windows (cluster_id, data_json) VALUES (?, ?)').run('c', JSON.stringify({ holderMemberId: 'a', taskId: null, baseSha: 'abcdef0', claimedAt: '2026-01-01' }));
  for (const action of ['merge.claim', 'merge.release', 'merge.assign', 'merge.revoke']) {
    assert.throws(() => f.send(a, { action, commitSha: 'abcdef0', memberId: 'a', reason: 'x' }), code('INVALID_REQUEST'));
  }
  assert.ok(!('mergeWindow' in f.hub.collaboration.query(user, 'c', { kind: 'workspace' })));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM merge_windows').get()!.n, 1);
});

test('legacy task and submission fields normalize on read without rewriting stored JSON', (t) => {
  const f = fixture(t), task = f.create();
  const raw = { ...task } as Partial<Task>;
  delete raw.requiresApproval; delete raw.mergeRequired; delete raw.mergedCommitSha; delete raw.mergedSubmissionId;
  saveCollaborationTask(f.store, raw as Task);
  saveCollaborationRecord(f.store, task.id, 'submission', { id: 'legacy' });
  const normalized = f.query(task.id);
  assert.equal(normalized.task.requiresApproval, false);
  assert.equal(normalized.task.mergeRequired, false);
  assert.equal(normalized.task.mergedCommitSha, null);
  assert.equal(normalized.submissions[0].commitSha, null);
  assert.equal(collaborationTasks(f.store, 'c', 10).tasks[0].mergeRequired, false);
  const stored = f.store.db.prepare('SELECT data_json FROM collaboration_tasks WHERE id = ?').get(task.id) as { data_json: string };
  assert.ok(!('mergeRequired' in JSON.parse(stored.data_json)));
});

test('after a reopen the merge only accepts the currently approved submission', (t) => {
  const f = fixture(t), task = f.create();
  const first = f.complete(task).approvedSubmissionId;
  f.act(user, task, { action: 'task.reopen', reason: 'hand-resolved a conflict' });
  assert.throws(() => f.act(user, task, { action: 'task.merge', commitSha: 'abcdef1' }), code('INVALID_STATE'));
  f.start(task);
  const second = f.submit(task, { commitSha: '1234567' }).submission!;
  assert.throws(() => f.act(user, task, { action: 'task.merge', commitSha: 'abcdef1' }), code('INVALID_STATE'), 'not approved yet');
  f.act(user, task, { action: 'task.review', submissionId: second.id, verdict: 'approve' });
  f.shipped(task, 'abcdef1');
  const merged = f.query(task.id);
  assert.notEqual(second.id, first);
  assert.deepEqual(merged.merges.map((record) => record.submissionId), [second.id]);
  assert.equal(merged.task.mergedSubmissionId, second.id);
  assert.deepEqual(merged.reviews.map((record) => [record.round, record.commitSha]), [[1, 'abcdef0'], [2, '1234567']]);
});

test('merge preconditions: only a valid completed mergeRequired result with a real commit', (t) => {
  const f = fixture(t), upstream = f.create({ mergeRequired: false });
  const task = f.create({ dependencyIds: [upstream.id] });
  assert.throws(() => f.act(user, task, { action: 'task.merge', commitSha: 'abcdef1' }), code('INVALID_STATE'), 'pending');
  f.complete(upstream);
  const done = f.complete(task);
  assert.equal(done.status, 'completed');
  assert.throws(() => f.act(user, task, { action: 'task.merge', commitSha: 'not-a-sha' }), code('INVALID_REQUEST'));
  assert.throws(() => f.act(user, task, { action: 'task.merge' }), code('INVALID_REQUEST'));
  f.act(user, upstream, { action: 'task.reopen', reason: 'upstream changed' });
  assert.equal(f.query(task.id).task.completionValid, false);
  assert.throws(() => f.act(user, task, { action: 'task.merge', commitSha: 'abcdef1' }), code('INVALID_STATE'), 'an invalid completion cannot merge');
  assert.deepEqual(f.query(task.id).merges, []);
});

test('manual marks are user only, end a confirmed assignment and preserve the submitted history', (t) => {
  const f = fixture(t), task = f.create({ reviewer: b });
  f.start(task);
  const original = f.submit(task).submission!;
  const before = f.query(task.id);
  const generation = f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
    permissions: { taskPlanning: true } }).coordinator!.generation;
  for (const action of ['task.mark_completed', 'task.mark_merged']) {
    for (const actor of [a, b, coordinator, { kind: 'system' } as const]) {
      assert.throws(() => f.act(actor, task, { action, generation, confirmStopped: true }), code('FORBIDDEN'));
    }
  }
  assert.throws(() => f.act(user, task, { action: 'task.mark_completed', expectedRevision: task.revision }), code('STALE_REVISION'));
  assert.throws(() => f.act(user, task, { action: 'task.mark_completed' }), code('STOP_CONFIRMATION_REQUIRED'));
  assert.throws(() => f.act(user, task, { action: 'task.mark_merged', confirmStopped: true, commitSha: 'invalid-sha' }), code('INVALID_REQUEST'));
  assert.deepEqual(f.query(task.id).task, before.task);

  // Leave the existing request to review in the queue, as when the client's delivery is paused or busy.
  const message = f.store.listMessages('c', 100).find((m) => m.body.includes('等待 b 验收'))!;
  const request = f.store.withDeliveries([message])[0].deliveries.find((d) => d.memberId === 'b')!;
  f.store.setDeliveryState(request.id, 'queued');
  const command = { action: 'task.mark_completed', taskId: task.id, operationId: 'manual-mark-retry', expectedRevision: before.task.revision,
    confirmStopped: true, reason: 'verified outside Orrery' };
  const completed = f.hub.collaboration.command(user, 'c', command);
  assert.deepEqual(f.hub.collaboration.command(user, 'c', command), completed);
  assert.equal(completed.task?.status, 'completed');
  assert.equal(completed.task?.completionValid, true);
  assert.equal(completed.task?.manualCompletion, true);
  assert.equal(completed.task?.currentAssignmentId, null);
  assert.equal(completed.task?.assignedMemberId, null);
  assert.equal(f.store.getDelivery(request.id)?.state, 'superseded');
  const detail = f.query(task.id);
  assert.equal(detail.assignments[0].endReason, 'user marked completed');
  assert.deepEqual(detail.submissions.map((s) => [s.id, s.superseded]), [[original.id, true], [completed.submission?.id, false]]);
  assert.equal(completed.submission?.assignmentId, null);
  assert.equal(completed.submission?.commitSha, null);
  assert.equal(detail.reviews[0].manual, true);
  assert.deepEqual(detail.reviews[0].reviewer, user);
  assert.equal(detail.reviews[0].reason, command.reason);
  assert.throws(() => f.act(user, task, { action: 'task.merge', commitSha: 'abcdef1' }), code('MERGE_NOT_VERIFIED'));

  const merged = f.act(user, task, { action: 'task.mark_merged' });
  assert.equal(merged.task?.status, 'merged');
  assert.equal(merged.task?.mergedCommitSha, null);
  assert.equal(merged.task?.mergedSubmissionId, completed.submission?.id);
  assert.equal(merged.merge?.manual, true);
  assert.deepEqual(merged.merge?.recordedBy, user);
  assert.equal(f.query(task.id).reviews.length, 1, 'marking an existing valid result merged does not replace or review it again');
  assert.throws(() => f.act(user, task, { action: 'task.mark_merged' }), code('INVALID_STATE'));
  const marks = f.store.listMessages('c', 100).filter((m) => m.body.includes('用户手动标记'));
  assert.equal(marks.length, 2, 'both marks are retained in group history');
  assert.ok(f.store.withDeliveries(marks).every((m) => m.deliveries.length === 0));
});

test('manual results release dependencies only when valid and never release an already-ready dependency twice', (t) => {
  const f = fixture(t), upstream = f.create({ mergeRequired: false, requiresApproval: true });
  const work = f.create({ dependencyIds: [upstream.id] });
  const downstream = f.create({ dependencyIds: [work.id], memberId: 'a' });
  f.create({ dependencyIds: [upstream.id], memberId: 'b' });
  const readyNotices = () => f.store.listMessages('c', 100).filter((m) => m.body.includes('前置依赖已就绪'));
  f.act(user, upstream, { action: 'task.cancel', reason: 'paused the plan' });
  const invalid = f.act(user, work, { action: 'task.mark_merged' });
  assert.equal(invalid.task?.status, 'merged');
  assert.equal(invalid.task?.completionValid, false);
  assert.equal(f.query(downstream.id).task.dependenciesReady, false);
  assert.equal(readyNotices().length, 0);

  const prerequisite = f.act(user, upstream, { action: 'task.mark_completed' }).task!;
  assert.equal(prerequisite.completionValid, true);
  assert.equal(prerequisite.proposalState, 'proposed', 'manual completion does not revise an approval gate');
  assert.equal(prerequisite.closeReason, undefined);
  assert.deepEqual(f.query(upstream.id).approvals, []);
  assert.equal(f.query(work.id).task.completionValid, false, 'a mark made before dependencies were ready needs to be recorded again');
  assert.equal(readyNotices().length, 1);
  f.act(user, upstream, { action: 'task.mark_merged' });
  assert.equal(readyNotices().length, 1, 'merging a valid result that did not need merging makes no dependency newly ready');

  const corrected = f.act(user, work, { action: 'task.mark_merged', commitSha: 'ABCDEF1' });
  assert.equal(corrected.task?.completionValid, true);
  assert.equal(corrected.task?.mergedCommitSha, 'abcdef1');
  assert.notEqual(corrected.task?.approvedSubmissionId, invalid.task?.approvedSubmissionId);
  assert.deepEqual(corrected.submission?.dependencyVersions, { [upstream.id]: prerequisite.approvedSubmissionId });
  assert.equal(f.query(work.id).merges.length, 2);
  assert.equal(f.query(downstream.id).task.dependenciesReady, true);
  assert.equal(readyNotices().length, 2);
  f.act(user, upstream, { action: 'task.reopen', reason: 'the prerequisite changed' });
  assert.equal(f.query(work.id).task.completionValid, false);
  assert.equal(f.query(downstream.id).task.dependenciesReady, false);
});

test('review commitSha reads null for old records and rounds count them', (t) => {
  const f = fixture(t), task = f.create({ mergeRequired: false });
  f.start(task);
  saveCollaborationRecord(f.store, task.id, 'submission', { id: 'legacy', taskId: task.id } as never);
  saveCollaborationRecord(f.store, task.id, 'review', { id: 'old-1', taskId: task.id, submissionId: 'legacy', verdict: 'reject', reason: 'old', reviewer: user, createdAt: '2026-01-01' } as never);
  saveCollaborationRecord(f.store, task.id, 'review', { id: 'old-2', taskId: task.id, submissionId: 'gone', verdict: 'reject', reason: 'old', reviewer: user, createdAt: '2026-01-02' } as never);
  const submission = f.submit(task, { commitSha: undefined }).submission!;
  assert.equal(submission.commitSha, null, 'a task that needs no merge may omit commitSha');
  f.act(user, task, { action: 'task.review', submissionId: submission.id, verdict: 'approve' });
  assert.deepEqual(f.query(task.id).reviews.map((record) => [record.round, record.commitSha]), [[1, null], [2, null], [3, null]]);
});

test('approve needs a task awaiting approval; a real mergeRequired change closes the gate again', (t) => {
  const f = fixture(t), active = f.create();
  assert.throws(() => f.act(user, active, { action: 'task.approve', verdict: 'approve' }), code('INVALID_STATE'), 'already active');
  const gated = f.create({ requiresApproval: true });
  f.act(user, gated, { action: 'task.approve', verdict: 'approve' });
  assert.throws(() => f.act(user, gated, { action: 'task.approve', verdict: 'approve' }), code('INVALID_STATE'), 'no longer proposed');
  const same = f.act(user, gated, { action: 'task.edit', mergeRequired: true }).task!;
  assert.deepEqual([same.definitionVersion, same.proposalState], [1, 'active'], 'passing back the same value is not a change');
  const changed = f.act(user, gated, { action: 'task.edit', mergeRequired: false }).task!;
  assert.deepEqual([changed.definitionVersion, changed.proposalState], [2, 'proposed']);
  const records = f.query(gated.id).approvals;
  assert.deepEqual(records.map((record) => [record.verdict, record.definitionVersion]), [['approve', 1]]);
});

test('a dependency without mergeRequired still counts as ready when completed', (t) => {
  const f = fixture(t), task = f.create();
  const done = f.complete(task);
  const legacy = { ...done } as Partial<Task>;
  delete legacy.mergeRequired; delete legacy.requiresApproval; delete legacy.mergedCommitSha; delete legacy.mergedSubmissionId;
  saveCollaborationTask(f.store, legacy as Task);
  assert.equal(f.query(task.id).task.mergeRequired, false);
  const downstream = f.create({ dependencyIds: [task.id] });
  assert.equal(downstream.dependenciesReady, true);
  assert.equal(f.query(downstream.id).task.dependenciesReady, true);
});

const fileRow = (id: string, clusterId = 'c') => ({ id, clusterId, uploader: 'user', name: `${id}.png`, mime: 'image/png', size: 3, sha256: 'x', createdAt: '2026-01-01' });

test('task attachments refuse another cluster\u2019s file, an unknown ID, more than 10 and repeats, on create and on edit', (t) => {
  const f = fixture(t);
  f.store.insertCluster({ id: 'd', name: 'd', category: '', createdAt: '2026-01-01' }, []);
  f.store.insertFile(fileRow('foreign', 'd'));
  const ids = Array.from({ length: 11 }, (_, i) => `f${i}`);
  for (const id of ids) f.store.insertFile(fileRow(id));
  assert.throws(() => f.create({ fileIds: ['foreign'] }), code('OUT_OF_SCOPE'));
  assert.throws(() => f.create({ fileIds: ['00000000-0000-0000-0000-000000000000'] }), code('OUT_OF_SCOPE'));
  assert.throws(() => f.create({ fileIds: ids }), /at most 10/);
  assert.throws(() => f.create({ fileIds: ['f0', 'f0'] }), code('INVALID_REQUEST'));
  const task = f.create({ fileIds: ids.slice(0, 10) });
  assert.equal(task.fileIds.length, 10);
  assert.throws(() => f.act(user, task, { action: 'task.edit', fileIds: ['foreign'] }), code('OUT_OF_SCOPE'));
  assert.throws(() => f.act(user, task, { action: 'task.edit', fileIds: ['missing'] }), code('OUT_OF_SCOPE'));
  assert.throws(() => f.act(user, task, { action: 'task.edit', fileIds: ids }), /at most 10/);
  assert.deepEqual(f.query(task.id).task.fileIds, ids.slice(0, 10));
});

test('an old task without fileIds reads as an empty list, and the stored JSON is not rewritten', (t) => {
  const f = fixture(t), task = f.create();
  assert.deepEqual(task.fileIds, []);
  const raw = { ...task } as Partial<Task>;
  delete raw.fileIds;
  saveCollaborationTask(f.store, raw as Task);
  const read = f.query(task.id);
  assert.deepEqual(read.task.fileIds, []);
  assert.deepEqual(read.attachments, []);
  assert.deepEqual(collaborationTasks(f.store, 'c', 10).tasks[0].fileIds, []);
  const stored = f.store.db.prepare('SELECT data_json FROM collaboration_tasks WHERE id = ?').get(task.id) as { data_json: string };
  assert.ok(!('fileIds' in JSON.parse(stored.data_json)));
});

test('editing attachments is a definition change: recorded in the history, gated like one, and refused once work has started', (t) => {
  const f = fixture(t);
  f.store.insertFile(fileRow('one')); f.store.insertFile(fileRow('two'));
  const task = f.create({ fileIds: ['one', 'two'] });
  const created = f.store.getEvent(f.query(task.id).events[0].seq)!.payload as { changes: { field: string; after: unknown; fileNames?: unknown }[] };
  assert.deepEqual(created.changes.find((c) => c.field === 'fileIds'), { field: 'fileIds', before: [], after: ['one', 'two'], fileNames: { one: 'one.png', two: 'two.png' } });
  assert.throws(() => f.act(b, task, { action: 'task.edit', fileIds: [] }), code('FORBIDDEN'), 'taskPlanning applies to a fileIds-only edit');
  const edited = f.act(user, task, { action: 'task.edit', fileIds: ['two'] });
  assert.equal(edited.task!.definitionVersion, task.definitionVersion + 1);
  const events = f.query(task.id).events;
  assert.deepEqual((events.at(-1)!.payload as { changes: unknown }).changes,
    [{ field: 'fileIds', before: ['one', 'two'], after: ['two'], fileNames: { one: 'one.png', two: 'two.png' } }]);
  assert.deepEqual(f.query(task.id).attachments.map((file) => file.id), ['two']);

  const gated = f.create({ requiresApproval: true, fileIds: ['one'] });
  f.act(user, gated, { action: 'task.approve', verdict: 'approve' });
  assert.equal(f.act(user, gated, { action: 'task.edit', fileIds: [] }).task!.proposalState, 'proposed', 'an approved definition needs approval again');

  f.start(task);
  assert.throws(() => f.act(user, task, { action: 'task.edit', fileIds: [] }), code('INVALID_STATE'));
  assert.deepEqual(f.act(user, task, { action: 'task.edit', fileIds: ['two'], labels: ['same files'] }).task!.fileIds, ['two'], 'an unchanged list is not a change');
});
