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
  assert.equal(T.eventMessage({ ...event, payload: { ...event.payload, message: { ...a, privateTo: 'm' } } }, 'c'), null);
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
    const transcriptHeld = held.filter((h) => h.path.includes('/transcript'));
    const dmHeld = held.filter((h) => h.path.includes('privateWith=m'));
    assert.equal(transcriptHeld.length, 2);
    assert.equal(dmHeld.length, 2);
    transcriptHeld[0].resolve(ok([item('stale-entry')], { after: 'A0', hasMore: true }));
    dmHeld[0].resolve([{ id: 'stale-dm', clusterId: 'c', from: 'user', privateTo: 'm', body: 'stale-dm-body', deliveries: [] }]);
    await flush();
    assert.equal(reads(), 2, 'no next page for a closed window');
    assert.doesNotMatch(member.textContent, /stale-entry|stale-dm-body/);
    transcriptHeld[1].resolve(ok([item('fresh-entry')], { after: 'A1' }));
    dmHeld[1].resolve([]);
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

test('private DM helpers: path, expanded delivery distinction, SSE updates, deduplication, and stale bindingGen', () => {
  assert.equal(T.privateMessagesPath('c 1', 'm/2'), '/api/clusters/c%201/messages?privateWith=m%2F2&limit=50');
  assert.equal(T.privateMessagesPath('c', 'm', 'id 1'), '/api/clusters/c/messages?privateWith=m&limit=50&before=id%201');

  const entries = T.transcriptEntries([
    item('d-group', 'orrery_delivery', { parts: [{ messageId: 'm1', from: 'user', body: 'hi group' }] }),
    item('d-dm', 'orrery_delivery', { parts: [{ messageId: 'm2', from: 'user', body: 'hi dm', private: true }] }),
  ]);
  assert.equal(T.isPrivateDeliveryEntry(entries[0]), false);
  assert.equal(T.isPrivateDeliveryEntry(entries[1]), true);
  assert.equal(T.isCard(entries[0]), true, 'group delivery stays a collapsible card');
  assert.equal(T.isCard(entries[1]), false, 'private DM renders expanded, not as a collapsible card');
  assert.deepEqual([...T.transcriptPrivateIds(entries)], ['m2']);

  const dm = T.eventPrivateMessage({ kind: 'message', payload: { message: { id: 'dm1', clusterId: 'c', privateTo: 'm', privateBindingGen: 2, body: 'secret' },
    deliveries: [{ id: 'del1', messageId: 'dm1', status: 'queued' }] } }, 'c', 'm');
  assert.equal(dm?.id, 'dm1');
  assert.equal(T.eventPrivateMessage({ kind: 'message', payload: { message: { id: 'pub1', clusterId: 'c', body: 'public' } } }, 'c', 'm'), null);

  const updated = T.applyPrivateDeliveryEvent([dm], { kind: 'delivery', payload: { delivery: { id: 'del1', messageId: 'dm1', status: 'failed', reason: 'timeout' } } });
  assert.deepEqual(T.dmStatusOf(updated[0], 2), {
    status: 'failed',
    outcome: null,
    delivery: { id: 'del1', messageId: 'dm1', status: 'failed', reason: 'timeout' },
    stale: false,
    canResend: true,
  });
  assert.deepEqual(T.dmStatusOf(updated[0], 3), {
    status: 'failed',
    outcome: null,
    delivery: { id: 'del1', messageId: 'dm1', status: 'failed', reason: 'timeout' },
    stale: true,
    canResend: false,
  });
  assert.deepEqual(T.dmStatusOf({ id: 'dm2', privateBindingGen: 2, deliveries: [{ id: 'del2', state: 'done', outcome: 'unknown' }] }, 2), {
    status: 'done',
    outcome: 'unknown',
    delivery: { id: 'del2', state: 'done', outcome: 'unknown' },
    stale: false,
    canResend: true,
  });
});

