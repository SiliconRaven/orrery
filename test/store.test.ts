// Schema migrations v1–v6 → v7 preserve every row and reference, clear old tokens, add soft removal, batches, read state
// and the (empty) settings table once.
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB_MODE, eventJson, Store, toEvent } from '../src/core/store.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { collaborationRecords, collaborationTask } from '../src/plugins/tasks/store.ts';
import type { Message } from '../src/core/types.ts';

/** Back to the v18 clusters table: no pin, archive or read position. */
const DROP_V29 = "DROP TRIGGER deliveries_state_seq_insert; DROP TRIGGER deliveries_state_seq_update; DELETE FROM settings WHERE key = 'delivery_state_sequence'; ALTER TABLE deliveries DROP COLUMN state_seq; ALTER TABLE deliveries DROP COLUMN dismissed_at; ALTER TABLE reads DROP COLUMN seen_at";
const DROP_V28 = DROP_V29 + '; ALTER TABLE members DROP COLUMN hidden_at';
const DROP_V27 = DROP_V28 + '; ALTER TABLE members DROP COLUMN unread_after_rowid; ALTER TABLE messages DROP COLUMN system_kind; ALTER TABLE messages DROP COLUMN explicit_mentions_json';
const DROP_V23 = `DROP INDEX messages_client_id; ALTER TABLE messages DROP COLUMN client_message_id; ALTER TABLE messages DROP COLUMN task_stamp_json; ALTER TABLE messages DROP COLUMN fyi; ALTER TABLE deliveries DROP COLUMN queue_warned; ${DROP_V27}`;
const DROP_V19 = `${DROP_V23}; ALTER TABLE clusters DROP COLUMN pinned_at; ALTER TABLE clusters DROP COLUMN archived_at; ALTER TABLE clusters DROP COLUMN user_read_message_id`;

/** The older synthetic fixtures begin with a fresh database, so remove the v17 collaboration schema before downgrading it. */
function removeCollaborationSchema(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS collaboration_records; DROP TABLE IF EXISTS collaboration_links; DROP TABLE collaboration_operations; DROP TABLE collaboration_policies; DROP TABLE collaboration_member_roles; DROP TABLE collaboration_roles; DROP TABLE IF EXISTS collaboration_tasks; DROP INDEX IF EXISTS messages_plugin_rate; ALTER TABLE messages DROP COLUMN kind; ALTER TABLE messages DROP COLUMN collab_event_id; ALTER TABLE clusters DROP COLUMN deleted_at');
  db.exec(DROP_V19);
}

test('listClusters reports each cluster\'s own pause', () => {
  const store = new Store(join(tempDir(), 'pause.db'));
  try {
    for (const id of ['paused', 'never-set']) store.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, []);
    store.setClusterPaused('paused', true, null);
    assert.deepEqual(store.listClusters().map((c) => [c.id, c.paused]), [['paused', true], ['never-set', false]]);
  } finally { store.close(); }
});

// The v2 schema, frozen: what databases written before tokens moved to memory look like.
const V2_SCHEMA = `
CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  name TEXT NOT NULL,
  avatar TEXT,
  harness TEXT NOT NULL,
  model TEXT,
  worker_session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  origin TEXT NOT NULL,
  mcp_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE(cluster_id, name),
  UNIQUE(harness, worker_session_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id), from_id TEXT NOT NULL, mentions_json TEXT NOT NULL,
  body TEXT NOT NULL, reply_to TEXT, chain_id TEXT NOT NULL, hop INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX messages_cluster ON messages(cluster_id);
CREATE INDEX messages_chain ON messages(chain_id);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  state TEXT NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(message_id, member_id)
);
CREATE INDEX deliveries_member_state ON deliveries(member_id, state);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT, member_id TEXT, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX events_member ON events(member_id, seq);
`;

const TOKENS = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const T = '2026-10-29T00:00:00.000Z';
// [state, error] per delivery, all to member m-a; the v1 backfill turns these into attempts [0, 1, 1, 1, 0].
const STATES: [string, string | null][] = [
  ['queued', null], ['running', null], ['done', null], ['failed', 'adapter crashed'], ['failed', '链轮次超限'],
];

// The v3 schema: v2 without members.mcp_token.
const V3_SCHEMA = V2_SCHEMA.replace('  mcp_token TEXT NOT NULL UNIQUE,\n', '');

