import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { actorKey } from '../src/core/collaboration.ts';
import { fingerprint, idleTaskCandidates, memberEligible, type IdleCandidateInput } from '../src/plugins/tasks/idle-candidates.ts';
import type { CollaborationActor, CollaborationCommand, Task } from '../src/core/collaboration-types.ts';
import type { MemberStatus } from '../src/core/types.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, number: 1, clusterId: 'c', title: id, scope: '', acceptance: '', priority: 'normal', createdBy: 'user', originMessageId: null,
  requiresApproval: false, mergeRequired: false, mergedCommitSha: null, mergedSubmissionId: null, fileIds: [],
  status: 'pending', proposalState: 'active', revision: 1, definitionVersion: 1,
  reviewer: { kind: 'user' }, executeRoleIds: [], reviewRoleIds: [], labels: [], dependencyIds: [],
  currentAssignmentId: null, latestSubmissionId: null, approvedSubmissionId: null, assignedMemberId: null,
  dependenciesReady: true, dependenciesChanged: false, completionValid: false, createdAt: '', updatedAt: '', ...extra,
});
const member = (id: string, status: MemberStatus, removedAt: string | null = null) => ({ id, status, removedAt, harness: 'mock', workerSessionId: 's-' + id });
const input = (tasks: Task[], extra: Partial<IdleCandidateInput> = {}): IdleCandidateInput => ({
  tasks,
  members: [member('idle1', 'idle'), member('idle2', 'idle'), member('busy', 'busy'), member('off', 'offline')],
  memberRoles: [], coordinator: null, ...extra,
});
const pairs = (data: IdleCandidateInput) => idleTaskCandidates(data).execute.map((p) => `${p.taskId}:${p.memberId}:${p.reason}`);

test('a pending unassigned task pairs with every idle eligible member', () => {
  assert.deepEqual(pairs(input([task('t')])), ['t:idle1:unassigned', 't:idle2:unassigned']);
});

test('a task assigned to an offline or removed member pairs with the idle members; a busy or idle executor is not stuck', () => {
  assert.deepEqual(pairs(input([task('t1', { assignedMemberId: 'busy' }), task('t2', { assignedMemberId: 'off' })])),
    ['t2:idle1:assignee-offline', 't2:idle2:assignee-offline']);
  // A removed or unknown executor counts as offline.
  assert.deepEqual(pairs(input([task('t', { assignedMemberId: 'gone' })], { members: [member('gone', 'idle', 'x'), member('idle1', 'idle')] })),
    ['t:idle1:assignee-offline']);
  // An idle executor can start it: not a candidate.
  assert.deepEqual(pairs(input([task('t', { assignedMemberId: 'idle1' })])), []);
});

test('an accepted task pairs only when its assignee is offline or out of quota, never just busy', () => {
  const accepted = (id: string, assignedMemberId: string) => task(id, { assignedMemberId, currentAssignmentId: 'as-' + id });
  assert.deepEqual(pairs(input([accepted('t1', 'busy'), accepted('t2', 'off'), accepted('t3', 'idle1')])),
    ['t2:idle1:assignee-offline', 't2:idle2:assignee-offline']);
  assert.deepEqual(pairs(input([accepted('t', 'busy')], { unavailable: ['busy'] })), ['t:idle1:quota-exhausted', 't:idle2:quota-exhausted']);
});

test('working, review, completed, merged, cancelled, proposed and blocked tasks are never candidates', () => {
  const tasks = (['working', 'review', 'completed', 'merged', 'cancelled'] as const)
    .map((status) => task(status, { status, assignedMemberId: 'off' }))
    .concat(task('proposed', { proposalState: 'proposed' }), task('blocked', { dependenciesReady: false }),
      task('blocked-accepted', { assignedMemberId: 'off', dependenciesReady: false }));
  assert.deepEqual(pairs(input(tasks)), []);
});

