import { randomUUID } from 'node:crypto';
import { ensureDefaultRoles } from './default-roles.ts';
import type { Hub } from './hub.ts';
import { asyncRefused, isThenable, type PluginActionOutcome } from './plugin.ts';
import type { Store, StoredMember } from './store.ts';
import type { HubEvent, Message, SystemMessageKind } from './types.ts';
import type {
  CollaborationActor, CollaborationCommand, CollaborationQuery, CollaborationQueryResult,
  CollaborationResult, CoordinatorPermission, Role, Task,
} from './collaboration-types.ts';

export class CollaborationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
/** The next step for refusals whose fix depends only on the code; other refusals say it where they are raised. */
const NEXT_STEP: Record<string, string> = {
  OPERATION_CONFLICT: '; use a new operationId for a different command, or resend the original request unchanged',
  STALE_POLICY: '; read list_tasks.coordinator.generation and retry with it, or omit generation if you are not the enabled coordinator',
};
const fail = (code: string, message: string): never => { throw new CollaborationError(code, message + (NEXT_STEP[code] ?? '')); };
export const MIN_ID_PREFIX = 8;
/** `prepared` when no prepare step ran at all (Collaboration.command), as opposed to one that prepared nothing. */
const NOT_PREPARED = Symbol('not prepared');
/**
 * A plugin's action, query or reference resolution answers synchronously (it runs inside the command's transaction or
 * the query's read): a promise is refused with PLUGIN_ASYNC, its rejection caught, and the transaction rolls back.
 */
function sync<T>(value: T, what: string): T {
  if (isThenable(value)) fail('PLUGIN_ASYNC', `plugin ${asyncRefused(value, what).message}; nothing was changed`);
  return value;
}
/** How long commandAsync waits for an action's plugin `prepare` step (Collaboration.prepareTimeoutMs; tests shorten it). */
export const PREPARE_TIMEOUT_MS = 5000;
/** What every orrery tool answers a hidden member (docs/cluster-members.md「隐身」); it names nobody else. */
export const HIDDEN_TOOL_TEXT = '你已被设为隐身，暂时不在这个群里：orrery 工具不会执行任何操作，也不会发出消息。等用户或协调员取消隐身后再使用。';
/** Core actions that take the generation pre-check; plugins declare theirs (OfficialPlugin.managementActions). */
const MANAGEMENT_ACTIONS = new Set(['role.create', 'role.edit', 'role.delete', 'role.ensure_defaults', 'member.roles', 'cluster.pause', 'member.hidden']);
/** Who did the work, across memberships: the same app conversation is the same participant (independent review). */
export const actorKey = (m: Pick<StoredMember, 'harness' | 'workerSessionId'>) => JSON.stringify([m.harness, m.workerSessionId]);
export const required = (value: unknown, field: string, max = 20_000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail('INVALID_REQUEST', field + ' is required');
  return value.trim();
};
export const strings = (value: unknown, field: string, max = 100): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || !value.every((s) => typeof s === 'string' && s.trim() && s.length <= 200)
    || new Set(value).size !== value.length) return fail('INVALID_REQUEST', field + ' must contain distinct non-empty strings');
  return value as string[];
};
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
/** Display name from a cluster's member list (with removed): appends `（已移出）` only when a removed member shares a name with an active one. */
export const memberLabel = (members: readonly StoredMember[], id: unknown, userLabel = 'user'): string => {
  if (typeof id !== 'string' || id === 'user') return userLabel;
  const member = members.find((item) => item.id === id);
  if (!member) return id;
  if (member.removedAt && members.some((other) => !other.removedAt && other.name === member.name)) {
    return `${member.name}（已移出）`;
  }
  return member.name;
};
/**
 * How generated text names a member that is hidden now (docs/cluster-members.md「隐身」): nobody in particular, and
 * without saying it is hidden, since every member can read a stored notice.
 */
