// Third-party plugin marks on messages, members and tasks (docs/external-plugins.md「网页界面」「标记」), Hub side:
// host.ui.mark with every refusal in its order, the text and tip cuts, replace and clear, the per-plugin cap with
// eviction, the budget shared with pushes and chips, and every way marks go (stop, restart, the UI switch, a grant taken
// away, a cluster in the bin, a Hub restart, a target that is gone), plugins and clusters kept apart. The page side is
// plugin-marks-browser.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_LIMITS } from '../src/core/external-plugin-ui.ts';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { openSse, startTestHub, tempDir, TEST_TOKEN, waitFor, bearer, type TestHub } from './helpers.ts';

const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'ui-probe');
type Plugin = { id: string; grant?: Record<string, unknown> };
/** How many messages c1 is seeded with (m-000 …): enough targets to pass the per-plugin cap. */
const SEEDED = UI_LIMITS.marksPerPluginPerCluster + 5;
const messageId = (i: number) => `m-${String(i).padStart(3, '0')}`;

/** Clusters c1, c2 (granted) and c3 (never), members Alice and Bob in each, messages; the probe declaring all three positions. */
function prepare(dir: string, plugins: Plugin[]) {
  mkdirSync(join(dir, 'home'), { recursive: true });
  const seed = new Store(join(dir, 'test.db'));
  for (const clusterId of ['c1', 'c2', 'c3']) {
    seed.insertCluster({ id: clusterId, name: `群 ${clusterId}`, category: '', createdAt: '2026-01-01' }, ['Alice', 'Bob'].map((name) => ({
      id: `${clusterId}-${name}`, clusterId, name, avatar: null, harness: 'mock', model: null, effort: null,
      workerSessionId: `${clusterId}-${name}`, cwd: dir, origin: 'attached' as const, removedAt: null })));
  }
  const message = (id: string, clusterId: string, i: number) => seed.insertMessage({ id, clusterId, from: 'user', mentions: [], body: `消息 ${id}`,
    replyTo: null, chainId: id, hop: 0, createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString() }, []);
  for (let i = 0; i < SEEDED; i++) message(messageId(i), 'c1', i);
  message('c2-message', 'c2', 0);
  message('c3-message', 'c3', 0);
  seed.close();
  const entries = plugins.map(({ id, grant }) => {
    const folder = join(dir, 'plugins', id);
    cpSync(FIXTURE, folder, { recursive: true });
    const m = JSON.parse(readFileSync(join(folder, 'orrery-plugin.json'), 'utf8'));
    m.id = id;
    m.name = `插件 ${id}`;
    m.ui.positions = ['titlebar', 'workbench', 'marks'];
    writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify(m));
    return { manifest: join(folder, 'orrery-plugin.json'), permissions: ['ui.show'], ui: ['titlebar', 'workbench', 'marks'], clusterIds: ['c1', 'c2'], ...grant };
  });
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: entries }));
}

/** A Hub whose plugin clock the test moves (`clock.now`), so the per-minute budget can be renewed without waiting. */
async function hub(plugins: Plugin[] = [{ id: 'ui-probe' }], dir = tempDir(), fresh = true, disabledPlugins?: string[]) {
  if (fresh) prepare(dir, plugins);
  const clock = { now: Date.now() };
  const app = await startTestHub({ dir, pluginLifecycle: { now: () => clock.now }, ...(disabledPlugins ? { disabledPlugins } : {}) });
  await waitFor(async () => (await app.api('GET', '/api/plugins')).installed.filter((p: any) => p.origin === 'external')
    .every((p: any) => p.runtime?.state === 'ready'), 'the plugins to be ready');
  return { app, clock, dir };
}

const hostCall = async (app: TestHub, method: string, params: unknown, plugin = 'ui-probe') =>
  (await app.api('POST', `/api/plugins/${plugin}/invoke`, { command: 'raw', arguments: { method, params } })).result;
const mark = (app: TestHub, params: unknown, plugin = 'ui-probe') => hostCall(app, 'host.ui.mark', params, plugin);
const burst = async (app: TestHub, method: string, args: Record<string, unknown>, plugin = 'ui-probe') =>
  (await app.api('POST', `/api/plugins/${plugin}/invoke`, { command: 'burst', arguments: { method, ...args } })).result;
