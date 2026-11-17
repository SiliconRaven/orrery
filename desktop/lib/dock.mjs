// Tab state machine of the desktop shell (docs/desktop.md). Pure: `step` turns a user action or an event of the orrery
// window into a new state plus a list of window operations; `runOps` hands those to the writer (lib/writer.mjs), the
// only place that touches Win32. Imports neither Electron nor the FFI library.
//
// A tab is bound to one window instance the user picked, or unbound ("需要重新选择"). A binding holds the window's
// identity and the WINDOWPLACEMENT read when it was taken over; that placement lives only in memory, belongs to this
// binding only and is never overwritten by switching or following. Nothing about windows is saved: after a restart
// every tab is unbound, and only the user's pick binds it again, even when there is a single candidate.
//
// Split view ("分屏"): the dock area is one pane (single), two columns, or a 2 × 2 grid. Each pane shows one tab (an
// app tab or the collaboration page, ORRERY) or nothing; a tab is in at most one pane. One pane is active: a click on
// a tab puts that tab there. Window operations only ever go to windows shown in a pane, except the one minimize of a
// window that leaves its pane, and put-backs.
import { APPS, fileName } from './apps.mjs';
import { MIN_RATIO, PANE_COUNT, paneRects } from './geometry.mjs';

export const ORRERY = 'orrery';
export const LAYOUTS = Object.freeze(Object.keys(PANE_COUNT));
const MAX_RATIO = 1 - MIN_RATIO;

/**
 * @typedef {import('./windows.mjs').Identity} Identity
 * @typedef {Identity & { id: number, placement: object, min?: { width: number, height: number } }} Binding
 *   min: the smallest visible size seen so far after placing it (the app would not shrink further), in pixels
 * @typedef {{ id: string, app: string, exe: string, title: string, binding: Binding | null }} Tab
 * @typedef {{ layout: 'single' | 'columns' | 'grid', ratios: { x: number, y: number }, panes: (string | null)[],
 *   active: number, minimized: boolean, closed: boolean, nextTab: number, nextBinding: number, tabs: Tab[] }} State
 *   panes: tab id, ORRERY or null (empty) per pane; active: index into panes
 * @typedef {import('./writer.mjs').WindowOp} WindowOp
 * @typedef {{ rect: object | null, gap?: number,
 *   capture(c: Identity): { ok: true, placement: object } | { ok: false, reason: string },
 *   dockedPosition?(hwnds: number[]): 'front' | 'under' | 'hidden', topmost?(hwnds: number[]): number | null,
 *   verify?(b: Binding): string | null }} Env
 *   rect: the dock area in pixels; gap: the slit between panes in pixels; dockedPosition, topmost: lib/windows.mjs (reads);
 *   verify: the writer's identity check (a read), null when the window is still the bound instance
 */

/** Tabs from desktop-state.json: app id, image file name and last title only. Anything else is ignored. */
export function loadTabs(json, apps = APPS) {
  const list = json && json.version === 1 && Array.isArray(json.tabs) ? json.tabs : [];
  return list
    .filter((t) => t && apps.some((a) => a.id === t.app) && typeof t.exe === 'string' && typeof t.title === 'string')
    .map((t) => ({ app: t.app, exe: fileName(t.exe).slice(0, 260), title: t.title.slice(0, 300) }));
}

const isRatio = (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_RATIO && v <= MAX_RATIO;

/** Layout and divider positions from desktop-state.json; anything not valid gives the defaults (single, 0.5). */
export function loadLayout(json) {
  const v1 = !!json && json.version === 1;
  const r = v1 ? json.ratios : null;
  return {
    layout: v1 && LAYOUTS.includes(json.layout) ? json.layout : 'single',
    ratios: r && typeof r === 'object' && isRatio(r.x) && isRatio(r.y) ? { x: r.x, y: r.y } : { x: 0.5, y: 0.5 },
  };
}

/** What desktop-state.json keeps: tabs, layout and divider positions. No window handles, no positions, no pane contents. */
export function savedState(state) {
  return { version: 1, layout: state.layout, ratios: { x: state.ratios.x, y: state.ratios.y },
    tabs: state.tabs.map((t) => ({ app: t.app, exe: t.exe, title: t.title })) };
}

/** After a start: the collaboration page in the first pane, the others empty, the first one active. @returns {State} */
export function initialState(saved = [], { layout = 'single', ratios = { x: 0.5, y: 0.5 } } = {}) {
  const tabs = saved.map((t, i) => ({ id: `t${i + 1}`, app: t.app, exe: t.exe, title: t.title, binding: null }));
  const panes = [ORRERY, ...Array(PANE_COUNT[layout] - 1).fill(null)];
  return { layout, ratios: { ...ratios }, panes, active: 0, minimized: false, closed: false, nextTab: tabs.length + 1, nextBinding: 1, tabs };
}

/** The tab bar's view of the state (titles are rendered as plain text there). */
export function view(state, apps = APPS) {
  return {
    selected: state.panes[state.active] ?? null,
    layout: state.layout,
    ratios: state.ratios,
    panes: state.panes,
    active: state.active,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      app: t.app,
      name: apps.find((a) => a.id === t.app)?.name ?? t.app,
      title: t.title,
      status: t.binding ? 'bound' : 'choose',
      inPane: state.panes.includes(t.id),
    })),
  };
}

