// Native Claude without a real model: the real bridge program (src/bridge/claude-bridge.ts) runs as a child process
// against a real Hub and a fake session inbox (a named pipe on Windows, a unix socket elsewhere) that records lines.
// Also the native Claude adapter against a fake BridgePort. docs/native-mode.md, "原生 Claude" and "验收" item 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createClaudeNativeAdapter } from '../src/adapters/claude/native.ts';
import { REPO_ROOT } from '../src/main.ts';
import type { BridgePort, Member, NativeDeliverContext } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

const BRIDGE = join(REPO_ROOT, 'src', 'bridge', 'claude-bridge.ts');
const HUB_DOWN = 'orrery Hub 未运行';

// ───────────── fixtures ─────────────

/** A ~/.claude with one session (`id`) whose cwd is `project`. */
function claudeDir(dir: string, id: string, project: string): string {
  const d = join(dir, 'claude');
  mkdirSync(join(d, 'projects', 'proj'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(d, 'projects', 'proj', `${id}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd: project, message: { role: 'user', content: 'hello from the app' } })}\n`);
  return d;
}

interface Inbox { path: string; connections: string[][]; close(): Promise<void> }

/**
 * A fake session inbox: records the lines of every connection, closes each connection after the client's end.
 * hangUp: drops every connection as soon as it is accepted, before reading anything.
 */
async function fakeInbox(opts: { hangUp?: boolean } = {}): Promise<Inbox> {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\orrery-test-inbox-${randomUUID()}` : join(tempDir(), 'inbox.sock');
  const connections: string[][] = [];
  const server: Server = createServer((socket) => {
    if (opts.hangUp) {
      socket.destroy();
      return;
    }
    const lines: string[] = [];
    connections.push(lines);
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', (l) => lines.push(l));
  });
  await new Promise<void>((ok) => server.listen(path, ok));
  return { path, connections, close: () => new Promise((ok) => server.close(() => ok())) };
}

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const { port } = s.address() as AddressInfo;
  await new Promise((ok) => s.close(ok));
  return port;
}

/** An HTTP proxy in front of the Hub that records everything passing through in both directions. */
async function recordingProxy(target: string) {
  const t = new URL(target);
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${JSON.stringify(req.headers)}`);
    const up = request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, host: t.host } }, (ur) => {
      res.writeHead(ur.statusCode!, ur.headers);
      res.flushHeaders();
      ur.on('data', (d: Buffer) => { seen.push(d.toString()); res.write(d); });
      ur.on('end', () => res.end());
    });
    up.on('error', () => res.destroy());
    req.on('data', (d: Buffer) => { seen.push(d.toString()); up.write(d); });
    req.on('end', () => up.end());
    res.on('close', () => up.destroy());
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => { server.closeAllConnections(); return new Promise((ok) => server.close(ok)); },
  };
}

function writeHubJson(home: string, url: string, secret: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url, secret, pid: 0 }));
}

