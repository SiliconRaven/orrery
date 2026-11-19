// The shared read-only SQLite transcript reader (src/adapters/shared/sqlite-transcript.ts) on synthetic databases.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { link, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { bounded, readSqliteTranscript, SQLITE_ROW_BYTES, type SqliteTranscriptOptions } from '../src/adapters/shared/sqlite-transcript.ts';
import { TRANSCRIPT_MAX_ITEMS, type TranscriptRequest } from '../src/core/native-transcript.ts';
import { junction } from './extensions-fixture.ts';

const SESSION = 'session-a';

async function fixture(t: TestContext, rows: unknown[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'app');
  await mkdir(root);
  const file = join(root, 'store.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY);
    CREATE TABLE item(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER, data TEXT NOT NULL);
    CREATE INDEX item_seq ON item(session_id, seq, id);
    INSERT INTO session VALUES ('session-a'), ('session-b');`);
  const insert = db.prepare('INSERT INTO item VALUES (?, ?, ?, ?)');
  const add = (value: unknown, session = SESSION) => {
    const seq = (db.prepare('SELECT ifnull(max(seq), -1) + 1 n FROM item').get() as { n: number }).n;
    insert.run(`row-${seq}`, session, seq, typeof value === 'string' && value.startsWith('raw:') ? value.slice(4) : JSON.stringify(value));
    return `row-${seq}`;
  };
  db.exec('BEGIN');
  rows.forEach(value => add(value));
  db.exec('COMMIT');
  db.close();   // a clean close deletes -wal and -shm
  let parsed = 0;
  const options: Omit<SqliteTranscriptOptions, 'request'> = {
    root, file, sessionKey: SESSION,
    schema: { session: ['id'], item: ['id', 'session_id', 'seq', 'data'] },
    session: { sql: 'SELECT 1 FROM session WHERE id = ?', params: [SESSION] },
    from: 'item', where: 'session_id = ?', params: [SESSION], order: ['seq', 'id'],
    select: `id, ${bounded('data')} AS data`,
    parse(row) {
      parsed++;
      if (row.data === null) return { items: [{ kind: 'unknown', text: 'too large', truncated: true }] };
      const value = JSON.parse(String(row.data)) as unknown;
      if (typeof value === 'string') return { items: [{ kind: 'user', text: value }], final: !value.startsWith('pending') };
      if (Array.isArray(value)) return { items: value.map(text => ({ kind: 'assistant' as const, text: String(text) })) };
      if (value === null) return { items: [] };
      return undefined;
    },
    unknownText: 'Unrecognized row.',
  };
  const page = (request: TranscriptRequest = {}, extra: Partial<SqliteTranscriptOptions> = {}) =>
    readSqliteTranscript({ ...options, ...extra, request });
  const write = (fn: (db: DatabaseSync) => void) => { const w = new DatabaseSync(file); try { fn(w); } finally { w.close(); } };
  return { dir, root, file, options, page, add: (value: unknown, session?: string) => {
    let id = ''; write(w => {
      const seq = (w.prepare('SELECT ifnull(max(seq), -1) + 1 n FROM item').get() as { n: number }).n;
      w.prepare('INSERT INTO item VALUES (?, ?, ?, ?)').run(`row-${seq}`, session ?? SESSION, seq, JSON.stringify(value));
      id = `row-${seq}`;
    }); return id;
  }, write, parsed: () => parsed };
}

test('latest, older and forward pages resume inside multi-item rows', async t => {
  const { page, add } = await fixture(t, ['old', ['a', 'b', 'c'], null, 'current']);
  const newest = await page({ limit: 2 });
  assert.equal(newest.status, 'ok');
  assert.deepEqual(newest.items.map(i => i.text), ['c', 'current']);
  assert.equal(newest.hasMore, true);
  const previous = await page({ limit: 2, cursor: newest.before });
  assert.deepEqual(previous.items.map(i => i.text), ['a', 'b']);
  const replay = await page({ limit: 2, cursor: previous.after, direction: 'after' });
  assert.deepEqual(replay.items, newest.items);
  const oldest = await page({ limit: 2, cursor: previous.before });
  assert.deepEqual(oldest.items.map(i => i.text), ['old']);
  assert.equal(oldest.before, undefined);
  assert.equal(oldest.hasMore, false);
  assert.deepEqual((await page({ direction: 'after', cursor: newest.after })).items, []);
  add(['d', 'e', 'f']);
  add('other session', 'session-b');
  const update = await page({ direction: 'after', cursor: newest.after, limit: 2 });
  assert.deepEqual(update.items.map(i => i.text), ['d', 'e']);
  assert.equal(update.hasMore, true);
  const last = await page({ direction: 'after', cursor: update.after });
  assert.deepEqual(last.items.map(i => i.text), ['f']);
  assert.equal(last.hasMore, false);
  assert.equal(new Set([...newest.items, ...previous.items, ...update.items].map(i => i.id)).size, 6);
});

test('an empty session gets a cursor, and a row the app still writes is read again with the same ID', async t => {
  const { page, add, write } = await fixture(t);
  const empty = await page();
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.items, []);
  assert.ok(empty.after);
  const id = add('pending reply');
  add(['done']);
  const first = await page({ direction: 'after', cursor: empty.after });
  assert.deepEqual(first.items.map(i => i.text), ['pending reply', 'done']);
  write(w => w.prepare("UPDATE item SET data = '\"finished reply\"' WHERE id = ?").run(id));
  const again = await page({ direction: 'after', cursor: first.after });
  assert.deepEqual(again.items.map(i => [i.id, i.text]), first.items.map((i, n) => [i.id, n ? 'done' : 'finished reply']));
  assert.deepEqual((await page({ direction: 'after', cursor: again.after })).items, []);
  const latest = await page();
  assert.deepEqual((await page({ direction: 'after', cursor: latest.after })).items, []);
});

test('missing database or session, unknown schema, bad rows and non-databases give a status, never throw', async t => {
  const { file, page, options, write } = await fixture(t, ['kept', 'raw:not json', { unknown: true }]);
  const result = await page();
  assert.deepEqual(result.items.map(i => i.kind), ['user', 'unknown', 'unknown']);
  assert.equal(result.unknownCount, 2);
  assert.equal((await page({}, { session: { sql: 'SELECT 1 FROM session WHERE id = ?', params: ['absent'] } })).status, 'missing');
  assert.equal((await page({}, { schema: { ...options.schema, item: ['id', 'renamed'] } })).status, 'unsupported');
  assert.equal((await page({}, { schema: { gone: ['id'] } })).status, 'unsupported');
  assert.equal((await page({}, { file: join(options.root, 'absent.sqlite') })).status, 'missing');
  assert.equal((await page({}, { root: join(options.root, 'absent'), file: join(options.root, 'absent', 'x.sqlite') })).status, 'missing');
  write(w => w.exec("INSERT INTO item VALUES ('row-null', 'session-a', NULL, '\"no order\"')"));
  assert.equal((await page()).status, 'unsupported');
  await writeFile(file, 'not a database at all, long enough to have a header'.repeat(200));
  assert.equal((await page()).status, 'unsupported');
});

test('cursors reset on tampering, another session, a deleted anchor row and a replaced file', async t => {
  const { file, page, write, options } = await fixture(t, ['one', 'two']);
  const start = (await page()).after!;
  const poll = (cursor: string, extra: Partial<SqliteTranscriptOptions> = {}) => page({ direction: 'after', cursor }, extra);
  assert.equal((await poll(start)).status, 'ok');
  assert.equal((await poll(`x${start.slice(1)}`)).status, 'reset');
  assert.equal((await poll(start, { sessionKey: 'session-b', params: ['session-b'] })).status, 'reset');
  write(w => w.exec("DELETE FROM item WHERE id = 'row-1'"));
  assert.equal((await poll(start)).status, 'reset');
  const before = (await page()).after!;
  await rename(file, `${file}.old`);
  const copy = new DatabaseSync(file);
  copy.exec(`CREATE TABLE session(id TEXT); CREATE TABLE item(id TEXT, session_id TEXT, seq INTEGER, data TEXT);
    INSERT INTO session VALUES ('session-a'); INSERT INTO item VALUES ('row-0', 'session-a', 0, '"one"');`);
  copy.close();
  assert.equal((await poll(before)).status, 'reset');
  assert.equal((await page()).status, 'ok', options.file);
});

test('a page reads a bounded number of rows and an oversized row becomes one unknown item', async t => {
  const rows = Array.from({ length: 3000 }, (_, i) => `row ${i}`);
  const { page, parsed, add } = await fixture(t, rows);
  const latest = await page({ limit: 10 });
  assert.deepEqual(latest.items.map(i => i.text), rows.slice(-10));
  assert.ok(parsed() <= 12, `parsed ${parsed()} rows`);
  const all = await page({ limit: 9999 });
  assert.equal(all.items.length, TRANSCRIPT_MAX_ITEMS);
  assert.ok(parsed() <= 12 + TRANSCRIPT_MAX_ITEMS + 2, `parsed ${parsed()} rows`);
  add('x'.repeat(SQLITE_ROW_BYTES + 1));
  const big = await page({ limit: 1 });
  assert.deepEqual(big.items.map(i => [i.kind, i.text, i.truncated]), [['unknown', 'too large', true]]);
});

const fingerprint = (dir: string) => Object.fromEntries(readdirSync(dir).map((name) => {
  const path = join(dir, name);
  return [name, `${statSync(path).size}:${statSync(path).mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`];
}));

test('a read writes no file: no -wal/-shm appears on a closed database and a live writer\'s -shm is untouched', async t => {
  const { root, file, page } = await fixture(t, ['one']);
  const closed = fingerprint(root);
  assert.deepEqual(Object.keys(closed), ['store.sqlite']);
  assert.deepEqual((await page()).items.map(i => i.text), ['one']);
  assert.deepEqual(fingerprint(root), closed);

  // The writer is another process, as the app is: SQLite shares one -shm mapping between connections of one process.
  const writer = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA wal_autocheckpoint=0");
    process.stdin.on('data', (d) => {
      if (String(d).includes('quit')) { db.close(); process.exit(0); }
      db.prepare('INSERT INTO item VALUES (?, ?, ?, ?)').run('row-live', 'session-a', 1, JSON.stringify('live'));
      process.stdout.write('ok');
    });
    process.stdout.write('ready');`, file], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => writer.kill());
  await once(writer.stdout, 'data');
  writer.stdin.write('insert');
  await once(writer.stdout, 'data');
  const live = fingerprint(root);
  assert.ok(live['store.sqlite-wal'] && live['store.sqlite-shm']);
  const result = await page();
  assert.deepEqual(result.items.map(i => i.text), ['one', 'live']);
  assert.deepEqual(fingerprint(root), live);
  writer.stdin.write('quit');
  await once(writer, 'exit');
  assert.ok(!existsSync(`${file}-wal`));
});

