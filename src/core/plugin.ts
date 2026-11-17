// Official plugins: in-process modules that share the core's database and transactions (docs/plugins.md).
// Core never imports a concrete plugin; the composition root builds a PluginHost from the registry and gives it to the Store.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Collaboration, CollaborationNotice } from './collaboration.ts';
import type { CollaborationActor, CollaborationCommand, CollaborationQuery, CollaborationQueryResult, CollaborationResult, CoordinatorPermission, CoordinatorPolicy, Task } from './collaboration-types.ts';
import type { Hub, Limits } from './hub.ts';
import type { Store, StoredMember } from './store.ts';
import type { HubEvent, Member, Message } from './types.ts';

/** What a plugin says about itself: plain JSON, so a third-party plugin's manifest file can share this shape later. */
export interface PluginManifest {
  id: string;
  version: string;
  /** Plugins that must be enabled for this one to be enabled, and be registered before it. */
  requires?: string[];
  /** The settings page's display name, in Chinese. Absent: the id. */
  name?: string;
  /** One line for the settings page, in Chinese. */
  description?: string;
  /** The settings page's longer text, opened from the plugin's card: plain text or the chat's Markdown subset. */
  details?: string;
}

/** What an action asks of the core beyond its result fields (docs/plugins.md, "动作合同"). Both optional. */
export interface PluginActionOutcome {
  /** The whole event payload, instead of the core's generic one. Called once the action is done. */
  payload?: (suggested: boolean) => Record<string, unknown>;
  /** Runs in the same transaction right after the event is written: notices and anything that names the event. */
  afterEvent?: (event: HubEvent) => void;
}

export interface PluginActionContext {
  store: Store;
  actor: CollaborationActor;
  actorId: string;
  clusterId: string;
  /** With its references already resolved to full IDs (the action's `refs` slot, else just `messageId`). */
  command: CollaborationCommand;
  /** The time this command is stamped with. */
  now: string;
  collaboration: Collaboration;
  hub: Hub;
  /** The core's coordinator permission check. true: suggest mode so far, so the action must not write. */
  management(permission: CoordinatorPermission, ordinaryAllowed?: boolean): boolean;
  /** The action fills this in. */
  outcome: PluginActionOutcome;
  /** Writes a system message in this transaction; it is published and scheduled after the commit. */
  notice(event: HubEvent, notice: CollaborationNotice): void;
  /** Publishes delivery changes after the commit (a superseded notice, say). */
  deliveriesChanged(events: HubEvent[]): void;
  /** Runs once the transaction has committed, in the order added, alongside notices. */
  afterCommit(publish: () => void): void;
}
/** Runs inside the command's transaction, after its idempotency check. Returns extra fields for the command's result. */
export type PluginAction = (ctx: PluginActionContext) => Partial<CollaborationResult> & Record<string, unknown>;

/** Resolves a command's references before anything else looks at them. */
export interface PluginRefContext {
  store: Store;
  clusterId: string;
  command: CollaborationCommand;
  collaboration: Collaboration;
}

export interface PluginQueryContext {
  store: Store;
  actor: CollaborationActor;
  clusterId: string;
  query: CollaborationQuery;
  /** The query's page size after the core's bounds. */
  limit: number;
  /** The cluster's task, or the core's OUT_OF_SCOPE error; a clear error when no task plugin is enabled. */
  task(taskId: unknown): Task;
  collaboration: Collaboration;
}
export type PluginQuery = (ctx: PluginQueryContext) => CollaborationQueryResult;

/** MCP tool registration. Schemas are zod shapes; core may not import zod, so they are opaque here. */
export interface PluginToolApi {
  /** The shared { limit, cursor } schema fields. */
  page: Record<string, unknown>;
  hub: Hub;
  /** The bridge secret and this Hub's address, for tools that hand out a signed command. */
  secret: string;
  hubUrl: string;
  query(name: string, description: string, kind: string, schema: Record<string, unknown>,
    prepare?: (params: Record<string, unknown>) => Record<string, unknown>,
    project?: (result: never, params: Record<string, unknown>, me: { id: string; clusterId: string; mode: 'native' }) => unknown): void;
  command(name: string, description: string, schema: Record<string, unknown>,
    action: string | ((args: Record<string, unknown>) => string),
    extend?: (result: CollaborationResult, me: { id: string; clusterId: string }) => unknown): void;
}

export interface PluginRoute {
  method: string;
  pattern: RegExp;
  /** Returns the JSON body of a 200 answer; a thrown error becomes the web API's usual 400. `body` is the request's
   *  JSON object for any method but GET (the web API's usual size and shape checks), undefined for GET. */
  handle(ctx: { hub: Hub; params: string[]; url: URL; body?: unknown }): unknown;
}

