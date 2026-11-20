// docs/desktop.md "应用位置": the program paths the user saves in the desktop shell's settings view. Plain Node: the
// pure modules (lib/locate.mjs checkProgram and startTarget, lib/app-paths.mjs) with fake read-only sources, and
// source checks of the shell's wiring; desktop/test/strip-check.mjs drives the real view in hidden Electron windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const DESKTOP = join(REPO_ROOT, 'desktop');
const load = (rel: string) => import(pathToFileURL(join(DESKTOP, rel)).href);
const { APPS } = await load('lib/apps.mjs');
const locate = await load('lib/locate.mjs');
const paths = await load('lib/app-paths.mjs');
const dock = await load('lib/dock.mjs');
const read = (rel: string) => readFileSync(join(DESKTOP, rel), 'utf8');

type App = { id: string; name: string; exe: string; package?: string; alias?: string; starter?: string };
type Stat = { file: boolean; link: boolean };
const appOf = (id: string): App => APPS.find((a: App) => a.id === id);
const KIMI = 'C:\\Program Files\\Kimi Code\\Kimi Code.exe';
const LAD = 'C:\\Users\\u\\AppData\\Local';

/** Fake sources: files on disk (path → lstat), aliases, package manifests, Start Menu shortcuts and app-paths.json's entries; reads logged. */
function io(over: { files?: Record<string, Stat>; aliases?: Record<string, string>; texts?: Record<string, string>; links?: { target: string; args: string }[]; saved?: Record<string, unknown> } = {}) {
  const log: string[] = [];
  const files = over.files ?? {};
  return {
    log,
    localAppData: LAD,
    readAlias: (p: string) => { log.push(`alias ${p}`); return over.aliases?.[p] ?? null; },
    readText: (p: string) => { log.push(`text ${p}`); return over.texts?.[p] ?? null; },
    isFile: (p: string) => { log.push(`file ${p}`); return files[p]?.file === true; },
    shortcuts: () => { log.push('shortcuts'); return over.links ?? []; },
    lstat: (p: string) => { log.push(`lstat ${p}`); return files[p] ?? null; },
    saved: () => { log.push('saved'); return over.saved ?? {}; },
  };
}
const file: Stat = { file: true, link: false };

