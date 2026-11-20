// coordinator.set and the standing instructions, and what a change of coordinator tells the people involved.
import { randomUUID } from 'node:crypto';
import { COORDINATOR_RULES } from './coordinator-rules.mts';
import {
  host, type ActionContextLike, type CoordinatorPermissions, type CoordinatorPolicy, type HubEventLike,
  type HubLike, type MemberLike, type StandingInstruction, type StoreLike, type TaskLike,
} from './host.mts';
import { coordinatorSnapshot, saveCoordinator } from './store.mts';

const fail = (code: string, message: string): never => { throw new (host().collaboration.CollaborationError)(code, message); };

const DEFAULT_PERMISSIONS: CoordinatorPermissions = {
  taskPlanning: true, assignment: true, roleManagement: true, reviewerManagement: true,
  knowledgeCommunication: true, recovery: true, cancelReopen: false, deliveryControl: false,
};
const MAX_STANDING_INSTRUCTION_TEXT = 500;
const MAX_STANDING_INSTRUCTIONS = 50;

export const setCoordinator = ({ store, actor, clusterId, command, now, collaboration, hub, outcome, notice, afterCommit }: ActionContextLike) => {
  if (actor.kind !== 'user') return fail('FORBIDDEN', 'only the user can change coordinator policy; ask the user to change it');
  const previous = coordinatorSnapshot(store, clusterId);
  if (command.memberId === null) {
    saveCoordinator(store, clusterId, null, previous.generation + 1);
    return { coordinator: null };
  }
  const member = collaboration.member(clusterId, command.memberId);
  // The coordinator is never hidden (docs/cluster-members.md「隐身」): a hidden member would receive nothing as one.
  if (member.hiddenAt && command.enabled === true) return fail('FORBIDDEN', `${member.name} is hidden; show it again before making it the coordinator`);
  if (typeof command.enabled !== 'boolean' || (command.mode !== 'suggest' && command.mode !== 'execute')) return fail('INVALID_REQUEST', 'enabled and mode are required');
  const permissions = { ...DEFAULT_PERMISSIONS, ...command.permissions };
  if (Object.keys(permissions).some((k) => !Object.hasOwn(DEFAULT_PERMISSIONS, k))
    || Object.values(permissions).some((v) => typeof v !== 'boolean')) return fail('INVALID_REQUEST', 'invalid coordinator permissions');
  if (command.taskPlanningRoleBypass !== undefined && typeof command.taskPlanningRoleBypass !== 'boolean') {
    return fail('INVALID_REQUEST', 'taskPlanningRoleBypass must be boolean');
  }
  const previousBypass = previous.coordinator?.memberId === member.id && previous.coordinator.taskPlanningRoleBypass === true;
  const taskPlanningRoleBypass = command.taskPlanningRoleBypass ?? previousBypass;
  // Long-term requirements survive a coordinator change; missing in old policies means [].
  const policy: CoordinatorPolicy = { memberId: member.id, enabled: command.enabled, mode: command.mode,
    permissions, generation: previous.generation + 1, ...(taskPlanningRoleBypass ? { taskPlanningRoleBypass: true } : {}),
    standingInstructions: previous.coordinator?.standingInstructions ?? [] };
  saveCoordinator(store, clusterId, policy, policy.generation);
  const previousMember = previous.coordinator?.memberId;
  outcome.afterEvent = (event: HubEventLike) => {
    if (policy.enabled && previousMember && previousMember !== member.id) {
      const publish = handover(hub, store, clusterId, event, previousMember, member.id, policy.generation, now);
      if (publish) afterCommit(publish);
    }
    if (policy.enabled) {
      const body = `协调员已改为 ${host().collaboration.personName(store, clusterId, command.memberId)}（${command.mode === 'suggest' ? '建议模式' : '授权执行'}），事件 ${event.seq}。\n协调规则 ${COORDINATOR_RULES.version}：\n${COORDINATOR_RULES.text}`;
      notice(event, { body, recipients: [member.id], systemKind: 'coordinator' });
    }
  };
  return { coordinator: policy };
};

