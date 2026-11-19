// A small fixed pool of reusable profile directories ("slots") for the test browser in test/browser.ts.
// Why not a fresh profile per launch: some time after start-up, Chromium on Windows checks whether the OS account has
// a blank password by attempting a logon with an empty password, and caches the answer in the profile's `Local State`.
// A fresh profile has no cache, so every launch that lives long enough records one failed OS logon, and a test run
// that starts many browsers can trip the OS account lockout policy. A reused slot keeps `Local State`, so each slot
// checks once (and again after the OS password changes).
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireTestQueue, isProcessAlive, TestQueueTimeoutError } from '../scripts/test-queue.ts';

/**
 * Number of slots. Each slot can cost one failed OS logon on its first use (and after a password change), all of them
 * possibly within a minute: this must stay far below common lockout thresholds (often 5 to 10 failures).
 */
export const POOL_SIZE = 4;
/** Overrides the pool directory (for CI, or for the pool's own tests). */
export const SLOTS_ENV = 'ORRERY_TEST_BROWSER_SLOTS';
/** Browser-level state kept between uses: the blank-password answer lives here. Everything else in a slot is deleted. */
const KEPT = ['Local State'];

/** Outside Git and outside any real browser profile; not named orrery-test-*, so the temp sweep leaves it alone. */
export function poolRoot(env: Record<string, string | undefined> = process.env): string {
  return env[SLOTS_ENV] || join(tmpdir(), 'orrery-browser-slots');
}

class SlotInUseError extends Error {}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/** Removes a link (symlink or junction) itself, never what it points to. */
function removeLink(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if (code(error) !== 'EPERM' && code(error) !== 'EISDIR') throw error;
    rmdirSync(path);   // a directory link on Windows: rmdir removes the link, not the target
  }
}

/** Deletes `path` without following links: links are removed as links, only real directories are walked. */
function removeTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return removeLink(path);   // Node reports Windows junctions as links too
  if (!stat.isDirectory()) return unlinkSync(path);
  // A reparse point Node does not report as a link resolves somewhere else: remove it as a link.
  if (!samePath(realpathSync.native(path), path)) return removeLink(path);
  for (const name of readdirSync(path)) removeTree(join(path, name));
  rmdirSync(path);
}

/**
 * Throws SlotInUseError while a browser still runs on the slot (for example one orphaned by a killed test process);
 * removes the lock files a dead one left behind. It never kills anything: the slot is skipped until that browser ends.
 */
function clearBrowserLocks(dir: string): void {
  // Windows: the running browser holds `lockfile` open without delete sharing, so deleting it fails while it runs.
  try { unlinkSync(join(dir, 'lockfile')); } catch (error) {
    if (code(error) !== 'ENOENT') {
      throw new SlotInUseError(`a browser still holds ${join(dir, 'lockfile')} (${code(error)}); if no test is running, end the browser `
        + `process whose command line has --user-data-dir=${dir}`);
    }
  }
  // Linux and macOS: SingletonLock is a symlink to "<host>-<pid>".
  let owner: string | null = null;
  try { owner = readlinkSync(join(dir, 'SingletonLock')); } catch { /* none, or not a link */ }
  const m = owner ? /^(.*)-(\d+)$/.exec(owner) : null;
  if (m && m[1] === hostname() && isProcessAlive(Number(m[2]))) throw new SlotInUseError(`browser pid ${m[2]} still runs on ${dir}`);
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { removeTree(join(dir, name)); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
  }
}

/**
 * Makes root/name ready for a new browser: deletes everything in it except KEPT. Refuses (throws) unless the slot is a
 * real directory directly under the real pool root with a slot-<n> name; creates it when missing.
 */
export function cleanSlot(root: string, name: string): string {
  if (!/^slot-\d+$/.test(name)) throw new Error(`refusing to clean ${name}: not a slot name`);
  const realRoot = realpathSync.native(root);
  const dir = join(realRoot, name);
  let stat;
  try { stat = lstatSync(dir); } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
    mkdirSync(dir);
    return dir;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing to clean ${dir}: not a real directory`);
  const real = realpathSync.native(dir);
  if (!samePath(real, dir) || !samePath(dirname(real), realRoot)) throw new Error(`refusing to clean ${dir}: it resolves outside ${realRoot}`);
  clearBrowserLocks(dir);
  for (const entry of readdirSync(dir)) {
    if (!KEPT.includes(entry)) removeTree(join(dir, entry));
  }
  return dir;
}

/** cleanSlot, retrying for a few seconds while a just-exited browser's helper processes still hold files. */
async function cleanWithRetry(root: string, name: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try { return cleanSlot(root, name); } catch (error) {
      const busy = code(error) === 'EBUSY' || code(error) === 'EPERM' || code(error) === 'ENOTEMPTY';
      if (!busy || attempt >= 30) throw error;
      await sleep(100);
    }
  }
}

interface Slot {
  /** The profile directory to pass as --user-data-dir. */
  dir: string;
  /** Frees the slot. Call only after the browser has exited. Idempotent. */
  release(): void;
}

interface AcquireOptions { root?: string; size?: number; timeoutMs?: number; pollMs?: number }

/**
 * Takes a free slot: an exclusive lock file per slot (root/slot-<n>.lock, created with 'wx', holding pid and start
 * time; a lock whose process is gone is taken over), then cleans the slot. When every slot is busy it waits up to
 * `timeoutMs` and then throws; it never creates slots beyond `size`.
 */
export async function acquireSlot({ root = poolRoot(), size = POOL_SIZE, timeoutMs = 120_000, pollMs = 250 }: AcquireOptions = {}): Promise<Slot> {
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let problem = '';
  for (;;) {
    for (let n = 0; n < size; n++) {
      const name = `slot-${n}`;
      let lock;
      try {
        lock = await acquireTestQueue({ lockPath: join(root, `${name}.lock`), timeoutMs: 0 });
      } catch (error) {
        if (error instanceof TestQueueTimeoutError) continue;   // held by a live process
        throw error;
      }
      try {
        return { dir: await cleanWithRetry(root, name), release: lock.release };
      } catch (error) {
        lock.release();
        problem = ` (last problem: ${name}: ${(error as Error).message})`;
      }
    }
    if (Date.now() >= deadline) throw new Error(`all ${size} test browser profile slots in ${root} stayed busy for ${timeoutMs} ms${problem}`);
    await sleep(pollMs);
  }
}
