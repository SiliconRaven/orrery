// The plug-ins' side of Hub discovery (plugins/shared/hub-discovery.mjs, docs/hub-discovery.md 3-6): which Hub is
// chosen, that only a signature goes on the wire, when nothing is sent, the explicit legacy fallback, the one claim
// retry, and that every plug-in's copy is the same file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { callOutcome, findHub, HubError, hubFetch, hubStream, readBridgeKey, signRequest } from '../plugins/shared/hub-discovery.mjs';
import { bridgeMac } from '../src/bridge-protocol.ts';
import { REPO_ROOT } from '../src/main.ts';
import { hubSecret, startTestHub, tempDir, TEST_HUB_ID, writeRegistry } from './helpers.ts';

const SOURCE = join(REPO_ROOT, 'plugins', 'shared', 'hub-discovery.mjs');
/** Every plug-in that is installed by copying, or must stay self-contained, carries this file next to its own. */
const COPIES = ['dsh-orrery/lib', 'cursor-orrery/lib', 'qoder-orrery', 'antigravity-orrery', 'unread-hint', 'zcode-orrery']
  .map((dir) => join(REPO_ROOT, 'plugins', dir, 'hub-discovery.mjs'));

/** A dead pid: a process that has exited (spawned and awaited). */
async function deadPid(): Promise<number> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((ok) => child.on('exit', ok));
  return child.pid!;
}

/** A fake Hub recording every request (headers and body); `answer` decides the response. */
async function fakeHub(answer: (req: IncomingMessage, body: string, res: ServerResponse) => void = (_q, _b, res) => res.writeHead(200).end('{}')) {
  const seen: { method: string; url: string; headers: IncomingMessage['headers']; raw: string[]; body: string }[] = [];
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, raw: req.rawHeaders, body });
    answer(req, body, res);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen,
    close: () => { srv.closeAllConnections(); return new Promise((ok) => srv.close(ok)); },
  };
}

const notSent = (e: unknown) => e instanceof HubError && e.kind === 'not-sent' && /^接入件没有发送请求：/.test(e.message);

test('client signature agrees with the Hub (published vector) and covers every x-orrery header and the body', () => {
  const target = { mode: 'signed' as const, hubId: TEST_HUB_ID, claim: '0'.repeat(32), url: 'http://127.0.0.1:1234', name: 'x', secret: '1'.repeat(64) };
  const sig = signRequest(target, 'GET', '/bridge/whoami', {}, Buffer.alloc(0), '1795090000000', 'a'.repeat(32));
  assert.equal(sig.split(' ').at(-1), '5b0aa96dcf183daaf5af47e8e1cd839be55aba9087430c0b4f52d8084462cb7d');
  const headers = { 'X-Orrery-Session': 's1', 'x-orrery-harness': 'cursor', 'x-orrery-extra': 'e', accept: 'ignored' };
  const body = Buffer.from('{"a":1}');
  const mine = signRequest(target, 'POST', '/mcp?x=1', headers, body, '1', 'b'.repeat(32)).split(' ').at(-1);
  const theirs = bridgeMac(target.secret, target, 'POST', '/mcp?x=1',
    new Map([['x-orrery-session', 's1'], ['x-orrery-harness', 'cursor'], ['x-orrery-extra', 'e']]), '1', 'b'.repeat(32), body);
  assert.equal(mine, theirs);
});

test('discovery: the active Hub from the registry; a request carries a signature and never the key', async () => {
  const hub = await fakeHub();
  const dir = join(tempDir(), 'registry');
  const reg = writeRegistry(dir, hub.url, { name: 'Daily' });
  const env = { ORRERY_REGISTRY: dir };
  try {
    const found = findHub({ env });
    assert.deepEqual({ ...found, secret: undefined }, { mode: 'signed', hubId: reg.hubId, claim: reg.claim, url: hub.url, name: 'Daily', secret: undefined });
    assert.equal(findHub({ env, secret: false }).secret, undefined, 'a URL-only lookup does not read the key');
    const r = await hubFetch('POST', '/mcp', { env, body: '{"jsonrpc":"2.0"}', headers: { 'x-orrery-session': 's-1', 'x-orrery-harness': 'qoder' } });
    assert.equal(r.status, 200);
    const [got] = hub.seen;
    assert.equal(got.headers['x-orrery-bridge'], undefined, 'no plaintext key header');
    assert.equal(got.headers.host, hub.url.slice(7));
    const [v, hubId, claim, ts, nonce, mac] = String(got.headers['x-orrery-sig']).split(' ');
    assert.deepEqual([v, hubId, claim], ['v1', reg.hubId, reg.claim]);
    assert.equal(mac, bridgeMac(reg.key, reg, 'POST', '/mcp', new Map([['x-orrery-session', 's-1'], ['x-orrery-harness', 'qoder']]), ts, nonce, Buffer.from(got.body)));
    assert.ok(!JSON.stringify(hub.seen).includes(reg.key), 'the key appears nowhere on the wire');
  } finally { await hub.close(); }
});

