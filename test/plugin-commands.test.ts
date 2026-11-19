// Plugin commands the user runs from a cluster's composer (docs/external-plugins.md「命令」): manifest params, the
// listing per cluster and grant, user-only triggering without chat side effects, argument checks, the invoke context,
// and long-running runs (progress, done, the cap, cancel, plugin exit, foreign or late notifications, the caps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommandRefusal, CommandRuns, parseDuration, validateArguments, type RunView } from '../src/core/external-plugin-commands.ts';
import { parseExternalManifest, type ExternalCommand } from '../src/core/external-plugin-config.ts';
import type { CommandLimits } from '../src/core/external-plugin-commands.ts';
import { REPO_ROOT } from '../src/main.ts';
import { Store } from '../src/core/store.ts';
import { bearer, openSse, rawFetch, startTestHub, tempDir, TEST_TOKEN, waitFor, memberHeaders } from './helpers.ts';

const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'command-demo');
const manifest = (commands: unknown[]) => ({ id: 'demo', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', permissions: [], commands });

test('manifest: commands may declare a description, typed params and clusterScoped; old {id,title} stays exactly that', () => {
  const fixture = parseExternalManifest(JSON.parse(readFileSync(join(FIXTURE, 'orrery-plugin.json'), 'utf8')));
  const greet = fixture.commands.find((c) => c.id === 'greet')!;
  assert.equal(greet.description, '立即回答一句话。');
  assert.deepEqual(greet.params!.map((p) => [p.name, p.type, p.required]), [['name', 'text', true], ['times', 'number', false],
    ['loud', 'boolean', false], ['who', 'member', false], ['mood', 'enum', false], ['wait', 'duration', false]]);
  assert.deepEqual(fixture.commands.find((c) => c.id === 'count'), { id: 'count', title: '旧式命令' }, 'an old command parses to what it was');
  assert.deepEqual(fixture.commands.find((c) => c.id === 'debug'), { id: 'debug', title: '测试探针', clusterScoped: false });
  assert.deepEqual(parseExternalManifest(manifest([{ id: 'x', title: 'X', clusterScoped: true, params: [] }])).commands, [{ id: 'x', title: 'X', params: [] }]);

  const param = (p: Record<string, unknown>) => manifest([{ id: 'x', title: 'X', params: [{ name: 'a', label: 'A', ...p }] }]);
  const good: Record<string, unknown>[] = [
    { type: 'text', default: 'hi', description: 'd' }, { type: 'text', required: true, default: 'ready' },
    { type: 'number', min: -1, max: 1, default: 0.5 }, { type: 'duration', default: 900 },
    { type: 'duration', min: 60, max: 3600, default: 60 }, { type: 'boolean', default: false, required: true }, { type: 'member' },
    { type: 'enum', options: ['a', 'b'], default: 'b' },
  ];
  for (const p of good) assert.doesNotThrow(() => parseExternalManifest(param(p)), JSON.stringify(p));
  const bad: Record<string, unknown>[] = [
    { type: 'date' }, { type: 'text', default: 5 }, { type: 'text', default: 'x'.repeat(2001) }, { type: 'number', min: 2, max: 1 },
    { type: 'number', max: 1, default: 2 }, { type: 'number', default: Number.NaN }, { type: 'duration', default: 1.5 }, { type: 'duration', default: 0 },
    { type: 'duration', min: 0 }, { type: 'duration', max: 31 * 24 * 3600 }, { type: 'boolean', default: 'yes' }, { type: 'member', default: 'm1' },
    { type: 'enum' }, { type: 'enum', options: [] }, { type: 'enum', options: ['a', 'a'] }, { type: 'enum', options: ['a'], default: 'b' },
    { type: 'text', options: ['a'] }, { type: 'text', min: 1 }, { type: 'boolean', required: 'yes' }, { type: 'text', extra: 1 },
    { type: 'text', label: '' }, { type: 'text', label: 'x'.repeat(61) }, { type: 'text', description: 'x'.repeat(201) },
    { type: 'text', name: 'Bad' }, { type: 'text', name: 'a-b' }, { type: 'text', name: 'x'.repeat(33) },
    { type: 'text', required: true, default: '' }, { type: 'text', required: true, default: ' \t ' },
  ];
  for (const p of bad) assert.throws(() => parseExternalManifest(param(p)), /invalid|unknown|duplicate/, JSON.stringify(p));
  const optionalBlank = parseExternalManifest(param({ type: 'text', default: '' })).commands[0];
  assert.equal(optionalBlank.params![0].default, '', 'an optional text keeps its empty default');
  assert.deepEqual(validateArguments(optionalBlank, {}, new Set()), { a: '' });
  const two = (a: string, b: string) => manifest([{ id: 'x', title: 'X', params: [{ name: a, type: 'text', label: 'A' }, { name: b, type: 'text', label: 'B' }] }]);
  assert.throws(() => parseExternalManifest(two('a', 'a')), /duplicate command parameter/);
  const many = Array.from({ length: 17 }, (_, i) => ({ name: `p${i}`, type: 'text', label: `P${i}` }));
  assert.throws(() => parseExternalManifest(manifest([{ id: 'x', title: 'X', params: many }])), /invalid command params/);
  assert.doesNotThrow(() => parseExternalManifest(manifest([{ id: 'x', title: 'X', params: many.slice(0, 16) }])));
  assert.throws(() => parseExternalManifest(manifest([{ id: 'x', title: 'X', params: {} }])), /invalid command params/);
  assert.throws(() => parseExternalManifest(manifest([{ id: 'x', title: 'X', clusterScoped: 'no' }])), /clusterScoped/);
  assert.throws(() => parseExternalManifest(manifest([{ id: 'x', title: 'X', longRunning: 'yes' }])), /longRunning/);
  assert.deepEqual(parseExternalManifest(manifest([{ id: 'x', title: 'X', longRunning: true }, { id: 'y', title: 'Y', longRunning: false }])).commands,
    [{ id: 'x', title: 'X', longRunning: true }, { id: 'y', title: 'Y' }], 'background mode is opt-in per command');
  assert.throws(() => parseExternalManifest(manifest([{ id: 'x', title: 'X', description: 'x'.repeat(201) }])), /invalid/);
  assert.throws(() => parseExternalManifest(manifest([{ id: 'x', title: 'X', usage: '/x' }])), /unknown/);
});

test('arguments: only declared names, each by its type and bounds; durations as seconds or 15m/900s/1h; members of the cluster', () => {
  const command = parseExternalManifest(JSON.parse(readFileSync(join(FIXTURE, 'orrery-plugin.json'), 'utf8'))).commands.find((c) => c.id === 'greet')!;
  const members = new Set(['m1', 'm2']);
  const ok = (raw: unknown) => validateArguments(command, raw, members);
  const refused = (raw: unknown) => {
    try { ok(raw); } catch (e) { assert.ok(e instanceof CommandRefusal); return [e.code, e.field]; }
    return null;
  };
  assert.deepEqual(ok({ name: 'Ann' }), { name: 'Ann', times: 1, mood: 'calm' }, 'defaults fill optional ones; others are left out');
  assert.deepEqual(ok({ name: 'Ann', times: 3, loud: true, who: 'm2', mood: 'happy', wait: '15m' }),
    { name: 'Ann', times: 3, loud: true, who: 'm2', mood: 'happy', wait: 900 });
  assert.deepEqual(ok({ name: 'Ann', who: null, wait: 120 }), { name: 'Ann', times: 1, mood: 'calm', wait: 120 }, 'null: as if absent');
  assert.deepEqual(refused({}), ['MISSING_ARGUMENT', 'name']);
  assert.deepEqual(refused({ name: '   ' }), ['MISSING_ARGUMENT', 'name'], 'a blank required text is missing');
  assert.deepEqual(refused({ name: 'Ann', extra: 1 }), ['UNKNOWN_ARGUMENT', 'extra']);
  assert.deepEqual(refused({ name: 5 }), ['INVALID_ARGUMENT', 'name']);
  assert.deepEqual(refused({ name: 'x'.repeat(2001) }), ['INVALID_ARGUMENT', 'name']);
  for (const times of [0, 6, 2.5e9, '3', Number.NaN, Infinity]) assert.deepEqual(refused({ name: 'A', times }), ['INVALID_ARGUMENT', 'times'], String(times));
  assert.deepEqual(refused({ name: 'A', loud: 'true' }), ['INVALID_ARGUMENT', 'loud']);
  assert.deepEqual(refused({ name: 'A', who: 'm3' }), ['INVALID_ARGUMENT', 'who'], 'not a member of this cluster');
  assert.deepEqual(refused({ name: 'A', mood: 'angry' }), ['INVALID_ARGUMENT', 'mood']);
  for (const wait of ['30s', '3h', 'soon', '15 minutes', 59, 7201, 90.5, '']) assert.deepEqual(refused({ name: 'A', wait }), ['INVALID_ARGUMENT', 'wait'], String(wait));
  assert.deepEqual(refused([]), ['INVALID_ARGUMENT', null]);
  assert.deepEqual(refused('x'), ['INVALID_ARGUMENT', null]);
  assert.deepEqual(validateArguments({ id: 'old', title: 'Old' }, undefined, members), {}, 'a command without params takes none');
  assert.deepEqual(refusedOld(), ['UNKNOWN_ARGUMENT', 'clusterId']);
  function refusedOld() {
    try { validateArguments({ id: 'old', title: 'Old' } as ExternalCommand, { clusterId: 'x' }, members); } catch (e) { return [(e as CommandRefusal).code, (e as CommandRefusal).field]; }
    return null;
  }
  const cases: [unknown, number | null][] = [['15m', 900], ['900s', 900], ['1h', 3600], ['1h30m', 5400], ['90', 90], [' 2m 5s ', 125], ['1H', 3600],
    ['10 h 5 s', 36005], [900, 900], [1.5, null], ['', null], ['m', null], ['1d', null], ['-5s', null], ['5 min', null], [null, null],
    ['1h30', null], ['5m5', null], ['10 h 5', null], ['1h 30', null]];
  for (const [input, seconds] of cases) assert.equal(parseDuration(input), seconds, String(input));
  const refusedWait = (() => { try { ok({ name: 'A', wait: '1h30' }); } catch (e) { return (e as CommandRefusal).message; } return ''; })();
  assert.match(refusedWait, /1h30 请写成 1h30m/, 'a bare number after a unit is refused with the fix in the message');
});

test('arguments: params named after Object.prototype members work like any other (own properties only)', () => {
  const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  const command = parseExternalManifest(manifest([{ id: 'x', title: 'X', params: names.map((name, i) => ({ name, type: 'number', label: name, default: i })) }])).commands[0];
  const members = new Set<string>();
  const omitted = validateArguments(command, {}, members);
  assert.deepEqual(omitted, { constructor: 0, toString: 1, valueOf: 2, hasOwnProperty: 3 }, 'omitted: the defaults apply');
  assert.deepEqual(Object.keys(omitted), names, 'own properties');
  assert.deepEqual(validateArguments(command, JSON.parse('{"constructor":5,"toString":6,"valueOf":7,"hasOwnProperty":8}'), members),
    { constructor: 5, toString: 6, valueOf: 7, hasOwnProperty: 8 }, 'given: validated');
  assert.throws(() => validateArguments(command, { toString: 'x' }, members), (e: CommandRefusal) => e.code === 'INVALID_ARGUMENT' && e.field === 'toString');
  assert.throws(() => validateArguments(command, JSON.parse('{"__proto__":{"x":1}}'), members), (e: CommandRefusal) => e.code === 'UNKNOWN_ARGUMENT');
  const required = parseExternalManifest(manifest([{ id: 'x', title: 'X', params: [{ name: 'valueOf', type: 'text', label: 'V', required: true }] }])).commands[0];
  assert.throws(() => validateArguments(required, {}, members), (e: CommandRefusal) => e.code === 'MISSING_ARGUMENT' && e.field === 'valueOf');
});

test('runs in memory: cancel waits for the answer of a starting run; an answer after the end never revives it', async () => {
  const frames: RunView[] = [];
  const limits: CommandLimits = { runMs: 10_000, cancelGraceMs: 50, maxRunsPerPlugin: 2, progressIntervalMs: 0 };
  let cancels = 0;
  const runs = new CommandRuns(limits, () => { cancels++; return true; });
  runs.onRun((r) => frames.push(r));
  const quick = runs.create({ clusterId: 'a', pluginId: 'p', pluginName: 'P', command: 'q', title: 'Q' });
  runs.progress('p', { runId: quick.runId, text: 'not a long command' });
  runs.answered(quick, { accepted: true, n: 1 });
  assert.deepEqual([frames.at(-1)!.state, frames.at(-1)!.progress, frames.at(-1)!.data], ['succeeded', null, { accepted: true, n: 1 }],
    'a command not declared longRunning: {accepted:true} is its final result, and it takes no progress');
  frames.length = 0;
  const run = runs.create({ clusterId: 'a', pluginId: 'p', pluginName: 'P', command: 'c', title: 'C' }, true);
  assert.throws(() => runs.cancel('a', run.runId), (e: CommandRefusal) => e.code === 'NOT_CANCELLABLE');
  assert.throws(() => runs.cancel('b', run.runId), (e: CommandRefusal) => e.code === 'RUN_NOT_FOUND', 'another cluster cannot see it');
  runs.answered(run, { accepted: true });
  runs.progress('q', { runId: run.runId, text: 'not mine' });
  runs.progress('p', { runId: run.runId, text: 'x', fraction: 2 });
  runs.progress('p', [run.runId]);
  assert.deepEqual(frames.map((f) => [f.state, f.progress]), [['starting', null], ['running', null]], 'foreign and malformed progress dropped');
  assert.equal(runs.cancel('a', run.runId).state, 'cancelling');
  assert.equal(runs.cancel('a', run.runId).state, 'cancelling', 'cancel twice: the same run');
  assert.equal(cancels, 1);
  await sleep(80);
  assert.deepEqual([frames.at(-1)!.state, frames.at(-1)!.reason], ['cancelled', 'no_answer']);
  const count = frames.length;
  runs.done('p', { runId: run.runId, ok: true, text: 'late' });
  runs.answered(run, { text: 'late answer' });
  runs.failed(run);
  assert.equal(frames.length, count, 'nothing after the end');
  assert.throws(() => runs.cancel('a', run.runId), (e: CommandRefusal) => e.code === 'RUN_NOT_FOUND');
  runs.close();
});

// ---- against a real test Hub ----

interface Plugin { id: string; clusterIds: string[]; optIn?: boolean }
/** Clusters `one` (Alice; Bob removed) and `two` (Dan) of native mock members, and copies of the fixture plugin. */
function setup(plugins: Plugin[]): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const store = new Store(join(dir, 'test.db'));
  for (const [clusterId, names] of Object.entries({ one: ['Alice', 'Bob'], two: ['Dan'] })) {
    store.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' }, names.map((name) => ({
      id: `${clusterId}-${name}`, clusterId, name, avatar: '', harness: 'mock', model: null, effort: null,
      workerSessionId: `${clusterId}-${name}`, cwd: dir, origin: 'attached' as const, removedAt: null })));
  }
  store.db.prepare('UPDATE members SET removed_at = ? WHERE id = ?').run('2026-01-02', 'one-Bob');
  store.close();
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: plugins.map((plugin) => {
    const directory = join(dir, 'plugins', plugin.id);
    cpSync(FIXTURE, directory, { recursive: true });
    const file = join(directory, 'orrery-plugin.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), id: plugin.id }));
    if (plugin.optIn === false) writeFileSync(join(directory, 'options.json'), JSON.stringify({ optIn: false }));
    return { manifest: file, permissions: ['clusters.read'], clusterIds: plugin.clusterIds };
  }) }));
  return dir;
}

