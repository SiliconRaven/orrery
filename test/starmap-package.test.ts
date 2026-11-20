// The star map as an independently released official package (docs/starmap.md「制品」, docs/official-plugin-updates.md
// 「星图制品与测试」): real ZIPs built from the one source the built-in copy also runs, installed through the settings
// API on an isolated test Hub with a mock native session, then activated at restart.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { packOfficialPlugin } from '../scripts/pack-official-plugin.ts';
import { emptyTranscriptPage, TRANSCRIPT_MAX_ITEMS, type TranscriptRequest } from '../src/core/native-transcript.ts';
import { readPluginsFile } from '../src/config.ts';
import { REPO_ROOT, type StartOptions } from '../src/main.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import type { OfficialManifest } from '../src/official-plugin-package.ts';
import { rawFetch, startTestHub, tempDir, type TestHub } from './helpers.ts';
import './plugin-host-hook.ts';

const SOURCE = join(REPO_ROOT, 'src/plugins/starmap/package');
const RELEASE = join(REPO_ROOT, 'src/plugins/starmap/release.json');
const release: Omit<OfficialManifest, 'files'> = JSON.parse(readFileSync(RELEASE, 'utf8'));
const KEY_ID = 'test-publisher';
const UPDATE = '/api/plugins/official-updates';
const transcriptPath = (clusterId: string, memberId: string) => `/api/clusters/${clusterId}/members/${memberId}/transcript`;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Signed starmap ZIPs (ephemeral key) and a local catalog in place of the release channel. */
function releases() {
  const dir = tempDir();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const zips = new Map<string, Buffer>();
  const fetched: string[] = [];
  // 2.0.1: the source as it is, through the documented release command (scripts/pack-official-plugin.ts).
  const key = join(dir, 'test-key.pem');
  const metadata = join(dir, 'starmap-2.0.1.json');
  const out = join(dir, 'starmap-2.0.1.zip');
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(metadata, JSON.stringify({ ...release, version: '2.0.1', keyId: KEY_ID }));
  const printed = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/pack-official-plugin.ts'), SOURCE, metadata, key, out], { encoding: 'utf8' });
  zips.set('2.0.1', readFileSync(out));
  assert.equal(printed.trim(), 'SHA-256 ' + sha256(zips.get('2.0.1')!));
  // 2.0.2: the same source with an observable change in its web module's English.
  const changed = join(dir, 'starmap-2.0.2');
  cpSync(SOURCE, changed, { recursive: true });
  const english = join(changed, 'web/i18n/en.json');
  writeFileSync(english, JSON.stringify({ ...JSON.parse(readFileSync(english, 'utf8')), 星图: 'Star map 2.0.2' }, null, 2) + '\n');
  zips.set('2.0.2', packOfficialPlugin(changed, { ...release, version: '2.0.2', keyId: KEY_ID }, privateKey));

  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    fetched.push(url.pathname);
    if (url.pathname.endsWith('/index.json')) {
      return Response.json({ format: 1, releases: [...zips].map(([version, bytes]) => ({
        id: 'starmap', version, tag: 'starmap-' + version, asset: 'starmap.zip', sha256: sha256(bytes),
      })) });
    }
    const version = /\/starmap-([^/]+)\/starmap\.zip$/.exec(url.pathname)?.[1];
    return version && zips.has(version) ? new Response(new Uint8Array(zips.get(version)!)) : new Response(null, { status: 404 });
  };
  // The first Hub with this package interface: the release metadata's minimum, not this checkout's version.
  const start = (extra: Partial<StartOptions> = {}) => startTestHub({ dir, officialUpdates: { keys: new Map([[KEY_ID, { publicKey, ids: ['starmap'] }]]), fetcher,
    hubVersion: release.hub.minVersion }, ...extra });
  return { start, fetched };
}

const plugins = (app: TestHub) => app.api('GET', '/api/plugins');
const card = async (app: TestHub) => (await plugins(app)).installed.find((p: { id: string }) => p.id === 'starmap');
const entryOf = async (app: TestHub) => (await plugins(app)).officialFrontend.find((e: { id: string }) => e.id === 'starmap');
const state = (app: TestHub) => JSON.parse(readFileSync(join(app.home, 'official-plugins', 'state.json'), 'utf8'));

