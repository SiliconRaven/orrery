// The simplified flow's assignment (docs/collaboration.md): one executor field, no accepted state, and an old database
// whose rows are projected on read and never rewritten until a task is next changed.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Assignment, CollaborationActor, CollaborationCommand, Task, TaskResult, WorkspaceResult } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { collaborationRecords, saveCollaborationRecord } from '../src/plugins/tasks/store.ts';
import { tempDir } from './helpers.ts';

const user: CollaborationActor = { kind: 'user' };
const as = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const MEMBERS = ['a', 'b', 'c'];

function driver(t: TestContext, store: Store) {
  const hub = new Hub({ store, nativeAdapters: {}, });
  t.after(async () => { await hub.close(); });
  let serial = 0;
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
    hub.collaboration.command(actor, 'c', { ...command, operationId: `op-${++serial}` });
  const read = (taskId: string) => hub.collaboration.query(user, 'c', { kind: 'task', taskId }) as TaskResult;
  const act = (actor: CollaborationActor, taskId: string, command: Partial<CollaborationCommand> & { action: CollaborationCommand['action'] }) =>
    send(actor, { taskId, expectedRevision: read(taskId).task.revision, ...command });
  const workspace = (query: Record<string, unknown>) => hub.collaboration.query(user, 'c', { kind: 'workspace', ...query }) as WorkspaceResult;
  return { hub, send, read, act, workspace };
}

function fresh(t: TestContext) {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, MEMBERS.map(memberRow));
  const d = driver(t, store);
  t.after(() => store.close());
  const create = (actor: CollaborationActor, extra: Partial<CollaborationCommand> = {}) =>
    d.send(actor, { action: 'task.create', title: 'work', scope: 's', acceptance: 'done', ...extra }).task!;
  return { store, ...d, create };
}

const memberRow = (id: string) => ({
  id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null, mode: 'native' as const,
  workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null,
});

test('create_task: the named executor, else the creator when eligible, else nobody', (t) => {
  const f = fresh(t);
  assert.equal(f.create(as('a')).assignedMemberId, 'a', 'a member who can do it does it');
  assert.equal(f.create(user).assignedMemberId, null, 'the user executes nothing');
  assert.equal(f.create(as('a'), { memberId: 'b' }).assignedMemberId, 'b');
  assert.equal(f.create(as('a'), { memberId: null }).assignedMemberId, null, 'null leaves it unassigned');

  const role = f.send(user, { action: 'role.create', name: 'builder' }).role!.id;
  assert.equal(f.create(as('a'), { executeRoleIds: [role] }).assignedMemberId, null, 'without the roles the creator is not the executor');
  assert.throws(() => f.create(as('a'), { executeRoleIds: [role], memberId: 'b' }), code('ROLE_REQUIRED'));
  assert.equal(f.create(as('a'), { reviewer: as('a') }).assignedMemberId, null, 'a creator who reviews does not also execute');
  assert.throws(() => f.create(user, { reviewer: as('b'), memberId: 'b' }), code('REVIEW_NOT_INDEPENDENT'));

  f.send(user, { action: 'coordinator.set', memberId: 'c', enabled: true, mode: 'execute' });
  const generation = (f.workspace({}).coordinator as { generation: number }).generation;
  assert.equal(f.create(as('c'), { generation }).assignedMemberId, null, 'the coordinator does not execute');
  assert.throws(() => f.create(as('c'), { generation, memberId: 'c' }), code('FORBIDDEN'));
  assert.equal(f.create(as('a'), { memberId: 'b' }).status, 'pending');
});

