// The per-chain turn limit setting (docs/hop-limit.md「每条链轮次上限」): default, precedence, strict input, the guard
// skipped under unlimited (turns still counted) and enforced for finite values, the hourly limit and pause still holding.
// Temp homes and databases, port 0, mock workers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { defaultScript, type MockScript } from './mock.ts';
import type { HubEvent } from '../src/core/types.ts';
import { fakeCursor, fakeCursorAdapter } from './cursor-fake.ts';
import { startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

const finite = (value: number) => ({ kind: 'finite', value });
const UNLIMITED = { kind: 'unlimited' };
/** The per-chain turn limit's part of GET /api/settings. */
const chainOf = (s: any) => ({ maxTurnsPerChain: s.maxTurnsPerChain, maxTurnsPerChainSource: s.maxTurnsPerChainSource });

// Both members answer every ping with another ping, forever (as in hub.test.ts).
const pingBack: MockScript = async (msg, tools, emit, signal) => {
  const body = msg.body.replace(/^@\S+\s+/, '');
  if (!body.startsWith('ping ')) return defaultScript(msg, tools, emit, signal);
  const r = await tools.send(`@${msg.from} ${body}`, msg.messageId);
  if (r.isError) emit({ type: 'error', message: r.text });
};

const patch = (app: TestHub, body: unknown) => fetch(app.url + '/api/settings', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

const guards = (events: HubEvent[], reason: string) =>
  events.filter((e) => e.kind === 'guard' && (e.payload as any).reason === reason).map((e) => e.payload as any);
const settingsEvents = (events: HubEvent[]) => events.filter((e) => e.kind === 'settings').map((e) => e.payload);
const savedRow = (app: TestHub) =>
  (app.store.db.prepare("SELECT value FROM settings WHERE key = 'max_turns_per_chain'").get() as any)?.value ?? null;

/** Starts a ping-pong chain and waits until a guard stops it; returns its messages' delivery states. */
async function runChain(app: TestHub, clusterId: string, nonce: string, timeoutMs = 5000) {
  const start = await app.api('POST', `/api/clusters/${clusterId}/messages`, { body: `@A relay B ${nonce}` });
  await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).chainId === start.id), `guard on chain ${nonce}`, timeoutMs);
  await waitFor(() => app.settled(clusterId), `chain ${nonce} settled`, timeoutMs);
  const msgs = (await app.messages(clusterId)).filter((m) => m.chainId === start.id);
  return { chainId: start.id as string, states: msgs.flatMap((m) => m.deliveries.map((d: any) => d.state)) };
}

test('chain 1: 20 by default; the start-up value applies until one is saved, which then wins after a restart', async () => {
  const fresh = await startTestHub();
  try {
    assert.deepEqual(chainOf(await fresh.api('GET', '/api/settings')), { maxTurnsPerChain: finite(20), maxTurnsPerChainSource: 'default' });
  } finally {
    await fresh.close();
  }

  const limits = { maxTurnsPerChain: 4 };   // what ORRERY_MAX_TURNS_PER_CHAIN=4 hands the Hub
  const app = await startTestHub({ limits });
  try {
    assert.deepEqual(chainOf(await app.api('GET', '/api/settings')), { maxTurnsPerChain: finite(4), maxTurnsPerChainSource: 'startup' });
    const res = await patch(app, { maxTurnsPerChain: finite(7) });
    assert.deepEqual([res.status, chainOf(res.data)], [200, { maxTurnsPerChain: finite(7), maxTurnsPerChainSource: 'saved' }]);
    assert.deepEqual([res.data.maxHops, res.data.source], [finite(6), 'default'], 'the hop limit is untouched');
    assert.deepEqual(settingsEvents(app.events), [{ maxTurnsPerChain: finite(7), maxTurnsPerChainSource: 'saved' }]);
    assert.equal(savedRow(app), '{"kind":"finite","value":7}');
  } finally {
    await app.close();
  }
  const again = await startTestHub({ dir: app.dir, limits });
  try {
    assert.deepEqual(chainOf(await again.api('GET', '/api/settings')), { maxTurnsPerChain: finite(7), maxTurnsPerChainSource: 'saved' });
    assert.deepEqual(chainOf((await again.api('GET', '/api/state')).settings), { maxTurnsPerChain: finite(7), maxTurnsPerChainSource: 'saved' });
  } finally {
    await again.close();
  }
});

