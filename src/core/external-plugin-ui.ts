// A third-party plugin's own web UI (docs/external-plugins.md「网页界面」): the manifest's `ui` declaration, the static
// files of its `ui/` folder and the policy every one of them is served with, and the bounds of the one channel between
// a frame and its plugin process. The frame is a sandboxed iframe (allow-scripts only) on the collaboration page; it
// talks to the page only through postMessage, the page to the Hub through its authenticated API. Pure except for the
// file reads, which never follow a link and never leave `ui/`.
import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { cleanText } from './external-plugin-commands.ts';

/** The two places a plugin's own frame may appear: a chip with a popover panel in the cluster's title bar, a workbench tab. */
export const FRAME_POSITIONS = ['titlebar', 'workbench'] as const;
export type FramePosition = typeof FRAME_POSITIONS[number];
/**
 * Every position a manifest may declare and a user grant: the two frame positions, and `marks` (small host-drawn marks on
 * messages, members and tasks, no frame: host.ui.mark).
 */
export const UI_POSITIONS = [...FRAME_POSITIONS, 'marks'] as const;
export type UiPosition = typeof UI_POSITIONS[number];
/** What a mark may sit on, and the states it may show (none, or one of these). */
export const MARK_TARGETS = ['message', 'member', 'task'] as const;
export type MarkTarget = typeof MARK_TARGETS[number];
export const MARK_STATES = ['running', 'done', 'failed', 'info'] as const;

/**
 * The bounds of plugin UIs. Files: one `ui/` folder, at most maxFiles files and maxTotalBytes together, each at most
 * maxFileBytes (checked when a frame opens, and each file again when it is read). The channel: a request or push
 * carries at most maxDataBytes of JSON; a request waits at most requestTimeoutMs (a timeout fails only that request,
 * never the plugin); the rates are sliding one-minute windows per plugin. maxFramesPerPlugin open frames per plugin
 * (all pages together); opening one more closes the oldest.
 */
export const UI_LIMITS = Object.freeze({
  panelHeight: Object.freeze({ min: 200, max: 480, default: 320 }),
  chipText: 24,
  markText: 16,
  markTip: 80,
  marksPerPluginPerCluster: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxFiles: 200,
  maxDepth: 8,
  maxDataBytes: 16 * 1024,
  requestTimeoutMs: 10_000,
  requestsPerPluginPerMinute: 120,
  inFlightPerPlugin: 4,
  pushesPerPluginPerMinute: 120,
  maxFramesPerPlugin: 16,
  maxErrorText: 300,
});

/** The manifest's `ui`: the positions it can show in and the popover panel's height (the title bar position only). */
export interface ExternalUi { positions: UiPosition[]; panelHeight: number }

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** `{"positions": ["titlebar", "workbench"], "panelHeight"?: 200..480}`: strict, like the rest of the manifest. */
export function parseUi(value: unknown, pluginId: string): ExternalUi {
  const bad = (what: string) => new Error(`plugin ${pluginId}: invalid ui ${what}`);
  if (!isObject(value) || Object.keys(value).some((key) => !['positions', 'panelHeight'].includes(key))) throw bad('declaration');
  const positions = value.positions;
  if (!Array.isArray(positions) || !positions.length || positions.some((p) => !(UI_POSITIONS as readonly unknown[]).includes(p))
    || new Set(positions).size !== positions.length) throw bad('positions');
  const height = value.panelHeight ?? UI_LIMITS.panelHeight.default;
  if (typeof height !== 'number' || !Number.isInteger(height) || height < UI_LIMITS.panelHeight.min || height > UI_LIMITS.panelHeight.max) {
    throw bad(`panelHeight (an integer from ${UI_LIMITS.panelHeight.min} to ${UI_LIMITS.panelHeight.max})`);
  }
  return { positions: [...positions] as UiPosition[], panelHeight: height };
}

