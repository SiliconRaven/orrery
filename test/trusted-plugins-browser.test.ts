// Full-trust plugins in the real page (headless, test/browser.ts; docs/external-plugins.md「完全信任的插件」「网页模块」).
// The page imports only the page modules the Hub lists; the example's notes button in the three themes at 1440 and
// 375 px; the settings cards (confirm, revoke, a load error); and real Hub child processes restarted on the same port:
// an ordinary restart behaves as always, while a revoke, a switch-off or safe mode detaches the plugin at once in every
// slot (its callbacks are counted and never called again, its dispose runs once, its elements are gone, cached message
// elements included) without reloading the page or touching unsent text and an open form, and a notice says so; also
// when the Hub restarts while the page is still loading. Screenshots go to .tmp/trusted-plugin-shots. Its own free port,
// temporary home and Hub processes; the browser comes from the shared profile slots (test/browser-slots.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPluginsFile, writePluginsFile } from '../src/config.ts';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { findBrowser, launchBrowser, type Browser } from './browser.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { freePort, insertMessageWithEvent, startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';

/**
 * The same Hub (port, home, database) as startTestHub gave, as its own process: the page tells a restarted Hub by its
 * process id, which an in-process test Hub shares with the test. Stopped through its own /api/shutdown.
 */
async function spawnHub(dir: string, port: number, env: Record<string, string> = {}): Promise<{ stop(): Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
    env: { ...process.env, ORRERY_PORT: String(port), ORRERY_HOME: join(dir, 'home'), ORRERY_DB: join(dir, 'test.db'),
      ORRERY_SKILLS_DIR: join(dir, 'skills'), KIMI_CODE_HOME: join(dir, 'kimi'), ORRERY_MOCK: '1', ORRERY_API_TOKEN: TEST_TOKEN, ORRERY_SAFE_MODE: '', ...env } });
  let out = '';
  child.stdout!.on('data', (c) => { out += c; });
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  try {
    await waitFor(() => out.includes('listening on'), 'the Hub process to start', 20_000);
  } catch (error) {
    child.kill();   // this child only: it must not keep the test's port
    throw error;
  }
  return { async stop() {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    await Promise.race([exited, sleep(20_000)]);
    if (child.exitCode === null) child.kill();
  } };
}

const found = findBrowser();
const skip = found.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? `no supported browser: ${found.reason}` : false;
const SHOTS = join(REPO_ROOT, '.tmp', 'trusted-plugin-shots');

/** Every test page module notes its import here first (the page's own record of what ran in it). */
const MARK = 'globalThis.__imported = [...(globalThis.__imported ?? []), decodeURIComponent(new URL(import.meta.url).pathname.split(\'/\')[2])];\n';

/**
 * A page module with all four slots that counts every call of each callback in globalThis.__probe[<id>] and renders
 * hidden elements; three cleanup functions: one counts, one throws, one never settles.
 */
const PROBE = `${MARK}const id = decodeURIComponent(new URL(import.meta.url).pathname.split('/')[2]);
const c = ((globalThis.__probe ??= {})[id] ??= { calls: {}, disposed: 0 });
const count = (name) => { c.calls[name] = (c.calls[name] ?? 0) + 1; };
export function register({ ui, onDispose }) {
  const { h } = ui;
  (globalThis.__probeUi ??= {})[id] = ui;   // the test opens this plugin's dialogs through its own host
  // A form of this plugin with one field: its input and submit callbacks are counted like the slots.
  (globalThis.__probeForm ??= {})[id] = () => ui.formDialog('探针表单', [
    h('label', {}, '探针字段', h('input', { 'data-probe-input': id, value: id === 'probe-a' ? '未编辑的初始值' : '', oninput: () => count('input') })),
    h('label', {}, '探针选择', h('select', { 'data-probe-choice': id }, h('option', { value: 'first' }, '原选项'), h('option', { value: 'second' }, '新选项'))),
    h('label', {}, '探针密码', h('input', { type: 'password', 'data-probe-password': id })),
    h('input', { type: 'hidden', value: '隐藏初始值' }),
  ], () => { count('submit'); });
  onDispose(() => { c.disposed++; });
  onDispose(() => { throw new Error('probe dispose fails on purpose'); });
  onDispose(() => new Promise(() => {}));
  return {
    message: {
      render() { count('render'); return h('span', { 'data-probe': id, 'data-kind': 'message', hidden: true }, id); },
      key() { count('key'); return 'k'; },
      capture() { count('capture'); return null; },
      restore() { count('restore'); },
      update() { count('update'); },
    },
    composer() { count('composer'); return h('span', { 'data-probe': id, hidden: true }); },
    settings() { count('settings'); return h('span', { 'data-probe': id, hidden: true }); },
    workbench({ beginCollectionRequest }) {
      count('workbench');
      return { id: id + '-tab', label: '探针 ' + id,
        render() { count('tab.render'); return h('div', { 'data-probe': id, 'data-probe-tab': id }, '探针 ' + id + ' 的内容'); },
        // The host's convention for a late answer: it may only be shown while current() is still true.
        load() { count('tab.load'); (globalThis.__probeLoad ??= {})[id] = beginCollectionRequest(); },
        reset() { count('tab.reset'); }, itemRow() { count('tab.itemRow'); return null; } };
    },
  };
}
`;

/**
 * Modules whose slots have the wrong shape: each would render `[data-bad]` elements if it were attached, and counts its
 * cleanup in globalThis.__bad[<id>].
 */
