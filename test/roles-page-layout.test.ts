// 角色与协调 in a real browser (docs/collaboration.md「角色与协调页」): on a narrow window the section rail is one
// horizontally scrolling row pinned under the workbench tabs. A redraw must keep the current item in view without
// moving the page, and a resize must re-pin the rail under the tabs when they wrap. A test Hub with mock members, the
// real page in a headless installed browser (test/browser.ts). Skipped when no supported browser is installed, unless
// ORRERY_REQUIRE_BROWSER=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBrowser, launchBrowser, type Browser, type Page } from './browser.ts';
import { startTestHub, TEST_TOKEN, type TestHub } from './helpers.ts';

const found = findBrowser();
const required = process.env.ORRERY_REQUIRE_BROWSER === '1';
const skip = found.path === null && !required ? `no supported browser: ${found.reason}` : false;

const CONTENT = `document.querySelector('dialog[open] .workbench-content')`;
const RAIL = `document.querySelector('dialog[open] .wb-rp-rail')`;
const railItem = (label: string) => `[...${RAIL}.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)})`;
/** Where the item sits in its rail: inside the visible horizontal range or not. */
const RAIL_STATE = `(() => {
  const rail = ${RAIL}, item = rail.querySelector('[aria-current="true"]');
  return { current: item.textContent, left: rail.scrollLeft, visible: item.offsetLeft >= rail.scrollLeft
    && item.offsetLeft + item.offsetWidth <= rail.scrollLeft + rail.clientWidth, scrollTop: ${CONTENT}.scrollTop, rail };
})()`;

/** A real mouse click at the element's centre, without scrolling anything first (page.click centres the element). */
async function tap(page: Page, expression: string, what: string) {
  const at = await page.evaluate<{ x: number; y: number; hit: boolean } | null>(`(() => {
    const el = ${expression};
    if (!el) return null;
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)) };
  })()`);
  assert.ok(at, `${what} is on the page`);
  assert.ok(at.hit, `${what} is not covered`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
/** Waits until the content has stopped scrolling (a rail click scrolls smoothly). */
async function settle(page: Page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await page.evaluate<number>(`${CONTENT}.scrollTop`);
    if (now === last) return;
    last = now;
  }
}

async function setUp(hub: TestHub) {
  const { cluster, members } = await hub.cluster('roles', ['alpha', 'beta', 'gamma']);
  const collab = (command: Record<string, unknown>) => hub.api('POST', `/api/clusters/${cluster.id}/collaboration`, { operationId: crypto.randomUUID(), ...command });
  await collab({ action: 'coordinator.set', memberId: members[0].id, enabled: true, mode: 'execute', permissions: { taskPlanning: true } });
  for (const text of ['每个任务写清验收标准', '晚上不派新任务']) await collab({ action: 'coordinator.instruction.add', instructionText: text });
  return collab;
}

async function openRoles(page: Page, hub: TestHub, width: number, height: number) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
  await page.waitFor(`[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'roles')`, 'the cluster');
  await page.evaluate(`[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'roles').click()`);
  await page.waitFor(`document.getElementById('open-workbench') && !document.getElementById('open-workbench').hidden`, 'the workbench button');
  await page.evaluate(`document.getElementById('open-workbench').click()`);
  await page.waitFor(`document.querySelector('dialog[open] .workbench-tabs')`, 'the workbench');
  await page.evaluate(`[...document.querySelectorAll('dialog[open] .workbench-tabs button')].find((b) => b.textContent === '角色与协调').click()`);
  await page.waitFor(`document.querySelectorAll('dialog[open] .wb-rp-card').length === 7 && document.querySelector('dialog[open] .wb-rp-instruction')`, 'the roles page');
  // The refreshes that follow opening the workbench redraw it a few times; start once it has been still for 800 ms.
  await page.evaluate(`(() => { window.__drawn = Date.now(); new MutationObserver(() => { window.__drawn = Date.now(); }).observe(${CONTENT}, { childList: true }); return true; })()`);
  await page.waitFor(`Date.now() - window.__drawn > 800`, 'the page to settle', 10_000);
}

