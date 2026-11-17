import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireTestQueue, formatDuration, formatWaitLine, isProcessAlive, queueTimeoutMs, shouldQueue,
  type TestQueueHolder, type TestQueueWaitInfo,
} from '../scripts/test-queue.ts';
import { tempDir } from './helpers.ts';

function holder(overrides: Partial<TestQueueHolder> = {}): TestQueueHolder {
  return { pid: process.pid, cwd: 'C:\\work\\held', startedAt: Date.now(), token: 'held', ...overrides };
}

test('test queue: acquires a free lock and releases it', async () => {
  const dir = tempDir();
  const lockPath = join(dir, 'run.lock');
  try {
    const queue = await acquireTestQueue({ lockPath, cwd: 'C:\\work\\mine', timeoutMs: 1000, pollMs: 10 });
    assert.equal(queue.lockPath, lockPath);
    const saved = JSON.parse(readFileSync(lockPath, 'utf8')) as TestQueueHolder;
    assert.equal(saved.pid, process.pid);
    assert.equal(saved.cwd, 'C:\\work\\mine');
    assert.ok(Number.isFinite(saved.startedAt));
    assert.equal(typeof saved.token, 'string');
    queue.release();
    assert.equal(existsSync(lockPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('test queue: waits while a live holder runs, then starts after the lock is released', async () => {
  const dir = tempDir();
  const lockPath = join(dir, 'run.lock');
  writeFileSync(lockPath, JSON.stringify(holder({ startedAt: Date.now() - 65_000 })));
  const seen: TestQueueWaitInfo[] = [];
  const releaseTimer = setTimeout(() => rmSync(lockPath, { force: true }), 120);
  const started = Date.now();
  try {
    const queue = await acquireTestQueue({
      lockPath, cwd: 'C:\\work\\waiting', timeoutMs: 5000, pollMs: 20,
      onWait: (info) => seen.push(info),
    });
    assert.ok(Date.now() - started >= 80, 'it waited instead of running in parallel');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pid, process.pid);
    assert.equal(seen[0].cwd, 'C:\\work\\held');
    assert.ok(seen[0].elapsedMs >= 60_000);
    assert.equal(queue.holder.cwd, 'C:\\work\\waiting');
    queue.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    clearTimeout(releaseTimer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test queue: takes over a lock whose holding process is gone', async () => {
  const dir = tempDir();
  const lockPath = join(dir, 'run.lock');
  const dead = spawnSync(process.execPath, ['-e', '']);
  assert.ok(dead.pid && dead.pid > 0);
  writeFileSync(lockPath, JSON.stringify(holder({ pid: dead.pid, cwd: 'C:\\work\\dead', startedAt: Date.now() - 120_000 })));
  const started = Date.now();
  try {
    const queue = await acquireTestQueue({
      lockPath, cwd: 'C:\\work\\next', timeoutMs: 2000, pollMs: 20,
      onWait: () => assert.fail('a dead holder must not be reported as running'),
    });
    assert.ok(Date.now() - started < 1500);
    assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as TestQueueHolder).pid, process.pid);
    queue.release();
    assert.equal(existsSync(lockPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('test queue: takes over an old broken lock but never a fresh one', async () => {
  const dir = tempDir();
  const lockPath = join(dir, 'run.lock');
  writeFileSync(lockPath, '');
  try {
    await assert.rejects(
      acquireTestQueue({ lockPath, cwd: 'C:\\work\\waiting', timeoutMs: 120, pollMs: 20 }),
      { code: 'ORRERY_TEST_QUEUE_TIMEOUT' },
    );
    assert.equal(existsSync(lockPath), true, 'a half-written lock is given a grace period');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const queue = await acquireTestQueue({ lockPath, cwd: 'C:\\work\\next', timeoutMs: 1000, pollMs: 20 });
    assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as TestQueueHolder).pid, process.pid);
    queue.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('test queue: waiting times out with the holder details and leaves the live lock alone', async () => {
  const dir = tempDir();
  const lockPath = join(dir, 'run.lock');
  const busy = holder({ cwd: 'C:\\work\\busy', startedAt: Date.now() - 95_000, token: 'busy' });
  writeFileSync(lockPath, JSON.stringify(busy));
  const seen: TestQueueWaitInfo[] = [];
  try {
    await assert.rejects(
      acquireTestQueue({
        lockPath, cwd: 'C:\\work\\waiting', timeoutMs: 120, pollMs: 20,
        onWait: (info) => seen.push(info),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as NodeJS.ErrnoException).code, 'ORRERY_TEST_QUEUE_TIMEOUT');
        assert.match(error.message, /pid \d+ in C:\\work\\busy/);
        assert.match(error.message, /No second test run was started/);
        return true;
      },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cwd, 'C:\\work\\busy');
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), busy, 'the live holder keeps its lock');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('test queue: release does not remove a lock another run now owns', async () => {
  const dir = tempDir();
  const lockPath = join(dir, 'run.lock');
  try {
    const queue = await acquireTestQueue({ lockPath, cwd: 'C:\\work\\mine', timeoutMs: 1000, pollMs: 10 });
    const other = holder({ pid: process.pid + 1, cwd: 'C:\\work\\other', token: 'other' });
    writeFileSync(lockPath, JSON.stringify(other));
    queue.release();
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), other);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('test queue: env switches, duration formatting and the wait line', () => {
  assert.equal(shouldQueue({}), true);
  assert.equal(shouldQueue({ ORRERY_TEST_NO_QUEUE: '0' }), true);
  assert.equal(shouldQueue({ ORRERY_TEST_NO_QUEUE: '1' }), false);
  assert.equal(queueTimeoutMs({}), 15 * 60 * 1000);
  assert.equal(queueTimeoutMs({ ORRERY_TEST_QUEUE_TIMEOUT_MS: '2500' }), 2500);
  assert.equal(queueTimeoutMs({ ORRERY_TEST_QUEUE_TIMEOUT_MS: 'nope' }), 15 * 60 * 1000);
  assert.equal(formatDuration(5_000), '5s');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(formatDuration(3_780_000), '1h 03m');
  const line = formatWaitLine({ ...holder(), elapsedMs: 65_000 }, 900_000);
  assert.match(line, /pid \d+/);
  assert.match(line, /C:\\work\\held/);
  assert.match(line, /1m 05s/);
  assert.match(line, /one full npm test at a time/);
  assert.equal(line.includes('\n'), false, 'the queue notice is one screen line');
});

test('test queue: only ESRCH proves that the holder is gone', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1234, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), false);
  assert.equal(isProcessAlive(1234, () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); }), true);
  assert.equal(isProcessAlive(1234, () => { throw new Error('cannot check'); }), true);
});
