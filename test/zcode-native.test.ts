// Native ZCode without ZCode (docs/adapters/zcode.md, "测试"): the store over databases built here (WAL included, columns
// missing), the caller identity from _meta, tickets, the wait/ack flow with a fake wait client, the anti-loop rules, and
// the real wait.mjs as a child process against a real test Hub. Nothing here runs ZCode or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createZcodeNativeAdapter, NOT_REARMED } from '../src/adapters/zcode/native.ts';
import { createZcodeStore, timeOf } from '../src/adapters/zcode/store.ts';
import { nativeFactories } from '../src/adapters/index.ts';
import { REPO_ROOT } from '../src/main.ts';
import { ARM_LIMIT, NOT_MEMBER_TEXT, tail, ticketFor, ticketSession, waitCommand, WAIT_SCRIPT, zcodeCaller } from '../src/mcp/zcode.ts';
import type { BridgePort, Member, NativeDeliverContext } from '../src/core/types.ts';
import { freePort, startTestHub, tempDir, waitFor, openSse } from './helpers.ts';

const WAIT = join(REPO_ROOT, 'plugins', 'zcode-orrery', 'wait.mjs');
const waitModule = await import(pathToFileURL(WAIT).href);
const S1 = 'task_11111111';
const S2 = 'task_22222222';
const SUB = 'task_sub';
const REMOTE = 'task_remote';
const OUTSIDER = 'task_outsider';

// ───────────── databases like ZCode's ─────────────

