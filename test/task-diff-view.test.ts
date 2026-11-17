import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

class FakeElement {
  readonly tagName: string;
  readonly children: (FakeElement | string)[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, (() => void)[]>();
  open = false;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  append(...items: (FakeElement | string)[]) { this.children.push(...items); }
  replaceChildren(...items: (FakeElement | string)[]) { this.children.splice(0, this.children.length, ...items); }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  fire(name: string) { for (const listener of this.listeners.get(name) ?? []) listener(); }
  get textContent(): string { return this.children.map((item) => typeof item === 'string' ? item : item.textContent).join(''); }
}

const previousDocument = (globalThis as any).document;
(globalThis as any).document = { createElement: (tag: string) => new FakeElement(tag), createElementNS: (_ns: string, tag: string) => new FakeElement(tag) };
after(() => { (globalThis as any).document = previousDocument; });
const { createTaskDiffView, createShipFailureView } = await import(pathToFileURL(join(process.cwd(), 'src/web/public/task-diff-view.js')).href) as {
  createTaskDiffView(options?: { load?: () => Promise<unknown>; legacy?: boolean; resolve?: (kind: string, id: string) => string | null }): FakeElement;
  createShipFailureView(options: { load: () => Promise<unknown> }): FakeElement;
};
const walk = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap((item) => typeof item === 'string' ? [] : walk(item))];
const withClass = (node: FakeElement, name: string) => walk(node).filter((item) => item.attributes.class?.split(' ').includes(name));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const open = (node: FakeElement) => { node.open = true; node.fire('toggle'); };

test('details loads only when opened, announces loading, and renders text, lists and scalar fields safely', async () => {
  const gate = Promise.withResolvers<unknown>();
  let calls = 0;
  const view = createTaskDiffView({ load: () => { calls++; return gate.promise; },
    resolve: (kind, id) => kind === 'role' && id === 'new-role' ? '执行者' : null });
  assert.equal(view.tagName, 'details');
  assert.equal((view.children[0] as FakeElement).tagName, 'summary', 'native summary supplies keyboard activation');
  assert.equal(calls, 0);
  open(view);
  assert.equal(calls, 1);
  assert.match(view.textContent, /正在加载任务变更/);
  assert.equal(walk(view).find((node) => node.attributes.role === 'status')?.textContent, '正在加载任务变更…');
  view.open = false; view.fire('toggle'); open(view);
  assert.equal(calls, 1, 'reopening while loading does not start another request');
  gate.resolve({ changes: [
    { field: 'title', before: null, after: '<img src=x onerror=alert(1)>' },
    { field: 'scope', before: '保留\n旧', after: '保留\n新' },
    { field: 'priority', before: 'low', after: 'high' },
    { field: 'reviewer', before: { kind: 'user' }, after: { kind: 'member', memberId: 'removed-member' } },
    { field: 'executeRoleIds', before: ['old-role'], after: ['new-role'] },
    { field: 'dependencyIds', before: [], after: ['unknown-task'] },
    { field: '__proto__', before: '<script>old</script>', after: '<script>new</script>' },
  ] });
  await tick();
  assert.match(view.textContent, /新增 <img src=x onerror=alert\(1\)>/);
  assert.match(view.textContent, /删除 旧/);
  assert.match(view.textContent, /新增 新/);
  // Each changed line starts with its sign icon (sprite plus or minus) before the word.
  const sign = (row: FakeElement) => typeof row.children[0] === 'string' ? 'text' : (row.children[0].children[0] as FakeElement).attributes.href;
  assert.deepEqual([...new Set(withClass(view, 'task-diff-add').map(sign))], ['#i-plus', 'text'], 'text diffs: an icon; list changes keep 新增：');
  assert.deepEqual([...new Set(withClass(view, 'task-diff-remove').map(sign))], ['#i-minus', 'text']);
  assert.match(view.textContent, /低 → 高/);
  assert.match(view.textContent, /用户 → removed-member/);
  assert.match(view.textContent, /去掉：old-role/);
  assert.match(view.textContent, /新增：执行者/);
  assert.match(view.textContent, /新增：unknown-task/);
  assert.match(view.textContent, /字段 __proto__/);
  assert.match(view.textContent, /<script>old<\/script> → <script>new<\/script>/);
  assert.ok(withClass(view, 'task-diff-remove').length >= 2);
  assert.ok(withClass(view, 'task-diff-add').length >= 3);
  assert.ok(!walk(view).some((node) => ['img', 'script'].includes(node.tagName)), 'untrusted markup remains text');
  view.open = false; view.fire('toggle'); open(view);
  assert.equal(calls, 1, 'successful data is reused');
});

