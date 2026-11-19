// Native Kimi Code adapter (src/adapters/kimi/, docs/adapters/kimi.md) against a fake Kimi service: a temp data
// directory (instances, server.token, workspaces, sessions) and a local HTTP + WebSocket server that plays the
// desktop app's embedded service. Never touches the real ~/.kimi-code and never starts Kimi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createKimiNativeAdapter, listenerOwner, marker, readInstances, type KimiNativeOptions } from '../src/adapters/kimi/native.ts';
import { encodeFrame, FrameReader, OP } from '../src/adapters/kimi/ws.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { AgentEvent, BridgePort, NativeDeliverContext } from '../src/core/types.ts';
import { fixtureNativeMock, mcpStatus, startTestHub, tempDir, waitFor } from './helpers.ts';

const TOKEN = 'fake-kimi-token-for-tests';
const S1 = 'session_11111111-1111-4111-8111-111111111111';
const S2 = 'session_22222222-2222-4222-8222-222222222222';
const ARCHIVED = 'session_33333333-3333-4333-8333-333333333333';
const OTHER_WS = 'session_44444444-4444-4444-8444-444444444444';
const SERVER_ID = '01FAKESERVERID';

type Reply = { code: number; msg?: string; data?: unknown; status?: number };

interface FakeKimi {
  home: string;
  project: string;
  port: number;
  /** Every HTTP request: method, path, authorization header and parsed body. */
  requests: { method: string; path: string; auth: string | undefined; body: any }[];
  /** What POST /prompts answers next (default: code 0); a function sees the body. */
  onPrompt: (sessionId: string, body: any) => Reply | 'hang' | 'reset';
  /** What a prompt abort answers. */
  abortReply: Reply;
  /** What GET /api/v1/oauth/usage answers. */
  usage: Reply;
  /** Holds the WebSocket handshake until it settles (a second instance appearing meanwhile). */
  upgradeGate: Promise<void> | null;
  /** WebSocket upgrades that reached the server (counted before upgradeGate holds them). */
  upgrades: number;
  /** Never answers subscribe_v2 either (a future service that changed it again). */
  ignoreSubscribe: boolean;
  serverId: string;
  /** Frames the WebSocket clients sent (parsed). */
  received: any[];
  /** Sends a frame to every WebSocket client. */
  emit(frame: unknown): void;
  /** Drops the event connections without stopping the HTTP service. */
  disconnect(): void;
  /** Sessions the service knows (subscribe answers not_found for others). */
  known: Set<string>;
  clients(): number;
  /** Writes the instance file (a different server id or host makes it not match). */
  register(over?: Record<string, unknown>): void;
  close(): Promise<void>;
}

function writeJson(path: string, data: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

/** `home`: share another fake's data directory (a second instance of the app). */
async function fakeKimi(opts: { home?: string; serverId?: string } = {}): Promise<FakeKimi> {
  const home = opts.home ?? join(tempDir(), 'kimi-home');
  const project = join(home, '..', 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, '..', 'placeholder'), '');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'server.token'), TOKEN + '\n');
  writeJson(join(home, 'workspaces.json'), {
    version: 1,
    workspaces: {
      wd1: { root: project, name: 'project', created_at: 1, last_opened_at: Date.UTC(2026, 9, 30) },
      wd2: { root: join(home, '..', 'gone'), name: 'gone', created_at: 1, last_opened_at: 1 },
    },
    deleted_workspace_ids: ['wd2'],
  });
  const state = (id: string, extra: Record<string, unknown>) =>
    writeJson(join(home, 'sessions', 'wd1', id, 'state.json'), { id, cwd: project, archived: false, createdAt: Date.UTC(2026, 9, 1), ...extra });
  state(S1, { title: 'first chat', updatedAt: Date.UTC(2026, 9, 31) });
  state(S2, { title: '', updatedAt: Date.UTC(2026, 9, 20) });
  state(ARCHIVED, { title: 'old', archived: true });
  writeJson(join(home, 'sessions', 'wd2', OTHER_WS, 'state.json'), { id: OTHER_WS, cwd: 'elsewhere', title: 'deleted workspace' });
  mkdirSync(join(home, 'sessions', 'wd1', 'not-a-session'), { recursive: true });

  const requests: FakeKimi['requests'] = [];
  const received: any[] = [];
  const sockets = new Set<Socket>();
  const known = new Set([S1, S2]);
  const send = (res: ServerResponse, r: Reply) =>
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: r.code, msg: r.msg ?? 'x', data: r.data ?? null }));
  const fake: FakeKimi = {
    home, project, port: 0, requests, received, known, upgradeGate: null, upgrades: 0, ignoreSubscribe: false, serverId: opts.serverId ?? SERVER_ID,
    onPrompt: () => ({ code: 0, data: { status: 'running' } }),
    abortReply: { code: 0, data: { aborted: true } },
    usage: { code: 0, data: { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.25, resetAt: '2026-11-03T14:00:00Z' }, limit7d: { usedRatio: 0.5 } }, extraUsage: null } } },
    emit: (frame) => { for (const s of sockets) s.write(encodeFrame(OP.text, Buffer.from(JSON.stringify(frame)), false)); },
    disconnect: () => { for (const s of sockets) s.destroy(); },
    clients: () => sockets.size,
    register: (over = {}) => writeJson(join(home, 'server', 'instances', '01INSTANCE.json'), {
      server_id: fake.serverId, pid: process.pid, host: '127.0.0.1', port: fake.port, started_at: Date.now(), heartbeat_at: Date.now(), host_version: '2.5.1', ...over,
    }),
    close: async () => {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = req.url ?? '';
    requests.push({ method: req.method ?? '', path, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, { status: 401, code: 40101 });
    if (req.method === 'GET' && path === '/api/v1/meta') return send(res, { code: 0, data: { server_id: fake.serverId, server_version: '2.5.1' } });
    const prompt = /^\/api\/v1\/sessions\/([^/]+)\/prompts$/.exec(path);
    if (req.method === 'POST' && prompt) {
      const r = fake.onPrompt(prompt[1], JSON.parse(raw));
      if (r === 'hang') return;   // queued, but the answer never comes (the client times out)
      if (r === 'reset') return void req.socket.destroy();
      return send(res, r);
    }
    if (req.method === 'GET' && path === '/api/v1/oauth/usage') return send(res, fake.usage);
    if (req.method === 'POST' && /\/prompts\/[^/]+:abort$/.test(path)) return send(res, fake.abortReply);
    send(res, { status: 404, code: 40400 });
  });
  server.on('upgrade', async (req: IncomingMessage, socket: Socket) => {
    fake.upgrades++;
    if (fake.upgradeGate) await fake.upgradeGate;
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    if (req.url !== '/api/v1/ws' || !offered.includes(`kimi-code.bearer.${TOKEN}`)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: kimi-code.bearer.${TOKEN}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const f of reader.push(chunk)) {
        if (f.opcode !== OP.text) continue;
        const msg = JSON.parse(f.payload.toString('utf8'));
        received.push(msg);
        // As 2.5.1 does: subscribe_v2 is answered, the old `subscribe` is dropped without a word.
        if (msg.type === 'subscribe_v2' && !fake.ignoreSubscribe) {
          const write = (frame: unknown) => socket.write(encodeFrame(OP.text, Buffer.from(JSON.stringify(frame)), false));
          const id: string = msg.payload.session_id;
          if (typeof msg.payload.transcript !== 'object') {
            write({ type: 'ack', id: msg.id, code: 1, msg: 'invalid subscribe_v2 payload', payload: {} });
            continue;
          }
          if (known.has(id)) write({ type: 'transcript.reset', session_id: id, payload: { type: 'transcript.reset', agent_id: 'main', snapshot: { items: [] }, has_more_older: false, seq: 0 } });
          write({ type: 'ack', id: msg.id, code: 0, msg: 'success', payload: { accepted: known.has(id) ? [id] : [], not_found: known.has(id) ? [] : [id] } });
        }
      }
    });
    socket.write(encodeFrame(OP.text, Buffer.from(JSON.stringify({ type: 'server_hello', payload: { heartbeat_ms: 10000 } })), false));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  fake.port = (server.address() as { port: number }).port;
  fake.register();
  return fake;
}

