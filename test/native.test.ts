// Native mode, Hub side (docs/native-mode.md): acceptance items 1, 2, 4, 5 and 6, with the mock native adapter
// ('bridge' kind under the harness name claude, 'queue' kind under codex) and a fake bridge: an HTTP SSE client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMockNativeAdapter, type MockNativeAdapter } from '../src/adapters/mock/native.ts';
import { parseEnvelope } from './mock.ts';
import type { Limits } from '../src/core/hub.ts';
import type { Member } from '../src/core/types.ts';
import { mcpStatus, startTestHub, tempDir, turnsOf, waitFor, type TestHub } from './helpers.ts';

type NativeHub = TestHub & { claude: MockNativeAdapter; codex: MockNativeAdapter; deepseek: MockNativeAdapter; secret: string };

/**
 * A test Hub with native claude (bridge) sessions c1..c3, native codex (queue) threads t1..t2 and native deepseek
 * (bridge, reached through the harness's shared stream) sessions d1..d2, all in one project.
 */
async function startNativeHub(limits: Partial<Limits> = {}): Promise<NativeHub> {
  const dir = tempDir();
  const p = join(dir, 'native-project');
  mkdirSync(p, { recursive: true });
  const session = (id: string) => ({ id, title: `chat ${id}`, model: null, cwd: p, updatedAt: null });
  const claude = createMockNativeAdapter({ harness: 'claude', kind: 'bridge', sessions: ['c1', 'c2', 'c3'].map(session) });
  const codex = createMockNativeAdapter({ harness: 'codex', kind: 'queue', sessions: ['t1', 't2'].map(session) });
  const deepseek = createMockNativeAdapter({ harness: 'deepseek', kind: 'bridge', sessions: ['d1', 'd2'].map(session) });
  // recheckMs is long so nothing but a bridge connecting can explain an offline member's delivery.
  const app = await startTestHub({ dir, nativeAdapters: { claude, codex, deepseek }, limits: { recheckMs: 60_000, ...limits } });
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  return Object.assign(app, { claude, codex, deepseek, secret });
}

interface FakeBridge {
  status: number;
  events: { deliveryId: string; sessionId: string; text: string }[];
  ended(): boolean;
  ack(deliveryId: string, ok?: boolean, error?: string): Promise<{ acked: boolean }>;
  close(): void;
}

/**
 * The Hub side of a bridge as unit 2's program will see it; session null opens the harness's shared stream.
 * With autoAck, every deliver is acked ok.
 */
async function bridge(url: string, secret: string, session: string | null, opts: { autoAck?: boolean; harness?: string } = {}): Promise<FakeBridge> {
  const ac = new AbortController();
  const query = `harness=${opts.harness ?? 'claude'}${session === null ? '' : `&session=${encodeURIComponent(session)}`}`;
  const res = await fetch(`${url}/bridge/stream?${query}`, {
    headers: { 'x-orrery-bridge': secret }, signal: ac.signal,
  });
  const events: FakeBridge['events'] = [];
  let ended = false;
  const ack = async (deliveryId: string, ok = true, error?: string) => {
    const r = await fetch(`${url}/bridge/ack`, {
      method: 'POST', headers: { 'x-orrery-bridge': secret, 'content-type': 'application/json' }, body: JSON.stringify({ deliveryId, ok, error }),
    });
    return r.json();
  };
  if (res.ok) {
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (/^event: deliver$/m.test(block) && data) {
            const e = JSON.parse(data);
            events.push(e);
            if (opts.autoAck) ack(e.deliveryId).catch(() => {});   // the Hub may be closing
          }
        }
      }
    })().catch(() => {}).finally(() => { ended = true; });
  } else {
    await res.body?.cancel();
  }
  return { status: res.status, events, ended: () => ended, ack, close: () => ac.abort() };
}

/** An MCP client speaking as a native conversation: claude via x-orrery-session, codex via _meta.threadId. */
async function nativeClient(url: string, headers: Record<string, string>, threadId?: string) {
  const client = new Client({ name: 'native-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) });
    const text = (res.content as any)[0].text as string;
    return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) };
  };
  return { call, close: () => client.close() };
}

