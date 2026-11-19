// Review fix: websites in the user's browser must not drive the local API (cross-site requests, DNS rebinding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { bearer, startTestHub, TEST_TOKEN } from './helpers.ts';

/** Raw HTTP so the test controls Host and Origin (fetch does not let us set Host). */
function raw(url: string, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((ok, fail) => {
    const req = request(url + path, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => ok({ status: res.statusCode!, body: data }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

test('wrong Host, foreign Origin and non-JSON writes are rejected; same-origin JSON works', async () => {
  const app = await startTestHub();
  try {
    const port = new URL(app.url).port;
    const json = { 'content-type': 'application/json' };
    const create = JSON.stringify({ name: 'x', members: [{ harness: 'mock', mode: 'native', projectPath: '/work' }] });

    // DNS rebinding: the browser sends the attacker's host name.
    assert.equal((await raw(app.url, 'GET', '/api/state', { host: `evil.example:${port}` })).status, 403);
    assert.equal((await raw(app.url, 'GET', '/api/state', { host: '127.0.0.1:1' })).status, 403);
    assert.equal((await raw(app.url, 'POST', '/mcp', { host: `evil.example:${port}`, ...json }, '{}')).status, 403);

    // Cross-site "simple" request: text/plain body, no preflight.
    const plain = await raw(app.url, 'POST', '/api/clusters', { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }, create);
    assert.equal(plain.status, 415);
    assert.equal((await raw(app.url, 'POST', '/api/pause', { host: `127.0.0.1:${port}` }, '{"paused":true}')).status, 415);
    assert.equal((await raw(app.url, 'PATCH', '/api/clusters/x', { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }, '{"category":"g"}')).status, 415);
    assert.equal((await raw(app.url, 'PATCH', '/api/clusters/x', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', ...json }, '{"category":"g"}')).status, 403);

    // Foreign Origin, even with a JSON content type.
    const foreign = await raw(app.url, 'POST', '/api/clusters', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', ...json }, create);
    assert.equal(foreign.status, 403);
    assert.deepEqual((await app.api('GET', '/api/state')).clusters, [], 'nothing was created');

    // The Hub's own page: same origin, JSON, either host spelling.
    const same = await raw(app.url, 'POST', '/api/clusters', { host: `localhost:${port}`, origin: `http://localhost:${port}`, ...json, ...bearer(TEST_TOKEN) }, create);
    assert.equal(same.status, 201);
    const noOrigin = await raw(app.url, 'POST', '/api/pause', { host: `127.0.0.1:${port}`, 'content-type': 'application/json; charset=utf-8', ...bearer(TEST_TOKEN) }, '{"paused":false}');
    assert.equal(noOrigin.status, 200);
  } finally {
    await app.close();
  }
});