test('legacy and events without changes have explicit empty states', async () => {
  let calls = 0;
  const old = createTaskDiffView({ legacy: true, load: async () => { calls++; return {}; } });
  open(old);
  assert.match(old.textContent, /旧通知产生于改版前，没有保存历史差异/);
  assert.equal(calls, 0);
  const empty = createTaskDiffView({ load: async () => ({ action: 'task.claim' }) });
  open(empty);
  await tick();
  assert.match(empty.textContent, /该事件没有记录字段变更/);
});

test('a failed load offers a working retry', async () => {
  let calls = 0;
  const view = createTaskDiffView({ load: async () => { if (++calls === 1) throw new Error('offline'); return { changes: [] }; } });
  open(view);
  await tick();
  assert.match(view.textContent, /加载任务变更失败/);
  assert.ok(walk(view).some((node) => node.attributes.role === 'alert'));
  const retry = walk(view).find((node) => node.tagName === 'button' && node.textContent === '重试')!;
  retry.fire('click');
  await tick();
  assert.equal(calls, 2);
  assert.match(view.textContent, /该事件没有记录字段变更/);
});

test('ship failure details load on open, can retry, and preserve only the saved plain text', async () => {
  let calls = 0;
  const diagnostic = 'npm test failed twice:\n<img src=x onerror=alert(1)>\nlast line';
  const view = createShipFailureView({ load: async () => {
    if (++calls === 1) throw new Error('offline');
    return { reason: 'checks: ' + diagnostic };
  } });
  assert.equal(view.open, false);
  assert.equal(view.textContent, '查看失败详情');
  assert.equal(calls, 0);
  open(view);
  await tick();
  assert.match(view.textContent, /加载诊断失败/);
  walk(view).find((node) => node.tagName === 'button' && node.textContent === '重试')!.fire('click');
  await tick();
  assert.equal(calls, 2);
  assert.equal(walk(view).find((node) => node.tagName === 'pre')?.textContent, diagnostic);
  assert.ok(!walk(view).some((node) => node.tagName === 'img'), 'markup is plain text');
  const old = createShipFailureView({ load: async () => ({ reason: 'conflict: only the part saved at the time' }) });
  open(old);
  await tick();
  assert.equal(walk(old).find((node) => node.tagName === 'pre')?.textContent, 'only the part saved at the time');
});

test('truncated and bounded comparisons are labelled without claiming missing content is complete', async () => {
  const before = Array(1100).fill('old').join('\n');
  const after = Array(1100).fill('new').join('\n');
  const view = createTaskDiffView({ load: async () => ({ changes: [
    { field: 'scope', before, after }, { field: 'acceptance', before, after, truncated: true },
    { field: 'labels', before: ['a', 'b', 'a'], after: ['a', 'b'], truncated: true },
    { field: 'reviewRoleIds', before: ['a', 'b'], after: ['b', 'a'] },
  ] }) });
  open(view);
  await tick();
  assert.match(view.textContent, /内容过长，以下显示旧版和新版全文/);
  assert.match(view.textContent, /字段内容已截断，以下仅为已保存片段/);
  assert.match(view.textContent, /内容过长，以下显示旧版和新版已保存片段/);
  assert.match(view.textContent, /去掉：a/);
  assert.match(view.textContent, /列表项没有增删，顺序可能已调整/);
  for (const field of withClass(view, 'task-diff-field').slice(0, 2)) {
    assert.deepEqual(withClass(field, 'task-diff-remove').map((node) => node.textContent), ['旧版']);
    assert.deepEqual(withClass(field, 'task-diff-add').map((node) => node.textContent), ['新版']);
    assert.doesNotMatch(field.textContent, /删除|新增/, 'fallback shows versions, not a precise diff');
  }
  assert.deepEqual(withClass(view, 'task-diff-before').map((node) => node.textContent), [before, before]);
  assert.deepEqual(withClass(view, 'task-diff-after').map((node) => node.textContent), [after, after]);
});

test('an attachment change is labelled and names the files; a missing name falls back to the id', async () => {
  const view = createTaskDiffView({ load: async () => ({ changes: [{ field: 'fileIds', before: ['a', 'b'], after: ['b', 'c', 'gone'],
    fileNames: { a: 'old.png', b: 'kept.txt', c: '<b>new</b>.png' } }] }), resolve: () => null });
  open(view);
  await tick();
  assert.match(view.textContent, /附件/);
  assert.match(view.textContent, /去掉：old\.png/);
  assert.match(view.textContent, /新增：<b>new<\/b>\.png/);
  assert.match(view.textContent, /新增：gone/);
  assert.ok(!view.textContent.includes('kept.txt'), 'an unchanged file is not listed');
  assert.doesNotMatch(view.textContent, /字段 fileIds/);
});
