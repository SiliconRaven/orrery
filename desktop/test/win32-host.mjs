// A stand-in shell for the Win32 check (test F), run as its own Electron process: binds the test window named in
// ORRERY_TEST_HWND / ORRERY_TEST_PID / ORRERY_TEST_TITLE (refusing any other window), docks it at ORRERY_TEST_RECT and
// reports "docked" in the file ORRERY_TEST_OUT. When the file ORRERY_TEST_QUIT appears it puts the window back,
// reports "restored" and exits. (Files, not stdin/stdout: an Electron main process on Windows does not reliably read
// stdin, and output written right before exit can be lost.) The check also ends this process by force instead.
import { app } from 'electron';
import { appendFileSync, existsSync } from 'node:fs';
import { ffi } from '../lib/win32.mjs';
import { miniShell } from './mini-shell.mjs';

const apps = [{ id: 'test', name: 'test window', exe: 'powershell.exe' }];
const env = process.env;
const say = (line) => appendFileSync(env.ORRERY_TEST_OUT, `${line}\n`);

app.whenReady().then(() => {   // not a top-level await: 'ready' waits for this module to finish evaluating
  const shell = miniShell(ffi, { apps, rect: JSON.parse(env.ORRERY_TEST_RECT) });
  const [candidate] = shell.candidates((c) => c.hwnd === Number(env.ORRERY_TEST_HWND) && c.pid === Number(env.ORRERY_TEST_PID) && c.title === env.ORRERY_TEST_TITLE);
  if (!candidate) { say('no-candidate'); app.exit(2); return; }
  shell.dispatch({ type: 'add', candidate });
  say(shell.state.tabs[0]?.binding ? 'docked' : `not-docked ${shell.notices.join(' ')}`);
  const timer = setInterval(() => {
    if (!existsSync(env.ORRERY_TEST_QUIT)) return;
    clearInterval(timer);
    shell.dispatch({ type: 'quit' });
    // This stand-in has no shell window of its own, so lowering it is refused by design; only put-backs count here.
    const putBack = shell.failures.filter((f) => f.op === 'putBack');
    say(putBack.length ? `restore-failed ${JSON.stringify(putBack)}` : 'restored');
    app.exit(0);
  }, 100);
});
