// Interface contract shared by every module. Imports only the types of the system-kind table (./system-kinds.js), which the page loads too. From
// docs/architecture.md and docs/native-mode.md.
import type { SystemKind } from './system-kinds.js';

export type MemberStatus = 'idle' | 'busy' | 'offline';

/** The actual MCP tool-list variants; fingerprints from different profiles are not comparable. */
export type ToolProfile = 'standard' | 'antigravity' | 'zcode' | 'qoder' | 'workbuddy';
export type ToolFingerprints = Record<ToolProfile, string>;
export interface ToolVersionClaim {
  source: 'client' | 'claude-forwarded' | 'claude-fallback' | 'dsh-source';
  scope: 'session' | 'plugin';
  profile: ToolProfile;
  fingerprint: string;
  observedAt: string;
  registered?: { succeeded: number; total: number };
}
export interface ToolCallObservation {
  profile: ToolProfile;
  lastCallAt: string;
  staleAfterMs: number;
  client: ToolVersionClaim | null;
  bridge: ToolVersionClaim | null;
}

/** Observed facts, independent of delivery state and global busy/idle. */
export interface ActivityObservation {
  kind: 'tool' | 'turn';
  phase: 'requested' | 'started' | 'finished' | 'failed';
  toolName?: string | null;
}

export interface ActivitySnapshot {
  state: 'unknown' | 'observing' | 'stale' | 'disconnected';
  source: string | null;
  lastSeenAt: string | null;
  lastActivityAt: string | null;
  event: ActivityObservation | null;
  staleAfterMs: number;
}

/** A trusted, process-local observation source; replacing or closing it invalidates the old handle. */
export interface ActivityObserver {
  record(observation: ActivityObservation): boolean;
  heartbeat(): boolean;
  close(): void;
}

/** A conversation the user sees in the native app; the Hub only delivers into it. */
export type MemberMode = 'native';

export interface Cluster {
  id: string;
  name: string;
  createdAt: string;
  /** The sidebar group the user put it in (PATCH /api/clusters/:id); '' = ungrouped. */
  category: string;
  /** Null for an active cluster; deleted clusters retain their history until restored. */
  deletedAt?: string | null;
  /** When the user pinned it in the sidebar (PATCH { pinned }); null = not pinned. Never set while archived. */
  pinnedAt: string | null;
  /** When the user archived it (PATCH { archived }); null = not archived. */
  archivedAt: string | null;
  /** The newest message the user has read here (POST /api/clusters/:id/read); only moves forward. Null = none yet. */
  userReadMessageId: string | null;
}

/** A cluster in listings: plus the time of its newest message (its creation time when it has none). */
export interface ClusterListing extends Cluster {
  lastMessageAt: string;
  paused: boolean;         // this cluster's own pause, separate from the Hub-wide one
  /** Recycle-bin listing only (GET /api/clusters?deleted=true): what a permanent delete would remove. */
  messageCount?: number;
  /** Event sequence of this cluster's latest move to the recycle bin, for permanent-delete confirmation. */
  trashVersion?: number;
  fileCount?: number;
}

export interface Member {
  id: string;
  clusterId: string;
  name: string;            // 集群内唯一；用于 @。只允许字母、数字、汉字、_ . -，不含空格
  avatar: string | null;   // emoji 或 data URL（不超过 256 KB）；null 时界面按名字生成默认头像
  harness: string;         // 'mock' | 'claude' | 'codex'
  model: string | null;
  effort: string | null;   // 原生 Claude 的 model/effort 由应用决定，Hub 只记录（可为 null）
  mode: MemberMode;
  workerSessionId: string;
  cwd: string;
  origin: 'attached' | 'created';  // 接入已有对话，还是由 orrery 新建
  status: MemberStatus;
  removedAt: string | null; // null: active; timestamp: historical membership only
  /** v28: set while the member is hidden (隐身): no delivery, invisible to other members, its tools refuse. Absent = null. */
  hiddenAt: string | null;
  longWaiting?: number;     // deliveries a long-queue warning covered that have still not started; absent when 0
}

