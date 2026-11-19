// 技能与 MCP page (src/web/public/extensions.js): the pure helpers in node, then the page in a headless browser over a
// test Hub with a fixture home: the sidebar entry opens it, fixture apps show, an app's skill is installed and appears in
// the shared list, the $ list is read again, overwrite asks first, a refusal is explained, the rail works by keyboard,
// and nothing scrolls sideways at 375 px. Skipped without a browser, as browser-smoke.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { REPO_ROOT } from '../src/main.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { fixtureHome, SECRETS, skillMd, write } from './extensions-fixture.ts';
import { startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

const ext = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'extensions.js')).href);

test('extensions ui: every refusal code the Hub can send has its own plain sentence', () => {
  const sources = ['skill-install.ts', 'zip.ts', 'app-extensions.ts'].map((f) => readFileSync(join(REPO_ROOT, 'src', 'core', f), 'utf8')).join('\n');
  const codes = new Set([...sources.matchAll(/new (?:InstallRefused|ZipRefused)\('([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 30, `found the codes (${codes.size})`);
  for (const code of codes) {
    const text = ext.installErrorText({ status: 400, data: { code, error: 'english' } });
    assert.doesNotMatch(text, /^安装失败|english/, `${code} has its own sentence`);
  }
  const files = readFileSync(join(REPO_ROOT, 'docs', 'files.md'), 'utf8');
  for (const code of codes) assert.match(files, new RegExp(`\`${code}\``), `docs/files.md lists ${code}`);
  assert.equal(ext.installErrorText({ status: 500, data: { error: 'boom' } }), '安装失败：boom');
  assert.equal(ext.installErrorText({ status: 502 }), '安装失败：HTTP 502');
});

test('extensions ui: the result line, the rail and the app summary', () => {
  assert.equal(ext.installedText({ name: 'a', replaced: false }), '已安装 a。');
  assert.equal(ext.installedText({ name: 'a', replaced: true, oldRemoved: true }), '已用新版本覆盖 a。');
  assert.match(ext.installedText({ name: 'a', replaced: true, oldRemoved: false }), /旧版本里有删不掉的内容/);
  const report = {
    shared: { skills: [{ name: 'x' }, { name: 'y' }] },
    apps: [
      { app: 'claude', status: 'ok', skills: [{}], mcpServers: [{}, {}] },
      { app: 'kimi', status: 'unsupported', skills: [], mcpServers: [] },
      { app: 'newapp', status: 'not_found', skills: [], mcpServers: [] },
    ],
  };
  assert.deepEqual(ext.railItems(report).map((r: any) => [r.id, r.name, r.count, r.title]), [
    ['shared', '共享文件夹', 2, '2 个 skill'],
    ['claude', 'Claude', 3, '1 个 skill，2 个 MCP 服务器'],
    ['kimi', 'Kimi Code', null, '暂不支持'],
    ['newapp', 'newapp', 0, '0 个 skill，0 个 MCP 服务器'],
  ]);
  assert.match(ext.appSummary({ status: 'unsupported' }), /^暂不支持/);
  assert.match(ext.appSummary({ status: 'not_found' }), /^未找到/);
  assert.match(ext.appSummary({ status: 'ok' }), /^只读/);
});

test('extensions ui: an older skill-list response cannot replace the post-install list', async () => {
  const app = readFileSync(join(REPO_ROOT, 'src/web/public/app.js'), 'utf8');
  const start = app.indexOf('let skillsRequest = 0;');
  const end = app.indexOf("\n$('open-extensions')", start);
  assert.ok(start >= 0 && end > start);
  const requests: ((list: { name: string }[]) => void)[] = [];
  const context: any = { S: { skills: [], skillNames: new Set(), skillsVersion: 0 },
    api: () => new Promise((resolve) => requests.push(resolve)), render() {} };
  runInNewContext(app.slice(start, end) + '\nglobalThis.readSkills = loadSkills;', context);
  const initial = context.readSkills();
  const installed = context.readSkills();
  requests[1]([{ name: 'newly-installed' }]);
  await installed;
  requests[0]([{ name: 'old-copy' }]);
  await initial;
  assert.deepEqual([...context.S.skillNames], ['newly-installed']);
  assert.equal(context.S.skillsVersion, 1, 'only the current response updates message rendering');
});

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;

test('extensions ui in the page: open from the sidebar, install an app skill, overwrite after confirming, refusals, keyboard, 375 px', { skip, timeout: 120_000 }, async () => {
  const { home, shared } = fixtureHome(realpathSync(tempDir()));
  write(join(home, '.claude', 'skills', 'late-collision', 'SKILL.md'), skillMd('late-collision', 'the app version'));
  const hub = await startTestHub({ skillsDir: shared, appHome: home });
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.navigate(`${hub.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(`document.getElementById('open-extensions')`, 'the sidebar entry');
    // Count the $ list reads from here on.
    await page.evaluate(`window.__skillReads = 0; { const f = window.fetch; window.fetch = (u, i) => { if (String(u) === '/api/skills') window.__skillReads++; return f(u, i); }; } true`);
    await page.click(`document.getElementById('open-extensions')`, 'the sidebar entry');
    const tab = (name: string) => `[...document.querySelectorAll('.extensions-dialog [role=tab]')].find((t) => t.querySelector('.ext-tab-name')?.textContent === ${JSON.stringify(name)})`;
    await page.waitFor(tab('Claude'), 'the app rail');
    const names = await page.evaluate<string[]>(`[...document.querySelectorAll('.extensions-dialog [role=tab] .ext-tab-name')].map((n) => n.textContent)`);
    assert.deepEqual(names, ['共享文件夹', 'Claude', 'ChatGPT / Codex', 'DeepSeek Harness', 'Kimi Code', 'ZCode', 'Antigravity', 'Qoder', 'WorkBuddy', 'Cursor']);
    assert.equal(await page.evaluate(`${tab('共享文件夹')}.getAttribute('aria-selected')`), 'true');
    const text = await page.evaluate<string>(`document.querySelector('.extensions-dialog').textContent`);
    for (const s of SECRETS) assert.ok(!text.includes(s), s);

    // An app: its skills with install buttons, MCP servers reduced, the note about credentials.
    await page.click(tab('Claude'), 'the Claude tab');
    const row = (name: string) => `[...document.querySelectorAll('#ext-panel .ext-row')].find((r) => r.querySelector('.ext-name')?.textContent === ${JSON.stringify(name)})`;
    await page.waitFor(row('alpha'), 'the alpha row');
    assert.match(await page.evaluate<string>(`${row('remote')}.textContent`), /HTTP.*https:\/\/api\.example\.com:8443/);
    assert.match(await page.evaluate<string>(`document.getElementById('ext-panel').textContent`), /密钥从不读出/);
    assert.match(await page.evaluate<string>(`${row('already')}.textContent`), /已在共享文件夹/);
    await page.click(`${row('alpha')}.querySelector('button')`, 'install alpha');
    await page.waitFor(`document.querySelector('#ext-panel .ext-result.ok')?.textContent === '已安装 alpha。'`, 'the install result');
    await page.waitFor(`window.__skillReads >= 1`, 'the $ list to be read again');
    assert.equal(await page.evaluate(`document.activeElement?.classList.contains('ext-result')`), true, 'focus goes to the result');
    assert.match(await page.evaluate<string>(`${row('alpha')}.textContent`), /已在共享文件夹/);

    // Overwrite asks first; cancel changes nothing, confirm replaces.
    await page.click(`${row('already')}.querySelector('button')`, 'overwrite already');
    await page.waitFor(`document.querySelector('dialog.ask[open]')`, 'the confirmation');
    await page.evaluate(`[...document.querySelectorAll('dialog.ask[open] button')].find((b) => b.textContent === '取消').click(); true`);
    await page.waitFor(`!document.querySelector('dialog.ask[open]')`, 'the confirmation to close');
    assert.equal(readFileSync(join(shared, 'already', 'SKILL.md'), 'utf8').includes('in the shared folder'), true);
    await page.click(`${row('already')}.querySelector('button')`, 'overwrite already');
    await page.waitFor(`document.querySelector('dialog.ask[open]')`, 'the confirmation');
    await page.evaluate(`[...document.querySelectorAll('dialog.ask[open] button')].find((b) => b.textContent === '覆盖').click(); true`);
    await page.waitFor(`document.querySelector('#ext-panel .ext-result.ok')?.textContent === '已用新版本覆盖 already。'`, 'the overwrite result');
    assert.match(readFileSync(join(shared, 'already', 'SKILL.md'), 'utf8'), /same name as a shared one/);

    // The row was read before another program installed this name. Confirming the conflict must send overwrite=true.
    write(join(shared, 'late-collision', 'SKILL.md'), skillMd('late-collision', 'installed after the list was read'));
    await page.evaluate(`window.__failSkillsRefresh = true; {
      const fetchBeforeFailure = window.fetch;
      window.fetch = (u, i) => String(u) === '/api/skills' && window.__failSkillsRefresh
        ? Promise.reject(new Error('skill-list refresh unavailable')) : fetchBeforeFailure(u, i);
    } true`);
    await page.click(`${row('late-collision')}.querySelector('button')`, 'install the name that appeared meanwhile');
    await page.waitFor(`document.querySelector('dialog.ask[open]')`, 'the newly detected overwrite confirmation');
    await page.evaluate(`[...document.querySelectorAll('dialog.ask[open] button')].find((b) => b.textContent === '覆盖').click(); true`);
    await page.waitFor(`document.querySelector('#ext-panel .ext-result.ok')?.textContent === '已用新版本覆盖 late-collision。'`, 'the committed install stays successful');
    await page.waitFor(`document.getElementById('ext-panel').textContent.includes('skill 已安装，但输入框的 $ 列表刷新失败。')`, 'the separate refresh warning');
    assert.match(readFileSync(join(shared, 'late-collision', 'SKILL.md'), 'utf8'), /the app version/);
    await page.evaluate('window.__failSkillsRefresh = false; true');
    await page.click(`[...document.querySelectorAll('#ext-panel button')].find((b) => b.textContent === '重试刷新')`, 'retry only the skill-list refresh');
    await page.waitFor(`!document.getElementById('ext-panel').textContent.includes('skill 已安装，但输入框的 $ 列表刷新失败。')`, 'the refresh warning to clear');
    assert.equal(await page.evaluate(`document.querySelector('#ext-panel .ext-result.ok')?.textContent`), '已用新版本覆盖 late-collision。');

    // The shared view lists it; a refused folder path is explained.
    await page.click(tab('共享文件夹'), 'the shared tab');
    await page.waitFor(row('alpha'), 'alpha in the shared list');
    await page.click(`[...document.querySelectorAll('#ext-panel button')].find((b) => b.textContent === '从文件夹安装…')`, 'from a folder');
    await page.type(`document.getElementById('ext-path')`, 'relative\\folder', 'the path input');
    await page.click(`[...document.querySelectorAll('#ext-path-form button')].find((b) => b.textContent === '安装')`, 'install');
    await page.waitFor(`document.querySelector('#ext-panel .ext-result.form-error')?.textContent.includes('以盘符开头')`, 'the refusal');
    assert.equal(await page.evaluate(`document.getElementById('ext-path').value`), 'relative\\folder', 'the typed path stays for a correction');

    // Keyboard: arrows move along the rail and show the place.
    await page.evaluate(`${tab('共享文件夹')}.focus(); true`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await page.waitFor(`document.activeElement === ${tab('Claude')} && ${tab('Claude')}.getAttribute('aria-selected') === 'true'`, 'ArrowDown to select Claude');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await page.waitFor(`${tab('Cursor')}.getAttribute('aria-selected') === 'true'`, 'End to select the last app');
    await page.click(tab('Kimi Code'), 'Kimi');
    await page.waitFor(`document.getElementById('ext-panel').textContent.includes('暂不支持')`, 'the unsupported note');

    // 375 px: neither the page nor the panel scrolls sideways.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await page.click(tab('Claude'), 'Claude at 375');
    await page.waitFor(row('alpha'), 'the alpha row at 375');
    const o = await page.evaluate<{ page: number; pane: number; rail: number }>(`(() => {
      const pane = document.querySelector('.extensions-dialog .settings-panels');
      return { page: document.documentElement.scrollWidth - innerWidth, pane: pane.scrollWidth - pane.clientWidth,
        rail: document.querySelector('.extensions-dialog').getBoundingClientRect().right - innerWidth };
    })()`);
    assert.ok(o.page <= 0 && o.pane <= 0 && o.rail <= 0, `no sideways scroll at 375 px: ${JSON.stringify(o)}`);
    // The invalid folder and the newly detected name collision are the expected HTTP failures.
    const problems = browser.problems();
    assert.deepEqual(problems.exceptions, []);
    assert.deepEqual(problems.console.filter((l) => !/status of (?:400|409) .*\/api\/extensions\/skills\/install/.test(l)), []);
  } finally {
    await browser?.close();
    await hub.close();
  }
});