const op = (kind, tab, trigger, extra = {}) => ({ op: kind, tab: tab.id, app: tab.app, binding: tab.binding, trigger, ...extra });
const bound = (state, id) => state.tabs.find((t) => t.id === id && t.binding) ?? null;
/** The bound tabs shown in a pane, with their pane index, in pane order. */
const shown = (state) => state.panes.flatMap((id, i) => { const tab = bound(state, id); return tab ? [{ tab, i }] : []; });
/** The panes' rects in pixels, or null when the dock area is not known. */
const rectsOf = (state, env) => (env.rect ? paneRects(env.rect, state.layout, state.ratios, env.gap ?? 0) : null);
/** The shell's own window beneath `tab`'s window, or beneath the lowest of all shown windows (the writer reads which). */
const lowerShell = (state, tab, trigger) => op('lowerShell', tab, trigger, { others: shown(state).filter((s) => s.tab.id !== tab.id).map((s) => s.tab.binding) });
const firstEmpty = (panes) => Math.max(0, panes.indexOf(null));

function tooSmall(state, tab, apps) {
  const name = apps.find((a) => a.id === tab.app)?.name ?? tab.app;
  return { tab: tab.id, text: `${name} 的窗口缩不到这么小，会盖住旁边一栏。可以拖动分隔线，或换成${state.layout === 'grid' ? '两栏' : '单栏'}。` };
}

/**
 * Shows `id` (a bound tab, or ORRERY) in a pane: the pane it is already in, else the active pane, replacing what was
 * there. That pane becomes active. A bound window is docked first, then the window it replaced is minimized. In this
 * order the old window is never minimized while it is still the active one with nothing docked in front, so Windows
 * does not hand the activation to the shell, which would come up over the new window.
 */
function selectTab(state, id, trigger, env) {
  const at = state.panes.indexOf(id);
  const target = at >= 0 ? at : state.active;
  const replaced = at >= 0 ? null : bound(state, state.panes[target]);
  const next = { ...state, panes: at >= 0 ? state.panes : state.panes.with(target, id), active: target };
  const ops = [];
  const notices = [];
  const tab = bound(next, id);
  if (tab) {
    const rect = rectsOf(next, env)?.[target];
    if (rect) {
      // Then the shell's own window goes beneath the docked windows, whether or not Windows granted the foreground switch.
      ops.push(op('restore', tab, trigger), op('place', tab, trigger, { rect }), op('foreground', tab, trigger), lowerShell(next, tab, trigger));
    } else {
      notices.push({ tab: id, text: 'orrery 窗口的内容区算不出可用的位置，没有移动应用窗口。' });
    }
  }
  if (replaced) ops.push(op('minimize', replaced, trigger));
  return { state: next, ops, notices };
}

/** Checks a picked candidate and reads its placement; a binding exists only if both succeed. */
function bind(state, tabId, candidate, env) {
  if (state.tabs.some((t) => t.binding?.hwnd === candidate.hwnd)) {
    return { error: '这个窗口已经在另一个标签里了。' };
  }
  const got = env.capture(candidate);
  if (!got.ok) return { error: `没有接管这个窗口（${got.reason}）：它可能已经关了或变了，也可能读不到它原来的位置。` };
  const { hwnd, pid, exePath, className } = candidate;
  return { binding: { id: state.nextBinding, hwnd, pid, exePath, className, placement: got.placement } };
}

/**
 * A new layout. Growing: the panes keep their content, the new ones are empty, and the first empty pane becomes
 * active. Shrinking: the filled panes in order, as many as fit, but always the active pane's content (the last other
 * ones are dropped first), moved into the new panes from the first on; the active pane follows its content. A dropped
 * app window is minimized, a dropped collaboration page is just not shown. A single pane is never empty: it shows the
 * collaboration page then.
 */
