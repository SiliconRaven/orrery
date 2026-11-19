// Full-trust third-party plugins (docs/external-plugins.md「完全信任的插件」): nothing of an unconfirmed, revoked or
// safe-mode plugin runs, the confirmation is bound to the entry's real path, a bad plugin is skipped alone, its
// migrations stay inside its prefix, and the example plugin works end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { readPluginsFile, writePluginsFile } from '../src/config.ts';
import { PluginHost, type OfficialPlugin } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { readPluginIcon } from '../src/core/plugin-icon.ts';
import { trustedPluginOf } from '../src/core/trusted-plugins.ts';
import { REPO_ROOT } from '../src/main.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { freePort, rawFetch, startTestHub, tempDir, TEST_TOKEN, type TestHub } from './helpers.ts';

type Card = { id: string; enabled: boolean; pendingEnabled: boolean; origin?: string; trust?: { state: string; entry: string | null; confirmed: boolean; error: string | null };
  trustConflict?: string };

/**
 * A full-trust plugin folder: a manifest, a Hub entry whose import and default export each append a line to `marker`
 * (in this test's own temp folder). `body` is the object the default export returns.
 */
function writePlugin(dir: string, id: string, body: string, manifest: Record<string, unknown> = {}) {
  const folder = join(dir, `plugin-${id}`);
  mkdirSync(join(folder, 'hub'), { recursive: true });
  const marker = join(folder, 'marker.txt');
  writeFileSync(join(folder, 'hub', 'index.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'imported\\n');
export default function ({ hostApi, z }) {
  appendFileSync(${JSON.stringify(marker)}, 'called ' + hostApi + ' ' + typeof z.string + '\\n');
  return (${body});
}
`);
  writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify({ id, version: '1.0.0', name: `示例 ${id}`, hostApi: 1, hubEntry: 'hub/index.mjs',
    ...manifest }));
  return { folder, manifest: join(folder, 'orrery-plugin.json'), entry: realpathSync.native(join(folder, 'hub', 'index.mjs')),
    marker: () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []) };
}

function register(home: string, manifests: string[]) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: manifests.map((manifest) => ({ manifest, trust: 'full' })) }));
}
const confirm = (home: string, list: { id: string; entry: string }[]) => writePluginsFile(home, { trusted: list });
const cardOf = async (app: TestHub, id: string): Promise<Card> => (await app.api('GET', '/api/plugins')).installed.find((p: Card) => p.id === id);
const tableExists = (app: TestHub, name: string) => !!app.store.db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(name);
const versionOf = (app: TestHub, id: string) =>
  (app.store.db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?').get(id) as { version: number } | undefined)?.version;

/** A plugin body with its own table, a route, the two cleanup hooks and a service that notes its start in `marker`. */
const notesBody = (marker: string) => `{
  migrations: ['CREATE TABLE x_demo_notes (cluster_id TEXT, member_id TEXT, what TEXT)'],
  routes: [{ method: 'GET', pattern: /^\\/api\\/x\\/demo\\/ping$/, handle: () => ({ pong: true }) }],
  memberRemoved: (store, clusterId, memberId) => { store.db.prepare("INSERT INTO x_demo_notes VALUES (?, ?, 'removed')").run(clusterId, memberId); },
  clusterPurging: (store, clusterId) => { store.db.prepare('DELETE FROM x_demo_notes WHERE cluster_id = ?').run(clusterId); },
  service: () => ({ start() { appendFileSync(${JSON.stringify(marker)}, 'service started\\n'); } }),
}`;

test('unconfirmed: nothing is imported and no migration runs; confirming binds the real entry path and loads it after a restart', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const plugin = writePlugin(dir, 'demo', notesBody(join(dir, 'plugin-demo', 'marker.txt')));
  register(home, [plugin.manifest]);
  let app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.deepEqual(plugin.marker(), [], 'the entry was never imported');
    assert.equal(tableExists(app, 'x_demo_notes'), false);
    assert.equal(versionOf(app, 'demo'), undefined, 'no migration ran');
    let card = await cardOf(app, 'demo');
    assert.equal(card.origin, 'trusted');
    assert.deepEqual([card.trust!.state, card.trust!.entry, card.trust!.confirmed], ['unconfirmed', plugin.entry, false]);
    assert.equal((await fetch(`${app.url}/api/x/demo/ping`)).status, 404);

    const put = (body: unknown, headers: Record<string, string> = {}) => fetch(`${app.url}/api/plugins/demo/trust`, { method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await put({ trusted: true, entry: join(dir, 'elsewhere.mjs') })).status, 409, 'a path the page did not show is refused');
    assert.equal((await put({ trusted: true })).status, 400);
    const res = await put({ trusted: true, entry: plugin.entry });
    assert.equal(res.status, 200);
    assert.deepEqual(readPluginsFile(home).trusted, [{ id: 'demo', entry: plugin.entry }]);
    card = (await res.json()).installed.find((p: Card) => p.id === 'demo');
    assert.deepEqual([card.trust!.state, card.trust!.confirmed], ['unconfirmed', true], 'it takes effect after a restart');
    assert.deepEqual(plugin.marker(), [], 'confirming imports nothing either');
  } finally { await app.close(); }

  app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.deepEqual(plugin.marker().slice(0, 2), ['imported', 'called 1 function'], 'imported once, with { hostApi: 1, z }');
    assert.ok(plugin.marker().includes('service started'));
    assert.equal(tableExists(app, 'x_demo_notes'), true);
    assert.equal(versionOf(app, 'demo'), 1);
    assert.deepEqual(await app.api('GET', '/api/x/demo/ping'), { pong: true });
    const card = await cardOf(app, 'demo');
    assert.deepEqual([card.trust!.state, card.enabled], ['loaded', true]);
    assert.ok((await app.api('GET', '/api/plugins')).plugins.some((p: { id: string }) => p.id === 'demo'));
  } finally { await app.close(); }
});

test('the trust API needs the user\'s login and refuses a plugin frame\'s origin', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const plugin = writePlugin(dir, 'demo', '{}');
  register(home, [plugin.manifest]);
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    const body = JSON.stringify({ trusted: true, entry: plugin.entry });
    const headers = { 'content-type': 'application/json' };
    assert.equal((await rawFetch(`${app.url}/api/plugins/demo/trust`, { method: 'PUT', headers, body })).status, 401, 'no token');
    assert.equal((await rawFetch(`${app.url}/api/plugins/demo/trust`, { method: 'PUT', body,
      headers: { ...headers, authorization: `Bearer ${TEST_TOKEN}`, origin: 'null' } })).status, 403, 'a sandboxed frame');
    assert.equal((await rawFetch(`${app.url}/api/plugins/demo/trust`, { method: 'PUT', body,
      headers: { ...headers, authorization: 'Bearer wrong-token-0123456789abcdefghijklmnop' } })).status, 401);
    assert.deepEqual(readPluginsFile(home).trusted ?? [], []);
    assert.equal((await fetch(`${app.url}/api/plugins/bookmarks/trust`, { method: 'PUT', headers, body })).status, 404, 'only full-trust plugins');
  } finally { await app.close(); }
});

test('revoked, safe mode, or confirmed for another path: the plugin does not run', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const a = writePlugin(dir, 'demo', '{ migrations: ["CREATE TABLE x_demo_t (x)"] }');
  register(home, [a.manifest]);
  confirm(home, [{ id: 'demo', entry: a.entry }]);
  let app = await startTestHub({ dir, port: await freePort(), safeMode: true });
  try {
    assert.deepEqual(a.marker(), [], 'safe mode imports nothing');
    assert.equal(versionOf(app, 'demo'), undefined);
    const listing = await app.api('GET', '/api/plugins');
    assert.equal(listing.safeMode, true);
    assert.equal(listing.installed.find((p: Card) => p.id === 'demo').trust.state, 'safe-mode');
  } finally { await app.close(); }

  app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.equal(a.marker().filter((l) => l.startsWith('called')).length, 1);
    assert.equal(versionOf(app, 'demo'), 1);
    await app.api('PUT', '/api/plugins/demo/trust', { trusted: false });
    assert.equal((await cardOf(app, 'demo')).trust!.confirmed, false);
    assert.deepEqual(readPluginsFile(home).trusted ?? [], []);
  } finally { await app.close(); }

  app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.equal(a.marker().filter((l) => l.startsWith('called')).length, 1, 'revoked: not run again');
    assert.equal((await cardOf(app, 'demo')).trust!.state, 'unconfirmed');
  } finally { await app.close(); }

  // The manifest now points at another entry file: the confirmation of the old path does not cover it.
  const other = join(a.folder, 'hub', 'other.mjs');
  writeFileSync(other, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(join(dir, 'other-marker.txt'))}, 'x'); export default () => ({});`);
  confirm(home, [{ id: 'demo', entry: a.entry }]);
  writeFileSync(a.manifest, JSON.stringify({ id: 'demo', version: '1.0.0', hostApi: 1, hubEntry: 'hub/other.mjs' }));
  app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.equal(existsSync(join(dir, 'other-marker.txt')), false, 'the new entry was not imported');
    const card = await cardOf(app, 'demo');
    assert.deepEqual([card.trust!.state, card.trust!.entry], ['path-changed', realpathSync.native(other)]);
  } finally { await app.close(); }
});

