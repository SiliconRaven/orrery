// The single entry for every call that changes an app window (docs/desktop.md "主进程唯一写入口"): docking,
// following, minimizing, bringing to the foreground and putting back all go through `write`. Before each Win32 write
// it re-reads the window and checks it is still the bound instance (lib/windows.mjs identityMismatch); on any mismatch
// or read failure it writes nothing and reports the binding as lost. It also holds the allow-list for parameters and
// triggers: only the SetWindowPos flags and ShowWindow commands below, SW_RESTORE and SetForegroundWindow only for
// explicit user actions, never while following.
//
// Keeping the docked window in front never raises the app window. On a real machine raising it did not bring it
// back once the user had clicked the shell; that fits the SetWindowPos documentation (bringing a window to the top
// needs foreground permission for its process), though the exact cause is still to be confirmed there. Instead the
// shell moves its OWN window to just beneath the bound window (`lowerShell`); the bound window is only the reference
// for hWndInsertAfter, checked like every write target, and is not changed.
//
// No Electron, no koffi: `ffi` is lib/win32.mjs in the shell and a recording fake in tests. The shell's main process
// creates one writer and sends every window operation through it; test/desktop.test.ts checks that nothing else calls
// the Win32 write functions.
import { APPS } from './apps.mjs';
import { fromRECT, isRect, outerRect, validPlacement } from './geometry.mjs';
import { identityMismatch, isCandidate, observe } from './windows.mjs';

export const HWND_TOP = 0;
export const SWP_NOSIZE = 0x1;
export const SWP_NOMOVE = 0x2;
export const SWP_NOZORDER = 0x4;
export const SWP_NOACTIVATE = 0x10;
export const SWP_NOOWNERZORDER = 0x200;
export const SWP_ASYNCWINDOWPOS = 0x4000;
/** The only SetWindowPos flags the contract allows. Not used here: SWP_ASYNCWINDOWPOS (see `place`). */
export const SWP_ALLOWED = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS;

export const SW_SHOWNORMAL = 1;
export const SW_SHOWMINIMIZED = 2;
export const SW_SHOWNOACTIVATE = 4;
export const SW_SHOWMINNOACTIVE = 7;
export const SW_RESTORE = 9;
/** The only ShowWindow commands. */
export const SW_ALLOWED = [SW_SHOWMINNOACTIVE, SW_RESTORE];

/** SW_RESTORE activates the window: only when the user picked this window or tab, or restored the orrery window by hand. */
export const RESTORE_TRIGGERS = Object.freeze(['add', 'choose', 'select', 'restore']);
/** SetForegroundWindow: only when the user clicked this app's tab or just picked its window. */
export const FOREGROUND_TRIGGERS = Object.freeze(['add', 'choose', 'select']);
/** SetWindowPlacement: only to put a window back when its tab closes, the shell closes or the Hub quits. */
export const PUT_BACK_TRIGGERS = Object.freeze(['close', 'quit', 'shutdown']);
/** The shell's own window beneath the bound one: after a tab action, on activation, or after a z-order check. */
export const LOWER_SHELL_TRIGGERS = Object.freeze(['add', 'choose', 'select', 'focus', 'restack']);

/**
 * The recorded placement, written back without activating where Windows has a non-activating equivalent: normal →
 * SW_SHOWNOACTIVATE, minimized → SW_SHOWMINNOACTIVE. Maximized stays SW_SHOWMAXIMIZED (there is no quiet variant).
 * Position, size, flags and the restore-to-maximized bit are unchanged.
 */
export function quietPlacement(wp) {
  const showCmd = wp.showCmd === SW_SHOWNORMAL ? SW_SHOWNOACTIVATE : wp.showCmd === SW_SHOWMINIMIZED ? SW_SHOWMINNOACTIVE : wp.showCmd;
  return { ...wp, showCmd };
}

