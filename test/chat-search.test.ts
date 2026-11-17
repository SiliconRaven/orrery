import { tempDir } from './helpers.ts';
// The chat filter's sender switch and hidden-warning count (ui.js), and the history search sheet's pure helpers
// (chat-search.js), run in node. The sheet itself and the jump are exercised in a real page by test/chat-search-browser.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const ui = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js')).href);
const search = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'chat-search.js')).href);

const system = (systemKind?: string, clusterId = 'c1') => ({ id: `s-${systemKind}`, clusterId, from: 'system', kind: 'system', body: 'b', ...(systemKind ? { systemKind } : {}) });
const said = (from: string, clusterId = 'c1', id = `${from}-msg`) => ({ id, clusterId, from, body: 'hi' });

test('chat filter: the older stored shape keeps its choice; senders are per cluster and only well-formed ones are read', () => {
  assert.deepEqual(ui.chatFilterFromStored('{"hide":["task"],"warningsOnly":true}'), { hide: ['task'], warningsOnly: true, senders: {} }, 'migrated as is');
  const stored = { hide: ['coordinator'], warningsOnly: false, senders: { c1: 'm1', c2: 'user' } };
  assert.deepEqual(ui.chatFilterFromStored(JSON.stringify(stored)), stored, 'the new shape round-trips');
  assert.deepEqual(ui.chatFilterFromStored('{"senders":{"c1":"","c2":5,"c3":"m3"}}').senders, { c3: 'm3' });
  assert.deepEqual(ui.chatFilterFromStored('{"senders":["m1"]}').senders, {});
  const filter = ui.chatFilterFromStored(JSON.stringify(stored));
  assert.equal(ui.chatFilterCount(filter, 'c1'), 2, 'a hidden category and a sender');
  assert.equal(ui.chatFilterCount(filter, 'c9'), 1, 'another cluster has no sender chosen');
  assert.equal(ui.chatFilterCount(ui.CHAT_FILTER_DEFAULT, 'c1'), 0, 'default: everything shown');
});

test('chat filter: only one sender, in its own cluster, combined with the category switches; a jump still lets its target through', () => {
  const filter = ui.chatFilterFromStored('{"senders":{"c1":"m1"}}');
  assert.equal(ui.chatShowsMessage(said('m1'), filter), true);
  assert.equal(ui.chatShowsMessage(said('m2'), filter), false, 'another member');
  assert.equal(ui.chatShowsMessage(said('user'), filter), false, 'the user');
  assert.equal(ui.chatShowsMessage(system('delivery_failed'), filter), false, 'a warning: the system is another sender');
  assert.equal(ui.chatShowsMessage(said('m2', 'c2'), filter), true, 'another cluster is not filtered');
  const systemOnly = ui.chatFilterFromStored('{"senders":{"c1":"system"},"hide":["task"]}');
  assert.deepEqual([system('task'), system('stalled'), said('m1')].map((m) => ui.chatShowsMessage(m, systemOnly)), [false, true, false]);
  const systemWarnings = ui.chatFilterFromStored('{"senders":{"c1":"system"},"warningsOnly":true}');
  assert.deepEqual([system('task'), system('stalled')].map((m) => ui.chatShowsMessage(m, systemWarnings)), [false, true]);
  assert.equal(ui.chatRowState(said('m2', 'c1', 'x'), filter, 'x'), 'jump', 'the jump target hidden by the sender switch is shown, marked');
});

test('chat filter: the loaded warnings it hides are counted, not the ones a jump shows or the filter lets through', () => {
  const messages = [system('delivery_failed'), system('stalled'), system('task'), said('m1'), undefined];
  assert.equal(search.hiddenWarnings(messages, ui.CHAT_FILTER_DEFAULT), 0);
  assert.equal(search.hiddenWarnings(messages, ui.chatFilterFromStored('{"hide":["warning"]}')), 2);
  assert.equal(search.hiddenWarnings(messages, ui.chatFilterFromStored('{"senders":{"c1":"m1"}}')), 2, 'a sender switch hides them too');
  assert.equal(search.hiddenWarnings(messages, ui.chatFilterFromStored('{"hide":["warning"]}'), 's-stalled'), 1, 'a jump target is shown');
  assert.equal(search.hiddenWarnings(messages, ui.chatFilterFromStored('{"warningsOnly":true}')), 0);
  // The page draws the count on the control and announces new hidden warnings politely.
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const html = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="chat-filter-live" class="sr-only" aria-live="polite"/);
  assert.match(app, /hiddenWarningArrived\(m\);/, 'every streamed message is checked');
  assert.match(app, /setText\(\$\('chat-filter-live'\), `筛选隐藏了 \$\{count\} 条新到的警告。`\)/, 'the same number as the badge');
});