test('confirmed but switched off: only the migrations and the two cleanup hooks run', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const plugin = writePlugin(dir, 'demo', notesBody(join(dir, 'plugin-demo', 'marker.txt')));
  register(home, [plugin.manifest]);
  confirm(home, [{ id: 'demo', entry: plugin.entry }]);
  writePluginsFile(home, { disabled: ['demo'] });
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.equal(versionOf(app, 'demo'), 1, 'the migrations ran');
    assert.equal(plugin.marker().includes('service started'), false, 'no service');
    assert.equal((await fetch(`${app.url}/api/x/demo/ping`)).status, 404, 'no routes');
    const card = await cardOf(app, 'demo');
    assert.deepEqual([card.trust!.state, card.enabled, card.pendingEnabled], ['loaded', false, false]);
    const { cluster, members } = await app.cluster('c', ['A', 'B']);
    await app.api('DELETE', `/api/clusters/${cluster.id}/members/${members[1].id}`, {});
    assert.deepEqual(app.store.db.prepare('SELECT what FROM x_demo_notes').all().map((r) => r.what), ['removed'], 'memberRemoved ran');
    await app.api('DELETE', `/api/clusters/${cluster.id}`, {});
    const trashed = (await app.api('GET', '/api/clusters?deleted=true'))[0];
    const result = await app.api('POST', `/api/clusters/${cluster.id}/purge`, { name: 'c', trashVersion: trashed.trashVersion });
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM x_demo_notes').get()!.n, 0, 'clusterPurging ran');
    assert.equal(result.pluginDataMayRemain, undefined, 'its data was cleaned');
  } finally { await app.close(); }
});

test('a plugin that fails to load or to fit is skipped alone, with its dependents; the Hub and the others start', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const good = writePlugin(dir, 'good', `{ routes: [{ method: 'GET', pattern: /^\\/api\\/x\\/good\\/ok$/, handle: () => ({ ok: true }) }] }`);
  const broken = writePlugin(dir, 'broken', '{}');
  writeFileSync(join(broken.folder, 'hub', 'index.mjs'), 'throw new Error("cannot even load");');
  const needsBroken = writePlugin(dir, 'needs-broken', '{}', { requires: ['broken'] });
  const api2 = writePlugin(dir, 'api-two', '{}', { hostApi: 2 });
  const clash = writePlugin(dir, 'bookmarks', '{}');
  const single = writePlugin(dir, 'second-tasks', '{ taskView: () => ({}) }');
  const outside = writePlugin(dir, 'outside', `{ routes: [{ method: 'GET', pattern: /^\\/api\\/tasks$/, handle: () => ({}) }] }`);
  const bridge = writePlugin(dir, 'bridgy', '{ bridgeRoutes: [] }');
  const schema = writePlugin(dir, 'schema', `{ migrations: ['CREATE TABLE x_schema_ok (x)', 'CREATE TABLE x_schema_two (x); CREATE INDEX x_schema_on_core ON messages (body)'] }`);
  const all = [good, broken, needsBroken, api2, clash, single, outside, bridge, schema];
  register(home, all.map((p) => p.manifest));
  confirm(home, all.map((p, i) => ({ id: ['good', 'broken', 'needs-broken', 'api-two', 'bookmarks', 'second-tasks', 'outside', 'bridgy', 'schema'][i], entry: p.entry })));
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.deepEqual(await app.api('GET', '/api/x/good/ok'), { ok: true }, 'the good one runs');
    const reason = async (id: string) => (await cardOf(app, id)).trust?.error ?? '';
    assert.match(await reason('broken'), /加载失败：cannot even load/);
    assert.match(await reason('needs-broken'), /依赖的插件 broken 没有加载/);
    assert.deepEqual(needsBroken.marker(), [], 'a dependent of a failed plugin is not imported');
    assert.match(await reason('api-two'), /hostApi 2 is not supported/);
    assert.deepEqual(api2.marker(), [], 'a hostApi mismatch is found in the manifest, before any import');
    assert.match((await cardOf(app, 'bookmarks')).trustConflict ?? '', /重名/, 'an official id: the official card says why the other did not load');
    assert.deepEqual(clash.marker(), []);
    assert.match(await reason('second-tasks'), /已导入但被拒绝（它的顶层代码和默认导出已经运行过）：taskView: is not open to third-party plugins/);
    assert.deepEqual(single.marker().slice(0, 1), ['imported'], 'and indeed its code ran');
    assert.match(await reason('outside'), /outside \/api\/x\/outside\//);
    assert.match(await reason('bridgy'), /bridgeRoutes are not open/);
    assert.match(await reason('schema'), /迁移第 2 步改动了 x_schema_ 前缀以外的结构（x_schema_on_core）/);
    assert.equal(versionOf(app, 'schema'), 1, 'the first step stays; the second was rolled back');
    assert.equal(tableExists(app, 'x_schema_two'), false);
    assert.equal(tableExists(app, 'x_schema_on_core'), false);
    for (const id of ['broken', 'needs-broken', 'api-two', 'second-tasks', 'outside', 'bridgy', 'schema']) {
      assert.equal((await cardOf(app, id)).trust!.state, 'failed', id);
    }
    assert.deepEqual((await app.api('GET', '/api/plugins')).plugins.map((p: { id: string }) => p.id).sort(), ['bookmarks', 'coordinator', 'good', 'tasks']);
  } finally { await app.close(); }
});