type App = Awaited<ReturnType<typeof startTestHub>>;
async function hub(plugins: Plugin[], limits: Partial<CommandLimits> = {}) {
  const dir = setup(plugins);
  const app = await startTestHub({ dir, pluginCommandLimits: { progressIntervalMs: 0, ...limits } });
  const sse = openSse(`${app.url}/api/stream?since=${app.store.lastEventSeq()}`, bearer(TEST_TOKEN));
  assert.equal(await sse.status, 200);
  const runs = () => sse.events.filter((e) => e.event === 'plugin-run').map((e) => e.data as RunView);
  return { app, sse, runs, close: async () => { sse.close(); await app.close(); } };
}
/** POST/GET with the user's token: `{status, data}` instead of throwing. */
async function call(app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = bearer(TEST_TOKEN)) {
  const res = await rawFetch(app.url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() as any };
}
const run = (app: App, cluster: string, pluginId: string, command: string, args?: unknown) =>
  call(app, 'POST', `/api/clusters/${cluster}/plugin-commands/run`, { pluginId, command, ...(args === undefined ? {} : { arguments: args }) });
const cancel = (app: App, cluster: string, runId: string) => call(app, 'POST', `/api/clusters/${cluster}/plugin-runs/${runId}/cancel`, {});
const probe = async (app: App, pluginId: string, args: Record<string, unknown>) => (await app.api('POST', `/api/plugins/${pluginId}/invoke`, { command: 'debug', arguments: args })).result;
/** The commands the plugin was invoked with, the probe's own calls left out. */
const commandsSeen = async (app: App, id: string) => (await probe(app, id, { action: 'seen' })).invokes.map((i: any) => i.command).filter((c: string) => c !== 'debug');
const state = async (app: App, id: string) => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === id).runtime.state;
const settled = (frames: () => RunView[], runId: string) =>
  waitFor(() => frames().find((r) => r.runId === runId && ['succeeded', 'failed', 'cancelled'].includes(r.state)), `run ${runId} ends`);
