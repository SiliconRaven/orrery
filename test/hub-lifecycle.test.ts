// docs/launcher.md 测试 2 和 4: the port is the single-instance lock (taken before any data is touched), and
// /api/health + /api/shutdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { bearer, freePort, holdScript, startTestHub, tempDir, TEST_TOKEN, waitFor, type TestHub } from './helpers.ts';

/** Spawns `node src/main.ts` (what `npm start` runs) on these paths. */
function startMain(env: Record<string, string>) {
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: REPO_ROOT, env: { ...process.env, ORRERY_API_TOKEN: TEST_TOKEN, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '' };
  child.stdout.on('data', (c) => { out.text += c; });
  child.stderr.on('data', (c) => { out.text += c; });
  return { child, out, exit: once(child, 'exit') as Promise<[number | null, string | null]> };
}

/** Raw HTTP status, so the test controls Host (fetch does not let us set it). */
function rawStatus(url: string, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<number>((ok, fail) => {
    const req = request(url + path, { method, headers: { ...bearer(TEST_TOKEN), ...headers } }, (res) => { res.resume(); ok(res.statusCode!); });
    req.on('error', fail);
    req.end(body);
  });
}

const postShutdown = (url: string, headers: Record<string, string> = { 'content-type': 'application/json' }, body = '{}') =>
  fetch(url + '/api/shutdown', { method: 'POST', headers, body });

