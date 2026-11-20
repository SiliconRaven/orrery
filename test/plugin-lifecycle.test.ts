// A third-party plugin's lifecycle (docs/external-plugins.md「生命周期」): start, stop and restart without a Hub restart,
// re-reading the registration, automatic restart with backoff, development reload, the shutdown grace, and every race
// between them. Plugins run as real processes from a temp dir; nothing calls a model.
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_CLOSE_PLUGIN_GRACE_MS, readPluginsFile, writePluginsFile } from '../src/config.ts';
import { parseExternalManifest, readExternalPlugin, readExternalPlugins } from '../src/core/external-plugin-config.ts';
import { DEFAULT_CALL_TIMEOUT_MS, EXIT_WAIT_MS, type ExternalPluginProcess } from '../src/core/external-plugin-process.ts';
import { START_TIMEOUT_MS } from '../src/launcher.ts';
import type { HubEvent } from '../src/core/types.ts';
import { REPO_ROOT } from '../src/main.ts';
import { ExternalPlugins, type DirectoryWatch, type LifecycleOptions } from '../src/core/external-plugins.ts';
import type { RunView } from '../src/core/external-plugin-commands.ts';
import { Store } from '../src/core/store.ts';
import { rawFetch, startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';

/**
 * One plugin script for every case. It reads behaviour.json from its folder when it starts: `init` (ms before it answers
 * initialize), `shutdown` ('answer' | 'never' | 'slow' | 'publish' | 'exit' | 'crash'), `slowMs`, `check` ('allow' | 'hang' |
 * 'refuse'), `afterReady` ('logcrash' | 'srccrash' | 'crash' | 'srcwrite').
 * 'slow' and 'publish' write shutdown.txt before answering. It records the notifications and events it gets.
 */
const script = `
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
let b = {}; try { b = JSON.parse(readFileSync('behaviour.json', 'utf8')); } catch {}
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let initialized = null; const notes = []; const events = []; const pending = new Map(); let serial = 0;
const call = (method, params) => new Promise((resolve) => { const id = 'p-' + (++serial); pending.set(id, resolve); send({ id, method, params }); });
createInterface({input:process.stdin}).on('line', async (line) => {
  const m = JSON.parse(line);
  if (!m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  if (m.id === undefined) { notes.push(m.method); if (m.method === 'event') events.push(m.params); return; }
  if (m.method === 'initialize') {
    initialized = m.params;
    setTimeout(() => {
      send({id:m.id,result:{apiVersion:1,notifications:['message.check.result','command.cancel']}});
      // 'logcrash': writes into its own folder (outside data/), then crashes: with reload on it would restart itself.
      if (b.afterReady === 'logcrash') setTimeout(() => { appendFileSync('log.txt', 'x'); process.exit(3); }, 30);
      if (b.afterReady === 'srccrash') setTimeout(() => { appendFileSync('gen.js', '//'); process.exit(3); }, 30);
      if (b.afterReady === 'crash') setTimeout(() => process.exit(3), 30);
      if (b.afterReady === 'srcwrite') setTimeout(() => appendFileSync('gen.js', '//'), b.writeDelay ?? 200);
    }, b.init ?? 0);
    return;
  }
  if (m.method === 'shutdown') {
    if (b.shutdown === 'never') return;
    if (b.shutdown === 'exit') process.exit(0);
    if (b.shutdown === 'crash') throw new Error('crashed while shutting down');
    if (b.shutdown === 'slow') { setTimeout(() => { writeFileSync('shutdown.txt', 'saved'); send({id:m.id,result:{}}); }, b.slowMs ?? 300); return; }
    if (b.shutdown === 'publish') {
      const answer = await call('host.events.publish', { type: 'plugin.' + initialized.pluginId + '.tick', data: { n: 1 } });
      writeFileSync('shutdown.txt', JSON.stringify(answer));
      send({id:m.id,result:{}}); return;
    }
    return send({id:m.id,result:{}});
  }
  if (m.method === 'message.check') {
    if (b.check === 'hang') return;
    return send({id:m.id,result:{allow: b.check !== 'refuse', reason: 'no'}});
  }
  const a = m.params.arguments ?? {};
  if (a.action === 'crash') process.exit(2);
  if (a.action === 'hang') return;
  if (a.action === 'late') return setTimeout(() => send({id:m.id,result:'late'}), a.ms ?? 300);
  if (a.action === 'pid') return send({id:m.id,result:process.pid});
  if (a.action === 'init') return send({id:m.id,result:initialized});
  if (a.action === 'notes') return send({id:m.id,result:notes});
  if (a.action === 'events') return send({id:m.id,result:events});
  if (a.action === 'host') return send({id:m.id,result:(await call(a.method, a.params ?? {}))});
  if (a.action === 'publish') return send({id:m.id,result:(await call('host.events.publish', { type: 'plugin.' + initialized.pluginId + '.tick', data: { n: 2 } }))});
  send({id:m.id,result:a});
});
`;

interface PluginSpec { id: string; behaviour?: object; manifest?: object; grant?: object }

/** Plugin folders under `dir/plugins`, registered in `dir/home/external-plugins.json` as given. */
function setup(plugins: PluginSpec[], dir = tempDir()): { dir: string; home: string; folder: (id: string) => string; register: (specs: PluginSpec[]) => void } {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const folder = (id: string) => join(dir, 'plugins', id);
  const register = (specs: PluginSpec[]) => writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: specs.map((p) => ({
    manifest: join(folder(p.id), 'orrery-plugin.json'), permissions: ['clusters.read'], clusterIds: ['one'], ...p.grant })) }));
  for (const plugin of plugins) {
    mkdirSync(folder(plugin.id), { recursive: true });
    writeFileSync(join(folder(plugin.id), 'main.mjs'), script);
    writeFileSync(join(folder(plugin.id), 'behaviour.json'), JSON.stringify(plugin.behaviour ?? {}));
    writeManifest(folder(plugin.id), plugin.id, plugin.manifest);
  }
  register(plugins);
  return { dir, home, folder, register };
}
function writeManifest(folder: string, id: string, extra: object = {}) {
  writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify({ id, version: '1.0.0', name: `插件${id}`, apiVersion: 1, entry: 'main.mjs',
    permissions: ['clusters.read', 'messages.read', 'messages.gate', 'events.read', 'events.publish'], events: ['plugin.*'],
    publishes: [{ name: 'tick', description: 'A tick.' }], commands: [{ id: 'test', title: 'Test' }], ...extra }));
}

type Records = { pluginId: string; kind: string; text: string }[];
/** An ExternalPlugins over a fresh in-memory store, with a stub Hub that keeps the restart records. */
function manager(home: string, enabled: string[], options: LifecycleOptions = {}, callTimeoutMs = 30_000) {
  const store = new Store(':memory:');
  store.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, []);
  const records: Records = [];
  const hub = { listMembers: () => [], externalPluginRestartRecord: (pluginId: string, _c: readonly string[], kind: string, text: string) => records.push({ pluginId, kind, text }) };
  const config = readExternalPlugins(home);
  const plugins = new ExternalPlugins(config.installations, store, enabled, callTimeoutMs, config.failures, hub as never, {},
    { reread: (id, directory) => readExternalPlugin(home, [], id, directory), ...options });
  return { plugins, store, records, close: async () => { await plugins.close(); store.close(); } };
}

const state = (plugins: ExternalPlugins, id: string) => plugins.stateOf(id);
const call = (plugins: ExternalPlugins, id: string, action: string) => plugins.invoke(id, { command: 'test', arguments: { action } }) as Promise<any>;
const pid = (plugins: ExternalPlugins, id: string) => call(plugins, id, 'pid') as Promise<number>;
/**
 * The pid of the instance running now, once one is ready and answers: a call that a stop (a reload, a restart) ends with
 * `plugin is stopping` is asked again. Any other failure fails the wait's own deadline, never counts as an answer.
 */
async function steadyPid(plugins: ExternalPlugins, id: string): Promise<number> {
  return waitFor(async () => {
    if (state(plugins, id) !== 'ready') return null;
    try { return await pid(plugins, id); } catch (error) {
      if (/plugin is (stopping|stopped|starting)|没有在运行/.test(String(error))) return null;
      throw error;
    }
  }, ` running and answering`, 10_000);
}
/** Waits until a process other than `old` is running and answering; returns its pid. */
async function replacedPid(plugins: ExternalPlugins, id: string, old: number, what: string): Promise<number> {
  return waitFor(async () => { const now = await steadyPid(plugins, id); return now !== old ? now : null; }, what, 10_000);
}
const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
const current = (plugins: ExternalPlugins, id: string) => (plugins as unknown as { processes: Map<string, ExternalPluginProcess> }).processes.get(id)!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('start, stop and restart one plugin; a start of a running plugin changes nothing', async () => {
  const { home } = setup([{ id: 'one' }, { id: 'two' }]);
  const t = manager(home, ['one', 'two']);
  try {
    await t.plugins.start();
    const first = await pid(t.plugins, 'one');
    const other = await pid(t.plugins, 'two');
    await t.plugins.startPlugin('one');
    assert.equal(await pid(t.plugins, 'one'), first, 'already running: left as it is');
    await t.plugins.restartPlugin('one');
    const second = await pid(t.plugins, 'one');
    assert.notEqual(second, first);
    assert.equal(alive(first), false, 'the old process is gone');
    await t.plugins.stop('one');
    assert.equal(state(t.plugins, 'one'), 'stopped');
    assert.equal(alive(second), false);
    await assert.rejects(pid(t.plugins, 'one'), /stopped/);
    await t.plugins.startPlugin('one');
    assert.equal(state(t.plugins, 'one'), 'ready');
    assert.equal(await pid(t.plugins, 'two'), other, 'the other plugin was never touched');
    const info = t.plugins.info('one') as any;
    assert.equal(info.enabled, true);
    assert.equal(info.lifecycle.lastFailure, null, 'a stop and start by the user are no failures');
  } finally { await t.close(); }
});