const asClaude = (app: NativeHub, session: string) =>
  nativeClient(app.url, { 'x-orrery-bridge': app.secret, 'x-orrery-session': session });
const asCodex = (app: NativeHub, thread: string) => nativeClient(app.url, { 'x-orrery-bridge': app.secret }, thread);

const memberStatus = async (app: TestHub, id: string) =>
  ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status;
const deliveryOf = async (app: TestHub, clusterId: string, messageId: string, memberId: string) =>
  (await app.messages(clusterId)).find((m) => m.id === messageId)!.deliveries.find((d) => d.memberId === memberId)!;

/** Cluster "mix": mock A (a new conversation), claude C (session c1), codex X (thread t1). */
async function mixedCluster(app: NativeHub) {
  const { cluster, members: [a, c, x] } = await app.api('POST', '/api/clusters', {
    name: 'mix',
    members: [
      { harness: 'mock', mode: 'native', name: 'A', projectPath: '/work' },
      { harness: 'claude', mode: 'native', sessionId: 'c1', name: 'C' },
      { harness: 'codex', mode: 'native', sessionId: 't1', name: 'X' },
    ],
  });
  return { cluster, a, c, x };
}

test('native 1: members of three harnesses mix in one cluster; @ and broadcast reach every one', async () => {
  const app = await startNativeHub();
  try {
    const { cluster, a, c, x } = await mixedCluster(app);
    assert.ok([a, c, x].every((m) => !('mode' in m)), 'one mode: members carry no mode field');
    assert.deepEqual([c.origin, c.workerSessionId, x.workerSessionId], ['attached', 'c1', 't1']);
    const br = await bridge(app.url, app.secret, 'c1', { autoAck: true });
    assert.equal(br.status, 200);
    const post = (body: string, to?: string[]) => app.api('POST', `/api/clusters/${cluster.id}/messages`, to ? { body, to } : { body });

    // Broadcast: A's mock runs its script, C's bridge gets a deliver, X's queue completes.
    const all = await post('@all hello everyone');
    await waitFor(() => app.settled(cluster.id), 'broadcast settled');
    const states = (await app.messages(cluster.id))[0].deliveries.map((d) => [d.memberId, d.state]);
    assert.deepEqual(states, [[a.id, 'done'], [c.id, 'done'], [x.id, 'done']]);
    assert.equal(br.events.length, 1);
    assert.equal(parseEnvelope(br.events[0].text).messageId, all.id, 'a group message carries the envelope');
    assert.match(br.events[0].text, /^\[orrery\] cluster=mix clusterId=\S+ from=user messageId=\S+ hop=0 to=@A @C @X\n@all hello everyone\n\n-{10}\n（你是群员 C。/);
    assert.equal(app.codex.delivered.length, 1);
    assert.equal(parseEnvelope(app.codex.delivered[0].text).body, '@all hello everyone');
    const xText = app.store.listEvents(0, x.id, ['agent']).map((e: any) => e.payload.event.text);
    assert.deepEqual(xText, [`mock codex received: ${app.codex.delivered[0].text}`], 'the adapter events reach the member page');

    // @C only reaches C.
    await post('@C just you');
    await waitFor(() => app.settled(cluster.id), '@C settled');
    assert.equal(br.events.length, 2);
    assert.equal(app.codex.delivered.length, 1);
    assert.equal(turnsOf(app, a.id), 1);

    // A → X: A's turn relays "@X ping n1".
    await post('@A relay X n1');
    await waitFor(() => app.codex.delivered.length === 2, 'X got the relay');
    const relay = parseEnvelope(app.codex.delivered[1].text);
    assert.deepEqual([relay.from, relay.hop, relay.body], ['A', 1, '@X ping n1']);
    await waitFor(() => app.settled(cluster.id), 'relay settled');

    // C speaks through the bridge's MCP connection, to A and X.
    const cc = await asClaude(app, 'c1');
    try {
      assert.deepEqual((await cc.call('list_agents')).data.map((m: any) => [m.name, m.status]), [['A', 'idle'], ['C', 'idle'], ['X', 'idle']]);
      const sent = await cc.call('send_message', { body: '@A @X chat from C' });
      assert.deepEqual(sent.data.deliveredTo, ['A', 'X']);
      await waitFor(() => turnsOf(app, a.id) === 3 && app.codex.delivered.length === 3, 'A and X got it');
      assert.equal(parseEnvelope(app.codex.delivered[2].text).from, 'C');
    } finally {
      await cc.close();
    }
    await waitFor(() => app.settled(cluster.id), 'all settled');
    br.close();
  } finally {
    await app.close();
  }
});

