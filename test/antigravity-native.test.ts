// Native Antigravity without Antigravity (docs/adapters/antigravity.md, "测试"): the conversation store over a summaries
// database built here, the adapter against a fake BridgePort, the Hub's hook-signed caller identity, the real hook
// script, and the real sidecar (plugins/antigravity-orrery) loaded into this process against a real test Hub, running a
// fake agentapi (a node script). Nothing here runs agy, agentapi, language_server.exe or Antigravity.exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createAntigravityNativeAdapter } from '../src/adapters/antigravity/native.ts';
import { goTime, workspacePaths } from '../src/adapters/antigravity/store.ts';
import { callerTag, signedConversation } from '../src/mcp/antigravity.ts';
import { REPO_ROOT } from '../src/main.ts';
import type { BridgePort, Member, NativeDeliverContext } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'antigravity-orrery');
const HOOK = join(PLUGIN_DIR, 'hook.mjs');
const sidecar = await import(pathToFileURL(join(PLUGIN_DIR, 'sidecar.mjs')).href);
const hook = await import(pathToFileURL(HOOK).href);
const hookDump = await import(pathToFileURL(join(PLUGIN_DIR, 'hook-dump.mjs')).href);
const FAKE_AGENTAPI = join(REPO_ROOT, 'test', 'fixtures', 'antigravity', 'fake-agentapi.mjs');

const C1 = '11111111-aaaa-4aaa-8aaa-111111111111';   // projects alpha and beta, titled, newest input in the WAL
const C2 = '22222222-aaaa-4aaa-8aaa-222222222222';   // alpha, no title (preview), zero times (file time)
const SUB = '33333333-aaaa-4aaa-8aaa-333333333333';  // alpha, a subagent
const KILLED = '44444444-aaaa-4aaa-8aaa-444444444444';
const CLI = '55555555-aaaa-4aaa-8aaa-555555555555';   // another app data dir
const NO_WS = '66666666-aaaa-4aaa-8aaa-666666666666'; // no workspace
const C3 = '77777777-aaaa-4aaa-8aaa-777777777777';   // gamma, not a cluster member
const CSRF = 'csrf-value-that-must-never-leave';
const RETRY_MS = 100;

// ───────────── a summaries database like Antigravity's ─────────────

