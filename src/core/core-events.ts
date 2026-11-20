// The core's own event types for third-party plugins (docs/external-plugins.md「事件目录」). Every field is copied by name
// from a whitelist: never spread a Hub payload, a Member or a Message here (session ids, working folders, file paths,
// tokens and fields added later must not leak). Official plugins declare their own types (OfficialPlugin.eventSource).
//
// Hub event kinds NOT exposed, and why:
// - agent: what an adapter observed of a delivered turn (model text, tool names and arguments); arguments can hold local paths
//   and secrets, and what a member says to the cluster arrives as message.created anyway.
// - settings: Hub-wide configuration (limits, usage alert, sidebar groups); group names can name clusters outside a
//   plugin's whitelist, and no plugin acts on them.
// - usage: token counts and subscription quota of the user's harness accounts: account data, not collaboration.
// - unread_hint, delivery_dismissed: page hints (an unread count, the user's 标为已知), derivable or page-only.
// - a cluster's creation and deletion: a new cluster is in no whitelist, and a deleted one gets no events.
import type { EventSource, EventTypeSpec, MemberBaseline } from './event-registry.ts';
import type { Store } from './store.ts';
import type { Delivery, FileInfo, HubEvent, Member, Message } from './types.ts';

/** Same cut as host.messages.list. */
export const MAX_EVENT_BODY_CHARS = 8000;

/** Shared by message events and host queries. Hub-generated templates can contain internal binding or error details. */
export function pluginMessageBody(message: Pick<Message, 'from' | 'kind' | 'body'>):
  { body: string; bodyOmitted?: true; bodyTruncated?: true } {
  if (message.from === 'system' || ['system', 'handover', 'handoff', 'resend'].includes(message.kind ?? '')) {
    return { body: '', bodyOmitted: true };
  }
  const long = message.body.length > MAX_EVENT_BODY_CHARS;
  return { body: long ? message.body.slice(0, MAX_EVENT_BODY_CHARS).toWellFormed() : message.body,
    ...(long ? { bodyTruncated: true } : {}) };
}

type Payload = Record<string, unknown>;
const payloadOf = (event: HubEvent): Payload => (event.payload && typeof event.payload === 'object' ? event.payload as Payload : {});
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
/** Only these scalar fields of a guard payload; anything else (task ids, plugin details, future fields) stays inside. */
const GUARD_FIELDS = ['chainId', 'hop', 'maxHops', 'maxTurnsPerChain', 'maxTurnsPerHour', 'maxNoticeBatchesPerHour', 'pluginId', 'window', 'limit'] as const;

interface Seen { status: Member['status']; name?: string; hidden?: boolean }

/** The kinds an old plugin knew in message.created; the others (handover, handoff, resend) read as an ordinary message. */
const legacyKind = (kind: Message['kind']) => (kind === 'task_comment' || kind === 'system' || kind === 'plugin' ? kind : null);

