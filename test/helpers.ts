import { request, type IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { keepTestTemp, removeTestDir, sleepSync, TEST_TEMP_PREFIX } from '../scripts/test-temp.ts';
import { signBridgeRequest } from '../src/bridge-protocol.ts';
import { dbModeOf } from '../src/config.ts';
import { listenLoopback, startHub, type StartOptions } from '../src/main.ts';
import { createMockNativeAdapter, MOCK_MODEL, type MockNativeAdapter, type MockNativeOptions } from '../src/adapters/mock/native.ts';
import type { Store } from '../src/core/store.ts';
import type { Cluster, Delivery, HubEvent, Member, Message } from '../src/core/types.ts';
import { defaultScript, scriptedNative, type MockOptions, type MockScript } from './mock.ts';

// Test Hubs skip flushing commits to disk (ORRERY_TEST_DB_SYNC, docs/architecture.md): startTestHub reads it here, and
// a Hub a test spawns with { ...process.env } inherits it. Unsafe on power loss, which a test does not care about.
// Tests about durability or the product default pass their own dbMode, or spawn without the variable.
process.env.ORRERY_TEST_DB_SYNC = 'off';
process.env.ORRERY_UPDATE_CHECKS = '0';

/** The API token of every test Hub (startTestHub's default; tests that call startHub pass it themselves). */
export const TEST_TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
export const TEST_HUB_ID = '52778aa6-f402-4340-886a-483986a64804';

/** fetch as Node has it, with no token added: for tests of the token check itself. */
export const rawFetch = globalThis.fetch;

// Test files call fetch(<hub>/api/...) everywhere: this adds TEST_TOKEN to a loopback /api/ request that carries no
// Authorization and no Cookie of its own, so those call sites stay as they are.
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? URL.parse(input) : null;
  const headers = new Headers(init?.headers);
  if (url?.hostname === '127.0.0.1' && url.pathname.startsWith('/api/') && !headers.has('authorization') && !headers.has('cookie')) {
    headers.set('authorization', `Bearer ${TEST_TOKEN}`);
    return rawFetch(input, { ...init, headers });
  }
  return rawFetch(input, init);
};

/** The closest directory at or above `dir` holding a `.git` entry (a folder, or a file in a worktree), or null. */
function gitRootOf(dir: string): string | null {
  // shortcut: any ".git" counts, even one Git would reject; ask git rev-parse (one spawn per call) if that ever misfires.
  for (let d = realpathSync(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

/** Every directory tempDir() made in this process; removed when the process exits (see removeCreatedTemp). */
const createdTemp: string[] = [];

/**
 * Best effort at process exit: deletes this process's tempDir() directories through removeTestDir's guards, with a
 * few short retries for files a just-exited child still held. Never throws, so it cannot change the exit code. A
 * directory still in use (a database this process left open: Windows refuses to delete it) stays for the age-based
 * sweep at the start of the next `npm test`. ORRERY_KEEP_TEST_TEMP=1 keeps everything.
 */
function removeCreatedTemp(): void {
  try {
    if (keepTestTemp()) return;
    let pending = createdTemp.splice(0);
    for (let attempt = 0; pending.length > 0 && attempt < 3; attempt++) {
      if (attempt > 0) sleepSync(50 * attempt);
      pending = pending.filter((dir) => {
        try { removeTestDir(dirname(dir), basename(dir)); return false; } catch { return true; }
      });
    }
  } catch { /* cleanup must never fail a test run */ }
}

export function tempDir(): string {
  const root = gitRootOf(tmpdir());
  if (root) {
    throw new Error(`test temp directory ${tmpdir()} is inside the Git repository ${root}: point TEMP/TMP/TMPDIR outside any repository, `
      + 'or project grouping treats every simulated project as that one repository and tests fail misleadingly');
  }
  const dir = mkdtempSync(join(tmpdir(), TEST_TEMP_PREFIX));
  if (createdTemp.push(dir) === 1) process.once('exit', removeCreatedTemp);
  return dir;
}

// Children launched directly by tests inherit a private registry, never the user's registry.
process.env.ORRERY_REGISTRY = join(tempDir(), 'registry');

/**
 * Seeds a message and its 'message' event in one transaction, with the payload Hub.post writes. A bare
 * store.insertMessage has no event: a member page's delivery lines and an SSE replay from an earlier seq miss it,
 * which looks like a page bug. Subscribers are not told (only the Hub does that): a page sees the message when it
 * reads the cluster's messages, or an SSE stream from an earlier seq replays the event.
 */
export function insertMessageWithEvent(store: Store, message: Message, recipientIds: string[] = []): { deliveries: Delivery[]; event: HubEvent } {
  return store.transaction(() => {
    const deliveries = store.insertMessage(message, recipientIds);
    const payload = { message: { ...message, ...store.pluginFields(message.id) }, deliveries };
    return { deliveries, event: store.appendEvent(message.clusterId, null, 'message', payload) };
  });
}

const addrInUse = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EADDRINUSE';

/**
 * A free loopback port that is not the user's 4317. The socket is closed before return, so something else can take
 * it before the caller binds: bind at once, or use withFreePort / retryAddrInUse when the bind can lose that race.
 */
export async function freePort(): Promise<number> {
  const s = createServer();
  try {
    return await listenLoopback(s, 0);
  } finally {
    if (s.listening) await new Promise<void>((ok) => s.close(() => ok()));
  }
}

/** Call `run` with a port reserved immediately beforehand. EADDRINUSE tries another port, up to `attempts` times. */
export async function withFreePort<T>(run: (port: number) => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = await freePort();
    try {
      return await run(port);
    } catch (error) {
      last = error;
      if (!addrInUse(error)) throw error;
    }
  }
  throw last;
}

/** Repeat `run` when a port it already chose was taken. Any other error propagates on the first attempt. */
export async function retryAddrInUse<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (!addrInUse(error)) throw error;
      await sleep(20 * (i + 1));
    }
  }
  throw last;
}