export const HIDDEN_PERSON = '一位成员';
/**
 * A member's display name in a notification; the user stays "用户" and a missing member keeps its id. Every text the
 * Hub writes itself (notices, receipts, warnings, briefings, envelopes) names members through this, and a member hidden
 * now is HIDDEN_PERSON: a stored notice is read by every member, so it must not carry the name. `showHidden` is only for
 * output that goes to the user or the enabled coordinator alone.
 */
export const personName = (store: Store, clusterId: string, id: unknown, showHidden = false): string => {
  if (typeof id !== 'string' || id === 'user') return '用户';
  const member = store.getMember(id, { includeRemoved: true });
  if (member?.clusterId !== clusterId) return id;
  if (member.hiddenAt && !member.removedAt && !showHidden) return HIDDEN_PERSON;
  if (member.removedAt && store.listMembers(clusterId).some((other) => other.name === member.name)) {
    return `${member.name}（已移出）`;
  }
  return member.name;
};
/** A business role's description: trimmed, '' allowed (it clears one), at most 500 characters. */
const roleDescription = (value: unknown): string => {
  if (typeof value !== 'string') return fail('INVALID_REQUEST', 'description must be a string');
  const trimmed = value.trim();
  if (trimmed.length > 500) return fail('INVALID_REQUEST', 'description must be at most 500 characters');
  return trimmed;
};

/** One system message a command writes; the Hub fills in its chain, hop and deliveries. */
export interface CollaborationNotice {
  body: string;
  /** What kind of notice it is; its category comes from src/core/system-kinds.js. */
  systemKind: SystemMessageKind;
  /** Who it names; anyone no longer in the cluster is dropped. */
  recipients: string[];
  /** Who of them gets a delivery and a turn; the rest only find it unread. Default: all of them. */
  wake?: string[];
  /** Keep it in the chat record even with nobody left to tell. */
  retain?: boolean;
  /** The task to link it to (TaskView.linkMessage). */
  taskId?: string;
  /** The event the web page can open for this notice. */
  collabEventId?: number;
  taskStamp?: Message['taskStamp'];
}

/** Writes notification messages in the caller's transaction; the returned callback publishes only after commit. */
export type CollaborationNotification = (actor: CollaborationActor, clusterId: string, event: HubEvent, notice: CollaborationNotice) => (() => void) | undefined;

export class Collaboration {
  private readonly store: Store;
  private readonly notify: (event: HubEvent) => void;
  private readonly notification: CollaborationNotification;
  private readonly hub: Hub;
  private readonly deliveriesChanged: (events: HubEvent[]) => void;
  /** commandAsync's time limit for a plugin `prepare` step (Limits.prepareTimeoutMs). */
  prepareTimeoutMs = PREPARE_TIMEOUT_MS;
  constructor(store: Store, notify: (event: HubEvent) => void, notification: CollaborationNotification, hub: Hub,
    deliveriesChanged: (events: HubEvent[]) => void) {
    this.store = store; this.notify = notify; this.notification = notification; this.hub = hub;
    this.deliveriesChanged = deliveriesChanged;
  }

  actor(actor: CollaborationActor, clusterId: string): string {
    if (!this.store.getCluster(clusterId)) return fail('OUT_OF_SCOPE', 'unknown cluster; use a clusterId from the orrery envelope');
    if (actor?.kind === 'user') return 'user';
    if (actor?.kind === 'system') return 'system';
    if (actor?.kind === 'member') {
      const member = this.store.getMember(actor.memberId);
      // A hidden member acts on nothing: the MCP gate refuses first, this covers every other way in.
      if (member?.clusterId === clusterId && member.hiddenAt) return fail('HIDDEN', HIDDEN_TOOL_TEXT);
      if (member?.clusterId === clusterId) return member.id;
    }
    return fail('OUT_OF_SCOPE', 'unknown member in this cluster; act from a conversation that is a member of this cluster');
  }

  member(clusterId: string, memberId: unknown): StoredMember {
    const member = typeof memberId === 'string' ? this.store.getMember(memberId) : null;
    if (!member || member.clusterId !== clusterId) return fail('OUT_OF_SCOPE', 'unknown member in this cluster; list_agents shows each memberId and name');
    return member;
  }

