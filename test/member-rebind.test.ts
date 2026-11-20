// Moving a member to another conversation (docs/cluster-members.md「换对话」), with mock native adapters only.
import type { TasksService } from '../src/plugins/tasks/package/hub/service.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { Limits } from '../src/core/hub.ts';
import type { Member } from '../src/core/types.ts';
import { rawFetch, startTestHub, TEST_TOKEN, tempDir, waitFor } from './helpers.ts';

const key = (session: string) => JSON.stringify(['mock', session]);

/** Native mock members A, B, C on s1..s3 of one cluster; a held session keeps its turn open until released. */
async function fixture(limits: Partial<Limits> = {}) {
  const dir = tempDir();
  const project = join(dir, 'project');
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(project, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => ({ id, title: id, model: `model-${id}`, cwd: id === 's6' ? elsewhere : project, updatedAt: null }));
  const holding = new Set<string>();
  const releases = new Map<string, () => void>();
  const native = createMockNativeAdapter({
    projects: [{ path: project, label: 'project', updatedAt: null }], sessions,
    // A held turn ignores abort, like an app that keeps going; finish() releases it for app.close().
    onDeliver: (sessionId) => (holding.has(sessionId) ? new Promise((resolve) => releases.set(sessionId, () => resolve('completed'))) : Promise.resolve('completed')),
  });
  const offline = new Set<string>();
  const online = native.isOnline.bind(native);
  native.isOnline = (sessionId, bridge) => !offline.has(sessionId) && online(sessionId, bridge);
  const foreign = createMockNativeAdapter({ harness: 'foreign', projects: [], sessions: [{ id: 'f1', title: 'f1', model: null, cwd: project, updatedAt: null }] });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native, foreign }, limits });
  const { cluster, members } = await app.hub.createCluster('rebind', ['A', 'B', 'C'].map((name, i) =>
    ({ harness: 'mock', sessionId: `s${i + 1}`, name })));
  const [a, b, c] = members;
  let serial = 0;
  const send = (actor: { kind: 'user' } | { kind: 'member'; memberId: string }, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: `rebind-${++serial}`, ...command } as never) as never as
      { task?: any; assignment?: any; submission?: any; role?: any };
  const user = { kind: 'user' as const };
  const as = (member: { id: string }) => ({ kind: 'member' as const, memberId: member.id });
  const move = (member: { id: string }, sessionId: string, extra: Record<string, unknown> = {}) =>
    app.api('POST', `/api/members/${member.id}/session`, { harness: 'mock', sessionId, confirmStopped: true, ...extra }) as Promise<{ member: Member; rebind: any }>;
  const history = (member: { id: string }) => app.api('GET', `/api/members/${member.id}/session-history`) as Promise<any[]>;
  const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
  /** A task of `member` carried up to `stage`; the reviewer is `reviewer` (default: the user). */
  const task = (member: { id: string }, title: string, stage: 'accepted' | 'working' | 'review', reviewer?: { id: string }) => {
    let t = send(user, { action: 'task.create', title, scope: title, acceptance: 'done', mergeRequired: false, ...(reviewer ? { reviewer: as(reviewer) } : {}) }).task;
    const claim = send(as(member), { action: 'task.claim', taskId: t.id, expectedRevision: t.revision });
    t = claim.task;
    const assignmentId: string = claim.assignment.id;
    if (stage === 'accepted') return { task: t, assignmentId, submissionId: null as string | null };
    t = send(as(member), { action: 'task.start', taskId: t.id, expectedRevision: t.revision, assignmentId }).task;
    if (stage === 'working') return { task: t, assignmentId, submissionId: null as string | null };
    const submitted = send(as(member), { action: 'task.submit', taskId: t.id, expectedRevision: t.revision, assignmentId, summary: 'result', evidenceMessageIds: [evidence.id] });
    return { task: submitted.task, assignmentId, submissionId: submitted.submission.id as string };
  };
  const view = (taskId: string) => app.hub.collaboration.query(user, cluster.id, { kind: 'task', taskId }) as any;
  const delivered = (session: string) => native.delivered.filter((d) => d.sessionId === session);
  const notices = async () => (await app.messages(cluster.id)).filter((m) => m.from === 'system');
  const finish = async () => {
    holding.clear();
    for (const release of releases.values()) release();
    await app.close();
  };
  const hold = (session: string) => holding.add(session);
  const release = (session: string) => { holding.delete(session); releases.get(session)?.(); };
  return { app, dir, native, offline, cluster, a, b, c, send, user, as, move, history, task, view, delivered, notices, finish, hold, release, evidence, project, elsewhere };
}

