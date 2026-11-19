// Review batches (docs/collaboration.md「验收批次」): who may arrange them, one wake for the reviewer when a batch is complete,
// in-batch readiness on submission, and the dependency-version rules that make a resubmission void what was built on it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { MIGRATIONS } from '../src/plugins/tasks/store.ts';
import { a, b, batchFixture, c, chain, r, user } from './batch-fixture.ts';
import { tempDir } from './helpers.ts';

const code = (e: unknown) => (e as { code?: string }).code;

test('create: the user or a member names a reviewer (member or user, never self); B<number> refers to it', (t) => {
  const f = batchFixture(t);
  const one = f.batch('first');
  assert.equal(one.number, 1);
  const two = f.batch('second', user, a);
  assert.equal(two.number, 2, 'a member may create a batch');
  assert.throws(() => f.send(a, { action: 'batch.create', title: 'x', reviewer: { kind: 'self' } }), (e) => code(e) === 'INVALID_REQUEST');
  assert.throws(() => f.send(a, { action: 'batch.create', title: 'x' }), (e) => code(e) === 'INVALID_REQUEST', 'a reviewer is required');
  assert.equal(f.view('B2').id, two.id);
  assert.equal(f.view(two.id.slice(0, 8)).number, 2);
  assert.throws(() => f.view('B9'), (e) => code(e) === 'OUT_OF_SCOPE');
});

test('join and leave: at creation or with batch.add before work starts; the batch reviewer becomes the task reviewer', (t) => {
  const f = batchFixture(t);
  const batch = f.batch('chain', r, a);   // a created the batch
  const mine = f.create('mine', batch.id, { memberId: 'b' }, a);
  assert.equal(mine.batchId, batch.id);
  assert.deepEqual(mine.reviewer, r, 'the batch reviewer');
  assert.throws(() => f.create('other', batch.id, {}, b), (e) => code(e) === 'FORBIDDEN', 'only the batch creator, the user or the coordinator');
  assert.throws(() => f.create('x', batch.id, { reviewer: user }), (e) => code(e) === 'INVALID_REQUEST', 'a different reviewer is refused');
  assert.throws(() => f.create('x', batch.id, { mergeRequired: false }), (e) => code(e) === 'INVALID_REQUEST', 'every batched task needs a merge');
  assert.throws(() => f.create('x', batch.id, { memberId: 'r' }), (e) => code(e) === 'REVIEW_NOT_INDEPENDENT', 'the reviewer cannot execute');

  const loose = f.create('loose', undefined, { reviewer: c, memberId: 'b' }, a);
  const self = f.create('self', undefined, { reviewer: { kind: 'self' }, memberId: 'b' }, a);
  assert.throws(() => f.act(a, self, { action: 'batch.add', batchId: batch.id }), (e) => code(e) === 'INVALID_STATE', 'a self-review task cannot join');
  assert.throws(() => f.act(b, loose, { action: 'batch.add', batchId: batch.id }), (e) => code(e) === 'FORBIDDEN', 'b created neither');
  const added = f.act(a, loose, { action: 'batch.add', batchId: `B${batch.number}` });
  assert.equal(added.task!.batchId, batch.id);
  assert.deepEqual(f.read(loose.id).task.reviewer, r);
  const event = f.store.getEvent(added.eventId)!.payload as any;
  assert.deepEqual(event.changes, [{ field: 'reviewer', before: c, after: r }], 'the reviewer change is recorded');
  assert.throws(() => f.act(a, loose, { action: 'batch.add', batchId: batch.id }), (e) => code(e) === 'INVALID_STATE', 'already in it');
  assert.throws(() => f.act(a, loose, { action: 'task.edit', reviewer: c }), (e) => code(e) === 'INVALID_STATE', 'no other reviewer while batched');
  assert.throws(() => f.act(a, loose, { action: 'task.edit', mergeRequired: false }), (e) => code(e) === 'INVALID_STATE');

  f.start(b, mine);
  assert.throws(() => f.act(a, mine, { action: 'batch.remove', batchId: batch.id }), (e) => code(e) === 'INVALID_STATE', 'started work cannot leave');
  const removed = f.act(a, loose, { action: 'batch.remove', batchId: batch.id });
  assert.equal('batchId' in removed.task!, false);
  assert.deepEqual(f.read(loose.id).task.reviewer, r, 'it keeps the reviewer it has');
  assert.throws(() => f.send(b, { action: 'batch.cancel', batchId: batch.id, reason: 'x' }), (e) => code(e) === 'FORBIDDEN', 'only its creator, the user or the coordinator cancels it');
});

