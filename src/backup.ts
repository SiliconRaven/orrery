import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveConfig } from './config.ts';

/** Timestamp used in backup names: local time, YYYYMMDD-HHmmss. */
function stamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-`
    + `${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

/** Copy the database with VACUUM INTO without opening it through Store (no migrations). Returns the new path. */
export function backupDatabase(dbPath: string, home: string, targetDir: string | undefined, now = new Date()): string {
  const directory = resolve(targetDir ?? join(home, 'backups'));
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `orrery-${stamp(now)}.db`);
  if (existsSync(target)) throw new Error(`备份目标已存在，不覆盖：${target}`);
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  // The target is bound as a statement parameter, so directories with quotes stay path text, never SQL.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  return target;
}

function main(): void {
  const config = resolveConfig(process.env);
  const target = backupDatabase(config.dbPath, config.home, process.argv[2], new Date());
  console.log(target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
