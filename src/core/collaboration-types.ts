// Public collaboration contract shared by the Hub, HTTP and MCP layers.
import type { FileInfo, HubEvent, Message } from './types.ts';

/** `system` is only ever passed by the Hub itself (the tasks plugin's ship report): no HTTP or MCP entry lets a caller name it. */
export type CollaborationActor = { kind: 'user' } | { kind: 'member'; memberId: string } | { kind: 'self' } | { kind: 'system' };
/** pending: not started yet, with or without an executor (assignedMemberId). An old stored 'accepted' reads as pending. */
export type TaskStatus = 'pending' | 'working' | 'review' | 'completed' | 'merged' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';
/** Why a task was cancelled; duplicate and superseded name another task of the cluster (which may since be deleted). */
export type TaskCloseKind = 'not_planned' | 'duplicate' | 'superseded' | 'other';
export interface TaskCloseReason { kind: TaskCloseKind; taskId?: string; }
/** A task field whose before/after value is recorded in its history. */
export type TaskChangeField = 'title' | 'scope' | 'acceptance' | 'priority' | 'labels' | 'reviewer'
  | 'executeRoleIds' | 'reviewRoleIds' | 'dependencyIds' | 'requiresApproval' | 'mergeRequired' | 'fileIds' | 'gitBranch';
/**
 * One recorded task change: the event payload's `changes` entry (docs/collaboration-api.md). Text values over
 * 20 KB are cut and the entry is marked `truncated`; create records only the fields that were set.
 */
export interface TaskChange { field: TaskChangeField; before: unknown; after: unknown; truncated?: boolean;
  /** fileIds only: each listed file's name at the time of the change, so the history stays readable. */
  fileNames?: Record<string, string>; }
export type CoordinatorPermission = 'taskPlanning' | 'assignment' | 'roleManagement' | 'reviewerManagement'
  | 'knowledgeCommunication' | 'recovery' | 'cancelReopen' | 'deliveryControl';
export type CoordinatorPermissions = Record<CoordinatorPermission, boolean>;
export interface StandingInstruction { id: string; text: string; createdBy: string; createdAt: string; }
export interface CoordinatorPolicy {
  memberId: string; enabled: boolean; mode: 'suggest' | 'execute'; generation: number; permissions: CoordinatorPermissions;
  /** User opt-in under taskPlanning; missing means the group create roles still apply. */
  taskPlanningRoleBypass?: boolean;
  /** User's long-term requirements, kept across coordinator changes; missing in old policies means []. */
  standingInstructions?: StandingInstruction[];
}
/** automatic: linked by a submit, not by set_git_branch; missing means manual (links stored before it existed too). */
export interface TaskGitBranch { repositoryPath: string; branch: string; automatic?: true; }
export interface Task {
  id: string;
  /** Shown as #12: 1, 2, 3… per cluster, taken when the task is created and never given again (docs/collaboration.md). */
  number: number;
  clusterId: string; title: string; scope: string; acceptance: string; priority: TaskPriority; createdBy: string;
  originMessageId: string | null; status: TaskStatus; proposalState: 'active' | 'proposed';
  requiresApproval: boolean; mergeRequired: boolean; mergedCommitSha: string | null; mergedSubmissionId: string | null;
  revision: number; definitionVersion: number; reviewer: CollaborationActor;
  executeRoleIds: string[]; reviewRoleIds: string[]; labels: string[]; dependencyIds: string[];
  /** Files attached to the definition (docs/collaboration.md); missing in old rows reads as []. */
  fileIds: string[];
  /** Local work location, independent of the immutable SHAs for reviewed and merged commits. */
  gitBranch?: TaskGitBranch;
  currentAssignmentId: string | null; latestSubmissionId: string | null; approvedSubmissionId: string | null;
  /** The executor, from assignment until the result is approved or the work given back. */
  assignedMemberId: string | null; dependenciesReady: boolean; dependenciesChanged: boolean; completionValid: boolean;
  createdAt: string; updatedAt: string;
  /** Set by task.cancel, cleared by task.reopen; tasks cancelled before it existed have none. */
  closeReason?: TaskCloseReason;
  /** Display-only projection of executeRoleIds/reviewRoleIds with names; deleted roles read as 已删除角色（id）. */
  executeRoles?: { id: string; name: string }[];
  reviewRoles?: { id: string; name: string }[];
  /** Display-only: the current approved submission was recorded by the user without an executor. */
  manualCompletion?: true;
  /** The latest reviewer takeover (task.takeover): who took the task over, on what basis, when. Kept as history. */
  takeover?: TaskTakeoverMark;
  /** The review batch it belongs to (the tasks plugin's batches.ts); absent outside a batch. */
  batchId?: string;
}
/**
 * Why the review mode after a takeover is what it is: the user did the takeover (user), the cluster setting allowed
 * self review (cluster_setting), the user reviews by default (user_review), or a named member reviews (named_member).
 */
