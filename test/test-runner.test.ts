import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { concurrencyArgs, failureReport, logName, openTests, parseSummary, pruneLogs, timeoutArgs } from '../scripts/test-lib.ts';
import { report } from '../scripts/ci-test-report.ts';
import { tempDir } from './helpers.ts';

test('test runner helpers: log names, summary parsing and log rotation', () => {
  assert.equal(logName(new Date(2026, 10, 8, 8, 27, 19)), '20261108-082719.log');
  const summary = parseSummary('ℹ tests 12\nℹ suites 0\nℹ pass 11\nℹ fail 1\nℹ skipped 2\n');
  assert.deepEqual(summary, { tests: 12, pass: 11, fail: 1, skipped: 2 });
  assert.deepEqual(parseSummary('no summary'), { tests: null, pass: null, fail: null, skipped: null });
  const dir = tempDir();
  try {
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `20261108-08${String(i).padStart(2, '0')}00.log`), 'x');
    const kept = pruneLogs(dir, 20);
    assert.equal(kept.length, 20);
    assert.equal(readdirSync(dir).length, 20);
    assert.ok(!kept.includes('20261108-080000.log'), 'the oldest logs are removed');
    assert.ok(kept.includes('20261108-082400.log'), 'the newest logs stay');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('test runner: ORRERY_TEST_CONCURRENCY sets node --test-concurrency; unset keeps the default', () => {
  assert.deepEqual(concurrencyArgs({}), []);
  assert.deepEqual(concurrencyArgs({ ORRERY_TEST_CONCURRENCY: '' }), []);
  assert.deepEqual(concurrencyArgs({ ORRERY_TEST_CONCURRENCY: '8' }), ['--test-concurrency=8']);
  for (const bad of ['0', '-1', '1.5', 'many', '8 --inspect', '1000']) assert.throws(() => concurrencyArgs({ ORRERY_TEST_CONCURRENCY: bad }), /ORRERY_TEST_CONCURRENCY/, bad);
});

test('test runner: failure report from a spec log, finished or killed', () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'test-logs', name), 'utf8');
  const finished = failureReport(fixture('finished.txt'));
  assert.equal(finished[0], '✖ failing tests:');
  assert.ok(finished.includes('✖ fails plainly (0.8362ms)') && finished.includes('  1 !== 2') && finished.includes('  Error: boom'));
  assert.ok(!finished.some((line) => line.includes('✔')), 'passing tests stay out');
  const killed = failureReport(fixture('killed.txt'));
  assert.deepEqual(killed.slice(1), ['✖ fails plainly (0.8362ms)', '  ✖ inner fails (0.165ms)', '✖ outer (0.4506ms)',
    'still running when the log ends: a suite that was still running (its next subtest, or a test in a later file)']);
  assert.deepEqual(failureReport('✔ a (1ms)\n✔ b (2ms)\n'), []);
});

test('test runner: the parent tests a killed log left open', () => {
  const hosted = [
    '✔ an offline coordinator is not sent an old message after coming online (66.1ms)',
    '▶ the existing hop, chain-turn and hourly guards apply to coordinator deliveries',
    '  ✔ hop limit (83.2ms)',
  ];
  assert.deepEqual(openTests(hosted), ['the existing hop, chain-turn and hourly guards apply to coordinator deliveries']);
  assert.match(failureReport(hosted.join('\n')).at(-1)!, /^still running when the log ends: the existing hop, chain-turn/);
  assert.deepEqual(openTests(['▶ a', '  ▶ b', '    ✔ c (1ms)', '  ✔ b (2ms)', '✖ a (3ms)', '▶ d', '  ▶ e']), ['d', 'e']);
  assert.deepEqual(openTests(['▶ a', '  ﹣ skipped (0.1ms) # SKIP', '✔ a (1ms)']), []);
});

test('test runner: ORRERY_TEST_TIMEOUT_MS sets a per-test timeout; unset keeps the default', () => {
  assert.deepEqual(timeoutArgs({}), []);
  assert.deepEqual(timeoutArgs({ ORRERY_TEST_TIMEOUT_MS: '120000' }), ['--test-timeout=120000']);
  for (const bad of ['999', '3600001', '2m', '-5', '1e5']) assert.throws(() => timeoutArgs({ ORRERY_TEST_TIMEOUT_MS: bad }), /ORRERY_TEST_TIMEOUT_MS/, bad);
});

test('test runner: the CI report covers every log oldest first, then the end of the newest', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(report(join(dir, 'none')), ['no test log was written']);
    const fixtures = join(import.meta.dirname, 'fixtures', 'test-logs');
    writeFileSync(join(dir, '20261115-100000.log'), readFileSync(join(fixtures, 'killed.txt')));
    writeFileSync(join(dir, '20261115-110000.log'), readFileSync(join(fixtures, 'finished.txt')));
    writeFileSync(join(dir, 'notes.txt'), 'not a log');
    const out = report(dir, 3);
    const first = out.indexOf('== 20261115-100000.log: failures');
    const second = out.indexOf('== 20261115-110000.log: failures');
    assert.ok(first >= 0 && second > first, out.join('\n'));
    assert.ok(out.slice(first, second).includes('✖ outer (0.4506ms)'));
    assert.ok(out.slice(second).includes('  Error: boom'));
    assert.equal(report(dir, 0).at(-1), '== last 0 lines of 20261115-110000.log');
    assert.deepEqual(out.slice(-4), ['== last 3 lines of 20261115-110000.log', '      at TestContext.<anonymous> (file:///example/a.test.mjs:5:72)', '      at Test.runInAsyncScope (node:async_hooks:227:14)', '']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
