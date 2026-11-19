// Clusters, members, messages, @ parsing, delivery scheduling, loop guards, the bridge registry and the event bus.
// See docs/architecture.md and docs/native-mode.md.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ActivityTracker, normalizeActivity } from './activity.ts';
import { loadAvatarPresets } from './avatars.ts';
import { createGroup, deleteGroup, effectiveGroups, renameGroup, reorderGroups } from './cluster-groups.ts';
import { actorKey, Collaboration, CollaborationError, HIDDEN_PERSON, HIDDEN_TOOL_TEXT, memberLabel, personName, type CollaborationNotice } from './collaboration.ts';
import type { CollaborationActor, CoordinatorPolicy, Task } from './collaboration-types.ts';
import { ensureDefaultRoles } from './default-roles.ts';
import { hiddenWorkNotice, hiddenWorkOf, type HiddenWork } from './hidden-work.ts';
import { CHAIN_LIMIT_ERROR, deliveryDiagnosis, deliveryUnresolved, resendNeedsConfirmation, timelineStages, type DeliveryTimeline, type QueuedHold, type ResendBlock } from './delivery-timeline.ts';
import { externalPluginSender } from './external-plugin-config.ts';
import { FileStore, isFileId, MAX_FILES_PER_MESSAGE, type FileStoreOptions } from './files.ts';
import { HANDOVER, handoverPackage, type HandoverPackage } from './handover.ts';
import { LIMIT_SETTINGS, parseLimit, type Limit, type LimitSetting, type LimitSource } from './limits.ts';
import { emptyTranscriptPage, TRANSCRIPT_MAX_ITEMS, type TranscriptPage, type TranscriptRequest } from './native-transcript.ts';
import { NOTIFY_SETTINGS, parseNotifyValue, type NotifySetting } from './notify-settings.ts';
import { asyncRefused, isThenable, PluginHookError, runHook, shortError, type EnvelopeItem, type PluginService } from './plugin.ts';
import { groupedProjects, projectIdentities } from './projects.ts';
import { listSkills, skillRefs, type SkillInfo } from './skills.ts';
import { ToolObservations } from './tool-observations.ts';
import type { ToolLists, ToolListMemory } from './tool-list.ts';
import { attributeTranscript, openTranscriptCursor, transcriptCursor } from './transcript-attribution.ts';
import type { ClusterChanges, QueuedCandidate, Store, StoredMember } from './store.ts';
import { emptyUnreadBreakdown } from './store.ts';
import { QUOTA_WARNING_PERCENT, quotaLevel, usageAlert, UsageTracker, type UsageReport } from './usage.ts';
import type {
  ActivityObserver, ActivitySnapshot, AgentEvent, BridgeDoneResult, BridgePort, Cluster, ClusterListing, Delivery, DeliveryResult, DeliveryState, FileInfo, HubEvent, Member, MemberRebind, Message, MessageCategory, ModelInfo, NativeAdapter, ProjectInfo,
  MessageCategoryFilter, MessageFilters, QuotaWindow, ReadVia, SessionInfo, SystemMessageKind, ToolCallObservation, ToolProfile, UnreadBreakdown, UnreadCategory, UnreadCategoryCounts, TurnHookHarness, WaitHarness,
} from './types.ts';

/** Options of read_messages: since/until/q/sender/mentions/category narrow both unread and history reads (intersection). */
export interface ReadOptions {
  limit?: number;
  before?: string;
  history?: boolean;
  since?: string;
  until?: string;
  q?: string;
  sender?: string;
  mentions?: string;
  category?: MessageCategoryFilter;
}

const MESSAGE_CATEGORIES = new Set<MessageCategoryFilter>(['mention', 'user', 'broadcast', 'task_notice', 'receipt_warning', 'warning']);
const UNREAD_CATEGORIES = new Set<UnreadCategory>(['mention', 'user', 'broadcast', 'task_notice']);

const formatUnreadAnnotations = (c: UnreadCategoryCounts): string => {
  const parts: string[] = [];
  if (c.fyi) parts.push(`仅知会 ${c.fyi}`);
  if (c.offline) parts.push(`离线 ${c.offline}`);
  if (c.failedOrUnknown) parts.push(`失败或结果未知 ${c.failedOrUnknown}`);
  if (c.blocked) parts.push(`被上限拦住 ${c.blocked}`);
  return parts.length ? `（${parts.join('，')}）` : '';
};

export function formatUnreadSummary(b: UnreadBreakdown): string {
  const parts: string[] = [];
  if (b.mention.total) parts.push(`点名你 ${b.mention.total}${formatUnreadAnnotations(b.mention)}`);
  if (b.user.total) parts.push(`用户 ${b.user.total}${formatUnreadAnnotations(b.user)}`);
  if (b.broadcast.total) parts.push(`广播 ${b.broadcast.total}${formatUnreadAnnotations(b.broadcast)}`);
  if (b.taskNotice.total) parts.push(`任务通知 ${b.taskNotice.total}${formatUnreadAnnotations(b.taskNotice)}`);
  return `未读 ${b.total}：${parts.join(' · ')}`;
}

/** One recorded plugin failure: where it happened (service, start, sweep, close, onQuotaChanged, tools …) and its first line. */
export interface PluginFault { phase: string; error: string; at: string }

export interface Limits {
  maxHops: number;         // the start-up hop limit (ORRERY_MAX_HOPS); a saved setting overrides it, see getLimit()
  maxTurnsPerChain: number; // the start-up per-chain turn limit (ORRERY_MAX_TURNS_PER_CHAIN); likewise overridden
  maxTurnsPerHour: number; // per conversation and hour for ordinary members (ORRERY_MAX_TURNS_PER_HOUR)
  maxCoordinatorTurnsPerHour: number; // the same, for a member that is the enabled coordinator of the cluster being scheduled
  maxNoticeBatchesPerHour: number; // the same hour, for batches of only system notifications (ORRERY_MAX_NOTICE_BATCHES_PER_HOUR)
  recheckMs: number;       // how often a member over the per-hour limit is re-checked, and app-checked members' status (watchStatus)
  bridgeAckMs: number;     // a bridge push without an ack within this time counts as failed
  startupGraceMs: number;  // after start, offline native members keep their deliveries queued this long (bridges reconnecting)
  quotaPollMs: number;     // how often in-use harnesses' quota is read from cheap sources (docs/usage.md); 0: never
  // Idle-task notices to the coordinator (docs/collaboration.md): wait after a trigger, periodic sweep, minimum gap per cluster.
  idleCheckMs: number;
  idleSweepMs: number;
  idleNoticeGapMs: number;
  failedNoticeGapMs: number; // proactive failed-delivery notices to the same sender for the same recipient wait at least this long (0: no wait)
  idleTaskGraceMs: number;   // a task updated within this window is not an idle candidate yet
  idleMemberGraceMs: number; // a member idle for less than this is not an idle candidate yet
  claudeQuotaPollMs: number; // how often Claude's quota is asked while a coordinated Claude member has open tasks; 0: never
  queueWarnMs: number;       // a delivery waiting this long without starting gets one warning (docs/collaboration.md); 0: never
  stalledMemberMs: number;         // no Hub-observed activity for this long -> one reminder to the coordinator
  noticeWindowMs: number;          // a burst of system notifications waits this long so it runs as one turn (0: no wait)
  messageWindowMs: number;         // member and plugin messages wait this long from the oldest queued one, so later arrivals join its turn (0: no wait)
}

export const DEFAULT_LIMITS: Limits = {
  maxHops: 6, maxTurnsPerChain: 20, maxTurnsPerHour: 30, maxCoordinatorTurnsPerHour: 120, maxNoticeBatchesPerHour: 300,
  recheckMs: 10_000, bridgeAckMs: 30_000, startupGraceMs: 10_000, quotaPollMs: 60_000,
  idleCheckMs: 60_000, idleSweepMs: 300_000, idleNoticeGapMs: 600_000, failedNoticeGapMs: 600_000, idleTaskGraceMs: 180_000, idleMemberGraceMs: 120_000, claudeQuotaPollMs: 900_000,
  stalledMemberMs: 1_800_000, noticeWindowMs: 2_000, messageWindowMs: 10_000,
  queueWarnMs: 300_000,
};

export interface HubOptions {
  store: Store;
  bridgeHubId?: string;    // stable id of this data directory, used to scope wait tickets
  secondary?: boolean;
  nativeAdapters: Record<string, NativeAdapter>;    // by harness
  limits?: Partial<Limits>;
  files?: FileStoreOptions; // where attachments are kept (docs/files.md); absent: no uploads or attachments
  skillsDir?: string;       // the user's shared skills folder, read-only (docs/files.md); absent: no skills
  avatarPresets?: string[]; // preset avatar names the Hub accepts; absent: read src/web/public/avatars at start-up
  toolList?: ToolListMemory; // the last start's MCP tool lists (checkToolList); absent: no tool-update hint
}

/** An attachment as a member sees it (envelope, read_messages): the local path only for native members. */
export interface AttachmentView { name: string; size: number; path?: string }

/**
 * How a message stands for one recipient (read_messages, for the caller's own messages). 'blocked': a guard stopped it
 * (the per-chain turn limit); `reason` for failed and blocked.
 */
export interface DeliveryOutcome { to: string; status: DeliveryState | 'blocked'; outcome: DeliveryResult | null; reason?: string }
/** What send_message reports: `duplicate` when clientMessageId matched an earlier send and nothing new was written. */
export interface SentMessage {
  message: Message;
  deliveredTo: string[];
  /** Names written as @name in the body that matched no member; empty when the body was not parsed (`to`). First send only: a duplicate reply omits it. */
  unresolvedMentions?: string[];
  /** Present only when an unresolved @-text starts with a member's name (`@张三你好`): says how to write it (mentionHints). First send only. */
  mentionHints?: string[];
  /** Present only when fyi=true + replyTo overrode fyi to wake the explicitly addressed asker. */
  fyiOverridden?: string[];
  /** No recipient at all: the message only stays in the record; names are what this cluster accepts after @. First send only. */
  warning?: string;
  duplicate?: true;
}

/**
 * A member's message as gate plugins are asked about it (messages.gate, docs/external-plugins.md「发言检查」), after
 * every check of the Hub's own and before anything is written. The plugin layer decides which plugin sees `body`.
 */
export interface MessageCheckRequest {
  /** Opaque and unique per check (one send attempt); the same id names it in message.created and its result. */
  checkId: string;
  clusterId: string;
  sender: { id: string; name: string };
  mentions: string[];     // member ids the message names (a member's @all: every present member)
  recipients: string[];   // member ids it will be delivered to
  fyi: boolean;
  replyTo: string | null;
  attachments: number;
  body: string;
}
type MessageCheckFailure = 'not_running' | 'timeout' | 'stopped' | 'exited' | 'protocol' | 'error' | 'malformed';
export type MessageCheckOutcome = { pluginId: string; name: string } & (
  { verdict: 'allow' } | { verdict: 'refuse'; reason: string } | { verdict: 'failed'; failure: MessageCheckFailure });
/**
 * How a check ended, told once it is final: stored, or not stored because another plugin refused it or the Hub's own
 * checks after the wait rejected it (including another send with the same clientMessageId stored meanwhile).
 */
export type MessageCheckResult = { stored: true; messageId: string } | { stored: false; reason: 'refused_by_other' | 'rejected_by_hub' };
/**
 * checkMessage → null: no plugin checks this cluster, and the send goes on at once. The promise never rejects.
 * For every check that returned a promise the Hub calls checkSettled exactly once, after the outcome is final; just
 * before it writes the message it calls checkStoring with the new message's id (its message event follows within that call).
 */
export interface MessageGate {
  checkMessage(request: MessageCheckRequest): Promise<MessageCheckOutcome[]> | null;
  checkStoring?(checkId: string, messageId: string): void;
  checkSettled?(checkId: string, result: MessageCheckResult): void;
}

/** A tool a third-party plugin offers members (docs/external-plugins.md「群员工具」), as tools/list shows it. */
export interface MemberToolDeclaration {
  name: string; description: string; inputSchema: Record<string, unknown>;
  /** The plugin is ready: listed. Not running: not listed, a call is answered PLUGIN_NOT_RUNNING. */
  running: boolean;
}
/** What the member's tools/call gets: the plugin's answer, or a stable code and a sentence. */
export type MemberToolOutcome = { ok: true; text?: string; data?: unknown } | { ok: false; code: string; message: string };
export interface MemberToolCall {
  /** The name the member called (p_<plugin>_<tool>). */
  name: string;
  /** The membership the MCP layer authenticated and selected; never taken from the tool's arguments. */
  clusterId: string;
  member: { id: string; name: string };
  /** The arguments as the member sent them, without the Hub's own clusterId. */
  arguments: unknown;
  /** Asked once the plugin has answered: is the caller still this membership (same conversation, shown)? */
  still(): boolean;
}
/** The composition root's third-party plugins (ExternalPlugins), for members' tools. Without one, members get none. */
export interface MemberToolHost {
  memberTools(clusterIds: readonly string[]): MemberToolDeclaration[];
  callMemberTool(call: MemberToolCall): Promise<MemberToolOutcome>;
}

/** A send a gate plugin refused: nothing was stored or delivered. The MCP layer shows `code: message`. */
class MessageRefused extends Error {
  readonly code = 'REFUSED_BY_PLUGIN';
}
// One user-visible record per key and window; repeats inside the window are only counted, and the next record says how many.
const GATE_REFUSAL_RECORD_MS = 60_000;     // per plugin and refused member
const GATE_FAILURE_RECORD_MS = 600_000;    // per plugin and cluster: a dead plugin would otherwise write one per minute forever
// Per plugin, cluster and kind (restart, gave up): a flapping plugin's restarts 2 s and 10 s apart make one record and a count.
const PLUGIN_RESTART_RECORD_MS = 60_000;
const GATE_FAILURE_TEXT: Record<MessageCheckFailure, string> = {
  not_running: '插件没有在运行',
  timeout: '没有在时限内回答；插件仍在运行，下一条发言照常检查',
  // 3: MAX_CHECK_TIMEOUTS in external-plugin-process.ts
  stopped: '连续 3 次没有在时限内回答，插件已被停止；在它重新启动之前不再检查发言',
  exited: '插件进程退出了',
  protocol: '插件出错（请求超时或输出不符合协议），已被停止', error: '插件回答了错误或收不下这个请求（可能不支持 message.check）', malformed: '插件的回答格式不对',
};

export interface DeliveryDetail extends Omit<DeliveryOutcome, 'outcome'> {
  outcome: DeliveryResult;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
}
export interface DeliveryReport { fyi: boolean; deliveries: DeliveryDetail[] }

/** 1536 → "1.5 KB". The web page's fmtSize (ui.js) matches. */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface MemberSpec {
  harness: string;
  mode?: unknown;           // input only: 'native', required to create a conversation (see buildMembers), optional to attach one
  projectPath?: string;
  sessionId?: string;       // attach an existing conversation; absent: create one (when the harness can)
  name?: string;
  avatar?: string | null;
  model?: string;           // new sessions only
  effort?: string;          // new sessions only
}

/** One connected bridge stream (GET /bridge/stream): one session's, or a whole harness's (shared). */
export interface BridgeConnection {
  send(e: { deliveryId: string; sessionId: string; text: string }): void;
  close(): void;
  sendActivity?(frame: { observerId: string; sessions: string[] }): void;
  /** Third-party plugin tools changed (a plugin started or stopped): the bridge tells its app the tool list changed. */
  toolsChanged?(): void;
  version?: string;   // the app version the bridge reported (Antigravity's sidecar), shown as harnessModes' bridgeVersion
}

interface ActivityBridge {
  conn: BridgeConnection;
  observerId: string;
  signature: string | null;
  sessions: Map<string, { seq: number; event: ReturnType<typeof normalizeActivity>; members: Map<string, { observer: ActivityObserver; seq: number }> }>;
}

type Ack = { ok: true; follows?: true } | { ok: false; error: string; outcome?: 'unknown' };
type DoneResult = BridgeDoneResult;

/** One run (turn or native delivery) of a member: one or more deliveries, delivered together. */
interface Running {
  batchId: string;          // the deliveries' batch_id: the id of the batch's first delivery; native adapters get it as deliveryId
  sessionKey: string;       // the conversation it runs in (sessionKey()): stays right when the member moves to another one
  deliveries: Delivery[];   // oldest first
  messages: Message[];      // the deliveries' messages, same order
  abort: AbortController;
  startedAt: number;        // its entry in turnStarts, taken back when the member turns out to be offline
  counted: boolean;         // it added an entry to turnStarts (a batch of only system notifications does not)
  sentMcpMessage: boolean;  // a successful message from this running conversation; suppress its forwarded answer
  // What its envelope told the member about its own messages that did not get through (undeliveredNotice): the
  // deliveries, and how many of its rejected-reply notes; `toolHint`: it carried the tool-update hint. Marked told
  // only when the run ends done.
  told: { ids: string[]; notes: number; toolHint?: boolean };
  waiting: { busy: boolean } | null;   // still in the harness's own queue, not picked up by a turn (NativeDeliverContext.waiting)
  queueWarned: boolean;                // the long-queue warning for this run was posted
}

/** Why Hub.purgeCluster changed nothing; the web API answers 404 for NOT_FOUND, else 409. */
export class PurgeRefused extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_IN_TRASH' | 'NAME_MISMATCH' | 'TRASH_CHANGED' | 'RUNNING' | 'ADDING_MEMBERS' | 'PLUGIN_DATA';
  /** RUNNING: the member whose work is still running. */
  readonly member: string | null;
  /** PLUGIN_DATA: plugins with tables in this database that did not run this start (the likely cause). */
  readonly plugins: string[];
  constructor(code: PurgeRefused['code'], message: string, member: string | null = null, plugins: string[] = []) {
    super(message);
    this.code = code;
    this.member = member;
    this.plugins = plugins;
  }
}

/** A permanent delete that happened: what it removed, the file ids whose folders could not be removed, and whether the WAL was written back. */
/**
 * `pluginDataMayRemain` (only when non-empty): plugins whose tables the database has (a migration record) but that did
 * not run this start (revoked, failed to load, safe mode): their clusterPurging did not run, so rows of the deleted
 * cluster may remain in their tables; the purge is never reported as complete for them.
 */
export interface PurgeResult { clusterId: string; messages: number; files: number; filesFailed: string[]; walCheckpointed: boolean; pluginDataMayRemain?: string[] }

/** SQLite's own foreign-key failure (SQLITE_CONSTRAINT_FOREIGNKEY, which node:sqlite reports as `errcode`). */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const isForeignKeyFailure = (e: unknown): boolean => (e as { errcode?: unknown } | null)?.errcode === SQLITE_CONSTRAINT_FOREIGNKEY;

/** Persists one event (Hub.emit, or inside Hub.atomically). */
type RecordEvent = (clusterId: string | null, memberId: string | null, kind: HubEvent['kind'], payload: unknown) => HubEvent;

const HOUR_MS = 3_600_000;
const OFFLINE_ERROR = '成员离线，未投递';
const SECONDARY_OFFLINE_ERROR = '第二实例：不投递';
/** The reason recorded on deliveries superseded when their member was hidden (page and user only: members never see it). */
export const HIDDEN_DELIVERY_REASON = '成员被设为隐身，投递已取消';
export const OPEN_STATUS_LABEL: Record<string, string> = { pending: '待开工', working: '执行中', review: '待验收' };
const MAX_AVATAR = 256 * 1024;
const NOTICE_MESSAGES = 5;    // an envelope names at most this many of the member's undelivered messages
const NOTICE_REASON_MAX = 80;
const NAME_RE = /^[\p{L}\p{N}_.-]+$/u;
const RESERVED_NAMES = new Set(['all', 'user']);
const OPTION_RE = /^[\p{L}\p{N}_.:/[\]-]{1,100}$/u;
const ACK_ERROR_MAX = 500;
const MAX_CLIENT_MESSAGE_ID = 200;
const MAX_NEW_BATCH_MESSAGES = 32;

/** Why a request for an isolated member is refused (docs/native-mode.md). */
const ISOLATED_REMOVED = 'isolated mode was removed: a member is a conversation of its native app';

/** Longest sidebar group name (characters, after trimming). */
export const MAX_CATEGORY = 40;
/** Longest cluster name (characters, after trimming) for a new cluster or a rename; older longer names are kept. */
export const MAX_CLUSTER_NAME = 60;

/**
 * A cluster name, for create and rename alike: trimmed, non-empty, at most MAX_CLUSTER_NAME characters, none of
 * \ / : * ? " < > | (a name once named a folder; the rule stays), no control characters or line separators (they would split the
 * envelope header line), not starting with ".". Duplicates are allowed: clusters are told apart by id.
 */
function checkClusterName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || /[\\/:*?"<>|\p{Cc}\p{Zl}\p{Zp}]/u.test(name) || name.trim().startsWith('.')
    || [...name.trim()].length > MAX_CLUSTER_NAME) {
    throw new Error(`cluster name is required, at most ${MAX_CLUSTER_NAME} characters, and may not contain \\ / : * ? " < > |, control characters or line separators, or start with "."`);
  }
  return name.trim();
}

function checkCategory(category: unknown): string {
  if (typeof category !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(category) || [...category.trim()].length > MAX_CATEGORY) {
    throw new Error(`category must be a string of at most ${MAX_CATEGORY} characters without control characters or line breaks`);
  }
  return category.trim();
}

const CLUSTER_PATCH_KEYS = new Set(['category', 'name', 'pinned', 'archived']);

function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name) || RESERVED_NAMES.has(name)) {
    throw new Error(`invalid member name ${JSON.stringify(name)}: letters, digits, CJK, _ . - only; not "all" or "user"`);
  }
  return name;
}

/** model / effort: an optional short identifier. */
function checkOption(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !OPTION_RE.test(value)) throw new Error(`invalid ${what} ${JSON.stringify(value)}`);
  return value;
}

/** Model names like "vendor/model x" become "vendor-model-x"; nothing usable left → the harness name. */
function defaultName(model: string | null, harness: string): string {
  const name = (model ?? '').replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '');
  return name && !RESERVED_NAMES.has(name) ? name : harness;
}

/**
 * null: the page draws a generated initial. `preset:<name>`: one of the avatars the Hub ships (the list is read at
 * start-up; anything else is refused, so the page never loads a file the Hub did not choose to serve). Otherwise an
 * emoji or an image data URL up to 256 KB, kept in the database as before.
 */
function checkAvatar(avatar: unknown, presets: ReadonlySet<string>): string | null {
  if (avatar === null) return null;
  if (typeof avatar !== 'string' || avatar.length > MAX_AVATAR) {
    throw new Error('avatar must be an emoji, a preset avatar or a data URL up to 256 KB');
  }
  if (avatar.startsWith('preset:')) {
    const name = avatar.slice('preset:'.length);
    if (!presets.has(name)) throw new Error(`unknown avatar preset ${JSON.stringify(name)}`);
    return avatar;
  }
  return avatar;
}

/** A letter, digit or combining mark in any script, optionally after a run of the joiners `.` `-` `_`, read at lastIndex. */
const NAME_GOES_ON = /[._-]*[\p{L}\p{N}\p{M}]/uy;

/**
 * Whether an @-name that stops at `end` really ends there: at the end of the text, or before anything but a letter,
 * digit or combining mark of any script (CJK counts as letters), where a run of `.` `-` `_` followed by a letter or
 * digit continues the name. `@agent`, `@agent 你好`, `@agent，`, `@agent.` and `@agent。` end; `@agent1`, `@agent你好`,
 * `@agent.v2` and `@agent.-v2` do not. The web page has a copy (ui.js), held to the same examples by a test.
 */
export function nameEnds(text: string, end: number): boolean {
  NAME_GOES_ON.lastIndex = end;
  return !NAME_GOES_ON.test(text);
}

/**
 * The name the `@` at index `at` of `text` mentions: one of `names` (the cluster's member names, plus 'all') written
 * right after the `@` and ending there (nameEnds), or null. Full names only: `@张` and `@张三你好` mention neither
 * 张三 nor 张三丰. Member names may contain `.` `-` `_` (NAME_RE), so two names can both end at one `@` only when the
 * longer one is the shorter plus trailing joiners (`A` and `A.` in `@A. hi`); then the longer one wins, by this rule and
 * not by the order of `names`. Does not look at what precedes the `@` (foo@bar) or at quoting: the caller does.
 */
export function mentionAt(text: string, at: number, names: Iterable<string>): string | null {
  let hit: string | null = null;
  for (const name of names) {
    if (name && text.startsWith(name, at + 1) && nameEnds(text, at + 1 + name.length) && (hit === null || name.length > hit.length)) hit = name;
  }
  return hit;
}

/**
 * send_message's hints for @-texts that matched no member but start with a member's name (`@张三你好`): no member has
 * that name; to reach 张三, end the name with a space or punctuation. Only says so: the message is never re-routed.
 */
export function mentionHints(unresolved: string[], names: Iterable<string>): string[] {
  const all = [...names];
  return unresolved.flatMap((text) => {
    const name = all.filter((n) => n && n !== text && text.startsWith(n)).sort((a, b) => b.length - a.length)[0];
    return name ? [`没有成员叫「${text}」；如果你想 @${name}，请在名字后面加空格或标点。`] : [];
  });
}

/**
 * The name written after the '@' at `at`, for an @ that matched no member: the characters member names may
 * contain (types.ts), with a dot only when it continues the name, so `@claude.` reads as `claude`.
 */
function unresolvedName(body: string, at: number): string {
  return /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*/u.exec(body.slice(at))?.[0] ?? '';
}

/** The warning send_message adds when nothing was addressed: the message stays in the record; these names can be @. */
function noRecipientWarning(members: StoredMember[]): string {
  const names = members.map((member) => member.name);
  return 'This message reached no member and only stays in the chat record. '
    + `Available member names: ${names.length ? names.join(', ') : '(none)'}.`;
}

/** A delivery's state as read_messages reports it: a chain-limit failure is 'blocked'. */
function outcomeOf(d: Delivery): { status: DeliveryOutcome['status']; outcome: DeliveryResult | null; reason?: string } {
  if (d.state === 'failed' && d.error === CHAIN_LIMIT_ERROR) return { status: 'blocked', outcome: d.outcome, reason: d.error };
  return { status: d.state, outcome: d.outcome, ...(['failed', 'superseded'].includes(d.state) && d.error ? { reason: d.error } : {}) };
}

const own = <T>(rec: Record<string, T>, key: unknown): T | undefined =>
  typeof key === 'string' && Object.hasOwn(rec, key) ? rec[key] : undefined;

/** The tool profile a member's harness gives it (its MCP caller kind), before any tool call is observed. */
function defaultProfile(member: StoredMember): ToolProfile {
  return member.harness === 'antigravity' ? 'antigravity'
    : member.harness === 'zcode' ? 'zcode'
      : member.harness === 'qoder' ? 'qoder'
        : member.harness === 'workbuddy' ? 'workbuddy' : 'standard';
}

