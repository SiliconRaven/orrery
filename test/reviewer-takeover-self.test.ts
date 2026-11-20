// Self review on a taken-over task (docs/collaboration.md「验收者接手」): it is bound to one executor by a record, and only
// the user or the user's cluster setting may create or move that binding. Every way in is tried through real MCP callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { REPO_ROOT } from '../src/main.ts';
import { shipForRunner, verifyShip } from '../src/plugins/tasks/package/hub/ship.mts';
import { startTestHub, tempDir } from './helpers.ts';

/** Five native mock members A-E on sessions s1-s5. */
async function fixture(name: string) {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const { cluster, members } = await app.hub.createCluster(name, ['A', 'B', 'C', 'D', 'E'].map((n, i) =>
    ({ harness: 'claude', sessionId: `s${i + 1}`, name: n })));
  const [a, b, c, d, e] = members;
  let serial = 0;
  const op = () => `self-${name}-${++serial}`;
  const user = { kind: 'user' as const };
  const send = (actor: unknown, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: op(), ...command } as never) as any;
  const task = (id: string) => app.store.tasks!.task(cluster.id, id)!;
  const rev = (id: string) => task(id).revision;
  const secret = () => JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  /** A tools/call from member session `session` through the Hub's real MCP endpoint; the parsed JSON, or { error }. */
  const mcp = async (session: string, tool: string, args: Record<string, unknown>) => {
    const response = await fetch(`${app.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret(), 'x-orrery-harness': 'claude', 'x-orrery-session': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { operationId: op(), ...args } } }) });
    const { result } = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    if (result.isError) return { error: result.content[0].text };
    try { return JSON.parse(result.content[0].text); } catch { return { text: result.content[0].text }; }
  };
  const act = (session: string, id: string, args: Record<string, unknown>) => mcp(session, 'task_action', { taskId: id, expectedRevision: rev(id), ...args });
  const page = (body: Record<string, unknown>) => app.api('POST', `/api/clusters/${cluster.id}/collaboration`, { operationId: op(), ...body });
  const setSelf = (on: boolean) => page({ action: 'tasks.settings', takeoverSelfReview: on });
  const detail = (id: string) => app.hub.collaboration.query(user, cluster.id, { kind: 'task', taskId: id, limit: 50 }) as any;
  const submitVia = (session: string, id: string, sha = 'abcdef0123') => act(session, id, { action: 'submit', assignmentId: task(id).currentAssignmentId ?? undefined,
    summary: 'done', commitSha: sha });
  const noticeOf = (eventId: number) => app.store.listMessages(cluster.id, 500).find((m) => m.kind === 'system' && m.collabEventId === eventId);
  return { app, cluster, a, b, c, d, e, user, send, task, rev, mcp, act, page, setSelf, detail, submitVia, noticeOf, secret };
}

const refusedSelf = (result: any, what: string) => {
  assert.ok(result.error, `${what}: refused`);
  assert.match(result.error, /FORBIDDEN/, what);
};

test('bypass (a): explicit user/member reviewer on takeover is refused 400; only the user may re-enable self after switching away', async () => {
  const f = await fixture('creator');
  const { app, a, c } = f;
  try {
    const created = await f.mcp('s2', 'create_task', { title: 'creator', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } });
    const id = created.task.id;
    // Member takeover requires review or submitted working state; user may take over from pending, or submit first.
    await f.act('s1', id, { action: 'start' });
    await f.submitVia('s1', id, 'abcdef0100');
    const badUser = await f.act('s3', id, { action: 'takeover', reviewer: { kind: 'user' } });
    assert.match(badUser.error, /INVALID_REQUEST/);
    const badMember = await f.act('s3', id, { action: 'takeover', reviewer: { kind: 'member', memberId: f.b.id } });
    assert.match(badMember.error, /INVALID_REQUEST/);

    const taken = await f.act('s3', id, { action: 'takeover' });
    assert.equal(taken.takeover.basis, 'reviewer');
    assert.deepEqual(taken.task.reviewer, { kind: 'self' });
    // Bound holder C may step reviewer up back to user; once moved away from self, creator B or C cannot move it back to self without the user.
    const steppedUp = await f.act('s3', id, { action: 'edit', reviewer: { kind: 'user' } });
    assert.deepEqual(steppedUp.task.reviewer, { kind: 'user' });
    refusedSelf(await f.act('s2', id, { action: 'edit', reviewer: { kind: 'self' } }), 'the creator\'s edit back to self');
    assert.deepEqual(f.task(id).reviewer, { kind: 'user' });
    const done = await f.submitVia('s3', id);
    assert.equal(done.task.status, 'review', 'user reviews once upgraded away from self');
  } finally { await app.close(); }
});

test('bypass (a), coordinator: coordinator cannot take over, cannot switch taken-over task to self', async () => {
  const f = await fixture('coordinator');
  const { app, a, c, d } = f;
  try {
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { recovery: true, reviewerManagement: true, cancelReopen: true, deliveryControl: true } }).coordinator;
    const id = f.send(f.user, { action: 'task.create', title: 'coord', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.act('s1', id, { action: 'start' });
    const coordTake = await f.act('s4', id, { action: 'takeover', generation: policy.generation });
    assert.match(coordTake.error, /FORBIDDEN/, 'coordinator is not the designated reviewer');
    // User takes over; if moved to user review, coordinator still cannot switch it back to self.
    await f.page({ action: 'task.takeover', taskId: id, expectedRevision: f.rev(id) });
    await f.page({ action: 'task.edit', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'user' } });
    refusedSelf(await f.act('s4', id, { action: 'edit', reviewer: { kind: 'self' }, generation: policy.generation }), 'the coordinator\'s edit back to self');
    const submitted = await f.submitVia('s3', id);
    assert.equal(submitted.task.status, 'review', 'no self approval');
  } finally { await app.close(); }
});

test('bypass (b): self review the user authorised for C does not travel with a hand-off to E', async () => {
  const f = await fixture('handoff');
  const { app, a, c, e } = f;
  try {
    const id = f.send(f.user, { action: 'task.create', title: 'handoff', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.act('s1', id, { action: 'start' });
    const taken = await f.page({ action: 'task.takeover', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'self' } });
    assert.equal(taken.takeover.basis, 'user');
    const handed = await f.act('s3', id, { action: 'handoff', assignmentId: f.task(id).currentAssignmentId, memberId: e.id, reason: 'over to E' });
    refusedSelf(handed, 'C hands the self-reviewed task to E');
    assert.equal(f.task(id).assignedMemberId, c.id);
    // Assign and claim reach the same rule once the task is free again.
    await f.act('s3', id, { action: 'release', assignmentId: f.task(id).currentAssignmentId, reason: 'stop' });
    refusedSelf(await f.act('s5', id, { action: 'claim' }), 'E claims it');
    refusedSelf(await f.act('s5', id, { action: 'assign', memberId: e.id }), 'E assigns it to itself');
    // C can take it back: the binding is C's.
    assert.equal((await f.act('s3', id, { action: 'assign', memberId: c.id })).task.assignedMemberId, c.id);
  } finally { await app.close(); }
});

test('authorised moves of self review: the user on the page, or the setting; each writes a record and a warning, and ship names the bound executor', async () => {
  const f = await fixture('authorised');
  const { app, a, b, c, e } = f;
  try {
    const id = f.send(f.user, { action: 'task.create', title: 'moved', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.act('s1', id, { action: 'start' });
    await f.page({ action: 'task.takeover', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'self' } });
    // The user hands it from C to E: self review stays, now bound to E.
    const handed = await f.page({ action: 'task.handoff', taskId: id, expectedRevision: f.rev(id), assignmentId: f.task(id).currentAssignmentId,
      memberId: e.id, reason: 'E finishes', confirmStopped: true });
    assert.equal(handed.takeover.toMemberId, e.id);
    assert.equal(handed.takeover.basis, 'user');
    assert.equal(handed.takeover.action, 'task.handoff');
    assert.equal(f.noticeOf(handed.eventId)!.systemKind, 'review_downgraded');
    assert.match(f.noticeOf(handed.eventId)!.body, /自查授权给 E（依据：用户本人操作）。此后不再有独立验收。/);
    assert.equal(f.task(id).takeover!.memberId, e.id, 'the mark follows the record');
    // C, no longer bound, could not submit even if it held the task; E can.
    await f.act('s5', id, { action: 'start' });
    const done = await f.submitVia('s5', id, 'abcdef0777');
    assert.equal(done.task.status, 'completed');
    assert.equal(done.review.takeover, true);
    const ship = shipForRunner(app.hub, f.secret(), app.url, f.cluster.id, id, e.id) as any;
    const verified = verifyShip(app.hub, f.secret(), /--ticket (\S+)/.exec(ship.ship.command)![1]);
    assert.deepEqual([verified.reviewer, verified.verdict, verified.takeover], ['E', 'self', true]);

    // Reopen preserves the bound holder; the user or holder stepping up to user/member unlocks handoff.
    const t2 = f.send(f.user, { action: 'task.create', title: 'stepup', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: t2, expectedRevision: f.rev(t2), reviewer: { kind: 'self' } });
    // After C edits reviewer to user, self-review binding clears and C can hand off to B (user still reviews).
    await f.act('s3', t2, { action: 'edit', reviewer: { kind: 'user' } });
    const handedOff = await f.act('s3', t2, { action: 'handoff', memberId: b.id, reason: 'C steps up reviewer first' });
    assert.equal(handedOff.task.assignedMemberId, b.id);
    assert.deepEqual(handedOff.task.reviewer, { kind: 'user' });

    // An edit to self on a taken-over task by the user binds it to the current executor.
    const t3 = f.send(f.user, { action: 'task.create', title: 'edit', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: t3, expectedRevision: f.rev(t3) });
    await f.page({ action: 'task.edit', taskId: t3, expectedRevision: f.rev(t3), reviewer: { kind: 'user' } });
    const edited = await f.page({ action: 'task.edit', taskId: t3, expectedRevision: f.rev(t3), reviewer: { kind: 'self' } });
    assert.equal(edited.takeover.action, 'task.edit');
    assert.equal(edited.takeover.toMemberId, c.id);
    assert.equal(f.noticeOf(edited.eventId)!.systemKind, 'review_downgraded');
    assert.deepEqual(f.detail(t3).takeovers.map((r: any) => [r.action, r.basis, r.toMemberId]), [['task.takeover', 'user', c.id], ['task.edit', 'user', c.id], ['task.edit', 'user', c.id]]);
  } finally { await app.close(); }
});

test('reopen after a self-reviewed finish keeps the bound holder assigned and blocks third-party claims', async () => {
  const f = await fixture('reopen');
  const { app, a, c, e } = f;
  try {
    const id = f.send(f.user, { action: 'task.create', title: 'reopen', scope: 's', acceptance: 'a', memberId: a.id, mergeRequired: false,
      reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'self' } });
    await f.act('s3', id, { action: 'start' });
    assert.equal((await f.submitVia('s3', id)).task.status, 'completed');
    const reopened = await f.page({ action: 'task.reopen', taskId: id, expectedRevision: f.rev(id), reason: 'again' });
    assert.equal(reopened.task.assignedMemberId, c.id, 'bound holder stays assigned across reopen');
    assert.equal(e && (await f.act('s5', id, { action: 'claim' })).error?.includes('FORBIDDEN'), true, 'E cannot claim');
    assert.equal((await f.act('s3', id, { action: 'start' })).task.assignedMemberId, c.id, 'C, still bound, restarts directly');
  } finally { await app.close(); }
});

test('the coordinator cannot be named as the next reviewer; explicit reviewer on takeover is rejected; edits on taken-over task reject coordinator', async () => {
  const f = await fixture('coordinator-reviewer');
  const { app, a, c, d } = f;
  try {
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute' }).coordinator;
    const id = f.send(f.user, { action: 'task.create', title: 'x', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    const named = await f.act('s3', id, { action: 'takeover', reviewer: { kind: 'member', memberId: d.id } });
    assert.match(named.error, /INVALID_REQUEST/);
    await f.page({ action: 'task.takeover', taskId: id, expectedRevision: f.rev(id) });
    await assert.rejects(f.page({ action: 'task.edit', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'member', memberId: d.id } }),
      /coordinator and cannot review/, 'not by an edit on a taken-over task either');
    assert.ok(policy);
  } finally { await app.close(); }
});

test('a second takeover by user after upgrading reviewer supersedes the prior takeover notice', async () => {
  const f = await fixture('withdraw');
  const { app, a, b, c } = f;
  try {
    const id = f.send(f.user, { action: 'task.create', title: 'w', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: b.id } }).task.id;
    app.hub.setPaused(true);
    const first = f.send(f.user, { action: 'task.takeover', taskId: id, expectedRevision: f.rev(id) });
    const notice = f.noticeOf(first.eventId)!;
    const toB = () => app.store.withDeliveries([app.store.getMessage(notice.id)!])[0].deliveries.find((x) => x.memberId === b.id)!;
    assert.equal(toB().state, 'queued');
    // Assign back away and name C as reviewer, then takeover to C: old wake-up to B is superseded.
    f.send(f.user, { action: 'task.edit', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'member', memberId: c.id } });
    f.send(f.user, { action: 'task.takeover', taskId: id, expectedRevision: f.rev(id) });
    assert.equal(toB().state, 'superseded', 'B no longer executes, so the old wake-up is withdrawn');
    app.hub.setPaused(false);
  } finally { await app.close(); }
});

test('boundary: reviewer self is only written through the takeover rule on taken-over tasks, and submit checks the binding', () => {
  const dir = join(REPO_ROOT, 'src/plugins/tasks/package/hub');
  const source = readFileSync(join(dir, 'actions.mts'), 'utf8');
  // Command reference copies do not change a task. Batch joins copy a user/member reviewer only;
  // task-batches.test.ts verifies that batches reject self review. Other changes use setReviewer.
  const writers = readdirSync(dir).filter((name) => name.endsWith('.mts'))
    .flatMap((name) => [...readFileSync(join(dir, name), 'utf8').matchAll(/(\w+)!?\.reviewer\s*=[^=]/g)].map((m) => `${name}:${m[1]}`))
    .filter((writer) => !['actions.mts:out', 'batches.mts:out'].includes(writer)).sort();
  assert.deepEqual(writers, ['actions.mts:task', 'actions.mts:task', 'batches.mts:task'],
    'only setReviewer and the two restricted batch joins write task reviewers');
  assert.match(source, /const setReviewer = /);
  assert.match(source, /\/\/ SELF-BINDING CHECK[\s\S]{0,400}selfReviewBound\(/, 'submit checks the binding before writing a self review');
  // Executor changes of a taken-over self-reviewed task go through the rule.
  assert.match(source, /const checkExecutor = [\s\S]{0,1200}rebindSelf\(/);
});

test('sequences: reviewer takeover directly binds self; self→user→self; cancel and reopen; nominate; a second takeover', async () => {
  const f = await fixture('sequences');
  const { app, a, c, d, e } = f;
  try {
    // Reviewer takes over directly once a submission exists: bound to C with basis reviewer.
    const t1 = f.send(f.user, { action: 'task.create', title: 'on-off', scope: 's', acceptance: 'a', memberId: a.id, mergeRequired: false,
      reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.act('s1', t1, { action: 'start' });
    await f.submitVia('s1', t1, 'abcdef0101');
    const taken1 = await f.act('s3', t1, { action: 'takeover' });
    assert.equal(taken1.takeover.basis, 'reviewer');
    assert.equal((await f.submitVia('s3', t1)).review.takeover, true);

    // The coordinator may move a self-reviewed task back to user review (an upgrade), but not to self again.
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { recovery: true, reviewerManagement: true, cancelReopen: true } }).coordinator;
    const t2 = f.send(f.user, { action: 'task.create', title: 'updown', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: t2, expectedRevision: f.rev(t2), reviewer: { kind: 'self' } });
    assert.deepEqual((await f.act('s4', t2, { action: 'edit', reviewer: { kind: 'user' }, generation: policy.generation })).task.reviewer, { kind: 'user' });
    refusedSelf(await f.act('s4', t2, { action: 'edit', reviewer: { kind: 'self' }, generation: policy.generation }), 'back to self');

    // Cancel and reopen: bound C stays assigned; coordinator cannot hand or assign to E.
    const t3 = f.send(f.user, { action: 'task.create', title: 'cancel', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: t3, expectedRevision: f.rev(t3), reviewer: { kind: 'self' } });
    await f.act('s4', t3, { action: 'cancel', reason: 'x', generation: policy.generation });
    await f.page({ action: 'task.reopen', taskId: t3, expectedRevision: f.rev(t3), reason: 'y' });
    refusedSelf(await f.act('s4', t3, { action: 'assign', memberId: e.id, generation: policy.generation }), 'the coordinator assigns E');
    refusedSelf(await f.act('s4', t3, { action: 'nominate', memberId: e.id, generation: policy.generation }), 'nominate is the same rule');
    // A second takeover is not possible on a self-reviewed task: it has no member reviewer.
    assert.match((await f.act('s3', t3, { action: 'takeover' })).error, /INVALID_STATE/);
    // Removing the bound member leaves nobody able to self-approve until the user assigns someone.
    app.hub.removeMember(f.cluster.id, c.id);
    const byUser = await f.page({ action: 'task.assign', taskId: t3, expectedRevision: f.rev(t3), memberId: e.id });
    assert.equal(byUser.takeover.toMemberId, e.id);
    assert.equal(byUser.takeover.basis, 'user');
  } finally { await app.close(); }
});

test('ship refuses a self review on a taken-over task that the rule did not bind', async () => {
  const f = await fixture('ship-guard');
  const { app, a, c } = f;
  try {
    const id = f.send(f.user, { action: 'task.create', title: 'g', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'self' } });
    await f.act('s3', id, { action: 'start' });
    const done = await f.submitVia('s3', id);
    const ticket = () => /--ticket (\S+)/.exec((shipForRunner(app.hub, f.secret(), app.url, f.cluster.id, id, c.id) as any).ship.command)![1];
    assert.equal(verifyShip(app.hub, f.secret(), ticket()).takeover, true);
    // Strip the binding from the stored review (as if it had been written another way): ship refuses it.
    app.store.db.prepare("UPDATE collaboration_records SET data_json = json_remove(data_json, '$.takeover') WHERE id = ?").run(done.review.id);
    assert.throws(() => verifyShip(app.hub, f.secret(), ticket()), /not authorised for its executor/);
  } finally { await app.close(); }
});
