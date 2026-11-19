// Native Qoder without Qoder (docs/adapters/qoder.md, "测试"): the read-only store over a database built here, identity
// only from each call's _meta, the shared wait route with Qoder's settings, the real wait.mjs and the plugin's real MCP
// relay as child processes. Nothing here runs Qoder, reads its data or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createQoderNativeAdapter } from '../src/adapters/qoder/native.ts';
import { createQoderStore } from '../src/adapters/qoder/store.ts';
import { nativeFactories } from '../src/adapters/index.ts';
import { QODER_WAIT, type Member } from '../src/core/types.ts';
import { REPO_ROOT } from '../src/main.ts';
import { QODER_WAIT_TOOL, qoderSession } from '../src/mcp/qoder.ts';
import { ARM_LIMIT, ticketFor, ticketSession, waitCommand } from '../src/mcp/wait-core.ts';
import { startTestHub, tempDir, waitFor, openSse, registryEnv, writeRegistry } from './helpers.ts';

const PLUGIN = join(REPO_ROOT, 'plugins', 'qoder-orrery');
const WAIT = join(REPO_ROOT, 'plugins', 'zcode-orrery', 'wait.mjs');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const SIDE = '33333333-3333-4333-8333-333333333333';
const ARCHIVED = '44444444-4444-4444-8444-444444444444';
const DELETED = '55555555-5555-4555-8555-555555555555';
const OUTSIDER = '66666666-6666-4666-8666-666666666666';
const IN_DEAD_WORKSPACE = '77777777-7777-4777-8777-777777777777';

const SCHEMA = `CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, name TEXT, workspace_source TEXT, root_paths_json TEXT, product_mode TEXT, archived INTEGER, deleted_at TEXT);
  CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, session_kind TEXT, owner_session_id TEXT, conversation_mode TEXT, workspace_id TEXT, title TEXT, model TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, deleted_at TEXT);`;

