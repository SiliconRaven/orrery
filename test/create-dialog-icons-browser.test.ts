// The create dialog's app list and app settings (app.js harnessForm) at phone width: the back button and a row's warning
// draw the sprite icons (ui.js icon), while each app's own logo is still drawn where it was. harnessForm once had a local
// `icon` for the logo that hid the shared helper, so the back button showed the app's logo. A test Hub with mock members,
// the real page in a headless installed browser (test/browser.ts). Skipped when no supported browser is installed,
// unless ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { startTestHub, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const required = process.env.ORRERY_REQUIRE_BROWSER === '1';
const skip = found.path === null && !required ? `no supported browser: ${found.reason}` : false;

test('create dialog at 375 px: the back button is the chevron icon, the app logos stay, a row warning is the alert icon', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.readyState === 'complete' && document.getElementById('new-cluster')`, 'the page');
    await page.evaluate(`document.getElementById('new-cluster').click()`);
    await page.waitFor(`document.querySelectorAll('#create-harnesses .app-row').length > 0`, 'the app list');
    // Tick the first app, then open its settings (on a phone the list gives way to them).
    await page.evaluate(`(() => { const row = document.querySelector('#create-harnesses .app-row');
      const box = row.querySelector('input[type=checkbox]'); box.checked = true; box.dispatchEvent(new Event('change'));
      row.querySelector('.app-row-main').click(); return true; })()`);
    await page.waitFor(`document.querySelector('#create-harnesses .harness-body:not([hidden]) .app-back')?.offsetWidth > 0`, 'the app settings');
    const seen = await page.evaluate<any>(`(() => {
      const body = document.querySelector('#create-harnesses .harness-body:not([hidden])');
      const back = body.querySelector('.app-back');
      const head = body.querySelector('.app-detail-head');
      const rows = [...document.querySelectorAll('#create-harnesses .app-row')];
      const problems = [...document.querySelectorAll('#create-harnesses .app-row-problem:not([hidden])')];
      return {
        back: { use: back.querySelector('svg.ico use')?.getAttribute('href') ?? null, logo: Boolean(back.querySelector('.app-icon')), text: back.textContent },
        headLogo: [...head.children].map((c) => c.classList.contains('app-icon') ? 'logo' : c.tagName.toLowerCase()),
        rowLogos: rows.map((r) => Boolean(r.querySelector('.app-row-main > .app-icon'))),
        problems: problems.map((p) => ({ use: p.querySelector('svg.ico use')?.getAttribute('href') ?? null, logo: Boolean(p.querySelector('.app-icon')) })),
        modeControls: body.querySelectorAll('.modes, input[name^=mode-]').length,
        oldModeText: body.textContent.includes('隔离') || body.textContent.includes('默认目录'),
        projectPlaceholder: body.querySelector('.project-row select option')?.textContent,
        beta: document.querySelector('.beta-label')?.textContent,
      };
    })()`);
    assert.deepEqual(seen.back, { use: '#i-chevron-left', logo: false, text: '应用列表' }, 'the back button: the sprite chevron and its words');
    assert.deepEqual(seen.headLogo, ['button', 'logo', 'h3'], 'the app logo still sits between the back button and the name');
    assert.ok(seen.rowLogos.length > 0 && seen.rowLogos.every(Boolean), `every app row keeps its logo: ${seen.rowLogos}`);
    for (const p of seen.problems) assert.deepEqual(p, { use: '#i-alert', logo: false }, 'a row warning: the alert icon');
    assert.equal(seen.modeControls, 0, 'the native-only form has no mode selector');
    assert.equal(seen.oldModeText, false, 'no background or implicit-default-directory flow remains');
    assert.equal(seen.projectPlaceholder, '选择项目…');
    assert.equal(seen.beta, 'Beta 测试版');
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