export type TakeoverBasis = 'user' | 'cluster_setting' | 'user_review' | 'named_member';
export interface TaskTakeoverMark { recordId: string; memberId: string; basis: TakeoverBasis; at: string; }
/**
 * A takeover-style record (append-only, kind 'takeover'): a task.takeover (the reviewer became the executor and the
 * review mode changed), or, on a task already taken over, an authorised switch to self review (task.edit) or move of
 * it to another executor (task.assign / task.claim / task.handoff). Self review is bound to the latest one's toMemberId.
 */
export interface Takeover {
  id: string; taskId: string;
  /** The command that wrote it. Records written before this field existed are takeovers. */
  action?: string;
  /** Who started it: 'user', or a member id (the executor, the reviewer or the coordinator). */
  by: string;
  /** The executor before, if any; the member who took over (the reviewer before). */
  fromMemberId: string | null; toMemberId: string;
  reviewFrom: CollaborationActor; reviewTo: CollaborationActor; basis: TakeoverBasis;
  /** The task's status before, and whether the latest review before it was a rejection. */
  previousStatus: TaskStatus; previousRejected: boolean; createdAt: string;
}
export interface Assignment {
  id: string; taskId: string; memberId: string; actorKey: string;
  /** Conversations this member used before it was moved (Hub.rebindMember); they still count as having worked on it. */
  formerActorKeys?: string[];
  acceptedAt: string;
  startedAt: string | null; endedAt: string | null; endReason: string | null; dependencyVersions: Record<string, string>;
}
export interface Submission {
  id: string; taskId: string; assignmentId: string | null; definitionVersion: number; summary: string;
  commitSha: string | null;
  evidenceMessageIds: string[]; evidenceFileIds: string[]; contributorKeys: string[];
  dependencyVersions: Record<string, string>; createdAt: string;
  /** A result attested by the user, with no assigned executor or reviewed commit. */
  manual?: true;
}
export interface Review {
  id: string; taskId: string; submissionId: string; reviewer: CollaborationActor;
  verdict: 'approve' | 'reject'; reason: string; createdAt: string;
  /** Written by the Hub when the executor submits a self-review task; the reviewer is the executor. */
  self?: true;
  /** The user's attestation when manually recording a result. */
  manual?: true;
  /** A self review written by the member who took the task over from its review (task.takeover). */
  takeover?: true;
}
/** Read projections; never written back into the immutable submission/review records. */
export interface SubmissionView extends Submission { superseded: boolean; }
export interface ReviewView extends Review { round: number; commitSha: string | null; }
export interface Approval {
  id: string; taskId: string; verdict: 'approve' | 'reject'; reason: string; definitionVersion: number; createdAt: string;
}
export interface Merge {
  id: string; taskId: string; commitSha: string | null; submissionId: string; reason: string; recordedBy: CollaborationActor; createdAt: string;
  /** The user recorded the status without a Git check. */
  manual?: true;
}
export interface Attention {
  id: string; taskId: string; kind: string; question: string; targetMemberId: string | null;
  createdBy: string; createdAt: string; resolvedAt: string | null; resolution: string | null;
}
export interface TaskSummary { taskId: string; author: string; content: string; throughEventId: number; sourceMessageIds: string[]; updatedAt: string; }
export interface Role { id: string; clusterId: string; name: string; description: string; }
export interface MemberRoles { memberId: string; roleIds: string[]; }
/** A message with what is attached to it; plugins add their own fields (messageFields). */
export interface CollectionItem { message: Message; taskIds?: string[]; attachments: FileInfo[]; [pluginField: string]: unknown; }

