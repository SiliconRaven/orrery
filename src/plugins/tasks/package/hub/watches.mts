// Task watches (docs/collaboration.md「关注任务」): a member asks to be told once when a task it does not depend on reaches
// its end. The table, the end check, the watch/unwatch actions and the notice text live here; actions.mts sends the notice.
import { completionValid, fail, taskOf } from './model.mts';
import type { PluginActionContext, Store, Task } from './types.mts';

export const MAX_WATCH_NOTE = 200;
export type TaskEnd = 'merged' | 'completed' | 'cancelled';
export interface Watch { memberId: string; note: string | null; createdAt: string }

/** Where a task ends: merged, cancelled, or completed when it needs no merge. A completed task awaiting its merge has not. */
export function taskEnd(store: Store, task: Task): TaskEnd | null {
  if (task.status === 'merged' || task.status === 'cancelled') return task.status;
  return task.status === 'completed' && !task.mergeRequired && completionValid(store, task) ? 'completed' : null;
}

type Row = Record<string, unknown>;
const toWatch = (row: Row): Watch => ({ memberId: String(row.member_id), note: row.note == null ? null : String(row.note), createdAt: String(row.created_at) });

/** The task's watches by members still in the cluster, oldest first. */
export function taskWatches(store: Pick<Store, 'db'>, taskId: string): Watch[] {
  return store.db.prepare(`SELECT w.member_id, w.note, w.created_at FROM task_watches w JOIN members m ON m.id = w.member_id
      WHERE w.task_id = ? AND m.removed_at IS NULL ORDER BY w.rowid`).all(taskId).map(toWatch);
}

export function memberWatch(store: Pick<Store, 'db'>, taskId: string, memberId: string): Watch | null {
  return taskWatches(store, taskId).find((watch) => watch.memberId === memberId) ?? null;
}

/** One-shot: the task's watches, removed. Called when the task reaches its end. */
export function takeWatches(store: Pick<Store, 'db'>, taskId: string): Watch[] {
  const watches = taskWatches(store, taskId);
  store.db.prepare('DELETE FROM task_watches WHERE task_id = ?').run(taskId);
  return watches;
}

/** The memberRemoved hook: a member removed from its cluster loses its watches. */
export function forgetMemberWatches(store: Pick<Store, 'db'>, _clusterId: string, memberId: string): void {
  store.db.prepare('DELETE FROM task_watches WHERE member_id = ?').run(memberId);
}

const note = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return fail('INVALID_REQUEST', 'note must be a string');
  const text = value.trim();
  if (text.length > MAX_WATCH_NOTE) return fail('INVALID_REQUEST', `note must be at most ${MAX_WATCH_NOTE} characters`);
  return text || null;
};

export function runWatchAction(ctx: PluginActionContext): Record<string, unknown> {
  const { store, actor, actorId, clusterId, command, now } = ctx;
  if (actor.kind !== 'member') return fail('FORBIDDEN', 'only a member can watch a task');
  const task = taskOf(store, clusterId, command.taskId);
  ctx.outcome.payload = () => ({ action: command.action, watchedTaskId: task.id });
  if (command.action === 'task.unwatch') {
    const removed = store.db.prepare('DELETE FROM task_watches WHERE task_id = ? AND member_id = ?').run(task.id, actorId).changes > 0;
    return { taskId: task.id, watch: null, removed };
  }
  const end = taskEnd(store, task);
  if (end) return fail('INVALID_STATE', `task has already ended (${end}); there is nothing left to watch`);
  const text = note(command.note);
  store.db.prepare(`INSERT INTO task_watches (task_id, member_id, note, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id, member_id) DO UPDATE SET note = excluded.note`).run(task.id, actorId, text, now);
  return { taskId: task.id, watch: memberWatch(store, task.id, actorId) };
}

const END_LABELS: Record<TaskEnd, string> = { merged: '已合并', completed: '已完成', cancelled: '已取消' };

export function watchNoticeBody(task: Task, end: TaskEnd, seq: number, watchers: { name: string; note: string | null }[]): string {
  const commit = end === 'merged' && task.mergedCommitSha ? `（合并提交 ${task.mergedCommitSha}）` : '';
  const quoted = (note: string) => note.replace(/\s+/g, ' ').replaceAll('@', '＠');
  const who = watchers.map(({ name, note }) => note ? `${name}（备注「${quoted(note)}」）` : name).join('、');
  return `关注的任务${task.number ? ` #${task.number}` : ''}【${task.title}】（${task.id}）${END_LABELS[end]}${commit}，事件 ${seq}。关注者：${who}。`;
}