test('a -wal without its -shm (left by a crash) is not opened: unsupported, and no -shm is created', async t => {
  const { root, file, page } = await fixture(t, ['one']);
  // What a crashed writer leaves once its -shm is gone: the database and a -wal holding a commit, no -shm.
  const crashed = join(root, 'crashed.sqlite');
  const w = new DatabaseSync(file);
  try {
    w.exec('PRAGMA wal_autocheckpoint=0');
    w.prepare('INSERT INTO item VALUES (?, ?, ?, ?)').run('row-wal', SESSION, 1, JSON.stringify('only in the wal'));
    copyFileSync(file, crashed);
    copyFileSync(`${file}-wal`, `${crashed}-wal`);
  } finally { w.close(); }
  const files = fingerprint(root);
  assert.deepEqual(Object.keys(files).sort(), ['crashed.sqlite', 'crashed.sqlite-wal', 'store.sqlite']);
  const result = await page({}, { file: crashed });
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.items, []);
  assert.deepEqual(fingerprint(root), files, 'nothing created or changed');
});

test('a cursor on a finished row resets when that row is rewritten in place; a row still being written is read again', async t => {
  const { page, write, add } = await fixture(t, ['first', 'second']);
  const latest = await page();
  assert.deepEqual(latest.items.map(i => i.text), ['first', 'second']);
  assert.equal((await page({ direction: 'after', cursor: latest.after })).status, 'ok', 'unchanged: no reset');
  const older = await page({ limit: 1 });
  write(w => w.exec("UPDATE item SET data = '\"second, edited\"' WHERE id = 'row-1'"));
  assert.equal((await page({ direction: 'after', cursor: latest.after })).status, 'reset');
  assert.equal((await page({ cursor: older.before })).status, 'reset', 'also when paging back from it');

  const now = (await page()).after!;
  const id = add('pending reply');
  const first = await page({ direction: 'after', cursor: now });
  assert.deepEqual(first.items.map(i => i.text), ['pending reply']);
  write(w => w.prepare("UPDATE item SET data = '\"pending, more text\"' WHERE id = ?").run(id));
  const again = await page({ direction: 'after', cursor: first.after });
  assert.equal(again.status, 'ok');
  assert.deepEqual(again.items.map(i => [i.id, i.text]), [[first.items[0]!.id, 'pending, more text']]);
});

test('paths outside the root, hard links and junctions are refused, also for the -wal file', async t => {
  const { dir, root, file, page, options } = await fixture(t, ['one']);
  const outside = join(dir, 'outside');
  await mkdir(outside);
  const foreign = join(outside, 'store.sqlite');
  await writeFile(foreign, readFileSync(file));
  assert.equal((await page({}, { file: foreign })).status, 'refused');
  assert.equal((await page({}, { file: join(root, '..', 'outside', 'store.sqlite') })).status, 'refused');
  const alias = join(root, 'alias');
  if (junction(outside, alias)) assert.equal((await page({}, { file: join(alias, 'store.sqlite') })).status, 'refused');
  const hard = join(root, 'hard.sqlite');
  await link(foreign, hard);
  assert.equal((await page({}, { file: hard })).status, 'refused');
  await writeFile(join(outside, 'wal'), '');
  await link(join(outside, 'wal'), `${file}-wal`);
  assert.equal((await page()).status, 'refused');
  assert.equal(options.file, file);
});