test('member rebind: id, name, roles and unread position stay; the conversation changes in place', async () => {
  const f = await fixture();
  try {
    const role = f.send(f.user, { action: 'role.create', name: 'builder' }).role;
    f.send(f.user, { action: 'member.roles', memberId: f.a.id, roleIds: [role.id] });
    f.offline.add('s1');
    const missed = f.app.hub.sendFromUser(f.cluster.id, '@A missed');
    f.offline.delete('s1');
    await waitFor(() => f.app.store.unreadIds(f.a.id, f.cluster.id).includes(missed.id), 'the message left unread');
    const unread = f.app.store.unreadIds(f.a.id, f.cluster.id);

    const { member, rebind } = await f.move(f.a, 's4');
    assert.equal(member.id, f.a.id);
    assert.equal(member.name, 'A');
    assert.deepEqual([member.workerSessionId, member.model, member.origin], ['s4', 'model-s4', 'attached']);
    assert.deepEqual([rebind.fromSessionId, rebind.toSessionId, rebind.confirmedStopped], ['s1', 's4', true]);
    const roles = f.app.store.collaborationMemberRoles(f.cluster.id).find((m) => m.memberId === f.a.id)?.roleIds;
    assert.deepEqual(roles, [role.id]);
    await waitFor(async () => (await f.notices()).every((m) => m.deliveries.every((d: any) => d.state === 'done')), 'the notice delivered');
    assert.deepEqual(f.app.store.unreadIds(f.a.id, f.cluster.id), unread, 'the unread position did not move');
    assert.equal(f.app.hub.listMembers(f.cluster.id).length, 3, 'no member was added');
  } finally { await f.finish(); }
});