test('busy, offline, removed, ineligible members and the coordinator are excluded', () => {
  const data = input([task('t', { executeRoleIds: ['r1', 'r2'] })], {
    members: [member('ok', 'idle'), member('partial', 'idle'), member('coord', 'idle'), member('removed', 'idle', 'x'),
      member('busy', 'busy'), member('off', 'offline')],
    memberRoles: ['ok', 'partial', 'coord', 'removed', 'busy', 'off'].map((memberId) =>
      ({ memberId, roleIds: memberId === 'partial' ? ['r1'] : ['r1', 'r2'] })),
    coordinator: { memberId: 'coord', enabled: true },
  });
  assert.deepEqual(pairs(data), ['t:ok:unassigned']);
  // A disabled coordinator is an ordinary member.
  assert.deepEqual(pairs({ ...data, coordinator: { memberId: 'coord', enabled: false } }), ['t:ok:unassigned', 't:coord:unassigned']);
});

test('the designated member reviewer is never an execution candidate even with the required roles', () => {
  const work = task('t', { reviewer: { kind: 'member', memberId: 'idle1' }, executeRoleIds: ['r'] });
  const memberRoles = ['idle1', 'idle2'].map((memberId) => ({ memberId, roleIds: ['r'] }));
  assert.deepEqual(pairs(input([work], { memberRoles })), ['t:idle2:unassigned']);
});

const reviews = (data: IdleCandidateInput) => idleTaskCandidates(data).review.map((p) => `${p.taskId}:${p.memberId}:${p.reason}`);
const inReview = (id: string, reviewerId: string | null, extra: Partial<Task> = {}) => task(id, {
  status: 'review', assignedMemberId: 'busy', reviewer: reviewerId ? { kind: 'member', memberId: reviewerId } : { kind: 'user' }, ...extra,
});

test('a task waiting on an offline or out-of-quota member reviewer pairs with idle eligible non-participants, a busy one does not', () => {
  assert.deepEqual(reviews(input([inReview('t1', 'busy'), inReview('t2', 'off'), inReview('t3', 'gone')])),
    ['t2:idle1:reviewer-offline', 't2:idle2:reviewer-offline', 't3:idle1:reviewer-offline', 't3:idle2:reviewer-offline']);
  assert.deepEqual(reviews(input([inReview('t', 'busy')], { unavailable: ['busy'] })), ['t:idle1:quota-exhausted', 't:idle2:quota-exhausted']);
  assert.deepEqual(idleTaskCandidates(input([inReview('t', 'off')])).execute, [], 'a task in review is never an execute candidate');
  // Review waits are independent of dependency readiness.
  assert.deepEqual(reviews(input([inReview('t', 'off', { dependenciesReady: false })])), ['t:idle1:reviewer-offline', 't:idle2:reviewer-offline']);
});

test('no review pair when the reviewer is idle or the user, or the idle member cannot review', () => {
  assert.deepEqual(reviews(input([inReview('t', 'idle1')])), [], 'an idle reviewer can review it');
  assert.deepEqual(reviews(input([inReview('t', null)])), [], 'a user reviewer never counts');
  const only = (extra: Partial<IdleCandidateInput>) => reviews(input([inReview('t', 'off', { reviewRoleIds: ['r'] })], {
    members: [member('off', 'offline'), member('solo', 'idle')], memberRoles: [{ memberId: 'solo', roleIds: ['r'] }], ...extra }));
  assert.deepEqual(only({}), ['t:solo:reviewer-offline']);
  assert.deepEqual(only({ participants: () => [actorKey(member('solo', 'idle'))] }), [], 'an execution participant cannot review');
  assert.deepEqual(only({ coordinator: { memberId: 'solo', enabled: true } }), [], 'the coordinator cannot review');
  assert.deepEqual(only({ memberRoles: [] }), [], 'a member without the review roles cannot review');
  assert.deepEqual(reviews(input([inReview('t', 'off', { proposalState: 'proposed' })])), [], 'a proposed task is not counted');
});