const asApp = async () => 'Kimi Code.exe';
const fast: KimiNativeOptions = { processImage: asApp, listenerPid: async () => process.pid, appCheckMs: 0, occupiedRetryMs: 10, requestTimeoutMs: 3000 };
const adapterFor = (k: FakeKimi, opts: KimiNativeOptions = {}) => createKimiNativeAdapter({ kimiHome: k.home, ...fast, ...opts });

const noBridge: BridgePort = { isOnline: () => false, push: async () => ({ ok: false, error: 'unused' }), waitDone: async () => 'dropped' };
function ctx(deliveryId: string, signal = new AbortController().signal, from?: string[]) {
  const events: AgentEvent[] = [];
  const c: NativeDeliverContext = { deliveryId, bridge: noBridge, onEvent: (e) => events.push(e), signal, ...(from ? { from } : {}) };
  return { c, events };
}

/** One `transcript.ops` frame of an agent, as a subscriber at grade 'block' gets it. */
function emitOps(k: FakeKimi, sessionId: string, ops: unknown[], agent = 'main') {
  k.emit({ type: 'transcript.ops', session_id: sessionId, timestamp: new Date().toISOString(), payload: { type: 'transcript.ops', agent_id: agent, ops, seq: 1 } });
}
const turnOp = (turnId: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ op: 'turn.upsert', turn: { kind: 'turn', turnId, ordinal: 7, state, origin: { kind: 'user' }, ...extra } });
const stepOp = (turnId: string, n: number, usage?: Record<string, number>) =>
  ({ op: 'step.upsert', turnId, step: { kind: 'step', stepId: `${turnId}.${n}`, turnId, ordinal: n, state: usage ? 'completed' : 'running', ...(usage ? { usage } : {}) } });
const textOp = (turnId: string, n: number, f: number, text: string, role = 'assistant') =>
  ({ op: 'frame.upsert', turnId, stepId: `${turnId}.${n}`, frame: { kind: 'text', frameId: `${turnId}.${n}.f${f}`, role, text } });

/** What Kimi would send for a prompt: each frame opens empty (its text streams as `append`) and is flushed whole. */
function runTurn(k: FakeKimi, sessionId: string, promptId: string, reply: string[], state = 'completed', error?: string) {
  const T = 't7';
  emitOps(k, sessionId, [turnOp(T, 'running', { triggerPromptId: promptId }), stepOp(T, 1)]);
  emitOps(k, sessionId, reply.map((_, i) => textOp(T, 1, i + 1, '')));
  // Another agent's turn with the same id does not end ours.
  emitOps(k, sessionId, [turnOp(T, 'failed')], 'sub');
  emitOps(k, sessionId, [...reply.map((text, i) => textOp(T, 1, i + 1, text)), turnOp(T, state, { triggerPromptId: promptId, ...(error ? { error } : {}) })]);
}

const prompts = (k: FakeKimi) => k.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/prompts'));

test('kimi 1: projects and sessions are read from the data directory, read-only', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  try {
    assert.deepEqual(await a.listProjects(), [{ path: k.project, label: 'project', updatedAt: new Date(Date.UTC(2026, 9, 30)).toISOString() }]);
    const sessions = await a.listSessions(k.project);
    assert.deepEqual(sessions.map((s) => [s.id, s.title, s.cwd]), [[S1, 'first chat', k.project], [S2, S2, k.project]]);
    assert.equal(sessions[0].updatedAt, new Date(Date.UTC(2026, 9, 31)).toISOString());
    assert.equal((await a.attachSession(S1)).title, 'first chat');
    await assert.rejects(a.attachSession(ARCHIVED), /not found/);
    await assert.rejects(a.attachSession(OTHER_WS), /not found/, 'a deleted workspace lists nothing');
    await assert.rejects(a.attachSession('../../etc'), /not a Kimi session id/);
    assert.equal(k.requests.length, 0, 'listing never asks the service');
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi 1b: projects.json (app 1.3.1 on) wins over the stale workspaces.json left behind; a broken one falls back', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  try {
    // wd1 is shown as deleted and wd2 as alive, the opposite of workspaces.json.
    writeJson(join(k.home, 'projects.json'), {
      schema_version: 2,
      projects: {
        wd1: { root: k.project, name: 'project', kind: 'implicit', created_at: '2026-10-01T00:00:00.000Z', last_opened_at: '2026-10-30T00:00:00.000Z' },
        wd2: { root: join(k.home, '..', 'gone'), name: 'moved', kind: 'implicit', created_at: '2026-10-01T00:00:00.000Z', last_opened_at: '2026-11-01T00:00:00.000Z' },
      },
      deleted_project_ids: ['wd1'],
      idempotency_keys: {},
    });
    assert.deepEqual(await a.listProjects(), [{ path: join(k.home, '..', 'gone'), label: 'moved', updatedAt: '2026-11-01T00:00:00.000Z' }]);
    assert.equal((await a.attachSession(OTHER_WS)).title, 'deleted workspace', 'sessions stay under the same wd id');
    await assert.rejects(a.attachSession(S1), /not found/);

    writeFileSync(join(k.home, 'projects.json'), '{ not json');
    assert.deepEqual((await a.listProjects()).map((p) => p.label), ['project']);
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi 2: online = instance file on loopback + the app process owning the port + /meta code 0', async () => {
  const k = await fakeKimi();
  // [what, setup, options, confirmed, may a request (with the token) reach the port]; 'unknown' = the check cannot answer
  const cases: [string, () => void, KimiNativeOptions, boolean | 'unknown', boolean][] = [
    ['all good', () => k.register(), {}, true, true],
    ['pid is not the app', () => k.register(), { processImage: async () => 'node.exe' }, false, false],
    ['pid gone (stale file)', () => k.register(), { processImage: async () => null }, false, false],
    ['kimi web counts', () => k.register(), { processImage: async () => 'kimi.exe' }, true, true],
    ['not loopback', () => k.register({ host: '0.0.0.0' }), {}, false, false],
    ['the port belongs to another process', () => k.register(), { listenerPid: async () => process.pid + 1 }, false, false],
    ['nobody owns the port', () => k.register(), { listenerPid: async () => null }, false, false],
    ['tasklist cannot answer (busy machine)', () => k.register(), { processImage: async () => undefined }, 'unknown', false],
    ['netstat cannot answer (busy machine)', () => k.register(), { listenerPid: async () => undefined }, 'unknown', false],
    // 2.4.0: /meta reports another server_id than the instance file; not compared.
    ['/meta names another server_id (2.4.0)', () => k.register({ server_id: '01M69R299T848TNW3Z7SJ7Y9F7' }), {}, true, true],
    // The port is owned (per the stub) but /meta is refused: an attempt without an answer, not "not running".
    ['nothing answers on the port', () => k.register({ port: 1 }), {}, 'unknown', false],
  ];
  try {
    for (const [what, setup, opts, online, reached] of cases) {
      setup();
      const before = k.requests.length;
      // A long cache age: isOnline answers from confirmOnline's check and starts no background check of its own.
      const a = adapterFor(k, { appCheckMs: 60_000, ...opts });
      const confirmed = await a.confirmOnline!(S1).catch((e: Error) => {
        assert.match(e.message, /could not check whether Kimi Code is running/, what);
        return 'unknown' as const;
      });
      assert.equal(confirmed, online, what);
      assert.equal(a.isOnline(S1, noBridge), online === true, `${what} (cached)`);
      assert.equal(k.requests.length > before, reached, `${what}: the token was ${reached ? '' : 'not '}sent`);
      await a.close?.();
    }
    k.register();
    assert.deepEqual((await readInstances(k.home)).map((i) => i.serverId), [SERVER_ID]);
    // Without the token file Kimi cannot be reached: offline.
    writeFileSync(join(k.home, 'server.token'), '');
    const a = adapterFor(k);
    assert.equal(await a.confirmOnline!(S1), false);
    await a.close?.();
    assert.ok(k.requests.every((r) => r.path === '/api/v1/meta' && (r.auth === `Bearer ${TOKEN}` || r.auth === undefined)));
  } finally {
    await k.close();
  }
});