test('migration steps cannot commit themselves, hide in the temp schema or take the prefix of a longer id; a switched-off dependency and an entry that never settles are skipped', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  // A step that commits on its own, a TEMP trigger on a core table, and a name that belongs to the longer id pa-b.
  const committer = writePlugin(dir, 'committer', `{ migrations: ['CREATE TABLE x_committer_t (x); COMMIT; CREATE INDEX x_committer_i ON messages (body)'] }`);
  const temp = writePlugin(dir, 'temp', `{ migrations: ['CREATE TEMP TRIGGER x_temp_trg AFTER INSERT ON messages BEGIN SELECT 1; END'] }`);
  const overlap = writePlugin(dir, 'pa', `{ migrations: ['CREATE TABLE x_pa_b_notes (x)'] }`);
  const longer = writePlugin(dir, 'pa-b', '{}');
  // Decided from the manifest before the import: a dependency that is switched off.
  const offOne = writePlugin(dir, 'off-one', '{}');
  const needsOff = writePlugin(dir, 'needs-off', '{}', { requires: ['off-one'] });
  // Never settles: a top-level await, and a default export whose promise never resolves.
  const stuckImport = writePlugin(dir, 'stuck-import', '{}');
  writeFileSync(join(stuckImport.folder, 'hub', 'index.mjs'), 'await new Promise(() => {}); export default () => ({});');
  const stuckCall = writePlugin(dir, 'stuck-call', '{}');
  writeFileSync(join(stuckCall.folder, 'hub', 'index.mjs'), 'export default () => new Promise(() => {});');
  const ids = ['committer', 'temp', 'pa', 'pa-b', 'off-one', 'needs-off', 'stuck-import', 'stuck-call'];
  const all = [committer, temp, overlap, longer, offOne, needsOff, stuckImport, stuckCall];
  register(home, all.map((p) => p.manifest));
  confirm(home, all.map((p, i) => ({ id: ids[i], entry: p.entry })).filter((c) => c.id !== 'pa-b'));
  writePluginsFile(home, { disabled: ['off-one'] });
  const started = Date.now();
  const app = await startTestHub({ dir, port: await freePort(), trustedLoadTimeoutMs: 300 });
  try {
    const reason = async (id: string) => (await cardOf(app, id)).trust?.error ?? '';
    assert.match(await reason('committer'), /迁移第 1 步失败，已回滚.*not authorized.*不能提交或开始事务/);
    assert.equal(tableExists(app, 'x_committer_t'), false, 'the step could not commit itself: all of it was rolled back');
    assert.equal(tableExists(app, 'x_committer_i'), false);
    assert.match(await reason('temp'), /前缀以外的结构（x_temp_trg）/);
    assert.equal(app.store.db.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name = 'x_temp_trg'").get(), undefined);
    assert.match(await reason('pa'), /前缀以外的结构（x_pa_b_notes）/, 'x_pa_b_ belongs to pa-b');
    assert.equal(tableExists(app, 'x_pa_b_notes'), false);
    assert.match(await reason('needs-off'), /依赖的插件 off-one 已关闭.*（没有导入）/);
    assert.deepEqual(needsOff.marker(), [], 'not imported');
    assert.match(await reason('stuck-import'), /加载失败：importing the entry and calling its default export took longer than 0.3 s/);
    assert.match(await reason('stuck-call'), /took longer than 0.3 s/);
    assert.ok(Date.now() - started < 15_000, 'the Hub started anyway');
    for (const id of ['committer', 'temp', 'pa', 'needs-off', 'stuck-import', 'stuck-call']) assert.equal((await cardOf(app, id)).trust!.state, 'failed', id);
    assert.equal((await cardOf(app, 'off-one')).trust!.state, 'loaded', 'a switched-off plugin still loads (migrations and cleanup hooks)');
  } finally { await app.close(); }
});

