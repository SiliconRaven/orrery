import type { TasksService } from '../src/plugins/tasks/service.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { Store } from '../src/core/store.ts';
import type { Limits } from '../src/core/hub.ts';
import { quotaLevel, UsageTracker } from '../src/core/usage.ts';
import { idleTaskCandidates } from '../src/plugins/tasks/idle-candidates.ts';
import type { Task } from '../src/core/collaboration-types.ts';
import type { MemberStatus, QuotaSnapshot, QuotaWindow } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { collaborationLinks } from '../src/plugins/tasks/store.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const win = (id: string, usedPercent: number, resetsAt: string | null = at(60)): QuotaWindow => ({ id, label: id, usedPercent, resetsAt });
const snap = (...windows: QuotaWindow[]): QuotaSnapshot => ({ windows, observedAt: at(0), source: 'test' });

test('quotaLevel: 90% warns, 100% is exhausted, the most severe window wins, a passed reset counts as reset', () => {
  assert.deepEqual(quotaLevel(snap(win('w', 89)), NOW), { level: 'none', window: null });
  assert.equal(quotaLevel(snap(win('w', 90)), NOW).level, 'warning');
  assert.equal(quotaLevel(snap(win('w', 100)), NOW).level, 'exhausted');
  const five = win('five', 95, at(30)), week = win('week', 100, at(600));
  assert.deepEqual(quotaLevel(snap(five, week), NOW), { level: 'exhausted', window: week });
  assert.deepEqual(quotaLevel(snap(win('a', 100, at(30)), win('b', 100, at(90))), NOW).window?.id, 'b', 'the one that keeps it limited longest');
  assert.deepEqual(quotaLevel(snap(win('w', 100, at(-1))), NOW), { level: 'none', window: null }, 'reset however old the snapshot');
  assert.deepEqual(quotaLevel(snap(win('old', 100, at(-1)), five), NOW), { level: 'warning', window: five });
  assert.deepEqual(quotaLevel(null, NOW), { level: 'none', window: null }, 'no snapshot: unsupported or never read');
});

test('a failed quota read keeps the previous snapshot, so it is never judged exhausted', async () => {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  let next: QuotaSnapshot | Error = snap(win('w', 40));
  const tracker = new UsageTracker({ store, pollMs: 0, harnessesInUse: () => ['h'], emit: () => {},
    adapters: { h: { harness: 'h', quota: async () => { if (next instanceof Error) throw next; return next; } } as never } });
  try {
    await tracker.poll(false);
    next = new Error('read failed');
    assert.equal((await tracker.poll(false)).h.ok, false);
    assert.equal(quotaLevel(tracker.snapshot('h'), NOW).level, 'none');
    assert.equal(tracker.snapshot('h')!.windows[0].usedPercent, 40);
  } finally { await tracker.close(); store.close(); }
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, number: 1, clusterId: 'c', title: id, scope: '', acceptance: '', priority: 'normal', createdBy: 'user', originMessageId: null,
  requiresApproval: false, mergeRequired: false, mergedCommitSha: null, mergedSubmissionId: null, fileIds: [],
  status: 'pending', proposalState: 'active', revision: 1, definitionVersion: 1,
  reviewer: { kind: 'user' }, executeRoleIds: [], reviewRoleIds: [], labels: [], dependencyIds: [],
  currentAssignmentId: null, latestSubmissionId: null, approvedSubmissionId: null, assignedMemberId: null,
  dependenciesReady: true, dependenciesChanged: false, completionValid: false, createdAt: '', updatedAt: '', ...extra,
});
const member = (id: string, status: MemberStatus) => ({ id, status, removedAt: null, harness: 'mock', workerSessionId: 's-' + id });

test('exhausted members are not idle candidates, and the tasks stuck on them say quota-exhausted', () => {
  const tasks = [task('nominated', { assignedMemberId: 'out' }), task('accepted', { assignedMemberId: 'out' }),
    task('review', { status: 'review', assignedMemberId: 'x', reviewer: { kind: 'member', memberId: 'out' } })];
  const data = { tasks, members: [member('out', 'idle'), member('free', 'idle')], memberRoles: [], coordinator: null };
  const exhausted = idleTaskCandidates({ ...data, unavailable: ['out'] });
  const show = (pairs: { taskId: string; memberId: string; reason: string }[]) => pairs.map((p) => `${p.taskId}:${p.memberId}:${p.reason}`);
  assert.deepEqual(show(exhausted.execute), ['nominated:free:quota-exhausted', 'accepted:free:quota-exhausted']);
  assert.deepEqual(show(exhausted.review), ['review:free:quota-exhausted']);
  // Without the quota (a warning only changes nothing): the idle nominee, assignee and reviewer can act themselves.
  const fine = idleTaskCandidates(data);
  assert.deepEqual([fine.execute, fine.review], [[], []]);
  assert.deepEqual(show(idleTaskCandidates({ ...data, tasks: [task('open')], unavailable: ['out'] }).execute), ['open:free:unassigned'],
    'an exhausted member is no idle candidate itself');
});

