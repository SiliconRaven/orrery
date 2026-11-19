// The read side: workspace, one task, a task's context, task references and a single event.
import { CollaborationError, type Collaboration } from '../../core/collaboration.ts';
import type { Approval, Assignment, Attention, CollaborationActor, Merge, Review, Submission, Takeover, TaskSummary } from '../../core/collaboration-types.ts';
import type { PluginQuery } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import { batchBase, batchSummary } from './batches.ts';
import { libraryView } from './labels.ts';
import { displayTask, fail, resolveTaskRef, taskDependencyEvaluation, taskOf } from './model.ts';
import { taskPermissions } from './permissions.ts';
import { taskSettings } from './takeover.ts';
import { taskWatches } from './watches.ts';
import {
  collaborationEvents, collaborationEventsBefore, collaborationLabels, collaborationLinkCount, collaborationRecords,
  collaborationTaskCandidates, collaborationTaskRefs, collaborationTasks, linkedClause, taskBatch, taskBatches,
} from './store.ts';

export const workspace: PluginQuery = ({ store, clusterId, query, limit, collaboration, actor }) => {
  if (query.memberId) collaboration.member(clusterId, query.memberId);
  const page = collaborationTasks(store, clusterId, limit, query.cursor, query);
  const evaluation = taskDependencyEvaluation(store, clusterId);
  const result = { ...page, tasks: page.tasks.map((t) => displayTask(store, t, evaluation)) };
  if (query.pageOnly) return result;
  const view = store.coordinator;
  const coordinator = view?.policy(clusterId);
  const pause = store.clusterPause(clusterId);
  // Hidden members are listed only to the user and the enabled coordinator (docs/cluster-members.md「隐身」).
  const seesHidden = actor.kind !== 'member' || (coordinator?.enabled && coordinator.memberId === actor.memberId);
  const memberRoles = store.collaborationMemberRoles(clusterId).filter((item) => seesHidden || !store.getMember(item.memberId)?.hiddenAt);
  return { ...result, roles: store.collaborationRoles(clusterId),
    // Review batches that are not cancelled, newest first, with their progress (batches.ts).
    batches: taskBatches(store, clusterId).filter((batch) => !batch.cancelledAt).map((batch) => batchSummary(store, batch)),
    memberRoles, labels: collaborationLabels(store, clusterId),
    labelLibrary: libraryView(store, clusterId), taskSettings: taskSettings(store, clusterId), taskPermissions: taskPermissions(store, clusterId),
    coordinator: coordinator ? { ...coordinator, rules: view!.rules } : null, paused: pause.paused,
    generation: view?.generation(clusterId) ?? 0, pausedBy: pause.pausedBy };
};

export const taskRefs: PluginQuery = ({ store, clusterId, query, limit }) => {
  if (query.ids === undefined && query.numbers === undefined) {
    return { tasks: collaborationTaskCandidates(store, clusterId, query.q ?? '', Math.min(limit, 20), query.includeClosed === true) };
  }
  const ids = query.ids ?? [];
  const numbers = query.numbers ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return fail('INVALID_REQUEST', 'ids must be an array of task ids');
  if (!Array.isArray(numbers) || numbers.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
    return fail('INVALID_REQUEST', 'numbers must be an array of positive integers');
  }
  if (ids.length > 100) return fail('INVALID_REQUEST', 'ids must be an array of at most 100 task ids');
  if (ids.length + numbers.length > 100) return fail('INVALID_REQUEST', 'at most 100 task refs may be requested at once');
  return { tasks: collaborationTaskRefs(store, clusterId, ids, numbers) };
};

