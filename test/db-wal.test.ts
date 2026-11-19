// The database's journal mode and durability settings (docs/architecture.md, storage): WAL with every commit flushed,
// the fallback and the forcing variable, waiting for other processes, the checkpoint, the test-only fast mode, and a
// process killed mid-write. Every Store here is opened with the product's settings unless a test says otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { dbModeOf } from '../src/config.ts';
import { Hub } from '../src/core/hub.ts';
import { BUSY_TIMEOUT_MS, DEFAULT_DB_MODE, Store, WAL_SIZE_LIMIT_BYTES } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { fixtureNativeMock, startTestHub, tempDir, waitFor } from './helpers.ts';

const pragma = (db: DatabaseSync, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0];
const walSize = (path: string) => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
const STORE_URL = pathToFileURL(join(REPO_ROOT, 'src', 'core', 'store.ts')).href;
/** A child's environment without the test fast mode: what the product runs with. */
const productEnv = () => { const env = { ...process.env }; delete env.ORRERY_TEST_DB_SYNC; return env; };

function addCluster(store: Store, dir: string, id = 'c'): void {
  store.insertCluster({ id, name: id, createdAt: 'now', category: '' }, [{
    id: `${id}-m`, clusterId: id, name: 'A', avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: `${id}-s`, cwd: dir, origin: 'created', removedAt: null,
  }]);
}

test('db: a fresh database opens in WAL with every commit flushed, the busy timeout and the WAL size limit', () => {
  const store = new Store(join(tempDir(), 'fresh.db'));
  try {
    assert.equal(store.journalMode, 'wal');
    assert.equal(store.journalWarning, null);
    assert.equal(pragma(store.db, 'journal_mode'), 'wal');
    assert.equal(pragma(store.db, 'synchronous'), 2, 'FULL');
    assert.equal(pragma(store.db, 'busy_timeout'), BUSY_TIMEOUT_MS);
    assert.equal(pragma(store.db, 'journal_size_limit'), WAL_SIZE_LIMIT_BYTES);
  } finally { store.close(); }
});

test('db: an existing rollback-journal database is switched to WAL on open and keeps its data', () => {
  const dir = tempDir();
  const path = join(dir, 'old.db');
  const old = new Store(path, undefined, { journal: 'delete', synchronous: 'full' });   // what earlier builds made
  addCluster(old, dir);
  old.close();
  const raw = new DatabaseSync(path);
  assert.equal(pragma(raw, 'journal_mode'), 'delete');
  raw.close();

  const store = new Store(path);
  try {
    assert.equal(store.journalMode, 'wal');
    assert.deepEqual(store.listClusters().map((c) => c.id), ['c']);
    assert.equal(store.listMembers('c').length, 1);
  } finally { store.close(); }
});

test('db: when SQLite keeps the old mode (a network share), the Hub starts in it and says so in one line', () => {
  const dir = tempDir();
  const path = join(dir, 'share.db');
  const refused = new Store(path, undefined, DEFAULT_DB_MODE, (db) => String(pragma(db, 'journal_mode')));
  try {
    assert.equal(refused.journalMode, 'delete');
    assert.match(refused.journalWarning ?? '', /^database journal mode is 'delete', not 'wal'/);
    assert.doesNotMatch(refused.journalWarning ?? '', /\n/);
    addCluster(refused, dir);
    assert.equal(refused.listClusters().length, 1);
    assert.equal(pragma(refused.db, 'synchronous'), 2);
    refused.checkpoint();   // nothing to do outside WAL
  } finally { refused.close(); }

  const thrown = new Store(path, undefined, DEFAULT_DB_MODE, () => { throw new Error('disk I/O error'); });
  try {
    assert.equal(thrown.journalMode, 'delete');
    assert.ok(thrown.journalWarning);
  } finally { thrown.close(); }
});

