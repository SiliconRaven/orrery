import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const ui = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench.js')).href);
const form = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench-form.js')).href);
const { pastedFiles, attachMenu } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/ui.js')).href);

test('a submission shows its evidence messages\' attachments, then its bare evidence files', () => {
  const png = { id: 'png', name: 'shot.png', mime: 'image/png', size: 9 };
  const txt = { id: 'txt', name: 'log.txt', mime: 'application/octet-stream', size: 3 };
  const messageFiles = new Map([['m1', [png, txt]], ['elsewhere', [{ id: 'known', name: 'k.gif', mime: 'image/gif', size: 1 }]]]);
  const files = ui.submissionFiles({ evidenceMessageIds: ['m1', 'not-loaded'], evidenceFileIds: ['png', 'known', 'abcdef0123456789'] }, messageFiles);
  assert.deepEqual(files.map((file: any) => file.id), ['png', 'txt', 'known', 'abcdef0123456789'], 'a file cited both ways appears once');
  assert.equal(files[2].name, 'k.gif', 'metadata from any loaded message is used');
  assert.deepEqual(files[3], { id: 'abcdef0123456789', name: '证据附件 abcdef01' }, 'an unknown file has no mime, so it is tried as an image');
  assert.deepEqual(ui.submissionFiles({}, new Map()), []);
});

test('linked attachments appear once and skip what a submission already shows', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  assert.deepEqual(ui.linkedFiles([{ attachments: [a, b] }, { attachments: [b, c] }, { message: {} }], [a]), [b, c]);
  assert.deepEqual(ui.linkedFiles(undefined), []);
});

test('workbench dependency graph preserves an unloaded predecessor as unknown', () => {
  const graph = ui.taskGraph([
    { id: 'a', title: 'A', dependencyIds: [] },
    { id: 'b', title: 'B', dependencyIds: ['a', 'unloaded'] },
  ]);
  assert.deepEqual(graph.layers.map((layer: any[]) => layer.map((node) => node.id)), [['a', 'unloaded'], ['b']]);
  assert.equal(graph.layers[0][1].task, null);
  assert.deepEqual(graph.edges, [{ from: 'a', to: 'b' }, { from: 'unloaded', to: 'b' }]);
});

test('member collections classify shared messages under each task and only unlinked messages as other', async () => {
  const { collectionBins } = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/official-plugins/bookmarks.js')).href);
  const first = { message: { id: 'one' }, taskIds: ['a', 'b'] };
  const second = { message: { id: 'two' }, taskIds: [] };
  const bins = collectionBins([first, second]);
  assert.deepEqual([...bins.keys()], ['a', 'b', '']);
  assert.deepEqual(bins.get('a'), [first]);
  assert.deepEqual(bins.get('b'), [first]);
  assert.deepEqual(bins.get(''), [second]);
});

test('completed work with a changed dependency remains visibly subject to review', () => {
  assert.match(ui.taskStatus({ status: 'completed', completionValid: false, dependenciesReady: true }), /依赖已变化，需复核/);
  assert.match(ui.taskStatus({ status: 'working', dependenciesChanged: true }), /依赖已变化，需复核/);
  assert.equal(ui.taskStatus({ status: 'completed', completionValid: true }), '已完成');
  assert.match(ui.taskStatus({ status: 'pending', proposalState: 'proposed' }), /待批准/);
  assert.equal(ui.taskStatus({ status: 'cancelled', proposalState: 'proposed' }), '已取消');
  assert.match(ui.taskStatus({ status: 'merged', completionValid: false }), /依赖已变化，需复核/);
});

test('member and role colours stay stable per id, and avatars keep readable initials', () => {
  for (const id of ['member-a', '8f45a8cf-b5a4-42cc-ac68-229de0ccad75', '']) {
    assert.equal(ui.toneIndex(id), ui.toneIndex(id), id);
    const tone = ui.toneIndex(id);
    assert.ok(Number.isInteger(tone) && tone >= 0 && tone < 8, id);
  }
  assert.equal(ui.initials('Kimi'), 'KI');
  assert.equal(ui.initials('deep seek'), 'DS');
  assert.equal(ui.initials('张伟'), '张');
  assert.equal(ui.initials(''), '?');
});

test('closed tasks do not describe their ended assignments as unclaimed', () => {
  const nameOf = (id: string) => `成员 ${id}`;
  assert.equal(ui.taskAssignee({ status: 'completed', assignedMemberId: null }, nameOf), null);
  assert.equal(ui.taskAssignee({ status: 'cancelled', assignedMemberId: null }, nameOf), null);
  assert.equal(ui.taskAssignee({ status: 'merged', assignedMemberId: null }, nameOf), null);
  assert.equal(ui.taskAssignee({ status: 'pending', assignedMemberId: null }, nameOf), '未分配');
  assert.equal(ui.taskAssignee({ status: 'working', assignedMemberId: 'a' }, nameOf), '成员 a');
});

test('closed tasks keep their last owner and never read as unclaimed', () => {
  const assignments = [{ memberId: 'a' }, { memberId: 'b' }];
  assert.equal(ui.taskOwner({ status: 'working', assignedMemberId: 'x' }, assignments), 'x');
  assert.equal(ui.taskOwner({ status: 'completed', assignedMemberId: null }, assignments), 'b');
  assert.equal(ui.taskOwner({ status: 'cancelled', assignedMemberId: null }, assignments), 'b');
  assert.equal(ui.taskOwner({ status: 'merged', assignedMemberId: null }, assignments), 'b');
  assert.equal(ui.taskOwner({ status: 'pending', assignedMemberId: null }, assignments), null);
  assert.equal(ui.taskOwner({ status: 'completed', assignedMemberId: null }), null);
  assert.equal(ui.taskOwner({ status: 'completed', assignedMemberId: null }, assignments, false), null,
    'a page that may be truncated cannot name the final owner');
  assert.equal(ui.taskOwner({ status: 'working', assignedMemberId: 'x' }, [], false), 'x',
    'the active assignee is known without any history');
  assert.equal(ui.closedNote({ status: 'completed' }), '已结束');
  assert.equal(ui.closedNote({ status: 'cancelled' }), '已结束');
  assert.equal(ui.closedNote({ status: 'merged' }), '已结束');
  assert.equal(ui.closedNote({ status: 'pending' }), '未分配');
});

test('label filters accumulate, toggle off and collapse card labels past three', () => {
  assert.deepEqual(ui.toggleLabelFilter(['ui'], '功能'), ['ui', '功能'], 'clicking a second label adds it (AND)');
  assert.deepEqual(ui.toggleLabelFilter(['ui', '功能'], 'ui'), ['功能'], 'clicking an active label removes only it');
  assert.deepEqual(ui.toggleLabelFilter([], 'ui'), ['ui']);
  assert.deepEqual(ui.visibleLabels(['a', 'b', 'c', 'd', 'e'], 3), { shown: ['a', 'b', 'c'], more: 2 });
  assert.deepEqual(ui.visibleLabels([], 3), { shown: [], more: 0 });
});

test('label filter helpers split, dedupe and build AND queries', () => {
  assert.deepEqual(ui.filterLabels('ui, 视觉，ui ,  '), ['ui', '视觉']);
  assert.deepEqual(ui.filterLabels(undefined), []);
  assert.equal(ui.hasTaskFilters({ label: [] }), false, 'an empty label list is not a filter');
  assert.equal(ui.hasTaskFilters({ label: ['ui'] }), true);
  assert.equal(ui.hasTaskFilters({ status: 'working' }), true);
  assert.deepEqual([...ui.taskFilterQuery({ label: ['ui', 'high'], status: 'working' }, '42').entries()],
    [['label', 'ui'], ['label', 'high'], ['status', 'working'], ['cursor', '42']]);
});

test('the filter bar state becomes the workspace query: repeated labels, set fields only, then the page cursor', () => {
  assert.deepEqual([...ui.taskFilterQuery({ q: '登录', label: ['ui', '后端'], memberId: '', status: 'review' }, 'c9').entries()],
    [['q', '登录'], ['label', 'ui'], ['label', '后端'], ['status', 'review'], ['cursor', 'c9']]);
  assert.equal(ui.taskFilterQuery({ q: '', label: [], memberId: '', status: '' }).toString(), '', 'an idle bar asks for everything');
});