/** One move of a native member to another conversation (Hub.rebindMember); kept as `rebind` in its 'member' event, append-only. */
export interface MemberRebind {
  memberId: string;
  memberName: string;
  clusterId: string;
  harness: string;
  fromSessionId: string;
  toSessionId: string;
  fromCwd: string;
  toCwd: string;
  confirmedStopped: true;  // the user ticked "the old conversation has stopped"
  at: string;
}

export interface Message {
  id: string;
  clusterId: string;
  from: string;            // 成员 id、'user'、'system' 或已验证的 'plugin:<id>'
  mentions: string[];      // 被 @ 的成员 id；为空表示没有 @
  body: string;
  replyTo: string | null;
  chainId: string;         // 用户消息开新链；agent 发的消息继承它正在处理的那条
  hop: number;             // 用户消息为 0；agent 发的为所处理消息的 hop + 1
  createdAt: string;
  /** 'chat' (default, also the column default), a task comment, a system notice, or a synthetic user message: a handover
   *  package send, a delivery handoff, or a resend. The synthetic kinds are user messages but not user requests. */
  kind?: 'chat' | 'task_comment' | 'system' | 'handover' | 'handoff' | 'resend' | 'plugin';
  /** System notifications only: the collaboration event this message reports (GET .../events/:eventId, red/green diff). */
  collabEventId?: number;
  /** Task notifications: the task as it stood when the notice was produced; the envelope marks a notice whose task moved on. */
  taskStamp?: { taskId: string; revision: number; submissionId: string | null };
  /** Sent with fyi=true: unread-only, no delivery or wakeup (except replyTo may still wake the asker). Absent or false on non-fyi / pre-v26 messages. */
  fyi?: boolean;
  /** System messages: what kind of notice it is (src/core/system-kinds.js maps it to a category). Set by every writer since 2026-11-15; absent on ordinary chat and older rows (v27 backfilled only receipts and queue warnings). */
  systemKind?: SystemMessageKind;
  /** Member/plugin @all broadcast (v27+): defined (`[]` or explicit `@name` IDs besides sender); absent on non-broadcasts, user messages, and pre-v27 rows. */
  explicitMentions?: string[];
}

export type SystemMessageKind = SystemKind;
export type UnreadCategory = 'mention' | 'user' | 'broadcast' | 'task_notice';
export type MessageCategory = UnreadCategory | 'receipt_warning';
/** read_messages' category filter: a message category, or warning (system messages whose kind is in the warning category). */
export type MessageCategoryFilter = MessageCategory | 'warning';
export type UnreadAnnotation = 'fyi' | 'offline' | 'failed_or_unknown' | 'blocked';

export interface UnreadCategoryCounts {
  total: number;
  fyi: number;
  offline: number;
  failedOrUnknown: number;
  blocked: number;
}

export interface UnreadBreakdown {
  total: number;
  mention: UnreadCategoryCounts;
  user: UnreadCategoryCounts;
  broadcast: UnreadCategoryCounts;
  taskNotice: UnreadCategoryCounts;
}

/** A file stored by the Hub (docs/files.md). Its bytes live at <files dir>/<id>/<name>; the path never leaves the Hub except to native members. */
export interface FileInfo {
  id: string;
  clusterId: string;
  uploader: string;        // 'user' or the member id that attached it
  name: string;            // sanitized file name, also the name on disk
  mime: string;            // image/png|jpeg|gif|webp when the magic bytes say so, else application/octet-stream
  size: number;
  sha256: string;
  createdAt: string;
}

/** offline：要投时原生群员离线，这条不投递、以后也不补投（终态）；消息仍算它未读。 */
export type DeliveryState = 'queued' | 'running' | 'done' | 'failed' | 'offline' | 'superseded';
/** Evidence about the target, independent of the Hub's scheduling state. */
export type DeliveryResult = 'accepted' | 'completed' | 'failed' | 'unknown';
export type NativeDeliveryResult = 'accepted' | 'completed' | 'offline' | { outcome: 'failed' | 'unknown'; error: string };
export type BridgeDoneResult = 'done' | 'dropped' | 'timeout' | 'aborted'
  | { outcome: 'completed' | 'failed' | 'unknown'; error?: string };

