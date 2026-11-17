import { tempDir } from './helpers.ts';
import type { StalledHint, TasksService } from '../src/plugins/tasks/service.ts';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Limits } from '../src/core/hub.ts';
import type { CoordinatorPolicy } from '../src/core/collaboration-types.ts';
import { coordinatorSnapshot, saveCoordinator } from '../src/plugins/coordinator/store.ts';
import { saveCollaborationTask } from '../src/plugins/tasks/store.ts';
import { startTestHub, waitFor } from './helpers.ts';

const PREFIX = '成员长时间没有活动';

/** A coordinator A and a worker B (native mock sessions s1/s2); policy is saved like the web would. */
async function fixture(limits: Partial<Limits> = {}, { coordinator = true } = {}) {
  const app = await startTestHub({ limits });
  const { cluster, members: [a, b] } = await app.hub.createCluster('stalled', [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
  ]);
  const previous = coordinatorSnapshot(app.store, cluster.id);
  const generation = previous.generation + 1;
  if (coordinator) saveCoordinator(app.store, cluster.id, {
    memberId: a.id, enabled: true, mode: 'execute', generation,
    permissions: { taskPlanning: true, assignment: true, roleManagement: true, reviewerManagement: true,
      knowledgeCommunication: true, recovery: true, cancelReopen: false, deliveryControl: false },
  } as CoordinatorPolicy, generation);
  let serial = 0;
  const send = (actor: { kind: 'user' } | { kind: 'member'; memberId: string }, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: `stalled-${++serial}`, ...command } as never) as never as
      { task?: any; assignment?: any };
  const as = (member: { id: string }) => ({ kind: 'member' as const, memberId: member.id });
  const create = (title: string, extra: Record<string, unknown> = {}) =>
    send({ kind: 'user' }, { action: 'task.create', title, scope: 's', acceptance: 'done', ...extra }).task!;
  const claim = (member: { id: string }, task: any) =>
    send(as(member), { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
  const start = (member: { id: string }, task: any, assignment: any) =>
    send(as(member), { action: 'task.start', taskId: task.id, expectedRevision: task.revision, assignmentId: assignment.id });

  const check = () => (app.hub.services.get('tasks') as TasksService).checkStalled(cluster.id);
  const notices = () => app.store.listMessages(cluster.id, 500).filter((m) => m.kind === 'system' && m.body.startsWith(PREFIX));
  const deliveryOf = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries[0];
  const hints = async () => ((await app.api('GET', '/api/stalled')) as { hints: StalledHint[] }).hints;
  return { app, cluster, a, b, send, as, create, claim, start, check, notices, deliveryOf, hints };
}

test('a stalled task owner is reminded once after the threshold, and new activity restarts the countdown', async (t) => {
  const { app, a, b, create, claim, start, check, notices, deliveryOf, hints } = await fixture({ stalledMemberMs: 60_000 });
  try {
    const task = create('写文档');
    const claimed = claim(b, task);
    start(b, claimed.task, claimed.assignment);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    check();
    assert.equal(notices().length, 0, 'inside the threshold');
    t.mock.timers.tick(60_001);
    check();
    const first = notices()[0];
    assert.ok(first, 'one reminder after the threshold');
    assert.deepEqual(first.mentions, [a.id], 'only the coordinator');
    assert.equal(first.systemKind, 'stalled');
    assert.ok(first.body.includes(task.id));
    assert.ok(first.body.includes('B'));
    assert.match(first.body, /没有活动证据/);
    assert.match(first.body, /不代表对方已经停工/);
    assert.match(first.body, /先问对方，或查看分支和投递情况/);
    // With a coordinator the page shows the same member too, next to the unchanged notice.
    assert.deepEqual((await hints()).map((h) => [h.memberId, h.tasks.map((x) => x.id)]), [[b.id, [task.id]]]);
    await waitFor(() => deliveryOf(first.id).state === 'done', 'reminder delivered');
    check();
    t.mock.timers.tick(600_000);
    check();
    assert.equal(notices().length, 1, 'the same member and task set are not reminded again');

    // A tool call proves the member is alive: the countdown starts again and only a full threshold re-arms it.
    app.store.saveActivity(b.id, 'deepseek', new Date().toISOString(), { kind: 'tool', phase: 'started', toolName: 'read' });
    check();
    assert.equal(notices().length, 1, 'new activity is inside its own threshold');
    t.mock.timers.tick(60_001);
    check();
    assert.equal(notices().length, 2, 'the new activity restarts the countdown');
    assert.match(notices()[1].body, /来源：工具调用/);
  } finally {
    t.mock.timers.reset();
    await app.close();
  }
});

test('no reminder without open tasks, and the settings API changes the threshold', async () => {
  const { app, b, create, claim, start, check, notices } = await fixture();
  try {
    check();
    assert.equal(notices().length, 0, 'no open task');
    const task = create('等待开工');
    const claimed = claim(b, task);
    start(b, claimed.task, claimed.assignment);
    check();
    assert.equal(notices().length, 0, 'default threshold is 30 minutes');

    const before = await app.api('GET', '/api/settings');
    assert.deepEqual([before.stalledMemberMinutes, before.stalledMemberMinutesSource], [30, 'default']);
    await app.api('PATCH', '/api/settings', { stalledMemberMinutes: 0 });
    assert.deepEqual(await app.api('GET', '/api/settings').then((s: any) => [s.stalledMemberMinutes, s.stalledMemberMinutesSource]), [0, 'saved']);
    check();
    assert.equal(notices().length, 1, 'a saved zero threshold applies at once');
    assert.ok(notices()[0].body.includes(task.id));
  } finally { await app.close(); }
});

test('background reminders read current work without the workbench query', async (t) => {
  const { app, cluster, b, create, hints } = await fixture({ stalledMemberMs: 0 });
  try {
    const ready = create('可以开工', { memberId: b.id });
    const dependency = create('未完成前置');
    create('等前置', { memberId: b.id, dependencyIds: [dependency.id] });
    create('待批准', { requiresApproval: true });
    const completed = create('已验收', { memberId: b.id, mergeRequired: true });
    saveCollaborationTask(app.store, { ...completed, status: 'completed' });

    const workspace = t.mock.method(app.hub.collaboration, 'query');
    const service = app.hub.services.get('tasks') as TasksService;
    service.checkIdle(cluster.id);
    assert.deepEqual((await hints()).map((h) => [h.memberId, h.tasks.map((task) => task.id)]), [[b.id, [ready.id]]]);
    assert.equal(workspace.mock.callCount(), 0, 'neither idle notices nor page hints use the workspace projection');
  } finally { await app.close(); }
});

test('offline members and members without activity evidence are described truthfully', async () => {
  const { app, cluster, b, create, claim, start, check, notices, hints } = await fixture({ stalledMemberMs: 0 });
  try {
    const task = create('无人回应');
    const claimed = claim(b, task);
    start(b, claimed.task, claimed.assignment);
    check();
    assert.equal(notices().length, 1);
    assert.match(notices()[0].body, /没有活动证据/);
    assert.doesNotMatch(notices()[0].body, /当前离线/);

    // A new member, offline before it is ever observed: offline wording next to the missing evidence.
    const { members: [c] } = await app.hub.addMembers(cluster.id, [{ projectPath: tempDir(), harness: 'mock', mode: 'native', name: 'C' }]);
    const online = app.native.isOnline.bind(app.native);
    app.native.isOnline = (sessionId, bridge) => sessionId !== c.workerSessionId && online(sessionId, bridge);
    const offlineTask = create('离线的任务', { reviewer: { kind: 'user' } });
    const offlineClaim = claim(c, offlineTask);
    start(c, offlineClaim.task, offlineClaim.assignment);
    check();
    const offlineNotice = notices().find((message) => message.body.includes(c.name));
    assert.ok(offlineNotice, 'one reminder for the offline member');
    assert.match(offlineNotice!.body, /当前离线/);
    assert.match(offlineNotice!.body, /没有活动证据/);
    const page = await hints();
    assert.deepEqual(page.map((h) => [h.memberName, h.offline, h.lastActivityAt]).sort(), [['B', false, null], ['C', true, null]]);
  } finally { await app.close(); }
});

test('without a coordinator the page hint names the member, tasks, latest activity and offline state, and sends nothing', async (t) => {
  const { app, cluster, b, send, as, create, claim, start, check, hints } = await fixture({ stalledMemberMs: 60_000 }, { coordinator: false });
  const traffic = () => [app.store.listMessages(cluster.id, 500).length,
    (app.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number }).n];
  try {
    const task = create('写文档', { reviewer: { kind: 'user' } });
    const claimed = claim(b, task);
    const started = send(as(b), { action: 'task.start', taskId: claimed.task.id, expectedRevision: claimed.task.revision, assignmentId: claimed.assignment.id }).task;
    const reviewTask = create('等 A 验收');
    const reviewClaim = claim(b, reviewTask);
    let review = start(b, reviewClaim.task, reviewClaim.assignment).task;
    review = send(as(b), { action: 'task.submit', taskId: review.id, expectedRevision: review.revision, assignmentId: reviewClaim.assignment.id,
      commitSha: 'abcdef0', summary: 'done', evidenceMessageIds: [] }).task;
    // The second task waits for review by member A unless it defaults to the user; either way B no longer holds it.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.deepEqual(await hints(), [], 'inside the threshold');
    t.mock.timers.tick(60_001);
    const before = traffic();
    check();
    const [hint, ...rest] = await hints();
    assert.deepEqual(traffic(), before, 'no notice, message or delivery without a coordinator');
    assert.equal(hint.clusterId, cluster.id);
    assert.equal(hint.memberId, b.id);
    assert.equal(hint.memberName, 'B');
    assert.deepEqual(hint.tasks.map((x) => [x.id, x.status]), [[task.id, 'working']]);
    assert.equal(hint.lastActivityAt, null, 'no evidence: the page says 没有活动证据');
    assert.equal(hint.lastActivitySource, null);
    assert.equal(hint.offline, false);
    assert.equal(hint.since, started.updatedAt, 'the silence starts at the last task change');
    if (review.reviewer.kind === 'member') {
      assert.deepEqual(rest.map((h) => [h.memberId, h.tasks.map((x) => x.id)]), [[review.reviewer.memberId, [review.id]]], 'a member reviewer holds the review');
    } else assert.deepEqual(rest, []);

    // New activity ends the hint; after a full threshold it comes back with the activity's time and source.
    const at = new Date().toISOString();
    app.store.saveActivity(b.id, 'deepseek', at, { kind: 'tool', phase: 'started', toolName: 'read' });
    assert.deepEqual((await hints()).filter((h) => h.memberId === b.id), [], 'new activity ends the hint');
    t.mock.timers.tick(60_001);
    const again = (await hints()).find((h) => h.memberId === b.id)!;
    assert.deepEqual([again.lastActivityAt, again.lastActivitySource, again.since], [at, '工具调用', at]);

    // Submitting the task ends it too: B holds nothing any more.
    send(as(b), { action: 'task.submit', taskId: started.id, expectedRevision: started.revision, assignmentId: claimed.assignment.id,
      commitSha: 'abcdef0', summary: 'done', evidenceMessageIds: [] });
    assert.deepEqual((await hints()).filter((h) => h.memberId === b.id), [], 'a submitted task is not held');
  } finally {
    t.mock.timers.reset();
    await app.close();
  }
});

