import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.ts';
import { backupDatabase } from '../src/backup.ts';
import { tempDir } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');

function tablesAndCounts(path: string, readOnly = true): { tables: string[]; counts: Record<string, number>; userVersion: number } {
  const db = new DatabaseSync(path, { readOnly });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((row) => String((row as Record<string, unknown>).name));
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as Record<string, unknown>;
      counts[table] = Number(row.n);
    }
    const version = db.prepare('PRAGMA user_version').get() as Record<string, unknown>;
    return { tables, counts, userVersion: Number(Object.values(version)[0]) };
  } finally { db.close(); }
}

function sourceDatabase(dir: string): string {
  const dbPath = join(dir, 'source.db');
  const store = new Store(dbPath);
  try {
    store.insertCluster({ id: 'c1', name: '备份测试', category: '', createdAt: '2026-11-08T00:00:00.000Z' },
      [{ id: 'm1', clusterId: 'c1', name: 'A', avatar: null, harness: 'mock', model: null, effort: null,
        workerSessionId: 's1', cwd: dir, origin: 'attached', removedAt: null }]);
  } finally { store.close(); }
  return dbPath;
}

test('npm run backup copies the database without touching the source', () => {
  const dir = tempDir();
  try {
    const dbPath = sourceDatabase(dir);
    const before = tablesAndCounts(dbPath);
    assert.ok(before.tables.length > 0);
    const outDir = join(dir, 'out');
    const result = spawnSync(process.execPath, ['src/backup.ts', outDir],
      { cwd: root, encoding: 'utf8', env: { ...process.env, ORRERY_DB: dbPath, ORRERY_HOME: join(dir, 'home') } });
    assert.equal(result.status, 0, result.stderr);
    const target = result.stdout.trim();
    assert.ok(target.startsWith(outDir), `unexpected path: ${target}`);
    assert.ok(existsSync(target));
    assert.deepEqual(tablesAndCounts(target), before, 'backup has the same tables, rows and user_version');
    assert.deepEqual(tablesAndCounts(dbPath), before, 'the source database is unchanged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the target directory defaults to ORRERY_HOME/backups', () => {
  const dir = tempDir();
  try {
    const dbPath = sourceDatabase(dir);
    const home = join(dir, 'home');
    const result = spawnSync(process.execPath, ['src/backup.ts'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, ORRERY_DB: dbPath, ORRERY_HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    const target = result.stdout.trim();
    assert.equal(resolve(target), resolve(join(home, 'backups', target.split(/[\\/]/).at(-1)!)));
    assert.deepEqual(readdirSync(join(home, 'backups')), [target.split(/[\\/]/).at(-1)!]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an existing backup target is refused instead of overwritten', () => {
  const dir = tempDir();
  try {
    const dbPath = sourceDatabase(dir);
    const now = new Date(2026, 10, 8, 12, 34, 56);
    const first = backupDatabase(dbPath, join(dir, 'home'), join(dir, 'out'), now);
    assert.ok(existsSync(first));
    assert.throws(() => backupDatabase(dbPath, join(dir, 'home'), join(dir, 'out'), now),
      (error: Error) => /已存在/.test(error.message));
    const after = tablesAndCounts(first);
    assert.ok(after.tables.length > 0, 'the first backup is left intact');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the target path is bound, so a directory with quotes is safe', () => {
  const dir = tempDir();
  try {
    const dbPath = sourceDatabase(dir);
    const outDir = join(dir, "out'dir");
    const target = backupDatabase(dbPath, join(dir, 'home'), outDir, new Date(2026, 10, 8, 12, 34, 56));
    assert.ok(existsSync(target), 'the quote is path text, not SQL');
    assert.ok(tablesAndCounts(target).tables.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a source database held open by another connection can be backed up', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const store = new Store(dbPath);
    try {
      store.insertCluster({ id: 'c1', name: '备份测试', category: '', createdAt: '2026-11-08T00:00:00.000Z' }, []);
      const before = store.db.prepare('PRAGMA user_version').get();
      const target = backupDatabase(dbPath, join(dir, 'home'), join(dir, 'out'), new Date(2026, 10, 8, 12, 34, 57));
      assert.ok(existsSync(target));
      const after = store.db.prepare('PRAGMA user_version').get();
      assert.deepEqual(after, before, 'the live source connection is untouched');
      assert.ok(tablesAndCounts(target).counts.clusters >= 1);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commits still in the WAL file (not yet checkpointed) are in the backup, which stands alone', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'source.db');
    const store = new Store(dbPath);
    try {
      for (let i = 0; i < 5; i++) store.insertCluster({ id: `c${i}`, name: `c${i}`, category: '', createdAt: '2026-11-15T00:00:00.000Z' }, []);
      assert.ok(statSync(`${dbPath}-wal`).size > 0, 'the commits are in the WAL file');
      const target = backupDatabase(dbPath, join(dir, 'home'), join(dir, 'out'), new Date(2026, 10, 15, 12, 0, 0));
      assert.ok(statSync(`${dbPath}-wal`).size > 0, 'the backup did not checkpoint the live database');
      assert.equal(existsSync(`${target}-wal`), false, 'the backup is one file');
      const copy = join(dir, 'alone', 'copy.db');   // away from the source's side files
      mkdirSync(join(dir, 'alone'));
      copyFileSync(target, copy);
      assert.equal(tablesAndCounts(copy).counts.clusters, 5);
      const check = new DatabaseSync(copy, { readOnly: true });
      try { assert.equal(Object.values(check.prepare('PRAGMA integrity_check').get() as object)[0], 'ok'); } finally { check.close(); }
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
