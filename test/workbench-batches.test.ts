// The workbench's review batches (docs/collaboration.md「验收批次」): a batch is a group above the status groups with its
// progress, its tasks in dependency order and a chip on each card; the rest of the list is unchanged.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const ui = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench.js')).href);

const batch = { id: 'b1', number: 1, title: 'chain', reviewer: { kind: 'user' }, createdBy: 'user', total: 3, submitted: 2, approved: 1,
  complete: false, allApproved: false, merged: false, missing: ['#3 待开工'], reviewedAt: null, cancelledAt: null, shipFailure: null,
  tasks: [{ id: 't1', number: 1, title: 'one', status: 'completed', state: 'approved', commitSha: 'aaaaaaa' },
    { id: 't2', number: 2, title: 'two', status: 'review', state: 'submitted', commitSha: 'bbbbbbb' },
    { id: 't3', number: 3, title: 'three', status: 'pending', state: 'missing', commitSha: null }] };

test('batch groups take the loaded tasks of each batch in dependency order and leave the rest to the status groups', () => {
  const tasks = [{ id: 't3', batchId: 'b1' }, { id: 'x', status: 'pending' }, { id: 't1', batchId: 'b1' }];
  const { groups, rest } = ui.batchGroups(tasks, [batch, { ...batch, id: 'b2', tasks: [{ id: 'gone' }] }]);
  assert.deepEqual(groups.map((group: any) => [group.batch.id, group.tasks.map((task: any) => task.id)]), [['b1', ['t1', 't3']]], 'a batch with nothing loaded is left out');
  assert.deepEqual(rest.map((task: any) => task.id), ['x']);
  assert.deepEqual(ui.batchGroups(tasks, undefined).rest.length, 3, 'a Hub without batches: every task stays where it was');
  assert.deepEqual(ui.batchGroups(tasks, [{ ...batch, id: 'new', total: 0, tasks: [] }]).groups.map((group: any) => group.batch.id), ['new'], 'an empty batch shows');
});

test('batch progress names submitted and approved counts and where the batch stands', () => {
  assert.deepEqual(ui.batchProgress(batch), { submitted: '已提交 2/3', approved: '已通过 1/3', state: '未齐', tone: 'open' });
  assert.equal(ui.batchProgress({ ...batch, complete: true }).state, '已齐，待验收');
  assert.equal(ui.batchProgress({ ...batch, complete: true, allApproved: true }).state, '已全部通过，待 ship');
  assert.equal(ui.batchProgress({ ...batch, merged: true }).tone, 'merged');
  const failed = ui.batchProgress({ ...batch, complete: true, allApproved: true, shipFailure: { kind: 'checks' } });
  assert.equal(failed.state, '上次合并失败，待处理');
  assert.equal(failed.tone, 'failed', 'a failed ship outranks ready in the head tone');
});

function mockDom(t: TestContext) {
  class El {
    children: any[] = []; attributes: Record<string, string> = {}; listeners = new Map<string, ((e: any) => unknown)[]>();
    dataset: any = {}; style = { setProperty() {} }; classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
    hidden = false; disabled = false; open = false; checked = false; value = ''; text = ''; offsetHeight = 0;
    readonly tagName: string;
    constructor(tagName: string) { this.tagName = tagName; }
    set textContent(value: string) { this.text = String(value); this.children = []; }
    get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    removeAttribute(name: string) { delete this.attributes[name]; }
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
    addEventListener(name: string, fn: (e: any) => unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
    removeEventListener() {}
    append(...items: any[]) { for (const item of items) { if (typeof item === 'string') { const node = new El('#text'); node.text = item; this.children.push(node); } else this.children.push(item); } }
    replaceChildren(...items: any[]) { this.children = []; this.append(...items); }
    contains(node: any): boolean { return node === this || this.children.some((child) => child.contains?.(node)); }
    all(test: (node: El) => boolean): El[] { return [...(test(this) ? [this] : []), ...this.children.flatMap((child) => child.all?.(test) ?? [])]; }
    closest() { return null; } querySelector() { return null; } querySelectorAll() { return []; } focus() {} remove() {}
    scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; }
  }
  const previous = { document: (globalThis as any).document, localStorage: (globalThis as any).localStorage, window: (globalThis as any).window };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  const body = new El('body');
  (globalThis as any).document = { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag),
    body, activeElement: null, addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {} };
  t.after(() => Object.assign(globalThis, previous));
  return body;
}

