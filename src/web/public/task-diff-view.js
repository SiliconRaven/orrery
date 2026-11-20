import { t } from "./i18n.js";
// Shared, lazily loaded task-change view. The page supplies loading and optional name lookup.
import { h, icon } from './ui.js';
import { diffLines, diffList } from './task-diff.js';

const FIELDS = { title: '标题', scope: '范围', acceptance: '验收条件', priority: '优先级', labels: '标签',
  reviewer: '验收者', executeRoleIds: '执行角色', reviewRoleIds: '验收角色', dependencyIds: '前置任务', fileIds: '附件', gitBranch: 'Git 分支' };
const TEXT_FIELDS = new Set(['title', 'scope', 'acceptance']);
const LIST_FIELDS = { labels: null, executeRoleIds: 'role', reviewRoleIds: 'role', dependencyIds: 'task', fileIds: 'file' };
const PRIORITY = { low: '低', normal: '普通', high: '高' };

const raw = (value) => value == null ? t("未设置") : typeof value === 'string' ? value : JSON.stringify(value);
const textValue = (value) => value == null ? '' : String(value);

function name(resolve, kind, value) {
  const id = String(value);
  const resolved = resolve?.(kind, id);
  return typeof resolved === 'string' && resolved ? resolved : id;
}

function scalar(field, value, resolve) {
  if (value == null) return t("未设置");
  if (field === 'priority' && typeof value === 'string' && Object.hasOwn(PRIORITY, value)) return t(PRIORITY[value]);
  if (field === 'gitBranch' && typeof value.repositoryPath === 'string' && typeof value.branch === 'string') {
    const branch = t('{branch}（{path}）', { branch: value.branch, path: value.repositoryPath });
    return value.automatic === true ? t('{branch}，提交时自动关联', { branch }) : branch;
  }
  if (field === 'reviewer' && typeof value === 'object') {
    if (value.kind === 'user') return t("用户");
    if (value.kind === 'self') return t("自查");
    if (value.kind === 'member' && typeof value.memberId === 'string') return name(resolve, 'member', value.memberId);
  }
  return raw(value);
}

function textChange(change) {
  const before = textValue(change.before);
  const after = textValue(change.after);
  const diff = diffLines(before, after);
  if (!diff.exact) {
    const portion = change.truncated ? t("已保存片段") : t("全文");
    return [h('p', { class: 'task-diff-warning' }, t("内容过长，以下显示旧版和新版{portion}。", { portion })),
      h('p', { class: 'task-diff-remove' }, icon('minus', 'ico-xs'), t("旧版")), h('pre', { class: 'task-diff-before' }, before),
      h('p', { class: 'task-diff-add' }, icon('plus', 'ico-xs'), t("新版")), h('pre', { class: 'task-diff-after' }, after)];
  }
  // A sign icon and a word on changed lines; unchanged lines keep the same indent with an empty slot.
  return diff.rows.map((row) => h('div', { class: `task-diff-${row.kind}` },
    row.kind === 'remove' ? [icon('minus', 'ico-xs'), t("删除 ")] : row.kind === 'add' ? [icon('plus', 'ico-xs'), t("新增 ")] : h('span', { class: 'task-diff-slot' }),
    row.text));
}

function listChange(change, resolve) {
  const before = Array.isArray(change.before) ? change.before : [];
  const after = Array.isArray(change.after) ? change.after : [];
  const { removed, added } = diffList(before, after);
  const kind = LIST_FIELDS[change.field];
  const label = (item) => change.fileNames?.[item] ?? (kind ? name(resolve, kind, item) : String(item));
  if (!removed.length && !added.length) return [h('p', { class: 'task-diff-state' }, t("列表项没有增删，顺序可能已调整。"))];
  return [
    ...removed.map((item) => h('div', { class: 'task-diff-remove' }, t("去掉：{name}", { name: label(item) }))),
    ...added.map((item) => h('div', { class: 'task-diff-add' }, t("新增：{name}", { name: label(item) }))),
  ];
}

