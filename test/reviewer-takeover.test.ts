// Reviewer takeover (docs/collaboration.md「验收者接手」): the designated reviewer (or the user) takes the task over
// and always owns self review through merge, with anti-bypass guards, reject+takeover, immediate stop/infoOnly notices,
// and product-code diff notification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMessage } from '../scripts/ship.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { gitRead } from '../src/core/projects.ts';
import { setBranchLookup, type GitRunner } from '../src/plugins/tasks/package/hub/branch-link.mts';
import { shipForRunner, verifyShip } from '../src/plugins/tasks/package/hub/ship.mts';
import { MIGRATIONS } from '../src/plugins/tasks/package/hub/store.mts';
import { startTestHub, tempDir } from './helpers.ts';

/** Five native mock members A-E on sessions s1-s5. B executes and C reviews in the helpers below. */
async function fixture(name: string) {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const { cluster, members } = await app.hub.createCluster(name, ['A', 'B', 'C', 'D', 'E'].map((n, i) =>
    ({ harness: 'claude', sessionId: `s${i + 1}`, name: n })));
  const [a, b, c, d, e] = members;
  let serial = 0;
  const op = () => `takeover-${name}-${++serial}`;
  const send = (actor: unknown, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: op(), ...command } as never) as any;
  const sendAsync = (actor: unknown, command: Record<string, unknown>) =>
    app.hub.collaboration.commandAsync(actor as never, cluster.id, { operationId: op(), ...command } as never) as Promise<any>;
  const user = { kind: 'user' as const };
  const as = (member: { id: string }) => ({ kind: 'member' as const, memberId: member.id });
  const task = (id: string) => app.store.tasks!.task(cluster.id, id)!;
  const rev = (id: string) => task(id).revision;
  const create = (extra: Record<string, unknown> = {}) => send(user, { action: 'task.create', title: 't', scope: 's', acceptance: 'a',
    memberId: b.id, reviewer: { kind: 'member', memberId: c.id }, ...extra }).task;
  const start = (id: string, who = b) => send(as(who), { action: 'task.start', taskId: id, expectedRevision: rev(id) });
  const submit = (id: string, who = b, sha = 'abcdef0123') => send(as(who), { action: 'task.submit', taskId: id, expectedRevision: rev(id),
    assignmentId: task(id).currentAssignmentId, summary: `done by ${who.name}`, commitSha: sha });
  const review = (id: string, actor: unknown, verdict: 'approve' | 'reject', extra: Record<string, unknown> = {}) => send(actor, { action: 'task.review', taskId: id,
    expectedRevision: rev(id), submissionId: task(id).latestSubmissionId, verdict, reason: verdict, ...extra });
  const takeover = (actor: unknown, id: string, extra: Record<string, unknown> = {}) =>
    send(actor, { action: 'task.takeover', taskId: id, expectedRevision: rev(id), ...extra });
  const detail = (id: string) => app.hub.collaboration.query(user, cluster.id, { kind: 'task', taskId: id, limit: 50 }) as any;
  const noticeOf = (eventId: number) => app.store.listMessages(cluster.id, 500).find((m) => m.kind === 'system' && m.collabEventId === eventId);
  const noticesOf = (eventId: number) => app.store.listMessages(cluster.id, 500).filter((m) => m.kind === 'system' && m.collabEventId === eventId);
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
  return { app, cluster, a, b, c, d, e, dir, send, sendAsync, user, as, task, rev, create, start, submit, review, takeover, detail, noticeOf, noticesOf, woken, mcp, secret };
}

const code = (expected: string, text?: RegExp) => (error: any) => {
  assert.equal(error.code, expected, error.message);
  if (text) assert.match(error.message, text);
  return true;
};

