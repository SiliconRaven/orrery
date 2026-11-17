// Native WorkBuddy without WorkBuddy (docs/adapters/workbuddy.md, "测试"): the conversation list over a database built
// here (WAL included, columns missing), the stdio bridge as a child process (identity only from its environment or a
// WorkBuddy.exe parent; nothing reaches the Hub without one), the wait/ack flow on the workbuddy route, and the offline
// rules. Nothing here runs WorkBuddy or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createWorkbuddyNativeAdapter, NOT_REARMED } from '../src/adapters/workbuddy/native.ts';
import { timeOf } from '../src/adapters/shared/sqlite-copy.ts';
import { createWorkbuddyStore } from '../src/adapters/workbuddy/store.ts';
import { nativeFactories } from '../src/adapters/index.ts';
import { REPO_ROOT } from '../src/main.ts';
import type { Member } from '../src/core/types.ts';
import { WORKBUDDY_WAIT } from '../src/core/types.ts';
import { ticketFor, ticketSession, waitCommand } from '../src/mcp/workbuddy.ts';
import { WAIT_SCRIPT } from '../src/mcp/wait-core.ts';
import { startTestHub, tempDir, waitFor, openSse } from './helpers.ts';

const BRIDGE = join(REPO_ROOT, 'plugins', 'workbuddy-orrery', 'bridge.mjs');
const { processInfo, resolveSessionId, sessionIdFromParent } = await import(pathToFileURL(BRIDGE).href);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '33333333-3333-4333-8333-333333333333';

// ───────────── a database like WorkBuddy's ─────────────