test('kimi 2c: a query that cannot answer keeps the last real answer and never confirms a connection', async () => {
  const k = await fakeKimi();
  try {
    k.register();
    let image: string | null | undefined = 'Kimi Code.exe';
    const a = adapterFor(k, { appCheckMs: 60_000, processImage: async () => image });
    assert.equal(await a.confirmOnline!(S1), true);
    assert.equal(a.isOnline(S1, noBridge), true);
    const reached = k.requests.length;
    image = undefined;   // tasklist timed out on a busy machine
    await assert.rejects(a.confirmOnline!(S1), /could not check whether Kimi Code is running/,
      'an unanswered check is an error, not "not running"');
    assert.equal(a.isOnline(S1, noBridge), true, 'the last real answer stands');
    assert.equal(k.requests.length, reached, 'no request (and no token) on an unanswered check');
    image = null;        // a real "not running" answer
    assert.equal(await a.confirmOnline!(S1), false);
    assert.equal(a.isOnline(S1, noBridge), false, 'a real not-running answer still takes it offline');
    await a.close?.();
  } finally { await k.close(); }
});

test('kimi 2f: a normal quota read confirms afresh and sends nothing on an unanswered check', async () => {
  const k = await fakeKimi();
  try {
    k.register();
    let image: string | null | undefined = 'Kimi Code.exe';
    // A long cache age: isOnline keeps answering "online" from the cache and starts no check of its own.
    const a = adapterFor(k, { appCheckMs: 60_000, processImage: async () => image });
    assert.equal(await a.confirmOnline!(S1), true);
    assert.equal(a.isOnline(S1, noBridge), true, 'the cache says online');
    const reached = k.requests.length;
    image = undefined;   // tasklist timed out on a busy machine
    // No snapshot is cached yet (quotaAt is -Infinity), so no throttle window applies; a cached "online" is still no
    // licence: both a normal and a refreshing read check afresh, get "unknown", and send not one request.
    assert.equal(await a.quota!({ refresh: false }), null, 'unknown: no snapshot, nothing asked');
    assert.equal(await a.quota!({ refresh: true }), null);
    assert.equal(k.requests.length, reached, 'no oauth/usage request: the token never went to the port');
    assert.equal(a.isOnline(S1, noBridge), true, 'the last real answer still stands');
    await a.close?.();
  } finally { await k.close(); }
});

test('kimi 2d: a retry inside one check can still confirm the app', async () => {
  const k = await fakeKimi();
  try {
    k.register();
    let calls = 0;
    const a = adapterFor(k, { appCheckMs: 60_000, processImage: async () => (++calls === 1 ? undefined : 'Kimi Code.exe') });
    assert.equal(await a.confirmOnline!(S1), true);
    await a.close?.();
  } finally { await k.close(); }
});

test('kimi 2e: an older check answering "running" late does not override a newer "not running"', async () => {
  const k = await fakeKimi();
  try {
    k.register();
    const gates: ((v: string | null | undefined) => void)[] = [];
    const a = adapterFor(k, { appCheckMs: 40, processImage: () => new Promise((done) => gates.push(done)) });
    const first = a.confirmOnline!(S1);
    // readInstances is async, so both checks could reach processImage in either order. Wait for the first one to get
    // there before starting the second: gates[0] is then the older check and gates[1] the newer one.
    await waitFor(() => gates.length === 1, 'the first check reached processImage');
    const second = a.confirmOnline!(S1);
    await waitFor(() => gates.length === 2, 'the second check reached processImage');
    gates[1](null);                 // the newer check says the app is gone
    assert.equal(await second, false);
    await new Promise((ok) => setTimeout(ok, 60));   // the newer answer is now older than appCheckMs
    gates[0]('Kimi Code.exe');      // the older check answers "running" late
    assert.equal(await first, false, 'a running answer older than a newer not-running is stale');
    // The stale answer sets neither the state nor the cache time: the "not running" is still 60 ms old, so it is due.
    assert.equal(a.isOnline(S1, noBridge), false);
    await waitFor(() => gates.length === 3, 'the next background check starts when due, not appCheckMs after the stale answer');
    gates[2]('Kimi Code.exe');
    await waitFor(() => a.isOnline(S1, noBridge), 'that check answers and the cache follows it');
    await a.close?.();
  } finally { await k.close(); }
});

test('kimi 2g: a check slower than appCheckMs starts no second one, and the cache age counts from its answer', async () => {
  const k = await fakeKimi();
  try {
    k.register();
    let calls = 0;
    let release: ((v: string) => void) | null = null;
    const a = adapterFor(k, { appCheckMs: 40, processImage: () => { calls++; return new Promise((done) => { release = done; }); } });
    assert.equal(a.isOnline(S1, noBridge), false, 'not known yet');
    await waitFor(() => calls === 1, 'the first background check started');
    await new Promise((ok) => setTimeout(ok, 80));   // the check now takes longer than appCheckMs
    for (let i = 0; i < 5; i++) a.isOnline(S1, noBridge);
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(calls, 1, 'no second check while one runs');
    release!('Kimi Code.exe');
    await waitFor(() => a.isOnline(S1, noBridge), 'the slow check answered "running"');
    await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(calls, 1, 'an answer that just arrived is fresh, however long the query took');
    await new Promise((ok) => setTimeout(ok, 50));
    a.isOnline(S1, noBridge);
    await waitFor(() => calls === 2, 'appCheckMs after the answer, the next isOnline refreshes');
    release!('Kimi Code.exe');
    await a.close?.();
  } finally { await k.close(); }
});

test('kimi 2b: netstat parsing: only listening rows of the port, all owned by one pid, at least one on 127.0.0.1', () => {
  const out = [
    '', 'Active Connections', '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2684',
    '  TCP    127.0.0.1:53644        0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:53644        127.0.0.1:60000        ESTABLISHED     4242',
    '  TCP    127.0.0.1:60000        127.0.0.1:53644        ESTABLISHED     999',
    '  TCP    127.0.0.1:536440       0.0.0.0:0              LISTENING       7',
    '  TCP    0.0.0.0:7000           0.0.0.0:0              侦听            12',
  ].join('\r\n');
  assert.equal(listenerOwner(out, 53644), 4242);
  assert.equal(listenerOwner(out, 60000), null, 'an outgoing connection is no listener');
  assert.equal(listenerOwner(out, 7000), null, 'bound to all addresses only: not a loopback listener');
  assert.equal(listenerOwner(out + '\r\n  TCP    127.0.0.1:7000         0.0.0.0:0              侦听            12', 7000), 12, 'state word in any language');
  assert.equal(listenerOwner(out + '\r\n  TCP    0.0.0.0:53644          0.0.0.0:0              LISTENING       555', 53644), null, 'two owners');
  assert.equal(listenerOwner(out, 1), null);
});

