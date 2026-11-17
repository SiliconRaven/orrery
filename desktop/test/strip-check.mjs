// When the "+" panel opens and closes (docs/desktop.md "+ 面板"), in real Electron without showing any window: `npm run
// test:strip` in desktop/. The real shell, tab bar page, preload and IPC, with the fake Win32 layer; windows are never
// shown or focused (show and focus are no-ops), so which window has the focus is set here, the way Windows would set
// it, and the panel's and the shell's blur are sent as Windows would send them. Mouse and keys go into the real pages.
// The main thread is blocked on purpose in two cases, so that the click's IPC reaches the main process late: the
// decision must not depend on when it arrives.
//
// The settings view (docs/desktop.md "应用位置") the same way: opened by the gear, its rows and actions in the real page,
// IPC from other senders and with paths refused, nothing saved without its own click. Its read-only sources are fakes
// over programs that are empty files in this check's temporary folder (this machine's Start Menu and aliases are never
// read), the file dialog is a stub and shell.openPath a recorder: nothing is started, no dialog shows.
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { APPS } from '../lib/apps.mjs';
import { startShell } from '../shell.mjs';
import { createFakeFfi, fakeWindow } from './fake-ffi.mjs';
import { checkTempDir } from './temp-dir.mjs';

const dir = checkTempDir('orrery-desktop-strip-');   // deleted after this process exits (temp-dir.mjs)
app.setPath('userData', join(dir, 'shell'));
app.on('window-all-closed', () => { /* the check closes the shell itself */ });
BrowserWindow.prototype.show = function show() { /* never shown */ };
BrowserWindow.prototype.focus = function focus() { /* never focused */ };
const launched = [];
shell.openPath = async (...args) => { launched.push(args); return ''; };   // never starts anything
const dialogs = [];
let dialogAnswer = { canceled: true, filePaths: [] };
dialog.showOpenDialog = async (...args) => { dialogs.push(args); return dialogAnswer; };   // never shows a dialog

/** Fake programs: empty files under this check's temporary folder. */
const program = (...parts) => {
  const p = join(dir, 'programs', ...parts);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '');
  return p;
};
const KIMI = program('Kimi Code', 'Kimi Code.exe');
const KIMI_OTHER = program('Portable', 'Kimi Code.exe');
const ZCODE = program('ZCode', 'ZCode.exe');
const AG1 = program('ag1', 'Antigravity.exe');
const AG2 = program('ag2', 'Antigravity.exe');
const CALC = program('calc', 'calc.exe');
const WB1 = program('wb', 'WorkBuddy.exe');
/** The read-only sources, faked: one Start Menu shortcut (Kimi Code), no aliases; files and lstat are real (temp files). */
const sources = () => ({
  localAppData: '',
  readAlias: () => null,
  isFile: (p) => existsSync(p),
  shortcuts: () => [{ target: KIMI, args: '' }],
  lstat: (p) => { try { const st = lstatSync(p); return { file: st.isFile(), link: st.isSymbolicLink() }; } catch { return null; } },
});
const appPaths = () => { try { return JSON.parse(readFileSync(join(dir, 'shell', 'app-paths.json'), 'utf8')).apps; } catch { return null; } };
let failed = 0;
const uncaught = [];
process.on('uncaughtException', (e) => { uncaught.push(e.message); failed++; console.log(`  FAIL uncaught in the main process: ${e.stack}`); });
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(20); return cond(); };
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);   // the main thread does nothing meanwhile