test('a route pattern cannot reach outside its prefix, even through an alternation', () => {
  const manifest = { id: 'demo', version: '1.0.0', requires: [] };
  const plugin = trustedPluginOf(manifest, { routes: [{ method: 'GET', pattern: /^\/api\/x\/demo\/a|\/api\/tasks/, handle: () => ({}) }] });
  const pattern = plugin.routes![0].pattern;
  assert.ok(pattern.test('/api/x/demo/a'));
  assert.equal(pattern.test('/api/tasks'), false);
  assert.throws(() => trustedPluginOf(manifest, { routes: [{ method: 'GET', pattern: /^\/api\/x\/demox\//, handle: () => ({}) }] }), /outside/);
  assert.throws(() => trustedPluginOf(manifest, { nonsense: 1 }), /unknown slot nonsense/);
  assert.throws(() => trustedPluginOf(manifest, { id: 'other' }), /says it is "other"/);
  assert.throws(() => trustedPluginOf(manifest, { actions: { 'demo.x': 1 } }), /actions must be an object of functions/);
  assert.equal(trustedPluginOf(manifest, { version: '9.9.9', name: 'x' }).version, '1.0.0', 'the manifest wins');
  for (const slot of ['taskView', 'coordinatorView', 'envelope']) {
    assert.throws(() => trustedPluginOf(manifest, { [slot]: () => ({}) }), /is not open to third-party plugins in this version/, slot);
  }
  // The slots are copied when checked: the plugin changing its own objects afterwards changes nothing that was checked.
  const actions: Record<string, unknown> = { 'demo.x': () => ({}) };
  const migrations = ['CREATE TABLE x_demo_t (x)'];
  const checked = trustedPluginOf(manifest, { actions, migrations });
  actions['demo.y'] = 'not a function';
  migrations.push('DROP TABLE messages');
  assert.deepEqual(Object.keys(checked.actions!), ['demo.x']);
  assert.deepEqual(checked.migrations, ['CREATE TABLE x_demo_t (x)']);
});

test('without setAuthorizer (Node before 24.10.0) a full-trust plugin with steps to run is skipped before any step; nothing else changes', () => {
  const store = new Store(':memory:');
  try {
    // Only this test's own connection loses the method; no global is touched.
    Object.defineProperty(store.db, 'setAuthorizer', { value: undefined, configurable: true });
    const official: OfficialPlugin = { id: 'off', version: '1.0.0', migrations: ['CREATE TABLE off_t (x)'] };
    const pending: OfficialPlugin = { id: 'demo', version: '1.0.0', migrations: ['CREATE TABLE x_demo_t (x)'] };
    const none: OfficialPlugin = { id: 'quiet', version: '1.0.0' };
    const skipped: [string, string][] = [];
    const host = new PluginHost([official, pending, none], [], { fullTrust: ['demo', 'quiet'], onSkip: (id, reason) => skipped.push([id, reason]) });
    host.migrate(store);
    assert.deepEqual(skipped.map(([id]) => id), ['demo']);
    assert.match(skipped[0][1], /迁移需要 Node v24\.10\.0 或更新版本（node:sqlite 的 setAuthorizer）.*没有运行任何一步/);
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'x_demo_t'").get(), undefined, 'no step ran');
    assert.equal(store.db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'demo'").get(), undefined);
    assert.ok(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'off_t'").get(), 'the official plugin migrated');
    assert.deepEqual(host.installed.map((p) => p.id), ['off', 'quiet'], 'a full-trust plugin with nothing pending stays');
  } finally { store.close(); }
});

test('a failed backup before a full-trust plugin\'s upgrade skips only that plugin', () => {
  const dir = tempDir();
  const path = join(dir, 'b.db');
  const official: OfficialPlugin = { id: 'off', version: '1.0.0', migrations: ['CREATE TABLE off_t (x)'] };
  const trusted: OfficialPlugin = { id: 'demo', version: '1.0.0', migrations: ['CREATE TABLE x_demo_t (x)'] };
  const dependent: OfficialPlugin = { id: 'demo-plus', version: '1.0.0', requires: ['demo'] };
  new Store(path, new PluginHost([official])).close();
  const skipped: string[] = [];
  const host = new PluginHost([official, trusted, dependent], [], { fullTrust: ['demo', 'demo-plus'], onSkip: (id) => skipped.push(id) });
  const store = new Store(path, host, undefined, undefined, { backup: () => { throw new Error('disk full'); } });
  try {
    assert.deepEqual(skipped, ['demo', 'demo-plus']);
    assert.match(host.skipped.get('demo')!, /升级前备份失败.*disk full/);
    assert.deepEqual(host.installed.map((p) => p.id), ['off']);
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'x_demo_t'").get(), undefined);
  } finally { store.close(); }
  assert.throws(() => new Store(path, new PluginHost([{ ...official, migrations: [...official.migrations!, 'CREATE TABLE off_two (x)'] }]),
    undefined, undefined, { backup: () => { throw new Error('disk full'); } }), /backup before it failed/, 'an official plugin\'s upgrade still stops the start');
});

test('purging a cluster says which unloaded plugins may still hold its data', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const plugin = writePlugin(dir, 'demo', '{ migrations: ["CREATE TABLE x_demo_rows (cluster_id TEXT)"] }');
  register(home, [plugin.manifest]);
  confirm(home, [{ id: 'demo', entry: plugin.entry }]);
  (await startTestHub({ dir, port: await freePort() }).then(async (app) => { await app.close(); }));
  confirm(home, []);
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    const { cluster } = await app.cluster('gone', ['A']);
    await app.api('DELETE', `/api/clusters/${cluster.id}`, {});
    const trashed = (await app.api('GET', '/api/clusters?deleted=true'))[0];
    const result = await app.api('POST', `/api/clusters/${cluster.id}/purge`, { name: 'gone', trashVersion: trashed.trashVersion });
    assert.deepEqual(result.pluginDataMayRemain, ['demo']);
  } finally { await app.close(); }
});

test('a purge blocked by a foreign key of an unloaded plugin deletes nothing and names the plugin', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const plugin = writePlugin(dir, 'refs', '{ migrations: ["CREATE TABLE x_refs_rows (cluster_id TEXT NOT NULL REFERENCES clusters(id))"] }');
  register(home, [plugin.manifest]);
  confirm(home, [{ id: 'refs', entry: plugin.entry }]);
  (await startTestHub({ dir, port: await freePort() }).then(async (app) => { await app.close(); }));
  confirm(home, []);   // revoked: its table stays, its clusterPurging does not run
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    const { cluster } = await app.cluster('held', ['A']);
    app.store.db.prepare('INSERT INTO x_refs_rows VALUES (?)').run(cluster.id);   // a row the plugin wrote while it ran
    await app.api('DELETE', `/api/clusters/${cluster.id}`, {});
    const trashed = (await app.api('GET', '/api/clusters?deleted=true'))[0];
    const res = await fetch(`${app.url}/api/clusters/${cluster.id}/purge`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'held', trashVersion: trashed.trashVersion }) });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.code, 'PLUGIN_DATA');
    assert.deepEqual(body.plugins, ['refs']);
    assert.match(body.error, /^nothing was deleted: FOREIGN KEY constraint failed; .* likely cause: refs$/);
    assert.ok((await app.api('GET', '/api/clusters?deleted=true')).some((c: { id: string }) => c.id === cluster.id), 'still in the recycle bin');
  } finally { await app.close(); }
});

/**
 * A full-trust plugin whose steps come from steps.json and whose default export fails while broken.flag exists: read on
 * every start, so a test can fix or break it without a new module (the import is cached for the whole test process).
 */
function growingPlugin(dir: string, id: string) {
  const folder = join(dir, `plugin-${id}`);
  mkdirSync(join(folder, 'hub'), { recursive: true });
  writeFileSync(join(folder, 'hub', 'index.mjs'), `import { existsSync, readFileSync } from 'node:fs';
export default () => {
  if (existsSync(new URL('../broken.flag', import.meta.url))) throw new Error('cannot load right now');
  return { migrations: JSON.parse(readFileSync(new URL('../steps.json', import.meta.url), 'utf8')) };
};
`);
  writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify({ id, version: '1.0.0', hostApi: 1, hubEntry: 'hub/index.mjs' }));
  const prefix = `x_${id.replaceAll('-', '_')}_`;
  return {
    manifest: join(folder, 'orrery-plugin.json'), entry: realpathSync.native(join(folder, 'hub', 'index.mjs')),
    failing: () => writeFileSync(join(folder, 'steps.json'), JSON.stringify([`CREATE TABLE ${prefix}one (x)`, 'CREATE TABLE nonsense'])),
    fixed: () => writeFileSync(join(folder, 'steps.json'), JSON.stringify([`CREATE TABLE ${prefix}one (x)`, `CREATE TABLE ${prefix}two (x)`])),
    broken: (on: boolean) => { if (on) writeFileSync(join(folder, 'broken.flag'), ''); else rmSync(join(folder, 'broken.flag'), { force: true }); },
  };
}