/** <home>/workbuddy.db with sessions and workspaces (one row only in the WAL, writer kept open). */
function fakeWorkbuddy(opts: { minimal?: boolean } = {}) {
  const home = tempDir();
  const alpha = join(home, 'work', 'alpha');
  const beta = join(home, 'work', 'beta');
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  const db = new DatabaseSync(join(home, 'workbuddy.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  if (opts.minimal) {
    db.exec('CREATE TABLE sessions (id TEXT, cwd TEXT)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(S1, alpha);
  } else {
    db.exec(`CREATE TABLE sessions (id TEXT, cwd TEXT, title TEXT, custom_title TEXT, status TEXT, created_at INTEGER,
      updated_at INTEGER, last_activity_at INTEGER, deleted_at TEXT, is_playground INTEGER, is_background_automation INTEGER,
      permission_mode TEXT, transport TEXT, visibility TEXT, group_id TEXT, project_id TEXT, unread INTEGER)`);
    db.exec('CREATE TABLE workspaces (path TEXT, last_opened_at INTEGER)');
    const add = db.prepare(`INSERT INTO sessions (id, cwd, title, custom_title, created_at, updated_at, last_activity_at,
      deleted_at, is_playground, is_background_automation, transport) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    add.run(S1, alpha, ' Fix parser ', null, 1_700_000_000_000, 1_700_000_100_000, 1_700_000_200_000, null, 0, 0, 'local');
    add.run('deleted', alpha, 'gone', null, 1, 1, 1, '2026-01-01T00:00:00Z', 0, 0, 'local');
    add.run('playground', alpha, 'play', null, 1, 1, 1, null, 1, 0, 'local');
    add.run('automation', alpha, 'cron', null, 1, 1, 1, null, 0, 1, 'local');
    add.run('cloud', alpha, 'cloud task', null, 1, 1, 1, null, 0, 0, 'cloud');
    add.run('bad id with spaces', alpha, 'bad', null, 1, 1, 1, null, 0, 0, 'local');
    add.run('no-cwd', '', 'nowhere', null, 1, 1, 1, null, 0, 0, 'local');
    add.run('custom', alpha, 'title', ' Custom title ', 1, 1, 1, null, 0, 0, 'local');
    db.prepare('INSERT INTO workspaces VALUES (?, ?)').run(alpha, 1_700_000_300_000);
    db.prepare('INSERT INTO workspaces VALUES (?, ?)').run(beta, 1_700_000_000_000);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    // Newest row after the checkpoint: only in the WAL.
    add.run(S2, beta, 'Beta chat', null, 1_700_000_000_000, null, 1_700_000_400_000, null, 0, 0, 'local');
  }
  return { home, alpha, beta, db };
}

test('workbuddy store: conversations from a copy of workbuddy.db (WAL included); filters; titles; times; originals untouched', async () => {
  const w = fakeWorkbuddy();
  try {
    const files = () => Object.fromEntries(readdirSync(w.home, { withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => [e.name, readFileSync(join(w.home, e.name)).toString('base64')]));
    const before = files();
    assert.ok(before['workbuddy.db-wal'], 'the fixture has a WAL');
    const store = createWorkbuddyStore(w.home);
    const projects = await store.listProjects();
    assert.deepEqual(projects.map((p) => [p.label, p.updatedAt]), [['beta', '2023-11-14T22:20:00.000Z'], ['alpha', '2023-11-14T22:18:20.000Z']]);
    assert.deepEqual((await store.listSessions(w.alpha)).map((s) => [s.id, s.title]), [[S1, 'Fix parser'], ['custom', 'Custom title']]);
    assert.deepEqual((await store.listSessions(w.beta)).map((s) => s.id), [S2], 'the WAL row is in; the cloud task is left out');
    assert.equal((await store.get(S2))?.title, 'Beta chat');
    for (const id of ['deleted', 'playground', 'automation', 'cloud', 'bad id with spaces', 'no-cwd', 'nope']) {
      assert.equal(await store.get(id), null, id);
    }
    assert.deepEqual(files(), before, 'the original database and WAL are unchanged');
  } finally {
    w.db.close();
  }
});

test('workbuddy store: missing columns are tolerated, a missing table or database reads as nothing', async () => {
  const w = fakeWorkbuddy({ minimal: true });
  try {
    const store = createWorkbuddyStore(w.home);
    assert.deepEqual(await store.listSessions(w.alpha), [{ id: S1, title: S1, model: null, cwd: w.alpha, updatedAt: null }]);
    assert.deepEqual((await store.listProjects()).map((p) => p.path), [w.alpha]);
    w.db.exec('DROP TABLE sessions; CREATE TABLE workspaces (path TEXT);');
    w.db.prepare('INSERT INTO workspaces VALUES (?)').run(w.beta);
    assert.deepEqual((await store.listProjects()).map((p) => p.path), [w.beta]);
    const none = createWorkbuddyStore(tempDir());
    assert.deepEqual(await none.listProjects(), []);
    assert.deepEqual(await none.listSessions('x'), []);
    assert.deepEqual([timeOf(1_700_000_000), timeOf(1_700_000_000_000), timeOf('2026-01-02T03:04:05Z'), timeOf(0), timeOf('x'), timeOf(null)],
      ['2023-11-14T22:13:20.000Z', '2023-11-14T22:13:20.000Z', '2026-01-02T03:04:05.000Z', null, null, null]);
  } finally {
    w.db.close();
  }
});

// ───────────── the wait configuration and the adapter ─────────────

test('workbuddy wait config: its own route, ticket and command; the command names the app ancestor', () => {
  assert.equal(WORKBUDDY_WAIT.harness, 'workbuddy');
  assert.equal(WORKBUDDY_WAIT.appProcess, 'WorkBuddy.exe');
  assert.equal(WORKBUDDY_WAIT.ancestorProcess, 'WorkBuddy.exe');
  assert.equal(WORKBUDDY_WAIT.metaKey, undefined, 'identity comes from the bridge process environment, never _meta');
  assert.equal(WORKBUDDY_WAIT.legacyWire, undefined, 'the envelope carries chat content only');
  const t = ticketFor('secret-a', S1);
  assert.match(t, /^w1\.11111111-1111-4111-8111-111111111111\.[0-9a-f]{64}$/);
  assert.equal(ticketSession('secret-a', t), S1);
  assert.equal(ticketSession('secret-b', t), null);
  const hub = 'http://127.0.0.1:4390';
  assert.equal(waitCommand(t, hub), `node "${WAIT_SCRIPT}" ${t} ${hub} workbuddy WorkBuddy.exe`);
  assert.ok(!WAIT_SCRIPT.includes('\\'));
});

test('workbuddy adapter: registered, no createSession, attach verifies the conversation; the Hub opens its wait route', async () => {
  const w = fakeWorkbuddy();
  const adapter = createWorkbuddyNativeAdapter({ workbuddyHome: w.home, workbuddyRunning: async () => true });
  const app = await startTestHub({ nativeAdapters: { workbuddy: adapter } });
  try {
    assert.ok(nativeFactories.workbuddy);
    assert.equal(app.hub.waitHarness('workbuddy')?.harness, 'workbuddy');
    assert.equal(adapter.harness, 'workbuddy');
    assert.equal(adapter.wait?.harness, 'workbuddy');
    assert.equal(adapter.createSession, undefined);
    assert.equal((await adapter.attachSession(S1)).id, S1);
    await assert.rejects(() => adapter.attachSession('nope'), /not found among the local WorkBuddy conversations/);
  } finally {
    await app.close();
    w.db.close();
  }
});

// ───────────── a Hub with WorkBuddy members ─────────────

async function wbHub(opts: { running?: () => Promise<boolean | null>; graceMs?: number } = {}) {
  const w = fakeWorkbuddy();
  const adapter = createWorkbuddyNativeAdapter({
    workbuddyHome: w.home, rearmGraceMs: opts.graceMs ?? 60_000, pollMs: 10, workbuddyRunning: opts.running ?? (async () => true),
  });
  const app = await startTestHub({ nativeAdapters: { workbuddy: adapter }, limits: { recheckMs: 60_000 } });
  const secret = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  return Object.assign(app, { w, secret });
}
type WHub = Awaited<ReturnType<typeof wbHub>>;

async function wbCluster(app: WHub) {
  const { cluster, members } = await app.api('POST', '/api/clusters', {
    name: 'wb',
    members: [
      { harness: 'workbuddy', mode: 'native', sessionId: S1, name: 'W1' },
      { harness: 'workbuddy', mode: 'native', sessionId: S2, name: 'W2' },
    ],
  });
  return { cluster, w1: members[0] as Member, w2: members[1] as Member };
}

async function done(app: WHub) {
  await app.close();
  app.w.db.close();
}

async function rpc(app: WHub, method: string, params: unknown, session = S1) {
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-orrery-bridge': app.secret, 'x-orrery-harness': 'workbuddy', 'x-orrery-session': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()).result;
}
const call = (app: WHub, name: string, args: Record<string, unknown> = {}, session = S1) =>
  rpc(app, 'tools/call', { name, arguments: args }, session);
const statusOf = async (app: WHub, id: string) => ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status;
const say = (app: WHub, clusterId: string, body: string) => app.api('POST', `/api/clusters/${clusterId}/messages`, { body });
const deliveriesOf = async (app: WHub, clusterId: string, memberId: string) =>
  (await app.messages(clusterId)).flatMap((m) => m.deliveries.filter((d) => d.memberId === memberId).map((d) => ({ ...d, body: m.body })));

/** A fake wait.mjs: holds GET /bridge/workbuddy-wait and collects its SSE events. */
function openWait(url: string, ticket: string) {
  return openSse(`${url}/bridge/workbuddy-wait`, { 'x-orrery-ticket': ticket });
}
const ack = (app: WHub, session: string, deliveryId: string) => fetch(`${app.url}/bridge/workbuddy-ack`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticketFor(app.secret, session), deliveryId }),
}).then((r) => r.json());

/** The real command as WorkBuddy would run it: through the shell, with a home whose hub.json names another Hub. */
function runWait(home: string, ticket: string, url: string) {
  const child = spawn(process.execPath, [WAIT_SCRIPT, ticket, url, 'workbuddy', 'WorkBuddy.exe'], {
    env: { ...process.env, ORRERY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
  child.stderr.resume();
  const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
  return { child, exited, out: () => out };
}

/** A process that starts the bridge as its own child, so the bridge's parent has these arguments on its command line. */
const parentCommand = (parentArgs: string[]) => ['-e',
  `require('node:child_process').spawn(process.execPath, [${JSON.stringify(BRIDGE)}], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0))`,
  '--', ...parentArgs];

/** The stdio bridge as WorkBuddy starts it: a child process with this environment, under a parent if `parentArgs` is given. */
function startBridge(env: Record<string, string | undefined>, parentArgs?: string[]) {
  const child = spawn(process.execPath, parentArgs ? parentCommand(parentArgs) : [BRIDGE], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  const byId = new Map<number, (m: any) => void>();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8').on('data', (c) => { err += c; });
  child.stdout.on('data', (c) => {
    buf += c;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (typeof m.id === 'number' && typeof m.method !== 'string') {
        byId.get(m.id)?.(m);
        byId.delete(m.id);
      }
    }
  });
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((ok, fail) => {
    const id = nextId++;
    // Long enough for the bridge's startup lookup (at most 15 s) on a busy machine when it has no environment id.
    const timer = setTimeout(() => { if (byId.delete(id)) fail(new Error(`no answer to ${method}; stderr: ${err}`)); }, 30_000);
    byId.set(id, (m) => { clearTimeout(timer); ok(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  // Closing stdin first ends a bridge that runs under its own parent too.
  return { child, rpc, stderr: () => err, stop: () => { child.stdin.end(); child.kill(); } };
}

// ───────────── the bridge ─────────────

test('bridge: the id is taken from a WorkBuddy.exe parent command line in every accepted form', () => {
  const accepted: [string, string][] = [
    ['WorkBuddy.exe', `"C:\\Apps\\WorkBuddy.exe" cli.mjs --acp --session-id ${S1}`],
    ['WorkBuddy.exe', `WorkBuddy.exe cli.mjs --session-id ${S1} --acp --session-id ${S1}`],
    ['WorkBuddy.exe', `WorkBuddy.exe --session-id=${S1} --session-id ${S1}`],
    ['WorkBuddy.exe', `WorkBuddy.exe --session-id "${S1}" --next`],
    ['WorkBuddy.exe', `WorkBuddy.exe --session-id="${S1}"`],
    ['WorkBuddy.exe', `WorkBuddy.exe --session-id\t${S1}`],
    ['WORKBUDDY.EXE', `x --session-id ${S1}`],
    ['workbuddy.exe', `x --session-id ${S1}`],
  ];
  for (const [image, line] of accepted) assert.equal(sessionIdFromParent(image, line), S1, line);
  assert.equal(sessionIdFromParent('WorkBuddy.exe', `x --session-id ${'a'.repeat(128)}`), 'a'.repeat(128), 'the longest allowed');
  assert.equal(sessionIdFromParent('WorkBuddy.exe', `x --session-id-file other --session-id ${S1}`), S1, 'another flag with this prefix is not it');
});

test('bridge: anything else on the parent gives no id', () => {
  const refused: [unknown, unknown][] = [
    ['node.exe', `node.exe --session-id ${S1}`],
    ['WorkBuddy.exe.exe', `x --session-id ${S1}`],
    ['NotWorkBuddy.exe', `x --session-id ${S1}`],
    ['', `x --session-id ${S1}`],
    [undefined, `x --session-id ${S1}`],
    ['WorkBuddy.exe', undefined],
    ['WorkBuddy.exe', ''],
    ['WorkBuddy.exe', 'WorkBuddy.exe cli.mjs --acp'],
    ['WorkBuddy.exe', `x --session-id-file ${S1}`],
    ['WorkBuddy.exe', `x not--session-id ${S1}`],
    ['WorkBuddy.exe', `x --session-id ${S1} --session-id ${S2}`],
    ['WorkBuddy.exe', `x --session-id=${S1} --session-id "${S2}"`],
    ['WorkBuddy.exe', `x --session-id ${S1} --session-id`],
    ['WorkBuddy.exe', `x --prompt "say --session-id ${S2}" --session-id ${S1}`],
    ['WorkBuddy.exe', `x --prompt "a \\" --session-id ${S2} b" --session-id ${S1}`],
    ['WorkBuddy.exe', 'x --session-id'],
    ['WorkBuddy.exe', 'x --session-id '],
    ['WorkBuddy.exe', 'x --session-id='],
    ['WorkBuddy.exe', 'x --session-id "" --next'],
    ['WorkBuddy.exe', 'x --session-id --next'],
    ['WorkBuddy.exe', 'x --session-id --session-id abc'],
    ['WorkBuddy.exe', 'x --session-id a/b'],
    ['WorkBuddy.exe', 'x --session-id a;b'],
    ['WorkBuddy.exe', 'x --session-id "a b"'],
    ['WorkBuddy.exe', 'x --session-id a"b'],
    ['WorkBuddy.exe', 'x --session-id "ab'],
    ['WorkBuddy.exe', 'x --session-id ab"'],
    ['WorkBuddy.exe', 'x "--session-id ab"'],
    ['WorkBuddy.exe', 'x "--session-id=ab"'],
    ['WorkBuddy.exe', 'x "--session-id" "ab"'],
    ['WorkBuddy.exe', 'x --session-id \\"abc\\"'],
    ['WorkBuddy.exe', 'x --session-id é'],
    ['WorkBuddy.exe', `x --session-id ${'a'.repeat(129)}`],
  ];
  for (const [image, line] of refused) assert.equal(sessionIdFromParent(image, line), null, `${image} | ${line}`);
});

test('bridge: the environment id wins and costs no lookup; only without one is the parent asked, once', async () => {
  let lookups = 0;
  const parent = { name: 'WorkBuddy.exe', commandLine: `x --session-id ${S2}` };
  const lookup = async () => { lookups++; return parent; };
  assert.equal(await resolveSessionId(S1, lookup), S1);
  assert.equal(lookups, 0, 'no lookup when the environment names the conversation');
  assert.equal(await resolveSessionId(undefined, lookup), S2);
  assert.equal(await resolveSessionId('', lookup), S2);
  assert.equal(lookups, 2);
  assert.equal(await resolveSessionId(undefined, async () => null), null, 'a failed lookup is no id');
});

test('bridge: the process lookup returns the real image name and the full command line', { skip: process.platform !== 'win32' && 'Windows process table' }, async () => {
  // The flag sits past a long argument: wrapped or cut output would lose it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--filler', 'x'.repeat(2000), '--session-id', S1], { stdio: 'ignore' });
  const exited = new Promise((ok) => child.on('exit', ok));
  try {
    const got = await processInfo(child.pid);
    assert.equal(got.name.toLowerCase(), basename(process.execPath).toLowerCase());
    assert.equal(sessionIdFromParent('WorkBuddy.exe', got.commandLine), S1);
    assert.equal(sessionIdFromParent(got.name, got.commandLine), null, 'its real image name is not WorkBuddy.exe');
  } finally {
    child.kill();
  }
  await exited;
  const gone = await processInfo(child.pid);
  assert.equal(sessionIdFromParent(gone?.name, gone?.commandLine), null, 'a process that is gone gives no id');
});

test('bridge: a parent with --session-id that is not WorkBuddy.exe gives no id, and the Hub is never contacted', async () => {
  let hits = 0;
  const fake = createServer((_req, res) => { hits++; res.writeHead(500, { 'content-type': 'application/json' }).end('{}'); });
  await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok));
  const home = tempDir();
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`, secret: 's' }));
  const b = startBridge({ CODEBUDDY_SESSION_ID: undefined, ORRERY_HOME: home }, ['--session-id', S1]);
  try {
    // Sent at once, before the startup lookup can have finished: they wait for it and are still answered.
    const [init, listed] = await Promise.all([b.rpc('initialize', { protocolVersion: '2025-06-18' }), b.rpc('tools/list')]);
    assert.match(init.result.instructions, /CODEBUDDY_SESSION_ID/);
    assert.deepEqual(listed.result, { tools: [] });
    const refused = await b.rpc('tools/call', { name: 'send_message', arguments: { body: 'x', session_id: S1 } });
    assert.equal(refused.result.isError, true);
    assert.equal(hits, 0, 'no Hub request without an identity');
    assert.ok(!b.stderr().includes(S1), 'the id on the parent command line is not printed');
  } finally {
    b.stop();
    await new Promise<void>((ok) => fake.close(() => ok()));
  }
});

test('bridge: an environment id wins over --session-id on the parent', async () => {
  const app = await wbHub();
  const b = startBridge({ CODEBUDDY_SESSION_ID: S1, ORRERY_HOME: app.home }, ['--session-id', S2]);
  try {
    const { cluster, w1 } = await wbCluster(app);
    const init = await b.rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.instructions, undefined);
    const sent = await b.rpc('tools/call', { name: 'send_message', arguments: { body: 'from W1' } });
    assert.equal(sent.result.isError, undefined, JSON.stringify(sent));
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, w1.id);
  } finally {
    b.stop();
    await done(app);
  }
});

test('bridge: identity is only CODEBUDDY_SESSION_ID from the process environment; one process per conversation', async () => {
  const app = await wbHub();
  const b1 = startBridge({ CODEBUDDY_SESSION_ID: S1, ORRERY_HOME: app.home });
  const b2 = startBridge({ CODEBUDDY_SESSION_ID: S2, ORRERY_HOME: app.home });
  try {
    const { cluster, w1, w2 } = await wbCluster(app);
    const init = await b1.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'WorkBuddy', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'orrery');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.instructions, undefined, 'an id is present');
    const tools = (await b1.rpc('tools/list')).result.tools.map((t: any) => t.name);
    assert.ok(tools.includes('wait_for_messages'), 'a workbuddy caller gets the wait tool');
    assert.ok(tools.includes('send_message'));

    const sent = await b1.rpc('tools/call', { name: 'send_message', arguments: { body: 'from W1' } });
    assert.equal(sent.result.isError, undefined, JSON.stringify(sent));
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, w1.id);
    await b2.rpc('tools/call', { name: 'send_message', arguments: { body: 'from W2' } });
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, w2.id, 'the second process is W2 without any argument saying so');
    const listed = JSON.parse((await b1.rpc('tools/call', { name: 'list_agents', arguments: { session_id: S2, sessionId: S2 } })).result.content[0].text);
    assert.deepEqual(listed.map((m: any) => m.name), ['W1', 'W2'], 'arguments never choose the conversation');
    const got = JSON.parse((await b1.rpc('tools/call', { name: 'wait_for_messages', arguments: {} })).result.content[0].text);
    assert.equal(got.command, waitCommand(ticketFor(app.secret, S1), app.url));
  } finally {
    b1.stop();
    b2.stop();
    await done(app);
  }
});

test('bridge: without CODEBUDDY_SESSION_ID nothing is sent to the Hub and no tool names a conversation', async () => {
  let hits = 0;
  const fake = createServer((_req, res) => { hits++; res.writeHead(500, { 'content-type': 'application/json' }).end('{}'); });
  await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok));
  const home = tempDir();
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: `http://127.0.0.1:${(fake.address() as { port: number }).port}`, secret: 's' }));
  const env: Record<string, string | undefined> = { ...process.env, ORRERY_HOME: home };
  delete env.CODEBUDDY_SESSION_ID;
  const b = startBridge(env);
  const empty = startBridge({ CODEBUDDY_SESSION_ID: '', ORRERY_HOME: home });
  try {
    for (const [name, bridge] of [['missing', b], ['empty', empty]] as const) {
      const init = await bridge.rpc('initialize', { protocolVersion: '2025-06-18' });
      assert.match(init.result.instructions, /CODEBUDDY_SESSION_ID/, name);
      assert.deepEqual((await bridge.rpc('tools/list')).result, { tools: [] }, name);
      const refused = await bridge.rpc('tools/call', { name: 'send_message', arguments: { body: 'x' } });
      assert.equal(refused.result.isError, true, name);
      assert.match(refused.result.content[0].text, /CODEBUDDY_SESSION_ID/, name);
      assert.deepEqual((await bridge.rpc('ping')).result, {}, name);
    }
    assert.equal(hits, 0, 'no Hub request without an identity');
  } finally {
    b.stop();
    empty.stop();
    await new Promise<void>((ok) => fake.close(() => ok()));
  }
});

