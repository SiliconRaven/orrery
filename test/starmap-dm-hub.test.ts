import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockNativeAdapter, type MockNativeOptions } from '../src/adapters/mock/native.ts';
import type { Message } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

async function fixture(onDeliver?: MockNativeOptions['onDeliver'], replies = false) {
  const dir = tempDir();
  const sessions = ['old', 'peer', 'coord', 'new'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = { ...createMockNativeAdapter({ sessions, onDeliver }), replies };
  const offline = new Set<string>();
  native.isOnline = (id) => !offline.has(id);
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, limits: { queueWarnMs: 1 } });
  const { cluster, members: [target, peer, coordinator] } = await app.hub.createCluster('Private delivery',
    sessions.slice(0, 3).map((session) => ({ harness: 'mock', sessionId: session.id, name: session.id })));
  app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
    action: 'coordinator.set', operationId: 'set-coordinator', memberId: coordinator.id, mode: 'execute',
    enabled: true, permissions: { deliveryControl: true },
  });
  const send = (body: string) => app.hub.sendFromUser(cluster.id, body, [target.id], undefined, undefined, undefined, true);
  const delivery = (message: Message) => app.store.withDeliveries([message])[0].deliveries[0];
  const history = (memberId: string) => app.hub.readMessages(memberId, { history: true, limit: 100 });
  const move = () => app.hub.rebindMember(target.id, { harness: 'mock', sessionId: 'new', confirmStopped: true });
  return { app, native, offline, cluster, target, peer, coordinator, send, delivery, history, move };
}

test('private Hub sends require a single active recipient and no attachments, tasks or handover', async (t) => {
  const { app, cluster, target, peer } = await fixture();
  t.after(() => app.close());
  const send = app.hub.sendFromUser.bind(app.hub, cluster.id, 'text');
  assert.throws(() => send([target.id], undefined, undefined, undefined, false), /private must be true or omitted/);
  assert.throws(() => send(undefined, undefined, undefined, undefined, true), /exactly one recipient/);
  assert.throws(() => send([target.id, peer.id], undefined, undefined, undefined, true), /exactly one recipient/);
  assert.throws(() => send(['unknown-member'], undefined, undefined, undefined, true), /active member/);
  assert.throws(() => send([target.id], ['file'], undefined, undefined, true), /attachments/);
  assert.throws(() => send([target.id], undefined, ['task'], undefined, true), /tasks or handover/);
  assert.throws(() => send([target.id], undefined, undefined, 'handover', true), /tasks or handover/);
  const message = send([target.id], [], [], undefined, true);
  assert.equal(message.privateTo, target.id);
  assert.equal(message.privateBindingGen, 1);
  assert.ok(app.store.isDirect(message.id));
});

test('offline and failed private sends stay out of shared history and failure notices; only same-binding direct resend works', async (t) => {
  const f = await fixture(async (_session, text) => {
    if (text === 'private-fail') throw new Error('mock delivery failed');
    return 'completed';
  });
  const { app, native, cluster, target, peer, coordinator, offline, send, delivery, history } = f;
  t.after(() => app.close());
  offline.add('old');
  const missed = send('private-offline');
  assert.equal(delivery(missed).state, 'offline');
  assert.ok(app.hub.readMessages(target.id).some((message) => message.id === missed.id));
  assert.equal(app.hub.getDeliveries(target.id, missed.id).deliveries[0].status, 'offline');
  assert.throws(() => app.hub.handoffDelivery(cluster.id, delivery(missed).id, { targetMemberId: peer.id }), /cannot be handed off/);

  for (const other of [peer, coordinator]) {
    assert.deepEqual(app.hub.readMessages(other.id, { before: missed.id }), []);
    assert.throws(() => app.hub.skipUnread(other.id, { before: missed.id }), /before must be a message in this cluster/);
    assert.throws(() => app.hub.ackMessages(other.id, [missed.id]), /cannot acknowledge/);
    assert.throws(() => app.hub.getDeliveries(other.id, missed.id), /not in your cluster/);
  }
  assert.throws(() => app.hub.sendFromMember(target.id, 'public reply', missed.id), /unknown message/);
  assert.throws(() => app.hub.sendFromMember(target.id, 'public reply', missed.id.slice(0, 8)), /unknown message/);
  assert.deepEqual(app.hub.ackMessages(target.id, [missed.id]), [missed.id]);

  offline.delete('old');
  const retry = await app.hub.resendDelivery(cluster.id, delivery(missed).id, {});
  assert.equal(retry.message.privateTo, target.id);
  assert.equal(retry.message.privateBindingGen, missed.privateBindingGen);
  assert.equal(retry.message.chainId, missed.chainId);
  assert.ok(app.store.isDirect(retry.message.id));
  assert.deepEqual(app.store.attachmentsOf(retry.message.id), []);
  await waitFor(() => delivery(retry.message).state === 'done', 'private resend delivered');
  assert.equal(native.delivered.find((entry) => entry.deliveryId === delivery(retry.message).id)?.text, missed.body);

  const failed = send('private-fail');
  await waitFor(() => delivery(failed).state === 'failed', 'mock failed during delivery');
  app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 1 });
  await assert.rejects(app.hub.resendDelivery(cluster.id, delivery(failed).id, { confirmDuplicate: true }), /chain has reached its turn limit/);
  assert.ok(app.events.some((event) => event.kind === 'guard'
    && (event.payload as { chainId?: string }).chainId === failed.id));
  for (const other of [peer, coordinator]) {
    const visible = history(other.id);
    assert.ok(visible.every((message) => !message.privateTo && message.systemKind !== 'delivery_failed'));
    assert.ok(!JSON.stringify(visible).includes(failed.id));
  }
  assert.equal(app.store.deliveryProblems(cluster.id, 100).count, 0);
});

