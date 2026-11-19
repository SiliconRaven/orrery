import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import type { CollaborationActor, CollaborationCommand, Task } from '../src/core/collaboration-types.ts';
import { collaborationTask, saveCollaborationTask } from '../src/plugins/tasks/store.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';

function fixture() {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const member = (id: string) => ({
    id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null,
  });
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, ['a', 'b', 'r', 'd', 'coord'].map(member));
  const hub = new Hub({ store, nativeAdapters: {} });
  let serial = 0;
  const user: CollaborationActor = { kind: 'user' };
  const as = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
    hub.collaboration.command(actor, 'c', { operationId: 'op-' + ++serial, ...command });
  const role = send(user, { action: 'role.create', name: 'checker' }).role!.id;
  for (const id of ['a', 'b', 'r']) send(user, { action: 'member.roles', memberId: id, roleIds: [role] });
  /** A task with reviewer b, executed by a and left in `status`. */
  const inFlight = (status: 'working' | 'review', createdBy: CollaborationActor = user): { task: Task; assignmentId: string; submissionId?: string } => {
    let task = send(createdBy, { action: 'task.create', title: 'work', scope: 's', acceptance: 'done',
      reviewer: as('b'), reviewRoleIds: [role], memberId: null }).task!;
    const claim = send(as('a'), { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
    task = send(as('a'), { action: 'task.start', taskId: task.id, expectedRevision: claim.task!.revision, assignmentId: claim.assignment!.id }).task!;
    if (status === 'working') return { task, assignmentId: claim.assignment!.id };
    const message = hub.sendFromUser('c', 'evidence');
    const submitted = send(as('a'), { action: 'task.submit', commitSha: 'abcdef0', taskId: task.id, expectedRevision: task.revision,
      assignmentId: claim.assignment!.id, summary: 'result', evidenceMessageIds: [message.id] });
    return { task: submitted.task!, assignmentId: claim.assignment!.id, submissionId: submitted.submission!.id };
  };
  const edit = (actor: CollaborationActor, task: Task, fields: Partial<CollaborationCommand>) =>
    send(actor, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, ...fields });
  return { store, hub, user, as, send, role, inFlight, edit };
}

test('the user swaps the reviewer of a task in review; the pending submission goes to the new reviewer', () => {
  const { store, user, as, send, inFlight, edit } = fixture();
  try {
    const { task, submissionId } = inFlight('review');
    const swapped = edit(user, task, { reviewer: as('r') });
    assert.equal(swapped.task!.status, 'review');
    assert.equal(swapped.task!.latestSubmissionId, submissionId, 'the submission is untouched');
    assert.equal(swapped.task!.definitionVersion, task.definitionVersion, 'a reviewer change does not void the submission');
    const payload = store.getEvent(swapped.eventId)!.payload as { action: string; changes: { field: string }[] };
    assert.equal(payload.action, 'task.edit');
    assert.deepEqual(payload.changes.map((c) => c.field), ['reviewer']);
    const notice = store.listMessages('c', 100).find((m) => m.collabEventId === swapped.eventId)!;
    assert.deepEqual([...notice.mentions].sort(), ['a', 'b', 'r'], 'old and new reviewer (and the assignee) hear about it');
    assert.throws(() => send(as('b'), { action: 'task.review', taskId: task.id, expectedRevision: swapped.task!.revision,
      submissionId, verdict: 'approve', reason: 'Independent review passed' }), /designated reviewer/);
    const done = send(as('r'), { action: 'task.review', taskId: task.id, expectedRevision: swapped.task!.revision,
      submissionId, verdict: 'approve', reason: 'Independent review passed' }).task!;
    assert.equal(done.status, 'completed');
    assert.equal(done.completionValid, true);
  } finally { store.close(); }
});

test('an authorized coordinator swaps the reviewer of a working task; suggest mode only suggests', () => {
  const { store, user, as, send, role, inFlight, edit } = fixture();
  try {
    let policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }).coordinator!;
    const { task } = inFlight('working');
    const swapped = edit(as('coord'), task, { generation: policy.generation, reviewer: as('r') }).task!;
    assert.deepEqual(swapped.reviewer, as('r'));
    assert.equal(swapped.status, 'working');
    const roles = edit(as('coord'), swapped, { generation: policy.generation, reviewRoleIds: [] }).task!;
    assert.deepEqual(roles.reviewRoleIds, []);
    policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'suggest' }).coordinator!;
    const suggested = edit(as('coord'), roles, { generation: policy.generation, reviewer: as('b'), reviewRoleIds: [role] });
    assert.ok(suggested.suggestion);
    assert.equal(suggested.task, undefined);
    assert.deepEqual(collaborationTask(store, 'c', task.id)!.reviewer, as('r'), 'a suggestion changes nothing');
    policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
      permissions: { reviewerManagement: false } }).coordinator!;
    assert.throws(() => edit(as('coord'), roles, { generation: policy.generation, reviewer: as('b') }), /permission is disabled/);
  } finally { store.close(); }
});

