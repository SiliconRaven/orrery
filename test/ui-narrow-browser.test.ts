// The main views at phone width (375 px) in a real browser: nothing makes the page scroll sideways, nor the open
// dialog's scrolling pane. Also the two narrow fixes of the scales work (test/ui-scales.test.ts): settings → 外观's four
// theme options on one row, and on 角色与协调 a disabled button's reason beside its button. A test Hub with mock members,
// the real page in a headless installed browser (test/browser.ts). Skipped when no supported browser is installed,
// unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launchBrowser, type Browser, type Page } from './browser.ts';
import { startTestHub, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const required = process.env.ORRERY_REQUIRE_BROWSER === '1';
const skip = found.path === null && !required ? `no supported browser: ${found.reason}` : false;

/** How far the page, and the open dialog's scrolling pane if any, reach past the window's width. */
async function overflow(page: Page, pane?: string) {
  return page.evaluate<{ page: number; pane: number | null }>(`(() => {
    const el = ${pane ? `document.querySelector(${JSON.stringify(pane)})` : 'null'};
    return { page: document.documentElement.scrollWidth - innerWidth, pane: el ? el.scrollWidth - el.clientWidth : null };
  })()`);
}
async function noSideScroll(page: Page, view: string, pane?: string) {
  if (pane) await page.waitFor(`document.querySelector(${JSON.stringify(pane)})`, view);
  const o = await overflow(page, pane);
  assert.ok(o.page <= 0, `${view}: the page scrolls sideways by ${o.page}px`);
  if (pane) assert.ok(o.pane !== null && o.pane <= 0, `${view}: ${pane} scrolls sideways by ${o.pane}px`);
}

test('375 px: chat, workbench tasks, roles and settings have no sideways scroll; the narrow fixes hold', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  try {
    // No coordinator in this cluster: the long-term instructions card shows why its add button is disabled.
    await hub.cluster('narrow', ['alpha', 'beta']);
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'narrow')`;
    await page.waitFor(item, 'the cluster');
    await page.evaluate(`${item}.click()`);
    await page.waitFor(`document.getElementById('open-workbench') && !document.getElementById('open-workbench').hidden`, 'the chat');
    await noSideScroll(page, 'chat');

    await page.evaluate(`document.getElementById('open-workbench').click()`);
    await page.waitFor(`document.querySelector('dialog[open] .workbench-tabs')`, 'the workbench');
    await noSideScroll(page, 'workbench tasks', 'dialog[open] .workbench-content');

    await page.evaluate(`[...document.querySelectorAll('dialog[open] .workbench-tabs button')].find((b) => /^角色/.test(b.textContent)).click()`);
    await page.waitFor(`document.querySelector('dialog[open] .wb-rp-hint')`, 'the roles page with a disabled reason');
    await noSideScroll(page, 'roles', 'dialog[open] .workbench-content');
    const hint = await page.evaluate<{ hint: DOMRect; button: DOMRect; title: DOMRect }>(`(() => {
      const hint = document.querySelector('dialog[open] .wb-rp-hint'), actions = hint.parentElement;
      const r = (el) => el.getBoundingClientRect().toJSON();
      return { hint: r(hint), button: r(actions.querySelector('button')), title: r(actions.parentElement.querySelector('h3')) };
    })()`);
    assert.ok(hint.hint.left <= hint.title.left + 1, `the reason starts at the card's left edge, under the title: ${JSON.stringify(hint)}`);
    assert.ok(hint.hint.right <= hint.button.left && hint.button.top < hint.hint.bottom, `the reason and its button share a line: ${JSON.stringify(hint)}`);

    await page.evaluate(`[...document.querySelectorAll('dialog[open]')].forEach((d) => d.close()); document.getElementById('open-settings').click(); true`);
    await page.waitFor(`document.getElementById('settings-dialog').open`, 'settings');
    for (const tab of ['appearance', 'limits', 'alerts', 'plugins', 'delivery']) {
      await page.evaluate(`document.getElementById('settings-tab-${tab}').click()`);
      await noSideScroll(page, `settings ${tab}`, '#settings-dialog .settings-panels');
      if (tab === 'appearance') {
        const tops = await page.evaluate<number[]>(`[...document.querySelectorAll('#settings-dialog .segmented label')].map((l) => Math.round(l.getBoundingClientRect().top))`);
        assert.equal(tops.length, 4);
        assert.equal(new Set(tops).size, 1, `the four theme options are on one row: ${tops}`);
      }
    }
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
