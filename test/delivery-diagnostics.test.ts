// Delivery diagnostics: the read-only timeline of one delivery and the user's manual resend (docs/native-mode.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { Delivery, Message } from '../src/core/types.ts';
import type { DeliveryTimeline } from '../src/core/delivery-timeline.ts';
import { rawFetch, startTestHub, tempDir, waitFor } from './helpers.ts';

/** A native mock whose turn result follows the message text; `online` is what its confirmOnline answers. */
async function fixture(name = 'diag', limits: Record<string, number> = {}) {
  const dir = tempDir();
  const sessions = ['a', 'b', 'c'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions });
  const check = { online: true, calls: 0 };
  let release: (() => void) | undefined;
  native.confirmOnline = async () => { check.calls++; return check.online; };
  native.deliver = async (_session, text) => {
    native.delivered.push({ sessionId: _session, text, deliveryId: '' });
    const has = (s: string) => text.includes(s);
    if (has('hold')) { await new Promise<void>((resolve) => { release = resolve; }); return 'completed'; }
    if (has('accept-me')) return 'accepted';
    if (has('fail-me')) return { outcome: 'failed', error: 'turn failed' };
    if (has('unknown-me')) return { outcome: 'unknown', error: 'connection lost' };
    if (has('throw-me')) throw new Error('adapter threw');
    return 'completed';
  };
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, limits: { recheckMs: 600_000, ...limits } });
  const { cluster, members: [a, b, c] } = await app.hub.createCluster(name, ['a', 'b', 'c'].map((sessionId, i) =>
    ({ harness: 'mock', mode: 'native', sessionId, name: 'ABC'[i] })));
  const delivery = (message: Message, memberId = a.id): Delivery => app.store.withDeliveries([message])[0].deliveries.find((d) => d.memberId === memberId)!;
  const ended = (message: Message) => waitFor(() => ['done', 'failed', 'offline', 'superseded'].includes(delivery(message).state), 'delivery end');
  const timeline = async (d: Delivery): Promise<DeliveryTimeline> => app.api('GET', `/api/clusters/${cluster.id}/deliveries/${d.id}/timeline`);
  const resend = (d: Delivery, body: unknown = {}) => app.api('POST', `/api/clusters/${cluster.id}/deliveries/${d.id}/resend`, body);
  const stages = (t: DeliveryTimeline) => Object.fromEntries(t.stages.map((s) => [s.key, s.status]));
  const pauseCluster = (paused: boolean) => app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', paused, operationId: randomUUID() });
  return { app, native, check, cluster, a, b, c, delivery, ended, timeline, resend, stages, pauseCluster, release: () => release?.() };
}

const NOTHING_RESENDABLE = null;

test('timeline: every result a delivery can end with has the right stages and diagnosis', async () => {
  const f = await fixture('terminals');
  const { app, cluster, a, delivery, ended, timeline, stages } = f;
  try {
    for (const [text, diagnosis, accepted, batch] of [
      ['accept-me', 'accepted', 'reached', true], ['completed-me', 'completed', 'reached', true],
      ['fail-me', 'failed', 'unknown', true], ['unknown-me', 'unknown', 'unknown', true], ['throw-me', 'failed', 'unknown', true],
    ] as const) {
      const message = app.hub.sendFromUser(cluster.id, text, [a.id]);
      await ended(message);
      const t = await timeline(delivery(message));
      assert.equal(t.diagnosis, diagnosis, text);
      assert.deepEqual(stages(t), { queued: 'reached', started: 'reached', accepted, acknowledged: 'unknown', ended: 'reached' }, text);
      assert.equal(Boolean(t.batchId), batch, text);
      assert.equal(t.stages[0].at, message.createdAt, 'queued at the message creation');
      assert.ok(t.stages[1].at, `${text}: start time from the running event`);
      assert.equal(t.stages[4].at, app.store.deliveryEventTimes([a.id]).get(t.deliveryId)!.endedAt, `${text}: end time from the terminal event`);
      if (text === 'accept-me') assert.equal(t.stages[2].at, t.stages[4].at, 'accepted as the delivery ended');
      if (text === 'completed-me') assert.equal(t.stages[2].at, null, 'completion proves acceptance but records no time for it');
      if (text === 'fail-me') assert.equal(t.stages[4].reason, 'turn failed');
    }
  } finally { await app.close(); }
});