async function stage(app: TestHub, version: string) {
  const { candidates } = await app.api('POST', UPDATE + '/check', {});
  assert.ok(candidates.some((c: { id: string; version: string; compatible: boolean }) => c.id === 'starmap' && c.version === version && c.compatible));
  const preview = await app.api('POST', UPDATE + '/prepare', { id: 'starmap', version });
  assert.deepEqual([preview.id, preview.version, preview.migrationVersion, preview.restartRequired], ['starmap', version, 0, true]);
  assert.deepEqual(await app.api('POST', UPDATE + '/confirm', { prepareId: preview.prepareId }), { id: 'starmap', version, restartRequired: true });
}

/** Where the Hub reads an entry's files from: the selected package's web/, or the built-in copy's source. */
function webRoot(app: TestHub, entry: string): string {
  const digest = entry.split('/')[3];
  const installed = join(app.home, 'official-plugins', 'starmap', digest, 'web');
  return existsSync(installed) ? installed : join(SOURCE, 'web');
}

/**
 * The page's own loader (plugin-slots.js) on GET /api/plugins: it takes the starmap entry, imports the selected files and
 * registers the full-page view with the package's English. Returns the view's title in Chinese and English.
 */
let loads = 0;
async function viewTitles(app: TestHub): Promise<[string, string]> {
  const list = await plugins(app);
  const entry = list.officialFrontend.find((e: { id: string }) => e.id === 'starmap');
  const served = await rawFetch(app.url + entry.entry);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), readFileSync(join(webRoot(app, entry.entry), 'index.js')), 'the page gets the file the loader imports');
  // A fresh page each time: plugin-slots.js remembers released plugins for the life of the page.
  const { loadPluginSlots, detachPluginSlots } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/plugin-slots.js')).href + '?page=' + ++loads);
  const { setLanguage } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/i18n.js')).href);
  const slots = await loadPluginSlots({ ...list, officialFrontend: [entry] }, { api: async () => ({}) }, async () => ({ register: () => ({}) }), undefined, () => true, {
    loadOfficial: (path: string) => import(pathToFileURL(join(webRoot(app, path), posix.relative(posix.dirname(entry.entry), path))).href),
    loadEnglish: async (path: string) => (await rawFetch(app.url + path)).json(),
  });
  try {
    const view = slots.view.find((v: { pluginId: string }) => v.pluginId === 'starmap');
    assert.ok(view, 'the star map view registered');
    const zh = view.title();
    setLanguage('en');
    return [zh, view.title()];
  } finally {
    setLanguage('zh');
    detachPluginSlots(slots, ['starmap']);
  }
}

/** Every served file of the selected web/ comes from this Hub: same bytes, no-store, and module imports stay inside it. */
async function servedOffline(app: TestHub) {
  const { entry } = await entryOf(app);
  const base = new URL(entry, app.url);
  const root = webRoot(app, entry);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => f.replaceAll('\\', '/'))
    .filter((f) => /\.(?:js|css|json|svg|md)$/.test(f));
  assert.ok(files.includes('vendor/three/three.module.min.js') && files.includes('vendor/three/addons/OrbitControls.js'));
  assert.ok(existsSync(join(root, 'vendor/three/LICENSE')), 'the three.js license ships with the package');
  const seen = new Set<string>();
  for (const file of files) {
    const res = await rawFetch(new URL(file, base));
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('cache-control'), 'no-store', file);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', file);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, readFileSync(join(root, file)), file);
    if (!file.endsWith('.js')) continue;
    const imports = /^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const match of bytes.toString('utf8').matchAll(imports)) {
      const spec = match[1] ?? match[2] ?? match[3];
      seen.add(file + ' -> ' + spec);
      assert.ok(spec === '/plugin-host/v1.js' || (/^\.\.?\//.test(spec) && files.includes(posix.join(posix.dirname(file), spec))), `${file} imports ${spec}`);
    }
  }
  for (const link of ['index.js -> ./vendor/three/three.module.min.js', 'vendor/three/addons/OrbitControls.js -> ../three.module.min.js',
    'scene.js -> /plugin-host/v1.js']) assert.ok(seen.has(link), link);
}

test('star map package: the built-in copy and every t() text of the package have their English in the package', () => {
  const english = JSON.parse(readFileSync(join(SOURCE, 'web/i18n/en.json'), 'utf8'));
  const web = join(SOURCE, 'web');
  for (const file of readdirSync(web).filter((f) => f.endsWith('.js'))) {
    for (const [, , msgid] of readFileSync(join(web, file), 'utf8').matchAll(/\bl?t\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g)) {
      assert.equal(typeof english[msgid], 'string', `${file}: ${msgid}`);
    }
  }
  // The theme names and notes are msgids too (themes.js); so are the plugin's own name and texts on the settings card.
  for (const msgid of ['星图', '暗月', '群星', '炽阳', '深蓝夜空', '在星图中按需查看成员当前绑定的原生对话。']) assert.equal(typeof english[msgid], 'string', msgid);
});

