// The third-party plugin card's tools part (plugins.js, docs/external-plugins.md「群员工具」), in node against a small fake
// DOM: the names members see, which are granted, the token-cost note, and plugin text only ever as text nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

// A small fake DOM: attributes, children with parents, `[attr]` / `[attr="value"]` selectors, replaceWith, focus.
type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, (event?: any) => void>; parent: El | null;
  value?: string; hidden?: boolean; className?: string;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; addEventListener(k: string, f: (event?: any) => void): void;
  append(...c: (El | string)[]): void; replaceChildren(...c: (El | string)[]): void; replaceWith(n: El): void; contains(x: unknown): boolean;
  querySelector(s: string): El | null; querySelectorAll(s: string): El[]; focus(): void };
const doc: any = {
  activeElement: null,
  createElement: (tag: string): El => {
    const el: El = { tag, attrs: {}, kids: [], on: {}, parent: null,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
      addEventListener(k, f) { this.on[k] = f; },
      append(...c) { for (const kid of c) { if (typeof kid !== 'string') kid.parent = this; this.kids.push(kid); } },
      replaceChildren(...c) { this.kids = []; this.append(...c); },
      replaceWith(n) { const p = this.parent!; p.kids[p.kids.indexOf(this)] = n; n.parent = p; this.parent = null; },
      contains(x) { return all(this).includes(x as El); },
      querySelector(s) { return this.querySelectorAll(s)[0] ?? null; },
      querySelectorAll(s) {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
        return m ? all(this).slice(1).filter((e) => Object.hasOwn(e.attrs, m[1]) && (m[2] === undefined || e.attrs[m[1]] === m[2])) : [];
      },
      focus() { doc.activeElement = this; } };
    return el;
  },
  createElementNS: (_ns: string, tag: string) => doc.createElement(tag),
};
(globalThis as any).document = doc;
const text = (e: El | string): string => (typeof e === 'string' ? e : e.kids.map(text).join(''));
const all = (e: El | string): El[] => (typeof e === 'string' ? [] : [e, ...e.kids.flatMap(all)]);
const plugins = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'plugins.js')).href);
const ui = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js')).href);

test('chat: a record quoting what a member or plugin wrote is shown as plain text, never Markdown (no links)', () => {
  const record = (systemKind: string, from = 'system') => ({ from, kind: from === 'system' ? 'system' : null, systemKind, body: '[click](https://example.invalid)' });
  assert.equal(ui.plainTextRecord(record('plugin_tool_call')), true);
  assert.equal(ui.plainTextRecord(record('plugin_refused')), true, 'the gate reason is plugin text too');
  for (const kind of ['plugin_check_failed', 'plugin_restarted', 'queue_warning']) {
    assert.equal(ui.plainTextRecord(record(kind)), true, `${kind} quotes a plugin's or member's name, or message snippets`);
  }
  for (const kind of ['task', 'delivery_failed', 'hidden_work']) {
    assert.equal(ui.plainTextRecord(record(kind)), false, `${kind} keeps its Markdown (task links)`);
  }
  assert.equal(ui.plainTextRecord(record('plugin_tool_call', 'a-member')), false, 'only system records');
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /legacy \|\| failure \|\| plainTextRecord\(msg\) \? body : mdBlocks\(markdownBlocks\(body\), msg\)/, 'the chat row uses it');
});

const life = { hub: 'run-1', seq: 1, autoRestart: false, devReload: false, autoRestarts: 0, maxAutoRestarts: 3, backoffSeconds: [2, 10, 60],
  windowMinutes: 10, restartAt: null, gaveUp: false, lastFailure: null, shutdownGraceMs: 5000, devReloadError: null };