/** A fake <Qoder app data> with main.sqlite. `journal: 'wal'` keeps some rows only in the WAL, the writer kept open. */
function fakeQoder(journal: 'wal' | 'delete' = 'wal') {
  const home = tempDir();
  const alpha = join(home, 'work', 'alpha');
  const beta = join(home, 'work', 'beta');
  const db = new DatabaseSync(join(home, 'main.sqlite'));
  db.exec(`PRAGMA journal_mode = ${journal === 'wal' ? 'WAL' : 'DELETE'}; ${journal === 'wal' ? 'PRAGMA wal_autocheckpoint = 0;' : ''} ${SCHEMA}`);
  const workspace = db.prepare('INSERT INTO workspaces (workspace_id, name, root_paths_json, archived, deleted_at) VALUES (?, ?, ?, ?, ?)');
  workspace.run('w1', 'Alpha project', JSON.stringify([alpha, join(home, 'work', 'extra')]), 0, null);
  workspace.run('w2', null, JSON.stringify([beta]), 0, null);
  workspace.run('w-archived', 'old', JSON.stringify([join(home, 'old')]), 1, null);
  workspace.run('w-deleted', 'gone', JSON.stringify([join(home, 'gone')]), 0, '2026-01-01');
  const session = db.prepare('INSERT INTO chat_sessions (session_id, session_kind, conversation_mode, workspace_id, title, model, created_at, updated_at, archived, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  session.run(S1, 'standard', 'normal', 'w1', ' Fix parser ', 'qoduck', 1_700_000_000_000, 1_700_000_100_000, 0, null);
  session.run(SIDE, 'sideChat', 'normal', 'w1', 'side', null, 1, 1, 0, null);
  session.run(OUTSIDER, 'standard', 'normal', 'w1', 'outsider', null, 1, 1, 0, null);
  session.run(ARCHIVED, 'standard', 'normal', 'w1', 'archived', null, 1, 1, 1, null);
  session.run(DELETED, 'standard', 'normal', 'w1', 'deleted', null, 1, 1, 0, '2026-01-01');
  session.run(IN_DEAD_WORKSPACE, 'standard', 'normal', 'w-deleted', 'dead', null, 1, 1, 0, null);
  session.run('not-a-uuid', 'standard', 'normal', 'w1', 'bad id', null, 1, 1, 0, null);
  session.run('88888888-8888-4888-8888-888888888888', 'standard', 'agent', 'w1', 'not normal', null, 1, 1, 0, null);
  if (journal === 'wal') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  session.run(S2, 'standard', 'normal', 'w2', null, null, 1_700_000_000, 1_700_000_200, 0, null);   // WAL only
  return { home, alpha, beta, db, source: join(home, 'main.sqlite') };
}

const filesOf = (dir: string) => Object.fromEntries(readdirSync(dir).filter((f) => f.startsWith('main.sqlite')).map((f) => [f, readFileSync(join(dir, f)).toString('base64')]));

test('qoder store: conversations from a copy of main.sqlite, WAL included; only standard, normal, live ones; the original stays byte-identical', async () => {
  const q = fakeQoder();
  try {
    const before = filesOf(q.home);
    assert.ok(before['main.sqlite-wal'], 'the fixture has a WAL');
    const store = createQoderStore(q.home);
    const projects = await store.listProjects();
    assert.deepEqual(projects.map((p) => [p.label, p.updatedAt]), [['beta', '2023-11-14T22:16:40.000Z'], ['Alpha project', '2023-11-14T22:15:00.000Z']], 'one row per workspace, named by Qoder when it has a name');
    assert.deepEqual((await store.listSessions(q.beta)).map((s) => [s.id, s.title]), [[S2, S2]], 'the WAL row; without a title, the id');
    const alpha = await store.listSessions(q.alpha);
    assert.deepEqual(alpha.map((s) => [s.id, s.title, s.model, s.cwd]), [[S1, 'Fix parser', 'qoduck', q.alpha], [OUTSIDER, 'outsider', null, q.alpha]], 'sideChat, archived, deleted, a dead workspace, a non-UUID id and non-normal mode are left out');
    assert.equal((await store.get(S1))?.title, 'Fix parser');
    for (const id of [SIDE, ARCHIVED, DELETED, IN_DEAD_WORKSPACE, 'not-a-uuid']) assert.equal(await store.get(id), null, id);
    assert.deepEqual(filesOf(q.home), before, 'the database and WAL are unchanged');
  } finally {
    q.db.close();
  }
});

test('qoder store: the copy is what gets opened: an exclusive lock on the original does not stop the listing, and no sidecar file appears', async () => {
  const q = fakeQoder('delete');
  try {
    const before = filesOf(q.home);
    assert.deepEqual(Object.keys(before), ['main.sqlite'], 'no WAL or journal beside it');
    // Anything opening the original in place would get SQLITE_BUSY and read nothing; only a copy can see these rows.
    q.db.exec('BEGIN EXCLUSIVE');
    assert.deepEqual((await createQoderStore(q.home).listSessions(q.alpha)).map((s) => s.id), [S1, OUTSIDER]);
    q.db.exec('COMMIT');
    assert.deepEqual(filesOf(q.home), before, 'still one unchanged file: no -wal, -shm or -journal created');
  } finally {
    q.db.close();
  }
});

test('qoder store: a missing database reads as empty; a table without the link column reads as nothing', async () => {
  assert.deepEqual(await createQoderStore(tempDir()).listProjects(), []);
  const home = tempDir();
  const db = new DatabaseSync(join(home, 'main.sqlite'));
  db.exec(`CREATE TABLE workspaces (workspace_id TEXT, root_paths_json TEXT); CREATE TABLE chat_sessions (session_id TEXT);
    INSERT INTO workspaces VALUES ('w', '["x"]'); INSERT INTO chat_sessions VALUES ('${S1}');`);
  db.close();
  assert.deepEqual(await createQoderStore(home).listProjects(), [], 'no chat_sessions.workspace_id: no conversation can be placed');
});

test('qoder identity: only _meta["com.qoder/turnContext"].sessionId names a conversation', () => {
  assert.equal(QODER_WAIT.appProcess, 'Qoder.exe');
  assert.equal(qoderSession({ 'com.qoder/turnContext': { sessionId: S1, turnId: 't' } }), S1);
  for (const meta of [undefined, {}, { sessionId: S1 }, { session_id: S1 }, { threadId: S1 }, { 'com.qoder/turnContext': {} },
    { 'com.qoder/turnContext': S1 }, { 'com.qoder/turnContext': { sessionId: 1 } }, { 'com.qoder/turnContext': { sessionId: '' } }, { 'com.qoder/sessionResourceContext': { sessionId: S1 } }]) {
    assert.equal(qoderSession(meta as any), null, JSON.stringify(meta));
  }
  assert.equal(qoderSession({ 'com.qoder/turnContext': ['sessionId'] } as any), null);
});

async function qHub(opts: { running?: () => Promise<boolean | null>; graceMs?: number; registryDir?: string } = {}) {
  const q = fakeQoder();
  const adapter = createQoderNativeAdapter({ qoderData: q.home, rearmGraceMs: opts.graceMs ?? 60_000, pollMs: 10, qoderRunning: opts.running ?? (async () => true) });
  const app = await startTestHub({ nativeAdapters: { qoder: adapter }, limits: { recheckMs: 60_000 }, ...(opts.registryDir ? { registryDir: opts.registryDir } : {}) });
  const secret = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  const { cluster, members: [q1, q2] } = await app.api('POST', '/api/clusters', {
    name: 'qc',
    members: [
      { harness: 'qoder', mode: 'native', sessionId: S1, name: 'Q1' },
      { harness: 'qoder', mode: 'native', sessionId: S2, name: 'Q2' },
      { harness: 'mock', mode: 'native', name: 'A', projectPath: '/work' },
    ],
  });
  const statusOf = async () => ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === q1.id)!.status;
  const say = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
  const deliveries = async () => (await app.messages(cluster.id)).flatMap((m) => m.deliveries.filter((d) => d.memberId === q1.id));
  return Object.assign(app, { q, secret, cluster, q1, q2, statusOf, say, deliveries, done: async () => { await app.close(); q.db.close(); } });
}
type QHub = Awaited<ReturnType<typeof qHub>>;