test('member rebind: the new conversation starts and submits in-progress tasks; the old conversation no longer is the member', async () => {
  const f = await fixture();
  try {
    const accepted = f.task(f.a, 'accepted', 'accepted');
    const working = f.task(f.a, 'working', 'working');
    await f.move(f.a, 's4');

    const rpc = async (session: string, method: string, params: unknown) => (await (await rawFetch(`${f.app.url}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'x-orrery-bridge': JSON.parse(readFileSync(join(f.app.home, 'hub.json'), 'utf8')).secret, 'x-orrery-session': session, 'x-orrery-harness': 'mock' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json()).result;
    assert.deepEqual(f.app.hub.nativeCallers('mock', 's1'), [], 'no identity left for the old conversation');
    assert.equal((await rpc('s1', 'tools/call', { name: 'read_messages', arguments: {} })).isError, true);
    assert.equal((await rpc('s4', 'tools/call', { name: 'read_messages', arguments: {} })).isError, undefined);

    const started = f.send(f.as(f.a), { action: 'task.start', taskId: accepted.task.id, expectedRevision: accepted.task.revision, assignmentId: accepted.assignmentId });
    assert.equal(started.task.status, 'working');
    const submitted = f.send(f.as(f.a), { action: 'task.submit', taskId: working.task.id, expectedRevision: working.task.revision, assignmentId: working.assignmentId,
      summary: 'done', evidenceMessageIds: [f.evidence.id] });
    assert.equal(submitted.task.status, 'review', 'a move does not change the task revision');
    assert.deepEqual([...submitted.submission.contributorKeys].sort(), [key('s1'), key('s4')]);
    const [assignment] = f.view(working.task.id).assignments;
    assert.deepEqual([assignment.memberId, assignment.actorKey, assignment.formerActorKeys], [f.a.id, key('s4'), [key('s1')]]);
  } finally { await f.finish(); }
});

test('member rebind: only the user, through the web API, with a stop confirmation', async () => {
  const f = await fixture();
  try {
    const path = `${f.app.url}/api/members/${f.a.id}/session`;
    const body = JSON.stringify({ harness: 'mock', sessionId: 's4', confirmStopped: true });
    const json = { 'content-type': 'application/json' };
    assert.equal((await rawFetch(path, { method: 'POST', body, headers: json })).status, 401, 'no token, no move');
    assert.equal((await rawFetch(path, { method: 'POST', body, headers: { ...json, authorization: 'Bearer nope' } })).status, 401);
    await assert.rejects(f.move(f.a, 's4', { confirmStopped: false }), /confirmStopped/);
    await assert.rejects(f.app.api('POST', `/api/members/${f.a.id}/session`, { harness: 'mock', sessionId: 's4' }), /confirmStopped/);

    const secret = JSON.parse(readFileSync(join(f.app.home, 'hub.json'), 'utf8')).secret;
    const listed = await (await rawFetch(`${f.app.url}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-session': 's1', 'x-orrery-harness': 'mock' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })).json();
    assert.ok(listed.result.tools.length > 5);
    assert.ok(!listed.result.tools.some((t: { name: string }) => /rebind|session|conversation/i.test(t.name)), 'no MCP tool moves a member');
    f.send(f.user, { action: 'coordinator.set', memberId: f.b.id, enabled: true, mode: 'execute' });
    assert.throws(() => f.send(f.as(f.b), { action: 'member.rebind', memberId: f.a.id, generation: 1 }), /unsupported/, 'not a collaboration action either');
    assert.equal(f.app.store.getMember(f.a.id)!.workerSessionId, 's1');
    assert.deepEqual(await f.history(f.a), []);
  } finally { await f.finish(); }
});

test('member rebind: a different harness, a taken target and the same conversation are refused', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.move(f.a, 'f1', { harness: 'foreign' }), /same harness/);
    await assert.rejects(f.move(f.a, 's2'), /already a member/, 'a member of this cluster');
    await assert.rejects(f.move(f.a, 's1'), /already bound/);
    await assert.rejects(f.move(f.a, 'nope'), /not found/);
    assert.equal(f.app.store.getMember(f.a.id)!.workerSessionId, 's1');
    assert.deepEqual(await f.history(f.a), [], 'a refused move leaves no record');
  } finally { await f.finish(); }
});

test('member rebind: a target in another cluster and one with another directory are allowed', async () => {
  const f = await fixture();
  try {
    const { cluster: other } = await f.app.hub.createCluster('other', [{ harness: 'mock', mode: 'native', sessionId: 's5', name: 'X' }]);
    const listed = await f.app.api('GET', `/api/harnesses/mock/sessions?mode=native&project=${encodeURIComponent(f.project)}`);
    assert.deepEqual(listed.find((s: any) => s.id === 's5').memberships.map((m: any) => m.clusterName), ['other'], 'the picker shows where it already is');
    const { member } = await f.move(f.a, 's5');
    assert.equal(member.workerSessionId, 's5');
    assert.deepEqual(f.app.hub.nativeCallers('mock', 's5').map((m) => m.clusterId).sort(), [f.cluster.id, other.id].sort());
    const { member: again } = await f.move(f.b, 's6');
    assert.equal(again.cwd, f.elsewhere);
    assert.deepEqual([...await f.history(f.b)].map((r) => [r.fromCwd, r.toCwd]), [[f.project, f.elsewhere]]);
  } finally { await f.finish(); }
});