test('task permission card saves all three role lists; coordinator bypass belongs to Task planning', { skip, timeout: 180_000 }, async () => {
  assert.ok(found.path);
  const hub = await startTestHub();
  let browser: Browser | undefined;
  const output = process.env.ORRERY_TASK_PERMISSIONS_SHOT_DIR;
  try {
    const command = await setUp(hub);
    const roles = await Promise.all(['建单成员', '交付成员', '独立验收'].map(async (name) =>
      (await command({ action: 'role.create', name })).role.id as string));
    const clusterId = hub.hub.listClusters().find((cluster) => cluster.name === 'roles')!.id;
    const workspace = () => hub.api('GET', `/api/clusters/${clusterId}/workspace`);
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const card = "document.getElementById('wb-rp-task-permissions')";
    const savedRoles = { createRoleIds: [roles[0]], executeRoleIds: [roles[1]], reviewRoleIds: [roles[2]] };
    const capture = async (name: string) => {
      if (!output) return;
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, name + '.png'), Buffer.from(data, 'base64'));
    };
    await openRoles(page, hub, 1280, 720);
    assert.equal(await page.evaluate(`[...${card}.querySelectorAll('.wb-rp-desc')].every(el => el.textContent === '所有成员')`), true);
    await page.evaluate(`${railItem('任务权限')}.click()`);
    await settle(page);
    await page.click(`${card}.querySelector('button')`, 'edit task permissions');
    const chooser = '[data-task-permission]';
    await page.waitFor(`document.querySelectorAll('${chooser}').length === 3`, 'three role pickers');
    await page.evaluate(`(() => {
      const choices = ${JSON.stringify(savedRoles)};
      for (const [key, ids] of Object.entries(choices)) {
        const fields = document.querySelector('[data-task-permission="' + key + '"]');
        for (const input of fields.querySelectorAll('input')) input.checked = ids.includes(input.value);
      }
    })()`);
    await capture('task-permissions-edit');
    const save = "document.querySelector('dialog[open] .workbench-form button[type=submit]')";
    await page.click(save, 'save role lists');
    await page.waitFor(`!document.querySelector('${chooser}') && ${card}.textContent.includes('独立验收')`, 'saved card');
    assert.deepEqual((await workspace()).taskPermissions, savedRoles);
    await page.evaluate(`${railItem('任务权限')}.click()`);
    await settle(page);
    await capture('task-permissions-card');

    const coordinatorEdit = "document.getElementById('wb-rp-coordinator').querySelector('.wb-rp-actions button')";
    await page.evaluate(`${railItem('协调员')}.click()`);
    await settle(page);
    await page.click(coordinatorEdit, 'edit coordinator permissions');
    const bypass = "document.querySelector('[data-coordinator-task-role-bypass]')";
    await page.waitFor(bypass, 'task planning bypass');
    assert.equal(await page.evaluate(`${bypass}.checked`), false);
    await page.click(bypass, 'allow coordinator role bypass');
    await capture('task-permissions-coordinator');
    await page.click(save, 'save coordinator authorization');
    await page.waitFor(`!${bypass}`, 'authorization saved');
    assert.equal((await workspace()).coordinator.taskPlanningRoleBypass, true);
    assert.deepEqual((await workspace()).taskPermissions, savedRoles);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`${railItem('任务权限')}.click()`);
    await settle(page);
    assert.equal(await page.evaluate(`${card}.scrollWidth <= ${card}.clientWidth`), true);
    await capture('task-permissions-narrow');
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});