  private task(clusterId: string, taskId: unknown): Task {
    if (!this.store.tasks) return fail('INVALID_REQUEST', 'tasks are not available: the tasks plugin is disabled');
    const task = typeof taskId === 'string' ? this.store.tasks.task(clusterId, taskId) : null;
    if (!task) return fail('OUT_OF_SCOPE', 'unknown task in this cluster; list_tasks shows task IDs');
    return task;
  }

  roleIds(clusterId: string, value: unknown, field: string): string[] {
    const ids = strings(value, field);
    const roles = new Set(this.store.collaborationRoles(clusterId).map((r) => r.id));
    if (ids.some((id) => !roles.has(id))) return fail('OUT_OF_SCOPE', 'unknown role in this cluster; list_tasks with include: ["roles"] shows role IDs');
    return ids;
  }

  /**
   * A full ID or a unique prefix in this cluster, as the full ID; non-strings are left to the caller's own checks.
   * `listing` names where the caller can read full IDs.
   */
  resolveId<T>(table: string, clusterId: string, ref: T, unknown: string, listing = 'read_messages with history: true'): T {
    if (typeof ref !== 'string') return ref;
    const matches = this.store.idsMatching(table, clusterId, ref, MIN_ID_PREFIX);
    if (matches.includes(ref)) return ref;
    if (matches.length === 1) return matches[0] as T;
    return fail('OUT_OF_SCOPE', `${unknown}: a full ID is needed; prefix ${ref} matched ${matches.length} items (a prefix needs at least ${MIN_ID_PREFIX} characters; ${listing} shows full IDs)`);
  }

  /** A member ID, or a name unique among the cluster's active members, as the member ID; anything else is left to member(). */
  memberRef<T>(clusterId: string, ref: T): T {
    if (typeof ref !== 'string' || this.store.getMember(ref)?.clusterId === clusterId) return ref;
    const named = this.store.listMembers(clusterId).filter((m) => m.name === ref);
    if (named.length > 1) {
      return fail('OUT_OF_SCOPE', `member name ${ref} matches ${named.length} members: ${named.map((m) => `${m.id} (${m.harness})`).join(', ')}; use one of these memberIds`);
    }
    return (named[0]?.id ?? ref) as T;
  }

  /** Every later check, the event and any suggestion see full IDs, whichever form the caller used. */
  private resolveRefs(clusterId: string, command: CollaborationCommand): CollaborationCommand {
    // Full source message IDs can bypass the public-prefix resolver in independently installed plugins.
    if (Array.isArray(command.sourceMessageIds)
      && command.sourceMessageIds.some((id) => typeof id === 'string' && this.store.getMessage(id)?.privateTo !== undefined)) {
      return fail('OUT_OF_SCOPE', 'unknown source message; use full message IDs from read_messages');
    }
    const refs = this.store.plugins.refs(command.action);
    if (refs) return sync(refs({ store: this.store, clusterId, command, collaboration: this }), `refs for ${command.action}`);
    if (command.messageId && this.store.plugins.action(command.action)) {
      return { ...command, messageId: this.resolveId('messages', clusterId, command.messageId, 'unknown message') };
    }
    return command;
  }

  private manage(actor: CollaborationActor, actorId: string, clusterId: string, cmd: CollaborationCommand,
    permission: CoordinatorPermission, ordinaryAllowed = false): 'execute' | 'suggest' {
    if (actor.kind === 'user') return 'execute';
    const policy = this.store.coordinator?.policy(clusterId);
    if (policy?.enabled && policy.memberId === actorId) {
      if (cmd.generation !== policy.generation) return fail('STALE_POLICY', `coordinator policy changed (current generation ${policy.generation})`);
      if (!policy.permissions[permission]) return fail('FORBIDDEN', `coordinator permission is disabled; ask the user to enable ${permission} or to do this themselves`);
      return policy.mode;
    }
    if (ordinaryAllowed) return 'execute';
    return fail('FORBIDDEN', 'this action is not permitted; ask the user or the enabled coordinator to do it');
  }