test('member rebind: old and new conversations both count as participants; neither reviews, a worker conversation is refused as reviewer', async () => {
  const f = await fixture();
  try {
    const reviewed = f.task(f.a, 'reviewed', 'review', f.c);
    const open = f.task(f.a, 'open', 'working');
    assert.deepEqual(f.view(reviewed.task.id).submissions[0].contributorKeys, [key('s1')]);
    await f.move(f.a, 's4');
    assert.deepEqual(f.view(reviewed.task.id).submissions[0].contributorKeys, [key('s1'), key('s4')], 'the undecided submission names both');

    const nominate = (taskId: string, reviewer: { id: string }) => f.send(f.user, { action: 'task.edit', taskId, expectedRevision: f.view(taskId).task.revision, reviewer: f.as(reviewer) });
    assert.throws(() => nominate(open.task.id, f.a), /participated in the task/, 'the new conversation');

    const { members: [again] } = await f.app.api('POST', `/api/clusters/${f.cluster.id}/members`, { members: [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'Again' }] });
    assert.notEqual(again.id, f.a.id);
    assert.throws(() => nominate(open.task.id, again), /participated in the task/, 'the old conversation, back as another member');
    assert.equal(nominate(open.task.id, f.b).task.reviewer.memberId, f.b.id, 'someone who did not work on it is fine');
  } finally { await f.finish(); }
});

test('member rebind: a reviewer cannot move onto a conversation that worked on a task it still has to review', async () => {
  const f = await fixture();
  try {
    const reviewed = f.task(f.a, 'reviewed', 'review', f.c);
    await f.move(f.a, 's4');
    const chatBefore = (await f.notices()).length;
    await assert.rejects(f.move(f.c, 's1'), /change the reviewer first.*reviewed/, 'the old conversation of the worker');
    await f.app.api('DELETE', `/api/clusters/${f.cluster.id}/members/${f.a.id}`, {});
    await assert.rejects(f.move(f.c, 's4'), /change the reviewer first.*reviewed/, 'the new conversation of the worker');
    assert.equal(f.app.store.getMember(f.c.id)!.workerSessionId, 's3', 'the binding did not change');
    assert.deepEqual(await f.history(f.c), [], 'no record');
    assert.equal((await f.notices()).length, chatBefore, 'no notice');
    assert.deepEqual(f.view(reviewed.task.id).assignments[0].formerActorKeys, [key('s1')], 'the task records did not change');

    await f.move(f.c, 's5');
    const done = f.send(f.as(f.c), { action: 'task.review', taskId: reviewed.task.id, expectedRevision: f.view(reviewed.task.id).task.revision,
      submissionId: reviewed.submissionId, verdict: 'approve', reason: 'looks fine' });
    assert.equal(done.task.status, 'completed', 'an independent conversation may review');
    await f.move(f.c, 's1');
    assert.equal(f.app.store.getMember(f.c.id)!.workerSessionId, 's1', 'a finished task no longer stands in the way');
  } finally { await f.finish(); }
});

test('member rebind: a late online check of the old conversation does not decide the queue that moved', async () => {
  for (const [late, target, reaches] of [[false, 'online', true], [true, 'offline', false]] as const) {
    const f = await fixture();
    try {
      const held = Promise.withResolvers<boolean>();
      f.native.confirmOnline = (session) => (session === 's1' ? held.promise : Promise.resolve(!f.offline.has(session)));
      const queued = f.app.hub.sendFromUser(f.cluster.id, '@A follow-me');
      if (target === 'offline') f.offline.add('s4');
      await f.move(f.a, 's4');
      const state = async () => (await f.app.messages(f.cluster.id)).find((m) => m.id === queued.id)!.deliveries[0].state;
      assert.equal(await state(), 'queued', 'still waiting for a check');
      held.resolve(late);
      await waitFor(async () => (await state()) === (reaches ? 'done' : 'offline'), `the check of the new ${target} conversation decides`);
      assert.equal(f.delivered('s4').some((d) => d.text.includes('follow-me')), reaches);
      assert.deepEqual(f.delivered('s1'), [], 'nothing went to the old conversation');
    } finally { await f.finish(); }
  }
});

