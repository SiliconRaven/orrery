// Win32 check (docs/desktop.md test F). Run in desktop/ with ORRERY_DESKTOP_WIN32=1: `npm run test:win32`.
// Runs in Electron's main process, which is per-monitor DPI aware like the shell, and drives the real lib/win32.mjs
// through the shell's reducer and writer. It only ever touches test windows it started itself (a PowerShell WinForms
// window titled "orrery-desktop-test <nonce>"), and checks that before every step: never another window.
// Results go to stdout and to the log file named by ORRERY_DESKTOP_WIN32_LOG (default: a file in the
// check's temp directory, which is deleted after the check exits unless ORRERY_KEEP_TEST_TEMP=1).
import { app, screen } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ORRERY } from '../lib/dock.mjs';
import { PANE_GAP, dockArea, fromRECT, paneRects, toPhysical } from '../lib/geometry.mjs';
import { listCandidates, observe } from '../lib/windows.mjs';
import { ffi } from '../lib/win32.mjs';
import { BAR, startShell } from '../shell.mjs';
import { miniShell, recording } from './mini-shell.mjs';
import { startTestWindow } from './test-window.mjs';
import { checkTempDir } from './temp-dir.mjs';

if (process.env.ORRERY_DESKTOP_WIN32 !== '1') {
  console.log('Win32 check skipped: set ORRERY_DESKTOP_WIN32=1 to run it (it opens and moves its own test windows).');
  process.exit(0);
}
const dir = checkTempDir('orrery-desktop-win32-');   // deleted after this process exits (temp-dir.mjs)
app.setPath('userData', join(dir, 'electron'));
app.on('window-all-closed', () => { /* the z-order check closes its shell window; the check goes on */ });
const logFile = process.env.ORRERY_DESKTOP_WIN32_LOG || join(dir, 'win32-check.log');
const log = (line) => { console.log(line); appendFileSync(logFile, `${line}\n`); };

const APPS = [{ id: 'test', name: 'test window', exe: 'powershell.exe' }];
const R1 = { x: 300, y: 260, width: 900, height: 640 };
const R2 = { x: 420, y: 320, width: 1100, height: 720 };
const started = [];
let failed = 0;

const frame = (hwnd) => fromRECT(ffi.getExtendedFrameBounds(hwnd));
const near = (a, b, tol = 2) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tol);
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(30); return cond(); };

/** Starts a test window and makes sure the handle really is ours before anything else happens. */
async function ours(state, options = {}) {
  const win = await startTestWindow(dir, { state, ...options });
  started.push(win);
  await until(() => win.last?.state === state);
  const o = observe(ffi, win.hwnd);
  if (!o.ok || o.window.pid !== win.pid || o.window.title !== win.title) throw new Error(`0x${win.hwnd.toString(16)} is not our test window`);
  return win;
}

function bindShell(win, rect = R1) {
  const rec = recording(ffi);
  const shell = miniShell(rec.ffi, { apps: APPS, rect });
  const [candidate] = shell.candidates((c) => c.hwnd === win.hwnd && c.pid === win.pid && c.title === win.title);
  return { rec, shell, candidate };
}

const state = (hwnd) => ({ iconic: ffi.isIconic(hwnd), zoomed: ffi.isZoomed(hwnd) });
const writesOf = (rec, from) => rec.calls.slice(from).map((c) => `${c.fn}${c.fn === 'showWindow' ? `(${c.args[0]})` : ''}`);

