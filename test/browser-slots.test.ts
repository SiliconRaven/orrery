// The test browser's profile slot pool (test/browser-slots.ts), without starting a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { sweep, TEST_TEMP_PREFIX } from '../scripts/test-temp.ts';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireSlot, cleanSlot, poolRoot, POOL_SIZE, SLOTS_ENV } from './browser-slots.ts';
import { junction } from './extensions-fixture.ts';
import { tempDir } from './helpers.ts';

const names = (dirs: string[]) => dirs.map((d) => d.split(/[\\/]/).pop()).sort();

test('slot pool: a small fixed size, an overridable root that the temp sweep does not match', () => {
  assert.ok(POOL_SIZE >= 1 && POOL_SIZE <= 4);
  assert.equal(poolRoot({ [SLOTS_ENV]: 'X:\\ci-slots' }), 'X:\\ci-slots');
  assert.match(poolRoot({}), /orrery-browser-slots$/);
  assert.doesNotMatch(poolRoot({}), /orrery-test-/);
});

test('the test temp sweep (npm test start, clean:temp) leaves an old slot pool and its Local State alone', () => {
  const tmp = tempDir();
  const pool = join(tmp, basename(poolRoot({})));
  const old = join(tmp, 'orrery-test-old');
  mkdirSync(join(pool, 'slot-0'), { recursive: true });
  writeFileSync(join(pool, 'slot-0', 'Local State'), '{}');
  mkdirSync(old);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const dir of [pool, old]) utimesSync(dir, past, past);
  assert.deepEqual(sweep(tmp, { now: Date.now(), env: {} }).removed, [old], 'the sweep ran and took only the orrery-test-* directory');
  assert.ok(existsSync(join(pool, 'slot-0', 'Local State')));
  assert.ok(!poolRoot({}).startsWith(tmpdir() + sep + TEST_TEMP_PREFIX), 'not inside a tempDir() directory');
});

test('slot pool: slots are handed out one per holder and reused after release', async () => {
  const root = tempDir();
  const a = await acquireSlot({ root, size: 3 });
  const b = await acquireSlot({ root, size: 3 });
  assert.deepEqual(names([a.dir, b.dir]), ['slot-0', 'slot-1']);
  a.release();
  a.release();   // idempotent
  const c = await acquireSlot({ root, size: 3 });
  assert.equal(c.dir, a.dir, 'the freed slot is reused before a new one is made');
  b.release(); c.release();
});

test('slot pool: concurrent callers get distinct slots; when all are busy the wait is bounded and makes no new slot', async () => {
  const root = tempDir();
  const slots = await Promise.all(Array.from({ length: 4 }, () => acquireSlot({ root, size: 4 })));
  assert.deepEqual(names(slots.map((s) => s.dir)), ['slot-0', 'slot-1', 'slot-2', 'slot-3']);
  const begin = Date.now();
  await assert.rejects(acquireSlot({ root, size: 4, timeoutMs: 300, pollMs: 50 }), /all 4 test browser profile slots .* stayed busy/);
  assert.ok(Date.now() - begin < 5_000);
  assert.equal(readdirSync(root).filter((n) => !n.endsWith('.lock')).length, 4, 'no fifth slot');
  // A waiter gets the slot as soon as one is freed.
  const waiting = acquireSlot({ root, size: 4, timeoutMs: 10_000, pollMs: 50 });
  await sleep(200);
  slots[2].release();
  assert.equal((await waiting).dir, slots[2].dir);
  for (const s of slots) s.release();
});

test('slot pool: a lock left by a process that is gone is taken over', async () => {
  const root = tempDir();
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  writeFileSync(join(root, 'slot-0.lock'), JSON.stringify({ pid: dead, cwd: root, startedAt: Date.now() - 60_000, token: 'old' }));
  const slot = await acquireSlot({ root, size: 1, timeoutMs: 2_000 });
  assert.match(slot.dir, /slot-0$/);
  assert.notEqual(JSON.parse(readFileSync(join(root, 'slot-0.lock'), 'utf8')).token, 'old');
  slot.release();
  assert.equal(existsSync(join(root, 'slot-0.lock')), false);
});

test('slot pool: the lock works between unrelated processes; a killed holder\'s slot is taken over', async () => {
  const root = tempDir();
  // A stand-in test process: takes the only slot through the env override, says so, never releases it.
  const code = `const { acquireSlot } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'browser-slots.ts')).href)});
    const s = await acquireSlot({ size: 1 }); console.log('held ' + s.dir); setInterval(() => {}, 1000);`;
  const other = spawn(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...process.env, [SLOTS_ENV]: root }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  try {
    await new Promise<void>((ok, fail) => {
      other.stdout.on('data', (c) => { if (String(c).includes('held')) ok(); });
      other.once('exit', () => fail(new Error('the stand-in exited early')));
    });
    await assert.rejects(acquireSlot({ root, size: 1, timeoutMs: 300, pollMs: 50 }), /stayed busy/);
  } finally {
    other.kill();   // like a test process killed by a timeout or Ctrl+C: no release
    if (other.exitCode === null && other.signalCode === null) await new Promise((ok) => other.once('exit', ok));
  }
  assert.ok(existsSync(join(root, 'slot-0.lock')), 'the dead holder left its lock behind');
  const slot = await acquireSlot({ root, size: 1, timeoutMs: 2_000 });
  assert.match(slot.dir, /slot-0$/);
  slot.release();
});