/** The marks the cluster's listing gives for a plugin, as [target, targetId, text, state, tip]. */
const listed = async (app: TestHub, clusterId: string, plugin = 'ui-probe') =>
  ((await app.api('GET', `/api/clusters/${clusterId}/plugin-ui`)).items.find((i: any) => i.pluginId === plugin)?.marks ?? [])
    .map((m: any) => [m.target, m.targetId, m.text, m.state, m.tip]);
const createTask = async (app: TestHub, clusterId: string, title: string) => (await app.api('POST', `/api/clusters/${clusterId}/collaboration`,
  { action: 'task.create', operationId: `create-${title}`, title, scope: 's', acceptance: 'a', memberId: null })).task;
const markFrames = (sse: ReturnType<typeof openSse>) => sse.events.filter((e) => e.event === 'plugin-ui' && (e.data.kind === 'mark' || e.data.kind === 'marks-cleared'));

test('marks: set, replace, clear; text and tip cut by code point; every refusal in its order; listed only where granted', async () => {
  const { app } = await hub([{ id: 'ui-probe' }, { id: 'ui-bar', grant: { ui: ['titlebar'] } }, { id: 'ui-none', grant: { permissions: [], ui: [] } },
    { id: 'ui-marks', grant: { ui: ['marks'] } }]);
  const sse = openSse(`${app.url}/api/stream`, bearer(TEST_TOKEN));
  try {
    await sse.status;
    const task = await createTask(app, 'c1', '第一个任务');
    const on = { clusterId: 'c1', target: 'message', targetId: messageId(0) };
    assert.deepEqual(await mark(app, { ...on, text: '构建中', state: 'running', tip: '第 3 步，共 5 步' }), { result: { shown: true } });
    await waitFor(() => markFrames(sse).length === 1, 'the mark frame');
    assert.deepEqual(markFrames(sse)[0].data, { kind: 'mark', pluginId: 'ui-probe', clusterId: 'c1', target: 'message', targetId: messageId(0),
      mark: { text: '构建中', state: 'running', tip: '第 3 步，共 5 步' } });
    // Set again: replaced, one mark per plugin and target.
    assert.deepEqual(await mark(app, { ...on, text: '通过', state: 'done' }), { result: { shown: true } });
    assert.deepEqual(await listed(app, 'c1'), [['message', messageId(0), '通过', 'done', null]]);
    // A member and a task; the states, including info and none.
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '值班', state: 'info' }), { result: { shown: true } });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'task', targetId: task.id, text: 'CI 失败', state: 'failed', tip: null }), { result: { shown: true } });
    assert.deepEqual(await listed(app, 'c1'), [['message', messageId(0), '通过', 'done', null], ['member', 'c1-Alice', '值班', 'info', null],
      ['task', task.id, 'CI 失败', 'failed', null]]);

    // The text: one line, cut to 16 characters by code point (Chinese and emoji alike); the tip to 80; HTML is only text.
    const cut = async (text: string, tip?: string) => {
      assert.deepEqual(await mark(app, { ...on, text, ...(tip === undefined ? {} : { tip }) }), { result: { shown: true } });
      return (await listed(app, 'c1'))[2].slice(2);   // the message mark is the newest now
    };
    assert.deepEqual(await cut('构建'.repeat(10)), ['构建'.repeat(8), null, null]);
    const emoji = (await cut('😀'.repeat(20)))[0];
    assert.equal(emoji, '😀'.repeat(16));
    assert.ok(emoji.isWellFormed(), 'no lone surrogate');
    assert.equal((await cut(`${'计'.repeat(15)}😀尾巴`))[0], `${'计'.repeat(15)}😀`);
    assert.equal((await cut('  a\u0007b\nc‮d  '))[0], 'a b c d', 'control, line and format characters become spaces');
    assert.equal((await cut('ok', '说明'.repeat(50)))[2], '说明'.repeat(40));
    assert.equal((await cut('ok', '🎉'.repeat(90)))[2], '🎉'.repeat(80));
    assert.equal((await cut('ok', '第一行\n第二行'))[2], '第一行 第二行');
    assert.equal((await cut('ok', ' \n '))[2], null, 'a tip with nothing left is no tip');
    assert.deepEqual(await cut('<b>粗</b>', '<img src=x onerror=alert(1)>'), ['<b>粗</b>', null, '<img src=x onerror=alert(1)>']);

    // Cleared: text null; the page is told; clearing again (nothing there) is no error.
    const before = markFrames(sse).length;
    assert.deepEqual(await mark(app, { ...on, text: null }), { result: { shown: false } });
    await waitFor(() => markFrames(sse).length === before + 1, 'the clear frame');
    assert.deepEqual(markFrames(sse).at(-1)!.data, { kind: 'mark', pluginId: 'ui-probe', clusterId: 'c1', target: 'message', targetId: messageId(0), mark: null });
    assert.deepEqual(await mark(app, { ...on, text: null }), { result: { shown: false } });
    assert.equal(markFrames(sse).length, before + 1, 'nothing to clear: no frame');
    assert.equal((await listed(app, 'c1')).length, 2);

    // Refusals, in their order; none is kept or told.
    const frames = markFrames(sse).length;
    const refused = async (params: unknown, code: string, plugin = 'ui-probe') => assert.deepEqual(await mark(app, params, plugin), { error: code }, JSON.stringify(params));
    await refused({ ...on, text: 'x' }, 'PERMISSION_DENIED', 'ui-none');
    await refused([1], 'INVALID_DATA');
    await refused({ ...on, text: 'x', color: 'red' }, 'INVALID_DATA');
    await refused({ ...on, text: 'x', icon: 'star' }, 'INVALID_DATA');
    await refused({ ...on, target: 'cluster', text: 'x' }, 'INVALID_DATA');
    await refused({ ...on, targetId: '', text: 'x' }, 'INVALID_DATA');
    await refused({ ...on, targetId: 42, text: 'x' }, 'INVALID_DATA');
    await refused({ ...on, targetId: 'x'.repeat(129), text: 'x' }, 'INVALID_DATA');
    await refused({ ...on }, 'INVALID_DATA');
    await refused({ ...on, text: 42 }, 'INVALID_DATA');
    await refused({ ...on, text: '\u0007\n ' }, 'INVALID_DATA');
    await refused({ ...on, text: 'x', state: 'blinking' }, 'INVALID_DATA');
    await refused({ ...on, text: 'x', state: 'warning' }, 'INVALID_DATA');
    await refused({ ...on, text: 'x', tip: 42 }, 'INVALID_DATA');
    await refused({ ...on, clusterId: 7, text: 'x' }, 'INVALID_DATA');
    await refused({ ...on, clusterId: 'c3', target: 'cluster', text: 'x' }, 'INVALID_DATA', 'ui-bar');   // the data first
    await refused({ clusterId: 'c3', target: 'message', targetId: 'c3-message', text: 'x' }, 'CLUSTER_NOT_GRANTED');
    await refused({ ...on, clusterId: 'gone', text: 'x' }, 'CLUSTER_NOT_GRANTED');
    await refused({ clusterId: 'c3', target: 'message', targetId: 'nope', text: 'x' }, 'CLUSTER_NOT_GRANTED', 'ui-bar');   // the cluster before the position
    await refused({ ...on, text: 'x' }, 'POSITION_NOT_GRANTED', 'ui-bar');
    await refused({ ...on, targetId: 'nope', text: 'x' }, 'POSITION_NOT_GRANTED', 'ui-bar');   // the position before the target
    // NOT_FOUND: no such target in this cluster (one of another cluster looks the same as none).
    await refused({ ...on, targetId: 'nope', text: 'x' }, 'NOT_FOUND');
    await refused({ ...on, targetId: 'c2-message', text: 'x' }, 'NOT_FOUND');
    await refused({ clusterId: 'c1', target: 'member', targetId: 'c2-Alice', text: 'x' }, 'NOT_FOUND');
    await refused({ clusterId: 'c1', target: 'member', targetId: 'nobody', text: 'x' }, 'NOT_FOUND');
    await refused({ clusterId: 'c1', target: 'task', targetId: 'no-task', text: 'x' }, 'NOT_FOUND');
    await refused({ clusterId: 'c2', target: 'task', targetId: task.id, text: 'x' }, 'NOT_FOUND');
    await refused({ clusterId: 'c1', target: 'message', targetId: 'c1-Alice', text: 'x' }, 'NOT_FOUND', 'ui-probe');   // a member id is no message
    await refused({ ...on, targetId: 'nope', text: null }, 'NOT_FOUND');   // clearing a mark it never set on a target that is not there
    assert.equal(markFrames(sse).length, frames, 'no frame for a refusal');

    // A push without a frame position granted is refused now that marks alone count as a position; push and chip still work.
    assert.deepEqual(await hostCall(app, 'host.ui.push', { clusterId: 'c1', position: 'marks', data: 1 }), { error: 'INVALID_DATA' });
    assert.deepEqual(await hostCall(app, 'host.ui.push', { clusterId: 'c1', data: 1 }), { result: { delivered: 0 } });
    // Granted marks alone: a push without a position has no frame position to go to; a chip has no title bar.
    assert.deepEqual(await hostCall(app, 'host.ui.push', { clusterId: 'c1', data: 1 }, 'ui-marks'), { error: 'POSITION_NOT_GRANTED' });
    assert.deepEqual(await hostCall(app, 'host.ui.push', { clusterId: 'c1', position: 'workbench', data: 1 }, 'ui-marks'), { error: 'POSITION_NOT_GRANTED' });
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: 'x' }, 'ui-marks'), { error: 'POSITION_NOT_GRANTED' });
    assert.deepEqual(await mark(app, { ...on, text: '只有标记' }, 'ui-marks'), { result: { shown: true } });
    assert.deepEqual(await mark(app, { ...on, text: null }, 'ui-marks'), { result: { shown: false } });
    // The page cannot open a frame at `marks`.
    const opened = await fetch(`${app.url}/api/clusters/c1/plugin-ui/frames`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'ui-probe', position: 'marks' }) });
    assert.equal(opened.status, 400);
    // The listing: positions name marks; the plugin granted the title bar only has none and no marks.
    const items = (await app.api('GET', '/api/clusters/c1/plugin-ui')).items;
    assert.deepEqual(items.map((i: any) => [i.pluginId, i.positions, i.marks.length]), [['ui-probe', ['titlebar', 'workbench', 'marks'], 2], ['ui-bar', ['titlebar'], 0], ['ui-marks', ['marks'], 0]]);
    assert.deepEqual((await app.api('GET', '/api/clusters/c3/plugin-ui')).items, [], 'c3 is in no read whitelist');
    const row = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'ui-probe');
    assert.deepEqual(row.ui.granted, ['titlebar', 'workbench', 'marks']);
  } finally {
    sse.close();
    await app.close();
  }
});