export interface Delivery {
  id: string;
  messageId: string;
  memberId: string;
  state: DeliveryState;
  outcome: DeliveryResult | null;
  /** The user-created handoff message, if this delivery has been handed to another member. */
  handoffMessageId: string | null;
  error: string | null;
  updatedAt: string;
  batchId: string | null;  // 开始时设置：同一次投递（一批）共用第一条 delivery 的 id；从未开始过为 null，但升级前的旧记录开始过也可能为 null
  attempts: number;        // 被置为 running 的次数（因离线收回的那次不算）；为 0 才可能是从未开始
}

/** The first way a message was marked read; acknowledgement is recorded separately. */
export type ReadVia = 'delivery' | 'read_messages' | 'ack_messages' | 'skip';

/** Filters shared by unread and history reads; senderId/mentionId are resolved IDs. */
export interface MessageFilters {
  since?: string;
  until?: string;
  q?: string;
  senderId?: string;
  /** Exactly this message kind ('chat' for ordinary chat messages). */
  kind?: Message['kind'];
  /** Every kind except these. */
  excludeKinds?: NonNullable<Message['kind']>[];
  mentionId?: string;
  /** True for the mentions name "all": the message mentions every active member of its cluster (or carried @all). */
  allMentions?: boolean;
  /** Categorized view filter evaluated for `categoryMemberId`; `warning` matches system messages of a warning kind. */
  category?: MessageCategoryFilter;
  categoryMemberId?: string;
}

export interface Read {
  memberId: string;
  messageId: string;
  via: ReadVia;
  at: string;
}

export interface MessageAcknowledgement {
  memberId: string;
  messageId: string;
  at: string;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; detail?: string }
  | { type: 'error'; message: string };

export interface HubEvent {
  seq: number;             // 全局递增，SSE 断线后按它续传
  clusterId: string | null;
  memberId: string | null;
  kind: 'cluster' | 'member' | 'message' | 'delivery' | 'read' | 'acknowledgement' | 'agent' | 'guard' | 'pause' | 'settings' | 'usage' | 'collaboration' | 'unread_hint'
    | 'delivery_dismissed';   // { deliveryIds, at }: the user marked these delivery problems as known (标为已知)
  payload: unknown;
  createdAt: string;
}

export interface ProjectInfo { path: string; label: string; updatedAt: string | null }

export interface SessionInfo {
  id: string;
  title: string;
  model: string | null;
  cwd: string;
  updatedAt: string | null;
}

/** A model the user can pick for a new member; `efforts` are the thinking efforts it accepts (empty: none to pick). */
export interface ModelInfo {
  id: string;              // what goes into the member spec's `model`
  label?: string;
  efforts: string[];
  isDefault?: boolean;     // the harness's own default when no model is picked
}

/**
 * Token counts, normalized across harnesses (docs/usage.md): `input` is input NOT read from or written to a cache;
 * `cachedInput` is input read from a cache; `cacheWrite` is input written to a cache; `output` includes `reasoning`
 * (reasoning is shown separately where a harness reports it, else 0). Codex reports input with cached input inside;
 * its adapter subtracts it. Counts of different models are not comparable and are never converted to money.
 */
