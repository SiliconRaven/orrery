// The tasks plugin's background side: idle-task notices and stalled-member reminders.
// The notices are ordinary system messages to the enabled coordinator, through the Hub's normal delivery path; the
// stalled-member hint on the web page (stalledHints) is only read, never delivered.
import type { Assignment } from '../../core/collaboration-types.ts';
import { personName } from '../../core/collaboration.ts';
import type { Hub } from '../../core/hub.ts';
import type { PluginService } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import type { HubEvent, Member } from '../../core/types.ts';
import { waitsForBatch } from './batches.ts';
import { idleTaskCandidates, pairKey, type IdleCandidate, type ReviewCandidate } from './idle-candidates.ts';
import { hiddenWorkTasks } from './hidden.ts';
import { participantKeys, taskDependencyEvaluation } from './model.ts';
import { collaborationRecords, collaborationReminderTasks, type ReminderTask } from './store.ts';

/** Collaboration actions after which a cluster is checked for idle-task candidates (besides a member turning idle). */
const IDLE_TRIGGERS = new Set(['task.create', 'task.edit', 'task.assign', 'task.nominate', 'task.claim', 'task.submit', 'task.review', 'task.approve', 'task.merge', 'task.mark_completed', 'task.mark_merged', 'task.shipped', 'task.ship_failed',
  'task.release', 'task.handoff', 'task.takeover', 'task.reopen', 'coordinator.set', 'cluster.pause']);

export class TasksService implements PluginService {
  private readonly hub: Hub;
  private readonly store: Store;
  // Idle-task notices: one pending check per cluster, and per cluster the pairs last notified and when.
  // shortcut: in memory, so a restart may repeat one notice; persist it if that turns out to bother coordinators.
  private readonly idleChecks = new Map<string, NodeJS.Timeout>();
  private readonly idleNotified = new Map<string, { keys: Set<string>; at: number }>();
  /** When each member was first seen idle, so a just-finished turn is not called idle yet (idleMemberGraceMs). */
  private readonly idleSince = new Map<string, number>();
  // Per member: the last task set and activity instant already reminded about (Hub restart repeats one reminder).
  private readonly stalledNotified = new Map<string, { fingerprint: string; lastActivityAt: number | null }>();

  constructor(hub: Hub) { this.hub = hub; this.store = hub.store; }

  close(): void {
    for (const t of this.idleChecks.values()) clearTimeout(t);
    this.idleChecks.clear();
  }

  sweep(): void {
    for (const c of this.store.listClusters()) {
      this.checkIdle(c.id);
      this.checkStalled(c.id);
    }
  }

  onEvent(event: HubEvent): void {
    const payload = event.payload as { action?: string; suggested?: boolean };
    if (!event.clusterId || payload.suggested) return;
    if (IDLE_TRIGGERS.has(payload.action ?? '')) this.scheduleIdleCheck(event.clusterId);
  }

  onMemberStatus(member: Member, before: Member['status'] | undefined): void {
    if (member.status === 'idle') {
      if (before !== 'idle') { this.idleSince.set(member.id, Date.now()); this.scheduleIdleCheck(member.clusterId); }
    } else this.idleSince.delete(member.id);
  }

  onClusterPurged(clusterId: string, memberIds: string[]): void {
    clearTimeout(this.idleChecks.get(clusterId));
    this.idleChecks.delete(clusterId);
    this.idleNotified.delete(clusterId);
    for (const id of memberIds) { this.idleSince.delete(id); this.stalledNotified.delete(id); }
  }

  onQuotaChanged(): void {
    for (const c of this.store.listClusters()) this.scheduleIdleCheck(c.id);
  }

  /** Checks the cluster for idle-task candidates once, idleCheckMs after the first trigger (later triggers join it). */
  private scheduleIdleCheck(clusterId: string): void {
    if (!this.hub.isRunning() || this.idleChecks.has(clusterId)) return;
    const timer = setTimeout(() => {
      this.idleChecks.delete(clusterId);
      this.checkIdle(clusterId);
    }, this.hub.limits.idleCheckMs);
    timer.unref();
    this.idleChecks.set(clusterId, timer);
  }