/** Rows a run must never add: messages, deliveries, logged events. */
const footprint = (app: App) => ({
  messages: app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n,
  deliveries: app.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()!.n,
  seq: app.store.lastEventSeq(),
});

test('listing: running plugins granted the cluster; old commands listed, clusterScoped:false not; the old HTTP invoke is unchanged', async () => {
  const t = await hub([{ id: 'command-demo', clusterIds: ['one'] }, { id: 'other-demo', clusterIds: ['two'] }]);
  try {
    const one = await t.app.api('GET', '/api/clusters/one/plugin-commands');
    assert.deepEqual(one.commands.map((c: any) => [c.pluginId, c.id]), [['command-demo', 'greet'], ['command-demo', 'session'], ['command-demo', 'count']]);
    assert.deepEqual(one.runs, []);
    const greet = one.commands[0];
    assert.equal(greet.pluginName, '命令示例（测试用）');
    assert.equal(greet.params.length, 6);
    assert.deepEqual(one.commands[2], { pluginId: 'command-demo', pluginName: '命令示例（测试用）', id: 'count', title: '旧式命令', description: '', params: [] });
    assert.deepEqual((await t.app.api('GET', '/api/clusters/two/plugin-commands')).commands.map((c: any) => c.pluginId), ['other-demo', 'other-demo', 'other-demo']);
    assert.equal((await call(t.app, 'GET', '/api/clusters/none/plugin-commands')).status, 404);

    // The old route: no context, no argument checks, clusterScoped:false commands too; and the settings list shows params.
    assert.deepEqual((await t.app.api('POST', '/api/plugins/command-demo/invoke', { command: 'count', arguments: { clusterId: 'one' } })).result,
      { old: true, accepted: true, arguments: { clusterId: 'one' }, hasContext: false });
    // From the cluster, the same old command (not longRunning) ends at once with its answer, `accepted` or not.
    const old = (await run(t.app, 'one', 'command-demo', 'count')).data.run;
    assert.deepEqual([old.state, old.data], ['succeeded', { old: true, accepted: true, arguments: {}, hasContext: true }]);
    assert.deepEqual((await t.app.api('GET', '/api/clusters/one/plugin-commands')).runs, [], 'it holds no slot');
    const seen = await probe(t.app, 'command-demo', { action: 'seen' });
    assert.ok(!('context' in seen.invokes[0]), 'no context key at all on the old route');
    assert.equal((await t.app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'command-demo').commands.length, 4);

    await t.app.api('POST', '/api/plugins/command-demo/stop', {});
    assert.deepEqual((await t.app.api('GET', '/api/clusters/one/plugin-commands')).commands, [], 'a stopped plugin offers nothing');
    assert.equal((await run(t.app, 'one', 'command-demo', 'count')).data.code, 'PLUGIN_NOT_RUNNING');
  } finally { await t.close(); }
});

