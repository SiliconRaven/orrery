// Reviewer takeover (docs/collaboration.md「验收者接手」): a task's member reviewer becomes its executor, and the caller says
// who reviews afterwards. Self review then needs the user's own action or the user's cluster setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMessage } from '../scripts/ship.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { shipForRunner, verifyShip } from '../src/plugins/tasks/ship.ts';
import { MIGRATIONS } from '../src/plugins/tasks/store.ts';
import { startTestHub, tempDir } from './helpers.ts';

/** Five native mock members A-E on sessions s1-s5. B executes and C reviews in the helpers below. */
async function fixture(name: string) {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const { cluster, members } = await app.hub.createCluster(name, ['A', 'B', 'C', 'D', 'E'].map((n, i) =>
    ({ harness: 'claude', mode: 'native' as const, sessionId: `s${i + 1}`, name: n })));
  const [a, b, c, d, e] = members;
  let serial = 0;
  const op = () => `takeover-${name}-${++serial}`;
  const send = (actor: unknown, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: op(), ...command } as never) as any;
  const user = { kind: 'user' as const };
  const as = (member: { id: string }) => ({ kind: 'member' as const, memberId: member.id });
  const task = (id: string) => app.store.tasks!.task(cluster.id, id)!;
  const rev = (id: string) => task(id).revision;
  const create = (extra: Record<string, unknown> = {}) => send(user, { action: 'task.create', title: 't', scope: 's', acceptance: 'a',
    memberId: b.id, reviewer: { kind: 'member', memberId: c.id }, ...extra }).task;
  const start = (id: string, who = b) => send(as(who), { action: 'task.start', taskId: id, expectedRevision: rev(id) });
  const submit = (id: string, who = b, sha = 'abcdef0123') => send(as(who), { action: 'task.submit', taskId: id, expectedRevision: rev(id),
    assignmentId: task(id).currentAssignmentId, summary: `done by ${who.name}`, commitSha: sha });
  const review = (id: string, actor: unknown, verdict: 'approve' | 'reject') => send(actor, { action: 'task.review', taskId: id,
    expectedRevision: rev(id), submissionId: task(id).latestSubmissionId, verdict, reason: verdict });
  const takeover = (actor: unknown, id: string, extra: Record<string, unknown> = {}) =>
    send(actor, { action: 'task.takeover', taskId: id, expectedRevision: rev(id), ...extra });
  const setSelf = (on: boolean) => app.api('POST', `/api/clusters/${cluster.id}/collaboration`, { action: 'tasks.settings', operationId: op(), takeoverSelfReview: on });
  const detail = (id: string) => app.hub.collaboration.query(user, cluster.id, { kind: 'task', taskId: id, limit: 50 }) as any;
  const noticeOf = (eventId: number) => app.store.listMessages(cluster.id, 500).find((m) => m.kind === 'system' && m.collabEventId === eventId);
  const woken = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries.map((x) => x.memberId).sort();
  /** A tools/call from member session `session` through the Hub's real MCP endpoint; the parsed JSON, or the error text. */
  const mcp = async (session: string, tool: string, args: Record<string, unknown>) => {
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const response = await fetch(`${app.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-harness': 'claude', 'x-orrery-session': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { operationId: op(), ...args } } }) });
    const { result } = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    if (result.isError) return { error: result.content[0].text };
    try { return JSON.parse(result.content[0].text); } catch { return { text: result.content[0].text }; }
  };
  const secret = () => JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  return { app, cluster, a, b, c, d, e, send, user, as, task, rev, create, start, submit, review, takeover, setSelf, detail, noticeOf, woken, mcp, secret };
}

const code = (expected: string, text?: RegExp) => (error: any) => {
  assert.equal(error.code, expected, error.message);
  if (text) assert.match(error.message, text);
  return true;
};

test('every status: pending (with or without an executor, also after a failed ship), working and review move; the rest are refused', async () => {
  const f = await fixture('status');
  const { app, b, c, as } = f;
  try {
    // pending with an executor who has not started: the reviewer becomes the executor and starts it like any assignee.
    const pending = f.create();
    const moved = f.takeover(as(b), pending.id);
    assert.equal(moved.task.status, 'pending');
    assert.equal(moved.task.assignedMemberId, c.id);
    assert.deepEqual(moved.task.reviewer, { kind: 'user' }, 'user review when the caller names none');
    assert.equal(moved.assignment, undefined, 'no assignment until the new executor starts');
    assert.equal(f.start(pending.id, c).task.status, 'working');

    // pending without an executor: the reviewer takes it.
    const open = f.create({ memberId: null });
    assert.equal(f.takeover(as(c), open.id).task.assignedMemberId, c.id);

    // working: the executor's assignment ends; the reviewer gets a started one.
    const working = f.create();
    f.start(working.id);
    const before = f.task(working.id).currentAssignmentId;
    const taken = f.takeover(as(c), working.id);
    assert.equal(taken.task.status, 'working');
    assert.equal(taken.assignment.memberId, c.id);
    assert.ok(taken.assignment.startedAt);
    const assignments = f.detail(working.id).assignments;
    assert.equal(assignments.find((x: any) => x.id === before).endReason, 'reviewer takeover');
    assert.ok(assignments.find((x: any) => x.id === before).endedAt);
    assert.throws(() => f.submit(working.id, b), code('STALE_ASSIGNMENT'), 'the old executor cannot submit any more');

    // review: the waiting result is superseded and the task goes back to working.
    const inReview = f.create();
    f.start(inReview.id);
    const submitted = f.submit(inReview.id);
    const fromReview = f.takeover(f.user, inReview.id);
    assert.equal(fromReview.task.status, 'working');
    assert.equal(fromReview.task.latestSubmissionId, null);
    const view = f.detail(inReview.id);
    assert.deepEqual(view.submissions.map((s: any) => [s.id, s.superseded]), [[submitted.submission.id, true]], 'kept, marked superseded');
    assert.throws(() => f.send(as(c), { action: 'task.review', taskId: inReview.id, expectedRevision: f.rev(inReview.id),
      submissionId: submitted.submission.id, verdict: 'approve', reason: 'x' }), code('STALE_SUBMISSION'));

    // after a failed ship the task is pending with its executor: it can be taken over.
    const shipped = f.create();
    f.start(shipped.id);
    f.submit(shipped.id);
    const approved = f.review(shipped.id, as(c), 'approve');
    assert.throws(() => f.takeover(as(c), shipped.id), code('INVALID_STATE', /already approved/), 'approved, awaiting its merge');
    f.send({ kind: 'system' }, { action: 'task.ship_failed', taskId: shipped.id, expectedRevision: f.rev(shipped.id),
      submissionId: approved.task.approvedSubmissionId, reason: 'conflict: x' });
    assert.equal(f.task(shipped.id).status, 'pending');
    // C approved it, so C cannot now take it over and still be an independent reviewer: but takeover makes C the executor.
    // The reviewer field still names C, so the takeover is allowed; the review moves to the user.
    assert.equal(f.takeover(as(b), shipped.id).task.assignedMemberId, c.id);

    // merged, cancelled, awaiting approval, and tasks without a member reviewer are refused.
    const merged = f.create({ mergeRequired: false });
    f.send(f.user, { action: 'task.mark_merged', taskId: merged.id, expectedRevision: f.rev(merged.id) });
    assert.throws(() => f.takeover(as(c), merged.id), code('INVALID_STATE', /closed/));
    const cancelled = f.create();
    f.send(f.user, { action: 'task.cancel', taskId: cancelled.id, expectedRevision: f.rev(cancelled.id), reason: 'no' });
    assert.throws(() => f.takeover(as(c), cancelled.id), code('INVALID_STATE', /closed/));
    const proposed = f.create({ requiresApproval: true, memberId: null });
    assert.throws(() => f.takeover(as(c), proposed.id), code('APPROVAL_REQUIRED'));
    f.send(f.user, { action: 'task.approve', taskId: proposed.id, expectedRevision: f.rev(proposed.id), verdict: 'approve' });
    assert.equal(f.takeover(as(c), proposed.id).task.assignedMemberId, c.id, 'once approved it can be taken over');
    for (const reviewer of [{ kind: 'user' }, { kind: 'self' }]) {
      const other = f.create({ reviewer });
      assert.throws(() => f.takeover(f.user, other.id), code('INVALID_STATE', /reviewed by a member/));
    }
    assert.ok(app.store.listMessages(f.cluster.id, 500).length > 0);
  } finally { await app.close(); }
});

test('who may start it: the executor, the reviewer, the user and the coordinator with recovery and reviewerManagement; nobody else', async () => {
  const f = await fixture('actors');
  const { app, a, b, c, d, e, as } = f;
  try {
    const t1 = f.create();
    assert.throws(() => f.takeover(as(a), t1.id), code('FORBIDDEN', /executor, its reviewer, the user or the coordinator/), 'an unrelated member');
    f.send(f.user, { action: 'member.hidden', memberId: e.id, hidden: true });
    assert.throws(() => f.takeover(as(e), t1.id), code('HIDDEN'), 'a hidden member acts on nothing');
    f.send(f.user, { action: 'member.hidden', memberId: e.id, hidden: false });

    // The coordinator: allowed with both permissions, under the member's rules (user review by default).
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { taskPlanning: true, assignment: true, roleManagement: true, reviewerManagement: true, knowledgeCommunication: true,
        recovery: true, cancelReopen: true, deliveryControl: true } }).coordinator;
    const byCoordinator = f.takeover(as(d), t1.id, { generation: policy.generation });
    assert.equal(byCoordinator.task.assignedMemberId, c.id);
    assert.equal(byCoordinator.takeover.basis, 'user_review');
    assert.equal(byCoordinator.takeover.by, d.id);
    const t2 = f.create();
    assert.throws(() => f.takeover(as(d), t2.id), code('STALE_POLICY'), 'the coordinator passes its generation');
    assert.throws(() => f.takeover(as(d), t2.id, { generation: policy.generation, reviewer: { kind: 'self' } }), code('FORBIDDEN', /允许验收者接手后自检/),
      'no extra powers: self review needs the user');
    const narrow = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { recovery: false } }).coordinator;
    assert.throws(() => f.takeover(as(d), t2.id, { generation: narrow.generation }), code('FORBIDDEN', /recovery/));
    // Suggest mode records a suggestion and changes nothing.
    const suggest = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'suggest' }).coordinator;
    const suggested = f.takeover(as(d), t2.id, { generation: suggest.generation });
    assert.ok(suggested.suggestion);
    assert.equal(f.task(t2.id).assignedMemberId, b.id);
    assert.equal(f.detail(t2.id).takeovers.length, 0);
    f.send(f.user, { action: 'coordinator.set', memberId: null });

    // The executor hands over; the reviewer takes; the user does it on the page (HTTP).
    const t3 = f.create();
    assert.equal(f.takeover(as(b), t3.id).takeover.by, b.id);
    const t4 = f.create();
    assert.equal(f.takeover(as(c), t4.id).takeover.by, c.id);
    const t5 = f.create();
    const viaPage = await app.api('POST', `/api/clusters/${f.cluster.id}/collaboration`, { action: 'task.takeover', operationId: 'page-1',
      taskId: t5.id, expectedRevision: t5.revision });
    assert.equal(viaPage.takeover.by, 'user');
    assert.equal(viaPage.takeover.basis, 'user');
  } finally { await app.close(); }
});

test('the review mode after it: user by default, a member who never worked on it, or self only with the user\'s authorisation', async () => {
  const f = await fixture('modes');
  const { app, a, b, c, d, e, as } = f;
  try {
    // A member: not the one taking over, not the old executor, nobody in the contributor history, holding the review roles.
    const role = f.send(f.user, { action: 'role.create', name: 'reviewers' }).role;
    const t1 = f.create({ memberId: a.id });
    f.start(t1.id, a);
    f.send(as(a), { action: 'task.handoff', taskId: t1.id, expectedRevision: f.rev(t1.id), assignmentId: f.task(t1.id).currentAssignmentId,
      memberId: b.id, reason: 'over to B' });
    f.start(t1.id, b);
    assert.throws(() => f.takeover(as(c), t1.id, { reviewer: { kind: 'member', memberId: c.id } }), code('REVIEW_NOT_INDEPENDENT', /taking the task over/));
    assert.throws(() => f.takeover(as(c), t1.id, { reviewer: { kind: 'member', memberId: b.id } }), code('REVIEW_NOT_INDEPENDENT', /worked on this task/));
    assert.throws(() => f.takeover(as(c), t1.id, { reviewer: { kind: 'member', memberId: a.id } }), code('REVIEW_NOT_INDEPENDENT', /worked on this task/), 'an earlier executor');
    f.send(f.user, { action: 'member.roles', memberId: c.id, roleIds: [role.id] });
    f.send(f.user, { action: 'task.edit', taskId: t1.id, expectedRevision: f.rev(t1.id), reviewRoleIds: [role.id] });
    assert.throws(() => f.takeover(as(c), t1.id, { reviewer: { kind: 'member', memberId: d.id } }), code('ROLE_REQUIRED'));
    f.send(f.user, { action: 'member.roles', memberId: d.id, roleIds: [role.id] });
    f.send(f.user, { action: 'member.hidden', memberId: e.id, hidden: true });
    f.send(f.user, { action: 'member.roles', memberId: e.id, roleIds: [role.id] });
    assert.throws(() => f.takeover(as(c), t1.id, { reviewer: { kind: 'member', memberId: e.id } }), code('OUT_OF_SCOPE'), 'a hidden member, to a member');
    assert.throws(() => f.takeover(f.user, t1.id, { reviewer: { kind: 'member', memberId: e.id } }), code('FORBIDDEN', /hidden/), 'the user is told why');
    const named = f.takeover(as(c), t1.id, { reviewer: { kind: 'member', memberId: 'D' } });
    assert.deepEqual(named.task.reviewer, { kind: 'member', memberId: d.id }, 'a unique member name resolves');
    assert.equal(named.takeover.basis, 'named_member');
    // D then reviews C's result; independence holds against both executors.
    f.submit(t1.id, c);
    assert.equal(f.review(t1.id, as(d), 'approve').task.status, 'completed');

    // Self: refused for members and the coordinator unless the user turned the setting on; the user may always.
    const t2 = f.create();
    assert.throws(() => f.takeover(as(c), t2.id, { reviewer: { kind: 'self' } }),
      code('FORBIDDEN', /a takeover with self review needs the user's authorisation.*ask the user to do this on the page or to turn on 「允许验收者接手后自检」.*or choose user review/));
    await f.setSelf(true);
    const bySetting = f.takeover(as(c), t2.id, { reviewer: { kind: 'self' } });
    assert.equal(bySetting.takeover.basis, 'cluster_setting');
    assert.deepEqual(bySetting.task.reviewer, { kind: 'self' });
    await f.setSelf(false);
    const t3 = f.create();
    assert.throws(() => f.takeover(as(b), t3.id, { reviewer: { kind: 'self' } }), code('FORBIDDEN'), 'off again: refused at commit time');
    const byUser = f.takeover(f.user, t3.id, { reviewer: { kind: 'self' } });
    assert.equal(byUser.takeover.basis, 'user');
    // Removed members can be neither the next reviewer nor the one taking over.
    const t4 = f.create();
    app.hub.removeMember(f.cluster.id, a.id);
    assert.throws(() => f.takeover(f.user, t4.id, { reviewer: { kind: 'member', memberId: a.id } }), code('OUT_OF_SCOPE'));
    app.hub.removeMember(f.cluster.id, c.id);
    assert.throws(() => f.takeover(f.user, t4.id), code('INVALID_STATE', /no longer in this cluster/));
  } finally { await app.close(); }
});

test('a hidden or coordinating reviewer, or one without the execute roles, cannot take over; an offline one can', async () => {
  const f = await fixture('reviewer');
  const { app, b, c, d, as } = f;
  try {
    const role = f.send(f.user, { action: 'role.create', name: 'builders' }).role;
    const roles = f.create({ executeRoleIds: [role.id], memberId: null });
    assert.throws(() => f.takeover(f.user, roles.id), code('ROLE_REQUIRED'));
    const t1 = f.create();
    f.send(f.user, { action: 'member.hidden', memberId: c.id, hidden: true });
    assert.throws(() => f.takeover(as(b), t1.id), code('OUT_OF_SCOPE'), 'to a member, a hidden reviewer reads as unknown');
    assert.throws(() => f.takeover(f.user, t1.id), code('FORBIDDEN', /hidden/));
    f.send(f.user, { action: 'member.hidden', memberId: c.id, hidden: false });
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' }).coordinator;
    assert.throws(() => f.takeover(as(b), t1.id), code('FORBIDDEN', /coordinator/));
    f.send(f.user, { action: 'coordinator.set', memberId: null });
    assert.ok(policy);
    const online = app.native.isOnline;
    app.native.isOnline = (session, bridge) => session !== 's3' && online(session, bridge);
    try {
      assert.equal(f.takeover(as(b), t1.id).task.assignedMemberId, c.id, 'offline is allowed; delivery waits as usual');
    } finally { app.native.isOnline = online; }
    assert.ok(d);
  } finally { await app.close(); }
});

test('records stay append-only, review rounds keep counting, and self review after a takeover says so in Reviewed-by', async () => {
  const f = await fixture('rounds');
  const { app, b, c, as } = f;
  try {
    const t = f.create();
    f.start(t.id);
    f.submit(t.id);
    f.review(t.id, as(c), 'reject');                                     // round 1: rejected
    f.submit(t.id, b, 'abcdef0456');
    await f.setSelf(true);
    const taken = f.takeover(as(c), t.id, { reviewer: { kind: 'self' } }); // C takes over the second, unreviewed result
    assert.equal(taken.takeover.previousRejected, true);
    assert.equal(taken.takeover.previousStatus, 'review');
    const done = f.submit(t.id, c, 'abcdef0789');
    assert.equal(done.task.status, 'completed');
    assert.equal(done.review.self, true);
    assert.equal(done.review.takeover, true);
    const view = f.detail(t.id);
    assert.equal(view.submissions.length, 3, 'every submission kept');
    assert.deepEqual(view.reviews.map((r: any) => [r.round, r.verdict, r.self ?? false]), [[1, 'reject', false], [2, 'approve', true]], 'rounds continue');
    assert.equal(view.takeovers.length, 1);
    assert.deepEqual(view.takeovers[0].reviewFrom, { kind: 'member', memberId: c.id });
    assert.deepEqual(view.takeovers[0].reviewTo, { kind: 'self' });
    assert.equal(view.task.takeover.basis, 'cluster_setting');
    // The takeover event is in the task history with the reviewer change and the record's facts.
    const event = view.events.find((x: any) => x.payload.action === 'task.takeover');
    assert.deepEqual(event.payload.changes.map((x: any) => x.field), ['reviewer']);
    assert.equal(event.payload.takeover.toMemberId, c.id);
    // Ship: C runs it (self), and the line names C, round 2, self, and the takeover.
    const ship = shipForRunner(app.hub, f.secret(), app.url, f.cluster.id, t.id, c.id) as any;
    const ticket = /--ticket (\S+)/.exec(ship.ship.command)![1];
    const verified = verifyShip(app.hub, f.secret(), ticket);
    assert.deepEqual({ reviewer: verified.reviewer, round: verified.round, verdict: verified.verdict, takeover: verified.takeover },
      { reviewer: 'C', round: 2, verdict: 'self', takeover: true });
    const line = buildMessage({ agent: 'x', type: 'fix', summary: 's', trailers: [] }, verified as never).split('\n')[2];
    assert.equal(line, `Reviewed-by: C (task ${t.id.slice(0, 8)}, r2, self, abcdef0, reviewer takeover)`);

    // User review after a takeover: the user approves, the executor (C) ships, and the line reads as today.
    await f.setSelf(false);
    const u = f.create();
    f.start(u.id);
    f.takeover(as(c), u.id);
    f.submit(u.id, c, 'abcdef0999');
    f.review(u.id, f.user, 'approve');
    const userShip = verifyShip(app.hub, f.secret(), /--ticket (\S+)/.exec((shipForRunner(app.hub, f.secret(), app.url, f.cluster.id, u.id, c.id) as any).ship.command)![1]);
    assert.deepEqual([userShip.verdict, userShip.reviewer, userShip.takeover], ['pass', 'user', undefined]);
  } finally { await app.close(); }
});

test('the notice: names the task, both members and the mode; wakes who must act, tells the rest, never the actor', async () => {
  const f = await fixture('notice');
  const { app, a, b, c, d, as } = f;
  try {
    // A creates; B works; C (reviewer) takes over a working task after a rejection and names D to review.
    const t = f.send(as(a), { action: 'task.create', title: 'notice @B', scope: 's', acceptance: 'a', memberId: b.id,
      reviewer: { kind: 'member', memberId: c.id } }).task;
    f.start(t.id);
    f.submit(t.id);
    f.review(t.id, as(c), 'reject');
    const taken = f.takeover(as(c), t.id, { reviewer: { kind: 'member', memberId: d.id } });
    const notice = f.noticeOf(taken.eventId)!;
    assert.equal(notice.systemKind, 'task');
    assert.equal(notice.body, `任务 #1【notice @B】由验收者 C 接手执行（发起：C，原执行者 B）；验收方式：成员验收（C） → 成员验收（D）（依据：指定成员）。`
      + `上一轮验收为退回。B 请停手，原派工的提交会被拒绝。事件 ${taken.eventId}。`);
    assert.deepEqual([...notice.mentions].sort(), [a.id, b.id, d.id].sort(), 'the old executor, the next reviewer and the creator; not the actor');
    assert.deepEqual(f.woken(notice.id), [b.id], 'only B, who may still be working, is woken');

    // The executor hands a task in review to C with self review (setting on): a warning-level notice; C is woken.
    await f.setSelf(true);
    const s = f.create();
    f.start(s.id);
    f.submit(s.id);
    const self = f.takeover(as(b), s.id, { reviewer: { kind: 'self' } });
    const warn = f.noticeOf(self.eventId)!;
    assert.equal(warn.systemKind, 'review_downgraded');
    assert.match(warn.body, /验收方式：成员验收（C） → 自查（依据：群设置授权）。此后不再有独立验收。事件/);
    assert.deepEqual(warn.mentions, [c.id]);
    assert.deepEqual(f.woken(warn.id), [c.id]);

    // The user takes over a pending, unassigned task the user created: nobody else to tell, yet the record stays in the chat.
    const quiet = f.create({ memberId: null });
    const byUser = f.takeover(f.user, quiet.id);
    assert.ok(f.noticeOf(byUser.eventId), 'kept in the chat record');
    assert.deepEqual(f.woken(f.noticeOf(byUser.eventId)!.id), [c.id], 'the reviewer now executing is woken');
    const own = f.create({ memberId: null });
    const byReviewer = f.takeover(as(c), own.id);
    const silent = f.noticeOf(byReviewer.eventId)!;
    assert.deepEqual(silent.mentions, [], 'the actor is not told, yet the notice is in the record');
  } finally { await app.close(); }
});

