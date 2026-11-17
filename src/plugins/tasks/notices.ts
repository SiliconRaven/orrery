// The Chinese sentences of task notifications (docs/collaboration.md). Old rows keep whatever text they were written with.
import { personName } from '../../core/collaboration.ts';
import type { Store } from '../../core/store.ts';
import type { Task } from '../../core/collaboration-types.ts';
import type { HubEvent } from '../../core/types.ts';
import { collaborationTask } from './store.ts';
import { BASIS_LABELS, reviewModeText } from './takeover.ts';

const CLOSE_LABELS: Record<string, string> = { not_planned: '不做了', duplicate: '重复', superseded: '被取代' };

export function noticeBody(store: Store, clusterId: string, source: HubEvent, action: string, task: Task | undefined, shipWake = false): string {
  const body = actionBody(store, clusterId, source, action, task, shipWake);
  // An edit, assignment or hand-off that also moved self review on a taken-over task says to whom and on what basis.
  const t = (source.payload as Record<string, any>).takeover;
  if (!t || action === 'task.takeover' || t.reviewTo?.kind !== 'self') return body;
  return `${body}自查授权给 ${personName(store, clusterId, t.toMemberId)}（依据：${BASIS_LABELS[t.basis as keyof typeof BASIS_LABELS] ?? '未知'}）。此后不再有独立验收。`;
}

