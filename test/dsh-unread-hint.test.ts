// The dsh-orrery plugin's tools/post-execute listener: the Hub's one-line unread hint becomes one additional context
// for the next step, and every failure leaves the tool result exactly as the downstream decision produced it.
// A fake DSH ctx registers the real plugin; a fake Hub speaks only the /bridge/unread-hint contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';
import { tempDir } from './helpers.ts';

const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'dsh-orrery');
const plugin: any = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href);
const S1 = '11111111-1111-4111-8111-111111111111';
const SECRET = 'unread-hint-test-secret';
const HINT = 'orrery：你有 2 条未读（含用户 1 条），方便时用 read_messages 查看';

// ───────────── fake Hub: /bridge/stream fails fast, /bridge/unread-hint follows the mode ─────────────

type Request = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
type Mode = 'hint' | 'empty' | 'error' | 'malformed' | 'destroy' | 'stall' | 'hang';

async function fakeHub() {
  const requests: Request[] = [];
  let mode: Mode = 'empty';
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url?.startsWith('/bridge/stream')) { res.writeHead(404).end(); return; }
      if (req.url !== '/bridge/unread-hint') { res.writeHead(404).end('{"error":"not found"}'); return; }
      if (mode === 'hint') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hint: HINT })); return; }
      if (mode === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
      if (mode === 'error') { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}'); return; }
      if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }).end('not json'); return; }
      if (mode === 'destroy') { req.socket.destroy(); return; }
      if (mode === 'stall') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"hint":'); return; }
      // hang: never answer; the plugin's own time limit must give up.
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, requests,
    setMode(next: Mode) { mode = next; },
    hintRequests: () => requests.filter((r) => r.url === '/bridge/unread-hint'),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

// ───────────── fake DSH: the plugin gets effect, tools.register, on('session/event' | 'tools/post-execute') ─────────────

type PostHandler = (exec: any, result: any, next: () => Promise<any>) => Promise<any>;

function fakeDsh() {
  const listeners = new Map<string, PostHandler[]>();
  const logs: string[] = [];
  const tools = new Map<string, any>();
  let disposers: (() => void)[] = [];
  const ctx = {
    logger: () => ({ info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) }),
    sessionController: { prompt: async () => { throw new Error('this test never delivers'); } },
    on(name: string, handler: PostHandler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    tools: {
      register(def: any) {
        if (tools.has(def.name)) throw new Error(`tool "${def.name}" is already registered`);
        tools.set(def.name, def);
        return () => { tools.delete(def.name); };
      },
    },
    effect(fn: () => () => void) { disposers.push(fn()); },
  };
  return {
    logs, listeners, tools,
    start(home: string, opts: Record<string, unknown> = {}) {
      plugin.start(ctx, { home, retryMs: 60_000, ...opts });
    },
    dispose() {
      for (const dispose of disposers.reverse()) dispose();
      disposers = [];
    },
    /** Runs the registered listener the way DSH's waterfall does. */
    async postExecute(exec: any, result: any) {
      const handler = listeners.get('tools/post-execute')?.[0];
      assert.ok(handler, 'the plugin registered tools/post-execute');
      let nextCalls = 0;
      const out = await handler(exec, result, async () => { nextCalls++; return result; });
      return { out, nextCalls };
    },
    /** Whether the listener swallows a downstream failure. */
    postExecuteThrowingNext(exec: any, result: any) {
      const handler = listeners.get('tools/post-execute')?.[0];
      assert.ok(handler, 'the plugin registered tools/post-execute');
      return handler(exec, result, async () => { throw new Error('downstream failed'); });
    },
  };
}

async function setup(opts: Record<string, unknown> = {}) {
  const hub = await fakeHub();
  const home = tempDir();
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: hub.url, secret: SECRET }));
  const dsh = fakeDsh();
  dsh.start(home, opts);
  return {
    hub, home, dsh,
    async close() { dsh.dispose(); await hub.close(); },
  };
}

const toolResult = () => ({ kind: 'accept', content: [{ type: 'text', text: 'the tool output' }] });
const execOf = (sessionId?: string) => ({ name: 'bash', ...(sessionId === undefined ? {} : { agent: { id: sessionId } }) });

// ───────────── acceptance 1: a hint adds one context; the tool result does not change ─────────────

