// Structural contracts for the tasks official package (zero imports outside package/hub/).
import type { IncomingMessage, ServerResponse } from 'node:http';

export type MemberStatus = 'idle' | 'busy' | 'offline';
export type SystemMessageKind =
  | 'delivery_failed' | 'hidden_work' | 'quota_exhausted' | 'ship_failed' | 'queue_warning' | 'stalled'
  | 'quota_low' | 'task_rejected' | 'task_attention' | 'review_downgraded' | 'plugin_rate_limit' | 'plugin_refused'
  | 'plugin_check_failed' | 'plugin_restarted' | 'task' | 'coordinator' | 'idle' | 'quota_recovered' | 'rebind'
  | 'member_renamed' | 'member_shown' | 'settings' | 'plugin_tool_call' | 'mode_removed' | 'receipt';

export interface ActivityObservation {
  kind: 'tool' | 'turn';
  phase: 'requested' | 'started' | 'finished' | 'failed';
  toolName?: string | null;
}

export interface Member {
  id: string;
  clusterId: string;
  name: string;
  avatar: string | null;
  harness: string;
  model: string | null;
  effort: string | null;
  workerSessionId: string;
  cwd: string;
  origin: 'attached' | 'created';
  status: MemberStatus;
  deliveryDisabled?: 'secondary';
  removedAt: string | null;
  hiddenAt: string | null;
  longWaiting?: number;
}

export type StoredMember = Omit<Member, 'status' | 'deliveryDisabled'>;

export interface Message {
  id: string;
  clusterId: string;
  from: string;
  mentions: string[];
  body: string;
  replyTo: string | null;
  chainId: string;
  hop: number;
  createdAt: string;
  kind?: 'chat' | 'task_comment' | 'system' | 'handover' | 'handoff' | 'resend' | 'plugin';
  collabEventId?: number;
  taskStamp?: { taskId: string; revision: number; submissionId: string | null };
  fyi?: boolean;
  systemKind?: SystemMessageKind;
  explicitMentions?: string[];
}

