// Members see what became of their own messages (docs/native-mode.md「投递结果」): per-recipient `deliveries` on their own
// messages in read_messages, and a notice in their next envelope for each recipient a message did not reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

/** One MCP tools/call as native member session `session` of harness mock. */
async function call(app: TestHub, session: string, name: string, args: Record<string, unknown>, error?: RegExp) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-orrery-bridge': secret, 'x-orrery-session': session, 'x-orrery-harness': 'mock',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const { result } = await res.json();
  if (error) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, error);
    return;
  }
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

/**
 * Native mock members A (s1), B (s2, offline), C (s3, its deliveries fail), D (s4); K (k1) answers every delivery
 * (a `replies` harness like Kimi). `failA`: A's next delivery fails.
 */
async function setup() {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3', 's4', 'k1'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const state = { failA: false };
  const native = createMockNativeAdapter({
    sessions,
    onDeliver: async (sessionId) => {
      if (sessionId === 's3') throw new Error('boom: the app refused it');
      if (sessionId === 's1' && state.failA) { state.failA = false; throw new Error('A failed once'); }
      return 'completed';
    },
  });
  native.isOnline = (sessionId) => sessionId !== 's2';
  const kimi = Object.assign(createMockNativeAdapter({
    harness: 'kmock', sessions,
    onDeliver: async (_s, _t, ctx) => { ctx.reply!('@A my answer'); return 'completed'; },
  }), { replies: true });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native, kmock: kimi } });
  const { cluster, members } = await app.api('POST', '/api/clusters', {
    name: 'status', members: [
      ...['A', 'B', 'C', 'D'].map((name, i) => ({ harness: 'mock', mode: 'native', sessionId: `s${i + 1}`, name })),
      { harness: 'kmock', mode: 'native', sessionId: 'k1', name: 'K' },
    ],
  });
  const send = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
  return { app, cluster, members, native, kimi, state, send };
}

test('delivery status: read_messages shows per-recipient outcomes on the caller’s own messages only', async () => {
  const { app, cluster, native } = await setup();
  try {
    const sent = await call(app, 's1', 'send_message', { body: '@B @C @D hello' });
    assert.deepEqual(sent.deliveredTo, ['B', 'C', 'D'], 'queued for, not delivered to');
    await waitFor(() => app.settled(cluster.id), 'settled');
    // The per-chain turn limit at 0: the next message's delivery is stopped by the guard.
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 0 });
    const blocked = await call(app, 's4', 'send_message', { body: '@A blocked' });
    await waitFor(() => app.settled(cluster.id), 'settled');

    const mine = (await call(app, 's1', 'read_messages', { history: true, detail: 'full' })).find((m: any) => m.id === sent.messageId);
    assert.deepEqual(mine.deliveries, [
      { to: 'B', status: 'offline', outcome: null },
      { to: 'C', status: 'failed', outcome: null, reason: 'boom: the app refused it' },
      { to: 'D', status: 'done', outcome: 'completed' },
    ]);
    // By default the history keeps a done delivery short; the others keep their outcome and reason.
    const short = (await call(app, 's1', 'read_messages', { history: true })).find((m: any) => m.id === sent.messageId);
    assert.deepEqual(short.deliveries, [
      { to: 'B', status: 'offline', outcome: null },
      { to: 'C', status: 'failed', outcome: null, reason: 'boom: the app refused it' },
      { to: 'D', status: 'done' },
    ]);
    const fromD = await call(app, 's4', 'read_messages', { history: true });
    assert.deepEqual(fromD.find((m: any) => m.id === blocked.messageId).deliveries, [{ to: 'A', status: 'blocked', outcome: null, reason: '链轮次超限' }]);
    assert.equal(fromD.find((m: any) => m.id === sent.messageId).deliveries, undefined, 'not on someone else’s message');
    assert.equal(native.delivered.filter((d) => d.sessionId === 's2').length, 0, 'the offline member got nothing');
  } finally {
    await app.close();
  }
});

