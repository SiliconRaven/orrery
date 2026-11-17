import type { TasksService } from '../src/plugins/tasks/service.ts';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { Limits } from '../src/core/hub.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { collaborationLinks, collaborationTask, collaborationTasks, saveCollaborationTask } from '../src/plugins/tasks/store.ts';

const PREFIX = '有成员空闲';
const WAIT_MS = 15_000;   // generous: a cold first run is much slower than later ones
const OFF = 600_000;      // an automatic check or sweep that never comes within a test

/**
 * Native mock members A..D on sessions s1..s4; a held session stays busy until released, an offline one is offline.
 * Negative checks call the Hub's check directly (`check`), so they never depend on how late a timer fires.
 */
async function fixture(name: string, limits: Partial<Limits>) {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3', 's4'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const holding = new Set<string>();
  const releases = new Map<string, () => void>();
  // A held turn also ends when the Hub aborts it (close), so app.close() does not wait forever.
  const native = createMockNativeAdapter({ harness: 'claude', sessions, onDeliver: (sessionId, _text, ctx) => holding.has(sessionId)
    ? new Promise((resolve) => {
      releases.set(sessionId, () => resolve('completed'));
      ctx.signal.addEventListener('abort', () => resolve('completed'), { once: true });
    }) : Promise.resolve('completed') });
  const offline = new Set<string>();
  const online = native.isOnline.bind(native);
  native.isOnline = (sessionId, bridge) => !offline.has(sessionId) && online(sessionId, bridge);
  const app = await startTestHub({ dir, nativeAdapters: { claude: native }, limits: { idleCheckMs: 30, idleSweepMs: OFF, idleTaskGraceMs: 0, idleMemberGraceMs: 0, ...limits } });
  const { cluster, members } = await app.hub.createCluster(name, ['A', 'B', 'C', 'D'].map((n, i) =>
    ({ harness: 'claude', mode: 'native' as const, sessionId: sessions[i].id, name: n })));
  const [a, b, c, d] = members;
  let serial = 0;
  const send = (actor: { kind: 'user' } | { kind: 'member'; memberId: string }, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: `idle-${++serial}`, ...command } as never) as never as
      { task?: any; assignment?: any; submission?: any };
  const user = { kind: 'user' as const };
  const as = (member: { id: string }) => ({ kind: 'member' as const, memberId: member.id });
  const status = (member: { id: string }) => app.hub.listMembers(cluster.id).find((m) => m.id === member.id)!.status;
  const hold = async (member: { id: string; workerSessionId: string }) => {
    holding.add(member.workerSessionId);
    app.hub.sendFromUser(cluster.id, 'hold', [member.id]);
    await waitFor(() => status(member) === 'busy', 'member busy', WAIT_MS);
  };
  const release = async (member: { id: string; workerSessionId: string }) => {
    holding.delete(member.workerSessionId);
    releases.get(member.workerSessionId)?.();
    await waitFor(() => status(member) === 'idle', 'member idle', WAIT_MS);
  };
  const hub = app.hub as unknown as { notify(e: unknown): void };
  const check = () => (app.hub.services.get('tasks') as TasksService).checkIdle(cluster.id);
  const notices = () => app.store.listMessages(cluster.id, 500).filter((m) => m.kind === 'system' && m.body.startsWith(PREFIX));
  const nth = (n: number) => waitFor(() => notices()[n], `idle notice ${n + 1}`, WAIT_MS);
  const deliveryOf = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries[0];
  const create = (title: string, extra: Record<string, unknown> = {}) =>
    send(user, { action: 'task.create', title, scope: 's', acceptance: 'done', ...extra }).task!;
  const rename = (task: { id: string }, title: string) => {
    const current = collaborationTask(app.store, cluster.id, task.id)!;
    send(user, { action: 'task.edit', taskId: task.id, expectedRevision: current.revision, title });
  };
  const coordinate = (extra: Record<string, unknown> = {}) =>
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute', ...extra });
  return { app, hub, cluster, a, b, c, d, send, user, as, hold, release, check, notices, nth, deliveryOf, create, rename, coordinate, offline };
}