const meta = (sessionId: string) => ({ 'com.qoder/turnContext': { sessionId, turnId: 'turn-1' } });

async function rpc(app: QHub, method: string, params: unknown, headers: Record<string, string> = { 'x-orrery-harness': 'qoder' }) {
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': app.secret, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()).result;
}
const call = (app: QHub, name: string, args: Record<string, unknown>, callerMeta?: Record<string, unknown>, headers?: Record<string, string>) =>
  rpc(app, 'tools/call', { name, arguments: args, ...(callerMeta ? { _meta: callerMeta } : {}) }, headers);

test('qoder calls: _meta names the member; without it nothing attaches or speaks; the session header is ignored; wait_for_messages only for Qoder callers', async () => {
  const app = await qHub();
  try {
    const names = (r: any) => r.tools.map((t: any) => t.name).sort();
    const others = names(await rpc(app, 'tools/list', {}, {}));
    const tools = await rpc(app, 'tools/list', {});
    assert.deepEqual(names(tools), [...others, 'wait_for_messages'].sort());
    assert.ok(!names(await rpc(app, 'tools/list', {}, {})).includes('wait_for_messages'), 'a Codex caller does not get it');
    assert.equal(tools.tools.find((t: any) => t.name === 'wait_for_messages').description, QODER_WAIT_TOOL);

    const listed = await call(app, 'list_agents', {}, meta(S1));
    assert.deepEqual(JSON.parse(listed.content[0].text).map((m: any) => m.name), ['Q1', 'Q2', 'A']);

    const before = (await app.messages(app.cluster.id)).length;
    for (const noIdentity of [undefined, {}, { sessionId: S1 }, { session_id: S1 }, { 'com.qoder/turnContext': {} }, meta(OUTSIDER), meta(SIDE)]) {
      const none = await call(app, 'list_agents', {}, noIdentity);
      assert.equal(none.content[0].text, '[]', `no members for ${JSON.stringify(noIdentity)}`);
      const sent = await call(app, 'send_message', { body: 'should not land' }, noIdentity);
      assert.equal(sent.isError, true, JSON.stringify(noIdentity));
      const wait = await call(app, 'wait_for_messages', {}, noIdentity);
      assert.equal(wait.isError, true);
      assert.match(wait.content[0].text, /不是任何 orrery 集群的成员/);
    }
    assert.equal((await app.messages(app.cluster.id)).length, before, 'nothing was written');

    const header = await call(app, 'list_agents', {}, undefined, { 'x-orrery-harness': 'qoder', 'x-orrery-session': S1 });
    assert.equal(header.content[0].text, '[]', 'x-orrery-session names nobody for a Qoder caller');

    const ok = await call(app, 'send_message', { body: 'from Q1' }, meta(S1));
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.equal((await app.messages(app.cluster.id)).at(-1)!.from, app.q1.id, 'attributed from _meta');
  } finally {
    await app.done();
  }
});