export interface FileInfo {
  id: string;
  clusterId: string;
  uploader: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export interface HubEvent {
  seq: number;
  clusterId: string | null;
  memberId: string | null;
  kind: 'cluster' | 'member' | 'message' | 'delivery' | 'read' | 'acknowledgement' | 'agent' | 'guard'
    | 'pause' | 'settings' | 'usage' | 'collaboration' | 'unread_hint' | 'delivery_dismissed';
  payload: unknown;
  createdAt: string;
}

export type CollaborationActor = { kind: 'user' } | { kind: 'member'; memberId: string } | { kind: 'self' } | { kind: 'system' };
export type TaskStatus = 'pending' | 'working' | 'review' | 'completed' | 'merged' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';
export type TaskCloseKind = 'not_planned' | 'duplicate' | 'superseded' | 'other';
export interface TaskCloseReason { kind: TaskCloseKind; taskId?: string; }
export type TaskChangeField = 'title' | 'scope' | 'acceptance' | 'priority' | 'labels' | 'reviewer'
  | 'executeRoleIds' | 'reviewRoleIds' | 'dependencyIds' | 'requiresApproval' | 'mergeRequired' | 'fileIds' | 'gitBranch';
export interface TaskChange { field: TaskChangeField; before: unknown; after: unknown; truncated?: boolean; fileNames?: Record<string, string>; }
export type CoordinatorPermission = 'taskPlanning' | 'assignment' | 'roleManagement' | 'reviewerManagement'
  | 'knowledgeCommunication' | 'recovery' | 'cancelReopen' | 'deliveryControl';
export type CoordinatorPermissions = Record<CoordinatorPermission, boolean>;
export interface StandingInstruction { id: string; text: string; createdBy: string; createdAt: string; }
export interface CoordinatorPolicy {
  memberId: string; enabled: boolean; mode: 'suggest' | 'execute'; generation: number; permissions: CoordinatorPermissions;
  taskPlanningRoleBypass?: boolean; standingInstructions?: StandingInstruction[];
}
export interface TaskGitBranch { repositoryPath: string; branch: string; automatic?: true; }
export type TakeoverBasis = 'user' | 'reviewer' | 'cluster_setting' | 'user_review' | 'named_member';
export interface TaskTakeoverMark { recordId: string; memberId: string; basis: TakeoverBasis; at: string; baseSubmissionId?: string | null; baseCommitSha?: string | null; }
export interface Takeover {
  id: string; taskId: string; action?: string; by: string; fromMemberId: string | null; toMemberId: string;
  reviewFrom: CollaborationActor; reviewTo: CollaborationActor; basis: TakeoverBasis;
  previousStatus: TaskStatus; previousRejected: boolean; createdAt: string;
  baseSubmissionId?: string | null; baseCommitSha?: string | null; reason?: string;
}
export interface TaskShipFailure {
  kind: 'conflict' | 'checks'; reason: string; detail: string; conflictFiles?: string[]; failedCheck?: string;
  at: string; eventId: number; approvedSubmissionId: string; approvedCommitSha: string; runnerId: string;
}
export interface SubmissionShipFix { runnerId: string; baseSubmissionId: string; baseCommitSha: string; originSubmissionId: string; failureEventId: number; }
export interface BatchShipFailureAttribution { taskIds: string[]; reason: string; by: string; at: string; eventId: number; }
export interface BatchShipFailureFix { taskId: string; fromSubmissionId: string; toSubmissionId: string; toCommitSha: string; at: string; }
export interface BatchShipFailure {
  kind: 'conflict' | 'checks'; taskIds: string[]; reason: string; detail: string; conflictFiles?: string[]; failedCheck?: string;
  digest: string; runnerId: string; at: string; eventId: number; attribution?: BatchShipFailureAttribution | null; fixes?: BatchShipFailureFix[];
}
export interface Task {
  id: string; number: number; clusterId: string; title: string; scope: string; acceptance: string; priority: TaskPriority;
  createdBy: string; originMessageId: string | null; status: TaskStatus; proposalState: 'active' | 'proposed';
  requiresApproval: boolean; mergeRequired: boolean; mergedCommitSha: string | null; mergedSubmissionId: string | null;
  revision: number; definitionVersion: number; reviewer: CollaborationActor;
  executeRoleIds: string[]; reviewRoleIds: string[]; labels: string[]; dependencyIds: string[]; fileIds: string[];
  gitBranch?: TaskGitBranch; currentAssignmentId: string | null; latestSubmissionId: string | null; approvedSubmissionId: string | null;
  assignedMemberId: string | null; dependenciesReady: boolean; dependenciesChanged: boolean; completionValid: boolean;
  createdAt: string; updatedAt: string; closeReason?: TaskCloseReason;
  executeRoles?: { id: string; name: string }[]; reviewRoles?: { id: string; name: string }[];
  manualCompletion?: true; takeover?: TaskTakeoverMark; batchId?: string; shipFailure?: TaskShipFailure | null;
}
export interface Assignment {
  id: string; taskId: string; memberId: string; actorKey: string; formerActorKeys?: string[];
  acceptedAt: string; startedAt: string | null; endedAt: string | null; endReason: string | null;
  dependencyVersions: Record<string, string>;
}
export interface Submission {
  id: string; taskId: string; assignmentId: string | null; definitionVersion: number; summary: string;
  commitSha: string | null; evidenceMessageIds: string[]; evidenceFileIds: string[]; contributorKeys: string[];
  dependencyVersions: Record<string, string>; createdAt: string; manual?: true; shipFix?: SubmissionShipFix;
}
export interface Review {
  id: string; taskId: string; submissionId: string; reviewer: CollaborationActor;
  verdict: 'approve' | 'reject'; reason: string; createdAt: string; self?: true; manual?: true; takeover?: true;
}
export interface Approval { id: string; taskId: string; verdict: 'approve' | 'reject'; reason: string; definitionVersion: number; createdAt: string; }
export interface Merge { id: string; taskId: string; commitSha: string | null; submissionId: string; reason: string; recordedBy: CollaborationActor; createdAt: string; manual?: true; }
export interface Attention {
  id: string; taskId: string; kind: string; question: string; targetMemberId: string | null;
  createdBy: string; createdAt: string; resolvedAt: string | null; resolution: string | null;
}
export interface TaskSummary { taskId: string; author: string; content: string; throughEventId: number; sourceMessageIds: string[]; updatedAt: string; }
export interface Role { id: string; clusterId: string; name: string; description: string; }
export interface MemberRoles { memberId: string; roleIds: string[]; }
export interface TaskPermissions { createRoleIds: string[]; executeRoleIds: string[]; reviewRoleIds: string[]; }
export interface TaskRef { id: string; number: number; title: string; status: TaskStatus; }
export interface CollectionItem { message: Message; taskIds?: string[]; attachments: FileInfo[]; [pluginField: string]: unknown; }
export interface CollectionsResult { items: CollectionItem[]; nextCursor: string | null; }
export interface WorkspaceResult {
  tasks: Task[]; roles: Role[]; memberRoles: MemberRoles[];
  coordinator: (CoordinatorPolicy & { rules: { version: string; text: string } }) | null;
  paused: boolean; generation: number; pausedBy: string | null; nextCursor: string | null;
  labels?: string[]; labelLibrary?: unknown; taskSettings?: { takeoverSelfReview: boolean }; taskPermissions?: TaskPermissions;
}
export interface TaskResult {
  task: Task; assignments: Assignment[]; submissions: (Submission & { superseded: boolean })[];
  reviews: (Review & { round: number; commitSha: string | null })[]; approvals: Approval[]; merges: Merge[];
  takeovers?: Takeover[]; attachments: FileInfo[]; dependencies: Task[]; attentions: Attention[];
  events: HubEvent[]; nextCursor: string | null; eventsNextCursor: string | null; linkedMessageCount: number;
  watchers?: { memberId: string; note: string | null; createdAt: string }[]; watching?: { note: string | null; createdAt: string } | null;
  shipRunnerId?: string; shipFixAllowed?: boolean;
}
export interface ContextResult {
  task: Task; dependencies: Task[]; assignment: Assignment | null; latestSubmission: Submission | null;
  attentions: Attention[]; messages: CollectionItem[]; events: HubEvent[]; summary: TaskSummary | null;
  nextCursor: string | null; messagesNextCursor: string | null; attentionsNextCursor: string | null;
}
export type CollaborationQueryResult = WorkspaceResult | Pick<WorkspaceResult, 'tasks' | 'nextCursor'> | TaskResult | CollectionsResult | ContextResult | { tasks: TaskRef[] };

export interface BranchLinkOutcome {
  status: 'linked' | 'kept' | 'cleared' | 'not_linked';
  branch?: string; automatic?: boolean; warning?: 'not_on_branch';
  reason?: 'timeout' | 'busy' | 'no_repository' | 'git_unavailable' | 'git_error' | 'unknown_commit' | 'no_branch' | 'several_branches' | 'invalid_branch' | 'changed';
  candidates?: string[]; more?: boolean;
}

export interface CollaborationCommand {
  action: string; operationId: string; taskId?: string; expectedRevision?: number;
  assignmentId?: string; submissionId?: string; title?: string; scope?: string; acceptance?: string; priority?: TaskPriority;
  originMessageId?: string | null; dependencyIds?: string[]; executeRoleIds?: string[]; reviewRoleIds?: string[];
  labels?: string[]; fileIds?: string[]; reviewer?: CollaborationActor; memberId?: string | null; roleId?: string; roleIds?: string[];
  gitBranch?: (Pick<TaskGitBranch, 'branch'> & Partial<Pick<TaskGitBranch, 'repositoryPath'>>) | null;
  description?: string; name?: string; summary?: string; evidenceMessageIds?: string[]; evidenceFileIds?: string[];
  commitSha?: string | null; requiresApproval?: boolean; mergeRequired?: boolean; expectedDependencyVersions?: Record<string, string>;
  verdict?: 'approve' | 'reject'; reason?: string; confirmStopped?: boolean; takeover?: boolean;
  failureEventId?: number; baseCommitSha?: string; closeReason?: TaskCloseKind; relatedTaskId?: string;
  attentionId?: string; kind?: string; question?: string; targetMemberId?: string | null; resolution?: string;
  messageId?: string; taskIds?: string[]; removeTaskIds?: string[];
  enabled?: boolean; mode?: 'suggest' | 'execute'; permissions?: Partial<CoordinatorPermissions>;
  taskPlanningRoleBypass?: boolean; generation?: number; paused?: boolean; hidden?: boolean; sourceEventId?: number;
  instructionId?: string; instructionText?: string; proposalState?: 'active' | 'proposed';
  throughEventId?: number; sourceMessageIds?: string[]; note?: string | null; taskPermissions?: TaskPermissions;
  batchId?: string; batchSubmissions?: { taskId: string; submissionId: string }[];
  failure?: { kind: 'conflict' | 'checks'; taskId?: string; detail?: string; conflictFiles?: string[]; failedCheck?: string };
}

export interface CollaborationQuery {
  kind: string; taskId?: string; limit?: number; cursor?: string; ids?: string[]; numbers?: number[];
  includeClosed?: boolean; messagesCursor?: string; eventsCursor?: string; attentionsCursor?: string;
  memberId?: string; label?: string | string[]; q?: string; status?: TaskStatus; holder?: string;
  sender?: string; since?: string; until?: string; open?: boolean; sort?: 'created-desc'; pageOnly?: boolean;
  eventsOrder?: 'asc' | 'desc'; eventsLimit?: number; messagesLimit?: number;
}

export interface CollaborationResult {
  action: string; eventId: number; task?: Task; role?: Role; coordinator?: CoordinatorPolicy | null;
  messageId?: string; assignment?: Assignment; submission?: Submission; review?: Review; takeover?: Takeover;
  approval?: Approval; merge?: Merge; attention?: Attention; suggestion?: unknown;
  deleted?: { id: string; title: string; linkedMessageCount: number };
  gitBranch?: BranchLinkOutcome;
}

export interface CollaborationNotice {
  recipients: string[]; body: string; systemKind: SystemMessageKind; wake?: string[]; retain?: boolean;
  taskId?: string; collabEventId?: number; taskStamp?: { taskId: string; revision: number; submissionId: string | null };
}

export interface PluginActionOutcome { payload?: (suggested: boolean) => Record<string, unknown>; afterEvent?: (event: any) => void; }

export interface Collaboration {
  member(clusterId: string, memberId: unknown): StoredMember;
  memberRef<T>(clusterId: string, ref: T): T;
  actor(actor: CollaborationActor, clusterId: string): string;
  roleIds(clusterId: string, value: unknown, field: string): string[];
  resolveId<T>(table: string, clusterId: string, ref: T, unknownMessage: string, listing?: string): T;
  query(actor: CollaborationActor, clusterId: string, query: CollaborationQuery): CollaborationQueryResult;
  command(actor: CollaborationActor, clusterId: string, command: CollaborationCommand): CollaborationResult;
}

export interface Store {
  db: { prepare(sql: string): { get(...args: any[]): any; all(...args: any[]): any[]; run(...args: any[]): { changes: number | bigint } } };
  prepared(sql: string): { all(...args: any[]): any[] };
  transaction<T>(fn: () => T): T;
  getCluster(id: string): unknown;
  listClusters(): { id: string }[];
  getMember(id: string, opts?: { includeRemoved?: boolean }): StoredMember | null | undefined;
  listMembers(clusterId: string, opts?: { includeRemoved?: boolean }): StoredMember[];
  getMessage(id: string): Message | null | undefined;
  getFile(id: string): FileInfo | null;
  getEvent(seq: number): HubEvent | null;
  eventInCluster(clusterId: string, seq: number): boolean;
  appendEvent(clusterId: string | null, memberId: string | null, kind: HubEvent['kind'], payload: unknown): HubEvent;
  appendCollaborationEvent(clusterId: string, memberId: string | null, payload: Record<string, unknown>): HubEvent;
  supersedeEventNotices(clusterId: string, memberId: string, action: string, match: Record<string, string>, reason: string): { memberId: string }[];
  idsMatching(table: string, clusterId: string, prefix: string, minLen: number): string[];
  collaborationRoles(clusterId: string): Role[];
  collaborationMemberRoles(clusterId: string): MemberRoles[];
  collaborationCollection(clusterId: string, query: { limit: number; cursor?: string; q?: string; sender?: string; since?: string; until?: string; where?: { sql: string; args: (string | number)[] }[] }): CollectionsResult;
  clusterPause(clusterId: string): { paused: boolean; pausedBy: string | null };
  hiddenWork(memberId: string, since: string): { taskId: string; kind: string; role: string; seq: number; at: string }[];
  lastActivity(memberId: string): { source: 'message' | 'delivery' | 'activity' | 'read' | 'acknowledgement'; at: string; event: unknown } | null;
  coordinator: { policy(clusterId: string): CoordinatorPolicy | null; generation(clusterId: string): number; rules: { version: string; text: string } } | null;
  tasks: { task(clusterId: string, taskId: string): Task | null } | null;
}

export interface Hub {
  store: Store;
  collaboration: Collaboration;
  limits: { idleCheckMs: number; idleTaskGraceMs: number; idleMemberGraceMs: number; idleNoticeGapMs: number };
  stalledAfterMs: number;
  services: Pick<Map<string, any>, 'get'>;
  isRunning(): boolean;
  isPaused(): boolean;
  publishEvents(events: HubEvent[]): void;
  visibleMembers(clusterId: string, viewerMemberId: string | null, members: readonly StoredMember[]): StoredMember[];
  attachmentViews(files: FileInfo[]): unknown[];
  noticeCoordinator(clusterId: string): CoordinatorPolicy | null;
  listMembers(clusterId: string): Member[];
  quotaExhaustedNow(harness: string, now: number): boolean;
  getNotifySetting(key: 'stalledMemberMinutes'): { value: number };
  postNotice(clusterId: string, memberId: string, body: string, taskIds: string[], onDone: () => void, systemKind: SystemMessageKind): void;
}

export interface PluginActionContext {
  store: Store; actor: CollaborationActor; actorId: string; clusterId: string;
  command: CollaborationCommand; now: string; collaboration: Collaboration; hub: Hub;
  management(permission: CoordinatorPermission, ordinaryAllowed?: boolean): boolean;
  outcome: PluginActionOutcome;
  notice(event: any, notice: CollaborationNotice): void;
  deliveriesChanged(events: HubEvent[]): void;
  afterCommit(publish: () => void): void;
  prepared?: unknown;
}
export type PluginPrepare = (ctx: { store: Store; actor: CollaborationActor; actorId: string; clusterId: string; command: CollaborationCommand; signal: AbortSignal }) => Promise<unknown>;
export type PluginAction = (ctx: PluginActionContext) => Partial<CollaborationResult> & Record<string, unknown>;
export interface PluginRefContext { store: Store; clusterId: string; command: CollaborationCommand; collaboration: Collaboration; }
export interface PluginQueryContext { store: Store; actor: CollaborationActor; clusterId: string; query: CollaborationQuery; limit: number; collaboration: Collaboration; }
export type PluginQuery = (ctx: PluginQueryContext) => CollaborationQueryResult;
export interface PluginToolApi {
  page: Record<string, unknown>; hub: Hub; secret: string; hubUrl: string;
  query(name: string, description: string, kind: string, schema: Record<string, unknown>,
    prepare?: (params: Record<string, unknown>) => Record<string, unknown>,
    project?: (result: never, params: Record<string, unknown>, me: { id: string; clusterId: string }) => unknown): void;
  command(name: string, description: string, schema: Record<string, unknown>,
    action: string | ((args: Record<string, unknown>) => string),
    extend?: (result: CollaborationResult, me: { id: string; clusterId: string }) => unknown): void;
}
export interface PluginRoute { method: string; pattern: RegExp; noStore?: true; handle(ctx: { hub: Hub; params: string[]; url: URL; body?: unknown }): unknown; }
export interface PluginBridgeRoute { method: string; pattern: RegExp; handle(ctx: { hub: Hub; secret: string; params: string[]; req: IncomingMessage; res: ServerResponse }): Promise<void>; }
export interface EnvelopeItem { message: Message; header?: string; lead?: string; afterBody?: string; tail?: string; }
export interface MemberTaskFacts {
  task: Task; role: 'executor' | 'reviewer' | 'former'; commitSha: string | null; mergedCommitSha: string | null;
  summary: string | null; submissionBy: string | null;
  review: { verdict: 'approve' | 'reject'; self: boolean; reviewer: string; at: string; reason: string } | null;
  questions: string[];
}
export interface PluginService {
  start?(): void; close?(): void; sweep?(): void; onEvent?(event: HubEvent): void;
  onMemberStatus?(member: Member, before: MemberStatus | undefined): void;
  onQuotaChanged?(): void; onClusterPurged?(clusterId: string, memberIds: string[]): void;
}
export interface EventTypeSpec {
  type: string; description: string; fields: string; from: 'collaboration';
  build(event: HubEvent): Record<string, unknown> | Record<string, unknown>[] | null;
}
export interface EventSource { types: EventTypeSpec[]; }
