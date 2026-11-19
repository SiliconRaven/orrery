import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

test('native delivery outcomes are persisted with events and only successful delivery records a read', async () => {
  const dir = tempDir();
  const native = createMockNativeAdapter({ sessions: [{ id: 's', title: 's', model: null, cwd: dir, updatedAt: null }] });
  native.deliver = async (_session, text) => {
    if (text === 'accepted') return 'accepted';
    if (text === 'completed') return 'completed';
    if (text === 'failed') return { outcome: 'failed', error: 'turn failed' };
    if (text === 'unknown') return { outcome: 'unknown', error: 'connection lost' };
    throw new Error('unclassified error');
  };
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    const { cluster, members: [m] } = await app.api('POST', '/api/clusters', { name: 'results', members: [{ harness: 'mock', mode: 'native', sessionId: 's', name: 'A' }] });
    for (const [text, state, outcome] of [
      ['accepted', 'done', 'accepted'], ['completed', 'done', 'completed'], ['failed', 'failed', 'failed'],
      ['unknown', 'failed', 'unknown'], ['throw', 'failed', null],
    ] as const) {
      const msg = app.hub.sendFromUser(cluster.id, text, [m.id]);
      await waitFor(() => ['done', 'failed', 'offline'].includes(app.store.withDeliveries([msg])[0].deliveries[0].state));
      const row = app.store.withDeliveries([msg])[0];
      assert.deepEqual([row.deliveries[0].state, row.deliveries[0].outcome], [state, outcome]);
      assert.equal(row.reads.some((r) => r.via === 'delivery'), state === 'done');
      const event = app.events.filter((e) => e.kind === 'delivery' && (e.payload as any).delivery.messageId === msg.id).at(-1)!;
      assert.equal((event.payload as any).delivery.outcome, outcome);
    }
  } finally { await app.close(); }
});

test('restart recovery atomically records unknown and does not repeat events on a second start', async () => {
  const store = new Store(':memory:');
  const dir = tempDir();
  store.insertCluster({ id: 'c', name: 'c', createdAt: 'now', category: '' }, [{
    id: 'm', clusterId: 'c', name: 'A', avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 's', cwd: dir, origin: 'created', removedAt: null,
  }]);
  const [d] = store.insertMessage({ id: 'msg', clusterId: 'c', from: 'user', mentions: ['m'], body: 'work', replyTo: null, chainId: 'msg', hop: 0, createdAt: 'now' }, ['m']);
  store.startDelivery(d.id, d.id);
  const append = store.appendEvent;
  store.appendEvent = () => { throw new Error('injected recovery event failure'); };
  assert.throws(() => new Hub({ store, nativeAdapters: {} }), /injected recovery/);
  assert.equal(store.getDelivery(d.id)!.state, 'running');
  store.appendEvent = append;
  const first = new Hub({ store, nativeAdapters: {} });
  assert.deepEqual([store.getDelivery(d.id)!.state, store.getDelivery(d.id)!.outcome], ['failed', 'unknown']);
  assert.equal(store.listEvents(0).filter((e) => e.kind === 'delivery').length, 1);
  await first.close();
  const second = new Hub({ store, nativeAdapters: {} });
  assert.equal(store.listEvents(0).filter((e) => e.kind === 'delivery').length, 1);
  await second.close();
  store.close();
});

test('a failed batch start rolls back and a throwing subscriber cannot strand the retry', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerHour: 1 } });
  try {
    const { cluster, members: [m] } = await app.api('POST', '/api/clusters', {
      name: 'batch start', members: [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }],
    });
    app.hub.setPaused(true);
    const messages = ['@A first', '@A second'].map((body) => app.hub.sendFromUser(cluster.id, body));
    const queued = () => app.store.withDeliveries(messages).flatMap((message) => message.deliveries);
    const append = app.store.appendEvent;
    app.store.appendEvent = (...args) => {
      if (args[2] === 'member' && (args[3] as any).member.status === 'busy') throw new Error('injected busy event failure');
      return append.apply(app.store, args);
    };
    try { assert.throws(() => app.hub.setPaused(false), /injected busy/); }
    finally { app.store.appendEvent = append; }
    assert.deepEqual(queued().map(({ state, attempts, batchId }) => [state, attempts, batchId]), [
      ['queued', 0, null], ['queued', 0, null],
    ]);
    const runningEvents = () => app.store.listEvents(0).filter((e) => e.kind === 'delivery' && (e.payload as any).delivery.state === 'running');
    assert.equal(runningEvents().length, 0);
    assert.equal(app.native.delivered.length, 0);

    const observed: string[][] = [];
    const failing = app.hub.subscribe((event) => {
      if (event.kind === 'delivery') throw new Error('observer unavailable');
    });
    const healthy = app.hub.subscribe((event) => {
      if (event.kind === 'delivery' && (event.payload as any).delivery.state === 'running') observed.push(queued().map((d) => d.state));
    });
    try {
      app.hub.setPaused(true);
      app.hub.setPaused(false);
      await waitFor(() => queued().every((d) => d.state === 'done'), 'both messages delivered');
      assert.deepEqual(observed, [['running', 'running'], ['running', 'running']]);
      assert.equal(app.native.delivered.length, 1, 'the rollback did not spend the one allowed turn');
      assert.match(app.native.delivered[0].text, /first[\s\S]*second/);
      assert.equal(runningEvents().length, 2);
      assert.deepEqual(queued().map((d) => d.attempts), [1, 1]);
    } finally { healthy(); failing(); }
  } finally { await app.close(); }
});

