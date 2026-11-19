import { t, language } from "./i18n.js";
// The workbench owns only its view state. The Hub validates every task command and owns all durable data.
import { attachMenu, attachmentNode, avatarEl, avatarKind, confirmDialog, emptyState, h, hiddenMark, icon, noticeDialog } from './ui.js';
import { createTaskDiffView } from './task-diff-view.js';
import { combobox } from './workbench-combobox.js';
import { filesField, formDialog } from './workbench-form.js';
import { createGraphCanvas } from './workbench-graph.js';
import { filterSections, isLibrarySignal, labelIndex, labelPicker, libraryColor, openLabelManager } from './workbench-labels.js';
import { STALLED_CAVEAT, stalledLines, stalledTaskText } from './stalled.js';

const STATUS = { pending: '待开工', working: '进行中', review: '待验收', completed: '已完成', merged: '已合并', cancelled: '已取消' };
const CLOSED_STATUSES = ['completed', 'merged', 'cancelled'];
export const pendingApproval = (task) => task.proposalState === 'proposed' && task.status === 'pending';
const PRIORITY = { low: '低', normal: '普通', high: '高' };
const PERMISSIONS = [
  ['taskPlanning', '任务规划', '创建和调整任务及依赖'], ['assignment', '任务分派', '分配执行成员'],
  ['roleManagement', '业务角色管理', '管理成员的业务角色'], ['reviewerManagement', '验收安排', '安排验收者与角色'],
  ['knowledgeCommunication', '资料与沟通', '整理关联资料并通知成员'], ['recovery', '故障协调', '协调受阻和恢复'],
  ['cancelReopen', '取消与重开', '按授权取消或重开任务'], ['deliveryControl', '投递控制', '暂停或恢复群投递'],
];
export const taskStatus = (task) => `${pendingApproval(task) ? t("待批准 · ") : ''}${(STATUS[task.status] ? t(STATUS[task.status]) : task.status)}${task.dependenciesChanged || (['completed', 'merged'].includes(task.status) && task.completionValid === false)
  ? t(" · 依赖已变化，需复核") : ''}`;
/** Why a task was cancelled (docs/collaboration.md); the cancel dialog offers them in this order, the first preselected. */
export const CLOSE_REASONS = { not_planned: '不做了', duplicate: '重复', superseded: '被取代', other: '其他' };
/** Only "其他" forces the user to type extra prose; 不做了 / 重复 / 被取代 speak for themselves (with relatedTaskId). */
export const cancelReasonRequired = (kind) => kind === 'other';
/** Human-readable task label with `#number` when assigned (legacy fixtures without `number` keep plain title). */
export const taskLabel = (task) => (task ? (task.number != null ? `#${task.number} ${task.title}` : task.title) : '');
export const closeCandidateText = (task) => `${task.number != null ? `#${task.number} ` : ''}${task.title} · ${(STATUS[task.status] ? t(STATUS[task.status]) : task.status)}`;

/** Searchable single-task picker used by the cancel dialog when marking a task duplicate or superseded. */
export function createRelatedTaskPicker({ clusterId, excludeId = null, load }) {
  let selected = null;
  let candidates = [];
  let started = false;
  let loading = false;
  let composing = false;
  let seq = 0;
  const search = h('input', { type: 'search', class: 'wb-close-search', placeholder: t("输入 #编号 或标题搜索任务"),
    'aria-label': t("搜索关联任务"), autocomplete: 'off', spellcheck: 'false' });
  const selectedEl = h('p', { class: 'wb-close-picked', hidden: true });
  const listEl = h('div', { class: 'wb-close-options', role: 'listbox', 'aria-label': t("可选任务") });
  // While a search runs: its own line, so the empty state below keeps its picture and sentence.
  const loadingEl = h('p', { class: 'muted wb-close-loading', hidden: true }, t("正在搜索…"));
  const emptyEl = emptyState(t("没有匹配的任务"), { compact: true });
  emptyEl.hidden = true;
  const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
  // Keep any option button under a pressed pointer intact until pointerup so late search results never eat the click.
  const redraws = redrawGate(listEl, () => renderList(), () => false);

  const localRank = (task, q) => {
    if (!q) return 0;
    const numMatch = /^#?([1-9]\d*)$/.exec(q);
    if (numMatch && task.number === Number(numMatch[1])) return 0;
    if (numMatch && task.number != null && String(task.number).startsWith(numMatch[1])) return 1;
    const hex = q.toLowerCase().replace(/-/g, '');
    if (/^[0-9a-f]{4,32}$/.test(hex) && String(task.id).toLowerCase().replace(/-/g, '').startsWith(hex)) return 2;
    if (task.title?.toLowerCase().includes(q.toLowerCase())) return 3;
    return -1;
  };

  function renderList() {
    if (!redraws.request()) return;
    const q = search.value.trim();
    const visible = candidates
      .filter((task) => task.id !== excludeId)
      .map((task) => ({ task, rank: localRank(task, q) }))
      .filter((item) => item.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((item) => item.task);
    listEl.replaceChildren(...visible.map((task) => h('button', {
      type: 'button',
      role: 'option',
      class: 'wb-close-option',
      'aria-selected': String(selected?.id === task.id),
      onclick: () => {
        selected = task;
        selectedEl.textContent = t("已选：{name}", { name: closeCandidateText(task) });
        selectedEl.hidden = false;
        renderList();
      },
    },
    task.number != null ? h('span', { class: 'wb-task-num' }, `#${task.number}`) : null,
    h('span', { class: 'wb-close-opt-title' }, task.title),
    h('span', { class: 'wb-close-opt-status' }, (STATUS[task.status] ? t(STATUS[task.status]) : task.status)))));
    loadingEl.hidden = !loading || visible.length > 0;
    emptyEl.hidden = loading || visible.length > 0;
  }

  async function refreshQuery(q) {
    const mine = ++seq;
    loading = true;
    errorEl.hidden = true;
    renderList();
    try {
      const items = await load(clusterId, q);
      if (mine !== seq) return;
      candidates = items ?? [];
    } catch (e) {
      if (mine !== seq) return;
      errorEl.textContent = t("加载可选任务失败：{error}", { error: e.message });
      errorEl.hidden = false;
    } finally {
      if (mine === seq) { loading = false; renderList(); }
    }
  }

  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; void refreshQuery(search.value.trim()); });
  search.addEventListener('input', () => { if (!composing) void refreshQuery(search.value.trim()); else renderList(); });

  return {
    el: h('div', { class: 'wb-close-picker' }, search, selectedEl, errorEl, listEl, loadingEl, emptyEl),
    search,
    start() { if (!started) { started = true; void refreshQuery(''); } },
    value: () => selected?.id ?? '',
    dispose() { seq++; loading = false; redraws.dispose(); },
  };
}
/** The reasons that name another task: what the dialog's picker asks, and the detail's sentence around the link. */
const RELATED_REASONS = { duplicate: { pick: '与哪个任务重复', before: '与任务', after: '重复' },
  superseded: { pick: '被哪个任务取代', before: '已被任务', after: '取代' } };
export const relatedReason = (kind) => Object.hasOwn(RELATED_REASONS, kind) ? { pick: t(RELATED_REASONS[kind].pick), before: t(RELATED_REASONS[kind].before), after: language() === 'en' ? '' : t(RELATED_REASONS[kind].after) } : null;
/** The status chip's text; a cancelled task with a reason says it, an older one stays plain 已取消. */
export function statusText(task) {
  if (pendingApproval(task)) return t("待批准");
  const kind = task.status === 'cancelled' ? task.closeReason?.kind : null;
  if (kind && Object.hasOwn(CLOSE_REASONS, kind)) return `${t(STATUS.cancelled)} · ${t(CLOSE_REASONS[kind])}`;
  return (STATUS[task.status] ? t(STATUS[task.status]) : task.status);
}
/** The cancel command's reason fields: a related task only for the reasons that take one (the Hub refuses it otherwise). */
export const closeReasonFields = (kind, relatedTaskId) => ({ closeReason: kind, ...(relatedReason(kind) ? { relatedTaskId } : {}) });
/**
 * The marks of an open task whose executor or reviewer is hidden (docs/cluster-members.md「隐身」); only the user's page
 * shows them. `memberOf(id)` returns the member or null. Closed tasks get none: nobody is waiting on them.
 */
export function taskHiddenMarks(task, memberOf) {
  if (CLOSED_STATUSES.includes(task.status)) return [];
  const hidden = (id) => { const m = id ? memberOf(id) : null; return Boolean(m && !m.removedAt && m.hiddenAt); };
  return [
    ...(hidden(task.assignedMemberId) ? [t("执行者隐身中")] : []),
    ...(task.reviewer?.kind === 'member' && hidden(task.reviewer.memberId) ? [t("验收人隐身中")] : []),
  ];
}
export function taskAssignee(task, nameOf) {
  if (task.assignedMemberId) return nameOf(task.assignedMemberId);
  return CLOSED_STATUSES.includes(task.status) ? null : t("未分配");
}

/**
 * Who is responsible: the active assignee, or — once the Hub clears assignedMemberId on completion/cancel — the
 * member whose assignment ended last. Null when nobody was ever assigned.
 */
export function taskOwner(task, assignments = [], complete = true) {
  if (task.assignedMemberId) return task.assignedMemberId;
  if (!complete || !CLOSED_STATUSES.includes(task.status)) return null;
  return assignments.at(-1)?.memberId ?? null;
}

/** Chip text for a task without a known executor: closed tasks ended, open tasks are still unassigned. */
export const closedNote = (task) => CLOSED_STATUSES.includes(task.status) ? t("已结束") : t("未分配");

/**
 * The confirmation text for permanently deleting a cancelled task (docs/collaboration.md): it names the task, says
 * the removal cannot be undone, and tells the user how many linked group messages survive without the link.
 */
export const taskDeleteWarning = (task, linkedMessageCount) => t("任务「{title}」将被永久删除，不能恢复。", { title: task.title })
  + t("它的派工、提交、验收、批准和合并记录会一起删除；{count} 条关联群聊消息会保留，只解除与这个任务的关联。", { count: Number.isSafeInteger(linkedMessageCount) ? linkedMessageCount : 0 });

/** The dependency/completion warning a task carries; every view that shows a task keeps it visible. */
export const needsReview = (task) => Boolean(task.dependenciesChanged || (['completed', 'merged'].includes(task.status) && task.completionValid === false));

export const pendingMerge = (task) => task.status === 'completed' && task.mergeRequired === true;
export const supersededSubmission = (task, submission) => Object.hasOwn(task, 'latestSubmissionId') && submission.id !== task.latestSubmissionId;

/** Why the review mode after a reviewer takeover is what it is (docs/collaboration.md「验收者接手」). */
export const TAKEOVER_BASIS = { user: '用户本人操作', cluster_setting: '群设置授权', user_review: '默认改为用户验收', named_member: '指定成员' };
/** The 验收者接手 mark of a task taken over by its reviewer, or null. */
export const takeoverMark = (task) => task.takeover ? t("验收者接手 · {basis}", { basis: (TAKEOVER_BASIS[task.takeover.basis] ? t(TAKEOVER_BASIS[task.takeover.basis]) : t("依据未知")) }) : null;
/** A review mode in words: 用户验收, 自查, or 成员验收 (`nameOf` names the member). */
export const reviewModeText = (reviewer, nameOf) => reviewer?.kind === 'member' ? t("成员验收（{name}）", { name: nameOf(reviewer.memberId) })
  : reviewer?.kind === 'self' ? t("自查") : t("用户验收");
/** A task its member reviewer can take over: not awaiting approval, still pending, working or in review. */
export const canTakeOver = (task) => task.reviewer?.kind === 'member' && task.proposalState !== 'proposed'
  && ['pending', 'working', 'review'].includes(task.status);
/**
 * The takeover command for the dialog's choice: user review sends no reviewer (the Hub's default), a member needs one
 * picked. Returns null while the choice is incomplete.
 */
export function takeoverCommand(task, mode, memberId) {
  const base = { action: 'task.takeover', taskId: task.id, expectedRevision: task.revision };
  if (mode === 'self') return { ...base, reviewer: { kind: 'self' } };
  if (mode === 'member') return memberId ? { ...base, reviewer: { kind: 'member', memberId } } : null;
  return base;
}

/**
 * The task detail's controls: at most one primary action for the state the task is in, the negative paired with it,
 * and the rest for the 更多 menu, each only when it applies. The Hub still validates every command.
 */
export function taskActionPlan(task) {
  const closed = CLOSED_STATUSES.includes(task.status);
  const assignable = task.status === 'pending' && task.proposalState !== 'proposed';
  const canMarkCompleted = task.status !== 'merged' && (task.status !== 'completed' || task.completionValid === false);
  const canMarkMerged = task.status !== 'merged' || task.completionValid === false;
  const primary = pendingApproval(task) ? 'approve'
    : task.status === 'review' && task.latestSubmissionId ? 'accept'
      : pendingMerge(task) ? (task.manualCompletion ? 'markMerged' : 'merge')
        : assignable && !task.assignedMemberId ? 'assign' : null;
  const negative = { approve: 'rejectTask', accept: 'rejectResult' }[primary] ?? null;
  // The task definition is editable only while pending.
  const more = [task.status === 'pending' && 'edit', ['working', 'review'].includes(task.status) && 'reviewer',
    assignable && primary !== 'assign' && 'assign',
    task.assignedMemberId && 'release', task.assignedMemberId && 'handoff', canTakeOver(task) && 'takeover',
    canMarkCompleted && 'markCompleted', canMarkMerged && primary !== 'markMerged' && 'markMerged',
    'gitBranch', task.gitBranch && 'clearGitBranch', 'public',
    closed && 'reopen', !closed && 'cancel', task.status === 'cancelled' && 'delete'].filter(Boolean);
  return { primary, negative, more };
}

/** The record sections a task detail shows: only those with records (合并记录 also for a recorded merge commit). */
export const recordSections = (detail) => ['attentions', 'submissions', 'reviews', 'takeovers', 'approvals', 'merges', 'assignments']
  .filter((key) => (detail?.[key] ?? []).length > 0 || (key === 'merges' && Boolean(detail?.task?.mergedCommitSha)));

/** Every record collection shares the Hub's cursor; old Hub responses may omit newer collections. */
export function appendTaskRecords(detail, next) {
  const keys = ['assignments', 'submissions', 'reviews', 'attentions', 'approvals', 'merges', 'takeovers'];
  return { ...detail, ...Object.fromEntries(keys.map((key) => [key, [...(detail[key] ?? []), ...(next[key] ?? [])]])),
    nextCursor: next.nextCursor };
}

/**
 * What a submission shows: the attachments of its evidence messages, then its bare evidence files. A bare file has
 * metadata only when some loaded message carried it; otherwise just its id is known (see attachmentNode).
 */
export function submissionFiles(submission, messageFiles) {
  const known = new Map([...messageFiles.values()].flat().map((file) => [file.id, file]));
  const files = new Map();
  for (const id of submission.evidenceMessageIds ?? []) for (const file of messageFiles.get(id) ?? []) files.set(file.id, file);
  for (const id of submission.evidenceFileIds ?? []) if (!files.has(id)) files.set(id, known.get(id) ?? { id, name: t("证据附件 {id}", { id: id.slice(0, 8) }) });
  return [...files.values()];
}

/** The attachments of the linked messages, each once, without the ones a submission already shows. */
export function linkedFiles(items, shown = []) {
  const seen = new Set(shown.map((file) => file.id));
  const files = [];
  for (const item of items ?? []) for (const file of item.attachments ?? []) if (!seen.has(file.id)) { seen.add(file.id); files.push(file); }
  return files;
}

// ---- task list groups (the task tab shows one collapsible section per status family) ----

/** The task-list groups in display order. `open` is the default when the cluster has no stored preference. */
export const TASK_GROUPS = [
  { key: 'approval', title: '待批准', statuses: [], open: true },
  { key: 'active', title: '进行中', statuses: ['working'], open: true },
  { key: 'review', title: '待验收', statuses: ['review'], open: true },
  { key: 'pending', title: '待开工', statuses: ['pending'], open: true },
  { key: 'completed', title: '已完成', statuses: ['completed'], open: false },
  { key: 'merged', title: '已合并', statuses: ['merged'], open: false },
  { key: 'cancelled', title: '已关闭', statuses: ['cancelled'], open: false },
];

/**
 * Group loaded tasks by status family; the incoming order (server order) is kept inside each group and groups with
 * no tasks are dropped. Unknown statuses are ignored.
 */
export function taskGroups(tasks) {
  const by = new Map(TASK_GROUPS.map((group) => [group.key, []]));
  for (const task of tasks) {
    const group = pendingApproval(task) ? TASK_GROUPS[0] : TASK_GROUPS.find((item) => item.statuses.includes(task.status));
    if (group) by.get(group.key).push(task);
  }
  return TASK_GROUPS.filter((group) => by.get(group.key).length)
    .map((group) => ({ key: group.key, title: t(group.title), open: group.open, tasks: by.get(group.key) }));
}

/**
 * Review batches (docs/collaboration.md「验收批次」): the loaded tasks of each open batch in the batch's dependency order,
 * and the tasks left for the status groups. A batch none of whose tasks is loaded (a filter hides them) is left out; a
 * batch with no task at all shows, empty.
 */
export function batchGroups(tasks, batches) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const groups = (batches ?? []).map((batch) => ({ batch, tasks: (batch.tasks ?? []).map((item) => byId.get(item.id)).filter(Boolean) }))
    .filter((group) => group.tasks.length || !group.batch.total);   // a new, empty batch still shows, to fill it
  const grouped = new Set(groups.flatMap((group) => group.tasks.map((task) => task.id)));
  return { groups, rest: tasks.filter((task) => !grouped.has(task.id)) };
}

/** A batch's progress as the texts of its chips: submitted n/m, approved k/m, and where it stands. */
export function batchProgress(batch) {
  const state = batch.merged ? t('已合并') : batch.shipFailure && batch.allApproved === false && !batch.complete ? t("合并失败，已退回")
    : batch.allApproved ? t("已全部通过，待 ship") : batch.complete ? t("已齐，待验收") : t("未齐");
  return { submitted: t('已提交 {submitted}/{total}', { submitted: batch.submitted, total: batch.total }), approved: t('已通过 {approved}/{total}', { approved: batch.approved, total: batch.total }), state,
    tone: batch.merged ? 'merged' : batch.allApproved || batch.complete ? 'ready' : batch.shipFailure ? 'failed' : 'open' };
}

const BATCH_STATE = { missing: '未提交', submitted: '已提交', approved: '已通过', merged: '已合并', cancelled: '已取消' };

/** The collapsed groups before the user changes anything: the finished and cancelled ones. */
export const defaultCollapsedTaskGroups = () => new Set(TASK_GROUPS.filter((group) => !group.open).map((group) => group.key));

/** A stored JSON array of collapsed group keys → a Set; missing, garbage or non-array → null (use the defaults). */
export function storedCollapsedTaskGroups(value) {
  try {
    const stored = JSON.parse(value);
    const legacy = Array.isArray(stored);
    const list = legacy ? stored : stored?.version === 2 ? stored.collapsed : null;
    if (!Array.isArray(list)) return null;
    const keys = new Set(list.filter((key) => typeof key === 'string' && TASK_GROUPS.some((group) => group.key === key)));
    if (legacy) keys.add('merged');
    return keys;
  } catch {
    return null;
  }
}

/** localStorage key of the collapsed task groups for one cluster. */
export const taskGroupsStorageKey = (clusterId) => `orrery.workbench.collapsedTaskGroups.${clusterId}`;

/** What the chat shows from the workspace (task titles, role names): the chat redraws only when this changes. */
export const workspaceLookupKey = (workspace) => JSON.stringify([
  (workspace?.tasks ?? []).map((task) => [task.id, task.number ?? null, task.title]), (workspace?.roles ?? []).map((role) => [role.id, role.name])]);

const REFRESH_COALESCE_MS = 250;

/** Runs `fn` once for a burst of calls within `ms` (after the first call), e.g. one refresh for many events. */
export function coalesce(fn, ms, timer = { set: (f, t) => setTimeout(f, t) }) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    timer.set(() => { pending = false; fn(); }, ms);
  };
}

/**
 * Redraws that never swap the control under a pressed pointer (a swapped control never gets its click). `request()`
 * says whether a redraw may run now; it may not while `hold()` (a graph drag, an open menu) or while a pointer is down
 * in `root`. A refused redraw runs (via `draw`) once both are over: after the release, so its click reaches the old
 * control first, or at most `ms` after the press when no release arrives. Call `settle()` when `hold()` may have ended.
 */
export function redrawGate(root, draw, hold, { win = typeof window === 'undefined' ? null : window, ms = 1000, now = Date.now, later = setTimeout } = {}) {
  let pressedAt = null;
  let waiting = false;
  let disposed = false;
  const pressing = () => pressedAt !== null && now() - pressedAt < ms;
  const run = () => { if (!disposed && waiting && !hold() && !pressing()) draw(); };
  const pressed = () => { if (disposed) return; pressedAt = now(); later(run, ms); };
  root.addEventListener('pointerdown', pressed, true);
  const released = () => { if (disposed || pressedAt === null) return; pressedAt = null; later(run, 0); };
  win?.addEventListener('pointerup', released);
  win?.addEventListener('pointercancel', released);
  return {
    request() { if (disposed) return false; waiting = hold() || pressing(); return !waiting; },
    settle() { if (!disposed) later(run, 0); },
    dispose() {
      if (disposed) return;
      disposed = true;
      waiting = false;
      pressedAt = null;
      root.removeEventListener?.('pointerdown', pressed, true);
      win?.removeEventListener?.('pointerup', released);
      win?.removeEventListener?.('pointercancel', released);
    },
  };
}