test('delivery status: the next envelope names each recipient a message did not reach, once, and only once delivered', async () => {
  const { app, cluster, native, state, send } = await setup();
  const toA = () => native.delivered.filter((d) => d.sessionId === 's1').map((d) => d.text);
  let releaseHold!: () => void;
  const holdA = new Promise<void>((r) => { releaseHold = r; });
  const origDeliver = native.deliver.bind(native);
  let holding = true;
  let holdStarted = false;
  native.deliver = async (sessionId, text, ctx) => {
    if (sessionId === 's1' && holding) { holding = false; holdStarted = true; await holdA; }
    return origDeliver(sessionId, text, ctx);
  };
  try {
    // Keep A busy in an inflight turn so these failures stay in the envelope queue rather than waking A proactively.
    await send('@A hold');
    await waitFor(() => holdStarted, 'hold delivery to A');
    const first = await call(app, 's1', 'send_message', { body: '@B @C @D hello\nworld' });
    await waitFor(() => app.hub.deliveryOutcomes(first.messageId).every((d) => ['offline', 'failed', 'done'].includes(d.status)));
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 0 });
    const blocked = await call(app, 's1', 'send_message', { body: '@D blocked' });
    await waitFor(() => app.hub.deliveryOutcomes(blocked.messageId).every((d) => d.status === 'blocked'));
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 20 });
    releaseHold();
    await waitFor(() => app.settled(cluster.id), 'settled');

    // A's delivery fails: the notice it carried is not counted as told.
    state.failA = true;
    await send('@A one');
    await waitFor(() => toA().length === 2, 'first delivery to A');
    await waitFor(() => app.settled(cluster.id), 'settled');
    await send('@A two');
    await waitFor(() => toA().length === 3, 'second delivery to A');
    await waitFor(() => app.settled(cluster.id), 'settled');
    for (const text of toA().slice(1)) {
      assert.ok(text.includes(`你之前发的消息「@B @C @D hello world」（messageId ${first.messageId}）的投递结果：B（离线，未投递）、C（投递流程失败：boom: the app refused it）。`), text);
      assert.ok(text.includes(`你之前发的消息「@D blocked」（messageId ${blocked.messageId}）的投递结果：D（被拦下：链轮次超限）。`), text);
      assert.ok(text.includes('这些投递不会自动重发。'), text);
      const details = [...text.matchAll(/投递详情：(\{[^\n]+\})/g)].map((m) => JSON.parse(m[1]));
      assert.deepEqual(details.map((d) => [d.to, d.status, d.outcome]),
        [['B', 'offline', 'unknown'], ['C', 'failed', 'unknown'], ['D', 'blocked', 'unknown']]);
      assert.ok(details.every((d) => d.messageId.length === 36 && d.reason && d.queuedAt && d.endedAt));
      assert.equal(details[0].startedAt, undefined);
      assert.ok(details[1].startedAt);
      assert.equal(details[2].startedAt, undefined);
    }
    // Told once it was delivered: the next envelope says nothing more.
    await send('@A three');
    await waitFor(() => toA().length === 4, 'third delivery to A');
    assert.ok(!toA()[3].includes('的投递结果：'), toA()[3]);
  } finally {
    releaseHold();
    await app.close();
  }
});

test('get_deliveries: own messages or current authorized coordinator, without read or queue effects', async () => {
  const { app, cluster, members: [a, b, c, d] } = await setup();
  try {
    app.hub.setPaused(true);
    const sent = await call(app, 's1', 'send_message', { body: '@D waiting' });
    const args = { messageId: sent.messageId };
    const snapshot = () => JSON.stringify(['deliveries', 'reads', 'message_acknowledgements', 'events'].map((table) =>
      app.store.db.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    assert.deepEqual(await call(app, 's1', 'get_deliveries', args), {
      fyi: false,
      deliveries: [{ to: 'D', status: 'queued', outcome: 'unknown',
        queuedAt: app.store.getMessage(sent.messageId)!.createdAt }],
    });
    await call(app, 's4', 'get_deliveries', args, /^FORBIDDEN:/);
    assert.equal(snapshot(), before, 'query does not write deliveries, reads, acknowledgements or events');
    let operation = 0;
    const policy = (memberId: string, enabled: boolean, mode: 'suggest' | 'execute', permission: boolean) =>
      app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'coordinator.set', operationId: `detail-${++operation}`,
        memberId, enabled, mode, permissions: { deliveryControl: permission } });
    policy(c.id, true, 'execute', true);
    assert.equal((await call(app, 's3', 'get_deliveries', args)).deliveries[0].status, 'queued');
    policy(c.id, true, 'suggest', true);
    const suggestBefore = snapshot();
    assert.equal((await call(app, 's3', 'get_deliveries', args)).deliveries[0].outcome, 'unknown');
    assert.equal(snapshot(), suggestBefore);
    policy(c.id, true, 'execute', false);
    await call(app, 's3', 'get_deliveries', args, /^FORBIDDEN:/);
    policy(c.id, false, 'execute', true);
    await call(app, 's3', 'get_deliveries', args, /^FORBIDDEN:/);
    policy(b.id, true, 'execute', true);
    await call(app, 's3', 'get_deliveries', args, /^FORBIDDEN:/);
    const other = await app.hub.createCluster('outside', [{ harness: 'mock', mode: 'native', sessionId: 's4', name: 'outside' }]);
    const foreign = app.hub.sendFromUser(other.cluster.id, 'outside message');
    await call(app, 's2', 'get_deliveries', { messageId: foreign.id }, /^FORBIDDEN:/);
    await call(app, 's2', 'get_deliveries', { clusterId: other.cluster.id, messageId: foreign.id }, /请选择 clusterId/);
    await call(app, 's2', 'get_deliveries', { messageId: 'missing' }, /^FORBIDDEN:/);
    assert.equal((await call(app, 's1', 'get_deliveries', args)).deliveries[0].status, 'queued', 'sender needs no coordinator permission');
    assert.ok(a.id !== d.id);
  } finally { await app.close(); }
});

