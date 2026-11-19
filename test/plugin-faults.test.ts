// Fault isolation for every in-process plugin (docs/plugins.md「故障隔离」): a plugin's service, member tools, hooks and
// prepare steps, and the automatic backup before a schema upgrade (docs/architecture.md「升级前备份」).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AUTO_BACKUP_LABEL, automaticUpgradeBackup, backupDatabase, BASELINE_MARKER, pruneAutomaticBackups } from '../src/backup.ts';
import type { CollaborationActor } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost, type OfficialPlugin, type PluginPrepare } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { freePort, startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

const plugin = (id: string, extra: Partial<OfficialPlugin> = {}): OfficialPlugin => ({ id, version: '1.0.0', ...extra });
const faultsOf = async (app: TestHub, id: string): Promise<{ phase: string; error: string }[]> =>
  (await app.api('GET', '/api/plugins')).installed.find((p: { id: string }) => p.id === id).faults ?? [];

test('a service that throws or rejects in construction, start, sweep, close or onQuotaChanged stops neither the Hub nor the other plugins', async () => {
  const seen = { failedStartSweeps: 0, failedStartEvents: 0, lateSweeps: 0, noisySweeps: 0, goodSweeps: 0, goodEvents: 0, goodClosed: false, lateClosed: 0 };
  const plugins = [
    ...officialPlugins,
    plugin('broken-make', { service: () => { throw new Error('cannot make'); } }),
    plugin('broken-start', { service: () => ({
      start() { throw new Error('start boom'); }, sweep() { seen.failedStartSweeps++; }, onEvent() { seen.failedStartEvents++; } }) }),
    plugin('late-start', { service: () => ({
      start: (async () => { throw new Error('async start boom'); }) as () => void, sweep() { seen.lateSweeps++; }, close() { seen.lateClosed++; } }) }),
    plugin('noisy', { service: () => ({
      sweep() { seen.noisySweeps++; throw new Error('sweep boom'); },
      onQuotaChanged: (() => Promise.reject(new Error('quota boom'))) as () => void,
      close() { throw new Error('close boom'); } }) }),
    plugin('good', { service: () => ({ sweep() { seen.goodSweeps++; }, onEvent() { seen.goodEvents++; }, close() { seen.goodClosed = true; } }) }),
  ];
  const app = await startTestHub({ port: await freePort(), plugins, limits: { idleSweepMs: 20 } });
  let closed = false;
  try {
    await waitFor(() => seen.goodSweeps >= 3 && seen.noisySweeps >= 3, 'sweeps of the working services');
    assert.deepEqual([...app.hub.services.keys()].filter((id) => !officialPlugins.some((p) => p.id === id)), ['noisy', 'good'],
      'a service that failed to be made or to start is not scheduled');
    assert.equal(seen.failedStartSweeps, 0);
    assert.equal(seen.lateSweeps, 0, 'a start that rejected right away is dropped before the first sweep');
    assert.equal(seen.lateClosed, 1, 'and closed once to release what it armed');

    const { cluster } = await app.cluster('c', ['A']);
    await app.api('POST', `/api/clusters/${cluster.id}/collaboration`, { action: 'role.create', operationId: 'r1', name: 'reviewer' });
    assert.ok(seen.goodEvents > 0, 'the others still observe events');
    assert.equal(seen.failedStartEvents, 0);

    (app.hub as unknown as { quotaChanged(): void }).quotaChanged();
    await waitFor(async () => (await faultsOf(app, 'noisy')).some((f) => f.phase === 'onQuotaChanged'), 'the quota fault');
    assert.deepEqual((await faultsOf(app, 'noisy')).map((f) => [f.phase, f.error]), [['sweep', 'sweep boom'], ['onQuotaChanged', 'quota boom']]);
    assert.deepEqual((await faultsOf(app, 'broken-make')).map((f) => [f.phase, f.error]), [['service', 'cannot make']]);
    assert.deepEqual((await faultsOf(app, 'broken-start')).map((f) => [f.phase, f.error]), [['start', 'start boom']]);
    assert.deepEqual((await faultsOf(app, 'late-start')).map((f) => [f.phase, f.error]), [['start', 'async start boom']]);
    assert.deepEqual(await faultsOf(app, 'good'), []);
    assert.equal((await app.api('GET', '/api/health')).state, 'running');
    await app.close();
    closed = true;
    assert.equal(seen.goodClosed, true, "a failing close did not stop the next one or the Hub's own shutdown");
  } finally { if (!closed) await app.close(); }
});

/** A tools/call from the native mock conversation s1. */
async function mcp(app: TestHub, method: string, params: Record<string, unknown> = {}) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const response = await fetch(`${app.url}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-harness': 'mock', 'x-orrery-session': 's1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return ((await response.json()) as { result: any }).result;
}

test("member tools: a plugin whose tools() throws, or whose tool name is taken, loses only its own tools", async () => {
  const plugins = [
    ...officialPlugins,
    plugin('tool-bad', { tools: (api) => { api.query('bad_one', 'never listed', 'collections', {}); throw new Error('tools boom'); } }),
    plugin('tool-clash', { tools: (api) => { api.query('clash_ok', 'never listed either', 'collections', {}); api.query('send_message', 'taken', 'collections', {}); } }),
    plugin('tool-good', { tools: (api) => { api.query('good_tool', 'my collections', 'collections', api.page); } }),
  ];
  const app = await startTestHub({ port: await freePort(), plugins });
  try {
    await app.hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const names = (await mcp(app, 'tools/list')).tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('good_tool'));
    assert.ok(names.includes('list_bookmarks'), 'the official plugins keep theirs');
    for (const gone of ['bad_one', 'clash_ok']) assert.equal(names.includes(gone), false, `${gone} is not registered`);
    assert.equal(names.filter((n: string) => n === 'send_message').length, 1);
    const called = await mcp(app, 'tools/call', { name: 'good_tool', arguments: {} });
    assert.notEqual(called.isError, true, called.content?.[0]?.text);
    assert.deepEqual((await faultsOf(app, 'tool-bad')).map((f) => [f.phase, f.error]), [['tools', 'tools boom']]);
    assert.match((await faultsOf(app, 'tool-clash'))[0].error, /send_message is already registered/);
  } finally { await app.close(); }
});

test("member tools: an in-process plugin cannot take a restricted plugin's p_ name, and a restricted tool that cannot be registered never fails the build", async () => {
  const plugins = [...officialPlugins,
    plugin('squatter', { tools: (api) => { api.query('squat_ok', 'never listed', 'collections', {}); api.query('p_notes_note', 'a restricted name', 'collections', {}); } })];
  const app = await startTestHub({ port: await freePort(), plugins });
  try {
    await app.hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    let names = (await mcp(app, 'tools/list')).tools.map((t: { name: string }) => t.name);
    assert.equal(names.includes('p_notes_note') || names.includes('squat_ok'), false, 'the plugin lost all of its tools');
    assert.match((await faultsOf(app, 'squatter'))[0].error, /p_notes_note is reserved for restricted third-party plugins/);
    // A restricted tool whose name is taken some other way (here: a core tool's) is left out; everyone else's list works.
    (app.hub as unknown as { pluginTools: () => unknown[] }).pluginTools = () => [
      { name: 'send_message', description: 'clash', inputSchema: { type: 'object' }, running: true },
      { name: 'p_ok_tool', description: 'fine', inputSchema: { type: 'object' }, running: true }];
    names = (await mcp(app, 'tools/list')).tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('p_ok_tool') && names.includes('list_agents'));
    assert.equal(names.filter((n: string) => n === 'send_message').length, 1);
  } finally { await app.close(); }
});

test('a promise where the host expects an answer now is refused, never half-used, and its rejection is always caught', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const plugins = [...officialPlugins,
    plugin('async-service', { service: (async () => ({ sweep() {} })) as unknown as OfficialPlugin['service'] }),
    plugin('rejecting-service', { service: (async () => { throw new Error('later'); }) as unknown as OfficialPlugin['service'] }),
    plugin('async-tools', { tools: (async (api: Parameters<NonNullable<OfficialPlugin['tools']>>[0]) => {
      api.query('before_await', 'declared before the await', 'collections', {});
      await Promise.resolve();
      api.query('after_await', 'declared after it', 'collections', {});
    }) as unknown as OfficialPlugin['tools'] }),
    plugin('async-hooks', {
      memberRemoved: (async () => {}) as unknown as OfficialPlugin['memberRemoved'],
      migrations: ['CREATE TABLE async_rows (x)'],
      actions: { 'async.write': (async ({ store }: { store: Store }) => { store.db.prepare('INSERT INTO async_rows VALUES (1)').run(); return {}; }) as never },
      queries: { 'async.read': (async () => ({ items: [] })) as never },
      messageFields: { asyncField: (async () => 'later') as never },
    })];
  const app = await startTestHub({ port: await freePort(), plugins });
  try {
    for (const id of ['async-service', 'rejecting-service']) {
      assert.match((await faultsOf(app, id))[0]?.error ?? '', /service\(\) returned a promise; it must answer synchronously/, id);
      assert.equal(app.hub.services.has(id), false, `${id} is not scheduled`);
    }
    await app.hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }, { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' }]);
    const names = (await mcp(app, 'tools/list')).tools.map((t: { name: string }) => t.name);
    assert.equal(names.includes('before_await') || names.includes('after_await'), false, 'nothing of an async tools() is registered');
    assert.match((await faultsOf(app, 'async-tools'))[0].error, /tools\(api\) returned a promise/);

    const cluster = app.store.listClusters()[0];
    const members = app.store.listMembers(cluster.id);
    const res = await fetch(`${app.url}/api/clusters/${cluster.id}/members/${members[1].id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'PLUGIN_HOOK_FAILED');
    assert.match(body.error, /plugin async-hooks failed in memberRemoved: memberRemoved returned a promise/);
    assert.equal(app.store.getMember(members[1].id)?.removedAt, null, 'the member is still there');

    const command = await fetch(`${app.url}/api/clusters/${cluster.id}/collaboration`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'async.write', operationId: 'w1' }) });
    assert.equal(command.status, 400);
    assert.equal((await command.json()).code, 'PLUGIN_ASYNC');
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM async_rows').get()!.n, 0, 'the action\'s write was rolled back');
    assert.throws(() => app.hub.collaboration.query({ kind: 'user' }, cluster.id, { kind: 'async.read' } as never), /PLUGIN_ASYNC|returned a promise/);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'hello' });
    const listed = (await app.messages(cluster.id)).find((m) => m.body === 'hello')!;
    assert.ok(Object.hasOwn(listed, 'asyncField'));
    assert.equal(listed.asyncField, null, 'an async message field reads as null');
    await new Promise((ok) => setTimeout(ok, 50));
    assert.deepEqual(unhandled, [], 'no unhandled rejection');
  } finally { process.off('unhandledRejection', onUnhandled); await app.close(); }
});