test('rebind immediately fails queued private messages and hides prior private history from the new binding', async (t) => {
  const { app, native, cluster, target, send, delivery, history, move } = await fixture();
  t.after(() => app.close());
  const delivered = send('private delivered before rebind');
  await waitFor(() => delivery(delivered).state === 'done');
  app.hub.setPaused(true);
  const queued = send('private queued before rebind');
  const publicMessage = app.hub.sendFromUser(cluster.id, 'public queued before rebind', [target.id]);
  assert.equal(delivery(queued).state, 'queued');
  assert.ok(history(target.id).some((message) => message.id === delivered.id));
  const rebound = await move();
  assert.equal(rebound.member.bindingGen, 2);
  assert.equal(delivery(queued).state, 'failed');
  assert.match(delivery(queued).error!, /换绑/);
  assert.equal(delivery(publicMessage).state, 'queued');
  assert.ok(app.hub.readMessages(target.id).every((message) => !message.privateTo));
  assert.ok(history(target.id).every((message) => !message.privateTo));
  await assert.rejects(app.hub.resendDelivery(cluster.id, delivery(queued).id, {}), /previous or removed binding/);
  assert.throws(() => app.hub.ackMessages(target.id, [delivered.id]), /cannot acknowledge/);
  app.hub.setPaused(false);
  await waitFor(() => delivery(publicMessage).state === 'done');
  assert.ok(native.delivered.filter((entry) => entry.sessionId === 'new').every((entry) => !entry.text.includes('private')));
});

test('public notices and posts do not inherit private chains; queues and automatic native replies do not publish private content', async (t) => {
  const held = Promise.withResolvers<void>();
  let nativeReply = false;
  const f = await fixture(async (_session, text, ctx) => {
    if (text === 'private held turn') {
      ctx.waiting?.({ busy: false });
      await held.promise;
    }
    if (text === 'private auto-answer turn') {
      nativeReply = true;
      ctx.reply?.('automatic reply from native private turn');
    }
    return 'completed';
  }, true);
  const { app, cluster, target, peer, coordinator, send, delivery, history } = f;
  t.after(async () => { held.resolve(); await app.close(); });
  const running = send('private held turn');
  await waitFor(() => delivery(running).state === 'running');
  const task = (title: string) => app.hub.collaboration.command({ kind: 'member', memberId: target.id }, cluster.id, {
    action: 'task.create', operationId: title, title, scope: 'scope', acceptance: 'done', memberId: peer.id,
  });
  const during = task('during-private');
  const standalone = app.hub.sendFromMember(target.id, 'independent public post').message;
  assert.equal(standalone.chainId, standalone.id);
  const queued = send('private auto-answer turn');
  const group = app.hub.sendFromUser(cluster.id, 'public queued text', [target.id]);
  await waitFor(() => app.store.overdueQueued(new Date(Date.now() + 60_000).toISOString()).some((q) => q.message.id === group.id));
  (app.hub as unknown as { warnLongQueues(): void }).warnLongQueues();
  const warnings = history(coordinator.id).filter((message) => message.systemKind === 'queue_warning');
  assert.ok(warnings.some((message) => message.body.includes(group.id)));
  assert.ok(warnings.every((message) => !message.body.includes(running.id) && !message.body.includes(queued.id)));

  held.resolve();
  await waitFor(() => nativeReply && delivery(queued).state === 'done' && delivery(group).state === 'done');
  const last = send('private last turn');
  await waitFor(() => delivery(last).state === 'done');
  const after = task('after-private');
  const next = app.hub.sendFromMember(target.id, 'another independent public post').message;
  assert.equal(next.chainId, next.id);
  const visible = history(peer.id);
  for (const eventId of [during.eventId, after.eventId]) {
    const notice = visible.find((message) => message.collabEventId === eventId);
    assert.ok(notice, 'regular task notification remains visible');
    assert.equal(notice.replyTo, null);
    assert.equal(notice.chainId, notice.id);
  }
  const serialized = JSON.stringify(visible);
  for (const message of [running, queued, last]) assert.ok(!serialized.includes(message.id));
  assert.ok(!serialized.includes('automatic reply from native private turn'));
  assert.ok(!JSON.stringify(app.events).includes('回答没有发到群里'));
});
