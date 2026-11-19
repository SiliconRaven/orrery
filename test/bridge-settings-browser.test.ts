import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { hubSecret, startTestHub, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? found.reason : false;

test('bridge settings reveal the key only on click, wrap it on a narrow page and clear it on close', { skip, timeout: 30_000 }, async () => {
  assert.ok(found.path);
  const app = await startTestHub();
  let browser: Browser | undefined;
  try {
    const key = hubSecret(app.home);
    await app.cluster('settings fixture', ['member']);
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN, key] });
    const page = browser.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await page.navigate(app.url + '/#token=' + TEST_TOKEN);
    await page.waitFor('document.querySelector("#cluster-list .cluster-item")', 'fixture loaded');
    await page.evaluate('document.getElementById("open-settings").click(); true');
    await page.waitFor('document.getElementById("settings-dialog").open', 'settings dialog');
    await page.evaluate('document.getElementById("settings-tab-delivery").click(); true');
    await page.waitFor('!document.getElementById("bridge-settings").hidden', 'bridge settings');
    assert.equal(await page.evaluate('document.getElementById("bridge-key-text").textContent'), '');
    await page.click('document.getElementById("bridge-reveal-key")', 'reveal key');
    await page.waitFor('!document.getElementById("bridge-key-value").hidden', 'key revealed');
    assert.ok(await page.evaluate('document.getElementById("bridge-key-text").textContent === ' + JSON.stringify(key)));
    assert.ok(await page.evaluate('document.querySelector(".settings-panels").scrollWidth <= document.querySelector(".settings-panels").clientWidth'));
    await page.click('document.getElementById("settings-close")', 'close settings');
    await page.waitFor('document.getElementById("bridge-key-value").hidden', 'key hidden on close');
    assert.equal(await page.evaluate('document.getElementById("bridge-key-text").textContent'), '');
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});