test('marks: at most 200 per plugin per cluster, the oldest evicted and the page told; the budget is shared with pushes and chips', async () => {
  const { app, clock } = await hub([{ id: 'ui-probe' }, { id: 'ui-other' }]);
  const sse = openSse(`${app.url}/api/stream`, bearer(TEST_TOKEN));
  const minute = () => { clock.now += 61_000; };
  try {
    await sse.status;
    const cap = UI_LIMITS.marksPerPluginPerCluster;
    const params = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => ({ clusterId: 'c1', target: 'message', targetId: messageId(from + k), text: `第 ${from + k} 条` }));
    // Marks on targets that then go do not stay counted: Bob's is dropped at the refused call, the task's when the
    // listing skips it. Were either kept, the cap below would evict it (a frame naming it) before any message mark.
    const task = await createTask(app, 'c1', '会被删的任务');
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Bob', text: '先设' }), { result: { shown: true } });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'task', targetId: task.id, text: '先设' }), { result: { shown: true } });
    await app.api('DELETE', '/api/clusters/c1/members/c1-Bob', {});
    const cancelled = (await app.api('POST', '/api/clusters/c1/collaboration', { action: 'task.cancel', operationId: 'cancel', taskId: task.id,
      expectedRevision: task.revision, reason: 'test' })).task;
    await app.api('POST', '/api/clusters/c1/collaboration', { action: 'task.delete', operationId: 'delete', taskId: task.id, expectedRevision: cancelled.revision });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Bob', text: null }), { error: 'NOT_FOUND' });
    assert.deepEqual(await listed(app, 'c1'), []);
    minute();
    // Up to the cap over two minutes of budget (120 a minute).
    assert.deepEqual(await burst(app, 'host.ui.mark', { paramsList: params(0, 120) }), { sent: 120 });
    minute();
    assert.deepEqual(await burst(app, 'host.ui.mark', { paramsList: params(120, cap) }), { sent: cap - 120 });
    assert.equal((await listed(app, 'c1')).length, cap);
    // The other plugin and the other cluster have their own count: marks there evict nothing here.
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'message', targetId: messageId(0), text: '别的插件' }, 'ui-other'), { result: { shown: true } });
    assert.deepEqual(await mark(app, { clusterId: 'c2', target: 'message', targetId: 'c2-message', text: '别的群' }), { result: { shown: true } });
    assert.equal((await listed(app, 'c1')).length, cap);
    // One more: the oldest (message 0) goes, and the page is told; replacing one makes it the newest.
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'message', targetId: messageId(1), text: '换过' }), { result: { shown: true } });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'message', targetId: messageId(cap), text: '第 201 个' }), { result: { shown: true } });
    await waitFor(() => markFrames(sse).some((e) => e.data.targetId === messageId(0) && e.data.pluginId === 'ui-probe' && e.data.mark === null), 'the eviction frame');
    const ids = (await listed(app, 'c1')).map((m: any) => m[1]);
    assert.equal(ids.length, cap);
    assert.ok(!ids.includes(messageId(0)), 'the oldest was evicted');
    assert.ok(ids.includes(messageId(1)), 'the replaced one is the newest, not evicted');
    assert.equal(ids.at(-1), messageId(cap));
    assert.equal(ids.at(-2), messageId(1));
    assert.deepEqual(await listed(app, 'c1', 'ui-other'), [['message', messageId(0), '别的插件', null, null]], 'another plugin\'s mark on that message stays');
    assert.ok(!markFrames(sse).some((e) => e.data.mark === null && (e.data.targetId === 'c1-Bob' || e.data.targetId === task.id)), 'the dropped marks were not counted');
    // Two more: message 2 then 3 (message 1 was refreshed).
    assert.deepEqual(await burst(app, 'host.ui.mark', { paramsList: params(cap + 1, cap + 3) }), { sent: 2 });
    const after = (await listed(app, 'c1')).map((m: any) => m[1]);
    assert.ok(!after.includes(messageId(2)) && !after.includes(messageId(3)) && after.includes(messageId(1)));

    // The budget: chips, pushes and marks together, 120 a minute per plugin; refusals do not count.
    minute();
    for (let i = 0; i < 5; i++) assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'task', targetId: 'no-task', text: 'x' }), { error: 'NOT_FOUND' });
    assert.deepEqual(await burst(app, 'host.ui.chip', { params: { clusterId: 'c1', text: '标签' }, times: 40 }), { sent: 40 });
    assert.deepEqual(await burst(app, 'host.ui.push', { params: { clusterId: 'c1', data: 0 }, times: 40 }), { sent: 40 });
    const rest = await burst(app, 'host.ui.mark', { params: { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '忙' }, times: 120 });
    assert.deepEqual(rest, { sent: 40, error: 'RATE_LIMITED' });
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: '再来' }), { error: 'RATE_LIMITED' });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: null }), { error: 'RATE_LIMITED' }, 'a clear counts too');
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '另一个' }, 'ui-other'), { result: { shown: true } },
      'another plugin has its own budget');
    minute();
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '下一分钟' }), { result: { shown: true } });
  } finally {
    sse.close();
    await app.close();
  }
});