const plugin = (over: object = {}) => ({ id: 'tool-demo', name: '工具示例', version: '1.0.0', requires: [], description: '', details: '', iconUrl: null,
  enabled: true, disabledByEnv: false, pendingEnabled: true, origin: 'external', permissions: ['tools.provide'], clusterIds: ['one'], commands: [],
  memberTools: [
    { name: 'p_tool-demo_echo', description: 'Echo <b>text</b>', granted: true },
    { name: 'p_tool-demo_slow', description: 'Wait', granted: false },
  ],
  runtime: { state: 'ready', error: null, errorCode: null }, lifecycle: life, ...over });

test('tools card: the names members see, which are granted, the token cost; declared but not permitted says so', () => {
  const view = plugins.pluginToolsView(plugin()) as El;
  const shown = text(view);
  assert.match(shown, /提供给群员的工具（群员看到的名字）/);
  assert.match(shown, /p_tool-demo_echo：Echo <b>text<\/b>p_tool-demo_slow/, 'the description is text, markup and all; granted: no note');
  assert.match(shown, /p_tool-demo_slow：Wait（未授予，不提供）/);
  assert.match(shown, /每次模型调用都要为它付 token/);
  assert.ok(!all(view).some((e) => e.tag === 'b'), 'nothing from the plugin becomes an element');
  assert.deepEqual(all(view).filter((e) => e.tag === 'code').map(text), ['p_tool-demo_echo', 'p_tool-demo_slow']);

  const unpermitted = text(plugins.pluginToolsView(plugin({ permissions: [] })) as El);
  assert.match(unpermitted, /没有授予 tools.provide，不会提供给群员/);
  assert.ok(!/付 token/.test(unpermitted) && !/未授予/.test(unpermitted));
  assert.equal(plugins.pluginToolsView(plugin({ memberTools: [] })), null, 'no tools, no section');

  const card = plugins.pluginRow(plugin(), [plugin()], false, () => {}, () => {}) as El;
  assert.ok(all(card).some((e) => e.attrs['data-plugin-tools'] === 'tool-demo'), 'in the details panel');
  assert.ok(all(card).some((e) => e.tag === 'span' && text(e) === '给群员的工具：1 个'), 'a chip with the granted count');
  const none = plugins.pluginRow(plugin({ permissions: [] }), [], false, () => {}, () => {}) as El;
  assert.ok(!all(none).some((e) => text(e).startsWith('给群员的工具：') && e.tag === 'span'), 'no chip without the permission');
});

test('tools card: names the clusters the tools are offered in, so two grants of the same size read differently', () => {
  const where = (clusters: { id: string; name: string }[]) => text(plugins.pluginToolsView(plugin({ memberToolClusters: clusters })) as El);
  const a = where([{ id: 'a', name: '前端组' }]);
  const b = where([{ id: 'b', name: '<b>后端组</b>' }]);
  assert.match(a, /给群员的工具只在这 1 个群提供：「前端组」。/);
  assert.match(b, /「<b>后端组<\/b>」/, 'a name is text, markup and all');
  assert.notEqual(a, b);
  // Every cluster is named in the details, however many: two grants with the same first five differ by the sixth.
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `群${i}` }));
  const six = where([...five, { id: 'x', name: '第六个甲' }]);
  const other = where([...five, { id: 'y', name: '第六个乙' }]);
  assert.match(six, /给群员的工具只在这 6 个群提供：「群0」、「群1」、「群2」、「群3」、「群4」、「第六个甲」。/);
  assert.ok(other.includes('第六个乙') && !other.includes('第六个甲'));
  assert.notEqual(six, other);
  const many = where(Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, name: `多${i}` })));
  assert.ok(many.includes('「多39」'), 'no cap in the details');
  assert.match(where([]), /现在没有群能用/, 'every granted cluster deleted or in the bin');
  assert.ok(!text(plugins.pluginToolsView(plugin({ permissions: [], memberToolClusters: [{ id: 'a', name: '前端组' }] })) as El).includes('前端组'),
    'no permission: no clusters claimed');
});