test('chat filter: the warning badge shows the hidden loaded warnings and the hidden arrivals apart', () => {
  assert.deepEqual(search.warningBadge(0, 0), { shown: false, fresh: false, text: '', title: '', note: '' });
  const here = search.warningBadge(3, 0);
  assert.deepEqual([here.shown, here.fresh, here.text], [true, false, '3']);
  assert.match(here.title, /已加载的消息里有 3 条警告被筛选隐藏/);
  const history = search.warningBadge(0, 1);   // viewing history: the new warning is not loaded, still shown
  assert.deepEqual([history.shown, history.fresh, history.text], [true, true, '新 1']);
  assert.match(history.note, /新到 1 条被隐藏的警告/);
  const both = search.warningBadge(9, 2);
  assert.equal(both.text, '9 · 新 2');
  assert.match(both.title, /9 条.*；.*新到 2 条/);
});

test('search: sender choices by identity, removed and hidden marked, same names told apart', () => {
  const m = (id: string, name: string, extra: object = {}) => ({ id, clusterId: 'c1', name, harness: 'claude', mode: 'native', removedAt: null, hiddenAt: null, ...extra });
  const members = [
    m('aaaaaa-1', 'A'), m('bbbbbb-1', 'B', { hiddenAt: 't' }), m('cccccc-1', 'A', { removedAt: 't' }), m('dddddd-1', 'C', { removedAt: 't' }),
    m('eeeeee-1', 'D', { harness: 'codex' }), m('ffffff-1', 'D', { harness: 'codex' }), m('zzzzzz-1', 'A', { clusterId: 'c2' }),
  ];
  const choices = search.senderChoices(members, 'c1', (harness: string) => ({ claude: 'Claude', codex: 'Codex' })[harness]);
  assert.deepEqual(choices.map((c: { value: string; label: string }) => [c.value, c.label]), [
    ['aaaaaa-1', 'A（Claude）'], ['bbbbbb-1', 'B（隐身）'], ['eeeeee-1', 'D（Codex · #eeeeee）'], ['ffffff-1', 'D（Codex · #ffffff）'],
    ['cccccc-1', 'A（Claude · 已移出）'], ['dddddd-1', 'C（已移出）'],
  ], 'members still in the group first; another cluster never listed');
  assert.equal(search.senderLabel('user', choices), '你');
  assert.equal(search.senderLabel('system', choices), 'Orrery 系统');
  assert.equal(search.senderLabel('plugin:x', choices), '插件 x');
  assert.equal(search.senderLabel('cccccc-1', choices), 'A（Claude · 已移出）');
  assert.equal(search.senderLabel('gone', choices), '（未知成员）');
});