/** The granted positions in an installation entry: declared ones only, no duplicates. */
export function parseUiGrant(value: unknown, declared: readonly UiPosition[] | undefined, pluginId: string): UiPosition[] {
  if (!Array.isArray(value) || value.some((p) => typeof p !== 'string') || new Set(value).size !== value.length) {
    throw new Error(`plugin ${pluginId}: invalid ui grant`);
  }
  if (value.some((p) => !declared?.includes(p as UiPosition))) throw new Error(`plugin ${pluginId}: ui grant was not declared by its manifest`);
  return [...value] as UiPosition[];
}

/** The only file types served from `ui/`, with the type each is served as (never sniffed: nosniff). */
const UI_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);
/**
 * A path segment as the URL may name it: starts with a letter, digit or `_`, then letters, digits, `_`, `-` and `.`, no
 * trailing dot (Windows would drop it), at most 100 characters. So no `..`, no hidden files, no drive, colon (alternate
 * data stream), backslash, `~` (8.3 names) or encoded slash survives.
 */
const SEGMENT = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-])?$/;
/** Device names Windows resolves in any folder (`con.js` is the console). */
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;
const UI_ENTRY = 'index.html';

/** The URL's path segments after the frame prefix, decoded once and checked; null for anything not allowed. */
export function uiSegments(rest: string): string[] | null {
  if (!rest || rest.length > 400) return null;
  const segments: string[] = [];
  for (const raw of rest.split('/')) {
    let segment: string;
    try { segment = decodeURIComponent(raw); } catch { return null; }
    if (!SEGMENT.test(segment) || RESERVED.test(segment)) return null;
    segments.push(segment);
  }
  if (segments.length > UI_LIMITS.maxDepth || !UI_TYPES.has(extname(segments.at(-1)!).toLowerCase())) return null;
  return segments;
}

const statOrNull = (path: string): Stats | null => { try { return lstatSync(path); } catch { return null; } };
const inside = (root: string, path: string) => path.startsWith(root + sep);

/**
 * The files of a `ui/` folder as checkUiFolder found it whole (`a/b.js` → its size and modification time): a file is
 * served only while it is still exactly this, so every file a frame gets belongs to a folder that passed the caps.
 */
export type UiListing = ReadonlyMap<string, { size: number; mtimeMs: number }>;

/**
 * One file of a plugin's `ui/` folder, read now, decided in this order:
 *   1. on disk: `ui/` itself and every folder on the way are real folders and the file a regular file (lstat: a symbolic
 *      link or junction anywhere is refused, never followed); missing or not so: null (404, whatever the listing says);
 *   2. against `listing`: not in it, or its size or modification time differ from it (added, rewritten, shrunk, grown
 *      since the folder was checked): 'stale', and the caller checks the whole folder again, then asks once more;
 *   3. the caps: over maxFileBytes: null (it counts in the folder's total, it is never served);
 *   4. serve: its real path still under the real `ui/`, the bytes read still the listed size (else 'stale'); its type is
 *      one of UI_TYPES (uiSegments only lets those through).
 * null answers 404 without saying why.
 */
export function readUiFile(directory: string, segments: readonly string[], listing: UiListing): { data: Buffer; type: string } | 'stale' | null {
  const root = join(directory, 'ui');
  const top = statOrNull(root);
  if (!top || top.isSymbolicLink() || !top.isDirectory()) return null;
  let path = root;
  let stat: Stats | null = null;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    stat = statOrNull(path);
    const last = index === segments.length - 1;
    if (!stat || stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) return null;
  }
  const listed = listing.get(segments.join('/'));
  if (!listed || stat!.size !== listed.size || stat!.mtimeMs !== listed.mtimeMs) return 'stale';
  if (listed.size > UI_LIMITS.maxFileBytes) return null;
  try {
    if (!inside(realpathSync(root), realpathSync(path))) return null;
    const data = readFileSync(path);
    if (data.length !== listed.size) return 'stale';   // rewritten between the look and the read
    return { data, type: UI_TYPES.get(extname(path).toLowerCase())! };
  } catch { return null; }
}