test('member rebind: a later submission and the idle notice also count the old conversation', async () => {
  const f = await fixture({ idleCheckMs: 600_000, idleSweepMs: 600_000, idleTaskGraceMs: 0, idleMemberGraceMs: 0 });
  try {
    const t = f.task(f.a, 'stuck', 'working', f.b);
    await f.move(f.a, 's4');
    const submitted = f.send(f.as(f.a), { action: 'task.submit', taskId: t.task.id, expectedRevision: t.task.revision, assignmentId: t.assignmentId, summary: 'r', evidenceMessageIds: [f.evidence.id] });
    assert.deepEqual([...submitted.submission.contributorKeys].sort(), [key('s1'), key('s4')]);

    f.send(f.user, { action: 'coordinator.set', memberId: f.c.id, enabled: true, mode: 'execute' });
    f.offline.add('s2');
    const { members: [again, fresh] } = await f.app.api('POST', `/api/clusters/${f.cluster.id}/members`, { members: [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'Again' }, { harness: 'mock', mode: 'native', sessionId: 's5', name: 'Fresh' }] });
    (f.app.hub.services.get('tasks') as TasksService).checkIdle(f.cluster.id);
    const notice = (await f.notices()).find((m) => m.body.startsWith('有成员空闲'));
    assert.ok(notice, 'the idle notice was written');
    const reviewPart = notice.body.split('验收：')[1];
    assert.ok(reviewPart.includes(fresh.name), 'an uninvolved idle member is offered');
    assert.ok(!reviewPart.includes(again.name), 'the old conversation is not');
  } finally { await f.finish(); }
});

test('member rebind: the new conversation can resubmit a completed task; the old one, back as another member, cannot', async () => {
  const f = await fixture();
  try {
    const create = (title: string, dependencyIds: string[] = []) =>
      f.send(f.user, { action: 'task.create', title, scope: title, acceptance: 'done', mergeRequired: false, dependencyIds }).task;
    const complete = (member: { id: string }, created: any) => {
      const claim = f.send(f.as(member), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
      const started = f.send(f.as(member), { action: 'task.start', taskId: created.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id }).task;
      const submitted = f.send(f.as(member), { action: 'task.submit', taskId: created.id, expectedRevision: started.revision, assignmentId: claim.assignment.id, summary: 'r', evidenceMessageIds: [f.evidence.id] });
      const task = f.send(f.user, { action: 'task.review', taskId: created.id, expectedRevision: submitted.task.revision, submissionId: submitted.submission.id, verdict: 'approve', reason: 'ok' }).task;
      return { task, assignmentId: claim.assignment.id as string };
    };
    let upstream = complete(f.b, create('upstream'));
    const downstream = complete(f.a, create('downstream', [upstream.task.id]));
    await f.move(f.a, 's4');
    upstream = complete(f.b, f.send(f.user, { action: 'task.reopen', taskId: upstream.task.id, expectedRevision: upstream.task.revision, reason: 'again' }).task);
    const versions = { [upstream.task.id]: upstream.task.approvedSubmissionId };
    const retry = () => ({ action: 'task.submit', taskId: downstream.task.id, expectedRevision: f.view(downstream.task.id).task.revision, assignmentId: downstream.assignmentId,
      summary: 'rechecked', evidenceMessageIds: [f.evidence.id], expectedDependencyVersions: versions });
    const { members: [again] } = await f.app.api('POST', `/api/clusters/${f.cluster.id}/members`, { members: [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'Again' }] });
    assert.throws(() => f.send(f.as(again), retry()), /prior executor/);
    assert.equal(f.send(f.as(f.a), retry()).task.status, 'review');
  } finally { await f.finish(); }
});