test('startup: a discovery write failure releases the Hub, database and port without masking the error', { timeout: 15_000 }, async () => {
  const dir = tempDir();
  const port = await freePort();
  // A child contains any leaked handles if this regresses. The directory at hub.json makes the rename fail.
  const script = `
    import assert from 'node:assert/strict';
    import { mkdirSync } from 'node:fs';
    import { createServer } from 'node:net';
    import { join } from 'node:path';
    import { startHub } from './src/main.ts';
    import { Store } from './src/core/store.ts';
    import { Hub } from './src/core/hub.ts';
    const [dir, rawPort] = process.argv.slice(1);
    const home = join(dir, 'home');
    mkdirSync(join(home, 'hub.json'), { recursive: true });
    let storeCloses = 0, adapterCloses = 0, nativeCloses = 0, hubError, listenersCleared = false;
    const close = Store.prototype.close;
    Store.prototype.close = function () { storeCloses++; return close.call(this); };
    const closeHub = Hub.prototype.close;
    Hub.prototype.close = async function () {
      this.subscribe(() => {});
      try { return await closeHub.call(this); }
      catch (error) { hubError = error; throw error; }
      finally { listenersCleared = this.listeners.size === 0; }
    };
    const adapter = { close: async () => { adapterCloses++; throw new Error('cleanup failure'); } };
    const timer = setInterval(() => {}, 1000);
    const native = { close: async () => { nativeCloses++; clearInterval(timer); } };
    let failure;
    try {
      await startHub({ home, dbPath: join(dir, 'test.db'), port: Number(rawPort),
        apiToken: 'test-token-0123456789abcdefghijklmnopqrstuvwxyz', nativeAdapters: { faulty: adapter, fake: native } });
    } catch (error) { failure = error; }
    assert.equal(failure?.syscall, 'rename', 'the original discovery error is returned');
    assert.equal(failure?.dest, join(home, 'hub.json'));
    assert.equal(adapterCloses, 1, 'the Hub was closed');
    assert.equal(nativeCloses, 1, 'the later adapter released its timer');
    assert.equal(hubError?.message, 'cleanup failure', 'the first Hub cleanup error was preserved');
    assert.equal(listenersCleared, true, 'the Hub removed its listeners');
    assert.equal(storeCloses, 1, 'the database was closed despite the adapter error');
    const server = createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(Number(rawPort), '127.0.0.1', resolve));
    await new Promise((resolve) => server.close(resolve));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, String(port)], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0, `child exited ${code ?? signal}: ${output}`);
  } finally {
    clearTimeout(timer);
  }
});

test('launcher 2: a second Hub on the same port and database fails with EADDRINUSE before touching any data', async () => {
  const hold = holdScript();
  const port = await freePort();
  const app = await startTestHub({ port, mock: { script: hold.script } });
  try {
    const { cluster } = await app.cluster('one', ['A']);
    app.hub.sendFromUser(cluster.id, '@A hold');
    const stateOf = (id: string) => (app.store.db.prepare('SELECT state FROM deliveries WHERE id = ?').get(id) as { state: string }).state;
    const id = await waitFor(() => (app.store.db.prepare("SELECT id FROM deliveries WHERE state = 'running'").get() as { id: string } | undefined)?.id, 'a running delivery');
    const discovery = readFileSync(join(app.home, 'hub.json'), 'utf8');
    const secret = readFileSync(join(app.home, 'secret'), 'utf8');

    const b = startMain({ ORRERY_PORT: String(port), ORRERY_DB: join(app.dir, 'test.db'), ORRERY_HOME: app.home, ORRERY_SANDBOX: join(app.dir, 'sandbox') });
    const [code] = await b.exit;
    assert.notEqual(code, 0);
    assert.match(b.out.text, /EADDRINUSE/);
    assert.equal(stateOf(id), 'running', "B did not requeue A's running delivery");
    assert.equal(readFileSync(join(app.home, 'hub.json'), 'utf8'), discovery, 'hub.json still points at A');
    assert.equal(readFileSync(join(app.home, 'secret'), 'utf8'), secret);
    assert.equal((await (await fetch(app.url + '/api/health')).json()).pid, process.pid, 'A still answers');
  } finally {
    hold.release();
    await app.close();
  }
});

test('launcher 4: /api/health describes the Hub without the bridge secret', async () => {
  const app = await startTestHub();
  try {
    const res = await fetch(app.url + '/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { app: 'orrery', pid: process.pid, state: 'running', home: app.home, db: join(app.dir, 'test.db'), executable: process.execPath });
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    assert.ok(!text.includes(secret));
    // Same Host check as the rest of the API.
    const port = new URL(app.url).port;
    assert.equal(await rawStatus(app.url, 'GET', '/api/health', { host: `evil.example:${port}` }), 403);
  } finally { await app.close(); }
});

test('launcher 4: without a shutdown callback /api/shutdown does not exist', async () => {
  const app = await startTestHub();
  try {
    assert.equal((await postShutdown(app.url)).status, 404);
    assert.equal((await (await fetch(app.url + '/api/health')).json()).state, 'running');
  } finally { await app.close(); }
});

test('launcher 4: shutdown refuses GET, cross-site and non-JSON requests; repeated requests and Ctrl+C close once', async () => {
  let calls = 0;
  let app!: TestHub;
  app = await startTestHub({ onShutdown: () => { calls++; void app.close(); } });
  try {
    const health = async () => (await (await fetch(app.url + '/api/health')).json()).state;
    assert.equal((await fetch(app.url + '/api/shutdown')).status, 404, 'GET');
    assert.equal((await postShutdown(app.url, { 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403);
    const port = new URL(app.url).port;
    assert.equal(await rawStatus(app.url, 'POST', '/api/shutdown', { host: `evil.example:${port}`, 'content-type': 'application/json' }, '{}'), 403, 'DNS rebinding');
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
      assert.equal((await postShutdown(app.url, { 'content-type': type }, 'a=1')).status, 415, type);
    }
    assert.equal(calls, 0);
    assert.equal(await health(), 'running');

    const { cluster } = await app.cluster('kept', ['A']);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'still here' });
    // Hold the close half-way so the second request and the "Ctrl+C" arrive while it runs.
    const gate = Promise.withResolvers<void>();
    let hubCloses = 0;
    const realClose = app.hub.close.bind(app.hub);
    app.hub.close = async () => { hubCloses++; await gate.promise; return realClose(); };

    const first = await postShutdown(app.url);
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), {});
    await waitFor(() => hubCloses === 1, 'close to start');
    assert.equal(await health(), 'stopping');
    assert.equal((await postShutdown(app.url)).status, 202, 'a repeated request is accepted too');
    const ctrlC = app.close();
    gate.resolve();
    await ctrlC;
    assert.equal(hubCloses, 1, 'closed once');
    assert.equal(calls, 2);
    assert.equal(existsSync(join(app.home, 'hub.json')), false);
    const store = new Store(join(app.dir, 'test.db'));
    try {
      assert.deepEqual(store.listClusters().map((c) => c.name), ['kept']);
      assert.deepEqual(store.listMessages(cluster.id, 10).map((m) => m.body), ['still here']);
    } finally { store.close(); }
  } finally { await app.close(); }
});

test('launcher 4: node src/main.ts exits after POST /api/shutdown, removes hub.json and keeps the data', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const hub = startMain({ ORRERY_PORT: '0', ORRERY_DB: join(dir, 'h.db'), ORRERY_SANDBOX: join(dir, 'sb'), ORRERY_HOME: home, ORRERY_MOCK: '1' });
  try {
    const url = await waitFor(() => /listening on (http:\S+)/.exec(hub.out.text)?.[1], 'hub to start', 10_000);
    const send = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { cluster } = await (await send('/api/clusters', { name: 'kept', members: [{ projectPath: tempDir(), harness: 'mock' }] })).json();
    await send(`/api/clusters/${cluster.id}/messages`, { body: 'still here' });
    assert.ok(existsSync(join(home, 'hub.json')));
    assert.equal((await send('/api/shutdown', {})).status, 202);
    const [code] = await hub.exit;
    assert.equal(code, 0);
    assert.equal(existsSync(join(home, 'hub.json')), false);
    const store = new Store(join(dir, 'h.db'));
    try {
      assert.deepEqual(store.listClusters().map((c) => c.name), ['kept']);
      assert.deepEqual(store.listMessages(cluster.id, 10).map((m) => m.body), ['still here']);
    } finally { store.close(); }
  } finally {
    if (hub.child.exitCode === null) hub.child.kill();
  }
});