test('manager: member window private DM send, live status, resend, stale binding, and plugin panels', async () => {
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const member = { id: 'm', clusterId: 'c', name: 'Ann', harness: 'claude', bindingGen: 2 };
    const f = fakeContext((method, path, body: any) => {
      if (path.startsWith('/api/state')) return { clusters: [{ id: 'c', name: 'Cluster' }], members: [member] };
      if (method === 'GET' && path.includes('privateWith=m')) {
        return [
          { id: 'synced-dm', clusterId: 'c', from: 'user', privateTo: 'm', privateBindingGen: 2, body: 'sent via orrery',
            deliveries: [{ id: 'd-sync', messageId: 'synced-dm', state: 'done' }] },
          { id: 'old-dm', clusterId: 'c', from: 'user', privateTo: 'm', privateBindingGen: 1, body: 'from old binding',
            deliveries: [{ id: 'd-old', messageId: 'old-dm', state: 'failed', reason: 'offline' }] },
          { id: 'cur-fail', clusterId: 'c', from: 'user', privateTo: 'm', privateBindingGen: 2, body: 'retry me',
            deliveries: [{ id: 'd-cur', messageId: 'cur-fail', state: 'failed', reason: 'boom' }] },
        ];
      }
      if (method === 'GET' && path.includes('/transcript')) {
        return ok([
          item('u1', 'user', { text: 'typed natively' }),
          item('dm-tr', 'orrery_delivery', { parts: [{ messageId: 'synced-dm', from: 'user', body: 'sent via orrery', private: true }] }),
        ]);
      }
      if (method === 'POST' && path === '/api/clusters/c/messages') {
        return { id: 'new-dm', clusterId: 'c', from: 'user', privateTo: 'm', privateBindingGen: 2, body: body.body,
          deliveries: [{ id: 'd-new', messageId: 'new-dm', state: 'queued' }] };
      }
      if (method === 'GET' && path === '/api/clusters/c/deliveries/d-cur/timeline') {
        return { deliveryId: 'd-cur', resend: { available: true, needsConfirmation: false } };
      }
      if (method === 'POST' && path === '/api/clusters/c/deliveries/d-cur/resend') {
        return { message: { id: 'resent-dm', clusterId: 'c', from: 'user', privateTo: 'm', privateBindingGen: 2, body: 'retry me' },
          delivery: { id: 'd-resent', messageId: 'resent-dm', state: 'queued' } };
      }
      return {};
    });
    let extClosed = 0;
    const extShell = new FakeNode('section', doc);
    (f.ctx as any).pluginUi = { mountStarmapFrame: () => ({ shell: extShell, close: () => { extClosed++; } }) };

    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx });
    windows.open({ kind: 'member', clusterId: 'c', memberId: 'm' });
    await flush();
    const layer = root.children[0];
    const win = layer.children[0];

    // Native user bubble vs expanded Orrery DM bubble both render cleanly; synced done DM is deduplicated from dmTray.
    assert.match(win.textContent, /你 · 在 Claude 里输入/);
    assert.match(win.textContent, /经 Orrery 私聊/);
    assert.match(win.textContent, /sent via orrery/);
    assert.equal(win.find((n) => n.attrs.get('data-dm-id') === 'synced-dm').length, 0, 'done DM already in transcript must not duplicate in dmTray');
    // Old binding DM is labeled 旧对话 with no resend button; current failed DM has Retry button.
    assert.match(win.textContent, /旧对话/);
    const retryBtns = win.find((n) => n.tag === 'button' && n.textContent === '重试');
    assert.equal(retryBtns.length, 1, 'only same-binding failed DM gets a retry button');
    retryBtns[0].fire('click');
    await flush();
    assert.ok(f.calls.some((c) => c.method === 'POST' && c.path === '/api/clusters/c/deliveries/d-cur/resend'));

    // Sending a new private DM calls POST /messages with private: true and expectedBindingGen.
    const input = win.find((n) => n.tag === 'textarea')[0];
    input.value = 'private hello';
    await win.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    assert.deepEqual(f.calls.find((c) => c.method === 'POST' && c.path === '/api/clusters/c/messages')?.body,
      { body: 'private hello', to: ['m'], private: true, expectedBindingGen: 2 });
    assert.equal(input.value, '');

    // Opening same-page panel & restricted external panel, theme sync, and plugin panel release.
    let unmounted = 0;
    const themesSeen: string[] = [];
    const panel = {
      key: 'ext:demo', id: 'demo', pluginId: 'ext', trusted: true, icon: 'tasks', scope: 'cluster',
      title: () => 'Demo Panel', defaultSize: { w: 500, h: 400 },
      mount(el: any, pctx: any) {
        pctx.onThemeChange((th: any) => themesSeen.push(th.id));
        el.append('panel body');
      },
      unmount() { unmounted++; },
    };
    windows.open({ kind: 'panel', panel, clusterId: 'c' });
    windows.open({ kind: 'external-panel', item: { pluginId: 'tp', name: 'Restricted TP' }, clusterId: 'c' });
    assert.equal(layer.children.length, 3);
    assert.match(layer.children[1].textContent, /第三方插件/);
    assert.match(layer.children[2].textContent, /第三方插件/);
    windows.setTheme({ id: 'sol', scheme: 'dark', tokens: {} });
    assert.deepEqual(themesSeen, ['sol']);
    windows.closePluginPanels('ext');
    assert.equal(unmounted, 1);
    assert.equal(layer.children.length, 2);
    windows.closeAll();
    assert.equal(extClosed, 1);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test('manager: rebind guards private DM draft, uncertain resend asks confirmDuplicate, panel guards draft & isolates multi-cluster instances', async () => {
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    let memberGen = 1;
    let simulateRace = false;
    const f = fakeContext((method, path, body: any) => {
      if (path.startsWith('/api/state')) {
        return {
          clusters: [{ id: 'c1', name: 'Cluster 1' }, { id: 'c2', name: 'Cluster 2' }],
          members: [{ id: 'm', clusterId: 'c1', name: 'Ann', harness: 'claude', bindingGen: memberGen }],
        };
      }
      if (method === 'GET' && path.includes('privateWith=m')) {
        return [
          { id: 'uncertain-dm', clusterId: 'c1', from: 'user', privateTo: 'm', privateBindingGen: 1, body: 'did it run?',
            deliveries: [{ id: 'd-unk', messageId: 'uncertain-dm', state: 'done', outcome: 'unknown', error: 'timeout' }] },
          { id: 'stale-dm', clusterId: 'c1', from: 'user', privateTo: 'm', privateBindingGen: 0, body: 'old gen',
            deliveries: [{ id: 'd-old', messageId: 'stale-dm', state: 'failed' }] },
        ];
      }
      if (method === 'GET' && path.includes('/transcript')) return ok([]);
      if (method === 'GET' && path === '/api/clusters/c1/deliveries/d-unk/timeline') {
        return { deliveryId: 'd-unk', resend: { available: true, needsConfirmation: true } };
      }
      if (method === 'POST' && path === '/api/clusters/c1/deliveries/d-unk/resend') {
        return { message: { id: 'resent-unk', clusterId: 'c1', from: 'user', privateTo: 'm', privateBindingGen: memberGen, body: 'did it run?' },
          delivery: { id: 'd-unk-2', messageId: 'resent-unk', state: 'queued' } };
      }
      if (method === 'POST' && path === '/api/clusters/c1/messages') {
        if (simulateRace) {
          simulateRace = false;
          throw Object.assign(new Error('member binding changed'), { data: { code: 'BINDING_CHANGED' } });
        }
        return { id: 'dm-sent', clusterId: 'c1', from: 'user', privateTo: 'm', privateBindingGen: body.expectedBindingGen ?? memberGen, body: body.body,
          deliveries: [{ id: 'd-sent', messageId: 'dm-sent', state: 'queued' }] };
      }
      return {};
    });

    const asks: any[] = [];
    let nextAskAnswer = false;
    const askClose = async (opts: any) => { asks.push(opts); return nextAskAnswer; };

    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx, askClose });
    windows.open({ kind: 'member', clusterId: 'c1', memberId: 'm' });
    await flush();
    const layer = root.children[0];
    const memWin = layer.children[0];

    // 1. Outcome-unknown DM shows retry button, checks timeline needsConfirmation, cancels cleanly, then sends confirmDuplicate: true.
    assert.match(memWin.textContent, /结果未知/);
    const retryBtns = memWin.find((n) => n.tag === 'button' && n.textContent === '重试');
    assert.equal(retryBtns.length, 1, 'uncertain DM gets retry button while stale DM does not');
    nextAskAnswer = false;
    retryBtns[0].fire('click');
    await flush();
    assert.equal(asks.length, 1, 'uncertain resend opens confirmation dialog');
    assert.equal(f.calls.some((c) => c.method === 'POST' && c.path.includes('/resend')), false, 'cancelling confirm does not POST resend');

    nextAskAnswer = true;
    retryBtns[0].fire('click');
    await flush();
    assert.equal(asks.length, 2);
    assert.deepEqual(f.calls.find((c) => c.method === 'POST' && c.path === '/api/clusters/c1/deliveries/d-unk/resend')?.body,
      { confirmDuplicate: true }, 'confirming uncertain resend sends confirmDuplicate: true');

    // 2. Writing a draft on bindingGen 1, then rebinding to bindingGen 2 preserves draft and blocks silent send until user confirms.
    const input = memWin.find((n) => n.tag === 'textarea')[0];
    input.value = 'only for session A';
    input.fire('input');
    memberGen = 2;
    f.emit({ kind: 'member', payload: { member: { id: 'm', clusterId: 'c1', name: 'Ann', harness: 'claude', bindingGen: 2 }, rebind: true } });
    await flush();
    assert.equal(input.value, 'only for session A', 'draft preserved across rebind');
    const sendBtn = memWin.find((n) => n.tag === 'button' && n.classes.has('smw-send'))[0];
    assert.equal(sendBtn.disabled, true, 'send disabled until user confirms new conversation');
    await memWin.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    assert.equal(f.calls.some((c) => c.method === 'POST' && c.path === '/api/clusters/c1/messages'), false, 'blocked submit does not POST');

    // Confirming the new conversation re-enables send and submits with expectedBindingGen: 2.
    const confirmRebindBtn = memWin.find((n) => n.tag === 'button' && n.classes.has('smw-rebind-ok'))[0];
    confirmRebindBtn.fire('click');
    assert.equal(sendBtn.disabled, false);
    // First simulate a race where the member moved to bindingGen 3 on the Hub before SSE arrives: draft must stay, re-lock, and refresh directory.
    simulateRace = true;
    memberGen = 3;
    await memWin.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    assert.equal(input.value, 'only for session A', 'draft kept after BINDING_CHANGED race');
    assert.equal(sendBtn.disabled, true, 're-locked after BINDING_CHANGED race');
    assert.equal(confirmRebindBtn.disabled, false, 'confirm unlocks once directory.refresh() observes bindingGen 3');

    // Confirm again and send cleanly to bindingGen 3.
    confirmRebindBtn.fire('click');
    await memWin.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    assert.deepEqual(f.calls.filter((c) => c.method === 'POST' && c.path === '/api/clusters/c1/messages').at(-1)?.body,
      { body: 'only for session A', to: ['m'], private: true, expectedBindingGen: 3 });
    assert.equal(input.value, '');

    // 3. Same-page panel draft protection on Esc and Close (cancel keeps draft, confirm closes & unmounts).
    // Also test per-instance lifecycle across two clusters simultaneously (c1 & c2)!
    const mounted = new Map<any, string>();
    const unmountedClusters: string[] = [];
    const clusterPanel = {
      key: 'tasks:tasks', id: 'tasks', pluginId: 'tasks', trusted: false, icon: 'tasks', scope: 'cluster',
      title: () => 'Tasks', defaultSize: { w: 500, h: 400 },
      mount(el: any, pctx: any) {
        mounted.set(el, pctx.clusterId);
        const ta = doc.createElement('textarea');
        el.append(ta);
        return () => {
          if (mounted.has(el)) {
            unmountedClusters.push(mounted.get(el)!);
            mounted.delete(el);
          }
        };
      },
      unmount(el: any) {
        if (mounted.has(el)) {
          unmountedClusters.push(mounted.get(el)!);
          mounted.delete(el);
        }
      },
    };
    windows.open({ kind: 'panel', panel: clusterPanel, clusterId: 'c1' });
    windows.open({ kind: 'panel', panel: clusterPanel, clusterId: 'c2' });
    assert.equal(mounted.size, 2, 'both cluster c1 and c2 panels remain mounted simultaneously');

    const p1Win = layer.children.find((w: any) => w.attrs.get('data-window') === 'panel|tasks:tasks|c1')!;
    const p2Win = layer.children.find((w: any) => w.attrs.get('data-window') === 'panel|tasks:tasks|c2')!;
    const p1Ta = p1Win.find((n: any) => n.tag === 'textarea')[0];
    p1Ta.value = 'unsaved panel draft';

    // Esc keeps panel with unsaved draft open.
    p1Win.fire('keydown', { key: 'Escape' });
    assert.equal(layer.children.includes(p1Win), true, 'Esc keeps panel with draft open');

    // Close button asks confirmation; cancelling keeps panel and draft intact.
    const asksBefore = asks.length;
    nextAskAnswer = false;
    p1Win.find((n: any) => n.classes.has('smw-close'))[0].fire('click');
    await flush();
    assert.equal(asks.length, asksBefore + 1, 'panel close with draft calls askClose');
    assert.equal(layer.children.includes(p1Win), true, 'cancelling keeps panel open');
    assert.equal(p1Ta.value, 'unsaved panel draft');
    assert.equal(mounted.size, 2);

    // Confirming closes ONLY c1 panel while c2 stays mounted!
    nextAskAnswer = true;
    p1Win.find((n: any) => n.classes.has('smw-close'))[0].fire('click');
    await flush();
    assert.equal(layer.children.includes(p1Win), false, 'c1 panel closed after confirm');
    assert.equal(layer.children.includes(p2Win), true, 'c2 panel remains open');
    assert.deepEqual(unmountedClusters, ['c1'], 'closing c1 unmounts only c1');
    assert.equal(mounted.size, 1);

    // Closing c2 (no draft) closes immediately without prompt and unmounts c2.
    p2Win.find((n: any) => n.classes.has('smw-close'))[0].fire('click');
    await flush();
    assert.equal(asks.length, asksBefore + 2, 'empty panel closes without extra confirm');
    assert.deepEqual(unmountedClusters, ['c1', 'c2']);
    assert.equal(mounted.size, 0);

    windows.closeAll();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test('manager: blocks private DM submit while directory is loading or failed without SSE, and ignores late stale snapshots', async () => {
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    // Directory GET held while member is already on bindingGen 2 on the Hub (no SSE).
    const heldStates: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const f1 = fakeContext((method, path, body: any) => {
      if (path.startsWith('/api/state')) {
        return new Promise((resolve, reject) => { heldStates.push({ resolve, reject }); });
      }
      if (method === 'GET' && path.includes('privateWith=m')) return [];
      if (method === 'GET' && path.includes('/transcript')) return ok([]);
      if (method === 'POST' && path === '/api/clusters/c1/messages') {
        return { id: 'dm-1', clusterId: 'c1', from: 'user', privateTo: 'm', privateBindingGen: body.expectedBindingGen, body: body.body, deliveries: [] };
      }
      return {};
    });

    const root1 = new FakeNode('div', doc);
    const w1 = W.createWindows({ root: root1, ctx: f1.ctx });
    w1.open({ kind: 'member', clusterId: 'c1', memberId: 'm' });
    await flush();
    const win1 = root1.children[0].children[0];
    const input1 = win1.find((n) => n.tag === 'textarea')[0];
    const send1 = win1.find((n) => n.tag === 'button' && n.classes.has('smw-send'))[0];

    assert.equal(heldStates.length, 1, 'initial directory GET is in flight');
    assert.equal(input1.disabled, true, 'DM input disabled before bindingGen is known');
    assert.equal(send1.disabled, true, 'DM send disabled before bindingGen is known');
    // Even forcing a form submit while directory is still loading must emit zero POSTs.
    input1.value = 'must not send without gen';
    await win1.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    assert.equal(f1.calls.filter((c) => c.method === 'POST' && c.path === '/api/clusters/c1/messages').length, 0,
      'no private DM POST while directory is loading and no SSE arrived');

    // If initial directory GET fails, composer stays disabled and still refuses POSTs until manual refresh succeeds.
    heldStates[0].reject(new Error('network down'));
    await flush();
    assert.equal(input1.disabled, true, 'DM input stays disabled after failed directory load');
    assert.equal(send1.disabled, true, 'DM send stays disabled after failed directory load');
    await win1.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    assert.equal(f1.calls.filter((c) => c.method === 'POST' && c.path === '/api/clusters/c1/messages').length, 0,
      'no private DM POST after failed directory load');

    // Clicking Refresh starts a new directory GET; if SSE delivers gen 2 before that GET resolves with stale gen 1,
    // the late stale snapshot must NOT overwrite gen 2.
    win1.find((n) => n.tag === 'button' && n.textContent === '刷新')[0].fire('click');
    await flush();
    assert.equal(heldStates.length, 2, 'manual Refresh issues a fresh directory GET');
    f1.emit({ kind: 'member', payload: { member: { id: 'm', clusterId: 'c1', name: 'Ann', harness: 'claude', bindingGen: 2 } } });
    await flush();
    // Now resolve the older directory GET with stale bindingGen: 1.
    heldStates[1].resolve({
      clusters: [{ id: 'c1', name: 'Cluster 1' }],
      members: [{ id: 'm', clusterId: 'c1', name: 'Ann', harness: 'claude', bindingGen: 1 }],
    });
    await flush();

    assert.equal(input1.disabled, false);
    assert.equal(send1.disabled, false);
    await win1.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();
    const posts1 = f1.calls.filter((c) => c.method === 'POST' && c.path === '/api/clusters/c1/messages');
    assert.equal(posts1.length, 1);
    assert.deepEqual(posts1[0].body, {
      body: 'must not send without gen',
      to: ['m'],
      private: true,
      expectedBindingGen: 2,
    }, 'late stale snapshot must not regress bindingGen below SSE-observed gen 2');
    w1.closeAll();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});

