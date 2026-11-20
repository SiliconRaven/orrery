import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { COORDINATOR_RULES } from '../src/plugins/coordinator/coordinator-rules.ts';
import { rawFetch, startTestHub, tempDir, waitFor } from './helpers.ts';

/** Three native mock members: A, B and C (A becomes the coordinator where a test needs one). */
async function fixture(name = 'notices') {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const { cluster, members: [a, b, c] } = await app.hub.createCluster(name, [
    { harness: 'claude', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'claude', mode: 'native', sessionId: 's2', name: 'B' },
    { harness: 'claude', mode: 'native', sessionId: 's3', name: 'C' },
  ]);
  let serial = 0;
  const send = (actor: { kind: 'user' } | { kind: 'member'; memberId: string } | { kind: 'system' }, command: Record<string, unknown>) =>
    app.hub.collaboration.command(actor as never, cluster.id, { operationId: `notice-${++serial}`, ...command } as never) as never as
      { eventId: number; task?: any; assignment?: any; submission?: any; coordinator?: any };
  const user = { kind: 'user' as const };
  const as = (member: any) => ({ kind: 'member' as const, memberId: member.id });
  const systems = () => app.store.listMessages(cluster.id, 200).filter((message) => message.kind === 'system');
  const notice = (eventId: number) => systems().find((message) => message.collabEventId === eventId);
  const storeEvent = (eventId: number) => app.store.getEvent(eventId)!;
  const deliveriesOf = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries;
  return { app, native, cluster, a, b, c, send, user, as, systems, notice, storeEvent, deliveriesOf };
}

test('task create and edit record only the definition fields that changed', async () => {
  const { app, cluster, b, send, user, storeEvent, notice } = await fixture('changes');
  try {
    const created = send(user, { action: 'task.create', title: 'work', scope: 'old scope', acceptance: 'done',
      priority: 'high', labels: ['ui'], reviewer: { kind: 'member', memberId: b.id } });
    const byField = Object.fromEntries(((storeEvent(created.eventId).payload as any).changes as any[])
      .map((change) => [change.field, change]));
    assert.equal(byField.title.before, null, 'create starts from the empty definition');
    assert.equal(byField.title.after, 'work');
    assert.equal(byField.scope.after, 'old scope');
    assert.equal(byField.priority.after, 'high');
    assert.deepEqual(byField.labels.before, []);
    assert.deepEqual(byField.labels.after, ['ui']);
    assert.deepEqual(byField.reviewer.after, { kind: 'member', memberId: b.id });
    assert.equal(byField.executeRoleIds, undefined, 'unchanged empty lists are not recorded');
    let task = created.task!;
    const renamed = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, title: 'renamed' });
    assert.deepEqual((storeEvent(renamed.eventId).payload as any).changes,
      [{ field: 'title', before: 'work', after: 'renamed' }]);
    task = renamed.task!;
    const same = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, title: 'renamed' });
    assert.equal(Object.hasOwn(storeEvent(same.eventId).payload as object, 'changes'), false,
      'an edit that changes nothing records no changes');
    assert.equal(notice(same.eventId), undefined, 'an edit that changes nothing notifies nobody');
    const scoped = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: same.task!.revision, scope: 'new scope' });
    assert.deepEqual(((storeEvent(scoped.eventId).payload as any).changes as any[]).map((change) => change.field), ['scope']);
  } finally { await app.close(); }
});

