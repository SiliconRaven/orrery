import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { COORDINATOR_RULES } from '../src/plugins/coordinator/coordinator-rules.ts';
import type { CollaborationActor, CollaborationCommand, CollaborationResult, Task } from '../src/core/collaboration-types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { collaborationLinks, collaborationTasks } from '../src/plugins/tasks/store.ts';

async function fixture() {
  const dir = tempDir();
  const sessions = ['a', 'b', 'c'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const { cluster, members: [a, b, c] } = await app.hub.createCluster('protocol', sessions.map((s) => ({
    harness: 'claude', mode: 'native', sessionId: s.id, name: s.id.toUpperCase(),
  })));
  return { app, native, cluster, a, b, c };
}

test('versioned coordinator rules reach setup, workspace, MCP and current coordinator envelopes', async () => {
  const { app, native, cluster, a, b } = await fixture();
  const clients: Client[] = [];
  try {
    const checks = [/建任务的人自己派工和选验收者：自己有执行资格就自己优先做/,
      /协调员只在用户指定、有成员闲着且有工作等分配、成员出错或离线、流程卡住且成员和程序处理不了时才做事，不主动安排任务/,
      /每轮协调先调用默认 read_messages/, /没有点名任何人的用户消息主动投给协调员/, /成员没有 @ 任何人的发言.*只留在群聊记录里/,
      /先问对方，或查看分支和投递情况，确认没在干活再重新安排/,
      /设计者主笔并创建任务/, /完整设计.*实施步骤.*依赖.*验收标准.*验证方法/,
      /发起人.*设计者.*建单人.*originMessageId/, /可以是同一人.*执行者和验收人都按资格和负荷安排.*不把任务集中堆给同一个人/,
      /不执行、不接任务、不验收/, /符合资格且未参与实现的指定验收人.*用户明确安排/, /建议模式只提出建议/,
      /approve 后任务变为 completed/,
      /需要合并的任务.*运行 ship.*`task_action merge` 补记合并提交/,
      /建单时如果已经知道合适的执行者，直接写上执行者.*和验收人，不需要等协调员同意/,
      /下游在前置 merged 后才就绪/,
      /建单时打开 `requiresApproval`.*用户批准前不分配、不开工/,
      /正常任务生命周期.*不通知协调员/, /异常阻塞.*需要协调.*明确求助/,
      /有可做任务或可验收任务的成员空闲.*Hub 会通知协调员.*执行者在忙、验收人在忙都不算卡住.*先问对方，或查看分支和投递情况.*不打断正在执行的任务/,
      /额度预警或用完的通知.*未开始的任务改派给其他人.*必要时换验收人.*正在执行的任务不打断.*额度恢复的通知不需要回应/,
    ];
    for (const check of checks) assert.match(COORDINATOR_RULES.text, check);
    assert.doesNotMatch(COORDINATOR_RULES.text, /merge\.claim|合并窗口/, 'ship replaced the merge window');
    assert.equal(COORDINATOR_RULES.version, 'v17');
    const set = (memberId: string, enabled: boolean, mode: 'execute' | 'suggest', operationId: string) =>
      app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'coordinator.set', operationId, memberId, enabled, mode });
    const initial = set(a.id, true, 'execute', 'coordinator-a');
    const setup = app.store.listMessages(cluster.id, 100).find((m) => m.kind === 'system')!;
    assert.ok(setup.body.includes(COORDINATOR_RULES.version));
    assert.ok(setup.body.includes(COORDINATOR_RULES.text));
    const first = await waitFor(() => native.delivered.find((d) => d.text.includes(setup.id)), 'setup envelope');
    assert.ok(first.text.endsWith(`规则版本 ${COORDINATOR_RULES.version}；完整规则用 list_tasks 加 include: ['rules'] 读取。`));
    const workspace = (memberId: string) => app.hub.collaboration.query({ kind: 'member', memberId }, cluster.id, { kind: 'workspace' });
    for (const memberId of [a.id, b.id]) {
      const query = workspace(memberId);
      assert.ok('coordinator' in query);
      assert.deepEqual(query.coordinator?.rules, COORDINATOR_RULES);
    }
    assert.equal(Object.hasOwn(app.store.coordinator!.policy(cluster.id)!, 'rules'), false);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    for (const sessionId of ['a', 'b']) {
      const client = new Client({ name: 'coordinator-protocol-test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
        requestInit: { headers: { 'x-orrery-bridge': secret, 'x-orrery-session': sessionId } },
      }));
      clients.push(client);
      const result = await client.callTool({ name: 'list_tasks', arguments: { clusterId: cluster.id, include: ['rules'] } });
      const data = JSON.parse((result.content as { type: string; text: string }[])[0].text);
      assert.deepEqual(data.coordinator.rules, COORDINATOR_RULES);
    }
    const suggest = set(a.id, true, 'suggest', 'coordinator-suggest');
    const suggested = app.hub.collaboration.command({ kind: 'member', memberId: a.id }, cluster.id, {
      action: 'role.create', operationId: 'suggest-role', name: 'example', generation: suggest.coordinator!.generation,
    });
    assert.ok(suggested.suggestion);
    assert.ok(!app.store.collaborationRoles(cluster.id).some((role) => role.name === 'example'));
    assert.notEqual(initial.coordinator!.generation, suggest.coordinator!.generation);
    const changes = app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system');
    assert.ok(changes.at(-1)!.body.includes(COORDINATOR_RULES.text), 'mode change includes the complete rules');

    set(b.id, true, 'execute', 'coordinator-b');
    const switchNotice = app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system').at(-1)!;
    assert.deepEqual(switchNotice.mentions, [b.id]);
    assert.ok(switchNotice.body.includes(COORDINATOR_RULES.text));
    const toOld = app.hub.sendFromUser(cluster.id, '@A old coordinator');
    const toNew = app.hub.sendFromUser(cluster.id, '@B new coordinator');
    const oldEnvelope = await waitFor(() => native.delivered.find((d) => d.text.includes(toOld.id)), 'old coordinator envelope');
    const newEnvelope = await waitFor(() => native.delivered.find((d) => d.text.includes(toNew.id)), 'new coordinator envelope');
    assert.doesNotMatch(oldEnvelope.text, /完整规则用 list_tasks 加 include: \['rules'\] 读取/);
    assert.match(newEnvelope.text, /完整规则用 list_tasks 加 include: \['rules'\] 读取/);
    await waitFor(() => app.store.withDeliveries([toNew])[0].deliveries[0].state === 'done', 'new coordinator delivery');
    set(b.id, false, 'execute', 'disable-coordinator');
    const disabled = app.hub.sendFromUser(cluster.id, '@B disabled coordinator');
    const disabledEnvelope = await waitFor(() => native.delivered.find((d) => d.text.includes(disabled.id)), 'disabled coordinator envelope');
    assert.doesNotMatch(disabledEnvelope.text, /完整规则用 list_tasks 加 include: \['rules'\] 读取/);
  } finally {
    for (const client of clients) await client.close();
    await app.close();
  }
});

