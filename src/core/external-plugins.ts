// The external host brokers only explicitly granted calls. Never pass Hub, Store, tokens or SQL over the wire.
import { randomBytes, randomUUID } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import { isAbsolute } from 'node:path';
import { coreEventSource, pluginMessageBody } from './core-events.ts';
import { EventRegistry, patternMatches, PLUGIN_NAMESPACE, type CatalogEntry, type MemberBaseline, type OwnedEventSource } from './event-registry.ts';
import { externalPluginSender, object, type ExternalInstallation, type ExternalPermission,
  type ExternalPluginFailure, type ExternalWriteSettings } from './external-plugin-config.ts';
import type { Hub, MemberToolCall, MemberToolDeclaration, MemberToolOutcome, MessageCheckOutcome, MessageCheckRequest, MessageCheckResult } from './hub.ts';
import { readPluginIcon, type PluginIcon } from './plugin-icon.ts';
import { COMMAND_LIMITS, CommandRefusal, CommandRuns, validateArguments, type CommandLimits, type RunView } from './external-plugin-commands.ts';
import { CheckTimeout, DEFAULT_SHUTDOWN_GRACE_MS, EXTERNAL_MAX_FRAME, ExternalPluginProcess, fitsPluginInitialize, HostRefusal, PluginAnswerError, PluginStopping,
  ToolTimeout, UiTimeout, type ExternalErrorCode, type ExternalEvent, type ExternalState, type SpawnPlugin } from './external-plugin-process.ts';
import { checkUiFolder, chipText, FRAME_POSITIONS, jsonBytes, MARK_STATES, MARK_TARGETS, readUiFile, UI_LIMITS, UiRefusal, uiSegments,
  type FramePosition, type MarkTarget, type UiListing, type UiPosition } from './external-plugin-ui.ts';
import { CallWindows, listedSchema, memberToolName, pluginErrorText, TOOL_LIMITS, ToolRefusal, toolAnswer, validateToolArguments,
  type ExternalTool } from './external-plugin-tools.ts';
import type { Store } from './store.ts';
import type { HubEvent, Message } from './types.ts';
import { configScopes, PluginPreferences, type ConfigNotice } from './external-plugin-preferences.ts';
import { PluginConfigProblem } from './external-plugin-values.ts';

/** Granted for this type and scope: events.read, a matching pattern, and for a cluster event that cluster in the whitelist. */
const eventGranted = (plugin: ExternalInstallation, type: string, clusterId: string | null) =>
  plugin.permissions.includes('events.read') && plugin.events.some((pattern) => patternMatches(pattern, type))
  && (clusterId === null || plugin.clusterIds.includes(clusterId));

/** What the plugin host needs of the Hub: plugin writes, records the user sees, and the members' live status. */
type HostHub = Pick<Hub, 'sendFromExternalPlugin' | 'externalPluginRateNotice' | 'externalPluginPublishLimit' | 'listMembers' | 'externalPluginRestartRecord'
  | 'externalPluginToolRecord'> & Partial<Pick<Hub, 'pluginFault'>>;

/** Granted ui.show and declared positions named in the grant: where its web UI may appear (in its read clusters). */
const grantedUi = (installation: ExternalInstallation): UiPosition[] => (installation.permissions.includes('ui.show') && installation.manifest.ui
  ? (installation.ui ?? []).filter((position) => installation.manifest.ui!.positions.includes(position)) : []);

/** Granted tools.provide and declared tools named in the grant: what members of its read clusters may be offered. */
const grantedTools = (installation: ExternalInstallation): ExternalTool[] => (installation.permissions.includes('tools.provide')
  ? installation.manifest.memberTools.filter((tool) => installation.tools.includes(tool.name)) : []);

/**
 * Automatic restart after a failure (docs/external-plugins.md「生命周期」), off by default per plugin. The n-th restart
 * inside the window waits AUTO_RESTART_BACKOFF_MS[n]: 2 s gets past a one-off hiccup at once, 10 s and 60 s give a
 * plugin that keeps crashing (a missing file, a full disk) time before it is tried again. At most this many restarts in
 * AUTO_RESTART_WINDOW_MS; the next failure inside the window leaves it failed until the user acts, so a plugin that
 * cannot start is not restarted forever.
 */
const AUTO_RESTART_BACKOFF_MS: readonly number[] = [2000, 10_000, 60_000];
const AUTO_RESTART_WINDOW_MS = 10 * 60_000;
/**
 * At most this many automatic restarts in total since the user's last start, restart or switch-on of automatic restart,
 * whatever the window says: a fault that comes back every 11 minutes ends too. A long healthy run gives nothing back
 * (simple and predictable: the user's start is the one way to a new budget).
 */
const AUTO_RESTART_TOTAL = 10;
/**
 * Development reload: changes in the plugin's directory are gathered for this long after the last one, so an editor
 * saving several files (or one file twice) restarts the plugin once.
 */
const DEV_RELOAD_DEBOUNCE_MS = 500;
/**
 * At most this many development reloads of one plugin in DEV_RELOAD_WINDOW_MS; the next change pauses reloading for it
 * until the user starts or restarts it or turns the switch off and on. A developer saving by hand stays well under it;
 * a plugin that writes into its own folder (outside data/) and so restarts itself stops at it.
 */
const DEV_RELOAD_MAX = 10;
const DEV_RELOAD_WINDOW_MS = 60_000;
/**
 * A reload of an instance that ran less than DEV_RELOAD_SHORT_MS counts as short-lived; DEV_RELOAD_SHORT_STREAK of them in
 * a row (a plugin that changes its own files soon after each start) pause reloading. DEV_RELOAD_TOTAL reloads since the
 * user's last start, restart or switch-on pause it in any case: a total bound, so nothing reloads itself forever.
 */
const DEV_RELOAD_SHORT_MS = 30_000;
const DEV_RELOAD_SHORT_STREAK = 5;
const DEV_RELOAD_TOTAL = 100;
/** Only these changes reload: source files, the manifest and package.json (both .json). Logs and other files do not. */
const DEV_RELOAD_SOURCES = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json'];
/** Paths under the plugin's directory whose changes never reload it: dependencies, and the folder for its own data. */
const DEV_RELOAD_IGNORED = new Set(['node_modules', 'data']);

/** A refused lifecycle request: a stable `code` and a sentence for the page (docs/external-plugins.md「生命周期」). */
export class LifecycleRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Watches a plugin's directory; `changed` gets the changed path relative to it, or null when the system does not say. */
export type DirectoryWatch = (directory: string, changed: (file: string | null) => void, failed: () => void) => { close(): void };

/** fs.watch, recursive (Node 24 on Windows, macOS and Linux); unref'd, so it never keeps the Hub alive. */
const watchDirectory: DirectoryWatch = (directory, changed, failed) => {
  const watcher = fsWatch(directory, { recursive: true, persistent: false }, (_type, file) => changed(typeof file === 'string' ? file : null));
  watcher.on('error', () => { watcher.close(); failed(); });   // the folder went away: an unhandled 'error' would crash the Hub
  return watcher;
};

/** What main.ts gives the plugin host for the lifecycle; every field is optional (tests use some). */
export interface LifecycleOptions {
  /**
   * The plugin's registration and manifest read again from disk (readExternalPlugin; `directory`: where it was registered
   * last, to name the entry whose manifest cannot be read); absent: the one in memory is reused.
   */
  reread?: (id: string, directory: string) => ExternalInstallation;
  /** Why the user may not start this plugin now (ORRERY_DISABLED_PLUGINS); null when it may. */
  startRefusal?: (id: string) => string | null;
  /** Official plugins enabled in this Hub: a requirement on one of them is met. */
  officialRunning?: readonly string[];
  /** The persisted switches (plugins.json) and how to save them; save may throw, and then nothing changes. */
  switches?: { autoRestart: readonly string[]; devReload: readonly string[]; uiOff?: readonly string[] };
  saveSwitches?: (next: { autoRestart: string[]; devReload: string[]; uiOff: string[] }) => void;
  backoffMs?: readonly number[];
  restartWindowMs?: number;
  debounceMs?: number;
  /** The total automatic-restart cap (AUTO_RESTART_TOTAL); tests lower it. */
  maxAutoRestartsTotal?: number;
  /** The grace for a plugin whose manifest names none. */
  shutdownGraceMs?: number;
  /** The Hub's close gives each plugin at most this grace (main.ts: HUB_CLOSE_PLUGIN_GRACE_MS); absent: its own grace. */
  closeGraceMs?: number;
  /** Development reload's cap (DEV_RELOAD_MAX in DEV_RELOAD_WINDOW_MS); tests shorten the window. */
  devReloadMax?: number;
  devReloadWindowMs?: number;
  devReloadShortMs?: number;
  devReloadShortStreak?: number;
  devReloadTotal?: number;
  /** Tests only: what starts a plugin's process (a stand-in whose exit is never seen, say). */
  spawn?: SpawnPlugin;
  watch?: DirectoryWatch;
  now?: () => number;
  /** How long a member's tool call waits for the plugin (TOOL_LIMITS.timeoutMs); tests shorten it. */
  toolTimeoutMs?: number;
  /** How long a frame's request waits for the plugin (UI_LIMITS.requestTimeoutMs); tests shorten it. */
  uiTimeoutMs?: number;
  /** The window of the tool-call records (TOOL_RECORD_MS); tests shorten it. */
  toolRecordMs?: number;
}

/**
 * The lifecycle of one registered plugin. `process` is the current instance; a start or restart replaces it with a new
 * one (one process per instance, never reused). `epoch` goes up with every lifecycle intent (a user's start, stop or
 * restart, an automatic restart, a reload, the Hub's close): an async step that finds it changed after an await stops
 * there, so an older intent never touches what a newer one made.
 */
interface Slot {
  readonly id: string;
  installation: ExternalInstallation;
  process: ExternalPluginProcess;
  epoch: number;
  /** Should be running: enabled at this start or started by the user, until the user stops it. */
  wanted: boolean;
  /** A start that failed before a process existed (the registration could not be read again, a requirement is not running). */
  startError: { error: string; errorCode: ExternalErrorCode } | null;
  autoRestart: boolean;
  devReload: boolean;
  /** The user turned its web UI off (docs/external-plugins.md「网页界面」): no frame opens, open ones are revoked. */
  uiOff: boolean;
  /** When the automatic restarts inside the window happened. */
  restarts: number[];
  backoff?: ReturnType<typeof setTimeout>;
  restartAt: number | null;
  /** The automatic restarts ran out; it stays failed until the user acts. */
  gaveUp: boolean;
  /** Why: the window's restarts ('window') or the total since the user's last start ('total'). */
  gaveUpReason: 'window' | 'total' | null;
  /** Automatic restarts since the user's last start, restart or switch-on (AUTO_RESTART_TOTAL caps it). */
  autoRestartsTotal: number;
  lastFailure: { at: string; errorCode: ExternalErrorCode | null; error: string | null } | null;
  watcher?: { close(): void };
  watched?: string;
  debounce?: ReturnType<typeof setTimeout>;
  devReloadError: string | null;
  /** Development reloads in the last DEV_RELOAD_WINDOW_MS; at DEV_RELOAD_MAX reload pauses until the user acts. */
  reloads: number[];
  reloadPaused: boolean;
  /** Reloads in a row of short-lived instances, reloads since the user's last start, when this instance was placed. */
  reloadStreak: number;
  reloadsSinceUser: number;
  placedAt: number;
  /** A source change came in while starting or stopping: reload once the launch has settled. */
  reloadDirty: boolean;
  /** The registration read again for a running plugin was invalid: it keeps running as before, the card says why. */
  registrationError: string | null;
  /** Timers that redraw the card when an automatic restart leaves the window (its count goes down). */
  agers: Set<ReturnType<typeof setTimeout>>;
  /** Bumped on every change the page should see; the page keeps the newer of two copies (`hub` tells Hub runs apart). */
  seq: number;
}

/** A plugin's lifecycle on the page: `GET /api/plugins` rows and the stream's `plugin-state` frames carry the same view. */
export interface LifecycleView {
  hub: string; seq: number; autoRestart: boolean; devReload: boolean; autoRestarts: number; maxAutoRestarts: number; backoffSeconds: number[]; windowMinutes: number;
  restartAt: string | null; gaveUp: boolean; lastFailure: Slot['lastFailure']; shutdownGraceMs: number; devReloadError: string | null;
  reloadPaused: boolean; registrationError: string | null;
  gaveUpReason: 'window' | 'total' | null; autoRestartsTotal: number; maxAutoRestartsTotal: number;
  /** The web UI's switch: true unless the user turned it off. */
  ui: boolean;
}
export interface PluginStateFrame {
  id: string; enabled: boolean; runtime: { state: ExternalState; error: string | null; errorCode: ExternalErrorCode | null }; lifecycle: LifecycleView;
}

/** The params of a call with a stable-code contract: a JSON object, or INVALID_DATA (arrays, strings, numbers, booleans). */
function codedParams(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HostRefusal('INVALID_DATA');
  return raw as Record<string, unknown>;
}

/**
 * The read calls added after v1's first two (host.messages.get, host.members.list) refuse with a stable code, in this
 * order: the permission, the parameters (a JSON object with exactly `fields`), then the cluster (in the read whitelist
 * and not deleted).
 */
function readScope(store: Store, installation: ExternalInstallation, permission: ExternalPermission, raw: unknown,
  fields: readonly string[], valid: (params: Record<string, unknown>) => boolean = () => true): { clusterId: string; params: Record<string, unknown> } {
  if (!installation.permissions.includes(permission)) throw new HostRefusal('PERMISSION_DENIED');
  const params = codedParams(raw);
  if (Object.keys(params).some((key) => !fields.includes(key)) || typeof params.clusterId !== 'string' || !valid(params)) {
    throw new HostRefusal('INVALID_DATA');
  }
  if (!installation.clusterIds.includes(params.clusterId) || !store.getCluster(params.clusterId)) throw new HostRefusal('CLUSTER_NOT_GRANTED');
  return { clusterId: params.clusterId, params };
}

const MAX_BODY_CHARS = 8000;
const MAX_REASON_CHARS = 300;
/** A gate plugin's reason as the member and the chat record show it: one line of plain text, no control or format characters. */
function refusalReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS).toWellFormed().trim();
}
const MAX_PAGE_BYTES = EXTERNAL_MAX_FRAME - 1024;   // the 1 KiB holds the envelope, even a 128-char request id fully escaped
// Reserve 1 KiB for the invoke envelope, bounded command ID, cluster/run UUIDs and timestamp.
const MAX_COMMAND_ARGUMENT_BYTES = EXTERNAL_MAX_FRAME - 1024;
/**
 * host.events.publish limits. 16 KiB of data leaves room for the envelope in a 64 KiB frame. 60 a minute per plugin
 * (sliding window, all clusters together) carries progress and status updates, but a plugin stuck in a loop cannot keep
 * every subscriber's 256-event queue full.
 */