const readLocal = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeLocal = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode: keep the page working */ } };

/** Per-cluster collapsed groups held in the page: the source of truth once the user toggles, and the fallback when
 * localStorage cannot be read or written. */
const taskGroupMemory = new Map();

/** The collapsed groups for this cluster: this page's state, then the stored preference, then the defaults. */
export const collapsedTaskGroups = (clusterId) => {
  const memory = taskGroupMemory.get(clusterId);
  if (memory) return new Set(memory);
  return storedCollapsedTaskGroups(readLocal(taskGroupsStorageKey(clusterId))) ?? defaultCollapsedTaskGroups();
};

/** Flip one group's collapsed state and remember it for this cluster; a failing localStorage never blocks the page. */
export function toggleTaskGroup(clusterId, key) {
  const collapsed = collapsedTaskGroups(clusterId);
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  taskGroupMemory.set(clusterId, new Set(collapsed));
  writeLocal(taskGroupsStorageKey(clusterId), JSON.stringify({ version: 2, collapsed: [...collapsed] }));
  return collapsed;
}
/** Stable tone index for a member or role id: the same subject keeps the same colour everywhere. */
export function toneIndex(id, count = 8) {
  let hash = 0;
  for (const ch of String(id ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % count;
}

/**
 * The active label filter as a list, unique. A list keeps its items whole: a label may contain a comma (one from before
 * the label library). Only a plain string (typed text, or an old stored value) is split on either comma.
 */
export const filterLabels = (value) => [...new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item)
  : String(value ?? '').split(/[,，]/).map((item) => item.trim()).filter(Boolean))];

/** Toggle one label in the active label filter: clicking 功能 while [ui] is active yields [ui, 功能]. */
export function toggleLabelFilter(active, label) {
  const labels = filterLabels(active);
  return labels.includes(label) ? labels.filter((item) => item !== label) : [...labels, label];
}

/** The edit form's fields that differ from the task: only these are sent, so untouched labels are never rewritten. */
export function taskEditChanges(task, fields) {
  const previous = { ...task, requiresApproval: task.requiresApproval === true, mergeRequired: task.mergeRequired === true };
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value)));
}

/** Card labels: show the first `max` and report how many more there are (rendered as +N). */
export function visibleLabels(labels = [], max = 3) {
  const list = Array.isArray(labels) ? labels.filter(Boolean) : [];
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

/** True when any task filter is set; label is a list, so a plain truthiness check is not enough. */
export function hasTaskFilters(filters = {}) {
  return Boolean(filters.q) || Boolean(filters.memberId) || Boolean(filters.status) || filterLabels(filters.label).length > 0;
}

/** Workspace query params: a label list becomes repeated label parameters, which the Hub ANDs. */
export function taskFilterQuery(filters = {}, cursor) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) { for (const item of value) if (item) query.append(key, item); }
    else if (value) query.set(key, value);
  }
  if (cursor) query.set('cursor', cursor);
  return query;
}

/** The task list's sort orders, in the order the sort select offers them; the first is the default. */
export const TASK_SORTS = [['created-desc', '创建时间 新→旧'], ['created-asc', '创建时间 旧→新'],
  ['updated-desc', '最近更新'], ['priority-desc', '优先级 高→低']];
export const DEFAULT_TASK_SORT = TASK_SORTS[0][0];
/** The Hub can page both creation orders. The other sorts use the full filtered result. */
export const sortNeedsAllPages = (sort) => !['created-asc', 'created-desc'].includes(sort);
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

/**
 * Tasks in the chosen order; the input is in server order (creation, oldest first). A missing or unreadable time
 * sorts last, a missing priority reads as normal (as the card shows it), ties keep creation order (newest first,
 * oldest first for created-asc). A 4+ hex digit query keeps the tasks whose id it prefixes first, as the Hub does.
 */
// shortcut: updated/priority sorts load all filtered pages; move those sorts to the Hub if they become slow.
export function sortTasks(tasks, sort = DEFAULT_TASK_SORT, q = '') {
  const at = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? time : null; };
  const lastIfMissing = (a, b, compare) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : compare(a, b);
  const trimmed = String(q ?? '').trim();
  const numMatch = /^#?([1-9]\d*)$/.exec(trimmed);
  const targetNum = numMatch && Number.isSafeInteger(Number(numMatch[1])) ? Number(numMatch[1]) : null;
  const hex = trimmed.toLowerCase().replace(/-/g, '');
  const idRank = (task) => {
    if (targetNum !== null && task.number === targetNum) return 0;
    if (/^[0-9a-f]{4,32}$/.test(hex) && String(task.id).toLowerCase().replace(/-/g, '').startsWith(hex)) return 1;
    return 2;
  };
  const rank = (task) => PRIORITY_RANK[task.priority ?? 'normal'] ?? 3;
  const primary = {
    'created-asc': (a, b) => lastIfMissing(at(a.createdAt), at(b.createdAt), (x, y) => x - y),
    'updated-desc': (a, b) => lastIfMissing(at(a.updatedAt) ?? at(a.createdAt), at(b.updatedAt) ?? at(b.createdAt), (x, y) => y - x),
    'priority-desc': (a, b) => rank(a) - rank(b),
  }[sort] ?? ((a, b) => lastIfMissing(at(a.createdAt), at(b.createdAt), (x, y) => y - x));
  const oldestFirst = sort === 'created-asc';
  return tasks.map((task, index) => ({ task, index }))
    .sort((a, b) => idRank(a.task) - idRank(b.task) || primary(a.task, b.task) || (oldestFirst ? a.index - b.index : b.index - a.index))
    .map((item) => item.task);
}

/** One-click views beside the filter bar: page-side predicates on top of the Hub's filters, at most one at a time. */
export const QUICK_VIEWS = [
  ['review', '等我验收', (task) => task.status === 'review' && task.reviewer?.kind === 'user'],
  ['approval', '待我批准', pendingApproval],
  ['working', '进行中', (task) => task.status === 'working'],
];
/** The tasks a quick view keeps; no view (or an unknown one) keeps them all. */
export function quickViewTasks(tasks, quick) {
  const test = QUICK_VIEWS.find(([id]) => id === quick)?.[2];
  return test ? tasks.filter(test) : tasks;
}

/** localStorage key of the task list's filters and sort for one cluster. */
export const taskViewStorageKey = (clusterId) => `orrery.workbench.taskView.${clusterId}`;

/**
 * A stored filter and sort choice → { filters, sort, quick }. Garbage reads as the defaults; an unknown sort, status or quick view falls
 * back to the default, and a member the cluster no longer has is dropped. Labels are checked once the Hub lists the
 * cluster's labels (withKnownLabels).
 */
export function storedTaskView(value, { memberIds = [] } = {}) {
  let stored = null;
  try { stored = JSON.parse(value); } catch { /* garbage: the defaults */ }
  if (stored?.version !== 1) stored = null;
  const filters = stored?.filters && typeof stored.filters === 'object' ? stored.filters : {};
  // A list since it was first stored; a comma-joined string is read the old way.
  const label = Array.isArray(filters.label) || typeof filters.label === 'string' ? filterLabels(filters.label) : [];
  return {
    filters: { q: typeof filters.q === 'string' ? filters.q : '', label,
      memberId: typeof filters.memberId === 'string' && memberIds.includes(filters.memberId) ? filters.memberId : '',
      status: typeof filters.status === 'string' && Object.hasOwn(STATUS, filters.status) ? filters.status : '' },
    sort: typeof stored?.sort === 'string' && TASK_SORTS.some(([id]) => id === stored.sort) ? stored.sort : DEFAULT_TASK_SORT,
    quick: typeof stored?.quick === 'string' && QUICK_VIEWS.some(([id]) => id === stored.quick) ? stored.quick : '',
  };
}

/**
 * Load the pages a workspace answer still needs: all of them while `needAll()`, and at
 * least as many tasks as `shown()` — read after every page, because "load more" may have added pages meanwhile — so a
 * refresh never shows fewer tasks than are on screen. The last checks and `commit(workspace)` run in one synchronous
 * step, so nothing (a "load more" landing in the same tick) can change the screen between them. False when `stale()`
 * says a newer request took over.
 */
export async function loadTaskPages(workspace, fetchPage, { needAll, shown, stale, commit, progress = () => {} }) {
  for (;;) {
    if (stale()) return false;
    if (!workspace.nextCursor || !(needAll() || workspace.tasks.length < shown())) { commit(workspace); return true; }
    progress(workspace.tasks.length);
    const next = await fetchPage(workspace.nextCursor);
    workspace = { ...workspace, tasks: [...workspace.tasks, ...next.tasks], nextCursor: next.nextCursor };
  }
}

/** The filters without labels the cluster no longer uses; the same object when nothing goes (or the labels are unknown). */
export function withKnownLabels(filters, labels) {
  const selected = filterLabels(filters.label);
  if (!Array.isArray(labels) || selected.every((label) => labels.includes(label))) return filters;
  return { ...filters, label: selected.filter((label) => labels.includes(label)) };
}

/** Avatar text: Latin names keep up to two initials, CJK names keep one character. */
export function initials(name) {
  const value = String(name ?? '').trim();
  if (!value) return '?';
  if (/^[\x00-\x7F]/.test(value)) {
    const parts = value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : value.slice(0, 2)).toUpperCase();
  }
  return value.slice(0, 1);
}

/** Keep missing dependencies as explicit unknown nodes; a partial page cannot establish their state. */
export function taskGraph(tasks) {
  const nodes = new Map(tasks.map((task) => [task.id, { id: task.id, task }]));
  const edges = [];
  for (const task of tasks) for (const id of task.dependencyIds ?? []) {
    if (!nodes.has(id)) nodes.set(id, { id, task: null });
    edges.push({ from: id, to: task.id });
  }
  const remaining = new Set(nodes.keys());
  const layers = [];
  while (remaining.size) {
    const layer = [...remaining].filter((id) => !edges.some((edge) => edge.to === id && remaining.has(edge.from)));
    if (!layer.length) { layers.push([...remaining].map((id) => nodes.get(id))); break; }
    layers.push(layer.map((id) => nodes.get(id)));
    for (const id of layer) remaining.delete(id);
  }
  return { layers, edges };
}