async function originalStates() {
  for (const original of ['Normal', 'Maximized', 'Minimized']) {
    log(`\n[F] dock and put back a ${original.toLowerCase()} window`);
    const win = await ours(original);
    const h = win.hwnd;
    const before = ffi.getWindowPlacement(h);
    const was = state(h);
    const { rec, shell, candidate } = bindShell(win);
    check(!!candidate, 'the test window is in the choice list');
    shell.dispatch({ type: 'add', candidate });
    check(!ffi.isIconic(h) && !ffi.isZoomed(h) && near(frame(h), R1), 'docked: normal state, visible frame = dock area', JSON.stringify(frame(h)));
    log(`       writes on add: ${writesOf(rec, 0).join(', ')}; foreground ${rec.calls.find((c) => c.fn === 'setForegroundWindow')?.result ? 'granted' : 'refused by Windows (allowed, not retried)'}`);

    let n = rec.calls.length;
    shell.rect = R2;
    shell.dispatch({ type: 'bounds' });
    check(near(frame(h), R2), 'follows a move and resize', JSON.stringify(frame(h)));
    check(writesOf(rec, n).every((w) => w === 'setWindowPos'), 'following uses SetWindowPos only', writesOf(rec, n).join(', '));
    n = rec.calls.length;
    shell.dispatch({ type: 'minimize' });
    check(ffi.isIconic(h), 'minimized with the orrery window');
    shell.dispatch({ type: 'restore' });
    check(!ffi.isIconic(h) && near(frame(h), R2), 'restored with the orrery window');
    shell.dispatch({ type: 'select', id: ORRERY });
    check(ffi.isIconic(h), 'the orrery tab minimizes it');
    shell.dispatch({ type: 'select', id: 't1' });
    check(!ffi.isIconic(h) && near(frame(h), R2), 'selecting its tab docks it again');
    shell.dispatch({ type: 'close', id: 't1' });
    const after = ffi.getWindowPlacement(h);
    check(after.showCmd === before.showCmd && JSON.stringify(after.rcNormalPosition) === JSON.stringify(before.rcNormalPosition),
      'closing the tab puts back the recorded placement', `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    check(JSON.stringify(state(h)) === JSON.stringify(was), `back to ${original.toLowerCase()}`, JSON.stringify(state(h)));
    await sleep(400);
    check(win.last.text === win.text && !win.exited, 'the test process and its unsaved input are untouched');
    win.stop();
  }
}

async function moveAcrossDisplays() {
  const displays = screen.getAllDisplays();
  log(`\n[F] displays: ${displays.map((d) => `${d.bounds.width}x${d.bounds.height} DIP @${d.scaleFactor * 100}%`).join(', ')}`);
  if (displays.length < 2) { log('  n/a  moving to another display: only one display here (unverified)'); return; }
  const win = await ours('Normal');
  const { shell, candidate } = bindShell(win);
  shell.dispatch({ type: 'add', candidate });
  const d = displays[1];
  const px = screen.dipToScreenRect(null, d.bounds);
  shell.rect = { x: px.x + 50, y: px.y + 50, width: 800, height: 600 };
  shell.dispatch({ type: 'bounds' });
  check(near(frame(win.hwnd), shell.rect), `follows onto display 2 (${d.scaleFactor * 100}%)`, JSON.stringify(frame(win.hwnd)));
  shell.dispatch({ type: 'close', id: 't1' });
  win.stop();
}

async function identityLost() {
  log('\n[F] identity no longer matches');
  const win = await ours('Normal');
  const { rec, shell, candidate } = bindShell(win);
  shell.dispatch({ type: 'add', candidate });
  const binding = shell.state.tabs[0].binding;
  const n = rec.calls.length;
  const at = frame(win.hwnd);
  for (const [what, b] of [['another pid', { ...binding, pid: binding.pid + 1 }], ['another class', { ...binding, className: 'X' }],
    ['another image path', { ...binding, exePath: 'C:\\Elsewhere\\powershell.exe' }]]) {
    const r = shell.writer.write({ op: 'place', tab: 't1', binding: b, trigger: 'bounds', rect: R2, raise: false });
    check(r.status === 'lost', `${what}: refused as lost`, r.reason);
  }
  check(rec.calls.length === n && near(frame(win.hwnd), at), 'zero writes, the window did not move');
  win.stop();
  await until(() => !ffi.isWindow(win.hwnd));
  shell.dispatch({ type: 'bounds' });
  shell.dispatch({ type: 'select', id: 't1' });
  check(rec.calls.length === n, 'after the window is gone: zero writes');
  check(shell.state.tabs[0].binding === null, 'the tab needs a new pick', shell.notices.at(-1));
}

async function unresponsive() {
  log('\n[F] a target window that stops responding for 6 s');
  const win = await ours('Normal');
  const { rec, shell, candidate } = bindShell(win);
  shell.dispatch({ type: 'add', candidate });
  win.command('hang 6000');
  await until(() => win.lines.some((l) => l.line === 'hang|start'));
  const hungAt = Date.now();
  await sleep(300);
  const timed = (label, fn) => {
    const t = Date.now();
    fn();
    log(`       ${label}: returned after ${Date.now() - t} ms (${Date.now() - hungAt} ms into the hang)`);
  };
  let n = rec.calls.length;
  shell.rect = R2;
  timed('follow (SetWindowPos)', () => shell.dispatch({ type: 'bounds' }));
  log(`       calls: ${rec.calls.slice(n).map((c) => `${c.fn} ${c.ms} ms → ${c.result}`).join('; ')}`);
  n = rec.calls.length;
  timed('minimize (ShowWindow)', () => shell.dispatch({ type: 'minimize' }));
  timed('restore (ShowWindow + SetWindowPos)', () => shell.dispatch({ type: 'restore' }));
  timed('close tab (SetWindowPlacement)', () => shell.dispatch({ type: 'close', id: 't1' }));
  log(`       calls: ${rec.calls.slice(n).map((c) => `${c.fn} ${c.ms} ms → ${c.result}`).join('; ')}`);
  await until(() => win.lines.some((l) => l.line === 'hang|end'), 10_000);
  await sleep(500);
  check(!win.exited && ffi.isWindow(win.hwnd) && win.last.text === win.text, 'after the hang: the window, its process and its input are intact');
  const blocked = rec.calls.some((c) => c.ms > 1000);
  log(`  note ${blocked ? 'synchronous calls to a hung window WAIT until it responds; the shell stalls meanwhile (reported, not worked around)' : 'no call blocked for more than 1 s'}`);
  win.stop();
}

/** Starts the stand-in shell as its own Electron process and lets it dock the window. */
async function host(win, rect) {
  const outFile = join(dir, `host-${win.pid}.out`);
  const quitFile = join(dir, `host-${win.pid}.quit`);
  const child = spawn(process.execPath, [join(import.meta.dirname, 'win32-host.mjs'), `--user-data-dir=${join(dir, `host-${win.pid}`)}`], {
    env: { ...process.env, ORRERY_TEST_HWND: String(win.hwnd), ORRERY_TEST_PID: String(win.pid), ORRERY_TEST_TITLE: win.title,
      ORRERY_TEST_RECT: JSON.stringify(rect), ORRERY_TEST_OUT: outFile, ORRERY_TEST_QUIT: quitFile },
    stdio: 'ignore',
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const out = () => (existsSync(outFile) ? readFileSync(outFile, 'utf8') : '');
  await until(() => /docked|no-candidate|not-docked/.test(out()), 20_000);
  return { child, out, exited: () => exited, quit: () => writeFileSync(quitFile, 'quit') };
}

async function hostEnds() {
  log('\n[F] the shell process is killed while a window is docked');
  const win = await ours('Normal');
  const hostA = await host(win, R1);
  check(/^docked/m.test(hostA.out()) && near(frame(win.hwnd), R1), 'the stand-in shell docked the window', hostA.out().trim());
  const before = win.last.at;
  hostA.child.kill();
  await until(hostA.exited);
  await sleep(1000);
  const o = observe(ffi, win.hwnd);
  check(hostA.exited() && !win.exited && o.ok, 'after the kill: the test process and its window still exist');
  check(o.ok && o.window.visible && !o.window.owner && !(o.window.exStyle & 0x80), 'still visible, no owner, not a tool window (keeps its taskbar entry)');
  check(win.last.at > before && win.last.text === win.text, 'still responding, unsaved input intact', win.last.text);
  check(near(frame(win.hwnd), R1), 'it stays where it was docked (no restore after a crash)');
  win.stop();

  log('\n[F] the shell closes normally while a maximized window is docked');
  const max = await ours('Maximized');
  const hostB = await host(max, R1);
  check(/^docked/m.test(hostB.out()) && !ffi.isZoomed(max.hwnd), 'docked (no longer maximized)');
  hostB.quit();
  await until(hostB.exited, 10_000);
  check(/restored/.test(hostB.out()) && ffi.isZoomed(max.hwnd), 'put back maximized on close', hostB.out().trim());
  check(max.last.text === max.text && !max.exited, 'input intact');
  max.stop();
}

/**
 * The docked window must stay above the shell window (the real shell.mjs window, two of my own test windows). A user
 * clicking the shell while it is already the active window (the usual state: the docked window is raised without
 * being activated) brings the shell to the top on mouse-down, with no new 'focus' event; so does pressing on the
 * tab bar row or a border to drag or resize it. Approximations used here, without real mouse input: a click on the
 * inactive shell = the foreground test window allows it and the shell activates itself; a press on the active shell =
 * win.moveTop() (the same z-order change, only possible while the shell is the foreground window); a drag or resize =
 * that press, then setPosition / setSize, then the press again (Windows' modal move and size loops are not entered).
 */
async function zOrder() {
  log('\n[F] z-order: the docked window stays above the shell (real shell window, two test windows)');
  const server = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>fake hub</title>'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Like real apps: started through WMI (not by this process, which hosts the shell), and strict: while not the
  // foreground window they refuse z-order requests that come without activation. A stronger, explicit model of the
  // restriction in the SetWindowPos documentation, standing in for an app that does not follow; not Windows itself.
  // B waits minimized until it is added: a visible, undocked B over the dock area would be a third window between
  // the shell and A, where the shell is deliberately not lowered (see the three-window case below).
  const A = await ours('Normal', { unrelated: true, strict: true });
  const B = await ours('Minimized', { unrelated: true, strict: true });
  const rec = recording(ffi);   // the shell's Win32 writes, for the log
  const h = startShell({ ffi: rec.ffi, ensure: async () => ({ origin }), apps: APPS });
  try {
    await new Promise((ok) => (h.win.isVisible() ? ok() : h.win.once('show', ok)));
    await sleep(800);
    const shellHwnd = Number(h.win.getNativeWindowHandle().readBigUInt64LE(0));
    const z = (w) => {
      if (ffi.isIconic(w.hwnd)) return 'minimized';
      const order = ffi.enumWindows();
      return order.indexOf(w.hwnd) < order.indexOf(shellHwnd) ? 'above' : 'BELOW';
    };
    const dockRect = () => {
      const display = screen.getDisplayMatching(h.win.getBounds());
      return toPhysical(dockArea(h.win.getContentBounds(), BAR), { dip: display.bounds, px: screen.dipToScreenRect(null, display.bounds), scale: display.scaleFactor });
    };
    const cand = (w) => listCandidates(ffi, { apps: APPS, exclude: h.state.tabs.flatMap((t) => (t.binding ? [t.binding.hwnd] : [])) })
      .find((c) => c.hwnd === w.hwnd && c.pid === w.pid);
    const settle = () => sleep(400);
    const step = async (what, fn, expect) => {
      await fn();
      const right = `A ${z(A)}, B ${z(B)}`;
      await settle();
      check(expect(), what, `right after: ${right}; after 400 ms: A ${z(A)}, B ${z(B)}; bring-to-top requests ignored so far: A ${A.last.refused}, B ${B.last.refused}`);
    };
    const aFront = () => z(A) === 'above';
    const aFrontBMin = () => z(A) === 'above' && z(B) === 'minimized';
    // Only the shell's own process (this one) may take the foreground; the test windows never get that right, like
    // real apps, which is what decides whether anything can bring them to the top.
    const others = [];   // further test windows of this section (C below)
    const activateShell = async () => {
      for (const w of [A, B, ...others]) {
        const n = w.lines.length;
        w.command(`allowfg ${process.pid}`);
        await until(() => w.lines.slice(n).some((l) => l.line.startsWith('allowfg|')), 2000);
      }
      h.win.focus();
      await until(() => h.win.isFocused(), 2000);
      if (!h.win.isFocused()) throw new Error('could not activate the shell (another program holds the foreground)');
    };
    const raiseShell = () => h.win.moveTop();
    const click = async () => { await activateShell(); raiseShell(); };

    await step('picked A: A above the shell', () => h.dispatch({ type: 'add', candidate: cand(A) }), aFront);
    await step('a click on the shell, then one more while it is active (brought to the top, no focus event): A above it', click, aFront);
    await step('switching to B (click on +): B above the shell, A minimized', async () => { await click(); h.dispatch({ type: 'add', candidate: cand(B) }); }, () => z(A) === 'minimized' && z(B) === 'above');
    await step('clicking tab A: A above the shell, B minimized', async () => { await click(); h.dispatch({ type: 'select', id: 't1' }); }, aFrontBMin);
    await step('dragging the shell by its tab bar row: A above the shell', async () => {
      await click();
      for (let i = 0; i < 5; i++) { const [x, y] = h.win.getPosition(); h.win.setPosition(x + 14, y + 8); await sleep(16); }
      raiseShell();
    }, aFrontBMin);
    check(near(frame(A.hwnd), dockRect()), 'after the drag A covers the dock area', `${JSON.stringify(frame(A.hwnd))} vs ${JSON.stringify(dockRect())}`);
    await step('resizing the shell: A above the shell', async () => {
      await click();
      for (let i = 0; i < 5; i++) { const [w, ht] = h.win.getSize(); h.win.setSize(w - 24, ht - 14); await sleep(16); }
      raiseShell();
    }, aFrontBMin);
    check(near(frame(A.hwnd), dockRect()), 'after the resize A covers the dock area', `${JSON.stringify(frame(A.hwnd))} vs ${JSON.stringify(dockRect())}`);
    await step('another click on the active shell: A above the shell', raiseShell, aFrontBMin);
    // The shell's real + menu. Real order: a press on + brings the shell up, the check lowers it beneath A right away,
    // then the click opens the menu, which must be open and in front. If the shell comes up while the menu is open,
    // Windows keeps it above A until the menu closes (the shell asks anyway); closing the menu runs the check again.
    const mine = () => ffi.enumWindows().filter((x) => ffi.getWindowThreadProcessId(x) === process.pid && ffi.isWindowVisible(x));
    const openMenu = async () => {
      const before = new Set(mine());
      const m = { closed: false, window: undefined, menu: h.openAddMenu() };
      m.menu.once('menu-will-close', () => { m.closed = true; });
      await sleep(300);
      m.window = mine().find((x) => !before.has(x) && x !== shellHwnd);
      return m;
    };
    const inFront = (m) => { const order = ffi.enumWindows(); return m.window !== undefined && order.indexOf(m.window) < order.indexOf(A.hwnd); };
    await activateShell();
    raiseShell();
    await sleep(60);
    const first = await openMenu();
    await sleep(300);
    check(!first.closed && inFront(first) && z(A) === 'above', 'a press on +, then its menu: the menu is open and in front, A above the shell',
      `menu closed ${first.closed}, in front ${inFront(first)}, A ${z(A)}`);
    first.menu.closePopup(h.win);
    await sleep(300);
    const second = await openMenu();
    let mark = rec.calls.length;
    const writes = () => { const w = rec.calls.slice(mark).map((c) => `${c.fn}@${c.hwnd === shellHwnd ? 'shell' : c.hwnd === A.hwnd ? 'A' : c.hwnd}${c.args[0] ? ` after ${c.args[0] === A.hwnd ? 'A' : c.args[0]}` : ''}=${c.result}`); mark = rec.calls.length; return w.join(', ') || 'none'; };
    raiseShell();
    await sleep(500);
    const during = `menu closed ${second.closed}, in front ${inFront(second)}, A ${z(A)}, writes during: ${writes()}`;
    const openAndInFront = !second.closed && inFront(second);
    second.menu.closePopup(h.win);
    await sleep(500);
    check(openAndInFront && z(A) === 'above', 'the shell brought up while a menu is open: the menu stays open and in front; A is back above once it closes',
      `${during}; after closing: A ${z(A)}, writes after: ${writes()}`);
    // Three windows: C, an unrelated visible window over the dock area, comes in front of the docked A (C → A → shell).
    // The user brings the shell back (shell → C → A). Lowering the shell beneath A would hide it behind C again, so
    // the shell must stay in front of C; a click on A's tab then brings A in front of both.
    const C = await ours('Normal', { unrelated: true });
    others.push(C);
    const stack = () => {
      const label = new Map([[shellHwnd, 'shell'], [A.hwnd, 'A'], [C.hwnd, 'C']]);
      return ffi.enumWindows().filter((x) => label.has(x)).map((x) => label.get(x)).join(' → ');
    };
    C.command('front');
    await sleep(500);
    const before3 = stack();
    await activateShell();
    await sleep(500);
    const after3 = stack();
    check(before3.startsWith('C → A') && after3.startsWith('shell → C'), 'three windows: the shell brought back stays in front of C, not lowered beneath A behind C',
      `before: ${before3}; brought back: ${after3}`);
    const mark3 = rec.calls.length;
    const refusedBefore = A.last.refused;
    h.dispatch({ type: 'select', id: 't1' });
    await sleep(500);
    const writes3 = rec.calls.slice(mark3).map((c) => `${c.fn}@${c.hwnd === shellHwnd ? 'shell' : c.hwnd === A.hwnd ? 'A' : c.hwnd}=${c.result}`).join(', ');
    // With a real click the shell is the foreground window and may hand the foreground to A, which brings A in front
    // of C. In this run Windows may refuse that (the shell's activation here is an approximation); a refused
    // foreground is not retried, so then only "A docked, shell right beneath it" is required.
    const granted = rec.calls.slice(mark3).some((c) => c.fn === 'setForegroundWindow' && c.result);
    const s3 = stack();
    check(s3.includes('A → shell') && (!granted || s3.startsWith('A → shell')), 'three windows: a click on A\'s tab docks A, the shell right beneath it (and A in front of C when Windows grants the foreground)',
      `${s3}; foreground ${granted ? 'granted' : 'refused by Windows in this run'}; writes: ${writes3}; A refused ${A.last.refused - refusedBefore} z-order request(s) meanwhile`);
    C.stop();
    h.dispatch({ type: 'quit' });
    check(!ffi.isIconic(A.hwnd) && !A.exited && !B.exited, 'closing the shell put the windows back');
  } finally {
    if (!h.win.isDestroyed()) h.win.destroy();
    server.close();
    A.stop();
    B.stop();
  }
}

/**
 * Split view (docs/desktop.md "分屏", test F): two columns, then a 2 × 2 grid, with the real shell window and four strict
 * test windows (they refuse z-order changes without activation, as in zOrder above). After tab clicks, clicks on the
 * shell, dragging and resizing it and dragging a divider, every docked window must be above the shell and cover its
 * pane. A third window between them keeps the shell from being lowered. Minimizing and restoring the shell takes every
 * pane along; closing it puts every window back. Same approximations of user input as zOrder (no real mouse, no modal
 * move or size loop; a divider drag is the reducer event the tab bar sends, at the rate it sends it).
 */
async function splitView() {
  log('\n[F] split view: every docked window stays above the shell (real shell window, two columns, then a 2 × 2 grid)');
  const server = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>fake hub</title>'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // A starts visible; the others wait minimized until added (a visible, undocked one over the dock area would be a third
  // window between the shell and the docked ones).
  const A = await ours('Normal', { unrelated: true, strict: true });
  const B = await ours('Minimized', { unrelated: true, strict: true });
  const C = await ours('Minimized', { unrelated: true, strict: true });
  const D = await ours('Minimized', { unrelated: true, strict: true });
  const all = [A, B, C, D];
  const before = new Map(all.map((w) => [w.hwnd, ffi.getWindowPlacement(w.hwnd)]));
  const rec = recording(ffi);
  const h = startShell({ ffi: rec.ffi, ensure: async () => ({ origin }), apps: APPS });
  const others = [];
  try {
    await new Promise((ok) => (h.win.isVisible() ? ok() : h.win.once('show', ok)));
    await sleep(800);
    const shellHwnd = Number(h.win.getNativeWindowHandle().readBigUInt64LE(0));
    const name = new Map([[shellHwnd, 'shell'], [A.hwnd, 'A'], [B.hwnd, 'B'], [C.hwnd, 'C'], [D.hwnd, 'D']]);
    const z = (w) => {
      if (ffi.isIconic(w.hwnd)) return 'minimized';
      const order = ffi.enumWindows();
      return order.indexOf(w.hwnd) < order.indexOf(shellHwnd) ? 'above' : 'BELOW';
    };
    const stack = () => ffi.enumWindows().filter((x) => name.has(x) && !ffi.isIconic(x)).map((x) => name.get(x)).join(' → ');
    const panes = () => {
      const display = screen.getDisplayMatching(h.win.getBounds());
      const rect = toPhysical(dockArea(h.win.getContentBounds(), BAR), { dip: display.bounds, px: screen.dipToScreenRect(null, display.bounds), scale: display.scaleFactor });
      return paneRects(rect, h.state.layout, h.state.ratios, Math.round(PANE_GAP * display.scaleFactor));
    };
    /** The test windows docked now, each with its pane. */
    const docked = () => all.flatMap((w) => {
      const tab = h.state.tabs.find((t) => t.binding?.hwnd === w.hwnd);
      const i = tab ? h.state.panes.indexOf(tab.id) : -1;
      return i >= 0 ? [{ w, i }] : [];
    });
    const covers = () => docked().every(({ w, i }) => near(frame(w.hwnd), panes()[i], 3));
    const allAbove = () => docked().length > 0 && docked().every(({ w }) => z(w) === 'above');
    const cand = (w) => listCandidates(ffi, { apps: APPS, exclude: h.state.tabs.flatMap((t) => (t.binding ? [t.binding.hwnd] : [])) })
      .find((c) => c.hwnd === w.hwnd && c.pid === w.pid);
    const activateShell = async () => {
      for (const w of [...all, ...others]) {
        const n = w.lines.length;
        w.command(`allowfg ${process.pid}`);
        await until(() => w.lines.slice(n).some((l) => l.line.startsWith('allowfg|')), 2000);
      }
      h.win.focus();
      await until(() => h.win.isFocused(), 2000);
      if (!h.win.isFocused()) throw new Error('could not activate the shell (another program holds the foreground)');
    };
    const raiseShell = () => h.win.moveTop();
    const click = async () => { await activateShell(); raiseShell(); };
    const step = async (what, fn, expect = allAbove) => {
      await fn();
      const right = stack();
      await sleep(400);
      check(expect(), what, `right after: ${right}; after 400 ms: ${stack()}; panes ${JSON.stringify(h.state.panes)}, active ${h.state.active}`);
    };
    const add = (w) => h.dispatch({ type: 'add', candidate: cand(w) });
    // Tab ids come from the state (tabs saved by the section above come back unbound and keep the first ids).
    const tabOf = (w) => h.state.tabs.find((t) => t.binding?.hwnd === w.hwnd).id;

    await step('two columns, A left and B right: both above the shell', () => {
      h.dispatch({ type: 'layout', layout: 'columns' });
      h.dispatch({ type: 'activate', pane: 0 });
      add(A);
      h.dispatch({ type: 'activate', pane: 1 });
      add(B);
    });
    check(covers(), 'each covers its pane', JSON.stringify(docked().map(({ w, i }) => [name.get(w.hwnd), i, frame(w.hwnd)])));
    await step('a click on the shell, then one more while it is active: both above it', click);
    await step('clicking tab A (A gets the foreground if Windows allows): both above the shell', async () => { await click(); h.dispatch({ type: 'select', id: tabOf(A) }); }, () => allAbove() && h.state.active === 0);
    await step('dragging the shell by its tab bar row: both above, each on its pane', async () => {
      await click();
      for (let i = 0; i < 5; i++) { const [x, y] = h.win.getPosition(); h.win.setPosition(x + 14, y + 8); await sleep(16); }
      raiseShell();
    }, () => allAbove() && covers());
    await step('resizing the shell: both above, each on its pane', async () => {
      await click();
      for (let i = 0; i < 5; i++) { const [w, ht] = h.win.getSize(); h.win.setSize(w + 20, ht + 12); await sleep(16); }
      raiseShell();
    }, () => allAbove() && covers());
    await step('dragging the divider: both above, each on its (resized) pane', async () => {
      await click();
      for (const x of [0.45, 0.4, 0.35]) { h.dispatch({ type: 'ratios', x, y: 0.5 }); await sleep(16); }
      raiseShell();
    }, () => allAbove() && covers() && h.state.ratios.x === 0.35);

    await step('2 × 2 grid, C and D in the bottom row: all four above the shell, each on its pane', async () => {
      await click();
      h.dispatch({ type: 'layout', layout: 'grid' });
      add(C);
      h.dispatch({ type: 'activate', pane: 3 });
      add(D);
    }, () => allAbove() && covers() && docked().length === 4);
    await step('a click on the shell: all four above it', click);
    await step('clicking tab B: all four above the shell', async () => { await click(); h.dispatch({ type: 'select', id: tabOf(B) }); }, () => allAbove() && h.state.active === 1);
    await step('dragging both dividers (the cross): all four above, each on its pane', async () => {
      await click();
      for (const [x, y] of [[0.5, 0.45], [0.55, 0.4], [0.6, 0.4]]) { h.dispatch({ type: 'ratios', x, y }); await sleep(16); }
      raiseShell();
    }, () => allAbove() && covers());
    await step('dragging and resizing the shell: all four above, each on its pane', async () => {
      await click();
      for (let i = 0; i < 4; i++) { const [x, y] = h.win.getPosition(); h.win.setPosition(x - 10, y - 6); await sleep(16); }
      for (let i = 0; i < 4; i++) { const [w, ht] = h.win.getSize(); h.win.setSize(w - 16, ht - 10); await sleep(16); }
      raiseShell();
    }, () => allAbove() && covers());

    // A third window E over the dock area comes in front of the docked ones; the user brings the shell back. Lowering
    // it beneath the lowest docked window would hide it behind E, so it stays in front of E.
    const E = await ours('Normal', { unrelated: true });
    others.push(E);
    name.set(E.hwnd, 'E');
    E.command('front');
    await sleep(500);
    const withE = stack();
    await activateShell();
    await sleep(500);
    const order = ffi.enumWindows();
    const shellAt = order.indexOf(shellHwnd);
    check(withE.startsWith('E') && shellAt < order.indexOf(E.hwnd) && docked().every(({ w }) => order.indexOf(w.hwnd) > order.indexOf(E.hwnd)),
      'a third window in between: the shell brought back stays in front of it, not lowered behind it', `before: ${withE}; brought back: ${stack()}`);
    E.stop();
    await until(() => !ffi.isWindow(E.hwnd), 5000);
    others.length = 0;
    // As with one pane, nothing lowers the shell again by itself (it is already active and on top); a tab click does.
    await step('the third window closed, a click on tab C: all four above the shell again', async () => { await click(); h.dispatch({ type: 'select', id: tabOf(C) }); }, () => allAbove() && h.state.active === 2);

    // Minimize and restore the shell window: every pane goes and comes back, the active pane's window last (in front).
    h.win.minimize();
    await until(() => h.win.isMinimized() && h.state.minimized, 3000);
    await sleep(300);
    check(all.every((w) => ffi.isIconic(w.hwnd)), 'minimizing the shell minimizes all four', all.map((w) => `${name.get(w.hwnd)} ${state(w.hwnd).iconic}`).join(', '));
    h.win.restore();
    await until(() => !h.win.isMinimized() && all.every((w) => !ffi.isIconic(w.hwnd)), 5000);
    await sleep(600);
    check(all.every((w) => !ffi.isIconic(w.hwnd)) && covers(), 'restoring the shell restores all four onto their panes', stack());
    await step('after the restore and a click: all four above the shell', click);

    // Close the shell: every window back to its own placement from before (A normal, B, C, D minimized).
    h.dispatch({ type: 'quit' });
    const back = all.every((w) => {
      const now = ffi.getWindowPlacement(w.hwnd);
      const was = before.get(w.hwnd);
      return now.showCmd === was.showCmd && JSON.stringify(now.rcNormalPosition) === JSON.stringify(was.rcNormalPosition);
    });
    check(back && !ffi.isIconic(A.hwnd) && [B, C, D].every((w) => ffi.isIconic(w.hwnd)) && all.every((w) => !w.exited && w.last.text === w.text),
      'closing the shell puts all four back where they were, input intact', all.map((w) => `${name.get(w.hwnd)} ${JSON.stringify(state(w.hwnd))}`).join(', '));
    // What the shell wrote, for the log: only to these windows and to itself.
    const targets = [...new Set(rec.calls.map((c) => name.get(c.hwnd) ?? `0x${c.hwnd.toString(16)}`))];
    check(targets.every((t) => ['shell', 'A', 'B', 'C', 'D'].includes(t)), 'writes went only to the four test windows and the shell\'s own window', targets.join(', '));
  } finally {
    for (const w of others) w.stop();
    if (!h.win.isDestroyed()) h.win.destroy();
    server.close();
    for (const w of all) w.stop();
  }
}

// Not a top-level await: Electron emits 'ready' only after the entry module has finished evaluating.
app.whenReady().then(async () => {
  log(`orrery desktop Win32 check, ${new Date().toISOString()}, Electron ${process.versions.electron}, log ${logFile}`);
  try {
    await originalStates();
    await moveAcrossDisplays();
    await identityLost();
    await unresponsive();
    await hostEnds();
    await zOrder();
    await splitView();
  } catch (e) {
    failed++;
    log(`  FAIL ${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    for (const w of started) w.stop();
  }
  log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  app.exit(failed ? 1 : 0);
});
