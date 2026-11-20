// The page side of plugin commands (src/web/public/plugin-commands.js, docs/external-plugins.md「命令」) in a fake DOM: the
// "/" menu at the start of the composer, the parameter form per type, the run chip, the notices, and runs kept per cluster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseDuration as hubParseDuration } from '../src/core/external-plugin-commands.ts';
import * as hubArgs from '../src/core/command-args.js';
import { rawFetch, startTestHub } from './helpers.ts';
import { REPO_ROOT } from '../src/main.ts';

class FakeElement {
  readonly children: (FakeElement | string)[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, ((e: any) => void)[]>();
  readonly tagName: string;
  parent: FakeElement | null = null;
  hidden = false;
  open = false;
  disabled = false;
  checked = false;
  type = '';
  textContent_: string | null = null;
  private value_: string | null = null;
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value);
    if (name === 'value') this.value_ = String(value);
    if (name === 'type') this.type = String(value);
    if (name === 'checked') this.checked = true;
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
  }
  get value(): string {
    if (this.value_ !== null || this.tagName !== 'SELECT') return this.value_ ?? '';
    const options = this.children.filter((c): c is FakeElement => c instanceof FakeElement);
    return (options.find((o) => 'selected' in o.attributes) ?? options[0])?.attributes.value ?? '';
  }
  set value(v: string) { this.value_ = v; }
  get textContent(): string { return this.textContent_ ?? this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(v: string) { this.textContent_ = v; this.children.length = 0; }
  append(...items: (FakeElement | string)[]) { for (const i of items) { if (i instanceof FakeElement) i.parent = this; this.children.push(i); } }
  replaceChildren(...items: (FakeElement | string)[]) { this.children.length = 0; this.textContent_ = null; this.append(...items); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  addEventListener(name: string, listener: (e: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  fire(name: string, event: any = {}) { for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {}, stopPropagation() {}, target: this, ...event }); }
  focus() { (globalThis as any).document.activeElement = this; }
  contains(e: unknown) { return e === this || this.all().includes(e as FakeElement); }
  /** Every descendant (elements only), depth first. */
  all(): FakeElement[] { return this.children.flatMap((c) => (c instanceof FakeElement ? [c, ...c.all()] : [])); }
  find(pred: (e: FakeElement) => boolean): FakeElement | undefined { return this.all().find(pred); }
  cls(name: string) { return this.find((e) => (e.attributes.class ?? '').split(' ').includes(name)); }
}
class FakeInput extends FakeElement {
  selectionStart = 0;
  selectionEnd = 0;
  constructor() { super('textarea'); }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  dispatchEvent(event: { type: string }) { this.fire(event.type, event); }
  type_(text: string) {
    this.value = this.value.slice(0, this.selectionStart) + text + this.value.slice(this.selectionEnd);
    this.selectionStart = this.selectionEnd = this.selectionStart + text.length;
    this.fire('input');
  }
}
(globalThis as any).document ??= { createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag), activeElement: null };
(globalThis as any).Event ??= class { type: string; constructor(type: string) { this.type = type; } };
const pc = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'plugin-commands.js')).href);
const pageArgs = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'command-args.js')).href);
const PUB = join(REPO_ROOT, 'src', 'web', 'public');

