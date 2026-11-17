// docs/desktop.md tests A (authorization and identity), B (ordering), C (write interception, allow-list) and the
// boundary rules of the desktop shell. Plain Node: the pure modules of desktop/lib and a recording fake of the Win32
// layer (desktop/test/fake-ffi.mjs); no Electron, no koffi, no real window is touched.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';
import { tempDir } from './helpers.ts';

const DESKTOP = join(REPO_ROOT, 'desktop');
const load = (rel: string) => import(pathToFileURL(join(DESKTOP, rel)).href);
const apps = await load('lib/apps.mjs');
const windows = await load('lib/windows.mjs');
const geometry = await load('lib/geometry.mjs');
const writerMod = await load('lib/writer.mjs');
const dock = await load('lib/dock.mjs');
const nav = await load('lib/navigation.mjs');
const startup = await load('lib/startup.mjs');
const shortcut = await load('shortcut.mjs');
const { createFakeFfi, fakeWindow } = await load('test/fake-ffi.mjs');

type Call = { fn: string; hwnd: number; after?: number; flags?: number; cmd?: number; tag?: string; placement?: Record<string, unknown> };
type Rect = { x: number; y: number; width: number; height: number };

const RECT: Rect = { x: 0, y: 72, width: 2560, height: 1368 };
/** The shell's own top-level window in the harness (not an app: its image is not in the app table). */
const OWN = 0x5e11;

/** A shell in miniature: the reducer, the writer and a fake FFI, wired as desktop/shell.mjs wires them. */
type DockedPosition = (ffi: unknown, shell: number, docked: number | number[], area: Rect | null) => string;

/**
 * `zorder`: the z-order read is the real lib/windows.mjs dockedPosition over the fake's z-order (or the given
 * implementation); otherwise the test sets what it says with `h.position` / `h.below`.
 */
function harness(wins: Record<string, unknown>[], opts: { rect?: Rect | null; gap?: number; focused?: boolean; zorder?: boolean | DockedPosition } = {}) {
  const ffi = createFakeFfi([...wins, fakeWindow({ hwnd: OWN, pid: 9000, exePath: 'C:\\orrery\\desktop\\electron.exe', title: 'orrery' })]);
  const w = writerMod.createWriter(ffi, { ownWindow: () => OWN });
  let state = dock.initialState();
  const notices: string[] = [];
  const failures: Record<string, unknown>[] = [];
  let position = 'front';   // what the shell's z-order read says, unless `zorder` makes it real
  const read: DockedPosition | null = opts.zorder === true ? windows.dockedPosition : opts.zorder || null;
  const env = () => {
    const rect = opts.rect === undefined ? RECT : opts.rect;
    return { rect, gap: opts.gap ?? 0, capture: (c: unknown) => w.capture(c),
      dockedPosition: (hwnds: number[]) => (read ? read(ffi, OWN, hwnds, rect) : position),
      topmost: (hwnds: number[]) => windows.topmostOf(ffi, hwnds), verify: (b: unknown) => w.verify(b) };
  };
  const dispatch = (event: Record<string, unknown>) => {
    ffi.tag = String(event.type);
    const r = dock.step(state, event, env());
    state = r.state;
    notices.push(...r.notices.map((n: { text: string }) => n.text));
    const out = dock.runOps(r.ops, (o: unknown) => w.write(o), dock.liveIn(state));
    failures.push(...out.failures);
    const after = dock.afterOps(state, out, env());
    state = after.state;
    notices.push(...after.notices.map((n: { text: string }) => n.text));
    ffi.tag = null;
    return r;
  };
  /** The + list or a tab's choice list, as the main process builds it. */
  const candidates = (app: string | null = null) => windows.listCandidates(ffi, {
    exclude: state.tabs.flatMap((t: { binding: { hwnd: number } | null }) => (t.binding ? [t.binding.hwnd] : [])), app,
  });
  const add = (hwnd: number) => {
    const c = candidates().find((x: { hwnd: number }) => x.hwnd === hwnd);
    assert.ok(c, `0x${hwnd.toString(16)} is in the + list`);
    return dispatch({ type: 'add', candidate: c });
  };
  return { ffi, writer: w, dispatch, add, candidates, notices, failures, get state() { return state; }, set state(s) { state = s; }, set below(v: boolean) { position = v ? 'under' : 'front'; }, set position(p: string) { position = p; } };
}

const calls = (h: { ffi: { calls: Call[] } }) => h.ffi.calls;
const fns = (cs: Call[]) => cs.map((c) => c.fn);

// --- A: authorization and identity -----------------------------------------------------------------------------

test('desktop A: the choice list leaves out tool, owned, topmost, cloaked, untitled, hidden and unsupported windows', () => {
  const ok = fakeWindow({ hwnd: 1 });
  const ffi = createFakeFfi([
    ok,
    fakeWindow({ hwnd: 2, iconic: true, visible: false, title: 'minimized Claude' }),   // minimized counts
    fakeWindow({ hwnd: 3, exStyle: 0x80 }),                 // tool window
    fakeWindow({ hwnd: 4, owner: 1 }),                      // has an owner
    fakeWindow({ hwnd: 5, exStyle: 0x8 }),                  // topmost: not supported
    fakeWindow({ hwnd: 6, cloaked: true }),                 // other virtual desktop
    fakeWindow({ hwnd: 7, cloaked: null }),                 // cloaking unreadable
    fakeWindow({ hwnd: 8, title: '  ' }),                   // no title
    fakeWindow({ hwnd: 9, visible: false }),                // hidden (e.g. in the tray)
    fakeWindow({ hwnd: 10, root: 1 }),                      // not top-level
    fakeWindow({ hwnd: 11, pid: 11, exePath: 'C:\\Windows\\notepad.exe' }),   // not in the app table
    fakeWindow({ hwnd: 12, pid: 12, unreadable: true, exePath: 'C:\\x\\Claude.exe' }),   // image path unreadable
    fakeWindow({ hwnd: 13, pid: 13, exePath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Kimi Code\\Kimi Code.exe', title: 'Kimi Code' }),
  ]);
  assert.deepEqual(windows.listCandidates(ffi).map((w: { hwnd: number }) => w.hwnd), [1, 2, 13]);
  assert.deepEqual(windows.listCandidates(ffi, { exclude: [1] }).map((w: { hwnd: number }) => w.hwnd), [2, 13]);
  assert.deepEqual(windows.listCandidates(ffi, { app: 'kimi-code' }).map((w: { appName: string }) => w.appName), ['Kimi Code']);
  assert.equal(ffi.calls.length, 0, 'listing writes nothing');
});

test('desktop A: the app table matches image file names without case; Kimi.exe is not Kimi Code', () => {
  assert.equal(apps.appForImage('C:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__x\\app\\claude.exe').id, 'claude');
  assert.equal(apps.appForImage('C:/x/CHATGPT.EXE').id, 'codex');
  assert.equal(apps.appForImage('C:\\x\\Kimi.exe'), null);
  assert.equal(apps.appForImage('C:\\x\\Codex.exe'), null);
  assert.deepEqual(apps.APPS.map((a: { id: string }) => a.id), ['claude', 'codex', 'deepseek', 'kimi-code', 'zcode', 'antigravity', 'qoder', 'workbuddy', 'cursor']);
  assert.equal(apps.appForImage('C:\\Program Files\\cursor\\Cursor.exe').id, 'cursor');
  assert.equal(apps.appForImage('C:\\Program Files\\WorkBuddy\\WorkBuddy.exe').id, 'workbuddy');
});

test('desktop A: identity is handle + pid + full image path + class, top-level, no owner, not topmost; the title is not part of it', () => {
  const base = fakeWindow({ hwnd: 1 });
  const id = { hwnd: 1, pid: base.pid, exePath: base.exePath, className: base.className };
  const seen = (over: Record<string, unknown>) => windows.identityMismatch(id, windows.observe(createFakeFfi([fakeWindow({ hwnd: 1, ...over })]), 1));
  assert.equal(seen({}), null);
  assert.equal(seen({ title: 'Claude — another title' }), null, 'a new title is still the same window');
  assert.equal(seen({ exePath: base.exePath.toUpperCase() }), null, 'paths compare without case');
  const cases: [Record<string, unknown>, string][] = [
    [{ destroyed: true }, 'gone'],
    [{ pid: 4001 }, 'pid'],
    [{ exePath: 'C:\\Other\\Claude.exe' }, 'image'],
    [{ className: 'Chrome_WidgetWin_0' }, 'class'],
    [{ root: 99 }, 'not-top-level'],
    [{ owner: 7 }, 'owner'],
    [{ exStyle: 0x8 }, 'topmost'],
    [{ unreadable: true }, 'unreadable'],   // e.g. an elevated process: no query rights, never retried with more
    [{ className: null }, 'unreadable'],
    [{ pid: 0 }, 'unreadable'],
  ];
  for (const [over, reason] of cases) assert.equal(seen(over), reason, JSON.stringify(over));
  // The same path on a process that is no longer an app from the table (renamed image) is refused too.
  const renamed = { ...id, exePath: 'C:\\x\\renamed.exe' };
  assert.equal(windows.identityMismatch(renamed, windows.observe(createFakeFfi([fakeWindow({ hwnd: 1, exePath: 'C:\\x\\renamed.exe' })]), 1)), 'app');
  // A read that throws is a failure, not a pass.
  const throwing = createFakeFfi([fakeWindow({ hwnd: 1 })]);
  Object.defineProperty(throwing.windows.get(1), 'pid', { get() { throw new Error('access denied'); } });
  assert.equal(windows.identityMismatch(id, windows.observe(throwing, 1)), 'unreadable');
});

test('desktop A: a window that was not picked (B) never gets a write, through every action', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const b = fakeWindow({ hwnd: 0xb, title: 'Claude — popout' });
  const h = harness([a, b]);
  h.add(0xa);
  h.below = true;
  for (const e of ['bounds', 'focus', 'restack', 'minimize', 'restack', 'restore', 'bounds', 'restack']) h.dispatch({ type: e });
  h.dispatch({ type: 'select', id: dock.ORRERY });
  h.dispatch({ type: 'select', id: 't1' });
  h.dispatch({ type: 'close', id: 't1' });
  h.dispatch({ type: 'quit' });
  assert.ok(calls(h).length > 5);
  assert.deepEqual([...new Set(calls(h).filter((c) => c.hwnd !== OWN).map((c) => c.hwnd))], [0xa], 'only the picked window');
  assert.ok(calls(h).some((c) => c.hwnd === OWN), 'the shell was lowered');
  assert.ok(calls(h).filter((c) => c.hwnd === OWN).every((c) => c.after === 0xa), 'and only ever beneath the picked window');
});

test('desktop A: when A is gone, the only other window of the same app is not taken over; the user must pick it', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const b = fakeWindow({ hwnd: 0xb, pid: 4100, title: 'Claude (new process)' });
  const h = harness([a, b]);
  h.add(0xa);
  h.dispatch({ type: 'select', id: dock.ORRERY });
  const before = calls(h).length;
  a.destroyed = true;   // e.g. the app updated and restarted with a new window
  h.dispatch({ type: 'select', id: 't1' });
  for (const e of ['bounds', 'focus', 'minimize', 'restore']) h.dispatch({ type: e });
  assert.deepEqual(calls(h).slice(before), [], 'zero writes, to A or to B');
  assert.equal(h.state.tabs[0].binding, null, 'the tab needs a new pick');
  assert.equal(dock.view(h.state).tabs[0].status, 'choose');
  // Selecting the unbound tab does nothing by itself (the shell opens its choice list); B stays untouched.
  h.dispatch({ type: 'select', id: 't1' });
  assert.deepEqual(calls(h).slice(before), []);
  // Only the explicit pick binds B.
  const [only] = h.candidates('claude');
  assert.equal(only.hwnd, 0xb);
  h.dispatch({ type: 'choose', id: 't1', candidate: only });
  assert.deepEqual([...new Set(calls(h).slice(before).filter((c) => c.hwnd !== OWN).map((c) => c.hwnd))], [0xb]);
  assert.ok(calls(h).slice(before).filter((c) => c.hwnd === OWN).every((c) => c.after === 0xb), 'the shell went beneath B only');
});

test('desktop A: a cancelled pick, a pick whose identity changed meanwhile, and a failed query are all zero writes', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const h = harness([a]);
  // Cancel: the menu closes without a pick, so no event reaches the reducer at all.
  assert.deepEqual(calls(h), []);
  const listed = h.candidates()[0];
  for (const change of [{ pid: 4999 }, { className: 'Other' }, { exePath: 'C:\\elsewhere\\Claude.exe' }, { destroyed: true }, { exStyle: 0x8 }, { owner: 3 }]) {
    const saved = { ...a };
    Object.assign(a, change);
    h.dispatch({ type: 'add', candidate: listed });
    Object.assign(a, saved);
    assert.deepEqual(calls(h), [], JSON.stringify(change));
    assert.equal(h.state.tabs.length, 0);
  }
  a.unreadable = true;   // the image path cannot be read
  h.dispatch({ type: 'add', candidate: listed });
  a.unreadable = false;
  a.placementOk = false;   // the original placement cannot be read: not taken over
  h.dispatch({ type: 'add', candidate: listed });
  assert.deepEqual(calls(h), []);
  assert.equal(h.state.tabs.length, 0);
  assert.ok(h.notices.length >= 8);
});

test('desktop A: putting back is checked like every other write', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const b = fakeWindow({ hwnd: 0xb, pid: 4100 });
  const h = harness([a, b]);
  h.add(0xa);
  h.add(0xb);
  const before = calls(h).length;
  a.pid = 4200;          // same handle, other process: not the bound window any more
  a.destroyed = false;
  b.className = 'Changed';
  h.dispatch({ type: 'close', id: 't1' });
  h.dispatch({ type: 'quit' });
  assert.deepEqual(calls(h).slice(before), [], 'no SetWindowPlacement to a window that is not the bound one');
});

test('desktop A: one window cannot be bound to two tabs', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const h = harness([a]);
  const c = h.candidates()[0];
  h.dispatch({ type: 'add', candidate: c });
  const n = calls(h).length;
  h.dispatch({ type: 'add', candidate: c });
  assert.equal(h.state.tabs.length, 1);
  assert.equal(calls(h).length, n);
  assert.deepEqual(h.candidates(), [], 'a bound window is not offered again');
  // An unbound tab of the same app cannot take it either.
  h.state = { ...h.state, tabs: [...h.state.tabs, { id: 't9', app: 'claude', exe: 'Claude.exe', title: 'old', binding: null }] };
  h.dispatch({ type: 'choose', id: 't9', candidate: c });
  assert.equal(h.state.tabs[1].binding, null);
  assert.equal(calls(h).length, n);
});

test('desktop A: DIP to pixels at 100 %, 150 % and 200 %; a maximized orrery window; a display to the left', () => {
  const at = (scale: number, dipW: number, dipH: number) => ({ dip: { x: 0, y: 0, width: dipW, height: dipH }, px: { x: 0, y: 0, width: dipW * scale, height: dipH * scale }, scale });
  // The window has no separate title bar: its content area starts at the top, the 44-DIP tab row is the title row.
  assert.equal(geometry.TAB_BAR_HEIGHT, 44);
  const content = { x: 100, y: 50, width: 801, height: 601 };
  const dockDip = geometry.dockArea(content, geometry.TAB_BAR_HEIGHT);
  assert.deepEqual(dockDip, { x: 100, y: 94, width: 801, height: 557 });
  assert.deepEqual(geometry.toPhysical(dockDip, at(1, 1920, 1080)), { x: 100, y: 94, width: 801, height: 557 });
  assert.deepEqual(geometry.toPhysical(dockDip, at(1.5, 1280, 720)), { x: 150, y: 141, width: 1202, height: 836 }, 'edges rounded, not sizes');
  assert.deepEqual(geometry.toPhysical(dockDip, at(2, 1440, 900)), { x: 200, y: 188, width: 1602, height: 1114 });
  // Maximized at 150 % on 1920 × 1080 with a 48 px taskbar: the content area is the work area, 1280 × 688 DIP.
  const max = geometry.toPhysical(geometry.dockArea({ x: 0, y: 0, width: 1280, height: 688 }, geometry.TAB_BAR_HEIGHT), at(1.5, 1280, 720));
  assert.deepEqual([max.x, max.y], [0, 66], 'starts right under the tab row (44 DIP = 66 px)');
  assert.equal(max.x + max.width, 1920, 'reaches the right edge');
  assert.equal(max.y + max.height, 1032, 'ends at the work area bottom (1080 - 48)');
  // A 150 % display left of the primary one: negative coordinates are kept.
  const left = { dip: { x: -1280, y: 0, width: 1280, height: 720 }, px: { x: -1920, y: 0, width: 1920, height: 1080 }, scale: 1.5 };
  assert.deepEqual(geometry.toPhysical({ x: -1000, y: 10, width: 400, height: 300 }, left), { x: -1500, y: 15, width: 600, height: 450 });
});

test('desktop A: non-finite numbers and non-positive sizes are refused; negative positions are fine', () => {
  for (const r of [{ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: Infinity, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 5, height: -1 }, { x: '1', y: 0, width: 1, height: 1 }, null]) {
    assert.equal(geometry.isRect(r), false, JSON.stringify(r));
  }
  assert.equal(geometry.isRect({ x: -2000, y: -50, width: 10, height: 10 }), true);
  assert.equal(geometry.toPhysical({ x: 0, y: 0, width: 0, height: 10 }, { dip: RECT, px: RECT, scale: 1 }), null);
  assert.equal(geometry.toPhysical(RECT, { dip: RECT, px: RECT, scale: NaN }), null);
  const wp = { flags: 0, showCmd: 1, ptMinPosition: { x: -1, y: -1 }, ptMaxPosition: { x: -1, y: -1 }, rcNormalPosition: { left: -1900, top: -40, right: -100, bottom: 900 } };
  assert.equal(geometry.validPlacement(wp), true, 'negative coordinates allowed');
  for (const bad of [{ ...wp, showCmd: 12 }, { ...wp, flags: 1.5 }, { ...wp, rcNormalPosition: { left: 0, top: 0, right: 0, bottom: 10 } },
    { ...wp, rcNormalPosition: { left: 0, top: 0, right: NaN, bottom: 10 } }, { ...wp, ptMinPosition: { x: Infinity, y: 0 } }, null]) {
    assert.equal(geometry.validPlacement(bad), false, JSON.stringify(bad));
  }
  // Invisible resize borders are added around the visible rect; implausible ones are ignored.
  assert.deepEqual(geometry.outerRect({ x: 10, y: 20, width: 100, height: 50 }, { left: 3, top: 20, right: 117, bottom: 77 }, { left: 10, top: 20, right: 110, bottom: 70 }),
    { x: 3, y: 20, width: 114, height: 57 });
  assert.deepEqual(geometry.outerRect({ x: 10, y: 20, width: 100, height: 50 }, { left: -500, top: 20, right: 117, bottom: 77 }, { left: 10, top: 20, right: 110, bottom: 70 }),
    { x: 10, y: 20, width: 100, height: 50 });
  // A rect the shell cannot compute moves nothing.
  const h = harness([fakeWindow({ hwnd: 0xa })], { rect: null });
  h.add(0xa);
  assert.deepEqual(calls(h), []);
});