test('a hook inside a core transaction that throws rolls the whole operation back and names the plugin and the operation', async () => {
  const plugins = [...officialPlugins, plugin('hooky', {
    memberRemoved: () => { throw new Error('keeps its rows'); },
    clusterPurging: () => { throw new Error('cannot purge'); },
  })];
  const app = await startTestHub({ port: await freePort(), plugins });
  try {
    const { cluster, members } = await app.cluster('c', ['A', 'B']);
    const res = await fetch(`${app.url}/api/clusters/${cluster.id}/members/${members[1].id}`, { method: 'DELETE',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'PLUGIN_HOOK_FAILED');
    assert.match(body.error, /plugin hooky failed in memberRemoved: keeps its rows; nothing was changed/);
    assert.equal(app.store.getMember(members[1].id)?.removedAt, null, 'the member is still in the cluster');

    await app.api('DELETE', `/api/clusters/${cluster.id}`, {});
    const trashed = (await app.api('GET', '/api/clusters?deleted=true'))[0];
    const purge = await fetch(`${app.url}/api/clusters/${cluster.id}/purge`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'c', trashVersion: trashed.trashVersion }) });
    assert.equal(purge.status, 400);
    assert.match((await purge.json()).error, /plugin hooky failed in clusterPurging: cannot purge/);
    assert.ok(app.store.getCluster(cluster.id, { includeDeleted: true }), 'the cluster is still in the recycle bin');
  } finally { await app.close(); }
});

