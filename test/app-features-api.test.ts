import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { UpdateChecker } from '../src/update-check.ts';
import type { WebControl } from '../src/web/server.ts';
import { rawFetch, startTestHub, tempDir } from './helpers.ts';

test('feature routes require user authentication, preserve installer grants and accept ZIP bytes', async () => {
  const dir = tempDir();
  const calls: { method: string; value: unknown }[] = [];
  let checks = 0;
  const updater = new UpdateChecker({
    home: join(dir, 'home'),
    currentVersion: '0.10.0-beta.1',
    fetcher: async () => {
      checks++;
      return Response.json([{ tag_name: 'v0.10.0-beta.2', prerelease: true, draft: false }]);
    },
  });
  const installer: NonNullable<WebControl['pluginInstaller']> = {
    maxArchiveBytes: 32 * 1024 * 1024,
    async prepare(value) {
      calls.push({ method: 'prepare', value });
      return { id: 'preview', manifest: { id: 'demo' } };
    },
    async confirm(id, grants) {
      calls.push({ method: 'confirm', value: { id, grants } });
      return { pluginId: 'demo', restartRequired: true };
    },
    async cancel(id) { calls.push({ method: 'cancel', value: id }); },
  };
  const app = await startTestHub({ dir, updateChecker: updater, pluginInstaller: installer });
  try {
    assert.equal(checks, 0, 'programmatic/test startup does not contact a release provider');
    const denied = await rawFetch(app.url + '/api/plugin-installs/prepare', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'demo' }),
    });
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await rawFetch(app.url + '/api/updates')).status, 401);

    await app.api('POST', '/api/plugin-installs/prepare', { source: 'demo@1.0.0' });
    const filename = '插件.zip';
    const zip = await fetch(app.url + '/api/plugin-installs/prepare?manifestPath=sub%2Forrery-plugin.json', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(filename) },
      body: new Uint8Array([80, 75, 3, 4]),
    });
    assert.equal(zip.status, 200);
    const payload = calls[1].value as { filename: string; manifestPath: string; bytes: Uint8Array };
    assert.equal(payload.filename, filename);
    assert.equal(payload.manifestPath, 'sub/orrery-plugin.json');
    assert.deepEqual([...payload.bytes], [80, 75, 3, 4]);

    const grants = { permissions: ['tools.provide', 'ui.show'], events: [], clusterIds: ['read'],
      writeClusterIds: [], tools: ['echo'], ui: ['workbench'] };
    await app.api('POST', '/api/plugin-installs/preview/confirm', grants);
    assert.deepEqual(calls[2], { method: 'confirm', value: { id: 'preview', grants } });
    await app.api('DELETE', '/api/plugin-installs/preview', {});
    assert.deepEqual(calls[3], { method: 'cancel', value: 'preview' });

    assert.equal((await app.api('POST', '/api/updates/check', {})).status, 'available');
    assert.equal(checks, 1);
    assert.equal((await app.api('PATCH', '/api/updates', { autoCheck: false })).autoCheck, false);
    await assert.rejects(app.api('PATCH', '/api/updates', { autoCheck: true, url: 'https://example.com' }), /Unsupported update setting/);
    const script = await fetch(app.url + '/shared/i18n/index.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    assert.equal((await fetch(app.url + '/shared/i18n/index.d.ts')).status, 404);
  } finally {
    await app.close();
  }
});

test('the settings page API keeps binary uploads, abort signals and errors intact', async () => {
  const source = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function api(');
  const end = source.indexOf('// Every /api/*', start);
  let request: RequestInit | undefined;
  let response = Response.json({ prepared: true });
  const api = runInNewContext(source.slice(start, end) + '\nfeatureApi', {
    Headers, unauthorized() {}, fetch: async (_path: string, init: RequestInit) => { request = init; return response; },
  });
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const { signal } = new AbortController();
  await api('POST', '/api/plugin-installs/prepare', bytes, {
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('插件.zip') }, signal,
  });
  assert.equal(request?.body, bytes);
  assert.equal(request?.signal, signal);
  assert.equal(new Headers(request?.headers).get('x-file-name'), encodeURIComponent('插件.zip'));
  response = Response.json({
    error: '请选择清单', code: 'MANIFEST_SELECTION_REQUIRED', manifestPaths: ['example/orrery-plugin.json'],
  }, { status: 400 });
  await assert.rejects(api('POST', '/api/plugin-installs/prepare', { source: 'npm:example' }), (error) => {
    assert.equal((error as Error).message, '请选择清单');
    assert.deepEqual((error as { data?: unknown }).data, {
      error: '请选择清单', code: 'MANIFEST_SELECTION_REQUIRED', manifestPaths: ['example/orrery-plugin.json'],
    });
    return true;
  });
  response = Response.json({ cancelled: true });
  await api('DELETE', '/api/plugin-installs/example');
  assert.equal(new Headers(request?.headers).get('content-type'), 'application/json');
  const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="updates-settings"/);
  assert.match(html, /id="plugin-install-settings"/);
});
