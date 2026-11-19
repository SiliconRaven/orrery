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

test('create dialog at 375 px: app icons, validation and the selected project', { skip, timeout: 120_000 }, async () => {
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
        modeControls: body.querySelectorAll('.modes, input[name^=mode-]').length,
        beta: document.querySelector('.beta-label')?.textContent,
        problems: problems.map((p) => ({ use: p.querySelector('svg.ico use')?.getAttribute('href') ?? null, logo: Boolean(p.querySelector('.app-icon')) })),
      };
    })()`);
    assert.deepEqual(seen.back, { use: '#i-chevron-left', logo: false, text: '应用列表' }, 'the back button: the sprite chevron and its words');
    assert.deepEqual(seen.headLogo, ['button', 'logo', 'h3'], 'the app logo still sits between the back button and the name');
    assert.ok(seen.rowLogos.length > 0 && seen.rowLogos.every(Boolean), `every app row keeps its logo: ${seen.rowLogos}`);
    for (const p of seen.problems) assert.deepEqual(p, { use: '#i-alert', logo: false }, 'a row warning: the alert icon');
    assert.equal(seen.modeControls, 0, 'only native sessions can be added');
    assert.equal(seen.beta, 'Beta 测试版');

    const projects = `document.querySelector('.harness-body:not([hidden]) .project-row select')`;
    const submit = `document.getElementById('create-submit')`;
    const error = `document.getElementById('create-error')`;
    await page.waitFor(`${projects}.options.length === 3 && !${submit}.disabled`, 'mock projects');
    assert.equal(await page.evaluate(`${projects}.options[0].textContent`), '选择项目…');
    await page.evaluate(`document.getElementById('create-name').value = 'Project contract'; ${submit}.click()`);
    await page.waitFor(`!${error}.hidden && ${error}.textContent === '请选择已有对话，或勾选新建对话'`, 'no implicit conversation');
    await page.evaluate(`document.querySelector('.harness-body:not([hidden]) input[aria-label="另外新建一个对话"]').click()`);
    await page.waitFor(`!${submit}.disabled`, 'the new-conversation form');
    await page.evaluate(`${submit}.click()`);
    await page.waitFor(`!${error}.hidden && ${error}.textContent === '请选择新建对话的项目目录'`, 'a project is required');
    assert.equal(hub.native.created.length, 0);
    const projectPath = await page.evaluate<string>(`(() => {
      const select = ${projects};
      select.value = Array.from(select.options).find((option) => option.textContent === 'project-2').value;
      select.dispatchEvent(new Event('change'));
      return select.value;
    })()`);
    await page.waitFor(`!${submit}.disabled && !document.querySelector('.app-row-problem:not([hidden])')`, 'the selected project clears the warning');
    await page.evaluate(`${submit}.click()`);
    await page.waitFor(`!document.getElementById('create-dialog').open`, 'the cluster was created');
    assert.deepEqual(hub.native.created.map(({ cwd }) => cwd), [projectPath]);
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