test('a member turning idle gets the coordinator one Chinese notice with both sections and the task ids', async () => {
  const f = await fixture('idle-notice', {});
  const { app, cluster, a, b, c, d, send, as, hold, release, check, notices, create, coordinate, offline } = f;
  try {
    for (const m of [b, d]) await hold(m);
    offline.add(c.workerSessionId);
    const open = create('写文档');
    let review = create('改接口', { reviewer: as(c) });
    const claim = send(as(d), { action: 'task.claim', taskId: review.id, expectedRevision: review.revision });
    review = send(as(d), { action: 'task.start', taskId: review.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id }).task;
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    send(as(d), { action: 'task.submit', commitSha: 'abcdef0', taskId: review.id, expectedRevision: review.revision, assignmentId: claim.assignment.id,
      summary: 'done', evidenceMessageIds: [evidence.id] });
    coordinate();
    check();
    assert.equal(notices().length, 0, 'nobody idle (the coordinator does not count): no notice');

    await release(b);   // the busy → idle event schedules the check; nothing else does
    const first = await f.nth(0);
    check();
    assert.equal(notices().length, 1, 'one notice; a further check finds nothing new');
    assert.deepEqual(first.mentions, [a.id], 'only the coordinator');
    assert.equal(first.hop, 0);
    const lines = first.body.split('\n');
    assert.ok(lines[0].includes('重新分配、转交或更换验收人'));
    assert.deepEqual(lines.slice(1), ['执行：', `- 任务 #1【写文档】（${open.id}）没有执行者；B 空闲且有执行资格。`,
      '验收：', `- 任务 #2【改接口】（${review.id}）在等 C 验收，但 C 离线；B 空闲且有验收资格。`], 'D executed it, so D may not review');
    assert.deepEqual(collaborationLinks(app.store, first.id).sort(), [open.id, review.id].sort());
    await waitFor(() => f.deliveryOf(first.id).state === 'done', 'notice delivered through the normal path', WAIT_MS);

    await hold(b);
    await release(b);
    check();
    assert.equal(notices().length, 1, 'the same pairs are not repeated');
  } finally { await app.close(); }
});

test('the notice uses default role assignments and leaves a task with an available executor alone', async () => {
  const f = await fixture('idle-roles', { idleCheckMs: OFF });
  const { app, cluster, a, b, c, d, send, user, as, create, coordinate, offline, check, notices } = f;
  try {
    const roles = app.store.collaborationRoles(cluster.id);
    send(user, { action: 'member.roles', memberId: b.id, roleIds: [roles.find((r) => r.name === '执行者')!.id] });
    send(user, { action: 'member.roles', memberId: d.id, roleIds: [roles.find((r) => r.name === '验收者')!.id] });
    offline.add(c.workerSessionId);

    const open = create('未分配');
    send(as(b), { action: 'task.create', title: '已分配未开工', scope: 's', acceptance: 'done' });
    const reviewed = send(as(d), { action: 'task.create', title: '等验收', scope: 's', acceptance: 'done', reviewer: as(c), mergeRequired: false }).task;
    const started = send(as(d), { action: 'task.start', taskId: reviewed.id, expectedRevision: reviewed.revision });
    send(as(d), { action: 'task.submit', taskId: reviewed.id, expectedRevision: started.task.revision, assignmentId: started.assignment.id, summary: 'done' });

    coordinate();
    check();
    assert.equal(notices().length, 1);
    assert.deepEqual(notices()[0].mentions, [a.id]);
    assert.deepEqual(notices()[0].body.split('\n').slice(1), [
      '执行：', `- 任务 #1【未分配】（${open.id}）没有执行者；B 空闲且有执行资格。`, '验收：', '- 无',
    ], 'D lacks the default execute role and cannot review its own work; B lacks the default review role');
  } finally { await app.close(); }
});

test('only a new pair re-notifies, and only once the gap has passed', async (t) => {
  const gap = 600_000;
  const f = await fixture('idle-gap', { idleCheckMs: OFF, idleNoticeGapMs: gap });
  const { app, b, c, d, offline, check, notices } = f;
  try {
    offline.add(c.workerSessionId);
    offline.add(d.workerSessionId);
    const open = f.create('写文档');
    f.coordinate();
    // Date only: the Hub's notice gap reads Date.now(); timers keep running for real.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    check();
    assert.deepEqual(notices().map((n) => n.body.split('\n')[2]), [`- 任务 #1【写文档】（${open.id}）没有执行者；B 空闲且有执行资格。`]);
    check();
    assert.equal(notices().length, 1, 'the same pairs are not repeated');
    offline.delete(c.workerSessionId);
    check();
    assert.equal(notices().length, 1, 'a new pair inside the gap waits');
    t.mock.timers.tick(gap - 1);
    check();
    assert.equal(notices().length, 1, 'still inside the gap');
    t.mock.timers.tick(1);
    check();
    assert.equal(notices().length, 2, 'the new pair once the gap has passed');
    assert.equal(notices()[1].body.split('\n')[2], `- 任务 #1【写文档】（${open.id}）没有执行者；B、C 空闲且有执行资格。`);
    t.mock.timers.tick(gap);
    check();
    assert.equal(notices().length, 2, 'unchanged pairs stay quiet after the gap too');
    offline.add(b.workerSessionId);
    check();
    offline.delete(b.workerSessionId);
    t.mock.timers.tick(gap);
    check();
    assert.equal(notices().length, 2, 'a pair that left and came back is not new');
  } finally {
    mock.timers.reset();
    await app.close();
  }
});

test('no coordinator, a paused cluster or a global pause means no idle notice', async () => {
  const { app, send, user, check, notices, nth, create, rename, coordinate } = await fixture('idle-quiet', {});
  try {
    const task = create('open');
    check();
    assert.equal(notices().length, 0, 'no coordinator');
    send(user, { action: 'cluster.pause', paused: true });
    coordinate();
    check();
    assert.equal(notices().length, 0, 'paused cluster');
    app.hub.setPaused(true);
    send(user, { action: 'cluster.pause', paused: false });
    check();
    assert.equal(notices().length, 0, 'global pause');
    app.hub.setPaused(false);
    rename(task, 'open2');   // a task event schedules the check
    await nth(0);
  } finally { await app.close(); }
});

