import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { TEST_TOKEN, waitFor } from './helpers.ts';
import { startPluginConfigDemo } from './plugin-config-demo.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;

test('browser: plugin preferences from the settings card and the group menu, with live field feedback', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const app = await startPluginConfigDemo();
  const view = (clusterId?: string) => app.api('GET', '/api/plugins/config-demo/config' + (clusterId ? `?clusterId=${clusterId}` : ''));
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const element = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
    const inDialog = (selector: string) => element(`#plugin-config-dialog[open] ${selector}`);
    const field = (name: string) => inDialog(`[name="${name}"]`);
    const replaceText = async (name: string, value: string) => {
      await page.evaluate(`${field(name)}.focus(); ${field(name)}.select(); true`);
      await page.send('Input.insertText', { text: value });
    };
    const save = () => page.click(inDialog('button[type="submit"]'), 'save plugin configuration');

    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    const groupMenu = element(`[data-cluster-menu="${app.projectId}"]`);
    await page.waitFor(groupMenu, 'the demo group');
    await page.click(element('#open-settings'), 'settings');
    await page.waitFor("document.getElementById('settings-dialog').open", 'settings dialog');
    await page.click(element('#settings-tab-plugins'), 'plugins tab');
    const configure = element('[data-plugin-config="config-demo"]');
    await page.waitFor(configure, 'config-demo settings card');
    await page.click(configure, 'open preferences from plugin card');
    await page.waitFor(field('title'), 'global preferences');
    for (const name of ['title', 'format', 'maxItems', 'directory', 'showDate']) {
      assert.ok(await page.evaluate(`${field(name)}?.getClientRects().length`), `visible global field: ${name}`);
    }
    assert.equal(await page.evaluate(`${field('title')}.value`), '每周简报');
    const titleSource = inDialog('[data-config-source="title"]');
    assert.equal(await page.evaluate(`${titleSource}.textContent`), '清单默认');
    await replaceText('title', '季度简报');
    await save();
    await waitFor(async () => (await view()).values.title === '季度简报', 'global title saved');
    await page.waitFor(`${titleSource}.textContent === '已保存自定义'`, 'saved override status');

    await page.click(inDialog('button[aria-label="关闭"]'), 'close preferences');
    await page.click(element('#settings-close'), 'close settings');
    // Closing settings restores focus asynchronously. Hover the row and wait for its action to receive pointer input.
    const triggerPoint = await page.evaluate<{ x: number; y: number }>(`(() => {
      const trigger = ${groupMenu};
      trigger.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = trigger.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...triggerPoint });
    await page.waitFor(`(() => {
      const trigger = ${groupMenu};
      if (!trigger) return false;
      const rect = trigger.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit && trigger.contains(hit);
    })()`, 'project group menu ready for pointer input');
    await page.click(groupMenu, 'project group menu');
    const menuItem = element('[data-menu-action="plugin-config"]');
    await page.waitFor(menuItem, 'group plugin preferences menu item');
    await page.click(menuItem, 'open preferences for the project group');
    await page.waitFor(field('sections'), 'project group fields');
    assert.equal(await page.evaluate(`${inDialog('select[data-config-cluster]')}.value`), app.projectId);
    const memberIds = await page.evaluate<string[]>(`[...${field('owner')}.options].map(option => option.value).filter(Boolean)`);
    assert.deepEqual(memberIds.sort(), [`${app.projectId}-0`, `${app.projectId}-1`]);
    const weeklyBefore = await view(app.weeklyId);
    await replaceText('interval', '30m');
    await replaceText('sections', '进展\n进展');
    await save();

    // A duplicate is a valid list; the fixture's report arrives after the user's accepted save.
    const reason = inDialog('[data-config-error="sections"]');
    await page.waitFor(`${reason}?.getClientRects().length && ${reason}.textContent.includes('栏目名称重复了。')`, 'plugin feedback beside sections');
    const first = await view(app.projectId);
    assert.equal(first.values.interval, 1800);
    assert.deepEqual(first.values.sections, ['进展', '进展']);
    assert.equal(first.errors.sections, '栏目名称重复了。');

    await replaceText('sections', '进展\n本周议题');
    await save();
    await waitFor(async () => {
      const next = await view(app.projectId);
      return next.revision > first.revision && next.values.sections[1] === '本周议题' && !next.errors.sections;
    }, 'corrected project preferences saved');
    await page.waitFor(`!${reason}?.getClientRects().length || !${reason}.textContent.trim()`, 'sections feedback cleared');
    const weeklyAfter = await view(app.weeklyId);
    assert.deepEqual([weeklyAfter.revision, weeklyAfter.values], [weeklyBefore.revision, weeklyBefore.values], 'other group untouched');
    assert.equal((await view()).values.title, '季度简报', 'global value survived the group edits');
    await page.click(inDialog('[data-config-scope="global"]'), 'switch back to global configuration');
    const resetTitle = inDialog('[data-config-reset="title"]');
    await page.waitFor(resetTitle, 'restore title action');
    await page.click(resetTitle, 'restore the manifest title');
    assert.equal(await page.evaluate(`${field('title')}.value`), '每周简报');
    assert.equal(await page.evaluate(`${titleSource}.textContent`), '清单默认 · 待保存');
    assert.equal((await view()).values.title, '季度简报', 'reset only changed the draft');
    await save();
    await waitFor(async () => {
      const saved = await view();
      return saved.values.title === '每周简报' && !saved.overriddenFields.includes('title');
    }, 'reset removes the stored title override');
    assert.deepEqual(browser.problems().exceptions, []);
    assert.deepEqual(browser.problems().console, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});