  query(actor: CollaborationActor, clusterId: string, query: CollaborationQuery): CollaborationQueryResult {
    this.actor(actor, clusterId);
    if (!query || typeof query !== 'object') return fail('INVALID_REQUEST', 'query is required');
    const limit = Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 100) : 50;
    const pluginQuery = this.store.plugins.query(query.kind);
    if (pluginQuery) return sync(pluginQuery({ store: this.store, actor, clusterId, query, limit, task: (taskId) => this.task(clusterId, taskId), collaboration: this }), `query ${query.kind}`);
    return fail('INVALID_REQUEST', 'unknown collaboration query');
  }

  /**
   * command(), after the action's plugin `prepare` step when it has one: bounded reads outside the database, run before
   * the transaction opens (docs/plugins.md). A retry of a recorded operation skips it and replays as usual; a prepare
   * that throws or does not answer within prepareTimeoutMs (its signal aborts then) prepares nothing, or fails the
   * command with PREPARE_FAILED when the plugin lists the action in prepareRequired. The action re-checks whatever was
   * prepared, which was read before an await.
   */
  async commandAsync(actor: CollaborationActor, clusterId: string, command: CollaborationCommand): Promise<CollaborationResult> {
    const prepare = typeof command?.action === 'string' ? this.store.plugins.prepare(command.action) : undefined;
    // A request command() refuses on its shape alone never gets the prepare step: command() refuses it right away.
    if (!prepare || typeof command.operationId !== 'string' || !command.operationId.trim() || command.operationId.length > 200) {
      return this.command(actor, clusterId, command);
    }
    const actorId = this.actor(actor, clusterId);
    let prepared: unknown;
    if (!this.store.collaborationOperation(clusterId, actorId, command.operationId)) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_ok, fail) => {
        timer = setTimeout(() => fail(new Error(`no answer within ${this.prepareTimeoutMs} ms`)), this.prepareTimeoutMs);
      });
      try {
        prepared = await Promise.race([prepare({ store: this.store, actor, actorId, clusterId, command, signal: controller.signal }), late]);
      } catch (e) {
        controller.abort();
        if (this.store.plugins.prepareRequired(command.action)) {
          return fail('PREPARE_FAILED', `${command.action} could not read what it needs before running (${e instanceof Error ? e.message : String(e)}); nothing was changed, try again`);
        }
        prepared = undefined;
      } finally { clearTimeout(timer); }
    }
    return this.execute(actor, clusterId, command, prepared);
  }

  /**
   * A command without the prepare step: every caller that is not commandAsync. An action whose plugin lists it in
   * prepareRequired is refused here (PREPARE_REQUIRED) unless it is the replay of an operation already recorded, so no
   * entry point can run it without what it depends on.
   */
  command(actor: CollaborationActor, clusterId: string, command: CollaborationCommand): CollaborationResult {
    return this.execute(actor, clusterId, command, NOT_PREPARED);
  }

  private execute(actor: CollaborationActor, clusterId: string, command: CollaborationCommand, prepared: unknown): CollaborationResult {
    const actorId = this.actor(actor, clusterId);
    if (!command || typeof command.operationId !== 'string' || !command.operationId.trim() || command.operationId.length > 200) {
      return fail('INVALID_REQUEST', 'operationId is required');
    }
    const request = canonical(command);
    let event: HubEvent | undefined;
    const afterCommit: (() => void)[] = [];
    const result = this.store.transaction(() => {
      if (actor.kind === 'member' && command.generation !== undefined
        && (MANAGEMENT_ACTIONS.has(command.action) || this.store.plugins.isManagementAction(command.action))) {
        // The generation lives on the policy snapshot even after the coordinator is cleared; report that number.
        const view = this.store.coordinator;
        const policy = view?.policy(clusterId);
        if (!policy?.enabled || policy.memberId !== actorId || policy.generation !== command.generation) {
          const note = policy ? '' : '; coordinator is not enabled';
          return fail('STALE_POLICY', `coordinator policy changed (current generation ${view?.generation(clusterId) ?? 0}${note})`);
        }
      }
      const previous = this.store.collaborationOperation(clusterId, actorId, command.operationId);
      if (previous) {
        if (previous.request !== request) return fail('OPERATION_CONFLICT', 'operationId was already used for a different command');
        return JSON.parse(previous.result) as CollaborationResult;
      }
      if (prepared === NOT_PREPARED && typeof command.action === 'string' && this.store.plugins.prepareRequired(command.action)) {
        return fail('PREPARE_REQUIRED', `${command.action} needs its prepare step; send it through commandAsync (the MCP tools and the web API do)`);
      }
      // After the retry check: a retry is compared with what was sent, and it replays even if a prefix has since become ambiguous.
      command = this.resolveRefs(clusterId, command);
      const now = new Date().toISOString();
      const out: CollaborationResult = { action: command.action, eventId: 0 };
      const outcome: PluginActionOutcome = {};
      let suggest = false;
      const management = (permission: CoordinatorPermission, ordinaryAllowed = false) => {
        if (this.manage(actor, actorId, clusterId, command, permission, ordinaryAllowed) === 'suggest') suggest = true;
      };
      const action = command.action;
      if (command.sourceEventId !== undefined && (!Number.isSafeInteger(command.sourceEventId)
        || !this.store.eventInCluster(clusterId, command.sourceEventId))) return fail('OUT_OF_SCOPE', 'unknown source event; use an event seq from get_task, or omit sourceEventId');
      if (action === 'role.ensure_defaults') {
        management('roleManagement');
        if (!suggest) ensureDefaultRoles(this.store, clusterId);
      } else if (action === 'role.create') {
        management('roleManagement');
        const role: Role = { id: randomUUID(), clusterId, name: required(command.name, 'name', 100),
          description: command.description === undefined ? '' : roleDescription(command.description) };
        if (this.store.collaborationRoles(clusterId).some((r) => r.name === role.name)) return fail('INVALID_REQUEST', 'role name is already in use; choose another name or edit the existing role');
        if (!suggest) this.store.saveCollaborationRole(role);
        out.role = role;
      } else if (action === 'role.edit') {
        management('roleManagement');
        const role = this.store.collaborationRoles(clusterId).find((r) => r.id === command.roleId);
        if (!role) return fail('OUT_OF_SCOPE', 'unknown role; list_tasks with include: ["roles"] shows role IDs');
        if (command.description === undefined) return fail('INVALID_REQUEST', 'no editable fields were provided');
        // The name stays fixed: tasks and members refer to the role by ID, and renaming is not a user request.
        role.description = roleDescription(command.description);
        if (!suggest) this.store.setCollaborationRoleDescription(role.id, role.description);
        out.role = role;
      } else if (action === 'role.delete') {
        management('roleManagement');
        const role = this.store.collaborationRoles(clusterId).find((r) => r.id === command.roleId);
        if (!role) return fail('OUT_OF_SCOPE', 'unknown role; list_tasks with include: ["roles"] shows role IDs');
        // Disabling Tasks keeps its group settings. Protect those references while the view is inactive too.
        const savedTasks = this.store.tasks ?? this.store.plugins.installed.find((plugin) => plugin.taskView)?.taskView?.(this.store);
        if (savedTasks?.groupPermissionsUseRole?.(clusterId, role.id)) {
          return fail('ROLE_IN_USE', 'role is required by group Task permissions. Remove it from Task permissions first.');
        }
        if (this.store.tasks?.all(clusterId).some((t) => t.executeRoleIds.includes(role.id) || t.reviewRoleIds.includes(role.id))) {
          return fail('ROLE_IN_USE', 'role is required by a task; remove the role from those tasks first (executeRoleIds, reviewRoleIds)');
        }
        if (!suggest) this.store.deleteCollaborationRole(role.id);
        out.role = role;
      } else if (action === 'member.roles') {
        management('roleManagement');
        const member = this.member(clusterId, command.memberId); const ids = this.roleIds(clusterId, command.roleIds, 'roleIds');
        if (!suggest) this.store.setCollaborationMemberRoles(member.id, ids);
      } else if (action === 'cluster.pause') {
        management('deliveryControl');
        if (typeof command.paused !== 'boolean') return fail('INVALID_REQUEST', 'paused must be boolean');
        const previous = this.store.clusterPause(clusterId);
        if (actor.kind === 'member' && previous.paused && previous.pausedBy === 'user' && !command.paused) {
          return fail('FORBIDDEN', 'only the user can resume a user-paused cluster; ask the user to resume it');
        }
        const pausedBy = command.paused ? (previous.pausedBy === 'user' ? 'user' : actorId) : null;
        if (!suggest) this.store.setClusterPaused(clusterId, command.paused, pausedBy);
        out.paused = command.paused;
      } else if (action === 'member.hidden') {
        // Only the user and the enabled coordinator with deliveryControl; nobody hides itself (docs/cluster-members.md「隐身」).
        management('deliveryControl');
        if (typeof command.hidden !== 'boolean') return fail('INVALID_REQUEST', 'hidden must be boolean');
        const member = this.member(clusterId, this.memberRef(clusterId, command.memberId));
        if (member.id === actorId) return fail('FORBIDDEN', 'you cannot hide or show yourself');
        const policy = this.store.coordinator?.policy(clusterId);
        if (command.hidden && policy?.enabled && policy.memberId === member.id) return fail('FORBIDDEN', 'the coordinator cannot be hidden; change or disable the coordinator first');
        if (!suggest) {
          const recorded: HubEvent[] = [];
          const applied = this.hub.applyHidden(member.id, command.hidden, (event) => recorded.push(event));
          afterCommit.push(() => { try { for (const e of recorded) this.notify(e); } finally { applied.after(); } });
        }
        out.hidden = command.hidden;
      } else {
        const pluginAction = this.store.plugins.action(action);
        if (!pluginAction) return fail('INVALID_REQUEST', 'unsupported collaboration action');
        Object.assign(out, sync(pluginAction({ store: this.store, actor, actorId, clusterId, command, now, collaboration: this, hub: this.hub,
          management: (permission, ordinaryAllowed) => { management(permission, ordinaryAllowed); return suggest; },
          outcome,
          notice: (source, notice) => { const publish = this.notification(actor, clusterId, source, notice); if (publish) afterCommit.push(publish); },
          deliveriesChanged: (events) => { if (events.length) afterCommit.push(() => this.deliveriesChanged(events)); },
          afterCommit: (publish) => afterCommit.push(publish), prepared: prepared === NOT_PREPARED ? undefined : prepared }), `action ${action}`));
      }

      if (suggest) {
        out.suggestion = command; delete out.role;
      }
      const payload = outcome.payload?.(suggest) ?? { action, ...(out.messageId ? { messageId: out.messageId } : {}),
        ...(out.role ? { roleId: out.role.id } : {}), ...(command.memberId ? { memberId: command.memberId } : {}),
        ...(command.reason ? { reason: command.reason } : {}), ...(command.paused !== undefined ? { paused: command.paused } : {}),
        ...(command.hidden !== undefined ? { hidden: command.hidden } : {}),
        ...(command.mode !== undefined ? { mode: command.mode, enabled: command.enabled } : {}),
        ...(command.instructionId !== undefined ? { instructionId: command.instructionId } : {}),
        ...(command.instructionText !== undefined ? { instructionText: command.instructionText } : {}),
        ...(command.sourceEventId !== undefined ? { sourceEventId: command.sourceEventId } : {}),
        ...(suggest ? { suggested: true } : {}) };
      event = this.store.appendCollaborationEvent(clusterId, actor.kind === 'member' ? actor.memberId : null, payload);
      out.eventId = event.seq;
      outcome.afterEvent?.(event);
      this.store.saveCollaborationOperation(clusterId, actorId, command.operationId, request, JSON.stringify(out));
      return out;
    });
    try {
      if (event) this.notify(event);
    } finally {
      let firstError: unknown;
      for (const publish of afterCommit) {
        try { publish(); } catch (error) { firstError ??= error; }
      }
      if (firstError) throw firstError;
    }
    return result;
  }
}
