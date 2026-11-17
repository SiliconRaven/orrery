// The web page loads recent messages instead of replaying the event log: the read-only endpoints that feed it
// (docs/architecture.md「网页的数据流」).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { insertMessageWithEvent, startTestHub, type TestHub } from './helpers.ts';

/** A paused Hub (nothing is delivered) with one cluster of two mock members. */
async function setup() {
  const app = await startTestHub();
  app.hub.setPaused(true);
  const { cluster, members } = await app.cluster('window', ['a', 'b']);
  return { app, cluster, members };
}

/** Seeds `n` messages from `from` to `to`, oldest first; returns their ids. */
function seed(app: TestHub, clusterId: string, n: number, from: string, to: string[] = []): string[] {
  return app.store.transaction(() => Array.from({ length: n }, (_, i) => {
    const id = randomUUID();
    insertMessageWithEvent(app.store, { id, clusterId, from, mentions: to, body: `message ${i}`, replyTo: null, chainId: id, hop: 0,
      createdAt: new Date().toISOString() }, to);
    return id;
  }));
}

test('state: each cluster carries its unread count and the running deliveries are listed', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const other = (await app.cluster('other', ['c'])).cluster;
    const mine = seed(app, cluster.id, 2, 'user', [a.id]);
    const theirs = seed(app, cluster.id, 3, a.id, [b.id]);
    seed(app, other.id, 1, 'user');
    let state = await app.api('GET', '/api/state');
    const unread = (id: string) => state.clusters.find((c: { id: string }) => c.id === id).unread;
    assert.equal(unread(cluster.id), 3, 'no read position: every message not from the user');
    assert.equal(unread(other.id), 0, 'only the user wrote there');
    assert.deepEqual(state.running, []);
    await app.api('POST', `/api/clusters/${cluster.id}/read`, { messageId: theirs[0] });
    const delivery = app.store.withDeliveries([app.store.getMessage(mine[0])!])[0].deliveries[0];
    app.store.startDelivery(delivery.id, delivery.id);
    state = await app.api('GET', '/api/state');
    assert.equal(unread(cluster.id), 2, 'after the read position');
    assert.deepEqual(state.running, [{ id: delivery.id, memberId: a.id }]);
  } finally {
    await app.close();
  }
});

test('messages: a window around a message, and the page after a message, in the usual shape', async () => {
  const { app, cluster, members: [a] } = await setup();
  try {
    const ids = seed(app, cluster.id, 30, 'user', [a.id]);
    const get = (query: string) => app.api('GET', `/api/clusters/${cluster.id}/messages?${query}`);
    const around = await get(`around=${ids[10]}&limit=7`);
    assert.deepEqual(around.map((m: { id: string }) => m.id), ids.slice(7, 14), 'three older, the message, three newer');
    assert.equal(around[3].deliveries[0].memberId, a.id, 'with deliveries, like the newest page');
    assert.deepEqual((await get(`around=${ids[1]}&limit=7`)).map((m: { id: string }) => m.id), ids.slice(0, 5), 'cut at the oldest');
    assert.deepEqual((await get(`around=${ids[28]}&limit=6`)).map((m: { id: string }) => m.id), ids.slice(25), 'cut at the newest');
    assert.deepEqual((await get(`after=${ids[24]}&limit=3`)).map((m: { id: string }) => m.id), ids.slice(25, 28));
    assert.deepEqual(await get(`after=${ids[29]}&limit=3`), [], 'nothing after the newest');
    const missing = await fetch(`${app.url}/api/clusters/${cluster.id}/messages?around=${randomUUID()}`);
    assert.equal(missing.status, 404);
    const otherCluster = (await app.cluster('other', ['c'])).cluster;
    assert.equal((await fetch(`${app.url}/api/clusters/${otherCluster.id}/messages?around=${ids[3]}`)).status, 404, 'only its own messages');
  } finally {
    await app.close();
  }
});

