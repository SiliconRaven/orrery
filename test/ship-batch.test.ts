// Batch ship (docs/collaboration.md「验收批次」): one merge commit for a whole review batch, the checks run once, one
// Reviewed-by line per task, every merge recorded in one Hub transaction; a conflict or failed check leaves the target alone.
// Every git action happens in temporary repositories under the system temp directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseCommandLine, shipBatch, ShipRefused as ScriptRefused, type BatchShipOptions, type BatchVerified } from '../scripts/ship.ts';
import { batchShipState } from '../src/plugins/tasks/batches.ts';
import { batchMergedOnTarget, batchShipFor, batchShipTicket, reportBatchShip, shipFor, shipTicket, ShipRefused, verifyBatchShip, verifyShip } from '../src/plugins/tasks/ship.ts';
import { collaborationRecords } from '../src/plugins/tasks/store.ts';
import { a, b, c, chain, r, user } from './batch-fixture.ts';
import { tempDir } from './helpers.ts';

const SECRET = 'a'.repeat(64);

/** A repository with main checked out and a check that appends one character to runs.txt per run (failing when `fail` exists). */
function repo(t: TestContext) {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const log = join(dir, 'runs.txt');
  const failFlag = join(dir, 'fail');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const write = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  const commit = (message: string) => { g('add', '-A'); g('commit', '-qm', message); return g('rev-parse', 'HEAD'); };
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'tester');
  g('config', 'user.email', 'tester@example.invalid');
  g('config', 'core.autocrlf', 'false');
  write('README.md', 'hello\n');
  write('.premerge/checks.json', JSON.stringify({ checks: [{ name: 'probe', timeout_seconds: 60,
    argv: ['node', '-e', 'require("fs").appendFileSync(process.argv[1], "x"); if (require("fs").existsSync(process.argv[2])) process.exit(1)', log, failFlag] }] }));
  commit('base');
  /** A branch `name` from `from` with `files`; main stays checked out. */
  const branch = (name: string, from: string, files: Record<string, string>) => {
    g('checkout', '-q', '-b', name, from);
    for (const [file, content] of Object.entries(files)) write(file, content);
    const sha = commit(`work on ${name}`);
    g('checkout', '-q', 'main');
    return sha;
  };
  const runs = () => existsSync(log) ? readFileSync(log, 'utf8').length : 0;
  return { dir, root, g, write, commit, branch, runs, failChecks: () => writeFileSync(failFlag, '') };
}

/** A three-task chain, each task on a branch built on the previous one, all submitted and approved by r. */
function approvedChain(t: TestContext) {
  const g = repo(t);
  const s1 = g.branch('agent/one', 'main', { 'one.txt': '1\n' });
  const s2 = g.branch('agent/two', 'agent/one', { 'two.txt': '2\n' });
  const s3 = g.branch('agent/three', 'agent/two', { 'three.txt': '3\n' });
  const f = chain(t, g.root);
  f.start(a, f.one); f.submit(a, f.one, s1);
  f.start(b, f.two); f.submit(b, f.two, s2);
  f.start(c, f.three); f.submit(c, f.three, s3);
  for (const task of [f.one, f.two, f.three]) f.review(r, task);
  const state = batchShipState(f.store, 'k', f.batchId)!;
  const ticket = batchShipTicket(SECRET, { clusterId: 'k', batchId: f.batchId, digest: state.digest });
  const client = { verify: async () => verifyBatchShip(f.hub, SECRET, ticket) as BatchVerified,
    report: async (result: object) => { await reportBatchShip(f.hub, SECRET, { ticket, ...result }); } };
  const options = (extra: Partial<BatchShipOptions> = {}): BatchShipOptions => ({ agent: 'claude-code', type: 'feat', summary: 'Land the chain',
    trailers: ['Co-Authored-By: Someone <someone@example.invalid>'], cwd: g.root, lockWaitMs: 5000, hub: client, ...extra });
  return { ...f, git: g, shas: [s1, s2, s3], ticket, options };
}

const status = (expected: number) => (e: unknown) => e instanceof ShipRefused && e.status === expected;