/** A /bridge/* route. It runs before the bridge-secret check, so it must authenticate the request itself. */
export interface PluginBridgeRoute {
  method: string;
  pattern: RegExp;
  handle(ctx: { hub: Hub; secret: string; params: string[]; req: IncomingMessage; res: ServerResponse }): Promise<void>;
}

/**
 * One task of a member's work, with the records a handover package reads (docs/cluster-members.md「交接包」):
 * the newest submission's commit and summary, the newest review, and the unresolved attention questions.
 */
export interface MemberTaskFacts {
  task: Task;
  /** How this member is attached to the task: its executor now, the reviewer a task in review waits for, or a former
   *  executor known only from the assignment records. */
  role: 'executor' | 'reviewer' | 'former';
  /** The commit of the task's newest submission; the Hub keeps no branch field. */
  commitSha: string | null;
  /** `task.mergedCommitSha`: the merge commit, once a ship has merged the result. */
  mergedCommitSha: string | null;
  /** The newest submission's summary, verbatim. */
  summary: string | null;
  /** The member name whose assignment submitted the newest submission; null when there is no submission. */
  submissionBy: string | null;
  /** The newest review of the task, or null when it has none yet. */
  review: { verdict: 'approve' | 'reject'; self: boolean; reviewer: string; at: string; reason: string } | null;
  /** Unresolved attention questions, oldest first. */
  questions: string[];
}

/**
 * Task facts the core reads when a plugin provides them; Store.tasks is null otherwise and the core drops the task
 * parts of what it does. `linkMessage` is the one write: the core posts messages, so it links them too.
 */
export interface TaskView {
  /** Every task of the cluster, in any state. */
  all(clusterId: string): Task[];
  task(clusterId: string, taskId: string): Task | null;
  resolveRef?(clusterId: string, ref: string): string;
  /** The questions of a task's unresolved attention items. */
  unresolvedQuestions(taskId: string): string[];
  /** The member's tasks in this cluster (its own work now or before, a task in review waiting for it), unfinished
   *  first then newest; `omitted` counts the tasks beyond `limit`. */
  memberTasks(clusterId: string, memberId: string, limit: number): { facts: MemberTaskFacts[]; omitted: number };
  /** Active tasks of the cluster with only what list_agents' load needs. */
  activeLoads(clusterId: string): { status: string; assignedMemberId: string | null; reviewerMemberId: string | null }[];
  /** The task IDs linked to a message. */
  links(messageId: string): string[];
  linkMessage(messageId: string, taskId: string, linkedBy: string): void;
  /** A condition on a message row (alias m): linked to this task. */
  linkedClause(taskId: string): { sql: string; args: string[] };
  /** The one notice for a member shown again (docs/cluster-members.md「隐身」): what it holds now; null when nothing. */
  heldBrief?(clusterId: string, memberId: string, hiddenSince: string | null): { body: string; taskIds: string[] } | null;
}

/**
 * What the core and the tasks plugin read about a cluster's coordinator when a plugin provides one; Store.coordinator
 * is null otherwise, and every reader treats that as "this cluster has no coordinator".
 */
export interface CoordinatorView {
  /** The stored policy, enabled or not; null when there is none. */
  policy(clusterId: string): CoordinatorPolicy | null;
  /** The current generation; it survives clearing the coordinator. 0 when none was ever set. */
  generation(clusterId: string): number;
  rules: { version: string; text: string };
  /** The member a message nobody was named in goes to; null: it stays in the chat record. */
  unaddressedRecipient(message: { clusterId: string; from: string; body: string; members: { id: string }[] }): string | null;
  /** Appended to the envelope's note for this member. */
  envelopeHint(member: StoredMember): string;
  /** After the body of an unaddressed message, for the member it was routed to. */
  envelopeNote(message: Message): string;
  /** The member's per-hour turn limit. */
  turnLimit(member: StoredMember, limits: Limits): number;
  /** A member was moved to another conversation: who else to tell, and what the moved member should know. */
  rebound(member: StoredMember, hubPaused: boolean): { alsoTell: string | null; lines: string[]; taskIds: string[] };
  /** Disable an enabled coordinator whose member is removed or missing (once, on removal or at Hub startup). */
  disableIfRemoved?(hub: Hub, clusterId: string, emit: { event: (e: HubEvent) => void; afterCommit: (fn: () => void) => void },
    targetMemberId?: string): void;
}