test('messages: every message answer carries the event seq its rows were read at (X-Orrery-Seq)', async () => {
  const { app, cluster, members: [a] } = await setup();
  try {
    const [id] = seed(app, cluster.id, 1, 'user', [a.id]);
    const seqOf = async (path: string) => {
      const res = await fetch(`${app.url}${path}`);
      assert.equal(res.status, 200);
      return Number(res.headers.get('x-orrery-seq'));
    };
    const paths = ['', '?limit=5', `?before=${id}`, `?after=${id}`, `?around=${id}`].map((q) => `/api/clusters/${cluster.id}/messages${q}`)
      .concat(`/api/clusters/${cluster.id}/messages/${id}`);
    for (const path of paths) assert.equal(await seqOf(path), app.store.lastEventSeq(), path);
    const delivery = app.store.withDeliveries([app.store.getMessage(id)!])[0].deliveries[0];
    const event = app.store.appendEvent(cluster.id, a.id, 'delivery', { delivery: app.store.setDeliveryState(delivery.id, 'done') });
    for (const path of paths) assert.equal(await seqOf(path), event.seq, `${path}: rows and seq move together`);
  } finally {
    await app.close();
  }
});

test('handoff and resend answers carry X-Orrery-Seq, at or after the event that recorded them, with the delivery as of it', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const [first, second] = seed(app, cluster.id, 2, 'user', [a.id]);
    const source = (id: string) => app.store.setDeliveryState(app.store.withDeliveries([app.store.getMessage(id)!])[0].deliveries[0].id, 'failed', 'boom', 'failed');
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${app.url}/api/clusters/${cluster.id}/deliveries/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200, await res.clone().text());
      return { seq: Number(res.headers.get('x-orrery-seq')), data: await res.json() };
    };
    for (const [id, path, body] of [[first, 'handoff', { targetMemberId: b.id }], [second, 'resend', {}]] as const) {
      const d = source(id);
      const answer = await post(`${d.id}/${path}`, body);
      const recorded = app.events.filter((e) => e.kind === 'delivery' && (e.payload as any).delivery.id === d.id).at(-1)!;
      assert.ok(answer.data.sourceDelivery.handoffMessageId, path);
      assert.ok(answer.seq >= recorded.seq, `${path}: not older than the event that recorded the handoff`);
      assert.equal(answer.seq, app.store.lastEventSeq(), `${path}: read with the delivery, after the write`);
      assert.deepEqual(answer.data.sourceDelivery, app.store.getDelivery(d.id), `${path}: the delivery as of that seq`);
      const again = await post(`${d.id}/${path}`, body);   // a retry gets the same handoff back, with the seq of now
      assert.equal(again.data.message.id, answer.data.message.id);
      assert.equal(again.seq, app.store.lastEventSeq());
    }
  } finally {
    await app.close();
  }
});

test('fyi: every message answer the page reads keeps the flag (windows, single message, problems, the stream event)', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const before = seed(app, cluster.id, 1, 'user');
    const id = randomUUID();
    const { deliveries, event } = insertMessageWithEvent(app.store, { id, clusterId: cluster.id, from: a.id, mentions: [b.id], body: 'fyi', replyTo: null,
      chainId: id, hop: 0, createdAt: new Date().toISOString(), fyi: true }, [b.id]);   // one delivery: an fyi reply that woke the asker
    seed(app, cluster.id, 1, 'user');
    assert.equal((event.payload as any).message.fyi, true, 'the message event');
    const get = (path: string) => app.api('GET', `/api/clusters/${cluster.id}/messages${path}`);
    const fyiOf = (list: any[]) => list.find((m) => m.id === id)?.fyi;
    for (const path of ['', `?around=${id}`, `?after=${before[0]}`]) assert.equal(fyiOf(await get(path)), true, path || 'newest');
    assert.equal((await get(`/${id}`)).fyi, true, 'single message');
    app.store.setDeliveryState(deliveries[0].id, 'offline', 'gone');
    const problems = await app.api('GET', `/api/clusters/${cluster.id}/delivery-problems`);
    assert.equal(problems.items[0].message.fyi, true, 'delivery problems');
  } finally {
    await app.close();
  }
});

