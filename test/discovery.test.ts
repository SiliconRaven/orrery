// hub.json is replaced by rename; on Windows that rename fails with EPERM while another process reads the file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DISCOVERY_RETRY_MS, writeDiscovery } from '../src/main.ts';
import { tempDir } from './helpers.ts';

const data = { url: 'http://127.0.0.1:1', secret: 's'.repeat(64), pid: process.pid };
const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const noWait = [0, 0, 0];

test('discovery: a busy rename is retried and then succeeds', async () => {
  const home = tempDir();
  let calls = 0;
  await writeDiscovery(home, data, (from, to) => {
    calls++;
    if (calls <= 2) throw busy(calls === 1 ? 'EPERM' : 'EBUSY');
    renameSync(from, to);
  }, noWait);
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'hub.json'), 'utf8')), data);
  assert.deepEqual(readdirSync(home), ['hub.json'], 'no temp file left');
});

test('discovery: retries are bounded; the rename error itself is thrown, naming the file, the code and the tries', async () => {
  const home = tempDir();
  let calls = 0;
  const thrown = busy('EPERM');
  await assert.rejects(writeDiscovery(home, data, () => { calls++; throw thrown; }, noWait),
    (e: Error) => e === thrown && e.message.includes(join(home, 'hub.json')) && e.message.includes('EPERM after 4 tries'));
  assert.equal(calls, noWait.length + 1);
  assert.deepEqual(readdirSync(home), [], 'no temp file and no hub.json');
});

test('discovery: other errors are not retried', async () => {
  const home = tempDir();
  let calls = 0;
  await assert.rejects(writeDiscovery(home, data, () => { calls++; throw busy('ENOENT'); }, noWait), /ENOENT after 1 tries/);
  assert.equal(calls, 1);
});

/**
 * Waits for this test only. The reader below reads every few milliseconds, far harder than a bridge (one read per
 * reconnect); in a tight loop it kept the file open through every try on a busy machine. The default
 * budget (DISCOVERY_RETRY_MS) is a product choice; "retries are bounded" above checks that a given budget caps the
 * tries, and the injected-EPERM test checks that a retry happens. This one checks that writing succeeds next to a
 * real concurrent reader, so it gives the retry room: about 10 s per write before it would give up.
 */
const STRESS_RETRY_MS = [...DISCOVERY_RETRY_MS, ...Array(17).fill(500)];

test('discovery: rewriting hub.json while another process keeps reading it never fails', async () => {
  const home = tempDir();
  await writeDiscovery(home, data);
  const file = join(home, 'hub.json');
  // A reader in its own process, like a bridge re-reading hub.json, pausing 5 ms between reads so a rename can get through.
  const reader = spawn(process.execPath, ['-e',
    `const { readFileSync } = require('node:fs'); const end = Date.now() + 60000; process.stdout.write('reading\\n');
     const pause = new Int32Array(new SharedArrayBuffer(4));
     while (Date.now() < end) { try { readFileSync(${JSON.stringify(file)}); } catch {} Atomics.wait(pause, 0, 0, 5); }`], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    // Start writing only once the reader is running, however slowly the machine starts it.
    await new Promise<void>((ok, fail) => { reader.stdout!.once('data', () => ok()); reader.once('exit', () => fail(new Error('reader exited'))); });
    for (let i = 0; i < 100; i++) await writeDiscovery(home, { ...data, pid: i }, renameSync, STRESS_RETRY_MS);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 99);
    assert.ok(!existsSync(join(home, `hub.json.${process.pid}.tmp`)));
  } finally {
    reader.kill();
  }
});
