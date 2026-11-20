// Pure helpers in src/web/public/ui.js (create dialog, member page; docs/native-mode.md「网页（单元 4）」), run in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext as runVm } from 'node:vm';
import { REPO_ROOT } from '../src/main.ts';
import { t, language } from '../shared/i18n/index.js';
import './plugin-host-hook.ts';

// Extracted browser functions close over the same real translations as their module imports.
const runInNewContext = (code: string, context: Record<string, any>) =>
  runVm('(function(t, language) {\n' + code + '\n})(uiTranslation.t, uiTranslation.language);', Object.assign(context, { uiTranslation: { t, language } }));

// A browser module without types: a computed specifier keeps tsc from looking for declarations.
const ui = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js')).href);
const bookmarks = await import(pathToFileURL(join(REPO_ROOT, 'src/plugins/bookmarks/package/web/index.js')).href);
const { createUsageRenderer } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/usage-view.js')).href);

const base = { harness: 'codex', nativeCreate: true, project: '', sessions: [] as { sessionId: string; name?: string; avatar?: string }[], create: false, name: '', avatar: '', model: '', effort: '' };

test('turn usage refreshes sender names after rename while retaining message targets', (t) => {
  const previous = (globalThis as any).document;
  (globalThis as any).document = { createElement: (tag: string) => ({ tag, props: {} as Record<string, any>, children: [] as any[],
    setAttribute(k: string, v: string) { this.props[k] = v; }, addEventListener(k: string, fn: unknown) { this.props['on' + k] = fn; },
    append(...children: any[]) { this.children.push(...children); } }) };
  t.after(() => { (globalThis as any).document = previous; });
  const state = { identity: 1, turnUsageError: false, turnUsage: { memberId: 'recipient', tokens: 10, turns: 1, average: 10,
    short: { turns: 1, tokens: 10 }, work: { turns: 0, tokens: 0 }, expensive: [{ at: '2026-11-16T09:00:00Z', tokens: 10,
      messages: [{ from: 'sender', kind: 'chat', excerpt: 'hello', messageId: 'msg-1' }] }] } };
  let name = 'Sender', rendered: any[] = [], target: string[] = [];
  const usage = createUsageRenderer({ element: () => ({ replaceChildren: (...nodes: any[]) => { rendered = nodes; } }),
    nameOf: () => name, showMessage: (...args: string[]) => { target = args; } });
  const member = { id: 'recipient', clusterId: 'cluster' };
  const buttons = (node: any): any[] => [node, ...(node.children ?? []).flatMap(buttons)].filter((x) => x?.tag === 'button');
  usage.renderTurns(member, { data: state.turnUsage, identity: state.identity, error: state.turnUsageError });
  assert.match(JSON.stringify(rendered), /Sender/);
  name = 'Renamed'; state.identity++;
  usage.renderTurns(member, { data: state.turnUsage, identity: state.identity, error: state.turnUsageError });
  assert.match(JSON.stringify(rendered), /Renamed/);
  assert.doesNotMatch(JSON.stringify(rendered), /Sender/);
  buttons(rendered[0])[0].props.onclick();
  assert.deepEqual(target, ['cluster', 'msg-1']);
});

test('tool versions distinguish unknown, old, matching and stale claims', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const current = `sha256:${'a'.repeat(64)}`;
  const report = { hub: { standard: current }, members: [{ memberId: 'm', profile: 'standard', observation: {
    lastCallAt: new Date(now).toISOString(), staleAfterMs: 1000, client: null,
    bridge: { profile: 'standard', fingerprint: `sha256:${'b'.repeat(64)}` },
  } }] };
  let view = ui.toolVersionView(report, 'm', 'claude', now);
  assert.equal(view.client.state, 'unknown');
  assert.equal(view.bridge.state, 'different');
  assert.match(view.advice, /重连 MCP/);
  assert.match(ui.toolVersionView(report, 'm', 'antigravity', now).advice, /MCP Servers 设置里刷新 orrery/);
  assert.match(ui.toolVersionView(report, 'm', 'workbuddy', now).advice, /WorkBuddy 的 MCP 设置里重连 orrery/);
  report.members[0].observation.bridge.fingerprint = current;
  view = ui.toolVersionView(report, 'm', 'claude', now);
  assert.equal(view.bridge.state, 'match');
  assert.equal(view.advice, null);
  assert.equal(ui.toolVersionView(report, 'm', 'claude', now + 1001).bridge.state, 'unknown');
  assert.equal(ui.toolVersionView(null, 'm', 'codex', now).hub, '未知');
});

test('tool version details stay open across minute refreshes and changed observations', (t) => {
  let now = 59_999, draws = 0;
  let child: any = null;
  const box = { querySelector: () => child, replaceChildren: (next: any) => { child = next; draws++; } };
  t.mock.method(Date, 'now', () => now);
  const usage = createUsageRenderer({ element: () => box });
  const build = () => ({ tagName: 'DETAILS', open: false });
  usage.draw('member-tool-versions', ['v1'], build, { perMinute: false, preserveOpen: true });
  child.open = true;
  now = 60_001;
  usage.draw('member-tool-versions', ['v1'], build, { perMinute: false, preserveOpen: true });
  assert.equal(draws, 1);
  assert.equal(child.open, true);
  usage.draw('member-tool-versions', ['v2'], build, { perMinute: false, preserveOpen: true });
  assert.equal(draws, 2);
  assert.equal(child.open, true);
});

test('sidebar sections are exclusive, ordered, and hide empty special sections', () => {
  const clusters = [
    { id: 'a', category: '', lastMessageAt: '2026-01-01', pinnedAt: null, archivedAt: null },
    { id: 'b', category: '工作', lastMessageAt: '2026-01-03', pinnedAt: 'p', archivedAt: null },
    { id: 'c', category: '工作', lastMessageAt: '2026-01-02', pinnedAt: null, archivedAt: null },
    { id: 'd', category: '归档', lastMessageAt: '2026-01-04', pinnedAt: 'old', archivedAt: 'a' },
  ];
  const sections = ui.sidebarSections(clusters);
  assert.deepEqual(sections.pinned.map((c: any) => c.id), ['b']);
  assert.deepEqual(sections.groups.map((g: any) => [g.name, g.clusters.map((c: any) => c.id)]), [['工作', ['c']], ['', ['a']]]);
  assert.deepEqual(sections.archived.map((c: any) => c.id), ['d']);
  assert.equal(new Set([...sections.pinned, ...sections.groups.flatMap((g: any) => g.clusters), ...sections.archived].map((c: any) => c.id)).size, 4);
  assert.deepEqual(ui.sidebarSections([]), { pinned: [], groups: [], archived: [] });
});

test('sidebar unread counts only non-user messages after a known position and caps its label', () => {
  const messages = [{ id: '1', from: 'user' }, { id: '2', from: 'agent' }, { id: '3', from: 'system' }, { id: '4', from: 'user' }];
  assert.equal(ui.clusterUnread(messages, null), 2);
  assert.equal(ui.clusterUnread(messages, '2'), 1);
  assert.equal(ui.clusterUnread(messages, 'missing'), 0, 'an incomplete replay is not guessed');
  assert.equal(ui.unreadLabel(0), '');
  assert.equal(ui.unreadLabel(99), '99');
  assert.equal(ui.unreadLabel(100), '99+');
});

test('cluster rename validation matches the Hub’s Unicode and path rules', () => {
  assert.deepEqual(ui.clusterNameInput('  群聊  '), { name: '群聊' });
  assert.deepEqual(ui.clusterNameInput('😀'.repeat(60)), { name: '😀'.repeat(60) });
  for (const value of ['', '  ', '.hidden', '😀'.repeat(61), 'a/b', 'a\\b', 'a:b', 'a\n', 'a\u2028b']) {
    assert.ok(ui.clusterNameInput(value).error, value);
  }
});

test('chat prompts describe unaddressed coordinator delivery without implying a broadcast', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  assert.match(app, /还没有消息。用 @名字 或 @all 选择接收成员。/);
  assert.doesNotMatch(app, /不带 @ 的消息会发给所有群员/);
  assert.match(html, /未点名时启用的协调员会收到，否则留在群聊记录里/);
});

test('sidebar read advancement waits for replay, stops after failure, and rechecks the selected group', async () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('const readRequests = new Map();');
  const end = app.indexOf("\n\nwindow.addEventListener('hashchange'", start);
  assert.ok(start >= 0 && end > start);
  let now = 10_000;
  const timers: { fn: () => void; delay: number }[] = [];
  const calls: { path: string; messageId: string }[] = [];
  const pending: PromiseWithResolvers<unknown>[] = [];
  const state: any = { sel: { cluster: 'a', overview: false }, lastSeq: 4,
    clusters: new Map([['a', { id: 'a', userReadMessageId: null }], ['b', { id: 'b', userReadMessageId: null }]]),
    clusterMsgs: new Map([['a', ['m1']], ['b', ['n1']]]),
    messages: new Map([['m1', { id: 'm1', from: 'agent' }], ['n1', { id: 'n1', from: 'agent' }]]) };
  const doc = { visibilityState: 'visible', hasFocus: () => true };
  const windows = new Map<string, any>([['a', { live: true, pending: null }], ['b', { live: true, pending: null }]]);
  const appClasses = new Set<string>();   // #app: 'view-open' while a full-page plugin view covers the chat
  const appEl = { classList: { contains: (c: string) => appClasses.has(c) } };
  const context: any = { S: state, clusterSnapshotSeq: 5, chatWindows: windows, unread: new Map(), document: doc,
    $: (id: string) => (id === 'app' ? appEl : assert.fail(`unexpected $(${id})`)),
    Date: { now: () => now }, setTimeout: (fn: () => void, delay: number) => (timers.push({ fn, delay }), timers.length),
    api: (_method: string, path: string, body: { messageId: string }) => {
      calls.push({ path, messageId: body.messageId });
      const gate = Promise.withResolvers<unknown>(); pending.push(gate); return gate.promise;
    } };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.read = { scheduleSelectedRead, allowRead };`, context);
  context.read.scheduleSelectedRead();
  assert.equal(calls.length, 0, 'do not advance while replay is incomplete');
  state.lastSeq = 5;
  doc.visibilityState = 'hidden'; context.read.scheduleSelectedRead();
  assert.equal(calls.length, 0, 'hidden pages do not advance');
  doc.visibilityState = 'visible'; context.read.scheduleSelectedRead();
  assert.deepEqual(calls[0], { path: '/api/clusters/a/read', messageId: 'm1' });
  pending[0].reject(new Error('offline'));
  await new Promise((resolve) => setImmediate(resolve));
  now += 5000; context.read.scheduleSelectedRead();
  assert.equal(calls.length, 1, 'failure does not schedule periodic retries');
  context.read.allowRead('a'); context.read.scheduleSelectedRead();
  assert.equal(calls.length, 2);
  state.clusterMsgs.get('a').push('m2'); state.messages.set('m2', { id: 'm2', from: 'agent' });
  context.read.allowRead('a');
  pending[1].reject(new Error('offline again'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1, 'a new message during the request permits one throttled retry');
  assert.equal(timers[0].delay, 2000);
  state.sel.cluster = 'b'; now += 2000; timers[0].fn();
  assert.deepEqual(calls[2], { path: '/api/clusters/b/read', messageId: 'n1' }, 'a stale timer cannot advance the old group');
  pending[2].resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  // Only a window that ends at the newest message reads; the old read position need not be loaded.
  state.clusters.get('b').userReadMessageId = 'not-loaded';
  state.clusterMsgs.get('b').push('n2'); state.messages.set('n2', { id: 'n2', from: 'agent' });
  windows.get('b').live = false;
  now += 5000; context.read.scheduleSelectedRead();
  assert.equal(calls.length, 3, 'an older window shown: nothing is read');
  windows.get('b').live = true; windows.get('b').pending = [];
  context.read.scheduleSelectedRead();
  assert.equal(calls.length, 3, 'nor while its newest messages are being read');
  windows.get('b').pending = null;
  context.read.scheduleSelectedRead();
  assert.deepEqual(calls[3], { path: '/api/clusters/b/read', messageId: 'n2' }, 'the read position is not in the window: still advanced');
  pending[3].resolve({});
  await new Promise((resolve) => setImmediate(resolve));

  // A full-page plugin view covers the chat: a message arriving meanwhile stays unread, a delayed receipt included.
  appClasses.add('view-open');
  state.clusterMsgs.get('b').push('n3'); state.messages.set('n3', { id: 'n3', from: 'agent' });
  context.read.scheduleSelectedRead();
  assert.equal(calls.length, 4, 'nothing is read while a view covers the chat');
  appClasses.delete('view-open');
  context.read.scheduleSelectedRead();   // n2 was sent just now: this receipt is delayed
  assert.equal(calls.length, 4);
  const delayed = timers.at(-1)!;
  appClasses.add('view-open');   // a view opens before the delayed receipt fires
  now += 2000; delayed.fn();
  assert.equal(calls.length, 4, 'a delayed receipt does not read under a view either');
  // Back in the chat (closing the view redraws, which schedules again): read as before.
  appClasses.delete('view-open');
  context.read.scheduleSelectedRead();
  assert.deepEqual(calls[4], { path: '/api/clusters/b/read', messageId: 'n3' });
  pending[4].resolve({});
  await new Promise((resolve) => setImmediate(resolve));
});

/**
 * The page's state code (setDelivery … applyEvent) in a VM, with what it calls from elsewhere stubbed: S, the clusters
 * and members as plain upserts, and an /api/state answer to give syncPaused. With `windows`, the window loaders too
 * (loadLatest … openMessage), their message requests held in `gates` until the test answers them.
 */
/** The jump helpers app.js takes from ui.js, for harnesses that run slices of app.js. */
const JUMP_HELPERS = { nextJump: ui.nextJump, jumpCurrent: ui.jumpCurrent, jumpPending: ui.jumpPending, jumpExceptionId: ui.jumpExceptionId };

function stateCode(snapshot: any = null, { windows = false, metadata = false, page = 200 } = {}) {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('function setDelivery(');
  const end = app.indexOf('\n// ---- quota and token counts', start);
  assert.ok(start >= 0 && end > start);
  const loaderStart = app.indexOf("// ---- loading a cluster's messages");
  const loaderEnd = app.indexOf('// ---- one message the page may not hold', loaderStart);
  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
  const gates: { path: string; open: (data: unknown[], seq: number) => void }[] = [];
  const state: any = { lastSeq: 0, sel: { cluster: null, member: null }, messages: new Map(), clusterMsgs: new Map(), clusters: new Map(),
    members: new Map(), handoffs: new Set(), running: new Map(), settings: null };
  const timers: (() => void)[] = [];
  const queued: string[] = [];
  const context: any = { ...JUMP_HELPERS, S: state, render() {}, replayComplete: () => true, loadUsageSoon() {}, pushMemberEvent() {}, allowRead() {}, hiddenWarningArrived() {},
    loadProblemsSoon() {}, withLastMessage: ui.withLastMessage, clusterUnread: ui.clusterUnread, clusterSnapshotSeq: -1, clusterVersions: new Map(),
    clusterSnapshotIds: new Set(), upsertCluster: (c: any) => state.clusters.set(c.id, { ...state.clusters.get(c.id), ...c }),
    upsertMember: (m: any) => state.members.set(m.id, m), workbench: { removed() {}, clustersChanged() {}, changed() {} }, stalled: { changed() {} },
    taskRefs: { changed() {} }, taskCandidates: { reset() {} }, queueMessageMetadata: (_c: string, id: string) => queued.push(id),
    select() {}, activityScope: null, pluginSlots: { message: [{ update: (msg: any, data: any) => { msg.bookmarks = data.bookmarks ?? []; } }] }, setTimeout: (fn: () => void) => timers.push(fn), clearTimeout() {},
    api: async (_method: string, path: string) => path.startsWith('/api/state') ? snapshot
      : new Promise((resolve) => gates.push({ path, open: (data, at) => resolve({ data, seq: at }) })),
    $: () => ({ addEventListener() {}, classList: { toggle() {} } }), setText() {}, noticeDialog() {},
    msgEls: new Map(), attachEls: new Map(), messageDiffViews: new Map(), receiptTimelines: new Map(), messageMetadata: new Map(),
    openReceipts: new Set(), openTaskLinks: new Set(), refMessages: new Map() };
  const metaStart = app.indexOf('const messageMetadata = new Map()');
  const metaEnd = app.indexOf('// ---- remembered UI choices', metaStart);
  assert.ok(metaStart >= 0 && metaEnd > metaStart);
  if (metadata) delete context.queueMessageMetadata;   // the real one, below
  const meta = metadata ? `${app.slice(metaStart, metaEnd)}\nObject.assign(globalThis.t, { pumpMessageMetadata, messageMetadata });` : '';
  const loaders = windows ? `${app.slice(loaderStart, loaderEnd)}\nObject.assign(globalThis.t, { loadLatest, loadOlder, loadNewer, openMessage, forgetWindow });` : '';
  const stateSource = app.slice(start, end).replace('const PAGE = 200;', `const PAGE = ${page};`);
  runInNewContext(`${stateSource}\nglobalThis.t = { applyEvent, syncPaused, setDelivery, addMessage, fillMessages, chatWindows, unread, unreadOf: (c) => unread.get(c)?.count ?? 0 };\n${loaders}\n${meta}`, context);
  let seq = 0;
  const send = (kind: string, payload: any, clusterId: string | null = 'a', memberId: string | null = null) =>
    context.t.applyEvent({ seq: ++seq, kind, payload, memberId, clusterId, createdAt: '2026-01-01T00:00:00.000Z' });
  const message = (id: string, from: string, clusterId = 'a') => ({ id, clusterId, from, body: id, mentions: [], createdAt: '2026-01-01T00:00:00.000Z' });
  return { state, context, t: context.t, timers, queued, gates, send, message, setSeq: (n: number) => { seq = n; } };
}

/** Message M of cluster 'c' as the REST API answers it: its delivery to 'm' still running, no read, no acknowledgement. */
const restM = (state = 'running', extra: Record<string, unknown> = {}) => ({ id: 'M', clusterId: 'c', from: 'agent', body: 'M', mentions: ['m'],
  createdAt: '2026-01-01T00:00:00.000Z', deliveries: [{ id: 'd', messageId: 'M', memberId: 'm', state, updatedAt: 'T' }], reads: [], acknowledgements: [], ...extra });
/** The three updates of M streamed at seq 11, 12 and 13: done, read, acknowledged. */
function streamUpdates(send: (kind: string, payload: any, clusterId?: string | null, memberId?: string | null) => void) {
  send('delivery', { delivery: { id: 'd', messageId: 'M', memberId: 'm', state: 'done', updatedAt: 'T' } }, 'c', 'm');
  send('read', { memberId: 'm', messageIds: ['M'], via: 'delivery' }, 'c');
  send('acknowledgement', { acknowledgements: [{ memberId: 'm', messageId: 'M', at: 'T' }] }, 'c');
}
const stateOfM = (state: any) => {
  const msg = state.messages.get('M');
  return [msg.deliveries.get('m').state, msg.reads.length, msg.acknowledgements.length];
};

test('web ui: updates streamed while a window is read are applied to its stale answer, for every way a window is read', async () => {
  for (const kind of ['latest', 'older', 'around', 'after']) {
    const { state, t, gates, send, setSeq } = stateCode(null, { windows: true });
    state.sel.cluster = 'c';
    state.lastSeq = 10; setSeq(10);
    const other = { id: 'X', clusterId: 'c', from: 'user', body: 'X', mentions: [], createdAt: 'T', deliveries: [], reads: [], acknowledgements: [] };
    if (kind !== 'latest' && kind !== 'around') {
      t.addMessage(other, { at: 9.5 });
      state.clusterMsgs.set('c', ['X']);
      t.chatWindows.set('c', { older: true, live: false, loading: null, pending: null, newer: false, token: 0 });
    }
    const loading = kind === 'latest' ? t.loadLatest('c') : kind === 'older' ? t.loadOlder('c') : kind === 'after' ? t.loadNewer('c') : t.openMessage('c', 'M');
    assert.equal(gates.length, 1, kind);
    streamUpdates(send);   // seq 11–13, while M is not loaded: only the ring keeps them
    assert.equal(state.messages.has('M'), false);
    gates[0].open([restM()], 10);   // read at seq 10: before all three
    await loading;
    assert.deepEqual(stateOfM(state), ['done', 1, 1], kind);
    assert.ok(state.clusterMsgs.get('c').includes('M'), kind);
  }
});

test('web ui: a REST copy never undoes a streamed update, even with the same updatedAt; REST first then events also ends right', () => {
  // (b) M loaded, 'done' streamed at seq 11, then an answer read at seq 10 with 'running' and the same updatedAt.
  const b = stateCode();
  b.setSeq(10);
  b.t.fillMessages([restM()], 5);
  b.send('delivery', { delivery: { id: 'd', messageId: 'M', memberId: 'm', state: 'done', updatedAt: 'T' } }, 'c', 'm');
  b.t.fillMessages([restM()], 10);
  assert.equal(b.state.messages.get('M').deliveries.get('m').state, 'done');
  b.t.fillMessages([restM('done')], 11);
  assert.equal(b.state.messages.get('M').deliveries.get('m').state, 'done', 'an answer read after it agrees');
  // The stream behind the answer: read at seq 21 ('done'), then the 'running' of seq 20, same millisecond, arrives.
  const behind = stateCode();
  behind.setSeq(19);
  behind.t.fillMessages([restM('done')], 21);
  behind.send('delivery', { delivery: { id: 'd', messageId: 'M', memberId: 'm', state: 'running', updatedAt: 'T' } }, 'c', 'm');
  assert.equal(behind.state.messages.get('M').deliveries.get('m').state, 'done', 'ordered by seq, not by the equal updatedAt');
  assert.deepEqual([...behind.state.running.get('m')], ['d'], 'the busy dot still follows the stream');
  // (c) control: the answer first, the events after it.
  const c = stateCode();
  c.setSeq(10);
  c.t.fillMessages([restM()], 10);
  streamUpdates(c.send);
  assert.deepEqual(stateOfM(c.state), ['done', 1, 1]);
  // (d) the same read and acknowledgement by both ways: once each, whichever comes first.
  const d = stateCode();
  d.setSeq(10);
  d.t.fillMessages([restM()], 10);
  streamUpdates(d.send);
  d.t.fillMessages([restM('done', { reads: [{ memberId: 'm', via: 'delivery', at: 'T' }], acknowledgements: [{ memberId: 'm', messageId: 'M', at: 'T' }] })], 13);
  d.t.fillMessages([restM()], 10);   // an older answer again: the ring replays 11–13 onto it
  assert.deepEqual(stateOfM(d.state), ['done', 1, 1]);
});

test('web ui: a handoff or resend answer is positioned like a read; an older window answer landing after it cannot undo it', async () => {
  // The two dialogs write their answer the same way: read with its seq, applied at seq + 0.5.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  for (const [from, to] of [['function openResend(', '\nfunction openHandoff('], ['function openHandoff(', '\n// A message\'s Markdown as DOM']]) {
    const dialog = app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
    assert.match(dialog, /const \{ data: result, seq \} = await api\('POST', [^;]*, true\);\n\s*setDelivery\(result\.sourceDelivery, false, seq \+ 0\.5\);/, from);
  }
  for (const [kind, target] of [['handoff', 'other'], ['resend', 'm']]) {
    const { state, t, gates, send, setSeq } = stateCode(null, { windows: true });
    state.sel.cluster = 'c';
    const offline = { id: 'd', messageId: 'M', memberId: 'm', state: 'offline', outcome: null, handoffMessageId: null, updatedAt: '2026-01-01T00:00:00.000Z' };
    const rest = { ...restM(), deliveries: [offline] };
    const first = t.loadLatest('c');
    gates[0].open([rest], 90);
    await first;
    const reload = t.loadLatest('c');   // e.g. "回到最新": the Hub reads M's old row at seq 100
    // The POST answers first: the handoff was recorded at seq 101–102, the answer read at 102.
    const handedOff = { ...offline, handoffMessageId: 'H', updatedAt: '2026-01-01T00:00:00.001Z' };
    t.setDelivery(handedOff, false, 102 + 0.5);
    gates[1].open([rest], 100);
    await reload;
    assert.equal(state.messages.get('M').deliveries.get('m').handoffMessageId, 'H', `${kind}: the older read does not undo it`);
    // Then the stream: the new message (seq 101) and the source delivery (seq 102). Nothing changes, nothing doubles.
    const rev = state.messages.get('M').rev;
    state.lastSeq = 100; setSeq(100);
    send('message', { message: { id: 'H', clusterId: 'c', from: 'user', body: 'H', mentions: [target], createdAt: 'T', kind }, deliveries: [] }, 'c');
    send('delivery', { delivery: handedOff }, 'c', 'm');
    assert.equal(state.messages.get('M').deliveries.get('m').handoffMessageId, 'H');
    assert.equal(state.messages.get('M').rev, rev, `${kind}: the event is already shown`);
    assert.deepEqual([...state.clusterMsgs.get('c')], ['M', 'H'], `${kind}: each message once`);
    assert.equal(state.handoffs.has('H'), true);
  }
});

test('web ui: task links and bookmarks take the latest read copy; an older metadata answer does not undo a newer window read', async () => {
  const { state, t, gates, send, setSeq } = stateCode(null, { windows: true, metadata: true });
  state.sel.cluster = 'c';
  const load = t.loadLatest('c');
  gates[0].open([restM('running', { taskIds: [], bookmarks: [] })], 10);
  await load;
  state.lastSeq = 10; setSeq(10);
  send('collaboration', { action: 'task.link', messageId: 'M' }, 'c');   // seq 11: the metadata refresh asks (gate 1)
  assert.equal(gates.at(-1)!.path, '/api/clusters/c/messages/M');
  const reload = t.loadLatest('c');   // gate 2: a window read later, after another link at seq 15
  gates[2].open([restM('running', { taskIds: ['t1', 't2'], bookmarks: [{ memberId: 'user' }] })], 20);
  await reload;
  assert.deepEqual([...state.messages.get('M').taskIds], ['t1', 't2'], 'a newer copy of a loaded message updates its fields');
  gates[1].open({ ...restM('running', { taskIds: ['t1'], bookmarks: [] }) } as any, 12);   // the refresh, read at 12, lands last
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.deepEqual([...state.messages.get('M').taskIds], ['t1', 't2'], 'the older answer is ignored');
  assert.equal(state.messages.get('M').bookmarks.length, 1);
  assert.equal(t.messageMetadata.size, 0, 'and the refresh counts as done: the newer copy holds the change it asked for');
  // A newer refresh still applies.
  send('collaboration', { action: 'bookmark.remove', messageId: 'M' }, 'c');
  gates.at(-1)!.open({ ...restM('running', { taskIds: ['t1', 't2'], bookmarks: [] }) } as any, 30);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(state.messages.get('M').bookmarks.length, 0);
  // There is no write without a position.
  assert.throws(() => t.setDelivery({ id: 'd', messageId: 'M', memberId: 'm', state: 'done' }, false), /position/);
  assert.throws(() => t.addMessage(restM()), /position/);
});

test('web ui: an fyi message keeps its flag by every way it reaches the page, and its notice follows streamed reads', async () => {
  const nameOf = (id: string) => ({ m: 'B' } as Record<string, string>)[id] ?? id;
  const notice = (msg: any) => ui.recordOnlyNotice(msg, [...msg.deliveries.values()], msg.reads, msg.acknowledgements, nameOf);
  const { state, t, gates, send, setSeq } = stateCode(null, { windows: true });
  state.sel.cluster = 'c';
  // A window read: the fyi message to m, no delivery.
  const load = t.loadLatest('c');
  // Streamed while that read runs (kept aside, then merged): another fyi message.
  state.lastSeq = 10; setSeq(10);
  send('message', { message: { id: 'F2', clusterId: 'c', from: 'agent', body: 'F2', mentions: ['m'], createdAt: 'T', fyi: true }, deliveries: [] }, 'c');
  gates[0].open([{ ...restM(), deliveries: [], fyi: true }], 10);
  await load;
  assert.deepEqual([...state.clusterMsgs.get('c')], ['M', 'F2']);
  for (const id of ['M', 'F2']) {
    assert.equal(state.messages.get(id).fyi, true, id);
    assert.equal(notice(state.messages.get(id)), '仅知会：B未读，不唤醒', id);
  }
  // Live in the window now: a streamed fyi message, then reads and an acknowledgement move the notices.
  send('message', { message: { id: 'F3', clusterId: 'c', from: 'agent', body: 'F3', mentions: ['m'], createdAt: 'T', fyi: true }, deliveries: [] }, 'c');
  send('read', { memberId: 'm', messageIds: ['M', 'F3'], via: 'read_messages' }, 'c');
  send('acknowledgement', { acknowledgements: [{ memberId: 'm', messageId: 'F2', at: 'T' }] }, 'c');
  for (const id of ['M', 'F2', 'F3']) assert.equal(notice(state.messages.get(id)), '仅知会：B已读，不唤醒', id);
  // A later window copy of a loaded message does not lose the flag (fields refresh keeps the rest of the message).
  const reload = t.loadLatest('c');
  gates[1].open([{ ...restM(), deliveries: [], fyi: true, taskIds: ['t'] }], 20);
  await reload;
  assert.equal(state.messages.get('M').fyi, true);
  assert.equal(notice(state.messages.get('M')), '仅知会：B已读，不唤醒');
});

test('web ui: a window answer older than the event ring is asked for once more', async () => {
  const { state, t, gates, send, setSeq } = stateCode(null, { windows: true });
  state.sel.cluster = 'c';
  state.lastSeq = 10; setSeq(10);
  const loading = t.loadLatest('c');
  for (let i = 0; i < 1001; i++) send('delivery', { delivery: { id: `z${i}`, messageId: 'elsewhere', memberId: 'n', state: 'done', updatedAt: 'T' } }, 'c', 'n');
  gates[0].open([restM()], 10);   // seq 11 has left the ring: what changed M in between cannot be known
  for (let i = 0; i < 6 && gates.length < 2; i++) await Promise.resolve();
  assert.equal(gates.length, 2, 'asked again');
  assert.equal(gates[1].path, gates[0].path);
  gates[1].open([restM('done')], 1011);
  await loading;
  assert.deepEqual([...state.clusterMsgs.get('c')], ['M']);
  assert.equal(state.messages.get('M').deliveries.get('m').state, 'done');
});

test('web ui: unread badges come from /api/state and move with streamed messages and read positions', async () => {
  const snapshot = { seq: 10, paused: false, settings: {}, members: [], running: [],
    clusters: [{ id: 'a', userReadMessageId: 'r', unread: 4 }, { id: 'b', userReadMessageId: null, unread: 0 }] };
  const { state, t, timers, send, message, setSeq } = stateCode(snapshot);
  await t.syncPaused();
  state.lastSeq = 10; setSeq(10);
  assert.deepEqual([t.unreadOf('a'), t.unreadOf('b')], [4, 0], 'no message is loaded: the Hub counted');
  send('message', { message: message('x1', 'agent'), deliveries: [] });
  send('message', { message: message('x2', 'user'), deliveries: [] });
  send('message', { message: message('y1', 'agent', 'b'), deliveries: [] }, 'b');
  assert.deepEqual([t.unreadOf('a'), t.unreadOf('b')], [5, 1], 'messages not from the user count');
  assert.equal(state.messages.size, 0, 'a cluster never opened keeps no messages');
  // A live window of 'a' holding the new read position: counted from the window.
  t.chatWindows.set('a', { live: true, pending: null });
  state.clusterMsgs.set('a', []);
  for (const [id, from] of [['x3', 'agent'], ['x4', 'user'], ['x5', 'agent']]) send('message', { message: message(id, from), deliveries: [] });
  assert.deepEqual(state.clusterMsgs.get('a'), ['x3', 'x4', 'x5']);
  send('cluster', { cluster: { id: 'a', userReadMessageId: 'x3' }, members: [] });
  assert.equal(t.unreadOf('a'), 1);
  // Moved past what this page holds (another page read 'b'): ask the Hub again.
  send('cluster', { cluster: { id: 'b', userReadMessageId: 'y1' }, members: [] }, 'b');
  assert.equal(timers.length, 1, 'a fresh /api/state is scheduled');
  assert.equal(t.unreadOf('b'), 1, 'the old count stays until it answers');
});

test('web ui: a /api/state answer older than the stream catches up with the events it missed', async () => {
  const snapshot = { seq: 5, paused: false, settings: {}, members: [], running: [{ id: 'd1', memberId: 'm' }, { id: 'd2', memberId: 'n' }],
    clusters: [{ id: 'a', userReadMessageId: null, unread: 2 }] };
  const { state, t, send, message, setSeq } = stateCode(snapshot);
  state.clusters.set('a', { id: 'a', userReadMessageId: null });
  setSeq(5);
  send('message', { message: message('late', 'agent'), deliveries: [] });            // seq 6, newer than the snapshot
  send('delivery', { delivery: { id: 'd2', messageId: 'z', memberId: 'n', state: 'done', updatedAt: '2' } }, 'a', 'n');
  await t.syncPaused();
  assert.equal(t.unreadOf('a'), 3, "the snapshot's 2 and the message after it");
  assert.deepEqual([...state.running.get('m')], ['d1'], 'running deliveries from the snapshot');
  assert.deepEqual([...state.running.get('n')], [], 'one that ended after the snapshot stays ended');
});

test('web ui: a cluster window loads the newest page, older pages in front, and a window around a message', async () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf("// ---- loading a cluster's messages");
  const end = app.indexOf('// ---- one message the page may not hold', start);
  assert.ok(start >= 0 && end > start);
  const PAGE = 4;
  const all = Array.from({ length: 11 }, (_, i) => ({ id: `m${i}`, clusterId: 'c', from: 'agent', body: '' }));
  const ids = (list: { id: string }[]) => list.map((m) => m.id);
  const gates: { path: string; open: (list: unknown[]) => void; fail: () => void }[] = [];
  const state: any = { sel: { cluster: 'c', member: null, overview: false }, messages: new Map(), clusterMsgs: new Map(), handoffs: new Set() };
  const windows = new Map();
  const notices: string[] = [];
  const el = () => ({ addEventListener() {}, classList: { toggle() {} } });
  const context: any = { ...JUMP_HELPERS, jump: null, S: state, PAGE, CHAT_WINDOW_LIMIT: PAGE * 3, chatWindows: windows, render() {}, select() {}, $: el, setText() {},
    noticeDialog: (text: unknown) => notices.push(String(text)), lt: ui.lt, msgEls: new Map(), attachEls: new Map(), messageDiffViews: new Map(), receiptTimelines: new Map(),
    openReceipts: new Set(), openTaskLinks: new Set(), messageMetadata: new Map(), refMessages: new Map(),
    fillMessages: (list: any[]) => list.map((m) => (state.messages.set(m.id, m), m.id)), ringFloor: 0, Date,
    api: (_method: string, path: string) => new Promise((resolve, reject) => gates.push({ path, open: (data) => resolve({ data, seq: 0 }), fail: () => reject(new Error('gone')) })) };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.w = { loadLatest, loadOlder, loadNewer, openMessage, windowOf };`, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const win = () => windows.get('c');

  // The newest page; a message streamed meanwhile is appended once.
  const latest = context.w.loadLatest('c');
  assert.equal(gates[0].path, '/api/clusters/c/messages?limit=4');
  win().pending.push({ id: 'm10', seq: 1 }); state.messages.set('m10', all[10]);
  gates[0].open(all.slice(6, 10));
  await latest;
  assert.deepEqual([...state.clusterMsgs.get('c')], ['m6', 'm7', 'm8', 'm9', 'm10']);
  assert.deepEqual([win().older, win().live, win().pending, win().loading], [true, true, null, null]);

  // An older page goes in front.
  const older = context.w.loadOlder('c');
  assert.equal(gates[1].path, '/api/clusters/c/messages?limit=4&before=m6');
  gates[1].open(all.slice(2, 6));
  await older;
  assert.deepEqual([...state.clusterMsgs.get('c')], ids(all.slice(2)));
  assert.deepEqual([win().older, win().anchor], [true, true], 'renderChat keeps the view in place');

  // A message further back: a window around it replaces this one; history not shown any more is dropped.
  const jump = context.w.openMessage('c', 'm0');
  assert.equal(gates[2].path, '/api/clusters/c/messages?limit=4&around=m0');
  win().pending.push({ id: 'm11', seq: 1 }); state.messages.set('m11', { id: 'm11' });
  gates[2].open(all.slice(0, 2));   // nothing older (two asked for), one newer (one asked for): neither end reached on the newer side
  await jump;
  assert.deepEqual([...state.clusterMsgs.get('c')], ['m0', 'm1']);
  assert.deepEqual([win().older, win().live, win().newer], [false, false, true], 'a message came meanwhile: "有新消息"');
  assert.equal(state.messages.has('m9'), false, 'messages outside the window are forgotten');
  assert.equal(state.messages.has('m11'), false, 'and so is the one that came meanwhile');
  await context.w.loadOlder('c');
  assert.equal(gates.length, 3, 'nothing older to ask for');

  // Scrolling down pages forward; a short page reaches the newest message and the window is live again.
  for (const [i, page] of [[3, all.slice(2, 6)], [4, all.slice(6, 10)]] as const) {
    const newer = context.w.loadNewer('c');
    gates[i].open([...page]);
    await newer;
    assert.equal(win().live, false);
  }
  assert.equal(gates[4].path, '/api/clusters/c/messages?limit=4&after=m5');
  const rest = context.w.loadNewer('c');
  win().pending.push({ id: 'm11', seq: 1 }); state.messages.set('m11', { id: 'm11' });
  gates[5].open([all[10]]);
  await rest;
  assert.deepEqual([win().live, win().newer], [true, false]);
  assert.deepEqual([...state.clusterMsgs.get('c').slice(-3)], ['m9', 'm10', 'm11']);

  // A jump that cannot be read leaves the window as it was and says so.
  const failed = context.w.openMessage('c', 'gone');
  win().pending.push({ id: 'm12', seq: 1 }); state.messages.set('m12', { id: 'm12' });
  gates[6].fail();
  await failed;
  await settle();
  assert.equal(state.clusterMsgs.get('c').at(-1), 'm12', 'a message streamed meanwhile still reaches the live window');
  assert.equal(notices.length, 1);
});

