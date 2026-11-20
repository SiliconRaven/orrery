import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChecks, runChecks, sameProcesses, timeoutScale, treeOf, type Check, type Outcome } from '../scripts/ci-checks.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const envOf = (name: string) => workflow.match(new RegExp(`^\\s+${name}: '([^']*)'$`, 'm'))?.[1];

test('ci workflow: runs the declared checks through the runner, never a copy of the commands', () => {
  assert.match(workflow, /^\s+run: node scripts\/ci-checks\.ts$/m);
  assert.doesNotMatch(workflow, /npm (ci|test)/, 'the commands live only in .premerge/checks.json');
  assert.ok(parseChecks(readFileSync(join(REPO_ROOT, '.premerge', 'checks.json'), 'utf8')).length > 0);
  assert.match(workflow, /if: failure\(\)\n\s+run: node scripts\/ci-test-report\.ts\n/, 'failures are printed by the report script');
});

test('ci workflow: the checks keep their temp files in the runner temp folder, on the fast drive', () => {
  const preflight = workflow.indexOf('- name: Check Windows registry permissions');
  const checks = workflow.indexOf('- name: Run the checks');
  assert.ok(preflight >= 0 && preflight < checks, 'the registry preflight runs before the full suite');
  const registryStep = workflow.slice(preflight, checks);
  assert.match(registryStep, /run: node --test test\/hub-registry-acl\.test\.ts/);
  const suiteStep = workflow.slice(checks, workflow.indexOf('run: node scripts/ci-checks.ts'));
  for (const step of [registryStep, suiteStep]) {
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) assert.match(step, new RegExp(`\\n\\s+${name}: \\$\\{\\{ runner\\.temp \\}\\}\\n`), name);
  }
});

test('ci workflow: read-only, every action pinned to a full commit SHA, credentials not kept', () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(workflow, /\bsecrets\.|write-all|: write\b|upload-artifact/);
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const ref of uses) assert.match(ref, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, ref);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+persist-credentials: false\n/);
});

test('ci workflow: the Node major matches the engines requirement in package.json', () => {
  const engines = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).engines.node as string;
  const pinned = workflow.match(/node-version: '(\d+)'/)?.[1];
  assert.equal(pinned, engines.match(/(\d+)/)?.[1], `workflow Node ${pinned} vs engines ${engines}`);
});

test('ci workflow: the job timeout covers every check at its scaled limit plus one rerun of the longest', () => {
  const checks = parseChecks(readFileSync(join(REPO_ROOT, '.premerge', 'checks.json'), 'utf8'));
  const scale = timeoutScale({ ORRERY_CHECK_TIMEOUT_SCALE: envOf('ORRERY_CHECK_TIMEOUT_SCALE') });
  const limits = checks.map((check) => check.timeout_seconds * scale);
  const worstMinutes = (limits.reduce((a, b) => a + b, 0) + Math.max(...limits)) / 60;
  const job = Number(workflow.match(/^\s+timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(job >= worstMinutes + 5, `timeout-minutes ${job} < ${Math.ceil(worstMinutes)} + 5 for setup`);
  assert.match(envOf('ORRERY_TEST_CONCURRENCY') ?? '', /^[1-9]\d*$/, 'the test concurrency is set explicitly');
  const perTest = Number(envOf('ORRERY_TEST_TIMEOUT_MS'));
  const testLimit = checks.find((check) => check.name === 'test')!.timeout_seconds * scale * 1000;
  assert.ok(perTest > 0 && perTest * 3 <= testLimit, `a per-test timeout (${perTest} ms) well inside the test check's limit (${testLimit} ms)`);
});

const pass: Outcome = { kind: 'pass', ms: 1000 };
const fail: Outcome = { kind: 'fail', ms: 1000, code: 1 };
const checksAB: Check[] = [{ name: 'a', argv: ['x'], timeout_seconds: 10 }, { name: 'b', argv: ['y'], timeout_seconds: 20 }];

