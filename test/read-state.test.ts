// Batched delivery and read state (docs/architecture.md「调度」「read_messages」, docs/native-mode.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hub, type Limits } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { defaultScript, parseEnvelopes, type MockScript } from './mock.ts';
import { createMockNativeAdapter, type MockNativeOptions } from '../src/adapters/mock/native.ts';
import type { HubEvent, Message } from '../src/core/types.ts';
import { fixtureNativeMock, holdScript, startTestHub, tempDir, waitFor } from './helpers.ts';

/** An in-process Hub (no HTTP) with native mock members A (session s1) and B (s2); paused, so nothing runs yet. */
async function nativeHub(opts: { store?: Store; dir?: string; native?: MockNativeOptions; limits?: Partial<Limits> } = {}) {
  const dir = opts.dir ?? tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions, ...opts.native });
  const store = opts.store ?? new Store(':memory:');
  const hub = new Hub({ store, nativeAdapters: { mock: native },
    limits: { messageWindowMs: 0, ...opts.limits } });   // no member-message window, as in startTestHub
  const events: HubEvent[] = [];
  hub.subscribe((e) => events.push(e));
  hub.start();   // no isolated turn runs in these tests
  return { dir, native, store, hub, events };
}

const deliveriesOf = (store: Store, clusterId: string) =>
  store.withDeliveries(store.listMessages(clusterId, 100)).flatMap((m) => m.deliveries);
const stateOf = (store: Store, messageId: string) => store.withDeliveries([store.getMessage(messageId)!])[0].deliveries[0];
/** A native onDeliver that never finishes on its own: it fails when the Hub aborts it. */
const hang: MockNativeOptions['onDeliver'] = (_s, _t, ctx) =>
  new Promise((_ok, fail) => ctx.signal.addEventListener('abort', () => fail(new Error('aborted')), { once: true }));

/** Three native nativeAdapters: A needs a fresh online check, B is offline, S sends without sharing A's online checks. */
async function postFixture() {
  const dir = tempDir();
  const session = (id: string) => ({ id, title: id, model: null, cwd: dir, updatedAt: null });
  const checked = createMockNativeAdapter({ harness: 'checked', sessions: [session('a')] });
  const offline = createMockNativeAdapter({ harness: 'offline', kind: 'bridge', sessions: [session('b')] });
  const senderNative = createMockNativeAdapter({ harness: 'sender', kind: 'bridge', sessions: [session('s')] });
  const store = new Store(':memory:');
  let checks = 0;
  checked.confirmOnline = async () => { checks++; return true; };
  const hub = new Hub({ store, nativeAdapters: { checked, offline, sender: senderNative },
    limits: { startupGraceMs: 0, messageWindowMs: 0 } });
  const events: HubEvent[] = [];
  hub.subscribe((e) => events.push(e));
  hub.start();
  const { cluster, members: [a, b, sender] } = await hub.createCluster('c', [
    { harness: 'checked', mode: 'native', sessionId: 'a', name: 'A' },
    { harness: 'offline', mode: 'native', sessionId: 'b', name: 'B' },
    { harness: 'sender', mode: 'native', sessionId: 's', name: 'S' },
  ]);
  const file = { id: randomUUID(), clusterId: cluster.id, uploader: 'user', name: 'note.txt', mime: 'application/octet-stream',
    size: 1, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() };
  store.insertFile(file);
  events.length = 0;
  return { hub, store, checked, offline, cluster, a, b, sender, file, events, checks: () => checks };
}