/** A v1, v2 or v3 database with two clusters, three members (one rowid gap), five messages and their deliveries. */
function legacyDb(path: string, version: 1 | 2 | 3): void {
  const db = new DatabaseSync(path);
  db.exec(version === 3 ? V3_SCHEMA : V2_SCHEMA);
  db.exec(`INSERT INTO clusters VALUES ('c1', 'one', '${T}'), ('c2', 'two', '${T}')`);
  const insert = db.prepare(`INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${version === 3 ? '' : '?, '}?)`);
  const member = (...v: (string | null)[]) => insert.run(...(version === 3 ? v.filter((_, i) => i !== 9) : v));
  member('m-b', 'c1', 'B', '🐭', 'mock', 'mock-1', 's-b', '/p', 'created', TOKENS[1], T);
  member('gone', 'c1', 'G', null, 'mock', null, 's-g', '/p', 'created', 'd'.repeat(64), T);
  member('m-a', 'c1', 'A', null, 'codex', null, 's-a', '/q', 'attached', TOKENS[0], T);
  member('m-x', 'c2', 'A', null, 'mock', 'mock-1', 's-x', '/p', 'created', TOKENS[2], T);
  db.exec("DELETE FROM members WHERE id = 'gone'");   // rowids 1, 3, 4: the copy must keep them
  STATES.forEach(([state, error], i) => {
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?)').run(`msg${i}`, 'c1', 'user', '["m-a"]', `body ${i}`, `msg${i}`, T);
    db.prepare('INSERT INTO deliveries (id, message_id, member_id, state, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`d${i}`, `msg${i}`, 'm-a', state, error, T);
  });
  db.prepare('INSERT INTO deliveries (id, message_id, member_id, state, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('d-b', 'msg0', 'm-b', 'done', null, T);
  db.exec(`INSERT INTO events (cluster_id, member_id, kind, payload_json, created_at) VALUES ('c1', 'm-a', 'agent', '{}', '${T}')`);
  if (version === 1) db.exec('ALTER TABLE deliveries DROP COLUMN attempts');
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

const MEMBER_COLUMNS = ['id', 'cluster_id', 'name', 'avatar', 'harness', 'model', 'worker_session_id', 'cwd', 'origin', 'created_at'];

/** Every row of every table (members without the token column, deliveries without attempts), with rowids. */
function dump(db: DatabaseSync) {
  const all = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
  return {
    clusters: all('SELECT rowid, id, name, created_at FROM clusters ORDER BY rowid'),
    members: all(`SELECT rowid, ${MEMBER_COLUMNS.join(', ')} FROM members ORDER BY rowid`),
    messages: all('SELECT rowid, id, cluster_id, from_id, mentions_json, body, reply_to, chain_id, hop, created_at FROM messages ORDER BY rowid'),
    deliveries: all('SELECT rowid, id, message_id, member_id, state, error, updated_at FROM deliveries ORDER BY rowid'),
    events: all('SELECT * FROM events ORDER BY seq'),
  };
}

function readDump(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return dump(db);
  } finally {
    db.close();
  }
}

/** A missing file (no WAL) holds no token. */
const hasToken = (path: string) => existsSync(path) && TOKENS.some((t) => readFileSync(path).includes(t));

/** Everything a database migrated to the current schema (v22) must satisfy. */
function checkLatest(store: Store): void {
  const db = store.db;
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 29);
  // v22: the merge window table exists and starts empty; v21 added no tables.
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merge_windows'").all().map((r) => r.name), ['merge_windows']);
  assert.deepEqual(db.prepare('SELECT * FROM merge_windows').all(), []);
  // v19: old clusters are not pinned, not archived and have no read position.
  assert.deepEqual(db.prepare('SELECT DISTINCT pinned_at, archived_at, user_read_message_id FROM clusters').all().map((r) => ({ ...r })),
    [{ pinned_at: null, archived_at: null, user_read_message_id: null }]);
  // v18: system notifications carry a collaboration event link; old messages have none.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE collab_event_id IS NOT NULL').get() as any).n, 0);
  // v17: business roles carry a description; these fixtures have no roles.
  assert.deepEqual(db.prepare('SELECT DISTINCT description FROM collaboration_roles').all(), []);
  assert.deepEqual(db.prepare('SELECT * FROM activity_snapshots').all(), []);
  assert.deepEqual(db.prepare('SELECT DISTINCT outcome, handoff_message_id FROM deliveries').all().map((r) => ({ ...r })), [{ outcome: null, handoff_message_id: null }]);
  assert.deepEqual(db.prepare('SELECT * FROM message_acknowledgements').all(), []);
  // v11: usage tables, empty.
  assert.deepEqual(db.prepare('SELECT * FROM turn_usage').all(), []);
  assert.deepEqual(db.prepare('SELECT * FROM quota_snapshots').all(), []);
  // v10: every old cluster is ungrouped.
  assert.deepEqual(db.prepare('SELECT DISTINCT category FROM clusters').all().map((r) => r.category), ['']);
  assert.deepEqual(store.listClusters().map((c) => c.category), store.listClusters().map(() => ''));
  // v9: old outcomes are history, none is told to its sender.
  assert.deepEqual(db.prepare('SELECT DISTINCT reported FROM deliveries').all().map((r) => r.reported), [1]);
  // v8: file tables, empty; old messages carry no attachments.
  assert.deepEqual(db.prepare('SELECT * FROM files').all(), []);
  assert.deepEqual(db.prepare('SELECT * FROM message_files').all(), []);
  assert.deepEqual(store.attachmentsOf('msg0'), []);
  // v7: a settings table with nothing saved.
  assert.deepEqual(db.prepare('SELECT * FROM settings').all(), []);
  assert.equal(store.getLimit('maxHops'), null);
  assert.equal(store.getLimit('maxTurnsPerChain'), null);
  // v6: the interrupted (running) delivery is its own batch; done deliveries are read via 'delivery'.
  assert.deepEqual(db.prepare('SELECT id, batch_id FROM deliveries ORDER BY rowid').all().map((r) => [r.id, r.batch_id]),
    [['d0', null], ['d1', 'd1'], ['d2', null], ['d3', null], ['d4', null], ['d-b', null]]);
  assert.deepEqual(db.prepare('SELECT member_id, message_id, via, at FROM reads ORDER BY member_id').all().map((r) => ({ ...r })),
    [{ member_id: 'm-a', message_id: 'msg2', via: 'delivery', at: T }, { member_id: 'm-b', message_id: 'msg0', via: 'delivery', at: T }]);
  assert.deepEqual(db.prepare('PRAGMA table_info(members)').all().map((c) => c.name), [...MEMBER_COLUMNS, 'mode', 'effort', 'removed_at', 'unread_after_rowid', 'hidden_at'], 'no mcp_token column');
  assert.deepEqual(db.prepare('SELECT DISTINCT mode, effort FROM members').all().map((r) => ({ ...r })), [{ mode: 'isolated', effort: null }],
    'historical migration keeps the stored mode');
  assert.deepEqual(db.prepare('SELECT DISTINCT direct FROM messages').all().map((r) => r.direct), [0]);
  assert.deepEqual(store.listMembers('c1').map((m) => [m.mode, m.effort]), [['isolated', null], ['isolated', null]]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1, 'foreign keys are back on');
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'members%' AND type = 'table'").all().map((r) => r.name), ['members']);
  // Active names remain unique, native sessions may join another cluster, and delivery references remain valid.
  const ins = db.prepare(`INSERT INTO members (${MEMBER_COLUMNS.join(', ')}) VALUES (?, ?, ?, NULL, ?, NULL, ?, '/p', 'created', ?)`);
  assert.throws(() => ins.run('dup-name', 'c1', 'A', 'mock', 's-new', T), /UNIQUE constraint failed: members\.cluster_id, members\.name/);
  assert.doesNotThrow(() => ins.run('shared-session', 'c2', 'Z', 'mock', 's-b', T));
  db.exec("DELETE FROM members WHERE id = 'shared-session'");
  assert.throws(() => db.prepare("INSERT INTO deliveries (id, message_id, member_id, state, updated_at) VALUES ('dx', 'msg0', 'nobody', 'queued', ?)").run(T),
    /FOREIGN KEY constraint failed/);
  assert.throws(() => db.exec("DELETE FROM members WHERE id = 'm-a'"), /FOREIGN KEY constraint failed/, 'a referenced member cannot be removed');
  // The Store reads the rebuilt table in the old order.
  assert.deepEqual(store.listMembers('c1').map((m) => m.id), ['m-b', 'm-a']);
}