test('get_deliveries: recorded timestamp provenance, missing evidence and handoff updates', async () => {
  const { app, cluster, members: [a, , , d] } = await setup();
  try {
    const sent = await call(app, 's1', 'send_message', { body: '@B @C @D evidence' });
    await waitFor(() => app.settled(cluster.id));
    const message = app.store.getMessage(sent.messageId)!;
    const deliveries = app.store.withDeliveries([message])[0].deliveries;
    const report = await call(app, 's1', 'get_deliveries', { messageId: message.id });
    assert.equal(report.fyi, false);
    const details = report.deliveries;
    for (let i = 0; i < details.length; i++) {
      const detail = details[i]; const delivery = deliveries[i];
      const running = app.store.listEvents(0, delivery.memberId, ['delivery'])
        .find((event) => (event.payload as any).delivery.id === delivery.id && (event.payload as any).delivery.state === 'running');
      assert.equal(detail.queuedAt, message.createdAt);
      assert.equal(detail.startedAt, (running?.payload as any)?.delivery.updatedAt);
      assert.equal(detail.endedAt, delivery.updatedAt);
    }
    assert.equal(details[0].reason, '成员离线，未投递');
    assert.equal(details[0].outcome, 'unknown');
    assert.equal(details[2].outcome, 'completed');
    app.hub.setPaused(true);
    const failed = deliveries[1];
    app.hub.handoffDelivery(cluster.id, failed.id, { targetMemberId: d.id, confirmStopped: true });
    app.store.db.prepare('UPDATE deliveries SET updated_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', failed.id);
    assert.equal(app.hub.getDeliveries(a.id, message.id).deliveries[1].endedAt, failed.updatedAt, 'handoff cannot move the end time');
    const offline = deliveries[0];
    app.hub.handoffDelivery(cluster.id, offline.id, { targetMemberId: d.id });
    assert.equal(app.hub.getDeliveries(a.id, message.id).deliveries[0].endedAt, undefined, 'old offline creation without a terminal event cannot recover its pre-handoff time');
    app.store.db.prepare("DELETE FROM events WHERE member_id = ? AND kind = 'delivery'").run(d.id);
    assert.equal(app.hub.getDeliveries(a.id, message.id).deliveries[2].startedAt, undefined, 'missing start event is never guessed');
    assert.equal(app.hub.getDeliveries(a.id, message.id).deliveries[2].endedAt, deliveries[2].updatedAt);
    const legacy = app.hub.sendFromMember(a.id, '@D legacy').message;
    const legacyDelivery = app.store.withDeliveries([legacy])[0].deliveries[0];
    app.store.setDeliveryState(legacyDelivery.id, 'done');
    assert.equal(app.hub.getDeliveries(a.id, legacy.id).deliveries[0].outcome, 'unknown');
    assert.equal(app.hub.deliveryOutcomes(legacy.id)[0].outcome, null, 'read_messages retains its legacy null');
  } finally { await app.close(); }
});

test('coordinator notices include failed, offline and chain-blocked details without recursion', async () => {
  const { app, cluster, members: [, , , coordinator] } = await setup();
  try {
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'coordinator.set', operationId: 'notices',
      memberId: coordinator.id, enabled: true, mode: 'execute', permissions: { deliveryControl: true } });
    await waitFor(() => app.settled(cluster.id));
    const failed = await call(app, 's1', 'send_message', { body: '@B @C fail' });
    await waitFor(() => app.settled(cluster.id));
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 0 });
    const blocked = await call(app, 's1', 'send_message', { body: '@C blocked' });
    await waitFor(() => app.settled(cluster.id));
    const notices = app.store.listMessages(cluster.id, 100).filter((m) => m.kind === 'system' && m.body.startsWith('投递失败或离线：'));
    assert.equal(notices.length, 3, 'blocked notification delivery creates no recursive failure notice');
    const details = notices.map((m) => JSON.parse(m.body.split('投递详情：')[1]));
    assert.deepEqual(details.map((detail) => [detail.messageId, detail.to, detail.status]),
      [[failed.messageId, 'B', 'offline'], [failed.messageId, 'C', 'failed'], [blocked.messageId, 'C', 'blocked']]);
    for (const notice of notices) assert.deepEqual(notice.mentions, [coordinator.id]);
    assert.ok(details.every((detail) => detail.reason && detail.outcome === 'unknown' && detail.queuedAt && detail.endedAt));
    assert.equal(details[2].startedAt, undefined);
    const original = app.store.withDeliveries([app.store.getMessage(blocked.messageId)!])[0];
    assert.equal(original.deliveries.length, 1);
    assert.equal(original.deliveries[0].state, 'failed');
  } finally { await app.close(); }
});