test('db: ORRERY_DB_JOURNAL=delete switches a WAL database back; unknown values are refused at start', () => {
  assert.deepEqual(dbModeOf({}), { journal: 'wal', synchronous: 'full' });
  assert.deepEqual(dbModeOf({ ORRERY_DB_JOURNAL: '', ORRERY_TEST_DB_SYNC: '' }), { journal: 'wal', synchronous: 'full' });
  assert.equal(dbModeOf({ ORRERY_DB_JOURNAL: 'DELETE' }).journal, 'delete');
  assert.throws(() => dbModeOf({ ORRERY_DB_JOURNAL: 'wall' }), /ORRERY_DB_JOURNAL must be wal or delete, not "wall"/);

  const dir = tempDir();
  const path = join(dir, 'back.db');
  const wal = new Store(path);
  addCluster(wal, dir);
  wal.close();
  const back = new Store(path, undefined, dbModeOf({ ORRERY_DB_JOURNAL: 'delete' }));
  try {
    assert.equal(back.journalMode, 'delete');
    assert.equal(back.journalWarning, null);
    assert.equal(back.listClusters().length, 1);
    assert.equal(existsSync(`${path}-wal`), false);
  } finally { back.close(); }
  const raw = new DatabaseSync(path);
  assert.equal(pragma(raw, 'journal_mode'), 'delete', 'the file itself is back in rollback mode');
  raw.close();

  const r = spawnSync(process.execPath, ['src/main.ts'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000,
    env: { ...productEnv(), ORRERY_DB_JOURNAL: 'bogus', ORRERY_PORT: '0', ORRERY_HOME: join(dir, 'home'), ORRERY_DB: join(dir, 'h.db') },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ORRERY_DB_JOURNAL must be wal or delete, not "bogus"/);
  assert.equal(existsSync(join(dir, 'h.db')), false, 'refused before the database was opened');
});

test('db: a reader holding a snapshot (as the backup does) does not block a write; a held write lock fails after the timeout', () => {
  const dir = tempDir();
  const path = join(dir, 'busy.db');
  const store = new Store(path);
  try {
    addCluster(store, dir, 'c1');
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec('BEGIN');
    assert.equal(Number(pragma(reader, 'user_version')) > 0, true);
    reader.prepare('SELECT COUNT(*) FROM clusters').get();
    const started = Date.now();
    addCluster(store, dir, 'c2');
    assert.ok(Date.now() - started < 1000, 'the write did not wait for the reader');
    assert.equal(Number(Object.values(reader.prepare('SELECT COUNT(*) FROM clusters').get() as object)[0]), 1, 'the reader keeps its snapshot');
    reader.exec('COMMIT');
    reader.close();

    const writer = new DatabaseSync(path);
    writer.exec('BEGIN IMMEDIATE');
    const t = Date.now();
    assert.throws(() => addCluster(store, dir, 'c3'), /database is locked/);
    const waited = Date.now() - t;
    writer.exec('ROLLBACK');
    writer.close();
    assert.ok(waited >= BUSY_TIMEOUT_MS - 100 && waited < BUSY_TIMEOUT_MS + 3000, `waited ${waited} ms`);
    addCluster(store, dir, 'c3');   // the error was for that statement only
    assert.equal(store.listClusters().length, 3);
  } finally { store.close(); }
});

test('db: in rollback mode a write waits for another process\'s reader and then succeeds', async () => {
  const dir = tempDir();
  const path = join(dir, 'rollback.db');
  const store = new Store(path, undefined, { journal: 'delete', synchronous: 'full' });
  try {
    addCluster(store, dir, 'c1');
    const holdMs = 500;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.env.DB, { readOnly: true });
      db.exec('BEGIN'); db.prepare('SELECT COUNT(*) FROM clusters').get();
      process.stdout.write('ready\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
      db.exec('COMMIT'); db.close();
    `], { env: { ...productEnv(), DB: path }, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    await waitFor(() => out.includes('ready'), 'the reader to hold its snapshot', 10_000);
    const started = Date.now();
    addCluster(store, dir, 'c2');   // commit needs the reader gone: waits, does not fail
    const waited = Date.now() - started;
    assert.ok(waited >= 100 && waited < BUSY_TIMEOUT_MS, `waited ${waited} ms`);
    assert.equal(store.listClusters().length, 2);
    await new Promise((ok) => child.once('exit', ok));
  } finally { store.close(); }
});

test('db: the checkpoint empties the WAL file, never throws, and leaves a pinned log for the next sweep', () => {
  const dir = tempDir();
  const path = join(dir, 'ckpt.db');
  const store = new Store(path);
  try {
    for (let i = 0; i < 20; i++) addCluster(store, dir, `c${i}`);
    assert.ok(walSize(path) > 0, 'the commits are in the WAL file');
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM clusters').get();
    addCluster(store, dir, 'late');
    const t = Date.now();
    store.checkpoint();   // a reader pins the log: no wait, no throw
    assert.ok(Date.now() - t < 500, 'the checkpoint did not wait for the reader');
    assert.ok(walSize(path) > 0);
    reader.exec('COMMIT');
    reader.close();
    store.checkpoint();
    assert.equal(walSize(path), 0, 'truncated once nothing pins it');
    assert.equal(store.listClusters().length, 21);
    store.checkpoint();   // nothing new: no-op
  } finally { store.close(); }
  store.checkpoint();   // closed: still no throw
});

test('db: the Hub\'s idle sweep checkpoints the WAL file', async () => {
  const app = await startTestHub({ limits: { idleSweepMs: 50 } });
  try {
    await app.cluster('sweep', ['A', 'B']);
    const path = join(app.dir, 'test.db');
    await waitFor(() => walSize(path) === 0, 'the sweep to truncate the WAL file');
    assert.equal(app.store.listClusters().length, 1);
  } finally { await app.close(); }
});

test('db: ORRERY_TEST_DB_SYNC is test-only; without it commits are flushed (FULL), with it they are not (OFF)', async () => {
  assert.equal(dbModeOf({}).synchronous, 'full');
  assert.equal(dbModeOf({ ORRERY_TEST_DB_SYNC: 'off' }).synchronous, 'off');
  assert.throws(() => dbModeOf({ ORRERY_TEST_DB_SYNC: 'normal' }), /ORRERY_TEST_DB_SYNC must be full or off/);
  const dir = tempDir();
  for (const [mode, expected] of [[dbModeOf({}), 2], [dbModeOf({ ORRERY_TEST_DB_SYNC: 'off' }), 0]] as const) {
    const store = new Store(join(dir, `${mode.synchronous}.db`), undefined, mode);
    try { assert.equal(pragma(store.db, 'synchronous'), expected); } finally { store.close(); }
  }
  // test/helpers.ts turns the fast mode on for test Hubs; a test can ask for the product's settings back.
  assert.equal(process.env.ORRERY_TEST_DB_SYNC, 'off');
  const fast = await startTestHub();
  try { assert.equal(pragma(fast.store.db, 'synchronous'), 0); } finally { await fast.close(); }
  const product = await startTestHub({ dbMode: DEFAULT_DB_MODE });
  try { assert.equal(pragma(product.store.db, 'synchronous'), 2); } finally { await product.close(); }
});

test('db: a process killed mid-write loses no acknowledged commit, and its running delivery becomes unknown, not re-delivered', async () => {
  const dir = tempDir();
  const path = join(dir, 'crash.db');
  // The product's settings (the Store default). Each row is acknowledged on stdout only after its commit returned.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeSync } from 'node:fs';
    import { Store } from ${JSON.stringify(STORE_URL)};
    const store = new Store(process.env.DB);
    store.insertCluster({ id: 'c', name: 'c', createdAt: 'now', category: '' }, [{
      id: 'm', clusterId: 'c', name: 'A', avatar: null, harness: 'mock', model: null, effort: null,
      workerSessionId: 's1', cwd: process.env.DIR, origin: 'created', removedAt: null }]);
    const [d] = store.insertMessage({ id: 'msg', clusterId: 'c', from: 'user', mentions: ['m'], body: 'work', replyTo: null, chainId: 'msg', hop: 0, createdAt: 'now' }, ['m']);
    store.startDelivery(d.id, d.id);
    store.db.exec('CREATE TABLE crash_rows (n INTEGER PRIMARY KEY)');
    const insert = store.db.prepare('INSERT INTO crash_rows VALUES (?)');
    writeSync(1, 'delivery ' + d.id + '\\n');
    for (let n = 1; n < 1e7; n++) { insert.run(n); writeSync(1, n + '\\n'); }
  `], { env: { ...productEnv(), DB: path, DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((ok) => child.once('exit', ok));
  await waitFor(() => (out.match(/^\d+$/gm)?.length ?? 0) >= 300, '300 acknowledged commits', 20_000);
  child.kill('SIGKILL');   // TerminateProcess on Windows: no exit handlers, no close
  await exited;
  const acked = Math.max(...(out.match(/^\d+$/gm) ?? []).map(Number));
  const deliveryId = /^delivery (\S+)$/m.exec(out)![1];
  assert.ok(walSize(path) > 0, 'the commits were still in the WAL file, not checkpointed');

  const store = new Store(path);
  try {
    assert.equal(pragma(store.db, 'integrity_check'), 'ok');
    const { rows, max } = store.db.prepare('SELECT COUNT(*) AS rows, MAX(n) AS max FROM crash_rows').get() as { rows: number; max: number };
    assert.ok(max >= acked, `every acknowledged row is there (acked ${acked}, found ${max})`);
    assert.equal(rows, max, 'no gaps');
    assert.equal(store.getDelivery(deliveryId)!.state, 'running');

    const mock = fixtureNativeMock(dir);
    const hub = new Hub({ store, nativeAdapters: { mock } });
    try {
      hub.start();
      assert.deepEqual([store.getDelivery(deliveryId)!.state, store.getDelivery(deliveryId)!.outcome], ['failed', 'unknown']);
      await new Promise((ok) => setTimeout(ok, 200));
      assert.equal(mock.delivered.length, 0, 'not delivered again');
    } finally { await hub.close(); }
  } finally { store.close(); }
});
