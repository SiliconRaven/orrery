// Acceptance criteria 3, 4, 5, 6, 8, 9 from docs/architecture.md (batch 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { defaultScript, type Envelope, type MockScript } from './mock.ts';
import type { Delivery } from '../src/core/types.ts';
import { fixtureNativeMock, startTestHub, tempDir, waitFor } from './helpers.ts';

const deliveryEvents = (events: { kind: string; payload: unknown }[]) =>
  events.filter((e) => e.kind === 'delivery').map((e) => (e.payload as { delivery: Delivery }).delivery);

test('3: a user message without @ is delivered to nobody and stays in the chat record', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('c', ['A', 'B', 'C']);
    const msg = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'hello everyone' });
    assert.deepEqual([msg.from, msg.mentions, msg.hop], ['user', [], 0]);
    const [listed] = await app.messages(cluster.id);
    assert.deepEqual([listed.id, listed.body, listed.deliveries], [msg.id, 'hello everyone', []]);
    const posted = app.events.find((e) => e.kind === 'message')!.payload as { deliveries: Delivery[] };
    assert.deepEqual(posted.deliveries, []);
    await sleep(100);
    assert.equal(deliveryEvents(app.events).length, 0, 'no member got a turn');
  } finally {
    await app.close();
  }
});

test('3b: a user message with @all goes to every member and all finish', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members } = await app.cluster('c', ['A', 'B', 'C']);
    const msg = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@all hello everyone' });
    assert.deepEqual(msg.mentions.sort(), members.map((m) => m.id).sort());
    await waitFor(() => app.settled(cluster.id), 'broadcast delivered');
    const [listed] = await app.messages(cluster.id);
    assert.deepEqual(listed.deliveries.map((d) => d.memberId).sort(), members.map((m) => m.id).sort());
    assert.ok(listed.deliveries.every((d) => d.state === 'done'));
  } finally {
    await app.close();
  }
});

test('4: @A reaches only A; B is told of and reads only what concerns it, or the whole history on request', async () => {
  const envelopes: Envelope[] = [];
  const recording: MockScript = (msg, ...rest) => (envelopes.push(msg), defaultScript(msg, ...rest));
  const app = await startTestHub({ mock: { script: recording } });
  try {
    const { cluster, members: [a, b] } = await app.cluster('c', ['A', 'B']);
    const hello = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A 你好' });
    assert.deepEqual(hello.mentions, [a.id]);
    await waitFor(() => app.settled(cluster.id), 'A done');
    assert.deepEqual((await app.messages(cluster.id))[0].deliveries.map((d) => d.memberId), [a.id]);
    assert.match(envelopes[0].raw, /^\[orrery\] cluster=c clusterId=\S+ from=user messageId=\S+ hop=0 to=@A\n@A 你好\n\n-{10}\n（你是群员 A。/);
    assert.doesNotMatch(envelopes[0].raw, /群里还有未读/);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'a note for everyone' });   // no @: delivered to nobody

    const texts = () => app.events.filter((e) => e.kind === 'agent' && e.memberId === b.id && (e.payload as any).event.type === 'text')
      .map((e) => JSON.parse((e.payload as any).event.text));
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@B read' });
    await waitFor(() => app.settled(cluster.id), 'B done');
    // '@A 你好' does not concern B; the user's note without @ does.
    assert.match(envelopes.find((e) => e.body === '@B read')!.raw, /群里还有未读 1：用户 1，可用 read_messages 查看。/);
    assert.deepEqual(texts()[0].map((m: any) => [m.from, m.mentions, m.body]),
      [['user', [], 'a note for everyone'], ['user', ['B'], '@B read']]);

    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@B read history' });
    await waitFor(() => app.settled(cluster.id), 'B done again');
    assert.doesNotMatch(envelopes.find((e) => e.body === '@B read history')!.raw, /群里还有未读/, 'what read_messages returned is read');
    assert.deepEqual(texts()[1].map((m: any) => m.body), ['@A 你好', 'a note for everyone', '@B read', '@B read history']);
  } finally {
    await app.close();
  }
});

