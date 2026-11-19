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

async function checkBatchDetails(page: Page, label: string, title: string, missing: string) {
  const button = `document.querySelector('.wb-group-batch .wb-batch-progress button')`;
  const dialog = `document.querySelector('dialog.wb-batch-dialog[open]')`;
  await page.waitFor(button, 'the review batch details button');
  await page.click(button, 'the review batch details button');
  await page.waitFor(dialog, 'the review batch details dialog', 5_000);
  assert.equal(await page.evaluate(`${dialog}.getAttribute('aria-label')`), label);
  assert.equal(await page.evaluate(`${dialog}.querySelector('div.workbench-form h2').textContent`), title);
  assert.ok(await page.evaluate(`[...${dialog}.querySelectorAll('p.muted')].some((p) => p.textContent === ${JSON.stringify(missing)})`));
  await page.click(`${dialog}.querySelector('button.primary')`, 'close the batch details dialog');
}

test('375 px: chat, workbench tasks, roles and settings have no sideways scroll; the narrow fixes hold', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  try {
    // No coordinator in this cluster: the long-term instructions card shows why its add button is disabled.
    const { cluster } = await hub.cluster('narrow', ['alpha', 'beta']);
    const command = (data: object) => hub.api('POST', `/api/clusters/${cluster.id}/collaboration`, { ...data, operationId: crypto.randomUUID() });
    const { batch } = await command({ action: 'batch.create', title: 'Browser fixture', reviewer: { kind: 'user' } });
    for (const title of ['One', 'Two']) await command({ action: 'task.create', title, scope: 'Review', acceptance: 'Checked', batchId: batch.id });
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
    await checkBatchDetails(page, '批次 B1', '批次 B1 · Browser fixture', '还差：#1 待开工、#2 待开工');

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
    // Switching languages with a draft shows the page confirmation, and cancelling leaves the composer as it was.
    const draft = '待发送草稿';
    await page.evaluate(`document.getElementById('settings-tab-appearance').click();
      document.getElementById('composer-input').value = ${JSON.stringify(draft)};`);
    const chooseEnglish = `(() => {
      const language = document.getElementById('ui-language');
      language.value = 'en';
      language.dispatchEvent(new Event('change'));
    })()`;
    await page.evaluate(chooseEnglish);
    await page.waitFor(`document.querySelector('dialog.ask[open] #ask-title')?.textContent === '切换语言并刷新页面？'`, 'language change confirmation');
    await page.evaluate(`document.querySelector('dialog.ask[open] button[value=cancel]').click()`);
    await page.waitFor(`document.getElementById('ui-language').value === 'zh'`, 'the original language selection');
    assert.equal(await page.evaluate(`document.getElementById('composer-input').value`), draft);
    assert.equal(await page.evaluate(`document.documentElement.lang`), 'zh-CN');
    await page.evaluate(`document.getElementById('composer-input').value = '';`);
    await page.evaluate(chooseEnglish);
    await page.waitFor(`document.documentElement.lang === 'en' && document.getElementById('open-settings').title === 'Settings'`, 'the reloaded English interface');
    await page.evaluate(`document.getElementById('open-settings').click()`);
    await page.waitFor(`document.getElementById('settings-dialog').open`, 'English settings');
    await noSideScroll(page, 'English appearance settings', '#settings-dialog .settings-panels');
    await page.evaluate(`document.getElementById('settings-dialog').close(); document.getElementById('open-workbench').click()`);
    await checkBatchDetails(page, 'Batch B1', 'Batch B1 · Browser fixture', 'Still needed: #1 待开工, #2 待开工');
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