test('a plugin disabled at this start can be started; a restart reads the changed grant and the upgraded manifest', async () => {
  const s = setup([{ id: 'one' }]);
  const t = manager(s.home, []);
  try {
    await t.plugins.start();
    assert.equal(state(t.plugins, 'one'), 'disabled');
    assert.equal((t.plugins.info('one') as any).enabled, false);
    await t.plugins.startPlugin('one');
    assert.equal(state(t.plugins, 'one'), 'ready');
    assert.deepEqual((await call(t.plugins, 'one', 'init')).permissions, ['clusters.read']);
    // The user grants more and upgrades the plugin: nothing changes by itself...
    s.register([{ id: 'one', grant: { permissions: ['clusters.read', 'events.read'], events: ['plugin.*'] } }]);
    writeManifest(s.folder('one'), 'one', { version: '2.0.0', name: '新名字' });
    assert.deepEqual((await call(t.plugins, 'one', 'init')).permissions, ['clusters.read'], 'no file is read while it runs');
    assert.equal(t.plugins.manifestOf('one')!.version, '1.0.0');
    // ...until the user restarts it.
    await t.plugins.restartPlugin('one');
    const init = await call(t.plugins, 'one', 'init');
    assert.deepEqual([init.permissions, init.events], [['clusters.read', 'events.read'], ['plugin.*']], 'a fresh initialize with the new grant');
    const info = t.plugins.info('one') as any;
    assert.deepEqual([info.version, info.name, info.permissions], ['2.0.0', '新名字', ['clusters.read', 'events.read']]);
  } finally { await t.close(); }
});

test('a registration that became invalid: a running plugin keeps running; a stopped one fails alone, clearly; fixed, it starts again', async () => {
  const s = setup([{ id: 'one' }, { id: 'two' }]);
  const t = manager(s.home, ['one', 'two'], { backoffMs: [30], switches: { autoRestart: ['one'], devReload: [] } });
  try {
    await t.plugins.start();
    const running = await pid(t.plugins, 'one');
    writeFileSync(join(s.folder('one'), 'orrery-plugin.json'), '{ broken');
    // Read before anything is stopped: the running instance stays, the user gets the reason, the card shows it.
    await assert.rejects(t.plugins.restartPlugin('one'), (e: any) => e.code === 'REGISTRATION_INVALID' && /JSON/.test(e.message));
    assert.equal(await pid(t.plugins, 'one'), running, 'still the same running process');
    assert.match((t.plugins.info('one') as any).lifecycle.registrationError, /orrery-plugin\.json|JSON/);
    await t.plugins.stop('one');
    assert.equal((t.plugins.info('one') as any).lifecycle.registrationError, null);
    const failedFrames: boolean[] = [];
    const off = t.plugins.onState((frame) => {
      if (frame.id === 'one' && frame.runtime.state === 'failed') failedFrames.push(frame.enabled);
    });
    await t.plugins.startPlugin('one');
    off();
    assert.equal(failedFrames.at(-1), true, 'the live card sees the accepted start together with its failure');
    const runtime = (t.plugins.info('one') as any).runtime;
    assert.equal(runtime.state, 'failed');
    assert.equal(runtime.errorCode, 'START_FAILED');
    assert.match(runtime.error, /orrery-plugin\.json|JSON/);
    assert.equal(state(t.plugins, 'two'), 'ready');
    await sleep(150);
    assert.equal(state(t.plugins, 'one'), 'failed', 'not restarted automatically with the older registration');
    assert.deepEqual([(t.plugins.info('one') as any).lifecycle.lastFailure.errorCode, t.records.length], ['START_FAILED', 0]);
    // Removed from the file, or renamed: the id is no longer registered.
    s.register([{ id: 'two' }]);
    await t.plugins.restartPlugin('one');
    assert.match((t.plugins.info('one') as any).runtime.error, /no longer registers a plugin with id one/);
    writeFileSync(join(s.home, 'external-plugins.json'), '{');
    await t.plugins.restartPlugin('one');
    assert.match((t.plugins.info('one') as any).runtime.error, /external-plugins\.json cannot be read now/);
    s.register([{ id: 'one' }, { id: 'two' }]);
    writeManifest(s.folder('one'), 'one');
    await t.plugins.startPlugin('one');
    assert.equal(state(t.plugins, 'one'), 'ready');
    assert.equal(state(t.plugins, 'two'), 'ready');
  } finally { await t.close(); }
});

test('a start is refused for a plugin the environment disables and for a requirement that is not running', async () => {
  const s = setup([{ id: 'base' }, { id: 'needs', manifest: { requires: ['base'] } }]);
  const t = manager(s.home, ['base'], { startRefusal: (id) => (id === 'base' ? 'disabled by the variable' : null) });
  try {
    await t.plugins.start();
    await t.plugins.stop('base');
    await assert.rejects(t.plugins.startPlugin('base'), (e: any) => e.code === 'DISABLED_BY_ENV');
    await assert.rejects(t.plugins.startPlugin('needs'), (e: any) => e.code === 'DEPENDENCY_NOT_RUNNING' && /base/.test(e.message));
    assert.equal(state(t.plugins, 'needs'), 'disabled', 'a refusal changes nothing');
    await assert.rejects(t.plugins.startPlugin('nope'), (e: any) => e.code === 'UNKNOWN_PLUGIN');
  } finally { await t.close(); }
});

test('automatic restart: off by default; on, bounded to the backoff list within the window, then it stays failed', async () => {
  const s = setup([{ id: 'one' }]);
  const off = manager(s.home, ['one'], { backoffMs: [30] });
  try {
    await off.plugins.start();
    await assert.rejects(call(off.plugins, 'one', 'crash'));
    await sleep(150);
    assert.equal(state(off.plugins, 'one'), 'failed', 'off by default: no restart');
    assert.equal((off.plugins.info('one') as any).lifecycle.lastFailure.errorCode, 'PROCESS_EXITED');
  } finally { await off.close(); }

  const t = manager(s.home, ['one'], { backoffMs: [40, 80, 120], switches: { autoRestart: ['one'], devReload: [] } });
  try {
    await t.plugins.start();
    const pids = [await pid(t.plugins, 'one')];
    for (let n = 1; n <= 3; n++) {
      const failedAt = Date.now();
      await assert.rejects(call(t.plugins, 'one', 'crash'));
      const life = (t.plugins.info('one') as any).lifecycle;
      assert.equal(state(t.plugins, 'one'), 'failed');
      assert.ok(life.restartAt, 'a restart is planned');
      const wait = Date.parse(life.restartAt) - failedAt;
      assert.ok(wait >= [40, 80, 120][n - 1] - 5 && wait < [40, 80, 120][n - 1] + 1000, `backoff ${n}: ${wait} ms`);
      await waitFor(() => state(t.plugins, 'one') === 'ready', `restart ${n}`);
      pids.push(await pid(t.plugins, 'one'));
      assert.equal((t.plugins.info('one') as any).lifecycle.autoRestarts, n);
    }
    assert.equal(new Set(pids).size, 4, 'a new process each time');
    assert.deepEqual(t.records.map((r) => r.kind), ['restart', 'restart', 'restart']);
    assert.match(t.records[0].text, /^插件「插件one」出错停止（PROCESS_EXITED），Hub 正在自动重启它：10 分钟内第 1 次，最多 3 次。$/);
    await assert.rejects(call(t.plugins, 'one', 'crash'));
    await sleep(250);
    const life = (t.plugins.info('one') as any).lifecycle;
    assert.equal(state(t.plugins, 'one'), 'failed', 'the fourth failure in the window is left alone');
    assert.deepEqual([life.gaveUp, life.restartAt], [true, null]);
    assert.equal(t.records.at(-1)!.kind, 'gave-up');
    assert.match(t.records.at(-1)!.text, /10 分钟内已自动重启 3 次，Hub 不再自动重启它/);
    // The user's start is a fresh budget.
    await t.plugins.startPlugin('one');
    assert.equal(state(t.plugins, 'one'), 'ready');
    assert.deepEqual([(t.plugins.info('one') as any).lifecycle.gaveUp, (t.plugins.info('one') as any).lifecycle.autoRestarts], [false, 0]);
  } finally { await t.close(); }
});

