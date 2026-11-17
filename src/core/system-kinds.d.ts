// Types for system-kinds.js, so the Hub's TypeScript can import the table the page also loads.
export type SystemKind = 'delivery_failed' | 'hidden_work' | 'quota_exhausted' | 'ship_failed' | 'queue_warning' | 'stalled'
  | 'quota_low' | 'task_rejected' | 'task_attention' | 'review_downgraded' | 'plugin_rate_limit' | 'task' | 'coordinator' | 'idle'
  | 'quota_recovered' | 'rebind' | 'member_shown' | 'settings' | 'receipt';
export type SystemCategory = 'warning' | 'task' | 'coordinator' | 'member' | 'other';
export type WarningLevel = 'problem' | 'attention';
export interface SystemClass { category: SystemCategory; level: WarningLevel | null }
export const SYSTEM_KINDS: Readonly<Record<SystemKind, SystemClass>>;
export const SYSTEM_CATEGORIES: readonly SystemCategory[];
export const SYSTEM_CATEGORY_LABELS: Readonly<Record<SystemCategory, string>>;
export const WARNING_LEVEL_LABELS: Readonly<Record<WarningLevel, string>>;
export function systemClass(systemKind: unknown): SystemClass;
export function kindsOf(category: SystemCategory): SystemKind[];