export type CollaborationQuery = {
  /** A core query, or one registered by a plugin. */
  kind: 'workspace' | 'task' | 'context' | 'task_refs' | (string & {}); taskId?: string; limit?: number; cursor?: string;
  /** task_refs: resolve these task ids or numbers (at most 100 combined); without ids/numbers it lists picker candidates for q. */
  ids?: string[];
  numbers?: number[];
  includeClosed?: boolean;
  messagesCursor?: string; eventsCursor?: string; attentionsCursor?: string;
  memberId?: string; label?: string | string[]; q?: string; status?: TaskStatus;
  /** workspace: only the open tasks this member holds, as executor (pending, working, review) or as the reviewer of one in review. */
  holder?: string; sender?: string; since?: string; until?: string;
  /** workspace without status: only tasks that are not completed, merged or cancelled. */
  open?: boolean;
  /** HTTP workspace opts into newest-first pages or requests only tasks and their next cursor. */
  sort?: 'created-desc'; pageOnly?: boolean;
  /** task/context: 'desc' returns the newest events first and the events cursor pages back to older ones. */
  eventsOrder?: 'asc' | 'desc';
  /** task/context: events per page (default: limit). context: messages per page (default: limit). */
  eventsLimit?: number; messagesLimit?: number;
};
export interface WorkspaceResult {
  tasks: Task[]; roles: Role[]; memberRoles: MemberRoles[]; coordinator: (CoordinatorPolicy & { rules: { version: string; text: string } }) | null;
  paused: boolean; generation: number; pausedBy: string | null; nextCursor: string | null;
  /** Every label used by this cluster's tasks (for filter autocompletion). */
  labels?: string[];
  /** The global label library with the groups this cluster chose (the tasks plugin's labels.ts LibraryView). */
  labelLibrary?: unknown;
  /** This cluster's task settings; only the user changes them (tasks.settings). */
  taskSettings?: { takeoverSelfReview: boolean };
  taskPermissions?: TaskPermissions;
}

export interface TaskPermissions {
  createRoleIds: string[];
  executeRoleIds: string[];
  reviewRoleIds: string[];
}
export interface TaskResult {
  task: Task; assignments: Assignment[]; submissions: SubmissionView[]; reviews: ReviewView[]; approvals: Approval[]; merges: Merge[];
  /** Reviewer takeovers, oldest first (task.takeover). */
  takeovers?: Takeover[];
  /** The stored files of task.fileIds, in that order. */
  attachments: FileInfo[];
  dependencies: Task[]; attentions: Attention[]; events: HubEvent[]; nextCursor: string | null; eventsNextCursor: string | null;
  /** How many messages are linked to the task; the user's delete confirmation names that number. */
  linkedMessageCount: number;
  /** Every member watching the task, oldest first; the same for every reader (watches are public in the cluster). */
  watchers?: { memberId: string; note: string | null; createdAt: string }[];
  /** A member reading: its own entry of `watchers`, or null. Absent for the user. */
  watching?: { note: string | null; createdAt: string } | null;
}
export interface CollectionsResult { items: CollectionItem[]; nextCursor: string | null; }
export interface ContextResult {
  task: Task; dependencies: Task[]; assignment: Assignment | null; latestSubmission: Submission | null;
  attentions: Attention[]; messages: CollectionItem[]; events: HubEvent[]; summary: TaskSummary | null;
  nextCursor: string | null; messagesNextCursor: string | null; attentionsNextCursor: string | null;
}
export interface TaskRef { id: string; number: number; title: string; status: TaskStatus; }
export interface TaskRefsResult { tasks: TaskRef[]; }
export type CollaborationQueryResult = WorkspaceResult | Pick<WorkspaceResult, 'tasks' | 'nextCursor'> | TaskResult | CollectionsResult | ContextResult | TaskRefsResult;

export type CollaborationAction = 'task.create' | 'task.edit' | 'task.assign' | 'task.nominate' | 'task.claim' | 'task.start'
  | 'task.submit' | 'task.review' | 'task.approve' | 'task.merge' | 'task.mark_completed' | 'task.mark_merged'
  | 'task.shipped' | 'task.ship_failed' | 'task.release' | 'task.cancel' | 'task.reopen' | 'task.set_git_branch'
  | 'task.handoff' | 'task.takeover' | 'task.delete' | 'task.watch' | 'task.unwatch'
  | 'task.attention' | 'task.resolve_attention' | 'task.summary' | 'message.link'
  | 'role.create' | 'role.edit' | 'role.delete' | 'role.ensure_defaults' | 'member.roles' | 'coordinator.set' | 'cluster.pause' | 'member.hidden'
  | 'coordinator.instruction.add' | 'coordinator.instruction.edit' | 'coordinator.instruction.remove'
  // An action registered by a plugin.
  | (string & {});

