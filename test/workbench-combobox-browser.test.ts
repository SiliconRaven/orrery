// The task form's Git branch picker in the real page (headless, test/browser.ts), on a real local repository with 150
// branches: the list scrolls (wheel and keys), stays inside the viewport at 1280×720 and 375×700, Enter takes a row
// without submitting, Esc closes only the list, and saving sends the same set_git_branch request for a listed branch
// and for a name typed freely. Skipped when no supported browser is installed, unless ORRERY_REQUIRE_BROWSER=1.
// ORRERY_SHOTS=<dir> also saves screenshots there (light and dark, 1280 and 375).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { findBrowser, launchBrowser, type Browser, type Page } from './browser.ts';
import { startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;
const SHOTS = process.env.ORRERY_SHOTS;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' }).toString();

/** A repository with `main` and `count` `agent/…` branches (refs written in one go). */
function repoWithBranches(dir: string, name: string, count: number): { path: string; branches: string[] } {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  const head = git(path, 'rev-parse', 'HEAD').trim();
  const names = Array.from({ length: count }, (_, i) => `agent/worker-${String(i).padStart(3, '0')}/topic-${i % 7 ? 'fix' : 'feature'}-${i}`);
  execFileSync('git', ['update-ref', '--stdin'], { cwd: path, windowsHide: true, input: names.map((n) => `create refs/heads/${n} ${head}\n`).join('') });
  return { path, branches: ['main', ...names].sort() };
}

// Enter carries its text, as a real key does: without it there is no keypress, so no implicit form submission to test.
const key = async (page: Page, key: string, code = key, keyCode = 0) => {
  const text = key === 'Enter' ? '\r' : undefined;
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, text, unmodifiedText: text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
};
const KEYS: Record<string, [string, number]> = { ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], End: ['End', 35], Home: ['Home', 36],
  Enter: ['Enter', 13], Escape: ['Escape', 27] };
const press = (page: Page, name: string, times = 1) => (async () => { for (let i = 0; i < times; i++) await key(page, name, KEYS[name][0], KEYS[name][1]); })();

const BRANCH = `document.querySelector('input[placeholder="选择本地分支或填写分支名"]')`;
const REPO = `document.querySelector('input[placeholder="选择仓库或填写本地绝对路径"]')`;
const POPUP = (input: string) => `document.getElementById(${input}.getAttribute('aria-controls')).parentElement`;
const LIST = (input: string) => `document.getElementById(${input}.getAttribute('aria-controls'))`;
const DIALOG = `[...document.querySelectorAll('dialog[open]')].find((d) => d.querySelector('h2')?.textContent.includes('Git 分支'))`;