/** The real bridge as Claude starts it: stdio JSON-RPC. The test process's own CLAUDE_CODE_* never reach it. */
function spawnBridge(env: Record<string, string>) {
  const base = Object.fromEntries(Object.entries(process.env)
    .filter(([k, v]) => v !== undefined && !/^(CLAUDE_CODE_|CLAUDECODE$|ORRERY_|HTTPS?_PROXY$|NO_PROXY$|NODE_USE_ENV_PROXY$)/i.test(k)));
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...base, ORRERY_BRIDGE_RETRY_MS: '100', ...env } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const out: any[] = [];
  let raw = '';
  child.stdout.on('data', (d: Buffer) => { raw += d.toString('utf8'); });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
    let m: any;
    try {
      m = JSON.parse(l);
    } catch {
      // A line a line reader cannot take whole: every waiting call gets an empty answer, so the test fails, not hangs.
      for (const [id, ok] of waiting) ok({ id, unparsable: l });
      return;
    }
    out.push(m);
    waiting.get(m.id)?.(m);
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
  let next = 1;
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise((ok) => {
    const id = next++;
    waiting.set(id, ok);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const initialize = (protocolVersion = '2025-06-18') =>
    rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
  return {
    child, out, rpc, notify, call, initialize, exited,
    stderr: () => stderr,
    raw: () => raw,
    async stop() {
      child.stdin.end();
      return exited;
    },
  };
}

/** A Hub with the real native Claude adapter over a fake ~/.claude holding session SID; the cluster: Claude C and mock A. */
async function claudeHub(dir = tempDir(), sid = randomUUID(), startupGraceMs = 0) {
  const project = join(dir, 'project');
  const adapter = createClaudeNativeAdapter({ claudeDir: claudeDir(dir, sid, project) });
  const app = await startTestHub({ dir, nativeAdapters: { claude: adapter }, limits: { recheckMs: 60_000, startupGraceMs } });
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  return Object.assign(app, { sid, secret, project, adapter });
}

async function mixedCluster(app: TestHub, sid: string) {
  const { cluster, members: [c, a] } = await app.api('POST', '/api/clusters', {
    name: 'mix', members: [{ harness: 'claude', mode: 'native', sessionId: sid, name: 'C' }, { harness: 'mock', mode: 'native', name: 'A', projectPath: '/work' }],
  });
  return { cluster, c, a };
}

const statusOf = async (app: TestHub, id: string) =>
  ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status;
const deliveryTo = async (app: TestHub, clusterId: string, messageId: string, memberId: string) =>
  (await app.messages(clusterId)).find((m) => m.id === messageId)?.deliveries.find((d) => d.memberId === memberId);

// ───────────── the bridge program ─────────────

test('claude bridge: a delivery lands in the inbox auth line first, is acked, and the token never leaves the bridge', async () => {
  const app = await claudeHub();
  const inbox = await fakeInbox();
  const proxy = await recordingProxy(app.url);
  const bridgeHome = join(app.dir, 'bridge-home');
  writeHubJson(bridgeHome, proxy.url, app.secret);
  const TOKEN = `inbox-token-${randomBytes(16).toString('hex')}`;
  const logged: string[] = [];
  const consoleOrig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(consoleOrig) as (keyof typeof consoleOrig)[]) {
    console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); consoleOrig[k](...a); };
  }
  const bridge = spawnBridge({
    ORRERY_HOME: bridgeHome, CLAUDE_CODE_SESSION_ID: app.sid, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN,
  });
  try {
    const { cluster, c, a } = await mixedCluster(app, app.sid);
    await waitFor(async () => (await statusOf(app, c.id)) === 'idle', 'the bridge brings C online');
    const listed = await app.api('GET', `/api/harnesses/claude/sessions?mode=native&project=${encodeURIComponent(app.project)}`);
    assert.deepEqual(listed.map((s: any) => [s.id, s.online, s.memberId]), [[app.sid, true, c.id]], 'native listing marks it online');

    // Hub → bridge → inbox: one connection, the auth line first, then the user line; then the ack makes it done.
    const msg = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C 你好 "quoted"\nline 2' });
    await waitFor(async () => (await deliveryTo(app, cluster.id, msg.id, c.id))?.state === 'done', 'delivery acked');
    assert.equal(inbox.connections.length, 1);
    const [auth, user, ...rest] = inbox.connections[0].map((l) => JSON.parse(l));
    assert.deepEqual(auth, { type: 'auth', token: TOKEN });
    assert.deepEqual(Object.keys(user).sort(), ['from', 'message', 'session_id', 'type'], 'no priority');
    assert.deepEqual([user.type, user.session_id, user.from, user.message.role], ['user', app.sid, 'orrery', 'user']);
    assert.match(user.message.content, /^\[orrery\] cluster=mix clusterId=\S+ from=user messageId=\S+ hop=0 to=@C\n@C 你好 "quoted"\nline 2\n\n-{10}\n（你是群员 C。/);
    assert.deepEqual(rest, []);

    // MCP relay: initialize is answered, send_message is attributed to C, notifications get no answer.
    const init = await bridge.initialize();
    await bridge.rpc('tools/list');
    assert.equal(init.result.serverInfo.name, 'orrery');
    assert.equal(init.result.instructions, undefined, 'nothing added to a healthy session');
    bridge.notify('notifications/initialized');
    assert.deepEqual(JSON.parse((await bridge.call('ack_messages', { messageIds: [msg.id] })).content[0].text), { acknowledged: [msg.id] });
    const sent = await bridge.call('send_message', { body: '@A from the app', replyTo: msg.id });
    assert.equal(sent.isError, undefined, sent.content[0].text);
    const { messageId } = JSON.parse(sent.content[0].text);
    const mine = (await app.messages(cluster.id)).find((m) => m.id === messageId)!;
    assert.deepEqual([mine.from, mine.hop, mine.chainId], [c.id, 1, msg.chainId]);
    await waitFor(async () => (await deliveryTo(app, cluster.id, messageId, a.id))?.state === 'done', '@A delivered');
    const agents = JSON.parse((await bridge.call('list_agents')).content[0].text);
    const version = app.hub.toolVersionReport().find((row) => row.memberId === c.id)?.observation;
    const versions = await app.api('GET', '/api/tool-versions');
    assert.equal(version?.bridge?.source, 'claude-forwarded');
    assert.equal(version?.bridge?.fingerprint, versions.hub.standard);
    assert.equal(version?.client, null, 'a forwarded list does not prove the client cache');
    assert.deepEqual(agents.map((m: any) => m.name).sort(), ['A', 'C']);
    const task = JSON.parse((await bridge.call('create_task', { operationId: 'claude-create', title: 'Task', scope: 'Scope', acceptance: 'Done' })).content[0].text);
    assert.equal(task.task.createdBy, c.id, 'the stdio bridge attributes the task to its session');
    assert.equal(bridge.out.filter((m) => m.id === undefined).length, 0, 'no line answered the notification');

    // The token appears nowhere outside the bridge: not on the wire to the Hub (either direction), not in Hub
    // events, logs, API answers, the database or the Hub's home, not in the bridge's own stderr.
    const api = JSON.stringify([
      await app.api('GET', '/api/state'), await app.messages(cluster.id),
      await app.api('GET', `/api/members/${c.id}/events`), await app.api('GET', `/api/members/${a.id}/events`),
    ]);
    const db = ['test.db', 'test.db-wal'].filter((f) => existsSync(join(app.dir, f))).map((f) => readFileSync(join(app.dir, f)).toString('latin1'));
    // Every file in the home, in its folders too (outbox/ exists from the start).
    const home = readdirSync(app.home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'));
    const places = { wire: proxy.seen.join('\n'), events: JSON.stringify(app.events), logs: logged.join('\n'), api, db: db.join(''), home: home.join(''), stderr: bridge.stderr() };
    assert.ok(proxy.seen.some((s) => s.includes('/bridge/ack')) && proxy.seen.some((s) => s.includes('x-orrery-session')), 'the proxy saw the traffic');
    for (const [where, s] of Object.entries(places)) assert.ok(!s.includes(TOKEN), `token found in ${where}`);
  } finally {
    Object.assign(console, consoleOrig);
    await bridge.stop();
    await proxy.close();
    await inbox.close();
    await app.close();
  }
});