export class Hub {
  readonly store: Store;
  readonly collaboration: Collaboration;
  readonly limits: Limits;
  private readonly nativeAdapters: Record<string, NativeAdapter>;
  private readonly transcriptCursorKey = randomUUID();
  readonly files: FileStore | null;
  private readonly skillsDir: string | undefined;
  private readonly avatarNames: string[];                 // preset avatar names, read once at start-up
  private readonly avatarNameSet: ReadonlySet<string>;
  private started = false;
  private closed = false;
  private paused = false;
  readonly bridgeHubId: string;
  private readonly secondary: boolean;
  private nativeDelivery: boolean;
  private readonly lastHintCount = new Map<string, string>();   // memberId -> unread breakdown signature last hinted; lost on restart
  // The effective limit settings (docs/hop-limit.md); each changed only after its store write.
  private readonly limitSettings: Record<LimitSetting, { limit: Limit; source: LimitSource }>;
  private readonly externalGuardUntil = new Map<string, number>();
  // Gate plugins (messages.gate) asked before a member's message is stored; set by the composition root once it exists.
  private gate: MessageGate | null = null;
  private memberToolHost: MemberToolHost | null = null;
  private readonly gateRecords = new Map<string, { until: number; repeats: number }>();
  // The coordinator notification settings (docs/collaboration.md); each changed only after its store write.
  private readonly notifySettings: Record<NotifySetting, { value: number; source: 'saved' | 'default' }>;
  /** How long a member holding a task may show no Hub-observed activity; the web setting changes it. */
  stalledAfterMs: number;
  // Unaddressed member messages wait in one window per coordinator so a burst wakes it once. In memory: a restart may
  // wake the queued messages immediately instead (shortcut: persist the window if that turns out to matter).
  // A burst of system notifications waits one short window per conversation before it runs (docs/collaboration.md).
  private readonly noticeWaits = new Map<string, { deadline: number; timer: NodeJS.Timeout }>();
  private readonly running = new Map<string, Running>();
  // Runs of members since moved to another conversation (rebindMember): they still occupy the old conversation until they settle.
  private readonly detached = new Set<Running>();
  private readonly inflight = new Set<Promise<void>>();
  // shortcut: turn timestamps live in memory, so the per-hour limit resets on restart; persist turn starts if that matters
  private readonly turnStarts = new Map<string, number[]>();
  private readonly throttled = new Map<string, NodeJS.Timeout>();
  // The same hour, counted separately: batches of only system notifications (docs/collaboration.md). They never enter
  // turnStarts, and a batch with a member or user message never enters this one.
  private readonly noticeStarts = new Map<string, number[]>();
  private readonly noticeThrottled = new Map<string, NodeJS.Timeout>();
  // Deliveries to native members whose adapter has confirmOnline that may not run before a fresh check says online
  // (delivery id -> member id), and the members with such a check in flight (one at a time per member). In memory only.
  private readonly pending = new Map<string, string>();
  private readonly confirming = new Set<string>();
  private inGrace = false;                           // within startupGraceMs of start()
  private graceTimer: NodeJS.Timeout | undefined;
  // The status each member's last 'member' event carried, and the harnesses with a watchStatus check in flight.
  private readonly shown = new Map<string, Member['status']>();
  private readonly watching = new Set<string>();
  private statusTimer: NodeJS.Timeout | undefined;
  /** Each enabled plugin's background side, by plugin id; one whose construction or start failed is not (or no longer) here. */
  readonly services = new Map<string, PluginService>();
  /** The latest failure of each plugin per phase (docs/plugins.md「故障隔离」), for its settings card. In memory only. */
  private readonly faults = new Map<string, Map<string, PluginFault>>();
  private idleSweep: NodeJS.Timeout | undefined;
  // Quota notices: keys (cluster, harness, window, resetsAt, level) already told, the exhausted window per
  // cluster and harness a recovery notice waits for, the earliest-reset timer and the Claude quota poll.
  // shortcut: in memory, so a restart may repeat one notice; persist it if that turns out to bother coordinators.
  private readonly quotaNotified = new Set<string>();
  // shortcut: in memory, so a restart may repeat a notice; persist if repeat notices become a problem.
  private readonly quotaExhausted = new Map<string, QuotaWindow>();
  private quotaTimer: NodeJS.Timeout | undefined;
  private claudeQuotaTimer: NodeJS.Timeout | undefined;
  private readonly overLimit = new Map<string, number>();   // member id -> the max_turns_per_hour limit last reported for it
  private readonly noticeOverLimit = new Map<string, number>(); // member id -> the max_notice_batches_per_hour limit last reported for it
  // In memory: cooldown per (senderId, recipientId) for proactive failed-delivery notices, and queued notice message -> covered delivery IDs.
  private readonly failedNoticeAt = new Map<string, number>();
  private readonly pendingSenderNotices = new Map<string, string[]>();
  private readonly recoveredFailures: Delivery[] = [];
  // Why a replies member's (Kimi) answers were not posted, until an envelope that says so is delivered.
  // shortcut: in memory, so a restart drops them; persist them if they turn out to matter.
  private readonly replyNotes = new Map<string, string[]>();
  private readonly listeners = new Set<(e: HubEvent) => void>();
  private readonly usage: UsageTracker;
  private readonly activity: ActivityTracker;
  private readonly toolObservations = new ToolObservations();
  private readonly toolList: ToolListMemory | null;
  private activityBridge: ActivityBridge | null = null;
  private readonly addingMembers = new Map<string, number>(); // cluster builds may be in flight before their members have ids in SQLite
  // Bridge streams by "<harness>\n<session id>", shared streams (one for all of a harness's sessions) by harness,
  // and pushes waiting for their ack by delivery id. In memory only.
  private readonly bridges = new Map<string, BridgeConnection>();
  private readonly sharedBridges = new Map<string, BridgeConnection>();
  private readonly acks = new Map<string, { resolve(r: Ack): void; timer: NodeJS.Timeout }>();
  // Deliveries whose bridge promised a later POST /bridge/done (ack with follows), by delivery id; `conn` carried it,
  // into the session of that harness. A done is accepted only for the same harness and session.
  private readonly dones = new Map<string, { conn: BridgeConnection; harness: string; sessionId: string; end(r: DoneResult): void }>();