for (const disruption of ['safe mode', 'revoked', 'load failure'] as const) {
  test(`backup: a ${disruption} start in the middle of an unfinished upgrade does not end the baseline's protection`, async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const backups = join(home, 'backups');
    (await startTestHub({ dir, port: await freePort() }).then(async (app) => { await app.close(); }));   // an existing database
    const grow = growingPlugin(dir, 'grow');
    grow.failing();
    register(home, [grow.manifest]);
    confirm(home, [{ id: 'grow', entry: grow.entry }]);
    const start = async (opts: { safeMode?: boolean } = {}) => (await startTestHub({ dir, port: await freePort(), ...opts })).close();
    const auto = () => readdirSync(backups).filter((name) => name.endsWith('-pre-upgrade.db')).sort();
    const marker = () => existsSync(join(backups, 'pre-upgrade-baseline.txt'));
    await start();   // step 1 commits, step 2 fails: the first backup, of the state before step 1, is the baseline
    const original = auto()[0];
    for (let n = 0; n < 5; n++) await start();
    assert.ok(auto().includes(original) && auto().length === 5, 'failing starts: the baseline and the newest four');
    if (disruption === 'safe mode') await start({ safeMode: true });
    else if (disruption === 'revoked') { confirm(home, []); await start(); confirm(home, [{ id: 'grow', entry: grow.entry }]); }
    else { grow.broken(true); await start(); grow.broken(false); }
    assert.ok(marker() && auto().includes(original), `the ${disruption} start kept the marker and the original copy`);
    await start();   // back to normal, still failing
    assert.ok(marker(), 'the marker is still there');
    assert.ok(auto().includes(original), 'the copy from before step 1 still exists');
    assert.equal(auto().length, 5, 'and the total stays bounded');
    grow.fixed();
    await start();   // the upgrade completes
    assert.equal(marker(), false, 'a really complete start ends the sequence');
    assert.equal(auto().length, 5, 'and prunes to the newest five');
  });
}

test('backup: a missing full-trust manifest preserves the baseline of a partially migrated database', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const backups = join(home, 'backups');
  const marker = join(backups, 'pre-upgrade-baseline.txt');
  const start = async () => startTestHub({ dir, port: await freePort() });
  await (await start()).close();
  const first = growingPlugin(dir, 'first');
  const second = growingPlugin(dir, 'second');
  first.fixed();
  writeFileSync(join(dir, 'plugin-second', 'steps.json'), JSON.stringify(['CREATE TABLE nonsense']));
  register(home, [first.manifest, second.manifest]);
  confirm(home, [{ id: 'first', entry: first.entry }, { id: 'second', entry: second.entry }]);

  const app = await start();
  try {
    assert.ok(tableExists(app, 'x_first_one'));
    assert.equal(versionOf(app, 'second'), undefined);
  } finally { await app.close(); }
  const original = readFileSync(marker, 'utf8').trim();
  const auto = () => readdirSync(backups).filter((name) => name.endsWith('-pre-upgrade.db'));
  for (let n = 0; n < 5; n++) await (await start()).close();
  assert.equal(auto().length, 5);
  const manifest = readFileSync(second.manifest);
  rmSync(second.manifest);
  const withoutManifest = await start();
  try {
    const { skippedRegistrations } = await withoutManifest.api('GET', '/api/plugins');
    assert.ok(skippedRegistrations.some((row: { index: number; manifestPath: string | null }) =>
      row.index === 2 && row.manifestPath === second.manifest), 'settings can locate the missing registration without its plugin id');
  } finally { await withoutManifest.close(); }
  assert.equal(existsSync(marker), true, 'a still registered plugin with an unreadable manifest may owe migrations');
  writeFileSync(second.manifest, manifest);
  await (await start()).close();
  assert.equal(readFileSync(marker, 'utf8').trim(), original);
  assert.equal(auto().length, 5);
  assert.ok(auto().includes(original), 'the only backup before the first plugin migrated still exists');
  for (const name of auto()) {
    const db = new DatabaseSync(join(backups, name), { readOnly: true });
    try {
      assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'x_first_one'").get()), name !== original);
    } finally { db.close(); }
  }

  second.fixed();
  const config = join(home, 'external-plugins.json');
  const registrations = JSON.parse(readFileSync(config, 'utf8'));
  registrations.plugins.push({ manifest: join(dir, 'missing-restricted.json') });
  writeFileSync(config, JSON.stringify(registrations));
  await (await start()).close();
  assert.equal(existsSync(marker), false, 'a missing restricted manifest does not prevent completion');
  assert.equal(auto().length, 5);
  writeFileSync(join(dir, 'plugin-second', 'steps.json'), JSON.stringify([
    'CREATE TABLE x_second_one (x)', 'CREATE TABLE x_second_two (x)', 'CREATE TABLE x_second_three (x)',
  ]));
  await (await start()).close();
  assert.equal(auto().length, 5);
  assert.ok(!auto().includes(original), 'the next upgrade can rotate out the old baseline');
});

test('backup: a plugin revoked for good with a migration record keeps the baseline protected; the total stays bounded', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const backups = join(home, 'backups');
  (await startTestHub({ dir, port: await freePort() }).then(async (app) => { await app.close(); }));
  const grow = growingPlugin(dir, 'grow');
  grow.failing();
  register(home, [grow.manifest]);
  confirm(home, [{ id: 'grow', entry: grow.entry }]);
  (await startTestHub({ dir, port: await freePort() }).then(async (app) => { await app.close(); }));
  const auto = () => readdirSync(backups).filter((name) => name.endsWith('-pre-upgrade.db')).sort();
  const original = auto()[0];
  confirm(home, []);   // revoked for good; its plugin_migrations row stays
  // Later upgrades of something else: each start has a new step to run, so each makes a backup.
  for (let steps = 1; steps <= 7; steps++) {
    const other: OfficialPlugin = { id: 'other', version: '1.0.0', migrations: Array.from({ length: steps }, (_, i) => `CREATE TABLE other_${i} (x)`) };
    (await startTestHub({ dir, port: await freePort(), plugins: [...officialPlugins, other] }).then(async (app) => { await app.close(); }));
  }
  assert.ok(existsSync(join(backups, 'pre-upgrade-baseline.txt')), 'the marker stays while grow’s record remains');
  assert.ok(auto().includes(original), 'the baseline is kept');
  assert.equal(auto().length, 5, 'the baseline and the newest four, no more');
});

test('a purge that a loaded plugin’s hook refuses keeps that plugin’s error; unloaded plugins are only a side note', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const archived = writePlugin(dir, 'archived-notes', '{ migrations: ["CREATE TABLE x_archived_notes_rows (note TEXT)"] }');   // empty, no foreign key
  register(home, [archived.manifest]);
  confirm(home, [{ id: 'archived-notes', entry: archived.entry }]);
  (await startTestHub({ dir, port: await freePort() }).then(async (app) => { await app.close(); }));
  confirm(home, []);   // revoked
  const current: OfficialPlugin = { id: 'current-notes', version: '1.0.0', clusterPurging: () => { throw new Error('the archive service is down'); } };
  const app = await startTestHub({ dir, port: await freePort(), plugins: [...officialPlugins, current] });
  try {
    const { cluster } = await app.cluster('kept', ['A']);
    await app.api('DELETE', `/api/clusters/${cluster.id}`, {});
    const trashed = (await app.api('GET', '/api/clusters?deleted=true'))[0];
    const res = await fetch(`${app.url}/api/clusters/${cluster.id}/purge`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'kept', trashVersion: trashed.trashVersion }) });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'PLUGIN_HOOK_FAILED', 'the real failure, not PLUGIN_DATA');
    assert.match(body.error, /^plugin current-notes failed in clusterPurging: the archive service is down; nothing was changed; besides, .* may still hold this cluster's data: archived-notes$/);
    assert.ok((await app.api('GET', '/api/clusters?deleted=true')).some((c: { id: string }) => c.id === cluster.id), 'still in the recycle bin');
    const trash = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'trash.js')).href);
    const shown = trash.purgeOutcome({ ok: false, status: res.status, data: body });
    assert.equal(shown.tone, 'refused');
    assert.ok(shown.text.startsWith('没有删除：plugin current-notes failed in clusterPurging: the archive service is down'), shown.text);
    assert.equal(shown.text.includes('很可能就是删不掉的原因'), false, 'the revoked plugin is not blamed');
  } finally { await app.close(); }
});

