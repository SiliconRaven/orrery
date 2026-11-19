// Electron checks for the desktop shell (docs/desktop.md tests D and E). Run in desktop/: `npm run test:electron`.
// The shell runs for real (shell.mjs, its windows, IPC, navigation rules), against a fake Hub page served here and
// with a recording fake of the Win32 layer, so no real app window is touched. Part E also starts a real test Hub
// through `--ensure` (temporary ORRERY_HOME / ORRERY_DB, a free port other than 4317) and two real shell processes.
// Real app URL schemes (claude:, codex:, dsh:) are deliberately not navigated here: if a guard failed, the running
// app would receive the link. An unregistered scheme takes the same path; test/desktop.test.ts covers the named ones.
import { BrowserWindow, Menu, app, ipcMain, screen, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { APPS } from '../lib/apps.mjs';
import { BAR, runEnsure, startShell, STRIP_PAGE, TABS_PAGE } from '../shell.mjs';
import { desktopPageUrl } from '../ui/language.mjs';
import { createFakeFfi, fakeWindow } from './fake-ffi.mjs';
import { checkTempDir } from './temp-dir.mjs';

const DESKTOP = join(import.meta.dirname, '..');
const tabsUrl = desktopPageUrl(TABS_PAGE, 'zh');
const stripUrl = desktopPageUrl(STRIP_PAGE, 'zh');
const dir = checkTempDir('orrery-desktop-electron-');   // deleted after this process exits (temp-dir.mjs)
app.setPath('userData', join(dir, 'shell'));
let failed = 0;
// An exception in the main process (an IPC handler using a destroyed window, say) is a failure, not a dialog box.
const uncaught = [];
process.on('uncaughtException', (e) => { uncaught.push(e.message); failed++; console.log(`  FAIL uncaught in the main process: ${e.stack}`); });
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!(await cond()) && Date.now() < end) await sleep(50); return cond(); };

// Spies: nothing may be handed to the system, and no window may be created besides the shell's own three (its window,
// the "+" panel and the settings view).
const handedOut = [];
shell.openExternal = async (...args) => { handedOut.push(args); };
// The shell's one launch call (launchApp → shell.openPath) is recorded here and starts nothing; the start targets come
// from a fake lookup passed to startShell (fakeTarget), never from this machine's real apps.
const launched = [];
shell.openPath = async (...args) => { launched.push(args); return ''; };
const fakeTarget = (a) => (['kimi-code', 'zcode'].includes(a.id) ? { ok: true, path: `C:\\fake\\${a.exe}`, icon: '' } : { ok: false, reason: '测试：没有安装' });
let windowsCreated = 0;
const contents = [];
app.on('browser-window-created', () => { windowsCreated++; });
app.on('web-contents-created', (_e, c) => { contents.push(c.getType()); });
app.on('window-all-closed', () => { /* keep running: the last check closes the shell on purpose */ });

const PAGE = `<!doctype html><meta charset="utf-8"><title>fake hub</title>
<a id="ext" href="https://example.com/" target="_blank">external</a>
<a id="scheme" href="orrery-test-unregistered://x">scheme</a>
<script>
  window.__probe = { orrery: typeof window.orrery, require: typeof require, process: typeof process, ipc: typeof window.ipcRenderer };
  window.__sse = [];
  new EventSource('/events').onmessage = (e) => window.__sse.push(e.data);
</script>`;
const EVIL_TABS = `<!doctype html><meta charset="utf-8"><title>not the tab bar</title><script>
  window.__tried = typeof window.orrery;
  if (window.orrery) { window.orrery.close('t1'); window.orrery.select('orrery'); window.orrery.add(10); window.orrery.retry(); window.orrery.layoutMenu(); }
  window.__done = true;
</script>`;
// The same page in the "+" panel's window, with the panel's preload: a pick and a close, both refused.
const EVIL_STRIP = `<!doctype html><meta charset="utf-8"><title>not the panel</title><script>
  if (window.orrery) { window.orrery.pick('deepseek'); window.orrery.close(); }
  window.__done = true;
</script>`;

/** A stand-in for the Hub: the page above, SSE, redirects, and /api/shutdown answering with `shutdownStatus`. */
function fakeHub(port = 0, other = '') {
  const sse = new Set();
  const state = { shutdownStatus: 403, sseCount: 0, pageLoads: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(`data: hello-${++state.sseCount}\n\n`);
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }
    if (url.pathname === '/redirect-out') { res.writeHead(302, { location: `${other}/` }); res.end(); return; }
    if (url.pathname === '/redirect-scheme') { res.writeHead(302, { location: 'orrery-test-unregistered://y' }); res.end(); return; }
    if (url.pathname === '/redirect-file') { res.writeHead(302, { location: 'file:///C:/Windows/win.ini' }); res.end(); return; }
    if (url.pathname.startsWith('/api/shutdown')) { res.writeHead(state.shutdownStatus, { 'content-type': 'application/json' }); res.end('{}'); return; }
    if (url.pathname === '/evil-tabs') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(EVIL_TABS); return; }
    if (url.pathname === '/evil-strip') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(EVIL_STRIP); return; }
    state.pageLoads++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    ok({
      origin: `http://127.0.0.1:${p}`, port: p, state,
      dropSse() { for (const r of sse) r.destroy(); },
      close() { for (const r of sse) r.destroy(); server.closeAllConnections(); return new Promise((done) => server.close(() => done())); },
    });
  }));
}

