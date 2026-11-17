// Coordinator notification settings the user can change on the web page (docs/collaboration.md): how long a member with
// open tasks may stay silent before the coordinator is reminded. Values are plain non-negative safe integers, saved as JSON numbers in the
// `settings` table (the same generic key/value table as the limit settings); no schema change. Store, Hub and web share
// this one list of keys and names.

export type NotifySetting = 'stalledMemberMinutes';

export const NOTIFY_SETTINGS = {
  stalledMemberMinutes: {
    key: 'stalled_member_minutes', name: '成员无活动提醒阈值', unit: '分钟', defaultValue: 30,
    sourceKey: 'stalledMemberMinutesSource',
  },
} as const satisfies Record<NotifySetting, { key: string; name: string; unit: string; defaultValue: number; sourceKey: string }>;

export const isNotifySetting = (v: unknown): v is NotifySetting => v === 'stalledMemberMinutes';

/** A non-negative safe integer, or null. 0 is a value (remind at once), not "unset". */
export function parseNotifyValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v + 0 : null;
}