test('an assigned executor starts directly; start creates the assignment and nobody else can', (t) => {
  const f = fresh(t);
  const task = f.create(user, { memberId: 'a' });
  assert.equal(task.currentAssignmentId, null, 'no assignment until work starts');
  assert.deepEqual(f.read(task.id).assignments, []);
  assert.throws(() => f.act(as('b'), task.id, { action: 'task.start' }), code('STALE_ASSIGNMENT'));
  const started = f.act(as('a'), task.id, { action: 'task.start' });
  assert.equal(started.task!.status, 'working');
  assert.equal(started.task!.currentAssignmentId, started.assignment!.id);
  assert.equal(started.assignment!.startedAt, started.assignment!.acceptedAt);
  assert.throws(() => f.act(as('a'), task.id, { action: 'task.start' }), code('INVALID_STATE'));
  assert.throws(() => f.act(as('b'), task.id, { action: 'task.assign', memberId: 'b' }), code('FORBIDDEN'), 'only the creator or coordinator hand it on');
  assert.throws(() => f.act(user, task.id, { action: 'task.assign', memberId: 'b' }), code('TASK_ALREADY_CLAIMED'), 'started work is handed off instead');
});

test('assign sets, replaces and clears the executor and tells both sides', (t) => {
  const f = fresh(t);
  const task = f.create(user);
  const first = f.act(user, task.id, { action: 'task.assign', memberId: 'a' });
  assert.equal(first.task!.assignedMemberId, 'a');
  const told = (eventId: number) => f.hub.store.listMessages('c', 100).find((m) => m.collabEventId === eventId)!;
  assert.match(told(first.eventId).body, /已分配给 a/);
  assert.deepEqual(told(first.eventId).mentions, ['a']);
  const swapped = f.act(user, task.id, { action: 'task.assign', memberId: 'b' });
  assert.deepEqual(told(swapped.eventId).mentions.sort(), ['a', 'b'], 'the old executor hears that it moved');
  const cleared = f.act(user, task.id, { action: 'task.assign', memberId: null });
  assert.equal(cleared.task!.assignedMemberId, null);
  assert.match(told(cleared.eventId).body, /执行者已清除/);

  assert.equal(f.act(as('a'), task.id, { action: 'task.assign', memberId: 'a' }).task!.assignedMemberId, 'a', 'a task nobody holds can be picked up');
  assert.throws(() => f.act(as('b'), task.id, { action: 'task.assign', memberId: 'b' }), code('FORBIDDEN'), 'but not taken from its executor');
  f.send(user, { action: 'coordinator.set', memberId: 'c', enabled: true, mode: 'execute' });
  assert.throws(() => f.act(user, task.id, { action: 'task.assign', memberId: 'c' }), code('FORBIDDEN'), 'the coordinator cannot be given work');
  const reviewed = f.create(user, { reviewer: as('b') });
  assert.throws(() => f.act(user, reviewed.id, { action: 'task.assign', memberId: 'b' }), code('REVIEW_NOT_INDEPENDENT'));
  f.act(user, reviewed.id, { action: 'task.assign', memberId: 'a' });
  assert.throws(() => f.act(user, reviewed.id, { action: 'task.edit', reviewer: as('a') }), code('REVIEW_NOT_INDEPENDENT'), 'nor can the executor be made the reviewer');
});

test('an assigned executor who has not started can give the task back', (t) => {
  const f = fresh(t);
  const task = f.create(user, { memberId: 'a' });
  assert.throws(() => f.act(as('b'), task.id, { action: 'task.release', reason: 'not mine' }), code('FORBIDDEN'));
  const released = f.act(as('a'), task.id, { action: 'task.release', reason: 'no time' }).task!;
  assert.deepEqual([released.status, released.assignedMemberId], ['pending', null]);
  const other = f.create(user, { memberId: 'a' });
  const handed = f.act(as('a'), other.id, { action: 'task.handoff', memberId: 'b', reason: 'b knows this' }).task!;
  assert.equal(handed.assignedMemberId, 'b');
});

test('a handoff waits for approval like an assignment; cancelling a gated task still works', (t) => {
  const f = fresh(t);
  const task = f.create(user, { requiresApproval: true, memberId: 'a' });
  const before = f.hub.store.listMessages('c', 100).length;
  for (const actor of [as('a'), user]) {
    assert.throws(() => f.act(actor, task.id, { action: 'task.handoff', memberId: 'b', reason: 'b knows this' }), code('APPROVAL_REQUIRED'));
  }
  assert.equal(f.read(task.id).task.assignedMemberId, 'a');
  assert.equal(f.hub.store.listMessages('c', 100).length, before, 'nobody is told');
  assert.equal(f.act(user, task.id, { action: 'task.cancel', reason: 'dropped' }).task!.status, 'cancelled');
});