test('the four task orders sort in the page, missing fields last and ties in creation order', () => {
  // Server order is creation order: a is the oldest.
  const tasks = [
    { id: 'a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z', priority: 'low' },
    { id: 'b', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', priority: 'high' },
    { id: 'c', createdAt: '2026-01-02T00:00:00Z', priority: 'normal' },                     // same time as b, no updatedAt
    { id: 'd', priority: 'high' },                                                           // no times at all
    { id: 'e', createdAt: '2026-01-03T00:00:00Z', updatedAt: 'garbage' },                    // no priority, bad updatedAt
  ];
  const ids = (sort: string, q = '') => ui.sortTasks(tasks, sort, q).map((task: any) => task.id).join('');
  assert.equal(ui.DEFAULT_TASK_SORT, 'created-desc');
  assert.equal(ids('created-desc'), 'ecbad', 'newest first; b and c tie, the later created (c) first; no time last');
  assert.equal(ids('created-asc'), 'abced', 'oldest first; the tie keeps creation order');
  assert.equal(ids('updated-desc'), 'aecbd', 'updatedAt, else createdAt; c (created 01-02) ties b and the later created wins');
  assert.equal(ids('priority-desc'), 'dbeca', 'high, normal (missing counts as normal), low; ties newest created first');
  assert.equal(ids('no-such-sort'), ids('created-desc'), 'an unknown order is the default');
  assert.deepEqual(tasks.map((task) => task.id), ['a', 'b', 'c', 'd', 'e'], 'the input is not reordered');
  const hex = [{ id: '0001-aaaa', createdAt: '2026-01-01T00:00:00Z' }, { id: 'beef-0001', createdAt: '2026-01-02T00:00:00Z' }];
  assert.deepEqual(ui.sortTasks(hex, 'created-desc', 'BEEF').map((task: any) => task.id), ['beef-0001', '0001-aaaa']);
  assert.deepEqual(ui.sortTasks(hex, 'created-asc', 'beef-').map((task: any) => task.id), ['beef-0001', '0001-aaaa'], 'an id hit stays first, as the Hub ranks it');
  assert.deepEqual(ui.sortTasks(hex, 'created-asc', 'bee').map((task: any) => task.id), ['0001-aaaa', 'beef-0001'], 'under 4 hex digits is plain text');
  const numbered = [
    { id: 'aaaa-0001', number: 12, createdAt: '2026-01-01T00:00:00Z' },
    { id: '0012-beef', number: 2, createdAt: '2026-01-02T00:00:00Z' },
  ];
  assert.deepEqual(ui.sortTasks(numbered, 'created-desc', '#2').map((task: any) => task.id), ['0012-beef', 'aaaa-0001'], '#number sorts first');
  assert.deepEqual(ui.sortTasks(numbered, 'created-asc', '2').map((task: any) => task.id), ['0012-beef', 'aaaa-0001'], 'bare digits match number and sort first');
  assert.deepEqual(ui.sortTasks(numbered, 'created-desc', '12').map((task: any) => task.id), ['aaaa-0001', '0012-beef'], 'number 12 beats newest');
  assert.equal(ui.sortNeedsAllPages('created-asc'), false, 'the Hub pages in this order');
  assert.equal(ui.sortNeedsAllPages('created-desc'), false, 'the default is also a Hub sort');
  for (const sort of ['updated-desc', 'priority-desc']) assert.equal(ui.sortNeedsAllPages(sort), true, sort);
});

test('a stored filter and sort choice is restored per cluster, dropping what the cluster no longer has', () => {
  const stored = JSON.stringify({ version: 1, sort: 'priority-desc',
    filters: { q: '登录', label: ['ui', 'gone', 'ui', 3], memberId: 'removed', status: 'review' } });
  const restored = ui.storedTaskView(stored, { memberIds: ['m1'] });
  assert.deepEqual(restored, { filters: { q: '登录', label: ['ui', 'gone'], memberId: '', status: 'review' }, sort: 'priority-desc', quick: '' },
    'a removed member goes at once; labels wait for the Hub to list them');
  assert.equal(ui.storedTaskView(stored, { memberIds: ['removed'] }).filters.memberId, 'removed');
  assert.deepEqual(ui.withKnownLabels(restored.filters, ['ui', '后端']), { q: '登录', label: ['ui'], memberId: '', status: 'review' });
  assert.equal(ui.withKnownLabels(restored.filters, ['ui', 'gone']), restored.filters, 'nothing dropped: the same object, so no second refresh');
  assert.equal(ui.withKnownLabels(restored.filters, undefined), restored.filters, 'an old Hub without a label list drops nothing');
  const defaults = { filters: { q: '', label: [], memberId: '', status: '' }, sort: 'created-desc', quick: '' };
  for (const bad of [null, '', 'not json', '[]', '{"version":2,"sort":"created-asc"}', JSON.stringify({ version: 1, sort: 'sideways', filters: { status: 'toString' } }),
    // Valid JSON of the wrong shape: an object with toString: null used to throw while converting it to a key.
    '{"version":1,"filters":{"status":{"toString":null}}}',
    JSON.stringify({ version: 1, sort: ['created-asc'], filters: { q: 5, memberId: ['m1'], status: ['review'], label: [{ toString: null }, 7, null] } }),
    JSON.stringify({ version: 1, sort: { toString: null }, filters: [] }),
    JSON.stringify({ version: 1, quick: 'toString' }), JSON.stringify({ version: 1, quick: ['review'] }), '{"version":1,"quick":{"toString":null}}']) {
    assert.deepEqual(ui.storedTaskView(bad), defaults, String(bad));
  }
  assert.equal(ui.taskViewStorageKey('c1'), 'orrery.workbench.taskView.c1');
});

test('quick views keep only their tasks: in review for the user, awaiting approval, working', () => {
  const tasks = [
    { id: 'r-user', status: 'review', reviewer: { kind: 'user' } },
    { id: 'r-member', status: 'review', reviewer: { kind: 'member', memberId: 'm1' } },
    { id: 'r-self', status: 'review', reviewer: { kind: 'self' } },
    { id: 'proposed', status: 'pending', proposalState: 'proposed' },
    { id: 'approved', status: 'pending', proposalState: 'approved', requiresApproval: true },
    { id: 'proposed-cancelled', status: 'cancelled', proposalState: 'proposed' },
    { id: 'working', status: 'working', reviewer: { kind: 'user' } },
    { id: 'done', status: 'completed', reviewer: { kind: 'user' } },
  ];
  const ids = (quick: string) => ui.quickViewTasks(tasks, quick).map((task: any) => task.id);
  assert.deepEqual(ui.QUICK_VIEWS.map(([id, caption]: any) => [id, caption]), [['review', '等我验收'], ['approval', '待我批准'], ['working', '进行中']]);
  assert.deepEqual(ids('review'), ['r-user'], 'a member or self review is not for the user to accept');
  assert.deepEqual(ids('approval'), ['proposed'], 'approved, or no longer pending, is not waiting for approval');
  assert.deepEqual(ids('working'), ['working']);
  assert.equal(ui.quickViewTasks(tasks, ''), tasks, 'no view keeps the list as it is');
  assert.equal(ui.quickViewTasks(tasks, 'toString'), tasks, 'an unknown view keeps everything');
});

test('a quick view combines with the Hub filters and the sort, and is restored with the rest of the view', () => {
  // The Hub already applied the label filter: these are the 前端 tasks, in server (creation) order.
  const labelled = [
    { id: 'a', status: 'working', labels: ['前端'], createdAt: '2026-01-01T00:00:00Z', priority: 'low' },
    { id: 'b', status: 'review', reviewer: { kind: 'user' }, labels: ['前端'], createdAt: '2026-01-02T00:00:00Z' },
    { id: 'c', status: 'working', labels: ['前端'], createdAt: '2026-01-03T00:00:00Z', priority: 'high' },
    { id: 'd', status: 'working', labels: ['前端'], createdAt: '2026-01-04T00:00:00Z' },
  ];
  const shown = (quick: string, sort: string) => ui.sortTasks(ui.quickViewTasks(labelled, quick), sort).map((task: any) => task.id).join('');
  assert.equal(shown('working', 'created-desc'), 'dca');
  assert.equal(shown('working', 'priority-desc'), 'cda', 'the sort still orders what the view keeps');
  assert.equal(shown('review', 'created-asc'), 'b');
  assert.equal(shown('approval', 'created-desc'), '', 'an empty view shows the no-match text');
  const stored = JSON.stringify({ version: 1, sort: 'priority-desc', quick: 'working', filters: { label: ['前端'], status: '' } });
  assert.deepEqual(ui.storedTaskView(stored), { filters: { q: '', label: ['前端'], memberId: '', status: '' }, sort: 'priority-desc', quick: 'working' });
  assert.equal(ui.storedTaskView(JSON.stringify({ version: 1, quick: 'approval' })).quick, 'approval', 'a view alone is remembered too');
});

test('a refresh loads enough pages for what is on screen, even when load more ran while it waited', async () => {
  const page = (from: number, to: number, nextCursor: string | null) => ({ tasks: Array.from({ length: to - from + 1 }, (_, i) => ({ id: `t${from + i}` })), nextCursor });
  const pages: Record<string, any> = { 50: page(51, 100, '100'), 100: page(101, 136, null) };
  const waiting: { cursor: string; resolve: (value: any) => void }[] = [];
  const fetchPage = (cursor: string) => new Promise((resolve) => waiting.push({ cursor, resolve }));
  const answer = async () => { await new Promise((ok) => setImmediate(ok)); const call = waiting.shift()!; call.resolve(pages[call.cursor]); return call.cursor; };

  // 100 tasks on screen in created-asc; the refresh waits for page 2 while "load more" brings the screen to 136.
  const screen = { count: 100 };
  const commits: any[] = [];
  const commit = (workspace: any) => commits.push(workspace);
  const run = ui.loadTaskPages(page(1, 50, '50'), fetchPage, { needAll: () => false, shown: () => screen.count, stale: () => false, commit });
  await new Promise((ok) => setImmediate(ok));
  screen.count = 136;
  assert.equal(await answer(), '50');
  assert.equal(await answer(), '100', 'the refresh fetches the page load more added');
  assert.equal(await run, true);
  assert.deepEqual(commits.map((w) => [w.tasks.length, w.nextCursor]), [[136, null]], '136 on screen stays 136, committed once');

  // Nothing more on screen: the refresh stops at what is shown; a newer request makes it give up without committing.
  commits.length = 0;
  const two = ui.loadTaskPages(page(1, 50, '50'), fetchPage, { needAll: () => false, shown: () => 100, stale: () => false, commit });
  await answer();
  assert.deepEqual([await two, commits.map((w) => w.tasks.length), waiting.length], [true, [100], 0]);
  commits.length = 0;
  const loaded: number[] = [];
  let stale = false;
  const all = ui.loadTaskPages(page(1, 50, '50'), fetchPage, { needAll: () => true, shown: () => 0, stale: () => stale, commit, progress: (n: number) => loaded.push(n) });
  await answer();
  stale = true;
  await answer();
  assert.deepEqual([await all, commits.length], [false, 0]);
  assert.deepEqual(loaded, [50, 100], 'progress before each page');
});

function mockWorkbenchDom(t: TestContext) {
  // A permissive stand-in for the DOM, enough for the workbench to open and draw its task list.
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
    scrolledInto: unknown = null; scrollIntoView(options: unknown) { this.scrolledInto = options; }
    showModal() { this.open = true; } close() { this.open = false; }
    reportValidity() { return !this.all((node) => node.attributes.type === 'checkbox' && 'required' in node.attributes && !node.checked).length; }
  }
  const previous = { document: (globalThis as any).document, localStorage: (globalThis as any).localStorage, window: (globalThis as any).window };
  // The redraw gate listens for the pointer's release on the window.
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  const body = new El('body');
  (globalThis as any).document = { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag),
    body, activeElement: null, addEventListener() {}, removeEventListener() {} };
  (globalThis as any).localStorage = { getItem: () => null, setItem() {} };
  t.after(() => Object.assign(globalThis, previous));
  return body;
}

