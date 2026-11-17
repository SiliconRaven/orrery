import { request, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { keepTestTemp, removeTestDir, sleepSync, TEST_TEMP_PREFIX } from '../scripts/test-temp.ts';
import { dbModeOf } from '../src/config.ts';
import { startHub, type StartOptions } from '../src/main.ts';
import { defaultScript, scriptedNative, type MockOptions, type MockScript } from './mock.ts';
import { MOCK_MODEL } from '../src/adapters/mock/native.ts';
import { createMockNativeAdapter, type MockNativeAdapter, type MockNativeOptions } from '../src/adapters/mock/native.ts';
import type { Store } from '../src/core/store.ts';
import type { Cluster, Delivery, HubEvent, Member, Message } from '../src/core/types.ts';

// Test Hubs skip flushing commits to disk (ORRERY_TEST_DB_SYNC, docs/architecture.md): startTestHub reads it here, and
// a Hub a test spawns with { ...process.env } inherits it. Unsafe on power loss, which a test does not care about.
// Tests about durability or the product default pass their own dbMode, or spawn without the variable.
process.env.ORRERY_TEST_DB_SYNC = 'off';

/** The API token of every test Hub (startTestHub's default; tests that call startHub pass it themselves). */
export const TEST_TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';

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

/** A free port that is not the user's 4317. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port === 4317 ? freePort() : port;
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

/** A native mock over two fixture conversations. */
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

export type TestHub = Awaited<ReturnType<typeof startHub>> & {
  dir: string;
  native: MockNativeAdapter;   // the native 'mock' harness (unless nativeAdapters was passed)
  events: HubEvent[];
  api(method: string, path: string, body?: unknown): Promise<any>;
  /** A cluster of empty mock specs with the given member names. */
  cluster(name: string, memberNames: string[]): Promise<{ cluster: Cluster; members: Member[] }>;
  messages(clusterId: string): Promise<{ id: string; deliveries: Delivery[]; [k: string]: any }[]>;
  settled(clusterId: string): Promise<boolean>;
};

export async function startTestHub(
  opts: Partial<StartOptions> & { mock?: MockOptions; native?: MockNativeOptions; dir?: string } = {},
): Promise<TestHub> {
  const dir = opts.dir ?? tempDir();
  let endpoint: { url: string; secret: string } | null = null;
  const native = scriptedNative({ ...fixture(dir), model: MOCK_MODEL, ...opts.mock, ...opts.native }, () => endpoint);
  const app = await startHub({
    dbPath: join(dir, 'test.db'), port: 0, home: join(dir, 'home'),
    apiToken: TEST_TOKEN, dbMode: dbModeOf(process.env), ...opts, nativeAdapters: { mock: native, ...opts.nativeAdapters },
    // No start-up grace unless a test asks for one: an offline native member's deliveries end 'offline' at once.
    // No system-notice wait window either: a busy member still batches everything queued, and the tests that exercise
    // the window pass their own noticeWindowMs. The same for the member-message window (messageWindowMs).
    limits: { startupGraceMs: 0, noticeWindowMs: 0, messageWindowMs: 0, ...opts.limits },
  });
  endpoint = { url: app.url, secret: JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret };
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
    dir, native, events, api, messages,
    cluster: (name: string, memberNames: string[]) =>
      api('POST', '/api/clusters', { name, members: memberNames.map((n) => ({ harness: 'mock', name: n, projectPath: join(dir, 'project-1') })) }),
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

/** A test conversation's real native bridge identity. */
export function nativeHeaders(app: Pick<TestHub, 'home' | 'store'>, memberId: string): Record<string, string> {
  const member = app.store.getMember(memberId, { includeRemoved: true });
  if (!member) throw new Error('unknown test member');
  return {
    'x-orrery-bridge': JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret,
    'x-orrery-harness': member.harness,
    'x-orrery-session': member.workerSessionId,
  };
}
