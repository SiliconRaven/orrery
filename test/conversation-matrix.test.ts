// The 全部对话 matrix (src/web/public/conversation-matrix.js): conversations × clusters as a pure model, the view
// switch, and the coordinators the page marks (from /api/state and coordinator.set events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { REPO_ROOT } from '../src/main.ts';
import { startTestHub } from './helpers.ts';

const cm = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/conversation-matrix.js')).href);

const at = (h: number) => `2026-11-15T${String(h).padStart(2, '0')}:00:00.000Z`;
const cluster = (id: string, hour: number, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), createdAt: at(hour), lastMessageAt: at(hour), category: '', pinnedAt: null, archivedAt: null, ...extra });
const member = (id: string, clusterId: string, extra: Record<string, unknown> = {}) => ({ id, clusterId, name: id, harness: 'claude', workerSessionId: `s-${id}`, removedAt: null, ...extra });

function fixture() {
  const clusters = [
    cluster('a', 5, { category: 'front' }), cluster('b', 4, { category: 'back' }), cluster('c', 3, { category: 'front' }),
    cluster('p', 1, { pinnedAt: at(1), category: 'back' }), cluster('loose', 2), cluster('old', 6, { archivedAt: at(6), category: 'front' }),
  ];
  const members = [
    // One Claude conversation in three clusters, with a different name in each.
    member('rev-a', 'a', { name: '评审', workerSessionId: 'S1' }), member('rev-b', 'b', { name: 'reviewer', workerSessionId: 'S1' }),
    member('rev-p', 'p', { name: '评审', workerSessionId: 'S1' }),
    // The same session id in another app is another conversation.
    member('cx', 'a', { harness: 'codex', workerSessionId: 'S1', name: 'codex-1' }),
    member('cx2', 'c', { harness: 'codex', workerSessionId: 'S2', name: 'codex-2' }),
    // Two conversations of an app the page does not know, under its own name.
    member('iso1', 'a', { harness: 'mock', workerSessionId: 'X1', name: 'iso' }),
    member('iso2', 'b', { harness: 'mock', workerSessionId: 'X2', name: 'iso' }),
    member('gone', 'a', { removedAt: at(7), workerSessionId: 'S9', name: 'gone' }),
    member('arch', 'old', { workerSessionId: 'S7', name: 'archived-only' }),
    member('stray', 'deleted-cluster', { workerSessionId: 'S8', name: 'stray' }),
    member('kimi', 'loose', { harness: 'kimi', workerSessionId: 'K1', name: 'kimi' }),
  ];
  const status: Record<string, string> = { 'rev-a': 'idle', 'rev-b': 'busy', 'rev-p': 'idle', cx: 'offline', cx2: 'offline', iso1: 'idle', iso2: 'offline', arch: 'idle', kimi: 'offline' };
  const activity: Record<string, string> = { 'rev-a': at(8), 'rev-b': at(9), cx: 'garbage' };
  return {
    clusters, members,
    args: (extra = {}) => ({ members, clusters, groups: ['back', 'front'], coordinators: { a: 'rev-a', b: 'iso2' },
      statusOf: (m: any) => status[m.id], activityAt: (m: any) => activity[m.id] ?? null, ...extra }),
  };
}

