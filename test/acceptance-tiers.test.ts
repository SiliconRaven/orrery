import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import type { CollaborationActor, CollaborationCommand, Task, TaskResult } from '../src/core/collaboration-types.ts';
import { bearer, holdScript, startTestHub, waitFor, turnsOf, memberHeaders } from './helpers.ts';
import { saveCollaborationTask } from '../src/plugins/tasks/store.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';

const user: CollaborationActor = { kind: 'user' };
const as = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
const self = { kind: 'self' as const };
const code = (expected: string) => (error: unknown) => !!error && (error as { code?: string }).code === expected;

function fixture(t: TestContext) {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' },
    ['a', 'b', 'c', 'd', 'coord'].map((id) => ({
      id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
      workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null,
    })));
  const hub = new Hub({ store, nativeAdapters: {} });
  t.after(async () => { await hub.close(); store.close(); });
  let serial = 0;
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
    hub.collaboration.command(actor, 'c', { ...command, operationId: 'tier-' + ++serial });
  const query = (taskId: string) => hub.collaboration.query(user, 'c', { kind: 'task', taskId }) as TaskResult;
  const act = (actor: CollaborationActor, task: Task, command: Partial<CollaborationCommand> & { action: CollaborationCommand['action'] }) =>
    send(actor, { taskId: task.id, expectedRevision: query(task.id).task.revision, ...command });
  const create = (extra: Partial<CollaborationCommand> = {}, actor: CollaborationActor = user) =>
    send(actor, { action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done', ...extra }).task!;
  const start = (task: Task, actor: CollaborationActor = as('a')) => {
    const claim = act(actor, task, { action: 'task.claim' });
    return act(actor, task, { action: 'task.start', assignmentId: claim.assignment!.id }).task!;
  };
  const evidence = hub.sendFromUser('c', 'proof');
  const submit = (actor: CollaborationActor, task: Task, extra: Partial<CollaborationCommand> = {}) => act(actor, task, {
    action: 'task.submit', assignmentId: query(task.id).task.currentAssignmentId!, summary: '自查：相关测试通过',
    evidenceMessageIds: [evidence.id], commitSha: 'ABCDEF0', ...extra,
  });
  const notice = (eventId: number) => store.listMessages('c', 300).find((message) => message.collabEventId === eventId);
  const deliveriesOf = (messageId: string) => store.withDeliveries([store.getMessage(messageId)!])[0].deliveries;
  return { store, hub, send, query, act, create, start, submit, evidence, notice, deliveriesOf };
}

test('self review submit completes the task, records round/commitSha/reason and only stays in the chat record', (t) => {
  const f = fixture(t);
  const coordinator = f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }).coordinator!;
  const task = f.create({ reviewer: self });
  f.start(task);
  const submitted = f.submit(as('a'), task, { commitSha: 'ABCDEF0' });
  assert.equal(submitted.task!.status, 'completed');
  assert.equal(submitted.task!.approvedSubmissionId, submitted.submission!.id);
  assert.equal(submitted.task!.currentAssignmentId, null);
  assert.equal(submitted.review!.self, true);
  assert.deepEqual(submitted.review!.reviewer, as('a'));

  const detail = f.query(task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(detail.reviews.length, 1);
  const [review] = detail.reviews;
  assert.deepEqual([review.round, review.commitSha, review.self, review.verdict], [1, 'abcdef0', true, 'approve']);
  assert.equal(review.reason, '自查：相关测试通过');
  const assignment = detail.assignments.find((item) => item.id === submitted.submission!.assignmentId)!;
  assert.ok(assignment.endedAt, 'the self review ends the assignment in the same transaction');
  assert.equal(assignment.endReason, 'approved');

  const message = f.notice(submitted.eventId)!;
  assert.match(message.body, /提交了任务 #1【work】的结果并完成自查，任务已完成/);
  assert.deepEqual(message.mentions, [], 'nobody is told: the coordinator hears of normal finishes only from the record');
  assert.equal(f.deliveriesOf(message.id).length, 0, 'no delivery, no wake');

  // A second round starts at round 2 and takes the new submission's commitSha.
  f.act(user, task, { action: 'task.reopen', reason: 'second pass' });
  f.start(task);
  f.submit(as('a'), task, { commitSha: '1234567', summary: '自查第二轮' });
  assert.deepEqual(f.query(task.id).reviews.map((item) => [item.round, item.commitSha, item.self, item.reason]),
    [[1, 'abcdef0', true, '自查：相关测试通过'], [2, '1234567', true, '自查第二轮']]);
  assert.equal(coordinator.memberId, 'coord');
});

test('self review submit rejects an empty summary and leaves the task working', (t) => {
  const f = fixture(t);
  const task = f.create({ reviewer: self, mergeRequired: false });
  f.start(task);
  assert.throws(() => f.submit(as('a'), task, { summary: '   ' }), code('INVALID_REQUEST'));
  assert.throws(() => f.submit(as('a'), task, { summary: undefined }), code('INVALID_REQUEST'));
  const detail = f.query(task.id);
  assert.equal(detail.task.status, 'working');
  assert.equal(detail.reviews.length, 0);
  assert.equal(detail.submissions.length, 0);
});

test('a merge-required self task waits for task.merge before downstream readiness; a no-merge self completion readies at once', (t) => {
  const f = fixture(t);
  const upstream = f.create({ reviewer: self, title: 'self upstream' });
  const downstream = f.send(user, { action: 'task.create', title: 'blocked downstream', scope: 's', acceptance: 'a',
    dependencyIds: [upstream.id] }).task!;
  f.send(user, { action: 'task.nominate', taskId: downstream.id, expectedRevision: f.query(downstream.id).task.revision, memberId: 'a' });
  f.start(upstream);
  const completed = f.submit(as('a'), upstream).task!;
  assert.equal(completed.status, 'completed');
  assert.equal(f.query(downstream.id).task.dependenciesReady, false);
  assert.ok(!f.store.listMessages('c', 300).some((message) => message.body.includes('前置依赖已就绪')),
    'no downstream readiness before the merge');
  const merged = f.act({ kind: 'system' }, upstream, { action: 'task.shipped', submissionId: f.query(upstream.id).task.approvedSubmissionId!, commitSha: 'abcdef1', reason: 'ship' });
  assert.equal(merged.task!.status, 'merged');
  assert.equal(f.query(downstream.id).task.dependenciesReady, true);
  assert.ok(f.store.listMessages('c', 300).some((message) => message.body.includes('前置依赖已就绪')
    && message.mentions.includes('a') && message.body.includes(downstream.id)));

  const quick = f.create({ reviewer: self, title: 'quick self', mergeRequired: false });
  const quickDown = f.send(user, { action: 'task.create', title: 'quick downstream', scope: 's', acceptance: 'a',
    dependencyIds: [quick.id] }).task!;
  f.send(user, { action: 'task.nominate', taskId: quickDown.id, expectedRevision: f.query(quickDown.id).task.revision, memberId: 'a' });
  f.start(quick);
  assert.equal(f.submit(as('a'), quick, { commitSha: undefined }).task!.status, 'completed');
  assert.equal(f.query(quickDown.id).task.dependenciesReady, true, 'a no-merge self completion readies its downstream');
  assert.ok(f.store.listMessages('c', 300).some((message) => message.body.includes('前置依赖已就绪')
    && message.body.includes(quickDown.id)));
});

test('only the allowed identities set self, and a task in review cannot switch to self', (t) => {
  const f = fixture(t);
  let policy = f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }).coordinator!;
  const other = f.create({ reviewer: as('b') });
  f.start(other);
  assert.throws(() => f.act(as('b'), other, { action: 'task.edit', reviewer: self }), code('FORBIDDEN'),
    'an ordinary member who is not the creator cannot set self');
  const byCoordinator = f.act(as('coord'), other, { action: 'task.edit', reviewer: self, generation: policy.generation });
  assert.deepEqual(byCoordinator.task!.reviewer, self, 'the coordinator with reviewerManagement may set self');
  policy = f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
    permissions: { reviewerManagement: false } }).coordinator!;
  assert.throws(() => f.act(as('coord'), byCoordinator.task!, { action: 'task.edit', reviewer: as('b'), generation: policy.generation }),
    /permission is disabled/);

  const working = f.create({ reviewer: as('b') });
  f.start(working);
  assert.deepEqual(f.act(user, working, { action: 'task.edit', reviewer: self }).task!.reviewer, self, 'the user may set self');

  const reviewTask = f.create({ reviewer: as('b') });
  f.start(reviewTask);
  f.submit(as('a'), reviewTask);
  const inReview = f.query(reviewTask.id).task;
  assert.equal(inReview.status, 'review');
  assert.throws(() => f.act(user, inReview, { action: 'task.edit', reviewer: self }), code('INVALID_STATE'),
    'a task already waiting for review cannot become self review');

  const own = f.create({}, as('d'));
  assert.deepEqual(f.act(as('d'), own, { action: 'task.edit', reviewer: self }).task!.reviewer, self,
    'a member creator may set self before work starts');
});