test('every status & anti-bypass guards: user moves pending/working/review to self; member requires review or submitted working', async () => {
  const f = await fixture('status');
  const { app, b, c, as } = f;
  try {
    // pending (with or without executor): member reviewer is refused (409), user moves it to self with basis 'user'.
    const pending = f.create();
    assert.throws(() => f.takeover(as(c), pending.id), code('INVALID_STATE', /review or working with at least one submission/));
    const moved = f.takeover(f.user, pending.id);
    assert.equal(moved.task.status, 'pending');
    assert.equal(moved.task.assignedMemberId, c.id);
    assert.deepEqual(moved.task.reviewer, { kind: 'self' }, 'always switches to self');
    assert.equal(moved.takeover.basis, 'user');
    assert.equal(moved.takeover.baseSubmissionId, null);
    assert.equal(moved.takeover.baseCommitSha, null);
    assert.equal(moved.assignment, undefined, 'no assignment until the new executor starts');
    assert.equal(f.start(pending.id, c).task.status, 'working');

    const open = f.create({ memberId: null });
    assert.equal(f.takeover(f.user, open.id).task.assignedMemberId, c.id);

    // working with 0 submissions: member refused (409), user allowed.
    const workingEmpty = f.create();
    f.start(workingEmpty.id);
    assert.throws(() => f.takeover(as(c), workingEmpty.id), code('INVALID_STATE', /at least one submission/));
    const userTaken = f.takeover(f.user, workingEmpty.id);
    assert.equal(userTaken.task.status, 'working');
    assert.equal(userTaken.assignment.memberId, c.id);

    // working WITH a submission (after reject): member reviewer can take over directly.
    const workingSub = f.create();
    f.start(workingSub.id);
    const sub1 = f.submit(workingSub.id, b, '1111111');
    f.review(workingSub.id, as(c), 'reject');
    const before = f.task(workingSub.id).currentAssignmentId;
    const taken = f.takeover(as(c), workingSub.id);
    assert.equal(taken.task.status, 'working');
    assert.equal(taken.assignment.memberId, c.id);
    assert.equal(taken.takeover.basis, 'reviewer');
    assert.equal(taken.takeover.baseSubmissionId, sub1.submission.id);
    assert.equal(taken.takeover.baseCommitSha, '1111111');
    const assignments = f.detail(workingSub.id).assignments;
    assert.equal(assignments.find((x: any) => x.id === before).endReason, 'reviewer takeover');
    assert.throws(() => f.submit(workingSub.id, b), code('STALE_ASSIGNMENT'), 'the old executor cannot submit any more');

    // review: baseline SHA captured before latestSubmissionId is cleared; explicit non-self reviewer rejected 400.
    const inReview = f.create();
    f.start(inReview.id);
    const submitted = f.submit(inReview.id, b, 'abcdef0123');
    assert.throws(() => f.takeover(as(c), inReview.id, { reviewer: { kind: 'user' } }), code('INVALID_REQUEST'));
    assert.throws(() => f.takeover(as(c), inReview.id, { reviewer: { kind: 'member', memberId: f.a.id } }), code('INVALID_REQUEST'));
    const fromReview = f.takeover(as(c), inReview.id, { reviewer: { kind: 'self' } });
    assert.equal(fromReview.task.status, 'working');
    assert.equal(fromReview.task.latestSubmissionId, null);
    assert.equal(fromReview.takeover.baseSubmissionId, submitted.submission.id);
    assert.equal(fromReview.takeover.baseCommitSha, 'abcdef0123');
    assert.equal(fromReview.task.takeover.baseCommitSha, 'abcdef0123');
    const view = f.detail(inReview.id);
    assert.deepEqual(view.submissions.map((s: any) => [s.id, s.superseded]), [[submitted.submission.id, true]], 'kept, marked superseded');
    assert.throws(() => f.send(as(c), { action: 'task.review', taskId: inReview.id, expectedRevision: f.rev(inReview.id),
      submissionId: submitted.submission.id, verdict: 'approve', reason: 'x' }), code('STALE_SUBMISSION'));

    // completed, merged, cancelled, awaiting approval, and tasks without a member reviewer are refused.
    const approved = f.create();
    f.start(approved.id);
    f.submit(approved.id);
    f.review(approved.id, as(c), 'approve');
    assert.throws(() => f.takeover(as(c), approved.id), code('INVALID_STATE', /already approved/));
    const merged = f.create({ mergeRequired: false });
    f.send(f.user, { action: 'task.mark_merged', taskId: merged.id, expectedRevision: f.rev(merged.id) });
    assert.throws(() => f.takeover(as(c), merged.id), code('INVALID_STATE', /closed/));
    const cancelled = f.create();
    f.send(f.user, { action: 'task.cancel', taskId: cancelled.id, expectedRevision: f.rev(cancelled.id), reason: 'no' });
    assert.throws(() => f.takeover(as(c), cancelled.id), code('INVALID_STATE', /closed/));
    const proposed = f.create({ requiresApproval: true, memberId: null });
    assert.throws(() => f.takeover(as(c), proposed.id), code('APPROVAL_REQUIRED'));
    f.send(f.user, { action: 'task.approve', taskId: proposed.id, expectedRevision: f.rev(proposed.id), verdict: 'approve' });
    assert.throws(() => f.takeover(as(c), proposed.id), code('INVALID_STATE'));
    assert.equal(f.takeover(f.user, proposed.id).task.assignedMemberId, c.id, 'user takes approved pending task');
    for (const reviewer of [{ kind: 'user' }, { kind: 'self' }]) {
      const other = f.create({ reviewer });
      assert.throws(() => f.takeover(f.user, other.id), code('INVALID_STATE', /reviewed by a member/));
    }
  } finally { await app.close(); }
});