/** One project holding two existing sessions (s1, s2), and an empty second project. */
function fixture(dir: string) {
  const p1 = join(dir, 'project-1');
  const p2 = join(dir, 'project-2');
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  return {
    projects: [{ path: p1, label: 'project-1', updatedAt: null }, { path: p2, label: 'project-2', updatedAt: null }],
    sessions: [
      { id: 's1', title: 'old chat 1', model: MOCK_MODEL, cwd: p1, updatedAt: null },
      { id: 's2', title: 'old chat 2', model: MOCK_MODEL, cwd: p1, updatedAt: null },
    ],
  };
}

/** A plain native mock ('queue' kind: always online, completes, no script) over the fixture, so s1 and s2 can be attached. */
export function fixtureNativeMock(dir: string, opts: MockNativeOptions = {}): MockNativeAdapter {
  return createMockNativeAdapter({ ...fixture(dir), model: MOCK_MODEL, ...opts });
}

/** A script whose turns on a message "hold" stay open until release() (or abort); other messages run defaultScript. */
export function holdScript(): { script: MockScript; release: () => void } {
  const gate = Promise.withResolvers<void>();
  const script: MockScript = (msg, tools, emit, signal) => {
    // Leading @mentions only address the member, as in the default script.
    if (msg.body.replace(/^(@\S+\s+)+/, '') !== 'hold') return defaultScript(msg, tools, emit, signal);
    signal.addEventListener('abort', () => gate.resolve(), { once: true });
    return gate.promise;
  };
  return { script, release: () => gate.resolve() };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

/** HTTP status of an MCP initialize request to the Hub with these headers (200 accepted, 401 rejected). */
export async function mcpStatus(url: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: INITIALIZE,
  });
  await res.body?.cancel();
  return res.status;
}

/** Read JSON SSE frames on the real test Hub's HTTP stream. */
export function openSse(url: string, headers: Record<string, string>) {
  const events: { event: string; data: any }[] = [];
  let response: IncomingMessage | undefined;
  const status = Promise.withResolvers<number>();
  const ended = Promise.withResolvers<void>();
  const req = request(url, { headers }, (res) => {
    response = res;
    status.resolve(res.statusCode!);
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    });
    res.on('close', () => ended.resolve());
  });
  req.on('error', () => { status.resolve(0); ended.resolve(); });
  req.end();
  return { events, status: status.promise, ended: ended.promise, close: () => { response?.destroy(); req.destroy(); } };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The MCP headers a test member's own bridge would send: the bridge secret and its conversation (harness, session). */
export function memberHeaders(app: Pick<TestHub, 'home' | 'store'>, memberId: string): Record<string, string> {
  const member = app.store.getMember(memberId, { includeRemoved: true });
  if (!member) throw new Error(`unknown test member ${memberId}`);
  return { 'x-orrery-bridge': hubSecret(app.home), 'x-orrery-harness': member.harness, 'x-orrery-session': member.workerSessionId };
}

/** How many deliveries the test Hub's mock harness was handed for this member's conversation (each one a turn). */
export function turnsOf(app: Pick<TestHub, 'native' | 'store'>, memberId: string): number {
  const session = app.store.getMember(memberId, { includeRemoved: true })?.workerSessionId;
  return app.native.delivered.filter((d) => d.sessionId === session).length;
}

/** The bridge secret of a test Hub, from its discovery file. */
export function hubSecret(home: string): string {
  return JSON.parse(readFileSync(join(home, 'hub.json'), 'utf8')).secret;
}

/**
 * A registry for plug-in tests (docs/hub-discovery.md 3): active.json and hubs/<hubId>.json naming `url` (a fake Hub or a
 * proxy), and the shared key. The record is alive (this test process's pid) unless `pid` says otherwise.
 */
