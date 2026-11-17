// The page side of the label library (src/web/public/workbench-labels.js): the pure layout of the grouped picker,
// the required-group note and the grouped filter list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const labels = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench-labels.js')).href);
const workbench = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench.js')).href);

/** Just enough DOM for ui.js h() and the label picker. */
class Node {
  tagName: string; children: (Node | string)[] = []; attributes: Record<string, string> = {}; hidden = false; value = ''; text = '';
  listeners = new Map<string, ((e: any) => void)[]>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  set textContent(v: string) { this.text = v; }
  get textContent(): string { return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  addEventListener(k: string, fn: (e: any) => void) { this.listeners.set(k, [...(this.listeners.get(k) ?? []), fn]); }
  append(...items: (Node | string)[]) { this.children.push(...items); }
  replaceChildren(...items: (Node | string)[]) { this.children = [...items]; }
  fire(name: string, event: any = {}) { for (const fn of this.listeners.get(name) ?? []) fn({ preventDefault() {}, ...event }); }
  all(): Node[] { return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()])); }
}
const withDom = <T>(fn: () => T): T => {
  (globalThis as any).document = { createElement: (tag: string) => new Node(tag) };
  try { return fn(); } finally { delete (globalThis as any).document; }
};
const chip = (root: Node, name: string) => root.all().find((n) => n.tagName === 'BUTTON' && n.textContent === name)!;

test('the edit form keeps a task’s comma label whole: a title-only edit sends no labels', () => withDom(() => {
  const legacy = { groups: [{ id: 'g', name: 'G', selected: true, required: false, labels: [{ id: 'l', name: 'alpha,beta', archived: false }] }], ungrouped: [] };
  const task = { title: 'old', labels: ['alpha,beta', 'Hub', 'hub'], requiresApproval: false, mergeRequired: true };
  const picker = labels.labelPicker(legacy, task.labels, () => 0);
  assert.deepEqual(picker.value(), ['alpha,beta', 'Hub', 'hub'], 'exactly as stored, not split or respelled');
  assert.deepEqual(workbench.taskEditChanges(task, { title: 'new', labels: picker.value(), requiresApproval: false, mergeRequired: true }), { title: 'new' },
    'only the title is sent, so the Hub creates no labels');
  // Clicking the comma label off and on again keeps it whole.
  const root = picker.el as unknown as Node;
  chip(root, 'alpha,beta').fire('click');
  assert.deepEqual(picker.value(), ['Hub', 'hub']);
  chip(root, 'alpha,beta').fire('click');
  assert.deepEqual(picker.value(), ['Hub', 'hub', 'alpha,beta']);
  // Only typed text is split on commas.
  const input = root.all().find((n) => n.tagName === 'INPUT')!;
  input.value = 'x, y，z';
  assert.deepEqual(picker.value(), ['Hub', 'hub', 'alpha,beta', 'x', 'y', 'z']);
}));

test('the label filter keeps a comma label whole: toggling it twice clears the filter', () => {
  const once = workbench.toggleLabelFilter([], 'alpha,beta');
  assert.deepEqual(once, ['alpha,beta']);
  assert.equal(String(workbench.taskFilterQuery({ label: once })), 'label=alpha%2Cbeta', 'one label parameter, not two');
  assert.deepEqual(workbench.toggleLabelFilter(once, 'alpha,beta'), []);
  assert.equal(workbench.hasTaskFilters({ label: workbench.toggleLabelFilter(once, 'alpha,beta') }), false);
  assert.deepEqual(workbench.withKnownLabels({ label: once }, ['alpha,beta']), { label: once });
  const stored = (label: unknown) => workbench.storedTaskView(JSON.stringify({ version: 1, filters: { label } })).filters.label;
  assert.deepEqual(stored(['alpha,beta', 'x']), ['alpha,beta', 'x'], 'a stored list keeps its items');
  assert.deepEqual(stored('a, b'), ['a', 'b'], 'an old comma-joined value is still read');
});