/** A page module folder `web/` next to a plugin's `hub/`, named in its manifest as webEntry. */
function writeWebPlugin(dir: string, id: string, manifest: Record<string, unknown> = {}) {
  const plugin = writePlugin(dir, id, '{}', { webEntry: 'web/index.js', ...manifest });
  mkdirSync(join(plugin.folder, 'web'), { recursive: true });
  writeFileSync(join(plugin.folder, 'web', 'index.js'), 'export function register() { return {}; }');
  return plugin;
}

/** What any unknown non-API path answers: the static file service's 404. */
async function assertUnknown(app: TestHub, path: string, init?: RequestInit) {
  const res = await rawFetch(`${app.url}${path}`, init);
  assert.equal(res.status, 404, path);
  assert.deepEqual(await res.json(), { error: 'not found' }, path);
}

test('webModule in a full-trust manifest is refused before the import; webEntry must sit in a sub-folder without the Hub entry', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const module = writePlugin(dir, 'with-module', '{}', { webModule: 'with-module' });
  const top = writePlugin(dir, 'web-top', '{}', { webEntry: 'index.js' });
  const beside = writePlugin(dir, 'web-beside', '{}', { webEntry: 'hub/page.js' });
  writeFileSync(join(beside.folder, 'hub', 'page.js'), 'export function register() { return {}; }');
  const escape = writePlugin(dir, 'web-escape', '{}', { webEntry: 'web/../../x/index.js' });
  register(home, [module.manifest, top.manifest, beside.manifest, escape.manifest]);
  confirm(home, [{ id: 'with-module', entry: module.entry }, { id: 'web-top', entry: top.entry }, { id: 'web-beside', entry: beside.entry },
    { id: 'web-escape', entry: escape.entry }]);
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    const withModule = await cardOf(app, 'with-module');
    assert.equal(withModule.trust!.state, 'failed');
    assert.match(withModule.trust!.error ?? '', /webModule is an official plugin's field; a full-trust plugin names its page module in webEntry/);
    assert.deepEqual(module.marker(), [], 'decided from the manifest, nothing imported');
    assert.deepEqual(beside.marker(), [], 'decided from the manifest, nothing imported');
    assert.match((await cardOf(app, 'web-beside')).trust!.error ?? '', /must be a sub-folder that does not hold the Hub entry/);
    // A manifest that does not parse is a registration failure, shown with its reason.
    const listing = await app.api('GET', '/api/plugins');
    const failures = JSON.stringify(listing);
    for (const id of ['web-top', 'web-escape']) assert.match(failures, new RegExp(`"reason":"plugin ${id}: webEntry must be a relative \\.js file in a sub-folder`), id);
    assert.deepEqual(top.marker(), []);
    assert.deepEqual(escape.marker(), []);
    assert.deepEqual(listing.trustedFrontend, []);
  } finally { await app.close(); }
});

test('the web folder and the Hub entry are compared by their spelling on disk', { skip: process.platform !== 'win32' && 'needs a case-insensitive file system' }, async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const folder = join(dir, 'case');
  mkdirSync(join(folder, 'web'), { recursive: true });
  writeFileSync(join(folder, 'web', 'hub.js'), 'export default () => ({});');
  writeFileSync(join(folder, 'web', 'index.js'), 'export function register() { return {}; }');
  writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify({ id: 'case', version: '1.0.0', hostApi: 1, hubEntry: 'web/hub.js', webEntry: 'WEB/index.js' }));
  register(home, [join(folder, 'orrery-plugin.json')]);
  confirm(home, [{ id: 'case', entry: realpathSync.native(join(folder, 'web', 'hub.js')) }]);
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    const card = await cardOf(app, 'case');
    assert.equal(card.trust!.state, 'failed');
    assert.match(card.trust!.error ?? '', /must be a sub-folder that does not hold the Hub entry/);
    for (const path of ['/plugin-web/case/', '/plugin-web/case/hub.js', '/plugin-web/case/HUB.JS', '/plugin-web/case/index.js']) await assertUnknown(app, path);
  } finally { await app.close(); }
});