const key = (k: string, extra: object = {}) => ({ key: k, preventDefault() {}, stopPropagation() {}, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
const COMMANDS = [
  { pluginId: 'demo', pluginName: '计时插件', id: 'start', title: '开始计时', description: '开始一个环节', params: [] },
  { pluginId: 'demo', pluginName: '计时插件', id: 'stop', title: '结束计时', description: '', params: [] },
  { pluginId: 'other', pluginName: 'Greeter', id: 'greet', title: '打招呼', description: '', params: [] },
];
const options = (menu: FakeElement) => menu.children.filter((c): c is FakeElement => c instanceof FakeElement && c.attributes.role === 'option');

test('the "/" menu: only at the very start, filters, has a footer, Esc keeps the text, no match sends, a pick clears and opens', () => {
  const input = new FakeInput();
  const menu = new FakeElement('ul');
  menu.hidden = true;
  const picked: any[] = [];
  const keys = pc.attachCommands(input, menu, () => COMMANDS, (c: any) => picked.push(c));
  input.focus();
  input.type_('看 /');
  assert.equal(menu.hidden, true, 'a "/" after other text is just text');
  input.value = ''; input.setSelectionRange(0, 0);
  input.type_('/');
  assert.equal(menu.hidden, false);
  assert.equal(options(menu).length, 3);
  assert.match((menu.children.at(-1) as FakeElement).textContent, /不会发到群聊/, 'the footer says commands are not sent');
  assert.match((menu.children.at(-1) as FakeElement).textContent, /上下键选中或输入完整的命令名.*Enter 照常把文字发到群聊/, 'and when Enter runs one');
  assert.equal((menu.children.at(-1) as FakeElement).attributes.role, 'presentation');
  input.type_('计时');
  assert.deepEqual(options(menu).map((o) => o.textContent.slice(0, 4)), ['开始计时', '结束计时'], 'filtered by title or plugin name');
  input.value = '/gree'; input.setSelectionRange(5, 5); input.fire('input');
  assert.deepEqual(options(menu).map((o) => o.textContent.slice(0, 3)), ['打招呼'], 'or by id');

  assert.equal(keys(key('Escape')), true);
  assert.equal(menu.hidden, true);
  assert.equal(input.value, '/gree', 'Esc keeps the text');
  assert.equal(keys(key('Enter')), false, 'the menu is closed: Enter is the composer\'s again (it sends)');

  input.value = '/nothing'; input.setSelectionRange(8, 8); input.fire('input');
  assert.equal(menu.hidden, true, 'no match: no menu');
  assert.equal(keys(key('Enter')), false, 'so Enter sends "/nothing" as a message');
  assert.equal(input.value, '/nothing');

  // A partly typed name with nothing chosen: Enter is the composer's (the text is sent as a message), not a command.
  input.value = '/sto please'; input.setSelectionRange(4, 4); input.fire('input');
  assert.deepEqual(options(menu).map((o) => o.textContent.slice(0, 4)), ['结束计时']);
  assert.equal(keys(key('Enter')), false, 'not chosen, not exact: Enter sends');
  assert.equal(menu.hidden, true);
  assert.equal(picked.length, 0);
  assert.equal(input.value, '/sto please', 'and the text is untouched');

  // The exact id (or title, any case): Enter runs it; the "/stop" goes, the rest of the text stays in the composer.
  input.value = '/STOP please'; input.setSelectionRange(5, 5); input.fire('input');
  assert.equal(keys(key('Enter')), true);
  assert.deepEqual(picked.map((c) => c.id), ['stop']);
  assert.equal(input.value, 'please', 'the leftover text stays, not sent and not lost');
  input.value = '/开始计时'; input.setSelectionRange(5, 5); input.fire('input');
  assert.equal(keys(key('Enter')), true);
  assert.deepEqual(picked.map((c) => c.id), ['stop', 'start'], 'an exact title');

  // Chosen with the arrow keys: Enter runs that one.
  input.value = '/计时'; input.setSelectionRange(3, 3); input.fire('input');
  keys(key('ArrowDown'));
  assert.equal(keys(key('Enter')), true);
  assert.deepEqual(picked.map((c) => c.id), ['stop', 'start', 'stop']);

  // Tab picks the highlighted row, chosen or not; a click picks too.
  input.value = '/'; input.setSelectionRange(1, 1); input.fire('input');
  assert.equal(keys(key('Tab')), true);
  assert.equal(picked.at(-1).id, 'start');
  input.value = '/'; input.setSelectionRange(1, 1); input.fire('input');
  options(menu)[2]!.fire('mousedown');
  assert.equal(picked.at(-1).id, 'greet');
  assert.equal(input.value, '');
});

test('the "/" menu: a list reload between the arrow choice and Enter keeps the choice on its command', () => {
  const input = new FakeInput();
  const menu = new FakeElement('ul');
  menu.hidden = true;
  let list = COMMANDS;
  const picked: string[] = [];
  const keys = pc.attachCommands(input, menu, () => list, (c: any) => picked.push(`${c.pluginId}/${c.id}`));
  input.focus();
  input.type_('/');
  keys(key('ArrowDown'));   // 结束计时
  list = [COMMANDS[2], { ...COMMANDS[0] }, { ...COMMANDS[1], title: '结束计时（新）' }];   // reloaded, in another order
  keys.refresh();
  assert.equal(options(menu)[2]!.attributes['aria-selected'], 'true', 'the highlight followed its command');
  assert.equal(keys(key('Enter')), true);
  assert.deepEqual(picked, ['demo/stop']);

  list = COMMANDS;
  input.value = '/'; input.setSelectionRange(1, 1); input.fire('input');
  keys(key('ArrowDown'));   // 结束计时 again
  list = [COMMANDS[0], COMMANDS[2]];   // the chosen command is gone after the reload
  keys.refresh();
  assert.equal(keys(key('Enter')), false, 'no choice any more and no exact name: Enter sends');
  assert.deepEqual(picked, ['demo/stop']);

  list = COMMANDS;
  input.value = '/'; input.setSelectionRange(1, 1); input.fire('input');
  keys(key('ArrowDown'));
  input.type_('计');   // typing more is a new query: the old choice no longer counts
  assert.equal(keys(key('Enter')), false);
});

const PARAMS = [
  { name: 'topic', type: 'text', label: '主题', required: true },
  { name: 'rounds', type: 'number', label: '轮数', required: false, min: 1, max: 5, default: 2 },
  { name: 'length', type: 'duration', label: '时长', required: false, default: 900, min: 60, max: 7200 },
  { name: 'strict', type: 'boolean', label: '严格', required: false, default: true },
  { name: 'host', type: 'member', label: '主持人', required: true },
  { name: 'tone', type: 'enum', label: '语气', required: false, options: ['calm', 'fast'] },
  { name: 'pace', type: 'enum', label: '节奏', required: false, options: ['slow', 'fast'], default: 'slow' },
];

test('arguments on the page: each type as the Hub checks it; empty optional ones are left for the Hub default', () => {
  const members = new Set(['m1']);
  const read = (raw: Record<string, unknown>) => pc.readArguments(PARAMS, raw, members);
  assert.deepEqual(read({ topic: 'x', rounds: '', length: '', strict: false, host: 'm1', tone: '' }),
    { values: { topic: 'x', strict: false, host: 'm1' }, errors: {} });
  assert.deepEqual(read({ topic: 'x', rounds: '3', length: '1h30m', strict: true, host: 'm1', tone: 'fast' }).values,
    { topic: 'x', rounds: 3, length: 5400, strict: true, host: 'm1', tone: 'fast' });
  const errors = read({ topic: ' ', rounds: '9', length: '30s', strict: true, host: 'm2', tone: 'loud' }).errors;
  assert.deepEqual(Object.keys(errors), ['topic', 'rounds', 'length', 'host', 'tone']);
  assert.match(errors.topic, /请填写「主题」/);
  assert.match(errors.rounds, /1 到 5/);
  assert.match(errors.length, /1 分钟到 2 小时/);
  assert.match(errors.host, /本群的成员/);
  assert.match(read({ topic: 'x', length: 'soon', host: 'm1' }).errors.length, /15m/);
  assert.match(read({ topic: 'x', length: '1h30', host: 'm1' }).errors.length, /1h30 请写成 1h30m/, 'a bare number after a unit');
  assert.deepEqual(read({ topic: 'x', length: '90', host: 'm1' }).values.length, 90, 'a number alone is seconds');
  // One copy of the rules: the page's module is the Hub's own file, re-exported.
  assert.equal(pageArgs.parseDuration, hubParseDuration);
  assert.equal(pageArgs.checkArgument, hubArgs.checkArgument);
  assert.deepEqual([900, 5400, 90, 3600, 0].map(pc.formatDuration), ['15m', '1h30m', '1m30s', '1h', '0s']);
});

test('arguments on the page: params named after Object.prototype members read and report as own fields', () => {
  const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];
  const params = names.map((name, i) => ({ name, type: 'number', label: name, required: i === 3, default: i === 3 ? undefined : i }));
  const empty = pc.readArguments(params, {}, new Set());
  assert.deepEqual(empty.values, {}, 'empty optional fields are left for the Hub default, never the inherited functions');
  assert.deepEqual(Object.keys(empty.errors), ['hasOwnProperty']);
  const given = pc.readArguments(params, Object.fromEntries(names.map((n, i) => [n, String(i + 5)])), new Set());
  assert.deepEqual<unknown>([given.values, given.errors], [{ constructor: 5, toString: 6, valueOf: 7, hasOwnProperty: 8 }, {}]);
  const form = pc.commandForm({ title: 'T', pluginName: 'P', params }, { members: [], onRun: () => {}, onCancel: () => {} });
  form.showErrors({ hasOwnProperty: 'x' });
  const errors = (form.el as FakeElement).all().filter((e) => e.attributes.class === 'form-error' && !e.hidden);
  assert.deepEqual(errors.map((e) => e.textContent), ['x'], 'only the field named in the errors, not every name an object inherits');
});

test('the parameter form: built from the params, defaults filled, errors next to the field, Enter runs, Esc cancels', async () => {
  const runs: any[] = [];
  let cancelled = 0;
  let answer: () => Promise<void> = async () => {};
  const form = pc.commandForm({ title: '开始环节', pluginName: '计时插件', description: '开始一个计时环节', params: PARAMS }, {
    members: [{ id: 'm1', name: 'Alice' }, { id: 'm2', name: 'Bob' }],
    onRun: (values: unknown) => { runs.push(values); return answer(); },
    onCancel: () => { cancelled++; },
  });
  const el = form.el as FakeElement;
  assert.equal(el.tagName, 'DIV', 'not a nested <form>: its submit would send the composer');
  assert.equal(el.attributes.role, 'dialog');
  const control = (name: string) => el.find((e) => e.attributes.id?.endsWith(`-${name}`) && ['INPUT', 'SELECT'].includes(e.tagName))!;
  assert.deepEqual(PARAMS.map((p) => [control(p.name).tagName, control(p.name).type]),
    [['INPUT', 'text'], ['INPUT', 'number'], ['INPUT', 'text'], ['INPUT', 'checkbox'], ['SELECT', ''], ['SELECT', ''], ['SELECT', '']]);
  assert.deepEqual([control('rounds').value, control('length').value, control('strict').checked], ['2', '15m', true], 'defaults');
  assert.deepEqual(control('host').children.map((o) => (o as FakeElement).textContent), ['请选择', 'Alice', 'Bob'], 'members by name');
  assert.deepEqual(control('tone').children.map((o) => (o as FakeElement).textContent), ['（不选）', 'calm', 'fast'], 'no default: an empty choice');
  assert.deepEqual([control('pace').children.map((o) => (o as FakeElement).textContent), control('pace').value], [['slow（默认）', 'fast'], 'slow'],
    'a default: no empty choice that would silently mean the default; it is preselected and marked');
  assert.match(el.textContent, /（必填）/);
  assert.match(el.textContent, /不会发到群聊/);
  const buttons = el.all().filter((e) => e.tagName === 'BUTTON');
  assert.deepEqual(buttons.map((b) => [b.textContent, b.type, b.attributes.class ?? '']), [['取消', 'button', ''], ['运行', 'button', 'primary']]);

  await form.submit();
  assert.deepEqual(runs, [], 'nothing runs while a field is wrong');
  const error = (name: string) => el.find((e) => e.attributes.id?.endsWith(`-${name}-error`))!;
  assert.deepEqual([error('topic').hidden, error('host').hidden, error('rounds').hidden], [false, false, true]);
  assert.match(error('topic').textContent, /请填写「主题」/);
  assert.equal(control('topic').attributes['aria-invalid'], 'true');

  control('topic').value = '复盘';
  control('host').value = 'm2';
  control('length').value = '20m';
  // Enter with a modifier in a field does nothing (and keeps any browser default from running); plain Enter runs.
  for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) el.fire('keydown', key('Enter', { target: control('topic'), [mod]: true }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, [], 'Shift/Ctrl/Alt/Meta+Enter run nothing');
  el.fire('keydown', key('Enter', { target: control('topic') }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, [{ topic: '复盘', rounds: 2, length: 1200, strict: true, host: 'm2', pace: 'slow' }]);
  assert.equal(error('topic').hidden, true);

  form.showErrors({ host: '「主持人」须是本群的成员。' });   // a refusal the Hub names a field for
  assert.equal(error('host').hidden, false);
  form.setError('插件没有在运行。');
  assert.ok(el.all().some((e) => e.attributes.class === 'form-error' && !e.hidden && e.textContent === '插件没有在运行。'));

  let release!: () => void;
  answer = () => new Promise<void>((r) => { release = r; });
  const pending = form.submit();
  assert.equal(buttons[1].disabled, true, 'busy while the run is asked for');
  await form.submit();
  assert.equal(runs.length, 2, 'a second Enter does not run it twice');
  release();
  await pending;
  assert.equal(buttons[1].disabled, false);

  el.fire('keydown', key('Escape'));
  buttons[0].fire('click');
  assert.equal(cancelled, 2);
});

test('form keys: every Enter in a field is kept from the browser; only plain Enter runs', () => {
  const press = (extra: object) => {
    let prevented = false, submitted = 0, cancelled = 0;
    const e = { ...key('Enter'), target: { tagName: 'INPUT' }, ...extra, preventDefault() { prevented = true; } };
    const did = pc.formKey(e, { submit: () => submitted++, cancel: () => cancelled++ });
    return [did, prevented, submitted, cancelled];
  };
  assert.deepEqual(press({}), ['submit', true, 1, 0]);
  for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) assert.deepEqual(press({ [mod]: true }), ['blocked', true, 0, 0], mod);
  assert.deepEqual(press({ isComposing: true }), ['none', false, 0, 0], 'an IME choosing a word');
  assert.deepEqual(press({ key: 'Escape', isComposing: true }), ['none', false, 0, 0], 'an IME cancels composition, not the form');
  assert.deepEqual(press({ target: { tagName: 'BUTTON' } }), ['none', false, 0, 0], 'a button keeps its own Enter');
  assert.deepEqual(press({ key: 'Escape' }), ['cancel', true, 0, 1]);
  assert.deepEqual(press({ key: 'a' }), ['none', false, 0, 0]);
});

test('the form is mounted outside the chat <form>, and the chat form does not submit from inside it', () => {
  const chat = new FakeElement('main'), slot = new FakeElement('div'), composer = new FakeElement('form'), textarea = new FakeElement('textarea');
  composer.append(textarea);
  chat.append(slot, composer);
  const form = pc.commandForm({ title: 'T', pluginName: 'P', params: PARAMS }, { members: [], onRun: () => {}, onCancel: () => {} });
  pc.mountCommandForm(slot, form.el);
  const ancestors = (e: FakeElement | null): FakeElement[] => (e ? [e, ...ancestors(e.parent)] : []);
  assert.ok(!ancestors(form.el).includes(composer), 'not a descendant of the chat <form>');
  assert.equal(slot.hidden, false);
  const field = (form.el as FakeElement).find((e) => e.tagName === 'INPUT')!;
  assert.equal(pc.chatSubmitAllowed(form.el, field), false, 'focus in the command form: the chat form does not send');
  assert.equal(pc.chatSubmitAllowed(form.el, textarea), true);
  assert.equal(pc.chatSubmitAllowed(undefined, textarea), true);
  pc.unmountCommandForm(slot);
  assert.deepEqual([slot.children.length, slot.hidden], [0, true]);

  // In the page itself: the slot is a sibling before the composer's <form>, and app.js mounts there and guards submit.
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  const at = html.indexOf('id="command-form-slot"'), form0 = html.indexOf('<form id="composer"');
  assert.ok(at > 0 && at < form0 && !html.slice(at, form0).includes('<form'), 'the slot is outside the composer form');
  const app = readFileSync(join(PUB, 'app.js'), 'utf8');
  assert.match(app, /mountCommandForm\(\$\('command-form-slot'\), form\.el\)/);
  assert.doesNotMatch(app, /parentElement\.append\(form\.el\)/);
  assert.match(app, /if \(!chatSubmitAllowed\(openForm\?\.form\.el, document\.activeElement\)\) return;/);
});

test('the argument rules are served to the page as the Hub\'s own file', async () => {
  const app = await startTestHub();
  try {
    const res = await rawFetch(`${app.url}/core/command-args.js`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), readFileSync(join(REPO_ROOT, 'src', 'core', 'command-args.js'), 'utf8'));
    assert.equal((await rawFetch(`${app.url}/core/command-args.d.ts`)).status, 404);
  } finally { await app.close(); }
});

