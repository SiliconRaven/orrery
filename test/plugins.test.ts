// The plugin host (docs/plugins.md): registry validation, per-plugin migrations and the slots, with a throwaway plugin
// next to the real bookmarks plugin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { disabledPluginsOf, readDisabledPlugins, writeDisabledPlugins } from '../src/config.ts';
import { CollaborationError } from '../src/core/collaboration.ts';
import type { CollaborationActor, CollaborationCommand, CollaborationResult, CollectionsResult, CoordinatorPolicy } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost, type OfficialPlugin } from '../src/core/plugin.ts';
import { PluginSettings } from '../src/core/plugin-settings.ts';
import { Store } from '../src/core/store.ts';
import { fingerprintTools } from '../src/mcp/tool-fingerprint.ts';
import { bookmarksOf } from '../src/plugins/bookmarks/index.ts';
import { saveCoordinator } from '../src/plugins/coordinator/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { rawFetch, startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

const plugin = (id: string, extra: Partial<OfficialPlugin> = {}): OfficialPlugin => ({ id, version: '1.0.0', ...extra });
const versionOf = (store: Store, id: string) =>
  (store.db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?').get(id) as { version: number } | undefined)?.version;

test('requires: a plugin whose dependency is disabled is refused with a message naming both', () => {
  const plugins = [plugin('tasks'), plugin('coordinator', { requires: ['tasks'] })];
  assert.deepEqual(new PluginHost(plugins).enabled.map((p) => p.id), ['tasks', 'coordinator']);
  assert.throws(() => new PluginHost(plugins, ['tasks']), /coordinator cannot be enabled: it requires tasks, which is disabled/);
  assert.deepEqual(new PluginHost(plugins, ['tasks', 'coordinator']).enabled, [], 'disabling both is fine');
  assert.deepEqual(new PluginHost(plugins, ['coordinator']).enabled.map((p) => p.id), ['tasks'], 'the dependency alone stays on');
});

test('the registry and the disabled list are checked', () => {
  assert.throws(() => new PluginHost([plugin('a', { requires: ['b'] }), plugin('b')]), /requires b, which must be registered before it/);
  assert.throws(() => new PluginHost([plugin('a', { requires: ['ghost'] })]), /requires ghost/);
  assert.throws(() => new PluginHost([plugin('a'), plugin('a')]), /registered twice/);
  assert.throws(() => new PluginHost([plugin('Bad Id')]), /invalid plugin id/);
  assert.throws(() => new PluginHost([plugin('a', { webModule: '../app' })]), /invalid web module for plugin a/);
  assert.throws(() => new PluginHost([plugin('a')], ['typo']), /cannot disable unknown plugin typo; registered plugins: a/);
  assert.deepEqual(disabledPluginsOf({ ORRERY_DISABLED_PLUGINS: ' a, ,b ' }), ['a', 'b']);
  assert.deepEqual(disabledPluginsOf({}), []);
  assert.throws(() => new PluginHost([plugin('a', { actions: { 'x.go': () => ({}) } }), plugin('b', { actions: { 'x.go': () => ({}) } })]),
    /plugin b registers action x.go, which is already taken/);
  const twice = { 'x.go': () => ({}) };
  assert.ok(new PluginHost([plugin('a', { actions: twice }), plugin('b', { actions: twice })], ['a']).action('x.go'), 'a disabled plugin claims nothing');
});

test('migrations: each plugin keeps its own version, applied once and resumed after an upgrade', () => {
  const path = join(tempDir(), 'p.db');
  const a = plugin('a', { migrations: ['CREATE TABLE a_one (x)'] });
  const b = plugin('b', { migrations: ['CREATE TABLE b_one (x)', 'CREATE TABLE b_two (x)'] });
  let store = new Store(path, new PluginHost([a, b]));
  assert.deepEqual([versionOf(store, 'a'), versionOf(store, 'b')], [1, 2]);
  store.close();
  // Reopening runs nothing again (CREATE TABLE without IF NOT EXISTS would throw), and a new step runs alone.
  store = new Store(path, new PluginHost([{ ...a, migrations: [...a.migrations!, 'CREATE TABLE a_two (x)'] }, b]));
  assert.deepEqual([versionOf(store, 'a'), versionOf(store, 'b')], [2, 2]);
  store.close();
});

test('migrations: a disabled plugin is still migrated; a failing step rolls back with its version; a newer database is refused', () => {
  const path = join(tempDir(), 'p.db');
  let store = new Store(path, new PluginHost([plugin('a', { migrations: ['CREATE TABLE a_one (x)'] })], ['a']));
  assert.equal(versionOf(store, 'a'), 1);
  store.close();
  const bad = plugin('a', { migrations: ['CREATE TABLE a_one_more (x)', 'CREATE TABLE half (x); CREATE TABLE nonsense'] });
  const failedPath = join(tempDir(), 'r.db');
  assert.throws(() => new Store(failedPath, new PluginHost([bad])));
  store = new Store(failedPath);
  assert.equal(versionOf(store, 'a'), 1, 'the step before the failure stays');
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get(), undefined, 'the failing step left nothing');
  store.close();
  assert.throws(() => new Store(path, new PluginHost([plugin('a')])), /plugin a: unsupported database schema version 1/);
});