test('member rebind: every move is recorded, in the chat too, and the history can only grow', async () => {
  const f = await fixture();
  try {
    await f.move(f.a, 's4');
    const [first] = await f.history(f.a);
    assert.equal(first.memberId, f.a.id);
    assert.deepEqual([first.fromSessionId, first.toSessionId, first.confirmedStopped, first.harness], ['s1', 's4', true, 'mock']);
    assert.ok(Date.parse(first.at) > 0);
    await f.move(f.a, 's5');
    const records = await f.history(f.a);
    assert.deepEqual(records.map((r) => [r.fromSessionId, r.toSessionId]), [['s1', 's4'], ['s4', 's5']]);
    assert.deepEqual(records[0], first, 'the earlier record did not change');
    const seqs = f.app.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'published in seq order: the page drops anything older than what it has seen');
    const chat = await f.notices();
    assert.equal(chat.length, 2, 'one system message per move');
    assert.ok(chat.every((m) => m.kind === 'system' && m.body.includes('已确认原对话停止')));
    assert.ok(chat[1].body.includes('s4') && chat[1].body.includes('s5'));

    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      const res = await rawFetch(`${f.app.url}/api/members/${f.a.id}/session-history`, { method, headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 404, method);
    }
    await f.app.api('DELETE', `/api/clusters/${f.cluster.id}/members/${f.a.id}`, {});
    assert.equal((await f.history(f.a)).length, 2, 'a removed member keeps its history');
  } finally { await f.finish(); }
});

test('member rebind: the member and the coordinator are woken with the tasks in hand', async () => {
  const f = await fixture();
  try {
    const working = f.task(f.a, 'still-working', 'working', f.b);
    const review = f.task(f.b, 'to-review', 'review', f.a);
    const other = f.task(f.b, 'not-mine', 'working');
    f.send(f.user, { action: 'coordinator.set', memberId: f.c.id, enabled: true, mode: 'execute' });
    await waitFor(() => f.delivered('s3').length, 'the coordinator policy notice');
    const before = f.delivered('s1').length;
    const coordinatorBefore = f.delivered('s3').length;

    await f.move(f.a, 's4');
    await waitFor(() => f.delivered('s4').length && f.delivered('s3').length > coordinatorBefore, 'both woken');
    const notice = (await f.notices()).at(-1)!;
    assert.deepEqual([...notice.mentions].sort(), [f.a.id, f.c.id].sort());
    assert.deepEqual(notice.deliveries.map((d: any) => d.memberId).sort(), [f.a.id, f.c.id].sort());
    assert.ok(notice.body.includes(working.task.id) && notice.body.includes(review.task.id));
    assert.ok(!notice.body.includes(other.task.id), 'only what is in this member\'s hands');
    assert.deepEqual([...notice.taskIds].sort(), [working.task.id, review.task.id].sort());
    assert.ok(f.delivered('s4')[0].text.includes('still-working'));
    assert.ok(f.delivered('s3').at(-1)!.text.includes('still-working'));
    assert.equal(f.delivered('s1').length, before, 'nothing more goes to the old conversation');
  } finally { await f.finish(); }
});