test('5: a v2 database is migrated to v7: rows kept, token column and token bytes gone, migrated once', () => {
  const path = join(tempDir(), 'v2.db');
  legacyDb(path, 2);
  const before = readDump(path);
  assert.ok(hasToken(path), 'the scan does see tokens in a v2 file');

  // The moment v3 is declared: both files already clean, the WAL file zero bytes.
  let atV3: { mainToken: boolean; walToken: boolean; walBytes: number } | undefined;
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql === 'PRAGMA user_version = 3') {
      atV3 = { mainToken: hasToken(path), walToken: hasToken(`${path}-wal`), walBytes: existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`).length : 0 };
    }
    return exec.call(this, sql);
  };
  let store: Store;
  try {
    store = new Store(path);
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  assert.deepEqual(atV3, { mainToken: false, walToken: false, walBytes: 0 });
  try {
    // While the connection is still open (the Hub keeps it for hours): the WAL was written back and emptied after the
    // VACUUM; what it holds now are the later migrations' pages, written from the clean file.
    assert.equal(hasToken(path), false, 'no old token in the database file once the migration returns');
    assert.equal(hasToken(`${path}-wal`), false, 'none in the WAL file either');
    checkLatest(store);
  } finally {
    store.close();
  }
  assert.deepEqual(readDump(path), before, 'every row of every table kept, rowids included');
  assert.equal(hasToken(path), false, 'no old token left anywhere in the file');

  const reopened = new Store(path);   // already v7: nothing to do
  try {
    checkLatest(reopened);
  } finally {
    reopened.close();
  }
  assert.deepEqual(readDump(path), before);
});

test('5: a v1 database is migrated to v7 with attempts backfilled once per state', () => {
  const path = join(tempDir(), 'v1.db');
  legacyDb(path, 1);
  const before = readDump(path);
  const attempts = (store: Store) => store.db.prepare("SELECT attempts FROM deliveries WHERE member_id = 'm-a' ORDER BY rowid").all().map((r) => r.attempts);

  const migrated = new Store(path);
  try {
    checkLatest(migrated);
    assert.deepEqual(attempts(migrated), [0, 1, 1, 1, 0]);
  } finally {
    migrated.close();
  }
  assert.deepEqual(readDump(path), before);
  assert.equal(hasToken(path), false);

  // A real count the backfill would overwrite with 1 if it ran again.
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE deliveries SET attempts = 7 WHERE id = 'd2'").run();
  raw.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(attempts(reopened), [0, 1, 7, 1, 0], 'the backfill did not run again');
  } finally {
    reopened.close();
  }
});

test('5: if the post-migration VACUUM fails, the next open redoes the cleanup', () => {
  const path = join(tempDir(), 'vacuum.db');
  legacyDb(path, 2);
  const before = readDump(path);
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql === 'VACUUM') throw new Error('injected VACUUM failure');
    return exec.call(this, sql);
  };
  try {
    assert.throws(() => new Store(path), /injected VACUUM failure/);
  } finally {
    DatabaseSync.prototype.exec = exec;
  }
  assert.ok(hasToken(path), 'the failed cleanup left old token bytes behind');

  const retried = new Store(path);   // not marked v3 yet, so the cleanup runs again (then v3 → v4)
  try {
    checkLatest(retried);
  } finally {
    retried.close();
  }
  assert.equal(hasToken(path), false, 'the retry removed them');
  assert.deepEqual(readDump(path), before);
});

test('5: if a reader pins the WAL so the clean-up cannot be written back, v3 is not reached and the next open finishes it', () => {
  const path = join(tempDir(), 'pinned.db');
  legacyDb(path, 2);
  const before = readDump(path);
  let reader: DatabaseSync | undefined;
  // Through the journal-mode seam: switch to WAL as usual, then a second connection (a backup, say) holds a snapshot.
  const pinAfterSwitch = (db: DatabaseSync, mode: string) => {
    const result = String((db.prepare(`PRAGMA journal_mode = ${mode}`).get() as any).journal_mode);
    reader = new DatabaseSync(path, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM members').get();
    return result;
  };
  try {
    assert.throws(() => new Store(path, undefined, DEFAULT_DB_MODE, pinAfterSwitch), /could not write the WAL back/);
    assert.equal((reader!.prepare('PRAGMA user_version').get() as any).user_version, 2, 'the reader still sees v2');
  } finally {
    reader?.exec('COMMIT');
    reader?.close();
  }
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((raw.prepare('PRAGMA user_version').get() as any).user_version, 2, 'not marked v3: the next open redoes the clean-up');
  } finally { raw.close(); }

  const retried = new Store(path);
  try {
    assert.equal(hasToken(path), false);
    assert.equal(hasToken(`${path}-wal`), false);
    checkLatest(retried);
  } finally {
    retried.close();
  }
  assert.deepEqual(readDump(path), before);
});

test('5: a migration that would leave a broken foreign key rolls back and keeps the v2 database as it was', () => {
  const path = join(tempDir(), 'broken.db');
  legacyDb(path, 2);
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  raw.prepare("INSERT INTO deliveries (id, message_id, member_id, state, updated_at) VALUES ('orphan', 'msg0', 'nobody', 'queued', ?)").run(T);
  raw.close();
  const before = readDump(path);

  assert.throws(() => new Store(path), /broke 1 foreign key/);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 2);
    assert.ok(db.prepare('PRAGMA table_info(members)').all().some((c) => c.name === 'mcp_token'), 'members untouched');
  } finally {
    db.close();
  }
  assert.deepEqual(readDump(path), before);
});

test('8 (native mode): a v3 database is migrated to v7: rows kept, members become isolated, migrated once', () => {
  const path = join(tempDir(), 'v3.db');
  legacyDb(path, 3);
  const before = readDump(path);
  const store = new Store(path);
  try {
    checkLatest(store);
    // The new columns work: a native member and a direct message round-trip.
    store.db.prepare("UPDATE members SET mode = 'native', effort = 'high' WHERE id = 'm-x'").run();
    assert.deepEqual([store.getMember('m-x')!.mode, store.getMember('m-x')!.effort], ['native', 'high']);
    store.db.prepare("UPDATE members SET mode = 'isolated', effort = NULL WHERE id = 'm-x'").run();
  } finally {
    store.close();
  }
  assert.deepEqual(readDump(path), before, 'every row of every table kept, rowids included');
  const reopened = new Store(path);
  try {
    checkLatest(reopened);
  } finally {
    reopened.close();
  }
  assert.deepEqual(readDump(path), before);
});

test('v24 upgrades with an index for the external plugin rate boundary', (t) => {
  const path = join(tempDir(), 'plugin-rate.db');
  const old = new Store(path);
  old.db.exec("INSERT INTO clusters (id, name, created_at) VALUES ('c', 'rate', '2026-01-01');");
  const add = (id: string, from: string, kind: 'chat' | 'plugin', createdAt: string) => old.insertMessage({
    id, clusterId: 'c', from, kind, createdAt, mentions: [], body: id, replyTo: null, chainId: id, hop: 0,
  }, []);
  add('older', 'plugin:writer', 'plugin', '2026-01-01T00:00:01.000Z');
  add('newer', 'plugin:writer', 'plugin', '2026-01-01T00:00:02.000Z');
  add('other', 'plugin:observer', 'plugin', '2026-01-01T00:00:03.000Z');
  add('user', 'user', 'chat', '2026-01-01T00:00:04.000Z');
  old.db.exec(`DROP INDEX messages_plugin_rate; ALTER TABLE messages DROP COLUMN fyi; ${DROP_V27}; PRAGMA user_version = 24`);
  old.close();

  const upgraded = new Store(path);
  try {
    assert.equal((upgraded.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
    const prepare = upgraded.db.prepare.bind(upgraded.db);
    const calls = t.mock.method(upgraded.db, 'prepare');
    const since = '2026-01-01T00:00:00.000Z';
    assert.equal(upgraded.pluginRateBoundary('c', 'plugin:writer', since, 2), '2026-01-01T00:00:01.000Z');
    const [sql] = calls.mock.calls[0].arguments;
    const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all('c', 'plugin:writer', since, 1);
    assert.match(String(plan[0].detail), /SEARCH messages USING .*INDEX messages_plugin_rate/);
    assert.equal(upgraded.pluginRateBoundary('c', 'plugin:writer', '2026-01-01T00:00:01.000Z', 2), null);
    assert.deepEqual(upgraded.listMessages('c', 10).map((msg) => msg.id), ['older', 'newer', 'other', 'user']);
  } finally { upgraded.close(); }
});

test('an unknown schema version is refused', () => {
  const path = join(tempDir(), 'future.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version = 30');
  db.close();
  assert.throws(() => new Store(path), /unsupported database schema version 30/);
});

test('activity schema migrates v14 without changing existing data', () => {
  const path = join(tempDir(), 'v14.db');
  const old = new Store(path);
  removeCollaborationSchema(old.db);
  old.db.exec("INSERT INTO clusters (id, name, created_at) VALUES ('c', 'existing', '2026-01-01'); DROP TABLE activity_snapshots; PRAGMA user_version = 14");
  old.close();
  const migrated = new Store(path);
  try {
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
    assert.equal(migrated.getCluster('c')?.name, 'existing');
    assert.deepEqual(migrated.db.prepare('SELECT * FROM activity_snapshots').all(), []);
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { migrated.close(); }
});

test('v16 to v19 adds role descriptions and the message event link and keeps existing rows', () => {
  const path = join(tempDir(), 'v16.db');
  const fresh = new Store(path);
  fresh.insertCluster({ id: 'c', name: 'c', createdAt: T, category: '' }, []);
  fresh.saveCollaborationRole({ id: 'r1', clusterId: 'c', name: '执行者', description: '负责实现' });
  fresh.insertMessage({ id: 'msg', clusterId: 'c', from: 'user', mentions: [], body: 'old note', replyTo: null,
    chainId: 'msg', hop: 0, createdAt: T }, []);
  fresh.close();
  const raw = new DatabaseSync(path);
  raw.exec(DROP_V19);
  raw.exec("ALTER TABLE collaboration_roles DROP COLUMN description; ALTER TABLE messages DROP COLUMN collab_event_id; PRAGMA user_version = 16");
  raw.close();
  const migrated = new Store(path);
  try {
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
    assert.deepEqual(migrated.collaborationRoles('c'), [{ id: 'r1', clusterId: 'c', name: '执行者', description: '' }]);
    migrated.setCollaborationRoleDescription('r1', '负责实现并提交结果');
    assert.deepEqual(migrated.collaborationRoles('c').map((r) => r.description), ['负责实现并提交结果']);
    assert.equal(migrated.getMessage('msg')?.body, 'old note', 'old messages survive the migration');
    assert.equal(migrated.getMessage('msg')?.collabEventId, undefined, 'old messages keep no event link');
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { migrated.close(); }
});

test('v17 to v19 adds an empty collaboration event link and leaves existing messages untouched', () => {
  const path = join(tempDir(), 'v17.db');
  const fresh = new Store(path);
  fresh.insertCluster({ id: 'c', name: 'c', createdAt: T, category: '' }, []);
  fresh.insertMessage({ id: 'msg', clusterId: 'c', from: 'user', mentions: [], body: 'keep me', replyTo: null,
    chainId: 'msg', hop: 0, createdAt: T }, []);
  fresh.close();
  const raw = new DatabaseSync(path);
  raw.exec(DROP_V19);
  raw.exec('ALTER TABLE messages DROP COLUMN collab_event_id; PRAGMA user_version = 17');
  raw.close();
  const migrated = new Store(path);
  try {
    assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
    const message = migrated.getMessage('msg')!;
    assert.equal(message.body, 'keep me');
    assert.equal(message.collabEventId, undefined);
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { migrated.close(); }
});

test('v18 to v19 gives every cluster an empty pin, archive and read position and keeps all other data', () => {
  const path = join(tempDir(), 'v18.db');
  const fresh = new Store(path);
  fresh.insertCluster({ id: 'c', name: 'kept', createdAt: T, category: 'work' }, []);
  fresh.insertCluster({ id: 'gone', name: 'binned', createdAt: T, category: '' }, []);
  fresh.deleteCluster('gone');
  fresh.insertMessage({ id: 'msg', clusterId: 'c', from: 'user', mentions: [], body: 'keep me', replyTo: null,
    chainId: 'msg', hop: 0, createdAt: T }, []);
  fresh.close();
  const raw = new DatabaseSync(path);
  raw.exec(`${DROP_V19}; PRAGMA user_version = 18`);
  const before = dump(raw);
  raw.close();
  for (let open = 0; open < 2; open++) {   // the second open finds the latest version and changes nothing
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(dump(migrated.db), before, 'every row kept');
      const [c] = migrated.listClusters();
      assert.deepEqual([c.id, c.name, c.category, c.pinnedAt, c.archivedAt, c.userReadMessageId], ['c', 'kept', 'work', null, null, null]);
      assert.ok(migrated.getCluster('gone', { includeDeleted: true })?.deletedAt, 'the recycle bin is unchanged');
      assert.equal(migrated.getMessage('msg')?.body, 'keep me');
    } finally { migrated.close(); }
  }
});

test('v19 to v22 runs the version-only steps, preserves history and adds the merge window on repeated opens', () => {
  const path = join(tempDir(), 'v19.db');
  const initial = new Store(path);
  initial.insertCluster({ id: 'c', name: 'kept', createdAt: T, category: '' }, []);
  initial.insertMessage({ id: 'm', clusterId: 'c', from: 'user', mentions: [], body: 'history', replyTo: null,
    chainId: 'm', hop: 0, createdAt: T }, []);
  const before = dump(initial.db);
  initial.db.exec(`${DROP_V23}; PRAGMA user_version = 19`);
  initial.close();
  for (let open = 0; open < 2; open++) {
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(dump(migrated.db), before);
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  }
});

test('v20 to v22 runs the task lifecycle and merge window migrations, preserving JSON and normalizing only reads', () => {
  const path = join(tempDir(), 'v20.db');
  const initial = new Store(path, new PluginHost(officialPlugins));
  initial.insertCluster({ id: 'c', name: 'kept', createdAt: T, category: '' }, []);
  const taskJson = '{ "id":"task", "clusterId":"c", "status":"completed" }';
  const submissionJson = '{ "id":"submission", "taskId":"task" }';
  initial.db.prepare('INSERT INTO collaboration_tasks VALUES (?, ?, ?)').run('task', 'c', taskJson);
  initial.db.prepare('INSERT INTO collaboration_records VALUES (?, ?, ?, ?)').run('submission', 'task', 'submission', submissionJson);
  const before = dump(initial.db);
  initial.db.exec(`${DROP_V23}; DROP TABLE merge_windows; PRAGMA user_version = 20`);
  initial.close();
  for (let open = 0; open < 2; open++) {
    const migrated = new Store(path, new PluginHost(officialPlugins));
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      // v20 -> v21 is the task lifecycle's version-only step; v21 -> v22 creates the window table.
      assert.deepEqual(migrated.db.prepare('SELECT * FROM merge_windows').all(), []);
      assert.equal(collaborationTask(migrated, 'c', 'task')!.mergeRequired, false);
      assert.equal(collaborationTask(migrated, 'c', 'task')!.requiresApproval, false);
      assert.equal(collaborationTask(migrated, 'c', 'task')!.mergedCommitSha, null);
      assert.equal(collaborationRecords<any>(migrated, 'task', 'submission')[0].commitSha, null);
      assert.deepEqual(dump(migrated.db), before, 'migration and read projection leave every original JSON byte intact');
    } finally { migrated.close(); }
  }
});

test('v21 to v22 adds the empty merge window table and keeps every row', () => {
  const path = join(tempDir(), 'v21.db');
  const initial = new Store(path, new PluginHost(officialPlugins));
  initial.insertCluster({ id: 'c', name: 'kept', createdAt: T, category: '' }, []);
  initial.insertMessage({ id: 'm', clusterId: 'c', from: 'user', mentions: [], body: 'history', replyTo: null,
    chainId: 'm', hop: 0, createdAt: T }, []);
  const before = dump(initial.db);
  initial.db.exec(`${DROP_V23}; DROP TABLE merge_windows; PRAGMA user_version = 21`);
  initial.close();
  for (let open = 0; open < 2; open++) {   // the second open finds the latest version and changes nothing
    const migrated = new Store(path, new PluginHost(officialPlugins));
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(migrated.db.prepare('SELECT * FROM merge_windows').all(), []);
      assert.deepEqual(dump(migrated.db), before);
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  }
});

test('v22 to v23 adds the idempotency key, the task stamp and the warned flag without touching old rows', () => {
  const path = join(tempDir(), 'v22.db');
  const initial = new Store(path, new PluginHost(officialPlugins));
  initial.insertCluster({ id: 'c', name: 'kept', createdAt: T, category: '' }, []);
  initial.insertMessage({ id: 'm', clusterId: 'c', from: 'user', mentions: [], body: 'history', replyTo: null, chainId: 'm', hop: 0, createdAt: T }, []);
  const before = dump(initial.db);
  initial.db.exec(`${DROP_V23}; PRAGMA user_version = 22`);
  initial.close();
  for (let open = 0; open < 2; open++) {
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(dump(migrated.db), before);
      assert.equal(migrated.getMessage('m')!.taskStamp, undefined);
      assert.equal(migrated.messageByClientId('user', 'x'), null);
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  }
});

test('a sender cannot store the same clientMessageId twice; another sender and no key can', () => {
  const store = new Store(':memory:');
  try {
    store.insertCluster({ id: 'c', name: 'c', createdAt: T, category: '' }, []);
    const msg = (id: string, from: string) => ({ id, clusterId: 'c', from, mentions: [], body: id, replyTo: null, chainId: id, hop: 0, createdAt: T });
    store.insertMessage(msg('a', 'x'), [], false, [], 'key');
    assert.throws(() => store.insertMessage(msg('b', 'x'), [], false, [], 'key'), /UNIQUE/);
    store.insertMessage(msg('c', 'y'), [], false, [], 'key');
    store.insertMessage(msg('d', 'x'), []);
    store.insertMessage(msg('e', 'x'), []);
    assert.equal(store.messageByClientId('x', 'key')!.id, 'a');
    assert.equal(store.messageByClientId('y', 'key')!.id, 'c');
  } finally { store.close(); }
});

test('v13 to v14 preserves history and enforces per-cluster native and isolated session boundaries', () => {
  const path = join(tempDir(), 'v13.db');
  const initial = new Store(path);
  const native = { id: 'native', clusterId: 'one', name: 'N', avatar: null, harness: 'mock', model: null,
    workerSessionId: 'shared', cwd: '/p', origin: 'attached' as const, mode: 'native' as const, effort: null, removedAt: null };
  const isolated = { ...native, id: 'isolated', clusterId: 'two', name: 'I', workerSessionId: 'private', origin: 'created' as const, mode: 'native' as const };
  for (const id of ['one', 'two', 'three']) initial.insertCluster({ id, name: id, createdAt: T, category: '' }, id === 'one' ? [native] : id === 'two' ? [isolated] : []);
  initial.close();
  const old = new DatabaseSync(path);
  removeCollaborationSchema(old);
  old.exec(`DROP TRIGGER IF EXISTS members_session_mode_insert; DROP TRIGGER IF EXISTS members_session_mode_update;
    DROP INDEX members_active_session;
    CREATE UNIQUE INDEX members_active_session ON members(harness, worker_session_id) WHERE removed_at IS NULL;
    PRAGMA user_version = 13`);
  old.close();
  const before = readDump(path);
  const store = new Store(path);
  try {
    assert.deepEqual(dump(store.db), before);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
    store.insertMembers([{ ...native, id: 'native-two', clusterId: 'two', name: 'N2' }]);
    assert.deepEqual(store.getMembersBySession('mock', 'shared').map((m) => m.id), ['native', 'native-two']);
    assert.throws(() => store.insertMembers([{ ...native, id: 'duplicate', name: 'N3' }]), /UNIQUE/);
    assert.doesNotThrow(() => store.insertMembers([{ ...native, id: 'third-binding', clusterId: 'three', mode: 'native' }]));
    assert.doesNotThrow(() => store.insertMembers([{ ...native, id: 'fourth-binding', name: 'N4', clusterId: 'three', workerSessionId: 'private' }]));
    assert.throws(() => store.db.exec("UPDATE members SET worker_session_id = 'shared' WHERE id = 'isolated'"), /UNIQUE/);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); }
});

test('members: direct v4 → v5 preserves native metadata, rowids and history, then allows inactive name/session reuse', () => {
  const path = join(tempDir(), 'v4.db');
  legacyDb(path, 3);
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE members ADD COLUMN mode TEXT NOT NULL DEFAULT 'isolated'; ALTER TABLE members ADD COLUMN effort TEXT; ALTER TABLE messages ADD COLUMN direct INTEGER NOT NULL DEFAULT 0;");
  raw.exec("UPDATE members SET mode = 'native', effort = 'high' WHERE id = 'm-a'; UPDATE messages SET direct = 1 WHERE id = 'msg0'; PRAGMA user_version = 4");
  const before = dump(raw);
  raw.close();
  const store = new Store(path);
  try {
    assert.deepEqual(dump(store.db), before);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(store.getMember('m-a')!.mode, 'native');
    assert.equal(store.getMember('m-a')!.effort, 'high');
    assert.equal(store.isDirect('msg0'), true);
    const { member } = store.removeMember('c1', 'm-a');
    assert.ok(member.removedAt);
    assert.equal(store.getMember('m-a'), null);
    store.insertMembers([{ ...member, id: 'new-member', removedAt: null }]);
    assert.equal(store.getMembersBySession('codex', 's-a')[0]?.id, 'new-member');
    assert.equal(store.listMembers('c1', { includeRemoved: true }).length, 3);
    assert.equal(store.withDeliveries(store.listMessages('c1', 10))[0].deliveries[0].memberId, 'm-a');
    assert.equal(store.listEvents(0)[0].memberId, 'm-a');
    assert.throws(() => store.updateMember('m-a', { name: 'changed' }), /unknown active member/);
  } finally { store.close(); }
  const reopened = new Store(path);
  try {
    assert.equal(reopened.getMember('m-a'), null);
    assert.equal(reopened.getMember('new-member')!.removedAt, null);
    assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { reopened.close(); }
});

test('members: v4 → v5 foreign key failure rolls the entire rebuild back', () => {
  const path = join(tempDir(), 'broken-v4.db');
  legacyDb(path, 3);
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  raw.exec("ALTER TABLE members ADD COLUMN mode TEXT NOT NULL DEFAULT 'isolated'; ALTER TABLE members ADD COLUMN effort TEXT; ALTER TABLE messages ADD COLUMN direct INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 4");
  raw.exec("INSERT INTO deliveries (id, message_id, member_id, state, updated_at) VALUES ('broken', 'msg0', 'missing', 'queued', 'now')");
  const before = dump(raw);
  raw.close();
  assert.throws(() => new Store(path), /schema v5 migration broke 1 foreign key/);
  assert.deepEqual(readDump(path), before);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 4);
    assert.equal(db.prepare('PRAGMA table_info(members)').all().some((c) => c.name === 'removed_at'), false);
  } finally { db.close(); }
});

test('read state: v5 → v7 keeps every row, backfills reads from done deliveries and makes a running delivery its own batch', () => {
  const path = join(tempDir(), 'v5.db');
  const fresh = new Store(path);
  const member = (id: string, name: string) => ({
    id, clusterId: 'c1', name, avatar: null, harness: 'mock', model: null, effort: null, mode: 'native' as const,
    workerSessionId: `s-${id}`, cwd: '/p', origin: 'created' as const, removedAt: null,
  });
  fresh.insertCluster({ id: 'c1', name: 'one', createdAt: T, category: '' }, [member('m-a', 'A'), member('m-b', 'B')]);
  ['done', 'running', 'queued', 'failed'].forEach((state, i) => {
    const [d] = fresh.insertMessage({ id: `msg${i}`, clusterId: 'c1', from: 'user', mentions: ['m-a'], body: `b${i}`, replyTo: null, chainId: `msg${i}`, hop: 0, createdAt: T }, ['m-a']);
    fresh.db.prepare('UPDATE deliveries SET state = ?, updated_at = ? WHERE id = ?').run(state, `${T}-${i}`, d.id);
  });
  fresh.insertMessage({ id: 'msgB', clusterId: 'c1', from: 'm-a', mentions: [], body: 'record only', replyTo: null, chainId: 'msgB', hop: 0, createdAt: T }, []);
  fresh.appendEvent('c1', 'm-a', 'agent', {});
  fresh.close();
  // Back to the v5 layout: no reads table, no batch_id.
  const raw = new DatabaseSync(path);
  removeCollaborationSchema(raw);
  raw.exec('DROP TABLE message_acknowledgements; DROP TABLE reads; DROP TABLE settings; DROP TABLE message_files; DROP TABLE files; ALTER TABLE deliveries DROP COLUMN outcome; ALTER TABLE deliveries DROP COLUMN handoff_message_id; ALTER TABLE deliveries DROP COLUMN batch_id; ALTER TABLE deliveries DROP COLUMN reported; ALTER TABLE clusters DROP COLUMN category; PRAGMA user_version = 5');
  raw.close();
  const before = readDump(path);

  for (let open = 0; open < 2; open++) {   // the second open finds v13 and changes nothing
    const store = new Store(path);
    try {
      assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(dump(store.db), before, 'every row of every table kept, rowids included');
      assert.deepEqual(store.db.prepare('SELECT * FROM reads').all().map((r) => ({ ...r })),
        [{ member_id: 'm-a', message_id: 'msg0', via: 'delivery', at: `${T}-0`, seen_at: `${T}-0` }]);
      const ds = store.withDeliveries(store.listMessages('c1', 10)).flatMap((m) => m.deliveries);
      assert.deepEqual(ds.map((d) => [d.state, d.batchId === d.id ? 'own' : d.batchId]), [['done', null], ['running', 'own'], ['queued', null], ['failed', null]]);
      assert.deepEqual(store.listUnread('m-a', 'c1', 10).map((m) => m.id), ['msg1', 'msg2', 'msg3'], 'only what was delivered counts as read');
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      store.close();
    }
  }
});

test('hop limit: v6 → v7 adds an empty settings table and keeps every row; a saved value reads back; a malformed one is an error', () => {
  const path = join(tempDir(), 'v6.db');
  const fresh = new Store(path);
  fresh.insertCluster({ id: 'c1', name: 'one', createdAt: T, category: '' }, [{
    id: 'm-a', clusterId: 'c1', name: 'A', avatar: null, harness: 'mock', model: null, effort: null, mode: 'native',
    workerSessionId: 's-a', cwd: '/p', origin: 'created', removedAt: null,
  }]);
  fresh.insertMessage({ id: 'msg0', clusterId: 'c1', from: 'user', mentions: ['m-a'], body: 'b', replyTo: null, chainId: 'msg0', hop: 0, createdAt: T }, ['m-a']);
  fresh.markRead('m-a', ['msg0'], 'delivery');
  fresh.appendEvent('c1', 'm-a', 'agent', {});
  fresh.close();
  const raw = new DatabaseSync(path);
  removeCollaborationSchema(raw);
  raw.exec('DROP TABLE message_acknowledgements; DROP TABLE settings; DROP TABLE message_files; DROP TABLE files; ALTER TABLE deliveries DROP COLUMN outcome; ALTER TABLE deliveries DROP COLUMN handoff_message_id; ALTER TABLE deliveries DROP COLUMN reported; ALTER TABLE clusters DROP COLUMN category; PRAGMA user_version = 6');   // back to the v6 layout
  raw.close();
  const before = readDump(path);

  const store = new Store(path);
  try {
    assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
    assert.deepEqual(dump(store.db), before, 'every row kept');
    assert.deepEqual(store.db.prepare('SELECT * FROM reads').all().map((r) => r.message_id), ['msg0']);
    assert.deepEqual(store.db.prepare('SELECT * FROM settings').all(), []);
    assert.equal(store.getLimit('maxHops'), null, 'no row: never saved');
    store.setLimit('maxHops', { kind: 'finite', value: 8 });
    store.setLimit('maxHops', { kind: 'unlimited' });
    assert.deepEqual(store.db.prepare('SELECT key, value FROM settings').all().map((r) => ({ ...r })), [{ key: 'max_hops', value: '{"kind":"unlimited"}' }]);
    assert.throws(() => store.setLimit('maxHops', { kind: 'finite', value: -1 }), /max_hops/);
    assert.throws(() => store.setLimit('maxHops', null as any), /max_hops/);
    // The per-chain turn limit is its own row; each setting reads back only its own.
    assert.equal(store.getLimit('maxTurnsPerChain'), null);
    store.setLimit('maxTurnsPerChain', { kind: 'finite', value: 40 });
    assert.deepEqual(store.getLimit('maxTurnsPerChain'), { kind: 'finite', value: 40 });
    assert.deepEqual(store.getLimit('maxHops'), { kind: 'unlimited' });
    assert.throws(() => store.setLimit('maxTurnsPerChain', { kind: 'finite', value: 1.5 }), /max_turns_per_chain/);
  } finally {
    store.close();
  }
  const again = new Store(path);
  try {
    assert.deepEqual(again.getLimit('maxHops'), { kind: 'unlimited' }, 'survives reopening');
    assert.deepEqual(again.getLimit('maxTurnsPerChain'), { kind: 'finite', value: 40 }, 'survives reopening');
    for (const bad of ['not json', 'null', '6', '{"kind":"unlimited","value":0}', '{"kind":"finite","value":-1}', '{"kind":"finite","value":"6"}', '{"kind":"finite"}', '[]']) {
      for (const [setting, key] of [['maxHops', 'max_hops'], ['maxTurnsPerChain', 'max_turns_per_chain']] as const) {
        again.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(bad, key);
        assert.throws(() => again.getLimit(setting), new RegExp(`saved setting ${key} is invalid`), bad);
      }
    }
  } finally {
    again.close();
  }
});

test('usage: a v10 database (with cluster categories) gets the empty usage tables as v11 and keeps its rows; opening again changes nothing', () => {
  const path = join(tempDir(), 'v10.db');
  const fresh = new Store(path);
  fresh.insertCluster({ id: 'c1', name: 'one', createdAt: T, category: 'work' }, []);
  fresh.close();
  const raw = new DatabaseSync(path);
  removeCollaborationSchema(raw);
  raw.exec('DROP TABLE message_acknowledgements; DROP TABLE turn_usage; DROP TABLE quota_snapshots; ALTER TABLE deliveries DROP COLUMN outcome; ALTER TABLE deliveries DROP COLUMN handoff_message_id; PRAGMA user_version = 10');   // back to the v10 layout
  raw.close();
  for (let open = 0; open < 2; open++) {
    const store = new Store(path);
    try {
      assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(store.listClusters().map((c) => [c.id, c.category]), [['c1', 'work']]);
      assert.deepEqual(store.db.prepare('SELECT * FROM turn_usage').all(), []);
      assert.equal(store.loadQuotas().size, 0);
    } finally {
      store.close();
    }
  }
});

test('acknowledgements: v11 migration preserves history and reads without inventing confirmations', () => {
  const path = join(tempDir(), 'v11.db');
  const fresh = new Store(path);
  fresh.insertCluster({ id: 'c', name: 'c', createdAt: T, category: '' }, [{
    id: 'm', clusterId: 'c', name: 'M', avatar: null, harness: 'mock', model: null, effort: null, mode: 'native',
    workerSessionId: 's', cwd: '/p', origin: 'created', removedAt: null,
  }]);
  fresh.insertMessage({ id: 'msg', clusterId: 'c', from: 'user', mentions: [], body: 'hi', replyTo: null, chainId: 'msg', hop: 0, createdAt: T }, ['m']);
  fresh.markRead('m', ['msg'], 'delivery');
  fresh.appendEvent('c', 'm', 'read', { messageIds: ['msg'], via: 'delivery' });
  fresh.close();
  const raw = new DatabaseSync(path);
  removeCollaborationSchema(raw);
  raw.exec('DROP TABLE message_acknowledgements; ALTER TABLE deliveries DROP COLUMN outcome; ALTER TABLE deliveries DROP COLUMN handoff_message_id; PRAGMA user_version = 11');
  raw.close();
  const before = readDump(path);
  for (let i = 0; i < 2; i++) {
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(dump(migrated.db), before);
      assert.deepEqual(migrated.db.prepare('SELECT via FROM reads').all().map((r) => r.via), ['delivery']);
      assert.deepEqual(migrated.acknowledgementsOf('msg'), []);
    } finally { migrated.close(); }
  }
});

test('eventJson: the JSON built around the stored payload is the event toEvent gives', () => {
  const store = new Store(join(tempDir(), 'events.db'));
  try {
    store.insertCluster({ id: 'c', name: 'c', createdAt: T, category: '' }, []);
    const payloads: unknown[] = [
      {}, [], null, 0, -1.5e-7, true, 'plain', '', { nested: { list: [1, 'two', null, { deep: [[]] }] } },
      { text: 'line one\nline two\r\nthree\ttab', quote: '"quoted" \\ back\\slash', unicode: '小B 🐭     \u0000 \u001f \ud83d' },
      { '': 'empty key', 'key "with" quotes\n': 1, 10: 'number-like key', 2: 'another' },
      { message: { id: 'm', body: '## 标题\n\n```ts\nconst a = "b";\n```\n' }, deliveries: [{ id: 'd', error: null }] },
      { big: 'x'.repeat(100_000) },
    ];
    const kinds = ['agent', 'message', 'delivery', 'member', 'cluster'] as const;
    payloads.forEach((payload, i) => store.appendEvent(i % 3 ? 'c' : null, i % 2 ? 'member "1"\n' : null, kinds[i % kinds.length], payload));
    store.appendCollaborationEvent('c', null, { action: 'task.create', title: 'a\nb' });   // rewrites its payload with the event id
    const rows = store.db.prepare('SELECT * FROM events ORDER BY seq').all();
    assert.equal(rows.length, payloads.length + 1);
    for (const row of rows) {
      assert.doesNotMatch(String(row.payload_json), /[\n\r]/, 'a stored payload has no raw line break');
      const json = eventJson(row);
      assert.doesNotMatch(json, /[\n\r]/, 'so the event fits on one SSE data line');
      assert.deepEqual(JSON.parse(json), toEvent(row));
      assert.equal(json, JSON.stringify(toEvent(row)), 'same text, same key order');
    }
    assert.deepEqual(store.eventJsonPage(0, 1000).map((e) => [e.seq, JSON.parse(e.json)]), store.listEvents(0).map((e) => [e.seq, e]));
    assert.deepEqual(store.eventJsonPage(2, 3).map((e) => e.seq), [3, 4, 5], 'after `since`, oldest first, at most `limit`');
    assert.deepEqual(store.eventJsonPage(rows.length, 3), []);
  } finally { store.close(); }
});

/** Store.withDeliveries as it was before it read each table once per list: every lookup prepared and run again for every message. */
function withDeliveriesReference(store: Store, msgs: Message[]) {
  return msgs.map((m) => {
    const rows = (sql: string) => store.db.prepare(sql).all(m.id) as any[];
    const attachments = rows('SELECT f.* FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ? ORDER BY mf.position')
      .map((r) => ({ id: r.id, clusterId: r.cluster_id, uploader: r.uploader, name: r.name, mime: r.mime, size: r.size, sha256: r.sha256, createdAt: r.created_at }));
    return {
      ...m,
      deliveries: rows('SELECT * FROM deliveries WHERE message_id = ? ORDER BY rowid').map((r) => ({
        id: r.id, messageId: r.message_id, memberId: r.member_id, state: r.state, outcome: r.outcome ?? null,
        handoffMessageId: r.handoff_message_id ?? null, error: r.error, updatedAt: r.updated_at, batchId: r.batch_id ?? null, attempts: r.attempts,
      })),
      reads: rows('SELECT * FROM reads WHERE message_id = ? ORDER BY at, member_id').map((r) => ({ memberId: r.member_id, messageId: r.message_id, via: r.via, at: r.at })),
      acknowledgements: rows('SELECT * FROM message_acknowledgements WHERE message_id = ? ORDER BY at, member_id').map((r) => ({ memberId: r.member_id, messageId: r.message_id, at: r.at })),
      taskIds: rows('SELECT task_id FROM collaboration_links WHERE message_id = ? ORDER BY rowid').map((r) => String(r.task_id)),
      bookmarks: rows('SELECT member_id, labels_json, created_at FROM collaboration_bookmarks WHERE message_id = ? ORDER BY rowid')
        .map((r) => ({ memberId: String(r.member_id), labels: JSON.parse(String(r.labels_json)) as string[], createdAt: String(r.created_at) })),
      ...(attachments.length ? { attachments } : {}),
    };
  });
}

test('withDeliveries: one query per table returns what the per-message lookups returned, field for field', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.cluster('c', ['A', 'B']);
    const path = `/api/clusters/${cluster.id}`;
    const task = (await app.api('POST', `${path}/collaboration`, { action: 'task.create', operationId: 't', title: 'T', scope: 'S', acceptance: 'D' })).task;
    const files: string[] = [];
    for (const name of ['one.txt', 'two.txt']) {
      const res = await fetch(`${app.url}/api/files?cluster=${cluster.id}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-orrery-filename': name }, body: `file ${name}`,
      });
      files.push((await res.json()).id);
    }
    const plain = await app.api('POST', `${path}/messages`, { body: 'note for all' });
    const rich = await app.api('POST', `${path}/messages`, { body: '@A @B evidence', attachments: files, taskIds: [task.id] });
    await app.api('POST', `${path}/messages`, { body: '@B only' });
    await waitFor(() => app.settled(cluster.id), 'delivered');
    await app.api('POST', `${path}/collaboration`, { action: 'bookmark.set', operationId: 'star', messageId: rich.id, labels: ['decision'] });
    app.hub.readMessages(b.id);
    app.hub.ackMessages(a.id, [rich.id, plain.id]);
    app.hub.ackMessages(b.id, [rich.id]);

    const msgs = app.hub.listMessages(cluster.id, 100);
    const got = app.store.withDeliveries(msgs);
    const want = withDeliveriesReference(app.store, msgs);
    assert.deepEqual(got, want);
    assert.equal(JSON.stringify(got), JSON.stringify(want), 'same fields in the same order');
    assert.deepEqual(app.store.withDeliveries(msgs), want, 'a second call reuses the statements');
    for (const m of msgs) assert.equal(JSON.stringify(app.store.withDeliveries([m])), JSON.stringify(withDeliveriesReference(app.store, [m])), 'one message');
    assert.deepEqual(app.store.withDeliveries([]), []);

    // The data above exercises every part.
    const richOut = got.find((m) => m.id === rich.id) as any;
    assert.deepEqual(richOut.deliveries.map((d: any) => d.memberId).sort(), [a.id, b.id].sort());
    assert.ok(richOut.reads.length >= 2);
    assert.deepEqual(richOut.acknowledgements.map((x: any) => x.memberId).sort(), [a.id, b.id].sort());
    assert.deepEqual(richOut.taskIds, [task.id]);
    assert.deepEqual(richOut.bookmarks.map((x: any) => x.labels), [['decision']]);
    assert.deepEqual(richOut.attachments.map((f: any) => f.id), files);
    const plainOut = got.find((m) => m.id === plain.id) as any;
    assert.ok(plainOut.reads.some((r: any) => r.via === 'read_messages') && !('attachments' in plainOut));
  } finally { await app.close(); }
});