test('bridge: an environment id that is no member is refused, not joined', async () => {
  const app = await wbHub();
  const b = startBridge({ CODEBUDDY_SESSION_ID: OUTSIDER, ORRERY_HOME: app.home });
  try {
    const { cluster } = await wbCluster(app);
    const count = (await app.messages(cluster.id)).length;
    assert.deepEqual(JSON.parse((await b.rpc('tools/call', { name: 'list_agents', arguments: {} })).result.content[0].text), []);
    for (const name of ['send_message', 'wait_for_messages']) {
      const r = await b.rpc('tools/call', { name, arguments: { body: 'spoof' } });
      assert.equal(r.result.isError, true);
      assert.equal(r.result.content[0].text, '这个对话还不是任何 orrery 集群的成员', name);
    }
    assert.equal((await app.messages(cluster.id)).length, count, 'nothing written');
  } finally {
    b.stop();
    await done(app);
  }
});

// ───────────── the wait route ─────────────

test('workbuddy wait: the real command prints the envelope only, acks, exits; a new wait ends the batch', async () => {
  const app = await wbHub();
  const elsewhere = tempDir();
  writeFileSync(join(elsewhere, 'hub.json'), JSON.stringify({ url: 'http://127.0.0.1:1', secret: 'x' }));
  let wait: ReturnType<typeof runWait> | undefined;
  try {
    const { cluster, w1 } = await wbCluster(app);
    const got = JSON.parse((await call(app, 'wait_for_messages')).content[0].text);
    assert.equal(got.command, waitCommand(ticketFor(app.secret, S1), app.url));
    assert.deepEqual([got.run_in_background, got.description, got.running], [true, 'orrery：等群消息', 0]);
    assert.equal(await openWait(app.url, 'w1.bad').status, 403);
    assert.equal(await openWait(app.url, ticketFor('another secret', S1)).status, 403);

    wait = runWait(elsewhere, ticketFor(app.secret, S1), app.url);
    await waitFor(async () => (await statusOf(app, w1.id)) === 'idle', 'the real command connected', 15_000);
    assert.equal(wait.out(), '', 'silent while waiting: a named harness prints the envelope only');
    const m = await say(app, cluster.id, '@W1 hello "quoted" & | < > ^ % $(x)\nline 2');
    assert.equal(await wait.exited, 0);
    const printed = wait.out();
    assert.ok(printed.includes(`messageId=${m.id}`) && printed.includes('hello "quoted" & | < > ^ % $(x)\nline 2'));
    for (const instruction of ['再运行', '重新运行', 'run_in_background', 'wait.mjs', '处理完']) {
      assert.ok(!printed.includes(instruction), `no "${instruction}" in the envelope`);
    }
    assert.equal(await statusOf(app, w1.id), 'busy', 'in the re-arm grace');
    const second = openWait(app.url, ticketFor(app.secret, S1));
    await second.status;
    await waitFor(async () => (await deliveriesOf(app, cluster.id, w1.id))[0]?.state === 'done', 'the batch is over');
    second.close();
  } finally {
    wait?.child.kill();
    await done(app);
  }
});

