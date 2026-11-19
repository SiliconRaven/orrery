// Plugin commands in the real page (headless, test/browser.ts; docs/external-plugins.md「命令」): "/" opens the command
// list, a pick opens the parameter form, a refused field shows its error, a quick run ends in a corner notice, a long run
// shows the header chip and is cancelled from it, another cluster shows none of it, the chat gets no message, and at
// 375 px the menu and the form span the composer.
// Uses the shared profile slots, like the other browser tests; a supported browser must be installed unless
// ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';
import { Store } from '../src/core/store.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;

/** Clusters `cmd-one` (granted to the fixture plugin) and `cmd-two` (not), each with one native mock member. */
function setup(): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const store = new Store(join(dir, 'test.db'));
  for (const id of ['cmd-one', 'cmd-two']) {
    store.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, [{ id: `${id}-Alice`, clusterId: id, name: 'Alice', avatar: '',
      harness: 'mock', model: null, effort: null, workerSessionId: `${id}-Alice`, cwd: dir, origin: 'attached' as const, removedAt: null }]);
  }
  store.close();
  const plugin = join(dir, 'plugins', 'command-demo');
  cpSync(join(REPO_ROOT, 'test', 'fixtures', 'command-demo'), plugin, { recursive: true });
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: [{
    manifest: join(plugin, 'orrery-plugin.json'), permissions: ['clusters.read'], clusterIds: ['cmd-one'] }] }));
  return dir;
}

