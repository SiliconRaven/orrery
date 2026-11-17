import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import type { CollaborationActor, CollaborationCommand } from '../src/core/collaboration-types.ts';
import { collaborationEvents, saveCollaborationTask } from '../src/plugins/tasks/store.ts';

function fixture(opts: { twins?: boolean } = {}) {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const member = (id: string, name: string, clusterId = 'c') => ({
    id, clusterId, name, avatar: null, harness: 'mock', model: null, effort: null,
    mode: 'native' as const, workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null,
  });
  // The schema forbids equal active names, so a duplicate needs the index gone.
  if (opts.twins) store.db.exec('DROP INDEX members_active_name');
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' },
    [member('id-a', 'alice'), member('id-b', 'bob'), ...(opts.twins ? [member('id-t1', 'twin'), member('id-t2', 'twin')] : [])]);
  store.insertCluster({ id: 'other', name: 'other', category: '', createdAt: '2026-01-01' }, [member('id-x', 'xavier', 'other')]);
  const hub = new Hub({ store, nativeAdapters: {}, });
  let serial = 0;
  const user: CollaborationActor = { kind: 'user' };
  const alice: CollaborationActor = { kind: 'member', memberId: 'id-a' };
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>, clusterId = 'c') =>
    hub.collaboration.command(actor, clusterId, { operationId: 'op-' + ++serial, ...command });
  const create = (title = 'task', extra: Partial<CollaborationCommand> = {}, clusterId = 'c') =>
    send(user, { action: 'task.create', title, scope: 's', acceptance: 'a', ...extra }, clusterId).task!;
  /** Give a stored row a chosen ID, to make prefixes collide. */
  const renameMessage = (id: string, to: string) => store.db.prepare('UPDATE messages SET id = ? WHERE id = ?').run(to, id);
  return { store, hub, user, alice, send, create, renameMessage };
}
const short = (id: string) => id.slice(0, 8);

test('each kind of ID accepts a unique prefix, and what is stored is the full ID', () => {
  const { store, hub, user, alice, send, create } = fixture();
  try {
    const origin = hub.sendFromUser('c', 'origin');
    const dependency = create('dependency');
    const task = create('dependent', { dependencyIds: [short(dependency.id)], originMessageId: short(origin.id) });
    assert.deepEqual(task.dependencyIds, [dependency.id], 'dependencyIds');
    assert.equal(task.originMessageId, origin.id, 'originMessageId');

    const edited = send(user, { action: 'task.edit', taskId: short(task.id), expectedRevision: task.revision, title: 'renamed' }).task!;
    assert.equal(edited.title, 'renamed', 'taskId');
    assert.equal((collaborationEvents(hub.store, 'c', task.id, 0, 10).at(-1)!.payload as any).taskId, task.id, 'the event has the full ID');

    const evidence = hub.sendFromUser('c', 'evidence');
    let free = create('free', { mergeRequired: false });
    const claim = send(alice, { action: 'task.claim', taskId: free.id, expectedRevision: free.revision });
    free = send(alice, { action: 'task.start', taskId: free.id, expectedRevision: claim.task!.revision, assignmentId: claim.assignment!.id }).task!;
    const submitted = send(alice, { action: 'task.submit', taskId: free.id, expectedRevision: free.revision,
      assignmentId: claim.assignment!.id, summary: 'done', evidenceMessageIds: [short(evidence.id)] });
    assert.deepEqual(submitted.submission!.evidenceMessageIds, [evidence.id], 'evidenceMessageIds');

    assert.equal(send(user, { action: 'message.link', messageId: short(evidence.id), taskIds: [task.id] }).messageId, evidence.id, 'message.link');
    assert.equal(send(alice, { action: 'bookmark.set', messageId: short(evidence.id) }).messageId, evidence.id, 'bookmark.set');

    const reply = hub.sendFromMember('id-a', 'answer', short(evidence.id));
    assert.equal(reply.message.replyTo, evidence.id, 'replyTo');
  } finally { store.close(); }
});