test('desktop app paths: what may be saved and started, with a reason for every refusal', () => {
  const kimi = appOf('kimi-code');
  const long = `C:\\${'a'.repeat(250)}\\Kimi Code.exe`;
  const accept: [App, string][] = [
    [kimi, KIMI],
    [kimi, 'c:\\program files\\kimi code\\KIMI CODE.EXE'],   // names compare without case
    [appOf('qoder'), 'C:\\Program Files\\Qoder\\Qoder Launcher.exe'],   // the app's own launcher (`starter`)
    [appOf('qoder'), 'D:\\Apps\\Qoder\\Qoder.exe'],
    [kimi, `C:\\${'a'.repeat(259 - 3 - 14)}\\Kimi Code.exe`],   // exactly MAX_PROGRAM_PATH
  ];
  for (const [a, p] of accept) {
    assert.equal(p.length <= locate.MAX_PROGRAM_PATH, true);
    assert.deepEqual(locate.checkProgram(a, p, io({ files: { [p]: file } })), { ok: true }, p);
  }
  const refuse: [string, unknown, RegExp, Stat?][] = [
    ['UNC share', '\\\\server\\share\\Kimi Code.exe', /本地盘/],
    ['\\\\?\\ path', '\\\\?\\C:\\Apps\\Kimi Code.exe', /本地盘/],
    ['\\\\.\\ device path', '\\\\.\\C:\\Apps\\Kimi Code.exe', /本地盘/],
    ['device namespace', '\\\\.\\pipe\\Kimi Code.exe', /本地盘/],
    ['alternate data stream', 'C:\\Apps\\a.txt:Kimi Code.exe', /本地盘/],
    ['stream of the exe', 'C:\\Apps\\Kimi Code.exe:evil', /本地盘/],
    ['file URL', 'file:///C:/Apps/Kimi Code.exe', /本地盘/],
    ['app protocol', 'kimi://open/Kimi Code.exe', /本地盘/],
    ['relative', 'Kimi Code.exe', /本地盘/],
    ['relative folder', 'Apps\\Kimi Code.exe', /本地盘/],
    ['drive-relative', 'C:Kimi Code.exe', /本地盘/],
    ['parent folder', 'C:\\Apps\\..\\Windows\\Kimi Code.exe', /\.\./],
    ['current folder', 'C:\\Apps\\.\\Kimi Code.exe', /\.\./],
    ['wrong extension', 'C:\\Apps\\Kimi Code.cmd', /本地盘/],
    ['a shortcut file', 'C:\\Apps\\Kimi Code.exe.lnk', /本地盘/],
    ['another program', 'C:\\Windows\\System32\\calc.exe', /文件名不是 Kimi Code\.exe/],
    ['allowed for another app only', 'C:\\Program Files\\Cursor\\Cursor.exe', /文件名不是/],
    ['Qoder\'s launcher for Kimi', 'C:\\Program Files\\Qoder\\Qoder Launcher.exe', /文件名不是/],
    ['a directory', KIMI, /不是一个文件/, { file: false, link: false }],
    ['missing file', 'C:\\Apps\\Gone\\Kimi Code.exe', /不存在/],
    ['a link', KIMI, /链接/, { file: false, link: true }],
    ['a link to a file', KIMI, /链接/, { file: true, link: true }],
    ['over-long', long, /太长/],
    ['trailing dot', 'C:\\Apps\\Kimi Code.exe.', /本地盘/],
    ['trailing space', 'C:\\Apps\\Kimi Code.exe ', /本地盘/],
    ['folder with a trailing dot', 'C:\\Apps.\\Kimi Code.exe', /以点或空格结尾/],
    ['folder with a trailing space', 'C:\\Apps \\Kimi Code.exe', /以点或空格结尾/],
    ['forward slashes', 'C:/Apps/Kimi Code.exe', /本地盘/],
    ['mixed slashes', 'C:\\Apps/Kimi Code.exe', /本地盘/],
    ['control character', 'C:\\Apps\n\\Kimi Code.exe', /本地盘/],
    ['wildcard', 'C:\\Apps\\*\\Kimi Code.exe', /本地盘/],
    ['environment variable', 'C:\\%TEMP%\\Kimi Code.exe', /%/],
    ['empty', '', /没有路径/],
    ['not a string', { path: KIMI }, /没有路径/],
  ];
  for (const [what, p, reason, stat] of refuse) {
    const fs = io({ files: stat ? { [String(p)]: stat } : { [KIMI]: file } });
    const r = locate.checkProgram(kimi, p, fs);
    assert.equal(r.ok, false, what);
    assert.match(r.reason, reason, what);
    if (!stat && !/不存在/.test(r.reason)) assert.deepEqual(fs.log, [], `${what}: refused before the file is looked at`);
  }
  // MSIX apps start from their alias only: no path is accepted for them, not even their own program in the package.
  for (const id of ['claude', 'codex']) {
    const p = `C:\\Program Files\\WindowsApps\\x\\app\\${appOf(id).exe}`;
    const r = locate.checkProgram(appOf(id), p, io({ files: { [p]: file } }));
    assert.equal(r.ok, false, id);
    assert.match(r.reason, /应用商店/);
  }
  assert.deepEqual(locate.programNames(appOf('qoder')), ['Qoder.exe', 'Qoder Launcher.exe']);
  assert.deepEqual(locate.programNames(kimi), ['Kimi Code.exe'], 'no new names: the app table\'s exe and starter only');
  // The shared shape check (also used for Start Menu shortcut targets) now refuses forward slashes and control characters.
  assert.equal(locate.isLocalProgram('C:/Apps/Kimi Code.exe'), false);
  assert.equal(locate.isLocalProgram(KIMI), true);
});

