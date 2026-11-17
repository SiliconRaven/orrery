// Acceptance criterion 11: the real entry point (what `npm start` runs) serves /api/state without tokens,
// SSE carries cluster and message events, and a renamed member can be @-mentioned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { REPO_ROOT } from '../src/main.ts';
import { REPLAY_PAGE } from '../src/web/server.ts';
import { startTestHub, tempDir, TEST_TOKEN, waitFor, type TestHub } from './helpers.ts';

/** Opens SSE streams, each collecting its raw text and `id:` seqs. */
function trackStreams() {
  const controllers: AbortController[] = [];
  return {
    closeAll: () => controllers.forEach((c) => c.abort()),
    async open(url: string, query: string, headers: Record<string, string> = {}) {
      const ac = new AbortController();
      controllers.push(ac);
      const res = await fetch(`${url}/api/stream${query}`, { signal: ac.signal, headers });
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const s = { text: '', seqs: [] as number[], close: () => ac.abort() };
      decodeInto(res.body!, (t) => {
        s.text += t;
        s.seqs = [...s.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      }).catch(() => {});
      return s;
    },
  };
}

/** Decodes a UTF-8 byte stream into text pieces; a multi-byte character may be split across chunks. */
async function decodeInto(chunks: AsyncIterable<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const dec = new TextDecoder();
  for await (const chunk of chunks) onText(dec.decode(chunk, { stream: true }));
  onText(dec.decode());
}

test('SSE helper: characters split across chunks decode intact', async () => {
  const text = 'id: 1\ndata: {"avatar":"🐭","name":"小B"}\n\n';
  async function* oneByteAtATime() {
    for (const b of new TextEncoder().encode(text)) yield new Uint8Array([b]);
  }
  let out = '';
  await decodeInto(oneByteAtATime(), (t) => { out += t; });
  assert.equal(out, text);
});

test('11: node src/main.ts serves state, streams events, and PATCH rename makes the new name @-able', async () => {
  const dir = tempDir();
  // `npm start` is `node src/main.ts`; spawning node directly avoids a cmd.exe shell on Windows. ORRERY_TEST_DB_SYNC
  // emptied: this round trip runs on the product's database settings, not the test fast mode.
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ORRERY_TEST_DB_SYNC: '', ORRERY_PORT: '0', ORRERY_DB: join(dir, 'h.db'), ORRERY_SANDBOX: join(dir, 'sb'), ORRERY_HOME: join(dir, 'home'), ORRERY_MAX_HOPS: '', ORRERY_MAX_TURNS_PER_CHAIN: '', ORRERY_MOCK: '1', ORRERY_API_TOKEN: TEST_TOKEN, KIMI_CODE_HOME: join(dir, 'kimi') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const streams = trackStreams();
  const openStream = streams.open;
  try {
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const url = await waitFor(() => /listening on (http:\S+)/.exec(out)?.[1], 'hub to start', 10_000);
    const get = (path: string) => fetch(url + path).then((r) => r.json());
    const send = (method: string, path: string, body: unknown) =>
      fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

    assert.deepEqual(await get('/api/state'), {
      clusters: [], coordinators: {}, members: [], paused: false, settings: { maxHops: { kind: 'finite', value: 6 }, source: 'default',
        maxTurnsPerChain: { kind: 'finite', value: 20 }, maxTurnsPerChainSource: 'default',
        stalledMemberMinutes: 30, stalledMemberMinutesSource: 'default', usageAlert: { turnTokens: 20_000_000, conversationTokens: 200_000_000 }, clusterGroups: [] },
      running: [], seq: 0,
    });
    assert.match(await (await fetch(url + '/')).text(), /<title>orrery<\/title>/);

    const first = await openStream(url, '');
    const streamed = () => first.text;

    const { cluster, members: [a, b] } = await send('POST', '/api/clusters', {
      name: 'demo', members: [{ projectPath: tempDir(), harness: 'mock' }, { projectPath: tempDir(), harness: 'mock' }],
    });
    assert.deepEqual([a.name, b.name], ['mock-1', 'mock-1-2']);
    await send('POST', `/api/clusters/${cluster.id}/messages`, { body: '@all hello' });
    await waitFor(() => /"kind":"cluster"/.test(streamed()) && /"kind":"message"/.test(streamed())
      && (streamed().match(/"state":"done"/g) ?? []).length === 2, 'SSE events');

    const state = JSON.stringify(await get('/api/state'));
    assert.ok(!state.includes(TEST_TOKEN), 'state does not contain the API token');
    assert.doesNotMatch(state, /"(?:token|apiToken|secret)"\s*:|[0-9a-f]{64}/i, 'state has no credential fields or bridge secret');

    const renamed = await send('PATCH', `/api/members/${b.id}`, { name: '小B', avatar: '🦊' });
    assert.deepEqual([renamed.name, renamed.avatar], ['小B', '🦊']);
    const msg = await send('POST', `/api/clusters/${cluster.id}/messages`, { body: '@小B 你好' });
    assert.deepEqual(msg.mentions, [b.id]);
    const taken = await fetch(url + `/api/members/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '小B' }) });
    assert.equal(taken.status, 400);

    const events = await get(`/api/members/${b.id}/events?since=0`);
    assert.ok(events.length > 0 && events.every((e: any) => e.kind === 'agent' || e.kind === 'delivery'));
    await waitFor(async () => (await get(`/api/clusters/${cluster.id}/messages`)).every((m: any) => m.deliveries.every((d: any) => d.state === 'done')), 'settled');
    const last = (await get(`/api/members/${b.id}/events?since=0`)).at(-1).seq;
    assert.deepEqual(await get(`/api/members/${b.id}/events?since=${last}`), []);

    // SSE resume: disconnect, miss an event, reconnect from a seq via ?since= and via Last-Event-ID.
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    await send('PATCH', `/api/members/${a.id}`, { avatar: '🐭' });          // marker: once seen, the stream is caught up
    await waitFor(() => first.text.includes('🐭'), 'first stream caught up');
    const seen = first.seqs.at(-1)!;
    assert.deepEqual(first.seqs, range(1, seen), 'live stream: contiguous from 1, no duplicates');
    first.close();
    await send('PATCH', `/api/members/${a.id}`, { avatar: '🐱' });          // seq seen+1, while disconnected
    const viaQuery = await openStream(url, `?since=${seen}`);
    const mid = Math.floor(seen / 2);
    const viaHeader = await openStream(url, '', { 'last-event-id': String(mid) });
    await send('PATCH', `/api/members/${a.id}`, { avatar: '🐶' });          // seq seen+2, live after reconnect
    await waitFor(() => viaQuery.seqs.at(-1) === seen + 2 && viaHeader.seqs.at(-1) === seen + 2, 'resumed streams');
    assert.equal((await get('/api/state')).seq, seen + 2, 'the snapshot carries the newest event seq');
    assert.deepEqual(viaQuery.seqs, [seen + 1, seen + 2]);
    assert.deepEqual(viaHeader.seqs, range(mid + 1, seen + 2));
    viaQuery.close();
    viaHeader.close();
  } finally {
    streams.closeAll();
    child.kill();
    await once(child, 'exit');
  }
});

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Appends `n` events in one transaction. Subscribers are not told: they reach a page through replay. */
function seedEvents(app: TestHub, n: number): void {
  app.store.transaction(() => { for (let i = 0; i < n; i++) app.store.appendEvent(null, null, 'agent', { i }); });
}

/** Counts the stream's page reads; `before` runs ahead of each one with its number (1 = the first page). */
function countPageReads(app: TestHub, before: (n: number) => void = () => {}): { n: number } {
  const read = app.store.eventJsonPage.bind(app.store);
  const reads = { n: 0 };
  app.store.eventJsonPage = (since, limit) => {
    before(++reads.n);
    return read(since, limit);
  };
  return reads;
}

const listeners = (app: TestHub): number => (app.hub as any).listeners.size;

test('SSE replay: events appended while a long replay runs arrive exactly once, in order', async () => {
  const app = await startTestHub();
  const streams = trackStreams();
  try {
    const emit = (tag: string) => (app.hub as any).emit(null, null, 'agent', { tag });
    const seeded = REPLAY_PAGE * 3 + 10;   // four page reads if nothing else were appended
    seedEvents(app, seeded);
    // One event lands just before every page read (between two pages, as a working member's would), and more on
    // their own timer ticks, wherever those fall: before, between and after the pages.
    const reads = countPageReads(app, (n) => emit(`page-${n}`));
    const timer = setInterval(() => emit('tick'), 1);
    let s;
    try {
      s = await streams.open(app.url, '');
      await waitFor(() => s!.seqs.length > seeded + 20, 'replay to pass the seeded events');
    } finally { clearInterval(timer); }
    assert.ok(reads.n >= 4, `read in pages (${reads.n} reads)`);
    const pages = reads.n;

    // Live from here on. A listener told about an event this connection already has (a duplicate) drops it.
    emit('live');
    (app.hub as any).notify(app.events[0]);
    emit('end');
    await waitFor(() => s!.text.includes('"tag":"end"'), 'the last live event');
    const last = app.store.lastEventSeq();
    assert.deepEqual(s.seqs, range(1, last), 'every seq once, in increasing order');
    for (const tag of ['page-1', 'page-2', 'page-4', 'live']) assert.equal(s.text.split(`"tag":"${tag}"`).length - 1, 1, tag);
    assert.ok(s.text.split('"tag":"tick"').length - 1 > 0, 'timer events arrived too');
    assert.equal(reads.n, pages, 'no page reads once the stream is live');
    const framed = s.text.split('\n\n').filter(Boolean).map((f) => /^id: (\d+)\ndata: (.*)$/.exec(f)!);
    assert.deepEqual(framed.map((m) => JSON.parse(m[2])), app.store.listEvents(0), 'each frame is the stored event');
    assert.ok(framed.every((m) => Number(m[1]) === JSON.parse(m[2]).seq));
  } finally {
    streams.closeAll();
    await app.close();
  }
});

test('SSE replay: since resumes inside a long log, a short log is one read, and closing unsubscribes', async () => {
  const app = await startTestHub();
  const streams = trackStreams();
  try {
    const before = listeners(app);
    seedEvents(app, 3);
    const reads = countPageReads(app);
    const short = await streams.open(app.url, '');
    await waitFor(() => short.seqs.length === 3, 'short replay');
    assert.equal(reads.n, 1, 'a short log is one page read');
    assert.equal(listeners(app), before + 1, 'subscribed once caught up');
    (app.hub as any).emit(null, null, 'agent', { tag: 'live' });
    await waitFor(() => short.seqs.length === 4, 'live event');
    assert.deepEqual(short.seqs, [1, 2, 3, 4]);
    short.close();
    await waitFor(() => listeners(app) === before, 'unsubscribed on close');

    seedEvents(app, REPLAY_PAGE * 3);
    const last = app.store.lastEventSeq();
    reads.n = 0;
    const since = last - REPLAY_PAGE - 5;   // one full page and a short one
    const viaQuery = await streams.open(app.url, `?since=${since}`);
    const viaHeader = await streams.open(app.url, '', { 'last-event-id': String(since) });
    await waitFor(() => viaQuery.seqs.at(-1) === last && viaHeader.seqs.at(-1) === last, 'resumed streams');
    assert.deepEqual(viaQuery.seqs, range(since + 1, last));
    assert.deepEqual(viaHeader.seqs, range(since + 1, last));
    assert.equal(reads.n, 4, 'two reads each');
    const beyond = await streams.open(app.url, `?since=${last + 100}`);   // a seq the log has not reached: nothing replayed, live events still sent
    await waitFor(() => listeners(app) === before + 3, 'all three live');
    (app.hub as any).emit(null, null, 'agent', { tag: 'live' });
    await waitFor(() => beyond.seqs.length === 1 && viaQuery.seqs.at(-1) === last + 1, 'live after resume');
    assert.deepEqual(beyond.seqs, [last + 1]);
  } finally {
    streams.closeAll();
    await app.close();
  }
});

test('SSE resume: a browser reconnect keeps ?since= and adds Last-Event-ID; the newer of the two wins', async () => {
  const app = await startTestHub();
  const streams = trackStreams();
  try {
    seedEvents(app, 10);
    // The page opens ?since=<snapshot seq>; EventSource reconnects to the same URL with the last id it saw.
    const reconnected = await streams.open(app.url, '?since=3', { 'last-event-id': '7' });
    const older = await streams.open(app.url, '?since=7', { 'last-event-id': '3' });
    await waitFor(() => reconnected.seqs.at(-1) === 10 && older.seqs.at(-1) === 10, 'both caught up');
    assert.deepEqual(reconnected.seqs, [8, 9, 10]);
    assert.deepEqual(older.seqs, [8, 9, 10]);
  } finally {
    streams.closeAll();
    await app.close();
  }
});

test('SSE replay: a client that disconnects mid-replay stops the page reads', async (t) => {
  const app = await startTestHub();
  const streams = trackStreams();
  try {
    const before = listeners(app);
    const pages = 40;
    seedEvents(app, REPLAY_PAGE * pages);
    const reads = countPageReads(app);
    const gone = await streams.open(app.url, '');   // resolves at the response headers, while the replay is running
    gone.close();
    await waitFor(async () => {
      const n = reads.n;
      await sleep(100);
      return reads.n === n;
    }, 'page reads to stop');
    t.diagnostic(`stopped after ${reads.n} of ${pages + 1} page reads`);
    assert.ok(reads.n >= 1 && reads.n < pages, `stopped after ${reads.n} of ${pages + 1} page reads`);
    assert.equal(listeners(app), before, 'never subscribed');
    await sleep(100);
    assert.ok(reads.n < pages, 'and stays stopped');
  } finally {
    streams.closeAll();
    await app.close();
  }
});

test('SSE replay: a page read that fails in a later tick (the store closed for shutdown) ends the stream, not the process', async () => {
  const app = await startTestHub();
  const { error } = console;
  const logged: unknown[][] = [];
  console.error = (...args) => { logged.push(args); };
  try {
    const before = listeners(app);
    seedEvents(app, REPLAY_PAGE * 5);
    const reads = countPageReads(app, (n) => { if (n === 3) throw new Error('database is not open'); });
    const res = await fetch(`${app.url}/api/stream`);
    let text = '';
    await decodeInto(res.body!, (t) => { text += t; }).catch(() => {});   // returns once the server ends the response
    assert.deepEqual([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])), range(1, REPLAY_PAGE * 2), 'the pages read before the failure arrived');
    await sleep(50);   // an uncaught exception or another read in a later tick would show here
    assert.equal(reads.n, 3);
    assert.deepEqual(logged, [['event replay failed:', 'database is not open']]);
    assert.equal(listeners(app), before, 'never subscribed');
  } finally {
    console.error = error;
    await app.close();
  }
});
