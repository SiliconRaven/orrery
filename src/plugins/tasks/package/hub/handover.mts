// The tasks a member is holding or recently finished, with the records the handover package reads
// (docs/cluster-members.md「交接包」). Read-only: no new table, no model call.
import { memberName } from './model.mts';
import { collaborationMemberTaskIds, collaborationRecords, collaborationTask } from './store.mts';
import type { Assignment, Attention, MemberTaskFacts, Review, Store, Submission } from './types.mts';

const ENDED = new Set(['completed', 'merged', 'cancelled']);
const ROLE_ORDER = { executor: 0, reviewer: 1, former: 2 };

export function memberTasks(store: Store, clusterId: string, memberId: string, limit: number): { facts: MemberTaskFacts[]; omitted: number } {
  const facts: MemberTaskFacts[] = [];
  for (const taskId of collaborationMemberTaskIds(store, clusterId, memberId)) {
    const task = collaborationTask(store, clusterId, taskId);
    if (!task) continue;
    const role: MemberTaskFacts['role'] = task.assignedMemberId === memberId ? 'executor'
      : task.status === 'review' && task.reviewer.kind === 'member' && task.reviewer.memberId === memberId ? 'reviewer'
        : 'former';
    const submission = collaborationRecords<Submission>(store, task.id, 'submission')
      .find((record) => record.id === task.latestSubmissionId) ?? null;
    const assignment = submission === null ? null : collaborationRecords<Assignment>(store, task.id, 'assignment')
      .find((record) => record.id === submission.assignmentId) ?? null;
    const submissionBy = submission?.manual ? '用户' : assignment === null ? null : memberName(store, assignment.memberId);
    const review = collaborationRecords<Review>(store, task.id, 'review').at(-1) ?? null;
    facts.push({
      task,
      role,
      commitSha: submission?.commitSha ?? null,
      mergedCommitSha: task.mergedCommitSha,
      summary: submission?.summary ?? null,
      submissionBy,
      review: review && { verdict: review.verdict, self: review.self === true,
        reviewer: review.reviewer.kind === 'member' ? memberName(store, review.reviewer.memberId) : '用户',
        at: review.createdAt, reason: review.reason },
      questions: collaborationRecords<Attention>(store, task.id, 'attention')
        .filter((attention) => !attention.resolvedAt).map((attention) => attention.question),
    });
  }
  facts.sort((a, b) => Number(ENDED.has(a.task.status)) - Number(ENDED.has(b.task.status))
    || ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
    || b.task.updatedAt.localeCompare(a.task.updatedAt) || a.task.id.localeCompare(b.task.id));
  return { facts: facts.slice(0, limit), omitted: Math.max(0, facts.length - limit) };
}
