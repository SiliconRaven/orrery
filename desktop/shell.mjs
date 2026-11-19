// The orrery desktop shell (docs/desktop.md), Electron main process: one window whose first tab is the collaboration
// page and whose other tabs are app windows the user picked. The dock area is one pane, two columns or a 2 × 2 grid
// (split view); each app window shown in a pane stays a separate top-level window docked over its pane; it is never
// re-parented, restyled or given an owner.
//
// Wiring: user actions (IPC from the fixed local tab bar, native menus) and this window's events go into the tab
// state machine (lib/dock.mjs); the operations it returns go through the single writer (lib/writer.mjs), which checks
// identity, flags and trigger before each Win32 write. The Win32 layer comes in as `ffi` (lib/win32.mjs from main.mjs,
// a fake in desktop/test). The collaboration page gets no preload, no IPC and no permission; it may only stay on the
// Hub's origin. Nothing is handed to the system to open, with one exception: launchApp starts a supported app on a
// click in the "+" panel (docs/desktop.md "启动应用"), a small window of the shell's own under "+" (ui/strip.html).
// Where it starts an app from can be saved by the user in the settings view (docs/desktop.md "应用位置"), another
// small window of the shell's own, under the gear (ui/settings.html).
import { BrowserWindow, Menu, WebContentsView, app, dialog, ipcMain, nativeImage, screen, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_PATHS_FILE, MAX_APP_PATHS_BYTES, confirmOffer, isUseRequest, issueOffers, parseAppPaths, serializeAppPaths, settingsBounds, settingsRow } from './lib/app-paths.mjs';
import { APPS } from './lib/apps.mjs';
import { LAYOUTS, ORRERY, afterOps, initialState, liveIn, loadLayout, loadTabs, runOps, savedState, step, view } from './lib/dock.mjs';
import { PANE_GAP, TAB_BAR_HEIGHT, dockArea, paneRects, toPhysical } from './lib/geometry.mjs';
import { createWatch } from './lib/launch.mjs';
import { checkProgram, programNames, startTarget } from './lib/locate.mjs';
import { allowNavigation, isHubShutdown, parseEnsure } from './lib/navigation.mjs';
import { iconFromExe } from './lib/peicon.mjs';
import { isAppId, panelBounds, panelStep, pickFor, stripEntries } from './lib/strip.mjs';
import { dockedPosition, listCandidates, topmostOf } from './lib/windows.mjs';
import { createWriter } from './lib/writer.mjs';
import { setLanguage, t } from '../shared/i18n/index.js';
import { desktopLanguage, desktopPageUrl, isDesktopLanguage } from './ui/language.mjs';

const HERE = import.meta.dirname;
/** The tab bar and the "+" panel: the only pages with a desktop interface, each its own. IPC from anything else is refused. */
export const TABS_PAGE = pathToFileURL(join(HERE, 'ui', 'tabs.html')).href;
export const STRIP_PAGE = pathToFileURL(join(HERE, 'ui', 'strip.html')).href;
export const SETTINGS_PAGE = pathToFileURL(join(HERE, 'ui', 'settings.html')).href;
const PRELOAD = join(HERE, 'preload.cjs');
const STRIP_PRELOAD = join(HERE, 'strip-preload.cjs');
const SETTINGS_PRELOAD = join(HERE, 'settings-preload.cjs');
/** Height of the single top row (orrery mark, tabs, +, system caption buttons) in DIP; ui/tabs.css uses the same. */
export const BAR = TAB_BAR_HEIGHT;
/** The caption buttons (minimize, maximize, close) are the system's own overlay, coloured like the tab row. */
const TITLE_BAR_OVERLAY = { color: '#141518', symbolColor: '#e6e4e0', height: BAR };
export const LAUNCHER = join(HERE, '..', 'src', 'launcher.ts');
const HUB_PARTITION = 'persist:orrery-hub';
/** How often the windows of an app started from the strip are read while its new window is awaited. */
const WATCH_TICK_MS = 400;

/**
 * `node src/launcher.ts --ensure` with fixed arguments and no shell, from the repository root. The launcher decides
 * whether a Hub runs and starts one if not; the shell only reads its one line.
 */
