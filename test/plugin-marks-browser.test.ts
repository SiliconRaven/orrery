// Third-party plugin marks in the real page (headless, test/browser.ts; docs/external-plugins.md「标记」): on a message
// (at most two, the rest behind "+N", which lists them all), on a member in the member list (one) and on a task card and
// the task detail (two, after orrery's own labels). Each mark carries the host's third-party icon and an accessible name
// starting with 第三方插件：; hovering it or focusing it by keyboard shows the plugin's name and the tip; plugin strings that
// look like HTML stay text; clicking a mark does nothing (a task card stays closed); marks follow the plugin live. All
// three places in the three themes at 1440 and 375 px. Uses the shared profile slots; run this file alone
// (--test-concurrency=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { insertMessageWithEvent, startTestHub, tempDir, TEST_TOKEN, waitFor, type TestHub } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;
const SHOTS = join(REPO_ROOT, '.tmp', 'plugin-ui-shots');
const PLUGINS: Record<string, string> = { 'mark-alpha': 'Alpha 标记', 'mark-beta': 'Beta 标记', 'mark-gamma': 'Gamma 标记' };

function setup(): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const store = new Store(join(dir, 'test.db'));
  store.insertCluster({ id: 'c1', name: '标记群', category: '', createdAt: '2026-01-01' }, ['Alice', 'Bob'].map((name) => ({ id: `c1-${name}`,
    clusterId: 'c1', name, avatar: '', harness: 'mock', model: null, effort: null, workerSessionId: `c1-${name}`, cwd: dir,
    origin: 'attached' as const, removedAt: null })));
  for (const [i, body] of ['第一条消息', '第二条消息：构建开始', '第三条消息：请看构建结果'].entries()) {
    const id = `msg-${i + 1}`;
    insertMessageWithEvent(store, { id, clusterId: 'c1', from: 'user', mentions: [], body, replyTo: null, chainId: id, hop: 0,
      createdAt: new Date(Date.now() - (3 - i) * 60_000).toISOString() });
  }
  store.close();
  const entries = Object.entries(PLUGINS).map(([id, name]) => {
    const folder = join(dir, 'plugins', id);
    cpSync(join(REPO_ROOT, 'test', 'fixtures', 'ui-probe'), folder, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(folder, 'orrery-plugin.json'), 'utf8'));
    Object.assign(manifest, { id, name });
    manifest.ui.positions.push('marks');
    writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify(manifest));
    return { manifest: join(folder, 'orrery-plugin.json'), permissions: ['ui.show'], ui: ['marks'], clusterIds: ['c1'] };
  });
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: entries }));
  return dir;
}

const mark = async (app: TestHub, plugin: string, target: string, targetId: string, text: string | null, state?: string, tip?: string) => {
  const answer = (await app.api('POST', `/api/plugins/${plugin}/invoke`, { command: 'raw', arguments: { method: 'host.ui.mark',
    params: { clusterId: 'c1', target, targetId, text, ...(state ? { state } : {}), ...(tip ? { tip } : {}) } } })).result;
  assert.ok(answer.result, `${plugin} ${target} ${targetId}: ${JSON.stringify(answer)}`);
};