test('qoder tool text: the stop rule is in the tool description, the reply gives the command with Qoder\'s harness arguments', async () => {
  const app = await qHub();
  try {
    assert.match(QODER_WAIT_TOOL, /killed or stopped/);
    assert.match(QODER_WAIT_TOOL, /do not run it again/);
    assert.match(QODER_WAIT_TOOL, /output file/);
    const reply = JSON.parse((await call(app, 'wait_for_messages', {}, meta(S1))).content[0].text);
    const ticket = ticketFor(QODER_WAIT, app.secret, S1, app.registry.hubId);
    assert.equal(reply.command, waitCommand(QODER_WAIT, ticket, app.url));
    assert.ok(reply.command.endsWith(`${app.url} qoder Qoder.exe`), reply.command);
    assert.deepEqual([reply.run_in_background, reply.running], [true, 0]);
    assert.equal(ticketSession(QODER_WAIT, app.secret, ticket, app.registry.hubId), S1);
    assert.match(ticket, /^q2\./);
  } finally {
    await app.done();
  }
});

/** A fake wait.mjs on Qoder's route. */
function openWait(url: string, ticket: string) {
  return openSse(`${url}/bridge/qoder-wait`, { 'x-orrery-ticket': ticket });
}
const ack = (url: string, ticket: string, deliveryId: string) => fetch(`${url}/bridge/qoder-ack`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, deliveryId }),
}).then((r) => r.json());

test('qoder wait route (shared core): a delivery is the envelope only, then busy until re-armed; duplicates held; arms limited', async () => {
  const app = await qHub();
  try {
    const ticket = ticketFor(QODER_WAIT, app.secret, S1, app.registry.hubId);
    const first = openWait(app.url, ticket);
    assert.equal(await first.status, 200);
    await waitFor(async () => (await app.statusOf()) === 'idle', 'online once a wait is connected');
    const held = openWait(app.url, ticket);
    await held.status;
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'qoder_extra_wait' && e.memberId === app.q1.id), 'duplicate notice');
    const m = await app.say('@Q1 hello');
    await waitFor(() => first.events.length, 'the delivery');
    assert.equal(held.events.length, 0, 'never to the held wait');
    const [{ event, data }] = first.events;
    assert.equal(event, 'deliver');
    assert.ok(data.text.includes(`messageId=${m.id}`) && data.text.includes('@Q1 hello'));
    for (const instruction of ['再运行', '重新运行', 'run_in_background', 'wait.mjs', ticket]) assert.ok(!data.text.includes(instruction), `no "${instruction}" in the envelope`);
    assert.deepEqual(await ack(app.url, ticket, data.deliveryId), { acked: true });
    await first.ended;
    await waitFor(async () => (await app.deliveries())[0]?.state === 'done', 'the held wait took over as the re-arm');
    held.close();

    const waits: ReturnType<typeof openWait>[] = [];
    for (let i = 0; i < ARM_LIMIT; i++) {
      const w = openWait(app.url, ticketFor(QODER_WAIT, app.secret, S2, app.registry.hubId));
      await w.status;
      waits.push(w);
    }
    const over = openWait(app.url, ticketFor(QODER_WAIT, app.secret, S2, app.registry.hubId));
    await over.status;
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'qoder_arm_rate' && e.memberId === app.q2.id), 'rate notice');
    for (const w of [...waits, over]) w.close();
  } finally {
    await app.done();
  }
});

test('qoder offline (shared core): a wait left behind by a Qoder that is gone is offline and gets nothing', async () => {
  const app = await qHub({ running: async () => false });
  try {
    const wait = openWait(app.url, ticketFor(QODER_WAIT, app.secret, S1, app.registry.hubId));
    assert.equal(await wait.status, 200);
    await app.say('@Q1 to an orphan');
    await waitFor(async () => (await app.deliveries())[0]?.state === 'offline', 'the delivery ends offline');
    assert.equal(wait.events.length, 0);
    assert.equal(await app.statusOf(), 'offline');
    wait.close();
  } finally {
    await app.done();
  }
});

