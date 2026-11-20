// The star map's chat windows (docs/starmap.md「聊天窗口」): the pure paging and grouping logic (transcript.js), the
// window stack, the window manager on a small fake DOM (no browser), and a source check that nothing parses HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';
import './plugin-host-hook.ts';

const dir = join(REPO_ROOT, 'src/plugins/starmap/package/web');
const T = await import(pathToFileURL(join(dir, 'transcript.js')).href);
const W = await import(pathToFileURL(join(dir, 'windows.js')).href);

const item = (id: string, kind = 'assistant', extra: object = {}) => ({ id, kind, text: id, ...extra });
const ok = (items: object[], extra: object = {}) => ({ status: 'ok', items, hasMore: false, unknownCount: 0, ...extra });

test('transcript and message paths carry only the route parameters, encoded', () => {
  assert.equal(T.transcriptPath('c 1', 'm/2'), '/api/clusters/c%201/members/m%2F2/transcript?limit=50');
  assert.equal(T.transcriptPath('c', 'm', { direction: 'before', cursor: 'a+b.c' }),
    '/api/clusters/c/members/m/transcript?direction=before&limit=50&cursor=a%2Bb.c');
  assert.equal(T.messagesPath('c'), '/api/clusters/c/messages?limit=50');
  assert.equal(T.messagesPath('c', 'id 1'), '/api/clusters/c/messages?limit=50&before=id%201');
});

test('merging pages: a later record with the same id replaces the earlier one and takes its place', () => {
  const merged = T.mergeItems([item('a'), item('b', 'assistant', { text: 'old' }), item('c')], [item('b', 'assistant', { text: 'new' }), item('d')]);
  assert.deepEqual(merged.map((i: any) => `${i.id}:${i.text}`), ['a:a', 'c:c', 'b:new', 'd:d']);
  // An older page in front: what the window already holds is later, so it wins.
  assert.deepEqual(T.mergeItems([item('x'), item('a', 'assistant', { text: 'older' })], [item('a', 'assistant', { text: 'kept' })])
    .map((i: any) => i.text), ['x', 'kept']);
  assert.equal(T.mergeItems([{ kind: 'user' }], [{ kind: 'user' }]).length, 2, 'items without an id are all kept');
});

test('paging state: latest, older, newer, and the reads they chain', () => {
  let s = T.transcriptState();
  assert.equal(s.status, 'loading');
  assert.equal(T.requestFor(s, 'before'), null);
  assert.deepEqual(T.requestFor(s, 'latest'), {});
  assert.equal(T.wantOnActivity(s), null, 'nothing to follow before the first page');

  let r = T.applyPage(s, 'latest', ok([item('3'), item('4')], { before: 'B1', after: 'A1', unknownCount: 1 }));
  s = r.state;
  assert.equal(r.then, null);
  assert.deepEqual([s.status, s.before, s.after, s.unknownCount, s.items.length], ['ok', 'B1', 'A1', 1, 2]);
  assert.equal(T.hasOlder(s), true);
  assert.deepEqual(T.requestFor(s, 'before'), { direction: 'before', cursor: 'B1' });
  assert.deepEqual(T.requestFor(s, 'after'), { direction: 'after', cursor: 'A1' });
  assert.equal(T.wantOnActivity(s), 'after');

  r = T.applyPage(s, 'before', ok([item('1'), item('2')], { after: 'ignored' }));
  s = r.state;
  assert.deepEqual(s.items.map((i: any) => i.id), ['1', '2', '3', '4']);
  assert.equal(s.before, null, 'the start of the conversation');
  assert.equal(s.after, 'A1', 'an older page keeps the newer cursor');
  assert.equal(T.hasOlder(s), false);

  r = T.applyPage(s, 'after', ok([item('4', 'assistant', { text: 'grown' }), item('5')], { after: 'A2', hasMore: true }));
  s = r.state;
  assert.equal(r.then, 'after', 'more to read in that direction');
  assert.deepEqual(s.items.map((i: any) => `${i.id}:${i.text}`), ['1:1', '2:2', '3:3', '4:grown', '5:5']);
  assert.equal(s.after, 'A2');
  r = T.applyPage(s, 'after', ok([], {}));
  assert.equal(r.state.after, 'A2', 'an answer without a cursor keeps the last one');
  assert.equal(r.then, null);

  // An empty older page that still has a cursor and more to scan goes on by itself.
  const scanning = T.applyPage({ ...s, before: 'B9' }, 'before', ok([], { before: 'B8', hasMore: true }));
  assert.equal(scanning.then, 'before');
  assert.equal(scanning.state.before, 'B8');
});

