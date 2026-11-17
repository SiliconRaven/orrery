// Hidden members and their tasks (docs/cluster-members.md「隐身」): the user's page hint for work that landed on a hidden
// member, and the one task-status brief a member gets when it is shown again. Read-only over the tasks and the Hub's
// hidden_work events (Store.hiddenWork); neither sends nor reassigns anything.
import type { Attention, Task } from '../../core/collaboration-types.ts';
import type { Store } from '../../core/store.ts';
import type { StoredMember } from '../../core/store.ts';
import { allTasks, shipState, taskDependencyEvaluation } from './model.ts';
import { collaborationRecords } from './store.ts';

const CLOSED = ['completed', 'merged', 'cancelled'];
const pendingAttentions = (store: Store, taskId: string, memberId: string) =>
  collaborationRecords<Attention>(store, taskId, 'attention').filter((item) => !item.resolvedAt && item.targetMemberId === memberId);
const shipRunnerOf = (store: Store, task: Task): string | null => {
  const state = shipState(store, task.clusterId, task.id);
  return state ? (state.reviewer === 'user' || state.self ? state.executorId : state.reviewer) : null;
};

/** Whether the member still holds this task: its executor, the reviewer of it in review, or the one who runs its ship. */
export function holds(store: Store, task: Task, memberId: string): boolean {
  if (task.proposalState !== 'active' || task.status === 'merged' || task.status === 'cancelled') return false;
  if (!CLOSED.includes(task.status) && task.assignedMemberId === memberId) return true;
  if (task.status === 'review' && task.reviewer.kind === 'member' && task.reviewer.memberId === memberId) return true;
  return task.status === 'completed' && task.mergeRequired && shipRunnerOf(store, task) === memberId;
}

/** One hint task: what waits on the hidden member (the latest landing on that task). */
export interface HiddenWorkTask {
  id: string; number: number | null; title: string; status: string; waiting: string; role: string;
  /** The event seq of the latest item on this task: a new item is a new hint, even of the same kind (dismissal key). */
  seq: number;
}

/**
 * The work that landed on this hidden member since it was hidden and still waits on it: the task is not finished,
 * cancelled or handed to someone else. Empty for a visible member: showing it, reassigning or closing ends the hint.
 * Per task: the latest item's kind and seq (the page's dismissal key), and the time the first item landed, which is
 * what `since` shows (how long work has waited on it).
 */
export function hiddenWorkTasks(store: Store, member: StoredMember): { tasks: HiddenWorkTask[]; since: string; latest: string } | null {
  if (!member.hiddenAt || member.removedAt) return null;
  const byTask = new Map<string, { kind: string; role: string; seq: number; at: string }[]>();
  for (const work of store.hiddenWork(member.id, member.hiddenAt)) {
    const items = byTask.get(work.taskId) ?? [];
    items.push(work);
    byTask.set(work.taskId, items);
  }
  const tasks: HiddenWorkTask[] = [];
  let since: string | null = null;
  let latest: string | null = null;
  for (const [taskId, items] of byTask) {
    const task = store.tasks?.task(member.clusterId, taskId);
    if (!task || task.proposalState !== 'active') continue;
    const held = holds(store, task, member.id);
    const named = !CLOSED.includes(task.status) && pendingAttentions(store, taskId, member.id).length > 0;
    const waiting = items.filter((item) => item.kind === 'attention' ? named : held);
    if (!waiting.length) continue;
    const first = waiting[0];
    const work = waiting[waiting.length - 1];
    tasks.push({ id: task.id, number: task.number ?? null, title: task.title, status: task.status, waiting: work.kind, role: work.role, seq: work.seq });
    if (since === null || first.at < since) since = first.at;
    if (latest === null || work.at > latest) latest = work.at;
  }
  return tasks.length ? { tasks, since: since!, latest: latest! } : null;
}

const label = (task: Task) => `- 任务${task.number ? ` #${task.number}` : ''}【${task.title}】（${task.id}）`;

/**
 * The one notice a member gets when it is shown again, about the current state only: its tasks in progress (those
 * rejected while it was hidden marked; the reason is in the task), its assigned tasks, the submissions waiting for its
 * review and the ships it has to run. Null when it holds nothing. Names nobody: no other member is mentioned.
 */
export function heldBrief(store: Store, clusterId: string, memberId: string, hiddenSince: string | null): { body: string; taskIds: string[] } | null {
  const rejected = new Set(hiddenSince ? store.hiddenWork(memberId, hiddenSince).filter((w) => w.kind === 'rejected').map((w) => w.taskId) : []);
  const tasks = [...allTasks(store, clusterId)].filter((task) => task.proposalState === 'active');
  const mine = (task: Task) => task.assignedMemberId === memberId;
  const working = tasks.filter((task) => mine(task) && (task.status === 'working' || task.status === 'review'));
  const evaluation = taskDependencyEvaluation(store, clusterId);
  const pending = tasks.filter((task) => mine(task) && task.status === 'pending');
  const ready = pending.filter((task) => evaluation.versions(task) !== null);
  const waiting = pending.filter((task) => evaluation.versions(task) === null);
  const reviewing = tasks.filter((task) => task.status === 'review' && task.reviewer.kind === 'member' && task.reviewer.memberId === memberId);
  const ships = tasks.filter((task) => task.status === 'completed' && task.mergeRequired && shipRunnerOf(store, task) === memberId);
  const named = tasks.filter((task) => !CLOSED.includes(task.status) && pendingAttentions(store, task.id, memberId).length > 0);
  const sections: [string, string[]][] = [
    ['正在做：', working.map((task) => label(task) + (task.status === 'review' ? '，已提交，等待验收'
      : rejected.has(task.id) ? '，隐身期间被退回，退回理由用 get_task 查看' : ''))],
    ['已分配、可以开工：', ready.map(label)],
    ['已分配、等前置任务：', waiting.map(label)],
    ['等你验收：', reviewing.map(label)],
    ['等你运行 ship（用 get_task 取 ship 命令）：', ships.map(label)],
    ['等你处理的事项（用 get_task_context 查看）：', named.map(label)],
  ];
  const shown = sections.filter(([, lines]) => lines.length);
  if (!shown.length) return null;
  const body = ['你已取消隐身，回到群里。隐身期间的消息不会补发；下面是你手上任务现在的情况，详情用 get_task 查看。',
    ...shown.flatMap(([head, lines]) => ['', head, ...lines])].join('\n');
  return { body, taskIds: [...new Set([...working, ...pending, ...reviewing, ...ships, ...named].map((task) => task.id))] };
}