test('search: criteria become one checked query; dates are local days, both ends included', () => {
  const c = (extra: object) => ({ ...search.EMPTY_CRITERIA, ...extra });
  assert.equal(search.criteriaEmpty(search.EMPTY_CRITERIA), true);
  assert.equal(search.criteriaEmpty(c({ q: '   ' })), true, 'blank keyword');
  assert.equal(search.criteriaEmpty(c({ files: true })), false);
  const { query } = search.searchQuery(c({ q: ' 50% ', sender: 'm1', category: 'warning:problem', from: '2026-03-01', to: '2026-03-02', files: true, order: 'asc' }), '42');
  const p = new URLSearchParams(query);
  assert.equal(p.get('q'), '50%');
  assert.deepEqual([p.get('sender'), p.get('category'), p.get('level'), p.get('files'), p.get('order'), p.get('cursor')], ['m1', 'warning', 'problem', '1', 'asc', '42']);
  assert.equal(p.get('from'), new Date(2026, 2, 1).toISOString(), 'local midnight');
  assert.equal(p.get('to'), new Date(new Date(2026, 2, 3).getTime() - 1).toISOString(), 'the last millisecond of the local day');
  assert.equal(new URLSearchParams(search.searchQuery(c({ category: 'task' })).query).get('level'), null);
  assert.equal(search.searchQuery(c({ order: 'desc' })).query, '', 'newest first is the default');
  assert.match(search.searchQuery(c({ from: '2026-02-30' })).error, /日期/);
  assert.match(search.searchQuery(c({ to: 'tomorrow' })).error, /日期/);
  assert.match(search.searchQuery(c({ from: '2026-03-02', to: '2026-03-01' })).error, /晚于/);
  assert.equal(search.searchQuery(c({ from: '2026-03-01', to: '2026-03-01' })).error, undefined, 'one day');
  assert.match(search.searchQuery(c({ q: 'x'.repeat(201) })).error, /200/);
  assert.deepEqual(search.criteriaFromFilter(ui.chatFilterFromStored('{"warningsOnly":true,"senders":{"c1":"m1"}}'), 'c1'),
    c({ sender: 'm1', category: 'warning' }), 'the filter as search criteria');
  assert.deepEqual(search.criteriaFromFilter(ui.CHAT_FILTER_DEFAULT, 'c1'), search.EMPTY_CRITERIA);
});

test('search: the Hub’s marks become text and <mark> runs, results and more-buttons in words', () => {
  const runs = (text: string, marks: unknown) => search.markedParts(text, marks).map((p: { text: string; hit: boolean }) => (p.hit ? `[${p.text}]` : p.text)).join('');
  assert.equal(runs('Deploy then DEPLOY', [[0, 6], [12, 18]]), '[Deploy] then [DEPLOY]');
  assert.equal(runs('<b>x</b>', [[1, 2]]), '<[b]>x</b>', 'text only: the page puts each run in a text node or <mark>');
  assert.equal(runs('abc', []), 'abc');
  assert.equal(runs('abc', undefined), 'abc');
  assert.equal(runs('abc', [[2, 1], [0, 9], [-1, 1], [1, 2], [0, 1]]), 'a[b]c', 'ranges out of order or out of bounds are ignored');
  assert.deepEqual(search.categoryMark({ from: 'system', kind: 'system', systemKind: 'ship_failed' }), { category: 'warning', level: 'problem', label: '警告 · 问题' });
  assert.deepEqual(search.categoryMark({ from: 'system', kind: 'system' }), { category: 'other', level: null, label: '其他' });
  assert.equal(search.categoryMark({ from: 'm1', kind: 'chat' }), null);
  assert.equal(search.moreLabel('limit', 'desc'), '加载更多');
  assert.equal(search.moreLabel('scan', 'desc'), '继续搜索更早的消息');
  assert.equal(search.moreLabel('scan', 'asc'), '继续搜索更新的消息');
  assert.equal(search.moreLabel(null, 'desc'), null);
  assert.equal(search.resultText(0, null, 'desc'), '没有找到符合条件的消息。');
  assert.equal(search.resultText(0, 'scan', 'desc'), '最近查过的一批消息里没有，更早的还没查。');
  assert.equal(search.resultText(3, 'limit', 'desc'), '找到 3 条，还有更多。');
  // The sheet never writes message text as HTML, and a result jumps through the page's one jump.
  const source = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'chat-search.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/);
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  assert.match(app, /openMessage: \(cid, id\) => void openMessage\(cid, id\)/);
});

// ---- the search sheet's one state (chat-search.js nextSearch): every event in every status ----

const step = (state: any, ...events: any[]) => events.reduce((s, e) => search.nextSearch(s, e), state);
const item = (id: string) => ({ id, from: 'user', createdAt: '2026-01-01T00:00:00.000Z', kind: 'chat', snippet: id, marks: [] });
const items = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => item(`${prefix}${i}`));
const edit = (patch: object) => ({ type: 'edit', patch });
const submit = { type: 'commit' };

