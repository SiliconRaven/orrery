import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findBrowser, launchBrowser } from './browser.ts';

const root = resolve(import.meta.dirname, '..');
const pub = join(root, 'src/web/public');
const browser = findBrowser();
const skipBrowser = !browser.path && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? 'no supported browser' : false;

test('signed package slots use the selected digest and their own live translations', async () => {
  const { detachPluginSlots, loadPluginSlots, staleOfficialPackages } = await import(pathToFileURL(join(pub, 'plugin-slots.js')).href);
  const { setLanguage, t } = await import(pathToFileURL(join(pub, 'i18n.js')).href);
  const { h, markdownBlocks, openTrash } = await import(pathToFileURL(join(pub, 'plugin-host/v1.js')).href);
  for (const helper of [h, markdownBlocks, openTrash]) assert.equal(typeof helper, 'function');

  const base = '/official-plugin-web/packaged-ui/' + 'a'.repeat(64) + '/';
  const entry = base + 'index.mjs';
  const english = base + 'i18n/en.json';
  const list = {
    plugins: [{ id: 'packaged-ui' }, { id: 'wrong-origin' }, { id: 'escape' }, { id: 'other-words' }],
    frontend: ['packaged-ui'],
    trustedFrontend: ['packaged-ui'],
    officialFrontend: [
      { id: 'packaged-ui', entry, english },
      { id: 'wrong-origin', entry: 'https://example.invalid/index.js' },
      { id: 'escape', entry: '/official-plugin-web/escape/' + 'a'.repeat(64) + '/nested/%2e%2e/index.js' },
      { id: 'other-words', entry: '/official-plugin-web/other-words/' + 'a'.repeat(64) + '/index.js', english },
      { id: 'disabled', entry: '/official-plugin-web/disabled/' + 'a'.repeat(64) + '/index.js' },
    ],
  };
  let translated: any;
  let switches = 0;
  const imports: string[] = [];
  const slots = await loadPluginSlots(list, { api: async () => ({}) },
    () => assert.fail('selected package must replace bundled entry'), () => assert.fail('not a third-party entry'),
    (icon: string) => icon === 'orbit', {
      async loadEnglish(path: string) { assert.equal(path, english); return { 确定: 'Package label', '版本 {version}': 'Version {version}' }; },
      async loadOfficial(path: string) {
        imports.push(path);
        return { register(host: any) {
          host.i18n.onLanguageChange(() => { switches++; });
          translated = host.i18n.lt('版本 {version}', { version: '2.0.0' });
          return { view: { id: 'packaged-ui', icon: 'orbit', title: () => host.i18n.t('确定'), mount() {}, unmount() {} } };
        } };
      },
    });
  try {
    assert.deepEqual(imports, [entry]);
    assert.equal(slots.view[0].trusted, false, 'official view keeps its official label');
    setLanguage('en');
    assert.equal(slots.view[0].title(), 'Package label');
    assert.equal(t('确定'), 'OK', 'package dictionary does not change the host language table');
    assert.equal(String(translated), 'Version 2.0.0');
    assert.equal(switches, 1);
    assert.deepEqual(staleOfficialPackages(slots, list), []);
    const replacement = { ...list, officialFrontend: [{ id: 'packaged-ui', entry: entry.replace('a'.repeat(64), 'b'.repeat(64)) }] };
    assert.deepEqual(staleOfficialPackages(slots, replacement), ['packaged-ui']);
    detachPluginSlots(slots, ['packaged-ui']);
    assert.equal(slots.view.length, 0);
    setLanguage('zh');
    assert.equal(switches, 1, 'released package no longer observes language switches');
  } finally {
    detachPluginSlots(slots, ['packaged-ui']);
    setLanguage('zh');
  }
});