test('qoder wait command: the real wait.mjs prints nothing while waiting, then only the envelope, and exits', async () => {
  const app = await qHub();
  const ticket = ticketFor(QODER_WAIT, app.secret, S1, app.registry.hubId);
  const child = spawn(process.execPath, [WAIT, ticket, app.url, 'qoder', 'Qoder.exe'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
  child.stderr.resume();
  const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
  try {
    await waitFor(async () => (await app.statusOf()) === 'idle', 'wait.mjs connected', 10_000);
    assert.equal(out, '', 'silent while waiting');
    const m = await app.say('@Q1 via the real command');
    assert.equal(await exited, 0);
    assert.ok(out.includes(`messageId=${m.id}`) && out.includes('@Q1 via the real command'));
    for (const instruction of ['再运行', '重新运行', '不要重新']) assert.ok(!out.includes(instruction), `no "${instruction}" in the output`);
    await waitFor(async () => (await app.statusOf()) === 'busy', 'in the re-arm grace');
  } finally {
    child.kill();
    await app.done();
  }
});

/** The plugin's real MCP relay as a child process, speaking newline-delimited JSON-RPC; `registry` is its ORRERY_REGISTRY. */
function startRelay(registry: string) {
  const child = spawn(process.execPath, [join(PLUGIN, 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ORRERY_REGISTRY: registry } });
  child.stderr.resume();
  const lines: any[] = [];
  createInterface({ input: child.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
  const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const ask = async (id: number, method: string, params?: unknown) => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return (await waitFor(() => lines.find((l) => l.id === id), `answer ${id}`, 8000));
  };
  return { child, lines, send, ask };
}

test('qoder plugin relay: initialize is local, calls reach the Hub unchanged, _meta decides the member, a missing _meta attaches nothing', async () => {
  const app = await qHub();
  const relay = startRelay(registryEnv(app).ORRERY_REGISTRY);
  try {
    const init = await relay.ask(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'qoder-desktop-mcp-host', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'orrery');
    relay.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = (await relay.ask(2, 'tools/list')).result.tools;
    assert.ok(tools.some((t: any) => t.name === 'wait_for_messages'), 'the Hub\'s Qoder tools');

    const listed = await relay.ask(3, 'tools/call', { name: 'list_agents', arguments: {}, _meta: meta(S1) });
    assert.deepEqual(JSON.parse(listed.result.content[0].text).map((m: any) => m.name), ['Q1', 'Q2', 'A']);

    const none = await relay.ask(4, 'tools/call', { name: 'list_agents', arguments: {} });
    assert.equal(none.result.content[0].text, '[]', 'no _meta: nobody, the relay adds no identity of its own');
    const wait = await relay.ask(5, 'tools/call', { name: 'wait_for_messages', arguments: {} });
    assert.equal(wait.result.isError, true);
    const issued = await relay.ask(6, 'tools/call', { name: 'wait_for_messages', arguments: {}, _meta: meta(S2) });
    assert.match(JSON.parse(issued.result.content[0].text).command, /q2\.[0-9a-f-]{36}\.22222222/);
    assert.equal((await relay.ask(7, 'ping')).result && true, true);
  } finally {
    relay.child.kill();
    await app.done();
  }
});

test('qoder plugin relay: with no Hub yet, tools/list is empty and calls fail softly; list_changed arrives once the Hub is up', async () => {
  const registry = join(tempDir(), 'registry');
  const relay = startRelay(registry);
  let app: Awaited<ReturnType<typeof qHub>> | undefined;
  try {
    assert.deepEqual((await relay.ask(1, 'tools/list')).result.tools, []);
    const call1 = await relay.ask(2, 'tools/call', { name: 'list_agents', arguments: {}, _meta: meta(S1) });
    assert.equal(call1.result.isError, true);
    assert.match(call1.result.content[0].text, /^接入件没有发送请求：未找到活动 Hub/);
    app = await qHub({ registryDir: registry });   // the Hub registers in the relay's registry: no relay restart
    await waitFor(() => relay.lines.some((l) => l.method === 'notifications/tools/list_changed'), 'list_changed', 10_000);
    assert.ok((await relay.ask(3, 'tools/list')).result.tools.length > 0);
  } finally {
    relay.child.kill();
    await app?.done();
  }
});

test('qoder plugin relay: requests are signed over the body (the _meta that names the member), never carrying the key', async () => {
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  const { createServer } = await import('node:http');
  const hub = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { content: [] } }));
  });
  await new Promise<void>((ok) => hub.listen(0, '127.0.0.1', ok));
  const registry = join(tempDir(), 'registry');
  const reg = writeRegistry(registry, `http://127.0.0.1:${(hub.address() as import('node:net').AddressInfo).port}`);
  const relay = startRelay(registry);
  try {
    await relay.ask(1, 'tools/call', { name: 'list_agents', arguments: {}, _meta: meta(S1) });
    const [got] = seen;
    assert.equal(got.headers['x-orrery-bridge'], undefined);
    const [, hubId, claim, ts, nonce, mac] = String(got.headers['x-orrery-sig']).split(' ');
    assert.deepEqual([hubId, claim], [reg.hubId, reg.claim]);
    const { bridgeMac } = await import('../src/bridge-protocol.ts');
    assert.equal(mac, bridgeMac(reg.key, reg, 'POST', '/mcp', new Map([['x-orrery-harness', 'qoder']]), ts, nonce, Buffer.from(got.body)));
    assert.equal(JSON.parse(got.body).params._meta['com.qoder/turnContext'].sessionId, S1, 'the body is relayed unchanged');
    assert.ok(!JSON.stringify(seen).includes(reg.key));
  } finally {
    relay.child.kill();
    hub.closeAllConnections();
    await new Promise<void>((ok) => hub.close(() => ok()));
  }
});

