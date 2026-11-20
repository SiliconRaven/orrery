// Official plugins: in-process modules that share the core's database and transactions (docs/plugins.md).
// Core never imports a concrete plugin; the composition root builds a PluginHost from the registry and gives it to the Store.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants as sqliteConstants } from 'node:sqlite';
import type { Collaboration, CollaborationNotice } from './collaboration.ts';
import type { EventSource, OwnedEventSource } from './event-registry.ts';
import type { CollaborationActor, CollaborationCommand, CollaborationQuery, CollaborationQueryResult, CollaborationResult, CoordinatorPermission, CoordinatorPolicy, Task } from './collaboration-types.ts';
import type { Hub, Limits } from './hub.ts';
import type { Store, StoredMember } from './store.ts';
import type { HubEvent, Member, Message } from './types.ts';

/** What a plugin says about itself: plain JSON, so a third-party plugin's manifest file can share this shape later. */
export interface PluginManifest {
  /** Repo-owned plugins can opt out of starting until the user enables them. Older manifests start by default. */
  defaultEnabled?: boolean;
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
  /**
   * What the action's `prepare` step read before the transaction (Collaboration.commandAsync), or undefined when it did
   * not run. It was read before an await: the action re-checks it against what it reads now before relying on it.
   */
  prepared?: unknown;
}
/**
 * Bounded reads an action needs from outside the database (git, say), run before its transaction so a slow process
 * cannot hold the transaction. The command is not yet resolved or checked. A throw, or no answer within the core's time
 * limit (Collaboration.prepareTimeoutMs; `signal` aborts then), means nothing was prepared, unless the plugin lists the
 * action in `prepareRequired`: then the command fails with PREPARE_FAILED.
 */
export type PluginPrepare = (ctx: { store: Store; actor: CollaborationActor; actorId: string; clusterId: string; command: CollaborationCommand;
  signal: AbortSignal }) => Promise<unknown>;
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
    project?: (result: never, params: Record<string, unknown>, me: { id: string; clusterId: string }) => unknown): void;
  command(name: string, description: string, schema: Record<string, unknown>,
    action: string | ((args: Record<string, unknown>) => string),
    extend?: (result: CollaborationResult, me: { id: string; clusterId: string }) => unknown): void;
}

export interface PluginRoute {
  method: string;
  pattern: RegExp;
  /** Do not cache this route's responses, for example when they carry a native transcript. */
  noStore?: true;
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
  /** Whether saved group task permissions still reference a role. Also consulted while Tasks is disabled. */
  groupPermissionsUseRole?(clusterId: string, roleId: string): boolean;
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
  /** Action → its read step before the transaction, for callers that use Collaboration.commandAsync (the MCP tools). */
  prepare?: Record<string, PluginPrepare>;
  /** Actions that depend on their prepare result: a prepare that throws or runs out of time fails the command. */
  prepareRequired?: string[];
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
  /**
   * The event types this plugin declares for third-party plugins (docs/plugins.md「事件」): names, descriptions and the
   * builders that copy whitelisted fields. They exist only while the plugin is enabled. Not `events`: a third-party
   * manifest registered here has an `events` list of its own.
   */
  eventSource?: (store: Store) => EventSource;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;

/** A plugin failure's text for the settings card and the log: its first line, at most 300 characters. */
export function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] || 'unknown error').slice(0, 300);
}

/**
 * A plugin hook that runs inside a core transaction (memberRemoved, memberRebound, clusterCreated, clusterPurging)
 * threw: the whole operation rolls back, and the error names the plugin and the operation.
 */
export class PluginHookError extends Error {
  readonly code = 'PLUGIN_HOOK_FAILED';
  readonly pluginId: string;
  readonly operation: string;
  constructor(pluginId: string, operation: string, cause: unknown) {
    super(`plugin ${pluginId} failed in ${operation}: ${shortError(cause)}; nothing was changed`, { cause });
    this.pluginId = pluginId;
    this.operation = operation;
  }
}