test('the member reviewer tier still forbids an execution participant from reviewing', (t) => {
  const f = fixture(t);
  assert.throws(() => f.start(f.create({ reviewer: as('a') })), code('REVIEW_NOT_INDEPENDENT'), 'the reviewer cannot take the work');
  const task = f.create({ reviewer: as('b') });
  f.start(task);
  const submitted = f.submit(as('a'), task);
  // Only an older row can still pair them; the review-time check is what stops it.
  saveCollaborationTask(f.store, { ...f.query(task.id).task, reviewer: as('a') });
  assert.throws(() => f.act(as('a'), task, { action: 'task.review', submissionId: submitted.submission!.id,
    verdict: 'approve', reason: 'self review is not allowed in the member tier' }), code('REVIEW_NOT_INDEPENDENT'));
  assert.throws(() => f.act(user, task, { action: 'task.edit', reviewer: as('a') }), code('REVIEW_NOT_INDEPENDENT'));
});

test('the current executor can hand off or release a started assignment without user confirmation', (t) => {
  const f = fixture(t);
  f.send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' });
  const task = f.create({ reviewer: as('b') });
  const started = f.start(task);
  const assignmentId = f.query(task.id).task.currentAssignmentId!;
  const handed = f.act(as('a'), started, { action: 'task.handoff', assignmentId, memberId: 'c',
    reason: '停在 agent/deepseek/x 的 abc1234；做完 A，剩 B' });
  assert.equal(handed.task!.status, 'pending');
  assert.equal(handed.task!.assignedMemberId, 'c');
  assert.ok(f.query(task.id).assignments.find((item) => item.id === assignmentId)!.endedAt, 'the old assignment ends');
  const handoffNotice = f.notice(handed.eventId)!;
  assert.ok(handoffNotice.mentions.includes('c') && handoffNotice.mentions.includes('coord') && handoffNotice.mentions.includes('b'));
  assert.deepEqual(f.deliveriesOf(handoffNotice.id).map((delivery) => delivery.memberId), ['c'],
    'the new executor is woken; the coordinator and reviewer only get unread mentions');

  const release = f.create();
  f.start(release);
  const releaseAssignment = f.query(release.id).task.currentAssignmentId!;
  const released = f.act(as('a'), f.query(release.id).task, { action: 'task.release', assignmentId: releaseAssignment,
    reason: '停在 main 的 def5678；做完 A，剩 B' });
  assert.equal(released.task!.status, 'pending');
  assert.equal(f.deliveriesOf(f.notice(released.eventId)!.id).length, 0, 'release only informs');

  for (const action of ['task.handoff', 'task.release'] as const) {
    const fresh = f.create(action === 'task.handoff' ? { reviewer: as('b') } : {});
    f.start(fresh);
    const freshAssignment = f.query(fresh.id).task.currentAssignmentId!;
    assert.throws(() => f.act(as('a'), f.query(fresh.id).task,
      { action, assignmentId: freshAssignment, reason: '  ', ...(action === 'task.handoff' ? { memberId: 'c' } : {}) }),
      code('INVALID_REQUEST'));
  }
});