test('handoff is atomic, routes one recipient, preserves attachments, and is idempotent after a lost response', async () => {
  const app = await startTestHub();
  try {
    app.hub.setPaused(true);
    const { cluster, members: [a, b, c] } = await app.cluster('handoff', ['A', 'B', 'C']);
    const { cluster: other, members: [outside] } = await app.cluster('outside', ['X']);
    const file = { id: randomUUID(), clusterId: cluster.id, uploader: 'user', name: 'request.txt', mime: 'application/octet-stream', size: 1, sha256: 'x', createdAt: new Date().toISOString() };
    app.store.insertFile(file);
    const original = app.hub.sendFromUser(cluster.id, 'original @C request', [a.id], [file.id]);
    const source = app.store.withDeliveries([original])[0].deliveries[0];
    const endpoint = `/api/clusters/${cluster.id}/deliveries/${source.id}/handoff`;
    await assert.rejects(app.api('POST', endpoint, { targetMemberId: b.id }), /not eligible/);
    app.store.setDeliveryState(source.id, 'failed', 'connection lost', 'unknown');
    await assert.rejects(app.api('POST', endpoint, { targetMemberId: b.id }), /confirmStopped/);
    await assert.rejects(app.api('POST', endpoint, { targetMemberId: a.id, confirmStopped: true }), /another active member/);
    await assert.rejects(app.api('POST', endpoint, { targetMemberId: outside.id, confirmStopped: true }), /another active member/);
    await assert.rejects(app.api('POST', `/api/clusters/${other.id}/deliveries/${source.id}/handoff`, { targetMemberId: outside.id, confirmStopped: true }), /unknown delivery/);
    await assert.rejects(app.api('POST', endpoint, { targetMemberId: b.id, note: 'x'.repeat(4001), confirmStopped: true }), /4000/);

    const append = app.store.appendEvent;
    const before = app.store.listEvents(0).length;
    app.store.appendEvent = (...args) => {
      if (args[2] === 'delivery' && (args[3] as any).delivery.handoffMessageId) throw new Error('injected event failure');
      return append.apply(app.store, args);
    };
    try { await assert.rejects(app.api('POST', endpoint, { targetMemberId: b.id, confirmStopped: true }), /injected event failure/); }
    finally { app.store.appendEvent = append; }
    assert.equal(app.store.getDelivery(source.id)!.handoffMessageId, null);
    assert.equal(app.store.listMessages(cluster.id, 100).length, 1);
    assert.equal(app.store.listEvents(0).length, before);

    // Observer failure still leaves a successful response, and retrying a lost response returns that result.
    const unsubscribe = app.hub.subscribe(() => { throw new Error('lost notification'); });
    const created = app.hub.handoffDelivery(cluster.id, source.id, { targetMemberId: b.id, note: '  please review  ', confirmStopped: true });
    unsubscribe();
    const createdId = created.message.id;
    assert.equal(app.store.getDelivery(source.id)!.handoffMessageId, createdId);
    app.hub.removeMember(cluster.id, b.id);
    const repeated = await app.api('POST', endpoint, { targetMemberId: b.id });
    assert.equal(repeated.message.id, createdId);
    assert.equal(repeated.sourceDelivery.handoffMessageId, createdId);
    assert.deepEqual(repeated.message.mentions, [b.id]);
    assert.equal(repeated.message.replyTo, original.id);
    assert.match(repeated.message.body, /original @C request/);
    assert.match(repeated.message.body, /用户补充：\nplease review/);
    assert.equal(app.store.isDirect(createdId), false, 'native recipients also get the envelope');
    assert.deepEqual(app.store.attachmentsOf(createdId).map((f) => f.id), [file.id]);
    assert.deepEqual(app.store.withDeliveries([repeated.message])[0].deliveries.map((d) => d.memberId), [b.id]);
    await assert.rejects(app.api('POST', endpoint, { targetMemberId: c.id, confirmStopped: true }), /already handed off/);
    assert.equal(app.store.listMessages(cluster.id, 100).length, 2);
  } finally { await app.close(); }
});

test('concurrent same-target handoffs create one message; legacy failed requires stop confirmation', async () => {
  const app = await startTestHub();
  try {
    app.hub.setPaused(true);
    const { cluster, members: [a, b] } = await app.cluster('race', ['A', 'B']);
    const message = app.hub.sendFromUser(cluster.id, '@A work');
    const [source] = app.store.withDeliveries([message])[0].deliveries;
    app.store.setDeliveryState(source.id, 'failed', 'old unclassified error');
    const endpoint = `/api/clusters/${cluster.id}/deliveries/${source.id}/handoff`;
    await assert.rejects(app.api('POST', endpoint, { targetMemberId: b.id }), /confirmStopped/);
    const results = await Promise.all(Array.from({ length: 2 }, () => app.api('POST', endpoint, { targetMemberId: b.id, confirmStopped: true })));
    assert.equal(results[0].message.id, results[1].message.id);
    assert.equal(app.store.listMessages(cluster.id, 100).length, 2);
    assert.equal(app.store.withDeliveries([results[0].message])[0].deliveries[0].memberId, b.id);
    assert.notEqual(a.id, b.id);
  } finally { await app.close(); }
});