test('ci checks: a failed check runs once more; two failures stop the run', async () => {
  const lines: string[] = [];
  const seq = [pass, fail, pass];
  assert.equal(await runChecks(checksAB, async () => seq.shift()!, 1, (l) => lines.push(l)), 0);
  assert.ok(lines.some((l) => l.startsWith('::warning::check b')));
  const calls: string[] = [];
  assert.equal(await runChecks(checksAB, async (c) => { calls.push(c.name); return fail; }, 1, () => {}), 1);
  assert.deepEqual(calls, ['a', 'a'], 'b never runs after a failed twice');
  assert.throws(() => parseChecks('{"checks":[]}'));
  assert.throws(() => parseChecks('{"checks":[{"name":"a","argv":[],"timeout_seconds":1}]}'));
});

test('ci checks: a timeout is reported as one, with its elapsed time, and is not rerun', async () => {
  const lines: string[] = [];
  const calls: Array<[string, number]> = [];
  const code = await runChecks(checksAB, async (c, limitMs) => { calls.push([c.name, limitMs]); return { kind: 'timeout', ms: 30_400, leftover: [], listed: true }; }, 1.5, (l) => lines.push(l));
  assert.equal(code, 1);
  assert.deepEqual(calls, [['a', 15_000]], 'the scaled limit, a single run');
  assert.ok(lines.includes('::error::check a timed out after 30 s (limit 15 s), not rerun; its process tree is gone'), lines.join('\n'));
  const left: string[] = [];
  await runChecks(checksAB, async () => ({ kind: 'timeout', ms: 1, leftover: [42], listed: true }), 1, (l) => left.push(l));
  assert.match(left.at(-1)!, /processes still running after the kill: 42$/);
  const unlisted: string[] = [];
  await runChecks(checksAB, async () => ({ kind: 'timeout', ms: 1, leftover: [], listed: false }), 1, (l) => unlisted.push(l));
  assert.match(unlisted.at(-1)!, /could not be listed, so only the check's own process was killed and watched: child processes may still be running$/);
  assert.doesNotMatch(unlisted.at(-1)!, /is gone/, 'no claim without a listing');
});

test('ci checks: the timeout scale is 1 unless set to a sane number', () => {
  assert.equal(timeoutScale({}), 1);
  assert.equal(timeoutScale({ ORRERY_CHECK_TIMEOUT_SCALE: '' }), 1);
  assert.equal(timeoutScale({ ORRERY_CHECK_TIMEOUT_SCALE: '1.5' }), 1.5);
  for (const bad of ['0', '-1', 'x', '11', '1e3', ' 2']) assert.throws(() => timeoutScale({ ORRERY_CHECK_TIMEOUT_SCALE: bad }), /ORRERY_CHECK_TIMEOUT_SCALE/, bad);
});

test('ci checks: the process tree follows parent ids but not a reused id of an older process', () => {
  const rows = [
    { pid: 10, parent: 1, created: 100 },
    { pid: 11, parent: 10, created: 110 },
    { pid: 12, parent: 11, created: 120 },
    { pid: 13, parent: 10, created: 90 },   // older than 10: its real parent was an earlier process with id 10
    { pid: 14, parent: 99, created: 130 },
  ];
  assert.deepEqual(treeOf(rows, 10), [10, 11, 12]);
  assert.deepEqual(treeOf(rows, 77), [77], 'an unknown root is still waited for');
});

test('ci checks: an id Windows reused for another process is not counted as left over or killed', () => {
  const created = new Map([[10, 100], [11, 110], [12, 120]]);
  const now = [{ pid: 10, parent: 1, created: 100 }, { pid: 11, parent: 5, created: 999 }, { pid: 40, parent: 1, created: 5 }];
  assert.deepEqual(sameProcesses([10, 11, 12], created, now, 10), [10], '11 is a new process with the old id, 12 is gone');
  assert.deepEqual(sameProcesses([10], new Map(), [{ pid: 10, parent: 1, created: 1 }], 10), [10], "an unlisted root is the check's own child");
  assert.deepEqual(sameProcesses([10, 11], created, [], 10), [10, 11], 'without a current listing nothing is dropped');
});
