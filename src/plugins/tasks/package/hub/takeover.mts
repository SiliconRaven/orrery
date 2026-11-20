// Reviewer takeover (docs/collaboration.md「验收者接手」): takeover records are the source of truth for self-review
// binding after a takeover; legacy cluster_setting / user_review / named_member labels stay read-only compatible.
import { host } from './host.mts';
import { collaborationRecords } from './store.mts';
import type { CollaborationActor, Store, Takeover, TakeoverBasis } from './types.mts';

export const takeoverRecords = (store: Pick<Store, 'db'>, taskId: string): Takeover[] =>
  collaborationRecords<Takeover>(store, taskId, 'takeover');

export function selfReviewHolder(store: Pick<Store, 'db'>, taskId: string): string | null {
  const latest = takeoverRecords(store, taskId).at(-1);
  return latest?.reviewTo.kind === 'self' ? latest.toMemberId : null;
}

export function selfReviewBound(store: Pick<Store, 'db'>, taskId: string, memberId: string): boolean | null {
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
  if (reviewer?.kind === 'member') return `成员验收（${host().collaboration.personName(store, clusterId, reviewer.memberId)}）`;
  return reviewer?.kind === 'self' ? '自查' : '用户验收';
}
