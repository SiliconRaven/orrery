// End-to-end smoke test: a test Hub with one mock member, the real page in a headless installed browser (test/browser.ts).
// One message round trip through the real composer, then one sidebar collapse. Skipped when no supported browser is
// installed, unless ORRERY_REQUIRE_BROWSER=1 (then a missing browser fails).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireTestQueue } from '../scripts/test-queue.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { DEFAULT_DB_MODE } from '../src/core/store.ts';
import { startTestHub, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const required = process.env.ORRERY_REQUIRE_BROWSER === '1';
const skip = found.path === null && !required ? `no supported browser: ${found.reason}` : false;

test('browser smoke: a message to a mock member round-trips through the real page', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub({ dbMode: DEFAULT_DB_MODE });   // the product's database settings, not the test fast mode
  let browser: Browser | null = null;
  let step = 'start the browser';
  try {
    await hub.cluster('smoke', ['bot']);
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const nonce = `n${Date.now().toString(36)}`;
    const clusterItem = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'smoke')`;
    const userMessage = `[...document.querySelectorAll('#messages article.msg.user')].find((a) => a.textContent.includes('ping ${nonce}'))`;

    step = 'page load';
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);   // the page trades the fragment for its session cookie
    await page.waitFor(clusterItem, 'the cluster in the sidebar');
    await page.click(clusterItem, 'the cluster in the sidebar');
    await page.waitFor(`!document.getElementById('composer').hidden`, 'the composer');

    step = 'sidebar';
    // Collapsing the cluster's section must redraw it: the head says collapsed and the cluster row goes away. The click
    // waits for a quiet sidebar and the check gets 5 s, so an unrelated redraw (unread, activity) cannot hide a click
    // that redraws nothing: the ungrouped section once stored its collapse without drawing it.
    assert.ok(await page.evaluate(`new Promise((ok) => {
      const list = document.getElementById('cluster-list');
      let quiet;
      const give = (v) => { observer.disconnect(); clearTimeout(quiet); clearTimeout(cap); ok(v); };
      const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(() => give(true), 750); });
      observer.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
      quiet = setTimeout(() => give(true), 750);
      const cap = setTimeout(() => give(false), 15000);
    })`), 'the sidebar kept changing for 15 s');
    const section = await page.evaluate<string>(`${clusterItem}.closest('#cluster-list [role="group"]').getAttribute('aria-label')`);
    const group = `[...document.querySelectorAll('#cluster-list [role="group"]')].find((g) => g.getAttribute('aria-label') === ${JSON.stringify(section)})`;
    await page.click(`${group}.querySelector('.group-head')`, `the "${section}" section header`);
    await page.waitFor(`${group}?.querySelector('.group-head').getAttribute('aria-expanded') === 'false' && !${group}.querySelector('.cluster-item')`,
      `the "${section}" section to collapse`, 5_000);

    step = 'send';
    await page.type(`document.getElementById('composer-input')`, `@bot ping ${nonce}`, 'the composer input');
    await page.click(`document.querySelector('#composer button[type="submit"]')`, 'the send button');
    await page.waitFor(userMessage, 'the sent message in the chat');
    assert.equal(await page.evaluate(`document.getElementById('composer-input').value`), '', 'the composer is cleared after sending');

    step = 'delivery';
    // The receipt row's class is the delivery's outcome, or its state when there is none (buildMessage / receiptsEl).
    const delivery = await page.waitFor<string>(`(() => {
      const el = ${userMessage}?.querySelector('.receipt-delivery');
      const kind = el && [...el.classList].find((c) => c !== 'receipt-delivery');
      return kind && !['queued', 'running'].includes(kind) ? kind : null;
    })()`, 'the delivery to finish');
    assert.ok(['done', 'completed', 'accepted'].includes(delivery), `delivery ended as ${delivery}`);

    step = 'reply';
    await page.waitFor(`[...document.querySelectorAll('#messages article.msg.agent')].some((a) => a.textContent.includes('pong ${nonce}'))`,
      "the mock member's reply");

    step = 'page errors';
    assert.deepEqual(browser.problems().exceptions, [], 'the page threw an uncaught exception');
  } catch (error) {
    const problems = browser?.problems() ?? { console: [], exceptions: [] };
    const list = (items: string[]) => (items.length ? items.map((s) => `  ${s}`).join('\n') : '  (none)');
    throw new Error(`browser smoke test failed at step "${step}": ${(error as Error).message}\n`
      + `page console errors:\n${list(problems.console)}\nuncaught exceptions:\n${list(problems.exceptions)}`, { cause: error });
  } finally {
    await browser?.close();
    await hub.close();
  }
});

test('browser smoke: the settings dialog switches sections by mouse and keyboard, opens plugin details and applies the theme', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  let step = 'start the browser';
  try {
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const selected = `document.querySelector('#settings-tabs [aria-selected="true"]').id`;
    const visiblePanels = `[...document.querySelectorAll('#settings-dialog [role="tabpanel"]')].filter((p) => !p.hidden).map((p) => p.id)`;

    step = 'open settings';
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.getElementById('open-settings')`, 'the settings button');
    await page.click(`document.getElementById('open-settings')`, 'the settings button');
    await page.waitFor(`document.getElementById('settings-dialog').open`, 'the settings dialog');
    assert.equal(await page.evaluate(selected), 'settings-tab-appearance');
    assert.deepEqual(await page.evaluate(visiblePanels), ['settings-panel-appearance']);

    step = 'sections';
    await page.click(`document.getElementById('settings-tab-plugins')`, 'the 插件 tab');
    assert.deepEqual(await page.evaluate(visiblePanels), ['settings-panel-plugins']);
    await page.waitFor(`document.querySelectorAll('#plugin-list .plugin-card').length >= 3`, 'the plugin cards');
    // Keyboard: ArrowDown moves to the next section and focuses its tab; End goes to the last one.
    await page.evaluate(`document.getElementById('settings-tab-plugins').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    assert.equal(await page.evaluate(selected), 'settings-tab-delivery');
    assert.equal(await page.evaluate(`document.activeElement.id`), 'settings-tab-delivery');
    assert.deepEqual(await page.evaluate(visiblePanels), ['settings-panel-delivery']);
    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
    assert.equal(await page.evaluate(selected), 'settings-tab-appearance');

    step = 'plugin details';
    await page.click(`document.getElementById('settings-tab-plugins')`, 'the 插件 tab');
    const disclosure = `document.querySelector('[data-plugin-details="tasks"]')`;
    await page.click(disclosure, 'the task plugin details button');
    assert.equal(await page.evaluate(`${disclosure}.getAttribute('aria-expanded')`), 'true');
    assert.equal(await page.evaluate(`document.getElementById('plugin-details-tasks').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('[data-plugin="tasks"]').checked`), true, 'nothing was toggled');

    step = 'theme';
    await page.click(`document.getElementById('settings-tab-appearance')`, 'the 外观 tab');
    const background = `getComputedStyle(document.body).backgroundColor`;
    await page.click(`document.querySelector('input[name="theme"][value="dark"]').parentElement`, 'the 深色 choice');
    assert.equal(await page.evaluate(`document.documentElement.dataset.theme`), 'dark');
    assert.equal(await page.evaluate(background), 'rgb(20, 21, 24)');
    await page.click(`document.querySelector('input[name="theme"][value="light"]').parentElement`, 'the 浅色 choice');
    assert.equal(await page.evaluate(background), 'rgb(244, 244, 242)');
    await page.navigate(`${hub.url}/`);   // the choice survives a reload and is in place before the page's own script runs
    assert.equal(await page.evaluate(`document.documentElement.dataset.theme`), 'light');
    await page.click(`document.getElementById('open-settings')`, 'the settings button');
    assert.equal(await page.evaluate(`document.querySelector('input[name="theme"]:checked').value`), 'light');
    await page.click(`document.querySelector('input[name="theme"][value="system"]').parentElement`, 'the 跟随系统 choice');
    assert.equal(await page.evaluate(`document.documentElement.hasAttribute('data-theme')`), false);
    assert.equal(await page.evaluate(`localStorage.getItem('orrery.theme')`), null);

    step = 'close';
    await page.click(`document.getElementById('settings-close')`, 'the close button');
    assert.equal(await page.evaluate(`document.getElementById('settings-dialog').open`), false);
    assert.deepEqual(browser.problems().exceptions, [], 'the page threw an uncaught exception');
  } catch (error) {
    const problems = browser?.problems() ?? { console: [], exceptions: [] };
    throw new Error(`settings smoke test failed at step "${step}": ${(error as Error).message}\n`
      + `page console errors: ${problems.console.join(' | ') || '(none)'}\nuncaught exceptions: ${problems.exceptions.join(' | ') || '(none)'}`, { cause: error });
  } finally {
    await browser?.close();
    await hub.close();
  }
});

test('browser start-up: a DevTools handshake that never opens fails in bounded time, leaves no browser and frees its profile slot', { skip, timeout: 60_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  // A socket that never fires open or error: launchBrowser has to give up on its own and clean up, since the caller
  // gets no handle to close.
  class StuckSocket extends EventTarget { close() {} send() {} }
  let started: { pid: number | undefined; profile: string } | undefined;
  let hadCache = false;
  const begin = Date.now();
  await assert.rejects(launchBrowser(found.path, {
    connectTimeoutMs: 300, WebSocket: StuckSocket as unknown as typeof WebSocket,
    onStart: (s) => { started = s; hadCache = existsSync(join(s.profile, 'Local State')); },
  }), /DevTools connect/);
  assert.ok(Date.now() - begin < 30_000, `took ${Date.now() - begin} ms`);
  assert.ok(started?.pid, 'the browser was started');
  // The slot is reused, not deleted: a cache that was there (the earlier tests in this file leave one) is kept.
  if (hadCache) assert.ok(existsSync(join(started.profile, 'Local State')), 'the slot keeps Local State');
  const again = await acquireTestQueue({ lockPath: `${started.profile}.lock`, timeoutMs: 0 });
  again.release();   // the slot lock could be taken again: it was freed
  assert.throws(() => process.kill(started!.pid!, 0), { code: 'ESRCH' }, 'the browser process is gone');
});
