import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { bookmarksOf } from '../src/plugins/bookmarks/index.ts';
import type { CollaborationActor, CollaborationCommand, Submission, Task } from '../src/core/collaboration-types.ts';
import { startTestHub, waitFor } from './helpers.ts';
import {
  collaborationLinkCount, collaborationLinks, collaborationRecords, collaborationTask, saveCollaborationRecord, saveCollaborationTask,
} from '../src/plugins/tasks/store.ts';

test('a task is created and read within its cluster, with idempotent retries', () => {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const cluster = { id: 'c', name: 'c', category: '', createdAt: new Date().toISOString() };
  store.insertCluster(cluster, []);
  const hub = new Hub({ store, nativeAdapters: {}, });
  const actor = { kind: 'user' } as const;
  const command = { action: 'task.create', operationId: 'op', title: 'Task', scope: 'Scope', acceptance: 'Done' } as const;
  const created = hub.collaboration.command(actor, cluster.id, command);
  assert.equal(created.task?.priority, 'normal');
  assert.deepEqual(hub.collaboration.command(actor, cluster.id, command), created);
  assert.throws(() => hub.collaboration.command(actor, cluster.id, { ...command, title: 'Changed' }), /operationId/);
  const workspace = hub.collaboration.query(actor, cluster.id, { kind: 'workspace' });
  assert.ok('tasks' in workspace);
  assert.equal(workspace.tasks[0].id, created.task!.id);
  assert.throws(() => hub.collaboration.query({ kind: 'member', memberId: 'other' }, cluster.id, { kind: 'workspace' }), /unknown member/);
  store.close();
});

function fixture() {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const member = (id: string, clusterId = 'c') => ({
    id, clusterId, name: id, avatar: null, harness: 'mock', model: null, effort: null,
    mode: 'native' as const, workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null,
  });
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, [member('a'), member('b'), member('coord')]);
  store.insertCluster({ id: 'other', name: 'other', category: '', createdAt: '2026-01-01' }, [member('outside', 'other')]);
  const hub = new Hub({ store, nativeAdapters: {}, });
  let serial = 0;
  const user: CollaborationActor = { kind: 'user' };
  const a: CollaborationActor = { kind: 'member', memberId: 'a' };
  const b: CollaborationActor = { kind: 'member', memberId: 'b' };
  const coordinator: CollaborationActor = { kind: 'member', memberId: 'coord' };
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
    hub.collaboration.command(actor, 'c', { operationId: 'op-' + ++serial, ...command });
  const message = hub.sendFromUser('c', 'evidence');
  return { store, hub, user, a, b, coordinator, send, message };
}

test('dependency versions, independent review and evidence remain tied to the task', () => {
  const { store, hub, user, a, b, send, message } = fixture();
  try {
    const role = send(user, { action: 'role.create', name: 'builder' }).role!;
    send(user, { action: 'member.roles', memberId: 'a', roleIds: [role.id] });
    let first = send(user, { action: 'task.create', title: 'first', scope: 'one', acceptance: 'done', mergeRequired: false,
      executeRoleIds: [role.id], reviewer: b }).task!;
    let second = send(user, { action: 'task.create', title: 'second', scope: 'two', acceptance: 'done', dependencyIds: [first.id] }).task!;
    let claimSecond = send(a, { action: 'task.claim', taskId: second.id, expectedRevision: second.revision });
    second = claimSecond.task!;
    assert.throws(() => send(a, { action: 'task.start', taskId: second.id, expectedRevision: second.revision,
      assignmentId: claimSecond.assignment!.id }), /dependencies are not ready/);
    let claim = send(a, { action: 'task.claim', taskId: first.id, expectedRevision: first.revision });
    first = claim.task!;
    first = send(a, { action: 'task.start', taskId: first.id, expectedRevision: first.revision, assignmentId: claim.assignment!.id }).task!;
    const submission = send(a, { action: 'task.submit', commitSha: 'abcdef0', taskId: first.id, expectedRevision: first.revision,
      assignmentId: claim.assignment!.id, summary: 'result', evidenceMessageIds: [message.id] });
    first = submission.task!;
    assert.throws(() => send(a, { action: 'task.review', taskId: first.id, expectedRevision: first.revision,
      submissionId: submission.submission!.id, verdict: 'approve', reason: 'Independent review passed' }), /designated reviewer/);
    first = send(b, { action: 'task.review', taskId: first.id, expectedRevision: first.revision,
      submissionId: submission.submission!.id, verdict: 'approve', reason: 'Independent review passed' }).task!;
    assert.equal(first.completionValid, true);
    second = send(a, { action: 'task.start', taskId: second.id, expectedRevision: second.revision,
      assignmentId: claimSecond.assignment!.id }).task!;
    const secondSubmission = send(a, { action: 'task.submit', commitSha: 'abcdef0', taskId: second.id, expectedRevision: second.revision,
      assignmentId: claimSecond.assignment!.id, summary: 'dependent result', evidenceMessageIds: [message.id] });
    second = secondSubmission.task!;
    first = send(user, { action: 'task.reopen', taskId: first.id, expectedRevision: first.revision, reason: 'new work' }).task!;
    assert.throws(() => send(user, { action: 'task.review', taskId: second.id, expectedRevision: second.revision,
      submissionId: secondSubmission.submission!.id, verdict: 'approve', reason: 'Independent review passed' }), /dependencies or definition changed/);
    second = send(user, { action: 'task.review', taskId: second.id, expectedRevision: second.revision,
      submissionId: secondSubmission.submission!.id, verdict: 'reject', reason: 'dependency changed' }).task!;
    assert.equal(second.status, 'working', 'a stale submission can still be returned');
    const context = hub.collaboration.query(user, 'c', { kind: 'context', taskId: first.id });
    assert.ok('messages' in context);
    assert.ok(context.messages.some((item) => item.message.id === message.id));
    assert.throws(() => hub.collaboration.query({ kind: 'member', memberId: 'outside' }, 'c', { kind: 'workspace' }), /unknown member/);
  } finally { store.close(); }
});

