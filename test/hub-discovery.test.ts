import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createZcodeNativeAdapter } from '../src/adapters/zcode/native.ts';
import { signBridgeRequest } from '../src/bridge-protocol.ts';
import { ZCODE_WAIT } from '../src/core/types.ts';
import { registeredHubOnPort } from '../src/hub-registry.ts';
import { ticketFor } from '../src/mcp/wait-core.ts';
import { hubSecret, startTestHub, tempDir, TEST_HUB_ID, TEST_TOKEN, waitFor, withFreePort } from './helpers.ts';

const whoami = '/bridge/whoami';
const keyA = '1'.repeat(64);
const keyB = '2'.repeat(64);
const jsonFile = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const portOf = (url: string) => Number(url.split(':').at(-1));

test('v1 canonical form agrees with the published client vector', () => {
  const target = { hubId: TEST_HUB_ID, claim: '0'.repeat(32), url: 'http://127.0.0.1:1234' };
  const signature = signBridgeRequest(keyA, target, 'GET', whoami, new Map(), Buffer.alloc(0), '1795090000000', 'a'.repeat(32));
  assert.equal(signature.split(' ').at(-1), '5b0aa96dcf183daaf5af47e8e1cd839be55aba9087430c0b4f52d8084462cb7d');
});

function http(url: string, path: string, headers: string[], method = 'GET', body?: string, host = url.slice(7)) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: portOf(url), path, method,
      headers: ['Host', host, ...headers], agent: false }, (res) => {
      let raw = '';
      res.setEncoding('utf8').on('data', (chunk) => { raw += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, data: raw ? JSON.parse(raw) : undefined }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('shared registry: first key, one active Hub, secondary settings and Hub-scoped tickets', async () => {
  const root = tempDir();
  const registryDir = join(root, 'registry');
  const aDir = join(root, 'a'), bDir = join(root, 'b');
  for (const [dir, key] of [[aDir, keyA], [bDir, keyB]]) {
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'home', 'secret'), key + '\n', { mode: 0o600 });
  }
  const a = await startTestHub({ dir: aDir, registryDir, name: 'Daily' });
  const b = await startTestHub({ dir: bDir, registryDir, name: 'Second',
    nativeAdapters: { zcode: createZcodeNativeAdapter({ zcodeRunning: async () => false }) } });
  try {
    assert.equal(a.registry.role, 'active');
    assert.equal(b.registry.role, 'secondary');
    assert.equal(hubSecret(b.home), keyA);
    assert.equal(readFileSync(join(registryDir, 'bridge-secret'), 'utf8').trim(), keyA);
    assert.equal(readFileSync(join(b.home, 'secret'), 'utf8').trim(), keyA);
    assert.equal(existsSync(join(b.home, 'secret.prev')), false);
    for (const record of [a.registry, b.registry]) {
      assert.deepEqual(jsonFile(join(registryDir, 'hubs', record.hubId + '.json')), record);
      assert.ok(!JSON.stringify(record).includes(keyA));
    }
    assert.deepEqual(await registeredHubOnPort(registryDir, portOf(a.url)), a.registry);
    assert.equal(await registeredHubOnPort(registryDir, portOf(b.url)), undefined);

    const before = await b.api('GET', '/api/bridge-settings');
    assert.deepEqual(before, { role: 'secondary', allowLegacy: true, nativeDelivery: false, keyMigrated: true });
    const { cluster } = await b.cluster('secondary fixture', ['worker']);
    await b.api('POST', '/api/clusters/' + cluster.id + '/messages', { body: '@worker stay local' });
    assert.equal((await b.messages(cluster.id)).at(-1)!.deliveries[0].state, 'offline');
    assert.equal(b.hub.listMembers(cluster.id)[0].status, 'offline');
    assert.equal(b.hub.listMembers(cluster.id)[0].deliveryDisabled, 'secondary');
    await assert.rejects(() => b.api('PATCH', '/api/bridge-settings', { nativeDelivery: true }), /confirm/);
    await b.api('PATCH', '/api/bridge-settings', { nativeDelivery: true, confirmed: true });
    await b.api('POST', '/api/clusters/' + cluster.id + '/messages', { body: '@worker explicitly enabled' });
    await waitFor(async () => (await b.messages(cluster.id)).some((m) =>
      m.deliveries.some((d) => d.state === 'done')), 'opt-in permits native delivery');

    const crossed = ticketFor(ZCODE_WAIT, keyA, 'fixture-session', a.registry.hubId);
    const oldTag = createHmac('sha256', keyA).update('orrery-zcode-wait\nfixture-session').digest('hex');
    for (const ticket of [crossed, 'z1.fixture-session.' + oldTag]) {
      assert.equal((await http(b.url, '/bridge/zcode-wait', ['x-orrery-ticket', ticket])).status, 403);
      assert.equal((await http(b.url, '/bridge/zcode-ack', ['content-type', 'application/json'], 'POST',
        JSON.stringify({ ticket, deliveryId: 'example' }))).status, 403);
    }
    await b.close();
    assert.equal(jsonFile(join(registryDir, 'active.json')).claim, a.registry.claim);
    assert.equal(existsSync(join(registryDir, 'hubs', b.registry.hubId + '.json')), false);
  } finally {
    await b.close();
    await a.close();
  }
  assert.equal(existsSync(join(registryDir, 'active.json')), false);
  writeFileSync(join(registryDir, 'bridge-secret'), 'malformed');
  await assert.rejects(startTestHub({ registryDir }), /Invalid Orrery registry key/);
});