export const changeInstructions = ({ store, actorId, clusterId, command, now, management }: ActionContextLike) => {
  const suggest = management('knowledgeCommunication');
  const snapshot = coordinatorSnapshot(store, clusterId);
  const policy = snapshot.coordinator;
  if (!policy) return fail('INVALID_STATE', 'enable a coordinator before changing standing instructions');
  if (suggest) return {};
  const instructions: StandingInstruction[] = [...(policy.standingInstructions ?? [])];
  const text = typeof command.instructionText === 'string' ? command.instructionText.trim() : '';
  if (command.action === 'coordinator.instruction.add') {
    if (!text) return fail('INVALID_REQUEST', 'instructionText is required');
    if (text.length > MAX_STANDING_INSTRUCTION_TEXT) return fail('INVALID_REQUEST', `instructionText must be at most ${MAX_STANDING_INSTRUCTION_TEXT} characters`);
    if (instructions.length >= MAX_STANDING_INSTRUCTIONS) return fail('INVALID_REQUEST', `at most ${MAX_STANDING_INSTRUCTIONS} standing instructions`);
    instructions.push({ id: randomUUID(), text, createdBy: actorId, createdAt: now });
  } else {
    const found = instructions.find((item) => item.id === command.instructionId);
    if (!found) return fail('OUT_OF_SCOPE', 'unknown standing instruction; list_tasks with include: ["rules"] shows them');
    if (command.action === 'coordinator.instruction.remove') instructions.splice(instructions.indexOf(found), 1);
    else {
      if (!text) return fail('INVALID_REQUEST', 'instructionText is required');
      if (text.length > MAX_STANDING_INSTRUCTION_TEXT) return fail('INVALID_REQUEST', `instructionText must be at most ${MAX_STANDING_INSTRUCTION_TEXT} characters`);
      found.text = text;
    }
  }
  const next: CoordinatorPolicy = { ...policy, standingInstructions: instructions };
  saveCoordinator(store, clusterId, next, snapshot.generation);
  return { coordinator: next };
};

/** A summary for the new coordinator, a goodbye for the old one, and the new one's pre-handover unread is skipped.
 * Messages are written in the command's transaction; publishing and scheduling run after it. */
function handover(hub: HubLike, store: StoreLike, clusterId: string, source: HubEventLike, oldMemberId: string, newMemberId: string,
  generation: number, at: string): (() => void) | undefined {
  const cluster = store.getCluster(clusterId);
  const oldMember = store.getMember(oldMemberId, { includeRemoved: true });
  const newMember = store.getMember(newMemberId);
  if (!cluster || !oldMember || !newMember) return undefined;
  const briefing = coordinatorBriefing(store, oldMember, hub.isPaused());
  const write = (recipientId: string, body: string, taskIds: string[] = []) => hub.writeSystemMessage(clusterId, [recipientId], body, taskIds, source.seq, 'coordinator');
  // Capture the pre-handover unread before writing anything: the summary and later user messages must stay unread.
  const skipped = store.unreadIds(newMember.id, clusterId, { until: at });
  const notifyNew = write(newMember.id, [`你是本群的新协调员（第 ${generation} 代）。`, ...briefing.lines].join('\n'), briefing.taskIds);
  const notifyOld = write(oldMember.id, `你已卸任协调员，现任是 ${newMember.name}，代次 ${generation}。`);
  return () => {
    notifyNew();
    notifyOld();
    if (skipped.length) hub.skipMessages(newMember, skipped);
  };
}