test('browser: the Git branch picker scrolls 150 branches, stays on screen, and saves listed and typed names', { skip, timeout: 180_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const dir = tempDir();
  const repo = repoWithBranches(dir, 'repo', 150);
  const many = repoWithBranches(dir, 'many', 450);
  const native = createMockNativeAdapter({ sessions: [{ id: 's1', title: 'Work', model: null, cwd: repo.path, updatedAt: null }] });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  app.hub.setPaused(true);
  let browser: Browser | null = null;
  let step = 'setup';
  try {
    const { cluster, members: [member] } = await app.api('POST', '/api/clusters', { name: 'branches', members: [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }] });
    const command = `/api/clusters/${cluster.id}/collaboration`;
    const task = (await app.api('POST', command, { action: 'task.create', operationId: 'create', title: 'Pick a branch',
      scope: 'Scope', acceptance: 'Done', memberId: member.id })).task;
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    const size = (width: number, height: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const shot = async (name: string) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    };
    const box = (expr: string) => page.evaluate<{ top: number; bottom: number; left: number; right: number; vw: number; vh: number }>(`(() => {
      const r = ${expr}.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: innerWidth, vh: innerHeight };
    })()`);
    const inViewport = async (what: string) => {
      const b = await box(POPUP(BRANCH));
      assert.ok(b.top >= 0 && b.left >= 0 && b.bottom <= b.vh && b.right <= b.vw, `${what}: the list ${JSON.stringify(b)} is inside the viewport`);
      assert.ok(b.bottom - b.top > 100, `${what}: the list has room (${b.bottom - b.top}px)`);
    };
    const openDialog = async (caption: string) => {
      const more = `[...document.querySelectorAll('button')].find((b) => b.textContent === '更多' && b.offsetParent)`;
      await page.waitFor(more, 'the task detail');
      await page.click(more, '更多');
      await page.click(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === ${JSON.stringify(caption)} && b.offsetParent)`, caption);
      await page.waitFor(DIALOG, 'the Git branch dialog');
    };
    const branchOptions = () => page.evaluate<number>(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length`);
    const popupOpen = () => page.evaluate<boolean>(`!${POPUP(BRANCH)}.hidden && ${BRANCH}.getAttribute('aria-expanded') === 'true'`);

    step = 'open the task';
    await size(1280, 720);
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    // Requests the page sends to the Hub's collaboration route, as the Hub receives them.
    await page.evaluate(`(() => { document.documentElement.dataset.theme = 'light'; window.__posts = []; const original = window.fetch; window.fetch = (url, init) => {
      if (String(url).endsWith('/collaboration') && init?.method === 'POST') window.__posts.push(JSON.parse(init.body));
      return original(url, init); }; return true; })()`);
    const item = `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === 'branches')`;
    await page.waitFor(item, 'the cluster');
    await page.click(item, 'the cluster');
    await page.click(`document.getElementById('open-workbench')`, 'the workbench button');
    const card = `[...document.querySelectorAll('.workbench-task')].find((c) => c.textContent.includes('Pick a branch'))`;
    await page.waitFor(card, 'the task card');
    await page.click(card, 'the task card');
    await openDialog('关联 Git 分支');

    step = 'pick the repository from its list';
    await page.waitFor(`${LIST(REPO)}.querySelectorAll('[role="option"]').length === 1`, 'the repository suggestion');
    await page.click(REPO, 'the repository field');
    await page.waitFor(`!${POPUP(REPO)}.hidden`, 'the repository list');
    await page.click(`${LIST(REPO)}.querySelector('[role="option"]')`, 'the repository row');
    assert.equal(await page.evaluate(`${REPO}.value`), repo.path);
    await page.waitFor(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length === 151`, 'the 151 branches');

    step = 'the list scrolls by wheel';
    await page.click(BRANCH, 'the branch field');
    await page.waitFor(`!${POPUP(BRANCH)}.hidden`, 'the branch list');
    const sizes = await page.evaluate<{ scroll: number; client: number }>(`({ scroll: ${LIST(BRANCH)}.scrollHeight, client: ${LIST(BRANCH)}.clientHeight })`);
    assert.ok(sizes.scroll > sizes.client * 3, `the list scrolls (${JSON.stringify(sizes)})`);
    await inViewport('1280×720');
    await shot('open-1280-light');
    const list = await box(LIST(BRANCH));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (list.left + list.right) / 2, y: (list.top + list.bottom) / 2, deltaX: 0, deltaY: 600 });
    await page.waitFor(`${LIST(BRANCH)}.scrollTop > 0`, 'the wheel to scroll the list');
    assert.equal(await popupOpen(), true, 'scrolling keeps the list open');

    step = 'keys move, the last row stays in view, Enter takes it without submitting';
    await press(page, 'ArrowDown', 151);
    const last = repo.branches.at(-1)!;
    const activeRow = `document.getElementById(${BRANCH}.getAttribute('aria-activedescendant'))`;
    assert.equal(await page.evaluate(`${activeRow}.dataset.value`), last);
    const row = await box(activeRow);
    const view = await box(LIST(BRANCH));
    assert.ok(row.top >= view.top - 1 && row.bottom <= view.bottom + 1, `the highlighted last row is visible (${JSON.stringify({ row, view })})`);
    await press(page, 'Home');
    assert.equal(await page.evaluate(`${LIST(BRANCH)}.scrollTop`), 0, 'Home scrolls back to the top');
    await press(page, 'End');
    await press(page, 'Enter');
    assert.equal(await page.evaluate(`${BRANCH}.value`), last, 'Enter fills the field');
    assert.equal(await popupOpen(), false);
    assert.ok(await page.evaluate(`Boolean(${DIALOG})`), 'Enter on the list did not submit the dialog');
    assert.deepEqual(await page.evaluate(`window.__posts`), []);

    step = 'Esc closes only the list';
    await press(page, 'ArrowDown');
    assert.equal(await popupOpen(), true);
    assert.equal(await page.evaluate(`${activeRow}.dataset.value`), last, 'reopened on the current branch');
    await press(page, 'Escape');
    assert.equal(await popupOpen(), false);
    assert.ok(await page.evaluate(`Boolean(${DIALOG})`), 'the first Esc leaves the dialog open');

    step = 'filter and pick with the mouse';
    await page.evaluate(`(${BRANCH}.select(), true)`);
    await page.send('Input.insertText', { text: 'FEATURE-1' });
    await page.waitFor(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length > 0`, 'the filtered rows');
    const filtered = await page.evaluate<string[]>(`[...${LIST(BRANCH)}.querySelectorAll('[role="option"]')].map((li) => li.dataset.value)`);
    assert.deepEqual(filtered, repo.branches.filter((b) => b.includes('feature-1')));
    assert.equal(await page.evaluate(`${LIST(BRANCH)}.querySelector('mark').textContent`), 'feature-1', 'the match is highlighted');
    await shot('filtered-1280-light');
    await page.click(`${LIST(BRANCH)}.querySelector('[role="option"]')`, 'a filtered row');
    assert.equal(await page.evaluate(`${BRANCH}.value`), filtered[0]);
    assert.equal(await popupOpen(), false);

    step = 'save a listed branch';
    await page.evaluate(`(${BRANCH}.value = ${JSON.stringify(last)}, true)`);
    await page.click(`${DIALOG}.querySelector('button.primary')`, '保存');
    await page.waitFor(`!${DIALOG}`, 'the dialog to close after saving');
    const [saved] = await page.evaluate<any[]>(`window.__posts`);
    const { operationId, ...request } = saved;
    assert.equal(typeof operationId, 'string');
    assert.deepEqual(request, { action: 'task.set_git_branch', taskId: task.id, expectedRevision: task.revision,
      gitBranch: { repositoryPath: repo.path, branch: last } });
    await page.waitFor(`[...document.querySelectorAll('.wb-git-branch-value')].some((n) => n.textContent === ${JSON.stringify(last)})`, 'the linked branch in the detail');

    step = 'a typed name that is not in the list saves with Enter';
    await openDialog('更改 Git 分支');
    await page.waitFor(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length === 151`, 'the branches again');
    await page.evaluate(`(${BRANCH}.focus(), ${BRANCH}.select(), true)`);
    await page.send('Input.insertText', { text: 'feature/not-yet-created' });
    assert.equal(await popupOpen(), false, 'no row matches: no list');
    await press(page, 'Enter');
    await page.waitFor(`window.__posts.length === 2 && !${DIALOG}`, 'the typed name saved by Enter');
    assert.deepEqual((await page.evaluate<any[]>(`window.__posts`))[1].gitBranch, { repositoryPath: repo.path, branch: 'feature/not-yet-created' });

    step = 'the second Esc closes the dialog; the list leaves nothing behind';
    await openDialog('更改 Git 分支');
    await page.waitFor(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length === 151`, 'the branches again');
    await page.evaluate(`(${BRANCH}.focus(), true)`);
    await press(page, 'ArrowDown', 3);
    assert.equal(await popupOpen(), true);
    const composing = await page.evaluate(`(() => { const before = ${BRANCH}.value;
      ${BRANCH}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      return { same: ${BRANCH}.value === before, open: !${POPUP(BRANCH)}.hidden }; })()`);
    assert.deepEqual(composing, { same: true, open: true }, 'Enter that ends an IME composition takes no row');
    await press(page, 'Escape');
    assert.ok(await page.evaluate(`Boolean(${DIALOG})`));
    // The dialog closes while a branch load is out: its answer lands nowhere.
    await page.evaluate(`(${REPO}.dispatchEvent(new Event('change')), true)`);
    await press(page, 'Escape');
    await page.waitFor(`!${DIALOG}`, 'the second Esc to close the dialog');
    await new Promise((r) => setTimeout(r, 500));
    // The dialog leaves the page on its close event, a task after `open` drops.
    await page.waitFor(`document.querySelectorAll('.wb-combo-popup').length === 0`, 'no orphan list');

    step = 'dark theme and the 375 px phone';
    await page.evaluate(`(document.documentElement.dataset.theme = 'dark', true)`);
    await openDialog('更改 Git 分支');
    await page.waitFor(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length === 151`, 'the branches again');
    await page.click(BRANCH, 'the branch field');
    await inViewport('1280×720 dark');
    await shot('open-1280-dark');
    await page.evaluate(`(${BRANCH}.select(), true)`);
    await page.send('Input.insertText', { text: 'FIX' });
    await shot('filtered-1280-dark');

    step = 'the repository changes to one with 451 branches: the list is cut and says so';
    await page.evaluate(`(${REPO}.value = ${JSON.stringify(many.path)}, ${REPO}.dispatchEvent(new Event('input')), true)`);
    assert.equal(await branchOptions(), 0, 'the old repository’s branches are gone at once');
    assert.equal(await popupOpen(), false, 'and their list closed');
    await page.evaluate(`(${REPO}.dispatchEvent(new Event('change')), true)`);
    await page.waitFor(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length === 200`, 'the first 200 of 451');
    await page.evaluate(`(${BRANCH}.value = '', ${BRANCH}.focus(), true)`);
    await press(page, 'ArrowDown');
    assert.equal(await page.evaluate(`${POPUP(BRANCH)}.querySelector('[role="status"]').textContent`), '451 个分支，显示前 200 个，输入可筛选');
    await inViewport('451 branches');
    await shot('truncated-1280-dark');
    // `main` sorts after the 200 drawn rows: reopened on it, it is drawn first and highlighted, and Enter keeps it.
    await press(page, 'Escape');
    await page.evaluate(`(${BRANCH}.value = 'main', true)`);
    await press(page, 'ArrowDown');
    assert.equal(await popupOpen(), true);
    assert.equal(await page.evaluate(`${activeRow}.dataset.value`), 'main', 'the current branch is the highlighted row');
    assert.equal(await page.evaluate(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length`), 200);
    await press(page, 'Enter');
    assert.equal(await page.evaluate(`${BRANCH}.value`), 'main', 'Enter keeps the current branch');
    assert.equal(await popupOpen(), false);
    await page.evaluate(`(${REPO}.value = ${JSON.stringify(repo.path)}, ${REPO}.dispatchEvent(new Event('change')), true)`);
    await page.waitFor(`${LIST(BRANCH)}.querySelectorAll('[role="option"]').length === 151`, 'the first repository again');
    await page.evaluate(`(document.documentElement.dataset.theme = 'light', true)`);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await size(375, 700);
    await page.evaluate(`(${BRANCH}.select(), document.execCommand('insertText', false, 'worker-1'), true)`);
    await page.waitFor(`!${POPUP(BRANCH)}.hidden`, 'the list at 375 px');
    await new Promise((r) => setTimeout(r, 100));
    await inViewport('375×700');
    assert.ok(await page.evaluate(`${LIST(BRANCH)}.querySelector('[role="option"]').getBoundingClientRect().height >= 44`), '44 px rows on a touch screen');
    await shot('filtered-375-light');
    await page.evaluate(`(${BRANCH}.select(), document.execCommand('delete'), true)`);
    await press(page, 'ArrowDown');
    await inViewport('375×700 all');
    await shot('open-375-light');
    await page.evaluate(`(document.documentElement.dataset.theme = 'dark', true)`);
    await shot('open-375-dark');
    await press(page, 'Escape');
    await press(page, 'Escape');
    await page.waitFor(`!${DIALOG}`, 'the dialog closed');
    assert.deepEqual(browser.problems().exceptions, []);
  } catch (error) {
    const problems = browser?.problems() ?? { console: [], exceptions: [] };
    throw new Error(`failed at "${step}": ${(error as Error).message}\nconsole: ${problems.console.join('\n')}\nexceptions: ${problems.exceptions.join('\n')}`, { cause: error });
  } finally {
    await browser?.close();
    await app.close();
  }
});