test('chain-blocked notice: a throwing listener cannot escape the microtask or prevent delivery', async () => {
  const { app, cluster, native, members: [, , , coordinator] } = await setup();
  let stop = () => {};
  try {
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'coordinator.set', operationId: 'throwing-notice',
      memberId: coordinator.id, enabled: true, mode: 'execute' });
    await waitFor(() => app.settled(cluster.id));
    // The failure must affect an open task to wake the coordinator; a taskless failure only counts unread.
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id,
      { action: 'task.create', operationId: 'throwing-task', title: 'blocked work', scope: 's', acceptance: 'a' }).task!;
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 0 });
    const published: string[] = [];
    stop = app.hub.subscribe((event) => {
      if (event.kind !== 'message') return;
      const message = (event.payload as any).message;
      if (message.kind !== 'system' || !message.body.startsWith('投递失败或离线：')) return;
      published.push(message.id);
      assert.ok(app.store.getMessage(message.id), 'notification is committed before listeners run');
      // Permit the already queued notice to run; this only changes limits and does not schedule deliveries.
      app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 20 });
      throw new Error('notice listener failed after commit');
    });
    const blocked = await call(app, 's1', 'send_message', { body: '@C blocked with throwing listener', taskIds: [task.id] });
    await waitFor(() => published.length === 1 && app.store.withDeliveries([app.store.getMessage(published[0])!])[0]
      .deliveries.every((d) => d.state === 'done'), 'committed notice is still scheduled');
    assert.ok(native.delivered.some((d) => d.sessionId === 's4' && d.text.includes(blocked.messageId)));
    assert.equal(app.hub.deliveryOutcomes(blocked.messageId)[0].status, 'blocked', 'original delivery is never retried');
    assert.equal(published.length, 1);
  } finally { stop(); await app.close(); }
});

test('delivery status: an unknown result tells the sender it may still execute', async () => {
  const { app, cluster, native, send } = await setup();
  const deliver = native.deliver.bind(native);
  native.deliver = async (session, text, ctx) => session === 's3' ? { outcome: 'unknown', error: 'bridge ack timed out' } : deliver(session, text, ctx);
  try {
    await call(app, 's1', 'send_message', { body: '@C please act' });
    await waitFor(() => app.settled(cluster.id));
    await send('@A next');
    await waitFor(() => native.delivered.some((d) => d.sessionId === 's1'));
    const text = native.delivered.find((d) => d.sessionId === 's1')!.text;
    assert.match(text, /结果未知，可能已送达或仍会执行：bridge ack timed out/);
    assert.doesNotMatch(text, /没有送到/);
  } finally { await app.close(); }
});

test('delivery status: a replies member (Kimi) is told when its answer was not posted', async () => {
  const { app, cluster, kimi, send } = await setup();
  const toK = () => kimi.delivered.map((d) => d.text);
  try {
    app.hub.setLimit('maxHops', { kind: 'finite', value: 0 });   // K's answer to a user message would be hop 1
    await send('@K first');
    await waitFor(() => app.settled(cluster.id), 'settled');
    assert.ok(!toK()[0].includes('没有发到群里'));
    app.hub.setLimit('maxHops', { kind: 'finite', value: 6 });
    await send('@K second');
    await waitFor(() => toK().length === 2, 'second delivery');
    assert.match(toK()[1], /你上一轮的回答没有发到群里：rejected: hop 1 exceeds the limit of 0/);
    await waitFor(() => app.settled(cluster.id), 'settled');
    await send('@K third');
    await waitFor(() => toK().length === 3, 'third delivery');
    assert.ok(!toK()[2].includes('没有发到群里'), 'told once');
    assert.ok(!toK()[2].includes('没有送到'), 'its answers this time reached A');
  } finally {
    await app.close();
  }
});