test('who may start it: only the designated reviewer or the user (HTTP); executor, coordinator and other members refused 403', async () => {
  const f = await fixture('actors');
  const { app, a, b, c, d, e, as } = f;
  try {
    const t1 = f.create();
    f.start(t1.id);
    f.submit(t1.id);
    assert.throws(() => f.takeover(as(a), t1.id), code('FORBIDDEN', /designated task reviewer/), 'an unrelated member');
    assert.throws(() => f.takeover(as(b), t1.id), code('FORBIDDEN', /designated task reviewer/), 'the executor cannot hand over via takeover');
    f.send(f.user, { action: 'member.hidden', memberId: e.id, hidden: true });
    assert.throws(() => f.takeover(as(e), t1.id), code('HIDDEN'), 'a hidden member acts on nothing');
    f.send(f.user, { action: 'member.hidden', memberId: e.id, hidden: false });

    const policy = f.send(f.user, { action: 'coordinator.set', memberId: d.id, enabled: true, mode: 'execute',
      permissions: { taskPlanning: true, assignment: true, roleManagement: true, reviewerManagement: true, knowledgeCommunication: true,
        recovery: true, cancelReopen: true, deliveryControl: true } }).coordinator;
    assert.throws(() => f.takeover(as(d), t1.id, { generation: policy.generation }), code('FORBIDDEN', /designated task reviewer/),
      'even a full-permission coordinator cannot trigger takeover');
    assert.equal(f.task(t1.id).assignedMemberId, b.id);
    f.send(f.user, { action: 'coordinator.set', memberId: null });

    const byReviewer = f.takeover(as(c), t1.id);
    assert.equal(byReviewer.takeover.by, c.id);
    assert.equal(byReviewer.takeover.basis, 'reviewer');

    const t5 = f.create();
    const viaPage = await app.api('POST', `/api/clusters/${f.cluster.id}/collaboration`, { action: 'task.takeover', operationId: 'page-1',
      taskId: t5.id, expectedRevision: t5.revision });
    assert.equal(viaPage.takeover.by, 'user');
    assert.equal(viaPage.takeover.basis, 'user');
    assert.deepEqual(viaPage.task.reviewer, { kind: 'self' });
  } finally { await app.close(); }
});