test('workbuddy wait: the app not running: a connected wait gets nothing and the delivery ends offline', async () => {
  const app = await wbHub({ running: async () => false });
  try {
    const { cluster, w1 } = await wbCluster(app);
    const wait = openWait(app.url, ticketFor(app.secret, S1));
    assert.equal(await wait.status, 200);
    await say(app, cluster.id, '@W1 to an orphan');
    await waitFor(async () => (await deliveriesOf(app, cluster.id, w1.id))[0]?.state === 'offline', 'nothing delivered, offline');
    assert.equal(wait.events.length, 0);
    assert.equal(await statusOf(app, w1.id), 'offline');
    wait.close();
  } finally {
    await done(app);
  }
});

test('workbuddy wait: no re-arm within the grace: offline, the queue ends offline, NOT_REARMED is shown', async () => {
  const app = await wbHub({ graceMs: 200 });
  try {
    const { cluster, w1 } = await wbCluster(app);
    const ticket = ticketFor(app.secret, S1);
    const wait = openWait(app.url, ticket);
    await waitFor(async () => (await statusOf(app, w1.id)) === 'idle', 'online');
    await say(app, cluster.id, '@W1 one');
    await waitFor(() => wait.events.length, 'delivered');
    assert.deepEqual(await ack(app, S1, wait.events[0].data.deliveryId), { acked: true });
    await say(app, cluster.id, '@W1 two');
    await waitFor(async () => (await deliveriesOf(app, cluster.id, w1.id)).map((d) => d.state).join() === 'done,offline', 'grace over');
    assert.equal(await statusOf(app, w1.id), 'offline');
    assert.ok(app.events.some((e) => e.kind === 'agent' && (e.payload as any).event.message === NOT_REARMED));
    wait.close();
  } finally {
    await done(app);
  }
});