test('idempotent retries, stale revisions and a second takeover after the first', async () => {
  const f = await fixture('races');
  const { app, b, c, as } = f;
  try {
    const t = f.create();
    f.start(t.id);
    const revision = f.rev(t.id);
    const command = { action: 'task.takeover', operationId: 'same-op', taskId: t.id, expectedRevision: revision };
    const first = app.hub.collaboration.command(as(c), f.cluster.id, command as never) as any;
    const again = app.hub.collaboration.command(as(c), f.cluster.id, command as never) as any;
    assert.equal(again.eventId, first.eventId, 'the same operationId replays');
    assert.equal(f.detail(t.id).takeovers.length, 1);
    assert.throws(() => app.hub.collaboration.command(as(b), f.cluster.id, { ...command, operationId: 'other-op' } as never), code('STALE_REVISION'));
    assert.throws(() => f.takeover(as(b), t.id), code('INVALID_STATE', /reviewed by the user/), 'the second, at the new revision, finds no member reviewer');
    // A submission racing a takeover: whichever commits first wins, the other sees a new revision.
    const r = f.create();
    f.start(r.id);
    const stale = f.rev(r.id);
    f.submit(r.id);
    assert.throws(() => f.send(as(c), { action: 'task.takeover', taskId: r.id, expectedRevision: stale }), code('STALE_REVISION'));
  } finally { await app.close(); }
});