test('post: event-write failure rolls back all rows and pending state through each send entry point', async (t) => {
  for (const entry of ['user mentions', 'user direct', 'member mentions'] as const) {
    await t.test(entry, async () => {
      const f = await postFixture();
      const { hub, store, cluster, a, b, sender, file, events, checked, offline } = f;
      const send = () => entry === 'user mentions' ? hub.sendFromUser(cluster.id, '@A @B hello', undefined, [file.id])
        : entry === 'user direct' ? hub.sendFromUser(cluster.id, 'hello', [a.id], [file.id])
        : hub.sendFromMember(sender.id, '@A @B hello', undefined, [file.id]).message;
      const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const before = ['messages', 'deliveries', 'message_files', 'events'].map(count);
      const appendEvent = store.appendEvent;
      let attemptedStates: string[] = [];
      try {
        store.appendEvent = (...args) => {
          const event = appendEvent.apply(store, args);
          if (args[2] === 'message') {
            attemptedStates = (args[3] as { deliveries: { state: string }[] }).deliveries.map((d) => d.state);
            assert.equal(count('message_files'), 1, 'attachment was linked before the injected failure');
            throw new Error('injected message event failure');
          }
          return event;
        };
        assert.throws(send, /injected message event failure/);
        store.appendEvent = appendEvent;
        assert.deepEqual(attemptedStates, entry === 'user direct' ? ['queued'] : ['queued', 'offline']);
        assert.deepEqual(['messages', 'deliveries', 'message_files', 'events'].map(count), before, 'all writes rolled back');
        assert.equal((hub as any).pending.size, 0, 'no ghost pending delivery');
        assert.equal(f.checks(), 0, 'no online confirmation after a rollback');
        assert.equal(events.length, 0, 'listeners heard nothing');
        assert.equal(checked.delivered.length + offline.delivered.length, 0, 'no adapter delivery after a rollback');

        const message = send();
        const payload = (events.find((e) => e.kind === 'message')!.payload as any);
        assert.deepEqual(payload.deliveries.map((d: { state: string }) => d.state), attemptedStates);
        assert.deepEqual(store.attachmentsOf(message.id), [file]);
        assert.equal(store.isDirect(message.id), entry === 'user direct');
        await waitFor(() => stateOf(store, message.id).state === 'done', 'freshly confirmed delivery');
        assert.equal(f.checks(), 1);
        assert.equal(checked.delivered.length, 1);
        if (entry !== 'user direct') {
          assert.equal(deliveriesOf(store, cluster.id).find((d) => d.memberId === b.id)!.state, 'offline');
        }
      } finally {
        store.appendEvent = appendEvent;
        await hub.close();
        store.close();
      }
    });
  }
});

test('post: a listener error after commit leaves a successful send and schedules delivery', async () => {
  const f = await postFixture();
  const { hub, store, cluster, a, checked } = f;
  let transactionDepth: number | undefined;
  const stop = hub.subscribe((e) => {
    if (e.kind === 'message') {
      transactionDepth = (store as any).depth;
      throw new Error('listener failed after commit');
    }
  });
  try {
    const message = hub.sendFromUser(cluster.id, 'hello', [a.id]);
    stop();
    assert.equal(transactionDepth, 0, 'listener runs after the transaction commits');
    assert.equal(store.listMessages(cluster.id, 10)[0]?.id, message.id, 'the returned message was committed');
    assert.equal(store.listEvents(0).filter((e) => e.kind === 'message').length, 1);
    assert.equal(f.checks(), 1, 'the committed delivery still gets its online check');
    await waitFor(() => stateOf(store, message.id).state === 'done', 'delivery after listener error');
    assert.equal(checked.delivered.length, 1);
  } finally {
    stop();
    await hub.close();
    store.close();
  }
});

test('batch: three messages queued for a busy member go out in one turn when it frees up', async () => {
  const hold = holdScript();
  const inputs: string[] = [];
  const recording: MockScript = (msg, ...rest) => {
    if (!inputs.includes(msg.raw)) inputs.push(msg.raw);
    return hold.script(msg, ...rest);
  };
  const app = await startTestHub({ mock: { script: recording } });
  try {
    const { cluster, members: [a] } = await app.cluster('c', ['A']);
    const send = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
    await send('@A hold');
    await waitFor(() => app.native.delivered.length === 1, 'first turn running');
    const queued = [await send('@A one'), await send('@A two'), await send('@A three')];
    hold.release();
    await waitFor(() => app.settled(cluster.id), 'all handled');

    assert.equal(app.native.delivered.length, 2, 'one adapter call for the three queued messages');
    assert.deepEqual(parseEnvelopes(inputs[1]).map((e) => [e.messageId, e.body]), queued.map((m) => [m.id, m.body]));
    assert.match(inputs[1], /\n\n-{10}\n（你是群员 A。.*上面共 3 条消息，回复哪一条就带 replyTo=那条的 messageId/);
    assert.equal(inputs[1].match(/-{10}/g)!.length, 1, 'one note for the whole batch');
    const ds = (await app.messages(cluster.id)).slice(1).map((m) => m.deliveries[0]);
    assert.deepEqual(ds.map((d) => d.state), ['done', 'done', 'done']);
    assert.deepEqual(ds.map((d) => d.batchId), [ds[0].id, ds[0].id, ds[0].id], 'the batch id is its first delivery id');
    assert.equal((app.hub as any).turnStarts.get(JSON.stringify(['native', a.harness, a.workerSessionId])).length, 2, 'the batch is one turn for the per-hour limit');
    const agent = app.events.filter((e) => e.kind === 'agent' && (e.payload as any).deliveryId === ds[0].id);
    assert.ok(agent.length > 0 && agent.every((e) => (e.payload as any).messageId === queued[0].id), 'agent output goes to the first delivery');
  } finally {
    await app.close();
  }
});