// A throwaway plugin that writes to its own table: it proves what the actions slot shares with the core's commands.
let journalRuns = 0;
const journal = plugin('journal', {
  migrations: ['CREATE TABLE journal (note TEXT)'],
  actions: {
    'journal.add': ({ store, command }) => {
      journalRuns++;
      store.db.prepare('INSERT INTO journal VALUES (?)').run(command.reason ?? 'note');
      if (command.reason === 'boom') throw new CollaborationError('INVALID_STATE', 'boom after writing');
      return { note: command.reason };
    },
    'journal.managed': ({ store, management }) => {
      if (management('taskPlanning')) return {};
      store.db.prepare('INSERT INTO journal VALUES (?)').run('managed');
      return { wrote: true };
    },
  },
});

function fixture(host = new PluginHost([...officialPlugins, journal]), dir?: string) {
  const store = new Store(dir ? join(dir, 'test.db') : ':memory:', host);
  const member = (id: string) => ({ id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null });
  if (!store.getCluster('c')) store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, [member('a'), member('coord')]);
  const hub = new Hub({ store, nativeAdapters: {} });
  const user: CollaborationActor = { kind: 'user' };
  const a: CollaborationActor = { kind: 'member', memberId: 'a' };
  const coord: CollaborationActor = { kind: 'member', memberId: 'coord' };
  let serial = 0;
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'> & { operationId?: string }) =>
    hub.collaboration.command(actor, 'c', { operationId: 'op-' + ++serial, ...command }) as CollaborationResult & Record<string, unknown>;
  const rows = () => Number((store.db.prepare('SELECT COUNT(*) AS n FROM journal').get() as { n: number }).n);
  const message = (id: string) => store.insertMessage({ id, clusterId: 'c', from: 'user', mentions: [], body: 'body of ' + id,
    replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString() }, []);
  return { store, hub, user, a, coord, send, rows, message };
}

test('actions: a plugin action runs in the command transaction, and a failure rolls everything back', () => {
  const { store, user, send, rows } = fixture();
  try {
    const eventsBefore = store.lastEventSeq();
    assert.throws(() => send(user, { action: 'journal.add', operationId: 'once', reason: 'boom' }), /boom after writing/);
    assert.equal(rows(), 0, 'the plugin write is gone');
    assert.equal(store.lastEventSeq(), eventsBefore, 'no event was written');
    assert.equal(store.collaborationOperation('c', 'user', 'once'), null, 'the operation was not recorded, so the same id can run again');
    const done = send(user, { action: 'journal.add', operationId: 'once', reason: 'fine' });
    assert.equal(rows(), 1);
    assert.equal(done.note, 'fine', 'the action adds to the core result');
    assert.ok(done.eventId > eventsBefore, 'the core wrote the event after the action');
    assert.deepEqual((store.getEvent(done.eventId)!.payload as { action: string }).action, 'journal.add');
  } finally { store.close(); }
});

test('actions: the same operationId replays the stored result and a different request conflicts', () => {
  const { store, user, send, rows } = fixture();
  try {
    const first = send(user, { action: 'journal.add', operationId: 'same', reason: 'a' });
    const runs = journalRuns;
    assert.deepEqual(send(user, { action: 'journal.add', operationId: 'same', reason: 'a' }), first);
    assert.equal(journalRuns, runs, 'the handler did not run again');
    assert.equal(rows(), 1);
    assert.throws(() => send(user, { action: 'journal.add', operationId: 'same', reason: 'b' }), /already used for a different command/);
  } finally { store.close(); }
});

test('actions: the core checks identity and the coordinator permissions before a plugin writes', () => {
  const { store, user, a, coord, send, rows } = fixture();
  try {
    assert.throws(() => send({ kind: 'member', memberId: 'ghost' }, { action: 'journal.add' }), /unknown member/);
    assert.throws(() => send(a, { action: 'journal.managed' }), /not permitted/);
    assert.equal(rows(), 0);
    assert.equal(send(user, { action: 'journal.managed' }).wrote, true);
    assert.equal(rows(), 1);
    const policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'suggest' }).coordinator!;
    const suggested = send(coord, { action: 'journal.managed', generation: policy.generation });
    assert.ok(suggested.suggestion, 'suggest mode records a suggestion');
    assert.equal(rows(), 1, 'and writes nothing');
    assert.throws(() => send(user, { action: 'nobody.registered' }), /unsupported collaboration action/);
  } finally { store.close(); }
});

test('bookmarks: actions and the collections query run through the slots with the old results', () => {
  const { store, hub, user, a, send, message } = fixture();
  try {
    message('m1');
    const set = send(user, { action: 'bookmark.set', operationId: 'star', messageId: 'm1', labels: ['keep'] });
    assert.deepEqual(Object.keys(set), ['action', 'eventId', 'bookmark', 'messageId']);
    assert.deepEqual(send(user, { action: 'bookmark.set', operationId: 'star', messageId: 'm1', labels: ['keep'] }), set, 'a retry replays');
    assert.deepEqual(bookmarksOf(store, 'm1').map((b) => b.labels), [['keep']]);
    assert.throws(() => send(a, { action: 'bookmark.set', messageId: 'nope' }), /unknown message/);
    assert.throws(() => send(a, { action: 'bookmark.set', messageId: 'm1', labels: [1 as unknown as string] }), /labels must contain/);
    const page = hub.collaboration.query(user, 'c', { kind: 'collections', memberId: 'user', label: 'keep' }) as CollectionsResult;
    assert.deepEqual(page.items.map((item) => item.message.id), ['m1']);
    assert.deepEqual(Object.keys(page.items[0]), ['message', 'taskIds', 'bookmarks', 'attachments']);
    assert.deepEqual((hub.collaboration.query(user, 'c', { kind: 'collections', label: 'other' }) as CollectionsResult).items, []);
    assert.throws(() => hub.collaboration.query(user, 'c', { kind: 'collections', memberId: 'ghost' }), /unknown member/);
    assert.throws(() => hub.collaboration.query(user, 'c', { kind: 'collections', taskId: 'ghost' }), /unknown task/);
    assert.equal(send(a, { action: 'bookmark.remove', messageId: 'm1' }).bookmark, null);
    assert.equal(bookmarksOf(store, 'm1').length, 1, "a member removes only their own");
  } finally { store.close(); }
});

