import { t, language } from './i18n.js';
// The chat's history search (docs/collaboration.md「搜索群聊记录」): a side sheet that asks the Hub
// (GET /api/clusters/:id/messages/search) about the cluster's whole history, and jumps to a result through the page's
// one jump (app.js openMessage). The pure helpers at the top are what test/web-ui.test.ts checks; createChatSearch
// builds and drives the sheet.
import { chatRowState, emptyState, h, icon, isSystemMessage } from './ui.js';
import { SYSTEM_CATEGORY_LABELS, WARNING_LEVEL_LABELS, systemClass } from './system-kinds.js';

export const FIXED_SENDERS = Object.freeze([{ value: 'user', get label() { return t("你"); } }, { value: 'system', get label() { return t("Orrery 系统"); } }]);

/**
 * The members of cluster `cid` as sender choices `{ value, label, removed, hidden }`, by identity: current names, the
 * members still in the cluster first (hidden ones marked 隐身), then removed ones (已移出). Members sharing a name also
 * show their app; a short id suffix tells apart any that still read the same.
 */
export function senderChoices(members, cid, appName = (harness) => harness) {
  const list = [...members].filter((m) => m && m.clusterId === cid);
  list.sort((a, b) => Number(Boolean(a.removedAt)) - Number(Boolean(b.removedAt)));
  const named = new Map();
  for (const m of list) named.set(m.name, (named.get(m.name) ?? 0) + 1);
  const extras = (m) => [
    named.get(m.name) > 1 ? appName(m.harness) : null,
    m.removedAt ? t("已移出") : null, m.hiddenAt && !m.removedAt ? t("隐身") : null,
  ].filter(Boolean);
  const label = (name, parts) => (parts.length ? t("{name}（{value2}）", { name: name, value2: parts.join(' · ') }) : name);
  const choices = list.map((m) => ({ value: m.id, label: label(m.name, extras(m)), removed: Boolean(m.removedAt), hidden: Boolean(m.hiddenAt) }));
  const seen = new Map();
  for (const c of choices) seen.set(c.label, (seen.get(c.label) ?? 0) + 1);
  return choices.map((c, i) => (seen.get(c.label) > 1 ? { ...c, label: label(list[i].name, [...extras(list[i]), `#${c.value.slice(0, 6)}`]) } : c));
}

/** A result's or a filter's sender in words: 你, Orrery 系统, 插件 x, or the member's choice label. */
export function senderLabel(from, choices) {
  const fixed = FIXED_SENDERS.find((s) => s.value === from);
  if (fixed) return fixed.label;
  if (typeof from === 'string' && from.startsWith('plugin:')) return t("插件 {value1}", { value1: from.slice(7) });
  return choices.find((c) => c.value === from)?.label ?? t("（未知成员）");
}

/** The category select: '' (any message), a system category, or warning:<level>. */
export const CATEGORY_CHOICES = Object.freeze([
  { value: '', get label() { return t("不限类别"); } },
  { value: 'warning', get label() { return t("{warning}（全部）", { warning: SYSTEM_CATEGORY_LABELS.warning }); } },
  { value: 'warning:problem', get label() { return `${SYSTEM_CATEGORY_LABELS.warning} · ${WARNING_LEVEL_LABELS.problem}`; } },
  { value: 'warning:attention', get label() { return `${SYSTEM_CATEGORY_LABELS.warning} · ${WARNING_LEVEL_LABELS.attention}`; } },
  ...['task', 'coordinator', 'member', 'other'].map((c) => ({ value: c, get label() { return SYSTEM_CATEGORY_LABELS[c]; } })),
]);

