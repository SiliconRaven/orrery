import { t } from "./i18n.js";
// Pure task-notice helpers: callers render every returned string as text, not HTML.
const MAX_LCS_CELLS = 1_000_000;

/**
 * Compare lines without losing their contents. `exact` is false when the bounded fallback was used.
 * Filtering out additions or removals and joining the remaining texts with '\n' reconstructs either input.
 * @param {string} before
 * @param {string} after
 * @returns {{ rows: { kind: 'equal' | 'remove' | 'add', text: string }[], exact: boolean }}
 */
export function diffLines(before, after) {
  const left = before === '' ? [] : before.split('\n');
  const right = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd--; }
  /** @type {{ kind: 'equal' | 'remove' | 'add', text: string }[]} */
  const rows = left.slice(0, start).map((text) => ({ kind: 'equal', text }));
  const m = leftEnd - start;
  const n = rightEnd - start;
  const exact = m * n <= MAX_LCS_CELLS;
  if (!exact || m === 0 || n === 0) {
    // shortcut: over the work limit the middle is replaced wholesale; upgrade if exact huge diffs become necessary.
    for (let i = start; i < leftEnd; i++) rows.push({ kind: 'remove', text: left[i] });
    for (let j = start; j < rightEnd; j++) rows.push({ kind: 'add', text: right[j] });
  } else {
    const width = n + 1;
    const lcs = new Uint32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i * width + j] = left[start + i] === right[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (left[start + i] === right[start + j]) { rows.push({ kind: 'equal', text: left[start + i] }); i++; j++; }
      else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) rows.push({ kind: 'remove', text: left[start + i++] });
      else rows.push({ kind: 'add', text: right[start + j++] });
    }
    while (i < m) rows.push({ kind: 'remove', text: left[start + i++] });
    while (j < n) rows.push({ kind: 'add', text: right[start + j++] });
  }
  for (let i = leftEnd; i < left.length; i++) rows.push({ kind: 'equal', text: left[i] });
  return { rows, exact };
}

/** @template T @param {T[]} left @param {T[]} right @returns {T[]} */
function subtract(left, right) {
  const counts = new Map();
  for (const item of right) counts.set(item, (counts.get(item) ?? 0) + 1);
  return left.filter((item) => {
    const count = counts.get(item) ?? 0;
    if (!count) return true;
    counts.set(item, count - 1);
    return false;
  });
}

/** Preserve each side's order and duplicate counts; reordering alone is not an addition or removal. @template T @param {T[]} before @param {T[]} after */
export function diffList(before, after) {
  return { removed: subtract(before, after), added: subtract(after, before) };
}

const TASK_ACTION_LABELS = Object.freeze({
  'task.create': '创建任务', 'task.edit': '更新任务', 'task.assign': '分配执行者', 'task.nominate': '提名执行者', 'task.claim': '接取任务',
  'task.start': '开始任务', 'task.submit': '提交任务', 'task.review': '记录验收', 'task.release': '释放任务',
  'task.cancel': '取消任务', 'task.reopen': '重开任务', 'task.handoff': '交接任务', 'task.takeover': '验收者接手', 'task.attention': '提出待处理事项',
  'task.resolve_attention': '处理待处理事项', 'task.summary': '更新任务摘要',
  'task.shipped': '合并进 main', 'task.ship_failed': '合并失败',
});

const linkedSystemNotice = (message) => message?.from === 'system' && message.kind === 'system'
  && Number.isSafeInteger(message.collabEventId) && message.collabEventId > 0 && typeof message.body === 'string';

/** Recognize the Hub's current create/edit sentences without fetching unrelated task events. */
export function isTaskChangeNotice(message) {
  if (!linkedSystemNotice(message)) return false;
  const create = /^任务(?: #[0-9]+)?【[\s\S]*】已创建（建单人 [\p{L}\p{N}_.-]+），事件 ([0-9]+)。$/u.exec(message.body);
  const edit = /^任务(?: #[0-9]+)?【[\s\S]*】已更新：改了 (?:标题|范围|验收条件|优先级|标签|验收者|执行角色|验收角色|前置任务|附件|部分字段)(?:、(?:标题|范围|验收条件|优先级|标签|验收者|执行角色|验收角色|前置任务|附件))*，事件 ([0-9]+)。$/u.exec(message.body);
  return Number((create ?? edit)?.[1]) === message.collabEventId;
}

// Historical notices may contain the saved reason in their body. Use the short sentence in chat and load the event for details.
// A failed ship keeps the task completed (docs/collaboration.md「ship 失败」): the newer sentence says so.
export function shipFailureNotice(message) {
  if (!linkedSystemNotice(message)) return null;
  const match = /^(任务(?: #[0-9]+)?【[\s\S]*?】合并失败)(：合并前检查未通过|：文件有合并冲突)?(，已退回执行者|，保留已通过状态（可原样重跑、ship_fix 或 reopen）)(?:（原因：[\s\S]*）)?，事件 ([0-9]+)。$/.exec(message.body);
  return Number(match?.[4]) === message.collabEventId ? `${match[1]}${match[2] ?? ''}${match[3]}，事件 ${match[4]}。` : null;
}

/** Parse only the exact legacy task notification from a verified system message. Event IDs remain strings. */
export function parseLegacyTaskNotice(message) {
  if (message?.from !== 'system' || message.kind !== 'system' || typeof message.body !== 'string') return null;
  const match = /^协作事件 (task\.[a-z][a-z0-9_]*)：任务「([\s\S]*?)」（([A-Za-z0-9_-]+)），事件 ([0-9]+)。请按需读取任务上下文。$/.exec(message.body);
  if (!match) return null;
  const [, action, taskTitle, taskId, eventId] = match;
  return { action, actionLabel: TASK_ACTION_LABELS[action] ? t(TASK_ACTION_LABELS[action]) : t("其他任务事件"), taskId, taskTitle, eventId, hasHistoryDiff: false };
}