test('normal lock serializes concurrent starts; a living but unresponsive record remains active', async () => {
  const registryDir = join(tempDir(), 'registry');
  const [a, b] = await Promise.all([startTestHub({ registryDir }), startTestHub({ registryDir })]);
  try {
    assert.deepEqual([a.registry.role, b.registry.role].sort(), ['active', 'secondary']);
    assert.equal(hubSecret(a.home), hubSecret(b.home));
  } finally { await Promise.all([a.close(), b.close()]); }

  const idle = createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((done) => idle.listen(0, '127.0.0.1', done));
  const addr = idle.address() as { port: number };
  const stale = { version: 1, role: 'active', hubId: TEST_HUB_ID, claim: 'f'.repeat(32), url: 'http://127.0.0.1:' + addr.port,
    pid: process.pid, name: 'Waiting fixture', home: tempDir(), startedAt: new Date().toISOString() };
  writeFileSync(join(registryDir, 'active.json'), JSON.stringify(stale));
  try {
    const c = await startTestHub({ registryDir });
    try {
      assert.equal(c.registry.role, 'secondary');
      assert.equal(jsonFile(join(registryDir, 'active.json')).claim, stale.claim);
    } finally { await c.close(); }
  } finally { await new Promise<void>((done) => idle.close(() => done())); }
  const d = await startTestHub({ registryDir });
  try { assert.equal(d.registry.role, 'active', 'a refused socket permits recovery even if the PID has been reused'); }
  finally { await d.close(); }
});

test('signed MCP: binds every identity field and exact body before posting; rejects wrong target and replay', async () => {
  const a = await startTestHub();
  try {
    const { cluster, members } = await a.cluster('signed fixture', ['alpha', 'beta']);
    const secret = hubSecret(a.home);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'send_message', arguments: { clusterId: cluster.id, body: 'signed message' } } });
    const headers = { 'x-orrery-harness': 'mock', 'x-orrery-session': members[0].workerSessionId, 'x-orrery-fixture': 'audit' };
    const path = '/mcp';
    const sign = (target = a.registry, route = path, ts?: string) =>
      signBridgeRequest(secret, target, 'POST', route, new Map(Object.entries(headers)), Buffer.from(body), ts);
    const send = (sig: string, fields = Object.entries(headers).flat(), raw = body, route = path) =>
      http(a.url, route, ['x-orrery-sig', sig, 'Content-Type', 'application/json',
        'Accept', 'application/json, text/event-stream', ...fields], 'POST', raw);
    for (const name of Object.keys(headers)) {
      const altered = Object.entries({ ...headers, [name]: 'wrong' }).flat();
      assert.deepEqual(await send(sign(), altered), { status: 401, data: { error: 'unauthorized', reason: 'mac' } });
      assert.equal((await send(sign(), [...Object.entries(headers).flat(), name, 'duplicate'])).status, 401);
    }
    assert.equal((await send(sign(), Object.entries(headers).flat(), body.replace('signed message', 'changed'))).data.reason, 'mac');
    assert.equal((await send(sign(), Object.entries(headers).flat(), body, '/mcp?x=1')).data.reason, 'mac');
    assert.equal((await send(sign(a.registry, '/mcp?x=1&x=2'), Object.entries(headers).flat(), body, '/mcp?x=1&x=2')).data.reason, 'mac');
    assert.equal((await send(sign({ ...a.registry, hubId: TEST_HUB_ID }))).data.reason, 'claim');
    assert.equal((await send(sign({ ...a.registry, url: 'http://127.0.0.1:1' }))).data.reason, 'mac');
    assert.equal((await send(sign(a.registry, path, String(Date.now() - 61_000)))).data.reason, 'expired');
    assert.equal((await a.messages(cluster.id)).length, 0);
    const once = sign();
    assert.equal((await send(once)).status, 200);
    assert.equal((await a.messages(cluster.id)).at(-1)!.from, members[0].id);
    assert.equal((await send(once)).data.reason, 'replay');
    assert.equal((await a.messages(cluster.id)).length, 1);
    const probe = signBridgeRequest(secret, a.registry, 'GET', whoami);
    const wrongHost = await http(a.url, whoami, ['x-orrery-sig', probe], 'GET', undefined, 'localhost:' + portOf(a.url));
    assert.equal(wrongHost.data.reason, 'host');
  } finally { await a.close(); }
});