test('desktop A: the state file keeps only app, image file name and last title; after a restart no tab is bound', () => {
  const h = harness([fakeWindow({ hwnd: 0xa })]);
  h.add(0xa);
  const saved = dock.savedState(h.state);
  assert.deepEqual(saved, { version: 1, layout: 'single', ratios: { x: 0.5, y: 0.5 }, tabs: [{ app: 'claude', exe: 'Claude.exe', title: 'Claude' }] });
  assert.doesNotMatch(JSON.stringify(saved), /hwnd|pid|placement|rcNormal|Apps/);
  const again = dock.initialState(dock.loadTabs(JSON.parse(JSON.stringify(saved))));
  assert.deepEqual(again.tabs.map((t: { binding: unknown }) => t.binding), [null]);
  // Junk in the file is dropped, never trusted.
  assert.deepEqual(dock.loadTabs({ version: 1, tabs: [{ app: 'nope', exe: 'x.exe', title: 't' }, { app: 'claude', exe: 'C:\\a\\Claude.exe', title: 'x', hwnd: 5, placement: {} }, 7] }),
    [{ app: 'claude', exe: 'Claude.exe', title: 'x' }]);
  assert.deepEqual(dock.loadTabs({ version: 2, tabs: [] }), []);
  // A restarted shell writes nothing on its own, whatever events arrive.
  const r = harness([fakeWindow({ hwnd: 0xa })]);
  r.state = again;
  for (const e of [{ type: 'focus' }, { type: 'bounds' }, { type: 'select', id: 't1' }, { type: 'minimize' }, { type: 'restore' }, { type: 'quit' }]) r.dispatch(e);
  assert.deepEqual(calls(r), []);
});

// --- B: ordering --------------------------------------------------------------------------------------------------

test('desktop B: switching tabs minimizes the old window and docks the new one; the orrery tab minimizes it', () => {
  const h = harness([fakeWindow({ hwnd: 0xa }), fakeWindow({ hwnd: 0xb, pid: 4100 })]);
  h.add(0xa);
  assert.deepEqual(calls(h).map((c) => [c.fn, c.hwnd, c.tag]), [['SetWindowPos', 0xa, 'add'], ['SetForegroundWindow', 0xa, 'add'], ['SetWindowPos', OWN, 'add']],
    'record the placement (a read), already normal so no restore, place, foreground, the shell right beneath it');
  h.ffi.calls.length = 0;
  h.add(0xb);
  h.dispatch({ type: 'select', id: 't1' });
  h.dispatch({ type: 'select', id: dock.ORRERY });
  assert.deepEqual(calls(h).map((c) => [c.fn, c.hwnd, c.cmd ?? '']), [
    ['SetWindowPos', 0xb, ''], ['SetForegroundWindow', 0xb, ''], ['SetWindowPos', OWN, ''], ['ShowWindow', 0xa, 7],   // add B, then A minimized
    ['ShowWindow', 0xa, 9], ['SetWindowPos', 0xa, ''], ['SetForegroundWindow', 0xa, ''], ['SetWindowPos', OWN, ''], ['ShowWindow', 0xb, 7],   // back to A
    ['ShowWindow', 0xa, 7],                                                                                 // orrery tab
  ]);
});

test('desktop B: after closing or quitting, late follow-ups never move or minimize the window again', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const h = harness([a]);
  h.add(0xa);
  // A follow-up computed before the close, run after it (as a queued task would be).
  const late = dock.step(h.state, { type: 'bounds' }, { rect: RECT, focused: false, capture: () => ({ ok: false, reason: 'x' }) }).ops;
  const lateMin = dock.step(h.state, { type: 'minimize' }, { rect: RECT, focused: false, capture: () => ({ ok: false, reason: 'x' }) }).ops;
  assert.equal(late.length, 1);
  h.dispatch({ type: 'bounds' });
  h.dispatch({ type: 'close', id: 't1' });
  const closedAt = calls(h).length;
  assert.equal(calls(h)[closedAt - 1].fn, 'SetWindowPlacement');
  const ran = dock.runOps([...late, ...lateMin], (o: unknown) => h.writer.write(o), dock.liveIn(h.state));
  for (const e of ['bounds', 'focus', 'minimize', 'restore']) h.dispatch({ type: e });
  h.dispatch({ type: 'close', id: 't1' });   // closed twice
  h.dispatch({ type: 'quit' });              // then the shell quits
  h.dispatch({ type: 'quit' });
  assert.deepEqual(ran, { lost: [], failures: [], observed: [] });
  assert.equal(calls(h).length, closedAt, 'nothing after the put-back');

  // The same for quit: one put-back per window, then nothing.
  const q = harness([fakeWindow({ hwnd: 0xa }), fakeWindow({ hwnd: 0xb, pid: 4100 })]);
  q.add(0xa);
  q.add(0xb);
  const pending = dock.step(q.state, { type: 'bounds' }, { rect: RECT, focused: true, capture: () => ({ ok: false, reason: 'x' }) }).ops;
  q.dispatch({ type: 'quit', trigger: 'shutdown' });
  const n = calls(q).length;
  dock.runOps(pending, (o: unknown) => q.writer.write(o), dock.liveIn(q.state));
  for (const e of ['bounds', 'focus', 'restore', 'minimize', 'quit']) q.dispatch({ type: e });
  assert.equal(calls(q).length, n);
  assert.deepEqual(calls(q).filter((c) => c.fn === 'SetWindowPlacement').map((c) => [c.hwnd, c.tag]), [[0xa, 'quit'], [0xb, 'quit']]);
});

test('desktop B: one window that cannot be put back does not stop the others; the failure is reported', () => {
  const a = fakeWindow({ hwnd: 0xa, setPlacementOk: false });
  const b = fakeWindow({ hwnd: 0xb, pid: 4100 });
  const c = fakeWindow({ hwnd: 0xc, pid: 4200 });
  const h = harness([a, b, c]);
  h.add(0xa); h.add(0xb); h.add(0xc);
  c.destroyed = true;
  h.dispatch({ type: 'quit' });
  assert.deepEqual(calls(h).filter((x) => x.fn === 'SetWindowPlacement').map((x) => x.hwnd), [0xa, 0xb]);
  assert.deepEqual(h.failures.map((f) => [f.tab, f.op, f.reason]), [['t1', 'putBack', 'SetWindowPlacement']]);
  assert.deepEqual(b.normal, { left: 100, top: 100, right: 900, bottom: 700 }, 'B is back where it was');
});

test('desktop B: rebinding reads a new placement; the old one is never applied to the new window', () => {
  const a = fakeWindow({ hwnd: 0xa, normal: { left: 10, top: 10, right: 410, bottom: 310 } });
  const h = harness([a]);
  h.add(0xa);
  a.destroyed = true;
  const b = h.ffi.add(fakeWindow({ hwnd: 0xb, pid: 4100, normal: { left: 600, top: 50, right: 1400, bottom: 650 }, zoomed: true }));
  h.dispatch({ type: 'select', id: 't1' });   // lost → needs a new pick
  h.dispatch({ type: 'choose', id: 't1', candidate: h.candidates('claude')[0] });
  h.dispatch({ type: 'close', id: 't1' });
  const put = calls(h).filter((c) => c.fn === 'SetWindowPlacement');
  assert.equal(put.length, 1);
  assert.equal(put[0].hwnd, 0xb);
  assert.deepEqual(put[0].placement?.rcNormalPosition, { left: 600, top: 50, right: 1400, bottom: 650 });
  assert.equal(put[0].placement?.showCmd, 3, 'B was maximized and is maximized again');
  assert.equal(b.zoomed, true);
});

test('desktop B: normal, maximized and minimized windows are put back in their own state, without activating where possible', () => {
  for (const [over, showCmd, zoomed, iconic] of [[{}, 4, false, false], [{ zoomed: true }, 3, true, false], [{ iconic: true }, 7, false, true],
    [{ iconic: true, zoomed: true }, 7, true, true]] as [Record<string, boolean>, number, boolean, boolean][]) {
    const a = fakeWindow({ hwnd: 0xa, ...over });
    const h = harness([a]);
    h.add(0xa);
    assert.equal(a.iconic, false, 'docked: not minimized');
    assert.equal(a.zoomed, false, 'docked: not maximized');
    h.dispatch({ type: 'close', id: 't1' });
    const put = calls(h).filter((c) => c.fn === 'SetWindowPlacement');
    assert.equal(put[0].placement?.showCmd, showCmd, JSON.stringify(over));
    assert.deepEqual([a.zoomed, a.iconic], [zoomed, iconic], JSON.stringify(over));
    assert.deepEqual(a.normal, { left: 100, top: 100, right: 900, bottom: 700 });
  }
});

// --- C: every FFI write, intercepted ------------------------------------------------------------------------------

const SWP_ALLOWED = 0x1 | 0x2 | 0x4 | 0x10 | 0x200 | 0x4000;

/** A long mixed sequence over two apps, every write recorded with the action that caused it. */
function busySession() {
  const a = fakeWindow({ hwnd: 0xa, iconic: true });
  const b = fakeWindow({ hwnd: 0xb, pid: 4100, exePath: 'C:\\Apps\\Codex\\app\\ChatGPT.exe', title: 'ChatGPT', zoomed: true, border: 7 });
  const h = harness([a, b, fakeWindow({ hwnd: 0xc, pid: 4300, title: 'never picked' })], { focused: false });
  h.add(0xa);
  h.add(0xb);
  h.below = true;   // every restack finds the docked window under the shell
  const script = ['bounds', 'focus', 'restack', 'bounds', 'minimize', 'restack', 'bounds', 'restore', 'focus', 'restack', 'bounds', 'bounds'];
  for (const e of script) h.dispatch({ type: e });
  h.dispatch({ type: 'select', id: 't1' });
  for (const e of script) h.dispatch({ type: e });
  h.dispatch({ type: 'select', id: dock.ORRERY });
  h.dispatch({ type: 'bounds' });
  h.dispatch({ type: 'select', id: 't2' });
  h.dispatch({ type: 'close', id: 't1' });
  h.dispatch({ type: 'quit' });
  return h;
}

test('desktop C: every write has an allowed target, flags, command and triggering action', () => {
  const h = busySession();
  const cs = calls(h);
  assert.ok(cs.length >= 30, `recorded ${cs.length} writes`);
  for (const c of cs) {
    if (c.hwnd === OWN) {
      // The shell's own window, moved beneath the bound window that is docked now: z-order only, never activating.
      assert.equal(c.fn, 'SetWindowPos');
      assert.ok([0xa, 0xb].includes(c.after ?? -1), `beneath 0x${(c.after ?? 0).toString(16)}`);
      assert.equal(c.flags, 0x13, 'SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE');
      assert.ok(['add', 'choose', 'select', 'focus', 'restack'].includes(c.tag ?? ''), `lowering the shell on ${c.tag}`);
      continue;
    }
    assert.ok([0xa, 0xb].includes(c.hwnd), `target 0x${c.hwnd.toString(16)}`);
    if (c.fn === 'SetWindowPos') {
      assert.equal(c.after, 0, 'HWND_TOP only');
      assert.equal((c.flags ?? 0) & ~SWP_ALLOWED, 0, `flags 0x${(c.flags ?? 0).toString(16)}`);
      assert.ok((c.flags ?? 0) & 0x10, 'always SWP_NOACTIVATE');
      assert.ok((c.flags ?? 0) & 0x4, 'an app window is never moved in the z-order (SWP_NOZORDER)');
    } else if (c.fn === 'ShowWindow') {
      assert.ok([7, 9].includes(c.cmd ?? -1), `ShowWindow ${c.cmd}`);
      if (c.cmd === 9) assert.ok(['add', 'choose', 'select', 'restore'].includes(c.tag ?? ''), `SW_RESTORE on ${c.tag}`);
    } else if (c.fn === 'SetForegroundWindow') {
      assert.ok(['add', 'choose', 'select'].includes(c.tag ?? ''), `SetForegroundWindow on ${c.tag}`);
    } else if (c.fn === 'SetWindowPlacement') {
      assert.ok(['close', 'quit'].includes(c.tag ?? ''), `SetWindowPlacement on ${c.tag}`);
    } else assert.fail(`unexpected write ${c.fn}`);
  }
  // Following (move / resize / activate) is SetWindowPos only: never SW_RESTORE, never SetForegroundWindow.
  const follow = cs.filter((c) => c.tag === 'bounds' || c.tag === 'focus' || c.tag === 'restack');
  assert.ok(cs.filter((c) => c.tag === 'restack' && c.hwnd === OWN).length >= 2, 'restacks lowered the shell beneath the docked window');
  assert.ok(follow.length >= 6);
  assert.deepEqual([...new Set(fns(follow))], ['SetWindowPos']);
  // SetForegroundWindow once per click on a tab or pick, and never otherwise.
  assert.deepEqual(cs.filter((c) => c.fn === 'SetForegroundWindow').map((c) => [c.tag, c.hwnd]), [['add', 0xa], ['add', 0xb], ['select', 0xa], ['select', 0xb]]);
  assert.deepEqual(h.ffi.unknown, [], 'no function outside the FFI surface was even looked up');
});

test('desktop C: the docked rect includes the invisible borders; minimized or user-maximized windows are not moved by following', () => {
  const a = fakeWindow({ hwnd: 0xa, border: 7 });
  const h = harness([a]);
  h.add(0xa);
  const pos = calls(h).find((c) => c.fn === 'SetWindowPos') as Call & { x: number; y: number; cx: number; cy: number };
  assert.deepEqual([pos.x, pos.y, pos.cx, pos.cy], [RECT.x - 7, RECT.y, RECT.width + 14, RECT.height + 7]);
  assert.deepEqual(a.rect, { left: RECT.x, top: RECT.y, right: RECT.x + RECT.width, bottom: RECT.y + RECT.height }, 'visible frame = dock area');
  const n = calls(h).length;
  a.iconic = true;     // the user minimized the docked app
  h.dispatch({ type: 'bounds' });
  a.iconic = false; a.zoomed = true;   // or maximized it
  h.dispatch({ type: 'bounds' });
  h.dispatch({ type: 'focus' });
  assert.equal(calls(h).length, n);
});

test('desktop C: a refused foreground is not retried and nothing else is tried instead', () => {
  const a = fakeWindow({ hwnd: 0xa, foregroundOk: false });
  const h = harness([a]);
  h.add(0xa);
  assert.deepEqual(calls(h).map((c) => [c.fn, c.hwnd]), [['SetWindowPos', 0xa], ['SetForegroundWindow', 0xa], ['SetWindowPos', OWN]],
    'no second try; the shell still goes beneath the docked window, so it is in front anyway');
  assert.deepEqual(h.failures.map((f) => f.reason), ['SetForegroundWindow']);
  assert.deepEqual(h.ffi.unknown, []);
});

test('desktop C: the writer refuses calls the contract does not allow, whatever the caller asks', () => {
  const a = fakeWindow({ hwnd: 0xa, iconic: true });
  const ffi = createFakeFfi([a]);
  const w = writerMod.createWriter(ffi);
  const binding = { id: 1, hwnd: 0xa, pid: a.pid, exePath: a.exePath, className: a.className };
  const placement = ffi.getWindowPlacement(0xa);
  const refused = [
    { op: 'restore', trigger: 'bounds' }, { op: 'restore', trigger: 'focus' }, { op: 'foreground', trigger: 'bounds' },
    { op: 'foreground', trigger: 'restore' }, { op: 'putBack', trigger: 'select', placement }, { op: 'putBack', trigger: 'close', placement: { showCmd: 1 } },
    { op: 'place', trigger: 'select', rect: { x: 0, y: 0, width: NaN, height: 5 } }, { op: 'SetParent', trigger: 'select' }, { op: 'constructor', trigger: 'select' },
    { op: 'raise', trigger: 'focus' },            // gone: an app window is never raised by z-order
    { op: 'lowerShell', trigger: 'restack' },     // no own window known to this writer
  ];
  for (const r of refused) assert.equal(w.write({ binding, tab: 't1', ...r }).status, 'refused', JSON.stringify(r));
  assert.equal(w.write({ op: 'minimize', tab: 't1', binding: { ...binding, hwnd: '0xa' } }).status, 'refused', 'a handle must be a number');
  assert.deepEqual(ffi.calls, []);
});

/**
 * Loads a desktop/lib module with one piece of source replaced (relative imports pointed at the real files), so a
 * test can prove that the check it relies on is load-bearing.
 */
