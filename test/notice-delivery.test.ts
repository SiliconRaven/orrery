import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { CollaborationCommand, CollaborationResult } from '../src/core/collaboration-types.ts';
import type { Message } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { collaborationLinks, collaborationTask, linkCollaborationMessage } from '../src/plugins/tasks/store.ts';

async function fixture() {
  const dir = tempDir();
  const sessions = ['a', 'b', 'c'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  const { cluster, members: [a, b, c] } = await app.hub.createCluster('notices', sessions.map((s) => ({
    harness: 'mock', mode: 'native', sessionId: s.id, name: s.id.toUpperCase(),
  })));
  let serial = 0;
  const send = (command: Omit<CollaborationCommand, 'operationId'>, operationId = `notice-${++serial}`) =>
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { ...command, operationId });
  const create = (title: string) => send({ action: 'task.create', title, scope: 'scope', acceptance: 'done' }).task!;
  const nominate = (task: ReturnType<typeof create>, memberId: string | null, operationId?: string) =>
    send({ action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId }, operationId);
  const notice = (result: CollaborationResult) => app.store.listMessages(cluster.id, 100).find((m) => m.collabEventId === result.eventId)!;
  const delivery = (message: Message, memberId: string) => app.store.withDeliveries([message])[0].deliveries.find((d) => d.memberId === memberId)!;
  return { app, native, cluster, a, b, c, send, create, nominate, notice, delivery };
}