export function coreEventSource(store: Store): EventSource {
  // shortcut: a deleted cluster's members stay here until the Hub restarts (one short entry each), evict on 'cluster' events if clusters churn.
  const seen = new Map<string, Seen>();
  const remember = (m: MemberBaseline) => seen.set(m.id, { status: m.status,
    ...(m.name === undefined ? {} : { name: m.name }), ...(m.hiddenAt === undefined ? {} : { hidden: !!m.hiddenAt }) });
  const memberOf = (event: HubEvent): Member | null => {
    const member = payloadOf(event).member as Member | undefined;
    return member && typeof member.id === 'string' ? member : null;
  };
  const by = (event: HubEvent) => event.memberId ?? null;
  const privateMessage = (id: unknown) => typeof id === 'string' && store.getMessage(id)?.privateTo !== undefined;
  const collab = (event: HubEvent, actions: readonly string[]) => {
    const p = payloadOf(event);
    return !p.suggested && typeof p.action === 'string' && actions.includes(p.action) ? p : null;
  };

  const types: EventTypeSpec[] = [
    {
      type: 'message.created', from: 'message', body: true,
      description: '群里出现一条新消息（群员、用户、系统通知或插件发的）。',
      fields: 'clusterId, messageId, from, mentions, createdAt, kind（null、task_comment、system 或 plugin）, messageKind（原始种类，含 handover、handoff、resend）, replyTo, chainId, hop, fyi, '
        + 'systemKind, recipients（收到投递的成员 ID）, attachments（[{id,name,mime,size}]，没有文件内容和路径）；有本群 messages.read 时普通文本另有 body（超过 8000 字截断并带 bodyTruncated），Hub 合成正文省略并标 bodyOmitted；'
        + '这次发言的检查问过本插件时另有 checkId',
      build: (event, { withBody }) => {
        const p = payloadOf(event);
        const message = p.message as Message | undefined;
        if (!message || typeof message.id !== 'string' || message.privateTo !== undefined) return null;
        const deliveries = Array.isArray(p.deliveries) ? p.deliveries as Delivery[] : [];
        const files = Array.isArray(p.attachments) ? p.attachments as FileInfo[] : [];
        const content = withBody && typeof message.body === 'string' ? pluginMessageBody(message) : null;
        return {
          clusterId: event.clusterId, messageId: message.id, from: message.from, mentions: [...(message.mentions ?? [])],
          createdAt: message.createdAt, kind: legacyKind(message.kind),
          messageKind: message.kind ?? 'chat', replyTo: message.replyTo ?? null, chainId: message.chainId ?? null, hop: message.hop ?? null,
          fyi: message.fyi === true, systemKind: message.systemKind ?? null,
          recipients: deliveries.flatMap((d) => (typeof d?.memberId === 'string' ? [d.memberId] : [])),
          attachments: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
          ...(content?.bodyOmitted ? { bodyOmitted: true } : content ?? {}),
        };
      },
    },
    {
      type: 'message.read', from: 'read',
      description: '成员读到了消息（投递、read_messages、ack_messages 或跳过）。',
      fields: 'clusterId, memberId, messageIds, via（delivery、read_messages、ack_messages 或 skip）, at',
      build: (event) => {
        const p = payloadOf(event);
        if (!Array.isArray(p.messageIds)) return null;
        const messageIds = p.messageIds.filter((id) => typeof id === 'string' && !privateMessage(id));
        if (!messageIds.length) return null;
        return { clusterId: event.clusterId, memberId: str(p.memberId) ?? event.memberId, messageIds,
          via: str(p.via), at: event.createdAt };
      },
    },
    {
      type: 'message.acknowledged', from: 'acknowledgement',
      description: '成员确认处理了消息（ack_messages）。',
      fields: 'clusterId, memberId, messageIds, at',
      build: (event) => {
        const list = payloadOf(event).acknowledgements;
        if (!Array.isArray(list)) return null;
        const messageIds = list.flatMap((a) => (typeof a?.messageId === 'string' && !privateMessage(a.messageId) ? [a.messageId] : []));
        if (!messageIds.length) return null;
        return { clusterId: event.clusterId, memberId: event.memberId, messageIds, at: event.createdAt };
      },
    },
    {
      type: 'member.status', from: 'member',
      description: '成员状态变化（idle、busy、offline）。改名等不改变状态的更新不推。',
      fields: 'clusterId, memberId, name, status, at',
      build: (event) => {
        const member = memberOf(event);
        const before = member && seen.get(member.id);
        // Every member that existed at startup has a baseline, so an unknown one was just added: that is not a change.
        if (!member || !before || before.status === member.status) return null;
        return { clusterId: event.clusterId, memberId: member.id, name: member.name, status: member.status, at: event.createdAt };
      },
    },
    {
      type: 'member.joined', from: 'member',
      description: '群里加入了一名成员。',
      fields: 'clusterId, memberId, name, harness, status, hidden, at',
      build: (event) => {
        const member = memberOf(event);
        if (!member || member.removedAt || seen.has(member.id)) return null;
        return { clusterId: event.clusterId, memberId: member.id, name: member.name, harness: member.harness,
          status: member.status, hidden: !!member.hiddenAt, at: event.createdAt };
      },
    },
    {
      type: 'member.removed', from: 'member',
      description: '成员被移出群。',
      fields: 'clusterId, memberId, name, at',
      build: (event) => {
        const member = memberOf(event);
        if (!member?.removedAt || !seen.has(member.id)) return null;
        return { clusterId: event.clusterId, memberId: member.id, name: member.name, at: event.createdAt };
      },
    },
    {
      type: 'member.updated', from: 'member',
      description: '成员改名、隐身或取消隐身。',
      fields: 'clusterId, memberId, name, hidden, at',
      build: (event) => {
        const member = memberOf(event);
        const before = member && seen.get(member.id);
        if (!member || !before || member.removedAt) return null;
        const renamed = before.name !== undefined && before.name !== member.name;
        const hidden = !!member.hiddenAt;
        if (!renamed && (before.hidden === undefined || before.hidden === hidden)) return null;
        return { clusterId: event.clusterId, memberId: member.id, name: member.name, hidden, at: event.createdAt };
      },
    },
    {
      type: 'cluster.updated', from: 'cluster',
      description: '群改名、改分组、置顶、归档、用户已读位置前进，或群从回收站恢复。',
      fields: 'clusterId, name, category, pinned, archived, userReadMessageId, at',
      build: (event) => {
        const cluster = payloadOf(event).cluster as { name?: unknown; category?: unknown; pinnedAt?: unknown; archivedAt?: unknown;
          deletedAt?: unknown; userReadMessageId?: unknown } | undefined;
        if (!cluster || cluster.deletedAt) return null;
        return { clusterId: event.clusterId, name: str(cluster.name), category: str(cluster.category) ?? '', pinned: !!cluster.pinnedAt,
          archived: !!cluster.archivedAt, userReadMessageId: privateMessage(cluster.userReadMessageId) ? null : str(cluster.userReadMessageId),
          at: event.createdAt };
      },
    },
    {
      type: 'cluster.paused', from: 'collaboration',
      description: '群被暂停或恢复投递。',
      fields: 'clusterId, paused, by（操作的成员 ID；用户为 null）, at',
      build: (event) => {
        const p = collab(event, ['cluster.pause']);
        return p && typeof p.paused === 'boolean' ? { clusterId: event.clusterId, paused: p.paused, by: by(event), at: event.createdAt } : null;
      },
    },
    {
      type: 'hub.paused', from: 'pause', scope: 'global',
      description: '用户打开或关闭了“暂停全部投递”。全局事件，不属于任何群。',
      fields: 'paused, at',
      build: (event) => {
        const paused = payloadOf(event).paused;
        return typeof paused === 'boolean' ? { paused, at: event.createdAt } : null;
      },
    },
    {
      type: 'role.changed', from: 'collaboration',
      description: '群里的角色被新建、修改说明、删除，或补齐了默认角色。',
      fields: 'clusterId, action（role.create、role.edit、role.delete 或 role.ensure_defaults）, roleId, name, description（角色已删除时为 null）, by, at',
      build: (event) => {
        const p = collab(event, ['role.create', 'role.edit', 'role.delete', 'role.ensure_defaults']);
        if (!p) return null;
        const roleId = str(p.roleId);
        const role = roleId ? store.collaborationRoles(event.clusterId!).find((r) => r.id === roleId) : undefined;
        return { clusterId: event.clusterId, action: p.action, roleId, name: role?.name ?? null, description: role?.description ?? null,
          by: by(event), at: event.createdAt };
      },
    },
    {
      type: 'member.roles', from: 'collaboration',
      description: '成员的角色被修改。',
      fields: 'clusterId, memberId, roleIds（修改后的全部角色）, by, at',
      build: (event) => {
        const p = collab(event, ['member.roles']);
        const memberId = p && str(p.memberId);
        if (!memberId) return null;
        const roleIds = store.collaborationMemberRoles(event.clusterId!).find((m) => m.memberId === memberId)?.roleIds ?? [];
        return { clusterId: event.clusterId, memberId, roleIds: [...roleIds], by: by(event), at: event.createdAt };
      },
    },
    {
      type: 'delivery.updated', from: 'delivery',
      description: '一条投递的状态变化（排队、开始、完成、失败、离线、被取代）。',
      fields: 'clusterId, deliveryId, messageId, memberId, state, outcome, attempts, at（不含错误文字）',
      build: (event) => {
        const d = payloadOf(event).delivery as Delivery | undefined;
        if (!d || typeof d.id !== 'string' || privateMessage(d.messageId)) return null;
        return { clusterId: event.clusterId, deliveryId: d.id, messageId: d.messageId, memberId: d.memberId, state: d.state,
          outcome: d.outcome ?? null, attempts: d.attempts ?? 0, at: event.createdAt };
      },
    },
    {
      type: 'guard.triggered', from: 'guard',
      description: '防循环或限速上限被触发（跳数、轮次、插件发送或发布上限等）。',
      fields: 'clusterId, memberId（没有时为 null）, reason, at；按原因另有 chainId、hop、maxHops、maxTurnsPerChain、maxTurnsPerHour、maxNoticeBatchesPerHour、pluginId、window、limit',
      build: (event) => {
        const p = payloadOf(event);
        if (typeof p.reason !== 'string' || privateMessage(p.chainId)) return null;
        const extra: Record<string, unknown> = {};
        for (const key of GUARD_FIELDS) {
          const value = p[key];
          if (typeof value === 'number' || (typeof value === 'string' && value.length <= 128)) extra[key] = value;
        }
        return { clusterId: event.clusterId, memberId: event.memberId, reason: p.reason, ...extra, at: event.createdAt };
      },
    },
  ];

  return {
    types,
    baseline: (members) => { for (const m of members) remember(m); },
    observed: (event) => {
      // Only a created or restored cluster lists members here, each with its current state: that is their baseline.
      if (event.kind === 'cluster') {
        const members = payloadOf(event).members;
        if (Array.isArray(members)) for (const m of members as Member[]) if (m && typeof m.id === 'string') remember(m);
      }
      if (event.kind === 'member') {
        const member = memberOf(event);
        if (member?.removedAt) seen.delete(member.id); else if (member) remember(member);
      }
    },
  };
}