test('conversation matrix: one row per conversation, by app; removed, foreign and archived-only memberships absent', () => {
  const f = fixture();
  const model = cm.conversationMatrix(f.args());
  assert.deepEqual(model.rowGroups.map((g: any) => [g.label, g.rows.map((r: any) => r.label)]), [
    ['Claude', ['评审 / reviewer']], ['ChatGPT / Codex', ['codex-1', 'codex-2']], ['Kimi Code', ['kimi']], ['mock', ['iso', 'iso']],
  ], 'apps by harness id A–Z under their app names; the archived-only conversation and the removed member are absent');
  assert.deepEqual(model.rowGroups.map((g: any) => [g.harness, g.icon]), [
    ['claude', '/app-icons/claude.ico'], ['codex', '/app-icons/codex.png'], ['kimi', '/app-icons/kimi-code.png'], ['mock', null],
  ], 'each app group carries its icon');
  assert.equal(model.rowCount, 6);
  const rev = model.rowGroups[0].rows[0];
  assert.deepEqual(Object.keys(rev.cells).sort(), ['a', 'b', 'p'], 'the same session in three clusters is one row');
  assert.deepEqual(rev.cells.b, { memberId: 'rev-b', clusterId: 'b', name: 'reviewer', status: 'busy', coordinator: false });
  assert.equal(rev.cells.a.coordinator, true, 'the coordinator of a is marked there');
  assert.equal(rev.status, 'busy', 'busy if any membership is');
  assert.equal(rev.lastActivityAt, at(9), 'the newest activity of its memberships');
  assert.equal(model.rowGroups[1].rows[0].lastActivityAt, null, 'an unreadable time is no time');
  assert.equal(model.rowGroups[3].rows[1].cells.b.coordinator, true, 'a coordinator in another app too');
  assert.deepEqual(model.rowGroups[3].rows.map((r: any) => r.status), ['idle', 'offline'], 'online before offline inside a group');
  assert.equal(cm.conversationKey(f.members[0]), cm.conversationKey(f.members[1]));
  assert.notEqual(cm.conversationKey(f.members[0]), cm.conversationKey(f.members[3]), 'another app');
  assert.notEqual(cm.conversationKey(f.members[5]), cm.conversationKey(f.members[6]), 'two sessions are two rows');
  assert.notEqual(cm.conversationKey(member('n1', 'a', { workerSessionId: '' })), cm.conversationKey(member('n2', 'b', { workerSessionId: '' })), 'no session id yet: its own row');
});

test('conversation matrix: columns follow the sidebar: pinned, the Hub group order, ungrouped; archived only on request; counts', () => {
  const f = fixture();
  const model = cm.conversationMatrix(f.args());
  assert.deepEqual(model.columnGroups.map((g: any) => [g.name, g.columns.map((c: any) => c.id)]), [
    ['置顶', ['p']], ['back', ['b']], ['front', ['a', 'c']], ['未分组', ['loose']],
  ], 'newest activity first inside a group, as in the sidebar');
  assert.equal(model.hiddenArchived, 1);
  const a = model.columns.find((c: any) => c.id === 'a');
  assert.deepEqual([a.memberCount, a.onlineCount], [3, 2], 'active members only; online = not offline');
  const shown = cm.conversationMatrix(f.args({ showArchived: true }));
  assert.deepEqual(shown.columnGroups.at(-1), { name: '已归档', columns: [{ id: 'old', name: 'OLD', group: '已归档', archived: true, memberCount: 1, onlineCount: 1 }] });
  assert.equal(shown.hiddenArchived, 0);
  assert.equal(shown.rowCount, 7, 'the archived-only conversation appears with its cluster');
  const empty = cm.conversationMatrix(f.args({ members: [] }));
  assert.deepEqual([empty.rowCount, empty.columns.length], [0, 5], 'clusters without members: columns, no rows');
  assert.deepEqual(cm.conversationMatrix(f.args({ members: [], clusters: [] })).columns, []);
  const sameName = cm.conversationMatrix(f.args({ clusters: [cluster('x', 1, { category: '置顶' }), cluster('y', 2, { pinnedAt: at(2) })], members: [] }));
  assert.deepEqual(sameName.columnGroups.map((g: any) => g.columns.map((c: any) => c.id)), [['y'], ['x']], 'a group named like a section stays apart');
});