function changeView(change, resolve) {
  const field = typeof change?.field === 'string' ? change.field : '';
  const label = Object.hasOwn(FIELDS, field) ? t(FIELDS[field]) : (field ? t("字段 {field}", { field }) : t("未知字段"));
  let body;
  if (TEXT_FIELDS.has(field)) body = textChange(change);
  else if (Object.hasOwn(LIST_FIELDS, field)) body = listChange(change, resolve);
  else body = [h('p', {}, `${scalar(field, change?.before, resolve)} → ${scalar(field, change?.after, resolve)}`)];
  return h('section', { class: 'task-diff-field' }, h('h4', {}, label),
    change?.truncated ? h('p', { class: 'task-diff-warning' }, t("字段内容已截断，以下仅为已保存片段。")) : null, body);
}

// A native disclosure gives both event views keyboard activation, lazy loading, and a retry on failure.
function eventDetails({ label, subject, load, render, legacy = false }) {
  const content = h('div', { class: 'task-diff-content', 'aria-live': 'polite' });
  const details = h('details', { class: 'task-diff' }, h('summary', {}, label), content);
  let state = legacy ? 'legacy' : 'idle';
  if (legacy) content.replaceChildren(h('p', { class: 'task-diff-state' }, t("这条旧通知产生于改版前，没有保存历史差异。")));

  const run = async () => {
    if (state === 'loading' || state === 'ready' || state === 'legacy') return;
    state = 'loading';
    content.replaceChildren(h('p', { class: 'task-diff-state', role: 'status' }, t("正在加载{subject}…", { subject })));
    try {
      content.replaceChildren(...render(await load()));
      state = 'ready';
    } catch {
      state = 'error';
      content.replaceChildren(h('p', { class: 'task-diff-state', role: 'alert' }, t("加载{subject}失败。", { subject })),
        h('button', { type: 'button', class: 'task-diff-retry', onclick: run }, t("重试")));
    }
  };
  details.addEventListener('toggle', () => { if (details.open && (state === 'idle' || state === 'error')) void run(); });
  return details;
}

/** The caller supplies the event URL and may resolve IDs into names. */
export function createTaskDiffView({ load, legacy = false, resolve } = {}) {
  return eventDetails({ label: t("查看改动"), subject: t("任务变更"), load, legacy, render(event) {
    const changes = Array.isArray(event?.changes) ? event.changes : [];
    return changes.length ? changes.map((change) => changeView(change, resolve))
      : [h('p', { class: 'task-diff-state' }, t("该事件没有记录字段变更。"))];
  } });
}

export function createShipFailureView({ load }) {
  return eventDetails({ label: t("查看失败详情"), subject: t("诊断"), load, render(event) {
    const diagnostic = typeof event?.reason === 'string' ? event.reason.replace(/^(?:checks|conflict): /, '') : '';
    const detail = diagnostic.trim() && diagnostic !== 'no detail' ? h('pre', { class: 'task-diff-after' }, diagnostic) : null;
    const empty = h('p', { class: 'task-diff-state' }, t("该事件没有保存失败详情。"));
    // The Hub writes structured fields with the failure (conflict files, the failed check); old events only keep the text.
    const failure = event?.failure && typeof event.failure === 'object' && !Array.isArray(event.failure) ? event.failure : null;
    if (!failure) return [detail ?? empty];
    const kind = failure.kind === 'conflict' ? t("合并冲突") : t("合并前检查未通过");
    return [
      h('p', { class: 'task-diff-warning' }, t("失败类型：{kind}", { kind })),
      ...(typeof failure.failedCheck === 'string' && failure.failedCheck ? [h('p', {}, t("失败的检查：{name}", { name: failure.failedCheck }))] : []),
      ...(Array.isArray(failure.conflictFiles) && failure.conflictFiles.length
        ? [h('p', {}, t("冲突文件：")), h('pre', { class: 'task-diff-after' }, failure.conflictFiles.join('\n'))] : []),
      detail ?? empty,
    ];
  } });
}