test('marks: one plugin never changes or clears another\'s; clusters apart; a target that is gone is NOT_FOUND for set and clear alike', async () => {
  const { app } = await hub([{ id: 'ui-probe' }, { id: 'ui-other' }]);
  try {
    const task = await createTask(app, 'c1', '要删的任务');
    const member = { clusterId: 'c1', target: 'member', targetId: 'c1-Bob' };
    assert.deepEqual(await mark(app, { ...member, text: '甲' }), { result: { shown: true } });
    assert.deepEqual(await mark(app, { ...member, text: '乙' }, 'ui-other'), { result: { shown: true } });
    // ui-other clears its own: ui-probe's stays; setting it again changes only its own.
    assert.deepEqual(await mark(app, { ...member, text: null }, 'ui-other'), { result: { shown: false } });
    assert.deepEqual(await mark(app, { ...member, text: null }, 'ui-other'), { result: { shown: false } });
    assert.deepEqual(await listed(app, 'c1'), [['member', 'c1-Bob', '甲', null, null]]);
    assert.deepEqual(await listed(app, 'c1', 'ui-other'), []);
    // A mark in c2 is listed in c2 only.
    assert.deepEqual(await mark(app, { clusterId: 'c2', target: 'member', targetId: 'c2-Bob', text: '丙' }), { result: { shown: true } });
    assert.deepEqual(await listed(app, 'c2'), [['member', 'c2-Bob', '丙', null, null]]);
    assert.deepEqual(await listed(app, 'c1'), [['member', 'c1-Bob', '甲', null, null]]);

    // The member removed, the task deleted: their marks are no longer listed; setting and clearing there are refused alike.
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'task', targetId: task.id, text: '任务' }), { result: { shown: true } });
    await app.api('DELETE', '/api/clusters/c1/members/c1-Bob', {});
    const cancelled = (await app.api('POST', '/api/clusters/c1/collaboration', { action: 'task.cancel', operationId: 'cancel', taskId: task.id,
      expectedRevision: task.revision, reason: 'test' })).task;
    await app.api('POST', '/api/clusters/c1/collaboration', { action: 'task.delete', operationId: 'delete', taskId: task.id, expectedRevision: cancelled.revision });
    assert.deepEqual(await listed(app, 'c1'), []);
    assert.deepEqual(await mark(app, { ...member, text: '再设' }), { error: 'NOT_FOUND' });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'task', targetId: task.id, text: '再设' }), { error: 'NOT_FOUND' });
    // Clearing there: NOT_FOUND every time, for the plugin that had a mark there and for one that had none.
    for (const plugin of ['ui-probe', 'ui-probe', 'ui-other']) assert.deepEqual(await mark(app, { ...member, text: null }, plugin), { error: 'NOT_FOUND' }, plugin);
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'task', targetId: task.id, text: null }), { error: 'NOT_FOUND' });
    // A target still there can be cleared, with or without a mark of this plugin on it.
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '在' }), { result: { shown: true } });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: null }), { result: { shown: false } });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: null }), { result: { shown: false } });
  } finally {
    await app.close();
  }
});