test('who may run: only the user token; members, the bridge secret and plugins are refused; no message, delivery, event or wake', async () => {
  const t = await hub([{ id: 'command-demo', clusterIds: ['one'] }]);
  try {
    const { secret } = JSON.parse(readFileSync(join(t.app.home, 'hub.json'), 'utf8'));
    const { members: [member] } = await t.app.cluster('members', ['m']);
    const before = footprint(t.app);
    const body = { pluginId: 'command-demo', command: 'greet', arguments: { name: 'A' } };
    for (const headers of [{}, { 'x-orrery-bridge': secret }, bearer(secret), memberHeaders(t.app, member.id)] as Record<string, string>[]) {
      assert.equal((await call(t.app, 'POST', '/api/clusters/one/plugin-commands/run', body, headers)).status, 401, JSON.stringify(Object.keys(headers)));
      assert.equal((await call(t.app, 'GET', '/api/clusters/one/plugin-commands', undefined, headers)).status, 401);
      assert.equal((await call(t.app, 'POST', '/api/clusters/one/plugin-runs/x/cancel', {}, headers)).status, 401);
    }
    assert.deepEqual(await commandsSeen(t.app, 'command-demo'), [], 'no refused caller reached the plugin');
    // A plugin has no call for it: neither a host method nor a notification with an id.
    for (const method of ['host.commands.run', 'command.run', 'command.done', 'command.progress']) {
      const answer = await probe(t.app, 'command-demo', { action: 'host', method, params: { pluginId: 'command-demo', command: 'greet', runId: 'x', ok: true } });
      assert.deepEqual(answer.error, { code: -32000, message: 'host request denied or invalid' }, method);
    }
    assert.equal(await state(t.app, 'command-demo'), 'ready');

    // The user runs a quick and a long command: nothing reaches the chat, the deliveries or the event log.
    const turns = t.app.native.delivered.length;
    assert.equal((await run(t.app, 'one', 'command-demo', 'greet', { name: 'A' })).data.run.state, 'succeeded');
    const long = (await run(t.app, 'one', 'command-demo', 'session', { ticks: 2, tickMs: 10 })).data.run;
    await settled(t.runs, long.runId);
    assert.deepEqual(footprint(t.app), before);
    assert.equal(t.app.native.delivered.length, turns, 'no turn started');
    assert.ok(!t.app.events.some((e) => JSON.stringify(e).includes(long.runId)), 'no Hub event names the run');
    assert.ok(!t.app.store.eventJsonPage(0, 10_000).some((e) => e.json.includes(long.runId)), 'nothing logged');
  } finally { await t.close(); }
});

