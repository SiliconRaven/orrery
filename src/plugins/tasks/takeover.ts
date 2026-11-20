// Reviewer takeover (docs/collaboration.md「验收者接手」): takeover records are the source of truth for self-review
// binding after a takeover; legacy cluster_setting / user_review / named_member labels stay read-only compatible.
import { personName } from '../../core/collaboration.ts';
import type { CollaborationActor, Takeover, TakeoverBasis } from '../../core/collaboration-types.ts';
import type { Store } from '../../core/store.ts';
import { collaborationRecords } from './store.ts';

// The table task_cluster_settings is still created by store.ts migration step 5 and cleared in purgeClusterTasks,
// so existing databases upgrade cleanly without dropping historical schema steps.

/**
 * A task's takeover-style records, oldest first. They are the source of truth: a task is taken over when it has any, and
 * self review on it is bound to the executor the latest one names. The task's `takeover` mark is written only together
 * with a record (actions.ts recordTakeover) and is for display.
 */
export const takeoverRecords = (store: Store, taskId: string): Takeover[] => collaborationRecords<Takeover>(store, taskId, 'takeover');

/** On a taken-over task: the member its self review is bound to (null when the latest record is not a switch to self). */
export function selfReviewHolder(store: Store, taskId: string): string | null {
  const latest = takeoverRecords(store, taskId).at(-1);
  return latest?.reviewTo.kind === 'self' ? latest.toMemberId : null;
}

/**
 * Whether `memberId` may write a self review on this task now: null for a task never taken over (the rule does not
 * apply), otherwise whether the latest record bound self review to exactly this member.
 */
export function selfReviewBound(store: Store, taskId: string, memberId: string): boolean | null {
  if (!takeoverRecords(store, taskId).length) return null;
  return selfReviewHolder(store, taskId) === memberId;
}

export const BASIS_LABELS: Record<TakeoverBasis, string> = {
  user: '用户本人操作',
  reviewer: '验收者本人接手',
  cluster_setting: '群设置授权',
  user_review: '默认改为用户验收',
  named_member: '指定成员',
};

/** How a review mode reads in a notice: 用户验收, 自查, or 成员验收（name）. */
export function reviewModeText(store: Store, clusterId: string, reviewer: CollaborationActor | undefined): string {
  if (reviewer?.kind === 'member') return `成员验收（${personName(store, clusterId, reviewer.memberId)}）`;
  return reviewer?.kind === 'self' ? '自查' : '用户验收';
}