function actionBody(store: Store, clusterId: string, source: HubEvent, action: string, task: Task | undefined, shipWake: boolean): string {
  const payload = source.payload as Record<string, any>;
  const seq = source.seq;
  const who = personName(store, clusterId, source.memberId);
  const title = task ? `任务${task.number ? ` #${task.number}` : ''}【${task.title}】` : '';
  const reason = typeof payload.reason === 'string' && payload.reason ? `（原因：${payload.reason}）` : '';
  const fieldNames: Record<string, string> = { title: '标题', scope: '范围', acceptance: '验收条件', priority: '优先级',
    labels: '标签', reviewer: '验收者', executeRoleIds: '执行角色', reviewRoleIds: '验收角色', dependencyIds: '前置任务',
    requiresApproval: '需要用户批准', mergeRequired: '需要合并', fileIds: '附件' };
  const changed = Array.isArray(payload.changes)
    ? payload.changes.map((change: { field?: string }) => fieldNames[change.field ?? ''] ?? change.field ?? '字段').join('、') : '';
  const reviewer = task?.reviewer.kind === 'member' ? personName(store, clusterId, task.reviewer.memberId) : task?.reviewer.kind === 'self' ? '自查' : '用户';
  if (payload.approvalVerdict) return payload.approvalVerdict === 'approve'
    ? `用户批准了${title}，事件 ${seq}。` : `用户退回了${title}的方案${reason}，事件 ${seq}。`;
  const stopNotice = typeof payload.coordinatorConfirmedStop === 'string' && store.getMember(payload.coordinatorConfirmedStop)
    ? `协调员已代确认这次停止，${personName(store, clusterId, payload.coordinatorConfirmedStop)} 请立即停手，原派工的开始和提交都会被拒绝。` : '';
  switch (action) {
    case 'task.create':
      return `${title}已创建（建单人 ${personName(store, clusterId, payload.createdBy ?? task?.createdBy)}${task?.assignedMemberId ? `，执行者 ${personName(store, clusterId, task.assignedMemberId)}` : ''}），事件 ${seq}。`;
    case 'task.edit':
      return `${title}已更新：改了 ${changed || '部分字段'}，事件 ${seq}。`;
    case 'task.set_git_branch':
      return `${who}${task?.gitBranch ? '更新了' : '移除了'}${title}的 Git 分支关联，事件 ${seq}。`;
    case 'task.assign': case 'task.nominate':
      return payload.memberId ? `${title}已分配给 ${personName(store, clusterId, payload.memberId)}，事件 ${seq}。` : `${title}的执行者已清除，事件 ${seq}。`;
    case 'task.claim':
      return `${who} 接取了${title}，事件 ${seq}。`;
    case 'task.start':
      return `${who} 开始执行${title}，事件 ${seq}。`;
    case 'task.submit':
      return task?.reviewer.kind === 'self'
        ? `${who} 提交了${title}的结果并完成自查，任务已完成，事件 ${seq}。`
        : `${who} 提交了${title}的结果，等待 ${reviewer} 验收，事件 ${seq}。`;
    case 'task.review':
      return payload.verdict === 'reject'
        ? `${who} 退回了${title}的结果${reason}，事件 ${seq}。`
        : `${who} 验收通过了${title}，任务已完成，事件 ${seq}。${shipWake ? '执行者请用 get_task 取 ship 命令并运行。' : ''}`;
    case 'task.merge': case 'task.shipped': return `${title}已合并（提交 ${String(payload.commitSha).slice(0, 7)}），事件 ${seq}。`;
    case 'task.mark_completed': return `用户手动标记${title}为已完成${reason}，事件 ${seq}。`;
    case 'task.mark_merged': {
      const commit = typeof payload.commitSha === 'string' ? `（提交 ${payload.commitSha.slice(0, 7)}）` : '';
      return `用户手动标记${title}为已合并${commit}${reason}，事件 ${seq}。`;
    }
    case 'task.ship_failed': {
      const category = typeof payload.reason === 'string' ? payload.reason.split(':', 1)[0] : '';
      const label = category === 'checks' ? '：合并前检查未通过' : category === 'conflict' ? '：文件有合并冲突' : '';
      return `${title}合并失败${label}，已退回执行者，事件 ${seq}。`;
    }
    case 'task.release': return `${title}的派工已释放${reason}，事件 ${seq}。`;
    case 'task.cancel': {
      // other adds nothing to the free-text reason, so it reads as before.
      const close = payload.closeReason as { kind?: string; taskId?: string } | undefined;
      const label = close?.kind ? CLOSE_LABELS[close.kind] : undefined;
      const related = close?.taskId ? collaborationTask(store, clusterId, close.taskId) : null;
      const why = label ? `（${label}${related ? `，见任务${related.number ? ` #${related.number}` : ''}【${related.title}】` : ''}）` : '';
      return `${title}已取消${why}${reason}，事件 ${seq}。${stopNotice}`;
    }
    case 'task.reopen': return `${title}已重新打开${reason}，事件 ${seq}。`;
    case 'task.handoff': return `${title}已转交给 ${personName(store, clusterId, payload.memberId)}${reason}，事件 ${seq}。${stopNotice}`;
    case 'task.takeover': {
      const t = payload.takeover ?? {};
      const from = typeof t.fromMemberId === 'string' && t.fromMemberId !== t.toMemberId ? `，原执行者 ${personName(store, clusterId, t.fromMemberId)}` : '';
      const stop = from && t.previousStatus === 'working' ? `${personName(store, clusterId, t.fromMemberId)} 请停手，原派工的提交会被拒绝。` : '';
      return `${title}由验收者 ${personName(store, clusterId, t.toMemberId)} 接手执行（发起：${who}${from}）；验收方式：${reviewModeText(store, clusterId, t.reviewFrom)} → ${reviewModeText(store, clusterId, t.reviewTo)}（依据：${BASIS_LABELS[t.basis as keyof typeof BASIS_LABELS] ?? '未知'}）。`
        + `${t.reviewTo?.kind === 'self' ? '此后不再有独立验收。' : ''}${t.previousRejected ? '上一轮验收为退回。' : ''}${stop}事件 ${seq}。`;
    }
    case 'task.attention': return `${title}有新的待处理事项：${payload.question ?? ''}，事件 ${seq}。`;
    default:
      return task ? `${title}有新的协作变化，事件 ${seq}。` : `协作设置已更新，事件 ${seq}。请查看本群任务和待处理事项。`;
  }
}
