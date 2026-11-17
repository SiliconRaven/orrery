// The program paths the user saved in the shell's settings view (docs/desktop.md "应用位置"), and what that view shows
// for each app. Pure: the file's text, the read-only sources and the running windows' program paths come in from
// shell.mjs, which reads and writes app-paths.json in its own data folder (never desktop-state.json). Nothing here
// runs or opens anything; whether a path may be started is decided by lib/locate.mjs checkProgram, at every use.
import { APPS } from './apps.mjs';
import { MAX_PROGRAM_PATH, checkProgram, locateApp } from './locate.mjs';

/** The file's name in the shell's data folder, and the largest file that is read at all (bigger reads as empty). */
export const APP_PATHS_FILE = 'app-paths.json';
export const MAX_APP_PATHS_BYTES = 64 * 1024;

/**
 * @typedef {{ path: string, source: 'picked' | 'detected', savedAt: string }} Saved
 *   picked: chosen in the system's file dialog; detected: found by the shell and confirmed with "使用这个位置"
 */

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * The saved paths in app-paths.json's text, by app id; the file is `{ "version": 1, "apps": { <id>: Saved } }`. Text
 * that is too long, not JSON, of another version or shape reads as no entries; an entry with a field of the wrong type
 * or length is left out; ids not in `apps` and extra fields are dropped. Only the shape is checked here.
 * @param {unknown} text @returns {Record<string, Saved>}
 */
export function parseAppPaths(text, apps = APPS) {
  const out = {};
  if (typeof text !== 'string' || text.length > MAX_APP_PATHS_BYTES) return out;
  let data;
  try { data = JSON.parse(text); } catch { return out; }
  if (!isPlain(data) || data.version !== 1 || !isPlain(data.apps)) return out;
  for (const a of apps) {
    const e = Object.hasOwn(data.apps, a.id) ? data.apps[a.id] : null;
    if (!isPlain(e) || typeof e.path !== 'string' || !e.path || e.path.length > MAX_PROGRAM_PATH
      || (e.source !== 'picked' && e.source !== 'detected') || typeof e.savedAt !== 'string' || e.savedAt.length > 40) continue;
    out[a.id] = { path: e.path, source: e.source, savedAt: e.savedAt };
  }
  return out;
}

/** The file's text for `saved`: known app ids only, the three fields only. */
export function serializeAppPaths(saved, apps = APPS) {
  const out = {};
  for (const a of apps) {
    const e = saved[a.id];
    if (e) out[a.id] = { path: e.path, source: e.source, savedAt: e.savedAt };
  }
  return `${JSON.stringify({ version: 1, apps: out }, null, 2)}\n`;
}

/**
 * @typedef {{ id: string, name: string, msix: boolean,
 *   status: 'saved' | 'invalid' | 'alias' | 'shortcut' | 'window' | 'missing',
 *   inUse: { path: string, source: 'saved' | 'alias' | 'shortcut', icon: string } | null,
 *   saved: (Saved & { ok: boolean, reason?: string }) | null,
 *   offer: { path: string, source: 'shortcut' | 'window' } | null,
 *   reason: string | null }} Row
 *   status: saved: a saved path that passes now; invalid: a saved path that no longer passes (saved.reason; inUse is
 *   then what the system sources give); alias / shortcut: found by the system's own entry; window: not found, but a
 *   window of it runs (its program is offered); missing: none of these.
 *   inUse: what a click in the "+" panel would start now (locate.mjs startTarget). offer: a location found now that
 *   passes checkProgram and differs from inUse, which "使用这个位置" saves (not for MSIX apps). reason: why the
 *   system sources found nothing.
 */

/**
 * One app's row in the settings view, read now. `windowPaths`: program paths of this app's windows running now (read
 * from the windows by the shell; only offered, never saved without the user's click).
 * @param {import('./apps.mjs').App} app @param {Record<string, Saved>} saved
 * @param {Parameters<typeof locateApp>[1] & { lstat(path: string): { file: boolean, link: boolean } | null }} io
 * @param {string[]} windowPaths
 * @returns {Row}
 */
