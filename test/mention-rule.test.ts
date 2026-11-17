// @-mentions match full member names only (docs/collaboration.md「点名规则」): the Hub's rule (core/hub.ts mentionAt),
// the page's copy (ui.js), the three ways a message is sent (user, member, plugin) and the hints for near misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { mentionAt, mentionHints, nameEnds } from '../src/core/hub.ts';
import { REPO_ROOT } from '../src/main.ts';
import { startTestHub, tempDir } from './helpers.ts';

class FakeElement {
  readonly children: (FakeElement | string)[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, ((e: any) => void)[]>();
  hidden = false;
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  append(...items: (FakeElement | string)[]) { this.children.push(...items); }
  replaceChildren(...items: (FakeElement | string)[]) { this.children.splice(0, this.children.length, ...items); }
  addEventListener(name: string, listener: (e: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  fire(name: string, event: any = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
}
class FakeInput extends FakeElement {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  constructor() { super('textarea'); }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  focus() { (globalThis as any).document.activeElement = this; }
  dispatchEvent(event: { type: string }) { this.fire(event.type, event); }
  type(text: string) {
    this.value = this.value.slice(0, this.selectionStart) + text + this.value.slice(this.selectionEnd);
    this.selectionStart = this.selectionEnd = this.selectionStart + text.length;
    this.fire('input');
  }
}
(globalThis as any).document ??= { createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag), activeElement: null };
const ui = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js')).href);

const NAMES = ['张三', '张三丰', 'worker-2', 'worker-2.1-east', 'reader', 'A', 'A.', 'all'];

/** [text, the name its first @ mentions or null]. */
const TABLE: [string, string | null][] = [
  ['@张三丰', '张三丰'], ['@张三', '张三'], ['@张', null],
  ['@张三你好', null], ['@张三丰你好', null], ['@张三 你好', '张三'], ['@张三，你好', '张三'], ['@张三。', '张三'],
  ['请看 @张三', '张三'], ['@张三\n下一行', '张三'], ['@张三😀', '张三'], ['@张三𠀀', null],
  ['@worker-2.1-east', 'worker-2.1-east'], ['@worker-2', 'worker-2'], ['@worker-2.', 'worker-2'], ['@worker-2. 好', 'worker-2'], ['@worker-2x', null],
  ['@worker-2.1', null], ['@worker-2.-x', null], ['@worker-2-', 'worker-2'], ['@worker-2_ hi', 'worker-2'], ['@worker-2__x', null],
  ['@reader请看', null], ['@reader 请看', 'reader'], ['@readeré', null], ['@readeŕ', null], ['@reader١', null], ['(@reader)', 'reader'],
  ['@A. hi', 'A.'], ['@A.', 'A.'], ['@A.b', null], ['@A..', 'A.'],
  ['@all', 'all'], ['@all，看', 'all'], ['@all你好', null], ['@all.v2', null],
];

/** A deterministic shuffle (mulberry32), so a failure names the order that broke. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

test('mention rule: the Hub and the page give the same answer for every example, in any member order', () => {
  const orders = [NAMES, [...NAMES].reverse(), ...Array.from({ length: 30 }, (_, seed) => shuffled(NAMES, seed + 1))];
  for (const [text, expected] of TABLE) {
    const at = text.indexOf('@');
    for (const names of orders) {
      assert.equal(mentionAt(text, at, names), expected, `Hub: ${text} with ${names.join(',')}`);
      assert.equal(ui.mentionAt(text, at, names), expected, `page: ${text} with ${names.join(',')}`);
    }
  }
  for (const [text] of TABLE) {
    for (let end = 0; end <= text.length; end++) assert.equal(ui.nameEnds(text, end), nameEnds(text, end), `${text} at ${end}`);
  }
});

test('mention hints: only for an unresolved @-text that starts with a member name, naming the longest such name', () => {
  assert.deepEqual(mentionHints(['张三你好', '张', 'Ghost', '张三丰在吗'], ['张三', '张三丰', 'all']), [
    '没有成员叫「张三你好」；如果你想 @张三，请在名字后面加空格或标点。',
    '没有成员叫「张三丰在吗」；如果你想 @张三丰，请在名字后面加空格或标点。',
  ]);
  assert.deepEqual(mentionHints(['all请看', 'reader请看'], ['reader', 'all']).length, 2);
  assert.deepEqual(mentionHints([], ['张三']), []);
});

/** A cluster of native members named `names` (in that order) plus a sender S, with deliveries paused. */
async function fixture(names: string[]) {
  const dir = tempDir();
  const all = [...names, 'S'];
  const sessions = all.map((_, i) => ({ id: `s${i}`, title: `s${i}`, model: null, cwd: dir, updatedAt: null }));
  const app = await startTestHub({ dir, nativeAdapters: { claude: createMockNativeAdapter({ sessions }) } });
  await app.api('POST', '/api/pause', { paused: true });   // only who it is addressed to matters
  const { cluster, members } = await app.hub.createCluster(`c-${names.join('-')}`, all.map((name, i) =>
    ({ harness: 'claude', mode: 'native' as const, sessionId: sessions[i].id, name })));
  const id = (name: string) => members.find((m) => m.name === name)!.id;
  const sender = id('S');
  const user = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
  const member = (body: string) => app.hub.sendFromMember(sender, body);
  const plugin = (body: string) => app.hub.sendFromExternalPlugin('ext-mentions', cluster.id, body, null, true);
  return { app, cluster, id, user, member, plugin };
}

const HINT = (text: string, name: string) => `没有成员叫「${text}」；如果你想 @${name}，请在名字后面加空格或标点。`;

for (const order of [['张三', '张三丰'], ['张三丰', '张三']]) {
  test(`full names only, ${order[0]} created first: @张三丰 → 张三丰, @张三 → 张三, @张 → nobody, from user, member and plugin`, async () => {
    const f = await fixture(order);
    try {
      const cases: [string, string[]][] = [['@张三丰 看一下', ['张三丰']], ['@张三 看一下', ['张三']], ['@张 看一下', []]];
      for (const [body, names] of cases) {
        const ids = names.map(f.id);
        const user = await f.user(body);
        assert.deepEqual(user.mentions, ids, `user: ${body}`);
        assert.equal(user.mentionHints, undefined, `user: no hint for ${body}`);
        const member = f.member(body);
        assert.deepEqual(member.message.mentions, ids, `member: ${body}`);
        assert.deepEqual(member.deliveredTo, names, `member: ${body}`);
        assert.equal(member.mentionHints, undefined);
        const plugin = f.plugin(body);
        assert.deepEqual(f.app.store.getMessage(plugin.messageId)!.mentions, ids, `plugin: ${body}`);
        assert.deepEqual(plugin.deliveredTo, names, `plugin: ${body}`);
      }
      assert.deepEqual(f.member('@张 看一下').unresolvedMentions, ['张']);
    } finally { await f.app.close(); }
  });
}

test('a name runs into the text after it: @张三你好 reaches nobody and the sender is told how to write it', async () => {
  const f = await fixture(['张三', '张三丰']);
  try {
    const member = f.member('@张三你好');
    assert.deepEqual([member.deliveredTo, member.unresolvedMentions, member.mentionHints], [[], ['张三你好'], [HINT('张三你好', '张三')]]);
    assert.match(member.warning ?? '', /reached no member/, 'nobody addressed: the usual warning too');
    const user = await f.user('@张三你好');
    assert.deepEqual([user.mentions, user.mentionHints], [[], [HINT('张三你好', '张三')]], 'the page gets the same hint');
    assert.deepEqual(f.app.store.getMessage(user.id)!.body, '@张三你好', 'the message is still saved, not re-routed');
    assert.equal((await f.app.api('GET', `/api/clusters/${f.cluster.id}/messages/${user.id}`)).mentionHints, undefined, 'the hint is not stored');
    assert.deepEqual((await f.user('@张三丰你好 @张三 在吗')).mentionHints, [HINT('张三丰你好', '张三丰')], 'longest name in the hint');
    assert.deepEqual(f.plugin('@张三你好').deliveredTo, []);
    for (const body of ['@张三 你好', '@张三，你好', '@张三。', '请看 @张三']) {
      const sent = f.member(body);
      assert.deepEqual([sent.deliveredTo, sent.unresolvedMentions, sent.mentionHints], [['张三'], [], undefined], body);
    }
    // to: names the recipients; the body stays plain text and is not diagnosed.
    const direct = f.member('@张三你好 @张三丰');
    assert.deepEqual(direct.deliveredTo, ['张三丰']);
    const explicit = f.app.hub.sendFromMember(f.id('S'), '@张三你好', undefined, [], undefined, ['张三']);
    assert.deepEqual([explicit.deliveredTo, explicit.unresolvedMentions, explicit.mentionHints], [['张三'], [], undefined]);
    const userTo = await f.app.api('POST', `/api/clusters/${f.cluster.id}/messages`, { body: '@张三你好', to: [f.id('张三丰')] });
    assert.deepEqual([userTo.mentions, userTo.mentionHints], [[f.id('张三丰')], undefined]);
  } finally { await f.app.close(); }
});

test('Latin names with joiners, @all, quoting and foo@bar under the full-name rule', async () => {
  const f = await fixture(['worker-2', 'worker-2.1-east', 'reader']);
  try {
    const to = (body: string) => f.member(body).deliveredTo;
    assert.deepEqual(to('@worker-2.1-east 看看'), ['worker-2.1-east']);
    assert.deepEqual(to('@worker-2 看看'), ['worker-2']);
    assert.deepEqual(to('交给 @worker-2.'), ['worker-2'], 'a sentence-final dot ends the name');
    assert.deepEqual(to('@worker-2x 看看'), []);
    assert.deepEqual(to('@reader请看'), [], 'a Latin name directly followed by CJK');
    assert.deepEqual(f.member('@reader请看').mentionHints, [HINT('reader请看', 'reader')]);
    assert.deepEqual(f.member('@worker-2x').mentionHints, [HINT('worker-2x', 'worker-2')]);
    // @all: same end rule, unchanged broadcast semantics (unread for all, delivered to the explicit names only).
    const all = f.member('@all 注意 @reader 处理');
    assert.deepEqual([all.message.mentions.length, all.deliveredTo], [3, ['reader']]);
    assert.deepEqual(f.member('@all你好').message.mentions, []);
    assert.deepEqual(f.member('@all你好').mentionHints, [HINT('all你好', 'all')]);
    assert.deepEqual((await f.user('@all 大家好')).mentions.length, 4, "the user's @all is everyone");
    // Quotes, code and foo@bar: unchanged.
    const bt = '`';
    assert.deepEqual(to(`${bt}@reader${bt} "@worker-2" “@all” ${bt}${bt}${bt}\n@reader\n${bt}${bt}${bt}`), []);
    assert.deepEqual(to('mail foo@reader'), []);
    assert.deepEqual(f.member('mail foo@reader').unresolvedMentions, []);
  } finally { await f.app.close(); }
});

test('the page highlights exactly the mentions the Hub delivered, for the same bodies', async () => {
  const f = await fixture(['张三', '张三丰', 'worker-2', 'worker-2.1-east']);
  try {
    const members = new Map(['张三', '张三丰', 'worker-2', 'worker-2.1-east'].map((name) => [f.id(name), { id: f.id(name), name }]));
    const bodies = ['@张三丰 和 @张三 看', '@张三你好 @张三丰', '@张 @张三。', '@worker-2.1-east @worker-2. @worker-2x', '@worker-2.1 @worker-2-', '@张三丰你好，@worker-2'];
    for (const body of bodies) {
      const sent = await f.user(body);
      const shown = ui.bodySegments(body, { mentions: sent.mentions, members }).filter((s: any) => s.mention).map((s: any) => s.mention);
      assert.deepEqual([...new Set(shown)].sort(), [...sent.mentions].sort(), body);
      // Even when the page is told every member was mentioned, it highlights only what the Hub's rule matches.
      const every = ui.bodySegments(body, { mentions: [...members.keys()], members }).filter((s: any) => s.mention).map((s: any) => s.mention);
      assert.deepEqual([...new Set(every)].sort(), [...sent.mentions].sort(), `${body} (all candidates)`);
    }
  } finally { await f.app.close(); }
});

test('send_message teaches the end rule, and the Claude bridge and DeepSeek plugin copies say the same', async () => {
  const f = await fixture(['张三']);
  try {
    const { secret } = JSON.parse(readFileSync(join(f.app.home, 'hub.json'), 'utf8'));
    const res = await fetch(`${f.app.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-orrery-bridge': secret, 'x-orrery-harness': 'claude', 'x-orrery-session': 's0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    const tool = ((await res.json()) as any).result.tools.find((t: any) => t.name === 'send_message');
    assert.match(tool.description, /follow it with a space, punctuation or the end of the text/);
    assert.match(tool.description, /`mentionHints`/);
    assert.ok(readFileSync(join(REPO_ROOT, 'src', 'bridge', 'claude-bridge.ts'), 'utf8').includes(JSON.stringify(tool.description)), 'Claude bridge copy');
    const dsh = await import(pathToFileURL(join(REPO_ROOT, 'plugins', 'dsh-orrery', 'lib', 'index.js')).href);
    assert.equal(dsh.TOOLS.find((t: any) => t.name === 'send_message').description, tool.description, 'DeepSeek plugin copy');
  } finally { await f.app.close(); }
});

test('the @ picker inserts the chosen full name followed by a space', () => {
  const input = new FakeInput();
  const menu = new FakeElement('ul');
  menu.hidden = true;
  const keys = ui.attachMentions(input, menu, () => [{ name: '张三', member: null }, { name: '张三丰', member: null }, { name: 'all', member: null }]);
  input.focus();
  input.type('请 @张');
  assert.equal(menu.children.length, 2, 'both names start with 张');
  keys({ key: 'ArrowDown', preventDefault() {}, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  keys({ key: 'Enter', preventDefault() {}, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  assert.equal(input.value, '请 @张三丰 ');
  assert.equal(mentionAt(input.value + '你好', 2, ['张三', '张三丰']), '张三丰', 'typing on after the pick still mentions the name');
});
