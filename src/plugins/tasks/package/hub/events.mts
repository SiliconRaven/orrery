// The tasks plugin's event types for third-party plugins (docs/external-plugins.md「事件目录」). Each field is copied by
// name; never a stored task as it is: its git branch names a local repository path.
import { collaborationRecord, collaborationRecords, collaborationTask } from './store.mts';
import type { CollaborationActor, EventSource, EventTypeSpec, HubEvent, Review, Store, Submission, Task } from './types.mts';

type Payload = Record<string, unknown>;
const TASK_FIELDS = 'clusterId, taskId, title, status, at, number, scope, acceptance, priority, labels, '
  + 'executor（{id,name}，没有时为 null）, reviewer（{kind,id?,name?}，kind 为 user、member 或 self）, action, by（操作的成员 ID；用户或 Hub 为 null）';

function lifecycle(action: string, verdict: unknown): string[] {
  if (action === 'task.submit') return verdict === 'approve' ? ['task.submitted', 'task.approved'] : ['task.submitted'];
  if (action === 'task.review') return verdict === 'approve' ? ['task.approved'] : verdict === 'reject' ? ['task.rejected'] : [];
  if (action === 'task.merge' || action === 'task.shipped' || action === 'batch.merge' || action === 'batch.shipped') return ['task.merged'];
  if (action === 'task.create') return ['task.created'];
  if (action === 'task.delete') return ['task.deleted'];
  return ['task.changed'];
}

export function taskEventSource(store: Store): EventSource {
  const name = (id: string | null) => (id ? store.getMember(id, { includeRemoved: true })?.name ?? null : null);
  const actor = (a: CollaborationActor) => (a.kind === 'member' ? { kind: a.kind, id: a.memberId, name: name(a.memberId) } : { kind: a.kind });
  const matching = (event: HubEvent, type: string): Payload | null => {
    const p = (event.payload ?? {}) as Payload;
    if (p.suggested || typeof p.action !== 'string' || (!p.action.startsWith('task.') && !p.action.startsWith('batch.'))) return null;
    return lifecycle(p.action, p.verdict).includes(type) ? p : null;
  };
  const common = (event: HubEvent, p: Payload, task: Task) => ({
    clusterId: event.clusterId, taskId: task.id, title: task.title, status: task.status, at: event.createdAt,
    number: task.number, scope: task.scope, acceptance: task.acceptance, priority: task.priority, labels: [...task.labels],
    executor: task.assignedMemberId ? { id: task.assignedMemberId, name: name(task.assignedMemberId) } : null,
    reviewer: actor(task.reviewer), action: p.action, by: event.memberId ?? null,
  });
  const submission = (task: Task) => collaborationRecord<Submission>(store, task.id, 'submission', task.latestSubmissionId);
  const review = (task: Task) => {
    const last = collaborationRecords<Review>(store, task.id, 'review').at(-1);
    return last ? { verdict: last.verdict, reason: last.reason, self: last.self === true,
      commitSha: collaborationRecord<Submission>(store, task.id, 'submission', last.submissionId)?.commitSha ?? null } : null;
  };
  const spec = (type: string, description: string, fields: string, extra?: (task: Task) => Record<string, unknown>): EventTypeSpec => ({
    type, description, fields: `${TASK_FIELDS}${fields ? `；${fields}` : ''}`, from: 'collaboration',
    build: (event) => {
      const p = matching(event, type);
      if (!p) return null;
      const ids = typeof p.taskId === 'string' ? [p.taskId] : Array.isArray(p.taskIds) ? p.taskIds.filter((id) => typeof id === 'string') : [];
      return ids.flatMap((id) => {
        const task = collaborationTask(store, event.clusterId!, id);
        return task ? [{ ...common(event, p, task), ...extra?.(task) }] : [];
      });
    },
  });
  const reviewed = (task: Task) => review(task) ?? { verdict: null, reason: null, self: false, commitSha: null };
  return {
    types: [
      spec('task.created', '群里新建了一个任务。', ''),
      spec('task.submitted', '执行者提交了结果。', 'summary（提交说明）, commitSha（提交的提交号，没有时为 null）',
        (task) => { const s = submission(task); return { summary: s?.summary ?? null, commitSha: s?.commitSha ?? null }; }),
      spec('task.approved', '验收通过。自查档的任务提交时就通过，同一次动作先后推 task.submitted 和 task.approved。',
        'verdict, reason（验收意见）, self（是否自查）, commitSha（被验收的提交号）', reviewed),
      spec('task.rejected', '验收退回。', 'verdict, reason（验收意见）, self, commitSha（被验收的提交号）', reviewed),
      spec('task.merged', '记录为已合并（task.merge 或 ship 的成功回报）。', 'mergedCommitSha', (task) => ({ mergedCommitSha: task.mergedCommitSha })),
      spec('task.changed', '任务的其他变化：派工、开始、改字段、取消、重开、交接、待办事项、摘要等，action 写明是哪一种。', ''),
      {
        type: 'task.deleted', from: 'collaboration', description: '任务被删除。', fields: 'clusterId, taskId, by, at',
        build: (event) => {
          const p = matching(event, 'task.deleted');
          return p && typeof p.taskId === 'string' ? { clusterId: event.clusterId, taskId: p.taskId, by: event.memberId ?? null, at: event.createdAt } : null;
        },
      },
    ],
  };
}