test('the window slides but a total cap ends a recurring fault: across many windows it stops at the cap, until the user acts', async () => {
  const s = setup([{ id: 'one' }]);
  let now = Date.now();
  const t = manager(s.home, ['one'], { backoffMs: [20, 20, 20], restartWindowMs: 60_000, maxAutoRestartsTotal: 5, now: () => now,
    switches: { autoRestart: ['one'], devReload: [] } });
  try {
    await t.plugins.start();
    // One failure every 61 s (injected clock): never more than one restart per window, so only the total ends it.
    for (let n = 1; n <= 5; n++) {
      now += 61_000;
      await assert.rejects(call(t.plugins, 'one', 'crash'));
      await waitFor(() => state(t.plugins, 'one') === 'ready', `restart ${n}`);
      const life = (t.plugins.info('one') as any).lifecycle;
      assert.deepEqual([life.autoRestarts, life.autoRestartsTotal, life.maxAutoRestartsTotal], [1, n, 5], 'one in the window, n in total');
    }
    now += 61_000;
    await assert.rejects(call(t.plugins, 'one', 'crash'));
    await sleep(200);
    let life = (t.plugins.info('one') as any).lifecycle;
    assert.deepEqual([state(t.plugins, 'one'), life.gaveUp, life.gaveUpReason, life.restartAt], ['failed', true, 'total', null]);
    assert.deepEqual(t.records.map((r) => r.kind), ['restart', 'restart', 'restart', 'restart', 'restart', 'gave-up']);
    assert.match(t.records.at(-1)!.text, /自你上次启动它以来已自动重启 5 次（累计上限），Hub 不再自动重启它/);
    for (let more = 0; more < 3; more++) { now += 3_600_000; await sleep(30); }
    assert.equal(state(t.plugins, 'one'), 'failed', 'hours later still given up: a healthy run or time gives nothing back');
    // Switching automatic restart off and on, or the user's start, gives a new budget.
    t.plugins.setLifecycle('one', { autoRestart: false });
    t.plugins.setLifecycle('one', { autoRestart: true });
    life = (t.plugins.info('one') as any).lifecycle;
    assert.deepEqual([life.gaveUp, life.autoRestartsTotal], [false, 0]);
    await t.plugins.startPlugin('one');
    assert.equal(state(t.plugins, 'one'), 'ready');
  } finally { await t.close(); }
});
test('the user\'s stop never restarts automatically, also during the backoff; a CHECK_TIMEOUT stop does', async () => {
  const s = setup([{ id: 'one' }, { id: 'gate', behaviour: { check: 'hang' }, grant: { permissions: ['messages.gate'] } }]);
  const t = manager(s.home, ['one', 'gate'], { backoffMs: [150], switches: { autoRestart: ['one', 'gate'], devReload: [] } });
  try {
    await t.plugins.start();
    await t.plugins.stop('one');
    await sleep(300);
    assert.equal(state(t.plugins, 'one'), 'stopped');
    await t.plugins.startPlugin('one');
    await assert.rejects(call(t.plugins, 'one', 'crash'));
    assert.ok((t.plugins.info('one') as any).lifecycle.restartAt, 'planned');
    await t.plugins.stop('one');   // the user's stop during the backoff
    assert.equal((t.plugins.info('one') as any).lifecycle.restartAt, null);
    await sleep(350);
    assert.equal(state(t.plugins, 'one'), 'stopped', 'the planned restart was cancelled');

    // Three checks in a row unanswered: CHECK_TIMEOUT, a failure, so it is restarted.
    const gatePid = await pid(t.plugins, 'gate');
    const request = (n: number) => ({ checkId: `c-${n}`, clusterId: 'one', sender: { id: 'a', name: 'A' }, mentions: [], recipients: [], fyi: false,
      replyTo: null, attachments: 0, body: 'x' });
    const outcomes = await Promise.all([1, 2, 3].map((n) => t.plugins.checkMessage(request(n))!));
    for (const n of [1, 2, 3]) t.plugins.checkSettled(`c-${n}`, { stored: true, messageId: `m-${n}` });
    assert.ok(outcomes.flat().every((o) => o.verdict === 'failed'), 'fail-open');
    assert.equal((t.plugins.info('gate') as any).lifecycle.lastFailure.errorCode, 'CHECK_TIMEOUT');
    await waitFor(() => state(t.plugins, 'gate') === 'ready', 'the gate plugin restarted');
    assert.notEqual(await pid(t.plugins, 'gate'), gatePid);
    assert.ok(t.records.some((r) => r.pluginId === 'gate' && /CHECK_TIMEOUT/.test(r.text)));
  } finally { await t.close(); }
});

