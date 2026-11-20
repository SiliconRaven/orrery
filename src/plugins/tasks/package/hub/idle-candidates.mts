// Pure, read-only calculation of "an idle member could do or review this task, but nobody is" (docs/collaboration.md).
import { host } from './host.mts';
import type { CoordinatorPolicy, Member, MemberRoles, Role, Task } from './types.mts';

export type IdleCandidateReason = 'unassigned' | 'assignee-offline' | 'quota-exhausted';
export type ReviewCandidateReason = 'reviewer-offline' | 'quota-exhausted';
export interface IdleCandidate { taskId: string; memberId: string; reason: IdleCandidateReason; }
export interface ReviewCandidate { taskId: string; memberId: string; reason: ReviewCandidateReason; }
export interface IdleCandidateInput {
  tasks: Pick<Task, 'id' | 'proposalState' | 'status' | 'reviewer' | 'reviewRoleIds' | 'executeRoleIds' | 'assignedMemberId' | 'dependenciesReady'>[];
  members: (Pick<Member, 'id' | 'status' | 'removedAt' | 'harness' | 'workerSessionId'> & Partial<Pick<Member, 'hiddenAt'>>)[];
  roles?: Pick<Role, 'id' | 'name'>[];
  memberRoles: MemberRoles[];
  coordinator: Pick<CoordinatorPolicy, 'memberId' | 'enabled'> | null;
  participants?: (taskId: string) => string[];
  unavailable?: string[];
}

export function memberEligible(memberRoles: MemberRoles[], memberId: string, roleIds: string[]): boolean {
  const roles = memberRoles.find((m) => m.memberId === memberId)?.roleIds ?? [];
  return roleIds.every((role) => roles.includes(role));
}

export function idleTaskCandidates({ tasks, members, roles = [], memberRoles, coordinator, participants = () => [], unavailable = [] }: IdleCandidateInput):
  { execute: IdleCandidate[]; review: ReviewCandidate[] } {
  const { actorKey } = host().collaboration;
  const active = members.filter((m) => !m.removedAt);
  const coordinatorId = coordinator?.enabled ? coordinator.memberId : null;
  const out = new Set(unavailable);
  const idle = active.filter((m) => m.status === 'idle' && m.id !== coordinatorId && !out.has(m.id) && !m.hiddenAt);
  const defaultRole = (name: string): string[] => {
    const role = roles.find((r) => r.name === name);
    if (!role) return [];
    const roleIds = [role.id];
    return active.some((m) => memberEligible(memberRoles, m.id, roleIds)) ? roleIds : [];
  };
  const defaultExecuteRoles = defaultRole('执行者');
  const defaultReviewRoles = defaultRole('验收者');
  const statusOf = (id: string) => (out.has(id) ? 'exhausted' : active.find((m) => m.id === id)?.status ?? 'offline');
  const execute: IdleCandidate[] = [];
  const review: ReviewCandidate[] = [];
  for (const task of tasks) {
    if (task.proposalState !== 'active') continue;
    if (task.status === 'review') {
      if (task.reviewer.kind !== 'member') continue;
      const reviewer = statusOf(task.reviewer.memberId);
      if (reviewer === 'idle' || reviewer === 'busy') continue;
      const done = new Set(participants(task.id));
      const roleIds = task.reviewRoleIds.length ? task.reviewRoleIds : defaultReviewRoles;
      for (const m of idle) {
        if (memberEligible(memberRoles, m.id, roleIds) && !done.has(actorKey(m))) {
          review.push({ taskId: task.id, memberId: m.id,
            reason: reviewer === 'exhausted' ? 'quota-exhausted' : 'reviewer-offline' });
        }
      }
      continue;
    }
    if (!task.dependenciesReady) continue;
    let reason: IdleCandidateReason | null = null;
    if (task.status === 'pending') {
      const assignee = task.assignedMemberId ? statusOf(task.assignedMemberId) : null;
      reason = assignee === null ? 'unassigned' : assignee === 'exhausted' ? 'quota-exhausted' : assignee === 'offline' ? 'assignee-offline' : null;
    }
    if (!reason) continue;
    const roleIds = task.executeRoleIds.length ? task.executeRoleIds : defaultExecuteRoles;
    for (const m of idle) {
      if (task.reviewer.kind === 'member' && task.reviewer.memberId === m.id) continue;
      if (memberEligible(memberRoles, m.id, roleIds)) execute.push({ taskId: task.id, memberId: m.id, reason });
    }
  }
  return { execute, review };
}

export const pairKey = (p: Pick<IdleCandidate, 'taskId' | 'memberId'>) => p.taskId + ':' + p.memberId;

export function fingerprint(pairs: Pick<IdleCandidate, 'taskId' | 'memberId'>[]): string {
  return pairs.map(pairKey).sort().join(',');
}
