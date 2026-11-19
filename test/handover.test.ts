// The member handover package (GET /api/members/:id/handover, docs/cluster-members.md「交接包」): every item comes
// from Hub records, missing records stay null, and the endpoint sends nothing and rebinds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { CollaborationActor, CollaborationCommand } from '../src/core/collaboration-types.ts';
import { startTestHub, TEST_TOKEN, tempDir, waitFor } from './helpers.ts';

/** Two native mock members and the collaboration command helper the cases below share. */
async function fixture() {
  const dir = tempDir();
  const native = createMockNativeAdapter({ sessions: [
    { id: 's-a', title: 'chat A', model: null, cwd: dir, updatedAt: null },
    { id: 's-b', title: 'chat B', model: null, cwd: dir, updatedAt: null },
  ] });
  native.deliver = async (_sessionId: string, text: string) => text.includes('fail') ? { outcome: 'failed' as const, error: 'turn failed' } : 'completed' as const;
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  const { cluster, members: [a, b] } = await app.api('POST', '/api/clusters', {
    name: 'handover',
    members: [{ harness: 'mock', mode: 'native', sessionId: 's-a', name: 'A' }, { harness: 'mock', mode: 'native', sessionId: 's-b', name: 'B' }],
  });
  const user: CollaborationActor = { kind: 'user' };
  const asA: CollaborationActor = { kind: 'member', memberId: a.id };
  const asB: CollaborationActor = { kind: 'member', memberId: b.id };
  let serial = 0;
  const command = (actor: CollaborationActor, cmd: Omit<CollaborationCommand, 'operationId'>) =>
    app.hub.collaboration.command(actor, cluster.id, { ...cmd, operationId: `op-${++serial}` });
  const start = (actor: CollaborationActor, taskId: string, expectedRevision: number) => {
    const claim = command(actor, { action: 'task.claim', taskId, expectedRevision });
    const started = command(actor, { action: 'task.start', taskId, expectedRevision: claim.task!.revision, assignmentId: claim.assignment!.id });
    return { claim, started };
  };
  return { app, cluster, a, b, user, asA, asB, command, start, native };
}

test('the handover package is built from Hub records only and never sends or rebinds', async () => {
  const { app, cluster, a, b, user, asA, command } = await fixture();
  try {
    // The user's own words, a task that A worked on and the user accepted, an unresolved question, and one delivery
    // that failed. Unaddressed user messages only enter the chat record (no coordinator), so they are not delivered.
    assert.ok((await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '目标：月底前完成认证重构' })).id);
    const created = command(user, { action: 'task.create', title: '认证重构', scope: '拆掉旧登录', acceptance: '测试通过' }).task!;
    const claim = command(asA, { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
    const started = command(asA, { action: 'task.start', taskId: created.id, expectedRevision: claim.task!.revision, assignmentId: claim.assignment!.id });
    const questioned = command(asA, { action: 'task.attention', taskId: created.id, expectedRevision: started.task!.revision,
      kind: 'question', question: '分支名要不要改成 feature/auth？' });
    const evidence = app.hub.sendFromUser(cluster.id, '证据');
    const submitted = command(asA, { action: 'task.submit', taskId: created.id, expectedRevision: questioned.task!.revision,
      assignmentId: claim.assignment!.id, summary: 'node --test test/handover.test.ts 通过，改了 2 个文件', commitSha: 'abc1234',
      evidenceMessageIds: [evidence.id] });
    const reviewed = command(user, { action: 'task.review', taskId: created.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'approve', reason: '接口按约定实现，测试覆盖到位' });
    assert.equal(reviewed.task!.status, 'completed');
    // A task comment the user wrote is a request too, even though post() marks it task_comment.
    app.hub.sendFromUser(cluster.id, '任务上提的真实要求：保留旧接口', undefined, undefined, [created.id]);
    const failed = app.hub.sendFromUser(cluster.id, 'fail this delivery', [a.id]);
    await waitFor(() => app.store.withDeliveries([failed])[0].deliveries.some((delivery) => delivery.state === 'failed'), 'failed delivery');

    const before = (await app.messages(cluster.id)).length;
    const handover = await app.api('GET', `/api/members/${a.id}/handover`);
    assert.equal((await app.messages(cluster.id)).length, before, 'reading the package sends no message');
    assert.equal(app.store.getMember(a.id)!.workerSessionId, 's-a', 'reading the package does not move the member');
    assert.ok(!JSON.stringify(handover).includes(TEST_TOKEN), 'no credential in the package');

    assert.deepEqual([handover.member.id, handover.member.name, handover.member.harness, 'mode' in handover.member, handover.member.sessionId],
      [a.id, 'A', 'mock', false, 's-a']);
    assert.deepEqual([handover.cluster.id, handover.cluster.name], [cluster.id, 'handover']);
    assert.ok(handover.requests.some((request: any) => request.body === '目标：月底前完成认证重构'), 'the user request is the record');
    assert.ok(handover.requests.some((request: any) => request.body === '任务上提的真实要求：保留旧接口'),
      'a task comment the user wrote is a request');
    assert.ok(handover.requests.length <= 5);

    assert.equal(handover.tasks.length, 1);
    const [task] = handover.tasks;
    assert.deepEqual([task.id, task.title, task.status], [created.id, '认证重构', 'completed']);
    assert.equal(task.commitSha, 'abc1234');
    assert.equal(task.submissionBy, 'A');
    assert.equal(task.branch, null, 'the Hub records no branch, so the page says 未知');
    assert.equal(task.commands, null, 'the Hub records no commands, so the page says 未知');
    assert.match(task.summary, /node --test/);
    assert.deepEqual([task.review.verdict, task.review.reviewer, task.review.self], ['approve', '用户', false]);
    assert.match(task.review.reason, /接口按约定实现/);
    assert.deepEqual(task.questions, ['分支名要不要改成 feature/auth？']);

    assert.equal(handover.deliveries.length, 1);
    const [problem] = handover.deliveries;
    assert.equal(problem.state, 'failed');
    assert.match(problem.error, /turn failed/);
    assert.equal(problem.message, 'fail this delivery');
    assert.ok(problem.at, 'the failure time comes from the delivery event');

    // A member with no tasks and no failed deliveries gets empty lists, never a filled-in guess.
    const empty = await app.api('GET', `/api/members/${b.id}/handover`);
    assert.deepEqual([empty.tasks, empty.deliveries], [[], []]);
  } finally { await app.close(); }
});

