// Offline native members (docs/native-mode.md「离线」): a delivery due while the member is offline ends 'offline' and is
// never sent later; the message stays unread for it. Start-up grace, confirmOnline, and what 'offline' does not count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Hub, type Limits } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { parseEnvelopes } from './mock.ts';
import { createMockNativeAdapter, type MockNativeOptions } from '../src/adapters/mock/native.ts';
import type { BridgeConnection } from '../src/core/hub.ts';
import { registries } from '../src/adapters/index.ts';
import { tempDir, waitFor } from './helpers.ts';

const OFFLINE = { state: 'offline', error: '成员离线，未投递' };

/**
 * An in-process Hub with mock members A (session s1) and B (s2), and I of another harness that is always online.
 * `online` decides whether A and B are online (kind 'queue'); kind 'bridge' follows the Hub's bridges instead.
 */
async function offlineHub(opts: { store?: Store; dir?: string; native?: MockNativeOptions; limits?: Partial<Limits> } = {}) {
  const dir = opts.dir ?? tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions, ...opts.native });
  const state = { online: false };
  if ((opts.native?.kind ?? 'queue') === 'queue') native.isOnline = () => state.online;
  const store = opts.store ?? new Store(':memory:');
  const hub = new Hub({
    store, nativeAdapters: { mock: native, other: createMockNativeAdapter({ harness: 'other' }) },
    limits: { startupGraceMs: 0, ...opts.limits },
  });
  hub.start();
  return { dir, native, store, hub, state };
}

const cluster = (hub: Hub) => hub.createCluster('c', [
  { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }, { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
  { harness: 'other', mode: 'native', name: 'I', projectPath: '/work' },
]);
const deliveryOf = (store: Store, messageId: string, memberId: string) =>
  store.withDeliveries([store.getMessage(messageId)!])[0].deliveries.find((d) => d.memberId === memberId)!;
const attempts = (store: Store, deliveryId: string) =>
  (store.db.prepare('SELECT attempts FROM deliveries WHERE id = ?').get(deliveryId) as { attempts: number }).attempts;
const pick = ({ state, error }: { state: string; error: string | null }) => ({ state, error });
const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));
/** A bridge stream that acks every push at once (or never, with `ack` false). */
const conn = (hub: Hub, ack = true): BridgeConnection => ({
  send: (e) => { if (ack) setImmediate(() => hub.ackBridge(e.deliveryId, true)); },
  close: () => {},
});

test('offline: a message for an offline member ends "offline" at once, stays unread, and is never sent later', async () => {
  const { hub, store, native, state } = await offlineHub();
  try {
    const { cluster: c, members: [a, , i] } = await cluster(hub);
    const m = hub.sendFromUser(c.id, '@A @I hi');
    assert.deepEqual(pick(deliveryOf(store, m.id, a.id)), OFFLINE, 'decided when posted');
    assert.equal(attempts(store, deliveryOf(store, m.id, a.id).id), 0, 'not a chain turn');
    assert.equal((hub as any).turnStarts.get(a.id), undefined, 'not an hourly turn');
    await waitFor(() => deliveryOf(store, m.id, i.id).state === 'done', 'a member of another harness is unaffected');

    // Posted while paused: still decided at once, so unpausing once the member is back sends nothing.
    hub.setPaused(true);
    const p = hub.sendFromUser(c.id, '@A paused');
    assert.deepEqual(pick(deliveryOf(store, p.id, a.id)), OFFLINE);
    state.online = true;
    hub.setPaused(false);
    hub.connectBridge('mock', 's1', conn(hub));   // a bridge connecting schedules the member too
    await tick(20);
    assert.equal(native.delivered.length, 0, 'nothing posted while offline is sent later');

    // The next delivery counts both as unread; read_messages returns them.
    const n = hub.sendFromUser(c.id, '@A next');
    await waitFor(() => deliveryOf(store, n.id, a.id).state === 'done', 'delivered while online');
    assert.equal(native.delivered.length, 1);
    assert.deepEqual(parseEnvelopes(native.delivered[0].text).map((e) => e.body), ['@A next']);
    assert.match(native.delivered[0].text, /群里还有未读 2：点名你 2（离线 2），可用 read_messages 查看。/);
    assert.deepEqual(hub.readMessages(a.id).map((x) => x.body), ['@A @I hi', '@A paused']);
  } finally {
    await hub.close();
  }
});