test('timeline: offline, superseded and the chain limit never started; missing records read as unknown', async () => {
  const f = await fixture('missing');
  const { app, cluster, a, b, check, delivery, ended, timeline, stages } = f;
  try {
    check.online = false;
    const offline = app.hub.sendFromUser(cluster.id, 'offline', [a.id]);
    await ended(offline);
    const off = await timeline(delivery(offline));
    assert.equal(off.diagnosis, 'offline');
    assert.deepEqual(stages(off), { queued: 'reached', started: 'not_reached', accepted: 'not_reached', acknowledged: 'unknown', ended: 'reached' });
    assert.equal(off.stages[4].reason, '成员离线，未投递');
    check.online = true;

    // A superseded notice's row carries the reason; no start.
    app.hub.setPaused(true);
    const superseded = app.hub.sendFromUser(cluster.id, 'old nomination', [a.id]);
    await waitFor(() => check.calls && !delivery(superseded).batchId);
    app.store.setDeliveryState(delivery(superseded).id, 'superseded', '已被取代');
    const sup = await timeline(delivery(superseded));
    assert.equal(sup.diagnosis, 'superseded');
    assert.deepEqual(stages(sup), { queued: 'reached', started: 'not_reached', accepted: 'not_reached', acknowledged: 'unknown', ended: 'reached' });
    assert.equal(sup.resend, NOTHING_RESENDABLE);

    // Done without any start or end event (an older row): the stages say unknown instead of guessing.
    const legacy = app.hub.sendFromUser(cluster.id, 'old row', [a.id]);
    await waitFor(() => check.calls && delivery(legacy).state === 'queued');
    app.store.setDeliveryState(delivery(legacy).id, 'done');
    const old = await timeline(delivery(legacy));
    assert.equal(old.diagnosis, 'done');
    assert.deepEqual(stages(old), { queued: 'reached', started: 'unknown', accepted: 'unknown', acknowledged: 'unknown', ended: 'reached' });
    assert.equal(old.batchId, null);

    // A handoff rewrites updated_at, so an offline row with no terminal event no longer has a known end time.
    const handed = app.hub.sendFromUser(cluster.id, 'no event', [a.id]);
    await waitFor(() => check.calls && delivery(handed).state === 'queued');
    app.store.setDeliveryState(delivery(handed).id, 'offline', '成员离线，未投递');
    app.hub.handoffDelivery(cluster.id, delivery(handed).id, { targetMemberId: b.id });
    const after = await timeline(delivery(handed));
    assert.equal(after.stages[4].status, 'unknown');
    assert.equal(after.stages[4].at, null);
    assert.equal(after.resend, NOTHING_RESENDABLE, 'already handled');
    app.hub.setPaused(false);

    // The chain limit blocks a delivery before it starts.
    const first = app.hub.sendFromUser(cluster.id, 'one turn', [a.id]);
    await ended(first);
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 1 });
    const { message: blocked } = app.hub.sendFromMember(a.id, '@B next', first.id);
    await waitFor(() => delivery(blocked, b.id).state === 'failed');
    const chain = await timeline(delivery(blocked, b.id));
    assert.equal(chain.diagnosis, 'chain_limit');
    assert.deepEqual(stages(chain), { queued: 'reached', started: 'not_reached', accepted: 'not_reached', acknowledged: 'unknown', ended: 'reached' });
    assert.deepEqual(chain.resend, { available: false, blockedBy: 'chain_limit', needsConfirmation: false });
  } finally { await app.close(); }
});