test('star map package: built-in by default, two signed versions through the settings API, the switch kept across restarts', async () => {
  const { start, fetched } = releases();
  const program = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  const desktop = readFileSync(join(REPO_ROOT, 'desktop/package.json'), 'utf8');
  let app = await start();
  try {
    // A fresh Hub: the built-in copy, off; no page module, no route; the settings card still has its icon and English.
    let row = await card(app);
    assert.deepEqual([row.version, row.enabled, row.officialUpdate.source, row.iconUrl, row.officialUpdate.english.name],
      [release.version, false, 'bundled', '/api/plugins/starmap/icon', 'Star map']);
    assert.equal(await entryOf(app), undefined);
    const { cluster, members: [reader] } = await app.cluster('sky', ['reader']);
    const path = transcriptPath(cluster.id, reader.id);
    assert.equal((await fetch(app.url + path)).status, 404);
    await app.api('PUT', '/api/plugins/starmap', { enabled: true });
    await app.close();

    // Enabled: the built-in copy's view loads from its payload, through the same loader and route a package uses.
    app = await start();
    const builtIn = (await entryOf(app)).entry;
    assert.deepEqual(await viewTitles(app), ['星图', 'Star map']);
    await servedOffline(app);
    assert.equal((await app.api('GET', path)).status, 'unsupported', 'the mock session has no transcript of its own');

    // Settings: check, prepare and confirm 2.0.1. Until the restart the built-in copy keeps running.
    await stage(app, '2.0.1');
    row = await card(app);
    assert.deepEqual([row.version, row.officialUpdate.source, row.officialUpdate.pendingVersion], [release.version, 'bundled', '2.0.1']);
    assert.equal((await entryOf(app)).entry, builtIn);
    await assert.rejects(app.api('POST', UPDATE + '/prepare', { id: 'starmap', version: '2.0.2' }), /OFFICIAL_RESTART_PENDING/);
    await app.close();

    // Restart: only the star map changed. Hub and desktop versions are the same files, the switch stayed on.
    const downloads = fetched.length;
    app = await start();
    assert.equal(fetched.length, downloads, 'activation reads the local copy only');
    row = await card(app);
    assert.deepEqual([row.version, row.enabled, row.officialUpdate.source, row.officialUpdate.pendingVersion], ['2.0.1', true, 'package', undefined]);
    assert.deepEqual(readPluginsFile(app.home).enabled, ['starmap']);
    assert.equal(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'), program);
    assert.equal(readFileSync(join(REPO_ROOT, 'desktop/package.json'), 'utf8'), desktop);
    const v1 = state(app).active.starmap;
    assert.equal(v1.version, '2.0.1');
    assert.equal((await entryOf(app)).entry, builtIn.replace(/[0-9a-f]{64}/, v1.digest));
    assert.equal((await rawFetch(app.url + builtIn)).status, 404, 'the old copy\'s files are gone with it');
    assert.deepEqual(await viewTitles(app), ['星图', 'Star map']);
    await servedOffline(app);
    await transcriptRoute(app, cluster.id, reader);

    // 2.0.2 differs where a user sees it: its English title.
    await stage(app, '2.0.2');
    await app.close();
    app = await start();
    row = await card(app);
    assert.deepEqual([row.version, row.enabled, row.officialUpdate.english.name], ['2.0.2', true, 'Star map 2.0.2']);
    assert.deepEqual(state(app).previous.starmap, v1);
    assert.deepEqual(await viewTitles(app), ['星图', 'Star map 2.0.2']);
    const { entry } = await entryOf(app);
    // The real artifact's pure modules work from where the Hub keeps them.
    const T = await import(pathToFileURL(join(webRoot(app, entry), 'transcript.js')).href);
    assert.equal(T.transcriptPath('c 1', 'm'), '/api/clusters/c%201/members/m/transcript?limit=50');
    assert.equal(program, readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

    // Switched off: the version stays, the page module, its files and the route are gone.
    await app.api('PUT', '/api/plugins/starmap', { enabled: false });
    await app.close();
    app = await start();
    row = await card(app);
    assert.deepEqual([row.version, row.enabled], ['2.0.2', false]);
    assert.equal(await entryOf(app), undefined);
    assert.equal((await rawFetch(app.url + entry)).status, 404);
    assert.equal((await fetch(app.url + path)).status, 404);
  } finally { await app.close(); }
});

/** The package's route: login, the cluster's active member, its query checks, paging and no-store. */
async function transcriptRoute(app: TestHub, clusterId: string, reader: { id: string; workerSessionId: string }) {
  const { cluster: other } = await app.cluster('other', ['other']);
  const path = transcriptPath(clusterId, reader.id);
  const calls: { session: string; request: TranscriptRequest }[] = [];
  app.native.transcript = async (session, request) => {
    calls.push({ session, request });
    return { status: 'ok', items: [{ id: 'one', kind: 'assistant', text: 'synthetic' }], after: 'adapter-after', hasMore: false, unknownCount: 0 };
  };
  assert.equal((await rawFetch(app.url + path)).status, 401);
  const wrong = await fetch(app.url + transcriptPath(other.id, reader.id));
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: 'unknown member in cluster' });
  for (const query of ['cursor=', 'limit=', 'limit=1.5', 'limit=0', `limit=${TRANSCRIPT_MAX_ITEMS + 1}`, 'limit=not-a-number',
    'direction=invalid', 'limit=3&limit=4', 'sessionId=private-path']) {
    const response = await fetch(app.url + path + '?' + query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'invalid transcript query parameters' });
  }
  assert.equal(calls.length, 0);
  const page = await fetch(app.url + path + '?direction=before&limit=2');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const body = await page.json();
  assert.deepEqual(body.items, [{ id: 'one', kind: 'assistant', text: 'synthetic' }]);
  assert.deepEqual(calls[0], { session: reader.workerSessionId, request: { direction: 'before', cursor: undefined, limit: 2 } });
  assert.equal((await app.api('GET', path + '?direction=after&cursor=' + encodeURIComponent(body.after))).status, 'ok');
  assert.equal(calls[1].request.cursor, 'adapter-after', 'the opaque Hub cursor pages on');
  assert.deepEqual(await app.api('GET', path + '?cursor=opaque-invalid'), emptyTranscriptPage('reset'));
  assert.equal(calls.length, 2, 'a refused cursor does not reach the native reader');
}