export function createWorkbench({ api, getMembers, getHistoryMembers, getClusters, nameOf, messageName, showMessage, selectCluster, getActivity,
  renderMarkdown = (value) => [value], workspaceChanged = () => {}, openImage = () => {}, uploadFile, stalled = null, pluginUi = null }) {
  let pluginIds = null;   // Before the registry is known, keep the existing task and coordinator views.
  let collectionTabs = [];
  const tasksEnabled = () => pluginIds === null || pluginIds.includes('tasks');
  const coordinatorEnabled = () => pluginIds === null || pluginIds.includes('coordinator');
  const title = h('h2', {}, t("任务工作台"));
  const content = h('div', { class: 'workbench-content' });
  // A third-party plugin's tab (docs/external-plugins.md「网页界面」) shows its frame here, outside `content`: render()
  // rebuilds `content`, and a frame moved in the page would reload. Only shown, hidden and filled by pluginUi.
  const pluginPane = h('div', { class: 'wb-plugin-pane', hidden: true });
  const dialog = h('dialog', { class: 'workbench', 'aria-label': t("任务工作台") },
    h('div', { class: 'workbench-shell' }, h('header', { class: 'workbench-head' },
      h('div', { class: 'workbench-title' }, h('span', { class: 'workbench-badge' }, t("工作区")), title),
      h('button', { class: 'icon', type: 'button', 'aria-label': t("关闭任务工作台"), onclick: () => dialog.close() }, icon('close'))), content, pluginPane));
  document.body.append(dialog);
  const view = { clusterId: null, workspace: null, workspaceKey: null, taskId: null, detail: null, context: null, request: 0, error: null, tab: 'tasks',
    collectionMode: 'public', collectionTask: null, collectionContext: null, collectionDetail: null, publicFilters: {}, collectionRequest: 0,
    overview: false, allGroups: [], allRequest: 0, taskFilters: {}, taskSort: DEFAULT_TASK_SORT, quickView: '', loadingTasks: null,
    settingsSection: null, rulesOpen: false };   // 角色与协调: the highlighted rail item, and whether the rules text is unfolded
  const operations = new Map();
  const eventDiffs = new Map();
  // What the user unfolded in the selected task's detail (history sections, long text): kept across redraws, reset by another task.
  const opened = new Set();
  let openedFor = null;
  const collapsedBatches = new Set();  // batch ids folded in the task list, for this page only
  const messageFiles = new Map();      // message id -> attachments; a message's attachments never change
  const evidenceLoading = new Set();
  const attachmentEls = new Map();     // built once and moved into each redraw, so thumbnails neither reload nor flicker
  const graphCanvas = createGraphCanvas({ onOpen: (id) => chooseTask(id), rerender: () => render(), settled: () => redraws.settle() });
  // Replacing the nodes would end a graph drag, throw away the open 更多 menu, or swallow the click being pressed.
  const redraws = redrawGate(dialog, () => render(), () => graphCanvas.busy() || taskBar.busy() || Boolean(content.querySelector('.wb-menu:not([hidden])')));
  const path = (suffix) => `/api/clusters/${encodeURIComponent(view.clusterId)}${suffix}`;
  // Keeps --wb-tabs-height (render measures it) right when the tab bar wraps or unwraps on a resize. One observer for the
  // workbench's life, watching only the tab bar on screen: render moves it to the new bar, closing the workbench stops it.
  const tabsObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    const bar = entries.at(-1).target;
    if (dialog.open && bar.isConnected) content.style.setProperty('--wb-tabs-height', `${bar.offsetHeight}px`);
  }) : null;
  dialog.addEventListener('close', () => { tabsObserver?.disconnect(); pluginUi?.hideWorkbench(); pluginPane.hidden = true; });

  // Colour and identity chips: the same id always gets the same tone, in every view and every refresh.
  // `clusterId`: the cluster the member belongs to; views that list several clusters (全部任务) pass each row's own.
  const memberOf = (id, clusterId = view.clusterId) => getMembers(clusterId).find((item) => item.id === id)
    ?? getHistoryMembers(clusterId).find((item) => item.id === id) ?? null;
  const memberChip = (id, clusterId = view.clusterId) => {
    const member = memberOf(id, clusterId);
    const name = member?.name ?? nameOf(id);
    // The member's own avatar (its app's icon by default); the tone initials only when it has none to show.
    return h('span', { class: `wb-member wb-tone-${toneIndex(id)}` },
      member && avatarKind(member) !== 'initial' ? avatarEl(member, 'xs')
        : h('span', { class: 'wb-avatar', 'aria-hidden': 'true' }, initials(name)),
      h('span', { class: 'wb-name' }, name));
  };
  const attachmentList = (scope, files) => {
    if (!files.length) return null;
    const key = JSON.stringify([scope, files.map((file) => [file.id, file.mime])]);
    if (!attachmentEls.has(key)) attachmentEls.set(key, h('div', { class: 'attachments' }, files.map((file) => attachmentNode(file, openImage))));
    return attachmentEls.get(key);
  };
  /** Who created a task: a link to the member's page; plain text for the user and for a member who has left the group. */
  const creatorLink = (createdBy) => {
    if (createdBy === 'user') return h('span', {}, t("用户"));
    const member = memberOf(createdBy);
    const name = member?.name ?? nameOf(createdBy);
    if (!member || member.removedAt) return h('span', {}, member ? t("{name}（已移出）", { name }) : name);
    return h('button', { type: 'button', class: 'mention link wb-creator', title: t("查看 {name}", { name }),
      onclick: () => { dialog.close(); selectCluster(view.clusterId, createdBy); } }, name);
  };
  const roleChip = (role) => h('span', { class: `wb-role wb-tone-${toneIndex(role.id)}`, title: role.description || undefined },
    h('span', { class: 'wb-role-dot', 'aria-hidden': 'true' }), h('span', {}, role.name));
  const roleChipById = (id) => {
    const role = (view.workspace?.roles ?? []).find((item) => item.id === id);
    return role ? roleChip(role) : h('span', { class: 'wb-role wb-tone-0' }, t("未加载角色 {id}", { id: String(id).slice(0, 8) }));
  };
  const roleList = (ids) => (ids ?? []).length ? (ids ?? []).map(roleChipById) : h('span', { class: 'muted' }, t("无"));
  const statusChip = (task) => h('span', { class: `wb-status wb-status-${task.status}` },
    h('span', { class: 'wb-status-dot', 'aria-hidden': 'true' }), statusText(task));
  /** Under the detail head of a task cancelled as a duplicate or superseded: the other task, plain text once it is deleted. */
  const closeReasonLine = (task) => {
    const phrase = task.status === 'cancelled' ? relatedReason(task.closeReason?.kind) : null;
    const id = task.closeReason?.taskId;
    if (!phrase || !id) return null;
    const related = view.relatedTask?.id === id ? view.relatedTask : null;
    return h('p', { class: 'wb-close-reason' }, `${phrase.before} `,
      related ? h('button', { type: 'button', class: 'mention link wb-close-link', 'data-wb-focus': 'close-related', title: t("打开这个任务"),
        onclick: () => chooseTask(related.id) }, taskLabel(related)) : h('span', { class: 'muted' }, t("{id}（已删除）", { id: id.slice(0, 8) })),
      ` ${phrase.after}`);
  };
  const mergeBadge = (task) => pendingMerge(task) ? h('span', { class: 'wb-mode' }, t("待合并")) : null;
  const priorityChip = (task) => h('span', { class: `wb-priority wb-priority-${task.priority ?? 'normal'}` },
    t("优先级 {priority}", { priority: t(PRIORITY[task.priority] ?? "普通") }));
  const dependencyChip = (task) => needsReview(task) ? h('span', { class: 'wb-warn' }, t("依赖已变化，需复核")) : null;
  /** 验收者接手 · its basis; a switch to self review reads as a warning, since no independent review is left. */
  const takeoverChip = (task) => {
    const mark = takeoverMark(task);
    if (!mark) return null;
    return h('span', { class: task.reviewer?.kind === 'self' ? 'wb-warn wb-takeover' : 'wb-mode wb-takeover', title: t("{name} 于 {at} 接手执行", { name: nameOf(task.takeover.memberId), at: task.takeover.at }) }, mark);
  };
  /** 执行者隐身中 / 验收人隐身中: the user decides about reassigning (docs/cluster-members.md「隐身」). */
  const hiddenChips = (task, clusterId = view.clusterId) => taskHiddenMarks(task, (id) => memberOf(id, clusterId)).map((mark) => hiddenMark(mark, 'wb-warn wb-hidden'));
  /** The stalled-member mark on a task whose holder has a visible hint (stalled.js); render() reads the hints once. */
  let stalledTasks = new Map();
  const stalledChip = (task, map = stalledTasks) => {
    const hint = map.get(task.id);
    return hint ? h('span', { class: 'wb-warn wb-stalled', title: [...stalledLines(hint), t(STALLED_CAVEAT)].join('\n') },
      hint.hidden ? t("{memberName} 隐身中", { memberName: hint.memberName }) : t("{memberName} 长时间无活动", { memberName: hint.memberName })) : null;
  };
  /** The hints of one cluster (or of every cluster, with its name): who, which tasks, the latest activity, offline, dismiss. */
  const stalledBanner = (hints, clusterName = null) => hints.length ? h('section', { class: 'wb-stalled-banner', 'aria-label': t("成员长时间没有活动") },
    hints.some((hint) => hint.kind !== 'hidden_work') ? h('p', { class: 'wb-stalled-caveat' }, t(STALLED_CAVEAT)) : null,   // not about hidden-member work
    hints.map((hint) => h('div', { class: 'wb-stalled-hint' },
      h('p', { class: 'wb-stalled-head' }, h('b', {}, clusterName ? `${clusterName(hint.clusterId)} · ` : '', stalledLines(hint)[0])),
      h('button', { type: 'button', class: 'small wb-stalled-dismiss', title: t("同一成员、同样的任务不再提示，直到它有新的活动或任务有变化"),
        onclick: () => stalled?.dismiss(hint) }, t("不再提示")),
      h('p', { class: 'wb-stalled-tasks' }, t("手上的任务："), hint.tasks.map((task) => h('button', { type: 'button', class: 'wb-stalled-task',
        onclick: () => { if (clusterName) { selectCluster(hint.clusterId); open(hint.clusterId); } chooseTask(task.id); } }, stalledTaskText(task)))),
      stalledLines(hint).slice(1).map((line) => h('p', { class: 'wb-stalled-line' }, line))))) : null;
  /** A label's tone: its colour in the label library, else one derived from the name. */
  let toneCache = { library: undefined, index: new Map() };
  const labelTone = (label) => {
    const library = view.workspace?.labelLibrary;
    if (toneCache.library !== library) toneCache = { library, index: labelIndex(library) };
    return libraryColor(toneCache.index, label) ?? toneIndex(label, 8);
  };
  /** A coloured task label; clicking (or Enter/Space) it filters the list to that label. */
  const labelChip =(label, extraClass = '') => h('span', {
    class: `wb-tag wb-tone-${labelTone(label)} wb-task-label${extraClass ? ` ${extraClass}` : ''}`,
    role: 'button', tabindex: '0', title: t("只看标签「{label}」", { label }),
    onclick: (event) => { event.stopPropagation(); filterByLabel(label); },
    onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); filterByLabel(label); } },
  }, label);
  /** Third-party plugins' marks on a task (plugin-ui.js), after orrery's own labels: at most two, the rest behind "+N". */
  const taskMarks = (task) => pluginUi?.marksSlot(task.clusterId ?? view.clusterId, 'task', task.id, 2) ?? null;
  /** Card labels: the first three plus a "+N" chip whose title lists the rest; then the plugins' marks. */
  const labelRow = (task) => {
    const marks = taskMarks(task);
    if (!task.labels?.length) return marks ? h('span', { class: 'wb-task-labels' }, marks) : null;
    const { shown, more } = visibleLabels(task.labels, 3);
    return h('span', { class: 'wb-task-labels' }, shown.map((label) => labelChip(label)),
      more ? h('span', { class: 'wb-task-label-more', title: task.labels.slice(3).join(', ') }, `+${more}`) : null, marks);
  };
  /** Clicking a label toggles it in the label filter, so filters accumulate as AND; clicking it again removes it. */
  function filterByLabel(label) {
    setTaskFilters({ ...view.taskFilters, label: toggleLabelFilter(view.taskFilters.label, label) });
  }

  // ---- task filters and sort: remembered per cluster (this page, then localStorage) ----
  const taskViewMemory = new Map();   // the source of truth once chosen, and the fallback when localStorage fails
  function saveTaskView() {
    const value = { filters: { ...view.taskFilters, label: filterLabels(view.taskFilters.label) }, sort: view.taskSort, quick: view.quickView };
    taskViewMemory.set(view.clusterId, value);
    writeLocal(taskViewStorageKey(view.clusterId), JSON.stringify({ version: 1, ...value }));
  }
  function restoredTaskView(clusterId) {
    const memory = taskViewMemory.get(clusterId);
    return storedTaskView(memory ? JSON.stringify({ version: 1, ...memory }) : readLocal(taskViewStorageKey(clusterId)),
      { memberIds: getMembers(clusterId).map((member) => member.id) });
  }
  function setTaskFilters(filters) {
    view.taskFilters = filters;
    view.loadingTasks = null;
    saveTaskView();
    render();
    void refresh();
  }
  function setTaskSort(sort) {
    view.taskSort = sort;
    view.loadingTasks = null;
    saveTaskView();
    render();
    if (taskPageSpec().key !== view.workspaceKey) void refresh();
  }
  /** Turn a quick view on ('' turns it off); its client-side predicate needs every filtered page. */
  function setQuickView(quick) {
    view.quickView = quick;
    view.loadingTasks = null;
    saveTaskView();
    render();
    if (taskPageSpec().key !== view.workspaceKey) void refresh();
  }
  function taskPageSpec() {
    const newest = view.tab === 'tasks' && view.taskSort === DEFAULT_TASK_SORT;
    const all = ['graph', 'members', 'collections'].includes(view.tab)
      || (view.tab === 'tasks' && (sortNeedsAllPages(view.taskSort) || Boolean(view.quickView)));
    const filters = newest ? { ...view.taskFilters, sort: 'created-desc' } : view.taskFilters;
    const key = JSON.stringify([taskFilterQuery(filters).toString(), all]);
    return { all, filters, key, newest };
  }
  function workspacePage(filters, cursor) {
    const query = taskFilterQuery(filters, cursor);
    if (cursor) query.set('pageOnly', '1');
    return api('GET', path(`/workspace?${query}`));
  }
  /** Something narrows the list: a Hub filter or a quick view. */
  const narrowed = () => hasTaskFilters(view.taskFilters) || Boolean(view.quickView);

  /** Chips of the active task filters; each removes itself, and one action clears them all. */
  function filterChips() {
    const filters = view.taskFilters;
    const remove = (patch) => { if (typeof patch === 'function') patch(); else setTaskFilters({ ...filters, ...patch }); taskBar.focusSearch(); };
    const chip = (key, value, title, patch, tone = '') => h('button', { type: 'button', class: `wb-filter-chip${tone}`, title,
      'aria-label': title, onclick: () => remove(patch) },
    tone ? h('span', { class: 'wb-role-dot', 'aria-hidden': 'true' }) : null, h('span', { class: 'wb-filter-key' }, key), h('span', { class: 'wb-filter-value' }, value),
    h('span', { class: 'wb-filter-x', 'aria-hidden': 'true' }, icon('close', 'ico-xs')));
    const chips = [];
    const quick = QUICK_VIEWS.find(([id]) => id === view.quickView);
    if (quick) chips.push(chip(t("视图"), t(quick[1]), t("移除快捷视图"), () => setQuickView('')));
    if (filters.q) chips.push(chip(t("关键词"), filters.q, t("移除关键词筛选"), { q: '' }));
    for (const label of filterLabels(filters.label)) {
      chips.push(chip(t("标签"), label, t("移除标签「{label}」", { label }), { label: filterLabels(filters.label).filter((item) => item !== label) },
        ` wb-tag-chip wb-tone-${labelTone(label)}`));
    }
    if (filters.memberId) {
      const name = getMembers(view.clusterId).find((member) => member.id === filters.memberId)?.name ?? filters.memberId;
      chips.push(chip(t("成员"), name, t("移除成员筛选"), { memberId: '' }));
    }
    if (filters.status) chips.push(chip(t("状态"), (STATUS[filters.status] ? t(STATUS[filters.status]) : filters.status), t("移除状态筛选"), { status: '' }));
    if (chips.length) chips.push(h('button', { type: 'button', class: 'wb-filter-clear',
      onclick: () => { view.quickView = ''; setTaskFilters({}); taskBar.focusSearch(); } }, t("清除全部")));
    return chips;
  }

  /**
   * The filter and sort bar above the task list, graph and member work. Built once and moved into each redraw, so
   * typing, focus and an open label list survive the redraws that live filtering and background refreshes cause.
   */
  const taskBar = (() => {
    let timer = null;
    let composing = false;
    const search = h('input', { type: 'search', class: 'wb-fb-control wb-fb-input', placeholder: t("搜索 #编号、标题、内容或 ID"),
      'aria-label': t("搜索任务（#编号、标题、内容或 ID）"), autocomplete: 'off', spellcheck: 'false' });
    const status = h('select', { class: 'wb-fb-control wb-fb-select', 'aria-label': t("按状态筛选"),
      onchange: () => setTaskFilters({ ...view.taskFilters, status: status.value }) },
    h('option', { value: '' }, t("全部状态")), Object.entries(STATUS).map(([id, caption]) => h('option', { value: id }, t(caption))));
    const member = h('select', { class: 'wb-fb-control wb-fb-select', 'aria-label': t("按成员筛选"),
      onchange: () => setTaskFilters({ ...view.taskFilters, memberId: member.value }) });
    const sort = h('select', { class: 'wb-fb-control wb-fb-select wb-fb-sort', 'aria-label': t("排序"), onchange: () => setTaskSort(sort.value) },
      TASK_SORTS.map(([id, caption]) => h('option', { value: id }, t(caption))));
    const sortBox = h('span', { class: 'wb-fb-sortbox' }, h('span', { class: 'wb-fb-sortcap', 'aria-hidden': 'true' }, t("排序")), sort);
    const triggerText = h('span', { class: 'wb-fb-trigger-text' }, t("标签"));
    const triggerCount = h('span', { class: 'wb-fb-badge', hidden: true });
    const trigger = h('button', { type: 'button', class: 'wb-fb-control wb-fb-select wb-fb-trigger', 'aria-haspopup': 'listbox',
      'aria-expanded': 'false', 'aria-controls': 'wb-fb-label-list' }, triggerText, triggerCount);
    const list = h('div', { class: 'wb-fb-menu', id: 'wb-fb-label-list', role: 'listbox', 'aria-multiselectable': 'true',
      'aria-label': t("按标签筛选（需同时满足）"), hidden: true });
    const picker = h('div', { class: 'wb-fb-labels' }, trigger, list);
    // Quick views toggle on and off; at most one is on. Their counts are of the loaded list, so they show only once it is whole.
    const quickViews = QUICK_VIEWS.map(([id, caption]) => {
      const count = h('span', { class: 'wb-fb-qcount', hidden: true });
      return { id, caption: t(caption), count, button: h('button', { type: 'button', class: 'wb-fb-control wb-fb-quick-btn', 'aria-pressed': 'false',
        onclick: () => setQuickView(view.quickView === id ? '' : id) }, h('span', {}, t(caption)), count) };
    });
    const quickGroup = h('span', { class: 'wb-fb-quick', role: 'group', 'aria-label': t("快捷视图") }, quickViews.map((item) => item.button));
    const chipRow = h('div', { class: 'wb-active-filters', 'aria-label': t("当前筛选") });
    const countText = h('span', { class: 'wb-fb-total' });
    const el = h('div', { class: 'wb-filterbar', role: 'search', 'aria-label': t("筛选和排序任务") },
      h('div', { class: 'wb-fb-controls' }, h('span', { class: 'wb-fb-search' }, search), quickGroup, status, picker, member, sortBox),
      h('div', { class: 'wb-fb-summary' }, chipRow, countText));

    const applySearch = () => {
      clearTimeout(timer);
      timer = null;
      const q = search.value.trim();
      if (q !== (view.taskFilters.q ?? '')) setTaskFilters({ ...view.taskFilters, q });
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(applySearch, 300); };   // live filtering, ~300 ms after typing stops
    search.addEventListener('input', (event) => { if (!event.isComposing) later(); });
    search.addEventListener('compositionstart', () => { composing = true; });
    search.addEventListener('compositionend', () => { composing = false; later(); redraws.settle(); });
    // A 4+ character hex query that matches exactly one task id prefix: Enter opens that task directly.
    search.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      const value = search.value.trim();
      const numMatch = /^#?([1-9]\d*)$/.exec(value);
      const numVal = numMatch && Number.isSafeInteger(Number(numMatch[1])) ? Number(numMatch[1]) : null;
      const normalized = value.toLowerCase().replace(/-/g, '');
      const isHex = /^[0-9a-f]{4,32}$/.test(normalized);
      const cid = view.clusterId;
      applySearch();
      if (numVal === null && !isHex) return;
      try {
        const page = await api('GET', `/api/clusters/${encodeURIComponent(cid)}/workspace?q=${encodeURIComponent(value)}`);
        const numHits = numVal !== null ? page.tasks.filter((task) => task.number === numVal) : [];
        const idHits = isHex ? page.tasks.filter((task) => String(task.id).toLowerCase().replace(/-/g, '').startsWith(normalized)) : [];
        const hits = numHits.length ? numHits : idHits;
        if (hits.length === 1 && cid === view.clusterId && dialog.open) chooseTask(hits[0].id);
      } catch { /* the filter still applies */ }
    });

    // The label list: a multi-select listbox. Enter/Space/ArrowDown on the button open it, arrows move, Space or Enter
    // toggles, Esc closes and returns focus to the button, Tab or a click elsewhere closes it.
    const options = () => [...list.querySelectorAll('[role="option"]')];
    const outside = (event) => { if (!picker.contains(event.target)) close(false); };
    function open(focusLast = false) {
      if (trigger.disabled) return;
      list.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      const items = options();
      (focusLast ? items.at(-1) : items.find((item) => item.getAttribute('aria-selected') === 'true') ?? items[0])?.focus();
    }
    function close(returnFocus) {
      if (list.hidden) return;
      list.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      if (returnFocus) trigger.focus();
    }
    trigger.addEventListener('click', () => { if (list.hidden) open(); else close(true); });
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(event.key === 'ArrowUp'); }
    });
    picker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(true); }
    });
    list.addEventListener('keydown', (event) => {
      const items = options();
      const index = items.indexOf(document.activeElement);
      const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
      if (move !== undefined) { event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, move))]?.focus(); }
      else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (index >= 0) items[index].click(); }
      else if (event.key === 'Tab') close(false);
    });

    let labelKey = null;
    let memberKey = null;
    let chipKey = null;
    function syncLabels() {
      const selected = filterLabels(view.taskFilters.label);
      const known = view.workspace?.labels ?? [];
      const all = [...new Set([...known, ...selected])];   // a selected label stays uncheckable until the Hub drops it
      // Grouped as in the label library; one section only (no library yet) needs no headings.
      const sections = filterSections(all, view.workspace?.labelLibrary);
      const key = JSON.stringify([sections, all.map(labelTone)]);
      if (key !== labelKey) {
        labelKey = key;
        const focused = list.contains(document.activeElement) ? document.activeElement.dataset.label : null;
        const option = (label) => h('div', { class: 'wb-fb-option', role: 'option', tabindex: '-1', 'data-label': label,
          'aria-selected': 'false', onclick: () => setTaskFilters({ ...view.taskFilters, label: toggleLabelFilter(view.taskFilters.label, label) }) },
        h('span', { class: 'wb-fb-check', 'aria-hidden': 'true' }),
        h('span', { class: `wb-tag wb-tone-${labelTone(label)}` }, h('span', { class: 'wb-role-dot', 'aria-hidden': 'true' }), label));
        list.replaceChildren(h('p', { class: 'wb-fb-menu-note', 'aria-hidden': 'true' }, t("需同时满足所选标签")),
          ...(sections.length > 1 ? sections.flatMap((section) => [h('p', { class: 'wb-fb-group', 'aria-hidden': 'true' }, section.title), ...section.labels.map(option)])
            : all.map(option)));
        if (focused) options().find((item) => item.dataset.label === focused)?.focus();
      }
      for (const item of options()) item.setAttribute('aria-selected', String(selected.includes(item.dataset.label)));
      trigger.disabled = !all.length;
      if (!all.length) close(false);
      triggerText.textContent = all.length || !view.workspace ? t("标签") : t("暂无标签");
      triggerCount.textContent = String(selected.length);
      triggerCount.hidden = !selected.length;
      trigger.classList.toggle('wb-fb-on', selected.length > 0);
      trigger.setAttribute('aria-label', all.length ? t("按标签筛选{selection}", { selection: selected.length ? t("，已选 {selectedCount} 个", { selectedCount: selected.length }) : '' }) : t("本群暂无标签"));
    }
    function syncCount(tasks) {
      const n = tasks.length;
      countText.textContent = view.loadingTasks != null ? t("正在加载全部任务… 已加载 {loadingTasks} 项", { loadingTasks: view.loadingTasks })
        : view.workspaceKey !== taskPageSpec().key || !view.workspace ? t("正在加载…")
          : view.workspace.nextCursor ? t("已加载 {n} 项，还有更多", { n })
            : narrowed() ? t("符合条件 {n} 项", { n }) : t("共 {n} 项", { n });
      countText.classList.toggle('wb-fb-loading', view.loadingTasks != null);
    }
    function syncQuick() {
      const whole = Boolean(view.workspace) && view.workspaceKey === taskPageSpec().key && !view.workspace.nextCursor;
      for (const { id, caption, count, button } of quickViews) {
        const n = whole ? quickViewTasks(view.workspace.tasks, id).length : null;
        count.textContent = n === null ? '' : String(n);
        count.hidden = n === null;
        button.classList.toggle('wb-fb-zero', n === 0);
        button.classList.toggle('wb-fb-on', view.quickView === id);
        button.setAttribute('aria-pressed', String(view.quickView === id));
        button.setAttribute('aria-label', n === null ? caption : t("{caption}，{n} 项", { caption: caption, n }));
        button.title = n === null ? t("{caption}（全部任务加载后显示数量）", { caption }) : t("{caption}：当前筛选下 {n} 项", { caption: caption, n });
      }
    }
    return {
      el,
      /** Bring the controls in line with the view; only what changed is rebuilt, so focus and typing survive. */
      sync(tasks) {
        const filters = view.taskFilters;
        if (timer === null && search.value.trim() !== (filters.q ?? '')) search.value = filters.q ?? '';
        status.value = filters.status ?? '';
        const members = getMembers(view.clusterId);
        const nextMemberKey = JSON.stringify(members.map((item) => [item.id, item.name]));
        if (nextMemberKey !== memberKey) {
          memberKey = nextMemberKey;
          member.replaceChildren(h('option', { value: '' }, t("全部成员")), ...members.map((item) => h('option', { value: item.id }, item.name)));
        }
        member.value = filters.memberId ?? '';
        status.classList.toggle('wb-fb-on', Boolean(status.value));
        member.classList.toggle('wb-fb-on', Boolean(member.value));
        sort.value = view.taskSort;
        sortBox.hidden = view.tab !== 'tasks';   // the graph and member work do not list tasks in an order
        syncLabels();
        syncQuick();
        const nextChipKey = JSON.stringify([filters, memberKey, view.quickView]);
        if (nextChipKey !== chipKey) { chipKey = nextChipKey; chipRow.replaceChildren(...filterChips()); }
        syncCount(tasks);
        return el;
      },
      busy: () => composing,
      focusSearch: () => search.focus(),
      reset() { clearTimeout(timer); timer = null; close(false); search.value = ''; labelKey = memberKey = chipKey = null; },
    };
  })();
  const taskTitleNodes = (task) => (task.number != null ? [h('span', { class: 'wb-task-num' }, `#${task.number}`), ' ', task.title] : [task.title]);
  const batchOf = (id) => (view.workspace?.batches ?? []).find((batch) => batch.id === id) ?? null;
  const batchChip = (task) => {
    if (!task.batchId) return null;
    const batch = batchOf(task.batchId);
    return h('span', { class: 'wb-mode wb-batch-chip', title: batch ? t('验收批次 B{number}【{title}】', batch) : t("验收批次") }, batch ? `B${batch.number}` : t("批次"));
  };
  const taskCard = (task) => h('button', { type: 'button', class: `workbench-task wb-task-${task.status}`,
    'aria-current': String(task.id === view.taskId), onclick: () => chooseTask(task.id) },
  h('span', { class: 'wb-task-top' }, h('b', { class: 'wb-task-title' }, ...taskTitleNodes(task)),
    h('span', { class: 'wb-task-badges' }, statusChip(task), mergeBadge(task), priorityChip(task))),
  h('span', { class: 'wb-task-meta' },
    task.assignedMemberId ? memberChip(task.assignedMemberId)
      : h('span', { class: 'muted' }, closedNote(task)),
    task.reviewer?.kind === 'member' ? h('span', { class: 'wb-task-reviewer' }, t("验收"), memberChip(task.reviewer.memberId))
      : task.reviewer?.kind === 'self' ? h('span', { class: 'wb-task-reviewer' }, t("自查"))
        : task.takeover ? h('span', { class: 'wb-task-reviewer' }, t("用户验收")) : null,
    batchChip(task), takeoverChip(task), dependencyChip(task), stalledChip(task), ...hiddenChips(task)),
  labelRow(task));

  async function command(body, cid = view.clusterId) {
    const key = JSON.stringify([cid, body]);
    if (!operations.has(key)) operations.set(key, crypto.randomUUID());
    const result = await api('POST', `/api/clusters/${encodeURIComponent(cid)}/collaboration`, { ...body, operationId: operations.get(key) });
    operations.delete(key);
    if (view.clusterId === cid) await refresh();
    return result;
  }

  /** Load unfiltered task pages into an existing control without resetting its selected options. */
  function taskOptionsPager(clusterId, select, excludeId = null) {
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const more = h('button', { type: 'button', class: 'small', onclick: () => load() }, t("加载更多可选任务"));
    let cursor = null, loaded = false, loading = false, modal = null;
    async function load() {
      if (loading || (loaded && !cursor)) return;
      loading = true; more.disabled = true; error.hidden = true;
      try {
        const suffix = loaded ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const page = await api('GET', `/api/clusters/${encodeURIComponent(clusterId)}/workspace${suffix}`);
        if (!modal?.open || view.clusterId !== clusterId) return;
        for (const task of page.tasks) {
          if (task.id === excludeId) continue;
          const existing = [...select.options].find((option) => option.value === task.id);
          if (existing) existing.textContent = taskLabel(task);
          else select.append(h('option', { value: task.id }, taskLabel(task)));
        }
        cursor = page.nextCursor; loaded = true;
        more.hidden = !cursor;
        more.textContent = t("加载更多可选任务");
      } catch (e) {
        if (modal?.open) { error.textContent = t("加载可选任务失败：{error}", { error: e.message }); error.hidden = false; more.textContent = t("重试加载可选任务"); }
      } finally { loading = false; more.disabled = false; }
    }
    return { more, error, start(dialog) { modal = dialog; void load(); } };
  }

  async function pickTasks(clusterId, selectedIds, onSave, { persisted = true } = {}) {
    try {
      let page = await api('GET', `/api/clusters/${encodeURIComponent(clusterId)}/workspace`);
      const select = h('select', { multiple: true, 'aria-label': t("关联的任务") });
      const added = new Map();
      const add = (id, label) => {
        if (added.has(id)) { added.get(id).textContent = label; return; }
        const option = h('option', { value: id }, label);
        option.selected = selectedIds.includes(id);
        added.set(id, option); select.append(option);
      };
      for (const id of selectedIds) add(id, t("未加载：{id}", { id }));
      for (const task of page.tasks) add(task.id, taskLabel(task));
      const more = h('button', { type: 'button', class: 'small', onclick: async () => {
        more.disabled = true;
        try {
          page = await api('GET', `/api/clusters/${encodeURIComponent(clusterId)}/workspace?cursor=${encodeURIComponent(page.nextCursor)}`);
          for (const task of page.tasks) add(task.id, taskLabel(task));
          more.hidden = !page.nextCursor;
        } catch (e) { await noticeDialog(e.message, t("加载任务失败")); }
        finally { more.disabled = false; }
      } }, t("加载更多任务"));
      more.hidden = !page.nextCursor;
      const reason = h('input', { placeholder: t("解除已有关系时必填") });
      formDialog(t("关联任务"), [h('p', { class: 'muted' }, t("按住 Ctrl 可多选；未加载的现有关联会保留。")),
        h('label', {}, t("关联的任务"), select), more, persisted ? h('label', {}, t("解除关联的原因"), reason) : null], async () => {
        const next = [...select.selectedOptions].map((option) => option.value);
        const addedIds = next.filter((id) => !selectedIds.includes(id));
        const removedIds = selectedIds.filter((id) => !next.includes(id));
        if (persisted && removedIds.length && !reason.value.trim()) throw new Error(t("解除关联时请填写原因。"));
        await onSave(next, addedIds, removedIds, reason.value.trim());
      });
    } catch (e) { await noticeDialog(e.message, t("加载任务失败")); }
  }

  // A burst of collaboration events refreshes once. If a request is in flight, remember one trailing refresh.
  let refreshing = 0;
  let refreshAgain = false;
  // Every read of the open detail takes a ticket; `shown` is the ticket whose watchers are on screen, so a late response
  // never replaces newer watchers. `afterLoad`: a task whose watchers changed while its detail was still loading.
  const watchers = { ticket: 0, shown: 0, afterLoad: null };
  const scheduleRefresh = coalesce(() => {
    if (refreshing) refreshAgain = true;
    else if (view.overview && dialog.open) void loadAll();
    else void refresh();
  }, REFRESH_COALESCE_MS);
  const finishRefresh = () => {
    if (--refreshing || !refreshAgain) return;
    refreshAgain = false;
    scheduleRefresh();
  };

  async function refresh() {
    if (!dialog.open || !view.clusterId || view.overview) return;
    refreshing++;
    const request = ++view.request;
    const cid = view.clusterId;
    const tab = view.tab;
    const taskId = tab === 'tasks' ? view.taskId : null;
    const filters = view.taskFilters;
    const page = taskPageSpec();
    const filtered = hasTaskFilters(filters);
    const watchersTicket = ++watchers.ticket;
    const stale = () => request !== view.request || cid !== view.clusterId || tab !== view.tab || page.key !== taskPageSpec().key
      || (tab === 'tasks' && taskId !== view.taskId) || !dialog.open;
    try {
      const [workspace, detail, context] = await Promise.all([
        workspacePage(page.filters),
        taskId ? api('GET', path(`/tasks/${encodeURIComponent(taskId)}`)) : null,
        taskId ? api('GET', path(`/tasks/${encodeURIComponent(taskId)}/context`)) : null,
      ]);
      if (stale()) return;
      // The task a cancelled one duplicates or was superseded by; null once it has been deleted.
      const relatedId = detail?.task?.status === 'cancelled' && relatedReason(detail.task.closeReason?.kind) ? detail.task.closeReason.taskId : null;
      const relatedTask = relatedId ? (await api('GET', path(`/task-refs?ids=${encodeURIComponent(relatedId)}`))).tasks[0] ?? null : null;
      if (stale()) return;
      // A label the cluster no longer uses (a stored choice, or the last task lost it) is dropped silently.
      const known = withKnownLabels(filters, workspace.labels);
      if (known !== filters) { setTaskFilters(known); return; }
      // Load the pages still needed first, showing progress while no complete list is on screen. A newer refresh,
      // another cluster or closing the workbench stops the loop.
      const sameList = () => view.workspaceKey === page.key;
      const showProgress = page.all && (!sameList() || Boolean(view.workspace.nextCursor));
      const committed = await loadTaskPages(workspace, (cursor) => workspacePage(page.filters, cursor), {
        needAll: () => page.all, shown: () => sameList() ? view.workspace.tasks.length : 0, stale,
        progress: (loaded) => { if (showProgress) { view.loadingTasks = loaded; render(); } },
        commit: (loaded) => {
          view.loadingTasks = null;
          const before = workspaceLookupKey(view.workspace);
          view.workspace = loaded;
          view.workspaceKey = page.key;
          view.workspaceFiltered = filtered;
          // A narrow watchers read that started after this refresh and already landed is newer: keep its watchers.
          const keepWatchers = watchers.shown > watchersTicket && detail && view.detail?.task?.id === detail.task?.id;
          view.detail = keepWatchers ? { ...detail, watchers: view.detail.watchers } : detail;
          if (!keepWatchers) watchers.shown = watchersTicket;
          view.relatedTask = relatedTask;
          view.context = context;
          view.error = null;
          if (workspaceLookupKey(loaded) !== before) workspaceChanged(cid);
        } });
      if (!committed) return;
      if (watchers.afterLoad && watchers.afterLoad === detail?.task?.id) {
        watchers.afterLoad = null;
        void reloadWatchers(cid, detail.task.id);
      }
    } catch (e) {
      if (stale()) return;
      view.error = e.message;
      view.loadingTasks = null;
    } finally {
      finishRefresh();
    }
    render();
  }

  async function loadAll() {
    refreshing++;
    const request = ++view.allRequest;
    const clusters = getClusters();
    try {
      const groups = await Promise.all(clusters.map(async (cluster) => {
        try { return { cluster, data: await api('GET', `/api/clusters/${encodeURIComponent(cluster.id)}/workspace?pageOnly=1`), error: null }; }
        catch (e) { return { cluster, data: null, error: e.message }; }
      }));
      if (request === view.allRequest && view.overview && dialog.open) { view.allGroups = groups; render(); }
    } finally { finishRefresh(); }
  }

  async function moreOverview(group) {
    const cursor = group.data?.nextCursor;
    if (!cursor) return;
    try {
      const next = await api('GET', `/api/clusters/${encodeURIComponent(group.cluster.id)}/workspace?cursor=${encodeURIComponent(cursor)}&pageOnly=1`);
      if (!view.overview || cursor !== group.data.nextCursor) return;
      group.data = { ...group.data, tasks: [...group.data.tasks, ...next.tasks], nextCursor: next.nextCursor };
      render();
    } catch (e) { group.error = e.message; render(); }
  }

  function overviewView() {
    const clusterName = (id) => getClusters().find((cluster) => cluster.id === id)?.name ?? t("未知群");
    return h('div', { class: 'wb-overview' }, h('div', { class: 'workbench-bar wb-overview-bar' },
      h('p', { class: 'muted' }, t("按群汇总任务；任务和依赖仍属于各自的群。")),
      h('button', { type: 'button', class: 'small', title: t("所有群共用的标签和标签组"), onclick: openLabels }, t("标签库"))),
      stalledBanner(stalled?.visible() ?? [], clusterName),
      view.allGroups.length ? view.allGroups.map((group) => h('section', { class: 'workbench-detail workbench-overview-group' },
        h('div', { class: 'workbench-bar' }, h('h3', {}, group.cluster.name), h('button', { type: 'button', class: 'small', onclick: () => { selectCluster(group.cluster.id); open(group.cluster.id); } }, t("打开群工作台"))),
        group.error ? h('p', { class: 'form-error' }, t("加载失败：{error}", { error: group.error })) : null,
        group.data?.tasks?.length ? group.data.tasks.map((task) => h('button', { type: 'button', class: `workbench-member-task wb-task-${task.status}`,
          onclick: () => { selectCluster(group.cluster.id); open(group.cluster.id, task.id); } },
        h('span', { class: 'wb-task-title' }, ...taskTitleNodes(task)), statusChip(task), mergeBadge(task), priorityChip(task), dependencyChip(task),
        stalledChip(task, stalled?.taskMap(group.cluster.id) ?? new Map()), ...hiddenChips(task, group.cluster.id), task.assignedMemberId ? memberChip(task.assignedMemberId, group.cluster.id) : null))
          : group.data ? emptyState(t("暂无任务"), { compact: true }) : h('p', { class: 'muted' }, t("正在加载…")),
        group.data?.nextCursor ? h('button', { type: 'button', class: 'small', onclick: () => moreOverview(group) }, t("加载更多本群任务")) : null))
        : emptyState(t("暂无集群或正在加载。")));
  }

  async function moreTasks() {
    const cursor = view.workspace?.nextCursor;
    const cid = view.clusterId;
    const page = taskPageSpec();
    if (!cursor || page.key !== view.workspaceKey) return;
    try {
      const next = await workspacePage(page.filters, cursor);
      // Appends to whatever is on screen now, in the same step as this check, so it never drops what a refresh committed
      // meanwhile; a page for an older list (other cursor or filters) is dropped instead.
      if (!dialog.open || view.overview || cid !== view.clusterId || page.key !== taskPageSpec().key || cursor !== view.workspace?.nextCursor) return;
      view.workspace = { ...view.workspace, tasks: [...view.workspace.tasks, ...next.tasks], nextCursor: next.nextCursor };
      view.error = null;
    } catch (e) { if (cid === view.clusterId) view.error = e.message; }
    render();
  }

  async function moreDetail(target, kind) {
    const detail = view[target];
    const cursor = kind === 'events' ? detail?.eventsNextCursor : detail?.nextCursor;
    const taskId = detail?.task?.id;
    const cid = view.clusterId;
    if (!cursor || !taskId) return;
    const query = new URLSearchParams({ [kind === 'events' ? 'eventsCursor' : 'cursor']: cursor });
    try {
      const next = await api('GET', path(`/tasks/${encodeURIComponent(taskId)}?${query}`));
      if (cid !== view.clusterId || view[target] !== detail) return;
      if (kind === 'events') view[target] = { ...detail, events: [...detail.events, ...next.events], eventsNextCursor: next.eventsNextCursor };
      else view[target] = appendTaskRecords(detail, next);
      render();
    } catch (e) { if (cid === view.clusterId) { view.error = e.message; render(); } }
  }

  function chooseTask(taskId) {
    view.taskId = taskId;
    view.tab = 'tasks';
    view.detail = null;
    view.context = null;
    render();
    refresh();
  }

  function chooseTab(tab) {
    if (view.tab === tab) return;
    if (view.tab === 'collections') view.collectionRequest++;
    view.tab = tab;
    view.loadingTasks = null;
    render();
    void refresh();
  }

  function graphView(tasks) {
    const hideClosed = graphCanvas.isHideClosed(view.clusterId);
    const visible = graphCanvas.filterTasks(tasks, hideClosed);
    const graph = taskGraph(visible);
    const layers = graph.layers.map((layer) => layer.map(({ id, task }) => ({ id, task, element: task
      ? h('button', { class: `workbench-graph-node wb-task-${task.status}`, type: 'button', onclick: () => chooseTask(id) },
        h('b', {}, ...taskTitleNodes(task)), h('span', { class: 'wb-task-badges' }, statusChip(task), mergeBadge(task), priorityChip(task)),
        h('span', { class: 'wb-task-meta' }, task.assignedMemberId ? memberChip(task.assignedMemberId) : h('span', { class: 'muted' }, closedNote(task)),
          task.reviewer?.kind === 'member' ? h('span', { class: 'wb-task-reviewer' }, t("验收"), memberChip(task.reviewer.memberId))
            : task.reviewer?.kind === 'self' ? h('span', { class: 'wb-task-reviewer' }, t("自查")) : null,
          task.dependenciesReady === false ? h('span', { class: 'wb-warn' }, t("前置未就绪")) : null,
          dependencyChip(task), stalledChip(task), ...hiddenChips(task)))
      : h('div', { class: 'workbench-graph-node missing' }, t("未加载的前置任务"), h('span', { class: 'workbench-meta' }, id)) })));
    // Judged on the list actually loaded: hidden tasks still exist, and their saved positions must survive.
    const complete = Boolean(view.workspace) && !view.workspace.nextCursor && !view.workspaceFiltered && !view.quickView && !hideClosed;
    return h('div', {}, h('p', { class: 'muted' }, t("箭头从前置任务指向后续任务。滚轮缩放，拖动空白处平移，拖动任务可以换位置，点击任务查看详情。")),
      view.workspace?.nextCursor || narrowed() ? h('p', { class: 'banner warn' }, t("分页或筛选可能隐藏任务；图中的前置关系可能不完整。")) : null,
      tasks.length ? graphCanvas.canvas({
        clusterId: view.clusterId,
        layers,
        edges: graph.edges,
        complete,
        emptyNote: visible.length ? '' : t("当前已加载的任务都已结束；取消勾选“隐藏已结束”即可查看。"),
      }) : emptyState(t("创建任务后在这里查看依赖图。")));
  }

  function membersView(tasks) {
    const members = getMembers(view.clusterId);
    const partial = view.workspace?.nextCursor || narrowed();
    return h('div', {}, partial ? h('p', { class: 'banner warn' }, t("分页或筛选可能隐藏任务；以下只统计当前已加载结果。")) : null,
      h('div', { class: 'workbench-members' }, members.length ? members.map((member) => {
      const own = tasks.filter((task) => task.assignedMemberId === member.id);
      const reviews = tasks.filter((task) => task.status === 'review' && task.reviewer?.kind === 'member' && task.reviewer.memberId === member.id);
      const activity = getActivity(member.id);
      const roleIds = view.workspace?.memberRoles?.find((item) => item.memberId === member.id)?.roleIds ?? [];
      return h('section', { class: `wb-member-card wb-tone-${toneIndex(member.id)}` },
        // The member and its name, then what the activity observer saw. No status dot: the workbench does not redraw on
        // member status events, so a dot here could go stale (the header, the member list and the member page show it).
        h('div', { class: 'wb-member-card-head' },
          h('span', { class: 'wb-member' }, avatarEl(member, 'sm'), h('span', { class: 'wb-name' }, member.name)),
          h('span', { class: `wb-presence wb-presence-${String(activity.state ?? 'unknown').replace(/[^a-z-]/gi, '') || 'unknown'}` }, activity.state ?? t("未知"))),
        h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("业务角色")), roleList(roleIds)),
        h('p', { class: 'workbench-meta' }, t("当前已加载结果：负责 {ownCount} 项 · 待验收 {reviewsCount} 项", { ownCount: own.length, reviewsCount: reviews.length })),
        h('p', { class: 'workbench-meta' }, t("活动观察：{state}{response}{activity}", { state: activity.state, response: activity.seen ? t(" · 最近响应 {seen}", { seen: activity.seen }) : '', activity: activity.activity ? t(" · 最近活动 {activity}", { activity: activity.activity }) : '' })),
        ...[...new Map([...own, ...reviews].map((task) => [task.id, task])).values()].map((task) => h('button', {
          type: 'button', class: 'workbench-member-task', onclick: () => chooseTask(task.id),
        }, h('span', { class: 'wb-task-title' }, ...taskTitleNodes(task)), statusChip(task), mergeBadge(task),
        h('span', { class: 'wb-task-meta' }, priorityChip(task), dependencyChip(task), stalledChip(task),
          reviews.includes(task) ? h('span', { class: 'wb-warn' }, t("待其验收")) : null))));
    }) : emptyState(t("当前群没有成员。"))));
  }

  function itemCard(item) {
    const message = item.message;
    const tone = item.taskIds?.length ? `wb-tone-${toneIndex(item.taskIds[0])}` : '';
    const author = message.from === 'user' || message.from === 'system' || message.kind === 'plugin'
      ? h('span', { class: 'wb-author' }, messageName(message)) : memberChip(message.from);
    return h('article', { class: `workbench-card wb-item ${tone}` },
      h('div', { class: 'wb-item-head' }, author,
        h('span', { class: 'workbench-meta' }, message.createdAt ? new Date(message.createdAt).toLocaleString(language() === 'en' ? 'en-US' : 'zh-CN') : t("时间未知"))),
      h('p', {}, message.body || t("附件消息")),
      attachmentList(`message:${message.id}`, item.attachments ?? []),
      h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("任务")),
        item.taskIds?.length ? item.taskIds.map((id) => h('span', { class: `wb-tag wb-tone-${toneIndex(id)}`, title: taskName(id) },
          h('span', { class: 'wb-role-dot', 'aria-hidden': 'true' }), taskName(id))) : h('span', { class: 'muted' }, t("其他"))),
      collectionTabs.map((tab) => tab.itemRow?.(item, memberChip)),
      h('div', { class: 'workbench-actions' }, h('button', { type: 'button', class: 'small', onclick: () => noticeDialog(message.body || t("这条消息没有文字正文。"), t("消息原文")) }, t("查看原文")),
        h('button', { type: 'button', class: 'small', onclick: () => { dialog.close(); showMessage(view.clusterId, message.id); } }, t("查看群聊上下文与附件"))));
  }

  function messageLink(id, label = t("查看来源消息")) {
    return h('button', { type: 'button', class: 'small', onclick: () => { dialog.close(); showMessage(view.clusterId, id); } }, `${label} ${id.slice(0, 8)}`);
  }

  /** Markdown that folds past about 12 lines (fitLongText decides after each redraw); 展开/收起 survives redraws. */
  function longText(key, value) {
    const box = h('div', { class: `wb-long${opened.has(key) ? ' wb-long-open' : ''}` },
      h('div', { class: 'msg-body wb-long-body' }, renderMarkdown(value, view.clusterId)));
    const toggle = h('button', { type: 'button', class: 'wb-long-toggle', hidden: !opened.has(key), 'data-wb-focus': `text:${key}`,
      'aria-expanded': String(opened.has(key)), onclick: () => {
        const open = !opened.has(key);
        if (open) opened.add(key); else opened.delete(key);
        box.classList.toggle('wb-long-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? t("收起") : t("展开");
      } }, opened.has(key) ? t("收起") : t("展开"));
    box.append(toggle);
    return box;
  }

  /** Folded text that really overflows gets its fade and 展开; text that fits shows neither. */
  // shortcut: measured on redraw only, so resizing the window does not refold; measure on resize if that matters.
  function fitLongText() {
    for (const box of content.querySelectorAll('.wb-long:not(.wb-long-open)')) {
      const body = box.firstElementChild;
      const cut = body.scrollHeight > body.clientHeight + 1;
      box.classList.toggle('wb-long-cut', cut);
      box.lastElementChild.hidden = !cut;
    }
  }

  function submissionView(submission, task) {
    return h('div', { class: 'workbench-card wb-submission' },
      h('div', { class: 'wb-row' }, submission.commitSha ? h('span', { class: 'workbench-meta', title: submission.commitSha },
        t("提交 "), h('code', {}, submission.commitSha.slice(0, 7))) : null,
      submission.manual ? h('span', { class: 'wb-mode' }, t("用户手动标记")) : null,
      supersededSubmission(task, submission) ? h('span', { class: 'wb-mode' }, t("已取代")) : null),
      submission.summary ? longText(`submission:${submission.id}`, submission.summary) : null,
      attachmentList(`submission:${submission.id}`, submissionFiles(submission, messageFiles)),
      h('div', { class: 'workbench-actions' }, (submission.evidenceMessageIds ?? []).map((id) => messageLink(id, t("证据消息")))));
  }

  function actorName(actor) {
    if (actor === 'user' || actor?.kind === 'user') return t("用户");
    if (actor?.kind === 'system') return 'ship';
    const id = typeof actor === 'string' ? actor : actor?.memberId;
    return id ? nameOf(id) : t("未知");
  }

  function reviewView(review) {
    const content = review.reason ? longText(`review:${review.id}`, review.reason) : h('p', { class: 'muted' }, t("无正文"));
    return h('article', { class: 'workbench-card wb-review-record' },
      h('div', { class: 'wb-review-head' },
        h('b', {}, Number.isSafeInteger(review.round) && review.round > 0 ? t("第 {round} 轮", { round: review.round }) : t("轮次未知")),
        h('span', { class: `wb-verdict wb-verdict-${review.verdict === 'approve' ? 'approve' : 'reject'}` }, review.verdict === 'approve' ? t("通过") : t("退回")),
        h('span', {}, t("验收者 {actorName}", { actorName: actorName(review.reviewer) })),
        review.self ? h('span', { class: 'wb-task-reviewer' }, t("自查")) : null,
        review.manual ? h('span', { class: 'wb-task-reviewer' }, t("手动标记")) : null,
        h('span', {}, review.createdAt ?? t("时间未知")),
        review.commitSha ? h('span', { title: review.commitSha }, t("提交 "), h('code', {}, review.commitSha.slice(0, 7))) : null), content);
  }

  function takeoverView(item) {
    // task.takeover: the reviewer took the task over; an edit, assignment or hand-off moved self review to an executor.
    const moved = item.action && item.action !== 'task.takeover';
    return h('p', { class: 'wb-takeover-record' }, t("{actorName} 发起 · ", { actorName: actorName(item.by) }), moved ? t("自查授权给 ") : null, memberChip(item.toMemberId), moved ? '' : t(" 接手执行"),
      item.fromMemberId && item.fromMemberId !== item.toMemberId ? [t("（原执行者 "), memberChip(item.fromMemberId), t('）')] : null,
      t(" · 验收方式 {before} → {after} · 依据 {basis}", { before: reviewModeText(item.reviewFrom, nameOf), after: reviewModeText(item.reviewTo, nameOf), basis: (TAKEOVER_BASIS[item.basis] ? t(TAKEOVER_BASIS[item.basis]) : t("未知")) }),
      item.previousRejected ? t(" · 上一轮验收为退回") : '', ` · ${item.createdAt ?? t("时间未知")}`);
  }

  function approvalView(item) {
    return h('p', {}, t("{verdict} · 定义版本 {version} · {time}{reason}", { verdict: item.verdict === 'approve' ? t("已批准") : t("已退回"), version: item.definitionVersion ?? t("未知"), time: item.createdAt ?? t("时间未知"), reason: item.reason ? ` · ${item.reason}` : '' }));
  }

  function mergeView(item) {
    return h('p', {}, item.manual ? t("用户手动标记已合并") : t("合并提交"),
      item.commitSha ? h('span', {}, item.manual ? t(" · 提交 ") : ' ', h('code', { title: item.commitSha }, item.commitSha))
        : item.manual ? t(" · 未填提交号") : t(" 未知"),
      t(" · 记录人 {author} · {time}{reason}", { author: actorName(item.recordedBy), time: item.createdAt ?? t("时间未知"), reason: item.reason ? ` · ${item.reason}` : '' }));
  }

  function taskName(id) { const task = view.workspace?.tasks?.find((item) => item.id === id); return task ? taskLabel(task) : t("未加载任务 {id}", { id: id.slice(0, 8) }); }

  function lookup(clusterId, kind, id) {
    if (view.clusterId !== clusterId) return null;
    if (kind === 'task') {
      const task = view.workspace?.tasks?.find((item) => item.id === id);
      return task ? taskLabel(task) : null;
    }
    if (kind === 'role') return view.workspace?.roles?.find((role) => role.id === id)?.name ?? null;
    if (kind === 'member') return getHistoryMembers(clusterId).find((member) => member.id === id)?.name ?? null;
    return null;
  }

  function eventRows(events, taskId) {
    if (!events?.length) return emptyState(t("暂无事件"), { compact: true });
    return events.map((event) => {
      const action = event.payload?.action;
      const branchChange = action === 'task.set_git_branch';
      let diff = null;
      if (branchChange || ['task.create', 'task.edit'].includes(action)) {
        const cid = view.clusterId;
        const key = JSON.stringify([cid, taskId, event.seq]);
        diff = eventDiffs.get(key);
        if (!diff) {
          diff = createTaskDiffView({ load: async () => event.payload, resolve: (kind, id) => lookup(cid, kind, id) });
          eventDiffs.set(key, diff);
        }
      }
      return h('div', { class: 'task-event-row' },
        h('p', { class: 'workbench-meta' }, `${event.createdAt ?? ''} · ${branchChange ? t("更新 Git 分支") : (action ?? event.kind)} · ${event.seq}`), diff);
    });
  }

  // The two collection views share one request slot so a late response cannot redraw the other view.
  function beginCollectionRequest() {
    const request = ++view.collectionRequest;
    return () => request === view.collectionRequest;
  }

  async function loadPublic(taskId, cursorKind = null) {
    const cid = view.clusterId;
    const current = beginCollectionRequest();
    view.collectionTask = taskId;
    if (!taskId) { view.collectionContext = null; view.collectionDetail = null; render(); return; }
    const query = new URLSearchParams(Object.entries(view.publicFilters).filter(([, value]) => value));
    if (cursorKind === 'messages' && view.collectionContext?.messagesNextCursor) query.set('messagesCursor', view.collectionContext.messagesNextCursor);
    if (cursorKind === 'events' && view.collectionContext?.nextCursor) query.set('cursor', view.collectionContext.nextCursor);
    if (cursorKind === 'attentions' && view.collectionContext?.attentionsNextCursor) query.set('attentionsCursor', view.collectionContext.attentionsNextCursor);
    try {
      const [context, detail] = await Promise.all([
        api('GET', path(`/tasks/${encodeURIComponent(taskId)}/context?${query}`)),
        cursorKind ? Promise.resolve(view.collectionDetail) : api('GET', path(`/tasks/${encodeURIComponent(taskId)}`)),
      ]);
      if (cid !== view.clusterId || !current() || taskId !== view.collectionTask) return;
      if (cursorKind === 'messages') view.collectionContext = { ...view.collectionContext, messages: [...view.collectionContext.messages, ...context.messages], messagesNextCursor: context.messagesNextCursor };
      else if (cursorKind === 'events') view.collectionContext = { ...view.collectionContext, events: [...view.collectionContext.events, ...context.events], nextCursor: context.nextCursor };
      else if (cursorKind === 'attentions') view.collectionContext = { ...view.collectionContext, attentions: [...view.collectionContext.attentions, ...context.attentions], attentionsNextCursor: context.attentionsNextCursor };
      else { view.collectionContext = context; view.collectionDetail = detail; }
      view.error = null;
    } catch (e) { if (cid === view.clusterId && current()) view.error = e.message; }
    render();
  }

  function publicFilters() {
    const filters = view.publicFilters;
    const sender = h('select', {}, h('option', { value: '' }, t("全部发送者")), h('option', { value: 'user' }, t("你")), h('option', { value: 'system' }, t("Orrery 系统")),
      getHistoryMembers(view.clusterId).map((item) => h('option', { value: item.id }, `${item.name}${item.removedAt ? t("（已移出）") : ''}`)));
    const q = h('input', { value: filters.q ?? '' });
    const since = h('input', { value: filters.since ?? '', placeholder: t("ISO 时间，可留空") });
    const until = h('input', { value: filters.until ?? '', placeholder: t("ISO 时间，可留空") });
    sender.value = filters.sender ?? '';
    formDialog(t("筛选任务资料"), [h('label', {}, t("发送者"), sender), h('label', {}, t("关键词"), q),
      h('label', {}, t("从时间"), since), h('label', {}, t("到时间"), until)], () => {
      view.publicFilters = { sender: sender.value, q: q.value.trim(), since: since.value.trim(), until: until.value.trim() };
      return loadPublic(view.collectionTask);
    });
  }

  function sendComment(task) {
    const body = h('textarea', { required: true });
    const recipients = h('select', { multiple: true, 'aria-label': t("明确通知成员") },
      getMembers(view.clusterId).map((member) => h('option', { value: member.id }, member.name)));
    formDialog(t("任务留言"), [h('label', {}, t("留言"), body), h('label', {}, t("明确通知成员（可多选）"), recipients)], async () => {
      const to = [...recipients.selectedOptions].map((option) => option.value);
      await api('POST', path('/messages'), { body: body.value, taskIds: [task.id], ...(to.length ? { to } : {}) });
      await refresh();
    });
  }

  function editSummary(task, context) {
    const summary = h('textarea', { required: true }); summary.value = context?.summary?.content ?? '';
    const through = h('input', { type: 'number', min: '0', value: String(context?.events?.at(-1)?.seq ?? context?.summary?.throughEventId ?? 0), required: true });
    const sources = h('input', { value: (context?.summary?.sourceMessageIds ?? []).join(', '), placeholder: t("消息 ID，用逗号分隔") });
    formDialog(t("更新任务摘要"), [h('label', {}, t("摘要"), summary), h('label', {}, t("覆盖到事件序号"), through), h('label', {}, t("来源消息 ID"), sources)],
      () => command({ action: 'task.summary', taskId: task.id, expectedRevision: task.revision, summary: summary.value.trim(),
        throughEventId: Number(through.value), sourceMessageIds: sources.value.split(/[,，]/).map((id) => id.trim()).filter(Boolean) }));
  }

  function publicMaterials() {
    const tasks = view.workspace?.tasks ?? [];
    const selected = h('select', { 'aria-label': t("资料所属任务"), onchange: (event) => loadPublic(event.target.value) },
      h('option', { value: '' }, t("选择任务")), tasks.map((task) => h('option', { value: task.id }, taskLabel(task))));
    selected.value = view.collectionTask ?? '';
    const context = view.collectionContext;
    const detail = view.collectionDetail;
    const task = context?.task;
    return h('div', {}, h('div', { class: 'workbench-bar' }, h('label', {}, t("任务 "), selected),
      task ? h('div', { class: 'workbench-actions' }, h('button', { type: 'button', class: 'small', onclick: publicFilters }, t("筛选资料")),
        h('button', { type: 'button', class: 'small', onclick: () => sendComment(task) }, t("写任务留言"))) : null),
    task ? h('div', { class: 'workbench-detail' }, h('div', { class: 'wb-detail-head' }, h('h3', {}, ...taskTitleNodes(task)),
      h('div', { class: 'wb-detail-badges' }, statusChip(task), mergeBadge(task), priorityChip(task))), h('p', {}, t("目标：{scope}", { scope: task.scope })), h('p', {}, t("验收：{acceptance}", { acceptance: task.acceptance })),
      h('section', {}, h('h4', {}, t("当前摘要")), context.summary ? h('p', {}, context.summary.content) : emptyState(t("暂无摘要"), { compact: true }),
        context.summary ? h('p', { class: 'workbench-meta' }, t("{name} · {updatedAt} · 覆盖到事件 {throughEventId}", { name: nameOf(context.summary.author), updatedAt: context.summary.updatedAt, throughEventId: context.summary.throughEventId })) : null,
        h('div', { class: 'workbench-actions' }, (context.summary?.sourceMessageIds ?? []).map((id) => messageLink(id))),
        h('button', { type: 'button', class: 'small', onclick: () => editSummary(task, context) }, t("更新摘要"))),
      h('section', {}, h('h4', {}, t("关联消息与附件")), context.messages?.length ? context.messages.map(itemCard) : emptyState(t("暂无关联消息"), { compact: true }),
        context.messagesNextCursor ? h('button', { type: 'button', class: 'small', onclick: () => loadPublic(task.id, 'messages') }, t("加载更多消息")) : null),
      h('section', {}, h('h4', {}, t("未解决事项")), context.attentions?.length ? context.attentions.map((item) => h('p', {}, item.question)) : emptyState(t("暂无未解决事项"), { compact: true }),
        context.attentionsNextCursor ? h('button', { type: 'button', class: 'small', onclick: () => loadPublic(task.id, 'attentions') }, t("加载更多事项")) : null),
      h('section', {}, h('h4', {}, t("结果与验收")), detail?.submissions?.length ? detail.submissions.map((item) => submissionView(item, task)) : emptyState(t("暂无结果"), { compact: true }),
        detail?.reviews?.map((review) => reviewView(review, task)),
        detail?.approvals?.map(approvalView), detail?.merges?.map(mergeView),
        detail?.nextCursor ? h('button', { type: 'button', class: 'small', onclick: () => moreDetail('collectionDetail', 'records') }, t("加载更多结果与记录")) : null),
      h('section', {}, h('h4', {}, t("事件时间线")), eventRows(context.events, task.id),
        context.nextCursor ? h('button', { type: 'button', class: 'small', onclick: () => loadPublic(task.id, 'events') }, t("加载更多事件")) : null))
      : emptyState(t("选择任务查看公共资料。")));
  }

  function collectionsView() {
    const tabs = [{ id: 'public', label: t("任务公共资料"), render: publicMaterials,
      load: () => { if (view.collectionTask) loadPublic(view.collectionTask); } }, ...collectionTabs];
    const current = tabs.find((tab) => tab.id === view.collectionMode) ?? tabs[0];
    const actions = tabs.map((tab) => h('button', { type: 'button', 'aria-pressed': String(current === tab),
      onclick: () => {
        if (view.collectionMode !== tab.id) view.collectionRequest++;
        view.collectionMode = tab.id;
        render();
        tab.load();
      } }, tab.label));
    return h('div', {}, h('div', { class: 'workbench-actions' }, actions), current.render());
  }

  function configureCoordinator(policy) {
    const member = h('select', { required: true }, h('option', { value: '' }, t("选择已有成员")),
      getMembers(view.clusterId).map((item) => h('option', { value: item.id }, item.name)));
    member.value = policy?.memberId ?? '';
    const mode = h('select', {}, h('option', { value: 'execute' }, t("授权执行")), h('option', { value: 'suggest' }, t("只建议")));
    mode.value = policy?.mode ?? 'execute';
    const checks = PERMISSIONS.map(([key, label, description], index) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = policy?.permissions?.[key] ?? index < 6;
      return { key, input, el: h('label', { class: 'workbench-check' }, input, h('span', {}, h('b', {}, t(label)), ` · ${t(description)}`)) };
    });
    formDialog(t("设置协调授权"), [h('p', { class: 'muted' }, t("必须明确选择现有成员并保存才启用。协调员不能修改自己的授权或代替验收。")),
      h('label', {}, t("协调员"), member), h('label', {}, t("模式"), mode), ...checks.map((item) => item.el)], () => command({
      action: 'coordinator.set', memberId: member.value, enabled: true, mode: mode.value,
      permissions: Object.fromEntries(checks.map((item) => [item.key, item.input.checked])),
      ...(policy ? { generation: policy.generation } : {}),
    }));
  }

  async function revokeCoordinator(policy) {
    const ok = await confirmDialog({ title: t("撤销协调授权？"), message: t("任务和资料会保留；协调员将不能继续使用这些委托权限。"), confirmText: t("撤销授权"), danger: true });
    if (!ok) return;
    try { await command({ action: 'coordinator.set', memberId: policy.memberId, enabled: false, mode: policy.mode,
      permissions: policy.permissions, generation: policy.generation }); }
    catch (e) { view.error = e.message; render(); }
  }

  function editInstruction(item = null) {
    const text = h('textarea', { required: true, maxLength: 500 });
    if (item) text.value = item.text;
    formDialog(item ? t("编辑用户长期要求") : t("新增用户长期要求"),
      [h('p', { class: 'muted' }, t("最多 500 字；换任时会随交接摘要一起交给新协调员，协调员按它继续执行。")),
        h('label', {}, t("内容"), text)],
      () => command({ action: item ? 'coordinator.instruction.edit' : 'coordinator.instruction.add',
        ...(item ? { instructionId: item.id } : {}), instructionText: text.value.trim() }));
  }

  async function deleteInstruction(item) {
    const ok = await confirmDialog({ title: t("删除长期要求？"), message: item.text, confirmText: t("删除"), danger: true });
    if (!ok) return;
    try { await command({ action: 'coordinator.instruction.remove', instructionId: item.id }); }
    catch (e) { view.error = e.message; render(); }
  }

  function createRole() {
    const name = h('input', { required: true });
    const description = h('textarea', { placeholder: t("这个角色负责什么、什么时候该找它（可留空）") });
    formDialog(t("新增业务角色"), [h('label', {}, t("角色名称"), name), h('label', {}, t("角色描述"), description)],
      () => command({ action: 'role.create', name: name.value.trim(), description: description.value.trim() }));
  }

  async function ensureDefaultRoles() {
    try {
      await command({ action: 'role.ensure_defaults' });
      await noticeDialog(t("已补全缺失的默认角色和空描述，已有描述保持不变。"), t("默认角色已检查"));
    } catch (e) { view.error = e.message; render(); }
  }

  function editRole(role) {
    const description = h('textarea', { placeholder: t("这个角色负责什么、什么时候该找它") });
    description.value = role.description ?? '';
    formDialog(t("编辑角色描述 · {name}", { name: role.name }), [
      h('p', { class: 'muted' }, t("成员读取任务时会看到这段描述。留空保存即清除描述。")),
      h('label', {}, t("角色描述"), description)],
    () => command({ action: 'role.edit', roleId: role.id, description: description.value.trim() }));
  }

  async function deleteRole(role) {
    const ok = await confirmDialog({ title: t("删除角色？"), message: t("删除“{name}”前请确认没有任务或成员继续使用。", { name: role.name }), confirmText: t("删除"), danger: true });
    if (!ok) return;
    try { await command({ action: 'role.delete', roleId: role.id }); }
    catch (e) { view.error = e.message; render(); }
  }

  function assignRoles(member) {
    const current = view.workspace?.memberRoles?.find((item) => item.memberId === member.id)?.roleIds ?? [];
    const checks = (view.workspace?.roles ?? []).map((role) => {
      const input = h('input', { type: 'checkbox' }); input.checked = current.includes(role.id);
      return { role, input, el: h('label', { class: 'workbench-check wb-role-check' }, input,
        h('span', { class: 'wb-check-text' }, roleChip(role),
          h('span', { class: 'wb-role-description' }, role.description || t("暂无描述")))) };
    });
    formDialog(t("设置 {name} 的角色", { name: member.name }), checks.length ? checks.map((item) => item.el) : [h('p', { class: 'muted' }, t("尚未创建业务角色。"))],
      () => command({ action: 'member.roles', memberId: member.id, roleIds: checks.filter((item) => item.input.checked).map((item) => item.role.id) }));
  }

  // ---- 角色与协调: a section rail beside one column of same-shaped cards (docs/collaboration.md「角色与协调页」) ----
  // [id, rail label, belongs to the coordinator plugin]
  const SETTINGS_SECTIONS = [['coordinator', t("协调员"), true], ['instructions', t("长期要求"), true], ['roles', t("业务角色")],
    ['member-roles', t("成员角色")], ['labels', t("标签组")], ['cluster', t("本群设置")]];
  const settingsSections = () => SETTINGS_SECTIONS.filter(([, , coordinator]) => !coordinator || coordinatorEnabled());
  const railButtons = new Map();   // section id -> rail button of the page on screen
  const sectionCards = new Map();  // section id -> its card
  let railPinned = false;          // a rail click scrolls smoothly; the scroll it causes must not move the highlight

  /** One card: heading row (title, optional chip, actions on the right), one muted line, then the content. */
  const settingsCard = (id, title, { chip = null, actions = [], sub }, ...content) => {
    const card = h('section', { class: `wb-rp-card wb-rp-${id}`, id: `wb-rp-${id}`, 'data-wb-section': id, 'aria-labelledby': `wb-rp-${id}-title` },
      h('div', { class: 'wb-rp-head' }, h('h3', { id: `wb-rp-${id}-title` }, title), chip,
        actions.filter(Boolean).length ? h('div', { class: 'wb-rp-actions' }, actions) : null),
      h('p', { class: 'wb-rp-sub' }, sub), ...content);
    sectionCards.set(id, card);
    return card;
  };
  /** A list row: what it is on the left (title, muted line under it), its actions on the right of the same row. */
  const settingsRow = (title, description, actions, extra = {}) => h('div', { class: 'wb-rp-row', ...extra },
    h('div', { class: 'wb-rp-main' }, h('div', { class: 'wb-rp-title' }, title),
      description === null ? null : h('div', { class: 'wb-rp-desc' }, description)),
    h('div', { class: 'wb-rp-row-actions' }, actions));
  const rowButton = (label, onclick, danger = false) => h('button', { type: 'button', class: danger ? 'small danger' : 'small', onclick }, label);
  // In-card rows: the compact empty state (ui.js), so a 48 px picture does not weigh on a card.
  const rpEmpty = (text) => emptyState(text, { compact: true });
  /** The existing switch look (settings.css .plugin-switch): a checkbox with role=switch, named by its row. */
  const settingSwitch = (props) => h('label', { class: 'plugin-switch' }, h('input', { type: 'checkbox', role: 'switch', ...props }));

  function markSection(id) {
    view.settingsSection = id;
    for (const [key, button] of railButtons) button.setAttribute('aria-current', String(key === id));
    revealRailItem(id);
  }
  /** Narrow layout: keep the item inside the horizontally scrolling rail. Only scrollLeft moves, never the page. */
  function revealRailItem(id) {
    const button = railButtons.get(id);
    const rail = button?.parentElement;
    if (!rail || !(rail.scrollWidth > rail.clientWidth)) return;
    if (button.offsetLeft < rail.scrollLeft) rail.scrollLeft = button.offsetLeft - 8;
    else if (button.offsetLeft + button.offsetWidth > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = button.offsetLeft + button.offsetWidth - rail.clientWidth + 8;
  }
  /** The card nearest the top of the scrolled content; the last one once the content is scrolled to its end. */
  function sectionInView() {
    const cards = [...sectionCards.entries()].filter(([, card]) => card.isConnected);
    if (!cards.length) return null;
    if (content.scrollTop > 0 && content.scrollTop + content.clientHeight >= content.scrollHeight - 2) return cards.at(-1)[0];
    const line = content.getBoundingClientRect().top + (parseFloat(getComputedStyle(content).scrollPaddingTop) || 0) + 24;
    let id = cards[0][0];
    for (const [key, card] of cards) if (card.getBoundingClientRect().top <= line) id = key;
    return id;
  }
  function goToSection(id) {
    markSection(id);
    const card = sectionCards.get(id);
    if (!card?.scrollIntoView) return;
    railPinned = true;
    card.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  const onSettingsPage = () => !view.overview && view.tab === 'settings' && dialog.open;
  content.addEventListener('scroll', () => { if (onSettingsPage() && !railPinned) { const id = sectionInView(); if (id && id !== view.settingsSection) markSection(id); } }, { passive: true });
  content.addEventListener('scrollend', () => { railPinned = false; });
  // The user taking over the scroll (wheel, touch, keys, the scrollbar) ends the pin at once: a rail click that did not need
  // to scroll fires no scrollend. A rail click itself unpins on pointerdown and pins again on click.
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) content.addEventListener(type, () => { railPinned = false; }, { passive: true });

  function settingsRail(sections) {
    railButtons.clear();
    return h('nav', { class: 'wb-rp-rail', 'aria-label': t("{section}分区", { section: coordinatorEnabled() ? t("角色与协调") : t("角色") }) }, sections.map(([id, label]) => {
      const button = h('button', { type: 'button', 'aria-current': String(view.settingsSection === id), 'aria-controls': `wb-rp-${id}`,
        'data-wb-focus': `rail-${id}`, onclick: () => goToSection(id) }, label);
      railButtons.set(id, button);
      return button;
    }));
  }

  function coordinatorCard(policy) {
    const configure = () => configureCoordinator(policy);
    if (!policy?.enabled) {
      return settingsCard('coordinator', t("协调员"), { sub: t("一名成员按你给的授权替你协调本群。") },
        emptyState(t("还没有协调员。启用后，它按授权替你派工、安排验收、处理受阻的任务，没有点名的消息也交给它。"),
          { compact: true, action: h('button', { type: 'button', class: 'small primary', onclick: configure }, t("设置并启用")) }));
    }
    const member = memberOf(policy.memberId);
    const rules = policy.rules;
    return settingsCard('coordinator', t("协调员"), {
      chip: h('span', { class: `wb-mode wb-mode-${policy.mode}` }, policy.mode === 'execute' ? t("授权执行") : t("只建议")),
      actions: [rowButton(t("修改授权"), configure), rowButton(t("撤销授权"), () => revokeCoordinator(policy), true)],
      sub: policy.mode === 'execute' ? t("按下面的授权替你派工、安排验收和处理故障。") : t("只提出建议，不替你落实任务或配置变更。"),
    },
    h('div', { class: 'wb-rp-who' }, member ? avatarEl(member) : memberChip(policy.memberId), member ? h('b', {}, member.name) : null),
    h('ul', { class: 'wb-rp-perms', 'aria-label': t("授权范围") }, PERMISSIONS.map(([key, label, description]) => {
      const on = policy.permissions?.[key] === true;
      return h('li', { class: on ? 'wb-rp-perm wb-rp-perm-on' : 'wb-rp-perm', title: t(description) },
        on ? icon('check', 'ico-xs') : null, t(label), h('span', { class: 'sr-only' }, on ? t("（已授权）") : t("（未授权）")));
    })),
    rules ? h('details', { class: 'wb-rp-rules', open: view.rulesOpen === true, ontoggle: (event) => { view.rulesOpen = event.target.open; } },
      h('summary', {}, h('span', {}, t("协调规则 {version}", { version: rules.version })), h('span', { class: 'wb-rp-rules-toggle', 'aria-hidden': 'true' })),
      h('div', { class: 'wb-rp-rules-text', tabindex: '0', role: 'region', 'aria-label': t("协调规则 {version} 全文", { version: rules.version }) }, rules.text)) : null);
  }

  function instructionsCard(policy) {
    const items = policy?.standingInstructions ?? [];
    return settingsCard('instructions', t("用户长期要求"), {
      actions: [policy ? null : h('span', { class: 'wb-rp-hint', id: 'wb-rp-instructions-hint' }, t("先启用协调员，再添加长期要求。")),
        h('button', { type: 'button', class: 'small', onclick: () => editInstruction(), disabled: policy ? undefined : true,
          'aria-describedby': policy ? undefined : 'wb-rp-instructions-hint' }, t("新增要求"))],
      sub: t("换任时会随交接摘要交给新协调员；协调员按此继续执行。"),
    }, items.length ? items.map((item) => settingsRow(item.text, null,
      [rowButton(t("编辑"), () => editInstruction(item)), rowButton(t("删除"), () => deleteInstruction(item), true)], { class: 'wb-rp-row wb-rp-instruction' }))
      : rpEmpty(t("还没有长期要求。")));
  }

  function rolesCard(roles) {
    return settingsCard('roles', t("业务角色"), {
      actions: [rowButton(t("新增角色"), createRole), rowButton(t("补上默认角色"), ensureDefaultRoles)],
      sub: t("角色决定任务资格，不授予协调管理权限。"),
    }, roles.length ? roles.map((role) => settingsRow(
      h('span', { class: `wb-rp-role wb-tone-${toneIndex(role.id)}` }, h('span', { class: 'wb-role-dot', 'aria-hidden': 'true' }), role.name),
      role.description || t("暂无描述"), [rowButton(t("编辑"), () => editRole(role)), rowButton(t("删除"), () => deleteRole(role), true)]))
      : rpEmpty(t("还没有业务角色。可以新增，或点“补上默认角色”加上设计者、验收者和执行者。")));
  }

  function memberRolesCard() {
    const members = getMembers(view.clusterId);
    const roleIdsOf = (id) => view.workspace?.memberRoles?.find((item) => item.memberId === id)?.roleIds ?? [];
    return settingsCard('member-roles', t("成员角色"), { sub: t("每个成员能执行和验收哪些任务，由它的业务角色决定。") },
      members.length ? members.map((member) => settingsRow(memberChip(member.id),
        h('span', { class: 'wb-member-roles' }, roleList(roleIdsOf(member.id))), [rowButton(t("设置角色"), () => assignRoles(member))]))
        : rpEmpty(t("当前群没有成员。")));
  }

  /** Which label groups this cluster uses (recommended in the task form, required ones enforced), and the library entry. */
  function labelGroupsCard() {
    const groups = view.workspace?.labelLibrary?.groups ?? [];
    const toggle = async (group, selected) => {
      try { await command({ action: 'label.select_group', groupId: group.id, selected }); }
      catch (e) { await noticeDialog(e.message, t("没有完成")); render(); }
    };
    return settingsCard('labels', t("本群使用的标签组"), {
      actions: [rowButton(t("管理标签库"), openLabels)],
      sub: t("新建和编辑任务时按组列出这些组的标签；必选组的标签每个新任务至少带一个。别的组的标签也可以直接用。"),
    }, groups.length ? groups.map((group) => settingsRow(
      [h('span', {}, group.name), group.required ? h('span', { class: 'wb-lp-required' }, t("必选")) : null,
        group.newClusterDefault ? h('span', { class: 'wb-lm-badge' }, t("新群默认使用")) : null],
      (group.labels ?? []).filter((label) => !label.archived).map((label) => label.name).join('、') || t("还没有标签"),
      [settingSwitch({ checked: group.selected === true, 'aria-label': t("本群使用「{name}」", { name: group.name }), 'data-wb-focus': `label-group-${group.id}`,
        onchange: (event) => toggle(group, event.target.checked) })]))
      : rpEmpty(t("标签库里还没有组。点“管理标签库”新建。")));
  }

  /** Switches that take effect at once: this cluster's delivery, and 允许验收者接手后自检 (per cluster, off by default, user only). */
  function clusterSettingsCard() {
    const paused = view.workspace?.paused === true;
    const takeover = view.workspace?.taskSettings?.takeoverSelfReview === true;
    const pause = async (next) => {
      try { await command({ action: 'cluster.pause', paused: next }); }
      catch (e) { view.error = e.message; render(); }
    };
    const allowTakeover = async (checked) => {
      try { await command({ action: 'tasks.settings', takeoverSelfReview: checked }); }
      catch (e) { await noticeDialog(e.message, t("没有完成")); render(); }
    };
    return settingsCard('cluster', t("本群设置"), { sub: t("这里的开关点一下立即生效。") },
      settingsRow(h('span', { id: 'wb-rp-delivery-title' }, t("本群投递")),
        h('span', { id: 'wb-rp-delivery-note' }, paused ? t("本群已暂停开始新投递；已开始的执行不受影响。") : t("本群允许开始新投递。")),
        [settingSwitch({ checked: !paused, 'aria-labelledby': 'wb-rp-delivery-title', 'aria-describedby': 'wb-rp-delivery-note',
          'data-wb-focus': 'setting-delivery', onchange: (event) => pause(!event.target.checked) })]),
      settingsRow([h('span', { id: 'wb-rp-takeover-title' }, t("允许验收者接手后自检")), h('span', { class: 'wb-warn' }, t("降低验收档"))],
        h('span', { id: 'wb-takeover-setting-note' }, t("打开后，成员把任务交给验收者时可以选自查：验收者自己检查后直接完成，不必等你在网页上操作；每次都会记在任务上并提醒。")),
        [settingSwitch({ checked: takeover, 'aria-labelledby': 'wb-rp-takeover-title', 'aria-describedby': 'wb-takeover-setting-note',
          'data-wb-focus': 'setting-takeover', onchange: (event) => allowTakeover(event.target.checked) })]));
  }

  /** The label library manager, from a cluster or from 全部任务; it belongs to no cluster. At most one is open. */
  let labelManager = null;
  function openLabels() {
    if (labelManager) return;
    labelManager = openLabelManager({ api, tone: (name) => toneIndex(name, 8), gate: redrawGate, onClose: () => { labelManager = null; } });
  }

  function settingsView() {
    const policy = view.workspace?.coordinator;
    const sections = settingsSections();
    if (!sections.some(([id]) => id === view.settingsSection)) view.settingsSection = sections[0][0];
    sectionCards.clear();
    const cards = { coordinator: () => coordinatorCard(policy), instructions: () => instructionsCard(policy),
      roles: () => rolesCard(view.workspace?.roles ?? []), 'member-roles': memberRolesCard, labels: labelGroupsCard, cluster: clusterSettingsCard };
    return h('div', { class: 'workbench-settings wb-rp' }, settingsRail(sections),
      h('div', { class: 'wb-rp-stack' }, sections.map(([id]) => cards[id]())));
  }

  /** The 验收者 choices (用户, 自查, each member) set to the task's reviewer; a reviewer no longer listed stays selectable. */
  function reviewerSelect(task) {
    const members = getMembers(view.clusterId);
    const current = task?.reviewer?.kind === 'member' ? task.reviewer.memberId : task?.reviewer?.kind === 'self' ? 'self' : 'user';
    const select = h('select', {}, h('option', { value: 'user' }, t("用户")), h('option', { value: 'self' }, t("自查")),
      members.map((member) => h('option', { value: member.id }, member.name)),
      task?.reviewer?.kind === 'member' && !members.some((member) => member.id === current) ? h('option', { value: current }, nameOf(current)) : null);
    select.value = current;
    return select;
  }
  const reviewerOf = (value) => value === 'user' ? { kind: 'user' } : value === 'self' ? { kind: 'self' } : { kind: 'member', memberId: value };

  /** After work has started: change only the reviewer. A refusal (a participant, the executor, self review in review…) stays in the dialog. */
  function changeReviewer(task) {
    const select = reviewerSelect(task);
    const before = select.value;
    formDialog(t("更换验收人"), [h('p', { class: 'muted' }, t("只换验收人，不打断执行；待验收的结果改由新验收人验收。")), h('label', {}, t("验收者"), select)],
      async () => {
        if (select.value === before) return;
        await command({ action: 'task.edit', taskId: task.id, expectedRevision: task.revision, reviewer: reviewerOf(select.value) });
      });
  }

  function editTask(task = null, savedFiles = []) {
    const input = (value = '') => h('input', { required: true, value });
    const area = (value = '') => { const el = h('textarea', { required: true }); el.value = value; return el; };
    const title = input(task?.title);
    const scope = area(task?.scope);
    const acceptance = area(task?.acceptance);
    const labels = labelPicker(view.workspace?.labelLibrary, task?.labels ?? [], labelTone);
    const priority = h('select', {}, Object.entries(PRIORITY).map(([id, label]) => h('option', { value: id }, label)));
    priority.value = task?.priority ?? 'normal';
    const reviewer = reviewerSelect(task);
    const executor = h('select', {}, h('option', { value: '' }, t("不指定")),
      getMembers(view.clusterId).map((member) => h('option', { value: member.id }, member.name)));
    const requiresApproval = h('input', { type: 'checkbox', checked: task?.requiresApproval === true });
    const mergeRequired = h('input', { type: 'checkbox', checked: task ? task.mergeRequired === true : true });
    // A new task may go into an open batch that has no review yet: it takes the batch reviewer and needs a merge.
    const openBatches = task ? [] : (view.workspace?.batches ?? []).filter((item) => !item.reviewedAt && !item.cancelledAt);
    const batch = h('select', { 'aria-label': t("验收批次") }, h('option', { value: '' }, t("不放进批次")),
      openBatches.map((item) => h('option', { value: item.id }, `B${item.number} · ${item.title}`)));
    const batchHint = h('p', { class: 'muted', hidden: true }, t("批次里的任务由批次的验收者验收，并且需要合并。"));
    batch.addEventListener('change', () => {
      const chosen = openBatches.find((item) => item.id === batch.value);
      reviewer.disabled = Boolean(chosen); mergeRequired.disabled = Boolean(chosen); batchHint.hidden = !chosen;
      if (chosen) { reviewer.value = chosen.reviewer.kind === 'member' ? chosen.reviewer.memberId : 'user'; mergeRequired.checked = true; }
    });
    const multi = (items, selected, label) => {
      const known = new Set(items.map((item) => item.id));
      const options = [...items, ...selected.filter((id) => !known.has(id)).map((id) => ({ id, name: t("未加载：{id}", { id }) }))];
      const el = h('select', { multiple: true, 'aria-label': label }, options.map((item) => h('option', { value: item.id }, item.name)));
      for (const option of el.options) option.selected = selected.includes(option.value);
      return el;
    };
    const deps = multi([], task?.dependencyIds ?? [], t("前置任务"));
    const roles = (view.workspace?.roles ?? []).map((role) => ({ id: role.id, name: role.name }));
    const executeRoles = multi(roles, task?.executeRoleIds ?? [], t("执行角色"));
    const reviewRoles = multi(roles, task?.reviewRoleIds ?? [], t("验收角色"));
    const selected = (el) => [...el.selectedOptions].map((option) => option.value);
    const depPager = taskOptionsPager(view.clusterId, deps, task?.id);
    const clusterId = view.clusterId;
    const files = filesField(savedFiles, (file, name) => uploadFile(clusterId, file, name));
    const modal = formDialog(task ? t("编辑任务") : t("新建任务"), [h('label', {}, t("标题"), title), h('label', {}, t("范围与目标"), scope),
      files.el, h('label', {}, t("验收条件"), acceptance), h('label', {}, t("优先级"), priority),
      h('div', { class: 'wb-form-field', role: 'group', 'aria-label': t("标签") }, h('span', { class: 'wb-form-caption' }, t("标签")), labels.el),
      task ? null : h('label', {}, t("执行者"), executor), openBatches.length ? h('label', {}, t('验收批次'), batch) : null, batchHint,
      h('label', {}, t("验收者"), reviewer),
      h('label', { class: 'workbench-check' }, requiresApproval, h('span', {}, t("需要用户批准后才能开工"))),
      h('label', { class: 'workbench-check' }, mergeRequired, h('span', {}, t("需要合并"))),
      h('p', { class: 'muted' }, t("可多选；未加载的前置任务会保留。")), h('label', {}, t("前置任务"), deps),
      depPager.more, depPager.error,
      h('label', {}, t("执行所需角色"), executeRoles), h('label', {}, t("验收所需角色"), reviewRoles)], async () => {
      if (files.problem()) throw new Error(files.problem());
      const fields = { title: title.value, scope: scope.value, acceptance: acceptance.value, priority: priority.value,
        labels: labels.value(),
        reviewer: reviewerOf(reviewer.value),
        dependencyIds: selected(deps), executeRoleIds: selected(executeRoles), reviewRoleIds: selected(reviewRoles),
        requiresApproval: requiresApproval.checked, mergeRequired: mergeRequired.checked, fileIds: files.ids() };
      if (!task && batch.value) {
        const { reviewer: _reviewer, ...rest } = fields;   // the Hub gives it the batch reviewer
        return command({ action: 'task.create', ...rest, mergeRequired: true, batchId: batch.value, memberId: executor.value || null });
      }
      if (!task) return command({ action: 'task.create', ...fields, memberId: executor.value || null });
      const changes = taskEditChanges(task, fields);
      if (Object.keys(changes).length) await command({ action: 'task.edit', taskId: task.id, expectedRevision: task.revision, ...changes });
    }, files.lock);
    modal.addEventListener('paste', files.paste);
    depPager.start(modal);
  }

  function assign(task) {
    const select = h('select', {}, h('option', { value: '' }, t("不指定")),
      getMembers(view.clusterId).map((member) => h('option', { value: member.id }, member.name)));
    select.value = task.assignedMemberId ?? '';
    formDialog(t("分配执行者"), [h('p', { class: 'muted' }, t("分配后由该成员直接开工。")), h('label', {}, t("执行者"), select)],
      () => command({ action: 'task.assign', taskId: task.id, expectedRevision: task.revision, memberId: select.value || null }));
  }

  function review(task, verdict) {
    const reason = h('textarea', verdict === 'reject' ? { required: true } : {});
    formDialog(verdict === 'approve' ? t("验收通过") : t("退回结果"), [h('label', {}, t("说明"), reason)], () => command({
      action: 'task.review', taskId: task.id, expectedRevision: task.revision, submissionId: task.latestSubmissionId,
      verdict, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
    }));
  }

  function approveTask(task, verdict) {
    const reason = h('textarea', verdict === 'reject' ? { required: true } : {});
    formDialog(verdict === 'approve' ? t("批准任务") : t("退回任务"), [h('label', {}, verdict === 'reject' ? t("退回意见（必填）") : t("批准说明（可选）"), reason)],
      () => {
        const value = reason.value.trim();
        if (verdict === 'reject' && !value) throw new Error(t("请填写退回意见"));
        return command({ action: 'task.approve', taskId: task.id, expectedRevision: task.revision, verdict,
          ...(value ? { reason: value } : {}) });
      });
  }

  function recordMerge(task) {
    const commitSha = h('input', { required: true, pattern: '[0-9a-fA-F]{7,40}', minlength: '7', maxlength: '40',
      placeholder: t("合并提交号（7～40 位十六进制）") });
    const reason = h('textarea');
    formDialog(t("记录合并"), [h('p', { class: 'muted' }, t("只在 ship 已经合并却没能上报时使用；Hub 会用 git 核实这个提交。")),
      h('label', {}, t("合并提交号"), commitSha), h('label', {}, t("说明（可选）"), reason)],
      () => command({ action: 'task.merge', taskId: task.id, expectedRevision: task.revision, commitSha: commitSha.value.trim(),
        ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) }));
  }

  function markTask(task, detail, merged) {
    const commitSha = merged ? h('input', { pattern: '[0-9a-fA-F]{7,40}', minlength: '7', maxlength: '40',
      placeholder: t("7～40 位十六进制") }) : null;
    const reason = h('textarea');
    const needsStop = task.currentAssignmentId && (['working', 'review'].includes(task.status)
      || detail.assignments?.some((assignment) => assignment.id === task.currentAssignmentId && assignment.startedAt));
    const stopped = needsStop ? h('input', { type: 'checkbox', required: true }) : null;
    formDialog(merged ? t("标记为已合并") : t("标记为已完成"), [
      h('p', { class: 'muted' }, merged ? t("此操作登记任务状态。代码合并请在 Git 中完成。") : t("任务历史会记下这次手动标记。")),
      task.dependenciesReady === false ? h('p', { class: 'muted' }, t("前置任务尚未就绪。就绪后请重新标记。")) : null,
      !merged && task.mergeRequired ? h('p', { class: 'muted' }, t("需要合并的任务在标记为已合并后才能放行下游。")) : null,
      commitSha ? h('label', {}, t("合并提交号（可选）"), commitSha) : null,
      h('label', {}, t("说明（可选）"), reason),
      stopped ? h('label', { class: 'workbench-check' }, stopped, t("我已确认原执行停止，可以结束当前派工")) : null,
    ], () => {
      const note = reason.value.trim();
      const sha = commitSha?.value.trim();
      return command({ action: merged ? 'task.mark_merged' : 'task.mark_completed', taskId: task.id, expectedRevision: task.revision,
        ...(note ? { reason: note } : {}), ...(sha ? { commitSha: sha } : {}), ...(stopped ? { confirmStopped: stopped.checked } : {}) });
    });
  }

  function editGitBranch(task) {
    const cid = view.clusterId;
    const url = path('/task-repositories');
    const repoStatus = h('p', { class: 'muted', role: 'status' }, t("正在读取本地仓库…"));
    const branchStatus = h('p', { class: 'muted', role: 'status', hidden: true });
    const repository = h('input', { required: true,
      value: task.gitBranch?.repositoryPath ?? '', placeholder: t("选择仓库或填写本地绝对路径"), oninput: clearBranches, onchange: loadBranches });
    const branch = h('input', { required: true, value: task.gitBranch?.branch ?? '', placeholder: t("选择本地分支或填写分支名") });
    // Our own list, not <datalist>: Chromium's datalist popup cannot scroll a long branch list inside the dialog.
    const repositories = combobox(repository, { noun: t("仓库"), label: t("本地仓库候选") });
    const branches = combobox(branch, { noun: t("分支"), label: t("本地分支候选") });
    const field = (caption, input, combo) => h('div', { class: 'wb-combo-field' },
      h('label', { for: input.getAttribute('id') }, caption), combo.el);
    const modal = formDialog(task.gitBranch ? t("更改 Git 分支") : t("关联 Git 分支"), [
      field(t("本地仓库或 worktree 路径"), repository, repositories), repoStatus,
      field(t("Git 分支"), branch, branches), branchStatus,
    ], () => {
      const repositoryPath = repository.value.trim();
      const name = branch.value.trim();
      if (!repositoryPath || !name) throw new Error(t("请填写仓库路径和分支名。"));
      return command({ action: 'task.set_git_branch', taskId: task.id, expectedRevision: task.revision,
        gitBranch: { repositoryPath, branch: name } }, cid);
    }, (busy) => {
      repository.disabled = branch.disabled = busy;
      if (busy) { repositories.close(); branches.close(); }
    });
    modal.addEventListener('close', () => { repositories.destroy(); branches.destroy(); });
    const isOpen = () => modal.open && view.clusterId === cid;

    function clearBranches() {
      branchStatus.hidden = true;
      return branches.load();
    }

    async function loadBranches() {
      const request = clearBranches();
      const repositoryPath = repository.value.trim();
      if (!repositoryPath) return;
      const current = () => isOpen() && branches.isCurrent(request) && repository.value.trim() === repositoryPath;
      branchStatus.textContent = t("正在读取本地分支…");
      branchStatus.hidden = false;
      try {
        const { branches: names } = await api('GET', `${url}?path=${encodeURIComponent(repositoryPath)}`);
        if (!current()) return;
        branches.loaded(request, names);
        branchStatus.textContent = t("暂无本地分支，可先填计划中的分支名。");
        branchStatus.hidden = names.length > 0;
      } catch (e) {
        if (current()) branchStatus.textContent = t("读取本地分支失败：{error}。也可直接填分支名。", { error: e.message });
      }
    }

    const repositoryLoad = repositories.load();
    void api('GET', url).then(({ repositories: items }) => {
      if (!isOpen()) return;
      repositories.loaded(repositoryLoad, items.map(({ path, label }) => ({ value: path, label })));
      repoStatus.textContent = t("暂无仓库候选，可直接填本地路径。");
      repoStatus.hidden = items.length > 0;
    }).catch((e) => {
      if (isOpen()) repoStatus.textContent = t("读取仓库候选失败：{error}。仍可直接填路径。", { error: e.message });
    });
    if (task.gitBranch) void loadBranches();
  }

  /** Delete a cancelled task for good after the page-level confirmation; only the user's page sends task.delete. */
  async function deleteTask(task) {
    const linked = Number.isSafeInteger(view.detail?.linkedMessageCount) ? view.detail.linkedMessageCount : 0;
    const confirmed = await confirmDialog({ title: t("永久删除任务"), message: taskDeleteWarning(task, linked),
      confirmText: t("永久删除"), danger: true });
    if (!confirmed) return;
    try {
      await command({ action: 'task.delete', taskId: task.id, expectedRevision: task.revision });
    } catch (e) {
      view.error = e.message;
      render();
      return;
    }
    // The task row is gone, so drop the selected task and reload the list without it.
    view.taskId = null; view.detail = null; view.context = null; view.error = null;
    await refresh();
    render();
  }

  function lifecycle(task, action) {
    const captions = { 'task.cancel': t("取消任务"), 'task.reopen': t("重开任务"), 'task.release': t("释放派工"), 'task.handoff': t("安排接手") };
    const cancel = action === 'task.cancel';
    const reasonCaption = h('span', {}, cancel ? t("说明（可选）") : t("原因"));
    const reason = h('textarea', { required: !cancel });
    const target = h('select', { required: true }, h('option', { value: '' }, t("选择成员")),
      getMembers(view.clusterId).map((member) => h('option', { value: member.id }, member.name)));
    const stopped = h('input', { type: 'checkbox' });
    const needsStop = Boolean(task.currentAssignmentId && ['working', 'review'].includes(task.status));
    // Cancel: why, and for 重复 / 被取代 a searchable task picker (including closed tasks); only "其他" forces prose.
    const kind = h('select', { onchange: () => syncCancelFields() },
      Object.entries(CLOSE_REASONS).map(([value, label]) => h('option', { value }, t(label))));
    const relatedCaption = h('span');
    let modal = null;
    const relatedPicker = cancel ? createRelatedTaskPicker({
      clusterId: view.clusterId,
      excludeId: task.id,
      load: async (cid, query) => {
        const page = await api('GET', `/api/clusters/${encodeURIComponent(cid)}/task-refs?includeClosed=1${query ? `&q=${encodeURIComponent(query)}` : ''}`);
        if (!modal?.open || view.clusterId !== cid) return [];
        return page.tasks;
      },
    }) : null;
    const relatedField = relatedPicker ? h('div', { class: 'wb-close-related', hidden: true }, h('label', {}, relatedCaption, relatedPicker.el)) : null;
    function syncCancelFields() {
      if (!relatedPicker) return;
      const phrase = relatedReason(kind.value);
      relatedField.hidden = !phrase;
      const needReason = cancelReasonRequired(kind.value);
      reason.required = needReason;
      reasonCaption.textContent = needReason ? t("说明") : t("说明（可选）");
      if (!phrase) return;
      relatedCaption.textContent = phrase.pick;
      relatedPicker.start();
    }
    if (cancel) syncCancelFields();
    modal = formDialog(captions[action], [cancel ? h('label', {}, t("原因"), kind) : null, relatedField,
      h('label', {}, reasonCaption, reason),
      action === 'task.handoff' ? h('label', {}, t("新候选成员"), target) : null,
      needsStop ? h('label', { class: 'workbench-check' }, stopped, t("我已确认原执行停止")) : null,
      needsStop ? h('p', { class: 'muted' }, t("活动观察、离线和取消投递都不能证明原执行已停止。")) : null], () => {
      if (cancel && relatedReason(kind.value) && !relatedPicker.value()) throw new Error(t("请选择关联任务"));
      return command({
        action, taskId: task.id, expectedRevision: task.revision, ...(task.currentAssignmentId ? { assignmentId: task.currentAssignmentId } : {}),
        reason: reason.value.trim(), ...(action === 'task.handoff' ? { memberId: target.value } : {}), ...(needsStop ? { confirmStopped: stopped.checked } : {}),
        ...(cancel ? closeReasonFields(kind.value, relatedPicker.value()) : {}),
      });
    });
    if (relatedPicker) modal.addEventListener('close', () => relatedPicker.dispose());
  }

  /**
   * 交给验收者: the reviewer becomes the executor, and the user says who reviews afterwards. Self review asks again
   * (confirmDialog), since no independent review is left. The Hub checks everything again; its refusal stays in the dialog.
   */
  function takeoverTask(task, detail) {
    const reviewerName = nameOf(task.reviewer.memberId);
    // Members who could review next: not the reviewer taking over, not anyone who has worked on the task, not the
    // enabled coordinator (it cannot review).
    const policy = view.workspace?.coordinator;
    const worked = new Set([task.reviewer.memberId, task.assignedMemberId, ...(detail?.assignments ?? []).map((item) => item.memberId),
      ...(policy?.enabled ? [policy.memberId] : [])]);
    const others = getMembers(view.clusterId).filter((member) => !worked.has(member.id) && !member.hiddenAt);
    const memberSelect = h('select', { 'aria-label': t("指定验收的成员"), disabled: true }, h('option', { value: '' }, t("选择成员")),
      others.map((member) => h('option', { value: member.id }, member.name)));
    const radios = [];
    const option = (value, caption, hint) => {
      const input = h('input', { type: 'radio', name: 'wb-takeover-mode', value, checked: value === 'user',
        onchange: () => { memberSelect.disabled = value !== 'member'; memberSelect.required = value === 'member'; } });
      radios.push([value, input]);
      return h('label', { class: 'workbench-check wb-takeover-option' }, input,
        h('span', { class: 'wb-check-text' }, h('b', {}, caption), h('span', { class: 'wb-role-description' }, hint)));
    };
    const mode = () => radios.find(([, input]) => input.checked)?.[0] ?? 'user';
    formDialog(t("交给验收者"), [
      h('p', { class: 'muted' }, t("{reviewer} 将成为执行者；原执行者的派工结束{stopNotice}", { reviewer: reviewerName, stopNotice: task.status === 'working' ? t("，如果还在做会收到停手通知") : '' })
        + t("{submissionNotice}。之前的提交和验收记录都保留，验收轮次接着数。", { submissionNotice: task.status === 'review' ? t("，待验收的提交标为已取代") : '' })),
      h('fieldset', { class: 'wb-takeover-modes' }, h('legend', {}, t("之后谁来验收")),
        option('user', t("用户验收（默认）"), t("由你在网页上验收。")),
        option('member', t("指定成员验收"), t("由一位没参与过这个任务的成员验收。")),
        h('label', { class: 'wb-takeover-member' }, t("成员"), memberSelect),
        option('self', t("自查"), t("{reviewerName} 自己检查后直接完成，不再有独立验收。", { reviewerName }))),
    ], async () => {
      const body = takeoverCommand(task, mode(), memberSelect.value);
      if (!body) throw new Error(t("请选择验收的成员"));
      if (mode() === 'self') {
        const ok = await confirmDialog({ title: t("改为自查？"), message: t("{reviewerName} 接手后自己检查并直接完成，不再有独立验收。这次改动会记在任务上，并在群里发一条提醒。", { reviewerName }),
          confirmText: t("改为自查"), danger: true });
        if (!ok) throw new Error(t("没有改为自查，任务未改动"));
      }
      await command(body);
    }, undefined, t("交给验收者"));
  }

  function attention(task, item = null) {
    const question = h('textarea', { required: true });
    const kind = h('input', { value: 'question', required: true });
    const target = h('select', {}, h('option', { value: '' }, t("未指定")),
      getMembers(view.clusterId).map((member) => h('option', { value: member.id }, member.name)));
    formDialog(item ? t("解决待处理事项") : t("新增待处理事项"), item
      ? [h('p', {}, item.question), h('label', {}, t("解决说明与证据"), question)]
      : [h('label', {}, t("类型"), kind), h('label', {}, t("问题或受阻原因"), question), h('label', {}, t("需要谁处理"), target)],
    () => command(item ? { action: 'task.resolve_attention', taskId: task.id, expectedRevision: task.revision,
      attentionId: item.id, resolution: question.value.trim() }
      : { action: 'task.attention', taskId: task.id, expectedRevision: task.revision, kind: kind.value.trim(), question: question.value.trim(), targetMemberId: target.value || null }));
  }

  /** The detail's action row: one primary for the task's state, its negative, two everyday actions and the 更多 menu. */
  function detailActions(task, detail) {
    const plan = taskActionPlan(task);
    const actions = {
      approve: [t("批准任务"), () => approveTask(task, 'approve')], rejectTask: [t("退回任务"), () => approveTask(task, 'reject')],
      accept: [t("验收通过"), () => review(task, 'approve')], rejectResult: [t("退回结果"), () => review(task, 'reject')],
      merge: [t("记录合并"), () => recordMerge(task)], assign: [t("分配执行者"), () => assign(task)],
      markCompleted: [t("标记为已完成"), () => markTask(task, detail, false)], markMerged: [t("标记为已合并"), () => markTask(task, detail, true)],
      gitBranch: [task.gitBranch ? t("更改 Git 分支") : t("关联 Git 分支"), () => editGitBranch(task)],
      clearGitBranch: [t("解除 Git 分支关联"), () => command({ action: 'task.set_git_branch', taskId: task.id, expectedRevision: task.revision,
        gitBranch: null }).catch((e) => noticeDialog(e.message, t("解除 Git 分支关联失败")))],
      edit: [t("编辑任务"), () => editTask(task, detail.attachments ?? [])], reviewer: [t("更换验收人"), () => changeReviewer(task)],
      release: [t("释放派工"), () => lifecycle(task, 'task.release')], handoff: [t("安排接手"), () => lifecycle(task, 'task.handoff')],
      takeover: [t("交给验收者"), () => takeoverTask(task, detail)],
      public: [t("公共资料"), () => { view.collectionMode = 'public'; chooseTab('collections'); loadPublic(task.id); }],
      reopen: [t("重开任务"), () => lifecycle(task, 'task.reopen')], cancel: [t("取消任务"), () => lifecycle(task, 'task.cancel')],
      delete: [t("永久删除"), () => deleteTask(task)],
    };
    const mergeBlocked = plan.primary === 'merge' && task.completionValid === false;
    const button = (key, className) => h('button', { type: 'button', class: className, 'data-wb-focus': `action:${key}`,
      disabled: key === 'merge' && mergeBlocked, title: key === 'merge' && mergeBlocked ? t("结果已失效，请先重新验收") : null,
      onclick: actions[key][1] }, actions[key][0]);
    const danger = (key) => key === 'cancel' || key === 'delete';
    const menu = h('div', { class: 'wb-menu', id: 'wb-more-menu', role: 'menu', 'aria-label': t("更多操作"), hidden: true },
      plan.more.flatMap((key, index) => [index > 0 && danger(key) ? h('div', { class: 'wb-menu-sep', role: 'separator' }) : null,
        h('button', { type: 'button', role: 'menuitem', class: danger(key) ? 'danger' : null, onclick: actions[key][1] }, actions[key][0])]));
    const more = h('button', { type: 'button', class: 'wb-icon-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'aria-controls': 'wb-more-menu', 'data-wb-focus': 'more', title: t("更多操作") }, icon('more'), h('span', {}, t("更多")));
    // A redraw that waited while the menu was open runs once it closes (after the press that closed it is released).
    attachMenu(more, menu, () => redraws.settle());
    return h('div', { class: 'workbench-actions wb-detail-actions' },
      plan.primary ? h('div', { class: 'wb-actions-main' }, button(plan.primary, 'primary'), plan.negative ? button(plan.negative) : null) : null,
      h('div', { class: 'wb-actions-side' },
        h('button', { type: 'button', class: 'wb-icon-button', 'data-wb-focus': 'action:comment', onclick: () => sendComment(task) },
          icon('comment'), h('span', {}, t("任务留言"))),
        h('button', { type: 'button', class: 'wb-icon-button', 'data-wb-focus': 'action:attention', onclick: () => attention(task) },
          icon('help'), h('span', {}, t("提出问题"))),
        h('div', { class: 'wb-more' }, more, menu)));
  }

  /** A record section folded by default with its count; the ones the user opened stay open across redraws. */
  function historySection(key, title, count, ...body) {
    const id = `history:${key}`;
    return h('section', {}, h('details', { class: 'wb-history', open: opened.has(id),
      ontoggle: (event) => { if (event.target.open) opened.add(id); else opened.delete(id); } },
    h('summary', { 'data-wb-focus': id }, h('span', {}, title), h('span', { class: 'wb-count' }, count)), ...body));
  }

  function detailView(detail) {
    if (!detail?.task) return h('div', { class: 'workbench-detail wb-task-detail' },
      view.taskId ? h('p', { class: 'muted' }, t("正在加载任务详情…")) : emptyState(t("选择一个任务查看详情。")));
    const task = detail.task;
    if (openedFor !== task.id) { opened.clear(); openedFor = task.id; }
    const shown = new Set(recordSections(detail));
    const records = (items) => `${items?.length ?? 0}${detail.nextCursor ? '+' : ''}`;
    const markdown = (key, value) => value ? longText(key, value) : h('p', { class: 'muted' }, t("未填写"));
    const linked = linkedFiles(view.context?.messages, [...(detail.attachments ?? []), ...(detail.submissions ?? []).flatMap((item) => submissionFiles(item, messageFiles))]);
    return h('div', { class: 'workbench-detail wb-task-detail', 'data-task-id': task.id },
      h('div', { class: 'wb-detail-head' }, h('h3', {}, ...taskTitleNodes(task)),
        h('div', { class: 'wb-detail-badges' }, statusChip(task), mergeBadge(task), priorityChip(task), batchChip(task), takeoverChip(task), dependencyChip(task), stalledChip(task))),
      closeReasonLine(task),
      h('p', { class: 'workbench-meta' }, t("版本 {revision}", { revision: task.revision }), ...(() => {
        // Only a complete first page can name who finished the task; otherwise the 50th assignment would lie.
        const owner = taskOwner(task, detail.assignments ?? [], detail.nextCursor === null);
        if (owner) return [t(" · 负责人 "), memberChip(owner)];
        return CLOSED_STATUSES.includes(task.status) ? [] : [t(" · 尚未分配")];
      })()),
      detailActions(task, detail),
      CLOSED_STATUSES.includes(task.status) ? null : h('p', { class: 'muted wb-detail-hint' }, t("任务的开工和结果提交由执行者在自己的会话中完成。")),
      h('section', {}, h('h4', {}, t("目标与范围")), markdown('scope', task.scope), attachmentList(`task:${task.id}`, detail.attachments ?? [])),
      h('section', {}, h('h4', {}, t("验收条件")), markdown('acceptance', task.acceptance)),
      h('section', {}, h('h4', {}, t("安排")),
        h('div', { class: 'wb-rows' },
          h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("建单人")), creatorLink(task.createdBy)),
          h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("执行者")),
            task.assignedMemberId ? memberChip(task.assignedMemberId) : h('span', { class: 'muted' }, t("未指定")),
            h('span', { class: 'wb-row-key' }, t("验收")),
            task.reviewer?.kind === 'member' ? memberChip(task.reviewer.memberId)
              : task.reviewer?.kind === 'self' ? h('span', { class: 'wb-task-reviewer' }, t("自查")) : h('span', { class: 'muted' }, t("用户")),
            ...hiddenChips(task)),
          task.batchId ? (() => {
            const batch = batchOf(task.batchId);
            return h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t('验收批次')),
              h('span', {}, batch ? `B${batch.number} · ${batch.title}` : t('已取消或未加载')),
              batch ? h('span', { class: 'wb-count' }, batchProgress(batch).state) : null,
              batch ? h('button', { type: 'button', class: 'small', onclick: () => batchDetail(batch) }, t('批次详情')) : null);
          })() : null,
          task.takeover ? h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("验收方式")),
            h('span', {}, reviewModeText(task.reviewer, nameOf)), takeoverChip(task)) : null,
          h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("执行角色")), roleList(task.executeRoleIds),
            h('span', { class: 'wb-row-key' }, t("验收角色")), roleList(task.reviewRoleIds)),
          task.gitBranch ? h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("Git 分支")),
            h('code', { class: 'wb-git-branch-value' }, task.gitBranch.branch),
            task.gitBranch.automatic ? h('span', { class: 'wb-mode wb-git-auto', title: t('提交时按提交号自动关联；手动设置后不再自动更改') }, t('自动')) : null,
            h('span', { class: 'muted wb-git-branch-value' }, task.gitBranch.repositoryPath)) : null,
          h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("前置")),
            detail.dependencies?.length ? detail.dependencies.map((dependency) => h('span', { class: 'wb-dep' }, ...taskTitleNodes(dependency), statusChip(dependency), mergeBadge(dependency)))
              : h('span', { class: 'muted' }, t("无")),
            task.dependenciesReady === false ? h('span', { class: 'wb-warn' }, t("未就绪")) : null),
          h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t("标签")),
            task.labels?.length ? task.labels.map((label) => labelChip(label, 'wb-task-label-detail')) : h('span', { class: 'muted' }, t("无")),
            taskMarks(task)),
          // Members waiting for this task to end (docs/collaboration.md「关注任务」); only the user's detail has them.
          detail.watchers?.length ? h('div', { class: 'wb-row', title: t("这些成员在任务合并、完成（不需要合并时）或取消时会收到一次通知") },
            h('span', { class: 'wb-row-key' }, t("关注")),
            detail.watchers.map((watch) => h('span', { class: 'wb-watch' }, memberChip(watch.memberId),
              watch.note ? h('span', { class: 'wb-watch-note' }, watch.note) : null))) : null)),
      shown.has('attentions') ? h('section', {}, h('h4', {}, t("待处理事项")), detail.attentions.map((item) => h('div', { class: 'wb-attention' },
        h('p', {}, item.question),
        item.resolvedAt ? h('p', { class: 'workbench-meta' }, h('span', { class: 'wb-verdict wb-verdict-approve' }, t("已解决")), ` ${item.resolution ?? ''}`)
          : h('button', { type: 'button', class: 'small', onclick: () => attention(task, item) }, t("标记解决"))))) : null,
      shown.has('submissions') ? h('section', {}, h('h4', {}, t("结果提交")), detail.submissions.map((item) => submissionView(item, task))) : null,
      shown.has('reviews') ? h('section', {}, h('h4', {}, t("验收记录")), detail.reviews.map((item) => reviewView(item))) : null,
      shown.has('takeovers') ? h('section', {}, h('h4', {}, t("验收者接手记录")), detail.takeovers.map(takeoverView)) : null,
      linked.length || view.context?.messagesNextCursor ? h('section', {}, h('h4', {}, t("关联消息的图片和附件")), attachmentList(`linked:${task.id}`, linked),
        view.context?.messagesNextCursor ? h('p', { class: 'muted' }, t("还有更多关联消息，可在“公共资料”里加载。")) : null) : null,
      shown.has('approvals') ? historySection('approvals', t("批准记录"), records(detail.approvals), detail.approvals.map(approvalView)) : null,
      shown.has('merges') ? historySection('merges', t("合并记录"), records(detail.merges),
        task.mergedCommitSha ? h('p', {}, t("当前合并提交 "), h('code', {}, task.mergedCommitSha)) : null, (detail.merges ?? []).map(mergeView)) : null,
      shown.has('assignments') ? historySection('assignments', t("派工历史"), records(detail.assignments), detail.assignments.map((item) => h('p', {},
        memberChip(item.memberId), t(" · 开始 {time}{end}", { time: item.startedAt ?? t("未开始"), end: item.endedAt ? t(" · 结束 {time} {reason}", { time: item.endedAt, reason: item.endReason ?? '' }) : '' })))) : null,
      detail.nextCursor ? h('button', { type: 'button', class: 'small', onclick: () => moreDetail('detail', 'records') }, t("加载更多派工与结果")) : null,
      historySection('events', t("事件历史"), `${detail.events?.length ?? 0}${detail.eventsNextCursor ? '+' : ''}`, eventRows(detail.events, task.id),
        detail.eventsNextCursor ? h('button', { type: 'button', class: 'small', onclick: () => moreDetail('detail', 'events') }, t("加载更多事件")) : null));
  }

  /** The task tab: one collapsible section per status family, in TASK_GROUPS order. */
  function taskGroupSections(tasks) {
    const collapsed = collapsedTaskGroups(view.clusterId);
    return taskGroups(tasks).map((group) => {
      const isCollapsed = collapsed.has(group.key);
      const bodyId = `wb-group-${group.key}-${view.clusterId}`;
      return h('section', { class: `workbench-group wb-group-${group.key}` },
        h('button', { type: 'button', class: 'workbench-group-head', 'aria-expanded': String(!isCollapsed), 'aria-controls': bodyId,
          onclick: () => { toggleTaskGroup(view.clusterId, group.key); render(); } },
        icon('chevron-down', 'wb-group-caret'),
        h('span', { class: 'wb-group-name' }, group.title),
        h('span', { class: 'wb-group-count' }, String(group.tasks.length))),
        h('div', { class: 'workbench-list', id: bodyId, hidden: isCollapsed }, group.tasks.map(taskCard)));
    });
  }

  /** Review batches above the status groups: a head with the progress, then the batch's loaded tasks in dependency order. */
  function batchSections(groups) {
    return groups.map(({ batch, tasks }) => {
      const key = `batch-${batch.id}`;
      const isCollapsed = collapsedBatches.has(batch.id);
      const bodyId = `wb-group-${key}`;
      const progress = batchProgress(batch);
      return h('section', { class: `workbench-group wb-group-batch wb-batch-${progress.tone}`, 'data-batch-id': batch.id },
        h('button', { type: 'button', class: 'workbench-group-head', 'aria-expanded': String(!isCollapsed), 'aria-controls': bodyId,
          onclick: () => { if (collapsedBatches.has(batch.id)) collapsedBatches.delete(batch.id); else collapsedBatches.add(batch.id); render(); } },
        icon('chevron-down', 'wb-group-caret'),
        h('span', { class: 'wb-group-name' }, t('批次 B{number} · {title}', batch)),
        h('span', { class: 'wb-group-count' }, String(batch.total))),
        h('div', { class: 'workbench-list', id: bodyId, hidden: isCollapsed },
          h('div', { class: 'wb-batch-progress' },
            h('span', { class: 'wb-count' }, progress.submitted), h('span', { class: 'wb-count' }, progress.approved),
            h('span', { class: progress.tone === 'failed' ? 'wb-warn' : progress.tone === 'open' ? 'wb-count' : 'wb-mode' }, progress.state),
            h('span', { class: 'wb-task-reviewer' }, t('验收'), batch.reviewer?.kind === 'member' ? memberChip(batch.reviewer.memberId) : t('用户')),
            h('button', { type: 'button', class: 'small', onclick: () => batchDetail(batch) }, t('批次详情'))),
          tasks.length ? tasks.map(taskCard) : emptyState(t('批次里还没有任务：点击“新建任务”，在“验收批次”中选择这个批次。'), { compact: true })));
    });
  }

  /** One batch: its tasks with their state and commit, the reviewer, and where the batch ship stands. */
  function batchDetail(batch) {
    const progress = batchProgress(batch);
    const rows = (batch.tasks ?? []).map((item) => h('div', { class: 'wb-row' },
      h('span', { class: 'wb-task-num' }, `#${item.number}`), h('span', {}, item.title),
      h('span', { class: `wb-status wb-status-${item.status}` }, t(STATUS[item.status] ?? item.status)),
      h('span', { class: item.state === 'missing' ? 'wb-count' : 'wb-mode' }, t(BATCH_STATE[item.state] ?? item.state)),
      item.commitSha ? h('code', {}, item.commitSha.slice(0, 7)) : null, item.branch ? h('code', {}, item.branch) : null));
    const ship = batch.merged ? t('已一次合并整批。')
      : batch.allApproved ? t('全部验收通过：拿到命令的成员用批次 ship 一次合并整批，检查只跑一遍。')
        : batch.shipFailure ? t('上次批次 ship 失败（{reason}），相关任务已退回执行者。', { reason: batch.shipFailure.kind === 'conflict' ? t('合并冲突') : t('合并前检查未通过') })
          : t('全部验收通过后才能合并；单个任务不能单独 ship。');
    const cancel = h('button', { type: 'button', class: 'small danger', hidden: batch.merged, onclick: () => { dialog.close(); cancelBatch(batch); } }, t('取消批次'));
    const close = h('button', { type: 'button', class: 'primary', onclick: () => dialog.close() }, t('关闭'));
    const dialog = h('dialog', { class: 'wb-batch-dialog', 'aria-label': t('批次 B{number}', batch) }, h('div', { class: 'workbench-form' },
      h('h2', {}, t('批次 B{number} · {title}', batch)),
      h('div', { class: 'wb-batch-progress' }, h('span', { class: 'wb-count' }, progress.submitted), h('span', { class: 'wb-count' }, progress.approved),
        h('span', { class: progress.tone === 'failed' ? 'wb-warn' : progress.tone === 'open' ? 'wb-count' : 'wb-mode' }, progress.state)),
      h('div', { class: 'wb-rows' }, h('div', { class: 'wb-row' }, h('span', { class: 'wb-row-key' }, t('验收')),
        batch.reviewer?.kind === 'member' ? memberChip(batch.reviewer.memberId) : h('span', {}, t('用户')),
        h('span', { class: 'wb-row-key' }, t('建单人')), creatorLink(batch.createdBy))),
      h('h4', {}, t('任务（按依赖顺序）')), rows.length ? h('div', { class: 'wb-rows' }, rows) : emptyState(t('批次里还没有任务。'), { compact: true }),
      batch.missing?.length ? h('p', { class: 'muted' }, t('还差：{items}', { items: batch.missing.join(t('、')) })) : null,
      h('h4', {}, t('合并')), h('p', { class: 'muted' }, ship),
      h('div', { class: 'row end' }, cancel, close)));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  function cancelBatch(batch) {
    const reason = h('textarea', { required: true });
    formDialog(t('取消批次 B{number}', batch), [h('p', { class: 'muted' }, t('批次里的任务回到普通任务，进度和记录都保留；之后各自验收、各自 ship。')),
      h('label', {}, t('原因'), reason)], () => command({ action: 'batch.cancel', batchId: batch.id, reason: reason.value }), () => {}, t('取消批次'));
  }

  function createBatch() {
    const title = h('input', { required: true });
    const reviewer = h('select', {}, h('option', { value: 'user' }, t('用户')),
      getMembers(view.clusterId).map((member) => h('option', { value: member.id }, member.name)));
    formDialog(t('新建验收批次'), [h('p', { class: 'muted' }, t('批次里的任务全部提交后，验收者只被叫醒一次，逐个给结论；全部通过后一次合并整批。批次内的下游在上游提交后就能开工。')),
      h('label', {}, t('标题'), title), h('label', {}, t('验收者'), reviewer)],
    () => command({ action: 'batch.create', title: title.value, reviewer: reviewerOf(reviewer.value) }), () => {}, t('创建'));
  }

  /** Note the attachments the loaded contexts carry and read the evidence messages they do not reach (paging), once each. */
  function rememberEvidenceFiles() {
    for (const context of [view.context, view.collectionContext]) for (const item of context?.messages ?? []) messageFiles.set(item.message.id, item.attachments ?? []);
    const cid = view.clusterId;
    const missing = [...new Set([view.detail, view.collectionDetail].flatMap((detail) => (detail?.submissions ?? []).flatMap((item) => item.evidenceMessageIds ?? [])))]
      .filter((id) => !messageFiles.has(id) && !evidenceLoading.has(id));
    if (!missing.length) return;
    for (const id of missing) evidenceLoading.add(id);
    void Promise.all(missing.map(async (id) => {
      // shortcut: a failed read shows no images for that message until the page reloads, so a refresh cannot retry forever; add a retry if reads ever fail in practice.
      try { messageFiles.set(id, (await api('GET', `/api/clusters/${encodeURIComponent(cid)}/messages/${encodeURIComponent(id)}`)).attachments ?? []); }
      catch { messageFiles.set(id, []); }
      evidenceLoading.delete(id);
    })).then(() => { if (cid === view.clusterId && dialog.open) render(); });
  }

  function render() {
    if (dialog.open && !redraws.request()) return;
    rememberEvidenceFiles();
    const active = content.contains(document.activeElement) && document.activeElement?.closest('.task-diff, .wb-filterbar') ? document.activeElement : null;
    const selection = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const focusKey = content.contains(document.activeElement) ? document.activeElement.closest('[data-wb-focus]')?.dataset.wbFocus : null;
    // The task list and the detail scroll on their own; a redraw keeps both places (the detail only for the same task).
    const before = { list: content.querySelector('.workbench-groups')?.scrollTop ?? 0,
      detail: content.querySelector('.wb-task-detail')?.scrollTop ?? 0, task: content.querySelector('.wb-task-detail')?.dataset.taskId,
      rail: content.querySelector('.wb-rp-rail')?.scrollLeft ?? 0 };
    // A plugin tab that is no longer offered (its grant ended, another cluster) falls back to the task list.
    const pluginTabs = !view.overview ? (pluginUi?.workbenchTabs(view.clusterId) ?? []) : [];
    if (view.tab.startsWith('plugin:') && !pluginTabs.some((tab) => `plugin:${tab.id}` === view.tab)) view.tab = 'tasks';
    const pluginTab = !view.overview && view.tab.startsWith('plugin:') ? view.tab.slice('plugin:'.length) : null;
    content.classList.toggle('wb-split', !view.overview && view.tab === 'tasks');
    content.classList.toggle('wb-plugin-tab', Boolean(pluginTab));
    pluginPane.hidden = !pluginTab;
    if (pluginTab) pluginUi.showWorkbench(view.clusterId, pluginTab, pluginPane); else pluginUi?.hideWorkbench();
    stalledTasks = view.clusterId && stalled ? stalled.taskMap(view.clusterId) : new Map();
    tabsObserver?.disconnect();
    if (view.overview) { title.textContent = t("全部任务"); content.replaceChildren(overviewView()); return; }
    title.textContent = t("任务工作台 · {group}", { group: getClusters().find((cluster) => cluster.id === view.clusterId)?.name ?? t("未知群") });
    const page = taskPageSpec();
    const loaded = view.workspaceKey === page.key && view.workspace;
    const tasks = quickViewTasks(loaded?.tasks ?? [], view.quickView);
    const tabs = [['tasks', t("任务")], ['graph', t("依赖图")], ['members', t("成员工作")], ['collections', t("资料库")], ['settings', coordinatorEnabled() ? t("角色与协调") : t("角色")],
      ...pluginTabs.map((tab) => [`plugin:${tab.id}`, tab.name, true])];
    const tabBar = h('nav', { class: 'workbench-tabs', 'aria-label': t('工作台视图') }, tabs.map(([id, label, external]) => h('button', {
      type: 'button', 'aria-current': String(view.tab === id), onclick: () => chooseTab(id), 'data-wb-plugin-tab': external ? id.slice('plugin:'.length) : null,
      title: external ? t('{label}（第三方插件）', { label }) : null, class: external ? 'wb-plugin-tab-button' : null,
    }, external ? [icon('layers', 'ico-xs'), h('span', { class: 'sr-only' }, t('第三方插件：'))] : null, label)));
    if (pluginTab) {
      content.replaceChildren(tabBar);
      content.style.setProperty('--wb-tabs-height', `${tabBar.offsetHeight}px`);
      tabsObserver?.observe(tabBar);
      return;
    }
    const loading = () => h('p', { class: 'muted' }, t("正在加载任务…"));
    const panels = {
      tasks: () => h('div', { class: 'workbench-tasks' },
        h('div', { class: 'workbench-groups' },
          !loaded ? loading() : (() => {
            const { groups, rest } = batchGroups(page.newest ? tasks : sortTasks(tasks, view.taskSort, view.taskFilters.q), loaded.batches);
            return groups.length || rest.length ? [...batchSections(groups), ...taskGroupSections(rest)]
              : emptyState(narrowed() ? t("没有符合筛选条件的任务。") : t("还没有任务，创建一个开始协作。"));
          })(),
          loaded?.nextCursor ? h('button', { type: 'button', class: 'small', onclick: moreTasks }, t("加载更多任务")) : null),
        detailView(view.detail)),
      graph: () => loaded ? graphView(tasks) : loading(),
      members: () => loaded ? membersView(tasks) : loading(),
      collections: () => loaded ? collectionsView() : loading(),
      settings: settingsView,
    };
    content.replaceChildren(...[tabBar, h('div', { class: 'workbench-bar' }, h('h3', { class: 'wb-panel-title' }, tabs.find(([id]) => id === view.tab)?.[1] ?? t("任务")),
      h('div', { class: 'workbench-actions' },
        view.tab === 'tasks' ? h('button', { type: 'button', onclick: () => createBatch() }, t('新建批次')) : null,
        h('button', { type: 'button', class: 'primary', onclick: () => editTask() }, t('新建任务')))),
    ['tasks', 'graph', 'members'].includes(view.tab) ? taskBar.sync(tasks) : null,
    ['tasks', 'graph', 'members'].includes(view.tab) ? stalledBanner(stalled?.forCluster(view.clusterId) ?? []) : null,
    view.error ? h('p', { class: 'form-error', role: 'alert' }, t("加载失败：{error}", { error: view.error })) : null,
    panels[view.tab]()].filter(Boolean));
    fitLongText();
    // The bar sticks under the tabs while the whole content scrolls; the tabs' height changes when they wrap, also when
    // the window is resized with the workbench open (tabsObserver).
    content.style.setProperty('--wb-tabs-height', `${tabBar.offsetHeight}px`);
    tabsObserver?.observe(tabBar);
    // The new rail starts at scrollLeft 0: put it back where it was, then make sure the current item shows.
    const rail = content.querySelector('.wb-rp-rail');
    if (rail) { rail.scrollLeft = before.rail; revealRailItem(view.settingsSection); }
    const list = content.querySelector('.workbench-groups');
    if (list) list.scrollTop = before.list;
    const detail = content.querySelector('.wb-task-detail');
    if (detail?.dataset.taskId && detail.dataset.taskId === before.task) detail.scrollTop = before.detail;
    if (active?.isConnected) {
      active.focus({ preventScroll: true });
      if (selection) active.setSelectionRange(...selection);
    } else if (focusKey) content.querySelector(`[data-wb-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  function open(clusterId, taskId) {
      view.overview = false;
      view.allRequest++;
      if (view.clusterId !== clusterId) {
        const { filters: taskFilters, sort: taskSort, quick: quickView } = restoredTaskView(clusterId);
        taskBar.reset();
        Object.assign(view, { clusterId, workspace: null, workspaceKey: null, taskId: null, detail: null, context: null,
          collectionTask: null, collectionContext: null, collectionDetail: null, publicFilters: {}, taskFilters, taskSort, quickView, collectionRequest: view.collectionRequest + 1 });
        for (const tab of collectionTabs) tab.reset?.();
        messageFiles.clear();
        attachmentEls.clear();
      }
      if (taskId !== undefined) Object.assign(view, { taskId, detail: null, context: null, tab: 'tasks' });
      view.error = null;
      view.loadingTasks = null;
      render();
      if (!dialog.open) dialog.showModal();
      if (view.tab === 'collections') collectionTabs.find((tab) => tab.id === view.collectionMode)?.load();
      refresh();
  }
  /** Re-reads only the open task's watchers: nothing else on the page depends on them. A response older than the shown
   *  watchers (see watchers.ticket) is dropped. */
  async function reloadWatchers(clusterId, taskId) {
    const ticket = ++watchers.ticket;
    try {
      const fresh = await api('GET', path(`/tasks/${encodeURIComponent(taskId)}`));
      if (ticket < watchers.shown || view.clusterId !== clusterId || view.detail?.task?.id !== taskId) return;
      watchers.shown = ticket;
      // In place: a history page in flight checks the detail by identity (moreDetail) and must still land.
      view.detail.watchers = fresh.watchers;
      render();
    } catch { /* the next refresh of the detail shows them */ }
  }

  return {
    open,
    /**
     * A watch or unwatch of `taskId` (no `taskId`: a member was removed): the open detail of that task, or for a removal the
     * open detail of the cluster whatever it shows now (a read in flight may already carry the removed member), re-reads its
     * watchers once. A change while the detail is still loading re-reads once the load lands. Never the task list or the
     * reference cache.
     */
    watchersChanged(clusterId, { taskId = null } = {}) {
      if (!dialog.open || view.overview || view.clusterId !== clusterId || view.tab !== 'tasks' || !view.taskId) return;
      if (taskId && taskId !== view.taskId) return;
      if (view.detail?.task?.id !== view.taskId) { watchers.afterLoad = view.taskId; return; }
      void reloadWatchers(clusterId, view.taskId);
    },
    openAll() { view.overview = true; view.allGroups = []; view.request++; render(); if (!dialog.open) dialog.showModal(); loadAll(); },
    changed(event) {
      // The library changed (from any cluster, MCP or the global route): the manager and this cluster's labels reload.
      if (isLibrarySignal(event)) { labelManager?.reload(); if (!view.overview) scheduleRefresh(); return; }
      if (view.overview && dialog.open) { scheduleRefresh(); return; }
      if (event.clusterId !== view.clusterId) return;
      scheduleRefresh();
      if (dialog.open && view.tab === 'collections') {
        if (view.collectionMode === 'public') { if (view.collectionTask) loadPublic(view.collectionTask); }
        else collectionTabs.find((tab) => tab.id === view.collectionMode)?.load();
      }
    },
    removed(clusterId) {
      if (view.overview) return;
      if (view.clusterId !== clusterId || !dialog.open) return;
      dialog.close();
      noticeDialog(t("该群聊已移入回收站，可恢复后继续使用。"), t("群聊已删除"));
    },
    clustersChanged() { if (view.overview && dialog.open) scheduleRefresh(); },
    /** The plugin UIs this cluster offers changed (pluginUi read them): the tab bar follows. */
    pluginTabsChanged(clusterId) { if (dialog.open && !view.overview && view.clusterId === clusterId) render(); },
    /** The visible stalled-member hints changed: redraw through the gate. */
    stalledChanged() { if (dialog.open) render(); },
    openTask: open,
    lookup,
    pickTasks,
    /** The answer of GET /api/plugins; null when it could not be read. */
    setPlugins(result, tabs) {
      pluginIds = result ? result.plugins.map((plugin) => plugin.id) : null;
      collectionTabs = tabs.map((createTab) => createTab({
        getClusterId: () => view.clusterId, getHistoryMembers, taskOptionsPager, itemCard, render, beginCollectionRequest,
        setError: (error) => { view.error = error; },
        taskTag: (id) => h('span', { class: `wb-tag wb-tone-${toneIndex(id)}` },
          h('span', { class: 'wb-role-dot', 'aria-hidden': 'true' }), taskName(id)),
      })).filter(Boolean);
    },
    /**
     * Full-trust plugins detached from the page (plugin-slots.js detachPluginSlots): their collection tabs leave the
     * workbench, the tab buttons included; an open one falls back to the public materials.
     */
    detachPlugins(ids) {
      collectionTabs = collectionTabs.filter((tab) => !ids.includes(tab.pluginId));
      if (view.collectionMode !== 'public' && !collectionTabs.some((tab) => tab.id === view.collectionMode)) {
        view.collectionMode = 'public';
        view.collectionRequest++;   // a late answer to the removed tab's load is no longer current
        if (dialog.open && view.tab === 'collections' && view.collectionTask) loadPublic(view.collectionTask);
      }
      if (dialog.open) render();
    },
    tasksEnabled,
    coordinatorEnabled,
    command,
    linkMessage(clusterId, message) {
      return pickTasks(clusterId, message.taskIds ?? [], async (_all, added, removed, reason) => {
        if (added.length || removed.length) await command({ action: 'message.link', messageId: message.id,
          taskIds: added, removeTaskIds: removed, ...(removed.length ? { reason } : {}) }, clusterId);
      });
    },
    refresh,
  };
}
