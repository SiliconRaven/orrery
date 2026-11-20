import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyTranscriptPage, TRANSCRIPT_MAX_ITEMS, type TranscriptPage, type TranscriptRequest } from '../src/core/native-transcript.ts';
import { rawFetch, startTestHub, tempDir } from './helpers.ts';

const transcriptPath = (clusterId: string, memberId: string) => `/api/clusters/${clusterId}/members/${memberId}/transcript`;
const fileAt = (dir: string) => join(dir, 'home', 'plugins.json');
const seedSettings = (dir: string, settings: object) => {
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(fileAt(dir), JSON.stringify(settings));
};

test('Star map starts off, preserves legacy settings and persists an explicit enable across restarts', async () => {
  const dir = tempDir();
  const legacy = { disabled: ['bookmarks'], autoRestart: ['example'], uiOff: ['example'] };
  seedSettings(dir, legacy);
  const first = await startTestHub({ dir });
  let path: string;
  try {
    const { cluster, members: [member] } = await first.cluster('example', ['reader']);
    path = transcriptPath(cluster.id, member.id);
    const before = await first.api('GET', '/api/plugins');
    const initial = before.installed.find((plugin: { id: string }) => plugin.id === 'starmap');
    assert.deepEqual([initial.enabled, initial.pendingEnabled, initial.iconUrl, initial.officialUpdate.source],
      [false, false, '/api/plugins/starmap/icon', 'bundled']);
    assert.equal((await fetch(first.url + initial.iconUrl)).headers.get('content-type'), 'image/svg+xml', 'settings can show the icon while off');
    assert.ok(!before.officialFrontend.some((entry: { id: string }) => entry.id === 'starmap'));
    assert.ok(!before.plugins.some((plugin: { id: string }) => plugin.id === 'bookmarks'));
    assert.equal((await fetch(first.url + path)).status, 404);
    const after = await first.api('PUT', '/api/plugins/starmap', { enabled: true });
    const pending = after.installed.find((plugin: { id: string }) => plugin.id === 'starmap');
    assert.deepEqual([pending.enabled, pending.pendingEnabled], [false, true]);
    assert.equal((await fetch(first.url + path)).status, 404);
    assert.deepEqual(JSON.parse(readFileSync(fileAt(dir), 'utf8')), { ...legacy, enabled: ['starmap'] });
  } finally { await first.close(); }

  const second = await startTestHub({ dir });
  let entry: string;
  try {
    const running = await second.api('GET', '/api/plugins');
    // The built-in copy's web module comes from its package payload, the same way a signed package's does.
    entry = running.officialFrontend.find((row: { id: string }) => row.id === 'starmap').entry;
    assert.match(entry, /^\/official-plugin-web\/starmap\/[0-9a-f]{64}\/index\.js$/);
    assert.ok(!running.frontend.includes('starmap'));
    assert.equal((await rawFetch(second.url + entry)).status, 200);
    assert.equal((await second.api('GET', path)).status, 'unsupported');
  } finally { await second.close(); }

  // A conflicting user disable takes priority. The environment also wins over an explicit enable.
  seedSettings(dir, { ...legacy, disabled: [...legacy.disabled, 'starmap'], enabled: ['starmap'] });
  const conflict = await startTestHub({ dir });
  try {
    assert.equal((await fetch(conflict.url + path)).status, 404);
    assert.equal((await rawFetch(conflict.url + entry)).status, 404, 'no page module while off');
    await conflict.api('PUT', '/api/plugins/starmap', { enabled: true });
    assert.deepEqual(JSON.parse(readFileSync(fileAt(dir), 'utf8')), { ...legacy, enabled: ['starmap'] });
  } finally { await conflict.close(); }
  const forcedOff = await startTestHub({ dir, disabledPlugins: ['starmap'] });
  try {
    const configured = (await forcedOff.api('GET', '/api/plugins')).installed.find((plugin: { id: string }) => plugin.id === 'starmap');
    assert.deepEqual([configured.enabled, configured.pendingEnabled, configured.disabledByEnv], [false, false, true]);
    assert.equal((await fetch(forcedOff.url + path)).status, 404);
    await assert.rejects(forcedOff.api('PUT', '/api/plugins/starmap', { enabled: true }), /环境变量/);
    assert.deepEqual(JSON.parse(readFileSync(fileAt(dir), 'utf8')), { ...legacy, enabled: ['starmap'] });
  } finally { await forcedOff.close(); }

  rmSync(fileAt(dir));
  const restored = await startTestHub({ dir });
  try {
    const reset = await restored.api('GET', '/api/plugins');
    assert.ok(reset.plugins.some((plugin: { id: string }) => plugin.id === 'bookmarks'));
    assert.equal((await fetch(restored.url + path)).status, 404);
  } finally { await restored.close(); }
});

test('Star map checks authentication and active membership before reading the bound conversation', async () => {
  const dir = tempDir();
  seedSettings(dir, { disabled: [], enabled: ['starmap'] });
  const app = await startTestHub({ dir });
  try {
    const { cluster, members: [reader, removed] } = await app.cluster('active', ['reader', 'removed']);
    const { cluster: other } = await app.cluster('other', ['other']);
    const { cluster: trash, members: [deleted] } = await app.cluster('trash', ['deleted']);
    app.hub.removeMember(cluster.id, removed.id);
    app.hub.deleteCluster(trash.id);
    const path = transcriptPath(cluster.id, reader.id);
    const calls: { session: string; request: TranscriptRequest }[] = [];
    const text = 'synthetic native transcript';
    let next: TranscriptPage | Error = {
      status: 'ok', items: [{ id: 'one', kind: 'assistant', text, source: { toolCallId: 'internal evidence' } }],
      after: 'adapter-after', hasMore: false, unknownCount: 0,
    };
    app.native.transcript = async (session, request) => {
      calls.push({ session, request });
      if (next instanceof Error) throw next;
      return next;
    };
    assert.equal((await rawFetch(app.url + path)).status, 401);
    for (const invalid of [
      transcriptPath(other.id, reader.id), transcriptPath(cluster.id, removed.id),
      transcriptPath(trash.id, deleted.id), transcriptPath(cluster.id, 'absent'),
    ]) {
      const response = await fetch(app.url + invalid);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'unknown member in cluster' });
    }
    assert.equal(calls.length, 0);

    // The route's query checks, paging and no-store are the package's (test/starmap-package.test.ts); the Hub core keeps
    // the bound session, the page statuses and what reaches the browser.
    const seq = app.store.lastEventSeq();
    const body = await app.api('GET', path);
    assert.deepEqual(body.items, [{ id: 'one', kind: 'assistant', text }]);
    assert.notEqual(body.after, 'adapter-after', 'only an opaque Hub cursor leaves the Hub');
    assert.deepEqual(calls[0], { session: reader.workerSessionId, request: { direction: undefined, cursor: undefined, limit: TRANSCRIPT_MAX_ITEMS } });
    for (const status of ['missing', 'unsupported', 'archived', 'refused', 'reset'] as const) {
      next = emptyTranscriptPage(status);
      assert.deepEqual(await app.api('GET', path), next);
    }
    next = new Error('private adapter details should never reach the browser');
    assert.deepEqual(await app.api('GET', path), emptyTranscriptPage('refused'));
    assert.equal(app.store.lastEventSeq(), seq, 'reading emits no event');
  } finally { await app.close(); }
});
