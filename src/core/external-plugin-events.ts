// The only place a Hub event becomes what a third-party plugin sees. Copy each field by name: never spread a Hub payload here.
import type { ExternalEventType } from './external-plugin-config.ts';
import type { ExternalEvent } from './external-plugin-process.ts';
import type { Store } from './store.ts';
import type { HubEvent, Member, Message } from './types.ts';

function taskEventTypes(action: string | undefined, verdict: string | undefined): ExternalEventType[] {
  // A self-reviewed task is submitted and approved in one action, and a plugin waiting for approvals must still see it.
  if (action === 'task.submit') return verdict === 'approve' ? ['task.submitted', 'task.approved'] : ['task.submitted'];
  if (action === 'task.review') return verdict === 'approve' ? ['task.approved'] : verdict === 'reject' ? ['task.rejected'] : [];
  if (action === 'task.merge' || action === 'task.shipped') return ['task.merged'];
  return [];
}

export class ExternalEventTranslator {
  // shortcut: a deleted cluster's members stay here until the Hub restarts (one short entry each), evict on 'cluster' events if clusters churn.
  private readonly lastStatus = new Map<string, Member['status']>();
  private readonly store: Store;

  constructor(store: Store) { this.store = store; }

  /**
   * Most 'member' events report no status change, and a status is computed, not stored, so "changed" needs a real
   * previous value. The composition root gives the status of every member that exists when the Hub starts.
   * Always overwrites: a restored cluster's members may have changed while it was in the recycle bin.
   */
  baseline(members: readonly Pick<Member, 'id' | 'status'>[]): void {
    for (const member of members) this.lastStatus.set(member.id, member.status);
  }

  translate(event: HubEvent, clusterId: string): ExternalEvent[] {
    if (event.kind === 'message') {
      const { message } = event.payload as { message: Message };
      return [{ type: 'message.created', data: { clusterId, messageId: message.id, from: message.from, mentions: [...message.mentions],
        createdAt: message.createdAt, kind: message.kind === 'task_comment' || message.kind === 'system' || message.kind === 'plugin' ? message.kind : null } }];
    }
    if (event.kind === 'collaboration') {
      const payload = event.payload as { action?: string; taskId?: string; verdict?: string; suggested?: boolean };
      const types = payload.suggested || !payload.taskId ? [] : taskEventTypes(payload.action, payload.verdict);
      // No tasks plugin, no store.tasks and no such actions.
      const task = types.length ? this.store.tasks?.task(clusterId, payload.taskId!) : null;
      if (!task) return [];
      return types.map((type) => ({ type, data: { clusterId, taskId: task.id, title: task.title, status: task.status, at: event.createdAt } }));
    }
    // Only a created or restored cluster lists members here, each with its current status: that is their baseline.
    if (event.kind === 'cluster') this.baseline((event.payload as { members: Member[] }).members);
    if (event.kind === 'member') {
      const { member } = event.payload as { member: Member };
      const before = this.lastStatus.get(member.id);
      if (member.removedAt) this.lastStatus.delete(member.id); else this.lastStatus.set(member.id, member.status);
      // Every member that existed at startup has a baseline, so an unknown one was just added: that is not a change.
      if (before === undefined || before === member.status) return [];
      return [{ type: 'member.status', data: { clusterId, memberId: member.id, name: member.name, status: member.status, at: event.createdAt } }];
    }
    return [];
  }
}