function changeLayout(state, layout, env, apps) {
  const n = PANE_COUNT[layout];
  let panes;
  let active;
  if (n >= state.panes.length) {
    panes = [...state.panes, ...Array(n - state.panes.length).fill(null)];
    active = n > state.panes.length ? firstEmpty(panes) : state.active;
  } else {
    const keep = state.panes.map((id, i) => ({ id, i })).filter((p) => p.id !== null);
    while (keep.length > n) keep.splice(keep.findLastIndex((p) => p.i !== state.active), 1);
    panes = [...keep.map((p) => p.id), ...Array(n - keep.length).fill(null)];
    active = keep.findIndex((p) => p.i === state.active);
    if (active < 0) active = firstEmpty(panes);
    if (n === 1 && panes[0] === null) panes = [ORRERY];
  }
  const next = { ...state, layout, panes, active };
  const rects = rectsOf(next, env);
  const ops = rects ? shown(next).map(({ tab, i }) => op('place', tab, 'layout', { rect: rects[i] })) : [];
  for (const id of state.panes) {
    const tab = bound(state, id);
    if (tab && !panes.includes(id)) ops.push(op('minimize', tab, 'layout'));
  }
  // A window known not to shrink that far (seen before) will cover part of the next pane: say so.
  const tight = rects && shown(next).find(({ tab, i }) => tab.binding.min
    && (tab.binding.min.width > rects[i].width + 2 || tab.binding.min.height > rects[i].height + 2));
  return { state: next, ops, notices: tight && layout !== 'single' ? [tooSmall(next, tight.tab, apps)] : [] };
}

/**
 * Divider positions: 15–85 % of the dock area, and no pane smaller than the smallest size seen for the window in it.
 * When both sides cannot have that, the left column or top row gets it.
 */
function clampRatios(state, want, env) {
  const min = (panes, key) => Math.max(0, ...panes.map((i) => bound(state, state.panes[i])?.binding.min?.[key] ?? 0));
  const fit = (v, size, first, second) => {
    let lo = MIN_RATIO;
    let hi = MAX_RATIO;
    if (size > 0) { lo = Math.max(lo, first / size); hi = Math.min(hi, 1 - second / size); }
    return Math.min(MAX_RATIO, Math.max(lo, Math.min(hi, v)));
  };
  const gap = env.gap ?? 0;
  const w = env.rect ? env.rect.width - gap : 0;
  const h = env.rect ? env.rect.height - gap : 0;
  return {
    x: fit(want.x, w, min([0, 2], 'width'), min([1, 3], 'width')),
    y: state.layout === 'grid' ? fit(want.y, h, min([0, 1], 'height'), min([2, 3], 'height')) : state.ratios.y,
  };
}

/**
 * @param {State} state
 * @param {{ type: string, [k: string]: any }} event
 * @param {Env} env
 * @returns {{ state: State, ops: WindowOp[], notices: { tab?: string, text: string }[] }}
 */