test('a handoff cannot target the enabled coordinator', (t) => {
  const f = fresh(t);
  f.send(user, { action: 'coordinator.set', memberId: 'c', enabled: true, mode: 'execute' });
  const task = f.create(user, { memberId: 'a' });
  assert.throws(() => f.act(as('a'), task.id, { action: 'task.handoff', memberId: 'c', reason: 'c is free' }), code('FORBIDDEN'));
  assert.equal(f.read(task.id).task.assignedMemberId, 'a');
});

test('start checks an assignmentId only when one is given', (t) => {
  const f = fresh(t);
  const claimed = f.create(user);
  const claim = f.act(as('a'), claimed.id, { action: 'task.claim' });
  assert.throws(() => f.act(as('a'), claimed.id, { action: 'task.start', assignmentId: 'old-assignment' }), code('STALE_ASSIGNMENT'));
  assert.equal(f.read(claimed.id).task.status, 'pending');
  assert.equal(f.act(as('a'), claimed.id, { action: 'task.start', assignmentId: claim.assignment!.id }).task!.status, 'working');

  const assigned = f.create(user, { memberId: 'a' });
  assert.throws(() => f.act(as('a'), assigned.id, { action: 'task.start', assignmentId: 'old-assignment' }), code('STALE_ASSIGNMENT'), 'there is no assignment yet to match');
  assert.equal(f.act(as('a'), assigned.id, { action: 'task.start' }).task!.status, 'working');
});

test('the deprecated nominate and claim still work for sessions with a cached tool list', (t) => {
  const f = fresh(t);
  const task = f.create(user);
  const nominated = f.act(user, task.id, { action: 'task.nominate', memberId: 'a' });
  assert.equal(nominated.task!.assignedMemberId, 'a');
  assert.match(f.hub.store.listMessages('c', 100).find((m) => m.collabEventId === nominated.eventId)!.body, /已分配给 a/);

  // claim → start → submit, each with the assignment the old flow reads from claim's result.
  const claim = f.act(as('a'), task.id, { action: 'task.claim' });
  assert.equal(claim.task!.status, 'pending', 'accepted is gone');
  assert.ok(claim.assignment!.id);
  assert.throws(() => f.act(as('a'), task.id, { action: 'task.claim' }), code('TASK_ALREADY_CLAIMED'));
  assert.throws(() => f.act(as('b'), task.id, { action: 'task.claim' }), code('FORBIDDEN'));
  const started = f.act(as('a'), task.id, { action: 'task.start', assignmentId: claim.assignment!.id });
  assert.equal(started.assignment!.id, claim.assignment!.id);
  const submitted = f.act(as('a'), task.id, { action: 'task.submit', assignmentId: claim.assignment!.id, summary: 'done', commitSha: 'abcdef0', evidenceMessageIds: [f.hub.sendFromUser('c', 'proof').id] });
  assert.equal(submitted.task!.status, 'review');

  const free = f.create(user);
  assert.equal(f.act(as('b'), free.id, { action: 'task.claim' }).task!.assignedMemberId, 'b', 'claim on a free task sets the executor');
  const held = f.create(user, { memberId: 'a' });
  assert.throws(() => f.act(as('b'), held.id, { action: 'task.claim' }), code('FORBIDDEN'), 'as a nomination used to');
});

test('a submission needs no evidence message', (t) => {
  const f = fresh(t);
  const task = f.create(user, { memberId: 'a', mergeRequired: false });
  const started = f.act(as('a'), task.id, { action: 'task.start' });
  const submitted = f.act(as('a'), task.id, { action: 'task.submit', assignmentId: started.assignment!.id, summary: 'done' });
  assert.deepEqual([submitted.task!.status, submitted.submission!.evidenceMessageIds, submitted.submission!.evidenceFileIds], ['review', [], []]);
  assert.throws(() => f.act(as('a'), task.id, { action: 'task.submit', assignmentId: started.assignment!.id, summary: 'x', evidenceMessageIds: ['no-such-message'] }), code('OUT_OF_SCOPE'), 'one that is given must still be real');
});