test('a batch merges in one commit: the checks run once, one Reviewed-by line per task, every task recorded merged', async (t) => {
  const f = approvedChain(t);
  const before = f.git.g('rev-parse', 'main');
  assert.equal(batchShipState(f.store, 'k', f.batchId)!.runner, 'r', 'the member reviewer runs it');
  const command = (batchShipFor(f.hub, SECRET, 'http://127.0.0.1:9', 'k', f.batchId).ship as { command: string }).command;
  assert.match(command, / --batch b1\.\S+ --hub http:\/\/127\.0\.0\.1:9 --agent <name>/);
  const out = await shipBatch(f.options());
  assert.ok(out.merged);
  assert.equal(f.git.runs(), 1, 'the checks ran once for the whole batch');
  assert.equal(f.git.g('rev-parse', 'main'), out.mergeCommit);
  assert.equal(f.git.g('rev-parse', 'main^1'), before);
  assert.equal(f.git.g('rev-parse', 'main^2'), f.shas[2], 'a chain: one merge whose second parent is the last branch');
  const ids = [f.one, f.two, f.three].map((task) => task.id.slice(0, 8));
  assert.equal(f.git.g('log', '-1', '--format=%B', 'main'), ['[claude-code] feat: Land the chain', '',
    ...f.shas.map((sha, i) => `Reviewed-by: name-r (task ${ids[i]}, r1, pass, ${sha.slice(0, 7)})`), 'Co-Authored-By: Someone <someone@example.invalid>'].join('\n'));
  for (const task of [f.one, f.two, f.three]) {
    const now = f.read(task.id);
    assert.equal(now.task.status, 'merged');
    assert.equal(now.task.mergedCommitSha, out.mergeCommit);
    assert.equal(collaborationRecords(f.store, task.id, 'merge').length, 1);
  }
  assert.equal(f.view(f.batchId).merged, true);
  assert.match(f.messages().at(-1)!.body, /批次 B1【chain】已合并（提交 [0-9a-f]{7}）：#1、#2、#3/);
  assert.throws(() => verifyBatchShip(f.hub, SECRET, f.ticket), status(409), 'the ticket is spent');
});

test('independent branches become one merge commit with every branch as a parent; a chain continued on one branch is fine', async (t) => {
  const g = repo(t);
  const s1 = g.branch('agent/x', 'main', { 'x.txt': 'x\n' });
  g.g('checkout', '-q', 'agent/x');
  g.write('x2.txt', 'more\n');
  const s2 = g.commit('continued on the same branch');   // agent/x moved on: s1 is inside s2
  g.g('checkout', '-q', 'main');
  const s3 = g.branch('agent/z', 'main', { 'z.txt': 'z\n' });
  const f = chain(t, g.root);
  f.start(a, f.one); f.submit(a, f.one, s1);
  f.start(b, f.two); f.submit(b, f.two, s2);
  f.act(user, f.three, { action: 'task.edit', dependencyIds: [] });
  f.start(c, f.three); f.submit(c, f.three, s3);
  for (const task of [f.one, f.two, f.three]) f.review(user, task);
  const state = batchShipState(f.store, 'k', f.batchId)!;
  assert.equal(state.runner, 'c', 'the user approved: the executor of the last task in dependency order');
  const ticket = batchShipTicket(SECRET, { clusterId: 'k', batchId: f.batchId, digest: state.digest });
  const out = await shipBatch({ agent: 'claude-code', type: 'feat', summary: 'Land', trailers: [], cwd: g.root, lockWaitMs: 5000,
    hub: { verify: async () => verifyBatchShip(f.hub, SECRET, ticket) as BatchVerified, report: async (result) => { await reportBatchShip(f.hub, SECRET, { ticket, ...result }); } } });
  assert.ok(out.merged);
  assert.deepEqual(g.g('log', '-1', '--format=%P', 'main').split(' ').slice(1).sort(), [s2, s3].sort(), 'parents: main, then each branch tip');
  assert.equal(batchMergedOnTarget([g.root], out.mergeCommit, [s1.slice(0, 8), s2, s2.slice(0, 8), s3]), true,
    'abbreviated and duplicate reviewed commits resolve to the same maximal heads');
  assert.equal(g.runs(), 1);
  assert.equal(f.read(f.one.id).task.status, 'merged');
});

test('a conflict names its task: only it goes back, the target is untouched, the other approvals stay', async (t) => {
  const f = approvedChain(t);
  // main changes two.txt after the branches were cut, so task two's branch no longer merges.
  f.git.write('two.txt', 'main\n');
  f.git.commit('main touches two.txt');
  const before = f.git.g('rev-parse', 'main');
  const out = await shipBatch(f.options());
  assert.equal(out.merged, false);
  assert.ok(!out.merged && out.kind === 'conflict' && out.taskId === f.two.id && /task #2 .*two\.txt/s.test(out.detail));
  assert.equal(f.git.g('rev-parse', 'main'), before);
  assert.equal(f.git.runs(), 0, 'no checks ran');
  assert.equal(f.read(f.two.id).task.status, 'pending');
  assert.equal(f.read(f.two.id).task.assignedMemberId, 'b', 'back with its executor');
  assert.equal(f.read(f.one.id).task.status, 'completed');
  assert.equal(f.read(f.one.id).task.completionValid, true, 'upstream approval stays');
  assert.equal(f.read(f.three.id).task.completionValid, false, 'downstream of the returned task must be redone');
  const notice = f.messages().find((m) => m.systemKind === 'ship_failed')!;
  assert.match(notice.body, /任务 #2 的分支有合并冲突，已退回它的执行者/);
  assert.deepEqual(f.woke(notice.id), ['b']);
  assert.equal(f.view(f.batchId).shipFailure.kind, 'conflict');
});

test('a check that fails twice sends back the task that ends the chain; the target is untouched', async (t) => {
  const f = approvedChain(t);
  f.git.failChecks();
  const before = f.git.g('rev-parse', 'main');
  const out = await shipBatch(f.options());
  assert.ok(!out.merged && out.kind === 'checks');
  assert.equal(f.git.runs(), 2, 'one run and its retry');
  assert.equal(f.git.g('rev-parse', 'main'), before);
  assert.deepEqual([f.one, f.two, f.three].map((task) => f.read(task.id).task.status), ['completed', 'completed', 'pending']);
  assert.match(f.messages().find((m) => m.systemKind === 'ship_failed')!.body, /合并前检查未通过，无法归到单个任务，已退回批次末端的任务 #3/);
});

test('a batched task cannot be shipped alone, and the Hub records a batch merge only when git shows every commit in it', async (t) => {
  const f = approvedChain(t);
  assert.deepEqual(shipFor(f.hub, SECRET, 'http://127.0.0.1:9', 'k', f.one.id), {}, 'no single-task command');
  const single = shipTicket(SECRET, { clusterId: 'k', taskId: f.one.id, submissionId: f.read(f.one.id).task.approvedSubmissionId!, commitSha: f.shas[0], reviewer: 'r' });
  assert.throws(() => verifyShip(f.hub, SECRET, single), (e) => e instanceof ShipRefused && /review batch/.test(e.message));
  // A merge of only the first branch does not contain the others.
  f.git.g('merge', '-q', '--no-ff', '-m', 'only one', f.shas[0]);
  const partial = f.git.g('rev-parse', 'HEAD');
  await assert.rejects(reportBatchShip(f.hub, SECRET, { ticket: f.ticket, mergeCommit: partial, pushed: false }), status(409));
  assert.throws(() => f.send(r, { action: 'batch.merge', batchId: f.batchId, commitSha: partial }), (e) => (e as { code?: string }).code === 'MERGE_NOT_VERIFIED');
  assert.equal(f.read(f.one.id).task.status, 'completed', 'nothing recorded');
  // The way out for a merge that landed but was not reported: git shows every reviewed commit brought in by it.
  f.git.g('merge', '-q', '--no-ff', '-m', 'the rest', f.shas[2]);
  assert.throws(() => f.send(r, { action: 'batch.merge', batchId: f.batchId, commitSha: f.git.g('rev-parse', 'HEAD') }), (e) => (e as { code?: string }).code === 'MERGE_NOT_VERIFIED',
    'its first parent already holds the first commit: this commit did not merge the whole batch');
});

test('the batch changing before the report records nothing: all or nothing', async (t) => {
  const f = approvedChain(t);
  f.git.g('merge', '-q', '--no-ff', '-m', 'the batch', f.shas[2]);
  const mergeCommit = f.git.g('rev-parse', 'HEAD');
  f.act(r, f.three, { action: 'task.reopen', reason: 'one more change' });
  await assert.rejects(reportBatchShip(f.hub, SECRET, { ticket: f.ticket, mergeCommit, pushed: false }), status(409));
  assert.deepEqual([f.one, f.two].map((task) => f.read(task.id).task.status), ['completed', 'completed'], 'no task was recorded merged');
});

test('a batch merge must name the reviewed heads, not later unreviewed descendants', async (t) => {
  const f = approvedChain(t);
  const later = f.git.branch('agent/later', f.shas[2], { 'unreviewed.txt': 'not approved\n' });
  f.git.g('merge', '-q', '--no-ff', '-m', 'merge the moved branch', later);
  const mergeCommit = f.git.g('rev-parse', 'HEAD');
  await assert.rejects(reportBatchShip(f.hub, SECRET, { ticket: f.ticket, mergeCommit, pushed: false }), status(409));
  assert.throws(() => f.send(r, { action: 'batch.merge', batchId: f.batchId, commitSha: mergeCommit }),
    (e) => (e as { code?: string }).code === 'MERGE_NOT_VERIFIED');
  for (const task of [f.one, f.two, f.three]) {
    assert.equal(f.read(task.id).task.status, 'completed');
    assert.equal(collaborationRecords(f.store, task.id, 'merge').length, 0);
  }
});

test('the command line takes --batch in place of --ticket, never both', () => {
  const base = ['--hub', 'http://127.0.0.1:1', '--agent', 'claude-code', '--type', 'feat', '--summary', 'Land'];
  assert.equal(parseCommandLine(['--batch', 'b1.x.y', ...base]).mode, 'batch');
  assert.equal(parseCommandLine(['--ticket', 's1.x.y', ...base]).mode, 'ship');
  assert.throws(() => parseCommandLine(['--batch', 'b1.x.y', '--ticket', 's1.x.y', ...base]), ScriptRefused);
});