/**
 * Whether `ui/` can be shown at all, checked when a frame opens and again whenever a frame asks for a file the last
 * check did not see as it is now: `ui/index.html` is a regular file, and the folder, walked without following any link,
 * holds at most maxFiles files and maxTotalBytes in all, maxDepth folders deep. Every regular file counts, whatever its
 * type or size (one over maxFileBytes, or of a type never served, is listed but never served); a link inside is skipped
 * (it is never served either). On success, the listing of what it saw.
 */
export function checkUiFolder(directory: string): { ok: true; files: UiListing } | { ok: false; code: 'FILES_MISSING' | 'FILES_INVALID'; message: string } {
  const root = join(directory, 'ui');
  const top = statOrNull(root);
  const entry = statOrNull(join(root, UI_ENTRY));
  if (!top || top.isSymbolicLink() || !top.isDirectory() || !entry || entry.isSymbolicLink() || !entry.isFile()) {
    return { ok: false, code: 'FILES_MISSING', message: '插件目录里没有界面文件 ui/index.html。' };
  }
  const files = new Map<string, { size: number; mtimeMs: number }>();
  let bytes = 0;
  const walk = (folder: string, prefix: string, depth: number): string | null => {
    let names: string[];
    try { names = readdirSync(folder); } catch { return '读不到界面文件夹。'; }
    for (const name of names) {
      const stat = statOrNull(join(folder, name));
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth >= UI_LIMITS.maxDepth) return `界面文件夹超过 ${UI_LIMITS.maxDepth} 层。`;
        const problem = walk(join(folder, name), `${prefix}${name}/`, depth + 1);
        if (problem) return problem;
      } else if (stat.isFile()) {
        files.set(`${prefix}${name}`, { size: stat.size, mtimeMs: stat.mtimeMs });
        bytes += stat.size;
        if (files.size > UI_LIMITS.maxFiles) return `界面文件超过 ${UI_LIMITS.maxFiles} 个。`;
        if (bytes > UI_LIMITS.maxTotalBytes) return `界面文件合计超过 ${UI_LIMITS.maxTotalBytes / 1024 / 1024} MiB。`;
      }
    }
    return null;
  };
  const problem = walk(root, '', 1);
  return problem ? { ok: false, code: 'FILES_INVALID', message: problem } : { ok: true, files };
}

/**
 * The policy every file of a frame is served with, `prefix` being this frame's own URL prefix
 * (`http://<host>/plugin-ui/<frameId>/`): an opaque-origin sandbox (scripts only), scripts, styles, images and fonts
 * from this prefix alone (inline styles and data: images too), no connections, nested frames, forms or <base>.
 */
export const uiFramePolicy = (prefix: string): string => `sandbox allow-scripts; default-src 'none'; script-src ${prefix}; `
  + `style-src ${prefix} 'unsafe-inline'; img-src ${prefix} data:; font-src ${prefix}; connect-src 'none'; frame-src 'none'; `
  + `form-action 'none'; base-uri 'none'`;

/**
 * The chip text a plugin sets (host.ui.chip): one line of plain text (control and format characters become spaces, runs
 * of spaces one), cut to its first `max` characters (chipText by default; a mark's text and tip pass theirs) counted by
 * code point, so an emoji's surrogate pair is never split. null for a non-string or one with nothing left.
 */
export function chipText(value: unknown, max: number = UI_LIMITS.chipText): string | null {
  if (typeof value !== 'string') return null;
  // Cleaned whole (cleanText's own cut is far beyond the characters kept), then cut by code point.
  const clean = Array.from(cleanText(value, value.length)).slice(0, max).join('').trimEnd();
  return clean || null;
}

/** The JSON (UTF-8) size of a value, or Infinity when it is not JSON (a cycle, a BigInt). */
export function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? ''); } catch { return Infinity; }
}

/** A refused frame open, request or push: a stable code and a sentence for the page. */
export class UiRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