export interface TokenTotals {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

/** One subscription time window: how much of it is used and when it resets. */
export interface QuotaWindow {
  id: string;              // stable per harness, e.g. 'primary', 'limit5h'
  label: string;           // shown to the user, e.g. '5 小时', '每周'
  usedPercent: number;     // 0..100
  resetsAt: string | null; // ISO time
}

/** A harness account's remaining subscription quota as last seen. */
export interface QuotaSnapshot {
  plan?: string;
  windows: QuotaWindow[];  // only the windows the account has (never assume two)
  extra?: string;          // a short note, e.g. Codex credits
  observedAt: string;      // when the numbers were true (a rollout line's time, or the time of the request)
  source: string;          // where they came from, e.g. 'rollout', 'app-server', 'oauth/usage'
}

export interface BridgePort {
  isOnline(harness: string, sessionId: string): boolean;
  /** 经桥把文字投进该会话；resolve 为桥的回执。会话不在线时 reject。 */
  push(harness: string, sessionId: string, deliveryId: string, text: string): Promise<{ ok: true; follows?: true } | { ok: false; error: string; outcome?: 'unknown' }>;
  /**
   * After an ack with `follows` (the bridge will report the end of the turn the delivery starts): waits for that
   * report (POST /bridge/done). Ends early with 'dropped' when the stream that carried the delivery goes away (or none
   * is connected), 'timeout' after timeoutMs, 'aborted' when the signal aborts. Never rejects.
   */
  waitDone(harness: string, sessionId: string, deliveryId: string, timeoutMs: number, signal: AbortSignal): Promise<BridgeDoneResult>;
}

export interface NativeDeliverContext {
  deliveryId: string;
  bridge: BridgePort;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
  /** Names of who sent the delivered messages, distinct, oldest first ('user' for the user). */
  from?: string[];
  /**
   * Given only when the adapter has `replies`: posts the answer of the turn this delivery started as the member's
   * message to the cluster (before deliver resolves). Call it at most once, with that turn's text only.
   */
  reply?: (text: string) => void;
  /**
   * Reports the tokens the turn this delivery started used (docs/usage.md). Call it at most once, before deliver
   * settles; the Hub stores it under this delivery's batch, so a redone delivery replaces rather than adds.
   */
  usage?: (totals: TokenTotals) => void;
  /**
   * For a harness that keeps its own queue (Codex): call it while the delivery still waits there, with whether the
   * conversation is busy with another turn, and with null once a turn has picked it up.
   */
  waiting?: (state: { busy: boolean } | null) => void;
}

export interface NativeAdapter {
  readonly harness: string;
  listProjects(): Promise<ProjectInfo[]>;
  listSessions(projectPath: string): Promise<SessionInfo[]>;
  attachSession(sessionId: string): Promise<SessionInfo>;
  /** 可选：新建一个在应用里看得到的对话。Claude 不支持（用户在桌面应用里新建）。 */
  /** memberName: the name the new member will have (Codex tells a new thread who it is when it runs an init turn). */
  createSession?(opts: { cwd: string; title: string; model?: string; effort?: string; memberName?: string }): Promise<{ sessionId: string; model: string | null }>;
  /** 现在能否投递（Claude：桥在线；Codex：桌面应用正在运行）。 */
  isOnline(sessionId: string, bridge: BridgePort): boolean;
  /**
   * 可选：isOnline 的答案可能过时（例如来自缓存）时，重新确认一次是否在线。isOnline 说离线时，Hub 先等它的答案，
   * 也说离线才把投递记为 'offline'（不可撤销）。不设则以 isOnline 为准（Claude：桥的连接状态就是准的）。
   * 现查不出结果（例如 tasklist 超时）时 reject：那是"未知"，不是"没在运行"，Hub 不会因此把投递记为 'offline'；
   * 适配器自己也不得在未知时连接或投递（Kimi 这样做，见 docs/adapters/kimi.md）。
   */
  confirmOnline?(sessionId: string): Promise<boolean>;
  /**
   * 把文字投进对话。harness 接受后 resolve 'accepted'（之后由 harness 自己排队、开轮次）；
   * 能观察到这一轮结束的适配器（Codex）可以在结束后 resolve 'completed'。不在线 resolve 'offline'（这一批记为离线、不重试），失败 reject。
   */
  deliver(sessionId: string, text: string, ctx: NativeDeliverContext): Promise<NativeDeliveryResult>;
  /**
   * True for a harness whose members cannot be identified over MCP (Kimi Code): they speak only by answering a
   * delivery; the Hub gives deliver a `reply` callback and tells the member so in the envelope.
   */
  readonly replies?: boolean;
  /** Optional: models (and their efforts) createSession accepts. */
  listModels?(): Promise<ModelInfo[]>;
  /**
   * Optional: the account's subscription quota (docs/usage.md). refresh false: only what is cheap (local files, or a
   * request the adapter rate-limits itself); refresh true: the user asked, ask the source now. Null: nothing known now
   * (e.g. the app is not running); the Hub keeps the last snapshot. Never starts the native app.
   */
  quota?(opts: { refresh: boolean }): Promise<QuotaSnapshot | null>;
  /** Optional: the whole conversation's token totals, read-only from the harness's own files. Null: not readable. */
  conversationTokens?(sessionId: string): Promise<TokenTotals | null>;
  /**
   * Set when attachSession only reads the harness's own files on this machine (no process, no request to the app): the
   * Hub may then call it every few minutes to show a member's current conversation title and model (docs/cluster-members.md).
   */
  readonly localSessions?: true;
  /** Set by a harness on the background-wait route: the Hub then serves its /bridge/<harness>-wait and -ack. */
  readonly wait?: WaitHarness;
  /** Set by a harness whose app runs orrery's hooks at each turn's start and end: the Hub serves /bridge/<harness>-park and -turn. */
  readonly turnHooks?: TurnHookHarness;
  close?(): Promise<void>;
}

/** A harness whose app runs orrery's hooks at the start and end of every turn (Cursor, docs/adapters/cursor.md). */
export interface TurnHookHarness {
  /** The member's `harness`; also names the routes /bridge/<harness>-park and /bridge/<harness>-turn. */
  readonly harness: string;
  /** A hook's report, already authenticated with the bridge secret and validated field by field by the Hub. */
  turn(report: TurnReport): void;
}

export interface TurnReport {
  /** The hook's conversation_id. */
  sessionId: string;
  /** 'start': beforeSubmitPrompt; 'end': stop. */
  event: 'start' | 'end';
  generationId: string;
  /** Start only: the 8-hex hand-over id found on the prompt's first line. */
  handout?: string;
  /** End only. */
  status?: 'completed' | 'aborted' | 'error';
  /** End only: the app's raw counts for the turn; the adapter normalizes them to TokenTotals. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** What a harness on the background-wait route supplies (src/mcp/wait-core.ts, src/adapters/shared/wait-native.ts). */
export interface WaitHarness {
  /** The member's `harness`; also names the routes and signs the tickets. */
  readonly harness: string;
  /** The app's Windows image name. The Hub calls a member offline and delivers nothing while none runs for this user. */
  readonly appProcess: string;
  /** The ancestor wait.mjs leaves with, by image name. Null: the first ancestor that is not a shell. */
  readonly ancestorProcess: string | null;
  /**
   * The `_meta` key of a tools/call that names the conversation. Absent for a harness whose bridge finds the id itself
   * and names it in the request headers (WorkBuddy): nothing about identity is read from `_meta` there.
   */
  readonly metaKey?: string;
  /**
   * ZCode only, as it worked before this was shared: the envelope ends with the re-arm instructions and the command
   * carries no harness arguments. A new harness leaves it out: the envelope is chat content only (an app's guard may
   * block "run it again" in command output), and the rule goes in the tool description and the skill.
   */
  readonly legacyWire?: true;
}

// Here because this is the one file both the adapters and the MCP side may import (test/boundaries.test.ts).
export const ZCODE_WAIT: WaitHarness = { harness: 'zcode', appProcess: 'ZCode.exe', ancestorProcess: null, metaKey: 'session_id', legacyWire: true };
// `satisfies`, not a `WaitHarness` annotation: src/mcp/qoder.ts indexes each call's _meta with this literal key.
export const QODER_WAIT = { harness: 'qoder', appProcess: 'Qoder.exe', ancestorProcess: 'Qoder.exe', metaKey: 'com.qoder/turnContext' } satisfies WaitHarness;

/**
 * WorkBuddy's stdio MCP bridge (plugins/workbuddy-orrery/bridge.mjs) takes the id from CODEBUDDY_SESSION_ID or else its
 * WorkBuddy.exe parent's --session-id and sends it as x-orrery-session, so there is no `_meta` key. The conversation's CLI
 * process is a WorkBuddy.exe, like the app itself: waiting leaves with the first WorkBuddy.exe above its shell.
 */
export const WORKBUDDY_WAIT: WaitHarness = { harness: 'workbuddy', appProcess: 'WorkBuddy.exe', ancestorProcess: 'WorkBuddy.exe' };