test('a cancelled or reassigned task ends the hint, and nothing shows while paused', async () => {
  const { app, a, b, send, create, claim, start, hints } = await fixture({ stalledMemberMs: 0 }, { coordinator: false });
  try {
    const one = create('一');
    const oneClaim = claim(b, one);
    let task = start(b, oneClaim.task, oneClaim.assignment).task;
    assert.deepEqual((await hints()).map((h) => h.memberId), [b.id]);

    app.hub.setPaused(true);
    assert.deepEqual(await hints(), [], 'everything paused');
    app.hub.setPaused(false);
    send({ kind: 'user' }, { action: 'cluster.pause', paused: true });
    assert.deepEqual(await hints(), [], 'the cluster paused');
    send({ kind: 'user' }, { action: 'cluster.pause', paused: false });
    assert.equal((await hints()).length, 1, 'back after the pause');

    task = send({ kind: 'user' }, { action: 'task.handoff', taskId: task.id, expectedRevision: task.revision, memberId: a.id,
      assignmentId: oneClaim.assignment.id, reason: '换人', confirmStopped: true }).task;
    assert.deepEqual((await hints()).map((h) => h.memberId).filter((id) => id === b.id), [], 'reassigned away from B');
    const two = create('二');
    const twoClaim = claim(b, two);
    const started = start(b, twoClaim.task, twoClaim.assignment).task;
    assert.ok((await hints()).some((h) => h.memberId === b.id));
    send({ kind: 'user' }, { action: 'task.cancel', taskId: started.id, expectedRevision: started.revision, closeReason: 'not_planned',
      assignmentId: twoClaim.assignment.id, reason: '不做了', confirmStopped: true });
    assert.deepEqual((await hints()).filter((h) => h.memberId === b.id), [], 'a cancelled task is not held');
  } finally { await app.close(); }
});
