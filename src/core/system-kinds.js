// Every `systemKind` a system message is written with, and the one category it belongs to (docs/collaboration-api.md
// 「系统消息分类」). The Hub and the page share this table: a pure module with no imports, which the web server hands to the
// page as /core/system-kinds.js (src/web/public/system-kinds.js re-exports it). A message without a kind (rows written before kinds existed) is `other`; the text is never parsed.

/** Warnings come in two levels: a problem (something failed or stopped) and an attention item (something waits). */
export const SYSTEM_KINDS = Object.freeze({
  delivery_failed: { category: 'warning', level: 'problem' },    // a delivery failed, is unknown or hit an offline member
  hidden_work: { category: 'warning', level: 'problem' },        // a wake-up with work landed on a hidden member
  quota_exhausted: { category: 'warning', level: 'problem' },    // a harness quota window is used up
  ship_failed: { category: 'warning', level: 'problem' },        // ship's merge or checks failed; the task went back
  queue_warning: { category: 'warning', level: 'attention' },    // deliveries have waited too long to start
  stalled: { category: 'warning', level: 'attention' },          // a member holding tasks shows no activity
  quota_low: { category: 'warning', level: 'attention' },        // a harness quota window is nearly used up
  task_rejected: { category: 'warning', level: 'attention' },    // a reviewer sent the result back
  task_attention: { category: 'warning', level: 'attention' },   // a question or attention item on a task waits
  review_downgraded: { category: 'warning', level: 'attention' },// a reviewer took a task over and it is now self-reviewed
  plugin_rate_limit: { category: 'warning', level: 'attention' },// a plugin hit its send limit
  task: { category: 'task', level: null },                       // task created, assigned, started, submitted, approved, merged...
  coordinator: { category: 'coordinator', level: null },         // coordinator set, handed over, removed
  idle: { category: 'coordinator', level: null },                // members idle while tasks wait (to the coordinator)
  quota_recovered: { category: 'coordinator', level: null },     // a used-up quota window is usable again
  rebind: { category: 'member', level: null },                   // a member moved to another conversation
  member_shown: { category: 'member', level: null },             // a hidden member is shown again: what it holds
  settings: { category: 'member', level: null },                 // cluster collaboration settings changed (roles, labels...)
  receipt: { category: 'other', level: null },                   // old acknowledgement receipts (no longer written)
});

export const SYSTEM_CATEGORIES = Object.freeze(['warning', 'task', 'coordinator', 'member', 'other']);
export const SYSTEM_CATEGORY_LABELS = Object.freeze({ warning: '警告', task: '任务进度', coordinator: '协调', member: '成员与群', other: '其他' });
export const WARNING_LEVEL_LABELS = Object.freeze({ problem: '问题', attention: '提醒' });

/** The category and warning level of a system message kind; an absent or unknown kind is `other`. */
export function systemClass(systemKind) {
  return (typeof systemKind === 'string' && Object.hasOwn(SYSTEM_KINDS, systemKind) && SYSTEM_KINDS[systemKind])
    || { category: 'other', level: null };
}

/** The kinds in one category, e.g. for a query filter. */
export function kindsOf(category) {
  return Object.keys(SYSTEM_KINDS).filter((kind) => SYSTEM_KINDS[kind].category === category);
}