test('qoder plugin relay: an answer cut off after the Hub got the call is reported as unknown, never as not delivered', async () => {
  const { createServer } = await import('node:http');
  let got = 0;
  // Reads the whole request (the Hub may have run it), then drops the connection without answering.
  const hub = createServer(async (req) => {
    for await (const _ of req) { /* the whole body arrives */ }
    got++;
    req.socket.destroy();
  });
  await new Promise<void>((ok) => hub.listen(0, '127.0.0.1', ok));
  const registry = join(tempDir(), 'registry');
  writeRegistry(registry, `http://127.0.0.1:${(hub.address() as import('node:net').AddressInfo).port}`);
  const relay = startRelay(registry);
  try {
    const r = await relay.ask(1, 'tools/call', { name: 'send_message', arguments: { body: 'x' }, _meta: meta(S1) });
    assert.equal(got, 1);
    assert.equal(r.result.isError, true);
    const text: string = r.result.content[0].text;
    assert.match(text, /结果未知/);
    assert.match(text, /read_messages/);
    assert.doesNotMatch(text, /没有送达|没有发出|没有执行/);
  } finally {
    relay.child.kill();
    hub.closeAllConnections();
    await new Promise<void>((ok) => hub.close(() => ok()));
  }
});

test('qoder plugin: self-contained, no fetch, identity only in _meta, stops rule in the skill, manifest and MCP entry in place', () => {
  const relaySource = readFileSync(join(PLUGIN, 'mcp.mjs'), 'utf8');
  // Node modules and its own copy of the shared discovery module (test/hub-discovery-client.test.ts checks the copy).
  for (const m of relaySource.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.ok(m[1].startsWith('node:') || m[1] === './hub-discovery.mjs', `only node: modules, not ${m[1]}`);
  assert.ok(!/\bfetch\s*\(/.test(relaySource));
  assert.ok(!relaySource.includes('x-orrery-session'), 'the relay never names a conversation');
  assert.equal(JSON.parse(readFileSync(join(PLUGIN, '.qoder-plugin', 'plugin.json'), 'utf8')).name, 'orrery');
  const entry = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.orrery;
  assert.deepEqual([entry.command, entry.args], ['node', ['${QODER_PLUGIN_ROOT}/mcp.mjs']]);
  assert.ok(existsSync(join(PLUGIN, 'skills', 'orrery', 'SKILL.md')));
  const skill = readFileSync(join(PLUGIN, 'skills', 'orrery', 'SKILL.md'), 'utf8');
  assert.match(skill, /不要重新运行/);
  assert.match(skill, /输出文件/);
});

test('qoder: registered as a native harness', () => {
  assert.equal(typeof nativeFactories.qoder, 'function');
});