test('web ui: messages stream into a live window only; REST and stream copies merge without going back in time', () => {
  const { state, t, queued, send, message } = stateCode();
  const d = (stateName: string, updatedAt: string) => ({ id: 'd', messageId: 'x1', memberId: 'm', state: stateName, updatedAt });
  // An older window: not appended into history, only flagged.
  t.chatWindows.set('a', { live: false, pending: null, newer: false });
  state.clusterMsgs.set('a', ['old']);
  send('message', { message: message('x0', 'agent'), deliveries: [] });
  assert.deepEqual(state.clusterMsgs.get('a'), ['old']);
  assert.equal(t.chatWindows.get('a').newer, true);
  // A request for the newest messages under way: kept aside for its answer.
  t.chatWindows.set('a', { live: false, pending: [] });
  send('message', { message: message('x1', 'agent'), deliveries: [d('queued', '1')] });
  assert.deepEqual(Array.from(t.chatWindows.get('a').pending, ({ id }: { id: string }) => id), ['x1']);
  send('delivery', { delivery: d('running', '3') }, 'a', 'm');
  assert.deepEqual([...state.running.get('m')], ['d'], 'the stream moves running');
  // The REST answer read before that event: its older delivery state does not win, nor touch running.
  const msg = t.addMessage({ ...message('x1', 'agent'), deliveries: [d('queued', '2')], reads: [{ memberId: 'm', via: 'delivery', at: '1' }], acknowledgements: [] }, { at: 2.5, rest: true });
  assert.equal(msg.deliveries.get('m').state, 'running');
  assert.deepEqual([...state.running.get('m')], ['d']);
  send('read', { memberId: 'm', messageIds: ['x1', 'not-loaded'], via: 'delivery' });
  assert.equal(msg.reads.length, 1, 'a receipt from both REST and the stream counts once');
  // Task links and bookmarks of a message that is not loaded are read when it is.
  send('collaboration', { action: 'task.link', messageId: 'not-loaded' });
  send('collaboration', { action: 'task.link', messageId: 'x1' });
  assert.deepEqual(queued, ['x1']);
  // A handoff or resend is known by its kind, without the source delivery.
  t.addMessage({ ...message('h1', 'user'), kind: 'resend', deliveries: [] }, { at: 1 });
  assert.equal(state.handoffs.has('h1'), true);
});

test('web ui: chat bounds a live burst, keeps a historical viewport and pages in both directions', async () => {
  const { state, context, t, gates, send, message } = stateCode(null, { windows: true, page: 4 });
  state.sel.cluster = 'c';
  const row = (i: number) => message(`m${i}`, 'agent', 'c');
  const stream = (i: number) => send('message', { message: row(i), deliveries: [] }, 'c');
  const ids = () => [...state.clusterMsgs.get('c')];
  const win = () => t.chatWindows.get('c');

  const latest = t.loadLatest('c');
  for (let i = 0; i < 8; i++) stream(i);
  assert.equal(state.messages.size, 4, 'the in-flight buffer holds one page');
  gates[0].open([], 0);   // the snapshot predates our rolling page
  await latest;
  assert.deepEqual(ids(), ['m4', 'm5', 'm6', 'm7']);
  assert.equal(win().live, true);
  assert.equal(win().older, true);

  for (let i = 8; i < 17; i++) stream(i);
  assert.equal(state.messages.size, 9, 'the latest window has room for the next burst');
  assert.equal(ids()[0], 'm8');
  assert.equal(ids().at(-1), 'm16');
  const box = { dataset: { cluster: 'c' }, scrollHeight: 2000, scrollTop: 400, clientHeight: 300 };
  context.$ = () => box;
  for (let i = 17; i < 21; i++) stream(i);
  assert.equal(state.messages.size, 12, 'the window does not grow past three pages');
  assert.equal(ids().at(-1), 'm19', 'the window stays put when reading up the page');
  assert.deepEqual([win().live, win().newer], [false, true]);

  const older = t.loadOlder('c');
  assert.match(gates[1].path, /before=m8$/);
  gates[1].open([4, 5, 6, 7].map(row), 21);
  await older;
  assert.deepEqual([ids()[0], ids().at(-1), ids().length, win().anchor], ['m4', 'm15', 12, true]);
  assert.equal(state.messages.has('m19'), false, 'paging up evicts messages at the newer end');

  const newer = t.loadNewer('c');
  assert.match(gates[2].path, /after=m15$/);
  gates[2].open([16, 17, 18, 19].map(row), 21);
  await newer;
  assert.deepEqual([ids()[0], ids().at(-1), ids().length, win().anchor], ['m8', 'm19', 12, true]);

  const caughtUp = t.loadNewer('c');
  gates[3].open([row(20)], 21);
  await caughtUp;
  assert.deepEqual([ids()[0], ids().at(-1), ids().length, win().live, win().newer], ['m9', 'm20', 12, true, false]);
});

test('web ui: leaving a cluster releases its chat and ignores a response from the previous visit', async () => {
  const { state, context, t, gates, send, message } = stateCode(null, { windows: true });
  state.sel.cluster = 'c';
  const previous = t.loadLatest('c');
  send('message', { message: message('held', 'agent', 'c'), deliveries: [] }, 'c');
  for (const cache of ['msgEls', 'attachEls', 'messageDiffViews', 'receiptTimelines', 'messageMetadata', 'refMessages']) {
    context[cache].set('held', {});
  }
  t.forgetWindow('c');
  assert.equal(state.messages.size, 0);
  assert.equal(t.chatWindows.size, 0);
  for (const cache of ['msgEls', 'attachEls', 'messageDiffViews', 'receiptTimelines', 'messageMetadata', 'refMessages']) {
    assert.equal(context[cache].size, 0, cache);
  }
  send('message', { message: message('while-away', 'agent', 'c'), deliveries: [] }, 'c');
  assert.equal(state.messages.size, 0, 'the stream keeps no bodies for a cluster left behind');
  const current = t.loadLatest('c');
  gates[0].open([message('stale', 'agent', 'c')], 1);
  await previous;
  assert.equal(state.messages.size, 0, 'a late answer cannot recreate the departed window');
  gates[1].open([message('while-away', 'agent', 'c')], 2);
  await current;
  assert.deepEqual([...state.clusterMsgs.get('c')], ['while-away']);
});

test('web ui: system message identity is distinct and other unknown senders stay unknown', () => {
  const members = new Map([['member', { name: '甲' }]]);
  assert.equal(ui.messageAuthorName({ from: 'system', kind: 'system' }, members), 'Orrery 系统');
  assert.equal(ui.messageAuthorName({ from: 'missing' }, members), '(未知成员)');
  assert.equal(ui.messageAuthorName({ from: 'system' }, members), '(未知成员)');
  assert.equal(ui.messageAuthorName({ from: 'member', kind: 'system' }, members), '甲');
  assert.equal(ui.messageAuthorName({ from: 'user' }, members), '你');
  assert.equal(ui.messageAuthorName({ from: 'plugin:review-alert', kind: 'plugin' }, members), '插件 review-alert');
});

test('web ui: only enabled first-party module names are imported and register slots', async () => {
  const { loadPluginSlots } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/plugin-slots.js')).href);
  const host = { api() {} };
  const imports: string[] = [];
  const hooks = { message: { render() {} }, composer() {}, workbench() {}, settings() {} };
  const load = async (name: string) => {
    imports.push(name);
    return { register(given: unknown) { assert.equal(given, host); return hooks; } };
  };
  const disabled = await loadPluginSlots({ frontend: [], plugins: [{ id: 'external' }] }, host, load);
  assert.deepEqual(disabled, {
    message: [], composer: [], workbench: [], settings: [], view: [], trusted: [], tried: [],
    officialPackages: new Map(), onRelease: null, closeView: null,
  });
  const enabled = await loadPluginSlots({
    frontend: ['bookmarks', 'bookmarks', 'disabled', '../app', '/app.js', 'https://external.invalid/a.js'],
    plugins: [{ id: 'bookmarks' }, { id: 'external' }, { id: '../app' }, { id: '/app.js' }, { id: 'https://external.invalid/a.js' }],
  }, host, load);
  assert.deepEqual(imports, ['bookmarks']);
  assert.deepEqual(['message', 'composer', 'workbench', 'settings', 'trusted', 'tried'].map((name) => enabled[name].length), [1, 1, 1, 1, 0, 0]);
});

test('web ui: full-trust page modules load only when listed and running, get their own host, and detach for good', async (t) => {
  const { detachPluginSlots, loadPluginSlots } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/plugin-slots.js')).href);
  const warnings = t.mock.method(console, 'warn', () => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const calls: string[] = [];
  const apiCalls: string[] = [];
  const formDialog = (_title: string, _fields: unknown, submit: () => void, setBusy: (busy: boolean) => void) => ({ submit, setBusy });
  const host = { api: async (method: string) => { apiCalls.push(method); return {}; }, nameOf: (id: string) => id, command: async () => 'done',
    ui: { h() {}, noticeDialog: async () => {}, confirmDialog: async () => true, formDialog } };
  const hosts = new Map<string, any>();
  let disposed = 0;
  const module = (id: string) => ({ register(given: any) {
    hosts.set(id, given);
    if (id === 'throws') throw new Error('fixture register failed');
    if (id === 'async') return Promise.reject(new Error('fixture register is async'));
    given.onDispose(() => { disposed++; calls.push(`${id}.dispose`); });
    given.onDispose(() => { throw new Error('fixture dispose failed'); });
    given.onDispose(() => new Promise(() => {}));   // never settles
    return {
      message: { render: () => { calls.push(`${id}.render`); return 'm'; }, key: () => { calls.push(`${id}.key`); return 'k'; },
        capture: () => calls.push(`${id}.capture`), restore: () => calls.push(`${id}.restore`), update: () => calls.push(`${id}.update`) },
      composer: () => { calls.push(`${id}.composer`); return 'c'; },
      // The settings slot of `two` hands back a promise: nothing for the page to insert (no stray "[object Promise]").
      settings: () => { calls.push(`${id}.settings`); return id === 'two' ? Promise.reject(new Error('fixture settings rejects')) : 's'; },
      workbench: () => ({ id: `${id}-tab`, label: id, render: () => { calls.push(`${id}.tab`); return 't'; }, load() {}, itemRow: () => { calls.push(`${id}.row`); } }),
    };
  } });
  const imported: string[] = [];
  const slots = await loadPluginSlots({ frontend: [], trustedFrontend: ['one', 'two', 'two', 'off', '../x', 'throws', 'missing', 'async'],
    plugins: [{ id: 'one' }, { id: 'two' }, { id: 'throws' }, { id: 'missing' }, { id: '../x' }, { id: 'async' }] }, host, async () => assert.fail('no official module'),
  (id: string) => { imported.push(id); if (id === 'missing') throw new Error('fixture 404'); return module(id); });
  assert.deepEqual(imported.sort(), ['async', 'missing', 'one', 'throws', 'two'], 'listed and running only; a module that fails to load or register is skipped');
  assert.deepEqual(slots.tried, ['one', 'two', 'throws', 'missing', 'async'], 'every module the page tried');
  assert.deepEqual(slots.trusted, ['one', 'two'], 'only those that registered their slots: an async register registers nothing');
  assert.deepEqual(['message', 'composer', 'workbench', 'settings'].map((name) => slots[name].map((s: any) => s.pluginId)), [['one', 'two'], ['one', 'two'], ['one', 'two'], ['one', 'two']]);
  const one = hosts.get('one');
  assert.notEqual(one, host, 'its own host');
  assert.equal(one.nameOf, host.nameOf);
  assert.equal(typeof one.onDispose, 'function');
  assert.equal(Object.isFrozen(one) && Object.isFrozen(one.ui), true);
  await one.api('GET');
  assert.deepEqual(apiCalls, ['GET']);
  const tabs = slots.workbench.map((create: any) => create({}));
  const dialog = one.ui.formDialog('x', [], () => calls.push('submit'), () => calls.push('busy'));
  dialog.submit();
  dialog.setBusy(true);
  assert.deepEqual(calls, ['submit', 'busy']);

  detachPluginSlots(slots, ['one']);
  detachPluginSlots(slots, ['one']);   // twice: the dispose functions still ran once
  assert.deepEqual(['message', 'composer', 'workbench', 'settings'].map((name) => slots[name].map((s: any) => s.pluginId)), [['two'], ['two'], ['two'], ['two']]);
  assert.equal(disposed, 1);
  calls.length = 0;
  // Anything of it the page still held is inert: its old slot wrappers and tab methods are never called again.
  const oneTab = tabs.find((tab: any) => tab.pluginId === 'one');
  assert.equal(oneTab.render(), undefined);
  assert.equal(oneTab.itemRow({}), undefined);
  dialog.submit();
  dialog.setBusy(false);
  assert.equal(calls.length, 0, 'no call after the detach');
  await assert.rejects(one.api('GET'), /detached from this page/);
  await assert.rejects(one.command({}), /detached from this page/);
  await assert.rejects(one.ui.noticeDialog('x'), /detached from this page/);
  assert.throws(() => one.ui.formDialog('x', []), /detached from this page/);
  assert.deepEqual(apiCalls, ['GET'], 'no request after the detach');
  one.onDispose(() => calls.push('late dispose'));
  assert.deepEqual(calls, ['late dispose'], 'registered after the detach: runs at once');
  // The other plugin is untouched.
  assert.equal(slots.message[0].render('x'), 'm');
  assert.equal(slots.composer[0](), 'c');
  assert.equal(slots.settings[0](), undefined, 'a promise from a page slot is caught and gives the page nothing');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'no unhandled rejection (async register, rejecting slot)');
  const asyncWarning = warnings.mock.calls.find((call) => call.arguments[0] === 'plugin UI failed to load: async');
  assert.match(String(asyncWarning?.arguments[1]), /register\(host\) must return the slots synchronously/);
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === 'plugin UI failed in two.settings'));
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === 'plugin UI failed in one.dispose'), 'a throwing dispose is logged');
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === 'plugin UI failed to load: throws'));
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === 'plugin UI failed to load: missing'));
  // A promise from a factory slot refuses the whole plugin: two is released after that call, like a detach.
  assert.deepEqual(['message', 'composer', 'workbench', 'settings'].map((name) => slots[name].length), [0, 0, 0, 0]);
  assert.deepEqual(slots.trusted, ['one'], 'two is no longer attached (no notice, nothing to offer)');
  await assert.rejects(hosts.get('two').api('GET'), /detached from this page/);
});

test('web ui: a full-trust module of the wrong shape, or one that fails in register, is rolled back as a whole', async (t) => {
  const { loadPluginSlots } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/plugin-slots.js')).href);
  const warnings = t.mock.method(console, 'warn', () => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const render = () => 'm';
  const tab = { id: 'tab', label: 'Tab', render: () => 't', load() {} };
  const shapes: Record<string, unknown> = {
    'string-key': { message: { render, key: 'not a function' } },
    'no-render': { message: { key: () => 'k' } },
    'junk-field': { message: { render, colour: 'red' } },
    'junk-slot': { composer: () => 'c', toolbar: () => 'x' },
    'number-slot': { composer: 42 },
    'array-hooks': [],
    'async-tab': { composer: () => 'c', workbench: async () => tab },
    'tab-no-render': { workbench: () => ({ id: 'x', label: 'X', load() {} }) },
    good: { message: { render }, composer: () => 'c', workbench: () => tab, settings: () => null },
  };
  const disposed: Record<string, number> = {};
  const hosts: Record<string, any> = {};
  const host = { api: async () => ({}), nameOf: (id: string) => id, command: async () => 'done', ui: {} };
  const ids = [...Object.keys(shapes), 'half'];
  const slots = await loadPluginSlots({ frontend: [], trustedFrontend: ids, plugins: ids.map((id) => ({ id })) }, host, async () => assert.fail('no official module'),
    async (id: string) => ({ register(given: any) {
      hosts[id] = given;
      given.onDispose(() => { disposed[id] = (disposed[id] ?? 0) + 1; });
      if (id === 'half') throw new Error('fixture register fails after taking a cleanup function');
      return shapes[id];
    } }));
  assert.deepEqual(slots.tried, ids);
  // async-tab passes registration (its factory is only called later); every other wrong one is refused at once.
  assert.deepEqual(slots.trusted, ['async-tab', 'tab-no-render', 'good']);
  for (const id of ['string-key', 'no-render', 'junk-field', 'junk-slot', 'number-slot', 'array-hooks', 'half']) {
    assert.equal(disposed[id], 1, `${id}: its cleanup ran once`);
    await assert.rejects(hosts[id].api('GET'), /detached from this page/, `${id}: its host is revoked`);
  }
  assert.deepEqual(slots.message.map((s: any) => s.pluginId), ['good'], 'no slot of a refused module');
  // The workbench calls the factories: an async one and one without render refuse their plugins, the good one works.
  const tabs = slots.workbench.map((create: any) => create({})).filter(Boolean);
  assert.deepEqual(tabs.map((t: any) => t.pluginId), ['good']);
  assert.equal(tabs[0].render(), 't');
  assert.equal(slots.composer.find((create: any) => create.pluginId === 'async-tab')(), undefined, 'a refused module is already inert before removal');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(slots.trusted, ['good']);
  assert.deepEqual(['message', 'composer', 'workbench', 'settings'].map((name) => slots[name].map((s: any) => s.pluginId)), [['good'], ['good'], ['good'], ['good']]);
  assert.equal(disposed['async-tab'], 1);
  assert.equal(disposed['tab-no-render'], 1);
  assert.equal(disposed.good, undefined, 'the good one keeps running');
  assert.deepEqual(unhandled, [], 'no unhandled rejection');
  const reasons = warnings.mock.calls.map((call) => `${call.arguments[0]} ${String(call.arguments[1])}`).join('\n');
  for (const text of ['message.key must be a function', 'message.render must be a function', 'message.colour is not part of the slot', 'toolbar is not a page slot',
    'composer must be a function', 'must return an object of slots', 'the workbench tab must be an object (not a promise)', 'the workbench tab.render must be a function']) {
    assert.ok(reasons.includes(text), text);
  }
});

test('web ui: failed plugin hooks leave the next plugin usable', async (t) => {
  const { loadPluginSlots } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/plugin-slots.js')).href);
  const warnings = t.mock.method(console, 'warn', () => {});
  const fail = () => { throw new Error('fixture hook failed'); };
  const broken = { workbench: fail, composer: fail, settings: fail, message: {
    render: fail, key: fail, capture: fail, restore: fail, update: fail,
  } };
  const message = {
    prefix: 'message',
    render(id: string) { return this.prefix + ' ' + id; },
  };
  const healthy = { workbench: () => ({
    id: 'tab', label: 'Tab', render() { return this.label; }, async load() { throw new Error('fixture load failed'); },
  }), composer: () => 'composer', settings: () => 'settings', message };
  const slots = await loadPluginSlots({
    frontend: ['broken', 'healthy'], plugins: [{ id: 'broken' }, { id: 'healthy' }],
  }, {}, async (id: string) => ({ register: () => id === 'broken' ? broken : healthy }));

  const tabs = slots.workbench.map((createTab: any) => createTab({})).filter(Boolean);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].render(), 'Tab', 'the tab keeps its method receiver');
  assert.equal(await tabs[0].load(), undefined, 'a rejected load is isolated too');
  assert.deepEqual(slots.composer.map((mount: any) => mount()).filter(Boolean), ['composer']);
  assert.deepEqual(slots.settings.map((mount: any) => mount()).filter(Boolean), ['settings']);
  assert.deepEqual(slots.message.map((slot: any) => slot.render('one')).filter(Boolean), ['message one']);
  for (const name of ['key', 'capture', 'restore', 'update']) assert.equal(slots.message[0][name](), undefined);
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]), [
    'plugin UI failed in broken.workbench', 'plugin UI failed in healthy.workbench.load',
    'plugin UI failed in broken.composer', 'plugin UI failed in broken.settings', 'plugin UI failed in broken.message.render',
    'plugin UI failed in broken.message.key', 'plugin UI failed in broken.message.capture',
    'plugin UI failed in broken.message.restore', 'plugin UI failed in broken.message.update',
  ]);
});

test('web ui: failed message metadata stays queued until a bounded retry', async () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('const messageMetadata = new Map()');
  const end = app.indexOf('// ---- remembered UI choices', start);
  assert.ok(start >= 0 && end > start);
  const message = { taskIds: [] as string[], bookmarks: [] as unknown[] };
  const state = { sel: { cluster: 'c' }, messages: new Map([['m', message]]) };
  let calls = 0;
  const context: any = { S: state, render() {}, pluginSlots: { message: [bookmarks.register({}).message] }, api: async () => {
    calls++;
    if (calls === 1) throw new Error('temporarily unavailable');
    return { data: { taskIds: ['task'], bookmarks: [{ memberId: 'user' }] }, seq: 7 };
  } };
  const fields = app.indexOf('function setFields(');
  runInNewContext(`${app.slice(fields, app.indexOf('\n}\n', fields) + 3)}\n${app.slice(start, end)}\nglobalThis.metadataTest = { queueMessageMetadata, retryMessageMetadata, pending: () => messageMetadata.size, reported: () => messageMetadata.get('m')?.reportedFailure };`, context);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  context.metadataTest.queueMessageMetadata('c', 'm');
  await flush();
  assert.equal(calls, 1);
  assert.equal(context.metadataTest.pending(), 1, 'failure retains the message');
  assert.equal(context.metadataTest.reported(), true, 'the UI can expose the failed sync');
  await flush();
  assert.equal(calls, 1, 'failure does not start a tight retry loop');
  context.metadataTest.retryMessageMetadata('c');
  assert.equal(context.metadataTest.reported(), true, 'the notice remains until the retry succeeds');
  await flush();
  assert.equal(calls, 2);
  assert.equal(context.metadataTest.pending(), 0);
  assert.deepEqual(message.taskIds, ['task']);
  assert.equal(message.bookmarks.length, 1);
});

test('web ui: defaultName sanitizes model name to valid member name, reserved names fallback to harness', () => {
  assert.equal(ui.defaultName(null, 'claude'), 'claude');
  assert.equal(ui.defaultName('', 'codex'), 'codex');
  assert.equal(ui.defaultName('gpt-4o', 'codex'), 'gpt-4o');
  assert.equal(ui.defaultName('vendor/model x', 'kimi'), 'vendor-model-x');
  assert.equal(ui.defaultName('all', 'claude'), 'claude');
  assert.equal(ui.defaultName('user', 'codex'), 'codex');
  assert.equal(ui.defaultName('---', 'codex'), 'codex');
  assert.equal(ui.defaultName('deepseek-r1:latest', 'deepseek'), 'deepseek-r1-latest');
  assert.equal(ui.defaultName('中文模型 2.0', 'kimi'), '中文模型-2.0');
});

test('web ui: the create form pre-fills the name the Hub would give: picked model, else the catalog default, made unique', () => {
  const mock = [{ id: 'mock-1', isDefault: true }, { id: 'mock-2' }];
  const cases: [string, Record<string, unknown>, string][] = [
    ['default model of the catalog', { harness: 'mock', models: mock }, 'mock-1'],
    ['picked model', { harness: 'mock', model: 'mock-2', models: mock }, 'mock-2'],
    ['catalog without a default', { harness: 'codex', models: [{ id: 'gpt-a' }] }, 'codex'],
    ['no catalog, typed model', { harness: 'kimi', model: 'vendor/model x' }, 'vendor-model-x'],
    ['no catalog, no model', { harness: 'deepseek' }, 'deepseek'],
    ['attached conversation without a model', { harness: 'claude', model: '' }, 'claude'],
    ['reserved model name', { harness: 'claude', model: 'user' }, 'claude'],
    ['taken once', { harness: 'mock', models: mock, taken: new Set(['mock-1']) }, 'mock-1-2'],
    ['taken twice', { harness: 'mock', models: mock, taken: new Set(['mock-1', 'mock-1-2']) }, 'mock-1-3'],
    ['harness name taken', { harness: 'codex', taken: new Set(['codex']) }, 'codex-2'],
  ];
  for (const [what, input, name] of cases) assert.equal(ui.memberDefaultName(input), name, what);
  // The page's copy of the Hub's naming rule (src/core/hub.ts defaultName / buildMembers) must not drift from it.
  const hub = readFileSync(join(REPO_ROOT, 'src', 'core', 'hub.ts'), 'utf8');
  const uiSrc = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js'), 'utf8');
  for (const rule of [String.raw`.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '')`, 'for (let i = 2; taken.has(']) {
    assert.ok(hub.includes(rule) && uiSrc.includes(rule), rule);
  }
});

test('web ui: each picked conversation is attached; a ticked "new" adds one in the picked project with mode native; nothing picked is an error', () => {
  const sessions = [{ sessionId: 't1', name: ' a1 ', avatar: 'preset:robot' }, { sessionId: 't2', name: '', avatar: '' }];
  const picked = { ...base, project: 'C:\\p', sessions, name: 'x', avatar: '🦊', model: 'gpt-a' };
  assert.deepEqual(ui.harnessSpecs(picked).specs, [
    { harness: 'codex', sessionId: 't1', name: 'a1', avatar: 'preset:robot' }, { harness: 'codex', sessionId: 't2' },
  ], 'each picked conversation carries its own name / avatar; fields of an unticked "new" are not sent; attaching needs no mode');
  assert.deepEqual(ui.harnessSpecs({ ...picked, create: true, effort: 'low' }).specs, [
    { harness: 'codex', sessionId: 't1', name: 'a1', avatar: 'preset:robot' }, { harness: 'codex', sessionId: 't2' },
    { harness: 'codex', mode: 'native', projectPath: 'C:\\p', name: 'x', avatar: '🦊', model: 'gpt-a', effort: 'low' },
  ], 'a new conversation says mode native: the Hub refuses a create without it');
  assert.deepEqual(ui.harnessSpecs({ ...base, name: 'ignored', avatar: 'ignored' }), { error: '请选择已有对话，或勾选新建对话' }, 'no default conversation');
  assert.deepEqual(ui.harnessSpecs({ ...base, create: true }), { error: '请选择新建对话的项目目录' }, 'a new conversation needs a project');
  assert.deepEqual(ui.harnessSpecs({ ...base, create: true, project: '  ' }), { error: '请选择新建对话的项目目录' });
  assert.deepEqual(ui.harnessSpecs({ ...base, create: true, project: 'C:\\p', name: ' rev ', avatar: ' 🦊 ', model: 'gpt-a', effort: 'high' }).specs,
    [{ harness: 'codex', mode: 'native', projectPath: 'C:\\p', name: 'rev', avatar: '🦊', model: 'gpt-a', effort: 'high' }], 'a new conversation with every field filled');
});

test('web ui: a harness that cannot create native conversations (Claude) must pick one', () => {
  const claude = { ...base, harness: 'claude', nativeCreate: false };
  assert.match(ui.harnessSpecs(claude).error, /只能接入已有会话/);
  assert.equal(ui.harnessSpecs(claude).specs, undefined);
  assert.match(ui.harnessSpecs({ ...claude, create: true, project: 'C:\\p' }).error, /只能接入已有会话/, 'a stale "new" tick creates nothing');
  assert.deepEqual(ui.harnessSpecs({ ...claude, sessions: [{ sessionId: 's1' }] }).specs, [{ harness: 'claude', sessionId: 's1' }]);
});

test('web ui: effort choices follow the model; the default model, else every effort, for "默认"', () => {
  const models = [
    { id: 'a', efforts: ['low', 'high'] },
    { id: 'b', efforts: ['medium'], isDefault: true },
    { id: 'c', efforts: [] },
  ];
  assert.deepEqual(ui.effortChoices(models, 'a'), ['low', 'high']);
  assert.deepEqual(ui.effortChoices(models, 'c'), []);
  assert.deepEqual(ui.effortChoices(models, 'gone'), []);
  assert.deepEqual(ui.effortChoices(models, ''), ['medium']);
  assert.deepEqual(ui.effortChoices(models.map(({ isDefault, ...m }) => m), ''), ['low', 'high', 'medium']);
  assert.deepEqual(ui.effortChoices([], ''), []);
});

test('web ui: the long-waiting note counts warned deliveries and is absent otherwise', () => {
  assert.equal(ui.longWaitingHint({ longWaiting: 3 }), '3 条消息已经等了很久，这个成员还没开始处理。');
  assert.equal(ui.longWaitingHint({}), null);
  assert.equal(ui.longWaitingHint({ longWaiting: 2, removedAt: 'x' }), null);
});