test('v25 to v26 adds fyi column (default 0) and preserves legacy messages without relabeling them', () => {
  const path = join(tempDir(), 'v25.db');
  const initial = new Store(path);
  initial.insertCluster({ id: 'c', name: 'kept', createdAt: T, category: '' }, []);
  initial.insertMessage({ id: 'legacy', clusterId: 'c', from: 'user', mentions: [], body: 'old record', replyTo: null, chainId: 'legacy', hop: 0, createdAt: T }, []);
  initial.db.exec(`ALTER TABLE messages DROP COLUMN fyi; ${DROP_V27}; PRAGMA user_version = 25`);
  initial.close();

  for (let open = 0; open < 2; open++) {
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      const oldMsg = migrated.getMessage('legacy')!;
      assert.equal(oldMsg.body, 'old record');
      assert.equal(oldMsg.fyi, undefined, 'migrated v25 message stays non-fyi');
      if (open === 0) {
        migrated.insertMessage({ id: 'fyi1', clusterId: 'c', from: 'm1', mentions: ['m2'], body: 'fyi note', replyTo: null, chainId: 'fyi1', hop: 0, createdAt: T, fyi: true }, []);
      }
      assert.equal(migrated.getMessage('fyi1')!.fyi, true);
      assert.equal(migrated.withDeliveries([migrated.getMessage('fyi1')!])[0].fyi, true);
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  }
});