test('default roles apply independently only when held, and explicit task roles take precedence', () => {
  const tasks = [task('exec'), task('explicit-exec', { executeRoleIds: ['special-exec'] }),
    inReview('review', 'off'), inReview('explicit-review', 'off', { reviewRoleIds: ['special-review'] })];
  const roles = [{ id: 'execute', name: '执行者' }, { id: 'review', name: '验收者' }];
  const data = input(tasks, { roles, memberRoles: [
    { memberId: 'idle1', roleIds: ['execute', 'special-review'] }, { memberId: 'idle2', roleIds: ['review', 'special-exec'] },
  ] });
  assert.deepEqual(pairs(data), ['exec:idle1:unassigned', 'explicit-exec:idle2:unassigned']);
  assert.deepEqual(reviews(data), ['review:idle2:reviewer-offline', 'explicit-review:idle1:reviewer-offline']);

  const offline = { ...data, memberRoles: [{ memberId: 'off', roleIds: ['execute'] }] };
  assert.deepEqual(pairs(offline), [], 'an offline holder still activates the default');
  assert.deepEqual(reviews(offline), ['review:idle1:reviewer-offline', 'review:idle2:reviewer-offline'], 'no review holder permits all eligible idle members');
  const removed = { ...offline, members: offline.members.map((m) => m.id === 'off' ? { ...m, removedAt: 'x' } : m) };
  assert.deepEqual(pairs(removed), ['exec:idle1:unassigned', 'exec:idle2:unassigned'], 'a removed holder does not activate the default');
});

test('fingerprint is stable regardless of input order', () => {
  const tasks = [task('a'), task('b', { assignedMemberId: 'off' })];
  const forward = idleTaskCandidates(input(tasks)).execute;
  const reversed = idleTaskCandidates(input([...tasks].reverse(), { members: [...input([]).members].reverse() })).execute;
  assert.notDeepEqual(forward, reversed);
  assert.equal(fingerprint(forward), fingerprint(reversed));
  assert.equal(fingerprint(forward), 'a:idle1,a:idle2,b:idle1,b:idle2');
  assert.equal(fingerprint([]), '');
});

test('memberEligible agrees with the Hub role check on claim', () => {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const stored = (id: string) => ({
    id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null,
  });
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, [stored('both'), stored('one'), stored('none')]);
  const hub = new Hub({ store, nativeAdapters: {} });
  try {
    let serial = 0;
    const user: CollaborationActor = { kind: 'user' };
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      hub.collaboration.command(actor, 'c', { operationId: 'op-' + ++serial, ...command });
    const r1 = send(user, { action: 'role.create', name: 'r1' }).role!.id;
    const r2 = send(user, { action: 'role.create', name: 'r2' }).role!.id;
    send(user, { action: 'member.roles', memberId: 'both', roleIds: [r1, r2] });
    send(user, { action: 'member.roles', memberId: 'one', roleIds: [r1] });
    const workspace = hub.collaboration.query(user, 'c', { kind: 'workspace' });
    assert.ok('memberRoles' in workspace);
    for (const roleIds of [[], [r1], [r2], [r1, r2]]) {
      for (const memberId of ['both', 'one', 'none']) {
        const t = send(user, { action: 'task.create', title: 't', scope: 's', acceptance: 'a', executeRoleIds: roleIds }).task!;
        let hubSays = true;
        try { send({ kind: 'member', memberId }, { action: 'task.claim', taskId: t.id, expectedRevision: t.revision }); }
        catch (error) { assert.match(String(error), /lacks roles/); hubSays = false; }
        assert.equal(memberEligible(workspace.memberRoles, memberId, roleIds), hubSays, `${memberId} with ${roleIds.length} roles`);
      }
    }
  } finally { store.close(); }
});