test('a task joins only until the batch has its first review', (t) => {
  const f = batchFixture(t);
  const batch = f.batch();
  const one = f.create('one', batch.id, { memberId: 'a' });
  f.start(a, one);
  f.submit(a, one, 'aaaaaaa');
  f.review(user, one, 'reject');
  const late = f.create('late', undefined, { memberId: 'b' });
  assert.throws(() => f.act(user, late, { action: 'batch.add', batchId: batch.id }), (e) => code(e) === 'INVALID_STATE' && /already has a review/.test((e as Error).message));
  assert.throws(() => f.create('late2', batch.id), (e) => code(e) === 'INVALID_STATE');
});

test('in-batch readiness: a dependent may start once its upstream is submitted, and is told what to build on', (t) => {
  const f = chain(t);
  assert.equal(f.read(f.two.id).task.dependenciesReady, false);
  assert.throws(() => f.start(b, f.two), (e) => code(e) === 'DEPENDENCIES_NOT_READY');
  f.start(a, f.one);
  // Its own repository: the checkout running the tests may not be one (an exported tree has no .git).
  const repo = tempDir();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  f.act(user, f.one, { action: 'task.set_git_branch', gitBranch: { repositoryPath: repo, branch: 'agent/one' } });
  const submitted = f.submit(a, f.one, 'aaaaaaa');
  const two = f.read(f.two.id);
  assert.equal(two.task.dependenciesReady, true);
  assert.deepEqual(two.dependencies[0].batchBase, { submissionId: submitted.submission!.id, commitSha: 'aaaaaaa', branch: 'agent/one' });
  assert.equal(two.batch.number, 1, 'get_task names the batch');
  const ready = f.messages().find((m) => m.mentions.includes('b') && /前置依赖已就绪（批次内/.test(m.body))!;
  assert.match(ready.body, /提交 aaaaaaa，分支 agent\/one/);
  assert.deepEqual(f.woke(ready.id), ['b'], 'the dependent executor is woken');
  assert.equal(f.read(f.three.id).task.dependenciesReady, false, 'three waits for two');
  f.start(b, f.two);
  // Outside the batch the merged rule is unchanged: a task depending on one is not ready before one merges.
  const outside = f.create('outside', undefined, { memberId: 'c', dependencyIds: [f.one.id] });
  assert.equal(f.read(outside.id).task.dependenciesReady, false);
  assert.equal(f.read(outside.id).dependencies[0].batchBase, undefined);
});

