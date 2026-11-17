import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request, type RequestListener } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { REPO_ROOT } from '../src/main.ts';
import { insertMessageWithEvent, startTestHub, tempDir } from './helpers.ts';

const hook = join(REPO_ROOT, 'plugins', 'unread-hint', 'hook.mjs');
async function run(harness: string, input: unknown, home: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [hook, harness], { env: { ...process.env, ...extraEnv, ORRERY_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const silent = (r: Awaited<ReturnType<typeof run>>, output = '') => assert.deepEqual(r, { code: 0, stdout: output, stderr: '' });

test('Claude and Codex subagent inputs never consume their parent session hint', async () => {
  const dir = tempDir();
  const session = 'parent-session';
  const sessions = [{ id: session, title: session, model: null, cwd: dir, updatedAt: null }];
  const app = await startTestHub({ dir, nativeAdapters: {
    claude: createMockNativeAdapter({ harness: 'claude', sessions }),
    codex: createMockNativeAdapter({ harness: 'codex', sessions }),
  }, limits: { quotaPollMs: 0 } });
  let requests = 0;
  const proxy = await listen((req, res) => {
    requests++;
    const upstream = request(app.url + req.url, { method: req.method, headers: { ...req.headers, host: new URL(app.url).host } }, (reply) => {
      res.writeHead(reply.statusCode ?? 500, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  try {
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const home = tempDir();
    writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: proxy.url, secret }));
    for (const harness of ['claude', 'codex']) {
      const { cluster, members: [member] } = await app.hub.createCluster(harness, [{ harness, mode: 'native', sessionId: session, name: 'A' }]);
      const id = randomUUID();
      insertMessageWithEvent(app.store, { id, clusterId: cluster.id, from: 'user', mentions: [member.id], body: 'private body',
        replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString() });
      const before = requests;
      silent(await run(harness, { session_id: session, agent_id: 'child', agent_type: 'worker' }, home));
      silent(await run(harness, { session_id: session, agent_id: '' }, home));
      assert.equal(requests, before, 'subagents never contact the Hub');
      const parent = await run(harness, { session_id: session, agent_type: 'main' }, home);
      assert.equal(parent.code, 0);
      assert.equal(parent.stderr, '');
      const output = JSON.parse(parent.stdout);
      assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
      assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
      assert.match(output.hookSpecificOutput.additionalContext, /未读 1：点名你 1/);
      assert.doesNotMatch(parent.stdout, /private body/);
      silent(await run(harness, { session_id: session }, home));
      silent(await run(harness, { session_id: session, agent_id: null }, home));
      assert.equal(requests, before + 3, 'only the parent calls contact the Hub; a null agent_id is not a subagent');
    }
  } finally { await proxy.close(); await app.close(); }
});

test('four output shapes and all unavailable-Hub cases are silent', async () => {
  let mode = 'hint';
  const server = await listen((_req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'partial') { res.writeHead(200).write('{'); return; }
    if (mode === 'error') return void res.writeHead(503).end('{}');
    if (mode === 'bad-json') return void res.writeHead(200).end('{');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hint: 'orrery：你有 1 条未读' }));
  });
  try {
    const home = tempDir();
    const configure = (url: string) => writeFileSync(join(home, 'hub.json'), JSON.stringify({ url, secret: 'fake-secret' }));
    configure(server.url);
    for (const harness of ['claude', 'codex', 'zcode', 'antigravity']) {
      const input = harness === 'antigravity' ? { conversationId: 's' } : { session_id: 's' };
      const result = await run(harness, input, home);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      const expected = harness === 'antigravity' ? { injectSteps: [{ ephemeralMessage: 'orrery：你有 1 条未读' }] }
        : harness === 'zcode' ? { additionalContext: 'orrery：你有 1 条未读' }
          : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'orrery：你有 1 条未读' } };
      assert.deepEqual(output, expected);
    }
    for (const unavailable of ['error', 'bad-json', 'timeout', 'partial']) {
      mode = unavailable;
      silent(await run('claude', { session_id: 's' }, home));
      silent(await run('antigravity', { conversationId: 's' }, home), '{}');
    }
    configure('http://example.com:4317');
    silent(await run('codex', { session_id: 's' }, home));
    configure('http://127.0.0.1:1');
    silent(await run('codex', { session_id: 's' }, home));
    silent(await run('claude', '{', home));
    const missing = tempDir();
    silent(await run('codex', { session_id: 's' }, missing));
    silent(await run('antigravity', { conversationId: 's' }, missing), '{}');
    writeFileSync(join(missing, 'hub.json'), '{');
    silent(await run('claude', { session_id: 's' }, missing));
    const unreadable = tempDir();
    mkdirSync(join(unreadable, 'hub.json'));
    silent(await run('codex', { session_id: 's' }, unreadable));
  } finally { await server.close(); }
});

test('localhost discovery bypasses an environment proxy', async () => {
  let intercepted = 0;
  const proxy = await listen((_req, res) => { intercepted++; res.writeHead(502).end(); });
  const hub = await listen((_req, res) => { res.writeHead(200).end(JSON.stringify({ hint: 'orrery：你有 1 条未读' })); });
  try {
    const home = tempDir();
    writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: hub.url.replace('127.0.0.1', 'localhost'), secret: 'fake-secret' }));
    const result = await run('zcode', { session_id: 's' }, home, { HTTP_PROXY: proxy.url, NODE_USE_ENV_PROXY: '1', NO_PROXY: '' });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { additionalContext: 'orrery：你有 1 条未读' });
    assert.equal(intercepted, 0);
  } finally { await proxy.close(); await hub.close(); }
});

test('hook uses only node built-ins, has no configuration writes or network fetch', () => {
  const source = readFileSync(hook, 'utf8');
  assert.ok([...source.matchAll(/^import .* from '([^']+)';$/gm)].every((m) => m[1].startsWith('node:')));
  assert.doesNotMatch(source, /\bfetch\s*\(|writeFile|appendFile|mkdir|permissionDecision|terminationBehavior|\bdecision\s*:/);
});