test('desktop app paths: the file: shape-checked on read, unknown ids and extra fields dropped, size-capped', () => {
  const good = { version: 1, apps: { 'kimi-code': { path: KIMI, source: 'picked', savedAt: '2026-11-16T10:00:00.000Z', args: '--evil', target: 'C:\\x\\calc.exe' },
    calc: { path: 'C:\\Windows\\System32\\calc.exe', source: 'picked', savedAt: 'x' } } };
  assert.deepEqual(paths.parseAppPaths(JSON.stringify(good)), { 'kimi-code': { path: KIMI, source: 'picked', savedAt: '2026-11-16T10:00:00.000Z' } });
  for (const [what, text] of [
    ['not JSON', '{"version":1,'], ['empty', ''], ['null', 'null'], ['an array', '[]'], ['another version', JSON.stringify({ ...good, version: 2 })],
    ['apps not an object', JSON.stringify({ version: 1, apps: [good.apps['kimi-code']] })], ['not a string', 42],
  ] as [string, unknown][]) assert.deepEqual(paths.parseAppPaths(text), {}, what);
  const bad = (e: Record<string, unknown>) => paths.parseAppPaths(JSON.stringify({ version: 1, apps: { 'kimi-code': { path: KIMI, source: 'picked', savedAt: 't', ...e } } }));
  for (const e of [{ path: 1 }, { path: '' }, { path: `C:\\${'a'.repeat(300)}.exe` }, { source: 'hub' }, { source: undefined }, { savedAt: 5 }, { savedAt: 'x'.repeat(41) }]) {
    assert.deepEqual(bad(e), {}, JSON.stringify(e));
  }
  assert.deepEqual(paths.parseAppPaths(JSON.stringify({ version: 1, apps: { ['__proto__']: { path: KIMI, source: 'picked', savedAt: 't' } } })), {});
  // Bigger than MAX_APP_PATHS_BYTES: read as nothing (the shell also skips such a file by its size before reading it).
  const huge = JSON.stringify({ ...good, pad: 'x'.repeat(paths.MAX_APP_PATHS_BYTES) });
  assert.deepEqual(paths.parseAppPaths(huge), {});
  // Written back: known ids and the three fields only; it reads back the same.
  const text = paths.serializeAppPaths({ 'kimi-code': { path: KIMI, source: 'detected', savedAt: 't', extra: 1 }, calc: { path: 'x', source: 'picked', savedAt: 't' } });
  assert.deepEqual(JSON.parse(text), { version: 1, apps: { 'kimi-code': { path: KIMI, source: 'detected', savedAt: 't' } } });
  assert.deepEqual(paths.parseAppPaths(text), { 'kimi-code': { path: KIMI, source: 'detected', savedAt: 't' } });
  // In the shell: its own file, written atomically (a temporary file renamed over it), never desktop-state.json.
  const shell = read('shell.mjs');
  assert.equal(paths.APP_PATHS_FILE, 'app-paths.json');
  assert.match(shell, /const appPathsFile = \(\) => join\(app\.getPath\('userData'\), APP_PATHS_FILE\);/);
  assert.match(shell, /writeFileSync\(`\$\{file\}\.tmp`, serializeAppPaths\(saved, apps\)\);\n {4}renameSync\(`\$\{file\}\.tmp`, file\);/);
  assert.match(shell, /return statSync\(file\)\.size > MAX_APP_PATHS_BYTES \? \{\} : parseAppPaths\(readFileSync\(file, 'utf8'\), apps\);/);
});