test('offline: a busy member that goes offline gets none of its queued messages when the running one finishes', async () => {
  const gate = Promise.withResolvers<'completed'>();
  const { hub, store, native, state } = await offlineHub({ native: { onDeliver: () => gate.promise } });
  state.online = true;
  try {
    const { cluster: c, members: [a] } = await cluster(hub);
    const first = hub.sendFromUser(c.id, '@A one');
    await waitFor(() => deliveryOf(store, first.id, a.id).state === 'running', 'running');
    const queued = [hub.sendFromUser(c.id, '@A two'), hub.sendFromUser(c.id, '@A three')];
    assert.deepEqual(queued.map((m) => deliveryOf(store, m.id, a.id).state), ['queued', 'queued'], 'online but busy: they wait');
    state.online = false;
    gate.resolve('completed');
    await waitFor(() => deliveryOf(store, first.id, a.id).state === 'done', 'first done');
    assert.deepEqual(queued.map((m) => pick(deliveryOf(store, m.id, a.id))), [OFFLINE, OFFLINE]);
    assert.equal(native.delivered.length, 1);
  } finally {
    await hub.close();
  }
});

test('offline: deliver answering "offline" ends the whole batch offline, gives the turn back, and never retries', async () => {
  let answer: 'offline' | 'completed' = 'offline';
  const { hub, store, native, state } = await offlineHub({ native: { onDeliver: async () => answer }, limits: { maxTurnsPerHour: 1 } });
  state.online = true;
  try {
    const { cluster: c, members: [a] } = await cluster(hub);
    hub.setPaused(true);
    const msgs = [hub.sendFromUser(c.id, '@A one'), hub.sendFromUser(c.id, '@A two')];
    hub.setPaused(false);
    await waitFor(() => msgs.every((m) => deliveryOf(store, m.id, a.id).state === 'offline'), 'batch offline');
    assert.deepEqual(msgs.map((m) => pick(deliveryOf(store, m.id, a.id))), [OFFLINE, OFFLINE]);
    assert.equal(native.delivered.length, 1, 'one attempt for the batch');
    assert.deepEqual(msgs.map((m) => attempts(store, deliveryOf(store, m.id, a.id).id)), [0, 0], 'the chain attempts are given back');
    assert.equal(store.countChainTurns(msgs[0].chainId), 0);
    assert.deepEqual((hub as any).turnStarts.get(JSON.stringify(['native', a.harness, a.workerSessionId])), [], 'the hourly turn is given back');
    await tick(50);
    assert.equal(native.delivered.length, 1, 'no retry');
    // The hourly limit (1) is still free: the next message goes out.
    answer = 'completed';
    const next = hub.sendFromUser(c.id, '@A three');
    await waitFor(() => deliveryOf(store, next.id, a.id).state === 'done', 'next delivered');
    assert.equal((hub as any).throttled.size, 0);
  } finally {
    await hub.close();
  }
});

