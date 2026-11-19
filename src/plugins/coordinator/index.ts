// The coordinator (Super Agent): who coordinates a cluster and with what permissions, the rules text, handover
// summaries, and where a user's message that names nobody goes (docs/plugins.md, docs/collaboration.md).
import type { CollaborationCommand } from '../../core/collaboration-types.ts';
import type { CoordinatorView, OfficialPlugin, PluginRefContext } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import { changeInstructions, coordinatorBriefing, disableRemovedCoordinator, setCoordinator } from './actions.ts';
import { COORDINATOR_RULES } from './coordinator-rules.ts';
import { coordinatorSnapshot } from './store.ts';

// References are checked by the actions themselves; an entry keeps a stray messageId from being resolved like a plugin message ref.
const noRefs = ({ command }: PluginRefContext): CollaborationCommand => command;
const COORDINATOR_ACTIONS = ['coordinator.set', 'coordinator.instruction.add', 'coordinator.instruction.edit', 'coordinator.instruction.remove'];

const view = (store: Store): CoordinatorView => {
  const policy = (clusterId: string) => coordinatorSnapshot(store, clusterId).coordinator;
  return {
    policy,
    generation: (clusterId) => coordinatorSnapshot(store, clusterId).generation,
    rules: COORDINATOR_RULES,
    unaddressedRecipient: ({ clusterId, from, body, members }) => {
      // Only the user's: a member who needs the coordinator names it; other member chat stays in the record.
      if (from !== 'user') return null;
      const coordinator = policy(clusterId);
      if (!coordinator?.enabled || !members.some((m) => m.id === coordinator.memberId)) return null;
      return /(^|[^A-Za-z0-9])@/.test(body) ? null : coordinator.memberId;
    },
    envelopeHint: (member) => {
      const coordinator = policy(member.clusterId);
      if (!coordinator?.enabled || coordinator.memberId !== member.id) return '';
      const standing = (coordinator.standingInstructions ?? []).length;
      return `\n\n你是本群协调员，规则版本 ${COORDINATOR_RULES.version}；完整规则用 list_tasks 加 include: ['rules'] 读取。`
        + (standing ? `\n用户长期要求见 list_tasks 的 coordinator.standingInstructions（${standing} 条）。` : '');
    },
    envelopeNote: (message) => (!message.mentions.length && message.from === 'user'
      ? '\n这是群里没有点名任何人的用户消息；你作为本群协调员收到它，请判断其中是否有需要安排的工作。' : ''),
    turnLimit: (member, limits) => {
      const coordinator = policy(member.clusterId);
      return coordinator?.enabled && coordinator.memberId === member.id ? limits.maxCoordinatorTurnsPerHour : limits.maxTurnsPerHour;
    },
    rebound: (member, hubPaused) => {
      const coordinator = policy(member.clusterId);
      if (!coordinator?.enabled || store.getMember(coordinator.memberId)?.clusterId !== member.clusterId) return { alsoTell: null, lines: [], taskIds: [] };
      if (coordinator.memberId !== member.id) return { alsoTell: coordinator.memberId, lines: [], taskIds: [] };
      const briefing = coordinatorBriefing(store, member, hubPaused);
      return { alsoTell: null, lines: [`你继续担任本群协调员（第 ${coordinator.generation} 代）。`, ...briefing.lines], taskIds: briefing.taskIds };
    },
    disableIfRemoved: (hub, clusterId, emit, targetMemberId) => disableRemovedCoordinator(hub, store, clusterId, emit, targetMemberId),
  };
};

export const coordinator: OfficialPlugin = {
  id: 'coordinator',
  version: '0.10.0-beta.2',
  name: '协调员',
  description: 'Beta 测试版。让一名成员按授权协调本群：主动派工、收用户未点名的消息、交接时带上摘要；关闭后没写收件人的消息只留在群聊记录里。',
  requires: ['tasks'],
  icon: 'coordinator.svg',
  details: `在任务工作台里指定一名成员做本群的协调员，并按你给的授权替你协调这个群。

**提供**
- 协调员按授权派工、验收和管理任务；你的长期要求随规则一起交给它
- 没写收件人的消息交给协调员处理
- 换协调员或协调员换对话时，自动带上交接摘要
- 协调员的每小时轮次上限高于普通成员；设置里的“协调员通知”（成员无活动提醒）

**关闭后**
没写收件人的消息只留在群聊记录里；所有成员按普通的每小时轮次上限；工作台和设置里的协调员部分隐藏。协调员设置保留，重新启用后都在。

需要先启用任务系统。`,
  actions: {
    'coordinator.set': setCoordinator,
    'coordinator.instruction.add': changeInstructions,
    'coordinator.instruction.edit': changeInstructions,
    'coordinator.instruction.remove': changeInstructions,
  },
  refs: {
    'coordinator.set': noRefs,
    'coordinator.instruction.add': noRefs,
    'coordinator.instruction.edit': noRefs,
    'coordinator.instruction.remove': noRefs,
  },
  coordinatorView: view,
  // The standing instructions' text stays out: it is the user's brief to the coordinator, not cluster chat.
  eventSource: (store) => ({ types: [{
    type: 'coordinator.changed', from: 'collaboration',
    description: '本群协调员被设置、更换、停用，或用户的长期要求被增删改。',
    fields: 'clusterId, action, memberId（协调员；没有时为 null）, enabled, mode（suggest 或 execute）, generation, permissions（八项委托权限的开关）, instructionCount, by, at',
    build: (event) => {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      if (p.suggested || typeof p.action !== 'string' || !COORDINATOR_ACTIONS.includes(p.action)) return null;
      const { coordinator: policy, generation } = coordinatorSnapshot(store, event.clusterId!);
      return { clusterId: event.clusterId, action: p.action, memberId: policy?.memberId ?? null, enabled: policy?.enabled ?? false,
        mode: policy?.mode ?? null, generation, permissions: policy ? { ...policy.permissions } : null,
        instructionCount: policy?.standingInstructions?.length ?? 0, by: event.memberId ?? null, at: event.createdAt };
    },
  }] }),
};