/** <home>/v2/tasks-index.sqlite (some rows only in the WAL, writer kept open) and <home>/cli/db/db.sqlite. */
function fakeZcode(opts: { minimal?: boolean } = {}) {
  const home = tempDir();
  const alpha = join(home, 'work', 'alpha');
  const beta = join(home, 'work', 'beta');
  mkdirSync(join(home, 'v2'), { recursive: true });
  mkdirSync(join(home, 'cli', 'db'), { recursive: true });
  const tasks = new DatabaseSync(join(home, 'v2', 'tasks-index.sqlite'));
  tasks.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  if (opts.minimal) {
    // An older or newer layout: only the two columns the store needs.
    tasks.exec('CREATE TABLE tasks (task_id TEXT, workspace_path TEXT)');
    tasks.prepare('INSERT INTO tasks VALUES (?, ?)').run(S1, alpha);
  } else {
    tasks.exec(`CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT, title TEXT,
      task_status TEXT, model TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, deleted INTEGER, cli_title TEXT, cli_deleted INTEGER)`);
    const add = tasks.prepare(`INSERT INTO tasks (workspace_path, workspace_identity, task_id, title, model, created_at, updated_at, archived, deleted, cli_title, cli_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    add.run(alpha, '', S1, ' Fix parser ', 'glm-5', 1_700_000_000_000, 1_700_000_100_000, 0, 0, null, 0);
    add.run(alpha, null, SUB, '', null, 1_700_000_000_000, null, 0, 0, 'cli title', 0);
    add.run(alpha, '', 'task_deleted', 'gone', null, 1, 1, 0, 1, null, 0);
    add.run(alpha, '', 'task_archived', 'old', null, 1, 1, 1, 0, null, 0);
    add.run(alpha, '', 'task_cli_deleted', 'cli gone', null, 1, 1, 0, 0, null, 1);
    add.run(beta, '{"kind":"ssh","host":"x"}', REMOTE, 'remote', null, 1, 1, 0, 0, null, 0);
    add.run(beta, '', 'bad id with spaces', 'bad', null, 1, 1, 0, 0, null, 0);
    tasks.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    // Newest rows after the checkpoint: only in the WAL.
    add.run(beta, '', S2, 'Beta chat', null, 1_700_000_000, 1_700_000_200, 0, 0, null, 0);
    add.run(alpha, '', OUTSIDER, 'outsider', null, 1, 1, 0, 0, null, 0);
  }
  const usage = new DatabaseSync(join(home, 'cli', 'db', 'db.sqlite'));
  usage.exec(`PRAGMA journal_mode = WAL; CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, input_tokens INTEGER,
    output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER)`);
  const turn = usage.prepare('INSERT INTO turn_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  turn.run(S1, 't1', 'completed', 100, 50, 10, 5, 1000);
  turn.run(S1, 't2', 'error', 20, 0, null, 0, 0);
  turn.run(S2, 't3', 'completed', 7, 3, 0, 0, 0);
  return { home, alpha, beta, writers: [tasks, usage] };
}

test('zcode store: conversations from a copy of tasks-index (WAL included); filters; titles; times; tokens; originals untouched', async () => {
  const z = fakeZcode();
  try {
    const files = () => Object.fromEntries(readdirSync(join(z.home, 'v2')).map((f) => [f, readFileSync(join(z.home, 'v2', f)).toString('base64')]));
    const before = files();
    assert.ok(before['tasks-index.sqlite-wal'], 'the fixture has a WAL');
    const store = createZcodeStore(z.home);
    const projects = await store.listProjects();
    assert.deepEqual(projects.map((p) => [p.label, p.updatedAt]), [['beta', '2023-11-14T22:16:40.000Z'], ['alpha', '2023-11-14T22:15:00.000Z']]);
    const alpha = await store.listSessions(z.alpha.toUpperCase());   // paths compare case-insensitively on Windows
    if (process.platform === 'win32') assert.deepEqual(alpha.map((s) => [s.id, s.title, s.model]), [[S1, 'Fix parser', 'glm-5'], [SUB, 'cli title', null], [OUTSIDER, 'outsider', null]]);
    assert.deepEqual((await store.listSessions(z.beta)).map((s) => s.id), [S2], 'the remote workspace and the bad id are left out; the WAL row is in');
    assert.equal((await store.get(S2))?.title, 'Beta chat');
    assert.equal(await store.get('task_deleted'), null);
    assert.equal(await store.get(REMOTE), null);
    assert.deepEqual(await store.tokens(S1), { input: 120, cachedInput: 1000, cacheWrite: 5, output: 50, reasoning: 10 });
    assert.equal(await store.tokens('nope'), null);
    assert.deepEqual(files(), before, 'the original database and WAL are unchanged');
  } finally {
    for (const w of z.writers) w.close();
  }
});

test('zcode store: missing columns are tolerated, a missing table or database reads as nothing', async () => {
  const z = fakeZcode({ minimal: true });
  try {
    const store = createZcodeStore(z.home);
    assert.deepEqual(await store.listSessions(z.alpha), [{ id: S1, title: S1, model: null, cwd: z.alpha, updatedAt: null }]);
    const none = createZcodeStore(tempDir());
    assert.deepEqual(await none.listProjects(), []);
    assert.equal(await none.tokens(S1), null);
    assert.deepEqual([timeOf(1_700_000_000), timeOf('2026-01-02T03:04:05Z'), timeOf(0), timeOf('x'), timeOf(null)],
      ['2023-11-14T22:13:20.000Z', '2026-01-02T03:04:05.000Z', null, null, null]);
  } finally {
    for (const w of z.writers) w.close();
  }
});

// ───────────── identity and tickets ─────────────

test('zcode tickets: signed per session, verified in constant time, stable; the command is byte-identical', () => {
  const t = ticketFor('secret-a', S1);
  assert.match(t, /^z1\.task_11111111\.[0-9a-f]{64}$/);
  assert.equal(ticketFor('secret-a', S1), t, 'same session, same ticket');
  assert.equal(ticketSession('secret-a', t), S1);
  assert.equal(ticketSession('secret-b', t), null, 'another secret');
  assert.equal(ticketSession('secret-a', t.replace(S1, S2)), null, 'another session under the same tag');
  for (const bad of [undefined, '', 'z1.', `z2.${S1}.${'0'.repeat(64)}`, `z1.${S1}.${'0'.repeat(63)}`, `z1.a b.${'0'.repeat(64)}`, 'secret-a']) {
    assert.equal(ticketSession('secret-a', bad), null, String(bad));
  }
  assert.throws(() => ticketFor('s', 'has space'));
  assert.throws(() => ticketFor('s', 'semi;colon'));
  assert.notEqual(t, 'secret-a');
  const hub = 'http://127.0.0.1:4390';
  assert.equal(waitCommand(t, hub), `node "${WAIT_SCRIPT}" ${t} ${hub}`, 'names the issuing Hub');
  assert.ok(!WAIT_SCRIPT.includes('\\'));
  assert.throws(() => waitCommand(t, hub, 'C:/100%/wait.mjs'));
  assert.throws(() => waitCommand(t, hub, 'C:/$HOME/wait.mjs'));
  for (const bad of ['http://example.com:80', 'http://127.0.0.1', 'https://127.0.0.1:1', 'http://127.0.0.1:1 & calc']) assert.throws(() => waitCommand(t, bad), bad);
  assert.ok(tail(waitCommand(t, hub)).includes(waitCommand(t, hub)));
});

test('zcode caller: root_session_id ?? session_id, flat or in com.zcode/request-context; subagent and remote workspace flagged', () => {
  assert.deepEqual(zcodeCaller({ session_id: S1 }), { sessionId: S1, subagent: false, remote: false });
  assert.deepEqual(zcodeCaller({ session_id: SUB, root_session_id: S1 }), { sessionId: S1, subagent: true, remote: false });
  assert.deepEqual(zcodeCaller({ session_id: S1, root_session_id: S1 }), { sessionId: S1, subagent: false, remote: false });
  assert.deepEqual(zcodeCaller({ 'com.zcode/request-context': { session_id: S2, workspace_identity: { kind: 'wsl' } } }), { sessionId: S2, subagent: false, remote: true });
  assert.deepEqual(zcodeCaller({ session_id: S1, workspace_identity: '' }), { sessionId: S1, subagent: false, remote: false });
  for (const meta of [undefined, {}, { session_id: 1 }, { session_id: '' }, { threadId: S1 }, { 'kimi/sessionId': S1 }]) assert.equal(zcodeCaller(meta as any), null);
});

// ───────────── a Hub with ZCode members ─────────────

async function zHub(opts: { graceMs?: number; z?: ReturnType<typeof fakeZcode>; port?: number; dir?: string } = {}) {
  const z = opts.z ?? fakeZcode();
  // ZCode counts as running: these tests never look at the real process list.
  const adapter = createZcodeNativeAdapter({ zcodeHome: z.home, rearmGraceMs: opts.graceMs ?? 60_000, pollMs: 10, zcodeRunning: async () => true });
  const app = await startTestHub({ ...(opts.dir ? { dir: opts.dir } : {}), ...(opts.port ? { port: opts.port } : {}), nativeAdapters: { zcode: adapter }, limits: { recheckMs: 60_000 } });
  return Object.assign(app, { z, secret: JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string });
}
type ZHub = Awaited<ReturnType<typeof zHub>>;

async function zCluster(app: ZHub) {
  const { cluster, members: [z1, z2, a] } = await app.api('POST', '/api/clusters', {
    name: 'zc',
    members: [
      { harness: 'zcode', mode: 'native', sessionId: S1, name: 'Z1' },
      { harness: 'zcode', mode: 'native', sessionId: S2, name: 'Z2' },
      { harness: 'mock', mode: 'native', name: 'A', projectPath: '/work' },
    ],
  });
  return { cluster, z1, z2, a };
}

async function done(app: ZHub) {
  await app.close();
  for (const w of app.z.writers) w.close();
}

async function rpc(app: ZHub, method: string, params: unknown, headers: Record<string, string> = { 'x-orrery-harness': 'zcode' }) {
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': app.secret, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()).result;
}
const call = (app: ZHub, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>, headers?: Record<string, string>) =>
  rpc(app, 'tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, headers);
const statusOf = async (app: ZHub, id: string) => ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status;
const say = (app: ZHub, clusterId: string, body: string) => app.api('POST', `/api/clusters/${clusterId}/messages`, { body });
const deliveriesOf = async (app: ZHub, clusterId: string, memberId: string) =>
  (await app.messages(clusterId)).flatMap((m) => m.deliveries.filter((d) => d.memberId === memberId).map((d) => ({ ...d, body: m.body })));

/** A fake wait.mjs: holds GET /bridge/zcode-wait and collects its SSE events. */
function openWait(url: string, ticket: string) {
  return openSse(`${url}/bridge/zcode-wait`, { 'x-orrery-ticket': ticket });
}
const ack = (app: ZHub, ticket: string, deliveryId: string) => fetch(`${app.url}/bridge/zcode-ack`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, deliveryId }),
}).then((r) => r.json());

test('zcode identity: _meta names the member; subagents speak as their root; wait_for_messages only for zcode callers, main conversation, local workspace', async () => {
  const app = await zHub();
  try {
    const { cluster, z1 } = await zCluster(app);
    const names = (r: any) => r.tools.map((t: any) => t.name).sort();
    const others = names(await rpc(app, 'tools/list', {}, {}));   // a Codex caller's tools
    assert.deepEqual(names(await rpc(app, 'tools/list', {})), [...others, 'wait_for_messages'].sort(), 'every tool of the others, plus wait_for_messages');
    assert.ok(!names(await rpc(app, 'tools/list', {}, {})).includes('wait_for_messages'), 'a Codex caller does not get it');
    assert.ok(!names(await rpc(app, 'tools/list', {}, { 'x-orrery-harness': 'kimi' })).includes('wait_for_messages'));

    const listed = await call(app, 'list_agents', {}, { session_id: S1 });
    assert.deepEqual(JSON.parse(listed.content[0].text).map((m: any) => m.name), ['Z1', 'Z2', 'A']);
    const sent = await call(app, 'send_message', { body: 'from a subagent' }, { session_id: SUB, root_session_id: S1 });
    assert.equal(sent.isError, undefined, JSON.stringify(sent));
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, z1.id, 'a subagent speaks as its top-level conversation');
    const nested = await call(app, 'read_messages', { history: true }, { 'com.zcode/request-context': { session_id: S2 } });
    assert.equal(nested.isError, undefined);

    const w = await call(app, 'wait_for_messages', {}, { session_id: S1 });
    const got = JSON.parse(w.content[0].text);
    assert.equal(got.command, waitCommand(ticketFor(app.secret, S1), app.url));
    assert.deepEqual([got.run_in_background, got.description], [true, 'orrery：等群消息']);
    assert.equal(got.running, 0);
    const held = openWait(app.url, ticketFor(app.secret, S1));
    await held.status;
    const again = JSON.parse((await call(app, 'wait_for_messages', {}, { session_id: S1 })).content[0].text);
    assert.equal(again.running, 1);
    assert.match(again.instructions, /^这个对话现在已经有 1 条这样的命令连着 orrery：不要再运行/);
    held.close();
    assert.equal(JSON.parse((await call(app, 'wait_for_messages', {}, { session_id: S1, turn_id: 'other' })).content[0].text).command, got.command, 'byte-identical every time');
    assert.match((await call(app, 'wait_for_messages', {}, { session_id: SUB, root_session_id: S1 })).content[0].text, /只能在主对话里挂等待/);
    assert.match((await call(app, 'wait_for_messages', {}, { session_id: S1, workspace_identity: { kind: 'ssh' } })).content[0].text, /远程工作区/);

    const count = (await app.messages(cluster.id)).length;
    for (const meta of [undefined, { session_id: OUTSIDER }, { session_id: 1 }, { threadId: S1 }, { 'kimi/sessionId': S1 }]) {
      for (const tool of ['send_message', 'wait_for_messages']) {
        const r = await call(app, tool, { body: 'spoof' }, meta as any);
        assert.deepEqual([r.isError, r.content[0].text], [true, '这个对话还不是任何 orrery 集群的成员'], `${tool} ${JSON.stringify(meta)}`);
      }
      assert.deepEqual(JSON.parse((await call(app, 'list_agents', {}, meta as any)).content[0].text), []);
    }
    // Other callers never take a ZCode identity from _meta.
    assert.match((await call(app, 'send_message', { body: 'x' }, { session_id: S1 }, {})).content[0].text, /不是任何 orrery 集群的成员/);
    assert.equal((await app.messages(cluster.id)).length, count, 'nothing written by refused calls');
  } finally {
    await done(app);
  }
});

test('zcode wait: deliver → printed and acked → busy until re-armed; messages meanwhile queue and go together on the new wait', async () => {
  const app = await zHub();
  try {
    const { cluster, z1 } = await zCluster(app);
    const ticket = ticketFor(app.secret, S1);
    assert.equal(await statusOf(app, z1.id), 'offline');
    assert.equal((await say(app, cluster.id, '@Z1 while offline')).id !== undefined, true);
    await waitFor(async () => (await deliveriesOf(app, cluster.id, z1.id))[0]?.state === 'offline', 'offline delivery');

    assert.equal(await openWait(app.url, 'z1.bad').status, 403);
    assert.equal(await openWait(app.url, ticketFor('another secret', S1)).status, 403);
    const first = openWait(app.url, ticket);
    assert.equal(await first.status, 200);
    await waitFor(async () => (await statusOf(app, z1.id)) === 'idle', 'online once a wait is connected');

    const m1 = await say(app, cluster.id, '@Z1 hello "quoted" & | < > ^ % $(x)\nline 2');
    await waitFor(() => first.events.length, 'the delivery');
    const [{ event, data }] = first.events;
    assert.equal(event, 'deliver');
    assert.ok(data.text.includes(`messageId=${m1.id}`) && data.text.includes('hello "quoted" & | < > ^ % $(x)\nline 2'));
    assert.ok(data.text.endsWith(tail(waitCommand(ticket, app.url))), 'the envelope ends with the re-arm instructions');
    assert.equal(await statusOf(app, z1.id), 'busy');

    assert.deepEqual(await ack(app, ticketFor(app.secret, S2), data.deliveryId), { acked: false }, 'another session cannot ack it');
    assert.deepEqual(await ack(app, ticket, data.deliveryId), { acked: true });
    await first.ended;
    assert.deepEqual(await ack(app, ticket, data.deliveryId), { acked: false }, 'once');
    // Busy in the re-arm grace: new messages queue (they are not 'offline').
    await say(app, cluster.id, '@Z1 second');
    await say(app, cluster.id, '@Z1 third');
    await new Promise((ok) => setTimeout(ok, 100));
    const mid = await deliveriesOf(app, cluster.id, z1.id);
    assert.deepEqual(mid.slice(1).map((d) => d.state), ['running', 'queued', 'queued']);
    assert.equal(await statusOf(app, z1.id), 'busy');

    const second = openWait(app.url, ticket);   // the member ran the same command again
    await waitFor(() => second.events.length, 'the queued batch on the new wait');
    assert.ok(second.events[0].data.text.includes('@Z1 second') && second.events[0].data.text.includes('@Z1 third'), 'one batch');
    const after = await deliveriesOf(app, cluster.id, z1.id);
    assert.deepEqual([after[1].state, after[1].outcome], ['done', 'accepted']);
    assert.deepEqual(after.slice(2).map((d) => d.state), ['running', 'running']);
    second.close();
  } finally {
    await done(app);
  }
});

test('zcode wait: a duplicate wait is held aside, takes over after a delivery, and counts as the re-arm', async () => {
  const app = await zHub();
  try {
    const { cluster, z1 } = await zCluster(app);
    const ticket = ticketFor(app.secret, S1);
    const a = openWait(app.url, ticket);
    await waitFor(async () => (await statusOf(app, z1.id)) === 'idle', 'online');
    const b = openWait(app.url, ticket);
    await b.status;
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'zcode_extra_wait' && e.memberId === z1.id), 'notice');
    await say(app, cluster.id, '@Z1 one');
    await waitFor(() => a.events.length, 'delivered to the first wait');
    assert.equal(b.events.length, 0, 'never to the held one');
    await ack(app, ticket, a.events[0].data.deliveryId);
    await waitFor(async () => (await deliveriesOf(app, cluster.id, z1.id))[0]?.state === 'done', 'the held wait took over: re-armed');
    await say(app, cluster.id, '@Z1 two');
    await waitFor(() => b.events.length, 'the next delivery on the promoted wait');
    a.close();
    b.close();
  } finally {
    await done(app);
  }
});

test('zcode wait: the active wait dropping without a delivery hands over to the held one; queued messages stay queued', async () => {
  const app = await zHub();
  try {
    const { cluster, z1 } = await zCluster(app);
    const ticket = ticketFor(app.secret, S1);
    const a = openWait(app.url, ticket);
    await waitFor(async () => (await statusOf(app, z1.id)) === 'idle', 'online');
    const b = openWait(app.url, ticket);
    await b.status;
    await app.api('POST', '/api/pause', { paused: true });
    await say(app, cluster.id, '@Z1 while paused');
    a.close();   // dropped without carrying a delivery
    await a.ended;
    await new Promise((ok) => setTimeout(ok, 100));
    assert.deepEqual((await deliveriesOf(app, cluster.id, z1.id)).map((d) => d.state), ['queued'], 'not marked offline in the hand-over');
    assert.equal(await statusOf(app, z1.id), 'idle');
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => b.events.length, 'delivered to the promoted wait');
    assert.ok(b.events[0].data.text.includes('@Z1 while paused'));
    b.close();
  } finally {
    await done(app);
  }
});

test('zcode wait: at most ARM_LIMIT waits per window are taken; later ones are only held (guard notice); removal ends every wait once', async () => {
  const app = await zHub();
  try {
    const { cluster, z1 } = await zCluster(app);
    const ticket = ticketFor(app.secret, S1);
    const waits: ReturnType<typeof openWait>[] = [];
    for (let i = 0; i < ARM_LIMIT; i++) {
      const w = openWait(app.url, ticket);
      await w.status;
      waits.push(w);
    }
    assert.ok(!app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'zcode_arm_rate'));
    const over = openWait(app.url, ticket);
    await over.status;
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'zcode_arm_rate' && e.memberId === z1.id), 'rate notice');
    // Use up every taken wait: the over-limit one never receives a delivery.
    for (let i = 0; i < ARM_LIMIT; i++) {
      await say(app, cluster.id, `@Z1 m${i}`);
      await waitFor(() => waits[i].events.length, `delivery ${i}`);
      await ack(app, ticket, waits[i].events[0].data.deliveryId);
    }
    await say(app, cluster.id, '@Z1 last');
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(over.events.length, 0, 'an over-limit wait is never used');
    assert.equal(await statusOf(app, z1.id), 'busy', 'still in the re-arm grace of the last delivery');

    await app.api('DELETE', `/api/clusters/${cluster.id}/members/${z1.id}`, {});
    await over.ended;
    assert.deepEqual(over.events, [{ event: 'end', data: { text: NOT_MEMBER_TEXT } }]);
    const late = openWait(app.url, ticket);
    await late.ended;
    assert.deepEqual(late.events, [{ event: 'end', data: { text: NOT_MEMBER_TEXT } }], 'a removed conversation is told to stop');
  } finally {
    await done(app);
  }
});

test('zcode wait: a member moved to another conversation tells the old conversation to stop waiting', async () => {
  const app = await zHub();
  try {
    const { z1 } = await zCluster(app);
    const wait = openWait(app.url, ticketFor(app.secret, S1));
    assert.equal(await wait.status, 200);
    await waitFor(() => app.hub.listMembers().find((m) => m.id === z1.id)!.status === 'idle', 'the wait counts as online');
    await app.api('POST', `/api/members/${z1.id}/session`, { harness: 'zcode', sessionId: OUTSIDER, confirmStopped: true });
    await wait.ended;
    assert.deepEqual(wait.events, [{ event: 'end', data: { text: NOT_MEMBER_TEXT } }]);
  } finally {
    await done(app);
  }
});

test('zcode wait: no re-arm within the grace → offline, the queue ends offline, the member page says how to re-arm', async () => {
  const app = await zHub({ graceMs: 200 });
  try {
    const { cluster, z1 } = await zCluster(app);
    const ticket = ticketFor(app.secret, S1);
    const w = openWait(app.url, ticket);
    await waitFor(async () => (await statusOf(app, z1.id)) === 'idle', 'online');
    await say(app, cluster.id, '@Z1 one');
    await waitFor(() => w.events.length, 'delivered');
    await ack(app, ticket, w.events[0].data.deliveryId);
    await say(app, cluster.id, '@Z1 two');
    await waitFor(async () => (await deliveriesOf(app, cluster.id, z1.id)).map((d) => d.state).join() === 'done,offline', 'grace over');
    assert.equal(await statusOf(app, z1.id), 'offline');
    assert.ok(app.events.some((e) => e.kind === 'agent' && (e.payload as any).event.message === NOT_REARMED));
  } finally {
    await done(app);
  }
});

// ───────────── the real wait.mjs ─────────────

function runWait(home: string, ticket: string, ...extraArgs: string[]) {
  const child = spawn(process.execPath, [WAIT, ticket, ...extraArgs], { env: { ...process.env, ORRERY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
  child.stderr.resume();
  const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
  return { child, exited, out: () => out };
}

test('wait.mjs: prints the envelope verbatim (quotes, newlines, & | < > ^ % $()), acks, exits 0; survives a Hub restart without exiting', async () => {
  const dir = tempDir();
  const port = await freePort();
  const z = fakeZcode();
  let app = await zHub({ z, port, dir });
  let wait: ReturnType<typeof runWait> | undefined;
  try {
    const { cluster, z1 } = await zCluster(app);
    const ticket = ticketFor(app.secret, S1);
    // The Hub URL from the command, with a home whose hub.json names another Hub: the argument wins.
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, 'hub.json'), JSON.stringify({ url: 'http://127.0.0.1:1', secret: 'x' }));
    wait = runWait(elsewhere, ticket, app.url);
    await waitFor(async () => (await statusOf(app, z1.id)) === 'idle', 'wait.mjs connected', 10_000);
    assert.equal(wait.out(), waitModule.STARTED);

    // The Hub restarts (same home, database and port): wait.mjs keeps waiting and connects to the new one.
    await app.close();
    app = await zHub({ z, port, dir });
    // A pooled connection to the old Hub may be reset once: retry.
    await waitFor(async () => (await statusOf(app, z1.id).catch(() => null)) === 'idle', 'reconnected after the restart', 15_000);
    assert.equal(wait.child.exitCode, null, 'did not exit (exiting would start a turn)');

    const body = '@Z1 "double" \'single\' & | < > ^ % $(rm -rf) `tick` \\back\nsecond line\r\nthird';
    const m = await say(app, cluster.id, body);
    assert.equal(await wait.exited, 0);
    const printed = wait.out().slice(waitModule.STARTED.length);
    assert.ok(printed.includes(`messageId=${m.id}`));
    assert.ok(printed.includes(body), 'the body exactly as sent');
    assert.ok(printed.endsWith(tail(waitCommand(ticket, app.url))));
    await waitFor(async () => (await statusOf(app, z1.id)) === 'busy', 'in the re-arm grace');
  } finally {
    wait?.child.kill();
    await done(app);
  }
});

test('wait.mjs: a wrong ticket ends at once with a message; a refused ticket says it is void; a non-loopback hub.json is never contacted', async () => {
  const home = tempDir();
  const bad = runWait(home, 'not-a-ticket');
  assert.equal(await bad.exited, 0);
  assert.equal(bad.out(), waitModule.BAD_TICKET);
  for (const url of ['http://example.com:80', 'http://10.0.0.1:4317', 'https://127.0.0.1:4317', 'http://127.0.0.1']) {
    const away = runWait(home, ticketFor('s', S1), url);
    assert.equal(await away.exited, 0);
    assert.equal(away.out(), waitModule.BAD_TICKET, `${url} is refused before any connection`);
  }

  const app = await zHub();
  try {
    const refused = runWait(app.home, ticketFor('another secret', S1));   // no URL argument (an older command): hub.json
    assert.equal(await refused.exited, 0);
    assert.equal(refused.out(), waitModule.STARTED + waitModule.VOID_TICKET, 'reached the Hub through hub.json');
  } finally {
    await done(app);
  }

  // hub.json pointing away from this machine: waitOnce keeps retrying and never asks it.
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: 'http://example.com:80', secret: 'x' }));
  const logs: string[] = [];
  const stop = new AbortController();
  const p = waitModule.waitOnce(ticketFor('s', S1), { home, retryMs: 20, log: (s: string) => logs.push(s), signal: stop.signal });
  await new Promise((ok) => setTimeout(ok, 150));
  stop.abort();
  await assert.rejects(p);
  assert.equal(logs.length, 1, 'one log line, however many retries');
  assert.match(logs[0], /no hub\.json/);
});

test('zcode adapter: a connected wait with no ZCode.exe running is offline and gets no delivery; unknown counts as running', async () => {
  const z = fakeZcode();
  try {
    let answer: boolean | null = false;
    let calls = 0;
    const adapter = createZcodeNativeAdapter({ zcodeHome: z.home, pollMs: 10, zcodeRunning: async () => (calls++, answer) });
    const pushed: string[] = [];
    const bridge: BridgePort = {
      isOnline: () => true,
      push: async (_h, _s, id) => (pushed.push(id), { ok: true }),
      waitDone: async () => 'dropped',
    };
    assert.equal(adapter.isOnline(S1, bridge), true, 'before the first check: unknown, so not marked offline');
    await waitFor(() => calls > 0, 'the background check');
    await new Promise((ok) => setTimeout(ok, 10));
    assert.equal(adapter.isOnline(S1, bridge), false, 'an orphaned wait: offline');
    assert.equal(calls, 1, 'cached, not run per call');
    const ctx = { deliveryId: 'd1', bridge, onEvent: () => {}, signal: new AbortController().signal } as NativeDeliverContext;
    assert.equal(await adapter.deliver(S1, 'text', ctx), 'offline');
    assert.deepEqual(pushed, [], 'nothing pushed to the orphan');
    answer = null;   // tasklist failed: unknown never turns anything offline (a delivery checks afresh)
    assert.equal(await adapter.deliver(S1, 'text', { ...ctx, deliveryId: 'd2' }), 'accepted');
    assert.deepEqual(pushed, ['d2']);
    assert.equal(adapter.isOnline(S1, bridge), true);
    assert.equal(adapter.isOnline(S1, { ...bridge, isOnline: () => false }), false, 'and never anything online');
  } finally {
    for (const w of z.writers) w.close();
  }
});

test('wait.mjs: the anchor is the first ancestor that is not a shell', () => {
  const table = [
    { pid: 10, ppid: 1, name: 'ZCode.exe' },
    { pid: 20, ppid: 10, name: 'bash.exe' },
    { pid: 30, ppid: 20, name: 'BASH.EXE' },
    { pid: 40, ppid: 30, name: 'cmd.exe' },
    { pid: 50, ppid: 99, name: 'sh.exe' },
  ];
  assert.equal(waitModule.anchorOf(table, 40), 10);
  assert.equal(waitModule.anchorOf(table, 10), 10, 'a parent that is no shell is its own anchor');
  assert.equal(waitModule.anchorOf(table, 50), null, 'the chain breaks at a missing process');
  assert.equal(waitModule.anchorOf(table, 77), null);
  assert.equal(waitModule.anchorOf([{ pid: 1, ppid: 1, name: 'bash.exe' }], 1), null, 'a loop ends');
});

test('wait.mjs: exits when the program above its shell is gone, even though the shell survives', { skip: process.platform !== 'win32' && 'Windows process table' }, async () => {
  const app = await zHub();
  let anchor: ReturnType<typeof spawn> | undefined;
  try {
    const { z1 } = await zCluster(app);
    const command = waitCommand(ticketFor(app.secret, S1), app.url);
    // Like ZCode: a non-shell program starts a shell that runs the wait. Killing the program leaves the shell alive.
    anchor = spawn(process.execPath, ['-e', `require('node:child_process').spawn(${JSON.stringify(command)}, { shell: true, stdio: 'ignore' }); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    await waitFor(async () => (await statusOf(app, z1.id)) === 'idle', 'wait.mjs connected', 15_000);
    await new Promise((ok) => setTimeout(ok, 4000));   // let it read the process table
    anchor.kill();
    await waitFor(async () => (await statusOf(app, z1.id)) === 'offline', 'wait.mjs gone after its anchor', 20_000);
  } finally {
    anchor?.kill();
    await done(app);
  }
});

test('wait.mjs: exits when the shell that started it is gone', async () => {
  const home = tempDir();
  // A parent that starts wait.mjs and exits at once, as a crashed shell would leave it.
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, [${JSON.stringify(WAIT)}, ${JSON.stringify(ticketFor('s', S1))}], { env: { ...process.env, ORRERY_HOME: ${JSON.stringify(home)} }, stdio: 'ignore', detached: true });
    console.log(c.pid); c.unref();`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  parent.stdout.on('data', (c) => { out += c; });
  await new Promise((ok) => parent.on('exit', ok));
  const pid = Number(out.trim());
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await waitFor(() => !alive(), 'wait.mjs exits after its parent', 12_000);
  } finally {
    if (alive()) process.kill(pid);
  }
});

test('wait.mjs: Node built-ins only, no fetch; the plugin folder is self-contained', () => {
  const code = readFileSync(WAIT, 'utf8');
  const specs = [...code.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specs.length > 0 && specs.every((s) => s.startsWith('node:')), specs.join());
  assert.ok(!/\bfetch\(/.test(code));
  assert.ok(!code.includes('secret'), 'never reads the bridge secret');
});

test('zcode: registered as a native harness', () => {
  assert.ok('zcode' in nativeFactories);
});
