// Work that lands on a hidden member (docs/cluster-members.md「隐身」): a task wake-up the Hub skipped because its
// recipient is hidden. Pure helpers; the Hub records each one as a page event, the tasks plugin turns them into page
// hints and into the brief a member gets when it is shown again.
import type { Task } from './collaboration-types.ts';

/** What waits on the hidden member. */
export type HiddenWorkKind = 'rejected' | 'ready' | 'ship' | 'review' | 'attention' | 'other';
/** Who the hidden member is for the task. */
export type HiddenWorkRole = 'executor' | 'reviewer' | 'named';

/** The 'guard' event payload that records it (reason 'hidden_work'); the page shows it on the member's page. */
export interface HiddenWork {
  reason: 'hidden_work'; taskId: string; kind: HiddenWorkKind; role: HiddenWorkRole;
  /** The task state it landed in: the same state and kind is recorded (and told) once per hidden period. */
  revision: number; status: string; sourceEventId: number;
}

/**
 * Which wake-up this is, from the event that caused it: `action` and `payload` of the source event, `noticeTaskId` the
 * task the notice is about (another task than the event's for a dependency that became ready).
 */
export function hiddenWorkOf(task: Task, memberId: string, action: string, payload: Record<string, unknown>, noticeTaskId: string): { kind: HiddenWorkKind; role: HiddenWorkRole } {
  const named: HiddenWorkRole = task.assignedMemberId === memberId ? 'executor'
    : task.reviewer.kind === 'member' && task.reviewer.memberId === memberId ? 'reviewer' : 'named';
  const kind: HiddenWorkKind = typeof payload.taskId === 'string' && payload.taskId !== noticeTaskId ? 'ready'
    : action === 'task.review' && payload.verdict === 'reject' ? 'rejected'
      : action === 'task.review' ? 'ship'
        : action === 'task.submit' && named === 'reviewer' ? 'review'
          : action === 'task.attention' ? 'attention' : 'other';
  // A finished task no longer names its executor: whoever ship falls to and is not the reviewer ran the task.
  const role = kind === 'ship' && named === 'named' ? 'executor' : named;
  return { kind, role };
}

const PHRASE: Record<HiddenWorkKind, string> = {
  rejected: '被退回', ready: '前置已就绪、可以开工', ship: '验收通过、等着运行 ship', review: '已提交结果、等待验收',
  attention: '有点名的待处理事项', other: '有新进展要处理',
};
const ROLE: Record<HiddenWorkRole, string> = { executor: '执行者', reviewer: '验收人', named: '被点名的成员' };

/**
 * The coordinator's wake-up (coordinator rules, rule 21). It is a chat message every member can read, so it does not
 * name the member: the coordinator finds it in the task (get_task) and in list_agents (`hidden: true`).
 */
export function hiddenWorkNotice(task: Task, kind: HiddenWorkKind, role: HiddenWorkRole, seq: number): string {
  return `任务${task.number ? ` #${task.number}` : ''}【${task.title}】${PHRASE[kind]}，但${ROLE[role]}是一位隐身成员，收不到通知，没有人会处理，事件 ${seq}。`
    + '请在授权内处理（协调规则第 21 条）：改派给其他有资格的成员，或在它就是合适的人、且隐身不是用户当前明确的要求时取消它的隐身；都做不了就告诉用户。处理结果写进任务。';
}