test('claude bridge: Hub requests never go through an environment proxy (NODE_USE_ENV_PROXY); U+2028/U+2029 survive the stream', async () => {
  const app = await claudeHub();
  const inbox = await fakeInbox();
  // A proxy that records whatever reaches it (plain requests and CONNECT) and serves nothing.
  const seen: string[] = [];
  const proxy = createHttpServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(502).end(); });
  proxy.on('connect', (req, socket) => { seen.push(`CONNECT ${req.url}`); socket.destroy(); });
  await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const bridge = spawnBridge({
    ORRERY_HOME: app.home, CLAUDE_CODE_SESSION_ID: app.sid, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't',
    NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '',
  });
  try {
    const { cluster, c } = await mixedCluster(app, app.sid);
    await waitFor(async () => (await statusOf(app, c.id)) === 'idle', 'stream connected')
      .catch((e) => { assert.deepEqual(seen, [], 'the proxy saw no request'); throw e; });
    const [LS, PS] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    const body = `@C line${LS}separator${PS}paragraph end`;
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m.id, c.id))?.state === 'done', 'acked');
    assert.ok(JSON.parse(inbox.connections[0][1]).message.content.includes(`\n${body}\n`), 'the whole text reached the inbox');
    const sent = await bridge.call('send_message', { body: 'relayed' });
    assert.equal(sent.isError, undefined, sent.content[0].text);
    // The relayed answer carries the separators too: on stdout they are escaped, and the JSON still decodes to them.
    const read = JSON.parse((await bridge.call('read_messages', { history: true })).content[0].text);
    assert.equal(read.find((x: any) => x.id === m.id).body, body);
    assert.ok(!bridge.raw().includes(LS) && !bridge.raw().includes(PS) && bridge.raw().includes(`\\u2028`), 'stdout lines hold no raw U+2028/U+2029');
    assert.deepEqual(seen, [], 'the proxy saw no request');
  } finally {
    await bridge.stop();
    await inbox.close();
    proxy.closeAllConnections();
    await new Promise((ok) => proxy.close(ok));
    await app.close();
  }
});