async function mutant(rel: string, from: string, to: string) {
  const src = readFileSync(join(DESKTOP, rel), 'utf8');
  assert.ok(src.includes(from), `${rel} contains ${from}`);
  const code = src.replace(from, to).replaceAll(/from '\.\/([a-z0-9]+\.mjs)'/g, (_m, f) => `from '${pathToFileURL(join(DESKTOP, 'lib', f)).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

test('desktop C: removing the identity check before writes makes the zero-write tests fail', async () => {
  // The scenario "a lost window gets no write", run against the real writer and against one without its check.
  const scenario = (mod: { createWriter: (f: unknown, o?: unknown) => { write: (o: unknown) => { status: string } } }) => {
    const a = fakeWindow({ hwnd: 0xa });
    const ffi = createFakeFfi([a]);
    const w = mod.createWriter(ffi, { ownWindow: () => OWN });
    const binding = { id: 1, hwnd: 0xa, pid: a.pid, exePath: a.exePath, className: a.className };
    a.pid = 9999;   // another process now
    for (const o of ['minimize', 'lowerShell', 'place', 'restore', 'foreground', 'putBack']) {
      w.write({ op: o, tab: 't1', binding, trigger: o === 'putBack' ? 'close' : 'select', rect: RECT, placement: ffi.getWindowPlacement(0xa) });
    }
    return ffi.calls.length;
  };
  assert.equal(scenario(writerMod), 0, 'the real writer writes nothing');
  const unchecked = await mutant('lib/writer.mjs', 'const check = (binding) => identityMismatch(binding, observe(ffi, binding.hwnd), apps);', 'const check = () => null;');
  assert.ok(scenario(unchecked) > 0, 'without the check the scenario writes, so the test above would fail');
  // And each identity rule is load-bearing: without it, the matching case of the identity test passes as "same".
  const base = fakeWindow({ hwnd: 1 });
  const id = { hwnd: 1, pid: base.pid, exePath: base.exePath, className: base.className };
  const rules: [string, Record<string, unknown>][] = [
    ["if (w.pid !== expected.pid) return 'pid';", { pid: 2 }],
    ["if (!samePath(w.exePath, expected.exePath)) return 'image';", { exePath: 'C:\\b\\Claude.exe' }],
    ["if (w.className !== expected.className) return 'class';", { className: 'x' }],
    ["if (w.root !== w.hwnd) return 'not-top-level';", { root: 5 }],
    ["if (w.owner) return 'owner';", { owner: 5 }],
    ["if (w.exStyle & WS_EX_TOPMOST) return 'topmost';", { exStyle: 8 }],
  ];
  for (const [line, over] of rules) {
    const m = await mutant('lib/windows.mjs', line, '');
    const ffi = createFakeFfi([fakeWindow({ hwnd: 1, ...over })]);
    assert.notEqual(windows.identityMismatch(id, windows.observe(ffi, 1)), null, `real: ${line}`);
    assert.equal(m.identityMismatch(id, m.observe(ffi, 1)), null, `mutant without ${line} accepts the changed window`);
  }
});

// --- allow-list and module boundaries -----------------------------------------------------------------------------

const ALLOWED_FFI = new Set(['EnumWindows', 'GetWindowThreadProcessId', 'OpenProcess', 'QueryFullProcessImageNameW', 'CloseHandle',
  'GetClassNameW', 'GetWindowTextW', 'IsWindow', 'IsWindowVisible', 'IsIconic', 'IsZoomed', 'GetWindowLongPtrW', 'GetAncestor', 'GetWindow',
  'GetWindowRect', 'GetWindowPlacement', 'DwmGetWindowAttribute', 'GetDpiForWindow', 'GetLastError',
  'SetWindowPos', 'ShowWindow', 'SetWindowPlacement', 'SetForegroundWindow']);
const FORBIDDEN = ['SetParent', 'SetWindowLongPtr', 'SetWindowLong', 'PostMessage', 'SendMessage', 'SendInput', 'keybd_event', 'mouse_event',
  'AttachThreadInput', 'CreateProcess', 'ShellExecute', 'WinExec', 'TerminateProcess', 'DestroyWindow', 'CloseWindow', 'SetWindowsHookEx',
  'SetWinEventHook', 'AllowSetForegroundWindow', 'LockSetForegroundWindow', 'SetProcessDpiAwareness', 'SetThreadDpiHostingBehavior'];

function desktopSources(): { path: string; code: string }[] {
  return readdirSync(DESKTOP, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(mjs|cjs|js|html)$/.test(f) && !f.split(/[\\/]/).includes('node_modules'))
    .map((f) => ({ path: f.replaceAll('\\', '/'), code: readFileSync(join(DESKTOP, f), 'utf8') }));
}

test('desktop C: win32.mjs declares only allow-listed Win32 functions, from user32, kernel32 and dwmapi only', () => {
  const src = readFileSync(join(DESKTOP, 'lib', 'win32.mjs'), 'utf8');
  const declared = [...src.matchAll(/\.func\(\s*'[^']*?(?:__stdcall\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
  assert.equal(declared.length, (src.match(/\.func\(/g) ?? []).length, 'every .func( is a prototype string the test can read');
  assert.ok(declared.length >= 20);
  for (const name of declared) assert.ok(ALLOWED_FFI.has(name), `${name} is not on the allow-list`);
  assert.deepEqual([...src.matchAll(/koffi\.load\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]), ['user32.dll', 'kernel32.dll', 'dwmapi.dll']);
  assert.equal((src.match(/koffi\.load\(/g) ?? []).length, 3);
  for (const bad of FORBIDDEN) assert.ok(!src.includes(bad), `${bad} appears in win32.mjs`);
  assert.doesNotMatch(src, /\.symbol\(|koffi\.call|indirect/, 'no other way to reach native code');
  // Parameters: limited process rights, and only the two DWM attributes.
  assert.deepEqual([...src.matchAll(/OpenProcess\(([A-Z_]+),/g)].map((m) => m[1]), ['PROCESS_QUERY_LIMITED_INFORMATION']);
  assert.match(src, /PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;/);
  assert.deepEqual([...src.matchAll(/DwmGetWindowAttribute\(hwnd, ([A-Z_]+),/g)].map((m) => m[1]).sort(), ['DWMWA_CLOAKED', 'DWMWA_EXTENDED_FRAME_BOUNDS']);
});

test('desktop C: only win32.mjs loads koffi, and only writer.mjs calls the Win32 write wrappers', () => {
  const sources = desktopSources();
  assert.ok(sources.some((s) => s.path === 'lib/writer.mjs'));
  for (const { path, code } of sources) {
    if (path !== 'lib/win32.mjs') assert.doesNotMatch(code, /['"]koffi(?:\/[^'"]*)?['"]|process\.dlopen/, `${path} loads koffi`);
    if (!['lib/win32.mjs', 'lib/writer.mjs', 'test/fake-ffi.mjs'].includes(path)) {
      assert.doesNotMatch(code, /\.(setWindowPos|showWindow|setWindowPlacement|setForegroundWindow)\b/, `${path} calls a write wrapper directly`);
    }
    for (const bad of FORBIDDEN) {
      // One test-only exception: the test window's own process lets the shell under test activate itself, as a user's
      // click would (Win32 check F, z-order). The shell and its modules never contain it.
      if (bad === 'AllowSetForegroundWindow' && path === 'test/test-window.mjs') continue;
      assert.ok(!code.includes(bad), `${bad} appears in ${path}`);
    }
    if (!path.startsWith('test/')) assert.doesNotMatch(code, /openExternal|showItemInFolder/, `${path} hands something to the system`);
    // The one exception, shell.mjs launchApp starting a supported app, is pinned down in the "desktop launch" tests.
    if (!path.startsWith('test/') && path !== 'shell.mjs') assert.doesNotMatch(code, /openPath/, `${path} hands something to the system`);
  }
  const writer = readFileSync(join(DESKTOP, 'lib', 'writer.mjs'), 'utf8');
  assert.doesNotMatch(writer, /SWP_FRAMECHANGED|SWP_HIDEWINDOW|SWP_SHOWWINDOW|HWND_TOPMOST|HWND_NOTOPMOST|SW_HIDE\b/);
  // Every write wrapper call in writer.mjs goes through the guarded helpers or follows a check in the same op.
  // Two SetWindowPos call sites: app windows through the flag-checked helper (HWND_TOP argument, SWP_NOZORDER in
  // practice), and the shell's own window beneath the checked bound window, with fixed flags.
  assert.equal((writer.match(/ffi\.setWindowPos\(/g) ?? []).length, 2);
  assert.match(writer, /return ffi\.setWindowPos\(hwnd, HWND_TOP, x, y, cx, cy, flags\);/);
  assert.match(writer, /return ffi\.setWindowPos\(own, ref\.hwnd, 0, 0, 0, 0, SWP_LOWER_SHELL\)/);
  assert.match(writer, /export const SWP_LOWER_SHELL = SWP_NOMOVE \| SWP_NOSIZE \| SWP_NOACTIVATE;/);
  assert.equal(writerMod.SWP_LOWER_SHELL, 0x13);
  assert.equal((writer.match(/ffi\.showWindow\(/g) ?? []).length, 1, 'one ShowWindow call site, behind the command check');
});

test('desktop: the pure modules import nothing but each other; desktop and src stay apart; the Hub gains no dependency', () => {
  const IMPORT = /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g;
  for (const f of ['apps.mjs', 'windows.mjs', 'geometry.mjs', 'dock.mjs', 'writer.mjs', 'navigation.mjs', 'startup.mjs', 'strip.mjs', 'launch.mjs', 'locate.mjs', 'peicon.mjs', 'app-paths.mjs']) {
    const specs = [...readFileSync(join(DESKTOP, 'lib', f), 'utf8').matchAll(IMPORT)].map((m) => m[1] ?? m[2]);
    for (const s of specs) assert.match(s, /^\.\/(apps|windows|geometry|dock|writer|navigation|locate)\.mjs$/, `lib/${f} imports ${s}`);
  }
  // Window bindings and the packaged runtime's file/HTTP I/O are the two non-pure modules.
  const runtimeImports = [...readFileSync(join(DESKTOP, 'lib', 'runtime.mjs'), 'utf8').matchAll(IMPORT)].map((m) => m[1] ?? m[2]);
  assert.ok(runtimeImports.every((s) => s.startsWith('node:')), 'packaged runtime uses Node I/O, not app or Win32 capabilities');
  assert.deepEqual(readdirSync(join(DESKTOP, 'lib')).filter((f) => f.endsWith('.mjs') && !['win32.mjs', 'runtime.mjs'].includes(f)).sort(),
    ['app-paths.mjs', 'apps.mjs', 'dock.mjs', 'geometry.mjs', 'launch.mjs', 'locate.mjs', 'navigation.mjs', 'peicon.mjs', 'startup.mjs', 'strip.mjs', 'windows.mjs', 'writer.mjs']);
  for (const { path, code } of desktopSources()) {
    const specs = [...code.matchAll(IMPORT)].map((m) => m[1] ?? m[2]);
    for (const s of specs) assert.ok(!/\/src\//.test(s) && !s.startsWith('../src'), `${path} imports ${s} (the shell runs src/launcher.ts as a program instead)`);
  }
  for (const f of readdirSync(join(REPO_ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter((x) => x.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(join(REPO_ROOT, 'src', f), 'utf8'), /desktop\//, `src/${f} refers to desktop/`);
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@modelcontextprotocol/sdk', 'zod']);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'knip', 'typescript']);
  const desk = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
  assert.deepEqual(desk.dependencies, { koffi: '3.3.3' }, 'runtime dependency stays pinned');
  assert.deepEqual(desk.devDependencies, { electron: '44.8.0', 'electron-builder': '26.18.0' }, 'build dependencies stay pinned');
  const lock = JSON.parse(readFileSync(join(DESKTOP, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/electron'].version, '44.8.0');
  assert.equal(lock.packages['node_modules/koffi'].version, '3.3.3');
});

// --- D / E, the parts that are plain functions -------------------------------------------------------------------

test('desktop: renderer accessibility is off unless ORRERY_DESKTOP_ACCESSIBILITY is 1, true or on', () => {
  const off = ['disable-renderer-accessibility'];
  assert.deepEqual(startup.chromiumSwitches({}), off, 'unset');
  for (const v of ['', '0', 'false', 'off', 'yes', '2', 'enabled']) assert.deepEqual(startup.chromiumSwitches({ ORRERY_DESKTOP_ACCESSIBILITY: v }), off, v);
  for (const v of ['1', 'true', 'TRUE', 'True', 'on', 'ON', 'On']) assert.deepEqual(startup.chromiumSwitches({ ORRERY_DESKTOP_ACCESSIBILITY: v }), [], v);
});

test('desktop D: the --ensure answer must be loopback HTTP with a port and nothing else but the token fragment', () => {
  const line = (url: unknown) => `${JSON.stringify({ url })}\n`;
  const o = 'http://127.0.0.1:4395';
  assert.deepEqual(nav.parseEnsure(line(o), 0), { origin: o, page: `${o}/` });
  assert.deepEqual(nav.parseEnsure(line('http://localhost:4395'), 0), { origin: 'http://localhost:4395', page: 'http://localhost:4395/' });
  assert.deepEqual(nav.parseEnsure(`noise\n${line(o)}`, 0), { origin: o, page: `${o}/` }, 'the last line counts');
  // The launcher's page address keeps its API token fragment (the page trades it for a cookie).
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789-_AB';
  assert.deepEqual(nav.parseEnsure(line(`${o}/#token=${token}`), 0), { origin: o, page: `${o}/#token=${token}` });
  for (const bad of ['https://127.0.0.1:4395', 'http://127.0.0.1', 'http://10.0.0.1:4395', 'http://127.0.0.1.evil.com:4395', 'http://user:pw@127.0.0.1:4395',
    'http://127.0.0.1:4395/x', 'http://127.0.0.1:4395/?k=v', 'http://127.0.0.1:4395/#t', 'http://127.0.0.1:4395/#token=a&b', 'http://127.0.0.1:4395/#token=',
    `http://127.0.0.1:4395/x#token=${token}`, 'file:///C:/x', 'claude://code/new', 'not a url', 42]) {
    assert.ok('error' in nav.parseEnsure(line(bad), 0), String(bad));
  }
  assert.deepEqual(nav.parseEnsure(`${JSON.stringify({ error: '端口 4395 被别的程序占用' })}\n`, 1), { error: '端口 4395 被别的程序占用' });
  assert.match(nav.parseEnsure('', 1).error, /没有给出 Hub 的地址（退出码 1）/);
});

test('desktop D: the collaboration page may only go to the exact Hub origin; app schemes and files go nowhere', () => {
  const hub = 'http://127.0.0.1:4395';
  assert.equal(nav.allowNavigation(hub, `${hub}/`, true), true);
  assert.equal(nav.allowNavigation(hub, `${hub}/clusters/x?y=1#z`, true), true);
  for (const url of ['http://127.0.0.1:4396/', 'https://127.0.0.1:4395/', 'http://localhost:4395/', 'http://127.0.0.1:4395.evil.com/', `${hub}@evil.com/`,
    'claude://code/new', 'codex://threads/wake/x', 'dsh://open', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi',
    'about:blank', 'blob:http://127.0.0.1:4395/x', 'not a url']) {
    assert.equal(nav.allowNavigation(hub, url, true), false, url);
  }
  assert.equal(nav.allowNavigation(hub, 'about:blank', false), true, 'an empty subframe stays in the page');
  assert.equal(nav.allowNavigation(hub, 'claude://x', false), false);
  assert.equal(nav.allowNavigation(null, `${hub}/`, true), false, 'nothing before the Hub is known');
});

test('desktop E: only POST /api/shutdown answered 202 by the Hub counts as "退出 orrery"', () => {
  const hub = 'http://127.0.0.1:4395';
  const ok = { method: 'POST', url: `${hub}/api/shutdown`, statusCode: 202 };
  assert.equal(nav.isHubShutdown(hub, ok), true);
  for (const d of [{ ...ok, statusCode: 403 }, { ...ok, statusCode: 500 }, { ...ok, statusCode: 0 }, { ...ok, method: 'GET' },
    { ...ok, url: `${hub}/api/shutdownx` }, { ...ok, url: 'http://127.0.0.1:4396/api/shutdown' }, { ...ok, url: 'nonsense' }]) {
    assert.equal(nav.isHubShutdown(hub, d), false, JSON.stringify(d));
  }
  assert.equal(nav.isHubShutdown(null, ok), false);
});

/**
 * createDesktopShortcut prints its result with console.log. In a test file stdout is node:test's report channel, and the
 * Node 24 test runner misreads text that reaches it in the same read as a report message when the text's third byte
 * is 0x80 or more, as in most Chinese text: "Unable to deserialize cloned data", the whole file fails. Keep it off stdout.
 */
function captureLog(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.join(' ')); });
  return lines;
}

test('desktop: npm run shortcut writes "orrery 桌面版.lnk" with every path in environment variables (fake runner)', async (t) => {
  const printed = captureLog(t);
  const calls: { script: string; vars: Record<string, string> }[] = [];
  const run = async (script: string, vars: Record<string, string>) => { calls.push({ script, vars }); return { code: 0, stdout: 'created|C:\\Users\\someone\\Desktop\\orrery 桌面版.lnk\r\n' }; };
  const electron = 'C:\\repo\\desktop\\node_modules\\electron\\dist\\electron.exe';
  assert.equal(await shortcut.createDesktopShortcut({ electron, node: 'C:\\Program Files\\nodejs\\node.exe', desktopDir: 'C:\\repo\\desktop', run, platform: 'win32' }), 0);
  assert.match(printed[0], /^已在桌面创建快捷方式：C:\\Users\\someone\\Desktop\\orrery 桌面版\.lnk$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, shortcut.SHORTCUT_SCRIPT);
  assert.deepEqual(calls[0].vars, {
    ORRERY_SHORTCUT_NAME: 'orrery 桌面版.lnk',
    ORRERY_SHORTCUT_TARGET: electron,
    ORRERY_SHORTCUT_ARGUMENTS: '"C:\\repo\\desktop" "--orrery-node=C:\\Program Files\\nodejs\\node.exe"',
    ORRERY_SHORTCUT_DIR: 'C:\\repo\\desktop',
    ORRERY_SHORTCUT_DESCRIPTION: 'orrery desktop',
    ORRERY_SHORTCUT_ICON: join('C:\\repo\\desktop', 'assets', 'orrery-icon.ico'),
  });
  for (const v of Object.values(calls[0].vars)) assert.ok(!calls[0].script.includes(v.replaceAll('"', '')), 'no value inside the script');
  assert.match(calls[0].script, /GetFolderPath\('Desktop'\)/);
  assert.doesNotMatch(calls[0].script, /ExecutionPolicy|RunAs|HKCU|HKLM|Startup|orrery\.lnk/i, 'only its own shortcut, nothing else');
  assert.equal(await shortcut.createDesktopShortcut({ electron, run, platform: 'linux' }), 1);
  assert.equal(calls.length, 1, 'Windows only');
  assert.equal(printed.at(-1), 'orrery 桌面版只支持 Windows。');
  const src = readFileSync(join(DESKTOP, 'shortcut.mjs'), 'utf8');
  assert.deepEqual([...src.matchAll(/spawn\('powershell\.exe', (\[[^\]]*\])/g)].map((m) => m[1]), ["['-NoProfile', '-NonInteractive', '-Command', script]"]);
});

test('desktop: the shortcut script writes a working .lnk (Windows; a temp folder stands in for the Desktop)', { skip: process.platform !== 'win32' }, async (t) => {
  const printed = captureLog(t);
  const dir = join(tempDir(), 'fake desktop');
  mkdirSync(dir);
  const desktop = "[Environment]::GetFolderPath('Desktop')";
  assert.ok(shortcut.SHORTCUT_SCRIPT.includes(desktop));
  const run = (script: string, vars: Record<string, string>) => shortcut.runPowerShell(script.replace(desktop, '$env:ORRERY_TEST_DESKTOP'), { ...vars, ORRERY_TEST_DESKTOP: dir });
  const electron = join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
  assert.equal(await shortcut.createDesktopShortcut({ electron, node: process.execPath, run, platform: 'win32' }), 0);
  assert.equal(await shortcut.createDesktopShortcut({ electron, node: process.execPath, run, platform: 'win32' }), 0, 'replaced');
  assert.deepEqual(readdirSync(dir), ['orrery 桌面版.lnk'], 'one shortcut, under its Chinese name');
  assert.match(printed.find((l) => l.startsWith('已覆盖'))!, /orrery 桌面版\.lnk$/, 'replaced');
  // Read it back through an ASCII-named copy (the same ANSI limit applies to reading).
  const read = await shortcut.runPowerShell([
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$copy = Join-Path $env:ORRERY_TEST_DESKTOP 'readback.lnk'",
    'Copy-Item -LiteralPath (Join-Path $env:ORRERY_TEST_DESKTOP $env:ORRERY_SHORTCUT_NAME) -Destination $copy',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($copy)',
    '$s.TargetPath; $s.Arguments; $s.WorkingDirectory; $s.Description; $s.IconLocation',
  ].join('; '), { ORRERY_TEST_DESKTOP: dir, ORRERY_SHORTCUT_NAME: shortcut.SHORTCUT_NAME });
  assert.deepEqual(read.stdout.trim().split(/\r?\n/), [electron, `"${DESKTOP}" "--orrery-node=${process.execPath}"`, DESKTOP, 'orrery desktop', `${join(DESKTOP, 'assets', 'orrery-icon.ico')},0`]);
});

// --- review desktop-tabs r1 ---------------------------------------------------------------------------------------