test('delivery problems: a count and the newest items, without handed-off, superseded or fine deliveries', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const ids = seed(app, cluster.id, 4, 'user', [a.id, b.id]);
    const deliveries = (id: string) => app.store.withDeliveries([app.store.getMessage(id)!])[0].deliveries;
    const [d0a, d0b] = deliveries(ids[0]);
    app.store.setDeliveryState(d0a.id, 'failed', 'boom');
    app.store.setDeliveryState(d0b.id, 'done', null, 'unknown');
    const [d1a] = deliveries(ids[1]);
    app.store.setDeliveryState(d1a.id, 'offline', 'gone');
    app.store.setHandoff(d1a.id, ids[3]);
    const [d2a, d2b] = deliveries(ids[2]);
    app.store.setDeliveryState(d2a.id, 'offline', 'gone');
    app.store.setDeliveryState(d2b.id, 'done');
    const all = await app.api('GET', `/api/clusters/${cluster.id}/delivery-problems`);
    assert.equal(all.count, 3);
    assert.deepEqual(all.items.map((r: any) => [r.message.id, r.delivery.id]), [[ids[2], d2a.id], [ids[0], d0b.id], [ids[0], d0a.id]], 'newest first');
    assert.equal(all.items[2].delivery.error, 'boom');
    const one = await app.api('GET', `/api/clusters/${cluster.id}/delivery-problems?limit=1`);
    assert.deepEqual([one.count, one.items.length], [3, 1], 'the count is not cut by the limit');
    assert.equal((await fetch(`${app.url}/api/clusters/${randomUUID()}/delivery-problems`)).status, 404);
  } finally {
    await app.close();
  }
});

test('member events: with a limit, pages back through every line kind, the created deliveries included', async () => {
  const { app, cluster, members: [a, b] } = await setup();
  try {
    const [toA] = seed(app, cluster.id, 1, 'user', [a.id]);
    seed(app, cluster.id, 1, 'user', [b.id]);   // another member's delivery: not a line on a's page
    const delivery = app.store.withDeliveries([app.store.getMessage(toA)!])[0].deliveries[0];
    app.store.appendEvent(cluster.id, a.id, 'delivery', { delivery: app.store.startDelivery(delivery.id, delivery.id) });
    app.store.appendEvent(cluster.id, a.id, 'agent', { event: { type: 'text', text: 'working' } });
    app.store.appendEvent(cluster.id, a.id, 'guard', { reason: 'max_turns_per_hour', maxTurnsPerHour: 1 });
    app.store.appendEvent(cluster.id, a.id, 'unread_hint', { count: 2 });
    app.store.appendEvent(cluster.id, b.id, 'agent', { event: { type: 'text', text: 'not mine' } });
    const all = await app.api('GET', `/api/members/${a.id}/events?limit=50`);
    assert.deepEqual(all.map((e: any) => e.kind), ['delivery', 'delivery', 'agent', 'guard', 'unread_hint']);
    assert.deepEqual([all[0].memberId, all[0].payload.delivery.state], [a.id, 'queued'], 'the line the message created');
    assert.deepEqual(all[0].payload.message, { from: 'user', body: 'message 0' }, 'delivery lines name their message');
    assert.ok(all.every((e: any, i: number) => i === 0 || e.seq > all[i - 1].seq), 'oldest first');
    const newest = await app.api('GET', `/api/members/${a.id}/events?limit=2`);
    assert.deepEqual(newest.map((e: any) => e.kind), ['guard', 'unread_hint']);
    const older = await app.api('GET', `/api/members/${a.id}/events?limit=2&before=${newest[0].seq}`);
    assert.deepEqual(older.map((e: any) => e.kind), ['delivery', 'agent']);
    const oldest = await app.api('GET', `/api/members/${a.id}/events?limit=2&before=${older[0].seq}`);
    assert.deepEqual(oldest.map((e: any) => e.payload.delivery.state), ['queued']);
    assert.deepEqual((await app.api('GET', `/api/members/${a.id}/events?since=0`)).map((e: any) => e.kind), ['delivery', 'agent'],
      'without a limit the old answer is unchanged');
  } finally {
    await app.close();
  }
});
