// A stand-in for lib/win32.mjs's `ffi`, for tests: windows held in memory, and every write call recorded with its
// exact arguments (the interceptor of docs/desktop.md test C). Any access to a function that win32.mjs does not
// export is recorded in `unknown` and throws, so a test notices a call outside the allow-list.

const READS = ['enumWindows', 'getWindowThreadProcessId', 'queryImagePath', 'getClassName', 'getWindowText', 'isWindow',
  'isWindowVisible', 'isIconic', 'isZoomed', 'getWindowLongPtr', 'getAncestor', 'getWindow', 'getWindowRect',
  'getExtendedFrameBounds', 'isCloaked', 'getWindowPlacement', 'getDpiForWindow', 'getLastError'];
const WRITES = ['setWindowPos', 'showWindow', 'setWindowPlacement', 'setForegroundWindow'];

/**
 * A Claude-like window: normal state at (100, 100), 800 × 600. Override any field. `minWidth` / `minHeight`: the
 * smallest visible size the app accepts (SetWindowPos leaves it larger), as some apps do.
 */
export function fakeWindow(over = {}) {
  const hwnd = over.hwnd ?? 0x1000;
  return {
    hwnd, pid: 4000, exePath: 'C:\\Apps\\Claude\\app\\Claude.exe', className: 'Chrome_WidgetWin_1', title: 'Claude',
    visible: true, iconic: false, zoomed: false, exStyle: 0, owner: 0, root: hwnd, cloaked: false,
    normal: { left: 100, top: 100, right: 900, bottom: 700 }, border: 0, destroyed: false, unreadable: false,
    foregroundOk: true, placementOk: true, setPlacementOk: true,
    ...over,
  };
}

export function createFakeFfi(windows = []) {
  const wins = new Map(windows.map((w) => [w.hwnd, w]));
  /** The z-order, topmost first (the order EnumWindows reports): the given order, changed by SetWindowPos. */
  const order = windows.map((w) => w.hwnd);
  const restack = (h, after) => {
    order.splice(order.indexOf(h), 1);
    const i = after === 0 ? -1 : order.indexOf(after);
    order.splice(i + 1, 0, h);
  };
  /** Every write: { fn, hwnd, ...args, tag } — `tag` is whatever the test set in `ffi.tag` (e.g. the user action). */
  const calls = [];
  const unknown = [];
  const get = (h) => { const w = wins.get(h); return w && !w.destroyed ? w : null; };
  const rectOf = (w) => w.rect ?? w.normal;

  const api = {
    windows: wins,
    calls,
    unknown,
    tag: null,
    add(w) { wins.set(w.hwnd, w); order.push(w.hwnd); return w; },
    /** A window comes to the front by itself (the user brought it back): not a write by the shell, not recorded. */
    toTop(h) { restack(h, 0); },

    enumWindows: () => order.filter((h) => !!get(h)),
    isWindow: (h) => !!get(h),
    getWindowThreadProcessId: (h) => get(h)?.pid ?? 0,
    queryImagePath: (pid) => {
      const w = [...wins.values()].find((x) => x.pid === pid && !x.destroyed);
      return w && !w.unreadable ? w.exePath : null;
    },
    getClassName: (h) => get(h)?.className ?? null,
    getWindowText: (h) => get(h)?.title ?? '',
    isWindowVisible: (h) => !!get(h)?.visible,
    isIconic: (h) => !!get(h)?.iconic,
    isZoomed: (h) => !!get(h)?.zoomed,
    getWindowLongPtr: (h, index) => (index === -20 ? get(h)?.exStyle ?? 0 : 0),
    getAncestor: (h) => get(h)?.root ?? 0,
    getWindow: (h) => get(h)?.owner ?? 0,
    getWindowRect: (h) => {
      const w = get(h);
      if (!w) return null;
      const r = rectOf(w);
      return { left: r.left - w.border, top: r.top, right: r.right + w.border, bottom: r.bottom + w.border };
    },
    getExtendedFrameBounds: (h) => { const w = get(h); return w ? { ...rectOf(w) } : null; },
    isCloaked: (h) => (get(h) ? get(h).cloaked : null),
    getWindowPlacement: (h) => {
      const w = get(h);
      if (!w || !w.placementOk) return null;
      return {
        flags: w.zoomed && w.iconic ? 2 : 0, showCmd: w.iconic ? 2 : w.zoomed ? 3 : 1,
        ptMinPosition: { x: -1, y: -1 }, ptMaxPosition: { x: -1, y: -1 }, rcNormalPosition: { ...w.normal },
      };
    },
    getDpiForWindow: () => 96,
    getLastError: () => 5,

    setWindowPos(h, after, x, y, cx, cy, flags) {
      calls.push({ fn: 'SetWindowPos', hwnd: h, after, x, y, cx, cy, flags, tag: api.tag });
      const w = get(h);
      if (!w) return false;
      if (!(flags & 0x4)) restack(h, after);   // z-order: right after `after`, or to the top for HWND_TOP (0)
      if (!(flags & 0x2) && !(flags & 0x1)) {   // moved and sized: the visible frame is the rect minus the border
        const width = Math.max(cx - 2 * w.border, w.minWidth ?? 0);
        const height = Math.max(cy - w.border, w.minHeight ?? 0);
        w.rect = { left: x + w.border, top: y, right: x + w.border + width, bottom: y + height };
        w.normal = { ...w.rect };
      }
      return true;
    },
    showWindow(h, cmd) {
      calls.push({ fn: 'ShowWindow', hwnd: h, cmd, tag: api.tag });
      const w = get(h);
      if (!w) return false;
      if (cmd === 9) { if (w.iconic) w.iconic = false; else w.zoomed = false; }
      if (cmd === 7) w.iconic = true;
      return true;
    },
    setWindowPlacement(h, wp) {
      calls.push({ fn: 'SetWindowPlacement', hwnd: h, placement: structuredClone(wp), tag: api.tag });
      const w = get(h);
      if (!w || !w.setPlacementOk) return false;
      w.normal = { ...wp.rcNormalPosition };
      delete w.rect;
      w.iconic = wp.showCmd === 2 || wp.showCmd === 7 || wp.showCmd === 6;
      w.zoomed = wp.showCmd === 3 || (w.iconic && !!(wp.flags & 2));
      return true;
    },
    setForegroundWindow(h) {
      calls.push({ fn: 'SetForegroundWindow', hwnd: h, tag: api.tag });
      const ok = !!get(h)?.foregroundOk;
      if (ok) restack(h, 0);   // activation brings it to the front
      return ok;
    },
  };
  for (const name of [...READS, ...WRITES]) if (typeof api[name] !== 'function') throw new Error(`fake is missing ${name}`);
  return new Proxy(api, {
    get(target, key) {
      if (typeof key === 'string' && !(key in target)) {
        unknown.push(key);
        throw new Error(`fake ffi has no ${key}`);
      }
      return target[key];
    },
  });
}

export const FFI_READS = READS;
export const FFI_WRITES = WRITES;