/** Fields not used by the selected action are ignored; identity always comes from CollaborationActor. */
export interface CollaborationCommand {
  action: CollaborationAction; operationId: string; taskId?: string; expectedRevision?: number;
  assignmentId?: string; submissionId?: string; title?: string; scope?: string; acceptance?: string; priority?: TaskPriority;
  originMessageId?: string | null; dependencyIds?: string[]; executeRoleIds?: string[]; reviewRoleIds?: string[];
  labels?: string[]; fileIds?: string[]; reviewer?: CollaborationActor; memberId?: string | null; roleId?: string; roleIds?: string[];
  /** task.set_git_branch: only the user supplies a repositoryPath; null clears the link. */
  gitBranch?: (Pick<TaskGitBranch, 'branch'> & Partial<Pick<TaskGitBranch, 'repositoryPath'>>) | null;
  /** Role description (role.create/role.edit): trimmed, '' clears it, at most 500 characters. */
  description?: string;
  name?: string; summary?: string; evidenceMessageIds?: string[]; evidenceFileIds?: string[];
  /** task.submit/task.merge/task.mark_merged: the reviewed branch commit or the merge commit (7-40 hexadecimal characters). */
  commitSha?: string | null; requiresApproval?: boolean; mergeRequired?: boolean;
  expectedDependencyVersions?: Record<string, string>;
  verdict?: 'approve' | 'reject'; reason?: string; confirmStopped?: boolean;
  /** task.cancel: why (default other); duplicate and superseded require relatedTaskId, the others refuse it. */
  closeReason?: TaskCloseKind; relatedTaskId?: string;
  attentionId?: string; kind?: string; question?: string; targetMemberId?: string | null; resolution?: string;
  messageId?: string; taskIds?: string[]; removeTaskIds?: string[];
  enabled?: boolean; mode?: 'suggest' | 'execute'; permissions?: Partial<CoordinatorPermissions>;
  /** coordinator.set (user only): allow taskPlanning to bypass the group create role list. */
  taskPlanningRoleBypass?: boolean;
  generation?: number; paused?: boolean; hidden?: boolean; sourceEventId?: number;
  /** coordinator.instruction.*: the standing instruction to edit/remove. */
  instructionId?: string;
  /** coordinator.instruction.add/edit: trimmed, 1-500 characters. */
  instructionText?: string;
  proposalState?: 'active' | 'proposed'; throughEventId?: number; sourceMessageIds?: string[];
  /** task.watch: the watcher's own note, returned in the end notice; trimmed, at most 200 characters. */
  note?: string | null;
  /** tasks.settings (user only): allow self review after a reviewer takeover in this cluster. */
  takeoverSelfReview?: boolean;
  /** tasks.permissions (user only): the complete set of group-wide task role gates. */
  taskPermissions?: TaskPermissions;
  /** task.create and batch.*: the review batch (an ID, a unique prefix or B<number>). */
  batchId?: string;
  /** batch.shipped / batch.ship_failed (the Hub only): the approved submissions the ship ticket was signed for. */
  batchSubmissions?: { taskId: string; submissionId: string }[];
  /** batch.ship_failed (the Hub only): what failed, and for a conflict the task whose branch conflicted. */
  failure?: { kind: 'conflict' | 'checks'; taskId?: string };
}
export interface CollaborationResult {
  action: CollaborationAction; eventId: number; task?: Task; role?: Role; coordinator?: CoordinatorPolicy | null;
  messageId?: string; assignment?: Assignment; submission?: Submission; review?: Review;
  attention?: Attention; suggestion?: CollaborationCommand; paused?: boolean; hidden?: boolean;
  approval?: Approval; merge?: Merge;
  /** task.takeover only: the record it appended. */
  takeover?: Takeover;
  /** task.delete only: the removed task and what the confirmation said it was removing. */
  deleted?: { id: string; title: string; linkedMessageCount: number };
  /** task.submit with a commitSha through the MCP tools only: what happened to the task's branch link (docs/collaboration-api.md). */
  gitBranch?: BranchLinkOutcome;
}
/**
 * linked: the submit linked (or moved) the automatic link; kept: the link stayed; cleared: an automatic link that no
 * longer fits was removed; not_linked: there was none and none was made. `reason` says why it was not linked or could
 * not be checked; `warning: not_on_branch` means a manual link's branch does not contain the commit.
 */
export interface BranchLinkOutcome {
  status: 'linked' | 'kept' | 'cleared' | 'not_linked';
  branch?: string; automatic?: boolean;
  reason?: 'no_repository' | 'git_unavailable' | 'git_error' | 'timeout' | 'busy' | 'unknown_commit' | 'no_branch' | 'several_branches' | 'invalid_branch' | 'changed';
  /** Branches at the commit that were not linked: at most 5 names and 2048 characters; `more` when others were left out. */
  candidates?: string[]; more?: boolean;
  warning?: 'not_on_branch';
}