const frame = (seq: number, state: string) => ({ id: 'tool-demo', enabled: true, runtime: { state, error: null, errorCode: null }, lifecycle: { ...life, seq } });
const row = (seq: number, clusters: string[], over: object = {}) => plugin({ permissions: ['tools.provide', 'messages.send'], writeClusterIds: ['one'],
  writeSettings: { mentionEnabled: false, perMinute: 10, perHour: 200 }, clusterIds: clusters,
  memberToolClusters: clusters.map((name) => ({ id: name, name })), lifecycle: { ...life, seq }, ...over });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('tools card: an open card follows a restart that changed the grant; unsaved input, focus and the open details stay', async () => {
  const reads: { resolve(v: unknown): void; reject(e: Error): void }[] = [];
  let first: unknown = { installed: [row(1, ['甲', '乙', '丙', '丁', '戊', '己'])] };
  const api = (_method: string, _path: string) => {
    if (first) { const answer = first; first = null; return Promise.resolve(answer); }
    return new Promise((resolve, reject) => reads.push({ resolve, reject }));
  };
  const list = doc.createElement('div');
  const settings = plugins.createPluginSettings(api, list);
  await settings.load();
  const grant = () => text(list.querySelector('[data-plugin-grant="tool-demo"]')!);
  list.querySelector('[data-plugin-details="tool-demo"]')!.on.click();
  const panel = all(list).find((e) => e.attrs.id === 'plugin-details-tool-demo')!;
  assert.equal(panel.hidden, false);
  assert.match(grant(), /6 个群提供：「甲」/);
  const input = all(list).find((e) => e.tag === 'input' && e.attrs.type === 'number')!;
  input.value = '17';
  input.focus();

  // Restarted elsewhere with a grant of one other cluster: the frames say stopping, then ready (a new instance).
  settings.applyState(frame(2, 'stopping'));
  settings.applyState(frame(3, 'ready'));
  assert.equal(reads.length, 1, 'the ready frame reads the list again');
  reads[0].resolve({ installed: [row(3, ['新群'])] });
  await tick();
  assert.match(grant(), /1 个群提供：「新群」/);
  assert.ok(!grant().includes('甲'), 'the revoked clusters are gone');
  assert.ok(all(list).includes(input) && input.value === '17' && doc.activeElement === input, 'the unsaved input and focus stay');
  assert.equal(panel.hidden, false, 'the details stay open');
  assert.match(text(list.querySelector('[data-plugin-live="tool-demo"]')!), /外部进程：ready/);

  // Two restarts quickly: the older read answers last and is dropped.
  settings.applyState(frame(5, 'stopping'));
  settings.applyState(frame(6, 'ready'));
  settings.applyState(frame(7, 'stopping'));
  settings.applyState(frame(8, 'ready'));
  assert.equal(reads.length, 3);
  reads[2].resolve({ installed: [row(8, ['乙方'])] });
  await tick();
  reads[1].resolve({ installed: [row(6, ['甲方'])] });
  await tick();
  assert.match(grant(), /「乙方」/);
  assert.ok(!grant().includes('甲方'), 'a slower older answer does not overwrite');

  // An answer older than the frame that asked (a stale copy) and a failed read change nothing.
  settings.applyState(frame(9, 'stopping'));
  settings.applyState(frame(10, 'ready'));
  reads[3].resolve({ installed: [row(9, ['旧的'])] });
  await tick();
  settings.applyState(frame(11, 'stopping'));
  settings.applyState(frame(12, 'ready'));
  reads[4].reject(new Error('network'));
  await tick();
  assert.match(grant(), /「乙方」/);
  assert.ok(!grant().includes('旧的'));
  assert.equal(doc.activeElement, input);
});