/** <gemini>/antigravity/conversation_summaries.db in WAL mode, with the newest change still in the WAL (writer kept open). */
function fakeGemini() {
  const gemini = tempDir();
  const data = join(gemini, 'antigravity');
  mkdirSync(join(data, 'conversations'), { recursive: true });
  const alpha = join(gemini, 'work', 'alpha');
  const beta = join(gemini, 'work', 'beta');
  const gamma = join(gemini, 'work', 'gamma');
  const uris = (...ps: string[]) => JSON.stringify(ps.map((p) => pathToFileURL(p).href));
  const db = new DatabaseSync(join(data, 'conversation_summaries.db'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
      last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, nesting_depth integer NOT NULL DEFAULT 0,
      killed numeric NOT NULL DEFAULT false, last_user_input_time datetime NOT NULL, app_data_dir text NOT NULL DEFAULT "",
      PRIMARY KEY (conversation_id))`);
  const add = db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris,
    nesting_depth, killed, last_user_input_time, app_data_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const zero = '0001-01-01 00:00:00+00:00';
  add.run(C1, ' Fix the parser ', 'p', '2026-01-02 03:04:05.1234567+00:00', uris(alpha, beta), 0, 0, '2026-01-02 03:00:00.5+00:00', 'antigravity');
  add.run(C2, '', 'Second chat\nmore lines', zero, uris(alpha), 0, 0, zero, 'antigravity');
  add.run(SUB, 'sub', '', '2026-01-03 00:00:00+00:00', uris(alpha), 1, 0, '2026-01-03 00:00:00+00:00', 'antigravity');
  add.run(KILLED, 'killed', '', '2026-01-03 00:00:00+00:00', uris(alpha), 0, 1, '2026-01-03 00:00:00+00:00', 'antigravity');
  add.run(CLI, 'cli', '', '2026-01-03 00:00:00+00:00', uris(alpha), 0, 0, '2026-01-03 00:00:00+00:00', 'antigravity-cli');
  add.run(NO_WS, 'no workspace', '', '2026-01-03 00:00:00+00:00', '', 0, 0, '2026-01-03 00:00:00+00:00', 'antigravity');
  add.run(C3, 'Gamma', '', '2025-12-01 00:00:00+00:00', uris(gamma), 0, 0, '2025-12-01 00:00:00+00:00', 'antigravity');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // The newest user input happened after the last checkpoint: it is only in the WAL.
  db.prepare('UPDATE conversation_summaries SET last_user_input_time = ? WHERE conversation_id = ?').run('2026-01-05 10:00:00.0000001+00:00', C1);
  writeFileSync(join(data, 'conversations', `${C2}.db`), '');
  utimesSync(join(data, 'conversations', `${C2}.db`), new Date('2026-01-04T00:00:00Z'), new Date('2026-01-04T00:00:00Z'));
  return { gemini, data, alpha, beta, gamma, writer: db };
}

test('antigravity store: projects and conversations from a copy of the summaries db (WAL included); filters; times; titles; originals untouched', async () => {
  const g = fakeGemini();
  try {
    const files = () => Object.fromEntries(readdirSync(g.data).filter((f) => f.startsWith('conversation_summaries'))
      .map((f) => [f, readFileSync(join(g.data, f)).toString('base64')]));
    const before = files();
    assert.ok(before['conversation_summaries.db-wal'], 'the fixture has a WAL');
    const adapter = createAntigravityNativeAdapter({ geminiHome: g.gemini });
    assert.deepEqual(await adapter.listProjects(), [
      { path: g.alpha, label: 'alpha', updatedAt: '2026-01-05T10:00:00.000Z' },
      { path: g.beta, label: 'beta', updatedAt: '2026-01-05T10:00:00.000Z' },
      { path: g.gamma, label: 'gamma', updatedAt: '2025-12-01T00:00:00.000Z' },
    ]);
    assert.deepEqual(await adapter.listSessions(g.alpha), [
      { id: C1, title: 'Fix the parser', model: null, cwd: g.alpha, updatedAt: '2026-01-05T10:00:00.000Z' },
      { id: C2, title: 'Second chat', model: null, cwd: g.alpha, updatedAt: '2026-01-04T00:00:00.000Z' },
    ], 'subagent, killed, other data dir and workspace-less conversations left out');
    assert.deepEqual((await adapter.listSessions(g.beta)).map((s) => [s.id, s.cwd]), [[C1, g.beta]]);
    assert.equal((await adapter.listSessions(g.alpha.toUpperCase())).length, process.platform === 'win32' ? 2 : 0, 'paths compare like the OS does');
    assert.equal((await adapter.attachSession(C3)).title, 'Gamma');
    for (const id of [SUB, KILLED, CLI, NO_WS, 'no-such', '../x', '']) await assert.rejects(adapter.attachSession(id), /not found/, id);
    assert.equal(adapter.createSession, undefined, 'conversations are created in the app');
    assert.deepEqual(files(), before, 'database, WAL and shared memory unchanged');
    assert.deepEqual(await createAntigravityNativeAdapter({ geminiHome: tempDir() }).listProjects(), [], 'no database: nothing listed');
  } finally {
    g.writer.close();
  }
});

test('antigravity store: Go times and workspace URIs', () => {
  assert.equal(goTime('2026-10-31 16:33:41.1604886+00:00'), '2026-10-31T16:33:41.160Z');
  assert.equal(goTime('0001-01-01 00:00:00+00:00'), null);
  for (const v of ['', 'soon', null, 5]) assert.equal(goTime(v), null);
  assert.deepEqual(workspacePaths(''), []);
  assert.deepEqual(workspacePaths('not json'), []);
  assert.deepEqual(workspacePaths('{"a":1}'), []);
  assert.deepEqual(workspacePaths('["https://example.com/x", 3]'), []);
  if (process.platform === 'win32') assert.deepEqual(workspacePaths('["file:///c%3A/Users/x%20y/proj"]'), ['c:\\Users\\x y\\proj']);
});

test('antigravity store: unreadable summaries and an unexpected schema still report their errors', async () => {
  for (const corrupt of [true, false]) {
    const gemini = tempDir();
    const data = join(gemini, 'antigravity');
    mkdirSync(data);
    const file = join(data, 'conversation_summaries.db');
    if (corrupt) writeFileSync(file, 'not a SQLite database');
    else new DatabaseSync(file).close();
    const before = readFileSync(file);
    const adapter = createAntigravityNativeAdapter({ geminiHome: gemini });
    await assert.rejects(adapter.listProjects(), corrupt ? /file is not a database/ : /no such table/);
    assert.deepEqual(readFileSync(file), before, 'failed reads leave the original untouched');
    assert.deepEqual(readdirSync(data), ['conversation_summaries.db'], 'the original gets no sidecar files');
  }
});

function fakePort(online: boolean, push: BridgePort['push']): BridgePort & { pushed: string[]; online: boolean } {
  const port = {
    online, pushed: [] as string[],
    isOnline: (h: string, id: string) => h === 'antigravity' && id === C1 && port.online,
    push: (h: string, id: string, deliveryId: string, text: string) => (port.pushed.push(`${h}/${id}/${deliveryId}/${text}`), push(h, id, deliveryId, text)),    waitDone: async () => 'dropped' as const,
  };
  return port;
}

test('antigravity native adapter: online from the bridge; deliver → accepted / offline / rejected', async () => {
  const adapter = createAntigravityNativeAdapter({ geminiHome: tempDir() });
  const ctx = (bridge: BridgePort): NativeDeliverContext => ({ deliveryId: 'd1', bridge, onEvent: () => {}, signal: new AbortController().signal });
  const ok = fakePort(true, async () => ({ ok: true }));
  assert.equal(adapter.isOnline(C1, ok), true);
  assert.equal(adapter.isOnline(C2, ok), false);
  assert.equal(await adapter.deliver(C1, 'hi', ctx(ok)), 'accepted');
  assert.deepEqual(ok.pushed, [`antigravity/${C1}/d1/hi`]);
  assert.equal(await adapter.deliver(C1, 'hi', ctx(fakePort(false, async () => ({ ok: true })))), 'offline');
  assert.deepEqual(await adapter.deliver(C1, 'hi', ctx(fakePort(true, async () => ({ ok: false, error: 'agentapi said no' })))), { outcome: 'unknown', error: 'agentapi said no' });
  const gone = fakePort(true, async () => { gone.online = false; throw new Error('no bridge'); });
  assert.deepEqual(await adapter.deliver(C1, 'hi', ctx(gone)), { outcome: 'unknown', error: 'Antigravity bridge delivery could not be confirmed: no bridge' });
});

// ───────────── Hub: identity from the hook-signed argument ─────────────

async function agHub(g = fakeGemini(), dir = tempDir()) {
  const app = await startTestHub({ dir, nativeAdapters: { antigravity: createAntigravityNativeAdapter({ geminiHome: g.gemini }) }, limits: { recheckMs: 60_000 } });
  return Object.assign(app, { g, secret: JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string });
}
type AgHub = Awaited<ReturnType<typeof agHub>>;

async function agCluster(app: AgHub) {
  const { cluster, members: [g1, g2, a] } = await app.api('POST', '/api/clusters', {
    name: 'ag',
    members: [
      { harness: 'antigravity', mode: 'native', sessionId: C1, name: 'G1' },
      { harness: 'antigravity', mode: 'native', sessionId: C2, name: 'G2' },
      { projectPath: tempDir(), harness: 'mock', name: 'A' },
    ],
  });
  return { cluster, g1, g2, a };
}

async function done(app: AgHub) {
  app.g.writer.close();
  await app.close();
}

/** One JSON-RPC request to the Hub's /mcp with the bridge secret and these extra headers. */
async function rpc(app: AgHub, method: string, params: unknown, headers: Record<string, string> = { 'x-orrery-harness': 'antigravity' }) {
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': app.secret, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()).result;
}
const call = (app: AgHub, name: string, args: Record<string, unknown>, headers?: Record<string, string>) => rpc(app, 'tools/call', { name, arguments: args }, headers);
const signed = (secret: string, id: string) => `${id}.${callerTag(secret, id)}`;
const statusOf = async (app: TestHub, id: string) =>
  ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status;
const deliveryTo = async (app: TestHub, clusterId: string, messageId: string, memberId: string) =>
  (await app.messages(clusterId)).find((m) => m.id === messageId)?.deliveries.find((d) => d.memberId === memberId);

test('antigravity identity: tools take orreryCaller only for antigravity callers; only a valid tag names the member', async () => {
  const app = await agHub();
  try {
    const { cluster, g1 } = await agCluster(app);
    const props = (tools: any[]) => Object.fromEntries(tools.map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {}).sort()]));
    const ag = props((await rpc(app, 'tools/list', {})).tools);
    const ordinary = props((await rpc(app, 'tools/list', {}, {})).tools);
    assert.ok(ag.create_task && ag.bookmark_message, 'collaboration tools are exposed');
    assert.deepEqual(Object.keys(ag), Object.keys(ordinary));
    for (const name of Object.keys(ag)) {
      assert.ok(ag[name].includes('orreryCaller'), name);
      assert.deepEqual(ag[name].filter((key: string) => key !== 'orreryCaller'), ordinary[name], name);
      assert.deepEqual(hook.answer({ conversationId: C1, toolCall: { name: `mcp_orrery_${name}`, args: {} } }, app.secret),
        { decision: 'ask', overwrite: { orreryCaller: signed(app.secret, C1) } }, `${name} is signed`);
    }

    const sent = await call(app, 'send_message', { body: 'hello from G1', orreryCaller: signed(app.secret, C1) });
    assert.equal(sent.isError, undefined, JSON.stringify(sent));
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, g1.id);
    assert.deepEqual(JSON.parse((await call(app, 'list_agents', { orreryCaller: signed(app.secret, C1) })).content[0].text).map((m: any) => m.name), ['G1', 'G2', 'A']);
    assert.ok(Array.isArray(JSON.parse((await call(app, 'read_messages', { orreryCaller: signed(app.secret, C2), history: true })).content[0].text)));

    const count = (await app.messages(cluster.id)).length;
    const refused = [
      undefined, '', C1, `${C1}.`, `${C1}.${'0'.repeat(64)}`, signed('another secret', C1),
      `${C1}.${callerTag(app.secret, C2)}`, signed(app.secret, 'not-a-uuid'),
    ];
    for (const orreryCaller of refused) {
      for (const tool of ['send_message', 'list_agents']) {
        const r = await call(app, tool, { body: 'spoof', ...(orreryCaller === undefined ? {} : { orreryCaller }) });
        assert.equal(r.isError, true, `${tool} ${orreryCaller}`);
        assert.match(r.content[0].text, /没有 orrery hook 的签名/);
      }
    }
    assert.deepEqual(JSON.parse((await call(app, 'list_agents', { orreryCaller: signed(app.secret, C3) })).content[0].text), [], 'signed but no member');
    assert.match((await call(app, 'send_message', { body: 'x', orreryCaller: signed(app.secret, C3) })).content[0].text, /不是任何 orrery 集群的成员/);

    // Other callers never get their identity from the arguments.
    assert.match((await call(app, 'send_message', { body: 'x', orreryCaller: signed(app.secret, C1) }, {})).content[0].text, /不是任何 orrery 集群的成员/, 'Codex caller: no _meta.threadId');
    assert.match((await call(app, 'send_message', { body: 'x', orreryCaller: signed(app.secret, C1) }, { 'x-orrery-session': C3, 'x-orrery-harness': 'deepseek' })).content[0].text, /不是任何 orrery 集群的成员/);
    assert.match((await call(app, 'send_message', { body: 'x', orreryCaller: signed(app.secret, C1) }, { 'x-orrery-session': C1 })).content[0].text, /不是任何 orrery 集群的成员/, 'a Claude session header with an Antigravity id is no member');
    assert.equal((await app.messages(cluster.id)).length, count, 'nothing written by refused calls');
  } finally {
    await done(app);
  }
});

test('antigravity identity: signed conversation chooses only its own cluster membership', async () => {
  const app = await agHub();
  try {
    const { cluster } = await agCluster(app);
    const { cluster: other, members: [g1] } = await app.hub.createCluster('other', [
      { harness: 'antigravity', mode: 'native', sessionId: C1, name: 'G1-other' },
    ]);
    const signedG1 = signed(app.secret, C1);
    const ambiguous = await call(app, 'list_agents', { orreryCaller: signedG1 });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, new RegExp(cluster.id));
    assert.match(ambiguous.content[0].text, new RegExp(other.id));
    const sent = await call(app, 'send_message', { body: 'other group', clusterId: other.id, orreryCaller: signedG1 });
    assert.equal(sent.isError, undefined);
    assert.equal((await app.messages(other.id)).at(-1)!.from, g1.id);
    const spoof = await call(app, 'send_message', { body: 'not a member', clusterId: other.id, orreryCaller: signed(app.secret, C2) });
    assert.equal(spoof.isError, true, 'a valid signature for a different conversation grants no membership');
    assert.equal((await app.messages(other.id)).length, 1);
  } finally { await done(app); }
});

test('antigravity identity: Hub tag and verification agree with the hook', () => {
  assert.equal(hook.callerValue(C1, 's3cret'), `${C1}.${callerTag('s3cret', C1)}`);
  assert.equal(signedConversation('s3cret', hook.callerValue(C1, 's3cret')), C1);
  assert.equal(signedConversation('other', hook.callerValue(C1, 's3cret')), null);
  assert.equal(hook.callerValue(C1, null), '');
  assert.equal(hook.callerValue(undefined, 's3cret'), '');
});

// ───────────── hook ─────────────

test('antigravity hook: overwrites orreryCaller on orrery calls (flat or nested arguments), whatever the model wrote; leaves other tools; never allows', () => {
  const v = hook.callerValue(C1, 'k');
  const forged = { orreryCaller: `${C2}.forged` };
  const ask = { decision: 'ask' };
  const p = (toolCall: unknown, conversationId: unknown = C1) => ({ conversationId, toolCall, workspacePaths: [] });
  for (const name of ['mcp_orrery_send_message', 'mcp__orrery__list_agents', 'orrery/read_messages', 'mcp__orrery__ack_messages', 'MCP_ORRERY_SEND_MESSAGE']) {
    assert.deepEqual(hook.answer(p({ name, args: { body: 'x', ...forged } }), 'k'), { ...ask, overwrite: { orreryCaller: v } }, name);
  }
  assert.deepEqual(hook.answer(p({ name: 'mcp_tool', args: { ServerName: 'orrery', ToolName: 'send_message', Arguments: { body: 'x', ...forged } } }), 'k'),
    { ...ask, overwrite: { Arguments: { body: 'x', orreryCaller: v } } });
  assert.deepEqual(hook.answer(p({ name: 'mcp_tool', args: { serverName: 'Orrery', arguments: JSON.stringify({ body: 'x', ...forged }) } }), 'k'),
    { ...ask, overwrite: { arguments: JSON.stringify({ body: 'x', orreryCaller: v }) } });
  assert.deepEqual(hook.answer(p({ name: 'mcp_tool', args: { serverName: 'orrery', arguments: { clusterId: 'group', body: 'x' } } }), 'k'),
    { ...ask, overwrite: { arguments: { clusterId: 'group', body: 'x', orreryCaller: v } } }, 'selection survives signing');
  assert.deepEqual(hook.answer(p({ name: 'mcp_tool', args: { serverName: 'orrery' } }), 'k'), { ...ask, overwrite: { orreryCaller: v } });
  for (const toolCall of [
    { name: 'run_command', args: { CommandLine: 'npm test', orreryCaller: 'x' } },
    { name: 'mcp_tool', args: { serverName: 'github', arguments: { q: 1 } } },
    { name: 'mcp_other_send_message', args: {} },
    { name: 'mcp_orreryx_send_message', args: {} },
    { name: 'send_message', args: {} },
    'garbage', null,
  ]) assert.deepEqual(hook.answer(p(toolCall), 'k'), ask, JSON.stringify(toolCall));
  assert.deepEqual(hook.answer(null, 'k'), ask);
  // Cannot sign: still overwrites, with '' (the Hub then refuses), so a model-written value never gets through.
  assert.deepEqual(hook.answer(p({ name: 'mcp_orrery_send_message', args: forged }), null), { ...ask, overwrite: { orreryCaller: '' } });
  assert.deepEqual(hook.answer(p({ name: 'mcp_orrery_send_message', args: forged }, null), 'k'), { ...ask, overwrite: { orreryCaller: '' } });
});

test('antigravity hook + Hub: the real hook process signs a call that the Hub then attributes to that conversation', async () => {
  const app = await agHub();
  try {
    const { cluster, g2 } = await agCluster(app);
    const runHook = (payload: string, home: string) =>
      JSON.parse(execFileSync(process.execPath, [HOOK], { input: payload, env: { ...process.env, ORRERY_HOME: home }, encoding: 'utf8' }));
    const args = { body: 'hello from G2', orreryCaller: signed(app.secret, C1) };   // the model claims to be G1
    const out = runHook(JSON.stringify({ conversationId: C2, toolCall: { name: 'mcp_orrery_send_message', args }, stepIdx: 3 }), app.home);
    assert.equal(out.decision, 'ask');
    const r = await call(app, 'send_message', { ...args, ...out.overwrite });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, g2.id, 'the conversation the hook named, not the one the model wrote');
    const msg = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'ack me' });
    const ackArgs = { messageIds: [msg.id], orreryCaller: signed(app.secret, C1) };
    const ackHook = runHook(JSON.stringify({ conversationId: C2, toolCall: { name: 'mcp_orrery_ack_messages', args: ackArgs } }), app.home);
    const ack = await call(app, 'ack_messages', { ...ackArgs, ...ackHook.overwrite });
    assert.deepEqual(JSON.parse(ack.content[0].text), { acknowledged: [msg.id] });
    assert.deepEqual(app.store.acknowledgementsOf(msg.id).map((a) => a.memberId), [g2.id]);
    const taskArgs = { operationId: 'ag-create', title: 'Task', scope: 'Scope', acceptance: 'Done', orreryCaller: signed(app.secret, C1) };
    const taskHook = runHook(JSON.stringify({ conversationId: C2, toolCall: { name: 'mcp_orrery_create_task', args: taskArgs } }), app.home);
    const task = await call(app, 'create_task', { ...taskArgs, ...taskHook.overwrite });
    assert.equal(JSON.parse(task.content[0].text).task.createdBy, g2.id);
    assert.deepEqual(runHook('not json', app.home), { decision: 'ask' });
    assert.deepEqual(runHook(JSON.stringify({ conversationId: C2, toolCall: { name: 'mcp_orrery_list_agents', args: {} } }), tempDir()),
      { decision: 'ask', overwrite: { orreryCaller: '' } }, 'no hub.json');
  } finally {
    await done(app);
  }
});

test('antigravity hook-dump: records the tool name and the shape of the call, never its content', () => {
  const secretBits = ['top secret body', 'my last input', C1, 'deadbeef'.repeat(8)];
  const payload = {
    conversationId: C1, lastUserInput: 'my last input', stepIdx: 3, workspacePaths: ['/w'],
    toolCall: { name: 'mcp_tool', args: { serverName: 'orrery', arguments: JSON.stringify({ body: 'top secret body', orreryCaller: `${C1}.${'deadbeef'.repeat(8)}` }) } },
  };
  const line = JSON.stringify(hookDump.record(JSON.stringify(payload)));
  for (const bit of secretBits) assert.ok(!line.includes(bit), `not recorded: ${bit}`);
  assert.deepEqual(hookDump.record(JSON.stringify(payload)), {
    toolName: 'mcp_tool',
    shape: {
      conversationId: 'string(36)', lastUserInput: 'string(13)', stepIdx: 'number', workspacePaths: ['string(2)'],
      toolCall: { name: 'string(8)', args: { serverName: 'string(6)', arguments: { jsonString: { body: 'string(15)', orreryCaller: 'string(101)' } } } },
    },
  });
  assert.deepEqual(hookDump.record('not json'), { unparsable: 'string(8)' });
});

// ───────────── sidecar ─────────────

function quietLog() {
  const lines: string[] = [];
  return { lines, info: (s: string) => lines.push(s), warn: (s: string) => lines.push(s) };
}

/** The sidecar with the fake agentapi; `calls()` = the argv each agentapi run got (after the executable). */
function fakeSidecar(home: string, extraEnv: Record<string, string> = {}) {
  const logFile = join(tempDir(), 'agentapi.log');
  const log = quietLog();
  const env = { ...process.env, ANTIGRAVITY_CSRF_TOKEN: CSRF, ANTIGRAVITY_LS_VERSION: '2.28.2', FAKE_AGENTAPI_LOG: logFile, ...extraEnv };
  const sc = sidecar.start({ home, env, retryMs: RETRY_MS, log, agentapi: { file: process.execPath, args: [FAKE_AGENTAPI, 'agentapi'] } });
  const calls = (): string[][] => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { ...sc, calls, log };
}

test('antigravity sidecar: online while connected, reports the version; a delivery runs agentapi send-message and is acked; a failure is scrubbed of the token', async () => {
  const app = await agHub();
  const sc = fakeSidecar(app.home);
  try {
    const { cluster, g1, g2 } = await agCluster(app);
    await waitFor(async () => (await statusOf(app, g1.id)) === 'idle' && (await statusOf(app, g2.id)) === 'idle', 'both online');
    assert.equal((await app.api('GET', '/api/harness-modes')).find((m: any) => m.harness === 'antigravity').bridgeVersion, '2.28.2');
    const badVersion = await fetch(`${app.url}/bridge/stream?harness=antigravity&version=bad%20version`, { headers: { 'x-orrery-bridge': app.secret } });
    assert.equal(badVersion.status, 400, 'the Hub takes only a short version string');
    await badVersion.body?.cancel();

    const text = 'hello "G1"\nsecond line & | < > ^ %PATH% $(x)';
    const m1 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: text, to: [g1.id] });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m1.id, g1.id))?.state === 'done', 'g1 done');
    assert.deepEqual(sc.calls(), [['agentapi', 'send-message', C1, text]], 'exact argv, no shell in between');

    const m2 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '-v starts with a dash', to: [g2.id] });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m2.id, g2.id))?.state === 'done', 'g2 done');
    assert.deepEqual(sc.calls().at(-1), ['agentapi', 'send-message', '--', C2, '-v starts with a dash']);

    const m3 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'please fail', to: [g1.id] });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m3.id, g1.id))?.state === 'failed', 'g1 failed');
    const error = (await deliveryTo(app, cluster.id, m3.id, g1.id))!.error!;
    assert.match(error, /agentapi send-message failed \(3\): conversation busy/);
    assert.doesNotMatch(error, new RegExp(CSRF), 'the token never reaches the Hub');
    assert.ok(sc.log.lines.every((l: string) => !l.includes(CSRF)), 'nor the log');

    // A token across the 500-character cut is scrubbed before the cut, so not even its tail gets out.
    const m4 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'please fail straddle', to: [g1.id] });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m4.id, g1.id))?.state === 'failed', 'g1 failed again');
    const cut = (await deliveryTo(app, cluster.id, m4.id, g1.id))!.error!;
    assert.match(cut, /\[redacted\]|^agentapi send-message failed \(3\): A*B+$/);
    for (const part of [CSRF, CSRF.slice(8), CSRF.slice(-12)]) {
      assert.ok(!cut.includes(part), `no piece of the token in the ack: ${part}`);
      assert.ok(sc.log.lines.every((l: string) => !l.includes(part)), `nor in the log: ${part}`);
    }
    await waitFor(() => app.settled(cluster.id), 'settled');

    sc.stop();
    await waitFor(async () => (await statusOf(app, g1.id)) === 'offline', 'offline once the sidecar stops');
    const off = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'while away', to: [g1.id] });
    assert.equal((await deliveryTo(app, cluster.id, off.id, g1.id))!.state, 'offline');
    assert.equal(sc.calls().length, 4, 'nothing run after stop');
  } finally {
    sc.stop();
    await done(app);
  }
});

test('antigravity sidecar: refuses a non-UUID conversation or a NUL text without running agentapi, and a normal message after a bad one is still delivered; sends neither the token nor the text anywhere but agentapi', async () => {
  // A plain HTTP server stands in for the Hub: it streams two deliveries and records every request it gets.
  const seen: { url: string; headers: string; body: string }[] = [];
  const acks: any[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url!, headers: JSON.stringify(req.headers), body });
    if (req.url!.startsWith('/bridge/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const deliveries = [['d1', 'not-a-uuid; calc.exe', 'hi'], ['d2', C1, 'hi'], ['d3', C1, 'bad\u0000message'], ['d4', C1, 'after the bad one']];
      for (const [deliveryId, sessionId, text] of deliveries) {
        res.write(`event: deliver\ndata: ${JSON.stringify({ deliveryId, sessionId, text })}\n\n`);
      }
      return;
    }
    acks.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"acked":true}');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const home = tempDir();
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: 'fake-secret' }));
  const sc = fakeSidecar(home, { ANTIGRAVITY_LS_VERSION: 'bad version!' });
  try {
    await waitFor(() => acks.length === 4, 'all acked');
    const byId = Object.fromEntries(acks.map((a) => [a.deliveryId, a]));
    assert.deepEqual(byId.d2, { deliveryId: 'd2', ok: true });
    assert.equal(byId.d1.ok, false);
    assert.match(byId.d1.error, /not an Antigravity conversation id/);
    // A NUL in the text is one failed delivery, not the end of the sidecar: the next message still goes through.
    assert.equal(byId.d3.ok, false);
    assert.match(byId.d3.error, /NUL/);
    assert.deepEqual(byId.d4, { deliveryId: 'd4', ok: true });
    assert.deepEqual(sc.calls().sort(), [['agentapi', 'send-message', C1, 'after the bad one'], ['agentapi', 'send-message', C1, 'hi']],
      'agentapi ran only for the UUID and the good texts');
    assert.equal(seen[0].url, '/bridge/stream?harness=antigravity', 'an unusable version is not reported');
    assert.ok(seen.every((r) => !r.headers.includes(CSRF) && !r.body.includes(CSRF)), 'the token is never sent');
  } finally {
    sc.stop();
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }
});

test('antigravity sidecar: how agentapi is run; the folder is a self-contained sidecar; hook and sidecar use Node built-ins only', () => {
  assert.deepEqual(sidecar.agentapiCommand({ ANTIGRAVITY_AGENTAPI_EXE: 'C:\\x\\language_server.exe' }, 'win32'), { file: 'C:\\x\\language_server.exe', args: ['agentapi'] });
  assert.equal(sidecar.agentapiCommand({}, 'win32'), null, 'no .bat through a shell');
  assert.deepEqual(sidecar.agentapiCommand({}, 'linux'), { file: 'agentapi', args: [] });
  assert.deepEqual(sidecar.sendMessageArgs(C1, 'hi'), ['send-message', C1, 'hi']);
  assert.deepEqual(sidecar.sendMessageArgs(C1, '--help'), ['send-message', '--', C1, '--help']);

  const spec = JSON.parse(readFileSync(join(PLUGIN_DIR, 'sidecar.json'), 'utf8'));
  assert.deepEqual([spec.command, spec.args, spec.restart_policy, spec.display_name], ['node', ['sidecar.mjs'], 'always', 'orrery Beta']);
  assert.equal(spec.builtin, undefined);
  assert.equal(spec.env, undefined, 'no environment of ours: agentapi gets what Antigravity injects');
  for (const file of ['sidecar.mjs', 'hook.mjs', 'hook-dump.mjs']) {
    const code = readFileSync(join(PLUGIN_DIR, file), 'utf8');
    const imports = [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.filter((s) => !s.startsWith('node:')), [], `${file}: Node built-ins only`);
    assert.doesNotMatch(code, /\bfetch\(/, `${file}: no fetch (it would honour NODE_USE_ENV_PROXY)`);
    assert.doesNotMatch(code, /shell\s*:|\bexec\(|execSync|\bspawn\(|antigravity:\/\/|vscode:\/\/|openExternal/, `${file}: no shell, no other program, no links`);
  }
  assert.match(readFileSync(join(PLUGIN_DIR, 'sidecar.mjs'), 'utf8'), /execFile\(agentapi\.file/);
  assert.ok(resolve(PLUGIN_DIR).startsWith(resolve(REPO_ROOT)));
});