test('approval still gates assignment and start; a task created with an executor waits for it', (t) => {
  const f = fresh(t);
  const task = f.create(user, { requiresApproval: true, memberId: 'a' });
  assert.equal(task.assignedMemberId, 'a');
  assert.throws(() => f.act(as('a'), task.id, { action: 'task.start' }), code('APPROVAL_REQUIRED'));
  assert.throws(() => f.act(user, task.id, { action: 'task.assign', memberId: 'b' }), code('APPROVAL_REQUIRED'));
  const approved = f.act(user, task.id, { action: 'task.approve', verdict: 'approve' });
  assert.deepEqual(f.hub.store.listMessages('c', 100).find((m) => m.collabEventId === approved.eventId)!.mentions, ['a'], 'the executor is told to go');
  assert.equal(f.act(as('a'), task.id, { action: 'task.start' }).task!.status, 'working');
});

// ---- an old database ----

/** A task row as the Hub wrote it before the simplified flow. */
const oldRow = (id: string, extra: Record<string, unknown>) => JSON.stringify({
  id, clusterId: 'c', title: id, scope: 's', acceptance: 'a', priority: 'normal', createdBy: 'user', originMessageId: null,
  status: 'pending', proposalState: 'active', requiresApproval: false, mergeRequired: true, mergedCommitSha: null, mergedSubmissionId: null,
  revision: 3, definitionVersion: 1, nominatedMemberId: null, reviewer: { kind: 'user' }, executeRoleIds: [], reviewRoleIds: [], labels: [], dependencyIds: [],
  currentAssignmentId: null, latestSubmissionId: null, approvedSubmissionId: null, assignedMemberId: null,
  dependenciesReady: true, dependenciesChanged: false, completionValid: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra,
});
const oldAssignment = (id: string, taskId: string, memberId: string, startedAt: string | null): Assignment => ({
  id, taskId, memberId, actorKey: JSON.stringify(['mock', 'session-' + memberId]), acceptedAt: '2026-01-01', startedAt, endedAt: null, endReason: null, dependencyVersions: {},
});

function upgraded(t: TestContext) {
  const dir = tempDir();
  const path = join(dir, 'old.db');
  const before = new Store(path, new PluginHost(officialPlugins));
  before.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, MEMBERS.map(memberRow));
  const insert = before.db.prepare('INSERT INTO collaboration_tasks (id, cluster_id, data_json) VALUES (?, \'c\', ?)');
  insert.run('accepted', oldRow('accepted', { status: 'accepted', assignedMemberId: 'a', nominatedMemberId: 'a', currentAssignmentId: 'as-accepted' }));
  insert.run('accepted2', oldRow('accepted2', { status: 'accepted', assignedMemberId: 'a', currentAssignmentId: 'as-accepted2' }));
  insert.run('nominated', oldRow('nominated', { nominatedMemberId: 'b' }));
  insert.run('open', oldRow('open', {}));
  insert.run('working', oldRow('working', { status: 'working', assignedMemberId: 'c', nominatedMemberId: 'c', currentAssignmentId: 'as-working' }));
  insert.run('done', oldRow('done', { status: 'completed', nominatedMemberId: 'b' }));
  saveCollaborationRecord(before, 'accepted', 'assignment', oldAssignment('as-accepted', 'accepted', 'a', null));
  saveCollaborationRecord(before, 'accepted2', 'assignment', oldAssignment('as-accepted2', 'accepted2', 'a', null));
  saveCollaborationRecord(before, 'working', 'assignment', oldAssignment('as-working', 'working', 'c', '2026-01-02'));
  before.close();
  const store = new Store(path, new PluginHost(officialPlugins));
  const d = driver(t, store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  return { store, ...d };
}