test('kimi 3: deliver posts only content and prompt_id, with the marker, and completes on the turn end', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  k.onPrompt = (sid, body) => {
    setTimeout(() => runTurn(k, sid, body.prompt_id, ['he', 'llo']), 20);
    return { code: 0, data: { status: 'running' } };
  };
  try {
    const { c, events } = ctx('d-1', undefined, ['user', 'B']);
    assert.equal(await a.deliver(S1, '[orrery] cluster=x from=user\nhi', c), 'completed');
    const [p] = prompts(k);
    assert.equal(p.path, `/api/v1/sessions/${S1}/prompts`);
    assert.equal(p.auth, `Bearer ${TOKEN}`);
    assert.deepEqual(p.body, { content: [{ type: 'text', text: '[orrery · 来自 user、B]\n[orrery] cluster=x from=user\nhi' }], prompt_id: 'd-1' });
    assert.deepEqual(events, [{ type: 'text', text: 'hello' }]);
    assert.deepEqual(k.received.find((m) => m.type === 'subscribe_v2').payload, { session_id: S1, transcript: { main: 'block' } });
    assert.ok(!k.received.some((m) => m.type === 'subscribe'), 'not the old subscribe, which 2.5.1 drops');
    assert.deepEqual(k.received.find((m) => m.type === 'client_hello').payload, { client_id: 'orrery' });
    assert.equal(marker(undefined), '[orrery]');

    // Only known terminal states count as failures; unknown states remain unknown and may still be running.
    for (const reason of ['failed', 'cancelled', 'unexpected']) {
      k.onPrompt = (sid, body) => {
        setTimeout(() => runTurn(k, sid, body.prompt_id, ['partial'], reason, reason === 'failed' ? 'model error' : undefined), 20);
        return { code: 0 };
      };
      const replies: string[] = [];
      const { c, events: failedEvents } = ctx(`d-${reason}`);
      c.reply = (text) => replies.push(text);
      assert.deepEqual(await a.deliver(S1, 'x', c), {
        outcome: reason === 'unexpected' ? 'unknown' : 'failed',
        error: reason === 'unexpected' ? 'Kimi reported an unrecognized turn state (unexpected); it may still be running'
          : `the Kimi turn ended ${reason}${reason === 'failed' ? ': model error' : ''}`,
      });
      assert.deepEqual(replies, []);
      assert.deepEqual(failedEvents, []);
    }
    // Every delivery subscribes again, on the same connection.
    assert.equal(k.received.filter((m) => m.type === 'subscribe_v2').length, 4);
    assert.equal(k.received.filter((m) => m.type === 'client_hello').length, 1);
    assert.equal(k.requests.filter((r) => r.path.endsWith(':abort')).length, 0, 'an unrecognized state never aborts the turn');
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi 4: already delivered, session busy elsewhere, unknown session, Kimi not running', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  try {
    k.onPrompt = () => ({ code: 40927, msg: 'in flight' });
    assert.deepEqual(await a.deliver(S1, 'x', ctx('d-1').c), { outcome: 'unknown', error: 'Kimi already knows this prompt ID (40927); its turn outcome is unknown' });
    k.onPrompt = () => ({ code: 40903, msg: 'completed' });
    assert.deepEqual(await a.deliver(S1, 'x', ctx('d-1').c), { outcome: 'unknown', error: 'Kimi already knows this prompt ID (40903); its turn outcome is unknown' });

    // Busy in another process twice, then free: waits and delivers; never takes the session over.
    let busy = 2;
    k.onPrompt = (sid, body) => {
      if (busy-- > 0) return { code: 40931, msg: 'occupied' };
      setTimeout(() => runTurn(k, sid, body.prompt_id, ['ok']), 20);
      return { code: 0 };
    };
    const before = prompts(k).length;
    assert.equal(await a.deliver(S1, 'x', ctx('d-3').c), 'completed');
    assert.equal(prompts(k).length - before, 3);
    k.onPrompt = () => ({ code: 40931, msg: 'occupied' });
    await assert.rejects(adapterFor(k, { occupiedRetries: 2 }).deliver(S1, 'x', ctx('d-4').c), /busy in another Kimi Code process/);
    assert.ok(k.requests.every((r) => !r.path.includes('takeover')), 'never takes over the session lock');

    k.onPrompt = () => ({ code: 40110, msg: 'model not ready' });
    await assert.rejects(a.deliver(S1, 'x', ctx('d-5').c), /refused the message: 40110 model not ready/);
    // Stale after Kimi's own reload and retry: nothing special, it fails like any other refusal.
    k.onPrompt = () => ({ code: 40932, msg: 'updated by another client' });
    await assert.rejects(a.deliver(S1, 'x', ctx('d-5b').c), /refused the message: 40932 updated by another client/);

    k.known.delete(S2);
    await assert.rejects(a.deliver(S2, 'x', ctx('d-6').c), /not found by the running Kimi Code/);

    // Kimi quit: no instance file. Offline, and not a single request.
    const n = k.requests.length;
    rmSync(join(k.home, 'server', 'instances', '01INSTANCE.json'));
    assert.equal(await adapterFor(k).deliver(S1, 'x', ctx('d-7').c), 'offline');
    assert.equal(k.requests.length, n);
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi: an accepted prompt with a lost event stream has an unknown outcome', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  k.onPrompt = () => {
    setTimeout(() => k.disconnect(), 20);
    return { code: 0 };
  };
  try {
    assert.deepEqual(await a.deliver(S1, 'x', ctx('d-lost').c), {
      outcome: 'unknown', error: 'Kimi accepted the message, but the event connection closed before its outcome was observed',
    });
    assert.equal(prompts(k).length, 1, 'a lost stream does not resend the prompt');
  } finally {
    await a.close?.();
    await k.close();
  }
});

for (const code of [0, 40402, 50001]) {
  test(`kimi r2: abort response ${code} does not prove the prompt was withdrawn`, async () => {
    const k = await fakeKimi();
    const a = adapterFor(k, { pickupTimeoutMs: 100 });
    k.abortReply = { code };
    k.onPrompt = () => ({ code: 0 });
    try {
      const result = await a.deliver(S1, 'x', ctx(`d-abort-${code}`).c);
      assert.equal(typeof result, 'object');
      if (typeof result !== 'object') throw new Error('expected unknown outcome');
      assert.equal(result.outcome, 'unknown');
      assert.match(result.error, new RegExp(String(code)));
      assert.match(result.error, /unknown|may.*run/i);
      assert.doesNotMatch(result.error, /it was taken back out of the queue/i);
      assert.equal(k.requests.filter((r) => r.path.endsWith(':abort')).length, 1);
    } finally {
      await a.close?.();
      await k.close();
    }
  });
}

test('kimi r2: a matched queued turn still times out and attempts withdrawal', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k, { pickupTimeoutMs: 250 });
  const stop = new AbortController();
  k.onPrompt = (sid, body) => {
    setTimeout(() => {
      emitOps(k, sid, [turnOp('queued-turn', 'queued', { triggerPromptId: body.prompt_id })]);
      k.emit({ type: 'ping', payload: { nonce: 'queued-timeout' } });
    }, 10);
    return { code: 0 };
  };
  const pending = a.deliver(S1, 'x', ctx('d-queued-timeout', stop.signal).c).then(
    (value) => ({ value }), (error: Error) => ({ error: error.message }),
  );
  try {
    await waitFor(() => k.received.some((m) => m.type === 'pong' && m.payload?.nonce === 'queued-timeout'), 'queued observed');
    const result = await Promise.race([pending, new Promise<null>((done) => setTimeout(() => done(null), 800))]);
    assert.ok(result && 'value' in result && typeof result.value === 'object', 'a queued turn must not leave delivery waiting indefinitely');
    assert.equal(result.value.outcome, 'unknown');
    assert.deepEqual(k.requests.filter((r) => r.path.endsWith(':abort')).map((r) => r.path), [`/api/v1/sessions/${S1}/prompts/d-queued-timeout:abort`]);
  } finally {
    stop.abort();
    await pending;
    await a.close?.();
    await k.close();
  }
});

test('kimi r2: cancelling after a matched queued turn attempts withdrawal', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  const stop = new AbortController();
  k.onPrompt = (sid, body) => {
    setTimeout(() => {
      emitOps(k, sid, [turnOp('queued-turn', 'queued', { triggerPromptId: body.prompt_id })]);
      k.emit({ type: 'ping', payload: { nonce: 'queued-cancel' } });
    }, 10);
    return { code: 0 };
  };
  const pending = a.deliver(S1, 'x', ctx('d-queued-cancel', stop.signal).c).then(
    (value) => ({ value }), (error: Error) => ({ error: error.message }),
  );
  try {
    await waitFor(() => k.received.some((m) => m.type === 'pong' && m.payload?.nonce === 'queued-cancel'), 'queued observed');
    stop.abort();
    const result = await pending;
    assert.deepEqual(k.requests.filter((r) => r.path.endsWith(':abort')).map((r) => r.path), [`/api/v1/sessions/${S1}/prompts/d-queued-cancel:abort`]);
    assert.ok('value' in result && typeof result.value === 'object');
    assert.equal(result.value.outcome, 'unknown');
  } finally {
    stop.abort();
    await pending;
    await a.close?.();
    await k.close();
  }
});

