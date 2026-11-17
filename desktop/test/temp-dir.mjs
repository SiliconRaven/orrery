// Temp directories for the desktop checks. checkTempDir(prefix) makes one with mkdtemp and starts a hidden, detached
// helper (temp-reaper.mjs) that deletes it once this process has exited: Electron keeps its profile files open until
// then, and the helper also covers a failed or crashed check. ORRERY_KEEP_TEST_TEMP=1 keeps the directory.
// Plain JavaScript (Electron runs these checks), so the guard below repeats scripts/test-temp.ts's rule.
import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const KEEP_ENV = 'ORRERY_KEEP_TEST_TEMP';
const keep = (env) => env[KEEP_ENV] !== undefined && env[KEEP_ENV] !== '' && env[KEEP_ENV] !== '0';
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Deletes `dir` only if it is a real directory (not a link or other reparse point) directly under the real temp
 * folder and named `prefix` plus something. Returns 'removed', 'missing' or 'refused'; throws when the delete fails.
 */
export function removeCheckTempDir(dir, prefix, root = tmpdir()) {
  const name = basename(dir);
  if (!prefix.startsWith('orrery-') || !name.startsWith(prefix) || name.length === prefix.length) return 'refused';
  const realRoot = realpathSync.native(root);
  if (!same(realpathSync.native(dirname(dir)), realRoot)) return 'refused';
  const target = join(realRoot, name);
  let stat;
  try { stat = lstatSync(target); } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !same(realpathSync.native(target), target)) return 'refused';
  rmSync(target, { recursive: true, force: true });
  return 'removed';
}

/** Starts the helper that deletes `dir` after process `pid` has exited. */
export function removeAfterExit(dir, prefix, pid = process.pid) {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'temp-reaper.mjs'), String(pid), dir, prefix], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return child;
}

/** A fresh temp directory for this check, deleted after the check's process exits (unless ORRERY_KEEP_TEST_TEMP=1). */
export function checkTempDir(prefix, env = process.env) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (!keep(env)) removeAfterExit(dir, prefix);
  return dir;
}
