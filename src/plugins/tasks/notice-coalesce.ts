// Group a delivery batch without reading the Store or changing deliveries.
import type { Task } from '../../core/collaboration-types.ts';
import type { HubEvent, Message } from '../../core/types.ts';

export interface NoticeInput {
  message: Message;
  taskIds: readonly string[];
  event?: HubEvent | null;
}

export type NoticeTask = Pick<Task, 'id' | 'clusterId' | 'title' | 'status' | 'assignedMemberId' | 'reviewer'>;

export interface NoticeItem {
  notice: NoticeInput;
  supersededBy?: { messageId: string; eventId: number; reason: 'nomination_changed' | 'status_changed' };
}

export type NoticeSection =
  | { kind: 'task'; clusterId: string; taskId: string; task: NoticeTask | null; items: NoticeItem[] }
  | { kind: 'message'; items: [NoticeItem] };

type Payload = Record<string, unknown>;

function verified(input: NoticeInput): { event: HubEvent; payload: Payload; taskId: string } | null {
  const { message, event } = input;
  if (message.from !== 'system' || message.kind !== 'system' || !event || event.kind !== 'collaboration'
    || event.clusterId !== message.clusterId || event.seq !== message.collabEventId || !Number.isSafeInteger(event.seq)
    || event.seq < 1 || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  const payload = event.payload as Payload;
  if (typeof payload.action !== 'string' || !payload.action.startsWith('task.')
    || typeof payload.taskId !== 'string' || !payload.taskId || !input.taskIds.includes(payload.taskId)) return null;
  return { event, payload, taskId: payload.taskId };
}

type Replacement = { type: 'nomination' | 'status'; value: string | null };

function replacement(payload: Payload): Replacement | null {
  if (payload.suggested !== undefined && payload.suggested !== false) return null;
  switch (payload.action) {
    case 'task.assign': case 'task.nominate': {
      // The existing event payload omits memberId when an executor is cleared.
      if (!Object.hasOwn(payload, 'memberId') || payload.memberId === null) return { type: 'nomination', value: null };
      return typeof payload.memberId === 'string' && payload.memberId
        ? { type: 'nomination', value: payload.memberId } : null;
    }
    case 'task.claim': return { type: 'status', value: 'accepted' };
    case 'task.start': return { type: 'status', value: 'working' };
    case 'task.submit': return { type: 'status', value: 'review' };
    case 'task.review': return payload.verdict === 'approve' ? { type: 'status', value: 'completed' }
      : payload.verdict === 'reject' ? { type: 'status', value: 'working' } : null;
    case 'task.mark_completed': case 'task.ship_failed': case 'task.ship_fix': return { type: 'status', value: 'completed' };
    case 'task.merge': case 'task.shipped': case 'task.mark_merged': return { type: 'status', value: 'merged' };
    case 'task.release': case 'task.handoff': case 'task.reopen': return { type: 'status', value: 'pending' };
    case 'task.cancel': return { type: 'status', value: 'cancelled' };
    // A takeover of a pending task changes its executor; of a started one, its status (back to working).
    case 'task.takeover': {
      const takeover = payload.takeover as { previousStatus?: unknown; toMemberId?: unknown } | undefined;
      if (takeover?.previousStatus === 'pending') return typeof takeover.toMemberId === 'string' ? { type: 'nomination', value: takeover.toMemberId } : null;
      return { type: 'status', value: 'working' };
    }
    default: return null;
  }
}

/** Mark only changes proved by a later event, independently for nomination and status. */
function markSuperseded(items: NoticeItem[]): void {
  const candidates = items.flatMap((item) => {
    const match = verified(item.notice);
    const change = match && replacement(match.payload);
    return match && change ? [{ item, eventId: match.event.seq, ...change }] : [];
  }).sort((a, b) => a.eventId - b.eventId);
  const pending = new Map<Replacement['type'], { value: string | null; items: NoticeItem[] }>();
  for (let i = 0; i < candidates.length;) {
    let end = i + 1;
    while (end < candidates.length && candidates[end].eventId === candidates[i].eventId) end++;
    for (const type of ['nomination', 'status'] as const) {
      const changes = candidates.slice(i, end).filter((candidate) => candidate.type === type);
      if (!changes.length || changes.some((change) => change.value !== changes[0].value)) continue;
      const previous = pending.get(type);
      if (previous && previous.value !== changes[0].value) {
        for (const item of previous.items) item.supersededBy = {
          messageId: changes[0].item.notice.message.id, eventId: changes[0].eventId,
          reason: type === 'nomination' ? 'nomination_changed' : 'status_changed',
        };
        pending.delete(type);
      }
      const same = pending.get(type);
      if (same) for (const change of changes) same.items.push(change.item);
      else pending.set(type, { value: changes[0].value, items: changes.map((change) => change.item) });
    }
    i = end;
  }
}

/** First-seen task sections, with original batch order inside each section and untouched individual notices. */
export function coalesceNotices(inputs: readonly NoticeInput[], tasks: readonly NoticeTask[] = []): NoticeSection[] {
  const sections: NoticeSection[] = [];
  const byCluster = new Map<string, Map<string, Extract<NoticeSection, { kind: 'task' }>>>();
  const taskByCluster = new Map<string, Map<string, NoticeTask>>();
  for (const task of tasks) {
    if (!taskByCluster.has(task.clusterId)) taskByCluster.set(task.clusterId, new Map());
    taskByCluster.get(task.clusterId)!.set(task.id, task);
  }
  for (const notice of inputs) {
    const item: NoticeItem = { notice };
    const match = verified(notice);
    if (!match) { sections.push({ kind: 'message', items: [item] }); continue; }
    const clusterId = notice.message.clusterId;
    if (!byCluster.has(clusterId)) byCluster.set(clusterId, new Map());
    const groups = byCluster.get(clusterId)!;
    let section = groups.get(match.taskId);
    if (!section) {
      section = { kind: 'task', clusterId, taskId: match.taskId,
        task: taskByCluster.get(clusterId)?.get(match.taskId) ?? null, items: [] };
      groups.set(match.taskId, section);
      sections.push(section);
    }
    section.items.push(item);
  }
  for (const section of sections) if (section.kind === 'task') markSuperseded(section.items);
  return sections;
}