test('task notifications are Chinese sentences with the event number and the right recipients', async () => {
  const { app, cluster, a, b, c, send, user, as, systems, notice, deliveriesOf } = await fixture('sentences');
  try {
    const setup = send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const setupNotice = systems().find((message) => message.body.includes('协调员已改为 A'))!;
    assert.equal(setupNotice.collabEventId, undefined, 'a coordinator setup notice has no task event to open');
    assert.equal(setupNotice.systemKind, 'coordinator');
    assert.match(setupNotice.body, /协调员已改为 A（授权执行）/);
    assert.ok(setupNotice.body.includes(`协调规则 ${COORDINATOR_RULES.version}：`), 'the setup message still carries the complete rules');
    let task = send(user, { action: 'task.create', title: 'work', scope: 's', acceptance: 'done', reviewer: as(c) }).task!;
    const created = systems().find((message) => message.collabEventId && message.body.includes('任务 #1【work】已创建'));
    assert.match(created!.body, /任务 #1【work】已创建（建单人 用户），事件 \d+。/);
    assert.deepEqual(created!.mentions, [], 'the group keeps the record without waking the coordinator');
    assert.equal(created!.systemKind, 'task', 'routine task progress');
    const renamed = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, title: 'work2' });
    assert.match(notice(renamed.eventId)!.body, /任务 #1【work2】已更新：改了 标题，事件 \d+。/);
    assert.deepEqual(notice(renamed.eventId)!.mentions, [c.id]);
    task = renamed.task!;
    const nominated = send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: b.id });
    assert.match(notice(nominated.eventId)!.body, /任务 #1【work2】已分配给 B，事件 \d+。/);
    task = nominated.task!;
    const claimed = send(as(b), { action: 'task.claim', taskId: task.id, expectedRevision: task.revision });
    assert.match(notice(claimed.eventId)!.body, /B 接取了任务 #1【work2】，事件 \d+。/);
    task = claimed.task!;
    const started = send(as(b), { action: 'task.start', taskId: task.id, expectedRevision: task.revision, assignmentId: claimed.assignment!.id });
    const startNotice = notice(started.eventId)!;
    assert.match(startNotice.body, /B 开始执行任务 #1【work2】，事件 \d+。/);
    assert.deepEqual(new Set(startNotice.mentions), new Set([a.id, c.id]), 'the coordinator and the reviewer keep the start as unread');
    assert.deepEqual(deliveriesOf(startNotice.id), [], 'and nobody is woken');
    task = started.task!;
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    const submitted = send(as(b), { action: 'task.submit', commitSha: 'abcdef0', taskId: task.id, expectedRevision: task.revision,
      assignmentId: claimed.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    assert.match(notice(submitted.eventId)!.body, /B 提交了任务 #1【work2】的结果，等待 C 验收，事件 \d+。/);
    task = submitted.task!;
    const rejected = send(as(c), { action: 'task.review', taskId: task.id, expectedRevision: task.revision,
      submissionId: submitted.submission!.id, verdict: 'reject', reason: 'revise' });
    assert.match(notice(rejected.eventId)!.body, /C 退回了任务 #1【work2】的结果（原因：revise），事件 \d+。/);
    assert.equal(notice(rejected.eventId)!.systemKind, 'task_rejected');
    task = rejected.task!;
    const resubmitted = send(as(b), { action: 'task.submit', commitSha: 'abcdef0', taskId: task.id, expectedRevision: task.revision,
      assignmentId: claimed.assignment!.id, summary: 'again', evidenceMessageIds: [evidence.id] });
    task = resubmitted.task!;
    const approved = send(as(c), { action: 'task.review', taskId: task.id, expectedRevision: task.revision,
      submissionId: resubmitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' });
    const approveNotice = notice(approved.eventId)!;
    assert.match(approveNotice.body, /C 验收通过了任务 #1【work2】，任务已完成，事件 \d+。/);
    assert.deepEqual(approveNotice.mentions, [b.id], 'completion tells the executor, not the coordinator');
    assert.equal(systems().filter((message) => message.collabEventId === approved.eventId).length, 1);
    // attention
    const asking = send(user, { action: 'task.create', title: 'ask', scope: 's', acceptance: 'done' }).task!;
    const attention = send(user, { action: 'task.attention', taskId: asking.id, expectedRevision: asking.revision,
      kind: 'question', question: '需要协调吗', targetMemberId: b.id });
    assert.match(notice(attention.eventId)!.body, /任务 #2【ask】有新的待处理事项：需要协调吗，事件 \d+。/);
    assert.equal(notice(attention.eventId)!.systemKind, 'task_attention');
    assert.deepEqual(new Set(deliveriesOf(notice(attention.eventId)!.id).map((delivery) => delivery.memberId)),
      new Set([b.id, a.id]), 'the target and the coordinator (an exception trigger) hear about the attention');
    // release / cancel / reopen / handoff
    const releaseTask = send(user, { action: 'task.create', title: 'release', scope: 's', acceptance: 'done', reviewer: as(c) }).task!;
    const releaseNominated = send(user, { action: 'task.nominate', taskId: releaseTask.id, expectedRevision: releaseTask.revision, memberId: b.id }).task!;
    const releaseClaim = send(as(b), { action: 'task.claim', taskId: releaseNominated.id, expectedRevision: releaseNominated.revision });
    const releaseStarted = send(as(b), { action: 'task.start', taskId: releaseClaim.task!.id,
      expectedRevision: releaseClaim.task!.revision, assignmentId: releaseClaim.assignment!.id }).task!;
    const released = send(user, { action: 'task.release', taskId: releaseStarted.id, expectedRevision: releaseStarted.revision,
      assignmentId: releaseClaim.assignment!.id, reason: '换人', confirmStopped: true });
    assert.match(notice(released.eventId)!.body, /任务 #3【release】的派工已释放（原因：换人），事件 \d+。/);
    const cancelTask = send(user, { action: 'task.create', title: 'cancel', scope: 's', acceptance: 'done', reviewer: as(c) }).task!;
    const cancelNominated = send(user, { action: 'task.nominate', taskId: cancelTask.id, expectedRevision: cancelTask.revision, memberId: b.id }).task!;
    const cancelClaim = send(as(b), { action: 'task.claim', taskId: cancelNominated.id, expectedRevision: cancelNominated.revision });
    const cancelled = send(user, { action: 'task.cancel', taskId: cancelClaim.task!.id, expectedRevision: cancelClaim.task!.revision,
      assignmentId: cancelClaim.assignment!.id, reason: '不做了' });
    assert.match(notice(cancelled.eventId)!.body, /任务 #4【cancel】已取消（原因：不做了），事件 \d+。/);
    const reopened = send(user, { action: 'task.reopen', taskId: cancelled.task!.id, expectedRevision: cancelled.task!.revision, reason: '继续' });
    assert.match(notice(reopened.eventId)!.body, /任务 #4【cancel】已重新打开（原因：继续），事件 \d+。/);
    const handoffTask = send(user, { action: 'task.create', title: 'hand', scope: 's', acceptance: 'done' }).task!;
    const handoffNominated = send(user, { action: 'task.nominate', taskId: handoffTask.id, expectedRevision: handoffTask.revision, memberId: b.id }).task!;
    const handoffClaim = send(as(b), { action: 'task.claim', taskId: handoffNominated.id, expectedRevision: handoffNominated.revision });
    const handoffStarted = send(as(b), { action: 'task.start', taskId: handoffClaim.task!.id,
      expectedRevision: handoffClaim.task!.revision, assignmentId: handoffClaim.assignment!.id }).task!;
    const handed = send(user, { action: 'task.handoff', taskId: handoffStarted.id, expectedRevision: handoffStarted.revision,
      assignmentId: handoffClaim.assignment!.id, memberId: c.id, reason: '接手', confirmStopped: true });
    assert.match(notice(handed.eventId)!.body, /任务 #5【hand】已转交给 C（原因：接手），事件 \d+。/);
    for (const message of systems()) assert.doesNotMatch(message.body, /协作事件 task\./, 'no old-style body remains');
  } finally { await app.close(); }
});

test('normal finishes stay in the chat record without reaching the coordinator; attention, release, handoff and reopen still do', async () => {
  const { app, cluster, a, b, c, send: rawSend, user, as, notice, deliveriesOf } = await fixture('finish-quiet');
  const send = rawSend as (actor: any, command: Record<string, unknown>) => any;
  try {
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof', [b.id]);
    const start = (title: string, extra: Record<string, unknown>) => {
      const created = send(user, { action: 'task.create', title, scope: 's', acceptance: 'done', ...extra }).task;
      const claim = send(as(b), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
      const task = send(as(b), { action: 'task.start', taskId: created.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id }).task;
      return { task, assignmentId: claim.assignment.id };
    };
    const submit = ({ task, assignmentId }: { task: any; assignmentId: string }) => send(as(b), { action: 'task.submit', taskId: task.id,
      expectedRevision: task.revision, assignmentId, summary: 'done', evidenceMessageIds: [evidence.id], commitSha: 'abcdef0123' });
    const approve = (submitted: any) => send(as(c), { action: 'task.review', taskId: submitted.task.id, expectedRevision: submitted.task.revision,
      submissionId: submitted.submission.id, verdict: 'approve', reason: 'ok' });
    const reachesCoordinator = (message: { id: string; mentions: string[] }) => message.mentions.includes(a.id)
      || deliveriesOf(message.id).some((delivery) => delivery.memberId === a.id);
    const quiet = (eventId: number, body: RegExp) => {
      const message = notice(eventId)!;
      assert.match(message.body, body, 'the group keeps the record');
      assert.equal(reachesCoordinator(message), false, 'the coordinator is not told');
    };

    const reviewed = start('reviewed', { reviewer: as(c) });
    const approved = approve(submit(reviewed));
    quiet(approved.eventId, /C 验收通过了任务 #1【reviewed】/);
    const merged = send({ kind: 'system' }, { action: 'task.shipped', taskId: approved.task.id, expectedRevision: approved.task.revision, submissionId: approved.task.approvedSubmissionId, commitSha: 'abcdef1234', reason: 'ship' });
    quiet(merged.eventId, /任务 #1【reviewed】已合并/);

    const toShip = approve(submit(start('shipped', { reviewer: as(c) })));
    const shipped = send({ kind: 'system' }, { action: 'task.shipped', taskId: toShip.task.id, expectedRevision: toShip.task.revision,
      submissionId: toShip.submission?.id ?? toShip.task.approvedSubmissionId, commitSha: 'abcdef5678', reason: 'ship' });
    quiet(shipped.eventId, /任务 #2【shipped】已合并/);

    const selfDone = submit(start('self', { reviewer: { kind: 'self' }, mergeRequired: false }));
    assert.equal(selfDone.task.status, 'completed');
    quiet(selfDone.eventId, /任务 #3【self】的结果并完成自查/);

    const reopened = send(user, { action: 'task.reopen', taskId: selfDone.task.id, expectedRevision: selfDone.task.revision, reason: 'again' });
    assert.equal(reachesCoordinator(notice(reopened.eventId)!), true, 'reopen');
    const toRelease = start('release', {});
    const released = send(user, { action: 'task.release', taskId: toRelease.task.id, expectedRevision: toRelease.task.revision,
      assignmentId: toRelease.assignmentId, reason: 'x', confirmStopped: true });
    assert.equal(reachesCoordinator(notice(released.eventId)!), true, 'release');
    const toHand = start('hand', {});
    const handed = send(user, { action: 'task.handoff', taskId: toHand.task.id, expectedRevision: toHand.task.revision,
      assignmentId: toHand.assignmentId, memberId: c.id, reason: 'x', confirmStopped: true });
    assert.equal(reachesCoordinator(notice(handed.eventId)!), true, 'handoff');
    const asking = send(user, { action: 'task.create', title: 'ask', scope: 's', acceptance: 'done' }).task;
    const attention = send(user, { action: 'task.attention', taskId: asking.id, expectedRevision: asking.revision, kind: 'question', question: 'q', targetMemberId: b.id });
    assert.equal(reachesCoordinator(notice(attention.eventId)!), true, 'attention');
  } finally { await app.close(); }
});

test('without a coordinator a self-reviewed completion and a merge still leave one linked record that names nobody', async () => {
  const { app, cluster, a, b, user, as, systems, notice, deliveriesOf } = await fixture('finish-record');
  try {
    let serial = 0;
    const send = (actor: unknown, command: Record<string, unknown>, operationId = `record-${++serial}`) =>
      app.hub.collaboration.command(actor as never, cluster.id, { operationId, ...command } as never) as any;
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    const finish = (extra: Record<string, unknown>) => {
      const created = send(user, { action: 'task.create', title: 'self', scope: 's', acceptance: 'a', reviewer: { kind: 'self' }, ...extra }).task;
      const claim = send(as(b), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
      const started = send(as(b), { action: 'task.start', taskId: created.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
      const command = { action: 'task.submit', taskId: created.id, expectedRevision: started.task.revision, assignmentId: claim.assignment.id,
        summary: 'done', evidenceMessageIds: [evidence.id], commitSha: 'abcdef0123' };
      const done = send(as(b), command, `submit-${created.id}`);
      assert.equal(done.task.status, 'completed');
      assert.equal(send(as(b), command, `submit-${created.id}`).eventId, done.eventId, 'a retried submit replays its result');
      return done;
    };
    const quietRecord = (eventId: number, body: RegExp) => {
      const records = systems().filter((message) => message.collabEventId === eventId);
      assert.equal(records.length, 1, 'exactly one record');
      assert.match(records[0].body, body);
      assert.deepEqual(records[0].mentions, [], 'nobody’s unread');
      assert.deepEqual(deliveriesOf(records[0].id), [], 'nobody is woken');
      return records[0];
    };
    const done = finish({});
    const record = quietRecord(done.eventId, /^B 提交了任务 #1【self】的结果并完成自查，任务已完成，事件 \d+。$/);
    assert.deepEqual((app.store.pluginFields(record.id) as any).taskIds, [done.task.id], 'linked to its task');
    assert.equal(notice(done.eventId)!.collabEventId, done.eventId);
    const shipped = send({ kind: 'system' }, { action: 'task.shipped', taskId: done.task.id, expectedRevision: done.task.revision,
      submissionId: done.task.approvedSubmissionId, commitSha: 'abcdef4567', reason: 'ship' });
    quietRecord(shipped.eventId, /^任务 #1【self】已合并（提交 abcdef4），事件 \d+。$/);
    // Created by its own executor: still one record, and the unread of both members is untouched.
    const unread = [a, b].map((member) => app.store.countUnread(member.id, cluster.id));
    quietRecord(finish({ mergeRequired: false }).eventId, /任务 #2【self】的结果并完成自查/);
    assert.deepEqual([a, b].map((member) => app.store.countUnread(member.id, cluster.id)), unread);
    // Other tiers keep their notices: a member reviewer is still woken by the submission, once.
    const reviewed = send(user, { action: 'task.create', title: 'member', scope: 's', acceptance: 'a', reviewer: as(a) }).task;
    const claim = send(as(b), { action: 'task.claim', taskId: reviewed.id, expectedRevision: reviewed.revision });
    const started = send(as(b), { action: 'task.start', taskId: reviewed.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
    const submitted = send(as(b), { action: 'task.submit', taskId: reviewed.id, expectedRevision: started.task.revision, assignmentId: claim.assignment.id,
      summary: 'done', evidenceMessageIds: [evidence.id], commitSha: 'abcdef0123' });
    const submitNotices = systems().filter((message) => message.collabEventId === submitted.eventId);
    assert.equal(submitNotices.length, 1);
    assert.deepEqual(deliveriesOf(submitNotices[0].id).map((delivery) => delivery.memberId), [a.id]);
  } finally { await app.close(); }
});

test('at the hop limit a kept record is still written (naming and waking nobody, hop not lowered); a real wake-up is still stopped', async () => {
  const { app, cluster, a, b, c, user, as, systems, deliveriesOf } = await fixture('hop-edge');
  try {
    let serial = 0;
    const send = (actor: unknown, command: Record<string, unknown>) =>
      app.hub.collaboration.command(actor as never, cluster.id, { operationId: `edge-${++serial}`, ...command } as never) as any;
    const guards = () => app.store.listEvents(0, undefined, ['guard']).map((event) => event.payload as any).filter((p) => p.reason === 'max_hops');
    // B has just been handed a hop-6 message (the default limit is 6): whatever B's actions notify is hop 7.
    const chainId = 'edge-chain';
    app.store.insertMessage({ id: chainId, clusterId: cluster.id, from: a.id, mentions: [b.id], body: '@B hop six', replyTo: null,
      chainId, hop: 6, createdAt: new Date().toISOString() }, [b.id]);
    app.store.db.prepare("UPDATE deliveries SET state = 'done', attempts = 1 WHERE message_id = ?").run(chainId);
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    const startAs = (title: string, extra: Record<string, unknown>) => {
      const created = send(user, { action: 'task.create', title, scope: 's', acceptance: 'a', ...extra }).task;
      const claim = send(as(b), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
      const started = send(as(b), { action: 'task.start', taskId: created.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
      return (summary: string) => send(as(b), { action: 'task.submit', taskId: created.id, expectedRevision: started.task.revision,
        assignmentId: claim.assignment.id, summary, evidenceMessageIds: [evidence.id], commitSha: 'abcdef0123' });
    };
    const submitSelf = startAs('self at the edge', { reviewer: { kind: 'self' }, mergeRequired: false });
    const before = guards().length;
    const done = submitSelf('done');
    assert.equal(done.task.status, 'completed');
    const records = systems().filter((m) => m.collabEventId === done.eventId);
    assert.equal(records.length, 1, 'the completion is kept in the chat record');
    assert.deepEqual([records[0].mentions, deliveriesOf(records[0].id)], [[], []], 'naming and waking nobody');
    assert.deepEqual([records[0].chainId, records[0].hop], [chainId, 7], 'it keeps the chain and its hop: nothing after it starts lower');
    assert.equal(guards().length, before, 'nothing was stopped, so no guard');
    // A real wake-up at the same edge is still stopped, with the guard, and writes nothing.
    const submitReviewed = startAs('reviewed at the edge', { reviewer: as(c) });
    const beforeWake = guards().length;
    const submitted = submitReviewed('done');
    assert.equal(guards().length, beforeWake + 1);
    assert.equal(systems().filter((m) => m.collabEventId === submitted.eventId).length, 0, 'no message for a blocked wake-up');
    assert.deepEqual(guards().at(-1), { reason: 'max_hops', chainId, hop: 7, maxHops: 6, sourceEventId: submitted.eventId });
    // A notice with recipients that must also be kept: the record stays, without mentions or deliveries, and the guard is recorded.
    const source = app.store.getEvent(submitted.eventId)!;
    const publish = (app.hub as any).collaborationNotification(as(b), cluster.id, source,
      { body: 'mixed', systemKind: 'task', recipients: [c.id, a.id], wake: [c.id], retain: true });
    publish?.();
    const mixed = systems().find((m) => m.body === 'mixed')!;
    assert.deepEqual([mixed.mentions, deliveriesOf(mixed.id), mixed.hop], [[], [], 7]);
    assert.equal(guards().length, beforeWake + 2, 'the stopped wake-up is in the guard record');
  } finally { await app.close(); }
});

test('a coordinator can cancel or hand off a started task; the old assignment dies and its executor is told to stop', async () => {
  const { app, cluster, a, b, c, send: rawSend, user, as, notice, storeEvent, deliveriesOf } = await fixture('coordinator-stop');
  const send = rawSend as (actor: any, command: Record<string, unknown>) => any;
  try {
    const coordinator = (mode: string, on: boolean) =>
      send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode, permissions: { cancelReopen: on, recovery: on } }).coordinator;
    const started = (title: string) => {
      const created = send(user, { action: 'task.create', title, scope: 's', acceptance: 'done' }).task;
      const claim = send(as(b), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
      const task = send(as(b), { action: 'task.start', taskId: created.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id }).task;
      return { taskId: task.id, expectedRevision: task.revision, assignmentId: claim.assignment.id };
    };
    const statusOf = (taskId: string) => (app.hub.collaboration.query(user as never, cluster.id, { kind: 'task', taskId }) as any).task.status;
    let policy = coordinator('execute', true);

    const job = started('job');
    const cancel = { action: 'task.cancel', ...job, reason: '重复了' };
    assert.throws(() => send(as(a), { ...cancel, generation: policy.generation, reason: '' }), /reason/);
    assert.throws(() => send(as(a), { ...cancel, generation: policy.generation - 1 }), /policy changed/);
    assert.throws(() => send(as(c), cancel), /not permitted/, 'an ordinary member cannot take it');
    assert.throws(() => send(as(c), { action: 'task.release', ...job, reason: 'x', confirmStopped: true }), /only the assignee or user can release/);
    const off = coordinator('execute', false);
    assert.throws(() => send(as(a), { ...cancel, generation: off.generation }), /permission is disabled/);
    assert.throws(() => send(as(a), { action: 'task.handoff', ...job, memberId: c.id, reason: 'x', generation: off.generation }), /permission is disabled/);
    const suggesting = coordinator('suggest', true);
    const suggestion = send(as(a), { ...cancel, generation: suggesting.generation });
    assert.ok(suggestion.suggestion);
    assert.equal(statusOf(job.taskId), 'working', 'suggest mode changes nothing');
    assert.equal((storeEvent(suggestion.eventId).payload as any).coordinatorConfirmedStop, undefined);
    assert.equal(notice(suggestion.eventId), undefined);

    policy = coordinator('execute', true);
    const cancelled = send(as(a), { ...cancel, generation: policy.generation });
    assert.equal(cancelled.task.status, 'cancelled');
    assert.equal((storeEvent(cancelled.eventId).payload as any).coordinatorConfirmedStop, b.id, 'the event records the stand-in confirmation');
    assert.match(notice(cancelled.eventId)!.body, /已取消（原因：重复了），事件 \d+。协调员已代确认这次停止，B 请立即停手/);
    assert.ok(deliveriesOf(notice(cancelled.eventId)!.id).some((delivery) => delivery.memberId === b.id), 'the old executor is woken');
    const stale = { taskId: job.taskId, expectedRevision: cancelled.task.revision, assignmentId: job.assignmentId };
    assert.throws(() => send(as(b), { action: 'task.start', ...stale }), /not assigned to you/);
    assert.throws(() => send(as(b), { action: 'task.submit', ...stale, summary: 'late', evidenceMessageIds: [app.hub.sendFromUser(cluster.id, 'proof').id] }), /no longer active/);

    const moved = started('moved');
    const handed = send(as(a), { action: 'task.handoff', ...moved, memberId: c.id, reason: '换人', generation: policy.generation });
    assert.equal(handed.task.status, 'pending');
    assert.equal(handed.task.assignedMemberId, c.id);
    assert.match(notice(handed.eventId)!.body, /已转交给 C（原因：换人），事件 \d+。协调员已代确认这次停止，B 请立即停手/);
    assert.deepEqual(new Set(deliveriesOf(notice(handed.eventId)!.id).map((delivery) => delivery.memberId)), new Set([b.id, c.id]));
    assert.throws(() => send(as(b), { action: 'task.submit', taskId: moved.taskId, expectedRevision: handed.task.revision, assignmentId: moved.assignmentId,
      summary: 'late', evidenceMessageIds: [app.hub.sendFromUser(cluster.id, 'proof').id] }), /no longer active/);

    // An executor already removed from the cluster: the action still works and nobody tries to reach them.
    const orphaned = started('orphaned');
    const orphanedAgain = started('orphaned again');
    await app.hub.removeMember(cluster.id, b.id);
    const closed = send(as(a), { action: 'task.cancel', ...orphaned, reason: '成员已移除', generation: policy.generation });
    assert.equal(closed.task.status, 'cancelled');
    assert.equal((storeEvent(closed.eventId).payload as any).coordinatorConfirmedStop, b.id);
    assert.equal(notice(closed.eventId), undefined, 'no recipient is left, so there is no notice');
    const reassigned = send(as(a), { action: 'task.handoff', ...orphanedAgain, memberId: c.id, reason: '成员已移除', generation: policy.generation });
    assert.doesNotMatch(notice(reassigned.eventId)!.body, /停手/);
    assert.deepEqual(deliveriesOf(notice(reassigned.eventId)!.id).map((delivery) => delivery.memberId), [c.id]);
  } finally { await app.close(); }
});

test('edit notifications reach the nominee, assignee and member reviewer but never the coordinator or the actor', async () => {
  const { app, cluster, a, b, c, send, user, as, notice } = await fixture('edit-recipients');
  try {
    const setup = send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    let task = send(user, { action: 'task.create', title: 'edit me', scope: 's', acceptance: 'done', reviewer: as(c) }).task!;
    const nominated = send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: b.id });
    task = nominated.task!;
    const edited = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, title: 'edited' });
    const message = notice(edited.eventId)!;
    assert.deepEqual(message.mentions, [b.id, c.id], 'nominee and reviewer hear about the edit');
    assert.ok(!message.mentions.includes(a.id), 'the coordinator is not woken by a normal edit');
    // The coordinator's own edit still notifies the affected members, not the coordinator itself.
    const coordinatorEdit = send(as(a), { action: 'task.edit', taskId: edited.task!.id, expectedRevision: edited.task!.revision,
      title: 'edited again', generation: setup.coordinator!.generation });
    const coordinatorMessage = notice(coordinatorEdit.eventId)!;
    assert.deepEqual(coordinatorMessage.mentions, [b.id, c.id]);
    assert.ok(!coordinatorMessage.mentions.includes(a.id), 'the actor is excluded');
  } finally { await app.close(); }
});

test('system messages link their event, expose the payload over HTTP and add one line to the envelope', async () => {
  const { app, native, cluster, b, send, user, notice } = await fixture('event-api');
  try {
    const created = send(user, { action: 'task.create', title: 'api', scope: 'old', acceptance: 'done' }).task!;
    const edited = send(user, { action: 'task.edit', taskId: created.id, expectedRevision: created.revision, scope: 'new' });
    const message = notice(edited.eventId)!;
    assert.equal(message.collabEventId, edited.eventId);
    const payload = await app.api('GET', `/api/clusters/${cluster.id}/tasks/${created.id}/events/${edited.eventId}`);
    assert.equal(payload.action, 'task.edit');
    assert.equal(payload.eventId, edited.eventId);
    assert.deepEqual(payload.changes, [{ field: 'scope', before: 'old', after: 'new' }]);
    const unauthenticated = await rawFetch(`${app.url}/api/clusters/${cluster.id}/tasks/${created.id}/events/${edited.eventId}`);
    assert.equal(unauthenticated.status, 401);
    await assert.rejects(app.api('GET', `/api/clusters/${cluster.id}/tasks/${created.id}/events/${edited.eventId + 999}`), /unknown collaboration event/);
    const other = send(user, { action: 'task.create', title: 'other', scope: 's', acceptance: 'done' }).task!;
    await assert.rejects(app.api('GET', `/api/clusters/${cluster.id}/tasks/${other.id}/events/${edited.eventId}`), /does not belong/);
    const messages = await app.api('GET', `/api/clusters/${cluster.id}/messages`);
    assert.equal(messages.find((item: any) => item.id === message.id).collabEventId, edited.eventId);
    assert.ok(messages.filter((item: any) => item.from === 'user').every((item: any) => item.collabEventId === undefined),
      'messages without a collaboration event carry no link');
    const detail = await app.api('GET', `/api/clusters/${cluster.id}/tasks/${created.id}`);
    const editEvent = detail.events.find((item: any) => item.seq === edited.eventId);
    assert.deepEqual(editEvent.payload.changes, [{ field: 'scope', before: 'old', after: 'new' }]);
    const nominated = send(user, { action: 'task.nominate', taskId: detail.task.id, expectedRevision: detail.task.revision, memberId: b.id });
    const envelope = await waitFor(() => native.delivered.find((item) => item.text.includes('已分配给')), 'nomination envelope');
    assert.ok(envelope.text.includes(`事件：task.nominate #${nominated.eventId}；完整改动见 get_task 的 events`));
  } finally { await app.close(); }
});

test('a failed or offline delivery produces a Chinese notice that names the original message', async () => {
  const { app, native, cluster, a, c, send, user } = await fixture('delivery-notice');
  try {
    native.isOnline = (sessionId) => sessionId !== 's1';
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const task = send(user, { action: 'task.create', title: 'offline work', scope: 's', acceptance: 'done' }).task!;
    const original = app.hub.sendFromUser(cluster.id, '@A please read', undefined, undefined, [task.id]);
    const notice = app.hub.listMessages(cluster.id, 100).find((message) => message.kind === 'system' && message.body.includes('投递失败或离线'))!;
    assert.ok(notice);
    assert.match(notice.body, /投递失败或离线：消息「@A please read」/);
    assert.ok(notice.body.includes(original.id), 'the notice names the source message');
    assert.ok(notice.body.includes('任务 #1【offline work】'));
    assert.ok(notice.body.includes('该成员当前离线'));
    assert.equal(notice.systemKind, 'delivery_failed');
    assert.equal(notice.collabEventId, undefined, 'a delivery notice points at a message event, not a task event');
    assert.deepEqual(notice.mentions, [c.id]);
    assert.ok(a.id !== c.id);
  } finally { await app.close(); }
});

test('dependency-ready notices carry no task event link and oversized Chinese text is cut on a byte boundary', async () => {
  const { app, cluster, a, b, c, send, user, as, systems, notice, storeEvent } = await fixture('edges');
  try {
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    let parent = send(user, { action: 'task.create', title: 'parent', scope: 's', acceptance: 'done', mergeRequired: false, reviewer: as(c) }).task!;
    parent = send(user, { action: 'task.nominate', taskId: parent.id, expectedRevision: parent.revision, memberId: b.id }).task!;
    const parentClaim = send(as(b), { action: 'task.claim', taskId: parent.id, expectedRevision: parent.revision });
    const parentStarted = send(as(b), { action: 'task.start', taskId: parentClaim.task!.id,
      expectedRevision: parentClaim.task!.revision, assignmentId: parentClaim.assignment!.id }).task!;
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    const parentSubmitted = send(as(b), { action: 'task.submit', commitSha: 'abcdef0', taskId: parentStarted.id, expectedRevision: parentStarted.revision,
      assignmentId: parentClaim.assignment!.id, summary: 'ok', evidenceMessageIds: [evidence.id] });
    let child = send(user, { action: 'task.create', title: 'child', scope: 's', acceptance: 'done',
      reviewer: as(c), dependencyIds: [parent.id] }).task!;
    child = send(user, { action: 'task.nominate', taskId: child.id, expectedRevision: child.revision, memberId: b.id }).task!;
    const approved = send(as(c), { action: 'task.review', taskId: parentSubmitted.task!.id,
      expectedRevision: parentSubmitted.task!.revision, submissionId: parentSubmitted.submission!.id, verdict: 'approve', reason: 'Independent review passed' });
    const readyNotice = systems().find((message) => message.body.includes('前置依赖已就绪') && message.body.includes(child.id))!;
    assert.ok(readyNotice, 'the downstream nominee gets the readiness notice');
    assert.equal(readyNotice.collabEventId, undefined,
      'the readiness notice is linked to the downstream task but names the upstream event, so it carries no link');
    assert.equal(notice(approved.eventId)?.collabEventId, approved.eventId, 'the approval notice itself stays linked');
    // The 20 KB limit counts UTF-8 bytes: 10 000 Chinese characters are 30 KB and must be cut on a character boundary.
    const longCreate = send(user, { action: 'task.create', title: 'bytes', scope: '中'.repeat(10_000), acceptance: 'done' });
    const scopeChange = ((storeEvent(longCreate.eventId).payload as any).changes as any[]).find((change) => change.field === 'scope')!;
    assert.equal(scopeChange.truncated, true);
    assert.ok(Buffer.byteLength(scopeChange.after, 'utf8') <= 20_000, 'the recorded value fits the byte limit');
    assert.ok(scopeChange.after.endsWith('中'), 'cut on a character boundary, never inside a character');
    assert.ok(!scopeChange.after.includes('\uFFFD'), 'no replacement characters');
    const shortCreate = send(user, { action: 'task.create', title: 'short', scope: '中文', acceptance: 'done' });
    const shortChange = ((storeEvent(shortCreate.eventId).payload as any).changes as any[]).find((change) => change.field === 'scope')!;
    assert.equal(shortChange.truncated, undefined, 'short text is untouched');
    assert.equal(shortChange.after, '中文');
  } finally { await app.close(); }
});


test('a member’s @all broadcast counts unread but wakes nobody; a specific @name wakes that member', async () => {
  const { app, cluster, a, b, c } = await fixture('broadcast-tiers');
  try {
    const all = app.hub.sendFromMember(a.id, '@all standup in five minutes');
    assert.deepEqual(all.deliveredTo, [], 'a broadcast is queued for nobody');
    assert.equal(all.warning, undefined, 'a broadcast reaches everyone as unread: no "only in the chat record" warning');
    assert.deepEqual(app.store.withDeliveries([all.message])[0].deliveries, [], 'no delivery: nobody is woken');
    for (const member of [b, c]) {
      assert.ok(app.store.countUnread(member.id, cluster.id) >= 1, 'the broadcast is unread');
      assert.ok(app.hub.readMessages(member.id).some((message) => message.id === all.message.id), 'and can be read');
    }
    const direct = app.hub.sendFromMember(a.id, '@B can you look at this?');
    assert.deepEqual(direct.deliveredTo, ['B']);
    assert.deepEqual(app.store.withDeliveries([direct.message])[0].deliveries.map((delivery) => delivery.memberId), [b.id],
      'a specific @name still wakes that member');
    // A broadcast with an explicit name in it: everyone keeps it unread, the named member is woken.
    const mixed = app.hub.sendFromMember(a.id, '@all FYI, @C please handle this');
    assert.deepEqual(mixed.deliveredTo, ['C']);
    assert.deepEqual(app.store.withDeliveries([mixed.message])[0].deliveries.map((delivery) => delivery.memberId), [c.id],
      'the explicit @name is not swallowed by the broadcast');
    assert.ok(app.store.countUnread(b.id, cluster.id) >= 1, 'the other member still only keeps it unread');
  } finally { await app.close(); }
});

test('send_message fyi: the named members keep it unread and nobody is woken; without it nothing changes', async () => {
  const { app, cluster, a, b, c, send, user, deliveriesOf } = await fixture('fyi');
  try {
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const say = (body: string, fyi?: unknown, to?: string[]) => app.hub.sendFromMember(a.id, body, undefined, [], undefined, to, undefined, fyi);
    const woken = (sent: { message: { id: string } }) => deliveriesOf(sent.message.id).map((delivery) => delivery.memberId);
    const note = say('@B the build is green again', true);
    assert.deepEqual(note.message.mentions, [b.id], 'the named member keeps it as unread');
    assert.deepEqual([note.deliveredTo, woken(note), note.warning], [[], [], undefined], 'no delivery and no "no recipient" warning');
    assert.ok(app.hub.readMessages(b.id).some((message) => message.id === note.message.id), 'and reads it later');
    const named = say('thanks, that settles it', true, ['B']);
    assert.deepEqual([named.message.mentions, named.deliveredTo, woken(named), named.warning], [[b.id], [], [], undefined], 'the same with `to`');
    const nobody = say('progress: half of the files are done', true);
    assert.deepEqual([nobody.message.mentions, nobody.deliveredTo, woken(nobody), nobody.warning], [[], [], [], undefined],
      'naming nobody reaches nobody, not even the enabled coordinator');
    assert.equal(say('@claude typo', true).unresolvedMentions?.[0], 'claude', 'a misspelt name is still reported');
    // Absent or false: an @ wakes as before, and a message for nobody is warned about.
    for (const sent of [say('@B please look at this'), say('@B and this', false)]) {
      assert.deepEqual([sent.deliveredTo, woken(sent)], [['B'], [b.id]]);
    }
    assert.match(say('nobody named').warning!, /only stays in the chat record/);
    assert.throws(() => say('@B hi', 'true'), /fyi must be a boolean/);
    assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE body = ?').get('@B hi') as any).n, 0, 'a refused send writes nothing');
  } finally { await app.close(); }
});

test('a failed delivery that affects no task only joins the coordinator’s unread; one on a task wakes it', async () => {
  const dir = tempDir();
  const sessions = ['off', 'coord'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  // A bridge-kind member is offline while no bridge is connected, so the delivery is offline from the start.
  const native = createMockNativeAdapter({ kind: 'bridge', harness: 'claude', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  try {
    const { cluster, members: [off, coord] } = await app.hub.createCluster('delivery-tiers', [
      { harness: 'claude', mode: 'native', sessionId: 'off', name: 'Off' },
      { harness: 'claude', mode: 'native', sessionId: 'coord', name: 'Coord' },
    ]);
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'coordinator.set', operationId: 'set', memberId: coord.id, enabled: true, mode: 'execute' });
    const notices = () => app.store.listMessages(cluster.id, 200).filter((message) => message.kind === 'system' && message.body.includes('投递失败或离线'));
    app.hub.sendFromUser(cluster.id, 'a plain message', [off.id]);
    await waitFor(() => notices().length === 1, 'the offline notice');
    const plain = notices()[0];
    assert.deepEqual(app.store.withDeliveries([plain])[0].deliveries, [], 'no task: the coordinator is not woken');
    assert.ok(app.store.countUnread(coord.id, cluster.id) >= 1, 'but it joins the unread');
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id,
      { action: 'task.create', operationId: 'task', title: 'affected', scope: 's', acceptance: 'a' }).task!;
    app.hub.sendFromUser(cluster.id, 'a message for a task', [off.id], undefined, [task.id]);
    await waitFor(() => notices().length === 2, 'the task notice');
    const affected = notices()[1];
    assert.ok(app.store.withDeliveries([affected])[0].deliveries.some((delivery) => delivery.memberId === coord.id),
      'a failure on a task wakes the coordinator');
    // A historical link to a closed task is not work affected by the failure: unread only.
    const closed = app.hub.collaboration.command({ kind: 'user' }, cluster.id,
      { action: 'task.cancel', operationId: 'cancel', taskId: task.id, expectedRevision: task.revision, reason: 'dropped' }).task!;
    app.hub.sendFromUser(cluster.id, 'a message linked to a closed task', [off.id], undefined, [closed.id]);
    await waitFor(() => notices().length === 3, 'the closed-task notice');
    assert.deepEqual(app.store.withDeliveries([notices()[2]])[0].deliveries, [], 'a closed task does not wake the coordinator');
    // With several links, any still-open task counts, whatever order the links are in.
    const open = app.hub.collaboration.command({ kind: 'user' }, cluster.id,
      { action: 'task.create', operationId: 'open', title: 'open', scope: 's', acceptance: 'a' }).task!;
    for (const [index, order] of [[closed.id, open.id], [open.id, closed.id]].entries()) {
      app.hub.sendFromUser(cluster.id, 'a message with mixed links', [off.id], undefined, order);
      await waitFor(() => notices().length === 4 + index, 'the mixed-link notice');
    }
    const mixed = notices().slice(3);
    assert.equal(mixed.length, 2);
    for (const message of mixed) {
      assert.ok(app.store.withDeliveries([message])[0].deliveries.some((delivery) => delivery.memberId === coord.id),
        'an open linked task wakes the coordinator in either order');
    }
  } finally { await app.close(); }
});

test('a rejected review and a failed ship wake the executor', async () => {
  const { app, cluster, a, b, send, user, as, notice, deliveriesOf } = await fixture('reject-ship-tiers');
  try {
    const created = send(user, { action: 'task.create', title: 'reject me', scope: 's', acceptance: 'a', reviewer: as(b) }).task!;
    let current = send(as(a), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
    const assignmentId = current.assignment!.id;
    current = send(as(a), { action: 'task.start', taskId: created.id, expectedRevision: current.task!.revision, assignmentId });
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    current = send(as(a), { action: 'task.submit', taskId: created.id, expectedRevision: current.task!.revision, assignmentId,
      summary: 'done', commitSha: 'abcdef0123', evidenceMessageIds: [evidence.id] });
    const rejected = send(as(b), { action: 'task.review', taskId: created.id, expectedRevision: current.task!.revision,
      submissionId: current.submission!.id, verdict: 'reject', reason: 'fix the check' });
    assert.ok(deliveriesOf(notice(rejected.eventId)!.id).some((delivery) => delivery.memberId === a.id),
      'a rejected review wakes the executor');
    current = send(as(a), { action: 'task.submit', taskId: created.id, expectedRevision: rejected.task!.revision, assignmentId,
      summary: 'fixed', commitSha: 'abcdef0123', evidenceMessageIds: [evidence.id] });
    const approved = send(as(b), { action: 'task.review', taskId: created.id, expectedRevision: current.task!.revision,
      submissionId: current.submission!.id, verdict: 'approve', reason: 'ok' });
    const failed = send({ kind: 'system' }, { action: 'task.ship_failed', taskId: created.id, expectedRevision: approved.task!.revision,
      submissionId: approved.task!.approvedSubmissionId, reason: 'checks: npm test failed twice:\nfinal assertion failed' });
    const failure = notice(failed.eventId)!;
    assert.equal(failure.body, `任务 #1【reject me】合并失败：合并前检查未通过，保留已通过状态（可原样重跑、ship_fix 或 reopen），事件 ${failed.eventId}。`);
    assert.equal(failure.collabEventId, failed.eventId);
    assert.equal(failure.systemKind, 'ship_failed', 'a problem-level warning');
    assert.deepEqual([...failure.mentions].sort(), [a.id, b.id].sort(), 'both executor and reviewer keep it as infoOnly unread');
    assert.deepEqual(deliveriesOf(failure.id), [], 'ship_failed sends infoOnly without automatic wake');
    const eventPath = `/api/clusters/${cluster.id}/tasks/${created.id}/events/${failed.eventId}`;
    assert.equal((await rawFetch(app.url + eventPath)).status, 401);
    const payload = await app.api('GET', eventPath);
    assert.equal(payload.reason, 'checks: npm test failed twice:\nfinal assertion failed');
    const other = send(user, { action: 'task.create', title: 'other', scope: 's', acceptance: 'done' }).task!;
    await assert.rejects(app.api('GET', `/api/clusters/${cluster.id}/tasks/${other.id}/events/${failed.eventId}`), /does not belong/);
  } finally { await app.close(); }
});

test('another member’s claim, start and submit wake nobody but the reviewer', async () => {
  const { app, cluster, a, b, c, send, user, as, notice, deliveriesOf } = await fixture('others-tiers');
  try {
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const created = send(user, { action: 'task.create', title: 'other work', scope: 's', acceptance: 'a', reviewer: as(b) }).task!;
    const claimed = send(as(a), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
    const claimNotice = notice(claimed.eventId);
    assert.deepEqual(claimNotice ? deliveriesOf(claimNotice.id) : [], [], 'the actor is not woken for its own claim');
    const beforeStart = app.store.countUnread(c.id, cluster.id);
    const started = send(as(a), { action: 'task.start', taskId: created.id, expectedRevision: claimed.task!.revision, assignmentId: claimed.assignment!.id });
    const startNotice = notice(started.eventId)!;
    assert.deepEqual(deliveriesOf(startNotice.id), [], 'a start wakes nobody');
    assert.ok(startNotice.mentions.includes(c.id) && startNotice.mentions.includes(b.id),
      'the coordinator and the reviewer keep the start as unread');
    assert.equal(app.store.countUnread(c.id, cluster.id), beforeStart + 1, 'the coordinator\'s unread count grew');
    assert.ok(app.hub.readMessages(c.id).some((message) => message.id === startNotice.id), 'and the default read returns it');
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    const beforeSubmit = app.store.countUnread(c.id, cluster.id);
    const submitted = send(as(a), { action: 'task.submit', taskId: created.id, expectedRevision: started.task!.revision,
      assignmentId: claimed.assignment!.id, summary: 'done', commitSha: 'abcdef0123', evidenceMessageIds: [evidence.id] });
    const submitNotice = notice(submitted.eventId)!;
    assert.deepEqual(deliveriesOf(submitNotice.id).map((delivery) => delivery.memberId), [b.id],
      'only the reviewer is woken');
    assert.ok(submitNotice.mentions.includes(c.id), 'the coordinator keeps the submission as unread');
    assert.equal(app.store.countUnread(c.id, cluster.id), beforeSubmit + 1, 'the coordinator\'s unread count grew');
    assert.ok(app.hub.readMessages(c.id).some((message) => message.id === submitNotice.id), 'and the default read returns it');
  } finally { await app.close(); }
});

test('an acknowledgement writes no message: it is on the acknowledged message, in read_messages and in its event', async () => {
  const { app, cluster, a, b } = await fixture('ack-tiers');
  try {
    const count = () => app.store.listMessages(cluster.id, 500).length;
    const fromUser = app.hub.sendFromUser(cluster.id, 'please acknowledge this', [a.id]);
    await waitFor(() => app.store.withDeliveries([fromUser])[0].deliveries.some((delivery) => delivery.state === 'done'), 'A gets it');
    const before = count();
    app.hub.ackMessages(a.id, [fromUser.id]);
    assert.equal(count(), before, 'acknowledging a user message writes nothing');
    assert.deepEqual(app.store.withDeliveries([app.store.getMessage(fromUser.id)!])[0].deliveries.map((delivery) => delivery.memberId), [a.id],
      'and the acknowledgement changes no delivery');
    const fromB = app.hub.sendFromMember(b.id, '@A please acknowledge this');
    await waitFor(() => app.store.withDeliveries([fromB.message])[0].deliveries.some((delivery) => delivery.state === 'done'), 'A gets B\'s message');
    const unreadBefore = app.store.countUnread(b.id, cluster.id);
    const afterB = count();
    assert.deepEqual(app.hub.ackMessages(a.id, [fromB.message.id]), [fromB.message.id]);
    assert.equal(count(), afterB, 'acknowledging a member message writes no receipt message either');
    assert.equal(app.store.countUnread(b.id, cluster.id), unreadBefore);
    // read_messages (src/mcp/server.ts) reports the history this way; the dsh test checks the tool output itself.
    const own = app.store.withDeliveries(app.hub.readMessages(b.id, { history: true })).find((message) => message.id === fromB.message.id)!;
    assert.deepEqual(own.acknowledgements.map((ack) => ack.memberId), [a.id], 'the sender finds the acknowledgement on its message');
    const events = app.store.listEvents(0, undefined, ['acknowledgement']);
    assert.ok(events.some((event) => (event.payload as any).acknowledgements.some((ack: any) => ack.messageId === fromB.message.id && ack.memberId === a.id)),
      'the acknowledgement event is still recorded');
    // A retry is safe and still writes nothing.
    app.hub.ackMessages(a.id, [fromB.message.id]);
    assert.equal(count(), afterB);
  } finally { await app.close(); }
});


test('a submission for the user to accept also joins the attached members unread', async () => {
  const { app, cluster, a, b, c, send, user, as, notice, deliveriesOf } = await fixture('user-review-tiers');
  try {
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    // The reviewer defaults to the user: no member is woken, but the attached members still keep it unread.
    const created = send(user, { action: 'task.create', title: 'user accepts', scope: 's', acceptance: 'a' }).task!;
    const claimed = send(as(a), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
    const started = send(as(a), { action: 'task.start', taskId: created.id, expectedRevision: claimed.task!.revision, assignmentId: claimed.assignment!.id });
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    const unreadBefore = app.store.countUnread(c.id, cluster.id);
    const submitted = send(as(a), { action: 'task.submit', taskId: created.id, expectedRevision: started.task!.revision,
      assignmentId: claimed.assignment!.id, summary: 'done', commitSha: 'abcdef0123', evidenceMessageIds: [evidence.id] });
    const submitNotice = notice(submitted.eventId)!;
    assert.deepEqual(submitNotice.mentions, [c.id], 'the coordinator keeps the submission as unread');
    assert.deepEqual(deliveriesOf(submitNotice.id), [], 'and nobody is woken: no member reviews this one');
    assert.equal(app.store.countUnread(c.id, cluster.id), unreadBefore + 1, 'the unread count grew');
    assert.ok(app.hub.readMessages(c.id).some((message) => message.id === submitNotice.id), 'the default read returns it');
    assert.equal(submitted.task!.status, 'review');
    assert.deepEqual(submitted.task!.reviewer, { kind: 'user' });
  } finally { await app.close(); }
});

const SHIP_LINE = '执行者请用 get_task 取 ship 命令并运行。';

/** A claims, starts and submits a task (the reviewer defaults to the user, and merging is required by default). */
async function shipFixture(name: string) {
  const f = await fixture(name);
  const send = f.send as (actor: any, command: Record<string, unknown>) => any;
  const evidence = f.app.hub.sendFromUser(f.cluster.id, 'evidence');
  const submit = (title: string, extra: Record<string, unknown> = {}) => {
    const created = send(f.user, { action: 'task.create', title, scope: 's', acceptance: 'a', ...extra }).task;
    const claim = send(f.as(f.a), { action: 'task.claim', taskId: created.id, expectedRevision: created.revision });
    const started = send(f.as(f.a), { action: 'task.start', taskId: created.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
    return send(f.as(f.a), { action: 'task.submit', taskId: created.id, expectedRevision: started.task.revision, assignmentId: claim.assignment.id,
      summary: 'done', commitSha: 'abcdef0123', evidenceMessageIds: [evidence.id] });
  };
  const review = (actor: unknown, submitted: any, verdict: string, reason?: string) => send(actor, { action: 'task.review', taskId: submitted.task.id,
    expectedRevision: submitted.task.revision, submissionId: submitted.submission.id, verdict, ...(reason ? { reason } : {}) });
  const woken = (message: { id: string }) => f.deliveriesOf(message.id).map((delivery) => delivery.memberId);
  return { ...f, send, submit, review, woken };
}

test('ship wake: the user approving a task to merge wakes its executor and says to run ship', async () => {
  const { app, native, a, user, notice, submit, review, woken } = await shipFixture('ship-wake');
  try {
    const approved = review(user, submit('ship me'), 'approve');
    assert.equal(approved.task.status, 'completed');
    assert.equal(approved.task.currentAssignmentId, null, 'the executor comes from the submission, not the cleared assignment');
    const message = notice(approved.eventId)!;
    assert.equal(message.body, `用户 验收通过了任务 #1【ship me】，任务已完成，事件 ${approved.eventId}。${SHIP_LINE}`);
    assert.deepEqual(message.mentions, [a.id]);
    assert.deepEqual(woken(message), [a.id], 'the executor gets a delivery, not just an unread');
    await waitFor(() => native.delivered.some((sent) => sent.sessionId === 's1' && sent.text.includes(SHIP_LINE)), 'the executor is woken');
  } finally { await app.close(); }
});

test('ship wake: a member reviewer approving leaves ship to the reviewer and does not wake the executor', async () => {
  const { app, a, b, as, notice, submit, review, woken } = await shipFixture('ship-member');
  try {
    const approved = review(as(b), submit('member reviewed', { reviewer: as(b) }), 'approve', 'ok');
    const message = notice(approved.eventId)!;
    assert.equal(message.body, `B 验收通过了任务 #1【member reviewed】，任务已完成，事件 ${approved.eventId}。`);
    assert.deepEqual(message.mentions, [a.id], 'the executor keeps it as unread');
    assert.deepEqual(woken(message), []);
  } finally { await app.close(); }
});

test('ship wake: a user approving a member-reviewed task to merge wakes the executor and says to run ship', async () => {
  const { app, a, b, user, as, notice, submit, review, woken } = await shipFixture('ship-user-for-member');
  try {
    const approved = review(user, submit('user for member', { reviewer: as(b) }), 'approve');
    const message = notice(approved.eventId)!;
    assert.equal(message.body, `用户 验收通过了任务 #1【user for member】，任务已完成，事件 ${approved.eventId}。${SHIP_LINE}`);
    assert.deepEqual(message.mentions, [a.id]);
    assert.deepEqual(woken(message), [a.id], 'the executor runs ship, not the member reviewer');
  } finally { await app.close(); }
});

test('ship wake: the user rejecting wakes the executor with no ship instruction', async () => {
  const { app, a, user, notice, submit, review, woken } = await shipFixture('ship-reject');
  try {
    const rejected = review(user, submit('rejected'), 'reject', 'fix it');
    const message = notice(rejected.eventId)!;
    assert.equal(message.body, `用户 退回了任务 #1【rejected】的结果（原因：fix it），事件 ${rejected.eventId}。`);
    assert.deepEqual(woken(message), [a.id]);
  } finally { await app.close(); }
});

test('ship wake: the user approving a task with nothing to merge does not wake the executor', async () => {
  const { app, a, user, notice, submit, review, woken } = await shipFixture('ship-no-merge');
  try {
    const approved = review(user, submit('no merge', { mergeRequired: false }), 'approve');
    const message = notice(approved.eventId)!;
    assert.equal(message.body, `用户 验收通过了任务 #1【no merge】，任务已完成，事件 ${approved.eventId}。`);
    assert.deepEqual(message.mentions, [a.id], 'the executor keeps it as unread');
    assert.deepEqual(woken(message), []);
  } finally { await app.close(); }
});

test('ship wake: a self-reviewed submission wakes nobody and has no ship instruction', async () => {
  const { app, c, send, user, notice, submit, woken } = await shipFixture('ship-self');
  try {
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const submitted = submit('self reviewed', { reviewer: { kind: 'self' } });
    assert.equal(submitted.task.status, 'completed');
    const message = notice(submitted.eventId)!;
    assert.equal(message.body, `A 提交了任务 #1【self reviewed】的结果并完成自查，任务已完成，事件 ${submitted.eventId}。`);
    assert.deepEqual(message.mentions, []);
    assert.deepEqual(woken(message), []);
  } finally { await app.close(); }
});

test('ship failure: preserves completed state across every tier and informs infoOnly without waking', async () => {
  const { app, a, b, send, user, as, notice, submit, review, woken } = await shipFixture('ship-failed-runner');
  try {
    const fail = (done: any) => send({ kind: 'system' }, { action: 'task.ship_failed', taskId: done.task.id, expectedRevision: done.task.revision,
      submissionId: done.task.approvedSubmissionId, reason: 'checks: npm test failed' });
    // User acceptance and self review: task stays completed, failure stays in executor's unread without waking.
    for (const done of [review(user, submit('user tier'), 'approve'), submit('self tier', { reviewer: { kind: 'self' } })]) {
      const failed = fail(done);
      assert.equal(failed.task.status, 'completed');
      assert.equal(failed.task.assignedMemberId, null);
      assert.ok(failed.task.shipFailure);
      assert.deepEqual(notice(failed.eventId)!.mentions, [a.id], 'the failure is in the executor’s unread');
      assert.deepEqual(woken(notice(failed.eventId)!), [], 'and does not wake them again');
    }
    // The user approving for a member reviewer leaves ship to the executor; both hear as infoOnly unread.
    const forMember = fail(review(user, submit('user for member', { reviewer: as(b) }), 'approve'));
    assert.deepEqual([...notice(forMember.eventId)!.mentions].sort(), [a.id, b.id].sort());
    assert.deepEqual(woken(notice(forMember.eventId)!), []);
    // The member reviewer ran ship: both reviewer and executor get infoOnly unread without an automatic wake.
    const byReviewer = fail(review(as(b), submit('member tier', { reviewer: as(b) }), 'approve', 'ok'));
    assert.deepEqual([...notice(byReviewer.eventId)!.mentions].sort(), [a.id, b.id].sort());
    assert.deepEqual(woken(notice(byReviewer.eventId)!), []);
  } finally { await app.close(); }
});

test('ship wake: the coordinator is not woken, even when it has become the executor since', async () => {
  const { app, a, c, send, user, notice, submit, review, woken } = await shipFixture('ship-coordinator');
  try {
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const submitted = submit('with coordinator');
    const unread = app.store.countUnread(c.id, app.store.getMember(c.id)!.clusterId);
    const approved = review(user, submitted, 'approve');
    const message = notice(approved.eventId)!;
    assert.deepEqual(message.mentions, [a.id]);
    assert.deepEqual(woken(message), [a.id], 'only the executor');
    assert.equal(app.store.countUnread(c.id, app.store.getMember(c.id)!.clusterId), unread, 'not even as unread');
    const pending = submit('coordinator since');
    send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const late = notice(review(user, pending, 'approve').eventId)!;
    assert.deepEqual(late.mentions, [], 'the coordinator rule wins over the ship wake');
    assert.deepEqual(woken(late), []);
  } finally { await app.close(); }
});

test('ship wake: an offline executor is not delivered, not resent and keeps the notice unread', async () => {
  const { app, native, cluster, a, c, send, user, systems, notice, deliveriesOf, submit, review } = await shipFixture('ship-offline');
  try {
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const submitted = submit('offline');
    native.isOnline = (sessionId) => sessionId !== 's1';
    const unread = app.store.countUnread(a.id, cluster.id);
    const message = notice(review(user, submitted, 'approve').eventId)!;
    assert.deepEqual(deliveriesOf(message.id).map((delivery) => [delivery.memberId, delivery.state]), [[a.id, 'offline']]);
    assert.equal(app.store.countUnread(a.id, cluster.id), unread + 1, 'it stays unread');
    assert.equal(systems().some((item) => item.body.includes('投递失败或离线')), false, 'a system notice raises no failure notice to the coordinator');
    native.isOnline = () => true;
    app.hub.sendFromUser(cluster.id, 'back online', [a.id]);
    await waitFor(() => native.delivered.some((sent) => sent.sessionId === 's1' && sent.text.includes('back online')), 'the next message');
    assert.equal(native.delivered.some((sent) => sent.text.includes(SHIP_LINE)), false, 'never resent');
    assert.equal(deliveriesOf(message.id)[0].state, 'offline');
  } finally { await app.close(); }
});

test('ship wake: a removed executor gets no delivery and the approval still succeeds', async () => {
  const { app, cluster, a, c, send, user, notice, deliveriesOf, submit, review } = await shipFixture('ship-removed');
  try {
    const first = submit('removed one');
    const second = submit('removed two');
    app.hub.removeMember(cluster.id, a.id);
    const alone = review(user, first, 'approve');
    assert.equal(alone.task.status, 'completed');
    assert.equal(notice(alone.eventId), undefined, 'with nobody left to tell, no notice is written');
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const kept = notice(review(user, second, 'approve').eventId)!;
    assert.deepEqual(kept.mentions, [], 'the chat record keeps it, naming nobody');
    assert.deepEqual(deliveriesOf(kept.id), []);
  } finally { await app.close(); }
});

test('wake and info notification tiers: actions create deliveries, receipts only unread mentions', async () => {
  const { app, cluster, a, b, send, user, as, notice, deliveriesOf } = await fixture('tiers');
  try {
    const created = send(user, { action: 'task.create', title: 'tiers', scope: 's', acceptance: 'a', mergeRequired: false, reviewer: { kind: 'member', memberId: b.id } });
    const task = created.task!;
    const nominated = send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: a.id });
    const nominateNotice = notice(nominated.eventId)!;
    assert.ok(deliveriesOf(nominateNotice.id).some((d) => d.memberId === a.id), 'nomination wakes the nominee');
    let current = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: nominated.task.revision, title: 'renamed' });
    const editNotice = notice(current.eventId)!;
    assert.ok(editNotice.mentions.includes(a.id) && editNotice.mentions.includes(b.id));
    assert.equal(deliveriesOf(editNotice.id).length, 0, 'a metadata-only edit is info: no delivery');
    assert.ok(app.store.countUnread(a.id, cluster.id) >= 1, 'the info notice is still unread');
    current = send(as(a), { action: 'task.claim', taskId: task.id, expectedRevision: current.task.revision });
    current = send(as(a), { action: 'task.start', taskId: task.id, expectedRevision: current.task.revision, assignmentId: current.assignment!.id });
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    const submitted = send(as(a), { action: 'task.submit', taskId: task.id, expectedRevision: current.task.revision,
      assignmentId: current.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    assert.ok(deliveriesOf(notice(submitted.eventId)!.id).some((d) => d.memberId === b.id), 'a new submission wakes the reviewer');
    const reviewed = send(as(b), { action: 'task.review', taskId: task.id, expectedRevision: submitted.task.revision,
      submissionId: submitted.submission!.id, verdict: 'approve', reason: 'reviewed' });
    const approveNotice = notice(reviewed.eventId)!;
    assert.ok(approveNotice.mentions.includes(a.id), 'the former owner is told');
    assert.equal(deliveriesOf(approveNotice.id).length, 0, 'approval is info: the owner is not woken');
    assert.ok(app.store.countUnread(a.id, cluster.id) >= 1);
  } finally { await app.close(); }
});

test('awaiting approval nothing is delivered; the decision wakes whoever must act', async () => {
  const { app, a, b, c, send, user, as, notice, deliveriesOf, systems } = await fixture('approval-tiers');
  try {
    const woken = (message: { id: string }) => deliveriesOf(message.id).map((delivery) => delivery.memberId).sort();
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    // Entering the gate at creation names nobody, not even the coordinator.
    const created = send(as(a), { action: 'task.create', title: 'gated', scope: 's', acceptance: 'a', requiresApproval: true });
    const entry = notice(created.eventId)!;
    assert.match(entry.body, /^任务 #1【gated】等待用户批准，事件 \d+。$/);
    assert.deepEqual(entry.mentions, []);
    assert.deepEqual(woken(entry), []);
    // A rejection or an approval with nobody lined up wakes the creator.
    const rejected = send(user, { action: 'task.approve', taskId: created.task.id, expectedRevision: created.task.revision, verdict: 'reject', reason: 'more detail' });
    assert.deepEqual(woken(notice(rejected.eventId)!), [a.id]);
    const approved = send(user, { action: 'task.approve', taskId: created.task.id, expectedRevision: rejected.task.revision, verdict: 'approve' });
    assert.deepEqual(woken(notice(approved.eventId)!), [a.id]);
    // Entering the gate later, and editing while gated, reach neither nominee nor reviewer.
    let task = send(as(b), { action: 'task.create', title: 'lined up', scope: 's', acceptance: 'a', reviewer: as(c) }).task!;
    task = send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: a.id }).task!;
    const closed = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, requiresApproval: true });
    assert.deepEqual([notice(closed.eventId)!.mentions, woken(notice(closed.eventId)!)], [[], []]);
    const edited = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: closed.task.revision, scope: 'new scope' });
    assert.deepEqual([notice(edited.eventId)!.mentions, woken(notice(edited.eventId)!)], [[], []]);
    assert.match(notice(edited.eventId)!.body, /已更新/, 'the edit stays in the group record');
    // With a nominee lined up the approval wakes them; the creator only needs to know.
    const go = send(user, { action: 'task.approve', taskId: task.id, expectedRevision: edited.task.revision, verdict: 'approve' });
    assert.deepEqual(woken(notice(go.eventId)!), [a.id]);
    assert.ok(notice(go.eventId)!.mentions.includes(b.id), 'the creator keeps it as unread');
    // The user lifting the gate is a go-ahead for the nominee too, but nothing for the reviewer to do.
    let lifted = send(user, { action: 'task.create', title: 'lift', scope: 's', acceptance: 'a', reviewer: as(b) }).task!;
    lifted = send(user, { action: 'task.nominate', taskId: lifted.id, expectedRevision: lifted.revision, memberId: a.id }).task!;
    lifted = send(user, { action: 'task.edit', taskId: lifted.id, expectedRevision: lifted.revision, requiresApproval: true }).task!;
    const open = send(user, { action: 'task.edit', taskId: lifted.id, expectedRevision: lifted.revision, requiresApproval: false });
    assert.deepEqual(woken(notice(open.eventId)!), [a.id]);
    assert.ok(notice(open.eventId)!.mentions.includes(b.id));
    assert.ok(!systems().some((message) => message.body.includes('前置依赖已就绪')));
  } finally { await app.close(); }
});

test('review approval and merge: executor is told, only ready owners are woken, a gated downstream hears nothing', async () => {
  const { app, cluster, a, b, c, send, user, as, notice, deliveriesOf, systems } = await fixture('merge-tiers');
  try {
    const woken = (message: { id: string }) => deliveriesOf(message.id).map((delivery) => delivery.memberId).sort();
    send(user, { action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute' });
    const make = (title: string, extra: Record<string, unknown> = {}) => send(user, { action: 'task.create', title, scope: 's', acceptance: 'a', ...extra }).task!;
    const nominate = (task: any, memberId: string) => send(user, { action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId }).task!;
    const upstream = make('up', { reviewer: as(b) });
    const blocker = make('blocker');
    nominate(make('ready one', { dependencyIds: [upstream.id] }), a.id);
    const blocked = nominate(make('still blocked', { dependencyIds: [upstream.id, blocker.id] }), b.id);
    send(as(b), { action: 'task.claim', taskId: blocked.id, expectedRevision: blocked.revision });
    const gated = nominate(make('gated down', { dependencyIds: [upstream.id] }), b.id);
    send(user, { action: 'task.edit', taskId: gated.id, expectedRevision: gated.revision, requiresApproval: true });
    let current = send(as(a), { action: 'task.claim', taskId: upstream.id, expectedRevision: upstream.revision });
    const assignmentId = current.assignment!.id;
    current = send(as(a), { action: 'task.start', taskId: upstream.id, expectedRevision: current.task.revision, assignmentId });
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    current = send(as(a), { action: 'task.submit', taskId: upstream.id, expectedRevision: current.task.revision, assignmentId,
      summary: 'done', evidenceMessageIds: [evidence.id], commitSha: 'abcdef0123' });
    const reviewed = send(as(b), { action: 'task.review', taskId: upstream.id, expectedRevision: current.task.revision,
      submissionId: current.submission!.id, verdict: 'approve', reason: 'looks right' });
    const approval = notice(reviewed.eventId)!;
    assert.ok(approval.mentions.includes(a.id), 'the executor keeps it as unread');
    assert.deepEqual(woken(approval), [], 'approval wakes nobody; the group keeps the record');
    assert.ok(!approval.mentions.includes(c.id), 'not even the coordinator');
    assert.ok(!systems().some((message) => message.body.includes('前置依赖已就绪')), 'a completed mergeRequired task readies nobody');
    const merged = send({ kind: 'system' }, { action: 'task.shipped', taskId: upstream.id, expectedRevision: reviewed.task.revision, submissionId: current.submission!.id, commitSha: 'abcdef1234', reason: 'ship' });
    const mergeNotice = notice(merged.eventId)!;
    assert.match(mergeNotice.body, /^任务 #1【up】已合并（提交 abcdef1），事件 \d+。$/);
    assert.deepEqual(woken(mergeNotice), [], 'a merge wakes nobody by itself');
    assert.ok(!mergeNotice.mentions.includes(c.id), 'the coordinator is not told');
    assert.ok(mergeNotice.mentions.includes(b.id), 'the owner of a still blocked downstream only gets it as unread');
    const ready = systems().filter((message) => message.body.includes('前置依赖已就绪'));
    assert.equal(ready.length, 1);
    assert.match(ready[0].body, /ready one/);
    assert.deepEqual(ready[0].mentions, [a.id]);
    assert.deepEqual(woken(ready[0]), [a.id]);
  } finally { await app.close(); }
});

test('assigning a task whose dependencies are not ready only informs the executor; readiness wakes them', async () => {
  const { app, cluster, a, b, c, send, user, as, notice, deliveriesOf, systems } = await fixture('unready-assign');
  try {
    const woken = (message: { id: string }) => deliveriesOf(message.id).map((delivery) => delivery.memberId);
    const make = (title: string, extra: Record<string, unknown> = {}) => send(user, { action: 'task.create', title, scope: 's', acceptance: 'a', ...extra });
    const assign = (task: any, memberId: string) => send(user, { action: 'task.assign', taskId: task.id, expectedRevision: task.revision, memberId });
    const upstream = make('up', { reviewer: as(c) }).task!;
    // At creation and by a later assignment: the executor cannot start, so the notice is unread only.
    const created = make('named at creation', { dependencyIds: [upstream.id], memberId: b.id });
    assert.deepEqual(notice(created.eventId)!.mentions, [b.id]);
    assert.deepEqual(woken(notice(created.eventId)!), [], 'no delivery while the dependency is not ready');
    const assigned = assign(make('assigned later', { dependencyIds: [upstream.id] }).task!, b.id);
    assert.deepEqual(notice(assigned.eventId)!.mentions, [b.id]);
    assert.deepEqual(woken(notice(assigned.eventId)!), []);
    // Nothing to wait for: the assignment wakes as before.
    assert.deepEqual(woken(notice(assign(make('no dependencies').task!, b.id).eventId)!), [b.id]);
    assert.deepEqual(woken(notice(make('no dependencies at creation', { memberId: b.id }).eventId)!), [b.id]);

    let current = send(as(a), { action: 'task.claim', taskId: upstream.id, expectedRevision: upstream.revision });
    const assignmentId = current.assignment!.id;
    current = send(as(a), { action: 'task.start', taskId: upstream.id, expectedRevision: current.task.revision, assignmentId });
    const evidence = app.hub.sendFromUser(cluster.id, 'evidence');
    current = send(as(a), { action: 'task.submit', taskId: upstream.id, expectedRevision: current.task.revision, assignmentId,
      summary: 'done', evidenceMessageIds: [evidence.id], commitSha: 'abcdef0123' });
    const reviewed = send(as(c), { action: 'task.review', taskId: upstream.id, expectedRevision: current.task.revision,
      submissionId: current.submission!.id, verdict: 'approve', reason: 'looks right' });
    assert.ok(!systems().some((message) => message.body.includes('前置依赖已就绪')), 'approved but not merged: still not ready');
    send({ kind: 'system' }, { action: 'task.shipped', taskId: upstream.id, expectedRevision: reviewed.task.revision,
      submissionId: current.submission!.id, commitSha: 'abcdef1234', reason: 'ship' });
    const ready = systems().filter((message) => message.body.includes('前置依赖已就绪'));
    assert.deepEqual(ready.map((message) => message.body.match(/任务 #\d+「(.*?)」/)![1]).sort(), ['assigned later', 'named at creation']);
    for (const message of ready) assert.deepEqual(woken(message), [b.id], 'the merge readies the task and wakes its executor');
    // Assigned once the dependency is merged: an ordinary wake.
    assert.deepEqual(woken(notice(assign(make('after the merge', { dependencyIds: [upstream.id] }).task!, b.id).eventId)!), [b.id]);
  } finally { await app.close(); }
});

test('attaching files wakes the executor with a sentence the page recognizes', async () => {
  const { app, cluster, b, send, user, notice, deliveriesOf } = await fixture('task-files');
  try {
    app.store.insertFile({ id: 'file-1', clusterId: cluster.id, uploader: 'user', name: 'shot.png', mime: 'image/png', size: 3, sha256: 'x', createdAt: '2026-01-01' });
    const { task } = send(user, { action: 'task.create', title: 'work', scope: 's', acceptance: 'a', memberId: b.id });
    const edited = send(user, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, fileIds: ['file-1'] });
    const message = notice(edited.eventId)!;
    assert.equal(message.body, `任务 #1【work】已更新：改了 附件，事件 ${edited.eventId}。`);
    assert.deepEqual(deliveriesOf(message.id).map((delivery: any) => delivery.memberId), [b.id], 'attachments are not a metadata-only edit');
  } finally {
    await app.close();
  }
});
