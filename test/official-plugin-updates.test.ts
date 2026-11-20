import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { packOfficialPlugin } from '../scripts/pack-official-plugin.ts';
import type { OfficialPlugin } from '../src/core/plugin.ts';
import { REPO_ROOT, type StartOptions } from '../src/main.ts';
import { readPluginsFile, writePluginsFile } from '../src/config.ts';
import type { OfficialManifest } from '../src/official-plugin-package.ts';
import { findBrowser, launchBrowser } from './browser.ts';
import { rawFetch, startTestHub, tempDir, TEST_TOKEN, type TestHub } from './helpers.ts';

const ID = 'package-fixture';
const KEY_ID = 'test-publisher';
const PATH = '/api/official-package-fixture';
const UPDATE = '/api/plugins/official-updates';
const CREATE = 'CREATE TABLE fixture_rows (message TEXT NOT NULL)';
const builtIn: OfficialPlugin = {
  id: ID, name: '测试插件', description: '测试用的官方包', version: '1.0.0', defaultEnabled: false,
  routes: [{ method: 'GET', pattern: /^\/api\/official-package-fixture$/, handle: () => ({ version: 'v1' }) }],
};

function zip(dir: string, version: string, privateKey: KeyObject, overrides: Partial<Omit<OfficialManifest, 'files'>> = {}): Buffer {
  const folder = join(dir, 'package-' + version);
  for (const d of ['hub', 'web/i18n', 'web/assets']) mkdirSync(join(folder, d), { recursive: true });
  writeFileSync(join(folder, 'hub/index.mjs'), [
    'export default function () { return {',
    '  migrations: [' + JSON.stringify(CREATE) + '],',
    '  routes: [{ method: "GET", pattern: /^\\/api\\/official-package-fixture$/,',
    '    handle: ({ hub }) => ({ version: ' + JSON.stringify(version) + ', rows: hub.store.db.prepare("SELECT message FROM fixture_rows ORDER BY rowid").all() }) }],',
    '}; }',
  ].join('\n'));
  writeFileSync(join(folder, 'web/index.js'), "import { name } from './assets/nested.js';\nexport function register(host) { return { view: { id: name, title: () => host.i18n.t('测试插件'), icon: 'orbit', mount() {}, unmount() {} } }; }\n");
  writeFileSync(join(folder, 'web/assets/nested.js'), "export const name = 'package-fixture';\n");
  writeFileSync(join(folder, 'web/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(folder, 'web/i18n/en.json'), JSON.stringify({ 测试插件: 'Fixture plugin', 测试用的官方包: 'Fixture for official packages' }));
  return packOfficialPlugin(folder, {
    format: 1, id: ID, version, keyId: KEY_ID, hub: { api: 1, minVersion: '0.10.0-beta.2' },
    requires: [], migrationVersion: 1, entry: 'hub/index.mjs', icon: 'web/icon.svg',
    web: { entry: 'web/index.js', english: 'web/i18n/en.json' }, ...overrides,
  }, privateKey);
}

function setup() {
  const dir = tempDir();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const available = new Map<string, Buffer>();
  const fetched: string[] = [];
  const add = (v: string, overrides?: Partial<Omit<OfficialManifest, 'files'>>, signer = privateKey) => {
    available.set(v, zip(dir, v, signer, overrides));
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    fetched.push(url.pathname);
    if (url.pathname.endsWith('/index.json')) {
      return Response.json({ format: 1, releases: [...available].map(([v, bytes]) => ({
        id: ID, version: v, tag: 'fixture-' + v, asset: 'fixture.zip', sha256: createHash('sha256').update(bytes).digest('hex'),
      })) });
    }
    const v = /\/fixture-([^/]+)\/fixture\.zip$/.exec(url.pathname)?.[1];
    return v && available.has(v) ? new Response(new Uint8Array(available.get(v)!)) : new Response(null, { status: 404 });
  };
  const opts: Partial<StartOptions> & { dir: string } = {
    dir, plugins: [builtIn], officialUpdates: { keys: new Map([[KEY_ID, { publicKey, ids: [ID] }]]), fetcher },
  };
  return { add, start: () => startTestHub(opts), dir, fetched };
}

const list = (app: TestHub) => app.api('GET', '/api/plugins');
const card = async (app: TestHub) => (await list(app)).installed.find((p: { id: string }) => p.id === ID);
const state = (app: TestHub) => JSON.parse(readFileSync(join(app.home, 'official-plugins', 'state.json'), 'utf8'));
const schema = (app: TestHub) => Number(app.store.db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?').get(ID)?.version ?? 0);

async function stage(app: TestHub, version: string) {
  const check = await app.api('POST', UPDATE + '/check', {});
  assert.ok(check.candidates.some((v: { id: string; version: string }) => v.id === ID && v.version === version));
  const preview = await app.api('POST', UPDATE + '/prepare', { id: ID, version });
  assert.equal(preview.migrationVersion, 1);
  const expected = { id: ID, version, restartRequired: true };
  assert.deepEqual(await app.api('POST', UPDATE + '/confirm', { prepareId: preview.prepareId }), expected);
  assert.deepEqual(await app.api('POST', UPDATE + '/confirm', { prepareId: preview.prepareId }), expected, 'confirmation retry is idempotent');
}

test('official updates activate the signed ZIP at restart and recover the previous compatible package without a download', async () => {
  const { add, start, fetched } = setup();
  let app = await start();
  try {
    assert.equal((await card(app)).enabled, false);
    assert.equal((await card(app)).officialUpdate.source, 'bundled');
    assert.equal((await rawFetch(app.url + UPDATE + '/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    await app.api('PUT', '/api/plugins/' + ID, { enabled: true });
    await app.close();
    app = await start();
    assert.deepEqual(await app.api('GET', PATH), { version: 'v1' });
    const { cluster } = await app.cluster('existing', ['FixtureMember']);
    add('2.0.0');
    await stage(app, '2.0.0');
    assert.equal((await card(app)).officialUpdate.pendingVersion, '2.0.0');
    assert.deepEqual(await app.api('GET', PATH), { version: 'v1' });
    assert.deepEqual((await list(app)).officialFrontend, []);
    assert.equal(schema(app), 0);
    const program = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
    await app.close();

    app = await start();
    assert.equal((await card(app)).officialUpdate.source, 'package');
    assert.equal((await card(app)).version, '2.0.0');
    assert.equal((await card(app)).officialUpdate.english.name, 'Fixture plugin');
    assert.equal((await card(app)).officialUpdate.pendingVersion, undefined);
    assert.deepEqual(readPluginsFile(app.home).enabled, [ID]);
    assert.equal(schema(app), 1);
    assert.equal(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'), program);
    assert.ok(app.store.getCluster(cluster.id));
    app.store.db.prepare('INSERT INTO fixture_rows VALUES (?)').run('retained');
    const v2 = state(app).active[ID];
    const entry = (await list(app)).officialFrontend[0];
    assert.ok(entry.entry.includes(v2.digest));
    const file = await rawFetch(app.url + entry.entry);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type') ?? '', /javascript/);
    assert.equal(file.headers.get('cache-control'), 'no-store');
    assert.equal((await rawFetch(app.url + new URL('./assets/nested.js', app.url + entry.entry).pathname)).status, 200);
    assert.equal((await rawFetch(app.url + entry.entry.replace(v2.digest, 'f'.repeat(64)))).status, 404);
    assert.equal((await rawFetch(app.url + entry.entry.replace('/index.js', '/hub/index.mjs'))).status, 404);
    assert.equal((await rawFetch(app.url + entry.entry.replace('/index.js', '/%2e%2e%2fhub%2findex.mjs'))).status, 404);
    assert.equal((await app.api('GET', PATH)).rows[0].message, 'retained');

    add('3.0.0');
    await stage(app, '3.0.0');
    await app.close();
    app = await start();
    assert.equal((await app.api('GET', PATH)).version, '3.0.0');
    assert.equal((await rawFetch(app.url + entry.entry)).status, 404, 'an old page cannot fetch assets from a replaced version');
    const { active, previous } = state(app);
    assert.deepEqual(previous[ID], v2);
    const v3 = active[ID];
    await app.close();
    writeFileSync(join(app.home, 'official-plugins', ID, v3.digest, 'web/index.js'), 'tampered');
    const downloads = fetched.length;
    app = await start();
    assert.equal(fetched.length, downloads);
    assert.equal((await app.api('GET', PATH)).version, '2.0.0');
    assert.equal((await app.api('GET', PATH)).rows[0].message, 'retained');
    assert.equal((await card(app)).officialUpdate.error.code, 'OFFICIAL_PACKAGE_INVALID');
    assert.deepEqual(state(app).active[ID], v2);
    assert.equal(state(app).previous?.[ID], undefined);
    assert.equal(schema(app), 1);

    await app.api('PUT', '/api/plugins/' + ID, { enabled: false });
    await app.close();
    app = await start();
    assert.equal((await card(app)).version, '2.0.0');
    assert.equal((await card(app)).enabled, false);
    assert.deepEqual((await list(app)).officialFrontend, []);
    assert.equal((await rawFetch(app.url + entry.entry)).status, 404);
    assert.equal((await fetch(app.url + (await card(app)).iconUrl)).status, 200, 'settings can still show the icon');
    await app.close();
    writeFileSync(join(app.home, 'official-plugins', ID, v2.digest, 'hub/index.mjs'), 'tampered');
    await assert.rejects(start(), /OFFICIAL_NO_COMPATIBLE_SET|没有兼容的启动组合.*备份/);
  } finally { await app.close(); }
});

const browser = findBrowser();
test('the real settings page reviews a signed ZIP and loads its webpage after Hub restart',
  { skip: !browser.path && process.env.ORRERY_REQUIRE_BROWSER !== '1' }, async () => {
  assert.ok(browser.path);
  const { add, start, dir } = setup();
  add('2.0.0');
  mkdirSync(join(dir, 'home'));
  writePluginsFile(join(dir, 'home'), { enabled: [ID] });
  let app = await start();
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    launched = await launchBrowser(browser.path, { redact: [TEST_TOKEN] });
    const { page } = launched;
    const open = () => page.navigate(app.url + '/?uiLang=en#token=' + TEST_TOKEN);
    const click = async (selector: string, label: string) => {
      await page.waitFor(selector, label);
      await page.click(selector, label);
    };
    await open();
    await click("document.getElementById('open-settings')", 'open settings');
    await click("document.getElementById('settings-tab-plugins')", 'plugins tab');
    await click("document.querySelector('[data-official-update-check]')", 'check for official updates');
    await click("document.querySelector('[data-plugin-update=package-fixture]')", 'review fixture ZIP');
    await click("[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Confirm update')", 'confirm fixture ZIP');
    await page.waitFor("document.getElementById('plugin-list').textContent.includes('Version 2.0.0 after restart')", 'pending version');
    assert.equal((await app.api('GET', PATH)).version, 'v1');
    await app.close();
    app = await start();
    await open();
    await click("document.querySelector('button[aria-label=\"Fixture plugin\"]')", 'fixture view uses signed nested modules and translation');
    await page.waitFor("document.getElementById('plugin-view-title').textContent === 'Fixture plugin'", 'selected package title');
    assert.equal((await app.api('GET', PATH)).version, '2.0.0');
  } finally {
    await launched?.close();
    await app.close();
  }
});

test('an impostor, a bad signature and an incompatible signed manifest cannot install over an official plugin', async () => {
  const { add, start } = setup();
  add('2.0.0', {}, generateKeyPairSync('ed25519').privateKey);
  add('3.0.0', { hub: { api: 1, minVersion: '99.0.0' } });
  add('4.0.0', { requires: [{ id: 'absent-dependency', minVersion: '1.0.0' }] });
  const app = await start();
  try {
    await app.api('POST', UPDATE + '/check', {});
    await assert.rejects(app.api('POST', UPDATE + '/prepare', { id: ID, version: '2.0.0' }), /OFFICIAL_PACKAGE_INVALID/);
    await assert.rejects(app.api('POST', UPDATE + '/prepare', { id: ID, version: '3.0.0' }), /OFFICIAL_HUB_INCOMPATIBLE/);
    await assert.rejects(app.api('POST', UPDATE + '/prepare', { id: ID, version: '4.0.0' }), /OFFICIAL_DEPENDENCY_CONFLICT/);
    await assert.rejects(app.api('POST', UPDATE + '/prepare', { id: 'impostor', version: '4.0.0' }), /OFFICIAL_RELEASE_INVALID/);
    assert.equal((await card(app)).version, '1.0.0');
    assert.equal((await card(app)).officialUpdate.pendingVersion, undefined);
    assert.equal(schema(app), 0);
  } finally { await app.close(); }
});
