// Batch ship (docs/collaboration.md「验收批次」): one merge commit for a whole review batch, the checks run once, one
// Reviewed-by line per task, every merge recorded in one Hub transaction; a conflict or failed check leaves the target alone.
// Every git action happens in temporary repositories under the system temp directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseCommandLine, shipBatch, ShipRefused as ScriptRefused, type BatchShipOptions, type BatchVerified } from '../scripts/ship.ts';
import { batchShipState } from '../src/plugins/tasks/package/hub/batches.mts';
import { setBranchLookup } from '../src/plugins/tasks/package/hub/branch-link.mts';
import { batchMergedOnTarget, batchShipFor, batchShipTicket, reportBatchShip, shipFor, shipTicket, ShipRefused, verifyBatchShip, verifyShip } from '../src/plugins/tasks/package/hub/ship.mts';
import { collaborationRecords } from '../src/plugins/tasks/package/hub/store.mts';
import { a, b, batchFixture, c, chain, r, user } from './batch-fixture.ts';
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

test('a conflict keeps all batch tasks completed, records conflictFiles and taskId, leaves target untouched, and informs without waking', async (t) => {
  const f = approvedChain(t);
  // main changes two.txt after the branches were cut, so task two's branch no longer merges.
  f.git.write('two.txt', 'main\n');
  f.git.commit('main touches two.txt');
  const before = f.git.g('rev-parse', 'main');
  const out = await shipBatch(f.options());
  assert.equal(out.merged, false);
  assert.ok(!out.merged && out.kind === 'conflict' && out.taskId === f.two.id && /task #2 .*two\.txt/s.test(out.detail));
  assert.deepEqual(out.conflictFiles, ['two.txt']);
  assert.equal(f.git.g('rev-parse', 'main'), before);
  assert.equal(f.git.runs(), 0, 'no checks ran');
  for (const task of [f.one, f.two, f.three]) {
    assert.equal(f.read(task.id).task.status, 'completed', 'all tasks stay completed');
    assert.equal(f.read(task.id).task.completionValid, true);
  }
  const notice = f.messages().find((m) => m.systemKind === 'ship_failed')!;
  assert.match(notice.body, /任务 #2 的分支有合并冲突（保持已通过状态/);
  assert.deepEqual(f.woke(notice.id), [], 'batch ship_failed notifies infoOnly without waking');
  const failure = f.view(f.batchId).shipFailure;
  assert.equal(failure.kind, 'conflict');
  assert.deepEqual(failure.taskIds, [f.two.id]);
  assert.deepEqual(failure.conflictFiles, ['two.txt']);
  assert.ok(Number.isSafeInteger(failure.eventId) && failure.eventId > 0);
  assert.ok(notice.body.includes(`事件 ${failure.eventId}。`));
  assert.equal(failure.attribution, null);
  assert.deepEqual(failure.fixes, []);
});

test('a check that fails twice keeps all tasks completed with empty taskIds (no batchEnds) and allows verbatim rerun', async (t) => {
  const f = approvedChain(t);
  f.git.failChecks();
  const before = f.git.g('rev-parse', 'main');
  const out = await shipBatch(f.options());
  assert.ok(!out.merged && out.kind === 'checks');
  assert.equal(out.failedCheck, 'probe');
  assert.equal(f.git.runs(), 2, 'one run and its retry');
  assert.equal(f.git.g('rev-parse', 'main'), before);
  assert.deepEqual([f.one, f.two, f.three].map((task) => f.read(task.id).task.status), ['completed', 'completed', 'completed']);
  const notice = f.messages().find((m) => m.systemKind === 'ship_failed')!;
  assert.match(notice.body, /合并前检查未通过（probe）（尚未归因，保持已通过状态/);
  assert.deepEqual(f.woke(notice.id), [], 'checks ship_failed wakes nobody');
  const view = f.view(f.batchId);
  assert.deepEqual(view.shipFailure.taskIds, [], 'checks failures never pre-populate batchEnds');
  assert.equal(view.shipFailure.failedCheck, 'probe');
  assert.equal(view.shipFailure.attribution, null);
  assert.equal(view.shipFixAllowed, true);
  // Before attribution, ship_fix on any task is refused 409.
  setBranchLookup({ budgetMs: 60_000 });
  t.after(() => setBranchLookup());
  f.hub.collaboration.prepareTimeoutMs = 60_000;
  for (const task of [f.one, f.two, f.three]) {
    await assert.rejects(() => f.hub.collaboration.commandAsync(r, 'k', {
      action: 'task.ship_fix', taskId: task.id, expectedRevision: f.read(task.id).task.revision,
      operationId: `unattr-${task.id}`, failureEventId: view.shipFailure.eventId, commitSha: f.shas[0], summary: 'no attr',
    } as any), (e: any) => e.code === 'INVALID_STATE');
  }
  // Removing the transient failure allows r to rerun the exact same b1 ticket verbatim.
  rmSync(join(f.git.dir, 'fail'));
  const rerun = await shipBatch(f.options());
  assert.equal(rerun.merged, true);
  assert.equal(f.view(f.batchId).shipFailure, null, 'shipFailure cleared upon batch merge');
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

test('batch attribute_failure + ship_fix on A -> B + unrelated C preserves same-batch lineage across completed and merged, and reopen/cancel breaks it', async (t) => {
  setBranchLookup({ budgetMs: 60_000 });
  t.after(() => setBranchLookup());
  const g = repo(t);
  const sA0 = g.branch('agent/a', 'main', { 'a.txt': 'a0\n' });
  const sB0 = g.branch('agent/b', 'agent/a', { 'b.txt': 'b0\n' });
  const sC0 = g.branch('agent/c', 'main', { 'c.txt': 'c0\n' });

  const f = batchFixture(t, g.root);
  f.hub.collaboration.prepareTimeoutMs = 60_000;
  const batch = f.batch('attr-lineage', r, user);
  const tA = f.create('A', batch.id, { memberId: 'a' });
  const tB = f.create('B', batch.id, { memberId: 'b', dependencyIds: [tA.id] });
  const tC = f.create('C', batch.id, { memberId: 'c' });
  const tD = f.create('D-outside', undefined, { memberId: 'c', dependencyIds: [tB.id] });

  f.start(a, tA); const subA0 = f.submit(a, tA, sA0).submission!;
  f.start(b, tB); f.submit(b, tB, sB0);
  f.start(c, tC); f.submit(c, tC, sC0);
  for (const task of [tA, tB, tC]) f.review(r, task);

  g.failChecks();
  const state0 = batchShipState(f.store, 'k', batch.id)!;
  const ticket0 = batchShipTicket(SECRET, { clusterId: 'k', batchId: batch.id, digest: state0.digest });
  const failOut = await shipBatch({
    agent: 'claude-code', type: 'feat', summary: 'Land B1', trailers: [], cwd: g.root, lockWaitMs: 5000,
    hub: { verify: async () => verifyBatchShip(f.hub, SECRET, ticket0) as BatchVerified, report: async (res) => { await reportBatchShip(f.hub, SECRET, { ticket: ticket0, ...res }); } },
  });
  assert.equal(failOut.merged, false);
  const failEv = f.view(batch.id).shipFailure.eventId;

  // Attribution access checks: only independent batch reviewer r may attribute, and out-of-batch tasks are refused.
  assert.throws(() => f.send(a, { action: 'batch.attribute_failure', batchId: batch.id, failureEventId: failEv, taskIds: [tA.id], reason: 'a' } as any),
    (e: any) => e.code === 'FORBIDDEN');
  assert.throws(() => f.send(user, { action: 'batch.attribute_failure', batchId: batch.id, failureEventId: failEv, taskIds: [tA.id], reason: 'user' } as any),
    (e: any) => e.code === 'FORBIDDEN');
  assert.throws(() => f.send(r, { action: 'batch.attribute_failure', batchId: batch.id, failureEventId: failEv, taskIds: [tD.id], reason: 'outside' } as any),
    (e: any) => e.code === 'INVALID_REQUEST');

  // Reviewer r attributes checks failure to tA once; infoOnly to a, write-once lock rejects second attribution.
  const msgCountBeforeAttr = f.messages().length;
  const attrRes = f.send(r, { action: 'batch.attribute_failure', batchId: batch.id, failureEventId: failEv, taskIds: ['#1'], reason: 'A broke probe' } as any);
  assert.deepEqual((attrRes.batch as any).shipFailure.attribution.taskIds, [tA.id]);
  const attrMsg = f.messages().slice(msgCountBeforeAttr).find((m) => /归因于 #1/.test(m.body))!;
  assert.ok(attrMsg.mentions.includes('a'));
  assert.deepEqual(f.woke(attrMsg.id), [], 'attribution wakes nobody');
  assert.throws(() => f.send(r, { action: 'batch.attribute_failure', batchId: batch.id, failureEventId: failEv, taskIds: [tC.id], reason: 'expand' } as any),
    (e: any) => e.code === 'INVALID_STATE');

  // Before tA is fixed, both tB and unrelated tC refuse ship_fix 409.
  const callShipFix = (task: typeof tA, commitSha: string, op: string, actor = r) =>
    f.hub.collaboration.commandAsync(actor, 'k', {
      action: 'task.ship_fix', taskId: task.id, expectedRevision: f.read(task.id).task.revision,
      operationId: op, failureEventId: failEv, commitSha, summary: 'batch fix',
    } as any);
  await assert.rejects(() => callShipFix(tB, sB0, 'b-early'), (e: any) => e.code === 'INVALID_STATE');
  await assert.rejects(() => callShipFix(tC, sC0, 'c-unrel'), (e: any) => e.code === 'INVALID_STATE');

  // Fix tA forward; verify tB stays valid, tC stays blocked 409, second fix on tA is 409, and old ticket0 is invalidated 409.
  rmSync(join(g.dir, 'fail'));
  g.g('checkout', '-q', 'agent/a');
  g.write('a.txt', 'a-fixed\n');
  const sAFix = g.commit('forward fix A');
  g.g('checkout', '-q', 'main');

  const fixA = await callShipFix(tA, sAFix, 'fix-a');
  assert.equal(fixA.task!.status, 'completed');
  assert.equal(fixA.task!.batchId, batch.id);
  assert.equal(fixA.submission!.shipFix!.originSubmissionId, subA0.id);
  assert.equal(f.read(tB.id).task.completionValid, true, 'downstream B stays completionValid while completed');
  assert.equal(f.read(tB.id).task.dependenciesChanged, false);
  const midView = f.view(batch.id);
  assert.notEqual(midView.shipFailure.digest, midView.currentDigest, 'digest differs once partially fixed');
  await assert.rejects(() => callShipFix(tA, sAFix, 'fix-a-twice'), (e: any) => e.code === 'INVALID_STATE');
  await assert.rejects(() => callShipFix(tC, sC0, 'c-still-blocked'), (e: any) => e.code === 'INVALID_STATE');
  assert.throws(() => verifyBatchShip(f.hub, SECRET, ticket0), status(409), 'old b1 ticket invalidated after ship_fix');

  // Also test that downstream B IS now unlocked for a ship_fix if needed (while leaving original C unfixed!).
  g.g('checkout', '-q', 'agent/b');
  g.g('merge', '-q', '--no-ff', '-m', 'pull A fix into B', sAFix);
  g.write('b.txt', 'b-fixed\n');
  const sBFix = g.commit('forward fix B');
  g.g('checkout', '-q', 'main');
  const fixB = await callShipFix(tB, sBFix, 'fix-b');
  assert.equal(fixB.task!.status, 'completed');

  const state1 = batchShipState(f.store, 'k', batch.id)!;
  const ticket1 = batchShipTicket(SECRET, { clusterId: 'k', batchId: batch.id, digest: state1.digest });
  const verified1 = verifyBatchShip(f.hub, SECRET, ticket1);
  assert.deepEqual(verified1.tasks.map((x) => [x.number, x.shipFix ?? false]), [[1, true], [2, true], [3, false]], 'only fixed tasks carry shipFix flag');
  const landed = await shipBatch({
    agent: 'claude-code', type: 'feat', summary: 'Land fixed batch', trailers: [], cwd: g.root, lockWaitMs: 5000,
    hub: { verify: async () => verifyBatchShip(f.hub, SECRET, ticket1) as BatchVerified, report: async (res) => { await reportBatchShip(f.hub, SECRET, { ticket: ticket1, ...res }); } },
  });
  assert.equal(landed.merged, true);
  assert.equal(f.view(batch.id).shipFailure, null);
  const logMsg = g.g('log', '-1', '--format=%B', 'main');
  assert.match(logMsg, new RegExp(`Reviewed-by: name-r \\(task ${tA.id.slice(0, 8)}, r1, pass, ${sAFix.slice(0, 7)}, ship fix\\)`));
  assert.match(logMsg, new RegExp(`Reviewed-by: name-r \\(task ${tC.id.slice(0, 8)}, r1, pass, ${sC0.slice(0, 7)}\\)`));

  // After merging the batch (all tasks status: 'merged'), check same-batch lineage on a fixed upstream -> untouched downstream B2 -> out-of-batch D2!
  const g2 = repo(t);
  const u0 = g2.branch('agent/u', 'main', { 'u.txt': 'u0\n' });
  const d0 = g2.branch('agent/d', 'agent/u', { 'd.txt': 'd0\n' });
  const f2 = batchFixture(t, g2.root);
  f2.hub.collaboration.prepareTimeoutMs = 60_000;
  const b2 = f2.batch('merged-lineage', r, user);
  const up2 = f2.create('up2', b2.id, { memberId: 'a' });
  const mid2 = f2.create('mid2', b2.id, { memberId: 'b', dependencyIds: [up2.id] });
  const out2 = f2.create('out2', undefined, { memberId: 'c', dependencyIds: [mid2.id] });
  f2.start(a, up2); f2.submit(a, up2, u0);
  f2.start(b, mid2); f2.submit(b, mid2, d0);
  f2.review(r, up2); f2.review(r, mid2);
  g2.failChecks();
  const st2 = batchShipState(f2.store, 'k', b2.id)!;
  const tk2 = batchShipTicket(SECRET, { clusterId: 'k', batchId: b2.id, digest: st2.digest });
  await shipBatch({ agent: 'claude-code', type: 'feat', summary: 'Fail b2', trailers: [], cwd: g2.root, lockWaitMs: 5000,
    hub: { verify: async () => verifyBatchShip(f2.hub, SECRET, tk2) as BatchVerified, report: async (res) => { await reportBatchShip(f2.hub, SECRET, { ticket: tk2, ...res }); } } });
  const ev2 = f2.view(b2.id).shipFailure.eventId;
  f2.send(r, { action: 'batch.attribute_failure', batchId: b2.id, failureEventId: ev2, taskIds: [up2.id], reason: 'u' } as any);
  rmSync(join(g2.dir, 'fail'));
  g2.g('checkout', '-q', 'agent/u');
  g2.write('u.txt', 'u1\n');
  const u1 = g2.commit('fix u');
  g2.g('checkout', '-q', 'main');
  await f2.hub.collaboration.commandAsync(r, 'k', {
    action: 'task.ship_fix', taskId: up2.id, expectedRevision: f2.read(up2.id).task.revision,
    operationId: 'fix-u2', failureEventId: ev2, commitSha: u1, summary: 'fix u',
  } as any);
  // Only up2 was fixed; mid2 still records original u0! Verify mid2 merges, stays completionValid in 'merged' state, and unlocks out2!
  const st2Fixed = batchShipState(f2.store, 'k', b2.id)!;
  const tk2Fixed = batchShipTicket(SECRET, { clusterId: 'k', batchId: b2.id, digest: st2Fixed.digest });
  const b2Landed = await shipBatch({ agent: 'claude-code', type: 'feat', summary: 'Land b2', trailers: [], cwd: g2.root, lockWaitMs: 5000,
    hub: { verify: async () => verifyBatchShip(f2.hub, SECRET, tk2Fixed) as BatchVerified, report: async (res) => { await reportBatchShip(f2.hub, SECRET, { ticket: tk2Fixed, ...res }); } } });
  assert.equal(b2Landed.merged, true);
  assert.equal(f2.read(mid2.id).task.status, 'merged');
  assert.equal(f2.read(mid2.id).task.completionValid, true, 'downstream citing original submission remains completionValid after batch transitions to merged');
  assert.equal(f2.read(mid2.id).task.dependenciesChanged, false);
  assert.equal(f2.read(out2.id).task.dependenciesReady, true, 'out-of-batch dependent becomes ready once merged');

  // Reopen / cancel breaks same-batch exemption immediately:
  const b3 = f2.batch('break-reopen', r, user);
  const up3 = f2.create('up3', b3.id, { memberId: 'a', mergeRequired: true });
  const mid3 = f2.create('mid3', b3.id, { memberId: 'b', dependencyIds: [up3.id], mergeRequired: true });
  f2.start(a, up3); f2.submit(a, up3, u0);
  f2.start(b, mid3); f2.submit(b, mid3, d0);
  f2.review(r, up3); f2.review(r, mid3);
  f2.act(r, up3, { action: 'task.reopen', reason: 'reopen breaks lineage' });
  assert.equal(f2.read(up3.id).task.batchId, undefined, 'reopened task leaves batch');
  assert.equal(f2.read(mid3.id).task.completionValid, false, 'reopen breaks downstream completionValid immediately');
  assert.equal(f2.read(mid3.id).task.dependenciesChanged, true);

  // User-substituted approval inside member batch refuses attribute_failure & ship_fix 403 while fallback runner can still rerun verbatim.
  const bUser = f.batch('user-sub', r, user);
  const uOne = f.create('uone', bUser.id, { memberId: 'a' });
  f.start(a, uOne); f.submit(a, uOne, sA0);
  f.review(user, uOne); // user substituted in member batch -> fallback runner is 'a'
  const uSt = batchShipState(f.store, 'k', bUser.id)!;
  assert.equal(uSt.runner, 'a');
  assert.equal(f.view(bUser.id).shipFixAllowed, false);
  const uTk = batchShipTicket(SECRET, { clusterId: 'k', batchId: bUser.id, digest: uSt.digest });
  await reportBatchShip(f.hub, SECRET, { ticket: uTk, failed: { kind: 'checks', failedCheck: 'probe', detail: 'fail' } });
  const uFailEv = f.view(bUser.id).shipFailure.eventId;
  for (const actor of [r, a, user]) {
    assert.throws(() => f.send(actor, { action: 'batch.attribute_failure', batchId: bUser.id, failureEventId: uFailEv, taskIds: [uOne.id], reason: 'no' } as any),
      (e: any) => e.code === 'FORBIDDEN');
    await assert.rejects(() => callShipFix(uOne as any, sAFix, `usub-${actor.kind}`, actor), (e: any) => e.code === 'FORBIDDEN');
  }
  f.send(user, { action: 'batch.cancel', batchId: bUser.id, reason: 'cancel fallback' });
  assert.equal(f.view(bUser.id).shipFailure, null);

  // Batch reopen from batch.shipFailure restores prior approved executor (woken if ready, infoOnly if still waiting on unmerged dependency).
  const bReopen = f.batch('reopen-restore', r, user);
  const rt1 = f.create('rt1', bReopen.id, { memberId: 'a' });
  const rt2 = f.create('rt2', bReopen.id, { memberId: 'b', dependencyIds: [rt1.id] });
  f.start(a, rt1); f.submit(a, rt1, sA0);
  f.start(b, rt2); f.submit(b, rt2, sB0);
  f.review(r, rt1); f.review(r, rt2);
  const rSt = batchShipState(f.store, 'k', bReopen.id)!;
  const rTk = batchShipTicket(SECRET, { clusterId: 'k', batchId: bReopen.id, digest: rSt.digest });
  await reportBatchShip(f.hub, SECRET, { ticket: rTk, failed: { kind: 'checks', failedCheck: 'probe', detail: 'batch check fail' } });

  // Reopening rt2 (whose upstream rt1 is not merged yet) restores 'b' as assignedMemberId without waking while blocked on rt1
  const r2Res = f.act(r, rt2, { action: 'task.reopen', reason: 'rt2 needs rework' });
  assert.equal(r2Res.task!.status, 'pending');
  assert.equal(r2Res.task!.assignedMemberId, 'b');
  assert.equal(r2Res.task!.batchId, undefined);
  assert.equal(f.view(bReopen.id).shipFailure, null);
  assert.deepEqual(f.woke(f.messages().find((m) => m.collabEventId === r2Res.eventId)!.id), []);
  assert.match(f.messages().find((m) => m.collabEventId === r2Res.eventId)!.body, /退回给原执行者 name-b/);

  // Reopening root rt1 after another batch failure wakes 'a' (restored executor) alongside downstream owner 'b'
  await reportBatchShip(f.hub, SECRET, { ticket: batchShipTicket(SECRET, { clusterId: 'k', batchId: bReopen.id, digest: batchShipState(f.store, 'k', bReopen.id)!.digest }),
    failed: { kind: 'conflict', conflictFiles: ['a.txt'], detail: 'conflict in a.txt', taskId: rt1.id } });
  const r1Res = f.act(r, rt1, { action: 'task.reopen', reason: 'rt1 conflict rework' });
  assert.equal(r1Res.task!.status, 'pending');
  assert.equal(r1Res.task!.assignedMemberId, 'a');
  assert.deepEqual(f.woke(f.messages().find((m) => m.collabEventId === r1Res.eventId)!.id), ['a', 'b']);
});
