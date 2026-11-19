import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { findBrowser, launchBrowser } from './browser.ts';

const found = findBrowser();
const skip = !found.path && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? 'no supported browser' : false;
const root = resolve(import.meta.dirname, '..');

test('plugin installer reviews sources, grants only checked scopes, uploads archives, cancels stages and translates UI', { skip, timeout: 90_000 }, async (test) => {
  assert.ok(found.path);
  const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/settings.css"></head>
    <body><main class="settings-dialog" style="max-width:720px;margin:24px auto;padding:16px"><div id="install"></div></main><script type="module">
    import { mountPluginInstall } from '/plugin-install.js';
    import { setLanguage } from '/i18n.js';
    window.calls = []; window.mode = 'normal'; window.failConfirm = false; window.installed = 0;
    let serial = 0;
    window.api = async (method, path, body, options) => {
      window.calls.push({ method, path, body: body instanceof ArrayBuffer ? [...new Uint8Array(body)] : body, options });
      if (method === 'DELETE') { if (window.failCancel) throw Error('cleanup failed'); return {}; }
      if (path === '/api/clusters') return [{ id: 'c1', name: '用户中文群' }, { id: 'c2', name: 'Second cluster' }];
      if (path.includes('/confirm')) { if (window.failConfirm) throw Error('permission save failed'); return { restartRequired: true }; }
      if (window.mode === 'multi' && !(body?.manifestPath || path.includes('manifestPath='))) {
        throw Object.assign(Error('choose a manifest'), { data: { code: 'MANIFEST_SELECTION_REQUIRED', manifestPaths: ['one/orrery-plugin.json', 'two/orrery-plugin.json'] } });
      }
      if (window.mode === 'held') await new Promise((resolve) => { window.releasePrepare = resolve; });
      return { id: 'stage-' + (++serial), manifestPath: 'orrery-plugin.json', digest: 'sha256:abc', restartRequired: true,
        source: { kind: body instanceof ArrayBuffer ? 'upload' : 'github', requested: body?.source || '中文包.zip', resolved: 'https://github.com/example/plugin/tree/commit' },
        manifest: { id: 'example', name: '<b data-test-plugin-name>Example plugin</b>', description: '用户中文描述', version: '1.0.0', requires: ['tasks'],
          permissions: ['clusters.read','messages.read','events.read','messages.send','messages.mention','tools.provide','ui.show'], events: ['message.created','task.submitted'],
          memberTools: [{ name: 'echo' }, { name: 'count' }], ui: { positions: ['titlebar','workbench'] } } };
    };
    window.mount = (locale = 'en') => { setLanguage(locale); window.view = mountPluginInstall(document.querySelector('#install'), {
      api: window.api, onInstalled: () => { window.installed++; } }); };
    window.mount();
    </script></body></html>`;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(pageHtml); return; }
    const relative = path === '/core/system-kinds.js' ? 'src/core/system-kinds.js'
      : path.startsWith('/shared/') ? path.slice(1) : join('src/web/public', path.slice(1));
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    try {
      res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  test.after(() => new Promise<void>((done) => server.close(() => done())));
  const browser = await launchBrowser(found.path!);
  test.after(() => browser.close());
  const page = browser.page;
  await page.navigate(`http://127.0.0.1:${(server.address() as any).port}/`);
  await page.waitFor(`document.querySelector('[data-install-prepare]')`, 'installer');
  const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const prepare = async (source = '@example/plugin') => {
    await page.type(`document.querySelector('input[type=text]')`, source, 'source');
    await click('[data-install-prepare]');
    await page.waitFor(`document.querySelector('[data-install-confirm]')`, 'review');
  };
  assert.equal(await page.evaluate('window.view.hasDraft()'), false);
  await prepare();
  assert.equal(await page.evaluate('window.view.hasDraft()'), true);
  assert.equal(await page.evaluate(`document.querySelectorAll('#install [data-test-plugin-name]').length`), 0, 'manifest text is rendered as plain text');
  assert.match(await page.evaluate<string>(`document.querySelector('#install').textContent`), /用户中文描述/);
  assert.equal(await page.evaluate(`document.querySelectorAll('#install input:checked').length`), 0, 'all grants begin unchecked');
  assert.equal(await page.evaluate(`document.querySelector('[data-install-choice="messages.mention"]').disabled`), true);
  await click('[data-install-choice="messages.send"]');
  await click('[data-install-choice="messages.mention"]');
  await click('[data-install-choice="events.read"]');
  await click('[data-install-choice="message.created"]');
  await page.evaluate(`const scopes = [...document.querySelectorAll('fieldset')].filter(f => f.querySelector('legend')?.textContent.startsWith('Clusters'));
    scopes[0].querySelector('[data-install-choice=c1]').click(); scopes[1].querySelector('[data-install-choice=c2]').click();`);
  await click('[data-install-choice="messages.send"]');
  assert.equal(await page.evaluate(`document.querySelector('[data-install-choice="messages.mention"]').checked`), false, 'revoking send also revokes mention');
  await click('[data-install-choice="messages.send"]');
  await click('[data-install-choice="tools.provide"]');
  await click('[data-install-choice="echo"]');
  await click('[data-install-choice="ui.show"]');
  await click('[data-install-choice="workbench"]');
  await page.evaluate(`window.failConfirm = true`);
  await click('[data-install-confirm]');
  await page.waitFor(`document.querySelector('[role=alert]')?.textContent === 'permission save failed'`, 'confirmation failure');
  await page.evaluate(`window.failConfirm = false`);
  await click('[data-install-confirm]');
  await page.waitFor(`window.installed === 1`, 'confirmed installation');
  assert.deepEqual(await page.evaluate(`window.calls.filter(c=>c.path.includes('/confirm')).at(-1).body`), {
    permissions: ['events.read', 'messages.send', 'tools.provide', 'ui.show'], events: ['message.created'], clusterIds: ['c1'], writeClusterIds: [],
    tools: ['echo'], ui: ['workbench'],
  });
  assert.match(await page.evaluate<string>(`document.querySelector('#install').textContent`), /Installed, awaiting Hub restart/);
  assert.equal(await page.evaluate('window.view.hasDraft()'), false);

  await page.evaluate(`window.mount('zh'); window.mode = 'multi'; document.querySelector('input[value=file]').click();
    const files = new DataTransfer(); files.items.add(new File([new Uint8Array([80,75,1,2])], '中文包.zip'));
    const input = document.querySelector('input[type=file]'); input.files = files.files; input.dispatchEvent(new Event('change'));`);
  await click('[data-install-prepare]');
  await page.waitFor(`document.querySelectorAll('[data-install-manifest]').length === 2`, 'manifest choice');
  await click('[data-install-manifest="two/orrery-plugin.json"]');
  await page.waitFor(`document.querySelector('[data-install-confirm]')`, 'upload review');
  const upload = await page.evaluate<any>(`window.calls.filter(c=>c.path.includes('manifestPath=')).at(-1)`);
  assert.deepEqual(upload.body, [80, 75, 1, 2]);
  assert.equal(upload.options.headers['x-file-name'], encodeURIComponent('中文包.zip'));
  assert.match(upload.path, /manifestPath=two%2Forrery-plugin.json/);
  assert.match(await page.evaluate<string>(`document.querySelector('#install').textContent`), /确认安装/);

  if (process.env.ORRERY_SHOTS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const path = join(process.env.ORRERY_SHOTS, 'plugin-install-review.png');
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(shot.data, 'base64'));
  }
  await page.evaluate(`window.failCancel = true`);
  await click('[data-install-cancel]');
  await page.waitFor(`document.querySelector('[role=alert]')?.textContent === 'cleanup failed'`, 'cleanup failure');
  await page.evaluate(`window.failCancel = false`);
  await click('[data-install-cancel]');
  await page.waitFor(`document.querySelector('[data-install-prepare]')`, 'cancelled stage');
  assert.ok(await page.evaluate(`window.calls.some(c=>c.method==='DELETE')`));

  await page.evaluate(`window.mode = 'held'; document.querySelector('input[value=source]').click();`);
  await page.type(`document.querySelector('input[type=text]')`, 'example-plugin', 'pending source');
  await click('[data-install-prepare]');
  await page.waitFor(`window.releasePrepare`, 'pending preparation');
  const deletes = await page.evaluate<number>(`window.calls.filter(c=>c.method==='DELETE').length`);
  await page.evaluate(`(async () => { window.disposed = window.view.dispose(); window.releasePrepare(); await window.disposed; })()`);
  assert.equal(await page.evaluate(`window.calls.filter(c=>c.method==='DELETE').length`), deletes + 1, 'closing during prepare cancels the returned stage');
  assert.equal(await page.evaluate(`document.querySelector('#install').childElementCount`), 0);
  assert.deepEqual(browser.problems(), { console: [], exceptions: [] });
});