export function settingsRow(app, saved, io, windowPaths) {
  const s = saved[app.id] ?? null;
  const check = s ? checkProgram(app, s.path, io) : null;
  const found = locateApp(app, io);
  const via = app.package ? 'alias' : 'shortcut';
  const passes = (p) => checkProgram(app, p, io).ok;
  const window = app.package ? null : windowPaths.find(passes) ?? null;
  const inUse = check?.ok ? { path: s.path, source: 'saved', icon: s.path } : found.ok ? { path: found.path, source: via, icon: found.icon } : null;
  const offer = app.package ? null : [found.ok ? { path: found.path, source: 'shortcut' } : null, window ? { path: window, source: 'window' } : null]
    .find((o) => o && passes(o.path) && !samePath(o.path, inUse?.path)) ?? null;
  let status = 'missing';
  if (check?.ok) status = 'saved';
  else if (s) status = 'invalid';
  else if (found.ok) status = via;
  else if (window) status = 'window';
  return {
    id: app.id, name: app.name, msix: !!app.package, status, inUse,
    saved: s ? { ...s, ok: check.ok, ...(check.ok ? {} : { reason: check.reason }) } : null,
    offer, reason: found.ok ? null : found.reason,
  };
}

/**
 * The offers the main process holds, by app id: `{ token, path }`, where `token` is an opaque random id the page gets
 * with the row and sends back with "使用这个位置" (it never sends a path). An app whose offered path is exactly the same
 * as before keeps its token; a new or changed offer gets a new one from `mint`; an app without an offer has none. So a
 * click made on an older offer than the current one carries a token that no longer matches.
 * @param {Record<string, { token: string, path: string }>} held @param {Row[]} rows @param {() => string} mint
 * @returns {Record<string, { token: string, path: string }>}
 */
export function issueOffers(held, rows, mint) {
  const out = {};
  for (const r of rows) {
    if (!r.offer) continue;
    const h = held[r.id];
    out[r.id] = h && h.path === r.offer.path ? h : { token: mint(), path: r.offer.path };
  }
  return out;
}

/** An offer token as the main process mints them (crypto.randomUUID: 36 characters, lower-case hex and dashes). */
export const isOfferToken = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);

/** "使用这个位置" from the page: exactly `{ app, token }`, a supported app's id and an offer token, nothing else. */
export const isUseRequest = (v, apps = APPS) => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join() === 'app,token' && apps.some((a) => a.id === v.app) && isOfferToken(v.token);

/**
 * Whether "使用这个位置" may save, decided in the main process: `held` is the offer it held for that app when the click
 * arrived (its token is spent either way), `now` the offer that detection finds again at the click. Saved only when the
 * click's token is that held offer's token and detection still finds exactly its path; then the held path is saved.
 * @param {{ token: string, path: string } | undefined} held @param {string} token
 * @param {{ path: string } | null | undefined} now
 * @returns {{ ok: true, path: string } | { ok: false }}
 */
export function confirmOffer(held, token, now) {
  return held && held.token === token && now && now.path === held.path ? { ok: true, path: held.path } : { ok: false };
}

/** The settings view's window in DIP: up to 560 × 640, under the gear (`anchorX`), inside the shell's content area. */
export const SETTINGS = Object.freeze({ width: 560, height: 640, margin: 4 });
export function settingsBounds(content, anchorX, bar) {
  const { width: w, height: h, margin } = SETTINGS;
  const width = Math.max(200, Math.min(w, content.width - 2 * margin));
  const height = Math.max(160, Math.min(h, content.height - bar - 2 - margin));
  const left = Math.min(Math.max(0, Math.round(anchorX)), content.width - width - margin);
  return { x: content.x + Math.max(margin, left), y: content.y + bar + 2, width, height };
}
