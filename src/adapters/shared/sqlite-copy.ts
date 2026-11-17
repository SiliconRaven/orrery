// Reading an app's private SQLite database without touching it: the database and its -wal are copied into a temp
// folder, the copy is read, then deleted. Never opened in place (even a reader of a WAL database writes its -shm).
// By default, an app's missing or unreadable database reads as nothing; strictRead preserves read errors.
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function pathKey(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** A time column as ISO: epoch ms or seconds, or a date text; null when unreadable. */
export function timeOf(v: unknown): string | null {
  let d: Date | null = null;
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = Number(v);
    d = n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : null;
  } else if (typeof v === 'string' && v.trim()) d = new Date(/^\d+$/.test(v.trim()) ? Number(v) : v);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export const truthy = (v: unknown) => v === 1 || v === 1n || v === true || v === '1' || v === 'true';

/** `fallback` when the file cannot be copied; unreadable copies also fall back unless strictRead is set. */
export async function withCopy<T>(home: string, file: string, fallback: T, read: (db: DatabaseSync) => T,
  { strictRead = false }: { strictRead?: boolean } = {}): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), 'orrery-sqlite-'));
  try {
    try {
      await copyFile(join(home, file), join(tmp, 'db.sqlite'));
    } catch {
      return fallback;   // the app never ran here
    }
    // shortcut: the two copies are not one snapshot; a checkpoint in between can tear the copy (the read then fails or
    // misses rows until the next refresh). Upgrade to a retry if real lists come out wrong.
    await copyFile(join(home, `${file}-wal`), join(tmp, 'db.sqlite-wal')).catch(() => {});
    const db = new DatabaseSync(join(tmp, 'db.sqlite'));
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch (error) {
    if (strictRead) throw error;
    return fallback;   // a torn or unexpected copy reads as nothing
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Rows of `table`, with only those of `columns` the table has (the rest come back undefined); [] when a required column is missing. */
export function tableRows(db: DatabaseSync, table: string, columns: string[], required: string[], where = '', params: string[] = []): Record<string, unknown>[] {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  if (!required.every((c) => have.has(c))) return [];
  const cols = columns.filter((c) => have.has(c));
  return db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ${where}`).all(...params) as Record<string, unknown>[];
}