test('bookmarks: an old database keeps its bookmarks through the upgrade to v24 and the plugin migration', () => {
  const dir = tempDir();
  let { store, user, send, message } = fixture(new PluginHost(officialPlugins), dir);
  message('m1');
  send(user, { action: 'bookmark.set', operationId: 'star', messageId: 'm1', labels: ['old'] });
  const before = bookmarksOf(store, 'm1');
  // What a v23 database looks like: the bookmark table from the core schema, no plugin bookkeeping.
  store.db.exec('DROP TABLE plugin_migrations; ALTER TABLE messages DROP COLUMN fyi; DROP TRIGGER deliveries_state_seq_insert; DROP TRIGGER deliveries_state_seq_update; ALTER TABLE deliveries DROP COLUMN state_seq; ALTER TABLE deliveries DROP COLUMN dismissed_at; ALTER TABLE reads DROP COLUMN seen_at; ALTER TABLE members DROP COLUMN hidden_at; ALTER TABLE members DROP COLUMN unread_after_rowid; ALTER TABLE messages DROP COLUMN system_kind; ALTER TABLE messages DROP COLUMN explicit_mentions_json; PRAGMA user_version = 23');
  store.close();
  ({ store } = fixture(new PluginHost(officialPlugins), dir));
  try {
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30);
    assert.equal(versionOf(store, 'bookmarks'), 1);
    assert.deepEqual(bookmarksOf(store, 'm1'), before);
  } finally { store.close(); }
});

test('bookmarks: a fresh database gets the table from the plugin, not from the core schema', () => {
  const bare = new Store(':memory:');
  const withPlugin = new Store(':memory:', new PluginHost(officialPlugins));
  const has = (store: Store) => !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'collaboration_bookmarks'").get();
  try {
    assert.equal(has(bare), false);
    assert.equal(has(withPlugin), true);
    assert.equal(versionOf(withPlugin, 'bookmarks'), 1);
  } finally { bare.close(); withPlugin.close(); }
});