test('conversation matrix: view choice from storage; the page draws it and keeps coordinators from the snapshot and events', () => {
  assert.equal(cm.viewFromStored('matrix'), 'matrix');
  for (const v of [null, '', 'list', 'grid']) assert.equal(cm.viewFromStored(v), 'list', String(v));
  assert.equal(cm.CONVERSATIONS_VIEW_KEY, 'orrery.conversationsView');
  assert.deepEqual(cm.STATUS_WORD, { busy: '忙', idle: '在线', offline: '离线' });

  const app = readFileSync(join(REPO_ROOT, 'src/web/public/app.js'), 'utf8');
  const html = readFileSync(join(REPO_ROOT, 'src/web/public/index.html'), 'utf8');
  for (const id of ['conversations-list-view', 'conversations-matrix-view', 'matrix-archived', 'matrix-narrow-hint']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(app, /try \{ return viewFromStored\(localStorage\.getItem\(CONVERSATIONS_VIEW_KEY\)\); \} catch \{ return 'list'; \}/);
  assert.match(app, /try \{ localStorage\.setItem\(CONVERSATIONS_VIEW_KEY, conversationsView\); \} catch/);
  assert.match(app, /onclick: \(\) => select\(c\.id, cell\.memberId\)/, 'a cell opens the member page');
  assert.match(app, /onclick: \(\) => select\(c\.id\) \}/, 'a column header opens the cluster');
  assert.doesNotMatch(app.slice(app.indexOf('function renderMatrix()'), app.indexOf('function buildMessage(')), /setInterval|api\(|fetch\(/, 'no polling, no requests');

  const start = app.indexOf('const coordinatorSeq = new Map();');
  const end = app.indexOf('\nlet syncs = 0;', start);
  const S = { coordinators: new Map([['c1', 'm1']]) };
  const ctx: any = { S };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.apply = applyCoordinator; globalThis.seqs = coordinatorSeq;`, ctx);
  ctx.apply('c1', { action: 'coordinator.set', memberId: 'm2', enabled: true, mode: 'suggest' }, 5);
  assert.equal(S.coordinators.get('c1'), 'm2');
  ctx.apply('c1', { action: 'coordinator.set', memberId: 'm3', enabled: true, suggested: true }, 6);
  assert.equal(S.coordinators.get('c1'), 'm2', 'a suggestion changes nothing');
  ctx.apply('c1', { action: 'coordinator.set', memberId: 'm2', enabled: false, mode: 'suggest' }, 7);
  assert.equal(S.coordinators.has('c1'), false, 'disabled');
  ctx.apply('c2', { action: 'coordinator.set' }, 8);
  assert.equal(S.coordinators.has('c2'), false, 'cleared');
  ctx.apply('c3', { action: 'task.create', memberId: 'x' }, 9);
  assert.equal(ctx.seqs.has('c3'), false, 'other actions are ignored');
  assert.match(app, /for \(const \[cid, seq\] of coordinatorSeq\) if \(seq > st\.seq\)/, 'a newer event wins over an older snapshot');
});

test('conversation matrix: /api/state lists each cluster\'s enabled coordinator, and only that', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a] } = await app.cluster('coord', ['A', 'B']);
    const { cluster: other } = await app.cluster('none', ['C']);
    assert.deepEqual((await app.api('GET', '/api/state')).coordinators, {});
    const set = (enabled: boolean, op: string) => app.api('POST', `/api/clusters/${cluster.id}/collaboration`, { action: 'coordinator.set', operationId: op, memberId: a.id, enabled, mode: 'suggest' });
    await set(true, 'on');
    assert.deepEqual((await app.api('GET', '/api/state')).coordinators, { [cluster.id]: a.id });
    const event = app.events.filter((e) => e.kind === 'collaboration').at(-1)! as any;
    assert.deepEqual([event.payload.action, event.payload.memberId, event.payload.enabled], ['coordinator.set', a.id, true], 'the event the page follows');
    await set(false, 'off');
    assert.deepEqual((await app.api('GET', '/api/state')).coordinators, {}, 'a disabled coordinator is not marked');
    assert.ok(other.id);
  } finally { await app.close(); }
});

test('conversation matrix: app names are the desktop shell\'s, icons are each app\'s own in app-icons; an unknown harness keeps its id', async () => {
  const { APPS } = await import(pathToFileURL(join(REPO_ROOT, 'desktop/lib/apps.mjs')).href);
  const { nativeFactories } = await import('../src/adapters/index.ts');
  const desktopId = (harness: string) => harness === 'kimi' ? 'kimi-code' : harness;
  for (const harness of Object.keys(nativeFactories)) {
    const app = cm.harnessApp(harness);
    assert.equal(app.name, APPS.find((a: any) => a.id === desktopId(harness))?.name, `${harness}: the name the tab strip uses`);
    assert.match(app.icon, new RegExp(`^/app-icons/${desktopId(harness)}\\.(png|ico)$`), `${harness}: its own icon, named by the desktop app id`);
    assert.ok(existsSync(join(REPO_ROOT, 'src/web/public', app.icon)), `${harness}: ${app.icon} is under src/web/public/app-icons`);
  }
  for (const a of APPS) assert.ok(Object.keys(nativeFactories).some((h) => desktopId(h) === a.id), `${a.id}: a desktop app the Hub supports`);
  assert.deepEqual(cm.harnessApp('mock'), { name: 'mock', icon: null }, 'unknown: the id as text, the page draws a neutral badge');
  assert.deepEqual(cm.harnessApp(undefined), { name: '', icon: null });
  assert.deepEqual(cm.harnessApp('toString'), { name: 'toString', icon: null }, 'no prototype names');
  const app = readFileSync(join(REPO_ROOT, 'src/web/public/app.js'), 'utf8');
  assert.match(app, /h\('span', \{ class: 'matrix-row-group-name' \}, appIcon\(g\),/, 'the group header draws the icon before the name');
});

test('conversation matrix: the web server serves the app icons with their image types', async () => {
  const app = await startTestHub();
  try {
    for (const [file, type] of [['claude.ico', 'image/x-icon'], ['codex.png', 'image/png'], ['kimi-code.png', 'image/png'], ['cursor.ico', 'image/x-icon']]) {
      const res = await fetch(`${app.url}/app-icons/${file}`);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers.get('content-type'), type, file);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(join(REPO_ROOT, 'src/web/public/app-icons', file)), `${file}: the file as it is`);
    }
  } finally { await app.close(); }
});

/** A scroll box as a browser has it: removing its content clamps the scroll position to the (now empty) extent. */
class FakeBox {
  scrollLeft = 0; scrollTop = 0; children: unknown[] = [];
  classList = { contains: (c: string) => c === 'matrix-scroll' };
  replaceChildren(...items: unknown[]) { this.children = items; if (!items.length) { this.scrollLeft = 0; this.scrollTop = 0; } }
}
class FakeHost {
  children: unknown[] = [];
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] ?? null; }
  replaceChildren(...items: unknown[]) { this.children = items; }
}

test('conversation matrix: a redraw keeps the same scroll box and where it was scrolled to', () => {
  const host = new FakeHost();
  let made = 0;
  const make = () => { made++; return new FakeBox(); };
  const box = cm.mountKeepingScroll(host, make, 'table 1');
  assert.deepEqual([made, host.children, box.children], [1, [box], ['table 1']]);
  box.scrollLeft = 180; box.scrollTop = 350;   // the user scrolled
  // A member turns busy, then back online: the model changes and the matrix is drawn again.
  for (const table of ['table 2 (busy)', 'table 3 (online)']) {
    const again = cm.mountKeepingScroll(host, make, table);
    assert.equal(again, box, 'the same box, not a new one at 0,0');
    assert.deepEqual([again.scrollLeft, again.scrollTop, again.children], [180, 350, [table]]);
  }
  assert.equal(made, 1);
  // After the list or an empty state was shown, the matrix starts in a new box.
  host.replaceChildren('the list');
  const fresh = cm.mountKeepingScroll(host, make, 'table 4');
  assert.notEqual(fresh, box);
  assert.deepEqual([fresh.scrollLeft, fresh.scrollTop, made], [0, 0, 2]);
  // A box whose content is swapped in a way that clamps (worst case) still ends where it was.
  const clamping = new FakeBox();
  clamping.replaceChildren = function (...items: unknown[]) { this.children = items; this.scrollLeft = 0; this.scrollTop = 0; };
  host.replaceChildren(clamping);
  clamping.scrollLeft = 40; clamping.scrollTop = 90;
  cm.mountKeepingScroll(host, make, 'table 5');
  assert.deepEqual([clamping.scrollLeft, clamping.scrollTop], [40, 90]);
  const app = readFileSync(join(REPO_ROOT, 'src/web/public/app.js'), 'utf8');
  const matrix = app.slice(app.indexOf('function renderMatrix()'), app.indexOf('function buildMessage('));
  assert.match(matrix, /mountKeepingScroll\(list, \(\) => h\('div', \{ class: 'matrix-scroll'/, 'the page draws the table through it');
  assert.doesNotMatch(matrix, /list\.replaceChildren\(h\('div', \{ class: 'matrix-scroll'/);
});