test('5: a busy member queues the next message and never runs two turns at once', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a] } = await app.cluster('c', ['A', 'B']);
    const send = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
    const first = await send('@A sleep 300');
    await waitFor(() => app.hub.listMembers().find((m) => m.id === a.id)?.status === 'busy', 'A busy');
    const second = await send('@A hello');
    const msgs = await app.messages(cluster.id);
    const stateOf = (id: string) => msgs.find((m) => m.id === id)!.deliveries[0].state;
    assert.equal(stateOf(first.id), 'running');
    assert.equal(stateOf(second.id), 'queued');

    await waitFor(() => app.settled(cluster.id), 'both delivered');
    const running = new Set<string>();
    const order: string[] = [];
    for (const d of deliveryEvents(app.events).filter((d) => d.memberId === a.id)) {
      if (d.state === 'running') running.add(d.id); else running.delete(d.id);
      assert.ok(running.size <= 1, 'A had two running deliveries at once');
      order.push(`${d.messageId === first.id ? 'first' : 'second'}:${d.state}`);
    }
    assert.deepEqual(order, ['first:running', 'first:done', 'second:running', 'second:done']);
  } finally {
    await app.close();
  }
});

test('6: relay chain user → A → B → A, and an agent message without @ is delivered to nobody', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.cluster('c', ['A', 'B']);
    const start = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A relay B n1' });
    await waitFor(async () => (await app.messages(cluster.id)).length === 3 && app.settled(cluster.id), 'chain finished');
    const [m0, ping, pong] = await app.messages(cluster.id);
    assert.equal(m0.id, start.id);
    assert.deepEqual([ping.from, ping.mentions, ping.body, ping.replyTo, ping.hop], [a.id, [b.id], '@B ping n1', null, 1]);
    assert.deepEqual([pong.from, pong.mentions, pong.body, pong.replyTo, pong.hop], [b.id, [a.id], '@A pong n1', ping.id, 2]);
    assert.deepEqual([m0.chainId, ping.chainId, pong.chainId], [start.id, start.id, start.id]);
    assert.deepEqual([ping.deliveries.map((d) => d.memberId), pong.deliveries.map((d) => d.memberId)], [[b.id], [a.id]]);

    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A chat just thinking aloud' });
    await waitFor(async () => (await app.messages(cluster.id)).length === 5 && app.settled(cluster.id), 'chat posted');
    const chat = (await app.messages(cluster.id))[4];
    assert.deepEqual([chat.from, chat.body, chat.mentions, chat.deliveries], [a.id, 'just thinking aloud', [], []]);
  } finally {
    await app.close();
  }
});

// Both members answer every ping with another ping, forever.
const pingBack: MockScript = async (msg, tools, emit, signal) => {
  const body = msg.body.replace(/^@\S+\s+/, '');
  if (!body.startsWith('ping ')) return defaultScript(msg, tools, emit, signal);
  const r = await tools.send(`@${msg.from} ${body}`, msg.messageId);
  if (r.isError) emit({ type: 'error', message: r.text });
};

test('8a: endless ping-pong stops at MAX_HOPS with a guard event', async () => {
  const app = await startTestHub({ limits: { maxHops: 3 }, mock: { script: pingBack } });
  try {
    const { cluster } = await app.cluster('c', ['A', 'B']);
    const start = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A relay B loop' });
    await waitFor(() => app.events.find((e) => e.kind === 'guard'), 'guard event');
    await waitFor(() => app.settled(cluster.id), 'chain settled');
    const msgs = await app.messages(cluster.id);
    assert.deepEqual(msgs.map((m) => m.hop), [0, 1, 2, 3]);
    assert.ok(msgs.every((m) => m.chainId === start.id));
    assert.equal((app.events.find((e) => e.kind === 'guard')!.payload as any).reason, 'max_hops');
    assert.ok(app.events.some((e) => e.kind === 'agent' && (e.payload as any).event.type === 'error'),
      'the rejected tool call came back to the worker as an error');
  } finally {
    await app.close();
  }
});

test('8b: endless ping-pong stops at MAX_TURNS_PER_CHAIN with a failed delivery and a guard event', async () => {
  const app = await startTestHub({ limits: { maxHops: 100, maxTurnsPerChain: 4 }, mock: { script: pingBack } });
  try {
    const { cluster } = await app.cluster('c', ['A', 'B']);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A relay B loop' });
    await waitFor(() => app.events.find((e) => e.kind === 'guard'), 'guard event');
    await waitFor(() => app.settled(cluster.id), 'chain settled');
    const deliveries = (await app.messages(cluster.id)).flatMap((m) => m.deliveries);
    assert.deepEqual(deliveries.map((d) => d.state), ['done', 'done', 'done', 'done', 'failed']);
    assert.equal(deliveries[4].error, '链轮次超限');
    assert.equal((app.events.find((e) => e.kind === 'guard')!.payload as any).reason, 'max_turns_per_chain');
  } finally {
    await app.close();
  }
});