/**
 * @typedef {import('./windows.mjs').Identity} Identity
 * @typedef {{ op: 'restore' | 'place' | 'lowerShell' | 'foreground' | 'minimize' | 'putBack', tab: string,
 *   binding: Identity & { id: number }, trigger: string, rect?: object, placement?: object,
 *   others?: (Identity & { id: number })[] }} WindowOp  others: lowerShell only, the other docked windows (split view)
 * @typedef {{ status: 'ok' | 'lost' | 'failed' | 'refused', reason?: string, error?: number,
 *   observed?: { width: number, height: number } }} WriteResult  observed: place only, the window stayed larger
 */

/** The only flags for moving the shell's own window beneath the bound window: z-order only, never activating. */
export const SWP_LOWER_SHELL = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;

/** @param {{ apps?: object[], ownWindow?: () => number }} options ownWindow: the shell's own top-level window handle */
export function createWriter(ffi, { apps = APPS, ownWindow = () => 0 } = {}) {
  const ok = { status: 'ok' };
  const refused = (reason) => ({ status: 'refused', reason });
  const failed = (call) => ({ status: 'failed', reason: call, error: ffi.getLastError() });

  /** Re-reads the window right before a write: null when it is still the bound instance, else why not. */
  const check = (binding) => identityMismatch(binding, observe(ffi, binding.hwnd), apps);

  const setWindowPos = (hwnd, x, y, cx, cy, flags) => {
    if (flags & ~SWP_ALLOWED) throw new Error(`SetWindowPos flags 0x${flags.toString(16)} are not allowed`);
    return ffi.setWindowPos(hwnd, HWND_TOP, x, y, cx, cy, flags);
  };
  const showWindow = (hwnd, cmd) => {
    if (!SW_ALLOWED.includes(cmd)) throw new Error(`ShowWindow ${cmd} is not allowed`);
    return ffi.showWindow(hwnd, cmd);
  };

  // Every call below is synchronous on purpose (no SWP_ASYNCWINDOWPOS): a request queued in the app's thread could
  // otherwise land after the window was put back. The cost: while an app does not respond, a call to its window
  // waits for it (docs/desktop.md, Win32 check F).
  const ops = {
    restore({ binding, trigger }) {
      if (!RESTORE_TRIGGERS.includes(trigger)) return refused(`SW_RESTORE on ${trigger}`);
      const h = binding.hwnd;
      for (let i = 0; i < 2; i++) {   // minimized from maximized: the first restore only un-minimizes
        const lost = check(binding);
        if (lost) return { status: 'lost', reason: lost };
        if (!ffi.isIconic(h) && !ffi.isZoomed(h)) return ok;
        showWindow(h, SW_RESTORE);
      }
      return ok;
    },
    place({ binding, rect }) {
      if (!isRect(rect)) return refused('rect');
      const lost = check(binding);
      if (lost) return { status: 'lost', reason: lost };
      const h = binding.hwnd;
      // Minimized or maximized by the user: following does not undo that (it may not use SW_RESTORE).
      if (ffi.isIconic(h) || ffi.isZoomed(h)) return ok;
      const r = outerRect(rect, ffi.getWindowRect(h), ffi.getExtendedFrameBounds(h));
      // Position and size only; the z-order is the shell's business (lowerShell) or the activation's (foreground).
      const flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER;
      if (!setWindowPos(h, r.x, r.y, r.width, r.height, flags)) return failed('SetWindowPos');
      // An app may not shrink that far (its own minimum size): read where it ended up (a read, GetWindowRect). When it
      // stayed larger, the visible size it kept is reported (0 for a side that did fit), so the shell can keep panes
      // at least that big.
      const got = fromRECT(ffi.getWindowRect(h));
      const over = (size, asked, visible) => (size > asked + 2 ? visible + size - asked : 0);
      const observed = got && { width: over(got.width, r.width, rect.width), height: over(got.height, r.height, rect.height) };
      return observed && (observed.width || observed.height) ? { status: 'ok', observed } : ok;
    },
    /**
     * The shell's own window goes just beneath the bound window, or, in split view, beneath the lowest of the docked
     * windows (`others` are the windows in the other panes), so they all show over it. Which one is lowest is read
     * right here, after any foreground switch just before. The docked windows themselves are not touched.
     */
    lowerShell({ binding, others = [], trigger }) {
      if (!LOWER_SHELL_TRIGGERS.includes(trigger)) return refused(`lowering the shell on ${trigger}`);
      const own = ownWindow();
      if (!Number.isInteger(own) || own <= 0 || own === binding.hwnd) return refused('own window');
      const lost = check(binding);
      if (lost) return { status: 'lost', reason: lost };
      // Another pane's window is only a reference once it, too, is still the bound one; otherwise it is left out
      // (its own next operation reports it lost).
      const refs = [binding, ...others.filter((b) => b && Number.isInteger(b.hwnd) && b.hwnd !== own && !check(b))]
        // A window the user minimized or maximized is not put in front of the shell.
        .filter((b) => !ffi.isIconic(b.hwnd) && !ffi.isZoomed(b.hwnd));
      if (!refs.length) return ok;
      const order = ffi.enumWindows();
      const ref = refs.reduce((low, b) => (order.indexOf(b.hwnd) > order.indexOf(low.hwnd) ? b : low));
      return ffi.setWindowPos(own, ref.hwnd, 0, 0, 0, 0, SWP_LOWER_SHELL) ? ok : failed('SetWindowPos');
    },
    foreground({ binding, trigger }) {
      if (!FOREGROUND_TRIGGERS.includes(trigger)) return refused(`SetForegroundWindow on ${trigger}`);
      const lost = check(binding);
      if (lost) return { status: 'lost', reason: lost };
      // Once. Windows may refuse (foreground lock); then the window is docked but not focused, and that is all.
      return ffi.setForegroundWindow(binding.hwnd) ? ok : failed('SetForegroundWindow');
    },
    minimize({ binding }) {
      const lost = check(binding);
      if (lost) return { status: 'lost', reason: lost };
      showWindow(binding.hwnd, SW_SHOWMINNOACTIVE);
      return ok;
    },
    putBack({ binding, trigger, placement }) {
      if (!PUT_BACK_TRIGGERS.includes(trigger)) return refused(`SetWindowPlacement on ${trigger}`);
      if (!validPlacement(placement)) return refused('placement');
      const lost = check(binding);
      if (lost) return { status: 'lost', reason: lost };
      return ffi.setWindowPlacement(binding.hwnd, quietPlacement(placement)) ? ok : failed('SetWindowPlacement');
    },
  };

  return {
    /** @param {WindowOp} op @returns {WriteResult} */
    write(op) {
      const fn = Object.hasOwn(ops, op?.op) ? ops[op.op] : null;
      if (!fn || !op.binding || !Number.isInteger(op.binding.hwnd)) return refused('op');
      try {
        return fn(op);
      } catch (e) {
        return { status: 'failed', reason: e instanceof Error ? e.message : String(e) };
      }
    },

    /** Is the window still the bound instance? null if so, else why not. A read (the same check as before each write). */
    verify(binding) {
      try { return check(binding); } catch { return 'unreadable'; }
    },

    /**
     * Before a window is taken over: is the picked window still that candidate (same identity, still listable), and
     * can its WINDOWPLACEMENT be read and used? Only then may anything be written to it. A read, not a write.
     * @param {Identity} candidate
     * @returns {{ ok: true, placement: object } | { ok: false, reason: string }}
     */
    capture(candidate) {
      try {
        const o = observe(ffi, candidate.hwnd);
        const lost = identityMismatch(candidate, o, apps);
        if (lost) return { ok: false, reason: lost };
        if (!isCandidate(o.window, apps)) return { ok: false, reason: 'not-a-candidate' };
        const placement = ffi.getWindowPlacement(candidate.hwnd);
        return validPlacement(placement) ? { ok: true, placement } : { ok: false, reason: 'placement' };
      } catch {
        return { ok: false, reason: 'unreadable' };
      }
    },
  };
}