/** The official registry with the built-in star map running from a copy of its payload, which a test can damage. */
function withPayloadCopy() {
  const directory = join(tempDir(), 'starmap-payload');
  cpSync(SOURCE, directory, { recursive: true });
  const plugins = officialPlugins.map((p) => (p.id === 'starmap' ? { ...p, packageSource: { ...p.packageSource!, directory } } : p));
  const damage = () => writeFileSync(join(directory, 'web/i18n/en.json'), '{ not json');
  return { plugins, damage };
}

test('star map package: a damaged built-in payload leaves the signed package selectable; without one the Hub reports why it cannot start', async () => {
  const { start } = releases();
  const { plugins, damage } = withPayloadCopy();
  let app = await start({ plugins });
  try {
    await app.api('PUT', '/api/plugins/starmap', { enabled: true });
    await stage(app, '2.0.1');
    await app.close();
    app = await start({ plugins });
    assert.equal((await card(app)).officialUpdate.source, 'package');
    await app.close();

    damage();
    app = await start({ plugins });
    const row = await card(app);
    assert.deepEqual([row.version, row.enabled, row.officialUpdate.source], ['2.0.1', true, 'package']);
    assert.equal(row.officialUpdate.error.code, 'OFFICIAL_PACKAGE_INVALID', 'the built-in copy\'s failure is on the card');
    assert.equal(state(app).active.starmap.version, '2.0.1');
    const { cluster, members: [reader] } = await app.cluster('sky', ['reader']);
    assert.equal((await app.api('GET', transcriptPath(cluster.id, reader.id))).status, 'unsupported');
  } finally { await app.close(); }

  // No signed package to fall back on: the existing blocking diagnosis, not a raw parse error.
  const fresh = withPayloadCopy();
  fresh.damage();
  await assert.rejects(startTestHub({ plugins: fresh.plugins }), (cause: Error) => {
    assert.match(cause.message, /OFFICIAL_NO_COMPATIBLE_SET|没有兼容的启动组合/);
    assert.match(cause.message, /备份/);
    assert.notEqual(cause.name, 'SyntaxError');
    return true;
  });
});