  /**
   * Tells the enabled coordinator (suggest mode too) about idle members who could take or review a task that is not
   * moving (idle-candidates.ts). Only when a pair appears that the last notice did not list, and at most once per
   * idleNoticeGapMs; a new pair that comes too early stays new for a later check. The notice is an ordinary system
   * message to the coordinator, so pause, offline handling and the turn limits apply as to any delivery.
   */
  checkIdle(clusterId: string): void {
    try {
      const coordinator = this.hub.noticeCoordinator(clusterId);
      if (!coordinator) return;
      const now = Date.now();
      const members = this.hub.listMembers(clusterId);
      const exhausted = new Set(members.map((m) => m.harness).filter((h) => this.hub.quotaExhaustedNow(h, now)));
      const unavailable = members.filter((m) => exhausted.has(m.harness)).map((m) => m.id);
      const { limits } = this.hub;
      // Grace periods: a task just changed and a member just finishing a turn are not idle candidates yet.
      const evaluation = taskDependencyEvaluation(this.store, clusterId);
      const settledTasks = collaborationReminderTasks(this.store, clusterId)
        .filter((task) => (task.status === 'pending' || task.status === 'review') && now - Date.parse(task.updatedAt) >= limits.idleTaskGraceMs
          && !waitsForBatch(this.store, task))   // a batch's reviewer has nothing to review until the batch is complete
        .map((task) => ({ ...task, dependenciesReady: task.status === 'pending' && evaluation.versions(task) !== null }));
      const settledMembers = members.map((member) => member.status === 'idle'
        && now - (this.idleSince.get(member.id) ?? now) < limits.idleMemberGraceMs
        ? { ...member, status: 'busy' as const } : member);
      const { execute, review } = idleTaskCandidates({ tasks: settledTasks, members: settledMembers, coordinator, unavailable,
        roles: this.store.collaborationRoles(clusterId), memberRoles: this.store.collaborationMemberRoles(clusterId),
        participants: (taskId) => participantKeys(collaborationRecords<Assignment>(this.store, taskId, 'assignment')) });
      const keys = new Set([...execute.map((p) => 'x:' + pairKey(p)), ...review.map((p) => 'r:' + pairKey(p))]);
      const last = this.idleNotified.get(clusterId);
      if (![...keys].some((key) => !last?.keys.has(key))) return;
      if (last && now - last.at < limits.idleNoticeGapMs) return;
      this.hub.postNotice(clusterId, coordinator.memberId, this.idleNoticeBody(clusterId, settledTasks, execute, review),
        [...new Set([...execute, ...review].map((p) => p.taskId))], () => this.idleNotified.set(clusterId, { keys, at: now }), 'idle');
    } catch {
      // A background check must not throw out of a timer; the next trigger or sweep tries again.
    }
  }

  private idleNoticeBody(clusterId: string, tasks: ReminderTask[], execute: IdleCandidate[], review: ReviewCandidate[]): string {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const name = (id: string | null) => personName(this.store, clusterId, id);
    const state = (reason: string) => (reason === 'quota-exhausted' ? '的额度已用完' : '离线');
    /** One line per task: "- <what is stuck>；<idle members> 空闲且有<kind>资格。" */
    const lines = (pairs: (IdleCandidate | ReviewCandidate)[], kind: string, why: (task: ReminderTask, reason: string) => string) => {
      const grouped = new Map<string, (IdleCandidate | ReviewCandidate)[]>();
      for (const p of pairs) grouped.set(p.taskId, [...(grouped.get(p.taskId) ?? []), p]);
      const out = [...grouped.values()].map((group) => {
        const task = byId.get(group[0].taskId)!;
        return `- 任务${task.number ? ` #${task.number}` : ''}【${task.title}】（${task.id}）${why(task, group[0].reason)}；${group.map((p) => name(p.memberId)).join('、')} 空闲且有${kind}资格。`;
      });
      return out.length ? out : ['- 无'];
    };
    const executeLines = lines(execute, '执行', (task, reason) => reason === 'unassigned' ? '没有执行者'
      : `已分配给 ${name(task.assignedMemberId)} 但还没开始，${name(task.assignedMemberId)} ${state(reason)}`);
    const reviewLines = lines(review, '验收', (task, reason) => {
      const reviewer = name(task.reviewer.kind === 'member' ? task.reviewer.memberId : null);
      return `在等 ${reviewer} 验收，但 ${reviewer} ${state(reason)}`;
    });
    return ['有成员空闲，而下面的任务没在执行或一直在等验收。请按资格决定是否重新分配、转交或更换验收人，不要打断正在执行的任务。',
      '执行：', ...executeLines, '验收：', ...reviewLines].join('\n');
  }