test('paging state: reset drops the cursors and reloads, a bounded number of times; other statuses show their reason', () => {
  const s = T.applyPage(T.transcriptState(), 'latest', ok([item('1')], { before: 'B', after: 'A' })).state;
  let r = T.applyPage(s, 'after', { status: 'reset', items: [], hasMore: false, unknownCount: 0 });
  assert.equal(r.then, 'latest');
  assert.deepEqual([r.state.status, r.state.items, r.state.before, r.state.after, r.state.resets], ['loading', [], null, null, 1]);
  for (let i = 1; i < T.MAX_RESETS; i++) r = T.applyPage(r.state, 'latest', { status: 'reset', items: [], hasMore: false, unknownCount: 0 });
  assert.equal(r.then, 'latest');
  r = T.applyPage(r.state, 'latest', { status: 'reset', items: [], hasMore: false, unknownCount: 0 });
  assert.equal(r.then, null, 'it stops reloading');
  assert.equal(r.state.status, 'reset');
  assert.equal(T.wantOnActivity(r.state), 'latest');
  assert.equal(T.applyPage(r.state, 'latest', ok([item('1')])).state.resets, 0, 'a good page clears the count');

  for (const status of ['missing', 'unsupported', 'archived', 'refused']) {
    const next = T.applyPage(s, 'after', { status, items: [], hasMore: false, unknownCount: 0 });
    assert.deepEqual([next.state.status, next.state.items, next.state.after, next.then], [status, [], null, null]);
  }
  assert.equal(T.wantOnActivity({ ...s, status: 'unsupported' }), null);
  assert.equal(T.wantOnActivity({ ...s, status: 'archived' }), null);
  assert.equal(T.wantOnActivity({ ...s, status: 'missing' }), 'latest');
  for (const bad of [null, 'x', { status: 'ok' }, { status: 'weird', items: [] }]) {
    assert.equal(T.applyPage(s, 'after', bad).state.status, 'refused');
  }
  assert.equal(T.nextWant(new Set(['before', 'after', 'latest'])), 'latest');
  assert.equal(T.nextWant(new Set(['before', 'after'])), 'after');
  assert.equal(T.nextWant(new Set()), null);
});

test('entries: orrery deliveries and posts become one card each, tools pair by call id, thinking keeps only its summary', () => {
  const entries = T.transcriptEntries([
    item('u1', 'user'),
    item('t1', 'thinking', { text: '  summary  ' }),
    item('t2', 'thinking', { text: '' }),
    item('c1', 'tool_call', { callId: 'k1', name: 'Read' }),
    item('r1', 'tool_result', { callId: 'k1' }),
    item('r0', 'tool_result', { callId: 'gone' }),
    item('c2', 'tool_call', { callId: 'k2', name: 'mcp__orrery__send_message' }),
    item('p2', 'orrery_post', { callId: 'k2', messageId: 'm2' }),
    item('d1', 'orrery_delivery', { parts: [{ messageId: 'm1', from: 'a', kind: 'chat', body: 'hello\nthere' }, { messageId: 'm3', from: 'system', kind: 'system', body: 'x' }] }),
    item('x1', 'unknown'),
    item('s1', 'system'),
  ]);
  assert.deepEqual(entries.map((e: any) => `${e.type}:${e.key}`),
    ['user:u1', 'thinking:t1', 'thinking:t2', 'tool:c1', 'tool:r0', 'post:p2', 'delivery:d1', 'system:s1']);
  assert.equal(entries[1].text, 'summary');
  assert.equal(entries[2].text, null);
  assert.equal(entries[3].result.id, 'r1');
  assert.equal(entries[4].call, null);
  assert.equal(entries[5].call.id, 'c2', 'the send call goes inside its post card');
  assert.deepEqual(T.deliveryCaption(entries[6].item), { from: 'a', text: 'hello there', more: 1 });
  assert.deepEqual(T.deliveryCaption({ kind: 'orrery_delivery', parts: [], text: 'raw   envelope' }), { from: null, text: 'raw envelope', more: 0 });

  let open = new Set<string>();
  assert.equal(T.allCardsOpen(entries, open), false);
  open = T.toggleAllCards(entries, open);
  assert.deepEqual([...open].sort(), ['d1', 'p2']);
  assert.equal(T.allCardsOpen(entries, open), true);
  assert.deepEqual([...T.toggleAllCards(entries, open)], [], 'the second press closes them all');
  assert.equal(T.allCardsOpen([], new Set()), false, 'nothing to open');
  assert.equal(T.oneLine('a'.repeat(10), 4), 'aaaa…');
});