// ---- the Hub ----

const WAIT_MS = 15_000;
const OFF = 600_000;   // automatic idle checks, sweeps and the Claude poll never come within a test

/**
 * A coordinator A and D on the quota-less 'mock' harness (native), B on a fake native 'claude' whose quota the test
 * sets, and C a new conversation on the same 'claude' harness. `refresh` makes the Hub read the quota now.
 */
async function hubFixture(name: string, limits: Partial<Limits> = {}) {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const mock = createMockNativeAdapter({ harness: 'mock', sessions });
  const claude = createMockNativeAdapter({ harness: 'claude', sessions });
  let current: QuotaSnapshot | null = null;
  const asked: { refresh: boolean; at: number }[] = [];
  // performance.now() is monotonic with sub-millisecond precision, so the poll-spacing assertion measures the timer
  // wait itself instead of the coarse wall clock.
  claude.quota = async ({ refresh }) => { asked.push({ refresh, at: performance.now() }); return current; };
  const offline = new Set<string>();
  const online = mock.isOnline.bind(mock);
  mock.isOnline = (sessionId, bridge) => !offline.has(sessionId) && online(sessionId, bridge);
  const app = await startTestHub({ dir, nativeAdapters: { mock, claude },
    limits: { quotaPollMs: 0, idleCheckMs: OFF, idleSweepMs: OFF, idleTaskGraceMs: 0, idleMemberGraceMs: 0, claudeQuotaPollMs: 0, ...limits } });
  const { cluster, members: [a, b, c, d] } = await app.hub.createCluster(name, [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'claude', mode: 'native', sessionId: 's2', name: 'B' },
    { harness: 'claude', mode: 'native', name: 'C', projectPath: '/work' },
    { harness: 'mock', mode: 'native', sessionId: 's3', name: 'D' },
  ]);
  let serial = 0;
  const send = (actor: { kind: 'user' } | { kind: 'member'; memberId: string }, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: `quota-${++serial}`, ...command } as never) as never as
      { task?: any; assignment?: any };
  const user = { kind: 'user' as const };
  const as = (m: { id: string }) => ({ kind: 'member' as const, memberId: m.id });
  const hub = app.hub as unknown as { checkQuota(): void; services: Map<string, TasksService>; pollClaudeQuota(): Promise<unknown> | undefined;
    claudeQuotaTimer: unknown };
  let observed = 0;
  /** The fake Claude reports these windows (a fresh observedAt each time), and the Hub reads them now. */
  const report = async (...windows: QuotaWindow[]) => {
    current = { windows, observedAt: new Date(Date.parse('2026-11-08T10:00:00Z') + ++observed * 1000).toISOString(), source: 'test' };
    await app.hub.refreshUsage();
  };
  const quotaNotices = () => app.store.listMessages(cluster.id, 500).filter((m) => m.kind === 'system' && m.body.startsWith('额度'));
  const deliveryOf = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries[0];
  const coordinate = () => send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
  const create = (title: string, extra: Record<string, unknown> = {}) =>
    send(user, { action: 'task.create', title, scope: 's', acceptance: 'done', ...extra }).task!;
  return { app, hub, cluster, a, b, c, d, send, user, as, report, quotaNotices, deliveryOf, coordinate, create, asked, offline };
}
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