const BAD = (shape: string) => `${MARK}const id = decodeURIComponent(new URL(import.meta.url).pathname.split('/')[2]);
const b = ((globalThis.__bad ??= {})[id] ??= { disposed: 0 });
export function register({ ui, onDispose }) {
  onDispose(() => { b.disposed++; });
  const el = () => ui.h('span', { 'data-bad': id }, id);
  return (${shape});
}
`;
const BAD_SHAPES: Record<string, string> = {
  'bad-key': `{ message: { render: el, key: 'not a function' }, composer: el }`,
  'bad-render': `{ message: { key: () => 'k' }, composer: el }`,
  'bad-async-tab': `{ composer: el, workbench: async () => ({ id: 'bad-tab', label: '坏标签', render: el, load() {} }) }`,
  'bad-slot': `{ composer: 42 }`,
  'bad-junk': `{ composer: el, toolbar: el }`,
  'bad-promise-settings': `{ composer: el, settings: () => Promise.resolve(el()) }`,
};
/** Takes a cleanup function and opens a form, then throws in register: all of it must be rolled back. */
const HALF = `${MARK}const id = decodeURIComponent(new URL(import.meta.url).pathname.split('/')[2]);
const b = ((globalThis.__bad ??= {})[id] ??= { disposed: 0 });
export function register({ ui, onDispose }) {
  onDispose(() => { b.disposed++; });
  ui.formDialog('半截的表单', [ui.h('input', { 'data-bad': id })], () => { b.submitted = true; });
  throw new Error('register fails half way on purpose');
}
`;

/**
 * Copies of the example (one confirmed, one only registered, one with a hostApi this Hub lacks), three probes, a
 * module whose register throws, one whose slots throw, one whose import never finishes, modules of the wrong shape and
 * one that fails half way through register; two clusters with messages.
 */
function setup(): { dir: string; home: string; entryOf: (id: string) => string } {
  const dir = tempDir();
  const home = join(dir, 'home');
  mkdirSync(home);
  const store = new Store(join(dir, 'test.db'));
  for (const [cid, name] of [['c1', '便签群'], ['c2', '第二个群']]) {
    store.insertCluster({ id: cid, name, category: '', createdAt: '2026-01-01' }, [{ id: `${cid}-Alice`, clusterId: cid, name: 'Alice', avatar: '',
      harness: 'mock', model: null, effort: null, workerSessionId: `${cid}-Alice`, cwd: dir, origin: 'attached' as const, removedAt: null }]);
    for (const [i, body] of [`${name}的第一条消息`, `${name}的第二条消息`].entries()) {
      const id = `${cid}-msg-${i}`;
      insertMessageWithEvent(store, { id, clusterId: cid, from: 'user', mentions: [], body, replyTo: null, chainId: id, hop: 0,
        createdAt: new Date(Date.now() - (2 - i) * 60_000).toISOString() });
    }
  }
  store.close();
  const example = (id: string, patch: Record<string, unknown> = {}) => {
    const folder = join(dir, 'plugins', id);
    cpSync(join(REPO_ROOT, 'examples', 'hub-plugins', 'trusted-demo'), folder, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(folder, 'orrery-plugin.json'), 'utf8'));
    writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id, ...patch }));
    writeFileSync(join(folder, 'web', 'index.js'), MARK + readFileSync(join(folder, 'web', 'index.js'), 'utf8'));
    return join(folder, 'orrery-plugin.json');
  };
  const own = (id: string, name: string, web: string) => {
    const folder = join(dir, 'plugins', id);
    mkdirSync(join(folder, 'hub'), { recursive: true });
    mkdirSync(join(folder, 'web'));
    writeFileSync(join(folder, 'hub', 'index.mjs'), 'export default () => ({});\n');
    writeFileSync(join(folder, 'web', 'index.js'), web);
    writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify({ id, version: '1.0.0', name, hostApi: 1, hubEntry: 'hub/index.mjs', webEntry: 'web/index.js' }));
    return join(folder, 'orrery-plugin.json');
  };
  const manifests = [example('trusted-demo'), example('notes-two', { name: '第二个便签示例' }), example('notes-old', { name: '旧接口的便签', hostApi: 2 }),
    own('probe-a', '探针 probe-a', PROBE), own('probe-b', '探针 probe-b', PROBE), own('probe-c', '探针 probe-c', PROBE),
    own('boom', '注册就出错', `${MARK}export function register() { throw new Error('register fails on purpose'); }\n`),
    own('slot-boom', '插槽出错', `${MARK}export function register() {
  const fail = () => { throw new Error('slot fails on purpose'); };
  return { composer: fail, message: { render: fail, key: fail } };
}\n`),
    own('hang', '一直加载', `${MARK}await new Promise(() => {});\nexport function register() { return {}; }\n`),
    ...Object.entries(BAD_SHAPES).map(([id, shape]) => own(id, `坏形状 ${id}`, BAD(shape))), own('half', '注册到一半', HALF)];
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: manifests.map((manifest) => ({ manifest, trust: 'full' })) }));
  const entryOf = (id: string) => realpathSync.native(join(dir, 'plugins', id, 'hub', 'index.mjs'));
  writePluginsFile(home, { trusted: ['trusted-demo', 'probe-a', 'probe-b', 'probe-c', 'boom', 'slot-boom', 'hang', ...Object.keys(BAD_SHAPES), 'half']
    .map((id) => ({ id, entry: entryOf(id) })) });
  return { dir, home, entryOf };
}