test('claim refresh, explicit key reveal and persistent legacy compatibility setting', async () => {
  const dir = tempDir();
  const a = await startTestHub({ dir });
  const key = hubSecret(a.home);
  const old = signBridgeRequest(key, a.registry, 'GET', whoami);
  try {
    const legacy = ['x-orrery-bridge', key];
    assert.equal((await http(a.url, whoami, legacy)).status, 401);
    assert.equal((await http(a.url, '/bridge/not-a-route', legacy)).status, 404, 'plain is allowed by default');
    assert.equal((await fetch(a.url + '/api/bridge-settings/reveal', { method: 'POST', headers: {
      authorization: 'Bearer invalid', 'content-type': 'application/json',
    }, body: '{}' })).status, 401);
    const revealed = await fetch(a.url + '/api/bridge-settings/reveal', { method: 'POST', headers: {
      authorization: 'Bearer ' + TEST_TOKEN, 'content-type': 'application/json',
    }, body: '{}' });
    assert.equal(revealed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await revealed.json(), { key });
    assert.ok(!JSON.stringify(await a.api('GET', '/api/bridge-settings')).includes(key));
    await a.api('PATCH', '/api/bridge-settings', { allowLegacy: false });
    assert.equal((await http(a.url, '/bridge/not-a-route', legacy)).status, 401);
    assert.equal((await http(a.url, whoami, ['x-orrery-sig', old])).status, 200);
  } finally { await a.close(); }
  const b = await startTestHub({ dir });
  try {
    assert.equal(b.registry.hubId, a.registry.hubId);
    assert.notEqual(b.registry.claim, a.registry.claim);
    assert.equal((await http(b.url, whoami, ['x-orrery-sig', old])).data.reason, 'claim');
    assert.equal((await b.api('GET', '/api/bridge-settings')).allowLegacy, false);
    assert.equal((await http(b.url, whoami, ['x-orrery-sig', signBridgeRequest(key, b.registry, 'GET', whoami)])).status, 200);
  } finally { await b.close(); }
});

test('registering does not block the event loop: while the Windows ACL checks run, the Hub answers 503 "hub is starting"',
  { skip: process.platform !== 'win32' && 'the ACL checks (PowerShell) run on Windows only' }, async () => {
    await withFreePort(async (port) => {
      let ready = false;
      const starting = startTestHub({ port }).finally(() => { ready = true; });
      const answers: number[] = [];
      // Same process as the Hub: with a synchronous ACL check this loop could not run until registration ended.
      while (!ready) {
        try { answers.push((await fetch(`http://127.0.0.1:${port}/api/health`)).status); } catch { /* not listening yet */ }
        await new Promise((ok) => setTimeout(ok, 20));
      }
      const app = await starting;
      try {
        assert.ok(answers.filter((s) => s === 503).length >= 2, `503 answers while registering: ${answers.join(',')}`);
      } finally { await app.close(); }
    });
  });