test('an in-flight reviewer swap rejects participants, ineligible reviewers, ordinary members and other fields', () => {
  const { store, user, as, inFlight, edit } = fixture();
  try {
    const { task } = inFlight('review');
    assert.throws(() => edit(user, task, { reviewer: as('a') }), /participated/);
    assert.throws(() => edit(user, task, { reviewer: as('d') }), /lacks roles/);
    assert.throws(() => edit(as('b'), task, { reviewer: as('r') }), /only the task creator, the user or the coordinator can change the reviewer/);
    assert.throws(() => edit(user, task, { scope: 'more' }), /stop work/);
    assert.throws(() => edit(user, task, { reviewer: as('r'), acceptance: 'stricter' }), /stop work/);
    const own = inFlight('working', as('d'));
    const renamed = edit(as('d'), own.task, { title: 'renamed' }).task!;
    assert.equal(renamed.title, 'renamed', 'other unlocked fields stay editable');
  } finally { store.close(); }
});

test('a pending task created by a member still lets that member set its reviewer', () => {
  const { store, as, send, edit } = fixture();
  try {
    const task = send(as('d'), { action: 'task.create', title: 'mine', scope: 's', acceptance: 'done' }).task!;
    assert.deepEqual(edit(as('d'), task, { reviewer: as('r') }).task!.reviewer, as('r'));
  } finally { store.close(); }
});

type Coded = Error & { code?: string };

test('the creator changes the reviewer of a working or in-review task until its first review', () => {
  const { store, as, send, inFlight, edit } = fixture();
  const deliveredTo = (eventId: number) => {
    const notice = store.listMessages('c', 200).find((m) => m.collabEventId === eventId)!;
    return store.withDeliveries([notice])[0].deliveries.map((delivery) => delivery.memberId);
  };
  try {
    const working = inFlight('working', as('d'));
    assert.deepEqual(edit(as('d'), working.task, { reviewer: as('r') }).task!.reviewer, as('r'));
    const { task, submissionId } = inFlight('review', as('d'));
    const swapped = edit(as('d'), task, { reviewer: as('r') });
    assert.deepEqual(swapped.task!.reviewer, as('r'));
    assert.equal(swapped.task!.latestSubmissionId, submissionId);
    const notice = store.listMessages('c', 200).find((m) => m.collabEventId === swapped.eventId)!;
    assert.ok(notice.mentions.includes('b'), 'the replaced reviewer keeps an unread notice');
    assert.ok(deliveredTo(swapped.eventId).includes('r'), 'the new reviewer is woken');
    assert.ok(!deliveredTo(swapped.eventId).includes('b'), 'the replaced reviewer is not woken');
    // The existing independence checks hold on this path too: the executor and earlier participants are refused.
    assert.throws(() => edit(as('d'), swapped.task!, { reviewer: as('a') }), (error: Coded) => error.code === 'REVIEW_NOT_INDEPENDENT');
    const other = inFlight('working', as('d'));
    const handed = send(as('a'), { action: 'task.handoff', taskId: other.task.id, expectedRevision: other.task.revision,
      assignmentId: other.assignmentId, memberId: 'r', reason: 'over to r' }).task!;
    const restarted = send(as('r'), { action: 'task.start', taskId: handed.id, expectedRevision: handed.revision }).task!;
    assert.equal(restarted.status, 'working');
    assert.throws(() => edit(as('d'), restarted, { reviewer: as('a') }), (error: Coded) =>
      error.code === 'REVIEW_NOT_INDEPENDENT' && /participated/.test(error.message));
    // A member who did not create the task still cannot change the reviewer.
    const current = collaborationTask(store, 'c', working.task.id)!;
    assert.throws(() => edit(as('r'), current, { reviewer: as('b') }), (error: Coded) =>
      error.code === 'FORBIDDEN' && /only the task creator, the user or the coordinator can change the reviewer/.test(error.message));
    assert.deepEqual(collaborationTask(store, 'c', working.task.id)!.reviewer, as('r'));
  } finally { store.close(); }
});