test('web ui: offline hint only for an offline native member; the bridge advice only for Claude', () => {
  const claude = { harness: 'claude', mode: 'native' };
  const hint = ui.offlineHint(claude, 'offline');
  assert.match(hint, /消息不会投递，上线后也不补发/);
  assert.match(hint, /read_messages/);
  assert.doesNotMatch(hint, /排队|自动送达/);
  assert.match(hint, /orrery 桥/);
  assert.match(hint, /重开这个会话/);
  assert.match(hint, /Claude Desktop 或终端/);
  assert.equal(ui.offlineHint({ harness: 'codex', mode: 'native' }, 'offline'), '这个对话现在离线，发给它的消息不会投递，上线后也不补发；消息留在群聊记录里，它之后可以用 read_messages 自己读。');
  assert.match(ui.offlineHint({ harness: 'antigravity', mode: 'native' }, 'offline'), /^这个对话现在离线.*orrery sidecar.*启用/);
  assert.match(ui.offlineHint({ harness: 'antigravity', mode: 'native' }, 'offline', false), /没有提供 antigravity/);
  assert.match(ui.offlineHint({ harness: 'zcode', mode: 'native' }, 'offline'), /^这个对话现在离线.*重新挂上 orrery/);
  assert.match(ui.offlineHint({ harness: 'workbuddy', mode: 'native' }, 'offline'), /^这个对话现在离线.*挂上 orrery/);
  assert.match(ui.offlineHint({ harness: 'qoder', mode: 'native' }, 'offline'), /^这个对话现在离线.*重新挂上 orrery/);
  assert.match(ui.offlineHint({ harness: 'cursor', mode: 'native' }, 'offline'), /^这个对话现在离线.*在 Cursor 里对这个对话说一句话/);
  assert.equal(ui.offlineHint(claude, 'idle'), null);
  assert.equal(ui.offlineHint(claude, 'busy'), null);
  const missing = ui.offlineHint(claude, 'offline', false);
  assert.match(missing, /没有提供 claude，发给它的消息不会投递/);
  assert.doesNotMatch(missing, /orrery 桥|重开/, 'no bridge advice when the Hub lacks the harness');
});

test('web ui: legacy member events normalize removal and replay cannot reactivate an already removed member', () => {
  const legacy = { id: 'a', clusterId: 'c', name: 'Alice', avatar: '🐭' };
  assert.equal(ui.mergeMember(undefined, legacy).removedAt, null);
  const removed = ui.mergeMember(legacy, { ...legacy, removedAt: '2026-10-30T00:00:00.000Z' });
  assert.deepEqual(ui.mergeMember(removed, legacy), removed);
  assert.deepEqual(ui.activeMembers([removed, { ...legacy, id: 'new' }, { ...legacy, id: 'other', clusterId: 'd' }], 'c').map((m: any) => m.id), ['new']);
  assert.equal(removed.name, 'Alice', 'history metadata remains available');
});

test('web ui: a member status comes from the newer of the /api/state snapshot and member events', () => {
  const member = (status: string) => ({ id: 'a', clusterId: 'c', name: 'A', mode: 'native', status, removedAt: null });
  // Page load: the snapshot at seq 5 (after a Hub restart the conversation has not reconnected), then the full replay.
  let m = ui.mergeMemberAt(undefined, member('offline'), 5 + 0.5);
  for (const seq of [2, 5]) m = ui.mergeMemberAt(m, { ...member('idle'), name: `A${seq}` }, seq);
  assert.equal(m.status, 'offline', 'older replayed events do not bring back the old online state');
  assert.equal(m.name, 'A5', 'their other fields still apply');
  m = ui.mergeMemberAt(m, member('idle'), 6);
  assert.equal(m.status, 'idle', 'the member event after the snapshot (reconnected) applies');
  // A snapshot answered after a newer event was already streamed does not undo it.
  assert.equal(ui.mergeMemberAt(m, member('offline'), 5.5).status, 'idle');
  // An API reply (no seq) keeps the status already held.
  assert.equal(ui.mergeMemberAt(m, member('offline')).status, 'idle');
  // Without a snapshot (the state request failed) events apply in order, as before.
  assert.equal(ui.mergeMemberAt(ui.mergeMemberAt(undefined, member('idle'), 1), member('offline'), 2).status, 'offline');
});

test('web ui: a later snapshot at the same seq replaces the status, older events still do not', () => {
  const member = (status: string) => ({ id: 'a', clusterId: 'c', name: 'A', mode: 'native', status, removedAt: null });
  // The page stays open; the Hub restarts with the same database and no new event, so the reconnect snapshot has
  // the same seq 2 but the member is now offline.
  let m = ui.mergeMemberAt(undefined, member('idle'), 2 + 0.5);
  m = ui.mergeMemberAt(m, member('offline'), 2 + 0.5);
  assert.equal(m.status, 'offline');
  assert.equal(m.statusAt, 2.5);
  // Events up to that seq still cannot bring the old online state back.
  for (const seq of [1, 2]) m = ui.mergeMemberAt(m, member('idle'), seq);
  assert.equal(m.status, 'offline');
  // A newer event wins, and a snapshot at the older seq answered after it does not undo it.
  m = ui.mergeMemberAt(m, member('idle'), 3);
  assert.equal(ui.mergeMemberAt(m, member('offline'), 2 + 0.5).status, 'idle');
});

test('web ui: a native sibling can show a shared busy channel without overriding a newer snapshot', () => {
  const native = { id: 'm', clusterId: 'c', harness: 'mock', mode: 'native', name: 'A', status: 'busy', removedAt: null };
  assert.equal(ui.memberStatus(native, true, false), 'busy', 'busy from another membership occupies this channel too');
  assert.equal(ui.memberStatusLabel(native, 'busy'), '投递通道占用');
  let current = ui.mergeMemberAt(undefined, { ...native, status: 'idle' }, 5.5);
  current = ui.mergeMemberAt(current, native, 5);
  assert.equal(ui.memberStatus(current, true, false), 'idle', 'a stale busy event cannot override the restart snapshot');
  assert.equal(ui.memberStatus({ ...current, status: 'offline' }, true, true), 'busy', 'a local running delivery remains busy');
  assert.equal(ui.memberStatus({ ...native, removedAt: 'now' }, true, true), 'offline');
  assert.equal(ui.memberStatus(native, false, true), 'offline');
});

test('web ui: conversations combine active memberships by harness and session ID', () => {
  const member = (id: string, clusterId: string, name: string, extra: object = {}) =>
    ({ id, clusterId, name, harness: 'mock', workerSessionId: 's1', removedAt: null, ...extra });
  const rows = ui.conversations([
    member('a', 'one', '甲'), member('b', 'two', '乙'), member('old', 'three', '移出', { removedAt: 'now' }),
    member('c', 'one', '无会话', { workerSessionId: '' }), member('d', 'one', '别家', { harness: 'other' }),
    member('e', 'one', '另一个会话', { workerSessionId: 's2' }),
  ], [{ id: 'one', name: '第一群' }, { id: 'two', name: '第二群' }]);
  assert.equal(rows.length, 4);
  const shared = rows.find((r: any) => r.harness === 'mock' && r.sessionId === 's1');
  assert.deepEqual(shared.memberships, [
    { clusterId: 'one', clusterName: '第一群', memberId: 'a', memberName: '甲' },
    { clusterId: 'two', clusterName: '第二群', memberId: 'b', memberName: '乙' },
  ]);
  assert.deepEqual(ui.conversations([], []), []);
});

test('web ui activity: report only observed facts, expire the channel and retain timestamped history on failure', () => {
  const seen = '2026-11-07T12:00:00.000Z';
  const at = '2026-11-07T11:59:58.000Z';
  const now = Date.parse(seen);
  const base = { state: 'observing', source: 'deepseek', lastSeenAt: seen, lastActivityAt: at, staleAfterMs: 45_000 };
  assert.deepEqual(ui.activitySummary(null, false, now), { state: '暂无观察', source: null, hasChannel: false, seen: null, activity: null });
  assert.equal(ui.activitySummary(null, true, now).hasChannel, false, 'a failed query without evidence does not add channel details');
  for (const [kind, phase, label] of [
    ['tool', 'requested', '工具请求'], ['tool', 'started', '工具开始/分派'], ['tool', 'finished', '工具返回'],
    ['tool', 'failed', '工具失败'], ['turn', 'started', '轮次开始'], ['turn', 'finished', '轮次结束'], ['turn', 'failed', '轮次失败'],
  ]) {
    const summary = ui.activitySummary({ ...base, event: { kind, phase, toolName: 'read_file' } }, false, now);
    assert.equal(summary.state, '观察中');
    assert.match(summary.activity, new RegExp(label));
    assert.equal(summary.activity.includes('read_file'), kind === 'tool');
  }
  const history = ui.activitySummary({ ...base, event: { kind: 'tool', phase: 'finished', toolName: 'read_file' } }, true, now);
  assert.equal(history.state, '观察查询暂不可用');
  assert.equal(history.hasChannel, true, 'a failed query keeps previously observed channel details');
  assert.ok(history.seen && history.activity.includes('工具返回 read_file'));
  assert.equal(ui.activitySummary({ ...base }, false, now + 45_001).state, '观察已过期');
  assert.equal(ui.activitySummary({ ...base, state: 'disconnected' }, false, now).state, '观察已断开');
  assert.equal(ui.activitySummary({ ...base, state: 'unknown' }, false, now).state, '仅历史');
  assert.equal(ui.activitySummary({ ...base, lastSeenAt: null }, false, now).state, '观察已过期');
  assert.equal(ui.activitySummary({ state: 'disconnected' }, false, now).hasChannel, true, 'a known disconnected channel still has details');
  for (const bad of ['<script>alert(1)</script>', 'x'.repeat(65), 'has space']) {
    const summary = ui.activitySummary({ ...base, source: bad, event: { kind: 'tool', phase: 'requested', toolName: bad } }, false, now);
    assert.equal(summary.source, null);
    assert.ok(summary.activity.endsWith('工具请求'));
    assert.ok(!summary.activity.includes(bad));
  }
});

test('web ui activity: a shared conversation chooses a dated membership without copying it to the other group', () => {
  const memberships = [{ memberId: 'old', clusterName: '第一群' }, { memberId: 'new', clusterName: '第二群' }];
  const old = { state: 'disconnected', lastSeenAt: '2026-11-07T12:00:00.000Z', lastActivityAt: null };
  const activity = new Map<string, { state: string; lastSeenAt: string | null; lastActivityAt: string | null }>([
    ['old', old], ['new', { state: 'unknown', lastSeenAt: null, lastActivityAt: null }],
  ]);
  assert.deepEqual(ui.conversationActivity(memberships, activity), { membership: memberships[0], snapshot: old });
  assert.equal(activity.get('new')?.state, 'unknown');
  assert.equal(ui.conversationActivity([memberships[1]], activity), null);
  activity.set('new', { state: 'observing', lastSeenAt: '2026-11-07T12:01:00.000Z', lastActivityAt: null });
  assert.equal(ui.conversationActivity(memberships, activity).membership.memberId, 'new');
});

test('web ui activity: slow requests complete, hung requests time out, and navigation or hiding cancels them', async () => {
  const app = readFileSync(join(REPO_ROOT, 'src/web/public/app.js'), 'utf8');
  const start = app.indexOf('// Activity is a read-only snapshot');
  const end = app.indexOf('\nfunction activityEl', start);
  assert.ok(start >= 0 && end > start);
  let now = Date.parse('2026-11-07T12:00:00Z');
  let nextTimer = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const intervals: (() => void)[] = [];
  const handlers = new Map<string, () => void>();
  const calls: { path: string; signal: AbortSignal; ignoreAbort: boolean; resolve: (response: unknown) => void; reject: (error: Error) => void }[] = [];
  const state = { sel: { cluster: 'a', overview: false }, members: new Map([
    ['a', { id: 'a', clusterId: 'a', removedAt: null }], ['b', { id: 'b', clusterId: 'b', removedAt: null }],
  ]), activity: new Map<string, any>(), activityFailed: false };
  const document = { visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => handlers.set(name, fn) };
  const location = { hash: '#c=a' };
  const renderedStates: string[] = [];
  class ClockDate extends Date { static now() { return now; } }
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const endAt = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= endAt).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = endAt;
    await flush();
  };
  const context: any = {
    S: state, activityReady: true, hubCheckPending: false, document, location, URLSearchParams, AbortController, Date: ClockDate,
    render() { renderedStates.push(ui.activitySummary(state.activity.get(state.sel.cluster), state.activityFailed, now).state); },
    setInterval(fn: () => void, ms: number) { assert.equal(ms, 10_000); intervals.push(fn); return 1; },
    setTimeout(fn: () => void, ms: number) { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch(path: string, options: { method: string; signal: AbortSignal }) {
      assert.equal(options.method, 'GET');
      let resolve!: (response: unknown) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      const call = { path, signal: options.signal, ignoreAbort: false, resolve, reject };
      options.signal.addEventListener('abort', () => { if (!call.ignoreAbort) reject(new Error('aborted')); }, { once: true });
      calls.push(call);
      return promise;
    },
  };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.activityTest = { syncActivityScope, loadActivity };`, context);
  const respond = async (index: number, memberId: string, source: string) => {
    const snapshot = { state: 'observing', source, lastSeenAt: new Date(now).toISOString(), lastActivityAt: null, event: null, staleAfterMs: 45_000 };
    calls[index].resolve({ ok: true, json: async () => ({ members: [{ memberId, activity: snapshot }] }) });
    await flush();
  };
  context.activityTest.syncActivityScope();
  assert.equal(calls.length, 1);
  for (let i = 0; i < 3; i++) {
    await advance(10_000);
    intervals[0]();
    assert.equal(calls.length, i + 1, 'the ten-second poll does not replace a still-running request');
    await advance(1_000);
    await respond(i, 'a', `slow-${i}`);
    assert.equal(state.activity.get('a')?.source, `slow-${i}`, 'an eleven-second response is applied');
    if (i < 2) { await advance(9_000); intervals[0](); }
  }
  await advance(9_000); intervals[0]();
  const hung = calls[3];
  await advance(10_000); intervals[0]();
  await advance(10_000); intervals[0]();
  assert.equal(calls.length, 4, 'only one hung request exists before timeout');
  await advance(5_000);
  assert.equal(hung.signal.aborted, true);
  assert.equal(state.activityFailed, true);
  assert.equal(state.activity.get('a')?.source, 'slow-2', 'history survives a timeout');
  assert.notEqual(ui.activitySummary(state.activity.get('a'), state.activityFailed, now).state, '观察中');
  await advance(5_000); intervals[0]();
  assert.equal(calls.length, 5, 'the next poll retries');
  await respond(4, 'a', 'recovered');
  assert.equal(state.activityFailed, false);
  assert.equal(state.activity.get('a')?.source, 'recovered');

  await advance(10_000); intervals[0]();
  const late = calls[5];
  late.ignoreAbort = true;   // a response already racing with cancellation must still be ignored
  location.hash = '#c=b'; state.sel.cluster = 'b'; context.activityTest.syncActivityScope();
  assert.equal(late.signal.aborted, true);
  assert.equal(calls.length, 7, 'the new view starts immediately');
  await respond(5, 'a', 'late-old-view');
  assert.equal(state.activity.get('a')?.source, 'recovered');
  await respond(6, 'b', 'new-view');
  assert.equal(state.activity.get('b')?.source, 'new-view');

  intervals[0]();
  const hidden = calls[7];
  document.visibilityState = 'hidden'; handlers.get('visibilitychange')!();
  assert.equal(hidden.signal.aborted, true);
  await advance(30_000); intervals[0]();
  assert.equal(calls.length, 8, 'hidden pages do not poll');
  document.visibilityState = 'visible'; handlers.get('visibilitychange')!();
  assert.equal(calls.length, 9, 'restoring visibility refreshes immediately');
  await respond(8, 'b', 'visible-again');
  assert.equal(state.activity.get('b')?.source, 'visible-again');

  intervals[0]();
  const toOverview = calls[9];
  location.hash = '#view=conversations'; state.sel.overview = true; context.activityTest.syncActivityScope();
  assert.equal(toOverview.signal.aborted, true);
  assert.equal(calls[10].path, '/api/activity', 'overview immediately requests its own scope');
  calls[10].ignoreAbort = true;
  location.hash = '#c=a'; state.sel.overview = false; state.sel.cluster = 'a'; context.activityTest.syncActivityScope();
  assert.equal(calls[10].signal.aborted, true);
  await respond(10, 'b', 'late-overview');
  assert.equal(state.activity.get('b')?.source, 'visible-again');
  await respond(11, 'a', 'from-cluster');
  await advance(45_001);
  assert.equal(renderedStates.at(-1), '观察已过期', 'the existing expiry timer still redraws without a poll');
});

test('web ui: moving a member warns about other clusters, an offline target, another directory and a turn in flight', () => {
  const member = { clusterId: 'a', cwd: 'C:\\work\\repo' };
  const memberships = [{ clusterId: 'b', clusterName: '第二群', memberName: '乙' }];
  assert.deepEqual(ui.rebindWarnings(member, { online: true, cwd: 'c:/work/repo/', memberships: [] }), [], 'the same directory, however written, needs no warning');
  const warnings = ui.rebindWarnings(member, { online: false, cwd: 'C:\\other', memberships }, { busy: true });
  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /第二群（群内名：乙）/);
  assert.match(warnings[1], /离线.*不会重发/);
  assert.match(warnings[2], /C:\\other/);
  assert.match(warnings[3], /结果会记为未知/);
});

test('web ui: moving a member: a project switch or refresh drops the pick at once, so a delayed or failed list cannot submit the old target', async () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('function openRebind(memberId)');
  const end = app.indexOf("$('panel-add').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  const node = (tag: string, props: any = {}, ...children: any[]): any => ({
    tag, props, children: children.flat(Infinity), listeners: {} as Record<string, any>, value: props.value ?? '', disabled: Boolean(props.disabled), checked: false, options: [] as any[],
    addEventListener(type: string, fn: any) { this.listeners[type] = fn; }, replaceChildren(...items: any[]) { this.children = items.flat(Infinity); },
    querySelector(selector: string) { return this.children.find((c: any) => c?.tag === selector); }, focus() {}, showModal() {}, close() {}, remove() {},
  });
  const find = (n: any, wanted: (x: any) => boolean): any => {
    if (!n || typeof n !== 'object') return null;
    if (wanted(n)) return n;
    for (const c of n.children) { const hit = find(c, wanted); if (hit) return hit; }
    return null;
  };
  const lists = new Map<string, PromiseWithResolvers<any[]>>();
  const projectList = (name: string) => { const w = Promise.withResolvers<any[]>(); lists.set(name, w); return w; };
  const posts: any[] = [];
  let rows: { pick(): void }[] = [];
  let dialog: any;
  const member = { id: 'm', name: 'A', harness: 'mock', clusterId: 'c', cwd: 'p0', workerSessionId: 's0' };
  const context: any = {
    h: node, S: { members: new Map([['m', member]]) }, harnessPath: (_h: string, rest: string) => rest, loadProjects: async () => true,
    statusOf: () => 'idle', rebindWarnings: () => [], upsertMember() {}, render() {}, document: { body: { append: (d: any) => { dialog = d; } } },
    sessionAvailability: () => ({ disabled: false }),
    sessionRow: (s: any, _picked: unknown, toggle: any) => { const row = node('label'); row.pick = () => toggle(s, true); rows.push(row); return row; },
    api: (method: string, path: string, body: unknown) => {
      if (method === 'POST') { posts.push(body); return Promise.resolve({ member }); }
      return lists.get(decodeURIComponent(path.split('project=')[1]))!.promise;
    },
  };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.openRebind = openRebind;`, context);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  context.openRebind('m');
  await flush();
  const project = find(dialog, (n) => n.tag === 'select');
  const stopped = find(dialog, (n) => n.props.type === 'checkbox');
  const submit = find(dialog, (n) => n.props.type === 'submit');
  const refresh = find(dialog, (n) => String(n.props.class).includes('refresh'));
  const list = find(dialog, (n) => n.props.class === 'sessions');
  const form = find(dialog, (n) => n.tag === 'form');
  const trySubmit = async () => { await form.listeners.submit({ preventDefault() {} }); await flush(); };
  const open = async (name: string, sessions: any[]) => {
    const w = projectList(name);
    project.value = name;
    project.listeners.change();
    rows = [];
    w.resolve(sessions);
    await flush();
  };
  const pickFirst = () => { rows[0].pick(); stopped.checked = true; stopped.listeners.change(); assert.equal(submit.disabled, false, 'picked and confirmed'); };

  await open('p1', [{ id: 's1', cwd: 'p1' }]);
  pickFirst();
  const delayed = projectList('p2');
  project.value = 'p2';
  project.listeners.change();
  assert.equal(submit.disabled, true, 'disabled as soon as the switch starts, before the list answers');
  await trySubmit();
  assert.deepEqual(posts, [], 'the previous project\'s pick cannot be submitted');
  rows = [];
  delayed.resolve([{ id: 's2', cwd: 'p2' }]);
  await flush();
  assert.equal(submit.disabled, true, 'nothing is picked in the new list until the user picks');

  pickFirst();
  const failed = projectList('p3');
  project.value = 'p3';
  project.listeners.change();
  failed.reject(new Error('boom'));
  await flush();
  assert.equal(submit.disabled, true, 'a failed list leaves nothing to submit');
  assert.match(list.children[0].children[0], /对话加载失败：boom/);
  await trySubmit();
  assert.deepEqual(posts, []);

  await open('p1', [{ id: 's1', cwd: 'p1' }]);
  pickFirst();
  const refreshed = projectList('p1');
  void refresh.listeners.click();
  assert.equal(submit.disabled, true, 'a refresh drops the pick too');
  rows = [];
  refreshed.resolve([{ id: 's1', cwd: 'p1' }]);
  await flush();
  pickFirst();
  await trySubmit();
  assert.equal(JSON.stringify(posts), JSON.stringify([{ harness: 'mock', sessionId: 's1', confirmStopped: true }]), 'a pick from the list on screen still goes through');
});

test('web ui: existing sessions remain selectable across groups but not within the target', () => {
  const memberships = [{ clusterId: 'a', clusterName: '第一群', memberId: 'm1', memberName: '甲', mode: 'native' }];
  const session = { memberId: 'm1', memberships };
  assert.equal(ui.sessionAvailability(session, null).disabled, false, 'new cluster may attach an existing native session');
  assert.equal(ui.sessionAvailability(session, 'b').disabled, false, 'another cluster may attach it');
  assert.equal(ui.sessionAvailability(session, 'a').reason, '已在当前群');
  assert.equal(ui.sessionAvailability({ memberId: 'old' }, 'b').disabled, true, 'older Hub without memberships stays conservative');
  assert.equal(ui.sessionAvailability({ memberId: null }, null).disabled, false);
});

test('web ui: the same member specs form create or add requests without introducing a second form schema', () => {
  const specs = ui.harnessSpecs({ ...base, create: true, name: 'review', model: 'gpt-a', effort: 'high' }).specs;
  assert.deepEqual(ui.memberSubmission(null, 'team', specs), { path: '/api/clusters', body: { name: 'team', members: specs } });
  assert.deepEqual(ui.memberSubmission('c /1', 'ignored', specs), { path: '/api/clusters/c%20%2F1/members', body: { members: specs } });
});

test('web ui: receipt rows are the member-id union of delivery, read and acknowledgement evidence', () => {
  const deliveries = [{ memberId: 'a', state: 'done' }, { memberId: 'b', state: 'offline', error: 'offline' }];
  const reads = [{ memberId: 'a', via: 'delivery' }, { memberId: 'b', via: 'read_messages' },
    { memberId: 'c', via: 'ack_messages' }, { memberId: 'c', via: 'read_messages' }, { memberId: 'old' }];
  const acknowledgements = [{ memberId: 'a', at: '2026-11-07T12:00:00Z' }, { memberId: 'd', at: '2026-11-07T12:00:01Z' }];
  const rows = ui.receiptMembers(deliveries.values(), reads, acknowledgements);
  assert.deepEqual(rows.map((r: any) => r.memberId), ['a', 'b', 'c', 'old', 'd']);
  assert.deepEqual(rows[0], { memberId: 'a', delivery: deliveries[0], read: reads[0], acknowledgement: acknowledgements[0] });
  assert.deepEqual(rows[1], { memberId: 'b', delivery: deliveries[1], read: reads[1], acknowledgement: null });
  assert.deepEqual(rows[2], { memberId: 'c', delivery: null, read: reads[2], acknowledgement: null }, 'ACK source is not replaced by a duplicate read');
  assert.deepEqual(rows[4], { memberId: 'd', delivery: null, read: null, acknowledgement: acknowledgements[1] });
  assert.deepEqual(ui.receiptMembers([], [], []), []);
});

test('web ui: delivery results follow evidence and handoff requires a stopped confirmation only when uncertain', () => {
  const cases = [
    [{ state: 'done', outcome: null }, '投递流程结束', false, false],
    [{ state: 'done', outcome: 'accepted' }, '已接收', false, false],
    [{ state: 'done', outcome: 'completed' }, '轮次完成', false, false],
    [{ state: 'failed', outcome: 'failed' }, '轮次失败', true, false],
    [{ state: 'failed', outcome: 'unknown' }, '结果未知', true, true],
    [{ state: 'failed', outcome: 'accepted' }, '已接收', true, true],
    [{ state: 'done', outcome: 'unknown' }, '结果未知', true, true],
    [{ state: 'failed', outcome: null }, '失败', true, true],
    [{ state: 'offline', outcome: null }, '离线，未投递', true, false],
    [{ state: 'superseded', outcome: null }, '已被新的提名取代，未投递', false, false],
    [{ state: 'superseded', outcome: 'unknown' }, '已被新的提名取代，未投递', false, false],
    [{ state: 'running', outcome: null }, '处理中', false, false],
  ];
  for (const [delivery, label, handoff, confirm] of cases as any[]) {
    assert.equal(ui.deliveryView(delivery).label, label);
    assert.equal(ui.canHandoff(delivery), handoff);
    assert.equal(ui.handoffNeedsConfirmation(delivery), confirm);
  }
  assert.equal(ui.canHandoff({ state: 'failed', outcome: 'unknown', handoffMessageId: 'message' }), false);
  assert.equal(ui.deliveryProblem({ state: 'superseded', outcome: 'unknown' }), false);
  assert.equal(ui.deliveryProblem({ state: 'failed', outcome: null }), true);
  assert.equal(ui.deliveryProblem({ state: 'offline', outcome: null }), true);
});

test('web ui: delivery advice tells each case apart, and a stage without a record reads as unknown', () => {
  const advice = (diagnosis: string, handoffMessageId: string | null = null) => ui.deliveryAdvice({ diagnosis, handoffMessageId });
  const distinct = ['paused_global', 'paused_cluster', 'hourly_limit', 'chain_limit', 'offline', 'failed', 'unknown'];
  assert.equal(new Set(distinct.map((d) => advice(d).reason)).size, distinct.length, 'the reasons the user must tell apart');
  for (const diagnosis of [...distinct, 'checking_online', 'notice_limit', 'busy', 'queued', 'running', 'superseded', 'accepted', 'completed', 'done']) {
    const view = advice(diagnosis);
    assert.ok(view.stage && view.reason && view.next, diagnosis);
  }
  assert.match(advice('paused_global').reason, /全部投递已暂停/);
  assert.match(advice('paused_cluster').reason, /本群已暂停/);
  assert.match(advice('chain_limit').stage, /防循环/);
  assert.match(advice('offline').reason, /不会自动补发/);
  assert.match(advice('unknown').reason, /可能已经送达/);
  assert.match(advice('offline', 'new-message').next, /新消息的回执/);

  assert.deepEqual(ui.timelineStageView({ key: 'started', status: 'unknown', at: null }), { label: '开始投递', value: '未知' });
  assert.equal(ui.timelineStageView({ key: 'accepted', status: 'reached', at: null }).value, '已发生，时间未知');
  assert.equal(ui.timelineStageView({ key: 'ended', status: 'pending', at: null }).value, '还没有');
  assert.equal(ui.timelineStageView({ key: 'accepted', status: 'not_reached', at: null }).value, '没有发生');
  assert.match(ui.timelineStageView({ key: 'queued', status: 'reached', at: '2026-11-09T01:02:03.000Z' }).value, /2026/);
  for (const blocked of ['offline', 'removed', 'hop_limit', 'chain_limit']) assert.ok(ui.resendBlockedText(blocked), blocked);
});

test('web ui: the page has no way to resend except the user pressing the button in the receipt panel', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('function openResend(');
  const dialog = app.slice(start, app.indexOf('\nfunction openHandoff(', start));
  assert.match(dialog, /confirmDuplicate: true/);
  assert.match(dialog, /required: true/, 'the duplicate-risk box must be ticked to submit');
  assert.match(dialog, /可能重复执行/);
  // The only callers of the resend endpoint and the dialog: not the event handling and not a timer.
  assert.equal(app.split('/resend`').length - 1, 1);
  assert.equal(app.split('openResend(').length - 1, 2, 'its definition and the receipt button');
  assert.doesNotMatch(app.slice(app.indexOf('function resendAction('), app.indexOf('function receiptsEl(')), /setTimeout|setInterval/);
});

test('web ui: the page says the Hub keeps running when closed, and "退出 orrery" confirms, posts JSON and stops reconnecting', () => {
  const pub = join(REPO_ROOT, 'src', 'web', 'public');
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  assert.match(html, /Hub 在后台运行，关掉这个页面不会停止它。/);
  assert.match(html, /<button id="quit"[^>]*><span data-i18n="退出 orrery">退出 orrery<\/span><\/button>/);
  assert.match(html, /<div id="quit-screen"[^>]*hidden>\s*<p><span data-i18n="orrery 已退出，可以关闭这个页面。">orrery 已退出，可以关闭这个页面。<\/span><\/p>/);
  // Asked in the page (danger style); cancelling returns before the request.
  assert.match(app, /const ok = await confirmDialog\(\{[^}]*message: lt\('退出后 Hub 停止，群员收不到新消息，直到你再次打开 orrery。'\)[^}]*danger: true,?\s*\}\);\s*if \(!ok\) return;[\s\S]*api\('POST', '\/api\/shutdown', \{\}\)/);
  assert.match(app, /api\('POST', '\/api\/shutdown', \{\}\)/);   // api() sends content-type: application/json
  assert.match(app, /noticeDialog\(lt\('退出失败：\{message\}', \{ message: e\.message \}\)\)/);
  assert.match(app, /function connect\(since, rebuilt = false\) \{\n  if \(quitting \|\| denied\) return;/);
});

test('web ui: the #token= fragment becomes the session cookie before any other request; a 401 stops reconnecting', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.slice(app.indexOf('// ---- start ----'));
  // The exchange is the first thing the start section does, and the fragment is dropped right after it.
  assert.match(start, /^\/\/ ---- start ----\n\n(\/\/[^\n]*\n)*const hashToken = new URLSearchParams\(location\.hash\.slice\(1\)\)\.get\('token'\);\nif \(hashToken !== null\) \{\n  try \{\n    await fetch\('\/api\/session', \{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}, body: JSON\.stringify\(\{ token: hashToken \}\) \}\);\n  \} catch \{[^\n]*\n  history\.replaceState\(null, '', location\.pathname \+ location\.search\);\n\}\nreadHash\(\);/);
  // The start section's first api() call is the initial load, after the exchange.
  assert.equal(start.indexOf('api('), start.indexOf("api('GET', '/api/harnesses')"));
  // Every way the page talks to /api/* notices a 401: api(), the upload, the skill ZIP upload, the health check, and the stream rebuild.
  assert.equal(app.match(/status === 401\) (return )?unauthorized\(\)/g)?.length, 5);
  assert.match(app, /if \(es\.readyState === EventSource\.CLOSED\) setTimeout\(reconnect, 3000\);/);
  assert.match(app, /function unauthorized\(\) \{\n  if \(denied\) return;\n  denied = true;\n  stream\?\.close\(\);\n  setConn\(false\);[^\n]*\n  noticeDialog\(/);
  // The status line says why the page stopped, not "已连接" or "重连中" (review api-token r1, P2).
  assert.match(app, /denied \? t\('未通过验证'\)/);
});

test('web ui: each limit setting shows its effective value and source; unlimited reads "…：无限"', () => {
  const settings = (maxHops: unknown, source: string, maxTurnsPerChain: unknown, maxTurnsPerChainSource: string) =>
    ({ maxHops, source, maxTurnsPerChain, maxTurnsPerChainSource });
  const defaults = settings({ kind: 'finite', value: 6 }, 'default', { kind: 'finite', value: 20 }, 'default');
  assert.deepEqual(ui.limitView('maxHops', defaults), { label: '跳数上限：6', unlimited: false, source: '默认值' });
  assert.deepEqual(ui.limitView('maxTurnsPerChain', defaults), { label: '每条链轮次上限：20', unlimited: false, source: '默认值' });
  const other = settings({ kind: 'finite', value: 0 }, 'startup', { kind: 'unlimited' }, 'saved');
  assert.deepEqual(ui.limitView('maxHops', other), { label: '跳数上限：0', unlimited: false, source: '来自 ORRERY_MAX_HOPS，保存后以这里为准' });
  assert.deepEqual(ui.limitView('maxTurnsPerChain', other),
    { label: '每条链轮次上限：无限', unlimited: true, source: '已在网页上保存；ORRERY_MAX_TURNS_PER_CHAIN 不再起作用' });
  const swapped = settings({ kind: 'unlimited' }, 'saved', { kind: 'finite', value: 3 }, 'startup');
  assert.deepEqual(ui.limitView('maxHops', swapped), { label: '跳数上限：无限', unlimited: true, source: '已在网页上保存；ORRERY_MAX_HOPS 不再起作用' });
  assert.deepEqual(ui.limitView('maxTurnsPerChain', swapped),
    { label: '每条链轮次上限：3', unlimited: false, source: '来自 ORRERY_MAX_TURNS_PER_CHAIN，保存后以这里为准' });
  // Not known yet (no snapshot, or only an older hop-only 'settings' event): nothing to show.
  assert.equal(ui.limitView('maxHops', null), null);
  assert.equal(ui.limitView('maxTurnsPerChain', { maxHops: { kind: 'finite', value: 6 }, source: 'saved' }), null);
});