test('native 2: an offline member gets nothing and nothing later; once its bridge connects, deliveries go one ack at a time', async () => {
  const app = await startNativeHub();
  try {
    const { cluster, c } = await mixedCluster(app);
    assert.equal(await memberStatus(app, c.id), 'offline', 'no bridge yet');
    const off = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'while offline', to: [c.id] });
    assert.deepEqual(
      [(await deliveryOf(app, cluster.id, off.id, c.id)).state, (await deliveryOf(app, cluster.id, off.id, c.id)).error],
      ['offline', '成员离线，未投递'],
    );

    // Connecting sends nothing posted before; what comes after arrives in order, each after the previous ack.
    const br = await bridge(app.url, app.secret, 'c1');
    await waitFor(async () => (await memberStatus(app, c.id)) === 'idle', 'online');
    const m1 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'first', to: [c.id] });
    const m2 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C second' });
    await waitFor(() => br.events.length === 1, 'first deliver');
    assert.equal(br.events[0].text, 'first');
    assert.equal(await memberStatus(app, c.id), 'busy', 'waiting for the ack');
    assert.deepEqual(await br.ack(br.events[0].deliveryId), { acked: true });
    await waitFor(() => br.events.length === 2, 'second deliver');
    assert.equal(parseEnvelope(br.events[1].text).body, '@C second');
    await br.ack(br.events[1].deliveryId);
    await waitFor(async () => (await deliveryOf(app, cluster.id, m2.id, c.id)).state === 'done', 'second done');
    assert.equal((await deliveryOf(app, cluster.id, m1.id, c.id)).state, 'done');
    assert.equal(await memberStatus(app, c.id), 'idle');
    assert.deepEqual(await br.ack(br.events[1].deliveryId), { acked: false }, 'an ack counts once');
    assert.equal(app.claude.delivered.length, 2, 'the message posted while offline was never sent');

    // A failed ack fails the delivery; a newer stream replaces the old one.
    const m3 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'third', to: [c.id] });
    await waitFor(() => br.events.length === 3, 'third deliver');
    await br.ack(br.events[2].deliveryId, false, 'inbox write failed');
    await waitFor(async () => (await deliveryOf(app, cluster.id, m3.id, c.id)).state === 'failed', 'third failed');
    assert.equal((await deliveryOf(app, cluster.id, m3.id, c.id)).error, 'inbox write failed');
    const br2 = await bridge(app.url, app.secret, 'c1', { autoAck: true });
    await waitFor(() => br.ended(), 'old stream closed by the new one');
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'fourth', to: [c.id] });
    await waitFor(() => br2.events.length === 1, 'new stream gets it');
    assert.equal(br.events.length, 3);

    // Disconnecting makes the member offline again.
    br2.close();
    await waitFor(async () => (await memberStatus(app, c.id)) === 'offline', 'offline after disconnect');
    await waitFor(() => app.settled(cluster.id), 'settled');

    // The bridge secret appears in no event, API response, SSE replay or database file.
    const ac = new AbortController();
    const sse = await fetch(app.url + '/api/stream', { signal: ac.signal });
    const reader = sse.body!.getReader();
    let streamed = '';
    while (!streamed.includes('"kind":"pause"') && !streamed.includes('fourth')) streamed += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    const outputs = [
      JSON.stringify(await app.api('GET', '/api/state')),
      JSON.stringify(await app.messages(cluster.id)),
      JSON.stringify(await app.api('GET', `/api/members/${c.id}/events`)),
      JSON.stringify(app.store.listEvents(0)),
      streamed,
    ];
    for (const out of outputs) assert.ok(!out.includes(app.secret), 'secret leaked');
  } finally {
    await app.close();
  }
  assert.ok(!readFileSync(join(app.dir, 'test.db')).includes(app.secret), 'secret in the database file');
});

