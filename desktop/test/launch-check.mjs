// Launch check (docs/desktop.md "启动应用"). Run in desktop/ with ORRERY_DESKTOP_WIN32=1: `npm run test:launch`.
// The real shell (shell.mjs) with the real Win32 layer starts a *test window* through its one launch function: the app
// list holds one test app (image powershell.exe) and the start target is a shortcut in a temporary folder that opens
// the repo's own test window (test-window.mjs) through wscript, hidden console, no real app. The click is the pages' own
// IPC (the tab bar's window.orrery.add, then the "+" panel's pick). Checks: started once, its new window docked into a
// new tab; the "+" panel opened again shows above that docked window, also after the shell was brought up, and leaves
// nothing behind when closed; the window is put back and closed at the end. It refuses to run if any window of the test app's image is already listed, so that it can never
// take one of the user's windows.
import { app, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { listCandidates, observe } from '../lib/windows.mjs';
import { ffi } from '../lib/win32.mjs';
import { startShell } from '../shell.mjs';
import { SCRIPT } from './test-window.mjs';
import { checkTempDir } from './temp-dir.mjs';

if (process.env.ORRERY_DESKTOP_WIN32 !== '1') {
  console.log('Launch check skipped: set ORRERY_DESKTOP_WIN32=1 to run it (it starts and docks its own test window).');
  process.exit(0);
}
const dir = checkTempDir('orrery-desktop-launch-');   // deleted after this process exits (temp-dir.mjs)
app.setPath('userData', join(dir, 'electron'));
app.on('window-all-closed', () => { /* the check closes the shell itself */ });
const APPS = [{ id: 'test', name: 'launch test window', exe: 'powershell.exe' }];
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};
const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(50); return cond(); };
const ps = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** The test window as something to start without arguments: a shortcut to wscript running a hidden PowerShell. */
function testApp() {
  const nonce = randomBytes(4).toString('hex');
  const title = `orrery-desktop-test ${nonce}`;
  const vars = { ORRERY_TEST_TITLE: title, ORRERY_TEST_TEXT: `unsaved input ${nonce}`, ORRERY_TEST_CMD: join(dir, `cmd-${nonce}.txt`),
    ORRERY_TEST_STATE: 'Normal', ORRERY_TEST_STRICT: '0' };
  const ps1 = join(dir, `window-${nonce}.ps1`);
  const out = join(dir, `out-${nonce}.txt`);
  writeFileSync(ps1, `\uFEFF${Object.entries(vars).map(([k, v]) => `$env:${k} = ${ps(v)}`).join('\n')}
$w = New-Object System.IO.StreamWriter(${ps(out)}, $true); $w.AutoFlush = $true; [Console]::SetOut($w)
${SCRIPT}`);
  const vbs = join(dir, `start-${nonce}.vbs`);
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""${ps1}""", 0, False\r\n`);
  const lnk = join(dir, `start-${nonce}.lnk`);
  if (!shell.writeShortcutLink(lnk, 'create', { target: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'), args: `"${vbs}"` })) throw new Error('could not write the test shortcut');
  return { title, lnk };
}

app.whenReady().then(async () => {
  console.log(`orrery desktop launch check, Electron ${process.versions.electron}`);
  const before = listCandidates(ffi, { apps: APPS });
  if (before.length) {
    console.log(`Launch check not run: ${before.length} window(s) of ${APPS[0].exe} are open, and the check must not take any of them.`);
    app.exit(1);
    return;
  }
  const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>fake hub</title>'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const target = testApp();
  const opened = [];
  const realOpen = shell.openPath.bind(shell);
  shell.openPath = (p) => { opened.push(p); return realOpen(p); };   // recorded, then really opened
  const ours = () => listCandidates(ffi, { apps: APPS }).filter((c) => c.title === target.title);
  let h = null;
  try {
    h = startShell({ ffi, ensure: async () => ({ origin: `http://127.0.0.1:${server.address().port}` }), apps: APPS,
      launchTarget: () => ({ ok: true, path: target.lnk, icon: '' }) });
    await until(() => h.hub.status === 'ready' && !h.tabs.isLoading(), 10_000);
    await sleep(500);
    await until(() => !h.strips.isLoading());
    await h.tabs.executeJavaScript('window.orrery.add(60); true');
    check(await until(() => h.strip?.[0]?.status === 'launch' && h.panel.isVisible()), 'the + panel shows the test app as not running, startable', JSON.stringify(h.strip));
    await h.strips.executeJavaScript("window.orrery.pick('test'); true");
    check(await until(() => opened.length === 1), 'a pick from the + panel starts it once, through the one launch call', JSON.stringify(opened));
    check(await until(() => h.state.tabs.length === 1 && !!h.state.tabs[0].binding, 20_000), 'its new window went into a new tab');
    const b = h.state.tabs[0]?.binding;
    const o = b ? observe(ffi, b.hwnd) : null;
    check(!!o?.ok && o.window.title === target.title, 'and it is the started test window', o?.ok ? o.window.title : 'not bound');
    check(h.state.panes[h.state.active] === 't1' && h.starting.length === 0, 'selected; the watch ended');
    await sleep(1500);
    check(opened.length === 1, 'started exactly once');

    // The "+" panel over the docked window: the window sits above the shell, the panel (owned by the shell, on top)
    // above both, overlapping it; still so after the shell is brought up (a press on its row) and lowered again.
    const handle = (w) => Number(w.getNativeWindowHandle().readBigUInt64LE(0));
    const [shellH, panelH] = [handle(h.win), handle(h.panel)];
    const stack = () => { const o = ffi.enumWindows(); return [o.indexOf(panelH), o.indexOf(b.hwnd), o.indexOf(shellH)]; };
    const overlaps = () => {
      const p = ffi.getExtendedFrameBounds(panelH);
      const d = ffi.getExtendedFrameBounds(b.hwnd);
      return !!p && !!d && p.left < d.right && d.left < p.right && p.top < d.bottom && d.top < p.bottom;
    };
    await h.tabs.executeJavaScript('window.orrery.add(60); true');
    check(await until(() => h.panel.isVisible()), 'the + panel opens again');
    await sleep(400);
    const [p1, d1, s1] = stack();
    check(p1 >= 0 && p1 < d1 && d1 < s1 && overlaps(), 'the panel is above the docked window, which is above the shell, and covers part of it', `z ${[p1, d1, s1]}`);
    h.win.moveTop();   // a press on the active shell's row: the shell comes up, the z-order check lowers it again
    await sleep(600);
    const [p2, d2, s2] = stack();
    const topmost = (Number(ffi.getWindowLongPtr(panelH, -20)) & 0x8) !== 0;   // WS_EX_TOPMOST, read only
    check(p2 >= 0 && p2 < d2 && d2 < s2 && topmost, 'after the shell was brought up: still panel, docked window, shell; the panel still topmost', `z ${[p2, d2, s2]}, topmost ${topmost}`);
    await h.strips.executeJavaScript('window.orrery.close(); true');
    check(await until(() => !h.panel.isVisible() && !ffi.isWindowVisible(panelH)), 'closed: the panel window is hidden, nothing left on screen');
    const [, d3, s3] = stack();
    check(d3 < s3 && opened.length === 1, 'the docked window is still above the shell; nothing was started', `z ${[d3, s3]}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    if (h && !h.win.isDestroyed()) h.win.close();   // puts the window back
    await sleep(500);
    for (const c of ours()) { try { process.kill(c.pid); } catch { /* gone */ } }
    await until(() => ours().length === 0, 5000);
    check(ours().length === 0, 'the test window is closed again');
    server.close();
  }
  console.log(`\n${failed ? `${failed} check(s) failed` : 'all checks passed'}`);
  app.exit(failed ? 1 : 0);
});
