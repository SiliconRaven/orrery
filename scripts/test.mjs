#!/usr/bin/env node
// Runs the type check and the tests, keeping the full spec output in a log file and the screen small.
// Full runs queue on a machine-wide lock: one npm test at a time per machine (scripts/test-queue.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireTestQueue, formatWaitLine, queueTimeoutMs, shouldQueue } from './test-queue.ts';
import { concurrencyArgs, logName, parseSummary, pruneLogs, timeoutArgs } from './test-lib.ts';
import { keepTestTemp, sweep, TEST_TEMP_PREFIX } from './test-temp.ts';

const ROOT = resolve(import.meta.dirname, '..');
const LOG_DIR = join(ROOT, '.tmp', 'test-logs');

/** Safety net for runs that were killed, crashed or timed out: their tempDir() directories older than 2 hours go. */
function sweepOldTestTemp() {
  if (keepTestTemp()) return;
  const { removed, failed } = sweep(tmpdir());
  if (removed.length || failed.length) {
    console.log(`temp sweep: removed ${removed.length} ${TEST_TEMP_PREFIX}* directories older than 2h${failed.length ? `, ${failed.length} could not be removed` : ''}`);
  }
}

function run() {
  sweepOldTestTemp();
  const verbose = process.argv.includes('--verbose') || process.env.ORRERY_TEST_VERBOSE === '1';
  const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const tsc = spawnSync(process.execPath, [tscBin, '--noEmit'], { cwd: ROOT, stdio: 'inherit' });
  if (tsc.status !== 0) return tsc.status ?? 1;

  mkdirSync(LOG_DIR, { recursive: true });
  const log = join(LOG_DIR, logName());
  const args = ['--test', ...concurrencyArgs(), ...timeoutArgs(), '--test-reporter=spec', `--test-reporter-destination=${log}`];
  if (verbose) args.push('--test-reporter=spec', '--test-reporter-destination=stdout');
  else args.push('--test-reporter=dot', '--test-reporter-destination=stdout');
  args.push('test/*.test.ts');
  const tests = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  pruneLogs(LOG_DIR);
  if (!existsSync(log)) return tests.status ?? 1;
  const summary = parseSummary(readFileSync(log, 'utf8'));
  const show = (value) => (value === null ? '?' : String(value));
  console.log(`tests ${show(summary.tests)} · pass ${show(summary.pass)} · fail ${show(summary.fail)} · skipped ${show(summary.skipped)} · log ${log}`);
  return tests.status ?? 1;
}

async function main() {
  let release = () => {};
  if (shouldQueue(process.env)) {
    const timeoutMs = queueTimeoutMs(process.env);
    const queue = await acquireTestQueue({
      cwd: ROOT,
      timeoutMs,
      onWait: (holder) => console.log(formatWaitLine(holder, timeoutMs)),
    });
    release = queue.release;
    const stop = (code) => { release(); process.exit(code); };
    process.once('SIGINT', () => stop(130));
    process.once('SIGTERM', () => stop(143));
  }
  try {
    process.exitCode = run();
  } finally {
    release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    if (error?.code === 'ORRERY_TEST_QUEUE_TIMEOUT') console.error(error.message);
    else console.error(error);
    process.exit(1);
  });
}
