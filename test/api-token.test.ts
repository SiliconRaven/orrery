// The web API token (docs/security.md): every /api/* request needs it, as a Bearer header or the page's cookie;
// static files, /mcp and /bridge/* keep their own rules. rawFetch: these requests must not get helpers' test token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../src/config.ts';
import { REPO_ROOT } from '../src/main.ts';
import { bearer, freePort, mcpStatus, rawFetch, startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

const json = { 'content-type': 'application/json' };

test('api token: /api/* answers 401 without it, works with Bearer or the port-named cookie', async () => {
  const app = await startTestHub();
  try {
    const port = new URL(app.url).port;
    for (const [method, path, body] of [['GET', '/api/state'], ['GET', '/api/health'], ['GET', '/api/stream'], ['GET', '/api/session'],
      ['GET', '/api/files/x'], ['POST', '/api/clusters', JSON.stringify({ name: 'x', members: [] })], ['POST', '/api/pause', '{"paused":true}']]) {
      for (const headers of [{}, bearer('wrong'), bearer(TEST_TOKEN + 'x'), { cookie: `orrery_${port}=wrong` }, { cookie: `orrery_1=${TEST_TOKEN}` }] as Record<string, string>[]) {
        const res = await rawFetch(app.url + path, { method, headers: { ...json, ...headers }, body });
        assert.equal(res.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
        assert.deepEqual(await res.json(), { error: 'unauthorized' });
      }
    }
    assert.equal(app.hub.isPaused(), false, 'the refused POST changed nothing');
    assert.equal((await rawFetch(app.url + '/api/state', { headers: bearer(TEST_TOKEN) })).status, 200);
    assert.equal((await rawFetch(app.url + '/api/state', { headers: { authorization: `bearer ${TEST_TOKEN}` } })).status, 200, 'scheme case');
    const cookie = { cookie: `other=1; orrery_${port}=${TEST_TOKEN}` };
    assert.equal((await rawFetch(app.url + '/api/state', { headers: cookie })).status, 200);
    const paused = await rawFetch(app.url + '/api/pause', { method: 'POST', headers: { ...json, ...cookie }, body: '{"paused":true}' });
    assert.equal(paused.status, 200);
    assert.equal(app.hub.isPaused(), true);
  } finally {
    await app.close();
  }
});

test('api token: POST /api/session trades the right token for a session cookie, and only that', async () => {
  const app = await startTestHub();
  try {
    const port = new URL(app.url).port;
    const session = (token: unknown) => rawFetch(app.url + '/api/session', { method: 'POST', headers: json, body: JSON.stringify({ token }) });
    for (const bad of ['wrong', TEST_TOKEN.slice(1), '', 42, null]) {
      const res = await session(bad);
      assert.equal(res.status, 401, String(bad));
      assert.equal(res.headers.get('set-cookie'), null);
    }
    const ok = await session(TEST_TOKEN);
    assert.equal(ok.status, 204);
    const set = ok.headers.get('set-cookie')!;
    assert.equal(set, `orrery_${port}=${TEST_TOKEN}; HttpOnly; SameSite=Strict; Path=/`, 'a session cookie: no Max-Age or Expires');
    const cookie = set.split(';')[0];
    assert.equal((await rawFetch(app.url + '/api/state', { headers: { cookie } })).status, 200);
    // The page's other requests: the SSE stream and a file link.
    const ac = new AbortController();
    const sse = await rawFetch(app.url + '/api/stream', { headers: { cookie }, signal: ac.signal });
    assert.equal(sse.status, 200);
    ac.abort();
    assert.equal((await rawFetch(app.url + '/api/files/none', { headers: { cookie } })).status, 404, 'past the token check');
    // The other content-type and Origin checks still come first.
    assert.equal((await rawFetch(app.url + '/api/session', { method: 'POST', body: JSON.stringify({ token: TEST_TOKEN }) })).status, 415);
  } finally {
    await app.close();
  }
});

test('api token: the page itself, /mcp and /bridge/* need no API token', async () => {
  const app = await startTestHub();
  try {
    assert.match(await (await rawFetch(app.url + '/')).text(), /<title>orrery<\/title>/);
    assert.equal((await rawFetch(app.url + '/app.js')).status, 200);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': secret }), 200, 'the bridge secret is enough for /mcp');
    assert.equal(await mcpStatus(app.url, bearer(TEST_TOKEN)), 401, 'the API token is not a bridge secret');
    const ack = (headers: Record<string, string>) => rawFetch(app.url + '/bridge/ack', { method: 'POST', headers: { ...json, ...headers }, body: '{}' });
    assert.notEqual((await ack({ 'x-orrery-bridge': secret })).status, 401);
    assert.equal((await ack(bearer(TEST_TOKEN))).status, 401);
  } finally {
    await app.close();
  }
});

test('api token: made once in <home>/api-token and reused; never in hub.json, an answer or an event', async () => {
  const dir = tempDir();
  const app = await startTestHub({ dir, apiToken: undefined });
  let token: string;
  try {
    token = readFileSync(join(app.home, 'api-token'), 'utf8').trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
    assert.equal((await rawFetch(app.url + '/api/state', { headers: bearer(TEST_TOKEN) })).status, 401, 'not the test token');
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await rawFetch(app.url + path, { method, headers: { ...json, ...bearer(token) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return res.text();
    };
    const created = JSON.parse(await call('POST', '/api/clusters', { name: 'c', members: [{ projectPath: tempDir(), harness: 'mock', name: 'a' }] }));
    const answers = [
      created, await call('GET', '/api/state'), await call('GET', '/api/health'), await call('GET', '/api/settings'),
      await call('POST', `/api/clusters/${created.cluster.id}/messages`, { body: 'hi' }), await call('GET', '/api/usage'),
    ].map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
    for (const text of [...answers, readFileSync(join(app.home, 'hub.json'), 'utf8'), JSON.stringify(app.events)]) {
      assert.ok(!text.includes(token), text.slice(0, 200));
    }
  } finally {
    await app.close();
  }
  const again = await startTestHub({ dir, apiToken: undefined });
  try {
    assert.equal(readFileSync(join(again.home, 'api-token'), 'utf8').trim(), token);
    assert.equal((await rawFetch(again.url + '/api/state', { headers: bearer(token) })).status, 200);
  } finally {
    await again.close();
  }
});

test('api token: ORRERY_API_TOKEN overrides the file; a short or unsafe one stops the Hub without showing it', async () => {
  const good = 'x'.repeat(32);
  assert.equal(resolveConfig({ ORRERY_API_TOKEN: good }).apiToken, good);
  assert.equal(resolveConfig({ ORRERY_API_TOKEN: '' }).apiToken, undefined, 'empty counts as unset');
  for (const bad of ['short-secret-value', 'y'.repeat(31), `${'z'.repeat(32)};x`, `${'z'.repeat(32)} x`]) {
    assert.throws(() => resolveConfig({ ORRERY_API_TOKEN: bad }), (e: Error) => /ORRERY_API_TOKEN must be/.test(e.message) && !e.message.includes(bad));
  }
  const dir = tempDir();
  const secretValue = 'too-short-but-secret';
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'src', 'main.ts')], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ORRERY_API_TOKEN: secretValue, ORRERY_PORT: String(await freePort()), ORRERY_HOME: join(dir, 'home'), ORRERY_DB: join(dir, 'h.db'), ORRERY_MOCK: '1' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ORRERY_API_TOKEN must be at least 32 characters/);
  assert.ok(!r.stderr.includes(secretValue) && !r.stdout.includes(secretValue), 'the value is never printed');

  const app = await startTestHub({ dir, apiToken: good });
  try {
    assert.equal((await rawFetch(app.url + '/api/state', { headers: bearer(good) })).status, 200);
    assert.throws(() => readFileSync(join(app.home, 'api-token')), 'no file is made for an env token');
  } finally {
    await app.close();
  }
});