function delayedLists() {
  const reads: ((v: unknown) => void)[] = [];
  const list: El = doc.createElement('div');
  const settings = plugins.createPluginSettings(() => new Promise((resolve) => reads.push(resolve)), list);
  return { list, settings, reads, answer(index: number, pluginRow: object) {
    assert.ok(reads[index], `expected list request ${index + 1}`);
    reads[index]({ installed: [pluginRow] });
  }, grant: () => text(list.querySelector('[data-plugin-grant="tool-demo"]')!) };
}

test('tools card: a slow full list cannot undo grants already refreshed after a restart', async () => {
  const { settings, answer, grant } = delayedLists();
  const initial = settings.load(); answer(0, row(1, ['旧群'])); await initial;
  const slow = settings.load();
  settings.applyState(frame(2, 'stopping'));
  settings.applyState(frame(3, 'ready'));
  answer(2, row(3, ['新群'])); await tick();
  assert.match(grant(), /「新群」/);
  answer(1, row(1, ['旧群'])); await slow;
  assert.match(grant(), /「新群」/);
  assert.ok(!grant().includes('旧群'));
});

test('tools card: a restart buffered before the first list catches up its grant exactly once', async () => {
  const { settings, reads, answer, grant } = delayedLists();
  const initial = settings.load();
  settings.applyState(frame(2, 'stopping')); settings.applyState(frame(3, 'ready'));
  answer(0, row(1, ['旧群'])); await initial;
  assert.equal(reads.length, 2, 'the first list predates the buffered ready frame');
  answer(1, row(3, ['新群'])); await tick();
  assert.match(grant(), /「新群」/);
  assert.ok(!grant().includes('旧群'));
  settings.applyState(frame(4, 'ready'));
  assert.equal(reads.length, 2, 'a later frame for the same ready instance needs no read');

  const fresh = delayedLists();
  const first = fresh.settings.load();
  fresh.settings.applyState(frame(2, 'stopping')); fresh.settings.applyState(frame(3, 'ready'));
  fresh.answer(0, row(3, ['新群'])); await first;
  assert.equal(fresh.reads.length, 1, 'a first list that already saw the restart needs no follow-up');
});

test('tools card: comparable HTTP reads use the newer grant and a lifecycle frame does not block a settings save', async () => {
  const { list, settings, answer, grant } = delayedLists();
  const initial = settings.load(); answer(0, row(1, ['旧群'])); await initial;
  settings.applyState(frame(2, 'stopping')); settings.applyState(frame(3, 'ready')); // local GET 1
  const full = settings.load();
  answer(2, row(3, ['新群'], { pendingEnabled: false })); await full;
  answer(1, row(3, ['旧群'])); await tick();
  assert.match(grant(), /「新群」/, 'the older grant read cannot overwrite the later full result at the same seq');
  settings.applyState(frame(5, 'ready'));   // a live-only change; the latest grant read was still at seq 3
  const saving = list.querySelector('[data-plugin="tool-demo"]')!.on.change({ target: { checked: true } });
  answer(3, row(4, ['改名后的群'], { pendingEnabled: true, writeSettings: { mentionEnabled: false, perMinute: 37, perHour: 200 } }));
  await saving;
  assert.match(grant(), /「改名后的群」/, 'seq 4 is fresher than the previous HTTP grant even though a frame already took state to 5');
  assert.equal(list.querySelector('[data-plugin="tool-demo"]')!.attrs.checked, '');
  assert.equal(all(list).find((e) => e.tag === 'input' && e.attrs.type === 'number')!.attrs.value, '37');
  const disabling = list.querySelector('[data-plugin="tool-demo"]')!.on.change({ target: { checked: false } });
  answer(4, row(4, ['改名后的群'], { pendingEnabled: false, writeSettings: { mentionEnabled: false, perMinute: 43, perHour: 200 } }));
  await disabling;
  assert.equal(list.querySelector('[data-plugin="tool-demo"]')!.attrs.checked, undefined, 'enable changes need no lifecycle seq bump');
  assert.equal(all(list).find((e) => e.tag === 'input' && e.attrs.type === 'number')!.attrs.value, '43');
});