test('a refresh and a load more answered in the same tick never redraw fewer tasks than were shown', async (t) => {
  const body = mockWorkbenchDom(t);

  const page = (from: number, to: number, nextCursor: string | null) => ({ labels: [], roles: [], memberRoles: [], nextCursor,
    tasks: Array.from({ length: to - from + 1 }, (_, i) => ({ id: `t${from + i}`, title: `T${from + i}`, status: 'pending', createdAt: new Date(Date.UTC(2026, 0, 1, 0, from + i)).toISOString() })) });
  const pages: Record<string, any> = { '': page(1, 50, '50'), 50: page(51, 100, '100'), 100: page(101, 136, null) };
  const waiting: { cursor: string; answer: () => void }[] = [];
  const api = (_method: string, url: string) => new Promise((resolve) => {
    const params = new URL(url, 'http://x').searchParams;
    const cursor = params.get('cursor') ?? '';
    assert.equal(params.get('sort'), 'created-desc', 'the default requests the Hub sort');
    assert.equal(params.get('pageOnly'), cursor ? '1' : null, 'only continuations omit metadata');
    waiting.push({ cursor, answer: () => resolve(pages[cursor]) });
  });
  const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok)); };
  const take = async (cursor: string) => { await tick(); const index = waiting.findIndex((call) => call.cursor === cursor); assert.ok(index >= 0, `a request for page ${cursor || 1}`); return waiting.splice(index, 1)[0]; };

  // Both orders of the two answers within one tick: refresh first (its result commits, then load more appends to it),
  // and load more first (the refresh then sees 136 on screen and fetches page 3 itself).
  for (const refreshFirst of [true, false]) {
    const workbench = ui.createWorkbench({ api, getMembers: () => [], getHistoryMembers: () => [], getClusters: () => [{ id: 'c1', name: '群' }],
      nameOf: (id: string) => id, messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
    const dialog = body.children.at(-1);
    const content = dialog.all((node: typeof body) => node.attributes.class === 'workbench-content')[0];
    const draws: number[] = [];
    const replace = content.replaceChildren.bind(content);
    content.replaceChildren = (...items: any[]) => { replace(...items); draws.push(content.all((node: typeof body) => /^workbench-task /.test(node.attributes.class ?? '')).length); };
    const loadMore = () => { const button = content.all((node: typeof body) => node.tagName === 'button' && node.textContent === '加载更多任务')[0]; for (const fn of button.listeners.get('click') ?? []) void fn({}); };

    workbench.open('c1');
    (await take('')).answer();
    await tick();
    assert.equal(draws.at(-1), 50, 'opening the default list renders one page');
    assert.equal(waiting.length, 0, 'remaining task pages wait for load more');
    loadMore();
    (await take('50')).answer();
    await tick();
    assert.equal(draws.at(-1), 100, '100 tasks on screen');

    void workbench.refresh();
    (await take('')).answer();
    const refreshPage2 = await take('50');   // the refresh needs page 2 to match the screen
    loadMore();
    const morePage3 = await take('100');
    if (refreshFirst) { refreshPage2.answer(); morePage3.answer(); } else { morePage3.answer(); refreshPage2.answer(); }
    await tick(20);
    if (!refreshFirst) (await take('100')).answer();   // the refresh's own page 3
    await tick(20);
    const first136 = draws.indexOf(136);
    const label = `${refreshFirst ? 'refresh' : 'load more'} answered first: ${draws.join(',')}`;
    assert.ok(first136 >= 0, `136 was shown (${label})`);
    assert.deepEqual(draws.slice(first136).filter((n) => n < 136), [], `no redraw with fewer tasks after 136 (${label})`);
    assert.equal(draws.at(-1), 136, label);
    assert.equal(waiting.length, 0, label);
    dialog.close();
  }
});

test('tasks are grouped by status family while keeping the loaded order', () => {
  const tasks = [
    { id: 'p1', status: 'pending' }, { id: 'w1', status: 'working' }, { id: 'r1', status: 'review' },
    { id: 'c1', status: 'completed' }, { id: 'x1', status: 'cancelled' }, { id: 'a1', status: 'working' },
    { id: 'w2', status: 'working' }, { id: 'm1', status: 'mystery' },
    { id: 'p2', status: 'pending', proposalState: 'proposed' }, { id: 'a2', status: 'pending', proposalState: 'proposed' },
    { id: 'x2', status: 'cancelled', proposalState: 'proposed' }, { id: 'g1', status: 'merged', proposalState: 'proposed' },
  ];
  const groups = ui.taskGroups(tasks);
  assert.deepEqual(groups.map((group: any) => group.key), ['approval', 'active', 'review', 'pending', 'completed', 'merged', 'cancelled']);
  assert.deepEqual(groups.map((group: any) => group.title), ['待批准', '进行中', '待验收', '待开工', '已完成', '已合并', '已关闭']);
  assert.deepEqual(groups[0].tasks.map((task: any) => task.id), ['p2', 'a2']);
  assert.deepEqual(groups[1].tasks.map((task: any) => task.id), ['w1', 'a1', 'w2'], 'accepted joins active and the loaded order holds');
  assert.deepEqual(groups[2].tasks.map((task: any) => task.id), ['r1']);
  assert.deepEqual(groups[3].tasks.map((task: any) => task.id), ['p1']);
  assert.deepEqual(groups[5].tasks.map((task: any) => task.id), ['g1']);
  assert.deepEqual(groups[6].tasks.map((task: any) => task.id), ['x1', 'x2'], 'closed status takes precedence over proposed');
  assert.deepEqual(ui.taskGroups([{ id: 'z', status: 'working' }]).map((group: any) => group.key), ['active'], 'empty groups are dropped');
  assert.deepEqual(ui.taskGroups([]), []);
  for (const [status, key] of [['working', 'active'], ['review', 'review'],
    ['pending', 'pending'], ['completed', 'completed'], ['merged', 'merged'], ['cancelled', 'cancelled']]) {
    assert.deepEqual(ui.taskGroups([{ status }])[0].key, key, status);
  }
});