test('timeline: an acknowledgement is its own stage, recorded with its time', async () => {
  const f = await fixture('ack');
  const { app, cluster, a, delivery, ended, timeline, stages } = f;
  try {
    const message = app.hub.sendFromUser(cluster.id, 'see it', [a.id]);
    await ended(message);
    app.hub.ackMessages(a.id, [message.id]);
    const t = await timeline(delivery(message));
    assert.equal(stages(t).acknowledged, 'reached');
    assert.equal(t.stages[3].at, app.store.acknowledgementsOf(message.id)[0].at);
  } finally { await app.close(); }
});

test('timeline: a queued delivery says why it waits: global pause, cluster pause, busy, hourly limit', async () => {
  const f = await fixture('holds', { maxTurnsPerHour: 1 });
  const { app, cluster, a, b, delivery, ended, timeline, pauseCluster, release, stages } = f;
  try {
    app.hub.setPaused(true);
    const paused = app.hub.sendFromUser(cluster.id, 'wait', [a.id]);
    await waitFor(() => f.check.calls);
    assert.equal((await timeline(delivery(paused))).diagnosis, 'paused_global');
    assert.deepEqual(stages(await timeline(delivery(paused))), { queued: 'reached', started: 'pending', accepted: 'pending', acknowledged: 'pending', ended: 'pending' });
    app.hub.setPaused(false);
    await ended(paused);

    pauseCluster(true);
    const inCluster = app.hub.sendFromUser(cluster.id, 'wait 2', [b.id]);
    await waitFor(() => f.check.calls >= 2);
    assert.equal((await timeline(delivery(inCluster, b.id))).diagnosis, 'paused_cluster');
    pauseCluster(false);
    await waitFor(() => delivery(inCluster, b.id).state === 'done');

    // A's only turn of the hour is used up by `paused`, so another message to A is held by the hourly limit.
    const held = app.hub.sendFromUser(cluster.id, 'over the hour', [a.id]);
    await waitFor(async () => (await timeline(delivery(held))).diagnosis === 'hourly_limit', 'hourly limit');
  } finally { release(); await app.close(); }
});

test('timeline: a busy member and a running delivery', async () => {
  const f = await fixture('busy');
  const { app, cluster, a, delivery, timeline, release, stages } = f;
  try {
    const first = app.hub.sendFromUser(cluster.id, 'hold', [a.id]);
    await waitFor(() => delivery(first).state === 'running', 'running');
    const running = await timeline(delivery(first));
    assert.equal(running.diagnosis, 'running');
    assert.deepEqual(stages(running), { queued: 'reached', started: 'reached', accepted: 'pending', acknowledged: 'pending', ended: 'pending' });
    const second = app.hub.sendFromUser(cluster.id, 'behind it', [a.id]);
    await waitFor(async () => (await timeline(delivery(second))).diagnosis === 'busy', 'busy');
  } finally { release(); await app.close(); }
});

test('timeline: one message is one aggregate query, and the delivery must belong to the cluster', async () => {
  const f = await fixture('one-query');
  const { app, cluster, a, b, c, delivery, ended } = f;
  const other = await app.hub.createCluster('other', [{ harness: 'mock', mode: 'native', name: 'X', projectPath: '/work' }]);
  try {
    const message = app.hub.sendFromUser(cluster.id, 'to all', [a.id, b.id, c.id]);
    await ended(message);
    let queries = 0;
    const real = app.store.deliveryEventTimes.bind(app.store);
    app.store.deliveryEventTimes = (ids) => { queries++; assert.equal(ids.length, 3); return real(ids); };
    const { timelines } = await app.api('GET', `/api/clusters/${cluster.id}/messages/${message.id}/delivery-timelines`);
    assert.equal(timelines.length, 3);
    assert.equal(queries, 1, 'not one query per delivery');
    app.store.deliveryEventTimes = real;
    await assert.rejects(app.api('GET', `/api/clusters/${other.cluster.id}/deliveries/${delivery(message).id}/timeline`), /unknown delivery/);
    await assert.rejects(app.api('GET', `/api/clusters/${other.cluster.id}/messages/${message.id}/delivery-timelines`), /unknown message/);
  } finally { await app.close(); }
});

