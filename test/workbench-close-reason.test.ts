import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const ui = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench.js')).href);

test('the status chip names the close reason of a cancelled task; older and open tasks read as before', () => {
  const cancelled = (kind?: string) => ({ status: 'cancelled', ...(kind ? { closeReason: { kind, taskId: 'x' } } : {}) });
  assert.equal(ui.statusText(cancelled('not_planned')), '已取消 · 不做了');
  assert.equal(ui.statusText(cancelled('duplicate')), '已取消 · 重复');
  assert.equal(ui.statusText(cancelled('superseded')), '已取消 · 被取代');
  assert.equal(ui.statusText(cancelled('other')), '已取消 · 其他');
  assert.equal(ui.statusText(cancelled()), '已取消', 'a task cancelled before close reasons has none');
  assert.equal(ui.statusText(cancelled('constructor')), '已取消', 'an unknown kind is ignored');
  assert.equal(ui.statusText({ status: 'pending', closeReason: { kind: 'duplicate' } }), '待开工', 'only a cancelled task shows it');
  assert.equal(ui.statusText({ status: 'pending', proposalState: 'proposed' }), '待批准');
});

test('the cancel dialog offers the four reasons, not_planned first, and asks for a task only for duplicate and superseded', () => {
  assert.deepEqual(Object.keys(ui.CLOSE_REASONS), ['not_planned', 'duplicate', 'superseded', 'other']);
  assert.equal(ui.relatedReason('duplicate').pick, '与哪个任务重复');
  assert.equal(ui.relatedReason('superseded').pick, '被哪个任务取代');
  for (const kind of ['not_planned', 'other', 'constructor', undefined]) assert.equal(ui.relatedReason(kind), null, String(kind));
  assert.deepEqual(ui.closeReasonFields('duplicate', 't1'), { closeReason: 'duplicate', relatedTaskId: 't1' });
  assert.deepEqual(ui.closeReasonFields('superseded', 't1'), { closeReason: 'superseded', relatedTaskId: 't1' });
  assert.deepEqual(ui.closeReasonFields('not_planned', 't1'), { closeReason: 'not_planned' },
    'a task picked before switching back to 不做了 is not sent');
  assert.deepEqual(ui.closeReasonFields('other', ''), { closeReason: 'other' });
  assert.equal(ui.cancelReasonRequired('not_planned'), false);
  assert.equal(ui.cancelReasonRequired('duplicate'), false);
  assert.equal(ui.cancelReasonRequired('superseded'), false);
  assert.equal(ui.cancelReasonRequired('other'), true);
});

class PickerNode {
  tagName: string;
  children: PickerNode[] = [];
  attributes: Record<string, string> = {};
  listeners = new Map<string, ((e: any) => void)[]>();
  hidden = false;
  value = '';
  text = '';
  constructor(tag: string) { this.tagName = tag; }
  set textContent(v: string) { this.text = v; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  addEventListener(k: string, fn: (e: any) => void) { this.listeners.set(k, [...(this.listeners.get(k) ?? []), fn]); }
  removeEventListener(k: string, fn: (e: any) => void) {
    this.listeners.set(k, (this.listeners.get(k) ?? []).filter((f) => f !== fn));
  }
  append(...items: (PickerNode | string)[]) {
    for (const item of items) {
      if (typeof item === 'string') { const n = new PickerNode('#text'); n.text = item; this.children.push(n); }
      else this.children.push(item);
    }
  }
  replaceChildren(...items: PickerNode[]) { this.children.splice(0, this.children.length); this.append(...items); }
  fire(name: string, event: any = {}) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  findAll(pred: (n: PickerNode) => boolean): PickerNode[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.findAll(pred))];
  }
}