test('kimi 5: an unstarted message attempts withdrawal on abort or timeout; an observed running turn is left alone', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k, { pickupTimeoutMs: 200 });
  const aborts = () => k.requests.filter((r) => r.path.endsWith(':abort')).map((r) => r.path);
  try {
    k.onPrompt = () => ({ code: 0, data: { status: 'queued' } });
    const timed = await a.deliver(S1, 'x', ctx('d-1').c);
    assert.ok(typeof timed === 'object' && timed.outcome === 'unknown');
    assert.match(timed.error, /did not report starting the message within/);
    assert.deepEqual(aborts(), [`/api/v1/sessions/${S1}/prompts/d-1:abort`]);

    const stop = new AbortController();
    const p = a.deliver(S1, 'x', ctx('d-2', stop.signal).c);
    await waitFor(() => prompts(k).length === 2, 'second prompt');
    stop.abort();
    const cancelled = await p;
    assert.ok(typeof cancelled === 'object' && cancelled.outcome === 'unknown');
    assert.match(cancelled.error, /delivery aborted/);
    assert.equal(aborts().length, 2);

    // Once its turn runs, an abort only stops waiting: the user's visible turn goes on.
    const run = new AbortController();
    k.onPrompt = (sid, body) => {
      setTimeout(() => emitOps(k, sid, [turnOp('t9', 'queued', { triggerPromptId: body.prompt_id }), turnOp('t9', 'running')]), 10);
      return { code: 0 };
    };
    const q = a.deliver(S1, 'x', ctx('d-3', run.signal).c);
    await waitFor(() => prompts(k).length === 3, 'third prompt');
    await new Promise((r) => setTimeout(r, 60));
    run.abort();
    const running = await q;
    assert.ok(typeof running === 'object' && running.outcome === 'unknown');
    assert.match(running.error, /turn may still be running/);
    assert.equal(aborts().length, 2);
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi: abort reporting an already-run prompt keeps its result unknown', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k, { pickupTimeoutMs: 200 });
  k.abortReply = { code: 40903 };
  try {
    k.onPrompt = () => ({ code: 0 });
    const timed = await a.deliver(S1, 'x', ctx('d-timeout').c);
    assert.deepEqual(timed, {
      outcome: 'unknown',
      error: 'Kimi did not report starting the message within 0 min; Kimi reports the prompt already ran (40903); its outcome is unknown',
    });

    k.onPrompt = () => 'reset';
    const reset = await a.deliver(S1, 'x', ctx('d-reset').c);
    assert.equal(typeof reset, 'object');
    if (typeof reset !== 'object') throw new Error('expected an unknown outcome');
    assert.equal(reset.outcome, 'unknown');
    assert.match(reset.error, /ECONNRESET.*already ran \(40903\)/);

    k.onPrompt = () => ({ code: 0 });
    const stop = new AbortController();
    const cancelled = a.deliver(S1, 'x', ctx('d-cancel', stop.signal).c);
    await waitFor(() => prompts(k).length === 3, 'third prompt');
    stop.abort();
    assert.deepEqual(await cancelled, {
      outcome: 'unknown', error: 'delivery aborted; Kimi reports the prompt already ran (40903); its outcome is unknown',
    });
    assert.equal(k.requests.filter((r) => r.path.endsWith(':abort')).length, 3, 'one abort per attempt');
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi 5b: a submit that times out or is cut off attempts withdrawal and keeps the original error', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k, { requestTimeoutMs: 300 });
  const aborts = () => k.requests.filter((r) => r.path.endsWith(':abort')).length;
  try {
    k.onPrompt = () => 'hang';
    const timed = await a.deliver(S1, 'x', ctx('d-1').c);
    assert.ok(typeof timed === 'object' && timed.outcome === 'unknown');
    assert.match(timed.error, /did not answer \(ETIMEDOUT\)/);
    assert.equal(aborts(), 1);
    k.onPrompt = () => 'reset';
    const reset = await a.deliver(S1, 'x', ctx('d-2').c);
    assert.ok(typeof reset === 'object' && reset.outcome === 'unknown');
    assert.match(reset.error, /did not answer \(ECONNRESET\)/);
    assert.equal(aborts(), 2);
    assert.deepEqual(k.requests.filter((r) => r.path.endsWith(':abort')).map((r) => r.path),
      [`/api/v1/sessions/${S1}/prompts/d-1:abort`, `/api/v1/sessions/${S1}/prompts/d-2:abort`]);

    // Cancelled while the submit hangs, then it times out: withdrawal is still attempted.
    k.onPrompt = () => 'hang';
    const stop = new AbortController();
    const p = a.deliver(S1, 'x', ctx('d-3', stop.signal).c);
    await waitFor(() => prompts(k).length === 3, 'third prompt');
    stop.abort();
    const cancelled = await p;
    assert.ok(typeof cancelled === 'object' && cancelled.outcome === 'unknown');
    assert.match(cancelled.error, /ETIMEDOUT/);
    assert.equal(aborts(), 3);
  } finally {
    await a.close?.();
    await k.close();
  }
});

/**
 * Kimi restarts while the event connection to A is being opened. A's handshake is held at the fake's upgrade handler
 * until B has taken over (B's event connection is subscribed), so A always finishes late, however slow the machine.
 * `pauseMs` waits after the restart before the second delivery starts, standing in for a slow machine.
 */
async function restartDuringHandshake(pauseMs: number) {
  const kA = await fakeKimi({ serverId: 'server-A' });
  const kB = await fakeKimi({ home: kA.home, serverId: 'server-B' });
  kA.register();
  // The fixture holds A's handshake on purpose: give it far more than the default 3 s (production limits are unchanged).
  const a = adapterFor(kA, { requestTimeoutMs: 60_000 });
  let release!: () => void;
  kA.upgradeGate = new Promise<void>((r) => { release = r; });
  try {
    kA.onPrompt = () => ({ code: 0 });
    answer(kB, ['from B']);
    // Captured at once, so a rejection is never unhandled while the test waits.
    const first = a.deliver(S1, 'x', ctx('d-1').c).then((value) => ({ value }), (error: Error) => ({ error }));
    await waitFor(() => kA.upgrades > 0, "A's handshake held at the upgrade", 30_000);
    kB.register();                                  // Kimi restarted: the instance file now names B
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    const replies: string[] = [];
    const second = ctx('d-2');
    second.c.reply = (t) => replies.push(t);
    const done = a.deliver(S1, 'y', second.c);
    await waitFor(() => kB.received.some((m) => m.type === 'subscribe_v2'), 'B has taken over', 30_000);
    release();                                      // only now does A's late handshake finish
    assert.equal(await done, 'completed');
    assert.deepEqual(replies, ['from B']);
    assert.equal(prompts(kA).length, 0, 'nothing was submitted to A');
    assert.equal(prompts(kB).length, 1);
    const late = await first;
    assert.ok('error' in late, 'the first delivery fails');
    assert.match(late.error.message, /restarted/);
  } finally {
    release();
    await a.close?.();
    await kA.close();
    await kB.close();
  }
}

test('kimi 5c: Kimi restarting while the event connection opens: events and the submit go to the same instance', () => restartDuringHandshake(0));

// One real 3.2 s pause: longer than the 3 s request limit the other tests use, which is what made this scenario fail on a
// slow machine. The pause has to be real time because the adapter's handshake timer is a real timer.
test('kimi 5c: the restart scenario still holds when the machine is slower than the usual 3 s request limit', () => restartDuringHandshake(3200));