test('chain 2: every malformed body is a 400 that changes neither the database nor memory', async () => {
  const app = await startTestHub();
  try {
    assert.equal((await patch(app, { maxTurnsPerChain: finite(9) })).status, 200);
    const bad: unknown[] = [
      { maxTurnsPerChain: finite(-1) }, { maxTurnsPerChain: finite(1.5) }, { maxTurnsPerChain: { kind: 'finite', value: '20' } },
      { maxTurnsPerChain: { kind: 'finite' } }, { maxTurnsPerChain: finite(2 ** 53) }, { maxTurnsPerChain: finite(20), extra: 1 },
      { maxTurnsPerChain: finite(20), confirmUnlimited: true }, { maxTurnsPerChain: UNLIMITED }, { maxTurnsPerChain: UNLIMITED, confirmUnlimited: false },
      { maxTurnsPerChain: UNLIMITED, confirmUnlimited: 'true' }, { maxTurnsPerChain: UNLIMITED, confirmUnlimited: true, extra: 1 },
      { maxTurnsPerChain: null }, { maxTurnsPerChain: 20 }, { maxTurnsPerChain: 'unlimited' },
      // One setting per request.
      { maxTurnsPerChain: finite(3), maxHops: finite(3) }, { maxTurnsPerChain: UNLIMITED, maxHops: UNLIMITED, confirmUnlimited: true },
      { maxturnsperchain: finite(3) }, { maxTurnsPerHour: finite(3) },
    ];
    for (const body of bad) assert.equal((await patch(app, body)).status, 400, JSON.stringify(body));
    for (const input of [finite(NaN), finite(Infinity), null, undefined, 20]) {
      assert.throws(() => app.hub.setLimit('maxTurnsPerChain', input), /maxTurnsPerChain must be/, String(input));
    }
    assert.throws(() => app.hub.setLimit('maxTurnsPerChain', UNLIMITED), /confirmUnlimited: true/);
    assert.deepEqual(app.hub.getLimit('maxTurnsPerChain'), { limit: finite(9), source: 'saved' });
    assert.deepEqual(app.hub.getLimit('maxHops'), { limit: finite(6), source: 'default' });
    assert.equal(savedRow(app), '{"kind":"finite","value":9}');
    assert.equal(settingsEvents(app.events).length, 1);
  } finally {
    await app.close();
  }
});

test('chain 3: unlimited (confirmed) lets a chain run past 20 turns, still counted; a finite value applies again to later turns', async () => {
  const app = await startTestHub({ limits: { maxHops: 21 }, mock: { script: pingBack } });
  try {
    const res = await patch(app, { maxTurnsPerChain: UNLIMITED, confirmUnlimited: true });
    assert.deepEqual([res.status, chainOf(res.data)], [200, { maxTurnsPerChain: UNLIMITED, maxTurnsPerChainSource: 'saved' }]);
    assert.equal(savedRow(app), '{"kind":"unlimited"}');
    const { cluster } = await app.cluster('c', ['A', 'B']);
    // The hop limit (21) stops the chain, not the turn limit: hops 0..21 are each delivered, 22 turns.
    const long = await runChain(app, cluster.id, 'u', 20_000);
    assert.deepEqual(long.states, Array(22).fill('done'));
    assert.equal(app.store.countChainTurns(long.chainId), 22, 'turns are still counted per chain');
    assert.deepEqual(guards(app.events, 'max_turns_per_chain'), []);
    assert.equal(guards(app.events, 'max_hops').length, 1);

    assert.equal((await patch(app, { maxTurnsPerChain: finite(3) })).status, 200);
    const short = await runChain(app, cluster.id, 's');
    assert.deepEqual(short.states, ['done', 'done', 'done', 'failed']);
    assert.deepEqual(guards(app.events, 'max_turns_per_chain'), [{ reason: 'max_turns_per_chain', chainId: short.chainId, maxTurnsPerChain: 3 }]);
  } finally {
    await app.close();
  }
});