test('a quick command: validated arguments and the context reach the plugin; refusals carry stable codes and the field', async () => {
  const t = await hub([{ id: 'command-demo', clusterIds: ['one'] }]);
  try {
    const { data } = await run(t.app, 'one', 'command-demo', 'greet', { name: 'Ann', times: 2, loud: true, who: 'one-Alice', mood: 'happy', wait: '1h' });
    const view = data.run;
    assert.deepEqual([view.state, view.text, view.clusterId, view.pluginId, view.command, view.title, view.reason],
      ['succeeded', '你好呀，Ann你好呀，Ann！', 'one', 'command-demo', 'greet', '打招呼', null]);
    assert.deepEqual(view.data.echo.arguments, { name: 'Ann', times: 2, loud: true, who: 'one-Alice', mood: 'happy', wait: 3600 });
    assert.deepEqual(view.data.echo.context, { clusterId: 'one', by: 'user', at: view.startedAt, runId: view.runId });
    await waitFor(() => t.runs().some((r) => r.runId === view.runId && r.state === 'succeeded'), 'the page stream hears the end too');

    const code = async (cluster: string, body: Record<string, unknown>) => {
      const res = await call(t.app, 'POST', `/api/clusters/${cluster}/plugin-commands/run`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      return [res.data.code, res.data.field ?? null];
    };
    const greet = (args: unknown) => ({ pluginId: 'command-demo', command: 'greet', arguments: args });
    assert.deepEqual(await code('one', greet({})), ['MISSING_ARGUMENT', 'name']);
    assert.deepEqual(await code('one', greet({ name: 'A', other: 1 })), ['UNKNOWN_ARGUMENT', 'other']);
    assert.deepEqual(await code('one', greet({ name: 'A', who: 'one-Bob' })), ['INVALID_ARGUMENT', 'who'], 'a removed member');
    assert.deepEqual(await code('one', greet({ name: 'A', who: 'two-Dan' })), ['INVALID_ARGUMENT', 'who'], 'a member of another cluster');
    assert.deepEqual(await code('one', greet({ name: 'A', wait: '30s' })), ['INVALID_ARGUMENT', 'wait']);
    assert.deepEqual(await code('two', greet({ name: 'A' })), ['CLUSTER_NOT_GRANTED', null]);
    assert.deepEqual(await code('one', { pluginId: 'command-demo', command: 'debug' }), ['UNKNOWN_COMMAND', null], 'not offered in clusters');
    assert.deepEqual(await code('one', { pluginId: 'command-demo', command: 'nope' }), ['UNKNOWN_COMMAND', null]);
    assert.deepEqual(await code('one', { pluginId: 'nobody', command: 'greet' }), ['UNKNOWN_PLUGIN', null]);
    assert.deepEqual(await code('one', { pluginId: 'command-demo', command: 'greet', extra: 1 }), ['INVALID_REQUEST', null]);
    assert.deepEqual(await code('one', { command: 'greet' }), ['INVALID_REQUEST', null]);
    assert.deepEqual(await commandsSeen(t.app, 'command-demo'), ['greet'], 'no refused run reached the plugin');
  } finally { await t.close(); }
});

test('oversized aggregate command arguments are refused before creating a run or invoking the plugin', async () => {
  const dir = setup([{ id: 'command-demo', clusterIds: ['one'] }]);
  const file = join(dir, 'plugins', 'command-demo', 'orrery-plugin.json');
  const configured = JSON.parse(readFileSync(file, 'utf8'));
  configured.commands.find((command: { id: string }) => command.id === 'count').params =
    Array.from({ length: 16 }, (_, index) => ({ name: `field${index}`, type: 'text', label: `Field ${index}` }));
  writeFileSync(file, JSON.stringify(configured));
  const app = await startTestHub({ dir });
  try {
    const args = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field${index}`, '中'.repeat(1500)]));
    const command = parseExternalManifest(configured).commands.find((item) => item.id === 'count')!;
    assert.deepEqual(validateArguments(command, args, new Set()), args, 'every individual parameter is valid');
    assert.ok(Buffer.byteLength(JSON.stringify(args)) > 63 * 1024);
    const before = footprint(app);
    const result = await run(app, 'one', 'command-demo', 'count', args);
    assert.equal(result.status, 400);
    assert.equal(result.data.code, 'INVALID_ARGUMENT');
    assert.match(result.data.error, /参数合计过长.*63 KiB/);
    assert.equal(result.data.run, undefined);
    assert.deepEqual(await commandsSeen(app, 'command-demo'), [], 'the oversized invoke never reached the plugin');
    assert.deepEqual((await app.api('GET', '/api/clusters/one/plugin-commands')).runs, []);
    assert.deepEqual(footprint(app), before, 'no messages, deliveries or logged events');
    assert.equal(await state(app, 'command-demo'), 'ready');
  } finally { await app.close(); }
});

test('a long command: accepted, then progress (coalesced), then done; ok, failed, and late notifications dropped', async () => {
  const t = await hub([{ id: 'command-demo', clusterIds: ['one'] }], { progressIntervalMs: 150 });
  try {
    const started = (await run(t.app, 'one', 'command-demo', 'session', { ticks: 10, tickMs: 40 })).data.run;
    assert.deepEqual([started.state, started.progress], ['running', '已开始'], 'the answer is already the accepted run');
    assert.deepEqual((await t.app.api('GET', '/api/clusters/one/plugin-commands')).runs.map((r: RunView) => r.runId), [started.runId]);
    assert.deepEqual((await t.app.api('GET', '/api/clusters/two/plugin-commands')).runs, [], 'not in another cluster');
    const end = await settled(t.runs, started.runId);
    assert.deepEqual([end.state, end.text, end.data, end.reason], ['succeeded', '环节结束，共 10 步', { ticks: 10 }, null]);
    const frames = t.runs().filter((r) => r.runId === started.runId);
    assert.deepEqual(frames.slice(0, 2).map((r) => r.state), ['starting', 'running']);
    const progress = frames.filter((r) => r.state === 'running' && r.progress !== '已开始');
    assert.ok(progress.length >= 1 && progress.length <= 5, `10 progress notes in ~400 ms, at most one frame per 150 ms (${progress.length})`);
    const steps = progress.map((r) => Number(/第 (\d+) 步/.exec(r.progress ?? '')?.[1]));
    assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'each frame carries the newest text so far');
    assert.ok(progress.every((r) => r.fraction! > 0 && r.fraction! < 1));
    assert.equal(end.progress, '第 10 步', 'the newest progress text is kept, nothing older replayed');
    assert.equal((await t.app.api('GET', '/api/clusters/one/plugin-commands')).runs.length, 0, 'an ended run is forgotten');

    const failed = (await run(t.app, 'one', 'command-demo', 'session', { mode: 'fail', ticks: 0, tickMs: 5 })).data.run;
    assert.deepEqual(await settled(t.runs, failed.runId).then((r) => [r.state, r.reason, r.text]), ['failed', 'plugin', '环节出错了']);

    const late = (await run(t.app, 'one', 'command-demo', 'session', { mode: 'after-done', ticks: 0, tickMs: 5 })).data.run;
    await settled(t.runs, late.runId);
    await sleep(100);
    assert.deepEqual(t.runs().filter((r) => r.runId === late.runId).map((r) => r.state), ['starting', 'running', 'succeeded'],
      'progress and done after the end are dropped');
    assert.equal(await state(t.app, 'command-demo'), 'ready', 'and are not a protocol error');

    // The answer {accepted, text:'A'} and command.progress 'B' in one chunk: the newer progress is kept.
    const chunk = (await run(t.app, 'one', 'command-demo', 'session', { mode: 'same-chunk' })).data.run;
    assert.deepEqual([chunk.state, chunk.progress], ['running', 'B']);
    assert.equal((await t.app.api('GET', '/api/clusters/one/plugin-commands')).runs.find((r: RunView) => r.runId === chunk.runId).progress, 'B');
  } finally { await t.close(); }
});

test('the run cap: a plugin that never reports is ended as failed, told to cancel; cancel with and without its cooperation', async () => {
  const t = await hub([{ id: 'command-demo', clusterIds: ['one'] }, { id: 'no-cancel', clusterIds: ['one'], optIn: false }],
    { runMs: 400, cancelGraceMs: 150 });
  try {
    const silent = (await run(t.app, 'one', 'command-demo', 'session', { mode: 'silent' })).data.run;
    const capped = await settled(t.runs, silent.runId);
    assert.deepEqual([capped.state, capped.reason], ['failed', 'timeout']);
    assert.match(capped.text!, /超过 400 毫秒.*已通知插件取消/);
    assert.deepEqual((await probe(t.app, 'command-demo', { action: 'seen' })).cancels, [{ runId: silent.runId }]);

    // Cooperating: the plugin confirms with command.done, the run ends cancelled with its words.
    const coop = (await run(t.app, 'one', 'command-demo', 'session', { ticks: 5, tickMs: 1000 })).data.run;
    assert.equal((await cancel(t.app, 'two', coop.runId)).status, 404, 'a run of another cluster is not found there');
    assert.equal((await cancel(t.app, 'one', coop.runId)).data.run.state, 'cancelling');
    assert.deepEqual(await settled(t.runs, coop.runId).then((r) => [r.state, r.reason, r.text]), ['cancelled', 'plugin', '已按要求停止']);

    // Ignoring it: after the grace the Hub stops waiting; a late done does not revive the run.
    const deaf = (await run(t.app, 'one', 'command-demo', 'session', { mode: 'ignore-cancel' })).data.run;
    await cancel(t.app, 'one', deaf.runId);
    const ended = await settled(t.runs, deaf.runId);
    assert.deepEqual([ended.state, ended.reason], ['cancelled', 'no_answer']);
    assert.match(ended.text!, /150 毫秒内确认取消/);
    const count = t.runs().length;
    await probe(t.app, 'command-demo', { action: 'notify', method: 'command.done', params: { runId: deaf.runId, ok: true, text: 'too late' } });
    await probe(t.app, 'command-demo', { action: 'notify', method: 'command.progress', params: { runId: deaf.runId, text: 'too late' } });
    await sleep(50);
    assert.equal(t.runs().length, count);
    assert.equal((await cancel(t.app, 'one', deaf.runId)).data.code, 'RUN_NOT_FOUND');

    // A plugin that did not ask for command.cancel: cancelled at once, and told so.
    const plain = (await run(t.app, 'one', 'no-cancel', 'session', { mode: 'silent' })).data.run;
    const done = (await cancel(t.app, 'one', plain.runId)).data.run;
    assert.deepEqual([done.state, done.reason], ['cancelled', 'unsupported']);
    assert.match(done.text, /不接收取消通知/);
    assert.deepEqual((await probe(t.app, 'no-cancel', { action: 'seen' })).cancels, [], 'never sent to a plugin that did not opt in');
  } finally { await t.close(); }
});

test('the plugin exits or is stopped mid-run: its runs fail; foreign, unknown and malformed notifications are dropped; the per-plugin cap', async () => {
  const t = await hub([{ id: 'command-demo', clusterIds: ['one'] }, { id: 'other-demo', clusterIds: ['one'] }, { id: 'crasher', clusterIds: ['one'] }],
    { maxRunsPerPlugin: 2 });
  try {
    const mine = (await run(t.app, 'one', 'command-demo', 'session', { mode: 'silent' })).data.run;
    // other-demo reports on command-demo's run, on an unknown run, and with params that are not an object.
    for (const params of [{ runId: mine.runId, ok: true, text: 'not yours' }, { runId: 'no-such-run', ok: true }, [mine.runId], 'x', null]) {
      await probe(t.app, 'other-demo', { action: 'notify', method: 'command.done', params });
      await probe(t.app, 'other-demo', { action: 'notify', method: 'command.progress', params });
    }
    await sleep(50);
    assert.deepEqual(t.runs().filter((r) => r.runId === mine.runId).map((r) => r.state), ['starting', 'running']);
    assert.equal(await state(t.app, 'other-demo'), 'ready', 'dropping them is not a protocol error');

    // The cap counts per plugin.
    await run(t.app, 'one', 'command-demo', 'session', { mode: 'silent' });
    const third = await run(t.app, 'one', 'command-demo', 'session', { mode: 'silent' });
    assert.deepEqual([third.status, third.data.code], [400, 'TOO_MANY_RUNS']);
    assert.equal((await run(t.app, 'one', 'other-demo', 'session', { mode: 'silent' })).data.run.state, 'running', 'another plugin is not affected');

    // Stopping the plugin ends its runs as failed.
    await t.app.api('POST', '/api/plugins/command-demo/stop', {});
    const stopped = t.runs().filter((r) => r.pluginId === 'command-demo' && r.state === 'failed');
    assert.deepEqual(stopped.map((r) => r.reason), ['plugin_stopped', 'plugin_stopped']);

    // The process exits on its own mid-run.
    const crash = (await run(t.app, 'one', 'crasher', 'session', { mode: 'exit' })).data.run;
    assert.deepEqual(await settled(t.runs, crash.runId).then((r) => [r.state, r.reason]), ['failed', 'plugin_stopped']);
    assert.equal(await state(t.app, 'crasher'), 'failed');
  } finally { await t.close(); }
});

test('the message-counter example runs from a cluster: the cluster comes from the context, the page gets a text', async () => {
  const dir = setup([]);
  const plugin = join(dir, 'plugins', 'message-counter');
  cpSync(join(REPO_ROOT, 'examples', 'hub-plugins', 'message-counter'), plugin, { recursive: true });
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: [{ manifest: join(plugin, 'orrery-plugin.json'),
    permissions: ['clusters.read', 'messages.read'], clusterIds: ['one'] }] }));
  const app = await startTestHub({ dir });
  try {
    app.hub.sendFromUser('one', 'hello');
    const { data } = await run(app, 'one', 'message-counter', 'count');
    assert.deepEqual([data.run.state, data.run.text], ['succeeded', '最近 1 条消息：user 1 条']);
    assert.deepEqual((await app.api('POST', '/api/plugins/message-counter/invoke', { command: 'count', arguments: { clusterId: 'one' } })).result,
      { clusterId: 'one', recentMessageCount: 1, limit: 100, senders: [{ senderId: 'user', count: 1 }] }, 'the HTTP answer is unchanged');
  } finally { await app.close(); }
});