test('browser: "/" lists commands, the form runs one, notices and the run chip stay with their cluster, nothing is sent', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const app = await startTestHub({ dir: setup() });
  let browser: Browser | null = null;
  let step = 'setup';
  const screenshot = async (name: string) => {
    const shot = await browser!.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const directory = join(REPO_ROOT, '.tmp', 'plugin-commands-shots');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  try {
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const item = (name: string) => `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === '${name}')`;
    const input = `document.getElementById('composer-input')`;
    const menuRows = `[...document.querySelectorAll('#command-menu li[role=option]')]`;
    const key = (k: string) => `${input}.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true }))`;
    const form = `document.querySelector('.command-form')`;
    const notice = (text: string) => `[...document.querySelectorAll('#run-notices .run-notice')].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;
    const messageCount = () => app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n as number;
    const before = messageCount();

    step = 'open the cluster';
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(item('cmd-one'), 'the cluster');
    await page.click(item('cmd-one'), 'the cluster');
    await page.waitFor(`!document.getElementById('composer').hidden`, 'the composer');

    step = 'the "/" menu';
    await page.type(input, '/', 'a slash');
    await page.waitFor(`${menuRows}.length === 3`, 'three commands');
    assert.match(await page.evaluate<string>(`document.querySelector('#command-menu .picker-footer').textContent`), /不会发到群聊/);
    await page.type(input, 'gre', 'a filter');
    await page.waitFor(`${menuRows}.length === 1`, 'one command left');
    await page.evaluate(key('ArrowDown'));   // a partly typed name runs nothing on Enter until it is chosen
    await page.evaluate(key('Enter'));
    await page.waitFor(form, 'the parameter form');
    assert.equal(await page.evaluate(`Boolean(${form}.closest('#composer'))`), false, 'the form is outside the composer <form>');
    assert.equal(await page.evaluate(`${input}.value`), '', 'the "/gre" text is gone, nothing inserted');

    step = 'a refused field, then a quick run';
    await page.click(`[...${form}.querySelectorAll('button')].find((b) => b.textContent === '运行')`, 'run');
    await page.waitFor(`[...${form}.querySelectorAll('.form-error')].some((e) => !e.hidden && e.textContent.includes('称呼'))`, 'the error next to the field');
    await page.type(`${form}.querySelector('input[type=text]')`, '小明', 'the name');
    await page.click(`[...${form}.querySelectorAll('button')].find((b) => b.textContent === '运行')`, 'run');
    await page.waitFor(notice('你好，小明'), 'the result notice');
    assert.equal(await page.evaluate(`Boolean(${form})`), false, 'the form closed');
    const box = await page.evaluate<{ right: number; top: number; headerBottom: number }>(`(() => { const r = document.getElementById('run-notices').getBoundingClientRect(); const h = document.querySelector('.chat-head').getBoundingClientRect(); return { right: h.right - r.right, top: r.top, headerBottom: h.bottom }; })()`);
    assert.ok(box.right < 40 && box.top >= box.headerBottom, 'below the header, leaving command controls clickable');

    step = 'a long run: the chip, its panel, cancel';
    await page.type(input, '/session', 'the long command');
    await page.waitFor(`${menuRows}.length === 1`, 'the long command');
    await page.evaluate(key('Enter'));
    await page.waitFor(form, 'its form');
    await page.evaluate(`${form}.querySelector('input[type=number]').value = '50'`);
    await page.evaluate(`[...${form}.querySelectorAll('input[type=number]')][1].value = '1000'`);
    await page.click(`[...${form}.querySelectorAll('button')].find((b) => b.textContent === '运行')`, 'run');
    await page.waitFor(`!document.getElementById('plugin-runs').hidden && document.getElementById('plugin-run-chip').textContent.includes('计时环节')`, 'the chip');
    await page.click(`document.getElementById('plugin-run-chip')`, 'the chip');
    await page.click(`[...document.querySelectorAll('#plugin-run-panel button')].find((b) => b.textContent === '取消')`, 'cancel');
    await page.waitFor(notice('已按要求停止'), 'the cancelled notice');
    await page.waitFor(`document.getElementById('plugin-runs').hidden`, 'the chip goes');

    step = 'another cluster shows none of it';
    await page.type(input, '/session', 'another long run');
    await page.evaluate(key('Enter'));
    await page.waitFor(form, 'its form');
    await page.click(`[...${form}.querySelectorAll('button')].find((b) => b.textContent === '运行')`, 'run');
    await page.waitFor(`!document.getElementById('plugin-runs').hidden`, 'the chip');
    await page.click(item('cmd-two'), 'the other cluster');
    await page.waitFor(`document.getElementById('plugin-runs').hidden`, 'no chip in cmd-two');
    await page.type(input, '/', 'a slash in cmd-two');
    await page.evaluate(`new Promise((r) => setTimeout(r, 300))`);
    assert.equal(await page.evaluate(`document.getElementById('command-menu').hidden`), true, 'no plugin is granted cmd-two');

    step = 'mobile width';
    await page.click(item('cmd-one'), 'back to cmd-one');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`document.getElementById('sidebar').getBoundingClientRect().right <= 1`, 'the sidebar resize transition');
    await page.evaluate(`${input}.value = ''`);
    await page.type(input, '/', 'a slash');
    await page.waitFor(`${menuRows}.length === 3`, 'the menu');
    const widths = await page.evaluate<{ menu: number; box: number }>(`({ menu: document.getElementById('command-menu').getBoundingClientRect().width,
      box: document.querySelector('.composer-box').getBoundingClientRect().width })`);
    assert.ok(Math.abs(widths.menu - widths.box) < 2, `the menu spans the composer (${widths.menu} vs ${widths.box})`);

    step = 'themes and widths';
    await page.waitFor(`document.getElementById('plugin-runs').hidden`, 'the earlier run ended');
    await page.evaluate(`[...document.querySelectorAll('#run-notices button')].forEach((button) => button.click())`);
    for (const theme of ['light', 'dark', 'orrery']) {
      for (const width of [1440, 375]) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 812 : 900, deviceScaleFactor: 1, mobile: false });
        if (width === 375) await page.waitFor(`document.getElementById('sidebar').getBoundingClientRect().right <= 1`, 'the sidebar resize transition');
        await page.evaluate(`globalThis.orreryTheme.set('${theme}'); ${input}.value = ''; ${input}.dispatchEvent(new Event('input', { bubbles: true }))`);
        await page.type(input, '/', 'the command menu');
        await page.waitFor(`${menuRows}.length === 3`, 'the commands');
        await screenshot(`${theme}-${width}-menu`);
        await page.type(input, 'greet', 'the greeting command');
        await page.evaluate(key('Enter'));
        await page.waitFor(form, 'the parameter form');
        assert.ok(await page.evaluate(`(() => { const r = ${form}.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; })()`), 'the form stays inside the viewport');
        await screenshot(`${theme}-${width}-form`);
        await page.click(`[...${form}.querySelectorAll('button')].find((b) => b.textContent === '取消')`, 'close the form');
      }
    }

    step = 'mobile run controls';
    await page.type(input, '/session', 'the long command');
    await page.evaluate(key('Enter'));
    await page.waitFor(form, 'its form');
    await page.evaluate(`${form}.querySelector('input[type=number]').value = '50'`);
    await page.evaluate(`[...${form}.querySelectorAll('input[type=number]')][1].value = '1000'`);
    await page.click(`[...${form}.querySelectorAll('button')].find((b) => b.textContent === '运行')`, 'run');
    await page.waitFor(`!document.getElementById('plugin-runs').hidden`, 'the running command');
    await page.click(`document.getElementById('plugin-run-chip')`, 'open the run panel');
    assert.ok(await page.evaluate(`(() => { const r = document.getElementById('plugin-run-panel').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`), 'the run panel stays inside the viewport');
    await screenshot('orrery-375-running');
    await page.click(`[...document.querySelectorAll('#plugin-run-panel button')].find((b) => b.textContent === '取消')`, 'cancel');
    await page.waitFor(`document.getElementById('plugin-runs').hidden`, 'the run ended');
    await screenshot('orrery-375-result');

    step = 'command drafts survive composition and a Hub update';
    await page.type(input, '/greet', 'another command');
    await page.evaluate(key('Enter'));
    await page.waitFor(form, 'the draft form');
    await page.type(`${form}.querySelector('input[type=text]')`, '保留的参数', 'a parameter draft');
    await page.evaluate(`${input}.value = '保留的聊天草稿'; ${input}.dispatchEvent(new Event('input', { bubbles: true }));
      ${form}.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      ${form}.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));`);
    assert.equal(await page.evaluate(`${input}.value`), '保留的聊天草稿');
    assert.equal(await page.evaluate(`${form}.querySelector('input[type=text]').value`), '保留的参数');
    // Leave only the parameter draft dirty. A changed health PID must show the existing update banner, not reload.
    await page.evaluate(`${input}.value = ''; ${input}.dispatchEvent(new Event('input', { bubbles: true }));
      globalThis.__commandTestFetch = fetch;
      globalThis.fetch = async (...args) => {
        const res = await globalThis.__commandTestFetch(...args);
        if (new URL(String(args[0]), location.href).pathname !== '/api/health') return res;
        const data = await res.json();
        return new Response(JSON.stringify({ ...data, pid: data.pid + 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      dispatchEvent(new Event('focus'));`);
    await page.waitFor(`!document.getElementById('update-banner').hidden`, 'the update banner protects the parameter draft');
    assert.equal(await page.evaluate(`${form}.querySelector('input[type=text]').value`), '保留的参数');
    await page.evaluate(`globalThis.fetch = globalThis.__commandTestFetch; delete globalThis.__commandTestFetch`);

    assert.equal(messageCount(), before, 'no command made a chat message');
    assert.deepEqual(browser.problems(), { console: [], exceptions: [] });
  } catch (e) {
    if (browser) await screenshot('failure').catch(() => {});
    (e as Error).message = `[${step}] ${(e as Error).message}`;
    throw e;
  } finally {
    await browser?.close();
    await app.close();
  }
});