test('roles page at 375 px: a redraw keeps the current rail item in view and the page where it was', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  try {
    const collab = await setUp(hub);
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await openRoles(page, hub, 375, 812);
    // The last item: the rail scrolls to show it, the page scrolls to the last card.
    await page.evaluate(`${RAIL}.scrollLeft = ${RAIL}.scrollWidth; true`);
    await tap(page, railItem('本群设置'), '本群设置 in the rail');
    await settle(page);
    const before =await page.evaluate<any>(`(() => { const s = ${RAIL_STATE}; window.__rail = s.rail; delete s.rail; return s; })()`);
    assert.equal(before.current, '本群设置');
    assert.ok(before.left > 0 && before.visible, `the rail shows the last item: ${JSON.stringify(before)}`);

    // A user command: the switch posts, the workbench refreshes and draws a new rail.
    const delivery = `document.querySelector('dialog[open] [aria-labelledby="wb-rp-delivery-title"]')`;
    await tap(page, delivery, 'the delivery switch');
    await page.waitFor(`${delivery}?.checked === false && ${RAIL} !== window.__rail`, 'the redraw after the command');
    const afterCommand = await page.evaluate<any>(`(() => { const s = ${RAIL_STATE}; window.__rail = s.rail; delete s.rail; return s; })()`);
    assert.equal(afterCommand.current, '本群设置');
    assert.ok(afterCommand.visible, `the current item is still in the rail's view: ${JSON.stringify(afterCommand)}`);
    assert.equal(afterCommand.scrollTop, before.scrollTop, 'the page did not move vertically');

    // A background change from elsewhere (a role made over the API) redraws the page the same way.
    await collab({ action: 'role.create', name: '后来的角色' });
    await page.waitFor(`${RAIL} !== window.__rail && document.querySelector('dialog[open] .wb-rp-roles').textContent.includes('后来的角色')`, 'the background redraw');
    const afterRefresh = await page.evaluate<any>(`(() => { const s = ${RAIL_STATE}; delete s.rail; return s; })()`);
    assert.equal(afterRefresh.current, '本群设置');
    assert.ok(afterRefresh.visible, `still in view after a background refresh: ${JSON.stringify(afterRefresh)}`);
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});

test('roles page opened wide then narrowed to 375 px: the rail sits under the wrapped tabs and every item is clickable', { skip, timeout: 120_000 }, async () => {
  assert.ok(found.path, `ORRERY_REQUIRE_BROWSER=1 but ${found.path === null ? found.reason : ''}`);
  const hub = await startTestHub();
  let browser: Browser | null = null;
  try {
    await setUp(hub);
    browser = await launchBrowser(found.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await openRoles(page, hub, 1280, 900);
    const wideTabs = await page.evaluate<number>(`document.querySelector('dialog[open] .workbench-tabs').offsetHeight`);
    // The window narrows with the workbench open: no redraw happens, the tabs wrap to two rows.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`document.querySelector('dialog[open] .workbench-tabs').offsetHeight > ${wideTabs}`, 'the tabs to wrap');
    await page.waitFor(`${CONTENT}.style.getPropertyValue('--wb-tabs-height') === document.querySelector('dialog[open] .workbench-tabs').offsetHeight + 'px'`,
      'the sticky offset to follow the tabs');

    // Go to a middle section, then check every item where a user would click it.
    await page.evaluate(`(() => { const b = ${railItem('成员角色')}; ${RAIL}.scrollLeft = b.offsetLeft - 8; return true; })()`);
    await tap(page, railItem('成员角色'), '成员角色 in the rail');
    await settle(page);
    const layout = await page.evaluate<any>(`(() => {
      const tabs = document.querySelector('dialog[open] .workbench-tabs').getBoundingClientRect();
      const rail = ${RAIL}.getBoundingClientRect();
      const card = document.querySelector('dialog[open] .wb-rp-member-roles').getBoundingClientRect();
      return { tabsBottom: tabs.bottom, railTop: rail.top, railBottom: rail.bottom, cardTop: card.top,
        current: ${RAIL}.querySelector('[aria-current="true"]').textContent };
    })()`);
    assert.equal(layout.current, '成员角色');
    assert.ok(layout.railTop >= layout.tabsBottom - 1, `the rail is under the tabs, not behind them: ${JSON.stringify(layout)}`);
    assert.ok(layout.cardTop >= layout.railBottom - 1, `the chosen card starts below the rail: ${JSON.stringify(layout)}`);
    const labels = await page.evaluate<string[]>(`[...${RAIL}.querySelectorAll('button')].map((b) => b.textContent)`);
    assert.equal(labels.length, 7);
    for (const label of labels) {
      const hit = await page.evaluate<boolean>(`(() => {
        const b = ${railItem(label)}, rail = ${RAIL};
        rail.scrollLeft = Math.max(0, b.offsetLeft - 8);
        const r = b.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at === b || b.contains(at);
      })()`);
      assert.ok(hit, `${label}: the item itself is under its centre`);
    }
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