test('discovery stops without sending: no registry, broken or stale records, an invalid key or an unsignable header', async () => {
  const hub = await fakeHub();
  const dir = join(tempDir(), 'registry');
  const env = { ORRERY_REGISTRY: dir };
  try {
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env }), (e) => notSent(e) && /未找到活动 Hub/.test((e as Error).message));
    writeRegistry(dir, hub.url);
    writeFileSync(join(dir, 'active.json'), '{ broken');
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env }), (e) => notSent(e) && /登记处文件无效/.test((e as Error).message));
    writeRegistry(dir, 'http://localhost:1');   // only http://127.0.0.1:<port> is a registry address
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env }), notSent);
    writeRegistry(dir, hub.url, { pid: await deadPid() });
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env }), (e) => notSent(e) && /进程已经退出/.test((e as Error).message));
    writeRegistry(dir, hub.url);
    writeFileSync(join(dir, 'bridge-secret'), 'not a key');
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env }), (e) => notSent(e) && /接入密钥无效/.test((e as Error).message));
    rmSync(join(dir, 'bridge-secret'));
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env }), (e) => notSent(e) && /读不到接入密钥/.test((e as Error).message));
    writeRegistry(dir, hub.url);
    await assert.rejects(hubFetch('POST', '/mcp', { env, headers: { 'x-orrery-session': 'a,b' } }), notSent);
    await assert.rejects(hubFetch('POST', '/mcp', { env, headers: { 'x-orrery-session': ' padded' } }), notSent);
    assert.equal(hub.seen.length, 0, 'nothing reached the port');
  } finally { await hub.close(); }
});

test('ORRERY_HUB pins one Hub by id or name; a pinned Hub that is not valid stops, never falling back to the active one', async () => {
  const active = await fakeHub();
  const pinned = await fakeHub();
  const dir = join(tempDir(), 'registry');
  const a = writeRegistry(dir, active.url, { name: 'Daily' });
  const p = writeRegistry(dir, pinned.url, { name: 'Source', key: a.key, active: false });
  try {
    await hubFetch('GET', '/bridge/whoami', { env: { ORRERY_REGISTRY: dir, ORRERY_HUB: p.hubId } });
    await hubFetch('GET', '/bridge/whoami', { env: { ORRERY_REGISTRY: dir, ORRERY_HUB: 'Source' } });
    assert.equal(pinned.seen.length, 2);
    for (const pin of [TEST_HUB_ID, 'Nobody']) {
      await assert.rejects(hubFetch('GET', '/bridge/whoami', { env: { ORRERY_REGISTRY: dir, ORRERY_HUB: pin, ORRERY_LEGACY_HUB: dir } }),
        (e) => notSent(e) && (e as Error).message.includes(`ORRERY_HUB=${pin}`));
    }
    writeRegistry(dir, pinned.url, { hubId: p.hubId, key: a.key, active: false, pid: await deadPid() });
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env: { ORRERY_REGISTRY: dir, ORRERY_HUB: p.hubId } }), notSent);
    assert.equal(active.seen.length, 0, 'the active Hub was never asked instead');
    assert.equal(pinned.seen.length, 2);
  } finally {
    await active.close();
    await pinned.close();
  }
});

