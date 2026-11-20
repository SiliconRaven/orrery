// Machine-wide queue for full `npm test` runs: the lock lives in the system temp directory, so every
// worktree on this machine shares it. Running a few files directly (`node --test test/foo.test.ts`)
// does not go through scripts/test.mjs and is not queued.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const LOCK_NAME = 'orrery-npm-test.lock';
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_MS = 1000;
export const NO_QUEUE_ENV = 'ORRERY_TEST_NO_QUEUE';
export const TIMEOUT_ENV = 'ORRERY_TEST_QUEUE_TIMEOUT_MS';
/** An empty or half-written lock file is not proof the writer died: wait this long before taking it over. */
const BROKEN_LOCK_GRACE_MS = 5000;
/** A takeover marker left by a process that died while clearing a stale lock is ignored after this long. */
const BREAKER_GRACE_MS = 5000;

export interface TestQueueHolder {
  pid: number;
  cwd: string;
  startedAt: number;
  token: string;
}

export interface TestQueueWaitInfo extends TestQueueHolder {
  elapsedMs: number;
}

export interface AcquireTestQueueOptions {
  lockPath?: string;
  timeoutMs?: number;
  pollMs?: number;
  cwd?: string;
  now?: () => number;
  onWait?: (holder: TestQueueWaitInfo) => void;
}

export interface AcquiredTestQueue {
  lockPath: string;
  holder: TestQueueHolder;
  release: () => void;
}

export class TestQueueTimeoutError extends Error {
  readonly code = 'ORRERY_TEST_QUEUE_TIMEOUT';
}

type Env = Record<string, string | undefined>;
type LockState = { state: 'missing' } | { state: 'held' | 'stale'; holder: TestQueueHolder | null };

/** The one lock file shared by every worktree on this machine. */
export function defaultLockPath(): string {
  return join(tmpdir(), LOCK_NAME);
}

/** Full runs queue unless ORRERY_TEST_NO_QUEUE=1 asks to skip it. */
export function shouldQueue(env: Env = process.env): boolean {
  return env[NO_QUEUE_ENV] !== '1';
}

/** Wait limit in milliseconds; a missing or invalid value means the default. */
export function queueTimeoutMs(env: Env = process.env): number {
  const raw = env[TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** Short human duration: 5s, 1m 05s, 1h 03m. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Whether process.kill(pid, 0) proves the process exists. Only ESRCH ("no such process") proves it is
 * gone; EPERM and unknown errors mean it exists or cannot be checked, so the lock must not be taken over.
 */
export function isProcessAlive(pid: number, kill: (pid: number, signal: number) => unknown = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/** One screen line saying who holds the queue and for how long. */
export function formatWaitLine(holder: TestQueueWaitInfo, timeoutMs: number): string {
  const elapsed = formatDuration(holder.elapsedMs);
  return `[test queue] pid ${holder.pid} (${holder.cwd || 'unknown worktree'}) has been running for ${elapsed}; `
    + `this machine runs one full npm test at a time (premerge runs npm test too), waiting up to ${formatDuration(timeoutMs)}`;
}

function readHolder(lockPath: string): TestQueueHolder | null {
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<TestQueueHolder>;
    if (!Number.isInteger(data?.pid) || (data.pid as number) <= 0 || !Number.isFinite(data.startedAt)
      || typeof data.token !== 'string' || typeof data.cwd !== 'string') return null;
    return data as TestQueueHolder;
  } catch {
    return null;
  }
}

function describeLock(lockPath: string, nowMs: number): LockState {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { state: 'missing' };
    // On Windows, unlinking a lock file while another process reads it briefly leaves STATUS_DELETE_PENDING (EPERM).
    if (process.platform === 'win32' && code === 'EPERM') return { state: 'held', holder: null };
    throw error;
  }
  const holder = readHolder(lockPath);
  if (holder) return { state: isProcessAlive(holder.pid) ? 'held' : 'stale', holder };
  // The creator opens the file with 'wx' and then writes it: a just-created empty file is not stale yet.
  return { state: nowMs - mtimeMs > BROKEN_LOCK_GRACE_MS ? 'stale' : 'held', holder: null };
}

function tryCreateLock(lockPath: string, holder: TestQueueHolder): TestQueueHolder | null {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST' || (process.platform === 'win32' && code === 'EPERM')) return null;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(holder));
    closeSync(fd);
    return holder;
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* someone else owns it now */ }
    throw error;
  }
}