test('warning, then exhausted with the affected members and their open tasks; each window and level once', async () => {
  const f = await hubFixture('quota-levels');
  const { app, cluster, a, b, c, d, send, as, report, quotaNotices, coordinate, create } = f;
  try {
    const nominated = create('写文档');
    send(f.user, { action: 'task.nominate', taskId: nominated.id, expectedRevision: nominated.revision, memberId: b.id });
    let working = create('改代码');
    const claim = send(as(b), { action: 'task.claim', taskId: working.id, expectedRevision: working.revision });
    working = send(as(b), { action: 'task.start', taskId: working.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id }).task;
    let review = create('改接口', { reviewer: as(c) });
    const dClaim = send(as(d), { action: 'task.claim', taskId: review.id, expectedRevision: review.revision });
    review = send(as(d), { action: 'task.start', taskId: review.id, expectedRevision: dClaim.task.revision, assignmentId: dClaim.assignment.id }).task;
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    send(as(d), { action: 'task.submit', commitSha: 'abcdef0', taskId: review.id, expectedRevision: review.revision, assignmentId: dClaim.assignment.id,
      summary: 'done', evidenceMessageIds: [evidence.id] });
    coordinate();
    const reset = later(120);
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 80, resetsAt: reset });
    assert.equal(quotaNotices().length, 0, 'below 90%: nothing');
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 92, resetsAt: reset });
    assert.equal(quotaNotices().length, 1);
    const warning = quotaNotices()[0];
    assert.deepEqual(warning.mentions, [a.id], 'only the coordinator');
    assert.ok(warning.body.startsWith(`额度预警：claude 的「5 小时」窗口已用 92%，${fmt(reset)} 重置（截至 `), warning.body);
    assert.ok(warning.body.endsWith('额度快用完，派新任务时注意。'));
    assert.equal(warning.systemKind, 'quota_low', 'an attention-level warning');
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 95, resetsAt: reset });
    assert.equal(quotaNotices().length, 1, 'the same window and level are told once');

    await report({ id: 'five_hour', label: '5 小时', usedPercent: 100, resetsAt: reset });
    assert.equal(quotaNotices().length, 2);
    const used = quotaNotices()[1];
    assert.deepEqual(used.body.split('\n').slice(1), ['本群受影响的成员：B、C。', '执行：',
      `- B：任务 #1【写文档】（${nominated.id}，已分配）；任务 #2【改代码】（${working.id}，正在做）`,
      '验收：', `- C：任务 #3【改接口】（${review.id}）`, '请按资格把未开始的任务改派，正在执行的不打断。'], 'attached and created Claude members; D is not');
    assert.ok(used.body.startsWith(`额度用完：claude 的「5 小时」窗口已用 100%，${fmt(reset)} 重置`));
    assert.deepEqual(collaborationLinks(app.store, used.id).sort(), [nominated.id, working.id, review.id].sort());
    assert.equal(used.systemKind, 'quota_exhausted', 'a problem-level warning');
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 100, resetsAt: reset }, { id: 'week', label: '每周', usedPercent: 50, resetsAt: later(9000) });
    assert.equal(quotaNotices().length, 2, 'not repeated for the same window');

    // While Claude is used up, B and C cannot act: the tasks stuck on them go to idle D in the idle notice.
    f.hub.services.get('tasks')!.checkIdle(cluster.id);
    const idle = app.store.listMessages(cluster.id, 500).find((m) => m.kind === 'system' && m.body.startsWith('有成员空闲'))!;
    assert.ok(idle.body.includes(`- 任务 #1【写文档】（${nominated.id}）已分配给 B 但还没开始，B 的额度已用完；D 空闲且有执行资格。`), idle.body);
    assert.ok(!idle.body.includes(`在等 C 验收`), 'D executed it, so nobody idle may review it');

    const next = later(420);
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 100, resetsAt: next });
    assert.equal(quotaNotices().length, 3, 'a new window (resetsAt changed) is told again');
    assert.ok(quotaNotices()[2].body.startsWith(`额度用完：claude 的「5 小时」窗口已用 100%，${fmt(next)} 重置`));
  } finally { await app.close(); }
});

test('a reset time that differs only by milliseconds between reads is the same period; a later period is told again', async () => {
  const f = await hubFixture('quota-jitter');
  const { app, report, quotaNotices, coordinate } = f;
  try {
    coordinate();
    const base = Math.round((Date.now() + 120 * 60_000) / 60_000) * 60_000;   // on a whole minute, like a real reset
    const reset = (ms: number) => new Date(base + ms).toISOString();
    for (const ms of [948, 75, 587, 882, -300]) await report({ id: 'five_hour', label: '5 小时', usedPercent: 92, resetsAt: reset(ms) });
    assert.equal(quotaNotices().length, 1, 'one warning for the period');
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 92, resetsAt: reset(5 * 3_600_000 + 75) });
    assert.equal(quotaNotices().length, 2, 'the next period warns again');
  } finally { await app.close(); }
});

test('recovery is told once after exhausted, not after a warning; a reset time arriving counts', async () => {
  const f = await hubFixture('quota-recovery');
  const { app, report, quotaNotices, coordinate } = f;
  try {
    coordinate();
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 92, resetsAt: later(60) });
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 40, resetsAt: later(60) });
    assert.deepEqual(quotaNotices().map((m) => m.body.slice(0, 5)), ['额度预警：'], 'no recovery after only a warning');
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 100, resetsAt: later(60) });
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 40, resetsAt: later(60) });
    assert.equal(quotaNotices().length, 3);
    assert.ok(quotaNotices()[2].body.startsWith('额度已恢复：claude 的「5 小时」窗口已用 40%（截至 '), quotaNotices()[2].body);
    assert.ok(quotaNotices()[2].body.endsWith('本群受影响的成员：B、C。'));
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 30, resetsAt: later(60) });
    assert.equal(quotaNotices().length, 3, 'recovery is told once');

    // Exhausted until a reset 1.5 s away (room for a slow run to see it exhausted first); nothing reads the quota
    // again: the Hub's reset timer tells the recovery.
    const soon = new Date(Date.now() + 1500).toISOString();
    await report({ id: 'week', label: '每周', usedPercent: 100, resetsAt: soon });
    assert.equal(quotaNotices().length, 4);
    const recovered = await waitFor(() => quotaNotices()[4], 'recovery at the reset time', WAIT_MS);
    assert.ok(recovered.body.startsWith('额度已恢复：claude 的「每周」窗口已重置'), recovered.body);
    assert.equal(recovered.systemKind, 'quota_recovered');
  } finally { await app.close(); }
});