const toolsOf = async (app: TestHub) => {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const response = await fetch(`${app.url}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  return ((await response.json()) as { result: { tools: { name: string }[] } }).result.tools;
};

test('tools: enabled, the two bookmark tools are exactly the ones from before the plugin system', async () => {
  const app = await startTestHub();
  try {
    const two = (await toolsOf(app)).filter((tool) => tool.name === 'list_bookmarks' || tool.name === 'bookmark_message');
    assert.equal(two.length, 2);
    // shortcut: a golden hash of these two definitions, the rest of the list is free to change; update it only when the tools are meant to change.
    assert.equal(fingerprintTools(two), 'sha256:4db3b48da91eff2f86ac754c9b6d01f1c8bdcca97eaf9932748991420b0fb797');
    const listing = await app.api('GET', '/api/plugins');
    assert.deepEqual(listing.plugins, [{ id: 'tasks', version: '0.10.0-beta.2' }, { id: 'bookmarks', version: '0.10.0-beta.2' }, { id: 'coordinator', version: '0.10.0-beta.2' }]);
    assert.deepEqual(listing.frontend, ['bookmarks']);
  } finally { await app.close(); }
});

test('disabled: no tools, no route, no field, and a Hub still runs a cluster chat', async () => {
  const enabled = await startTestHub();
  const enabledNames = (await toolsOf(enabled)).map((tool) => tool.name);
  await enabled.close();
  const app = await startTestHub({ disabledPlugins: ['bookmarks'] });
  try {
    assert.deepEqual((await toolsOf(app)).map((tool) => tool.name).sort(),
      enabledNames.filter((name) => name !== 'list_bookmarks' && name !== 'bookmark_message').sort());
    const listing = await app.api('GET', '/api/plugins');
    assert.deepEqual(listing.plugins, [{ id: 'tasks', version: '0.10.0-beta.2' }, { id: 'coordinator', version: '0.10.0-beta.2' }]);
    assert.deepEqual(listing.frontend, []);
    const { cluster, members } = await app.cluster('p', ['alice']);
    const path = `/api/clusters/${cluster.id}`;
    const sent = await app.api('POST', `${path}/messages`, { body: `@${members[0].name} hello` });
    await waitFor(() => app.settled(cluster.id), 'delivery ended');
    const event = app.events.find((e) => e.kind === 'message' && (e.payload as { message: { id: string } }).message.id === sent.id)!;
    assert.equal(Object.hasOwn((event.payload as { message: object }).message, 'bookmarks'), false);
    const [message] = await app.messages(cluster.id);
    assert.equal((message as Record<string, unknown>).bookmarks, undefined, 'the field does not appear');
    await assert.rejects(app.api('GET', `${path}/collections`), /404/);
    await assert.rejects(app.api('POST', `${path}/collaboration`, { action: 'bookmark.set', operationId: 'x', messageId: message.id }), /unsupported collaboration action/);
  } finally { await app.close(); }
});

test('disabled: existing bookmarks stay, and deleting a cluster with bookmarks still works', async () => {
  const dir = tempDir();
  const first = await startTestHub({ dir });
  let path: string, cluster: { id: string }, sent: { id: string };
  try {
    ({ cluster } = await first.cluster('p', ['alice']));
    path = `/api/clusters/${cluster.id}`;
    sent = await first.api('POST', `${path}/messages`, { body: 'keep me' });
    await first.api('POST', `${path}/collaboration`, { action: 'bookmark.set', operationId: 'star', messageId: sent.id, labels: ['kept'] });
  } finally { await first.close(); }

  const disabled = await startTestHub({ dir, disabledPlugins: ['bookmarks'] });
  try {
    const raw = disabled.store.db.prepare('SELECT labels_json FROM collaboration_bookmarks WHERE message_id = ?').get(sent.id) as { labels_json: string };
    assert.equal(raw.labels_json, '["kept"]', 'the row survives while the plugin is off');
    await disabled.api('DELETE', path, {});
    assert.equal(disabled.hub.listClusters().some((c) => c.id === cluster.id), false, 'deleted');
    await disabled.api('POST', `${path}/restore`, {});
  } finally { await disabled.close(); }

  const again = await startTestHub({ dir });
  try {
    assert.deepEqual(bookmarksOf(again.store, sent.id).map((b) => b.labels), [['kept']], 'enabling it again finds them');
  } finally { await again.close(); }
});

// ---- the settings page's switch: plugins.json, the environment variable and the dependency rules ----

const withPluginsFile = (dir: string, text: string) => {
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(dir, 'home', 'plugins.json'), text);
};
const fileOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'home', 'plugins.json'), 'utf8'));

test('plugins.json: written whole and read back; no file means none; a damaged file is an error, not an empty list', () => {
  const home = tempDir();
  assert.deepEqual(readDisabledPlugins(home), []);
  writeDisabledPlugins(home, ['a', 'b']);
  assert.deepEqual(readDisabledPlugins(home), ['a', 'b']);
  assert.deepEqual(readdirSync(home), ['plugins.json'], 'no temp file left behind');
  writeDisabledPlugins(home, []);
  assert.deepEqual(readDisabledPlugins(home), []);
  for (const bad of ['{ not json', '', '[]', 'null', '{"disabled":"a"}', '{"disabled":[1]}']) {
    writeFileSync(join(home, 'plugins.json'), bad);
    assert.throws(() => readDisabledPlugins(home), /plugins\.json .*(not valid JSON|must look like).*delete it/, JSON.stringify(bad));
  }
});

test('PluginSettings: dependencies are checked both ways against the next start, and a refused change writes nothing', () => {
  const plugins = [plugin('tasks', { name: '任务' }), plugin('coordinator', { name: '协调员', requires: ['tasks'] })];
  const saved: { disabled: string[]; enabled: string[] }[] = [];
  const settings = new PluginSettings(new PluginHost(plugins), [], { disabled: [], enabled: [] }, (switches) => saved.push(switches));
  assert.throws(() => settings.setEnabled('tasks', false), /不能禁用“任务”：“协调员”依赖它/);
  assert.deepEqual(saved, []);
  settings.setEnabled('coordinator', false);
  settings.setEnabled('tasks', false);
  assert.deepEqual(saved.at(-1), { disabled: ['coordinator', 'tasks'], enabled: [] },
    'once its dependent is off for the next start, the dependency may go too');
  assert.throws(() => settings.setEnabled('coordinator', true), /不能启用“协调员”：它依赖的“任务”没有启用/);
  settings.setEnabled('tasks', true);
  settings.setEnabled('coordinator', true);
  assert.deepEqual(saved.at(-1), { disabled: [], enabled: ['tasks', 'coordinator'] });
  assert.deepEqual(settings.list().map((p) => [p.id, p.enabled, p.pendingEnabled]), [['tasks', true, true], ['coordinator', true, true]]);
});

test('PluginSettings: a failed save changes nothing; an id this version does not know stays in the file', () => {
  let fail = true;
  const saved: { disabled: string[]; enabled: string[] }[] = [];
  const settings = new PluginSettings(new PluginHost([plugin('a')]), [], { disabled: ['removed-later'], enabled: ['future'] }, (switches) => {
    if (fail) throw new Error('disk full');
    saved.push(switches);
  });
  assert.throws(() => settings.setEnabled('a', false), /disk full/);
  assert.equal(settings.list()[0].pendingEnabled, true);
  fail = false;
  settings.setEnabled('a', false);
  assert.deepEqual(saved, [{ disabled: ['removed-later', 'a'], enabled: ['future'] }]);
});

test('PluginSettings checks dependencies and explicit switch conflicts for plugins that default to off', () => {
  const plugins = [plugin('off', { defaultEnabled: false }), plugin('dependent', { defaultEnabled: false, requires: ['off'] })];
  const host = new PluginHost(plugins);
  assert.deepEqual(host.enabled, []);
  const settings = new PluginSettings(host, [], { disabled: ['off'], enabled: ['off'] }, () => {});
  assert.equal(settings.pendingEnabled('off'), false);
  assert.throws(() => settings.setEnabled('dependent', true), /依赖/);
  settings.setEnabled('off', true);
  settings.setEnabled('dependent', true);
  assert.equal(settings.pendingEnabled('dependent'), true);
  assert.throws(() => settings.setEnabled('off', false), /依赖/);
});

const onlyBookmarks = officialPlugins.filter((plugin) => plugin.id === 'bookmarks');

test('api: GET lists what is installed; PUT only changes the next start, which then honours it', async () => {
  const dir = tempDir();
  const first = await startTestHub({ dir, plugins: onlyBookmarks });
  try {
    const before = await first.api('GET', '/api/plugins');
    assert.deepEqual(before.installed, [{ id: 'bookmarks', version: '0.10.0-beta.2', requires: [], name: '收藏', description: onlyBookmarks[0].description,
      details: onlyBookmarks[0].details, iconUrl: '/official-plugins/bookmarks.svg', enabled: true, disabledByEnv: false, pendingEnabled: true,
      officialUpdate: { source: 'bundled' } }]);
    const after = await first.api('PUT', '/api/plugins/bookmarks', { enabled: false });
    assert.deepEqual(after.plugins, [{ id: 'bookmarks', version: '0.10.0-beta.2' }], 'still running until the Hub restarts');
    assert.equal(after.installed[0].enabled, true);
    assert.equal(after.installed[0].pendingEnabled, false);
    assert.deepEqual(fileOf(dir), { disabled: ['bookmarks'] });
    assert.deepEqual((await first.api('GET', '/api/plugins')).installed, after.installed);
    await assert.rejects(first.api('PUT', '/api/plugins/ghost', { enabled: false }), /404/);
    await assert.rejects(first.api('PUT', '/api/plugins/bookmarks', { enabled: 'no' }), /400.*enabled must be a boolean/);
    assert.deepEqual(fileOf(dir), { disabled: ['bookmarks'] }, 'the refused requests wrote nothing');
  } finally { await first.close(); }

  const second = await startTestHub({ dir, plugins: onlyBookmarks });
  try {
    const now = await second.api('GET', '/api/plugins');
    assert.deepEqual(now.plugins, [], 'plugins.json is applied at the start');
    assert.deepEqual([now.installed[0].enabled, now.installed[0].disabledByEnv, now.installed[0].pendingEnabled], [false, false, false]);
    assert.equal((await second.api('PUT', '/api/plugins/bookmarks', { enabled: true })).installed[0].pendingEnabled, true);
    assert.deepEqual(fileOf(dir), { disabled: [], enabled: ['bookmarks'] });
  } finally { await second.close(); }
});

test('api: both plugin routes need the API token', async () => {
  const app = await startTestHub();
  try {
    assert.equal((await rawFetch(`${app.url}/api/plugins`)).status, 401);
    const put = await rawFetch(`${app.url}/api/plugins/bookmarks`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' });
    assert.equal(put.status, 401);
    assert.equal((await app.api('GET', '/api/plugins')).installed[0].pendingEnabled, true);
  } finally { await app.close(); }
});

test('the environment variable adds to the file and wins: that plugin cannot be switched on from the page', async () => {
  const dir = tempDir();
  withPluginsFile(dir, '{"disabled":["a"]}');
  const app = await startTestHub({ dir, plugins: [plugin('a'), plugin('b'), plugin('c')], disabledPlugins: ['b'] });
  try {
    const { plugins, installed } = await app.api('GET', '/api/plugins');
    assert.deepEqual(plugins.map((p: { id: string }) => p.id), ['c'], 'the union of the two');
    assert.deepEqual(installed.map((p: { id: string; disabledByEnv: boolean; pendingEnabled: boolean }) => [p.id, p.disabledByEnv, p.pendingEnabled]),
      [['a', false, false], ['b', true, false], ['c', false, true]]);
    await assert.rejects(app.api('PUT', '/api/plugins/b', { enabled: true }), /400.*环境变量/);
    assert.deepEqual(fileOf(dir), { disabled: ['a'] });
    assert.equal((await app.api('PUT', '/api/plugins/a', { enabled: true })).installed[0].pendingEnabled, true, 'the file-only one can');
  } finally { await app.close(); }
});

test('api: refuses a change that would break a dependency, naming it', async () => {
  const app = await startTestHub({ plugins: [plugin('tasks', { name: '任务' }), plugin('coordinator', { name: '协调员', requires: ['tasks'] })] });
  try {
    await assert.rejects(app.api('PUT', '/api/plugins/tasks', { enabled: false }), /400.*“协调员”依赖它/);
    await app.api('PUT', '/api/plugins/coordinator', { enabled: false });
    await app.api('PUT', '/api/plugins/tasks', { enabled: false });
    await assert.rejects(app.api('PUT', '/api/plugins/coordinator', { enabled: true }), /400.*依赖的“任务”没有启用/);
  } finally { await app.close(); }
});

test('start-up: a damaged plugins.json stops the Hub with the reason; an id this version does not have is skipped and kept', async () => {
  const damaged = tempDir();
  withPluginsFile(damaged, 'oops');
  await assert.rejects(startTestHub({ dir: damaged }), /plugins\.json is not valid JSON/);

  const dir = tempDir();
  withPluginsFile(dir, '{"disabled":["from-another-version"]}');
  const app = await startTestHub({ dir, plugins: onlyBookmarks });
  try {
    assert.deepEqual((await app.api('GET', '/api/plugins')).plugins, [{ id: 'bookmarks', version: '0.10.0-beta.2' }]);
    await app.api('PUT', '/api/plugins/bookmarks', { enabled: false });
    assert.deepEqual(fileOf(dir), { disabled: ['from-another-version', 'bookmarks'] });
  } finally { await app.close(); }
  await assert.rejects(startTestHub({ disabledPlugins: ['typo'] }), /cannot disable unknown plugin typo/);
});

const TASK_TOOLS = ['list_tasks', 'list_labels', 'manage_labels', 'get_task', 'get_task_context', 'create_task', 'task_action', 'raise_attention', 'resolve_attention', 'set_task_summary', 'link_message_tasks',
  'get_batch', 'manage_batch'];

/** A tools/call from a native mock conversation. */
const callTool = async (app: TestHub, name: string, args: Record<string, unknown>, session = 's1') => {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const response = await fetch(`${app.url}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-harness': 'mock', 'x-orrery-session': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const { result } = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: result.isError === true, text: result.content[0].text };
};

test('a prepare step belongs to one of the plugin’s own actions', () => {
  const action = () => ({});
  const prepare = async () => undefined;
  assert.throws(() => new PluginHost([plugin('a', { prepare: { 'x.do': prepare } })]), /prepare for x\.do, which is not its action/);
  assert.equal(new PluginHost([plugin('a', { actions: { 'x.do': action }, prepare: { 'x.do': prepare } })]).prepare('x.do'), prepare);
  assert.equal(new PluginHost([plugin('a', { actions: { 'x.do': action }, prepare: { 'x.do': prepare } })], ['a']).prepare('x.do'), undefined, 'a disabled plugin prepares nothing');
});

test('a slot only one plugin may fill is refused when two do', () => {
  const view = () => ({}) as never;
  assert.throws(() => new PluginHost([plugin('a', { taskView: view }), plugin('b', { taskView: view })]), /a, b all register taskView/);
  assert.equal(new PluginHost([plugin('a', { taskView: view }), plugin('b', { taskView: view })], ['a']).taskView, view);
});

test('tools: enabled, the task tools match the versioned definitions', async () => {
  const app = await startTestHub();
  try {
    const tools = (await toolsOf(app)).filter((tool) => TASK_TOOLS.includes(tool.name));
    assert.equal(tools.length, TASK_TOOLS.length);
    // shortcut: a golden hash of these thirteen definitions; update it only when the tools are meant to change
    // (updated task_action/manage_batch definitions for takeover simplification, ship_fix, failure attribution, and cross-creator batch membership).
    assert.equal(fingerprintTools(tools), 'sha256:00ef589d3ce464c096a7ed66991bd8a3e299923450bd04d92bfc0a9d7297f91c');
  } finally { await app.close(); }
});

test('tasks disabled: the Hub starts, chat and pause work, the task surfaces are gone, the data stays', async () => {
  const dir = tempDir();
  const native = [{ harness: 'mock', sessionId: 's1', name: 'A' }, { harness: 'mock', sessionId: 's2', name: 'B' }];
  const first = await startTestHub({ dir });
  let path: string, clusterId: string, taskId: string, linkedId: string, memberB: string;
  try {
    const { cluster, members } = await first.hub.createCluster('plain', native);
    clusterId = cluster.id;
    memberB = members[1].name;
    path = `/api/clusters/${clusterId}`;
    taskId = (await first.api('POST', `${path}/collaboration`, { action: 'task.create', operationId: 'c', title: 'kept', scope: 's', acceptance: 'a' })).task.id;
    linkedId = (await first.api('POST', `${path}/messages`, { body: 'linked', taskIds: [taskId] })).id;
  } finally { await first.close(); }

  const off = await startTestHub({ dir, disabledPlugins: ['tasks', 'coordinator'] });
  try {
    assert.equal(off.store.tasks, null);
    assert.equal(off.store.coordinator, null, 'tasks and the coordinator are off together');
    assert.equal(off.hub.services.size, 0, 'no idle or merge-window timers run');
    assert.deepEqual((await off.api('GET', '/api/plugins')).plugins, [{ id: 'bookmarks', version: '0.10.0-beta.2' }]);
    const names = (await toolsOf(off)).map((tool) => tool.name);
    for (const name of TASK_TOOLS) assert.equal(names.includes(name), false, `${name} is gone`);
    for (const name of ['send_message', 'manage_roles', 'set_cluster_paused', 'list_bookmarks']) assert.ok(names.includes(name), `${name} stays`);

    await off.api('POST', `${path}/messages`, { body: `@${memberB} hello` });
    await waitFor(() => off.settled(clusterId), 'chat delivered');
    assert.equal(Object.hasOwn((await off.messages(clusterId)).at(-1)!, 'taskIds'), false);
    const unnamed = await off.api('POST', `${path}/messages`, { body: 'nobody named' });
    assert.deepEqual((await off.api('GET', `${path}/messages/${unnamed.id}`)).deliveries, [], 'it only stays in the record');
    assert.equal(Object.hasOwn(JSON.parse((await callTool(off, 'list_agents', {})).text)[0], 'load'), false);

    await assert.rejects(off.api('POST', `${path}/messages`, { body: 'x', taskIds: [taskId] }), /tasks plugin is disabled/);
    const refused = await callTool(off, 'send_message', { body: 'x', taskIds: [taskId] });
    assert.ok(refused.isError && /tasks plugin is disabled/.test(refused.text), refused.text);
    await assert.rejects(off.api('GET', `${path}/workspace`), /404/);
    await assert.rejects(off.api('GET', `${path}/tasks/${taskId}`), /404/);
    await assert.rejects(off.api('POST', `${path}/collaboration`, { action: 'task.create', operationId: 'n', title: 't', scope: 's', acceptance: 'a' }), /unsupported collaboration action/);
    await assert.rejects(off.api('GET', `${path}/collections?taskId=${taskId}`), /tasks plugin is disabled/);
    assert.deepEqual((await off.api('GET', `${path}/collections`)).items, [], 'bookmarks without the task filter still work');
    assert.equal((await fetch(`${off.url}/bridge/ship-verify`, { method: 'POST', body: '{}' })).status, 401, 'the ship route is gone: back to the bridge secret');

    await off.api('POST', `${path}/collaboration`, { action: 'cluster.pause', operationId: 'p1', paused: true });
    const held = await off.api('POST', `${path}/messages`, { body: `@${memberB} while paused` });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal((await off.api('GET', `${path}/messages/${held.id}`)).deliveries[0].state, 'queued', 'the pause still holds deliveries');
    await off.api('POST', `${path}/collaboration`, { action: 'cluster.pause', operationId: 'p2', paused: false });
    await waitFor(() => off.settled(clusterId), 'delivered after resuming');

    assert.equal((off.store.db.prepare('SELECT COUNT(*) AS n FROM collaboration_tasks').get() as { n: number }).n, 1, 'the row survives while the plugin is off');
  } finally { await off.close(); }

  const again = await startTestHub({ dir });
  try {
    assert.deepEqual((await again.api('GET', `${path}/workspace`)).tasks.map((task: { id: string }) => task.id), [taskId], 'enabling it again finds the task');
    assert.deepEqual((await again.messages(clusterId)).find((message) => message.id === linkedId)!.taskIds, [taskId], 'and the link');
    assert.equal(again.hub.services.size, 1);
  } finally { await again.close(); }
});

test('coordinator: the real registry refuses switching tasks off while the coordinator depends on it', async () => {
  await assert.rejects(startTestHub({ disabledPlugins: ['tasks'] }),
    /plugin coordinator cannot be enabled: it requires tasks, which is disabled; enable it or also disable coordinator/);
  const app = await startTestHub();
  try {
    await assert.rejects(app.api('PUT', '/api/plugins/tasks', { enabled: false }), /400.*“协调员”依赖它/);
    assert.deepEqual((await app.api('PUT', '/api/plugins/coordinator', { enabled: false })).installed.find((p: { id: string }) => p.id === 'coordinator').pendingEnabled, false);
    assert.deepEqual((await app.api('PUT', '/api/plugins/tasks', { enabled: false })).installed.find((p: { id: string }) => p.id === 'tasks').pendingEnabled, false, 'once the coordinator is off for the next start, tasks may go too');
    await assert.rejects(app.api('PUT', '/api/plugins/coordinator', { enabled: true }), /400.*依赖的“任务系统”没有启用/);
  } finally { await app.close(); }
  const { name, requires } = officialPlugins.find((p) => p.id === 'coordinator')!;
  assert.equal(name, '协调员');
  assert.deepEqual(requires, ['tasks']);
});

test('coordinator disabled: unaddressed messages stay in the record, tasks and pause keep working, the policy waits', async () => {
  const dir = tempDir();
  const native = [{ harness: 'mock', sessionId: 's1', name: 'A' }, { harness: 'mock', sessionId: 's2', name: 'B' }];
  const first = await startTestHub({ dir });
  let path: string, clusterId: string, a: string, b: string, enabledTools: string[];
  try {
    const { cluster, members } = await first.hub.createCluster('plain', native);
    clusterId = cluster.id; a = members[0].id; b = members[1].id;
    path = `/api/clusters/${clusterId}`;
    enabledTools = (await toolsOf(first)).map((tool) => tool.name);
    await first.api('POST', `${path}/collaboration`, { action: 'coordinator.set', operationId: 'set', memberId: a, enabled: true, mode: 'execute' });
    await first.api('POST', `${path}/collaboration`, { action: 'coordinator.instruction.add', operationId: 'add', instructionText: 'keep this' });
    await first.api('POST', `${path}/collaboration`, { action: 'cluster.pause', operationId: 'pause', paused: true });
    await first.api('POST', `${path}/collaboration`, { action: 'cluster.pause', operationId: 'resume', paused: false });
  } finally { await first.close(); }

  const off = await startTestHub({ dir, disabledPlugins: ['coordinator'] });
  try {
    assert.equal(off.store.coordinator, null);
    assert.ok(off.store.tasks, 'tasks stay on');
    assert.deepEqual((await off.api('GET', '/api/plugins')).plugins.map((p: { id: string }) => p.id), ['tasks', 'bookmarks']);
    assert.deepEqual((await toolsOf(off)).map((tool) => tool.name).sort(), [...enabledTools].sort(), 'no MCP tool belongs to the coordinator');

    const user = await off.api('POST', `${path}/messages`, { body: 'nobody named' });
    assert.deepEqual((await off.api('GET', `${path}/messages/${user.id}`)).deliveries, []);
    const member = JSON.parse((await callTool(off, 'send_message', { body: 'nobody named either' })).text);
    assert.deepEqual(member.deliveredTo, [], 'not an error: it only stays in the record');
    assert.deepEqual((await off.messages(clusterId)).at(-1)!.deliveries, []);
    assert.equal(off.store.listUnread(a, clusterId, 50).some((m) => m.id === member.id), false, 'no coordinator top-up in read_messages');

    await off.api('POST', `${path}/messages`, { body: '@B hello' });
    await waitFor(() => off.settled(clusterId), 'named delivery');
    assert.equal((await off.messages(clusterId)).at(-1)!.deliveries[0].state, 'done');
    await off.api('POST', `${path}/collaboration`, { action: 'cluster.pause', operationId: 'p1', paused: true });
    const held = await off.api('POST', `${path}/messages`, { body: '@B wait' });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal((await off.api('GET', `${path}/messages/${held.id}`)).deliveries[0].state, 'queued', 'the pause still holds deliveries');
    await off.api('POST', `${path}/collaboration`, { action: 'cluster.pause', operationId: 'p2', paused: false });
    await waitFor(() => off.settled(clusterId), 'delivered after resuming');

    await assert.rejects(off.api('POST', `${path}/collaboration`, { action: 'coordinator.set', operationId: 'x', memberId: a, enabled: true, mode: 'execute' }), /unsupported collaboration action/);
    await assert.rejects(off.api('POST', `${path}/collaboration`, { action: 'coordinator.instruction.add', operationId: 'y', instructionText: 'no' }), /unsupported collaboration action/);
    assert.equal((await off.api('GET', `${path}/workspace`)).coordinator, null);
    assert.equal(JSON.parse((await callTool(off, 'list_tasks', {})).text).coordinator, null);

    // A stale generation is refused clearly, an ordinary caller is not; A is no longer the coordinator here, so tasks treat it as anyone else.
    const asA = { kind: 'member' as const, memberId: a };
    const asB = { kind: 'member' as const, memberId: b };
    const run = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>, op: string) =>
      off.hub.collaboration.command(actor, clusterId, { operationId: op, ...command });
    assert.throws(() => run(asA, { action: 'task.create', title: 't', scope: 's', acceptance: 'a', generation: 1 }, 'stale'), /coordinator policy changed \(current generation 0; coordinator is not enabled\)/);
    const created = run(asA, { action: 'task.create', title: 'ordinary create', scope: 's', acceptance: 'a', reviewer: { kind: 'member', memberId: a }, mergeRequired: false }, 'create').task!;
    const claim = run(asB, { action: 'task.claim', taskId: created.id, expectedRevision: created.revision }, 'claim');
    let task = claim.task!;
    task = run(asB, { action: 'task.start', taskId: task.id, expectedRevision: task.revision, assignmentId: claim.assignment!.id }, 'start').task!;
    const evidence = off.hub.sendFromUser(clusterId, 'proof');
    task = run(asB, { action: 'task.submit', taskId: task.id, expectedRevision: task.revision, assignmentId: claim.assignment!.id,
      summary: 'done', evidenceMessageIds: [evidence.id] }, 'submit').task!;
    const reviewed = run(asA, { action: 'task.review', taskId: task.id, expectedRevision: task.revision, submissionId: task.latestSubmissionId!, verdict: 'approve', reason: 'ok' }, 'review');
    assert.equal(reviewed.task!.status, 'completed', 'the old coordinator may review: the limit is the plugin\'s');
    const second = run({ kind: 'user' }, { action: 'task.create', title: 'for a', scope: 's', acceptance: 'a' }, 'create2').task!;
    assert.ok(run(asA, { action: 'task.claim', taskId: second.id, expectedRevision: second.revision }, 'claim2').assignment, 'and claim');
    assert.throws(() => run(asB, { action: 'cluster.pause', paused: true }, 'member-pause'), /not permitted/);
  } finally { await off.close(); }

  const again = await startTestHub({ dir });
  try {
    const policy = (await again.api('GET', `${path}/workspace`)).coordinator;
    assert.deepEqual([policy.memberId, policy.enabled, policy.standingInstructions.map((i: { text: string }) => i.text)], [a, true, ['keep this']], 'enabling it again finds the policy');
    const routed = await again.api('POST', `${path}/messages`, { body: 'routed again' });
    assert.deepEqual((await again.api('GET', `${path}/messages/${routed.id}`)).deliveries.map((d: { memberId: string }) => d.memberId), [a]);
  } finally { await again.close(); }
});

