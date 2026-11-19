// Self review on a taken-over task (docs/collaboration.md「验收者接手」): it is bound to one executor by a record, and only
// the user or the user's cluster setting may create or move that binding. Every way in is tried through real MCP callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { REPO_ROOT } from '../src/main.ts';
import { shipForRunner, verifyShip } from '../src/plugins/tasks/ship.ts';
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
  assert.match(result.error, /允许验收者接手后自检/, `${what}: says how to get authorisation`);
};

test('bypass (a), creator: a default takeover, then the creator edits the reviewer to self; refused without the user', async () => {
  const f = await fixture('creator');
  const { app, a, c } = f;
  try {
    // B creates the task (executor A, reviewer C) and is its creator; C takes it over with the default (user review).
    const created = await f.mcp('s2', 'create_task', { title: 'creator', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } });
    const id = created.task.id;
    assert.equal((await f.act('s3', id, { action: 'takeover', reviewer: { kind: 'self' } })).error?.includes('FORBIDDEN'), true, 'self directly is refused');
    const taken = await f.act('s3', id, { action: 'takeover' });
    assert.equal(taken.takeover.basis, 'user_review');
    refusedSelf(await f.act('s2', id, { action: 'edit', reviewer: { kind: 'self' } }), 'the creator\'s edit to self');
    assert.deepEqual(f.task(id).reviewer, { kind: 'user' });
    // C works and submits: the user reviews, nothing self-approved.
    await f.act('s3', id, { action: 'start' });
    const submitted = await f.submitVia('s3', id);
    assert.equal(submitted.task.status, 'review');
  } finally { await app.close(); }
});