test('desktop app paths: a click starts a valid saved path first, re-checked at the click; otherwise the system sources', () => {
  const kimi = appOf('kimi-code');
  const saved = { 'kimi-code': { path: 'D:\\Tools\\Kimi\\Kimi Code.exe', source: 'picked', savedAt: 't' } };
  const shortcut = { links: [{ target: KIMI, args: '' }] };
  const both = { 'D:\\Tools\\Kimi\\Kimi Code.exe': file, [KIMI]: file };
  assert.deepEqual(locate.startTarget(kimi, io({ ...shortcut, files: both, saved })), { ok: true, path: 'D:\\Tools\\Kimi\\Kimi Code.exe', icon: 'D:\\Tools\\Kimi\\Kimi Code.exe' });
  // Deleted or renamed after it was saved: ignored at the click, the shortcut is used; the entry itself stays.
  const gone = io({ ...shortcut, files: { [KIMI]: file }, saved });
  assert.equal(locate.startTarget(kimi, gone).path, KIMI);
  assert.ok(gone.log.includes('lstat D:\\Tools\\Kimi\\Kimi Code.exe'), 'checked again at the click');
  assert.equal(locate.startTarget(kimi, io({ files: {}, saved })).ok, false, 'nothing valid anywhere: not started');
  // Replaced by a link (or a folder) after saving: ignored.
  assert.equal(locate.startTarget(kimi, io({ ...shortcut, files: { ...both, 'D:\\Tools\\Kimi\\Kimi Code.exe': { file: false, link: true } }, saved })).path, KIMI);
  // A tampered file: another program, another app's program, a path with arguments, a URL: all ignored.
  for (const p of ['C:\\Windows\\System32\\calc.exe', 'C:\\Program Files\\Cursor\\Cursor.exe', `${KIMI} --evil`, 'kimi://x', '\\\\srv\\s\\Kimi Code.exe']) {
    const r = locate.startTarget(kimi, io({ ...shortcut, files: { ...both, [p]: file }, saved: { 'kimi-code': { path: p } } }));
    assert.equal(r.path, KIMI, p);
  }
  // MSIX: a saved entry is never used; the app ID is (found through the alias and the package manifest).
  const alias = `${LAD}\\Microsoft\\WindowsApps\\Claude_pzs8sxrjxfjjc\\claude-desktop.exe`;
  const evil = 'C:\\Windows\\System32\\Claude.exe';
  const dir = 'C:\\Program Files\\WindowsApps\\Claude_1.2.3.0_x64__pzs8sxrjxfjjc';
  const texts = { [`${dir}\\AppxManifest.xml`]: '<Applications><Application Id="Claude" Executable="app\\Claude.exe"></Application></Applications>' };
  const r = locate.startTarget(appOf('claude'), io({ files: { [evil]: file }, aliases: { [alias]: `${dir}\\app\\Claude.exe` }, texts, saved: { claude: { path: evil } } }));
  assert.deepEqual([r.path, r.aumid], [alias, 'Claude_pzs8sxrjxfjjc!Claude']);
  // Another app's entry is not this app's.
  assert.equal(locate.startTarget(kimi, io({ files: both, saved: { cursor: saved['kimi-code'] } })).ok, false);
  assert.equal(locate.startTarget.length, 2, 'startTarget(app, sources): nothing else goes in');
});