test('an unfinished task is not squeezed out by newer finished ones, and the omitted count is reported', async () => {
  const { app, cluster, a, b, user, asA, asB, command, start } = await fixture();
  try {
    const running = command(user, { action: 'task.create', title: 'CURRENT', scope: 's', acceptance: 'a' }).task!;
    start(asA, running.id, running.revision);
    // Ten finished tasks, all newer than the running one.
    for (let i = 0; i < 10; i++) {
      const task = command(user, { action: 'task.create', title: `done-${i}`, scope: 's', acceptance: 'a' }).task!;
      const { claim, started } = start(asA, task.id, task.revision);
      const evidence = app.hub.sendFromUser(cluster.id, `证据 ${i}`);
      const submitted = command(asA, { action: 'task.submit', taskId: task.id, expectedRevision: started.task!.revision,
        assignmentId: claim.assignment!.id, summary: 'ok', commitSha: 'abc1234', evidenceMessageIds: [evidence.id] });
      command(user, { action: 'task.review', taskId: task.id, expectedRevision: submitted.task!.revision,
        submissionId: submitted.submission!.id, verdict: 'approve', reason: 'ok' });
    }
    // A task A handed to B is unfinished and newer than CURRENT: A's own current work still comes first.
    const handed = command(user, { action: 'task.create', title: 'HANDED', scope: 's', acceptance: 'a' }).task!;
    const first = start(asA, handed.id, handed.revision);
    const released = command(asA, { action: 'task.release', taskId: handed.id, expectedRevision: first.started.task!.revision,
      assignmentId: first.claim.assignment!.id, reason: '交给 B' });
    start(asB, handed.id, released.task!.revision);
    const handover = await app.api('GET', `/api/members/${a.id}/handover`);
    assert.equal(handover.tasks.length, 10);
    assert.equal(handover.tasks[0].id, running.id, 'the running task comes first, before newer work handed to others');
    assert.equal(handover.tasks[0].status, 'working');
    assert.equal(handover.tasksOmitted, 2, 'two of the twelve tasks did not fit');
    assert.equal(handover.tasks[0].role, 'executor');
    assert.ok(handover.tasks.some((task: any) => task.id === handed.id && task.role === 'former'));
  } finally { await app.close(); }
});

test('a sent handover package, a delivery handoff and a resend are not user requests', async () => {
  const { app, cluster, a, b, native } = await fixture();
  try {
    app.hub.sendFromUser(cluster.id, '目标：月底前完成认证重构');
    // The member page sends the package through the normal message route, marked as a handover.
    app.hub.sendFromUser(cluster.id, '交接包 · A …', [a.id], undefined, undefined, 'handover');
    // A delivery handoff writes another synthetic user message.
    const failed = app.hub.sendFromUser(cluster.id, 'fail this delivery', [a.id]);
    await waitFor(() => app.store.withDeliveries([failed])[0].deliveries.some((delivery) => delivery.state === 'failed'), 'failed delivery');
    const delivery = app.store.withDeliveries([failed])[0].deliveries[0];
    app.hub.handoffDelivery(cluster.id, delivery.id, { targetMemberId: b.id });
    // A resend writes a third synthetic user message (develop's resendDelivery, kind 'resend').
    native.deliver = async (_sessionId: string, text: string) => text.includes('uncertain') ? { outcome: 'unknown' as const, error: 'turn may still run' } : 'completed' as const;
    const uncertain = app.hub.sendFromUser(cluster.id, 'uncertain delivery', [a.id]);
    await waitFor(() => app.store.withDeliveries([uncertain])[0].deliveries.some((item) => item.outcome === 'unknown'), 'uncertain delivery');
    await app.hub.resendDelivery(cluster.id, app.store.withDeliveries([uncertain])[0].deliveries[0].id, { confirmDuplicate: true });
    const handover = await app.api('GET', `/api/members/${a.id}/handover`);
    assert.deepEqual(handover.requests.map((request: any) => request.body), ['目标：月底前完成认证重构', 'fail this delivery', 'uncertain delivery'],
      'the synthetic user messages are left out; real user messages stay');
    const all = await app.messages(cluster.id);
    assert.ok(all.some((message) => message.body.startsWith('交接包')), 'the package is still in the chat record');
    assert.ok(all.some((message) => message.body.startsWith('用户交接：')), 'the handoff is still in the chat record');
    assert.ok(all.some((message) => message.body.startsWith('用户重发：')), 'the resend is still in the chat record');
  } finally { await app.close(); }
});