test('task group folding keeps working when localStorage cannot be read or written', () => {
  // No localStorage in Node at all: defaults, then the toggle stays visible for this page.
  assert.deepEqual([...ui.collapsedTaskGroups('cluster-x')], ['completed', 'merged', 'cancelled']);
  ui.toggleTaskGroup('cluster-x', 'completed');
  assert.ok(!ui.collapsedTaskGroups('cluster-x').has('completed'), 'expanding completed is visible without storage');
  ui.toggleTaskGroup('cluster-x', 'completed');
  assert.ok(ui.collapsedTaskGroups('cluster-x').has('completed'), 'and collapsing it again too');
  // Reads work but writes throw (quota/private mode): the page state still flips, consecutive toggles included.
  const stored = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => stored.has(key) ? stored.get(key) : null,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: (key: string) => stored.delete(key),
  };
  try {
    ui.toggleTaskGroup('cluster-y', 'completed');
    assert.ok(!ui.collapsedTaskGroups('cluster-y').has('completed'), 'the toggle is rendered even though the write failed');
    ui.toggleTaskGroup('cluster-y', 'completed');
    assert.ok(ui.collapsedTaskGroups('cluster-y').has('completed'), 'consecutive toggles keep flipping the page state');
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test('task group folding defaults to open for work and closed for finished groups', () => {
  assert.deepEqual([...ui.defaultCollapsedTaskGroups()], ['completed', 'merged', 'cancelled']);
  assert.deepEqual([...ui.storedCollapsedTaskGroups('["review","completed"]')], ['review', 'completed', 'merged']);
  assert.deepEqual([...ui.storedCollapsedTaskGroups('{"version":2,"collapsed":["review"]}')], ['review'], 'a user can keep merged expanded');
  assert.equal(ui.storedCollapsedTaskGroups('{"review":true}'), null, 'only an array is a stored preference');
  assert.equal(ui.storedCollapsedTaskGroups('junk'), null);
  assert.deepEqual([...ui.storedCollapsedTaskGroups('["unknown","review"]')], ['review', 'merged'], 'old preferences keep known keys and default the new group closed');
});

test('legacy folding preferences survive and the new merged group can stay expanded', () => {
  const key = ui.taskGroupsStorageKey('legacy-cluster');
  const saved = new Map([[key, '["review"]']]);
  (globalThis as any).localStorage = {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => saved.set(name, value),
  };
  try {
    assert.deepEqual([...ui.collapsedTaskGroups('legacy-cluster')], ['review', 'merged']);
    ui.toggleTaskGroup('legacy-cluster', 'merged');
    assert.deepEqual([...ui.storedCollapsedTaskGroups(saved.get(key))], ['review']);
    assert.deepEqual([...ui.collapsedTaskGroups('legacy-cluster')], ['review']);
  } finally { delete (globalThis as any).localStorage; }
});

test('dependency and completion warnings stay visible wherever a task is rendered', () => {
  assert.equal(ui.needsReview({ status: 'completed', completionValid: false }), true);
  assert.equal(ui.needsReview({ status: 'completed', completionValid: true }), false);
  assert.equal(ui.needsReview({ status: 'merged', completionValid: false }), true);
  assert.equal(ui.needsReview({ status: 'working', dependenciesChanged: true }), true);
  assert.equal(ui.needsReview({ status: 'working', dependenciesChanged: false }), false);
  assert.equal(ui.needsReview({ status: 'review', dependenciesReady: false }), false, 'only the recorded warnings count');
});

test('approval and merge controls reflect only eligible task states', () => {
  assert.equal(ui.pendingApproval({ status: 'pending', proposalState: 'proposed' }), true);
  for (const status of ['working', 'review', 'completed', 'merged', 'cancelled']) {
    assert.equal(ui.pendingApproval({ status, proposalState: 'proposed' }), false, status);
  }
  assert.equal(ui.pendingMerge({ status: 'completed', mergeRequired: true }), true);
  assert.equal(ui.pendingMerge({ status: 'completed' }), false, 'legacy tasks do not require a merge');
  assert.equal(ui.pendingMerge({ status: 'merged', mergeRequired: true }), false);
});

test('submission replacement uses the authoritative latest id and tolerates old records', () => {
  assert.equal(ui.supersededSubmission({ latestSubmissionId: 'new' }, { id: 'old' }), true);
  assert.equal(ui.supersededSubmission({ latestSubmissionId: 'new' }, { id: 'new' }), false);
  assert.equal(ui.supersededSubmission({}, { id: 'old' }), false, 'missing legacy task field is not guessed');
  assert.equal(ui.supersededSubmission({ latestSubmissionId: null }, { id: 'old' }), true);
});

test('the task detail shows one primary action for the state, its negative beside it, and the rest in 更多', () => {
  const plan = (task: object) => ui.taskActionPlan({ status: 'pending', ...task });
  assert.deepEqual(plan({ proposalState: 'proposed' }), { primary: 'approve', negative: 'rejectTask', more: ['edit', 'markCompleted', 'markMerged', 'gitBranch', 'public', 'cancel'] });
  assert.deepEqual(plan({}), { primary: 'assign', negative: null, more: ['edit', 'markCompleted', 'markMerged', 'gitBranch', 'public', 'cancel'] });
  assert.deepEqual(plan({ assignedMemberId: 'a' }), { primary: null, negative: null,
    more: ['edit', 'assign', 'release', 'handoff', 'markCompleted', 'markMerged', 'gitBranch', 'public', 'cancel'] }, 'an assigned task keeps 分配执行者 in the menu');
  assert.deepEqual(plan({ status: 'working', assignedMemberId: 'a' }), { primary: null, negative: null,
    more: ['reviewer', 'release', 'handoff', 'markCompleted', 'markMerged', 'gitBranch', 'public', 'cancel'] }, 'after work starts 更换验收人 replaces 编辑任务');
  assert.deepEqual(plan({ status: 'review', assignedMemberId: 'a', latestSubmissionId: 's' }),
    { primary: 'accept', negative: 'rejectResult', more: ['reviewer', 'release', 'handoff', 'markCompleted', 'markMerged', 'gitBranch', 'public', 'cancel'] });
  assert.equal(plan({ status: 'review' }).primary, null, 'nothing to accept without a submission');
  assert.deepEqual(plan({ status: 'completed', mergeRequired: true }), { primary: 'merge', negative: null, more: ['markMerged', 'gitBranch', 'public', 'reopen'] });
  assert.deepEqual(plan({ status: 'completed', mergeRequired: true, manualCompletion: true }),
    { primary: 'markMerged', negative: null, more: ['gitBranch', 'public', 'reopen'] });
  assert.deepEqual(plan({ status: 'completed', mergeRequired: true, completionValid: false }),
    { primary: 'merge', negative: null, more: ['markCompleted', 'markMerged', 'gitBranch', 'public', 'reopen'] });
  assert.deepEqual(plan({ status: 'completed' }), { primary: null, negative: null, more: ['markMerged', 'gitBranch', 'public', 'reopen'] });
  assert.deepEqual(plan({ status: 'merged' }), { primary: null, negative: null, more: ['gitBranch', 'public', 'reopen'] });
  assert.deepEqual(plan({ status: 'merged', gitBranch: { branch: 'main' } }),
    { primary: null, negative: null, more: ['gitBranch', 'clearGitBranch', 'public', 'reopen'] });
  assert.deepEqual(plan({ status: 'merged', completionValid: false }), { primary: null, negative: null, more: ['markMerged', 'gitBranch', 'public', 'reopen'] });
  assert.deepEqual(plan({ status: 'cancelled' }), { primary: null, negative: null, more: ['markCompleted', 'markMerged', 'gitBranch', 'public', 'reopen', 'delete'] });
});

test('task detail confirms manual completion and records a manual merge without requiring a SHA', async (t) => {
  const body = mockWorkbenchDom(t);
  const actions: object[] = [];
  const task = { id: 't1', title: '任务', status: 'working', revision: 1, currentAssignmentId: 'a1', mergeRequired: true,
    manualCompletion: false, assignedMemberId: null as string | null };
  const api = async (method: string, url: string, args: Record<string, unknown>) => {
    if (method === 'POST') {
      assert.equal(url, '/api/clusters/c1/collaboration');
      const { operationId, ...action } = args;
      assert.equal(typeof operationId, 'string');
      actions.push(action);
      Object.assign(task, { status: action.action === 'task.mark_completed' ? 'completed' : 'merged',
        revision: task.revision + 1, currentAssignmentId: null, manualCompletion: true });
      return { task };
    }
    if (url.includes('/workspace')) return { tasks: [task], labels: [], roles: [], memberRoles: [], nextCursor: null };
    if (url.endsWith('/context')) return {};
    return { task, assignments: [], merges: task.status === 'merged' ? [{ manual: true, commitSha: null, recordedBy: { kind: 'user' } }] : [] };
  };
  const workbench = ui.createWorkbench({ api, getMembers: () => [], getHistoryMembers: () => [], getClusters: () => [{ id: 'c1', name: '群' }],
    nameOf: (id: string) => id, messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  const button = (caption: string) => {
    const node = body.all((node) => node.tagName === 'button' && node.textContent === caption)[0];
    assert.ok(node, `visible operation ${caption}`);
    return node;
  };
  const fire = (node: typeof body, event: string) => Promise.all((node.listeners.get(event) ?? []).map((fn) => fn({ preventDefault() {} })));
  const activeForm = () => {
    const dialog = body.all((node) => node.tagName === 'dialog' && node.open).at(-1)!;
    return dialog.all((node) => node.tagName === 'form')[0];
  };
  workbench.openTask('c1', 't1');
  await new Promise((done) => setImmediate(done));
  await fire(button('更多'), 'click');
  const complete = button('标记为已完成');
  await fire(complete, 'click');
  const menu = body.all((node) => node.attributes.role === 'menu')[0];
  for (const fn of menu.listeners.get('click') ?? []) fn({ target: { closest: () => complete } });
  const completeForm = activeForm();
  const confirmation = completeForm.all((node) => node.attributes.type === 'checkbox')[0];
  await fire(completeForm, 'submit');
  assert.deepEqual(actions, [], 'an active assignment requires confirmation before posting');
  confirmation.checked = true;
  completeForm.all((node) => node.tagName === 'textarea')[0].value = ' 完成说明 ';
  await fire(completeForm, 'submit');
  assert.deepEqual(actions, [{ action: 'task.mark_completed', taskId: 't1', expectedRevision: 1, reason: '完成说明', confirmStopped: true }]);

  await fire(button('标记为已合并'), 'click');
  const mergeForm = activeForm();
  assert.equal(mergeForm.all((node) => node.tagName === 'input' && 'required' in node.attributes).length, 0);
  await fire(mergeForm, 'submit');
  assert.deepEqual(actions[1], { action: 'task.mark_merged', taskId: 't1', expectedRevision: 2 });
  assert.match(body.textContent, /用户手动标记已合并 · 未填提交号/);
});

test('task detail links and clears a local Git branch, and ignores suggestions for a previous path', async (t) => {
  const body = mockWorkbenchDom(t);
  const firstPath = 'C:\\Projects\\First Repo';
  const secondPath = 'D:\\Projects\\Second Repo';
  const manualPath = 'D:\\Projects\\Linked Worktree';
  const firstBranches = Promise.withResolvers<{ branches: string[] }>();
  const secondBranches = Promise.withResolvers<{ branches: string[] }>();
  const repoUrl = '/api/clusters/c1/task-repositories';
  const reads: string[] = [];
  const writes: object[] = [];
  const events: object[] = [];
  type GitBranch = { repositoryPath: string; branch: string };
  const task = { id: 't1', title: '任务', status: 'working', revision: 1, gitBranch: null as GitBranch | null };
  const api = async (method: string, url: string, args: Record<string, unknown>) => {
    if (method === 'POST') {
      assert.equal(url, '/api/clusters/c1/collaboration');
      const { operationId, ...action } = args;
      assert.equal(typeof operationId, 'string');
      writes.push(action);
      const before = task.gitBranch;
      task.gitBranch = action.gitBranch as GitBranch | null;
      task.revision++;
      events.unshift({ seq: task.revision, payload: { action: action.action,
        changes: [{ field: 'gitBranch', before, after: task.gitBranch }] } });
      return { task };
    }
    if (url.startsWith(repoUrl)) {
      reads.push(url);
      if (url === repoUrl) return { repositories: [{ path: firstPath, label: 'First Repo' }, { path: secondPath, label: 'Second Repo' }] };
      if (url === repoUrl + '?path=' + encodeURIComponent(firstPath)) return firstBranches.promise;
      if (url === repoUrl + '?path=' + encodeURIComponent(secondPath)) return secondBranches.promise;
      if (url === repoUrl + '?path=' + encodeURIComponent(manualPath)) throw new Error('Git 暂时不可用');
      throw new Error('unexpected Git lookup ' + url);
    }
    if (url.includes('/workspace')) return { tasks: [task], labels: [], roles: [], memberRoles: [], nextCursor: null };
    if (url.endsWith('/context')) return {};
    return { task, events };
  };
  const workbench = ui.createWorkbench({ api, getMembers: () => [], getHistoryMembers: () => [],
    getClusters: () => [{ id: 'c1', name: '群' }], nameOf: (id: string) => id, messageName: () => '',
    showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  const tick = () => new Promise((done) => setImmediate(done));
  const fire = (node: typeof body, event: string, args: object = {}) => Promise.all(
    (node.listeners.get(event) ?? []).map((fn) => fn({ preventDefault() {}, ...args })));
  const menuAction = async (caption: string) => {
    const menu = body.all((node) => node.attributes.role === 'menu')[0];
    menu.hidden = 'hidden' in menu.attributes;
    await fire(body.all((node) => node.tagName === 'button' && node.textContent === '更多')[0], 'click');
    assert.equal(menu.hidden, false);
    const item = menu.all((node) => node.attributes.role === 'menuitem' && node.textContent === caption)[0];
    assert.ok(item, caption);
    await fire(item, 'click');
    await fire(menu, 'click', { target: { closest: () => item } });
  };

  workbench.openTask('c1', 't1');
  await tick();
  assert.deepEqual(reads, [], 'opening a task does not run Git discovery');
  await menuAction('关联 Git 分支');
  const modal = body.all((node) => node.tagName === 'dialog' && node.open).at(-1)!;
  const form = modal.all((node) => node.tagName === 'form')[0];
  // The fields' own suggestion lists (workbench-combobox.js), found by their accessible names.
  const options = (name: string) => form.all((node) => node.attributes['aria-label'] === name)[0]
    .all((node) => node.attributes.role === 'option').map((node) => node.attributes['data-value']);
  assert.deepEqual(options('本地仓库候选'), [firstPath, secondPath]);
  const [repository, branch] = form.all((node) => node.tagName === 'input');
  const selectRepository = (path: string) => {
    repository.value = path;
    void fire(repository, 'input');
    return fire(repository, 'change');
  };
  const first = selectRepository(firstPath);
  const second = selectRepository(secondPath);
  assert.deepEqual(reads, [repoUrl, ...[firstPath, secondPath].map((path) => repoUrl + '?path=' + encodeURIComponent(path))]);
  secondBranches.resolve({ branches: ['main', 'feature/local'] });
  await second;
  assert.deepEqual(options('本地分支候选'), ['main', 'feature/local']);
  firstBranches.resolve({ branches: ['stale'] });
  await first;
  assert.deepEqual(options('本地分支候选'), ['main', 'feature/local']);

  await selectRepository(' ' + manualPath + ' ');
  assert.deepEqual(options('本地分支候选'), []);
  assert.match(form.textContent, /读取本地分支失败.*也可直接填分支名/);
  branch.value = ' feature/future ';
  await fire(form, 'submit');
  assert.deepEqual(writes, [{ action: 'task.set_git_branch', taskId: 't1', expectedRevision: 1,
    gitBranch: { repositoryPath: manualPath, branch: 'feature/future' } }]);
  const values = () => body.all((node) => node.attributes.class?.split(' ').includes('wb-git-branch-value'))
    .map((node) => node.textContent);
  assert.deepEqual(values(), ['feature/future', manualPath]);
  const change = body.all((node) => node.attributes.class === 'task-diff')[0];
  change.open = true;
  await fire(change, 'toggle');
  await tick();
  assert.ok(change.textContent.includes('未设置 → feature/future（' + manualPath + '）'));

  await menuAction('解除 Git 分支关联');
  assert.deepEqual(writes[1], { action: 'task.set_git_branch', taskId: 't1', expectedRevision: 2, gitBranch: null });
  assert.deepEqual(values(), []);
});

test('task detail marks a branch a submit linked as 自动, and a manual one without it', async (t) => {
  const body = mockWorkbenchDom(t);
  const task = { id: 't1', title: '任务', status: 'review', revision: 3,
    gitBranch: { repositoryPath: 'D:\\Projects\\Repo', branch: 'topic', automatic: true } as { repositoryPath: string; branch: string; automatic?: true } };
  const api = async (_method: string, url: string) => url.includes('/workspace')
    ? { tasks: [task], labels: [], roles: [], memberRoles: [], nextCursor: null } : url.endsWith('/context') ? {} : { task, events: [] };
  const workbench = ui.createWorkbench({ api, getMembers: () => [], getHistoryMembers: () => [],
    getClusters: () => [{ id: 'c1', name: '群' }], nameOf: (id: string) => id, messageName: () => '',
    showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  const marks = () => body.all((node) => node.attributes.class?.split(' ').includes('wb-git-auto')).map((node) => node.textContent);
  workbench.openTask('c1', 't1');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(marks(), ['自动']);
  delete task.gitBranch.automatic;
  task.revision++;
  workbench.openTask('c1', 't1');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(marks(), []);
});

/** A workbench on task t1 of cluster c1 whose detail reads (GET …/tasks/t1) wait until the test answers them. */
function watcherBench(t: TestContext) {
  const body = mockWorkbenchDom(t);
  const task = { id: 't1', title: '任务', status: 'pending', revision: 1 };
  const reads: string[] = [];
  const pending: PromiseWithResolvers<object>[] = [];
  const api = async (_method: string, url: string) => {
    reads.push(url);
    if (url.includes('/workspace')) return { tasks: [task], labels: [], roles: [], memberRoles: [], nextCursor: null };
    if (url.endsWith('/context')) return {};
    const answer = Promise.withResolvers<object>();
    pending.push(answer);
    return answer.promise;
  };
  const workbench = ui.createWorkbench({ api, getMembers: () => [{ id: 'm1', name: 'A' }, { id: 'm2', name: 'B' }], getHistoryMembers: () => [],
    getClusters: () => [{ id: 'c1', name: '群' }], nameOf: (id: string) => ({ m1: 'A', m2: 'B' } as Record<string, string>)[id] ?? id,
    messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done)); };
  /** Answers detail read `index` with these watchers (and any other detail fields). */
  const answer = async (index: number, watchers: object[], extra: object = {}) => { pending[index].resolve({ task, events: [], watchers, ...extra }); await settle(); };
  const shown = () => body.all((node) => node.attributes.class === 'wb-watch').map((node) => node.textContent);
  const detailReads = () => reads.filter((url) => url === '/api/clusters/c1/tasks/t1').length;
  return { body, workbench, reads, pending, settle, answer, shown, detailReads };
}

test('the task detail lists its watchers as plain text; a watch of the task or a removed watcher re-reads only that detail', async (t) => {
  const { body, workbench, reads, settle, answer, shown } = watcherBench(t);
  workbench.openTask('c1', 't1');
  await settle();
  await answer(0, [{ memberId: 'm1', note: '<b>继续检查 #12</b>', createdAt: 'x' }, { memberId: 'm2', note: null, createdAt: 'y' }]);
  assert.equal(shown().length, 2);
  const notes = body.all((node) => node.attributes.class === 'wb-watch-note');
  assert.deepEqual(notes.map((node) => node.textContent), ['<b>继续检查 #12</b>'], 'the note is text, not markup; no note, no box');

  // Another task or another cluster: nothing is read.
  reads.length = 0;
  workbench.watchersChanged('c1', { taskId: 't2' });
  workbench.watchersChanged('other', { taskId: 't1' });
  workbench.watchersChanged('other');
  await settle();
  assert.deepEqual(reads, []);
  // A member removed by another request (no task id): the open detail drops it, and only the detail is read.
  workbench.watchersChanged('c1');
  await settle();
  await answer(1, [{ memberId: 'm2', note: null, createdAt: 'y' }]);
  assert.deepEqual(reads, ['/api/clusters/c1/tasks/t1'], 'not the task list or the context');
  assert.equal(shown().length, 1);
  // An unwatch of this task: the same narrow read.
  workbench.watchersChanged('c1', { taskId: 't1' });
  await settle();
  await answer(2, []);
  assert.equal(shown().length, 0);
  assert.equal(body.all((node) => node.tagName === 'span' && node.textContent === '关注').length, 0, 'no row without watchers');
});

test('watcher reads never go back in time: an older answer, a late full refresh, and a change during the first load', async (t) => {
  const { workbench, pending, settle, answer, shown, detailReads } = watcherBench(t);
  const one = [{ memberId: 'm1', note: null, createdAt: 'x' }];
  const two = [...one, { memberId: 'm2', note: null, createdAt: 'y' }];
  // A watch arrives while the detail is still loading: it re-reads once the load lands.
  workbench.openTask('c1', 't1');
  await settle();
  workbench.watchersChanged('c1', { taskId: 't1' });
  await settle();
  assert.equal(detailReads(), 1, 'nothing to re-read yet');
  await answer(0, one);
  assert.equal(detailReads(), 2, 'the load landed: one more read');
  await answer(1, two);
  assert.equal(shown().length, 2);

  // An older watch answer arrives after a newer unwatch answer: the newer stays.
  workbench.watchersChanged('c1', { taskId: 't1' });
  workbench.watchersChanged('c1', { taskId: 't1' });
  await settle();
  await answer(3, []);
  await answer(2, two);
  assert.equal(shown().length, 0, 'the late, older answer is dropped');

  // A full refresh starts, then a narrow read: the narrow answer lands first, the full refresh's later answer keeps it.
  workbench.changed({ kind: 'collaboration', clusterId: 'c1', payload: { action: 'task.edit', taskId: 't1' } });
  for (let waited = 0; pending.length < 5 && waited < 3000; waited += 20) await new Promise((done) => setTimeout(done, 20));   // 250 ms coalescing
  assert.equal(pending.length, 5, 'the full refresh is reading');
  workbench.watchersChanged('c1', { taskId: 't1' });
  await settle();
  await answer(5, one);
  assert.equal(shown().length, 1);
  await answer(4, two);
  assert.equal(shown().length, 1, 'the late full refresh does not bring back older watchers');

  // A watch read is in flight and has already fetched A (m1), which the screen does not show; then A is removed. The
  // removal re-reads although A is not listed, and the older answer, landing last, cannot bring A back.
  workbench.watchersChanged('c1', { taskId: 't1' });
  workbench.watchersChanged('c1');
  await settle();
  await answer(7, [{ memberId: 'm2', note: null, createdAt: 'y' }]);
  await answer(6, two);
  assert.equal(shown().length, 1, 'only B, whatever order the answers come in');
  assert.ok(!shown()[0].includes('A'));
});

test('a watchers re-read keeps the open detail object, so a history page in flight still lands', async (t) => {
  const { body, workbench, reads, pending, settle, answer, shown } = watcherBench(t);
  workbench.openTask('c1', 't1');
  await settle();
  await answer(0, [{ memberId: 'm1', note: null, createdAt: 'x' }], { nextCursor: '20', assignments: [] });
  const more = body.all((node) => node.tagName === 'button' && node.textContent === '加载更多派工与结果')[0];
  assert.ok(more, 'the detail has another page of records');
  for (const fn of more.listeners.get('click') ?? []) void fn({ preventDefault() {} });   // it waits for the page: answered below
  await settle();
  assert.equal(reads.at(-1), '/api/clusters/c1/tasks/t1?cursor=20', 'the next page is being read');
  workbench.watchersChanged('c1', { taskId: 't1' });
  await settle();
  await answer(2, [{ memberId: 'm1', note: null, createdAt: 'x' }, { memberId: 'm2', note: null, createdAt: 'y' }]);
  assert.equal(shown().length, 2);
  pending[1].resolve({ nextCursor: null, assignments: [{ id: 'a1', memberId: 'm1', acceptedAt: 'x', startedAt: null, endedAt: null }] });
  await settle();
  assert.equal(body.all((node) => node.tagName === 'button' && node.textContent === '加载更多派工与结果').length, 0, 'the page landed');
  assert.equal(shown().length, 2, 'and the watchers from the newer read stay');
});

test('closing 更多 by pressing another card selects that card on the first click, even with a redraw waiting', () => {
  // Fake events, timers and clock; attachMenu is the real one. The browser drops a click whose pressed element was
  // replaced, so the card's click counts only if no redraw ran between its pointerdown and its click.
  type Listener = (event: any) => void;
  const target = () => { const on = new Map<string, Listener[]>(); return { on,
    addEventListener(name: string, f: Listener) { on.set(name, [...(on.get(name) ?? []), f]); },
    removeEventListener(name: string, f: Listener) { on.set(name, (on.get(name) ?? []).filter((g) => g !== f)); },
    fire(name: string, event: any = {}) { for (const f of on.get(name) ?? []) f(event); } }; };
  const previous = (globalThis as any).document;
  const doc: any = { ...target(), activeElement: null };
  (globalThis as any).document = doc;
  try {
    let clock = 0;
    const timers: { at: number; f: () => void }[] = [];
    const later = (f: () => void, ms: number) => { timers.push({ at: clock + ms, f }); };
    const tick = (to = clock) => { clock = to; for (let due; (due = timers.findIndex((t) => t.at <= clock)) >= 0;) timers.splice(due, 1)[0].f(); };
    const root = target(), win = target();
    let draws = 0;
    let card = 'card-B, drawn 0';   // each redraw replaces every card element
    let selected = 'A';
    const node = (id: string) => ({ ...target(), id, hidden: false, attrs: {} as Record<string, string>, kids: [] as any[],
      setAttribute(k: string, v: string) { this.attrs[k] = v; }, focus() { doc.activeElement = this; },
      contains(other: any) { return other === this || this.kids.includes(other); },
      querySelectorAll() { return this.kids; }, closest() { return null; } });
    const button = node('more'), menu = node('menu');
    menu.hidden = true;
    menu.kids.push(node('item'));
    const redraw = () => { if (gate.request()) card = `card-B, drawn ${++draws}`; };
    const gate = ui.redrawGate(root, redraw, () => !menu.hidden, { win, ms: 1000, now: () => clock, later });
    attachMenu(button, menu, () => gate.settle());

    button.fire('click');
    assert.equal(menu.hidden, false, 'the menu is open');
    redraw();
    assert.equal(draws, 0, 'a background refresh waits while the menu is open');

    // Press card B: the press reaches the workbench first, then the page-wide listener closes the menu.
    const pressed = card;
    root.fire('pointerdown');
    doc.fire('pointerdown', { target: node('card-B') });
    assert.equal(menu.hidden, true, 'the press closed the menu');
    tick(clock + 100);   // the mouse is held 100 ms
    assert.equal(draws, 0, 'no redraw replaces the pressed card while it is held');
    win.fire('pointerup');
    if (card === pressed) selected = 'B';   // the click reaches the card only if it is still the pressed one
    assert.equal(selected, 'B', 'the first click selects B');
    tick();
    assert.equal(draws, 1, 'the waiting redraw runs right after the click');

    // No release ever arrives: the redraw still runs, at most a second after the press.
    root.fire('pointerdown');
    redraw();
    tick(clock + 999);
    assert.equal(draws, 1);
    tick(clock + 1);
    assert.equal(draws, 2, 'bounded fallback');

    // Closed by keyboard (Esc): the waiting redraw runs at once.
    win.fire('pointerup');
    tick();
    button.fire('click');
    redraw();
    menu.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    tick();
    assert.equal(draws, 3);
  } finally { (globalThis as any).document = previous; }
});

test('the task detail renders only the record sections that have records', () => {
  assert.deepEqual(ui.recordSections({ task: {}, attentions: [], submissions: [], reviews: [], approvals: [], merges: [], assignments: [] }), []);
  assert.deepEqual(ui.recordSections({ task: {} }), [], 'an old Hub may omit collections');
  assert.deepEqual(ui.recordSections({ task: {}, attentions: [{}], submissions: [{}], reviews: [{}], approvals: [{}], merges: [{}], assignments: [{}] }),
    ['attentions', 'submissions', 'reviews', 'approvals', 'merges', 'assignments']);
  assert.deepEqual(ui.recordSections({ task: { mergedCommitSha: 'abc1234' }, merges: [] }), ['merges'], 'a recorded merge commit shows 合并记录');
});

test('record pagination appends approvals and merges alongside the existing collections', () => {
  const first = { assignments: [{ id: 'a' }], submissions: [{ id: 's' }], reviews: [{ id: 'r', round: 7 }],
    attentions: [{ id: 'q' }], approvals: [{ id: 'p' }], merges: [{ id: 'm' }], nextCursor: '50' };
  const next = { assignments: [], submissions: [{ id: 's2' }], reviews: [{ id: 'r2', round: 8 }],
    attentions: [], approvals: [{ id: 'p2' }], merges: [{ id: 'm2' }], nextCursor: null };
  const merged = ui.appendTaskRecords(first, next);
  assert.deepEqual(merged.submissions.map((x: any) => x.id), ['s', 's2']);
  assert.deepEqual(merged.reviews.map((x: any) => x.round), [7, 8], 'round numbers come from the Hub');
  assert.deepEqual(merged.approvals.map((x: any) => x.id), ['p', 'p2']);
  assert.deepEqual(merged.merges.map((x: any) => x.id), ['m', 'm2']);
  assert.equal(merged.nextCursor, null);
  assert.deepEqual(ui.appendTaskRecords({ assignments: [], nextCursor: '1' }, { nextCursor: null }).approvals, []);
  assert.equal(first.nextCursor, '50', 'input is untouched');
});

test('permanently deleting a closed task says it cannot be undone and names the surviving messages', () => {
  const warning = ui.taskDeleteWarning({ title: '旧任务' }, 3);
  assert.match(warning, /旧任务/);
  assert.match(warning, /不能恢复/);
  assert.match(warning, /3 条关联群聊消息会保留/);
  assert.match(warning, /只解除与这个任务的关联/);
  assert.match(ui.taskDeleteWarning({ title: 'x' }, undefined), /0 条关联群聊消息/);
  assert.equal(ui.taskGroups([{ id: 'x', status: 'cancelled' }])[0].title, '已关闭', 'cancelled tasks are listed under the closed group');
  assert.equal(ui.taskGroups([{ id: 'x', status: 'completed' }])[0].title, '已完成', 'completed tasks keep their own group');
});

test('workbench refreshes once for a burst of events, and tells the chat only when titles or role names change', () => {
  const timers: (() => void)[] = [];
  let runs = 0;
  const schedule = ui.coalesce(() => { runs++; }, 250, { set: (f: () => void) => { timers.push(f); } });
  schedule(); schedule(); schedule();
  assert.equal(timers.length, 1, 'one timer for the burst');
  timers.shift()!();
  assert.equal(runs, 1);
  schedule();
  assert.equal(timers.length, 1, 'a later call schedules again');
  const a = { tasks: [{ id: 't', title: 'A', status: 'pending', revision: 1 }], roles: [{ id: 'r', name: 'R' }] };
  assert.equal(ui.workspaceLookupKey(a), ui.workspaceLookupKey({ ...a, tasks: [{ ...a.tasks[0], status: 'working', revision: 2 }] }),
    'a status change alone does not redraw the chat');
  assert.notEqual(ui.workspaceLookupKey(a), ui.workspaceLookupKey({ ...a, tasks: [{ ...a.tasks[0], title: 'B' }] }));
  assert.notEqual(ui.workspaceLookupKey(a), ui.workspaceLookupKey({ ...a, tasks: [{ ...a.tasks[0], number: 9 }] }));
  assert.notEqual(ui.workspaceLookupKey(a), ui.workspaceLookupKey({ ...a, roles: [{ id: 'r', name: 'S' }] }));
  assert.notEqual(ui.workspaceLookupKey(null), ui.workspaceLookupKey(a), 'the first load does');
});

test('the task form adds files up to the task limit, removes one, and sends only what is stored', () => {
  const saved = form.savedFormFile({ id: 'old', name: 'old.png', size: 3, mime: 'image/png' });
  assert.deepEqual(saved, { key: 'old', id: 'old', name: 'old.png', size: 3, mime: 'image/png', state: 'done' });
  const nine = Array.from({ length: 9 }, (_, i) => form.savedFormFile({ id: `s${i}`, name: 's', size: 1, mime: 'x' }));
  const added = form.addFormFiles(nine, [{ name: 'a.png', size: 1 }, { name: 'b.png', size: 1 }, { name: 'big.iso', size: 20 * 1024 * 1024 + 1 }], 5);
  assert.deepEqual(added.added.map((u: any) => [u.key, u.name, u.state]), [[5, 'a.png', 'uploading']]);
  assert.equal(added.list.length, 10);
  assert.equal(added.errors.length, 2);
  assert.match(added.errors.join(), /一个任务最多带 10 个文件，「b\.png」/);
  assert.match(added.errors.join(), /big\.iso/);

  let list = form.addFormFiles([saved], [{ name: 'pic.png', size: 2 }, { name: 'log.txt', size: 4 }], 1).list;
  assert.equal(form.formFilesProblem(list), '还有文件在上传，等上传完再保存');
  assert.deepEqual(form.formFileIds(list), ['old'], 'nothing is sent for a file still uploading');
  list = form.settleFormFile(list, 1, { id: 'pic', name: 'pic.png', size: 2, mime: 'image/png' });
  list = form.settleFormFile(list, 2, null, 'HTTP 413');
  assert.deepEqual(list.map((u: any) => [u.key, u.state, u.id, u.error]), [['old', 'done', 'old', undefined], [1, 'done', 'pic', undefined], [2, 'error', undefined, 'HTTP 413']]);
  assert.equal(form.formFilesProblem(list), '有文件上传失败，移除后再保存');
  list = form.removeFormFile(list, 2);
  assert.equal(form.formFilesProblem(list), null);
  assert.deepEqual(form.formFileIds(list), ['old', 'pic']);
  list = form.removeFormFile(list, 'old');
  assert.deepEqual(form.formFileIds(list), ['pic'], 'a saved file can be removed before saving');
  assert.deepEqual(form.settleFormFile(list, 9, { id: 'late' }).map((u: any) => u.id), ['pic'], 'an upload that finishes after its entry was removed does not bring it back');
});

test('a paste attaches files, names clipboard images, and leaves text pastes alone', () => {
  const now = new Date(2026, 10, 9, 8, 7, 6);
  const shot = new File(['x'], 'image.png', { type: 'image/png' });
  const doc = new File(['x'], 'report.pdf', { type: 'application/pdf' });
  const files = pastedFiles({ files: [shot, doc], types: ['Files'] }, now);
  assert.equal(files[0].as, '粘贴的图片-20261109-080706.png');
  assert.equal(files[1].as, undefined);
  assert.equal(pastedFiles({ files: [shot], types: ['Files', 'text/plain'] }, now), null);
  assert.equal(pastedFiles({ files: [], types: [] }, now), null);
});

/** Just enough DOM for formDialog and filesField; `fire` skips the browser's disabled check, so the handlers' own guards are tested. */
class FormNode {
  readonly tagName: string;
  readonly children: FormNode[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, ((event: unknown) => unknown)[]>();
  hidden = false; disabled = false; open = false; value = ''; files: unknown[] = [];
  text = '';
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(value: string) { this.text = value; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, listener: (event: unknown) => unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  append(...items: (FormNode | string)[]) {
    for (const item of items) {
      if (typeof item === 'string') { const node = new FormNode('#text'); node.text = item; this.children.push(node); } else this.children.push(item);
    }
  }
  replaceChildren(...items: FormNode[]) { this.children.splice(0, this.children.length); this.append(...items); }
  remove() {}
  reportValidity() { return true; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close', {}); }
  click() {}
  fire(name: string, event: unknown = {}) { return Promise.all((this.listeners.get(name) ?? []).map((listener) => listener(event))); }
  find(test: (node: FormNode) => boolean): FormNode | undefined {
    return test(this) ? this : this.children.map((child) => child.find(test)).find(Boolean);
  }
}

test('the task form hands its attachment lock to the dialog', () => {
  assert.match(readFileSync(join(REPO_ROOT, 'src/web/public/workbench.js'), 'utf8'), /fileIds: files\.ids\(\) };[\s\S]*?\}, files\.lock\);\n\s*modal\.addEventListener\('paste', files\.paste\);/);
});

test('a save in flight freezes the attachments; a failed save unlocks them and keeps the list', async (t) => {
  const previous = (globalThis as any).document;
  (globalThis as any).document = { createElement: (tag: string) => new FormNode(tag), createElementNS: (_ns: string, tag: string) => new FormNode(tag), body: new FormNode('body') };
  t.after(() => { (globalThis as any).document = previous; });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const uploads: string[] = [];
  const field = form.filesField([{ id: 'old', name: 'old.png', size: 3, mime: 'image/png' }],
    async (_file: unknown, name: string) => { uploads.push(name); return { id: `id-${name}`, name, size: 1, mime: 'image/png' }; });
  let sent: string[] = [];
  let gate = Promise.withResolvers<void>();
  const dialog: FormNode = form.formDialog('编辑任务', [field.el], async () => { sent = field.ids(); await gate.promise; }, field.lock);
  dialog.addEventListener('paste', field.paste);
  const formNode = dialog.find((node) => node.tagName === 'form')!;
  const save = () => formNode.fire('submit', { preventDefault() {} });
  const replacement = { name: 'new.png', size: 1, type: 'image/png' };
  const paste = () => dialog.fire('paste', { clipboardData: { files: [replacement], types: ['Files'] }, preventDefault() {} });
  const removeOld = () => field.el.find((node: FormNode) => node.attributes['aria-label'] === '移除 old.png') as FormNode | undefined;
  const pickButton: FormNode = field.el.find((node: FormNode) => node.tagName === 'button' && node.textContent === '添加文件');
  const input: FormNode = field.el.find((node: FormNode) => node.tagName === 'input');
  const off = (node: FormNode) => node.disabled || 'disabled' in node.attributes;
  assert.ok(!off(removeOld()!) && !off(pickButton) && !off(input), 'open for editing before the save');

  // The reproduction: the POST hangs, the user removes old.png and pastes a replacement.
  const saving = save();
  assert.deepEqual(sent, ['old']);
  assert.ok(off(removeOld()!) && off(pickButton) && off(input), 'every control shows it is locked');
  await removeOld()!.fire('click');
  await paste();
  input.files = [replacement];
  await input.fire('change');
  await tick();
  assert.deepEqual(uploads, [], 'nothing new starts uploading');
  assert.ok(removeOld(), 'old.png stays listed');
  assert.deepEqual(field.ids(), ['old'], 'the page still shows what the request carries');

  gate.reject(new Error('保存失败'));
  await saving;
  assert.equal(dialog.open, true, 'a failed save keeps the dialog');
  assert.match(dialog.textContent, /保存失败/);
  assert.deepEqual(field.ids(), ['old'], 'what the user entered is kept');
  assert.ok(!off(removeOld()!) && !off(pickButton) && !off(input), 'unlocked after the failure');

  await removeOld()!.fire('click');
  await paste();
  await tick();
  assert.deepEqual(uploads, ['new.png']);
  assert.deepEqual(field.ids(), ['id-new.png'], 'editing works again');

  gate = Promise.withResolvers<void>();
  const retry = save();
  assert.deepEqual(sent, ['id-new.png']);
  assert.ok(off(pickButton), 'locked again for the retry');
  gate.resolve();
  await retry;
  assert.equal(dialog.open, false, 'a successful save closes the dialog');
});

test('交给验收者 is offered only for a member-reviewed task that is pending, working or in review', () => {
  const member = { kind: 'member', memberId: 'c' };
  const has = (task: object) => ui.taskActionPlan({ status: 'pending', reviewer: member, ...task }).more.includes('takeover');
  assert.equal(has({}), true);
  assert.equal(has({ status: 'working' }), true);
  assert.equal(has({ status: 'review', latestSubmissionId: 's' }), true);
  for (const status of ['completed', 'merged', 'cancelled']) assert.equal(has({ status }), false, status);
  assert.equal(has({ proposalState: 'proposed' }), false, 'awaiting approval');
  assert.equal(has({ reviewer: { kind: 'user' } }), false);
  assert.equal(has({ reviewer: { kind: 'self' } }), false);
  assert.deepEqual(ui.taskActionPlan({ status: 'working', assignedMemberId: 'a', reviewer: member }).more,
    ['reviewer', 'release', 'handoff', 'takeover', 'markCompleted', 'markMerged', 'gitBranch', 'public', 'cancel']);
});

test('the takeover command, mark and review-mode words', () => {
  const task = { id: 't', revision: 4 };
  assert.deepEqual(ui.takeoverCommand(task, 'user', 'x'), { action: 'task.takeover', taskId: 't', expectedRevision: 4 }, 'user review is the Hub default');
  assert.deepEqual(ui.takeoverCommand(task, 'member', 'd').reviewer, { kind: 'member', memberId: 'd' });
  assert.equal(ui.takeoverCommand(task, 'member', ''), null, 'a member must be picked');
  assert.deepEqual(ui.takeoverCommand(task, 'self').reviewer, { kind: 'self' });
  assert.equal(ui.takeoverMark({}), null);
  assert.equal(ui.takeoverMark({ takeover: { basis: 'cluster_setting' } }), '验收者接手 · 群设置授权');
  assert.equal(ui.takeoverMark({ takeover: { basis: 'user_review' } }), '验收者接手 · 默认改为用户验收');
  assert.equal(ui.takeoverMark({ takeover: { basis: 'odd' } }), '验收者接手 · 依据未知');
  const name = (id: string) => id.toUpperCase();
  assert.equal(ui.reviewModeText({ kind: 'member', memberId: 'd' }, name), '成员验收（D）');
  assert.equal(ui.reviewModeText({ kind: 'self' }, name), '自查');
  assert.equal(ui.reviewModeText({ kind: 'user' }, name), '用户验收');
});

test('交给验收者: three labelled modes, user review by default, a member must be picked, self asks again before posting', async (t) => {
  const body = mockWorkbenchDom(t);
  const posted: any[] = [];
  const task: any = { id: 't1', number: 7, title: '任务', status: 'working', revision: 3, currentAssignmentId: 'a1', assignedMemberId: 'b',
    reviewer: { kind: 'member', memberId: 'c' }, mergeRequired: true };
  const api = async (method: string, url: string, args: Record<string, unknown>) => {
    if (method === 'POST') {
      const { operationId: _op, ...action } = args;
      posted.push(action);
      return { task };
    }
    if (url.includes('/workspace')) return { tasks: [task], labels: [], roles: [], memberRoles: [], nextCursor: null, taskSettings: { takeoverSelfReview: false },
      coordinator: { memberId: 'f', enabled: true, mode: 'execute', generation: 1, permissions: {}, rules: { version: 'v', text: '' } } };
    if (url.endsWith('/context')) return {};
    return { task, assignments: [{ id: 'a0', memberId: 'a' }, { id: 'a1', memberId: 'b' }], takeovers: [] };
  };
  const members = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id.toUpperCase(), ...(id === 'e' ? { hiddenAt: 'x' } : {}) }));
  const workbench = ui.createWorkbench({ api, getMembers: () => members, getHistoryMembers: () => [], getClusters: () => [{ id: 'c1', name: '群' }],
    nameOf: (id: string) => String(id).toUpperCase(), messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  const fire = (node: any, event: string) => Promise.all((node.listeners.get(event) ?? []).map((fn: any) => fn({ preventDefault() {}, target: node })));
  const button = (caption: string) => body.all((node) => node.tagName === 'button' && node.textContent === caption)[0];
  const openDialog = async () => {
    await fire(button('更多'), 'click');
    await fire(button('交给验收者'), 'click');
    return body.all((node) => node.tagName === 'dialog' && node.open).at(-1)!;
  };
  workbench.openTask('c1', 't1');
  await new Promise((done) => setImmediate(done));

  let dialog = await openDialog();
  const form = dialog.all((node) => node.tagName === 'form')[0];
  assert.match(form.textContent, /C 将成为执行者；原执行者的派工结束，如果还在做会收到停手通知/);
  assert.equal(dialog.all((node) => node.tagName === 'legend')[0].textContent, '之后谁来验收', 'a fieldset legend names the group for screen readers');
  const radios = dialog.all((node) => node.attributes.type === 'radio');
  assert.deepEqual(radios.map((node) => node.attributes.value), ['user', 'member', 'self']);
  assert.ok(radios.every((node) => node.attributes.name === 'wb-takeover-mode'), 'one keyboard group');
  assert.ok('checked' in radios[0].attributes, 'user review starts selected');
  assert.match(form.textContent, /自己检查后直接完成，不再有独立验收/, 'the self option states the consequence');
  const select = dialog.all((node) => node.tagName === 'select')[0];
  assert.deepEqual(select.all((node) => node.tagName === 'option').map((node) => node.attributes.value), ['', 'd'],
    'only members who never worked on it, are not hidden and are not the coordinator');
  assert.equal(form.all((node) => node.attributes.type === 'submit')[0].textContent, '交给验收者', 'the submit button says what it does');
  await fire(form, 'submit');
  assert.deepEqual([...posted], [{ action: 'task.takeover', taskId: 't1', expectedRevision: 3 }]);

  // A member mode without a member: refused in the dialog, nothing posted.
  dialog = await openDialog();
  let modes = dialog.all((node) => node.attributes.type === 'radio');
  modes[1].checked = true;
  await fire(modes[1], 'change');
  await fire(dialog.all((node) => node.tagName === 'form')[0], 'submit');
  assert.equal(posted.length, 1);
  assert.match(dialog.textContent, /请选择验收的成员/);
  dialog.all((node) => node.tagName === 'select')[0].value = 'd';
  await fire(dialog.all((node) => node.tagName === 'form')[0], 'submit');
  assert.deepEqual(posted[1].reviewer, { kind: 'member', memberId: 'd' });

  // Self: confirmDialog first; cancelling posts nothing, confirming posts.
  for (const answer of ['cancel', 'confirm']) {
    dialog = await openDialog();
    modes = dialog.all((node) => node.attributes.type === 'radio');
    modes[0].checked = false;
    modes[2].checked = true;
    const submitted = fire(dialog.all((node) => node.tagName === 'form')[0], 'submit');
    await new Promise((done) => setImmediate(done));
    const ask = body.all((node) => node.tagName === 'dialog' && node.attributes.class === 'ask' && node.open).at(-1)!;
    assert.match(ask.textContent, /改为自查？.*不再有独立验收/);
    (ask as any).returnValue = answer;
    ask.open = false;
    await fire(ask, 'close');
    await submitted;
  }
  assert.equal(posted.length, 3, 'only the confirmed self review was posted');
  assert.deepEqual(posted[2].reviewer, { kind: 'self' });
});

test('the cluster setting and the takeover mark: the setting posts tasks.settings; a taken-over task shows its mode and basis', async (t) => {
  const body = mockWorkbenchDom(t);
  const posted: any[] = [];
  const task: any = { id: 't1', number: 1, title: '接手过的任务', status: 'working', revision: 2, assignedMemberId: 'c',
    reviewer: { kind: 'self' }, takeover: { recordId: 'r', memberId: 'c', basis: 'cluster_setting', at: '2026-11-16T00:00:00Z' } };
  const api = async (method: string, url: string, args: Record<string, unknown>) => {
    if (method === 'POST') { const { operationId: _op, ...action } = args; posted.push(action); return {}; }
    if (url.includes('/workspace')) return { tasks: [task], labels: [], roles: [], memberRoles: [], nextCursor: null, taskSettings: { takeoverSelfReview: true } };
    if (url.endsWith('/context')) return {};
    return { task, assignments: [], takeovers: [{ id: 'r', by: 'b', fromMemberId: 'b', toMemberId: 'c', reviewFrom: { kind: 'member', memberId: 'c' },
      reviewTo: { kind: 'self' }, basis: 'cluster_setting', previousRejected: true, createdAt: '2026-11-16T00:00:00Z' }] };
  };
  const workbench = ui.createWorkbench({ api, getMembers: () => [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }], getHistoryMembers: () => [],
    getClusters: () => [{ id: 'c1', name: '群' }], nameOf: (id: string) => String(id).toUpperCase(), messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  workbench.openTask('c1', 't1');
  await new Promise((done) => setImmediate(done));
  assert.match(body.textContent, /验收者接手 · 群设置授权/);
  assert.match(body.textContent, /验收方式自查验收者接手 · 群设置授权/, 'the detail names the current mode');
  assert.match(body.textContent, /验收者接手记录.*B 发起 · .*C.* 接手执行.*验收方式 成员验收（C） → 自查 · 依据 群设置授权 · 上一轮验收为退回/);
  const card = body.all((node) => /^workbench-task /.test(node.attributes.class ?? ''))[0];
  assert.match(card.textContent, /验收者接手 · 群设置授权/, 'the card carries the mark');

  const settings = body.all((node) => node.tagName === 'button' && node.textContent === '角色与协调')[0];
  for (const fn of settings.listeners.get('click') ?? []) await fn({});
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
  const box = body.all((node) => node.attributes['aria-describedby'] === 'wb-takeover-setting-note')[0];
  assert.ok(box, 'the setting is in the settings view with its explanation');
  assert.ok('checked' in box.attributes, 'it reflects the workspace');
  for (const fn of box.listeners.get('change') ?? []) await fn({ target: { checked: false } });
  assert.deepEqual(posted, [{ action: 'tasks.settings', takeoverSelfReview: false }]);
});

// ---- 角色与协调: the section rail, the same card for every section, rows, danger actions and empty states ----
const FULL_SETTINGS = {
  tasks: [], labels: [], nextCursor: null, paused: false, taskSettings: { takeoverSelfReview: false },
  coordinator: { memberId: 'a', enabled: true, mode: 'execute', generation: 3, standingInstructions: [{ id: 'i1', text: '晚上不派新任务' }],
    permissions: { taskPlanning: true, assignment: true, roleManagement: false }, rules: { version: 'v16', text: '1. 第一条规则' } },
  roles: [{ id: 'r1', name: '设计者', description: '写设计' }, { id: 'r2', name: '验收者', description: '' }],
  memberRoles: [{ memberId: 'a', roleIds: ['r1'] }],
  labelLibrary: { groups: [{ id: 'g1', name: '模块', selected: true, required: true, labels: [{ name: '前端' }, { name: '旧', archived: true }] }] },
};
const EMPTY_SETTINGS = { tasks: [], labels: [], nextCursor: null, paused: true, coordinator: null, roles: [], memberRoles: [], labelLibrary: { groups: [] } };

async function openSettings(t: TestContext, workspace: any, { members = [{ id: 'a', name: 'A' }], plugins = null as string[] | null } = {}) {
  const body = mockWorkbenchDom(t);
  const posted: any[] = [];
  const api = async (method: string, url: string, args: Record<string, unknown>) => {
    if (method === 'POST') { const { operationId: _op, ...action } = args; posted.push(action); return {}; }
    return url.includes('/workspace') ? workspace : {};
  };
  const workbench = ui.createWorkbench({ api, getMembers: () => members, getHistoryMembers: () => [], getClusters: () => [{ id: 'c1', name: '群' }],
    nameOf: (id: string) => id, messageName: () => '', showMessage() {}, selectCluster() {}, getActivity: () => ({}) });
  if (plugins) workbench.setPlugins({ plugins: plugins.map((id) => ({ id })) }, []);
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done)); };
  workbench.open('c1');
  await tick();
  const tab = body.all((node) => node.tagName === 'button' && /^角色/.test(node.textContent))[0];
  for (const fn of tab.listeners.get('click') ?? []) await fn({});
  await tick();
  const find = (test: (node: any) => boolean) => body.all(test);
  const byClass = (name: string) => find((node) => (node.attributes.class ?? '').split(' ').includes(name));
  const button = (text: string, within: any = body) => within.all((node: any) => node.tagName === 'button' && node.textContent === text);
  const click = async (node: any) => { for (const fn of node.listeners.get('click') ?? []) await fn({}); await tick(); };
  const change = async (node: any, checked: boolean) => { for (const fn of node.listeners.get('change') ?? []) await fn({ target: { checked } }); await tick(); };
  return { body, posted, byClass, button, click, change, card: (id: string) => byClass(`wb-rp-${id}`)[0] };
}

test('角色与协调: a real nav rail lists the six sections in order, marks one current and goes to the chosen card', async (t) => {
  const page = await openSettings(t, FULL_SETTINGS);
  const [rail] = page.byClass('wb-rp-rail');
  assert.equal(rail.tagName, 'nav');
  assert.equal(rail.attributes['aria-label'], '角色与协调分区');
  const items = rail.children;
  assert.deepEqual(items.map((item: any) => item.textContent), ['协调员', '长期要求', '业务角色', '成员角色', '标签组', '本群设置']);
  assert.ok(items.every((item: any) => item.tagName === 'button' && item.attributes.type === 'button'), 'keyboard reachable buttons');
  assert.deepEqual(items.map((item: any) => item.attributes['aria-current']), ['true', 'false', 'false', 'false', 'false', 'false']);
  const cards = page.byClass('wb-rp-card');
  assert.deepEqual(cards.map((card: any) => card.attributes['data-wb-section']), ['coordinator', 'instructions', 'roles', 'member-roles', 'labels', 'cluster'],
    'one card per rail item, in the same order');
  for (const card of cards) {
    assert.equal(card.tagName, 'section');
    assert.equal(card.children[0].attributes.class, 'wb-rp-head', 'every card starts with the same heading row');
    assert.equal(card.children[0].children[0].tagName, 'h3');
    assert.equal(card.children[1].attributes.class, 'wb-rp-sub', 'then one muted line');
    assert.equal(card.attributes['aria-labelledby'], card.children[0].children[0].attributes.id);
  }
  assert.equal(items[2].attributes['aria-controls'], 'wb-rp-roles');
  await page.click(items[2]);
  assert.deepEqual(items.map((item: any) => item.attributes['aria-current']), ['false', 'false', 'true', 'false', 'false', 'false']);
  assert.equal((page.card('roles').scrolledInto as any)?.block, 'start', 'the chosen card is scrolled to the top');
});

test('角色与协调 without the coordinator plugin: the rail and the page drop 协调员 and 长期要求', async (t) => {
  const page = await openSettings(t, FULL_SETTINGS, { plugins: ['tasks'] });
  const [rail] = page.byClass('wb-rp-rail');
  assert.equal(rail.attributes['aria-label'], '角色分区');
  assert.deepEqual(rail.children.map((item: any) => item.textContent), ['业务角色', '成员角色', '标签组', '本群设置']);
  assert.equal(rail.children[0].attributes['aria-current'], 'true');
  assert.equal(page.card('coordinator'), undefined);
  assert.equal(page.card('instructions'), undefined);
});

test('角色与协调 rows: actions on the same row, destructive ones styled as danger, every operation posts as before', async (t) => {
  const page = await openSettings(t, FULL_SETTINGS);
  const coordinator = page.card('coordinator');
  assert.match(coordinator.textContent, /授权执行/);
  assert.match(coordinator.textContent, /A/);
  const perms = page.byClass('wb-rp-perm');
  assert.equal(perms.length, 8, 'every permission is shown');
  // An authorised one starts with the check icon (sprite), then its name and the words for screen readers.
  assert.deepEqual(page.byClass('wb-rp-perm-on').map((chip: any) => [chip.children[0].tagName, chip.children[0].children[0].attributes.href, chip.textContent.replace('（已授权）', '')]),
    [['svg', '#i-check', '任务规划'], ['svg', '#i-check', '任务分派']]);
  assert.match(perms[2].textContent, /业务角色管理（未授权）/);
  const [rules] = page.byClass('wb-rp-rules');
  assert.equal(rules.tagName, 'details', 'the rules text folds');
  assert.match(rules.textContent, /协调规则 v16.*1\. 第一条规则/);

  for (const text of ['撤销授权', '删除']) {
    for (const button of page.button(text)) assert.equal(button.attributes.class, 'small danger', `${text} is a danger action`);
  }
  assert.equal(page.button('删除').length, 3, 'one instruction and two roles');
  for (const text of ['修改授权', '编辑', '新增要求', '新增角色', '补上默认角色', '设置角色', '管理标签库']) {
    for (const button of page.button(text)) assert.equal(button.attributes.class, 'small', `${text} is a plain small button`);
  }
  for (const row of page.byClass('wb-rp-row')) {
    assert.equal(row.children[0].attributes.class, 'wb-rp-main', 'content on the left');
    assert.equal(row.children.at(-1).attributes.class, 'wb-rp-row-actions', 'actions on the right of the same row');
  }
  const role = page.card('roles').all((node: any) => (node.attributes.class ?? '').startsWith('wb-rp-role '))[0];
  assert.match(role.attributes.class, /wb-tone-\d/, 'a role keeps its own tone, shown as a dot before the name');
  assert.match(page.card('roles').textContent, /验收者暂无描述/);

  // Label group and delivery switches post exactly what the old checkbox and button did.
  const [group] = page.card('labels').all((node: any) => node.attributes['aria-label'] === '本群使用「模块」');
  assert.equal(group.attributes.role, 'switch');
  assert.match(page.card('labels').textContent, /模块必选前端/, 'archived labels stay out');
  await page.change(group, false);
  const [delivery] = page.card('cluster').all((node: any) => node.attributes['aria-labelledby'] === 'wb-rp-delivery-title');
  assert.ok('checked' in delivery.attributes, 'delivery on while the cluster is not paused');
  await page.change(delivery, false);
  assert.deepEqual(page.posted, [{ action: 'label.select_group', groupId: 'g1', selected: false }, { action: 'cluster.pause', paused: true }]);
});

test('角色与协调 empty states: each section says what is missing; a disabled action says why next to it', async (t) => {
  const page = await openSettings(t, EMPTY_SETTINGS, { members: [] });
  const coordinator = page.card('coordinator');
  assert.match(coordinator.textContent, /还没有协调员。/);
  assert.equal(page.button('设置并启用', coordinator)[0].attributes.class, 'small primary');
  const [add] = page.button('新增要求');
  assert.ok('disabled' in add.attributes);
  assert.equal(add.attributes['aria-describedby'], 'wb-rp-instructions-hint');
  const hint = page.byClass('wb-rp-hint')[0];
  assert.equal(hint.attributes.id, 'wb-rp-instructions-hint');
  assert.equal(hint.textContent, '先启用协调员，再添加长期要求。');
  assert.equal(page.card('instructions').children[0].children.at(-1).children.indexOf(add), 1, 'the hint sits right before the button');
  // The shared empty state (ui.js emptyState), compact inside a card.
  const empty = (id: string) => page.card(id).all((node: any) => node.attributes.class === 'empty-state compact')[0]?.textContent;
  assert.match(empty('instructions'), /还没有长期要求/);
  assert.match(empty('roles'), /还没有业务角色/);
  assert.match(empty('member-roles'), /当前群没有成员/);
  assert.match(empty('labels'), /标签库里还没有组/);
  assert.match(page.card('cluster').textContent, /本群已暂停开始新投递/);
  const [delivery] = page.card('cluster').all((node: any) => node.attributes['aria-labelledby'] === 'wb-rp-delivery-title');
  assert.ok(!('checked' in delivery.attributes), 'a paused cluster shows its delivery switch off');
  await page.change(delivery, true);
  assert.deepEqual(page.posted, [{ action: 'cluster.pause', paused: false }]);
});

test('角色与协调 narrow layout: at 720 px the rail becomes one horizontally scrolling row above the single column', () => {
  const css = readFileSync(join(REPO_ROOT, 'src/web/public/workbench.css'), 'utf8');
  const narrow = css.slice(css.indexOf('@media (max-width: 720px)'));
  assert.ok(css.includes('@media (max-width: 720px)'));
  assert.match(narrow, /\.wb-rp \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(narrow, /\.wb-rp-rail \{[^}]*flex-direction: row;[^}]*overflow-x: auto;/);
  assert.match(css, /\.wb-rp \{ display: grid; grid-template-columns: 168px minmax\(0, 860px\);/, 'wide: a rail beside one column');
  assert.match(css, /\.wb-rp-rail \{ position: sticky;/);
  // Danger buttons are the page's shared style (style.css button.danger), not a local copy.
  assert.doesNotMatch(css, /\.wb-rp button\.danger/);
  assert.match(readFileSync(join(REPO_ROOT, 'src/web/public/style.css'), 'utf8'), /\nbutton\.danger \{ border-color: color-mix\(in srgb, var\(--failed\)[^}]*color: var\(--failed\); \}/, 'danger uses the failed token');
  const block = css.slice(css.indexOf('/* ---- 角色与协调'), css.indexOf('.wb-role-description'));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgb\(|prefers-color-scheme/i, 'colours only through the theme tokens');
});
