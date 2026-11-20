// # task references in chat messages (docs/collaboration.md「消息里引用任务」): the picker, the Hub lookup and how the
// page renders them. Browser modules run in node with a small fake DOM; the Markdown → DOM code is taken from app.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { REPO_ROOT } from '../src/main.ts';
import { t } from '../shared/i18n/index.js';
import { startTestHub } from './helpers.ts';
import { collaborationTask, saveCollaborationTask } from '../src/plugins/tasks/package/hub/store.mts';

class FakeElement {
  readonly tagName: string;
  readonly children: (FakeElement | string)[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, ((e: any) => void)[]>();
  hidden = false;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  append(...items: (FakeElement | string)[]) { this.children.push(...items); }
  replaceChildren(...items: (FakeElement | string)[]) { this.children.splice(0, this.children.length, ...items); }
  addEventListener(name: string, listener: (e: any) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  fire(name: string, event: any = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  get textContent(): string { return this.children.map((item) => typeof item === 'string' ? item : item.textContent).join(''); }
}

class FakeInput extends FakeElement {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  constructor() { super('textarea'); }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  focus() { (globalThis as any).document.activeElement = this; }
  dispatchEvent(event: { type: string }) { this.fire(event.type, event); }
  /** Types text at the caret, firing input as a browser would. */
  type(text: string) {
    this.value = this.value.slice(0, this.selectionStart) + text + this.value.slice(this.selectionEnd);
    this.selectionStart = this.selectionEnd = this.selectionStart + text.length;
    this.fire('input');
  }
}

(globalThis as any).document = { createElement: (tag: string) => new FakeElement(tag), activeElement: null };

const load = (file: string) => import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', file)).href);
const ui = await load('ui.js');
const refs = await load('task-refs.js');
const { inlineText, markdownBlocks } = await load('markdown.js');

const ID = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;
const key = (name: string) => ({ key: name, preventDefault() {}, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
const walk = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap((item) => typeof item === 'string' ? [] : walk(item))];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const fixture = async (name: string) => {
  const app = await startTestHub();
  const { cluster } = await app.cluster(name, ['A']);
  const path = `/api/clusters/${cluster.id}`;
  const task = async (title: string, status?: string, scope = 'Scope') => {
    const { task: t } = await app.api('POST', `${path}/collaboration`, { action: 'task.create', operationId: `op-${title}-${Math.random()}`, title, scope, acceptance: 'Done' });
    if (status) saveCollaborationTask(app.store, { ...collaborationTask(app.store, cluster.id, t.id)!, status: status as any });
    return t.id as string;
  };
  return { app, cluster, path, task, close: () => app.close() };
};

test('task-refs candidates: filter by title text or id prefix, newest first, bounded', async () => {
  const f = await fixture('refs-candidates');
  try {
    const alpha = await f.task('Fix Login');
    const beta = await f.task('Payment retries', undefined, 'mentions Login in scope only');
    await f.task('Fix Logout');
    const list = (q: string) => f.app.api('GET', `${f.path}/task-refs?q=${encodeURIComponent(q)}`).then((r) => r.tasks);
    assert.deepEqual((await list('')).map((t: any) => t.title), ['Fix Logout', 'Payment retries', 'Fix Login'], 'empty query lists the newest first');
    assert.deepEqual((await list('login')).map((t: any) => t.id), [alpha], 'title text, not scope text');
    assert.deepEqual((await list(alpha.slice(0, 6))).map((t: any) => t.id), [alpha], 'id prefix');
    assert.deepEqual((await list(beta.replace(/-/g, '').slice(0, 12))).map((t: any) => t.id), [beta], 'id prefix without hyphens');
    assert.deepEqual(await list('no such task'), []);
    for (let i = 0; i < 25; i++) await f.task(`bulk ${i}`);
    assert.equal((await list('')).length, 20, 'at most 20 candidates, the whole list is never fetched');
  } finally { await f.close(); }
});

test('task-refs candidates: merged and cancelled tasks are hidden, other statuses are not', async () => {
  const f = await fixture('refs-status');
  try {
    const open = await f.task('Open work');
    const completed = await f.task('Completed work', 'completed');
    await f.task('Merged work', 'merged');
    await f.task('Cancelled work', 'cancelled');
    const titles = (await f.app.api('GET', `${f.path}/task-refs?q=work`)).tasks.map((t: any) => t.id);
    assert.deepEqual(titles.sort(), [completed, open].sort());
  } finally { await f.close(); }
});

test('task-refs candidates: unfinished first, then completed, merged and cancelled; most recently updated first in each; an exact #number first', async () => {
  const f = await fixture('refs-order');
  try {
    const touch = (id: string, status: string, updatedAt: string) =>
      saveCollaborationTask(f.app.store, { ...collaborationTask(f.app.store, f.cluster.id, id)!, status: status as any, updatedAt });
    const ids: Record<string, string> = {};
    for (const [name, status, at] of [['pend-old', 'pending', '01'], ['merged-new', 'merged', '09'], ['work', 'working', '03'],
      ['done', 'completed', '05'], ['review', 'review', '04'], ['cancel', 'cancelled', '02'], ['pend-new', 'pending', '06']] as const) {
      ids[name] = await f.task(name);
      touch(ids[name], status, `2026-11-${at}T00:00:00.000Z`);
    }
    const list = async (q: string) => (await f.app.api('GET', `${f.path}/task-refs?includeClosed=1&q=${encodeURIComponent(q)}`)).tasks;
    const all = await list('');
    assert.deepEqual(all.map((t: any) => t.title), ['pend-new', 'review', 'work', 'pend-old', 'merged-new', 'done', 'cancel'],
      'two tiers, newest update first inside each, whatever the creation order');
    assert.deepEqual(all.map((t: any) => t.status), ['pending', 'review', 'working', 'pending', 'merged', 'completed', 'cancelled'], 'each carries its status');
    const merged = all.find((t: any) => t.title === 'merged-new');
    assert.equal((await list(`#${merged.number}`))[0].id, ids['merged-new'], 'an exact number match comes first, even a closed task');
    assert.deepEqual((await f.app.api('GET', `${f.path}/task-refs?q=`)).tasks.map((t: any) => t.title), ['pend-new', 'review', 'work', 'pend-old', 'done'],
      'without includeClosed merged and cancelled stay hidden, same order');
  } finally { await f.close(); }
});

test('# picker rows: #number, title and the workbench status chip', () => {
  assert.deepEqual(refs.taskStatusChip('working'), { label: '进行中', className: 'wb-status wb-status-working' });
  assert.deepEqual(refs.taskStatusChip('review'), { label: '待验收', className: 'wb-status wb-status-review' });
  assert.deepEqual(refs.taskStatusChip('pending'), { label: '待开工', className: 'wb-status wb-status-pending' });
  assert.deepEqual(refs.taskStatusChip('accepted'), { label: '待开工', className: 'wb-status wb-status-pending' }, 'the old name of pending');
  assert.deepEqual(refs.taskStatusChip('completed'), { label: '已完成', className: 'wb-status wb-status-completed' });
  assert.deepEqual(refs.taskStatusChip('merged'), { label: '已合并', className: 'wb-status wb-status-merged' });
  assert.deepEqual(refs.taskStatusChip('cancelled'), { label: '已取消', className: 'wb-status wb-status-cancelled' });
  assert.deepEqual(refs.taskStatusChip('weird'), { label: 'weird', className: 'wb-status wb-status-unknown' });
  assert.equal(refs.taskStatusChip(undefined), null);
  const workbench = readFileSync(join(REPO_ROOT, 'src/web/public/workbench.js'), 'utf8');
  assert.match(workbench, /const STATUS = \{ pending: '待开工', working: '进行中', review: '待验收', completed: '已完成', merged: '已合并', cancelled: '已取消' \};/,
    'the same words as the workbench chips');
  const css = readFileSync(join(REPO_ROOT, 'src/web/public/workbench.css'), 'utf8');
  for (const s of ['pending', 'working', 'review', 'completed', 'merged', 'cancelled']) assert.match(css, new RegExp(`\\.wb-status-${s} \\{`), `${s} is coloured there`);

  const input = new FakeInput();
  const menu = new FakeElement('ul');
  menu.hidden = true;
  const keys = ui.attachTaskRefs(input, menu, () => [
    { name: '7', id: ID(7), number: 7, title: '进行中的', status: 'working' },
    { name: '3', id: ID(3), number: 3, title: '合并了的', status: 'merged' },
    { name: '9', id: ID(9), number: 9, title: '旧 Hub' },
  ]);
  input.focus();
  input.type('看 #');
  const rows = menu.children as FakeElement[];
  assert.deepEqual(rows.map((li) => li.textContent), ['#7进行中的进行中', '#3合并了的已合并', '#9旧 Hub'], 'the source order is kept');
  const chip = rows[1].children[2] as FakeElement;
  assert.equal(chip.attributes.class, 'wb-status wb-status-merged task-pick-status');
  assert.equal(rows[2].children.length, 2, 'no status, no chip');
  keys(key('ArrowDown'));
  keys(key('Enter'));
  assert.equal(input.value, '看 #3 ', 'Enter still inserts #number');

});

test('# picker source: each candidate keeps the status the Hub sent', async () => {
  const source = refs.createTaskCandidates({ load: async () => [{ id: ID(5), number: 5, title: 'x', status: 'review' }, { id: ID(6), number: 6, title: 'y' }], onChange: () => {} });
  source('c', '');
  await tick();
  assert.deepEqual(source('c', ''), [{ name: '5', id: ID(5), number: 5, title: 'x', status: 'review' }, { name: '6', id: ID(6), number: 6, title: 'y' }]);
});

test('task-refs lookup: exact ids in this cluster only, any status, at most 100 per request', async () => {
  const f = await fixture('refs-lookup');
  try {
    const merged = await f.task('Merged', 'merged');
    const { cluster: other } = await f.app.cluster('other', ['X']);
    const { task: foreign } = await f.app.api('POST', `/api/clusters/${other.id}/collaboration`, { action: 'task.create', operationId: 'foreign', title: 'Foreign', scope: 's', acceptance: 'a' });
    const got = await f.app.api('GET', `${f.path}/task-refs?ids=${[merged, foreign.id, ID(1)].join(',')}`);
    assert.deepEqual(got.tasks, [{ id: merged, number: 1, title: 'Merged', status: 'merged' }], 'unknown ids and another cluster\'s task are absent');
    const tooMany = Array.from({ length: 101 }, (_, i) => ID(i)).join(',');
    await assert.rejects(f.app.api('GET', `${f.path}/task-refs?ids=${tooMany}`), /at most 100/);
    await assert.rejects(f.app.api('GET', `/api/clusters/nope/task-refs?ids=${ID(1)}`), /unknown cluster/);
  } finally { await f.close(); }
});

test('# picker: typing lists candidates, arrows move the highlight, Enter inserts the chosen id, duplicate titles stay apart', () => {
  const input = new FakeInput();
  const menu = new FakeElement('ul');
  menu.hidden = true;
  const candidates = [{ name: ID(1), title: '修复登录' }, { name: ID(2), title: '修复登录' }, { name: ID(3), title: 'Payment' }];
  const queries: string[] = [];
  const keys = ui.attachTaskRefs(input, menu, (query: string) => { queries.push(query); return candidates; });
  input.focus();
  input.type('看 #');
  assert.equal(menu.hidden, false);
  assert.equal(menu.children.length, 3, 'all candidates for an empty query');
  input.type('修复');
  assert.equal(menu.children.length, 2, 'filtered by title');
  assert.equal(queries.at(-1), '修复', 'the query reaches the source');
  input.selectionStart = input.selectionEnd = input.value.length;
  assert.equal(keys(key('ArrowDown')), true);
  assert.equal((menu.children[1] as FakeElement).attributes['aria-selected'], 'true');
  assert.equal(keys(key('Enter')), true, 'Enter selects while the menu is open');
  assert.equal(input.value, `看 #${ID(2)} `, 'the second of two same-title tasks, by id');
  assert.equal(menu.hidden, true);
  assert.equal(keys(key('Enter')), false, 'with the menu closed Enter is the composer\'s again');
  input.type('#000000');
  assert.equal(menu.children.length, 3, 'ids match by prefix');
  input.type('03');
  assert.equal(menu.children.length, 1);
  assert.equal(((menu.children[0] as FakeElement).children[0] as FakeElement).textContent, '#00000003');
  assert.equal(keys(key('Escape')), true);
  assert.equal(menu.hidden, true);

  // Numbered candidates display #N and insert `#N `; matching works on #number digits, UUID prefix and title.
  const nInput = new FakeInput();
  const nMenu = new FakeElement('ul');
  nMenu.hidden = true;
  const numbered = [
    { name: '12', id: ID(12), number: 12, title: '支付改造' },
    { name: '25', id: ID(25), number: 25, title: '压测任务' },
  ];
  const nKeys = ui.attachTaskRefs(nInput, nMenu, () => numbered);
  nInput.focus();
  nInput.type('先看 #1');
  assert.equal(nMenu.children.length, 1, 'number prefix matches #12 without grabbing #25');
  assert.equal(((nMenu.children[0] as FakeElement).children[0] as FakeElement).textContent, '#12');
  nKeys(key('Enter'));
  assert.equal(nInput.value, '先看 #12 ', 'picking inserts #number');
});

test('# picker: only at a word start, and not for Markdown headings; $ picker still inserts its name', () => {
  const input = new FakeInput();
  const menu = new FakeElement('ul');
  ui.attachTaskRefs(input, menu, () => [{ name: ID(1), title: 'A' }]);
  input.focus();
  input.type('abc#');
  assert.equal(menu.children.length, 0, 'after a word character');
  input.value = ''; input.selectionStart = input.selectionEnd = 0; menu.hidden = true;
  input.type('##');
  assert.equal(menu.hidden, true, '## is a heading marker');
  input.value = ''; input.selectionStart = input.selectionEnd = 0;
  input.type('# ');
  assert.equal(menu.hidden, true, 'a space closes it: `# title` stays a heading');

  const skillInput = new FakeInput();
  const skillMenu = new FakeElement('ul');
  const keys = ui.attachSkills(skillInput, skillMenu, () => [{ name: 'deploy', description: 'd' }]);
  skillInput.focus();
  skillInput.type('$pl');
  assert.equal(skillMenu.children.length, 1);
  keys(key('Enter'));
  assert.equal(skillInput.value, '$deploy ');
});

test('# picker source: one request per cluster and query, late answers dropped, reset asks again', async () => {
  const pending: { query: string; resolve: (v: unknown) => void; cluster: string }[] = [];
  let refreshed = 0;
  const source = refs.createTaskCandidates({
    load: (cluster: string, query: string) => new Promise((resolve) => pending.push({ query, resolve, cluster })),
    onChange: () => { refreshed++; },
  });
  assert.deepEqual(source('c1', ''), []);
  source('c1', '');
  assert.equal(pending.length, 1, 'same query, one request');
  pending[0].resolve([{ id: ID(1), title: 'first' }]);
  await tick();
  assert.deepEqual(source('c1', ''), [{ name: ID(1), title: 'first' }]);
  assert.equal(refreshed, 1);

  source('c1', 'a');
  source('c1', 'ab');
  assert.equal(pending.length, 3);
  pending[2].resolve([{ id: ID(2), title: 'ab' }]);
  pending[1].resolve([{ id: ID(3), title: 'late' }]);
  await tick();
  assert.deepEqual(source('c1', 'ab'), [{ name: ID(2), title: 'ab' }], 'the older answer does not replace the newer');
  assert.equal(refreshed, 2);

  source('c2', 'ab');
  assert.deepEqual(source('c2', 'ab'), [], 'another cluster starts empty');
  assert.equal(pending.at(-1)?.cluster, 'c2');
  source.reset();
  source('c2', 'ab');
  assert.equal(pending.length, 5, 'reset asks again');

  source('c1', 'n');
  pending[5].resolve([{ id: ID(4), number: 4, title: 'numbered' }]);
  await tick();
  assert.deepEqual(source('c1', 'n'), [{ name: '4', id: ID(4), number: 4, title: 'numbered' }]);
  assert.deepEqual(source(undefined as any, ''), [], 'no target');
});

test('task reference cache: rendering asks in bounded batches once, then only reads', async () => {
  const requests: string[][] = [];
  let changes = 0;
  const cache = refs.createTaskRefs({
    load: async (_cluster: string, ids: string[]) => { requests.push(ids); return ids.filter((id) => id !== ID(2)).map((id) => ({ id, title: `T${id}` })); },
    onChange: () => { changes++; },
    delay: 0,
  });
  for (let render = 0; render < 948; render++) cache.track('c', [ID(1), ID(2)]);
  const wait = async () => { for (let i = 0; i < 10; i++) await tick(); };
  await wait();
  assert.deepEqual(requests, [[ID(1), ID(2)]], 'one request however often it renders');
  assert.equal(changes, 1, 'one redraw when the answer arrives');
  assert.deepEqual(cache.get('c', ID(1)), { id: ID(1), title: `T${ID(1)}` });
  assert.equal(cache.get('c', ID(2)), null, 'an unknown task is null');
  assert.equal(cache.get('c', ID(9)), undefined, 'never looked up');

  cache.track('c', [ID(1), ID(2)]);
  await wait();
  assert.equal(requests.length, 1, 'known ids are never asked again');

  const many = Array.from({ length: 250 }, (_, i) => ID(100 + i));
  cache.track('c', many);
  await wait();
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.slice(1).map((r) => r.length), [100, 100, 50], 'batches of at most 100');

  cache.changed('c');
  cache.track('c', [ID(1)]);
  await wait();
  assert.deepEqual(requests.at(-1), [ID(1)], 'a collaboration event re-checks what is shown');
  assert.equal(requests.length, 5);

  // Number refs and UUIDs resolve together and key both by number and UUID.
  const nCache = refs.createTaskRefs({
    load: async (_cluster: string, batchRefs: string[]) => batchRefs.includes('12') ? [{ id: ID(12), number: 12, title: '修复支付' }] : [],
    onChange: () => {},
    delay: 0,
  });
  nCache.track('c', ['12', '99']);
  await wait();
  assert.deepEqual(nCache.get('c', '12'), { id: ID(12), number: 12, title: '修复支付' });
  assert.deepEqual(nCache.get('c', ID(12)), { id: ID(12), number: 12, title: '修复支付' });
  assert.equal(nCache.get('c', '99'), null);
});

test('task reference cache: a failed lookup leaves plain text and no redraw loop', async () => {
  let changes = 0;
  let calls = 0;
  const cache = refs.createTaskRefs({ load: async () => { calls++; throw new Error('Hub unreachable'); }, onChange: () => { changes++; }, delay: 0 });
  cache.track('c', [ID(1)]);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(cache.get('c', ID(1)), null);
  assert.equal(changes, 0, 'nothing a message shows has changed');
  assert.equal(calls, 1);
  cache.track('c', [ID(1)]);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls, 1, 'not retried on every render');
});

const app = readFileSync(join(REPO_ROOT, 'src/web/public/app.js'), 'utf8');
const start = app.indexOf('// A message\'s Markdown as DOM');
const end = app.indexOf('\n// A message\'s attachments never change', start);
assert.ok(start >= 0 && end > start, 'the Markdown → DOM section is still there');

/** The page's own rendering code, with the task cache and the workbench stubbed. */
function renderer(known: Record<string, { id: string; title: string } | null>) {
  const opened: [string, string][] = [];
  const context = { t, h: ui.h, bodySegments: ui.bodySegments, snippet: ui.snippet, inRanges: refs.inRanges, quotedRanges: refs.quotedRanges, inlineText,
    S: { skillNames: new Set(), skills: [], members: new Map(), handoffs: new Set() },
    nameOf: () => 'x', select: () => {},
    taskRefs: { get: (_cluster: string, id: string) => known[id] },
    workbench: { openTask: (cluster: string, id: string) => opened.push([cluster, id]) } };
  const render = runInNewContext(`${app.slice(start, end)}\nmdBlocks;`, context) as (blocks: unknown[], msg: unknown) => FakeElement[];
  const mount = (body: string) => {
    const root = new FakeElement('div');
    root.append(...render(markdownBlocks(body), { id: 'm', clusterId: 'c', mentions: [] }));
    return root;
  };
  return { mount, opened, links: (root: FakeElement) => walk(root).filter((el) => el.attributes.class === 'task-ref') };
}

test('rendered references: a known task is a highlighted link that opens it, by the id written', () => {
  const r = renderer({ [ID(1)]: { id: ID(1), title: '修复登录' }, [ID(2)]: { id: ID(2), title: '修复登录' } });
  const root = r.mount(`请看 #${ID(2)}，然后 **#${ID(1)}**。`);
  const links = r.links(root);
  assert.deepEqual(links.map((a) => a.textContent), ['#00000002 修复登录', '#00000001 修复登录']);
  assert.equal(root.textContent.includes(ID(2)), false, 'the full id stays in the tooltip');
  assert.match(links[0].attributes.title, new RegExp(ID(2)));
  let prevented = false;
  links[0].fire('click', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'no hash navigation');
  assert.deepEqual(r.opened, [['c', ID(2)]], 'duplicate titles: the id in the message decides');
});

test('rendered references: an unknown task or one from another cluster is plain text', () => {
  const r = renderer({ [ID(1)]: null });
  const body = `缺的 #${ID(1)} 还有没见过的 #${ID(2)}。`;
  const root = r.mount(body);
  assert.equal(r.links(root).length, 0);
  assert.equal(root.textContent, body);
});

test('rendered references: not parsed in code, code blocks, quotes, block quotes or link labels', () => {
  const r = renderer({ [ID(1)]: { id: ID(1), title: 'T' } });
  const ref = `#${ID(1)}`;
  const bt = '`';
  const bodies = [
    `${bt}${ref}${bt}`,
    `${bt.repeat(3)}\n${ref}\n${bt.repeat(3)}`,
    `他说 "${ref}" 这里`,
    `他说 “${ref}” 这里`,
    `他说 ‘${ref}’ 这里`,
    `> ${ref} 引用`,
    `>> ${ref} 深一层`,
    `[${ref}](https://example.com/x)`,
    `他说 “**${ref}**” 这里`,        // a quote the Markdown split into nodes
    `他说 "${bt}x${bt} ${ref}" 这里`,
    `[标签](https://example.com/) "${ref}"`,   // offsets stay right after a link
  ];
  for (const body of bodies) {
    const root = r.mount(body);
    assert.equal(r.links(root).length, 0, `no link in: ${body}`);
    assert.ok(root.textContent.includes(ID(1)), `kept as text: ${body}`);
  }
  assert.equal(r.links(r.mount(`"引用" 之后 ${ref}`)).length, 1, 'a closed quote before it does not hide it');
  assert.equal(r.links(r.mount(`> 引用\n\n${ref}`)).length, 1, 'neither does an earlier block quote');
  assert.equal(r.links(r.mount(`${bt}x${bt} ${ref}`)).length, 1, 'nor earlier code');
  assert.equal(r.links(r.mount(`"a" [标签](https://example.com/) ${ref}`)).length, 1, 'nor an earlier link');

  // #number refs & legacy #UUID both render as `#N Title`; unknown #999 or quoted/code #N stay plain text.
  const rn = renderer({
    '12': { id: ID(12), number: 12, title: '数字任务' } as any,
    [ID(12)]: { id: ID(12), number: 12, title: '数字任务' } as any,
    '99': null,
  });
  const mixed = rn.mount(`先看 #12 和旧引用 #${ID(12)}，不存在的 #99，代码 \`#12\`，引号 "#12"`);
  const mixedLinks = rn.links(mixed);
  assert.deepEqual(mixedLinks.map((a) => a.textContent), ['#12 数字任务', '#12 数字任务']);
  mixedLinks[0].fire('click', { preventDefault: () => {} });
  assert.deepEqual(rn.opened, [['c', ID(12)]]);
  assert.ok(mixed.textContent.includes('#99'));
  assert.ok(mixed.textContent.includes('"#12"'));
});

test('# syntax: exact #number or full ids only, at a word start', () => {
  const ids = (body: string) => refs.taskRefIds(body);
  assert.deepEqual(ids(`#${ID(1)} 和 #${ID(2)} 和再一次 #${ID(1)}`), [ID(1), ID(2)]);
  assert.deepEqual(ids(`#${ID(1)}。`), [ID(1)], 'CJK punctuation after it');
  assert.deepEqual(ids('#12 和 #123，以及 #12'), ['12', '123']);
  for (const body of [`a#${ID(1)}`, `#${ID(1)}x`, `#${ID(1)}-x`, `##${ID(1)}`, '#00000001', '#0', '#12a', '#12-x', 'a#12', '##12', '#99999999999999999999', 'no refs']) {
    assert.deepEqual(ids(body), [], body);
  }
  assert.deepEqual(ids(undefined as any), []);
});

test('# quoting agrees with the Hub\'s @ quoting', async () => {
  const bt = '`';
  const shapes = (x: string) => [
    `${bt}${x}${bt}`, `${bt.repeat(3)}\n${x}\n${bt.repeat(3)}`, `"${x}"`, `'${x}'`, `“${x}”`, `‘${x}’`, `"a \\"${x}\\""`,
    `plain ${x}`, `"${x}`, `"a\n${x}"`, `“a\n${x}”`, `${bt}a${bt} ${x}`,
  ];
  const app2 = await startTestHub();
  try {
    const { cluster, members: [member] } = await app2.cluster('quote-agreement', ['B']);
    for (const body of shapes('@B')) {
      const mentioned = app2.hub.sendFromUser(cluster.id, body).mentions.includes(member.id);
      const quoted = refs.inRanges(refs.quotedRanges(body), body.indexOf('@B'));
      assert.equal(!quoted, mentioned, `same answer for: ${JSON.stringify(body)}`);
    }
  } finally { await app2.close(); }
});