test('shared prerequisite paths do not multiply workspace reads, and reopening still invalidates descendants', (t) => {
  const { store, hub, user, send } = fixture();
  try {
    const template = send(user, { action: 'task.create', title: 'template', scope: 'one', acceptance: 'done', mergeRequired: false }).task!;
    const tasks: Task[] = [];
    let prior: Task[] = [];
    for (let level = 0; level < 12; level++) {
      const pair: Task[] = [];
      for (let side = 0; side < 2; side++) {
        const id = `dag-${level}-${side}`;
        const submission: Submission = {
          id: `result-${id}`, taskId: id, assignmentId: `assignment-${id}`, definitionVersion: template.definitionVersion,
          summary: 'ok', commitSha: null, evidenceMessageIds: [], evidenceFileIds: [], contributorKeys: [],
          dependencyVersions: Object.fromEntries(prior.map((task) => [task.id, task.approvedSubmissionId!])), createdAt: template.createdAt,
        };
        const task: Task = { ...template, id, number: template.number + tasks.length + 1, status: 'completed',
          dependencyIds: prior.map((task) => task.id), approvedSubmissionId: submission.id, latestSubmissionId: submission.id };
        saveCollaborationTask(store, task);
        saveCollaborationRecord(store, task.id, 'submission', submission);
        pair.push(task);
        tasks.push(task);
      }
      prior = pair;
    }

    const prepares = t.mock.method(store.db, 'prepare');
    const workspace = () => {
      const result = hub.collaboration.query(user, 'c', { kind: 'workspace' });
      assert.ok('memberRoles' in result);
      return result.tasks;
    };
    const completed = workspace().filter((task) => task.id !== template.id);
    assert.equal(completed.length, tasks.length);
    assert.ok(completed.every((task) => task.dependenciesReady && task.completionValid));
    const statementCount = prepares.mock.callCount();
    assert.ok(statementCount <= 4 * tasks.length + 20, `workspace used ${statementCount} prepared statements for ${tasks.length} tasks`);
    t.diagnostic(`${statementCount} prepared statements for a ${tasks.length}-task dependency graph`);

    const root = tasks[0];
    const leaf = tasks.at(-1)!;
    send(user, { action: 'task.reopen', taskId: root.id, expectedRevision: root.revision, reason: 'new work' });
    const invalid = workspace().find((task) => task.id === leaf.id)!;
    assert.equal(invalid.dependenciesReady, false);
    assert.equal(invalid.completionValid, false);
    assert.equal(invalid.dependenciesChanged, true);

    saveCollaborationTask(store, { ...root, dependencyIds: [leaf.id] });
    const cycle = workspace().find((task) => task.id === root.id)!;
    assert.equal(cycle.dependenciesReady, false);
    assert.equal(cycle.completionValid, false);
  } finally { store.close(); }
});