test('the idle notice is exempt from the per-hour limit but a member message is not; offline handling', async () => {
  const limited = await fixture('idle-hour', { maxTurnsPerHour: 0, maxCoordinatorTurnsPerHour: 0, recheckMs: 30 });
  try {
    limited.create('open');
    limited.coordinate();
    const notice = await limited.nth(0);
    // A batch of only system notifications neither counts nor is blocked by the per-hour cap (docs/collaboration.md).
    await waitFor(() => limited.deliveryOf(notice.id).state === 'done', 'exempt system notice', WAIT_MS);
    assert.deepEqual((limited.app.hub as any).turnStarts.get(JSON.stringify(['native', limited.a.harness, limited.a.workerSessionId])) ?? [],
      [], 'the notice is not an hourly turn');
    assert.ok(!limited.app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'),
      'the system notice is not throttled');
    // A member message in the same queue is still over its cap.
    const message = limited.app.hub.sendFromUser(limited.cluster.id, '@A hello');
    await waitFor(() => limited.app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'
      && e.memberId === limited.a.id), 'member message guard', WAIT_MS);
    assert.equal(limited.deliveryOf(message.id).state, 'queued', 'a member message is still limited');
  } finally { await limited.app.close(); }
  const away = await fixture('idle-offline', {});
  try {
    away.offline.add(away.a.workerSessionId);
    away.create('open');
    away.coordinate();
    const notice = await away.nth(0);
    await waitFor(() => away.deliveryOf(notice.id).state === 'offline', 'offline coordinator', WAIT_MS);
    away.offline.delete(away.a.workerSessionId);
    away.check();
    assert.equal(away.notices().length, 1, 'not sent again once the coordinator is back');
    assert.equal(away.deliveryOf(notice.id).state, 'offline');
  } finally { await away.app.close(); }
});

test('a notice that failed to be stored is retried; one stored before a later failure is not repeated', async () => {
  const f = await fixture('idle-retry', { idleCheckMs: OFF, idleNoticeGapMs: 0 });
  const { hub, check, notices } = f;
  try {
    f.create('open');
    f.coordinate();
    const store = f.app.store as unknown as { insertMessage(msg: { body: string }, ...rest: unknown[]): unknown };
    const insert = store.insertMessage.bind(store);
    let attempts = 0;
    store.insertMessage = (msg, ...rest) => {
      if (msg.body.startsWith(PREFIX) && attempts++ === 0) throw new Error('injected insert failure');
      return insert(msg, ...rest);
    };
    check();
    assert.equal(attempts, 1);
    assert.equal(notices().length, 0, 'the failed insert rolled back');
    check();
    assert.equal(notices().length, 1, 'the next check retries');
    check();
    assert.equal(notices().length, 1, 'and then counts it');

    // A new pair whose message is stored but whose broadcast throws is still counted as notified.
    f.create('second');
    const notify = hub.notify.bind(hub);
    let broken = true;
    hub.notify = (e: any) => {
      if (broken && e.kind === 'message' && e.payload.message.body.startsWith(PREFIX)) {
        broken = false;
        throw new Error('injected broadcast failure');
      }
      notify(e);
    };
    check();
    assert.equal(broken, false, 'the failure was injected');
    assert.equal(notices().length, 2);
    check();
    assert.equal(notices().length, 2, 'not generated twice');
  } finally { await f.app.close(); }
});

test('a task updated inside the grace window is not an idle candidate', async () => {
  const f = await fixture('idle-task-grace', { idleTaskGraceMs: 600_000 });
  const { app, cluster, b, c, d, hold, release, check, notices, create, coordinate } = f;
  try {
    coordinate();
    for (const m of [b, c, d]) await hold(m);
    for (const m of [b, c, d]) await release(m);
    create('fresh');
    check();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(notices().length, 0, 'a task changed just now waits for the next check');
    const task = collaborationTasks(app.store, cluster.id, 10).tasks[0];
    saveCollaborationTask(app.store, { ...task, updatedAt: new Date(Date.now() - 600_000).toISOString() });
    check();
    await waitFor(() => notices().length >= 1, 'notice after grace');
  } finally { await app.close(); }
});

test('a member idle for less than the grace window is not an idle candidate yet', async () => {
  const f = await fixture('idle-member-grace', { idleMemberGraceMs: 120_000 });
  const { app, b, c, d, hold, release, check, notices, create, coordinate } = f;
  try {
    coordinate();
    create('waiting');
    for (const m of [b, c, d]) await hold(m);
    for (const m of [b, c, d]) await release(m);
    check();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(notices().length, 0, 'members just turned idle are still within the grace window');
  } finally { await app.close(); }
});