const freePort = async () => { const s = await fakeHub(); await s.close(); return s.port === 4317 ? freePort() : s.port; };
const js = (wc, code) => wc.executeJavaScript(code).catch((e) => `error: ${e.message}`);
// Part E's real Hubs all get this API token (ORRERY_API_TOKEN); the fake Hub ignores it.
const API_TOKEN = 'electron-check-token-0123456789abcdefghij';
const auth = { authorization: `Bearer ${API_TOKEN}` };
const health = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/api/health`, { headers: auth })).json(); } catch { return null; } };
const shutdownHub = (port) => fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{}' }).catch(() => {});

/** The tab row is the window's title row: measured in the real window. */
async function titleRow(h) {
  console.log('\n[D] one top row: orrery mark, tabs, +, system caption buttons');
  await until(async () => !h.tabs.isLoading() && (await js(h.tabs, "document.querySelectorAll('.tab').length")) > 0, 10_000);
  const info = await js(h.tabs, `(() => {
    const region = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).getPropertyValue('app-region');
    const bar = document.getElementById('bar');
    const r = bar.getBoundingClientRect();
    const wco = navigator.windowControlsOverlay;
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: innerWidth, bar: region(bar),
      tab: region(document.querySelector('.tab')), add: region(document.getElementById('add')),
      first: { text: document.querySelector('.tab').innerText.trim(), img: document.querySelector('.tab img.icon:not([hidden])')?.src.slice(0, 22),
        label: document.querySelector('.tab .pick').getAttribute('aria-label') },
      overlay: !!(wco && wco.visible),
      area: wco ? wco.getTitlebarAreaRect().toJSON() : null };
  })()`);
  check(info.top === 0 && info.bottom === BAR, `the row is ${BAR} DIP high at the very top`, JSON.stringify(info));
  check(info.bar === 'drag' && info.tab === 'no-drag' && info.add === 'no-drag', 'empty space drags the window; tabs and + are clickable');
  check(info.first.text === '' && info.first.img === 'data:image/png;base64,' && info.first.label === '协作页',
    'the collaboration tab comes first: the orrery icon, no visible text, its name as the accessible name', JSON.stringify(info.first));
  check(info.overlay && info.right < info.width && Math.abs(info.right - (info.area.x + info.area.width)) <= 1,
    'the system caption buttons are on (window controls overlay) and the row ends where they begin', JSON.stringify(info.area));
  const outer = h.win.getBounds();
  const content = h.win.getContentBounds();
  check(content.y - outer.y <= 2 && outer.y + outer.height - (content.y + content.height) <= 10, 'no separate title bar: the content area starts at the top',
    `${JSON.stringify(outer)} / ${JSON.stringify(content)}`);
  h.win.maximize();
  await until(() => h.win.isMaximized(), 3000);
  await sleep(500);
  const work = screen.getDisplayMatching(h.win.getBounds()).workArea;
  const max = h.win.getContentBounds();
  check(['x', 'y', 'width', 'height'].every((k) => Math.abs(max[k] - work[k]) <= 1), 'maximized: the content area is the work area, the dock area starts under the row',
    `${JSON.stringify(max)} vs ${JSON.stringify(work)}`);
  h.win.unmaximize();
  await until(() => !h.win.isMaximized(), 3000);
  await sleep(300);
}

async function isolation(h, hub, other) {
  console.log('\n[D] collaboration page: no desktop interface, same-origin page and SSE work');
  const ready = await until(async () => (await js(h.collab, 'window.__sse.length')) > 0, 10_000);
  check(ready && h.collab.getURL().startsWith(hub.origin), 'the Hub page loads and its SSE stream works', h.collab.getURL());
  const probe = await js(h.collab, 'window.__probe');
  check(Object.values(probe).every((v) => v === 'undefined'), 'no window.orrery, require, process or ipcRenderer in the page', JSON.stringify(probe));
  await js(h.collab, "location.href = '/second'");
  check(await until(() => h.collab.getURL() === `${hub.origin}/second`), 'a same-origin navigation is allowed');

  console.log('\n[D] IPC only from the tab bar, only with tab ids');
  await until(() => !h.tabs.isLoading());
  const fake = h.ffiCalls;
  const before = { ...h.ipc };
  await js(h.tabs, "window.orrery.select('orrery'); true");
  check(await until(() => h.ipc.accepted === before.accepted + 1), 'the tab bar page is accepted');
  h.dispatch({ type: 'add', candidate: h.candidates()[0] });
  check(h.state.tabs[0]?.binding, 'a (fake) window was picked into t1');
  h.dispatch({ type: 'select', id: 'orrery' });
  const writes = fake.length;
  const tabsBefore = JSON.stringify(h.state.tabs);
  await js(h.tabs, `window.orrery.select({ hwnd: 4096 }); window.orrery.select('t99'); window.orrery.close(4096); window.orrery.select('run:calc.exe');
    window.orrery.close('orrery'); true`);
  await sleep(400);
  check(fake.length === writes && JSON.stringify(h.state.tabs) === tabsBefore, 'forged handles, unknown ids and command names change nothing');
  const rejected = h.ipc.rejected;
  ipcMain.emit('tabs:close', { sender: h.collab, senderFrame: h.collab.mainFrame }, 't1');
  ipcMain.emit('tabs:close', { sender: h.tabs, senderFrame: { parent: h.tabs.mainFrame, processId: h.tabs.mainFrame.processId, routingId: -1, url: tabsUrl } }, 't1');
  ipcMain.emit('tabs:close', { sender: h.tabs, senderFrame: h.tabs.mainFrame }, 't1', 'extra');
  check(h.ipc.rejected === rejected + 3 && h.state.tabs[0].binding, 'refused: the collaboration page as sender, a subframe, extra arguments');
  await h.tabs.loadURL(`${hub.origin}/evil-tabs`);
  await until(async () => (await js(h.tabs, 'window.__done')) === true);
  await sleep(400);
  check(h.ipc.rejected === rejected + 8 && h.state.tabs[0].binding && fake.length === writes,
    'a tab bar navigated to another page is refused, even with the preload present', `rejected ${h.ipc.rejected - rejected - 3}`);
  await h.tabs.loadURL(tabsUrl);
  await js(h.tabs, "window.orrery.select('orrery'); true");
  check(await until(() => h.ipc.accepted > before.accepted + 1), 'back on the fixed page, the tab bar is accepted again');
  const r2 = h.ipc.rejected;
  await h.strips.loadURL(`${hub.origin}/evil-strip`);
  await until(async () => (await js(h.strips, 'window.__done')) === true);
  await sleep(400);
  check(h.ipc.rejected === r2 + 2 && h.state.tabs[0].binding && fake.length === writes && launched.length === 0,
    'a panel navigated to another page is refused too, even with its preload present', `rejected ${h.ipc.rejected - r2}`);
  await h.strips.loadURL(stripUrl);

  console.log('\n[D] navigation, redirects and new windows never leave the Hub origin and hand nothing to the system');
  const home = `${hub.origin}/second`;
  const backHome = async () => {
    if (h.collab.getURL() !== home || (await js(h.collab, 'typeof window.__sse')) !== 'object') await h.collab.loadURL(home);
  };
  const targets = ['https://example.com/', `${other.origin}/`, 'orrery-test-unregistered://x', 'file:///C:/Windows/win.ini', 'data:text/html,hi',
    '/redirect-out', '/redirect-scheme', '/redirect-file'];
  for (const t of targets) {
    await backHome();
    js(h.collab, `location.href = ${JSON.stringify(t)}; true`);
    await sleep(600);
    // A redirect to file: is refused by Chromium itself (ERR_UNSAFE_REDIRECT): an error page at the Hub URL.
    check(new URL(h.collab.getURL()).origin === hub.origin, `stays on the Hub origin: ${t}`, h.collab.getURL());
  }
  await backHome();
  const opens = await js(h.collab, `[window.open('https://example.com/'), window.open('/'), window.open('orrery-test-unregistered://z'), window.open('')].map(String)`);
  check(JSON.stringify(opens) === JSON.stringify(['null', 'null', 'null', 'null']), 'window.open always gets no window', JSON.stringify(opens));
  await js(h.collab, "document.getElementById('ext').click(); document.getElementById('scheme').click(); true");
  await js(h.collab, `const f = document.createElement('iframe'); f.src = ${JSON.stringify(`${other.origin}/`)}; document.body.append(f); true`);
  await sleep(800);
  const frames = h.collab.mainFrame.framesInSubtree.map((f) => f.url);
  check(!frames.some((u) => u.startsWith(other.origin)), 'a cross-origin iframe is not loaded', JSON.stringify(frames));
  check(h.collab.getURL() === home, 'clicked external and scheme links went nowhere');
  check(handedOut.length === 0, 'shell.openExternal was never called', JSON.stringify(handedOut));
  check(launched.length === 0, 'nothing was started (shell.openPath never called)', JSON.stringify(launched));
  check(windowsCreated === 3, 'no window besides the shell, its + panel and its settings view was created', `${windowsCreated}`);
  check(contents.length === 4, 'no web contents besides the tab bar, the collaboration page, the + panel and the settings view', JSON.stringify(contents));
}

/** F5 / Ctrl+R (real key input events) reload the collaboration page only; the tab bar is never reloaded. */
async function reloadKeys(h, hub) {
  console.log('\n[D] F5 and Ctrl+R reload the collaboration page (main process), never the tab bar');
  h.dispatch({ type: 'select', id: 'orrery' });
  const url = desktopPageUrl(h.collab.getURL(), 'zh');
  let tabLoads = 0;
  h.tabs.on('did-finish-load', () => { tabLoads++; });
  const reloaded = async (n) => (await until(() => hub.state.pageLoads === n, 3000))
    && await until(async () => !h.collab.isLoading() && (await js(h.collab, 'window.__sse?.length')) > 0, 5000);
  const key = (wc, keyCode, modifiers = []) => {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  let n = hub.state.pageLoads;
  key(h.collab, 'F5');
  check(await reloaded(n + 1) && h.collab.getURL() === url, 'F5 in the collaboration page reloads it with the desktop language', `${hub.state.pageLoads - n} load(s), ${h.collab.getURL()}`);
  n = hub.state.pageLoads;
  key(h.collab, 'R', ['control']);
  check(await reloaded(n + 1), 'Ctrl+R in the collaboration page reloads it');
  n = hub.state.pageLoads;
  key(h.tabs, 'F5');
  check(await reloaded(n + 1), 'F5 in the tab bar while 协作 is selected reloads the collaboration page');
  h.dispatch({ type: 'select', id: 't1' });
  n = hub.state.pageLoads;
  key(h.tabs, 'R', ['control']);
  key(h.tabs, 'F5');
  await sleep(800);
  check(hub.state.pageLoads === n, 'with an app tab selected, the keys in the tab bar reload nothing', `${hub.state.pageLoads - n} load(s)`);
  check(tabLoads === 0, 'the tab bar page itself was never reloaded', `${tabLoads}`);
  h.dispatch({ type: 'select', id: 'orrery' });
}

/**
 * A first click on the inactive shell activates it on mouse-down, and the 'focus' that follows makes the main process
 * send the (unchanged) state again before mouse-up. Real input events in the real renderer; the select must arrive.
 */
async function clickAcrossRedraw(h) {
  console.log('\n[D] a click on a tab still selects it when the state is sent again between mouse-down and mouse-up');
  h.dispatch({ type: 'select', id: 'orrery' });
  await js(h.tabs, `window.__states = 0; window.__downs = 0;
    window.orrery.onState(() => { window.__states++; });
    document.addEventListener('mousedown', () => { window.__downs++; }, true); true`);
  await until(async () => (await js(h.tabs, 'window.__states')) > 0);
  const at = await js(h.tabs, `(() => {
    const pick = document.querySelectorAll('.tab .pick')[1];
    window.__pick = pick;
    const r = pick.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const accepted = h.ipc.accepted;
  const states = await js(h.tabs, 'window.__states');
  h.tabs.sendInputEvent({ type: 'mouseMove', ...at });
  h.tabs.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
  await until(async () => (await js(h.tabs, 'window.__downs')) > 0);
  h.dispatch({ type: 'focus' });   // what win.on('focus') does when that mouse-down activated the shell
  await until(async () => (await js(h.tabs, 'window.__states')) > states);
  const replaced = await js(h.tabs, '!window.__pick.isConnected');
  h.tabs.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
  const selected = () => h.state.panes[h.state.active];
  // Two messages per click on a tab: the press (tabs:press, which closes the + panel if open) and the select.
  const ok = await until(() => h.ipc.accepted === accepted + 2 && selected() === 't1', 2000);
  check(ok, 'one click selected t1', `accepted +${h.ipc.accepted - accepted}, selected ${selected()}, button replaced before mouse-up: ${replaced}`);
}

/**
 * The "+" panel (docs/desktop.md "+ 面板"): a window of the shell's own under +, owned by the shell and on top; icons
 * only. Its two channels only from the panel page (a pick with a supported app id, a close), the tab bar's only from
 * the tab bar. With real mouse and key events: one candidate goes straight into a new tab, several are offered by title
 * (the menu's popup replaced by a recorder), a disabled icon sends nothing, arrows and Enter work, Escape, + again, a
 * click outside it and moving the shell close it.
 */
async function plusStrip(h, ffi) {
  console.log('\n[D] the + panel: under +, above the content, icons only; a pick only from the panel, with a supported app id');
  ffi.add(fakeWindow({ hwnd: 0xb, pid: 4100, exePath: 'C:\\Apps\\Codex\\app\\ChatGPT.exe', title: 'Codex A' }));
  ffi.add(fakeWindow({ hwnd: 0xc, pid: 4100, exePath: 'C:\\Apps\\Codex\\app\\ChatGPT.exe', title: 'Codex B' }));
  ffi.add(fakeWindow({ hwnd: 0xd, pid: 4200, exePath: 'C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe', title: 'DeepSeek' }));
  await until(() => !h.strips.isLoading());
  const prefs = h.strips.getLastWebPreferences();
  const probe = await js(h.strips, '({ require: typeof require, process: typeof process, api: Object.keys(window.orrery ?? {}).join() })');
  check(prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.webSecurity !== false
    && probe.require === 'undefined' && probe.process === 'undefined' && probe.api === 'onState,pick,close' && h.strips.getURL() === stripUrl,
  'the panel: its fixed local page, sandboxed, context isolation, no node; its preload exposes onState, pick and close only', JSON.stringify(probe));
  check(h.panel.getParentWindow() === null && h.panel.isAlwaysOnTop() && !h.panel.isVisible(), 'not owned by the shell window (see lowerShell), on top, hidden until +');

  const tabCount = h.state.tabs.length;
  const before = { ...h.ipc };
  const bar = { sender: h.tabs, senderFrame: h.tabs.mainFrame };
  const panel = { sender: h.strips, senderFrame: h.strips.mainFrame };
  const collabFrame = { sender: h.collab, senderFrame: h.collab.mainFrame };
  const sub = { sender: h.strips, senderFrame: { parent: h.strips.mainFrame, processId: h.strips.mainFrame.processId, routingId: -1, url: stripUrl } };
  const reject = [
    ['strip:pick', collabFrame, 'deepseek'], ['strip:close', collabFrame], ['tabs:add', collabFrame, 10],
    ['strip:pick', bar, 'deepseek'], ['strip:close', bar], ['tabs:add', panel, 10], ['tabs:select', panel, 'orrery'], ['strip:pick', sub, 'deepseek'],
    ['strip:pick', panel, 'calc'], ['strip:pick', panel, 'C:\\Windows\\System32\\calc.exe'], ['strip:pick', panel, 1], ['strip:pick', panel, { id: 'deepseek' }],
    ['strip:pick', panel], ['strip:pick', panel, 'deepseek', 'extra'], ['strip:close', panel, 'x'],
    ['tabs:add', bar], ['tabs:add', bar, 'claude'], ['tabs:add', bar, NaN], ['tabs:add', bar, { x: 10 }], ['tabs:add', bar, { x: 10, press: 0 }],
    ['tabs:add', bar, 10, 20], ['tabs:press', bar, 1], ['tabs:press', collabFrame], ['tabs:press', panel],
  ];
  for (const [channel, event, ...args] of reject) ipcMain.emit(channel, event, ...args);
  check(h.ipc.rejected === before.rejected + reject.length && h.ipc.accepted === before.accepted && h.strip === null && h.state.tabs.length === tabCount,
    'refused: the collaboration page, the tab bar on the panel\'s channels and the panel on the tab bar\'s, a subframe, unknown ids, paths, numbers, objects, missing or extra arguments',
    `rejected ${h.ipc.rejected - before.rejected} of ${reject.length}`);
  ipcMain.emit('strip:pick', panel, 'deepseek');
  check(h.state.tabs.length === tabCount, 'a pick while the panel is closed adds nothing');

  const center = (wc, sel) => js(wc, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const clickIn = async (wc, sel) => {
    const at = await center(wc, sel);
    wc.sendInputEvent({ type: 'mouseMove', ...at });
    wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
  };
  const click = (sel) => clickIn(sel.startsWith('#apps') ? h.strips : h.tabs, sel);
  // Enter activates a button on its character event, as with a real key press.
  const key = async (wc, keyCode) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await sleep(60);
  };
  const shown = () => h.strip !== null && h.panel.isVisible();
  const open = async () => { await click('#add'); return until(shown); };

  check(await open(), 'a click on + opens the panel');
  const add = await js(h.tabs, "(() => { const r = document.getElementById('add').getBoundingClientRect(); return { left: r.left, bottom: r.bottom }; })()");
  const p = h.panel.getBounds();
  const c = h.win.getContentBounds();
  check(p.y === c.y + BAR + 2 && Math.abs(p.x - (c.x + Math.round(add.left))) <= 1 && p.x + p.width <= c.x + c.width && add.bottom < BAR,
    'just below the tab row, its left edge under +, inside the shell', `panel ${JSON.stringify(p)}, + at ${add.left}, content ${JSON.stringify(c)}`);
  check(await js(h.tabs, "document.getElementById('add').getAttribute('aria-expanded')") === 'true', '+ says it is expanded');
  const dom = await js(h.strips, `[...document.querySelectorAll('#apps .app')].map((b) => { const r = b.getBoundingClientRect(); const g = b.querySelector('.glyph').getBoundingClientRect();
    return { text: b.innerText.trim(), status: b.dataset.status, off: b.getAttribute('aria-disabled'), tip: b.title, w: r.width, h: r.height, gw: g.width, inside: r.right <= innerWidth - 1 && r.bottom <= innerHeight - 1, at: [r.right, r.bottom, innerWidth, innerHeight] }; })`);
  const status = dom.map((d) => d.status).join();
  const expectedStatus = { claude: 'docked', codex: 'add', deepseek: 'add', 'kimi-code': 'launch', zcode: 'launch' };
  check(dom.length === APPS.length && status === APPS.map(({ id }) => expectedStatus[id] ?? 'missing').join(),
    'one icon per supported app: Claude docked, Codex and DeepSeek to add, Kimi Code and ZCode to start, the rest not found', status);
  check(dom.every((d) => d.w === 44 && d.h === 44 && d.gw === 32 && d.inside), 'each a 44 × 44 target with a 32 px icon, all inside the panel', JSON.stringify(dom.map((d) => [d.w, d.h, d.gw, d.at])));
  // A program file without an icon shows its app name's first character instead; Codex shows the count of its 2 windows.
  check(dom.every((d) => [...d.text.replace(/[\d\s]/g, '')].length <= 1) && dom[1].text.endsWith('2'), 'no visible names: an icon or one letter, and a window count', JSON.stringify(dom.map((d) => d.text)));
  check(dom[0].off === 'true' && dom[5].off === 'true' && dom[2].off === 'false' && dom[3].off === 'false' && dom[2].tip === 'DeepSeek Harness：加成标签'
    && dom[3].tip === 'Kimi Code：没有在运行，点一下启动它' && dom[7].tip === 'WorkBuddy：没有在运行，也没法启动（测试：没有安装）', 'names and states are in the tooltips', JSON.stringify(dom.map((d) => d.tip)));
  const accepted = h.ipc.accepted;
  await click('#apps .app[data-status="missing"]');
  await sleep(300);
  check(h.ipc.accepted === accepted && shown(), 'a disabled icon sends nothing');
  await click('#apps .app:nth-child(3)');
  check(await until(() => h.state.tabs.length === tabCount + 1), 'DeepSeek\'s one window: one click, a new tab');
  const added = h.state.tabs.at(-1);
  check(added?.binding?.hwnd === 0xd && h.state.panes[h.state.active] === added.id && h.strip === null && !h.panel.isVisible(),
    'bound to that window (identity captured), selected, panel closed');

  console.log('\n[D] the + panel by keyboard: arrows move, Enter picks, Escape closes and gives the focus back to +');
  const popped = [];
  const realPopup = Menu.prototype.popup;
  Menu.prototype.popup = function popup(options) { popped.push(this); options?.callback?.(); };
  try {
    await open();
    const focused = () => js(h.strips, "[...document.querySelectorAll('#apps .app')].indexOf(document.activeElement)");
    check(await until(() => h.panel.isFocused(), 2000) && await focused() === -1, 'opened: the panel has the focus, no icon looks chosen yet', `panel focused ${h.panel.isFocused()}`);
    await key(h.strips, 'Right');
    await key(h.strips, 'Right');
    const atCodex = await focused();
    await key(h.strips, 'End');
    const atEnd = await focused();
    await key(h.strips, 'Home');
    await key(h.strips, 'Right');
    check(atCodex === 1 && atEnd === APPS.length - 1 && await focused() === 1, 'Right, End, Home move the focus between the icons', `${atCodex}, ${atEnd}`);
    await key(h.strips, 'Return');
    check(await until(() => popped.length === 1), 'Enter on Codex (two windows): a list');
    const labels = popped[0]?.items.map((i) => i.label).join(', ');
    check(labels === 'Codex A, Codex B' && h.state.tabs.length === tabCount + 1 && h.strip === null, 'listing the windows by title; nothing added before a pick; the panel closed', labels);
    popped[0].items[1].click();
    check(h.state.tabs.at(-1)?.binding?.hwnd === 0xc, 'the picked window goes into a new tab');
  } finally {
    Menu.prototype.popup = realPopup;
  }
  await open();
  await until(() => h.panel.isFocused(), 2000);
  await key(h.strips, 'Escape');
  check(await until(() => h.strip === null && !h.panel.isVisible()), 'Escape closes the panel');
  check(await until(() => h.win.isFocused(), 2000) && await js(h.tabs, 'document.activeElement?.id') === 'add', 'and the focus is back on + in the shell',
    `shell focused ${h.win.isFocused()}, active element ${await js(h.tabs, 'document.activeElement?.id')}`);
  await open();
  await click('#add');
  check(await until(() => h.strip === null && !h.panel.isVisible()), '+ again closes it');
  // The shell itself taking the focus (as a press on its empty title row does) leaves it open; a press elsewhere in the
  // shell (here: the dock area of the tab bar page) closes it; a click on + after that opens it.
  await open();
  await until(() => h.panel.isFocused(), 2000);
  h.win.focus();
  await until(() => h.win.isFocused(), 2000);
  await sleep(300);
  check(shown() && h.win.isFocused(), 'the shell taking the focus (a press on its title row) leaves it open');
  const elsewhere = { x: 20, y: BAR + 20 };
  h.tabs.sendInputEvent({ type: 'mouseDown', ...elsewhere, button: 'left', clickCount: 1 });
  h.tabs.sendInputEvent({ type: 'mouseUp', ...elsewhere, button: 'left', clickCount: 1 });
  check(await until(() => h.strip === null && !h.panel.isVisible()), 'a press elsewhere in the tab bar closes it');
  check(await open(), 'a click on + after that opens it again');
  // A press on + while it is open: the press activates the shell (h.win.focus() here, as Windows does on the press);
  // that alone does not close it, so the click that ends the press closes it, however long it was held and however late
  // its IPC reaches the main process (the main thread is blocked in one case so that the IPC waits).
  const plus = await center(h.tabs, '#add');
  const pressPlus = async (ms, blockMs = 0) => {
    await until(() => h.panel.isFocused(), 2000);
    h.tabs.sendInputEvent({ type: 'mouseMove', ...plus });
    h.tabs.sendInputEvent({ type: 'mouseDown', ...plus, button: 'left', clickCount: 1 });
    h.win.focus();
    await sleep(ms);
    h.tabs.sendInputEvent({ type: 'mouseUp', ...plus, button: 'left', clickCount: 1 });
    if (blockMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
    await sleep(300);
  };
  await pressPlus(80);
  check(h.strip === null && !h.panel.isVisible(), 'a quick click on + while it is open closes it, and it stays closed');
  check(await open(), 'opened again');
  await pressPlus(700);
  check(h.strip === null && !h.panel.isVisible(), 'a press on + held for 0.7 s closes it; its release does not reopen it');
  check(await open(), 'opened again');
  await pressPlus(550, 350);
  check(h.strip === null && !h.panel.isVisible(), 'held 0.55 s while the main process was busy 0.35 s: closed, not reopened');
  // Its own close (Alt+F4 while it has the focus) only closes it: the window is kept and opens again.
  check(await open(), 'opened again');
  h.panel.close();
  check(await until(() => h.strip === null && !h.panel.isVisible()) && !h.panel.isDestroyed(), 'the panel\'s own close only closes it; the window is kept');
  check(await open() && !h.win.isDestroyed() && uncaught.length === 0, 'and + opens it again; the shell goes on, nothing thrown');
  await click('#add');
  await until(() => h.strip === null);
  const [x, y] = h.win.getPosition();
  h.win.setPosition(x + 10, y);
  check(await until(() => h.strip === null && !h.panel.isVisible()), 'moving the shell closes it');
  h.win.setPosition(x, y);
  await sleep(200);
  await startFromStrip(h, ffi, click, shown, open, panel);
  const tabsDom = await js(h.tabs, "[...document.querySelectorAll('.tab .pick')].map((p) => ({ text: p.innerText.trim(), label: p.getAttribute('aria-label') }))");
  check(tabsDom.every((t) => [...t.text].length <= 1) && tabsDom[1]?.label === 'Claude', 'tabs show no text (an icon, or one letter without one); the app name is the accessible name', JSON.stringify(tabsDom));
  for (const t of h.state.tabs.slice(tabCount)) h.dispatch({ type: 'close', id: t.id });
  h.dispatch({ type: 'select', id: 't1' });
}

/**
 * Starting an app from the panel (docs/desktop.md "启动应用"), with the recorded launch call and the fake lookup: nothing
 * is started by opening the panel, a re-selection, the shell being brought back or the collaboration page; a click on a
 * not-running app's icon starts it once; its one new window goes into a new tab, two new windows are offered by title.
 */
async function startFromStrip(h, ffi, click, shown, open, panel) {
  console.log('\n[D] starting an app from the panel: only a click on its icon starts it, once; its new window is docked');
  const n = launched.length;
  ipcMain.emit('strip:pick', { sender: h.collab, senderFrame: h.collab.mainFrame }, 'kimi-code');
  ipcMain.emit('strip:pick', { sender: h.tabs, senderFrame: h.tabs.mainFrame }, 'kimi-code');
  h.focus();   // what a second shell does
  await open();
  check(launched.length === n && h.ipc.rejected > 0, 'opening the panel, the collaboration page\'s and the tab bar\'s pick and the shell being brought back start nothing');
  await click('#apps .app:nth-child(4)');   // Kimi Code
  check(await until(() => launched.length === n + 1), 'a click on Kimi Code\'s icon starts it');
  check(JSON.stringify(launched.at(-1)) === JSON.stringify(['C:\\fake\\Kimi Code.exe']), 'with the looked-up path alone: no arguments', JSON.stringify(launched.at(-1)));
  check(h.starting.join() === 'kimi-code' && h.strip === null, 'the shell watches for its window; the panel closed');
  await sleep(450);
  await open();
  const st = await js(h.strips, "document.querySelector('#apps .app:nth-child(4)').dataset.status + ' ' + document.querySelector('#apps .app:nth-child(4)').getAttribute('aria-disabled')");
  check(st === 'starting true', 'while it starts, its icon is disabled ("正在启动")', st);
  await click('#apps .app:nth-child(4)');
  await sleep(300);
  check(launched.length === n + 1, 'a click meanwhile does not start it again');
  // Its window appears. Until the watch has decided (its settle time), the panel read again still says "starting" and
  // a pick adds nothing. Sent in the same turn, before the watch's next poll.
  const tabs = h.state.tabs.length;
  const fromBar = { sender: h.tabs, senderFrame: h.tabs.mainFrame };
  ffi.add(fakeWindow({ hwnd: 0xe1, pid: 4500, exePath: 'C:\\Apps\\Kimi Code\\Kimi Code.exe', title: 'Kimi Code' }));
  ipcMain.emit('tabs:add', fromBar, 40);
  ipcMain.emit('tabs:add', fromBar, 40);   // closed and opened again: read now, with the window there
  const entry = h.strip?.find((e) => e.id === 'kimi-code');
  ipcMain.emit('strip:pick', panel, 'kimi-code');
  check(entry?.status === 'starting' && entry.windows === 1 && h.state.tabs.length === tabs && launched.length === n + 1,
    'with its window already there: still "starting", and a pick adds nothing and starts nothing', JSON.stringify(entry));
  check(await until(() => h.state.tabs.length === tabs + 1, 4000), 'its one new window goes into a new tab (by the watch)');
  check(h.state.tabs.at(-1)?.binding?.hwnd === 0xe1 && h.starting.length === 0, 'bound to it (identity captured); the watch ended');

  const popped = [];
  const realPopup = Menu.prototype.popup;
  Menu.prototype.popup = function popup(options) { popped.push(this); options?.callback?.(); };
  try {
    if (h.strip) ipcMain.emit('strip:close', panel);
    await sleep(450);
    await open();
    await click('#apps .app:nth-child(5)');   // ZCode
    check(await until(() => launched.length === n + 2), 'a click on ZCode\'s icon starts it');
    ffi.add(fakeWindow({ hwnd: 0xe2, pid: 4600, exePath: 'C:\\Apps\\ZCode\\ZCode.exe', title: 'ZCode one' }));
    ffi.add(fakeWindow({ hwnd: 0xe3, pid: 4600, exePath: 'C:\\Apps\\ZCode\\ZCode.exe', title: 'ZCode two' }));
    check(await until(() => popped.length === 1, 4000), 'two new windows together: a list');
    const labels = popped[0]?.items.map((i) => i.label).join(', ');
    check(labels === 'ZCode one, ZCode two' && h.state.tabs.length === tabs + 1, 'by title; nothing added before a pick', labels);
  } finally {
    Menu.prototype.popup = realPopup;
  }
  // Re-selecting an unbound tab never starts anything (its list is the app's running windows only).
  check(launched.length === n + 2, 'exactly two starts, both from clicks on icons');
}

/**
 * Split view (docs/desktop.md "分屏"): the new IPC only from the tab bar and only with valid values; the layout menu;
 * a divider dragged with real mouse events keeps its pointer capture while the main process sends the state again
 * (changed and unchanged) mid-drag; a tab click survives a changed state between mouse-down and mouse-up.
 */
async function splitView(h) {
  console.log('\n[D] split view: new IPC only from the tab bar, only with valid values');
  const before = { ...h.ipc };
  const fake = { sender: h.tabs, senderFrame: h.tabs.mainFrame };
  const reject = [
    ['pane:activate', { sender: h.collab, senderFrame: h.collab.mainFrame }, 0],
    ['layout:ratios', { sender: h.collab, senderFrame: h.collab.mainFrame }, { x: 0.3, y: 0.5 }],
    ['layout:menu', { sender: h.collab, senderFrame: h.collab.mainFrame }],
    ['pane:activate', { sender: h.tabs, senderFrame: { parent: h.tabs.mainFrame, processId: h.tabs.mainFrame.processId, routingId: -1, url: tabsUrl } }, 0],
    ['pane:activate', fake, 5], ['pane:activate', fake, -1], ['pane:activate', fake, 0.5], ['pane:activate', fake, '0'], ['pane:activate', fake],
    ['pane:activate', fake, 0, 1],
    ['layout:ratios', fake, { x: NaN, y: 0.5 }], ['layout:ratios', fake, { x: Infinity, y: 0.5 }], ['layout:ratios', fake, { x: '0.3', y: 0.5 }],
    ['layout:ratios', fake, { x: 0.3 }], ['layout:ratios', fake, { x: 0.3, y: 0.5, hwnd: 10 }], ['layout:ratios', fake, [0.3, 0.5]],
    ['layout:ratios', fake, { x: 0.3, y: 0.5 }, 'extra'], ['layout:ratios', fake], ['layout:menu', fake, 'grid'],
  ];
  const stateBefore = JSON.stringify(h.state);
  for (const [channel, event, ...args] of reject) ipcMain.emit(channel, event, ...args);
  check(h.ipc.rejected === before.rejected + reject.length && h.ipc.accepted === before.accepted && JSON.stringify(h.state) === stateBefore,
    'refused: the collaboration page, a subframe, a pane out of range or not an integer, divider values not finite, extra keys or arguments',
    `rejected ${h.ipc.rejected - before.rejected} of ${reject.length}`);
  await js(h.tabs, 'window.orrery.activate(3); window.orrery.ratios({ x: Infinity, y: 0 }); true');
  check(await until(() => h.ipc.rejected === before.rejected + reject.length + 2), 'from the tab bar too: pane 3 in a single layout, an infinite position');

  // The layout menu: built in the main process; the popup is replaced by a recorder here, so nothing opens on screen.
  const popped = [];
  const realPopup = Menu.prototype.popup;
  Menu.prototype.popup = function popup(options) { popped.push(this); options?.callback?.(); };
  try {
    await js(h.tabs, 'window.orrery.layoutMenu(); true');
    check(await until(() => popped.length === 1), 'the layout button opens the layout menu (main process)');
    const items = popped[0]?.items.map((i) => `${i.label}${i.checked ? '*' : ''}`).join(', ');
    check(items === '单栏*, 左右两栏, 四宫格', 'single, two columns, 2 × 2 grid; the current one checked', items);
    popped[0].items[1].click();
  } finally {
    Menu.prototype.popup = realPopup;
  }
  check(h.state.layout === 'columns' && h.state.active === 1 && h.state.panes[1] === null, 'picking "左右两栏": two columns, the new right pane empty and active', JSON.stringify(h.state.panes));
  await until(async () => (await js(h.tabs, "document.getElementById('panel').dataset.layout")) === 'columns');

  // The collaboration page sits in its pane; a click into it makes that pane active (seen in the main process).
  h.dispatch({ type: 'activate', pane: 0 });
  h.dispatch({ type: 'select', id: 'orrery' });   // into the left pane, in place of t1
  h.dispatch({ type: 'activate', pane: 1 });
  const view = h.win.contentView.children.find((v) => v.webContents === h.collab);
  const [cw] = h.win.getContentSize();
  const b = view?.getBounds();
  check(h.state.panes[0] === 'orrery' && b && b.x === 0 && b.y === BAR && Math.abs(b.width - Math.round((cw - 6) / 2)) <= 1,
    'the collaboration page fills the left pane only', JSON.stringify(b));
  h.collab.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
  h.collab.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
  check(await until(() => h.state.active === 0, 2000), 'a click into the collaboration page makes its pane active');

  console.log('\n[D] split view: dragging a divider with real mouse events, while the state is sent again mid-drag');
  await js(h.tabs, `window.__vdiv = document.getElementById('vdiv'); window.__lost = 0;
    window.__vdiv.addEventListener('lostpointercapture', () => { window.__lost++; }); true`);
  const geo = await js(h.tabs, `(() => {
    const p = document.getElementById('panel').getBoundingClientRect();
    const d = document.getElementById('vdiv').getBoundingClientRect();
    return { left: p.left, width: p.width, x: Math.round(d.left + d.width / 2), y: Math.round(d.top + d.height / 2) };
  })()`);
  const ratioAt = (x) => (x - geo.left - 3) / (geo.width - 6);
  const move = (x, y = geo.y) => h.tabs.sendInputEvent({ type: 'mouseMove', x, y, modifiers: ['leftButtonDown'] });
  h.tabs.sendInputEvent({ type: 'mouseMove', x: geo.x, y: geo.y });
  h.tabs.sendInputEvent({ type: 'mouseDown', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
  const target1 = Math.round(geo.left + geo.width * 0.35);
  for (let x = geo.x; x >= target1; x -= 20) { move(x, geo.y + 60); await sleep(20); }
  move(target1, geo.y + 60);
  check(await until(() => Math.abs(h.state.ratios.x - ratioAt(target1)) < 0.002, 2000), 'the divider follows the drag', `x ${h.state.ratios.x.toFixed(3)} vs ${ratioAt(target1).toFixed(3)}`);
  // Mid-drag the main process sends the state again: unchanged (activation) and changed (another active pane, a notice).
  const sent = await js(h.tabs, 'window.__states = 0; window.orrery.onState(() => { window.__states++; }); true');
  h.dispatch({ type: 'focus' });
  h.dispatch({ type: 'activate', pane: 1 });
  h.dispatch({ type: 'activate', pane: 0 });
  check(sent === true && await until(async () => (await js(h.tabs, 'window.__states')) >= 3), 'the state was sent again three times mid-drag');
  const target2 = Math.round(geo.left + geo.width * 0.7);
  for (let x = target1; x <= target2; x += 25) { move(x, geo.y - 80); await sleep(20); }
  move(target2, geo.y - 80);
  check(await until(() => Math.abs(h.state.ratios.x - ratioAt(target2)) < 0.002, 2000), 'after that the drag still moves the divider (pointer capture kept)',
    `x ${h.state.ratios.x.toFixed(3)} vs ${ratioAt(target2).toFixed(3)}`);
  move(Math.round(geo.left + 4), geo.y);
  check(await until(() => h.state.ratios.x === 0.15, 2000), 'dragged to the edge: stops at 15 %', String(h.state.ratios.x));
  h.tabs.sendInputEvent({ type: 'mouseUp', x: Math.round(geo.left + 4), y: geo.y, button: 'left', clickCount: 1 });
  const kept = await js(h.tabs, "window.__vdiv === document.getElementById('vdiv') && window.__vdiv.isConnected");
  const lost = await js(h.tabs, 'window.__lost');
  check(kept === true && lost === 1, 'the divider element was never replaced; the capture ended once, on mouse-up', `same element ${kept}, capture lost ${lost} time(s)`);
  await sleep(100);
  move(Math.round(geo.left + geo.width * 0.6), geo.y);
  await sleep(300);
  check(h.state.ratios.x === 0.15, 'after mouse-up, moving the mouse changes nothing');

  console.log('\n[D] split view: a tab click survives a changed state between mouse-down and mouse-up');
  h.dispatch({ type: 'activate', pane: 1 });
  await until(async () => (await js(h.tabs, "document.querySelectorAll('.pane')[1].classList.contains('active')")) === true);
  const at = await js(h.tabs, `(() => {
    const pick = document.querySelectorAll('.tab .pick')[1];
    window.__pick = pick;
    const r = pick.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const accepted = h.ipc.accepted;
  h.tabs.sendInputEvent({ type: 'mouseMove', ...at });
  h.tabs.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
  await sleep(100);
  h.dispatch({ type: 'activate', pane: 0 });   // e.g. the activation's z-order read chose another pane
  await until(async () => (await js(h.tabs, "document.querySelectorAll('.pane')[0].classList.contains('active')")) === true);
  const same = await js(h.tabs, 'window.__pick.isConnected');
  h.tabs.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
  check(await until(() => h.ipc.accepted === accepted + 2 && h.state.panes[0] === 't1' && h.state.active === 0, 2000),   // the press and the select
    'one click put t1 into the (new) active pane', `button kept ${same}, panes ${JSON.stringify(h.state.panes)}, active ${h.state.active}`);
  // Back to a single pane for the remaining checks.
  h.dispatch({ type: 'layout', layout: 'single' });
  check(h.state.layout === 'single' && h.state.panes[0] === 't1', 'back to a single pane: the active pane\'s content stays');
}

async function notAQuit(h, hub) {
  console.log('\n[E] lost connections, a Hub restart and other answers are not a quit');
  hub.dropSse();
  await sleep(1500);
  check(!h.win.isDestroyed(), 'SSE dropped: the shell stays open');
  const statuses = [];
  for (const [status, path, method] of [[403, '/api/shutdown', 'POST'], [500, '/api/shutdown', 'POST'], [202, '/api/shutdown', 'GET'], [202, '/api/shutdownx', 'POST']]) {
    hub.state.shutdownStatus = status;
    statuses.push(await js(h.collab, `fetch(${JSON.stringify(path)}, { method: '${method}', ${method === 'POST' ? "headers: { 'content-type': 'application/json' }, body: '{}'" : ''} }).then((r) => r.status, () => 0)`));
    await sleep(300);
    check(!h.win.isDestroyed(), `${method} ${path} answered ${status}: the shell stays open`);
  }
  check(statuses.join() === '403,500,202,202', 'each of those requests did reach the (fake) Hub', statuses.join());
  const port = hub.port;
  await hub.close();
  await sleep(800);
  const again = await fakeHub(port);
  check(await until(() => again.state.sseCount > 0, 10_000) && !h.win.isDestroyed(), 'the Hub went away and came back (the page reconnected): the shell stays open');
  return again;
}

/** What main.mjs does on 'second-instance' (shell.focus) while the shell is minimized with a docked window. */
async function secondInstance(h) {
  console.log('\n[E] a second shell brings this one back (shell.focus): only the current tab\'s bound window is restored');
  h.dispatch({ type: 'select', id: 't1' });
  const binding = h.state.tabs[0].binding?.id;
  const tabCount = h.state.tabs.length;
  h.win.minimize();
  check(await until(() => h.win.isMinimized() && h.state.minimized), 'the shell is minimized, and the docked window with it');
  const n = h.ffiCalls.length;
  h.focus();
  await until(() => !h.win.isMinimized() && h.ffiCalls.length > n + 1, 5000);
  await sleep(500);
  const seq = h.ffiCalls.slice(n).map((c) => `${c.fn}${c.cmd ? `(${c.cmd})` : ''}@0x${c.hwnd.toString(16)}`);
  console.log(`       real Electron order: ${seq.join(', ')}`);
  check(seq[0] === 'ShowWindow(9)@0xa' && seq.length >= 2 && seq.slice(1).every((s) => s === 'SetWindowPos@0xa'),
    'SW_RESTORE, then SetWindowPos, and only for the bound window', seq.join(', '));
  check(!seq.some((s) => s.startsWith('SetForegroundWindow')), 'no foreground switch');
  check(h.state.tabs.length === tabCount && h.state.tabs[0].binding?.id === binding, 'no new binding');
}

async function webQuit(h, hub) {
  console.log('\n[E] "退出 orrery" in the page (POST /api/shutdown → 202) puts windows back, then closes the shell');
  const placements = () => h.ffiCalls.filter((c) => c.fn === 'SetWindowPlacement').length;
  // A destroyed panel (whatever destroyed it) is never used: + does nothing and nothing throws.
  h.panel.destroy();
  ipcMain.emit('tabs:add', { sender: h.tabs, senderFrame: h.tabs.mainFrame }, 40);
  await sleep(300);
  check(h.strip === null && uncaught.length === 0 && !h.win.isDestroyed(), 'with its panel destroyed, + does nothing and nothing throws');
  h.dispatch({ type: 'select', id: 't1' });
  const n = placements();
  hub.state.shutdownStatus = 202;
  check(new URL(h.collab.getURL()).origin === hub.origin && (await js(h.collab, 'typeof window.__sse')) === 'object', 'on the Hub page');
  js(h.collab, "fetch('/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)");
  check(await until(() => h.win.isDestroyed(), 5000), 'the shell window closed');
  check(h.panel.isDestroyed() && BrowserWindow.getAllWindows().length === 0, 'and its + panel with it: no window left behind');
  check(placements() === n + 1, 'the docked window was put back first');
}

async function ensureAndSecondShell() {
  console.log('\n[E] --ensure: a real test Hub (temporary home and database, a free port) is started once and reused');
  const port = await freePort();
  const home = join(dir, 'home');
  const env = { ...process.env, ORRERY_HOME: home, ORRERY_DB: join(dir, 'hub.db'), ORRERY_PORT: String(port), ORRERY_API_TOKEN: API_TOKEN };
  const a = await runEnsure({ env });
  const first = await health(port);
  const b = await runEnsure({ env });
  const second = await health(port);
  check(a.origin === `http://127.0.0.1:${port}` && b.origin === a.origin, 'both runs give the same loopback origin', JSON.stringify([a.origin, b.origin]));
  check(a.page === `${a.origin}/#token=${API_TOKEN}`, 'the page address carries the API token fragment');
  check(first?.pid && second?.pid === first.pid, 'the second run reused the Hub (same pid)');
  await shutdownHub(port);
  await until(async () => !(await health(port)), 10_000);

  console.log('\n[E] a second shell only brings the first to the front: no Hub, no FFI');
  const userData = join(dir, 'single');
  const portA = await freePort();
  const envA = { ...env, ORRERY_HOME: join(dir, 'home-a'), ORRERY_DB: join(dir, 'a.db'), ORRERY_PORT: String(portA) };
  const shellA = spawn(process.execPath, [DESKTOP, `--user-data-dir=${userData}`], { env: envA, stdio: 'ignore' });
  let aExited = false;
  shellA.once('exit', () => { aExited = true; });
  check(await until(async () => !!(await health(portA)), 30_000), 'the first shell started its Hub');
  let portB = await freePort();
  while (portB === portA) portB = await freePort();
  const homeB = join(dir, 'home-b');
  const shellB = spawn(process.execPath, [DESKTOP, `--user-data-dir=${userData}`], { env: { ...envA, ORRERY_HOME: homeB, ORRERY_PORT: String(portB) }, stdio: 'ignore' });
  let bCode = null;
  shellB.once('exit', (code) => { bCode = code ?? -1; });
  check(await until(() => bCode !== null, 15_000), 'the second shell exits by itself', `exit ${bCode}`);
  await sleep(500);
  check(!existsSync(homeB) || readdirSync(homeB).length === 0, 'it never ran the launcher (its ORRERY_HOME stays empty)');
  check(!(await health(portB)), 'and no Hub listens on its port');
  check(!aExited, 'the first shell is still running');
  shellA.kill();
  await until(() => aExited);
  await shutdownHub(portA);
  await until(async () => !(await health(portA)), 10_000);
}

app.whenReady().then(async () => {   // not a top-level await: 'ready' waits for this module to finish evaluating
  console.log(`orrery desktop Electron checks, Electron ${process.versions.electron}`);
  const other = await fakeHub();
  let hub = await fakeHub(0, other.origin);
  const ffi = createFakeFfi([fakeWindow({ hwnd: 0xa })]);
  try {
    const h = startShell({ ffi, ensure: async () => ({ origin: hub.origin }), launchTarget: fakeTarget });
    h.ffiCalls = ffi.calls;
    await titleRow(h);
    await isolation(h, hub, other);
    await reloadKeys(h, hub);
    await clickAcrossRedraw(h);
    await plusStrip(h, ffi);
    await splitView(h);
    hub = await notAQuit(h, hub);
    await secondInstance(h);
    await webQuit(h, hub);
    await ensureAndSecondShell();
  } catch (e) {
    failed++;
    console.log(`  FAIL ${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    await hub.close();
    await other.close();
  }
  console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  app.exit(failed ? 1 : 0);
});