test('kimi 5d: a service that never confirms the subscription: the error says why, a cancel ends the wait, nothing is submitted', async () => {
  const k = await fakeKimi();
  k.ignoreSubscribe = true;
  const a = adapterFor(k, { subscribeTimeoutMs: 100 });
  const patient = adapterFor(k);   // the default wait: only the cancel can end it in time
  try {
    await assert.rejects(a.deliver(S1, 'x', ctx('d-1').c), /did not confirm the event subscription .*version may be incompatible with orrery/);
    const stop = new AbortController();
    const p = patient.deliver(S1, 'x', ctx('d-2', stop.signal).c);
    await waitFor(() => k.received.filter((m) => m.type === 'subscribe_v2').length === 2, 'second subscribe');
    stop.abort();
    await assert.rejects(p, /delivery aborted/);
    assert.equal(prompts(k).length, 0);
  } finally {
    await a.close?.();
    await patient.close?.();
    await k.close();
  }
});

test('kimi 6: only the answer of the turn this delivery started is replied, once; other turns are ignored; pings get pongs', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  k.onPrompt = (_sid, body) => {
    setTimeout(() => {
      // The user's own turn in the app, and a turn of another prompt: neither is ours.
      emitOps(k, S1, [turnOp('t1', 'running'), textOp('t1', 1, 1, 'the user turn'), turnOp('t1', 'completed')]);
      emitOps(k, S1, [turnOp('t2', 'running', { triggerPromptId: 'someone-else' }), textOp('t2', 1, 1, 'other prompt'), turnOp('t2', 'completed')]);
      k.emit({ type: 'ping', timestamp: new Date().toISOString(), payload: { nonce: 'n-1' } });
      runTurn(k, S1, body.prompt_id, ['  ours', ' only  ']);
    }, 20);
    return { code: 0 };
  };
  try {
    const replies: string[] = [];
    const { c, events } = ctx('d-1');
    c.reply = (t) => replies.push(t);
    assert.equal(await a.deliver(S1, 'x', c), 'completed');
    assert.deepEqual(replies, ['ours only']);
    assert.deepEqual(events, [{ type: 'text', text: '  ours only  ' }]);
    await waitFor(() => k.received.some((m) => m.type === 'pong'), 'pong');
    assert.deepEqual(k.received.find((m) => m.type === 'pong').payload, { nonce: 'n-1' });

    // An empty answer replies nothing.
    k.onPrompt = (sid, body) => {
      setTimeout(() => runTurn(k, sid, body.prompt_id, ['  ']), 20);
      return { code: 0 };
    };
    const empty = ctx('d-2');
    empty.c.reply = (t) => replies.push(t);
    assert.equal(await a.deliver(S1, 'x', empty.c), 'completed');
    assert.deepEqual(replies, ['ours only']);
    assert.equal(a.replies, true);
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi 6b: the answer and the tokens are read from upserts: frames joined in order, a re-sent frame or step counts once, the rest ignored', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  const u1 = { inputOther: 100, output: 10, inputCacheRead: 1000, inputCacheCreation: 5 };
  const u2 = { inputOther: 20, output: 2, inputCacheRead: 2000, inputCacheCreation: 0 };
  const T = 't7';
  k.onPrompt = (_sid, body) => {
    setTimeout(() => {
      emitOps(k, S1, [turnOp(T, 'running', { triggerPromptId: body.prompt_id }), stepOp(T, 1)]);
      emitOps(k, S1, [textOp(T, 1, 1, '')]);                                   // opened empty
      emitOps(k, S2, [textOp(T, 1, 2, 'another session')]);
      emitOps(k, S1, [textOp(T, 1, 2, 'a sub agent')], 'sub');
      emitOps(k, S1, [textOp('t8', 1, 1, 'another turn')]);
      emitOps(k, S1, [
        textOp(T, 1, 3, 'a steered prompt', 'user'),
        { op: 'frame.upsert', turnId: T, stepId: `${T}.1`, frame: { kind: 'thinking', frameId: `${T}.1.f4`, text: 'thinking' } },
        { op: 'frame.upsert', turnId: T, stepId: `${T}.1`, frame: { kind: 'tool', frameId: `${T}.1.call`, toolCallId: 'call', name: 'x', state: 'running' } },
        { op: 'marker.upsert', item: { kind: 'marker', markerId: 'm1', marker: 'hook' } },
      ]);
      emitOps(k, S1, [textOp(T, 1, 1, 'first '), stepOp(T, 1, u1)]);           // flushed, then the step ends
      emitOps(k, S1, [stepOp(T, 1, u1), stepOp(T, 1), textOp(T, 1, 1, 'first ')]);   // upserted again: still once
      emitOps(k, S1, [stepOp(T, 2), textOp(T, 2, 1, ''), textOp(T, 2, 2, ''), textOp(T, 2, 2, 'third'), textOp(T, 2, 1, 'second ')]);
      emitOps(k, S1, [stepOp(T, 2, u2), turnOp(T, 'completed', { triggerPromptId: body.prompt_id })]);
    }, 20);
    return { code: 0 };
  };
  try {
    const replies: string[] = [];
    const used: unknown[] = [];
    const { c } = ctx('d-1');
    assert.equal(await a.deliver(S1, 'x', { ...c, reply: (t) => replies.push(t), usage: (t) => used.push(t) }), 'completed');
    assert.deepEqual(replies, ['first second third']);
    assert.deepEqual(used, [{ input: 120, cachedInput: 3000, cacheWrite: 5, output: 12, reasoning: 0 }]);
  } finally {
    await a.close?.();
    await k.close();
  }
});

test('kimi 6c: a failed or cancelled turn fails the delivery with Kimi\'s error text, posts nothing, and still reports its tokens', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k);
  const end = (state: string, error?: string) => {
    k.onPrompt = (sid, body) => {
      setTimeout(() => {
        emitOps(k, sid, [turnOp('t5', 'running', { triggerPromptId: body.prompt_id }), textOp('t5', 1, 1, 'half an answer'), stepOp('t5', 1, { inputOther: 1, output: 1, inputCacheCreation: 0 })]);
        // Later upserts of a turn name it by turnId alone: the trigger is only needed to recognise it.
        emitOps(k, sid, [turnOp('t5', 'queued'), turnOp('t5', state, error ? { error } : {})]);
      }, 20);
      return { code: 0 };
    };
  };
  try {
    for (const [state, error, expected] of [
      ['failed', 'model error', 'the Kimi turn ended failed: model error'],
      ['failed', undefined, 'the Kimi turn ended failed'],          // wedged turns carry no error
      ['cancelled', undefined, 'the Kimi turn ended cancelled'],
    ] as const) {
      end(state, error);
      const replies: string[] = [];
      const used: unknown[] = [];
      const { c } = ctx(`d-${state}-${error}`);
      assert.deepEqual(await a.deliver(S1, 'x', { ...c, reply: (t) => replies.push(t), usage: (t) => used.push(t) }), { outcome: 'failed', error: expected });
      assert.deepEqual(replies, []);
      assert.equal(used.length, 1);
    }
  } finally {
    await a.close?.();
    await k.close();
  }
});

/** A Hub with a Kimi member (S1) and two native mock members: M (mock, s1) and X (codex, thread t1). */
async function kimiHub(k: FakeKimi, opts: KimiNativeOptions = {}) {
  const dir = tempDir();
  const adapter = adapterFor(k, opts);
  const codex = createMockNativeAdapter({ harness: 'codex', kind: 'queue', sessions: [{ id: 't1', title: 't1', model: null, cwd: dir, updatedAt: null }] });
  const app = await startTestHub({ dir, nativeAdapters: { kimi: adapter, mock: fixtureNativeMock(dir), codex } });
  const { cluster, members: [kimi, m, x] } = await app.api('POST', '/api/clusters', {
    name: 'k',
    members: [
      { harness: 'kimi', mode: 'native', sessionId: S1, name: 'Kimi1' },
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'M' },
      { harness: 'codex', mode: 'native', sessionId: 't1', name: 'X' },
    ],
  });
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  return { app, cluster, kimi, m, x, secret };
}

const answer = (k: FakeKimi, text: string[], delayMs = 20) => {
  k.onPrompt = (sid, body) => {
    setTimeout(() => runTurn(k, sid, body.prompt_id, text), delayMs);
    return { code: 0 };
  };
};