export function step(state, event, env, apps = APPS) {
  const none = { state, ops: [], notices: [] };
  if (state.closed) return none;

  switch (event.type) {
    case 'add': {   // the user picked a window in the + list (built by the main process)
      const c = event.candidate;
      const app = apps.find((a) => a.id === c?.app);
      if (!app) return none;
      const b = bind(state, null, c, env);
      if (b.error) return { ...none, notices: [{ text: b.error }] };
      const tab = { id: `t${state.nextTab}`, app: app.id, exe: fileName(c.exePath), title: c.title, binding: b.binding };
      const next = { ...state, nextTab: state.nextTab + 1, nextBinding: state.nextBinding + 1, tabs: [...state.tabs, tab] };
      return selectTab(next, tab.id, 'add', env);
    }
    case 'choose': {   // the user picked a window for an unbound tab, in that app's list
      const tab = state.tabs.find((t) => t.id === event.id);
      const c = event.candidate;
      if (!tab || tab.binding || c?.app !== tab.app) return none;
      const b = bind(state, tab.id, c, env);
      if (b.error) return { ...none, notices: [{ tab: tab.id, text: b.error }] };
      const tabs = state.tabs.map((t) => (t.id === tab.id ? { ...t, title: c.title, binding: b.binding } : t));
      return selectTab({ ...state, nextBinding: state.nextBinding + 1, tabs }, tab.id, 'choose', env);
    }
    case 'select':
      // An unbound tab is not selected here: the main process opens its choice list instead.
      return event.id === ORRERY || bound(state, event.id) ? selectTab(state, event.id, 'select', env) : none;
    case 'activate': {   // the user clicked a pane (the collaboration page, an empty pane, the hint behind a window)
      const i = event.pane;
      return Number.isInteger(i) && i >= 0 && i < state.panes.length && i !== state.active ? { ...none, state: { ...state, active: i } } : none;
    }
    case 'layout':   // the user picked a layout in the layout menu
      return LAYOUTS.includes(event.layout) && event.layout !== state.layout ? changeLayout(state, event.layout, env, apps) : none;
    case 'ratios': {   // the user dragged a divider
      if (state.layout === 'single' || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return none;
      const ratios = clampRatios(state, event, env);
      if (ratios.x === state.ratios.x && ratios.y === state.ratios.y) return none;
      const next = { ...state, ratios };
      const rects = rectsOf(next, env);
      return { state: next, ops: rects ? shown(next).map(({ tab, i }) => op('place', tab, 'ratios', { rect: rects[i] })) : [], notices: [] };
    }
    case 'close': {
      const tab = state.tabs.find((t) => t.id === event.id);
      if (!tab) return none;
      const ops = tab.binding ? [op('putBack', tab, 'close', { placement: tab.binding.placement })] : [];
      const tabs = state.tabs.filter((t) => t.id !== tab.id);
      // Its pane becomes empty (not refilled); the single pane shows the collaboration page instead, as before split view.
      const at = state.panes.indexOf(tab.id);
      const panes = at < 0 ? state.panes : state.panes.with(at, state.layout === 'single' ? ORRERY : null);
      return { state: { ...state, tabs, panes }, ops, notices: [] };
    }
    case 'quit': {   // the shell closes (trigger 'quit') or the Hub quit from the web page ('shutdown')
      const trigger = event.trigger === 'shutdown' ? 'shutdown' : 'quit';
      const ops = state.tabs.filter((t) => t.binding).map((t) => op('putBack', t, trigger, { placement: t.binding.placement }));
      const tabs = state.tabs.map((t) => ({ ...t, binding: null }));
      return { state: { ...state, closed: true, tabs }, ops, notices: [] };
    }
    case 'bounds': {   // the orrery window moved, was resized, maximized or unmaximized
      const rects = state.minimized ? null : rectsOf(state, env);
      return rects ? { ...none, ops: shown(state).map(({ tab, i }) => op('place', tab, 'bounds', { rect: rects[i] })) } : none;
    }
    case 'focus':     // the orrery window was activated
    case 'restack': {
      // The shell came up over the docked windows: it was activated ('focus'), or it was brought to the top while
      // already active, which sends no 'focus' (a click, a drag or resize from the tab row or a border), or a tab
      // action has just settled, or a menu closed ('restack'). Then the shell's own window goes back beneath the
      // docked windows (lowerShell), but only when nothing else shows between them over the dock area: otherwise the
      // shell would end up hidden too, and it stays where the user put it ('hidden'). The app windows themselves are
      // not raised: on a real machine that did not bring them back, which fits the SetWindowPos documentation
      // (bringing a window to the top needs foreground permission for its process).
      if (state.minimized) return none;
      let next = state;
      const notices = [];
      // Only windows that are still the bound instances take part in the z-order reads. One that is not (another
      // process, an owner now, …) is unbound right here, as the writer would, and from then on counts like any other
      // window: over the dock area between the shell and the docked windows it keeps the shell from being lowered.
      const stale = env.verify ? shown(state).flatMap(({ tab }) => {
        const reason = env.verify(tab.binding);
        return reason ? [{ tab: tab.id, app: tab.app, binding: tab.binding, op: event.type, trigger: event.type, reason }] : [];
      }) : [];
      if (stale.length) {
        const l = step(state, { type: 'lost', lost: stale }, env, apps);
        next = l.state;
        notices.push(...l.notices);
      }
      // Activated in split view: the valid docked window highest in the z-order (just under the shell now) is taken
      // as the one the user used last, and its pane becomes the active one. A z-order reading, not a record of the
      // last input: a click inside an app window is not seen otherwise.
      if (event.type === 'focus' && next.layout !== 'single' && env.topmost) {
        const list = shown(next);
        const top = env.topmost(list.map((s) => s.tab.binding.hwnd));
        const hit = list.find((s) => s.tab.binding.hwnd === top);
        if (hit && hit.i !== next.active) next = { ...next, active: hit.i };
      }
      const list = shown(next);
      if (!list.length || env.dockedPosition?.(list.map((s) => s.tab.binding.hwnd)) !== 'under') return { state: next, ops: [], notices };
      const anchor = (list.find((s) => s.i === next.active) ?? list[0]).tab;
      // The writer checks the reference it picks once more, right before the write.
      return { state: next, ops: [lowerShell(next, anchor, event.type)], notices };
    }
    case 'minimize':
      return { state: { ...state, minimized: true }, ops: state.minimized ? [] : shown(state).map(({ tab }) => op('minimize', tab, 'minimize')), notices: [] };
    case 'restore': {   // the user restored the orrery window: every shown window comes back, the active pane's last (in front)
      const rects = rectsOf(state, env);
      const list = shown(state).sort((a, b) => Number(a.i === state.active) - Number(b.i === state.active));
      const ops = state.minimized && rects
        ? list.flatMap(({ tab, i }) => [op('restore', tab, 'restore'), op('place', tab, 'restore', { rect: rects[i] })]) : [];
      return { state: { ...state, minimized: false }, ops, notices: [] };
    }
    case 'lost': {   // the writer found a bound window gone or changed: drop that binding (and its placement)
      const gone = new Set((event.lost ?? []).map((l) => l.binding.id));
      const tabs = state.tabs.map((t) => (t.binding && gone.has(t.binding.id) ? { ...t, binding: null } : t));
      const notices = state.tabs.filter((t) => t.binding && gone.has(t.binding.id))
        .map((t) => ({ tab: t.id, text: '窗口已经关了或身份变了，需要重新选择。orrery 没有再动它。' }));
      // A tab closed in the same step is no longer in the state, so its failed put-back is reported here, once.
      // (Quitting the shell reports its own list, and this step is not reached once the shell is closing.)
      for (const l of event.lost ?? []) {
        if (l.op !== 'putBack' || l.trigger !== 'close' || state.tabs.some((t) => t.id === l.tab)) continue;
        const name = apps.find((a) => a.id === l.app)?.name ?? '这个应用';
        notices.push({ tab: l.tab, text: `${name} 的窗口已经关了或不是原来那个了（${l.reason}），关标签时没有把它还原。orrery 没有动它。` });
      }
      return { state: { ...state, tabs }, ops: [], notices };
    }
    case 'observed': {   // placed windows that stayed larger than asked: remember that size for this binding (memory only)
      const seen = new Map((event.observed ?? []).map((o) => [o.binding.id, o]));
      let grew = null;
      const tabs = state.tabs.map((t) => {
        const o = t.binding && seen.get(t.binding.id);
        if (!o) return t;
        const old = t.binding.min ?? { width: 0, height: 0 };
        const min = { width: Math.max(old.width, o.width), height: Math.max(old.height, o.height) };
        if (min.width === old.width && min.height === old.height) return t;
        grew ??= t;
        return { ...t, binding: { ...t.binding, min } };
      });
      return { state: { ...state, tabs }, ops: [], notices: grew && state.layout !== 'single' ? [tooSmall(state, grew, apps)] : [] };
    }
    default:
      return none;
  }
}

/**
 * Is `op` still meant to run? A put-back always (its binding was retired in the same step); any other operation only
 * while its binding is still in `state`, the shell is not closing, and (except a minimize) its tab is shown in a pane.
 * Guards against a queued follow-up that would run after the window was put back or left its pane.
 */
export const liveIn = (state) => (o) => {
  if (o.op === 'putBack') return true;
  const tab = state.closed ? null : state.tabs.find((t) => t.binding && t.binding.id === o.binding.id);
  return !!tab && (o.op === 'minimize' || state.panes.includes(tab.id));
};

/**
 * Runs the operations in order through `write`. After a window is reported lost, the rest of its operations are
 * skipped; other windows carry on (one failed put-back does not stop the others). `observed`: windows that stayed
 * larger than the pane they were placed in.
 */
export function runOps(ops, write, isLive = () => true) {
  const lostIds = new Set();
  const lost = [];
  const failures = [];
  const observed = [];
  for (const o of ops) {
    if (lostIds.has(o.binding.id) || !isLive(o)) continue;
    const r = write(o);
    if (r.status === 'lost') {
      lostIds.add(o.binding.id);
      lost.push({ tab: o.tab, app: o.app, binding: o.binding, op: o.op, trigger: o.trigger, reason: r.reason });
    } else if (r.status !== 'ok') {
      failures.push({ tab: o.tab, op: o.op, trigger: o.trigger, ...r });
    } else if (r.observed) {
      observed.push({ tab: o.tab, binding: o.binding, ...r.observed });
    }
  }
  return { lost, failures, observed };
}

/** What the writer found, back into the state: lost windows unbound, sizes seen remembered. */
export function afterOps(state, out, env, apps = APPS) {
  let s = state;
  const notices = [];
  for (const type of ['lost', 'observed']) {
    if (!out[type]?.length) continue;
    const r = step(s, { type, [type]: out[type] }, env, apps);
    s = r.state;
    notices.push(...r.notices);
  }
  return { state: s, notices };
}
