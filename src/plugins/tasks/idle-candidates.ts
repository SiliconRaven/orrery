// Pure, read-only calculation of "an idle member could do or review this task, but nobody is" (docs/collaboration.md).
// Takes the reminder facts and member statuses for one cluster; no Hub or Store access.
import { actorKey } from '../../core/collaboration.ts';
import type { CoordinatorPolicy, MemberRoles, Role, Task } from '../../core/collaboration-types.ts';
import type { Member } from '../../core/types.ts';

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
  /** Participant keys for a task with a blocked reviewer, including former conversations. */
  participants?: (taskId: string) => string[];
  /** Members whose harness quota is used up: like offline, but their stuck tasks say 'quota-exhausted'. */
  unavailable?: string[];
}

/** Same rule as the assignment check: the member holds every required role. */
export function memberEligible(memberRoles: MemberRoles[], memberId: string, roleIds: string[]): boolean {
  const roles = memberRoles.find((m) => m.memberId === memberId)?.roleIds ?? [];
  return roleIds.every((role) => roles.includes(role));
}

export function idleTaskCandidates({ tasks, members, roles = [], memberRoles, coordinator, participants = () => [], unavailable = [] }: IdleCandidateInput):
  { execute: IdleCandidate[]; review: ReviewCandidate[] } {
  const active = members.filter((m) => !m.removedAt);
  const coordinatorId = coordinator?.enabled ? coordinator.memberId : null;
  const out = new Set(unavailable);
  // A hidden member is never a candidate: it receives nothing and cannot be given a task.
  const idle = active.filter((m) => m.status === 'idle' && m.id !== coordinatorId && !out.has(m.id) && !m.hiddenAt);
  // Apply a default role only when the cluster uses it, regardless of the holders' current status.
  const defaultRole = (name: string): string[] => {
    const role = roles.find((r) => r.name === name);
    if (!role) return [];
    const roleIds = [role.id];
    return active.some((m) => memberEligible(memberRoles, m.id, roleIds)) ? roleIds : [];
  };
  const defaultExecuteRoles = defaultRole('执行者');
  const defaultReviewRoles = defaultRole('验收者');
  // A member missing from the active list (removed, or another cluster) cannot act, so it counts as offline.
  const statusOf = (id: string) => (out.has(id) ? 'exhausted' : active.find((m) => m.id === id)?.status ?? 'offline');
  const execute: IdleCandidate[] = [];
  const review: ReviewCandidate[] = [];
  for (const task of tasks) {
    if (task.proposalState !== 'active') continue;
    if (task.status === 'review') {
      // A user reviewer is never "stuck": the Hub cannot see whether the user is busy.
      if (task.reviewer.kind !== 'member') continue;
      const reviewer = statusOf(task.reviewer.memberId);
      // A busy reviewer is not stuck either: a reviewer who really went quiet gets the stalled-member notice.
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
      // An idle or busy executor will get to it; a really silent one gets the stalled-member notice.
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

/** One pair's key; `fingerprint` and the Hub's notice dedupe use the same form. */
export const pairKey = (p: Pick<IdleCandidate, 'taskId' | 'memberId'>) => p.taskId + ':' + p.memberId;

/** Order-independent key of a candidate set. */
export function fingerprint(pairs: Pick<IdleCandidate, 'taskId' | 'memberId'>[]): string {
  return pairs.map(pairKey).sort().join(',');
}