test('dependencies: the new assignment keeps the versions the work started against', async () => {
  const f = await fixture('deps');
  const { app, c, as } = f;
  try {
    const up = f.create({ reviewer: { kind: 'self' }, mergeRequired: false });
    f.start(up.id);
    f.submit(up.id);
    const down = f.create({ dependencyIds: [up.id] });
    f.start(down.id);
    const versions = f.detail(down.id).assignments.at(-1).dependencyVersions;
    f.send(f.user, { action: 'task.reopen', taskId: up.id, expectedRevision: f.rev(up.id), reason: 'again' });
    const taken = f.takeover(as(c), down.id);
    assert.deepEqual(taken.assignment.dependencyVersions, versions);
    assert.equal(taken.task.dependenciesChanged, true, 'the change is still visible');
    assert.throws(() => f.submit(down.id, c), code('DEPENDENCIES_NOT_READY'));
  } finally { await app.close(); }
});

test('errors that used to dead-end now point to takeover', async () => {
  const f = await fixture('errors');
  const { app, b, c, as } = f;
  try {
    const t = f.create();
    assert.throws(() => f.send(f.user, { action: 'task.assign', taskId: t.id, expectedRevision: f.rev(t.id), memberId: c.id }),
      code('REVIEW_NOT_INDEPENDENT', /task_action takeover/));
    f.start(t.id);
    assert.throws(() => f.send(as(b), { action: 'task.handoff', taskId: t.id, expectedRevision: f.rev(t.id), assignmentId: f.task(t.id).currentAssignmentId,
      memberId: c.id, reason: 'fix' }), code('REVIEW_NOT_INDEPENDENT', /task_action takeover/));
    f.submit(t.id);
    f.review(t.id, as(c), 'reject');
    // The user created it, so a member creator is needed for the creator's reviewer edit.
    const own = f.send(as(b), { action: 'task.create', title: 'mine', scope: 's', acceptance: 'a', memberId: b.id, reviewer: { kind: 'member', memberId: c.id } }).task;
    f.start(own.id);
    f.submit(own.id);
    f.review(own.id, as(c), 'reject');
    assert.throws(() => f.send(as(b), { action: 'task.edit', taskId: own.id, expectedRevision: f.rev(own.id), reviewer: { kind: 'user' } }),
      code('FORBIDDEN', /task_action takeover/));
  } finally { await app.close(); }
});