test('runs per cluster: one notice per run whichever source tells first; no step back, no revival; other clusters see nothing', () => {
  const timers: (() => void)[] = [];
  let changed = 0;
  const state = pc.createCommandState({ setTimer: (fn: () => void) => timers.push(fn), onChange: () => changed++ });
  const base = { runId: 'r1', clusterId: 'A', pluginId: 'p', pluginName: '计时插件', command: 'c', title: '开始计时', startedAt: '2026-11-17T01:00:00Z',
    endedAt: null, progress: null, fraction: null, text: null, reason: null };
  state.apply({ ...base, state: 'running', progress: '第 1 步' });
  state.apply({ ...base, state: 'starting' });
  assert.deepEqual(state.active('A').map((r: any) => [r.state, r.progress]), [['running', '第 1 步']], 'an older frame from the other connection');
  const snapshot = state.mark();
  state.apply({ ...base, state: 'running', progress: '第 2 步', fraction: 0.8 });
  state.replace('A', [{ ...base, state: 'running', progress: '第 1 步', fraction: 0.1 }], snapshot);
  state.apply({ ...base, state: 'running', progress: '第 1 步', fraction: 0.1 }, false, snapshot);
  assert.deepEqual(state.active('A').map((r: any) => [r.progress, r.fraction]), [['第 2 步', 0.8]], 'older listing and HTTP snapshots preserve newer SSE progress');
  state.apply({ ...base, state: 'cancelling', progress: '第 2 步', fraction: 0.8 }, false, snapshot);
  assert.equal(state.active('A')[0].state, 'cancelling', 'a newer state still advances even when a progress frame arrived first');
  assert.deepEqual(state.active('B'), [], 'a run of A never shows in B');
  state.apply({ ...base, state: 'succeeded', text: '完成了' }, false, snapshot);
  state.apply({ ...base, state: 'running' });
  state.apply({ ...base, state: 'succeeded', text: '完成了' });
  assert.deepEqual(state.active('A'), []);
  assert.deepEqual(state.notices('B'), [], 'the notice belongs to A');
  const [notice] = state.notices('A');
  assert.deepEqual([notice.kind, notice.title, notice.text, state.notices('A').length], ['ok', '「开始计时」已完成', '完成了', 1]);
  assert.equal(timers.length, 1, 'a success notice is dismissed later, counted from when it was shown');
  timers[0]();
  assert.equal(changed, 1);
  assert.deepEqual(state.notices('A'), []);

  state.apply({ ...base, runId: 'r2', state: 'failed', reason: 'timeout', text: '命令运行超过 30 分钟' });
  state.apply({ ...base, runId: 'r3', clusterId: 'B', state: 'failed', text: null });
  assert.equal(timers.length, 1, 'not shown yet: no timer');
  assert.deepEqual(state.notices('A').map((n: any) => [n.kind, n.text]), [['failed', '命令运行超过 30 分钟']]);
  assert.equal(timers.length, 1, 'a failure stays until closed');
  assert.deepEqual(state.notices('B').map((n: any) => n.text), ['命令没有完成。'], 'B\'s notice waits for B');
  state.dismiss(state.notices('A')[0].key);
  assert.deepEqual(state.notices('A'), []);

  state.apply({ ...base, runId: 'r4', state: 'running' });
  state.apply({ ...base, runId: 'r5', state: 'running', clusterId: 'B' });
  // A listing asked for before r6 started lands after r6's frame: r6 is newer than the listing and stays.
  const asked = state.mark();
  state.apply({ ...base, runId: 'r6', state: 'starting' });
  state.replace('A', [{ ...base, runId: 'r4', state: 'running' }], asked);
  assert.deepEqual(state.active('A').map((r: any) => r.runId).sort(), ['r4', 'r6'], 'the just-started run keeps its chip');
  const beforeAnswer = state.mark();
  state.apply({ ...base, runId: 'r7', state: 'running' }, false, state.mark());
  state.replace('A', [{ ...base, runId: 'r4', state: 'running' }, { ...base, runId: 'r6', state: 'starting' }], beforeAnswer);
  assert.ok(state.active('A').some((r: any) => r.runId === 'r7'), 'a new run accepted by HTTP is newer than an earlier listing');
  state.replace('A', [], state.mark());
  assert.deepEqual(state.active('A'), [], 'gone from a listing asked for after it: dropped without a notice');
  assert.deepEqual(state.active('B').map((r: any) => r.runId), ['r5'], 'another cluster untouched');
  state.local('A', 'failed', '「开始计时」没有运行', '插件没有在运行。');
  assert.deepEqual(state.notices('A').map((n: any) => n.text), ['插件没有在运行。']);
  for (const bad of [null, {}, { runId: 5 }]) state.apply(bad);
});