function prepareFixture(prepare: PluginPrepare) {
  const ran: { action: string; prepared: unknown }[] = [];
  const action = (name: string) => ({ [name]: ({ prepared }: { prepared?: unknown }) => { ran.push({ action: name, prepared }); return {}; } });
  const store = new Store(':memory:', new PluginHost([plugin('prep', {
    actions: { ...action('prep.strict'), ...action('prep.loose') },
    prepare: { 'prep.strict': prepare, 'prep.loose': prepare },
    prepareRequired: ['prep.strict'],
  })]));
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, []);
  const hub = new Hub({ store, nativeAdapters: {} });
  hub.collaboration.prepareTimeoutMs = 30;
  const user: CollaborationActor = { kind: 'user' };
  let serial = 0;
  const send = (action: string) => hub.collaboration.commandAsync(user, 'c', { action, operationId: `op-${++serial}` } as never);
  return { store, hub, ran, send };
}

test('prepare: a timeout aborts its signal, fails an action that depends on it and lets any other continue', async () => {
  const signals: AbortSignal[] = [];
  const { store, hub, ran, send } = prepareFixture(({ signal }) => {
    signals.push(signal);
    return new Promise(() => {});   // never answers
  });
  try {
    await assert.rejects(send('prep.strict'), (e: Error & { code?: string }) => e.code === 'PREPARE_FAILED' && /no answer within 30 ms/.test(e.message));
    await send('prep.loose');
    assert.deepEqual(ran, [{ action: 'prep.loose', prepared: undefined }], 'only the undeclared action ran, as if nothing was prepared');
    assert.equal(signals.length, 2);
    assert.ok(signals.every((s) => s.aborted), 'each timed-out prepare got its signal aborted');
  } finally { await hub.close(); store.close(); }
});