test('handoff still requires execute eligibility, refuses the reviewer, and other identities still need the user', (t) => {
  const f = fixture(t);
  const reviewed = f.create({ reviewer: as('b') });
  f.start(reviewed);
  const reviewedAssignment = f.query(reviewed.id).task.currentAssignmentId!;
  assert.throws(() => f.act(as('a'), f.query(reviewed.id).task,
    { action: 'task.handoff', assignmentId: reviewedAssignment, memberId: 'b', reason: 'take over' }), /reviewer/);

  const role = f.send(user, { action: 'role.create', name: 'only-a' }).role!.id;
  f.send(user, { action: 'member.roles', memberId: 'a', roleIds: [role] });
  const ineligible = f.create({ executeRoleIds: [role] });
  f.start(ineligible);
  const ineligibleAssignment = f.query(ineligible.id).task.currentAssignmentId!;
  assert.throws(() => f.act(as('a'), f.query(ineligible.id).task,
    { action: 'task.handoff', assignmentId: ineligibleAssignment, memberId: 'c', reason: 'take over' }), code('ROLE_REQUIRED'));

  const held = f.create({ reviewer: as('b') });
  f.start(held);
  const heldAssignment = f.query(held.id).task.currentAssignmentId!;
  assert.throws(() => f.act(as('c'), f.query(held.id).task,
    { action: 'task.handoff', assignmentId: heldAssignment, memberId: 'c', reason: 'take over' }), /not permitted/);
  assert.throws(() => f.act(as('c'), f.query(held.id).task,
    { action: 'task.release', assignmentId: heldAssignment, reason: 'take over' }), /only the assignee or user/);
  for (const action of ['task.handoff', 'task.release'] as const) {
    assert.throws(() => f.act(user, f.query(held.id).task,
      { action, assignmentId: heldAssignment, reason: 'user has not confirmed the stop',
        ...(action === 'task.handoff' ? { memberId: 'c' } : {}) }), code('STOP_CONFIRMATION_REQUIRED'));
  }
});