test('quota notices: none without a coordinator or while paused; exempt from the hourly limit; offline as usual; unsupported never', async () => {
  const f = await hubFixture('quota-quiet', { maxTurnsPerHour: 0, maxCoordinatorTurnsPerHour: 0 });
  const { app, hub, cluster, user, send, report, quotaNotices, coordinate, deliveryOf } = f;
  try {
    await report({ id: 'five_hour', label: '5 小时', usedPercent: 100, resetsAt: later(60) });
    assert.equal(quotaNotices().length, 0, 'no coordinator');
    send(user, { action: 'cluster.pause', paused: true });
    coordinate();
    hub.checkQuota();
    assert.equal(quotaNotices().length, 0, 'paused cluster');
    app.hub.setPaused(true);
    send(user, { action: 'cluster.pause', paused: false });
    hub.checkQuota();
    assert.equal(quotaNotices().length, 0, 'global pause');
    app.hub.setPaused(false);
    hub.checkQuota();   // what the 5-minute sweep does
    assert.equal(quotaNotices().length, 1);
    // A batch of only system notifications is exempt even at a cap of 0 (docs/collaboration.md).
    await waitFor(() => deliveryOf(quotaNotices()[0].id).state === 'done', 'exempt system notice', WAIT_MS);
    assert.ok(!app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'),
      'the system notice is not throttled');
    // A member message is still over its hourly cap.
    const limited = app.hub.sendFromUser(cluster.id, '@B hello');
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'), 'hour guard', WAIT_MS);
    assert.equal(deliveryOf(limited.id).state, 'queued', 'a member message still waits over the per-hour limit');
    assert.ok(!quotaNotices()[0].body.includes('mock'), 'the quota-less mock harness never gets a notice');
    assert.ok(app.store.getCluster(cluster.id));
  } finally { await app.close(); }
  const away = await hubFixture('quota-offline');
  try {
    away.offline.add(away.a.workerSessionId);
    away.coordinate();
    await away.report({ id: 'five_hour', label: '5 小时', usedPercent: 100, resetsAt: later(60) });
    const [notice] = away.quotaNotices();
    await waitFor(() => away.deliveryOf(notice.id).state === 'offline', 'offline coordinator', WAIT_MS);
    away.offline.delete(away.a.workerSessionId);
    away.hub.checkQuota();
    assert.equal(away.quotaNotices().length, 1, 'not sent again once the coordinator is back');
  } finally { await away.app.close(); }
});

test('the Claude quota poll asks only while a coordinated Claude member has open tasks, once per interval', async () => {
  const off = await hubFixture('poll-off');
  try {
    assert.equal(off.hub.claudeQuotaTimer, undefined, 'claudeQuotaPollMs 0 disables the poll');
  } finally { await off.app.close(); }
  const f = await hubFixture('poll-conditions', { claudeQuotaPollMs: OFF });
  const { app, hub, b, send, user, create, coordinate, asked } = f;
  try {
    const task = create('写文档');
    assert.equal(hub.pollClaudeQuota(), undefined, 'no coordinator: nothing started');
    coordinate();
    assert.equal(hub.pollClaudeQuota(), undefined, 'no open task of a Claude member');
    send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: b.id });
    await hub.pollClaudeQuota();
    assert.deepEqual(asked.map((q) => q.refresh), [true], 'one refresh of Claude only');
  } finally { await app.close(); }
  const interval = 120;
  const timed = await hubFixture('poll-interval', { claudeQuotaPollMs: interval });
  try {
    const task = timed.create('写文档');
    timed.coordinate();
    timed.send(timed.user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: timed.b.id });
    await waitFor(() => timed.asked.length >= 2, 'two polls', WAIT_MS);
    // Windows timers can fire up to one clock tick (~15.6 ms) early, so the floor keeps a tick of slack; an immediate
    // re-poll would be single-digit milliseconds apart, so the periodic wait stays proven. shortcut: a loop stalled
    // for a whole interval could still squeeze the gap below the floor; upgrade to mock timers if that ever bites.
    assert.ok(timed.asked[1].at - timed.asked[0].at >= interval - 20, `${timed.asked[1].at - timed.asked[0].at} ms apart`);
    assert.ok(timed.asked.every((q) => q.refresh));
  } finally { await timed.app.close(); }
});