test('Hub chat helpers: merging by id, older pages, stream events, member activity, read position', () => {
  const a = { id: 'a', clusterId: 'c', body: '1' }, b = { id: 'b', clusterId: 'c', body: '2' };
  const b2 = { ...b, body: 'edited' };
  assert.deepEqual(T.mergeMessages([a, b], [b2, { id: 'c', clusterId: 'c' }]).map((m: any) => m.body ?? m.id), ['1', 'edited', 'c']);
  assert.deepEqual(T.prependMessages([b], [a, b]).map((m: any) => m.id), ['a', 'b']);
  const event = { kind: 'message', clusterId: 'c', payload: { message: a, deliveries: [{ memberId: 'm' }], attachments: [{ id: 'f' }] } };
  assert.deepEqual(T.eventMessage(event, 'c'), { ...a, attachments: [{ id: 'f' }] });
  assert.equal(T.eventMessage(event, 'other'), null);
  assert.equal(T.eventMessage({ kind: 'delivery', payload: {} }, 'c'), null);
  assert.equal(T.isMemberActivity(event, 'm'), true, 'a delivery to the member');
  assert.equal(T.isMemberActivity({ kind: 'message', payload: { message: { from: 'm' }, deliveries: [] } }, 'm'), true);
  assert.equal(T.isMemberActivity({ kind: 'agent', memberId: 'm', payload: {} }, 'm'), true);
  assert.equal(T.isMemberActivity({ kind: 'delivery', payload: { delivery: { memberId: 'm' } } }, 'm'), true);
  assert.equal(T.isMemberActivity({ kind: 'member', payload: { member: { id: 'm' } } }, 'm'), true);
  assert.equal(T.isMemberActivity({ kind: 'agent', memberId: 'n', payload: {} }, 'm'), false);
  assert.equal(T.isMemberActivity(null, 'm'), false);
  assert.equal(T.readTarget([a, b], null, null), 'b');
  assert.equal(T.readTarget([a, b], 'b', null), null);
  assert.equal(T.readTarget([a, b], 'a', 'b'), null, 'just sent');
  assert.equal(T.readTarget([], null, null), null);
});

test('window keys and stack: one window per target, the same target raises it, closing gives the top to the one below', () => {
  assert.equal(W.windowKey({ kind: 'hub', clusterId: 'c' }), 'hub|c');
  assert.equal(W.windowKey({ kind: 'member', clusterId: 'c', memberId: 'm' }), 'member|c|m');
  for (const bad of [null, {}, { kind: 'hub' }, { kind: 'member', clusterId: 'c' }, { kind: 'hub', clusterId: '' }, { kind: 'other', clusterId: 'c' }]) {
    assert.equal(W.windowKey(bad), null);
  }
  const s = W.windowStack();
  assert.equal(s.open('a'), true);
  assert.equal(s.open('b'), true);
  assert.equal(s.top(), 'b');
  assert.equal(s.open('a'), false, 'already open: raised, not a new one');
  assert.deepEqual(s.keys(), ['b', 'a']);
  assert.equal(s.raise('a'), false, 'already on top');
  assert.equal(s.raise('b'), true);
  assert.equal(s.raise('zz'), false);
  assert.equal(s.close('b'), true);
  assert.equal(s.top(), 'a');
  assert.equal(s.close('b'), false);
  s.open('c');
  assert.deepEqual(s.clear(), ['c', 'a']);
  assert.equal(s.top(), null);
});