test('/plugin-web/ serves a loaded plugin\'s page module folder read-only: no traversal, links, HTML, oversized files or Hub entry', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const shown = writeWebPlugin(dir, 'shown');
  const web = join(shown.folder, 'web');
  mkdirSync(join(web, 'lib'));
  writeFileSync(join(web, 'lib', 'util.js'), 'export const x = 1;');
  writeFileSync(join(web, 'page.html'), '<p>no</p>');
  writeFileSync(join(web, 'big.js'), 'x'.repeat(1024 * 1024 + 1));
  writeFileSync(join(web, '.hidden.js'), 'export const h = 1;');
  writeFileSync(join(shown.folder, 'secret.js'), 'export const s = 1;');
  mkdirSync(join(dir, 'outside-dir'));
  writeFileSync(join(dir, 'outside-dir', 'leak.js'), 'export const leak = 1;');
  symlinkSync(join(dir, 'outside-dir'), join(web, 'linked'), 'junction');
  let fileLink = true;
  try { symlinkSync(join(dir, 'outside-dir', 'leak.js'), join(web, 'leak.js'), 'file'); } catch { fileLink = false; }   // may need a privilege on Windows
  linkSync(join(shown.folder, 'hub', 'index.mjs'), join(web, 'entry.js'));   // the Hub entry under another name (a hard link)
  register(home, [shown.manifest]);
  confirm(home, [{ id: 'shown', entry: shown.entry }]);
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    const entry = await rawFetch(`${app.url}/plugin-web/shown/`);   // no login, like the page's own files
    assert.equal(entry.status, 200);
    assert.equal(entry.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(entry.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(entry.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(entry.headers.get('cache-control'), 'no-store');
    assert.match(entry.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
    assert.match(await entry.text(), /export function register/);
    assert.equal((await rawFetch(`${app.url}/plugin-web/shown/lib/util.js`)).status, 200);
    assert.equal((await rawFetch(`${app.url}/plugin-web/shown/index.js`)).status, 200);
    if (process.platform === 'win32') assert.equal((await rawFetch(`${app.url}/plugin-web/shown/LIB/Util.JS`)).status, 200, 'the same file in another case');
    const refused = ['/plugin-web/shown/page.html', '/plugin-web/shown/big.js', '/plugin-web/shown/.hidden.js', '/plugin-web/shown/../secret.js',
      '/plugin-web/shown/%2e%2e/secret.js', '/plugin-web/shown/%2E%2E%2Fsecret.js', '/plugin-web/shown/lib%2Futil.js', '/plugin-web/shown/..%5Csecret.js',
      '/plugin-web/shown/linked/leak.js', '/plugin-web/shown/entry.js', '/plugin-web/shown/ENTRY.JS', '/plugin-web/shown/%2e%2e/hub/index.mjs',
      '/plugin-web/shown/lib/', '/plugin-web/shown', '/plugin-web/shown/C:/Windows/win.ini', '/plugin-web/shown/con.js', '/plugin-web/Shown/',
      '/plugin-web/bookmarks/', '/plugin-web/no-such/', ...(fileLink ? ['/plugin-web/shown/leak.js'] : [])];
    for (const path of refused) await assertUnknown(app, path);
    await assertUnknown(app, '/plugin-web/shown/', { method: 'POST' });
    const listing = await app.api('GET', '/api/plugins');
    assert.deepEqual(listing.trustedFrontend, ['shown']);
    assert.deepEqual(listing.frontend, ['bookmarks'], 'the official list is unchanged');
    // The Hub entry moved (or rebuilt) after the start: the page module folder is still served.
    renameSync(join(shown.folder, 'hub', 'index.mjs'), join(shown.folder, 'hub', 'moved.mjs'));
    assert.equal((await rawFetch(`${app.url}/plugin-web/shown/`)).status, 200, 'the module after the entry moved');
    assert.equal((await rawFetch(`${app.url}/plugin-web/shown/lib/util.js`)).status, 200);
  } finally { await app.close(); }
});

test('trustedFrontend lists a page module only while its plugin is confirmed, loaded and enabled this start; nothing else is served', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const ok = writeWebPlugin(dir, 'ok-web');
  const unconfirmed = writeWebPlugin(dir, 'unconfirmed-web');
  const broken = writeWebPlugin(dir, 'broken-web');
  writeFileSync(join(broken.folder, 'hub', 'index.mjs'), 'throw new Error("broken on purpose");');
  const badMigration = writePlugin(dir, 'migrate-web', '{ migrations: ["CREATE TABLE elsewhere (x)"] }', { webEntry: 'web/index.js' });
  mkdirSync(join(badMigration.folder, 'web'));
  writeFileSync(join(badMigration.folder, 'web', 'index.js'), 'export function register() { return {}; }');
  const noWeb = writePlugin(dir, 'no-web', '{}');
  register(home, [ok.manifest, unconfirmed.manifest, broken.manifest, badMigration.manifest, noWeb.manifest]);
  const all = [{ id: 'ok-web', entry: ok.entry }, { id: 'broken-web', entry: broken.entry }, { id: 'migrate-web', entry: badMigration.entry }, { id: 'no-web', entry: noWeb.entry }];
  confirm(home, all);
  const served = async (app: TestHub, id: string) => (await rawFetch(`${app.url}/plugin-web/${id}/`)).status === 200;
  const listed = async (app: TestHub) => (await app.api('GET', '/api/plugins')).trustedFrontend;
  let app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.deepEqual(await listed(app), ['ok-web'], 'loaded and enabled; not unconfirmed, failed to import, failed to migrate or without a module');
    assert.equal((await cardOf(app, 'broken-web')).trust!.state, 'failed');
    assert.equal((await cardOf(app, 'migrate-web')).trust!.state, 'failed');
    assert.equal(await served(app, 'ok-web'), true);
    for (const id of ['unconfirmed-web', 'broken-web', 'migrate-web', 'no-web']) await assertUnknown(app, `/plugin-web/${id}/`);
    await app.close();

    writePluginsFile(home, { trusted: all, disabled: ['ok-web'] });   // switched off: imported for its migrations only
    app = await startTestHub({ dir, port: await freePort() });
    assert.deepEqual(await listed(app), [], 'switched off');
    await assertUnknown(app, '/plugin-web/ok-web/');
    await app.close();

    writePluginsFile(home, { trusted: all, disabled: [] });
    app = await startTestHub({ dir, port: await freePort(), safeMode: true });
    assert.deepEqual(await listed(app), [], 'safe mode');
    await assertUnknown(app, '/plugin-web/ok-web/');
    await app.close();

    confirm(home, all.filter((c) => c.id !== 'ok-web'));   // revoked
    app = await startTestHub({ dir, port: await freePort() });
    assert.deepEqual(await listed(app), [], 'revoked');
    await assertUnknown(app, '/plugin-web/ok-web/');
    await app.close();

    confirm(home, all);
    app = await startTestHub({ dir, port: await freePort() });
    assert.deepEqual(await listed(app), ['ok-web'], 'confirmed again');
    assert.equal(await served(app, 'ok-web'), true);
  } finally { await app.close(); }
});