/** What whoever takes over as coordinator needs to know; `previous` is who held the post. */
export function coordinatorBriefing(store: StoreLike, previous: Pick<MemberLike, 'id' | 'clusterId'>, hubPaused: boolean): { lines: string[]; taskIds: string[] } {
  const { personName } = host().collaboration;
  const { OPEN_STATUS_LABEL } = host().hub;
  const clusterId = previous.clusterId;
  const snapshot = coordinatorSnapshot(store, clusterId);
  const paused = store.clusterPause(clusterId).paused;
  const view = store.tasks;
  const tasks = (view?.all(clusterId) ?? []).filter((task) => task.proposalState === 'active');
  const nameOf = (id: string | null | undefined) => id ? personName(store, clusterId, id) : '无';   // stored: a hidden member is not named
  const ownerName = (task: TaskLike) => task.assignedMemberId ? nameOf(task.assignedMemberId) : '未分配';
  const reviewerName = (task: TaskLike) => task.reviewer.kind === 'member' ? nameOf(task.reviewer.memberId) : task.reviewer.kind === 'self' ? '自查' : '用户';
  const instructions = snapshot.coordinator?.standingInstructions ?? [];
  const unresolved: string[] = [];
  for (const task of tasks) for (const question of view!.unresolvedQuestions(task.id)) unresolved.push(`任务${task.number ? ` #${task.number}` : ''}「${task.title}」：${question}`);
  const groups = Object.keys(OPEN_STATUS_LABEL).map((status) => ({
    status, tasks: tasks.filter((task) => task.status === status),
  })).filter((group) => group.tasks.length);
  const oldLast = [...store.listMessages(clusterId, 1000)].reverse()
    .find((message) => message.from === previous.id)?.createdAt ?? null;
  const lines = [
    instructions.length
      ? `用户长期要求：\n${instructions.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`
      : '用户长期要求：无',
    ...(view ? [unresolved.length ? `待处理事项：\n${unresolved.map((line) => `- ${line}`).join('\n')}` : '待处理事项：无',
      '未完成任务：',
      ...(groups.length ? groups.map((group) => `- ${OPEN_STATUS_LABEL[group.status]}：${group.tasks
        .map((task) => `${task.number ? `#${task.number} ` : ''}「${task.title}」（负责人 ${ownerName(task)} / 验收人 ${reviewerName(task)}）`).join('、')}`) : ['无'])] : []),
    `群暂停：${paused ? '是' : '否'}；全局暂停：${hubPaused ? '是' : '否'}。`,
    `前任最后一条发言时间：${oldLast ?? '无'}。`,
  ];
  return { lines, taskIds: tasks.filter((task) => OPEN_STATUS_LABEL[task.status]).map((task) => task.id) };
}

/** Disable an enabled coordinator whose member is removed or missing (once, keeping memberId and incrementing generation). */
export function disableRemovedCoordinator(
  hub: HubLike,
  store: StoreLike,
  clusterId: string,
  emit: { event: (e: any) => void; afterCommit: (fn: () => void) => void },
  targetMemberId?: string,
): void {
  const snapshot = coordinatorSnapshot(store, clusterId);
  const policy = snapshot.coordinator;
  if (!policy?.enabled) return;
  if (targetMemberId !== undefined && policy.memberId !== targetMemberId) return;
  const member = store.getMember(policy.memberId, { includeRemoved: true });
  if (member && !member.removedAt && member.clusterId === clusterId) return;
  const next: CoordinatorPolicy = { ...policy, enabled: false, generation: snapshot.generation + 1 };
  saveCoordinator(store, clusterId, next, next.generation);
  const event = store.appendCollaborationEvent(clusterId, null, {
    action: 'coordinator.set', memberId: policy.memberId, enabled: false, mode: policy.mode, coordinator: next,
  });
  emit.event(event);
  const removedName = member?.name ?? policy.memberId;
  emit.afterCommit(hub.writeSystemMessage(
    clusterId, [], `协调员 ${removedName} 已被移出，协调功能已停用，不 @ 任何人的消息将只留在群聊记录里`, [], event.seq, 'coordinator',
  ));
}