/** One message of a delivery envelope, with what a plugin adds around the core's lines. */
export interface EnvelopeItem {
  message: Message;
  /** Appended to the [orrery] header line. */
  header?: string;
  /** Between the header line and the body. */
  lead?: string;
  /** Straight after the body. */
  afterBody?: string;
  /** Last, after the attachments and the core's notes. */
  tail?: string;
}

/** A plugin's background side, one instance per Hub. Every method is optional and must not throw out of a timer. */
export interface PluginService {
  /** Hub.start: re-arm what survives a restart. */
  start?(): void;
  close?(): void;
  /** Every Limits.idleSweepMs. */
  sweep?(): void;
  /** A collaboration event, after it committed and was broadcast. */
  onEvent?(event: HubEvent): void;
  onMemberStatus?(member: Member, before: Member['status'] | undefined): void;
  /** A harness's quota snapshot changed, or one of its windows reset. */
  onQuotaChanged?(): void;
  /** A cluster was deleted for good (after the commit): forget what is kept in memory for it and these members. */
  onClusterPurged?(clusterId: string, memberIds: string[]): void;
}

export interface OfficialPlugin extends PluginManifest {
  /** Repo-owned browser entry in web/public/official-plugins/, named after this plugin. */
  webModule?: string;
  /** Repo-owned icon in web/public/official-plugins/, named `<id>.svg`. A third-party plugin's icon is `iconPath`. */
  icon?: string;
  /** SQL, oldest first; a plugin's schema version is how many have run. Run for every registered plugin, even a disabled one. */
  migrations?: string[];
  actions?: Record<string, PluginAction>;
  queries?: Record<string, PluginQuery>;
  tools?(api: PluginToolApi): void;
  routes?: PluginRoute[];
  /** Extra top-level fields of a message's JSON: field name → its value for this message. */
  messageFields?: Record<string, (store: Store, messageId: string) => unknown>;
  /** Actions that take the coordinator generation pre-check: a stale generation must not fall back to the ordinary path. */
  managementActions?: string[];
  /** Action → how to resolve its references. Without an entry the core resolves only `messageId`. */
  refs?: Record<string, (ctx: PluginRefContext) => CollaborationCommand>;
  bridgeRoutes?: PluginBridgeRoute[];
  /** The read side of the plugin that owns tasks (TaskView). One provider at most. */
  taskView?: (store: Store) => TaskView;
  /** The coordinator's read side (CoordinatorView). One provider at most. */
  coordinatorView?: (store: Store) => CoordinatorView;
  /** Lays a delivery batch out as sections of items, in order. One provider at most; default: each message on its own. */
  envelope?: (store: Store, messages: Message[], nameOf: (id: string) => string) => EnvelopeItem[][];
  service?: (hub: Hub) => PluginService;
  /** Before a member moves to another conversation, in its transaction. Throw to refuse the move. */
  memberRebinding?: (store: Store, member: StoredMember, target: { harness: string; workerSessionId: string }) => void;
  /** After the move, in the same transaction. */
  memberRebound?: (store: Store, clusterId: string, memberId: string, oldKey: string, newKey: string) => void;
  /** A member was removed from its cluster, in the same transaction. Called for every installed plugin, as clusterPurging. */
  memberRemoved?: (store: Store, clusterId: string, memberId: string) => void;
  /** A new cluster was inserted, in the same transaction. */
  clusterCreated?: (store: Store, clusterId: string) => void;
  /**
   * A cluster in the recycle bin is being deleted for good, in the purge transaction, before any core row goes (its
   * messages and members still exist). Delete every row of this plugin's tables tied to the cluster, its members, its
   * messages or its files. Called for every installed plugin, enabled or not: its tables exist either way.
   */
  clusterPurging?: (store: Store, clusterId: string) => void;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** Validates the registry against the disabled list and answers what the enabled plugins provide. */
export class PluginHost {
  readonly installed: readonly OfficialPlugin[];
  readonly enabled: readonly OfficialPlugin[];
  readonly routes: readonly PluginRoute[];
  readonly bridgeRoutes: readonly PluginBridgeRoute[];
  readonly taskView: OfficialPlugin['taskView'];
  readonly coordinatorView: OfficialPlugin['coordinatorView'];
  readonly envelope: OfficialPlugin['envelope'];
  private readonly management = new Set<string>();
  private readonly refsOf = new Map<string, NonNullable<OfficialPlugin['refs']>[string]>();
  private readonly actions = new Map<string, PluginAction>();
  private readonly queries = new Map<string, PluginQuery>();
  private readonly fields = new Map<string, (store: Store, messageId: string) => unknown>();