/** Every status the sheet can be in, reached by real event sequences in cluster c1. */
function states() {
  const idle = step(search.SEARCH_START, { type: 'cluster', cid: 'c1' });
  const loading = step(idle, edit({ q: 'old' }), submit);
  const page = step(loading, { type: 'answer', token: loading.request.token, items: items('old', 30), cursor: '9', reason: 'limit' });
  const appending = step(page, { type: 'more' });
  const error = step(loading, { type: 'failed', token: loading.request.token, message: 'down' });
  const appendError = step(appending, { type: 'failed', token: appending.request.token, message: 'down' });
  const invalid = step(idle, edit({ from: '2026-03-02', to: '2026-03-01' }), submit);
  return { idle, loading, page, appending, error, appendError, invalid };
}

test('search sheet: the states reached by real sequences', () => {
  const s = states();
  assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]: [string, any]) => [k, [v.status, v.rows.length, Boolean(v.request), v.error?.append ?? null]])), {
    idle: ['idle', 0, false, null], loading: ['loading', 0, true, null], page: ['idle', 30, false, null], appending: ['appending', 30, true, null],
    error: ['error', 0, false, false], appendError: ['idle', 30, false, true], invalid: ['error', 0, false, false],
  });
  assert.equal(search.searchView(s.page).more, '加载更多');
  assert.equal(search.searchView(s.appendError).more, '加载更多', 'a failed continuation keeps its continue button');
  assert.match(search.searchView(s.appendError).text, /找到 30 条.*继续搜索失败：down/);
  assert.match(search.searchView(s.invalid).text, /晚于/);
  assert.equal(search.searchView(s.loading).text, '正在搜索…');
});

test('search sheet: every event in every status', () => {
  const events: Record<string, (s: any) => any> = {
    input: () => edit({ q: 'new' }),
    field: () => [edit({ sender: 'user' }), submit],
    sort: () => ({ type: 'sort' }),
    clear: () => ({ type: 'clear' }),
    more: () => ({ type: 'more' }),
    pick: () => ({ type: 'pick' }),
    close: () => ({ type: 'close' }),
    openSame: () => ({ type: 'open', cid: 'c1' }),
    openOther: () => ({ type: 'open', cid: 'c2' }),
    openPrefill: () => ({ type: 'open', cid: 'c1', prefill: { sender: 'user' } }),
    clusterOther: () => ({ type: 'cluster', cid: 'c2' }),
    commit: () => submit,
    answer: (s) => ({ type: 'answer', token: s.request?.token ?? -1, items: items('new', 2), cursor: null, reason: null }),
    failed: (s) => ({ type: 'failed', token: s.request?.token ?? -1, message: 'down' }),
    staleAnswer: () => ({ type: 'answer', token: 999, items: items('stale', 5), cursor: '1', reason: 'limit' }),
    staleFailed: () => ({ type: 'failed', token: 999, message: 'x' }),
  };
  // Expected status after each event, per starting status: idle, loading, page, appending, error, appendError, invalid.
  const expected: Record<string, string[]> = {
    input: ['idle', 'loading', 'idle', 'appending', 'error', 'idle', 'error'],
    field: ['loading', 'loading', 'loading', 'loading', 'loading', 'loading', 'error'],
    sort: ['idle', 'loading', 'loading', 'loading', 'loading', 'loading', 'error'],
    clear: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle'],
    more: ['idle', 'loading', 'appending', 'appending', 'error', 'appending', 'error'],
    pick: ['idle', 'loading', 'idle', 'appending', 'error', 'idle', 'error'],
    close: ['idle', 'idle', 'idle', 'idle', 'error', 'idle', 'error'],
    openSame: ['idle', 'loading', 'idle', 'appending', 'error', 'idle', 'error'],
    openOther: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle'],
    openPrefill: ['loading', 'loading', 'loading', 'loading', 'loading', 'loading', 'loading'],
    clusterOther: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle'],
    commit: ['idle', 'loading', 'idle', 'appending', 'loading', 'loading', 'error'],
    answer: ['idle', 'idle', 'idle', 'idle', 'error', 'idle', 'error'],
    failed: ['idle', 'error', 'idle', 'idle', 'error', 'idle', 'error'],
    staleAnswer: ['idle', 'loading', 'idle', 'appending', 'error', 'idle', 'error'],
    staleFailed: ['idle', 'loading', 'idle', 'appending', 'error', 'idle', 'error'],
  };
  const names = ['idle', 'loading', 'page', 'appending', 'error', 'appendError', 'invalid'];
  for (const [name, make] of Object.entries(events)) {
    names.forEach((stateName, i) => {
      const before = (states() as any)[stateName];
      const made = make(before);
      const after = step(before, ...(Array.isArray(made) ? made : [made]));
      const where = `${stateName} + ${name}`;
      assert.equal(after.status, expected[name][i], where);
      // The rules that hold after any event:
      assert.equal(after.status === 'loading', Boolean(after.request && !after.request.append), `${where}: loading ⇔ a new search is out`);
      assert.equal(after.status === 'appending', Boolean(after.request?.append), `${where}: appending ⇔ a next page is out`);
      assert.ok(after.tokens >= before.tokens, `${where}: tokens only grow`);
      const view = search.searchView(after);
      if (view.more) assert.ok(after.status === 'idle' && !after.request && after.next?.cursor && search.sameSearch(after.draft, after.criteria), `${where}: more only for the shown search`);
      if (after.request && after.request !== before.request) assert.equal(after.request.token, after.tokens, `${where}: a new request has the newest token`);
      if (name.startsWith('stale') || name === 'pick' || name === 'openSame') assert.equal(after, before, `${where}: nothing changes`);
      if (name === 'close') {
        assert.equal(after.request, null, where);
        assert.ok(search.sameSearch(after.draft, after.criteria ?? search.EMPTY_CRITERIA), `${where}: the form shows the kept search`);
        assert.equal(after.rows, before.rows, `${where}: the stable page is kept`);
      }
      if (name === 'openOther' || name === 'clusterOther') assert.deepEqual([after.cid, after.rows, after.criteria, after.request], ['c2', [], null, null], where);
      if (name === 'input') assert.equal(after.draft.q, 'new', where);
      if (name === 'sort') assert.equal(after.draft.q, before.draft.q, `${where}: sorting never rewrites the keyword`);
    });
  }
});