test('native 2b: a push without an ack within bridgeAckMs fails the delivery', async () => {
  const app = await startNativeHub({ bridgeAckMs: 100 });
  try {
    const { cluster, c } = await mixedCluster(app);
    const br = await bridge(app.url, app.secret, 'c1');   // never acks
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'x', to: [c.id] });
    await waitFor(async () => (await deliveryOf(app, cluster.id, m.id, c.id)).state === 'failed', 'timed out');
    assert.match((await deliveryOf(app, cluster.id, m.id, c.id)).error!, /did not ack within 100 ms/);
    assert.deepEqual(await br.ack(br.events[0].deliveryId), { acked: false }, 'a late ack changes nothing');
    br.close();
  } finally {
    await app.close();
  }
});

test('native discovery: hub.json has url, secret and pid; the secret is reused on restart; hub.json goes on close', async () => {
  const dir = tempDir();
  const first = await startTestHub({ dir });
  const home = first.home;
  const d1 = JSON.parse(readFileSync(join(home, 'hub.json'), 'utf8'));
  await first.close();
  assert.deepEqual(Object.keys(d1), ['url', 'secret', 'pid']);
  assert.match(d1.secret, /^[0-9a-f]{64}$/);
  assert.deepEqual([d1.url, d1.pid], [first.url, process.pid]);
  assert.equal(existsSync(join(home, 'hub.json')), false, 'removed on close');
  const second = await startTestHub({ dir });
  try {
    assert.equal(JSON.parse(readFileSync(join(home, 'hub.json'), 'utf8')).secret, d1.secret);
  } finally {
    await second.close();
  }
});