test('coordinator: an old row keeps the policy and the pause; the core and the plugin only write their own columns', () => {
  const path = join(tempDir(), 'p.db');
  const member = (id: string) => ({ id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null });
  const policy = { memberId: 'a', enabled: true, mode: 'execute', generation: 5, permissions: {}, standingInstructions: [{ id: 'i', text: 'stay', createdBy: 'user', createdAt: 'now' }] };
  const row = () => store.db.prepare('SELECT data_json, paused, generation, paused_by FROM collaboration_policies WHERE cluster_id = ?').get('c');
  let store = new Store(path, new PluginHost(officialPlugins));
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, [member('a')]);
  // What a v24 database holds: the row the old code wrote, both halves together.
  store.db.prepare('INSERT INTO collaboration_policies VALUES (?, ?, 1, 5, ?)').run('c', JSON.stringify(policy), 'user');
  store.close();

  store = new Store(path, new PluginHost(officialPlugins, ['coordinator']));
  assert.equal(store.coordinator, null);
  assert.deepEqual(store.clusterPause('c'), { paused: true, pausedBy: 'user' });
  store.setClusterPaused('c', false, null);
  const unpaused = row();
  assert.equal(unpaused!.data_json, JSON.stringify(policy), 'resuming with the coordinator off leaves its columns alone');
  assert.equal(unpaused!.generation, 5);
  store.close();

  store = new Store(path, new PluginHost(officialPlugins));
  assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30, 'no schema change');
  assert.deepEqual(store.coordinator!.policy('c'), policy);
  assert.equal(store.coordinator!.generation('c'), 5);
  assert.deepEqual(store.clusterPause('c'), { paused: false, pausedBy: null });
  saveCoordinator(store, 'c', { ...policy, enabled: false } as unknown as CoordinatorPolicy, 6);
  assert.equal(row()!.paused, 0, 'the plugin does not touch the pause');
  store.setClusterPaused('c', true, 'user');
  assert.equal(row()!.generation, 6, 'the core does not touch the generation');
  assert.deepEqual(store.clusterPause('c'), { paused: true, pausedBy: 'user' });
  store.close();
});