test('desktop B: closing a tab whose window is no longer the bound one writes nothing and says so, once', () => {
  for (const [reason, change] of [['pid', { pid: 4999 }], ['topmost', { exStyle: 0x8 }], ['gone', { destroyed: true }]] as [string, Record<string, unknown>][]) {
    const a = fakeWindow({ hwnd: 0xa });
    const h = harness([a]);
    h.add(0xa);
    const n = calls(h).length;
    const before = h.notices.length;
    Object.assign(a, change);
    h.dispatch({ type: 'close', id: 't1' });
    assert.equal(calls(h).length, n, `${reason}: no write`);
    assert.deepEqual(h.state.tabs, [], `${reason}: the tab is gone`);
    const said = h.notices.slice(before);
    assert.equal(said.length, 1, `${reason}: exactly one notice`);
    assert.ok(said[0].startsWith(`Claude 的窗口已经关了或不是原来那个了（${reason}），关标签时没有把它还原`), said[0]);
  }
  // Quitting the shell lists such windows itself (a dialog in shell.mjs): the reducer adds no second notice.
  const q = harness([fakeWindow({ hwnd: 0xa })]);
  q.add(0xa);
  q.ffi.windows.get(0xa).pid = 4999;
  const before = q.notices.length;
  q.dispatch({ type: 'quit' });
  assert.equal(q.notices.length, before);
  assert.deepEqual(calls(q).filter((c) => c.fn === 'SetWindowPlacement'), []);
});

test('desktop E: a second shell only brings the first back: the current tab\'s bound window is restored and re-docked, nothing new is bound', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const b = fakeWindow({ hwnd: 0xb, pid: 4100 });
  const h = harness([a, b, fakeWindow({ hwnd: 0xc, pid: 4300, title: 'never picked' })]);
  h.add(0xa);
  h.add(0xb);
  const bindings = JSON.stringify(h.state.tabs.map((t: { binding: { id: number } }) => t.binding.id));
  // shell.focus() (main.mjs calls it on 'second-instance') restores a minimized shell window and focuses it, which
  // reaches the reducer as 'restore' and 'focus': the bound window of the current tab comes back with it.
  h.dispatch({ type: 'minimize' });
  let n = calls(h).length;
  h.below = true;   // the restored shell comes up over the docked window
  h.dispatch({ type: 'restore' });
  h.dispatch({ type: 'focus' });
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd, c.cmd ?? c.flags, c.after ?? '']), [
    ['ShowWindow', 0xb, 9, ''],          // SW_RESTORE: the shell window was restored, a user-level action
    ['SetWindowPos', 0xb, 0x214, 0],     // back over the content area: SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER
    ['SetWindowPos', OWN, 0x13, 0xb],    // the activated shell goes beneath it: SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
  ]);
  // Not minimized: only the shell is lowered.
  n = calls(h).length;
  h.dispatch({ type: 'focus' });
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd, c.after]), [['SetWindowPos', OWN, 0xb]]);
  assert.equal(calls(h).filter((c) => c.fn === 'SetForegroundWindow' && c.tag !== 'add').length, 0, 'no foreground switch');
  assert.equal(JSON.stringify(h.state.tabs.map((t: { binding: { id: number } }) => t.binding.id)), bindings, 'no new binding');
  // A restarted shell has no binding: being brought back writes nothing at all.
  const r = harness([fakeWindow({ hwnd: 0xa })]);
  r.state = dock.initialState([{ app: 'claude', exe: 'Claude.exe', title: 'Claude' }]);
  for (const e of ['minimize', 'restore', 'focus']) r.dispatch({ type: e });
  assert.deepEqual(calls(r), []);
});

// --- z-order: the docked window stays in front of the shell ------------------------------------------------------

test('desktop B: when the shell comes up over the docked window, the shell goes beneath it again, and only then', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const h = harness([a]);
  h.add(0xa);
  let n = calls(h).length;
  h.dispatch({ type: 'restack' });
  assert.equal(calls(h).length, n, 'still in front: no write');
  h.below = true;   // a click on the already active shell brought it to the top
  h.dispatch({ type: 'restack' });
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd, c.after, c.flags, c.tag]), [['SetWindowPos', OWN, 0xa, 0x13, 'restack']],
    'the shell\'s own window, inserted after the docked window: SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE; the app window gets no write');
  // Nothing on the orrery tab, while the shell is minimized, for a window the user minimized or maximized, or after quitting.
  const quiet = (setup: (x: ReturnType<typeof harness>, w: Record<string, unknown>) => void, what: string) => {
    const w = fakeWindow({ hwnd: 0xa });
    const x = harness([w]);
    x.add(0xa);
    setup(x, w);
    x.below = true;
    const m = calls(x).length;
    x.dispatch({ type: 'restack' });
    assert.equal(calls(x).length, m, what);
  };
  quiet((x) => x.dispatch({ type: 'select', id: dock.ORRERY }), 'orrery tab');
  quiet((x) => x.dispatch({ type: 'minimize' }), 'shell minimized');
  quiet((_x, w) => { w.iconic = true; }, 'minimized by the user');
  quiet((_x, w) => { w.zoomed = true; }, 'maximized by the user');
  quiet((x) => x.dispatch({ type: 'quit' }), 'after quitting');
  quiet((x) => x.dispatch({ type: 'close', id: 't1' }), 'after closing the tab');
  // And never a window that is not the bound one.
  n = calls(h).length;
  a.pid = 9999;
  h.dispatch({ type: 'restack' });
  assert.equal(calls(h).length, n, 'identity checked as for every write');
  assert.equal(h.state.tabs[0].binding, null);
});

// --- one top row: the orrery mark, the tabs and the system caption buttons -----------------------------------------