test('an ambiguous, unknown or too short prefix asks for the full ID and says how many matched', () => {
  const { store, hub, user, send, create, renameMessage } = fixture();
  try {
    const task = create();
    saveCollaborationTask(store, { ...task, id: 'abcdef12-one', number: 101 });   // copies need numbers of their own
    saveCollaborationTask(store, { ...task, id: 'abcdef12-two', number: 102 });
    const edit = (taskId: string) => send(user, { action: 'task.edit', taskId, expectedRevision: 1, title: 'x' });
    assert.throws(() => edit('abcdef12'), (e: any) => e.code === 'OUT_OF_SCOPE'
      && /unknown task in this cluster: prefix abcdef12 matched 2 items/.test(e.message));
    assert.equal(edit('abcdef12-one').task!.id, 'abcdef12-one', 'a full ID still works when it shares a prefix');
    assert.throws(() => edit('00000000'), /prefix 00000000 matched 0 items/);
    assert.throws(() => edit(task.id.slice(0, 7)), /matched 0 items \(a prefix needs at least 8 characters/);
    assert.throws(() => edit('%%%%%%%%'), /matched 0 items/, 'no wildcards');
    assert.throws(() => edit('ABCDEF12'), /matched 0 items/, 'case-sensitive');

    const first = hub.sendFromUser('c', 'one'); const second = hub.sendFromUser('c', 'two');
    renameMessage(first.id, 'feedface-one'); renameMessage(second.id, 'feedface-two');
    assert.throws(() => send(user, { action: 'bookmark.set', messageId: 'feedface' }), /unknown message: a full ID is needed; prefix feedface matched 2 items/);
    assert.throws(() => hub.sendFromMember('id-a', 'hi', 'feedface'), /unknown message feedface in this cluster: a full ID is needed; prefix feedface matched 2 items/);
    assert.throws(() => hub.sendFromMember('id-a', 'hi', '00000000'), /matched 0 items/);
    assert.throws(() => create('t', { originMessageId: 'feedface' }), /unknown source message: a full ID is needed/);
    assert.throws(() => create('t', { dependencyIds: ['abcdef12'] }), /matched 2 items/);
  } finally { store.close(); }
});

test('a prefix only reaches the current cluster', () => {
  const { store, hub, user, send, create } = fixture();
  try {
    const foreign = create('foreign', {}, 'other');
    const foreignMessage = hub.sendFromUser('other', 'foreign');
    assert.throws(() => send(user, { action: 'task.edit', taskId: short(foreign.id), expectedRevision: 1, title: 'x' }), /matched 0 items/);
    assert.throws(() => send(user, { action: 'task.edit', taskId: foreign.id, expectedRevision: 1, title: 'x' }), /matched 0 items/);
    assert.throws(() => hub.sendFromMember('id-a', 'hi', short(foreignMessage.id)), /matched 0 items/);
  } finally { store.close(); }
});

test('a retry compares the raw request and replays even after its prefix became ambiguous', () => {
  const { store, hub, user, create } = fixture();
  try {
    const task = create();
    const command = { action: 'task.edit', operationId: 'retry', taskId: short(task.id), expectedRevision: 1, title: 'once' } as const;
    const first = hub.collaboration.command(user, 'c', command);
    saveCollaborationTask(store, { ...task, id: short(task.id) + '-twin', number: 101 });
    assert.deepEqual(hub.collaboration.command(user, 'c', command), first);
    assert.throws(() => hub.collaboration.command(user, 'c', { ...command, taskId: task.id }), (e: any) => e.code === 'OPERATION_CONFLICT');
  } finally { store.close(); }
});

test('nominate, handoff and reviewer accept a unique member name', () => {
  const { store, hub, user, alice, send, create } = fixture();
  try {
    const task = create('named', { reviewer: { kind: 'member', memberId: 'alice' } });
    assert.deepEqual(task.reviewer, { kind: 'member', memberId: 'id-a' }, 'reviewer on create');
    const edited = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, reviewer: { kind: 'member', memberId: 'bob' } }).task!;
    assert.deepEqual(edited.reviewer, { kind: 'member', memberId: 'id-b' }, 'reviewer on edit');

    const reset = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: edited.revision, reviewer: { kind: 'user' } }).task!;
    const nominated = send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: reset.revision, memberId: 'alice' }).task!;
    assert.equal(nominated.assignedMemberId, 'id-a', 'nominate');
    assert.equal((collaborationEvents(hub.store, 'c', task.id, 0, 10).at(-1)!.payload as any).memberId, 'id-a', 'the event has the member ID');
    const cleared = send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: nominated.revision, memberId: null }).task!;
    assert.equal(cleared.assignedMemberId, null, 'null still clears');

    const claim = send(alice, { action: 'task.claim', taskId: task.id, expectedRevision: cleared.revision });
    const handed = send(user, { action: 'task.handoff', taskId: task.id, expectedRevision: claim.task!.revision,
      assignmentId: claim.assignment!.id, memberId: 'bob', reason: 'swap' }).task!;
    assert.equal(handed.assignedMemberId, 'id-b', 'handoff');
    assert.throws(() => send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: handed.revision, memberId: 'nobody' }),
      /unknown member in this cluster; list_agents/);
    assert.throws(() => send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: handed.revision, memberId: 'xavier' }),
      /unknown member/, 'a name from another cluster');
  } finally { store.close(); }
});