  /**
   * Reminds the enabled coordinator once per (member, task set) when a member holding assigned, working or review tasks
   * has had no Hub-observed activity for the stalled threshold. The text never claims the member stopped: with no evidence it
   * says so, and offline members are named as offline. Only a notice: no reassignment, no interruption, no app start.
   * Dedupe and the activity base are in memory (shortcut: a restart may repeat one reminder).
   */
  checkStalled(clusterId: string): void {
    try {
      const coordinator = this.hub.noticeCoordinator(clusterId);
      if (!coordinator) return;
      for (const { member, held, evidence, evidenceAt: lastActivityAt, taskAt } of this.stalledHolders(clusterId, coordinator.memberId)) {
        // A hidden holder is silent because it is hidden: no chat notice about it (it could only point at an unseen
        // member). Its work reaches the coordinator through rule 21's notices, and the user through the page hints.
        if (member.hiddenAt) continue;
        const fingerprint = held.map((task) => task.id).sort().join(',');
        const told = this.stalledNotified.get(member.id);
        if (told && told.fingerprint === fingerprint && told.lastActivityAt === lastActivityAt) continue;
        this.hub.postNotice(clusterId, coordinator.memberId, this.stalledNoticeBody(member, held, evidence, taskAt),
          held.map((task) => task.id), () => this.stalledNotified.set(member.id, { fingerprint, lastActivityAt }), 'stalled');
      }
    } catch {
      // A background check must not throw out of a timer; the next sweep tries again.
    }
  }

  /**
   * Members holding open work with no Hub-observed activity for the stalled threshold.
   * An assign/start/edit is Hub-observed task movement too: silence starts after the newest of it and the activity
   * evidence. Read-only; the coordinator reminder and the web page's hint share it.
   */
  stalledHolders(clusterId: string, skipMemberId?: string): StalledHolder[] {
    const evaluation = taskDependencyEvaluation(this.store, clusterId);
    const heldByMember = new Map<string, ReminderTask[]>();
    for (const task of collaborationReminderTasks(this.store, clusterId)) {
      const id = task.status === 'review' ? (task.reviewer.kind === 'member' ? task.reviewer.memberId : null) : task.assignedMemberId;
      if (!id || id === skipMemberId || (task.status === 'pending' && evaluation.versions(task) === null) || waitsForBatch(this.store, task)) continue;
      const held = heldByMember.get(id);
      if (held) held.push(task);
      else heldByMember.set(id, [task]);
    }
    if (!heldByMember.size) return [];
    const now = Date.now();
    const out: StalledHolder[] = [];
    for (const member of this.hub.listMembers(clusterId)) {
      const held = heldByMember.get(member.id);
      if (!held) continue;
      const evidence = this.store.lastActivity(member.id);
      const evidenceAt = evidence ? Date.parse(evidence.at) : NaN;
      const taskAt = held.reduce((latest, task) => {
        const changed = Date.parse(task.updatedAt);
        return Number.isFinite(changed) ? Math.max(latest, changed) : latest;
      }, -Infinity);
      const baseline = Math.max(Number.isFinite(evidenceAt) ? evidenceAt : -Infinity, Number.isFinite(taskAt) ? taskAt : -Infinity);
      if (!Number.isFinite(baseline) || now - baseline < this.hub.stalledAfterMs) continue;
      out.push({ member, held, evidence, evidenceAt: Number.isFinite(evidenceAt) ? evidenceAt : null, taskAt, baseline });
    }
    return out;
  }

