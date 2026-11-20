// Host bridge and structural core contracts for the coordinator official package (zero external imports).

export type CoordinatorPermission =
  | 'taskPlanning' | 'assignment' | 'roleManagement' | 'reviewerManagement'
  | 'knowledgeCommunication' | 'recovery' | 'cancelReopen' | 'deliveryControl';

export type CoordinatorPermissions = Record<CoordinatorPermission, boolean>;

export interface StandingInstruction {
  id: string;
  text: string;
  createdBy: string;
  createdAt: string;
}

export interface CoordinatorPolicy {
  memberId: string;
  enabled: boolean;
  mode: 'suggest' | 'execute';
  generation: number;
  permissions: CoordinatorPermissions;
  taskPlanningRoleBypass?: boolean;
  standingInstructions?: StandingInstruction[];
}

export type CollaborationActorLike =
  | { kind: 'user' }
  | { kind: 'member'; memberId: string }
  | { kind: 'self' }
  | { kind: 'system' };

export interface TaskLike {
  id: string;
  number: number;
  title: string;
  status: string;
  proposalState: 'active' | 'proposed';
  assignedMemberId: string | null;
  reviewer: CollaborationActorLike;
}

export interface MemberLike {
  id: string;
  clusterId: string;
  name: string;
  removedAt: string | null;
  hiddenAt: string | null;
}

export interface HubEventLike {
  seq: number;
  clusterId?: string | null;
  memberId?: string | null;
  createdAt: string;
  payload?: unknown;
}

export interface StatementLike {
  get(...args: any[]): any;
  run(...args: any[]): unknown;
}

export interface StoreLike {
  db: { prepare(sql: string): StatementLike };
  getCluster(id: string): unknown;
  getMember(id: string, options?: { includeRemoved?: boolean }): MemberLike | null | undefined;
  clusterPause(clusterId: string): { paused: boolean };
  unreadIds(memberId: string, clusterId: string, options?: { until?: string }): string[];
  listMessages(clusterId: string, limit?: number): { from: string; createdAt: string }[];
  appendCollaborationEvent(clusterId: string, memberId: string | null, payload: Record<string, unknown>): HubEventLike;
  tasks: {
    all(clusterId: string): TaskLike[];
    unresolvedQuestions(taskId: string): string[];
  } | null;
}

export interface HubLike {
  isPaused(): boolean;
  writeSystemMessage(clusterId: string, recipients: string[], body: string, taskIds: string[],
    sourceEventSeq: number, systemKind: 'coordinator'): () => void;
  skipMessages(member: any, messageIds: string[]): void;
}

export interface CoordinatorCommandLike {
  action: string;
  memberId?: string | null;
  enabled?: boolean;
  mode?: 'suggest' | 'execute';
  permissions?: Partial<CoordinatorPermissions>;
  taskPlanningRoleBypass?: boolean;
  instructionId?: string;
  instructionText?: string;
}

export interface ActionContextLike {
  store: StoreLike;
  actor: CollaborationActorLike;
  actorId: string;
  clusterId: string;
  command: CoordinatorCommandLike;
  now: string;
  collaboration: { member(clusterId: string, memberId: unknown): MemberLike };
  hub: HubLike;
  management(permission: CoordinatorPermission, ordinaryAllowed?: boolean): boolean;
  outcome: { afterEvent?: (event: any) => void };
  notice(event: any, notice: { body: string; recipients: string[]; systemKind: 'coordinator' }): void;
  afterCommit(publish: () => void): void;
}

export interface CoordinatorHost {
  collaboration: {
    CollaborationError: new (code: string, message: string) => Error;
    personName(store: any, clusterId: string, id: unknown, showHidden?: boolean): string;
  };
  hub: {
    OPEN_STATUS_LABEL: Record<string, string>;
  };
}

let current: CoordinatorHost | undefined;

export function setHost(h: CoordinatorHost): void { current = h; }

export function host(): CoordinatorHost {
  if (!current) throw new Error('Coordinator host is not attached yet.');
  return current;
}