test('batch: an isolated reply continues the chain of its replyTo within the batch', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  try {
    const { cluster } = await app.cluster('c', ['A']);
    const send = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
    await send('@A hold');
    await waitFor(() => app.native.delivered.length === 1, 'first turn running');
    const [x, y] = [await send('@A ping x'), await send('@A ping y')];
    hold.release();
    await waitFor(async () => (await app.messages(cluster.id)).length === 5 && app.settled(cluster.id), 'pongs');
    const pongs = (await app.messages(cluster.id)).slice(3);
    assert.deepEqual(pongs.map((m) => [m.body, m.replyTo, m.chainId, m.hop]), [['@user pong x', x.id, x.id, 1], ['@user pong y', y.id, y.id, 1]]);
  } finally {
    await app.close();
  }
});

test('batch: a delivery whose chain is over the limit fails alone; the rest still go together', async () => {
  const { hub, store, native, events } = await nativeHub({ limits: { maxTurnsPerChain: 1 } });
  try {
    hub.setPaused(true);
    const { cluster, members: [a] } = await hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const first = hub.sendFromUser(cluster.id, '@A first');
    // Same chain as `first`: once `first` takes the chain's one turn, this one is over the limit.
    const over: Message = { ...first, id: 'over', body: '@A over', hop: 1, createdAt: new Date().toISOString() };
    store.insertMessage(over, [a.id]);
    const other = hub.sendFromUser(cluster.id, '@A other');
    hub.setPaused(false);
    await waitFor(() => deliveriesOf(store, cluster.id).every((d) => d.state === 'done' || d.state === 'failed'), 'settled');
    assert.equal(native.delivered.length, 1);
    assert.deepEqual(parseEnvelopes(native.delivered[0].text).map((e) => e.body), ['@A first', '@A other']);
    assert.deepEqual([stateOf(store, first.id).state, stateOf(store, 'over').state, stateOf(store, other.id).state], ['done', 'failed', 'done']);
    assert.equal(stateOf(store, 'over').error, '链轮次超限');
    assert.equal(events.filter((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_chain').length, 1);
  } finally {
    await hub.close();
  }
});

test('batch: a native direct message is never batched, and a batch stops before one', async () => {
  const { hub, store, native } = await nativeHub();
  try {
    hub.setPaused(true);
    const { cluster, members: [a] } = await hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    hub.sendFromUser(cluster.id, 'direct 1', [a.id]);
    hub.sendFromUser(cluster.id, '@A env 1');
    hub.sendFromUser(cluster.id, 'direct 2', [a.id]);
    hub.sendFromUser(cluster.id, '@A env 2');
    hub.sendFromUser(cluster.id, '@A env 3');
    hub.setPaused(false);
    await waitFor(() => deliveriesOf(store, cluster.id).every((d) => d.state === 'done'), 'all done');
    const runs = native.delivered.map((d) => (d.text.startsWith('[orrery]') ? parseEnvelopes(d.text).map((e) => e.body) : d.text));
    assert.deepEqual(runs, ['direct 1', ['@A env 1'], 'direct 2', ['@A env 2', '@A env 3']]);
  } finally {
    await hub.close();
  }
});

test('batch: after a restart the interrupted batch is unknown and queued work is delivered separately', async () => {
  const dir = tempDir();
  const store = new Store(join(dir, 'restart.db'));
  const first = await nativeHub({ store, dir, native: { onDeliver: hang } });
  const { cluster, members: [a] } = await first.hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
  first.hub.setPaused(true);
  const m1 = first.hub.sendFromUser(cluster.id, '@A one');
  const m2 = first.hub.sendFromUser(cluster.id, '@A two');
  first.hub.setPaused(false);
  await waitFor(() => stateOf(store, m2.id).state === 'running', 'batch running');
  const batchId = stateOf(store, m1.id).id;
  const m3 = first.hub.sendFromUser(cluster.id, '@A three');   // queued while the batch runs
  await first.hub.close();   // the Hub goes away mid-delivery

  const second = await nativeHub({ store, dir, native: { onDeliver: async () => 'completed' } });
  try {
    await waitFor(() => stateOf(store, m3.id).state === 'done', 'queued work done');
    const runs = second.native.delivered.map((d) => [d.deliveryId, parseEnvelopes(d.text).map((e) => e.messageId)]);
    const d3 = stateOf(store, m3.id);
    assert.deepEqual(runs, [[d3.id, [m3.id]]], 'only the never-started message is delivered');
    assert.deepEqual([m1, m2].map((m) => [stateOf(store, m.id).state, stateOf(store, m.id).outcome]), [['failed', 'unknown'], ['failed', 'unknown']]);
    assert.deepEqual([m1, m2, m3].map((m) => stateOf(store, m.id).batchId), [batchId, batchId, d3.id]);
    assert.equal(a.id, stateOf(store, m3.id).memberId);
  } finally {
    await second.hub.close();
    store.close();
  }
});

test('batch: removing a member cancels every delivery of its running batch; the late result changes nothing', async () => {
  const { hub, store, events } = await nativeHub({ native: { onDeliver: hang } });
  try {
    hub.setPaused(true);
    const { cluster, members: [a] } = await hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const msgs = [hub.sendFromUser(cluster.id, '@A one'), hub.sendFromUser(cluster.id, '@A two')];
    hub.setPaused(false);
    await waitFor(() => msgs.every((m) => stateOf(store, m.id).state === 'running'), 'batch running');
    hub.removeMember(cluster.id, a.id);
    await new Promise((ok) => setTimeout(ok, 30));   // the aborted delivery settles
    assert.deepEqual(msgs.map((m) => [stateOf(store, m.id).state, stateOf(store, m.id).outcome]),
      [['failed', 'unknown'], ['failed', 'unknown']]);
    assert.equal(events.filter((e) => e.kind === 'read').length, 0);
  } finally {
    await hub.close();
  }
});

test('batch: a native reply without replyTo continues the chain of the newest message of its batch', async () => {
  const { hub, store, native } = await nativeHub({ native: { onDeliver: async () => 'accepted' } });
  try {
    hub.setPaused(true);
    const { cluster, members: [a] } = await hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const [m1, m2] = [hub.sendFromUser(cluster.id, '@A one'), hub.sendFromUser(cluster.id, '@A two')];
    hub.setPaused(false);
    await waitFor(() => stateOf(store, m2.id).state === 'done', 'delivered');
    assert.equal(native.delivered.length, 1);
    const reply = hub.sendFromMember(a.id, 'answer').message;
    assert.deepEqual([reply.chainId, reply.hop], [m2.id, 1]);
    const answer1 = hub.sendFromMember(a.id, 'answer to one', m1.id).message;
    assert.deepEqual([answer1.chainId, answer1.hop], [m1.id, 1]);
  } finally {
    await hub.close();
  }
});

test('read_messages: by default only unread messages that concern the caller; each comes back once', async () => {
  const { hub, store, events } = await nativeHub();
  try {
    hub.setPaused(true);   // no delivery runs: everything stays unread
    const { cluster, members: [a, b] } = await hub.createCluster('c', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }, { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const say = (body: string) => hub.sendFromUser(cluster.id, body);
    const all = [
      say('@A only a'), say('@all everyone'), say('plain note'), say('@B only b'),
      hub.sendFromMember(a.id, 'A thinking aloud').message, hub.sendFromMember(a.id, '@B from A').message,
      hub.sendFromMember(b.id, '@A own message').message, hub.sendFromMember(a.id, '@all from A').message,
    ];
    const bodies = (ms: Message[]) => ms.map((m) => m.body);
    assert.deepEqual(bodies(hub.readMessages(b.id, { limit: 2 })), ['@all everyone', 'plain note'], 'oldest first, up to limit');
    assert.deepEqual(bodies(hub.readMessages(b.id)), ['@B only b', '@B from A', '@all from A']);
    assert.deepEqual(hub.readMessages(b.id), [], 'a second call returns nothing new');
    const read = events.filter((e) => e.kind === 'read').map((e) => e.payload as any);
    assert.deepEqual(read.map((p) => [p.memberId, p.via, p.messageIds.length]), [[b.id, 'read_messages', 2], [b.id, 'read_messages', 3]]);
    // Reading does not touch the queued deliveries.
    assert.ok(deliveriesOf(store, cluster.id).every((d) => d.state === 'queued'));

    // history: every recent message, any sender, read or not; `before` pages back. Returned ones become read.
    assert.deepEqual(bodies(hub.readMessages(b.id, { history: true, limit: 3 })), bodies(all.slice(-3)));
    assert.deepEqual(bodies(hub.readMessages(b.id, { before: all[2].id })), bodies(all.slice(0, 2)));
    const readByB = (store.db.prepare('SELECT message_id, via FROM reads WHERE member_id = ?').all(b.id) as any[]);
    assert.ok(readByB.some((r) => r.message_id === all[0].id && r.via === 'read_messages'), '@A only a was read through history');
    assert.ok(!readByB.some((r) => r.message_id === all[6].id), 'its own message is not marked read');
    // A has '@A only a', '@all everyone', 'plain note', '@B ...' (not A's), its own (no), '@A own message'.
    assert.deepEqual(bodies(hub.readMessages(a.id)), ['@A only a', '@all everyone', 'plain note', '@A own message']);
  } finally {
    await hub.close();
  }
});

test('read state: a done delivery is read; the messages API and the SSE stream carry reads; the MCP tool takes history', async () => {
  const dir = tempDir();
  const sessions = ['a', 'b'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const claude = createMockNativeAdapter({ harness: 'claude', kind: 'queue', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude } });
  const clients: Client[] = [];
  try {
    const { cluster, members: [a, b] } = await app.api('POST', '/api/clusters', { name: 'c', members: [
      { harness: 'claude', mode: 'native', sessionId: 'a', name: 'A' }, { harness: 'claude', mode: 'native', sessionId: 'b', name: 'B' },
    ] });
    const hello = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hello' });
    const note = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'note for all' });
    await waitFor(() => app.settled(cluster.id), 'delivered');

    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    for (const id of ['a', 'b']) {
      const client = new Client({ name: 'read-state-test', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: { 'x-orrery-bridge': secret, 'x-orrery-session': id } } }));
      clients.push(client);
    }
    const read = async (client: Client, args = {}) =>
      JSON.parse(((await client.callTool({ name: 'read_messages', arguments: args })).content as any)[0].text).map((m: any) => m.body);
    assert.deepEqual(await read(clients[0]), ['note for all'], 'A already read "@A hello" through its delivery');
    assert.deepEqual(await read(clients[1]), ['note for all'], 'B: "@A hello" is not its business');
    assert.deepEqual(await read(clients[1]), []);
    assert.deepEqual(await read(clients[1], { history: true }), ['@A hello', 'note for all']);

    const listed = await app.messages(cluster.id);
    const reads = (id: string) => listed.find((m) => m.id === id)!.reads.map((r: any) => [r.memberId, r.via]);
    assert.deepEqual(reads(hello.id), [[a.id, 'delivery'], [b.id, 'read_messages']]);
    assert.deepEqual(reads(note.id).sort(), [[a.id, 'read_messages'], [b.id, 'read_messages']].sort());

    const ac = new AbortController();
    const sse = await fetch(app.url + '/api/stream', { signal: ac.signal });
    const reader = sse.body!.getReader();
    let streamed = '';
    while ((streamed.match(/"kind":"read"/g) ?? []).length < 4) streamed += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    const readEvents = streamed.split('\n').filter((l) => l.startsWith('data: ') && l.includes('"kind":"read"')).map((l) => JSON.parse(l.slice(6)).payload);
    assert.deepEqual(readEvents[0], { memberId: a.id, messageIds: [hello.id], via: 'delivery' });
    assert.deepEqual(readEvents.slice(1).map((p: any) => [p.memberId, p.via, p.messageIds]),
      [[a.id, 'read_messages', [note.id]], [b.id, 'read_messages', [note.id]], [b.id, 'read_messages', [hello.id]]]);
  } finally {
    for (const c of clients) await c.close();
    await app.close();
  }
});