test('resend: only when the member is confirmed online now; offline sends nothing and wakes nothing', async () => {
  const f = await fixture('offline-resend');
  const { app, native, check, cluster, a, delivery, ended, timeline, resend } = f;
  try {
    check.online = false;
    const message = app.hub.sendFromUser(cluster.id, 'missed', [a.id]);
    await ended(message);
    const source = delivery(message);
    assert.equal(source.state, 'offline');
    assert.deepEqual((await timeline(source)).resend, { available: false, blockedBy: 'offline', needsConfirmation: false });

    const before = { delivered: native.delivered.length, messages: app.store.listMessages(cluster.id, 100).length, calls: check.calls };
    await assert.rejects(resend(source), /not confirmed online/);
    assert.equal(check.calls, before.calls + 1, 'asked the adapter, not a cache');
    assert.equal(native.delivered.length, before.delivered);
    assert.equal(app.store.listMessages(cluster.id, 100).length, before.messages);
    assert.deepEqual(delivery(message), source, 'the original is untouched');

    // A check that fails is not a confirmation either, though scheduling treats it as worth a try.
    native.confirmOnline = async () => { throw new Error('check failed'); };
    await assert.rejects(resend(source), /not confirmed online/);
    native.confirmOnline = async () => { check.calls++; return check.online; };

    // Online again, the same delivery can be resent; the page never saw an automatic retry.
    check.online = true;
    assert.equal(native.delivered.length, before.delivered, 'coming online does not resend');
    assert.deepEqual((await timeline(source)).resend, { available: true, needsConfirmation: false });
    const { message: copy, sourceDelivery } = await resend(source);
    await ended(copy);
    assert.deepEqual([delivery(copy).state, native.delivered.at(-1)!.sessionId], ['done', 'a']);
    assert.equal(sourceDelivery.handoffMessageId, copy.id);
  } finally { await app.close(); }
});

test('resend: an adapter without confirmOnline is asked through isOnline', async () => {
  const dir = tempDir();
  const native = createMockNativeAdapter({ kind: 'bridge', sessions: [{ id: 's', title: 's', model: null, cwd: dir, updatedAt: null }] });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    const { cluster, members: [m] } = await app.hub.createCluster('bridged', [{ harness: 'mock', mode: 'native', sessionId: 's', name: 'A' }]);
    const message = app.hub.sendFromUser(cluster.id, 'nobody home', [m.id]);
    const [source] = app.store.withDeliveries([message])[0].deliveries;
    assert.equal(source.state, 'offline', 'no bridge connected');
    await assert.rejects(app.api('POST', `/api/clusters/${cluster.id}/deliveries/${source.id}/resend`, {}), /not confirmed online/);
    assert.equal(native.delivered.length, 0);
  } finally { await app.close(); }
});