export function writeRegistry(dir: string, url: string, opts: { key?: string; hubId?: string; claim?: string; pid?: number;
  name?: string; active?: boolean } = {}) {
  const record = { version: 1, hubId: opts.hubId ?? randomUUID(), name: opts.name ?? 'Test Hub', url, pid: opts.pid ?? process.pid,
    home: join(dir, 'home'), role: 'active', claim: opts.claim ?? randomBytes(16).toString('hex'), startedAt: new Date().toISOString() };
  const key = opts.key ?? randomBytes(32).toString('hex');
  mkdirSync(join(dir, 'hubs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'bridge-secret'), `${key}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'hubs', `${record.hubId}.json`), JSON.stringify(record));
  if (opts.active !== false) writeFileSync(join(dir, 'active.json'), JSON.stringify(record));
  return { ...record, key, dir };
}

/**
 * For a test relay in front of a test Hub (to record or drop traffic): the plug-ins' registry names the relay, with the
 * Hub's key, and resignedHeaders() turns each request the relay received into one the Hub accepts (a signature binds
 * one address and one Hub start, so a relay that only forwards would be refused).
 */
export const relayRegistry = (app: Pick<TestHub, 'home'>, registryDir: string, relayUrl: string) =>
  writeRegistry(registryDir, relayUrl, { key: hubSecret(app.home), name: 'Test relay' });

export function resignedHeaders(app: Pick<TestHub, 'home' | 'registry' | 'url'>, req: IncomingMessage, body: Buffer): Record<string, string> {
  const own = Object.entries(req.headers).filter(([k]) => k.startsWith('x-orrery-') && k !== 'x-orrery-sig') as [string, string][];
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'x-orrery-sig')) as Record<string, string>;
  return { ...headers, host: app.url.slice(7),
    'x-orrery-sig': signBridgeRequest(hubSecret(app.home), app.registry, req.method!, req.url!, new Map(own), body) };
}

/** The environment a plug-in started by a test needs to find this test Hub: its registry, never the account's. */
export const registryEnv = (app: Pick<TestHub, 'registryDir'>) => ({ ORRERY_REGISTRY: app.registryDir });

export type TestHub = Awaited<ReturnType<typeof startHub>> & {
  dir: string;
  /** The test Hub's own registry (ORRERY_REGISTRY for the plug-ins a test starts). */
  registryDir: string;
  /** A project folder (empty at start) for new mock conversations: a new conversation must name its project. */
  project: string;
  /** The adapter registered as the 'mock' harness: the scripted mock (test/mock.ts), or the test's own opts.nativeAdapters.mock. */
  native: MockNativeAdapter;
  events: HubEvent[];
  api(method: string, path: string, body?: unknown): Promise<any>;
  /** A cluster of new mock conversations in `project`, with the given member names. */
  cluster(name: string, memberNames: string[]): Promise<{ cluster: Cluster; members: Member[] }>;
  messages(clusterId: string): Promise<{ id: string; deliveries: Delivery[]; [k: string]: any }[]>;
  settled(clusterId: string): Promise<boolean>;
};

export async function startTestHub(
  opts: Partial<StartOptions> & { mock?: MockOptions; dir?: string } = {},
): Promise<TestHub> {
  const dir = opts.dir ?? tempDir();
  const registryDir = opts.registryDir ?? join(dir, 'registry');
  // The scripted mock answers through the Hub's MCP endpoint, known once the Hub listens (a turn before that waits a tick).
  let endpoint: { url: string; secret: string } | null = null;
  const native = scriptedNative({ ...fixture(dir), model: MOCK_MODEL, ...opts.mock }, () => endpoint);
  const app = await startHub({
    dbPath: join(dir, 'test.db'), home: join(dir, 'home'),
    registryDir,
    apiToken: TEST_TOKEN, dbMode: dbModeOf(process.env), ...opts,
    // After ...opts, so a caller that omits port keeps the atomic bind (opts.port from freePort() used to win, then lose the race).
    port: opts.port ?? 0,
    nativeAdapters: { mock: native, ...opts.nativeAdapters },
    // No start-up grace unless a test asks for one: an offline native member's deliveries end 'offline' at once.
    // No system-notice wait window either: a busy member still batches everything queued, and the tests that exercise
    // the window pass their own noticeWindowMs. The same for the member-message window (messageWindowMs).
    limits: { startupGraceMs: 0, noticeWindowMs: 0, messageWindowMs: 0, ...opts.limits },
  });
  endpoint = { url: app.url, secret: hubSecret(app.home) };
  const project = join(dir, 'work');
  mkdirSync(project, { recursive: true });
  const events: HubEvent[] = [];
  app.hub.subscribe((e) => events.push(e));
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(app.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  const messages = (clusterId: string): ReturnType<TestHub["messages"]> => api('GET', `/api/clusters/${clusterId}/messages`);
  return Object.assign(app, {
    // The adapter the Hub really uses: a test's own 'mock' replaces the scripted one, so assertions on app.native see its calls.
    dir, registryDir, project, native: (opts.nativeAdapters?.mock ?? native) as MockNativeAdapter, events, api, messages,
    cluster: (name: string, memberNames: string[]) =>
      api('POST', '/api/clusters', { name, members: memberNames.map((n) => ({ harness: 'mock', mode: 'native', name: n, projectPath: project })) }),
    settled: async (clusterId: string) => {
      const msgs = await messages(clusterId);
      return msgs.length > 0 && msgs.every((m) => m.deliveries.every((d) => ['done', 'failed', 'offline', 'superseded'].includes(d.state)));
    },
  });
}

export async function waitFor<T>(fn: () => T | Promise<T>, what = 'condition', timeoutMs = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