test('the review mode after it: always binds self review owned by taker; removed/invalid states rejected', async () => {
  const f = await fixture('modes');
  const { app, a, c, as } = f;
  try {
    const t1 = f.create({ memberId: a.id });
    f.start(t1.id, a);
    f.submit(t1.id, a, 'abcdef0111');
    const taken = f.takeover(as(c), t1.id);
    assert.deepEqual(taken.task.reviewer, { kind: 'self' });
    assert.equal(taken.takeover.basis, 'reviewer');
    assert.equal(f.submit(t1.id, c, 'abcdef0112').task.status, 'completed');

    const t4 = f.create();
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
    assert.throws(() => f.takeover(f.user, t1.id), code('FORBIDDEN', /hidden/));
    f.send(f.user, { action: 'member.hidden', memberId: c.id, hidden: false });
    const policy = f.send(f.user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' }).coordinator;
    f.start(t1.id, b);
    f.submit(t1.id, b, 'abcdef0222');
    assert.throws(() => f.takeover(as(c), t1.id, { generation: policy.generation }), code('FORBIDDEN', /coordinator/));
    f.send(f.user, { action: 'coordinator.set', memberId: null });
    const online = app.native.isOnline;
    app.native.isOnline = (session, bridge) => session !== 's3' && online(session, bridge);
    try {
      assert.equal(f.takeover(as(c), t1.id).task.assignedMemberId, c.id, 'offline reviewer taking via member action allowed');
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
    const taken = f.takeover(as(c), t.id);                                // C takes over directly into self review
    assert.equal(taken.takeover.previousRejected, true);
    assert.equal(taken.takeover.previousStatus, 'review');
    assert.equal(taken.takeover.basis, 'reviewer');
    assert.equal(taken.takeover.baseCommitSha, 'abcdef0456');
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
    assert.equal(view.task.takeover.basis, 'reviewer');
    const event = view.events.find((x: any) => x.payload.action === 'task.takeover');
    assert.deepEqual(event.payload.changes.map((x: any) => x.field), ['reviewer']);
    assert.equal(event.payload.takeover.toMemberId, c.id);
    const ship = shipForRunner(app.hub, f.secret(), app.url, f.cluster.id, t.id, c.id) as any;
    const ticket = /--ticket (\S+)/.exec(ship.ship.command)![1];
    const verified = verifyShip(app.hub, f.secret(), ticket);
    assert.deepEqual({ reviewer: verified.reviewer, round: verified.round, verdict: verified.verdict, takeover: verified.takeover },
      { reviewer: 'C', round: 2, verdict: 'self', takeover: true });
    const line = buildMessage({ agent: 'x', type: 'fix', summary: 's', trailers: [] }, verified as never).split('\n')[2];
    assert.equal(line, `Reviewed-by: C (task ${t.id.slice(0, 8)}, r2, self, abcdef0, reviewer takeover)`);
  } finally { await app.close(); }
});

test('immediate takeover notices: working wakes old executor + supersedes queued notices; review & pending send infoOnly + clear stale notices', async () => {
  const f = await fixture('notice');
  const { app, a, b, c, as } = f;
  try {
    // working with submission -> wakes B to stop, creator A gets infoOnly, reviewer C (actor) not woken
    const t = f.send(as(a), { action: 'task.create', title: 'notice @B', scope: 's', acceptance: 'a', memberId: b.id,
      reviewer: { kind: 'member', memberId: c.id } }).task;
    f.start(t.id);
    f.submit(t.id, b, '1111111');
    f.review(t.id, as(c), 'reject');
    app.hub.setPaused(true);
    const queuedAssign = f.send(f.user, { action: 'task.create', title: 'queued-old', scope: 's', acceptance: 'a', memberId: b.id,
      reviewer: { kind: 'member', memberId: c.id } });
    // Put notice on t: assign B to ensure t has a queued notice? Let's trigger takeover on working t with paused hub first.
    assert.ok(queuedAssign);
    app.hub.setPaused(false);
    const taken = f.takeover(as(c), t.id);
    const notice = f.noticeOf(taken.eventId)!;
    assert.equal(notice.systemKind, 'review_downgraded');
    assert.match(notice.body, /验收方式：成员验收（C） → 自查（依据：验收者本人接手）。此后不再有独立验收。上一轮验收为退回。B 请停手，原派工的提交会被拒绝。事件/);
    assert.deepEqual([...notice.mentions].sort(), [a.id, b.id].sort());
    assert.deepEqual(f.woken(notice.id), [b.id], 'working state wakes old executor B to stop');

    // review takeover -> B gets infoOnly (NOT woken), queued task.submit/edit notices for C are superseded
    app.hub.setPaused(true);
    const revTask = f.create({ memberId: b.id, reviewer: { kind: 'member', memberId: c.id } });
    f.start(revTask.id, b);
    const subEv = f.submit(revTask.id, b, '2222222');
    const reviewSubMsg = f.noticeOf(subEv.eventId)!;
    const deliveryToC = () => app.store.withDeliveries([app.store.getMessage(reviewSubMsg.id)!])[0].deliveries.find((d) => d.memberId === c.id)!;
    assert.equal(deliveryToC().state, 'queued');
    const byRev = f.takeover(as(c), revTask.id);
    const revNotice = f.noticeOf(byRev.eventId)!;
    assert.ok(revNotice.mentions.includes(b.id), 'old executor informed unread');
    assert.deepEqual(f.woken(revNotice.id), [], 'review takeover never wakes old executor');
    assert.equal(deliveryToC().state, 'superseded', 'stale review notice for C is superseded');

    // user takeover from pending: old executor B infoOnly + queued notice superseded; taker C woken only when dependencies ready
    const dep = f.create({ reviewer: { kind: 'self' }, mergeRequired: true });
    const waitTask = f.create({ dependencyIds: [dep.id], memberId: b.id, reviewer: { kind: 'member', memberId: c.id } });
    const pendingByUser = f.takeover(f.user, waitTask.id);
    const pendingNotice = f.noticeOf(pendingByUser.eventId)!;
    assert.deepEqual([...pendingNotice.mentions].sort(), [b.id, c.id].sort());
    assert.deepEqual(f.woken(pendingNotice.id), [], 'waiting on deps wakes neither old executor B nor C');

    const readyTask = f.create({ memberId: b.id, reviewer: { kind: 'member', memberId: c.id } });
    const readyByUser = f.takeover(f.user, readyTask.id);
    const readyNotice = f.noticeOf(readyByUser.eventId)!;
    assert.deepEqual(f.woken(readyNotice.id), [c.id], 'ready pending user takeover wakes taker C only, keeps B infoOnly');
    app.hub.setPaused(false);
  } finally { await app.close(); }
});

test('post-takeover submit sends infoOnly notice when product code changes or cannot verify, and skips when only docs/tests change', async () => {
  const f = await fixture('product-diff');
  const { app, b, c, as, dir } = f;
  setBranchLookup({ budgetMs: 60_000 });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim();
  const commit = (cwd: string, msg: string) => {
    git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', msg);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  try {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    git(repo, 'init', '-b', 'develop');
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
    git(repo, 'add', '.');
    commit(repo, 'init');
    git(repo, 'checkout', '-b', 'topic');
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 2;\n');
    git(repo, 'add', '.');
    const baseSha = commit(repo, 'work by B');

    // Point C's saved cwd via a task manual gitBranch or C's projectPath (fixture used dir; use set_git_branch from user)
    const tDocs = f.create({ memberId: b.id, reviewer: { kind: 'member', memberId: c.id }, mergeRequired: false });
    f.send(f.user, { action: 'task.set_git_branch', taskId: tDocs.id, expectedRevision: f.rev(tDocs.id), gitBranch: { repositoryPath: repo, branch: 'topic' } });
    f.start(tDocs.id, b);
    await f.sendAsync(as(b), { action: 'task.submit', taskId: tDocs.id, expectedRevision: f.rev(tDocs.id),
      assignmentId: f.task(tDocs.id).currentAssignmentId, summary: 'b done', commitSha: baseSha });
    f.takeover(as(c), tDocs.id);

    // Docs/test-only edit by C -> NO product-diff notice to B
    writeFileSync(join(repo, 'docs', 'notes.md'), '# doc\n');
    writeFileSync(join(repo, 'test', 'app.test.ts'), '// test\n');
    git(repo, 'add', '.');
    const docsSha = commit(repo, 'docs and tests only');
    const subDocs = await f.sendAsync(as(c), { action: 'task.submit', taskId: tDocs.id, expectedRevision: f.rev(tDocs.id),
      assignmentId: f.task(tDocs.id).currentAssignmentId, summary: 'c docs', commitSha: docsSha });
    assert.equal(f.noticesOf(subDocs.eventId).length, 1, 'no extra product-diff notice when only docs/tests changed');

    // Product code edit by C -> extra infoOnly notice to original executor B
    const tProd = f.create({ memberId: b.id, reviewer: { kind: 'member', memberId: c.id }, mergeRequired: false });
    f.send(f.user, { action: 'task.set_git_branch', taskId: tProd.id, expectedRevision: f.rev(tProd.id), gitBranch: { repositoryPath: repo, branch: 'topic' } });
    f.start(tProd.id, b);
    await f.sendAsync(as(b), { action: 'task.submit', taskId: tProd.id, expectedRevision: f.rev(tProd.id),
      assignmentId: f.task(tProd.id).currentAssignmentId, summary: 'b work', commitSha: docsSha });
    f.takeover(as(c), tProd.id);
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 3;\n');
    git(repo, 'add', '.');
    const prodSha = commit(repo, 'edit product code');
    const subProd = await f.sendAsync(as(c), { action: 'task.submit', taskId: tProd.id, expectedRevision: f.rev(tProd.id),
      assignmentId: f.task(tProd.id).currentAssignmentId, summary: 'c prod fix', commitSha: prodSha });
    const diffMsg = f.noticesOf(subProd.eventId).find((m) => m.body.includes('产品代码'))!;
    assert.ok(diffMsg, 'extra infoOnly notice emitted for product code edit');
    assert.match(diffMsg.body, /src\/app\.ts/);
    assert.deepEqual(diffMsg.mentions, [b.id]);
    assert.deepEqual(f.woken(diffMsg.id), [], 'product diff notice must not wake original executor');
    // Clean merge from main + evil merge product edit both run without git show / --remerge-diff
    const seenArgs: string[][] = [];
    const spyRunner: GitRunner = (cwd, args, signal) => { seenArgs.push(args); return gitRead(cwd, args, signal); };
    setBranchLookup({ budgetMs: 60_000, runner: spyRunner });
    git(repo, 'checkout', '-qb', 'main', 'HEAD~2');
    writeFileSync(join(repo, 'src', 'main-only.ts'), 'export const fromMain = 1;\n');
    git(repo, 'add', '.');
    commit(repo, 'main advances');
    git(repo, 'checkout', '-q', 'topic');
    const preMergeSha = git(repo, 'rev-parse', 'HEAD');

    const tCleanMerge = f.create({ memberId: b.id, reviewer: { kind: 'member', memberId: c.id }, mergeRequired: false });
    f.send(f.user, { action: 'task.set_git_branch', taskId: tCleanMerge.id, expectedRevision: f.rev(tCleanMerge.id), gitBranch: { repositoryPath: repo, branch: 'topic' } });
    f.start(tCleanMerge.id, b);
    await f.sendAsync(as(b), { action: 'task.submit', taskId: tCleanMerge.id, expectedRevision: f.rev(tCleanMerge.id),
      assignmentId: f.task(tCleanMerge.id).currentAssignmentId, summary: 'b merge baseline', commitSha: preMergeSha });
    f.takeover(as(c), tCleanMerge.id);
    git(repo, 'merge', '--no-edit', '-q', 'main');
    const cleanMergedSha = git(repo, 'rev-parse', 'HEAD');
    const subCleanMerge = await f.sendAsync(as(c), { action: 'task.submit', taskId: tCleanMerge.id, expectedRevision: f.rev(tCleanMerge.id),
      assignmentId: f.task(tCleanMerge.id).currentAssignmentId, summary: 'c clean merge', commitSha: cleanMergedSha });
    assert.equal(f.noticesOf(subCleanMerge.eventId).length, 1, 'clean merge from main skips extra product-diff notice');
    assert.equal(seenArgs.some((args) => args.includes('--remerge-diff') || args[0] === 'show'), false);

    // Takeover submit with post-merge product code commit notifies B without --remerge-diff
    git(repo, 'reset', '--hard', preMergeSha);
    const tMergeProd = f.create({ memberId: b.id, reviewer: { kind: 'member', memberId: c.id }, mergeRequired: false });
    f.send(f.user, { action: 'task.set_git_branch', taskId: tMergeProd.id, expectedRevision: f.rev(tMergeProd.id), gitBranch: { repositoryPath: repo, branch: 'topic' } });
    f.start(tMergeProd.id, b);
    await f.sendAsync(as(b), { action: 'task.submit', taskId: tMergeProd.id, expectedRevision: f.rev(tMergeProd.id),
      assignmentId: f.task(tMergeProd.id).currentAssignmentId, summary: 'b work', commitSha: preMergeSha });
    f.takeover(as(c), tMergeProd.id);
    execFileSync('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: repo, stdio: 'pipe', windowsHide: true });
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 4;\n');
    git(repo, 'add', '.');
    const evilMergeSha = commit(repo, 'evil merge touching src/app.ts');
    const subEvil = await f.sendAsync(as(c), { action: 'task.submit', taskId: tMergeProd.id, expectedRevision: f.rev(tMergeProd.id),
      assignmentId: f.task(tMergeProd.id).currentAssignmentId, summary: 'c merge fix', commitSha: evilMergeSha });
    const evilDiffMsg = f.noticesOf(subEvil.eventId).find((m) => /产品代码|未能只读核对/.test(m.body))!;
    assert.ok(evilDiffMsg, 'evil merge product edit still emits infoOnly notice');
    assert.deepEqual(evilDiffMsg.mentions, [b.id]);
    assert.deepEqual(f.woken(evilDiffMsg.id), []);
    assert.equal(seenArgs.some((args) => args.includes('--remerge-diff') || args[0] === 'show'), false);
  } finally { setBranchLookup(); await app.close(); }
});

test('atomic reject+takeover on task_action review: single transaction, keeps rejected submission, wakes nobody, enforces gates', async () => {
  const f = await fixture('reject-takeover');
  const { app, b, c, d, as } = f;
  try {
    const t = f.create({ memberId: b.id, reviewer: { kind: 'member', memberId: c.id } });
    f.start(t.id, b);
    const sub = f.submit(t.id, b, 'abcdef0333');
    // approve + takeover refused 400 with zero writes
    const badApprove = await f.mcp('s3', 'task_action', { action: 'review', taskId: t.id, expectedRevision: f.rev(t.id),
      submissionId: sub.submission.id, verdict: 'approve', takeover: true, reason: 'no' });
    assert.match(badApprove.error, /INVALID_REQUEST/);
    assert.equal(f.task(t.id).status, 'review');

    // user / self reviewer with takeover: true -> 409 INVALID_STATE
    const uTask = f.create({ reviewer: { kind: 'user' } });
    f.start(uTask.id, b);
    const uSub = f.submit(uTask.id, b, 'abcdef0334');
    assert.throws(() => f.send(f.user, { action: 'task.review', taskId: uTask.id, expectedRevision: f.rev(uTask.id),
      submissionId: uSub.submission.id, verdict: 'reject', takeover: true, reason: 'x' }), code('INVALID_STATE'));

    // non-reviewer member / coordinator refused 403
    assert.throws(() => f.send(as(d), { action: 'task.review', taskId: t.id, expectedRevision: f.rev(t.id),
      submissionId: sub.submission.id, verdict: 'reject', takeover: true, reason: 'x' }), code('FORBIDDEN'));

    // designated reviewer rejects with takeover: true via MCP
    const res = await f.mcp('s3', 'task_action', { action: 'review', taskId: `#${t.number}`, expectedRevision: f.rev(t.id),
      submissionId: sub.submission.id, verdict: 'reject', takeover: true, reason: 'small fix myself' });
    assert.equal(res.task.status, 'working');
    assert.deepEqual(res.task.reviewer, { kind: 'self' });
    assert.equal(res.task.assignedMemberId, c.id);
    assert.equal(res.task.latestSubmissionId, sub.submission.id, 'rejected submission preserved until new submit');
    assert.equal(res.review.verdict, 'reject');
    assert.equal(res.takeover.action, 'task.review');
    assert.equal(res.takeover.baseCommitSha, 'abcdef0333');
    assert.equal(res.takeover.reason, undefined, 'MCP write result omits takeover reason prose');
    const notice = f.noticeOf(res.eventId)!;
    assert.equal(notice.systemKind, 'review_downgraded');
    assert.deepEqual(notice.mentions, [b.id]);
    assert.deepEqual(f.woken(notice.id), [], 'original executor only gets infoOnly, never woken');
    const detail = app.hub.collaboration.query(f.user, f.cluster.id, { kind: 'task', taskId: t.id, eventsOrder: 'desc', eventsLimit: 5 } as any) as any;
    assert.equal(detail.events[0].payload.takeoverId, res.takeover.id);
    assert.equal(detail.takeovers.at(-1).reason, 'small fix myself');
    const done = f.submit(t.id, c, 'abcdef0335');
    assert.equal(done.task.status, 'completed');
    assert.equal(done.review.takeover, true);
  } finally { await app.close(); }
});

test('idempotent retries, stale revisions and a second takeover after the first', async () => {
  const f = await fixture('races');
  const { app, b, c, as } = f;
  try {
    const t = f.create();
    f.start(t.id);
    f.submit(t.id, b, 'abcdef0123');
    const revision = f.rev(t.id);
    const command = { action: 'task.takeover', operationId: 'same-op', taskId: t.id, expectedRevision: revision };
    const first = app.hub.collaboration.command(as(c), f.cluster.id, command as never) as any;
    const again = app.hub.collaboration.command(as(c), f.cluster.id, command as never) as any;
    assert.equal(again.eventId, first.eventId, 'the same operationId replays');
    assert.equal(f.detail(t.id).takeovers.length, 1);
    assert.throws(() => app.hub.collaboration.command(as(b), f.cluster.id, { ...command, operationId: 'other-op' } as never), code('STALE_REVISION'));
    assert.throws(() => f.takeover(as(b), t.id), code('INVALID_STATE', /self review/), 'the second, at the new revision, finds no member reviewer');
    // A submission racing a takeover on working task with existing submission: whichever commits first wins.
    const r = f.create();
    f.start(r.id);
    f.submit(r.id, b, '1111111');
    f.review(r.id, as(c), 'reject');
    const stale = f.rev(r.id);
    f.submit(r.id, b, '2222222');
    assert.throws(() => f.send(as(c), { action: 'task.takeover', taskId: r.id, expectedRevision: stale }), code('STALE_REVISION'));
  } finally { await app.close(); }
});

test('dependencies: the new assignment keeps the versions the work started against', async () => {
  const f = await fixture('deps');
  const { app, b, c, as } = f;
  try {
    const up = f.create({ reviewer: { kind: 'self' }, mergeRequired: false });
    f.start(up.id);
    f.submit(up.id);
    const down = f.create({ dependencyIds: [up.id] });
    f.start(down.id);
    const subDown = f.submit(down.id, b, '1111111');
    assert.ok(subDown);
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
    const own = f.send(as(b), { action: 'task.create', title: 'mine', scope: 's', acceptance: 'a', memberId: b.id, reviewer: { kind: 'member', memberId: c.id } }).task;
    f.start(own.id);
    f.submit(own.id);
    f.review(own.id, as(c), 'reject');
    assert.throws(() => f.send(as(b), { action: 'task.edit', taskId: own.id, expectedRevision: f.rev(own.id), reviewer: { kind: 'user' } }),
      code('FORBIDDEN', /task_action takeover/));
  } finally { await app.close(); }
});

test('tasks.settings is removed and workspace omits taskSettings, while takeovers are strictly fixed to reviewer/user', async () => {
  const f = await fixture('no-setting');
  const { app, b, c, d, as, mcp } = f;
  try {
    const workspace = () => app.api('GET', `/api/clusters/${f.cluster.id}/workspace`);
    assert.equal((await workspace()).taskSettings, undefined);
    assert.throws(() => f.send(f.user, { action: 'tasks.settings', takeoverSelfReview: true }), code('INVALID_REQUEST'));
    const asAction = await mcp('s3', 'task_action', { action: 'settings', taskId: '#1', takeoverSelfReview: true });
    assert.ok(asAction.error);

    // Through MCP: reviewer takes over submitted task into self review with basis 'reviewer'.
    const t1 = f.create();
    f.start(t1.id, b);
    f.submit(t1.id, b, 'abcdef0444');
    const viaMcp = await mcp('s3', 'task_action', { action: 'takeover', taskId: `#${t1.number}`, expectedRevision: f.rev(t1.id) });
    assert.equal(viaMcp.takeover.toMemberId, c.id);
    assert.equal(viaMcp.takeover.basis, 'reviewer');
    assert.deepEqual(viaMcp.task.reviewer, { kind: 'self' });
    assert.equal(d && true, true);
  } finally { await app.close(); }
});

test('migration: a step-4 database gets the settings table, off for every cluster', () => {
  const path = join(tempDir(), 'takeover.db');
  let store = new Store(path, new PluginHost(officialPlugins));
  store.db.exec(`DROP TABLE task_cluster_settings; UPDATE plugin_migrations SET version = 4 WHERE plugin_id = 'tasks';`);
  store.close();
  store = new Store(path, new PluginHost(officialPlugins));
  try {
    assert.ok(MIGRATIONS.length >= 5);   // step 6 (review batches) came later
    assert.equal((store.db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'tasks'").get() as { version: number }).version, MIGRATIONS.length);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM task_cluster_settings').get() as { n: number }).n, 0);
    store.transaction(() => store.db.exec(MIGRATIONS[4]));   // running it again is harmless
  } finally { store.close(); }
});