test('envelope: a single message keeps the one-message format', async () => {
  const inputs: string[] = [];
  const recording: MockScript = (msg, ...rest) => (inputs.push(msg.raw), defaultScript(msg, ...rest));
  const app = await startTestHub({ mock: { script: recording } });
  try {
    const { cluster, members: [member] } = await app.cluster('c', ['A']);
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hi' });
    await waitFor(() => app.settled(cluster.id), 'done');
    assert.equal(inputs[0], `[orrery] cluster=c clusterId=${cluster.id} from=user messageId=${m.id} hop=0 to=@A\n@A hi\n\n----------\n`
      + `（你是群员 A。有 ack_messages 工具时，看到消息用 ack_messages 确认（👍 即收到），不要为确认单独发言；只有提问、交结果、报阻塞或请别人做事时才用 send_message；任务结果和证据写进 task_action submit 的 summary，Hub 会通知验收人，不用另外 @；需要改派或流程卡住时才 @ 协调员；回答别人问你的问题不要带 fyi；只是知会、不需要对方行动的发言带 fyi=true（对方只留未读，不被唤醒）；要让某人收到，正文里写 @名字，回复这条请带 replyTo=${m.id}。`
      + `不 @ 人的发言只留在群聊记录里。要发文件：先用你自己的工具把文件复制进你的 orrery 发件箱 ${join(app.home, 'outbox', member.id)}，再在 send_message 的 attachments 里写文件名（Hub 只复制，不会删掉发件箱里的文件）。这个群的 clusterId 是 ${cluster.id}；调用 orrery 工具时可带 clusterId 指定群。）`);
  } finally {
    await app.close();
  }
});