test('claude bridge: Hub down → initialize, tools/list and ping still answer, tools/call says so; same answers as the Hub once it is up', async () => {
  const dir = tempDir();
  const sid = randomUUID();
  const home = join(dir, 'home');
  writeHubJson(home, `http://127.0.0.1:${await deadPort()}`, 'f'.repeat(64));   // a stale hub.json: nothing listens
  const inbox = await fakeInbox();
  const bridge = spawnBridge({ ORRERY_HOME: home, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  let app: Awaited<ReturnType<typeof claudeHub>> | undefined;
  try {
    const down = {
      init: (await bridge.initialize()).result,
      initNew: (await bridge.initialize('2999-01-01')).result,
      tools: (await bridge.rpc('tools/list')).result,
      call: (await bridge.call('send_message', { body: 'x' })),
      ping: (await bridge.rpc('ping')).result,
      other: (await bridge.rpc('resources/list')).error,
    };
    assert.deepEqual(down.call, { content: [{ type: 'text', text: HUB_DOWN }], isError: true });
    assert.deepEqual(down.ping, {});
    assert.equal(down.other.message, HUB_DOWN);
    assert.ok(['list_agents', 'send_message', 'read_messages', 'skip_unread', 'get_deliveries', 'ack_messages', 'create_task', 'bookmark_message'].every(
      (name) => down.tools.tools.some((t: any) => t.name === name)));
    // No hub.json at all is the same.
    writeFileSync(join(home, 'hub.json'), 'not json');
    assert.deepEqual(await bridge.call('list_agents'), { content: [{ type: 'text', text: HUB_DOWN }], isError: true });

    // The Hub comes up (same home: it rewrites hub.json): the bridge connects and relays, with no restart.
    app = await claudeHub(dir, sid);
    const { cluster, c } = await mixedCluster(app, sid);
    await waitFor(async () => (await statusOf(app!, c.id)) === 'idle', 'bridge connects once the Hub is up');
    assert.equal(JSON.parse((await bridge.call('list_agents')).content[0].text).length, 2);
    // What the bridge said on its own equals what the Hub says: initialize (any version) and tools/list.
    const direct = async (body: object) => {
      const r = await fetch(`${app!.url}/mcp`, {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': app!.secret, 'x-orrery-session': sid },
      });
      return (await r.json()).result;
    };
    const params = (v: string) => ({ protocolVersion: v, capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
    assert.deepEqual(down.init, await direct({ method: 'initialize', params: params('2025-06-18') }));
    assert.deepEqual(down.initNew, await direct({ method: 'initialize', params: params('2999-01-01') }));
    assert.deepEqual(down.tools, await direct({ method: 'tools/list' }));
    assert.deepEqual((await bridge.rpc('tools/list')).result, down.tools, 'relayed tools/list');
    assert.deepEqual((await bridge.initialize()).result, down.init, 'initialize does not change with the Hub up');
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C hi' });
    await waitFor(async () => (await deliveryTo(app!, cluster.id, m.id, c.id))?.state === 'done', 'delivered');
  } finally {
    await bridge.stop();
    await inbox.close();
    await app?.close();
  }
});

test('claude bridge: reconnects after the Hub restarts on another port, and what was posted in the start-up grace then arrives', async () => {
  const dir = tempDir();
  let app = await claudeHub(dir);
  const { sid } = app;
  const inbox = await fakeInbox();
  const bridge = spawnBridge({ ORRERY_HOME: app.home, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  try {
    const { cluster, c } = await mixedCluster(app, sid);
    await waitFor(async () => (await statusOf(app, c.id)) === 'idle', 'online');
    const oldUrl = app.url;
    await app.close();
    // Something else takes the old port, so the new Hub must use another one and the bridge must re-read hub.json.
    const squatter = createServer();
    await new Promise<void>((ok) => squatter.listen(Number(new URL(oldUrl).port), '127.0.0.1', ok));
    try {
      app = await claudeHub(dir, sid, 20_000);
    } finally {
      squatter.close();
    }
    assert.notEqual(app.url, oldUrl, 'another port');
    // Posted before the bridge is back, within the start-up grace: it waits queued, then goes out once the bridge reconnects.
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C after restart' });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m.id, c.id))?.state === 'done', 'delivered after reconnect', 10_000);
    assert.equal(inbox.connections.length, 1);
    assert.match(JSON.parse(inbox.connections[0][1]).message.content, /\n@C after restart\n/);
    assert.equal(JSON.parse((await bridge.call('list_agents')).content[0].text).length, 2, 'the relay follows the new port too');
  } finally {
    await bridge.stop();
    await inbox.close();
    await app.close();
  }
});

/** A fake Hub that only holds /bridge/stream open and counts the connections; `down()` drops everything. */
async function fakeStreamHub() {
  let streams = 0;
  const srv = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/bridge/stream')) {
      streams++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    } else res.writeHead(503).end();
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    streams: () => streams,
    down: () => { srv.closeAllConnections(); return new Promise((ok) => srv.close(ok)); },
  };
}

const listChanged = (bridge: ReturnType<typeof spawnBridge>) => bridge.out.filter((m) => m.method === 'notifications/tools/list_changed').length;
const connectedLogs = (bridge: ReturnType<typeof spawnBridge>) => bridge.stderr().split('connected to the Hub').length - 1;
const settle = () => new Promise((ok) => setTimeout(ok, 300));   // a few retry periods (ORRERY_BRIDGE_RETRY_MS=100)

test('claude bridge: tools/list_changed once after the Hub stream comes back, none on the first connect', async () => {
  const home = join(tempDir(), 'home');
  let hub = await fakeStreamHub();
  writeHubJson(home, hub.url, 'f'.repeat(64));
  const inbox = await fakeInbox();
  const bridge = spawnBridge({ ORRERY_HOME: home, CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  try {
    await bridge.initialize();
    await waitFor(() => connectedLogs(bridge) === 1, 'first connect');
    await settle();
    assert.equal(listChanged(bridge), 0, 'nothing on the first connect');
    // The Hub goes down and comes back (here on another port, as after a restart).
    await hub.down();
    await settle();
    hub = await fakeStreamHub();
    writeHubJson(home, hub.url, 'f'.repeat(64));
    await waitFor(() => connectedLogs(bridge) === 2, 'reconnect');
    await settle();
    assert.equal(listChanged(bridge), 1, 'exactly one after the reconnect');
    assert.equal(hub.streams(), 1);
  } finally {
    await bridge.stop();
    await inbox.close();
    await hub.down();
  }
});

test('claude bridge: tools/list answered from the built-in list while the Hub was down → tools/list_changed on the first connect', async () => {
  const home = join(tempDir(), 'home');
  writeHubJson(home, `http://127.0.0.1:${await deadPort()}`, 'f'.repeat(64));
  const inbox = await fakeInbox();
  const bridge = spawnBridge({ ORRERY_HOME: home, CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  const hub = await fakeStreamHub();
  try {
    await bridge.initialize();
    const tools = (await bridge.rpc('tools/list')).result.tools;
    assert.equal(tools.length, 23, 'the built-in list');
    for (const name of ['get_batch', 'manage_batch']) assert.equal(tools.find((tool: any) => tool.name === name)?.inputSchema.type, 'object', name);
    assert.equal(listChanged(bridge), 0);
    writeHubJson(home, hub.url, 'f'.repeat(64));
    await waitFor(() => connectedLogs(bridge) === 1, 'first connect');
    await settle();
    assert.equal(listChanged(bridge), 1);
  } finally {
    await bridge.stop();
    await inbox.close();
    await hub.down();
  }
});

test('claude bridge: the stream\'s tools-changed (a third-party plugin\'s tools came or went) becomes tools/list_changed', async () => {
  const home = join(tempDir(), 'home');
  const open: import('node:http').ServerResponse[] = [];
  const srv = createHttpServer((req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/bridge/stream')) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    open.push(res);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  writeHubJson(home, `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'f'.repeat(64));
  const inbox = await fakeInbox();
  const bridge = spawnBridge({ ORRERY_HOME: home, CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  try {
    await bridge.initialize();
    await waitFor(() => open.length === 1, 'connected');
    await settle();
    assert.equal(listChanged(bridge), 0);
    open[0].write('event: tools-changed\ndata: {}\n\n');
    await waitFor(() => listChanged(bridge) === 1, 'list_changed');
    open[0].write('event: something-else\ndata: {}\n\n');
    await settle();
    assert.equal(listChanged(bridge), 1, 'other events change nothing');
  } finally {
    await bridge.stop();
    await inbox.close();
    srv.closeAllConnections();
    await new Promise((ok) => srv.close(ok));
  }
});

test('claude bridge: an inbox that cannot be reached fails the delivery with the reason; stdin closing exits cleanly', async () => {
  const app = await claudeHub();
  const missing = process.platform === 'win32' ? `\\\\.\\pipe\\orrery-test-missing-${randomUUID()}` : join(app.dir, 'missing.sock');
  const bridge = spawnBridge({ ORRERY_HOME: app.home, CLAUDE_CODE_SESSION_ID: app.sid, CLAUDE_CODE_MESSAGING_SOCKET: missing, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  try {
    const { cluster, c } = await mixedCluster(app, app.sid);
    await waitFor(async () => (await statusOf(app, c.id)) === 'idle', 'online');
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C hi' });
    const d = await waitFor(async () => {
      const x = await deliveryTo(app, cluster.id, m.id, c.id);
      return x?.state === 'failed' ? x : null;
    }, 'failed');
    assert.match(d.error!, /^could not write to the session inbox: /);
  } finally {
    assert.equal(await bridge.stop(), 0, 'exit code 0 once stdin closes');
    await app.close();
  }
});

test('claude bridge: an inbox that hangs up before the message is written is a failed delivery, not ok', async () => {
  const app = await claudeHub();
  const inbox = await fakeInbox({ hangUp: true });
  const bridge = spawnBridge({ ORRERY_HOME: app.home, CLAUDE_CODE_SESSION_ID: app.sid, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  try {
    const { cluster, c } = await mixedCluster(app, app.sid);
    await waitFor(async () => (await statusOf(app, c.id)) === 'idle', 'online');
    // Bigger than any pipe buffer, so the write cannot complete before the inbox hangs up.
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: `@C ${'x'.repeat(900_000)}` });
    const d = await waitFor(async () => {
      const x = await deliveryTo(app, cluster.id, m.id, c.id);
      return x && x.state !== 'queued' && x.state !== 'running' ? x : null;
    }, 'settled');
    assert.equal(d.state, 'failed');
    assert.match(d.error!, /^could not write to the session inbox: /);
  } finally {
    await bridge.stop();
    await inbox.close();
    await app.close();
  }
});

test('claude bridge: a 3xx from the Hub is an error and is never followed', async () => {
  const sid = randomUUID();
  const home = join(tempDir(), 'home');
  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const srv = createHttpServer(handler);
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
  };
  const followed: string[] = [];
  const redirected: string[] = [];
  const target = await listen((req, res) => { followed.push(`${req.method} ${req.url}`); res.writeHead(500).end(); });
  const hub = await listen((req, res) => {
    redirected.push(`${req.method} ${req.url}`);
    res.writeHead(307, { location: `${target.url}${req.url}` }).end();
  });
  writeHubJson(home, hub.url, 'f'.repeat(64));
  const inbox = await fakeInbox();
  const bridge = spawnBridge({ ORRERY_HOME: home, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
  try {
    const r = await bridge.call('list_agents');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /HTTP 307/);
    await waitFor(() => redirected.filter((x) => x.startsWith('GET /bridge/stream')).length >= 2, 'the stream was retried');
    assert.ok(redirected.some((x) => x === 'POST /mcp'));
    assert.deepEqual(followed, [], 'no redirect was followed');
  } finally {
    await bridge.stop();
    await inbox.close();
    for (const x of [hub, target]) {
      x.srv.closeAllConnections();
      await new Promise((ok) => x.srv.close(ok));
    }
  }
});

test('claude bridge: without inbox variables it still relays MCP, says so in initialize, and never goes online', async () => {
  const app = await claudeHub();
  const bridge = spawnBridge({ ORRERY_HOME: app.home, CLAUDE_CODE_SESSION_ID: app.sid });
  try {
    const { cluster, c } = await mixedCluster(app, app.sid);
    const init = (await bridge.initialize()).result;
    assert.match(init.instructions, /没有提供会话收件箱/);
    const sent = await bridge.call('send_message', { body: 'still here' });
    assert.equal(JSON.parse(sent.content[0].text).deliveredTo.length, 0);
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, c.id);
    await new Promise((ok) => setTimeout(ok, 500));   // five retry periods
    assert.equal(await statusOf(app, c.id), 'offline');
    assert.match(bridge.stderr(), /没有提供会话收件箱/);
  } finally {
    await bridge.stop();
    await app.close();
  }
  // And without a session id it cannot speak for anyone.
  const lost = spawnBridge({ ORRERY_HOME: app.home });
  try {
    assert.match((await lost.initialize()).result.instructions, /CLAUDE_CODE_SESSION_ID/);
    const r = await lost.call('list_agents');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /CLAUDE_CODE_SESSION_ID/);
  } finally {
    await lost.stop();
  }
});

// ───────────── the adapter ─────────────

function fakePort(online: boolean, push: BridgePort['push']): BridgePort & { pushed: string[]; online: boolean } {
  const port = {
    online, pushed: [] as string[],
    isOnline: (h: string, id: string) => h === 'claude' && id === 'S' && port.online,
    push: (h: string, id: string, deliveryId: string, text: string) => (port.pushed.push(`${h}/${id}/${deliveryId}/${text}`), push(h, id, deliveryId, text)),    waitDone: async () => 'dropped' as const,
  };
  return port;
}

test('claude native adapter: online from the bridge; deliver → accepted / offline / rejected; sessions from the store; no createSession', async () => {
  const dir = tempDir();
  const sid = randomUUID();
  const project = join(dir, 'project');
  const adapter = createClaudeNativeAdapter({ claudeDir: claudeDir(dir, sid, project) });
  const ctx = (bridge: BridgePort): NativeDeliverContext => ({ deliveryId: 'd1', bridge, onEvent: () => {}, signal: new AbortController().signal });

  assert.equal(adapter.harness, 'claude');
  assert.equal(adapter.createSession, undefined, 'the user creates sessions in the app');
  assert.deepEqual((await adapter.listSessions(project)).map((s) => [s.id, s.title]), [[sid, 'hello from the app']]);
  assert.equal((await adapter.attachSession(sid)).cwd, project);
  await assert.rejects(adapter.attachSession(randomUUID()), /not found/);

  const ok = fakePort(true, async () => ({ ok: true }));
  assert.equal(adapter.isOnline('S', ok), true);
  assert.equal(await adapter.deliver('S', 'hi', ctx(ok)), 'accepted');
  assert.deepEqual(ok.pushed, ['claude/S/d1/hi']);

  const off = fakePort(false, async () => { throw new Error('must not push'); });
  assert.equal(adapter.isOnline('S', off), false);
  assert.equal(await adapter.deliver('S', 'hi', ctx(off)), 'offline');
  assert.deepEqual(off.pushed, []);

  const bad = fakePort(true, async () => ({ ok: false, error: 'inbox gone' }));
  assert.deepEqual(await adapter.deliver('S', 'hi', ctx(bad)), { outcome: 'unknown', error: 'inbox gone' });

  // Once the push is attempted, a dropped bridge does not prove whether it received the message.
  const dropped = fakePort(true, async () => { dropped.online = false; throw new Error('no bridge connected'); });
  assert.deepEqual(await adapter.deliver('S', 'hi', ctx(dropped)), { outcome: 'unknown', error: 'Claude bridge delivery could not be confirmed: no bridge connected' });
  const broken = fakePort(true, async () => { throw new Error('boom'); });
  assert.deepEqual(await adapter.deliver('S', 'hi', ctx(broken)), { outcome: 'unknown', error: 'Claude bridge delivery could not be confirmed: boom' });
});