test('normal task lifecycle never notifies the coordinator, with direct reviewer and executor notices', async () => {
  const { app, cluster, a, b, c } = await fixture();
  try {
    const user: CollaborationActor = { kind: 'user' };
    const executor: CollaborationActor = { kind: 'member', memberId: b.id };
    const reviewer: CollaborationActor = { kind: 'member', memberId: c.id };
    let serial = 0;
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(actor, cluster.id, { ...command, operationId: `lifecycle-${++serial}` });
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const setupId = app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system').at(-1)!.id;
    const notices = () => app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system' && m.id !== setupId);
    const notice = (eventId: number) => notices().find((m) => m.body.includes(`事件 ${eventId}。`));
    let task = send(user, { action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done', reviewer }).task!;
    task = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, priority: 'high' }).task!;
    const nominated = send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: b.id });
    assert.deepEqual(notice(nominated.eventId)?.mentions, [b.id]);
    const claimed = send(executor, { action: 'task.claim', taskId: task.id, expectedRevision: nominated.task!.revision });
    task = send(executor, { action: 'task.start', taskId: task.id, expectedRevision: claimed.task!.revision,
      assignmentId: claimed.assignment!.id }).task!;
    task = send(executor, { action: 'task.summary', taskId: task.id, expectedRevision: task.revision,
      summary: 'progress', sourceMessageIds: [evidence.id], throughEventId: 0 }).task!;
    const submit = () => send(executor, { action: 'task.submit', commitSha: 'abcdef0', taskId: task.id, expectedRevision: task.revision,
      assignmentId: claimed.assignment!.id, summary: 'result', evidenceMessageIds: [evidence.id] });
    let submitted = submit();
    assert.deepEqual(new Set(notice(submitted.eventId)?.mentions), new Set([c.id, a.id]),
      'the reviewer is woken; the coordinator keeps the submission as unread');
    let rejected = send(reviewer, { action: 'task.review', taskId: task.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'reject', reason: 'revise' });
    assert.deepEqual(notice(rejected.eventId)?.mentions, [b.id]);
    task = rejected.task!;
    submitted = submit();
    assert.deepEqual(new Set(notice(submitted.eventId)?.mentions), new Set([c.id, a.id]));
    for (const message of notices().filter((m) => m.mentions.includes(a.id))) {
      assert.deepEqual(app.store.withDeliveries([message])[0].deliveries.filter((delivery) => delivery.memberId === a.id), [],
        'the coordinator only keeps the record');
    }
    const approval: CollaborationCommand = { action: 'task.review', operationId: 'same-approval', taskId: task.id,
      expectedRevision: submitted.task!.revision, submissionId: submitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' };
    const approved = app.hub.collaboration.command(reviewer, cluster.id, approval);
    assert.equal(approved.task!.status, 'completed');
    assert.deepEqual(notice(approved.eventId)?.mentions, [b.id], 'approval tells the executor; the record stays in the group');
    const before = notices().length;
    assert.deepEqual(app.hub.collaboration.command(reviewer, cluster.id, approval), approved);
    assert.equal(notices().length, before, 'same operation ID creates no second notification');
    assert.throws(() => app.hub.collaboration.command(reviewer, cluster.id, { ...approval, operationId: 'different-approval' }), /revision changed/);
    for (const message of notices().filter((m) => m.mentions.includes(a.id))) {
      assert.deepEqual(app.store.withDeliveries([message])[0].deliveries.filter((delivery) => delivery.memberId === a.id), [],
        'no normal intermediate notification wakes it');
    }
  } finally { await app.close(); }
});

