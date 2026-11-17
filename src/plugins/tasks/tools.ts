// The MCP task tools. Their names, descriptions and schemas are the contract members rely on; only their place in the tool
// list moved when they became a plugin (they now follow the core tools).
import { z } from 'zod';
import type { CollaborationCommand, ContextResult, Task, TaskResult, WorkspaceResult } from '../../core/collaboration-types.ts';
import type { PluginToolApi } from '../../core/plugin.ts';
import type { HubEvent } from '../../core/types.ts';
import { clusterLabelCatalog, PRESET_PACKS } from './labels.ts';
import { shipForRunner } from './ship.ts';

/** manage_labels' action → the label.* collaboration action. */
const LABEL_TOOL_ACTIONS: Record<string, string> = { create: 'label.create', edit: 'label.edit', merge: 'label.merge', delete: 'label.delete',
  create_group: 'label.group_create', edit_group: 'label.group_edit', delete_group: 'label.group_delete', add_pack: 'label.add_pack',
  select_group: 'label.select_group' };

/**
 * The task fields list_tasks returns by default, and get_task / get_task_context for dependencies. approvedSubmissionId
 * is what a resubmission after a dependency change declares in expectedDependencyVersions.
 */
const TASK_SUMMARY = ['id', 'number', 'title', 'status', 'proposalState', 'priority', 'revision', 'createdBy', 'assignedMemberId',
  'reviewer', 'labels', 'dependencyIds', 'dependenciesReady', 'dependenciesChanged', 'completionValid', 'approvedSubmissionId',
  'requiresApproval', 'mergeRequired', 'mergedCommitSha', 'mergedSubmissionId', 'closeReason', 'updatedAt'] as const;
export const taskSummary = (task: Task) => Object.fromEntries(TASK_SUMMARY.filter((key) => key in task).map((key) => [key, task[key]]));
/**
 * An event whose payload carries `changes` names the changed fields only, unless the full values are asked for. A
 * review event drops its reason too: up to 50 000 characters, and get_task already returns it in `reviews`.
 */
export const eventView = (full: boolean) => (event: HubEvent): HubEvent => {
  const payload = event.payload as { action?: string; reason?: string; changes?: { field: string }[] } | null;
  if (full || !payload || typeof payload !== 'object') return event;
  const { changes, ...rest } = payload;
  const dropReason = payload.action === 'task.review' && payload.reason !== undefined;
  if (!Array.isArray(changes) && !dropReason) return event;
  if (dropReason) delete rest.reason;
  return { ...event, payload: { ...rest, ...(Array.isArray(changes) ? { changedFields: changes.map((c) => c.field) } : {}) } };
};

