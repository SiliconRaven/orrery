// What a delivery envelope says about tasks: the task IDs on the header, one section per task, and whether a notice is out of date.
import type { Task } from '../../core/collaboration-types.ts';
import type { EnvelopeItem } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import type { Message } from '../../core/types.ts';
import { coalesceNotices } from './notice-coalesce.ts';
import { collaborationLinks, collaborationTask } from './store.ts';

const STATUS_NAMES: Record<Task['status'], string> = { pending: '待开工', working: '正在执行',
  review: '待验收', completed: '已完成', merged: '已合并', cancelled: '已取消' };

export function taskEnvelope(store: Store, messages: Message[], nameOf: (id: string) => string): EnvelopeItem[][] {
  const inputs = messages.map((message) => ({ message, taskIds: collaborationLinks(store, message.id),
    event: message.from === 'system' && message.collabEventId != null ? store.getEvent(message.collabEventId) : null }));
  const taskState = (task: Task) => `${STATUS_NAMES[task.status] ?? task.status}；负责人：${task.assignedMemberId ? nameOf(task.assignedMemberId) : '未分配'}；验收人：${task.reviewer.kind === 'member' ? nameOf(task.reviewer.memberId) : task.reviewer.kind === 'self' ? '自查' : '用户'}`;
  /** After a notice whose task moved on since it was produced (other batches included); the notice's own text stays. */
  const expiredLine = ({ taskStamp: stamp, clusterId }: Message): string => {
    const task = stamp ? collaborationTask(store, clusterId, stamp.taskId) : null;
    if (!stamp || !task || (task.revision === stamp.revision && task.latestSubmissionId === stamp.submissionId)) return '';
    const submission = task.latestSubmissionId === stamp.submissionId ? '' : `，最新提交 ${task.latestSubmissionId ?? '无'}（这条通知时是 ${stamp.submissionId ?? '无'}）`;
    return `\n已过期：当前状态是${taskState(task)}（修订 ${stamp.revision} → ${task.revision}${submission}）。`;
  };
  return coalesceNotices(inputs).map((section) => {
    const grouped = section.kind === 'task' && section.items.length > 1;
    const task = grouped && section.kind === 'task' ? collaborationTask(store, section.clusterId, section.taskId) : null;
    const summary = !grouped ? '' : task ? `\n任务当前状态：${taskState(task)}。` : '\n任务当前状态：不可用。';
    return section.items.map((item, index) => {
      const { message: m, taskIds, event } = item.notice;
      const payload = event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as { action?: unknown; taskId?: unknown } : null;
      const afterBody = m.kind === 'system' && event?.kind === 'collaboration' && event.clusterId === m.clusterId
        && typeof payload?.taskId === 'string' && taskIds.includes(payload.taskId)
        ? `\n事件：${typeof payload.action === 'string' ? payload.action : 'event'} #${m.collabEventId}；完整改动见 get_task 的 events`
        : '';
      const group = grouped && section.kind === 'task' && index === 0 ? `\n任务通知${task?.number ? ` #${task.number}` : ''}【${task?.title ?? section.taskId}】（${section.taskId}）：` : '';
      const time = grouped ? `\n时间：${m.createdAt}` : '';
      const superseded = item.supersededBy
        ? `\n已被后来的${item.supersededBy.reason === 'nomination_changed' ? '分配' : '状态'}取代（事件 ${item.supersededBy.eventId}，messageId ${item.supersededBy.messageId}）。` : expiredLine(m);
      return { message: m, header: taskIds.length ? ` taskIds=${taskIds.join(',')}` : '', lead: group + time, afterBody,
        tail: superseded + (index === section.items.length - 1 ? summary : '') };
    });
  });
}