  /** The BridgePort handed to native adapters. */
  readonly bridge: BridgePort = {
    // A session's own stream, else its harness's shared stream.
    isOnline: (harness, sessionId) => !this.closed && (this.bridges.has(`${harness}\n${sessionId}`) || this.sharedBridges.has(harness)),
    push: (harness, sessionId, deliveryId, text) => {
      const conn = this.closed ? undefined : this.bridges.get(`${harness}\n${sessionId}`) ?? this.sharedBridges.get(harness);
      if (!conn) return Promise.reject(new Error(`${harness} session ${sessionId} has no bridge connected`));
      return new Promise<Ack>((resolve) => {
        const timer = setTimeout(() => {
          this.acks.delete(deliveryId);
          resolve({ ok: false, outcome: 'unknown', error: `bridge did not ack within ${this.limits.bridgeAckMs} ms` });
        }, this.limits.bridgeAckMs);
        this.acks.set(deliveryId, { resolve, timer });
        conn.send({ deliveryId, sessionId, text });
      });
    },
    waitDone: (harness, sessionId, deliveryId, timeoutMs, signal) => {
      const conn = this.closed ? undefined : this.bridges.get(`${harness}\n${sessionId}`) ?? this.sharedBridges.get(harness);
      if (!conn) return Promise.resolve('dropped');
      if (signal.aborted) return Promise.resolve('aborted');
      this.dones.get(deliveryId)?.end('dropped');   // a stale wait for the same id (cannot happen: one run per member)
      return new Promise<DoneResult>((resolve) => {
        const end = (r: DoneResult) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          if (this.dones.get(deliveryId) === entry) this.dones.delete(deliveryId);
          resolve(r);
        };
        const onAbort = () => end('aborted');
        const timer = setTimeout(() => end('timeout'), timeoutMs);
        const entry = { conn, harness, sessionId, end };
        signal.addEventListener('abort', onAbort, { once: true });
        this.dones.set(deliveryId, entry);
      });
    },
  };

  constructor(opts: HubOptions) {
    this.store = opts.store;
    this.bridgeHubId = opts.bridgeHubId ?? randomUUID();
    this.secondary = opts.secondary ?? false;
    this.nativeDelivery = !this.secondary || this.store.getSavedNumber('secondary_native_delivery') === 1;
    this.collaboration = new Collaboration(opts.store, (event) => {
      this.notify(event);
      const payload = event.payload as { action?: string; paused?: boolean; suggested?: boolean };
      for (const [id, service] of this.services) this.guardPlugin(id, 'onEvent', () => service.onEvent?.(event));
      if (payload.action === 'cluster.pause' && !payload.suggested && event.clusterId) {
        for (const member of this.store.listMembers(event.clusterId)) {
          if (payload.paused === true) this.scheduleSession(member);
          else if (payload.paused === false) this.schedule(member.id);
        }
      }
    }, (actor, clusterId, event, notice) => this.collaborationNotification(actor, clusterId, event, notice),
    this, (events) => this.publishSuperseded(events));
    this.activity = new ActivityTracker(opts.store);
    this.nativeAdapters = opts.nativeAdapters;
    this.files = opts.files ? new FileStore(opts.store, opts.files) : null;
    this.skillsDir = opts.skillsDir;
    this.toolList = opts.toolList ?? null;
    this.avatarNames = [...new Set(opts.avatarPresets ?? loadAvatarPresets())].sort();
    this.avatarNameSet = new Set(this.avatarNames);
    const l = opts.limits ?? {};
    this.limits = {
      maxHops: l.maxHops ?? DEFAULT_LIMITS.maxHops,
      maxTurnsPerChain: l.maxTurnsPerChain ?? DEFAULT_LIMITS.maxTurnsPerChain,
      maxTurnsPerHour: l.maxTurnsPerHour ?? DEFAULT_LIMITS.maxTurnsPerHour,
      maxCoordinatorTurnsPerHour: l.maxCoordinatorTurnsPerHour ?? DEFAULT_LIMITS.maxCoordinatorTurnsPerHour,
      maxNoticeBatchesPerHour: l.maxNoticeBatchesPerHour ?? DEFAULT_LIMITS.maxNoticeBatchesPerHour,
      recheckMs: l.recheckMs ?? DEFAULT_LIMITS.recheckMs,
      bridgeAckMs: l.bridgeAckMs ?? DEFAULT_LIMITS.bridgeAckMs,
      startupGraceMs: l.startupGraceMs ?? DEFAULT_LIMITS.startupGraceMs,
      quotaPollMs: l.quotaPollMs ?? DEFAULT_LIMITS.quotaPollMs,
      idleCheckMs: l.idleCheckMs ?? DEFAULT_LIMITS.idleCheckMs,
      idleSweepMs: l.idleSweepMs ?? DEFAULT_LIMITS.idleSweepMs,
      idleNoticeGapMs: l.idleNoticeGapMs ?? DEFAULT_LIMITS.idleNoticeGapMs,
      failedNoticeGapMs: l.failedNoticeGapMs ?? DEFAULT_LIMITS.failedNoticeGapMs,
      idleTaskGraceMs: l.idleTaskGraceMs ?? DEFAULT_LIMITS.idleTaskGraceMs,
      idleMemberGraceMs: l.idleMemberGraceMs ?? DEFAULT_LIMITS.idleMemberGraceMs,
      claudeQuotaPollMs: l.claudeQuotaPollMs ?? DEFAULT_LIMITS.claudeQuotaPollMs,
      queueWarnMs: l.queueWarnMs ?? DEFAULT_LIMITS.queueWarnMs,
      stalledMemberMs: l.stalledMemberMs ?? DEFAULT_LIMITS.stalledMemberMs,
      noticeWindowMs: l.noticeWindowMs ?? DEFAULT_LIMITS.noticeWindowMs,
      messageWindowMs: l.messageWindowMs ?? DEFAULT_LIMITS.messageWindowMs,
    };
    // Saved on the web page > the variable at start-up > the default. getLimit throws on a malformed saved value.
    const effective = (setting: LimitSetting): { limit: Limit; source: LimitSource } => {
      const startup = parseLimit({ kind: 'finite', value: this.limits[setting] });
      if (!startup) throw new Error(`${LIMIT_SETTINGS[setting].env} must be a non-negative safe integer`);
      const saved = this.store.getLimit(setting);
      return saved ? { limit: saved, source: 'saved' } : { limit: startup, source: l[setting] === undefined ? 'default' : 'startup' };
    };
    this.limitSettings = { maxHops: effective('maxHops'), maxTurnsPerChain: effective('maxTurnsPerChain') };
    // Saved on the web page > the start-up default (tests pass Limits). getSavedNumber throws on a malformed saved value.
    const savedSetting = (setting: NotifySetting) => this.store.getSavedNumber(NOTIFY_SETTINGS[setting].key);
    const savedStalled = savedSetting('stalledMemberMinutes');
    this.notifySettings = {
      stalledMemberMinutes: {
        value: savedStalled ?? Math.round(this.limits.stalledMemberMs / 60_000),
        source: savedStalled === null ? 'default' : 'saved',
      },
    };
    this.stalledAfterMs = savedStalled === null ? this.limits.stalledMemberMs : savedStalled * 60_000;
    this.atomically((record) => {
      // Deliveries interrupted by the last stop: their senders are told at start, as after a user's removal.
      for (const d of this.store.recoverRunning()) {
        record(this.store.getMember(d.memberId, { includeRemoved: true })?.clusterId ?? null, d.memberId, 'delivery', { delivery: d });
        this.recoveredFailures.push(d);
      }
    });
    this.usage = new UsageTracker({
      store: this.store, adapters: this.nativeAdapters, pollMs: this.limits.quotaPollMs,
      harnessesInUse: () => [...new Set(this.store.listMembers().map((m) => m.harness))],
      emit: (clusterId, memberId, payload) => {
        if (this.closed) return;
        this.emit(clusterId, memberId, 'usage', payload);
        if ((payload as { quota?: unknown }).quota) this.quotaChanged();
      },
    });
    for (const plugin of this.store.plugins.enabled) {
      if (!plugin.service) continue;
      try {
        const service: unknown = plugin.service(this);
        // A factory answers synchronously: a promise (an async factory) is refused and its rejection caught.
        if (isThenable(service)) throw asyncRefused(service, 'service()');
        if (!service || typeof service !== 'object') throw new Error('service() did not return an object');
        this.services.set(plugin.id, service);
      } catch (e) { this.pluginFault(plugin.id, 'service', e); }
    }
  }

  /**
   * Records a plugin failure for its settings card and logs it once per new text (docs/plugins.md「故障隔离」). Also
   * used by the MCP tool builder and the composition root (a plugin left out at start-up).
   */
  pluginFault(pluginId: string, phase: string, error: unknown): void {
    const text = shortError(error);
    const phases = this.faults.get(pluginId) ?? new Map<string, PluginFault>();
    this.faults.set(pluginId, phases);
    if (phases.get(phase)?.error !== text) console.warn(`plugin ${pluginId} failed in ${phase}: ${text}`);
    phases.set(phase, { phase, error: text, at: new Date().toISOString() });
  }

  /** A plugin's recorded failures, one per phase, oldest phase first. */
  pluginFaults(pluginId: string): PluginFault[] {
    return [...(this.faults.get(pluginId)?.values() ?? [])];
  }

  /**
   * Runs one plugin callback so that neither a synchronous throw nor a promise it hands back and that rejects reaches
   * the Hub: both are recorded as a fault of this phase, then `failed` runs. Timers and promises the plugin starts on its
   * own and does not hand back are outside this (docs/plugins.md「故障隔离」).
   */
  private guardPlugin(pluginId: string, phase: string, run: () => unknown, failed?: () => void): void {
    const fault = (e: unknown) => { this.pluginFault(pluginId, phase, e); failed?.(); };
    try {
      const result = run();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') (result as PromiseLike<unknown>).then(undefined, fault);
    } catch (e) { fault(e); }
  }

  /** A service whose start failed takes no part in anything later; it is closed once to release what it armed. */
  private dropService(pluginId: string, service: PluginService): void {
    if (this.services.get(pluginId) !== service) return;
    this.services.delete(pluginId);
    this.guardPlugin(pluginId, 'close', () => service.close?.());
  }

  /** Begin delivering. Called once the Hub listens. */
  start(): void {
    this.started = true;
    // Nothing queued before this start has a confirmed online state (pending ones were in memory): confirm them all.
    for (const m of this.store.listMembers()) {
      const native = own(this.nativeAdapters, m.harness);
      if (native?.confirmOnline) this.confirmQueued(m, native);
    }
    // Right after a (re)start, Claude bridges have not reconnected yet: an offline member's deliveries wait out the
    // grace instead of ending 'offline'; when it ends, every member is scheduled once more under the normal rule.
    if (this.limits.startupGraceMs > 0) {
      this.inGrace = true;
      this.graceTimer = setTimeout(() => {
        this.inGrace = false;
        this.scheduleAll();
      }, this.limits.startupGraceMs);
    }
    this.scheduleAll();
    if (this.store.coordinator?.disableIfRemoved) {
      const events: HubEvent[] = [];
      const afterCommit: (() => void)[] = [];
      this.store.transaction(() => {
        for (const cluster of this.store.listClusters()) {
          this.store.coordinator!.disableIfRemoved!(this, cluster.id, {
            event: (e) => events.push(e),
            afterCommit: (fn) => afterCommit.push(fn),
          });
        }
      });
      for (const event of events) this.notify(event);
      for (const fn of afterCommit) fn();
    }
    for (const d of this.recoveredFailures.splice(0)) this.notifyFailedSender(d);
    for (const { delivery, noticeId, handled } of this.store.pendingMigrationSenderNotices()) {
      if (!handled) this.notifyFailedSender(delivery, noticeId);
      this.store.completeMigrationSenderNotice(delivery.id);
    }
    for (const [id, service] of [...this.services]) this.guardPlugin(id, 'start', () => service.start?.(), () => this.dropService(id, service));
    this.statusTimer = setInterval(() => {
      this.watchStatus();
      this.warnLongQueues();
    }, this.limits.recheckMs);
    this.statusTimer.unref();
    this.idleSweep = setInterval(() => {
      for (const [id, service] of this.services) this.guardPlugin(id, 'sweep', () => service.sweep?.());
      this.checkQuota();   // retries a quota notice skipped while paused or without a coordinator
      this.store.checkpoint();   // keeps the WAL file small; never throws
    }, this.limits.idleSweepMs);
    this.idleSweep.unref();
    this.armQuotaTimer(Date.now());
    if (this.limits.claudeQuotaPollMs > 0) {
      this.claudeQuotaTimer = setInterval(() => void this.pollClaudeQuota(), this.limits.claudeQuotaPollMs);
      this.claudeQuotaTimer.unref();
    }
    this.usage.start();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.dropActivityBridge();
    this.activity.close();
    for (const t of this.throttled.values()) clearTimeout(t);
    for (const t of this.noticeThrottled.values()) clearTimeout(t);
    this.noticeThrottled.clear();
    for (const w of this.noticeWaits.values()) clearTimeout(w.timer);
    this.noticeWaits.clear();
    clearTimeout(this.graceTimer);
    clearInterval(this.statusTimer);
    clearInterval(this.idleSweep);
    clearTimeout(this.quotaTimer);
    clearInterval(this.claudeQuotaTimer);
    // One failing close stops neither the others nor the Hub's own shutdown; a start that fails later closes nothing again.
    for (const [id, service] of this.services) this.guardPlugin(id, 'close', () => service.close?.());
    this.services.clear();
    for (const r of this.running.values()) r.abort.abort();
    for (const [id, a] of this.acks) {
      clearTimeout(a.timer);
      this.acks.delete(id);
      a.resolve({ ok: false, error: 'hub closing' });
    }
    for (const d of [...this.dones.values()]) d.end('aborted');
    const usageClosed = this.usage.close();
    for (const c of [...this.bridges.values(), ...this.sharedBridges.values()]) c.close();
    this.bridges.clear();
    this.sharedBridges.clear();
    await Promise.allSettled([...this.inflight, usageClosed]);
    let firstError: unknown;
    let failed = false;
    for (const a of Object.values(this.nativeAdapters)) {
      try { await a.close?.(); } catch (e) {
        if (!failed) { firstError = e; failed = true; }
      }
    }
    this.listeners.clear();
    if (failed) throw firstError;
  }

  // ---- events ----

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Announce events a plugin wrote in a committed transaction beyond its command's own event (e.g. other clusters'). */
  publishEvents(events: HubEvent[]): void {
    for (const e of events) this.notify(e);
  }

  private emit(clusterId: string | null, memberId: string | null, kind: HubEvent['kind'], payload: unknown): void {
    this.notify(this.store.appendEvent(clusterId, memberId, kind, payload));
  }

  private notify(e: HubEvent): void {
    if (this.activityBridge && ['cluster', 'member', 'message', 'delivery', 'read', 'acknowledgement'].includes(e.kind)) {
      try { this.refreshActivityBridge(); } catch { /* observation must not change collaboration operations */ }
    }
    for (const fn of this.listeners) {
      try { fn(e); } catch { console.warn(`Hub listener failed after a ${e.kind} event committed`); }
    }
  }

  /**
   * Store writes and the events recording them (`record`), committed in one transaction: a crash leaves neither
   * half. Listeners hear the events only after the commit.
   */
  private atomically(fn: (record: RecordEvent) => void): void {
    const events: HubEvent[] = [];
    this.store.transaction(() => fn((clusterId, memberId, kind, payload) => {
      const event = this.store.appendEvent(clusterId, memberId, kind, payload);
      events.push(event);
      return event;
    }));
    for (const e of events) this.notify(e);
  }

  /** The rows and events were committed together; release pending checks and wake the remaining shared queues. */
  private publishSuperseded(events: HubEvent[]): void {
    const members = new Set<string>();
    for (const event of events) {
      const delivery = (event.payload as { delivery: Delivery }).delivery;
      this.pending.delete(delivery.id);
      members.add(delivery.memberId);
    }
    let firstError: unknown;
    this.publishEvents(events);
    for (const id of members) {
      const member = this.store.getMember(id);
      if (member) try { this.emitMember(member); this.scheduleSession(member); } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  }

  private emitMember(m: StoredMember): void {
    const member = this.withStatus(m);
    const event = this.store.appendEvent(m.clusterId, m.id, 'member', { member });
    this.publishMember(member, event);
  }

  private publishMember(member: Member, event: HubEvent, publishFollowing?: () => void): void {
    const before = this.shown.get(member.id);
    this.shown.set(member.id, member.status);
    this.notify(event);
    publishFollowing?.();   // publish in sequence before status hooks can write more events
    this.notifyMemberStatus(member, before);
  }

  private notifyMemberStatus(member: Member, before: Member['status'] | undefined): void {
    for (const [id, service] of this.services) this.guardPlugin(id, 'onMemberStatus', () => service.onMemberStatus?.(member, before));
  }

  /**
   * A native member whose online state comes from checking the app (adapters with confirmOnline: Codex, Kimi) has no
   * connection that tells the Hub when the app quits or starts, and isOnline only reads a cache. So every recheckMs:
   * one fresh check per such harness (their check is of the app, not of one conversation), then a 'member' event for
   * each of its members whose status differs from the one its last event carried. Bridged members need none of this:
   * a bridge connecting or dropping already sends one (bridgeChanged).
   */
  private watchStatus(): void {
    if (this.closed) return;
    const byHarness = new Map<string, StoredMember[]>();
    for (const m of this.store.listMembers()) {
      if (!own(this.nativeAdapters, m.harness)?.confirmOnline) continue;
      byHarness.set(m.harness, [...(byHarness.get(m.harness) ?? []), m]);
    }
    for (const [harness, members] of byHarness) {
      if (this.watching.has(harness)) continue;
      this.watching.add(harness);
      const p: Promise<void> = this.nativeAdapter(harness).confirmOnline!(members[0].workerSessionId).catch(() => false).then(() => {
        this.watching.delete(harness);
        if (this.closed) return;
        for (const { id } of members) {
          const m = this.store.getMember(id);
          if (m && this.withStatus(m).status !== this.shown.get(id)) this.emitMember(m);
        }
      }).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  // ---- harness discovery ----

  /** Every harness with a (native) adapter. */
  harnesses(): string[] {
    return Object.keys(this.nativeAdapters);
  }

  /**
   * What each harness supports (GET /api/harness-modes): `native` is always true; `nativeCreate`: a member can be a new
   * conversation; `bridgeVersion` (only when known): the app version reported by the harness's connected shared bridge stream.
   */
  harnessModes(): { harness: string; native: true; nativeCreate: boolean; bridgeVersion?: string }[] {
    return this.harnesses().map((harness) => {
      const version = this.sharedBridges.get(harness)?.version;
      return {
        harness,
        native: true,
        nativeCreate: typeof own(this.nativeAdapters, harness)?.createSession === 'function',
        ...(version ? { bridgeVersion: version } : {}),
      };
    });
  }

  private nativeAdapter(harness: unknown): NativeAdapter {
    const a = own(this.nativeAdapters, harness);
    if (!a) throw new Error(`unknown harness ${harness}`);
    return a;
  }

  /** The background-wait settings of a native harness on that route; undefined for every other harness. */
  waitHarness(harness: string): WaitHarness | undefined {
    return own(this.nativeAdapters, harness)?.wait;
  }

  /** The turn-hook settings of a native harness whose app runs orrery's hooks (Cursor); undefined for every other harness. */
  turnHookHarness(harness: string): TurnHookHarness | undefined {
    return own(this.nativeAdapters, harness)?.turnHooks;
  }

  async listProjects(harness: string): Promise<ProjectInfo[]> {
    const projects = await this.nativeAdapter(harness).listProjects();
    return groupedProjects(projects, await projectIdentities(projects.map((p) => p.path)));
  }

  /** Sessions of a project, with their active memberships; `memberId` retains the old first-membership field. */
  async listSessions(
    harness: string, projectPath: string,
  ): Promise<(SessionInfo & { memberId: string | null; memberships: { clusterId: string; clusterName: string; memberId: string; memberName: string; hidden?: true }[]; online: boolean })[]> {
    const adapter = this.nativeAdapter(harness);
    const projects = await adapter.listProjects();
    const paths = [...new Set([projectPath, ...projects.map((p) => p.path)])];
    const identities = await projectIdentities(paths);
    const matching = paths.filter((_, i) => identities[i].key === identities[0].key);
    const listed = (await Promise.all(matching.map((path) => adapter.listSessions(path)))).flat();
    const byId = new Map<string, SessionInfo>();
    for (const session of listed) {
      const previous = byId.get(session.id);
      if (!previous || (session.updatedAt ?? '') > (previous.updatedAt ?? '')) byId.set(session.id, session);
    }
    const sessions = [...byId.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return sessions.map((s) => {
      const members = this.store.getMembersBySession(harness, s.id);
      if (members.length) this.usage.sessionSeen(harness, s);   // fresher title/model for the member list
      return {
        ...s,
        memberId: members[0]?.id ?? null,
        memberships: members.map((m) => ({ clusterId: m.clusterId, clusterName: this.store.getCluster(m.clusterId)!.name,
          memberId: m.id, memberName: m.name, ...(m.hiddenAt ? { hidden: true as const } : {}) })),   // the user's page only
        online: adapter.isOnline(s.id, this.bridge),
      };
    });
  }

  /** Models a new member of this harness can be created with; [] when the adapter cannot list them. */
  async listModels(harness: string): Promise<ModelInfo[]> {
    return (await this.nativeAdapter(harness).listModels?.()) ?? [];
  }

  // ---- clusters and members ----

  /** Every active membership of the member's conversation, itself included. */
  private sessionMembers(m: StoredMember): StoredMember[] {
    return this.store.getMembersBySession(m.harness, m.workerSessionId);
  }

  /** One conversation, whatever clusters it is in: delivery channel, per-hour counts and notice windows are per key. */
  private sessionKey(m: Pick<Member, 'harness' | 'workerSessionId'>): string {
    return JSON.stringify(['native', m.harness, m.workerSessionId]);
  }

  /** Drops a pending system-notice or member-message window (and its timer) for one conversation. */
  private clearNoticeWait(key: string): void {
    const wait = this.noticeWaits.get(key);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.noticeWaits.delete(key);
  }

  /**
   * The per-hour turn limit for the member's next turn: an enabled coordinator of the cluster being scheduled gets
   * the coordinator limit, every other member the ordinary one. Read at each scheduling, so a handover or a disable
   * applies to the very next turn. Counts stay per conversation (sessionKey): one native conversation in several
   * clusters shares one count, and each scheduling of it checks the identity that conversation has in that cluster.
   */
  private hourlyTurnLimit(member: StoredMember): number {
    return this.store.coordinator?.turnLimit(member, this.limits) ?? this.limits.maxTurnsPerHour;
  }

  /** A removed membership can still have an in-flight adapter call until its abort settles. */
  private sessionRun(m: StoredMember): Running | undefined {
    const key = this.sessionKey(m);
    for (const run of [...this.running.values(), ...this.detached]) if (run.sessionKey === key) return run;
    return undefined;
  }

  private sessionRunning(m: StoredMember): boolean {
    return this.sessionRun(m) !== undefined;
  }

  private emitSessionMembers(m: StoredMember): void {
    for (const sibling of this.sessionMembers(m)) this.emitMember(sibling);
  }

  private withStatus(m: StoredMember, starting = false): Member {
    if (m.removedAt) return { ...m, status: 'offline' };
    if (!this.nativeDelivery) return { ...m, status: 'offline', deliveryDisabled: 'secondary' };
    const run = this.running.get(m.id);
    const longWaiting = this.store.countWarnedQueued(m.id) + (run?.waiting && run.queueWarned ? run.deliveries.length : 0);
    const waiting = longWaiting ? { longWaiting } : {};
    const a = own(this.nativeAdapters, m.harness);
    const status = !a ? 'offline' : starting || this.sessionRunning(m) ? 'busy' : a.isOnline(m.workerSessionId, this.bridge) ? 'idle' : 'offline';
    return { ...m, status, ...waiting };
  }

  /** Clusters in creation order, each with its newest message time (docs/architecture.md, GET /api/state). */
  listClusters(): ClusterListing[] {
    return this.store.listClusters();
  }

  listDeletedClusters(): ClusterListing[] {
    return this.store.listClusters(true);
  }

  private clearThrottleTimers(memberId: string): void {
    for (const timers of [this.throttled, this.noticeThrottled]) {
      clearTimeout(timers.get(memberId));
      timers.delete(memberId);
    }
  }

  deleteCluster(id: string): Cluster {
    const members = this.store.listMembers(id);
    const events: HubEvent[] = [];
    const cluster = this.store.transaction(() => {
      const removed = this.store.deleteCluster(id);
      for (const delivery of removed.cancelled) events.push(this.store.appendEvent(id, delivery.memberId, 'delivery', { delivery }));
      events.push(this.store.appendEvent(id, null, 'cluster', { cluster: removed.cluster, members: [] }));
      return removed.cluster;
    });
    for (const member of members) {
      this.toolObservations.remove(member.id);
      this.clearThrottleTimers(member.id);
      for (const [deliveryId, memberId] of this.pending) if (memberId === member.id) this.pending.delete(deliveryId);
    }
    for (const event of events) this.notify(event);
    for (const member of members) this.clearNoticeWait(this.sessionKey(member));
    for (const member of members) this.scheduleSession(member);
    return cluster;
  }

  restoreCluster(id: string): Cluster {
    const events: HubEvent[] = [];
    const afterCommit: (() => void)[] = [];
    const cluster = this.store.transaction(() => {
      const restored = this.store.restoreCluster(id);
      const members = this.store.listMembers(id).map((member) => this.withStatus(member));
      events.push(this.store.appendEvent(id, null, 'cluster', { cluster: restored, members }));
      // The start-up check skips the recycle bin: a coordinator moved out meanwhile (v30) is stopped now.
      this.store.coordinator?.disableIfRemoved?.(this, id, { event: (e) => events.push(e), afterCommit: (fn) => afterCommit.push(fn) });
      return restored;
    });
    for (const event of events) this.notify(event);
    for (const fn of afterCommit) fn();
    return cluster;
  }

  /**
   * Deletes a cluster in the recycle bin for good (POST /api/clusters/:id/purge; only the user's page and API token).
   * The exact name and trash version must match the confirmed listing. Refuses a group with any active member work,
   * including a member still being added.
   * One transaction (Store.purgeCluster); after it, what this Hub keeps in memory for the cluster and its members is
   * dropped (never session-keyed state: one conversation can be a member elsewhere), the Hub's copies of its uploaded
   * files are removed, and the WAL is written back. A file folder that cannot be removed is reported, not rolled back.
   */
  async purgeCluster(id: string, name: unknown, trashVersion: number): Promise<PurgeResult> {
    let purged: ReturnType<Store['purgeCluster']>;
    try {
      purged = this.purgeRows(id, name, trashVersion);
    } catch (e) {
      // The transaction rolled back (nothing was deleted). Plugins whose tables exist but whose clusterPurging did not run
      // this start (revoked, failed to load, safe mode) are named as the likely cause only of a foreign-key failure; any
      // other failure (a loaded plugin's hook, say) keeps its own error and names them at most as a side note.
      const unloaded = e instanceof PurgeRefused ? [] : this.store.unloadedPluginsWithTables();
      if (!unloaded.length) throw e;
      if (isForeignKeyFailure(e)) {
        throw new PurgeRefused('PLUGIN_DATA', `nothing was deleted: ${(e as Error).message}; plugins with tables in this database `
          + `that did not run this start may still hold this cluster's data and are the likely cause: ${unloaded.join(', ')}`, null, unloaded);
      }
      const note = `; besides, plugins with tables in this database that did not run this start may still hold this cluster's data: ${unloaded.join(', ')}`;
      if (e instanceof Error) { e.message += note; throw e; }
      throw new Error(`${String(e)}${note}`);
    }
    return this.afterPurge(id, purged);
  }

  private purgeRows(id: string, name: unknown, trashVersion: number) {
    return this.store.purgeCluster(id, (cluster, memberIds, actualVersion) => {
      if (!cluster) throw new PurgeRefused('NOT_FOUND', `unknown cluster ${id}`);
      if (!cluster.deletedAt) throw new PurgeRefused('NOT_IN_TRASH', 'the cluster is not in the recycle bin (restored?); nothing was deleted');
      if (typeof name !== 'string' || name !== cluster.name) throw new PurgeRefused('NAME_MISMATCH', 'the name does not match the cluster\'s name; nothing was deleted');
      if (trashVersion !== actualVersion) throw new PurgeRefused('TRASH_CHANGED', 'the cluster returned to the recycle bin after this confirmation; nothing was deleted');
      if (this.addingMembers.has(id)) throw new PurgeRefused('ADDING_MEMBERS', 'the cluster is still adding members; nothing was deleted');
      const busy = this.purgeBlocker(memberIds);
      if (busy) throw new PurgeRefused('RUNNING', `member ${busy} still has work running; nothing was deleted, try again once it has ended`, busy);
    });
  }

  private async afterPurge(id: string, purged: ReturnType<Store['purgeCluster']>): Promise<PurgeResult> {
    this.notify(purged.event);
    this.forgetPurged(id, purged.memberIds);
    // Memory only: the cluster is gone either way.
    for (const [pluginId, service] of this.services) this.guardPlugin(pluginId, 'onClusterPurged', () => service.onClusterPurged?.(id, purged.memberIds));
    const filesFailed = this.files ? await this.files.removeFolders(purged.files) : [];
    const remain = this.store.unloadedPluginsWithTables();
    return { clusterId: id, messages: purged.messages, files: purged.files.length, filesFailed, walCheckpointed: this.store.checkpoint(),
      ...(remain.length ? { pluginDataMayRemain: remain } : {}) };
  }

  /** The name of a member of these whose work is still running (a Hub run, a moved member's old run, a running delivery), or null. */
  private purgeBlocker(memberIds: string[]): string | null {
    const ids = new Set(memberIds);
    const busy = [...this.running.values(), ...this.detached].flatMap((run) => run.deliveries.map((d) => d.memberId)).find((m) => ids.has(m))
      ?? this.store.runningDeliveries().find((d) => ids.has(d.memberId))?.memberId;
    return busy === undefined ? null : this.store.getMember(busy, { includeRemoved: true })?.name ?? busy;
  }

  /** Drops what this Hub keeps in memory for a purged cluster and its members. Session-keyed state stays. */
  private forgetPurged(clusterId: string, memberIds: string[]): void {
    const ids = new Set(memberIds);
    for (const id of memberIds) {
      for (const map of [this.lastHintCount, this.shown, this.overLimit, this.noticeOverLimit, this.replyNotes]) map.delete(id);
      this.clearThrottleTimers(id);
      this.toolObservations.remove(id);
      this.activity.forget(id);
      this.toolList?.told(id);
    }
    for (const [deliveryId, memberId] of this.pending) if (ids.has(memberId)) this.pending.delete(deliveryId);
    for (const key of this.failedNoticeAt.keys()) if (key.split('\0').some((id) => ids.has(id))) this.failedNoticeAt.delete(key);
    for (const key of this.quotaNotified) if (JSON.parse(key)[0] === clusterId) this.quotaNotified.delete(key);
    for (const key of this.quotaExhausted.keys()) if (key.startsWith(`${clusterId}\n`)) this.quotaExhausted.delete(key);
    for (const key of this.externalGuardUntil.keys()) if (JSON.parse(key)[1] === clusterId) this.externalGuardUntil.delete(key);
    for (const messageId of this.pendingSenderNotices.keys()) if (!this.store.getMessage(messageId)) this.pendingSenderNotices.delete(messageId);
  }

  listMembers(clusterId?: string, options: { includeRemoved?: boolean } = {}): Member[] {
    return this.store.listMembers(clusterId, options).map((m) => this.withStatus(m));
  }

  /** The MCP layer supplies only memberships resolved by its normal caller authentication. */
  recordToolCall(members: readonly Member[], profile: ToolProfile, meta: unknown, bridge: 'claude' | 'deepseek' | null): void {
    const active = members.filter((member) => this.store.getMember(member.id)?.clusterId === member.clusterId);
    this.toolObservations.record(active.map((member) => member.id), profile, meta, bridge);
  }

  /**
   * The member page's read-only connection line. It asks the adapter's own online check instead of reading
   * withStatus: that status prefers 'busy' while a delivery runs, so a broken connection during a delivery
   * would be shown as online with a check that never ran. The work state stays what it was.
   */
  private connectionReport(m: StoredMember): { state: 'online' | 'offline'; basis: string } {
    if (m.removedAt) return { state: 'offline', basis: '已移出集群' };
    if (!this.nativeDelivery) return { state: 'offline', basis: SECONDARY_OFFLINE_ERROR };
    const a = own(this.nativeAdapters, m.harness);
    if (!a) return { state: 'offline', basis: 'Hub 没有这个 harness 的适配器' };
    return { state: a.isOnline(m.workerSessionId, this.bridge) ? 'online' : 'offline',
      basis: a.confirmOnline ? 'Hub 检查原生应用是否运行' : 'Hub 检查桥或等待通道是否连接' };
  }

  /** Tool fingerprints plus the member page's read-only health data; no new tables and no extra polling. */
  toolVersionReport(): { memberId: string; profile: ToolProfile; profileSource: 'last-call' | 'member-mode'; observation: ToolCallObservation | null;
    connection: { state: 'online' | 'offline'; basis: string; observedAt: string };
    lastProblem: { state: 'failed' | 'offline'; error: string | null; at: string | null; messageId: string } | null }[] {
    const observedAt = new Date().toISOString();
    return this.store.listMembers().map((member) => {
      const observation = this.toolObservations.get(member.id);
      return { memberId: member.id, profile: observation?.profile ?? defaultProfile(member),
        profileSource: observation ? 'last-call' : 'member-mode', observation,
        connection: { ...this.connectionReport(member), observedAt },
        lastProblem: this.store.lastDeliveryProblem(member.id) };
    });
  }

  /**
   * Once at start-up: takes the native members now, and returns what to call with each profile's current tool list
   * once it is known. Those members whose profile's list changed since the last start (and that still exist then) get
   * the tool-update hint in their next envelope; members added meanwhile do not (docs/native-mode.md「工具清单更新提示」).
   */
  checkToolList(): (current: ToolLists) => void {
    const atStart = this.store.listMembers().map((m) => ({ id: m.id, profile: defaultProfile(m) }));
    return (current) => {
      if (this.closed || !this.toolList) return;
      const still = new Set(this.store.listMembers().map((m) => m.id));
      this.toolList.compare(current, atStart.filter((m) => still.has(m.id)));
    };
  }

  /** Latest observation for an active membership, separate from the delivery status. */
  activityFor(memberId: string): ActivitySnapshot {
    if (!this.store.getMember(memberId)) throw new Error('unknown active member');
    return this.activity.snapshot(memberId);
  }

  openActivityObserver(memberId: string, source: string): ActivityObserver {
    if (this.closed) throw new Error('hub is closed');
    return this.activity.open(memberId, source);
  }

  activityReport(clusterId?: string): { members: { memberId: string; activity: ActivitySnapshot }[] } {
    if (clusterId !== undefined && !this.store.getCluster(clusterId)) throw new Error('unknown cluster');
    return { members: this.store.listMembers(clusterId).map((m) => ({ memberId: m.id, activity: this.activityFor(m.id) })) };
  }

  // ---- usage (docs/usage.md) ----

  /** Quota and token counts of a cluster's active members (every active member when clusterId is absent). */
  async usageReport(clusterId?: string): Promise<UsageReport> {
    if (clusterId !== undefined && !this.store.getCluster(clusterId)) throw new Error(`unknown cluster ${clusterId}`);
    const report = await this.usage.report(clusterId ?? null, this.listMembers(clusterId));
    const limits = this.store.getUsageAlert();
    for (const row of report.members) row.alert = usageAlert(row, limits);
    return report;
  }

  getUsageAlert(): { turnTokens: number; conversationTokens: number } { return this.store.getUsageAlert(); }

  setUsageAlert(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('usageAlert must contain two non-negative safe integers');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'conversationTokens,turnTokens'
      || !Number.isSafeInteger(value.turnTokens) || (value.turnTokens as number) < 0
      || !Number.isSafeInteger(value.conversationTokens) || (value.conversationTokens as number) < 0) throw new Error('usageAlert must contain two non-negative safe integers');
    const settings = { turnTokens: value.turnTokens as number, conversationTokens: value.conversationTokens as number };
    let event: HubEvent | undefined;
    this.store.transaction(() => { this.store.setUsageAlert(settings); event = this.store.appendEvent(null, null, 'settings', { usageAlert: settings }); });
    this.notify(event!);
  }

  /** Reads every in-use harness's quota now, asking the sources that cost a request too. Per harness: worked or why not. */
  refreshUsage(): Promise<Record<string, { ok: boolean; error?: string }>> {
    return this.usage.poll(true);
  }

  /** Every active membership of this authenticated conversation. */
  nativeCallers(harness: string, sessionId: string): Member[] {
    return this.closed ? [] : this.store.getMembersBySession(harness, sessionId).map((m) => this.withStatus(m));
  }

  /**
   * One line of numbers when these memberships' unread counts changed since the last hint, else ''. Tool results and
   * the per-tool hook share the record, so one change gives one hint whichever runs first. A pause gives no hint and
   * leaves the record alone. It opens no delivery or turn; the event is how the user sees a hint the chat does not show.
   */
  unreadHint(members: Pick<Member, 'id' | 'clusterId'>[]): string {
    if (this.paused) return '';
    const counted = members.filter((m) => !this.store.clusterPause(m.clusterId).paused && !this.store.getMember(m.id)?.hiddenAt)
      .map((m) => ({ ...m, breakdown: this.store.unreadHintCounts(m.id, m.clusterId) }))
      .map((m) => ({ ...m, signature: JSON.stringify(m.breakdown) }));
    let changed = false;
    for (const m of counted) {
      if (!m.breakdown.total) this.lastHintCount.delete(m.id);
      else if (this.lastHintCount.get(m.id) !== m.signature) changed = true;
    }
    if (!changed) return '';
    const unread = counted.filter((m) => m.breakdown.total);
    let events: HubEvent[];
    try {
      events = this.store.transaction(() => unread.map((m) => this.store.appendEvent(m.clusterId, m.id, 'unread_hint', { count: m.breakdown.total })));
    } catch {
      return '';   // no record, no hint: the next call tries again, and the tool call that worked still reports success
    }
    for (const m of unread) this.lastHintCount.set(m.id, m.signature);
    this.publishEvents(events);
    const clusters = new Set(unread.map((m) => m.clusterId)).size;
    const sum = emptyUnreadBreakdown();
    const keys = ['mention', 'user', 'broadcast', 'taskNotice'] as const;
    const metrics = ['total', 'fyi', 'offline', 'failedOrUnknown', 'blocked'] as const;
    for (const m of unread) {
      sum.total += m.breakdown.total;
      for (const k of keys) for (const f of metrics) sum[k][f] += m.breakdown[k][f];
    }
    return `orrery：${formatUnreadSummary(sum)}，方便时用 read_messages 查看${clusters > 1 ? `，分布在 ${clusters} 个群` : ''}`;
  }

  /** The hint for this conversation if it is a native member; a stranger gets the same '' as an unchanged count. */
  unreadHintFor(harness: string, sessionId: string): string {
    return this.unreadHint(this.nativeCallers(harness, sessionId));
  }

  /**
   * All-or-nothing: if any spec fails, nothing is stored. Sessions already created in the native app stay there.
   * Members attach an existing conversation, or are created when the native adapter can create one.
   */
  async createCluster(name: unknown, specs: unknown): Promise<{ cluster: Cluster; members: Member[] }> {
    const clusterName = checkClusterName(name);
    if (!Array.isArray(specs) || specs.length === 0) throw new Error('a cluster needs at least one member spec');

    const cluster: Cluster = { id: randomUUID(), name: clusterName, createdAt: new Date().toISOString(), category: '', deletedAt: null,
      pinnedAt: null, archivedAt: null, userReadMessageId: null };
    const built = await this.buildMembers(cluster, specs);

    this.store.transaction(() => {
      this.store.insertCluster(cluster, built);
      ensureDefaultRoles(this.store, cluster.id);
      for (const plugin of this.store.plugins.enabled) runHook(plugin, 'clusterCreated', () => plugin.clusterCreated?.(this.store, cluster.id));
    });
    const members = built.map((m) => this.withStatus(m));
    this.emit(cluster.id, null, 'cluster', { cluster, members });
    this.usage.membersAdded();
    for (const m of members) this.shown.set(m.id, m.status);
    return { cluster, members };
  }

  /**
   * The user's changes to a cluster (PATCH /api/clusters/:id): any non-empty subset of
   * - category: the sidebar group, plain text, trimmed, at most MAX_CATEGORY characters, no control characters or
   *   line breaks; '' = ungrouped;
   * - name: a new name, checked like a new cluster's (checkClusterName); read live by listings, MCP and envelopes;
   * - pinned / archived: booleans. Archiving unpins; pinning and archiving at once, or pinning an archived cluster
   *   without unarchiving it in the same request, is refused. Setting a flag that is already set keeps its time.
   * All of it is applied in one transaction with exactly one 'cluster' event (no members: they did not change).
   * Deleted clusters (in the recycle bin) are unknown here.
   */
  updateCluster(id: string, fields: unknown): Cluster {
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new Error('body must be a JSON object');
    const body = fields as Record<string, unknown>;
    const keys = Object.keys(body);
    if (!keys.length || keys.some((k) => !CLUSTER_PATCH_KEYS.has(k))) {
      throw new Error('body must be a non-empty subset of {"category":"<group>","name":"<name>","pinned":<boolean>,"archived":<boolean>}');
    }
    for (const k of ['pinned', 'archived']) {
      if (k in body && typeof body[k] !== 'boolean') throw new Error(`${k} must be a boolean`);
    }
    if (body.pinned === true && body.archived === true) throw new Error('a cluster cannot be pinned and archived at once');
    const changes: ClusterChanges = {};
    if ('category' in body) changes.category = checkCategory(body.category);
    if ('name' in body) changes.name = checkClusterName(body.name);
    let cluster!: Cluster;
    this.atomically((record) => {
      const current = this.store.getCluster(id);
      if (!current) throw new Error(`unknown cluster ${id}`);
      // The group list keeps the group being left and the one entered, so neither disappears when it empties.
      if (changes.category !== undefined && changes.category !== current.category) {
        const groups = this.clusterGroups();
        const next = changes.category && !groups.includes(changes.category) ? createGroup(groups, changes.category) : groups;
        if (JSON.stringify(next) !== JSON.stringify(this.store.getClusterGroups())) {
          this.store.setClusterGroups(next);
          record(null, null, 'settings', { clusterGroups: next });
        }
      }
      const now = new Date().toISOString();
      if (body.archived === true) Object.assign(changes, { archivedAt: current.archivedAt ?? now, pinnedAt: null });
      if (body.archived === false) changes.archivedAt = null;
      if (body.pinned === true) {
        if (current.archivedAt && body.archived !== false) throw new Error('an archived cluster cannot be pinned; unarchive it first');
        changes.pinnedAt = current.pinnedAt ?? now;
      }
      if (body.pinned === false) changes.pinnedAt = null;
      cluster = this.store.updateCluster(id, changes);
      record(cluster.id, null, 'cluster', { cluster, members: [] });
    });
    return cluster;
  }

  // ---- sidebar groups (src/core/cluster-groups.ts; GET/POST/PUT/PATCH/DELETE /api/cluster-groups) ----

  /** The groups in sidebar order: the saved list plus groups active clusters use that it lacks. Never '' (未分组). */
  clusterGroups(): string[] {
    return effectiveGroups(this.store.getClusterGroups(), this.store.listClusters().map((c) => c.category));
  }

  /** A group name: the cluster category rules, and not empty (that is 未分组). */
  private checkGroupName(name: unknown): string {
    const checked = checkCategory(name);
    if (!checked) throw new Error('group name must not be empty');
    return checked;
  }

  /**
   * One change of the group list and the clusters it moves, in one transaction: a 'cluster' event per moved cluster
   * and one 'settings' event { clusterGroups } with the new list. A failure leaves both as they were.
   */
  private changeGroups(change: (groups: string[]) => { groups: string[]; from?: string; to?: string }): string[] {
    let result!: string[];
    this.atomically((record) => {
      const { groups, from, to } = change(this.clusterGroups());
      if (from !== undefined && to !== undefined && from !== to) {
        for (const c of this.store.listClusters()) {
          if (c.category !== from) continue;
          const cluster = this.store.updateCluster(c.id, { category: to });
          record(cluster.id, null, 'cluster', { cluster, members: [] });
        }
      }
      this.store.setClusterGroups(groups);
      record(null, null, 'settings', { clusterGroups: groups });
      result = groups;
    });
    return result;
  }

  createClusterGroup(name: unknown): string[] {
    const checked = this.checkGroupName(name);
    return this.changeGroups((groups) => ({ groups: createGroup(groups, checked) }));
  }

  /** Renames a group and moves every cluster in it (archived and pinned ones too) to the new name. */
  renameClusterGroup(from: unknown, to: unknown): string[] {
    if (typeof from !== 'string') throw new Error('group must be a name');
    const target = this.checkGroupName(to);
    return this.changeGroups((groups) => ({ groups: renameGroup(groups, from, target), from, to: target }));
  }

  /** Deletes a group; its clusters become ungrouped (category ''), nothing else about them changes. */
  deleteClusterGroup(name: unknown): string[] {
    if (typeof name !== 'string') throw new Error('group must be a name');
    return this.changeGroups((groups) => ({ groups: deleteGroup(groups, name), from: name, to: '' }));
  }

  /** `order`: every group, each once, in the new order. */
  reorderClusterGroups(order: unknown): string[] {
    return this.changeGroups((groups) => ({ groups: reorderGroups(groups, order) }));
  }

  /**
   * Moves the user's read position in a cluster to `messageId` (POST /api/clusters/:id/read). Only forward, by the
   * order messages were stored: an older or equal message changes nothing and emits nothing. A change emits one
   * 'cluster' event. The Hub keeps only this position; unread counts are the page's business.
   */
  markClusterRead(id: string, messageId: unknown): Cluster {
    if (typeof messageId !== 'string' || !messageId) throw new Error('messageId must be a message id');
    let cluster!: Cluster;
    this.atomically((record) => {
      const advanced = this.store.advanceUserRead(id, messageId);
      cluster = advanced.cluster;
      if (advanced.changed) record(cluster.id, null, 'cluster', { cluster, members: [] });
    });
    return cluster;
  }

  async addMembers(clusterId: string, specs: unknown): Promise<{ members: Member[] }> {
    const cluster = this.store.getCluster(clusterId);
    if (!cluster) throw new Error(`unknown cluster ${clusterId}`);
    this.addingMembers.set(clusterId, (this.addingMembers.get(clusterId) ?? 0) + 1);
    try {
      const built = await this.buildMembers(cluster, specs);
      this.store.insertMembers(built);
      for (const m of built) this.emitMember(m);
      this.usage.membersAdded();
      return { members: built.map((m) => this.withStatus(m)) };
    } finally {
      const rest = this.addingMembers.get(clusterId)! - 1;
      if (rest) this.addingMembers.set(clusterId, rest);
      else this.addingMembers.delete(clusterId);
    }
  }

  private async buildMembers(cluster: Cluster, specs: unknown): Promise<StoredMember[]> {
    if (!Array.isArray(specs) || specs.length === 0) throw new Error('at least one member spec is required');
    const title = `orrery: ${cluster.name}`;
    const built: StoredMember[] = [];
    const taken = new Set(this.store.listMembers(cluster.id).map((m) => m.name));
    const claimed = new Set<string>();

    for (const spec of specs as MemberSpec[]) {
      // Validate what we can before a session gets created in the native app.
      const mode = spec?.mode;
      if (mode === 'isolated') throw new Error(ISOLATED_REMOVED);
      if (mode !== undefined && mode !== 'native') throw new Error(`invalid mode ${JSON.stringify(mode)}`);
      const native = this.nativeAdapter(spec.harness);
      if (spec.name !== undefined) checkName(spec.name);
      const avatar = checkAvatar(spec.avatar ?? null, this.avatarNameSet);
      const model = checkOption(spec.model, 'model');
      const effort = checkOption(spec.effort, 'effort');
      const attach = spec.sessionId !== undefined;
      if (attach && (model !== undefined || effort !== undefined)) {
        throw new Error('model and effort apply to new sessions only; an attached conversation keeps its own');
      }
      // Before isolated mode was removed, a spec without mode asked for an isolated member (a Hub-run worker): such a
      // request must fail, never quietly become a conversation with the user's own permissions. Attaching names an
      // existing conversation, so only creating needs the explicit mode.
      if (!attach && mode !== 'native') throw new Error(`${ISOLATED_REMOVED}; to create a new conversation of the native app, send mode "native"`);
      if (!attach && !native.createSession) {
        throw new Error(`${spec.harness} native members can only attach an existing conversation`);
      }
      // A new conversation works in the project the user picked; there is no default folder (docs/native-mode.md).
      if (!attach && (typeof spec.projectPath !== 'string' || !spec.projectPath.trim())) {
        throw new Error('projectPath is required for a new conversation: pick a project folder, or attach an existing conversation with sessionId');
      }

      const id = randomUUID();
      const nameFor = (model: string | null) => {
        const base = spec.name ?? defaultName(model, spec.harness);
        let n = base;
        for (let i = 2; taken.has(n); i++) n = `${base}-${i}`;
        taken.add(n);
        return n;
      };
      // A native session created with a chosen model or effort is told its member name in an init turn
      // (docs/native-mode.md), so that name is settled first; otherwise it follows the model the harness reports.
      let memberName = !attach && (model !== undefined || effort !== undefined) ? nameFor(model ?? null) : null;
      let session: { sessionId: string; model: string | null; cwd: string; origin: Member['origin'] };
      let sessionTitle = title;   // a created conversation's title is orrery's; an attached one's is the app's
      if (attach) {
        if (typeof spec.sessionId !== 'string' || !spec.sessionId) throw new Error('sessionId must be a non-empty string');
        const key = `${spec.harness}\n${spec.sessionId}`;
        const existing = this.store.getMembersBySession(spec.harness, spec.sessionId);
        if (claimed.has(key) || existing.some((m) => m.clusterId === cluster.id)) {
          throw new Error(`session ${spec.sessionId} is already a member`);
        }
        claimed.add(key);
        const info = await native.attachSession(spec.sessionId);
        session = { sessionId: info.id, model: info.model, cwd: info.cwd, origin: 'attached' };
        sessionTitle = info.title;
      } else {
        const cwd = resolve(spec.projectPath!);
        const created = await native.createSession!({ cwd, title, model, effort, ...(memberName ? { memberName } : {}) });
        session = { ...created, cwd, origin: 'created' };
      }
      memberName ??= nameFor(session.model);
      this.usage.sessionSeen(spec.harness, { id: session.sessionId, title: sessionTitle, model: session.model });
      built.push({
        id, clusterId: cluster.id, name: memberName, avatar, harness: spec.harness,
        model: session.model, effort: effort ?? null, workerSessionId: session.sessionId, cwd: session.cwd, origin: session.origin, removedAt: null,
        hiddenAt: null,   // the same shape as a member read back from the store (toMember)
      });
    }

    return built;
  }

  removeMember(clusterId: string, memberId: string): Member {
    if (!this.store.getCluster(clusterId)) throw new Error('unknown cluster');
    const events: HubEvent[] = [];
    const afterCommit: (() => void)[] = [];
    const member = this.store.transaction(() => {
      const removed = this.store.removeMember(clusterId, memberId);
      this.store.runMemberRemovedHooks(clusterId, memberId);
      const member = this.withStatus(removed.member);
      for (const delivery of removed.cancelled) {
        this.pendingSenderNotices.delete(delivery.messageId);
        events.push(this.store.appendEvent(clusterId, memberId, 'delivery', { delivery }));
        afterCommit.push(() => this.notifyFailedSender(delivery));
      }
      events.push(this.store.appendEvent(clusterId, memberId, 'member', { member }));
      this.store.coordinator?.disableIfRemoved?.(this, clusterId, {
        event: (e) => events.push(e),
        afterCommit: (fn) => afterCommit.push(fn),
      }, memberId);
      return member;
    });
    // Forget and stop only after the membership, cancellations and their events commit together.
    this.toolObservations.remove(memberId);
    this.clearThrottleTimers(memberId);
    for (const [id, m] of this.pending) if (m === memberId) this.pending.delete(id);
    this.clearNoticeWait(this.sessionKey(member));
    this.overLimit.delete(memberId);
    this.noticeOverLimit.delete(memberId);
    this.replyNotes.delete(memberId);
    // Persist removal before abort: even a synchronous adapter callback now sees an inactive membership.
    this.stopRun(this.running.get(memberId), '成员已移出集群，投递已取消');
    this.shown.set(memberId, member.status);
    for (const event of events) this.notify(event);
    for (const fn of afterCommit) fn();
    this.scheduleSession(member);
    return member;
  }

  /** Aborts a run whose membership or conversation just changed, and answers its push if a bridge has not yet. */
  private stopRun(run: Running | undefined, error: string): void {
    if (!run) return;
    run.abort.abort();
    const ack = this.acks.get(run.batchId);
    if (ack) {
      clearTimeout(ack.timer);
      this.acks.delete(run.batchId);
      ack.resolve({ ok: false, error });
    }
  }

  /**
   * The user moves a native member to an existing conversation of the same harness (POST /api/members/:id/session,
   * docs/cluster-members.md). The member keeps its id, name, roles, unread position and tasks; the old conversation stops
   * being this member at once. Web API only: neither a member nor the coordinator can reach it. The record is the
   * 'member' event's `rebind`; moving, task records, record and notice commit together.
   */
  async rebindMember(memberId: string, input: unknown): Promise<{ member: Member; rebind: MemberRebind }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('body must be an object');
    const { harness, sessionId, confirmStopped } = input as Record<string, unknown>;
    if (confirmStopped !== true) throw new Error('confirmStopped is required: confirm the old conversation has stopped');
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId must be a non-empty string');
    const before = this.store.getMember(memberId);
    if (!before) throw new Error(`unknown member ${memberId}`);
    if (harness !== before.harness) throw new Error(`the new conversation must be of the same harness (${before.harness})`);
    const info = await this.nativeAdapter(before.harness).attachSession(sessionId);
    if (info.id === before.workerSessionId) throw new Error('the member is already bound to this conversation');
    this.usage.sessionSeen(before.harness, info);

    const events: HubEvent[] = [];
    const afterCommit: (() => void)[] = [];
    let publishNotice!: () => void;
    const { member, rebind } = this.store.transaction(() => {
      if (this.store.getMember(memberId)?.workerSessionId !== before.workerSessionId) throw new Error('the member changed meanwhile, try again');
      if (this.store.getMembersBySession(before.harness, info.id).some((m) => m.clusterId === before.clusterId)) {
        throw new Error(`session ${info.id} is already a member of this cluster`);
      }
      for (const plugin of this.store.plugins.enabled) {
        // A throw refuses the move with the plugin's own words; a promise cannot be waited for inside the transaction.
        const answer: unknown = plugin.memberRebinding?.(this.store, before, { harness: before.harness, workerSessionId: info.id });
        if (isThenable(answer)) throw new PluginHookError(plugin.id, 'memberRebinding', asyncRefused(answer, 'memberRebinding'));
      }
      const { member, interrupted } = this.store.rebindMember(memberId, { workerSessionId: info.id, cwd: info.cwd, model: info.model });
      for (const plugin of this.store.plugins.enabled) {
        runHook(plugin, 'memberRebound', () => plugin.memberRebound?.(this.store, before.clusterId, memberId, actorKey(before), actorKey(member)));
      }
      const rebind: MemberRebind = { memberId, memberName: member.name, clusterId: member.clusterId, harness: member.harness,
        fromSessionId: before.workerSessionId, toSessionId: member.workerSessionId, fromCwd: before.cwd, toCwd: member.cwd,
        confirmedStopped: true, at: new Date().toISOString() };
      for (const delivery of interrupted) {
        this.pendingSenderNotices.delete(delivery.messageId);
        events.push(this.store.appendEvent(member.clusterId, memberId, 'delivery', { delivery }));
        afterCommit.push(() => this.notifyFailedSender(delivery));
      }
      const event = this.store.appendEvent(member.clusterId, memberId, 'member', { member: this.withStatus(member), rebind });
      events.push(event);
      publishNotice = this.rebindNotice(member, rebind, interrupted.length, event.seq);
      return { member, rebind };
    });

    // After the commit, as on removal. A late completion of the old run must not touch these results or a new run.
    const run = this.running.get(memberId);
    if (run) {
      this.running.delete(memberId);
      this.detached.add(run);
      this.stopRun(run, '成员已换对话，投递结果未知');
    }
    this.clearThrottleTimers(memberId);   // the per-hour limit counts per conversation
    this.overLimit.delete(memberId);
    this.noticeOverLimit.delete(memberId);
    this.lastHintCount.delete(memberId);   // the new conversation has not been told, even if the count is the same
    for (const event of events) this.notify(event);
    publishNotice();   // schedules the member: its queued deliveries now go to the new conversation (or end offline there)
    for (const fn of afterCommit) fn();
    this.emitMember(member);   // last: the page drops events that arrive out of seq order
    return { member: this.withStatus(member), rebind };
  }

  /** The member's moves to another conversation, oldest first (GET /api/members/:id/session-history). */
  memberRebinds(memberId: string): (MemberRebind & { eventId: number })[] {
    if (!this.store.getMember(memberId, { includeRemoved: true })) throw new Error(`unknown member ${memberId}`);
    return this.store.memberRebinds(memberId);
  }

  /**
   * In-process read for trusted consumers. Only the member's active native binding supplies the session id.
   * A transcript read does not produce a Hub event or write to the Store.
   */
  async memberTranscript(memberId: string, request: TranscriptRequest = {}): Promise<TranscriptPage> {
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some((name) => name !== 'direction' && name !== 'limit' && name !== 'cursor')) {
      return emptyTranscriptPage('refused');
    }
    const { cursor, direction, limit = TRANSCRIPT_MAX_ITEMS } = request;
    if ((direction !== undefined && direction !== 'before' && direction !== 'after')
      || !Number.isSafeInteger(limit) || limit < 1) return emptyTranscriptPage('refused');
    if (typeof memberId !== 'string' || !memberId || this.closed) return emptyTranscriptPage('missing');

    const member = this.store.getMember(memberId);   // excludes removed memberships and deleted clusters
    if (!member || !member.workerSessionId) return emptyTranscriptPage('missing');
    const adapter = own(this.nativeAdapters, member.harness);
    if (!adapter?.transcript) return emptyTranscriptPage('unsupported');
    const bindingOf = (m: StoredMember) =>
      JSON.stringify([m.id, m.clusterId, m.harness, m.workerSessionId, this.store.memberBindingVersion(m.id)]);
    const binding = bindingOf(member);
    let nativeCursor: string | undefined;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 4096) return emptyTranscriptPage('reset');
      const opened = openTranscriptCursor(this.transcriptCursorKey, binding, cursor);
      if (!opened) return emptyTranscriptPage('reset');
      nativeCursor = opened;
    }

    let page: TranscriptPage;
    try {
      page = await adapter.transcript(member.workerSessionId, { cursor: nativeCursor, direction, limit: Math.min(limit, TRANSCRIPT_MAX_ITEMS) });
    } catch {
      // Adapter exceptions can contain native paths or content.
      page = emptyTranscriptPage('refused');
    }
    if (this.closed) return emptyTranscriptPage('missing');
    const current = this.store.getMember(memberId);
    if (!current) return emptyTranscriptPage('missing');
    if (bindingOf(current) !== binding) return emptyTranscriptPage('reset');
    if (page.status !== 'ok') return emptyTranscriptPage(page.status);
    return { ...page, items: attributeTranscript(this.store, current, page.items),
      before: page.before === undefined ? undefined : transcriptCursor(this.transcriptCursorKey, binding, page.before),
      after: page.after === undefined ? undefined : transcriptCursor(this.transcriptCursorKey, binding, page.after) };
  }

  /**
   * The handover package of a member (GET /api/members/:id/handover, docs/cluster-members.md「交接包」): the user's
   * recent requests, the member's tasks with their records, and its recent failed deliveries. Read-only and derived
   * from records only; sending it and moving the member stay explicit user actions in the page.
   */
  handover(memberId: string): HandoverPackage {
    const member = this.store.getMember(memberId, { includeRemoved: true });
    if (!member) throw new Error(`unknown member ${memberId}`);
    const cluster = this.store.getCluster(member.clusterId);
    if (!cluster) throw new Error(`unknown cluster ${member.clusterId}`);
    const tasks = this.store.tasks?.memberTasks(cluster.id, member.id, HANDOVER.tasks) ?? { facts: [], omitted: 0 };
    return handoverPackage({
      member, cluster, generatedAt: new Date().toISOString(),
      // A sent handover package, a delivery handoff and a resend are user messages too, but not user requests. A task
      // comment the user wrote is a request, so only those synthetic kinds are excluded (not `kind: 'chat'`).
      requests: this.store.listMessages(cluster.id, HANDOVER.requests, undefined,
        { senderId: 'user', excludeKinds: ['handover', 'handoff', 'resend'] }),
      tasks: tasks.facts,
      tasksOmitted: tasks.omitted,
      deliveries: this.store.recentDeliveryProblems(member.id, HANDOVER.deliveries),
    });
  }

  /**
   * The group-chat record of a move, written inside rebindMember's transaction: it wakes the member and the enabled
   * coordinator, with the tasks in the member's hands. A moved coordinator also gets the handover summary.
   */
  private rebindNotice(member: StoredMember, rebind: MemberRebind, interrupted: number, sourceEventId: number): () => void {
    // A hidden member's move writes no chat notice: it could only describe an unseen member, and it would not reach the
    // member anyway (the brief on showing tells it what it holds). The member event's `rebind` keeps the record.
    if (member.hiddenAt) return () => this.scheduleSession(member);
    const moved = this.store.coordinator?.rebound(member, this.paused) ?? { alsoTell: null, lines: [], taskIds: [] };
    const view = this.store.tasks;
    const tasks = (view?.all(member.clusterId) ?? []).filter((task) => task.proposalState === 'active');
    const executing = tasks.filter((task) => ['pending', 'working', 'review'].includes(task.status) && task.assignedMemberId === member.id);
    const reviewing = tasks.filter((task) => task.status === 'review' && task.reviewer.kind === 'member' && task.reviewer.memberId === member.id);
    const list = (items: Task[]) => (items.length ? items.map((task) => `- 任务${task.number ? ` #${task.number}` : ''}【${task.title}】（${task.id}，${OPEN_STATUS_LABEL[task.status]}）`) : ['- 无']);
    const who = personName(this.store, member.clusterId, member.id);
    const lines = [
      `用户把 ${who} 换到了新对话，并已确认原对话停止。成员身份、角色、${view ? '未读和任务' : '未读'}都没有变。`,
      `原对话：${rebind.fromSessionId}（${rebind.fromCwd}）`,
      `新对话：${rebind.toSessionId}（${rebind.toCwd}）`,
      ...(interrupted ? [`原对话有 ${interrupted} 条在途投递，结果记为未知，这些消息仍算 ${who} 未读。`] : []),
      ...(view ? ['', `${who} 手上的任务：`, '执行：', ...list(executing), '', '验收：', ...list(reviewing), '',   // blank lines: the page renders Markdown
        '原对话的上下文不会带过来：请用 get_task 查看任务详情和已有进度，接着推进。'] : ['', '原对话的上下文不会带过来。']),
    ];
    lines.push(...moved.lines);
    return this.writeSystemMessage(member.clusterId, moved.alsoTell ? [member.id, moved.alsoTell] : [member.id], lines.join('\n'),
      [...new Set([...executing, ...reviewing].map((task) => task.id).concat(moved.taskIds))], sourceEventId, 'rebind');
  }

  updateMember(id: string, fields: { name?: unknown; avatar?: unknown }): Member {
    const { member, event, publishNotice } = this.store.transaction(() => {
      const m = this.store.getMember(id);
      if (!m) throw new Error(`unknown member ${id}`);
      const name = fields.name === undefined || fields.name === m.name ? undefined : checkName(fields.name);
      const peers = name === undefined ? [] : this.store.listMembers(m.clusterId);
      if (peers.some((peer) => peer.name === name)) {
        throw new Error(`name ${name} is already used in this cluster`);
      }
      const avatar = fields.avatar === undefined ? undefined : checkAvatar(fields.avatar, this.avatarNameSet);
      const member = this.withStatus(this.store.updateMember(id, { name, avatar }));
      const event = this.store.appendEvent(m.clusterId, id, 'member', { member });
      // Chat history is shared, so a hidden member's rename is recorded only in its member event.
      const publishNotice = name !== undefined && !m.hiddenAt ? this.collaborationNotification({ kind: 'user' }, m.clusterId, event, {
        recipients: peers.filter((peer) => !peer.hiddenAt).map((peer) => peer.id), wake: [], systemKind: 'member_renamed',
        body: `成员「${m.name}」已改名为「${name}」。\nMember “${m.name}” was renamed to “${name}”.`,
      }) : undefined;
      return { member, event, publishNotice };
    });
    this.publishMember(member, event, publishNotice);
    return member;
  }

  // ---- hidden members (docs/cluster-members.md「隐身」) ----

  /** Whether `viewerId` ('user' or a member id) sees the cluster's hidden members: only the user and the enabled coordinator do. */
  seesHidden(clusterId: string, viewerId: string): boolean {
    if (viewerId === 'user') return true;
    const policy = this.store.coordinator?.policy(clusterId);
    return !!policy?.enabled && policy.memberId === viewerId;
  }

  /** `members` as `viewerId` may see them: without the hidden ones unless it is the user or the enabled coordinator. */
  visibleMembers<T extends Pick<StoredMember, 'hiddenAt'>>(clusterId: string, viewerId: string, members: T[]): T[] {
    return this.seesHidden(clusterId, viewerId) ? members : members.filter((m) => !m.hiddenAt);
  }

  /** The user hides or shows a member (POST /api/members/:id/hidden). */
  setMemberHidden(memberId: string, hidden: unknown): Member {
    if (typeof hidden !== 'boolean') throw new Error('hidden must be a boolean');
    const events: HubEvent[] = [];
    const { member, after } = this.store.transaction(() => this.applyHidden(memberId, hidden, (e) => events.push(e)));
    this.publishHidden(events, after);
    return this.withStatus(member);
  }

  /**
   * Hides or shows a member inside the caller's transaction (the user's route above, or the coordinator's
   * `member.hidden` collaboration action): its unstarted deliveries are superseded, a running turn goes on. Only page
   * events record it: no chat message says that someone was hidden or shown. `after` runs once the transaction commits.
   */
  applyHidden(memberId: string, hidden: boolean, record: (event: HubEvent) => void): { member: StoredMember; after: () => void } {
    const before = this.store.getMember(memberId);
    if (!before) throw new Error(`unknown member ${memberId}`);
    const policy = this.store.coordinator?.policy(before.clusterId);
    if (hidden && policy?.enabled && policy.memberId === memberId) {
      throw new Error(`${before.name} is the coordinator and cannot be hidden: change or disable the coordinator first`);
    }
    if (hidden === Boolean(before.hiddenAt)) return { member: before, after: () => {} };
    const { member, superseded } = this.store.setMemberHidden(memberId, hidden, HIDDEN_DELIVERY_REASON);
    for (const delivery of superseded) record(this.store.appendEvent(member.clusterId, memberId, 'delivery', { delivery }));
    const event = this.store.appendEvent(member.clusterId, memberId, 'member', { member: this.withStatus(member), hidden });
    record(event);
    // Shown again: one wake-up with what it holds now (nothing from the hidden period is replayed). Written after the
    // unread start moved to now, so it is the first unread message; an ordinary notice, so offline and the loop guards apply.
    const brief = hidden ? null : this.store.tasks?.heldBrief?.(member.clusterId, memberId, before.hiddenAt);
    const publishBrief = brief ? this.writeSystemMessage(member.clusterId, [memberId], brief.body, brief.taskIds, event.seq, 'member_shown') : null;
    return { member, after: () => {
      publishBrief?.();
      for (const d of superseded) {
        this.pending.delete(d.id);   // an online check still out for it no longer matters
        this.pendingSenderNotices.delete(d.messageId);
      }
      this.lastHintCount.delete(memberId);
      this.scheduleSession(member);   // a shared conversation's other bindings may go on
    } };
  }

  private publishHidden(events: HubEvent[], after: () => void): void {
    try { for (const event of events) this.notify(event); } finally { after(); }
  }

  // ---- bridges (Hub side of the bridge protocol, docs/native-mode.md) ----

  /**
   * Registers a bridge stream for one session, or with sessionId null the harness's shared stream (all its sessions).
   * A newer one for the same key replaces (and closes) the older. Returns the disconnect.
   */
  connectBridge(harness: string, sessionId: string | null, conn: BridgeConnection): () => void {
    const [map, key] = sessionId === null ? [this.sharedBridges, harness] : [this.bridges, `${harness}\n${sessionId}`];
    const old = map.get(key);
    if (harness === 'deepseek' && sessionId === null) {
      this.dropActivityBridge();
      if (conn.sendActivity) this.activityBridge = { conn, observerId: '', signature: null, sessions: new Map() };
    }
    map.set(key, conn);
    if (old) this.dropDones(old);
    old?.close();
    this.bridgeChanged(harness, sessionId);
    if (this.activityBridge?.conn === conn) {
      try { this.refreshActivityBridge(); } catch { /* an observation channel must not affect delivery */ }
    }
    return () => {
      this.dropDones(conn);
      if (map.get(key) !== conn) return;
      if (this.activityBridge?.conn === conn) this.dropActivityBridge();
      map.delete(key);
      this.bridgeChanged(harness, sessionId);
    };
  }

  /** Revoke the whole observation epoch when the set of eligible memberships changes. */
  private refreshActivityBridge(): void {
    const bridge = this.activityBridge;
    if (!bridge || this.closed || this.sharedBridges.get('deepseek') !== bridge.conn) return;
    const eligible = this.store.listMembers().filter((m) => m.harness === 'deepseek'
      && this.store.hasActivityParticipation(m.id));
    const signature = JSON.stringify(eligible.map((m) => [m.id, m.workerSessionId]).sort());
    if (signature === bridge.signature) return;
    for (const session of bridge.sessions.values()) for (const member of session.members.values()) member.observer.close();
    bridge.sessions.clear();
    bridge.observerId = randomUUID();
    bridge.signature = null;
    try {
      for (const member of eligible) {
        let session = bridge.sessions.get(member.workerSessionId);
        if (!session) bridge.sessions.set(member.workerSessionId, session = { seq: 0, event: null, members: new Map() });
        session.members.set(member.id, { observer: this.openActivityObserver(member.id, 'deepseek'), seq: 0 });
      }
      bridge.conn.sendActivity!({ observerId: bridge.observerId, sessions: [...bridge.sessions.keys()] });
      bridge.signature = signature;
    } catch {
      for (const session of bridge.sessions.values()) for (const member of session.members.values()) member.observer.close();
      bridge.sessions.clear();
    }
  }

  private dropActivityBridge(): void {
    const bridge = this.activityBridge;
    this.activityBridge = null;
    if (bridge) for (const session of bridge.sessions.values()) for (const member of session.members.values()) member.observer.close();
  }

  /** The activity source is fixed by this bridge, never supplied by a model or by the request body. */
  recordBridgeActivity(observerId: string, sessionId: string, seq: number, value: unknown): boolean {
    const bridge = this.activityBridge;
    if (!bridge || this.closed || bridge.conn !== this.sharedBridges.get('deepseek') || bridge.observerId !== observerId) return false;
    const session = bridge.sessions.get(sessionId);
    if (!session || !Number.isSafeInteger(seq) || seq < 0 || seq < session.seq) return false;
    const event = seq === 0 ? null : normalizeActivity(value);
    if ((seq === 0 && value !== null) || (seq > 0 && !event)) return false;
    try {
      const eligible = this.store.getMembersBySession('deepseek', sessionId)
        .filter((m) => this.store.hasActivityParticipation(m.id)).map((m) => m.id).sort();
      if (JSON.stringify(eligible) !== JSON.stringify([...session.members.keys()].sort())) {
        this.refreshActivityBridge();
        return false;
      }
      if (seq > session.seq) {
        session.seq = seq;
        session.event = event;
      }
      let accepted = true;
      for (const member of session.members.values()) {
        if (seq > member.seq && session.event) {
          if (member.observer.record(session.event)) member.seq = seq;
          else accepted = false;
        } else if (!member.observer.heartbeat()) accepted = false;
      }
      return accepted;
    } catch {
      return false;
    }
  }

  /**
   * A bridge's receipt for a push. False when no push is waiting for it (unknown, timed out or already acked).
   * `follows`: the bridge will also report the end of the turn the delivery starts (POST /bridge/done).
   */
  ackBridge(deliveryId: string, ok: boolean, error?: string, follows = false): boolean {
    const pending = this.acks.get(deliveryId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.acks.delete(deliveryId);
    pending.resolve(ok ? (follows ? { ok: true, follows: true } : { ok: true }) : { ok: false, error: (error || 'bridge reported a failure').slice(0, ACK_ERROR_MAX) });
    return true;
  }

  /**
   * A bridge's report that the turn a delivery started has ended, in the session of the harness it was delivered into.
   * False when nothing waits for it, or the delivery went to another harness or session (ignored either way).
   */
  doneBridge(deliveryId: string, harness: string, sessionId: string, usage?: unknown, result?: Extract<BridgeDoneResult, object>): boolean {
    const pending = this.dones.get(deliveryId);
    // The tokens the turn used (the DSH plugin reports them): stored under the delivery's batch, like ctx.usage.
    if (usage !== undefined && pending && pending.harness === harness && pending.sessionId === sessionId) {
      const delivery = this.store.getDelivery(deliveryId);
      const member = delivery ? this.store.getMember(delivery.memberId) : null;
      if (member) this.usage.recordTurn(member, deliveryId, usage);
    }
    if (!pending || pending.harness !== harness || pending.sessionId !== sessionId) return false;
    pending.end(result ?? 'done');
    return true;
  }

  /** A loop-guard notice raised outside the scheduler (the ZCode wait limits, src/mcp/zcode.ts) on each membership of the session. */
  guardSession(harness: string, sessionId: string, payload: { reason: string } & Record<string, unknown>): void {
    if (this.closed) return;
    for (const m of this.store.getMembersBySession(harness, sessionId)) this.emit(m.clusterId, m.id, 'guard', payload);
  }

  /** The stream that carried these deliveries is gone: nobody will report their turns' end. */
  private dropDones(conn: BridgeConnection): void {
    for (const d of [...this.dones.values()]) if (d.conn === conn) d.end('dropped');
  }

  /** sessionId null: the harness's shared stream changed, which concerns every native member of that harness. */
  private bridgeChanged(harness: string, sessionId: string | null): void {
    if (this.closed) return;
    const members = sessionId === null
      ? this.store.listMembers().filter((m) => m.harness === harness)
      : this.store.getMembersBySession(harness, sessionId);
    for (const m of members) {
      this.emitMember(m);
      this.schedule(m.id);   // a stream that just connected gets the member's queued deliveries right away
    }
  }

  // ---- messages ----

  /**
   * Member ids @-mentioned in `body`: full cluster names only, case-sensitive, `all` = everyone (mentionAt). A name
   * must be followed by the end, whitespace or punctuation (`@张三 你好`, `@张三，`, `@A.`); a letter or digit of any
   * script continues it (`@张三你好`, `@A1`, `@A.v2` mention nobody).
   * `unresolved` keeps the names that matched no member, in first-seen order, for send_message's report.
   */
  private parseMentions(body: string, members: StoredMember[]): { ids: string[]; all: boolean; unresolved: string[] } {
    const byName = new Map<string, string>(members.map((m) => [m.name, m.id]));
    byName.set('all', 'all');   // 'all' is a reserved member name (checkName)
    // @ inside inline code, fenced code or quotes is quoted text, not a mention. A backslash escapes the
    // next character inside western quotes (so \" does not close them).
    const masked: [number, number][] = [];
    const closing: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' };
    for (let index = 0; index < body.length;) {
      if (body.startsWith('```', index)) {
        const end = body.indexOf('```', index + 3);
        const stop = end < 0 ? body.length : end + 3;
        masked.push([index, stop]); index = stop; continue;
      }
      if (body[index] === '`') {
        const end = body.indexOf('`', index + 1);
        const stop = end < 0 ? body.length : end + 1;
        masked.push([index, stop]); index = stop; continue;
      }
      const open = body[index];
      const close = closing[open];
      if (close) {
        let cursor = index + 1;
        while (cursor < body.length && body[cursor] !== close) {
          if (close === '"' || close === "'") {
            if (body[cursor] === '\\' && cursor + 1 < body.length) { cursor += 2; continue; }
            if (body[cursor] === '\n') break;
          }
          cursor++;
        }
        if (cursor < body.length && body[cursor] === close) { masked.push([index, cursor + 1]); index = cursor + 1; continue; }
      }
      index++;
    }
    const inQuoted = (index: number) => masked.some(([start, end]) => index >= start && index < end);
    const ids = new Set<string>();
    const unresolved = new Set<string>();
    let all = false;
    for (let i = body.indexOf('@'); i >= 0; i = body.indexOf('@', i + 1)) {
      if (inQuoted(i)) continue;
      if (i > 0 && /[A-Za-z0-9]/.test(body[i - 1])) continue;   // foo@bar is not a mention
      const name = mentionAt(body, i, byName.keys());
      if (name === 'all') all = true;
      else if (name !== null) ids.add(byName.get(name)!);
      else {
        const written = unresolvedName(body, i + 1);
        if (written) unresolved.add(written);
      }
    }
    return { ids: [...ids], all, unresolved: [...unresolved] };
  }

  /**
   * Without `to`, recipients are the @-mentions in `body` (`@all` = everyone); an unaddressed message with no
   * mention candidate goes to the enabled coordinator, if any. With `to` (member ids of this
   * cluster), exactly those members get it and the body is not parsed; any invalid id rejects the whole message.
   * `to` = exactly one native member (its member page) delivers the body as typed, without the envelope.
   * `kind: 'handover'` marks a handover package send: it is a user message, but the package's own "user requests"
   * section excludes it (and delivery handoffs) so a sent package never becomes the cluster's goal.
   */
  sendFromUser(clusterId: string, body: unknown, to?: unknown, attachments?: unknown, taskIds?: unknown, kind?: 'handover'): Message {
    if (typeof body !== 'string') throw new Error('body is required');
    if (!this.store.getCluster(clusterId)) throw new Error(`unknown cluster ${clusterId}`);
    const files = this.checkAttachments(clusterId, attachments);
    if (!body.trim() && !files.length) throw new Error('body is required');
    const members = this.store.listMembers(clusterId);
    let mentions: string[];
    if (to === undefined) {
      const { ids, all } = this.parseMentions(body, members);
      mentions = all ? members.filter((m) => !m.hiddenAt).map((m) => m.id) : ids;   // @all does not include a hidden member
    } else {
      if (!Array.isArray(to) || to.length === 0 || !to.every((id) => typeof id === 'string') || new Set(to).size !== to.length) {
        throw new Error('to must be a non-empty array of distinct member ids');
      }
      const bad = to.find((id) => !members.some((m) => m.id === id));
      if (bad !== undefined) throw new Error(`member ${JSON.stringify(bad)} is not in this cluster`);
      mentions = to;
    }
    const linkedTaskIds = this.checkTaskIds(clusterId, taskIds);
    const direct = linkedTaskIds.length === 0 && to !== undefined && mentions.length === 1;
    const fallback = to === undefined && mentions.length === 0 ? this.store.coordinator?.unaddressedRecipient({ clusterId, from: 'user', body, members }) : null;
    const recipients = fallback ? [fallback] : mentions;
    const id = randomUUID();
    return this.post({ id, clusterId, from: 'user', mentions, body, replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString(),
      ...(kind ? { kind } : {}) }, recipients, direct, files, linkedTaskIds);
  }

  /** Called by the external broker after it authenticates the plugin and validates the write grant and cause. */
  sendFromExternalPlugin(pluginId: string, clusterId: string, body: string, cause: Message | null, mentionEnabled: boolean) {
    const id = randomUUID();
    const chainId = cause?.chainId ?? id;
    const hop = cause ? cause.hop + 1 : 0;
    const { limit } = this.limitSettings.maxHops;
    if (limit.kind === 'finite' && hop > limit.value) {
      this.externalPluginGuard(pluginId, clusterId, 'max_hops', { chainId, hop, maxHops: limit.value });
      throw new Error('plugin message exceeds the chain hop limit');
    }

    const members = mentionEnabled ? this.store.listMembers(clusterId).filter((m) => !m.hiddenAt) : [];
    const { ids: recipients, all } = mentionEnabled ? this.parseMentions(body, members) : { ids: [], all: false };
    const mentions = all ? members.map((member) => member.id) : recipients;
    const message = this.post({
      id, clusterId, from: externalPluginSender(pluginId), kind: 'plugin', body, mentions, replyTo: cause?.id ?? null,
      chainId, hop, createdAt: new Date().toISOString(), ...(all ? { explicitMentions: recipients } : {}),
    }, recipients, false, [], [], undefined, pluginId);
    return { messageId: message.id, deliveredTo: recipients.map((id) => members.find((member) => member.id === id)!.name) };
  }

  private externalPluginGuard(pluginId: string, clusterId: string | null, reason: string, details: Record<string, unknown>, intervalMs = 60_000): boolean {
    // Denied requests can arrive faster than accepted messages. Bound their guard rows as well as chat warnings.
    const key = JSON.stringify([pluginId, clusterId, reason, details.window]);
    const now = Date.now();
    if (now < (this.externalGuardUntil.get(key) ?? 0)) return false;
    this.externalGuardUntil.set(key, now + intervalMs);
    this.notify(this.store.appendEvent(clusterId, null, 'guard', { reason, pluginId, ...details }));
    return true;
  }

  /** A broker rate warning is visible to the user but cannot wake a member or trigger the source plugin. */
  externalPluginRateNotice(pluginId: string, clusterId: string, window: 'minute' | 'hour', limit: number): void {
    if (!this.externalPluginGuard(pluginId, clusterId, 'external_plugin_rate_limit', { window, limit }, window === 'minute' ? 60_000 : 3_600_000)) return;
    const id = randomUUID();
    const interval = window === 'minute' ? '每分钟' : '每小时';
    const body = `插件「${pluginId}」达到发送上限（${interval} ${limit} 条），暂未发送新消息。`;
    this.post({ id, clusterId, from: 'system', kind: 'system', systemKind: 'plugin_rate_limit', body, mentions: [], replyTo: null, chainId: id, hop: 0,
      createdAt: new Date().toISOString() }, [], false, [], [], undefined, pluginId);
  }

  /**
   * A plugin's published events went over its per-minute cap. Like the send notice: a guard record and a chat notice
   * without recipients in the cluster the refused event named, at most once a minute per plugin and cluster; it wakes
   * nobody and is not sent back to that plugin. A global event has no chat to show it in: the guard record and a log line.
   */
  externalPluginPublishLimit(pluginId: string, clusterId: string | null, limit: number): void {
    if (!this.externalPluginGuard(pluginId, clusterId, 'external_plugin_publish_rate_limit', { window: 'minute', limit })) return;
    if (!clusterId || !this.store.getCluster(clusterId)) {
      console.warn(`external plugin ${pluginId} reached its event publish limit (${limit} a minute); events over it were refused`);
      return;
    }
    const id = randomUUID();
    const body = `插件「${pluginId}」发布事件达到上限（每分钟 ${limit} 条），超出上限的事件被拒绝，没有转发给其他插件。`;
    this.post({ id, clusterId, from: 'system', kind: 'system', systemKind: 'plugin_rate_limit', body, mentions: [], replyTo: null, chainId: id, hop: 0,
      createdAt: new Date().toISOString() }, [], false, [], [], undefined, pluginId);
  }

  /**
   * A third-party plugin failed and is restarted automatically ('restart'), or its automatic restarts ran out
   * ('gave-up'): one system record in each of its existing clusters (the gate records' mechanism: no recipient, wakes
   * nobody, not sent to that plugin), at most one per plugin, cluster and kind a minute, the repeats counted in the next.
   * A plugin with no cluster gets a log line only.
   */
  externalPluginRestartRecord(pluginId: string, clusterIds: readonly string[], kind: 'restart' | 'gave-up', text: string): void {
    const existing = clusterIds.filter((id) => this.store.getCluster(id));
    if (!existing.length) console.warn(`external plugin ${pluginId}: ${kind === 'restart' ? 'restarting after a failure' : 'automatic restarts used up'}`);
    for (const clusterId of existing) {
      this.gateRecord(`${kind}:${pluginId}:${clusterId}`, PLUGIN_RESTART_RECORD_MS, clusterId, pluginId, text, 'plugin_restarted', kind === 'restart' ? '次自动重启' : '条同类记录');
    }
  }

  /** A user explicitly hands one unsuccessful or uncertain delivery to another member. */
  handoffDelivery(clusterId: string, deliveryId: string, input: unknown): { message: Message; sourceDelivery: Delivery } {
    if (!this.store.getCluster(clusterId)) throw new Error('unknown cluster');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('handoff body must be an object');
    const { targetMemberId, note, confirmStopped } = input as Record<string, unknown>;
    if (typeof targetMemberId !== 'string' || !targetMemberId) throw new Error('targetMemberId is required');
    if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) throw new Error('note must be a string of at most 4000 characters');
    if (confirmStopped !== undefined && typeof confirmStopped !== 'boolean') throw new Error('confirmStopped must be a boolean');

    const source = this.store.getDelivery(deliveryId);
    const original = source && this.store.getMessage(source.messageId);
    if (!source || !original || original.clusterId !== clusterId) throw new Error('unknown delivery in this cluster');
    if (source.handoffMessageId) {
      const message = this.store.getMessage(source.handoffMessageId);
      if (!message || message.clusterId !== clusterId || message.mentions.length !== 1) throw new Error('stored handoff is invalid');
      if (message.mentions[0] !== targetMemberId) throw new Error('delivery already handed off to another member');
      return { message, sourceDelivery: source };
    }
    if (source.state === 'superseded' || (source.state !== 'failed' && source.state !== 'offline' && source.outcome !== 'unknown')) throw new Error('delivery is not eligible for handoff');
    if ((source.outcome === 'unknown' || (source.state === 'failed' && source.outcome !== 'failed')) && confirmStopped !== true) {
      throw new Error('confirmStopped is required: the original execution may still be running');
    }
    const target = this.store.getMember(targetMemberId);
    if (!target || target.clusterId !== clusterId || target.id === source.memberId) throw new Error('target must be another active member of this cluster');
    if (target.hiddenAt) throw new Error(`${target.name} is hidden and receives nothing; show it again first or pick another member`);
    const previous = this.store.getMember(source.memberId, { includeRemoved: true });
    const extra = typeof note === 'string' ? note.trim() : '';
    const pluginSource = original.kind === 'plugin' ? `\n原发送者：插件「${original.from.slice('plugin:'.length)}」（按群员请求处理）。` : '';
    const body = `用户交接：原接收成员 ${previous ? personName(this.store, clusterId, previous.id) : source.memberId}；原投递${source.outcome === 'unknown' ? '结果未知' : source.state === 'offline' ? '离线' : '失败'}。`
      + `${pluginSource}${source.error ? `\n原因：${source.error}` : ''}\n\n原请求：\n${original.body}`
      + `${extra ? `\n\n用户补充：\n${extra}` : ''}`;
    const id = randomUUID();
    return this.recordHandoff(source, original, { id, clusterId, from: 'user', mentions: [target.id], body, replyTo: original.id, chainId: id, hop: 0, createdAt: new Date().toISOString(), kind: 'handoff' });
  }

  /**
   * The user sends a failed, offline or uncertain delivery again to the same member, as a new message quoting the
   * original; the original delivery keeps its result and points at the new message. Only over the web API: there is
   * no MCP tool or collaboration action for this. It keeps the original's chain and hop, so the loop limits still
   * count it, and it asks the adapter whether the member is online now instead of trusting a cached status.
   */
  async resendDelivery(clusterId: string, deliveryId: string, input: unknown): Promise<{ message: Message; sourceDelivery: Delivery }> {
    if (!this.store.getCluster(clusterId)) throw new Error('unknown cluster');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('resend body must be an object');
    const { confirmDuplicate } = input as Record<string, unknown>;
    if (confirmDuplicate !== undefined && typeof confirmDuplicate !== 'boolean') throw new Error('confirmDuplicate must be a boolean');
    const earlier = this.resendSource(clusterId, deliveryId);
    if (earlier.done) return earlier.done;
    if (!deliveryUnresolved(earlier.source)) throw new Error('delivery is not eligible for resend');
    if (confirmDuplicate !== true && resendNeedsConfirmation(earlier.source, this.store.deliveryTimes(earlier.source).startedAt)) {
      throw new Error('confirmDuplicate is required: the original may already have run, so a resend can run it twice');
    }
    const member = this.store.getMember(earlier.source.memberId);
    if (!member) throw new Error('the member has been removed from this cluster');
    if (member.hiddenAt) throw new Error(`${member.name} is hidden and receives nothing; show it again first`);
    if (!await this.confirmedOnline(member)) throw new Error('the member is not confirmed online; nothing was sent');
    // Everything below runs in one tick: a concurrent resend either finished above or sees this one's handoff.
    const { source, original, done } = this.resendSource(clusterId, deliveryId);
    if (done) return done;
    const current = this.store.getMember(source.memberId);
    if (!current || current.workerSessionId !== member.workerSessionId) throw new Error('the member moved to another conversation during the online check; nothing was sent');
    const limit = this.resendLimit(original);
    if (limit === 'hop_limit') {
      const maxHops = this.limitSettings.maxHops.limit;
      this.emit(clusterId, current.id, 'guard', { reason: 'max_hops', chainId: original.chainId, hop: original.hop, maxHops: maxHops.kind === 'finite' ? maxHops.value : null });
      throw new Error(`rejected: hop ${original.hop} exceeds the limit for this message chain`);
    }
    if (limit === 'chain_limit') {
      const maxTurns = this.limitSettings.maxTurnsPerChain.limit;
      this.emit(clusterId, current.id, 'guard', { reason: 'max_turns_per_chain', chainId: original.chainId, maxTurnsPerChain: maxTurns.kind === 'finite' ? maxTurns.value : null });
      throw new Error('rejected: this message chain has reached its turn limit');
    }
    const what = source.outcome === 'unknown' ? '结果未知，可能已经执行过，请先确认没有重复' : source.state === 'offline' ? '离线，当时没有送到' : '失败';
    const body = `用户重发：这条消息之前的投递${what}。\n原发送者：${original.from === 'system' ? '系统' : personName(this.store, clusterId, original.from)}`
      + `${source.error ? `\n原因：${source.error}` : ''}\n\n原请求：\n${original.body}`;
    return this.recordHandoff(source, original, { id: randomUUID(), clusterId, from: 'user', mentions: [current.id], body,
      replyTo: original.id, chainId: original.chainId, hop: original.hop, createdAt: new Date().toISOString(), kind: 'resend' });
  }

  /** The delivery a resend acts on, and its earlier resend if there is one (a retry after a lost response gets that one back). */
  private resendSource(clusterId: string, deliveryId: string): { source: Delivery; original: Message; done?: { message: Message; sourceDelivery: Delivery } } {
    const source = this.store.getDelivery(deliveryId);
    const original = source && this.store.getMessage(source.messageId);
    if (!source || !original || original.clusterId !== clusterId) throw new Error('unknown delivery in this cluster');
    if (!source.handoffMessageId) return { source, original };
    const message = this.store.getMessage(source.handoffMessageId);
    if (!message || message.clusterId !== clusterId || message.mentions.length !== 1) throw new Error('stored handoff is invalid');
    if (message.mentions[0] !== source.memberId) throw new Error('delivery already handed off to another member');
    return { source, original, done: { message, sourceDelivery: source } };
  }

  /**
   * The user marks delivery problems as known (标为已知): one delivery, or (`all`) every problem the page listed, up
   * to the listing's `version`. Only the header count changes: the delivery keeps its state, receipt, hand-off and resend.
   * Only over the web API: there is no MCP tool or collaboration action for this. Returns how many it marked and the
   * cluster's problem count after it.
   */
  dismissDeliveryProblems(clusterId: string, target: { deliveryId: string } | { all: unknown }): { dismissed: number; count: number } {
    if (!this.store.getCluster(clusterId)) throw new Error('unknown cluster');
    let version = 0;
    if ('all' in target) {
      const input = target.all as Record<string, unknown> | null;
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'version'
          || !Number.isSafeInteger(input.version) || (input.version as number) < 0) {
        throw new Error('body must be {"version":<the version of the listing, a non-negative integer>}');
      }
      version = input.version as number;
    }
    let ids: string[] = [];
    this.atomically((record) => {
      const at = new Date().toISOString();
      ids = 'deliveryId' in target
        ? (this.store.dismissDeliveryProblem(clusterId, target.deliveryId, at) ? [target.deliveryId] : [])
        : this.store.dismissDeliveryProblems(clusterId, version, at);
      // Other open pages read the count again on it; nothing else listens.
      if (ids.length) record(clusterId, null, 'delivery_dismissed', { deliveryIds: ids, at });
    });
    return { dismissed: ids.length, count: this.store.deliveryProblems(clusterId, 0).count };
  }

  /** Which loop limit a resend of this message would break; the same checks as sending and scheduling. */
  private resendLimit(original: Message): 'hop_limit' | 'chain_limit' | null {
    const hops = this.limitSettings.maxHops.limit;
    if (hops.kind === 'finite' && original.hop > hops.value) return 'hop_limit';
    const turns = this.limitSettings.maxTurnsPerChain.limit;
    return turns.kind === 'finite' && this.store.countChainTurns(original.chainId) >= turns.value ? 'chain_limit' : null;
  }

  /** Asks now; an adapter that cannot say (a failed check) counts as not confirmed. Never starts the app. */
  private async confirmedOnline(member: StoredMember): Promise<boolean> {
    if (!this.nativeDelivery) return false;
    const native = own(this.nativeAdapters, member.harness);
    if (!native) return false;
    if (native.confirmOnline) return native.confirmOnline(member.workerSessionId).catch(() => false);
    return native.isOnline(member.workerSessionId, this.bridge);
  }

  /** The new message, its deliveries, and the original delivery's link to it, in one transaction; then publish and schedule. */
  private recordHandoff(source: Delivery, original: Message, message: Message): { message: Message; sourceDelivery: Delivery } {
    const { clusterId, mentions: [targetId] } = message;
    const files = this.store.attachmentsOf(original.id);
    const pending: Delivery[] = [];
    let sourceDelivery!: Delivery;
    const events = this.store.transaction(() => {
      // The store checks the one-handoff invariant again in the same transaction as message and event writes.
      const deliveries = this.store.insertMessage(message, [targetId], false, files.map((f) => f.id)).map((d) => this.decideOnline(d, pending));
      sourceDelivery = this.store.setHandoff(source.id, message.id);
      return [
        this.store.appendEvent(clusterId, null, 'message', { message, deliveries, ...(files.length ? { attachments: files } : {}) }),
        this.store.appendEvent(clusterId, source.memberId, 'delivery', { delivery: sourceDelivery }),
      ];
    });
    for (const d of pending) this.pending.set(d.id, d.memberId);
    try {
      for (const event of events) this.notify(event);
    } finally {
      for (const d of pending) if (this.pending.has(d.id)) this.confirm(d.memberId);
      this.schedule(targetId);
    }
    return { message, sourceDelivery };
  }

  /** Attachment ids of a message being sent: distinct stored files of this cluster, at most MAX_FILES_PER_MESSAGE. */
  private checkAttachments(clusterId: string, ids: unknown): FileInfo[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length > MAX_FILES_PER_MESSAGE) {
      throw new Error(`attachments must be an array of at most ${MAX_FILES_PER_MESSAGE} distinct file ids`);
    }
    return ids.map((id) => {
      const f = isFileId(id) ? this.store.getFile(id) : null;
      if (!f || f.clusterId !== clusterId) throw new Error(`unknown file ${JSON.stringify(id)} in this cluster`);
      return f;
    });
  }

  // ---- files and skills (docs/files.md) ----

  private fileStore(): FileStore {
    if (!this.files) throw new Error('this Hub keeps no files');
    return this.files;
  }

  /** The user's upload from the web page: a new file of the cluster, not yet in any message. */
  uploadFile(clusterId: string, name: unknown, body: AsyncIterable<Uint8Array>): Promise<FileInfo> {
    return this.fileStore().save(clusterId, 'user', name, body);
  }

  /** A stored file and where its bytes are, looked up by id only; null when there is none. */
  file(id: unknown): { info: FileInfo; path: string } | null {
    const info = this.files && isFileId(id) ? this.store.getFile(id) : null;
    return info ? { info, path: this.files!.pathOf(info) } : null;
  }

  /**
   * Copies the files a member names from its own outbox folder (MCP send_message) into the store; all or
   * nothing. The folder is the caller's own (`memberId` is the authenticated caller).
   * The outbox is never changed: the sender cleans it up with its own tools.
   */
  async importFiles(memberId: string, names: unknown): Promise<string[]> {
    const member = this.store.getMember(memberId);
    if (!member) throw new Error(`unknown member ${memberId}`);
    if (!Array.isArray(names) || names.length > MAX_FILES_PER_MESSAGE || new Set(names).size !== names.length) {
      throw new Error(`attachments must be at most ${MAX_FILES_PER_MESSAGE} distinct file names`);
    }
    const store = this.fileStore();
    const ids: string[] = [];
    try {
      for (const name of names) ids.push((await store.importFromOutbox(member.clusterId, member.id, name)).id);
    } catch (e) {
      await store.discard(ids);
      throw e;
    }
    return ids;
  }

  /** Drops the Hub's own copies no message carries (their send was refused); the outbox is untouched. */
  async discardFiles(ids: string[]): Promise<void> {
    await this.files?.discard(ids);
  }

  /** A message's attachments as a member sees them. */
  attachmentsFor(messageId: string): AttachmentView[] {
    return this.attachmentViews(this.store.attachmentsOf(messageId));
  }

  /** Files as a member sees them (envelope, read_messages, get_task): name, size and the local path. */
  attachmentViews(files: FileInfo[]): AttachmentView[] {
    return files.map((f) => ({
      name: f.name, size: f.size, ...(this.files ? { path: this.files.pathOf(f) } : {}),
    }));
  }

  listSkills(): SkillInfo[] {
    return listSkills(this.skillsDir);
  }

  /** The preset avatars the page can pick ({ name } files in src/web/public/avatars, read at start-up). */
  avatarPresets(): string[] {
    return [...this.avatarNames];
  }

  /**
   * Called by the MCP layer; `fromId` was established from the caller's conversation.
   * A conversation may speak any time. An active Hub run determines its chain even when it speaks in another cluster:
   * when the run delivers a batch, the message continues the chain of `replyTo` if that is in the batch, else of the
   * batch's newest message (hop + 1). Otherwise `replyTo` (if delivered to this conversation), then its newest delivery attempt, determine
   * the chain across memberships, including removed ones. Only a conversation never sent a delivery starts at hop 0.
   * `clientMessageId`: the caller's idempotency key; see resentMessage. Nothing is ever resent automatically.
   * `fyi`: nobody has to act. The members it names keep it unread (mentions) and nobody gets a delivery; not stored.
   * No gate plugin is asked here: every path where a member's words become a message (the MCP send_message tool, a
   * replies member's answer) uses sendFromMemberGated. This one is for tests and setup that run without plugins.
   */
  sendFromMember(fromId: string, body: string, replyTo?: string, attachments: string[] = [], taskIds?: unknown, to?: unknown, clientMessageId?: unknown, fyi?: unknown): SentMessage {
    const plan = this.planMemberSend(fromId, body, replyTo, attachments, taskIds, to, clientMessageId, fyi);
    return 'earlier' in plan ? plan.earlier : plan.commit();
  }

  /**
   * sendFromMember, with the gate plugins (messages.gate) asked last, after every check of the Hub's own and before
   * anything is written: a refusal throws MessageRefused and leaves no message, delivery or message event, only a
   * rate-limited record. A plugin that does not answer in time lets the message through (fail-open), also recorded.
   * Without a gate plugin for this cluster nothing waits: the message is written within this call, as before.
   * A clientMessageId repeat of an accepted message returns it without asking; a refused one was never stored, so
   * a repeat is asked again.
   */
  async sendFromMemberGated(fromId: string, body: string, replyTo?: string, attachments: string[] = [], taskIds?: unknown, to?: unknown, clientMessageId?: unknown, fyi?: unknown): Promise<SentMessage> {
    const plan = this.planMemberSend(fromId, body, replyTo, attachments, taskIds, to, clientMessageId, fyi);
    if ('earlier' in plan) return plan.earlier;
    const gate = this.gate;
    const check: MessageCheckRequest = { ...plan.check, checkId: randomUUID() };
    const asking = gate?.checkMessage(check);
    if (!gate || !asking) return plan.commit();
    // Told to the gate exactly once, in `finally`, when it is final; it says only what happened to this check.
    let result: MessageCheckResult = { stored: false, reason: 'rejected_by_hub' };
    let writing: string | undefined;
    try {
      const outcomes = await asking;
      // The turn, the members or a concurrent repeat may have changed while the plugins answered: check everything again.
      const again = this.planMemberSend(fromId, body, replyTo, attachments, taskIds, to, clientMessageId, fyi, plan);
      if ('earlier' in again) return again.earlier;   // stored by another send, not by this check
      try { this.gateVerdicts(check, outcomes); } catch (error) {
        if (error instanceof MessageRefused) result = { stored: false, reason: 'refused_by_other' };
        throw error;
      }
      writing = again.id;
      gate.checkStoring?.(check.checkId, again.id);
      const sent = again.commit();
      result = { stored: true, messageId: sent.message.id };
      return sent;
    } finally {
      // A commit can throw after its transaction (a failing listener): the message is stored all the same.
      if (!result.stored && writing) {
        try { if (this.store.getMessage(writing)) result = { stored: true, messageId: writing }; } catch { /* closed: not stored by us */ }
      }
      try { gate.checkSettled?.(check.checkId, result); } catch { /* observation must not change the send's result */ }
    }
  }

  /** The composition root's gate plugins (ExternalPlugins); without one, no message is checked. */
  setMessageGate(gate: MessageGate): void { this.gate = gate; }

  /** The composition root's third-party plugins for members' tools (ExternalPlugins); without one, members get none. */
  setMemberTools(host: MemberToolHost): void { this.memberToolHost = host; }

  /**
   * The third-party tools of these memberships (one conversation's, hidden ones already left out): those of plugins
   * granted tools.provide and at least one of their clusters, `running` or not. Each name once.
   */
  pluginTools(members: readonly Pick<Member, 'clusterId'>[]): MemberToolDeclaration[] {
    if (!this.memberToolHost || this.closed || !members.length) return [];
    const seen = new Set<string>();
    return this.memberToolHost.memberTools([...new Set(members.map((m) => m.clusterId))]).filter((t) => !seen.has(t.name) && !!seen.add(t.name));
  }

  /** A member calls a third-party tool; it writes no message or delivery, wakes nobody and uses no loop budget. */
  callPluginTool(call: MemberToolCall): Promise<MemberToolOutcome> {
    if (!this.memberToolHost) return Promise.resolve({ ok: false, code: 'NOT_GRANTED', message: '没有这个插件工具。' });
    return this.memberToolHost.callMemberTool(call);
  }

  /**
   * Plugin tools of these clusters changed: the bridge of each conversation (its own stream) with a shown membership in
   * one of them is told, so its app can list again. Conversations elsewhere hear nothing.
   */
  pluginToolsChanged(clusterIds: readonly string[]): void {
    if (this.closed) return;
    for (const [key, conn] of this.bridges) {
      const cut = key.indexOf('\n');   // "<harness>\n<session id>"; neither part can hold a newline (bridge.ts isId)
      if (!this.nativeCallers(key.slice(0, cut), key.slice(cut + 1)).some((m) => !m.hiddenAt && clusterIds.includes(m.clusterId))) continue;
      try { conn.toolsChanged?.(); } catch { /* one closed stream must not stop the others */ }
    }
  }

  /**
   * The user-visible trace of a member's call of a third-party tool: a system record (plugin_tool_call) without
   * recipients. It wakes nobody and is not sent to that plugin as an event. The caller (ExternalPlugins) limits how
   * often: one a minute per plugin, member and tool, the repeats counted in the next one.
   */
  externalPluginToolRecord(pluginId: string, clusterId: string, text: string): void {
    if (this.closed || !this.store.getCluster(clusterId)) return;
    const id = randomUUID();
    this.post({ id, clusterId, from: 'system', kind: 'system', systemKind: 'plugin_tool_call', body: text, mentions: [], replyTo: null, chainId: id, hop: 0,
      createdAt: new Date().toISOString() }, [], false, [], [], undefined, pluginId);
  }

  /** Records what the gate plugins said (rate-limited), and throws when any of them refused. */
  private gateVerdicts(check: Omit<MessageCheckRequest, 'checkId'>, outcomes: MessageCheckOutcome[]): void {
    const refusals: Extract<MessageCheckOutcome, { verdict: 'refuse' }>[] = [];
    for (const outcome of outcomes) {
      if (outcome.verdict === 'allow') continue;
      if (outcome.verdict === 'refuse') {
        refusals.push(outcome);
        this.gateRecord(`refuse:${outcome.pluginId}:${check.sender.id}`, GATE_REFUSAL_RECORD_MS, check.clusterId, outcome.pluginId,
          `插件「${outcome.name}」拒绝了 ${check.sender.name} 的一条发言：${outcome.reason || '（插件没有说明原因）'}。这条发言没有存进群聊，也没有投递。`,
          'plugin_refused', '条被拒绝的发言');
      } else {
        this.gateRecord(`${outcome.failure === 'stopped' ? 'stopped' : 'failed'}:${outcome.pluginId}:${check.clusterId}`, GATE_FAILURE_RECORD_MS, check.clusterId, outcome.pluginId,
          `插件「${outcome.name}」没有完成发言检查（${GATE_FAILURE_TEXT[outcome.failure]}），这一次该插件未拦截 ${check.sender.name} 的发言；最终结果仍以其他检查为准。`,
          'plugin_check_failed', '次没有完成的检查');
      }
    }
    if (!refusals.length) return;
    throw new MessageRefused(refusals.map((r) => `插件「${r.name}」拒绝了这条发言：${r.reason || '（插件没有说明原因）'}`).join('；')
      + '。这条消息没有存进群聊，也没有投递给任何人。可以等一会儿或改写后再发；不要原样反复重试。');
  }

  /**
   * One system record the user sees in the cluster (no recipient, wakes nobody, never the refused text), at most one
   * per key and window; the repeats inside a window are counted and the next record says how many there were.
   */
  private gateRecord(key: string, windowMs: number, clusterId: string, pluginId: string, text: string, systemKind: SystemMessageKind, unit: string): void {
    const now = Date.now();
    const seen = this.gateRecords.get(key);
    if (seen && now < seen.until) { seen.repeats++; return; }
    this.gateRecords.set(key, { until: now + windowMs, repeats: 0 });
    const body = seen?.repeats ? `${text}\n（上一条同类记录之后的 ${Math.round(windowMs / 60_000)} 分钟内另有 ${seen.repeats} ${unit}，没有单独记录。）` : text;
    const id = randomUUID();
    try {
      // The plugin does not get its own record as an event (sourcePluginId), so it cannot answer itself.
      this.post({ id, clusterId, from: 'system', kind: 'system', systemKind, body, mentions: [], replyTo: null, chainId: id, hop: 0,
        createdAt: new Date(now).toISOString() }, [], false, [], [], undefined, pluginId);
    } catch { /* a record that cannot be written (the cluster was just deleted) must not change the send's result */ }
  }

  private planMemberSend(fromId: string, body: string, replyTo?: string, attachments: string[] = [], taskIds?: unknown, to?: unknown,
    clientMessageId?: unknown, fyi?: unknown, context?: { from: StoredMember; run?: Running; handling: Message | null }):
    { earlier: SentMessage } | { from: StoredMember; run?: Running; handling: Message | null; id: string;
      check: Omit<MessageCheckRequest, 'checkId'>; commit: () => SentMessage } {
    const from = this.store.getMember(fromId);
    if (!from) throw new Error(`unknown member ${fromId}`);
    if (from.hiddenAt) throw new Error(HIDDEN_TOOL_TEXT);   // a hidden member cannot speak (its tools refuse first)
    if (context && (from.harness !== context.from.harness || from.workerSessionId !== context.from.workerSessionId)) {
      throw new Error('rejected: the sender conversation changed during the message check');
    }
    const run = context ? context.run : this.sessionRun(from);
    if (fyi !== undefined && typeof fyi !== 'boolean') throw new Error('fyi must be a boolean');
    const earlier = this.resentMessage(fromId, clientMessageId, run ?? null);
    if (earlier) return { earlier };
    const files = this.checkAttachments(from.clusterId, attachments);
    if (!body.trim() && !files.length) throw new Error('body is required');
    if (replyTo) replyTo = this.collaboration.resolveId('messages', from.clusterId, replyTo, `unknown message ${replyTo} in this cluster`);
    // An ordinary member's names, @ and hints know nothing of hidden members; the coordinator's may name one (no delivery).
    const members = this.visibleMembers(from.clusterId, fromId, this.store.listMembers(from.clusterId));
    const present = members.filter((m) => !m.hiddenAt).map((m) => m.id);   // whom @all and deliveries can reach
    let mentions: string[];
    let explicit: string[] = [];   // the members this message is a request to, even inside a broadcast
    let unresolvedMentions: string[] = [];
    let broadcast = false;   // a member's @all: unread for everyone, but only explicit @names wake anyone
    if (to !== undefined) {
      // Explicit names win: the body is plain text, so quoted @all and @names never deliver anything.
      if (!Array.isArray(to) || to.length === 0 || !to.every((name) => typeof name === 'string')
        || new Set(to).size !== to.length) throw new Error('to must be a non-empty array of distinct member names');
      const byName = new Map(members.map((member) => [member.name, member.id]));
      const names = members.filter((member) => !member.removedAt).map((member) => member.name);
      const resolved = to.map((name) => {
        const id = byName.get(String(name).trim());
        if (!id) throw new Error(`unknown member name ${JSON.stringify(name)}; available: ${names.join(', ')}`);
        return id;
      });
      mentions = resolved.filter((id) => id !== fromId);
      explicit = mentions;
    } else {
      const { ids, all, unresolved } = this.parseMentions(body, members);
      unresolvedMentions = unresolved;
      broadcast = all;
      // An agent's @-mention of itself never comes back to it.
      explicit = ids.filter((id) => id !== fromId);
      mentions = (all ? present : ids).filter((id) => id !== fromId);
    }
    // The coordinator plugin says where a message that names nobody goes; a member's stays in the chat record.
    const fallback = mentions.length === 0 && !fyi ? this.store.coordinator?.unaddressedRecipient({ clusterId: from.clusterId, from: fromId, body, members }) : null;
    // A member's @all is a broadcast (wake-up table in docs/collaboration.md): everyone keeps it unread, and only the members
    // named explicitly ("@all FYI, @B please handle") are woken; the broadcast itself wakes nobody.
    // fyi: for information only, so named members are not woken — unless replying to an active asker explicitly
    // addressed by this message, who is still waiting for the answer and must be woken while everyone else stays unread.
    const repliedAsker = fyi && replyTo ? this.store.getMessage(replyTo) : null;
    const fyiOverrideIds = repliedAsker && repliedAsker.clusterId === from.clusterId && explicit.includes(repliedAsker.from)
      ? [repliedAsker.from] : [];
    const recipients = (fyi ? fyiOverrideIds : fallback ? [fallback] : broadcast ? explicit : mentions).filter((id) => present.includes(id));

    const id = randomUUID();
    let handling: Message | null;
    if (context) {
      handling = context.handling;
    } else {
      handling = run
        ? run.messages.find((m) => m.id === replyTo) ?? run.messages.at(-1)!
        : (replyTo ? this.store.lastDeliveredToSession(from.harness, from.workerSessionId, replyTo) : null)
          ?? this.store.lastDeliveredToSession(from.harness, from.workerSessionId);
    }
    const chainId = handling?.chainId ?? id;
    const hop = handling ? handling.hop + 1 : 0;
    // Unlimited skips only this check; chainId and hop are computed and stored as always.
    const { limit } = this.limitSettings.maxHops;
    if (limit.kind === 'finite' && hop > limit.value) {
      this.emit(from.clusterId, fromId, 'guard', { reason: 'max_hops', chainId, hop, maxHops: limit.value });
      throw new Error(`rejected: hop ${hop} exceeds the limit of ${limit.value} for this message chain`);
    }
    const linkedTaskIds = this.checkTaskIds(from.clusterId, taskIds);
    const check: Omit<MessageCheckRequest, 'checkId'> = { clusterId: from.clusterId, sender: { id: fromId, name: from.name }, mentions: [...mentions],
      recipients: [...recipients], fyi: fyi === true, replyTo: replyTo ?? null, attachments: files.length, body };
    return { from, run, handling, id, check, commit: () => {
      const message = this.post({
        id, clusterId: from.clusterId, from: fromId, mentions, body, replyTo: replyTo ?? null, chainId, hop, createdAt: new Date().toISOString(),
        ...(fyi ? { fyi: true } : {}), ...(broadcast ? { explicitMentions: explicit } : {}),
      }, recipients, false, files, linkedTaskIds, clientMessageId as string | undefined);
      if (run) run.sentMcpMessage = true;
      const deliveredTo = recipients.map((m) => members.find((x) => x.id === m)!.name);
      return {
        ...this.sentResult(message, deliveredTo, unresolvedMentions, members, broadcast || fyi === true),
        ...(fyiOverrideIds.length && deliveredTo.length ? { fyiOverridden: deliveredTo } : {}),
      };
    } };
  }

  /** The first send's result: its unresolved names and, with no recipient, the warning. A broadcast reaches everyone as
   *  unread even when it is a request to nobody, so it is not warned about (its text stays in the chat record); an fyi
   *  message is meant to wake nobody. */
  private sentResult(message: Message, deliveredTo: string[], unresolvedMentions: string[], members: StoredMember[], broadcast = false): SentMessage {
    const hints = mentionHints(unresolvedMentions, [...members.map((m) => m.name), 'all']);
    return { message, deliveredTo, unresolvedMentions, ...(hints.length ? { mentionHints: hints } : {}),
      ...(deliveredTo.length || broadcast ? {} : { warning: noRecipientWarning(members.filter((m) => !m.hiddenAt)) }) };
  }

  /**
   * The mentionHints for a user's group-chat message `body` in this cluster (the web page shows them after the send,
   * without blocking it); [] when every @-text resolved or none starts with a member's name.
   */
  userMentionHints(clusterId: string, body: unknown): string[] {
    if (typeof body !== 'string') return [];
    const members = this.store.listMembers(clusterId);
    return mentionHints(this.parseMentions(body, members).unresolved, [...members.map((m) => m.name), 'all']);
  }

  /**
   * The message this member already sent with this clientMessageId, as send_message's result, or null. A repeat
   * writes nothing and is told by `duplicate`; the first send stands even if the repeat's text differs. The first
   * send's diagnosis (`unresolvedMentions`, `warning`) is not replayed or recomputed: it belongs to that send, the Hub
   * does not store it, and the repeat's own `to` or the current member names must not change it, so the reply omits it.
   */
  resentMessage(fromId: string, clientMessageId: unknown, sendingRun?: Running | null): SentMessage | null {
    if (clientMessageId === undefined) return null;
    if (typeof clientMessageId !== 'string' || !clientMessageId || clientMessageId.length > MAX_CLIENT_MESSAGE_ID) {
      throw new Error(`clientMessageId must be a non-empty string of at most ${MAX_CLIENT_MESSAGE_ID} characters`);
    }
    const message = this.store.messageByClientId(fromId, clientMessageId);
    if (!message) return null;
    const from = this.store.getMember(fromId);
    const run = sendingRun === undefined ? from && this.sessionRun(from) : sendingRun;
    if (run) run.sentMcpMessage = true;   // as for a first send: this turn has spoken, its answer is not forwarded
    // From the deliveries, as the first send reported them.
    const deliveredTo = this.deliveriesSeenBy(message, fromId).map((d) => personName(this.store, message.clusterId, d.memberId));
    return { message, deliveredTo, duplicate: true };
  }

  /** One system message written inside the caller's transaction; the callback publishes and schedules it after the commit. */
  writeSystemMessage(clusterId: string, recipients: string[], body: string, taskIds: string[], sourceEventId: number, systemKind: SystemMessageKind): () => void {
    const id = randomUUID();
    const msg: Message = { id, clusterId, from: 'system', mentions: recipients, body, replyTo: null,
      chainId: id, hop: 0, createdAt: new Date().toISOString(), kind: 'system', systemKind };
    const pending: Delivery[] = [];
    const deliveries = this.store.insertMessage(msg, recipients).map((delivery) => this.decideOnline(delivery, pending));
    for (const taskId of taskIds) this.store.tasks?.linkMessage(id, taskId, 'system');
    const messageEvent = this.store.appendEvent(clusterId, null, 'message',
      { message: { ...msg, ...this.store.pluginFields(id) }, deliveries, sourceEventId });
    return () => {
      for (const delivery of pending) this.pending.set(delivery.id, delivery.memberId);
      try { this.notify(messageEvent); } finally {
        for (const delivery of pending) if (this.pending.has(delivery.id)) this.confirm(delivery.memberId);
        for (const recipientId of recipients) this.schedule(recipientId);
      }
    };
  }

  private collaborationNotification(actor: CollaborationActor, clusterId: string, source: HubEvent,
    notice: CollaborationNotice, original?: Message): (() => void) | undefined {
    const recipients = notice.recipients.filter((id) => this.store.getMember(id)?.clusterId === clusterId);
    if (!recipients.length && !notice.retain) return;
    let handling: Message | null = original ?? null;
    if (!handling && actor.kind === 'member') {
      const member = this.store.getMember(actor.memberId)!;
      handling = this.sessionRun(member)?.messages.at(-1) ?? this.store.lastDeliveredToSession(member.harness, member.workerSessionId);
    }
    const id = randomUUID();
    const chainId = handling?.chainId ?? id;
    const hop = handling ? handling.hop + 1 : 0;
    const { limit } = this.limitSettings.maxHops;
    // Past the hop limit nobody is told: whoever the notice would name or wake is the guard's business. A notice the
    // chat must keep (`retain`) is still written, naming nobody and delivered to nobody, so it can start no turn. It
    // keeps the chain and the hop it would have had, so nothing that later follows it starts from a lower hop.
    const overHops = limit.kind === 'finite' && hop > limit.value;
    const guard = overHops && recipients.length ? this.store.appendEvent(clusterId, actor.kind === 'member' ? actor.memberId : null, 'guard',
      { reason: 'max_hops', chainId, hop, maxHops: limit.value, sourceEventId: source.seq }) : null;
    if (overHops && !notice.retain) return () => this.notify(guard!);
    if (overHops) recipients.length = 0;
    const msg: Message = { id, clusterId, from: 'system', mentions: recipients, body: notice.body,
      replyTo: handling?.clusterId === clusterId ? handling.id : null, chainId, hop,
      createdAt: new Date().toISOString(), kind: 'system', systemKind: notice.systemKind, ...(notice.collabEventId !== undefined ? { collabEventId: notice.collabEventId } : {}),
      ...(notice.taskStamp ? { taskStamp: notice.taskStamp } : {}) };
    const pending: Delivery[] = [];
    // Info recipients are in mentions/unread but get no delivery and no turn; only wake recipients are scheduled.
    const { wake } = notice;
    const deliverTo = wake === undefined ? recipients : recipients.filter((id) => wake.includes(id));
    const deliveries = this.store.insertMessage(msg, deliverTo).map((d) => this.decideOnline(d, pending));
    if (notice.taskId) this.store.tasks?.linkMessage(id, notice.taskId, 'system');
    const message = { ...msg, ...this.store.pluginFields(id) };
    const messageEvent = this.store.appendEvent(clusterId, null, 'message', { message, deliveries, sourceEventId: source.seq });
    // A wake-up whose recipient is hidden got no delivery (Store.insertMessage): the work it carried lands on nobody.
    const landed = this.hiddenWorkLanded(actor, clusterId, source, notice, deliverTo, msg);
    return () => {
      for (const d of pending) if (this.store.getDelivery(d.id)?.state === 'queued') this.pending.set(d.id, d.memberId);
      try {
        if (guard) this.notify(guard);
        this.notify(messageEvent);
      } finally {
        for (const d of pending) if (this.pending.has(d.id)) this.confirm(d.memberId);
        for (const memberId of deliverTo) this.schedule(memberId);
        landed?.();
      }
    };
  }

  /**
   * Work that lands on a hidden member (docs/cluster-members.md「隐身」): every task wake-up goes through
   * collaborationNotification, so this one place covers them all, whatever the template. Each one is recorded as a
   * 'guard' page event (the user's hint, GET /api/stalled, and the brief on showing read these), and wakes the enabled
   * coordinator when it holds a permission that can deal with it (rule 21). The stored event is the only record: it is
   * written once per (member, task, revision, status, kind) of a hidden period, and the coordinator is told exactly when
   * it is written, in the same transaction, so a rollback undoes both, a retry redoes both and a restart repeats nothing.
   */
  private hiddenWorkLanded(actor: CollaborationActor, clusterId: string, source: HubEvent, notice: CollaborationNotice,
    deliverTo: string[], msg: Message): (() => void) | undefined {
    const task = notice.taskId ? this.store.tasks?.task(clusterId, notice.taskId) : null;
    if (!task) return;
    const hidden = deliverTo.filter((memberId) => this.store.getMember(memberId)?.hiddenAt);
    if (!hidden.length) return;
    const payload = (source.payload ?? {}) as Record<string, unknown>;
    const action = typeof payload.action === 'string' ? payload.action : '';
    const events: HubEvent[] = [];
    const after: (() => void)[] = [];
    for (const memberId of hidden) {
      const { kind, role } = hiddenWorkOf(task, memberId, action, payload, task.id);
      const since = this.store.getMember(memberId)!.hiddenAt!;
      if (this.store.hiddenWork(memberId, since).some((w) => w.taskId === task.id && w.kind === kind && w.revision === task.revision && w.status === task.status)) continue;
      const work: HiddenWork = { reason: 'hidden_work', taskId: task.id, kind, role, revision: task.revision, status: task.status, sourceEventId: source.seq };
      events.push(this.store.appendEvent(clusterId, memberId, 'guard', work));
      // Keep the notice queued during a pause; its delivery follows the usual resume path.
      const coordinator = this.store.coordinator?.policy(clusterId);
      if (!coordinator?.enabled || this.store.getMember(coordinator.memberId)?.clusterId !== clusterId
        || (actor.kind === 'member' && actor.memberId === coordinator.memberId)) continue;
      const { assignment, recovery, deliveryControl } = coordinator.permissions;
      if (!assignment && !recovery && !deliveryControl) continue;   // nothing it could do: the user's page hint is enough
      const publish = this.collaborationNotification(actor, clusterId, source,
        { recipients: [coordinator.memberId], body: hiddenWorkNotice(task, kind, role, source.seq), taskId: task.id, systemKind: 'hidden_work' }, msg);
      if (publish) after.push(publish);
    }
    return () => {
      for (const e of events) this.notify(e);
      for (const fn of after) fn();
    };
  }

  /** Started and not closing: background work may be scheduled. */
  isRunning(): boolean { return this.started && !this.closed; }

  /** Whether the harness's quota snapshot says it is used up right now. */
  quotaExhaustedNow(harness: string, now: number): boolean { return quotaLevel(this.usage.snapshot(harness), now).level === 'exhausted'; }

  /** The enabled coordinator a Hub notice may go to now: none while the Hub or the cluster is paused. */
  noticeCoordinator(clusterId: string): CoordinatorPolicy | null {
    if (this.closed || this.paused) return null;
    const coordinator = this.store.coordinator?.policy(clusterId);
    if (!this.store.getCluster(clusterId) || this.store.clusterPause(clusterId).paused || !coordinator?.enabled
      || this.store.getMember(coordinator.memberId)?.clusterId !== clusterId) return null;
    return coordinator;
  }

  /**
   * One Hub notice (idle tasks, a stalled member, quota) to the coordinator through the normal delivery path. `record` runs only once
   * the message is stored: a failed insert rolls back and the next check retries, while a failure after the commit
   * (broadcast, scheduling) must not produce the same notice twice.
   */
  postNotice(clusterId: string, coordinatorId: string, body: string, taskIds: string[], record: () => void, systemKind: SystemMessageKind): void {
    const id = randomUUID();
    try {
      this.post({ id, clusterId, from: 'system', mentions: [coordinatorId], body, replyTo: null, chainId: id, hop: 0,
        createdAt: new Date().toISOString(), kind: 'system', systemKind }, [coordinatorId], false, [], taskIds);
    } finally {
      if (this.store.getMessage(id)) record();
    }
  }

  /**
   * The early warning for long queues: a delivery waiting queueWarnMs since its message was written without starting,
   * whether queued in the Hub or in the harness's own queue (Codex). One info notice per recipient per check to the
   * senders and the coordinator: it joins their unread, starts no turn and cannot queue itself. Marked only once
   * written, so a failed write retries at the next check; a paused Hub or cluster is meant to wait, so it is not warned.
   */
  private warnLongQueues(): void {
    const waitMs = this.limits.queueWarnMs;
    if (!waitMs || !this.started || this.closed || this.paused || this.inGrace) return;
    try {
      const now = Date.now();
      const cutoff = new Date(now - waitMs).toISOString();
      const byMember = new Map<string, { ids: string[]; messages: Message[]; run?: Running }>();
      const entry = (memberId: string) => byMember.get(memberId) ?? byMember.set(memberId, { ids: [], messages: [] }).get(memberId)!;
      for (const q of this.store.overdueQueued(cutoff)) {
        const e = entry(q.memberId);
        e.ids.push(q.id);
        e.messages.push(q.message);
      }
      for (const [memberId, run] of this.running) {
        const clusterId = this.store.getMember(memberId)?.clusterId;
        if (!clusterId || !run.waiting || run.queueWarned || run.messages[0].createdAt > cutoff
          || this.store.clusterPause(clusterId).paused) continue;
        const e = entry(memberId);
        e.run = run;
        e.messages.unshift(...run.messages);
      }
      for (const [memberId, overdue] of byMember) {
        const member = this.store.getMember(memberId);
        // A hidden member's turn that started before hiding is not warned about: the warning could only name an unseen member.
        if (member && !member.hiddenAt) try { this.postQueueWarning(member, overdue, now); } catch { /* the next check tries again */ }
      }
    } catch {
      // A background check must not throw out of a timer.
    }
  }

  private postQueueWarning(member: StoredMember, overdue: { ids: string[]; messages: Message[]; run?: Running }, now: number): void {
    const { clusterId } = member;
    const run = this.sessionRun(member);
    const inTurn = run !== undefined && (run.waiting?.busy ?? true);
    const active = new Set(this.store.listMembers(clusterId).map((m) => m.id));
    const coordinator = this.noticeCoordinator(clusterId)?.memberId;
    const mentions = [...new Set([...overdue.messages.map((m) => m.from), ...(coordinator ? [coordinator] : [])])]
      .filter((id) => id !== member.id && active.has(id));
    const minutes = (m: Message) => Math.max(1, Math.round((now - Date.parse(m.createdAt)) / 60_000));
    const shown = overdue.messages.slice(0, NOTICE_MESSAGES).map((m) => {
      const flat = m.body.replace(/\s+/g, ' ').trim();
      return `- 「${flat.length > 20 ? `${flat.slice(0, 20)}…` : flat}」（messageId ${m.id}，来自 ${m.from === 'system' ? '系统' : personName(this.store, clusterId, m.from)}）已等 ${minutes(m)} 分钟`;
    });
    const more = overdue.messages.length - shown.length;
    const body = [`排队预警：投给 ${personName(this.store, member.clusterId, member.id)} 的 ${overdue.messages.length} 条消息还没开始，最久已等 ${minutes(overdue.messages[0])} 分钟；${personName(this.store, member.clusterId, member.id)} ${inTurn ? '正在一轮中' : '现在不在轮次中'}。`,
      ...shown, ...(more ? [`另有 ${more} 条。`] : []), '投递仍在排队，不用重发。'].join('\n');
    const id = randomUUID();
    try {
      this.post({ id, clusterId, from: 'system', mentions, body, replyTo: null, chainId: id, hop: 0, createdAt: new Date(now).toISOString(), kind: 'system', systemKind: 'queue_warning' }, []);
    } finally {
      if (this.store.getMessage(id)) {
        this.store.markQueueWarned(overdue.ids);
        if (overdue.run) overdue.run.queueWarned = true;
        this.emitMember(member);
      }
    }
  }

  // ---- quota notices (docs/usage.md「额度提醒」) ----

  /** A quota snapshot changed or a window's reset time came: notices now, idle candidates on their usual delay. */
  private quotaChanged(): void {
    if (!this.started || this.closed) return;
    this.checkQuota();
    for (const [id, service] of this.services) this.guardPlugin(id, 'onQuotaChanged', () => service.onQuotaChanged?.());
  }

  /**
   * For every cluster with a coordinator that may be told: each harness its members use that is at warning or
   * exhausted gets one notice per (cluster, harness, window, resetsAt to the minute, level); after an exhausted notice, one
   * recovery notice once the harness is below warning or that window has reset. Records live in memory only.
   */
  private checkQuota(): void {
    if (!this.started || this.closed) return;
    const now = Date.now();
    this.armQuotaTimer(now);
    for (const c of this.store.listClusters()) {
      try { this.checkClusterQuota(c.id, now); } catch { /* the next change, reset or sweep tries again */ }
    }
  }

  private checkClusterQuota(clusterId: string, now: number): void {
    const coordinator = this.noticeCoordinator(clusterId);
    if (!coordinator) return;
    const members = this.listMembers(clusterId);
    let tasks: Task[] | null = null;
    const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });
    for (const harness of new Set(members.map((m) => m.harness))) {
      const snapshot = this.usage.snapshot(harness);
      if (!snapshot) continue;
      const { level, window } = quotaLevel(snapshot, now);
      const affected = members.filter((m) => m.harness === harness && !m.hiddenAt);   // hidden members: rule 21 and the page hint
      if (!affected.length) continue;   // only hidden members use it: nothing to tell about visible work
      const names = affected.map((m) => m.name).join('、');
      const pending = `${clusterId}\n${harness}`;
      const was = this.quotaExhausted.get(pending);
      if (was && level !== 'exhausted' && (level === 'none' || (was.resetsAt !== null && Date.parse(was.resetsAt) <= now))) {
        const current = snapshot.windows.find((w) => w.id === was.id);
        const reset = was.resetsAt !== null && Date.parse(was.resetsAt) <= now;
        const state = reset ? '已重置' : current ? `已用 ${current.usedPercent}%` : '已低于预警线';
        this.postNotice(clusterId, coordinator.memberId,
          `额度已恢复：${harness} 的「${was.label}」窗口${state}（截至 ${fmt(snapshot.observedAt)}）。本群受影响的成员：${names}。`,
          [], () => this.quotaExhausted.delete(pending), 'quota_recovered');
      }
      if (level === 'none' || !window) continue;
      // A source may report the same reset a few hundred milliseconds apart on every read: the minute names the period.
      const resetMinute = window.resetsAt === null ? null : Math.round(Date.parse(window.resetsAt) / 60_000);
      const key = JSON.stringify([clusterId, harness, window.id, resetMinute, level]);
      if (this.quotaNotified.has(key)) continue;
      tasks ??= this.store.tasks?.all(clusterId) ?? [];
      const open = tasks.filter((t) => t.proposalState === 'active');
      const statusName: Record<string, string> = { pending: '已分配', working: '正在做' };
      const linked = new Set<string>();
      const group = (pick: (m: Member) => Task[], label: (t: Task) => string) => {
        const lines = affected.flatMap((m) => {
          const mine = pick(m);
          for (const t of mine) linked.add(t.id);
          return mine.length ? [`- ${personName(this.store, clusterId, m.id)}：${mine.map((t) => `任务${t.number ? ` #${t.number}` : ''}【${t.title}】（${label(t)}）`).join('；')}`] : [];
        });
        return lines.length ? lines : ['- 无'];
      };
      const executeLines = group((m) => open.filter((t) => (t.status === 'pending' || t.status === 'working') && t.assignedMemberId === m.id),
        (t) => `${t.id}，${statusName[t.status]}`);
      const reviewLines = group((m) => open.filter((t) => t.status === 'review' && t.reviewer.kind === 'member'
        && t.reviewer.memberId === m.id), (t) => t.id);
      const exhausted = level === 'exhausted';
      const body = [
        `${exhausted ? '额度用完' : '额度预警'}：${harness} 的「${window.label}」窗口已用 ${window.usedPercent}%，`
          + `${window.resetsAt ? `${fmt(window.resetsAt)} 重置` : '重置时间未知'}（截至 ${fmt(snapshot.observedAt)}）。`,
        `本群受影响的成员：${names}。`, ...(this.store.tasks ? ['执行：', ...executeLines, '验收：', ...reviewLines] : []),
        exhausted ? '请按资格把未开始的任务改派，正在执行的不打断。' : '额度快用完，派新任务时注意。',
      ].join('\n');
      this.postNotice(clusterId, coordinator.memberId, body, [...linked], () => {
        this.quotaNotified.add(key);
        if (exhausted) this.quotaExhausted.set(pending, window);
      }, exhausted ? 'quota_exhausted' : 'quota_low');
    }
  }

  /** One timer for the earliest reset of a window at warning or above (or one an exhausted notice waits on). */
  private armQuotaTimer(now: number): void {
    clearTimeout(this.quotaTimer);
    this.quotaTimer = undefined;
    const resets = [...this.usage.harnessesWithSnapshot().flatMap((h) => this.usage.snapshot(h)!.windows)
      .filter((w) => w.usedPercent >= QUOTA_WARNING_PERCENT), ...this.quotaExhausted.values()]
      .map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)).filter((t) => t > now);
    if (!resets.length) return;
    // setTimeout holds at most ~24.8 days; a later reset is re-armed by the timer itself.
    this.quotaTimer = setTimeout(() => this.quotaChanged(), Math.min(Math.min(...resets) - now + 1, 2 ** 31 - 1));
    this.quotaTimer.unref();
  }

  /**
   * Claude has no cheap quota source: every claudeQuotaPollMs the Hub asks it (the same refresh as the web page's,
   * with its 10 s minimum gap), but only while a Claude member of a cluster with an enabled coordinator has an
   * unfinished task to execute or review. Otherwise no process is started.
   */
  private pollClaudeQuota(): Promise<unknown> | undefined {
    if (this.closed || !own(this.nativeAdapters, 'claude')?.quota) return;
    const needed = this.store.listClusters().some((c) => {
      const policy = this.store.coordinator?.policy(c.id);
      const claude = new Set(this.store.listMembers(c.id).filter((m) => m.harness === 'claude').map((m) => m.id));
      if (!policy?.enabled || !claude.size) return false;
      return (this.store.tasks?.all(c.id) ?? []).some((t) => t.status !== 'completed' && t.status !== 'merged' && t.status !== 'cancelled'
        && [t.assignedMemberId, t.reviewer.kind === 'member' ? t.reviewer.memberId : null]
          .some((id) => id !== null && claude.has(id)));
    });
    return needed ? this.usage.poll(true, ['claude']) : undefined;
  }

  private deliveryNotification(event: HubEvent, delivery: Delivery): (() => void) | undefined {
    const original = this.store.getMessage(delivery.messageId);
    if (!original || original.kind === 'system' || original.kind === 'plugin' || !this.store.getCluster(original.clusterId)) return;
    const policy = this.store.coordinator?.policy(original.clusterId);
    if (!policy?.enabled || policy.memberId === delivery.memberId || policy.memberId === original.from) return;
    const view = this.store.tasks;
    const linked = (view?.links(original.id) ?? []).map((id) => view!.task(original.clusterId, id)).filter((task) => task !== null);
    // A historical link to a closed task is not work affected by the failure: any still-open linked task wakes the
    // coordinator, whatever order the links are in; with none, the notice only joins its unread and may still show one.
    const openTask = linked.find((task) => !['completed', 'merged', 'cancelled'].includes(task.status));
    const task = openTask ?? linked[0];
    const affectsTask = openTask !== undefined;
    const clip = original.body.length > 28 ? `${original.body.slice(0, 28)}…` : original.body;
    // A failed-delivery notice reports a delivery, which a later task change does not make out of date: no stamp, no event link.
    return this.collaborationNotification({ kind: 'user' }, original.clusterId, event, {
      recipients: [policy.memberId], taskId: task?.id, systemKind: 'delivery_failed',
      body: `投递失败或离线：消息「${clip}」（来源 ${original.id}）没有送到 ${personName(this.store, original.clusterId, delivery.memberId)}${task ? `（任务${task.number ? ` #${task.number}` : ''}【${task.title}】）` : ''}，`
        + `${delivery.state === 'offline' ? '该成员当前离线' : '投递未成功'}${delivery.error ? `（${delivery.error}）` : ''}，事件 ${event.seq}。请查看实际投递结果。`
        + this.deliveryNoticeDetail(original, delivery),
      // A failure that affects no open task is informational (wake-up table in docs/collaboration.md): the coordinator keeps it
      // as unread without a turn. A failure on an open task is the "member offline, work affected" case and wakes it.
      ...(affectsTask ? {} : { wake: [] }),
    }, original);
  }

  /**
   * Notifies an idle member sender immediately when its non-fyi message failed or hit an offline recipient, unless a
   * busy/queued state, pause, hourly notice cap, or per-(sender, recipient) cooldown applies — in all suppressed
   * cases `delivery.reported` stays 0 so the next envelope still carries it.
   */
  private notifyFailedSender(delivery: Delivery, noticeId?: string): void {
    if (!this.isRunning() || this.paused) return;
    const original = this.store.getMessage(delivery.messageId);
    if (!original || original.from === 'user' || original.from === 'system' || original.kind === 'system' || original.kind === 'plugin' || original.fyi) return;
    if (!this.store.getCluster(original.clusterId) || this.store.clusterPause(original.clusterId).paused) return;
    const sender = this.store.getMember(original.from);
    if (!sender || sender.clusterId !== original.clusterId) return;
    // A delivery report must not name a member hidden since (docs/cluster-members.md「隐身」).
    if (this.store.getMember(delivery.memberId)?.hiddenAt && !this.seesHidden(sender.clusterId, sender.id)) return;
    if (this.sessionRunning(sender) || this.confirming.has(sender.id) || this.store.queued(sender.id).length > 0) return;
    if (this.store.firstQueuedSession(sender.harness, sender.workerSessionId)) return;
    const key = this.sessionKey(sender);
    const now = Date.now();
    const noticeStarts = (this.noticeStarts.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    if (noticeStarts.length >= this.limits.maxNoticeBatchesPerHour || this.noticeThrottled.has(sender.id)) return;
    const gapMs = this.limits.failedNoticeGapMs;
    const cooldownKey = `${sender.id}\0${delivery.memberId}`;
    const last = this.failedNoticeAt.get(cooldownKey);
    if (gapMs > 0 && last !== undefined && now - last < gapMs) return;
    const members = this.store.listMembers(original.clusterId, { includeRemoved: true });
    const body = `${this.formatFailureGroup(members, original, [delivery])}\n这些投递不会自动重发。`;
    const taskIds = this.store.tasks?.links(original.id) ?? [];
    const id = noticeId ?? randomUUID();
    this.pendingSenderNotices.set(id, [delivery.id]);
    try {
      this.post(
        {
          id, clusterId: original.clusterId, from: 'system', mentions: [sender.id], body,
          replyTo: null, chainId: id, hop: 0, createdAt: new Date(now).toISOString(), kind: 'system', systemKind: 'delivery_failed',
        },
        [sender.id], false, [], taskIds,
      );
    } finally {
      const msg = this.store.getMessage(id);
      if (msg) {
        this.failedNoticeAt.set(cooldownKey, now);
        const d = this.store.withDeliveries([msg])[0]?.deliveries[0];
        if (!d || (d.state !== 'queued' && d.state !== 'running')) this.pendingSenderNotices.delete(id);
      } else {
        this.pendingSenderNotices.delete(id);
      }
    }
  }

  private checkTaskIds(clusterId: string, value: unknown): string[] {
    if (value === undefined) return [];
    const view = this.store.tasks;
    if (!view) {
      if (Array.isArray(value) && !value.length) return [];
      throw new Error('taskIds cannot be used: the tasks plugin is disabled; send the message without taskIds');
    }
    if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== 'string')) {
      throw new Error('taskIds must contain distinct tasks in this cluster');
    }
    const resolved = (value as string[]).map((ref) => (view.resolveRef ? view.resolveRef(clusterId, ref) : ref));
    if (new Set(resolved).size !== resolved.length || resolved.some((id) => !view.task(clusterId, id))) {
      throw new Error('taskIds must contain distinct tasks in this cluster');
    }
    return resolved;
  }

  private post(msg: Message, recipients: string[], direct = false, files: FileInfo[] = [], taskIds: string[] = [],
    clientMessageId?: string, sourcePluginId?: string): Message {
    if (!this.store.getCluster(msg.clusterId)) throw new Error('unknown cluster');
    if (taskIds.length && !msg.kind) msg = { ...msg, kind: 'task_comment' };
    // A native recipient's online state is decided per delivery, as it is created (docs/native-mode.md「离线」).
    const pending: Delivery[] = [];
    const notices: (() => void)[] = [];
    const event = this.store.transaction(() => {
      const deliveries = this.store.insertMessage(msg, recipients, direct, files.map((f) => f.id), clientMessageId).map((d) => this.decideOnline(d, pending));
      for (const id of taskIds) this.store.tasks?.linkMessage(msg.id, id, msg.from);
      const message = { ...msg, ...this.store.pluginFields(msg.id) };
      const event = this.store.appendEvent(msg.clusterId, null, 'message', { message, deliveries, ...(files.length ? { attachments: files } : {}),
        ...(sourcePluginId ? { sourcePluginId } : {}) });
      for (const delivery of deliveries) if (delivery.state === 'offline') {
        const notice = this.deliveryNotification(event, delivery); if (notice) notices.push(notice);
        notices.push(() => this.notifyFailedSender(delivery));
      }
      return event;
    });
    for (const d of pending) this.pending.set(d.id, d.memberId);
    // A committed plugin send must return its message id even if a subscriber or scheduling callback fails.
    const afterCommit = (effect: () => void) => {
      try { effect(); } catch (error) {
        if (!sourcePluginId) throw error;
        console.warn('Hub callback failed after a plugin message committed');
      }
    };
    try {
      this.notify(event);
      for (const notice of notices) afterCommit(notice);
    } finally {
      for (const d of pending) if (this.pending.has(d.id)) afterCommit(() => this.confirm(d.memberId));
      for (const id of recipients) afterCommit(() => this.schedule(id));
    }
    return msg;
  }

  /**
   * A new delivery to a native member: with confirmOnline it waits for a fresh check (pending; never the cache);
   * otherwise isOnline decides now and an offline member's delivery is 'offline' from the start. The start-up grace
   * keeps it queued instead. Returns the delivery as it now is.
   */
  private decideOnline(d: Delivery, pending: Delivery[]): Delivery {
    const member = this.store.getMember(d.memberId);
    if (!this.started || !member) return d;
    if (!this.nativeDelivery) return this.store.markOffline(d.id, SECONDARY_OFFLINE_ERROR);
    const native = own(this.nativeAdapters, member.harness);
    if (native?.confirmOnline) {
      pending.push(d);
      return d;
    }
    if (this.inGrace || native?.isOnline(member.workerSessionId, this.bridge)) return d;
    return this.store.markOffline(d.id, OFFLINE_ERROR);
  }

  /** Per recipient, how the message's deliveries stand (read_messages shows them to the message's sender only). */
  deliveryOutcomes(messageId: string, viewerId = 'user'): DeliveryOutcome[] {
    const msg = this.store.getMessage(messageId);
    if (!msg) return [];
    const members = this.store.listMembers(msg.clusterId, { includeRemoved: true });
    return this.deliveriesSeenBy(msg, viewerId).map((d) => ({
      to: memberLabel(members, d.memberId),
      ...outcomeOf(d),
    }));
  }

  /** Read-only: current membership and coordinator authorization are checked on every call. */
  getDeliveries(memberId: string, messageId: string): DeliveryReport {
    const member = this.store.getMember(memberId);
    const message = this.store.getMessage(messageId);
    if (!member || !message || message.clusterId !== member.clusterId) {
      throw new CollaborationError('FORBIDDEN', 'message is not in your cluster');
    }
    const coordinator = this.store.coordinator?.policy(member.clusterId);
    if (message.from !== member.id && !(coordinator?.enabled && coordinator.memberId === member.id && coordinator.permissions.deliveryControl)) {
      throw new CollaborationError('FORBIDDEN', 'only the sender or the enabled coordinator with deliveryControl may inspect deliveries');
    }
    return {
      fyi: message.fyi === true,
      deliveries: this.deliveriesSeenBy(message, memberId).map((d) => this.deliveryDetail(message, d, this.seesHidden(message.clusterId, memberId))),
    };
  }

  /** A message's deliveries as `viewerId` may see them: without those to members now hidden, unless it sees hidden members. */
  private deliveriesSeenBy(message: Message, viewerId: string): Delivery[] {
    const deliveries = this.store.withDeliveries([message])[0].deliveries;
    return this.seesHidden(message.clusterId, viewerId) ? deliveries : deliveries.filter((d) => !this.store.getMember(d.memberId)?.hiddenAt);
  }

  /** `showHidden`: only for a reader who sees hidden members; a stored notice (deliveryNoticeDetail) never names one. */
  private deliveryDetail(message: Message, delivery: Delivery, showHidden = false): DeliveryDetail {
    return {
      to: personName(this.store, message.clusterId, delivery.memberId, showHidden),
      ...outcomeOf(delivery), outcome: delivery.outcome ?? 'unknown',
      ...(delivery.error ? { reason: delivery.error } : {}),
      queuedAt: message.createdAt,
      ...this.store.deliveryTimes(delivery),
    };
  }

  /** One delivery's timeline (docs/native-mode.md). Read-only, and only the page's API serves it. */
  async deliveryTimeline(clusterId: string, deliveryId: string): Promise<DeliveryTimeline> {
    const delivery = this.store.getDelivery(deliveryId);
    const message = delivery && this.store.getMessage(delivery.messageId);
    if (!delivery || !message || message.clusterId !== clusterId) throw new Error('unknown delivery in this cluster');
    return (await this.timelines(message, [delivery]))[0];
  }

  /** Every delivery of one message, for an expanded receipt panel. */
  async messageTimelines(clusterId: string, messageId: string): Promise<DeliveryTimeline[]> {
    const message = this.store.getMessage(messageId);
    if (!message || message.clusterId !== clusterId) throw new Error('unknown message in this cluster');
    return this.timelines(message, this.store.withDeliveries([message])[0].deliveries);
  }

  /** The events of all the deliveries are aggregated in one query; only resendable deliveries ask the adapter. */
  private async timelines(message: Message, deliveries: Delivery[]): Promise<DeliveryTimeline[]> {
    const times = this.store.deliveryEventTimes(deliveries.map((d) => d.memberId));
    const acknowledged = new Map(this.store.acknowledgementsOf(message.id).map((a) => [a.memberId, a.at]));
    return Promise.all(deliveries.map(async (d) => ({
      deliveryId: d.id, messageId: d.messageId, memberId: d.memberId, batchId: d.batchId,
      state: d.state, outcome: d.outcome, error: d.error, handoffMessageId: d.handoffMessageId,
      diagnosis: deliveryDiagnosis(d, this.queuedHold(d, message)),
      stages: timelineStages(d, message, times.get(d.id) ?? {}, acknowledged.get(d.memberId) ?? null),
      resend: await this.resendOffer(d, message, times.get(d.id)?.startedAt),
    })));
  }

  private queuedHold(d: Delivery, message: Message): QueuedHold {
    const member = this.store.getMember(d.memberId);
    if (this.paused) return 'paused_global';
    if (member && this.store.clusterPause(member.clusterId).paused) return 'paused_cluster';
    if (this.pending.has(d.id)) return 'checking_online';
    if (message.from === 'system' ? this.noticeOverLimit.has(d.memberId) : this.overLimit.has(d.memberId)) return message.from === 'system' ? 'notice_limit' : 'hourly_limit';
    return member && this.sessionRunning(member) ? 'busy' : 'queued';
  }

  private async resendOffer(d: Delivery, message: Message, startedAt: string | undefined): Promise<DeliveryTimeline['resend']> {
    if (d.handoffMessageId || !deliveryUnresolved(d)) return null;
    const needsConfirmation = resendNeedsConfirmation(d, startedAt);
    const member = this.store.getMember(d.memberId);
    const blockedBy: ResendBlock | null = !member ? 'removed' : member.hiddenAt ? 'hidden' : this.resendLimit(message) ?? (await this.confirmedOnline(member) ? null : 'offline');
    return blockedBy ? { available: false, blockedBy, needsConfirmation } : { available: true, needsConfirmation };
  }

  private deliveryNoticeDetail(message: Message, delivery: Delivery): string {
    return `\n投递详情：${JSON.stringify({ messageId: message.id, ...this.deliveryDetail(message, delivery) })}`;
  }

  listMessages(clusterId: string, limit: number, before?: string): Message[] {
    return this.store.listMessages(clusterId, limit, before);
  }

  /**
   * The read_messages tool. Default: up to `limit` relevant unread messages of the member, oldest first (see
   * Store.listUnread). `history` (or a `before`): the cluster's recent `limit` messages, paged back by `before`.
   * since/until/q/sender/mentions narrow either mode (intersection); unread mode never widens the relevant set.
   * Every returned message not sent by the member becomes read by it. Reading never touches queued deliveries.
   */
  readMessages(memberId: string, opts: ReadOptions = {}): Message[] {
    const member = this.store.getMember(memberId);
    if (!member) throw new Error(`unknown member ${memberId}`);
    const limit = opts.limit ?? 20;
    const filters = this.readFilters(member, opts);
    const msgs = opts.history || opts.before !== undefined
      ? this.store.listMessages(member.clusterId, limit, opts.before, filters)
      : this.store.listUnread(member.id, member.clusterId, limit, filters);
    // Receipts and their event in one transaction: the web rebuilds read markers by replaying events.
    this.atomically((record) => this.markRead(member, msgs.filter((m) => m.from !== member.id).map((m) => m.id), 'read_messages', record));
    return msgs;
  }

  /**
   * Marks every relevant unread message at or before a point as read with via 'skip'. This is not an
   * acknowledgement: no acknowledgements are written and queued deliveries never change. Returns how many were skipped.
   * Exactly one point is required: `before` (a messageId in the member's cluster) or `until` (an ISO time).
   */
  skipUnread(memberId: string, point: { before?: string; until?: string; category?: UnreadCategory } = {}): number {
    const member = this.store.getMember(memberId);
    if (!member) throw new Error(`unknown member ${memberId}`);
    if (point.category !== undefined && !UNREAD_CATEGORIES.has(point.category)) {
      throw new Error('category must be one of mention, user, broadcast, task_notice');
    }
    const hasBefore = point.before !== undefined && point.before !== '';
    const hasUntil = point.until !== undefined && point.until !== '';
    if ((hasBefore && hasUntil) || (!hasBefore && !hasUntil && point.category === undefined)) {
      throw new Error('skip_unread needs exactly one of before or until');
    }
    let beforeRowid: number | undefined;
    let until: string | undefined;
    if (hasBefore) {
      beforeRowid = this.store.messageRowid(member.clusterId, point.before!) ?? undefined;
      if (beforeRowid === undefined) throw new Error('before must be a message in this cluster');
    } else if (hasUntil) {
      until = this.isoTime(point.until!, 'until');
    }
    const ids = this.store.unreadIds(member.id, member.clusterId, { beforeRowid, until, category: point.category });
    this.skipMessages(member, ids);
    return ids.length;
  }

  /** Marks exactly these messages read for the member, as skip_unread does. */
  skipMessages(member: StoredMember, ids: string[]): void {
    this.atomically((record) => this.markRead(member, ids, 'skip', record));
  }

  /** Validates and resolves read_messages' filters against the member's cluster; names only ever stay in that cluster. */
  private readFilters(member: StoredMember, opts: ReadOptions): MessageFilters {
    const filters: MessageFilters = {};
    if (opts.since !== undefined && opts.since !== '') filters.since = this.isoTime(opts.since, 'since');
    if (opts.until !== undefined && opts.until !== '') filters.until = this.isoTime(opts.until, 'until');
    if (opts.q !== undefined && opts.q !== '') {
      if (opts.q.length > 200) throw new Error('q must be at most 200 characters');
      filters.q = opts.q;
    }
    if (opts.sender !== undefined && opts.sender !== '') {
      filters.senderId = opts.sender === 'user' || opts.sender === 'system' ? opts.sender : this.memberByName(member.clusterId, opts.sender, member.id).id;
    }
    if (opts.mentions !== undefined && opts.mentions !== '') {
      if (opts.mentions === 'all') filters.allMentions = true;
      else filters.mentionId = this.memberByName(member.clusterId, opts.mentions, member.id).id;
    }
    if (opts.category !== undefined) {
      if (!MESSAGE_CATEGORIES.has(opts.category)) {
        throw new Error('category must be one of mention, user, broadcast, task_notice, receipt_warning, warning');
      }
      filters.category = opts.category;
      filters.categoryMemberId = member.id;
    }
    return filters;
  }

  private isoTime(value: string, name: string): string {
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) throw new Error(`${name} must be an ISO time`);
    return new Date(at).toISOString();
  }

  private memberByName(clusterId: string, name: string, viewerId: string): StoredMember {
    // A hidden member's name is unknown to whoever may not see it, like a name that matches no member.
    const all = this.visibleMembers(clusterId, viewerId, this.store.listMembers(clusterId, { includeRemoved: true }));
    const member = all.find((item) => !item.removedAt && item.name === name) ?? all.find((item) => item.name === name);
    if (!member) throw new Error(`unknown member name "${name}"`);
    return member;
  }

  /** Explicitly acknowledge other members' visible messages without changing delivery scheduling. */
  ackMessages(memberId: string, messageIds: string[]): string[] {
    const member = this.store.getMember(memberId);
    if (!member) throw new Error(`unknown member ${memberId}`);
    if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 100
        || messageIds.some((id) => typeof id !== 'string' || !id) || new Set(messageIds).size !== messageIds.length) {
      throw new Error('messageIds must contain 1 to 100 unique message IDs');
    }
    for (const id of messageIds) {
      const message = this.store.getMessage(id);
      if (!message || message.clusterId !== member.clusterId || message.from === member.id) {
        throw new Error('cannot acknowledge one or more messages');
      }
    }
    // No receipt message: the sender finds the acknowledgement on its own message (read_messages, the page's count).
    this.atomically((record) => {
      const acknowledgements = this.store.acknowledge(member.id, messageIds);
      this.markRead(member, messageIds, 'ack_messages', record);
      if (acknowledgements.length) record(member.clusterId, member.id, 'acknowledgement', { acknowledgements });
    });
    return messageIds;
  }

  /**
   * Writes the read receipts and records a `read` event for the ones that are new, and for skipped ones that now really
   * reached the member (Store.markRead): the page reads the delivery-problem count again on it.
   */
  private markRead(member: StoredMember, messageIds: string[], via: ReadVia, record: RecordEvent): void {
    const fresh = this.store.markRead(member.id, messageIds, via);
    if (fresh.length) record(member.clusterId, member.id, 'read', { memberId: member.id, messageIds: fresh, via });
  }

  // ---- limit settings: hop limit, per-chain turn limit (docs/hop-limit.md) ----

  getLimit(setting: LimitSetting): { limit: Limit; source: LimitSource } {
    const { limit, source } = this.limitSettings[setting];
    return { limit: { ...limit }, source };
  }

  /**
   * Saves a new global limit setting. Writing unlimited needs `confirmUnlimited: true` every time (a guard against
   * slips, not proof a person clicked). The setting and its event commit first; memory changes only after that succeeds.
   * Only later messages and turns see the new limit: history, queued deliveries and earlier rejections are left as they are.
   */
  setLimit(setting: LimitSetting, input: unknown, opts: { confirmUnlimited?: unknown } = {}): { limit: Limit; source: LimitSource } {
    const limit = parseLimit(input);
    if (!limit) throw new Error(`${setting} must be {"kind":"finite","value":<non-negative safe integer>} or {"kind":"unlimited"}`);
    if (limit.kind === 'unlimited' && opts.confirmUnlimited !== true) throw new Error(`an unlimited ${setting} needs confirmUnlimited: true`);
    let event: HubEvent | undefined;
    this.store.transaction(() => {
      this.store.setLimit(setting, limit);
      event = this.store.appendEvent(null, null, 'settings', { [setting]: limit, [LIMIT_SETTINGS[setting].sourceKey]: 'saved' });
    });
    this.limitSettings[setting] = { limit, source: 'saved' };
    this.notify(event!);
    return this.getLimit(setting);
  }

  // ---- coordinator notification settings (docs/collaboration.md) ----

  getNotifySetting(setting: NotifySetting): { value: number; source: 'saved' | 'default' } {
    const { value, source } = this.notifySettings[setting];
    return { value, source };
  }

  /**
   * Saves one coordinator notification setting. The setting and its event commit first; memory changes only after that
   * succeeds. Later checks use the new threshold.
   */
  setNotifySetting(setting: NotifySetting, input: unknown): { value: number; source: 'saved' | 'default' } {
    const value = parseNotifyValue(input);
    if (value === null) throw new Error(`${setting} must be a non-negative safe integer`);
    let event: HubEvent | undefined;
    this.store.transaction(() => {
      this.store.saveNumber(NOTIFY_SETTINGS[setting].key, value);
      event = this.store.appendEvent(null, null, 'settings', { [setting]: value, [NOTIFY_SETTINGS[setting].sourceKey]: 'saved' });
    });
    this.notifySettings[setting] = { value, source: 'saved' };
    this.stalledAfterMs = value * 60_000;
    this.notify(event!);
    return this.getNotifySetting(setting);
  }

  // ---- pause ----

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.emit(null, null, 'pause', { paused });
    if (!paused) this.scheduleAll();
  }

  nativeDeliveryEnabled(): boolean {
    return this.nativeDelivery;
  }

  setSecondaryNativeDelivery(enabled: boolean): void {
    if (!this.secondary) throw new Error('Only a secondary Hub can change this setting');
    if (this.nativeDelivery === enabled) return;
    this.store.saveNumber('secondary_native_delivery', enabled ? 1 : 0);
    this.nativeDelivery = enabled;
    for (const member of this.store.listMembers()) this.emitMember(member);
    this.scheduleAll();
  }

  // ---- scheduling ----

  private scheduleAll(): void {
    for (const m of this.store.listMembers()) this.schedule(m.id);
  }

  /** Wake all bindings; schedule() picks the oldest queued delivery of their shared conversation. */
  private scheduleSession(member: StoredMember): void {
    for (const m of this.sessionMembers(member)) this.schedule(m.id);
  }

  /**
   * Starts the member's next run if it may: one run at a time per conversation. A run delivers the oldest
   * queued delivery together with the queued ones after it (a batch), counted as one turn for the per-hour limit unless
   * every delivery in it is a system notification (docs/collaboration.md). A burst of system notifications first waits
   * noticeWindowMs so it runs as one turn; a user message flushes that wait. Member and plugin messages with no user
   * message queued wait until messageWindowMs after the oldest of them was created, so what arrives meanwhile joins
   * the same turn; a user message ends that wait at once too. A direct message (no
   * envelope) always runs alone, and a batch stops before one, so order is kept. New batches have a message-count cap.
   * A batch interrupted by a restart ends unknown instead of being automatically sent again.
   * A member found offline (its harness missing counts too) gets nothing later: its queued deliveries end
   * 'offline', even while paused, busy or throttled (with confirmOnline: once a fresh check confirms it). Exception:
   * the start-up grace, where they stay queued. A pending delivery (see decideOnline) never runs, and a batch stops
   * before one, so order is kept. `confirmed`: confirmOnline just said online.
   */
  private schedule(memberId: string, confirmed = false): void {
    if (!this.started || this.closed) return;
    const member = this.store.getMember(memberId);
    if (!member) return;
    if (!this.nativeDelivery) {
      this.dropOffline(member, this.store.queued(memberId).map((q) => q.id), SECONDARY_OFFLINE_ERROR);
      return;
    }
    const native = own(this.nativeAdapters, member.harness);
    if (!confirmed && !native?.isOnline(member.workerSessionId, this.bridge)) {
      if (native?.confirmOnline) this.confirmQueued(member, native);
      else if (!this.inGrace) this.dropOffline(member, this.store.queued(memberId).map((q) => q.id));
      return;
    }
    if (!native) {
      this.dropOffline(member, this.store.queued(memberId).map((q) => q.id));
      return;
    }
    if (this.paused || this.store.clusterPause(member.clusterId).paused || this.sessionRunning(member)) return;
    // Keep FIFO among unpaused clusters without batching past a sibling membership.
    const sharedHead = this.store.firstQueuedSession(member.harness, member.workerSessionId);
    if (sharedHead && sharedHead.memberId !== memberId) {
      this.schedule(sharedHead.memberId);
      return;
    }
    const key = this.sessionKey(member);
    const now = Date.now();
    const starts = (this.turnStarts.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    const hourlyLimit = this.hourlyTurnLimit(member);
    const limited = this.throttled.has(memberId) || starts.length >= hourlyLimit;
    const { limit: chainLimit } = this.limitSettings.maxTurnsPerChain;
    const direct = (q: QueuedCandidate) => q.direct && !this.store.tasks?.links(q.message.id).length;
    // A runnable direct user message cannot join a batch or wait for another message. No need to read the tail.
    const fastHead = sharedHead && !this.pending.has(sharedHead.id) && !sharedHead.batchId && !limited
      && sharedHead.message.from === 'user' && direct(sharedHead)
      && (chainLimit.kind === 'unlimited' || this.store.countChainTurns(sharedHead.message.chainId) < chainLimit.value)
      ? sharedHead : null;
    const before = sharedHead && !fastHead ? this.store.firstQueuedSession(member.harness, member.workerSessionId, memberId)?.id : undefined;
    const all = fastHead ? [fastHead] : !sharedHead ? [] : this.store.queuedCandidates(memberId, before);
    const cut = all.findIndex((q) => this.pending.has(q.id));
    const queue = cut < 0 ? all : all.slice(0, cut);
    const chainTurns = new Map<string, number>();   // chain id -> turns started, counting the ones this run adds
    const tried = new Set<string>();                // deliveries this call already failed on their chain turn limit
    const turnsOf = (chainId: string) => chainTurns.get(chainId) ?? this.store.countChainTurns(chainId);
    /** Whether the delivery's chain may take another turn; if not, the delivery fails with a guard event. */
    // Unlimited skips only this check; turns are still counted per chain (deliveries' attempts).
    const fits = (q: QueuedCandidate): boolean => {
      if (chainLimit.kind === 'unlimited' || turnsOf(q.message.chainId) < chainLimit.value) return true;
      tried.add(q.id);
      const notices: (() => void)[] = [];
      this.atomically((record) => {
        const delivery = this.store.setDeliveryState(q.id, 'failed', CHAIN_LIMIT_ERROR);
        this.pendingSenderNotices.delete(delivery.messageId);
        const event = record(member.clusterId, memberId, 'delivery', { delivery });
        record(member.clusterId, memberId, 'guard', {
          reason: 'max_turns_per_chain', chainId: q.message.chainId, maxTurnsPerChain: chainLimit.value,
        });
        const notice = this.deliveryNotification(event, delivery);
        if (notice) notices.push(notice);
        notices.push(() => this.notifyFailedSender(delivery));
      });
      // Scheduling a notice here could re-enter this queue before its batch has been selected.
      if (notices.length) queueMicrotask(() => {
        for (const publish of notices) {
          try { publish(); } catch { /* already committed; the notice's finally still schedules its deliveries */ }
        }
      });
      return false;
    };
    const take = (q: QueuedCandidate) => chainTurns.set(q.message.chainId, turnsOf(q.message.chainId) + 1);
    // Fail deliveries whose chain is over its turn limit until one may run (a loop: thousands can pile up).
    let i = 0;
    while (i < queue.length && !fits(queue[i])) i++;
    // Every queued delivery after the chain-limit guards is over the chain cap (or the queue is empty): nothing can
    // run for this member. Keep the rebind/removal handling we inherited from the delivery improvements.
    if (!queue[i]) {
      if (i > 0) queueMicrotask(() => {
        const current = this.store.getMember(memberId);   // a rebind or removal may have got in first
        if (current) this.emitMember(current);
        this.scheduleSession(member); // a guard may expose a sibling without recursive guard failures
      });
      this.clearNoticeWait(key);
      return;
    }
    // At the hourly cap a member may still take a batch of system notifications (docs/collaboration.md). While the cap
    // holds, pick the queued system notifications out of the queue; the member and user messages stay queued as before.
    /** The member messages are over the hourly cap: one guard per limit in force, and a recheck. */
    const holdTurns = () => {
      this.turnStarts.set(key, starts);
      if (this.throttled.has(memberId)) return;
      // Once per over-limit run, and again if the identity changed the cap meanwhile: the event always names the
      // number in force now, not the one reported before a handover or a disable.
      if (this.overLimit.get(memberId) !== hourlyLimit) {
        this.overLimit.set(memberId, hourlyLimit);
        this.emit(member.clusterId, memberId, 'guard', { reason: 'max_turns_per_hour', maxTurnsPerHour: hourlyLimit });
      }
      this.throttled.set(memberId, setTimeout(() => {
        this.throttled.delete(memberId);
        this.schedule(memberId);
      }, this.limits.recheckMs));
    };
    let first: QueuedCandidate | undefined;
    let followers: QueuedCandidate[] = [];
    if (limited) {
      const systems = queue.slice(i).filter((q) => q.message.from === 'system');
      let j = 0;
      while (j < systems.length && !fits(systems[j])) j++;
      first = systems[j];
      followers = systems.slice(j + 1);
    } else {
      first = queue[i];
    }
    if (!first) {
      if (limited && queue[i]) holdTurns();   // no system notification to run: the member messages are over the cap
      else {
        this.clearNoticeWait(key);
        if (i > 0) queueMicrotask(() => this.scheduleSession(member)); // a guard may expose a sibling without recursive guard failures
      }
      return;
    }

    /** Takes the batch starting at queue[start]: that delivery and the ones that may join it (a direct message runs alone). */
    const takeBatch = (start: number): QueuedCandidate[] => {
      const head = queue[start];
      const batch = [head];
      take(head);
      if (!head.batchId && direct(head)) return batch;
      for (let index = start + 1; index < queue.length; index++) {
        const q = queue[index];
        if (head.batchId) {
          if (q.batchId !== head.batchId) continue;
        } else if (batch.length >= MAX_NEW_BATCH_MESSAGES || q.batchId || direct(q)) break;
        if (fits(q)) {
          batch.push(q);
          take(q);
        }
      }
      return batch;
    };
    let firstDirect = direct(first);
    let batch: QueuedCandidate[];
    if (limited) {
      batch = [first];
      take(first);
      for (const q of followers) {
        if (first.batchId ? q.batchId !== first.batchId : Boolean(q.batchId)) continue;
        if (!first.batchId && batch.length >= MAX_NEW_BATCH_MESSAGES) break;
        if (fits(q)) {
          batch.push(q);
          take(q);
        }
      }
    } else {
      batch = takeBatch(i);
    }

    // A batch of system notifications alone is not a turn for the per-hour limit, for the coordinator and an ordinary
    // member alike. Any member or user message in it makes it one turn, and its identity's cap applies as before.
    let counted = batch.some((q) => q.message.from !== 'system');
    // Those system-only batches have a separate hourly cap of their own (docs/collaboration.md). At the cap they stay
    // queued and are retried by the recheck; member and user messages do not enter this count and are not held by it.
    const noticeStarts = (this.noticeStarts.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    const noticeLimit = this.limits.maxNoticeBatchesPerHour;
    if (!counted && noticeStarts.length >= noticeLimit) {
      this.clearNoticeWait(key);
      if (limited) {
        // The member messages are still over the turn cap when the member is limited: keep their guard and recheck too.
        if (queue.some((q) => q.message.from !== 'system')) holdTurns();
      } else {
        // The cap holds this system-only batch, not the member and user messages behind it: run the next one on its
        // own (a direct message still runs alone, a batchId group keeps its rules) and leave the capped batch queued.
        chainTurns.clear();   // the held batch is not part of the run chosen here
        let next = i;
        while (next < queue.length && (queue[next].message.from === 'system' || tried.has(queue[next].id) || !fits(queue[next]))) next++;
        if (next < queue.length) {
          first = queue[next];
          batch = takeBatch(next);
          firstDirect = direct(first);
          counted = batch.some((q) => q.message.from !== 'system');   // it starts with a member or user message
        }
      }
      // Once per limit in force, like the turn cap; the next system batch that runs clears it again.
      if (this.noticeOverLimit.get(memberId) !== noticeLimit) {
        this.noticeOverLimit.set(memberId, noticeLimit);
        this.emit(member.clusterId, memberId, 'guard', { reason: 'max_notice_batches_per_hour', maxNoticeBatchesPerHour: noticeLimit });
      }
      if (!this.noticeThrottled.has(memberId)) {
        this.noticeThrottled.set(memberId, setTimeout(() => {
          this.noticeThrottled.delete(memberId);
          this.schedule(memberId);
        }, this.limits.recheckMs));
      }
      if (!counted) return;
    }
    // A burst of system notifications waits one short window per conversation so it runs as one turn. When member or
    // user messages could run too, they must not be delayed: the wait ends and they join the batch, which counts.
    const mayWait = !counted && (limited || queue.slice(i).every((q) => q.message.from === 'system'));
    const waiting = this.noticeWaits.get(key);
    // Member and plugin messages wait one window, measured from the oldest of them in this batch (later arrivals do
    // not extend it), so what arrives meanwhile runs in the same turn. A queued user message is never delayed, nor is
    // a direct message or a batchId group at the head. The timer only re-runs this method, which decides again.
    const heldUntil = counted && this.limits.messageWindowMs > 0 && !firstDirect && !first.batchId
      && !queue.slice(i).some((q) => q.message.from === 'user')
      ? Math.min(...batch.filter((q) => q.message.from !== 'system').map((q) => Date.parse(q.message.createdAt))) + this.limits.messageWindowMs : 0;
    if (heldUntil > Date.now()) {
      if (waiting?.deadline !== heldUntil) {
        this.clearNoticeWait(key);
        const timer = setTimeout(() => {
          const pending = this.noticeWaits.get(key);
          if (pending) pending.deadline = 0;   // as below: a timer that fires a moment early must not leave a system-only queue waiting
          if (!this.closed) this.schedule(memberId);
        }, heldUntil - Date.now());
        timer.unref();
        this.noticeWaits.set(key, { deadline: heldUntil, timer });
      }
      return;
    }
    if (waiting) {
      if (mayWait && Date.now() < waiting.deadline) return;
      this.clearNoticeWait(key);
    } else if (mayWait && this.limits.noticeWindowMs > 0) {
      const timer = setTimeout(() => {
        const pending = this.noticeWaits.get(key);
        if (pending) pending.deadline = 0;   // the timer's own schedule call must not start a second window
        if (!this.closed) this.schedule(memberId);
      }, this.limits.noticeWindowMs);
      timer.unref();
      this.noticeWaits.set(key, { deadline: Date.now() + this.limits.noticeWindowMs, timer });
      return;
    }
    // The queued member messages are still over the cap: keep the guard and the recheck, even though this batch runs.
    if (limited && queue.some((q) => q.message.from !== 'system')) holdTurns();
    const messages = batch.map((q) => this.store.getMessage(q.message.id)!);
    const batchId = first.batchId ?? first.id;
    const { deliveries, events, statuses } = this.store.transaction(() => {
      const events: HubEvent[] = [];
      const deliveries = batch.map((q) => {
        const delivery = this.store.startDelivery(q.id, batchId);
        events.push(this.store.appendEvent(member.clusterId, memberId, 'delivery', { delivery }));
        return delivery;
      });
      const statuses = this.sessionMembers(member).map((sibling) => {
        const busy = this.withStatus(sibling, true);
        events.push(this.store.appendEvent(busy.clusterId, busy.id, 'member', { member: busy }));
        return { busy, before: this.shown.get(busy.id) };
      });
      return { deliveries, events, statuses };
    });

    if (counted) {
      starts.push(now);
      this.turnStarts.set(key, starts);
      this.overLimit.delete(memberId);
    } else {
      noticeStarts.push(now);
      this.noticeStarts.set(key, noticeStarts);
      this.noticeOverLimit.delete(memberId);
    }

    const run: Running = {
      batchId,
      sessionKey: key,
      deliveries,
      messages,
      abort: new AbortController(),
      startedAt: now,
      counted,
      sentMcpMessage: false,
      told: { ids: [], notes: 0 },
      waiting: null,
      queueWarned: false,
    };
    // A listener can reenter the Hub. Publish only after the whole start committed and the session is reserved.
    this.running.set(memberId, run);
    for (const { busy } of statuses) this.shown.set(busy.id, busy.status);
    this.publishEvents(events);
    for (const { busy, before } of statuses) this.notifyMemberStatus(busy, before);
    // After startDelivery: the unseen count in the envelope leaves out what this run delivers.
    let input: string;
    try {
      if (firstDirect) input = this.directText(run.messages[0], member);
      else {
        const notice = this.undeliveredNotice(member, run.messages);
        const toolHint = this.toolList?.hint(member.id) ?? '';
        run.told = { ...notice.told, toolHint: toolHint !== '' };
        input = this.envelope(run.messages, member, notice.text + toolHint);
      }
    } catch (e) {
      // The run is already marked; ending it here releases the member, so later messages still go out.
      this.finish(member, run, 'failed', `投递内容没能生成：${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const p = this.deliverNative(member, native, run, input)
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Every queued delivery of the member becomes pending and gets a fresh check (the cache said offline, or a restart). */
  private confirmQueued(member: StoredMember, native: NativeAdapter): void {
    for (const q of this.store.queued(member.id)) this.pending.set(q.id, member.id);
    this.confirm(member.id, native);
  }

  /**
   * Asks confirmOnline about the member's pending deliveries, one check at a time per member. A check decides only the
   * deliveries that were pending when it started, so a stale answer never decides a newer delivery: those get the next
   * check. Offline → they end 'offline'; online (or a failed check: unknown, deliver has the last word) → plain queued.
   */
  private confirm(memberId: string, native = this.nativeOf(memberId)): void {
    if (this.closed || this.confirming.has(memberId) || !native?.confirmOnline) return;
    const member = this.store.getMember(memberId);
    const ids = [...this.pending].filter(([, m]) => m === memberId).map(([id]) => id);
    if (!member || !ids.length) return;
    this.confirming.add(memberId);
    const p: Promise<void> = native.confirmOnline(member.workerSessionId).catch(() => true).then((online) => {
      this.confirming.delete(memberId);
      const current = this.store.getMember(memberId);
      // Moved meanwhile: the answer is about the old conversation, so the still-pending deliveries get a check of the new one.
      if (!this.closed && current && this.sessionKey(current) !== this.sessionKey(member)) return this.confirm(memberId, native);
      for (const id of ids) this.pending.delete(id);
      if (this.closed || !current) return;
      if (!online) this.dropOffline(member, ids);
      this.confirm(memberId, native);
      this.schedule(memberId, online);
    }).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  private nativeOf(memberId: string): NativeAdapter | undefined {
    const m = this.store.getMember(memberId);
    return m ? own(this.nativeAdapters, m.harness) : undefined;
  }

  /** Ends those of `ids` that are still queued 'offline' (terminal; the messages stay unread for the member). */
  private dropOffline(member: StoredMember, ids: string[], reason = OFFLINE_ERROR): void {
    const queued = new Set(this.store.queued(member.id).map((q) => q.id));
    let dropped = false;
    const notices: (() => void)[] = [];
    this.atomically((record) => {
      for (const id of ids) {
        if (queued.has(id)) {
          dropped = true;
          const delivery = this.store.markOffline(id, reason);
          this.pendingSenderNotices.delete(delivery.messageId);
          const event = record(member.clusterId, member.id, 'delivery', { delivery });
          const notice = this.deliveryNotification(event, delivery); if (notice) notices.push(notice);
          notices.push(() => this.notifyFailedSender(delivery));
        }
      }
    });
    for (const notice of notices) notice();
    if (dropped) this.emitMember(member);
    if (dropped) queueMicrotask(() => this.scheduleSession(member));
  }

  private agentEvents(member: StoredMember, run: Running): (event: AgentEvent) => void {
    return (event) => {
      // A batch's agent output is attributed to its first delivery.
      if (!this.closed && !this.detached.has(run) && this.store.getMember(member.id)) {
        this.emit(member.clusterId, member.id, 'agent', { deliveryId: run.deliveries[0].id, messageId: run.messages[0].id, event });
      }
    };
  }

  /** One native delivery: 'accepted' / 'completed' → done, 'offline' → offline (never retried), a throw → failed. */
  private async deliverNative(member: StoredMember, adapter: NativeAdapter, run: Running, input: string): Promise<void> {
    if (!this.nativeDelivery) {
      this.finish(member, run, 'offline', SECONDARY_OFFLINE_ERROR);
      return;
    }
    let state: 'done' | 'failed' | 'offline';
    let error: string | null = null;
    let outcome: DeliveryResult | null = null;
    try {
      const from = [...new Set(run.messages.map((m) => (m.from === 'user' ? 'user' : personName(this.store, member.clusterId, m.from, this.seesHidden(member.clusterId, member.id)))))];
      // The turn's answer as the member's message (adapters with `replies`), like any message a member sends:
      // @ routing, hop and turn limits and the pause switch apply. It continues the chain of the batch's newest message.
      const reply = adapter.replies ? (text: string) => this.postReply(member, run, text) : undefined;
      const r = await adapter.deliver(member.workerSessionId, input, {
        deliveryId: run.batchId, bridge: this.bridge, onEvent: this.agentEvents(member, run), signal: run.abort.signal, from,
        ...(reply ? { reply } : {}),
        usage: (totals) => this.usage.recordTurn(member, run.batchId, totals),
        waiting: (state) => {
          const warned = run.waiting !== null && run.queueWarned;
          run.waiting = state;
          // Not for a run detached by a rebind: `member` still names the old conversation.
          if (warned && !state && !this.closed && this.running.get(member.id) === run && this.store.getMember(member.id)) this.emitMember(member);
        },
      });
      if (r === 'accepted' || r === 'completed') { state = 'done'; outcome = r; }
      else if (r === 'offline') state = 'offline';
      else if (typeof r === 'object' && (r.outcome === 'failed' || r.outcome === 'unknown') && typeof r.error === 'string') {
        state = 'failed';
        outcome = r.outcome;
        error = r.error;
      }
      else throw new Error(`native adapter returned ${JSON.stringify(r)}`);
    } catch (e) {
      state = 'failed';
      error = e instanceof Error ? e.message : String(e);
    }
    this.finish(member, run, state, error, outcome);
  }

  /**
   * A native turn's answer, unless this run already sent an MCP message. A rejection (e.g. the hop limit, or a gate
   * plugin's refusal) posts nothing. Without a gate plugin the answer is written within this call; with one it is
   * written once the plugins answered (at most their timeout later), even if the run has ended meanwhile.
   */
  private postReply(member: StoredMember, run: Running, text: string): void {
    if (this.closed || run.sentMcpMessage || !text.trim() || this.running.get(member.id) !== run || !this.store.getMember(member.id)) return;
    if (this.store.getMember(member.id)?.hiddenAt) return;   // hidden during the turn: its answer is not posted
    this.sendFromMemberGated(member.id, text, run.messages.at(-1)!.id).catch((e: unknown) => {
      if (this.closed) return;
      // The hop limit already emitted its guard event; anything else is shown on the member's page. The member itself
      // learns it from its next envelope (it has no tool that would tell it).
      const why = e instanceof Error ? e.message : String(e);
      this.agentEvents(member, run)({ type: 'error', message: `回答没有发到群里：${why}` });
      this.replyNotes.set(member.id, [...(this.replyNotes.get(member.id) ?? []), why]);
    });
  }

  private finish(member: StoredMember, run: Running, state: 'done' | 'failed' | 'offline', error: string | null, outcome: DeliveryResult | null = null): void {
    // On shutdown leave 'running' for recovery to record its unknown result atomically.
    if (this.closed) return;
    for (const m of run.messages) this.pendingSenderNotices.delete(m.id);
    if (this.detached.delete(run)) {
      // The member has moved on (`member` still names the old conversation): this run only freed that conversation.
      this.emitSessionMembers(member);
      this.scheduleSession(member);
      return;
    }
    this.running.delete(member.id);
    const historic = this.store.getMember(member.id, { includeRemoved: true });
    const deletedCluster = this.store.getCluster(member.clusterId, { includeDeleted: true })?.deletedAt;
    if (!this.store.getMember(member.id) && (!deletedCluster || historic?.removedAt)) {
      // A late completion cannot undo cancellation, but releasing the shared channel must wake its other bindings.
      this.emitSessionMembers(member);
      this.scheduleSession(member);
      return;
    }
    if (state === 'offline') {
      // Nothing reached the member: neither a turn nor a system-notice batch for the hourly limits (markOffline also
      // gives back the chain attempt).
      const starts = (run.counted ? this.turnStarts : this.noticeStarts).get(this.sessionKey(member));
      const i = starts?.indexOf(run.startedAt) ?? -1;
      if (i >= 0) starts!.splice(i, 1);
    }
    // The batch's final states and, when done, its read receipts: one transaction, so a crash cannot leave
    // done deliveries whose messages still count as unread.
    const notices: (() => void)[] = [];
    this.atomically((record) => {
      for (const d of run.deliveries) {
        const delivery = state === 'offline' ? this.store.markOffline(d.id, error ?? OFFLINE_ERROR) : this.store.setDeliveryState(d.id, state, error, outcome);
        const event = record(member.clusterId, member.id, 'delivery', { delivery });
        if (state === 'failed' || state === 'offline') {
          const notice = this.deliveryNotification(event, delivery); if (notice) notices.push(notice);
          notices.push(() => this.notifyFailedSender(delivery));
        }
      }
      if (state === 'done') {
        this.markRead(member, run.messages.map((m) => m.id), 'delivery', record);
        this.store.markReported(run.told.ids);
      }
    });
    for (const notice of notices) notice();
    // Notes added meanwhile come after the ones this run told.
    if (state === 'done' && run.told.notes) this.replyNotes.get(member.id)?.splice(0, run.told.notes);
    if (state === 'done' && run.told.toolHint) this.toolList?.told(member.id);
    this.emitSessionMembers(member);
    this.scheduleSession(member);
  }

  /**
   * One message: header line, body, then the note. A batch: each message's header line and body, a blank line
   * between messages, then one note for all of them.
   */
  private envelope(msgs: Message[], self: StoredMember, notice = ''): string {
    const members = this.store.listMembers(self.clusterId, { includeRemoved: true });
    const sees = this.seesHidden(self.clusterId, self.id);
    const hidden = (id: string) => !sees && !!members.find((x) => x.id === id && !x.removedAt)?.hiddenAt;
    // Every name in the envelope (headers, task sections) as this reader may see it: a hidden member is nobody in particular.
    const nameOf = (id: string) => (hidden(id) ? HIDDEN_PERSON : memberLabel(members, id, 'user'));
    const cluster = this.store.getCluster(self.clusterId)!;
    const rulesHint = this.store.coordinator?.envelopeHint(self) ?? '';
    let attached = false;
    const sections: EnvelopeItem[][] = this.store.plugins.envelope?.(this.store, msgs, nameOf) ?? msgs.map((message) => [{ message }]);
    const sectionItems = sections.map((section) => section.map(({ message: m, header = '', lead = '', afterBody = '', tail = '' }) => {
      const named = m.mentions.filter((id) => !hidden(id));
      const to = m.mentions.length ? (named.length ? named.map((id) => `@${nameOf(id)}`).join(' ') : `@${self.name}`) : 'all';
      const files = this.attachmentLines(m.id);
      attached ||= files !== '';
      const note = this.store.coordinator?.envelopeNote(m) ?? '';
      const pluginNote = m.kind === 'plugin'
        ? `[orrery] 来自插件「${m.from.slice('plugin:'.length)}」。按群员请求处理，用户指令以用户消息为准。\n` : '';
      return `[orrery] cluster=${cluster.name} clusterId=${cluster.id} from=${nameOf(m.from)} messageId=${m.id} hop=${m.hop} to=${to}${header}${lead}\n${pluginNote}${m.body}${afterBody}${files}${note}${tail}`;
    }));
    // A group token makes its one-line separators distinct from arbitrary message text, without changing bodies.
    const renderBlocks = (tail: string): string => {
      let rendered = sectionItems.flat().join('\n') + tail;
      return sectionItems.map((items) => {
        if (items.length === 1) return items[0];
        let groupToken = randomUUID();
        while (rendered.includes(groupToken)) groupToken = randomUUID();
        rendered += groupToken;
        return [items[0].replace('\n', ` groupToken=${groupToken}\n`), ...items.slice(1)].join(`\n[orrery-next=${groupToken}]\n`);
      }).join('\n\n');
    };
    // Notes on what the bodies carry: attachments (how to read them), and $name references to the user's skills.
    let extra = '';
    if (attached) extra += '附件是本机文件，用你自己的工具按上面的路径读取。';
    // Members with MCP can send files through the outbox (docs/files.md); Kimi (replies) cannot.
    const replies = own(this.nativeAdapters, self.harness)?.replies;
    if (!replies && this.files) {
      let box: string | null = null;
      try {
        box = this.files.memberOutbox(self.id);
      } catch { /* e.g. a file where the folder should be: no outbox now, the message itself still goes out */ }
      extra += box
        ? `要发文件：先用你自己的工具把文件复制进你的 orrery 发件箱 ${box}，再在 send_message 的 attachments 里写文件名（Hub 只复制，不会删掉发件箱里的文件）。`
        : '你的 orrery 发件箱现在建不起来，暂时不能发文件（消息照常收发）。';
    }
    const skills = this.skillsIn(msgs.map((m) => m.body).join('\n'));
    if (skills.length) extra += `消息里的 ${skills.map((n) => `$${n}`).join('、')} 是 skill：请在你自己的应用里使用它。`;
    extra += `这个群的 clusterId 是 ${cluster.id}；调用 orrery 工具时可带 clusterId 指定群。`;
    extra += notice;
    // Check sender liveness by memberId so display labels like （已移出） never turn into @target instructions.
    const isNonMemberSender = (m: Message) => m.from === 'user' || m.from === 'system' || m.kind === 'plugin';
    const senderOf = (m: Message): StoredMember | null => (
      isNonMemberSender(m) ? null : members.find((x) => x.id === m.from) ?? null
    );
    const isRemovedSender = (m: Message) => {
      if (isNonMemberSender(m)) return false;
      const sender = senderOf(m);
      return !sender || Boolean(sender.removedAt);
    };
    const removedSenders = [...new Set(msgs.filter(isRemovedSender).map((m) => nameOf(m.from)))];
    let how: string;
    if (msgs.length === 1) {
      const m = msgs[0];
      const sender = senderOf(m);
      if (isNonMemberSender(m)) {
        // Only a member can receive an @ reply. Replies to users/system/plugins stay without @target.
        how = `要让某人收到，正文里写 @名字，回复这条请带 replyTo=${m.id}。`;
      } else if (!sender || sender.removedAt) {
        how = `要让某人收到，正文里写 @名字；原发送者 ${nameOf(m.from)} 已移出群聊、无法再接收消息（请勿按展示名 @ 它，以免误发给同名在群成员），请另选当前收件人写 @名字 并带 replyTo=${m.id}。`;
      } else {
        how = `要让某人收到，正文里写 @名字，回复这条请写 @${sender.name} 并带 replyTo=${m.id}。`;
      }
    } else {
      const removedBatchNote = removedSenders.length
        ? `其中 ${removedSenders.join('、')} 已移出群聊、无法再接收消息，请改选当前收件人，勿按「（已移出）」@ 以免误发同名新成员。`
        : '';
      how = `要让某人收到，正文里写 @名字。上面共 ${msgs.length} 条消息，回复哪一条就带 replyTo=那条的 messageId；回复仍在群的成员还要写 @发送者名字（已移出成员无法接收消息，请另选当前收件人）。${removedBatchNote}`;
    }
    // A replies member may have direct MCP tools; without them its plain-text answer is its message.
    if (replies) {
      // It has no list_agents, so the note tells it who it can @.
      const others = members.filter((x) => !x.removedAt && x.id !== self.id && !hidden(x.id)).map((x) => `@${x.name}（${x.harness}）`);
      const removedRepliesNote = removedSenders.length
        ? `其中原发送者 ${removedSenders.join('、')} 已移出，无法再接收消息，请从上面的当前成员列表选择收件人，勿按「（已移出）」@ 以免误发同名新成员。`
        : '';
      const tail = `（你是群员 ${self.name}。群里现在的其他成员：${[...others, '@user 是你的用户'].join('、')}。`
        + '有 ack_messages 工具时，看到消息用 ack_messages 确认（👍 即收到），不要为确认单独发言；有 MCP 工具时可调用 send_message 发言、read_messages 读消息；这一轮已用 send_message 发言时，不再代发回答。'
        + '没有这些工具时，你这一轮的回答会原样作为你的发言发到群里；要让某人收到，回答里写 @名字（回复仍在群的成员写 @发送者名字；已移出成员无法接收消息，请另选当前收件人）。'
        + `不 @ 人的回答只留在记录里。${removedRepliesNote}没有这些工具时，无法主动确认，只能回答投给你的消息，不能主动发言，也读不到群里别的消息。${extra}）${rulesHint}`;
      return `${renderBlocks(tail)}\n\n----------\n${tail}`;
    }
    const unseen = this.store.unreadBreakdown(self.id, self.clusterId, { excludeInFlight: true });
    const unseenHint = unseen.total ? `群里还有${formatUnreadSummary(unseen)}，可用 read_messages 查看。` : '';
    // The dashes set orrery's note apart from the body; the blank line keeps markdown from reading them as a heading underline.
    const tail = `（你是群员 ${self.name}。有 ack_messages 工具时，看到消息用 ack_messages 确认（👍 即收到），不要为确认单独发言；只有提问、交结果、报阻塞或请别人做事时才用 send_message；任务结果和证据写进 task_action submit 的 summary，Hub 会通知验收人，不用另外 @；需要改派或流程卡住时才 @ 协调员；回答别人问你的问题不要带 fyi；只是知会、不需要对方行动的发言带 fyi=true（对方只留未读，不被唤醒）；${how}`
      + `不 @ 人的发言只留在群聊记录里。${unseenHint}${extra}）${rulesHint}`;
    return `${renderBlocks(tail)}\n\n----------\n${tail}`;
  }

  /**
   * The member's own messages that did not get through to someone (failed, blocked by a guard, offline) and that no
   * delivered envelope has told it about yet, one sentence per message (the newest NOTICE_MESSAGES; older ones only
   * counted); for a replies member also its answers the Hub did not post. `told` is marked when the run ends done.
   */
  private formatFailureGroup(members: StoredMember[], m: Message, ds: Delivery[]): string {
    const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
    const flat = m.body.replace(/\s+/g, ' ').trim();
    const what = flat ? `「${cut(flat, 20)}」` : '（只有附件）';
    const who = ds.map((d) => {
      const name = d.memberId === 'user' ? memberLabel(members, d.memberId, 'user') : personName(this.store, m.clusterId, d.memberId);   // also stored in a notice
      const o = outcomeOf(d);
      const why = o.outcome === 'unknown' ? `结果未知，可能已送达或仍会执行：${cut(o.reason ?? '原因不明', NOTICE_REASON_MAX)}`
        : o.status === 'offline' ? '离线，未投递' : `${o.status === 'blocked' ? '被拦下' : '投递流程失败'}：${cut(o.reason ?? '原因不明', NOTICE_REASON_MAX)}`;
      return `${name}（${why}）`;
    });
    let text = `你之前发的消息${what}（messageId ${m.id}）的投递结果：${who.join('、')}。`;
    for (const d of ds) text += this.deliveryNoticeDetail(m, d);
    return text;
  }

  /**
   * Notice at the top of an envelope for failures and unknown outcomes on the member's own messages (reported = 0, once
   * counted); for a replies member also its answers the Hub did not post. `told` is marked when the run ends done.
   */
  private undeliveredNotice(self: StoredMember, batch: Message[] = []): { text: string; told: Running['told'] } {
    const allFailed = this.store.unreported(self.id);
    const covered = new Set<string>();
    for (const m of batch) for (const id of this.pendingSenderNotices.get(m.id) ?? []) covered.add(id);
    // Not about members hidden since, unless this is the coordinator: they are counted as told and never named.
    const sees = this.seesHidden(self.clusterId, self.id);
    const failed = allFailed.filter((d) => !covered.has(d.id) && (sees || !this.store.getMember(d.memberId)?.hiddenAt));
    const notes = this.replyNotes.get(self.id) ?? [];
    const told = { ids: allFailed.map((d) => d.id), notes: notes.length };
    const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
    let text = '';
    if (failed.length) {
      const members = this.store.listMembers(self.clusterId, { includeRemoved: true });
      const byMessage = new Map<string, typeof failed>();
      for (const d of failed) byMessage.set(d.messageId, [...(byMessage.get(d.messageId) ?? []), d]);
      const groups = [...byMessage.values()];
      const shown = groups.slice(-NOTICE_MESSAGES);
      for (const ds of shown) text += `${this.formatFailureGroup(members, ds[0].message, ds)}\n`;
      if (groups.length > shown.length) text += `另有 ${groups.length - shown.length} 条你发的消息存在失败或结果未知的投递。`;
      text += '这些投递不会自动重发。';
    }
    if (notes.length === 1) text += `你上一轮的回答没有发到群里：${cut(notes[0], NOTICE_REASON_MAX)}。`;
    else if (notes.length > 1) text += `你最近有 ${notes.length} 轮的回答没有发到群里，最近一次：${cut(notes.at(-1)!, NOTICE_REASON_MAX)}。`;
    return { text, told };
  }

  /** A direct message (member page, native member, no envelope): the body as typed, then its attachment lines. */
  private directText(msg: Message, self: StoredMember): string {
    const files = this.attachmentLines(msg.id);
    return msg.body.trim() ? msg.body + files : files.trimStart();
  }

  /** One line per attachment, after a message's body: name, size and the local path. */
  private attachmentLines(messageId: string): string {
    return this.attachmentsFor(messageId)
      .map((a) => `\n[orrery 附件] ${a.name}（${fmtSize(a.size)}）${a.path ? `：${a.path}` : ''}`).join('');
  }

  /** Skills the text refers to as $name. The skills folder is read only when a `$` could start one. */
  private skillsIn(text: string): string[] {
    if (!/\$[A-Za-z0-9]/.test(text)) return [];
    return skillRefs(text, new Set(this.listSkills().map((s) => s.name)));
  }
}