test('delegation checks each permission, keeps generations and does not allow a member to confirm stopping', () => {
  const { store, hub, user, a, coordinator, send, message } = fixture();
  try {
    let task = send(user, { action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done' }).task!;
    let policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
      permissions: { taskPlanning: false, reviewerManagement: true, knowledgeCommunication: false, recovery: true } }).coordinator!;
    assert.equal(policy.permissions.cancelReopen, false);
    assert.equal(policy.permissions.deliveryControl, false);
    assert.throws(() => send(coordinator, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision,
      generation: policy.generation, reviewer: a, scope: 'expanded' }), /permission is disabled/);
    assert.throws(() => send(coordinator, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision,
      generation: policy.generation, priority: 'high' }), /permission is disabled/);
    assert.throws(() => send(coordinator, { action: 'task.summary', taskId: task.id, expectedRevision: task.revision,
      generation: policy.generation, summary: 'note', throughEventId: 0 }), /permission is disabled/);
    policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'suggest' }).coordinator!;
    const suggestion = send(coordinator, { action: 'member.roles', generation: policy.generation, memberId: 'a', roleIds: [] });
    assert.ok(suggestion.suggestion);
    assert.throws(() => send(coordinator, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }), /only the user/);
    const oldGeneration = policy.generation;
    send(user, { action: 'coordinator.set', memberId: null });
    policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }).coordinator!;
    assert.ok(policy.generation > oldGeneration);
    assert.throws(() => send(coordinator, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision,
      generation: oldGeneration, memberId: 'a' }), /policy changed/);
    const claim = send(a, { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
    task = claim.task!;
    task = send(a, { action: 'task.start', taskId: task.id, expectedRevision: task.revision, assignmentId: claim.assignment!.id }).task!;
    const releasedStarted = send(a, { action: 'task.release', taskId: task.id, expectedRevision: task.revision,
      assignmentId: claim.assignment!.id, reason: 'done' });
    assert.equal(releasedStarted.task!.status, 'pending', 'the executor declaration is the stop confirmation');
    send(user, { action: 'bookmark.set', messageId: message.id, labels: ['decision'] });
    send(a, { action: 'bookmark.set', messageId: message.id });
    send(a, { action: 'bookmark.remove', messageId: message.id, memberId: 'user' });
    assert.deepEqual(bookmarksOf(store, message.id).map((v) => v.memberId), ['user']);
    assert.ok(hub.collaboration.query(user, 'c', { kind: 'collections', memberId: 'user' }));
    send(a, { action: 'bookmark.set', messageId: message.id });
    hub.removeMember('c', 'a');
    const historical = hub.collaboration.query(user, 'c', { kind: 'collections', memberId: 'a' });
    assert.ok('items' in historical);
    assert.equal(historical.items[0].message.id, message.id);
  } finally { store.close(); }
});

test('business roles carry an editable description that every member can read', () => {
  const { store, hub, user, a, coordinator, send } = fixture();
  try {
    const role = send(user, { action: 'role.create', name: 'checker', description: '  负责验收结果  ' }).role!;
    assert.equal(role.description, '负责验收结果');
    const workspace = hub.collaboration.query(user, 'c', { kind: 'workspace' });
    assert.ok('roles' in workspace);
    assert.equal(workspace.roles.find((item) => item.id === role.id)!.description, '负责验收结果');
    // A plain member reads the same description through the workspace query behind list_tasks.
    const byMember = hub.collaboration.query(a, 'c', { kind: 'workspace' });
    assert.ok('roles' in byMember);
    assert.equal(byMember.roles.find((item) => item.id === role.id)!.description, '负责验收结果');
    // The description is editable on its own; a blank value clears it.
    const edited = send(user, { action: 'role.edit', roleId: role.id, description: '检查结果是否满足验收条件' });
    assert.equal(edited.role!.description, '检查结果是否满足验收条件');
    assert.equal(send(user, { action: 'role.edit', roleId: role.id, description: '   ' }).role!.description, '');
    assert.throws(() => send(user, { action: 'role.edit', roleId: role.id }), /no editable fields/);
    assert.throws(() => send(user, { action: 'role.edit', roleId: 'missing', description: 'x' }), /unknown role/);
    assert.throws(() => send(user, { action: 'role.create', name: 'long', description: 'x'.repeat(501) }), /at most 500/);
    assert.throws(() => send(user, { action: 'role.create', name: 'number', description: 5 as any }), /must be a string/);
    // Who may edit: the user, or a coordinator with roleManagement and the current generation.
    const policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }).coordinator!;
    assert.equal(send(coordinator, { action: 'role.edit', roleId: role.id, description: '由协调员维护', generation: policy.generation })
      .role!.description, '由协调员维护');
    assert.throws(() => send(a, { action: 'role.edit', roleId: role.id, description: '普通成员修改' }), /not permitted/);
    assert.throws(() => send(coordinator, { action: 'role.edit', roleId: role.id, description: '旧代次', generation: policy.generation - 1 }), /policy changed/);
  } finally { store.close(); }
});

test('a coordinator needs reviewer management when creating a task with review settings', () => {
  const { store, user, a, coordinator, send } = fixture();
  try {
    const policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
      permissions: { taskPlanning: true, reviewerManagement: false } }).coordinator!;
    const create = { action: 'task.create' as const, title: 'work', scope: 'scope', acceptance: 'done', generation: policy.generation };
    assert.throws(() => send(coordinator, { ...create, reviewer: a }), /permission is disabled/);
    assert.throws(() => send(coordinator, { ...create, reviewRoleIds: [] }), /permission is disabled/);
    assert.equal(send(coordinator, create).task?.reviewer.kind, 'user');
  } finally { store.close(); }
});