test('the run chip and the notices', () => {
  const details = new FakeElement('details'), summary = new FakeElement('summary'), panel = new FakeElement('div');
  const cancelled: string[] = [];
  const els = { details, summary, panel };
  pc.drawRuns(els, [], { onCancel: () => {} });
  assert.equal(details.hidden, true);
  const run = (runId: string, state: string, progress: string | null) => ({ runId, clusterId: 'A', pluginName: '计时插件', title: `环节${runId}`, state, progress,
    fraction: progress ? 0.5 : null, startedAt: runId });
  pc.drawRuns(els, [run('1', 'starting', null), run('2', 'running', '还剩 5 分钟')], { onCancel: (r: any) => cancelled.push(r.runId) });
  assert.equal(details.hidden, false);
  assert.match(summary.textContent, /^环节2 · 还剩 5 分钟\+1$/, 'the newest run, its progress, and how many more');
  assert.equal(summary.cls('plugin-run-text')!.textContent, '环节2 · 还剩 5 分钟', 'the part that truncates');
  const buttons = panel.all().filter((e) => e.tagName === 'BUTTON');
  assert.deepEqual(buttons.map((b) => [b.textContent, b.disabled]), [['取消', true], ['取消', false]], 'a starting run cannot be cancelled yet');
  buttons[1].fire('click');
  assert.deepEqual(cancelled, ['2']);
  assert.equal(panel.find((e) => e.attributes.role === 'progressbar')!.attributes['aria-valuenow'], '50');
  const run2Btn = buttons[1];
  pc.drawRuns(els, [run('1', 'running', '第 1 步'), run('2', 'running', '还剩 4 分钟')], { onCancel: (r: any) => cancelled.push(r.runId) });
  assert.equal(panel.all().filter((e) => e.tagName === 'BUTTON')[1], run2Btn, 'progress updates keep the existing cancel button element');
  pc.drawRuns(els, [run('3', 'cancelling', null)], { onCancel: () => {} });
  assert.match(summary.textContent, /环节3 · 正在取消/);

  const box = new FakeElement('div');
  const dismissed: number[] = [];
  pc.drawNotices(box, [{ key: 1, kind: 'ok', title: '「a」已完成', text: '好了', pluginName: 'P' }, { key: 2, kind: 'failed', title: '「b」失败', text: 'x\ny', pluginName: '' }],
    (k: number) => dismissed.push(k));
  const [ok, failed] = box.children as FakeElement[];
  assert.deepEqual([ok.attributes.class, ok.attributes.role, failed.attributes.class, failed.attributes.role],
    ['run-notice ok', 'status', 'run-notice failed', 'alert']);
  assert.equal(failed.cls('run-notice-text')!.textContent, 'x\ny', 'the plugin\'s text as text');
  failed.find((e) => e.tagName === 'BUTTON')!.fire('click');
  assert.deepEqual(dismissed, [2]);
});
