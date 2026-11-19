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
import { insertMessageWithEvent, relayRegistry, resignedHeaders, startTestHub, tempDir, writeRegistry } from './helpers.ts';

const hook = join(REPO_ROOT, 'plugins', 'unread-hint', 'hook.mjs');
/** Runs the hook with `registry` as its ORRERY_REGISTRY. */
async function run(harness: string, input: unknown, registry: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [hook, harness], { env: { ...process.env, ORRERY_REGISTRY: registry, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
  // A counting relay: the hook's registry names it; it signs each request again for the Hub.
  const proxy = await listen(async (req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const upstream = request(app.url + req.url, { method: req.method, headers: resignedHeaders(app, req, body) }, (reply) => {
      res.writeHead(reply.statusCode ?? 500, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    upstream.end(body);
  });
  try {
    const home = join(tempDir(), 'registry');
    relayRegistry(app, home, proxy.url);
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
    const home = join(tempDir(), 'registry');
    const configure = (url: string) => writeRegistry(home, url);
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
    writeFileSync(join(missing, 'active.json'), '{');
    silent(await run('claude', { session_id: 's' }, missing));
    const unreadable = tempDir();
    mkdirSync(join(unreadable, 'active.json'));
    silent(await run('codex', { session_id: 's' }, unreadable));
    // A hub.json in ORRERY_HOME is never read without the explicit legacy setting.
    const oldHome = tempDir();
    mkdirSync(oldHome, { recursive: true });
    writeFileSync(join(oldHome, 'hub.json'), JSON.stringify({ url: server.url, secret: 'fake-secret', pid: process.pid }));
    mode = 'hint';
    silent(await run('codex', { session_id: 's' }, missing, { ORRERY_HOME: oldHome }));
  } finally { await server.close(); }
});

test('registry and explicit legacy (localhost) discovery bypass an environment proxy; only the legacy path sends the key', async () => {
  let intercepted = 0;
  const seen: Record<string, unknown>[] = [];
  const proxy = await listen((_req, res) => { intercepted++; res.writeHead(502).end(); });
  const hub = await listen((req, res) => { seen.push(req.headers); res.writeHead(200).end(JSON.stringify({ hint: 'orrery：你有 1 条未读' })); });
  const proxied = { HTTP_PROXY: proxy.url, NODE_USE_ENV_PROXY: '1', NO_PROXY: '' };
  try {
    const registry = join(tempDir(), 'registry');
    const reg = writeRegistry(registry, hub.url);
    const signed = await run('zcode', { session_id: 's' }, registry, proxied);
    assert.deepEqual(signed, { code: 0, stdout: JSON.stringify({ additionalContext: 'orrery：你有 1 条未读' }), stderr: '' });
    assert.equal(seen[0]['x-orrery-bridge'], undefined);
    assert.match(String(seen[0]['x-orrery-sig']), /^v1 /);
    assert.ok(!JSON.stringify(seen).includes(reg.key));

    const oldHome = tempDir();
    writeFileSync(join(oldHome, 'hub.json'), JSON.stringify({ url: hub.url.replace('127.0.0.1', 'localhost'), secret: 'fake-secret', pid: process.pid }));
    const legacy = await run('zcode', { session_id: 's' }, tempDir(), { ...proxied, ORRERY_LEGACY_HUB: oldHome });
    assert.deepEqual(legacy, { code: 0, stdout: JSON.stringify({ additionalContext: 'orrery：你有 1 条未读' }), stderr: '' });
    assert.equal(seen[1]['x-orrery-bridge'], 'fake-secret');
    assert.equal(intercepted, 0);
  } finally { await proxy.close(); await hub.close(); }
});

test('hook uses only node built-ins, has no configuration writes or network fetch', () => {
  const source = readFileSync(hook, 'utf8');
  // Node built-ins and its own copy of the shared discovery module (test/hub-discovery-client.test.ts checks the copy).
  assert.ok([...source.matchAll(/^import .* from '([^']+)';$/gm)].every((m) => m[1].startsWith('node:') || m[1] === './hub-discovery.mjs'));
  assert.doesNotMatch(source, /\bfetch\s*\(|writeFile|appendFile|mkdir|permissionDecision|terminationBehavior|\bdecision\s*:/);
});