test('kimi 7: the answer is posted as the member, replying to what it got, with @ routing; nothing else is posted', async () => {
  const k = await fakeKimi();
  const h = await kimiHub(k);
  const msgs = () => h.app.messages(h.cluster.id);
  try {
    answer(k, ['@M 你好']);
    await h.app.api('DELETE', `/api/clusters/${h.cluster.id}/members/${h.x.id}`, {});
    const sent = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Kimi1 hello' });
    await waitFor(async () => (await msgs()).some((x) => x.from === h.kimi.id), 'the reply');
    const text = prompts(k)[0].body.content[0].text as string;
    // No list_agents: the note lists the active members other than itself (X was removed) and the user.
    assert.match(text, /群里现在的其他成员：@M（mock）、@user 是你的用户。/);
    assert.match(text, /^\[orrery · 来自 user\]\n\[orrery\] cluster=k clusterId=\S+ from=user/);
    assert.match(text, /有 ack_messages 工具时，看到消息用 ack_messages 确认/);
    assert.match(text, /没有这些工具时，无法主动确认/);
    assert.match(text, /有 MCP 工具时可调用 send_message 发言、read_messages 读消息/);
    assert.match(text, /这一轮已用 send_message 发言时，不再代发回答/);
    assert.match(text, /没有这些工具时，无法主动确认，只能回答投给你的消息，不能主动发言，也读不到群里别的消息/);
    const reply = (await msgs()).find((x) => x.from === h.kimi.id)!;
    assert.deepEqual([reply.body, reply.replyTo, reply.hop, reply.chainId, reply.mentions], ['@M 你好', sent.id, 1, sent.chainId, [h.m.id]]);
    // Routed like any member's message: M gets it delivered.
    await waitFor(async () => (await msgs()).find((x) => x.id === reply.id)!.deliveries.find((d) => d.memberId === h.m.id)?.state === 'done', 'M got it');
    assert.equal((await msgs()).find((x) => x.id === sent.id)!.deliveries[0].state, 'done');

    // A turn orrery did not start (the user typing in Kimi) is never posted; nor is an empty answer.
    const before = (await msgs()).length;
    emitOps(k, S1, [turnOp('t30', 'running'), textOp('t30', 1, 1, '@M not from orrery'), turnOp('t30', 'completed')]);
    answer(k, []);
    const quiet = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Kimi1 say nothing' });
    await waitFor(async () => (await msgs()).find((x) => x.id === quiet.id)!.deliveries[0].state === 'done', 'delivered');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await msgs()).length, before + 1, 'only the user message was added');
  } finally {
    await h.app.close();
    await k.close();
  }
});

test('kimi 8: the reply obeys the hop limit and the pause switch', async () => {
  const k = await fakeKimi();
  const h = await kimiHub(k);
  const msgs = () => h.app.messages(h.cluster.id);
  try {
    // Hop limit 0: the user's message is hop 0, the answer would be hop 1. Not posted; a guard event says why.
    await h.app.api('PATCH', '/api/settings', { maxHops: { kind: 'finite', value: 0 } });
    answer(k, ['@M too far']);
    const first = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Kimi1 one' });
    await waitFor(async () => (await msgs()).find((x) => x.id === first.id)!.deliveries[0].state === 'done', 'delivered');
    assert.equal((await msgs()).length, 1);
    assert.ok(h.app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_hops' && e.memberId === h.kimi.id));

    // Paused while Kimi answers: the answer is posted, but M's delivery waits for the switch.
    await h.app.api('PATCH', '/api/settings', { maxHops: { kind: 'finite', value: 6 } });
    answer(k, ['@M later'], 200);
    const second = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Kimi1 two' });
    await waitFor(() => prompts(k).length === 2, 'second prompt');
    await h.app.api('POST', '/api/pause', { paused: true });
    await waitFor(async () => (await msgs()).some((x) => x.from === h.kimi.id), 'the reply');
    const reply = (await msgs()).find((x) => x.from === h.kimi.id)!;
    assert.equal(reply.replyTo, second.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await msgs()).find((x) => x.id === reply.id)!.deliveries[0].state, 'queued');
    await h.app.api('POST', '/api/pause', { paused: false });
    await waitFor(async () => (await msgs()).find((x) => x.id === reply.id)!.deliveries[0].state === 'done', 'M got it after the pause');
  } finally {
    await h.app.close();
    await k.close();
  }
});

test('kimi 11: an unanswered check fails the delivery instead of ending it offline', async () => {
  const k = await fakeKimi();
  let image: string | null | undefined = 'Kimi Code.exe';
  // A long cache age: after the warm delivery the Hub remembers "online" without a new check of its own.
  const h = await kimiHub(k, { appCheckMs: 60_000, processImage: async () => image });
  const msgs = () => h.app.messages(h.cluster.id);
  try {
    answer(k, ['@M warm']);
    const warm = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Kimi1 warm' });
    await waitFor(async () => (await msgs()).find((x) => x.id === warm.id)!.deliveries[0].state === 'done', 'the warm delivery');

    // The cache says online. tasklist then stops answering (busy machine): that is unknown, not "not running".
    image = undefined;
    const asked = k.requests.length;
    const promptsBefore = prompts(k).length;
    const second = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Kimi1 again' });
    const delivery = await waitFor(async () => {
      const d = (await msgs()).find((x) => x.id === second.id)!.deliveries[0];
      return ['done', 'failed', 'offline', 'superseded'].includes(d.state) ? d : undefined;
    }, 'the second delivery to settle');
    assert.notEqual(delivery.state, 'offline', 'unknown is not "not running": the delivery must not be dropped as offline');
    assert.equal(delivery.state, 'failed');
    assert.match(String(delivery.error), /could not check whether Kimi Code is running/);
    assert.equal(prompts(k).length, promptsBefore, 'nothing was submitted');
    assert.equal(k.requests.length, asked, 'not one request: the token never went to the port');
  } finally {
    await h.app.close();
    await k.close();
  }
});

test('kimi 9: an MCP caller with the kimi header and no session is no member, not even a Codex thread', async () => {
  const k = await fakeKimi();
  const h = await kimiHub(k);
  const client = new Client({ name: 'kimi-test', version: '0' });
  try {
    assert.equal(await mcpStatus(h.app.url, { 'x-orrery-bridge': h.secret, 'x-orrery-harness': '' }), 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(h.app.url + '/mcp'), {
      requestInit: { headers: { 'x-orrery-bridge': h.secret, 'x-orrery-harness': 'kimi' } },
    }));
    // With a Codex member's thread id in _meta it would be X on the Codex path; with the header it is nobody.
    const sent = await client.callTool({ name: 'send_message', arguments: { body: 'hi' }, _meta: { threadId: 't1' } });
    assert.deepEqual([sent.isError, (sent.content as any)[0].text], [true, '这个对话还不是任何 orrery 集群的成员']);
    const read = await client.callTool({ name: 'read_messages', arguments: {} });
    assert.equal(read.isError, true);
    const list = await client.callTool({ name: 'list_agents', arguments: {}, _meta: { threadId: 't1' } });
    assert.deepEqual(JSON.parse((list.content as any)[0].text), []);
    assert.equal((await h.app.messages(h.cluster.id)).length, 0, 'nothing was written');

    // The other header values keep their own paths: antigravity asks for its hook signature, no header is Codex.
    const as = async (headers: Record<string, string>, meta?: Record<string, unknown>) => {
      const c = new Client({ name: 'kimi-test-2', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(h.app.url + '/mcp'), { requestInit: { headers } }));
      try {
        const r = await c.callTool({ name: 'send_message', arguments: { body: 'path check' }, ...(meta ? { _meta: meta } : {}) });
        return { isError: r.isError === true, text: (r.content as any)[0].text as string };
      } finally {
        await c.close();
      }
    };
    assert.match((await as({ 'x-orrery-bridge': h.secret, 'x-orrery-harness': 'antigravity' })).text, /没有 orrery hook 的签名/);
    assert.equal((await as({ 'x-orrery-bridge': h.secret }, { threadId: 't1' })).isError, false);
    assert.equal((await h.app.messages(h.cluster.id)).at(-1)!.from, h.x.id, 'no harness header: the Codex thread path');
  } finally {
    await client.close();
    await h.app.close();
    await k.close();
  }
});