const raw = (store: Store, id: string) => JSON.parse(String(store.db.prepare('SELECT data_json FROM collaboration_tasks WHERE id = ?').get(id)!.data_json));

test('an upgraded database reads old rows in the new model without rewriting them', (t) => {
  const f = upgraded(t);
  const accepted = f.read('accepted').task;
  assert.deepEqual([accepted.status, accepted.assignedMemberId, accepted.currentAssignmentId], ['pending', 'a', 'as-accepted'], 'accepted is pending with its assignee');
  const nominated = f.read('nominated').task;
  assert.deepEqual([nominated.status, nominated.assignedMemberId], ['pending', 'b'], 'the nominee is the executor');
  assert.equal(f.read('open').task.assignedMemberId, null);
  assert.equal(f.read('done').task.assignedMemberId, null, 'a finished task keeps no executor from an old nomination');
  assert.ok(!('nominatedMemberId' in accepted));

  const pending = f.workspace({ status: 'pending' }).tasks.map((task: Task) => task.id).sort();
  assert.deepEqual(pending, ['accepted', 'accepted2', 'nominated', 'open'], 'the status filter sees through the old value');
  assert.deepEqual(f.workspace({ memberId: 'b', open: true }).tasks.map((task: Task) => task.id), ['nominated'], 'so does the member filter');
  assert.deepEqual(f.store.tasks!.activeLoads('c').map((load) => [load.status, load.assignedMemberId]).sort(),
    [['completed', null], ['pending', 'a'], ['pending', 'a'], ['pending', 'b'], ['pending', null], ['working', 'c']].sort());

  assert.equal(raw(f.store, 'accepted').status, 'accepted', 'reading rewrites nothing');
  assert.equal(raw(f.store, 'nominated').nominatedMemberId, 'b');
});

test('every unfinished old task can continue after the upgrade', (t) => {
  const f = upgraded(t);
  const proof = () => [f.hub.sendFromUser('c', 'proof').id];

  // accepted: the executor starts it on the assignment it already has, and submits with that id.
  const started = f.act(as('a'), 'accepted', { action: 'task.start', assignmentId: 'as-accepted' });
  assert.equal(started.assignment!.id, 'as-accepted');
  assert.equal(raw(f.store, 'accepted').status, 'working');
  assert.equal(f.act(as('a'), 'accepted', { action: 'task.submit', assignmentId: 'as-accepted', summary: 'done', commitSha: 'abcdef0', evidenceMessageIds: proof() }).task!.status, 'review');

  // accepted, then given to someone else: the unstarted assignment ends and the new executor gets their own.
  const moved = f.act(user, 'accepted2', { action: 'task.assign', memberId: 'b' }).task!;
  assert.deepEqual([moved.assignedMemberId, moved.currentAssignmentId], ['b', null]);
  assert.equal(collaborationRecords<Assignment>(f.store, 'accepted2', 'assignment')[0].endReason, 'reassigned');
  assert.throws(() => f.act(as('a'), 'accepted2', { action: 'task.start' }), code('STALE_ASSIGNMENT'));
  assert.notEqual(f.act(as('b'), 'accepted2', { action: 'task.start' }).assignment!.id, 'as-accepted2');

  // nominated: its nominee starts directly.
  assert.equal(f.act(as('b'), 'nominated', { action: 'task.start' }).task!.status, 'working');
  assert.equal(raw(f.store, 'nominated').nominatedMemberId, undefined, 'the row takes the new shape once changed');

  // unassigned: assigned, then started.
  f.act(user, 'open', { action: 'task.assign', memberId: 'c' });
  assert.equal(f.act(as('c'), 'open', { action: 'task.start' }).task!.status, 'working');

  // working: submits on the assignment it has.
  assert.equal(f.act(as('c'), 'working', { action: 'task.submit', assignmentId: 'as-working', summary: 'done', commitSha: 'abcdef0', evidenceMessageIds: proof() }).task!.status, 'review');
});