test('browser: full-trust page modules load only when listed, and a Hub restart detaches a revoked, switched-off or safe-mode one in place', { skip, timeout: 600_000 }, async () => {
  assert.ok(found.path, 'ORRERY_REQUIRE_BROWSER=1 but no supported browser');
  const { dir, home, entryOf } = setup();
  const port = await freePort();   // fixed: the page follows a Hub restart on the same address
  const app = await startTestHub({ dir, port });
  let appOpen = true;
  let spawned = null as { stop(): Promise<void> } | null;
  let browser: Browser | null = null;
  let step = 'setup';
  const shot = async (name: string) => {
    const { data } = await browser!.page.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  try {
    browser = await launchBrowser(found.path!, { redact: [TEST_TOKEN] });
    const page = browser.page;
    // With ?holdHealth in the address, the page's first GET /api/health waits until the test releases it, and is only
    // then sent: the test restarts the Hub between the page's plugin list and its first health check. After
    // __failPlugins(n), the next n reads of GET /api/plugins answer 503 (counted in __pluginsFailed).
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const real = window.fetch.bind(window);
      let held = !new URLSearchParams(location.search).has('holdHealth');
      let failing = 0;
      window.__pluginsFailed = 0;
      window.__failPlugins = (n) => { failing = n; };
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (!held && url.startsWith('/api/health')) {
          held = true;
          await new Promise((release) => { window.__releaseHealth = release; window.__healthHeld = true; });
        }
        if (failing > 0 && url === '/api/plugins' && (init?.method ?? 'GET') === 'GET') {
          failing--;
          window.__pluginsFailed++;
          return new Response('{"error":"held by the test"}', { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return real(input, init);
      };
    })();` });
    const size = (width: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: false });
    const card = (id: string) => `document.querySelector('#plugin-list article[aria-label="${{ 'trusted-demo': '完全信任示例：群便签', 'notes-two': '第二个便签示例', 'notes-old': '旧接口的便签' }[id]}"]')`;
    const text = async (id: string) => page.evaluate<string>(`${card(id)}?.textContent ?? ''`);
    const composer = `document.getElementById('composer-input')`;
    const imported = () => page.evaluate<string[]>('[...(globalThis.__imported ?? [])].sort()');
    const total = (id: string) => page.evaluate<number>(`Object.values(globalThis.__probe?.['${id}']?.calls ?? {}).reduce((a, b) => a + b, 0)`);
    const disposed = (id: string) => page.evaluate<number>(`globalThis.__probe?.['${id}']?.disposed ?? -1`);
    const inPage = (id: string) => page.evaluate<number>(`document.querySelectorAll('[data-probe="${id}"], [data-plugin-slot="${id}"]').length`);
    const kept = () => page.evaluate<string[]>(`[...document.querySelectorAll('dialog.kept-input[open] textarea')].map((t) => t.value)`);
    const notice = () => page.evaluate<string>(`document.getElementById('trust-banner').hidden ? '' : document.getElementById('trust-banner-text').textContent`);
    /** Clicks once the element really receives pointer input (a dialog closing or a layout change can still cover it). */
    const clickable = async (expression: string, what: string) => {
      await page.waitFor(`(() => {
        const el = ${expression};
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(hit && el.contains(hit));
      })()`, `${what} ready for pointer input`);
      await page.click(expression, what);
    };
    const clusterItem = (name: string) => `[...document.querySelectorAll('#cluster-list .cluster-item')].find((b) => b.querySelector('.name')?.textContent === '${name}')`;
    const showCluster = async (name: string, cid: string) => {
      const shown = `document.getElementById('messages').textContent.includes('${name}的第二条消息')`;
      // A click during a layout change (a resize, a banner appearing) can miss: try again a few times.
      for (let attempt = 1; ; attempt++) {
        await clickable(clusterItem(name), name);
        try { await page.waitFor(shown, `${cid}'s messages`, 5000); return; } catch (error) { if (attempt === 3) throw error; }
      }
    };
    const wbButton = (label: string) => `[...document.querySelectorAll('dialog.workbench button')].find((b) => b.textContent.trim() === '${label}')`;
    const notesButton = `document.querySelector('[data-trusted-demo="open"]')`;
    /** Stops the running Hub and starts a new process on the same port; `window.beforeRestart` tells a reload. */
    const restart = async (env: Record<string, string> = {}) => {
      await page.evaluate('window.beforeRestart = true');
      if (appOpen) { await app.close(); appOpen = false; } else await spawned!.stop();
      spawned = await spawnHub(dir, port, env);
    };
    /**
     * Things that redraw messages, the composer area and the workbench, so any slot still attached is called. `control`:
     * a probe still attached, whose counter must move (the redraw happened); without one (none left) a short wait.
     */
    const provokeRedraws = async (control?: string) => {
      const before = control ? await total(control) : 0;
      await showCluster('第二个群', 'c2');   // c2's kept message elements come back
      await showCluster('便签群', 'c1');
      await page.evaluate(`window.dispatchEvent(new Event('focus'))`);
      if (control) await page.waitFor(`Object.values(globalThis.__probe['${control}'].calls).reduce((a, b) => a + b, 0) > ${before}`, `${control} redrawn`);
      else await sleep(800);
    };
    /** The example's Alt+Shift+N listener calls preventDefault: whether a cancelable key press reached it. */
    const shortcutHandled = () => page.evaluate<boolean>(`(() => {
      const e = new KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyN', bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    })()`);
    const bad = [...Object.keys(BAD_SHAPES), 'half'];
    const all = ['boom', 'hang', 'probe-a', 'probe-b', 'probe-c', 'slot-boom', 'trusted-demo', ...bad].sort();

    step = 'open the page';
    await size(1440);
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    await page.waitFor(clusterItem('便签群'), 'the cluster list', 30_000);
    await showCluster('第二个群', 'c2');
    await showCluster('便签群', 'c1');
    await page.waitFor(notesButton, 'the example\'s notes button');
    assert.deepEqual(await imported(), all, 'only the confirmed, loaded modules (not the unconfirmed or failed ones); one that never loads does not hold up the page');
    assert.equal(await page.evaluate(`document.getElementById('safe-mode-banner').hidden && document.getElementById('trust-banner').hidden`), true);
    for (const id of ['probe-a', 'probe-b', 'probe-c']) {
      assert.equal(await page.evaluate(`document.querySelectorAll('[data-probe="${id}"][data-kind="message"]').length`), 2, `${id}: on each shown message`);
      assert.equal(await page.evaluate(`Boolean(document.querySelector('#plugin-list ~ [data-probe="${id}"]'))`), true, `${id}: its settings element`);
      assert.equal(await page.evaluate(`Boolean(document.querySelector('#composer [data-probe="${id}"]'))`), true, `${id}: its composer element`);
    }
    // Wrong shapes (a string key, no render, an async workbench factory, a number for a slot, a slot that does not exist,
    // a promise from the settings slot) and a register that fails half way: nothing of them is left, each cleanup ran once.
    await page.waitFor(`${JSON.stringify(bad)}.every((id) => globalThis.__bad?.[id]?.disposed === 1)`, 'every refused module cleaned up once');
    assert.equal(await page.evaluate(`document.querySelectorAll('[data-bad]').length`), 0, 'no element of a refused module');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'the form the half registration opened is gone');
    assert.equal(await page.evaluate(`globalThis.__bad.half.submitted === undefined`), true);
    for (const area of ['composer', 'settings-dialog']) {
      assert.equal(await page.evaluate(`document.getElementById('${area}').textContent.includes('[object Promise]')`), false, `${area}: no stray text`);
    }
    assert.equal(await page.evaluate(`Object.values(globalThis.__bad).map((b) => b.disposed).join()`), bad.map(() => 1).join(), 'once, not again later');
    step = 'the example in every theme and width';
    await page.evaluate(`(() => { const c = ${composer}; c.value = ''; })()`);
    for (const width of [1440, 375]) {
      await size(width);
      for (const theme of ['light', 'dark', 'orrery']) {
        await page.evaluate(`globalThis.orreryTheme.set('${theme}')`);
        await page.waitFor(notesButton, 'the notes button');
        const fit = await page.evaluate<{ right: number; viewport: number; scroll: number }>(`(() => {
          const r = ${notesButton}.getBoundingClientRect(); return { right: r.right, viewport: innerWidth, scroll: document.documentElement.scrollWidth }; })()`);
        assert.ok(fit.right <= fit.viewport + 0.5 && fit.scroll <= fit.viewport, `${theme} ${width}: the button fits, no sideways scroll (${JSON.stringify(fit)})`);
        await shot(`example-${theme}-${width}-composer`);
        await clickable(notesButton, 'the notes button');
        await page.waitFor(`document.querySelector('dialog[open] [data-trusted-demo="input"]')`, 'the notes dialog');
        if (width === 1440 && theme === 'light') {
          await page.type(`document.querySelector('dialog[open] [data-trusted-demo="input"]')`, '第一条便签', 'a note');
          await page.click(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === '添加')`, 'add');
          await page.waitFor(`!document.querySelector('dialog[open] [data-trusted-demo="input"]')`, 'saved');
          await clickable(notesButton, 'the notes button again');
          await page.waitFor(`document.querySelector('dialog[open] [data-trusted-demo="list"]')?.textContent.includes('用户：第一条便签')`, 'the saved note');
        }
        const dialog = await page.evaluate<{ left: number; right: number; viewport: number }>(`(() => {
          const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth }; })()`);
        assert.ok(dialog.left >= 0 && dialog.right <= dialog.viewport + 0.5, `${theme} ${width}: the dialog fits`);
        await shot(`example-${theme}-${width}-dialog`);
        await page.evaluate(`document.querySelector('dialog[open]').close()`);
        await page.waitFor(`!document.querySelector('dialog[open]')`, 'closed');
      }
    }
    await size(1440);
    await page.evaluate(`globalThis.orreryTheme.set('orrery')`);
    const problems = browser.problems();
    assert.deepEqual(problems.exceptions, [], 'no uncaught exception: a module that throws in register or a slot does not break the page');
    assert.deepEqual(problems.console, [], 'no console error');

    step = '(a) an ordinary restart changes nothing about the plugins';
    await page.evaluate(`(() => { const c = ${composer}; c.value = '还没发出的话'; c.dispatchEvent(new Event('input')); })()`);
    const beforeOrdinary = await total('probe-a');
    await restart();
    await page.waitFor(`document.getElementById('update-banner').hidden === false`, 'the usual banner', 45_000);
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload of its own');
    assert.equal(await notice(), '', 'no plugin notice');
    assert.equal(await page.evaluate(`${composer}.value`), '还没发出的话');
    await provokeRedraws();
    assert.ok(await total('probe-a') > beforeOrdinary, 'the plugins stay attached');
    assert.ok(await inPage('trusted-demo') > 0);
    assert.deepEqual(await imported(), all, 'nothing imported again');

    step = 'a fresh load from the new Hub, then the cards';
    await page.evaluate(`(() => { const c = ${composer}; c.value = ''; c.dispatchEvent(new Event('input')); })()`);
    await page.navigate(`http://127.0.0.1:${port}/?fresh=1#token=${TEST_TOKEN}`);
    await page.waitFor(clusterItem('便签群'), 'the cluster list', 30_000);
    await showCluster('第二个群', 'c2');
    await showCluster('便签群', 'c1');
    await page.waitFor(notesButton, 'the notes button');
    await clickable(`document.getElementById('open-settings')`, 'settings');
    await clickable(`document.getElementById('settings-tab-plugins')`, 'the plugins tab');
    await page.waitFor(`${card('trusted-demo')} && ${card('notes-two')} && ${card('notes-old')}`, 'the three cards');
    for (const id of ['trusted-demo', 'notes-two', 'notes-old']) {
      assert.equal(await page.evaluate(`${card(id)}.querySelector('[data-full-trust]')?.textContent`), '完全信任', `${id}: the mark`);
      assert.equal(await page.evaluate(`${card(id)}.querySelector('.plugin-icon img')?.getAttribute('src')`), `/api/plugins/${id}/icon`, `${id}: its icon`);
      await page.waitFor(`${card(id)}.querySelector('.plugin-icon img')?.naturalWidth > 0`, `${id}: the icon loaded`);
    }
    assert.match(await text('trusted-demo'), /已启用/);
    assert.match(await text('notes-two'), /未确认信任，没有运行/);
    assert.match(await text('notes-old'), /启动时被跳过.*跳过的原因：.*hostApi 2 is not supported/);
    assert.equal(await page.evaluate(`Boolean(${card('notes-old')}.querySelector('[data-plugin-trust]'))`), false, 'nothing to confirm on a broken registration');

    step = 'the confirm dialog';
    const confirmButton = `${card('notes-two')}.querySelector('[data-plugin-trust="confirm"]')`;
    await clickable(confirmButton, 'confirm');
    await page.waitFor(`document.querySelector('dialog.ask[open]')`, 'the dialog');
    const message = await page.evaluate<string>(`document.querySelector('dialog.ask[open]').textContent`);
    assert.match(message, /完全信任“第二个便签示例”？/);
    assert.match(message, /和 orrery 本身拥有相同的权限/);
    assert.match(message, /它的网页模块（如果有）和 orrery 的页面在同一页里运行/);
    assert.ok(message.includes(entryOf('notes-two')), 'the entry path it binds to');
    await shot('confirm-dialog-1440');
    await page.click(`document.querySelector('dialog.ask[open] button[value="cancel"]')`, 'cancel');
    await page.waitFor(`!document.querySelector('dialog.ask[open]')`, 'closed');
    assert.equal(readPluginsFile(home).trusted!.some((t) => t.id === 'notes-two'), false, 'cancel changes nothing');
    await clickable(confirmButton, 'confirm again');
    await page.waitFor(`document.querySelector('dialog.ask[open]')`, 'the dialog');
    await page.click(`document.querySelector('dialog.ask[open] button[value="confirm"]')`, 'confirm in the dialog');
    await page.waitFor(`${card('notes-two')}?.textContent.includes('重启 Hub 后生效：将加载')`, 'the pending state');
    assert.deepEqual(readPluginsFile(home).trusted!.find((t) => t.id === 'notes-two'), { id: 'notes-two', entry: entryOf('notes-two') });

    step = 'revoke on the card';
    await clickable(`${card('trusted-demo')}.querySelector('[data-plugin-trust="revoke"]')`, 'revoke');
    await page.waitFor(`${card('trusted-demo')}?.textContent.includes('重启 Hub 后生效：将不再加载')`, 'the revoke pending state');
    assert.equal(readPluginsFile(home).trusted!.some((t) => t.id === 'trusted-demo'), false);
    assert.match(await text('trusted-demo'), /确认、撤销和启用开关都在重启 Hub 后生效/);
    assert.ok(await inPage('trusted-demo') > 0, 'still running until the restart');

    step = 'the cards in every theme and width';
    for (const width of [1440, 375]) {
      await size(width);
      for (const theme of ['light', 'dark', 'orrery']) {
        await page.evaluate(`globalThis.orreryTheme.set('${theme}')`);
        await page.evaluate(`${card('notes-two')}.scrollIntoView({ block: 'start' })`);
        const fit = await page.evaluate<{ right: number; viewport: number; scroll: number }>(`(() => {
          const r = ${card('trusted-demo')}.getBoundingClientRect();
          return { right: Math.max(r.right, ${card('notes-old')}.getBoundingClientRect().right), viewport: innerWidth, scroll: document.documentElement.scrollWidth };
        })()`);
        assert.ok(fit.right <= fit.viewport + 0.5, `${theme} ${width}: the cards fit (${JSON.stringify(fit)})`);
        assert.ok(fit.scroll <= fit.viewport, `${theme} ${width}: no sideways scroll`);
        await shot(`${theme}-${width}-cards`);
        await page.evaluate(`${card('notes-old')}.scrollIntoView({ block: 'start' })`);
        await shot(`${theme}-${width}-error`);
      }
    }
    await size(1440);
    await page.evaluate(`globalThis.orreryTheme.set('orrery')`);
    await page.evaluate(`document.getElementById('settings-dialog').close()`);

    step = 'before revoking: unsent text, the workbench on a plugin tab, the example\'s own dialog';
    writePluginsFile(home, { trusted: readPluginsFile(home).trusted!.filter((t) => t.id !== 'probe-a') });   // revoke probe-a too
    await page.evaluate(`(() => { const c = ${composer}; c.value = '还没发出的话'; c.dispatchEvent(new Event('input')); })()`);
    await clickable(`document.getElementById('open-workbench')`, 'the workbench');
    await clickable(wbButton('资料库'), 'the collections view');
    await clickable(wbButton('探针 probe-a'), 'probe-a\'s tab');
    await page.waitFor(`document.querySelector('[data-probe-tab="probe-a"]')`, 'probe-a\'s tab content');
    assert.equal(await shortcutHandled(), true, 'the example\'s shortcut listener is there');
    await page.waitFor(`document.querySelector('dialog[open] [data-trusted-demo="input"]')`, 'the example\'s dialog from its shortcut');
    await page.type(`document.querySelector('dialog[open] [data-trusted-demo="input"]')`, '没保存的便签', 'type into the example form');
    await page.evaluate(`globalThis.__probeForm['probe-a'](); true`);   // a form of probe-a with nothing typed into it
    // probe-a's own notice dialog open, and a confirm of it waiting in the page's shared dialog queue behind it.
    await page.evaluate(`globalThis.__probeUi['probe-a'].noticeDialog('探针的提示'); globalThis.__probeUi['probe-a'].confirmDialog({ message: '排队的确认' }); true`);
    await page.waitFor(`document.querySelector('dialog.ask[open]')?.textContent.includes('探针的提示')`, 'probe-a\'s notice dialog');
    assert.equal(await disposed('probe-a'), 0);

    step = '(b) revoked: detached in every slot, no reload';
    await restart();
    await page.waitFor(`document.getElementById('trust-banner').hidden === false`, 'the plugin notice', 45_000);
    const afterRevoke = await total('probe-a');
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload of its own');
    assert.equal(await page.evaluate(`${composer}.value`), '还没发出的话', 'the unsent text is intact');
    const said = await notice();
    assert.match(said, /Hub 重启后不再加载完全信任插件(“完全信任示例：群便签”、“探针 probe-a”|“探针 probe-a”、“完全信任示例：群便签”)/);
    assert.match(said, /页面已移除它们经插件接口加入的内容，不再调用它们；它们的代码还留在这个页面里，刷新页面后彻底生效。/);
    assert.match(said, /完全信任插件“第二个便签示例”现在可以加载，刷新页面后加载。/);
    assert.equal(await page.evaluate(`document.getElementById('update-banner').hidden`), false, 'the usual banner as well (a restart with unsaved input)');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('dialog.ask'))`), false, 'probe-a\'s open notice is closed and its queued confirm never opened');
    assert.equal(await inPage('probe-a'), 0, 'probe-a: nothing of it left (composer, settings, messages, its workbench tab content)');
    assert.equal(await inPage('trusted-demo'), 0, 'the notes button and the dialog it opened are gone');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-trusted-demo]'))`), false);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('dialog[open] button')].some((button) => button.textContent === '添加')`),
      false, 'the kept note has no plugin submit button');
    assert.equal(await page.evaluate(`document.querySelector('dialog.workbench').open`), true, 'the workbench stays open');
    assert.equal(await page.evaluate(`Boolean(${wbButton('探针 probe-a')})`), false, 'its tab button is gone');
    assert.equal(await page.evaluate(`${wbButton('任务公共资料')}?.getAttribute('aria-pressed')`), 'true', 'the public materials instead');
    assert.equal(await page.evaluate(`Boolean(${wbButton('探针 probe-b')})`), true, 'the other plugins\' tabs stay');
    assert.equal(await page.evaluate(`Boolean(${wbButton('坏标签')})`), false, 'no tab of the refused async factory');
    assert.equal(await page.evaluate(`globalThis.__probeLoad['probe-a']()`), false, 'a late answer to the removed tab\'s load is no longer current');
    // The host keeps the example's typed text; probe-a's untouched initial value is not a draft.
    assert.deepEqual(await kept(), ['新便签：\n没保存的便签'], 'one notice, with the typed text and its label');
    assert.equal(await page.evaluate(`document.querySelector('dialog.kept-input textarea').readOnly`), true);
    assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-probe-input="probe-a"]'))`), false);
    assert.equal(await disposed('probe-a'), 1, 'its dispose ran once');
    assert.equal(await disposed('probe-b'), 0);
    await page.evaluate(`document.querySelector('dialog.workbench').close()`);
    for (const theme of ['light', 'dark', 'orrery']) {
      await page.evaluate(`globalThis.orreryTheme.set('${theme}')`);
      await shot(`kept-input-${theme}-1440`);
    }
    await shot('notice-orrery-1440');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(`globalThis.orreryTheme.set('${theme}')`);
      await shot(`notice-${theme}-1440`);
    }
    await size(375);
    await sleep(600);   // the narrow layout's sidebar slides away
    for (const theme of ['light', 'dark', 'orrery']) {
      await page.evaluate(`globalThis.orreryTheme.set('${theme}')`);
      const fit = await page.evaluate<{ right: number; viewport: number }>(`(() => {
        const r = document.getElementById('trust-banner').getBoundingClientRect(); return { right: r.right, viewport: innerWidth }; })()`);
      assert.ok(fit.right <= fit.viewport + 0.5, `${theme} 375: the notice fits`);
      assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('trust-reload')).whiteSpace`), 'nowrap', 'the button keeps one line');
      await shot(`notice-${theme}-375`);
      const fitKept = await page.evaluate<{ left: number; right: number; viewport: number }>(`(() => {
        const r = document.querySelector('dialog.kept-input').getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth }; })()`);
      assert.ok(fitKept.left >= 0 && fitKept.right <= fitKept.viewport + 0.5, `${theme} 375: the kept-input notice fits`);
      await shot(`kept-input-${theme}-375`);
    }
    await size(1440);
    await sleep(600);
    await page.evaluate(`globalThis.orreryTheme.set('orrery')`);
    await provokeRedraws('probe-b');   // the other plugins are still called
    assert.equal(await shortcutHandled(), false, 'the example removed its own shortcut listener in onDispose');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('dialog[open]:not(.kept-input)'))`), false);
    assert.equal(await total('probe-a'), afterRevoke, 'no callback of probe-a was called again (key, capture, restore, update, render, tab hooks)');
    assert.equal(await inPage('probe-a'), 0, 'kept message elements came back without it');
    // The page's own reload question opens at once: nothing of probe-a is left in the shared dialog queue.
    await clickable(`document.getElementById('trust-reload')`, 'reload');
    await page.waitFor(`document.querySelector('dialog.ask[open]')?.textContent.includes('未发送的草稿')`, 'the page\'s reload question');
    await page.click(`document.querySelector('dialog.ask[open] button[value="cancel"]')`, 'keep the page');
    await page.waitFor(`!document.querySelector('dialog.ask')`, 'closed, and no queued dialog of probe-a after it');
    // The kept text: selectable and copyable; closing it is the user's action.
    await clickable(`[...document.querySelectorAll('dialog.kept-input button')].find((b) => b.textContent === '复制')`, 'copy');
    await page.waitFor(`[...document.querySelectorAll('dialog.kept-input button')].some((b) => b.textContent === '已复制')`, 'copied');
    assert.equal(await page.evaluate(`(() => { const t = document.querySelector('dialog.kept-input textarea'); return t.value.slice(t.selectionStart, t.selectionEnd); })()`),
      '新便签：\n没保存的便签', 'the whole text is selected');
    await clickable(`[...document.querySelectorAll('dialog.kept-input button')].find((b) => b.textContent === '关闭')`, 'close');
    await page.waitFor(`!document.querySelector('dialog.kept-input')`, 'the kept text closed by the user');
    assert.equal(await page.evaluate(`document.querySelectorAll('[data-probe="probe-b"][data-kind="message"]').length`), 2);
    assert.equal(await disposed('probe-a'), 1, 'still once');
    assert.equal(await page.evaluate(`${composer}.value`), '还没发出的话');

    step = '(c) switched off, with an open form';
    writePluginsFile(home, { disabled: ['probe-b'] });
    await clickable(`document.getElementById('new-cluster')`, 'new cluster');
    await page.waitFor(`document.getElementById('create-dialog').open`, 'the create dialog');
    await page.evaluate(`(() => { const i = document.getElementById('create-name'); i.value = '正在填写的群名'; i.dispatchEvent(new Event('input')); })()`);
    await page.evaluate(`globalThis.__probeForm['probe-b'](); true`);
    await page.type(`document.querySelector('[data-probe-input="probe-b"]')`, '探针里没提交的字', 'type into probe-b\'s form');
    const choice = `document.querySelector('[data-probe-choice="probe-b"]')`;
    await page.evaluate(`${choice}.focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    assert.equal(await page.evaluate(`${choice}.value`), 'second', 'the browser selected a different option');
    const password = `document.querySelector('[data-probe-password="probe-b"]')`;
    await page.type(password, 'synthetic-probe-password', 'type a test password');
    assert.equal(await page.evaluate(`${password}.value`), 'synthetic-probe-password', 'the password field received the test text');
    assert.ok((await page.evaluate<number>(`globalThis.__probe['probe-b'].calls.input`)) > 0, 'its input callback ran while it was attached');
    await page.evaluate(`window.__probeBForm = document.querySelector('[data-probe-input="probe-b"]').closest('form')`);
    await restart();
    await page.waitFor(`document.getElementById('trust-banner').textContent.includes('探针 probe-b')`, 'probe-b in the notice', 45_000);
    assert.deepEqual(await kept(), ['探针字段：\n探针里没提交的字\n\n探针选择：\n新选项'], 'kept text contains the option label and omits password and hidden fields');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-probe-input="probe-b"]'))`), false, 'its form is gone: nothing can submit to it');
    await page.evaluate(`window.__probeBForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`);
    assert.equal(await page.evaluate(`globalThis.__probe['probe-b'].calls.submit`), undefined, 'even a retained reference cannot invoke the old callback');
    const afterOff = await total('probe-b');
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload of its own');
    assert.equal(await page.evaluate(`document.getElementById('create-dialog').open && document.getElementById('create-name').value`), '正在填写的群名', 'the open form keeps its input');
    assert.equal(await page.evaluate(`${composer}.value`), '还没发出的话');
    assert.equal(await inPage('probe-b'), 0);
    assert.equal(await disposed('probe-b'), 1);
    await page.evaluate(`document.getElementById('create-dialog').close()`);
    await provokeRedraws('probe-c');
    assert.equal(await total('probe-b'), afterOff, 'probe-b is not called again (its submit and input callbacks included)');
    assert.match(await notice(), /刷新页面后彻底生效/);
    // With only the kept text left unsaved, the reload button still asks first.
    await page.evaluate(`(() => { const c = ${composer}; c.value = ''; c.dispatchEvent(new Event('input')); })()`);
    await clickable(`document.getElementById('trust-reload')`, 'reload');
    await page.waitFor(`document.querySelector('dialog.ask[open]')?.textContent.includes('未发送的草稿')`, 'the question, because of the kept text');
    await page.click(`document.querySelector('dialog.ask[open] button[value="cancel"]')`, 'keep the page');
    await page.waitFor(`!document.querySelector('dialog.ask')`, 'closed');
    assert.equal(await page.evaluate('window.beforeRestart === true'), true);
    await clickable(`[...document.querySelectorAll('dialog.kept-input button')].find((b) => b.textContent === '关闭')`, 'close the kept text');
    await page.waitFor(`!document.querySelector('dialog.kept-input')`, 'closed');
    await page.evaluate(`(() => { const c = ${composer}; c.value = '还没发出的话'; c.dispatchEvent(new Event('input')); })()`);

    step = '(c1) an ordinary restart while the notice shows: the usual banner, still no reload';
    await page.evaluate(`(() => { const c = ${composer}; c.value = ''; c.dispatchEvent(new Event('input')); document.getElementById('update-banner').hidden = true; })()`);
    await restart();   // nothing unsaved: before the notice this restart would have reloaded the page
    await page.waitFor(`document.getElementById('update-banner').hidden === false`, 'the usual banner', 45_000);
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload while the notice shows');
    assert.match(await notice(), /刷新页面后彻底生效/, 'the notice stays');
    await page.evaluate(`(() => { const c = ${composer}; c.value = '还没发出的话'; c.dispatchEvent(new Event('input')); })()`);

    step = '(c2) listed again without a reload: it stays detached';
    writePluginsFile(home, { disabled: [] });
    await restart();
    await page.waitFor(`document.getElementById('trust-banner').textContent.includes('“探针 probe-b”现在可以加载')
      || document.getElementById('trust-banner').textContent.includes('、“探针 probe-b”现在可以加载')`, 'probe-b offered for a reload', 45_000);
    assert.match(await notice(), /完全信任插件“第二个便签示例”、“探针 probe-b”现在可以加载，刷新页面后加载。|“探针 probe-b”、“第二个便签示例”现在可以加载/);
    await provokeRedraws('probe-c');
    assert.equal(await total('probe-b'), afterOff, 'not attached again');
    assert.equal(await inPage('probe-b'), 0);
    assert.equal(await disposed('probe-b'), 1);
    assert.deepEqual(await imported(), all, 'nothing imported again');

    step = '(d) safe mode';
    const beforeSafe = await total('probe-c');
    assert.ok(beforeSafe > 0);
    await restart({ ORRERY_SAFE_MODE: '1' });
    await page.waitFor(`document.getElementById('trust-banner').textContent.includes('探针 probe-c')`, 'probe-c in the notice', 45_000);
    const afterSafe = await total('probe-c');
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload of its own');
    assert.equal(await inPage('probe-c'), 0);
    assert.equal(await disposed('probe-c'), 1, 'once, although another of its cleanups throws and one never settles');
    assert.ok((await notice()).includes('“插槽出错”'), 'slot-boom registered its slots: named');
    // boom (register threw) and hang (never finished importing) never ran through the host here: not named.
    assert.doesNotMatch(await notice(), /注册就出错|一直加载/);
    assert.doesNotMatch(await notice(), /现在可以加载/, 'safe mode lists nothing to load');
    await provokeRedraws();   // no probe left attached to prove the redraw: a short wait instead
    assert.equal(await total('probe-c'), afterSafe);
    assert.equal(await page.evaluate(`${composer}.value`), '还没发出的话');
    assert.deepEqual(browser.problems().exceptions, [], 'no uncaught exception after the restarts');

    step = 'the reload button: asks because of the unsent text, then nothing revoked is imported';
    await clickable(`document.getElementById('trust-reload')`, 'reload');
    await page.waitFor(`document.querySelector('dialog.ask[open]')?.textContent.includes('未发送的草稿')`, 'the question');
    await page.click(`document.querySelector('dialog.ask[open] button[value="confirm"]')`, 'reload anyway');
    await page.waitFor(`window.beforeRestart === undefined && document.getElementById('safe-mode-banner')?.hidden === false`, 'the reloaded page in safe mode', 30_000);
    await page.waitFor(clusterItem('便签群'), 'the cluster list');
    assert.deepEqual(await imported(), [], 'safe mode: no module imported');
    assert.equal(await notice(), '');

    step = '(e) a restart out of safe mode: newly listed modules wait for a reload';
    await showCluster('便签群', 'c1');
    await restart();
    await page.waitFor(`document.getElementById('trust-banner').hidden === false`, 'the notice', 45_000);
    const offered = await notice();
    assert.match(offered, /^完全信任插件.*“第二个便签示例”.*现在可以加载，刷新页面后加载。$/);
    assert.doesNotMatch(offered, /彻底生效/, 'nothing was detached');
    assert.deepEqual(await imported(), [], 'no hot loading');
    await clickable(`document.getElementById('trust-reload')`, 'reload');
    await page.waitFor(`window.beforeRestart === undefined && document.querySelector('[data-trusted-demo="open"]')`, 'the reloaded page with the new notes button', 30_000);
    assert.deepEqual(await imported(), ['boom', 'hang', 'notes-two', 'probe-b', 'probe-c', 'slot-boom', ...bad].sort(), 'the confirmed ones; not the revoked trusted-demo and probe-a');
    assert.equal(await notice(), '');

    step = '(f) the Hub restarts while the page loads: the list the page loaded is still compared';
    await page.navigate(`http://127.0.0.1:${port}/?holdHealth=1#token=${TEST_TOKEN}`);
    await page.waitFor('window.__healthHeld === true', 'the page\'s first health check, held', 30_000);
    assert.ok((await imported()).includes('probe-c'), 'probe-c loaded from the list of the start before');
    assert.equal(await disposed('probe-c'), 0);
    writePluginsFile(home, { trusted: readPluginsFile(home).trusted!.filter((t) => t.id !== 'probe-c') });
    await page.evaluate('window.beforeRestart = true');
    await spawned!.stop();
    spawned = await spawnHub(dir, port);
    await page.evaluate('window.__releaseHealth()');
    await page.waitFor(`document.getElementById('trust-banner').textContent.includes('探针 probe-c')`, 'probe-c in the notice', 45_000);
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload of its own');
    assert.equal(await inPage('probe-c'), 0);
    assert.equal(await disposed('probe-c'), 1);

    step = '(g1) the first list read after an unchanged restart fails: no reload until the list is known, then as always';
    await page.navigate(`http://127.0.0.1:${port}/?fresh=2#token=${TEST_TOKEN}`);
    await page.waitFor(`${clusterItem('便签群')} && document.querySelector('[data-probe="probe-b"]')`, 'the page with its modules', 30_000);
    await page.evaluate('window.__failPlugins(1)');
    await restart();
    await page.waitFor('window.__pluginsFailed === 1', 'the failed read', 45_000);
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload while the list is unknown');
    assert.equal(await page.evaluate(`document.getElementById('update-banner').hidden && document.getElementById('trust-banner').hidden`), true, 'and no banner yet');
    await page.evaluate(`window.dispatchEvent(new Event('focus'))`);   // the next check (as the 10 s tick would)
    await page.waitFor(`window.beforeRestart === undefined && document.querySelector('[data-probe="probe-b"]')`, 'the ordinary reload (nothing unsaved)', 30_000);

    step = '(g2) the first list read after a revoke fails: no reload, then the detach';
    await page.evaluate('window.__failPlugins(1)');
    writePluginsFile(home, { trusted: readPluginsFile(home).trusted!.filter((t) => t.id !== 'probe-b') });
    await restart();
    await page.waitFor('window.__pluginsFailed === 1', 'the failed read', 45_000);
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload while the list is unknown');
    assert.equal(await notice(), '');
    assert.ok(await inPage('probe-b') > 0, 'the failed list read has not detached the plugin');
    await page.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await page.waitFor(`document.getElementById('trust-banner').textContent.includes('探针 probe-b')`, 'probe-b detached', 45_000);
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'still no reload');
    assert.equal(await inPage('probe-b'), 0);

    step = '(g3) safe mode on and off without a reload: the safe-mode banner follows the list';
    assert.equal(await page.evaluate(`document.getElementById('safe-mode-banner').hidden`), true);
    await restart({ ORRERY_SAFE_MODE: '1' });
    await page.waitFor(`document.getElementById('safe-mode-banner').hidden === false`, 'the safe-mode banner', 45_000);
    await restart();
    await page.waitFor(`document.getElementById('safe-mode-banner').hidden === true`, 'no safe-mode banner', 45_000);
    assert.equal(await page.evaluate('window.beforeRestart === true'), true, 'no reload of its own');
    assert.deepEqual(browser.problems().exceptions, [], 'no uncaught exception');
  } catch (error) {
    try { await shot('failure'); } catch { /* no page */ }
    throw new Error(`${step}: ${(error as Error).message}; page problems: ${JSON.stringify(browser?.problems())}`, { cause: error });
  } finally {
    await browser?.close();
    if (appOpen) await app.close();
    await spawned?.stop();
  }
});