const MAX_PUBLISH_BYTES = 16 * 1024;
const PUBLISH_PER_MINUTE = 60;
/** A member polling a tool every second leaves one chat record a minute (per plugin, member and tool), the rest counted. */
const TOOL_RECORD_MS = 60_000;
const DEFAULT_WRITE_SETTINGS: Readonly<ExternalWriteSettings> = { mentionEnabled: false, perMinute: 10, perHour: 200 };
const RATE_WINDOWS = [
  { setting: 'perMinute', window: 'minute', ms: 60_000 },
  { setting: 'perHour', window: 'hour', ms: 3_600_000 },
] as const;

function patchedRate(input: Record<string, unknown>, setting: 'perMinute' | 'perHour', current: number | null): number | null {
  if (!Object.hasOwn(input, setting)) return current;
  const value = input[setting];
  if (value === null) {
    if (input.confirmUnlimited !== true) throw new Error(`${setting} 不限额需要 confirmUnlimited: true。`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${setting} 必须是正整数或 null。`);
  return value;
}

/**
 * One message as host.messages.list and host.messages.get return it. The body goes through pluginMessageBody, the
 * rule message events use too: Hub-composed bodies (system, handover, handoff, resend) are omitted, others cut at 8000.
 */
function pluginMessageItem(message: Message): Record<string, unknown> {
  const content = pluginMessageBody(message);
  return { id: message.id, clusterId: message.clusterId, from: message.from,
    body: content.body, createdAt: message.createdAt, messageKind: message.kind ?? 'chat',
    ...(content.bodyOmitted ? { bodyOmitted: true } : {}), ...(content.bodyTruncated ? { bodyTruncated: true } : {}) };
}

/** Fills one frame newest first: what gets dropped is older, so the page's first id still works as `before`. */
function messagesPage(messages: readonly Message[]) {
  const page: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const message of messages.toReversed()) {
    const item = pluginMessageItem(message);
    // JSON needs at most 6 bytes a character, so one cut body always fits: a page is never empty just because of size.
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > MAX_PAGE_BYTES) return { messages: page.reverse(), truncated: true };
    page.push(item);
  }
  return { messages: page.reverse() };
}

/**
 * An open frame of a plugin's web UI. Its id (unguessable, in its URL) is the only thing that names it: the plugin,
 * cluster and position the Hub derives everything from. It belongs to one process instance; when that instance stops,
 * the user turns the UI off or the grant ends, the frame is revoked and its id stops working.
 */
interface UiFrame { id: string; pluginId: string; clusterId: string; position: FramePosition; process: ExternalPluginProcess }
/** What the chip a plugin sets in a cluster's title bar shows (host.ui.chip). */
interface UiChip { text: string | null; state: 'running' | 'done' | 'failed' | null }
/** A mark a plugin set on a message, member or task (host.ui.mark): what the page shows of it. */
interface UiMark { target: MarkTarget; targetId: string; text: string; state: typeof MARK_STATES[number] | null; tip: string | null }
/**
 * Frames for the user's page (the web stream's `plugin-ui`): a push to some frames, a chip change, frames revoked, one
 * mark set or cleared (`mark: null`; evicted ones too), and all of a plugin's marks in a cluster gone.
 */
export type UiStreamFrame =
  | { kind: 'push'; pluginId: string; frameIds: string[]; data: unknown }
  | { kind: 'chip'; pluginId: string; clusterId: string; chip: UiChip | null }
  | { kind: 'revoked'; pluginId: string; frameIds: string[]; reason: string }
  | { kind: 'mark'; pluginId: string; clusterId: string; target: MarkTarget; targetId: string; mark: Omit<UiMark, 'target' | 'targetId'> | null }
  | { kind: 'marks-cleared'; pluginId: string; clusterId: string };
const CHIP_STATES = ['running', 'done', 'failed'];

/** A check in flight: the plugin instances it was sent to and those that answered allow (by plugin id). */
interface Check { clusterId: string; asked: Map<string, ExternalPluginProcess>; allowed: Map<string, ExternalPluginProcess>; messageId?: string }

export class ExternalPlugins {
  /** The current instance of each registered plugin (a restart replaces it; the slot keeps the rest). */
  private readonly processes = new Map<string, ExternalPluginProcess>();
  private readonly slots = new Map<string, Slot>();
  /** The core's and the enabled official plugins' event types (a disabled plugin's types do not exist). */
  readonly events: EventRegistry;

  private readonly failures: readonly ExternalPluginFailure[];
  private readonly store: Store;
  private readonly preferences: PluginPreferences;
  private readonly hub?: HostHub;
  private readonly timeoutMs?: number;
  private readonly lifecycle: LifecycleOptions;
  /** This Hub run, for the page: a state seq from an earlier run means nothing next to one from this run. */
  private readonly hubRun = randomUUID();
  private seq = 0;
  private closed = false;
  /** The switches as plugins.json has them, ids not registered in this run included (a save keeps those). */
  private readonly savedSwitches: { autoRestart: string[]; devReload: string[]; uiOff: string[] };
  private readonly stateListeners = new Set<(frame: PluginStateFrame) => void>();
  /**
   * Checks in flight, by checkId: who was sent the request and who answered allow. An entry lives from checkMessage
   * to the Hub's checkSettled (exactly once per check), so there are only as many as sends waiting on the gate.
   * Each plugin is kept with the instance that was asked: a plugin restarted meanwhile gets nothing of the old check.
   */
  private readonly checks = new Map<string, Check>();
  /** messageId → checkId while that message is being written (checkStoring → checkSettled): its message.created names the check. */
  private readonly storing = new Map<string, string>();
  // Only known-exhausted windows, at most one deadline per configured plugin and write cluster.
  private readonly rateBlocks = new Map<string, Map<string, number>>();
  /** Accepted publish times of the last minute, per plugin: at most PUBLISH_PER_MINUTE each. */
  private readonly published = new Map<string, number[]>();
  /** Last publish-rate notice, at most one per installed plugin; repeated refusals within a minute keep its time. */
  private readonly publishLimits = new Map<string, { at: string; perMinute: number }>();
  /** Commands the user ran from a cluster (docs/external-plugins.md「命令」), in memory only. */
  private readonly runs: CommandRuns;
  /** Members' tool calls sent in the last minute, per plugin and member and per plugin (TOOL_LIMITS). Kept across restarts. */
  private readonly toolCalls = new CallWindows();
  /** Told which clusters' members may see other tools now (a tool plugin started or stopped): the bridges' list_changed. */
  private readonly toolListeners = new Set<(clusterIds: string[]) => void>();
  /** What each ready tool plugin offers, as last told to the listeners, with the clusters it offers it in. */
  private readonly offered = new Map<string, { signature: string; clusterIds: readonly string[] }>();
  /**
   * Open record windows, per plugin, member, tool and whether the call reached the plugin: the outcomes counted since
   * the window's first record, and the timer that writes their summary when the window ends and then forgets the entry.
   * An entry lives at most one window, so the map holds only the last window's callers.
   */
  private readonly toolRecords = new Map<string, { counts: Map<string, number>; settle(): void }>();
  /** Open frames of plugins' web UIs, by frame id (docs/external-plugins.md「网页界面」); in memory only, so a Hub restart ends them all. */
  private readonly frames = new Map<string, UiFrame>();
  /** The chip each plugin set per cluster (`<pluginId> <clusterId>`); dropped when the plugin leaves ready or its UI is turned off. */
  private readonly chips = new Map<string, UiChip>();
  /**
   * The marks each plugin set per cluster (`<pluginId> <clusterId>` → `<target> <targetId>` → mark), oldest first (at
   * most marksPerPluginPerCluster each); in memory only, dropped like the chips and when the cluster goes to the bin.
   */
  private readonly marks = new Map<string, Map<string, UiMark>>();
  /** UI requests and pushes (with chips and marks) sent in the last minute, per plugin (UI_LIMITS). */
  private readonly uiCalls = new CallWindows();
  /** Each plugin's `ui/` folder as last checked whole (checkUiFolder): the only files its frames are served. */
  private readonly uiListings = new Map<string, UiListing>();
  private readonly uiListeners = new Set<(frame: UiStreamFrame) => void>();

  constructor(installations: readonly ExternalInstallation[], store: Store, enabled: readonly string[], timeoutMs?: number,
    failures: readonly ExternalPluginFailure[] = [], hub?: HostHub, commandLimits: Partial<CommandLimits> = {}, lifecycle: LifecycleOptions = {}) {
    this.store = store;
    this.preferences = new PluginPreferences(store);
    this.hub = hub;
    this.timeoutMs = timeoutMs;
    this.lifecycle = lifecycle;
    this.savedSwitches = { autoRestart: [...lifecycle.switches?.autoRestart ?? []], devReload: [...lifecycle.switches?.devReload ?? []],
      uiOff: [...lifecycle.switches?.uiOff ?? []] };
    // command.cancel is opt-in like the other notifications: false (not sent) tells the run to stop waiting at once.
    this.runs = new CommandRuns({ ...COMMAND_LIMITS, ...commandLimits }, (pluginId, runId) => {
      const process = this.processes.get(pluginId);
      if (process?.state !== 'ready' || !process.wants('command.cancel')) return false;
      process.pushNotification('command.cancel', { runId });
      return true;
    });
    // A full-trust plugin whose event declarations fail or clash with an existing owner's loses only its types
    // (docs/plugins.md「故障隔离」); an official one's clash still stops the start.
    const fault = (id: string, error: unknown) => hub?.pluginFault?.(id, 'eventSource', error);
    const owned: OwnedEventSource[] = [{ owner: 'core', source: coreEventSource(store) }];
    for (const source of store.plugins.eventSources(store, fault)) {
      if (!store.plugins.isFullTrust(source.owner)) { owned.push(source); continue; }
      try { new EventRegistry([...owned, source]); owned.push(source); } catch (e) { fault(source.owner, e); }
    }
    this.events = new EventRegistry(owned);
    this.failures = failures;
    const on = (list: readonly string[] | undefined, id: string) => !!list?.includes(id);
    for (const installation of installations) {
      const id = installation.manifest.id;
      const slot: Slot = { id, installation, process: undefined as unknown as ExternalPluginProcess, epoch: 0, wanted: enabled.includes(id),
        startError: null, autoRestart: on(lifecycle.switches?.autoRestart, id), devReload: on(lifecycle.switches?.devReload, id), uiOff: on(lifecycle.switches?.uiOff, id),
        restarts: [], restartAt: null, gaveUp: false, gaveUpReason: null, autoRestartsTotal: 0, lastFailure: null, devReloadError: null, reloads: [], reloadPaused: false, reloadStreak: 0, reloadsSinceUser: 0, placedAt: 0, reloadDirty: false,
        registrationError: null, agers: new Set(), seq: 0 };
      this.slots.set(id, slot);
      this.place(slot, installation, this.instance(slot, installation));
    }
  }

  /** The current registrations, in configuration order. */
  private get installations(): ExternalInstallation[] { return [...this.slots.values()].map((slot) => slot.installation); }

  /**
   * A new process instance for this registration. Everything it can reach (host calls, run notifications, the end of its
   * runs, its state on the page, its failure) goes through `current()`: once a newer instance replaced it, a late frame
   * or callback of this one changes nothing, whatever state it is in.
   */
  private instance(slot: Slot, installation: ExternalInstallation): ExternalPluginProcess {
    const store = this.store;
    const pluginId = installation.manifest.id;
    let self: ExternalPluginProcess | undefined;
    const current = () => self !== undefined && this.processes.get(pluginId) === self;
    {
      const allowed = (permission: ExternalPermission) => {
        if (!installation.permissions.includes(permission)) throw new Error('permission denied');
      };
      const broker = (method: string, raw: unknown) => {
        if (!current()) throw new Error('plugin instance replaced');
        // Calls with a stable-code contract check the params' shape themselves, in their documented order.
        if (method === 'host.messages.get') {
          const { clusterId, params } = readScope(store, installation, 'messages.read', raw, ['clusterId', 'messageId'],
            (p) => typeof p.messageId === 'string' && !!p.messageId && p.messageId.length <= 128);
          const message = store.getMessage(params.messageId as string);
          // One answer for "no such message" and "a message of another cluster": nothing about other clusters leaks.
          if (message?.clusterId !== clusterId) throw new HostRefusal('NOT_FOUND');
          return { message: pluginMessageItem(message) };
        }
        if (method === 'host.members.list') return this.listMembers(readScope(store, installation, 'clusters.read', raw, ['clusterId']).clusterId);
        if (method === 'host.events.publish') return this.publishFromPlugin(installation, raw);
        if (method === 'host.ui.push' || method === 'host.ui.chip' || method === 'host.ui.mark') return this.uiFromPlugin(installation, method, raw);
        // The v1 calls promised no codes: any failure here, a non-object params included, is the generic error.
        const params = object(raw);
        if (method === 'host.clusters.list') {
          allowed('clusters.read');
          return { clusters: installation.clusterIds.flatMap((id) => {
            const cluster = store.getCluster(id);
            return cluster ? [{ id: cluster.id, name: cluster.name }] : [];
          }) };
        }
        if (method === 'host.messages.list') {
          allowed('messages.read');
          if (typeof params.clusterId !== 'string' || !installation.clusterIds.includes(params.clusterId) || !store.getCluster(params.clusterId)) throw new Error('cluster out of scope');
          const limit = params.limit ?? 20;
          if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid limit');
          if (params.before !== undefined && (typeof params.before !== 'string' || params.before.length > 128)) throw new Error('invalid cursor');
          if (typeof params.before === 'string' && store.getMessage(params.before)?.clusterId !== params.clusterId) throw new Error('cursor out of scope');
          return messagesPage(store.listMessages(params.clusterId, limit, params.before as string | undefined));
        }
        if (method === 'host.messages.send') {
          allowed('messages.send');
          return this.send(installation, params);
        }
        throw new Error('unsupported host method');
      };
      const eventAllowed = (event: ExternalEvent) => {
        const clusterId = event.clusterId ?? null;
        return eventGranted(installation, event.type, clusterId) && (clusterId === null || !!store.getCluster(clusterId));
      };
      // The effective settings (writeSettings), read when initialize is sent; changes follow as writeSettings.changed.
      const extras = () => ({ ...this.writeExtras(installation),
        ...(installation.manifest.config?.length ? { config: this.preferences.snapshot(installation) } : {}) });
      // A run's progress and end are accepted only from the plugin that owns the run (CommandRuns checks the owner), and
      // only from its current instance (an older one's runs already ended when it stopped).
      const hooks = {
        notification: (method: string, params: unknown) => {
          if (!current()) return;
          if (method === 'config.errors') this.preferences.report(installation, params);
          else if (method === 'command.progress') this.runs.progress(pluginId, params);
          else this.runs.done(pluginId, params);
        },
        inactive: () => {
          if (!current()) return;
          this.runs.endPlugin(pluginId);
          this.preferences.resetReports(pluginId);
        },
        changed: () => { if (current()) this.touch(slot); },
        failed: () => { if (current()) this.failedOnItsOwn(slot, self!); },
      };
      self = new ExternalPluginProcess(installation, broker, this.timeoutMs, eventAllowed, extras, hooks,
        this.lifecycle.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, this.lifecycle.spawn);
      return self;
    }
  }

  /** Makes `process` (made for `installation`) the slot's current instance: the only place an instance becomes current. */
  private place(slot: Slot, installation: ExternalInstallation, process: ExternalPluginProcess): void {
    slot.installation = installation;
    slot.process = process;
    this.processes.set(slot.id, process);
    slot.startError = null;
    this.touch(slot);
  }

  /**
   * host.members.list: the cluster's current members (removed ones are gone), each by a whitelist of fields. Never the
   * conversation or session id, working folder, avatar, model, bridge or anything else a Member carries.
   */
  private listMembers(clusterId: string) {
    if (!this.hub) throw new Error('members are unavailable');
    const roleNames = new Map(this.store.collaborationRoles(clusterId).map((role) => [role.id, role.name]));
    const roleIds = new Map(this.store.collaborationMemberRoles(clusterId).map((m) => [m.memberId, m.roleIds]));
    return { members: this.hub.listMembers(clusterId).map((m) => ({ id: m.id, name: m.name, harness: m.harness,
      status: m.status, hidden: !!m.hiddenAt,
      roles: (roleIds.get(m.id) ?? []).flatMap((id) => (roleNames.has(id) ? [{ id, name: roleNames.get(id)! }] : [])) })) };
  }

  private writeSettings(installation: ExternalInstallation): ExternalWriteSettings {
    const saved = this.store.getExternalWriteSettings(installation.manifest.id) ?? DEFAULT_WRITE_SETTINGS;
    return { ...saved, mentionEnabled: saved.mentionEnabled === true && installation.permissions.includes('messages.mention') };
  }

  private writeExtras(installation: ExternalInstallation) {
    return installation.permissions.includes('messages.send') ? { writeSettings: this.writeSettings(installation) } : {};
  }

  private configurable(id: string): ExternalInstallation {
    const installation = this.slots.get(id)?.installation;
    if (!installation?.manifest.config?.length) throw new PluginConfigProblem('CONFIG_NOT_FOUND', '没有可配置的插件。');
    return installation;
  }

  configView(id: string, clusterId: string | null) {
    return this.preferences.view(this.configurable(id), clusterId);
  }

  setConfig(id: string, clusterId: string | null, raw: unknown) {
    const installation = this.configurable(id);
    if (this.closed) throw new PluginConfigProblem('HUB_CLOSING', 'Hub 正在关闭。');
    this.preferences.save(installation, clusterId, raw, (config) =>
      fitsPluginInitialize(installation, { ...this.writeExtras(installation), config }));
    this.processes.get(id)!.configChanged(clusterId, () => {
      if (clusterId !== null && !this.granted(installation, clusterId)) return null;
      return this.preferences.notification(installation, clusterId);
    });
    return this.preferences.view(installation, clusterId);
  }

  configsInCluster(clusterId: string) {
    if (!this.store.getCluster(clusterId)) return null;
    return { plugins: this.installations.filter((p) => p.manifest.config?.some((field) => field.scope === 'cluster')
      && this.granted(p, clusterId)).map(({ manifest }) => ({ id: manifest.id, name: manifest.name ?? manifest.id })) };
  }

  onConfig(listener: (notice: ConfigNotice) => void) { return this.preferences.onChange(listener); }

  setWriteSettings(id: string, value: unknown): void {
    const installation = this.installations.find((item) => item.manifest.id === id);
    if (!installation?.permissions.includes('messages.send')) throw new Error('该插件未获发送消息的权限。');
    const input = object(value);
    const fields = ['mentionEnabled', 'perMinute', 'perHour'];
    if (!fields.some((field) => Object.hasOwn(input, field)) || Object.keys(input).some((field) => !fields.includes(field) && field !== 'confirmUnlimited')) {
      throw new Error('请提供 mentionEnabled、perMinute 或 perHour。');
    }
    const current = this.writeSettings(installation);
    const mentionEnabled = Object.hasOwn(input, 'mentionEnabled') ? input.mentionEnabled : current.mentionEnabled;
    if (typeof mentionEnabled !== 'boolean') throw new Error('mentionEnabled 必须是布尔值。');
    if (mentionEnabled && !installation.permissions.includes('messages.mention')) throw new Error('该插件未获 messages.mention 权限。');
    const perMinute = patchedRate(input, 'perMinute', current.perMinute);
    const perHour = patchedRate(input, 'perHour', current.perHour);
    this.store.setExternalWriteSettings(id, { mentionEnabled, perMinute, perHour });
    this.rateBlocks.delete(id);
    this.processes.get(id)?.pushNotification('writeSettings.changed', { writeSettings: this.writeSettings(installation) });
  }

  private send(installation: ExternalInstallation, params: Record<string, unknown>) {
    if (!this.hub) throw new Error('plugin writes are unavailable');
    const { clusterId, body, causedBy } = params;
    if (Object.keys(params).some((key) => !['clusterId', 'body', 'causedBy'].includes(key))) throw new Error('unexpected send field');
    if (typeof clusterId !== 'string' || !installation.writeClusterIds.includes(clusterId)) throw new Error('write cluster out of scope');
    if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_CHARS) throw new Error('invalid plugin message body');
    if (causedBy !== undefined && (typeof causedBy !== 'string' || !causedBy || causedBy.length > 128)) throw new Error('invalid causedBy');
    const pluginId = installation.manifest.id;
    const now = Date.now();
    const blocks = this.rateBlocks.get(pluginId);
    if (now < (blocks?.get(clusterId) ?? 0)) throw new Error('plugin message rate limit');
    blocks?.delete(clusterId);

    if (!this.store.getCluster(clusterId)) throw new Error('write cluster out of scope');
    const cause = causedBy === undefined ? null : this.store.getMessage(causedBy);
    if (causedBy !== undefined && cause?.clusterId !== clusterId) throw new Error('causedBy message out of scope');
    const settings = this.writeSettings(installation);
    const sender = externalPluginSender(pluginId);
    for (const { setting, window, ms } of RATE_WINDOWS) {
      const limit = settings[setting];
      if (limit === null) continue;
      const boundary = this.store.pluginRateBoundary(clusterId, sender, new Date(now - ms).toISOString(), limit);
      if (boundary === null) continue;
      const blocked = blocks ?? new Map<string, number>();
      blocked.set(clusterId, Date.parse(boundary) + ms);
      this.rateBlocks.set(pluginId, blocked);
      this.hub.externalPluginRateNotice(pluginId, clusterId, window, limit);
      throw new Error('plugin message rate limit');
    }
    return this.hub.sendFromExternalPlugin(pluginId, clusterId, body, cause, settings.mentionEnabled);
  }

  /**
   * host.events.publish: a type the manifest declares, under plugin.<id>., to the other plugins that subscribe to it.
   * Fire and forget like Hub events: nothing is stored, replayed, turned into a message or charged to any loop budget.
   * Refusals carry a stable code (docs/external-plugins.md「发布事件」); a refused publish does not count against the rate.
   */
  private publishFromPlugin(installation: ExternalInstallation, raw: unknown) {
    const params = codedParams(raw);   // documented: a non-object params is INVALID_DATA before the permission
    if (!installation.permissions.includes('events.publish')) throw new HostRefusal('PERMISSION_DENIED');
    if (Object.keys(params).some((key) => !['type', 'clusterId', 'data'].includes(key)) || typeof params.type !== 'string') throw new HostRefusal('INVALID_DATA');
    const pluginId = installation.manifest.id;
    const type = params.type;
    if (!type.startsWith(`${PLUGIN_NAMESPACE}.${pluginId}.`)) throw new HostRefusal('WRONG_NAMESPACE');
    if (!installation.manifest.publishes.some((p) => p.type === type)) throw new HostRefusal('TYPE_NOT_DECLARED');
    const clusterId = params.clusterId ?? null;
    if (clusterId !== null && typeof clusterId !== 'string') throw new HostRefusal('INVALID_DATA');
    if (clusterId !== null && (!(installation.clusterIds.includes(clusterId) || installation.writeClusterIds.includes(clusterId))
      || !this.store.getCluster(clusterId))) throw new HostRefusal('CLUSTER_NOT_GRANTED');
    const data = params.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HostRefusal('INVALID_DATA');
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_PUBLISH_BYTES) throw new HostRefusal('TOO_LARGE');
    const now = Date.now();
    const recent = (this.published.get(pluginId) ?? []).filter((at) => now - at < 60_000);
    this.published.set(pluginId, recent);
    if (recent.length >= PUBLISH_PER_MINUTE) {
      const previous = this.publishLimits.get(pluginId);
      if (!previous || now - Date.parse(previous.at) >= 60_000) {
        this.publishLimits.set(pluginId, { at: new Date(now).toISOString(), perMinute: PUBLISH_PER_MINUTE });
      }
      try { this.hub?.externalPluginPublishLimit(pluginId, clusterId, PUBLISH_PER_MINUTE); } catch { /* the record is best effort; the refusal is not */ }
      throw new HostRefusal('RATE_LIMITED');
    }
    recent.push(now);
    for (const plugin of this.installations) {
      const id = plugin.manifest.id;
      if (id !== pluginId && eventGranted(plugin, type, clusterId)) this.processes.get(id)?.pushEvent({ type, clusterId, data: data as Record<string, unknown> });
    }
    return { published: true };
  }

  /**
   * MessageGate for the Hub: asks every running plugin granted messages.gate for this cluster (its read scope), all at
   * once. null when none is configured for it, so the send does not wait. A plugin disabled at this start or stopped
   * by the user is not asked and leaves no record; one that is starting or failed counts as not answering.
   */
  checkMessage(request: MessageCheckRequest): Promise<MessageCheckOutcome[]> | null {
    // Asked when ready. Counted as not answering (fail-open WITH a record) when it is expected to be running but is not:
    // `wanted` (enabled at this start or started by the user, and not stopped by the user) while it restarts, waits for
    // an automatic restart, starts, failed or gave up. Not asked and no record only when the user does not want it running.
    const holders = this.installations.filter((p) => p.permissions.includes('messages.gate') && p.clusterIds.includes(request.clusterId)
      && (this.stateOf(p.manifest.id) === 'ready' || this.slots.get(p.manifest.id)!.wanted));
    if (!holders.length) return null;
    const check: Check = { clusterId: request.clusterId, asked: new Map(), allowed: new Map() };
    this.checks.set(request.checkId, check);
    return Promise.all(holders.map((installation) => this.askGate(installation, request, check)));
  }

  /** Just before the Hub writes the checked message: its message.created will carry the checkId to the plugins asked. */
  checkStoring(checkId: string, messageId: string): void {
    const check = this.checks.get(checkId);
    if (!check || check.messageId) return;
    check.messageId = messageId;
    this.storing.set(messageId, checkId);
  }

  /**
   * The check's final outcome, once: message.check.result to each plugin that answered allow (a refuser, a plugin that
   * did not answer in time and a plugin never asked get none). The entry ends here, so a second call does nothing.
   */
  checkSettled(checkId: string, result: MessageCheckResult): void {
    const check = this.checks.get(checkId);
    if (!check) return;
    this.checks.delete(checkId);
    if (check.messageId) this.storing.delete(check.messageId);
    const params = result.stored ? { checkId, stored: true, messageId: result.messageId } : { checkId, stored: false, reason: result.reason };
    // Re-checked when written, as a queued event is: a cluster deleted (or out of scope) meanwhile drops it, counted.
    // Only to the instance that answered: a plugin restarted since then never heard of this check.
    for (const [pluginId, process] of check.allowed) {
      if (this.processes.get(pluginId) !== process) continue;
      const installation = this.slots.get(pluginId)?.installation;
      process.pushNotification('message.check.result', params,
        () => !!installation?.clusterIds.includes(check.clusterId) && !!this.store.getCluster(check.clusterId));
    }
  }

  private async askGate(installation: ExternalInstallation, request: MessageCheckRequest, check: Check): Promise<MessageCheckOutcome> {
    const pluginId = installation.manifest.id;
    const process = this.processes.get(pluginId)!;
    const who = { pluginId, name: installation.manifest.name ?? pluginId };
    const long = request.body.length > MAX_BODY_CHARS;
    // Copied field by field: the body only with messages.read (the gate's cluster is always in its read scope).
    const params = {
      checkId: request.checkId,
      clusterId: request.clusterId, sender: { ...request.sender }, mentions: [...request.mentions], recipients: [...request.recipients],
      fyi: request.fyi, replyTo: request.replyTo, attachments: request.attachments, bodyLength: request.body.length,
      ...(installation.permissions.includes('messages.read')
        ? { body: long ? request.body.slice(0, MAX_BODY_CHARS).toWellFormed() : request.body, ...(long ? { bodyTruncated: true } : {}) } : {}),
    };
    if (process.state !== 'ready') return { ...who, verdict: 'failed', failure: 'not_running' };
    let answer: unknown;
    try { answer = await process.check(params, () => check.asked.set(pluginId, process)); } catch (error) {
      // Failed: this request (or one at the same time) stopped it. Still ready: a single late check, or an error answer
      // (an older plugin: method not found).
      const state = process.state as ExternalState;
      const code = process.errorCode;
      return { ...who, verdict: 'failed', failure: state === 'ready' ? (error instanceof CheckTimeout ? 'timeout' : 'error')
        : state !== 'failed' ? 'not_running' : code === 'CHECK_TIMEOUT' ? 'stopped'
        : code === 'PROCESS_EXITED' || code === 'IO_ERROR' ? 'exited' : 'protocol' };
    }
    const result = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer as Record<string, unknown> : null;
    if (result?.allow === true) { check.allowed.set(pluginId, process); return { ...who, verdict: 'allow' }; }
    if (result?.allow !== false) return { ...who, verdict: 'failed', failure: 'malformed' };
    return { ...who, verdict: 'refuse', reason: refusalReason(result.reason) };
  }

  has(id: string): boolean { return this.slots.has(id); }
  /**
   * A registered plugin's icon, read and checked now; undefined when it declares none or is not registered. `full:
   * false` (the plugin list, which only needs the verdict) reads at most the first few KiB of the file.
   */
  icon(id: string, full = true): PluginIcon | undefined {
    const installation = this.installations.find((p) => p.manifest.id === id);
    if (!installation || installation.manifest.iconPath === undefined) return undefined;
    return readPluginIcon(installation.directory, installation.manifest.iconPath, full);
  }
  /**
   * A registered plugin's row additions for GET /api/plugins. The manifest's own fields (name, version, description...)
   * come from the registration read last (an upgrade shows once it is restarted); `enabled` is whether it should be
   * running in this Hub (enabled at start or started since, until the user stops it); `runtime` and `lifecycle` are the
   * same view the stream's plugin-state frames carry.
   */
  info(id: string) {
    const slot = this.slots.get(id);
    if (!slot) return { runtime: undefined };   // skipped plugins are never listed as a registered id
    const { installation } = slot;
    const { manifest } = installation;
    const icon = this.icon(id, false);   // the list shows the reason on the card, so it checks; the route reads the file
    const frame = this.frame(slot);
    return { version: manifest.version, name: manifest.name ?? id, description: manifest.description ?? '', details: manifest.details ?? '',
      requires: manifest.requires ?? [], enabled: frame.enabled,
      origin: 'external' as const, apiVersion: installation.manifest.apiVersion,
      ...(manifest.config?.length ? { configScopes: configScopes(manifest.config) } : {}),
      iconUrl: icon && 'data' in icon ? `/api/plugins/${encodeURIComponent(id)}/icon` : null,
      ...(icon && 'error' in icon ? { iconError: icon.error } : {}),
      ...(installation.manifest.detailsTruncated ? { detailsTruncated: true } : {}),
      permissions: installation.permissions, events: installation.events, clusterIds: installation.clusterIds, commands: installation.manifest.commands,
      // The names members see (granted or not), so the card says which tools are offered and which are only declared.
      memberTools: installation.manifest.memberTools.map((tool) => ({ name: memberToolName(id, tool.name), description: tool.description,
        granted: grantedTools(installation).includes(tool) })),
      // Where those tools are offered: the rule the listing uses (toolsOfferedIn), by name for the card.
      memberToolClusters: grantedTools(installation).length
        ? installation.clusterIds.filter((clusterId) => this.toolsOfferedIn(installation, clusterId))
          .map((clusterId) => ({ id: clusterId, name: this.store.getCluster(clusterId, { includeDeleted: true })?.name ?? clusterId })) : [],
      eventGrants: this.eventGrants(installation), publishes: installation.manifest.publishes.map((t) => ({ type: t.type, description: t.description,
        ...(t.fields ? { fields: t.fields } : {}) })),
      eventPublishLimit: this.publishLimits.get(id) ?? null,
      // Its web UI: the positions declared and those granted (the card says where it may appear, and has the switch).
      ...(manifest.ui ? { ui: { positions: manifest.ui.positions, granted: grantedUi(installation), panelHeight: manifest.ui.panelHeight } } : {}),
      ...(installation.permissions.includes('messages.send') ? { writeClusterIds: installation.writeClusterIds, writeSettings: this.writeSettings(installation) } : {}),
      runtime: frame.runtime, lifecycle: frame.lifecycle };
  }

  /** The manifest read last for this registered plugin (an upgrade shows once it was started or restarted). */
  manifestOf(id: string) { return this.slots.get(id)?.installation.manifest; }

  /** The plugin's state now (a start that failed before a process existed counts as failed); undefined when not registered. */
  stateOf(id: string): ExternalState | undefined {
    const slot = this.slots.get(id);
    return slot && (slot.startError ? 'failed' : slot.process.state);
  }

  /** What the page shows of a plugin's lifecycle, sequenced by `lifecycle.seq` within `lifecycle.hub` (this Hub run). */
  private frame(slot: Slot): PluginStateFrame {
    const process = slot.process;
    const restarts = this.restartsInWindow(slot);
    return { id: slot.id, enabled: slot.wanted,
      runtime: slot.startError ? { state: 'failed', ...slot.startError } : { state: process.state, error: process.error, errorCode: process.errorCode },
      lifecycle: { hub: this.hubRun, seq: slot.seq, autoRestart: slot.autoRestart, devReload: slot.devReload, autoRestarts: restarts.length,
        maxAutoRestarts: this.backoffs().length, backoffSeconds: this.backoffs().map((ms) => ms / 1000), windowMinutes: this.windowMinutes(), restartAt: slot.restartAt === null ? null : new Date(slot.restartAt).toISOString(), gaveUp: slot.gaveUp,
        lastFailure: slot.lastFailure, shutdownGraceMs: process.shutdownGraceMs, devReloadError: slot.devReloadError,
        reloadPaused: slot.reloadPaused, registrationError: slot.registrationError,
        gaveUpReason: slot.gaveUpReason, autoRestartsTotal: slot.autoRestartsTotal, maxAutoRestartsTotal: this.totalCap(), ui: !slot.uiOff } };
  }

  /** Something about the slot the page shows changed: a new seq, and a plugin-state frame to the listeners (the web stream). */
  private touch(slot: Slot): void {
    slot.seq = ++this.seq;
    this.toolsMaybeChanged();
    this.reviewFrames(slot);
    if (!this.stateListeners.size) return;
    const frame = this.frame(slot);
    for (const listener of this.stateListeners) {
      try { listener(frame); } catch { /* one closed stream must not stop the others */ }
    }
  }

  // ---- tools for members (docs/external-plugins.md「群员工具」) ----

  /**
   * What each plugin offers members now: its granted tools as listed and its read clusters, while it is ready. Compared
   * on every change of a slot; for each plugin whose offer changed (it started, stopped, failed, or came back with other
   * declarations or grants), the clusters it offered tools in before and after are told to the listeners, once.
   */
  private toolsMaybeChanged(): void {
    const affected = new Set<string>();
    for (const slot of this.slots.values()) {
      const tools = grantedTools(slot.installation);
      const now = tools.length && this.stateOf(slot.id) === 'ready'
        ? { signature: JSON.stringify([slot.installation.clusterIds, tools.map((t) => [t.name, t.description, listedSchema(t)])]),
          clusterIds: slot.installation.clusterIds } : undefined;
      const before = this.offered.get(slot.id);
      if (before?.signature === now?.signature) continue;
      for (const clusterId of [...before?.clusterIds ?? [], ...now?.clusterIds ?? []]) affected.add(clusterId);
      if (now) this.offered.set(slot.id, now); else this.offered.delete(slot.id);
    }
    if (!affected.size) return;
    for (const listener of this.toolListeners) {
      try { listener([...affected]); } catch { /* a listener never changes the lifecycle */ }
    }
  }

  /** The tools members of these clusters could be offered changed (the Hub tells those members' bridges). */
  onToolsChanged(listener: (clusterIds: string[]) => void): () => void {
    this.toolListeners.add(listener);
    return () => this.toolListeners.delete(listener);
  }

  /**
   * The tools of a conversation whose (shown) memberships are in these clusters: the granted tools of every plugin with
   * at least one of them in its read whitelist (clusterIds) and not deleted. `running` is false for a plugin that is
   * starting, stopping, failed or stopped: such a tool is not listed, but a call (from an app still showing an older
   * list) is answered PLUGIN_NOT_RUNNING at once instead of "no such tool".
   */
  memberTools(clusterIds: readonly string[]): MemberToolDeclaration[] {
    return this.installations.flatMap((installation) => {
      const id = installation.manifest.id;
      const tools = grantedTools(installation);
      if (!tools.length) return [];
      if (!clusterIds.some((clusterId) => this.toolsOfferedIn(installation, clusterId))) return [];
      const running = this.stateOf(id) === 'ready';
      return tools.map((tool) => ({ name: memberToolName(id, tool.name), description: `(third-party plugin ${id}) ${tool.description}`,
        inputSchema: listedSchema(tool), running }));
    });
  }

  /**
   * A member's call of a plugin tool. Checked in this order, the first failure answers: the grant (the tool is declared
   * and granted, tools.provide, the cluster in the read whitelist and not deleted: NOT_GRANTED), the plugin running
   * (PLUGIN_NOT_RUNNING, at once), the arguments (INVALID_ARGUMENT), the budgets (RATE_LIMITED). A refused call is never
   * sent and uses no budget. A sent call waits at most the tool timeout (TOOL_TIMEOUT; the plugin keeps running) and is
   * settled at once when the plugin stops (PLUGIN_NOT_RUNNING). After the answer the caller is checked again (`still`):
   * a member removed, hidden, rebound or whose turn ended meanwhile gets CALLER_CHANGED, never the result. Every call
   * of a known tool leaves a rate-limited record in the cluster. Nothing here writes a message, a delivery or a Hub
   * event of its own (only that record), wakes anyone or counts against a loop limit.
   */
  async callMemberTool(call: MemberToolCall): Promise<MemberToolOutcome> {
    const found = this.findTool(call.name);
    if (!found) return { ok: false, code: 'NOT_GRANTED', message: '没有这个插件工具，或它没有获准在这里使用。' };
    const { slot, tool } = found;
    // Read once, before any await: the call belongs to this registration and this process instance from here on.
    const installation = slot.installation;
    const process = slot.process;
    const pluginId = slot.id;
    const pluginName = installation.manifest.name ?? pluginId;
    const started = this.now();
    let args: Record<string, unknown>;
    const finish = (outcome: MemberToolOutcome, sent: boolean, delivered = true): MemberToolOutcome => {
      this.toolRecord(call, pluginId, pluginName, outcome, sent, delivered, this.now() - started);
      return delivered ? outcome : { ok: false, code: 'CALLER_CHANGED',
        message: '调用期间这个对话已不再是这名成员（被移出、隐身、换绑到别的对话，或这一轮已经结束），这次调用的结果没有交回。' };
    };
    const refuse = (code: string, message: string) => finish({ ok: false, code, message }, false);
    if (!this.toolsOfferedIn(installation, call.clusterId)) {
      return refuse('NOT_GRANTED', `插件「${pluginName}」没有获准在这个群提供工具。`);
    }
    const state = this.stateOf(pluginId);
    if (state !== 'ready') return refuse('PLUGIN_NOT_RUNNING', `插件「${pluginName}」没有在运行（${state}），等它重新运行后再试。`);
    try { args = validateToolArguments(tool, call.arguments); } catch (error) {
      return refuse('INVALID_ARGUMENT', error instanceof ToolRefusal ? error.message : '参数不对。');
    }
    const now = this.now();
    const memberKey = `member\n${pluginId}\n${call.member.id}`;
    const pluginKey = `plugin\n${pluginId}`;
    if (process.inFlight('tool.call') >= TOOL_LIMITS.inFlightPerPlugin) {
      return refuse('RATE_LIMITED', `插件「${pluginName}」同时最多处理 ${TOOL_LIMITS.inFlightPerPlugin} 个工具调用，稍后再试。`);
    }
    if (this.toolCalls.full(memberKey, TOOL_LIMITS.perMemberPerMinute, now)) {
      return refuse('RATE_LIMITED', `你每分钟最多调用插件「${pluginName}」的工具 ${TOOL_LIMITS.perMemberPerMinute} 次，稍后再试。`);
    }
    if (this.toolCalls.full(pluginKey, TOOL_LIMITS.perPluginPerMinute, now)) {
      return refuse('RATE_LIMITED', `插件「${pluginName}」的工具每分钟最多被调用 ${TOOL_LIMITS.perPluginPerMinute} 次（所有成员合计），稍后再试。`);
    }
    const timeoutMs = this.lifecycle.toolTimeoutMs ?? TOOL_LIMITS.timeoutMs;
    const context = { clusterId: call.clusterId, member: { id: call.member.id, name: call.member.name }, at: new Date(now).toISOString(), callId: randomUUID() };
    let outcome: MemberToolOutcome;
    // The budgets are charged, and the call counts as sent, only once the request was written to the plugin (synchronously,
    // in the same step as the checks above).
    let sent = false;
    try {
      // Sent to this instance only: its answer, its timeout or its stop settles the call; a later instance never sees it.
      outcome = { ok: true, ...toolAnswer(await process.toolCall({ tool: tool.name, arguments: args, context }, timeoutMs, () => {
        sent = true;
        this.toolCalls.take(memberKey, now);
        this.toolCalls.take(pluginKey, now);
      })) };
    } catch (error) {
      // Never written (its other requests fill the plugin's pending slots, or it stopped in between): refused, uses no budget.
      if (!sent) {
        return process.state !== 'ready' ? refuse('PLUGIN_NOT_RUNNING', `插件「${pluginName}」没有在运行（${process.state}），等它重新运行后再试。`)
          : refuse('RATE_LIMITED', `插件「${pluginName}」暂时收不下更多请求，这次调用没有交给它；稍后再试。`);
      }
      const detail = error instanceof PluginAnswerError ? pluginErrorText(error.detail) : '';
      outcome = error instanceof ToolRefusal ? { ok: false, code: error.code, message: error.message }
        : error instanceof ToolTimeout ? { ok: false, code: 'TOOL_TIMEOUT', message: `插件「${pluginName}」没有在 ${timeoutMs / 1000} 秒内回答；插件仍在运行，可以稍后再试。` }
          : error instanceof PluginStopping || process.state !== 'ready'
            ? { ok: false, code: 'PLUGIN_NOT_RUNNING', message: `插件「${pluginName}」在调用期间停止了，这次调用没有完成；等它重新运行后可以再试。` }
            : error instanceof PluginAnswerError ? { ok: false, code: 'TOOL_FAILED', message: `插件「${pluginName}」报告失败${detail ? `：${detail}` : '。'}` }
              : { ok: false, code: 'TOOL_FAILED', message: `插件「${pluginName}」没有完成这次调用，稍后再试。` };
    }
    let delivered = false;
    try { delivered = call.still(); } catch { /* the caller cannot be confirmed: nothing is handed over */ }
    return finish(outcome, true, delivered);
  }

  /**
   * The one grant rule for where a plugin's tools are offered: the cluster is in its read whitelist (clusterIds) and still
   * exists (not deleted, not in the bin). The member paths ask it only for their own clusters; only the user's settings
   * card walks the whole whitelist.
   */
  private toolsOfferedIn(installation: ExternalInstallation, clusterId: string): boolean {
    return installation.clusterIds.includes(clusterId) && !!this.store.getCluster(clusterId);
  }

  /** The registered plugin and granted tool a member-visible name stands for; undefined when there is none. */
  private findTool(name: string): { slot: Slot; tool: ExternalTool } | undefined {
    for (const slot of this.slots.values()) {
      const tool = grantedTools(slot.installation).find((t) => memberToolName(slot.id, t.name) === name);
      if (tool) return { slot, tool };
    }
    return undefined;
  }

  /**
   * The chat record of one call (Hub.externalPluginToolRecord): safe metadata only, never content. Who called which
   * plugin's which tool, the outcome code, whether the call reached the plugin and whether the result was handed back,
   * how long it took, how many argument fields and how many bytes of arguments, how many bytes of result. Never an
   * argument value or key (keys can be member-chosen), the result, or the plugin's error text (the member gets those in
   * its own answer, nobody else does). The cluster's chat is shared, so its other members could read anything put here.
   *
   * Calls that reached the plugin and calls refused before it are windowed apart, so a refused call never hides one
   * that ran. The first call of a window is written at once; the others in the window (TOOL_RECORD_MS) are only
   * counted, and the window is settled (settleToolRecord) when it ends or the Hub closes: a summary with the counts,
   * written once, then the entry is gone. Once closing, a record is written at once without a window.
   */
  private toolRecord(call: MemberToolCall, pluginId: string, pluginName: string, outcome: MemberToolOutcome, sent: boolean,
    delivered: boolean, ms: number): void {
    const label = !delivered ? 'CALLER_CHANGED' : outcome.ok ? 'OK' : outcome.code;
    const write = (text: string) => {
      try { this.hub?.externalPluginToolRecord(pluginId, call.clusterId, text); } catch { /* a record never changes the call */ }
    };
    const key = `${pluginId}\n${call.member.id}\n${call.name}\n${sent ? 'sent' : 'refused'}`;
    const open = this.closed ? undefined : this.toolRecords.get(key);
    if (open) { open.counts.set(label, (open.counts.get(label) ?? 0) + 1); return; }
    if (!this.closed) {
      const entry = { counts: new Map<string, number>(), settle: () => {
        if (this.toolRecords.get(key) !== entry) return;   // settled already: once only
        clearTimeout(entry.timer);
        this.toolRecords.delete(key);
        const total = [...entry.counts.values()].reduce((a, b) => a + b, 0);
        if (!total) return;
        write(`「${call.member.name}」在上一条记录之后又调用了插件「${pluginName}」的工具 ${call.name} ${total} 次`
          + `（${sent ? '都交给了插件' : '都被拒绝，没有交给插件'}：${[...entry.counts].map(([what, n]) => `${what} ${n} 次`).join('、')}），没有逐条记录。`);
      }, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      entry.timer = setTimeout(entry.settle, this.lifecycle.toolRecordMs ?? TOOL_RECORD_MS);
      entry.timer.unref?.();
      this.toolRecords.set(key, entry);
    }
    const raw = call.arguments;
    let argBytes = 0;
    try { argBytes = Buffer.byteLength(JSON.stringify(raw ?? {}) ?? ''); } catch { /* not JSON: counted as 0 */ }
    const fields = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).length : 0;
    let resultBytes = 0;
    if (outcome.ok) try { resultBytes = Buffer.byteLength(JSON.stringify({ text: outcome.text, data: outcome.data })); } catch { /* not JSON */ }
    const seconds = `用时 ${(ms / 1000).toFixed(1)} 秒`;
    const how = !sent ? `被拒绝（${outcome.ok ? 'OK' : outcome.code}），没有交给插件`
      : `${outcome.ok ? '成功（OK）' : `失败（${outcome.code}）`}，交给了插件，${delivered ? '结果交回了调用者' : '结果没有交回（CALLER_CHANGED：调用期间这个对话已不再是这名成员）'}，${seconds}`;
    write(`「${call.member.name}」调用了插件「${pluginName}」的工具 ${call.name}：${how}。`
      + `参数 ${fields} 项、${argBytes} 字节${sent && outcome.ok ? `；结果 ${resultBytes} 字节` : ''}。记录不含参数和结果的内容。`);
  }

  /** Settles every open record window now (the Hub's close): each summary written once, while the store is open. */
  private settleToolRecords(): void {
    for (const entry of [...this.toolRecords.values()]) entry.settle();
  }

  // ---- the plugins' own web UIs (docs/external-plugins.md「网页界面」) ----

  /** Where this plugin's UI may appear in this cluster now: granted positions, the cluster in its read whitelist and not deleted. */
  private uiAllowed(installation: ExternalInstallation, clusterId: string, position: UiPosition): boolean {
    return grantedUi(installation).includes(position) && installation.clusterIds.includes(clusterId) && !!this.store.getCluster(clusterId);
  }

  /** Why an open frame may not serve or ask anything now (the first that applies), or null while it may. */
  private frameProblem(frame: UiFrame): UiRefusal | null {
    const slot = this.slots.get(frame.pluginId);
    if (!slot) return new UiRefusal('FRAME_CLOSED', '这个界面已经失效，请重新打开。');
    if (slot.uiOff) return new UiRefusal('UI_OFF', '这个插件的网页界面已在设置里关闭。');
    if (!this.uiAllowed(slot.installation, frame.clusterId, frame.position)) return new UiRefusal('NOT_GRANTED', '这个插件没有获准在本群的这个位置显示界面。');
    if (slot.startError || this.processes.get(frame.pluginId) !== frame.process || frame.process.state !== 'ready') {
      return new UiRefusal('PLUGIN_NOT_RUNNING', '插件没有在运行；它重新运行后界面会重新加载。');
    }
    return null;
  }

  /** Ends these frames: their ids stop working at once, and the page is told (its placeholders follow). */
  private revokeFrames(pluginId: string, frames: readonly UiFrame[], reason: string): void {
    if (!frames.length) return;
    for (const frame of frames) this.frames.delete(frame.id);
    this.tellUi({ kind: 'revoked', pluginId, frameIds: frames.map((frame) => frame.id), reason });
  }

  /**
   * After any change of a slot (touch): its frames that may no longer show (the instance they belong to stopped or was
   * replaced, the UI was turned off, the grant ended) are revoked, and its chips and marks are forgotten once it is not
   * running (a restart passes through that too) or its UI is off; the page is told the marks went.
   */
  private reviewFrames(slot: Slot): void {
    const ended = [...this.frames.values()].filter((frame) => frame.pluginId === slot.id).map((frame) => [frame, this.frameProblem(frame)] as const)
      .filter(([, problem]) => problem !== null);
    if (this.stateOf(slot.id) !== 'ready' || slot.uiOff) {
      for (const key of [...this.chips.keys()]) if (key.startsWith(`${slot.id}\n`)) this.chips.delete(key);
      this.dropMarks((pluginId) => pluginId === slot.id);
    }
    for (const code of new Set(ended.map(([, problem]) => problem!.code))) {
      this.revokeFrames(slot.id, ended.filter(([, problem]) => problem!.code === code).map(([frame]) => frame), code);
    }
  }

  /**
   * Forgets the marks of the plugins `which` picks (in `clusterId` only, or in every cluster), and tells the page once per
   * plugin and cluster that had any: a plugin stopped or switched off, a cluster in the bin.
   */
  private dropMarks(which: (pluginId: string) => boolean, clusterId: string | null = null): void {
    for (const [key, marks] of [...this.marks]) {
      const [pluginId, cluster] = key.split('\n');
      if (!which(pluginId) || (clusterId !== null && cluster !== clusterId)) continue;
      this.marks.delete(key);
      if (marks.size) this.tellUi({ kind: 'marks-cleared', pluginId, clusterId: cluster });
    }
  }

  /**
   * Whether a mark's target is there now: a message, a member not removed, a task (through the tasks plugin's view: none
   * while it is disabled), each of this cluster.
   */
  private markTargetExists(clusterId: string, target: MarkTarget, targetId: string): boolean {
    if (target === 'message') return this.store.getMessage(targetId)?.clusterId === clusterId;
    if (target === 'member') return this.store.getMember(targetId)?.clusterId === clusterId;
    return this.store.tasks?.task(clusterId, targetId) != null;
  }

  private tellUi(frame: UiStreamFrame): void {
    for (const listener of this.uiListeners) {
      try { listener(frame); } catch { /* one closed stream must not stop the others */ }
    }
  }

  /** Pushes, chips and revocations for the user's page (the web stream's `plugin-ui` frames). */
  onUi(listener: (frame: UiStreamFrame) => void): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  /**
   * The plugin UIs a cluster's page may show (GET /api/clusters/:id/plugin-ui): every registered plugin granted ui.show
   * and positions with this cluster in its read whitelist, whether it runs and whether its switch is on (the page draws
   * a placeholder for those that may not show now), its chip, and, with `marks` granted, its marks in this cluster whose
   * target is still there (oldest first; those on a target that is gone are dropped). null when the cluster does not exist.
   */
  uiItems(clusterId: string) {
    if (!this.store.getCluster(clusterId)) return null;
    return { items: [...this.slots.values()].flatMap((slot) => {
      const installation = slot.installation;
      const positions = grantedUi(installation).filter((position) => this.uiAllowed(installation, clusterId, position));
      if (!positions.length) return [];
      const running = this.stateOf(slot.id) === 'ready';
      const shown = running && !slot.uiOff;
      const kept = this.marks.get(`${slot.id}\n${clusterId}`);
      // A mark whose target is gone is dropped here (not listed, no longer counted against the cap).
      for (const [key, mark] of kept ?? []) if (!this.markTargetExists(clusterId, mark.target, mark.targetId)) kept!.delete(key);
      const marks = shown && positions.includes('marks') ? [...kept?.values() ?? []] : [];
      return [{ pluginId: slot.id, name: installation.manifest.name ?? slot.id, positions, panelHeight: installation.manifest.ui!.panelHeight,
        running, on: !slot.uiOff, chip: shown ? this.chips.get(`${slot.id}\n${clusterId}`) ?? null : null, marks }];
    }) };
  }

  /**
   * The page opens a frame (POST /api/clusters/:id/plugin-ui/frames, the user's token only): `{pluginId, position}`.
   * Checked in this order: the body, the plugin, the grant (ui.show, the position, the cluster in the read whitelist and
   * not deleted), the switch, that it runs, its files. The answer's URL carries a new unguessable frame id, valid for
   * this process instance only; the oldest of the plugin's frames is closed when it already has maxFramesPerPlugin.
   */
  openUiFrame(clusterId: string, raw: unknown) {
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!body || Object.keys(body).some((key) => !['pluginId', 'position'].includes(key)) || typeof body.pluginId !== 'string'
      || !(FRAME_POSITIONS as readonly unknown[]).includes(body.position)) throw new UiRefusal('INVALID_REQUEST', '请求须是 {pluginId, position}，position 为 titlebar 或 workbench。');
    const slot = this.slots.get(body.pluginId);
    if (!slot) throw new UiRefusal('UNKNOWN_PLUGIN', '没有这个第三方插件。');
    const position = body.position as FramePosition;
    const { installation } = slot;
    if (!this.uiAllowed(installation, clusterId, position)) throw new UiRefusal('NOT_GRANTED', '这个插件没有获准在本群的这个位置显示界面。');
    if (slot.uiOff) throw new UiRefusal('UI_OFF', '这个插件的网页界面已在设置里关闭。');
    if (this.stateOf(slot.id) !== 'ready') throw new UiRefusal('PLUGIN_NOT_RUNNING', '插件没有在运行；它重新运行后界面会重新加载。');
    const files = checkUiFolder(installation.directory);
    if (!files.ok) { this.uiListings.delete(slot.id); throw new UiRefusal(files.code, files.message); }
    this.uiListings.set(slot.id, files.files);
    const mine = [...this.frames.values()].filter((frame) => frame.pluginId === slot.id);
    if (mine.length >= UI_LIMITS.maxFramesPerPlugin) this.revokeFrames(slot.id, mine.slice(0, mine.length - UI_LIMITS.maxFramesPerPlugin + 1), 'EVICTED');
    const id = randomBytes(24).toString('base64url');
    this.frames.set(id, { id, pluginId: slot.id, clusterId, position, process: slot.process });
    return { frameId: id, url: `/plugin-ui/${id}/index.html`, pluginId: slot.id, name: installation.manifest.name ?? slot.id, clusterId, position,
      panelHeight: installation.manifest.ui!.panelHeight };
  }

  /** The page closed a frame (DELETE /api/plugin-ui/frames/:id): its id stops working. Closing an unknown id does nothing. */
  closeUiFrame(frameId: string): void { this.frames.delete(frameId); }

  /**
   * A file of a live frame (GET /plugin-ui/<frameId>/<path>, no login): null (404) for an unknown, closed or revoked id,
   * a frame that may not show now (revoked on the way), or a path or file readUiFile refuses. Only a file of a whole
   * `ui/` folder that passed checkUiFolder is served: one the last check did not see as it is now (added or rewritten
   * since) makes the whole folder be checked again first; the new listing then serves every frame of the plugin, and a
   * folder that no longer passes serves nothing new.
   */
  uiFile(frameId: string, rest: string): { data: Buffer; type: string } | null {
    const frame = this.frames.get(frameId);
    if (!frame) return null;
    const problem = this.frameProblem(frame);
    if (problem) { this.revokeFrames(frame.pluginId, [frame], problem.code); return null; }
    const segments = uiSegments(rest);
    if (!segments) return null;
    const directory = this.slots.get(frame.pluginId)!.installation.directory;
    const listing = this.uiListings.get(frame.pluginId);
    const file = listing ? readUiFile(directory, segments, listing) : 'stale';
    if (file !== 'stale') return file;
    const checked = checkUiFolder(directory);
    if (!checked.ok) { this.uiListings.delete(frame.pluginId); return null; }
    this.uiListings.set(frame.pluginId, checked.files);
    const again = readUiFile(directory, segments, checked.files);
    return again === 'stale' ? null : again;
  }

  /**
   * A frame's request to its own plugin (POST /api/plugin-ui/frames/:id/request, `{data}`): the plugin, cluster and
   * position come from the frame id alone. Checked in this order: the frame (FRAME_CLOSED), that it may show now (UI_OFF,
   * NOT_GRANTED, PLUGIN_NOT_RUNNING: the frame is revoked), the body (INVALID_REQUEST), the size (TOO_LARGE), the
   * plugin's in-flight and per-minute budgets (BUSY, RATE_LIMITED). Sent as `ui.request` to this frame's instance only;
   * it waits at most the UI timeout (UI_TIMEOUT; the plugin keeps running). Any answer, an error too, reaches the page
   * only while the frame still passes the checks it was sent under (otherwise FRAME_CLOSED or the frame's refusal), and a
   * result only at most maxDataBytes (TOO_LARGE).
   */
  async uiRequest(frameId: string, raw: unknown): Promise<{ result: unknown }> {
    const frame = this.frames.get(frameId);
    if (!frame) throw new UiRefusal('FRAME_CLOSED', '这个界面已经关闭或失效，请重新打开。');
    const problem = this.frameProblem(frame);
    if (problem) { this.revokeFrames(frame.pluginId, [frame], problem.code); throw problem; }
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!body || Object.keys(body).some((key) => key !== 'data')) throw new UiRefusal('INVALID_REQUEST', '请求须是 {data}。');
    const data = body.data ?? null;
    if (jsonBytes(data) > UI_LIMITS.maxDataBytes) throw new UiRefusal('TOO_LARGE', `请求的数据超过 ${UI_LIMITS.maxDataBytes / 1024} KiB。`);
    const { process, pluginId } = frame;
    const key = `request\n${pluginId}`;
    const now = this.now();
    if (process.inFlight('ui.request') >= UI_LIMITS.inFlightPerPlugin) {
      throw new UiRefusal('BUSY', `插件同时最多处理 ${UI_LIMITS.inFlightPerPlugin} 个界面请求，稍后再试。`);
    }
    if (this.uiCalls.full(key, UI_LIMITS.requestsPerPluginPerMinute, now)) {
      throw new UiRefusal('RATE_LIMITED', `插件的界面每分钟最多发 ${UI_LIMITS.requestsPerPluginPerMinute} 个请求，稍后再试。`);
    }
    let sent = false;
    let result: unknown;
    let failure: { error: unknown } | null = null;
    try {
      result = await process.uiRequest({ position: frame.position, clusterId: frame.clusterId, data,
        context: { at: new Date(now).toISOString(), requestId: randomUUID() } }, this.lifecycle.uiTimeoutMs ?? UI_LIMITS.requestTimeoutMs, () => {
        sent = true;
        this.uiCalls.take(key, now);
      });
    } catch (error) { failure = { error }; }
    // An answer, result or error alike, reaches the page only through a frame that may still show: the same check as
    // before sending. Closed, revoked (a stop, the switch, a deleted cluster) or no longer allowed: the frame's refusal,
    // never the plugin's result or its error text.
    if (!this.frames.has(frameId)) throw new UiRefusal('FRAME_CLOSED', '这个界面在插件回答前已经关闭或失效，回答没有交回。');
    const after = this.frameProblem(frame);
    if (after) { this.revokeFrames(frame.pluginId, [frame], after.code); throw after; }
    if (failure) {
      const { error } = failure;
      if (!sent || error instanceof PluginStopping || process.state !== 'ready') {
        throw process.state !== 'ready' ? new UiRefusal('PLUGIN_NOT_RUNNING', '插件没有在运行；它重新运行后界面会重新加载。')
          : new UiRefusal('BUSY', '插件暂时收不下更多请求，稍后再试。');
      }
      if (error instanceof UiTimeout) throw new UiRefusal('UI_TIMEOUT', `插件没有在 ${(this.lifecycle.uiTimeoutMs ?? UI_LIMITS.requestTimeoutMs) / 1000} 秒内回答。`);
      const detail = error instanceof PluginAnswerError ? pluginErrorText(error.detail) : '';
      throw new UiRefusal('UI_FAILED', `插件报告失败${detail ? `：${detail}` : '。'}`);
    }
    if (jsonBytes(result ?? null) > UI_LIMITS.maxDataBytes) throw new UiRefusal('TOO_LARGE', `插件的回答超过 ${UI_LIMITS.maxDataBytes / 1024} KiB，没有交回。`);
    return { result: result ?? null };
  }

  /**
   * host.ui.push `{clusterId, position?, data}` and host.ui.chip `{clusterId, text, state?}` from the plugin. Refusals
   * carry a stable code, in this order: PERMISSION_DENIED (no ui.show or no granted position), INVALID_DATA,
   * CLUSTER_NOT_GRANTED (not in the read whitelist, or deleted), POSITION_NOT_GRANTED, TOO_LARGE, RATE_LIMITED (both
   * calls share one per-minute budget; a refused call does not count). A push reaches only this plugin's open frames in
   * that cluster (and position), of its current instance; none open is not an error (`delivered: 0`).
   */
  private uiFromPlugin(installation: ExternalInstallation, method: 'host.ui.push' | 'host.ui.chip' | 'host.ui.mark', raw: unknown) {
    const params = codedParams(raw);
    const granted = grantedUi(installation);
    if (!granted.length) throw new HostRefusal('PERMISSION_DENIED');
    if (method === 'host.ui.mark') return this.markFromPlugin(installation, granted, params);
    const push = method === 'host.ui.push';
    const fields = push ? ['clusterId', 'position', 'data'] : ['clusterId', 'text', 'state'];
    if (Object.keys(params).some((key) => !fields.includes(key)) || typeof params.clusterId !== 'string') throw new HostRefusal('INVALID_DATA');
    const clusterId = params.clusterId;
    const position = params.position ?? null;
    const text = params.text === null ? null : chipText(params.text);
    const state = params.state ?? null;
    if (push ? (position !== null && !(FRAME_POSITIONS as readonly unknown[]).includes(position)) || params.data === undefined
      : (params.text !== null && text === null) || (state !== null && !CHIP_STATES.includes(state as string))) throw new HostRefusal('INVALID_DATA');
    if (!installation.clusterIds.includes(clusterId) || !this.store.getCluster(clusterId)) throw new HostRefusal('CLUSTER_NOT_GRANTED');
    // A push names a frame position, or none (every granted frame position: at least one must be granted).
    const positionGranted = !push ? granted.includes('titlebar')
      : position === null ? granted.some((p) => (FRAME_POSITIONS as readonly string[]).includes(p)) : granted.includes(position as UiPosition);
    if (!positionGranted) throw new HostRefusal('POSITION_NOT_GRANTED');
    if (push && jsonBytes(params.data) > UI_LIMITS.maxDataBytes) throw new HostRefusal('TOO_LARGE');
    const pluginId = installation.manifest.id;
    this.takeUiBudget(pluginId);
    if (!push) {
      // UI turned off: like a push with no open frame, accepted but shown nowhere and not kept (turning it off forgot the
      // chips, so turning it on again shows none until the plugin sets one).
      if (this.slots.get(pluginId)?.uiOff) return { shown: false };
      const chip: UiChip = { text, state: state as UiChip['state'] };
      this.chips.set(`${pluginId}\n${clusterId}`, chip);
      this.tellUi({ kind: 'chip', pluginId, clusterId, chip });
      return { shown: true };
    }
    const process = this.processes.get(pluginId);
    const frameIds = [...this.frames.values()].filter((frame) => frame.pluginId === pluginId && frame.clusterId === clusterId
      && (position === null || frame.position === position) && frame.process === process).map((frame) => frame.id);
    if (frameIds.length) this.tellUi({ kind: 'push', pluginId, frameIds, data: params.data });
    return { delivered: frameIds.length };
  }

  /** One push, chip or mark from the plugin against its per-minute budget (shared by the three); over it: RATE_LIMITED. */
  private takeUiBudget(pluginId: string): void {
    const key = `push\n${pluginId}`;
    const now = this.now();
    if (this.uiCalls.full(key, UI_LIMITS.pushesPerPluginPerMinute, now)) throw new HostRefusal('RATE_LIMITED');
    this.uiCalls.take(key, now);
  }

  /**
   * host.ui.mark `{clusterId, target, targetId, text, state?, tip?}`: one mark of this plugin on a message, member or task
   * of the cluster; setting it again replaces it, `text: null` clears it. Refusals, in this order: INVALID_DATA (fields,
   * target, id, text, state, tip), CLUSTER_NOT_GRANTED, POSITION_NOT_GRANTED (`marks` not granted), UI_OFF (the UI
   * switched off, as a frame is refused then), NOT_FOUND (no such target in this cluster, for a set and a clear alike; a
   * mark the plugin left on a target that is gone is dropped then), RATE_LIMITED (the budget shared with pushes and
   * chips; refusals do not count). Calls reach here only from the ready, current instance (the process refuses the rest).
   * The oldest of the plugin's marks in the cluster goes once there are more than marksPerPluginPerCluster; the page is
   * told of every change.
   */
  private markFromPlugin(installation: ExternalInstallation, granted: UiPosition[], params: Record<string, unknown>) {
    const fields = ['clusterId', 'target', 'targetId', 'text', 'state', 'tip'];
    const { clusterId, target, targetId } = params;
    if (Object.keys(params).some((key) => !fields.includes(key)) || typeof clusterId !== 'string'
      || !(MARK_TARGETS as readonly unknown[]).includes(target) || typeof targetId !== 'string' || !targetId || targetId.length > 128) {
      throw new HostRefusal('INVALID_DATA');
    }
    const clear = params.text === null;
    const text = clear ? null : chipText(params.text, UI_LIMITS.markText);
    const state = params.state ?? null;
    const tip = params.tip === undefined || params.tip === null ? null : chipText(params.tip, UI_LIMITS.markTip);
    if ((!clear && text === null) || (state !== null && !(MARK_STATES as readonly unknown[]).includes(state))
      || (params.tip !== undefined && params.tip !== null && typeof params.tip !== 'string')) throw new HostRefusal('INVALID_DATA');
    if (!installation.clusterIds.includes(clusterId) || !this.store.getCluster(clusterId)) throw new HostRefusal('CLUSTER_NOT_GRANTED');
    if (!granted.includes('marks')) throw new HostRefusal('POSITION_NOT_GRANTED');
    const pluginId = installation.manifest.id;
    const key = `${pluginId}\n${clusterId}`;
    const targetKey = `${target}\n${targetId}`;
    if (this.slots.get(pluginId)?.uiOff) throw new HostRefusal('UI_OFF');
    const own = this.marks.get(key);
    if (!this.markTargetExists(clusterId, target as MarkTarget, targetId)) {
      own?.delete(targetKey);   // its target is gone: not listed, and no longer counted against the cap
      throw new HostRefusal('NOT_FOUND');
    }
    this.takeUiBudget(pluginId);
    const tell = (on: UiMark, shown: boolean) => this.tellUi({ kind: 'mark', pluginId, clusterId, target: on.target, targetId: on.targetId,
      mark: shown ? { text: on.text, state: on.state, tip: on.tip } : null });
    if (clear) {
      const old = own?.get(targetKey);
      if (old) { own!.delete(targetKey); tell(old, false); }
      return { shown: false };
    }
    const marks = own ?? new Map<string, UiMark>();
    this.marks.set(key, marks);
    marks.delete(targetKey);   // set again: it becomes the newest
    const mark: UiMark = { target: target as MarkTarget, targetId, text: text!, state: state as UiMark['state'], tip };
    marks.set(targetKey, mark);
    while (marks.size > UI_LIMITS.marksPerPluginPerCluster) {
      const [oldestKey, oldest] = marks.entries().next().value!;
      marks.delete(oldestKey);
      tell(oldest, false);
    }
    tell(mark, true);
    return { shown: true };
  }

  /** Plugin state changes for the user's page (the web stream's `plugin-state` frames). */
  onState(listener: (frame: PluginStateFrame) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Each granted pattern with the types it matches now; a wildcard also matches types added later (the page says so). */
  private eventGrants(installation: ExternalInstallation) {
    const catalog = this.catalog().filter((t) => t.owner !== installation.manifest.id);
    return installation.events.map((pattern) => ({ pattern, wildcard: pattern === '*' || pattern.endsWith('.*'),
      types: catalog.filter((t) => patternMatches(pattern, t.type)).map((t) => ({ type: t.type, owner: t.owner, description: t.description, fields: t.fields })) }));
  }

  /** One failed card per unused manifest id; other failures are identified by their registration position. */
  registrationFailures(hasRegistered: (id: string) => boolean) {
    const shown = new Set<string>();
    const skippedRegistrations: Pick<ExternalPluginFailure, 'index' | 'manifestPath' | 'reason'>[] = [];
    // Dependency failures lack a registration position. Use their manifest for the card when possible.
    const failed = [...this.failures].sort((a, b) => a.index - b.index).flatMap((failure) => {
      const manifest = failure.manifest;
      if (!manifest || hasRegistered(manifest.id) || shown.has(manifest.id)) {
        const { index, manifestPath, reason } = failure;
        skippedRegistrations.push({ index, manifestPath: manifestPath && isAbsolute(manifestPath)
          ? manifestPath.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�') : null, reason });
        return [];
      }
      shown.add(manifest.id);
      return [{ id: manifest.id, version: manifest.version, requires: manifest.requires ?? [],
        name: manifest.name ?? manifest.id, description: manifest.description ?? '',
        details: manifest.details ?? '', ...(manifest.detailsTruncated ? { detailsTruncated: true } : {}), iconUrl: null,
        enabled: false, disabledByEnv: false, pendingEnabled: false, unavailable: true,
        origin: 'external' as const, apiVersion: manifest.apiVersion, commands: manifest.commands,
        runtime: { state: 'failed' as const, error: failure.error, errorCode: 'START_FAILED' as const } }];
    });
    return { failed, skippedRegistrations };
  }
  /** The Hub's start: every plugin enabled for it, at once, from the registration read at start-up. */
  async start(): Promise<void> {
    await Promise.all([...this.slots.values()].filter((slot) => slot.wanted).map((slot) => {
      this.syncWatch(slot);
      return this.launch(slot, false);
    }));
  }

  // ---- lifecycle (docs/external-plugins.md「生命周期」): the user's start, stop and restart, automatic restart, reload ----

  private slotOf(id: string): Slot {
    const slot = this.slots.get(id);
    if (!slot) throw new LifecycleRefusal('UNKNOWN_PLUGIN', '没有这个第三方插件。');
    if (this.closed) throw new LifecycleRefusal('HUB_CLOSING', 'Hub 正在关闭。');
    return slot;
  }

  /**
   * What the user's start or restart is refused for before anything is read or stopped: ORRERY_DISABLED_PLUGINS. Its
   * requirements are judged in launch, by the manifest read from disk then (a repaired manifest may have dropped one).
   */
  private refuseStart(slot: Slot): void {
    const refusal = this.lifecycle.startRefusal?.(slot.id);
    if (refusal) throw new LifecycleRefusal('DISABLED_BY_ENV', refusal);
  }

  /** Requirements not met now: an official plugin must be enabled in this Hub, another third-party plugin must be ready. */
  private missingRequirements(installation: ExternalInstallation): string[] {
    return (installation.manifest.requires ?? []).filter((dep) => !this.lifecycle.officialRunning?.includes(dep) && this.stateOf(dep) !== 'ready');
  }

  /**
   * The user's start: re-reads the registration and manifest, then starts a new instance. A running plugin is left as it
   * is. Refused (thrown) when the previous process of this plugin never exited; then nothing about the slot changed.
   */
  async startPlugin(id: string): Promise<void> {
    const slot = this.slotOf(id);
    if (!slot.startError && (slot.process.state === 'starting' || slot.process.state === 'ready')) return;
    this.refuseStart(slot);
    const refusal = await this.launch(slot, true, () => this.userWants(slot));
    if (refusal) throw refusal;
  }

  /**
   * The user's restart: re-read, then stop (with the shutdown grace) and start. Also starts a plugin that is not running.
   * A running plugin whose registration cannot be read now keeps running; the refusal says why (REGISTRATION_INVALID).
   */
  async restartPlugin(id: string): Promise<void> {
    const slot = this.slotOf(id);
    this.refuseStart(slot);
    const refusal = await this.launch(slot, true, () => this.userWants(slot));
    if (refusal) throw refusal;
  }

  /** The user's stop: no automatic restart or reload follows it, until the user starts the plugin again. Repeating it does nothing more. */
  async stop(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.epoch++;
    slot.wanted = false;
    slot.startError = null;
    slot.registrationError = null;
    slot.reloadDirty = false;
    this.cancelBackoff(slot);
    this.syncWatch(slot);
    this.touch(slot);
    const process = slot.process;
    await process.close();
    if (this.processes.get(slot.id) === process) this.noteStop(slot, process);
  }

  /** A start or restart by the user: it wants the plugin running, with fresh budgets of automatic restarts and reloads. */
  private userWants(slot: Slot): void {
    slot.wanted = true;
    slot.restarts = [];
    slot.gaveUp = false;
    slot.gaveUpReason = null;
    slot.autoRestartsTotal = 0;
    slot.reloads = [];
    slot.reloadPaused = false;
    slot.reloadStreak = 0;
    slot.reloadsSinceUser = 0;
    this.syncWatch(slot);
  }

  /**
   * After a stop: an exit that was never seen (STOP_TIMEOUT), or a non-zero exit before the `shutdown` answer (its
   * shutdown work may be incomplete), is kept as the last failure so the card says so. The state stays as the stop left it.
   */
  private noteStop(slot: Slot, process: ExternalPluginProcess): void {
    if (process.exitPending) {
      slot.lastFailure = { at: new Date(this.now()).toISOString(), errorCode: 'STOP_TIMEOUT',
        error: process.error ?? 'plugin stop requested but process exit was not observed' };
    } else if (process.shutdownTrouble) {
      slot.lastFailure = { at: new Date(this.now()).toISOString(), errorCode: 'PROCESS_EXITED', error: process.shutdownTrouble };
    } else return;
    this.touch(slot);
  }

  /**
   * Starts a new instance in place of the current one: with the registration read again from disk when `reread` (the
   * user's actions and the development reload), with the one in memory otherwise (the Hub's start, an automatic
   * restart). The registration is read and checked BEFORE anything is stopped: a running plugin whose new registration
   * is invalid keeps running (REGISTRATION_INVALID, also on its card); one that is not running fails with START_FAILED.
   * A new instance is never started while the previous process's exit is unseen (STOP_TIMEOUT). `accepted` runs once the
   * attempt goes ahead (a new instance is placed, or a not-running plugin fails START_FAILED), never for a refusal: the
   * caller's bookkeeping (the user's intent, an automatic restart's count and record) waits for it. Every await is
   * followed by the epoch check: a newer intent (another restart, a stop, the Hub's close) owns the slot from then on,
   * and this one ends without touching it. Never rejects: a refusal for the user is returned.
   */
  private async launch(slot: Slot, reread: boolean, accepted?: () => void): Promise<LifecycleRefusal | null> {
    let installation = slot.installation;
    let problem: string | null = null;
    if (reread) {
      try { installation = this.lifecycle.reread?.(slot.id, installation.directory) ?? installation; } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      const missing = problem === null ? this.missingRequirements(installation) : [];
      if (missing.length) problem = `required plugins are not running: ${missing.join(', ')}`;
      if (problem !== null) {
        const running = !slot.startError && (slot.process.state === 'starting' || slot.process.state === 'ready');
        if (running) {
          slot.registrationError = problem;
          this.touch(slot);
        }
        // Refused requests leave an earlier restart or backoff in charge of the slot.
        if (missing.length && accepted) {
          return new LifecycleRefusal('DEPENDENCY_NOT_RUNNING', `它依赖的插件没有在运行：${missing.join('、')}。先启动它们。`);
        }
        if (running) return new LifecycleRefusal('REGISTRATION_INVALID', `重新读取登记失败，插件仍按原来的登记运行：${problem}`);
      }
    }
    const epoch = ++slot.epoch;
    this.cancelBackoff(slot);
    if (problem !== null) {
      accepted?.();
      this.startFailed(slot, problem);
      this.afterLaunch(slot, epoch);
      return null;
    }
    let process = slot.process;
    if (reread || process.state !== 'disabled') {
      await process.close();   // the current instance, whatever its state; the same promise for a stop already under way
      if (slot.epoch !== epoch || this.closed) return null;
      this.noteStop(slot, process);
      if (process.exitPending) {
        // A stop is not done without evidence of exit: never two processes of one plugin (within this Hub run).
        return new LifecycleRefusal('STOP_TIMEOUT', '上一个插件进程没有确认退出，没有启动新的进程。稍后再试；它可能还在运行。');
      }
      accepted?.();
      process = this.instance(slot, installation);
      this.place(slot, installation, process);
      slot.placedAt = this.now();
      // Read again and valid: the note about an older registration is over. A relaunch from memory keeps it (it runs that one).
      if (reread) slot.registrationError = null;
      this.syncWatch(slot);   // the directory may have moved with the registration
    } else {
      accepted?.();
      slot.placedAt = this.now();
    }
    // Only plugins with write settings, and never throwing: a malformed saved value fails that plugin's own initialize
    // (INITIALIZE_FAILED, where the same read happens), not the Hub's start.
    const settings = () => {
      try { return installation.permissions.includes('messages.send') ? JSON.stringify(this.writeSettings(installation)) : null; } catch { return null; }
    };
    const sent = settings();
    await process.start();
    if (this.processes.get(slot.id) !== process) return null;
    // Changed while initialize was on its way, before the plugin could be told: tell it now.
    const now = settings();
    if (sent !== null && now !== null && now !== sent) process.pushNotification('writeSettings.changed', { writeSettings: JSON.parse(now) });
    this.afterLaunch(slot, epoch);
    return null;
  }

  /**
   * A source change came in while the plugin was starting or stopping (a save during the shutdown grace of a reload, say):
   * once the launch has settled, one more reload, through the same debounce and caps. Only with development reload on.
   */
  private afterLaunch(slot: Slot, epoch: number): void {
    if (!slot.reloadDirty || slot.epoch !== epoch) return;
    slot.reloadDirty = false;
    if (slot.watcher) this.planReload(slot, slot.watcher);
  }

  /**
   * A start that could not make a process (the registration read again is invalid, a requirement is not running): failed
   * with START_FAILED, like a plugin skipped at start-up, and recorded as the last failure. Not restarted automatically:
   * that would run the older registration the user just changed; the file must be fixed first (a reload or the user's
   * start reads it again).
   */
  private startFailed(slot: Slot, error: string): void {
    slot.startError = { error, errorCode: 'START_FAILED' };
    slot.registrationError = null;   // it is not running the older registration either
    slot.lastFailure = { at: new Date(this.now()).toISOString(), errorCode: 'START_FAILED', error };
    this.touch(slot);
  }

  private backoffs(): readonly number[] { return this.lifecycle.backoffMs ?? AUTO_RESTART_BACKOFF_MS; }
  private totalCap(): number { return this.lifecycle.maxAutoRestartsTotal ?? AUTO_RESTART_TOTAL; }
  private now(): number { return this.lifecycle.now?.() ?? Date.now(); }
  private restartsInWindow(slot: Slot): number[] {
    const now = this.now();
    return slot.restarts.filter((at) => now - at < (this.lifecycle.restartWindowMs ?? AUTO_RESTART_WINDOW_MS));
  }

  private cancelBackoff(slot: Slot): void {
    clearTimeout(slot.backoff);
    slot.backoff = undefined;
    slot.restartAt = null;
  }

  /**
   * The current instance failed by itself. Recorded as the last failure; with automatic restart on, the plugin still
   * wanted and its automatic restarts not given up, a restart is planned after the backoff, unless the window's restarts
   * are used up (then it gives up: one record, and no automatic restart until the user starts or restarts it, however
   * long ago the restarts were and whatever reload started it since). The timer only acts if nothing else happened to
   * the slot meanwhile (same epoch, Hub open). The restart is counted and recorded only when it actually starts a
   * process: an attempt refused for an unseen exit (STOP_TIMEOUT) uses no budget, writes nothing and is not retried.
   */
  private failedOnItsOwn(slot: Slot, process: ExternalPluginProcess): void {
    slot.lastFailure = { at: new Date(this.now()).toISOString(), errorCode: process.errorCode, error: process.error };
    if (this.closed || !slot.wanted || !slot.autoRestart || slot.gaveUp) {
      slot.registrationError = null;   // not running, and no relaunch of the older registration follows
      this.touch(slot);
      return;
    }
    slot.restarts = this.restartsInWindow(slot);
    const backoffs = this.backoffs();
    const total = slot.autoRestartsTotal >= this.totalCap();
    if (total || slot.restarts.length >= backoffs.length) {
      slot.gaveUp = true;
      slot.gaveUpReason = total ? 'total' : 'window';
      slot.registrationError = null;
      this.touch(slot);
      this.record(slot, 'gave-up', `插件「${this.nameOf(slot)}」又出错停止（${slot.lastFailure.errorCode ?? '未知错误'}）：`
        + (total ? `自你上次启动它以来已自动重启 ${this.totalCap()} 次（累计上限），` : `${this.windowMinutes()} 分钟内已自动重启 ${backoffs.length} 次，`)
        + 'Hub 不再自动重启它。要再运行，请在 设置 → 插件 里启动它。');
      return;
    }
    const delay = backoffs[slot.restarts.length];
    const epoch = ++slot.epoch;
    this.cancelBackoff(slot);
    slot.restartAt = this.now() + delay;
    slot.backoff = setTimeout(() => {
      slot.backoff = undefined;
      slot.restartAt = null;
      if (this.closed || slot.epoch !== epoch || !slot.wanted || !slot.autoRestart) { this.touch(slot); return; }
      const failure = slot.lastFailure?.errorCode ?? '未知错误';
      void this.launch(slot, false, () => {
        slot.restarts.push(this.now());
        slot.autoRestartsTotal++;
        this.ageOut(slot);
        // Written as the new process starts: it says only what has happened (the failure) and what is happening now.
        this.record(slot, 'restart', `插件「${this.nameOf(slot)}」出错停止（${failure}），Hub 正在自动重启它：`
          + `${this.windowMinutes()} 分钟内第 ${slot.restarts.length} 次，最多 ${backoffs.length} 次。`);
      }).catch(() => {});
    }, delay);
    slot.backoff.unref?.();
    this.touch(slot);
  }

  /**
   * When the restart just counted leaves the window, the count on the card goes down: a frame then, so the page does
   * not keep showing it (the seq moves). The timer is unref'd and cleared at the Hub's close.
   */
  private ageOut(slot: Slot): void {
    const timer = setTimeout(() => { slot.agers.delete(timer); if (!this.closed) this.touch(slot); },
      (this.lifecycle.restartWindowMs ?? AUTO_RESTART_WINDOW_MS) + 10);
    timer.unref?.();
    slot.agers.add(timer);
  }

  private nameOf(slot: Slot): string { return slot.installation.manifest.name ?? slot.id; }
  private windowMinutes(): number { return Math.round((this.lifecycle.restartWindowMs ?? AUTO_RESTART_WINDOW_MS) / 60_000); }

  /** A record the user sees in the plugin's clusters (Hub.externalPluginRestartRecord: rate-limited, wakes nobody). */
  private record(slot: Slot, kind: 'restart' | 'gave-up', text: string): void {
    const { clusterIds, writeClusterIds } = slot.installation;
    try { this.hub?.externalPluginRestartRecord(slot.id, [...new Set([...clusterIds, ...writeClusterIds])], kind, text); } catch { /* a record never changes the lifecycle */ }
  }

  /**
   * The user turns automatic restart or development reload on or off: `{autoRestart?, devReload?}`, at least one, only
   * booleans. Saved to plugins.json first (a failed save changes nothing); turning automatic restart off cancels a
   * planned restart, turning it on plans none for a failure that already happened (the user can start the plugin).
   */
  setLifecycle(id: string, raw: unknown): void {
    if (!this.slots.has(id)) throw new LifecycleRefusal('UNKNOWN_PLUGIN', '没有这个第三方插件。');
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const fields = ['autoRestart', 'devReload', 'ui'];
    if (!body || !Object.keys(body).length || Object.keys(body).some((key) => !fields.includes(key))
      || Object.values(body).some((value) => typeof value !== 'boolean')) {
      throw new LifecycleRefusal('INVALID_REQUEST', '请求须是 {autoRestart?, devReload?, ui?}，值为 true 或 false。');
    }
    const slot = this.slotOf(id);   // then HUB_CLOSING, the documented order
    const next = { autoRestart: Object.hasOwn(body, 'autoRestart') ? body.autoRestart as boolean : slot.autoRestart,
      devReload: Object.hasOwn(body, 'devReload') ? body.devReload as boolean : slot.devReload,
      uiOff: Object.hasOwn(body, 'ui') ? !(body.ui as boolean) : slot.uiOff };
    // Ids not registered in this run (skipped at start-up) keep their switches, as the enable list keeps them.
    const list = (key: 'autoRestart' | 'devReload' | 'uiOff') => [...this.savedSwitches[key].filter((other) => !this.slots.has(other)),
      ...[...this.slots.values()].filter((s) => (s === slot ? next[key] : s[key])).map((s) => s.id)];
    const saved = { autoRestart: list('autoRestart'), devReload: list('devReload'), uiOff: list('uiOff') };
    this.lifecycle.saveSwitches?.(saved);
    Object.assign(this.savedSwitches, saved);
    if (next.devReload !== slot.devReload) {   // the switch resumes a paused reload
      slot.reloads = []; slot.reloadPaused = false; slot.reloadStreak = 0; slot.reloadsSinceUser = 0; slot.reloadDirty = false;
    }
    if (next.autoRestart && !slot.autoRestart) {   // switching automatic restart on gives a new budget, like the user's start
      slot.restarts = []; slot.gaveUp = false; slot.gaveUpReason = null; slot.autoRestartsTotal = 0;
    }
    slot.autoRestart = next.autoRestart;
    slot.devReload = next.devReload;
    slot.uiOff = next.uiOff;   // turned off: touch() below revokes its open frames at once
    if (!slot.autoRestart && slot.backoff) { slot.epoch++; this.cancelBackoff(slot); slot.registrationError = null; }
    this.syncWatch(slot);
    this.touch(slot);
  }

  /**
   * Development reload: the plugin's directory is watched while reload is on and the plugin is wanted (not after the
   * user's stop, not after the Hub's close). A watcher that cannot start or breaks is noted on the card; the plugin
   * keeps running.
   */
  private syncWatch(slot: Slot): void {
    const directory = slot.installation.directory;
    if (!slot.devReload || !slot.wanted || this.closed) { this.unwatch(slot); return; }
    if (slot.watcher && slot.watched === directory) return;
    this.unwatch(slot);
    try {
      const watch = this.lifecycle.watch ?? watchDirectory;
      const watcher = watch(directory, (file) => this.changedOnDisk(slot, watcher, file), () => {
        if (slot.watcher !== watcher) return;
        this.unwatch(slot);
        slot.devReloadError = '插件目录的监视中断了（目录被删除或移动？）；关掉再打开“开发用重新加载”可以重试。';
        this.touch(slot);
      });
      slot.watcher = watcher;
      slot.watched = directory;
      slot.devReloadError = null;
    } catch {
      slot.devReloadError = '无法监视插件目录；文件改动不会自动重新加载。';
    }
  }

  private unwatch(slot: Slot): void {
    try { slot.watcher?.close(); } catch { /* already closed */ }
    slot.watcher = undefined;
    slot.watched = undefined;
    clearTimeout(slot.debounce);
    slot.debounce = undefined;
  }

  /**
   * A change in the plugin's directory. Only a source change reloads: the manifest, package.json and files ending in
   * DEV_RELOAD_SOURCES (a change the system names no file for counts too); nothing under node_modules/ or data/. While
   * the plugin is starting or stopping the change is remembered and reloads once the launch has settled; while reloading
   * is paused it is ignored. Otherwise a reload after the debounce (planReload, which applies the caps).
   */
  private changedOnDisk(slot: Slot, watcher: { close(): void }, file: string | null): void {
    if (slot.watcher !== watcher || this.closed || slot.reloadPaused) return;
    if (file !== null) {
      const parts = file.split(/[\\/]/);   // fs.watch names the file relative to the watched folder
      if (DEV_RELOAD_IGNORED.has(parts[0])) return;
      const name = parts.at(-1)!.toLowerCase();
      if (!DEV_RELOAD_SOURCES.some((ending) => name.endsWith(ending))) return;
    }
    const state = this.stateOf(slot.id);
    if (state === 'starting' || state === 'stopping') { slot.reloadDirty = true; return; }
    this.planReload(slot, watcher);
  }

  /**
   * A reload after the debounce, unless a cap stops it, which pauses reloading for this plugin until the user starts or
   * restarts it or turns the switch off and on (reloadPaused, shown on the card). The caps, all counted per plugin:
   *   - rate: at most DEV_RELOAD_MAX reloads in DEV_RELOAD_WINDOW_MS;
   *   - short-lived streak: DEV_RELOAD_SHORT_STREAK reloads in a row of an instance that had run less than
   *     DEV_RELOAD_SHORT_MS (a reload of an instance that ran longer resets the streak);
   *   - total: DEV_RELOAD_TOTAL reloads since the user last started, restarted or switched reloading on.
   * The total makes it true that no plugin reloads itself forever, however slowly it writes its own files.
   */
  private planReload(slot: Slot, watcher: { close(): void }): void {
    clearTimeout(slot.debounce);
    slot.debounce = setTimeout(() => {
      slot.debounce = undefined;
      if (this.closed || slot.watcher !== watcher || !slot.devReload || !slot.wanted || slot.reloadPaused) return;
      const now = this.now();
      slot.reloads = slot.reloads.filter((at) => now - at < (this.lifecycle.devReloadWindowMs ?? DEV_RELOAD_WINDOW_MS));
      const shortLived = now - slot.placedAt < (this.lifecycle.devReloadShortMs ?? DEV_RELOAD_SHORT_MS);
      const streak = shortLived ? slot.reloadStreak + 1 : 0;
      if (slot.reloads.length >= (this.lifecycle.devReloadMax ?? DEV_RELOAD_MAX)
        || streak >= (this.lifecycle.devReloadShortStreak ?? DEV_RELOAD_SHORT_STREAK)
        || slot.reloadsSinceUser >= (this.lifecycle.devReloadTotal ?? DEV_RELOAD_TOTAL)) {
        slot.reloadPaused = true;
        slot.reloadDirty = false;
        this.touch(slot);
        return;
      }
      slot.reloadStreak = streak;
      slot.reloads.push(now);
      slot.reloadsSinceUser++;
      void this.launch(slot, true).catch(() => {});
    }, this.lifecycle.debounceMs ?? DEV_RELOAD_DEBOUNCE_MS);
    slot.debounce.unref?.();
  }

  /**
   * POST /api/plugins/:id/invoke. A plugin that is not running, or that a stop (the user's, a restart, a reload) ended
   * while the call was out, answers PLUGIN_NOT_RUNNING (retryable once it runs again; the message keeps the state, e.g.
   * "plugin is stopping"). Any other failure is the plugin's own and keeps its generic error.
   */
  invoke(id: string, value: unknown): Promise<unknown> {
    const process = this.processes.get(id);
    if (!process) return Promise.reject(new Error('unknown external plugin'));
    const input = object(value);
    if (Object.keys(input).some((key) => !['command', 'arguments'].includes(key)) || typeof input.command !== 'string') throw new Error('expected {command, arguments}');
    const notRunning = () => new LifecycleRefusal('PLUGIN_NOT_RUNNING', `插件没有在运行（plugin is ${process.state}），等它重新运行后再试。`);
    if (process.state !== 'ready') return Promise.reject(notRunning());
    return process.invoke(input.command, object(input.arguments ?? {})).catch((error) => {
      if (error instanceof PluginStopping) throw notRunning();
      throw error;
    });
  }
  /** A cluster the plugin reads or writes, not deleted: where its commands are offered and may run. */
  private granted(installation: ExternalInstallation, clusterId: string): boolean {
    return (installation.clusterIds.includes(clusterId) || installation.writeClusterIds.includes(clusterId)) && !!this.store.getCluster(clusterId);
  }

  /**
   * The cluster's "/" menu: the commands of running plugins granted this cluster (not those declared clusterScoped:
   * false), and the runs still going there. null when the cluster does not exist.
   */
  commands(clusterId: string) {
    if (!this.store.getCluster(clusterId)) return null;
    const commands = this.installations.flatMap((installation) => {
      if (this.processes.get(installation.manifest.id)?.state !== 'ready' || !this.granted(installation, clusterId)) return [];
      return installation.manifest.commands.filter((c) => c.clusterScoped !== false).map((c) => ({
        pluginId: installation.manifest.id, pluginName: installation.manifest.name ?? installation.manifest.id,
        id: c.id, title: c.title, description: c.description ?? '', params: c.params ?? [] }));
    });
    return { commands, runs: this.runs.active(clusterId) };
  }

  /**
   * The user runs a command in a cluster (POST /api/clusters/:id/plugin-commands/run, the page's token only). Checked in
   * this order: the body, the plugin, the command, the cluster's grant, that the plugin is running, the arguments, the
   * per-plugin run cap. Nothing here writes a message or a delivery, wakes anyone or counts against a loop limit.
   */
  async runCommand(clusterId: string, raw: unknown): Promise<RunView> {
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!body || Object.keys(body).some((key) => !['pluginId', 'command', 'arguments'].includes(key))
      || typeof body.pluginId !== 'string' || typeof body.command !== 'string') {
      throw new CommandRefusal('INVALID_REQUEST', '请求须是 {pluginId, command, arguments?}。');
    }
    const installation = this.installations.find((p) => p.manifest.id === body.pluginId);
    const process = installation && this.processes.get(installation.manifest.id);
    if (!installation || !process) throw new CommandRefusal('UNKNOWN_PLUGIN', '没有这个插件。');
    const command = installation.manifest.commands.find((c) => c.id === body.command && c.clusterScoped !== false);
    if (!command) throw new CommandRefusal('UNKNOWN_COMMAND', '这个插件没有可以在群里运行的这个命令。');
    if (!this.granted(installation, clusterId)) throw new CommandRefusal('CLUSTER_NOT_GRANTED', '这个插件没有获准在本群使用。');
    if (process.state !== 'ready') throw new CommandRefusal('PLUGIN_NOT_RUNNING', '插件没有在运行。');
    const members = new Set((this.hub?.listMembers(clusterId) ?? []).map((m) => m.id));
    const args = validateArguments(command, body.arguments, members);
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_COMMAND_ARGUMENT_BYTES) {
      throw new CommandRefusal('INVALID_ARGUMENT', '参数合计过长：JSON 编码后最多 63 KiB，请缩短文字后再运行。');
    }
    if (this.runs.count(installation.manifest.id) >= this.runs.limits.maxRunsPerPlugin) {
      throw new CommandRefusal('TOO_MANY_RUNS', `这个插件已有 ${this.runs.limits.maxRunsPerPlugin} 个命令在运行，等其中一个结束再试。`);
    }
    const run = this.runs.create({ clusterId, pluginId: installation.manifest.id, pluginName: installation.manifest.name ?? installation.manifest.id,
      command: command.id, title: command.title }, command.longRunning === true);
    try {
      this.runs.answered(run, await process.invoke(command.id, args, { clusterId, by: 'user', at: run.startedAt, runId: run.runId }));
    } catch { this.runs.failed(run); }
    // Read after the await: the run may have ended meanwhile (the plugin stopped, sent command.done, or hit the cap).
    return CommandRuns.view(run);
  }

  /** The user's cancel of a run in this cluster (a run of another cluster is RUN_NOT_FOUND, as an unknown one). */
  cancelRun(clusterId: string, runId: string): RunView { return this.runs.cancel(clusterId, runId); }

  /** Run changes for the user's page (the web stream). Never stored, never sent to a plugin. */
  onRun(listener: (run: RunView) => void): () => void { return this.runs.onRun(listener); }

  /** Call before subscribing to the Hub: what "changed" means for a member's first status event (core-events.ts). */
  baselineMembers(members: readonly MemberBaseline[]): void { this.events.baseline(members); }

  /** Every type a subscriber could see now: the registry's and the ones installed plugins declare they publish. */
  catalog(): CatalogEntry[] {
    return [...this.events.catalog(), ...this.installations.flatMap((p) => p.manifest.publishes.map((t) => ({
      type: t.type, owner: p.manifest.id, description: t.description, fields: t.fields ?? '', scope: 'either' as const })))];
  }

  /**
   * Hub listener, called after the commit. Routes by grant; each process re-checks right before writing. A stopped
   * process ignores the push. The body variant goes only to plugins with messages.read (its scope is the same whitelist).
   */
  publish(event: HubEvent): void {
    // A cluster moved to the recycle bin (or otherwise changed): its frames that may no longer show die now, not at their
    // next file or request. A restored cluster gets new frames when the page opens them again.
    if (event.kind === 'cluster') {
      try {
        const ended = [...this.frames.values()].filter((frame) => frame.clusterId === event.clusterId)
          .map((frame) => [frame, this.frameProblem(frame)] as const).filter(([, problem]) => problem !== null);
        for (const [frame, problem] of ended) this.revokeFrames(frame.pluginId, [frame], problem!.code);
        // Its marks go with it (not kept for a restore); the page is told.
        if (event.clusterId && !this.store.getCluster(event.clusterId)) this.dropMarks(() => true, event.clusterId);
      } catch { /* the next file or request checks again */ }
    }
    try {   // a throwing listener would break the Hub's own delivery path
      const payload = (event.payload ?? {}) as { sourcePluginId?: unknown; pluginId?: unknown };
      // A plugin never hears about its own message, nor about the guard record its own limit wrote.
      const source = event.kind === 'message' ? payload.sourcePluginId : event.kind === 'guard' ? payload.pluginId : undefined;
      const wanted = (type: string) => this.installations.some((p) => eventGranted(p, type, null));
      for (const item of this.events.translate(event, wanted)) {
        // A checked member message: the plugins its check was sent to also get the checkId (no one else does).
        const checkId = item.type === 'message.created' ? this.storing.get(String(item.data.messageId)) : undefined;
        const asked = checkId ? this.checks.get(checkId)?.asked : undefined;
        for (const plugin of this.installations) {
          const id = plugin.manifest.id;
          if (id === source || !eventGranted(plugin, item.type, item.clusterId)) continue;
          const data = item.bodyData && plugin.permissions.includes('messages.read') ? item.bodyData : item.data;
          const process = this.processes.get(id);
          // The checkId only to the instance the check was sent to (not to one started since).
          process?.pushEvent({ type: item.type, clusterId: item.clusterId, data: process && asked?.get(id) === process ? { ...data, checkId } : data });
        }
      }
    } catch { /* observation must not change collaboration */ }
  }
  /**
   * The Hub's close: no lifecycle action starts anything from here on; every timer and watcher goes; every plugin is
   * stopped at the same time, so the whole close takes at most the longest grace plus the exit wait, however many there are.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const slot of this.slots.values()) {
      slot.epoch++;
      this.cancelBackoff(slot);
      this.unwatch(slot);
      for (const timer of slot.agers) clearTimeout(timer);
      slot.agers.clear();
    }
    // Each grace capped (closeGraceMs), also for a stop already under way: the Hub's close has a fixed upper bound.
    const cap = this.lifecycle.closeGraceMs;
    await Promise.all([...this.processes.values()].map((process) => process.close(cap === undefined ? undefined : Math.min(cap, process.shutdownGraceMs))));
    // The calls the stops just ended are recorded; then every open window writes its count while the store is open.
    this.settleToolRecords();
    this.frames.clear();
    this.chips.clear();
    this.marks.clear();
    this.uiListeners.clear();
    this.runs.close();
    this.preferences.close();
    this.stateListeners.clear();
  }
}
