// Geometry for docking (docs/desktop.md "停靠细节"): where the dock area is, DIP → physical pixels on the orrery
// window's display, and which geometry values may be used at all. Pure functions, no imports.
//
// Rect: { x, y, width, height } (DIP or pixels). RECT: Win32's { left, top, right, bottom } in pixels.

const finite = (...values) => values.every((v) => typeof v === 'number' && Number.isFinite(v));

/** Usable as a window rect: finite numbers, positive width and height. Negative x / y are fine (a display to the left or above). */
export function isRect(r) {
  return !!r && finite(r.x, r.y, r.width, r.height) && r.width > 0 && r.height > 0;
}

/**
 * Height of the shell's single top row in DIP: the orrery mark, the tabs and +, and the system's caption buttons
 * (Electron's title bar overlay) share it. shell.mjs and ui/tabs.css use the same value.
 */
export const TAB_BAR_HEIGHT = 44;

/**
 * The dock area: the content area of the orrery window below the tab bar (all DIP). The window has no separate title
 * bar (it is hidden; the tab row is the title row), so the content area starts at the top of the window.
 */
export function dockArea(content, barHeight) {
  return { x: content.x, y: content.y + barHeight, width: content.width, height: content.height - barHeight };
}

/**
 * DIP → physical pixels on one display. `display` = { dip: the display's bounds in DIP, px: the same bounds in pixels,
 * scale }. Edges are rounded, not sizes, so the result lines up with the display's pixel grid at 125 % or 150 %.
 * Returns null when the input is not a usable rect.
 */
export function toPhysical(rect, display) {
  if (!isRect(rect) || !isRect(display?.dip) || !isRect(display?.px) || !finite(display.scale) || display.scale <= 0) return null;
  const { dip, px, scale } = display;
  const x = (v) => Math.round(px.x + (v - dip.x) * scale);
  const y = (v) => Math.round(px.y + (v - dip.y) * scale);
  const left = x(rect.x);
  const top = y(rect.y);
  const out = { x: left, y: top, width: x(rect.x + rect.width) - left, height: y(rect.y + rect.height) - top };
  return isRect(out) ? out : null;
}

/** Do two usable rects overlap (by more than an edge)? */
export function intersects(a, b) {
  return isRect(a) && isRect(b) && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** RECT → Rect, or null when it is not a usable rect. */
export function fromRECT(r) {
  if (!r || !finite(r.left, r.top, r.right, r.bottom)) return null;
  const out = { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  return isRect(out) ? out : null;
}

/**
 * The rect to hand to SetWindowPos so that the window's visible frame covers `visible`. Windows with a native frame
 * have invisible resize borders: GetWindowRect is larger than the DWM extended frame bounds. Borders that are missing,
 * negative or implausibly wide (more than 64 px) count as zero.
 */
export function outerRect(visible, windowRECT, frameRECT) {
  let l = 0; let t = 0; let r = 0; let b = 0;
  if (fromRECT(windowRECT) && fromRECT(frameRECT)) {
    const m = [frameRECT.left - windowRECT.left, frameRECT.top - windowRECT.top, windowRECT.right - frameRECT.right, windowRECT.bottom - frameRECT.bottom];
    if (m.every((v) => v >= 0 && v <= 64)) [l, t, r, b] = m;
  }
  return { x: visible.x - l, y: visible.y - t, width: visible.width + l + r, height: visible.height + t + b };
}

/**
 * A WINDOWPLACEMENT that may be recorded and later written back: integer show command 0–11, finite points, and a
 * normal-position RECT with positive width and height (negative coordinates allowed).
 */
export function validPlacement(wp) {
  if (!wp || typeof wp !== 'object') return false;
  const { flags, showCmd, ptMinPosition: mn, ptMaxPosition: mx, rcNormalPosition: rc } = wp;
  return Number.isInteger(flags) && Number.isInteger(showCmd) && showCmd >= 0 && showCmd <= 11
    && !!mn && !!mx && finite(mn.x, mn.y, mx.x, mx.y) && fromRECT(rc) !== null;
}

/** Split view (docs/desktop.md "分屏"): the layouts and how many panes each has, in pane order. */
export const PANE_COUNT = Object.freeze({ single: 1, columns: 2, grid: 4 });
/** The slit between panes in DIP: room to grab a divider and to draw the active-pane mark. */
export const PANE_GAP = 6;
/** No pane narrower or lower than this share of the dock area. */
export const MIN_RATIO = 0.15;

/**
 * The panes of `area` (pixels or DIP; edges rounded) for a layout: single = the area; columns = left, right; grid =
 * top left, top right, bottom left, bottom right. `ratios.x` is the left column's share of the width without the gap,
 * `ratios.y` the top row's share of the height (grid only). The tab bar draws the same split with CSS.
 */
export function paneRects(area, layout, ratios, gap) {
  const split = (start, size, two, r) => {
    if (!two) return [[start, size]];
    const first = Math.round((size - gap) * r);
    return [[start, first], [start + first + gap, size - first - gap]];
  };
  const xs = split(area.x, area.width, layout !== 'single', ratios.x);
  const ys = split(area.y, area.height, layout === 'grid', ratios.y);
  return ys.flatMap(([y, height]) => xs.map(([x, width]) => ({ x, y, width, height })));
}