test('the shutdown grace: an answer within it is a clean stop, none is a kill at its end; the Hub close is bounded however many', async () => {
  const s = setup([
    { id: 'saver', behaviour: { shutdown: 'slow', slowMs: 400 } },
    { id: 'stuck', behaviour: { shutdown: 'never' }, manifest: { shutdownGraceMs: 300 } },
  ]);
  const t = manager(s.home, ['saver', 'stuck']);
  try {
    await t.plugins.start();
    assert.equal((t.plugins.info('stuck') as any).lifecycle.shutdownGraceMs, 300);
    assert.equal((t.plugins.info('saver') as any).lifecycle.shutdownGraceMs, 5000, 'the default');
    await t.plugins.stop('saver');
    assert.equal(readFileSync(join(s.folder('saver'), 'shutdown.txt'), 'utf8'), 'saved', 'it finished its work before the kill');
    assert.deepEqual([state(t.plugins, 'saver'), (t.plugins.info('saver') as any).runtime.errorCode], ['stopped', null]);
    const stuckPid = await pid(t.plugins, 'stuck');
    const started = Date.now();
    await t.plugins.stop('stuck');
    const took = Date.now() - started;
    assert.ok(took >= 280 && took < 1800, `killed after its grace: ${took} ms`);
    assert.equal(alive(stuckPid), false);
    assert.deepEqual([state(t.plugins, 'stuck'), (t.plugins.info('stuck') as any).runtime.errorCode], ['stopped', 'TIMEOUT']);
  } finally { await t.close(); }

  assert.throws(() => parseExternalManifest({ id: 'x', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', permissions: [], commands: [], shutdownGraceMs: 30_001 }), /shutdownGraceMs/);
  assert.throws(() => parseExternalManifest({ id: 'x', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', permissions: [], commands: [], shutdownGraceMs: 1.5 }), /shutdownGraceMs/);
  assert.throws(() => parseExternalManifest({ id: 'x', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', permissions: [], commands: [], shutdownGraceMs: '5000' }), /shutdownGraceMs/);

  // Five plugins that never answer, 600 ms grace each: closed together, not one after another.
  const many = setup(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, behaviour: { shutdown: 'never' }, manifest: { shutdownGraceMs: 600 } })));
  const m = manager(many.home, ['a', 'b', 'c', 'd', 'e']);
  await m.plugins.start();
  const started = Date.now();
  await m.close();
  const took = Date.now() - started;
  assert.ok(took < 2900, `bounded by the longest grace plus the exit wait (about 1.6 s), not their sum (3 s and more): ${took} ms`);
});

test('races: a double restart, a stop while starting, the Hub closing during a backoff or a restart', async () => {
  const s = setup([{ id: 'one' }, { id: 'slow', behaviour: { init: 600 } }]);
  const t = manager(s.home, ['one', 'slow'], { backoffMs: [200], switches: { autoRestart: ['one'], devReload: [] } });
  try {
    await t.plugins.start();
    const first = await pid(t.plugins, 'one');
    // Two restarts at once: the later one wins, and only its process runs.
    const instances = new Set<ExternalPluginProcess>();
    const off = t.plugins.onState(() => instances.add(current(t.plugins, 'one')));
    await Promise.all([t.plugins.restartPlugin('one'), t.plugins.restartPlugin('one')]);
    off();
    const live = [...instances].filter((p) => p.state === 'ready');
    assert.equal(live.length, 1, 'exactly one instance runs');
    assert.equal(live[0], current(t.plugins, 'one'));
    assert.equal(alive(first), false);

    // A stop while it is starting: stopped, and the late initialize answer does not revive it.
    const restarting = t.plugins.restartPlugin('slow');
    await waitFor(() => state(t.plugins, 'slow') === 'starting', 'starting');
    await t.plugins.stop('slow');
    await restarting;
    await sleep(800);
    assert.equal(state(t.plugins, 'slow'), 'stopped');
    assert.equal((t.plugins.info('slow') as any).runtime.errorCode, null, 'the user\'s stop is no failure');
    assert.equal((t.plugins.info('slow') as any).lifecycle.restartAt, null);
  } finally { await t.close(); }

  // The Hub closes during the backoff: the planned restart never happens.
  const c = manager(s.home, ['one'], { backoffMs: [200], switches: { autoRestart: ['one'], devReload: [] } });
  await c.plugins.start();
  await assert.rejects(call(c.plugins, 'one', 'crash'));
  const failed = current(c.plugins, 'one');
  await c.close();
  await sleep(350);
  assert.equal(current(c.plugins, 'one'), failed, 'no new instance after the close');
  await assert.rejects(c.plugins.startPlugin('one'), (e: any) => e.code === 'HUB_CLOSING');

  // The Hub closes during a restart that is waiting for the old process: nothing is started after it.
  const d = manager(s.home, ['slow']);
  await d.plugins.start();
  const restart = d.plugins.restartPlugin('slow');
  await d.close();
  await restart;
  assert.ok(['stopped', 'failed'].includes(state(d.plugins, 'slow')!));
  await sleep(700);
  assert.notEqual(state(d.plugins, 'slow'), 'ready');
});

test('identity: a late frame or callback of the old instance changes nothing after a restart', async () => {
  const s = setup([{ id: 'one', grant: { permissions: ['clusters.read'] } }]);
  const t = manager(s.home, ['one']);
  const runs: RunView[] = [];
  t.plugins.onRun((run) => runs.push(run));
  try {
    await t.plugins.start();
    const old = current(t.plugins, 'one') as unknown as { hostCall(m: string, p: unknown): unknown; hooks: Record<string, (...a: unknown[]) => void>; state: string };
    await t.plugins.restartPlugin('one');
    const fresh = current(t.plugins, 'one');
    assert.notEqual(fresh, old);
    // Even if the old instance looked ready again, its host calls are refused and its hooks reach nothing.
    old.state = 'ready';
    assert.throws(() => old.hostCall('host.clusters.list', {}), /replaced/);
    const run = t.plugins.runCommand('one', { pluginId: 'one', command: 'test', arguments: {} });
    await run;
    old.hooks.inactive();
    old.hooks.failed();
    old.hooks.notification('command.done', { runId: 'x', ok: true });
    assert.equal(state(t.plugins, 'one'), 'ready');
    assert.equal((t.plugins.info('one') as any).lifecycle.lastFailure, null, 'the old instance\'s failure is not this one\'s');
    old.state = 'stopped';
  } finally { await t.close(); }
});

test('restart during a command run, a pending gate check and a publish from the stopping plugin', async () => {
  const s = setup([
    { id: 'one', behaviour: { shutdown: 'publish' }, grant: { permissions: ['clusters.read', 'events.publish', 'messages.gate'] } },
    { id: 'listener', grant: { permissions: ['events.read'], events: ['plugin.*'] } },
  ]);
  const t = manager(s.home, ['one', 'listener']);
  const runs: RunView[] = [];
  t.plugins.onRun((run) => runs.push(run));
  try {
    await t.plugins.start();
    // A host call to the plugin that never answers is rejected by the restart, not left pending.
    const hang = t.plugins.invoke('one', { command: 'test', arguments: { action: 'hang' } }).catch((e) => e);
    // An allowed check settled only after the restart: the new instance never hears of it.
    const request = { checkId: 'c-1', clusterId: 'one', sender: { id: 'a', name: 'A' }, mentions: [], recipients: [], fyi: false, replyTo: null, attachments: 0, body: 'x' };
    const [outcome] = await t.plugins.checkMessage(request)!;
    assert.equal(outcome.verdict, 'allow');
    await t.plugins.restartPlugin('one');
    const interrupted = await hang;
    assert.ok(interrupted instanceof Error && 'code' in interrupted);
    assert.equal(interrupted.code, 'PLUGIN_NOT_RUNNING');
    assert.match(String(interrupted), /stopping/, 'ended at once when the shutdown began, not left to its timeout');
    t.plugins.checkSettled('c-1', { stored: true, messageId: 'm-1' });
    assert.deepEqual(await call(t.plugins, 'one', 'notes'), [], 'no message.check.result for a check of the old instance');
    // The plugin's publish while it was stopping was refused; nothing reached the listener.
    const answer = JSON.parse(readFileSync(join(s.folder('one'), 'shutdown.txt'), 'utf8'));
    assert.equal(answer.error.code, -32000);
    assert.deepEqual(await call(t.plugins, 'listener', 'notes'), [], 'no event from the stopping plugin');
    // Running again, its publish goes through: a fresh instance with the same grants.
    const published = await call(t.plugins, 'one', 'publish');
    assert.deepEqual(published.result, { published: true });

    // A check pending while the plugin restarts: fail-open (not_running), never a refusal.
    writeFileSync(join(s.folder('one'), 'behaviour.json'), JSON.stringify({ check: 'hang' }));
    await t.plugins.restartPlugin('one');
    const pending = t.plugins.checkMessage({ ...request, checkId: 'c-2' })!;
    await sleep(50);
    const restart = t.plugins.restartPlugin('one');
    const [late] = await pending;
    t.plugins.checkSettled('c-2', { stored: true, messageId: 'm-2' });
    await restart;
    assert.deepEqual([late.verdict, late.verdict === 'failed' && late.failure], ['failed', 'not_running']);
  } finally { await t.close(); }
});

test('a long command run ends as plugin_stopped when the plugin is restarted', async () => {
  const s = setup([{ id: 'one', manifest: { commands: [{ id: 'test', title: 'Test', longRunning: true }] } }]);
  writeFileSync(join(s.folder('one'), 'main.mjs'), script.replace("send({id:m.id,result:a});\n});", "send({id:m.id,result:{accepted:true}});\n});"));
  const t = manager(s.home, ['one']);
  const runs: RunView[] = [];
  t.plugins.onRun((run) => runs.push(run));
  try {
    await t.plugins.start();
    const run = await t.plugins.runCommand('one', { pluginId: 'one', command: 'test', arguments: {} });
    assert.equal(run.state, 'running');
    await t.plugins.restartPlugin('one');
    const end = runs.filter((r) => r.runId === run.runId).at(-1)!;
    assert.deepEqual([end.state, end.reason], ['failed', 'plugin_stopped']);
    assert.deepEqual(t.plugins.commands('one')!.runs, [], 'nothing left running');
  } finally { await t.close(); }
});

test('development reload: debounced, ignores node_modules and data, re-reads the manifest; watchers close on stop, switch-off and close', async () => {
  const s = setup([{ id: 'dev' }]);
  mkdirSync(join(s.folder('dev'), 'data'));
  mkdirSync(join(s.folder('dev'), 'node_modules'));
  const t = manager(s.home, ['dev'], { debounceMs: 150, switches: { autoRestart: [], devReload: ['dev'] } });
  try {
    await t.plugins.start();
    const first = await pid(t.plugins, 'dev');
    writeFileSync(join(s.folder('dev'), 'data', 'state.json'), '{}');
    writeFileSync(join(s.folder('dev'), 'node_modules', 'x.js'), '');
    await sleep(500);
    assert.equal(await pid(t.plugins, 'dev'), first, 'data/ and node_modules/ do not reload');
    writeManifest(s.folder('dev'), 'dev', { version: '1.1.0' });
    writeFileSync(join(s.folder('dev'), 'helper.mjs'), '// 1');
    writeFileSync(join(s.folder('dev'), 'helper.mjs'), '// 2');
    await replacedPid(t.plugins, 'dev', first, 'the reload');
    await waitFor(() => t.plugins.manifestOf('dev')!.version === '1.1.0', 'the manifest was read again');
    assert.equal(alive(first), false);
    // That a burst makes one reload is checked below with the fake watch: real fs.watch may deliver late duplicates.
  } finally { await t.close(); }

  // Watcher bookkeeping with a fake watch: every open is closed again, a pending debounce never fires after a close.
  const opened: { closed: boolean; fire: (file: string | null) => void }[] = [];
  const watch: DirectoryWatch = (_dir, changed) => {
    const w = { closed: false, fire: changed, close() { this.closed = true; } };
    opened.push(w);
    return w;
  };
  const f = manager(s.home, ['dev'], { debounceMs: 100, watch, switches: { autoRestart: [], devReload: [] } });
  try {
    await f.plugins.start();
    assert.equal(opened.length, 0, 'off by default');
    f.plugins.setLifecycle('dev', { devReload: true });
    assert.equal(opened.filter((w) => !w.closed).length, 1);
    await f.plugins.stop('dev');
    assert.equal(opened.filter((w) => !w.closed).length, 0, 'closed by the user\'s stop');
    await f.plugins.startPlugin('dev');
    assert.equal(opened.filter((w) => !w.closed).length, 1, 'open again with the start');
    f.plugins.setLifecycle('dev', { devReload: false });
    assert.equal(opened.filter((w) => !w.closed).length, 0, 'closed by the switch');
    f.plugins.setLifecycle('dev', { devReload: true });
    // A burst of saves within the debounce makes one reload.
    let starts = 0;
    const off = f.plugins.onState((frame) => { if (frame.runtime.state === 'starting') starts++; });
    const burst = await pid(f.plugins, 'dev');
    for (const file of ['orrery-plugin.json', 'helper.mjs', 'helper.mjs']) opened.at(-1)!.fire(file);
    await replacedPid(f.plugins, 'dev', burst, 'the burst reload');
    await sleep(300);
    off();
    assert.equal(starts, 1, 'one burst of saves, one reload');
    const before = await steadyPid(f.plugins, 'dev');
    opened.at(-1)!.fire('main.mjs');
    await f.plugins.close();
    assert.equal(opened.filter((w) => !w.closed).length, 0, 'closed by the Hub close');
    await sleep(250);
    assert.equal(alive(before), false);
    assert.equal(state(f.plugins, 'dev'), 'stopped', 'the debounce did not fire after the close');
  } finally { await f.close(); }
});

test('plugins.json keeps the switches next to the enable list; a damaged list is an error', () => {
  const home = tempDir();
  writePluginsFile(home, { autoRestart: ['a'] });
  writePluginsFile(home, { disabled: ['b'] });
  assert.deepEqual(readPluginsFile(home), { disabled: ['b'], enabled: [], autoRestart: ['a'], devReload: [], uiOff: [] });
  writePluginsFile(home, { autoRestart: [], devReload: ['c'], uiOff: ['d'] });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'plugins.json'), 'utf8')), { disabled: ['b'], devReload: ['c'], uiOff: ['d'] }, 'empty optional lists are left out');
  writePluginsFile(home, { uiOff: [] });
  assert.deepEqual(readPluginsFile(home), { disabled: ['b'], enabled: [], autoRestart: [], devReload: ['c'], uiOff: [] });
  writeFileSync(join(home, 'plugins.json'), '{"disabled":[],"autoRestart":"a"}');
  assert.throws(() => readPluginsFile(home), /must look like/);
});

// ---- through the Hub: routes, user only, persistence, records, the gate end to end ----

/** A send_message over MCP as the native mock member whose conversation is `session` (the bridge secret). */
async function mcpSend(app: Awaited<ReturnType<typeof startTestHub>>, session: string, body: string) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret,
      'x-orrery-session': session, 'x-orrery-harness': 'mock' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body } } }),
  });
  const { result } = await res.json();
  return { isError: result.isError === true, text: result.content[0].text as string };
}

function seedCluster(dir: string, names: string[]) {
  const seed = new Store(join(dir, 'test.db'));
  seed.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, names.map((name) => ({ id: `one-${name}`, clusterId: 'one', name,
    avatar: null, harness: 'mock', model: null, effort: null, workerSessionId: `one-${name}`, cwd: dir, origin: 'attached' as const, removedAt: null })));
  seed.close();
}