test('suppressed coordinator notifications retain only their existing group history and remain idempotent', async () => {
  const { app, cluster, a, b, c } = await fixture();
  try {
    app.hub.setPaused(true);
    const user: CollaborationActor = { kind: 'user' };
    const member: CollaborationActor = { kind: 'member', memberId: b.id };
    const send = (actor: CollaborationActor, command: CollaborationCommand) => app.hub.collaboration.command(actor, cluster.id, command);
    const systemFor = (eventId: number) => app.store.listMessages(cluster.id, 100)
      .filter((m) => m.kind === 'system' && m.body.includes(`事件 ${eventId}。`));
    const beforeCoordinator = send(user, { action: 'task.create', operationId: 'history-before', title: 'before', scope: 'scope', acceptance: 'done' });
    assert.deepEqual(systemFor(beforeCoordinator.eventId), [], 'no coordinator previously meant no notification record');
    const policy = send(user, { action: 'coordinator.set', operationId: 'history-policy', memberId: a.id, enabled: true, mode: 'execute' }).coordinator!;
    const beforeEvent = app.store.lastEventSeq();
    const beforeMessages = app.store.listMessages(cluster.id, 100).length;
    const appendEvent = app.store.appendEvent;
    app.store.appendEvent = (...args) => {
      const event = appendEvent.apply(app.store, args);
      if (args[2] === 'message') throw new Error('injected message event failure');
      return event;
    };
    const rollback: CollaborationCommand = { action: 'task.create', operationId: 'history-rollback', title: 'rollback', scope: 'scope', acceptance: 'done' };
    try { assert.throws(() => send(user, rollback), /injected message event failure/); }
    finally { app.store.appendEvent = appendEvent; }
    assert.equal(app.store.lastEventSeq(), beforeEvent);
    assert.equal(app.store.listMessages(cluster.id, 100).length, beforeMessages);
    assert.ok(!collaborationTasks(app.store, cluster.id, 100).tasks.some((task) => task.title === 'rollback'));
    const retried = send(user, rollback);
    assert.equal(systemFor(retried.eventId).length, 1, 'transaction rollback did not save the operation');
    const coordinatorCreate = send({ kind: 'member', memberId: a.id }, { action: 'task.create', operationId: 'history-own',
      title: 'own', scope: 'scope', acceptance: 'done', generation: policy.generation });
    assert.deepEqual(systemFor(coordinatorCreate.eventId), [], 'the coordinator’s own creation previously did not notify itself');
    const create: CollaborationCommand = { action: 'task.create', operationId: 'history-create', title: 'work', scope: 'scope',
      acceptance: 'done', reviewer: { kind: 'member', memberId: c.id } };
    const created = send(user, create);
    const createdMessages = systemFor(created.eventId);
    assert.equal(createdMessages.length, 1);
    assert.deepEqual(createdMessages[0].mentions, []);
    assert.deepEqual(app.store.withDeliveries(createdMessages)[0].deliveries, []);
    assert.deepEqual(collaborationLinks(app.store, createdMessages[0].id), [created.task!.id]);
    assert.ok(app.events.some((event) => event.kind === 'message' && (event.payload as any).message.id === createdMessages[0].id),
      'the empty-recipient message is published to the group');
    assert.deepEqual(send(user, create), created);
    assert.equal(systemFor(created.eventId).length, 1);

    const claim: CollaborationCommand = { action: 'task.claim', operationId: 'history-claim', taskId: created.task!.id,
      expectedRevision: created.task!.revision };
    const claimed = send(member, claim);
    const claimedMessages = systemFor(claimed.eventId);
    assert.equal(claimedMessages.length, 1);
    assert.deepEqual(claimedMessages[0].mentions, []);
    assert.deepEqual(app.store.withDeliveries(claimedMessages)[0].deliveries, []);
    assert.deepEqual(collaborationLinks(app.store, claimedMessages[0].id), [created.task!.id]);
    assert.deepEqual(send(member, claim), claimed);
    assert.equal(systemFor(claimed.eventId).length, 1);

    const started = send(member, { action: 'task.start', operationId: 'history-start', taskId: created.task!.id,
      expectedRevision: claimed.task!.revision, assignmentId: claimed.assignment!.id });
    const startMessages = systemFor(started.eventId);
    assert.equal(startMessages.length, 1, 'a start is an info notice now');
    assert.deepEqual(new Set(startMessages[0].mentions), new Set([c.id, a.id]), 'the reviewer and the coordinator keep it unread');
    assert.deepEqual(app.store.withDeliveries(startMessages)[0].deliveries, [], 'and nobody is woken');
    const evidence = app.hub.sendFromUser(cluster.id, 'proof', [b.id]);
    const submitted = send(member, { action: 'task.submit', commitSha: 'abcdef0', operationId: 'history-submit', taskId: created.task!.id,
      expectedRevision: started.task!.revision, assignmentId: claimed.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    const submittedMessages = systemFor(submitted.eventId);
    assert.equal(submittedMessages.length, 1, 'a direct reviewer and retained history share one notification');
    assert.deepEqual(new Set(submittedMessages[0].mentions), new Set([c.id, a.id]));
    assert.deepEqual(app.store.withDeliveries(submittedMessages)[0].deliveries.map((d) => d.memberId), [c.id]);
    assert.deepEqual(collaborationLinks(app.store, submittedMessages[0].id), [created.task!.id]);

    send(user, { action: 'coordinator.set', operationId: 'history-disable', memberId: a.id, enabled: false, mode: 'execute' });
    const disabled = send(user, { action: 'task.create', operationId: 'history-disabled', title: 'disabled', scope: 'scope', acceptance: 'done' });
    assert.deepEqual(systemFor(disabled.eventId), [], 'a disabled coordinator did not cause a history record');
  } finally { await app.close(); }
});

test('a newly appointed coordinator is not woken by its earlier reviewer or nominee role', async () => {
  const { app, cluster, a, b, c } = await fixture();
  try {
    const user: CollaborationActor = { kind: 'user' };
    const executor: CollaborationActor = { kind: 'member', memberId: c.id };
    let serial = 0;
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(actor, cluster.id, { ...command, operationId: `overlap-${++serial}` });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const work = send(user, { action: 'task.create', title: 'review', scope: 'scope', acceptance: 'done',
      reviewer: { kind: 'member', memberId: b.id } }).task!;
    const pending = send(user, { action: 'task.create', title: 'nominee', scope: 'scope', acceptance: 'done' }).task!;
    const nominated = send(user, { action: 'task.nominate', taskId: pending.id, expectedRevision: pending.revision, memberId: b.id });
    const claimed = send(executor, { action: 'task.claim', taskId: work.id, expectedRevision: work.revision });
    const started = send(executor, { action: 'task.start', taskId: work.id, expectedRevision: claimed.task!.revision,
      assignmentId: claimed.assignment!.id });
    send(user, { action: 'coordinator.set', memberId: b.id, enabled: true, mode: 'execute' });
    const submitted = send(executor, { action: 'task.submit', commitSha: 'abcdef0', taskId: work.id, expectedRevision: started.task!.revision,
      assignmentId: claimed.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    assert.throws(() => send(user, { action: 'task.assign', taskId: pending.id, expectedRevision: nominated.task!.revision, memberId: b.id }), /coordinator and cannot execute/);
    const repeatedNomination = send(user, { action: 'task.edit', taskId: pending.id, expectedRevision: nominated.task!.revision, scope: 'changed' });
    const messages = app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system');
    // The old reviewer, now the coordinator, cannot review this task any more: it keeps the submission as unread and
    // is not woken. The unrelated edit still names nobody.
    const submittedHistory = messages.find((m) => m.body.includes(`事件 ${submitted.eventId}。`))!;
    assert.deepEqual(submittedHistory.mentions, [b.id], 'the old reviewer keeps it as unread');
    assert.deepEqual(app.store.withDeliveries([submittedHistory])[0].deliveries, [], 'and is not woken');
    const editHistory = messages.find((m) => m.body.includes(`事件 ${repeatedNomination.eventId}。`))!;
    assert.deepEqual(editHistory.mentions, []);
    assert.deepEqual(app.store.withDeliveries([editHistory])[0].deliveries, []);
    assert.deepEqual(submitted.task!.reviewer, { kind: 'member', memberId: b.id });
    assert.equal(repeatedNomination.task!.assignedMemberId, b.id, 'the Hub does not silently reassign the task');
    assert.throws(() => send({ kind: 'member', memberId: b.id }, { action: 'task.review', taskId: work.id,
      expectedRevision: submitted.task!.revision, submissionId: submitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' }), /coordinator.*cannot review/);
  } finally { await app.close(); }
});

test('dependency notices reach a newly ready nominee and preserve review and completion invalidation', async () => {
  const { app, cluster, a, b, c } = await fixture();
  try {
    const { members: [d] } = await app.hub.addMembers(cluster.id, [{ harness: 'claude', mode: 'native', name: 'D', projectPath: '/work' }]);
    const user: CollaborationActor = { kind: 'user' };
    const actor = (id: string): CollaborationActor => ({ kind: 'member', memberId: id });
    let serial = 0;
    const send = (who: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(who, cluster.id, { ...command, operationId: `dependency-${++serial}` });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const create = (title: string, dependencies: string[] = [], reviewer: CollaborationActor = user) => send(user, {
      action: 'task.create', title, scope: title, acceptance: 'done', dependencyIds: dependencies, reviewer, mergeRequired: false,
    }).task!;
    const messagesFor = (eventId: number) => app.store.listMessages(cluster.id, 100)
      .filter((m) => m.kind === 'system' && m.body.includes(`事件 ${eventId}。`));
    const noticesFor = (eventId: number) => messagesFor(eventId).flatMap((m) => m.mentions);
    const submit = (task: Task, memberId: string) => {
      const claim = send(actor(memberId), { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
      const start = send(actor(memberId), { action: 'task.start', taskId: task.id, expectedRevision: claim.task!.revision,
        assignmentId: claim.assignment!.id });
      const submitted = send(actor(memberId), { action: 'task.submit', commitSha: 'abcdef0', taskId: task.id, expectedRevision: start.task!.revision,
        assignmentId: claim.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
      return { ...submitted, assignmentId: claim.assignment!.id };
    };
    const approve = (result: CollaborationResult, who: CollaborationActor = user) => send(who, {
      action: 'task.review', taskId: result.task!.id, expectedRevision: result.task!.revision,
      submissionId: result.submission!.id, verdict: 'approve', reason: 'Independent review passed',
    });
    let p = create('first');
    let q = create('second');
    let downstream = create('downstream', [p.id, q.id], actor(c.id));
    downstream = send(user, { action: 'task.nominate', taskId: downstream.id, expectedRevision: downstream.revision, memberId: d.id }).task!;
    const first = approve(submit(p, b.id)); p = first.task!;
    assert.ok(!noticesFor(first.eventId).includes(d.id), 'one of two dependencies is not ready');
    assert.ok(!noticesFor(first.eventId).includes(c.id), 'an unsubmitted dependent does not notify its reviewer');
    const qResult = submit(q, b.id);
    const approval: CollaborationCommand = { action: 'task.review', operationId: 'dependency-approve-q', taskId: q.id,
      expectedRevision: qResult.task!.revision, submissionId: qResult.submission!.id, verdict: 'approve', reason: 'Independent review passed' };
    const second = app.hub.collaboration.command(user, cluster.id, approval); q = second.task!;
    assert.ok(noticesFor(second.eventId).includes(d.id), 'the nominated downstream executor receives readiness');
    assert.ok(!noticesFor(second.eventId).includes(c.id), 'readiness does not notify the unsubmitted reviewer');
    const ready = messagesFor(second.eventId).find((m) => m.mentions.includes(d.id))!;
    assert.match(ready.body, /前置依赖已就绪/);
    assert.ok(ready.body.includes(downstream.title) && ready.body.includes(downstream.id));
    assert.deepEqual(collaborationLinks(app.store, ready.id), [downstream.id]);
    const beforeRetry = messagesFor(second.eventId).length;
    assert.deepEqual(app.hub.collaboration.command(user, cluster.id, approval), second);
    assert.equal(messagesFor(second.eventId).length, beforeRetry, 'retry does not duplicate readiness notifications');

    let result = submit(downstream, d.id);
    let reopened = send(user, { action: 'task.reopen', taskId: p.id, expectedRevision: p.revision, reason: 'changed' });
    assert.ok(noticesFor(reopened.eventId).includes(c.id), 'a pending review is told when its dependency becomes invalid');
    const rejected = send(actor(c.id), { action: 'task.review', taskId: downstream.id, expectedRevision: result.task!.revision,
      submissionId: result.submission!.id, verdict: 'reject', reason: 'revise' });
    downstream = rejected.task!;
    p = approve(submit(reopened.task!, b.id)).task!;
    const reapproved = app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system').at(-1)!;
    assert.ok(reapproved.mentions.includes(d.id), 'the executor hears that its dependency changed');
    assert.match(reapproved.body, /前置依赖已就绪/);
    assert.deepEqual(collaborationLinks(app.store, reapproved.id), [downstream.id]);
    assert.ok(!reapproved.mentions.includes(c.id), 'a returned submission does not wake its reviewer before revision');
    const changed = app.hub.collaboration.query(user, cluster.id, { kind: 'task', taskId: downstream.id });
    assert.ok('task' in changed && changed.task.dependenciesChanged);
    const revised = send(actor(d.id), { action: 'task.submit', commitSha: 'abcdef0', taskId: downstream.id, expectedRevision: downstream.revision,
      assignmentId: result.assignmentId, summary: 'revised', evidenceMessageIds: [evidence.id],
      expectedDependencyVersions: { [p.id]: p.approvedSubmissionId!, [q.id]: q.approvedSubmissionId! } });
    downstream = approve(revised, actor(c.id)).task!;
    reopened = send(user, { action: 'task.reopen', taskId: p.id, expectedRevision: p.revision, reason: 'again' });
    assert.ok(noticesFor(reopened.eventId).includes(d.id), 'the completed dependent executor hears invalidation');
    assert.ok(noticesFor(reopened.eventId).includes(c.id), 'the completed dependent reviewer hears invalidation');
    const invalid = app.hub.collaboration.query(user, cluster.id, { kind: 'task', taskId: downstream.id });
    assert.ok('task' in invalid && !invalid.task.completionValid);
  } finally { await app.close(); }
});

test('questions, release, handoff, reopen and delivery failures still reach the coordinator', async () => {
  const { app, native, cluster, a, b, c } = await fixture();
  try {
    const user: CollaborationActor = { kind: 'user' };
    const member: CollaborationActor = { kind: 'member', memberId: b.id };
    let serial = 0;
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(actor, cluster.id, { ...command, operationId: `exception-${++serial}` });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    let task = send(user, { action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done' }).task!;
    const noticesFor = (eventId: number) => app.store.listMessages(cluster.id, 100)
      .find((m) => m.kind === 'system' && m.body.includes(`事件 ${eventId}。`))?.mentions ?? [];
    for (const target of [null, a.id, c.id]) {
      const attention = send(user, { action: 'task.attention', taskId: task.id, expectedRevision: task.revision,
        kind: 'question', question: 'help', targetMemberId: target });
      task = attention.task!;
      assert.ok(noticesFor(attention.eventId).includes(a.id));
      assert.equal(noticesFor(attention.eventId).filter((id) => id === a.id).length, 1);
      if (target === c.id) assert.ok(noticesFor(attention.eventId).includes(c.id));
    }
    const claimed = send(member, { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
    const released = send(member, { action: 'task.release', taskId: task.id, expectedRevision: claimed.task!.revision,
      assignmentId: claimed.assignment!.id, reason: 'cannot continue' });
    assert.ok(noticesFor(released.eventId).includes(a.id));
    const again = send(member, { action: 'task.claim', taskId: task.id, expectedRevision: released.task!.revision });
    const handoff = send(user, { action: 'task.handoff', taskId: task.id, expectedRevision: again.task!.revision,
      assignmentId: again.assignment!.id, memberId: c.id, reason: 'change executor' });
    assert.deepEqual(new Set(noticesFor(handoff.eventId)), new Set([a.id, b.id, c.id]),
      'the coordinator, the previous executor and the new nominee hear about the handoff');
    const claimC = send({ kind: 'member', memberId: c.id }, { action: 'task.claim', taskId: task.id, expectedRevision: handoff.task!.revision });
    const startC = send({ kind: 'member', memberId: c.id }, { action: 'task.start', taskId: task.id, expectedRevision: claimC.task!.revision,
      assignmentId: claimC.assignment!.id });
    const submitted = send({ kind: 'member', memberId: c.id }, { action: 'task.submit', commitSha: 'abcdef0', taskId: task.id, expectedRevision: startC.task!.revision,
      assignmentId: claimC.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    const approved = send(user, { action: 'task.review', taskId: task.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' });
    const reopened = send(user, { action: 'task.reopen', taskId: task.id, expectedRevision: approved.task!.revision, reason: 'new issue' });
    assert.ok(noticesFor(reopened.eventId).includes(a.id));

    native.isOnline = (session) => session !== 'c';
    const offline = app.hub.sendFromUser(cluster.id, '@C delivery that fails');
    assert.equal(app.store.withDeliveries([offline])[0].deliveries[0].state, 'offline');
    const failure = app.store.listMessages(cluster.id, 100).find((m) => m.kind === 'system' && m.body.includes(offline.id));
    assert.ok(failure?.mentions.includes(a.id), 'delivery failure is still reported');
  } finally { await app.close(); }
});

test('an upstream reviewer who owns a downstream task receives its ready notice', async () => {
  const { app, cluster, a, b, c } = await fixture();
  try {
    const user: CollaborationActor = { kind: 'user' };
    const actor = (id: string): CollaborationActor => ({ kind: 'member', memberId: id });
    let serial = 0;
    const send = (who: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(who, cluster.id, { ...command, operationId: `reviewer-owner-${++serial}` });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const source = send(user, { action: 'task.create', title: 'upstream', scope: 'scope', acceptance: 'done', mergeRequired: false, reviewer: actor(b.id) }).task!;
    const child = send(user, { action: 'task.create', title: 'child', scope: 'scope', acceptance: 'done', dependencyIds: [source.id] }).task!;
    send(user, { action: 'task.nominate', taskId: child.id, expectedRevision: child.revision, memberId: b.id });
    const claim = send(actor(c.id), { action: 'task.claim', taskId: source.id, expectedRevision: source.revision });
    const started = send(actor(c.id), { action: 'task.start', taskId: source.id, expectedRevision: claim.task!.revision, assignmentId: claim.assignment!.id });
    const submitted = send(actor(c.id), { action: 'task.submit', commitSha: 'abcdef0', taskId: source.id, expectedRevision: started.task!.revision,
      assignmentId: claim.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    const approval = send(actor(b.id), { action: 'task.review', taskId: source.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' });
    const notices = app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system' && m.body.includes(`事件 ${approval.eventId}。`));
    const ready = notices.find((m) => m.mentions.includes(b.id) && m.body.includes('前置依赖已就绪'))!;
    assert.ok(ready.body.includes(child.id));
    assert.deepEqual(collaborationLinks(app.store, ready.id), [child.id]);
    assert.equal(notices.filter((m) => m.mentions.includes(a.id)).length, 0, 'the coordinator is not told about the approval');
  } finally { await app.close(); }
});

test('a notification listener failure does not prevent other ready notices from being published', async () => {
  const { app, cluster, a, b, c } = await fixture();
  try {
    const { members: [d] } = await app.hub.addMembers(cluster.id, [{ harness: 'claude', mode: 'native', name: 'D', projectPath: '/work' }]);
    const user: CollaborationActor = { kind: 'user' };
    const executor: CollaborationActor = { kind: 'member', memberId: d.id };
    let serial = 0;
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(actor, cluster.id, { ...command, operationId: `notify-failure-${++serial}` });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const source = send(user, { action: 'task.create', title: 'source', scope: 'scope', acceptance: 'done', mergeRequired: false }).task!;
    for (const target of [b.id, c.id]) {
      const dependent = send(user, { action: 'task.create', title: 'dependent', scope: 'scope', acceptance: 'done', dependencyIds: [source.id] }).task!;
      send(user, { action: 'task.nominate', taskId: dependent.id, expectedRevision: dependent.revision, memberId: target });
    }
    const claim = send(executor, { action: 'task.claim', taskId: source.id, expectedRevision: source.revision });
    const started = send(executor, { action: 'task.start', taskId: source.id, expectedRevision: claim.task!.revision, assignmentId: claim.assignment!.id });
    const submitted = send(executor, { action: 'task.submit', commitSha: 'abcdef0', taskId: source.id, expectedRevision: started.task!.revision,
      assignmentId: claim.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    const approval: CollaborationCommand = { action: 'task.review', operationId: 'notify-failure-approval', taskId: source.id,
      expectedRevision: submitted.task!.revision, submissionId: submitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' };
    const published: string[] = [];
    const stop = app.hub.subscribe((event) => {
      if (event.kind !== 'message') return;
      published.push((event.payload as any).message.id);
      if (published.length === 1) throw new Error('message listener failed');
    });
    assert.equal(app.hub.collaboration.command(user, cluster.id, approval).task!.status, 'completed');
    stop();
    assert.equal(published.length, 3, 'completion and both readiness messages were published');
    const notices = published.map((id) => app.store.getMessage(id)!);
    assert.ok(!notices.some((m) => m.mentions.includes(a.id)), 'the coordinator is not told about the approval');
    assert.ok(notices.some((m) => m.mentions.includes(d.id) && m.body.includes('验收通过')));
    assert.ok(notices.some((m) => m.mentions.includes(b.id) && m.body.includes('前置依赖已就绪')));
    assert.ok(notices.some((m) => m.mentions.includes(c.id) && m.body.includes('前置依赖已就绪')));
    await waitFor(() => notices.every((m) => app.store.withDeliveries([m])[0].deliveries.every((d) => d.state === 'done')), 'all committed notices');
    const beforeRetry = app.store.listMessages(cluster.id, 100).length;
    assert.equal(app.hub.collaboration.command(user, cluster.id, approval).task!.status, 'completed');
    assert.equal(app.store.listMessages(cluster.id, 100).length, beforeRetry);
  } finally { await app.close(); }
});