test('once a task has a review record only the user or the coordinator may change its reviewer', () => {
  const { store, user, as, send, inFlight, edit } = fixture();
  const forbidden = (error: Coded) =>
    error.code === 'FORBIDDEN' && /the task already has a review; ask the user or the coordinator to change the reviewer/.test(error.message);
  try {
    // After a rejection the task is working again, with a review record.
    const rejected = inFlight('review', as('d'));
    const back = send(as('b'), { action: 'task.review', taskId: rejected.task.id, expectedRevision: rejected.task.revision,
      submissionId: rejected.submissionId, verdict: 'reject', reason: 'needs more' }).task!;
    assert.equal(back.status, 'working');
    assert.throws(() => edit(as('d'), back, { reviewer: as('r') }), forbidden);
    assert.throws(() => edit(as('d'), back, { reviewRoleIds: [] }), forbidden);
    assert.deepEqual(edit(user, back, { reviewer: as('r') }).task!.reviewer, as('r'), 'the user still can');
    // After an approval and a reopen the task is pending again, and the record is still there.
    const approved = inFlight('review', as('d'));
    const done = send(as('b'), { action: 'task.review', taskId: approved.task.id, expectedRevision: approved.task.revision,
      submissionId: approved.submissionId, verdict: 'approve', reason: 'Independent review passed' }).task!;
    const reopened = send(user, { action: 'task.reopen', taskId: done.id, expectedRevision: done.revision, reason: 'again' }).task!;
    assert.equal(reopened.status, 'pending');
    assert.throws(() => edit(as('d'), reopened, { reviewer: as('r') }), forbidden);
    assert.deepEqual(edit(user, reopened, { reviewer: as('r') }).task!.reviewer, as('r'));
  } finally { store.close(); }
});

test('the creator may not switch a started task to self review; a pending one still can', () => {
  const { store, as, send, inFlight, edit } = fixture();
  try {
    const { task } = inFlight('working', as('d'));
    assert.throws(() => edit(as('d'), task, { reviewer: { kind: 'self' } }), (error: Coded) =>
      error.code === 'FORBIDDEN' && /cannot switch the task to self review; ask the user or the coordinator/.test(error.message));
    assert.deepEqual(collaborationTask(store, 'c', task.id)!.reviewer, as('b'), 'nothing changed');
    const pending = send(as('d'), { action: 'task.create', title: 'mine', scope: 's', acceptance: 'done' }).task!;
    assert.deepEqual(edit(as('d'), pending, { reviewer: { kind: 'self' } }).task!.reviewer, { kind: 'self' });
  } finally { store.close(); }
});

test('any member edits the title, priority and labels of an unfinished task, waking nobody', () => {
  const { store, user, as, send, inFlight, edit } = fixture();
  try {
    const { task, assignmentId } = inFlight('working');
    const tidied = edit(as('r'), task, { title: 'clearer', priority: 'high', labels: ['ui'] });
    assert.equal(tidied.task!.title, 'clearer');
    const payload = store.getEvent(tidied.eventId)!.payload as { changes: { field: string }[] };
    assert.deepEqual(payload.changes.map((c) => c.field), ['title', 'priority', 'labels'], 'the history records the edit');
    const notice = store.listMessages('c', 200).find((m) => m.collabEventId === tidied.eventId)!;
    assert.deepEqual(store.withDeliveries([notice])[0].deliveries, [], 'nobody is woken');
    // Any other field in the same command needs the creator, the user or the coordinator, and nothing is applied.
    for (const extra of [{ scope: 'more' }, { acceptance: 'stricter' }]) {
      assert.throws(() => edit(as('r'), tidied.task!, { title: 'again', ...extra }), (error: Coded) =>
        error.code === 'FORBIDDEN' && /only the task creator, the user or the coordinator can change these fields/.test(error.message));
    }
    const unchanged = collaborationTask(store, 'c', task.id)!;
    assert.equal(unchanged.title, 'clearer');
    assert.equal(unchanged.revision, tidied.task!.revision);
    // Finished tasks refuse a non-creator; the creator keeps the right to tidy them.
    const submitted = inFlight('review', as('d'));
    const completed = send(as('b'), { action: 'task.review', taskId: submitted.task.id, expectedRevision: submitted.task.revision,
      submissionId: submitted.submissionId, verdict: 'approve', reason: 'Independent review passed' }).task!;
    const finished = (error: Coded) => error.code === 'FORBIDDEN' && /the task is finished/.test(error.message);
    assert.throws(() => edit(as('r'), completed, { title: 'late' }), finished);
    assert.equal(edit(as('d'), completed, { title: 'creator renames' }).task!.title, 'creator renames');
    // shortcut: a merged status is written directly, since ship's git verification is out of scope for this test.
    const merged = { ...collaborationTask(store, 'c', completed.id)!, status: 'merged' as const };
    saveCollaborationTask(store, merged);
    assert.throws(() => edit(as('r'), merged, { labels: ['late'] }), finished);
    const cancelled = send(user, { action: 'task.cancel', taskId: task.id, expectedRevision: unchanged.revision, assignmentId,
      reason: 'drop', confirmStopped: true }).task!;
    assert.equal(cancelled.status, 'cancelled');
    assert.throws(() => edit(as('r'), cancelled, { priority: 'low' }), finished);
  } finally { store.close(); }
});