test('HTTP: the user alone starts, stops and restarts; stable codes; the switches persist; no plugin method for it', async () => {
  const s = setup([{ id: 'one' }, { id: 'env' }]);
  seedCluster(s.dir, ['A']);
  const app = await startTestHub({ dir: s.dir, disabledPlugins: ['env'] });
  const answer = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await rawFetch(app.url + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}`, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const row = async (id: string) => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === id);
    assert.equal((await row('one')).runtime.state, 'ready');
    // No token, the bridge secret or another token instead of it: refused before anything else.
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    for (const authorization of [undefined, `Bearer ${secret}`, 'Bearer not-the-token']) {
      const res = await rawFetch(`${app.url}/api/plugins/one/restart`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: '{}' });
      assert.equal(res.status, 401);
    }
    assert.equal((await row('one')).runtime.state, 'ready', 'nothing was restarted');
    // The plugin protocol has no lifecycle method: a plugin cannot restart itself or another one.
    for (const method of ['host.plugins.restart', 'host.plugins.stop', 'host.plugins.start']) {
      const viaPlugin = (await app.api('POST', '/api/plugins/one/invoke', { command: 'test', arguments: { action: 'host', method, params: { id: 'env' } } })).result;
      assert.equal(viaPlugin.error.code, -32000, method);
    }
    // Stable codes: the plugin, then the body, then the state.
    assert.deepEqual(await answer('POST', '/api/plugins/nope/start', {}), { status: 404, body: { error: 'unknown external plugin', code: 'UNKNOWN_PLUGIN' } });
    for (const bad of [[], { now: true }, '"x"']) {
      const res = await answer('POST', '/api/plugins/one/restart', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      if (typeof bad !== 'string') assert.equal(res.body.code, 'INVALID_REQUEST');
    }
    for (const bad of [{}, [], { autoRestart: 'yes' }, { autoRestart: true, extra: 1 }, { devReload: null }]) {
      const res = await answer('PATCH', '/api/plugins/one/lifecycle', bad);
      assert.deepEqual([res.status, res.body.code], [400, 'INVALID_REQUEST'], JSON.stringify(bad));
    }
    const refused = await answer('POST', '/api/plugins/env/start', {});
    assert.deepEqual([refused.status, refused.body.code], [409, 'DISABLED_BY_ENV']);
    // The happy paths answer the list.
    const pidOf = async () => (await app.api('POST', '/api/plugins/one/invoke', { command: 'test', arguments: { action: 'pid' } })).result;
    const before = await pidOf();
    const restarted = await app.api('POST', '/api/plugins/one/restart', {});
    assert.equal(restarted.installed.find((p: any) => p.id === 'one').runtime.state, 'ready');
    assert.notEqual(await pidOf(), before);
    assert.equal((await app.api('POST', '/api/plugins/one/stop', {})).installed.find((p: any) => p.id === 'one').runtime.state, 'stopped');
    assert.ok(!(await app.api('GET', '/api/plugins')).plugins.some((p: any) => p.id === 'one'));
    const notRunning = await answer('POST', '/api/plugins/one/invoke', { command: 'test', arguments: { action: 'pid' } });
    assert.deepEqual([notRunning.status, notRunning.body.code], [409, 'PLUGIN_NOT_RUNNING'], 'a stable, retryable code');
    assert.match(notRunning.body.error, /plugin is stopped/);
    assert.equal((await app.api('POST', '/api/plugins/one/start', {})).installed.find((p: any) => p.id === 'one').runtime.state, 'ready');
    assert.ok((await app.api('GET', '/api/plugins')).plugins.some((p: any) => p.id === 'one'), 'listed as running again');
    const switched = await app.api('PATCH', '/api/plugins/one/lifecycle', { autoRestart: true });
    assert.equal(switched.installed.find((p: any) => p.id === 'one').lifecycle.autoRestart, true);
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, 'plugins.json'), 'utf8')), { disabled: [], autoRestart: ['one'] });
    await app.api('PUT', '/api/plugins/one', { enabled: false });
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, 'plugins.json'), 'utf8')), { disabled: ['one'], autoRestart: ['one'] }, 'the enable switch keeps the others');
  } finally { await app.close(); }
  // Read back at the next start.
  const again = await startTestHub({ dir: s.dir });
  try {
    const row = (await again.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'one');
    assert.deepEqual([row.runtime.state, row.lifecycle.autoRestart, row.lifecycle.devReload], ['disabled', true, false]);
  } finally { await again.close(); }
});

test('Hub: a flapping plugin leaves rate-limited restart records; a stopped gate plugin, started again, checks messages again', async () => {
  const s = setup([{ id: 'gate', behaviour: { check: 'refuse' }, grant: { permissions: ['messages.gate'], clusterIds: ['one'] } }]);
  seedCluster(s.dir, ['A', 'B']);
  const app = await startTestHub({ dir: s.dir, pluginLifecycle: { backoffMs: [50, 100, 150] } });
  const records = () => app.store.listMessages('one', 200).filter((m) => m.systemKind === 'plugin_restarted');
  try {
    assert.match((await mcpSend(app, 'one-A', '@B first')).text, /^REFUSED_BY_PLUGIN/);
    // Stopped by the user: not asked, no record, the message goes through.
    await app.api('POST', '/api/plugins/gate/stop', {});
    assert.equal((await mcpSend(app, 'one-A', '@B while stopped')).isError, false);
    assert.equal(app.store.listMessages('one', 200).filter((m) => m.systemKind === 'plugin_check_failed').length, 0);
    // Started again: a fresh process, which checks (and refuses) again.
    await app.api('POST', '/api/plugins/gate/start', {});
    assert.match((await mcpSend(app, 'one-A', '@B after the start')).text, /^REFUSED_BY_PLUGIN/);

    // Flapping: two crashes a few ms apart restart it twice, and the user sees one record (the second counted).
    await app.api('PATCH', '/api/plugins/gate/lifecycle', { autoRestart: true });
    const crash = () => app.api('POST', '/api/plugins/gate/invoke', { command: 'test', arguments: { action: 'crash' } }).catch(() => {});
    const ready = () => waitFor(async () => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'gate').runtime.state === 'ready', 'ready');
    await crash(); await ready();
    await crash(); await ready();
    const written = records();
    assert.equal(written.length, 1, written.map((m) => m.body).join('\n'));
    assert.match(written[0].body, /插件「插件gate」出错停止（PROCESS_EXITED），Hub 正在自动重启它：10 分钟内第 1 次，最多 3 次。/);
    assert.deepEqual(written[0].mentions, []);
    const row = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'gate');
    assert.equal(row.lifecycle.autoRestarts, 2);
    assert.equal(row.lifecycle.lastFailure.errorCode, 'PROCESS_EXITED');
    assert.match((await mcpSend(app, 'one-A', '@B after the restarts')).text, /^REFUSED_BY_PLUGIN/, 'checking again after the automatic restart');
  } finally { await app.close(); }
});


// ---- review fixes: exit during the grace, reload loops, switches, exit evidence, close bound, aging, guards ----

test('saving a switch keeps the switches of plugins not registered in this run', () => {
  const s = setup([{ id: 'one' }]);
  const saved: unknown[] = [];
  const t = manager(s.home, ['one'], { switches: { autoRestart: ['ghost', 'one'], devReload: ['ghost'] }, saveSwitches: (next) => saved.push(next) });
  try {
    t.plugins.setLifecycle('one', { autoRestart: false });
    assert.deepEqual(saved.at(-1), { autoRestart: ['ghost'], devReload: ['ghost'], uiOff: [] });
    t.plugins.setLifecycle('one', { devReload: true });
    assert.deepEqual(saved.at(-1), { autoRestart: ['ghost'], devReload: ['ghost', 'one'], uiOff: [] });
    t.plugins.setLifecycle('one', { ui: false });
    assert.deepEqual(saved.at(-1), { autoRestart: ['ghost'], devReload: ['ghost', 'one'], uiOff: ['one'] });
  } finally { void t.close(); }
});

test('the Hub close caps every grace, also a long stop already under way, below the launcher\'s wait', async () => {
  assert.ok(START_TIMEOUT_MS > DEFAULT_CALL_TIMEOUT_MS + HUB_CLOSE_PLUGIN_GRACE_MS + EXIT_WAIT_MS + 2000,
    'a stopping Hub (initialize wait, capped grace, exit wait) is gone before the launcher gives up on it');
  assert.match(readFileSync(join(REPO_ROOT, 'src', 'main.ts'), 'utf8'), /closeGraceMs: HUB_CLOSE_PLUGIN_GRACE_MS/, 'the composition root applies the cap');
  const s = setup([{ id: 'slow', behaviour: { shutdown: 'never' }, manifest: { shutdownGraceMs: 30_000 } }]);
  const t = manager(s.home, ['slow'], { closeGraceMs: 300 });
  await t.plugins.start();
  const stopping = t.plugins.stop('slow');   // the user's stop, waiting up to 30 s
  await sleep(50);
  const started = Date.now();
  await t.close();
  await stopping;
  const took = Date.now() - started;
  assert.ok(took < 300 + EXIT_WAIT_MS + 900, `capped: ${took} ms`);
});

test('the automatic-restart count on the card goes down when a restart leaves the window (a frame says so)', async () => {
  const s = setup([{ id: 'one' }]);
  // The window is measured on an injected clock that only moves when the test says: however slowly the plugin starts
  // on a busy machine, the restart is still inside the window until the test moves the clock past it.
  let now = Date.now();
  const t = manager(s.home, ['one'], { backoffMs: [20], restartWindowMs: 400, now: () => now, switches: { autoRestart: ['one'], devReload: [] } });
  const frames: { state: string; count: number }[] = [];
  t.plugins.onState((frame) => frames.push({ state: frame.runtime.state, count: frame.lifecycle.autoRestarts }));
  try {
    await t.plugins.start();
    await assert.rejects(call(t.plugins, 'one', 'crash'));
    await waitFor(() => state(t.plugins, 'one') === 'ready', 'restarted');
    assert.equal((t.plugins.info('one') as any).lifecycle.autoRestarts, 1);
    await sleep(500);   // the timer for the window has fired on the real clock: the restart is not aged yet on this one
    assert.equal(frames.at(-1)!.count, 1, 'no frame with a count that did not go down');
    const before = frames.length;
    now += 401;
    // Nothing else happens to the plugin now: the next frame is the timer's, with the aged count.
    await waitFor(() => frames.length > before, 'a frame with the aged count');
    assert.deepEqual(frames.slice(before), [{ state: 'ready', count: 0 }]);
  } finally { await t.close(); }
});

const messageEvent = (id: string): HubEvent => ({ seq: 1, clusterId: 'one', memberId: null, kind: 'message', createdAt: '2026-01-02T00:00:00.000Z',
  payload: { message: { id, clusterId: 'one', from: 'a', mentions: [], body: 'b', replyTo: null, chainId: id, hop: 0, createdAt: '2026-01-02T00:00:00.000Z' } } });
const checkRequest = (checkId: string) => ({ checkId, clusterId: 'one', sender: { id: 'a', name: 'A' }, mentions: [], recipients: [], fyi: false,
  replyTo: null, attachments: 0, body: 'x' });

test('a check of the old instance: the new one gets neither its checkId in message.created nor its result', async () => {
  const s = setup([{ id: 'gate', manifest: { events: ['message.created', 'plugin.*'] },
    grant: { permissions: ['messages.gate', 'events.read'], events: ['message.created'] } }]);
  const t = manager(s.home, ['gate']);
  try {
    await t.plugins.start();
    // Control: without a restart the asked instance gets the checkId (so the test below can see it if it leaks).
    assert.equal((await t.plugins.checkMessage(checkRequest('c-0'))!)[0].verdict, 'allow');
    t.plugins.checkStoring('c-0', 'm-0');
    t.plugins.publish(messageEvent('m-0'));
    t.plugins.checkSettled('c-0', { stored: true, messageId: 'm-0' });
    assert.equal((await call(t.plugins, 'gate', 'events')).at(-1).data.checkId, 'c-0');

    assert.equal((await t.plugins.checkMessage(checkRequest('c-1'))!)[0].verdict, 'allow');
    const old = current(t.plugins, 'gate') as any;
    await t.plugins.restartPlugin('gate');
    t.plugins.checkStoring('c-1', 'm-1');
    t.plugins.publish(messageEvent('m-1'));
    const seen = await call(t.plugins, 'gate', 'events');
    assert.equal(seen.at(-1).data.messageId, 'm-1');
    assert.equal(seen.at(-1).data.checkId, undefined, 'no checkId for the new instance');
    // checkSettled's own guard: even an old instance that claimed to be ready gets nothing queued.
    old.state = 'ready';
    t.plugins.checkSettled('c-1', { stored: true, messageId: 'm-1' });
    assert.equal(old.events.length, 0, 'nothing queued on the old instance');
    old.state = 'stopped';
    assert.ok(!(await call(t.plugins, 'gate', 'notes')).includes('message.check.result'));
  } finally { await t.close(); }
});

// ---- second review: gave-up holds, reload caps are a total bound, saves during a launch, exits during shutdown,
// ---- the STOP_TIMEOUT path through the real close, registrationError transitions ----

/** A fake watch: each open watcher can be fired by hand. */
function fakeWatch() {
  const opened: { closed: boolean; fire: (file: string | null) => void }[] = [];
  const watch: DirectoryWatch = (_dir, changed) => {
    const w = { closed: false, fire: changed, close() { this.closed = true; } };
    opened.push(w);
    return w;
  };
  return { watch, open: () => opened.filter((w) => !w.closed), fire: (file: string | null) => opened.filter((w) => !w.closed).forEach((w) => w.fire(file)) };
}

test('a plugin that exits on shutdown stops at once and cleanly; one that crashes stops at once and the card keeps a note', async () => {
  const s = setup([{ id: 'exits', behaviour: { shutdown: 'exit' } }, { id: 'crashes', behaviour: { shutdown: 'crash' } }]);
  const t = manager(s.home, ['exits', 'crashes']);
  try {
    await t.plugins.start();
    for (const id of ['exits', 'crashes']) {
      const started = Date.now();
      await t.plugins.stop(id);
      const took = Date.now() - started;
      assert.ok(took < 2000, `${id}: the exit ends the 5 s grace at once (${took} ms)`);
      const runtime = (t.plugins.info(id) as any).runtime;
      assert.deepEqual([runtime.state, runtime.errorCode, runtime.error], ['stopped', null, null], id);
    }
    assert.equal((t.plugins.info('exits') as any).lifecycle.lastFailure, null, 'exit code 0 is a clean stop');
    const note = (t.plugins.info('crashes') as any).lifecycle.lastFailure;
    assert.equal(note.errorCode, 'PROCESS_EXITED');
    assert.match(note.error, /exited with code 1 during shutdown/, 'its shutdown work may be incomplete: the card says so');
    await t.plugins.startPlugin('exits');
    const started = Date.now();
    await t.plugins.restartPlugin('exits');
    assert.ok(Date.now() - started < 2500);
    assert.equal(state(t.plugins, 'exits'), 'ready');
  } finally { await t.close(); }
});

test('after giving up, a reload may start the plugin but its failures never restart it again, across several windows', async () => {
  const s = setup([{ id: 'down', behaviour: { afterReady: 'crash' } }]);
  const w = fakeWatch();
  // An injected clock: the three restarts fall inside the window however slowly each process starts, and the window
  // passes only when the test moves the clock.
  let now = Date.now();
  const t = manager(s.home, ['down'], { backoffMs: [20, 20, 20], restartWindowMs: 1500, debounceMs: 20, watch: w.watch, now: () => now,
    switches: { autoRestart: ['down'], devReload: ['down'] } });
  // Starts are counted as changes into 'starting': another frame while it starts (the count on the card going down
  // as the clock passes the window) is no new start.
  let starts = 0;
  let last = '';
  t.plugins.onState((frame) => {
    if (frame.runtime.state === 'starting' && last !== 'starting') starts++;
    last = frame.runtime.state;
  });
  try {
    await t.plugins.start();
    await waitFor(() => (t.plugins.info('down') as any).lifecycle.gaveUp && state(t.plugins, 'down') === 'failed', 'gave up', 10_000);
    assert.deepEqual(t.records.map((r) => r.kind), ['restart', 'restart', 'restart', 'gave-up']);
    for (let round = 1; round <= 3; round++) {
      now += 1700;   // the restart window (1.5 s) has passed again
      const before = starts;
      w.fire('main.mjs');   // the developer saves: a reload starts it
      await waitFor(() => starts > before && state(t.plugins, 'down') === 'failed', `reload ${round} ran and failed`);
      await sleep(200);
      assert.equal(starts, before + 1, `round ${round}: the reload only, no automatic restart after it`);
    }
    assert.deepEqual(t.records.map((r) => r.kind), ['restart', 'restart', 'restart', 'gave-up'], 'no new restart or gave-up record');
    assert.equal((t.plugins.info('down') as any).lifecycle.gaveUp, true);
    writeFileSync(join(s.folder('down'), 'behaviour.json'), '{}');
    await t.plugins.startPlugin('down');
    assert.deepEqual([(t.plugins.info('down') as any).lifecycle.gaveUp, state(t.plugins, 'down')], [false, 'ready'], 'only the user clears it');
  } finally { await t.close(); }
});

test('reload triggers: only source files, the manifest and package.json; a change with no file name counts', async () => {
  const s = setup([{ id: 'dev' }]);
  const w = fakeWatch();
  // Six quick reloads in a row would be a short-lived streak: raise it, this test is about what triggers.
  const t = manager(s.home, ['dev'], { debounceMs: 20, devReloadShortStreak: 100, watch: w.watch, switches: { autoRestart: [], devReload: ['dev'] } });
  try {
    await t.plugins.start();
    let pidNow = await pid(t.plugins, 'dev');
    for (const file of ['log.txt', 'notes.md', 'image.png', join('data', 'state.json'), join('node_modules', 'x', 'index.js'), 'debug.log']) {
      w.fire(file);
      await sleep(80);
      assert.equal(await pid(t.plugins, 'dev'), pidNow, `${file} does not reload`);
    }
    for (const file of ['main.mjs', join('lib', 'util.ts'), 'orrery-plugin.json', 'package.json', 'a.cjs', null]) {
      w.fire(file);
      pidNow = await replacedPid(t.plugins, 'dev', pidNow, `${file} reloads`);
    }
  } finally { await t.close(); }
});

test('reload caps are a total bound: a plugin that rewrites its source soon after each start is paused; a developer is not', async () => {
  // Slow writer: one source write 150 ms after each start, far under the per-minute rate cap; the short-lived streak stops it.
  const s = setup([{ id: 'writer', behaviour: { afterReady: 'srcwrite', writeDelay: 150 } }]);
  const t = manager(s.home, ['writer'], { debounceMs: 30, devReloadMax: 1000, devReloadShortMs: 5000, devReloadShortStreak: 3,
    switches: { autoRestart: [], devReload: ['writer'] } });
  let starts = 0;
  t.plugins.onState((frame) => { if (frame.runtime.state === 'starting') starts++; });
  try {
    await t.plugins.start();
    await waitFor(() => (t.plugins.info('writer') as any).lifecycle.reloadPaused, 'paused', 15_000);
    const paused = starts;
    await sleep(1000);
    assert.equal(starts, paused, 'nothing more after the pause');
    assert.ok(starts <= 1 + 3, `${starts} starts`);
  } finally { await t.close(); }

  // A developer: saves with long-lived instances in between (injected time) never builds a streak; the total cap still holds.
  const d = setup([{ id: 'dev' }]);
  const w = fakeWatch();
  let now = Date.now();
  const u = manager(d.home, ['dev'], { debounceMs: 20, now: () => now, devReloadShortMs: 30_000, devReloadShortStreak: 2, devReloadTotal: 4,
    watch: w.watch, switches: { autoRestart: [], devReload: ['dev'] } });
  try {
    await u.plugins.start();
    for (let save = 1; save <= 4; save++) {
      now += 60_000;   // the instance ran a minute before this save
      const before = await steadyPid(u.plugins, 'dev');
      w.fire('main.mjs');
      await replacedPid(u.plugins, 'dev', before, `save ${save}`);
      assert.equal((u.plugins.info('dev') as any).lifecycle.reloadPaused, false);
    }
    now += 60_000;
    w.fire('main.mjs');
    await waitFor(() => (u.plugins.info('dev') as any).lifecycle.reloadPaused, 'the total cap (4) pauses the fifth');
    await u.plugins.startPlugin('dev');
    await u.plugins.restartPlugin('dev');
    assert.equal((u.plugins.info('dev') as any).lifecycle.reloadPaused, false, 'the user\'s restart resumes');
  } finally { await u.close(); }
});

test('development reload cannot loop: windows shortened and spanned several times, a self-writing crasher stays bounded', async () => {
  const s = setup([{ id: 'loop', behaviour: { afterReady: 'srccrash' } }]);
  const t = manager(s.home, ['loop'], { debounceMs: 30, backoffMs: [30, 30, 30], restartWindowMs: 20_000, devReloadMax: 3, devReloadWindowMs: 300,
    switches: { autoRestart: ['loop'], devReload: ['loop'] } });
  let starts = 0;
  t.plugins.onState((frame) => { if (frame.id === 'loop' && frame.runtime.state === 'starting') starts++; });
  try {
    await t.plugins.start();
    await waitFor(() => (t.plugins.info('loop') as any).lifecycle.reloadPaused, 'reloading paused', 15_000);
    await waitFor(() => state(t.plugins, 'loop') === 'failed' && !(t.plugins.info('loop') as any).lifecycle.restartAt, 'settled', 15_000);
    const settled = starts;
    await sleep(2000);   // several reload windows (300 ms each)
    assert.equal(starts, settled, 'no more starts once paused and given up, however many windows pass');
    assert.ok(starts <= 1 + 3 + 5, `bounded: ${starts} starts`);
    assert.deepEqual([(t.plugins.info('loop') as any).lifecycle.gaveUp, (t.plugins.info('loop') as any).lifecycle.reloadPaused], [true, true]);
    writeFileSync(join(s.folder('loop'), 'behaviour.json'), '{}');
    await t.plugins.startPlugin('loop');
    const after = (t.plugins.info('loop') as any).lifecycle;
    assert.deepEqual([after.gaveUp, after.reloadPaused, state(t.plugins, 'loop')], [false, false, 'ready']);
  } finally { await t.close(); }
});

test('a manifest saved during the shutdown grace of a reload is not lost: one more reload once it settles', async () => {
  const s = setup([{ id: 'dev', behaviour: { shutdown: 'slow', slowMs: 500 } }]);
  const w = fakeWatch();
  const t = manager(s.home, ['dev'], { debounceMs: 20, watch: w.watch, switches: { autoRestart: [], devReload: ['dev'] } });
  try {
    await t.plugins.start();
    writeManifest(s.folder('dev'), 'dev', { version: '2.0.0' });
    w.fire('orrery-plugin.json');
    await waitFor(() => state(t.plugins, 'dev') === 'stopping', 'the reload is in its grace');
    writeManifest(s.folder('dev'), 'dev', { version: '3.0.0' });
    w.fire('orrery-plugin.json');   // ignored for now, remembered
    await waitFor(() => t.plugins.manifestOf('dev')!.version === '3.0.0' && state(t.plugins, 'dev') === 'ready', 'the remembered change reloaded', 10_000);
  } finally { await t.close(); }
});

test('registrationError: kept across an automatic relaunch from memory, cleared when the plugin is not running it', async () => {
  const s = setup([{ id: 'one' }]);
  const t = manager(s.home, ['one'], { backoffMs: [20], switches: { autoRestart: ['one'], devReload: [] } });
  const note = () => (t.plugins.info('one') as any).lifecycle.registrationError;
  try {
    await t.plugins.start();
    writeFileSync(join(s.folder('one'), 'orrery-plugin.json'), '{ broken');
    await assert.rejects(t.plugins.restartPlugin('one'), (e: any) => e.code === 'REGISTRATION_INVALID');
    assert.ok(note());
    // Crash with automatic restart on: relaunched from memory, i.e. still the older registration: the note stays.
    await assert.rejects(call(t.plugins, 'one', 'crash'));
    await waitFor(() => state(t.plugins, 'one') === 'ready', 'relaunched');
    assert.ok(note(), 'still running the older registration');
    // Crash with automatic restart off: not running anything, so no note.
    t.plugins.setLifecycle('one', { autoRestart: false });
    await assert.rejects(call(t.plugins, 'one', 'crash'));
    assert.deepEqual([state(t.plugins, 'one'), note()], ['failed', null]);
    // A start with the file still bad: START_FAILED, no note.
    await t.plugins.startPlugin('one');
    assert.deepEqual([(t.plugins.info('one') as any).runtime.errorCode, note()], ['START_FAILED', null]);
    // Fixed: running the registration on disk, no note.
    writeManifest(s.folder('one'), 'one');
    await t.plugins.startPlugin('one');
    assert.deepEqual([state(t.plugins, 'one'), note()], ['ready', null]);
    // Cancelling a planned automatic restart (the switch off during the backoff) also clears it.
    writeFileSync(join(s.folder('one'), 'orrery-plugin.json'), '{ broken');
    await assert.rejects(t.plugins.restartPlugin('one'), (e: any) => e.code === 'REGISTRATION_INVALID');
    t.plugins.setLifecycle('one', { autoRestart: true });
    await assert.rejects(call(t.plugins, 'one', 'crash'));
    assert.ok((t.plugins.info('one') as any).lifecycle.restartAt && note());
    t.plugins.setLifecycle('one', { autoRestart: false });
    assert.deepEqual([state(t.plugins, 'one'), note()], ['failed', null]);
  } finally { await t.close(); }
});

/**
 * A stand-in child process for the REAL ExternalPluginProcess close path: it answers initialize and shutdown, ignores
 * the kill (so its exit is unseen until the test emits it), and can send a bad frame.
 */
function fakeChildren() {
  const made: { child: any; garbage(): void; exit(code: number): void }[] = [];
  const spawn = () => {
    const child: any = new EventEmitter();
    child.pid = 900_000 + made.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = 0;
    child.kill = () => { child.kills++; return true; };   // unkillable: no 'exit' follows
    let buffer = '';
    child.stdin = new Writable({ write(chunk, _enc, done) {
      buffer += chunk.toString();
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        const reply = (result: unknown) => { if (!child.stdout.destroyed) child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'); };
        if (m.method === 'initialize') reply({ apiVersion: 1 });
        else if (m.method === 'shutdown') reply({});
        else if (m.id !== undefined) reply(child.pid);
      }
      done();
    } });
    made.push({ child, garbage: () => child.stdout.write('not json\n'), exit: (code) => child.emit('exit', code, null) });
    return child;
  };
  return { spawn, made };
}

test('STOP_TIMEOUT through the real close: no second process, a refused start changes nothing, the late exit frees it', async () => {
  const s = setup([{ id: 'one' }]);
  const kids = fakeChildren();
  const w = fakeWatch();
  const t = manager(s.home, ['one'], { spawn: kids.spawn, backoffMs: [30], watch: w.watch, switches: { autoRestart: ['one'], devReload: ['one'] } });
  const frames: string[] = [];
  t.plugins.onState((frame) => frames.push(frame.runtime.state));
  try {
    await t.plugins.start();
    assert.equal(state(t.plugins, 'one'), 'ready');
    await t.plugins.stop('one');   // real close: shutdown answered, kill ignored, exit never seen within 1 s
    let info = t.plugins.info('one') as any;
    assert.deepEqual([info.runtime.state, info.runtime.errorCode, info.lifecycle.lastFailure.errorCode], ['failed', 'STOP_TIMEOUT', 'STOP_TIMEOUT']);
    assert.equal(kids.made[0].child.kills, 1);
    // A start is refused, and leaves the slot as it was: not wanted, no watcher armed, no second child.
    await assert.rejects(t.plugins.startPlugin('one'), (e: any) => e.code === 'STOP_TIMEOUT');
    info = t.plugins.info('one') as any;
    assert.deepEqual([info.enabled, w.open().length, kids.made.length], [false, 0, 1]);
    // The exit is finally seen: the card hears of it and the plugin can start.
    kids.made[0].exit(0);
    assert.equal(frames.at(-1), 'stopped');
    assert.equal(state(t.plugins, 'one'), 'stopped');
    await t.plugins.startPlugin('one');
    assert.deepEqual([state(t.plugins, 'one'), kids.made.length, w.open().length], ['ready', 2, 1]);
    // An automatic restart refused for an unseen exit: no budget used, no record, no process.
    kids.made[1].garbage();   // a protocol error: failed, killed (ignored), exit unseen
    await waitFor(() => (t.plugins.info('one') as any).lifecycle.lastFailure?.errorCode === 'STOP_TIMEOUT', 'the restart attempt refused', 5000);
    info = t.plugins.info('one') as any;
    assert.deepEqual([info.lifecycle.autoRestarts, t.records.length, kids.made.length, info.runtime.state], [0, 0, 2, 'failed']);
    kids.made[1].exit(0);
  } finally { await t.close(); }
});

// ---- review round 1: shutdown's own wait, the gate during a restart, dependencies from the manifest just read ----

test('shutdown has its own wait: a request already out ends at once, its timer cannot cut the grace, its late answer is dropped', async () => {
  // The reviewer's control: grace 2000 ms, saving takes 1300 ms, an ordinary call times out after 800 ms.
  const s = setup([{ id: 'saver', behaviour: { shutdown: 'slow', slowMs: 1300 }, manifest: { shutdownGraceMs: 2000 } }]);
  const t = manager(s.home, ['saver'], {}, 800);
  const saved = join(s.folder('saver'), 'shutdown.txt');
  const stopTimed = async () => { const started = Date.now(); await t.plugins.stop('saver'); return Date.now() - started; };
  try {
    await t.plugins.start();
    // No request in flight: a clean finish after the saving.
    let took = await stopTimed();
    // The lower bound is the point (the saving was not cut short); the upper one only rules out waiting for the full
    // grace and the kill, which errorCode null and the saved file also prove.
    assert.ok(took >= 1250 && took < 3000, `clean finish: ${took} ms`);
    assert.deepEqual([state(t.plugins, 'saver'), (t.plugins.info('saver') as any).runtime.errorCode, readFileSync(saved, 'utf8')], ['stopped', null, 'saved']);
    // One command in flight: it ends for its caller when the shutdown begins, and the grace runs its full length.
    writeFileSync(saved, '');
    await t.plugins.startPlugin('saver');
    const runs: RunView[] = [];
    t.plugins.onRun((run) => runs.push(run));
    const hung = t.plugins.invoke('saver', { command: 'test', arguments: { action: 'hang' } }).then(() => 'answered', (e) => ({ error: String(e), at: Date.now() }));
    const late = t.plugins.invoke('saver', { command: 'test', arguments: { action: 'late', ms: 300 } }).then(() => 'answered', (e) => String(e));
    const started = Date.now();
    took = await stopTimed();
    const ended = await hung as { error: string; at: number };
    assert.match(ended.error, /stopping/);
    assert.ok(ended.at - started < 600, `the caller is told at once, not at its 800 ms timeout (${ended.at - started} ms)`);
    assert.match(String(await late), /stopping/, 'its answer at 300 ms came during the grace and was dropped, not a protocol error');
    assert.ok(took >= 1250 && took < 3000, `the 800 ms call timeout did not cut the 2000 ms grace: ${took} ms`);
    const runtime = (t.plugins.info('saver') as any).runtime;
    assert.deepEqual([runtime.state, runtime.errorCode, runtime.error], ['stopped', null, null], 'no TIMEOUT, no PROTOCOL_ERROR');
    assert.equal(readFileSync(saved, 'utf8'), 'saved', 'the shutdown work finished');
  } finally { await t.close(); }
});

test('a check in flight when a stop begins is fail-open (not_running) at once, not after its 1.5 s', async () => {
  const s = setup([{ id: 'gate', behaviour: { check: 'hang', shutdown: 'slow', slowMs: 600 }, grant: { permissions: ['messages.gate'] } }]);
  const t = manager(s.home, ['gate']);
  try {
    await t.plugins.start();
    const pending = t.plugins.checkMessage({ checkId: 'c', clusterId: 'one', sender: { id: 'a', name: 'A' }, mentions: [], recipients: [], fyi: false, replyTo: null, attachments: 0, body: 'x' })!;
    await sleep(30);
    const started = Date.now();
    const restart = t.plugins.restartPlugin('gate');
    const [outcome] = await pending;
    assert.ok(Date.now() - started < 1000, 'settled when the shutdown began, not at the 1.5 s check timeout');
    assert.deepEqual([outcome.verdict, outcome.verdict === 'failed' && outcome.failure], ['failed', 'not_running']);
    t.plugins.checkSettled('c', { stored: true, messageId: 'm' });
    await restart;
    assert.equal(state(t.plugins, 'gate'), 'ready');
  } finally { await t.close(); }
});

test('the gate in every state: asked when ready; not running WITH a record whenever it is expected to run; silent only when the user does not want it', async () => {
  const s = setup([
    { id: 'gate', behaviour: { shutdown: 'slow', slowMs: 500, init: 0 }, grant: { permissions: ['messages.gate'] } },
    { id: 'off', grant: { permissions: ['messages.gate'] } },
  ]);
  const w = fakeWatch();
  const t = manager(s.home, ['gate'], { backoffMs: [400, 400, 400], restartWindowMs: 60_000, maxAutoRestartsTotal: 1, watch: w.watch,
    devReloadMax: 1, switches: { autoRestart: ['gate'], devReload: ['gate'] } });
  let n = 0;
  const verdicts = async () => {
    const asked = t.plugins.checkMessage({ checkId: `c-${++n}`, clusterId: 'one', sender: { id: 'a', name: 'A' }, mentions: [], recipients: [], fyi: false, replyTo: null, attachments: 0, body: 'x' });
    const outcomes = asked ? await asked : null;
    t.plugins.checkSettled(`c-${n}`, { stored: true, messageId: `m-${n}` });
    return outcomes?.map((o) => `${o.pluginId}:${o.verdict === 'failed' ? o.failure : o.verdict}`) ?? null;
  };
  try {
    await t.plugins.start();
    assert.deepEqual(await verdicts(), ['gate:allow'], 'ready: asked; "off" (disabled at this start, not wanted): not asked');
    // Restarting: stopping, then starting.
    writeFileSync(join(s.folder('gate'), 'behaviour.json'), JSON.stringify({ shutdown: 'slow', slowMs: 500, init: 400 }));
    const restart = t.plugins.restartPlugin('gate');
    await waitFor(() => state(t.plugins, 'gate') === 'stopping', 'stopping for the restart');
    assert.deepEqual(await verdicts(), ['gate:not_running'], 'stopping for a restart');
    await waitFor(() => state(t.plugins, 'gate') === 'starting', 'starting');
    assert.deepEqual(await verdicts(), ['gate:not_running'], 'starting');
    await restart;
    assert.deepEqual(await verdicts(), ['gate:allow']);
    // Reload paused (it is still running): asked.
    w.fire('main.mjs'); await sleep(700); await waitFor(() => state(t.plugins, 'gate') === 'ready', 'reloaded');
    w.fire('main.mjs'); await waitFor(() => (t.plugins.info('gate') as any).lifecycle.reloadPaused, 'paused');
    assert.deepEqual(await verdicts(), ['gate:allow'], 'reload paused, still running');
    // Failed, waiting for its automatic restart; then given up (total cap 1).
    await assert.rejects(call(t.plugins, 'gate', 'crash'));
    assert.ok((t.plugins.info('gate') as any).lifecycle.restartAt);
    assert.deepEqual(await verdicts(), ['gate:not_running'], 'backoff before an automatic restart');
    await waitFor(() => state(t.plugins, 'gate') === 'ready', 'restarted', 5000);
    await assert.rejects(call(t.plugins, 'gate', 'crash'));
    assert.equal((t.plugins.info('gate') as any).lifecycle.gaveUp, true);
    assert.deepEqual(await verdicts(), ['gate:not_running'], 'gave up: the user still believes the referee is on');
    // The user's stop: not asked, no record.
    await t.plugins.stop('gate');
    assert.equal(await verdicts(), null, 'stopped by the user');
    // Started by the user, the disabled one counts too while it is wanted.
    await t.plugins.startPlugin('off');
    assert.deepEqual(await verdicts(), ['off:allow']);
  } finally { await t.close(); }
});

test('Hub: a member message sent after the shutdown of a restart began is let through WITH a record', async () => {
  const s = setup([{ id: 'gate', behaviour: { check: 'refuse', shutdown: 'slow', slowMs: 800 }, grant: { permissions: ['messages.gate'], clusterIds: ['one'] } }]);
  seedCluster(s.dir, ['A', 'B']);
  const app = await startTestHub({ dir: s.dir });
  try {
    assert.match((await mcpSend(app, 'one-A', '@B before')).text, /^REFUSED_BY_PLUGIN/);
    const restart = app.api('POST', '/api/plugins/gate/restart', {});
    await waitFor(async () => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'gate').runtime.state === 'stopping', 'stopping');
    const sent = await mcpSend(app, 'one-A', '@B during the restart');
    assert.equal(sent.isError, false, sent.text);
    assert.ok(app.store.listMessages('one', 200).some((m) => m.body === '@B during the restart'), 'stored');
    const records = app.store.listMessages('one', 200).filter((m) => m.systemKind === 'plugin_check_failed');
    assert.equal(records.length, 1);
    assert.match(records[0].body, /插件「插件gate」没有完成发言检查（插件没有在运行）/);
    await restart;
    assert.match((await mcpSend(app, 'one-A', '@B after')).text, /^REFUSED_BY_PLUGIN/, 'checking again');
  } finally { await app.close(); }
});

test('requirements are judged by the manifest just read: a dropped one no longer blocks, a new missing one is refused and keeps the running instance', async () => {
  const s = setup([{ id: 'base' }, { id: 'app', manifest: { requires: ['base'] } }]);
  const t = manager(s.home, ['base', 'app']);
  try {
    await t.plugins.start();
    // Present and running: fine.
    await t.plugins.restartPlugin('app');
    assert.equal(state(t.plugins, 'app'), 'ready');
    // The user stops base and repairs app's manifest so it no longer requires it: the restart reads it and succeeds.
    await t.plugins.stop('base');
    writeManifest(s.folder('app'), 'app', { version: '2.0.0' });
    await t.plugins.restartPlugin('app');
    assert.deepEqual([state(t.plugins, 'app'), t.plugins.manifestOf('app')!.version], ['ready', '2.0.0']);
    // A new requirement that is not running: refused, the running instance stays, the card says why.
    const running = await pid(t.plugins, 'app');
    writeManifest(s.folder('app'), 'app', { version: '3.0.0', requires: ['base'] });
    await assert.rejects(t.plugins.restartPlugin('app'), (e: any) => e.code === 'DEPENDENCY_NOT_RUNNING' && /base/.test(e.message));
    assert.deepEqual([await pid(t.plugins, 'app'), t.plugins.manifestOf('app')!.version], [running, '2.0.0']);
    assert.match((t.plugins.info('app') as any).lifecycle.registrationError, /base/);
    // Not running and refused: nothing changes either.
    await t.plugins.stop('app');
    await assert.rejects(t.plugins.startPlugin('app'), (e: any) => e.code === 'DEPENDENCY_NOT_RUNNING');
    assert.deepEqual([state(t.plugins, 'app'), (t.plugins.info('app') as any).enabled], ['stopped', false]);
    await t.plugins.startPlugin('base');
    await t.plugins.startPlugin('app');
    assert.deepEqual([state(t.plugins, 'app'), t.plugins.manifestOf('app')!.version], ['ready', '3.0.0']);
  } finally { await t.close(); }
});

test('a restart refused for a missing dependency preserves the scheduled recovery', async () => {
  const s = setup([{ id: 'base' }, { id: 'app' }]);
  const t = manager(s.home, ['app'], { switches: { autoRestart: ['app'], devReload: [] }, backoffMs: [500] });
  try {
    await t.plugins.start();
    await assert.rejects(call(t.plugins, 'app', 'crash'));
    const life = () => {
      const info = t.plugins.info('app');
      assert.ok('lifecycle' in info);
      return info.lifecycle;
    };
    const scheduled = life().restartAt;
    assert.ok(scheduled);
    writeManifest(s.folder('app'), 'app', { version: '2.0.0', requires: ['base'] });
    await assert.rejects(t.plugins.restartPlugin('app'), { code: 'DEPENDENCY_NOT_RUNNING' });
    assert.equal(life().restartAt, scheduled);
    await waitFor(() => state(t.plugins, 'app') === 'ready', 'original scheduled recovery');
    assert.equal(t.plugins.manifestOf('app')?.version, '1.0.0');
    assert.equal(life().autoRestartsTotal, 1);
  } finally { await t.close(); }
});

test('an in-flight invoke reports its own process failure or timeout', async () => {
  const s = setup([{ id: 'app' }]);
  const t = manager(s.home, ['app'], {}, 800);
  try {
    await t.plugins.start();
    await assert.rejects(call(t.plugins, 'app', 'crash'), /plugin process exited/);
    await t.plugins.startPlugin('app');
    await assert.rejects(call(t.plugins, 'app', 'hang'), /plugin request timed out/);
  } finally { await t.close(); }
});