test('bypass (a), coordinator: a default takeover of a working task, then the coordinator edits to self; refused', async () => {
  const f = await fixture('coordinator');
  const { app, a, c, d } = f;
  try {
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { recovery: true, reviewerManagement: true, cancelReopen: true, deliveryControl: true } }).coordinator;
    const id = f.send(f.user, { action: 'task.create', title: 'coord', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.act('s1', id, { action: 'start' });
    const taken = await f.act('s4', id, { action: 'takeover', generation: policy.generation });
    assert.equal(taken.task.status, 'working');
    refusedSelf(await f.act('s4', id, { action: 'edit', reviewer: { kind: 'self' }, generation: policy.generation }), 'the coordinator\'s edit to self');
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

    // With the setting on, a member may move it; with it off again, not.
    const t2 = f.send(f.user, { action: 'task.create', title: 'setting', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.setSelf(true);
    await f.act('s3', t2, { action: 'takeover', reviewer: { kind: 'self' } });
    const assigned = await f.act('s3', t2, { action: 'handoff', memberId: b.id, reason: 'over to B' });
    assert.equal(assigned.takeover.basis, 'cluster_setting');
    assert.equal(assigned.takeover.toMemberId, b.id);
    await f.setSelf(false);
    refusedSelf(await f.act('s2', t2, { action: 'handoff', memberId: e.id, reason: 'over to E' }), 'setting off again');
    // An edit to self on a taken-over task by the user binds it to the current executor.
    const t3 = f.send(f.user, { action: 'task.create', title: 'edit', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.act('s3', t3, { action: 'takeover' });
    const edited = await f.page({ action: 'task.edit', taskId: t3, expectedRevision: f.rev(t3), reviewer: { kind: 'self' } });
    assert.equal(edited.takeover.action, 'task.edit');
    assert.equal(edited.takeover.toMemberId, c.id);
    assert.equal(f.noticeOf(edited.eventId)!.systemKind, 'review_downgraded');
    assert.deepEqual(f.detail(t3).takeovers.map((r: any) => [r.action, r.basis, r.toMemberId]), [['task.takeover', 'user_review', c.id], ['task.edit', 'user', c.id]]);
  } finally { await app.close(); }
});

test('reopen after a self-reviewed finish: a new executor needs a new authorisation; the bound one does not', async () => {
  const f = await fixture('reopen');
  const { app, a, c, e } = f;
  try {
    const id = f.send(f.user, { action: 'task.create', title: 'reopen', scope: 's', acceptance: 'a', memberId: a.id, mergeRequired: false,
      reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'self' } });
    await f.act('s3', id, { action: 'start' });
    assert.equal((await f.submitVia('s3', id)).task.status, 'completed');
    await f.page({ action: 'task.reopen', taskId: id, expectedRevision: f.rev(id), reason: 'again' });
    refusedSelf(await f.act('s5', id, { action: 'claim' }), 'E claims the reopened task');
    assert.ok(e);
    assert.equal((await f.act('s3', id, { action: 'claim' })).task.assignedMemberId, c.id, 'C, still bound, picks it up again');
  } finally { await app.close(); }
});

test('the coordinator cannot be named as the next reviewer; the page leaves it out; edits on a taken-over task neither', async () => {
  const f = await fixture('coordinator-reviewer');
  const { app, a, c, d } = f;
  try {
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute' }).coordinator;
    const id = f.send(f.user, { action: 'task.create', title: 'x', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    const named = await f.act('s3', id, { action: 'takeover', reviewer: { kind: 'member', memberId: d.id } });
    assert.match(named.error, /FORBIDDEN/);
    assert.match(named.error, /coordinator and cannot review/);
    await f.act('s3', id, { action: 'takeover' });
    await assert.rejects(f.page({ action: 'task.edit', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'member', memberId: d.id } }),
      /coordinator and cannot review/, 'not by an edit on a taken-over task either');
    assert.ok(policy);
  } finally { await app.close(); }
});

test('a second takeover withdraws the first takeover\'s queued wake-up to the member who no longer executes', async () => {
  const f = await fixture('withdraw');
  const { app, a, b, c } = f;
  try {
    const id = f.send(f.user, { action: 'task.create', title: 'w', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: b.id } }).task.id;
    app.hub.setPaused(true);
    const first = f.send({ kind: 'member', memberId: a.id }, { action: 'task.takeover', taskId: id, expectedRevision: f.rev(id), reviewer: { kind: 'member', memberId: c.id } });
    const notice = f.noticeOf(first.eventId)!;
    const toB = () => app.store.withDeliveries([app.store.getMessage(notice.id)!])[0].deliveries.find((x) => x.memberId === b.id)!;
    assert.equal(toB().state, 'queued');
    f.send({ kind: 'member', memberId: c.id }, { action: 'task.takeover', taskId: id, expectedRevision: f.rev(id) });
    assert.equal(toB().state, 'superseded', 'B no longer executes, so the old wake-up is withdrawn');
    app.hub.setPaused(false);
  } finally { await app.close(); }
});

test('boundary: reviewer self is only written through the takeover rule on taken-over tasks, and submit checks the binding', () => {
  const dir = join(REPO_ROOT, 'src/plugins/tasks');
  const source = readFileSync(join(dir, 'actions.ts'), 'utf8');
  // Command reference copies do not change a task. Batch joins copy a user/member reviewer only;
  // task-batches.test.ts verifies that batches reject self review. Other changes use setReviewer.
  const writers = readdirSync(dir).filter((name) => name.endsWith('.ts'))
    .flatMap((name) => [...readFileSync(join(dir, name), 'utf8').matchAll(/(\w+)!?\.reviewer\s*=[^=]/g)].map((m) => `${name}:${m[1]}`))
    .filter((writer) => !['actions.ts:out', 'batches.ts:out'].includes(writer)).sort();
  assert.deepEqual(writers, ['actions.ts:task', 'actions.ts:task', 'batches.ts:task'],
    'only setReviewer and the two restricted batch joins write task reviewers');
  assert.match(source, /const setReviewer = /);
  assert.match(source, /\/\/ SELF-BINDING CHECK[\s\S]{0,400}selfReviewBound\(/, 'submit checks the binding before writing a self review');
  // Executor changes of a taken-over self-reviewed task go through the rule.
  assert.match(source, /const checkExecutor = [\s\S]{0,1200}rebindSelf\(/);
});

test('sequences: setting on, takeover, setting off; self→user→self; cancel and reopen; nominate; a second takeover', async () => {
  const f = await fixture('sequences');
  const { app, a, c, d, e } = f;
  try {
    // The binding made while the setting was on stays C's after it is turned off: C was authorised at that moment.
    await f.setSelf(true);
    const t1 = f.send(f.user, { action: 'task.create', title: 'on-off', scope: 's', acceptance: 'a', memberId: a.id, mergeRequired: false,
      reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.act('s3', t1, { action: 'takeover', reviewer: { kind: 'self' } });
    await f.setSelf(false);
    await f.act('s3', t1, { action: 'start' });
    assert.equal((await f.submitVia('s3', t1)).review.takeover, true);

    // The coordinator may move a self-reviewed task back to user review (an upgrade), but not to self again.
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { recovery: true, reviewerManagement: true, cancelReopen: true } }).coordinator;
    const t2 = f.send(f.user, { action: 'task.create', title: 'updown', scope: 's', acceptance: 'a', memberId: a.id, reviewer: { kind: 'member', memberId: c.id } }).task.id;
    await f.page({ action: 'task.takeover', taskId: t2, expectedRevision: f.rev(t2), reviewer: { kind: 'self' } });
    assert.deepEqual((await f.act('s4', t2, { action: 'edit', reviewer: { kind: 'user' }, generation: policy.generation })).task.reviewer, { kind: 'user' });
    refusedSelf(await f.act('s4', t2, { action: 'edit', reviewer: { kind: 'self' }, generation: policy.generation }), 'back to self');

    // Cancel and reopen: the executor is cleared; only the bound C may pick it up, the coordinator cannot hand it to E.
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