test('changed and cleared nominations supersede only the old unstarted recipient, preserving history and read state', async () => {
  const f = await fixture();
  const { app, native, cluster, a, b, c, send, create, nominate, notice, delivery } = f;
  try {
    app.hub.setPaused(true);
    send({ action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'execute', permissions: { deliveryControl: true } });
    let task = create('first');
    const first = nominate(task, a.id); task = first.task!;
    const firstMessage = notice(first); const original = structuredClone(firstMessage);
    const again = send({ action: 'task.assign', taskId: task.id, expectedRevision: task.revision, memberId: a.id }); task = again.task!;
    const againMessage = notice(again);
    assert.equal(delivery(firstMessage, a.id).state, 'queued', 'same nominee does not supersede');
    const other = create('other');
    const otherNomination = nominate(other, a.id); const otherMessage = notice(otherNomination);
    const fake: Message = { ...firstMessage, id: 'unlinked-system-notice', collabEventId: undefined };
    app.store.insertMessage(fake, [a.id]);
    linkCollaborationMessage(app.store, fake.id, task.id, 'system');
    linkCollaborationMessage(app.store, fake.id, other.id, 'system');
    const cross = { ...otherMessage, id: 'cross-task-notice' };
    app.store.insertMessage(cross, [a.id]);
    linkCollaborationMessage(app.store, cross.id, task.id, 'system');
    const attempted = { ...firstMessage, id: 'already-attempted' };
    const attemptedDelivery = app.store.insertMessage(attempted, [a.id])[0];
    app.store.db.prepare('UPDATE deliveries SET attempts = 1 WHERE id = ?').run(attemptedDelivery.id);
    const suggestedEvent = app.store.appendCollaborationEvent(cluster.id, null,
      { action: 'task.nominate', taskId: task.id, memberId: a.id, suggested: true });
    const suggestedMessage = { ...firstMessage, id: 'suggested-event', collabEventId: suggestedEvent.seq };
    app.store.insertMessage(suggestedMessage, [a.id]);
    const switched = nominate(task, b.id, 'switch'); task = switched.task!;
    const newMessage = notice(switched);
    for (const message of [firstMessage, againMessage]) {
      const d = delivery(message, a.id);
      assert.equal(d.state, 'superseded');
      assert.equal(d.outcome, null);
      assert.match(d.error!, new RegExp(`事件 ${switched.eventId}.*B`));
      assert.equal((app.store.db.prepare('SELECT attempts FROM deliveries WHERE id = ?').get(d.id) as any).attempts, 0);
      assert.throws(() => app.hub.handoffDelivery(cluster.id, d.id, { targetMemberId: b.id }), /not eligible/);
      const [detail] = app.hub.getDeliveries(c.id, message.id).deliveries;
      assert.equal(detail.status, 'superseded');
      assert.equal(detail.outcome, 'unknown');
      assert.equal(detail.startedAt, undefined);
      assert.equal(detail.endedAt, d.updatedAt);
      assert.equal(detail.reason, d.error);
    }
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const response = await fetch(`${app.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'x-orrery-bridge': secret, 'x-orrery-session': 'c', 'x-orrery-harness': 'mock' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'get_deliveries', arguments: { clusterId: cluster.id, messageId: firstMessage.id },
      } }),
    });
    const rpc = await response.json() as any;
    const { fyi, deliveries: [detail] } = JSON.parse(rpc.result.content[0].text);
    assert.equal(fyi, false);
    assert.equal(detail.status, 'superseded');
    assert.match(detail.reason, new RegExp(`事件 ${switched.eventId}`));
    assert.equal(detail.startedAt, undefined);
    assert.ok(detail.endedAt);
    assert.throws(() => app.hub.getDeliveries(a.id, firstMessage.id), /only the sender or/);
    app.store.db.prepare("UPDATE deliveries SET outcome = 'unknown' WHERE id = ?").run(delivery(firstMessage, a.id).id);
    assert.throws(() => app.hub.handoffDelivery(cluster.id, delivery(firstMessage, a.id).id, { targetMemberId: b.id, confirmStopped: true }), /not eligible/);
    app.store.db.prepare('UPDATE deliveries SET outcome = NULL WHERE id = ?').run(delivery(firstMessage, a.id).id);
    assert.equal(delivery(otherMessage, a.id).state, 'queued');
    assert.equal(delivery(fake, a.id).state, 'queued');
    assert.equal(delivery(cross, a.id).state, 'queued');
    assert.equal(delivery(attempted, a.id).state, 'queued', 'a previously started row is not withdrawn');
    assert.equal(delivery(suggestedMessage, a.id).state, 'queued', 'suggested events do not prove a real nomination');
    assert.equal(delivery(newMessage, b.id).state, 'queued');
    assert.deepEqual(app.store.getMessage(firstMessage.id), original);
    assert.ok(collaborationLinks(app.store, firstMessage.id).includes(task.id));
    assert.equal(app.store.countUnread(a.id, cluster.id), 3, 'the two superseded messages and the info notice that the task moved count as unread; queued deliveries do not');
    assert.equal(app.store.db.prepare('SELECT * FROM reads WHERE member_id = ? AND message_id = ?').get(a.id, firstMessage.id), undefined);
    assert.ok(app.hub.readMessages(a.id).some((m) => m.id === firstMessage.id), 'superseded is still normally unread');
    const historyCount = app.store.listEvents(0).filter((e) => e.kind === 'delivery'
      && (e.payload as any).delivery.state === 'superseded').length;
    const retry = send({ action: 'task.nominate', taskId: task.id, expectedRevision: again.task!.revision, memberId: b.id }, 'switch');
    assert.equal(retry.eventId, switched.eventId);
    assert.equal(app.store.listEvents(0).filter((e) => e.kind === 'delivery' && (e.payload as any).delivery.state === 'superseded').length, historyCount);
    const back = nominate(task, a.id); task = back.task!;
    assert.equal(delivery(newMessage, b.id).state, 'superseded');
    const backMessage = notice(back);
    const clear = nominate(task, null); task = clear.task!;
    assert.equal(delivery(backMessage, a.id).state, 'superseded');
    assert.match(delivery(backMessage, a.id).error!, /已清除/);
    app.hub.setPaused(false);
    await waitFor(() => delivery(otherMessage, a.id).state === 'done', 'other task still delivered');
    assert.ok(native.delivered.every((d) => !d.text.includes(firstMessage.id) && !d.text.includes(newMessage.id)));
  } finally { await app.close(); }
});

test('superseding the pending head releases another cluster sharing the same native session', async () => {
  const { app, native, a, b, create, nominate, notice, delivery } = await fixture();
  const gate = Promise.withResolvers<boolean>();
  let checks = 0;
  native.confirmOnline = (session) => session === 'a' && ++checks === 1 ? gate.promise : Promise.resolve(true);
  try {
    const sibling = await app.hub.createCluster('sibling', [{ harness: 'mock', mode: 'native', sessionId: 'a', name: 'A' }]);
    let task = create('shared');
    const first = nominate(task, a.id); task = first.task!; const old = notice(first);
    await waitFor(() => checks >= 1, 'first online check');
    const siblingTask = app.hub.collaboration.command({ kind: 'user' }, sibling.cluster.id,
      { action: 'task.create', operationId: 'other-create', title: 'other', scope: 'scope', acceptance: 'done' }).task!;
    const siblingNomination = app.hub.collaboration.command({ kind: 'user' }, sibling.cluster.id,
      { action: 'task.nominate', operationId: 'other-nominate', taskId: siblingTask.id,
        expectedRevision: siblingTask.revision, memberId: sibling.members[0].id });
    const siblingNotice = app.store.listMessages(sibling.cluster.id, 100).find((m) => m.collabEventId === siblingNomination.eventId)!;
    const next = app.hub.sendFromUser(sibling.cluster.id, '@A later message');
    await waitFor(() => checks >= 2, 'sibling online check');
    await waitFor(() => !(app.hub as any).confirming.has(sibling.members[0].id), 'sibling checks finish');
    assert.equal(native.delivered.some((d) => d.text.includes(next.id)), false);
    nominate(task, b.id);
    assert.equal(delivery(old, a.id).state, 'superseded');
    assert.notEqual(delivery(siblingNotice, sibling.members[0].id).state, 'superseded', 'the other cluster is unchanged');
    await waitFor(() => native.delivered.find((d) => d.text.includes(next.id)), 'sibling queue proceeds');
    assert.ok(native.delivered.some((d) => d.text.includes(siblingNotice.id)));
    gate.resolve(false);
    await waitFor(() => !(app.hub as any).confirming.has(a.id), 'stale check finished');
    assert.equal(delivery(old, a.id).state, 'superseded');
  } finally { gate.resolve(false); await app.close(); }
});

test('handoff, release and cancel supersede the old executor\'s unstarted assignment notice', async () => {
  const { app, a, b, c, send, notice, delivery } = await fixture();
  try {
    app.hub.setPaused(true);
    const make = (title: string) => send({ action: 'task.create', title, scope: 'scope', acceptance: 'done', memberId: a.id });
    const created = make('handed');
    const old = notice(created);
    assert.equal(delivery(old, a.id).state, 'queued');
    const handed = send({ action: 'task.handoff', taskId: created.task!.id, expectedRevision: created.task!.revision, memberId: b.id, reason: 'b knows this' });
    assert.equal(delivery(old, a.id).state, 'superseded');
    assert.match(delivery(old, a.id).error!, new RegExp(`事件 ${handed.eventId}.*B`));

    const handedNotice = notice(handed);
    assert.equal(delivery(handedNotice, b.id).state, 'queued');
    send({ action: 'task.assign', taskId: created.task!.id, expectedRevision: handed.task!.revision, memberId: c.id });
    assert.equal(delivery(handedNotice, b.id).state, 'superseded', 'the notice of a handoff is an assignment too');

    for (const action of ['task.release', 'task.cancel'] as const) {
      const made = make(action);
      send({ action, taskId: made.task!.id, expectedRevision: made.task!.revision, reason: 'no longer needed' });
      assert.equal(delivery(notice(made), a.id).state, 'superseded', action);
      assert.match(delivery(notice(made), a.id).error!, /已清除/, action);
    }
  } finally { await app.close(); }
});

test('a throwing listener cannot prevent committed replacement or subsequent queue scheduling', async () => {
  const { app, native, a, b, create, nominate, notice, delivery } = await fixture();
  try {
    app.hub.setPaused(true);
    let task = create('listener');
    const first = nominate(task, a.id); task = first.task!; const old = notice(first);
    const unsub = app.hub.subscribe((event) => {
      if (event.kind === 'delivery' && (event.payload as any).delivery.state === 'superseded') throw new Error('listener failure');
    });
    const result = nominate(task, b.id, 'listener-switch');
    unsub();
    assert.equal(delivery(old, a.id).state, 'superseded');
    assert.equal(nominate(task, b.id, 'listener-switch').eventId, result.eventId);
    const next = notice(result);
    app.hub.setPaused(false);
    await waitFor(() => native.delivered.find((d) => d.text.includes(next.id)), 'new nomination delivered');
  } finally { await app.close(); }
});

test('a reentrant replacement does not register an already superseded online check', async () => {
  const { app, native, cluster, a, b, c, create, nominate, notice, delivery } = await fixture();
  const gate = Promise.withResolvers<boolean>();
  native.confirmOnline = () => gate.promise;
  try {
    app.hub.setPaused(true);
    let task = create('reentrant');
    task = nominate(task, a.id).task!;
    let nested = false;
    const unsubscribe = app.hub.subscribe((event) => {
      const payload = event.payload as { action?: string; memberId?: string };
      if (!nested && event.kind === 'collaboration' && payload.action === 'task.nominate' && payload.memberId === b.id) {
        nested = true;
        const current = collaborationTask(app.store, cluster.id, task.id)!;
        nominate(current, c.id, 'reentrant-c');
      }
    });
    const replaced = nominate(task, b.id, 'reentrant-b');
    unsubscribe();
    const old = notice(replaced);
    assert.equal(delivery(old, b.id).state, 'superseded');
    assert.equal((app.hub as any).pending.has(delivery(old, b.id).id), false);
  } finally { gate.resolve(true); await app.close(); }
});

test('suggestion and rollback leave old queued nomination untouched; retry commits once', async () => {
  const { app, cluster, a, b, c, send, create, nominate, notice, delivery } = await fixture();
  try {
    app.hub.setPaused(true);
    const policy = send({ action: 'coordinator.set', memberId: c.id, enabled: true, mode: 'suggest' });
    let task = create('rollback');
    const first = nominate(task, a.id); task = first.task!;
    const old = notice(first);
    const proposal = app.hub.collaboration.command({ kind: 'member', memberId: c.id }, cluster.id, {
      action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: b.id,
      generation: policy.coordinator!.generation, operationId: 'suggest',
    });
    assert.ok(proposal.suggestion);
    assert.equal(delivery(old, a.id).state, 'queued');
    const before = app.store.listEvents(0).length;
    const save = app.store.saveCollaborationOperation.bind(app.store);
    app.store.saveCollaborationOperation = () => { throw new Error('forced transaction rollback'); };
    try { assert.throws(() => nominate(task, b.id, 'rollback-switch'), /forced transaction rollback/); }
    finally { app.store.saveCollaborationOperation = save; }
    assert.equal(delivery(old, a.id).state, 'queued');
    assert.equal(app.store.listEvents(0).length, before);
    const committed = nominate(task, b.id, 'rollback-switch');
    assert.equal(delivery(old, a.id).state, 'superseded');
    assert.equal(nominate(task, b.id, 'rollback-switch').eventId, committed.eventId);
  } finally { await app.close(); }
});

test('running, completed and offline nominations are never superseded', async () => {
  const { app, native, a, b, create, nominate, notice, delivery } = await fixture();
  const gate = Promise.withResolvers<'completed'>();
  const original = native.deliver;
  let hold = true;
  native.deliver = async (session, text, ctx) => {
    if (session === 'a' && hold) { native.delivered.push({ sessionId: session, text, deliveryId: ctx.deliveryId }); return gate.promise; }
    return original(session, text, ctx);
  };
  try {
    let task = create('running');
    const first = nominate(task, a.id); task = first.task!; const old = notice(first);
    await waitFor(() => delivery(old, a.id).state === 'running', 'old nomination running');
    nominate(task, b.id);
    assert.equal(delivery(old, a.id).state, 'running');
    hold = false; gate.resolve('completed');
    await waitFor(() => delivery(old, a.id).state === 'done', 'running nomination finished');
    task = create('done');
    const done = nominate(task, a.id); task = done.task!; const doneMessage = notice(done);
    await waitFor(() => delivery(doneMessage, a.id).state === 'done', 'nomination completed');
    nominate(task, b.id);
    assert.equal(delivery(doneMessage, a.id).state, 'done');
    native.isOnline = (session) => session !== 'a';
    task = create('offline');
    const offline = nominate(task, a.id); task = offline.task!; const offlineMessage = notice(offline);
    assert.equal(delivery(offlineMessage, a.id).state, 'offline');
    nominate(task, b.id);
    assert.equal(delivery(offlineMessage, a.id).state, 'offline');
  } finally { gate.resolve('completed'); await app.close(); }
});

test('superseded deliveries survive restart and cannot bypass the chain limit', async () => {
  const { app, native, a, b, create, nominate, notice, delivery } = await fixture();
  let closed = false;
  let reopened: Awaited<ReturnType<typeof startTestHub>> | undefined;
  try {
    app.hub.setPaused(true);
    let task = create('restart');
    const first = nominate(task, a.id); task = first.task!; const old = notice(first);
    const next = nominate(task, b.id); const latest = notice(next);
    assert.equal(delivery(old, a.id).state, 'superseded');
    const dir = app.dir;
    await app.close(); closed = true;
    reopened = await startTestHub({ dir, nativeAdapters: { mock: native },
      limits: { maxTurnsPerChain: 0 } });
    const store = reopened.store;
    await waitFor(() => store.withDeliveries([store.getMessage(latest.id)!])[0].deliveries[0].state === 'failed', 'guard after restart');
    const oldDelivery = store.withDeliveries([store.getMessage(old.id)!])[0].deliveries[0];
    assert.equal(oldDelivery.state, 'superseded');
    assert.equal((store.db.prepare('SELECT attempts FROM deliveries WHERE id = ?').get(oldDelivery.id) as any).attempts, 0);
    assert.equal(native.delivered.some((item) => item.text.includes(old.id)), false);
    assert.ok(store.listEvents(0).some((event) => event.kind === 'guard' && (event.payload as any).reason === 'max_turns_per_chain'));
  } finally {
    if (!closed) await app.close();
    if (reopened) await reopened.close();
  }
});

for (const online of [false, true]) test(`late online confirmation (${online}) cannot revive or overwrite superseded delivery`, async () => {
  const { app, native, a, b, create, nominate, notice, delivery } = await fixture();
  const gate = Promise.withResolvers<boolean>();
  let checks = 0;
  native.confirmOnline = (session) => session === 'a' ? (checks++, gate.promise) : Promise.resolve(true);
  try {
    app.hub.setPaused(true);
    let task = create('pending');
    const first = nominate(task, a.id); task = first.task!; const old = notice(first);
    await waitFor(() => checks > 0, 'online confirmation started');
    nominate(task, b.id);
    assert.equal(delivery(old, a.id).state, 'superseded');
    gate.resolve(online);
    await waitFor(() => !(app.hub as any).confirming.has(a.id), 'online confirmation finished');
    assert.equal(delivery(old, a.id).state, 'superseded');
    assert.equal((app.hub as any).pending.has(delivery(old, a.id).id), false);
    app.hub.setPaused(false);
    assert.ok(native.delivered.every((item) => !item.text.includes(old.id)));
  } finally { gate.resolve(online); await app.close(); }
});