test('search sheet: the reviewer’s three sequences, as events', () => {
  const { page } = states();
  // 1. A new keyword typed, "load more" clicked before the pause ends: no old page is appended, the new search runs.
  let s = step(page, edit({ q: 'new' }));
  assert.equal(search.searchView(s).more, null, 'the button is gone while the form differs from the results');
  s = step(s, { type: 'more' });
  assert.equal(s.request, null, 'load more does nothing');
  s = step(s, submit);
  assert.equal(s.request.criteria.q, 'new');
  s = step(s, { type: 'answer', token: s.request.token, items: items('new', 3), cursor: null, reason: null });
  assert.deepEqual([s.criteria.q, s.rows.map((r: { id: string }) => r.id)], ['new', ['new0', 'new1', 'new2']]);
  // 2. The sort toggle while a new keyword waits: the keyword stays, the new search has both.
  s = step(page, edit({ q: 'new' }), { type: 'sort' });
  assert.deepEqual([s.draft.q, s.request.criteria.q, s.request.criteria.order], ['new', 'new', 'asc']);
  // 3. Closed and reopened during a continuation: the page before it, with its button, no spinner; its answer is dropped.
  const appending = step(page, { type: 'more' });
  s = step(appending, { type: 'close' }, { type: 'open', cid: 'c1' });
  assert.deepEqual([s.status, s.rows.length, search.searchView(s).more], ['idle', 30, '加载更多']);
  assert.equal(step(s, { type: 'answer', token: appending.request.token, items: items('late', 30), cursor: null, reason: null }), s, 'the abandoned answer is stale');
  // An older search's answer landing after a newer one started never shows.
  const twice = step(page, edit({ q: 'a' }), submit, edit({ q: 'b' }), submit);
  assert.equal(step(twice, { type: 'answer', token: twice.request.token - 1, items: items('a', 1), cursor: null, reason: null }), twice);
  // Typing back the shown keyword: the same search, the button returns without asking again.
  s = step(page, edit({ q: 'oldx' }), edit({ q: 'old ' }), submit);
  assert.deepEqual([s.request, search.searchView(s).more], [null, '加载更多']);
});