test('slot pool: on Linux and macOS a slot whose SingletonLock names a live process is skipped', { skip: process.platform === 'win32' && 'POSIX lock only' }, async () => {
  const root = tempDir();
  mkdirSync(join(root, 'slot-0', 'Default'), { recursive: true });
  symlinkSync(`${hostname()}-${process.pid}`, join(root, 'slot-0', 'SingletonLock'));
  await assert.rejects(acquireSlot({ root, size: 1, timeoutMs: 300, pollMs: 50 }), /still runs/);
  assert.ok(existsSync(join(root, 'slot-0', 'Default')));
});

test('slot cleaning keeps Local State and removes page-level state and dead browser lock files', async () => {
  const root = tempDir();
  const dir = join(root, 'slot-0');
  mkdirSync(join(dir, 'Default', 'Local Storage'), { recursive: true });
  writeFileSync(join(dir, 'Local State'), '{"password_manager":{"os_password_blank":false}}');
  writeFileSync(join(dir, 'Default', 'Cookies'), 'c');
  writeFileSync(join(dir, 'Default', 'Local Storage', 'x'), 'x');
  writeFileSync(join(dir, 'First Run'), '');
  writeFileSync(join(dir, 'lockfile'), '');
  const slot = await acquireSlot({ root, size: 1 });
  assert.deepEqual(readdirSync(slot.dir), ['Local State']);
  assert.equal(readFileSync(join(slot.dir, 'Local State'), 'utf8'), '{"password_manager":{"os_password_blank":false}}');
  slot.release();
});

test('slot cleaning refuses names and slots outside the pool root, and never follows a link inside a slot', (t) => {
  const root = tempDir();
  const outside = tempDir();
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  for (const bad of ['..', 'slot-0/..', 'other', 'slot-']) assert.throws(() => cleanSlot(root, bad), /not a slot name/);
  if (!junction(outside, join(root, 'slot-1'))) return t.skip('the OS refused to create a junction');
  assert.throws(() => cleanSlot(root, 'slot-1'), /refusing to clean/);
  assert.ok(existsSync(join(outside, 'keep.txt')), 'a slot that is a link is not cleaned through');
  mkdirSync(join(root, 'slot-0', 'Default'), { recursive: true });
  junction(outside, join(root, 'slot-0', 'Default', 'escape'));
  junction(outside, join(root, 'slot-0', 'top-link'));
  cleanSlot(root, 'slot-0');
  assert.deepEqual(readdirSync(join(root, 'slot-0')), []);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep', 'the link target is untouched');
  rmdirSync(join(root, 'slot-1'));   // the link itself, before the temp cleanup
});

test('slot pool: an orphaned browser (owner process gone, browser still holding its lock file) keeps its slot: skipped, not cleaned, not killed', { skip: process.platform !== 'win32' && 'Windows lock file only' }, async () => {
  const root = tempDir();
  const dir = join(root, 'slot-0');
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Default', 'Cookies'), 'c');
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  writeFileSync(join(root, 'slot-0.lock'), JSON.stringify({ pid: dead, cwd: root, startedAt: Date.now() - 60_000, token: 'old' }));
  // Like the running browser: a process holds the file open without delete sharing (Node itself always shares delete).
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [IO.File]::Open($env:LOCK_PATH, 'OpenOrCreate', 'ReadWrite', 'Read'); [Console]::Out.WriteLine('ready'); Start-Sleep 60"],
  { env: { ...process.env, LOCK_PATH: join(dir, 'lockfile') }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    await new Promise<void>((ok, fail) => {
      holder.stdout.on('data', (c) => { if (String(c).includes('ready')) ok(); });
      holder.once('exit', () => fail(new Error('the lock holder exited early')));
    });
    await assert.rejects(acquireSlot({ root, size: 1, timeoutMs: 300, pollMs: 50 }), /still holds/);
    assert.ok(existsSync(join(dir, 'Default', 'Cookies')), 'nothing deleted under a running browser');
    assert.equal(existsSync(join(root, 'slot-0.lock')), false, 'the slot lock is not left behind');
    assert.equal(holder.exitCode, null, 'the browser stand-in was not killed');
  } finally {
    holder.kill();
    if (holder.exitCode === null) await new Promise((ok) => holder.once('exit', ok));
  }
  const slot = await acquireSlot({ root, size: 1 });
  assert.deepEqual(readdirSync(slot.dir), []);
  slot.release();
});
