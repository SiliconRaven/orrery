import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runtimeConfig, stopInstalledHub } from '../lib/runtime.mjs';

test('packaged runtime needs no Node on PATH and keeps writable data outside installation', () => {
  const resourcesPath = join(tmpdir(), 'Orrery install', 'resources');
  const userData = join(tmpdir(), 'Orrery profile');
  const runtime = runtimeConfig({ packaged: true, resourcesPath, userData, node: 'ignored', env: { PATH: '' } });
  assert.equal(runtime.node, join(resourcesPath, 'node', 'node.exe'));
  assert.equal(runtime.launcher, join(resourcesPath, 'hub', 'src', 'launcher.ts'));
  assert.equal(runtime.env.ORRERY_HOME, join(userData, 'hub'));
  assert.equal(runtime.env.ORRERY_DB, join(userData, 'hub', 'orrery.db'));
  const explicit = { ORRERY_HOME: join(userData, 'custom'), ORRERY_DB: join(userData, 'custom.db') };
  assert.deepEqual(runtimeConfig({ packaged: true, resourcesPath, userData, env: explicit }).env, explicit);
  const env = { PATH: 'development' };
  const dev = runtimeConfig({ packaged: false, node: 'custom-node', env });
  assert.equal(dev.node, 'custom-node');
  assert.equal(dev.env, env);
  assert.equal(dev.launcher, join(import.meta.dirname, '..', '..', 'src', 'launcher.ts'));
});

test('installer shuts down only the authenticated Hub belonging to this installation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-installer-runtime-'));
  const runtime = runtimeConfig({ packaged: true, resourcesPath: join(dir, 'resources'), userData: dir, env: {} });
  await mkdir(runtime.env.ORRERY_HOME);
  await writeFile(join(runtime.env.ORRERY_HOME, 'api-token'), 'test-installer-token');
  let posts = 0;
  let running = true;
  let changes = {};
  const health = { app: 'orrery', pid: 12345, state: 'running', home: runtime.env.ORRERY_HOME,
    db: runtime.env.ORRERY_DB, executable: runtime.node };
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-installer-token') { res.writeHead(401).end(); return; }
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...health, ...changes })); return; }
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/shutdown');
    assert.equal(req.headers['content-type'], 'application/json', 'the real Hub requires JSON writes');
    posts++; running = false; res.writeHead(202).end('{}');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise((done) => server.close(done)); await rm(dir, { recursive: true, force: true }); });
  const file = join(runtime.env.ORRERY_HOME, 'hub.json');
  await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: health.pid }));
  for (const mismatch of [{ home: dir }, { db: join(dir, 'other.db') }, { executable: process.execPath }, { pid: 54321 }]) {
    changes = mismatch;
    await assert.rejects(stopInstalledHub(runtime, { isAlive: () => running }), /does not match/);
  }
  assert.equal(posts, 0);
  changes = {};
  await stopInstalledHub(runtime, { isAlive: () => running });
  assert.equal(posts, 1);
  await writeFile(file, JSON.stringify({ url: 'https://example.invalid', pid: health.pid }));
  await assert.rejects(stopInstalledHub(runtime), /invalid or non-local/);
  await rm(file);
  await stopInstalledHub(runtime);
});