/** Whether a plugin handed back a promise (or any thenable) where the host expects an answer now. */
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';

/**
 * A callback whose contract is synchronous handed back a thenable: its rejection is caught (never unhandled) and this
 * error is returned for the caller to throw. Nothing of what the promise does later is waited for or used.
 */
export function asyncRefused(value: PromiseLike<unknown>, what: string): Error {
  value.then(undefined, () => {});
  return new Error(`${what} returned a promise; it must answer synchronously`);
}

/**
 * Runs one plugin's transactional hook; a throw becomes a PluginHookError, which the caller's transaction rethrows. A
 * hook that returns a promise fails the same way: the transaction cannot wait for it.
 */
export function runHook(plugin: { id: string }, operation: string, run: () => unknown): void {
  let result: unknown;
  try { result = run(); } catch (e) { throw new PluginHookError(plugin.id, operation, e); }
  if (isThenable(result)) throw new PluginHookError(plugin.id, operation, asyncRefused(result, operation));
}

/** The prefix a full-trust plugin's tables, indexes, triggers and views carry: x_<id with - as _>_ */
export const tablePrefixOf = (id: string): string => `x_${id.replaceAll('-', '_')}_`;

type SchemaEntry = { type: string; name: string; table: string; sql: string };
/** The database's schema objects and user_version, keyed by type and name. SQLite's own bookkeeping tables are left out. */
function schemaOf(store: Store): Map<string, SchemaEntry> {
  const read = (table: string, tag: string) => store.db.prepare(`SELECT type, name, tbl_name AS tbl, sql FROM ${table} WHERE name NOT IN ('sqlite_sequence') AND name NOT LIKE 'sqlite_stat%'`).all()
    .map((r) => [`${tag}${r.type} ${r.name}`, { type: String(r.type), name: String(r.name), table: String(r.tbl), sql: String(r.sql ?? '') }] as const);
  // The temporary schema too: a TEMP trigger on a core table lives there.
  const map = new Map([...read('sqlite_schema', ''), ...read('sqlite_temp_schema', 'temp ')]);
  const version = String((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  map.set('pragma user_version', { type: 'pragma', name: 'user_version', table: '', sql: version });
  return map;
}

/**
 * The schema objects a migration step created, changed or dropped outside `prefix`: an object counts as the plugin's
 * own only when its name has the prefix (SQLite's automatic index: its table's name) and it belongs to a table with
 * the prefix, so an index or trigger on a core table is outside too. user_version is the core's. `others` are the longer
 * prefixes of other full-trust ids that start with this one (`x_a_b_` for `x_a_`): those names are theirs, not its.
 */
function structureOutside(before: Map<string, SchemaEntry>, after: Map<string, SchemaEntry>, prefix: string, others: readonly string[]): string[] {
  const mine = (name: string) => name.startsWith(prefix) && !others.some((other) => name.startsWith(other));
  const own = (e: SchemaEntry) => e.type !== 'pragma' && mine(e.table) && (mine(e.name) || e.name.startsWith('sqlite_autoindex_'));
  const changed: string[] = [];
  for (const [key, entry] of after) if (before.get(key)?.sql !== entry.sql && !own(entry)) changed.push(entry.name);
  for (const [key, entry] of before) if (!after.has(key) && !own(entry)) changed.push(entry.name);
  return changed;
}

class StructureError extends Error {
  readonly names: string[];
  constructor(names: string[]) { super(`changed schema objects outside the plugin's prefix: ${names.join(', ')}`); this.names = names; }
}

/** What PluginHost knows beyond the registry: which plugins are full-trust third-party ones (docs/external-plugins.md「完全信任的插件」). */
export interface PluginHostOptions {
  /** Persisted user opt-ins. The constructor's disabled list still takes priority. */
  explicitlyEnabled?: readonly string[];
  /** Ids of full-trust plugins: a migration of theirs is checked against their table prefix, and any failure skips them. */
  fullTrust?: Iterable<string>;
  /** A full-trust plugin (or one depending on it) left out after the registry was built: its migration, a backup. */
  onSkip?: (id: string, reason: string) => void;
  /** Every registered full-trust id, loaded or not: one whose table prefix extends another's keeps those names. */
  registeredTrusted?: Iterable<string>;
}

/** The Node version whose node:sqlite has DatabaseSync.setAuthorizer (the Node 24 docs: "Added in: v24.10.0"). */
const AUTHORIZER_NODE = 'v24.10.0';

/** What a full-trust migration step may not run: it would end or nest the transaction the check depends on, or reach outside it. */
const STEP_DENIED = new Set([sqliteConstants.SQLITE_TRANSACTION, sqliteConstants.SQLITE_SAVEPOINT, sqliteConstants.SQLITE_ATTACH,
  sqliteConstants.SQLITE_DETACH, sqliteConstants.SQLITE_PRAGMA]);

/** Forced and user disables share the first check. Only an explicit enable overrides a default of off. */
export function pluginEnabledBySettings(plugin: Pick<PluginManifest, 'id' | 'defaultEnabled'>,
  disabled: readonly string[], enabled: readonly string[]): boolean {
  return !disabled.includes(plugin.id) && (plugin.defaultEnabled !== false || enabled.includes(plugin.id));
}

/** Validates the registry against the disabled list and answers what the enabled plugins provide. */
export class PluginHost {
  // Rebuilt (build()) when a full-trust plugin is skipped while the Store opens; read-only for everyone else.
  installed!: readonly OfficialPlugin[];
  enabled!: readonly OfficialPlugin[];
  routes!: readonly PluginRoute[];
  bridgeRoutes!: readonly PluginBridgeRoute[];
  taskView: OfficialPlugin['taskView'];
  coordinatorView: OfficialPlugin['coordinatorView'];
  envelope: OfficialPlugin['envelope'];
  /** Full-trust plugins left out after the registry was built, with the reason. */
  readonly skipped = new Map<string, string>();
  private readonly management = new Set<string>();
  private readonly refsOf = new Map<string, NonNullable<OfficialPlugin['refs']>[string]>();
  private readonly actions = new Map<string, PluginAction>();
  private readonly prepares = new Map<string, PluginPrepare>();
  private readonly required = new Set<string>();
  private readonly queries = new Map<string, PluginQuery>();
  private readonly fields = new Map<string, (store: Store, messageId: string) => unknown>();
  private readonly registry: readonly OfficialPlugin[];
  private readonly disabled: readonly string[];
  private readonly explicitlyEnabled: readonly string[];
  private readonly fullTrust: ReadonlySet<string>;
  private readonly onSkip: (id: string, reason: string) => void;
  private readonly registeredTrusted: readonly string[];

  constructor(installed: readonly OfficialPlugin[] = [], disabled: readonly string[] = [], options: PluginHostOptions = {}) {
    this.registry = installed;
    this.disabled = disabled;
    this.explicitlyEnabled = options.explicitlyEnabled ?? [];
    this.fullTrust = new Set(options.fullTrust ?? []);
    this.onSkip = options.onSkip ?? (() => {});
    this.registeredTrusted = [...new Set([...(options.registeredTrusted ?? []), ...this.fullTrust])];
    this.build();
  }

  isFullTrust(id: string): boolean { return this.fullTrust.has(id); }

  /**
   * Leaves full-trust plugins out from now on, and every plugin that requires one of them, and rebuilds what the
   * enabled plugins provide. Only full-trust plugins can be left out: an official one's failure stops the start.
   */
  skip(ids: readonly string[], reason: string): void {
    const out = new Set(ids.filter((id) => this.fullTrust.has(id) && !this.skipped.has(id)));
    for (const id of out) { this.skipped.set(id, reason); this.onSkip(id, reason); }
    for (let changed = out.size > 0; changed;) {
      changed = false;
      for (const plugin of this.registry) {
        if (this.skipped.has(plugin.id) || !(plugin.requires ?? []).some((dep) => this.skipped.has(dep))) continue;
        const because = `它依赖的插件 ${(plugin.requires ?? []).filter((dep) => this.skipped.has(dep)).join('、')} 被跳过`;
        this.skipped.set(plugin.id, because);
        this.onSkip(plugin.id, because);
        changed = true;
      }
    }
    if (out.size) this.build();
  }

  private build(): void {
    const installed = this.registry.filter((plugin) => !this.skipped.has(plugin.id));
    const disabled = this.disabled.filter((id) => !this.skipped.has(id));
    for (const map of [this.management, this.refsOf, this.actions, this.prepares, this.required, this.queries, this.fields]) map.clear();
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
    this.enabled = installed.filter((plugin) => pluginEnabledBySettings(plugin, disabled, this.explicitlyEnabled));
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
      for (const name of Object.keys(plugin.prepare ?? {})) {
        if (plugin.actions?.[name] === undefined) throw new Error(`plugin ${plugin.id} registers prepare for ${name}, which is not its action`);
      }
      claim(this.prepares, 'prepare for', plugin, plugin.prepare);
      for (const name of plugin.prepareRequired ?? []) {
        if (plugin.prepare?.[name] === undefined) throw new Error(`plugin ${plugin.id} lists ${name} in prepareRequired without a prepare for it`);
        this.required.add(name);
      }
      claim(this.queries, 'query', plugin, plugin.queries);
      claim(this.fields, 'message field', plugin, plugin.messageFields);
      claim(this.refsOf, 'refs for', plugin, plugin.refs);
      for (const action of plugin.managementActions ?? []) this.management.add(action);
    }
  }

  action(name: string): PluginAction | undefined { return this.actions.get(name); }
  prepare(name: string): PluginPrepare | undefined { return this.prepares.get(name); }
  /** The action fails when its prepare throws or runs out of time (prepareRequired). */
  prepareRequired(name: string): boolean { return this.required.has(name); }
  query(kind: string): PluginQuery | undefined { return this.queries.get(kind); }
  refs(action: string) { return this.refsOf.get(action); }
  isManagementAction(action: string): boolean { return this.management.has(action); }

  /**
   * The enabled plugins' event declarations; a disabled plugin's types do not exist. A full-trust plugin whose
   * eventSource throws only loses its event types (`failed` hears why); an official one's throw stops the start.
   */
  eventSources(store: Store, failed: (id: string, error: unknown) => void = () => {}): OwnedEventSource[] {
    return this.enabled.flatMap((plugin) => {
      if (typeof plugin.eventSource !== 'function') return [];
      const make = () => {
        const source = plugin.eventSource!(store);
        if (isThenable(source)) throw asyncRefused(source, 'eventSource');
        return source;
      };
      if (!this.fullTrust.has(plugin.id)) return [{ owner: plugin.id, source: make() }];
      try { return [{ owner: plugin.id, source: make() }]; } catch (e) { failed(plugin.id, e); return []; }
    });
  }

  /** The installed plugins with migration steps not yet run on this database (before Store's core migration too). */
  pendingMigrations(store: Store): string[] {
    let versions: Map<string, number>;
    try {
      versions = new Map(store.db.prepare('SELECT plugin_id, version FROM plugin_migrations').all().map((r) => [String(r.plugin_id), Number(r.version)]));
    } catch { versions = new Map(); }   // an old database without the table: the core upgrade creates it
    return this.installed.filter((p) => (p.migrations?.length ?? 0) > (versions.get(p.id) ?? 0)).map((p) => p.id);
  }

  /**
   * Each step commits together with its version, so a failed step reruns on the next start. A failure says which
   * version the plugin reached; nothing is restored automatically. An official plugin's failure stops the start; a
   * full-trust plugin's skips it (and its dependents), and each of its steps may only create, change or drop schema
   * objects named with its table prefix on its own tables (structureOutside): anything else rolls the step back.
   */
  migrate(store: Store): void {
    const read = store.db.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?');
    const save = store.db.prepare('INSERT INTO plugin_migrations (plugin_id, version) VALUES (?, ?) ON CONFLICT(plugin_id) DO UPDATE SET version = excluded.version');
    for (const plugin of [...this.installed]) {
      if (this.skipped.has(plugin.id)) continue;   // left out on the way (a dependency's failed step)
      const trusted = this.fullTrust.has(plugin.id);
      const steps = plugin.migrations ?? [];
      const current = Number(read.get(plugin.id)?.version ?? 0);
      if (current > steps.length) {
        const reason = `plugin ${plugin.id}: unsupported database schema version ${current} (this Hub knows ${steps.length})`;
        if (trusted) { this.skip([plugin.id], `数据库里它的迁移版本是 ${current}，这个版本的插件只有 ${steps.length} 步（降级了？）`); continue; }
        throw new Error(reason);
      }
      // The step check needs DatabaseSync.setAuthorizer (Node 24.10.0+; the Hub itself runs on 24.2+): without it a
      // full-trust plugin with steps to run is skipped before any of them, and nothing else changes.
      if (trusted && current < steps.length && typeof store.db.setAuthorizer !== 'function') {
        this.skip([plugin.id], `迁移需要 Node ${AUTHORIZER_NODE} 或更新版本（node:sqlite 的 setAuthorizer），现在是 ${process.version}；没有运行任何一步`);
        continue;
      }
      const prefix = tablePrefixOf(plugin.id);
      const others = this.registeredTrusted.map(tablePrefixOf).filter((other) => other !== prefix && other.startsWith(prefix));
      for (let v = current; v < steps.length; v++) {
        try {
          store.transaction(() => {
            if (!trusted) { store.db.exec(steps[v]); save.run(plugin.id, v + 1); return; }
            // A full-trust step may not end the transaction (COMMIT, savepoints), attach a database or run a pragma: the
            // authorizer refuses those statements, so the comparison and the rollback below always cover the whole step.
            const before = schemaOf(store);
            store.db.setAuthorizer((action) => (STEP_DENIED.has(action) ? sqliteConstants.SQLITE_DENY : sqliteConstants.SQLITE_OK));
            try { store.db.exec(steps[v]); } finally { store.db.setAuthorizer(null); }
            const outside = structureOutside(before, schemaOf(store), prefix, others);
            if (outside.length) throw new StructureError(outside);
            save.run(plugin.id, v + 1);
          });
        } catch (e) {
          if (trusted) {
            this.skip([plugin.id], e instanceof StructureError
              ? `迁移第 ${v + 1} 步改动了 ${tablePrefixOf(plugin.id)} 前缀以外的结构（${e.names.join('、')}），已回滚，数据停在第 ${v} 步`
              : `迁移第 ${v + 1} 步失败，已回滚，数据停在第 ${v} 步（共 ${steps.length} 步）：${shortError(e)}`
                + (/not authorized/.test(shortError(e)) ? '（迁移步骤里不能提交或开始事务、用保存点、附加数据库或执行 PRAGMA）' : ''));
            break;
          }
          throw new Error(`plugin ${plugin.id}: migration step ${v + 1} failed and was rolled back; its data stays at version ${v} of ${steps.length}: ${shortError(e)}`
            + (store.upgradeBackup ? `; the backup made before the upgrade is ${store.upgradeBackup}` : '') + '; nothing was restored automatically', { cause: e });
        }
      }
    }
  }

  /**
   * Field name → value for one message, in registration order. Nothing when no enabled plugin adds fields. A field read
   * that hands back a promise gives null (the promise's rejection is caught): message lists are built synchronously.
   */
  messageFields(store: Store, messageId: string): Record<string, unknown> {
    return Object.fromEntries([...this.fields].map(([name, read]) => {
      const value = read(store, messageId);
      if (!isThenable(value)) return [name, value];
      asyncRefused(value, `message field ${name}`);
      return [name, null];
    }));
  }

  /** The enabled plugins' fields of a message that already carries them (Store.withDeliveries). */
  pickMessageFields(message: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries([...this.fields.keys()].map((name) => [name, message[name]]));
  }
}