test('marks go when the plugin stops, restarts, its UI is switched off or its grant is taken away, and with a cluster in the bin', async () => {
  const { app, dir } = await hub([{ id: 'ui-probe' }, { id: 'ui-other' }]);
  const sse = openSse(`${app.url}/api/stream`, bearer(TEST_TOKEN));
  const cleared = (plugin: string, clusterId: string) => sse.events.filter((e) => e.event === 'plugin-ui' && e.data.kind === 'marks-cleared'
    && e.data.pluginId === plugin && e.data.clusterId === clusterId).length;
  const setBoth = async (plugin = 'ui-probe') => {
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '一' }, plugin), { result: { shown: true } });
    assert.deepEqual(await mark(app, { clusterId: 'c2', target: 'member', targetId: 'c2-Alice', text: '二' }, plugin), { result: { shown: true } });
  };
  try {
    await sse.status;
    await setBoth('ui-other');

    // Stopped: gone in both clusters, the page told once per cluster; started again: none come back.
    await setBoth();
    await app.api('POST', '/api/plugins/ui-probe/stop', {});
    await waitFor(() => cleared('ui-probe', 'c1') === 1 && cleared('ui-probe', 'c2') === 1, 'the stop clearing');
    await app.api('POST', '/api/plugins/ui-probe/start', {});
    assert.deepEqual([await listed(app, 'c1'), await listed(app, 'c2')], [[], []]);
    // Restarted: the same.
    await setBoth();
    await app.api('POST', '/api/plugins/ui-probe/restart', {});
    await waitFor(() => cleared('ui-probe', 'c1') === 2 && cleared('ui-probe', 'c2') === 2, 'the restart clearing');
    assert.deepEqual([await listed(app, 'c1'), await listed(app, 'c2')], [[], []]);

    // The UI switched off: gone; setting or clearing while off is refused (UI_OFF, after the grant checks, before the
    // target) and takes no budget: more refusals than a minute's budget, then calls succeed once it is on again.
    await setBoth();
    await app.api('PATCH', '/api/plugins/ui-probe/lifecycle', { ui: false });
    await waitFor(() => cleared('ui-probe', 'c1') === 3, 'the switch-off clearing');
    const frames = markFrames(sse).length;
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '关着' }), { error: 'UI_OFF' });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: null }), { error: 'UI_OFF' });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'nobody', text: 'x' }), { error: 'UI_OFF' });
    assert.deepEqual(await mark(app, { clusterId: 'c3', target: 'member', targetId: 'nobody', text: 'x' }), { error: 'CLUSTER_NOT_GRANTED' });
    for (let i = 0; i < UI_LIMITS.pushesPerPluginPerMinute; i++) {
      assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '关着' }), { error: 'UI_OFF' });
    }
    assert.equal(markFrames(sse).length, frames, 'nothing told while off');
    await app.api('PATCH', '/api/plugins/ui-probe/lifecycle', { ui: true });
    assert.deepEqual(await listed(app, 'c1'), []);
    assert.deepEqual(await burst(app, 'host.ui.mark', { params: { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '开着' }, times: 2 }),
      { sent: 2 }, 'the refusals took no budget');
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: null }), { result: { shown: false } });

    // A cluster in the bin: its marks go (every plugin's), the page told; the other cluster's stay; restored: not back.
    await setBoth();
    await app.api('DELETE', '/api/clusters/c2', {});
    await waitFor(() => cleared('ui-probe', 'c2') === 4 && cleared('ui-other', 'c2') === 1, 'the trash clearing');
    assert.equal(cleared('ui-probe', 'c1'), 3, 'c1 untouched');
    assert.deepEqual(await mark(app, { clusterId: 'c2', target: 'member', targetId: 'c2-Alice', text: '回收站' }), { error: 'CLUSTER_NOT_GRANTED' });
    await app.api('POST', '/api/clusters/c2/restore', {});
    assert.deepEqual([await listed(app, 'c2'), await listed(app, 'c2', 'ui-other')], [[], []]);
    assert.deepEqual(await listed(app, 'c1'), [['member', 'c1-Alice', '一', null, null]]);
    assert.deepEqual(await listed(app, 'c1', 'ui-other'), [['member', 'c1-Alice', '一', null, null]]);

    // The grant taken away (marks no longer in its ui grant), then restarted as the docs say: gone, and refused from now on.
    const configPath = join(dir, 'home', 'external-plugins.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.plugins[0].ui = ['titlebar', 'workbench'];
    writeFileSync(configPath, JSON.stringify(config));
    await app.api('POST', '/api/plugins/ui-probe/restart', {});
    await waitFor(() => cleared('ui-probe', 'c1') === 4, 'the clearing at the restart with the new grant');
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'member', targetId: 'c1-Alice', text: '无权' }), { error: 'POSITION_NOT_GRANTED' });
    assert.equal((await app.api('GET', '/api/clusters/c1/plugin-ui')).items.find((i: any) => i.pluginId === 'ui-probe').marks.length, 0);
    assert.deepEqual(await listed(app, 'c1', 'ui-other'), [['member', 'c1-Alice', '一', null, null]], 'the other plugin keeps its own');
  } finally {
    sse.close();
    await app.close();
  }
});

test('marks: none after a Hub restart; with the tasks plugin disabled there are no tasks to mark', async () => {
  const dir = tempDir();
  const first = await hub(undefined, dir);
  const task = await createTask(first.app, 'c1', '停用前的任务');
  assert.deepEqual(await mark(first.app, { clusterId: 'c1', target: 'message', targetId: messageId(0), text: '重启前' }), { result: { shown: true } });
  assert.deepEqual(await mark(first.app, { clusterId: 'c1', target: 'task', targetId: task.id, text: '重启前' }), { result: { shown: true } });
  assert.equal((await listed(first.app, 'c1')).length, 2);
  await first.app.close();
  // The coordinator requires the tasks plugin: both off.
  const { app } = await hub(undefined, dir, false, ['coordinator', 'tasks']);
  try {
    assert.deepEqual(await listed(app, 'c1'), []);
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'task', targetId: task.id, text: '停用后' }), { error: 'NOT_FOUND' });
    assert.deepEqual(await mark(app, { clusterId: 'c1', target: 'message', targetId: messageId(0), text: '停用后' }), { result: { shown: true } });
  } finally {
    await app.close();
  }
});