test('read state: a batch\'s done states and read receipts commit together; a failure in between leaves neither', async () => {
  const dir = tempDir();
  const store = new Store(join(dir, 'atomic.db'));
  const first = await nativeHub({ store, dir, native: { onDeliver: hang } });
  const { cluster, members: [a] } = await first.hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
  first.hub.setPaused(true);
  const msgs = [first.hub.sendFromUser(cluster.id, '@A one'), first.hub.sendFromUser(cluster.id, '@A two')];
  first.hub.setPaused(false);
  await waitFor(() => msgs.every((m) => stateOf(store, m.id).state === 'running'), 'batch running');
  const run = (first.hub as any).running.get(a.id);
  const reads = () => (store.db.prepare('SELECT COUNT(*) AS n FROM reads').get() as any).n;
  const eventsBefore = store.listEvents(0).length;
  // The process "dies" after the delivery states are written and before the read receipts are.
  const markRead = store.markRead;
  store.markRead = () => { throw new Error('crash between the writes'); };
  assert.throws(() => (first.hub as any).finish(store.getMember(a.id), run, 'done', null), /crash between the writes/);
  store.markRead = markRead;
  assert.deepEqual(msgs.map((m) => stateOf(store, m.id).state), ['running', 'running'], 'no done state without its read receipt');
  assert.equal(reads(), 0);
  assert.equal(store.listEvents(0).length, eventsBefore, 'no event for the rolled-back writes');
  assert.ok(!first.events.slice(-3).some((e) => e.kind === 'delivery' && (e.payload as any).delivery.state === 'done'), 'listeners heard nothing');
  run.abort.abort();
  await first.hub.close();

  // After restart the interrupted batch remains unknown, and no read receipt was invented.
  const second = await nativeHub({ store, dir, native: { onDeliver: async () => 'accepted' } });
  try {
    assert.deepEqual(msgs.map((m) => [stateOf(store, m.id).state, stateOf(store, m.id).outcome]), [['failed', 'unknown'], ['failed', 'unknown']]);
    assert.equal(second.native.delivered.length, 0);
    assert.equal(reads(), 0);
    assert.deepEqual(second.hub.readMessages(a.id).map((m) => m.id), msgs.map((m) => m.id));
  } finally {
    await second.hub.close();
    store.close();
  }
});

test('read state: read_messages writes its receipts and their read event together; a failure leaves neither', async () => {
  const { hub, store, events } = await nativeHub();
  try {
    hub.setPaused(true);
    const { cluster, members: [a] } = await hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    hub.sendFromUser(cluster.id, 'note');
    const reads = () => (store.db.prepare('SELECT COUNT(*) AS n FROM reads').get() as any).n;
    const appendEvent = store.appendEvent;
    store.appendEvent = (...args) => {
      if (args[2] === 'read') throw new Error('crash before the event');
      return appendEvent.apply(store, args);
    };
    assert.throws(() => hub.readMessages(a.id), /crash before the event/);
    store.appendEvent = appendEvent;
    assert.equal(reads(), 0, 'no receipt without its event');
    assert.equal(events.filter((e) => e.kind === 'read').length, 0);

    assert.deepEqual(hub.readMessages(a.id).map((m) => m.body), ['note'], 'still unread, so returned again');
    assert.equal(reads(), 1);
    assert.deepEqual(store.listEvents(0, a.id, ['read']).map((e) => (e.payload as any).messageIds.length), [1]);
  } finally {
    await hub.close();
  }
});