test('a task message to one native member includes its group envelope while ordinary direct messages remain unchanged', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [member] } = await app.hub.createCluster('tasks', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    ]);
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.create', operationId: 'create', title: 'work', scope: 'scope', acceptance: 'done',
    }).task!;
    const body = '请查看结果\n正文保持原样';
    const message = app.hub.sendFromUser(cluster.id, body, [member.id], undefined, [task.id]);
    const delivery = await waitFor(() => app.native.delivered[0], 'task message delivery');
    assert.ok(delivery.text.includes('clusterId=' + cluster.id));
    assert.ok(delivery.text.includes('messageId=' + message.id));
    assert.ok(delivery.text.includes('taskIds=' + task.id));
    assert.ok(delivery.text.includes('\n' + body + '\n'));
    assert.equal(app.store.getMessage(message.id)?.body, body);
    await waitFor(() => app.store.withDeliveries([message])[0].deliveries[0].state === 'done', 'task message completion');
    const direct = 'ordinary direct text';
    app.hub.sendFromUser(cluster.id, direct, [member.id]);
    const ordinary = await waitFor(() => app.native.delivered[1], 'ordinary direct delivery');
    assert.equal(ordinary.text, direct);
  } finally { await app.close(); }
});

test('a paused cluster does not block another cluster sharing the native session', async () => {
  const app = await startTestHub();
  const runs: { text: string; gate: PromiseWithResolvers<'completed'> }[] = [];
  app.native.deliver = async (_session, text) => {
    const gate = Promise.withResolvers<'completed'>();
    runs.push({ text, gate });
    return gate.promise;
  };
  try {
    const one = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const two = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'B' }]);
    app.hub.collaboration.command({ kind: 'user' }, one.cluster.id, { action: 'cluster.pause', operationId: 'pause', paused: true });
    const first = app.hub.sendFromUser(one.cluster.id, '@A waiting');
    const second = app.hub.sendFromUser(two.cluster.id, '@B active');
    assert.equal(runs.length, 1);
    assert.ok(runs[0].text.includes(second.id));
    assert.equal(app.store.withDeliveries([first])[0].deliveries[0].state, 'queued');
    const third = app.hub.sendFromUser(two.cluster.id, '@B next');
    app.hub.collaboration.command({ kind: 'user' }, one.cluster.id, { action: 'cluster.pause', operationId: 'resume', paused: false });
    assert.equal(runs.length, 1, 'resuming cannot overlap a running native turn');
    runs[0].gate.resolve('completed');
    await waitFor(() => runs.length === 2, 'resumed cluster delivery');
    assert.ok(runs[1].text.includes(first.id), 'the oldest now-runnable delivery goes first');
    runs[1].gate.resolve('completed');
    await waitFor(() => runs.length === 3, 'next unpaused delivery');
    assert.ok(runs[2].text.includes(third.id));
    runs[2].gate.resolve('completed');
  } finally {
    for (const run of runs) run.gate.resolve('completed');
    await app.close();
  }
});

test('pausing an older pending cluster wakes a confirmed sibling sharing the native session', async () => {
  const app = await startTestHub();
  const checks: PromiseWithResolvers<boolean>[] = [];
  app.native.confirmOnline = async () => {
    const check = Promise.withResolvers<boolean>();
    checks.push(check);
    return check.promise;
  };
  try {
    const one = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const two = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'B' }]);
    const first = app.hub.sendFromUser(one.cluster.id, '@A older');
    const second = app.hub.sendFromUser(two.cluster.id, '@B confirmed');
    assert.equal(checks.length, 2);
    const secondDelivery = app.store.withDeliveries([second])[0].deliveries[0];
    checks[1].resolve(true);
    await waitFor(() => !(app.hub as any).pending.has(secondDelivery.id), 'sibling online confirmation');
    assert.equal(app.native.delivered.length, 0, 'older pending delivery owns the queue');
    app.hub.collaboration.command({ kind: 'user' }, one.cluster.id, { action: 'cluster.pause', operationId: 'pause', paused: true });
    await waitFor(() => app.native.delivered.length === 1, 'confirmed sibling wakes after pause');
    assert.ok(app.native.delivered[0].text.includes(second.id));
    checks[0].resolve(true);
    await waitFor(() => !(app.hub as any).pending.has(app.store.withDeliveries([first])[0].deliveries[0].id), 'older confirmation');
    assert.equal(app.store.withDeliveries([first])[0].deliveries[0].state, 'queued');
    assert.equal(app.native.delivered.length, 1);
  } finally {
    for (const check of checks) check.resolve(false);
    await app.close();
  }
});

test('a queued native direct message gains a group envelope when linked to a task', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [member] } = await app.hub.createCluster('tasks', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    ]);
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.create', operationId: 'create', title: 'work', scope: 'scope', acceptance: 'done',
    }).task!;
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'pause', paused: true });
    const body = '任务关联之前的正文';
    const message = app.hub.sendFromUser(cluster.id, body, [member.id]);
    assert.equal(app.store.isDirect(message.id), true);
    assert.equal(app.store.withDeliveries([message])[0].deliveries[0].state, 'queued');
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'message.link', operationId: 'link', messageId: message.id, taskIds: [task.id],
    });
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'resume', paused: false });
    const sent = await waitFor(() => app.native.delivered[0], 'linked task message');
    assert.ok(sent.text.includes('clusterId=' + cluster.id));
    assert.ok(sent.text.includes('messageId=' + message.id));
    assert.ok(sent.text.includes('taskIds=' + task.id));
    assert.ok(sent.text.includes('\n' + body + '\n'));
    assert.equal(app.store.getMessage(message.id)?.body, body);
    await waitFor(() => app.store.withDeliveries([message])[0].deliveries[0].state === 'done', 'linked message completion');
    app.hub.sendFromUser(cluster.id, 'ordinary', [member.id]);
    const ordinary = await waitFor(() => app.native.delivered[1], 'ordinary message');
    assert.equal(ordinary.text, 'ordinary');
  } finally { await app.close(); }
});