export function taskTools({ page, hub, secret, hubUrl, query, command }: PluginToolApi): void {
  const taskRef = 'Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes).';
  const reviewer = z.union([
    z.object({ kind: z.literal('user') }),
    z.object({ kind: z.literal('member'), memberId: z.string() }),
    z.object({ kind: z.literal('self') }),
  ]).optional().describe('Who should review the result: the user, a member, or self (the executor records their own checks on submit; no reviewer is woken). This is a target, not the caller identity.');
  const taskDefinition = {
    title: z.string().optional(), scope: z.string().optional(), acceptance: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Task priority; default normal.'),
    dependencyIds: z.array(z.string()).optional(),
    executeRoleIds: z.array(z.string()).optional(), reviewRoleIds: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional().describe('Prefer this cluster’s labels (list_tasks with include: ["labels"]). Names match the shared label library without case and are stored in its spelling; a name the library lacks is created there as an ungrouped label (1-20 characters, no commas). Each required group this cluster uses needs at least one label (on edit, only when labels change); archived labels cannot be added.'),
    reviewer,
    requiresApproval: z.boolean().optional().describe('Require user approval before assignment or start; default false. Only the user can turn this off.'),
    mergeRequired: z.boolean().optional().describe('Require a recorded merge before dependencies are ready; default true for new tasks. Editable before work starts.'),
    fileIds: z.array(z.string()).optional().describe('Files attached to the task definition: at most 10 IDs of files stored in this cluster (the folder name in an attachment path is its ID). Edit replaces the whole list and is refused once work has started.'),
  };
  const generation = z.number().int().describe('Required when acting as coordinator; use list_tasks.coordinator.generation.');
  const version = {
    expectedRevision: z.number().int().describe('Current task revision from get_task.'), assignmentId: z.string().optional(),
    submissionId: z.string().optional(), generation: generation.optional(),
  };
  const detail = z.enum(['summary', 'full']).optional();
  const eventDetail = z.enum(['summary', 'full']).optional().describe('summary (default): each event lists changedFields instead of the before/after values in changes, and review events leave out their reason (get_task has it in reviews); full: everything.');
  const eventsLimit = z.number().int().min(1).max(50).optional().describe('Events per page, newest first; default 5.');

  query('list_tasks', 'List this cluster’s tasks and coordinator policy, 20 per page with a cursor for more. '
    + 'By default only unfinished tasks (no completed, merged or cancelled ones unless status asks for them, or includeClosed), '
    + 'each as a summary (id, number, title, status, proposalState, priority, revision, executor (assignedMemberId), reviewer, labels, dependencies and their readiness, approvedSubmissionId, requiresApproval, mergeRequired, mergedCommitSha, mergedSubmissionId, and closeReason on a cancelled task); '
    + 'detail: "full" returns whole tasks, get_task returns one. The coordinator is summarized as memberId, enabled, mode, generation, '
    + 'permissions and rulesVersion; include adds roles, memberRoles, labels (the label groups this cluster uses, each with name, description, required and its labels, plus the ungrouped labels; archived labels are left out; list_labels shows the whole library) or rules (the coordinator rules text and the user’s standing instructions). '
    + 'q matches title/scope/acceptance text, task numbers (#12 or bare digits, sorting first), and task ids (full UUID or a 4+ character id prefix; id hits follow number hits). label may be repeated (array) to require every label (AND).', 'workspace', {
    ...page, q: z.string().optional().describe('Keyword for title/scope/acceptance, a task number (#12 or bare digits, sorted first), or a task id (full UUID or 4+ character id prefix).'),
    memberId: z.string().optional(), label: z.union([z.string(), z.array(z.string())]).optional().describe('A label, or several labels that must all match (AND).'),
    status: z.enum(['pending', 'working', 'review', 'completed', 'merged', 'cancelled']).optional(),
    includeClosed: z.boolean().optional().describe('true: also completed, merged and cancelled tasks (default false; a status filter overrides it).'),
    detail: detail.describe('summary (default) or full task records.'),
    include: z.array(z.enum(['roles', 'memberRoles', 'labels', 'rules'])).optional().describe('Extra parts to return; none by default.'),
  }, ({ includeClosed, detail: _detail, include: _include, ...p }) => ({ ...p, limit: p.limit ?? 20, open: !includeClosed && !p.status }),
  (result: WorkspaceResult, p, me) => {
    const include = new Set(Array.isArray(p.include) ? p.include as string[] : []);
    const c = result.coordinator;
    return {
      tasks: p.detail === 'full' ? result.tasks : result.tasks.map(taskSummary), nextCursor: result.nextCursor, paused: result.paused,
      coordinator: !c ? null : include.has('rules') ? c
        : { memberId: c.memberId, enabled: c.enabled, mode: c.mode, generation: c.generation, permissions: c.permissions, rulesVersion: c.rules.version },
      ...(include.has('roles') ? { roles: result.roles } : {}),
      ...(include.has('memberRoles') ? { memberRoles: result.memberRoles } : {}),
      ...(include.has('labels') ? { labels: clusterLabelCatalog(hub.store, me.clusterId) } : {}),
    };
  });
  query('list_labels', 'Read the label library shared by every cluster: groups (id, name, description, required, newClusterDefault, createdBy, and selected: whether this cluster uses it) with their labels (id, name, description, color, archived, createdBy, usage: how many tasks and clusters carry it), the ungrouped labels, and the preset packs add_pack can add. list_tasks with include: ["labels"] is the short view of this cluster’s groups.', 'labels', {});
  command('manage_labels', 'Change the label library shared by every cluster. create: name (1-20 characters, no commas; group names too), optional groupId, description, color. edit: labelId and any of name, groupId (null: ungrouped), description, color (null: automatic), archived; a name another label already has merges this label into it. merge: labelId into intoLabelId. delete: labelId; tasks keep the text. create_group: name, optional description, required (every cluster using the group needs one of its labels on each new task), newClusterDefault (new clusters use the group). edit_group: groupId and any of those fields. delete_group: groupId; its labels become ungrouped. add_pack: pack; names that already exist are skipped. select_group: groupId and selected, whether this cluster uses the group. labelId, intoLabelId and groupId take an ID or a name. A member may delete, or merge away, only labels and groups it created itself; ask the user for others. A rename or merge changes every task with that label in every cluster, closed ones too, without a revision change or notice; each affected cluster records the changed tasks with their labels before and after in an event.', {
    action: z.enum(['create', 'edit', 'merge', 'delete', 'create_group', 'edit_group', 'delete_group', 'add_pack', 'select_group']),
    name: z.string().optional(), description: z.string().optional(),
    labelId: z.string().optional(), intoLabelId: z.string().optional(), groupId: z.string().nullable().optional(),
    color: z.number().int().min(0).max(7).nullable().optional().describe('A tag colour 0-7; null picks one from the name.'),
    archived: z.boolean().optional().describe('Archived labels stay on tasks but cannot be added to more.'),
    required: z.boolean().optional(), newClusterDefault: z.boolean().optional(),
    pack: z.enum(PRESET_PACKS.map((pack) => pack.id) as [string, ...string[]]).optional(),
    selected: z.boolean().optional(),
  }, (args) => LABEL_TOOL_ACTIONS[args.action as string]);
  query('get_task', 'Read a task and its attachments (name, size and, for native members, a local path to read), assignments, submissions (with commitSha and superseded), reviews (full text, with round and commitSha), approvals, merges, dependencies (as summaries), history, watchers (every member watching it, with its note) and watching (your own entry, or null). '
    + 'Records come 20 per page (limit, cursor). Events come newest first, 5 per page (eventsLimit); eventsCursor pages back to older ones; '
    + 'each event lists changedFields unless eventDetail is "full".', 'task', {
    taskId: z.string().describe(taskRef), ...page, eventsCursor: z.string().optional().describe('Continue to older events from eventsNextCursor.'),
    eventsLimit, eventDetail,
  }, ({ eventDetail: _d, ...p }) => ({ ...p, limit: p.limit ?? 20, eventsOrder: 'desc', eventsLimit: p.eventsLimit ?? 5 }),
  (result: TaskResult, p, me) => ({ ...result, attachments: hub.attachmentViews(result.attachments, me), dependencies: result.dependencies.map(taskSummary), events: result.events.map(eventView(p.eventDetail === 'full')),
    ...shipForRunner(hub, secret, hubUrl, me.clusterId, result.task.id, me.id) }));
  query('get_task_context', 'Read a task context: definition, dependencies (as summaries), evidence messages (10 per page), unresolved questions (20 per page) and events '
    + '(newest first, 5 per page; nextCursor pages back to older ones; changedFields unless eventDetail is "full").', 'context', {
    taskId: z.string().describe(taskRef), ...page, messagesCursor: z.string().optional().describe('Continue messages from messagesNextCursor.'),
    attentionsCursor: z.string().optional().describe('Continue unresolved issues from attentionsNextCursor.'),
    q: z.string().optional(), sender: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
    eventsLimit, eventDetail,
  }, ({ eventDetail: _d, ...p }) => ({ ...p, limit: p.limit ?? 20, messagesLimit: p.limit ?? 10, eventsOrder: 'desc', eventsLimit: p.eventsLimit ?? 5 }),
  (result: ContextResult, p) => ({ ...result, dependencies: result.dependencies.map(taskSummary), events: result.events.map(eventView(p.eventDetail === 'full')) }));
  command('create_task', 'Create a task in this cluster with a goal, scope and acceptance criteria. memberId names its executor; left out, a member who may execute it becomes the executor, and null leaves it unassigned. requiresApproval defaults false; mergeRequired defaults true (set false for work with no code merge). reviewer may be {kind:"self"} for a low-risk task the executor checks itself; only the user, the creator or the coordinator with reviewerManagement may set it; the creator may change it only until the first review of the task. dependencyIds accept #number (e.g. #12), a full ID, or a unique prefix of at least 8 characters in this cluster (bare 8+ digit numbers remain ID prefixes); originMessageId accepts a full ID or a unique prefix of at least 8 characters; memberId and reviewer.memberId also accept a unique member name.', {
    ...taskDefinition, title: z.string(), scope: z.string(), acceptance: z.string(),
    memberId: z.string().nullable().optional().describe('Executor of the task; null leaves it unassigned. Left out: the creator when eligible.'),
    originMessageId: z.string().nullable().optional(), generation: version.generation,
    sourceEventId: z.number().int().optional(),
  }, 'task.create');
  command('task_action', "Edit, assign, start, submit, review, merge, release, cancel, reopen, hand off or take over a task. Edit accepts requiresApproval and mergeRequired; approval itself is user-only through HTTP. Any member may edit only the title, priority and labels of an unfinished task; other edit fields need the creator, the user or the coordinator. The creator may change the reviewer until the first review of the task, but not to self review once work has started. Assign sets or changes the executor before work starts: it requires memberId (or null to clear it). Deprecated, kept for one version: nominate is another name for assign, and claim assigns the task to yourself. The executor starts the task directly; start returns the assignment, and submit requires its assignmentId. Submit requires summary, and commitSha when mergeRequired is true; evidenceMessageIds and evidenceFileIds are optional. Resubmit during review to replace the latest submission. After dependencies change or when resubmitting an invalid completed result, use get_task_context to obtain each dependency’s current approvedSubmissionId and provide expectedDependencyVersions. Review requires the latest submissionId, verdict and reason (immutable review notes, up to 50000 characters). Merge is the way out when ship landed the merge but could not report it: commitSha is that merge commit, and it is refused unless read-only git shows it on the target branch with the reviewed commit as its second parent. Release, cancel, reopen and handoff require reason; include assignmentId when an assignment exists, and memberId for handoff. Cancel takes an optional closeReason (default other); duplicate and superseded also require relatedTaskId, another task of this cluster, and reopen clears it. On task.* actions, taskId, dependencyIds and relatedTaskId accept #number (e.g. #12), a full ID, or a unique prefix of at least 8 characters in this cluster (bare 8+ digit numbers remain ID prefixes); evidenceMessageIds accept a full ID or a unique prefix of at least 8 characters; memberId (assign, handoff) and reviewer.memberId also accept a unique member name. The current executor may release or hand off their own started assignment without user confirmation; a handoff target needs the execute roles and cannot be the task reviewer (use takeover for that). Takeover hands a task with a member reviewer to that reviewer, who becomes its executor: the executor, the reviewer, the user or the coordinator may do it while the task is pending, working or in review. reviewer names who reviews afterwards: {kind:\"user\"} (the default when left out), a member who has not worked on the task, or {kind:\"self\"}, which is refused unless the user does the takeover or has turned on this cluster's setting that allows self review after a takeover. The previous assignment ends, a result waiting for review is superseded, earlier submissions and reviews stay, and review rounds keep counting. On a task that was taken over, self review is bound to one executor: switching it to self with edit, or giving a self-reviewed task to another executor (assign, claim, handoff), needs the same authorisation, and only the bound executor can submit a self review. On a self-review task submit writes the self review and completes the task immediately. The current executor can use set_git_branch with gitBranch to link or clear a local branch. The Hub uses the task's linked repository or the executor's saved project folder. Watch: use it when you want to do something after a task finishes but do not depend on it (with a real dependency, use dependencyIds instead); you are woken once when the task is merged, completed without needing a merge, or cancelled, and the watch then ends. A watch and its optional note are visible to everyone in the cluster (members and the user): get_task lists them, and the notice at the end names each watcher with its note. Watching again replaces the note; unwatch stops it. Watch and unwatch need no expectedRevision and change nothing on the task.", {
    action: z.enum(['edit', 'assign', 'start', 'submit', 'review', 'merge', 'release', 'cancel', 'reopen', 'handoff', 'takeover', 'nominate', 'claim', 'set_git_branch', 'watch', 'unwatch']),
    ...version, expectedRevision: version.expectedRevision.optional().describe('Current task revision from get_task; required for every action except watch and unwatch.'),
    taskId: z.string().describe(taskRef),
    ...taskDefinition, memberId: z.string().nullable().optional(),
    summary: z.string().optional(), evidenceMessageIds: z.array(z.string()).optional(), evidenceFileIds: z.array(z.string()).optional(),
    expectedDependencyVersions: z.record(z.string(), z.string()).optional()
      .describe('For submit after dependency versions change, map each dependency task ID to its current approved submission ID.'),
    verdict: z.enum(['approve', 'reject']).optional(), reason: z.string().max(50_000).optional(),
    closeReason: z.enum(['not_planned', 'duplicate', 'superseded', 'other']).optional().describe('Cancel only: why the task is closed; default other.'),
    relatedTaskId: z.string().optional().describe('Cancel with duplicate or superseded only: the task this one duplicates or is replaced by (#number e.g. #12, full ID, or unique 8+ character prefix; bare 8+ digit numbers remain ID prefixes).'),
    commitSha: z.string().optional().describe('Reviewed branch commit for submit, or the merge commit for merge; 7-40 hexadecimal characters, stored lowercase.'),
    gitBranch: z.strictObject({ branch: z.string() }).nullable().optional().describe('For set_git_branch, set a local branch name or pass null to clear the link.'),
    note: z.string().optional().describe('Watch only: a short note, visible to everyone in the cluster and repeated in the notice when the task ends (e.g. "start #12 after the merge"); trimmed, then at most 200 characters (UTF-16 code units).'),
    sourceEventId: z.number().int().optional(),
  }, (args) => `task.${args.action}` as CollaborationCommand['action'],
  (result, me) => (result.action === 'task.review' && result.review?.verdict === 'approve' && result.task?.mergeRequired
    ? { ...result, ...shipForRunner(hub, secret, hubUrl, me.clusterId, result.task.id, me.id) } : result));
  command('raise_attention', 'Record a question, blocker or other issue on a task.', {
    taskId: z.string().describe(taskRef), ...version, kind: z.string(), question: z.string(), targetMemberId: z.string().nullable().optional(),
    sourceEventId: z.number().int().optional(),
  }, 'task.attention');
  command('resolve_attention', 'Resolve a recorded task issue with an explanation.', {
    taskId: z.string().describe(taskRef), attentionId: z.string(), resolution: z.string(), ...version,
  }, 'task.resolve_attention');
  command('set_task_summary', 'Save a task summary with its source messages and the latest event it covers.', {
    taskId: z.string().describe(taskRef), summary: z.string(), throughEventId: z.number().int(), sourceMessageIds: z.array(z.string()), ...version,
  }, 'task.summary');
  command('link_message_tasks', 'Add or remove task links on an existing message in this cluster. messageId accepts a full ID or a unique prefix of at least 8 characters in this cluster; taskIds and removeTaskIds accept #number (e.g. #12), a full ID, or a unique prefix of at least 8 characters (bare 8+ digit numbers remain ID prefixes).', {
    messageId: z.string(), taskIds: z.array(z.string()).optional().describe(taskRef), removeTaskIds: z.array(z.string()).optional().describe(taskRef),
    reason: z.string().optional(), generation: version.generation,
  }, 'message.link');
}