test('8c: pause stops new turns; resume continues', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('c', ['A']);
    assert.deepEqual(await app.api('POST', '/api/pause', { paused: true }), { paused: true });
    assert.equal((await app.api('GET', '/api/state')).paused, true);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hello' });
    await sleep(150);
    assert.equal((await app.messages(cluster.id))[0].deliveries[0].state, 'queued');
    assert.ok(!deliveryEvents(app.events).some((d) => d.state === 'running'));
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => app.settled(cluster.id), 'delivered after resume');
    assert.deepEqual(app.events.filter((e) => e.kind === 'pause').map((e) => (e.payload as any).paused), [true, false]);
  } finally {
    await app.close();
  }
});

test('8d: a member over MAX_TURNS_PER_HOUR starts no new turns', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerHour: 2, recheckMs: 30 } });
  try {
    const { cluster } = await app.cluster('c', ['A']);
    for (const n of [1, 2, 3]) await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: `@A hello ${n}` });
    await sleep(300); // several recheck periods
    assert.deepEqual((await app.messages(cluster.id)).map((m) => m.deliveries[0].state), ['done', 'done', 'queued']);
    const guards = app.events.filter((e) => e.kind === 'guard');
    assert.equal(guards.length, 1, 'guard is reported once, not on every recheck');
    assert.equal((guards[0].payload as any).reason, 'max_turns_per_hour');
  } finally {
    await app.close();
  }
});

test('9: a running delivery becomes unknown after a Hub restart', async () => {
  const app = await startTestHub();
  const { cluster } = await app.cluster('c', ['A']);
  const msg = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A sleep 10000' });
  await waitFor(() => deliveryEvents(app.events).some((d) => d.state === 'running'), 'running');
  await app.close(); // simulates the Hub going away mid-turn

  const store = new Store(join(app.dir, 'test.db'));
  try {
    assert.equal(store.withDeliveries(store.listMessages(cluster.id, 10))[0].deliveries[0].state, 'running',
      'the interrupted turn was left running in the database');
    const hub = new Hub({ store, nativeAdapters: { mock: fixtureNativeMock(app.dir) }, });
    const [after] = store.withDeliveries(store.listMessages(cluster.id, 10));
    assert.equal(after.id, msg.id);
    assert.equal(after.deliveries[0].state, 'failed');
    assert.equal(after.deliveries[0].outcome, 'unknown');
    assert.match(after.deliveries[0].error!, /Hub 重启/);
    const recoveryEvents = store.listEvents(0).filter((e) => e.kind === 'delivery' && (e.payload as any).delivery.outcome === 'unknown');
    assert.equal(recoveryEvents.length, 1);
    await hub.close();
  } finally {
    store.close();
  }
});

test('4b: @ parsing — full names only, word boundaries, @all means everyone, unknown names are ignored', async () => {
  const app = await startTestHub();
  try {
    await app.api('POST', '/api/pause', { paused: true });   // only the parsing matters here
    const { cluster, members: [m1, m12, al] } = await app.api('POST', '/api/clusters', {
      name: 'c', members: [{ projectPath: tempDir(), harness: 'mock' }, { projectPath: tempDir(), harness: 'mock' }, { projectPath: tempDir(), harness: 'mock', name: 'al' }],
    });
    assert.deepEqual([m1.name, m12.name], ['mock-1', 'mock-1-2']);
    const mentions = async (body: string) => (await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body })).mentions;
    assert.deepEqual(await mentions('@mock-1-2 hi'), [m12.id]);
    assert.deepEqual(await mentions('@mock-1 and @al'), [m1.id, al.id]);
    assert.deepEqual(await mentions('@all hi'), [m1.id, m12.id, al.id]);
    assert.deepEqual(await mentions('@nobody hi'), []);
    assert.deepEqual(await mentions('@alfred and @mock-1-3 hi'), [], 'a name must not run into ASCII word characters');
    assert.deepEqual(await mentions('mail me at foo@al or a@mock-1'), [], 'foo@bar is not a mention');
    assert.deepEqual(await mentions('@al你好，@mock-1.'), [m1.id], 'punctuation may follow a name; CJK letters continue it (full names only)');
    assert.deepEqual(await mentions('@al 你好，@al，@mock-1。'), [al.id, m1.id], 'a space or punctuation before CJK ends the name');
    assert.deepEqual(await mentions('（@al）'), [al.id], 'full-width punctuation may precede @');
    assert.deepEqual(await mentions('@al.v2 hi and @mock-1._x'), [], 'a dot followed by a word character continues the name');
    assert.deepEqual(await mentions('@al.-v2 hi'), [], 'a dot followed by - continues the name');
    assert.deepEqual(await mentions('@all.-v2 hi'), [], '@all.-v2 is not a broadcast');
    assert.deepEqual(await mentions('@al. ok'), [al.id]);
    assert.deepEqual(await mentions('@al。'), [al.id]);
    assert.deepEqual(await mentions('see @al.'), [al.id]);
    assert.deepEqual(await mentions('@al.，@mock-1..'), [al.id, m1.id]);
  } finally {
    await app.close();
  }
});