  constructor(installed: readonly OfficialPlugin[] = [], disabled: readonly string[] = []) {
    const known = new Set<string>();
    for (const plugin of installed) {
      if (!ID_RE.test(plugin.id)) throw new Error(`invalid plugin id ${JSON.stringify(plugin.id)}`);
      if (plugin.webModule !== undefined && plugin.webModule !== plugin.id) throw new Error(`invalid web module for plugin ${plugin.id}`);
      if (plugin.icon !== undefined && plugin.icon !== `${plugin.id}.svg`) throw new Error(`invalid icon for plugin ${plugin.id}`);
      if (known.has(plugin.id)) throw new Error(`plugin ${plugin.id} is registered twice`);
      for (const dep of plugin.requires ?? []) {
        if (!known.has(dep)) throw new Error(`plugin ${plugin.id} requires ${dep}, which must be registered before it`);
      }
      known.add(plugin.id);
    }
    for (const id of disabled) {
      if (!known.has(id)) throw new Error(`cannot disable unknown plugin ${id}; registered plugins: ${[...known].join(', ') || 'none'}`);
    }
    this.installed = installed;
    this.enabled = installed.filter((plugin) => !disabled.includes(plugin.id));
    const on = new Set(this.enabled.map((plugin) => plugin.id));
    for (const plugin of this.enabled) {
      const missing = (plugin.requires ?? []).filter((dep) => !on.has(dep));
      if (missing.length) throw new Error(`plugin ${plugin.id} cannot be enabled: it requires ${missing.join(', ')}, which is disabled; enable it or also disable ${plugin.id}`);
    }
    this.routes = this.enabled.flatMap((plugin) => plugin.routes ?? []);
    this.bridgeRoutes = this.enabled.flatMap((plugin) => plugin.bridgeRoutes ?? []);
    const single = <K extends 'taskView' | 'coordinatorView' | 'envelope'>(slot: K): OfficialPlugin[K] => {
      const owners = this.enabled.filter((plugin) => plugin[slot]);
      if (owners.length > 1) throw new Error(`plugins ${owners.map((plugin) => plugin.id).join(', ')} all register ${slot}; only one may`);
      return owners[0]?.[slot];
    };
    this.taskView = single('taskView');
    this.coordinatorView = single('coordinatorView');
    this.envelope = single('envelope');
    const claim = <T>(map: Map<string, T>, slot: string, plugin: OfficialPlugin, entries: Record<string, T> | undefined) => {
      for (const [name, value] of Object.entries(entries ?? {})) {
        if (map.has(name)) throw new Error(`plugin ${plugin.id} registers ${slot} ${name}, which is already taken`);
        map.set(name, value);
      }
    };
    for (const plugin of this.enabled) {
      claim(this.actions, 'action', plugin, plugin.actions);
      claim(this.queries, 'query', plugin, plugin.queries);
      claim(this.fields, 'message field', plugin, plugin.messageFields);
      claim(this.refsOf, 'refs for', plugin, plugin.refs);
      for (const action of plugin.managementActions ?? []) this.management.add(action);
    }
  }

  action(name: string): PluginAction | undefined { return this.actions.get(name); }
  query(kind: string): PluginQuery | undefined { return this.queries.get(kind); }
  refs(action: string) { return this.refsOf.get(action); }
  isManagementAction(action: string): boolean { return this.management.has(action); }

  /** Each step commits together with its version, so a failed step reruns on the next start. */
  migrate(store: Store): void {
    const read = store.db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?');
    const save = store.db.prepare('INSERT INTO plugin_migrations (plugin_id, version) VALUES (?, ?) ON CONFLICT(plugin_id) DO UPDATE SET version = excluded.version');
    for (const plugin of this.installed) {
      const steps = plugin.migrations ?? [];
      const current = Number(read.get(plugin.id)?.version ?? 0);
      if (current > steps.length) throw new Error(`plugin ${plugin.id}: unsupported database schema version ${current} (this Hub knows ${steps.length})`);
      for (let v = current; v < steps.length; v++) {
        store.transaction(() => { store.db.exec(steps[v]); save.run(plugin.id, v + 1); });
      }
    }
  }

  /** Field name → value for one message, in registration order. Nothing when no enabled plugin adds fields. */
  messageFields(store: Store, messageId: string): Record<string, unknown> {
    return Object.fromEntries([...this.fields].map(([name, read]) => [name, read(store, messageId)]));
  }

  /** The enabled plugins' fields of a message that already carries them (Store.withDeliveries). */
  pickMessageFields(message: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries([...this.fields.keys()].map((name) => [name, message[name]]));
  }
}
