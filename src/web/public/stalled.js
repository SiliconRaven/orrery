import { t, language } from './i18n.js';
// The stalled-member hint (docs/collaboration.md「成员长时间没有活动」): members holding tasks with no activity the Hub
// has seen past the threshold. The Hub computes the hints (GET /api/stalled); the page only shows them, and a dismissal
// is this viewer's own choice, kept in localStorage. Nothing here sends, delivers or wakes anything.

/** localStorage key of the dismissed hints: { [memberId]: stalledKey }. */
export const STALLED_DISMISSED_KEY = 'orrery.stalledDismissed';

/**
 * One member, one set of tasks, one silence: a new activity or a task change gives a new key (`since` moves). A
 * hidden_work hint (work landed on a hidden member) also keys on what waits and on the latest item's event seq per task,
 * so any new item brings it back, even one of the same kind on the same task.
 */
export const stalledKey = (hint) => [hint.memberId, hint.tasks.map((task) => `${task.id}${task.waiting ? `:${task.waiting}:${task.seq ?? ''}` : ''}`).sort().join(','), hint.since].join('|');

/** Where a hint's dismissal is kept: one entry per member and kind, so a dismissed silence hides no hidden-member work. */
const dismissSlot = (hint) => (hint.kind === 'hidden_work' ? `${hint.memberId}|hidden_work` : hint.memberId);

/** The hints not dismissed: a dismissal hides only the exact key it was made for. */
export const visibleStalled = (hints, dismissed) => hints.filter((hint) => dismissed[dismissSlot(hint)] !== stalledKey(hint));

/** The dismissed map after dismissing `hint`; one entry per member and kind, so it never grows past the members ever seen. */
export const withDismissed = (dismissed, hint) => ({ ...dismissed, [dismissSlot(hint)]: stalledKey(hint) });