test('the example plugin: its table, its routes, its member tool and its purge hook', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const folder = join(dir, 'trusted-demo');
  cpSync(join(REPO_ROOT, 'examples', 'hub-plugins', 'trusted-demo'), folder, { recursive: true });
  register(home, [join(folder, 'orrery-plugin.json')]);
  confirm(home, [{ id: 'trusted-demo', entry: realpathSync.native(join(folder, 'hub', 'index.mjs')) }]);
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    assert.equal(tableExists(app, 'x_trusted_demo_notes'), true);
    const { cluster } = await app.hub.createCluster('demo', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const path = `/api/x/trusted-demo/clusters/${cluster.id}/notes`;
    assert.deepEqual((await app.api('POST', path, { body: '用户的便签' })).notes.map((n: { body: string }) => n.body), ['用户的便签']);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const mcp = async (method: string, params: Record<string, unknown> = {}) => ((await (await fetch(`${app.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-harness': 'mock', 'x-orrery-session': 's1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: any }).result;
    assert.ok((await mcp('tools/list')).tools.some((t: { name: string }) => t.name === 'trusted_demo_note'));
    const called = await mcp('tools/call', { name: 'trusted_demo_note', arguments: { operationId: 'n1', body: '成员的便签' } });
    assert.notEqual(called.isError, true, called.content?.[0]?.text);
    assert.deepEqual((await app.api('GET', path)).notes.map((n: { author: string; body: string }) => `${n.author}:${n.body}`), ['A:成员的便签', '用户:用户的便签']);
    assert.deepEqual((await app.api('GET', '/api/plugins')).trustedFrontend, ['trusted-demo']);
    assert.match(await (await rawFetch(`${app.url}/plugin-web/trusted-demo/`)).text(), /export function register/);
    await app.api('DELETE', `/api/clusters/${cluster.id}`, {});
    const trashed = (await app.api('GET', '/api/clusters?deleted=true'))[0];
    await app.api('POST', `/api/clusters/${cluster.id}/purge`, { name: 'demo', trashVersion: trashed.trashVersion });
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM x_trusted_demo_notes').get()!.n, 0, 'the hook cleaned its rows');
  } finally { await app.close(); }
});

test('icons work exactly as for restricted plugins, confirmed or not; a bad icon never blocks loading; a damaged plugins.json does not break the list', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
  const on = writePlugin(dir, 'icon-on', '{}', { icon: 'icon.svg' });
  const off = writePlugin(dir, 'icon-off', '{}', { icon: 'icon.svg' });
  for (const p of [on, off]) writeFileSync(join(p.folder, 'icon.svg'), svg);
  const outside = writePlugin(dir, 'icon-outside', '{}', { icon: '../elsewhere.svg' });
  const text = writePlugin(dir, 'icon-text', '{}', { icon: 'icon.txt' });
  writeFileSync(join(text.folder, 'icon.txt'), 'not an image');
  register(home, [on, off, outside, text].map((p) => p.manifest));
  confirm(home, [{ id: 'icon-on', entry: on.entry }, { id: 'icon-outside', entry: outside.entry }, { id: 'icon-text', entry: text.entry }]);
  const app = await startTestHub({ dir, port: await freePort() });
  try {
    type IconCard = Card & { iconUrl: string | null; iconError?: string };
    const card = async (id: string) => (await cardOf(app, id)) as IconCard;
    for (const id of ['icon-on', 'icon-off']) {
      assert.equal((await card(id)).iconUrl, `/api/plugins/${id}/icon`, id);
      const res = await fetch(`${app.url}/api/plugins/${id}/icon`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/svg+xml');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.deepEqual([(await card('icon-on')).trust!.state, (await card('icon-off')).trust!.state], ['loaded', 'unconfirmed']);
    assert.deepEqual(off.marker(), [], 'showing the icon of an unconfirmed plugin runs none of its code');
    for (const [id, folder, icon] of [['icon-outside', outside.folder, '../elsewhere.svg'], ['icon-text', text.folder, 'icon.txt']] as const) {
      const c = await card(id);
      assert.equal(c.iconUrl, null, id);
      assert.equal(c.iconError, (readPluginIcon(realpathSync.native(folder), icon, false) as { error: string }).error, `${id}: refused with the restricted tier's own reason`);
      assert.equal(c.trust!.state, 'loaded', `${id}: a bad icon does not block loading`);
      assert.equal((await fetch(`${app.url}/api/plugins/${id}/icon`)).status, 404);
    }
    // plugins.json damaged while the Hub runs: the list still answers, with the confirmations read at start-up and why.
    writeFileSync(join(home, 'plugins.json'), '{ not json');
    const c = await card('icon-on');
    assert.deepEqual([c.trust!.state, c.trust!.confirmed], ['loaded', true]);
    assert.match((c.trust as { fileError?: string }).fileError ?? '', /not valid JSON/);
  } finally { await app.close(); }
});

test('page helpers: the purge notice, the card state and the confirm text', async () => {
  const pub = join(REPO_ROOT, 'src', 'web', 'public');
  const trash = await import(pathToFileURL(join(pub, 'trash.js')).href);
  const cards = await import(pathToFileURL(join(pub, 'plugins.js')).href);
  assert.deepEqual(trash.purgeOutcome({ ok: true, data: { filesFailed: [], pluginDataMayRemain: ['demo'] } }),
    { tone: 'partial', text: '已永久删除，但插件 demo 这次没有运行，它们的数据表里可能还留着这个群的数据' });
  const row = (trust: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'demo', name: 'Demo', enabled: true, pendingEnabled: true, trust, ...extra });
  const state = (trust: Record<string, unknown>, extra?: Record<string, unknown>) => cards.pluginState(row(trust, extra)).text;
  assert.equal(state({ state: 'unconfirmed', confirmed: false }), '未确认信任，没有运行');
  assert.equal(state({ state: 'unconfirmed', confirmed: true }), '重启 Hub 后生效：将加载');
  assert.equal(state({ state: 'loaded', confirmed: false }), '重启 Hub 后生效：将不再加载（已撤销信任）');
  assert.equal(state({ state: 'loaded', confirmed: true }, { enabled: false, pendingEnabled: false }), '已停用：只运行迁移和清理');
  assert.equal(state({ state: 'loaded', confirmed: true }), '已启用');
  assert.equal(state({ state: 'safe-mode', confirmed: true }), '安全模式：这次没有加载');
  assert.equal(state({ state: 'path-changed', confirmed: false }), '入口路径变了，需要重新确认');
  const text = cards.trustConfirmText({ name: 'Demo', trust: { entry: 'C:/p/hub.mjs' } });
  assert.match(text.message, /和 orrery 本身拥有相同的权限/);
  assert.match(text.message, /网页模块（如果有）和 orrery 的页面在同一页里运行/);
  assert.match(text.message, /入口文件：C:\/p\/hub\.mjs/);
  assert.equal(text.danger, true);

  // After a Hub restart: what the page detaches and what only a reload would load.
  const slots = await import(pathToFileURL(join(pub, 'plugin-slots.js')).href);
  const off = new Set(['gone-earlier']);
  const change = (trusted: string[], listed: unknown, tried = trusted) => slots.trustedChange({ trusted, tried }, { trustedFrontend: listed }, (id: string) => off.has(id));
  assert.deepEqual(change(['a', 'b'], ['a', 'b']), { stale: [], fresh: [] }, 'an unchanged list');
  assert.deepEqual(change(['a', 'b'], ['b']), { stale: ['a'], fresh: [] }, 'revoked, switched off, safe mode or failed');
  assert.deepEqual(change(['a'], ['a', 'c']), { stale: [], fresh: ['c'] }, 'newly confirmed');
  assert.deepEqual(change(['a', 'gone-earlier'], ['a', 'gone-earlier']), { stale: [], fresh: ['gone-earlier'] }, 'listed again: stays detached, a reload loads it');
  assert.deepEqual(change(['a'], undefined), { stale: ['a'], fresh: [] }, 'safe mode lists none');
  // A module that failed to load or register here: nothing to detach when it drops out, nothing to offer while listed.
  assert.deepEqual(change(['a'], ['a', 'failed'], ['a', 'failed']), { stale: [], fresh: [] });
  assert.deepEqual(change(['a'], ['a'], ['a', 'failed']), { stale: [], fresh: [] });
  // Which Hub start the page compares with: the one its plugin list came from, also when the Hub restarted during the load.
  assert.equal(slots.hubStartChanged('start-a', { app: 'orrery', pid: 7, instance: 'start-a' }), false, 'the same start');
  assert.equal(slots.hubStartChanged('start-a', { app: 'orrery', pid: 7, instance: 'start-b' }), true, 'a restart, even with the same pid');
  assert.equal(slots.hubStartChanged(null, { app: 'orrery', pid: 7, instance: 'start-b' }), false, 'nothing loaded to compare with');
  assert.equal(slots.hubStartChanged('start-a', { app: 'other', instance: 'start-b' }), false);
  assert.equal(slots.hubStartChanged('start-a', { app: 'orrery', pid: 8 }), false, 'a Hub without starts to tell apart');
  assert.equal(slots.trustNoticeText([], []), '');
  const one = slots.trustNoticeText(['便签'], []);
  assert.match(one, /不再加载完全信任插件“便签”/);
  assert.match(one, /页面已移除它经插件接口加入的内容，不再调用它；它的代码还留在这个页面里，刷新页面后彻底生效。$/);
  assert.match(slots.trustNoticeText(['A', 'B'], ['C']), /“A”、“B”.*它们的代码.*刷新页面后彻底生效。 完全信任插件“C”现在可以加载，刷新页面后加载。$/);
  assert.equal(slots.trustNoticeText([], ['C']), '完全信任插件“C”现在可以加载，刷新页面后加载。');
});