/** `task` and `context` share how they read the task, its records and its events. */
export const taskDetail: PluginQuery = ({ store, clusterId, query, limit, actor }) => {
  const taskId = typeof query.taskId === 'string' ? resolveTaskRef(store, clusterId, query.taskId) : query.taskId;
  const task = taskOf(store, clusterId, taskId);
  const evaluation = taskDependencyEvaluation(store, clusterId);
  // A dependency in the same review batch with a current submission says which commit (and linked branch) to build on.
  const dependencies = task.dependencyIds.map((id) => {
    const upstream = taskOf(store, clusterId, id);
    const base = batchBase(store, task, upstream);
    return { ...displayTask(store, upstream, evaluation), ...(base ? { batchBase: base } : {}) };
  });
  const batch = task.batchId ? taskBatch(store, clusterId, task.batchId) : null;
  const batchField = batch ? { batch: (({ tasks: _tasks, ...summary }) => summary)(batchSummary(store, batch)) } : {};
  const assignments = collaborationRecords<Assignment>(store, task.id, 'assignment');
  const submissions = collaborationRecords<Submission>(store, task.id, 'submission')
    .map((submission) => ({ ...submission, superseded: submission.id !== task.latestSubmissionId }));
  const attentions = collaborationRecords<Attention>(store, task.id, 'attention');
  // Events oldest first by default (the web pages forward with the cursor); MCP asks for the newest first and pages
  // back to older ones (eventsOrder 'desc'), with its own page size.
  const eventsLimit = Number.isSafeInteger(query.eventsLimit) && query.eventsLimit! > 0 ? Math.min(query.eventsLimit!, 100) : limit;
  const eventsCursor = Number(query.kind === 'context' ? query.cursor : query.eventsCursor) || 0;
  const events = query.eventsOrder === 'desc'
    ? collaborationEventsBefore(store, clusterId, task.id, eventsCursor || null, eventsLimit + 1)
    : collaborationEvents(store, clusterId, task.id, eventsCursor, eventsLimit + 1);
  const eventsPage = events.slice(0, eventsLimit);
  const eventsNext = events.length > eventsLimit ? String(events[eventsLimit - 1].seq) : null;
  if (query.kind === 'task') {
    const reviews = collaborationRecords<Review>(store, task.id, 'review')
      .map((review, index) => ({ ...review, round: index + 1, commitSha: submissions.find((s) => s.id === review.submissionId)?.commitSha ?? null }));
    const approvals = collaborationRecords<Approval>(store, task.id, 'approval');
    const merges = collaborationRecords<Merge>(store, task.id, 'merge');
    const takeovers = collaborationRecords<Takeover>(store, task.id, 'takeover');
    const offset = Math.max(0, Number(query.cursor) || 0);
    const nextCursor = [assignments, submissions, reviews, attentions, approvals, merges, takeovers].some((items) => items.length > offset + limit)
      ? String(offset + limit) : null;
    // Watches are public in the cluster: everyone gets the list; a member also gets its own entry (docs/collaboration.md「关注任务」).
    // Hidden members stay out of what other members read (docs/cluster-members.md「隐身」), as in workspace above.
    const policy = store.coordinator?.policy(clusterId);
    const seesHidden = actor.kind !== 'member' || (policy?.enabled && policy.memberId === actor.memberId);
    const watchers = taskWatches(store, task.id).filter((item) => seesHidden || !store.getMember(item.memberId)?.hiddenAt);
    const own = actor.kind === 'member' ? watchers.find((item) => item.memberId === actor.memberId) : undefined;
    const watch = { watchers, ...(actor.kind === 'member' ? { watching: own ? { note: own.note, createdAt: own.createdAt } : null } : {}) };
    return { task: displayTask(store, task, evaluation), attachments: task.fileIds.map((id) => store.getFile(id)).filter((file) => file !== null),
      assignments: assignments.slice(offset, offset + limit),
      submissions: submissions.slice(offset, offset + limit), reviews: reviews.slice(offset, offset + limit),
      approvals: approvals.slice(offset, offset + limit), merges: merges.slice(offset, offset + limit),
      takeovers: takeovers.slice(offset, offset + limit),
      dependencies, attentions: attentions.slice(offset, offset + limit), events: eventsPage,
      linkedMessageCount: collaborationLinkCount(store, task.id), nextCursor,
      eventsNextCursor: eventsNext, ...watch, ...batchField };
  }
  const messagesLimit = Number.isSafeInteger(query.messagesLimit) && query.messagesLimit! > 0 ? Math.min(query.messagesLimit!, 100) : limit;
  const messages = store.collaborationCollection(clusterId, { limit: messagesLimit, where: [linkedClause(task.id)], cursor: query.messagesCursor,
    q: query.q, sender: query.sender, since: query.since, until: query.until });
  const summaries = collaborationRecords<TaskSummary>(store, task.id, 'summary');
  const unresolved = attentions.filter((a) => !a.resolvedAt);
  const attentionOffset = Math.max(0, Number(query.attentionsCursor) || 0);
  return { task: displayTask(store, task, evaluation), dependencies,
    assignment: assignments.find((a) => a.id === task.currentAssignmentId) ?? null,
    latestSubmission: submissions.find((s) => s.id === task.latestSubmissionId) ?? null,
    attentions: unresolved.slice(attentionOffset, attentionOffset + limit), messages: messages.items, events: eventsPage,
    summary: summaries.at(-1) ?? null, nextCursor: eventsNext, ...batchField,
    messagesNextCursor: messages.nextCursor,
    attentionsNextCursor: unresolved.length > attentionOffset + limit ? String(attentionOffset + limit) : null };
};

/**
 * One collaboration event's payload (with `changes` where recorded), for the web diff view. The event must belong
 * to the task and the cluster; reading it grants nothing else (docs/collaboration-api.md).
 */
export function taskEvent(store: Store, collaboration: Collaboration, actor: CollaborationActor, clusterId: string, taskId: string, eventId: number): Record<string, unknown> {
  collaboration.actor(actor, clusterId);
  const task = taskOf(store, clusterId, resolveTaskRef(store, clusterId, taskId));
  const event = Number.isSafeInteger(eventId) ? store.getEvent(eventId) : null;
  if (!event || event.clusterId !== clusterId || event.kind !== 'collaboration') throw new CollaborationError('OUT_OF_SCOPE', 'unknown collaboration event');
  if ((event.payload as { taskId?: unknown }).taskId !== task.id) throw new CollaborationError('OUT_OF_SCOPE', 'event does not belong to this task');
  return { ...(event.payload as Record<string, unknown>), eventId: event.seq };
}