test('resend: a new message quotes the original on its chain; the original keeps its result and links to it', async () => {
  const f = await fixture('quote');
  const { app, cluster, a, b, delivery, ended, resend, timeline } = f;
  try {
    const file = { id: randomUUID(), clusterId: cluster.id, uploader: 'user', name: 'request.txt', mime: 'application/octet-stream', size: 1, sha256: 'x', createdAt: new Date().toISOString() };
    app.store.insertFile(file);
    const message = app.hub.sendFromUser(cluster.id, 'fail-me please', [a.id], [file.id]);
    await ended(message);
    const source = delivery(message);
    const { message: copy, sourceDelivery } = await resend(source);
    assert.deepEqual(copy.mentions, [a.id]);
    assert.equal(copy.from, 'user');
    assert.equal(copy.replyTo, message.id);
    assert.equal(copy.chainId, message.chainId, 'the loop limits keep counting it');
    assert.equal(copy.hop, message.hop);
    assert.match(copy.body, /用户重发/);
    assert.match(copy.body, /fail-me please/);
    assert.match(copy.body, /原因：turn failed/);
    assert.deepEqual(app.store.attachmentsOf(copy.id).map((x) => x.id), [file.id]);
    assert.equal(app.store.isDirect(copy.id), false);
    for (const k of ['state', 'outcome', 'error', 'batchId', 'id', 'messageId', 'memberId'] as const) assert.equal(sourceDelivery[k], source[k], k);
    assert.equal(sourceDelivery.handoffMessageId, copy.id);
    assert.deepEqual(app.events.filter((e) => e.kind === 'delivery' && (e.payload as any).delivery.handoffMessageId === copy.id).map((e) => e.memberId), [a.id], 'recorded as a delivery event');
    assert.equal((await timeline(delivery(message))).resend, NOTHING_RESENDABLE);
    await assert.rejects(app.api('POST', `/api/clusters/${cluster.id}/deliveries/${source.id}/handoff`, { targetMemberId: b.id }), /already handed off/);

    // A retry after a lost response finds the same message, and nothing new is created.
    const count = app.store.listMessages(cluster.id, 100).length;
    assert.equal((await resend(source)).message.id, copy.id);
    assert.equal(app.store.listMessages(cluster.id, 100).length, count);
  } finally { await app.close(); }
});

test('resend: concurrent requests create one message', async () => {
  const f = await fixture('race');
  const { app, cluster, a, delivery, ended, resend } = f;
  try {
    const message = app.hub.sendFromUser(cluster.id, 'fail-me', [a.id]);
    await ended(message);
    const results = await Promise.all([resend(delivery(message)), resend(delivery(message)), resend(delivery(message))]);
    assert.equal(new Set(results.map((r) => r.message.id)).size, 1);
    assert.equal(app.store.listMessages(cluster.id, 100).length, 2);
  } finally { await app.close(); }
});

test('resend: a result that may have run needs an explicit confirmation of possible duplication', async () => {
  const f = await fixture('confirm');
  const { app, cluster, a, delivery, ended, resend, timeline } = f;
  try {
    const unknown = app.hub.sendFromUser(cluster.id, 'unknown-me', [a.id]);
    await ended(unknown);
    assert.equal((await timeline(delivery(unknown))).resend!.needsConfirmation, true);
    await assert.rejects(resend(delivery(unknown)), /confirmDuplicate/);
    await assert.rejects(resend(delivery(unknown), { confirmDuplicate: 'yes' }), /must be a boolean/);
    const { message } = await resend(delivery(unknown), { confirmDuplicate: true });
    assert.match(message.body, /可能已经执行过/);

    // An adapter failure with no outcome after the delivery started may have reached the app; a plain failure may not.
    const thrown = app.hub.sendFromUser(cluster.id, 'throw-me', [a.id]);
    await ended(thrown);
    assert.equal((await timeline(delivery(thrown))).resend!.needsConfirmation, true);
    const failed = app.hub.sendFromUser(cluster.id, 'fail-me', [a.id]);
    await ended(failed);
    assert.equal((await timeline(delivery(failed))).resend!.needsConfirmation, false);
  } finally { await app.close(); }
});

