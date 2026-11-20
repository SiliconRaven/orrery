import { t } from '../../shared/i18n/index.js';
// Where a supported app is installed, looked up read-only (docs/desktop.md "图标"): the shell shows the icon of an app
// that is not running from the program file found here. Pure: the read-only sources come in as `io` (shell.mjs reads
// the file system and the Start Menu shortcuts). Nothing here runs or opens anything. Also the one check for a program
// path the user saved in the settings view (checkProgram), and what a click starts (startTarget). An MSIX app is checked
// against its package manifest here and started by app ID (lib/launch.mjs startApp).
import { fileName } from './apps.mjs';

/**
 * @typedef {{ localAppData: string, readAlias(path: string): string | null, readText(path: string): string | null,
 *   isFile(path: string): boolean, shortcuts(): { target: string, args: string }[] }} Sources
 *   readAlias: where an app execution alias points (a link read, the file is not opened); readText: a text file's
 *   contents, only read, null when it is missing or larger than MAX_MANIFEST_BYTES (an MSIX package's
 *   AppxManifest.xml); shortcuts: the Start Menu's .lnk files as read by the system (their target program and arguments)
 * @typedef {{ ok: true, path: string, icon: string, aumid?: string } | { ok: false, reason: string }} Location
 *   path: the program the app's Start Menu shortcut opens, without arguments, or for an MSIX app its execution alias
 *   (shown, never started); icon: the program file that holds the app's icon; aumid: for an MSIX app, the app ID it is
 *   started by (`<package family name>!<Application Id>`, lib/launch.mjs startApp)
 */

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
/**
 * A program on a local drive: `X:\...\name.exe`, no network share, no device or stream path, no other file type, only
 * backslashes, no control characters.
 */