test('8e: a restart preserves the chain turn count without retrying a running turn', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerChain: 1 } });
  const { cluster } = await app.cluster('c', ['A']);
  await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A sleep 10000' });
  await waitFor(() => deliveryEvents(app.events).some((d) => d.state === 'running'), 'running');
  await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A queued after restart' });
  await app.close();   // the one allowed turn started, then the Hub went away

  const again = await startTestHub({ dir: app.dir, limits: { maxTurnsPerChain: 1 } });
  try {
    await waitFor(() => again.settled(cluster.id), 'interrupted delivery recovered');
    const [d] = (await again.messages(cluster.id))[0].deliveries;
    assert.deepEqual([d.state, d.outcome], ['failed', 'unknown']);
    await waitFor(() => again.native.delivered.length === 1, 'the never-started queued message runs');
    assert.equal((await again.messages(cluster.id))[1].deliveries[0].state, 'done');
    assert.equal((again.store.db.prepare('SELECT attempts FROM deliveries').get() as any).attempts, 1);
  } finally {
    await again.close();
  }
});

test('8f: thousands of deliveries over the chain limit are failed without blowing the stack', async () => {
  const dir = tempDir();
  const store = new Store(':memory:');
  const hub = new Hub({ store, nativeAdapters: { mock: fixtureNativeMock(dir) },  limits: { maxTurnsPerChain: 0 } });
  try {
    hub.start();   // never called: no turn may start
    hub.setPaused(true);
    const { cluster } = await hub.createCluster('c', [{ projectPath: tempDir(), harness: 'mock', name: 'A' }]);
    for (let i = 0; i < 6000; i++) hub.sendFromUser(cluster.id, `@A m${i}`);
    hub.setPaused(false);
    const counts = store.db.prepare('SELECT state, COUNT(*) AS n FROM deliveries GROUP BY state').all();
    assert.deepEqual(counts.map((r) => [r.state, r.n]), [['failed', 6000]]);
  } finally {
    await hub.close();
    store.close();
  }
});

test('4c: the unseen hint counts unread messages that concern the member, minus what is on its way to it', async () => {
  const envelopes: Envelope[] = [];
  const recording: MockScript = (msg, ...rest) => (envelopes.push(msg), defaultScript(msg, ...rest));
  const app = await startTestHub({ mock: { script: recording } });
  try {
    const { cluster } = await app.cluster('c', ['A', 'B']);
    await app.api('POST', '/api/pause', { paused: true });
    for (const body of ['@B first', '@A hidden', 'note', '@B second']) await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => app.settled(cluster.id), 'all handled');
    for (const body of ['@B read', '@B again']) {
      await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
      await waitFor(() => app.settled(cluster.id), body);
    }
    const hint = (body: string) => /群里还有未读 (\d+)：/.exec(envelopes.find((e) => e.body === body)!.raw)?.[1] ?? '0';
    // B: '@B first' and '@B second' came in one batch, so only 'note' is unseen; '@A hidden' is not B's business.
    // '@B read' returns 'note', so the next envelope has nothing left to hint at.
    assert.deepEqual([hint('@B first'), hint('@B second'), hint('@A hidden'), hint('@B read'), hint('@B again')], ['1', '1', '1', '1', '0']);
  } finally {
    await app.close();
  }
});