test('desktop app paths: the settings rows: saved, invalid with its reason, found, running window offered, missing', () => {
  const kimi = appOf('kimi-code');
  const D = 'D:\\Tools\\Kimi\\Kimi Code.exe';
  const W = 'E:\\Portable\\Kimi Code\\Kimi Code.exe';
  const row = (app: App, o: Parameters<typeof io>[0], windows: string[] = []) => paths.settingsRow(app, o?.saved ?? {}, io(o), windows);
  // Found by its shortcut, nothing saved, nothing else: no offer.
  let r = row(kimi, { links: [{ target: KIMI, args: '' }], files: { [KIMI]: file } });
  assert.deepEqual([r.status, r.inUse.path, r.inUse.source, r.offer, r.saved], ['shortcut', KIMI, 'shortcut', null, null]);
  // Not found, but a window of it runs: its program is offered, not saved.
  r = row(kimi, { files: { [W]: file } }, [W]);
  assert.deepEqual([r.status, r.inUse, r.offer], ['window', null, { path: W, source: 'window' }]);
  assert.match(r.reason, /开始菜单/);
  // A running window's program that would not pass is not offered (another program by name, a link).
  assert.equal(row(kimi, { files: { [W]: { file: true, link: true } } }, [W]).offer, null);
  // Saved and valid: used; the shortcut (another location) is offered.
  const saved = { 'kimi-code': { path: D, source: 'picked', savedAt: 't' } };
  r = row(kimi, { links: [{ target: KIMI, args: '' }], files: { [KIMI]: file, [D]: file }, saved });
  assert.deepEqual([r.status, r.inUse.path, r.inUse.source, r.saved.ok, r.offer?.path], ['saved', D, 'saved', true, KIMI]);
  // The same location found again is not offered (case aside).
  r = row(kimi, { links: [{ target: D.toUpperCase(), args: '' }], files: { [D.toUpperCase()]: file, [D]: file }, saved });
  assert.equal(r.offer, null);
  // Saved but gone: "已失效" with the reason, kept (not removed), the shortcut is what a click starts now.
  r = row(kimi, { links: [{ target: KIMI, args: '' }], files: { [KIMI]: file }, saved });
  assert.deepEqual([r.status, r.saved.ok, r.saved.path, r.inUse.path], ['invalid', false, D, KIMI]);
  assert.match(r.saved.reason, /不存在/);
  // Missing everywhere.
  r = row(kimi, {});
  assert.deepEqual([r.status, r.inUse, r.offer], ['missing', null, null]);
  // MSIX: found by its alias; never an offer, not even its running window; a saved entry shows as invalid.
  const alias = `${LAD}\\Microsoft\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0\\chatgpt-desktop.exe`;
  const pkg = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
  const texts = { 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__2p2nqsd0c76g0\\AppxManifest.xml': '<Application Id="App" Executable="app/ChatGPT.exe">' };
  r = row(appOf('codex'), { aliases: { [alias]: pkg }, texts, files: { [pkg]: file } }, [pkg]);
  assert.deepEqual([r.status, r.msix, r.inUse.path, r.inUse.icon, r.offer], ['alias', true, alias, pkg, null]);
  r = row(appOf('codex'), { aliases: { [alias]: pkg }, texts, files: { [pkg]: file }, saved: { codex: { path: pkg, source: 'picked', savedAt: 't' } } });
  assert.deepEqual([r.status, r.inUse.path], ['invalid', alias]);
  // The view's window: under the gear, inside the shell, at most 560 × 640 DIP.
  assert.deepEqual(paths.settingsBounds({ x: 100, y: 50, width: 1280, height: 800 }, 1100, 44), { x: 100 + 1280 - 560 - 4, y: 96, width: 560, height: 640 });
  assert.deepEqual(paths.settingsBounds({ x: 0, y: 0, width: 500, height: 400 }, 300, 44), { x: 4, y: 46, width: 492, height: 350 });
});

/** A function's body in the shell's source, by its name. */
function fnBody(src: string, name: string) {
  const m = new RegExp(`^( *)(?:export )?(?:async )?function ${name}\\(`, 'm').exec(src);
  assert.ok(m, `function ${name}`);
  return src.slice(m.index, src.indexOf(`\n${m[1]}}\n`, m.index) + m[1].length + 3);
}

test('desktop app paths: nothing is saved without the user\'s action in the settings view; the page never sends a path', () => {
  const shell = read('shell.mjs');
  const count = (re: RegExp) => (shell.match(re) ?? []).length;
  // Two writes: saving (savePath) and clearing (clearPath). savePath is reached from 使用这个位置 and from the file dialog
  // only; clearPath from 清除 only; each from the settings view's handler table, behind fromSettings.
  assert.equal(count(/\bwriteAppPaths\(/g), 3, 'defined once, called in savePath and clearPath');
  assert.match(fnBody(shell, 'savePath'), /writeAppPaths\(saved, apps\)/);
  assert.match(fnBody(shell, 'clearPath'), /writeAppPaths\(saved, apps\)/);
  assert.equal(count(/\bsavePath\(/g), 3, 'defined once, called by useOffer and pickProgram');
  assert.match(fnBody(shell, 'useOffer'), /savePath\(a, r\.path, 'detected'\);/);
  assert.match(fnBody(shell, 'pickProgram'), /savePath\(a, r\.filePaths\[0\], 'picked'\)/);
  for (const [fn, n] of [['useOffer', 2], ['pickProgram', 2], ['clearPath', 2], ['detect', 2]] as [string, number][]) {
    assert.equal(count(new RegExp(`\\b${fn}\\(`, 'g')), n, `${fn}: defined once, called once`);
  }
  const table = /^ {2}const settingsHandlers = \{\n([\s\S]*?)^ {2}\};$/m.exec(shell)?.[1] ?? '';
  assert.match(table, /'settings:use': \(req\) => \{ if \(settings\) useOffer\(appOf\(req\.app\), req\.token\); \},/);
  assert.match(table, /'settings:pick': \(id\) => \{ if \(settings\) pickProgram\(appOf\(id\)\); \},/);
  assert.match(table, /'settings:clear': \(id\) => \{ if \(settings\) clearPath\(appOf\(id\)\); \},/);
  assert.match(table, /'settings:detect': \(id\) => \{ if \(settings\) detect\(appOf\(id\)\); \},/);
  assert.match(shell, /^ {2}listen\(settingsHandlers, fromSettings\);$/m);
  // Detection (opening the view, 自动检测) only reads: no write in it.
  for (const fn of ['readSettings', 'detect', 'settingsEvent']) assert.doesNotMatch(fnBody(shell, fn), /writeAppPaths|savePath/, fn);
  // 使用这个位置 saves the path held for the token the page sent, only while that token is current and detection still
  // finds exactly that path; the token is spent first; nothing from the page but the id and the token.
  assert.match(fnBody(shell, 'useOffer'), /const held = offers\[a\.id\];\n {4}delete offers\[a\.id\];\n {4}settings = readSettings\(\);\n {4}const r = confirmOffer\(held, token, settings\.find\(\(x\) => x\.id === a\.id\)\?\.offer\);\n {4}if \(!r\.ok\)/);
  assert.match(fnBody(shell, 'readSettings'), /offers = issueOffers\(offers, rows, randomUUID\);/);
  assert.match(fnBody(shell, 'closeSettings'), /offers = \{\};/, 'closing voids every token');
  // The file dialog is the main process's own, for one .exe; its answer is checked again before it is saved.
  assert.match(fnBody(shell, 'pickProgram'), /dialog\.showOpenDialog\(settingsWin, \{/);
  assert.match(fnBody(shell, 'pickProgram'), /filters: \[\{ name: t\('\{name\} 程序', \{ name: a\.name \}\), extensions: \['exe'\] \}\]/);
  assert.match(fnBody(shell, 'savePath'), /const check = checkProgram\(a, path, io\);\n {4}if \(!check\.ok\)/);
  // Every settings channel takes one supported app id (or nothing, for the close): a path is refused by the check.
  for (const c of ['detect', 'pick', 'clear']) assert.match(shell, new RegExp(`'settings:${c}': oneAppId,`));
  assert.match(shell, /'settings:use': \(\.\.\.args\) => args\.length === 1 && isUseRequest\(args\[0\], apps\),/);
  assert.match(read('settings-preload.cjs'), /use: \(app, token\) => ipcRenderer\.send\('settings:use', \{ app: id\(app\), token: id\(token\) \}\),/);
  assert.match(shell, /const oneAppId = \(\.\.\.args\) => args\.length === 1 && isAppId\(args\[0\], apps\);/);
  assert.match(shell, /'settings:close': \(\.\.\.args\) => args\.length === 0,/);
  assert.match(shell, /'tabs:settings': \(\.\.\.args\) => args\.length === 1 && Number\.isFinite\(args\[0\]\),/);
  const preload = read('settings-preload.cjs');
  assert.deepEqual([...preload.matchAll(/ipcRenderer\.(send|on|invoke|sendSync)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`),
    ['on settings:state', 'send settings:detect', 'send settings:use', 'send settings:pick', 'send settings:clear', 'send settings:language', 'send settings:close']);
  assert.deepEqual([...preload.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ['onState', 'detect', 'use', 'pick', 'clear', 'language', 'close'], 'all it exposes');
  assert.match(preload, /const id = \(v\) => \(typeof v === 'string' \? v : ''\);/);
  // The tab bar gains the gear's call only; the panel's preload is unchanged; the collaboration page has no preload.
  const tabsPreload = read('preload.cjs');
  assert.match(tabsPreload, /settings: \(x\) => ipcRenderer\.send\('tabs:settings', Number\(x\)\),/);
  assert.doesNotMatch(tabsPreload, /'settings:/);
  assert.doesNotMatch(read('strip-preload.cjs'), /settings/);
  const collab = /const collab = new WebContentsView\(\{([\s\S]*?)\}\);/.exec(shell)?.[1] ?? '';
  assert.ok(collab && !/preload/.test(collab), 'the collaboration page has no preload');
});

test('desktop app paths: the state file, the page, the Hub or a docked window never become a launch target', () => {
  // desktop-state.json: fields that look like start targets are dropped when it is read, and it is not app-paths.json.
  const tampered = { version: 1, tabs: [{ app: 'kimi-code', exe: 'C:\\evil\\calc.exe', title: 'k', path: 'C:\\evil\\calc.exe', appPaths: { 'kimi-code': 'x' } }], appPaths: { 'kimi-code': { path: 'C:\\evil\\Kimi Code.exe' } } };
  assert.deepEqual(dock.loadTabs(tampered), [{ app: 'kimi-code', exe: 'calc.exe', title: 'k' }]);
  const shell = read('shell.mjs');
  assert.match(shell, /const statePath = join\(app\.getPath\('userData'\), 'desktop-state\.json'\);/);
  assert.doesNotMatch(fnBody(shell, 'readAppPaths'), /statePath|desktop-state/);
  assert.doesNotMatch(fnBody(shell, 'persist'), /AppPaths|app-paths/, 'the state file\'s writer writes no paths');
  // The launch: launchTarget(a) at the click, a fresh lookup (system sources + app-paths.json); nothing else goes in.
  assert.match(fnBody(shell, 'launchApp'), /^ {4}const target = launchTarget\(a\);$/m);
  // Looked up (and a saved path checked) right before the one start call: nothing slow between them.
  const body = fnBody(shell, 'launchApp');
  assert.ok(body.indexOf('startApp(target, ') > body.indexOf('const target = launchTarget(a);'));
  assert.doesNotMatch(body.slice(body.indexOf('const target = launchTarget(a);'), body.indexOf('startApp(target, ')), /listCandidates|readSettings|await/);
  assert.doesNotMatch(fnBody(shell, 'launchApp'), /state\.|statePath|exePath|binding|hub\.|collab|wc\.|offered|settings/);
  // A running window's program is only offered (readSettings); it reaches the file only through useOffer → savePath.
  assert.doesNotMatch(fnBody(shell, 'readSettings'), /writeAppPaths|savePath/);
  // The pure lookup: the saved entry is re-checked by checkProgram before it is returned; nothing else is read.
  const src = read('lib/locate.mjs');
  assert.match(fnBody(src, 'startTarget'), /if \(saved && checkProgram\(app, saved\.path, io\)\.ok\) return \{ ok: true, path: saved\.path, icon: saved\.path \};\n {2}return locateApp\(app, io\);/);
});

test('desktop app paths: the settings view is the shell\'s own trusted page, opened and closed like the + panel', () => {
  const shell = read('shell.mjs');
  const win = /const settingsWin = new BrowserWindow\(\{([\s\S]*?)\n {2}\}\);/.exec(shell)?.[1] ?? '';
  assert.match(win, /^\n {4}show: false, frame: false, alwaysOnTop: true, skipTaskbar: true,/);
  assert.doesNotMatch(win, /parent|modal/, 'no owner (as the + panel: lowerShell)');
  assert.match(win, /webPreferences: \{ preload: SETTINGS_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false \}/);
  assert.match(shell, /export const SETTINGS_PAGE = pathToFileURL\(join\(HERE, 'ui', 'settings\.html'\)\)\.href;/);
  assert.equal((shell.match(/settingsWin\.loadURL\(/g) ?? []).length, 1, 'loaded once; a language switch redraws it in place');
  assert.match(shell, /settingsPage\.on\('before-input-event', \(e, input\) => \{ if \(reloadKey\(input\)\) e\.preventDefault\(\); \}\);/);
  assert.match(shell, /win\.on\('closed', \(\) => \{ if \(!settingsWin\.isDestroyed\(\)\) settingsWin\.destroy\(\); \}\);/);
  assert.match(fnBody(shell, 'quit'), /if \(!settingsWin\.isDestroyed\(\)\) settingsWin\.destroy\(\);/);
  assert.match(shell, /settingsWin\.on\('close', \(e\) => \{ if \(closing\) return; e\.preventDefault\(\); closeSettings\(\); \}\);/);
  assert.match(shell, /for \(const e of \['move', 'resize', 'minimize', 'hide'\]\) win\.on\(e, \(\) => closeSettings\(\)\);/);
  // The + panel's rules: panelStep decides; opening one closes the other; Win32 is never used for it.
  const ev = fnBody(shell, 'settingsEvent');
  assert.match(ev, /const act = panelStep\(!!settings, event, focus\);/);
  assert.match(ev, /closeStrip\(\);/);
  assert.match(fnBody(shell, 'panelEvent'), /closeSettings\(\);/);
  assert.doesNotMatch(shell, /ffi\.\w+\([^)]*settings/);
  assert.match(shell, /'tabs:settings': \(x\) => settingsEvent\('plus', x\),/);
  // Its page: the tab bar's CSP, text only, loads and opens nothing.
  const html = read('ui/settings.html');
  const csp = (h: string) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(h)?.[1];
  assert.equal(csp(html), csp(read('ui/tabs.html')));
  assert.doesNotMatch(html, /<img|<iframe|https?:|<script>|style=/);
  const js = read('ui/settings.mjs');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|fetch\(|XMLHttpRequest|import\(|location|window\.open/);
  // The gear: keyboard reachable (a button), named, and a press on it does not count as a press elsewhere.
  assert.match(read('ui/tabs.html'), /<button id="settings" type="button" data-i18n-title="[^"]+" title="[^"]+" data-i18n-aria-label="应用位置设置" aria-label="应用位置设置" aria-expanded="false" aria-haspopup="dialog">/);
  // Opened before its page (or the + panel's) had loaded: the state is sent again once it has.
  assert.match(shell, /strips\.on\('did-finish-load', \(\) => render\(\)\);\n {2}settingsPage\.on\('did-finish-load', \(\) => render\(\)\);/);
});

test('desktop app paths: 使用这个位置 saves only the offer the view showed, by its token', () => {
  let n = 0;
  const mint = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const OLD = 'D:\\Old\\Antigravity.exe';
  const NEW = 'E:\\New\\Antigravity.exe';
  const rows = (offers: Record<string, string | null>) => Object.entries(offers).map(([id, path]) => ({ id, offer: path ? { path, source: 'window' } : null }));
  // The view shows OLD for antigravity with token t1.
  let held = paths.issueOffers({}, rows({ antigravity: OLD, zcode: null }), mint);
  const t1 = held.antigravity.token;
  assert.deepEqual(Object.keys(held), ['antigravity'], 'no offer, no token');
  // The reviewer's sequence: a detect (for any app) refreshes everything and antigravity's offer is now NEW; the old
  // page's queued click still carries t1.
  held = paths.issueOffers(held, rows({ antigravity: NEW, zcode: null }), mint);
  const t2 = held.antigravity.token;
  assert.notEqual(t2, t1, 'a changed offer gets a new token');
  assert.deepEqual(paths.confirmOffer(held.antigravity, t1, { path: NEW }), { ok: false }, 'the old click saves nothing');
  // The fresh click with t2, detection still NEW: NEW is saved (the path held here, not anything from the page).
  assert.deepEqual(paths.confirmOffer(held.antigravity, t2, { path: NEW }), { ok: true, path: NEW });
  assert.deepEqual(paths.confirmOffer(held.antigravity, t2, { path: OLD }), { ok: false }, 'detection at the click finds another path');
  assert.deepEqual(paths.confirmOffer(held.antigravity, t2, null), { ok: false }, 'nothing offered any more');
  assert.deepEqual(paths.confirmOffer(undefined, t2, { path: NEW }), { ok: false }, 'spent or never issued');
  assert.deepEqual(paths.confirmOffer(held.antigravity, t2, { path: NEW.toUpperCase() }), { ok: false }, 'exactly the same path');
  // An unchanged offer keeps its token across refreshes (a detect for another app does not void a valid click).
  assert.equal(paths.issueOffers(held, rows({ antigravity: NEW }), mint).antigravity.token, t2);
  // Offer gone and back: a new token (the old one stays void).
  const gone = paths.issueOffers(held, rows({ antigravity: null }), mint);
  assert.notEqual(paths.issueOffers(gone, rows({ antigravity: NEW }), mint).antigravity.token, t2);
  // A token from app A is not app B's.
  const two = paths.issueOffers({}, rows({ antigravity: NEW, zcode: 'E:\\Z\\ZCode.exe' }), mint);
  assert.deepEqual(paths.confirmOffer(two.zcode, two.antigravity.token, { path: 'E:\\Z\\ZCode.exe' }), { ok: false });
  // The request's shape: exactly { app, token }, a supported id and a token as crypto.randomUUID makes them.
  const tok = '3b241101-e2bb-4255-8caf-4136c566a962';
  assert.equal(paths.isOfferToken(crypto.randomUUID()), true);
  assert.equal(paths.isUseRequest({ app: 'zcode', token: tok }), true);
  for (const bad of [null, 'zcode', ['zcode', tok], { app: 'zcode' }, { token: tok }, { app: 'calc', token: tok }, { app: 'zcode', token: tok.toUpperCase() },
    { app: 'zcode', token: `${tok}0` }, { app: 'zcode', token: 'x'.repeat(36) }, { app: 'zcode', token: tok, path: 'C:\\x\\ZCode.exe' }, { app: 'zcode', token: 1 },
    Object.assign(Object.create({ inherited: 1 }), { app: 'zcode', token: tok })]) {
    assert.equal(paths.isUseRequest(bad), false, JSON.stringify(bad));
  }
});