test('member rebind: a moved coordinator gets the handover summary and keeps its post and unread', async () => {
  const f = await fixture();
  try {
    const t = f.task(f.a, 'in-flight-task', 'working');
    f.send(f.user, { action: 'coordinator.set', memberId: f.c.id, enabled: true, mode: 'execute' });
    f.send(f.user, { action: 'coordinator.instruction.add', instructionText: 'always ask first' });
    const generation = f.app.store.coordinator!.policy(f.cluster.id)!.generation;
    f.offline.add('s3');
    const missed = f.app.hub.sendFromUser(f.cluster.id, '@C missed');
    f.offline.delete('s3');
    await waitFor(() => f.app.store.unreadIds(f.c.id, f.cluster.id).includes(missed.id), 'unread');

    await f.move(f.c, 's4');
    const notice = (await f.notices()).at(-1)!;
    assert.deepEqual(notice.mentions, [f.c.id], 'one message: it is both the member and the coordinator');
    for (const part of ['用户长期要求', 'always ask first', '待处理事项', '未完成任务', 'in-flight-task', '前任最后一条发言时间', `第 ${generation} 代`]) assert.ok(notice.body.includes(part), part);
    assert.ok(notice.taskIds.includes(t.task.id));
    const policy = f.app.store.coordinator!.policy(f.cluster.id)!;
    assert.deepEqual([policy.memberId, policy.generation], [f.c.id, generation], 'still the coordinator, same generation');
    assert.ok(f.app.store.unreadIds(f.c.id, f.cluster.id).includes(missed.id), 'unlike a handover, its unread is not skipped');
    await waitFor(() => f.delivered('s4').some((d) => d.text.includes('always ask first')), 'delivered to the new conversation');
  } finally { await f.finish(); }
});

test('member rebind: an in-flight turn ends unknown and stays unread; its late completion changes nothing and it still occupies the old conversation', async () => {
  const f = await fixture();
  try {
    const { cluster: other, members: [sibling] } = await f.app.hub.createCluster('other', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'Sib' }]);
    f.hold('s1');
    f.hold('s4');
    const running = f.app.hub.sendFromUser(f.cluster.id, '@A running');
    await waitFor(() => f.delivered('s1').length === 1, 'the held turn');
    const waiting = f.app.hub.sendFromUser(other.id, '@Sib waiting');
    const deliveryOf = async (clusterId: string, id: string) => (await f.app.messages(clusterId)).find((m) => m.id === id)!.deliveries[0];

    await f.move(f.a, 's4');
    const interrupted = await deliveryOf(f.cluster.id, running.id);
    assert.deepEqual([interrupted.state, interrupted.outcome], ['failed', 'unknown']);
    assert.match(interrupted.error!, /换对话/);
    assert.ok(f.app.store.unreadIds(f.a.id, f.cluster.id).includes(running.id));
    assert.equal(f.app.hub.listMembers(other.id).find((m) => m.id === sibling.id)!.status, 'busy', 'the old conversation is still running that turn');
    assert.equal((await deliveryOf(other.id, waiting.id)).state, 'queued');
    await waitFor(() => f.delivered('s4').length === 1, 'the notice runs in the new conversation meanwhile');

    f.release('s1');
    await waitFor(async () => (await deliveryOf(other.id, waiting.id)).state === 'done', 'the sibling goes next');
    const later = await deliveryOf(f.cluster.id, running.id);
    assert.deepEqual([later.state, later.outcome], ['failed', 'unknown'], 'the late completion did not overwrite it');
    assert.ok(f.app.store.unreadIds(f.a.id, f.cluster.id).includes(running.id));
    assert.equal(f.app.hub.listMembers(f.cluster.id).find((m) => m.id === f.a.id)!.status, 'busy', 'the new conversation\'s own run is untouched');
    assert.equal(f.delivered('s1').length, 2, 'only the running turn and the sibling reached the old conversation');
    f.release('s4');
    await waitFor(() => f.app.hub.listMembers(f.cluster.id).find((m) => m.id === f.a.id)!.status === 'idle', 'the new run ends normally');
  } finally { await f.finish(); }
});