export const isLocalProgram = (p) => typeof p === 'string' && /^[A-Za-z]:\\[^\u0000-\u001f:*?"<>|/]+\.exe$/i.test(p) && !p.includes('\\\\');

/** Largest AppxManifest.xml read (real ones are a few dozen KB). */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** An app user model ID as the supported app list writes it, `<package family name>!<Application Id>`, nothing else. */
export const isAumid = (s) => typeof s === 'string' && /^[A-Za-z0-9.\-_]+![A-Za-z0-9.\-_]+$/.test(s);

/**
 * The installed package's folder, from the program an MSIX app's alias points at: the path up to and with the segment
 * `<Name>_<version>_<architecture>_<resource id>_<publisher id>` of the family name `<Name>_<publisher id>`; or null.
 * @param {string} family @param {string} target
 */
export function packageDir(family, target) {
  const cut = family.lastIndexOf('_');
  if (cut <= 0) return null;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segment = new RegExp(`^${esc(family.slice(0, cut))}_[0-9.]+_[A-Za-z0-9]+_[A-Za-z0-9.-]*_${esc(family.slice(cut + 1))}$`, 'i');
  const parts = String(target).split('\\');
  const at = parts.findIndex((p) => segment.test(p));
  return at > 0 ? parts.slice(0, at + 1).join('\\') : null;
}

/**
 * Does the package manifest (AppxManifest.xml's text) declare an Application with this Id whose Executable, under the
 * package folder `dir`, is `target`? A tag may span lines; slashes in Executable count as backslashes; the paths
 * compare without case.
 * @param {string} xml @param {string} appId @param {string} dir @param {string} target
 */
export function manifestRuns(xml, appId, dir, target) {
  const attr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  for (const m of xml.matchAll(/<Application\b([^>]*)>/g)) {
    const exe = attr(m[1], 'Executable');
    if (attr(m[1], 'Id') === appId && exe && same(`${dir}\\${exe.replaceAll('/', '\\')}`, target)) return true;
  }
  return false;
}

/**
 * Where `app` is installed, looked up now in read-only system sources only: an MSIX app through its execution alias,
 * which must still point at the app's program inside its package, whose manifest must declare the app's Application
 * Id with that program (it is then started by app ID, never through the alias); any other through a Start Menu
 * shortcut whose target is the app's program (or its `starter`) and that passes no arguments. Never from the state
 * file, the collaboration page, the Hub or a window seen earlier: none of those is an input here.
 * @param {import('./apps.mjs').App} app
 * @param {Sources} io
 * @returns {Location}
 */
export function locateApp(app, io) {
  if (app.package) {
    const path = `${io.localAppData}\\Microsoft\\WindowsApps\\${app.package}\\${app.alias}`;
    const to = io.localAppData ? io.readAlias(path) : null;
    if (!to) return { ok: false, reason: t('没有找到它的安装（找不到这个应用包的启动入口）') };
    if (!isLocalProgram(path) || !same(fileName(to), app.exe)) return { ok: false, reason: t('它的启动入口指向的不是这个应用') };
    const aumid = `${app.package}!${app.appId}`;
    const dir = packageDir(app.package, to);
    const xml = dir ? io.readText(`${dir}\\AppxManifest.xml`) : null;
    if (typeof app.appId !== 'string' || !isAumid(aumid) || typeof xml !== 'string' || xml.length > MAX_MANIFEST_BYTES || !manifestRuns(xml, app.appId, dir, to)) {
      return { ok: false, reason: t('它的应用包清单里没有这个应用 ID，或者这个 ID 的程序不是这个应用') };
    }
    return { ok: true, path, icon: to, aumid };
  }
  const names = [app.exe, app.starter].filter(Boolean);
  const link = io.shortcuts().find((l) => isLocalProgram(l.target) && names.some((n) => same(fileName(l.target), n))
    && !String(l.args ?? '').trim() && io.isFile(l.target));
  return link ? { ok: true, path: link.target, icon: link.target } : { ok: false, reason: t('没有找到它的安装（开始菜单里没有它的快捷方式）') };
}

/** Longest program path accepted (MAX_PATH less the terminating null); longer ones would need the `\\?\` form. */
export const MAX_PROGRAM_PATH = 259;

/** The program file names `app` may be started from: its windows' program, and its own launcher (`starter`). */
export const programNames = (app) => [app.exe, app.starter].filter(Boolean);

/**
 * May `path` be saved for `app` and started (docs/desktop.md "应用位置")? Checked when the user saves it and again at
 * every use: an app that is not an MSIX package (those start from their alias only); a local-drive `.exe` path
 * (isLocalProgram), at most MAX_PROGRAM_PATH long, without `.` or `..` segments or segments ending in a dot or space
 * (Windows drops those, so the path would name another file); its file name one of the app's own program names; the
 * file there now, a regular file, not a link (lstat: a symbolic link, junction or app execution alias is refused).
 * @param {import('./apps.mjs').App} app @param {unknown} path
 * @param {{ lstat(path: string): { file: boolean, link: boolean } | null }} io
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkProgram(app, path, io) {
  const no = (reason) => ({ ok: false, reason });
  if (app.package) return no(t('它是应用商店（MSIX）安装的，只能和开始菜单一样按应用 ID 启动，不能指定程序文件'));
  if (typeof path !== 'string' || !path) return no(t('没有路径'));
  if (path.length > MAX_PROGRAM_PATH) return no(t('路径太长（超过 {max} 个字符）', { max: MAX_PROGRAM_PATH }));
  if (!isLocalProgram(path)) return no(t('不是本地盘上的 .exe 程序（不接受网络共享、设备路径、URL、数据流、正斜杠或别的文件类型）'));
  if (path.includes('%')) return no(t('路径里有 %（可能被当成环境变量展开，打开的就不是核对过的文件）'));
  if (path.slice(3).split('\\').some((s) => s === '.' || s === '..' || /[. ]$/.test(s))) return no(t('路径里有 . 或 ..，或者某一段以点或空格结尾'));
  const names = programNames(app);
  if (!names.some((n) => same(fileName(path), n))) return no(t('文件名不是 {names}', { names: names.join(t(' 或 ')) }));
  const st = io.lstat(path);
  if (!st) return no(t('文件不存在或读不到'));
  if (st.link) return no(t('它是一个链接（快捷方式、符号链接或别名），不是程序文件本身'));
  if (!st.file) return no(t('它不是一个文件'));
  return { ok: true };
}

/**
 * What a click in the "+" panel starts for `app` (docs/desktop.md "启动应用"), looked up now: the program path the user
 * saved in the settings view (`io.saved()`, the shell's app-paths.json), if it passes checkProgram now; otherwise the
 * read-only system sources (locateApp). A saved path that fails is ignored here, not removed.
 * @param {import('./apps.mjs').App} app
 * @param {Sources & { lstat(path: string): { file: boolean, link: boolean } | null,
 *   saved(): Record<string, { path: string }> }} io
 * @returns {Location}
 */
export function startTarget(app, io) {
  const saved = io.saved()[app.id];
  if (saved && checkProgram(app, saved.path, io).ok) return { ok: true, path: saved.path, icon: saved.path };
  return locateApp(app, io);
}