export function runEnsure({ node = 'node', launcher = LAUNCHER, env = process.env } = {}) {
  return new Promise((done) => {
    let stdout = '';
    const child = spawn(node, [launcher, '--ensure'], { cwd: dirname(dirname(launcher)), env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.once('error', (e) => done({ error: t('没能运行 Node（{error}）。确认装了 Node 24，再在 desktop 目录里重新运行一次 npm run shortcut。', { error: e.message }) }));
    child.once('close', (code) => done(parseEnsure(stdout, code)));
  });
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** A file's change stamp (modification time and size), or null when it cannot be read. */
const stampOf = (path) => { try { const st = statSync(path); return st.isFile() ? `${st.mtimeMs}:${st.size}` : null; } catch { return null; } };

/**
 * The read-only places where an app's install is looked up (lib/locate.mjs locateApp; for its icon, and on a click
 * in the strip, its start target): MSIX app execution aliases (a
 * link read) and the Start Menu shortcuts of this user and of all users (read by the system's shortcut reader,
 * Electron's shell.readShortcutLink). Read afresh every time: the folders are listed again, and a shortcut is parsed
 * again whenever its file changed (reading all of them takes most of a second, so an unchanged file's last reading is
 * reused, in memory only; nothing is saved).
 */
const linkReads = new Map();
function readLink(path) {
  const stamp = stampOf(path);
  if (!stamp) return null;
  const last = linkReads.get(path);
  if (last?.stamp === stamp) return last.link;
  let link = null;
  try { const l = shell.readShortcutLink(path); link = { target: l.target ?? '', args: l.args ?? '' }; } catch { /* not a readable shortcut */ }
  linkReads.set(path, { stamp, link });
  return link;
}
/**
 * The program paths the user saved in the settings view: app-paths.json in the shell's own data folder, read afresh at
 * every use (lib/app-paths.mjs parseAppPaths; a missing, oversized or broken file reads as none). Written only by
 * writeAppPaths, from the settings view's own IPC handlers.
 */
const appPathsFile = () => join(app.getPath('userData'), APP_PATHS_FILE);
function readAppPaths(apps) {
  try {
    const file = appPathsFile();
    return statSync(file).size > MAX_APP_PATHS_BYTES ? {} : parseAppPaths(readFileSync(file, 'utf8'), apps);
  } catch {
    return {};
  }
}
/** Replaces the file (a temporary file renamed over it, so a reader never sees half of it). False when it failed. */
function writeAppPaths(saved, apps) {
  try {
    const file = appPathsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, serializeAppPaths(saved, apps));
    renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

function systemSources() {
  let links = null;
  const startMenus = [join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ...(process.env.ProgramData ? [join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')] : [])];
  const shortcuts = () => startMenus.flatMap((root) => {
    let files = [];
    try { files = readdirSync(root, { recursive: true, encoding: 'utf8' }); } catch { /* no such folder */ }
    return files.filter((f) => f.toLowerCase().endsWith('.lnk')).flatMap((f) => readLink(join(root, f)) ?? []);
  });
  return {
    localAppData: process.env.LOCALAPPDATA ?? '',
    readAlias: (path) => { try { return readlinkSync(path); } catch { return null; } },
    isFile: (path) => stampOf(path) !== null,
    shortcuts: () => (links ??= shortcuts()),
    // For a saved path: the file itself, not what a link points at (lib/locate.mjs checkProgram refuses links).
    lstat: (path) => { try { const st = lstatSync(path); return { file: st.isFile(), link: st.isSymbolicLink() }; } catch { return null; } },
  };
}

/**
 * The icon in a program file's own resources (lib/peicon.mjs), as a data URL, or null. The file is only read: opened
 * read-only, never run or loaded; the parser asks for the headers and the resource section, each read bounded.
 */
function resourceIcon(path) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const icon = iconFromExe((offset, length) => {
      const b = Buffer.alloc(length);
      return b.subarray(0, readSync(fd, b, 0, length, offset));
    });
    return icon ? `data:${icon.type};base64,${icon.bytes.toString('base64')}` : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Refuses every browser permission (camera, microphone, screen capture, notifications, …) in this session. */
function denyPermissions(s) {
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
  s.on('will-download', (e) => e.preventDefault());
}

/**
 * Builds the window and wires everything. Assumes the single-instance lock is held (main.mjs takes it first).
 * `launchTarget` and `sources` are for the checks only (they must never start a real app, nor read this machine's
 * installs); main.mjs leaves both: the read-only system sources, and as the launch target a valid saved path, else
 * those sources (lib/locate.mjs startTarget).
 * @param {{ ffi: object, ensure: () => Promise<{ origin: string, page?: string } | { error: string }>, apps?: object[],
 *   sources?: typeof systemSources, launchTarget?: (app: object) => import('./lib/locate.mjs').Location }} opts
 */
export function startShell({ ffi, ensure, apps = APPS, sources = systemSources, launchTarget = null }) {
  /** What an app is looked up in, read afresh at each call: the read-only system sources and the saved paths. */
  const lookup = () => ({ ...sources(), saved: () => readAppPaths(apps) });
  launchTarget ??= (a, io = lookup()) => startTarget(a, io);
  let shellHwnd = 0;   // this shell's own top-level window, set once it exists
  const writer = createWriter(ffi, { apps, ownWindow: () => shellHwnd });
  const statePath = join(app.getPath('userData'), 'desktop-state.json');
  const saved = readJson(statePath);
  let uiLanguage = desktopLanguage(saved?.language);
  setLanguage(uiLanguage);
  let state = initialState(loadTabs(saved, apps), loadLayout(saved));
  let lastSaved = JSON.stringify({ ...savedState(state), language: uiLanguage });
  /** @type {{ status: 'starting' } | { status: 'ready', origin: string } | { status: 'error', message: string }} */
  let hub = { status: 'starting' };
  let hubPage = null;
  let notice = null;
  let closing = false;
  /** The "+" panel: null while closed, else its entries as read when it opened (lib/strip.mjs); how often it was opened. */
  let strip = null;
  let stripOpened = 0;
  /**
   * The settings view (docs/desktop.md "应用位置"): null while closed, else its rows as last read (lib/app-paths.mjs
   * settingsRow); how often it was opened; whether its file dialog is open; per app, the offer the view shows now and
   * its token (lib/app-paths.mjs issueOffers: what "使用这个位置" may save) and the last action's result.
   */
  let settings = null;
  let settingsOpened = 0;
  let dialogOpen = false;
  let offers = {};
  const messages = {};
  /** Apps started from the strip whose new window the shell is still watching for, and those watches' timers. */
  const starting = new Set();
  const watches = new Set();
  const ipc = { accepted: 0, rejected: 0 };
  // Icons for the tab bar, as data URLs (the page loads nothing itself): the orrery icon for the collaboration tab, and
  // each app's icon, from the program file of one of its windows seen running, or of its install (locateApp) when it
  // is not running. First from the file's own resources (resourceIcon); else Electron's app.getFileIcon, unless that
  // gives the system's generic program icon (the same as for a file that does not exist: all apps would look alike);
  // else the tab bar shows the app name's first character. Each file is tried once per change stamp.
  const icons = { [ORRERY]: nativeImage.createFromPath(join(HERE, 'assets', 'orrery-icon.png')).resize({ width: 64, quality: 'best' }).toDataURL() };
  const iconTried = new Map();
  const generic = app.getFileIcon(join(app.getPath('userData'), 'no-such-program.exe'), { size: 'large' }).then((i) => i.toDataURL(), () => null);
  function learnIcon(appId, path) {
    if (icons[appId] || !path) return;
    const stamp = stampOf(path);
    if (!stamp || iconTried.get(path) === stamp) return;
    iconTried.set(path, stamp);
    const own = resourceIcon(path);
    if (own) { icons[appId] = own; render(); return; }
    app.getFileIcon(path, { size: 'large' }).then(async (img) => {
      const url = img.isEmpty() ? null : img.toDataURL();
      if (!url || url === await generic || icons[appId]) return;
      icons[appId] = url;
      render();
    }, () => { /* no icon: the tab bar shows the app name's first character */ });
  }

  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 560, minHeight: 360, title: 'orrery', show: false, backgroundColor: '#1e1f23',
    icon: join(HERE, 'assets', 'orrery-icon.ico'),
    // No separate title bar: the tab row is the title row (drag, double-click to maximize), with the system buttons.
    titleBarStyle: 'hidden', titleBarOverlay: TITLE_BAR_OVERLAY,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  win.setMenu(null);
  const tabs = win.webContents;
  // The "+" panel (docs/desktop.md "+ 面板"): a small frameless window of the shell's own, always on top, because the
  // docked windows sit above the shell (lowerShell) and would cover anything drawn in it. Not owned by the shell window:
  // with an owned topmost window, moving the shell beneath a docked window succeeds but has no effect (test F). No
  // taskbar entry; destroyed with the shell. Hidden until "+" is clicked; positioned through Electron only, never through
  // the Win32 layer.
  const panel = new BrowserWindow({
    show: false, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, width: 120, height: 60, title: 'orrery', backgroundColor: '#232428',
    webPreferences: { preload: STRIP_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  panel.removeMenu();
  win.on('closed', () => { if (!panel.isDestroyed()) panel.destroy(); });   // it is not owned, so it would outlive the shell
  const strips = panel.webContents;
  // The settings view (docs/desktop.md "应用位置"): a window like the "+" panel (same reasons: above the docked windows,
  // no owner, no taskbar entry, positioned through Electron only), under the gear, hidden until it is clicked.
  const settingsWin = new BrowserWindow({
    show: false, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, width: 640, height: 400, title: t('orrery 桌面设置'), backgroundColor: '#232428',
    webPreferences: { preload: SETTINGS_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  settingsWin.removeMenu();
  win.on('closed', () => { if (!settingsWin.isDestroyed()) settingsWin.destroy(); });
  const settingsPage = settingsWin.webContents;
  const collab = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition: HUB_PARTITION, spellcheck: false },
  });
  win.contentView.addChildView(collab);
  denyPermissions(session.defaultSession);
  denyPermissions(collab.webContents.session);

  // The tab bar, the "+" panel and the settings view are fixed local pages: they never navigate and open nothing.
  for (const page of [tabs, strips, settingsPage]) {
    page.on('will-navigate', (e) => e.preventDefault());
    page.on('will-frame-navigate', (e) => e.preventDefault());
    page.on('will-attach-webview', (e) => e.preventDefault());
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  // The collaboration page stays on the Hub's exact origin; anything else is stopped, not handed to the system.
  const hubOrigin = () => (hub.status === 'ready' ? hub.origin : null);
  const wc = collab.webContents;
  wc.on('will-frame-navigate', (e) => { if (!allowNavigation(hubOrigin(), e.url, e.isMainFrame)) e.preventDefault(); });
  wc.on('will-navigate', (e, url) => { if (!allowNavigation(hubOrigin(), e.url ?? url, true)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!allowNavigation(hubOrigin(), e.url ?? url, e.isMainFrame ?? true)) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A click into the collaboration page makes its pane the active one. Seen here, in the main process, from the input
  // Electron routes to the page; the page itself gets no interface for it.
  // The same press closes the "+" panel and the settings view (a click elsewhere in the shell).
  wc.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown') { panelEvent('press'); settingsEvent('press'); }
    const i = state.panes.indexOf(ORRERY);
    if (input.type === 'mouseDown' && i >= 0 && i !== state.active) dispatch({ type: 'activate', pane: i });
  });
  // F5 / Ctrl+R reload the collaboration page (the shell has no menu or address bar), e.g. to load new web code after
  // a Hub update. Seen in the main process, from the keys Electron routes to the page or to the tab bar while the
  // collaboration page is the selected tab; the page gets no interface for it and the navigation rules stay as they are.
  const reloadKey = (input) => input.type === 'keyDown' && !input.alt && !input.meta
    && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'));
  const reloadCollab = () => {
    if (hub.status !== 'ready' || wc.isDestroyed()) return;
    const page = wc.getURL();
    wc.loadURL(desktopPageUrl(allowNavigation(hub.origin, page, true) ? page : hubPage, uiLanguage)).catch(() => {});
  };
  wc.on('before-input-event', (e, input) => {
    if (!reloadKey(input)) return;
    e.preventDefault();
    reloadCollab();
  });
  tabs.on('before-input-event', (e, input) => {
    if (!reloadKey(input)) return;
    e.preventDefault();   // the tab bar itself is never reloaded
    if (state.panes[state.active] === ORRERY) reloadCollab();
  });
  strips.on('before-input-event', (e, input) => { if (reloadKey(input)) e.preventDefault(); });   // never reloaded either
  settingsPage.on('before-input-event', (e, input) => { if (reloadKey(input)) e.preventDefault(); });
  // "退出 orrery" in the page: only a POST /api/shutdown that the Hub answered with 202. Lost connections, SSE drops
  // and a Hub restart are not a quit.
  wc.session.webRequest.onCompleted((d) => {
    if (d.webContentsId === wc.id && isHubShutdown(hubOrigin(), d)) quit('shutdown');
  });

  /** The dock area in physical pixels on the window's display, and the slit between panes there. */
  const dock = () => {
    if (win.isDestroyed()) return { rect: null, gap: 0 };
    const display = screen.getDisplayMatching(win.getBounds());
    const px = screen.dipToScreenRect(null, display.bounds);
    const rect = toPhysical(dockArea(win.getContentBounds(), BAR), { dip: display.bounds, px, scale: display.scaleFactor });
    return { rect, gap: Math.round(PANE_GAP * display.scaleFactor) };
  };
  shellHwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
  const env = () => {
    const { rect, gap } = dock();
    return { rect, gap, capture: (c) => writer.capture(c),
      dockedPosition: (hwnds) => dockedPosition(ffi, shellHwnd, hwnds, rect), topmost: (hwnds) => topmostOf(ffi, hwnds),
      verify: (b) => writer.verify(b) };
  };

  // Saved a moment after the last change: dragging a divider changes the state many times a second.
  let persistTimer = null;
  const schedulePersist = () => { persistTimer ??= setTimeout(persist, 400); };
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = null;
    const s = JSON.stringify({ ...savedState(state), language: uiLanguage });
    if (s === lastSaved) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(`${statePath}.tmp`, s);
      renameSync(`${statePath}.tmp`, statePath);
      lastSaved = s;
    } catch { /* the tab list is a convenience; failing to save it changes nothing else */ }
  }

  /** The collaboration page fills its pane (in DIP), and shows only while it is in one. */
  function layout() {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const area = { x: 0, y: BAR, width: w, height: Math.max(1, h - BAR) };
    const i = state.panes.indexOf(ORRERY);
    const r = i >= 0 ? paneRects(area, state.layout, state.ratios, PANE_GAP)[i] : area;
    collab.setBounds({ x: r.x, y: r.y, width: Math.max(0, r.width), height: Math.max(0, r.height) });
    collab.setVisible(i >= 0 && hub.status === 'ready');
  }

  function render() {
    if (win.isDestroyed() || tabs.isDestroyed()) return;
    for (const t of state.tabs) if (t.binding) learnIcon(t.app, t.binding.exePath);
    tabs.send('tabs:state', {
      ...view(state, apps),
      language: uiLanguage,
      hub: hub.status === 'error' ? { status: 'error', message: hub.message } : { status: hub.status },
      notice,
      canPick: hub.status !== 'starting',
      stripOpen: !!strip,
      settingsOpen: !!settings,
      icons,
    });
    const iconsOf = (list) => Object.fromEntries(list.flatMap((e) => (icons[e.id] ? [[e.id, icons[e.id]]] : [])));
    if (strip && !strips.isDestroyed()) {
      strips.send('strip:state', { entries: strip, icons: iconsOf(strip), opened: stripOpened, language: uiLanguage });
    }
    if (settings && !settingsPage.isDestroyed()) {
      settingsPage.send('settings:state', { rows: settings.map((r) => ({ ...r, message: messages[r.id] ?? null })), icons: iconsOf(settings),
        opened: settingsOpened, busy: dialogOpen, language: uiLanguage });
    }
  }

  /** One user action or window event: reducer → writer → (lost windows unbound) → save, layout, redraw. */
  function dispatch(event) {
    if (win.isDestroyed()) return { lost: [], failures: [] };
    const e = env();
    const r = step(state, event, e, apps);
    state = r.state;
    // The usual case: still in front, nothing changed.
    if (event.type === 'restack' && !r.ops.length && !r.notices.length) return { lost: [], failures: [] };
    const out = runOps(r.ops, (o) => writer.write(o), liveIn(state));
    // Lost windows unbound; windows that stayed larger than their pane remembered for this binding.
    const after = afterOps(state, out, e, apps);
    state = after.state;
    const notices = [...r.notices, ...after.notices];
    for (const f of out.failures) {
      if (f.op === 'putBack') notices.push({ text: t('有一个窗口没能还原到原来的位置（{reason}{error}）。', { reason: f.reason, error: f.error ? t('，错误 {error}', { error: f.error }) : '' }) });
      else if (f.status === 'refused') console.error('orrery desktop: refused window operation', f);
    }
    if (notices.length) notice = notices.at(-1).text;
    schedulePersist();
    layout();
    render();
    return out;
  }

  /** Puts every bound window back, says which could not be, and closes the shell. The Hub keeps running. */
  function quit(trigger) {
    if (closing) return;
    closing = true;
    for (const t of watches) clearInterval(t);   // windows of apps still starting are no longer watched for
    const out = dispatch({ type: 'quit', trigger });
    persist();
    const problems = [
      ...out.failures.filter((f) => f.op === 'putBack').map((f) => t('{tab}：{reason}{error}', { tab: f.tab, reason: f.reason, error: f.error ? t('（错误 {error}）', { error: f.error }) : '' })),
      ...out.lost.map((l) => t('{tab}：窗口已经关了或身份变了（{reason}），没有去动它', { tab: l.tab, reason: l.reason })),
    ];
    if (problems.length && !win.isDestroyed()) {
      dialog.showMessageBoxSync(win, { type: 'warning', title: 'orrery', message: t('有应用窗口没能还原到原来的位置'), detail: problems.join('\n'), buttons: [t('确定')] });
    }
    if (!panel.isDestroyed()) panel.destroy();
    if (!settingsWin.isDestroyed()) settingsWin.destroy();
    if (!win.isDestroyed()) win.destroy();
  }

  const menuText = (s) => String(s).slice(0, 120).replaceAll('&', '&&');
  const boundHandles = () => state.tabs.flatMap((t) => (t.binding ? [t.binding.hwnd] : []));

  /** Running windows of supported apps that are not in a tab yet (all apps, or one app's). Reads only. */
  const candidates = (appId = null) => {
    const list = listCandidates(ffi, { apps, exclude: boundHandles(), app: appId });
    for (const c of list) learnIcon(c.app, c.exePath);
    return list;
  };

  /** The panel's entries, read now: each app's windows, tabs, whether it is being started, and where it would start from. */
  function readStrip() {
    const list = candidates();
    const io = lookup();
    // Only apps without a window to add are looked up: the others show their windows, not a start.
    const targets = Object.fromEntries(apps.filter((a) => !list.some((c) => c.app === a.id)).map((a) => [a.id, launchTarget(a, io)]));
    for (const [id, t] of Object.entries(targets)) if (t.ok) learnIcon(id, t.icon);
    return stripEntries(list, state.tabs, { targets, starting }, apps);
  }
  /**
   * A click on "+" (`anchorX`, its left edge in the tab bar), a press elsewhere in the shell, or a focus change: opened,
   * closed or left as it is, by lib/strip.mjs panelStep (event order and focus state, no clocks). Opening reads the
   * entries now and puts the panel under "+". Opening or closing it touches no app window.
   */
  function panelEvent(event, anchorX = 0) {
    const focus = { shellFocused: !win.isDestroyed() && win.isFocused(), panelFocused: !panel.isDestroyed() && panel.isFocused() };
    const act = panelStep(!!strip, event, focus);
    if (act === 'close') closeStrip();
    if (act !== 'open' || panel.isDestroyed()) return;
    closeSettings();
    strip = readStrip();
    stripOpened++;
    panel.setBounds(panelBounds(strip.length, win.getContentBounds(), anchorX, BAR));
    render();
    panel.show();
  }
  /**
   * Closes the panel: a pick, Escape, "+" again, a press elsewhere in the shell, the focus leaving the shell and the
   * panel, the shell moving, resizing, minimizing or hiding. While the panel has the focus (a pick, Escape), the shell
   * takes it back first, as if the user had clicked it; Windows would otherwise hand it to whichever window comes next.
   */
  function closeStrip() {
    if (!strip) return;
    strip = null;
    if (!panel.isDestroyed()) {
      if (panel.isFocused() && !win.isDestroyed()) win.focus();
      panel.hide();
    }
    render();
  }
  // The panel or the shell lost the focus: looked at once Windows has activated the next window (a later task), so the
  // focus moving between the two (a press on the shell's tab row, the panel opening) is seen as such.
  const focusChanged = () => setTimeout(() => panelEvent('focus'), 0);
  panel.on('blur', focusChanged);
  win.on('blur', focusChanged);
  // The panel's own close (Alt+F4 while it has the focus) only closes the strip: the panel is reused, and only the shell
  // destroys it (quit, 'closed').
  panel.on('close', (e) => { if (closing) return; e.preventDefault(); closeStrip(); });
  for (const e of ['move', 'resize', 'minimize', 'hide']) win.on(e, () => closeStrip());

  /**
   * The settings view (docs/desktop.md "应用位置"), opened and closed by the "+" panel's rules (lib/strip.mjs panelStep):
   * the gear toggles it, a press elsewhere in the shell or the focus leaving the shell and the view closes it, and so do
   * Escape, its own close button and the shell moving, resizing, minimizing or hiding. Opening it closes the "+" panel
   * and the other way round. While its file dialog is open, nothing closes it. Opening or closing it touches no app
   * window.
   */
  function settingsEvent(event, anchorX = 0) {
    if (dialogOpen) return;
    const focus = { shellFocused: !win.isDestroyed() && win.isFocused(), panelFocused: !settingsWin.isDestroyed() && settingsWin.isFocused() };
    const act = panelStep(!!settings, event, focus);
    if (act === 'close') closeSettings();
    if (act !== 'open' || settingsWin.isDestroyed()) return;
    closeStrip();
    for (const id of Object.keys(messages)) delete messages[id];
    settings = readSettings();
    settingsOpened++;
    settingsWin.setBounds(settingsBounds(win.getContentBounds(), anchorX, BAR));
    render();
    settingsWin.show();
  }
  function closeSettings() {
    if (!settings || dialogOpen) return;
    settings = null;
    offers = {};   // every token shown so far is void; opening again issues new ones
    if (!settingsWin.isDestroyed()) {
      if (settingsWin.isFocused() && !win.isDestroyed()) win.focus();
      settingsWin.hide();
    }
    render();
  }
  settingsWin.on('blur', () => setTimeout(() => settingsEvent('focus'), 0));
  win.on('blur', () => setTimeout(() => settingsEvent('focus'), 0));
  settingsWin.on('close', (e) => { if (closing) return; e.preventDefault(); closeSettings(); });
  for (const e of ['move', 'resize', 'minimize', 'hide']) win.on(e, () => closeSettings());

  /**
   * Every app's row, read now from the read-only sources, the saved file and the program paths of the app windows
   * running now (lib/app-paths.mjs settingsRow). Reads only. Each offer is held here with a token (issueOffers: kept
   * while the offered path stays exactly the same, new when it changes); the page gets the token with the row and sends
   * it back with "使用这个位置", so that only the offer the view showed can be saved.
   */
  function readSettings() {
    const io = lookup();
    const saved = io.saved();
    const running = listCandidates(ffi, { apps });
    for (const c of running) learnIcon(c.app, c.exePath);
    const rows = apps.map((a) => settingsRow(a, saved, io, running.filter((c) => c.app === a.id).map((c) => c.exePath)));
    offers = issueOffers(offers, rows, randomUUID);
    for (const r of rows) if (r.inUse) learnIcon(r.id, r.inUse.icon);
    return rows.map((r) => (r.offer ? { ...r, offer: { ...r.offer, token: offers[r.id].token } } : r));
  }
  function refreshSettings() {
    if (!settings) return;
    settings = readSettings();
    render();
  }
  const appOf = (id) => apps.find((a) => a.id === id);
  /** Saves `path` for app `a` after checking it again here (lib/locate.mjs checkProgram); only the settings view's actions call it. */
  function savePath(a, path, source) {
    const io = lookup();
    const check = checkProgram(a, path, io);
    if (!check.ok) messages[a.id] = t('没有保存：{reason}。', { reason: check.reason });
    else {
      const saved = io.saved();
      saved[a.id] = { path, source, savedAt: new Date().toISOString() };
      messages[a.id] = writeAppPaths(saved, apps) ? t('已保存。在 + 面板里点它，就从这里启动。') : t('没能写入设置文件，没有保存。');
    }
    refreshSettings();
  }
  /** 自动检测: everything read again now; a location that differs from the one in use is only offered. */
  function detect(a) {
    settings = readSettings();
    const r = settings.find((x) => x.id === a.id);
    messages[a.id] = r?.offer ? null : t('检测完了，{result}。', { result: t(r?.inUse ? '没有找到别的位置' : '没有找到它') });
    render();
  }
  /**
   * 使用这个位置: the page sends the app id and the token of the offer it showed, never a path. The token is spent at
   * once; detection runs again here; the path held for that token is saved only if the token is the current one for
   * this app and detection still finds exactly that path (lib/app-paths.mjs confirmOffer). Otherwise nothing is saved
   * and the current state, with a new token for the current offer, is sent again.
   */
  function useOffer(a, token) {
    const held = offers[a.id];
    delete offers[a.id];
    settings = readSettings();
    const r = confirmOffer(held, token, settings.find((x) => x.id === a.id)?.offer);
    if (!r.ok) { messages[a.id] = t('检测到的位置变了，没有保存。请看一下现在的结果再确认。'); render(); return; }
    savePath(a, r.path, 'detected');
  }
  /** 选择程序…: the system's file dialog, opened here (main process), for one .exe; the result is checked before it is saved. */
  async function pickProgram(a) {
    if (dialogOpen || a.package || settingsWin.isDestroyed()) return;
    dialogOpen = true;
    render();
    let r = { canceled: true, filePaths: [] };
    try {
      r = await dialog.showOpenDialog(settingsWin, { title: t('选择 {name} 的程序（{programs}）', { name: a.name, programs: programNames(a).join(t(' 或 ')) }), buttonLabel: t('打开'),
        properties: ['openFile', 'dontAddToRecent'], filters: [{ name: t('{name} 程序', { name: a.name }), extensions: ['exe'] }] });
    } catch { /* treated as cancelled */ } finally {
      dialogOpen = false;
    }
    // The file was chosen by the user in this very dialog; the view cannot close while it is open (closeSettings), only
    // the shell quitting ends it.
    if (closing || !settings) return;
    if (!r.canceled && r.filePaths.length === 1) savePath(a, r.filePaths[0], 'picked');
    else render();
  }
  /** 清除 (after the page's own confirmation): the saved path is removed; the app is started from the system sources again. */
  function clearPath(a) {
    const saved = readAppPaths(apps);
    if (!saved[a.id]) { refreshSettings(); return; }
    delete saved[a.id];
    messages[a.id] = writeAppPaths(saved, apps) ? t('已清除。') : t('没能写入设置文件，没有清除。');
    refreshSettings();
  }

  /**
   * A click on an app's icon in the "+" panel, from the 'strip:pick' IPC handler only: its one candidate window goes into
   * a new tab at once; with several, a list of their titles is shown and the user picks one (closing that list does
   * nothing); with none, the app is started (launchApp) unless a tab holds a window of it or it is being started.
   */
  function pickApp(appId) {
    const list = candidates(appId);
    closeStrip();
    const pick = pickFor(list, state.tabs, appId, starting);
    if (!pick) return;
    if ('add' in pick) userAction({ type: 'add', candidate: pick.add });
    else if ('choose' in pick) windowsMenu(pick.choose);
    else launchApp(apps.find((a) => a.id === appId));
  }

  /**
   * The only place the shell starts a program (docs/desktop.md "启动应用"), with one call site: pickApp, on a click in
   * the "+" panel. The target is looked up now, read-only (lib/locate.mjs locateApp), and opened with the
   * system's default action for a program file, without arguments (shell.openPath). Then, for WATCH_MS, the app's
   * windows that were not there before the click are watched for: one goes into a new tab (identity captured and
   * checked as for any pick), several are offered by title, none: nothing more happens. It is never started again.
   */
  function launchApp(a) {
    // The windows there before the click are read first, so that the target is looked up (and a user-chosen path
    // checked) right before shell.openPath, with nothing slow in between.
    const before = new Set(listCandidates(ffi, { apps, app: a.id }).map((c) => c.hwnd));
    const target = launchTarget(a);
    if (!target.ok) { notice = t('没有启动 {name}：{reason}。', { name: a.name, reason: target.reason }); render(); return; }
    const watch = createWatch(before, Date.now());
    starting.add(a.id);
    const stop = () => {
      clearInterval(timer);
      watches.delete(timer);
      starting.delete(a.id);
      if (strip && !closing) { strip = readStrip(); render(); }
    };
    const timer = setInterval(() => {
      if (closing || win.isDestroyed()) { stop(); return; }
      const r = watch.tick(candidates(a.id), Date.now());
      if (!r) return;
      stop();
      if ('add' in r) userAction({ type: 'add', candidate: r.add });
      else if ('choose' in r) windowsMenu(r.choose);
    }, WATCH_TICK_MS);
    watches.add(timer);
    shell.openPath(target.path).then((error) => {
      if (!error || watch.done) return;
      stop();
      notice = t('没能启动 {name}（{error}）。', { name: a.name, error });
      render();
    });
  }
  function windowsMenu(list) {
    // While one of the shell's menus is open, Windows keeps the shell above the docked window whatever we ask, so the
    // check runs again once the menu has closed.
    const menu = Menu.buildFromTemplate(list.map((c) => ({ label: menuText(c.title), click: () => userAction({ type: 'add', candidate: c }) })));
    menu.popup({ window: win, callback: () => restack() });
    return menu;
  }

  /** The layout menu (single, two columns, 2 × 2 grid). Only a pick changes the layout; closing it changes nothing. */
  const LAYOUT_LABELS = { single: '单栏', columns: '左右两栏', grid: '四宫格' };
  function layoutMenu() {
    const menu = Menu.buildFromTemplate(LAYOUTS.map((l) => ({
      label: t(LAYOUT_LABELS[l]), type: 'radio', checked: state.layout === l, click: () => dispatch({ type: 'layout', layout: l }),
    })));
    menu.popup({ window: win, callback: () => restack() });
    return menu;
  }

  /** An unbound tab's list: only that app's windows; the user picks one even when there is just one. */
  function chooseMenu(id) {
    const tab = state.tabs.find((t) => t.id === id && !t.binding);
    if (!tab) return;
    const name = apps.find((a) => a.id === tab.app)?.name ?? tab.app;
    const list = listCandidates(ffi, { apps, exclude: boundHandles(), app: tab.app });
    Menu.buildFromTemplate([
      { label: menuText(t('选择 {name} 的窗口（上次是“{title}”）', { name, title: tab.title })), enabled: false },
      { type: 'separator' },
      ...(list.length
        ? list.map((c) => ({ label: menuText(c.title), click: () => userAction({ type: 'choose', id, candidate: c }) }))
        : [{ label: menuText(t('{name} 现在没有在运行的窗口', { name })), enabled: false }]),
    ]).popup({ window: win, callback: () => restack() });
  }

  /**
   * IPC is accepted only from the shell's own fixed local pages, each for its own channels: that page's webContents,
   * its main frame, still showing that page. The tab bar's channels only from the tab bar, the panel's two only from
   * the panel, the settings view's only from the settings view. The collaboration page has no preload, so it cannot
   * even send; a subframe, a page that was navigated elsewhere, or another page are refused here.
   */
  const fromPage = (event, wc, url) => {
    const f = event.senderFrame;
    const main = wc.isDestroyed() ? null : wc.mainFrame;
    return event.sender === wc && !!f && !!main && f.parent === null
      && f.processId === main.processId && f.routingId === main.routingId && f.url === desktopPageUrl(url, uiLanguage);
  };
  const fromTabBar = (event) => fromPage(event, tabs, TABS_PAGE);
  const fromStrip = (event) => fromPage(event, strips, STRIP_PAGE);
  const fromSettings = (event) => fromPage(event, settingsPage, SETTINGS_PAGE);
  const isTabId = (id) => typeof id === 'string' && (id === ORRERY || state.tabs.some((t) => t.id === id));
  // Split view: a pane number of the current layout; divider positions as { x, y }, two finite numbers and nothing else
  // (the reducer clamps them). Anything else is refused outright.
  const isPane = (i) => Number.isInteger(i) && i >= 0 && i < state.panes.length;
  const isRatios = (r) => !!r && typeof r === 'object' && Object.getPrototypeOf(r) === Object.prototype
    && Object.keys(r).sort().join() === 'x,y' && Number.isFinite(r.x) && Number.isFinite(r.y);
  const oneAppId = (...args) => args.length === 1 && isAppId(args[0], apps);
  const valid = {
    // "+" sends its left edge (a finite number; the panel's position is clamped to the shell's content area).
    'tabs:add': (...args) => args.length === 1 && Number.isFinite(args[0]),
    // The gear likewise: its left edge, where the settings view goes.
    'tabs:settings': (...args) => args.length === 1 && Number.isFinite(args[0]),
    // The settings view sends a supported app's id for each action, and with 使用这个位置 the offer's token as well:
    // exactly { app, token } (lib/app-paths.mjs isUseRequest). Never a path.
    'settings:detect': oneAppId,
    'settings:use': (...args) => args.length === 1 && isUseRequest(args[0], apps),
    'settings:pick': oneAppId,
    'settings:clear': oneAppId,
    'settings:language': (...args) => args.length === 1 && isDesktopLanguage(args[0]),
    'settings:close': (...args) => args.length === 0,
    // A press in the tab bar anywhere but on "+": nothing else.
    'tabs:press': (...args) => args.length === 0,
    'strip:close': (...args) => args.length === 0,
    // The panel sends a supported app's id and nothing else; which windows it has is looked up here.
    'strip:pick': (...args) => args.length === 1 && isAppId(args[0], apps),
    'layout:menu': (...args) => args.length === 0,
    'pane:activate': (...args) => args.length === 1 && isPane(args[0]),
    'layout:ratios': (...args) => args.length === 1 && isRatios(args[0]),
  };
  const handlers = {
    'tabs:hello': () => { candidates(); render(); },   // a first read of the running windows, for the tabs' icons
    'tabs:select': (id) => {
      if (!isTabId(id)) return;
      const tab = state.tabs.find((t) => t.id === id);
      if (tab && !tab.binding) { if (hub.status !== 'starting') chooseMenu(id); return; }
      userAction({ type: 'select', id });
    },
    'tabs:close': (id) => { if (isTabId(id) && id !== ORRERY) dispatch({ type: 'close', id }); },
    'tabs:add': (x) => { if (hub.status !== 'starting') panelEvent('plus', x); },
    'tabs:settings': (x) => settingsEvent('plus', x),
    'tabs:press': () => { panelEvent('press'); settingsEvent('press'); },
    'layout:menu': () => { layoutMenu(); },
    'pane:activate': (pane) => dispatch({ type: 'activate', pane }),
    'layout:ratios': ({ x, y }) => dispatch({ type: 'ratios', x, y }),
    'tabs:retry': () => { if (hub.status === 'error') connectHub(); },
    'tabs:dismiss': () => { notice = null; render(); },
  };
  /** The "+" panel's two calls: a pick (a supported app's id) and a close (Escape). */
  const stripHandlers = {
    'strip:pick': (appId) => { if (strip && hub.status !== 'starting') pickApp(appId); },
    'strip:close': () => closeStrip(),
  };
  /**
   * The settings view's calls (docs/desktop.md "应用位置"): an app id and the action (使用这个位置 also the offer's token),
   * only while the view is open. The path to save is always held or asked for here: the offer held for that token and
   * found again, or the file dialog's answer.
   */
  const settingsHandlers = {
    'settings:detect': (id) => { if (settings) detect(appOf(id)); },
    'settings:use': (req) => { if (settings) useOffer(appOf(req.app), req.token); },
    'settings:pick': (id) => { if (settings) pickProgram(appOf(id)); },
    'settings:clear': (id) => { if (settings) clearPath(appOf(id)); },
    'settings:language': (value) => {
      if (!settings || dialogOpen || value === uiLanguage) return;
      uiLanguage = value;
      setLanguage(value);
      notice = null;
      for (const id of Object.keys(messages)) delete messages[id];
      persist();
      settingsWin.setTitle(t('orrery 桌面设置'));
      win.loadURL(desktopPageUrl(TABS_PAGE, value));
      panel.loadURL(desktopPageUrl(STRIP_PAGE, value));
      settingsWin.loadURL(desktopPageUrl(SETTINGS_PAGE, value));
      render();
    },
    'settings:close': () => closeSettings(),
  };
  function listen(table, from) {
    for (const [channel, handler] of Object.entries(table)) {
      ipcMain.removeAllListeners(channel);
      ipcMain.on(channel, (event, ...args) => {
        if (!from(event) || args.length > 1 || (valid[channel] && !valid[channel](...args))) { ipc.rejected++; return; }
        ipc.accepted++;
        handler(...args);
      });
    }
  }
  listen(handlers, fromTabBar);
  listen(stripHandlers, fromStrip);
  listen(settingsHandlers, fromSettings);

  async function connectHub() {
    hub = { status: 'starting' };
    layout();
    render();
    const r = await ensure();
    if (closing || win.isDestroyed()) return;
    hub = 'origin' in r ? { status: 'ready', origin: r.origin } : { status: 'error', message: r.error };
    // r.page carries the API token in its fragment; the page trades it for a session cookie and drops it.
    if ('origin' in r) {
      hubPage = r.page ?? `${r.origin}/`;
      wc.loadURL(desktopPageUrl(hubPage, uiLanguage)).catch(() => { /* shown by the page itself, or retried by the user */ });
    }
    layout();
    render();
  }

  // Keeping the docked window in front. A click on the shell while it is already the active window, a press on its
  // tab row or border to drag or resize it, or Chromium re-activating it, all bring the shell to the top without a
  // 'focus' event. Each of these changes the shell's own window position, so its WM_WINDOWPOSCHANGED triggers a check
  // right after: the shell's own window goes back beneath the docked window (lowerShell) only if the docked window is
  // directly under it, with no other window over the dock area in between (lib/windows.mjs dockedPosition). Only this
  // window's own messages are observed.
  const WM_WINDOWPOSCHANGED = 0x0047;
  let restackQueued = false;
  const restack = () => {
    if (restackQueued || win.isDestroyed()) return;
    restackQueued = true;
    setTimeout(() => {
      restackQueued = false;
      if (!win.isDestroyed() && !win.isMinimized()) dispatch({ type: 'restack' });
    }, 0);
  };
  win.hookWindowMessage(WM_WINDOWPOSCHANGED, restack);
  /** A tab action of the user, plus one check once Windows and Chromium have finished reacting to the click. */
  function userAction(event) { dispatch(event); setTimeout(restack, 250); }

  for (const e of ['move', 'resize', 'maximize', 'unmaximize']) {
    win.on(e, () => { layout(); if (!win.isMinimized()) dispatch({ type: 'bounds' }); });
  }
  win.on('minimize', () => dispatch({ type: 'minimize' }));
  win.on('restore', () => dispatch({ type: 'restore' }));
  win.on('focus', () => dispatch({ type: 'focus' }));
  win.on('close', (e) => { if (!closing) { e.preventDefault(); quit('quit'); } });
  win.once('ready-to-show', () => win.show());
  tabs.on('did-finish-load', () => render());
  // The same for the panel and the settings view: opened before their page had loaded, their state was sent before the
  // page listened for it; once loaded, it is sent again.
  strips.on('did-finish-load', () => render());
  settingsPage.on('did-finish-load', () => render());
  win.loadURL(desktopPageUrl(TABS_PAGE, uiLanguage));
  panel.loadURL(desktopPageUrl(STRIP_PAGE, uiLanguage));
  settingsWin.loadURL(desktopPageUrl(SETTINGS_PAGE, uiLanguage));
  layout();
  connectHub();

  return {
    win, tabs, collab: wc, panel, strips, settingsWin, settingsPage, ipc,
    get state() { return state; },
    get hub() { return hub; },
    get strip() { return strip; },
    get settings() { return settings; },
    get starting() { return [...starting]; },
    dispatch,
    candidates: () => candidates(),
    /** For the checks: opens the real window list of the panel (shown when an app has several windows) and returns it. */
    openAddMenu: () => windowsMenu(candidates()),
    /** For the checks: opens the real layout menu and returns it (as a click on the layout button does). */
    openLayoutMenu: () => layoutMenu(),
    /** A second shell was started: bring this one to the front instead. */
    focus() {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  };
}