test('the task list shows a batch as a group with its progress above the status groups; its cards carry the batch', async (t) => {
  const body = mockDom(t);
  const workspace = { labels: [], roles: [], memberRoles: [], nextCursor: null, batches: [batch],
    tasks: [{ id: 'x', number: 4, title: 'loose', status: 'pending', createdAt: '2026-01-04' },
      ...batch.tasks.map((item, i) => ({ id: item.id, number: item.number, title: item.title, status: item.status, batchId: 'b1', createdAt: `2026-01-0${i + 1}` }))] };
  const api = async (_method: string, url: string) => (url.includes('/workspace') ? workspace : {});
  const workbench = ui.createWorkbench({ api, getMembers: () => [], getHistoryMembers: () => [], getClusters: () => [{ id: 'c1', name: '群' }],
    nameOf: (id: string) => id, messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  workbench.open('c1');
  for (let i = 0; i < 10; i++) await new Promise((ok) => setImmediate(ok));
  const dialog = body.children.at(-1);
  const sections = dialog.all((node: any) => node.tagName === 'section' && /workbench-group /.test(node.attributes.class ?? ''));
  assert.equal(sections[0].attributes['data-batch-id'], 'b1', 'the batch comes first');
  assert.match(sections[0].textContent, /批次 B1 · chain/);
  assert.match(sections[0].textContent, /已提交 2\/3.*已通过 1\/3.*未齐/);
  const cards = (section: any) => section.all((node: any) => /^workbench-task /.test(node.attributes.class ?? '')).map((node: any) => node.textContent);
  assert.deepEqual(cards(sections[0]).map((text: string) => /#(\d)/.exec(text)![1]), ['1', '2', '3'], 'in dependency order');
  assert.ok(cards(sections[0]).every((text: string) => text.includes('B1')), 'each card names its batch');
  const rest = sections.slice(1).flatMap(cards);
  assert.deepEqual(rest.map((text: string) => /#(\d)/.exec(text)![1]), ['4'], 'batched tasks are not repeated in the status groups');
  const newBatch = dialog.all((node: any) => node.tagName === 'button' && node.textContent === '新建批次');
  assert.equal(newBatch.length, 1);
  dialog.close();
});

for (const hasBatch of [true, false]) {
  test(`an empty task list ${hasBatch ? 'shows its empty batch with details and cancellation' : 'keeps its ordinary empty state without batches'}`, async (t) => {
    const body = mockDom(t);
    const emptyBatch = { ...batch, total: 0, submitted: 0, approved: 0, tasks: [], missing: [] };
    const workspace = { labels: [], roles: [], memberRoles: [], nextCursor: null, tasks: [], batches: hasBatch ? [emptyBatch] : [] };
    const pending = Promise.withResolvers<object>();
    const api = async (_method: string, url: string) => (url.includes('/workspace') ? pending.promise : {});
    const workbench = ui.createWorkbench({ api, getMembers: () => [], getHistoryMembers: () => [], getClusters: () => [{ id: 'c1', name: '群' }],
      nameOf: (id: string) => id, messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
    workbench.open('c1');
    const dialog = body.children.at(-1);
    assert.match(dialog.textContent, /正在加载任务…/, 'a pending workspace keeps the loading state');
    assert.doesNotMatch(dialog.textContent, /还没有任务，创建一个开始协作。/);
    pending.resolve(workspace);
    for (let i = 0; i < 10; i++) await new Promise((ok) => setImmediate(ok));
    if (!hasBatch) {
      assert.equal(dialog.all((node: any) => node.attributes['data-batch-id']).length, 0);
      assert.match(dialog.textContent, /还没有任务，创建一个开始协作。/);
    } else {
      const section = dialog.all((node: any) => node.attributes['data-batch-id'] === 'b1')[0];
      assert.ok(section, 'the loaded empty batch is a real group');
      assert.match(section.textContent, /批次 B1 · chain/);
      assert.match(section.textContent, /已提交 0\/0.*已通过 0\/0.*未齐/);
      assert.match(section.textContent, /点击“新建任务”，在“验收批次”中选择这个批次/);
      assert.doesNotMatch(section.textContent, /manage_batch/);
      assert.doesNotMatch(dialog.textContent, /还没有任务，创建一个开始协作。/);
      const details = section.all((node: any) => node.tagName === 'button' && node.textContent === '批次详情')[0];
      details.listeners.get('click')[0]({});
      const detailDialog = body.children.at(-1);
      assert.equal(detailDialog.open, true);
      assert.match(detailDialog.textContent, /批次 B1 · chain/);
      const cancel = detailDialog.all((node: any) => node.tagName === 'button' && node.textContent === '取消批次')[0];
      assert.ok(cancel);
      assert.equal(cancel.hidden, false);
      cancel.listeners.get('click')[0]({});
      const cancelDialog = body.children.at(-1);
      assert.equal(cancelDialog.open, true);
      assert.match(cancelDialog.textContent, /取消批次 B1/);
      assert.equal(cancelDialog.all((node: any) => node.tagName === 'textarea' && node.attributes.required === '').length, 1);
      cancelDialog.close();
    }
    dialog.close();
  });
}

/** A workspace batch whose ship failed: a checks failure, optional attribution and fixes, and the digest it failed on. */
function failedBatch(overrides: any = {}) {
  return { ...batch, total: 2, submitted: 2, approved: 2, complete: true, allApproved: true, reviewer: { kind: 'member', memberId: 'r' },
    tasks: [{ id: 't1', number: 1, title: 'one', status: 'completed', state: 'approved', commitSha: 'aaaaaaa' },
      { id: 't2', number: 2, title: 'two', status: 'completed', state: 'approved', commitSha: 'bbbbbbb' }],
    shipFailure: { kind: 'checks', reason: 'checks: npm test failed', detail: 'test/x.test.ts:1 failed', failedCheck: 'npm test', digest: 'old-digest', runnerId: 'r', eventId: 42,
      attribution: null, fixes: [] },
    shipRunnerId: 'r', currentDigest: 'old-digest', shipFixAllowed: true, ...overrides };
}

async function openBatchDetail(t: TestContext, batches: any[]) {
  const body = mockDom(t);
  const workspace = { labels: [], roles: [], memberRoles: [], nextCursor: null, batches,
    tasks: batches.flatMap((item: any) => item.tasks.map((task: any) => ({ id: task.id, number: task.number, title: task.title, status: task.status, batchId: item.id, createdAt: '2026-01-01' }))) };
  const api = async (_method: string, url: string) => {
    if (url.includes('/workspace')) return workspace;
    if (url.includes('/tasks/')) return { task: { id: 't1', number: 1, title: 'one', status: 'completed', revision: 2 } };
    return {};
  };
  const workbench = ui.createWorkbench({ api, getMembers: () => [{ id: 'r', name: 'R' }], getHistoryMembers: () => [], getClusters: () => [{ id: 'c1', name: '群' }],
    nameOf: (id: string) => String(id).toUpperCase(), messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  workbench.open('c1');
  for (let i = 0; i < 10; i++) await new Promise((ok) => setImmediate(ok));
  const section = body.children.at(-1).all((node: any) => node.attributes['data-batch-id'] === batches[0].id)[0];
  const details = section.all((node: any) => node.tagName === 'button' && node.textContent === '批次详情')[0];
  details.listeners.get('click')[0]({});
  return { body, dialog: body.children.at(-1) };
}

test('a failed batch ship shows the structured failure and the rerun, attribution and ship_fix paths', async (t) => {
  const { dialog } = await openBatchDetail(t, [failedBatch()]);
  assert.match(dialog.textContent, /上次批次 ship 失败/);
  assert.match(dialog.textContent, /合并前检查未通过/);
  assert.match(dialog.textContent, /失败事件#42/);
  assert.match(dialog.textContent, /合并执行者R/);
  assert.match(dialog.textContent, /合并前检查未通过 checks: npm test failed/);
  assert.match(dialog.textContent, /失败的检查npm test/);
  assert.match(dialog.textContent, /完整诊断/);
  assert.match(dialog.textContent, /R 可以直接原样重跑批次 ship 命令/);
  assert.match(dialog.textContent, /检查失败还没有归因：批验收者 R 先在会话里调用 manage_batch attribute_failure（failureEventId 42）指定受影响任务/);
  assert.doesNotMatch(dialog.textContent, /已退回执行者/, 'a failed ship keeps every task completed');
  assert.equal(dialog.all((node: any) => node.tagName === 'button' && node.textContent === '重开任务').length, 2, 'every completed task can be reopened by the user');
  assert.ok(dialog.all((node: any) => node.tagName === 'button' && node.textContent === '取消批次').length, 'the user can still cancel the batch');
  dialog.close();
});

test('a repaired failed batch names the fresh-ticket state, the attribution, the fixes and the ship_fix handoff', async (t) => {
  const { dialog } = await openBatchDetail(t, [failedBatch({ currentDigest: 'new-digest',
    shipFailure: { kind: 'checks', reason: 'checks: npm test failed', detail: '', digest: 'old-digest', runnerId: 'r', eventId: 42,
      attribution: { taskIds: ['t1'], reason: 'test/x.test.ts 指向 A 的改动', by: 'r', at: '2026-11-20T00:00:00Z', eventId: 43 },
      fixes: [{ taskId: 't1', fromSubmissionId: 's1', toSubmissionId: 's2', toCommitSha: 'ccccccc', at: '2026-11-20T00:01:00Z' }] } })]);
  assert.match(dialog.textContent, /部分任务已原地修复：旧的批次 ship 票据已失效/);
  assert.match(dialog.textContent, /R 归因于 #1 one：test\/x.test.ts 指向 A 的改动/);
  assert.match(dialog.textContent, /已原地修复#1 one 至 ccccccc/);
  assert.match(dialog.textContent, /批验收者 R 可以在自己的会话里对受影响任务调用 task_action ship_fix（failureEventId 42）/);
  assert.doesNotMatch(dialog.textContent, /受影响任务的成员/);
  dialog.close();
});

test('a batch whose approval cannot be replaced in place offers only the rerun, reopen and cancel paths', async (t) => {
  const { dialog } = await openBatchDetail(t, [failedBatch({ reviewer: { kind: 'user' }, shipFixAllowed: false })]);
  assert.match(dialog.textContent, /这个批次不能原地换提交（用户验收、代点通过或后备 runner）：只能原样重跑/);
  assert.doesNotMatch(dialog.textContent, /manage_batch attribute_failure/);
  dialog.close();
});

test('a conflict failure names the conflicting task and points ship_fix at the batch reviewer', async (t) => {
  const { dialog } = await openBatchDetail(t, [failedBatch({ shipFailure: { kind: 'conflict', taskIds: ['t1'], reason: 'conflict: src/a.js',
    detail: 'both changed src/a.js', conflictFiles: ['src/a.js'], digest: 'old-digest', runnerId: 'r', eventId: 42, attribution: null, fixes: [] } })]);
  assert.match(dialog.textContent, /冲突任务#1 one/, 'the batch failure names the branch that conflicts');
  assert.match(dialog.textContent, /批验收者 R 可以在自己的会话里对受影响任务调用 task_action ship_fix（failureEventId 42）/);
  assert.doesNotMatch(dialog.textContent, /受影响任务的成员/);
  dialog.close();
});

test('reopening a task from the batch panel closes the panel, whose failure data is about to go stale', async (t) => {
  const { body, dialog } = await openBatchDetail(t, [failedBatch()]);
  const reopen = dialog.all((node: any) => node.tagName === 'button' && node.textContent === '重开任务')[0];
  await reopen.listeners.get('click')[0]({});
  for (let i = 0; i < 5; i++) await new Promise((ok) => setImmediate(ok));
  assert.equal(dialog.open, false, 'the batch panel closes before the reopen form opens');
  const form = body.all((node: any) => node.tagName === 'dialog' && node.open).at(-1);
  assert.ok(form);
  assert.match(form.textContent, /重开任务/, 'the ordinary reopen form opens');
  form.close();
});
