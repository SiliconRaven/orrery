// A third-party plugin's own web UI in the real page (headless, test/browser.ts; docs/external-plugins.md「网页界面」):
// the frame cannot read the page's cookie, storage or DOM, reach the Hub's API, load or send anything elsewhere, open
// windows or navigate the page or itself away (a canary server on another port must see no request at all), while its
// own scripts, module scripts, styles and images load under the frame policy. Both positions render in the three themes
// at 1440 and 375 px; the placeholders appear (not running, load timeout, files missing, turned off); turning the switch
// off removes an open frame at once. Uses the shared profile slots; run this file alone (--test-concurrency=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { findBrowser, launchBrowser, type Browser, type Page } from './browser.ts';
import { rawFetch, startTestHub, tempDir, TEST_TOKEN, waitFor, type TestHub } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;
const SHOTS = join(REPO_ROOT, '.tmp', 'plugin-ui-shots');

function setup(): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const store = new Store(join(dir, 'test.db'));
  store.insertCluster({ id: 'c1', name: '界面群', category: '', createdAt: '2026-01-01' }, [{ id: 'c1-Alice', clusterId: 'c1', name: 'Alice', avatar: '',
    harness: 'mock', model: null, effort: null, workerSessionId: 'c1-Alice', cwd: dir, origin: 'attached' as const, removedAt: null }]);
  store.close();
  const copy = (from: string, id: string) => {
    const folder = join(dir, 'plugins', id);
    cpSync(from, folder, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(folder, 'orrery-plugin.json'), 'utf8'));
    manifest.id = id;
    manifest.name = { 'ui-silent': '不就绪的界面', 'ui-nofiles': '没有界面文件' }[id] ?? manifest.name;
    writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify(manifest));
    return folder;
  };
  const probe = join(REPO_ROOT, 'test', 'fixtures', 'ui-probe');
  copy(join(REPO_ROOT, 'examples', 'hub-plugins', 'ui-demo'), 'ui-demo');
  copy(probe, 'ui-probe');
  writeFileSync(join(copy(probe, 'ui-silent'), 'ui', 'index.html'), '<!doctype html><p>never ready</p>');
  rmSync(join(copy(probe, 'ui-nofiles'), 'ui'), { recursive: true });
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: ['ui-demo', 'ui-probe', 'ui-silent', 'ui-nofiles'].map((id) => ({
    manifest: join(dir, 'plugins', id, 'orrery-plugin.json'), permissions: ['ui.show'], ui: ['titlebar', 'workbench'], clusterIds: ['c1'] })) }));
  return dir;
}

const received = async (app: TestHub, plugin = 'ui-probe') =>
  (await app.api('POST', `/api/plugins/${plugin}/invoke`, { command: 'requests', arguments: {} })).result.requests.map((r: any) => r.data);

/**
 * The value of `expression` inside the plugin UI frame the page's `iframe` element shows (DevTools, for the test only;
 * the sandboxed frame runs in its own process). null while that frame is not there yet.
 */
async function inFrame<T>(page: Page, iframe: string, expression: string): Promise<T | null> {
  const src = await page.evaluate<string | null>(`${iframe}?.src ?? null`);
  return src ? page.frameEvaluate<T>(src, expression) : null;
}