test('prepare: a throw fails a declared action and prepares nothing for an undeclared one; a result reaches both', async () => {
  let mode: 'throw' | 'answer' = 'throw';
  const { store, hub, ran, send } = prepareFixture(async () => { if (mode === 'throw') throw new Error('git is gone'); return 'facts'; });
  try {
    await assert.rejects(send('prep.strict'), /PREPARE|could not read what it needs before running \(git is gone\)/);
    await send('prep.loose');
    mode = 'answer';
    await send('prep.strict');
    assert.deepEqual(ran, [{ action: 'prep.loose', prepared: undefined }, { action: 'prep.strict', prepared: 'facts' }]);
  } finally { await hub.close(); store.close(); }
});

test('prepare: the web API runs the prepare step like the members\' tools; no entry runs a dependent action without it; a replay re-runs nothing', async () => {
  let fail = false;
  const seen = { prepares: 0, actions: [] as unknown[] };
  const plugins = [...officialPlugins, plugin('prep', {
    actions: { 'prep.do': ({ prepared }) => { seen.actions.push(prepared); return { got: prepared }; } },
    prepare: { 'prep.do': async () => { seen.prepares++; if (fail) throw new Error('git is gone'); return 'facts'; } },
    prepareRequired: ['prep.do'],
  })];
  const app = await startTestHub({ port: await freePort(), plugins });
  try {
    const { cluster } = await app.cluster('c', ['A']);
    const post = (operationId: string) => fetch(`${app.url}/api/clusters/${cluster.id}/collaboration`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prep.do', operationId }) });
    let res = await post('first');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).got, 'facts', 'the action got the prepared value');
    fail = true;
    res = await post('second');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'PREPARE_FAILED');
    assert.deepEqual(seen.actions, ['facts'], 'the action did not run without its prepare result');
    const prepares = seen.prepares;
    res = await post('first');
    assert.equal((await res.json()).got, 'facts', 'the recorded result is replayed');
    assert.equal(seen.prepares, prepares, 'a replay runs no prepare step');
    assert.deepEqual(seen.actions, ['facts'], 'and no action');
    // The synchronous entry (internal callers) refuses such an action, but still replays a recorded one.
    assert.throws(() => app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'prep.do', operationId: 'third' } as never),
      (e: Error & { code?: string }) => e.code === 'PREPARE_REQUIRED');
    assert.equal((app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'prep.do', operationId: 'first' } as never) as { got?: unknown }).got, 'facts');
    assert.deepEqual(seen.actions, ['facts']);
  } finally { await app.close(); }
});

test('prepareRequired must name an action with a prepare step', () => {
  assert.throws(() => new PluginHost([plugin('a', { actions: { 'a.x': () => ({}) }, prepareRequired: ['a.x'] })]), /prepareRequired without a prepare/);
});