test('member rebind: queued deliveries follow the member; to an offline conversation they end offline and are not resent', async () => {
  const f = await fixture();
  try {
    f.hold('s1');
    f.app.hub.sendFromUser(f.cluster.id, '@A first');
    await waitFor(() => f.delivered('s1').length === 1, 'the held turn');
    f.app.hub.sendFromUser(f.cluster.id, '@A queued');
    await f.move(f.a, 's4');
    await waitFor(() => f.delivered('s4').some((d) => d.text.includes('queued')), 'a queued message goes to the new conversation');
    f.release('s1');

    f.hold('s4');
    await waitFor(() => f.app.hub.listMembers(f.cluster.id).find((m) => m.id === f.a.id)!.status === 'idle', 'idle again');
    const second = f.app.hub.sendFromUser(f.cluster.id, '@A second');
    await waitFor(() => f.delivered('s4').some((d) => d.text.includes('second')), 'held on s4');
    const third = f.app.hub.sendFromUser(f.cluster.id, '@A third');
    f.offline.add('s5');
    const { member } = await f.move(f.a, 's5');
    assert.equal(member.status, 'offline', 'allowed, and the answer says so');
    await waitFor(async () => (await f.app.messages(f.cluster.id)).find((m) => m.id === third.id)!.deliveries[0].state === 'offline', 'the queued one ends offline');
    f.offline.delete('s5');
    f.app.hub.setPaused(true);
    f.app.hub.setPaused(false);
    await new Promise((ok) => setTimeout(ok, 30));
    assert.deepEqual(f.delivered('s5'), [], 'never resent or woken');
    const unread = f.app.store.unreadIds(f.a.id, f.cluster.id);
    assert.ok(unread.includes(second.id) && unread.includes(third.id), 'both stay unread for it to read later');
  } finally { await f.finish(); }
});

test('member rebind: the new conversation gets the unread hint even though the count did not change', async () => {
  const f = await fixture();
  try {
    f.offline.add('s1');
    const missed = f.app.hub.sendFromUser(f.cluster.id, '@A missed');
    f.offline.delete('s1');
    await waitFor(() => f.app.store.unreadIds(f.a.id, f.cluster.id).includes(missed.id), 'the message left unread');
    const counts = f.app.store.unreadHintCounts(f.a.id, f.cluster.id);
    const hint = f.app.hub.unreadHintFor('mock', 's1');
    assert.match(hint, /未读 \d+：/);
    assert.equal(f.app.hub.unreadHintFor('mock', 's1'), '', 'the old conversation was told once');

    await f.move(f.a, 's4');
    await waitFor(async () => (await f.notices()).every((m) => m.deliveries.every((d: any) => d.state === 'done')), 'the notice delivered');
    await waitFor(() => f.app.store.unreadHintCounts(f.a.id, f.cluster.id).total === counts.total, 'the notice read by delivery');
    assert.equal(f.app.hub.unreadHintFor('mock', 's1'), '', 'the old conversation is nobody now');
    assert.equal(f.app.hub.unreadHintFor('mock', 's4'), hint, 'the new conversation has never been told');
    assert.equal(f.app.hub.unreadHintFor('mock', 's4'), '', 'and is told once');
  } finally { await f.finish(); }
});

test('member rebind: the DeepSeek activity bridge is told the new conversation', async () => {
  const dir = tempDir();
  const sessions = ['d1', 'd2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'deepseek', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { deepseek: native } });
  try {
    const { members: [member] } = await app.hub.createCluster('activity', [{ harness: 'deepseek', mode: 'native', sessionId: 'd1', name: 'D' }]);
    const frames: { observerId: string; sessions: string[] }[] = [];
    const disconnect = app.hub.connectBridge('deepseek', null, { send() {}, close() {}, sendActivity(frame) { frames.push(frame); } });
    app.hub.sendFromMember(member.id, 'participates');
    assert.deepEqual(frames.at(-1)?.sessions, ['d1']);
    const observer = frames.at(-1)!.observerId;
    await app.api('POST', `/api/members/${member.id}/session`, { harness: 'deepseek', sessionId: 'd2', confirmStopped: true });
    assert.deepEqual(frames.at(-1)?.sessions, ['d2']);
    assert.notEqual(frames.at(-1)!.observerId, observer, 'a new epoch: late reports from the old conversation are refused');
    assert.equal(app.hub.recordBridgeActivity(observer, 'd1', 1, { kind: 'turn', phase: 'started' }), false);
    disconnect();
  } finally { await app.close(); }
});