/** The browser's localStorage, or null when even reading the property throws (blocked site data): memory only then. */
export function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readDismissed(storage = browserStorage()) {
  try {
    const value = JSON.parse(storage?.getItem(STALLED_DISMISSED_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

const fmt = (iso) => new Date(iso).toLocaleString(language() === 'en' ? 'en-GB' : 'zh-CN', { hour12: false });
const STATUS = { get pending() { return t("已分配"); }, get working() { return t("进行中"); }, get review() { return t("待验收"); } };
/** What waits on a hidden member, per task of a hidden_work hint (the Hub's HiddenWorkKind). */
export const HIDDEN_WAITING = { get rejected() { return t("被退回，执行者隐身中，没有人会处理"); }, get ready() { return t("前置已就绪，执行者隐身中，没有人会开工"); },
  get ship() { return t("等运行 ship，该运行的成员隐身中"); }, get review() { return t("等验收，验收人隐身中"); }, get attention() { return t("有点名的待处理事项，被点名的成员隐身中"); }, get other() { return t("有新进展，隐身成员收不到"); } };
export const stalledTaskText = (task) => t("{value1}{title}（{value3}）", { value1: task.number != null ? `#${task.number} ` : '', title: task.title, value3: task.waiting ? HIDDEN_WAITING[task.waiting] ?? t("隐身成员收不到") : STATUS[task.status] ?? task.status });
/** The caveat every hint carries: absence of activity is not proof that the work stopped. */
export const STALLED_CAVEAT = '这只是 Hub 看到的活动，不代表对方已经停工：有些应用在一轮中间不报告活动。请先问对方或查看分支和投递情况。';

/** The hint's sentences, in order: who, the latest activity (or that there is none), offline. */
export function stalledLines(hint) {
  if (hint.kind === 'hidden_work') {
    return [t("{memberName}（{harness}）隐身中，落到它身上的工作没有人会处理。", { memberName: hint.memberName, harness: hint.harness }),
      t("它收不到通知；请改派、取消任务或取消它的隐身。改派、取消、任务完成或取消隐身后，这条提示自动消失。")];
  }
  return [
    t("{memberName}（{harness}）手上有任务，超过 {thresholdMinutes} 分钟没有活动。", { memberName: hint.memberName, harness: hint.harness, thresholdMinutes: hint.thresholdMinutes }),
    hint.lastActivityAt
      ? t("Hub 看到的最近活动：{lastActivityAt}（来源：{lastActivitySource}）。", { lastActivityAt: fmt(hint.lastActivityAt), lastActivitySource: hint.lastActivitySource })
      : t("没有活动证据：Hub 没有记录到该成员的发言、投递开始或结束或活动事件；最后一次任务变化在 {lastTaskChangeAt}。", { lastTaskChangeAt: fmt(hint.lastTaskChangeAt) }),
    // A hidden holder is silent because it was hidden (docs/cluster-members.md「隐身」), not ordinary silence.
    ...(hint.hidden ? [t("{memberName} 当前隐身中：它收不到任何消息，也不能发言或操作任务；要不要改派它手上的任务由你或协调员决定。", { memberName: hint.memberName })]
      : hint.offline ? [t("{memberName} 当前离线：发给它的消息不会投递，恢复在线后也不补发。", { memberName: hint.memberName })] : []),
  ];
}

/** A badge's words and title for some hints: hidden-member work and silences are counted apart, never mixed up. */
export function stalledBadge(hints, short = false) {
  const hidden = hints.filter((hint) => hint.kind === 'hidden_work');
  const silent = hints.filter((hint) => hint.kind !== 'hidden_work');
  const text = [hidden.length ? (short ? t("隐身有活") : t("{length} 人隐身有活", { length: hidden.length })) : '', silent.length ? (short ? t("无活动") : t("{length} 人无活动", { length: silent.length })) : '']
    .filter(Boolean).join(' · ');
  const title = [
    hidden.length ? t("{length} 位隐身成员手上有工作，没有人会处理：\n{hidden}", { length: hidden.length, hidden: stalledSummary(hidden) }) : '',
    silent.length ? t("{length} 位成员手上有任务却长时间没有活动（不代表已停工）：\n{silent}", { length: silent.length, silent: stalledSummary(silent) }) : '',
  ].filter(Boolean).join('\n');
  return { text, title };
}

/** One line for a title attribute: who and which tasks. */
export const stalledSummary = (hints) => hints.map((hint) =>
  t("{memberName}{value2}：{value3}", { memberName: hint.memberName, value2: hint.hidden ? t("（隐身中）") : hint.offline ? t("（离线）") : '', value3: hint.tasks.map(stalledTaskText).join(t("、")) })).join('\n');

/**
 * Keeps the hints fresh: a read on start, again a few seconds after any Hub event (coalesced), and every minute, since
 * time passing alone can make a member cross the threshold. `onChange` runs when what is visible changed.
 */
export function createStalledWatch({ api, onChange, storage = browserStorage(), eventDelayMs = 3000, everyMs = 60_000 }) {
  let hints = [];
  let dismissed = readDismissed(storage);
  let shownKey = '[]';
  let timer = null;
  let loading = false;
  let again = false;
  const visible = () => visibleStalled(hints, dismissed);
  const announce = () => {
    const key = JSON.stringify(visible());
    if (key !== shownKey) { shownKey = key; onChange(); }
  };
  let interval = null;
  /** The first call starts the minute timer; until then (tasks plugin off) events read nothing. */
  async function load() {
    if (interval === null) { interval = setInterval(() => void load(), everyMs); interval.unref?.(); }   // unref: node tests
    if (loading) { again = true; return; }
    loading = true;
    try { hints = (await api('GET', '/api/stalled')).hints ?? []; }
    catch { /* no tasks plugin or no Hub: keep what is shown until the next read */ }
    finally { loading = false; }
    announce();
    if (again) { again = false; void load(); }
  }
  return {
    load,
    /** A Hub event: read again shortly (one read for a burst). */
    changed() { if (interval !== null && timer === null) timer = setTimeout(() => { timer = null; void load(); }, eventDelayMs); },
    visible,
    forCluster: (clusterId) => visible().filter((hint) => hint.clusterId === clusterId),
    /** The tasks of this cluster with a visible hint: taskId → hint. */
    taskMap(clusterId) { return new Map(visible().filter((hint) => hint.clusterId === clusterId).flatMap((hint) => hint.tasks.map((task) => [task.id, hint]))); },
    dismiss(hint) {
      // Another tab's dismissals are picked up, but this page's own never get lost, even when storage cannot be written.
      dismissed = withDismissed({ ...readDismissed(storage), ...dismissed }, hint);
      try { storage?.setItem(STALLED_DISMISSED_KEY, JSON.stringify(dismissed)); } catch { /* quota or private mode: this page still hides it */ }
      announce();
    },
  };
}
