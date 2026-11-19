import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveConfig } from './config.ts';

/** Timestamp used in backup names: local time, YYYYMMDD-HHmmss. */
function stamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-`
    + `${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

/**
 * The suffix of the backups the Hub makes on its own before a schema upgrade (docs/architecture.md「升级前备份」):
 * `orrery-YYYYMMDD-HHmmss-pre-upgrade.db`, with `-N` after the time when one of the same second exists. Only these are
 * rotated; a manual backup (`npm run backup`) has no suffix.
 */
export const AUTO_BACKUP_LABEL = 'pre-upgrade';
/** How many automatic backups are kept; older ones are deleted after a start whose upgrade finished. */
export const AUTO_BACKUPS_KEPT = 5;
const AUTO_BACKUP_RE = /^orrery-(\d{8}-\d{6})(?:-(\d+))?-pre-upgrade\.db$/;   // AUTO_BACKUP_LABEL
/** The automatic backups in `directory`, oldest first (by the time in the name, then the tiebreaker). */
function automaticBackups(directory: string): string[] {
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const key = (name: string) => { const m = AUTO_BACKUP_RE.exec(name)!; return `${m[1]}-${(m[2] ?? '0').padStart(6, '0')}`; };
  return names.filter((name) => AUTO_BACKUP_RE.test(name)).sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Copy the database with VACUUM INTO without opening it through Store (no migrations). Returns the new path. A `label`
 * goes into the name after the time (the automatic backups' AUTO_BACKUP_LABEL); with a label, a name already taken in
 * the same second gets `-2`, `-3`… after the time instead of failing. A copy that fails half-way is removed.
 */
export function backupDatabase(dbPath: string, home: string, targetDir: string | undefined, now = new Date(), label?: string): string {
  const directory = resolve(targetDir ?? join(home, 'backups'));
  mkdirSync(directory, { recursive: true });
  const name = (n: number) => join(directory, `orrery-${stamp(now)}${n > 1 ? `-${n}` : ''}${label ? `-${label}` : ''}.db`);
  // With a label: one above the highest of this second already there, so a later backup always sorts after an earlier
  // one even when rotation has deleted some of the same second.
  let next = 1;
  if (label) {
    const head = `orrery-${stamp(now)}`;
    const tail = `-${label}.db`;
    for (const taken of readdirSync(directory)) {
      if (!taken.startsWith(head) || !taken.endsWith(tail)) continue;
      const middle = taken.slice(head.length, taken.length - tail.length);
      const n = middle === '' ? 1 : Number(/^-(\d+)$/.exec(middle)?.[1] ?? 0);
      next = Math.max(next, n + 1);
    }
  }
  const target = name(next);
  if (existsSync(target)) throw new Error(`备份目标已存在，不覆盖：${target}`);
  if (!existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);
  // The target is bound as a statement parameter, so directories with quotes stay path text, never SQL.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch (e) {
    rmSync(target, { force: true });   // a partial file must not count as a backup
    throw e;
  } finally {
    db.close();
  }
  return target;
}

/** Deletes all but the newest `keep` automatic backups in `directory` (by the time in their names), and never one named
 *  in `spare`; manual ones stay. */
export function pruneAutomaticBackups(directory: string, keep = AUTO_BACKUPS_KEPT, spare: readonly string[] = []): string[] {
  const automatic = automaticBackups(directory).filter((name) => !spare.includes(name));
  const old = automatic.slice(0, Math.max(0, automatic.length - keep));
  for (const name of old) rmSync(join(directory, name), { force: true });
  return old;
}

/**
 * The marker of an unfinished upgrade sequence in the backups folder: it names the first automatic backup made since the
 * last complete start (every migration finished, nothing skipped), the earliest restore point of this sequence.
 */
export const BASELINE_MARKER = 'pre-upgrade-baseline.txt';

/** The marked baseline: null (no unfinished sequence), the backup's name, or 'corrupt' (unreadable, or names no backup). */
function readBaseline(directory: string): string | null | 'corrupt' {
  let text: string;
  try { text = readFileSync(join(directory, BASELINE_MARKER), 'utf8').trim(); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'corrupt';
  }
  return AUTO_BACKUP_RE.test(text) && existsSync(join(directory, text)) ? text : 'corrupt';
}

/**
 * The composition root's StoreUpgrade (docs/architecture.md「升级前备份」).
 * - `backup()`: every start that is about to run a pending step makes a fresh backup, so the newest committed data is
 *   always covered. The first one since the last complete start is the sequence's baseline (BASELINE_MARKER). Then old
 *   automatic backups go, but never the baseline: the baseline and the newest four others stay. A marker that cannot be
 *   read or written makes this prune nothing until a complete start.
 * - `done()`: Store calls it after a complete start (every migration finished, nothing skipped, whether or not anything
 *   was pending): the sequence is over, the marker goes and the newest five automatic backups stay.
 * A plugin step that keeps failing therefore costs one backup (one VACUUM INTO) per start.
 */
export function automaticUpgradeBackup(dbPath: string, directory: string, now: () => Date = () => new Date()) {
  const log = (what: string, e: unknown) => console.error(`${what}:`, e instanceof Error ? e.message : e);
  return {
    backup(): string {
      const made = backupDatabase(dbPath, directory, directory, now(), AUTO_BACKUP_LABEL);
      let baseline = readBaseline(directory);
      if (baseline === null) {
        try { writeFileSync(join(directory, BASELINE_MARKER), `${basename(made)}\n`); baseline = basename(made); } catch (e) {
          log('could not mark the upgrade baseline, so no automatic backup is deleted until an upgrade finishes', e);
          baseline = 'corrupt';
        }
      }
      if (baseline !== 'corrupt') {
        try { pruneAutomaticBackups(directory, AUTO_BACKUPS_KEPT - 1, [baseline]); } catch (e) { log('could not delete old automatic backups', e); }
      }
      return made;
    },
    done(): void {
      try {
        rmSync(join(directory, BASELINE_MARKER), { force: true });
        if (existsSync(directory)) pruneAutomaticBackups(directory);
      } catch (e) { log('could not delete old automatic backups', e); }
    },
  };
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