test('native 4: wrong or missing secret is 401; a conversation that is no member writes nothing; no bearer tokens', async () => {
  const app = await startNativeHub();
  try {
    const { cluster, a } = await mixedCluster(app);
    const wrong = 'f'.repeat(64);
    // /mcp
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': wrong, 'x-orrery-session': 'c1' }), 401);
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': wrong }), 401);
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': app.secret.slice(1) }), 401);
    assert.equal(await mcpStatus(app.url, { 'x-orrery-session': 'c1' }), 401, 'session without secret');
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': app.secret, 'x-orrery-session': 'c1' }), 200);
    // A Bearer header names nobody: alone it is 401, next to a good secret the bridge identity is what counts.
    assert.equal(await mcpStatus(app.url, { authorization: 'Bearer nope' }), 401);
    assert.equal(await mcpStatus(app.url, { authorization: 'Bearer nope', 'x-orrery-bridge': app.secret, 'x-orrery-session': 'c1' }), 200);
    // /bridge/*
    assert.equal((await bridge(app.url, wrong, 'c1')).status, 401);
    assert.equal(await memberStatus(app, (await app.api('GET', '/api/state')).members[1].id), 'offline', 'a rejected stream is not online');
    const ack = await fetch(`${app.url}/bridge/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"deliveryId":"x","ok":true}' });
    assert.equal(ack.status, 401);

    const count = () => (app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const before = count();
    // A Claude session and a Codex thread that are in no cluster.
    for (const client of [await asClaude(app, 'c2'), await asCodex(app, 't2'), await asCodex(app, '')]) {
      try {
        assert.deepEqual((await client.call('list_agents')).data, []);
        for (const [tool, args] of [['send_message', { body: '@A hi' }], ['read_messages', {}]] as const) {
          const r = await client.call(tool, args);
          assert.deepEqual([r.isError, r.text], [true, '这个对话还不是任何 orrery 集群的成员']);
        }
      } finally {
        await client.close();
      }
    }
    // Harnesses do not mix: A's session is a mock one (not claude), c1 is claude (not codex).
    for (const client of [await asClaude(app, a.workerSessionId), await asCodex(app, 'c1')]) {
      try {
        assert.equal((await client.call('send_message', { body: '@C hi' })).isError, true);
      } finally {
        await client.close();
      }
    }
    assert.equal(count(), before, 'nothing written');
    assert.deepEqual(await app.messages(cluster.id), []);

    // The Codex identity works per call through _meta.threadId.
    const x = await asCodex(app, 't1');
    try {
      assert.deepEqual((await x.call('send_message', { body: 'from X' })).data.deliveredTo, []);
      assert.equal((await app.messages(cluster.id))[0].from, (await app.api('GET', '/api/state')).members[2].id);
    } finally {
      await x.close();
    }
  } finally {
    await app.close();
  }
});

test('native 5: chain attribution for native senders follows the three rules', async () => {
  const app = await startNativeHub();
  try {
    const { cluster, a, c, x } = await mixedCluster(app);
    await app.api('POST', '/api/pause', { paused: true });   // only C's deliveries matter; A and X stay queued
    const br = await bridge(app.url, app.secret, 'c1', { autoAck: true });
    const cc = await asClaude(app, 'c1');
    const msg = async (id: string) => (await app.messages(cluster.id)).find((m) => m.id === id)!;
    try {
      // Rule 3: nothing was ever delivered to C → a new chain at hop 0. Native senders need no running turn.
      const fresh = (await cc.call('send_message', { body: 'nothing delivered yet' })).data;
      const m0 = await msg(fresh.messageId);
      assert.deepEqual([m0.chainId, m0.hop], [m0.id, 0]);

      await app.api('POST', '/api/pause', { paused: false });
      const u1 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'u1', to: [c.id] });
      const u2 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'u2', to: [c.id] });
      const ux = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'only X', to: [x.id] });
      await waitFor(() => app.settled(cluster.id), 'delivered');

      // Rule 2: no replyTo → the newest message delivered to C (u2).
      const r2 = await msg((await cc.call('send_message', { body: 'no replyTo' })).data.messageId);
      assert.deepEqual([r2.chainId, r2.hop], [u2.chainId, 1]);
      // Rule 1: replyTo a message delivered to C → that chain.
      const r1 = await msg((await cc.call('send_message', { body: 'answer u1', replyTo: u1.id })).data.messageId);
      assert.deepEqual([r1.chainId, r1.hop, r1.replyTo], [u1.chainId, 1, u1.id]);
      // replyTo a message never delivered to C → rule 2 again.
      const rx = await msg((await cc.call('send_message', { body: 'answer X', replyTo: ux.id })).data.messageId);
      assert.deepEqual([rx.chainId, rx.hop], [u2.chainId, 1]);
      // Another cluster's message is refused as before.
      assert.equal((await cc.call('send_message', { body: 'x', replyTo: 'nope' })).isError, true);
      assert.ok(a);
    } finally {
      await cc.close();
      br.close();
    }
  } finally {
    await app.close();
  }
});

test('native 5: hop limit, chain turn limit, hourly limit and pause hold for native deliveries', async () => {
  const app = await startNativeHub({ maxHops: 1, maxTurnsPerChain: 2, maxTurnsPerHour: 2 });
  try {
    const { cluster, c, x } = await mixedCluster(app);
    const post = (body: string, to: string[]) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body, to });
    const state = async (id: string, member: string) => (await deliveryOf(app, cluster.id, id, member)).state;

    // Hop limit: user → X (hop 0) → X says @C (hop 1) → C answers @X (hop 2 > 1): rejected with a guard event.
    const u = await post('start', [x.id]);
    await waitFor(async () => (await state(u.id, x.id)) === 'done', 'X got it');
    const xc = await asCodex(app, 't1');
    const cc = await asClaude(app, 'c1');
    try {
      const br = await bridge(app.url, app.secret, 'c1', { autoAck: true });
      await waitFor(async () => (await memberStatus(app, c.id)) === 'idle', 'C online');
      const hop1 = await xc.call('send_message', { body: '@C over to you' });
      assert.equal(hop1.isError, false);
      await waitFor(async () => (await state(hop1.data.messageId, c.id)) === 'done', 'C got hop 1');
      const hop2 = await cc.call('send_message', { body: '@X back' });
      assert.deepEqual([hop2.isError, hop2.text], [true, 'rejected: hop 2 exceeds the limit of 1 for this message chain']);
      assert.ok(app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_hops' && e.memberId === c.id));
      br.close();
      await waitFor(async () => (await memberStatus(app, c.id)) === 'offline', 'C offline');
    } finally {
      await xc.close();
      await cc.close();
    }

    // Chain turn limit (2): that chain already had 2 deliveries started (X, then C), so a third fails unstarted.
    // Hourly limit (2): X has used 1; one more is allowed, the next waits with a guard event.
    const both = await post('two', [x.id]);
    await waitFor(async () => (await state(both.id, x.id)) === 'done', 'X second');
    const third = await post('three', [x.id]);
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'), 'hourly guard');
    assert.equal(await state(third.id, x.id), 'queued');
    assert.equal(app.codex.delivered.length, 2);
    const xm = await asCodex(app, 't1');
    try {
      // X's newest delivered message is "two" (its own chain, 1 turn so far). Replying to "start" uses that chain: 2 turns.
      const br = await bridge(app.url, app.secret, 'c1', { autoAck: true });   // online: an offline C would end it 'offline'
      await waitFor(async () => (await memberStatus(app, c.id)) === 'idle', 'C online');
      const late = await xm.call('send_message', { body: '@C late', replyTo: u.id });
      assert.equal(late.isError, false);
      await waitFor(async () => (await state(late.data.messageId, c.id)) === 'failed', 'chain limit');
      assert.equal((await deliveryOf(app, cluster.id, late.data.messageId, c.id)).error, '链轮次超限');
      br.close();
    } finally {
      await xm.close();
    }

    // Pause: an online native member gets nothing while paused, and its queue moves on unpause.
    await app.api('POST', '/api/pause', { paused: true });
    const br = await bridge(app.url, app.secret, 'c1', { autoAck: true });
    const p = await post('paused', [c.id]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await state(p.id, c.id), 'queued');
    assert.equal(br.events.length, 0);
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => br.events.length === 1, 'delivered after unpause');
    assert.equal(br.events[0].text, 'paused');
    br.close();
  } finally {
    await app.close();
  }
});

test('native 6: a user message sent with `to` = exactly one native member arrives without the envelope', async () => {
  const app = await startNativeHub();
  try {
    const { cluster, a, c, x } = await mixedCluster(app);
    const br = await bridge(app.url, app.secret, 'c1', { autoAck: true });
    const post = (body: unknown) => app.api('POST', `/api/clusters/${cluster.id}/messages`, body);
    const typed = '帮我看看 @A 这个函数\n第二行';
    await post({ body: typed, to: [c.id] });
    await post({ body: 'plain for X', to: [x.id] });
    await waitFor(() => br.events.length === 1 && app.codex.delivered.length === 1, 'direct deliveries');
    assert.equal(br.events[0].text, typed, 'exactly as typed: no envelope, @A not routed');
    assert.equal(app.codex.delivered[0].text, 'plain for X');
    assert.equal(turnsOf(app, a.id), 0, 'A got nothing');

    // Everything else keeps the envelope: two recipients, an @-mention without `to`.
    await post({ body: 'to both', to: [c.id, x.id] });
    await post({ body: '@C mention' });
    await post({ body: 'chat to A', to: [a.id] });
    await waitFor(() => app.settled(cluster.id), 'settled');
    assert.deepEqual(br.events.slice(1).map((e) => parseEnvelope(e.text).body), ['to both', '@C mention']);
    assert.equal(parseEnvelope(app.codex.delivered[1].text).body, 'to both');
    assert.equal(app.native.delivered.at(-1)!.text, 'chat to A', 'A\'s page is a direct message too');
    br.close();
  } finally {
    await app.close();
  }
});

test('native create: allowed only when the adapter can create; model and effort recorded', async () => {
  const app = await startNativeHub();
  try {
    const create = (members: unknown[]) =>
      fetch(app.url + '/api/clusters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'n', members }) });
    const noCreate = await create([{ harness: 'claude', mode: 'native' }]);
    assert.equal(noCreate.status, 400);
    assert.match((await noCreate.json()).error, /claude native members can only attach an existing conversation/);
    assert.equal((await create([{ harness: 'codex', mode: 'native', projectPath: '/work', effort: 'bad effort' }])).status, 400);

    const { members: [x, i] } = await (await create([
      { harness: 'codex', mode: 'native', projectPath: join(app.dir, 'n'), model: 'gpt-x', effort: 'high', name: 'NX' },
      { harness: 'mock', mode: 'native', model: 'mock-big', effort: 'low', name: 'I', projectPath: '/work' },
    ])).json();
    assert.deepEqual([x.origin, x.model, x.effort, x.name], ['created', 'gpt-x', 'high', 'NX']);
    assert.deepEqual(app.codex.created, [{ cwd: join(app.dir, 'n'), title: 'orrery: n', model: 'gpt-x', effort: 'high', memberName: 'NX' }]);
    assert.deepEqual([i.origin, i.model, i.effort], ['created', 'mock-big', 'low']);
    assert.deepEqual([app.native.created[0].model, app.native.created[0].effort, app.native.created[0].memberName], ['mock-big', 'low', 'I']);
  } finally {
    await app.close();
  }
});

test('native create: with a model or effort the member name is settled first and passed on (for the init turn); without, not', async () => {
  const app = await startNativeHub();
  try {
    const { members } = await app.api('POST', '/api/clusters', {
      name: 'names',
      members: [
        { harness: 'codex', mode: 'native', projectPath: '/work', model: 'gpt-x' },
        { harness: 'codex', mode: 'native', projectPath: '/work', model: 'gpt-x' },
        { harness: 'codex', mode: 'native', projectPath: '/work', effort: 'high', name: 'E' },
        { harness: 'codex', mode: 'native', projectPath: '/work' },
      ],
    });
    assert.deepEqual(members.map((m: any) => m.name), ['gpt-x', 'gpt-x-2', 'E', 'mock-1']);
    assert.deepEqual(app.codex.created.map((c) => c.memberName), ['gpt-x', 'gpt-x-2', 'E', undefined]);
  } finally {
    await app.close();
  }
});

// ───────────── shared bridge streams and the harness header (docs/adapters/deepseek.md, "桥协议的扩展") ─────────────

/** Cluster "ds": native claude C (c1), native deepseek D1 (d1) and D2 (d2). */
async function deepseekCluster(app: NativeHub) {
  const { cluster, members: [c, d1, d2] } = await app.api('POST', '/api/clusters', {
    name: 'ds',
    members: [
      { harness: 'claude', mode: 'native', sessionId: 'c1', name: 'C' },
      { harness: 'deepseek', mode: 'native', sessionId: 'd1', name: 'D1' },
      { harness: 'deepseek', mode: 'native', sessionId: 'd2', name: 'D2' },
    ],
  });
  return { cluster, c, d1, d2 };
}

test('native 7: a shared stream puts every session of its harness online and tags each deliver with its sessionId', async () => {
  const app = await startNativeHub();
  try {
    const { cluster, c, d1, d2 } = await deepseekCluster(app);
    const post = (body: string, to?: string[]) => app.api('POST', `/api/clusters/${cluster.id}/messages`, to ? { body, to } : { body });
    assert.equal(await memberStatus(app, d1.id), 'offline', 'no stream yet');

    // A malformed stream request is refused and puts nobody online.
    for (const q of ['session=d1', 'harness=deepseek&session=', 'harness=']) {
      const res = await fetch(`${app.url}/bridge/stream?${q}`, { headers: { 'x-orrery-bridge': app.secret } });
      await res.body?.cancel();
      assert.equal(res.status, 400, q);
    }
    assert.equal(await memberStatus(app, d1.id), 'offline');

    const shared = await bridge(app.url, app.secret, null, { harness: 'deepseek' });
    assert.equal(shared.status, 200);
    await waitFor(async () => (await memberStatus(app, d1.id)) === 'idle' && (await memberStatus(app, d2.id)) === 'idle', 'd1 and d2 online');
    assert.equal(await memberStatus(app, c.id), 'offline', 'another harness is not covered');

    const m1 = await post('to d1', [d1.id]);
    await waitFor(() => shared.events.length === 1, 'deliver for d1');
    assert.equal(shared.events[0].sessionId, 'd1');
    assert.equal(shared.events[0].text, 'to d1');
    await shared.ack(shared.events[0].deliveryId);
    await waitFor(async () => (await deliveryOf(app, cluster.id, m1.id, d1.id)).state === 'done', 'd1 done');
    const m2 = await post('@D2 your turn');
    await waitFor(() => shared.events.length === 2, 'deliver for d2');
    assert.equal(shared.events[1].sessionId, 'd2');
    await shared.ack(shared.events[1].deliveryId, false, 'session/writer-held');
    await waitFor(async () => (await deliveryOf(app, cluster.id, m2.id, d2.id)).state === 'failed', 'd2 failed');
    assert.equal((await deliveryOf(app, cluster.id, m2.id, d2.id)).error, 'session/writer-held');

    // A per-session stream also tags its delivers (old bridges ignore the extra field).
    const own = await bridge(app.url, app.secret, 'c1', { autoAck: true });
    await post('to c', [c.id]);
    await waitFor(() => own.events.length === 1, 'deliver for c1');
    assert.equal(own.events[0].sessionId, 'c1');

    // A newer shared stream replaces the older; closing it takes the whole harness offline.
    const shared2 = await bridge(app.url, app.secret, null, { harness: 'deepseek', autoAck: true });
    await waitFor(() => shared.ended(), 'old shared stream closed by the new one');
    await post('to d1 again', [d1.id]);
    await waitFor(() => shared2.events.length === 1, 'new shared stream gets it');
    assert.equal(shared.events.length, 2);
    shared2.close();
    await waitFor(async () => (await memberStatus(app, d1.id)) === 'offline' && (await memberStatus(app, d2.id)) === 'offline', 'offline after disconnect');
    assert.equal(await memberStatus(app, c.id), 'idle', "c1's own stream is untouched");
    const off = await post('while offline', [d2.id]);
    assert.equal((await deliveryOf(app, cluster.id, off.id, d2.id)).state, 'offline');
    await waitFor(() => app.settled(cluster.id), 'settled');
    own.close();
  } finally {
    await app.close();
  }
});

test('native 8: x-orrery-harness picks the harness of x-orrery-session; without it the caller is claude; harnesses do not mix', async () => {
  const app = await startNativeHub();
  try {
    const { cluster, c, d1 } = await deepseekCluster(app);
    const as = (session: string, harness?: string) =>
      nativeClient(app.url, { 'x-orrery-bridge': app.secret, 'x-orrery-session': session, ...(harness === undefined ? {} : { 'x-orrery-harness': harness }) });
    const from = async () => (await app.messages(cluster.id)).at(-1)!.from;

    for (const [session, harness, id] of [['d1', 'deepseek', d1.id], ['c1', undefined, c.id], ['c1', 'claude', c.id]] as const) {
      const client = await as(session, harness);
      try {
        assert.equal((await client.call('send_message', { body: `from ${session}` })).isError, false);
        assert.equal(await from(), id);
      } finally {
        await client.close();
      }
    }
    // A session id under the wrong harness (or under none, which means claude) is no member.
    for (const [session, harness] of [['c1', 'deepseek'], ['d1', undefined], ['d1', 'claude']] as const) {
      const client = await as(session, harness);
      try {
        const r = await client.call('send_message', { body: 'nope' });
        assert.deepEqual([r.isError, r.text], [true, '这个对话还不是任何 orrery 集群的成员']);
      } finally {
        await client.close();
      }
    }
    assert.equal((await app.messages(cluster.id)).length, 3);
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': app.secret, 'x-orrery-session': 'd1', 'x-orrery-harness': '' }), 401);
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': 'f'.repeat(64), 'x-orrery-session': 'd1', 'x-orrery-harness': 'deepseek' }), 401);
  } finally {
    await app.close();
  }
});