test('a duplicated member name fails and lists the candidates', () => {
  const { store, user, send, create } = fixture({ twins: true });
  try {
    const task = create();
    assert.throws(() => send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: 1, memberId: 'twin' }),
      /member name twin matches 2 members: id-t1 \(mock\), id-t2 \(mock\); use one of these memberIds/);
    assert.throws(() => create('t', { reviewer: { kind: 'member', memberId: 'twin' } }), /matches 2 members/);
    assert.equal(send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: 1, memberId: 'id-t2' }).task!.assignedMemberId, 'id-t2');
  } finally { store.close(); }
});

test('refusals keep their code and text and add the next step', () => {
  const { store, user, alice, send, create } = fixture();
  try {
    const task = create();
    const check = (fn: () => unknown, code: string, text: RegExp) => assert.throws(fn, (e: any) => e.code === code && text.test(e.message), code);
    check(() => send(user, { action: 'task.edit', taskId: task.id, expectedRevision: 99, title: 'x' }), 'STALE_REVISION',
      /^task revision changed; read the current revision with get_task/);
    check(() => send(alice, { action: 'role.create', name: 'r' }), 'FORBIDDEN', /^this action is not permitted; ask the user or the enabled coordinator/);

    const role = send(user, { action: 'role.create', name: 'builder' }).role!;
    const guarded = create('guarded', { executeRoleIds: [role.id] });
    check(() => send(alice, { action: 'task.claim', taskId: guarded.id, expectedRevision: guarded.revision }), 'ROLE_REQUIRED',
      /lacks roles: builder; ask the user or the coordinator to grant/);

    const claim = send(alice, { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
    check(() => send(alice, { action: 'task.claim', taskId: task.id, expectedRevision: claim.task!.revision }), 'TASK_ALREADY_CLAIMED',
      /^task is not available; read its state with get_task/);
    const started = send(alice, { action: 'task.start', taskId: task.id, expectedRevision: claim.task!.revision, assignmentId: claim.assignment!.id }).task!;
    check(() => send(user, { action: 'task.release', taskId: task.id, expectedRevision: started.revision, assignmentId: claim.assignment!.id, reason: 'stop' }),
      'STOP_CONFIRMATION_REQUIRED', /^only the user can confirm the execution has stopped; available paths: the assignee finishes and submits, the user retries this with confirmStopped: true/);
  } finally { store.close(); }
});
