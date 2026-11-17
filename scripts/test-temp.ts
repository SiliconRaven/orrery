// Test temp directories: tempDir()'s per-process cleanup (test/helpers.ts), the age-based sweep at the start of
// `npm test` (scripts/test.mjs) and the manual `npm run clean:temp` (scripts/clean-temp.ts) all delete through here.
// Rule: only a directory that is a direct child of the temp root, named with an exact prefix, and not a link or other
// reparse point (lstat says directory, its real path is exactly root/name). Anything else is left alone.
import { lstatSync, readdirSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { join, sep } from 'node:path';

export const TEST_TEMP_PREFIX = 'orrery-test-';
/** Set to anything but '' or '0' to keep every test temp directory (no exit cleanup, no sweep) for inspection. */
export const KEEP_ENV = 'ORRERY_KEEP_TEST_TEMP';
/** The sweep only takes directories this much older than now, so a concurrent run's fresh ones are never touched. */
export const SWEEP_AGE_MS = 2 * 60 * 60 * 1000;

export type EntryType = 'dir' | 'file' | 'link' | 'other';
export interface Entry { name: string; type: EntryType; mtimeMs: number }

type Env = Record<string, string | undefined>;

export function keepTestTemp(env: Env = process.env): boolean {
  const value = env[KEEP_ENV];
  return value !== undefined && value !== '' && value !== '0';
}

/** A bare entry name with the prefix and something after it: no separators, no '.' or '..'. */
export function hasOwnName(name: string, prefix: string): boolean {
  return prefix.length > 0 && name.startsWith(prefix) && name.length > prefix.length && !/[\\/]/.test(name)
    && name !== '.' && name !== '..';
}

/**
 * What a sweep or clean:temp does with each entry of the temp root, from one call so a preview lists exactly what is
 * deleted. `delete`: directories (not links, files or anything else) with the exact prefix whose mtime is at least
 * `maxAgeMs` before `now` (maxAgeMs 0: any age). `fresh`: prefix matches kept by the age rule. `kept`: every other
 * orrery-* directory, counted by prefix (the name up to its last '-', as mkdtemp names them). The opt-out keeps all.
 */
export interface Selection { delete: string[]; fresh: string[]; kept: Map<string, number> }

export function selectTemp(now: number, entries: Entry[],
  { prefix = TEST_TEMP_PREFIX, maxAgeMs = SWEEP_AGE_MS, env = process.env as Env } = {}): Selection {
  const selection: Selection = { delete: [], fresh: [], kept: new Map() };
  const keepAll = keepTestTemp(env);
  for (const e of entries) {
    if (e.type !== 'dir') continue;
    if (hasOwnName(e.name, prefix) && !keepAll) {
      (now - e.mtimeMs >= maxAgeMs ? selection.delete : selection.fresh).push(e.name);
    } else if (e.name.startsWith('orrery-')) {
      const key = /^(orrery-.*-)[^-]+$/.exec(e.name)?.[1] ?? e.name;
      selection.kept.set(key, (selection.kept.get(key) ?? 0) + 1);
    }
  }
  selection.delete.sort();
  selection.fresh.sort();
  return selection;
}

/** Pure core of the sweep: the paths under `root` that selectTemp marks for deletion. */
export function pickStale(root: string, now: number, entries: Entry[],
  options: { prefix?: string; maxAgeMs?: number; env?: Env } = {}): string[] {
  return selectTemp(now, entries, options).delete.map((name) => join(root, name));
}

function typeOf(stat: Stats): EntryType {
  if (stat.isSymbolicLink()) return 'link';   // Node reports Windows junctions as links too
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

/** The direct children of `root` as entries (lstat: links are not followed). Unreadable children are skipped. */
export function listEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  for (const name of readdirSync(root)) {
    try {
      const stat = lstatSync(join(root, name));
      entries.push({ name, type: typeOf(stat), mtimeMs: stat.mtimeMs });
    } catch { /* gone or unreadable: not ours to judge */ }
  }
  return entries;
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Deletes root/name if, right now, it is a real directory directly under the real `root` with the exact prefix.
 * Returns 'removed', 'missing', or 'refused' (not a match: nothing touched); throws when the delete itself fails.
 */
export function removeTestDir(root: string, name: string, prefix = TEST_TEMP_PREFIX): 'removed' | 'missing' | 'refused' {
  if (!hasOwnName(name, prefix)) return 'refused';
  const realRoot = realpathSync.native(root);
  const target = join(realRoot, name);
  let stat;
  try { stat = lstatSync(target); } catch (error: any) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return 'refused';
  // A reparse point Node does not report as a link (or any redirection) resolves somewhere else: refuse it.
  const real = realpathSync.native(target);
  if (!samePath(real, target) || !samePath(real.slice(0, real.lastIndexOf(sep)), realRoot)) return 'refused';
  rmSync(target, { recursive: true, force: true });
  return 'removed';
}

export interface SweepResult { removed: string[]; failed: { path: string; error: string }[] }

/** Deletes the given names under `root` through removeTestDir, one by one. Never throws. */
export function removeSelected(root: string, names: string[], prefix = TEST_TEMP_PREFIX): SweepResult {
  const result: SweepResult = { removed: [], failed: [] };
  for (const name of names) {
    const path = join(root, name);
    try {
      if (removeTestDir(root, name, prefix) === 'removed') result.removed.push(path);
    } catch (error: any) {
      result.failed.push({ path, error: String(error?.code ?? error) });
    }
  }
  return result;
}

/** Lists `root`, selects with selectTemp and deletes the selection through removeTestDir. Never throws. */
export function sweep(root: string, { now = Date.now(), prefix = TEST_TEMP_PREFIX, maxAgeMs = SWEEP_AGE_MS, env = process.env as Env } = {}): SweepResult {
  let names: string[];
  try { names = selectTemp(now, listEntries(root), { prefix, maxAgeMs, env }).delete; } catch (error: any) {
    return { removed: [], failed: [{ path: root, error: String(error?.code ?? error) }] };
  }
  return removeSelected(root, names, prefix);
}

/** Blocking sleep for exit handlers, where timers no longer run. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