test('official settings check, cancel and confirm a verified update before displaying its pending version', { skip: skipBrowser }, async (ctx) => {
  assert.ok(browser.path);
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>
    <main id="list"></main><script type="module">
    import { createPluginSettings } from '/plugins.js';
    import { setLanguage } from '/i18n.js';
    setLanguage('en');
    const prefix = '/api/plugins/official-updates';
    let pending;
    window.calls = [];
    window.fail = false;
    const api = async (method, path, body) => {
      window.calls.push({ method, path, body });
      if (path === '/api/plugins') return { instance: 'test', installed: [
        { id: 'fixture', name: '测试插件', description: '说明', version: '1.0.0', requires: [], enabled: false, pendingEnabled: false,
          officialUpdate: { source: 'package', english: { name: 'Fixture plugin', description: 'Package description' }, pendingVersion: pending } },
        { id: 'another', name: 'Another plugin', version: '1.0.0', requires: [], enabled: true, pendingEnabled: true,
          officialUpdate: { source: 'bundled' } },
      ] };
      if (path === prefix + '/check') {
        if (window.fail) throw new Error('catalog unavailable');
        return { candidates: [{ id: 'fixture', version: '2.0.0', compatible: true }, { id: 'another', version: '3.0.0', compatible: false }] };
      }
      if (path === prefix + '/prepare') return { prepareId: 'stage-1', id: body.id, version: body.version, migrationVersion: 3, restartRequired: true };
      if (path === prefix + '/confirm') { pending = '2.0.0'; return { id: 'fixture', version: pending, restartRequired: true }; }
      if (path === prefix + '/prepared/stage-1' && method === 'DELETE') return {};
      throw new Error('unexpected request');
    };
    await createPluginSettings(api, document.querySelector('#list')).load();
    </script></body></html>`;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }
    const file = resolve(path.startsWith('/shared/') || path.startsWith('/core/') ? root : pub,
      path.startsWith('/core/') ? 'src' + path : path.slice(1));
    if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    try {
      const bytes = readFileSync(file);
      res.setHeader('content-type', 'text/javascript');
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  ctx.after(() => new Promise<void>((done) => server.close(() => done())));
  const launched = await launchBrowser(browser.path);
  ctx.after(() => launched.close());
  const page = launched.page;
  await page.navigate(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const check = '[data-official-update-check]';
  const review = '[data-plugin-update=fixture]';
  const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const button = (text: string) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === ${JSON.stringify(text)}).click()`);
  await page.waitFor(`document.querySelector('${check}')`, 'check action');
  assert.equal(await page.evaluate("window.calls.length"), 1, 'opening settings does not fetch the catalog');
  assert.match(await page.evaluate<string>('document.querySelector("#list").textContent'), /Fixture plugin/);
  await click(check);
  await page.waitFor(`document.querySelector('${review}')`, 'compatible candidate can be reviewed');
  assert.match(await page.evaluate<string>('document.querySelector("#list").textContent'), /Version 3\.0\.0 is incompatible/);
  await click(review);
  await page.waitFor("document.querySelector('dialog[open]')?.textContent.includes('3 migration steps')", 'review dialog');
  await button('Cancel');
  await page.waitFor("window.calls.some(c => c.method === 'DELETE')", 'discarded preparation');
  assert.equal(await page.evaluate("window.calls.filter(c => c.path.endsWith('/confirm')).length"), 0);
  await page.waitFor(`!document.querySelector('${review}').disabled`, 'review restored after cancellation');
  await click(review);
  await page.waitFor("document.querySelector('dialog[open]')?.textContent.includes('Confirm update')", 'second review');
  await button('Confirm update');
  await page.waitFor("document.querySelector('#list').textContent.includes('Version 2.0.0 after restart')", 'new version pending');
  assert.match(await page.evaluate<string>('document.querySelector("article").textContent'), /Fixture plugin 1\.0\.0/);
  assert.equal(await page.evaluate("document.querySelector('[data-plugin=fixture]').checked"), false, 'update preserves its disabled switch');
  assert.deepEqual(await page.evaluate("window.calls.find(c => c.path.endsWith('/confirm')).body"), { prepareId: 'stage-1' });
  await page.evaluate("window.fail = true");
  await click(check);
  await page.waitFor("document.querySelector('dialog[open]')?.textContent.includes('catalog unavailable')", 'check failure');
  assert.match(await page.evaluate<string>('document.querySelector("#list").textContent'), /Version 2\.0\.0 after restart/);
  assert.deepEqual(launched.problems(), { console: [], exceptions: [] });
});
