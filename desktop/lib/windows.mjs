// Which windows the desktop shell may list, and whether a window is still the one a tab is bound to
// (docs/desktop.md "绑定、核对身份和还原"). No Electron, no koffi: the Win32 reads come in as `ffi` (lib/win32.mjs in
// the shell, a fake in tests), so the root `npm test` checks every rule here.
import { APPS, appForImage } from './apps.mjs';
import { fromRECT, intersects } from './geometry.mjs';

export const GWL_EXSTYLE = -20;
export const GA_ROOT = 2;
export const GW_OWNER = 4;
export const WS_EX_TOPMOST = 0x8;
export const WS_EX_TOOLWINDOW = 0x80;

/**
 * @typedef {{ hwnd: number, pid: number, exePath: string, className: string }} Identity
 * @typedef {Identity & { title: string, visible: boolean, iconic: boolean, zoomed: boolean, exStyle: number,
 *   owner: number, root: number, cloaked: boolean | null }} Observed
 * @typedef {{ ok: true, window: Observed } | { ok: false, reason: 'gone' | 'unreadable' }} Observation
 */

/**
 * Reads one window with the allow-listed read calls. `gone`: IsWindow is false. `unreadable`: the process id, image
 * path (for example no permission to query a process running as administrator) or class name could not be read, or a
 * read threw. Both mean "not usable": never retried with more rights.
 * @returns {Observation}
 */
export function observe(ffi, hwnd) {
  try {
    if (!ffi.isWindow(hwnd)) return { ok: false, reason: 'gone' };
    const pid = ffi.getWindowThreadProcessId(hwnd);
    const exePath = pid ? ffi.queryImagePath(pid) : null;
    const className = ffi.getClassName(hwnd);
    if (!pid || !exePath || !className) return { ok: false, reason: 'unreadable' };
    return {
      ok: true,
      window: {
        hwnd, pid, exePath, className,
        title: ffi.getWindowText(hwnd) ?? '',
        visible: !!ffi.isWindowVisible(hwnd),
        iconic: !!ffi.isIconic(hwnd),
        zoomed: !!ffi.isZoomed(hwnd),
        exStyle: Number(ffi.getWindowLongPtr(hwnd, GWL_EXSTYLE)) || 0,
        owner: ffi.getWindow(hwnd, GW_OWNER) || 0,
        root: ffi.getAncestor(hwnd, GA_ROOT) || 0,
        cloaked: ffi.isCloaked(hwnd),
      },
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** @param {Observed} w @returns {Identity} */
export const identityOf = (w) => ({ hwnd: w.hwnd, pid: w.pid, exePath: w.exePath, className: w.className });

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Why `observation` is not the window bound as `expected`, or null when it still is: the same window handle, process
 * id, full image path (still a supported app) and class name; still top-level, without an owner, not topmost. The
 * title changes on its own and is not part of the identity.
 * @param {Identity} expected
 * @param {Observation} observation
 * @returns {string | null}
 */
export function identityMismatch(expected, observation, apps = APPS) {
  if (!observation.ok) return observation.reason;
  const w = observation.window;
  if (w.hwnd !== expected.hwnd) return 'hwnd';
  if (w.pid !== expected.pid) return 'pid';
  if (!samePath(w.exePath, expected.exePath)) return 'image';
  if (!appForImage(w.exePath, apps)) return 'app';
  if (w.className !== expected.className) return 'class';
  if (w.root !== w.hwnd) return 'not-top-level';
  if (w.owner) return 'owner';
  if (w.exStyle & WS_EX_TOPMOST) return 'topmost';
  return null;
}

/**
 * May this window appear in a choice list? A supported app's top-level window without an owner, visible or minimized,
 * not a tool window, not topmost (not supported in the first version), not cloaked (another virtual desktop, or hidden
 * by DWM; also when that could not be read) and with a title.
 * @param {Observed} w
 */
export function isCandidate(w, apps = APPS) {
  return !!appForImage(w.exePath, apps) && w.root === w.hwnd && !w.owner && (w.visible || w.iconic)
    && !(w.exStyle & WS_EX_TOOLWINDOW) && !(w.exStyle & WS_EX_TOPMOST) && w.cloaked === false && w.title.trim() !== '';
}

/**
 * Where the docked windows are relative to the shell, from the EnumWindows order (top-level windows, topmost first).
 * Only docked windows that are neither minimized nor maximized count (the user's own state is left alone); of those,
 * the lowest in the z-order decides. Reads only.
 * - 'front': all of them are above the shell (or none is listed, the shell is not, or there is no dock area to judge by);
 * - 'under': the lowest is under the shell and no other window between them shows over the dock area, so moving the
 *   shell just beneath it brings them all into view;
 * - 'hidden': some other visible, non-minimized, non-cloaked window overlapping the dock area sits between the shell
 *   and the lowest. Moving the shell beneath it would hide the shell behind that window as well, so the shell is left
 *   where the user put it; a click on an app's tab still docks it.
 * @param {object} ffi @param {number} shell @param {number | number[]} docked @param {object | null} area the dock area in pixels
 * @returns {'front' | 'under' | 'hidden'}
 */
export function dockedPosition(ffi, shell, docked, area) {
  const order = ffi.enumWindows();
  const s = order.indexOf(shell);
  const live = [docked].flat().filter((h) => !ffi.isIconic(h) && !ffi.isZoomed(h));
  const d = Math.max(-1, ...live.map((h) => order.indexOf(h)));
  if (!area || s < 0 || d < 0 || d < s) return 'front';
  for (const h of order.slice(s + 1, d)) {
    if (live.includes(h) || !ffi.isWindowVisible(h) || ffi.isIconic(h) || ffi.isCloaked(h) !== false) continue;
    if (intersects(fromRECT(ffi.getExtendedFrameBounds(h)), area)) return 'hidden';
  }
  return 'under';
}

/**
 * Of the given docked windows, the one highest in the z-order that is not minimized, or null. Right after the shell
 * was activated, that is the docked window just under it: the one the user used last. Reads only.
 */
export function topmostOf(ffi, docked) {
  return ffi.enumWindows().find((h) => docked.includes(h) && !ffi.isIconic(h)) ?? null;
}

/**
 * The choice list: every candidate window, or only one app's (`app` = app id), leaving out windows already bound to a
 * tab (`exclude` = their handles). Each entry carries its app's id and name for the menu.
 * @returns {(Observed & { app: string, appName: string })[]}
 */
export function listCandidates(ffi, { apps = APPS, exclude = [], app = null } = {}) {
  const out = [];
  for (const hwnd of ffi.enumWindows()) {
    if (exclude.includes(hwnd)) continue;
    const o = observe(ffi, hwnd);
    if (!o.ok || !isCandidate(o.window, apps)) continue;
    const a = appForImage(o.window.exePath, apps);
    if (app !== null && a.id !== app) continue;
    out.push({ ...o.window, app: a.id, appName: a.name });
  }
  return out;
}