test('resend: a missing batch id alone does not prove the delivery never started', async () => {
  const f = await fixture('no-batch');
  const { app, cluster, a, b, delivery, ended, resend, timeline, stages } = f;
  const setRow = (d: Delivery, column: 'batch_id' | 'attempts', value: number | null) =>
    app.store.db.prepare(`UPDATE deliveries SET ${column} = ? WHERE id = ?`).run(value, d.id);
  try {
    // An old row: it ran (one attempt, a running event) but predates batch ids.
    const thrown = app.hub.sendFromUser(cluster.id, 'throw-me', [a.id]);
    await ended(thrown);
    assert.equal(delivery(thrown).outcome, null);
    setRow(delivery(thrown), 'batch_id', null);
    const old = await timeline(delivery(thrown));
    assert.equal(old.batchId, null);
    assert.deepEqual([stages(old).started, stages(old).accepted, old.resend!.needsConfirmation], ['reached', 'unknown', true]);
    const count = app.store.listMessages(cluster.id, 100).length;
    await assert.rejects(resend(delivery(thrown), {}), /confirmDuplicate/);
    assert.equal(app.store.listMessages(cluster.id, 100).length, count, 'refused: nothing was sent');
    assert.equal(delivery(thrown).handoffMessageId, null);
    const { message: copy } = await resend(delivery(thrown), { confirmDuplicate: true });
    assert.equal(delivery(thrown).handoffMessageId, copy.id);
    await ended(copy);

    // A running event is evidence on its own, whatever the row's counters say.
    const contradictory = app.hub.sendFromUser(cluster.id, 'throw-me too', [a.id]);
    await ended(contradictory);
    setRow(delivery(contradictory), 'batch_id', null);
    setRow(delivery(contradictory), 'attempts', 0);
    assert.equal((await timeline(delivery(contradictory))).resend!.needsConfirmation, true);

    // Truly never started: stopped by the chain limit, so no attempt, no batch and no running event.
    const first = app.hub.sendFromUser(cluster.id, 'one turn', [a.id]);
    await ended(first);
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 1 });
    const { message: blocked } = app.hub.sendFromMember(a.id, '@B next', first.id);
    await waitFor(() => delivery(blocked, b.id).state === 'failed');
    const never = await timeline(delivery(blocked, b.id));
    assert.equal(never.batchId, null);
    assert.deepEqual([stages(never).started, stages(never).accepted, never.resend!.needsConfirmation], ['not_reached', 'not_reached', false]);

    // An attempt with no other record (the migration's back-fill) is not proof either way: no conclusion, and ask.
    setRow(delivery(blocked, b.id), 'attempts', 1);
    const backfilled = await timeline(delivery(blocked, b.id));
    assert.deepEqual([stages(backfilled).started, stages(backfilled).accepted, backfilled.resend!.needsConfirmation], ['unknown', 'unknown', true]);
    setRow(delivery(blocked, b.id), 'attempts', 0);

    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 20 });
    const { message: resent } = await resend(delivery(blocked, b.id), {});
    assert.equal(delivery(blocked, b.id).handoffMessageId, resent.id);
  } finally { await app.close(); }
});

test('resend: refused for what is not a problem, for a removed member, and outside the cluster', async () => {
  const f = await fixture('refused');
  const { app, cluster, a, b, delivery, ended, resend } = f;
  try {
    const fine = app.hub.sendFromUser(cluster.id, 'fine', [a.id]);
    await ended(fine);
    await assert.rejects(resend(delivery(fine)), /not eligible/);

    app.hub.setPaused(true);
    const queued = app.hub.sendFromUser(cluster.id, 'queued', [a.id]);
    await assert.rejects(resend(delivery(queued)), /not eligible/);
    app.store.setDeliveryState(delivery(queued).id, 'superseded', 'replaced');
    await assert.rejects(resend(delivery(queued)), /not eligible/);
    app.hub.setPaused(false);

    const failed = app.hub.sendFromUser(cluster.id, 'fail-me', [b.id]);
    await waitFor(() => delivery(failed, b.id).state === 'failed');
    const source = delivery(failed, b.id);
    const other = await app.hub.createCluster('outsider', [{ harness: 'mock', mode: 'native', name: 'X', projectPath: '/work' }]);
    await assert.rejects(app.api('POST', `/api/clusters/${other.cluster.id}/deliveries/${source.id}/resend`, {}), /unknown delivery/);
    app.hub.removeMember(cluster.id, b.id);
    await assert.rejects(resend(source), /removed/);
    assert.deepEqual((await f.timeline(source)).resend, { available: false, blockedBy: 'removed', needsConfirmation: false });
  } finally { await app.close(); }
});