test('dsh unread hint: a Hub hint becomes one additional user message; the tool result is kept', async () => {
  const { hub, dsh, close } = await setup();
  try {
    hub.setMode('hint');
    const downstreamContext = {
      id: 'downstream-context', role: 'user',
      content: [{ type: 'text', text: 'downstream context' }],
      source: { kind: 'repeat-tool-reminder' },
    };
    const downstream = { ...toolResult(), additionalContexts: [downstreamContext] };
    const { out, nextCalls } = await dsh.postExecute(execOf(S1), downstream);

    assert.equal(nextCalls, 1, 'next() runs once');
    assert.equal(out.kind, 'accept');
    assert.deepEqual(out.content, toolResult().content, 'the tool content is untouched');
    assert.equal(out.additionalContexts.length, 2, 'exactly one hint plus the downstream context');
    const [context] = out.additionalContexts;
    assert.equal(context.role, 'user');
    assert.match(context.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(context.content, [{ type: 'text', text: HINT }], 'one text block, the Hub line verbatim');
    assert.doesNotMatch(context.content[0].text, /\n/, 'one line');
    assert.deepEqual(context.source, { kind: 'dsh-orrery', form: 'notice', summary: 'orrery unread hint' });
    assert.notEqual(context.source.kind, 'plugin', 'session format v4 refuses the retired plugin source kind');
    assert.equal(out.additionalContexts[1], downstreamContext, 'downstream contexts survive in order');
    assert.ok(!context.content[0].text.includes(SECRET), 'the bridge secret is not in the hint');

    const [request] = hub.hintRequests();
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-orrery-bridge'], SECRET);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { harness: 'deepseek', session: S1 });
    assert.ok(!dsh.logs.some((line) => line.includes(SECRET)), 'the secret is never logged');
  } finally { await close(); }
});

test('dsh unread hint: an empty answer and a tool call without a session add nothing', async () => {
  const { hub, dsh, close } = await setup();
  try {
    hub.setMode('empty');
    const downstream = toolResult();
    const empty = await dsh.postExecute(execOf(S1), downstream);
    assert.equal(empty.out, downstream, 'the downstream decision is returned unchanged');
    assert.equal(empty.nextCalls, 1);

    const noSession = await dsh.postExecute(execOf(), downstream);
    assert.equal(noSession.out, downstream);
    assert.equal(hub.hintRequests().length, 1, 'no Hub request without a session id');
  } finally { await close(); }
});

// ───────────── acceptance 1: empty / unreachable / throwing all go to next() unchanged ─────────────

test('dsh unread hint: a 500, bad JSON, a dropped or stalled connection, or a timeout still return next() unchanged', async () => {
  const { hub, dsh, close } = await setup({ hintTimeoutMs: 50 });
  try {
    const downstream = toolResult();
    for (const mode of ['error', 'malformed', 'destroy', 'stall', 'hang'] as const) {
      hub.setMode(mode);
      const started = Date.now();
      const { out, nextCalls } = await dsh.postExecute(execOf(S1), downstream);
      assert.equal(out, downstream, `${mode}: the downstream decision is returned unchanged`);
      assert.equal(nextCalls, 1, `${mode}: next() is not skipped`);
      assert.ok(Date.now() - started < 1500, `${mode}: the hint time limit is short`);
    }
    assert.ok(!dsh.logs.some((line) => /hint|unread/i.test(line)), 'failures are silent');
  } finally { await close(); }
});

test('dsh unread hint: no hub.json and a closed Hub port are silent and change nothing', async () => {
  const downstream = toolResult();

  const noHub = fakeDsh();
  noHub.start(tempDir());
  try {
    assert.equal((await noHub.postExecute(execOf(S1), downstream)).out, downstream);
  } finally { noHub.dispose(); }

  // A port that was listening and is now closed: the request gets ECONNREFUSED.
  const closed = createServer();
  await new Promise<void>((ok) => closed.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((ok) => closed.close(() => ok()));
  const home = tempDir();
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url, secret: SECRET }));
  const dsh = fakeDsh();
  dsh.start(home);
  try {
    const { out, nextCalls } = await dsh.postExecute(execOf(S1), downstream);
    assert.equal(out, downstream);
    assert.equal(nextCalls, 1);
    assert.deepEqual(dsh.logs.filter((line) => /hint|unread/i.test(line)), []);
  } finally { dsh.dispose(); }
});

// ───────────── decisions, failures and cleanup ─────────────

test('dsh unread hint: a block decision keeps its feedback and gains the hint first', async () => {
  const { hub, dsh, close } = await setup();
  try {
    hub.setMode('hint');
    const feedback = [{ type: 'text', text: 'corrective feedback' }];
    const { out } = await dsh.postExecute(execOf(S1), { kind: 'block', feedback });
    assert.equal(out.kind, 'block');
    assert.equal(out.feedback, feedback);
    assert.equal(out.additionalContexts.length, 1);
    assert.deepEqual(out.additionalContexts[0].content, [{ type: 'text', text: HINT }]);
  } finally { await close(); }
});

test('dsh unread hint: a throwing downstream is not swallowed; disposal unregisters the listener', async () => {
  const { hub, dsh, close } = await setup();
  try {
    hub.setMode('hint');
    await assert.rejects(dsh.postExecuteThrowingNext(execOf(S1), toolResult()), /downstream failed/);
    dsh.dispose();
    assert.equal(dsh.listeners.get('tools/post-execute')?.length ?? 0, 0, 'the hook is removed with the plugin');
  } finally { await close(); }
});