app.whenReady().then(async () => {
  console.log(`orrery desktop + panel checks (hidden), Electron ${process.versions.electron}`);
  const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>hub</title><body>hub</body>'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const ffi = createFakeFfi([]);
  // The "+" panel's and the settings view's pages are loaded only when this check says so: each is
  // opened first, its state sent before its page listens, and the page must still show it once loaded.
  const held = new Map();
  const realLoad = BrowserWindow.prototype.loadURL;
  BrowserWindow.prototype.loadURL = function loadURL(url, ...rest) {
    const page = /\/ui\/(strip|settings)\.html$/.exec(String(url))?.[1];
    if (!page || held.has(page)) return realLoad.call(this, url, ...rest);
    held.set(page, () => realLoad.call(this, url, ...rest));
    return Promise.resolve();
  };
  const h = startShell({ ffi, ensure: async () => ({ origin: `http://127.0.0.1:${server.address().port}` }), sources });
  BrowserWindow.prototype.loadURL = realLoad;
  // Which window has the focus, as Windows would have it: 'shell', 'panel', 'settings' or null (another app, a docked window).
  let focus = null;
  h.win.isFocused = () => focus === 'shell';
  h.panel.isFocused = () => focus === 'panel';
  h.settingsWin.isFocused = () => focus === 'settings';
  const moveFocus = (to) => {   // the blur of the window that had it, as Windows sends it
    const from = focus;
    focus = to;
    if (from === 'panel') h.panel.emit('blur');
    if (from === 'shell') h.win.emit('blur');
    if (from === 'settings') h.settingsWin.emit('blur');
  };
  try {
    await until(() => h.hub.status === 'ready' && !h.tabs.isLoading(), 10_000);
    await sleep(300);
    console.log('\n[pages] opened before their page has loaded, the + panel and the settings view still show their state');
    const fromBar = { sender: h.tabs, senderFrame: h.tabs.mainFrame };
    for (const [page, wc, openIt, isOpen, count, close] of [
      ['strip', h.strips, () => ipcMain.emit('tabs:add', fromBar, 60), () => h.strip !== null, "document.querySelectorAll('#apps .app').length", () => ipcMain.emit('strip:close', { sender: h.strips, senderFrame: h.strips.mainFrame })],
      ['settings', h.settingsPage, () => ipcMain.emit('tabs:settings', fromBar, 120), () => h.settings !== null, "document.querySelectorAll('#rows .row').length", () => ipcMain.emit('settings:close', { sender: h.settingsPage, senderFrame: h.settingsPage.mainFrame })],
    ]) {
      openIt();
      check(isOpen() && wc.getURL() === '', `${page}: opened while its page is not loaded yet (its state went nowhere)`);
      held.get(page)();
      await until(() => wc.getURL().endsWith(`${page}.html`) && !wc.isLoading(), 5000);
      await sleep(300);
      const n = await wc.executeJavaScript(count);
      check(n === APPS.length, `${page}: once loaded, its state is sent again and drawn`, `${n} of ${APPS.length}`);
      close();
      await sleep(100);
      check(!isOpen(), `${page}: closed again`);
    }
    const center = (wc, sel) => wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const plus = await center(h.tabs, '#add');
    const down = (wc, at) => { wc.sendInputEvent({ type: 'mouseMove', ...at }); wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 }); };
    const up = (wc, at) => wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
    const open = () => h.strip !== null;
    const settle = () => sleep(250);
    // A click on +, as the user makes it: the press activates the shell (the panel, if it had the focus, loses it).
    const pressPlus = async (holdMs, { blockMs = 0 } = {}) => {
      down(h.tabs, plus);
      moveFocus('shell');
      await sleep(holdMs);
      up(h.tabs, plus);
      if (blockMs) block(blockMs);   // the click's IPC waits in the main process's queue
      await settle();
    };
    const openPanel = async () => {
      await pressPlus(40);
      if (open()) moveFocus('panel');   // the panel takes the focus when it shows
      return open();
    };

    console.log('\n[+] a click on + toggles the panel; a press on + while it is open closes it, however long or late');
    check(await openPanel(), 'a click on + opens it');
    await pressPlus(550, { blockMs: 350 });
    check(!open() && !uncaught.length, 'held 0.55 s while the main process was busy 0.35 s: closed, not reopened');
    check(await openPanel(), 'one click opens it again');
    await pressPlus(80, { blockMs: 350 });
    check(!open(), 'a quick click while the main process was busy 0.35 s: closed, not reopened');
    check(await openPanel(), 'one click opens it again');
    await pressPlus(700);
    check(!open(), 'held 0.7 s, delivered at once: closed');
    check(await openPanel(), 'one click opens it again');
    await pressPlus(60);
    check(!open(), 'a quick click: closed');

    console.log('\n[+] the focus moving between the shell and the panel leaves it open; leaving both closes it');
    check(await openPanel(), 'opened');
    moveFocus('shell');   // e.g. a press on the empty title row, which the page never sees
    await settle();
    check(open(), 'the shell takes the focus (a press on its title row): still open');
    moveFocus(null);   // Alt+Tab to another app
    await settle();
    check(!open(), 'the focus leaves the shell too (another app): closed');
    check(await openPanel(), 'one click opens it again');
    moveFocus(null);   // a click on a docked app window
    await settle();
    check(!open(), 'the panel loses the focus to a docked window: closed');

    console.log('\n[+] a press elsewhere in the shell closes it');
    check(await openPanel(), 'opened');
    const tab = await center(h.tabs, '.tab .pick');
    down(h.tabs, tab);
    moveFocus('shell');
    up(h.tabs, tab);
    await settle();
    check(!open(), 'a click on a tab in the tab bar: closed');
    check(await openPanel(), 'one click opens it again');
    h.collab.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    moveFocus('shell');
    h.collab.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    await settle();
    check(!open(), 'a click in the collaboration page: closed');
    check(await openPanel(), 'one click opens it again');
    h.win.emit('minimize');
    check(!open(), 'the shell minimized: closed');
    check(await openPanel(), 'one click opens it again');
    h.win.emit('hide');
    check(!open(), 'the shell hidden: closed');

    console.log('\n[+] keyboard');
    focus = 'shell';
    await h.tabs.executeJavaScript("document.getElementById('add').focus(); true");
    for (const type of ['keyDown', 'char', 'keyUp']) h.tabs.sendInputEvent({ type, keyCode: 'Return' });
    await settle();
    check(open(), 'Enter on + opens it');
    moveFocus('panel');
    for (const type of ['keyDown', 'keyUp']) h.strips.sendInputEvent({ type, keyCode: 'Escape' });
    await settle();
    check(!open(), 'Escape in the panel closes it');

    console.log('\n[+] the panel\'s IPC stays narrow');
    const before = { ...h.ipc };
    const bar = { sender: h.tabs, senderFrame: h.tabs.mainFrame };
    const reject = [['tabs:add', bar, { x: 60, press: 550 }], ['tabs:add', bar, { x: 60 }], ['tabs:add', bar, '60'], ['tabs:add', bar, 60, 1],
      ['tabs:press', bar, 1], ['tabs:press', { sender: h.collab, senderFrame: h.collab.mainFrame }], ['tabs:press', { sender: h.strips, senderFrame: h.strips.mainFrame }]];
    for (const [channel, event, ...args] of reject) ipcMain.emit(channel, event, ...args);
    check(h.ipc.rejected === before.rejected + reject.length && h.ipc.accepted === before.accepted && !open(),
      'refused: tabs:add with anything but one finite number, tabs:press with an argument or from another page', `${h.ipc.rejected - before.rejected} of ${reject.length}`);

    await settingsView({ h, ffi, center, down, up, settle, open, openPanel, moveFocus });
    check(BrowserWindow.getAllWindows().every((w) => !w.isVisible()) && uncaught.length === 0, 'no window was shown; nothing thrown');
    check(launched.length === 0, 'nothing was started', JSON.stringify(launched));
  } catch (e) {
    failed++;
    console.log(`  FAIL ${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    h.dispatch({ type: 'quit' });
    if (!h.win.isDestroyed()) h.win.destroy();
    server.close();
  }
  console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  app.exit(failed ? 1 : 0);
});

/** The settings view (docs/desktop.md "应用位置"), in the real pages with the fake sources above. */
async function settingsView({ h, ffi, center, down, up, settle, open, openPanel, moveFocus }) {
  console.log('\n[settings] the gear opens the app locations view, like the + panel');
  const shown = () => h.settings !== null;
  const js = (code) => h.settingsPage.executeJavaScript(code);
  const press = (sel) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  const row = (id) => h.settings?.find((r) => r.id === id);
  const statuses = () => js("[...document.querySelectorAll('#rows .row')].map((r) => r.dataset.status).join()");
  const message = (id) => js(`document.querySelector('#rows .row[data-app="${id}"] .message')?.textContent ?? ''`);
  const gear = await center(h.tabs, '#settings');
  const clickGear = async () => { down(h.tabs, gear); moveFocus('shell'); up(h.tabs, gear); await settle(); if (shown()) moveFocus('settings'); };
  await until(() => !h.settingsPage.isLoading());
  const probe = await js('({ require: typeof require, process: typeof process, api: Object.keys(window.orrery ?? {}).join() })');
  check(probe.require === 'undefined' && probe.process === 'undefined' && probe.api === 'onState,detect,use,pick,clear,close',
    'its page: sandboxed, no node; its preload exposes onState, detect, use, pick, clear and close only', JSON.stringify(probe));
  check(await openPanel(), 'the + panel open first');
  await clickGear();
  check(shown() && !open() && await h.tabs.executeJavaScript("document.getElementById('settings').getAttribute('aria-expanded')") === 'true',
    'a click on the gear opens the view and closes the + panel; the gear says it is expanded');
  const expected = APPS.map((a) => (a.id === 'kimi-code' ? 'shortcut' : 'missing')).join();
  await settle();
  check(await statuses() === expected, 'one row per supported app: Kimi Code found by its shortcut, the rest not found', await statuses());
  check(await js("document.querySelector('#rows .row[data-status=\"shortcut\"] .path.use').title") === KIMI, 'the path in use, whole in its tooltip');
  check(await js("[...document.querySelectorAll('#rows .row')].slice(0, 2).every((r) => !r.querySelector('[data-focus$=\":pick\"]') && r.textContent.includes('应用商店'))"),
    'Claude and ChatGPT / Codex (MSIX): no 选择程序, a note instead');
  check(appPaths() === null && launched.length === 0, 'opening it saves nothing, starts nothing');

  console.log('\n[settings] 自动检测 offers a running window\'s program; only 使用这个位置 saves it');
  ffi.add(fakeWindow({ hwnd: 0x51, pid: 5100, exePath: ZCODE, title: 'ZCode' }));
  await press('[data-focus="zcode:detect"]');
  check(await until(() => row('zcode')?.offer?.path === ZCODE) && row('zcode').status === 'window', 'ZCode: its running window\'s program is offered', JSON.stringify(row('zcode')));
  check(appPaths() === null, 'not saved yet');
  // Other senders, and a path in place of an app id, are refused; nothing is saved by them.
  const before = { ...h.ipc };
  const from = (wc) => ({ sender: wc, senderFrame: wc.mainFrame });
  const page = from(h.settingsPage);
  const sub = { sender: h.settingsPage, senderFrame: { parent: h.settingsPage.mainFrame, processId: h.settingsPage.mainFrame.processId, routingId: -1, url: h.settingsPage.getURL() } };
  const reject = [
    ['settings:use', from(h.tabs), 'zcode'], ['settings:use', from(h.strips), 'zcode'], ['settings:use', from(h.collab), 'zcode'], ['settings:use', sub, 'zcode'],
    ['settings:pick', from(h.collab), 'kimi-code'], ['settings:clear', from(h.tabs), 'kimi-code'], ['settings:detect', from(h.strips), 'zcode'], ['settings:close', from(h.collab)],
    ['settings:use', page, ZCODE], ['settings:use', page, 'zcode', ZCODE], ['settings:pick', page, CALC], ['settings:pick', page, { id: 'kimi-code', path: CALC }],
    ['settings:use', page, 'calc'], ['settings:clear', page], ['settings:close', page, 'x'],
    ['tabs:settings', page, 10], ['tabs:settings', from(h.tabs), 'zcode'], ['tabs:settings', from(h.collab), 10], ['strip:pick', page, 'zcode'], ['tabs:select', page, 'orrery'],
  ];
  for (const [channel, event, ...args] of reject) ipcMain.emit(channel, event, ...args);
  check(h.ipc.rejected === before.rejected + reject.length && h.ipc.accepted === before.accepted && appPaths() === null && shown(),
    'refused: the tab bar, the + panel, the collaboration page and a subframe on its channels, paths instead of app ids, extra arguments, and its page on others\' channels',
    `rejected ${h.ipc.rejected - before.rejected} of ${reject.length}`);
  await press('[data-focus="zcode:use"]');
  check(await until(() => appPaths()?.zcode?.path === ZCODE) && appPaths().zcode.source === 'detected' && row('zcode')?.status === 'saved',
    '使用这个位置: saved as detected, the row says so', JSON.stringify(appPaths()));
  h.dispatch({ type: 'layout', layout: 'columns' });   // a change, so that the state file is written now
  await until(() => existsSync(join(dir, 'shell', 'desktop-state.json')), 2000);
  h.dispatch({ type: 'layout', layout: 'single' });
  const state = readFileSync(join(dir, 'shell', 'desktop-state.json'), 'utf8');
  check(!state.includes('ZCode') && !/path/i.test(state), 'desktop-state.json holds no path');

  console.log('\n[settings] 使用这个位置 saves only the offer the view showed, by the token the main process gave it');
  const use = (app, token) => ipcMain.emit('settings:use', page, { app, token });
  const tokenOf = (id) => row(id)?.offer?.token;
  const ag = ffi.add(fakeWindow({ hwnd: 0x52, pid: 5200, exePath: AG1, title: 'Antigravity' }));
  await press('[data-focus="antigravity:detect"]');
  await until(() => row('antigravity')?.offer?.path === AG1);
  const t1 = tokenOf('antigravity');
  const pageToken = await js("document.querySelector('[data-focus=\"antigravity:use\"]') ? 'shown' : 'none'");
  check(/^[0-9a-f-]{36}$/.test(t1 ?? '') && pageToken === 'shown', 'the offer is shown with a token the main process made', t1);
  // The reviewer's sequence: another program of the same name runs now; a detect for another app refreshes every row
  // (antigravity's offer becomes AG2, with a new token); then the old page's queued click arrives with the old token.
  ag.exePath = AG2;
  ipcMain.emit('settings:detect', page, 'zcode');
  const t2 = tokenOf('antigravity');
  check(row('antigravity')?.offer?.path === AG2 && t2 && t2 !== t1, 'after the refresh: AG2 offered with a new token');
  use('antigravity', t1);
  await settle();
  check(appPaths().antigravity === undefined && row('antigravity')?.offer?.path === AG2 && /变了/.test(await message('antigravity')),
    'the old click (old token, after the refresh): nothing saved; the current offer is shown again with a message');
  const t3 = tokenOf('antigravity');
  check(t3 && t3 !== t2, 'the token held when that click came is spent: the view gets a new one for the same offer');
  use('antigravity', t2);
  await settle();
  check(appPaths().antigravity === undefined, 'the token that was current before the stale click is spent too: nothing saved');
  // A token of one app sent for another, a replayed one, a made-up one, and a wrong shape: nothing saved.
  const wb = ffi.add(fakeWindow({ hwnd: 0x53, pid: 5300, exePath: WB1, title: 'WorkBuddy' }));
  await press('[data-focus="workbuddy:detect"]');
  await until(() => !!tokenOf('workbuddy'));
  const ipcBefore = { ...h.ipc };
  for (const bad of [{ app: 'zcode', token: tokenOf('workbuddy') }, { app: 'workbuddy', token: tokenOf('antigravity') }]) ipcMain.emit('settings:use', page, bad);
  ipcMain.emit('settings:use', page, { app: 'antigravity', token: '00000000-0000-4000-8000-000000000000' });
  for (const bad of [{ app: 'antigravity', token: tokenOf('antigravity'), path: AG2 }, { app: 'antigravity', token: tokenOf('antigravity')?.toUpperCase() }, { app: 'antigravity' }, [ 'antigravity', tokenOf('antigravity') ]]) ipcMain.emit('settings:use', page, bad);
  await settle();
  const after = appPaths();
  check(after.zcode?.path === ZCODE && after.workbuddy === undefined && after.antigravity === undefined && h.ipc.rejected === ipcBefore.rejected + 4,
    'another app\'s token, a made-up token: refused at the check; a path, an upper-case token, a missing token or an array: refused by the IPC check', `rejected ${h.ipc.rejected - ipcBefore.rejected}`);
  // Two quick clicks with the current token: the first saves, the second is a replay and saves nothing more.
  const t4 = tokenOf('antigravity');
  use('antigravity', t4);
  const firstSaved = appPaths()?.antigravity?.path;
  use('antigravity', t4);
  await settle();
  check(firstSaved === AG2 && appPaths().antigravity?.path === AG2 && row('antigravity')?.status === 'saved', 'two quick clicks: the first saves AG2, the replay changes nothing');
  // Close and open again: every token shown before is void.
  const tw = tokenOf('workbuddy');
  ipcMain.emit('settings:close', page);
  await clickGear();
  check(shown() && tokenOf('workbuddy') && tokenOf('workbuddy') !== tw, 'opened again: the same offer has a new token');
  use('workbuddy', tw);
  await settle();
  check(appPaths().workbuddy === undefined, 'a click with a token from before the view closed saves nothing');
  // The real click in the page uses the token it was given: saved.
  await press('[data-focus="workbuddy:use"]');
  check(await until(() => appPaths()?.workbuddy?.path === WB1), 'the page\'s own click with the current token saves WorkBuddy');
  ffi.windows.delete(wb.hwnd);

  console.log('\n[settings] 选择程序…: the main process\'s own dialog; its answer is checked before it is saved');
  dialogAnswer = { canceled: false, filePaths: [CALC] };
  await press('[data-focus="kimi-code:pick"]');
  await until(() => dialogs.length === 1);
  await settle();
  const opts = dialogs[0]?.[1];
  check(dialogs[0]?.[0] === h.settingsWin && opts?.filters?.[0]?.extensions.join() === 'exe' && opts.properties.includes('openFile'), 'one dialog, owned by the view, for .exe files', JSON.stringify(opts));
  const kimiMsg = await message('kimi-code');
  check(appPaths()['kimi-code'] === undefined && /文件名不是 Kimi Code\.exe/.test(kimiMsg), 'another program picked: refused with the reason, nothing saved', kimiMsg);
  dialogAnswer = { canceled: true, filePaths: [] };
  await press('[data-focus="kimi-code:pick"]');
  await settle();
  check(appPaths()['kimi-code'] === undefined, 'cancelled: nothing saved');
  dialogAnswer = { canceled: false, filePaths: [KIMI_OTHER] };
  await press('[data-focus="kimi-code:pick"]');
  check(await until(() => appPaths()?.['kimi-code']?.path === KIMI_OTHER) && appPaths()['kimi-code'].source === 'picked' && row('kimi-code')?.inUse?.path === KIMI_OTHER,
    'its own program picked: saved as picked and in use (before the Start Menu shortcut)');

  console.log('\n[settings] the + panel follows a valid saved path; a path gone since is ignored, shown as 已失效, cleared on request');
  ffi.windows.delete(0x51);   // ZCode no longer runs
  ffi.windows.delete(0x52);
  moveFocus('shell');
  await clickGear();   // closes it
  check(!shown(), 'the gear again closes it');
  check(await openPanel() && h.strip.find((e) => e.id === 'zcode')?.status === 'launch', 'the + panel: ZCode startable from its saved path', JSON.stringify(h.strip.find((e) => e.id === 'zcode')));
  renameSync(ZCODE, `${ZCODE}.old`);   // deleted or renamed after it was saved
  await clickGear();
  check(shown() && !open() && row('zcode')?.status === 'invalid' && /不存在/.test(row('zcode').saved.reason) && appPaths().zcode?.path === ZCODE,
    'the view shows it as 已失效 with the reason; the entry is kept', JSON.stringify(row('zcode')));
  moveFocus('shell');
  await clickGear();
  check(await openPanel() && h.strip.find((e) => e.id === 'zcode')?.status === 'missing', 'the + panel: ZCode no longer startable');
  await clickGear();
  await press('[data-focus="zcode:clear"]');
  await settle();
  check(appPaths().zcode?.path === ZCODE && await js("!!document.querySelector('[data-focus=\"zcode:confirm\"]')"), '清除 asks first; nothing removed yet');
  await press('[data-focus="zcode:confirm"]');
  check(await until(() => appPaths() && appPaths().zcode === undefined) && appPaths()['kimi-code']?.path === KIMI_OTHER && row('zcode')?.status === 'missing',
    'confirmed: only that entry removed', JSON.stringify(appPaths()));

  console.log('\n[settings] closing: Escape, a press elsewhere, the focus leaving, the shell moving');
  for (const type of ['keyDown', 'keyUp']) h.settingsPage.sendInputEvent({ type, keyCode: 'Escape' });
  await settle();
  check(!shown(), 'Escape closes it');
  await clickGear();
  const tab = await center(h.tabs, '.tab .pick');
  down(h.tabs, tab); moveFocus('shell'); up(h.tabs, tab);
  await settle();
  check(!shown(), 'a click on a tab closes it');
  await clickGear();
  moveFocus(null);
  await settle();
  check(!shown(), 'the focus leaving the shell and the view closes it');
  await clickGear();
  h.win.emit('move');
  check(!shown(), 'the shell moving closes it');
  await clickGear();
  h.settingsWin.close();
  await settle();
  check(!shown() && !h.settingsWin.isDestroyed(), 'its own close only closes it');
  check(launched.length === 0, 'none of this started anything');
}
