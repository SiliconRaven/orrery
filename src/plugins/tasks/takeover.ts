// Reviewer takeover (docs/collaboration.md「验收者接手」): the cluster setting that lets self review follow a takeover,
// the user-only action that changes it, and the words its records and notices use. actions.ts runs task.takeover itself.
import { personName } from '../../core/collaboration.ts';
import type { CollaborationActor, Takeover, TakeoverBasis } from '../../core/collaboration-types.ts';
import type { PluginActionContext } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import { fail } from './model.ts';
import { collaborationRecords } from './store.ts';

// The table, task_cluster_settings, is created by store.ts's migration step 5; a cluster purge clears it there.

/** Whether this cluster lets the member who took a task over review it themself (default off). */
export function takeoverSelfReview(store: Store, clusterId: string): boolean {
  const row = store.db.prepare('SELECT takeover_self_review FROM task_cluster_settings WHERE cluster_id = ?').get(clusterId);
  return Number(row?.takeover_self_review ?? 0) === 1;
}

export const taskSettings = (store: Store, clusterId: string) => ({ takeoverSelfReview: takeoverSelfReview(store, clusterId) });

export const SETTING_NAME = '允许验收者接手后自检';

/**
 * tasks.settings: only the user, through the page's cluster route; no MCP tool sends it, and the Hub refuses every other
 * actor, the coordinator included. The change stays in the chat record as a settings notice that wakes nobody.
 */
export function runSettingsAction(ctx: PluginActionContext): Record<string, unknown> {
  const { store, actor, clusterId, command } = ctx;
  if (actor.kind !== 'user') return fail('FORBIDDEN', 'only the user can change this cluster\'s task settings, on the page');
  if (typeof command.takeoverSelfReview !== 'boolean') return fail('INVALID_REQUEST', 'takeoverSelfReview must be boolean');
  const enabled = command.takeoverSelfReview;
  store.db.prepare(`INSERT INTO task_cluster_settings (cluster_id, takeover_self_review) VALUES (?, ?)
    ON CONFLICT(cluster_id) DO UPDATE SET takeover_self_review = excluded.takeover_self_review`).run(clusterId, enabled ? 1 : 0);
  ctx.outcome.payload = () => ({ action: command.action, takeoverSelfReview: enabled });
  ctx.outcome.afterEvent = (event) => ctx.notice(event, { systemKind: 'settings', recipients: [], retain: true,
    body: `用户${enabled ? '开启' : '关闭'}了本群的「${SETTING_NAME}」，事件 ${event.seq}。` });
  return { taskSettings: taskSettings(store, clusterId) };
}

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

/**
 * THE rule: may this actor make a taken-over task self-reviewed (or move its self review to another executor) now?
 * Only the user, or anyone while the user's cluster setting is on. Returns the basis to record; refuses otherwise,
 * saying how to proceed (`what` names the refused step).
 */
export function authoriseSelfReview(store: Store, clusterId: string, actor: CollaborationActor, what: string): TakeoverBasis {
  if (actor.kind === 'user') return 'user';
  if (takeoverSelfReview(store, clusterId)) return 'cluster_setting';
  return fail('FORBIDDEN', `${what} needs the user's authorisation, because self review on a taken-over task is bound to one executor: ask the user to do this on the page or to turn on 「${SETTING_NAME}」 for this cluster, or choose user review (the default) or another member`);
}

export const BASIS_LABELS: Record<TakeoverBasis, string> = { user: '用户本人操作', cluster_setting: '群设置授权',
  user_review: '默认改为用户验收', named_member: '指定成员' };

/** How a review mode reads in a notice: 用户验收, 自查, or 成员验收（name）. */
export function reviewModeText(store: Store, clusterId: string, reviewer: CollaborationActor | undefined): string {
  if (reviewer?.kind === 'member') return `成员验收（${personName(store, clusterId, reviewer.memberId)}）`;
  return reviewer?.kind === 'self' ? '自查' : '用户验收';
}