test('a task appears under a member only when it is their work or waits for their review', async () => {
  const { app, cluster, a, b, user, asA, asB, command, start } = await fixture();
  try {
    // B is the reviewer of a task A submits: the task waits for B, but the submission is A's work.
    const reviewed = command(user, { action: 'task.create', title: '待审', scope: 's', acceptance: 'a', reviewer: { kind: 'member', memberId: b.id } }).task!;
    const { claim, started } = start(asA, reviewed.id, reviewed.revision);
    const evidence = app.hub.sendFromUser(cluster.id, '证据');
    const submitted = command(asA, { action: 'task.submit', taskId: reviewed.id, expectedRevision: started.task!.revision,
      assignmentId: claim.assignment!.id, summary: 'A 的提交说明', commitSha: 'abc1234', evidenceMessageIds: [evidence.id] });
    const waiting = await app.api('GET', `/api/members/${b.id}/handover`);
    assert.equal(waiting.tasks.length, 1);
    assert.deepEqual([waiting.tasks[0].status, waiting.tasks[0].role], ['review', 'reviewer']);
    assert.deepEqual([waiting.tasks[0].commitSha, waiting.tasks[0].submissionBy], ['abc1234', 'A'],
      'the reviewer needs the submission it is about to review, labelled with its author');
    assert.equal(waiting.tasks[0].summary, 'A 的提交说明');
    const own = await app.api('GET', `/api/members/${a.id}/handover`);
    assert.deepEqual([own.tasks[0].status, own.tasks[0].role, own.tasks[0].commitSha], ['review', 'executor', 'abc1234']);
    // Once reviewed, the task no longer waits for B: a reviewer only appears while the task is in review.
    command(user, { action: 'task.review', taskId: reviewed.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'approve', reason: 'ok' });
    assert.equal((await app.api('GET', `/api/members/${b.id}/handover`)).tasks.length, 0);

    // A starts a task and releases it; B takes over and submits. A is "former" and does not get B's submission.
    const taken = command(user, { action: 'task.create', title: '接手', scope: 's', acceptance: 'a' }).task!;
    const first = start(asA, taken.id, taken.revision);
    const released = command(asA, { action: 'task.release', taskId: taken.id, expectedRevision: first.started.task!.revision,
      assignmentId: first.claim.assignment!.id, reason: '交给 B' });
    const second = start(asB, taken.id, released.task!.revision);
    const evidenceB = app.hub.sendFromUser(cluster.id, 'B 的证据');
    command(asB, { action: 'task.submit', taskId: taken.id, expectedRevision: second.started.task!.revision,
      assignmentId: second.claim.assignment!.id, summary: 'B 的提交说明', commitSha: 'bbb2222', evidenceMessageIds: [evidenceB.id] });
    const former = (await app.api('GET', `/api/members/${a.id}/handover`)).tasks.find((task: any) => task.id === taken.id);
    assert.deepEqual([former.role, former.commitSha, former.summary, former.submissionBy], ['former', 'bbb2222', 'B 的提交说明', 'B'],
      'A no longer works on it; the submission is shown but named as B\'s work');
    const current = (await app.api('GET', `/api/members/${b.id}/handover`)).tasks.find((task: any) => task.id === taken.id);
    assert.deepEqual([current.role, current.commitSha, current.summary], ['executor', 'bbb2222', 'B 的提交说明']);
  } finally { await app.close(); }
});

test('the handover package still works when the tasks plugin is off', async () => {
  const dir = tempDir();
  const native = createMockNativeAdapter({ sessions: [{ id: 's', title: 'chat', model: null, cwd: dir, updatedAt: null }] });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, plugins: [] });
  try {
    const { cluster, members: [a] } = await app.api('POST', '/api/clusters', {
      name: 'no-tasks', members: [{ harness: 'mock', mode: 'native', sessionId: 's', name: 'A' }] });
    app.hub.sendFromUser(cluster.id, '目标');
    const handover = await app.api('GET', `/api/members/${a.id}/handover`);
    assert.deepEqual([handover.tasks, handover.tasksOmitted], [[], 0], 'no tasks plugin: no tasks, not a failure');
    assert.ok(handover.requests.some((request: any) => request.body === '目标'), 'the rest of the package still works');
  } finally { await app.close(); }
});
