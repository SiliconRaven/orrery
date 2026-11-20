// Starting a supported app that is not running, from a click in the "+" strip (docs/desktop.md "启动应用"): the start
// call and what happens after the click. Where the app is started from is looked up read-only by lib/locate.mjs
// locateApp, and the shell's one launch function (shell.mjs launchApp) does the starting through startApp, with the
// process start and the system's open action passed in. Pure; nothing here starts anything by itself.
import { isAumid } from './locate.mjs';

/** A Windows folder as %SystemRoot% names it: `X:\Name`, one segment, no separators or special characters. */
const isSystemRoot = (p) => typeof p === 'string' && /^[A-Za-z]:\\[^\\/:*?"<>|\u0000-\u001f]+$/.test(p);

/**
 * Starts `target` (lib/locate.mjs Location) and resolves to '' when started or to an error text. An MSIX app is
 * activated by app ID like the Start menu does: `%SystemRoot%\explorer.exe shell:AppsFolder\<aumid>` (the absolute
 * path, so that no same-named program in the current folder is run), detached, nothing passed on to the app; started
 * once the process exists (explorer's exit code means nothing, it is always 1), failed on its 'error' event. Any other
 * app: the system's default action for its program file, without arguments (`openPath`, Electron's shell.openPath).
 * @param {{ path: string, aumid?: string }} target
 * @param {{ spawn: Function, openPath: (path: string) => Promise<string>, systemRoot: string | undefined }} io
 * @returns {Promise<string>}
 */
export function startApp(target, { spawn, openPath, systemRoot }) {
  if (!('aumid' in target)) return openPath(target.path);
  if (!isAumid(target.aumid)) return Promise.resolve('invalid app ID');
  if (!isSystemRoot(systemRoot)) return Promise.resolve('no Windows folder (%SystemRoot%)');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(`${systemRoot}\\explorer.exe`, [`shell:AppsFolder\\${target.aumid}`], { detached: true, windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      resolve(String(e?.message ?? e));
      return;
    }
    child.once('error', (e) => resolve(String(e?.message ?? e)));
    child.once('spawn', () => { child.unref(); resolve(''); });
  });
}

/** How long the shell watches for the started app's new window, and how long it waits for others appearing with it. */
export const WATCH_MS = 20_000;
export const SETTLE_MS = 800;

/**
 * Watches for the started app's windows that were not there before the click (`before`: their handles). Each `tick`
 * gets the app's current candidate windows. Only windows first seen before the deadline (start + WATCH_MS) count; one
 * seen after it is ignored, also when a poll comes late. When counted windows are there, it waits SETTLE_MS from the
 * first of them for others appearing with them (this may end up to SETTLE_MS after the deadline), then answers: one →
 * { add }, several → { choose } (the user picks). When none is there at or after the deadline → { none }. Once it has
 * answered, it is done; it never starts anything again.
 * @template {{ hwnd: number }} C
 * @param {Set<number>} before @param {number} start
 */
export function createWatch(before, start) {
  const deadline = start + WATCH_MS;
  const counted = new Set();   // windows first seen before the deadline
  let seen = null;
  let done = false;
  return {
    get done() { return done; },
    /** @param {C[]} list @param {number} now @returns {{ add: C } | { choose: C[] } | { none: true } | null} */
    tick(list, now) {
      if (done) return null;
      if (now < deadline) for (const c of list) if (!before.has(c.hwnd)) counted.add(c.hwnd);
      const fresh = list.filter((c) => counted.has(c.hwnd));
      if (!fresh.length) {
        seen = null;   // one came and went (a splash screen): wait for the real one
        if (now < deadline) return null;
        done = true;
        return { none: true };
      }
      seen ??= now;
      if (now - seen < SETTLE_MS) return null;
      done = true;
      return fresh.length === 1 ? { add: fresh[0] } : { choose: fresh };
    },
  };
}