test('manager: BINDING_CHANGED refreshes directory without SSE, blocks confirm until new bindingGen arrives, and ignores out-of-order old snapshots', async () => {
  const doc = new FakeDoc();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    let serverGen = 1;
    let stateGetCount = 0;
    const heldRefresh: Array<(v: unknown) => void> = [];
    const f = fakeContext((method, path, body: any) => {
      if (path.startsWith('/api/state')) {
        stateGetCount++;
        if (stateGetCount === 1) {
          return {
            clusters: [{ id: 'c1', name: 'Cluster 1' }],
            members: [{ id: 'm', clusterId: 'c1', name: 'Ann', harness: 'claude', bindingGen: 1 }],
          };
        }
        return new Promise((resolve) => { heldRefresh.push(resolve); });
      }
      if (method === 'GET' && path.includes('privateWith=m')) return [];
      if (method === 'GET' && path.includes('/transcript')) return ok([]);
      if (method === 'POST' && path === '/api/clusters/c1/messages') {
        if (body.expectedBindingGen !== serverGen) {
          throw Object.assign(new Error('member binding changed'), { data: { code: 'BINDING_CHANGED' } });
        }
        return {
          id: `dm-${body.expectedBindingGen}`,
          clusterId: 'c1',
          from: 'user',
          privateTo: 'm',
          privateBindingGen: serverGen,
          body: body.body,
          deliveries: [{ id: 'd-ok', messageId: `dm-${body.expectedBindingGen}`, state: 'queued' }],
        };
      }
      return {};
    });

    const root = new FakeNode('div', doc);
    const windows = W.createWindows({ root, ctx: f.ctx });
    windows.open({ kind: 'member', clusterId: 'c1', memberId: 'm' });
    await flush();
    assert.equal(stateGetCount, 1);

    const win = root.children[0].children[0];
    const input = win.find((n) => n.tag === 'textarea')[0];
    const sendBtn = win.find((n) => n.tag === 'button' && n.classes.has('smw-send'))[0];
    const confirmBtn = win.find((n) => n.tag === 'button' && n.classes.has('smw-rebind-ok'))[0];

    // Write draft on bindingGen 1, then rebind on server to gen 2 WITHOUT emitting any SSE event.
    input.value = 'draft before silent rebind';
    input.fire('input');
    serverGen = 2;

    await win.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();

    // Must have rejected with BINDING_CHANGED, preserved draft, triggered a real second directory GET, and disabled Confirm until new gen arrives.
    assert.equal(stateGetCount, 2, 'BINDING_CHANGED must trigger a real directory refresh GET even after loaded=true');
    assert.equal(input.value, 'draft before silent rebind', 'draft preserved after rejection');
    assert.equal(sendBtn.disabled, true, 'send locked after rejection');
    assert.equal(confirmBtn.disabled, true, 'confirm button disabled while refresh has not observed a newer bindingGen');
    confirmBtn.fire('click');
    assert.equal(sendBtn.disabled, true, 'clicking confirm while disabled does not unlock send');

    // Trigger another refresh (GET #3) that resolves FIRST with bindingGen 2, while GET #2 resolves LATER with stale bindingGen 1.
    win.find((n) => n.tag === 'button' && n.textContent === '刷新')[0].fire('click');
    await flush();
    assert.equal(stateGetCount, 3);
    assert.equal(heldRefresh.length, 2);

    heldRefresh[1]({
      clusters: [{ id: 'c1', name: 'Cluster 1' }],
      members: [{ id: 'm', clusterId: 'c1', name: 'Ann', harness: 'claude', bindingGen: 2 }],
    });
    await flush();
    assert.equal(confirmBtn.disabled, false, 'confirm unlocks as soon as newer bindingGen 2 arrives without SSE');

    // Late resolution of older GET #2 with stale bindingGen 1 must NOT overwrite bindingGen 2 or re-lock confirm.
    heldRefresh[0]({
      clusters: [{ id: 'c1', name: 'Cluster 1' }],
      members: [{ id: 'm', clusterId: 'c1', name: 'Ann', harness: 'claude', bindingGen: 1 }],
    });
    await flush();
    assert.equal(confirmBtn.disabled, false, 'stale snapshot must not overwrite newer bindingGen 2');
    assert.equal(input.value, 'draft before silent rebind', 'draft still preserved');

    // Now user explicitly confirms and submits to bindingGen 2 (still with zero SSE events).
    confirmBtn.fire('click');
    assert.equal(sendBtn.disabled, false);
    await win.find((n) => n.tag === 'form')[0].fire('submit');
    await flush();

    const posts = f.calls.filter((c) => c.method === 'POST' && c.path === '/api/clusters/c1/messages');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].body, { body: 'draft before silent rebind', to: ['m'], private: true, expectedBindingGen: 1 });
    assert.deepEqual(posts[1].body, { body: 'draft before silent rebind', to: ['m'], private: true, expectedBindingGen: 2 });
    assert.equal(input.value, '', 'draft cleared after confirmed send succeeds');
    windows.closeAll();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});