test('resend: the loop limits apply, and no delivery is created when they refuse it', async () => {
  const f = await fixture('limits');
  const { app, cluster, a, delivery, ended, resend, timeline } = f;
  try {
    const message = app.hub.sendFromUser(cluster.id, 'fail-me', [a.id]);
    await ended(message);
    const source = delivery(message);
    const count = () => app.store.listMessages(cluster.id, 100).length;
    const guards = () => app.events.filter((e) => e.kind === 'guard').map((e) => (e.payload as any).reason);

    // The failed attempt used the chain's only allowed turn: resending would be turn 2 of 1.
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 1 });
    const before = count();
    assert.deepEqual((await timeline(source)).resend, { available: false, blockedBy: 'chain_limit', needsConfirmation: false });
    await assert.rejects(resend(source), /turn limit/);
    assert.equal(count(), before);
    assert.deepEqual(guards(), ['max_turns_per_chain']);
    assert.equal(delivery(message).handoffMessageId, null);
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 20 });

    // A chain that has run past a limit lowered since cannot be pushed further by the user's button either.
    const { message: failing } = app.hub.sendFromMember(a.id, '@B fail-me', message.id);
    await waitFor(() => delivery(failing, f.b.id).state === 'failed');
    app.hub.setLimit('maxHops', { kind: 'finite', value: 0 });
    assert.equal(failing.hop, 1);
    assert.deepEqual((await timeline(delivery(failing, f.b.id))).resend, { available: false, blockedBy: 'hop_limit', needsConfirmation: false });
    const beforeHop = count();
    await assert.rejects(resend(delivery(failing, f.b.id)), /exceeds the limit/);
    assert.equal(count(), beforeHop);
    assert.ok(guards().includes('max_hops'));
  } finally { await app.close(); }
});

test('resend: the copy waits behind the hourly limit and the pause like any other message', async () => {
  const f = await fixture('hourly', { maxTurnsPerHour: 1 });
  const { app, native, cluster, a, delivery, ended, resend, timeline } = f;
  try {
    const message = app.hub.sendFromUser(cluster.id, 'fail-me', [a.id]);
    await ended(message);
    const before = native.delivered.length;
    const { message: copy } = await resend(delivery(message));
    await waitFor(async () => (await timeline(delivery(copy))).diagnosis === 'hourly_limit', 'held by the hourly limit');
    assert.equal(delivery(copy).state, 'queued');
    assert.equal(native.delivered.length, before);
    app.hub.setPaused(true);
    assert.equal((await timeline(delivery(copy))).diagnosis, 'paused_global');
  } finally { await app.close(); }
});

test('resend: a member cannot call it: no API token, no MCP tool', async () => {
  const f = await fixture('members-cannot');
  const { app, cluster, a, delivery, ended } = f;
  try {
    const message = app.hub.sendFromUser(cluster.id, 'fail-me', [a.id]);
    await ended(message);
    const url = `${app.url}/api/clusters/${cluster.id}/deliveries/${delivery(message).id}/resend`;
    const post = (headers: Record<string, string>) => rawFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await post({})).status, 401);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    assert.equal((await post({ 'x-orrery-bridge': secret })).status, 401, 'the bridge secret is not the API token');
    assert.equal((await post({ 'x-orrery-bridge': secret, 'x-orrery-harness': a.harness, 'x-orrery-session': a.workerSessionId })).status, 401,
      'nor is a member\'s own bridge identity');
    assert.equal(delivery(message).handoffMessageId, null);

    const listed = await rawFetch(`${app.url}/mcp`, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    assert.ok(names.includes('get_deliveries'), 'the list is the real one');
    assert.equal(names.filter((n) => /resend|retry|redeliver/i.test(n)).length, 0);
  } finally { await app.close(); }
});