test('the setting: off by default, only the user changes it; members and a coordinator with every permission cannot, through MCP or directly', async () => {
  const f = await fixture('setting');
  const { app, c, d, as, mcp } = f;
  try {
    const workspace = () => app.api('GET', `/api/clusters/${f.cluster.id}/workspace`);
    assert.deepEqual((await workspace()).taskSettings, { takeoverSelfReview: false });
    f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { taskPlanning: true, assignment: true, roleManagement: true, reviewerManagement: true, knowledgeCommunication: true,
        recovery: true, cancelReopen: true, deliveryControl: true } });
    const generation = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { cancelReopen: true, deliveryControl: true } }).coordinator.generation;
    for (const actor of [as(c), as(d)]) {
      assert.throws(() => f.send(actor, { action: 'tasks.settings', takeoverSelfReview: true }), code('FORBIDDEN', /only the user/));
      assert.throws(() => f.send(actor, { action: 'tasks.settings', takeoverSelfReview: true, generation }), code('FORBIDDEN', /only the user/));
    }
    // No tool reaches it: task_action has no such action, and an extra field rides along nowhere.
    for (const session of ['s3', 's4']) {
      const asAction = await mcp(session, 'task_action', { action: 'settings', taskId: '#1', takeoverSelfReview: true });
      assert.ok(asAction.error, `${session}: task_action refuses an unknown action`);
      const t = f.create();
      const smuggled = await mcp(session, 'task_action', { action: 'takeover', taskId: t.id, expectedRevision: t.revision,
        reviewer: { kind: 'self' }, takeoverSelfReview: true, ...(session === 's4' ? { generation } : {}) });
      assert.match(smuggled.error, /允许验收者接手后自检/, `${session}: self review stays refused`);
    }
    assert.deepEqual((await workspace()).taskSettings, { takeoverSelfReview: false }, 'still off');

    // Through MCP the reviewer takes over with user review (the default), and the coordinator with a named member.
    const t1 = f.create();
    const viaMcp = await mcp('s3', 'task_action', { action: 'takeover', taskId: `#${t1.number}`, expectedRevision: t1.revision });
    assert.equal(viaMcp.takeover.toMemberId, c.id);
    const t2 = f.create();
    const viaCoordinator = await mcp('s4', 'task_action', { action: 'takeover', taskId: t2.id, expectedRevision: t2.revision, generation,
      reviewer: { kind: 'member', memberId: 'A' } });
    assert.equal(viaCoordinator.takeover.basis, 'named_member');

    // The user turns it on (and the change stays in the chat as a settings notice); then the reviewer may choose self.
    const on = await f.setSelf(true);
    assert.deepEqual(on.taskSettings, { takeoverSelfReview: true });
    const settingNotice = app.store.listMessages(f.cluster.id, 500).find((m) => m.kind === 'system' && m.body.includes('开启了本群的「允许验收者接手后自检」'))!;
    assert.equal(settingNotice.systemKind, 'settings');
    assert.equal(settingNotice.body, `用户开启了本群的「允许验收者接手后自检」，事件 ${on.eventId}。`);
    assert.deepEqual(settingNotice.mentions, [], 'it wakes nobody');
    const t3 = f.create();
    const self = await mcp('s3', 'task_action', { action: 'takeover', taskId: t3.id, expectedRevision: t3.revision, reviewer: { kind: 'self' } });
    assert.equal(self.takeover.basis, 'cluster_setting');
    await assert.rejects(app.api('POST', `/api/clusters/${f.cluster.id}/collaboration`, { action: 'tasks.settings', operationId: 'bad', takeoverSelfReview: 'yes' }), /boolean/);
  } finally { await app.close(); }
});

test('migration: a step-4 database gets the settings table, off for every cluster', () => {
  const path = join(tempDir(), 'takeover.db');
  let store = new Store(path, new PluginHost(officialPlugins));
  store.db.exec(`DROP TABLE task_cluster_settings; UPDATE plugin_migrations SET version = 4 WHERE plugin_id = 'tasks';`);
  store.close();
  store = new Store(path, new PluginHost(officialPlugins));
  try {
    assert.equal(MIGRATIONS.length, 5);
    assert.equal((store.db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'tasks'").get() as { version: number }).version, 5);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM task_cluster_settings').get() as { n: number }).n, 0);
    store.transaction(() => store.db.exec(MIGRATIONS[4]));   // running it again is harmless
  } finally { store.close(); }
});