// ---- the automatic backup before a schema upgrade ----

const CORE_V28 = 'DROP TRIGGER deliveries_state_seq_insert; DROP TRIGGER deliveries_state_seq_update; ALTER TABLE deliveries DROP COLUMN state_seq; '
  + 'ALTER TABLE deliveries DROP COLUMN dismissed_at; ALTER TABLE reads DROP COLUMN seen_at; PRAGMA user_version = 28';
const versionOf = (store: Store, id: string) =>
  (store.db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?').get(id) as { version: number } | undefined)?.version;

test('backup: only an existing database with core or plugin steps pending is backed up, once per start', () => {
  const dir = tempDir();
  const path = join(dir, 'u.db');
  const made: string[] = [];
  const upgrade = { backup: () => { const file = backupDatabase(path, dir, join(dir, 'backups'), new Date(2026, 0, 1, 0, 0, made.length), AUTO_BACKUP_LABEL); made.push(file); return file; } };
  const one = plugin('a', { migrations: ['CREATE TABLE a_one (x)'] });
  new Store(path, new PluginHost([one]), undefined, undefined, upgrade).close();
  assert.deepEqual(made, [], 'a new database is not backed up');
  new Store(path, new PluginHost([one]), undefined, undefined, upgrade).close();
  assert.deepEqual(made, [], 'nothing pending: no backup');

  const two = plugin('a', { migrations: ['CREATE TABLE a_one (x)', 'CREATE TABLE a_two (x)'] });
  const three = plugin('b', { migrations: ['CREATE TABLE b_one (x)'] });
  let store = new Store(path, new PluginHost([two, three]), undefined, undefined, upgrade);
  assert.equal(made.length, 1, 'two plugins pending: one backup covers both');
  assert.equal(store.upgradeBackup, made[0]);
  assert.match(made[0], /orrery-20260101-000000-pre-upgrade\.db$/);
  assert.deepEqual([versionOf(store, 'a'), versionOf(store, 'b')], [2, 1]);
  store.db.exec(CORE_V28);
  store.close();

  store = new Store(path, new PluginHost([two, three]), undefined, undefined, upgrade);
  assert.equal(made.length, 2, 'a core upgrade is backed up as well');
  assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30);
  store.close();
  const backup = new Store(made[1], new PluginHost([two, three]));
  try {
    assert.equal(backup.upgradeBackup, null);
  } finally { backup.close(); }
});

test('backup: a failed backup changes nothing, for a core upgrade and for a plugin step alike', () => {
  const dir = tempDir();
  const path = join(dir, 'f.db');
  const failing = { backup: (): string => { throw new Error('disk full'); } };
  const one = plugin('a', { migrations: ['CREATE TABLE a_one (x)'] });
  let store = new Store(path, new PluginHost([one]));
  store.db.exec(CORE_V28);
  store.close();
  assert.throws(() => new Store(path, new PluginHost([one]), undefined, undefined, failing),
    /needs a schema upgrade and the backup before it failed, so nothing was changed: disk full/);
  store = new Store(path, new PluginHost([one]));   // no backup asked for: upgrades
  store.close();
  const two = plugin('a', { migrations: ['CREATE TABLE a_one (x)', 'CREATE TABLE a_two (x)'] });
  assert.throws(() => new Store(path, new PluginHost([two]), undefined, undefined, failing), /disk full/);
  store = new Store(path, new PluginHost([one]));
  try {
    assert.equal(versionOf(store, 'a'), 1, 'the plugin step did not run');
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'a_two'").get(), undefined);
  } finally { store.close(); }
});

test('backup: a failing step reports the version it reached and keeps the backup', () => {
  const dir = tempDir();
  const path = join(dir, 's.db');
  new Store(path, new PluginHost([plugin('a', { migrations: ['CREATE TABLE a_one (x)'] })])).close();
  const upgrade = { backup: () => backupDatabase(path, dir, join(dir, 'backups'), new Date(2026, 0, 2), AUTO_BACKUP_LABEL) };
  const bad = plugin('a', { migrations: ['CREATE TABLE a_one (x)', 'CREATE TABLE a_two (x)', 'CREATE TABLE nonsense'] });
  assert.throws(() => new Store(path, new PluginHost([bad]), undefined, undefined, upgrade),
    /plugin a: migration step 3 failed and was rolled back; its data stays at version 2 of 3: .*the backup made before the upgrade is .*pre-upgrade\.db; nothing was restored automatically/);
});