test('MCP create_task and task_action edit accept self; get_task and the task summary expose it', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [a] } = await app.cluster('tiers-mcp', ['A']);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hold' });
    await waitFor(() => turnsOf(app, a.id) > 0, 'member turn');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: memberHeaders(app, a.id) },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text as string;
      assert.equal(result.isError === true, false, text);
      return JSON.parse(text);
    };
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    const created = await call('create_task', { operationId: 'mcp-create', title: 'self task', scope: 's', acceptance: 'a',
      reviewer: self, mergeRequired: false });
    assert.deepEqual(created.task.reviewer, self);
    const claim = await call('task_action', { action: 'claim', operationId: 'mcp-claim', taskId: created.task.id,
      expectedRevision: created.task.revision });
    const started = await call('task_action', { action: 'start', operationId: 'mcp-start', taskId: created.task.id,
      expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
    const submitted = await call('task_action', { action: 'submit', operationId: 'mcp-submit', taskId: created.task.id,
      expectedRevision: started.task.revision, assignmentId: claim.assignment.id, summary: 'self check: 3/3 tests pass',
      evidenceMessageIds: [evidence.id] });
    assert.equal(submitted.task.status, 'completed');
    assert.equal(submitted.review.self, true);
    const got = await call('get_task', { taskId: created.task.id });
    assert.deepEqual(got.task.reviewer, self);
    assert.equal(got.reviews[0].self, true);
    assert.deepEqual([got.reviews[0].round, got.reviews[0].commitSha], [1, null]);
    const listed = await call('list_tasks', { includeClosed: true });
    assert.deepEqual(listed.tasks.find((item: any) => item.id === created.task.id).reviewer, self);

    const second = await call('create_task', { operationId: 'mcp-create-2', title: 'edit to self', scope: 's', acceptance: 'a',
      mergeRequired: false });
    const edited = await call('task_action', { action: 'edit', operationId: 'mcp-edit', taskId: second.task.id,
      expectedRevision: second.task.revision, reviewer: self });
    assert.deepEqual(edited.task.reviewer, self);
  } finally {
    await client?.close();
    hold.release();
    await app.close();
  }
});