  /**
   * The web page's hint (GET /api/stalled): every cluster's stalled holders, with or without a coordinator, the coordinator
   * itself included. Computed from stored facts on each request, so a hint goes as soon as the member shows activity or
   * the task moves on, and a Hub restart changes nothing. Nothing while the Hub or the cluster is paused. Read-only: it
   * posts, delivers and wakes nothing.
   */
  stalledHints(): StalledHint[] {
    if (!this.hub.isRunning()) return [];
    const minutes = this.hub.getNotifySetting('stalledMemberMinutes').value;
    // Work that landed on a hidden member shows at once, paused or not: nobody else will pick it up (docs/cluster-members.md「隐身」).
    const clusters = this.store.listClusters();
    const hidden = clusters.flatMap((c) => this.hub.listMembers(c.id).flatMap((member): StalledHint[] => {
      const work = hiddenWorkTasks(this.store, member);
      return work ? [{ kind: 'hidden_work', clusterId: c.id, memberId: member.id, memberName: member.name, harness: member.harness,
        offline: member.status === 'offline', hidden: true, tasks: work.tasks, lastActivityAt: null, lastActivitySource: null,
        lastTaskChangeAt: work.latest, since: work.since, thresholdMinutes: minutes }] : [];
    }));
    if (this.hub.isPaused()) return hidden;
    return [...hidden, ...clusters.filter((c) => !this.store.clusterPause(c.id).paused).flatMap((c) =>
      this.stalledHolders(c.id).map(({ member, held, evidence, taskAt, baseline }): StalledHint => ({
        kind: 'stalled', clusterId: c.id, memberId: member.id, memberName: member.name, harness: member.harness, offline: member.status === 'offline',
        hidden: Boolean(member.hiddenAt),
        tasks: held.map((task) => ({ id: task.id, number: task.number ?? null, title: task.title, status: task.status })),
        lastActivityAt: evidence?.at ?? null, lastActivitySource: evidence ? activitySource(evidence) : null,
        lastTaskChangeAt: new Date(taskAt).toISOString(), since: new Date(baseline).toISOString(), thresholdMinutes: minutes,
      })))];
  }

  private stalledNoticeBody(member: Member, tasks: ReminderTask[], evidence: ReturnType<Store['lastActivity']>, taskAt: number): string {
    const fmt = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
    const last = evidence
      ? `Hub 看到的最近活动：${fmt(Date.parse(evidence.at))}（来源：${activitySource(evidence)}）。`
      : `Hub 没有活动证据：没有记录到该成员的发言、投递开始或结束或活动事件；最后一次任务状态变化在 ${fmt(taskAt)}。`;
    // A hidden holder is silent because it was hidden, not because it stopped: say so instead of the ordinary silence.
    const who = personName(this.store, member.clusterId, member.id);   // stored and readable by everyone: a hidden holder is not named
    const offline = member.hiddenAt
      ? ` ${who} 当前隐身中：它收不到任何消息，也不能发言或操作任务；它手上的任务要不要改派，请你或用户决定。`
      : member.status === 'offline' ? ` ${member.name} 当前离线：发给它的消息不会投递，恢复在线后也不补发。` : '';
    const statusNames: Record<string, string> = { pending: '已分配', working: '正在做', review: '待验收' };
    return [
      `成员长时间没有活动：${who}（${member.harness}${member.hiddenAt ? '，隐身中' : ''}），超过设置的 ${this.hub.getNotifySetting('stalledMemberMinutes').value} 分钟。`,
      ...tasks.map((task) => `- 任务${task.number ? ` #${task.number}` : ''}【${task.title}】（${task.id}，${statusNames[task.status] ?? task.status}）`),
      last + offline,
      '以上只是 Hub 看到的活动，不代表对方已经停工：有些 harness 在一轮中间不报告活动。请先问对方，或查看分支和投递情况，确认没在干活再重新安排；不要自动改派、打断或启动原生应用。',
    ].join('\n');
  }
}

type Evidence = NonNullable<ReturnType<Store['lastActivity']>>;

/** A member stalledHolders found. evidenceAt: null without any activity evidence; baseline: when the silence began. */
export interface StalledHolder {
  member: Member; held: ReminderTask[]; evidence: Evidence | null; evidenceAt: number | null; taskAt: number; baseline: number;
}

/** One hint of GET /api/stalled (docs/collaboration-api.md). `since`: when the silence began; activity or a task change moves it. */
export interface StalledHint {
  /** stalled: no activity past the threshold; hidden_work: work landed on a hidden member (each task says what waits). */
  kind: 'stalled' | 'hidden_work';
  clusterId: string; memberId: string; memberName: string; harness: string; offline: boolean; hidden: boolean;
  tasks: { id: string; number: number | null; title: string; status: string; waiting?: string; role?: string; seq?: number }[];
  lastActivityAt: string | null; lastActivitySource: string | null; lastTaskChangeAt: string; since: string; thresholdMinutes: number;
}

/** The kind of the newest activity evidence, in the reminder's words. */
function activitySource(evidence: Evidence): string {
  const kind = (evidence.event as { kind?: string } | null)?.kind;
  return evidence.source === 'message' ? '发言' : evidence.source === 'delivery' ? '投递开始或结束'
    : evidence.source === 'read' ? '读取消息' : evidence.source === 'acknowledgement' ? '确认消息'
    : kind === 'tool' ? '工具调用' : kind === 'turn' ? '轮次' : '活动事件或心跳';
}