test('v26 to v27 migrates both empty and populated databases cleanly', () => {
  const emptyPath = join(tempDir(), 'v26-empty.db');
  const emptyInit = new Store(emptyPath);
  emptyInit.db.exec(`${DROP_V27}; PRAGMA user_version = 26`);
  emptyInit.close();
  const emptyUpgraded = new Store(emptyPath);
  try {
    assert.equal((emptyUpgraded.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
    assert.deepEqual(emptyUpgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { emptyUpgraded.close(); }

  const path = join(tempDir(), 'v26-populated.db');
  const initial = new Store(path);
  const cluster = { id: 'c', name: 'kept', createdAt: '2026-01-01T00:00:00.000Z', category: '' };
  initial.insertCluster(cluster, [
    { id: 'm-old', clusterId: 'c', name: 'Old', avatar: null, harness: 'mock', model: null, workerSessionId: 'w-old', cwd: '/p', origin: 'created', mode: 'native', effort: null, removedAt: null },
    { id: 'm-mid', clusterId: 'c', name: 'Mid', avatar: null, harness: 'mock', model: null, workerSessionId: 'w-mid', cwd: '/p', origin: 'created', mode: 'native', effort: null, removedAt: null },
  ]);
  initial.db.prepare("UPDATE members SET created_at = '2026-01-01T00:00:02.500Z' WHERE id = 'm-mid'").run();
  initial.insertMessage({ id: 'msg1', clusterId: 'c', from: 'user', mentions: [], body: 'first user note', replyTo: null, chainId: 'msg1', hop: 0, createdAt: '2026-01-01T00:00:01.000Z' }, []);
  initial.insertMessage({ id: 'msg2', clusterId: 'c', from: 'system', kind: 'system', mentions: ['m-old'], body: '确认回执：Old 确认看到了你发的 1 条消息', replyTo: null, chainId: 'msg2', hop: 0, createdAt: '2026-01-01T00:00:02.000Z' }, []);
  initial.insertMessage({ id: 'msg3', clusterId: 'c', from: 'system', kind: 'system', mentions: ['m-old'], body: '排队预警：1 条发给 @Mid 的消息等待超过 10s', replyTo: null, chainId: 'msg3', hop: 0, createdAt: '2026-01-01T00:00:03.000Z' }, []);
  initial.insertMessage({ id: 'msg4', clusterId: 'c', from: 'system', kind: 'system', mentions: ['m-old', 'm-mid'], body: '任务通知：请查看状态', replyTo: null, chainId: 'msg4', hop: 0, createdAt: '2026-01-01T00:00:04.000Z' }, []);
  initial.insertMessage({ id: 'msg5', clusterId: 'c', from: 'm-other', mentions: ['m-old', 'm-mid'], body: '@all legacy broadcast without column', replyTo: null, chainId: 'msg5', hop: 0, createdAt: '2026-01-01T00:00:05.000Z' }, []);
  initial.insertMessage({ id: 'msg6', clusterId: 'c', from: 'user', mentions: [], body: '确认回执：user chat quoting prefix', replyTo: null, chainId: 'msg6', hop: 0, createdAt: '2026-01-01T00:00:06.000Z' }, []);
  initial.db.exec(`${DROP_V27}; PRAGMA user_version = 26`);
  initial.close();

  for (let open = 0; open < 2; open++) {
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.equal((migrated.db.prepare("SELECT unread_after_rowid AS v FROM members WHERE id = 'm-old'").get() as any).v, 0);
      const msg2Rowid = (migrated.db.prepare("SELECT rowid FROM messages WHERE id = 'msg2'").get() as any).rowid;
      assert.equal((migrated.db.prepare("SELECT unread_after_rowid AS v FROM members WHERE id = 'm-mid'").get() as any).v, msg2Rowid);
      assert.equal(migrated.getMessage('msg2')!.systemKind, 'receipt');
      assert.equal(migrated.getMessage('msg3')!.systemKind, 'queue_warning');
      assert.equal(migrated.getMessage('msg4')!.systemKind, undefined);
      assert.equal(migrated.getMessage('msg1')!.systemKind, undefined);
      assert.equal(migrated.getMessage('msg6')!.systemKind, undefined, 'strict backfill leaves non-system prefix untouched');
      assert.equal(migrated.getMessage('msg5')!.explicitMentions, undefined, 'legacy @all row stays explicit_mentions_json=NULL/undefined');
      assert.equal(migrated.unreadBreakdown('m-old', 'c').mention.total, 1, 'legacy @all row stays classified as mention');
      assert.equal(migrated.unreadBreakdown('m-old', 'c').broadcast.total, 0);
      assert.equal(migrated.countUnread('m-old', 'c'), 4, 'm-old sees msg1, msg4, msg5, msg6 (not receipt msg2 or queue warning msg3)');
      assert.equal(migrated.countUnread('m-mid', 'c'), 3, 'm-mid skips pre-join msg1/msg2 and warning msg3; sees msg4, msg5, msg6');
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  }
});

test('v27 to v28 adds hidden_at: an old database upgrades with nobody hidden', () => {
  const path = join(tempDir(), 'v27.db');
  const initial = new Store(path);
  initial.insertCluster({ id: 'c', name: 'kept', createdAt: '2026-01-01T00:00:00.000Z', category: '' }, [
    { id: 'm1', clusterId: 'c', name: 'One', avatar: null, harness: 'mock', model: null, workerSessionId: 'w1', cwd: '/p', origin: 'created', mode: 'native', effort: null, removedAt: null },
  ]);
  initial.insertMessage({ id: 'msg1', clusterId: 'c', from: 'user', mentions: ['m1'], body: '@One hi', replyTo: null, chainId: 'msg1', hop: 0, createdAt: '2026-01-01T00:00:01.000Z' }, ['m1']);
  initial.db.exec(`${DROP_V28}; PRAGMA user_version = 27`);
  initial.close();
  for (let open = 0; open < 2; open++) {
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.equal(migrated.getMember('m1')!.hiddenAt, null, 'nobody is hidden after the upgrade');
      assert.equal(migrated.queued('m1').length, 1, 'rows kept');
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  }
});

test('v28 to v29: dismissed_at, state_seq with its triggers, reads.seen_at backfilled for reads and acknowledged skips', () => {
  const path = join(tempDir(), 'v28.db');
  const initial = new Store(path);
  initial.insertCluster({ id: 'c', name: 'kept', createdAt: '2026-01-01T00:00:00.000Z', category: '' }, [
    { id: 'm1', clusterId: 'c', name: 'One', avatar: null, harness: 'mock', model: null, workerSessionId: 'w1', cwd: '/p', origin: 'created', mode: 'native', effort: null, removedAt: null },
  ]);
  const msg = (id: string) => ({ id, clusterId: 'c', from: 'user', mentions: ['m1'], body: id, replyTo: null, chainId: id, hop: 0, createdAt: '2026-01-01T00:00:01.000Z' });
  const offline = ['skipped', 'read', 'unread', 'confirmed'].map((id) => {
    const [d] = initial.insertMessage(msg(id), ['m1']);
    initial.markOffline(d.id, 'gone');
    return d;
  });
  const schemaOf = (s: Store) => s.db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'deliveries_state_seq%' ORDER BY name").all().map((r) => ({ ...r }));
  const fresh = schemaOf(initial);
  initial.db.exec(`${DROP_V29}; PRAGMA user_version = 28`);
  initial.db.exec(`INSERT INTO reads (member_id, message_id, via, at) VALUES
    ('m1', 'skipped', 'skip', 't1'), ('m1', 'read', 'read_messages', 't2'), ('m1', 'confirmed', 'skip', 't3');
    INSERT INTO message_acknowledgements (member_id, message_id, at) VALUES ('m1', 'confirmed', 't4')`);
  initial.close();
  for (let open = 0; open < 2; open++) {
    const migrated = new Store(path);
    try {
      assert.equal((migrated.db.prepare('PRAGMA user_version').get() as any).user_version, 29);
      assert.deepEqual(migrated.db.prepare('SELECT id, state, dismissed_at, state_seq FROM deliveries ORDER BY rowid').all().map((r) => ({ ...r })),
        offline.map((d) => ({ id: d.id, state: 'offline', dismissed_at: null, state_seq: 0 })), 'old rows: before any listing');
      assert.deepEqual(migrated.db.prepare('SELECT message_id, via, at, seen_at FROM reads ORDER BY message_id').all().map((r) => ({ ...r })),
        [{ message_id: 'confirmed', via: 'skip', at: 't3', seen_at: 't4' },
          { message_id: 'read', via: 'read_messages', at: 't2', seen_at: 't2' }, { message_id: 'skipped', via: 'skip', at: 't1', seen_at: null }]);
      assert.deepEqual(migrated.deliveryProblems('c', 10).items.map((r) => r.message.id).sort(), ['skipped', 'unread'], 'a skip is not a read');
      assert.deepEqual(schemaOf(migrated), fresh, 'the same triggers as a new database');
      assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { migrated.close(); }
  }
});

test('hiding supersedes only unstarted deliveries, creates none, hides unread; showing restarts unread from that moment; removal clears it', () => {
  const store = new Store(join(tempDir(), 'hidden.db'));
  try {
    store.insertCluster({ id: 'c', name: 'c', createdAt: '2026-01-01T00:00:00.000Z', category: '' }, ['a', 'b'].map((id) => (
      { id, clusterId: 'c', name: id.toUpperCase(), avatar: null, harness: 'mock', model: null, workerSessionId: `w-${id}`, cwd: '/p',
        origin: 'created' as const, mode: 'native' as const, effort: null, removedAt: null })));
    const msg = (id: string, mentions: string[]): Message => ({ id, clusterId: 'c', from: 'user', mentions, body: id, replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString() });
    const [running] = store.insertMessage(msg('m-run', ['b']), ['b']);
    store.startDelivery(running.id, 'batch');
    const [queued] = store.insertMessage(msg('m-queued', ['b']), ['b']);
    const { member, superseded } = store.setMemberHidden('b', true, 'reason');
    assert.ok(member.hiddenAt);
    assert.deepEqual(superseded.map((d) => [d.id, d.state, d.error]), [[queued.id, 'superseded', 'reason']]);
    assert.equal(store.getDelivery(running.id)!.state, 'running', 'a turn already running is not interrupted');
    assert.deepEqual(store.insertMessage(msg('m-hidden', ['a', 'b']), ['a', 'b']).map((d) => d.memberId), ['a'], 'no delivery to a hidden member');
    assert.equal(store.unreadBreakdown('b', 'c').total, 0, 'nothing counts unread while hidden');
    assert.equal(store.setMemberHidden('b', true, 'again').superseded.length, 0, 'hiding twice changes nothing');
    store.setMemberHidden('b', false, '');
    assert.equal(store.getMember('b')!.hiddenAt, null);
    assert.equal(store.unreadBreakdown('b', 'c').total, 0, 'messages from before showing do not come back as unread');
    store.insertMessage(msg('m-after', ['b']), []);
    assert.equal(store.unreadBreakdown('b', 'c').total, 1, 'normal from the moment of showing');
    store.setMemberHidden('b', true, 'reason');
    assert.equal(store.removeMember('c', 'b').member.hiddenAt, null);
    assert.equal(store.getMember('b', { includeRemoved: true })!.hiddenAt, null, 'removal clears the hidden state');
  } finally { store.close(); }
});