export const EMPTY_CRITERIA = Object.freeze({ q: '', sender: '', category: '', from: '', to: '', files: false, order: 'desc' });

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A local calendar day 'YYYY-MM-DD' as a Date at its local midnight, or null when it is no real day. */
function localDay(text) {
  const m = DAY.exec(text);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/**
 * The query string for one page of a search, or `{ error }` for criteria the Hub would refuse. Dates are local days,
 * both included: `from` its midnight, `to` the last millisecond before the next local midnight.
 */
export function searchQuery(criteria, cursor = null) {
  const params = new URLSearchParams();
  const q = criteria.q.trim();
  if (q.length > 200) return { error: t("关键词最多 200 个字。") };
  if (q) params.set('q', q);
  if (criteria.sender) params.set('sender', criteria.sender);
  if (criteria.category) {
    const [category, level] = criteria.category.split(':');
    params.set('category', category);
    if (level) params.set('level', level);
  }
  const from = criteria.from ? localDay(criteria.from) : null;
  const to = criteria.to ? localDay(criteria.to) : null;
  if ((criteria.from && !from) || (criteria.to && !to)) return { error: t("日期写法不对，请用日期选择器选一天。") };
  if (from && to && from > to) return { error: t("开始日期晚于结束日期。") };
  if (from) params.set('from', from.toISOString());
  if (to) params.set('to', new Date(new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() - 1).toISOString());
  if (criteria.files) params.set('files', '1');
  if (criteria.order === 'asc') params.set('order', 'asc');
  if (cursor) params.set('cursor', cursor);
  return { query: params.toString() };
}

/** No criterion at all: the sheet asks for one instead of listing the whole history. */
export const criteriaEmpty = (c) => !c.q.trim() && !c.sender && !c.category && !c.from && !c.to && !c.files;

/** The search criteria that match what the chat filter shows in cluster `cid` (for 在全部历史里搜索). */
export function criteriaFromFilter(filter, cid) {
  return { ...EMPTY_CRITERIA, sender: filter.senders?.[cid] ?? '', category: filter.warningsOnly ? 'warning' : '' };
}
/** `text` cut into `{ text, hit }` runs at the Hub's `marks` ([start, end) ranges, in order); bad ranges are ignored. */
export function markedParts(text, marks = []) {
  const parts = [];
  let from = 0;
  for (const [s, e] of marks) {
    if (!(Number.isInteger(s) && Number.isInteger(e) && s >= from && e > s && e <= text.length)) continue;
    if (s > from) parts.push({ text: text.slice(from, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    from = e;
  }
  if (from < text.length || !parts.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/** The system-category mark of a result row, e.g. 警告 · 问题; null for a member's or the user's message. */
export function categoryMark(item) {
  if (!isSystemMessage(item)) return null;
  const { category, level } = systemClass(item.systemKind);
  return { category, level, label: level ? `${SYSTEM_CATEGORY_LABELS[category]} · ${WARNING_LEVEL_LABELS[level]}` : SYSTEM_CATEGORY_LABELS[category] };
}

/** Loaded warnings of a cluster the chat filter hides (a jump's target is shown, so not counted). */
export function hiddenWarnings(messages, filter, jumpId = null) {
  return messages.filter((m) => m && isSystemMessage(m) && systemClass(m.systemKind).category === 'warning'
    && chatRowState(m, filter, jumpId) === 'hidden').length;
}

/**
 * The 筛选 control's warning badge from two numbers: `hidden`, the loaded messages of the chat's current window that
 * are warnings the filter hides; `arrived`, warnings streamed in for this cluster since the user last closed the filter
 * panel or changed the filter, that the filter hid when they came. In an older window those are not loaded, so they are
 * not in `hidden`; at the newest messages they are loaded and counted in both. Old warnings never count as arrived.
 */
export function warningBadge(hidden, arrived) {
  if (!hidden && !arrived) return { shown: false, fresh: false, text: '', title: '', note: '' };
  const here = hidden ? t("已加载的消息里有 {hidden} 条警告被筛选隐藏", { hidden: hidden }) : '';
  const fresh = arrived ? t("上次看筛选以后新到 {arrived} 条被隐藏的警告", { arrived: arrived }) : '';
  return {
    shown: true, fresh: arrived > 0,
    text: `${hidden || ''}${hidden && arrived ? ' · ' : ''}${arrived ? t("新 {arrived}", { arrived: arrived }) : ''}`,
    title: [here, fresh].filter(Boolean).join(t("；")),
    note: t("{value1}。{value2}", { value1: [here, fresh].filter(Boolean).join(t("；")), value2: arrived ? t("新到的可能不在当前显示的这段里；关上这个面板后不再算新。") : '' }),
  };
}

/** The text after the results: what the Hub said about the next page. */
export function moreLabel(reason, order) {
  if (reason === 'limit') return t("加载更多");
  if (reason === 'scan') return order === 'asc' ? t("继续搜索更新的消息") : t("继续搜索更早的消息");
  return null;
}

/** The status line after an answer: how many were found, and whether history goes on. */
export function resultText(count, reason, order) {
  const rest = order === 'asc' ? t("更新") : t("更早");
  if (!count) return reason === 'scan' ? t("最近查过的一批消息里没有，{rest}的还没查。", { rest: rest }) : t("没有找到符合条件的消息。");
  return t("找到 {count} 条{value2}。", { count: count, value2: reason === 'limit' ? t("，还有更多") : reason === 'scan' ? t("，{rest}的消息还没查完", { rest: rest }) : '' });
}

// ---- the sheet's state: one value, changed only by nextSearch (like ui.js nextJump) ----

/** What a criteria value asks the Hub (its first page), or its error: two values that ask the same are the same search. */
const queryKey = (c) => { const built = searchQuery(c); return built.error ? `error:${built.error}` : built.query; };
export const sameSearch = (a, b) => Boolean(a && b) && queryKey(a) === queryKey(b);

/**
 * The search sheet as a value:
 * - `cid`: the cluster it searches; `draft`: what the form shows; `criteria`: the search the rows belong to (null: none
 *   yet); `rows`, `next` ({ cursor, reason } or null): the stable page, always of `criteria`;
 * - `status`: idle | loading (a new search is out) | appending (the next page of `criteria` is out) | error (the last
 *   search failed or its criteria are invalid; `error.text` says why); `error.append`: a continuation failed, the page
 *   before it stays;
 * - `request`: the one request out ({ token, criteria, append, cursor, restore }), or null; `tokens`: the last token
 *   given. An answer whose token is not the request's is stale and changes nothing.
 */
export const SEARCH_START = Object.freeze({ cid: null, draft: EMPTY_CRITERIA, criteria: null, rows: [], next: null, status: 'idle', error: null, request: null, tokens: 0 });

/**
 * The sheet's next state. Events: open {cid, prefill?}, cluster {cid}, edit {patch}, commit, sort, clear, more, pick,
 * close, answer {token, items, cursor, reason}, failed {token, message}. Rules: rows always belong to `criteria`; a
 * form change only edits `draft`, and "load more" works only while `draft` asks the same as `criteria` (otherwise it is
 * hidden until the new search lands); sort and clear are form changes that commit at once; a new search supersedes any
 * request out; a continuation that fails or is abandoned leaves the page it continued, with its continue button; close
 * drops the request out and puts the form back to `criteria`, keeping the page for this cluster; another cluster starts over.
 */
export function nextSearch(state, event) {
  const fresh = (cid) => ({ ...SEARCH_START, cid, tokens: state.tokens });
  switch (event.type) {
    case 'open': {
      const base = event.cid === state.cid ? state : fresh(event.cid);
      if (!event.prefill) return base;
      return nextSearch({ ...base, draft: { ...EMPTY_CRITERIA, ...event.prefill, order: base.draft.order } }, { type: 'commit' });
    }
    case 'cluster': return event.cid === state.cid ? state : fresh(event.cid);
    case 'edit': return { ...state, draft: { ...state.draft, ...event.patch } };
    case 'sort': return nextSearch(nextSearch(state, { type: 'edit', patch: { order: state.draft.order === 'asc' ? 'desc' : 'asc' } }), { type: 'commit' });
    case 'clear': return nextSearch(nextSearch(state, { type: 'edit', patch: { ...EMPTY_CRITERIA, order: state.draft.order } }), { type: 'commit' });
    case 'commit': {
      const draft = state.draft;
      const built = searchQuery(draft);
      if (built.error) return { ...state, criteria: draft, rows: [], next: null, status: 'error', error: { text: built.error, append: false }, request: null };
      if (criteriaEmpty(draft)) return { ...state, criteria: draft, rows: [], next: null, status: 'idle', error: null, request: null };
      if (state.request && sameSearch(state.request.criteria, draft)) return state;   // already asked (its first or next page)
      if (!state.request && state.status === 'idle' && !state.error && sameSearch(state.criteria, draft)) return state;   // already shown
      const restore = state.request ? state.request.restore : { status: state.status, error: state.error };
      const token = state.tokens + 1;
      return { ...state, tokens: token, status: 'loading', request: { token, criteria: draft, append: false, cursor: null, restore } };
    }
    case 'more': {
      if (state.request || state.status !== 'idle' || !state.next?.cursor || !sameSearch(state.draft, state.criteria)) return state;
      const token = state.tokens + 1;
      return { ...state, tokens: token, status: 'appending', error: null,
        request: { token, criteria: state.criteria, append: true, cursor: state.next.cursor, restore: { status: 'idle', error: state.error } } };
    }
    case 'answer': {
      const r = state.request;
      if (!r || r.token !== event.token) return state;
      const next = event.cursor ? { cursor: event.cursor, reason: event.reason } : null;
      return { ...state, criteria: r.criteria, rows: r.append ? [...state.rows, ...event.items] : event.items, next, status: 'idle', error: null, request: null };
    }
    case 'failed': {
      const r = state.request;
      if (!r || r.token !== event.token) return state;
      if (r.append) return { ...state, status: 'idle', error: { text: t("继续搜索失败：{message}", { message: event.message }), append: true }, request: null };
      return { ...state, criteria: r.criteria, rows: [], next: null, status: 'error', error: { text: t("搜索失败：{message}", { message: event.message }), append: false }, request: null };
    }
    case 'close': {
      const settled = state.request ? { ...state, ...state.request.restore, request: null } : state;
      return { ...settled, draft: settled.criteria ?? { ...EMPTY_CRITERIA, order: state.draft.order } };
    }
    case 'pick': return state;   // a result click jumps (app.js openMessage); the sheet's own state does not change
    default: return state;
  }
}

/**
 * What the sheet shows for a state: `text` and `kind` of the status line, the empty-state `hint`, the `more` button's
 * label (null: no button), and whether the rows are `stale` (a new search is out, they belong to the previous one).
 */
export function searchView(state) {
  const { status, criteria, rows, next, error } = state;
  const order = criteria?.order ?? state.draft.order;
  const nothing = !criteria || criteriaEmpty(criteria);
  const idleHint = t("每一项都可以单独用：比如只选一个发送者，或只选“警告 · 问题”。");
  if (status === 'loading') return { kind: 'loading', text: t("正在搜索…"), hint: '', more: null, stale: rows.length > 0 };
  if (status === 'appending') return { kind: 'loading', text: t("正在继续搜索…"), hint: '', more: null, stale: false };
  if (status === 'error') return { kind: 'error', text: error.text, hint: '', more: null, stale: false };
  if (nothing) return { kind: 'idle', text: t("在本群的全部历史里查找，已移出成员的发言也在内。"), hint: idleHint, more: null, stale: false };
  const text = resultText(rows.length, next?.reason ?? null, order) + (error?.append ? ` ${error.text}` : '');
  return { kind: error?.append ? 'error' : 'done', text, hint: rows.length ? '' : t("试试换个关键词，或放宽发送者、类别和日期。"),
    more: sameSearch(state.draft, criteria) ? moreLabel(next?.reason ?? null, order) : null, stale: false };
}

const fullTime = (iso) => new Date(iso).toLocaleString(language() === 'en' ? 'en-GB' : 'zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The search sheet: draws `nextSearch`'s state and turns the user's actions and the Hub's answers into its events.
 * `deps`: api(method, path), members() (every member the page knows, removed ones included), appName(harness),
 * openMessage(cid, id), narrow() (true: a result click closes the sheet), onToggle(open, hadFocus). Returns
 * { open(cid, prefill?), close(), sync(cid) }; sync runs on every chat render: another cluster (or none) closes the
 * sheet and starts it over, the same one refreshes the sender list.
 */
export function createChatSearch(deps) {
  let state = SEARCH_START;
  let timer = null;   // the keyword's pause before it searches; cleared by every event that changes the context
  let choices = [];
  let choicesSig = '';
  let drawnRows = null;

  const q = h('input', { type: 'search', class: 'search-q', placeholder: t("关键词"), 'aria-label': t("关键词"), maxlength: '200', autocomplete: 'off' });
  const sender = h('select', { 'aria-label': t("发送者") });
  const category = h('select', { 'aria-label': t("系统消息类别") }, CATEGORY_CHOICES.map((c) => h('option', { value: c.value }, c.label)));
  const from = h('input', { type: 'date', 'aria-label': t("开始日期") });
  const to = h('input', { type: 'date', 'aria-label': t("结束日期") });
  const files = h('input', { type: 'checkbox' });
  const order = h('button', { type: 'button', class: 'small search-order', title: t("切换结果顺序") });
  const reset = h('button', { type: 'button', class: 'small' }, t("清空条件"));
  const status = h('p', { class: 'search-status muted', role: 'status' });
  const list = h('ol', { class: 'search-results', 'aria-label': t("搜索结果") });
  const more = h('button', { type: 'button', class: 'small search-more', hidden: true });
  const empty = emptyState('');   // its sentence is the search's hint, set on each draw
  empty.hidden = true;
  const closeButton = h('button', { type: 'button', class: 'icon-button ghost', title: t("关闭搜索"), 'aria-label': t("关闭搜索") }, icon('close'));
  const body = h('div', { class: 'search-body' }, empty, list, more);
  const sheet = h('section', { id: 'chat-search', class: 'chat-search', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'chat-search-title', hidden: true },
    h('header', { class: 'search-head' }, h('h2', { id: 'chat-search-title' }, t("搜索群聊记录")), closeButton),
    h('div', { class: 'search-form' },
      h('div', { class: 'search-q-row' }, icon('search'), q),
      h('div', { class: 'search-grid' },
        h('label', {}, h('span', {}, t("发送者")), sender),
        h('label', {}, h('span', {}, t("系统消息")), category),
        h('label', {}, h('span', {}, t("从")), from),
        h('label', {}, h('span', {}, t("到")), to)),
      h('div', { class: 'search-row' },
        h('label', { class: 'search-check' }, files, t("只看带附件的")),
        h('span', { class: 'search-row-end' }, reset, order))),
    status, body,
    h('p', { class: 'search-foot muted' }, t("名字是成员现在的名字；已移出的成员也能选。")));
  document.body.append(sheet);

  // Events after which a pending keyword pause must not fire: it would search in a context that has moved on.
  const SETTLES = new Set(['commit', 'sort', 'clear', 'close', 'cluster', 'open']);
  function dispatch(event) {
    const before = state;
    state = nextSearch(state, event);
    if (SETTLES.has(event.type)) stopPause();
    if (state.cid !== before.cid) choicesSig = '';
    const r = state.request;
    if (r && r !== before.request) void send(state.cid, r);
    draw();
  }

  async function send(cid, r) {
    const { query } = searchQuery(r.criteria, r.append ? r.cursor : null);
    try {
      const answer = await deps.api('GET', `/api/clusters/${encodeURIComponent(cid)}/messages/search?${query}`);
      dispatch({ type: 'answer', token: r.token, items: answer.items, cursor: answer.cursor, reason: answer.reason });
    } catch (e) {
      dispatch({ type: 'failed', token: r.token, message: e.message });
    }
  }

  function fillSenders() {
    const fresh = senderChoices(deps.members(), state.cid, deps.appName);
    const sig = JSON.stringify(fresh);
    if (sig === choicesSig) return;
    choicesSig = sig;
    choices = fresh;
    drawnRows = null;   // result rows name senders by these labels
    const active = choices.filter((c) => !c.removed), removed = choices.filter((c) => c.removed);
    sender.replaceChildren(h('option', { value: '' }, t("所有人")), ...FIXED_SENDERS.map((s) => h('option', { value: s.value }, s.label)),
      active.length ? h('optgroup', { label: t("成员") }, active.map((c) => h('option', { value: c.value }, c.label))) : null,
      removed.length ? h('optgroup', { label: t("已移出的成员") }, removed.map((c) => h('option', { value: c.value }, c.label))) : null);
    sender.value = state.draft.sender;   // new options reset the shown choice; a member who left is still in the list
    // A chosen member gone from the list (its cluster purged): back to everyone, searched again.
    const chosen = state.draft.sender;
    if (chosen && !FIXED_SENDERS.some((s) => s.value === chosen) && !choices.some((c) => c.value === chosen)) {
      dispatch({ type: 'edit', patch: { sender: '' } });
      if (!sheet.hidden) dispatch({ type: 'commit' });
    }
  }

  function row(item) {
    const mark = categoryMark(item);
    const parts = markedParts(item.snippet, item.marks).filter((p) => p.text);
    return h('li', {}, h('button', { type: 'button', class: 'search-result', onclick: () => pick(item) },
      h('span', { class: 'search-result-head' },
        h('span', { class: 'search-who' }, senderLabel(item.from, choices)),
        mark ? h('span', { class: `search-mark${mark.level ? ` ${mark.level}` : ''}` }, mark.label) : null,
        h('time', { datetime: item.createdAt }, fullTime(item.createdAt))),
      parts.length ? h('p', { class: 'search-snippet' }, parts.map((p) => (p.hit ? h('mark', {}, p.text) : p.text)))
        : h('p', { class: 'search-snippet muted' }, t("（没有文字）"))));
  }

  function draw() {
    const d = state.draft;
    // The form shows the draft; a field already showing it is left alone (typing, IME composition, the caret).
    if (q.value !== d.q) q.value = d.q;
    if (sender.value !== d.sender) sender.value = d.sender;
    if (category.value !== d.category) category.value = d.category;
    if (from.value !== d.from) from.value = d.from;
    if (to.value !== d.to) to.value = d.to;
    files.checked = d.files;
    order.textContent = d.order === 'asc' ? t("最早在前") : t("最新在前");
    const view = searchView(state);
    if (state.rows !== drawnRows) { list.replaceChildren(...state.rows.map(row)); drawnRows = state.rows; }
    list.classList.toggle('stale', view.stale);
    body.setAttribute('aria-busy', String(view.kind === 'loading'));
    more.hidden = !view.more;
    if (view.more) more.textContent = view.more;
    status.textContent = view.text;
    status.dataset.state = view.kind;
    empty.hidden = !view.hint || state.rows.length > 0;
    empty.querySelector('p').textContent = view.hint;
  }

  function pick(item) {
    dispatch({ type: 'pick' });
    const cid = state.cid;
    if (deps.narrow()) close();
    deps.openMessage(cid, item.id);
  }

  function open(cid, prefill = null) {
    dispatch({ type: 'open', cid, prefill });
    fillSenders();
    sheet.hidden = false;
    deps.onToggle?.(true);
    q.focus();
  }
  function close() {
    if (sheet.hidden) return;
    dispatch({ type: 'close' });
    const focused = sheet.contains(document.activeElement);
    sheet.hidden = true;
    deps.onToggle?.(false, focused);
  }

  const edit = (patch) => dispatch({ type: 'edit', patch });
  // An IME composition is a draft of the keyword: nothing is searched until it ends. Any pause still running is
  // stopped when it starts, and the pause itself checks again before it searches.
  let composing = false;
  const stopPause = () => { clearTimeout(timer); timer = null; };
  const pause = () => {
    stopPause();
    timer = setTimeout(() => { timer = null; if (!composing) dispatch({ type: 'commit' }); }, 300);
  };
  q.addEventListener('compositionstart', () => { composing = true; stopPause(); });
  q.addEventListener('input', (e) => {
    edit({ q: q.value });
    composing = e.isComposing;   // the browser's own word, also when a composition ended without compositionend
    if (composing) { stopPause(); return; }
    pause();
  });
  q.addEventListener('compositionend', () => {
    composing = false;
    edit({ q: q.value });
    pause();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || composing) return;
    e.preventDefault();
    edit({ q: q.value });
    dispatch({ type: 'commit' });
  });
  sender.addEventListener('change', () => { edit({ sender: sender.value }); dispatch({ type: 'commit' }); });
  category.addEventListener('change', () => { edit({ category: category.value }); dispatch({ type: 'commit' }); });
  from.addEventListener('change', () => { edit({ from: from.value }); dispatch({ type: 'commit' }); });
  to.addEventListener('change', () => { edit({ to: to.value }); dispatch({ type: 'commit' }); });
  files.addEventListener('change', () => { edit({ files: files.checked }); dispatch({ type: 'commit' }); });
  order.addEventListener('click', () => dispatch({ type: 'sort' }));
  reset.addEventListener('click', () => { dispatch({ type: 'clear' }); q.focus(); });
  more.addEventListener('click', () => dispatch({ type: 'more' }));
  closeButton.addEventListener('click', close);
  sheet.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    e.preventDefault();
    close();
  });

  return {
    open, close,
    sync(cid) {
      if (cid === state.cid) { if (!sheet.hidden) fillSenders(); return; }
      close();
      dispatch({ type: 'cluster', cid });
    },
  };
}