test('submissions do not wake the reviewer; the batch being complete wakes it once, listing every task and commit', (t) => {
  const f = chain(t);
  f.start(a, f.one);
  const s1 = f.submit(a, f.one, 'aaaaaaa');
  const plain = f.messages().find((m) => m.collabEventId === s1.eventId)!;
  assert.ok(plain.mentions.includes('r'), 'the reviewer has it unread');
  assert.equal(f.woke(plain.id).includes('r'), false, 'but is not woken');
  assert.match(plain.body, /属于批次 B1【chain】，批次齐了以后 name-r 一起验收/);
  f.start(b, f.two);
  f.submit(b, f.two, 'bbbbbbb');
  assert.equal(f.completeNotices().length, 0);
  // A member reviewer cannot review early; the missing tasks are listed. The user can (next test).
  assert.throws(() => f.review(r, f.one), (e) => code(e) === 'BATCH_INCOMPLETE' && /#3 待开工/.test((e as Error).message));
  f.start(c, f.three);
  const last = f.submit(c, f.three, 'ccccccc');
  const notices = f.completeNotices();
  assert.equal(notices.length, 1);
  assert.deepEqual(f.woke(notices[0].id), ['r']);
  assert.match(notices[0].body, new RegExp(`事件 ${last.eventId}`));
  assert.match(notices[0].body, /#1【one】待验收：提交 aaaaaaa（新提交）/);
  assert.match(notices[0].body, /#3【three】待验收：提交 ccccccc（新提交）/);
  assert.equal(f.view(f.batchId).complete, true);
  // A resubmission of a task still in review leaves the batch complete: no second wake.
  f.submit(c, f.three, 'cccccc2');
  assert.equal(f.completeNotices().length, 1);
});

test('the user may review before the batch is complete', (t) => {
  const f = chain(t);
  f.start(a, f.one);
  f.submit(a, f.one, 'aaaaaaa');
  assert.equal(f.review(user, f.one).task!.status, 'completed');
});

for (const join of ['create', 'add']) test(`a task joining through ${join} revokes the previous ready notice until the enlarged batch is complete`, (t) => {
  const f = batchFixture(t);
  const batch = f.batch();
  const x = f.create('first', batch.id, { memberId: 'a' });
  f.start(a, x); f.submit(a, x, 'aaaaaaa');
  assert.equal(f.completeNotices().length, 1);
  const y = f.create('new task', join === 'create' ? batch.id : undefined, { memberId: 'b' });
  if (join === 'add') f.act(user, y, { action: 'batch.add', batchId: batch.id });
  assert.equal(f.view(batch.id).complete, false);
  assert.throws(() => f.review(r, x), (e) => code(e) === 'BATCH_INCOMPLETE', 'the earlier submission is no longer ready to review');
  f.start(b, y); f.submit(b, y, 'bbbbbbb');
  assert.equal(f.completeNotices().length, 2);
  assert.equal(f.view(batch.id).complete, true);
  assert.equal(f.review(r, x).task!.status, 'completed');
  assert.equal(f.review(r, y).task!.status, 'completed');
});

test('returning one task keeps the ready authorization of other submissions in the unchanged batch', (t) => {
  const f = batchFixture(t);
  const batch = f.batch();
  const x = f.create('first', batch.id, { memberId: 'a' });
  const y = f.create('second', batch.id, { memberId: 'b' });
  f.start(a, x); f.submit(a, x, 'aaaaaaa');
  f.start(b, y); f.submit(b, y, 'bbbbbbb');
  assert.equal(f.completeNotices().length, 1);
  f.review(r, x, 'reject');
  assert.equal(f.view(batch.id).complete, false);
  assert.equal(f.review(r, y).task!.status, 'completed', 'the reviewer can finish reviewing the other notified submission');
  f.submit(a, x, 'aaaaaa2');
  assert.equal(f.completeNotices().length, 2);
  assert.equal(f.review(r, x).task!.status, 'completed');
});

test('two submissions that complete a batch give exactly one notice; a retried operation replays without a second', (t) => {
  const f = batchFixture(t);
  const batch = f.batch();
  const x = f.create('x', batch.id, { memberId: 'a' });
  const y = f.create('y', batch.id, { memberId: 'b' });
  f.start(a, x); f.start(b, y);
  const rx = f.read(x.id).task, ry = f.read(y.id).task;
  // Both prepared against the same state, as two executors submitting at once; the Hub serializes the transactions.
  f.send(a, { action: 'task.submit', taskId: x.id, expectedRevision: rx.revision, assignmentId: rx.currentAssignmentId!, summary: 's', commitSha: 'aaaaaaa' }, 'sx');
  f.send(b, { action: 'task.submit', taskId: y.id, expectedRevision: ry.revision, assignmentId: ry.currentAssignmentId!, summary: 's', commitSha: 'bbbbbbb' }, 'sy');
  assert.equal(f.completeNotices().length, 1);
  const again = f.send(b, { action: 'task.submit', taskId: y.id, expectedRevision: ry.revision, assignmentId: ry.currentAssignmentId!, summary: 's', commitSha: 'bbbbbbb' }, 'sy');
  assert.equal(again.task!.status, 'review', 'the original result');
  assert.equal(f.completeNotices().length, 1);
});

test('cancelling the last missing task completes the batch; a submit after a batch cancel is an ordinary submission', (t) => {
  const f = batchFixture(t);
  const batch = f.batch();
  const x = f.create('x', batch.id, { memberId: 'a' });
  const y = f.create('y', batch.id, { memberId: 'b' });
  f.start(a, x);
  f.submit(a, x, 'aaaaaaa');
  f.act(user, y, { action: 'task.cancel', reason: 'not needed' });
  assert.equal(f.completeNotices().length, 1, 'the cancel crossed the line');
  assert.match(f.completeNotices()[0].body, /#1【x】待验收/);
  assert.doesNotMatch(f.completeNotices()[0].body, /#2/, 'a cancelled task is not listed');

  const other = f.batch('other');
  const p = f.create('p', other.id, { memberId: 'a' });
  const q = f.create('q', other.id, { memberId: 'b' });
  f.start(a, p); f.start(b, q);
  f.submit(a, p, '1111111');
  const cancelled = f.send(user, { action: 'batch.cancel', batchId: other.id, reason: 'split it up' });
  assert.equal('batchId' in f.read(p.id).task, false, 'released');
  assert.equal(f.read(p.id).task.status, 'review', 'nothing else changes');
  const cancelNotice = f.messages().find((m) => m.body.includes(`事件 ${cancelled.eventId}。`))!;
  assert.deepEqual(f.woke(cancelNotice.id), ['r'], 'the reviewer of a task now waiting as an ordinary task is woken');
  const s = f.submit(b, q, '2222222');
  const plain = f.messages().find((m) => m.collabEventId === s.eventId)!;
  assert.ok(f.woke(plain.id).includes('r'), 'an ordinary submission wakes the reviewer as before');
  assert.equal(f.completeNotices().length, 1);
  assert.equal(f.review(r, q).task!.status, 'completed', 'and it is reviewed as an ordinary task');
  assert.throws(() => f.send(user, { action: 'batch.cancel', batchId: other.id, reason: 'again' }), (e) => code(e) === 'INVALID_STATE');
});

test('a reject sends only that task back; approved dependents are voided by dependency versions; one more wake with markers', (t) => {
  const f = chain(t);
  f.start(a, f.one); f.submit(a, f.one, 'aaaaaaa');
  f.start(b, f.two); f.submit(b, f.two, 'bbbbbbb');
  f.start(c, f.three); f.submit(c, f.three, 'ccccccc');
  assert.equal(f.completeNotices().length, 1);
  // The reviewer gives a verdict per task, in any order.
  f.review(r, f.two); f.review(r, f.three);
  f.review(r, f.one, 'reject');
  assert.equal(f.read(f.one.id).task.status, 'working');
  assert.deepEqual([f.read(f.two.id).task.status, f.read(f.three.id).task.status], ['completed', 'completed'], 'nothing else is sent back');
  assert.equal(f.read(f.two.id).task.completionValid, false, 'but what was built on the rejected one is no longer valid');
  assert.equal(f.read(f.three.id).task.completionValid, false);
  const resubmitted = f.submit(a, f.one, 'aaaaaa2');
  assert.equal(f.read(f.two.id).task.completionValid, false);
  assert.equal(f.read(f.three.id).task.completionValid, false, 'the stale intermediate submission keeps its downstream invalid');
  assert.equal(f.read(f.three.id).task.dependenciesReady, false, 'a downstream task cannot build on the stale intermediate submission');
  assert.deepEqual(f.view(f.batchId).tasks.map((task: { state: string }) => task.state), ['submitted', 'missing', 'missing']);
  // two's executor hears its approved result is built on an old version and must be submitted again.
  const stale = f.messages().find((m) => m.body.includes(`事件 ${resubmitted.eventId}`) && m.mentions.includes('b'))!;
  assert.match(stale.body, /有新提交.*要在新版本上重新提交/);
  assert.deepEqual(f.woke(stale.id), ['b']);
  assert.equal(f.completeNotices().length, 1, 'not complete: two is stale');
  assert.throws(() => f.review(r, f.two), (e) => code(e) === 'STALE_SUBMISSION');
  f.resubmitApproved(b, f.two, 'bbbbbb2');
  assert.equal(f.completeNotices().length, 1, 'three is still built on two\'s old submission');
  f.resubmitApproved(c, f.three, 'cccccc2');
  const notices = f.completeNotices();
  assert.equal(notices.length, 2, 'complete again: one more wake');
  assert.deepEqual(f.woke(notices[1].id), ['r']);
  assert.match(notices[1].body, /#1【one】待验收：提交 aaaaaa2（新提交，上一轮退回）/);
  assert.match(notices[1].body, /#2【two】待验收：提交 bbbbbb2（新提交，上一轮通过）/);
  assert.match(notices[1].body, /#3【three】待验收：提交 cccccc2（新提交，上一轮通过）/);
  for (const task of [f.one, f.two, f.three]) f.review(r, task);
  assert.equal(f.view(f.batchId).allApproved, true);
});

test('when every task is approved the member reviewer gets the batch ship; individual ship is refused', (t) => {
  const f = chain(t);
  f.start(a, f.one); f.submit(a, f.one, 'aaaaaaa');
  f.start(b, f.two); f.submit(b, f.two, 'bbbbbbb');
  f.start(c, f.three); f.submit(c, f.three, 'ccccccc');
  f.review(r, f.one); f.review(r, f.two);
  const last = f.review(r, f.three);
  assert.equal(f.view(f.batchId).allApproved, true);
  assert.equal(f.messages().some((m) => /都已验收通过/.test(m.body)), false, `the reviewer runs it: no extra notice (event ${last.eventId})`);
  assert.throws(() => f.act(r, f.one, { action: 'task.merge', commitSha: 'aaaaaaa' }), (e) => code(e) === 'INVALID_STATE' && /batch/.test((e as Error).message));
  assert.equal(f.read(f.three.id).task.completionValid, true, 'valid on the in-batch versions until the batch merges');
});

test('a user-reviewed batch: the executor of the last task in dependency order is woken to ship', (t) => {
  const f = batchFixture(t);
  const batch = f.batch('by user', user);
  const one = f.create('one', batch.id, { memberId: 'a' });
  const two = f.create('two', batch.id, { memberId: 'b', dependencyIds: [one.id] });
  f.start(a, one); f.submit(a, one, 'aaaaaaa');
  f.start(b, two); f.submit(b, two, 'bbbbbbb');
  const complete = f.completeNotices();
  assert.equal(complete.length, 1);
  assert.deepEqual(complete[0].mentions, [], 'the user reads it in the chat');
  f.review(user, two);
  const last = f.review(user, one);
  const ship = f.messages().find((m) => /都已验收通过/.test(m.body))!;
  assert.match(ship.body, new RegExp(`请 name-b 用 get_batch 取批次 ship 命令并运行.*事件 ${last.eventId}。`));
  assert.deepEqual(f.woke(ship.id), ['b']);
});

test('takeover moves a task out of its batch', (t) => {
  const f = batchFixture(t);
  const batch = f.batch();
  const x = f.create('x', batch.id, { memberId: 'a' });
  f.start(a, x);
  const out = f.act(r, x, { action: 'task.takeover' });
  assert.equal('batchId' in out.task!, false);
  assert.match(f.messages().find((m) => m.collabEventId === out.eventId)!.body, /任务已移出批次 B1【chain】/);
});

test('migration: a step-5 database gets the batch table; old tasks stay outside any batch', () => {
  const path = join(tempDir(), 'batches.db');
  let store = new Store(path, new PluginHost(officialPlugins));
  store.db.exec(`DROP INDEX collaboration_tasks_batch; DROP TABLE task_batches; DROP TABLE task_cluster_permissions;
    UPDATE plugin_migrations SET version = 5 WHERE plugin_id = 'tasks';`);
  store.close();
  store = new Store(path, new PluginHost(officialPlugins));
  try {
    assert.equal((store.db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'tasks'").get() as { version: number }).version, MIGRATIONS.length);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM task_batches').get() as { n: number }).n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_cluster_permissions').get()!.n, 0);
    store.transaction(() => store.db.exec(MIGRATIONS[5]));   // running it again is harmless
  } finally { store.close(); }
});