test('browser: plugin marks on messages, members and tasks', { skip, timeout: 240_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const app = await startTestHub({ dir: setup() });
  let browser: Browser | null = null;
  let step = 'setup';
  const shot = async (name: string) => {
    const { data } = await browser!.page.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `marks-${name}.png`), Buffer.from(data, 'base64'));
  };
  try {
    await waitFor(async () => (await app.api('GET', '/api/plugins')).installed.filter((p: any) => p.origin === 'external')
      .every((p: any) => p.runtime?.state === 'ready'), 'the plugins', 15_000);
    const task = (await app.api('POST', '/api/clusters/c1/collaboration', { action: 'task.create', operationId: 'create', title: '修好构建',
      scope: 's', acceptance: 'a', memberId: null, labels: ['前端'] })).task;
    await mark(app, 'mark-alpha', 'message', 'msg-3', 'CI 通过', 'done', '第 128 次构建');
    await mark(app, 'mark-beta', 'message', 'msg-3', '<b>粗</b>', 'info', '<img src=x onerror=alert(1)>');
    await mark(app, 'mark-gamma', 'message', 'msg-3', '审阅中', 'running');
    await mark(app, 'mark-gamma', 'message', 'msg-2', '默认样式');
    await mark(app, 'mark-alpha', 'member', 'c1-Alice', '值班', 'info', '今天值班到 18 点');
    await mark(app, 'mark-beta', 'member', 'c1-Alice', '忙', 'failed');
    await mark(app, 'mark-alpha', 'task', task.id, 'CI 失败', 'failed', '第 3 步失败');
    await mark(app, 'mark-beta', 'task', task.id, '已同步', 'done');
    await mark(app, 'mark-gamma', 'task', task.id, '待审阅', 'running', '等 Gamma 审阅');

    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const size = (width: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: false });
    const slot = (target: string, id: string, within = 'document') =>
      `[...((${within})?.querySelectorAll('.pui-marks[data-pui-marks="${target}"]') ?? [])].find((s) => s.dataset.puiId === ${JSON.stringify(id)} && s.offsetParent)`;
    const marksIn = (s: string) => `[...(${s}?.querySelectorAll(':scope > .pui-mark') ?? [])]`;
    const center = async (expression: string) => page.evaluate<{ x: number; y: number }>(`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const key = async (name: string, code: number, shift = false) => {
      for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 });
    };

    step = 'open the cluster';
    await size(1440);
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === '标记群')`;
    await page.waitFor(item, 'the cluster');
    await page.click(item, 'the cluster');

    step = 'a message: two marks sorted by plugin name, the rest behind +N';
    const msg3 = slot('message', 'msg-3');
    await page.waitFor(`${marksIn(msg3)}.length === 2`, 'the two marks on the latest message');
    assert.deepEqual(await page.evaluate(`${marksIn(msg3)}.map((m) => m.dataset.pluginMark)`), ['mark-alpha', 'mark-beta']);
    assert.equal(await page.evaluate(`${msg3}.querySelector('.pui-marks-more').textContent`), '+1');
    assert.equal(await page.evaluate(`${msg3}.closest('.msg').querySelector('.msg-body').nextElementSibling === ${msg3}`), true, 'the row right under the body');
    for (const [i, name] of [[0, 'Alpha 标记'], [1, 'Beta 标记']] as const) {
      assert.equal(await page.evaluate(`Boolean(${marksIn(msg3)}[${i}].querySelector('svg.ico use[href="#i-layers"]'))`), true, `${name}: the host icon`);
      assert.match(await page.evaluate<string>(`${marksIn(msg3)}[${i}].getAttribute('aria-label')`), new RegExp(`^第三方插件：${name}：`), `${name}: its accessible name`);
    }
    // HTML from the plugin is text: no element made of it, no script run.
    assert.equal(await page.evaluate(`${marksIn(msg3)}[1].querySelector('.pui-mark-text').textContent`), '<b>粗</b>');
    assert.equal(await page.evaluate(`${marksIn(msg3)}[1].querySelector('.pui-mark-text').childElementCount`), 0);
    assert.equal(await page.evaluate(`${msg3}.querySelectorAll('img').length`), 0);
    assert.match(await page.evaluate<string>(`${marksIn(msg3)}[1].querySelector('.pui-mark-tip').textContent`), /<img src=x onerror=alert\(1\)>/);
    assert.equal(await page.evaluate(`${marksIn(slot('message', 'msg-2'))}.length`), 1);
    assert.equal(await page.evaluate(`${slot('message', 'msg-2')}.querySelector('.pui-marks-more')`), null, 'no +N with one mark');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.pui-marks[data-pui-marks="message"]')].find((s) => s.dataset.puiId === 'msg-1').hidden`), true, 'no marks: no row');

    step = 'hover and keyboard focus show the plugin name and the tip';
    const tipShown = (expression: string) => `getComputedStyle(${expression}.querySelector('.pui-mark-tip')).display !== 'none'`;
    assert.equal(await page.evaluate(tipShown(`${marksIn(msg3)}[0]`)), false, 'hidden at rest');
    const alpha = await center(`${marksIn(msg3)}[0]`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: alpha.x, y: alpha.y });
    await page.waitFor(tipShown(`${marksIn(msg3)}[0]`), 'the tip on hover');
    assert.equal(await page.evaluate(`${marksIn(msg3)}[0].querySelector('.pui-mark-tip').textContent`), 'Alpha 标记（第三方插件）第 128 次构建');
    await shot('hover-1440');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await page.evaluate(`${marksIn(msg3)}[0].focus()`);
    await key('Tab', 9);
    await page.waitFor(`document.activeElement === ${marksIn(msg3)}[1] && document.activeElement.matches(':focus-visible')`, 'Tab onto the second mark');
    await page.waitFor(tipShown(`${marksIn(msg3)}[1]`), 'the tip on keyboard focus');
    assert.match(await page.evaluate<string>(`${marksIn(msg3)}[1].querySelector('.pui-mark-tip').textContent`), /^Beta 标记（第三方插件）/);

    step = '+N opens the full list; Esc closes it; clicking a mark does nothing';
    await page.click(`${msg3}.querySelector('.pui-marks-more')`, 'the +1');
    await page.waitFor(`${msg3}.querySelectorAll('.pui-marks-all .pui-marks-all-row').length === 3`, 'the full list');
    assert.deepEqual(await page.evaluate(`[...${msg3}.querySelectorAll('.pui-marks-all-who')].map((e) => e.textContent)`), ['Alpha 标记', 'Beta 标记', 'Gamma 标记']);
    assert.equal(await page.evaluate(`${msg3}.querySelector('.pui-marks-more').getAttribute('aria-expanded')`), 'true');
    await shot('message-all-1440');
    await page.evaluate(`${msg3}.querySelector('.pui-marks-all .pui-mark').focus()`);
    await key('Escape', 27);
    await page.waitFor(`!${msg3}.querySelector('.pui-marks-all') && document.activeElement === ${msg3}.querySelector('.pui-marks-more')`, 'Esc closed it, focus on +N');
    const url = await page.evaluate<string>('location.href');
    await page.click(`${marksIn(msg3)}[0]`, 'a mark');
    assert.equal(await page.evaluate('location.href'), url);
    assert.equal(await page.evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'nothing opened');

    step = 'a member: one mark in the member list, right of the name';
    await page.click(`document.getElementById('members-toggle')`, 'the member panel');
    const alice = slot('member', 'c1-Alice', `document.getElementById('manage-list')`);
    await page.waitFor(`${marksIn(alice)}.length === 1`, 'the member mark');
    assert.equal(await page.evaluate(`${marksIn(alice)}[0].dataset.pluginMark`), 'mark-alpha');
    assert.equal(await page.evaluate(`${alice}.querySelector('.pui-marks-more').textContent`), '+1');
    assert.equal(await page.evaluate(`${alice}.closest('.member-name-line').querySelector('b').textContent`), 'Alice');
    const geometry = await page.evaluate<{ nameRight: number; markLeft: number; sameLine: boolean }>(`(() => {
      const name = ${alice}.closest('.member-name-line').querySelector('b').getBoundingClientRect(); const m = ${alice}.getBoundingClientRect();
      return { nameRight: name.right, markLeft: m.left, sameLine: Math.abs((name.top + name.bottom) / 2 - (m.top + m.bottom) / 2) < 8 };
    })()`);
    assert.ok(geometry.markLeft >= geometry.nameRight && geometry.sameLine, `right of the name (${JSON.stringify(geometry)})`);
    // A listener on the row's own button tells whether a click got through; the slot stops every click inside it.
    const memberOpen = `${alice}.closest('button.member-open')`;
    await page.evaluate(`(() => { globalThis.rowClicks = 0; ${memberOpen}.addEventListener('click', () => { globalThis.rowClicks++; }); })()`);
    await page.click(`${marksIn(alice)}[0]`, 'the member mark');
    await page.click(`${alice}.querySelector('.pui-marks-more')`, 'the member +1');
    await page.waitFor(`${alice}.querySelector('.pui-marks-all')`, 'the member mark list');
    await page.click(`${alice}.querySelector('.pui-marks-all-who')`, 'a row of the list');
    await page.click(`${alice}.querySelector('.pui-marks-all-tip')`, 'a tip in the list');
    assert.equal(await page.evaluate('globalThis.rowClicks'), 0, 'no click reached the member button');
    assert.equal(await page.evaluate(`Boolean(${alice}) && document.getElementById('members-toggle').getAttribute('aria-expanded') === 'true'`), true, 'still the list');

    step = 'a mark frame while the list is open keeps it open and keeps focus; one for another target does not redraw it';
    await page.evaluate(`${alice}.querySelector('.pui-marks-more').focus()`);
    const moreBefore = await page.evaluate(`globalThis.moreBefore = ${alice}.querySelector('.pui-marks-more'), true`);
    assert.equal(moreBefore, true);
    await mark(app, 'mark-beta', 'member', 'c1-Bob', '别人');
    await page.waitFor(`${marksIn(slot('member', 'c1-Bob', `document.getElementById('manage-list')`))}.length === 1`, 'the other member\'s mark');
    assert.equal(await page.evaluate(`${alice}.querySelector('.pui-marks-more') === globalThis.moreBefore && document.activeElement === globalThis.moreBefore`), true, 'not redrawn');
    await mark(app, 'mark-gamma', 'member', 'c1-Alice', '第三个', 'info');
    await page.waitFor(`${alice}.querySelectorAll('.pui-marks-all .pui-marks-all-row').length === 3 && ${alice}.querySelector('.pui-marks-more').textContent === '+2'`, 'the list redrawn with the new mark');
    assert.equal(await page.evaluate(`document.activeElement === ${alice}.querySelector('.pui-marks-more')`), true, 'focus kept on +N');

    step = 'Esc with focus on +N closes only the list, not the member panel';
    await key('Escape', 27);
    await page.waitFor(`!${alice}.querySelector('.pui-marks-all')`, 'the list closed');
    assert.equal(await page.evaluate(`document.getElementById('members-toggle').getAttribute('aria-expanded')`), 'true', 'the member panel stays open');
    assert.equal(await page.evaluate(`document.activeElement === ${alice}.querySelector('.pui-marks-more')`), true);
    await mark(app, 'mark-gamma', 'member', 'c1-Alice', null);
    await mark(app, 'mark-beta', 'member', 'c1-Bob', null);
    await page.click(`document.getElementById('members-toggle')`, 'close the member panel');
    await page.waitFor(`document.getElementById('members-toggle').getAttribute('aria-expanded') === 'false'`, 'the member panel closed');

    step = 'a task: on its card after the labels, and in the detail; clicking a mark does not open the task';
    await page.evaluate(`document.getElementById('open-workbench').click()`);
    await page.waitFor(`document.querySelector('dialog.workbench[open]')`, 'the workbench opened');
    const card = `[...document.querySelectorAll('.workbench-task')].find((c) => c.textContent.includes('修好构建'))`;
    await page.waitFor(card, 'the task card');
    const onCard = slot('task', task.id, card);
    await page.waitFor(`${marksIn(onCard)}.length === 2`, 'the task card marks');
    assert.equal(await page.evaluate(`${onCard}.parentElement.classList.contains('wb-task-labels') && ${onCard}.previousElementSibling?.textContent === '前端'`), true, 'after the labels');
    assert.equal(await page.evaluate(`${onCard}.querySelector('.pui-marks-more').textContent`), '+1');
    // The card's own click handler opens the task: a listener beside it counts the clicks that get through (dispatched
    // synchronously with the mouse event, so counting after the awaited click is deterministic).
    await page.evaluate(`(() => { globalThis.cardClicks = 0; ${card}.addEventListener('click', () => { globalThis.cardClicks++; }); })()`);
    await page.click(`${marksIn(onCard)}[0]`, 'a mark on the card');
    await page.click(`${onCard}.querySelector('.pui-marks-more')`, 'the card +1');
    await page.waitFor(`${onCard}.querySelector('.pui-marks-all')`, 'the card mark list');
    await page.click(`${onCard}.querySelector('.pui-marks-all-who')`, 'a row of the list');
    await page.click(`${onCard}.querySelector('.pui-marks-all-tip')`, 'a tip in the list');
    assert.equal(await page.evaluate('globalThis.cardClicks'), 0, 'no click reached the card');
    assert.equal(await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => resolve(${card}.getAttribute('aria-current'))))`), 'false', 'the card did not open');
    await page.evaluate(`${onCard}.querySelector('.pui-marks-more').focus()`);
    await key('Escape', 27);
    await page.waitFor(`!${onCard}.querySelector('.pui-marks-all')`, 'Esc closed the card list');
    assert.equal(await page.evaluate(`document.querySelector('dialog.workbench').open`), true, 'the workbench stays open');
    await page.click(`${card}.querySelector('.wb-task-title')`, 'the task card');
    const detailRow = `[...document.querySelectorAll('dialog.workbench .wb-row')].find((r) => r.querySelector('.wb-row-key')?.textContent === '标签')`;
    const inDetail = slot('task', task.id, detailRow);
    await page.waitFor(`${marksIn(inDetail)}.length === 2`, 'the task detail marks');
    assert.deepEqual(await page.evaluate(`${marksIn(inDetail)}.map((m) => m.dataset.pluginMark)`), ['mark-alpha', 'mark-beta']);
    await page.evaluate(`document.querySelector('dialog.workbench').close()`);

    step = 'every place in every theme, 1440 and 375 px';
    for (const width of [1440, 375]) {
      await size(width);
      await page.navigate(`${app.url}/?width=${width}#c=c1`);
      await page.waitFor(`${marksIn(msg3)}.length === 2`, 'the message marks at this width');
      for (const theme of ['light', 'dark', 'orrery']) {
        await page.evaluate(`globalThis.orreryTheme.set('${theme}')`);
        await page.evaluate(`${msg3}.scrollIntoView({ block: 'center' })`);
        const box = await page.evaluate<{ left: number; right: number; viewport: number }>(`(() => { const r = ${msg3}.getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth }; })()`);
        assert.ok(box.left >= 0 && box.right <= box.viewport, `${theme} ${width}: the message marks are on screen (${JSON.stringify(box)})`);
        await shot(`${theme}-${width}-message`);
        await page.click(`document.getElementById('members-toggle')`, 'the member panel');
        await page.waitFor(`${marksIn(slot('member', 'c1-Alice', `document.getElementById('manage-list')`))}.length === 1`, 'the member mark');
        await shot(`${theme}-${width}-member`);
        // On a phone the open panel covers the toggle: closed the way its own close control does, by the toggle's handler.
        await page.evaluate(`document.getElementById('members-toggle').click()`);
        await page.waitFor(`document.getElementById('members-toggle').getAttribute('aria-expanded') === 'false'`, 'the member panel closed');
        await page.click(`document.getElementById('open-workbench')`, 'the workbench');
        await page.waitFor(`${marksIn(onCard)}.length === 2`, 'the task card marks');
        await shot(`${theme}-${width}-task-card`);
        await page.click(`${card}.querySelector('.wb-task-title')`, 'the task card');
        await page.waitFor(`${marksIn(inDetail)}.length === 2`, 'the task detail marks');
        await page.evaluate(`${inDetail}.scrollIntoView({ block: 'center' })`);
        await shot(`${theme}-${width}-task-detail`);
        await page.evaluate(`document.querySelector('dialog.workbench').close()`);
      }
    }
    await size(1440);
    await page.evaluate(`globalThis.orreryTheme.set('system')`);

    step = 'marks follow the plugin live: set, clear, stop';
    await mark(app, 'mark-gamma', 'message', 'msg-1', '新来的', 'info');
    await page.waitFor(`${marksIn(slot('message', 'msg-1'))}.length === 1`, 'a new mark appears');
    await mark(app, 'mark-gamma', 'message', 'msg-1', null);
    await page.waitFor(`[...document.querySelectorAll('.pui-marks[data-pui-marks="message"]')].find((s) => s.dataset.puiId === 'msg-1').hidden`, 'a cleared mark goes');
    await app.api('POST', '/api/plugins/mark-alpha/stop', {});
    await page.waitFor(`${marksIn(msg3)}.map((m) => m.dataset.pluginMark).join() === 'mark-beta,mark-gamma' && !${msg3}.querySelector('.pui-marks-more')`,
      'a stopped plugin\'s marks go');
    await app.api('POST', '/api/plugins/mark-alpha/start', {});

    step = 'a message kept aside by a filter shows its marks as they are when it comes back';
    // 只看警告 hides every message here: the chat keeps their elements and puts them back unchanged when it is cleared.
    const msg2 = slot('message', 'msg-2');
    const warningsOnly = (on: boolean) => page.evaluate(`(() => { const box = document.querySelector('[data-filter="warningsOnly"]'); if (box.checked !== ${on}) box.click(); return true; })()`);
    await page.waitFor(`${marksIn(msg2)}.length === 1`, 'the Gamma mark on message 2');
    const kept = await page.evaluate(`globalThis.keptMessage = ${msg2}.closest('.msg'), true`);
    assert.equal(kept, true);
    // The member panel stays open beside the chat: a Gamma mark on Alice there shows when the page has heard Gamma's frames.
    await page.click(`document.getElementById('members-toggle')`, 'the member panel');
    // Alice has Beta's mark (Alpha's went with its restart); a second one, Gamma's, shows as "+1".
    const aliceGamma = `Boolean(${slot('member', 'c1-Alice', `document.getElementById('manage-list')`)}?.querySelector('.pui-marks-more'))`;
    await page.waitFor(`${marksIn(slot('member', 'c1-Alice', `document.getElementById('manage-list')`))}.length === 1 && !(${aliceGamma})`, 'Beta\'s mark alone on Alice');
    await mark(app, 'mark-gamma', 'member', 'c1-Alice', '旁证', 'info');
    await page.waitFor(aliceGamma, 'the Gamma mark on Alice');
    await warningsOnly(true);
    await page.waitFor(`!globalThis.keptMessage.isConnected`, 'the message taken out by the filter');
    await app.api('PATCH', '/api/plugins/mark-gamma/lifecycle', { ui: false });   // its marks are cleared while the message is out
    await page.waitFor(`!(${aliceGamma})`, 'the page heard the clearing');
    await warningsOnly(false);
    await page.waitFor(`globalThis.keptMessage.isConnected`, 'the same element back');
    await page.waitFor(`!globalThis.keptMessage.querySelector('.pui-mark') && globalThis.keptMessage.querySelector('.pui-marks').hidden`, 'no stale mark on it');
    await app.api('PATCH', '/api/plugins/mark-gamma/lifecycle', { ui: true });
    await warningsOnly(true);
    await page.waitFor(`!globalThis.keptMessage.isConnected`, 'taken out again');
    await mark(app, 'mark-gamma', 'message', 'msg-2', '离开时设的', 'done');   // set while the message is out
    await mark(app, 'mark-gamma', 'member', 'c1-Alice', '旁证', 'info');      // the frames arrive in order: this one shows the first was heard
    await page.waitFor(aliceGamma, 'the page heard the new mark');
    await warningsOnly(false);
    await page.waitFor(`globalThis.keptMessage.isConnected`, 'back again');
    await page.waitFor(`globalThis.keptMessage.querySelector('.pui-mark-text')?.textContent === '离开时设的'`, 'the mark set meanwhile is shown');

    step = 'a list read before a frame never overwrites what the frame did: a late answer, the next read delayed, then failing';
    // Each read of c1's list goes to the Hub at once (so its answer is the Hub's state when it was sent) and is handed to
    // the page only when the test releases it: pass, or fail as a network error would.
    await page.evaluate(`(() => {
      globalThis.listings = [];
      const original = window.fetch;
      window.fetch = async (input, init) => {
        if ((init?.method ?? 'GET') !== 'GET' || !String(input).endsWith('/api/clusters/c1/plugin-ui')) return original(input, init);
        const res = await original(input, init);
        const body = await res.text();
        const how = await new Promise((resolve) => globalThis.listings.push(resolve));
        if (how === 'fail') throw new TypeError('the read failed');
        return new Response(body, { status: res.status, headers: res.headers });
      };
      return true;
    })()`);
    const bob = slot('member', 'c1-Bob', `document.getElementById('manage-list')`);
    const bobMarks = `${marksIn(bob)}.map((m) => m.dataset.pluginMark + ':' + m.querySelector('.pui-mark-text').textContent).join()`;
    await mark(app, 'mark-beta', 'member', 'c1-Bob', '晚到', 'info');
    await page.waitFor(`${bobMarks}.includes('mark-beta')`, 'Beta\'s mark on Bob');
    await app.api('PATCH', '/api/plugins/mark-alpha/lifecycle', { autoRestart: true });   // a plugin-state frame: the page reads the list
    await page.waitFor(`globalThis.listings.length === 1`, 'a read on its way, with Bob\'s mark in it');
    await mark(app, 'mark-beta', 'member', 'c1-Bob', null);   // a frame after that read was sent
    await page.waitFor(`${bobMarks} === ''`, 'the clear shown');
    await page.evaluate(`globalThis.listings[0]('pass'), true`);
    await page.waitFor(`globalThis.listings.length === 2`, 'the late answer dropped and the list read again');
    assert.equal(await page.evaluate(bobMarks), '', 'the cleared mark did not come back');
    // (a) the next read delayed: a mark set by a frame meanwhile shows and stays when that read's (older) answer comes.
    await mark(app, 'mark-gamma', 'member', 'c1-Bob', '飞行中', 'running');
    await page.waitFor(`${bobMarks}.startsWith('mark-gamma')`, 'the mark set during the read');
    assert.equal(await page.evaluate(`${marksIn(bob)}.length`), 1);
    await page.evaluate(`globalThis.listings[1]('pass'), true`);
    await page.waitFor(`globalThis.listings.length === 3`, 'that answer dropped too, read again');
    assert.match(await page.evaluate<string>(bobMarks), /^mark-gamma:.*飞行中$/, 'the mark from the frame kept, the cleared one not back');
    // (b) the next read fails: the page keeps what the frames gave it.
    await page.evaluate(`globalThis.listings[2]('fail'), true`);
    await page.evaluate(`new Promise((resolve) => setTimeout(() => resolve(true), 0))`);   // the rejection is handled in microtasks before this
    assert.match(await page.evaluate<string>(bobMarks), /^mark-gamma:.*飞行中$/, 'unchanged after the failed read');
    // Reads that answer after the last frame are applied: the page and the Hub agree.
    await page.evaluate(`(() => { const original = globalThis.listings; globalThis.listings = { push: (resolve) => resolve('pass'), get length() { return 0; } }; return Boolean(original); })()`);
    await app.api('PATCH', '/api/plugins/mark-alpha/lifecycle', { autoRestart: false });
    await mark(app, 'mark-gamma', 'member', 'c1-Bob', null);
    await page.waitFor(`${bobMarks} === ''`, 'cleared through the stream with reads passing');

    step = 'a long tip stays inside the visible area at every position, on hover and on keyboard focus, at 375 and 1440 px';
    const LONG = '插件说明'.repeat(20);   // 80 characters, the most a tip keeps
    await mark(app, 'mark-beta', 'message', 'msg-3', '<b>粗</b>', 'info', LONG);
    await mark(app, 'mark-beta', 'member', 'c1-Alice', '忙', 'failed', LONG);
    await mark(app, 'mark-gamma', 'member', 'c1-Alice', '旁证', 'info', LONG);
    await mark(app, 'mark-beta', 'task', task.id, '已同步', 'done', LONG);
    const TIP_CHECK = `globalThis.tipBox = (mark) => {
      const tip = mark?.querySelector(':scope > .pui-mark-tip');
      if (!tip || getComputedStyle(tip).display === 'none') return null;
      // The viewport cut by every ancestor that clips or scrolls (the chat, the member panel, the workbench and its panes).
      const b = tip.getBoundingClientRect();
      const a = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let up = mark.parentElement; up && up !== document.body; up = up.parentElement) {
        const s = getComputedStyle(up);
        if (s.overflowX === 'visible' && s.overflowY === 'visible' && up.tagName !== 'DIALOG') continue;
        const r = up.getBoundingClientRect();
        a.left = Math.max(a.left, r.left); a.top = Math.max(a.top, r.top); a.right = Math.min(a.right, r.left + up.clientLeft + up.clientWidth); a.bottom = Math.min(a.bottom, r.top + up.clientTop + up.clientHeight);
      }
      return { inside: b.left >= a.left - 0.5 && b.right <= a.right + 0.5 && b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5,
        box: [b.left, b.top, b.right, b.bottom].map(Math.round), area: [a.left, a.top, a.right, a.bottom].map(Math.round), text: tip.textContent.length };
    }, true`;
    const tipInside = async (expression: string, where: string) => {
      await page.evaluate(`(${expression}).scrollIntoView({ block: 'center' })`);
      // Hover.
      const at = await center(expression);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      const hovered = await page.waitFor<any>(`tipBox(${expression})`, `${where}: the tip on hover`);
      assert.ok(hovered.inside, `${where}, hover: ${JSON.stringify(hovered)}`);
      assert.ok(hovered.text > 80, `${where}: the long tip`);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      // Keyboard focus (a key first, so the page counts the next focus as keyboard focus).
      await key('Shift', 16);
      await page.evaluate(`(${expression}).focus(), true`);
      const focused = await page.waitFor<any>(`document.activeElement === (${expression}) && document.activeElement.matches(':focus-visible') && tipBox(${expression})`,
        `${where}: the tip on keyboard focus`);
      assert.ok(focused.inside, `${where}, focus: ${JSON.stringify(focused)}`);
      return focused;
    };
    const aliceIn = (within = `document.getElementById('manage-list')`) => slot('member', 'c1-Alice', within);
    const markOf = (s: string, plugin: string, inList = false) => `[...(${s}?.querySelectorAll('${inList ? '.pui-marks-all .pui-mark' : ':scope > .pui-mark'}') ?? [])].find((m) => m.dataset.pluginMark === '${plugin}')`;
    for (const width of [375, 1440]) {
      await size(width);
      await page.navigate(`${app.url}/?tips=${width}#c=c1`);
      await page.waitFor(`${markOf(msg3, 'mark-beta')}`, 'the message marks');
      await page.evaluate(TIP_CHECK);
      // The member panel stays open across a reload; on a phone it covers the chat.
      await page.evaluate(`(() => { const t = document.getElementById('members-toggle'); if (t.getAttribute('aria-expanded') === 'true') t.click(); return true; })()`);
      await page.waitFor(`document.getElementById('members-toggle').getAttribute('aria-expanded') === 'false'`, 'the member panel closed');
      await tipInside(markOf(msg3, 'mark-beta'), `${width} message`);
      await shot(`tip-${width}-message`);
      await page.evaluate(`document.getElementById('members-toggle').click()`);
      await page.waitFor(`${markOf(aliceIn(), 'mark-beta')}`, 'the member mark');
      await tipInside(markOf(aliceIn(), 'mark-beta'), `${width} member`);
      await shot(`tip-${width}-member`);
      await page.evaluate(`${aliceIn()}.querySelector('.pui-marks-more').click()`);
      await page.waitFor(`${markOf(aliceIn(), 'mark-gamma', true)}`, 'the member list');
      const list = await page.evaluate<number[]>(`(() => { const b = ${aliceIn()}.querySelector('.pui-marks-all').getBoundingClientRect(); return [b.left, b.right]; })()`);
      assert.ok(list[0] >= 0 && list[1] <= width, `${width}: the +N list inside the viewport (${list})`);
      await tipInside(markOf(aliceIn(), 'mark-gamma', true), `${width} member +N list`);
      await shot(`tip-${width}-list`);
      await page.evaluate(`document.getElementById('members-toggle').click()`);
      await page.waitFor(`document.getElementById('members-toggle').getAttribute('aria-expanded') === 'false'`, 'the member panel closed');
      await page.evaluate(`document.getElementById('open-workbench').click()`);
      await page.waitFor(`${markOf(onCard, 'mark-beta')}`, 'the task card mark');
      await tipInside(markOf(onCard, 'mark-beta'), `${width} task card`);
      await shot(`tip-${width}-task-card`);
      await page.evaluate(`${card}.querySelector('.wb-task-title').click()`);
      await page.waitFor(`${markOf(inDetail, 'mark-beta')}`, 'the task detail mark');
      await tipInside(markOf(inDetail, 'mark-beta'), `${width} task detail`);
      await shot(`tip-${width}-task-detail`);
      await page.evaluate(`document.querySelector('dialog.workbench').close()`);
    }
    await size(1440);

    const problems = browser.problems();
    assert.deepEqual(problems.exceptions, [], 'no uncaught exception');
  } catch (error) {
    try { await shot('failure'); } catch { /* no page */ }
    throw new Error(`${step}: ${(error as Error).message}`, { cause: error });
  } finally {
    await browser?.close();
    await app.close();
  }
});