// ---- the manager on a fake DOM ----

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, ((e: any) => void)[]>();
  classes = new Set<string>();
  style: Record<string, string> = {};
  hidden = false; disabled = false; value = ''; scrollTop = 0; ownText = '';
  tag: string; doc: FakeDoc;
  classList = {
    add: (c: string) => { this.classes.add(c); }, remove: (c: string) => { this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, on?: boolean) => { const v = on ?? !this.classes.has(c); if (v) this.classes.add(c); else this.classes.delete(c); return v; },
  };
  constructor(tag: string, doc: FakeDoc) { this.tag = tag; this.doc = doc; }
  get ownerDocument() { return this.doc; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name: string, value: unknown) {
    this.attrs.set(name, String(value));
    if (name === 'class') { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  addEventListener(type: string, fn: (e: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (e: any) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }
  fire(type: string, event: any = {}) {
    const e = { preventDefault() { this.defaultPrevented = true; }, defaultPrevented: false, target: this, ...event };
    for (let at: FakeNode | null = this; at; at = at.parent) for (const fn of at.listeners.get(type) ?? []) fn(e);
    return e;
  }
  append(...nodes: unknown[]) {
    for (const node of nodes) {
      const child = node instanceof FakeNode ? node : Object.assign(new FakeNode('#text', this.doc), { ownText: String(node) });
      child.remove();
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes: unknown[]) { for (const c of [...this.children]) c.remove(); this.append(...nodes); }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  set textContent(value: string) { this.replaceChildren(value); }
  get textContent(): string { return this.tag === '#text' ? this.ownText : this.children.map((c) => c.textContent).join(''); }
  focus() {}
  closest() { return null; }
  all(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  find(pred: (n: FakeNode) => boolean) { return this.all().filter(pred); }
  byClass(c: string) { return this.find((n) => n.classes.has(c)); }
}
class FakeDoc {
  head: FakeNode; body: FakeNode;
  constructor() { this.head = new FakeNode('head', this); this.body = new FakeNode('body', this); }
  createElement(tag: string) { return new FakeNode(tag, this); }
  createElementNS(_ns: string, tag: string) { return new FakeNode(tag, this); }
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function fakeContext(answer: (method: string, path: string, body?: unknown) => unknown) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const listeners = new Set<(e: any) => void>();
  let unsubscribed = 0;
  return {
    calls, listeners, unsubscribed: () => unsubscribed,
    emit: (e: any) => { for (const fn of [...listeners]) fn(e); },
    ctx: {
      api: async (method: string, path: string, body?: unknown) => { calls.push({ method, path, body }); return answer(method, path, body); },
      onEvent: (fn: (e: any) => void) => { listeners.add(fn); return () => { unsubscribed++; listeners.delete(fn); }; },
      openChat: (id: string) => { calls.push({ method: 'openChat', path: id }); },
      theme: 'dark',
    },
  };
}

test('manager: opens a Hub chat once, raises it again, sends, follows the stream, marks read, and closeAll ends everything', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const first = { id: 'm1', clusterId: 'c', from: 'user', body: 'hello **there**', createdAt: '2026-11-19T10:00:00Z' };
    const notice = { id: 'm2', clusterId: 'c', from: 'system', kind: 'system', systemKind: 'task', body: 'a notice', createdAt: '2026-11-19T10:01:00Z' };
    const f = fakeContext((method, path) => {
      if (path.startsWith('/api/state')) return { clusters: [{ id: 'c', name: 'Cluster' }], members: [] };
      if (method === 'GET' && path.startsWith('/api/clusters/c/messages')) return [first, notice];
      if (method === 'POST' && path === '/api/clusters/c/messages') return { id: 'm3', clusterId: 'c', from: 'user', body: 'sent', createdAt: '2026-11-19T10:02:00Z' };
      return {};
    });
    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx });
    assert.equal(doc.head.children.length, 1, 'the stylesheet is linked once');
    assert.match(doc.head.children[0].getAttribute('href')!, /\/starmap\/package\/web\/windows\.css$/);
    W.createWindows({ root: new FakeNode('div', doc), ctx: fakeContext(() => ({})).ctx }).closeAll();
    assert.equal(doc.head.children.length, 1);

    windows.open({ kind: 'hub', clusterId: 'c' });
    windows.open({ kind: 'hub', clusterId: 'c' });
    windows.open({ kind: 'nonsense' });
    const layer = root.children[0];
    assert.equal(layer.children.length, 1, 'one window for one target');
    await flush();
    const win = layer.children[0];
    assert.equal(win.getAttribute('aria-label'), 'Hub 群聊：Cluster');
    assert.ok(win.classes.has('smw-active'));
    assert.equal(f.calls.filter((c) => c.path === '/api/clusters/c/messages?limit=50').length, 1);
    assert.match(win.textContent, /hello there/);
    const sys = win.byClass('smw-sys');
    assert.equal(sys.length, 1, 'the system notice is drawn apart');
    assert.ok(sys[0].classes.has('smw-k-task'));
    assert.deepEqual(f.calls.filter((c) => c.path === '/api/clusters/c/read').map((c) => c.body), [{ messageId: 'm2' }]);

    windows.setSatellites('c', ['m2']);
    assert.equal(win.byClass('smw-sat-tag').length, 1);

    const input = win.find((n) => n.tag === 'textarea')[0];
    input.value = 'sent';
    await win.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    assert.deepEqual(f.calls.find((c) => c.method === 'POST' && c.path === '/api/clusters/c/messages')?.body, { body: 'sent' });
    assert.equal(input.value, '');

    f.emit({ kind: 'message', clusterId: 'c', payload: { message: { id: 'm4', clusterId: 'c', from: 'user', body: 'from the stream', createdAt: '2026-11-19T10:03:00Z' }, deliveries: [] } });
    f.emit({ kind: 'message', clusterId: 'x', payload: { message: { id: 'm5', clusterId: 'x', from: 'user', body: 'other cluster' }, deliveries: [] } });
    assert.match(win.textContent, /from the stream/);
    assert.doesNotMatch(win.textContent, /other cluster/);
    t.mock.timers.tick(2500);
    assert.deepEqual(f.calls.filter((c) => c.path === '/api/clusters/c/read').at(-1)?.body, { messageId: 'm4' }, 'read again, after the pause');

    win.find((n) => n.getAttribute('aria-label') === '在聊天界面打开')[0].fire('click');
    assert.ok(f.calls.some((c) => c.method === 'openChat' && c.path === 'c'));

    // Esc with a draft keeps the window; without one closes it.
    input.value = 'draft';
    assert.equal(win.fire('keydown', { key: 'Escape' }).defaultPrevented, true);
    assert.equal(layer.children.length, 1);

    windows.open({ kind: 'member', clusterId: 'c', memberId: 'm' });
    assert.equal(layer.children.length, 2);
    assert.ok(!win.classes.has('smw-active'), 'the newer window has the focus');
    windows.open({ kind: 'hub', clusterId: 'c' });
    assert.ok(win.classes.has('smw-active'), 'opening it again raises it');

    windows.closeAll();
    assert.equal(f.unsubscribed(), 1);
    assert.equal(root.children.length, 0, 'the layer is gone');
    windows.open({ kind: 'hub', clusterId: 'c' });
    assert.equal(root.children.length, 0, 'closed for good');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test('manager: a member window pages its transcript, follows activity, reloads on reset, ignores answers after closeAll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const pages: unknown[] = [
      ok([item('a1', 'user', { text: 'question' }), item('d1', 'orrery_delivery', { parts: [{ messageId: 'h1', from: 'system', kind: 'system', body: 'notice body' }] }),
        item('c1', 'tool_call', { callId: 'k', name: 'send_message', text: '{"body":"x"}' }), item('p1', 'orrery_post', { callId: 'k', messageId: 'h2' })],
      { before: 'B1', after: 'A1' }),
      ok([item('a2', 'assistant', { text: 'answer <b>raw</b>' })], { after: 'A2' }),
      { status: 'reset', items: [], hasMore: false, unknownCount: 0 },
      ok([item('a3', 'assistant', { text: 'after reset' })], { after: 'A3' }),
    ];
    let hold: ((v: unknown) => void) | null = null, holdNext = false;
    const f = fakeContext((method, path) => {
      if (path.startsWith('/api/state')) return { clusters: [{ id: 'c', name: 'Cluster' }], members: [{ id: 'm', clusterId: 'c', name: 'Ann', harness: 'claude', avatar: '🙂' }] };
      if (path === '/api/clusters/c/messages/h2') return { id: 'h2', body: 'the posted text' };
      if (path.includes('/transcript')) {
        if (holdNext) return new Promise((resolve) => { hold = resolve; });
        return pages.shift();
      }
      return {};
    });
    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx });
    windows.open({ kind: 'member', clusterId: 'c', memberId: 'm' });
    await flush();
    const win = root.children[0].children[0];
    const transcriptCalls = () => f.calls.filter((c) => c.path.includes('/transcript')).map((c) => c.path.replace('/api/clusters/c/members/m/transcript?', ''));
    assert.deepEqual(transcriptCalls(), ['limit=50']);
    assert.equal(win.getAttribute('aria-label'), 'Ann 的对话（Cluster）');
    assert.match(win.textContent, /question/);
    const cards = win.byClass('smw-card');
    assert.equal(cards.length, 2, 'the delivery and the post, the send call inside its card');
    assert.ok(!cards.some((c) => c.classes.has('smw-open')));

    const all = win.find((n) => n.attrs.has('data-ox-all'))[0];
    assert.equal(all.textContent, '全部展开');
    all.fire('click');
    await flush();
    assert.equal(all.textContent, '全部收起');
    assert.ok(win.byClass('smw-card').every((c) => c.classes.has('smw-open')));
    assert.ok(f.calls.some((c) => c.path === '/api/clusters/c/messages/h2'), 'the post text is read when its card opens');
    assert.match(win.textContent, /the posted text/);

    // Activity of another member changes nothing; this member's runs one `after` read after a short pause.
    f.emit({ kind: 'agent', memberId: 'other', payload: {} });
    f.emit({ kind: 'agent', memberId: 'm', payload: {} });
    f.emit({ kind: 'delivery', payload: { delivery: { memberId: 'm' } } });
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(transcriptCalls(), ['limit=50', 'direction=after&limit=50&cursor=A1']);
    assert.match(win.textContent, /answer <b>raw<\/b>/, 'markup stays text');

    // The cursor no longer fits (the conversation was rewritten): drop it and read the newest page.
    f.emit({ kind: 'agent', memberId: 'm', payload: {} });
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(transcriptCalls().slice(2), ['direction=after&limit=50&cursor=A2', 'limit=50']);
    assert.match(win.textContent, /after reset/);
    assert.doesNotMatch(win.textContent, /question/);

    const older = win.find((n) => n.tag === 'button' && n.textContent === '加载更早的内容')[0];
    assert.equal(older.hidden, true, 'no older page after the reload (no before cursor)');

    // A read is still on its way when the windows close: its answer changes nothing.
    holdNext = true;
    win.find((n) => n.tag === 'button' && n.textContent === '刷新')[0].fire('click');
    await flush();
    assert.ok(hold, 'the reload was asked');
    windows.closeAll();
    assert.equal(f.listeners.size, 0);
    (hold as ((v: unknown) => void) | null)?.(ok([item('late')]));
    await flush();
    assert.doesNotMatch(win.textContent, /late/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test('binding changes: a rebind, a removal and the recycle bin are told apart from ordinary activity', () => {
  const member = (extra: object = {}) => ({ kind: 'member', memberId: 'm', payload: { member: { id: 'm', clusterId: 'c', removedAt: null, ...extra } } });
  assert.equal(T.bindingChange({ ...member(), payload: { ...member().payload, rebind: { memberId: 'm' } } }, 'c', 'm'), 'rebind');
  assert.equal(T.bindingChange(member({ removedAt: '2026-11-19T10:00:00Z' }), 'c', 'm'), 'ended');
  assert.equal(T.bindingChange({ kind: 'cluster', payload: { cluster: { id: 'c', deletedAt: '2026-11-19T10:00:00Z' }, members: [] } }, 'c', 'm'), 'ended');
  assert.equal(T.bindingChange(member(), 'c', 'm'), null, 'a status change is activity');
  assert.equal(T.bindingChange({ kind: 'cluster', payload: { cluster: { id: 'c', deletedAt: null }, members: [] } }, 'c', 'm'), null);
  assert.equal(T.bindingChange({ kind: 'cluster', payload: { cluster: { id: 'x', deletedAt: '2026-11-19T10:00:00Z' } } }, 'c', 'm'), null);
  assert.equal(T.bindingChange({ ...member(), payload: { member: { id: 'other', clusterId: 'c' }, rebind: {} } }, 'c', 'm'), null);
  assert.equal(T.isGoneError({ status: 400, data: { error: 'unknown member in cluster' } }), true);
  assert.equal(T.isGoneError({ status: 500 }), false);
  assert.equal(T.wantOnActivity({ ...T.transcriptState(), status: 'ended' }), null);
});

test('manager: the close button asks before dropping a draft; Esc keeps it', async () => {
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const f = fakeContext((_method, path) => (path.startsWith('/api/state') ? { clusters: [{ id: 'c', name: 'Cluster' }], members: [] } : []));
    const asked: unknown[] = [];
    let reply = false;
    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx, askClose: async (options: unknown) => { asked.push(options); return reply; } });
    windows.open({ kind: 'hub', clusterId: 'c' });
    await flush();
    const layer = root.children[0];
    const win = layer.children[0];
    const closeButton = win.byClass('smw-close')[0];
    win.find((n) => n.tag === 'textarea')[0].value = 'not sent yet';
    win.fire('keydown', { key: 'Escape' });
    assert.equal(layer.children.length, 1, 'Esc keeps a window with a draft');
    closeButton.fire('click');
    await flush();
    assert.equal(asked.length, 1);
    assert.equal(layer.children.length, 1, '"no" keeps it');
    reply = true;
    closeButton.fire('click');
    await flush();
    assert.equal(asked.length, 2);
    assert.equal(layer.children.length, 0, '"yes" closes it');
    // Without a draft the close button closes at once.
    windows.open({ kind: 'hub', clusterId: 'c' });
    await flush();
    layer.children[0].byClass('smw-close')[0].fire('click');
    await flush();
    assert.equal(asked.length, 2);
    assert.equal(layer.children.length, 0);
    windows.closeAll();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test("manager: a window closed and opened again for the same target ignores the closed one's late answers", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const held: { path: string; resolve: (v: unknown) => void }[] = [];
    const f = fakeContext((method, path) => {
      if (path.startsWith('/api/state')) return { clusters: [{ id: 'c', name: 'Cluster' }], members: [{ id: 'm', clusterId: 'c', name: 'Ann', harness: 'claude' }] };
      if (method === 'GET') return new Promise((resolve) => { held.push({ path, resolve }); });
      return {};
    });
    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx, askClose: async () => true });
    const layer = root.children[0];
    const msg = (id: string) => ({ id, clusterId: 'c', from: 'user', body: id, createdAt: '2026-11-19T10:00:00Z' });

    // The Hub chat: the first window's read comes back after it closed and a new one opened for the same chat.
    windows.open({ kind: 'hub', clusterId: 'c' });
    await flush();
    layer.children[0].byClass('smw-close')[0].fire('click');
    await flush();
    windows.open({ kind: 'hub', clusterId: 'c' });
    await flush();
    const hub = layer.children[0];
    assert.equal(held.length, 2);
    held[0].resolve([msg('stale')]);
    await flush();
    assert.doesNotMatch(hub.textContent, /stale/);
    assert.deepEqual(f.calls.filter((c) => c.path.endsWith('/read')), [], 'nothing it never showed is marked read');
    held[1].resolve([msg('fresh')]);
    await flush();
    assert.match(hub.textContent, /fresh/);
    assert.deepEqual(f.calls.filter((c) => c.path.endsWith('/read')).map((c) => c.body), [{ messageId: 'fresh' }]);
    hub.byClass('smw-close')[0].fire('click');
    await flush();

    // The member conversation: the old window's page would chain a next one; it neither draws nor reads on.
    windows.open({ kind: 'member', clusterId: 'c', memberId: 'm' });
    await flush();
    layer.children[0].byClass('smw-close')[0].fire('click');
    await flush();
    windows.open({ kind: 'member', clusterId: 'c', memberId: 'm' });
    await flush();
    const member = layer.children[0];
    const reads = () => f.calls.filter((c) => c.path.includes('/transcript')).length;
    assert.equal(reads(), 2);
    held[2].resolve(ok([item('stale-entry')], { after: 'A0', hasMore: true }));
    await flush();
    assert.equal(reads(), 2, 'no next page for a closed window');
    assert.doesNotMatch(member.textContent, /stale-entry/);
    held[3].resolve(ok([item('fresh-entry')], { after: 'A1' }));
    await flush();
    assert.match(member.textContent, /fresh-entry/);
    windows.closeAll();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test('manager: a member window drops the old conversation on a rebind, a removal or a gone answer, and reads the new one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const answers: unknown[] = [{ status: 'unsupported', items: [], hasMore: false, unknownCount: 0 }];
    let held: ((v: unknown) => void) | null = null;
    const f = fakeContext((_method, path) => {
      if (path.startsWith('/api/state')) {
        return { clusters: [{ id: 'c', name: 'Cluster' }], members: [{ id: 'm', clusterId: 'c', name: 'Ann', harness: 'claude' }, { id: 'k', clusterId: 'c', name: 'Kay', harness: 'codex' }] };
      }
      if (path.includes('/transcript')) {
        const next = answers.shift();
        if (next === 'hold') return new Promise((resolve) => { held = resolve; });
        if (next instanceof Error) throw next;
        return next;
      }
      return {};
    });
    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx });
    windows.open({ kind: 'member', clusterId: 'c', memberId: 'm' });
    await flush();
    const win = root.children[0].children[0];
    const reads = () => f.calls.filter((c) => c.path.startsWith('/api/clusters/c/members/m/transcript'))
      .map((c) => c.path.replace('/api/clusters/c/members/m/transcript?', ''));
    assert.match(win.textContent, /还不能在这里读取/);
    const member = { id: 'm', clusterId: 'c', name: 'Ann', harness: 'claude', removedAt: null };

    // Unsupported, then moved to a readable conversation: the newest page of the new one is read at once.
    answers.push(ok([item('new-1')], { before: 'B1', after: 'A1' }));
    f.emit({ kind: 'member', memberId: 'm', payload: { member, rebind: { memberId: 'm' } } });
    await flush();
    assert.deepEqual(reads(), ['limit=50', 'limit=50']);
    assert.match(win.textContent, /new-1/);

    // A read of the old binding is on its way when the member moves again: its text goes at once, the late answer is dropped.
    answers.push('hold', ok([item('new-2')], { after: 'A2' }));
    f.emit({ kind: 'agent', memberId: 'm', payload: {} });
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(reads().at(-1), 'direction=after&limit=50&cursor=A1');
    f.emit({ kind: 'member', memberId: 'm', payload: { member, rebind: { memberId: 'm' } } });
    assert.doesNotMatch(win.textContent, /new-1/, 'the old conversation is not shown as the new one');
    (held as ((v: unknown) => void) | null)?.(ok([item('old-late')], { after: 'A9', hasMore: true }));
    await flush();
    assert.deepEqual(reads().slice(2), ['direction=after&limit=50&cursor=A1', 'limit=50']);
    assert.doesNotMatch(win.textContent, /old-late/);
    assert.match(win.textContent, /new-2/);

    // Removed from the cluster: nothing of the conversation stays, the reason shows, activity reads nothing.
    f.emit({ kind: 'member', memberId: 'm', payload: { member: { ...member, removedAt: '2026-11-19T10:00:00Z' } } });
    assert.doesNotMatch(win.textContent, /new-2/);
    assert.match(win.textContent, /这个群员已不在这个群里/);
    f.emit({ kind: 'agent', memberId: 'm', payload: {} });
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(reads().length, 4);

    // Another window whose reload answers that the member is gone (the event was missed): its old text goes too.
    answers.push(ok([item('shown')], { after: 'K1' }));
    windows.open({ kind: 'member', clusterId: 'c', memberId: 'k' });
    await flush();
    const other = root.children[0].children[1];
    assert.match(other.textContent, /shown/);
    answers.push(Object.assign(new Error('unknown member in cluster'), { status: 400, data: { error: 'unknown member in cluster' } }));
    other.find((n) => n.tag === 'button' && n.textContent === '刷新')[0].fire('click');
    await flush();
    assert.doesNotMatch(other.textContent, /shown/);
    assert.match(other.textContent, /这个群员已不在这个群里/);

    // The cluster moved to the recycle bin: the window of a member still shown empties the same way.
    answers.push(ok([item('kept')], { after: 'K2' }));
    other.find((n) => n.tag === 'button' && n.textContent === '刷新')[0].fire('click');
    await flush();
    assert.match(other.textContent, /kept/);
    f.emit({ kind: 'cluster', payload: { cluster: { id: 'c', name: 'Cluster', deletedAt: '2026-11-19T11:00:00Z' }, members: [] } });
    assert.doesNotMatch(other.textContent, /kept/);
    assert.match(other.textContent, /这个群员已不在这个群里/);
    windows.closeAll();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test('rendering safety: the window files never parse HTML, load no URL from content, and link only through markdown.js', () => {
  const windows = readFileSync(join(dir, 'windows.js'), 'utf8');
  const transcript = readFileSync(join(dir, 'transcript.js'), 'utf8');
  for (const source of [windows, transcript]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|srcdoc|\beval\(|new Function/);
    assert.doesNotMatch(source, /\b(?:h|createElement|createElementNS)\([^)]*'(?:img|image|iframe|video|audio|source|object|embed)'|\bsrc\b/,
      'nothing loads a URL');
  }
  assert.doesNotMatch(transcript, /\bdocument\.|\bwindow\.|^\s*import\b|\bfetch\(/m, 'transcript.js is pure');
  assert.doesNotMatch(windows, /\bfetch\(/, 'reads go through ctx.api');
  // Links: only markdown.js's checked addresses, opened apart from the page.
  const hrefs = [...windows.matchAll(/href[^\n]*/g)].map((m) => m[0]);
  assert.ok(hrefs.length >= 2);
  for (const line of hrefs) {
    assert.ok(line.startsWith("href: n.href, target: '_blank', rel: 'noopener noreferrer'") || line.startsWith("href', new URL('./windows.css', import.meta.url).href"),
      `unexpected href: ${line}`);
  }
  // Markdown comes only from the host's public helper, which re-exports markdown.js itself.
  assert.match(windows, /^import \{[^}]*\bmarkdownBlocks\b[^}]*\} from '\/plugin-host\/v1\.js';/m);
  assert.match(readFileSync(join(REPO_ROOT, 'src/web/public/plugin-host/v1.js'), 'utf8'), /^export \{ markdownBlocks \} from '\.\.\/markdown\.js';/m);
});