test('web ui: coordinator notification settings show their value and source, and send a non-negative integer', () => {
  const settings = { stalledMemberMinutes: 0, stalledMemberMinutesSource: 'saved' };
  assert.deepEqual(ui.notifyView('stalledMemberMinutes', settings),
    { label: '成员无活动提醒阈值：0 分钟', value: 0, source: '已在网页上保存' });
  assert.equal(ui.notifyView('stalledMemberMinutes', null), null);
  assert.equal(ui.notifyView('stalledMemberMinutes', {}), null);
  assert.deepEqual(ui.notifySubmission('stalledMemberMinutes', ' 0 '), { body: { stalledMemberMinutes: 0 } });
  assert.deepEqual(ui.notifySubmission('stalledMemberMinutes', '30'), { body: { stalledMemberMinutes: 30 } });
  for (const value of ['', '-1', '1.5', 'abc', '1e3', '99999999999999999']) {
    assert.ok(ui.notifySubmission('stalledMemberMinutes', value).error, value);
  }
  // The dialog has the form and the page sends one setting per request.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="stalled-form"'));
  assert.match(app, /const NOTIFY_FORMS = \[/);
  assert.match(app, /const sub = notifySubmission\(f\.setting, \$f\('value'\)\.value\);/);
  assert.match(app, /api\('PATCH', '\/api\/settings', sub\.body\)/);
});

test('web ui: a limit form sends a finite integer, or unlimited only with the contract warning to confirm', () => {
  const contract = readFileSync(join(REPO_ROOT, 'docs', 'hop-limit.md'), 'utf8');
  for (const setting of ['maxHops', 'maxTurnsPerChain']) {
    assert.deepEqual(ui.limitSubmission(setting, { unlimited: false, value: ' 10 ' }), { body: { [setting]: { kind: 'finite', value: 10 } } });
    assert.deepEqual(ui.limitSubmission(setting, { unlimited: false, value: '0' }), { body: { [setting]: { kind: 'finite', value: 0 } } });
    for (const value of ['', '-1', '1.5', 'abc', '1e3', '99999999999999999']) {
      assert.ok(ui.limitSubmission(setting, { unlimited: false, value }).error, value);
    }
    const unlimited = ui.limitSubmission(setting, { unlimited: true, value: '' });
    assert.deepEqual(unlimited.body, { [setting]: { kind: 'unlimited' }, confirmUnlimited: true });
    assert.equal(unlimited.confirm.message, ui.UNLIMITED_WARNING[setting]);
    assert.equal(unlimited.confirm.danger, true);
    // The warning is the contract's text, word for word.
    assert.ok(contract.includes(`> ${ui.UNLIMITED_WARNING[setting]}`), `UNLIMITED_WARNING.${setting} matches docs/hop-limit.md`);
  }
  assert.equal(ui.limitSubmission('maxHops', { unlimited: false, value: 'x' }).error, '跳数上限要填非负整数，或勾选"无限"');
  assert.equal(ui.limitSubmission('maxTurnsPerChain', { unlimited: true, value: '' }).confirm.title, '把每条链轮次上限设为无限？');
  // The chain warning says plainly what then stops agents @-ing each other.
  assert.match(ui.UNLIMITED_WARNING.maxTurnsPerChain, /互相 @ 下去，直到每小时轮次上限或暂停开关让它们停下/);
  // The page asks before sending, and sends nothing when cancelled.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(sub\.confirm && !\(await confirmDialog\(liveAsk\(\(\) => limitSubmission\(f\.setting, input\)\.confirm\)\)\)\) \{[^}]*return;\s*\}[\s\S]*api\('PATCH', '\/api\/settings', sub\.body\)/);
});

test('web ui: confirm and notice dialogs open one at a time; a later one waits until the earlier has closed', async () => {
  const opened: string[] = [];
  const close: Array<(v: unknown) => void> = [];
  const show = ui.oneAtATime((name: string) => {
    opened.push(name);
    return new Promise((resolve, reject) => close.push((v) => (v instanceof Error ? reject(v) : resolve(v))));
  });
  const settle = () => new Promise((r) => setImmediate(r));
  const a = show('a');
  const b = show('b');
  const c = show('c');
  await settle();
  assert.deepEqual(opened, ['a'], 'b and c wait while a is open');
  close[0](true);
  assert.equal(await a, true);
  await settle();
  assert.deepEqual(opened, ['a', 'b']);
  close[1](new Error('boom'));
  await assert.rejects(b, /boom/);
  await settle();
  assert.deepEqual(opened, ['a', 'b', 'c'], 'a failed dialog does not block the next');
  close[2](false);
  assert.equal(await c, false);
});

test("web ui: the page never uses the browser's own confirm, alert or prompt dialogs", () => {
  const pub = join(REPO_ROOT, 'src', 'web', 'public');
  // A call of the global function (bare or via window/globalThis/self); confirmDialog(, sub.confirm, x.alert( do not match.
  const NATIVE = /(?<![\w$.])(?:(?:window|globalThis|self)\.)?(?:confirm|alert|prompt)\s*\(/;
  // A local function declaration is not a call to the browser's dialog API.
  const calls = (source: string) => source.replace(/\bfunction\s+(?:confirm|alert|prompt)\s*\(/g, 'function localDialog(');
  for (const f of readdirSync(pub, { withFileTypes: true, recursive: true })) {
    if (!f.isFile() || !/\.(?:js|html)$/.test(f.name)) continue;
    const file = join(f.parentPath, f.name);
    assert.doesNotMatch(calls(readFileSync(file, 'utf8')), NATIVE, file);
  }
  assert.match('if (!confirm("x")) return;', NATIVE);
  assert.match('window.alert(e.message)', NATIVE);
  assert.doesNotMatch(calls('async function confirm() {}'), NATIVE);
  assert.match('const v = prompt ("name")', NATIVE);
  assert.doesNotMatch('await confirmDialog({ message }); sub.confirm && noticeDialog(m)', NATIVE);
});

test('web ui: the name/avatar editor sends only what changed; an image wins over the emoji and is checked first', async () => {
  const m = { id: 'm1', name: 'rev', avatar: '🦊' };
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const read = async () => png;
  assert.deepEqual(await ui.editFields(m, { name: ' rev ', emoji: ' 🦊 ' }, read), { fields: {} });
  assert.deepEqual(await ui.editFields(m, { name: 'rev2', emoji: '🐼' }, read), { fields: { name: 'rev2', avatar: '🐼' } });
  assert.deepEqual(await ui.editFields(m, { name: 'rev', emoji: '🐼', file: { type: 'image/png' } }, read), { fields: { avatar: png } });
  assert.match((await ui.editFields(m, { name: 'rev', emoji: '', file: { type: 'image/svg+xml' } }, read)).error, /只支持/);
  assert.match((await ui.editFields(m, { name: 'rev', emoji: '', file: { type: 'image/png' } }, async () => 'data:image/png;base64,' + 'A'.repeat(ui.MAX_AVATAR))).error, /图片太大/);
  assert.match((await ui.editFields(m, { name: 'rev', emoji: '', file: { type: 'image/png' } }, async () => 'data:image/svg+xml;base64,AA==')).error, /无法识别/);
  // A preset is a reference (not image bytes); a typed emoji or an upload still wins over it, and an unchanged pick sends nothing.
  assert.deepEqual(await ui.editFields(m, { name: 'rev', emoji: '', preset: 'claude' }, read), { fields: { avatar: 'preset:claude' } });
  assert.deepEqual(await ui.editFields({ ...m, avatar: 'preset:claude' }, { name: 'rev', emoji: '', preset: 'claude' }, read), { fields: {} });
  assert.deepEqual(await ui.editFields(m, { name: 'rev', emoji: '🐼', preset: 'claude' }, read), { fields: { avatar: '🐼' } });
  assert.deepEqual(await ui.editFields(m, { name: 'rev', emoji: '', preset: 'claude', file: { type: 'image/png' } }, read), { fields: { avatar: png } });
});

test('web ui: the member panel list edits only an active member of that cluster', () => {
  const members = [{ id: 'a', clusterId: 'c1' }, { id: 'b', clusterId: 'c1', removedAt: '2026-11-01T00:00:00Z' }, { id: 'c', clusterId: 'c2' }];
  assert.deepEqual(ui.activeMembers(members, 'c1').map((m: { id: string }) => m.id), ['a'], 'rows, so edit entries, are active members only');
  assert.equal(ui.activeMember(members, 'c1', 'a')?.id, 'a');
  assert.equal(ui.activeMember(members, 'c1', 'b'), null, 'removed');
  assert.equal(ui.activeMember(members, 'c1', 'c'), null, 'another cluster');
  assert.equal(ui.activeMember(members, 'c1', null), null);
});

test('web ui: files over 20 MB or past 10 per message are refused with a message in the page', () => {
  const mb = 1024 * 1024;
  const r = ui.pickFiles(8, [{ name: 'a.txt', size: 10 }, { name: 'big.iso', size: 20 * mb + 1 }, { name: 'b.txt', size: 20 * mb }, { name: 'c.txt', size: 1 }]);
  assert.deepEqual(r.accepted.map((f: any) => f.name), ['a.txt', 'b.txt']);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /「big\.iso」有 20\.0 MB，超过单个文件 20 MB 的上限/);
  assert.match(r.errors[1], /最多带 10 个文件，「c\.txt」没有加上/);
  assert.deepEqual(ui.pickFiles(0, []), { accepted: [], errors: [] });
  assert.deepEqual([ui.fmtSize(0), ui.fmtSize(1023), ui.fmtSize(1536), ui.fmtSize(5 * mb)], ['0 B', '1023 B', '1.5 KB', '5.0 MB']);
  assert.equal(ui.pasteName('image/jpeg', new Date(2026, 10, 1, 9, 5, 7)), '粘贴的图片-20261101-090507.jpg');
  assert.equal(ui.pasteName('image/x-unknown', new Date(2026, 0, 2, 3, 4, 5)), '粘贴的图片-20260102-030405.png');
  assert.ok(ui.isImage('image/webp') && !ui.isImage('image/svg+xml') && !ui.isImage('text/html') && !ui.isImage(undefined));
});

test('web ui: attachment notices are kept per target; clearing one leaves the others', () => {
  const board = ui.noticeBoard();
  board.set('c:A', ['「a.iso」太大']);
  assert.equal(board.text('c:A'), '「a.iso」太大');
  assert.equal(board.text('c:B'), '', 'switching to B shows nothing of A');
  board.set('c:B', ['x', 'y']);
  board.clear('c:A');                       // A's old send completing
  assert.deepEqual([board.text('c:A'), board.text('c:B')], ['', 'x\ny'], 'B keeps its own notice');
  board.set('c:B', []);
  assert.equal(board.text('c:B'), '');
  // app.js renders the notice of the composer's own target and clears only the sending target's.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /attachErrors\.text\(target\)/);
  assert.match(app, /attachErrors\.set\(target, errors\)/);
  assert.match(app, /attachErrors\.clear\(target\)/);
  assert.doesNotMatch(app, /showAttachError/);
});

test('web ui: $name of a known skill is split out as text; everything else stays plain text, HTML included', () => {
  const opts = { skills: new Set(['ponytail', 'ponytail-review']) };
  const body = '<img src=x onerror=alert(1)> 用 $ponytail-review，再 $ponytail. 不是 a$ponytail、$unknown';
  const segs = ui.bodySegments(body, opts);
  assert.deepEqual(segs, [
    '<img src=x onerror=alert(1)> 用 ', { skill: 'ponytail-review', text: '$ponytail-review' }, '，再 ',
    { skill: 'ponytail', text: '$ponytail' }, '. 不是 a$ponytail、$unknown',
  ]);
  assert.equal(segs.map((s: any) => (typeof s === 'string' ? s : s.text)).join(''), body, 'nothing added or lost');
  assert.deepEqual(ui.bodySegments('no skills', opts), ['no skills']);
  assert.deepEqual(ui.bodySegments('', opts), []);
  // The page builds the highlighted part as a text node: app.js passes seg.text as a child, never innerHTML.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /h\('span', \{ class: 'skill', title: .*\}, seg\.text\)/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/, 'the page never parses strings as HTML');
});

test('web ui: the cluster list is newest activity first, and a message event moves a cluster up', () => {
  const c = (id: string, createdAt: string, lastMessageAt?: string) => ({ id, name: id, createdAt, ...(lastMessageAt ? { lastMessageAt } : {}) });
  const old = c('old', '2026-11-01T10:00:00.000Z', '2026-11-01T12:00:00.000Z');
  const newer = c('new', '2026-11-01T11:00:00.000Z', '2026-11-01T11:30:00.000Z');
  const quiet = c('quiet', '2026-11-01T09:00:00.000Z');
  assert.deepEqual(ui.clusterOrder([newer, old, quiet]).map((x: any) => x.id), ['old', 'new', 'quiet'],
    'newest message first; a cluster without messages uses its creation time');
  // A live message event updates the cluster; an older or equal one returns the same object, so no redraw is needed.
  const moved = ui.withLastMessage(quiet, '2026-11-01T13:00:00.000Z');
  assert.equal(moved.lastMessageAt, '2026-11-01T13:00:00.000Z');
  assert.notEqual(moved, quiet);
  assert.equal(ui.withLastMessage(moved, '2026-11-01T12:59:59.000Z'), moved);
  assert.equal(ui.withLastMessage(moved, moved.lastMessageAt), moved);
  assert.equal(ui.withLastMessage(quiet, 'not a time'), quiet);
  assert.deepEqual(ui.clusterOrder([newer, old, moved]).map((x: any) => x.id), ['quiet', 'old', 'new']);
  // Equal times keep the incoming (Hub creation) order: the sort is stable, so nothing moves needlessly.
  assert.deepEqual(ui.clusterOrder([c('b', '2026-11-01T09:00:00.000Z'), c('a', '2026-11-01T09:00:00.000Z')]).map((x: any) => x.id), ['b', 'a']);
  // Invalid times sort last instead of throwing.
  assert.equal(ui.clusterOrder([c('bad', 'not a time'), c('ok', '2026-11-01T00:00:00.000Z')]).at(-1).id, 'bad');
});

test('web ui: the member panel toggle sums up members and online, stacks at most five avatars; open/closed is remembered', () => {
  assert.equal(ui.memberSummary(3, 2), '3 个群员 · 2 在线');
  assert.equal(ui.memberSummary(0, 0), '0 个群员 · 0 在线');
  assert.equal(ui.MEMBER_STACK, 5);
  assert.deepEqual(ui.stackedMembers(['a', 'b', 'c', 'd', 'e', 'f']), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ui.stackedMembers([]), []);
  // Only "1" is open; missing or unreadable storage means the default: closed.
  assert.equal(ui.PANEL_OPEN_KEY, 'orrery.panelOpen');
  assert.equal(ui.expandedFromStored('1'), true);
  for (const stored of [null, undefined, '', '0', 'true', 'yes']) assert.equal(ui.expandedFromStored(stored), false, String(stored));
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /try \{ return expandedFromStored\(localStorage\.getItem\(PANEL_OPEN_KEY\)\); \} catch \{ return false; \}/);
  assert.match(app, /try \{ localStorage\.setItem\(PANEL_OPEN_KEY, open \? '1' : '0'\); \} catch/);
  assert.match(app, /memberSummary\(counts\.total, counts\.online, counts\.hidden\)/);
  assert.match(app, /stackedMembers\(members\)/);
  // #m= opens the panel on that member; otherwise it shows the list only while open.
  assert.match(app, /if \(S\.members\.get\(S\.sel\.member\)\) return 'member';\n  return panelOpen && S\.clusters\.has\(S\.sel\.cluster\) \? 'members' : null;/);
  // Escape inside the panel closes it (not while an IME is composing), and focus goes back to the toggle.
  assert.match(app, /if \(e\.key !== 'Escape' \|\| e\.isComposing \|\| e\.defaultPrevented\) return;/);
  assert.match(app, /if \(inside\) \$\('members-toggle'\)\.focus\(\);/);
  // Lists are redrawn only when what they show changes, and never between pointerdown and pointerup.
  assert.match(app, /if \(sig === shown\) return;\n    if \(down\) \{ pending = true; return; \}/);
  assert.match(app, /addEventListener\('pointerdown', \(\) => \{ down = true; \}\)/);
  assert.match(app, /setTimeout\(render, 0\);   \/\/ after this press' click was dispatched on the old button/);
  assert.match(app, /const drawClusters = stableList\(\$\('cluster-list'\)\);/);
  assert.match(app, /const drawMemberList = stableList\(\$\('manage-list'\)\);/);
  // The toggle itself is never replaced (only its content), and that content never takes the press.
  const css = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.members-toggle > \* \{ pointer-events: none; \}/);
});

test('web ui: the member panel replaced the manage dialog: rename/avatar, remove with confirmation and add live in the panel', () => {
  const pub = join(REPO_ROOT, 'src', 'web', 'public');
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  assert.doesNotMatch(html, /id="manage-dialog"|id="manage-members"/, 'no separate dialog or header button');
  const panel = html.slice(html.indexOf('<aside id="member-panel"'), html.indexOf('</aside>', html.indexOf('<aside id="member-panel"')));
  for (const id of ['members-view', 'manage-list', 'panel-add', 'close-panel', 'member-view', 'back-members', 'member-composer']) {
    assert.ok(panel.includes(`id="${id}"`), `${id} is in the panel`);
  }
  // Removing asks in the page's confirm dialog (removeMember, tested below), not in a box under the list.
  assert.doesNotMatch(panel, /id="remove-confirmation"|id="remove-confirm"/);
  // The row's actions are icon buttons from ui.js memberRowActions (labels and names tested with it).
  assert.match(app, /memberRowActions\(m\)\.map\(\(a\) => h\('button', \{ type: 'button', class: `icon-button ghost member-action/);
  assert.match(app, /'aria-label': a\.name, 'data-tip': a\.label/);
  assert.match(app, /remove: \(m\) => void removeMember\(m\),/, 'removing still asks first');
  assert.match(app, /\$\('panel-add'\)\.addEventListener\('click', \(\) => openCreate\(S\.sel\.cluster\)\);/);
});

test('web ui member list: removing asks in the confirm dialog, says what is kept, and sends the same request', async () => {
  // The texts.
  const native = ui.removeMemberConfirm({ name: 'Ann' });
  assert.equal(native.title, '将“Ann”移出集群？');
  assert.equal(native.confirmText, '移出集群');
  assert.equal(native.danger, true);
  assert.match(native.message, /群聊和投递记录都会保留/);
  assert.match(native.message, /排队的投递会取消/);
  assert.match(native.message, /应用里的这个对话不会被删除或改动；它已经开始的一轮可能继续运行/);
  assert.match(native.message, /重新加进来，会成为一个新成员/);

  // The flow (app.js removeMember), run with stand-ins for the page.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('async function removeMember(m)');
  const end = app.indexOf('/**', start);
  assert.ok(start >= 0 && end > start);
  const run = async (answer: boolean, member: any, others: string[] = [], moveFocus?: 'from-row' | 'from-body') => {
    const calls: any[] = [], asked: any[] = [], focused: any[] = [];
    const members = new Map<string, any>([[member.id, member]]);
    const origin = { contains: (node: unknown): boolean => node === origin };
    const body = { contains: () => true };
    const document = { body, activeElement: (moveFocus === 'from-body' ? body : origin) as unknown };
    const context: any = {
      removing: false, editingId: 'x', manageError: null, manageNotice: '', managedCluster: member.clusterId,
      S: { members, sel: { cluster: member.clusterId } }, document, panelView: () => 'members',
      removeMemberConfirm: ui.removeMemberConfirm, liveAsk: ui.liveAsk,
      // The dialog's text as it reads now (liveAsk makes each text field follow a language switch).
      confirmDialog: async (o: any) => { asked.push(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v != null && typeof v === 'object' ? String(v) : v]))); return answer; },
      api: async (...args: any[]) => {
        calls.push(args);
        if (moveFocus) document.activeElement = { id: 'composer-input' };
        return { member: { ...member, removedAt: 'now' } };
      },
      upsertMember: (m: any) => members.set(m.id, m), membersOf: () => [...others.slice(0, 1), member.id, ...others.slice(1)].map((id) => ({ id })),
      renderManage() {}, render() {}, focusRow: (id: string, what = 'open') => { focused.push(`${id}:${what}`); return true; },
      $: (id: string) => ({ focus: () => focused.push(`#${id}`) }),
    };
    runInNewContext(`${app.slice(start, end)}\nglobalThis.go = removeMember;`, context);
    await context.go(member);
    return { calls, asked, focused, notice: context.manageNotice, removing: context.removing };
  };
  const ann = { id: 'm1', name: 'Ann', clusterId: 'c1', removedAt: null };
  // Cancel: nothing is sent; focus goes back to the row's remove button.
  const cancelled = await run(false, ann);
  assert.deepEqual(cancelled.calls, []);
  assert.deepEqual(cancelled.asked, [native]);
  assert.deepEqual(cancelled.focused, ['m1:remove']);
  // Confirm: the same DELETE as before; focus moves to the next member, or the one before, or 添加成员.
  const done = await run(true, ann, ['m0', 'm2']);
  assert.equal(JSON.stringify(done.calls), JSON.stringify([['DELETE', '/api/clusters/c1/members/m1', {}]]));
  assert.equal(done.notice, '已将“Ann”移出集群，历史已保留。');
  assert.equal(done.removing, false);
  assert.deepEqual(done.focused, ['m2:open']);
  assert.deepEqual((await run(true, { ...ann }, ['m0'])).focused, ['m0:open']);
  assert.deepEqual((await run(true, { ...ann })).focused, ['#panel-add']);
  for (const origin of ['from-row', 'from-body'] as const) {
    assert.deepEqual((await run(true, ann, ['m0', 'm2'], origin)).focused, [], `a newly focused input keeps focus ${origin}`);
  }
});

test('web ui: sidebar groups: category input rules, alphabetical groups with 未分组 last, newest first inside, collapsed set from storage', () => {
  assert.deepEqual(ui.categoryInput('  前端 '), { category: '前端' });
  assert.deepEqual(ui.categoryInput(''), { category: '' });
  assert.deepEqual(ui.categoryInput('   '), { category: '' });
  assert.deepEqual(ui.categoryInput('字'.repeat(40)), { category: '字'.repeat(40) });
  assert.deepEqual(ui.categoryInput('😀'.repeat(40)), { category: '😀'.repeat(40) }, 'characters, not UTF-16 units');
  assert.match(ui.categoryInput('x'.repeat(41)).error, /最多 40 个字/);
  assert.match(ui.categoryInput('a\nb').error, /换行或控制字符/);
  assert.match(ui.categoryInput('a b').error, /换行或控制字符/);
  assert.equal(ui.MAX_CATEGORY, 40);
  const hub = readFileSync(join(REPO_ROOT, 'src', 'core', 'hub.ts'), 'utf8');
  assert.match(hub, /export const MAX_CATEGORY = 40;/, 'the page and the Hub use the same limit');

  const c = (id: string, at: string, category?: string) => ({ id, name: id, createdAt: at, lastMessageAt: at, ...(category === undefined ? {} : { category }) });
  const groups = ui.clusterGroups([
    c('old-b', '2026-11-01T01:00:00Z', 'beta'), c('none', '2026-11-01T05:00:00Z'), c('new-b', '2026-11-01T03:00:00Z', 'beta'),
    c('a1', '2026-11-01T02:00:00Z', 'alpha'), c('blank', '2026-11-01T04:00:00Z', ''), c('cn', '2026-11-01T00:00:00Z', '前端'),
  ]);
  assert.deepEqual(groups.map((g: any) => [g.name, g.clusters.map((x: any) => x.id)]), [
    ['前端', ['cn']], ['alpha', ['a1']], ['beta', ['new-b', 'old-b']], ['', ['none', 'blank']],
  ], 'named groups in Chinese collation order (pinyin, then Latin letters), ungrouped (missing or empty category) last, newest activity first inside');
  assert.deepEqual(ui.clusterGroups([]), []);
  assert.equal(ui.UNGROUPED, '未分组');

  assert.deepEqual([...ui.collapsedFromStored('["beta",""]')], ['beta', '']);
  for (const bad of [null, '', 'nope', '{"a":1}', '[1,2]']) assert.equal(ui.collapsedFromStored(bad).size, 0, String(bad));
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /try \{ return collapsedFromStored\(localStorage\.getItem\(COLLAPSED_GROUPS_KEY\)\); \} catch \{ return new Set\(\); \}/);
  assert.match(app, /try \{ await api\('PATCH', `\/api\/clusters\/\$\{encodeURIComponent\(id\)\}`, \{ category \}\); \}/, 'moving a cluster is its category');
});

test('web ui: collapsing 未分组 alone changes what the sidebar redraws on, and its key cannot be a group name', () => {
  const sig = ui.collapsedSignature;
  assert.notEqual(sig(new Set([''])), sig(new Set()), 'only 未分组 collapsed is not "nothing collapsed"');
  assert.notEqual(sig(new Set(['', 'a'])), sig(new Set(['a'])));
  assert.notEqual(sig(new Set(['a\u0001b'])), sig(new Set(['a', 'b'])), 'no separator inside a name can fake two names');
  assert.equal(sig(new Set(['b', 'a'])), sig(new Set(['a', 'b'])), 'the order of collapsing does not matter');
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /return \[archiveOpen, collapsedSignature\(collapsedGroups\), /, 'the sidebar redraw check uses it');
  // 未分组 is remembered as '' (collapsedFromStored keeps it). A group is never '': the Hub refuses an empty or blank
  // group name (test/cluster-sidebar.test.ts), the page's dialog too, and '' in the Hub's list is not drawn as a group.
  assert.equal(ui.categoryInput('   ').category, '', 'a blank group field means 未分组');
  const c = (id: string, category: string) => ({ id, name: id, createdAt: '2026-11-01T00:00:00Z', category });
  assert.deepEqual(ui.clusterGroups([c('x', 'a'), c('y', ' ')], ['', 'a']).map((g: any) => g.name), ['a', ''], 'only the ungrouped section is keyed ""');
});

test('web ui: sidebar groups follow the Hub list: its order, empty groups kept, unlisted groups after it, 未分组 last', () => {
  const c = (id: string, at: string, category?: string, extra = {}) => ({ id, name: id, createdAt: at, lastMessageAt: at, ...(category === undefined ? {} : { category }), ...extra });
  const clusters = [c('a1', '2026-11-01T02:00:00Z', 'alpha'), c('b1', '2026-11-01T03:00:00Z', 'beta'), c('none', '2026-11-01T05:00:00Z', ''),
    c('legacy', '2026-11-01T01:00:00Z', '前端'), c('a2', '2026-11-01T04:00:00Z', 'alpha')];
  const groups = ui.clusterGroups(clusters, ['beta', 'empty', 'alpha']);
  assert.deepEqual(groups.map((g: any) => [g.name, g.clusters.map((x: any) => x.id)]), [
    ['beta', ['b1']], ['empty', []], ['alpha', ['a2', 'a1']], ['前端', ['legacy']], ['', ['none']],
  ], 'listed order, an empty listed group, then a group the list lacks, ungrouped last; newest first inside');
  assert.deepEqual(ui.clusterGroups([], ['only']).map((g: any) => g.name), ['only'], 'an empty group with no clusters at all');
  assert.deepEqual(ui.clusterGroups([c('x', '2026-11-01T00:00:00Z', 'x')], ['', 'x', 'x', 3 as any]).map((g: any) => g.name), ['x'], 'junk in the list is ignored');
  const sections = ui.sidebarSections([...clusters, c('p', '2026-11-01T06:00:00Z', 'beta', { pinnedAt: 'x' })], ['beta', 'empty', 'alpha']);
  assert.deepEqual(sections.groups.map((g: any) => g.name), ['beta', 'empty', 'alpha', '前端', ''], 'sections pass the order on');
  assert.deepEqual(sections.pinned.map((x: any) => x.id), ['p']);

  assert.deepEqual(ui.moveGroup(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(ui.moveGroup(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.equal(ui.moveGroup(['a', 'b'], 'a', -1), null, 'already first');
  assert.equal(ui.moveGroup(['a', 'b'], 'b', 1), null, 'already last');
  assert.equal(ui.moveGroup(['a'], 'z', 1), null, 'unknown');
  assert.deepEqual(ui.moveTargets(['a', 'b'], ' b '), [
    { name: 'a', label: 'a', current: false }, { name: 'b', label: 'b', current: true }, { name: '', label: '未分组', current: false },
  ]);
  assert.equal(ui.moveTargets(['a'], undefined).at(-1).current, true, 'no category is 未分组');

  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  for (const call of ["api('POST', '/api/cluster-groups', { name })", "api('PATCH', '/api/cluster-groups', { from, to })",
    "api('DELETE', '/api/cluster-groups', { name })", "api('PUT', '/api/cluster-groups', { groups: next })"]) assert.ok(app.includes(call), call);
  assert.match(app, /\{ key: 'move', label: t\('移到分组…'\) \}/, 'the cluster menu moves without dragging');
  assert.match(app, /item\('new-group', t\('新建分组…'\)\)/);
  assert.match(app, /draggable: 'true'/);
  assert.match(html, /<button id="new-group" class="icon-button ghost" type="button" aria-label="新建分组"[^>]*title="新建分组"/);
});

/**
 * The page's own group actions (groupAction → the rename dialog's save, delete) and remembered collapse state, run
 * with a fake Hub whose events and answers arrive in the order a test picks. `view()` is what the sidebar draws: each
 * group with collapsed or not (drawClusterList's `!collapsedGroups.has(g.name)`), after render's expandSelectedGroup.
 */
function groupActionsHarness(start: { groups: string[]; clusters: any[]; collapsed: string[]; selected?: string }) {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const part = (from: string, to: string) => {
    const a = app.indexOf(from);
    const b = app.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${from} … ${to} is still in app.js`);
    return app.slice(a, b);
  };
  const storage = new Map<string, string>([[ui.COLLAPSED_GROUPS_KEY, JSON.stringify(start.collapsed)]]);
  const hub = { groups: [...start.groups], clusters: start.clusters.map((c) => ({ ...c })) };
  const S = { clusters: new Map(), settings: { clusterGroups: [] as string[] }, sel: { cluster: start.selected ?? null } };
  const sync = () => {   // what the Hub's cluster and settings events do to the page
    S.settings = { clusterGroups: [...hub.groups] };
    S.clusters = new Map(hub.clusters.map((c) => [c.id, { ...c }]));
  };
  sync();
  const views: string[] = [];
  const pending: { resolve: () => void; reject: (e: Error) => void; apply: () => void }[] = [];
  let save: ((name: string) => Promise<unknown>) | null = null;
  const context: Record<string, unknown> = {
    S, localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    COLLAPSED_GROUPS_KEY: ui.COLLAPSED_GROUPS_KEY, collapsedFromStored: ui.collapsedFromStored, moveGroup: ui.moveGroup, UNGROUPED: ui.UNGROUPED,
    clusterMenu: null, closeClusterMenu: () => {}, groupList: () => ui.clusterGroups([...S.clusters.values()], S.settings.clusterGroups).map((g: any) => g.name).filter(Boolean),
    groupNameDialog: (_title: string, _initial: string, fn: (name: string) => Promise<unknown>) => { save = fn; },
    confirmDialog: async () => true, noticeDialog: async () => {}, lt: ui.lt,
    api: (method: string, _path: string, body: any) => new Promise<void>((resolve, reject) => {
      // The Hub has done the change when it answers; its events are applied by sse(), separately.
      const apply = () => {
        if (method === 'PATCH') {
          hub.groups = hub.groups.map((g) => g === body.from ? body.to : g);
          for (const c of hub.clusters) if (c.category === body.from) c.category = body.to;
        }
        if (method === 'DELETE') {
          hub.groups = hub.groups.filter((g) => g !== body.name);
          for (const c of hub.clusters) if (c.category === body.name) c.category = '';
        }
      };
      pending.push({ resolve, reject, apply });
    }),
  };
  context.render = () => {   // drawn at once (the real render batches into a frame; the order is the same)
    (context.t as any).expandSelectedGroup();
    views.push(view());
  };
  const view = (collapsed: Set<string> = (context.t as any).collapsed) =>
    ui.sidebarSections([...S.clusters.values()], (context.groupList as () => string[])()).groups.map((g: any) => `${g.name || ui.UNGROUPED}:${collapsed.has(g.name) ? 'collapsed' : 'open'}`).join(' ');
  runInNewContext(`${part('/** Sidebar groups the user collapsed', '/** A pane')}
${part("// The selected cluster's group opens", 'const drawClusters')}
${part('async function groupAction(', "/** A named group's menu")}
globalThis.t = { groupAction, expandSelectedGroup, get collapsed() { return collapsedGroups; } };`, context);
  const t = context.t as any;
  t.expandSelectedGroup();   // the first render
  return {
    t, views, view, pending,
    save: (name: string) => save!(name),
    /** The Hub's events reach the page. */
    sse: () => { sync(); (context.render as () => void)(); },
    /** The Hub did the change and its answer reaches the page (or fails). */
    answer: async (error?: Error) => { const p = pending.shift()!; if (error) p.reject(error); else { p.apply(); p.resolve(); } await new Promise((r) => setTimeout(r, 0)); },
    /** What a reload of the page would draw now. */
    reloaded: () => view(ui.collapsedFromStored(storage.get(ui.COLLAPSED_GROUPS_KEY) ?? null)),
  };
}

test('web ui: renaming a collapsed group keeps it collapsed whether the events or the answer arrive first, as a reload shows it', async () => {
  const start = { groups: ['Old', 'Other'], collapsed: ['Old'], selected: 'loose',
    clusters: [{ id: 'grouped', name: 'Grouped', category: 'Old', createdAt: '2026-11-01T00:00:00Z' }, { id: 'loose', name: 'Loose', category: '', createdAt: '2026-11-01T00:00:00Z' }] };
  for (const order of ['events first', 'answer first'] as const) {
    const h = groupActionsHarness(start);
    assert.equal(h.view(), 'Old:collapsed Other:open 未分组:open');
    await h.t.groupAction('Old', 'rename');
    const saved = h.save('Renamed');
    assert.equal(h.views.at(-1), 'Old:collapsed Other:open 未分组:open', `${order}: no flash while the request is out`);
    // The Hub applied the change (it sends its events before it answers); which of the two reaches the page first varies.
    h.pending[0].apply();
    if (order === 'events first') { h.sse(); assert.equal(h.views.at(-1), 'Renamed:collapsed Other:open 未分组:open', 'events first: drawn collapsed under the new name'); await h.answer(); }
    else { await h.answer(); h.sse(); }
    await saved;
    assert.equal(h.views.at(-1), 'Renamed:collapsed Other:open 未分组:open', order);
    assert.equal(h.views.at(-1), h.reloaded(), `${order}: the page right after saving is what a reload shows`);
    assert.deepEqual([...h.t.collapsed], ['Renamed'], `${order}: the old name is not kept`);
  }
});

test('web ui: a refused group rename puts the collapse state back; a renamed group holding the selected cluster stays collapsed', async () => {
  const h = groupActionsHarness({ groups: ['Old'], collapsed: ['Old'], clusters: [{ id: 'g', name: 'G', category: 'Old', createdAt: '2026-11-01T00:00:00Z' }] });
  await h.t.groupAction('Old', 'rename');
  const saved = h.save('New');
  const refused = assert.rejects(saved, /already exists/, 'the dialog shows the Hub\'s answer');
  await h.answer(new Error('group "New" already exists'));
  await refused;
  assert.deepEqual([...h.t.collapsed], ['Old']);
  assert.equal(h.views.at(-1), 'Old:collapsed', 'drawn as before');
  assert.equal(h.reloaded(), 'Old:collapsed');

  // The selected cluster's group opens when the cluster moves to another group; a rename is not a move.
  for (const order of ['events first', 'answer first'] as const) {
    const sel = groupActionsHarness({ groups: ['Old'], collapsed: [], selected: 'g', clusters: [{ id: 'g', name: 'G', category: 'Old', createdAt: '2026-11-01T00:00:00Z' }] });
    sel.t.collapsed.add('Old');   // collapsed by hand after it was opened for the selection
    const again = (await sel.t.groupAction('Old', 'rename'), sel.save('New'));
    sel.pending[0].apply();
    if (order === 'events first') { sel.sse(); await sel.answer(); } else { await sel.answer(); sel.sse(); }
    await again;
    assert.equal(sel.views.at(-1), 'New:collapsed', `${order}: ${JSON.stringify(sel.views)}`);
    assert.equal(sel.views.at(-1), sel.reloaded(), order);
  }
});

test('web ui: deleting a group drops its collapse state, so a later group of that name starts open', async () => {
  const h = groupActionsHarness({ groups: ['Gone', 'Kept'], collapsed: ['Gone', 'Kept'],
    clusters: [{ id: 'a', name: 'A', category: 'Gone', createdAt: '2026-11-01T00:00:00Z' }, { id: 'b', name: 'B', category: 'Kept', createdAt: '2026-11-01T00:00:00Z' }] });
  const done = h.t.groupAction('Gone', 'delete');
  await new Promise((r) => setTimeout(r, 0));
  h.pending[0].apply();
  h.sse();
  await h.answer();
  await done;
  assert.deepEqual([...h.t.collapsed], ['Kept']);
  assert.equal(h.views.at(-1), 'Kept:collapsed 未分组:open');
  assert.equal(h.views.at(-1), h.reloaded());
});

test('web ui: relative times: 刚刚, minutes, hours today, 昨天, days, then a date; clock skew is never negative', () => {
  const at = (...parts: number[]) => new Date(...(parts as [number, number, number, number?, number?, number?])).getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = at(2026, 10, 15, 14, 30, 0);   // 15 Nov 2026 14:30 local time
  const ago = (ms: number) => ui.relativeTime(iso(now - ms), now);
  assert.equal(ago(0), '刚刚');
  assert.equal(ago(59_999), '刚刚', 'just under a minute');
  assert.equal(ago(60_000), '1 分钟前', 'a minute');
  assert.equal(ago(59 * 60_000 + 59_999), '59 分钟前', 'just under an hour');
  assert.equal(ago(3_600_000), '1 小时前', 'an hour');
  assert.equal(ago(-5 * 60_000), '刚刚', 'a time ahead of this clock (skew) is not negative');
  assert.equal(ago(-3 * 86_400_000), '刚刚');
  assert.equal(ui.relativeTime(iso(at(2026, 10, 15, 0, 0, 0)), now), '14 小时前', 'midnight today is still today');
  assert.equal(ui.relativeTime(iso(at(2026, 10, 14, 23, 59, 59)), now), '昨天', 'one second before midnight is yesterday');
  const justAfterMidnight = at(2026, 10, 15, 0, 10, 0);
  assert.equal(ui.relativeTime(iso(at(2026, 10, 14, 23, 50, 0)), justAfterMidnight), '20 分钟前', 'minutes win over the date line');
  assert.equal(ui.relativeTime(iso(at(2026, 10, 14, 22, 0, 0)), justAfterMidnight), '昨天', 'over an hour across midnight');
  assert.equal(ui.relativeTime(iso(at(2026, 10, 13, 9, 0, 0)), now), '2 天前');
  assert.equal(ui.relativeTime(iso(at(2026, 10, 9, 0, 0, 0)), now), '6 天前', 'six calendar days');
  assert.equal(ui.relativeTime(iso(at(2026, 10, 8, 23, 59, 0)), now), '11月8日', 'a week: the date');
  assert.equal(ui.relativeTime(iso(at(2025, 11, 31, 12, 0, 0)), now), '2025年12月31日', 'another year names it');
  assert.equal(ui.relativeTime(undefined, now), '');
  assert.equal(ui.relativeTime('not a time', now), '');
  assert.notEqual(ui.fullTime(iso(now)), '', 'the tooltip has the full time');
  assert.equal(ui.fullTime('nope'), '');
});

test('web ui: relative times refresh in place: only words that changed are rewritten', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const make = (relAt: string, text: string) => ({ dataset: { relAt }, textContent: text, writes: 0 });
  const els = [make('2026-11-15T11:58:00Z', '刚刚'), make('2026-11-15T11:00:00Z', '1 小时前')];
  const watched = els.map((el) => new Proxy(el, { set(t: any, k, v) { if (k === 'textContent') t.writes++; t[k] = v; return true; } }));
  ui.refreshRelativeTimes({ querySelectorAll: (sel: string) => { assert.equal(sel, 'time[data-rel-at]'); return watched; } }, now);
  assert.deepEqual(els.map((e) => [e.textContent, e.writes]), [['2 分钟前', 1], ['1 小时前', 0]]);
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /setInterval\(\(\) => refreshRelativeTimes\(document\), 30_000\);/, 'a timer, not a redraw');
  assert.match(app, /relativeTimeEl\(c\.lastMessageAt, 'rel-time cluster-time'\)/, 'each sidebar cluster');
  assert.match(app, /lastAt\[i\] \? relativeTimeEl\(lastAt\[i\]\) : null/, 'each cluster on 全部对话');
});

test('web ui: the sidebar head and its entries draw sprite icons; settings is a gear with a name', () => {
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  const sidebar = html.slice(html.indexOf('<aside id="sidebar">'), html.indexOf('</aside>'));
  assert.match(sidebar, /<button id="open-settings" class="icon-button ghost" type="button" aria-label="设置"[^>]*title="[^"]+"[^>]*><svg class="ico" aria-hidden="true"><use href="#i-gear"\/><\/svg><\/button>/);
  assert.doesNotMatch(sidebar, /⚙/);
  for (const [id, icon, text, after] of [['open-conversations', 'chats', '全部对话', ''], ['open-trash', 'trash', '回收站', ''],
    // 全部任务 also carries the stalled-member badge (stalled.js), hidden until a hint shows.
    ['open-task-overview', 'tasks', '全部任务', '<span id="task-overview-stalled" class="stalled-badge" hidden></span>']]) {
    assert.match(sidebar, new RegExp(`<button id="${id}" class="conversation-nav" type="button"><svg class="ico" aria-hidden="true"><use href="#i-${icon}"/></svg><span><span data-i18n="${text}">${text}</span></span>${after}</button>`));
  }
  for (const icon of ['gear', 'chats', 'trash']) assert.match(html, new RegExp(`<symbol id="i-${icon}" viewBox="0 0 24 24">`));
  assert.doesNotMatch(html.slice(html.indexOf('<svg class="sprite"'), html.indexOf('</svg>', html.indexOf('<svg class="sprite"'))), /fill="#|stroke="#|https?:/, 'currentColor only, nothing external');
});

test('web ui: pane widths are clamped to their limits and to the room the chat needs; stored garbage means the default', () => {
  const { side, panel } = ui.PANES;
  assert.equal(ui.clampPane('side', 300), 300);
  assert.equal(ui.clampPane('side', 10), side.min);
  assert.equal(ui.clampPane('side', 5000), side.max);
  assert.equal(ui.clampPane('panel', 299.6), 300, 'whole pixels');
  assert.equal(ui.clampPane('panel', NaN), panel.def);
  // 1000 px window, sidebar 248: the panel may take at most 1000 - 248 - CHAT_MIN.
  assert.equal(ui.clampPane('panel', 700, 1000 - 248), 1000 - 248 - ui.CHAT_MIN);
  assert.equal(ui.clampPane('panel', 700, 400), panel.min, 'a tiny window still keeps the pane usable');
  assert.equal(ui.paneFromStored('side', '320'), 320);
  assert.equal(ui.paneFromStored('side', '9999'), side.max);
  for (const bad of [null, undefined, '', 'wide', '  ']) assert.equal(ui.paneFromStored('panel', bad), panel.def, String(bad));
  // Keyboard: the divider moves with the arrow (→ widens the sidebar, narrows the panel); Shift is a bigger step.
  assert.equal(ui.paneKey('side', 300, 'ArrowRight'), 316);
  assert.equal(ui.paneKey('side', 300, 'ArrowLeft', true), 236);
  assert.equal(ui.paneKey('panel', 360, 'ArrowRight'), 344);
  assert.equal(ui.paneKey('panel', 360, 'ArrowLeft'), 376);
  assert.equal(ui.paneKey('panel', 360, 'Home'), panel.min);
  assert.equal(ui.paneKey('side', 300, 'End'), side.max);
  assert.equal(ui.paneKey('side', 300, 'Enter'), null);
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  for (const id of ['side-divider', 'panel-divider']) {
    assert.match(html, new RegExp(`<div id="${id}" class="divider" role="separator" aria-orientation="vertical"[^>]*tabindex="0"`));
  }
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /try \{ return paneFromStored\(pane, localStorage\.getItem\(PANES\[pane\]\.key\)\); \} catch \{ return PANES\[pane\]\.def; \}/);
  assert.match(app, /d\.setPointerCapture\(e\.pointerId\);/);
  const css = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'style.css'), 'utf8');
  assert.match(css, /@media \(max-width: 900px\) \{\n  #app \{ grid-template-columns: minmax\(0, 1fr\); \}\n  #chat \{ grid-column: 1; \}\n  \.divider \{ display: none !important; \}/, 'no dividers in the narrow layout');
  // An auto row makes every layout change (a typed character) measure the whole chat history again.
  assert.match(css, /\n#app \{[^}]*grid-template-rows: minmax\(0, 1fr\);[^}]*height: 100dvh; \}/, 'the page row is the window height, not the content height');
});

test('web ui: composers grow with their text up to 12 lines or 40% of the window, then scroll', () => {
  const base = { min: 56, lineHeight: 20, chrome: 16 };
  assert.deepEqual(ui.autogrowHeight({ ...base, content: 40, viewport: 1000 }), { height: 56, scroll: false }, 'never below its rows');
  assert.deepEqual(ui.autogrowHeight({ ...base, content: 120, viewport: 1000 }), { height: 120, scroll: false });
  // 12 lines: 12 * 20 + 16 = 256 < 400 (40% of 1000).
  assert.deepEqual(ui.autogrowHeight({ ...base, content: 900, viewport: 1000 }), { height: 256, scroll: true });
  // A short window: 40% of 500 = 200 < 256.
  assert.deepEqual(ui.autogrowHeight({ ...base, content: 900, viewport: 500 }), { height: 200, scroll: true });
  assert.deepEqual(ui.autogrowHeight({ ...base, content: 900, viewport: 100 }), { height: 56, scroll: true }, 'the rows win over a tiny window');
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /input\.addEventListener\('input', \(\) => autogrow\(input\)\);/);
  assert.match(app, /drafts\.delete\(target\);\n    autogrow\(c\.input\);/, 'a restored draft is measured');
  assert.match(app, /c\.input\.value = '';\n    autogrow\(c\.input\);/, 'a sent draft shrinks back');
  const uiSrc = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js'), 'utf8');
  assert.match(uiSrc, /input\.dispatchEvent\(new Event\('input'\)\);/, 'a picked @name or $skill regrows too');
});

test('web ui: a composer at its rows is not measured again while its text fits, and returns to its rows', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('function autogrow(input) {');
  const end = app.indexOf('\n/** Binds the composer', start);
  assert.ok(start >= 0 && end > start);
  // A textarea of 56px rows (1px borders): scrollHeight is its text's height, at least its own inner height.
  let text = 20, writes = 0, height = '';
  const style = { overflowY: 'hidden', get height() { return height; }, set height(v: string) { writes++; height = v; } };
  const input = { offsetParent: {}, value: 'a', scrollTop: 0, style,
    get offsetHeight() { return height ? parseFloat(height) : 56; },
    get clientHeight() { return this.offsetHeight - 2; },
    get scrollHeight() { return Math.max(text, this.clientHeight); } };
  const scroller = { scrollHeight: 1000, scrollTop: 500, clientHeight: 500 };
  const context: any = { chat: { input, scroller }, direct: { input: {}, scroller: {} }, innerHeight: 1000, autogrowHeight: ui.autogrowHeight,
    getComputedStyle: () => ({ borderTopWidth: '1px', borderBottomWidth: '1px', lineHeight: '20px', paddingTop: '8px', paddingBottom: '8px' }) };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.autogrow = autogrow;`, context);
  context.autogrow(input);
  assert.equal(writes, 0, 'text that fits the rows changes nothing');
  text = 120;
  context.autogrow(input);
  assert.equal(height, '122px');
  assert.equal(scroller.scrollTop, 1000, 'the stream stays at its newest line');
  text = 20;
  context.autogrow(input);
  assert.equal(height, '', 'back at its rows there is no height left to reset');
  writes = 0;
  context.autogrow(input);
  assert.equal(writes, 0);
});

test('web ui: deliveries bump their message revision, and events that only add member-page lines do not redraw', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('function setDelivery(');
  const end = app.indexOf('\n// ---- quota and token counts', start);
  assert.ok(start >= 0 && end > start);
  let renders = 0, usageLoads = 0, complete = true;
  const lines: string[] = [];
  const state: any = { lastSeq: 0, sel: { member: 'open' }, messages: new Map(), clusterMsgs: new Map([['c', []]]), clusters: new Map(), handoffs: new Set(), running: new Map() };
  const context: any = { S: state, render: () => { renders++; }, replayComplete: () => complete, loadUsageSoon: () => { usageLoads++; },
    pushMemberEvent: (id: string) => { lines.push(id); }, allowRead: () => {}, hiddenWarningArrived: () => {}, withLastMessage: ui.withLastMessage, loadProblemsSoon: () => {},
    stalled: { changed() {} } };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.applyEvent = applyEvent;\nchatWindows.set('c', { live: true, pending: null });`, context);
  let seq = 0;
  const send = (kind: string, payload: unknown, memberId: string | null = null) =>
    context.applyEvent({ seq: ++seq, kind, payload, memberId, clusterId: 'c', createdAt: '2026-01-01T00:00:00.000Z' });
  const delivery = (deliveryState: string) => ({ id: 'd1', messageId: 'msg', memberId: 'other', state: deliveryState });
  send('message', { message: { id: 'msg', clusterId: 'c', from: 'user', body: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }, deliveries: [delivery('queued')] });
  const msg = state.messages.get('msg');
  assert.equal(msg.rev, 1);
  send('delivery', { delivery: delivery('running') }, 'other');
  assert.equal(msg.rev, 2, 'a changed delivery marks its message for a rebuild');
  assert.equal(msg.deliveries.get('other').state, 'running');
  assert.equal(renders, 2);
  send('agent', { event: { type: 'text', text: 'working' } }, 'other');
  send('unread_hint', { count: 1 }, 'other');
  send('usage', { turn: {} }, 'other');
  assert.equal(renders, 2, 'nothing on screen changed');
  assert.equal(usageLoads, 1);
  assert.deepEqual(lines.slice(-2), ['other', 'other'], 'the lines are kept for when that member page opens');
  send('agent', { event: { type: 'text', text: 'working' } }, 'open');
  assert.equal(renders, 3, 'the open member page gets its line');
  complete = false;   // the log is still catching up with the snapshot: the event that ends that has to be drawn
  send('agent', { event: { type: 'text', text: 'working' } }, 'other');
  send('usage', { turn: {} }, 'other');
  assert.equal(renders, 5);
});

test('web ui: the chat header actions and the composer controls are icon buttons that say what they are', () => {
  const pub = join(REPO_ROOT, 'src', 'web', 'public');
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  const css = readFileSync(join(pub, 'style.css'), 'utf8');
  // Every icon is defined once in the sprite, and every <use> (or the workbench's icon()) names one of them.
  const symbols = [...html.matchAll(/<symbol id="(i-[a-z-]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(symbols).size, symbols.length);
  const workbench = readFileSync(join(pub, 'workbench.js'), 'utf8');
  const uiSource = readFileSync(join(pub, 'ui.js'), 'utf8');
  // The member list: its row actions (both hide states) and the marks of its details line.
  // Every script under public/ that draws an icon names it as icon('name'…) or, in a table, icon: 'name'.
  const scripts = [
    ...readdirSync(pub, { recursive: true }).map(String).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(pub, f), 'utf8')),
    ...readdirSync(join(REPO_ROOT, 'src', 'plugins'), { recursive: true }).map(String)
      .filter((f) => /^[^\\/]+[\\/]package[\\/]web[\\/].*\.js$/.test(f) && !/[\\/]vendor[\\/]/.test(f))
      .map((f) => readFileSync(join(REPO_ROOT, 'src', 'plugins', f), 'utf8')),
  ].join('\n');
  const used = [...html.matchAll(/<use href="#(i-[a-z-]+)"\/>/g)].map((m) => m[1])
    .concat([...scripts.matchAll(/\bicon\('([a-z-]+)'/g), ...scripts.matchAll(/\bicon: '([a-z-]+)'/g)].map((m) => `i-${m[1]}`))
    .concat([{}, { hiddenAt: 'x' }].flatMap((m) => ui.memberRowActions({ name: 'n', ...m }, 'native').map((a: any) => `i-${a.icon}`)))
    .concat([...uiSource.matchAll(/\['([a-z-]+)', (?:t\()?['"](?:模型|项目|对话) ['"]\)?\]/g)].map((m) => `i-${m[1]}`));
  assert.deepEqual([...new Set(used)].sort(), [...symbols].sort());
  const head = html.slice(html.indexOf('<header class="chat-head">'), html.indexOf('</header>'));
  for (const [id, icon] of [['delivery-problems', 'alert'], ['open-workbench', 'tasks']]) {
    assert.match(head, new RegExp(`<button id="${id}" class="icon-button ghost" type="button" hidden[^>]*><svg class="ico" aria-hidden="true"><use href="#i-${icon}"/></svg></button>`));
  }
  assert.doesNotMatch(html + app, /set-category|category-dialog/, 'groups are managed in the sidebar, not inside a cluster');
  assert.match(head, /id="open-workbench"[^>]*title="任务工作台"[^>]*aria-label="任务工作台"/);
  // The names that change are set together with the tooltip; the count is the badge.
  assert.match(app, /function iconLabel\(button, text\) \{\n  if \(button\.title === text\) return;\n  button\.title = text;\n  button\.setAttribute\('aria-label', text\);\n\}/);
  assert.match(app, /iconLabel\(\$\('delivery-problems'\), t\('有问题的投递 \{problemCount\}', \{ problemCount: problemCount \}\)\);/);
  assert.match(app, /\$\('delivery-problems'\)\.hidden = !problemCount;\n  \$\('delivery-problems'\)\.dataset\.count = /);
  // Deleting a cluster is only in the sidebar's cluster menu.
  assert.doesNotMatch(html, /delete-cluster|删除群聊/);
  assert.doesNotMatch(app, /delete-cluster/);
  assert.match(app, /\{ key: 'delete', label: t\('删除'\) \}/);
  assert.match(app, /if \(action === 'delete'\) return deleteCluster\(cluster\);/);
  // The header never scrolls sideways: the tools wrap to a second line instead.
  assert.doesNotMatch(css.slice(css.indexOf('/* ---- chat ---- */'), css.indexOf('.messages {')), /overflow-x/);
  const chatHeadRule = /\.chat-head\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(chatHeadRule, /\bdisplay:\s*flex;/);
  assert.match(chatHeadRule, /\bflex-wrap:\s*wrap;/);
  // Composer: "+" opens a menu with the two actions; the file input and the old ids are still there; send is an icon.
  const composer = html.slice(html.indexOf('<form id="composer"'), html.indexOf('</form>', html.indexOf('<form id="composer"')));
  assert.match(composer, /<button id="composer-add" class="icon-button" type="button"[^>]*aria-haspopup="menu" aria-expanded="false" aria-controls="composer-menu">/);
  assert.match(composer, /<div id="composer-menu" class="composer-menu" role="menu"[^>]*hidden>\s*<button id="composer-tasks" type="button" role="menuitem"[^>]*>.*关联任务.*<span id="composer-task-count" class="menu-count"><\/span><\/button>\s*<button id="composer-attach" type="button" role="menuitem" title="添加附件（每个文件不超过 20 MB，一条消息最多 10 个）"[^>]*>.*添加附件.*<\/button>\s*<\/div>/);
  assert.ok(composer.indexOf('id="composer-add"') < composer.indexOf('id="composer-input"'), '"+" comes before the input');
  assert.match(composer, /<input id="composer-file" type="file" multiple hidden>/);
  assert.doesNotMatch(composer, /📎|>发送</);
  assert.equal(html.match(/<button class="primary icon-button" type="submit" title="发送"[^>]*aria-label="发送"[^>]*><svg class="ico" aria-hidden="true"><use href="#i-send"\/><\/svg><\/button>/g)?.length, 2, 'group chat and member page');
  assert.match(app, /attachMenu\(\$\('composer-add'\), \$\('composer-menu'\)\);\n\$\('composer-attach'\)\.addEventListener\('click', \(\) => \$\('composer-file'\)\.click\(\)\);/);
  assert.match(app, /\$\('composer-add'\)\.dataset\.count = count \|\| '';/);
  assert.match(css, /\.icon-button\[data-count\]:not\(\[data-count=""\]\)::after \{\n  content: attr\(data-count\); position: absolute;/, 'the badge overlaps, so it moves nothing');
  // Plugin controls stay beside the input, not inside the menu.
  assert.match(app, /chat\.button\.before\(\.\.\.pluginSlots\.composer\.map\(/);
});

test('web ui: attachMenu opens on click and arrows, moves with ↓/↑, and Esc or a choice returns focus to the button', async () => {
  type Fake = { id: string; hidden: boolean; attrs: Record<string, string>; on: Record<string, (e: any) => void>; kids: Fake[];
    setAttribute(k: string, v: string): void; addEventListener(k: string, f: (e: any) => void): void; focus(): void;
    contains(other: unknown): boolean; querySelectorAll(selector: string): Fake[]; closest(selector: string): Fake | null };
  const previous = (globalThis as any).document;
  const doc: any = { activeElement: null, on: {} as Record<string, (e: any) => void>, addEventListener(k: string, f: (e: any) => void) { this.on[k] = f; },
    removeEventListener(k: string, f: (e: any) => void) { if (this.on[k] === f) delete this.on[k]; } };
  (globalThis as any).document = doc;
  const el = (id: string, kids: Fake[] = []): Fake => ({
    id, hidden: false, attrs: {}, on: {}, kids,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { this.on[k] = f; },
    focus() { doc.activeElement = this; },
    contains(other) { return other === this || this.kids.includes(other as Fake); },
    querySelectorAll(selector) { assert.equal(selector, '[role="menuitem"]'); return this.kids; },
    closest(selector) { assert.equal(selector, '[role="menuitem"]'); return this; },
  });
  const key = (name: string) => { const e = { key: name, prevented: false, stopped: false, preventDefault() { e.prevented = true; }, stopPropagation() { e.stopped = true; } }; return e; };
  try {
    const [tasks, attach] = [el('tasks'), el('attach')];
    const menu = el('menu', [tasks, attach]);
    menu.hidden = true;
    const button = el('button');
    let closes = 0;
    ui.attachMenu(button, menu, () => { closes++; });
    assert.equal(doc.on.pointerdown, undefined, 'a closed menu adds no page-wide listener');
    const shows = (open: boolean, focus: Fake, why: string) => {
      assert.deepEqual([menu.hidden, button.attrs['aria-expanded'], doc.activeElement.id], [!open, String(open), focus.id], why);
      assert.equal(typeof doc.on.pointerdown, open ? 'function' : 'undefined', `${why}: the press listener lives only while open`);
    };

    button.on.click({});   // Enter and Space arrive as a click
    shows(true, tasks, 'opens at the first item');
    menu.on.keydown(key('ArrowDown')); shows(true, attach, '↓');
    menu.on.keydown(key('ArrowDown')); shows(true, tasks, '↓ wraps');
    menu.on.keydown(key('ArrowUp')); shows(true, attach, '↑ wraps');
    const esc = key('Escape');
    menu.on.keydown(esc);
    shows(false, button, 'Esc closes and returns focus');
    assert.deepEqual([esc.prevented, esc.stopped], [true, true], 'Esc does not also close the panel around it');
    assert.equal(closes, 1, 'onClose runs after a close');

    const up = key('ArrowUp');
    button.on.keydown(up);
    shows(true, attach, '↑ on the button opens at the last item');
    assert.equal(up.prevented, true);
    button.on.click({});
    shows(false, button, 'a second click closes');
    button.on.keydown(key('ArrowDown'));
    shows(true, tasks, '↓ on the button opens at the first item');
    button.on.keydown(key('a'));
    shows(true, tasks, 'other keys do nothing');

    menu.on.click({ target: attach });
    shows(false, button, 'choosing an item closes and returns focus');

    // A hidden item (tasks switched off) is skipped.
    tasks.hidden = true;
    button.on.click({});
    shows(true, attach, 'the first visible item');
    menu.on.keydown(key('ArrowDown')); shows(true, attach, 'the only item keeps focus');

    // A press elsewhere closes without taking focus; a press inside or on the button is left to their own handlers.
    doc.on.pointerdown({ target: attach });
    doc.on.pointerdown({ target: button });
    assert.equal(menu.hidden, false);
    const elsewhere = el('elsewhere');
    elsewhere.focus();
    doc.on.pointerdown({ target: elsewhere });
    assert.deepEqual([menu.hidden, button.attrs['aria-expanded'], doc.activeElement.id, doc.on.pointerdown], [true, 'false', 'elsewhere', undefined]);

    // Tab away: focus left the menu, so it closes on the next tick.
    button.on.click({});
    elsewhere.focus();
    menu.on.focusout({});
    await new Promise((ok) => setTimeout(ok, 0));
    assert.deepEqual([menu.hidden, doc.activeElement.id], [true, 'elsewhere']);
  } finally { (globalThis as any).document = previous; }
});

test('web ui: the limits live in a settings dialog opened from the sidebar; the pause switch stays in the sidebar', () => {
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  const sidebar = html.slice(html.indexOf('<aside id="sidebar">'), html.indexOf('</aside>'));
  assert.match(sidebar, /<button id="open-settings"[^>]*aria-label="设置"/);
  assert.match(sidebar, /<button id="pause"/);
  assert.doesNotMatch(sidebar, /id="limits"/);
  const dialog = html.slice(html.indexOf('<dialog id="settings-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="settings-dialog"')));
  for (const id of ['limits', 'hop-form', 'chain-form', 'settings-pause', 'settings-close']) assert.ok(dialog.includes(`id="${id}"`), id);
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /settingsDialog\.addEventListener\('close', \(\) => \{[\s\S]*?disposeInstallPanel\(\);[\s\S]*?\$\('open-settings'\)\.focus\(\);/);
});

test('web ui: the plugins section lists each plugin with its switch, and a refused switch flips back', async () => {
  const pub = join(REPO_ROOT, 'src', 'web', 'public');
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const dialog = html.slice(html.indexOf('<dialog id="settings-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="settings-dialog"')));
  assert.ok(dialog.includes('id="plugin-list"'));
  assert.match(html, /重启 Hub 后生效/);
  assert.match(readFileSync(join(pub, 'app.js'), 'utf8'), /createPluginSettings\(api, \$\('plugin-list'\), pluginConfig\.openPlugin\)/);
  assert.doesNotMatch(readFileSync(join(pub, 'plugins.js'), 'utf8'), /\balert\(/);

  type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, (event?: any) => void>; focused?: boolean;
    setAttribute(k: string, v: string): void; addEventListener(k: string, f: (event?: any) => void): void; append(...c: (El | string)[]): void; focus(): void; showModal(): void; remove(): void };
  const previous = (globalThis as any).document;
  const body: El[] = [];
  (globalThis as any).document = {
    activeElement: null, body: { append: (dialog: El) => body.push(dialog) },
    createElement: (tag: string): El => ({
      tag, attrs: {}, kids: [], on: {},
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      addEventListener(k: string, f: (event?: any) => void) { this.on[k] = f; },
      append(...c: (El | string)[]) { this.kids.push(...c); },
      focus() { this.focused = true; }, showModal() {}, remove() {},
    }),
    createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),   // sprite icons
  };
  const text = (e: El | string): string => (typeof e === 'string' ? e : e.kids.map(text).join(''));
  const inputs = (e: El | string): El[] => typeof e === 'string' ? [] : [...(e.tag === 'input' ? [e] : []), ...e.kids.flatMap(inputs)];
  try {
    const { createPluginSettings, pluginRow } = await import(pathToFileURL(join(pub, 'plugins.js')).href);
    let groups: El[] = [];
    // The list holds two groups (official, third-party); `rows` are the plugin cards in them, in order.
    const cardsOf = (e: El | string): El[] => typeof e === 'string' ? [] : e.tag === 'article' ? [e] : e.kids.flatMap(cardsOf);
    let rows: El[] = [];
    const list = { replaceChildren: (...r: El[]) => { groups = r; rows = r.flatMap(cardsOf); },
      querySelector: (selector: string) => groups.flatMap(inputs).find((i) => selector === `[data-plugin="${i.attrs['data-plugin']}"]`) };
    const entry = (over: object) => ({ version: '1.0.0', requires: [], description: '一句话', enabled: true, disabledByEnv: false, pendingEnabled: true, ...over });
    const installed = [entry({ id: 'tasks', name: '任务' }), entry({ id: 'coord', name: '协调员', requires: ['tasks'] }),
      entry({ id: 'env', name: '环境', enabled: false, disabledByEnv: true, pendingEnabled: false })];
    const external = entry({ id: 'external-test', name: '外部', origin: 'external', permissions: ['messages.read'], clusterIds: ['one'],
      runtime: { state: 'failed', error: 'plugin process exited' } });
    const externalRow = pluginRow(external, [external], false, () => {});
    assert.match(text(externalRow), /外部进程：failed/);
    assert.match(text(externalRow), /外部进程错误：plugin process exited/);
    assert.match(text(externalRow), /第三方/);
    assert.match(text(externalRow), /已授权：messages.read；限定 1 个群。独立进程不是安全沙箱。/);
    assert.doesNotMatch(text(externalRow), /发言设置|发言检查/);
    const gate = { ...external, permissions: ['messages.read', 'messages.gate'] };
    assert.match(text(pluginRow(gate, [gate], false, () => {})), /发言检查（messages\.gate）：可以在群员发言前拒绝这条发言（不能修改内容）/);
    const writer = { ...external, permissions: ['messages.send', 'messages.mention'], writeClusterIds: ['one', 'two'],
      writeSettings: { mentionEnabled: true, perMinute: null, perHour: 200 } };
    const writeRow = pluginRow(writer, [writer], false, () => {});
    assert.match(text(writeRow), /唤醒已开启每分钟上限：无限/);
    assert.match(text(writeRow), /可发言的群：2 个/);
    assert.equal(inputs(writeRow).find((i) => i.attrs['aria-label'] === '允许外部唤醒成员')?.attrs.checked, '');
    const sendOnly = { ...writer, permissions: ['messages.send'] };
    assert.doesNotMatch(text(pluginRow(sendOnly, [sendOnly], false, () => {})), /允许插件唤醒成员|唤醒已开启/);
    const calls: unknown[][] = [];
    let answer: () => unknown = () => ({ installed });
    const settings = createPluginSettings(async (...args: unknown[]) => { calls.push(args); return answer(); }, list);

    await settings.load();
    assert.deepEqual(calls[0], ['GET', '/api/plugins']);
    assert.equal(groups.length, 2, 'official and third-party groups');
    assert.match(text(groups[1]), /还没有第三方插件。可以在下方安装。/);
    assert.match(text(rows[0]), /任务 ?1\.0\.0一句话/);
    assert.match(text(rows[1]), /依赖：任务/, 'a dependency shows by its name');
    assert.match(text(rows[2]), /由环境变量禁用/);
    assert.doesNotMatch(text(rows[0]), /重启 Hub/);
    const [taskSwitch, , envSwitch] = rows.map((row) => inputs(row)[0]);
    assert.equal(taskSwitch.attrs.checked, '');
    assert.equal(taskSwitch.attrs.disabled, undefined);
    assert.equal(envSwitch.attrs.checked, undefined);
    assert.equal(envSwitch.attrs.disabled, '', 'the variable cannot be overruled from the page');

    answer = () => ({ installed: [{ ...installed[0], pendingEnabled: false }, installed[1], installed[2]] });
    await taskSwitch.on.change({ target: { checked: false } });
    assert.deepEqual(calls[1], ['PUT', '/api/plugins/tasks', { enabled: false }]);
    assert.match(text(rows[0]), /重启 Hub 后生效：将禁用/);
    assert.equal(inputs(rows[0])[0].attrs.checked, undefined, 'the switch shows the next start');
    assert.equal(inputs(rows[0])[0].focused, true, 'focus stays on the switch that was used');

    answer = () => { throw new Error('不能禁用“任务”：“协调员”依赖它'); };
    const refused = inputs(rows[1])[0].on.change({ target: { checked: false } });
    await new Promise((ok) => setImmediate(ok));
    assert.equal(inputs(rows[1])[0].attrs.checked, '', 'the last good state is back');
    assert.match(text(body[0]), /操作插件失败.*“协调员”依赖它/, 'the error shows in a page dialog');
    (body[0] as any).returnValue = '';
    body[0].on.close();
    await refused;

    let answerOld: (value: unknown) => void = () => {};
    let reads = 0;
    const racing = createPluginSettings(() => (++reads === 1
      ? new Promise((ok) => { answerOld = ok; })
      : Promise.resolve({ installed: [{ ...installed[0], pendingEnabled: false }] })), list);
    const old = racing.load();
    await racing.load();
    answerOld({ installed: [installed[0]] });
    await old;
    assert.match(text(rows[0]), /重启 Hub 后生效：将禁用/, 'a slow older read does not overwrite the newer answer');
  } finally { (globalThis as any).document = previous; }
});

test('web ui: plugin write settings confirm new risks and submit only changed values', async () => {
  const { pluginWriteSubmission } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/plugins.js')).href);
  const plugin = { permissions: ['messages.send', 'messages.mention'], writeSettings: { mentionEnabled: false, perMinute: null, perHour: 200 } };
  const fields = { mentionEnabled: false, perMinute: { unlimited: true, value: '' }, perHour: { unlimited: false, value: '200' } };
  assert.deepEqual(pluginWriteSubmission(plugin, fields), { body: {}, confirm: null });
  assert.deepEqual(pluginWriteSubmission(plugin, { ...fields, perHour: { unlimited: false, value: ' 250 ' } }), { body: { perHour: 250 }, confirm: null });
  const wake = pluginWriteSubmission(plugin, { ...fields, mentionEnabled: true });
  assert.deepEqual(wake.body, { mentionEnabled: true });
  assert.match(wake.confirm?.message ?? '', /模型用量/);
  const unlimited = pluginWriteSubmission(plugin, { ...fields, perHour: { unlimited: true, value: '' } });
  assert.deepEqual(unlimited.body, { perHour: null, confirmUnlimited: true });
  assert.match(unlimited.confirm?.message ?? '', /每小时上限.*无限.*刷屏.*未读列表.*群聊历史.*开启唤醒.*模型用量/);
  assert.match(pluginWriteSubmission(plugin, { ...fields, perHour: { unlimited: false, value: '0' } }).error ?? '', /正整数/);
  const sendOnly = { ...plugin, permissions: ['messages.send'] };
  assert.deepEqual(pluginWriteSubmission(sendOnly, { ...fields, mentionEnabled: true }), { body: {}, confirm: null });
});

test('web ui: the two-pane create dialog posts exactly what the one-column dialog did for the same choices', () => {
  const claude = { ...base, harness: 'claude', nativeCreate: false, mode: 'native', project: 'D:\\w',
    sessions: [{ sessionId: 'c1', name: ' lead ', avatar: '🦊' }, { sessionId: 'c2', name: '', avatar: '' }] };
  const codex = { ...base, mode: 'native', project: 'D:\\w', sessions: [{ sessionId: 'x1', name: 'gpt', avatar: 'preset:robot' }],
    create: true, name: ' extra ', model: 'gpt-a', effort: 'high' };
  const kimi = { ...base, harness: 'kimi', project: 'D:\\k', create: true, name: 'rev' };
  const members = [
    { harness: 'claude', sessionId: 'c1', name: 'lead', avatar: '🦊' },
    { harness: 'claude', sessionId: 'c2' },
    { harness: 'codex', sessionId: 'x1', name: 'gpt', avatar: 'preset:robot' },
    { harness: 'codex', mode: 'native', projectPath: 'D:\\w', name: 'extra', model: 'gpt-a', effort: 'high' },
    { harness: 'kimi', mode: 'native', projectPath: 'D:\\k', name: 'rev' },
  ];
  assert.deepEqual(ui.createRequest('c 1', 'ignored', [claude, codex, kimi]),
    { request: { path: '/api/clusters/c%201/members', body: { members } } });
  assert.deepEqual(ui.createRequest(null, 'team', [claude, codex, kimi]), { request: { path: '/api/clusters', body: { name: 'team', members } } });
  // The first incomplete app is named, so the page can show it; nothing ticked is its own error.
  const empty = { ...claude, sessions: [] };
  assert.deepEqual(ui.createRequest('c', '', [codex, empty, { ...empty, harness: 'cursor' }]),
    { error: ui.harnessSpecs(empty).error, harness: 'claude' });
  assert.deepEqual(ui.createRequest('c', '', []), { error: '至少勾选一个 harness' });
});

test('web ui: names edited on a conversation that is not in focus are sent as typed, in pick order', () => {
  // The dialog shows one conversation's editor at a time; the others keep their values and are still sent.
  const claude = { ...base, harness: 'claude', nativeCreate: false, mode: 'native', project: 'D:\\w',
    sessions: [{ sessionId: 'c2', name: ' 审查员 ', avatar: '' }, { sessionId: 'c1', name: 'claude-opus', avatar: '🦊' }, { sessionId: 'c3', name: '', avatar: '' }] };
  assert.deepEqual(ui.createRequest('c', '', [claude]).request.body.members, [
    { harness: 'claude', sessionId: 'c2', name: '审查员' },
    { harness: 'claude', sessionId: 'c1', name: 'claude-opus', avatar: '🦊' },
    { harness: 'claude', sessionId: 'c3' },
  ]);
});

test('web ui: a picked entry marks an invalid or duplicate name; an empty one is left to the Hub', () => {
  const taken = new Set(['claude-opus']);
  assert.equal(ui.memberNameProblem('', taken, []), null);
  assert.equal(ui.memberNameProblem('审查员.v2_a-b', taken, []), null);
  for (const bad of ['bad name', 'a/b', 'all', 'user', '@x']) assert.equal(ui.memberNameProblem(bad, taken, []), '名字无效', bad);
  assert.match(ui.memberNameProblem('claude-opus', taken, []), /重名/);
  assert.match(ui.memberNameProblem('rev', new Set(), ['rev']), /重名/, 'another picked entry of the app sends it');
  assert.equal(ui.memberNameProblem('rev', new Set(), ['rev-2']), null);
  const row = ui.appRowSummary({ ...base, mode: 'native', checked: true, loadFailed: false, sessions: [{ sessionId: 'a' }], memberProblem: true });
  assert.deepEqual(row, { text: '选了 1 个对话 · 添加 1 个成员', problem: '成员名字有问题' }, 'the app row lights up too');
  // The page's copy of the Hub's member-name rule must not drift from it.
  const hub = readFileSync(join(REPO_ROOT, 'src', 'core', 'hub.ts'), 'utf8');
  const uiSrc = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js'), 'utf8');
  assert.ok(hub.includes(String.raw`/^[\p{L}\p{N}_.-]+$/u`) && uiSrc.includes(String.raw`/^[\p{L}\p{N}_.-]+$/u`));
});

test('web ui: an app row says whether it is ticked, what it adds and what is missing, without opening it', () => {
  const row = (c: object) => ui.appRowSummary({ ...base, checked: true, loadFailed: false, ...c });
  const two = [{ sessionId: 'a' }, { sessionId: 'b' }];
  assert.deepEqual(row({ checked: false, mode: 'native' }), { text: '未勾选', problem: null });
  assert.deepEqual(row({ checked: false, mode: 'native', nativeCreate: false, sessions: two }), { text: '未勾选 · 已选 2 个对话', problem: null },
    'unticking keeps what was picked');
  assert.deepEqual(row({ mode: 'native', sessions: two }), { text: '选了 2 个对话 · 添加 2 个成员', problem: null });
  assert.deepEqual(row({ mode: 'native', sessions: two, create: true, project: 'C:\\p' }), { text: '选了 2 个对话，新建 1 个对话 · 添加 3 个成员', problem: null });
  assert.deepEqual(row({ create: true, project: 'C:\\p' }), { text: '新建 1 个对话 · 添加 1 个成员', problem: null });
  assert.deepEqual(row({ create: true }), { text: '已勾选', problem: '请选择新建对话的项目目录' }, 'a new conversation without a project');
  assert.deepEqual(row({ mode: 'native' }), { text: '已勾选', problem: '还没选对话' }, 'nothing picked: no default conversation');
  assert.deepEqual(row({ mode: 'native', nativeCreate: false }), { text: '已勾选', problem: '还没选对话' });
  assert.deepEqual(row({ mode: 'native', sessions: two, loadFailed: true }), { text: '已勾选', problem: '列表加载失败' });
  assert.deepEqual(row({ checked: false, mode: 'native', nativeCreate: false, loadFailed: true }), { text: '未勾选', problem: null },
    'an unticked app is not submitted, so it has nothing to fix');
});

test('web ui: ticking shows the ticked app, unticking stays put; arrow keys move between rows without wrapping', () => {
  assert.equal(ui.focusAfterTick('codex', 'claude', true), 'claude');
  assert.equal(ui.focusAfterTick('codex', 'claude', false), 'codex');
  assert.equal(ui.focusAfterTick('claude', 'claude', false), 'claude');
  assert.equal(ui.rowAfterKey(1, 4, 'ArrowDown'), 2);
  assert.equal(ui.rowAfterKey(3, 4, 'ArrowDown'), 3);
  assert.equal(ui.rowAfterKey(0, 4, 'ArrowUp'), 0);
  assert.equal(ui.rowAfterKey(2, 4, 'Home'), 0);
  assert.equal(ui.rowAfterKey(0, 4, 'End'), 3);
  assert.equal(ui.rowAfterKey(1, 4, 'Enter'), null);
  // The submit handler builds the request with createRequest only (no second path that could drift).
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const submit = app.slice(app.indexOf("$('create-form').addEventListener('submit'"));
  assert.match(submit.slice(0, submit.indexOf('} finally {')), /createRequest\(clusterId, \$\('create-name'\)\.value, choices\)[\s\S]*api\('POST', request\.path, request\.body\)/);
});

test('web ui: the create dialog locks before reading avatars, so a second click cannot post the same members', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const submit = app.slice(app.indexOf("$('create-form').addEventListener('submit'"));
  const lock = submit.indexOf('creating = true;');
  assert.ok(lock > 0 && lock < submit.indexOf('await f.choice()'), 'the lock is taken before the first await');
  assert.ok(submit.indexOf('await f.choice()') < submit.indexOf('} finally {'), 'reading the choices is inside the try that releases it');
});

test('web ui: preset avatars are references the page renders from /avatars/, never image data', () => {
  assert.equal(ui.presetName('preset:chatgpt-2'), 'chatgpt-2');
  assert.equal(ui.presetName('preset:glm'), 'glm');
  for (const bad of ['preset:', 'preset:../x', 'preset:UPPER', 'preset:-x', 'preset:a_b', 'preset:a--b', '🦊', 'data:image/png;base64,AA==', null, undefined]) {
    assert.equal(ui.presetName(bad), null, String(bad));
  }
  // The avatar element loads the shipped PNG through <img>; the editor offers the names from the Hub, never a data URL.
  const uiSrc = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js'), 'utf8');
  assert.ok(uiSrc.includes("`/avatars/${preset}.png`"), 'avatarEl addresses /avatars/<name>.png');
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /api\('GET', '\/api\/avatars'\)/);
  assert.match(app, /function presetPicker\(/);
  assert.match(app, /S\.avatars\.map\(\(name\) =>/);
  assert.match(app, /presetName\(m\.avatar\)/);
  // A create dialog opened before the list arrived gets its preset rows once it does.
  assert.match(app, /for \(const f of harnessForms\) f\.refreshPresets\(\);/);
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  assert.match(html, /data-role=\"presets\"/);
});

test('web ui: a member without an avatar shows its app\'s icon with its own mark; set avatars and apps without an icon are unchanged', () => {
  type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, (e: any) => void>;
    setAttribute(k: string, v: string): void; addEventListener(k: string, f: (e: any) => void): void; append(...c: (El | string)[]): void };
  const prev = (globalThis as any).document;
  (globalThis as any).document = { createElement: (tag: string): El => ({ tag, attrs: {}, kids: [], on: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; }, append(...c) { this.kids.push(...c); } }) };
  try {
    const m = (extra: Record<string, unknown>) => ({ name: 'opus', harness: 'claude', avatar: null, ...extra });
    const el = (extra: Record<string, unknown>, size = 'sm', opts = {}) => ui.avatarEl(m(extra), size, opts) as El;
    const img = (e: El) => e.kids.find((k): k is El => typeof k !== 'string' && k.tag === 'img');

    // No avatar, known app: the app's icon (alt="": the name is beside it), the member's colour and initial in the mark.
    const app = el({});
    assert.equal(ui.avatarKind(m({})), 'app');
    assert.equal(app.attrs.class, `avatar sm app ${ui.APP_AVATAR_MARK}`);
    assert.deepEqual([img(app)!.attrs.src, img(app)!.attrs.alt], ['/app-icons/claude.ico', '']);
    assert.equal(app.attrs.style, `--mark: ${ui.memberColor('opus')}`);
    if (ui.APP_AVATAR_MARK === 'badge') assert.deepEqual([(app.kids[1] as El).attrs, (app.kids[1] as El).kids], [{ class: 'avatar-mark', 'aria-hidden': 'true' }, ['O']]);
    else assert.equal(app.kids.length, 1, 'ring: the colour is the ring, no letter');
    // Every avatar's tooltip is the name; standing alone (named), the name is also its accessible name.
    assert.equal(app.attrs.title, 'opus');
    assert.equal(app.attrs['aria-label'], undefined, 'beside the name: not read twice');
    const named = el({}, 'sm', { named: true });
    assert.deepEqual([named.attrs.role, named.attrs['aria-label']], ['img', 'opus']);
    // A member who has left keeps the old rule in the history: the initial tile, or its own avatar.
    assert.equal(ui.avatarKind(m({ removedAt: 'then' })), 'initial');
    assert.equal(ui.avatarKind(m({ removedAt: 'then', avatar: '🦊' })), 'emoji');
    assert.equal(img(el({ harness: 'cursor' }))!.attrs.src, '/app-icons/cursor.ico', '.ico and .png icons alike');
    // Two members of one app differ in their marks: another letter, and for these two names another colour.
    const other = el({ name: 'sonnet' });
    assert.notEqual(other.attrs.style, app.attrs.style);
    if (ui.APP_AVATAR_MARK === 'badge') assert.deepEqual((other.kids[1] as El).kids, ['S']);
    // A broken icon turns the same element into the initial tile, never a broken-image glyph.
    const parent = { className: '', style: '', kids: [] as unknown[], setAttribute(k: string, v: string) { (this as any)[k] = v; },
      replaceChildren(...c: unknown[]) { this.kids = c; } };
    img(app)!.on.error({ target: { parentElement: parent } });
    assert.deepEqual([parent.className, parent.style, parent.kids], ['avatar sm', `background: ${ui.memberColor('opus')}`, ['O']]);

    // No avatar, an app without an icon (mock, a newer adapter): the initial tile as before.
    const tile = el({ harness: 'mock' });
    assert.equal(ui.avatarKind(m({ harness: 'mock' })), 'initial');
    assert.deepEqual([tile.attrs.class, tile.attrs.style, tile.kids], ['avatar sm', `background: ${ui.memberColor('opus')}`, ['O']]);
    // A set avatar wins over the app: emoji, preset, uploaded image (and an invalid value is the default again).
    assert.deepEqual([el({ avatar: '🦊' }).attrs.class, el({ avatar: '🦊' }).kids], ['avatar sm emoji', ['🦊']]);
    assert.equal(img(el({ avatar: 'preset:glm' }))!.attrs.src, '/avatars/glm.png');
    assert.equal(img(el({ avatar: 'data:image/png;base64,AA==' }))!.attrs.src, 'data:image/png;base64,AA==');
    assert.deepEqual(['🦊', 'preset:glm', 'data:image/png;base64,AA==', 'preset:../x', 'data:text/html,x'].map((avatar) => ui.avatarKind(m({ avatar }))),
      ['emoji', 'preset', 'image', 'emoji', 'app']);
  } finally { (globalThis as any).document = prev; }
});

test('web ui: a member\'s colour keeps its hue and carries a white letter at 4.5:1', () => {
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const rgb = (h: number, s: number, l: number) => { s /= 100; l /= 100; const a = s * Math.min(l, 1 - l);
    const f = (n: number) => { const k = (n + h / 30) % 12; return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); }; return [f(0), f(8), f(4)]; };
  const hues = new Set<number>();
  for (let i = 0; i < 400; i++) {
    const [, h, s, l] = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(ui.memberColor(`member-${i}`))!.map(Number);
    hues.add(h);
    assert.equal(s, 42);
    const [r, g, b] = rgb(h, s, l);
    const ratio = 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
    assert.ok(ratio >= 4.5, `hue ${h}: ${ratio.toFixed(2)}`);
  }
  assert.equal(hues.size, 12, 'all twelve hues still in use');
});

test('web ui: memberMarks gives members of one app different one-character labels and colours', () => {
  let n = 0;
  const mem = (name: string, extra: Record<string, unknown> = {}) => ({ id: `m${n++}`, name, harness: 'claude', avatar: null, removedAt: null, ...extra });
  const labels = (list: ReturnType<typeof mem>[]) => { const marks = ui.memberMarks(list); return list.map((m) => marks.get(m.id)?.label ?? null); };
  // Different first characters: the first character, as before.
  assert.deepEqual(labels([mem('opus'), mem('sonnet'), mem('haiku')]), ['O', 'S', 'H']);
  // Same prefix: the first character after what each shares with the others, then its last name part, then more.
  assert.deepEqual(labels([mem('claude-2'), mem('claude-opus'), mem('claude-opus-2')]), ['2', 'O', 'P']);
  assert.deepEqual(labels([mem('claude'), mem('claude-2')]), ['C', '2'], 'a name that is the others\' prefix keeps its letter');
  assert.deepEqual(labels([mem('前端评审'), mem('前端开发'), mem('后端')]), ['评', '开', '后'], 'CJK');
  assert.deepEqual(labels([mem('a😀x'), mem('a😀y')]), ['X', 'Y']);
  const emoji = labels([mem('👩‍💻1'), mem('👩‍💻2'), mem('x👩‍💻')]);
  assert.deepEqual(emoji, ['1', '2', 'X'], 'an emoji is one grapheme, never split');
  // Names that give nothing: ordinals. Identical names cannot be told apart by text: ordinals too.
  assert.deepEqual(labels([mem('aa'), mem('aa'), mem('aa')]), ['A', '1', '2']);
  // Unique within the app, not across apps; other apps, custom avatars and removed members are not part of it.
  const mixed = [mem('codex', { harness: 'codex' }), mem('claude'), mem('cc', { avatar: '🦊' }), mem('cx', { removedAt: 'then' }), mem('mock', { harness: 'mock' })];
  assert.deepEqual(labels(mixed), ['C', 'C', null, null, null]);
  // Stability: an unrelated member (other initial or other app) joining changes nobody's label or colour.
  const base = [mem('claude-2'), mem('claude-opus')];
  const before = ui.memberMarks(base);
  const after = ui.memberMarks([...base, mem('sonnet'), mem('codex-1', { harness: 'codex' })]);
  for (const m of base) assert.deepEqual(after.get(m.id), before.get(m.id));
  // Colours differ within an app even when two names hash to the same hue, and keep 4.5:1 (lightness by hue).
  const names = Array.from({ length: 40 }, (_, i) => `member-${i}`);
  const hueOf = (c: string) => Number(/^hsl\((\d+) /.exec(c)![1]);
  const sameHue = names.filter((x) => hueOf(ui.memberColor(x)) === hueOf(ui.memberColor(names[0]))).slice(0, 2);
  assert.equal(sameHue.length, 2, 'two names with one hue');
  const pair = sameHue.map((x) => mem(x));
  const colours = pair.map((m) => ui.memberMarks(pair).get(m.id).color);
  assert.notEqual(colours[0], colours[1]);
  assert.equal(colours[0], ui.memberColor(sameHue[0]), 'the first keeps its own colour');
  assert.match(colours[1], new RegExp(`^hsl\\(${(hueOf(colours[0]) + 30) % 360} 42% `), 'the next hue, same lightness rule');
});

test('web ui: the member list does not repeat the app icon the avatar already shows; the editors show the default they return to', () => {
  const pub = join(REPO_ROOT, 'src', 'web', 'public');
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  // The badge drops its icon (keeping the words) exactly when the avatar is the app's icon, which then carries the
  // hover text.
  assert.match(app, /avatarKind\(m\) === 'app' \? null : appIcon\(\{ icon: app\.icon, label: app\.name \}\)\);/);
  assert.match(app, /'aria-label': appText\(m\), title: appText\(m\)/);
  assert.match(app, /if \(avatarKind\(m\) === 'app'\) el\.title = `\$\{m\.name\} · \$\{appText\(m\)\} · \$\{presenceOf\(m\)\.label\}`;/);
  // 恢复默认头像 (member page and list) shows the default avatar; the add dialog's 清除头像 the app's icon.
  assert.match(html, /data-role="reset-avatar"><span data-role="default-avatar"><\/span><span data-i18n="恢复默认头像">恢复默认头像<\/span>/);
  assert.match(app, /part\('default-avatar'\)\.replaceChildren\(avatarEl\(\{ \.\.\.m, avatar: null \}, 'xs'\)\)/);
  assert.match(app, /harnessApp\(harness\)\.icon \? avatarEl\(\{ name: '', harness, avatar: null \}, 'xs'\) : null, lt\('清除头像'\)/);
  // The workbench's member chips use the same avatar; the tone initials only when there is no picture or emoji.
  const wb = readFileSync(join(pub, 'workbench.js'), 'utf8');
  assert.match(wb, /member && avatarKind\(member\) !== 'initial' \? avatarEl\(member, 'xs'\)/);
  // 全部任务 lists every cluster: each row looks its members up in its own cluster, not the one selected.
  assert.match(wb, /const memberChip = \(id, clusterId = view\.clusterId\) => \{\n\s+const member = memberOf\(id, clusterId\);/);
  assert.match(wb, /\.\.\.hiddenChips\(task, group\.cluster\.id\), task\.assignedMemberId \? memberChip\(task\.assignedMemberId, group\.cluster\.id\)/);
  // The header stack has no names beside it: each avatar is named; the page feeds memberMarks per cluster.
  assert.match(app, /stackedMembers\(members\)\.map\(\(m\) => avatarEl\(m, 'sm', \{ named: true, presence: presenceOf\(m\) \}\)\)/);
  assert.match(app, /setAvatarMarks\(\(m\) => \{[\s\S]*?memberMarks\(membersOf\(m\.clusterId\)\)/);
});

test('web ui: unwrittenRecipients names only the recipients the text does not @', () => {
  const member = (id: string, extra = {}) => [id, { id, name: id, clusterId: 'c', removedAt: null, ...extra }];
  const members = new Map([member('a'), member('b'), member('me'), member('gone', { removedAt: 'then' }),
    ['x', { id: 'x', name: 'x', clusterId: 'other', removedAt: null }]] as [string, unknown][]);
  const none = new Set<string>();
  const shown = (body: string, mentions: string[] | undefined, extra = {}, handoffs = none) =>
    ui.unwrittenRecipients({ id: 'm1', clusterId: 'c', from: 'me', body, mentions, ...extra }, members, handoffs);

  // Sent with `to`: nothing written, so all of them show, in order. A removed member still shows; the page names it.
  assert.deepEqual(shown('review this', ['b', 'gone']), ['b', 'gone']);
  assert.deepEqual(shown('', ['a']), ['a'], 'an attachment-only message still shows them');
  // Written ones are not repeated; a partly written list only adds the rest.
  assert.deepEqual(shown('@a @b hi', ['a', 'b']), []);
  assert.deepEqual(shown('@a hi', ['a', 'b']), ['b']);
  assert.deepEqual(shown('- item @a\n\n| @b |\n|---|\n| x |', ['a', 'b']), [], 'lists and tables count');
  // A @ in code, inline code or quotes is not written.
  for (const body of ['```\n@a\n```', '`@a`', '> @a', '"@a"', '“@a”']) assert.deepEqual(shown(body, ['a']), ['a'], body);
  // Ordinary, system and handoff messages show nothing.
  assert.deepEqual(shown('no one', []), []);
  assert.deepEqual(shown('no one', undefined), []);
  assert.deepEqual(shown('notice', ['a'], { from: 'system' }), []);
  assert.deepEqual(shown('handed over', ['a'], {}, new Set(['m1'])), []);

  // A real @all adds no line, but only with both: an unquoted @all in the text and every other active member covered.
  assert.deepEqual(shown('@all hi', ['a', 'b']), []);
  assert.deepEqual(shown('@all hi', ['a', 'b', 'me'], { from: 'user' }), []);
  assert.deepEqual(shown('`@all` hi', ['a', 'b']), ['a', 'b'], 'quoted @all is not a call');
  assert.deepEqual(shown('hi', ['a', 'b']), ['a', 'b'], 'to everyone by name is not a call');
  assert.deepEqual(shown('@all hi', ['a']), ['a'], 'to one member, whatever the text says');
});

test('web ui: bodySegments highlights delivered @mentions, @all, and $skills as text; undelivered stays plain text', () => {
  const members = new Map([
    ['m-kimi', { id: 'm-kimi', name: 'kimi' }],
    ['m-claude', { id: 'm-claude', name: 'claude-opus-5-5' }],
    ['m-agent', { id: 'm-agent', name: 'agent' }],
    ['m-agent-1', { id: 'm-agent-1', name: 'agent-1' }],
    ['m-renamed', { id: 'm-renamed', name: 'bob' }], // was 'alice'
  ]);
  const skills = new Set(['ponytail', 'ponytail-review']);
  const mentions = ['m-kimi', 'm-claude', 'm-agent', 'm-agent-1', 'm-renamed'];

  // 1. Delivered mention + @all + $skill + undelivered mention (@stranger)
  const body1 = 'Hi @kimi and @all, please check with $ponytail, but not @stranger!';
  const segs1 = ui.bodySegments(body1, { skills, mentions, members });
  assert.deepEqual(segs1, [
    'Hi ',
    { mention: 'm-kimi', text: '@kimi' },
    ' and ',
    { mention: 'all', text: '@all' },
    ', please check with ',
    { skill: 'ponytail', text: '$ponytail' },
    ', but not @stranger!',
  ]);
  assert.equal(segs1.map((s: any) => (typeof s === 'string' ? s : s.text)).join(''), body1, 'nothing added or lost');

  // 2. Mention only delivered members: even if member exists in cluster, if not in mentions, it stays plain text
  const body2 = 'Sent to @kimi only, mentioning @claude-opus-5-5 in text';
  const segs2 = ui.bodySegments(body2, { skills, mentions: ['m-kimi'], members });
  assert.deepEqual(segs2, [
    'Sent to ',
    { mention: 'm-kimi', text: '@kimi' },
    ' only, mentioning @claude-opus-5-5 in text',
  ]);

  // 3. Renamed member: old name in text stays plain text (照原文显示)
  const body3 = 'Hello @alice and @bob';
  const segs3 = ui.bodySegments(body3, { skills, mentions, members });
  assert.deepEqual(segs3, [
    'Hello @alice and ',
    { mention: 'm-renamed', text: '@bob' },
  ]);

  // 4. Token boundaries:
  // - foo@bar is not a mention
  // - (@kimi) is a mention
  // - @kimi. at end of sentence matches @kimi, trailing . stays plain text
  // - @kimi.v2 is not a mention of @kimi
  // - CJK right after a name continues it (full names only): @kimi你好 is not @kimi; @kimi，你好 is
  // - Full names: @agent-1 matches agent-1, not agent
  const body4 = 'foo@bar (@kimi) @kimi. @kimi.v2 @kimi你好 @kimi，你好 @agent-1 @agent';
  const segs4 = ui.bodySegments(body4, { skills, mentions, members });
  assert.deepEqual(segs4, [
    'foo@bar (',
    { mention: 'm-kimi', text: '@kimi' },
    ') ',
    { mention: 'm-kimi', text: '@kimi' },
    '. @kimi.v2 @kimi你好 ',
    { mention: 'm-kimi', text: '@kimi' },
    '，你好 ',
    { mention: 'm-agent-1', text: '@agent-1' },
    ' ',
    { mention: 'm-agent', text: '@agent' },
  ]);

  // 5. Zero recipients: @all and mentions stay plain text if mentions array is empty (P2 review fix)
  assert.deepEqual(ui.bodySegments('@all', { mentions: [], members: new Map() }), ['@all']);
  assert.deepEqual(ui.bodySegments('@all and @kimi', { mentions: [], members }), ['@all and @kimi']);

  // 6. Empty or missing options
  assert.deepEqual(ui.bodySegments('', { skills, mentions, members }), []);
  assert.deepEqual(ui.bodySegments('just plain text'), ['just plain text']);

  // 7. Verification of app.js DOM rendering structure
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /class:\s*'mention'/);
  assert.match(app, /class:\s*'mention link'/);
  assert.match(app, /select\(msg\.clusterId,\s*seg\.mention\)/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/, 'the page never parses strings as HTML');
});

test('web ui usage: token counts read short, resets say when or "已重置", quota lines and the cluster total', () => {
  assert.deepEqual([0, 950, 12_345, 123_456, 3_400_000, 45_000_000].map(ui.fmtTokens), ['0', '950', '12K', '123K', '3.4M', '45M']);
  assert.equal(ui.fmtTokens(1234), '1.2K');
  const t = { input: 1200, cachedInput: 50_000, cacheWrite: 0, output: 300, reasoning: 100 };
  assert.equal(ui.tokenSum(t), 51_500);
  assert.equal(ui.tokenText(t), '共 52K：输入 1.2K · 缓存读 50K · 缓存写 0 · 输出 300（推理 100）');
  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.equal(ui.resetText('2026-11-03T11:59:00Z', now), '已重置');
  assert.equal(ui.resetText('2026-11-03T12:30:00Z', now), '30 分后重置');
  assert.equal(ui.resetText('2026-11-03T14:05:00Z', now), '2 小时 5 分后重置');
  assert.equal(ui.resetText('2026-11-10T12:00:00Z', now), '7 天后重置');
  assert.equal(ui.resetText(null, now), '');

  assert.deepEqual(ui.quotaLines({ harness: 'claude', supported: false, snapshot: null }, now), [{ label: '额度', percent: null, note: '暂不支持' }]);
  assert.deepEqual(ui.quotaLines({ harness: 'kimi', supported: true, snapshot: null, error: 'x' }, now), [{ label: '额度', percent: null, note: '读取失败：x' }]);
  const snap = { windows: [{ id: 'a', label: '5 小时', usedPercent: 32.6, resetsAt: '2026-11-03T13:00:00Z' }, { id: 'b', label: '每周', usedPercent: 90, resetsAt: '2026-11-01T00:00:00Z' }], observedAt: '2026-11-03T11:00:00Z', source: 'x' };
  assert.deepEqual(ui.quotaLines({ harness: 'codex', supported: true, snapshot: snap }, now), [
    { label: '5 小时', percent: 33, note: '1 小时 0 分后重置' }, { label: '每周', percent: null, note: '已重置' },
  ]);
  assert.equal(ui.quotaAsOf({ supported: true, snapshot: snap, error: 'down' }, () => '11:00'), '截至 11:00（最近一次读取失败：down）');
  assert.equal(ui.quotaAsOf({ supported: false, snapshot: null }), '');

  const zero = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  assert.equal(ui.clusterUsageText(null), '');
  assert.equal(ui.clusterUsageText({ members: [{ viaOrrery: null, conversation: null }], cluster: { viaOrrery: zero, conversation: zero } }), '');
  assert.equal(ui.clusterUsageText({ members: [{ viaOrrery: { totals: t, turns: 1 }, conversation: t }], cluster: { viaOrrery: t, conversation: { ...t, input: 2_000_000 } } }),
    'token：经 orrery 52K · 对话合计 2.1M');
});

test('web ui usage: usageView shows the member\'s harness quota (or 暂不支持) and its tokens as text only', () => {
  // A minimal document: elements keep attributes, listeners and children; text is collected from text nodes.
  type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, () => void>; setAttribute(k: string, v: string): void; addEventListener(k: string, f: () => void): void; append(...c: (El | string)[]): void };
  const prev = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string): El => ({
      tag, attrs: {}, kids: [], on: {},
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; }, append(...c) { this.kids.push(...c); },
    }),
  };
  const text = (e: El | string): string => (typeof e === 'string' ? e : e.kids.map(text).join('|'));
  const find = (e: El | string, pred: (x: El) => boolean): El | null => (typeof e === 'string' ? null : pred(e) ? e : e.kids.map((k) => find(k, pred)).find(Boolean) ?? null);
  try {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const t = { input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 };
    const usage = {
      clusterId: 'c', cluster: {},
      quotas: [{ harness: 'codex', supported: true, snapshot: { windows: [{ id: 'p', label: '每周', usedPercent: 41, resetsAt: '2026-11-04T12:00:00Z' }], observedAt: '2026-11-03T11:00:00Z', source: 'rollout' } },
        { harness: 'claude', supported: false, snapshot: null }],
      members: [{ memberId: 'm1', harness: 'codex', viaOrrery: { totals: t, turns: 2 }, conversationSupported: true, conversation: null },
        { memberId: 'm2', harness: 'claude', viaOrrery: null, conversationSupported: true, conversation: t }],
    };
    let refreshed = 0;
    const codex = ui.usageView({ id: 'm1', harness: 'codex', mode: 'native', name: '<b>x</b>' }, usage, { onRefresh: () => refreshed++, now });
    const s = text(codex);
    assert.match(s, /codex 额度/);
    assert.match(s, /每周\|\|已用 41% · 24 小时 0 分后重置/, 'label, bar (no text), percent and reset');
    assert.match(s, /经 orrery\|共 15：输入 10 · 缓存读 0 · 缓存写 0 · 输出 5（2 轮）/);
    assert.match(s, /整个对话\|读不到/);
    assert.equal(find(codex, (e) => e.attrs.role === 'meter')!.attrs['aria-valuenow'], '41');
    find(codex, (e) => e.tag === 'button')!.on.click();
    assert.equal(refreshed, 1);
    const claude = text(ui.usageView({ id: 'm2', harness: 'claude', mode: 'native', name: 'c' }, usage, { onRefresh: () => {}, now }));
    assert.match(claude, /额度\|暂不支持/);
    assert.match(claude, /经 orrery\|暂无记录/);
    assert.equal(find(ui.usageView({ id: 'm2', harness: 'claude', mode: 'native', name: 'c' }, usage, { onRefresh: () => {}, now }), (e) => e.tag === 'button'), null, 'no refresh without a source');
    assert.equal(text(ui.usageView({ id: 'm1', harness: 'codex', mode: 'native', name: 'x' }, null)), '', 'nothing before the report arrives');

    // The member panel: a short token line per member row (the quota is on each row: memberDetails).
    assert.equal(ui.memberTokensText(usage.members[0]), '经 orrery 15（2 轮）');
    assert.equal(ui.memberTokensText(usage.members[1]), '对话 15');
    assert.equal(ui.memberTokensText(null), '');
  } finally {
    (globalThis as any).document = prev;
  }
});

test('web ui member list: model, project, conversation and the app\'s quota on each row; unknowns say so, old values say when', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const fmt = (iso: string) => iso.slice(11, 16);
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const member = (o: Record<string, unknown> = {}) => ({ id: 'm1', name: 'a', harness: 'claude', model: null, effort: null,
    cwd: 'D:\\work\\shop', workerSessionId: 's1', ...o });
  const snapshot = (pct: number, observed = at(2)) => ({ windows: [{ id: 'h5', label: '5 小时', usedPercent: pct, resetsAt: at(-75) },
    { id: 'wk', label: '每周', usedPercent: 41, resetsAt: at(-3 * 1440) }], observedAt: observed, source: 'x' });
  const quota = (pct: number, observed?: string) => ({ harness: 'claude', supported: true, snapshot: snapshot(pct, observed) });
  const d = (m: Record<string, unknown>, row: unknown, q: unknown, loaded = true) => ui.memberDetails(member(m), row, q, { usageLoaded: loaded, now, fmt });

  // Two conversations of one app in different projects: told apart by project and title.
  const a = d({}, { session: { sessionId: 's1', title: '修复结账页', model: 'claude-opus', observedAt: at(1) } }, quota(93));
  const b = d({ id: 'm2', cwd: '/home/u/backend-services/', workerSessionId: 's2' }, { session: { sessionId: 's2', title: '订单服务重试', model: 'claude-sonnet', observedAt: at(1) } }, quota(93));
  assert.deepEqual([a.model.text, a.project.text, a.conversation.text], ['claude-opus', 'shop', '修复结账页']);
  assert.deepEqual([b.model.text, b.project.text, b.conversation.text], ['claude-sonnet', 'backend-services', '订单服务重试']);
  assert.equal(a.project.title, '项目（工作目录）：D:\\work\\shop', 'the full path on hover');
  assert.match(a.conversation.title, /会话 ID：s1/);
  // The quota is the app account's: the same on both rows, marked as claude's, nearly used up in words (not colour only).
  assert.equal(a.quota.text, 'claude 额度 快用完 93%（5 小时）');
  assert.equal(a.quota.text, b.quota.text);
  assert.equal(a.quota.level, 'warning');
  assert.match(a.quota.title, /^claude 账号的额度，同一应用的群员共用\n5 小时：已用 93% · 1 小时 15 分后重置\n每周：已用 41% · 3 天后重置\n截至 11:58$/);
  assert.equal(d({}, null, quota(100)).quota.text, 'claude 额度 已用完 100%（5 小时）');
  assert.equal(d({}, null, quota(20, at(90))).quota.text, 'claude 额度 41%（每周，截至 10:30）', 'the most used window; an old reading says when');

  // Unknowns: no model anywhere, no title read, no quota source, nothing read yet, no report yet.
  const unknown = d({}, { session: null }, { harness: 'claude', supported: false, snapshot: null });
  assert.deepEqual([unknown.model.text, unknown.conversation.text, unknown.quota.text], ['模型未知', '对话标题未知', '额度不支持']);
  assert.equal(d({}, null, { harness: 'claude', supported: true, snapshot: null, error: 'x' }).quota.text, '额度未读到');
  assert.equal(d({}, null, undefined).quota.text, '额度未知');
  assert.equal(d({}, null, undefined, false).quota, null, 'before GET /api/usage answers: no quota part');
  assert.equal(d({ cwd: '' }, null, null).project.text, '项目未知');
  // Only the model stored at add time: labelled as such; a reading older than the re-read interval says when.
  assert.equal(d({ model: 'gpt-5' }, null, null).model.text, 'gpt-5（加入时）');
  const seen = d({}, { session: { sessionId: 's1', title: 't', model: 'gpt-5', observedAt: at(45) } }, null);
  // The row marks project and conversation with icons; only an old title says when it was read.
  assert.deepEqual([seen.model.text, seen.conversation.prefix, a.conversation.prefix, a.project.prefix], ['gpt-5（11:15 读到）', '（11:15 读到）', undefined, undefined]);
  // Very long values stay whole in the data (the row truncates them with CSS and shows them on hover).
  const long = '很长的标题'.repeat(40);
  assert.equal(d({}, { session: { sessionId: 's1', title: long, model: null, observedAt: at(1) } }, null).conversation.text, long);
  assert.equal(ui.projectName('C:\\a\\b\\'), 'b');
  assert.equal(ui.projectName(null), '');
});

test('web ui member list: a row\'s details in tiers: model; project and conversation; a quiet usage line; a long conversation\'s warning in its own row', () => {
  type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; setAttribute(k: string, v: string): void; addEventListener(): void; append(...c: (El | string)[]): void };
  const prev = (globalThis as any).document;
  const make = (tag: string): El => ({ tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, append(...c) { this.kids.push(...c); } });
  (globalThis as any).document = { createElement: make, createElementNS: (_ns: string, tag: string) => make(tag) };
  const cls = (e: El) => e.attrs.class ?? '';
  const all = (e: El | string, pred: (x: El) => boolean): El[] => (typeof e === 'string' ? [] : [...(pred(e) ? [e] : []), ...e.kids.flatMap((k) => all(k, pred))]);
  const text = (e: El | string, skipHidden = false): string => (typeof e === 'string' ? e
    : skipHidden && (e.attrs['aria-hidden'] === 'true') ? '' : e.kids.map((k) => text(k, skipHidden)).join(''));
  const seen = (e: El | string): string => (typeof e === 'string' ? e : cls(e).includes('sr-only') ? '' : e.kids.map(seen).join(''));
  try {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const fmt = (iso: string) => iso.slice(11, 16);
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const quota = (pct: number, observed = at(2)) => ({ harness: 'claude', supported: true, snapshot: { windows: [{ id: 'h5', label: '5 小时', usedPercent: pct, resetsAt: at(-75) }], observedAt: observed, source: 'x' } });
    const member = { id: 'm1', name: 'a', harness: 'claude', model: null, effort: null, cwd: 'D:\\work\\shop', workerSessionId: 's1' };
    const row = { session: { sessionId: 's1', title: '修复结账页', model: 'claude-opus', observedAt: at(1) } };
    const d = (q: unknown, loaded = true) => ui.memberDetails(member, row, q, { usageLoaded: loaded, now, fmt });
    const view = (q: unknown, extra = {}) => ui.memberDetailsView(d(q), extra);

    // Tier 2: the model on its own line, then project and conversation together; tier 3: the usage line.
    const normal = view(quota(41), { tokens: '经 orrery 1.2M（7 轮） · 对话 14M' });
    const lines = normal.kids as El[];
    assert.deepEqual(lines.map(cls), ['member-line member-line-model', 'member-line member-line-where', 'member-line member-usage']);
    assert.equal(seen(lines[0]), 'claude-opus');
    assert.equal(seen(lines[1]), 'shop修复结账页');
    assert.deepEqual(all(lines[1], (e) => cls(e).startsWith('member-detail')).map((e) => e.attrs.title), ['项目（工作目录）：D:\\work\\shop', d(quota(41)).conversation.title]);
    // A normal quota: a meter and the number; the whole sentence for hover and screen readers.
    const q = all(lines[2], (e) => cls(e).includes('member-quota'))[0];
    assert.equal(cls(q), 'member-detail member-quota quota-ok');
    assert.equal(seen(q), '41%');
    assert.equal(text(q, true), 'claude 额度 41%（5 小时）', 'screen readers: the sentence, once');
    assert.match(q.attrs.title, /^claude 账号的额度，同一应用的群员共用\n5 小时：已用 41%/);
    assert.equal((all(q, (e) => cls(e) === 'member-meter')[0].kids[0] as El).attrs.style, 'width: 41%');
    // The token parts each stay whole; nothing is cut.
    const tokens = all(lines[2], (e) => cls(e) === 'member-tokens')[0];
    assert.equal(text(tokens), '经 orrery 1.2M（7 轮） · 对话 14M');
    assert.deepEqual(tokens.kids.filter((k) => typeof k !== 'string').map((k) => text(k)), ['经 orrery 1.2M（7 轮）', '对话 14M']);
    assert.equal(all(normal, (e) => cls(e) === 'member-length-alert').length, 0, 'no warning for a normal conversation');

    // Near the limit and used up: the words say so, with the window, emphasised (warning / danger tokens in CSS).
    const warn = all(view(quota(93)), (e) => cls(e).includes('member-quota'))[0];
    assert.equal(cls(warn), 'member-detail member-quota quota-warning');
    assert.equal(seen(warn), '额度快用完 93%（5 小时）');
    const out = all(view(quota(100)), (e) => cls(e).includes('member-quota'))[0];
    assert.equal(cls(out), 'member-detail member-quota quota-exhausted');
    assert.equal(seen(out), '额度已用完 100%（5 小时）');
    // An old reading says when; unknowns are words without a meter.
    assert.equal(d(quota(20, at(90))).quota.short, '20%（截至 10:30）');
    const unknown = all(view({ harness: 'claude', supported: false, snapshot: null }), (e) => cls(e).includes('member-quota'))[0];
    assert.equal(seen(unknown), '额度不支持');
    assert.equal(all(unknown, (e) => cls(e) === 'member-meter').length, 0);
    // Before GET /api/usage answers and without tokens: no usage line at all.
    assert.equal((ui.memberDetailsView(d(null, false)) as any).kids.length, 2);

    // A long conversation: the warning sits in this member's details, with the same words as the member page.
    const alertText = ui.usageAlertText({ alert: { turnTokens: null, conversationTokens: 1_085_000_000 } });
    const long = view(quota(41), { tokens: '经 orrery 472M（95 轮） · 对话 77M', alert: alertText });
    const warning = all(long, (e) => cls(e) === 'member-length-alert');
    assert.equal(warning.length, 1);
    assert.equal(text(warning[0]), '对话已很长（单轮 未知 / 合计 1085M），建议在应用里开新对话或压缩。');
    assert.equal((long.kids.at(-1) as El), warning[0], 'last in the row');
  } finally {
    (globalThis as any).document = prev;
  }
});

test('web page: the member list builds each row with its own long-conversation warning, and nothing after the list', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const body = app.slice(app.indexOf('function renderManage()'), app.indexOf('async function removeMember('));
  assert.match(body, /memberDetailsView\(details\.get\(m\.id\), \{ tokens: tokensOf\(m\), alert: alertOf\(m\) \}\)/);
  assert.match(body, /const alertOf = \(m\) => usageAlertText\(usage\?\.members\.find\(\(r\) => r\.memberId === m\.id\)\);/, 'the same source as the member page');
  assert.doesNotMatch(body, /banner warn member-length-alert/, 'no separate box between or after rows');
});

test('web ui member list: each row action is an icon with a tooltip and a name saying whose row; the set per member is unchanged', () => {
  const names = (m: Record<string, unknown>) => ui.memberRowActions({ name: 'Ann', ...m }).map((a: any) => `${a.key}:${a.icon}:${a.label}:${a.name}${a.danger ? ':danger' : ''}`);
  // All four; the conversation can be changed.
  assert.deepEqual(names({}), ['edit:pencil:改名/头像:改名/头像：Ann', 'rebind:swap:换对话:换对话：Ann',
    'hide:eye-off:设为隐身:设为隐身：Ann', 'remove:user-minus:移出集群:移出集群：Ann:danger']);
  // Hidden: the same actions, the hide button now shows it back with its own icon and words.
  assert.equal(names({ hiddenAt: '2026-11-15T00:00:00Z' })[2], 'hide:eye:取消隐身:取消隐身：Ann');
  // Only removal is marked dangerous (red, its own icon, set apart; it still asks first).
  assert.deepEqual(ui.memberRowActions({ name: 'x' }).filter((a: any) => a.danger).map((a: any) => a.key), ['remove']);
  // The app icon's words: the app.
  assert.equal(ui.memberAppText('Claude'), 'Claude');
  // Every icon the list draws is in the page's sprite.
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  for (const id of ['pencil', 'swap', 'eye', 'eye-off', 'user-minus', 'chip', 'project', 'comment']) assert.match(html, new RegExp(`<symbol id="i-${id}" viewBox="0 0 24 24">`), id);
  // The tooltip shows on hover and on keyboard focus; touch gets 44 px targets.
  const css = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.member-action:hover::after, \.member-action:focus-visible::after \{ opacity: 1; \}/);
  assert.match(css, /@media \(max-width: 900px\), \(pointer: coarse\) \{[^}]*\n  button\.icon-button\.member-action \{ width: 44px; height: 44px; \}/);
});

test('web ui member list: after a member moves to another conversation, info read for the old one is never shown as current', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const opts = { usageLoaded: true, now, fmt: (iso: string) => iso.slice(11, 16) };
  const onA = { id: 'm1', name: 'a', harness: 'claude', model: 'model-a', effort: null, cwd: 'D:\\work\\alpha', workerSessionId: 'sA' };
  const onB = { ...onA, model: 'model-b', cwd: 'D:\\work\\beta', workerSessionId: 'sB' };   // the member event after the move
  const reportA = { memberId: 'm1', session: { sessionId: 'sA', title: 'Old conversation', model: 'model-a', observedAt: new Date(now).toISOString() } };
  const reportB = { memberId: 'm1', session: { sessionId: 'sB', title: 'New conversation', model: 'model-b', observedAt: new Date(now).toISOString() } };
  // The match rule.
  assert.equal(ui.currentSession(onA, reportA), reportA.session);
  assert.equal(ui.currentSession(onB, reportA), null, 'read for the old binding');
  assert.equal(ui.currentSession(onB, { session: { ...reportB.session, sessionId: undefined } }), null, 'no binding: not used');
  // Scenario 1: moved A → B, the page still holds A's report: the row (and the member page, same function) drops A's title
  // and model at once; only the model stored by the move is shown, labelled as such.
  const stale = ui.memberDetails(onB, reportA, null, opts);
  assert.deepEqual([stale.model.text, stale.project.text, stale.conversation.text], ['model-b（加入时）', 'beta', '对话标题未知']);
  assert.equal(ui.memberDetails(onB, reportB, null, opts).conversation.text, 'New conversation');
  // Scenario 2: moved back to A while B's report was in flight; B's late answer is not A's.
  const late = ui.memberDetails(onA, reportB, null, opts);
  assert.deepEqual([late.model.text, late.project.text, late.conversation.text], ['model-a（加入时）', 'alpha', '对话标题未知']);
});

test('web page: a rebind refetches the usage report and only the newest report request may apply', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(p\.rebind\) \{[^}]*S\.rebinds\.set\([^\n]*\n[^\n]*\n\s*if \(p\.member\.clusterId === S\.sel\.cluster\) loadUsageSoon\(0\);/);
  assert.match(app, /const mine = \+\+usageRequest;[\s\S]{0,200}if \(S\.sel\.cluster !== cid \|\| mine !== usageRequest\) return;/);
  // The member list and the member page both go through memberDetails, which applies currentSession.
  assert.equal((app.match(/memberDetails\(m, /g) ?? []).length, 2);
});

test('web ui: after a Hub restart the page reloads itself only when nothing would be lost', () => {
  const hub = (pid: number) => ({ app: 'orrery', pid, state: 'running' });
  const clean = { drafts: ['', '  \n'], uploads: 0, editing: false };
  // Same Hub, nothing known yet, or not an orrery answer: nothing to do.
  assert.equal(ui.hubRestartAction(100, hub(100), clean), 'none');
  assert.equal(ui.hubRestartAction(null, hub(200), clean), 'none');
  assert.equal(ui.hubRestartAction(100, null, clean), 'none');
  assert.equal(ui.hubRestartAction(100, { app: 'other', pid: 200 }, clean), 'none');
  assert.equal(ui.hubRestartAction(100, { app: 'orrery' }, clean), 'none');
  // Another Hub process: reload when only blank drafts would go, else the banner.
  assert.equal(ui.hubRestartAction(100, hub(200), clean), 'reload');
  assert.equal(ui.hubRestartAction(100, hub(200)), 'reload');
  assert.equal(ui.hubRestartAction(100, hub(200), { ...clean, drafts: ['', 'half a message'] }), 'banner');
  assert.equal(ui.hubRestartAction(100, hub(200), { ...clean, uploads: 1 }), 'banner');
  assert.equal(ui.hubRestartAction(100, hub(200), { ...clean, editing: true }), 'banner');
  assert.equal(ui.reloadWouldLose(clean), false);
  assert.equal(ui.reloadWouldLose({ drafts: ['x'] }), true);
});

test('web reload: a limit edit kept in the closed settings form counts as unsaved (review reload r1, P1)', () => {
  const settings = { maxHops: { kind: 'finite', value: 6 }, source: 'default', maxTurnsPerChain: { kind: 'unlimited' }, maxTurnsPerChainSource: 'saved' };
  const edited = (setting: string, form: { unlimited: boolean; value: string }) => ui.limitFormEdited(setting, settings, form);
  // The review's case: 6 saved, 12 typed and the dialog closed without saving.
  assert.equal(edited('maxHops', { unlimited: false, value: '12' }), true);
  assert.equal(edited('maxHops', { unlimited: false, value: '6' }), false);
  assert.equal(edited('maxHops', { unlimited: false, value: ' 6 ' }), false, 'what the Hub would read back');
  assert.equal(edited('maxHops', { unlimited: true, value: '6' }), true);
  assert.equal(edited('maxHops', { unlimited: false, value: '' }), true);
  assert.equal(edited('maxTurnsPerChain', { unlimited: true, value: '' }), false);
  assert.equal(edited('maxTurnsPerChain', { unlimited: true, value: '30' }), false, 'the value box is disabled while unlimited is ticked');
  assert.equal(edited('maxTurnsPerChain', { unlimited: false, value: '30' }), true);
  assert.equal(ui.limitFormEdited('maxHops', null, { unlimited: false, value: '12' }), false, 'nothing to compare before the settings load');
  const withNotify = { ...settings, stalledMemberMinutes: 30 };
  assert.equal(ui.notifyFormEdited('stalledMemberMinutes', withNotify, '45'), true);
  assert.equal(ui.notifyFormEdited('stalledMemberMinutes', withNotify, ' 30 '), false);
  assert.equal(ui.notifyFormEdited('stalledMemberMinutes', null, '45'), false, 'nothing to compare before the settings load');

  // The caller: unsaved() asks this of every limit and notification form, from the inputs themselves.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function unsaved('), app.indexOf('\n}\n', app.indexOf('function unsaved(')));
  assert.match(fn, /LIMIT_FORMS\.some\(\(f\) => limitFormEdited\(f\.setting, S\.settings, \{ unlimited: \$\(`\$\{f\.id\}-unlimited`\)\.checked, value: \$\(`\$\{f\.id\}-value`\)\.value \}\)\)/);
  assert.match(fn, /NOTIFY_FORMS\.some\(\(f\) => notifyFormEdited\(f\.setting, S\.settings, \$\(\`\$\{f\.id\}-value\`\)\.value\)\)/);
});

test('web ui: related task chips collapse into one row and keep the expanded state across re-renders', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('const openTaskLinks = new Set();');
  const end = app.indexOf('\n\nfunction receiptsEl(', start);
  assert.ok(start >= 0 && end > start, 'the related-task component is extractable');
  type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, (event?: any) => void>;
    setAttribute(k: string, v: string): void; addEventListener(k: string, f: (event?: any) => void): void; append(...c: (El | string)[]): void };
  const previous = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string): El => ({
      tag, attrs: {}, kids: [], on: {},
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      addEventListener(k: string, f: (event?: any) => void) { this.on[k] = f; },
      append(...c: (El | string)[]) { this.kids.push(...c); },
    }),
    createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),   // sprite icons
  };
  const text = (e: El | string): string => (typeof e === 'string' ? e : e.kids.map(text).join('|'));
  const findAll = (e: El | string, pred: (x: El) => boolean): El[] => typeof e === 'string' ? [] : [...(pred(e) ? [e] : []), ...e.kids.flatMap((kid) => findAll(kid, pred))];
  const find = (e: El | string, pred: (x: El) => boolean): El | null => findAll(e, pred)[0] ?? null;
  const opened: string[][] = [];
  const context: any = {
    S: { messages: new Map() },
    h: ui.h, pluginSlots: { message: [bookmarks.register({ nameOf: () => '用户' }).message] },
    workbench: { openTask: (clusterId: string, id: string) => opened.push([clusterId, id]),
      lookup: (clusterId: string, kind: string, id: string) => clusterId === 'c1' && kind === 'task' && id === 't1aaaaaa' ? '已加载任务' : null,
      linkMessage: () => {} },
  };
  try {
    runInNewContext(`${app.slice(start, end)}\nglobalThis.collab = { messageCollaboration, openTaskLinks };`, context);
    const message = { id: 'm1', clusterId: 'c1', taskIds: ['t1aaaaaa', 't2bbbbbb', 't3cccccc'], bookmarks: [] };
    context.S.messages.set(message.id, message);
    const first = context.collab.messageCollaboration(message);
    const fold = find(first, (e) => e.attrs.class === 'message-task-links')!;
    assert.ok(fold, 'a collapsible row exists');
    assert.equal(text(find(fold, (e) => e.tag === 'summary')!), '关联任务 3');
    assert.equal(fold.attrs.open, undefined, 'collapsed by default');
    assert.equal(findAll(fold, (e) => e.tag === 'button').length, 3, 'all related tasks live inside the fold');
    assert.equal(text(findAll(fold, (e) => e.tag === 'button')[0]), '已加载任务');
    assert.equal(text(findAll(fold, (e) => e.tag === 'button')[1]), '任务 t2bbbbbb');
    const linkEntry = findAll(first, (e) => e.tag === 'button').filter((e) => text(e) === '关联任务');
    assert.equal(linkEntry.length, 1, 'the link/unlink entry stays available');
    assert.equal(findAll(fold, (e) => e.tag === 'button').includes(linkEntry[0]), false, 'it stays outside the fold');
    findAll(fold, (e) => e.tag === 'button')[0].on.click!();
    assert.deepEqual(opened, [['c1', 't1aaaaaa']]);
    fold.on.toggle!({ target: { open: true } });
    assert.ok(context.collab.openTaskLinks.has('m1'), 'the open row is remembered');
    const second = context.collab.messageCollaboration(message);
    assert.equal(find(second, (e) => e.attrs.class === 'message-task-links')!.attrs.open, '', 'a re-render keeps it expanded');
    find(second, (e) => e.attrs.class === 'message-task-links')!.on.toggle!({ target: { open: false } });
    assert.equal(context.collab.openTaskLinks.has('m1'), false, 'collapsing forgets it');
    const plain = context.collab.messageCollaboration({ id: 'm2', clusterId: 'c1', taskIds: [], bookmarks: [] });
    assert.equal(find(plain, (e) => e.attrs.class === 'message-task-links'), null, 'no empty fold without related tasks');
    assert.equal(findAll(plain, (e) => e.tag === 'button').filter((e) => text(e) === '关联任务').length, 1);
    const other = context.collab.messageCollaboration({ id: 'm3', clusterId: 'other', taskIds: ['t1aaaaaa'], bookmarks: [] });
    const otherFold = find(other, (e) => e.attrs.class === 'message-task-links')!;
    assert.equal(text(findAll(otherFold, (e) => e.tag === 'button')[0]), '任务 t1aaaaaa', 'another cluster never borrows the title');
    context.collab.openTaskLinks.add('m1');
    context.collab.messageCollaboration({ id: 'm1', clusterId: 'c1', taskIds: [], bookmarks: [] });
    assert.equal(context.collab.openTaskLinks.has('m1'), false, 'no tasks: the remembered state is dropped');
    context.S.messages.delete(message.id);
    fold.on.toggle!({ target: { open: true } });
    assert.equal(context.collab.openTaskLinks.has('m1'), false, 'an evicted row cannot restore its cached state');
    assert.ok(find(plain, (e) => e.attrs.class === 'message-stars'), 'the registered module renders the bookmark entry');
    context.pluginSlots.message = [];
    const hidden = context.collab.messageCollaboration({ id: 'm4', clusterId: 'c1', taskIds: [] });
    assert.equal(find(hidden, (e) => e.attrs.class === 'message-stars'), null, 'the bookmarks plugin is off: no bookmark entry');
    assert.equal(findAll(hidden, (e) => e.tag === 'button').filter((e) => text(e) === '关联任务').length, 1, 'the task entry stays');
    context.workbench.tasksEnabled = () => false;
    const noTasks = context.collab.messageCollaboration({ id: 'm5', clusterId: 'c1', taskIds: ['t1aaaaaa'] });
    assert.equal(findAll(noTasks, (e) => e.tag === 'button').filter((e) => text(e) === '关联任务').length, 0, 'the tasks plugin is off: no task entry');
    assert.equal(find(noTasks, (e) => e.attrs.class === 'message-task-links'), null);
  } finally {
    (globalThis as any).document = previous;
  }
});

test('web ui: task notice details load lazily and only use an event belonging to the linked task', async () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('const messageDiffViews = new Map();');
  const end = app.indexOf('\n\nfunction messageCollaboration(', start);
  assert.ok(start >= 0 && end > start);
  const helpers = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'task-diff.js')).href);
  const calls: string[] = [];
  let options: any;
  let response = { taskId: 'right', eventId: 42, action: 'task.edit', changes: [] };
  const context: any = {
    isTaskChangeNotice: helpers.isTaskChangeNotice, shipFailureNotice: helpers.shipFailureNotice,
    createTaskDiffView: (value: any) => { options = value; return { view: true }; },
    createShipFailureView: (value: any) => { options = value; return { failure: true }; },
    workbench: { lookup: (clusterId: string, kind: string, id: string) => clusterId === 'c1' && kind === 'task' ? `任务 ${id}` : null },
    api: async (_method: string, path: string) => {
      calls.push(path);
      if (path.includes('/wrong/')) throw new Error('wrong task');
      return response;
    },
  };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.diff = { messageTaskDiff };`, context);
  const message = { id: 'm', clusterId: 'c1', from: 'system', kind: 'system', collabEventId: 42,
    body: '任务【标题】已更新：改了 范围，事件 42。', taskIds: ['wrong', 'right'] };
  const view = context.diff.messageTaskDiff(message, null);
  assert.ok(view);
  assert.deepEqual(calls, [], 'constructing a closed view does not fetch');
  assert.equal(context.diff.messageTaskDiff(message, null), view, 'redraw reuses the view');
  const event = await options.load();
  assert.equal(event.taskId, 'right');
  assert.deepEqual(calls, ['/api/clusters/c1/tasks/wrong/events/42', '/api/clusters/c1/tasks/right/events/42']);
  assert.equal(options.resolve('task', 'right'), '任务 right');
  assert.equal(context.diff.messageTaskDiff({ ...message, id: 'user', from: 'user' }, null), null);
  assert.equal(context.diff.messageTaskDiff({ ...message, id: 'unlinked', collabEventId: undefined }, null), null);
  assert.equal(context.diff.messageTaskDiff({ ...message, id: 'unrelated', body: '协调设置已更新，事件 42。' }, null), null);

  const failure = { ...message, id: 'failure', taskIds: ['right'], body: '任务【标题】合并失败：合并前检查未通过，已退回执行者，事件 42。' };
  assert.equal(context.diff.messageTaskDiff(failure, null).failure, true);
  assert.equal(calls.length, 2, 'failure details also stay unloaded while closed');
  await assert.rejects(options.load(), /task event unavailable/, 'a different action cannot supply diagnostics');
  response = { ...response, action: 'task.ship_failed', eventId: 43 };
  await assert.rejects(options.load(), /task event unavailable/, 'a different event cannot supply diagnostics');
  response = { ...response, eventId: 42, taskId: 'wrong' };
  await assert.rejects(options.load(), /task event unavailable/, 'a different task cannot supply diagnostics');
  response = { ...response, taskId: 'right' };
  assert.equal((await options.load()).action, 'task.ship_failed');
  assert.equal(calls.at(-1), '/api/clusters/c1/tasks/right/events/42');
  assert.equal(context.diff.messageTaskDiff({ ...failure, id: 'forged', from: 'user' }, null), null);
  assert.equal(context.diff.messageTaskDiff({ ...failure, id: 'wrong-id', collabEventId: 43 }, null), null);

  const old = { ...failure, id: 'old', body: '任务【标题】合并失败，已退回执行者（原因：checks: old\npartial log），事件 42。' };
  assert.equal(helpers.shipFailureNotice(old), '任务【标题】合并失败，已退回执行者，事件 42。');
  assert.equal(context.diff.messageTaskDiff(old, null).failure, true);
  // Since a failed ship keeps the task completed, the Hub's notice says 保留已通过状态 instead of 已退回执行者.
  const kept = { ...failure, id: 'kept', body: '任务 #7【标题】合并失败：合并前检查未通过，保留已通过状态（可原样重跑、ship_fix 或 reopen），事件 42。' };
  assert.equal(helpers.shipFailureNotice(kept), '任务 #7【标题】合并失败：合并前检查未通过，保留已通过状态（可原样重跑、ship_fix 或 reopen），事件 42。');
  assert.equal(context.diff.messageTaskDiff(kept, null).failure, true);
  const numberedFailure = { ...failure, id: 'numbered-failure', body: '任务 #7【标题】合并失败：合并前检查未通过，已退回执行者，事件 42。' };
  assert.equal(context.diff.messageTaskDiff(numberedFailure, null).failure, true);
  const numberedEdit = { ...message, id: 'numbered-edit', body: '任务 #7【标题】已更新：改了 范围，事件 42。' };
  assert.ok(context.diff.messageTaskDiff(numberedEdit, null));
});

test('member health shows the connection basis, observation time and newest delivery problem', () => {
  const report = { members: [
    { memberId: 'on', connection: { state: 'online', basis: 'Hub 检查桥或等待通道是否连接', observedAt: '2026-11-09T10:20:00.000Z' }, lastProblem: null },
    { memberId: 'off', connection: { state: 'offline', basis: 'Hub 没有这个 harness 的适配器', observedAt: '2026-11-09T10:21:00.000Z' },
      lastProblem: { state: 'offline', error: '成员离线，未投递', at: '2026-11-09T10:19:00.000Z', messageId: 'm1' } },
    { memberId: 'old-time', connection: { state: 'offline', basis: 'Hub 检查桥或等待通道是否连接', observedAt: '2026-11-09T10:22:00.000Z' },
      lastProblem: { state: 'failed', error: 'boom', at: null, messageId: 'm2' } },
  ] };
  const on = ui.memberHealth(report, { id: 'on' });
  assert.equal(on.connection.state, 'online');
  assert.equal(on.connection.label, '在线');
  assert.match(on.connection.basis, /桥或等待通道/);
  assert.ok(on.connection.observed, 'the observation time is shown');
  assert.deepEqual(on.problem, { known: true, text: null }, 'a report with a null lastProblem says there is no record');
  const off = ui.memberHealth(report, { id: 'off' });
  assert.equal(off.connection.state, 'offline');
  assert.equal(off.connection.label, '离线');
  assert.match(off.problem.text, /离线未投递/);
  assert.match(off.problem.text, /成员离线/);
  assert.match(ui.memberHealth(report, { id: 'old-time' }).problem.text, /^时间未知 · 投递失败：boom/);
  assert.equal(ui.memberHealth(report, { id: 'gone', removedAt: '2026-11-09' }).connection.basis, '已移出集群');
  // A missing or failed report is unknown, never "no failure record".
  const noReport = ui.memberHealth(null, { id: 'on' });
  assert.equal(noReport.connection.state, 'unknown');
  assert.match(noReport.connection.basis, /读取失败/);
  assert.deepEqual(noReport.problem, { known: false, text: '工具版本报告读取失败' });
  const absent = ui.memberHealth(report, { id: 'absent' });
  assert.equal(absent.connection.state, 'unknown');
  assert.match(absent.connection.basis, /没有这个成员的连接信息/);
  assert.deepEqual(absent.problem, { known: false, text: '报告里没有这个成员的投递记录' });
  const oldReport = ui.memberHealth({ members: [{ memberId: 'm' }] }, { id: 'm' });
  assert.deepEqual(oldReport.problem, { known: false, text: '报告缺少投递记录字段' }, 'an older report without lastProblem is unknown');
  assert.deepEqual(ui.memberHealth({ members: [{ memberId: 'm', lastProblem: { state: 'queued' } }] }, { id: 'm' }).problem,
    { known: false, text: '投递记录格式不可识别' });
});

test('web ui: the handover package text carries the records and says 未知 for what the Hub does not keep', () => {
  const pkg = {
    member: { id: 'm1', name: '小A', harness: 'codex', model: 'gpt-5', cwd: 'C:/work/app', sessionId: 's-1' },
    cluster: { id: 'c', name: 'demo' },
    generatedAt: '2026-11-09T12:00:00Z',
    requests: [{ at: '2026-11-09T11:00:00Z', body: '月底前完成认证重构' }],
    tasksOmitted: 1,
    tasks: [{
      id: 't1', title: '认证重构', status: 'completed', proposalState: 'active', role: 'former',
      updatedAt: '2026-11-09T11:30:00Z', branch: null,
      commitSha: 'abc1234', mergedCommitSha: 'def5678', summary: '改了 2 个文件，测试通过', commands: null, submissionBy: '小B',
      review: { verdict: 'approve', self: false, reviewer: '小B', at: '2026-11-09T11:40:00Z', reason: '接口按约定实现' },
      questions: ['分支名要不要改？'],
    }, {
      id: 't2', title: '补文档', status: 'pending', proposalState: 'proposed', role: 'executor',
      updatedAt: '2026-11-09T11:45:00Z', branch: null,
      commitSha: null, mergedCommitSha: null, summary: null, commands: null, submissionBy: null, review: null, questions: [],
    }],
    deliveries: [{ at: '2026-11-09T11:50:00Z', state: 'failed', outcome: 'unknown', error: 'turn failed', message: '再试一次' }],
  };
  const text = ui.handoverText(pkg);
  assert.match(text, /^交接包 · 小A（codex · gpt-5）· 集群 demo/);
  assert.match(text, /内容只来自 Hub 记录/);
  assert.match(text, /工作目录：C:\/work\/app/);
  assert.match(text, /## 一、集群目标（用户最近的要求）/);
  assert.match(text, /月底前完成认证重构/);
  assert.match(text, /### 认证重构（已完成）/);
  assert.match(text, /任务 ID：t1/);
  assert.match(text, /分支：未知（Hub 没有记录分支/);
  assert.match(text, /提交：abc1234（执行者的提交，小B）/, 'another member\'s submission is labelled, not hidden');
  assert.match(text, /合并提交：def5678/);
  assert.match(text, /提交说明（执行者的提交，小B）：改了 2 个文件/);
  assert.match(text, /最近验收意见：通过 · 小B/);
  assert.match(text, /接口按约定实现/);
  assert.match(text, /实际跑过的命令：未知（Hub 的任务记录没有命令字段）/);
  assert.match(text, /未解决的问题：\n {2}- 分支名要不要改？/);
  assert.match(text, /这个成员的角色：曾经负责/);
  assert.match(text, /### 补文档（待批准）/);
  assert.match(text, /这个成员的角色：执行者/);
  assert.match(text, /另有 1 个任务未显示/);
  // The date is shown, but the hour depends on the machine's time zone: assert the shape, not one zone's value.
  assert.match(text, /生成时间：\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}/);
  assert.match(text, /提交：未知/);
  assert.match(text, /最近验收意见：未知（这个任务还没有验收记录）/);
  assert.match(text, /未解决的问题：无/);
  assert.match(text, /## 三、最近的投递失败/);
  assert.match(text, /结果未知 · turn failed · 消息「再试一次」/);
  assert.doesNotMatch(text, /undefined|null|NaN/);

  // A member with no records: each section says 未知 with why, never a filled-in value.
  const empty = ui.handoverText({
    member: { id: 'm2', name: 'B', harness: 'mock', model: null, cwd: '', sessionId: '' },
    cluster: { id: 'c', name: 'empty' }, generatedAt: '2026-11-09T12:00:00Z', tasksOmitted: 0,
    requests: [], tasks: [], deliveries: [],
  });
  assert.match(empty, /工作目录：未知/);
  assert.match(empty, /对话 ID：未知/);
  assert.match(empty, /- 未知（Hub 里没有这个群用户的发言记录）/);
  assert.match(empty, /- 未知（Hub 的任务记录里没有这个成员的任务）/);
  assert.match(empty, /- 未知（没有失败或离线的投递记录）/);
  assert.doesNotMatch(empty, /undefined|null|NaN/);
  assert.equal(ui.handoverText(null), '');
});

test('web ui: fyi notice, splitReceiptMembers (投递对象 vs 读过的人) and twin removed suffix', () => {
  const nameOf = (id: string) => ({ a: 'A', b: 'B', c: 'C' }[id] ?? id);
  const legacy = { id: 'm0', fyi: undefined, mentions: ['b'] };
  assert.equal(ui.recordOnlyNotice(legacy, [], [], [], nameOf), '没有投递对象，只留在群聊记录里');
  assert.equal(ui.recordOnlyNotice(legacy, [{ memberId: 'b', state: 'done' }], [], [], nameOf), null);

  const fyiMsg = { id: 'm1', fyi: true, mentions: ['b'] };
  assert.equal(ui.recordOnlyNotice(fyiMsg, [], [], [], nameOf), '仅知会：B未读，不唤醒');
  assert.equal(ui.recordOnlyNotice(fyiMsg, [], [{ memberId: 'b', via: 'read_messages' }], [], nameOf), '仅知会：B已读，不唤醒');

  const mixed = { id: 'm2', fyi: true, mentions: ['a', 'b'] };
  assert.equal(ui.recordOnlyNotice(mixed, [{ memberId: 'a', state: 'queued' }], [], [], nameOf), '仅知会：B未读，不唤醒');
  assert.equal(ui.recordOnlyNotice({ id: 'm3', fyi: true, mentions: [] }, [], [], [], nameOf), '仅知会，不唤醒');

  const split = ui.splitReceiptMembers(
    mixed,
    [{ memberId: 'a', state: 'done', outcome: 'completed' }],
    [{ memberId: 'b', via: 'read_messages', at: '2026-11-13T00:00:00Z' }, { memberId: 'c', via: 'read_messages', at: '2026-11-13T00:00:01Z' }],
    [{ memberId: 'c', at: '2026-11-13T00:00:02Z' }],
  );
  assert.deepEqual(split.recipients.map((r: any) => [r.memberId, Boolean(r.delivery), r.fyiOnly]), [['a', true, false], ['b', false, true]]);
  assert.deepEqual(split.readOnly.map((r: any) => [r.memberId, Boolean(r.delivery)]), [['c', false]]);

  // Non-fyi message read by a third party via history: reader stays in readOnly, never recipients.
  const splitLegacy = ui.splitReceiptMembers(
    legacy,
    [],
    [{ memberId: 'c', via: 'read_messages', at: '2026-11-13T00:00:01Z' }],
    [],
  );
  assert.equal(splitLegacy.recipients.length, 0);
  assert.deepEqual(splitLegacy.readOnly.map((r: any) => r.memberId), ['c']);

  // Removed member gets （已移出） only when an active member in the same cluster shares the name.
  const members = new Map([
    ['old-codex', { id: 'old-codex', clusterId: 'c1', name: 'codex', removedAt: '2026-11-13T00:00:00Z' }],
    ['new-codex', { id: 'new-codex', clusterId: 'c1', name: 'codex', removedAt: null }],
    ['old-ghost', { id: 'old-ghost', clusterId: 'c1', name: 'ghost', removedAt: '2026-11-13T00:00:00Z' }],
    ['other-claude', { id: 'other-claude', clusterId: 'c2', name: 'ghost', removedAt: null }],
  ]);
  assert.equal(ui.messageAuthorName({ from: 'old-codex' }, members), 'codex（已移出）');
  assert.equal(ui.messageAuthorName({ from: 'new-codex' }, members), 'codex');
  assert.equal(ui.messageAuthorName({ from: 'old-ghost' }, members), 'ghost');
});

test('web ui: hidden members are marked, counted apart from online, listed with their tasks before hiding, and noted in the composer', async () => {
  const wb = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench.js')).href);
  const cm = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/conversation-matrix.js')).href);
  const stalled = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/stalled.js')).href);
  assert.equal(ui.HIDDEN_MARK, '隐身中', 'words, not colour alone');
  assert.match(readFileSync(join(REPO_ROOT, 'src/web/public/ui.js'), 'utf8'), /export const hiddenMark = \(text = t\(HIDDEN_MARK\), cls = 'hidden-mark'\) => h\('span', \{ class: cls \}, icon\('eye-off', 'ico-xs'\), text\);/, 'and an icon (the crossed-out eye) wherever it is a chip');
  const members = [
    { id: 'a', clusterId: 'c', name: 'Alice', harness: 'mock', workerSessionId: 'sa', removedAt: null, hiddenAt: null },
    { id: 'h', clusterId: 'c', name: 'Hidey', harness: 'mock', workerSessionId: 'sh', removedAt: null, hiddenAt: '2026-11-15T00:00:00.000Z' },
    { id: 'o', clusterId: 'c', name: 'Off', harness: 'mock', workerSessionId: 'so', removedAt: null, hiddenAt: null },
  ];
  const statusOf = (m: { id: string }) => (m.id === 'o' ? 'offline' : 'idle');
  assert.deepEqual(ui.memberCounts(members, statusOf), { total: 3, online: 1, hidden: 1 }, 'a hidden member is not online');
  assert.equal(ui.memberSummary(3, 1, 1), '3 个群员 · 1 在线 · 1 隐身');
  assert.equal(ui.memberSummary(3, 2, 0), '3 个群员 · 2 在线');

  const task = (id: string, status: string, assignedMemberId: string | null, reviewer: object = { kind: 'user' }) =>
    ({ id, number: Number(id.slice(1)), title: `T${id}`, status, proposalState: 'active', assignedMemberId, reviewer });
  const tasks = [task('t1', 'working', 'h'), task('t2', 'review', 'a', { kind: 'member', memberId: 'h' }), task('t3', 'completed', 'h'), task('t4', 'pending', 'a')];
  const held = ui.heldTasks(tasks, 'h');
  assert.deepEqual([held.executing.map((t: { id: string }) => t.id), held.reviewing.map((t: { id: string }) => t.id)], [['t1'], ['t2']]);
  const text = ui.hiddenConfirmText(members[1], held, true);
  assert.match(text, /把 Hidey 设为隐身？/);
  assert.match(text, /执行：\n- #1 Tt1/);
  assert.match(text, /验收：\n- #2 Tt2/);
  assert.match(ui.hiddenConfirmText(members[1], { executing: [], reviewing: [] }, true), /没有未完成的任务/);
  assert.match(ui.hiddenConfirmText(members[1], held, false), /取消 Hidey 的隐身/);

  assert.equal(ui.hiddenMentionHint('@Hidey please look', members), '@Hidey 隐身中，不会收到（消息照常发出，留在群聊记录里）。');
  assert.equal(ui.hiddenMentionHint('@Alice please', members), '');
  assert.equal(ui.hiddenMentionHint('@Hideyou is someone else', members), '', 'full names only, the Hub rule');
  assert.equal(ui.hiddenMentionHint('mail@Hidey', members), '');

  const memberOf = (id: string) => members.find((m) => m.id === id) ?? null;
  assert.deepEqual(wb.taskHiddenMarks(tasks[0], memberOf), ['执行者隐身中']);
  assert.deepEqual(wb.taskHiddenMarks(tasks[1], memberOf), ['验收人隐身中']);
  assert.deepEqual(wb.taskHiddenMarks(tasks[2], memberOf), [], 'a closed task waits on nobody');

  const model = cm.conversationMatrix({ members, clusters: [{ id: 'c', name: 'C', createdAt: '2026-01-01T00:00:00.000Z' }], statusOf });
  assert.deepEqual([model.columns[0].onlineCount, model.columns[0].hiddenCount], [1, 1]);
  type Cell = { memberId: string; hidden: boolean };
  const cells: Cell[] = model.rowGroups.flatMap((g: { rows: { cells: Record<string, Cell> }[] }) => g.rows.map((r) => r.cells.c));
  assert.equal(cells.find((x) => x.memberId === 'h')?.hidden, true);

  const hint = { memberName: 'Hidey', harness: 'mock', thresholdMinutes: 30, lastActivityAt: null, lastTaskChangeAt: '2026-11-15T00:00:00.000Z',
    tasks: [{ id: 't1', number: 1, title: 'T', status: 'working' }], offline: true, hidden: true };
  assert.match(stalled.stalledLines(hint).at(-1), /隐身中/, 'labelled hidden, not as ordinary silence or offline');
  assert.match(stalled.stalledSummary([hint]), /Hidey（隐身中）/);

  // Work that landed on a hidden member: its own hint kind, words per task, its own dismissal slot and badge words.
  const work = { kind: 'hidden_work', clusterId: 'c', memberId: 'h', memberName: 'Hidey', harness: 'mock', offline: false, hidden: true,
    tasks: [{ id: 't1', number: 12, title: 'T', status: 'working', waiting: 'rejected', role: 'executor' }, { id: 't2', number: 13, title: 'R', status: 'review', waiting: 'review', role: 'reviewer' }],
    lastActivityAt: null, lastActivitySource: null, lastTaskChangeAt: '2026-11-15T00:00:00.000Z', since: '2026-11-15T00:00:00.000Z', thresholdMinutes: 30 };
  assert.match(stalled.stalledLines(work)[0], /Hidey（mock）隐身中，落到它身上的工作没有人会处理/);
  assert.equal(stalled.stalledTaskText(work.tasks[0]), '#12 T（被退回，执行者隐身中，没有人会处理）');
  assert.equal(stalled.stalledTaskText(work.tasks[1]), '#13 R（等验收，验收人隐身中）');
  const silence = { ...hint, kind: 'stalled', memberId: 'h' };
  const dismissedSilence = stalled.withDismissed({}, silence);
  assert.deepEqual(stalled.visibleStalled([work, silence], dismissedSilence), [work], 'dismissing the silence keeps the hidden-work hint');
  const dismissedWork = stalled.withDismissed(dismissedSilence, work);
  assert.deepEqual(stalled.visibleStalled([work, silence], dismissedWork), []);
  const more = { ...work, tasks: [...work.tasks, { id: 't3', number: 14, title: 'S', status: 'pending', waiting: 'ready', role: 'executor' }] };
  assert.deepEqual(stalled.visibleStalled([more], dismissedWork), [more], 'new work brings it back');
  const badge = stalled.stalledBadge([work, silence]);
  assert.equal(badge.text, '1 人隐身有活 · 1 人无活动');
  assert.match(badge.title, /1 位隐身成员手上有工作，没有人会处理/);
  assert.equal(stalled.stalledBadge([work], true).text, '隐身有活');
  // Held tasks on a later page are listed too: the page asks only for what the member holds and follows the cursor.
  assert.equal(ui.heldTasksPath('c 1', 'h'), '/api/clusters/c%201/workspace?holder=h&limit=100');
  assert.equal(ui.heldTasksPath('c', 'h', 'next'), '/api/clusters/c/workspace?holder=h&limit=100&cursor=next');
  const pages: Record<string, { tasks: unknown[]; nextCursor: string | null }> = {
    start: { tasks: [tasks[1]], nextCursor: 'p2' }, p2: { tasks: [task('t102', 'working', 'h')], nextCursor: null } };
  const asked: (string | null)[] = [];
  const listed = await ui.allPages(async (cursor: string | null) => { asked.push(cursor); return pages[cursor ?? 'start']; });
  assert.deepEqual(asked, [null, 'p2']);
  const all = ui.heldTasks(listed, 'h');
  assert.deepEqual([all.executing.map((t: { id: string }) => t.id), all.reviewing.map((t: { id: string }) => t.id)], [['t102'], ['t2']]);
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(app.includes("tasks = await allPages((cursor) => api('GET', heldTasksPath(m.clusterId, memberId, cursor)));"), 'every page of the held tasks');
  assert.ok(app.includes("api('POST', `/api/members/${encodeURIComponent(memberId)}/hidden`, { hidden: hide })"), 'the user route');
  assert.ok(app.includes("confirmDialog({ title: hide ? lt('设为隐身') : lt('取消隐身'), message: text"), 'confirmed first');
});

test('web ui: old acknowledgement receipts stay out of the chat; other messages are shown', () => {
  const system = (systemKind?: string) => ({ id: 'x', from: 'system', kind: 'system', body: '确认回执：A 确认看到了你发的 1 条消息', ...(systemKind ? { systemKind } : {}) });
  assert.equal(ui.chatShowsMessage(system('receipt')), false, 'an old receipt row is not rendered');
  assert.equal(ui.chatShowsMessage(system('queue_warning')), true);
  assert.equal(ui.chatShowsMessage(system()), true, 'an old system row without a kind is shown, whatever its text');
  assert.equal(ui.chatShowsMessage({ id: 'y', from: 'm1', body: 'hi', systemKind: 'receipt' }), true, 'only system messages are filtered');
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /chatRowState\(S\.messages\.get\(id\), chatFilter, jumpExceptionId/, 'the chat list applies it');
});

test('system kinds: every kind has one category, unknown and missing kinds are 其他, the type lists the same kinds', async () => {
  const kinds = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'system-kinds.js')).href);
  for (const [kind, entry] of Object.entries(kinds.SYSTEM_KINDS) as [string, any][]) {
    assert.ok(kinds.SYSTEM_CATEGORIES.includes(entry.category), `${kind} has a known category`);
    assert.equal(entry.level !== null, entry.category === 'warning', `${kind}: only warnings have a level`);
    assert.deepEqual(kinds.systemClass(kind), entry);
  }
  const expected: Record<string, [string, string | null]> = {
    delivery_failed: ['warning', 'problem'], hidden_work: ['warning', 'problem'], quota_exhausted: ['warning', 'problem'],
    ship_failed: ['warning', 'problem'], queue_warning: ['warning', 'attention'], stalled: ['warning', 'attention'],
    quota_low: ['warning', 'attention'], task_rejected: ['warning', 'attention'], task_attention: ['warning', 'attention'],
    review_downgraded: ['warning', 'attention'], plugin_rate_limit: ['warning', 'attention'],
    plugin_refused: ['warning', 'attention'], plugin_check_failed: ['warning', 'problem'], plugin_restarted: ['warning', 'problem'], task: ['task', null], coordinator: ['coordinator', null], idle: ['coordinator', null],
    quota_recovered: ['coordinator', null], rebind: ['member', null], member_renamed: ['member', null], member_shown: ['member', null], settings: ['member', null],
    plugin_tool_call: ['member', null], mode_removed: ['member', null], receipt: ['other', null],
  };
  assert.deepEqual(Object.fromEntries(Object.entries(kinds.SYSTEM_KINDS).map(([kind, e]: [string, any]) => [kind, [e.category, e.level]])), expected);
  for (const missing of [undefined, null, '', 'not_a_kind', 'toString', '__proto__']) {
    assert.deepEqual(kinds.systemClass(missing), { category: 'other', level: null }, `${String(missing)} is other`);
  }
  assert.deepEqual(kinds.kindsOf('warning').sort(), Object.keys(expected).filter((k) => expected[k][0] === 'warning').sort());
  // The TypeScript type every writer is checked against names exactly the table's kinds (a writer cannot use an unmapped kind).
  const declared = readFileSync(join(REPO_ROOT, 'src', 'core', 'system-kinds.d.ts'), 'utf8');
  const union = /export type SystemKind = ([^;]+);/.exec(declared)![1];
  assert.deepEqual([...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), Object.keys(expected).sort());
});

test('web ui: the page loads the core system-kind table through the one file the server hands out', async () => {
  const { startTestHub, rawFetch } = await import('./helpers.ts');
  const app = await startTestHub();
  try {
    const shared = await rawFetch(`${app.url}/core/system-kinds.js`);
    assert.equal(shared.status, 200);
    assert.match(shared.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await shared.text(), readFileSync(join(REPO_ROOT, 'src', 'core', 'system-kinds.js'), 'utf8'));
    assert.equal((await rawFetch(`${app.url}/core/store.ts`)).status, 404, 'no other core file');
    assert.equal((await rawFetch(`${app.url}/core/system-kinds.d.ts`)).status, 404);
    assert.equal((await rawFetch(`${app.url}/system-kinds.js`)).status, 200, 'the page module that re-exports it');
  } finally { await app.close(); }
});

test('web ui: a jump target shows through the chat filter, marked, until the filter changes or the chat moves on', () => {
  const user = { id: 'u1', from: 'user', body: 'hello', mentions: [] };
  const task = { id: 't1', from: 'system', kind: 'system', systemKind: 'task', body: 'b' };
  const warningsOnly = ui.chatFilterFromStored('{"warningsOnly":true}');
  const hideTasks = ui.chatFilterFromStored('{"hide":["task"]}');
  assert.equal(ui.chatRowState(user, warningsOnly), 'hidden');
  assert.equal(ui.chatRowState(user, warningsOnly, 'u1'), 'jump', 'the jump target is let through and marked');
  assert.equal(ui.chatRowState(user, warningsOnly, 'other'), 'hidden', 'only the target');
  assert.equal(ui.chatRowState(task, hideTasks, 't1'), 'jump', 'a hidden-category system message too');
  assert.equal(ui.chatRowState(user, ui.CHAT_FILTER_DEFAULT, 'u1'), 'shown', 'nothing to mark when the filter shows it anyway');
});

test('web ui: the jump state machine (ui.js nextJump): every transition, stale answers, and what the chat reads from it', () => {
  const open = (token: number, cid = 'c1', id = 'm1', receipts = true) => ui.nextJump(null, { type: 'open', cid, id, receipts, token });
  const j = open(1);
  assert.deepEqual(j, { cid: 'c1', id: 'm1', receipts: true, token: 1, landed: false });
  assert.deepEqual([ui.jumpExceptionId(j, 'c1'), ui.jumpExceptionId(j, 'c2'), ui.jumpPending(j, 'c1'), ui.jumpPending(j, 'c2')], ['m1', null, true, false]);
  // Every event, for the current jump and for a stale token.
  assert.equal(ui.nextJump(j, { type: 'answer', token: 1, found: true }), j, 'found: still heading for it');
  assert.equal(ui.nextJump(j, { type: 'answer', token: 1, found: false }), null, 'not found: ended');
  assert.equal(ui.nextJump(j, { type: 'answer', token: 0, found: false }), j, 'a stale answer changes nothing');
  assert.equal(ui.nextJump(j, { type: 'failed', token: 1 }), null);
  assert.equal(ui.nextJump(j, { type: 'failed', token: 0 }), j);
  const landed = ui.nextJump(j, { type: 'landed', token: 1 });
  assert.deepEqual([landed.landed, ui.jumpPending(landed, 'c1'), ui.jumpExceptionId(landed, 'c1')], [true, false, 'm1'], 'landed: still let through, no longer pending');
  assert.equal(ui.nextJump(j, { type: 'landed', token: 0 }), j);
  assert.equal(ui.nextJump(j, { type: 'view', cid: 'c1' }), j, 'the same chat keeps it');
  assert.equal(ui.nextJump(j, { type: 'view', cid: 'c2' }), null, 'another cluster ends it');
  assert.equal(ui.nextJump(j, { type: 'view', cid: null }), null, 'the overview ends it');
  assert.equal(ui.nextJump(j, { type: 'filter' }), null, 'a filter change ends it');
  assert.equal(ui.nextJump(landed, { type: 'filter' }), null, 'a landed one too');
  assert.equal(ui.nextJump(j, { type: 'latest', cid: 'c1' }), null, '回到最新 or a forgotten window in its cluster ends it');
  assert.equal(ui.nextJump(j, { type: 'latest', cid: 'c2' }), j, 'another cluster’s window does not');
  assert.equal(ui.nextJump(j, { type: 'unknown' }), j);
  for (const event of [{ type: 'answer', token: 1, found: true }, { type: 'failed', token: 1 }, { type: 'landed', token: 1 }, { type: 'view', cid: 'c1' },
    { type: 'filter' }, { type: 'latest', cid: 'c1' }]) assert.equal(ui.nextJump(null, event), null, `${event.type} never starts a jump`);
  // A second jump: only its answer counts, the first one's answer is stale.
  const second = ui.nextJump(j, { type: 'open', cid: 'c1', id: 'm2', receipts: false, token: 2 });
  assert.equal(ui.jumpCurrent(second, 1), false);
  assert.equal(ui.nextJump(second, { type: 'answer', token: 1, found: false }), second);
  assert.equal(ui.nextJump(second, { type: 'landed', token: 1 }), second);
  assert.deepEqual(ui.nextJump(second, { type: 'landed', token: 2 }).landed, true);
  // Cancelled (filter, cluster switch, 回到最新) then a late answer, a late landing or un-filtering: nothing comes back.
  for (const cancel of [{ type: 'filter' }, { type: 'view', cid: 'c2' }, { type: 'latest', cid: 'c1' }]) {
    let state: any = ui.nextJump(j, cancel);
    for (const late of [{ type: 'answer', token: 1, found: true }, { type: 'landed', token: 1 }, { type: 'filter' }, { type: 'view', cid: 'c1' }]) {
      state = ui.nextJump(state, late);
      assert.equal(state, null, `${cancel.type} then ${late.type}`);
    }
    assert.equal(ui.jumpCurrent(state, 1), false);
    assert.equal(ui.jumpPending(state, 'c1'), false, `after ${cancel.type} a full live window follows the bottom again`);
    assert.equal(ui.jumpExceptionId(state, 'c1'), null);
  }
  // The page reads the jump only through these helpers, and every writer goes through nextJump.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.equal([...app.matchAll(/\bpendingJump\b|\bjumpShown\b/g)].length, 0, 'no second jump variable');
  assert.deepEqual([...app.matchAll(/\bjump = ([^;]+);/g)].map((m) => m[1].startsWith('nextJump(jump, ') || m[1] === 'null'), Array(9).fill(true),
    'the declaration and the eight writes all go through nextJump');
  assert.match(app, /if \(w\.loading === 'older' \|\| jumpPending\(jump, m\.clusterId\)/, 'messageArrived keeps its page only for a pending jump');
  const openSrc = app.slice(app.indexOf('async function openMessage('), app.indexOf('// The bar above the composer'));
  assert.match(openSrc, /if \(!jumpCurrent\(jump, jumpToken\)\) return keep\(\);/, 'a cancelled jump’s answer leaves the window as it was');
  const setFilter = app.slice(app.indexOf('function filterChanged('), app.indexOf('function filterChanged(') + 400);
  assert.match(setFilter, /jump = nextJump\(jump, \{ type: 'filter' \}\);/);
  assert.match(app, /chatRowState\(S\.messages\.get\(id\), chatFilter, jumpExceptionId\(jump, cid\)\) !== 'hidden'/, 'the chat list applies it');
});

test('web ui: the chat filter, its stored form and the warning mark', () => {
  const system = (systemKind?: string) => ({ id: 'x', from: 'system', kind: 'system', body: 'b', ...(systemKind ? { systemKind } : {}) });
  const member = { id: 'm', from: 'm1', body: 'hi' };
  assert.deepEqual(ui.chatFilterFromStored(null), { hide: [], warningsOnly: false, senders: {} });
  assert.deepEqual(ui.chatFilterFromStored('not json'), { hide: [], warningsOnly: false, senders: {} });
  assert.deepEqual(ui.chatFilterFromStored('{"hide":["task","bogus","coordinator"],"warningsOnly":"yes"}'), { hide: ['task', 'coordinator'], warningsOnly: false, senders: {} });
  const hideTasks = ui.chatFilterFromStored('{"hide":["task"]}');
  assert.equal(ui.chatFilterCount(hideTasks), 1);
  assert.equal(ui.chatShowsMessage(system('task'), hideTasks), false, 'task progress hidden');
  assert.equal(ui.chatShowsMessage(system('ship_failed'), hideTasks), true, 'a task failure is a warning, still shown');
  assert.equal(ui.chatShowsMessage(member, hideTasks), true, 'member messages are not system categories');
  const hideOther = ui.chatFilterFromStored('{"hide":["other"]}');
  assert.equal(ui.chatShowsMessage(system(), hideOther), false, 'an old row without a kind is 其他');
  const warningsOnly = ui.chatFilterFromStored('{"warningsOnly":true}');
  assert.equal(ui.chatFilterCount(warningsOnly), 1);
  assert.deepEqual([system('queue_warning'), system('delivery_failed'), system('task'), system(), member].map((m) => ui.chatShowsMessage(m, warningsOnly)),
    [true, true, false, false, false]);
  assert.equal(ui.chatShowsMessage(system('receipt'), ui.CHAT_FILTER_DEFAULT), false, 'old receipts never show');
  assert.deepEqual(ui.systemMark(system('ship_failed')), { level: 'problem', label: '问题' });
  assert.deepEqual(ui.systemMark(system('queue_warning')), { level: 'attention', label: '提醒' });
  assert.equal(ui.systemMark(system('task')), null, 'routine notices keep their look');
  assert.equal(ui.systemMark(system()), null);
  assert.equal(ui.systemMark({ ...member, systemKind: 'ship_failed' }), null, 'only system messages are marked');
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /'aria-label': t\('警告'\)/, 'the icon has an accessible name');
  assert.match(app, /notice-\$\{mark\.level\}/, 'the article carries the level class');
  assert.match(app, /localStorage\.setItem\(CHAT_FILTER_KEY/, 'the filter is kept per browser');
});

test('web ui: opening a member page draws its lines and throws nothing (every name it reads exists)', () => {
  // renderMemberPanel as the page runs it, with the page's state and elements stood in for. Its helpers are stubs; the
  // names it reads from the page's scope are given here, so a name the page never declares throws as in the browser.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const fn = /^function renderMemberPanel\(\) \{[\s\S]*?^\}/m.exec(app)![0];
  const elements = new Map<string, any>();
  const el = (id: string) => {
    if (!elements.has(id)) {
      const e: any = { id, hidden: false, textContent: '', children: [] as unknown[], scrollTop: 0, scrollHeight: 0, clientHeight: 0, firstElementChild: null,
        replaceChildren(...c: unknown[]) { this.children = c; }, append(...c: unknown[]) { this.children.push(...c); }, prepend(...c: unknown[]) { this.children.unshift(...c); } };
      elements.set(id, e);
    }
    return elements.get(id);
  };
  const member = { id: 'm1', clusterId: 'c1', name: 'Ann', harness: 'codex', removedAt: null, hiddenAt: null, origin: 'attached', cwd: 'C:/p', workerSessionId: 's1' };
  const lines = [{ seq: 1, kind: 'a' }, { seq: 2, kind: 'b' }, { seq: 3, kind: 'c' }];
  const log = { events: lines, loading: false, error: false, prepended: 0 };
  const filled: unknown[] = [];
  const context: Record<string, any> = {
    S: { members: new Map([[member.id, member]]), sel: { member: member.id }, harnesses: ['codex'], usage: null, rebinds: new Map(), activity: new Map(),
      activityFailed: false, toolVersions: null, turnUsage: null, identity: 0, turnUsageError: false, memberLogs: new Map([[member.id, log]]) },
    $: el, panelFor: null, panelIdentity: -1, panelCount: 0, hiding: new Set(), HIDDEN_MARK: '隐身中',
    statusOf: () => 'idle', presenceOf: () => null, avatarEl: () => ({}), memberStatusLabel: () => 'idle', offlineHint: () => null, longWaitingHint: () => null,
    memberDetails: () => ({ model: 'm', conversation: 'c' }), h: (tag: string) => ({ tag }), fmtTime: String, emptyState: (text: string) => ({ empty: text }),
    activityEl: () => ({}), activitySummary: () => null, toolVersionView: () => ({}), memberHealth: () => ({}), usageAlertText: () => '', usageView: () => ({}),
    refreshQuota() {}, usageRenderer: { draw() {}, renderTurns() {} }, loadMemberLog: () => log, renderComposer() {},
    panelEditor: { fill: (m: unknown) => filled.push(m) }, direct: { input: { placeholder: '' } }, buildEvent: (e: { seq: number }) => ({ line: e.seq }),
  };
  runInNewContext(`${fn}\nglobalThis.renderMemberPanel = renderMemberPanel;`, context);
  assert.doesNotThrow(() => context.renderMemberPanel());
  assert.deepEqual(el('member-events').children, [{ line: 1 }, { line: 2 }, { line: 3 }], 'the member\'s lines are drawn');
  assert.deepEqual(filled, [member], 'its editor is filled');
  assert.equal(el('member-composer-note').hidden, false, 'every member is a native conversation: the note says how a direct message arrives');
  assert.match(context.direct.input.placeholder, /直接发给这个对话/);
});