test('ORRERY_HUB: a record whose own hubId is not the pinned one (copied or restored under another name) is never used', async () => {
  const other = await fakeHub();
  const dir = join(tempDir(), 'registry');
  // A valid, live record for another Hub, stored under the pinned id's file name; a second copy under a third name.
  const real = writeRegistry(dir, other.url, { name: 'Restored', active: false });
  const pinned = '0a0b0c0d-1111-4222-8333-444455556666';
  const copy = readFileSync(join(dir, 'hubs', `${real.hubId}.json`), 'utf8');
  writeFileSync(join(dir, 'hubs', `${pinned}.json`), copy);
  rmSync(join(dir, 'hubs', `${real.hubId}.json`));
  writeFileSync(join(dir, 'hubs', '99999999-1111-4222-8333-444455556666.json'), copy);
  try {
    await assert.rejects(hubFetch('POST', '/mcp', { env: { ORRERY_REGISTRY: dir, ORRERY_HUB: pinned }, body: 'x' }),
      (e) => notSent(e) && (e as Error).message.includes(`ORRERY_HUB=${pinned}`));
    // By name: only a record kept under its own hubId counts, so the misplaced copies match nothing.
    await assert.rejects(hubFetch('POST', '/mcp', { env: { ORRERY_REGISTRY: dir, ORRERY_HUB: 'Restored' }, body: 'x' }), notSent);
    assert.equal(other.seen.length, 0, 'nothing was signed for the record\'s own id and address');
  } finally { await other.close(); }
});

test('callOutcome: not sent (retry is safe), refused (did not run), or unknown (may have run: check first)', () => {
  const sentNothing = callOutcome(new HubError('not-sent', '接入件没有发送请求：未找到活动 Hub。', { sent: false }));
  assert.match(sentNothing, /^接入件没有发送请求：未找到活动 Hub。这次调用没有发出，可以放心重试。$/);
  assert.match(callOutcome(new HubError('unreachable', '连不上 Hub「X」（u）：ECONNREFUSED', { sent: false })), /没有发出，可以放心重试/);
  assert.match(callOutcome(new HubError('rejected', 'Hub「X」拒收：mac', { sent: true })), /^Hub「X」拒收：mac。这次调用没有执行。$/);
  const unknown = callOutcome(new HubError('unreachable', 'Hub「X」的回答不完整：aborted', { sent: true }));
  assert.match(unknown, /结果未知/);
  assert.match(unknown, /read_messages/);
  assert.doesNotMatch(unknown, /没有发出|没有执行|没有送达/);
});

test('legacy fallback only with ORRERY_LEGACY_HUB: then <home>/hub.json with a live pid and a loopback address, the key in x-orrery-bridge', async () => {
  const legacy = await fakeHub();
  const root = tempDir();
  const dir = join(root, 'registry');
  const home = join(root, 'old-home');
  mkdirSync(home, { recursive: true });
  const key = 'c'.repeat(64);
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: legacy.url, secret: key, pid: process.pid }));
  const logged: string[] = [];
  const log = (m: string) => logged.push(m);
  try {
    // A hub.json in the default home or ORRERY_HOME is never read without the explicit setting.
    await assert.rejects(hubFetch('GET', '/bridge/whoami', { env: { ORRERY_REGISTRY: dir, ORRERY_HOME: home }, log }), notSent);
    assert.equal(legacy.seen.length, 0);
    const env = { ORRERY_REGISTRY: dir, ORRERY_LEGACY_HUB: home };
    const r = await hubFetch('POST', '/bridge/ack', { env, log, body: '{}' });
    assert.equal(r.status, 200);
    assert.equal(legacy.seen[0].headers['x-orrery-bridge'], key);
    assert.equal(legacy.seen[0].headers['x-orrery-sig'], undefined);
    assert.match(logged.join('\n'), /按用户设置的旧版回退连接 .*hub\.json/);
    // A running registry Hub wins over the legacy setting.
    const current = await fakeHub();
    writeRegistry(dir, current.url);
    await hubFetch('GET', '/bridge/whoami', { env, log });
    assert.equal(current.seen.length, 1);
    assert.equal(legacy.seen.length, 1);
    await current.close();
    rmSync(join(dir, 'active.json'));
    for (const bad of [{ url: legacy.url, secret: key, pid: await deadPid() }, { url: 'http://example.com:80', secret: key, pid: process.pid }]) {
      writeFileSync(join(home, 'hub.json'), JSON.stringify(bad));
      await assert.rejects(hubFetch('GET', '/bridge/whoami', { env, log }), notSent);
    }
    assert.equal(legacy.seen.length, 1);
  } finally { await legacy.close(); }
});