test('desktop: the tab row is the title row: system caption buttons, drag on empty space, clickable parts no-drag', () => {
  const shell = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(shell, /titleBarStyle: 'hidden', titleBarOverlay: TITLE_BAR_OVERLAY/);
  assert.match(shell, /const TITLE_BAR_OVERLAY = \{ color: '#141518', symbolColor: '#e6e4e0', height: BAR \};/);
  assert.match(shell, /export const BAR = TAB_BAR_HEIGHT;/);
  const css = readFileSync(join(DESKTOP, 'ui', 'tabs.css'), 'utf8');
  const rule = (selector: string) => {
    const m = new RegExp(`(?:^|\\n)${selector.replace(/[.#[\]"=]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    assert.ok(m, `rule ${selector}`);
    return m[1];
  };
  assert.match(rule('#bar'), /-webkit-app-region: drag;/);
  // Every place that assumes the row's height follows TAB_BAR_HEIGHT: the row, the strip behind the caption buttons,
  // the dock area below it (the overlay's height is BAR, above).
  const bar = `${geometry.TAB_BAR_HEIGHT}px`;
  assert.match(rule('#bar'), new RegExp(`height: ${bar};`), 'TAB_BAR_HEIGHT');
  assert.match(rule('html::before'), new RegExp(`height: ${bar};`), 'TAB_BAR_HEIGHT');
  assert.match(rule('#bar'), /width: env\(titlebar-area-width, 100%\);/, 'ends where the caption buttons begin');
  assert.match(rule('#panel'), new RegExp(`inset: ${bar} 0 0 0;`));
  for (const s of ['.tab', '#add, #layout, #settings']) assert.match(rule(s), /-webkit-app-region: no-drag;/, s);
  // Bigger targets: tab icons 24 px in a 36 px high tab; +, the layout button and the gear 34 px.
  assert.match(rule('.glyph'), /width: 24px; height: 24px;/);
  assert.match(rule('.tab'), /height: 36px;/);
  assert.match(rule('#add, #layout, #settings'), /width: 34px;\n  height: 34px;/);
  assert.match(css, /--bar: #141518;/, 'the caption buttons use the tab row colour');
  const html = readFileSync(join(DESKTOP, 'ui', 'tabs.html'), 'utf8');
  assert.match(html, /<header id="bar">[\s\S]*id="tabs"[\s\S]*id="add"[\s\S]*id="layout"[\s\S]*id="settings"[\s\S]*<\/header>/, 'tabs, +, the layout button and the gear in one row');
  assert.doesNotMatch(html, /id="strip"/, 'the apps are no longer in the row: they open in the + panel');
  assert.doesNotMatch(html, /<img|<iframe|https?:/, 'no remote content');
  // Icons arrive as data URLs from the main process; nothing else is loosened in the tab bar's CSP.
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
});

// --- the "+" strip: one icon per supported app -------------------------------------------------------------------

const strip = await load('lib/strip.mjs');

test('desktop: the + strip has one entry per supported app: windows to add, docked, being started, startable or not found', () => {
  const c = (app: string, hwnd: number) => ({ app, hwnd });
  const tabs = [{ app: 'deepseek', binding: { hwnd: 0xd } }, { app: 'kimi-code', binding: null }];
  const targets = { 'kimi-code': { ok: true }, zcode: { ok: true }, antigravity: { ok: false, reason: '没有找到' }, deepseek: { ok: true }, claude: { ok: true } };
  const entries = strip.stripEntries([c('claude', 1), c('codex', 2), c('codex', 3)], tabs, { targets, starting: new Set(['zcode']) });
  assert.deepEqual(entries.map((e: { id: string }) => e.id), apps.APPS.map((a: { id: string }) => a.id), 'every app, in the table order');
  const by = Object.fromEntries(entries.map((e: { id: string; status: string; windows: number }) => [e.id, `${e.status}/${e.windows}`]));
  assert.deepEqual(by, { claude: 'add/1', codex: 'add/2', deepseek: 'docked/0', 'kimi-code': 'launch/0', zcode: 'starting/0', antigravity: 'missing/0', qoder: 'missing/0', workbuddy: 'missing/0', cursor: 'missing/0' },
    'an unbound tab (kimi-code) does not count as running; running apps are never "launch"');
  assert.equal(entries[0].name, 'Claude');
  assert.equal(entries.find((e: { id: string }) => e.id === 'antigravity').reason, '没有找到', 'the reason goes to the tooltip');
});

test('desktop: a strip click adds the one candidate directly, offers several by title, starts the app only with none', () => {
  const none = new Set<string>();
  assert.deepEqual(strip.pickFor([{ hwnd: 1 }], [], 'claude', none), { add: { hwnd: 1 } });
  assert.deepEqual(strip.pickFor([{ hwnd: 1 }, { hwnd: 2 }], [], 'claude', none), { choose: [{ hwnd: 1 }, { hwnd: 2 }] });
  assert.deepEqual(strip.pickFor([], [], 'claude', none), { launch: true });
  assert.equal(strip.pickFor([], [{ app: 'claude', binding: { hwnd: 1 } }], 'claude', none), null, 'a window of it is in a tab: it runs, no start');
  assert.deepEqual(strip.pickFor([], [{ app: 'claude', binding: null }], 'claude', none), { launch: true }, 'an unbound tab is no running window');
  assert.equal(strip.pickFor([], [], 'claude', new Set(['claude'])), null, 'being started already: no second start');
  // Through the reducer: the one candidate goes into a new tab like a pick from a list (identity captured, docked).
  const h = harness([fakeWindow({ hwnd: 0xa })]);
  const pick = strip.pickFor(h.candidates(), h.state.tabs, 'claude', none);
  h.dispatch({ type: 'add', candidate: pick.add });
  assert.equal(h.state.tabs[0].binding.hwnd, 0xa);
  assert.ok(fns(calls(h)).includes('SetWindowPos'));
  // Re-choosing an unbound tab is unchanged: the user picks from that app's list even when there is one window.
  const shell = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(shell, /'tabs:select': \(id\) => \{[\s\S]*?if \(tab && !tab\.binding\) \{ if \(hub\.status !== 'starting'\) chooseMenu\(id\); return; \}/);
  assert.doesNotMatch(shell.slice(shell.indexOf('function chooseMenu'), shell.indexOf('const fromTabBar')), /pickFor|launchApp|userAction\(\{ type: 'add'/);
});

test('desktop: the strip sends only a supported app id; the main process checks it against its app list', () => {
  for (const id of apps.APPS.map((a: { id: string }) => a.id)) assert.equal(strip.isAppId(id), true, id);
  for (const bad of ['', 'calc', 'Claude', 'claude ', 'C:\\Windows\\System32\\calc.exe', 'shell:AppsFolder\\x', 1, null, undefined, {}, ['claude'], { id: 'claude' }]) {
    assert.equal(strip.isAppId(bad), false, JSON.stringify(bad));
  }
  assert.equal(strip.isAppId('test', [{ id: 'test', name: 't', exe: 't.exe' }]), true, 'against the list the shell was given');
  assert.equal(strip.isAppId('claude', [{ id: 'test', name: 't', exe: 't.exe' }]), false);
  const shell = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(shell, /'strip:pick': \(\.\.\.args\) => args\.length === 1 && isAppId\(args\[0\], apps\),/);
  assert.match(shell, /'strip:close': \(\.\.\.args\) => args\.length === 0,/);
  assert.match(shell, /'tabs:add': \(\.\.\.args\) => args\.length === 1 && Number\.isFinite\(args\[0\]\),/, 'one finite number, nothing else (an object is refused)');
  assert.match(shell, /'tabs:press': \(\.\.\.args\) => args\.length === 0,/);
  ipcSenders(shell);
  // The panel's preload sends a string id or a close, nothing else; the tab bar's preload has no pick or close any more.
  const panelPreload = readFileSync(join(DESKTOP, 'strip-preload.cjs'), 'utf8');
  assert.match(panelPreload, /pick: \(app\) => ipcRenderer\.send\('strip:pick', typeof app === 'string' \? app : ''\),/);
  assert.deepEqual([...panelPreload.matchAll(/ipcRenderer\.(send|on|invoke|sendSync)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`),
    ['on strip:state', 'send strip:pick', 'send strip:close'], 'the panel hears its state, sends a pick or a close');
  assert.deepEqual([...panelPreload.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ['onState', 'pick', 'close'], 'all it exposes');
  const preload = readFileSync(join(DESKTOP, 'preload.cjs'), 'utf8');
  assert.doesNotMatch(preload, /strip:/, 'the tab bar sends no pick and no close');
  assert.match(preload, /add: \(x\) => ipcRenderer\.send\('tabs:add', Number\(x\)\),/);
  assert.match(preload, /pressed: \(\) => ipcRenderer\.send\('tabs:press'\),/);
});

test('desktop: the + panel opens just under +, inside the shell, its icons in balanced rows of 44 px cells', () => {
  const { PANEL, panelBounds } = strip;
  assert.deepEqual(PANEL, { cell: 44, gap: 4, edge: 7, margin: 4 });
  const content = { x: 100, y: 50, width: 1280, height: 800 };
  // 8 apps on a wide shell: one row, 8 × 44 + 7 × 4 + 2 × 7 = 394 wide, 58 high, its left edge under +, just below the row.
  assert.deepEqual(panelBounds(8, content, 160, 44), { x: 260, y: 96, width: 394, height: 58 });
  // Under a + near the right edge: moved left to stay inside the content area (4 DIP margin); never left of it.
  assert.deepEqual(panelBounds(8, content, 1200, 44).x, 100 + 1280 - 394 - 4);
  assert.deepEqual(panelBounds(8, content, -50, 44).x, 104);
  // Narrow: only 5 cells fit in 280 DIP, so two balanced rows of 4 (not 5 + 3); one column at the very least.
  const narrow = panelBounds(8, { x: 0, y: 0, width: 280, height: 400 }, 30, 44);
  assert.deepEqual([narrow.width, narrow.height], [2 * 7 + 4 * 44 + 3 * 4, 2 * 7 + 2 * 44 + 4]);
  assert.deepEqual([panelBounds(8, { x: 0, y: 0, width: 40, height: 400 }, 0, 44).width], [58]);
  assert.deepEqual(panelBounds(9, content, 0, 44).width, 2 * 7 + 9 * 44 + 8 * 4, 'more apps, a longer row while it fits');
  // The panel's CSS draws the same grid.
  const css = readFileSync(join(DESKTOP, 'ui', 'strip.css'), 'utf8');
  assert.match(css, /#apps \{ display: grid; grid-template-columns: repeat\(var\(--cols, 1\), 44px\); gap: 4px;/);
  assert.match(readFileSync(join(DESKTOP, 'ui', 'strip.mjs'), 'utf8'), /Math\.round\(\(innerWidth - 2 \* 7 \+ 4\) \/ 48\)/, 'columns from the window width, cell + gap');
  assert.match(css, /html \{ border: 1px solid var\(--line\);/);
  assert.match(css, /body \{\n  padding: 6px;/);
  assert.match(css, /\.app \{[^}]*width: 44px;\n  height: 44px;/, 'a 44 × 44 hit area');
  assert.match(css, /\.glyph \{ position: relative; display: block; width: 32px; height: 32px; \}/, '32 px icons');
  assert.match(css, /\.app:hover:not\(\[aria-disabled="true"\]\) \{ background: var\(--hover\); \}/);
  assert.match(css, /\.app:focus-visible \{ outline: 2px solid var\(--accent\);/);
});

test('desktop: the + panel opens and closes by event and focus state only, never by clocks', () => {
  const { panelStep } = strip;
  // A click on + toggles it: open → closed, closed → open, whenever and however late the click arrives.
  assert.equal(panelStep(true, 'plus'), 'close');
  assert.equal(panelStep(false, 'plus'), 'open');
  assert.equal(panelStep(false, 'plus', { shellFocused: true }), 'open', 'keyboard on +, or a click after the panel closed for any reason');
  // A press elsewhere in the shell (the tab bar, the collaboration page) closes it.
  assert.equal(panelStep(true, 'press', { shellFocused: true }), 'close');
  assert.equal(panelStep(false, 'press'), null);
  // A focus change closes it only when neither the shell nor the panel has the focus.
  assert.equal(panelStep(true, 'focus', { shellFocused: true }), null, 'a press on + or on the title row: the shell has it, the panel stays');
  assert.equal(panelStep(true, 'focus', { panelFocused: true }), null, 'the panel opening (the shell loses the focus to it)');
  assert.equal(panelStep(true, 'focus', {}), 'close', 'another app, a docked window, nothing');
  assert.equal(panelStep(false, 'focus', {}), null);
  assert.equal(panelStep.length, 2, 'panelStep(open, event, focus): no time goes in');
  const src = readFileSync(join(DESKTOP, 'lib', 'strip.mjs'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export function panelStep')), /Date|performance|setTimeout/, 'no clock in the decision');
  // In the shell: every event goes through panelStep with the two windows' focus; nothing reads a clock for it.
  const shell = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.doesNotMatch(shell, /REOPEN_AFTER_BLUR_MS|closedByThisPress|PRESS_SLACK_MS|stripBlurredAt|pressMs/);
  const ev = fnBody(shell, 'panelEvent');
  assert.match(ev, /const focus = \{ shellFocused: !win\.isDestroyed\(\) && win\.isFocused\(\), panelFocused: !panel\.isDestroyed\(\) && panel\.isFocused\(\) \};\n {4}const act = panelStep\(!!strip, event, focus\);/);
  assert.doesNotMatch(ev, /Date|performance/);
  assert.match(shell, /'tabs:add': \(x\) => \{ if \(hub\.status !== 'starting'\) panelEvent\('plus', x\); \},/);
  assert.match(shell, /'tabs:press': \(\) => \{ panelEvent\('press'\); settingsEvent\('press'\); \},/);
  assert.match(shell, /if \(input\.type === 'mouseDown'\) \{ panelEvent\('press'\); settingsEvent\('press'\); \}/, 'a press in the collaboration page');
  assert.match(shell, /const focusChanged = \(\) => setTimeout\(\(\) => panelEvent\('focus'\), 0\);\n {2}panel\.on\('blur', focusChanged\);\n {2}win\.on\('blur', focusChanged\);/);
  assert.match(shell, /for \(const e of \['move', 'resize', 'minimize', 'hide'\]\) win\.on\(e, \(\) => closeStrip\(\)\);/);
  // The tab bar reports a press anywhere but on +, and sends + with its left edge only.
  const tabs = readFileSync(join(DESKTOP, 'ui', 'tabs.mjs'), 'utf8');
  assert.match(tabs, /document\.addEventListener\('pointerdown', \(e\) => \{ if \(!e\.target\.closest\?\.\('#add, #settings'\)\) api\.pressed\(\); \}, true\);/);
  assert.match(tabs, /\$\('add'\)\.addEventListener\('click', \(\) => api\.add\(\$\('add'\)\.getBoundingClientRect\(\)\.left\)\);/);
});

test('desktop: the + panel survives its own close (Alt+F4): it only closes the strip; a destroyed panel is never used', () => {
  const shell = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(shell, /panel\.on\('close', \(e\) => \{ if \(closing\) return; e\.preventDefault\(\); closeStrip\(\); \}\);/);
  // Only the shell destroys it; every use checks first.
  assert.deepEqual([...shell.matchAll(/panel\.destroy\(\)/g)].length, 2, 'quit and the shell window\'s closed event');
  assert.match(fnBody(shell, 'panelEvent'), /if \(act !== 'open' \|\| panel\.isDestroyed\(\)\) return;/);
  assert.match(fnBody(shell, 'closeStrip'), /if \(!panel\.isDestroyed\(\)\) \{/);
  assert.match(shell, /if \(strip && !strips\.isDestroyed\(\)\) \{\n {6}strips\.send\('strip:state'/);
});

test('desktop: the + panel is the shell\'s own trusted page: fixed, sandboxed, no node, strict CSP, never navigates or reloads', () => {
  const shell = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(shell, /export const STRIP_PAGE = pathToFileURL\(join\(HERE, 'ui', 'strip\.html'\)\)\.href;/);
  assert.match(shell, /const STRIP_PRELOAD = join\(HERE, 'strip-preload\.cjs'\);/);
  assert.equal((shell.match(/new BrowserWindow\(/g) ?? []).length, 3, 'the shell window, the panel and the settings view, nothing else');
  const panel = /const panel = new BrowserWindow\(\{([\s\S]*?)\n {2}\}\);/.exec(shell)?.[1] ?? '';
  assert.match(panel, /^\n {4}show: false, frame: false, alwaysOnTop: true, skipTaskbar: true,/, 'on top of the docked windows, no taskbar entry');
  // Not owned by the shell window: an owned topmost window keeps lowerShell from taking effect (test F found it).
  assert.doesNotMatch(panel, /parent|modal/);
  assert.match(shell, /win\.on\('closed', \(\) => \{ if \(!panel\.isDestroyed\(\)\) panel\.destroy\(\); \}\);/, 'and it never outlives the shell');
  assert.match(panel, /webPreferences: \{ preload: STRIP_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false \}/);
  assert.match(shell, /panel\.loadURL\(STRIP_PAGE\);/);
  assert.equal((shell.match(/panel\.loadURL\(/g) ?? []).length, 1, 'loaded once, the fixed page');
  assert.match(shell, /panel\.removeMenu\(\);/);
  // The same guards as the tab bar: no navigation, no webview, no new window; F5 / Ctrl+R never reload it.
  assert.match(shell, /for \(const page of \[tabs, strips, settingsPage\]\) \{\n {4}page\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\);\n {4}page\.on\('will-frame-navigate', \(e\) => e\.preventDefault\(\)\);\n {4}page\.on\('will-attach-webview', \(e\) => e\.preventDefault\(\)\);\n {4}page\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\);\n {2}\}/);
  assert.match(shell, /strips\.on\('before-input-event', \(e, input\) => \{ if \(reloadKey\(input\)\) e\.preventDefault\(\); \}\);/);
  // Positioned only through Electron (setBounds, show, hide); no Win32 call is made for it.
  assert.doesNotMatch(shell, /ffi\.\w+\([^)]*panel/);
  assert.match(fnBody(shell, 'panelEvent'), /panel\.setBounds\(panelBounds\(strip\.length, win\.getContentBounds\(\), anchorX, BAR\)\);/);
  // Closed by a pick, Escape, + again, focus loss, the shell moving, resizing, minimizing, and destroyed with the shell.
  assert.match(shell, /panel\.on\('blur', focusChanged\);/);
  assert.match(shell, /for \(const e of \['move', 'resize', 'minimize', 'hide'\]\) win\.on\(e, \(\) => closeStrip\(\)\);/);
  assert.match(fnBody(shell, 'quit'), /if \(!panel\.isDestroyed\(\)\) panel\.destroy\(\);/);
  assert.match(fnBody(shell, 'pickApp'), /const list = candidates\(appId\);\n {4}closeStrip\(\);/);
  // Its page: the tab bar's CSP, nothing remote, no inline script or style.
  const html = readFileSync(join(DESKTOP, 'ui', 'strip.html'), 'utf8');
  const csp = (h: string) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(h)?.[1];
  assert.equal(csp(html), csp(readFileSync(join(DESKTOP, 'ui', 'tabs.html'), 'utf8')));
  assert.equal(csp(html), "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
  assert.doesNotMatch(html, /<img|<iframe|https?:|<script>|style=/);
  const js = readFileSync(join(DESKTOP, 'ui', 'strip.mjs'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|fetch\(|XMLHttpRequest|import\(|location|window\.open/, 'text only, loads and opens nothing');
});

/**
 * Every IPC handler sits behind a sender check, each page for its own channels: one listen() with the one check
 * (sender page, argument count, values), called exactly twice, the tab bar's table with fromTabBar and the panel's two
 * channels with fromStrip; both checks are the same fromPage, pinned to that page's webContents and fixed local URL.
 */
function ipcSenders(shell: string) {
  assert.equal((shell.match(/ipcMain\.on\(/g) ?? []).length, 1, 'one place registers IPC handlers');
  assert.match(fnBody(shell, 'listen'), /ipcMain\.on\(channel, \(event, \.\.\.args\) => \{\n {8}if \(!from\(event\) \|\| args\.length > 1 \|\| \(valid\[channel\] && !valid\[channel\]\(\.\.\.args\)\)\) \{ ipc\.rejected\+\+; return; \}/);
  assert.deepEqual([...shell.matchAll(/^ {2}listen\((\w+), (\w+)\);$/gm)].map((m) => `${m[1]} ${m[2]}`), ['handlers fromTabBar', 'stripHandlers fromStrip', 'settingsHandlers fromSettings']);
  assert.equal((shell.match(/\blisten\(/g) ?? []).length, 4, 'defined once, called three times');
  assert.match(shell, /const fromTabBar = \(event\) => fromPage\(event, tabs, TABS_PAGE\);/);
  assert.match(shell, /const fromStrip = \(event\) => fromPage\(event, strips, STRIP_PAGE\);/);
  assert.match(shell, /const fromSettings = \(event\) => fromPage\(event, settingsPage, SETTINGS_PAGE\);/);
  assert.match(shell, /const settingsPage = settingsWin\.webContents;/);
  assert.match(shell, /return event\.sender === wc && !!f && !!main && f\.parent === null\n {6}&& f\.processId === main\.processId && f\.routingId === main\.routingId && f\.url === url;/);
  assert.match(shell, /const tabs = win\.webContents;/);
  assert.match(shell, /const strips = panel\.webContents;/);
  // The panel's table: exactly its two channels; neither is in the tab bar's table, and the tab bar's are not in it.
  const block = (name: string) => {
    const m = new RegExp(`^ {2}const ${name} = \\{\\n([\\s\\S]*?)^ {2}\\};$`, 'm').exec(shell);
    assert.ok(m, name);
    return [...m[1].matchAll(/^ {4}'([a-z]+:[a-z]+)':/gm)].map((x) => x[1]);
  };
  assert.deepEqual(block('stripHandlers'), ['strip:pick', 'strip:close']);
  assert.deepEqual(block('settingsHandlers'), ['settings:detect', 'settings:use', 'settings:pick', 'settings:clear', 'settings:close']);
  const tabChannels = block('handlers');
  assert.ok(tabChannels.length >= 8 && tabChannels.every((c) => !c.startsWith('strip:') && !c.startsWith('settings:')), tabChannels.join());
}

// --- icons: from the program file's own resources; installs looked up read-only --------------------------------

const peicon = await load('lib/peicon.mjs');
const locate = await load('lib/locate.mjs');

type Frame = { size: number; bits?: number; bytes: Buffer };
/**
 * A minimal Windows program file (PE32+) with a resource section: RT_ICON frames and one RT_GROUP_ICON listing them,
 * unless `group` is false. Only the parts the icon reader looks at; enough to stand in for a real program file.
 */
function fakePe(frames: Frame[], { group = true, extraType = 0 } = {}) {
  const RVA = 0x2000;
  const dir = (named: number, ids: number) => { const b = Buffer.alloc(16); b.writeUInt16LE(named, 12); b.writeUInt16LE(ids, 14); return b; };
  const ent = (id: number, to: number, sub: boolean) => { const b = Buffer.alloc(8); b.writeUInt32LE(id, 0); b.writeUInt32LE((to | (sub ? 0x80000000 : 0)) >>> 0, 4); return b; };
  // Layout inside the section: [root][type dirs][name dirs][lang dirs][data entries][data]; offsets computed below.
  const grp = Buffer.alloc(6 + frames.length * 14);
  grp.writeUInt16LE(1, 2);
  grp.writeUInt16LE(frames.length, 4);
  frames.forEach((f, i) => {
    const e = 6 + i * 14;
    grp[e] = f.size >= 256 ? 0 : f.size;
    grp[e + 1] = f.size >= 256 ? 0 : f.size;
    grp.writeUInt16LE(1, e + 4);
    grp.writeUInt16LE(f.bits ?? 32, e + 6);
    grp.writeUInt32LE(f.bytes.length, e + 8);
    grp.writeUInt16LE(i + 1, e + 12);
  });
  const resources: { type: number; id: number; bytes: Buffer }[] = [
    ...frames.map((f, i) => ({ type: 3, id: i + 1, bytes: f.bytes })),
    ...(group ? [{ type: 14, id: 1, bytes: grp }] : []),
    ...(extraType ? [{ type: extraType, id: 1, bytes: Buffer.from('version') }] : []),
  ];
  const types = [...new Set(resources.map((r) => r.type))].sort((a, b) => a - b);
  // Sizes: root 16 + 8 per type; per type a name dir 16 + 8 per id; per resource a lang dir 16 + 8; data entries 16 each.
  let o = 16 + types.length * 8;
  const typeDir = new Map<number, number>();
  for (const t of types) { typeDir.set(t, o); o += 16 + resources.filter((r) => r.type === t).length * 8; }
  const langDir = resources.map(() => { const at = o; o += 24; return at; });
  const dataEntry = resources.map(() => { const at = o; o += 16; return at; });
  const dataAt = resources.map((r) => { const at = o; o += r.bytes.length + ((4 - (r.bytes.length % 4)) % 4); return at; });
  const sec = Buffer.alloc(o);
  dir(0, types.length).copy(sec, 0);
  types.forEach((t, i) => ent(t, typeDir.get(t)!, true).copy(sec, 16 + i * 8));
  for (const t of types) {
    const mine = resources.map((r, i) => ({ r, i })).filter(({ r }) => r.type === t);
    dir(0, mine.length).copy(sec, typeDir.get(t)!);
    mine.forEach(({ r, i }, k) => ent(r.id, langDir[i], true).copy(sec, typeDir.get(t)! + 16 + k * 8));
  }
  resources.forEach((r, i) => {
    dir(0, 1).copy(sec, langDir[i]);
    ent(1033, dataEntry[i], false).copy(sec, langDir[i] + 16);
    sec.writeUInt32LE(RVA + dataAt[i], dataEntry[i]);
    sec.writeUInt32LE(r.bytes.length, dataEntry[i] + 4);
    r.bytes.copy(sec, dataAt[i]);
  });
  const PE = 0x80;
  const OPT = 240;   // PE32+ optional header with 16 data directories
  const head = Buffer.alloc(0x400);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(PE, 0x3c);
  head.write('PE\0\0', PE, 'latin1');
  head.writeUInt16LE(0x8664, PE + 4);
  head.writeUInt16LE(1, PE + 6);   // one section
  head.writeUInt16LE(OPT, PE + 20);
  const opt = PE + 24;
  head.writeUInt16LE(0x20b, opt);
  head.writeUInt32LE(16, opt + 108);   // NumberOfRvaAndSizes
  head.writeUInt32LE(RVA, opt + 112 + 16);   // data directory 2: resources
  head.writeUInt32LE(sec.length, opt + 112 + 20);
  const st = opt + OPT;
  head.write('.rsrc', st, 'latin1');
  head.writeUInt32LE(sec.length, st + 8);
  head.writeUInt32LE(RVA, st + 12);
  head.writeUInt32LE(sec.length, st + 16);
  head.writeUInt32LE(0x400, st + 20);
  return Buffer.concat([head, sec]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (tag: string) => Buffer.concat([PNG_SIG, Buffer.from(`fake png ${tag}`)]);
const bmp = (size: number) => { const b = Buffer.alloc(40 + size * size * 4, 7); b.writeUInt32LE(40, 0); b.writeInt32LE(size, 4); b.writeInt32LE(size * 2, 8); return b; };
/** A read function over `file` that, like the shell's, returns fewer bytes at the end; it fails the test on a bad request. */
function reader(file: Buffer, log: [number, number][] = []) {
  return (offset: number, length: number) => {
    assert.ok(Number.isInteger(offset) && offset >= 0, `offset ${offset}`);
    assert.ok(Number.isInteger(length) && length > 0 && length <= peicon.MAX_RESOURCES, `length ${length}`);
    log.push([offset, length]);
    return file.subarray(offset, offset + length);
  };
}

test('desktop icons: a PNG frame of the program\'s icon is returned as it is stored', () => {
  const big = png('256');
  const r = peicon.iconFromExe(reader(fakePe([{ size: 16, bytes: bmp(16) }, { size: 256, bytes: big }])));
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.bytes, big);
  // The smallest frame of at least 48 px is chosen (small to send, sharp at 200 %); of equal sizes the most colours.
  const r2 = peicon.iconFromExe(reader(fakePe([{ size: 256, bytes: png('256') }, { size: 64, bytes: png('64') }, { size: 32, bytes: png('32') }])));
  assert.deepEqual(r2.bytes, png('64'));
  assert.deepEqual(peicon.pick([{ size: 48, bits: 8 }, { size: 48, bits: 32 }, { size: 16, bits: 32 }]), { size: 48, bits: 32 });
  assert.deepEqual(peicon.pick([{ size: 16, bits: 32 }, { size: 32, bits: 32 }]), { size: 32, bits: 32 }, 'nothing of 48 px: the largest');
  assert.equal(peicon.pick([]), null);
});

test('desktop icons: a bitmap-only icon becomes a one-frame .ico of the chosen frame', () => {
  const frame = bmp(48);
  const r = peicon.iconFromExe(reader(fakePe([{ size: 16, bytes: bmp(16) }, { size: 32, bytes: bmp(32) }, { size: 48, bits: 32, bytes: frame }])));
  assert.equal(r.type, 'image/x-icon');
  const b: Buffer = r.bytes;
  assert.deepEqual([b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4)], [0, 1, 1], 'ICONDIR: reserved, type 1, one image');
  assert.deepEqual([b[6], b[7], b.readUInt16LE(10), b.readUInt16LE(12)], [48, 48, 1, 32], 'width, height, planes, bit count');
  assert.deepEqual([b.readUInt32LE(14), b.readUInt32LE(18)], [frame.length, 22], 'size and offset of the frame');
  assert.deepEqual(b.subarray(22), frame);
});

test('desktop icons: no icon resource, truncated or garbage files give null; never a throw or a read outside the file', () => {
  assert.equal(peicon.iconFromExe(reader(fakePe([{ size: 32, bytes: bmp(32) }], { group: false, extraType: 16 }))), null, 'frames without a group');
  assert.equal(peicon.iconFromExe(reader(fakePe([], { extraType: 16 }))), null, 'an empty group');
  assert.equal(peicon.iconFromExe(reader(Buffer.alloc(0))), null);
  assert.equal(peicon.iconFromExe(reader(Buffer.from('MZ just text'))), null);
  assert.equal(peicon.iconFromExe(() => { throw new Error('unreadable'); }), null, 'a failing read');
  assert.equal(peicon.iconFromExe(() => null), null);
  const good = fakePe([{ size: 16, bytes: bmp(16) }, { size: 256, bytes: png('x') }]);
  // Every truncation of a valid file: null or the right icon (never a throw, never a bad request: reader asserts).
  for (let n = 0; n < good.length; n += 7) {
    const r = peicon.iconFromExe(reader(good.subarray(0, n)));
    assert.ok(r === null || r.bytes.equals(png('x')), `truncated at ${n}`);
  }
  // Corrupted bytes anywhere (pointers, counts, sizes): null or an icon, never a throw or a request out of range.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 3000; i++) {
    const bad = Buffer.from(good);
    for (let k = 0; k < 4; k++) bad[rnd() % bad.length] = rnd() & 0xff;
    const log: [number, number][] = [];
    const r = peicon.iconFromExe(reader(bad, log));
    assert.ok(r === null || (r.bytes.length > 0 && ['image/png', 'image/x-icon'].includes(r.type)));
    assert.ok(log.length <= 6, 'a handful of bounded reads, no loop over the file');
  }
  // Huge sizes in the headers are not followed (the read function is never asked for more than MAX_RESOURCES).
  const huge = Buffer.from(good);
  huge.writeUInt32LE(0x7fffffff, 0x80 + 24 + 112 + 20);
  assert.equal(peicon.iconFromExe(reader(huge)), null);
});

test('desktop icons: the shell reads the program file only (opened read-only), never runs it, and falls back in order', () => {
  const src = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(src, /try \{ fd = openSync\(path, 'r'\); \} catch \{ return null; \}/);
  assert.equal((src.match(/openSync\(/g) ?? []).length, 1);
  assert.match(fnBody(src, 'learnIcon'), /const own = resourceIcon\(path\);\n[\s\S]*app\.getFileIcon\(path, \{ size: 'large' \}\)[\s\S]*url === await generic/,
    'resources first, then getFileIcon unless generic, else the letter');
  // Starting apps (launchApp, shell.openPath) is pinned down by the "desktop launch" tests below.
});

/** The source of `function name(...) { ... }` in a file, up to its closing brace at the same indentation. */
function fnBody(src: string, name: string) {
  const m = new RegExp(`^( *)function ${name}\\(`, 'm').exec(src);
  assert.ok(m, `function ${name}`);
  const end = src.indexOf(`\n${m[1]}}\n`, m.index);
  return src.slice(m.index, end + m[1].length + 3);
}

const LAD = 'C:\\Users\\u\\AppData\\Local';
const appOf = (id: string) => apps.APPS.find((a: { id: string }) => a.id === id);
/** Fake read-only sources: aliases (path → target), Start Menu shortcuts, existing files; every read is logged. */
function sources(over: { aliases?: Record<string, string>; links?: { target: string; args: string }[]; files?: string[]; lad?: string } = {}) {
  const log: string[] = [];
  return {
    log,
    localAppData: over.lad ?? LAD,
    readAlias: (p: string) => { log.push(`alias ${p}`); return over.aliases?.[p] ?? null; },
    isFile: (p: string) => { log.push(`file ${p}`); return (over.files ?? []).includes(p); },
    shortcuts: () => { log.push('shortcuts'); return over.links ?? []; },
  };
}

test('desktop locate: an MSIX app is found through its execution alias, only while it points at the app\'s program', () => {
  const alias = `${LAD}\\Microsoft\\WindowsApps\\Claude_pzs8sxrjxfjjc\\claude-desktop.exe`;
  const real = 'C:\\Program Files\\WindowsApps\\Claude_9.9.9.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';
  assert.deepEqual(locate.locateApp(appOf('claude'), sources({ aliases: { [alias]: real } })), { ok: true, path: alias, icon: real });
  const codexAlias = `${LAD}\\Microsoft\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0\\chatgpt-desktop.exe`;
  assert.equal(locate.locateApp(appOf('codex'), sources({ aliases: { [codexAlias]: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe' } })).path, codexAlias);
  assert.equal(locate.locateApp(appOf('claude'), sources()).ok, false);
  for (const other of ['C:\\Program Files\\WindowsApps\\Claude_9_x64__pzs8sxrjxfjjc\\app\\resources\\claude-ssh-proxy.exe', 'C:\\Windows\\System32\\calc.exe']) {
    const r = locate.locateApp(appOf('claude'), sources({ aliases: { [alias]: other } }));
    assert.equal(r.ok, false, other);
    assert.match(r.reason, /不是这个应用/);
  }
  assert.equal(locate.locateApp(appOf('claude'), sources({ lad: '', aliases: { [alias]: real } })).ok, false);
  const io = sources({ aliases: { [alias]: real } });
  locate.locateApp(appOf('claude'), io);
  assert.deepEqual(io.log, [`alias ${alias}`], 'the alias read is the only read');
});

test('desktop locate: other apps are found through a Start Menu shortcut to their own program, without arguments, on a local drive', () => {
  const exe = 'C:\\Program Files\\Kimi Code\\Kimi Code.exe';
  const ok = (links: { target: string; args: string }[], files = [exe]) => locate.locateApp(appOf('kimi-code'), sources({ links, files }));
  assert.deepEqual(ok([{ target: exe, args: '' }]), { ok: true, path: exe, icon: exe });
  assert.equal(ok([{ target: exe.toUpperCase(), args: '' }], [exe.toUpperCase()]).path, exe.toUpperCase(), 'file names compare without case');
  const refused: [string, { target: string; args: string }[], string[]?][] = [
    ['no shortcut', []],
    ['arguments', [{ target: exe, args: '--evil' }]],
    ['another program (Kimi.exe is the chat app)', [{ target: 'C:\\Program Files\\Kimi\\Kimi.exe', args: '' }], ['C:\\Program Files\\Kimi\\Kimi.exe']],
    ['the target file is gone', [{ target: exe, args: '' }], []],
    ['a network share', [{ target: '\\\\server\\share\\Kimi Code.exe', args: '' }], ['\\\\server\\share\\Kimi Code.exe']],
    ['a script with the same base name', [{ target: 'C:\\x\\Kimi Code.exe.cmd', args: '' }], ['C:\\x\\Kimi Code.exe.cmd']],
    ['a URL', [{ target: 'kimi://open', args: '' }], ['kimi://open']],
    ['an alternate data stream', [{ target: 'C:\\x\\a.txt:Kimi Code.exe', args: '' }], ['C:\\x\\a.txt:Kimi Code.exe']],
  ];
  for (const [what, links, files] of refused) assert.equal(ok(links, files).ok, false, what);
  assert.equal(ok([{ target: exe, args: '-x' }, { target: exe, args: ' ' }]).path, exe, 'the first usable shortcut');
  const starter = 'C:\\ProgramData\\Qoder\\Qoder Launcher\\Qoder Launcher.exe';
  assert.equal(locate.locateApp(appOf('qoder'), sources({ links: [{ target: starter, args: '' }], files: [starter] })).path, starter);
  assert.equal(locate.locateApp(appOf('zcode'), sources({ links: [{ target: starter, args: '' }], files: [starter] })).ok, false);
  for (const a of apps.APPS) {
    const io = sources({ links: [{ target: 'C:\\Windows\\System32\\calc.exe', args: '' }], files: ['C:\\Windows\\System32\\calc.exe'] });
    assert.equal(locate.locateApp(a, io).ok, false, `${a.id} never resolves to another program`);
  }
});

test('desktop locate: the install is never taken from the state file, the page, the Hub or an earlier window', () => {
  const tampered = { version: 1, tabs: [{ app: 'kimi-code', exe: 'C:\\evil\\calc.exe', title: 'Kimi Code', target: 'C:\\evil\\calc.exe', path: 'C:\\evil\\calc.exe' }] };
  assert.deepEqual(dock.loadTabs(tampered), [{ app: 'kimi-code', exe: 'calc.exe', title: 'Kimi Code' }]);
  assert.equal(locate.locateApp.length, 2, 'locateApp(app, sources): nothing else goes in');
  const src = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(src, /launchTarget \?\?= \(a, io = lookup\(\)\) => startTarget\(a, io\);/, 'the strip and the launch look installs up the same way');
  assert.match(fnBody(src, 'readStrip'), /for \(const \[id, t\] of Object\.entries\(targets\)\) if \(t\.ok\) learnIcon\(id, t\.icon\);/);
  assert.equal((src.match(/startTarget\(/g) ?? []).length, 1, 'one lookup in the shell: startTarget, as the default launchTarget');
  assert.doesNotMatch(src, /locateApp\(/, 'the system sources alone are read through startTarget (or a settings row)');
});

// --- starting an app from the strip (docs/desktop.md "启动应用") --------------------------------------------------

const launch = await load('lib/launch.mjs');
test('desktop launch rule 4: whatever locateApp finds for any app is a local .exe path: no arguments, protocol or namespace', () => {
  for (const a of apps.APPS) {
    const r = locate.locateApp(a, sources({ links: [{ target: `C:\\Apps\\${a.exe}`, args: '' }], files: [`C:\\Apps\\${a.exe}`],
      aliases: a.package ? { [`${LAD}\\Microsoft\\WindowsApps\\${a.package}\\${a.alias}`]: `C:\\Program Files\\WindowsApps\\x\\${a.exe}` } : {} }));
    assert.equal(r.ok, true, a.id);
    assert.match(r.path, /^[A-Za-z]:\\[^:*?"<>|]+\.exe$/i, a.id);
  }
});

test('desktop launch rule 3: the target never comes from the state file, the collaboration page, the Hub or an earlier window', () => {
  // A tampered state file: extra fields that look like start targets are dropped when it is read.
  const tampered = { version: 1, tabs: [{ app: 'kimi-code', exe: 'C:\\evil\\calc.exe', title: 'Kimi Code', target: 'C:\\evil\\calc.exe', path: 'C:\\evil\\calc.exe', args: '--x' }] };
  const loaded = dock.loadTabs(tampered);
  assert.deepEqual(loaded, [{ app: 'kimi-code', exe: 'calc.exe', title: 'Kimi Code' }]);
  // Whatever the state holds, the target is what the read-only sources say, looked up by the app record alone.
  const exe = 'C:\\Program Files\\Kimi Code\\Kimi Code.exe';
  const state = dock.initialState(loaded);
  const r = locate.locateApp(appOf(state.tabs[0].app), sources({ links: [{ target: exe, args: '' }], files: [exe] }));
  assert.equal(r.path, exe);
  assert.equal(locate.locateApp.length, 2, 'locateApp(app, sources): nothing else goes in');
  // In the shell: the launch target is looked up with the app record from the shell's own app list, at the click.
  const shell = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  const body = fnBody(shell, 'launchApp');
  assert.match(body, /^ {4}const target = launchTarget\(a\);$/m);
  assert.match(fnBody(shell, 'pickApp'), /launchApp\(apps\.find\(\(a\) => a\.id === appId\)\);/);
  assert.doesNotMatch(body, /state\.|saved|statePath|exePath|binding|hub\.|collab|wc\./, 'no state, saved file, window path, Hub or page in the launch');
  assert.match(shell, /launchTarget \?\?= \(a, io = lookup\(\)\) => startTarget\(a, io\);/);
  assert.match(shell, /const lookup = \(\) => \(\{ \.\.\.sources\(\), saved: \(\) => readAppPaths\(apps\) \}\);/, 'the system sources and app-paths.json, nothing else');
  // main.mjs never replaces the lookup (only the checks inject one, to start nothing real).
  const main = readFileSync(join(DESKTOP, 'main.mjs'), 'utf8');
  assert.match(main, /startShell\(\{ ffi, ensure: \(\) => runEnsure\(runtime\) \}\)/);
  assert.match(main, /runtimeConfig\(\{ packaged: app\.isPackaged, resourcesPath: process\.resourcesPath/);
  assert.doesNotMatch(main, /launchTarget|openPath|\bsources\b/);
});

test('desktop launch rules 1, 4, 5: one launch function, one call site, reached only from the tab bar\'s strip:pick; no arguments', () => {
  const sources = desktopSources().filter((f) => !f.path.startsWith('test/') && !f.path.startsWith('scripts/'));
  for (const f of sources) assert.doesNotMatch(f.code, /(?:from\s+|import\s*\()['"][^'"]*scripts\//, 'build scripts stay outside the app runtime');
  // Rule 5: exactly one place hands a program to the system, in launchApp, which is called once, from pickApp, which
  // is called once, from the strip:pick IPC handler.
  const shellSrc = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  const calls = sources.flatMap((f) => [...f.code.matchAll(/\.openPath\(/g)].map(() => f.path));
  assert.deepEqual(calls, ['shell.mjs'], 'one openPath call in all desktop sources');
  assert.ok(!sources.some((f) => /openExternal|showItemInFolder/.test(f.code)), 'nothing else is handed to the system');
  const launchBody = fnBody(shellSrc, 'launchApp');
  assert.match(launchBody, /^ {4}shell\.openPath\(target\.path\)\.then\(/m, 'the call is inside launchApp, with the target path alone (rule 4)');
  const count = (re: RegExp) => (shellSrc.match(re) ?? []).length;
  assert.equal(count(/\blaunchApp\(/g), 2, 'defined once, called once');
  assert.equal(count(/\bpickApp\(/g), 2, 'pickApp defined once, called once');
  assert.match(fnBody(shellSrc, 'pickApp'), /else launchApp\(/);
  const pickLine = /^ {4}'strip:pick': \(appId\) => \{ if \(strip && hub\.status !== 'starting'\) pickApp\(appId\); \},$/m;
  assert.match(shellSrc, pickLine);
  // Rule 1: that handler is in the panel's table, registered only behind the panel's sender check (fromStrip: the
  // panel's own webContents, main frame, fixed local page; the collaboration page has no preload, and the tab bar and
  // any other page are refused); nothing else starts a program: no other process start in the shell.
  const stripTable = /^ {2}const stripHandlers = \{\n([\s\S]*?)^ {2}\};$/m.exec(shellSrc);
  assert.ok(stripTable && pickLine.test(stripTable[1]), 'the pick handler is in the panel\'s table');
  ipcSenders(shellSrc);
  assert.equal(count(/\bspawn\(/g), 1, 'the only other process start is runEnsure (node + the launcher, fixed arguments)');
  assert.match(shellSrc, /spawn\(node, \[launcher, '--ensure'\],/);
  for (const f of sources) {
    // shortcut.mjs is not part of the running shell: `npm run shortcut`, run by the user, writes the Desktop shortcut.
    const code = f.code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // comments may name them
    if (f.path !== 'shell.mjs' && f.path !== 'shortcut.mjs') assert.doesNotMatch(code, /launchApp|pickApp|child_process|openPath/, `${f.path} has no launch path`);
    assert.doesNotMatch(f.code, /shell:AppsFolder|explorer\.exe|\bexecFile\b|\bexec\(|\bfork\(/i, `${f.path}: no other way to start a program`);
  }
  // Start-up, restoring tabs, an app going away, Hub or page events, second-instance activation, re-selecting a tab:
  // none of these reaches pickApp (its one call is the strip:pick handler above). main.mjs's second instance only
  // brings the shell to the front; the reducer and the writer know nothing about starting.
  const main = readFileSync(join(DESKTOP, 'main.mjs'), 'utf8');
  assert.match(main, /app\.on\('second-instance', \(\) => shell\.focus\(\)\);/);
  for (const f of ['lib/dock.mjs', 'lib/writer.mjs', 'lib/windows.mjs', 'lib/navigation.mjs']) {
    assert.doesNotMatch(readFileSync(join(DESKTOP, f), 'utf8'), /launchApp|openPath|locateApp|createWatch|launch\.mjs/, f);
  }
  // Rule 4 in the result: what may be started is a local .exe (checked in locateApp, tested above), opened with no
  // second argument; the panel's preload's pick sends a string id only, and the tab bar's sends none.
  assert.match(readFileSync(join(DESKTOP, 'strip-preload.cjs'), 'utf8'), /pick: \(app\) => ipcRenderer\.send\('strip:pick', typeof app === 'string' \? app : ''\),/);
  assert.doesNotMatch(readFileSync(join(DESKTOP, 'preload.cjs'), 'utf8'), /strip:pick/);
});

test('desktop launch rule 2: only apps in the supported list; the tab bar\'s id is checked against the shell\'s list', () => {
  const shellSrc = readFileSync(join(DESKTOP, 'shell.mjs'), 'utf8');
  assert.match(shellSrc, /'strip:pick': \(\.\.\.args\) => args\.length === 1 && isAppId\(args\[0\], apps\),/);
  // An id that passed is looked up in the same list; locateApp only knows how to find that app's own program.
  for (const a of apps.APPS) {
    const io = sources({ links: [{ target: 'C:\\Windows\\System32\\calc.exe', args: '' }, { target: 'C:\\Windows\\System32\\cmd.exe', args: '' }],
      files: ['C:\\Windows\\System32\\calc.exe', 'C:\\Windows\\System32\\cmd.exe'] });
    assert.equal(locate.locateApp(a, io).ok, false, `${a.id} never resolves to another program`);
  }
});

test('desktop launch: after the click, one new window is added, several are offered, none within 20 s does nothing', () => {
  const W = (hwnd: number) => ({ hwnd });
  const t0 = 1000;
  // One window appears (the windows there before the click never count).
  let w = launch.createWatch(new Set([1]), t0);
  assert.equal(w.tick([W(1)], t0 + 400), null);
  assert.equal(w.tick([W(1), W(2)], t0 + 3000), null, 'waits a moment for others appearing with it');
  assert.deepEqual(w.tick([W(1), W(2)], t0 + 3000 + launch.SETTLE_MS), { add: W(2) });
  assert.equal(w.done, true);
  assert.equal(w.tick([W(1), W(2), W(3)], t0 + 5000), null, 'answered once; done');
  // Several appear together: the user picks.
  w = launch.createWatch(new Set(), t0);
  assert.equal(w.tick([W(5), W(6)], t0 + 2000), null);
  assert.deepEqual(w.tick([W(5), W(6), W(7)], t0 + 2000 + launch.SETTLE_MS), { choose: [W(5), W(6), W(7)] });
  // None within WATCH_MS: nothing (the caller does not start it again).
  w = launch.createWatch(new Set([1]), t0);
  assert.equal(w.tick([W(1)], t0 + launch.WATCH_MS - 1), null);
  assert.deepEqual(w.tick([W(1)], t0 + launch.WATCH_MS), { none: true });
  assert.equal(w.tick([W(1), W(9)], t0 + launch.WATCH_MS + 500), null, 'a window appearing after the watch is not taken');
  // A splash screen that comes and goes resets the wait; the next window is the one.
  w = launch.createWatch(new Set(), t0);
  assert.equal(w.tick([W(8)], t0 + 1000), null);
  assert.equal(w.tick([], t0 + 1500), null);
  assert.equal(w.tick([W(9)], t0 + 1600), null);
  assert.deepEqual(w.tick([W(9)], t0 + 1600 + launch.SETTLE_MS), { add: W(9) });
  // A window first seen just before the deadline still gets its settle time (decided at most SETTLE_MS after it).
  w = launch.createWatch(new Set(), t0);
  assert.equal(w.tick([W(4)], t0 + launch.WATCH_MS - 100), null);
  assert.equal(w.tick([W(4)], t0 + launch.WATCH_MS), null, 'still settling past the deadline');
  assert.deepEqual(w.tick([W(4)], t0 + launch.WATCH_MS - 100 + launch.SETTLE_MS), { add: W(4) });
  assert.equal(launch.WATCH_MS, 20_000);
});

test('desktop launch: the deadline wins: a window first seen after 20 s is never added, also when a poll comes late', () => {
  const W = (hwnd: number) => ({ hwnd });
  // Review desktop-launcher r1, P2-1: nothing at 19.9 s, the first window at 20.1 s → the watch ends, nothing added.
  let w = launch.createWatch(new Set(), 0);
  assert.equal(w.tick([], 19_900), null);
  assert.deepEqual(w.tick([W(9)], 20_100), { none: true });
  assert.equal(w.done, true);
  assert.equal(w.tick([W(9)], 21_000), null, 'ended: answers nothing more');
  // A late poll (the event loop was busy), nothing seen before: whatever is there now came after the deadline.
  w = launch.createWatch(new Set(), 0);
  assert.equal(w.tick([], 5_000), null);
  assert.deepEqual(w.tick([W(9), W(10)], 45_000), { none: true });
  // A late poll after a window was first seen before the deadline: its settle time is over, it is added; a window
  // first seen only in the late poll is not taken with it.
  w = launch.createWatch(new Set(), 0);
  assert.equal(w.tick([W(4)], 19_700), null);
  assert.deepEqual(w.tick([W(4), W(5)], 45_000), { add: W(4) });
  // The same with two seen before the deadline: the user picks between those two only.
  w = launch.createWatch(new Set(), 0);
  assert.equal(w.tick([W(4), W(6)], 19_700), null);
  assert.deepEqual(w.tick([W(4), W(6), W(5)], 45_000), { choose: [W(4), W(6)] });
  // Seen before the deadline but gone by the late poll (a splash screen): nothing is added.
  w = launch.createWatch(new Set(), 0);
  assert.equal(w.tick([W(4)], 19_700), null);
  assert.deepEqual(w.tick([W(5)], 45_000), { none: true });
});

test('desktop launch: while an app is being started its icon stays "starting" and a click adds nothing, windows or not', () => {
  // Review desktop-launcher r1, P2-2: a window of the app is already there (the watch is in its settle time).
  const T = [{ id: 'test', name: 'Test', exe: 'Test.exe' }];
  const starting = new Set(['test']);
  const [e] = strip.stripEntries([{ app: 'test', hwnd: 1 }], [], { targets: { test: { ok: true } }, starting }, T);
  assert.equal(e.status, 'starting');
  assert.equal(strip.pickFor([{ hwnd: 1 }], [], 'test', starting), null);
  assert.equal(strip.pickFor([{ hwnd: 1 }, { hwnd: 2 }], [], 'test', starting), null);
  // The outer path, with the shell's pieces and a fake Win32 layer: start → the window appears → the strip is opened
  // again and the icon clicked → nothing is added and nothing is started again; the watch then adds the window, once.
  const h = harness([]);
  const claudeStarting = new Set(['claude']);
  const w = launch.createWatch(new Set(h.candidates('claude').map((c: { hwnd: number }) => c.hwnd)), 0);
  h.ffi.add(fakeWindow({ hwnd: 0xa }));
  assert.equal(w.tick(h.candidates('claude'), 400), null, 'settling');
  const reopened = strip.stripEntries(h.candidates(), h.state.tabs, { targets: { claude: { ok: true } }, starting: claudeStarting });
  assert.equal(reopened.find((x: { id: string }) => x.id === 'claude').status, 'starting');
  assert.equal(strip.pickFor(h.candidates('claude'), h.state.tabs, 'claude', claudeStarting), null, 'the click: no add, no start');
  assert.deepEqual([h.state.tabs.length, calls(h).length], [0, 0]);
  const r = w.tick(h.candidates('claude'), 400 + launch.SETTLE_MS);
  assert.equal(r.add.hwnd, 0xa);
  claudeStarting.delete('claude');
  h.dispatch({ type: 'add', candidate: r.add });
  assert.equal(h.state.tabs.length, 1);
  assert.equal(strip.pickFor(h.candidates('claude'), h.state.tabs, 'claude', claudeStarting), null, 'docked now: a click starts nothing');
});

test('desktop launch: the auto-added window goes through the normal pick: identity captured and checked, nothing else written', () => {
  // The watch's { add } is dispatched as the same 'add' a pick from a list is: a window whose identity changed between
  // the read and the add gets no write; the other app windows get none either.
  const h = harness([fakeWindow({ hwnd: 0xa }), fakeWindow({ hwnd: 0xb, pid: 4100, title: 'other' })]);
  const w = launch.createWatch(new Set([0xb]), 0);
  w.tick(h.candidates('claude'), 100);
  const r = w.tick(h.candidates('claude'), 100 + launch.SETTLE_MS);
  assert.equal(r.add.hwnd, 0xa);
  h.ffi.windows.get(0xa).pid = 7777;   // replaced meanwhile
  h.dispatch({ type: 'add', candidate: r.add });
  assert.deepEqual(calls(h), [], 'identity changed: zero writes');
  assert.equal(h.state.tabs.length, 0);
});

// --- review desktop-tabs r3 ---------------------------------------------------------------------------------------

test('desktop B: dockedPosition reads the z-order: front, under, or hidden behind a window between them', () => {
  const S = () => fakeWindow({ hwnd: OWN, pid: 9000, exePath: 'C:\\orrery\\desktop\\electron.exe', title: 'orrery' });
  const A = () => fakeWindow({ hwnd: 0xa });
  const C = (over: Record<string, unknown> = {}) => fakeWindow({ hwnd: 0xc, pid: 4300, exePath: 'C:\\Windows\\notepad.exe', title: 'C', ...over });
  const at = (wins: Record<string, unknown>[], area: Rect | null = RECT) => windows.dockedPosition(createFakeFfi(wins), OWN, 0xa, area);
  assert.equal(at([A(), S(), C()]), 'front');
  assert.equal(at([S(), A(), C()]), 'under');
  assert.equal(at([C(), S(), A()]), 'under', 'a window in front of both does not matter here');
  assert.equal(at([S(), C(), A()]), 'hidden', 'C between them, over the dock area');
  for (const [what, over] of [['invisible', { visible: false }], ['minimized', { iconic: true }], ['cloaked', { cloaked: true }], ['cloaking unreadable', { cloaked: null }],
    ['elsewhere on screen', { normal: { left: 3000, top: 3000, right: 3100, bottom: 3100 } }]] as [string, Record<string, unknown>][]) {
    assert.equal(at([S(), C(over), A()]), 'under', `C ${what} does not hide A`);
  }
  assert.equal(at([S(), C(), A()], null), 'front', 'no dock area: nothing to judge by, nothing to do');
  assert.equal(at([S(), C()]), 'front', 'docked window not listed');
});

/**
 * The reviewer's case on an in-memory z-order: A docked, then C (unrelated, over the dock area) comes in front of it
 * (C → A → shell), then the user brings the shell back from the taskbar (shell → C → A). Returns the final order.
 */
function threeWindows(read: DockedPosition | true) {
  const h = harness([fakeWindow({ hwnd: 0xa }), fakeWindow({ hwnd: 0xc, pid: 4300, exePath: 'C:\\Windows\\notepad.exe', title: 'C' })], { zorder: read });
  h.add(0xa);
  const name = (x: number) => (x === OWN ? 'shell' : x === 0xa ? 'A' : 'C');
  const stack = () => h.ffi.enumWindows().map(name).join(' → ');
  assert.equal(stack(), 'A → shell → C', 'docked: the shell right beneath A');
  h.ffi.toTop(0xc);
  assert.equal(stack(), 'C → A → shell');
  h.ffi.toTop(OWN);
  const n = calls(h).length;
  h.dispatch({ type: 'focus' });
  h.dispatch({ type: 'restack' });
  return { h, n, stack };
}

test('desktop B: three windows: the shell brought back is not lowered behind a window over the dock area; a tab click still docks', async () => {
  const { h, n, stack } = threeWindows(true);
  assert.equal(stack(), 'shell → C → A', 'the shell stays usable in front of C');
  assert.equal(calls(h).length, n, 'focus and restack wrote nothing');
  h.dispatch({ type: 'select', id: 't1' });   // the user clicks A's tab: dock it, shell right beneath
  assert.equal(stack(), 'A → shell → C');
  // Without the "window in between" rule (the code before this fix), the same case hides the shell behind C.
  const old = await mutant('lib/windows.mjs', "    if (intersects(fromRECT(ffi.getExtendedFrameBounds(h)), area)) return 'hidden';\n", '');
  assert.equal(threeWindows(old.dockedPosition).stack(), 'C → A → shell', 'the mutant lowers the shell beneath A, behind C');
});

test('desktop C: lowering the shell is refused for any trigger but a tab action, activation or a z-order check', () => {
  const a = fakeWindow({ hwnd: 0xa });
  const ffi = createFakeFfi([a, fakeWindow({ hwnd: OWN, pid: 9000, exePath: 'C:\\orrery\\desktop\\electron.exe', title: 'orrery' })]);
  const w = writerMod.createWriter(ffi, { ownWindow: () => OWN });
  const binding = { id: 1, hwnd: 0xa, pid: a.pid, exePath: a.exePath, className: a.className };
  for (const trigger of ['bounds', 'minimize', 'restore', 'close', 'quit', 'shutdown', 'menu', '']) {
    assert.equal(w.write({ op: 'lowerShell', tab: 't1', binding, trigger }).status, 'refused', trigger);
  }
  assert.deepEqual(ffi.calls, []);
  for (const trigger of ['add', 'choose', 'select', 'focus', 'restack']) assert.equal(w.write({ op: 'lowerShell', tab: 't1', binding, trigger }).status, 'ok', trigger);
  assert.equal(ffi.calls.length, 5);
});

// --- split view (docs/desktop.md "分屏") ---------------------------------------------------------------------------

const GAP = 6;
/** The pane rects of RECT with a 6 px slit, as the reducer computes them. */
const panesOf = (layout: string, ratios = { x: 0.5, y: 0.5 }) => geometry.paneRects(RECT, layout, ratios, GAP) as Rect[];
const claude = (hwnd: number, over: Record<string, unknown> = {}) => fakeWindow({ hwnd, pid: 4000 + hwnd, title: `Claude ${hwnd.toString(16)}`, ...over });
const visible = (w: { rect?: { left: number; top: number; right: number; bottom: number } }) => w.rect && { x: w.rect.left, y: w.rect.top, width: w.rect.right - w.rect.left, height: w.rect.bottom - w.rect.top };
/** A shell with windows 0xa… added in order, in the given layout (each add goes into the active pane). */
function split(layout: 'columns' | 'grid', hwnds: number[], opts: Record<string, unknown> = {}) {
  const h = harness(hwnds.map((x) => claude(x)), { gap: GAP, ...opts });
  h.dispatch({ type: 'layout', layout });
  h.dispatch({ type: 'activate', pane: 0 });   // the first window replaces the collaboration page in the first pane
  for (const x of hwnds) {
    h.add(x);
    // The next empty pane becomes active for the next add, as the user would click it.
    const empty = h.state.panes.indexOf(null);
    if (empty >= 0) h.dispatch({ type: 'activate', pane: empty });
  }
  return h;
}
const paneIds = (h: { state: { panes: (string | null)[] } }) => h.state.panes.join(',');

test('desktop B: split geometry: two columns and a 2 × 2 grid with a slit; the tab bar draws the same split', () => {
  assert.deepEqual(panesOf('single'), [RECT]);
  assert.deepEqual(panesOf('columns'), [{ x: 0, y: 72, width: 1277, height: 1368 }, { x: 1283, y: 72, width: 1277, height: 1368 }]);
  assert.deepEqual(panesOf('grid', { x: 0.25, y: 0.5 }), [
    { x: 0, y: 72, width: 639, height: 681 }, { x: 645, y: 72, width: 1915, height: 681 },
    { x: 0, y: 759, width: 639, height: 681 }, { x: 645, y: 759, width: 1915, height: 681 },
  ]);
  assert.equal(geometry.PANE_GAP, 6);
  const css = readFileSync(join(DESKTOP, 'ui', 'tabs.css'), 'utf8');
  assert.match(css, /\.pane\.c0 \{ left: 0; width: calc\(\(100% - 6px\) \* var\(--x\)\); \}/);
  assert.match(css, /\.pane\.r1 \{ top: calc\(\(100% - 6px\) \* var\(--y\) \+ 6px\); bottom: 0; \}/);
});

test('desktop B: changing the layout: growing keeps the content and activates the first empty pane; shrinking keeps the active pane\'s content and minimizes the rest', () => {
  const h = harness([claude(0xa), claude(0xb), claude(0xc), claude(0xd)], { gap: GAP });
  const a = h.ffi.windows.get(0xa);
  h.add(0xa);
  h.dispatch({ type: 'layout', layout: 'columns' });
  assert.deepEqual([paneIds(h), h.state.active], ['t1,', 1], 'A stays in the left pane, the new right pane is empty and active');
  assert.deepEqual(visible(a), panesOf('columns')[0], 'A resized into the left pane');
  h.add(0xb);
  assert.deepEqual([paneIds(h), h.state.active], ['t1,t2', 1], 'a new window goes into the active pane');
  h.dispatch({ type: 'layout', layout: 'grid' });
  assert.deepEqual([paneIds(h), h.state.active], ['t1,t2,,', 2], 'the two columns become the top row; the first empty cell is active');
  h.add(0xc);
  h.dispatch({ type: 'activate', pane: 3 });
  h.add(0xd);
  assert.equal(paneIds(h), 't1,t2,t3,t4');
  assert.deepEqual([0xa, 0xb, 0xc, 0xd].map((x) => visible(h.ffi.windows.get(x))), panesOf('grid'));
  // The active pane is the last one: shrinking drops the last others first, and the active content always stays.
  let n = calls(h).length;
  h.dispatch({ type: 'layout', layout: 'columns' });
  assert.deepEqual([paneIds(h), h.state.active], ['t1,t4', 1], 'A and D (active) stay; C, then B were dropped');
  assert.deepEqual(calls(h).slice(n).filter((c) => c.fn === 'ShowWindow').map((c) => [c.hwnd, c.cmd]), [[0xb, 7], [0xc, 7]], 'B and C minimized');
  assert.deepEqual([0xa, 0xd].map((x) => visible(h.ffi.windows.get(x))), panesOf('columns'));
  n = calls(h).length;
  h.dispatch({ type: 'layout', layout: 'single' });
  assert.deepEqual([paneIds(h), h.state.active], ['t4', 0]);
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd, c.cmd ?? '']), [['SetWindowPos', 0xd, ''], ['ShowWindow', 0xa, 7]]);
  assert.deepEqual(visible(h.ffi.windows.get(0xd)), RECT);
  // The collaboration page dropped from a pane is just not shown; an emptied single pane shows it again.
  const g = harness([], { gap: GAP });
  g.dispatch({ type: 'layout', layout: 'grid' });
  assert.deepEqual([paneIds(g), g.state.active], ['orrery,,,', 1]);
  g.dispatch({ type: 'select', id: dock.ORRERY });   // already in pane 0: only makes it active
  g.dispatch({ type: 'activate', pane: 3 });
  g.dispatch({ type: 'layout', layout: 'columns' });
  assert.deepEqual([paneIds(g), g.state.active], ['orrery,', 1], 'the active pane was empty: the first empty pane is active');
  g.dispatch({ type: 'select', id: dock.ORRERY });
  g.dispatch({ type: 'activate', pane: 1 });
  g.dispatch({ type: 'select', id: dock.ORRERY });   // into the active pane? It is already in pane 0: that one becomes active
  assert.deepEqual([paneIds(g), g.state.active], ['orrery,', 0]);
  g.state = { ...g.state, panes: [null, null], active: 1 };
  g.dispatch({ type: 'layout', layout: 'single' });
  assert.deepEqual([paneIds(g), g.state.active], ['orrery', 0]);
  assert.deepEqual(calls(g), []);
});

test('desktop B: a tab click goes into the active pane; a tab already in a pane only makes that pane active; a tab is never in two panes', () => {
  const h = split('columns', [0xa, 0xb]);
  const c = h.ffi.add(claude(0xc));
  h.add(0xc);   // the active pane is the right one (after B the grid had no empty pane left: still pane 1)
  assert.deepEqual([paneIds(h), h.state.active], ['t1,t3', 1], 'C replaced B in the active pane');
  assert.equal(h.ffi.windows.get(0xb).iconic, true, 'B minimized');
  assert.deepEqual(visible(c), panesOf('columns')[1]);
  // A is in the left pane: clicking its tab activates that pane and docks A again, no other pane moves.
  let n = calls(h).length;
  h.dispatch({ type: 'select', id: 't1' });
  assert.deepEqual([paneIds(h), h.state.active], ['t1,t3', 0]);
  assert.deepEqual(calls(h).slice(n).filter((x) => x.hwnd !== OWN).map((x) => [x.fn, x.hwnd]), [['SetWindowPos', 0xa], ['SetForegroundWindow', 0xa]],
    'only A: placed and brought to the foreground; C is not written to');
  // B (not shown) goes into the active (left) pane and replaces A, which is minimized.
  n = calls(h).length;
  h.dispatch({ type: 'select', id: 't2' });
  assert.deepEqual([paneIds(h), h.state.active], ['t2,t3', 0]);
  assert.deepEqual(calls(h).slice(n).filter((x) => x.hwnd !== OWN).map((x) => [x.fn, x.hwnd, x.cmd ?? '']),
    [['ShowWindow', 0xb, 9], ['SetWindowPos', 0xb, ''], ['SetForegroundWindow', 0xb, ''], ['ShowWindow', 0xa, 7]], 'B docked first, then A minimized');
  // The collaboration page into the active pane replaces B; then a click on the tab of C, already shown, moves nothing else.
  n = calls(h).length;
  h.dispatch({ type: 'select', id: dock.ORRERY });
  assert.deepEqual([paneIds(h), h.state.active, dock.view(h.state).selected], ['orrery,t3', 0, dock.ORRERY]);
  assert.deepEqual(calls(h).slice(n).map((x) => [x.fn, x.hwnd, x.cmd]), [['ShowWindow', 0xb, 7]]);
  h.dispatch({ type: 'select', id: 't3' });
  assert.deepEqual([paneIds(h), h.state.active], ['orrery,t3', 1]);
  for (const id of ['t1', 't2', dock.ORRERY, 't3', 't1']) {
    h.dispatch({ type: 'select', id });
    const shown = h.state.panes.filter((p: string | null) => p !== null);
    assert.equal(new Set(shown).size, shown.length, `no tab in two panes after selecting ${id}`);
  }
  // The tab bar sees which tabs are in a pane and which one is in the active pane.
  const v = dock.view(h.state);
  assert.deepEqual([v.layout, v.panes, v.active, v.selected], ['columns', h.state.panes, h.state.active, h.state.panes[h.state.active]]);
  assert.deepEqual(v.tabs.map((t: { inPane: boolean }) => t.inPane), ['t1', 't2', 't3'].map((id) => h.state.panes.includes(id)));
  // Out-of-range or non-integer panes change nothing.
  const before = JSON.stringify(h.state);
  for (const pane of [-1, 2, 1.5, '1', null, h.state.active]) h.dispatch({ type: 'activate', pane });
  assert.equal(JSON.stringify(h.state), before);
});

test('desktop B: closing a tab in a pane empties that pane (not refilled); in a single pane the collaboration page comes back', () => {
  const h = split('columns', [0xa, 0xb]);
  h.dispatch({ type: 'close', id: 't1' });
  assert.deepEqual([paneIds(h), h.state.active], [',t2', 1]);
  assert.equal(calls(h).at(-1)?.fn, 'SetWindowPlacement');
  const s = harness([claude(0xa)]);
  s.add(0xa);
  s.dispatch({ type: 'close', id: 't1' });
  assert.equal(paneIds(s), 'orrery');
});

test('desktop B: following, minimizing, restoring and quitting cover every pane; the active pane\'s window is restored last', () => {
  const h = split('grid', [0xa, 0xb, 0xc]);
  h.dispatch({ type: 'activate', pane: 1 });
  let n = calls(h).length;
  h.dispatch({ type: 'bounds' });
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd]), [['SetWindowPos', 0xa], ['SetWindowPos', 0xb], ['SetWindowPos', 0xc]]);
  assert.deepEqual([0xa, 0xb, 0xc].map((x) => visible(h.ffi.windows.get(x))), panesOf('grid').slice(0, 3));
  n = calls(h).length;
  h.dispatch({ type: 'minimize' });
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd, c.cmd]), [['ShowWindow', 0xa, 7], ['ShowWindow', 0xb, 7], ['ShowWindow', 0xc, 7]]);
  h.dispatch({ type: 'bounds' });
  h.dispatch({ type: 'focus' });
  n = calls(h).length;
  h.dispatch({ type: 'restore' });
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd, c.cmd ?? '']), [
    ['ShowWindow', 0xa, 9], ['SetWindowPos', 0xa, ''], ['ShowWindow', 0xc, 9], ['SetWindowPos', 0xc, ''], ['ShowWindow', 0xb, 9], ['SetWindowPos', 0xb, ''],
  ], 'B (the active pane) last, so it ends up in front');
  assert.equal(calls(h).slice(n).filter((c) => c.fn === 'SetForegroundWindow').length, 0);
  n = calls(h).length;
  h.dispatch({ type: 'quit' });
  assert.deepEqual(calls(h).slice(n).map((c) => [c.fn, c.hwnd]), [['SetWindowPlacement', 0xa], ['SetWindowPlacement', 0xb], ['SetWindowPlacement', 0xc]]);
});

test('desktop B: the shell goes beneath the lowest docked window, read at write time; not when a third window is in between', () => {
  const wins = [claude(0xa), claude(0xb), fakeWindow({ hwnd: 0xe, pid: 4300, exePath: 'C:\\Windows\\notepad.exe', title: 'E', iconic: true })];
  const h = harness(wins, { gap: GAP, zorder: true });
  const name = (x: number) => (x === OWN ? 'shell' : x === 0xa ? 'A' : x === 0xb ? 'B' : 'E');
  const stack = () => h.ffi.enumWindows().filter((x: number) => !h.ffi.isIconic(x)).map(name).join(' → ');
  h.dispatch({ type: 'layout', layout: 'columns' });
  h.dispatch({ type: 'activate', pane: 0 });
  h.add(0xa);
  h.dispatch({ type: 'activate', pane: 1 });
  h.add(0xb);
  assert.equal(stack(), 'B → A → shell', 'both docked windows above the shell');
  // A click on the shell brings it to the top; the check puts it beneath the lowest of them (A).
  h.ffi.toTop(OWN);
  h.dispatch({ type: 'restack' });
  assert.equal(stack(), 'B → A → shell');
  assert.deepEqual(calls(h).filter((c) => c.hwnd === OWN).map((c) => c.after).at(-1), 0xa);
  // Clicking B's tab when B is the lowest: B gets the foreground (comes up), and only then is the lowest read (A).
  h.ffi.toTop(0xa);
  h.ffi.toTop(OWN);
  assert.equal(stack(), 'shell → A → B');
  h.dispatch({ type: 'select', id: 't2' });
  assert.equal(stack(), 'B → A → shell', 'not beneath B, which would leave A under the shell');
  // Windows refuses the foreground: B stays where it was, the shell goes beneath B, the lowest.
  h.ffi.windows.get(0xb).foregroundOk = false;
  h.ffi.toTop(0xa);
  h.ffi.toTop(OWN);
  h.dispatch({ type: 'select', id: 't2' });
  assert.equal(stack(), 'A → B → shell');
  // A third window (E) over the dock area between the shell and the lowest docked window: no write.
  const e = h.ffi.windows.get(0xe);
  e.iconic = false;
  h.ffi.toTop(0xa);
  h.ffi.toTop(0xe);
  h.ffi.toTop(OWN);
  assert.equal(stack(), 'shell → E → A → B');
  let n = calls(h).length;
  h.dispatch({ type: 'focus' });
  h.dispatch({ type: 'restack' });
  assert.equal(calls(h).length, n, 'E is between the shell and B: the shell is not lowered behind E');
  h.ffi.toTop(0xa);
  h.ffi.toTop(OWN);   // shell → A → E → B: E still between the shell and B, the lowest
  h.dispatch({ type: 'restack' });
  assert.equal(calls(h).length, n);
  // A window the user minimized does not count: with B minimized, the shell goes beneath A.
  e.iconic = true;
  h.ffi.windows.get(0xb).iconic = true;
  h.ffi.toTop(OWN);
  h.dispatch({ type: 'restack' });
  assert.equal(stack(), 'A → shell');
  assert.ok(calls(h).slice(n).every((c) => c.hwnd === OWN && c.after === 0xa));
  n = calls(h).length;
  h.dispatch({ type: 'restack' });
  assert.equal(calls(h).length, n, 'already beneath every docked window: nothing written');
});

test('desktop B: activated in split view, the docked window highest in the z-order makes its pane active', () => {
  const h = split('columns', [0xa, 0xb], { zorder: true });
  assert.equal(h.state.active, 1);
  // The user worked in A (it came to the front), then clicked the shell.
  h.ffi.toTop(0xa);
  h.ffi.toTop(OWN);
  h.dispatch({ type: 'focus' });
  assert.equal(h.state.active, 0, 'A was used last');
  assert.equal(dock.view(h.state).selected, 't1');
  assert.equal(calls(h).at(-1)?.hwnd, OWN, 'and the shell went beneath the docked windows');
  // The same in B; a minimized window does not count; 'restack' (no activation) never changes the active pane.
  h.ffi.toTop(0xb);
  h.ffi.toTop(OWN);
  h.dispatch({ type: 'restack' });
  assert.equal(h.state.active, 0, 'restack does not judge the active pane');
  h.ffi.toTop(0xb);
  h.ffi.windows.get(0xb).iconic = true;
  h.ffi.toTop(OWN);
  h.dispatch({ type: 'focus' });
  assert.equal(h.state.active, 0, 'B minimized: A is the highest that counts');
  h.ffi.windows.get(0xb).iconic = false;
  h.ffi.toTop(0xb);
  h.ffi.toTop(OWN);
  h.dispatch({ type: 'focus' });
  assert.equal(h.state.active, 1);
  // A single pane has nothing to choose.
  const s = harness([claude(0xa)], { zorder: true });
  s.add(0xa);
  s.ffi.toTop(OWN);
  s.dispatch({ type: 'focus' });
  assert.equal(s.state.active, 0);
});

test('desktop B: dividers stay within 15–85 % and above the smallest size an app was seen to accept; a layout that cannot fit says so', () => {
  const h = split('columns', [0xa, 0xb]);
  const ratios = () => [h.state.ratios.x, h.state.ratios.y];
  h.dispatch({ type: 'ratios', x: 0.3, y: 0.9 });
  assert.deepEqual(ratios(), [0.3, 0.5], 'two columns: y is ignored');
  assert.deepEqual([0xa, 0xb].map((x) => visible(h.ffi.windows.get(x))), panesOf('columns', { x: 0.3, y: 0.5 }), 'both windows follow the divider');
  h.dispatch({ type: 'ratios', x: 0.01, y: 0.5 });
  assert.equal(h.state.ratios.x, 0.15);
  h.dispatch({ type: 'ratios', x: 7, y: 0.5 });
  assert.equal(h.state.ratios.x, 0.85);
  for (const bad of [{ x: NaN, y: 0.5 }, { x: Infinity, y: 0.5 }, { x: '0.4', y: 0.5 }, { x: 0.4 }]) {
    h.dispatch({ type: 'ratios', ...bad });
    assert.equal(h.state.ratios.x, 0.85, JSON.stringify(bad));
  }
  const s = harness([], { gap: GAP });
  s.dispatch({ type: 'ratios', x: 0.3, y: 0.3 });
  assert.deepEqual(s.state.ratios, { x: 0.5, y: 0.5 }, 'a single pane has no divider');

  // An app that does not shrink below 1600 × 1000 px (visible): seen when it is placed, remembered for this binding.
  const m = harness([claude(0xa, { minWidth: 1600, minHeight: 1000 }), claude(0xb)], { gap: GAP });
  m.add(0xa);
  assert.equal(m.notices.length, 0, 'it fits a single pane');
  m.dispatch({ type: 'layout', layout: 'columns' });
  assert.deepEqual(m.state.tabs[0].binding.min, { width: 1600, height: 0 }, 'seen: it stayed 1600 px wide (its height did fit)');
  assert.match(m.notices.at(-1) ?? '', /^Claude 的窗口缩不到这么小，会盖住旁边一栏。可以拖动分隔线，或换成单栏。$/);
  m.add(0xb);
  m.dispatch({ type: 'ratios', x: 0.3, y: 0.5 });
  assert.equal(m.state.ratios.x, 1600 / (2560 - GAP), 'the left pane is kept as wide as A was seen to be');
  assert.equal(visible(m.ffi.windows.get(0xa))?.width, 1600);
  assert.equal(geometry.paneRects(RECT, 'columns', m.state.ratios, GAP)[0].width, 1600);
  // Grid: A does not fit the top row's height; seen once, then known on the next change, said each time, not twice.
  const said = m.notices.length;
  m.dispatch({ type: 'layout', layout: 'grid' });
  assert.equal(m.notices.length, said + 1);
  assert.match(m.notices.at(-1) ?? '', /或换成两栏。$/);
  m.dispatch({ type: 'layout', layout: 'columns' });
  m.dispatch({ type: 'layout', layout: 'grid' });
  assert.equal(m.notices.length, said + 2, 'the known size: one notice on the change');
  // Not kept: the size seen belongs to that binding only.
  m.dispatch({ type: 'close', id: 't1' });
  m.dispatch({ type: 'layout', layout: 'single' });
  m.add(0xa);
  assert.equal(m.state.tabs.at(-1).binding.min, undefined);
  assert.doesNotMatch(JSON.stringify(dock.savedState(m.state)), /min|1600/);
});

test('desktop A: the state file keeps layout and divider positions, not what the panes held; invalid values give the defaults', () => {
  const h = split('grid', [0xa]);
  h.dispatch({ type: 'ratios', x: 0.3, y: 0.6 });
  const saved = JSON.parse(JSON.stringify(dock.savedState(h.state)));
  assert.deepEqual(saved, { version: 1, layout: 'grid', ratios: { x: 0.3, y: 0.6 }, tabs: [{ app: 'claude', exe: 'Claude.exe', title: 'Claude a' }] });
  const again = dock.initialState(dock.loadTabs(saved), dock.loadLayout(saved));
  assert.deepEqual([again.layout, again.ratios, again.panes, again.active], ['grid', { x: 0.3, y: 0.6 }, [dock.ORRERY, null, null, null], 0],
    'after a restart: the collaboration page in the first pane, the others empty');
  const def = { layout: 'single', ratios: { x: 0.5, y: 0.5 } };
  for (const bad of [null, {}, { version: 2, layout: 'grid' }, { version: 1, layout: 'rows' }, { version: 1, layout: 'constructor' }]) {
    assert.deepEqual(dock.loadLayout(bad).layout, 'single', JSON.stringify(bad));
  }
  for (const ratios of [{ x: 0.1, y: 0.5 }, { x: 0.5, y: 0.9 }, { x: '0.5', y: 0.5 }, { x: null, y: 0.5 }, { x: 0.5 }, 'x', 7]) {
    assert.deepEqual(dock.loadLayout({ version: 1, layout: 'single', ratios }), def, JSON.stringify(ratios));
  }
  assert.deepEqual(dock.loadLayout({ version: 1, layout: 'columns', ratios: { x: 0.15, y: 0.85 } }), { layout: 'columns', ratios: { x: 0.15, y: 0.85 } });
});

test('desktop A: unbound and lost windows get no write in split view, whatever the panes, layout and dividers do', () => {
  // A restarted shell: tabs from the file, all unbound, saved grid layout.
  const r = harness([claude(0xa), claude(0xb)], { gap: GAP, zorder: true });
  r.state = dock.initialState([{ app: 'claude', exe: 'Claude.exe', title: 'Claude a' }, { app: 'claude', exe: 'Claude.exe', title: 'Claude b' }], { layout: 'grid', ratios: { x: 0.5, y: 0.5 } });
  for (const e of [{ type: 'activate', pane: 2 }, { type: 'select', id: 't1' }, { type: 'select', id: dock.ORRERY }, { type: 'ratios', x: 0.3, y: 0.3 },
    { type: 'layout', layout: 'columns' }, { type: 'layout', layout: 'grid' }, { type: 'focus' }, { type: 'restack' }, { type: 'bounds' },
    { type: 'minimize' }, { type: 'restore' }, { type: 'close', id: 't2' }, { type: 'quit' }]) r.dispatch(e);
  assert.deepEqual(calls(r), []);
  // A window lost in one pane: no write to it again; the other pane carries on; the tab stays in its pane, unbound.
  const h = split('columns', [0xa, 0xb]);
  h.ffi.windows.get(0xa).pid = 9999;
  const n = calls(h).length;
  for (const e of [{ type: 'bounds' }, { type: 'ratios', x: 0.4, y: 0.5 }, { type: 'minimize' }, { type: 'restore' }, { type: 'layout', layout: 'grid' }]) h.dispatch(e);
  assert.deepEqual([...new Set(calls(h).slice(n).filter((c) => c.hwnd !== OWN).map((c) => c.hwnd))], [0xb]);
  assert.equal(h.state.tabs[0].binding, null);
  assert.equal(h.state.panes[0], 't1', 'still in its pane, needing a new pick');
  assert.equal(dock.view(h.state).tabs[0].status, 'choose');
});

test('desktop C: split view adds no write: allowed calls, flags and triggers only; a window in no pane gets only its one minimize (and its put-back)', () => {
  const wins = [claude(0xa), claude(0xb, { iconic: true }), claude(0xc, { zoomed: true }), claude(0xd), claude(0xf)];
  const h = harness(wins, { gap: GAP });
  h.below = true;   // every z-order check finds the docked windows under the shell
  const script: Record<string, unknown>[] = [{ type: 'bounds' }, { type: 'focus' }, { type: 'restack' }, { type: 'ratios', x: 0.3, y: 0.7 }, { type: 'minimize' },
    { type: 'bounds' }, { type: 'restore' }, { type: 'restack' }];
  h.add(0xa);
  h.dispatch({ type: 'layout', layout: 'grid' });
  h.add(0xb); h.dispatch({ type: 'activate', pane: 2 }); h.add(0xc); h.dispatch({ type: 'activate', pane: 3 }); h.add(0xd);
  for (const e of script) h.dispatch(e);
  h.dispatch({ type: 'activate', pane: 0 });
  h.add(0xf);                                   // replaces A in pane 0: A minimized once
  for (const e of script) h.dispatch(e);
  h.dispatch({ type: 'layout', layout: 'columns' });   // B (pane 1) kept with F (active)… C, D dropped: minimized once each
  for (const e of script) h.dispatch(e);
  h.dispatch({ type: 'select', id: dock.ORRERY });
  for (const e of script) h.dispatch(e);
  h.dispatch({ type: 'close', id: 't2' });
  h.dispatch({ type: 'quit' });
  const cs = calls(h);
  assert.ok(cs.length >= 40, `recorded ${cs.length} writes`);
  for (const c of cs) {
    if (c.hwnd === OWN) {
      assert.equal(c.fn, 'SetWindowPos');
      assert.equal(c.flags, 0x13);
      assert.ok([0xa, 0xb, 0xc, 0xd, 0xf].includes(c.after ?? -1));
      assert.ok(['add', 'choose', 'select', 'focus', 'restack'].includes(c.tag ?? ''), `lowering the shell on ${c.tag}`);
      continue;
    }
    if (c.fn === 'SetWindowPos') {
      assert.equal(c.after, 0);
      assert.equal(c.flags, 0x214, 'SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER');
    } else if (c.fn === 'ShowWindow') {
      assert.ok([7, 9].includes(c.cmd ?? -1));
      if (c.cmd === 9) assert.ok(['add', 'choose', 'select', 'restore'].includes(c.tag ?? ''), `SW_RESTORE on ${c.tag}`);
    } else if (c.fn === 'SetForegroundWindow') {
      assert.ok(['add', 'choose', 'select'].includes(c.tag ?? ''), `SetForegroundWindow on ${c.tag}`);
    } else if (c.fn === 'SetWindowPlacement') {
      assert.ok(['close', 'quit'].includes(c.tag ?? ''));
    } else assert.fail(`unexpected write ${c.fn}`);
  }
  assert.deepEqual([...new Set(cs.filter((c) => ['ratios', 'layout'].includes(c.tag ?? '')).map((c) => `${c.fn}${c.cmd ? `(${c.cmd})` : ''}`))].sort(),
    ['SetWindowPos', 'ShowWindow(7)'], 'divider and layout changes: placing and minimizing only');
  // Windows out of every pane: from the moment they left, one minimize and then only their put-back.
  const left = (hwnd: number, tag: string) => {
    const i = cs.findIndex((c) => c.hwnd === hwnd && c.fn === 'ShowWindow' && c.cmd === 7 && c.tag === tag);
    assert.ok(i >= 0, `0x${hwnd.toString(16)} minimized on ${tag}`);
    assert.deepEqual(cs.slice(i + 1).filter((c) => c.hwnd === hwnd).map((c) => c.fn), ['SetWindowPlacement'], `0x${hwnd.toString(16)}: nothing but the put-back`);
  };
  left(0xa, 'add');
  left(0xc, 'layout');
  left(0xd, 'layout');
  assert.deepEqual(cs.filter((c) => c.fn === 'SetForegroundWindow').map((c) => c.hwnd), [0xa, 0xb, 0xc, 0xd, 0xf], 'only for a window just picked or clicked');
  assert.deepEqual(h.ffi.unknown, []);
});

// --- review desktop-split r1 --------------------------------------------------------------------------------------

test('desktop B: another pane\'s window that is no longer the bound one counts as a third window: not lowered beneath, not the active pane', () => {
  for (const [what, change] of [['pid', { pid: 9999 }], ['owner', { owner: 0x77 }]] as [string, Record<string, unknown>][]) {
    const h = split('columns', [0xa, 0xb], { zorder: true });
    const name = (x: number) => (x === OWN ? 'shell' : x === 0xa ? 'A' : 'B');
    const stack = () => h.ffi.enumWindows().map(name).join(' → ');
    h.dispatch({ type: 'activate', pane: 0 });   // A active
    // B (right pane) changes identity, but no write has found that out yet; it is visible over the dock area.
    Object.assign(h.ffi.windows.get(0xb), change);
    h.ffi.toTop(0xa);
    h.ffi.toTop(0xb);
    h.ffi.toTop(OWN);
    assert.equal(stack(), 'shell → B → A', what);
    const n = calls(h).length;
    h.dispatch({ type: 'restack' });
    assert.deepEqual(calls(h).slice(n), [], `${what}: B sits between the shell and A, so the shell is not lowered beneath A`);
    assert.equal(stack(), 'shell → B → A', what);
    assert.equal(h.state.tabs[1].binding, null, `${what}: B is unbound (needs a new pick)`);
    assert.equal(h.state.panes[1], 't2', `${what}: and stays in its pane`);
    assert.match(h.notices.at(-1) ?? '', /需要重新选择/);
    // Activation: B on top does not make its pane active; A, the valid one, is still the reference.
    const g = split('columns', [0xa, 0xb], { zorder: true });
    g.dispatch({ type: 'activate', pane: 0 });
    Object.assign(g.ffi.windows.get(0xb), change);
    g.ffi.toTop(0xa);
    g.ffi.toTop(0xb);
    g.ffi.toTop(OWN);
    const m = calls(g).length;
    g.dispatch({ type: 'focus' });
    assert.equal(g.state.active, 0, `${what}: the stale B does not decide the active pane`);
    assert.deepEqual(calls(g).slice(m), [], `${what}: and the shell stays in front of B`);
    assert.equal(g.state.tabs[1].binding, null);
  }
});