test('backup: only the newest five automatic backups are kept; manual ones stay', () => {
  const dir = join(tempDir(), 'backups');
  mkdirSync(dir);
  const auto = (n: number) => `orrery-2026010${n}-000000-pre-upgrade.db`;
  for (let n = 1; n <= 7; n++) writeFileSync(join(dir, auto(n)), '');
  writeFileSync(join(dir, 'orrery-20250101-000000.db'), '');
  assert.deepEqual(pruneAutomaticBackups(dir), [auto(1), auto(2)]);
  assert.deepEqual(readdirSync(dir).sort(), ['orrery-20250101-000000.db', ...[3, 4, 5, 6, 7].map(auto)]);
});

/** The clusters a database file holds, read read-only (what a backup would restore). */
const clustersIn = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT id FROM clusters ORDER BY id').all().map((r) => String(r.id)); } finally { db.close(); }
};
const autoIn = (dir: string) => readdirSync(dir).filter((name) => name.endsWith('-pre-upgrade.db')).sort();

test('backup: a skipped upgrade, then data, then the fixed upgrade: its fresh backup holds the new data and the first baseline stays', () => {
  const dir = tempDir();
  const path = join(dir, 'up.db');
  const backups = join(dir, 'backups');
  const ok = plugin('opt', { migrations: ['CREATE TABLE x_opt_one (x)'] });
  new Store(path, new PluginHost([ok], [], { fullTrust: ['opt'] })).close();
  const failing = plugin('opt', { migrations: ['CREATE TABLE x_opt_one (x)', 'CREATE TABLE nonsense'] });
  let store = new Store(path, new PluginHost([failing], [], { fullTrust: ['opt'] }), undefined, undefined, automaticUpgradeBackup(path, backups));
  const baseline = store.upgradeBackup!;
  assert.ok(store.plugins.skipped.has('opt'), 'the optional plugin was skipped, the Hub works');
  store.insertCluster({ id: 'made-after-the-failure', name: 'c', category: '', createdAt: '2026-01-01' }, []);
  store.close();
  assert.equal(readFileSync(join(backups, BASELINE_MARKER), 'utf8').trim(), basename(baseline));
  const fixed = plugin('opt', { migrations: ['CREATE TABLE x_opt_one (x)', 'CREATE TABLE x_opt_two (x)'] });
  store = new Store(path, new PluginHost([fixed], [], { fullTrust: ['opt'] }), undefined, undefined, automaticUpgradeBackup(path, backups));
  try {
    assert.notEqual(store.upgradeBackup, baseline, 'a fresh backup, never one reused by schema version');
    assert.deepEqual(clustersIn(store.upgradeBackup!), ['made-after-the-failure'], 'the backup taken for this upgrade holds the newest data');
    assert.ok(existsSync(baseline), 'the baseline from before the first attempt is still there');
    assert.deepEqual(clustersIn(baseline), []);
    assert.equal(existsSync(join(backups, BASELINE_MARKER)), false, 'a complete start ends the sequence');
  } finally { store.close(); }
});

test('backup: a failure loop keeps the baseline and the newest four, older automatic backups go; a complete start prunes to five', () => {
  const dir = tempDir();
  const path = join(dir, 'loop.db');
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  const old = (n: number) => `orrery-2020010${n}-000000-pre-upgrade.db`;
  for (let n = 1; n <= 6; n++) writeFileSync(join(backups, old(n)), '');   // from earlier, complete upgrades
  writeFileSync(join(backups, 'orrery-20200101-000000.db'), '');   // a manual one
  new Store(path, new PluginHost([plugin('a', { migrations: ['CREATE TABLE a_one (x)'] })])).close();
  const failing = plugin('a', { migrations: ['CREATE TABLE a_one (x)', 'CREATE TABLE nonsense'] });
  const made: string[] = [];
  for (let start = 0; start < 7; start++) {
    const upgrade = automaticUpgradeBackup(path, backups);
    assert.throws(() => new Store(path, new PluginHost([failing]), undefined, undefined, { ...upgrade, backup: () => { const p = upgrade.backup(); made.push(basename(p)); return p; } }),
      /migration step 2 failed/);
  }
  assert.equal(new Set(made).size, 7, 'one fresh backup per start');
  assert.deepEqual(autoIn(backups), [made[0], ...made.slice(-4)].sort(), 'the baseline and the newest four; the older ones went');
  assert.ok(readdirSync(backups).includes('orrery-20200101-000000.db'), 'manual backups stay');
  const fixed = plugin('a', { migrations: ['CREATE TABLE a_one (x)', 'CREATE TABLE a_two (x)'] });
  const store = new Store(path, new PluginHost([fixed]), undefined, undefined, automaticUpgradeBackup(path, backups));
  try {
    assert.equal(autoIn(backups).length, 5, 'after the complete start: the newest five');
    assert.ok(autoIn(backups).includes(basename(store.upgradeBackup!)));
    assert.equal(existsSync(join(backups, BASELINE_MARKER)), false);
  } finally { store.close(); }
});