test('kimi 9b: runtime session metadata enables Kimi MCP tools, while missing or wrong identities stay closed', async () => {
  const k = await fakeKimi();
  const h = await kimiHub(k);
  const client = new Client({ name: 'kimi-session-test', version: '0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(h.app.url + '/mcp'), {
      requestInit: { headers: { 'x-orrery-bridge': h.secret, 'x-orrery-harness': 'kimi' } },
    }));
    const meta = { 'kimi/sessionId': S1 };
    const listed = await client.callTool({ name: 'list_agents', arguments: {}, _meta: meta });
    assert.notEqual(listed.isError, true);
    assert.ok(JSON.parse((listed.content as any)[0].text).some((m: any) => m.name === 'Kimi1'));
    const read = await client.callTool({ name: 'read_messages', arguments: { history: true }, _meta: meta });
    assert.notEqual(read.isError, true);
    const sent = await client.callTool({ name: 'send_message', arguments: { body: '@M direct from kimi' }, _meta: meta });
    assert.notEqual(sent.isError, true);
    const written = (await h.app.messages(h.cluster.id)).at(-1)!;
    assert.deepEqual([written.from, written.body, written.mentions], [h.kimi.id, '@M direct from kimi', [h.m.id]]);

    for (const call of [
      { arguments: { body: 'missing' } },
      { arguments: { body: 'wrong type' }, _meta: { 'kimi/sessionId': 1 } },
      { arguments: { body: 'empty' }, _meta: { 'kimi/sessionId': '' } },
      { arguments: { body: 'unknown' }, _meta: { 'kimi/sessionId': S2 } },
      { arguments: { body: 'argument only', sessionId: S1 } },
      { arguments: { body: 'codex only' }, _meta: { threadId: 't1' } },
    ]) {
      const result = await client.callTool({ name: 'send_message', ...call });
      assert.deepEqual([result.isError, (result.content as any)[0].text], [true, '这个对话还不是任何 orrery 集群的成员']);
    }
    assert.equal((await h.app.messages(h.cluster.id)).length, 1, 'only the authenticated call wrote a message');
    assert.equal(await mcpStatus(h.app.url, { 'x-orrery-bridge': 'wrong', 'x-orrery-harness': 'kimi' }), 401);

    await h.app.api('DELETE', `/api/clusters/${h.cluster.id}/members/${h.kimi.id}`, {});
    const removed = await client.callTool({ name: 'send_message', arguments: { body: 'removed' }, _meta: meta });
    assert.equal(removed.isError, true);
    assert.equal((await h.app.messages(h.cluster.id)).length, 1);
  } finally {
    await client.close();
    await h.app.close();
    await k.close();
  }
});

test('kimi 9c: a direct MCP message suppresses the same run\'s forwarded answer without weakening reply routing', async () => {
  const k = await fakeKimi();
  const h = await kimiHub(k);
  const client = new Client({ name: 'kimi-session-dedup-test', version: '0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(h.app.url + '/mcp'), {
      requestInit: { headers: { 'x-orrery-bridge': h.secret, 'x-orrery-harness': 'kimi' } },
    }));
    k.onPrompt = () => ({ code: 0 });
    const sent = await h.app.api('POST', `/api/clusters/${h.cluster.id}/messages`, { body: '@Kimi1 respond once' });
    await waitFor(() => prompts(k).length === 1, 'Kimi turn started');
    const direct = await client.callTool({
      name: 'send_message', arguments: { body: '@M once', replyTo: sent.id }, _meta: { 'kimi/sessionId': S1 },
    });
    assert.notEqual(direct.isError, true);
    runTurn(k, S1, prompts(k)[0].body.prompt_id, ['@M duplicate answer']);
    await waitFor(() => h.app.settled(h.cluster.id), 'Kimi turn finished');
    const messages = await h.app.messages(h.cluster.id);
    assert.equal(messages.length, 2, 'only the user message and the direct MCP message remain');
    assert.deepEqual([messages[1].from, messages[1].body, messages[1].mentions], [h.kimi.id, '@M once', [h.m.id]]);
    assert.equal(messages[1].replyTo, sent.id);
  } finally {
    await client.close();
    await h.app.close();
    await k.close();
  }
});

test('kimi 10: the adapter never starts or opens Kimi and never changes session settings (source check)', () => {
  // Code only: comments may name what is avoided.
  const src = ['native.ts', 'store.ts', 'ws.ts', 'transcript.ts']
    .map((f) => readFileSync(join(import.meta.dirname, '..', 'src', 'adapters', 'kimi', f), 'utf8'))
    .join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  assert.doesNotMatch(src, /kimi-code:\/\//);
  // The only processes it ever starts are tasklist (is the app running?) and netstat (who owns the port?).
  assert.deepEqual([...src.matchAll(/from 'node:child_process'/g)].length, 1);
  assert.match(src, /import \{ execFile \} from 'node:child_process'/);
  assert.doesNotMatch(src, /\bspawn|execSync|execFileSync|\bfork\(/);
  assert.deepEqual([...src.matchAll(/execFile\('([^']+)'/g)].map((m) => m[1]), ['tasklist', 'netstat']);
  assert.doesNotMatch(src, /takeover|permission_mode|disabled_tools|\bfetch\(|new WebSocket/);
  assert.doesNotMatch(src, /console\./, 'nothing is logged (the token must never be)');
});

test('kimi usage: a turn reports the sum of its own steps (another agent\'s not); quota from oauth/usage, at most every 5 min unless refreshed, never when not running', async () => {
  const k = await fakeKimi();
  const a = adapterFor(k, { quotaRefreshMinMs: 0 });
  try {
    k.onPrompt = (sid, body) => {
      setTimeout(() => {
        emitOps(k, sid, [turnOp('t3', 'running', { triggerPromptId: body.prompt_id }), stepOp('t3', 1)]);
        emitOps(k, sid, [stepOp('t3', 1, { inputOther: 100, output: 10, inputCacheRead: 1000, inputCacheCreation: 5 })]);
        emitOps(k, sid, [stepOp('t3', 1, { inputOther: 9999, output: 9999, inputCacheCreation: 0 })], 'sub');
        emitOps(k, sid, [stepOp('t3', 2, { inputOther: 20, output: 2, inputCacheRead: 2000, inputCacheCreation: 0 }), turnOp('t3', 'completed')]);
      }, 20);
      return { code: 0 };
    };
    const used: unknown[] = [];
    const { c } = ctx('d-u');
    assert.equal(await a.deliver(S1, 'x', { ...c, usage: (t) => used.push(t) }), 'completed');
    assert.deepEqual(used, [{ input: 120, cachedInput: 3000, cacheWrite: 5, output: 12, reasoning: 0 }]);

    const asked = () => k.requests.filter((r) => r.path === '/api/v1/oauth/usage');
    const q = (await a.quota!({ refresh: false }))!;
    assert.deepEqual(q.windows.map((w) => [w.id, w.usedPercent, w.resetsAt]), [['limit5h', 25, '2026-11-03T14:00:00.000Z'], ['limit7d', 50, null]]);
    assert.equal(asked()[0].auth, `Bearer ${TOKEN}`);
    k.usage = { code: 0, data: { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.75 } } } } };
    assert.deepEqual(await a.quota!({ refresh: false }), q, 'within 5 min: the last answer, nothing asked');
    assert.equal(asked().length, 1);
    assert.equal((await a.quota!({ refresh: true }))!.windows[0].usedPercent, 75, 'refresh asks now');
    k.usage = { code: 0, data: { kind: 'error', message: 'not logged in' } };
    await assert.rejects(a.quota!({ refresh: true }), /not logged in/);
  } finally {
    await a.close?.();
    await k.close();
  }
  // Kimi Code not running: nothing is asked, no snapshot.
  const gone = adapterFor(k, { processImage: async () => null });
  assert.equal(await gone.quota!({ refresh: true }), null);
  await gone.close?.();
});
