// Shared component looks in a real browser (style.css): the current settings tab keeps the chosen
// fill while the real mouse is over it, while other tabs still react to hover; and the wake switch that the real
// plugins.js pluginRow draws on a third-party plugin card is the page's one switch, like the enable switch beside it.
// A test Hub, the real page in a headless installed browser (test/browser.ts). Skipped when no supported browser is
// installed, unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launchBrowser, type Browser, type Page } from './browser.ts';
import { startTestHub, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const required = process.env.ORRERY_REQUIRE_BROWSER === '1';
const skip = found.path === null && !required ? `no supported browser: ${found.reason}` : false;

const bg = (page: Page, id: string) => page.evaluate<string>(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).backgroundColor`);
/** The real mouse over the element's centre. */
async function hover(page: Page, id: string) {
  const at = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await new Promise((r) => setTimeout(r, 100));
}

test('settings tabs keep the chosen fill under the mouse; the plugin wake switch is the shared switch', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.getElementById('open-settings')`, 'the page');
    await page.evaluate(`document.getElementById('open-settings').click(); document.getElementById('settings-tab-plugins').click(); true`);
    await page.waitFor(`document.getElementById('settings-tab-plugins').getAttribute('aria-selected') === 'true'`, 'the plugins tab');

    for (const theme of ['dark', 'light']) {
      await page.evaluate(`globalThis.orreryTheme.set(${JSON.stringify(theme)})`);
      await hover(page, 'settings-title');   // away from the rail
      const chosen = await bg(page, 'settings-tab-plugins');
      const idle = await bg(page, 'settings-tab-limits');
      assert.notEqual(chosen, idle, `${theme}: the chosen tab has its fill`);
      await hover(page, 'settings-tab-plugins');
      assert.equal(await bg(page, 'settings-tab-plugins'), chosen, `${theme}: hovering the chosen tab keeps its fill`);
      await hover(page, 'settings-tab-limits');
      assert.notEqual(await bg(page, 'settings-tab-limits'), idle, `${theme}: another tab still reacts to hover`);
    }

    // A third-party plugin allowed to send and wake members, drawn by the real pluginRow into the settings panel.
    const sizes = await page.evaluate<Record<string, { appearance: string; width: number; height: number; background: string; host: string }>>(`(async () => {
      const { pluginRow } = await import('/plugins.js');
      const plugin = { id: 'external-test', name: '外部', origin: 'external', version: '1.0.0', requires: [], description: '一句话', enabled: true,
        disabledByEnv: false, pendingEnabled: true, permissions: ['messages.send', 'messages.mention'], clusterIds: ['one'], writeClusterIds: ['one'],
        writeSettings: { mentionEnabled: true, perMinute: 5, perHour: 200 } };
      const row = pluginRow(plugin, [plugin], false, () => {}, () => {});
      document.getElementById('settings-panel-plugins').append(row);
      // Computed sizes: the write settings sit in the folded details, so nothing has a box on screen.
      const look = (input) => { const s = getComputedStyle(input);
        return { appearance: s.appearance, width: parseFloat(s.width), height: parseFloat(s.height), background: s.backgroundColor, host: input.parentElement.className }; };
      const sw = (label) => row.querySelector('input[role="switch"][aria-label="' + label + '"]');
      return { enable: look(sw('启用外部')), wake: look(sw('允许外部唤醒成员')) };
    })()`);
    assert.equal(sizes.wake.appearance, 'none', JSON.stringify(sizes));
    assert.deepEqual([sizes.wake.width, sizes.wake.height], [34, 20], 'the shared 34x20 track');
    assert.deepEqual(sizes.wake, { ...sizes.enable, host: sizes.wake.host }, 'the same look as the enable switch (both on)');
    assert.match(sizes.wake.host, /\bplugin-switch\b/);
    assert.match(sizes.wake.host, /\brisk-option\b/, 'still marked as a setting with consequences');
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