test('offline: after restart the interrupted delivery is unknown and only queued work waits for the grace', async () => {
  /** A Hub stops with A's first delivery running and its second queued; a second Hub starts on the same database. */
  const restart = async (startupGraceMs: number) => {
    const dir = tempDir();
    const store = new Store(join(dir, 'restart.db'));
    const first = await offlineHub({ store, dir, native: { kind: 'bridge' } });
    const { cluster: c, members: [a] } = await cluster(first.hub);
    first.hub.connectBridge('mock', 's1', conn(first.hub, false));   // online, never acks: the first stays running
    const msgs = [first.hub.sendFromUser(c.id, '@A one'), first.hub.sendFromUser(c.id, '@A two')];
    await waitFor(() => deliveryOf(store, msgs[0].id, a.id).state === 'running', 'running');
    assert.equal(deliveryOf(store, msgs[1].id, a.id).state, 'queued');
    await first.hub.close();
    const second = await offlineHub({ store, dir, native: { kind: 'bridge' }, limits: { startupGraceMs } });
    const states = () => msgs.map((m) => deliveryOf(store, m.id, a.id).state);
    return { store, second, a, msgs, states };
  };

  // No bridge within the grace: interrupted work stays unknown; queued work ends offline.
  let r = await restart(100);
  try {
    assert.deepEqual(r.states(), ['failed', 'queued'], 'only queued work is kept during the grace');
    await tick(30);
    assert.deepEqual(r.states(), ['failed', 'queued']);
    await waitFor(() => r.states()[1] === 'offline', 'queued work is offline after the grace');
    assert.equal(deliveryOf(r.store, r.msgs[0].id, r.a.id).outcome, 'unknown');
    assert.equal(r.second.native.delivered.length, 0);
  } finally {
    await r.second.hub.close();
    r.store.close();
  }

  // The bridge reconnects within the grace: only the never-started message is delivered.
  r = await restart(5_000);
  try {
    r.second.hub.connectBridge('mock', 's1', conn(r.second.hub));
    await waitFor(() => r.states()[1] === 'done', 'queued message delivered');
    assert.deepEqual(r.states(), ['failed', 'done']);
    assert.deepEqual(r.second.native.delivered.map((d) => d.deliveryId), [deliveryOf(r.store, r.msgs[1].id, r.a.id).id]);
  } finally {
    await r.second.hub.close();
    r.store.close();
  }
});

test('offline: with confirmOnline every delivery waits for a check started after it was posted; one check at a time', async () => {
  const { hub, store, native, state } = await offlineHub();
  state.online = true;   // the cache: never trusted for a new delivery
  const checks: PromiseWithResolvers<boolean>[] = [];
  native.confirmOnline = () => {
    checks.push(Promise.withResolvers<boolean>());
    return checks.at(-1)!.promise;
  };
  const stateOf = (m: { id: string }, member: { id: string }) => deliveryOf(store, m.id, member.id).state;
  try {
    const { cluster: c, members: [a, b] } = await cluster(hub);
    // "two" comes after the first check started: that check decides only "one"; "two" waits for its own.
    const one = hub.sendFromUser(c.id, '@A one');
    const two = hub.sendFromUser(c.id, '@A two');
    assert.equal(checks.length, 1, 'one check per member at a time');
    assert.deepEqual([stateOf(one, a), stateOf(two, a)], ['queued', 'queued']);
    await tick(10);
    assert.equal(native.delivered.length, 0, 'nothing runs before its check');
    checks[0].resolve(true);
    await waitFor(() => checks.length === 2, 'the second check');
    await waitFor(() => stateOf(one, a) === 'done', 'one delivered');
    assert.equal(stateOf(two, a), 'queued', 'two still waits for its check');
    checks[1].resolve(true);
    await waitFor(() => stateOf(two, a) === 'done', 'two delivered');
    assert.deepEqual(native.delivered.map((d) => parseEnvelopes(d.text).map((e) => e.body)), [['@A one'], ['@A two']], 'in order');

    // Paused, cache online: a check that says offline ends it 'offline'; unpausing sends nothing.
    hub.setPaused(true);
    const three = hub.sendFromUser(c.id, '@A three');
    checks[2].resolve(false);
    await waitFor(() => stateOf(three, a) === 'offline', 'dropped while paused');
    hub.setPaused(false);

    // A stale "offline" decides only what was pending when it started (review: P2).
    const four = hub.sendFromUser(c.id, '@A four');
    const five = hub.sendFromUser(c.id, '@A five');
    checks[3].resolve(false);
    await waitFor(() => stateOf(four, a) === 'offline', 'four dropped');
    await waitFor(() => checks.length === 5, 'five gets its own check');
    assert.equal(stateOf(five, a), 'queued');
    checks[4].resolve(true);
    await waitFor(() => stateOf(five, a) === 'done', 'five delivered');
    assert.equal(native.delivered.length, 3);

    // Removed while the check runs: the removal's cancellation stands.
    const r = hub.sendFromUser(c.id, '@B hi');
    hub.removeMember(c.id, b.id);
    checks[5].resolve(false);
    await tick(10);
    assert.equal(stateOf(r, b), 'failed');

    // The Hub closing while the check runs: nothing is decided.
    const six = hub.sendFromUser(c.id, '@A six');
    const closing = hub.close();
    checks[6].resolve(false);
    await closing;
    assert.equal(stateOf(six, a), 'queued');
    assert.equal(native.delivered.length, 3);
  } finally {
    for (const check of checks) check.resolve(false);   // Hub.close waits for checks in flight
    await hub.close();
  }
});