/**
 * Clear a lock whose holder is gone. The .breaking marker makes sure only one waiter does this:
 * without it two waiters could remove each other's fresh lock and both start a full run.
 */
function takeStaleLock(lockPath: string, now: () => number): 'done' | 'busy' {
  const breaker = `${lockPath}.breaking`;
  let fd: number;
  try {
    fd = openSync(breaker, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST' && !(process.platform === 'win32' && code === 'EPERM')) throw error;
    try {
      if (now() - statSync(breaker).mtimeMs > BREAKER_GRACE_MS) unlinkSync(breaker);
    } catch { /* another waiter already cleaned it */ }
    return 'busy';
  }
  try {
    if (describeLock(lockPath, now()).state === 'stale') {
      try { unlinkSync(lockPath); } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT' && !(process.platform === 'win32' && code === 'EPERM')) throw error;
      }
    }
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(breaker); } catch { /* already gone */ }
  }
  return 'done';
}

/** Remove the lock only if it is still ours: a lock taken over by another run must survive. */
export function releaseLock(lockPath: string, holder: TestQueueHolder): void {
  const current = readHolder(lockPath);
  if (current?.pid !== holder.pid || current.token !== holder.token) return;
  try { unlinkSync(lockPath); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

function timeoutError(lockPath: string, timeoutMs: number, holder: TestQueueHolder | null, nowMs: number): TestQueueTimeoutError {
  const running = holder
    ? `pid ${holder.pid} in ${holder.cwd || 'an unknown worktree'} has been running for ${formatDuration(nowMs - holder.startedAt)}`
    : `the lock ${lockPath} is held by another process`;
  return new TestQueueTimeoutError(
    `timed out after ${formatDuration(timeoutMs)} waiting for the full test queue: ${running}. `
    + 'No second test run was started. Wait for it to finish, or raise ORRERY_TEST_QUEUE_TIMEOUT_MS.',
  );
}

/**
 * Wait until this machine has no other full npm test running, then hold the queue until release().
 * Throws TestQueueTimeoutError instead of starting a parallel run when the wait limit passes.
 */
export async function acquireTestQueue(options: AcquireTestQueueOptions = {}): Promise<AcquiredTestQueue> {
  const lockPath = options.lockPath ?? defaultLockPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const announced = new Set<string>();
  let lastHolder: TestQueueHolder | null = null;

  for (;;) {
    const holder: TestQueueHolder = { pid: process.pid, cwd, startedAt: now(), token: randomUUID() };
    if (tryCreateLock(lockPath, holder)) {
      return { lockPath, holder, release: () => releaseLock(lockPath, holder) };
    }

    const nowMs = now();
    const current = describeLock(lockPath, nowMs);
    if (current.state === 'stale') {
      if (takeStaleLock(lockPath, now) === 'done') continue;
    } else if (current.state === 'missing') {
      continue;
    } else if (current.holder) {
      lastHolder = current.holder;
      const key = `${current.holder.pid}:${current.holder.startedAt}`;
      if (!announced.has(key) && options.onWait) {
        announced.add(key);
        options.onWait({ ...current.holder, elapsedMs: Math.max(0, nowMs - current.holder.startedAt) });
      }
    }

    if (nowMs >= deadline) throw timeoutError(lockPath, timeoutMs, lastHolder, nowMs);
    await sleep(Math.max(1, Math.min(pollMs, deadline - nowMs)));
  }
}