test('chain 4: with both limits unlimited, pause and the hourly limit still stop agents @-ing each other', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerHour: 3, recheckMs: 30 }, mock: { script: pingBack } });
  try {
    assert.equal((await patch(app, { maxHops: UNLIMITED, confirmUnlimited: true })).status, 200);
    assert.equal((await patch(app, { maxTurnsPerChain: UNLIMITED, confirmUnlimited: true })).status, 200);
    const { cluster } = await app.cluster('c', ['A', 'B']);
    await app.api('POST', '/api/pause', { paused: true });
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A relay B forever' });
    await sleep(150);
    assert.deepEqual((await app.messages(cluster.id)).map((m) => m.deliveries[0].state), ['queued'], 'nothing starts while paused');
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => guards(app.events, 'max_turns_per_hour').length > 0, 'hourly guard');
    await sleep(200);   // several recheck periods: the chain stays stopped
    const states = (await app.messages(cluster.id)).flatMap((m) => m.deliveries.map((d: any) => d.state));
    assert.deepEqual(states, [...Array(6).fill('done'), 'queued'], 'A and B ran 3 turns each, the next waits');
    assert.deepEqual(guards(app.events, 'max_turns_per_chain'), []);
    assert.deepEqual(guards(app.events, 'max_hops'), []);
  } finally {
    await app.close();
  }
});

test('chain 5: a malformed saved value or start-up value stops the Hub, naming the setting', async () => {
  const dir = tempDir();
  const store = new Store(join(dir, 'test.db'));
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('max_turns_per_chain', ?)").run('{"kind":"finite","value":"20"}');
  store.close();
  await assert.rejects(startTestHub({ dir }), /saved setting max_turns_per_chain is invalid/);
  const mem = new Store(':memory:');
  try {
    assert.throws(() => new Hub({ store: mem, nativeAdapters: {}, limits: { maxTurnsPerChain: 2 ** 53 } }), /ORRERY_MAX_TURNS_PER_CHAIN/);
  } finally {
    mem.close();
  }
});

test('chain 6: a native Cursor member in a ping-pong chain is stopped by the per-chain turn limit like any other member', async () => {
  const S = 'aaaaaaaa-1111-4111-8111-111111111111';
  const app = await startTestHub({ limits: { maxTurnsPerChain: 3 }, mock: { script: pingBack }, nativeAdapters: { cursor: fakeCursorAdapter([S]) } });
  const cursor = fakeCursor(app, S, 'A');
  try {
    const { cluster } = await app.api('POST', '/api/clusters', { name: 'c', members: [{ harness: 'cursor', mode: 'native', sessionId: S, name: 'C' }, { harness: 'mock', mode: 'native', name: 'A', projectPath: '/work' }] });
    await waitFor(() => app.hub.bridge.isOnline('cursor', S), 'the Cursor member parked');
    const start = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C ping t1' });
    await waitFor(() => guards(app.events, 'max_turns_per_chain').length > 0, 'chain guard', 10_000);
    await waitFor(() => app.settled(cluster.id), 'settled', 10_000);
    const states = (await app.messages(cluster.id)).filter((m) => m.chainId === start.id).flatMap((m) => m.deliveries.map((d: any) => d.state));
    assert.deepEqual(states, ['done', 'done', 'done', 'failed'], 'C, A, C ran; A\'s turn, the fourth of the chain, is refused');
    assert.deepEqual(guards(app.events, 'max_turns_per_chain'), [{ reason: 'max_turns_per_chain', chainId: start.id, maxTurnsPerChain: 3 }]);
  } finally {
    await cursor.stop();
    await app.close();
  }
});
