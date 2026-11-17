// The "+" panel of the tab bar (docs/desktop.md): one icon per supported app, what a click on it does, and where the
// panel goes. Pure: the candidate windows come in from lib/windows.mjs listCandidates, the tabs from lib/dock.mjs, the
// start targets from lib/locate.mjs locateApp.
import { APPS } from './apps.mjs';

/** The panel's grid in DIP (ui/strip.css uses the same): one cell per app, the gap between cells, the edge (1 + 6). */
export const PANEL = Object.freeze({ cell: 44, gap: 4, edge: 7, margin: 4 });

/**
 * Where the "+" panel goes, in screen DIP: just under the tab row, its left edge under "+" (`anchorX`, from the content
 * area's left), kept inside the shell's content area. As many columns as fit, rows balanced (8 apps: one row of 8, or
 * two of 4 when only 5 to 7 fit).
 * @param {number} count apps @param {{ x: number, y: number, width: number }} content the shell's content bounds
 * @param {number} anchorX @param {number} bar the tab row's height
 */
export function panelBounds(count, content, anchorX, bar) {
  const { cell, gap, edge, margin } = PANEL;
  const n = Math.max(1, count);
  const fit = Math.max(1, Math.floor((content.width - 2 * margin - 2 * edge + gap) / (cell + gap)));
  const rows = Math.ceil(n / Math.min(n, fit));
  const cols = Math.ceil(n / rows);
  const width = 2 * edge + cols * cell + (cols - 1) * gap;
  const height = 2 * edge + rows * cell + (rows - 1) * gap;
  const left = Math.min(Math.max(0, Math.round(anchorX)), content.width - width - margin);
  return { x: content.x + Math.max(margin, left), y: content.y + bar + 2, width, height };
}

/**
 * @typedef {{ id: string, name: string, windows: number, status: 'add' | 'docked' | 'launch' | 'starting' | 'missing',
 *   reason?: string }} Entry
 *   add: windows of this app not in a tab yet (`windows` of them); docked: every window of it is in a tab already;
 *   launch: not running, a click starts it; starting: started, the shell is watching for its window;
 *   missing: not running and its install was not found (`reason`)
 */

/**
 * What the open or closed "+" panel does on an event: 'open', 'close' or null. Decided from the event and the focus
 * state only, never from clocks, so a press held long or a click that reaches the main process late changes nothing.
 * - 'plus': a click on "+" toggles it. A press on "+" does not close the open panel by itself (the focus moving from the
 *   panel to the shell is not a reason, below), so there is nothing to undo when that press ends.
 * - 'press': a press anywhere else in the shell (the tab bar, the collaboration page) closes it.
 * - 'focus': the panel or the shell lost the focus; read once both windows have handled the switch. It closes only when
 *   neither the shell nor the panel has the focus (another app, a docked window, nothing).
 * @param {boolean} open @param {'plus' | 'press' | 'focus'} event
 * @param {{ shellFocused?: boolean, panelFocused?: boolean }} [focus]
 * @returns {'open' | 'close' | null}
 */
export function panelStep(open, event, { shellFocused = false, panelFocused = false } = {}) {
  if (event === 'plus') return open ? 'close' : 'open';
  if (!open) return null;
  if (event === 'press') return 'close';
  if (event === 'focus') return shellFocused || panelFocused ? null : 'close';
  return null;
}

/** Is `v` the id of a supported app? The only thing the "+" panel may send for a pick. */
export const isAppId = (v, apps = APPS) => typeof v === 'string' && apps.some((a) => a.id === v);

/** Does any tab hold a window of this app? Then it is running, and a click never starts it. */
const docked = (tabs, id) => tabs.some((t) => t.app === id && t.binding);

/**
 * One entry per supported app, in the app table's order.
 * @param {{ app: string }[]} candidates windows not in a tab yet (listCandidates with the bound windows excluded)
 * @param {{ app: string, binding: object | null }[]} tabs
 * @param {{ targets?: Record<string, { ok: boolean, reason?: string }>, starting?: Set<string> }} [launch]
 * @returns {Entry[]}
 */
export function stripEntries(candidates, tabs, { targets = {}, starting = new Set() } = {}, apps = APPS) {
  return apps.map((a) => {
    const windows = candidates.filter((c) => c.app === a.id).length;
    const e = { id: a.id, name: a.name, windows };
    if (starting.has(a.id)) return { ...e, status: 'starting' };   // until its watch ends, even with a window there
    if (windows) return { ...e, status: 'add' };
    if (docked(tabs, a.id)) return { ...e, status: 'docked' };
    const t = targets[a.id];
    return t?.ok ? { ...e, status: 'launch' } : { ...e, status: 'missing', reason: t?.reason ?? '没有找到它的安装' };
  });
}

/**
 * A click on an app's icon, given that app's candidate windows, read by the main process at the click: exactly one
 * goes straight into a new tab; several are offered in a list (by title) for the user to pick; none starts the app,
 * unless a tab holds a window of it already (it is running). While it is being started, a click does nothing.
 * @template C @param {C[]} list
 * @param {{ app: string, binding: object | null }[]} tabs @param {string} id @param {Set<string>} starting
 * @returns {{ add: C } | { choose: C[] } | { launch: true } | null}
 */
export function pickFor(list, tabs, id, starting) {
  if (starting.has(id)) return null;   // its start watch decides about the new window, not a click
  if (list.length === 1) return { add: list[0] };
  if (list.length > 1) return { choose: list };
  return docked(tabs, id) || starting.has(id) ? null : { launch: true };
}