test('offline: an app-checked member (confirmOnline) that goes off or on line gets a member event within recheckMs', async () => {
  // Like Codex: isOnline only reads a cache that confirmOnline refreshes; the app quitting sends the Hub nothing.
  const { hub, native, state } = await offlineHub({ limits: { recheckMs: 20 } });
  let cache = true;
  let checks = 0;
  native.isOnline = () => cache;
  native.confirmOnline = async () => { checks++; cache = state.online; return cache; };
  state.online = true;
  const statuses: string[] = [];
  hub.subscribe((e) => { if (e.kind === 'member' && (e.payload as any).member.name === 'A') statuses.push((e.payload as any).member.status); });
  try {
    await cluster(hub);
    await tick(80);
    assert.equal(statuses.length, 0, 'no event while nothing changes');
    assert.ok(checks >= 1 && checks <= 5, `one check per harness per tick (A and B share it): ${checks}`);
    state.online = false;   // the app quits
    await waitFor(() => statuses.includes('offline'), 'offline shown');
    assert.equal(hub.listMembers().find((m) => m.name === 'A')!.status, 'offline');
    state.online = true;
    await waitFor(() => statuses.at(-1) === 'idle', 'back online');
    assert.deepEqual(statuses, ['offline', 'idle'], 'one event per change');
  } finally {
    await hub.close();
  }
});

test('offline: the default Hub registers no mock (ORRERY_MOCK=1 adds it); old mock members show offline and get nothing', async () => {
  assert.deepEqual(Object.keys(registries(false)).sort(), ['antigravity', 'claude', 'codex', 'cursor', 'deepseek', 'kimi', 'qoder', 'workbuddy', 'zcode']);
  assert.deepEqual(Object.keys(registries(true)).sort(), ['antigravity', 'claude', 'codex', 'cursor', 'deepseek', 'kimi', 'mock', 'qoder', 'workbuddy', 'zcode']);

  // A database made by a Hub that had mock (and the test harness 'other'): a message queued while paused.
  const dir = tempDir();
  const store = new Store(join(dir, 'old.db'));
  const first = await offlineHub({ store, dir });
  first.state.online = true;
  const { cluster: c, members: [a, , i] } = await cluster(first.hub);
  first.hub.setPaused(true);
  const old = first.hub.sendFromUser(c.id, '@A @I queued');
  assert.deepEqual([a, i].map((m) => deliveryOf(store, old.id, m.id).state), ['queued', 'queued']);
  await first.hub.close();

  // The same data under a Hub without those harnesses: offline, the queued deliveries end offline, new ones too; nothing throws.
  const hub = new Hub({ store, nativeAdapters: {}, limits: { startupGraceMs: 0 } });
  hub.start();
  try {
    assert.deepEqual(hub.listMembers(c.id).map((m) => m.status), ['offline', 'offline', 'offline']);
    assert.deepEqual([a, i].map((m) => pick(deliveryOf(store, old.id, m.id))), [OFFLINE, OFFLINE]);
    const m = hub.sendFromUser(c.id, '@all hi');
    assert.deepEqual([a, i].map((x) => pick(deliveryOf(store, m.id, x.id))), [OFFLINE, OFFLINE]);
  } finally {
    await hub.close();
    store.close();
  }
});