const label = (name: string, extra: Record<string, unknown> = {}) => ({ id: name, name, groupId: null, color: null, description: '', archived: false, ...extra });
const library = {
  groups: [
    { id: 'kind', name: 'Kind', required: true, selected: true, description: 'what', labels: [label('feature'), label('fix'), label('old', { archived: true })] },
    { id: 'area', name: 'Area', required: false, selected: true, labels: [label('front', { color: 3 })] },
    { id: 'far', name: 'Far', required: true, selected: false, labels: [label('far')] },
  ],
  ungrouped: [label('loose'), label('gone', { archived: true })],
  packs: [],
};

test('the library signal is the cluster-less label.library collaboration event, nothing else', () => {
  assert.equal(labels.isLibrarySignal({ kind: 'collaboration', clusterId: null, payload: { action: 'label.library', source: 'label.edit' } }), true);
  assert.equal(labels.isLibrarySignal({ kind: 'collaboration', clusterId: 'c', payload: { action: 'label.edit' } }), false, 'a cluster event');
  assert.equal(labels.isLibrarySignal({ kind: 'collaboration', clusterId: 'c', payload: { action: 'label.library' } }), false);
  assert.equal(labels.isLibrarySignal({ kind: 'settings', clusterId: null, payload: { action: 'label.library' } }), false);
  assert.equal(labels.isLibrarySignal(undefined), false);
});

test('typed labels split on both commas, take the library spelling and drop duplicates in any case', () => {
  const index = labels.labelIndex(library);
  assert.deepEqual(labels.typedLabels(' Feature, new ，NEW,, front', index), ['feature', 'new', 'front']);
  assert.equal(labels.libraryColor(index, 'FRONT'), 3);
  assert.equal(labels.libraryColor(index, 'feature'), null, 'no colour: the page derives one');
  assert.equal(labels.libraryColor(index, 'unknown'), null);
});

test('the picker lists the groups this cluster uses, then ungrouped, then chosen labels from elsewhere; archived only when chosen', () => {
  assert.deepEqual(labels.pickerSections(library, []).map((s: any) => [s.title, s.required, s.labels]), [
    ['Kind', true, ['feature', 'fix']], ['Area', false, ['front']], ['未分组', false, ['loose']]]);
  const chosen = labels.pickerSections(library, ['old', 'far', 'legacy']);
  assert.deepEqual(chosen.map((s: any) => [s.title, s.labels]), [
    ['Kind', ['feature', 'fix', 'old']], ['Area', ['front']], ['未分组', ['loose']], ['其他', ['far', 'legacy']]]);
  assert.deepEqual(labels.pickerSections(null, ['x']).map((s: any) => s.title), ['其他'], 'no library yet');
});

test('missing required groups: only the ones this cluster uses, with their usable labels', () => {
  assert.deepEqual(labels.missingRequired(library, ['front']), [{ name: 'Kind', labels: ['feature', 'fix'] }]);
  assert.deepEqual(labels.missingRequired(library, ['FIX']), [], 'matched without case');
  assert.deepEqual(labels.missingRequired(library, ['old']), [], 'an archived label the task keeps still counts');
  assert.match(labels.missingText(labels.missingRequired(library, [])), /必选组「Kind」还没选：feature、fix 中选一个/);
  const empty = { groups: [{ id: 'e', name: 'Empty', required: true, selected: true, labels: [] }], ungrouped: [] };
  assert.match(labels.missingText(labels.missingRequired(empty, [])), /还没有标签/);
});

test('the filter list groups labels in use: used groups first, then ungrouped, then labels the library lacks', () => {
  const sections = labels.filterSections(['far', 'legacy', 'fix', 'loose', 'front'], library);
  assert.deepEqual(sections.map((s: any) => [s.title, s.labels]), [
    ['Kind', ['fix']], ['Area', ['front']], ['Far', ['far']], ['未分组', ['loose']], ['不在标签库', ['legacy']]]);
  assert.deepEqual(labels.filterSections(['a', 'b'], undefined).map((s: any) => s.title), ['不在标签库']);
  assert.equal(labels.impactText({ tasks: 12, clusters: 3 }), '3 个群的 12 个任务');
  assert.equal(labels.impactText({ tasks: 0, clusters: 0 }), '没有任务');
});