test('backup: a marker that cannot be read prunes nothing until a complete start', () => {
  const dir = tempDir();
  const path = join(dir, 'm.db');
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  for (let n = 1; n <= 6; n++) writeFileSync(join(backups, `orrery-2020010${n}-000000-pre-upgrade.db`), '');
  writeFileSync(join(backups, BASELINE_MARKER), 'not a backup name');
  new Store(path, new PluginHost([plugin('a', { migrations: ['CREATE TABLE a_one (x)'] })])).close();
  const failing = plugin('a', { migrations: ['CREATE TABLE a_one (x)', 'CREATE TABLE nonsense'] });
  for (let start = 0; start < 3; start++) assert.throws(() => new Store(path, new PluginHost([failing]), undefined, undefined, automaticUpgradeBackup(path, backups)));
  assert.equal(autoIn(backups).length, 9, 'nothing deleted while the baseline is unknown');
  new Store(path, new PluginHost([plugin('a', { migrations: ['CREATE TABLE a_one (x)'] })]), undefined, undefined, automaticUpgradeBackup(path, backups)).close();
  assert.equal(autoIn(backups).length, 5, 'a complete start, even with nothing pending, prunes and ends the sequence');
  assert.equal(existsSync(join(backups, BASELINE_MARKER)), false);
});

test('backup: two in the same second get distinct names; a copy that fails leaves no file behind', () => {
  const dir = tempDir();
  const path = join(dir, 'same.db');
  new Store(path).close();
  const at = new Date(2026, 0, 3, 4, 5, 6);
  const one = backupDatabase(path, dir, join(dir, 'b'), at, AUTO_BACKUP_LABEL);
  const two = backupDatabase(path, dir, join(dir, 'b'), at, AUTO_BACKUP_LABEL);
  assert.deepEqual([one, two].map((p) => p.slice(join(dir, 'b').length + 1)), ['orrery-20260103-040506-pre-upgrade.db', 'orrery-20260103-040506-2-pre-upgrade.db']);
  assert.deepEqual(pruneAutomaticBackups(join(dir, 'b'), 1), ['orrery-20260103-040506-pre-upgrade.db'], 'the tiebreaker sorts after the plain name');
  const broken = join(dir, 'broken.db');
  writeFileSync(broken, 'this is not a database'.repeat(100));
  assert.throws(() => backupDatabase(broken, dir, join(dir, 'c'), at, AUTO_BACKUP_LABEL));
  assert.deepEqual(readdirSync(join(dir, 'c')), [], 'no partial file counts as a backup');
});

test('backup: the Hub backs up into <home>/backups before upgrading an existing database', async () => {
  const dir = tempDir();
  const extra = plugin('extra', { migrations: ['CREATE TABLE extra_one (x)'] });
  const first = await startTestHub({ dir, port: await freePort() });
  await first.close();
  assert.equal(existsSync(join(dir, 'home', 'backups')), false, 'a new database: no backup');
  const again = await startTestHub({ dir, port: await freePort(), plugins: [...officialPlugins, extra] });
  try {
    const files = readdirSync(join(dir, 'home', 'backups'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^orrery-\d{8}-\d{6}-pre-upgrade\.db$/);
    assert.equal(again.store.upgradeBackup, join(dir, 'home', 'backups', files[0]));
  } finally { await again.close(); }
});