test('401 claim: re-read once and re-sign to the same Hub; a changed Hub or an unchanged claim is reported, not retried', async () => {
  let reason = 'claim';
  const hub = await fakeHub((_req, _body, res) => {
    if (hub.seen.length === 1 || reason !== 'claim') res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', reason }));
    else res.writeHead(200).end('{"ok":true}');
  });
  const dir = join(tempDir(), 'registry');
  const env = { ORRERY_REGISTRY: dir };
  const first = writeRegistry(dir, hub.url, { name: 'Daily' });
  try {
    // The Hub restarted: same hubId and address, new claim. The second request is signed with the new claim.
    const stale = findHub({ env });
    writeRegistry(dir, hub.url, { hubId: first.hubId, key: first.key, name: 'Daily' });
    const r = await hubFetch('POST', '/mcp', { env, hub: stale, body: 'x' });
    assert.equal(r.status, 200);
    assert.equal(hub.seen.length, 2);
    const claims = hub.seen.map((s) => String(s.headers['x-orrery-sig']).split(' ')[2]);
    assert.notEqual(claims[0], claims[1]);
    assert.equal(claims[1], (findHub({ env }) as { claim: string }).claim);

    // Unchanged claim: one request, the Hub's refusal.
    hub.seen.length = 0;
    await assert.rejects(hubFetch('POST', '/mcp', { env, body: 'x' }), (e) => e instanceof HubError && e.kind === 'rejected'
      && e.message === 'Hub「Daily」拒收：claim');
    assert.equal(hub.seen.length, 1);

    // Another Hub became active: the request is not sent to it.
    hub.seen.length = 0;
    const other = await fakeHub();
    const fresh = findHub({ env });
    writeRegistry(dir, other.url, { key: first.key });
    await assert.rejects(hubFetch('POST', '/mcp', { env, hub: fresh, body: 'x' }), (e) => e instanceof HubError && e.kind === 'rejected');
    assert.equal(hub.seen.length, 1);
    assert.equal(other.seen.length, 0);
    await other.close();

    // Any other reason: reported as the Hub's refusal, no retry.
    writeRegistry(dir, hub.url, { hubId: first.hubId, key: first.key, name: 'Daily' });
    hub.seen.length = 0;
    reason = 'mac';
    await assert.rejects(hubStream('/bridge/stream?harness=x', { env }), (e) => e instanceof HubError && e.kind === 'rejected' && e.reason === 'mac');
    assert.equal(hub.seen.length, 1);
  } finally { await hub.close(); }
});

test('against a real Hub: signed requests pass, a Hub restarted on the same port is followed by one re-signed retry', async () => {
  const dir = tempDir();
  const a = await startTestHub({ dir });
  const env = { ORRERY_REGISTRY: a.registryDir };
  const port = Number(a.url.split(':').at(-1));
  assert.equal(readBridgeKey(env), hubSecret(a.home));
  const who = await hubFetch('GET', '/bridge/whoami', { env });
  assert.deepEqual(JSON.parse(who.text), { hubId: a.registry.hubId, claim: a.registry.claim, name: 'Orrery', role: 'active' });
  const stale = findHub({ env });
  await a.close();
  await assert.rejects(hubFetch('GET', '/bridge/whoami', { env }), notSent);
  const b = await startTestHub({ dir, port });
  try {
    const again = await hubFetch('GET', '/bridge/whoami', { env, hub: stale });
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(again.text).claim, b.registry.claim);
  } finally { await b.close(); }
});

test('every plug-in copy of hub-discovery.mjs is byte-identical to plugins/shared, which imports Node built-ins only', () => {
  const source = readFileSync(SOURCE);
  for (const copy of COPIES) assert.ok(readFileSync(copy).equals(source), `${copy} differs from plugins/shared/hub-discovery.mjs`);
  const specs = [...source.toString('utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0 && specs.every((s) => s.startsWith('node:')), specs.join());
  assert.ok(!/\bfetch\(/.test(source.toString('utf8')), 'no fetch: a proxy must never see a request');
  // Every plug-in folder that has a copy imports it from its own folder, never from plugins/shared.
  for (const dir of ['dsh-orrery', 'cursor-orrery', 'qoder-orrery', 'antigravity-orrery', 'unread-hint', 'zcode-orrery']) {
    const files = readdirSync(join(REPO_ROOT, 'plugins', dir), { recursive: true, encoding: 'utf8' }).filter((f) => /\.(mjs|js)$/.test(f));
    for (const f of files) assert.ok(!readFileSync(join(REPO_ROOT, 'plugins', dir, f), 'utf8').includes('../shared/'), `${dir}/${f} reaches outside its folder`);
  }
});