test('browser: plugin UI frames are isolated, render at both positions in every theme and width, and follow the plugin', { skip, timeout: 240_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const hits: string[] = [];
  const canary = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { 'access-control-allow-origin': '*' }).end('x'); });
  await new Promise<void>((ok) => canary.listen(0, '127.0.0.1', ok));
  const canaryUrl = `http://127.0.0.1:${(canary.address() as AddressInfo).port}`;
  const app = await startTestHub({ dir: setup() });
  let browser: Browser | null = null;
  let step = 'setup';
  const shot = async (name: string) => {
    const { data } = await browser!.page.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  try {
    await waitFor(async () => (await app.api('GET', '/api/plugins')).installed.filter((p: any) => p.origin === 'external')
      .every((p: any) => p.runtime?.state === 'ready'), 'the plugins', 15_000);
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const size = (width: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: false });
    const chip = (id: string) => `document.querySelector('[data-plugin-chip="${id}"] .pui-chip')`;
    const shell = (id: string, position: string) => `document.querySelector('[data-plugin-ui="${id}"][data-position="${position}"]')`;
    const iframe = (id: string, position: string) => `${shell(id, position)}?.querySelector('iframe')`;
    const placeholder = (id: string, position: string, code: string) => `${shell(id, position)}?.querySelector('[data-placeholder="${code}"]')`;
    const closePanel = `document.querySelector('.pui-panel .pui-close')?.click()`;

    step = 'open the cluster';
    await size(1440);
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === '界面群')`;
    await page.waitFor(item, 'the cluster');
    await page.click(item, 'the cluster');
    await page.waitFor(`${chip('ui-demo')} && ${chip('ui-probe')}`, 'the plugin chips in the title bar');
    // Every plugin chip carries the host's mark and says it is a third-party plugin, whatever the plugin calls itself.
    for (const id of ['ui-demo', 'ui-probe']) {
      assert.equal(await page.evaluate(`Boolean(${chip(id)}.querySelector('svg.ico use[href="#i-layers"]'))`), true, `${id}: the mark`);
      assert.match(await page.evaluate<string>(`${chip(id)}.textContent`), /^第三方插件：/, `${id}: its accessible name`);
    }
    const pageUrl = await page.evaluate<string>('location.href');
    await page.evaluate(`globalThis.violations = []; document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI))`);

    step = 'the probe frame: init, then everything it must not do';
    await page.click(chip('ui-probe'), 'the probe chip');
    await page.waitFor(iframe('ui-probe', 'titlebar'), 'the probe frame');
    const title = await page.evaluate<string>(`${iframe('ui-probe', 'titlebar')}.title`);
    assert.equal(title, '界面探针（测试用） · 标题栏面板');
    assert.equal(await page.evaluate(`${iframe('ui-probe', 'titlebar')}.getAttribute('sandbox')`), 'allow-scripts');
    assert.equal(await page.evaluate(`${shell('ui-probe', 'titlebar')}.querySelector('.pui-tag').textContent`), '第三方插件');
    const init = await waitFor(async () => (await received(app)).find((d: any) => d.kind === 'init'), 'the init report', 15_000);
    assert.equal(init.position, 'titlebar');
    assert.equal(init.clusterId, 'c1');
    assert.equal(init.language, 'zh-CN');
    assert.match(init.theme.colors.bg, /^rgb/);
    const probeFrameId = await page.evaluate<string>(`new URL(${iframe('ui-probe', 'titlebar')}.src).pathname.split('/')[2]`);
    await app.api('POST', '/api/plugins/ui-probe/invoke', { command: 'raw', arguments: { method: 'host.ui.push', params: { clusterId: 'c1', position: 'titlebar', data: { canary: canaryUrl } } } });
    const probe = await waitFor(async () => (await received(app)).find((d: any) => d.kind === 'probe'), 'the probe results', 20_000);
    const r = probe.results;
    assert.equal(r.origin, 'null', 'an opaque origin');
    assert.equal(r.parentDocument, 'threw:SecurityError', 'no access to the page DOM');
    assert.equal(r.cookie, 'threw:SecurityError', 'no cookie');
    assert.equal(r.localStorage, 'threw:SecurityError', 'no localStorage');
    assert.equal(r.sessionStorage, 'threw:SecurityError', 'no sessionStorage');
    assert.equal(r.windowOpen, 'null', 'no new window');
    assert.match(r.fetchHub, /^rejected:/, 'no Hub API');
    assert.match(r.fetchCanary, /^rejected:/, 'no outside request');
    assert.equal(r.externalScript, 'blocked');
    assert.equal(r.externalImage, 'blocked');
    assert.equal(r.inlineScript, 'blocked', 'only scripts from its own prefix');
    assert.equal(r.ownImage, 'loaded', 'its own image');
    assert.equal(r.style, 'rgb(1, 2, 3)', 'its own stylesheet');
    assert.equal(r.module, 'loaded', 'its own module script');
    // The probe then took its frame to the canary: the page's frame-src stops it. Nothing ever reached the canary.
    await page.waitFor(`violations.some((v) => v.startsWith('frame-src') && v.includes('${canaryUrl}'))`, 'the blocked frame navigation', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(hits, [], 'no request reached the outside server (script, image, fetch, window, top or frame navigation)');
    assert.equal(await page.evaluate('location.href'), pageUrl, 'the page was not navigated');

    step = 'only the page\'s own frames are heard: a message from another window is ignored';
    const heard = (await received(app)).length;
    await page.evaluate(`(() => {
      const forged = { type: 'orrery.request', id: 'forged', data: { action: 'echo', forged: true } };
      window.postMessage(forged, '*');
      const other = document.createElement('iframe');   // about:blank, not a plugin frame of this page
      document.body.append(other);
      other.contentWindow.parent.postMessage(forged, '*');
      other.contentWindow.eval('parent.postMessage({ type: "orrery.ready" }, "*")');
      other.remove();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal((await received(app)).length, heard, 'nothing reached the plugin');
    await page.evaluate(closePanel);
    await page.waitFor(`!document.querySelector('.pui-panel')`, 'the panel closed');
    // The page gives the id back with a request it does not wait for, so the panel can be gone before the Hub hears it.
    await waitFor(async () => (await rawFetch(`${app.url}/plugin-ui/${probeFrameId}/index.html`)).status === 404, 'closing to give the frame id back', 10_000);

    step = 'the example: one request, one push to the other position, the chip';
    await page.click(chip('ui-demo'), 'the example chip');
    await page.waitFor(iframe('ui-demo', 'titlebar'), 'the example panel frame');
    await page.click(`document.getElementById('open-workbench')`, 'the workbench');
    const tabButton = `document.querySelector('[data-wb-plugin-tab="ui-demo"]')`;
    await page.waitFor(tabButton, 'the example tab');
    assert.equal(await page.evaluate(`Boolean(${tabButton}.querySelector('svg.ico use[href="#i-layers"]'))`), true, 'the tab carries the host mark');
    assert.equal(await page.evaluate<string>(`${tabButton}.textContent`), '第三方插件：界面示例');
    await page.click(tabButton, 'the example tab');
    await page.waitFor(iframe('ui-demo', 'workbench'), 'the example workbench frame');
    const bench = iframe('ui-demo', 'workbench');
    await waitFor(() => inFrame<boolean>(page, bench, `!document.getElementById('add').disabled`), 'the example ready', 15_000);
    await inFrame(page, bench, `document.getElementById('add').click()`);
    await waitFor(() => inFrame<boolean>(page, bench, `document.getElementById('count').textContent === '1'`), 'the answer in the workbench');
    await waitFor(() => inFrame<boolean>(page, iframe('ui-demo', 'titlebar'), `document.getElementById('count').textContent === '1'`), 'the push in the title bar panel');
    await page.waitFor(`${chip('ui-demo')}.textContent.includes('计数 1') && ${chip('ui-demo')}.classList.contains('pui-running')`, 'the chip text');
    // The frame got the theme's colours.
    const bg = await inFrame<string>(page, bench, `getComputedStyle(document.body).backgroundColor`);
    assert.equal(bg, await page.evaluate<string>(`(() => { const s = document.createElement('span'); s.style.color = 'var(--bg)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`));
    await page.evaluate(`document.querySelector('dialog.workbench').close()`);
    await page.evaluate(closePanel);

    step = 'both positions in every theme, 1440 and 375 px';
    for (const width of [1440, 375]) {
      await size(width);
      // Loaded afresh at this width (a phone's sidebar is a drawer), straight into the cluster.
      await page.navigate(`${app.url}/?width=${width}#c=c1`);
      await page.waitFor(`${chip('ui-demo')}?.textContent.includes('计数 1')`, 'the chips at this width');
      for (const theme of ['light', 'dark', 'orrery']) {
        await page.evaluate(`globalThis.orreryTheme.set('${theme}')`);
        await page.click(chip('ui-demo'), 'the example chip');
        await page.waitFor(iframe('ui-demo', 'titlebar'), 'the panel frame');
        await waitFor(() => inFrame<boolean>(page, iframe('ui-demo', 'titlebar'), `document.getElementById('count').textContent === '1'`), 'the panel ready', 15_000);
        const box = await page.evaluate<{ left: number; right: number; width: number; frameHeight: number; viewport: number }>(`(() => {
          const r = document.querySelector('.pui-panel').getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, frameHeight: ${iframe('ui-demo', 'titlebar')}.getBoundingClientRect().height, viewport: innerWidth };
        })()`);
        assert.ok(box.left >= 0 && box.right <= box.viewport, `${theme} ${width}: the panel is on screen`);
        assert.equal(box.width, width === 375 ? 375 : 360, `${theme} ${width}: the panel width`);
        assert.equal(box.frameHeight, 240, `${theme} ${width}: the declared panel height`);
        await shot(`${theme}-${width}-titlebar`);
        await page.evaluate(closePanel);
        await page.click(`document.getElementById('open-workbench')`, 'the workbench');
        await page.click(`document.querySelector('[data-wb-plugin-tab="ui-demo"]')`, 'the example tab');
        await page.waitFor(iframe('ui-demo', 'workbench'), 'the workbench frame');
        await waitFor(() => inFrame<boolean>(page, iframe('ui-demo', 'workbench'), `document.getElementById('count').textContent === '1'`), 'the tab ready', 15_000);
        const area = await page.evaluate<{ width: number; height: number; inside: boolean }>(`(() => {
          const f = ${iframe('ui-demo', 'workbench')}.getBoundingClientRect(); const d = document.querySelector('dialog.workbench').getBoundingClientRect();
          return { width: f.width, height: f.height, inside: f.left >= d.left && f.right <= d.right && f.top >= d.top && f.bottom <= d.bottom };
        })()`);
        assert.ok(area.inside && area.width > 200 && area.height > 200, `${theme} ${width}: the tab's frame fills the workbench (${JSON.stringify(area)})`);
        await shot(`${theme}-${width}-workbench`);
        await page.evaluate(`document.querySelector('dialog.workbench').close()`);
      }
    }
    await size(1440);
    await page.evaluate(`globalThis.orreryTheme.set('system')`);

    step = 'a theme change reaches an open frame';
    await page.click(chip('ui-probe'), 'the probe chip');
    await waitFor(async () => (await received(app)).filter((d: any) => d.kind === 'init').length >= 2, 'a new init');
    await page.evaluate(`globalThis.orreryTheme.set('orrery')`);
    const themed = await waitFor(async () => (await received(app)).find((d: any) => d.kind === 'theme' && d.theme.name === 'orrery'), 'the theme message');
    assert.equal(themed.theme.colors.bg, 'rgb(7, 11, 22)');
    assert.equal(themed.theme.scheme, 'dark');
    await page.evaluate(`globalThis.orreryTheme.set('system')`);

    step = 'not running: placeholder, then a new frame once it is back';
    const before = await page.evaluate<string>(`${iframe('ui-probe', 'titlebar')}.src`);
    await app.api('POST', '/api/plugins/ui-probe/stop', {});
    await page.waitFor(placeholder('ui-probe', 'titlebar', 'PLUGIN_NOT_RUNNING'), 'the not-running placeholder');
    assert.equal(await page.evaluate(`Boolean(${iframe('ui-probe', 'titlebar')})`), false);
    assert.equal((await rawFetch(before)).status, 404, 'the old frame id is dead');
    await app.api('POST', '/api/plugins/ui-probe/start', {});
    await page.waitFor(`${iframe('ui-probe', 'titlebar')} && ${iframe('ui-probe', 'titlebar')}.src !== ${JSON.stringify(before)}`, 'a new frame', 15_000);
    await page.evaluate(closePanel);

    step = 'a stop while a frame is being opened: the late answer is given back, never shown, and it recovers';
    // The frame request reaches the Hub (which answers with an id), but the page sees the answer only when released.
    await page.evaluate(`(() => {
      globalThis.realFetch = window.fetch;
      window.fetch = async (input, init) => {
        const res = await globalThis.realFetch(input, init);
        if (init?.method === 'POST' && String(input).endsWith('/plugin-ui/frames')) {
          globalThis.heldFrame = await res.clone().json();
          await new Promise((resolve) => { globalThis.releaseFrame = resolve; });
        }
        return res;
      };
    })()`);
    await page.click(chip('ui-probe'), 'the probe chip');
    await page.waitFor(`typeof globalThis.releaseFrame === 'function'`, 'the held frame answer');
    const held = await page.evaluate<string>('globalThis.heldFrame.url');
    await app.api('POST', '/api/plugins/ui-probe/stop', {});
    await page.waitFor(placeholder('ui-probe', 'titlebar', 'PLUGIN_NOT_RUNNING'), 'the not-running placeholder');
    await page.evaluate('window.fetch = globalThis.realFetch; globalThis.releaseFrame()');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await page.evaluate(`Boolean(${iframe('ui-probe', 'titlebar')})`), false, 'the late answer is not shown');
    assert.ok(await page.evaluate(placeholder('ui-probe', 'titlebar', 'PLUGIN_NOT_RUNNING')), 'the placeholder stays');
    await app.api('POST', '/api/plugins/ui-probe/start', {});
    await page.waitFor(`${iframe('ui-probe', 'titlebar')} && !${iframe('ui-probe', 'titlebar')}.src.endsWith(${JSON.stringify(held)})`, 'a new frame once it is back', 15_000);

    step = 'leaving the page gives the frame id back';
    const leaving = await page.evaluate<string>(`${iframe('ui-probe', 'titlebar')}.src`);
    assert.equal((await rawFetch(leaving)).status, 200);
    await page.navigate(`${app.url}/?again=1#c=c1`);
    await waitFor(async () => (await rawFetch(leaving)).status === 404, 'the id given back on pagehide', 10_000);
    await page.waitFor(`${chip('ui-probe')}`, 'the chips again');

    step = 'files missing; the keyboard: Tab into the frame, Esc on the host side closes';
    await page.click(chip('ui-nofiles'), 'the chip of the plugin without files');
    await page.waitFor(placeholder('ui-nofiles', 'titlebar', 'FILES_MISSING'), 'the files-missing placeholder');
    await page.evaluate(`document.querySelector('.pui-panel .pui-close').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor(`!document.querySelector('.pui-panel') && document.activeElement === ${chip('ui-nofiles')}`, 'Esc closed the panel, focus back on its chip');
    await page.click(chip('ui-demo'), 'the example chip');
    await waitFor(() => inFrame<boolean>(page, iframe('ui-demo', 'titlebar'), `!document.getElementById('add').disabled`), 'the example ready', 15_000);
    await page.evaluate(`document.querySelector('.pui-panel .pui-close').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.waitFor(`document.activeElement === ${iframe('ui-demo', 'titlebar')}`, 'Tab moved into the frame');
    assert.equal(await inFrame(page, iframe('ui-demo', 'titlebar'), `document.activeElement?.id`), 'add', 'onto its first control');
    await page.evaluate(closePanel);
    await page.click(chip('ui-silent'), 'the chip of the silent plugin');
    await page.waitFor(iframe('ui-silent', 'titlebar'), 'its frame');
    await page.waitFor(placeholder('ui-silent', 'titlebar', 'LOAD_TIMEOUT'), 'the load-timeout placeholder', 15_000);
    await shot('placeholder-timeout');
    await page.evaluate(closePanel);

    step = 'the switch on the settings card removes an open frame at once';
    await page.click(chip('ui-demo'), 'the example chip');
    await page.waitFor(iframe('ui-demo', 'titlebar'), 'the panel frame');
    const open = await page.evaluate<string>(`${iframe('ui-demo', 'titlebar')}.src`);
    await page.click(`document.getElementById('open-settings')`, 'settings');
    await page.click(`document.getElementById('settings-tab-plugins')`, 'the plugins tab');
    const uiSwitch = `document.querySelector('[data-plugin-live="ui-demo"] [data-plugin-switch="ui"]')`;
    await page.waitFor(`${uiSwitch}?.checked === true`, 'the UI switch, on');
    await page.click(uiSwitch, 'the UI switch');
    await page.waitFor(`!${iframe('ui-demo', 'titlebar')} && ${placeholder('ui-demo', 'titlebar', 'UI_OFF')}`, 'the frame gone, the turned-off placeholder');
    assert.equal((await rawFetch(open)).status, 404, 'its URL is dead');
    await page.waitFor(`${uiSwitch}?.checked === false`, 'the switch, off');
    await page.click(uiSwitch, 'the UI switch again');
    await page.waitFor(iframe('ui-demo', 'titlebar'), 'a new frame once it is on again', 15_000);

    const problems = browser.problems();
    assert.deepEqual(problems.exceptions, [], 'no uncaught exception');
  } catch (error) {
    try { await shot('failure'); } catch { /* no page */ }
    throw new Error(`${step}: ${(error as Error).message}`, { cause: error });
  } finally {
    await browser?.close();
    await app.close();
    canary.close();
  }
});