test('a changed dependency requires explicit current versions and the approved executor for resubmission', () => {
  const { store, hub, user, a, b, send, message } = fixture();
  try {
    const create = (title: string, dependencyIds: string[] = []) => send(user, {
      action: 'task.create', title, scope: title, acceptance: 'done', dependencyIds, mergeRequired: false,
    }).task!;
    const complete = (task: ReturnType<typeof create>, executor: CollaborationActor = a) => {
      const claimed = send(executor, { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
      task = claimed.task!;
      task = send(executor, { action: 'task.start', taskId: task.id, expectedRevision: task.revision, assignmentId: claimed.assignment!.id }).task!;
      const submitted = send(executor, { action: 'task.submit', commitSha: 'abcdef0', taskId: task.id, expectedRevision: task.revision,
        assignmentId: claimed.assignment!.id, summary: 'result', evidenceMessageIds: [message.id] });
      task = send(user, { action: 'task.review', taskId: task.id, expectedRevision: submitted.task!.revision,
        submissionId: submitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' }).task!;
      return { task, assignmentId: claimed.assignment!.id };
    };
    let upstream = complete(create('upstream'));
    const oldVersion = upstream.task.approvedSubmissionId!;
    const pending = create('downstream', [upstream.task.id]);
    const oldClaim = send(a, { action: 'task.claim', taskId: pending.id, expectedRevision: pending.revision });
    const released = send(a, { action: 'task.release', taskId: pending.id, expectedRevision: oldClaim.task!.revision,
      assignmentId: oldClaim.assignment!.id, reason: 'hand over' });
    let downstream = complete(released.task!, b);
    const last = create('third', [downstream.task.id]);
    let working = create('working', [upstream.task.id]);
    const workingClaim = send(a, { action: 'task.claim', taskId: working.id, expectedRevision: working.revision });
    working = send(a, { action: 'task.start', taskId: working.id, expectedRevision: workingClaim.task!.revision,
      assignmentId: workingClaim.assignment!.id }).task!;
    let reopened = send(user, { action: 'task.reopen', taskId: upstream.task.id, expectedRevision: upstream.task.revision, reason: 'new work' }).task!;
    upstream = complete(reopened);
    const currentVersions = { [upstream.task.id]: upstream.task.approvedSubmissionId! };
    const oldVersions = { [upstream.task.id]: oldVersion };
    const late = { action: 'task.submit' as const, commitSha: 'abcdef0', taskId: working.id, expectedRevision: working.revision,
      assignmentId: workingClaim.assignment!.id, summary: 'late result', evidenceMessageIds: [message.id] };
    assert.throws(() => send(a, late), /declare the current dependency versions/);
    assert.throws(() => send(a, { ...late, expectedDependencyVersions: oldVersions }), /do not match/);
    const lateSubmission = send(a, { ...late, expectedDependencyVersions: currentVersions });
    assert.deepEqual(lateSubmission.submission?.dependencyVersions, currentVersions);
    const view = hub.collaboration.query(user, 'c', { kind: 'task', taskId: downstream.task.id });
    assert.ok('task' in view);
    assert.equal(view.task.dependenciesReady, true);
    assert.equal(view.task.dependenciesChanged, true);
    assert.equal(view.task.completionValid, false);
    const third = hub.collaboration.query(user, 'c', { kind: 'task', taskId: last.id });
    assert.ok('task' in third);
    assert.equal(third.task.dependenciesReady, false);
    const retry = { action: 'task.submit' as const, commitSha: 'abcdef0', taskId: downstream.task.id, expectedRevision: downstream.task.revision,
      assignmentId: downstream.assignmentId, summary: 'rechecked', evidenceMessageIds: [message.id] };
    assert.throws(() => send(b, retry), /declare the current dependency versions/);
    assert.throws(() => send(a, { ...retry, assignmentId: oldClaim.assignment!.id, expectedDependencyVersions: currentVersions }),
      /only the approved assignment/);
    const submitted = send(b, { ...retry, expectedDependencyVersions: currentVersions });
    assert.ok(submitted.assignment);
    downstream.task = send(user, { action: 'task.review', taskId: downstream.task.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' }).task!;
    assert.equal(downstream.task.completionValid, true);
    const ready = hub.collaboration.query(user, 'c', { kind: 'task', taskId: last.id });
    assert.ok('task' in ready);
    assert.equal(ready.task.dependenciesReady, true);
  } finally { store.close(); }
});

test('revoked coordinator generations cannot fall back to creator permissions and empty edits do not write', () => {
  const { store, hub, user, a, b, coordinator, send } = fixture();
  try {
    const policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' }).coordinator!;
    const create: CollaborationCommand = { action: 'task.create', operationId: 'coordinator-create',
      title: 'work', scope: 'scope', acceptance: 'done', generation: policy.generation };
    let task = hub.collaboration.command(coordinator, 'c', create).task!;
    send(user, { action: 'coordinator.set', memberId: null });
    assert.throws(() => hub.collaboration.command(coordinator, 'c', create), /policy changed/, 'cached operations still check the generation');
    assert.throws(() => send(coordinator, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision,
      memberId: 'a', generation: policy.generation }), /policy changed/);
    task = send(coordinator, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: 'a' }).task!;
    const beforeEvent = store.lastEventSeq();
    assert.throws(() => send(b, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision }), /no editable fields/);
    assert.equal(collaborationTask(store, 'c', task.id)?.revision, task.revision);
    assert.equal(store.lastEventSeq(), beforeEvent);
  } finally { store.close(); }
});

test('coordinator notifications preserve the triggering chain and a user pause cannot be undone by a member', () => {
  const { store, hub, user, coordinator, send } = fixture();
  try {
    const policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
      permissions: { deliveryControl: true } }).coordinator!;
    const setup = store.listMessages('c', 50).find((m) => m.kind === 'system')!;
    const delivery = store.withDeliveries([setup])[0].deliveries[0];
    store.setDeliveryState(delivery.id, 'running');
    store.setDeliveryState(delivery.id, 'done', null, 'completed');
    const task = send(user, { action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done' }).task!;
    const command: CollaborationCommand = { action: 'task.nominate', operationId: 'same-op', taskId: task.id,
      expectedRevision: task.revision, memberId: 'a', generation: policy.generation };
    const result = hub.collaboration.command(coordinator, 'c', command);
    const before = store.listMessages('c', 100).length;
    assert.deepEqual(hub.collaboration.command(coordinator, 'c', command), result);
    const all = store.listMessages('c', 100);
    assert.equal(all.length, before, 'retry does not create another notification');
    const notice = all.at(-1)!;
    assert.equal(notice.from, 'system');
    assert.equal(notice.chainId, setup.chainId);
    assert.equal(notice.hop, setup.hop + 1);
    send(user, { action: 'cluster.pause', paused: true });
    assert.throws(() => send(coordinator, { action: 'cluster.pause', paused: false, generation: policy.generation }),
      /only the user can resume/);
  } finally { store.close(); }
});

test('task search and context pages keep messages and event cursors independent', () => {
  const { store, hub, user, send } = fixture();
  try {
    let task = send(user, { action: 'task.create', title: 'search needle', scope: 'scope', acceptance: 'done', labels: ['tag'] }).task!;
    const fileId = '11111111-1111-4111-8111-111111111111';
    store.insertFile({ id: fileId, clusterId: 'c', uploader: 'user', name: 'proof.txt',
      mime: 'application/octet-stream', size: 1, sha256: 'test', createdAt: '2026-01-01' });
    hub.sendFromUser('c', 'source one', undefined, [fileId], [task.id]);
    hub.sendFromUser('c', 'source two', undefined, undefined, [task.id]);
    const search = hub.collaboration.query(user, 'c', { kind: 'workspace', q: 'needle', label: 'tag', limit: 1 });
    assert.ok('tasks' in search);
    assert.equal(search.tasks[0].id, task.id);
    const first = hub.collaboration.query(user, 'c', { kind: 'context', taskId: task.id, limit: 1 });
    assert.ok('messages' in first);
    assert.ok(first.messagesNextCursor);
    assert.equal(first.messages[0].attachments[0].id, fileId);
    const second = hub.collaboration.query(user, 'c', { kind: 'context', taskId: task.id,
      limit: 1, messagesCursor: first.messagesNextCursor! });
    assert.ok('messages' in second);
    assert.notEqual(first.messages[0].message.id, second.messages[0].message.id);
    task = send(user, { action: 'task.summary', taskId: task.id, expectedRevision: task.revision, summary: 'summary',
      sourceMessageIds: [first.messages[0].message.id], throughEventId: 0 }).task!;
    task = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, priority: 'high' }).task!;
    assert.equal(task.priority, 'high');
    const context = hub.collaboration.query(user, 'c', { kind: 'context', taskId: task.id });
    assert.ok('summary' in context);
    assert.deepEqual(context.summary?.sourceMessageIds, [first.messages[0].message.id]);
  } finally { store.close(); }
});

test('task search matches ids and 4+ character id prefixes, ranking id hits first', () => {
  const { store, hub, user, send } = fixture();
  try {
    const target = send(user, { action: 'task.create', title: 'Alpha', scope: 'plain scope', acceptance: 'done' }).task!;
    const mention = send(user, { action: 'task.create', title: 'Mentions', scope: `refers to ${target.id}`, acceptance: 'done' }).task!;
    const id = target.id;
    const hex = id.replace(/-/g, '');
    const byFull = hub.collaboration.query(user, 'c', { kind: 'workspace', q: id }) as any;
    assert.deepEqual(byFull.tasks.map((task: any) => task.id), [id, mention.id], 'the id hit sorts before the text hit');
    const byPrefix = hub.collaboration.query(user, 'c', { kind: 'workspace', q: hex.slice(0, 8) }) as any;
    assert.equal(byPrefix.tasks[0].id, id, 'an 8-character hex prefix finds the task');
    const short = hub.collaboration.query(user, 'c', { kind: 'workspace', q: hex.slice(0, 3) }) as any;
    assert.ok(!short.tasks.some((task: any) => task.id === id), 'a 3-character prefix is not an id match');
    assert.equal((hub.collaboration.query(user, 'c', { kind: 'workspace', q: 'alpha' }) as any).tasks[0].id, id,
      'title keywords still match');
    const outside = hub.collaboration.command(user, 'other', { action: 'task.create', operationId: 'outside-1',
      title: 'Outside', scope: 'plain', acceptance: 'done' }).task!;
    assert.ok(!(hub.collaboration.query(user, 'c', { kind: 'workspace', q: outside.id }) as any).tasks
      .some((task: any) => task.id === outside.id), 'ids stay inside their cluster');
    // The ranked order paginates without duplicates or gaps.
    const first = hub.collaboration.query(user, 'c', { kind: 'workspace', q: hex.slice(0, 8), limit: 1 }) as any;
    assert.equal(first.tasks[0].id, id);
    assert.ok(first.nextCursor);
    const second = hub.collaboration.query(user, 'c', { kind: 'workspace', q: hex.slice(0, 8), limit: 1,
      cursor: first.nextCursor }) as any;
    assert.equal(second.tasks[0].id, mention.id);
    assert.equal(second.nextCursor, null);
    // A cursor too large to be a safe integer must not inline "Infinity" into SQL; it degrades to the first page.
    const hugeCursor = `${'9'.repeat(400)}:${'9'.repeat(400)}`;
    const huge = hub.collaboration.query(user, 'c', { kind: 'workspace', q: hex.slice(0, 8), limit: 1, cursor: hugeCursor }) as any;
    assert.equal(huge.tasks[0].id, id, 'an overflowing cursor falls back to the first page instead of throwing');
  } finally { store.close(); }
});

test('workspace label filter accepts several labels with AND semantics', () => {
  const { store, hub, user, send } = fixture();
  try {
    const both = send(user, { action: 'task.create', title: 'both', scope: 's', acceptance: 'a', labels: ['ui', 'high'] }).task!;
    const uiOnly = send(user, { action: 'task.create', title: 'ui only', scope: 's', acceptance: 'a', labels: ['ui'] }).task!;
    send(user, { action: 'task.create', title: 'high only', scope: 's', acceptance: 'a', labels: ['high'] });
    const and = hub.collaboration.query(user, 'c', { kind: 'workspace', label: ['ui', 'high'] }) as any;
    assert.deepEqual(and.tasks.map((task: any) => task.id), [both.id], 'every label must match');
    const single = hub.collaboration.query(user, 'c', { kind: 'workspace', label: 'ui' }) as any;
    assert.deepEqual(single.tasks.map((task: any) => task.id), [both.id, uiOnly.id]);
    assert.deepEqual(and.labels, ['high', 'ui'], 'the workspace lists every used label for autocompletion');
    // Paging keeps the AND semantics and pages never repeat or leak another cluster's tasks.
    const page1 = hub.collaboration.query(user, 'c', { kind: 'workspace', label: 'ui', limit: 1 }) as any;
    assert.equal(page1.tasks.length, 1);
    assert.ok(page1.nextCursor);
    const page2 = hub.collaboration.query(user, 'c', { kind: 'workspace', label: 'ui', limit: 1, cursor: page1.nextCursor }) as any;
    assert.equal(page2.tasks.length, 1);
    assert.notEqual(page2.tasks[0].id, page1.tasks[0].id);
    hub.collaboration.command(user, 'other', { action: 'task.create', operationId: 'label-other', title: 'outside',
      scope: 's', acceptance: 'a', labels: ['ui'] });
    assert.equal((hub.collaboration.query(user, 'c', { kind: 'workspace', label: 'ui' }) as any).tasks.length, 2,
      'another cluster\'s labeled task is not returned');
  } finally { store.close(); }
});

test('a throwing collaboration listener does not prevent a committed notification from being published', () => {
  const { store, hub, user, send } = fixture();
  try {
    send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' });
    const task = send(user, { action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done' }).task!;
    const observed: string[] = [];
    const unsubscribe = hub.subscribe((event) => {
      observed.push(event.kind);
      if (event.kind === 'collaboration') throw new Error('listener failed');
    });
    assert.equal(send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: 'a' }).task!.assignedMemberId, 'a');
    unsubscribe();
    assert.deepEqual(observed, ['collaboration', 'message']);
  } finally { store.close(); }
});

test('only the user deletes a cancelled task, and only after nothing depends on it, taking records and links', () => {
  const { store, hub, user, a, send, message } = fixture();
  try {
    let task = send(user, { action: 'task.create', title: 'remove me', scope: 's', acceptance: 'a' }).task!;
    // An open task may not be deleted, and a member may not delete even with every role.
    assert.throws(() => send(user, { action: 'task.delete', taskId: task.id, expectedRevision: task.revision }), /only cancelled tasks/);
    const claimed = send(a, { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
    task = claimed.task!;
    task = send(user, { action: 'task.attention', taskId: task.id, expectedRevision: task.revision, kind: 'question', question: 'why' }).task!;
    send(user, { action: 'message.link', messageId: message.id, taskIds: [task.id] });
    task = send(user, { action: 'task.cancel', taskId: task.id, expectedRevision: task.revision, assignmentId: claimed.assignment!.id, reason: 'cleanup' }).task!;
    const detail = hub.collaboration.query(user, 'c', { kind: 'task', taskId: task.id });
    assert.ok('linkedMessageCount' in detail);
    assert.ok(detail.linkedMessageCount >= 1, 'the delete dialog can name the linked message count');
    const linked = detail.linkedMessageCount;
    assert.throws(() => send(a, { action: 'task.delete', taskId: task.id, expectedRevision: task.revision }), /only the user can delete/);
    // A dependent task blocks the delete and is named; the refusal writes nothing.
    const dependent = send(user, { action: 'task.create', title: 'depends on it', scope: 's', acceptance: 'a', dependencyIds: [task.id] }).task!;
    assert.throws(() => send(user, { action: 'task.delete', taskId: task.id, expectedRevision: task.revision }), (error: any) => {
      assert.equal(error.code, 'TASK_HAS_DEPENDENTS');
      assert.match(error.message, /depends on it/);
      assert.match(error.message, new RegExp(dependent.id));
      return true;
    });
    assert.equal(collaborationTask(store, 'c', task.id)?.status, 'cancelled', 'a refused delete leaves the task whole');
    send(user, { action: 'task.edit', taskId: dependent.id, expectedRevision: dependent.revision, dependencyIds: [] });
    const before = store.lastEventSeq();
    const deleted = send(user, { action: 'task.delete', taskId: task.id, expectedRevision: task.revision });
    assert.deepEqual(deleted.deleted, { id: task.id, title: 'remove me', linkedMessageCount: linked });
    assert.ok(store.lastEventSeq() > before, 'the delete is recorded as a collaboration event');
    const deleteEvent = store.getEvent(store.lastEventSeq())!;
    assert.equal((deleteEvent.payload as any).action, 'task.delete');
    assert.equal((deleteEvent.payload as any).messageIds.length, linked, 'the event names every unlinked message');
    assert.ok((deleteEvent.payload as any).messageIds.includes(message.id));
    assert.equal(collaborationTask(store, 'c', task.id), null, 'the task row is gone');
    assert.deepEqual(collaborationRecords(store, task.id, 'assignment'), [], 'assignments go with the task');
    assert.deepEqual(collaborationRecords(store, task.id, 'attention'), [], 'attentions go with the task');
    assert.deepEqual(collaborationLinks(store, message.id), [], 'the link is gone');
    assert.equal(collaborationLinkCount(store, task.id), 0, 'no link is left behind');
    assert.ok(store.getMessage(message.id), 'the message itself stays in the group chat');
    assert.ok(!(hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).tasks.some((item: any) => item.id === task.id));
    assert.throws(() => hub.collaboration.query(user, 'c', { kind: 'task', taskId: task.id }), /unknown task/);
    assert.throws(() => send(user, { action: 'task.delete', taskId: task.id, expectedRevision: task.revision }), /unknown task/);
    // Completed tasks are closed but not deletable: only cancellation leads to the closed group's delete.
    let done = send(user, { action: 'task.create', title: 'finished', scope: 's', acceptance: 'a', reviewer: { kind: 'user' } }).task!;
    const doneClaim = send(a, { action: 'task.claim', taskId: done.id, expectedRevision: done.revision });
    done = send(a, { action: 'task.start', taskId: done.id, expectedRevision: doneClaim.task!.revision, assignmentId: doneClaim.assignment!.id }).task!;
    const submitted = send(a, { action: 'task.submit', taskId: done.id, expectedRevision: done.revision,
      assignmentId: doneClaim.assignment!.id, summary: 'done', evidenceMessageIds: [message.id], commitSha: 'abc1234' });
    done = send(user, { action: 'task.review', taskId: done.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'approve' }).task!;
    assert.equal(done.status, 'completed');
    assert.throws(() => send(user, { action: 'task.delete', taskId: done.id, expectedRevision: done.revision }), /only cancelled tasks/);
  } finally { store.close(); }
});