test('the cancel related-task picker filters immediately by #number or title, includes closed tasks, excludes self, and selects', async (t) => {
  const prev = (globalThis as any).document;
  (globalThis as any).document = { createElement: (tag: string) => new PickerNode(tag), createElementNS: (_ns: string, tag: string) => new PickerNode(tag) };
  t.after(() => { (globalThis as any).document = prev; });
  const queries: string[] = [];
  const all = [
    { id: 'self', number: 1, title: 'self task', status: 'pending' },
    { id: 'closed-2', number: 2, title: '已完成替代方案', status: 'completed' },
    { id: 'cancelled-3', number: 3, title: '已取消参考', status: 'cancelled' },
    { id: 'open-12', number: 12, title: '其他开放任务', status: 'working' },
  ];
  const picker = ui.createRelatedTaskPicker({
    clusterId: 'c1',
    excludeId: 'self',
    load: async (_cid: string, q: string) => {
      queries.push(q);
      if (!q) return all;
      const num = /^#?(\d+)$/.exec(q)?.[1];
      return all.filter((t) => (num && t.number === Number(num)) || t.title.includes(q));
    },
  });
  picker.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(queries, ['']);
  const options = () => picker.el.findAll((n: PickerNode) => n.attributes.role === 'option');
  assert.deepEqual(options().map((o: PickerNode) => o.textContent), [
    '#2已完成替代方案已完成',
    '#3已取消参考已取消',
    '#12其他开放任务进行中',
  ], 'excludes self, displays #number title and status including closed tasks');

  picker.search.value = '#2';
  picker.search.fire('input');
  assert.deepEqual(options().map((o: PickerNode) => o.textContent), ['#2已完成替代方案已完成'], 'filters cached list synchronously');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(queries, ['', '#2']);

  options()[0].fire('click');
  assert.equal(picker.value(), 'closed-2');
  assert.equal(options()[0].attributes['aria-selected'], 'true');
  assert.match(picker.el.textContent, /已选：#2 已完成替代方案 · 已完成/);
});

test('the cancel related-task picker defers redraw while pointer is pressed so late search results keep the first click working', async (t) => {
  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;
  const win = new PickerNode('window');
  (globalThis as any).document = { createElement: (tag: string) => new PickerNode(tag), createElementNS: (_ns: string, tag: string) => new PickerNode(tag) };
  (globalThis as any).window = win;
  t.after(() => { (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin; });

  const target = { id: 't2', number: 2, title: 'Target task', status: 'pending' };
  let resolveSecond!: (tasks: any[]) => void;
  let calls = 0;
  const picker = ui.createRelatedTaskPicker({
    clusterId: 'c1',
    excludeId: 'self',
    load: () => {
      calls++;
      if (calls === 1) return Promise.resolve([target]);
      return new Promise((r) => { resolveSecond = r; });
    },
  });
  picker.start();
  await new Promise((r) => setImmediate(r));

  const listbox = picker.el.findAll((n: PickerNode) => n.attributes.role === 'listbox')[0];
  const options = () => picker.el.findAll((n: PickerNode) => n.attributes.role === 'option');

  picker.search.value = 'Target';
  picker.search.fire('input');
  assert.equal(calls, 2);
  const pressedBtn = options()[0];
  listbox.fire('pointerdown');

  resolveSecond!([target]);
  await new Promise((r) => setImmediate(r));
  assert.equal(options()[0], pressedBtn, 'pressed option node must stay in place until pointerup');

  win.fire('pointerup');
  pressedBtn.fire('click');
  assert.equal(picker.value(), 't2', 'first click immediately selects the pressed option');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(options()[0].attributes['aria-selected'], 'true');
  picker.dispose();
  assert.equal(win.listeners.get('pointerup')?.length ?? 0, 0);
  assert.equal(win.listeners.get('pointercancel')?.length ?? 0, 0);
});

test('disposing the related-task picker across repeated open/close cycles removes global listeners and ignores late draws', async (t) => {
  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;
  const win = new PickerNode('window');
  (globalThis as any).document = { createElement: (tag: string) => new PickerNode(tag), createElementNS: (_ns: string, tag: string) => new PickerNode(tag) };
  (globalThis as any).window = win;
  t.after(() => { (globalThis as any).document = prevDoc; (globalThis as any).window = prevWin; });

  for (let i = 0; i < 5; i++) {
    let resolveLate!: (tasks: any[]) => void;
    let calls = 0;
    const picker = ui.createRelatedTaskPicker({
      clusterId: 'c1',
      excludeId: 'self',
      load: () => {
        calls++;
        if (calls === 1) return Promise.resolve([{ id: `t${i}`, number: i + 1, title: `Task ${i}`, status: 'pending' }]);
        return new Promise((r) => { resolveLate = r; });
      },
    });
    picker.start();
    await new Promise((r) => setImmediate(r));
    const listbox = picker.el.findAll((n: PickerNode) => n.attributes.role === 'listbox')[0];
    picker.search.value = 'Task';
    picker.search.fire('input');
    listbox.fire('pointerdown');

    picker.dispose();
    assert.equal(win.listeners.get('pointerup')?.length ?? 0, 0, `cycle ${i}: pointerup cleaned up`);
    assert.equal(win.listeners.get('pointercancel')?.length ?? 0, 0, `cycle ${i}: pointercancel cleaned up`);
    assert.equal(listbox.listeners.get('pointerdown')?.length ?? 0, 0, `cycle ${i}: pointerdown cleaned up`);

    resolveLate!([{ id: 'late', number: 99, title: 'Late', status: 'pending' }]);
    await new Promise((r) => setTimeout(r, 15));
    const renderedIds = picker.el.findAll((n: PickerNode) => n.attributes.role === 'option').map((n: PickerNode) => n.textContent);
    assert.equal(renderedIds.some((txt: string) => txt.includes('#99')), false, 'late response after dispose must not redraw');
  }
});

test('the cancel related-task picker says "searching" on its own line while a search runs, then shows the shared compact empty state', async (t) => {
  const prev = (globalThis as any).document;
  (globalThis as any).document = { createElement: (tag: string) => new PickerNode(tag), createElementNS: (_ns: string, tag: string) => new PickerNode(tag) };
  t.after(() => { (globalThis as any).document = prev; });
  let release: (items: unknown[]) => void = () => {};
  const picker = ui.createRelatedTaskPicker({ clusterId: 'c1', load: () => new Promise((resolve) => { release = resolve; }) });
  picker.start();
  const byClass = (cls: string) => picker.el.findAll((n: PickerNode) => n.attributes.class === cls)[0];
  const empty = byClass('empty-state compact');
  const loading = byClass('muted wb-close-loading');
  assert.ok(empty, 'the empty state is ui.js emptyState, compact');
  assert.equal(empty.children[0].attributes.class, 'empty-art', 'with its picture');
  assert.equal(empty.textContent, '没有匹配的任务');
  assert.deepEqual([loading.hidden, loading.textContent, empty.hidden], [false, '正在搜索…', true], 'searching: the loading line, not the empty state');
  release([]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([loading.hidden, empty.hidden], [true, false], 'nothing found: the empty state');
  assert.equal(empty.children[0].attributes.class, 'empty-art', 'its picture was not wiped by a text update');
  assert.equal(empty.textContent, '没有匹配的任务');
});