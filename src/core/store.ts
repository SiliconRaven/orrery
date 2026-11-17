// SQLite persistence. The only core module that knows the table layout; plugins own their tables (core/plugin.ts).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHAIN_LIMIT_ERROR } from './delivery-timeline.ts';
import { CLUSTER_GROUPS_KEY, parseGroups } from './cluster-groups.ts';
import type { ExternalWriteSettings } from './external-plugin-config.ts';
import { LIMIT_SETTINGS, parseLimit, type Limit, type LimitSetting } from './limits.ts';
import { PluginHost, type CoordinatorView, type TaskView } from './plugin.ts';
import type { ActivityObservation, Cluster, ClusterListing, Delivery, DeliveryResult, DeliveryState, FileInfo, HubEvent, Member, MemberRebind, Message, MessageAcknowledgement, MessageCategory, MessageFilters, QuotaSnapshot, Read, ReadVia, TokenTotals, UnreadAnnotation, UnreadBreakdown, UnreadCategory, UnreadCategoryCounts } from './types.ts';
import type { CollectionItem, MemberRoles, Role } from './collaboration-types.ts';
import { kindsOf } from './system-kinds.js';

export type StoredMember = Omit<Member, 'status'>;
const PURGED_CHAIN_TURNS = 'purged_chain_turns:';
/** A member about to be written: it always starts visible, so `hiddenAt` may be left out and is not written (read back as null). */
export type NewMember = Omit<StoredMember, 'hiddenAt'> & { hiddenAt?: string | null };
/** `attachments` only when the message has any (older readers never see the field). */
export type MessageWithDeliveries = Message & { deliveries: Delivery[]; reads: Read[]; acknowledgements: MessageAcknowledgement[];
  attachments?: FileInfo[] } & Record<string, unknown>;
/**
 * What Store.searchMessages matches, every field narrowing: `q` a case-insensitive (ASCII) literal substring, `senderId`
 * a from id, `systemKinds` system messages whose kind is in `kinds` (`not`: is not, or has none), `since`/`until`
 * inclusive ISO times, `withFiles` messages with an attachment.
 */
export type MessageSearch = { q?: string; senderId?: string; systemKinds?: { kinds: string[]; not?: boolean };
  since?: string; until?: string; withFiles?: boolean };
/** A search hit: the message without its body, and an excerpt of the body around the first hit (Store.searchMessages). */
export type SearchHit = Omit<Message, 'body'> & { excerpt: string; cutBefore: boolean; cutAfter: boolean };
/** Characters of a hit's excerpt (plus the keyword's length), of them this many before the first hit. */
export const SEARCH_EXCERPT = 600;
export const SEARCH_EXCERPT_BEFORE = 200;
/** A queued delivery with its full message. */
export type QueuedDelivery = Delivery & { message: Message; direct: boolean };
/** Queue selection only needs this metadata. Read the message itself when a delivery is selected. */
export type QueuedCandidate = Pick<Delivery, 'id' | 'memberId' | 'batchId'> & {
  message: Pick<Message, 'id' | 'from' | 'chainId' | 'createdAt'>;
  direct: boolean;
};

const SCHEMA_VERSION = 29;

// The v16 collaboration tables, frozen: the v15 → v16 migration creates exactly this; v16 → v17 then adds the role
// description column (the fresh schema below starts at the newest shape).
const collaborationTablesV16 = `
CREATE TABLE collaboration_tasks (id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id), data_json TEXT NOT NULL);
CREATE INDEX collaboration_tasks_cluster ON collaboration_tasks(cluster_id);
CREATE TABLE collaboration_roles (id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id), name TEXT NOT NULL, UNIQUE(cluster_id, name));
CREATE TABLE collaboration_member_roles (member_id TEXT NOT NULL REFERENCES members(id), role_id TEXT NOT NULL REFERENCES collaboration_roles(id), PRIMARY KEY(member_id, role_id));
CREATE TABLE collaboration_links (message_id TEXT NOT NULL REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES collaboration_tasks(id), linked_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(message_id, task_id));
CREATE TABLE collaboration_bookmarks (member_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), labels_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(member_id, message_id));
CREATE TABLE collaboration_policies (cluster_id TEXT PRIMARY KEY REFERENCES clusters(id), data_json TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, paused_by TEXT);
CREATE TABLE collaboration_operations (cluster_id TEXT NOT NULL REFERENCES clusters(id), actor TEXT NOT NULL, operation_id TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(cluster_id, actor, operation_id));
CREATE TABLE collaboration_records (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES collaboration_tasks(id), kind TEXT NOT NULL, data_json TEXT NOT NULL);
CREATE INDEX collaboration_records_task ON collaboration_records(task_id, kind);
`;

// v17 adds one short, editable description per business role; roles created before it read as ''.
// The task tables are the tasks plugin's (src/plugins/tasks): it creates them on a fresh database.
const collaborationTables = `
CREATE TABLE collaboration_roles (id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', UNIQUE(cluster_id, name));
CREATE TABLE collaboration_member_roles (member_id TEXT NOT NULL REFERENCES members(id), role_id TEXT NOT NULL REFERENCES collaboration_roles(id), PRIMARY KEY(member_id, role_id));
CREATE TABLE collaboration_policies (cluster_id TEXT PRIMARY KEY REFERENCES clusters(id), data_json TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, paused_by TEXT);
CREATE TABLE collaboration_operations (cluster_id TEXT NOT NULL REFERENCES clusters(id), actor TEXT NOT NULL, operation_id TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(cluster_id, actor, operation_id));
`;

// The v3 members table, frozen: the v2 → v3 rebuild creates exactly this; v3 → v4 then adds mode and effort.
const membersTableV3 = (name: string) => `
CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  name TEXT NOT NULL,
  avatar TEXT,
  harness TEXT NOT NULL,
  model TEXT,
  worker_session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(cluster_id, name),
  UNIQUE(harness, worker_session_id)
);`;
const MEMBER_COLUMNS_V3 = 'id, cluster_id, name, avatar, harness, model, worker_session_id, cwd, origin, created_at';
const MEMBER_COLUMNS_V4 = `${MEMBER_COLUMNS_V3}, mode, effort`;
const MEMBER_COLUMNS = `${MEMBER_COLUMNS_V4}, removed_at`;

// The v5 members table, frozen: the v4 → v5 rebuild creates exactly this; v26 → v27 then adds unread_after_rowid.
const membersTableV5 = (name: string) => `
CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  name TEXT NOT NULL,
  avatar TEXT,
  harness TEXT NOT NULL,
  model TEXT,
  worker_session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'isolated',   -- 'isolated' | 'native'
  effort TEXT,
  removed_at TEXT
);`;

const membersTable = (name: string) => `
CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  name TEXT NOT NULL,
  avatar TEXT,
  harness TEXT NOT NULL,
  model TEXT,
  worker_session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'native' CHECK(mode = 'native'),
  effort TEXT,
  removed_at TEXT,
  unread_after_rowid INTEGER NOT NULL DEFAULT 0,  -- v27: messages at or before this rowid are pre-join and excluded from unread
  hidden_at TEXT                                  -- v28: non-null while the member is hidden (docs/cluster-members.md「隐身」)
);`;
const memberIndexesV5 = `
CREATE UNIQUE INDEX members_active_name ON members(cluster_id, name) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX members_active_session ON members(harness, worker_session_id) WHERE removed_at IS NULL;
`;
const multiSessionIndexes = `
CREATE UNIQUE INDEX members_active_session ON members(cluster_id, harness, worker_session_id) WHERE removed_at IS NULL;
`;
const memberIndexes = `
CREATE UNIQUE INDEX members_active_name ON members(cluster_id, name) WHERE removed_at IS NULL;
${multiSessionIndexes}`;

// Which member has read which message; the first way of reading wins (insert-or-ignore). Frozen v6 shape: the v5 → v6
// migration creates exactly this; v28 → v29 then adds seen_at.
const readsTableV6 = `
CREATE TABLE reads (
  member_id TEXT NOT NULL REFERENCES members(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  via TEXT NOT NULL,   -- 'delivery' | 'read_messages' | 'ack_messages'
  at TEXT NOT NULL,
  PRIMARY KEY (member_id, message_id)
);`;
const readsTable = `
CREATE TABLE reads (
  member_id TEXT NOT NULL REFERENCES members(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  via TEXT NOT NULL,   -- 'delivery' | 'read_messages' | 'ack_messages' | 'skip': the first way, never changed
  at TEXT NOT NULL,    -- when that first way happened
  seen_at TEXT,        -- v29: the first time it really reached the member (any way but 'skip'); null = only skipped
  PRIMARY KEY (member_id, message_id)
);`;

// v29: deliveries.state_seq orders every delivery insert and state/outcome change Hub-wide, so "全部标为已知" can mark
// exactly the problems that existed when listed. The counter outlives the delivery rows, even when a group is purged.
const DELIVERY_STATE_SEQUENCE_KEY = 'delivery_state_sequence';
const bumpDeliveryStateSequence = `
  INSERT INTO settings (key, value) VALUES ('${DELIVERY_STATE_SEQUENCE_KEY}', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(settings.value AS INTEGER) + 1;
  UPDATE deliveries SET state_seq = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = '${DELIVERY_STATE_SEQUENCE_KEY}')
    WHERE rowid = NEW.rowid;`;
const deliveryStateSeq = `
CREATE TRIGGER deliveries_state_seq_insert AFTER INSERT ON deliveries
BEGIN ${bumpDeliveryStateSequence} END;
CREATE TRIGGER deliveries_state_seq_update AFTER UPDATE OF state, outcome ON deliveries
WHEN OLD.state IS NOT NEW.state OR OLD.outcome IS NOT NEW.outcome
BEGIN ${bumpDeliveryStateSequence} END;
`;

const acknowledgementsTable = `
CREATE TABLE message_acknowledgements (
  member_id TEXT NOT NULL REFERENCES members(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  at TEXT NOT NULL,
  PRIMARY KEY (member_id, message_id)
);`;

// Global settings saved from the web page, one row per setting; no row means "never saved". Values are JSON.
const settingsTable = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,   -- 'max_hops', 'max_turns_per_chain': a Limit (src/core/limits.ts)
  value TEXT NOT NULL
);`;

// Files the Hub stores (docs/files.md) and which message carries which, in order. Files outlive their cluster's members.
const filesTables = `
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  uploader TEXT NOT NULL,   -- 'user' or a member id
  name TEXT NOT NULL,       -- sanitized; also the file name on disk
  mime TEXT NOT NULL,       -- from the magic bytes: an image type or application/octet-stream
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE message_files (
  message_id TEXT NOT NULL REFERENCES messages(id),
  file_id TEXT NOT NULL REFERENCES files(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX message_files_file ON message_files(file_id);`;

// Token usage of turns orrery started (docs/usage.md), one row per batch: a batch redone after a restart replaces its
// row, so nothing is counted twice. And the last quota snapshot per harness, so a restarted Hub still shows it.
// IF NOT EXISTS: the usage migration may be renumbered when merged with another schema change; running it twice is harmless.
const usageTables = `
CREATE TABLE IF NOT EXISTS turn_usage (
  batch_id TEXT PRIMARY KEY,   -- deliveries.batch_id of the run whose turn used the tokens
  member_id TEXT NOT NULL REFERENCES members(id),
  input INTEGER NOT NULL,
  cached_input INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_usage_member ON turn_usage(member_id);
CREATE TABLE IF NOT EXISTS quota_snapshots (
  harness TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL   -- a QuotaSnapshot
);`;

const activityTable = `
CREATE TABLE IF NOT EXISTS activity_snapshots (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  source TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_activity_at TEXT,
  event_json TEXT
);`;

const clientMessageIndex = 'CREATE UNIQUE INDEX messages_client_id ON messages(from_id, client_message_id) WHERE client_message_id IS NOT NULL;';
const pluginRateIndex = "CREATE INDEX IF NOT EXISTS messages_plugin_rate ON messages(cluster_id, from_id, created_at) WHERE kind = 'plugin';";

// How many of each plugin's migrations have run (PluginHost.migrate); the plugins' own tables are theirs.
const pluginMigrationsTable = 'CREATE TABLE IF NOT EXISTS plugin_migrations (plugin_id TEXT PRIMARY KEY, version INTEGER NOT NULL);';

const SCHEMA = `
CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',   -- the web sidebar's group; '' = ungrouped
  deleted_at TEXT,
  pinned_at TEXT,                      -- v19: when the user pinned it in the sidebar; null = not pinned
  archived_at TEXT,                    -- v19: when the user archived it; null = not archived (never both set)
  user_read_message_id TEXT            -- v19: the newest message the user has read in it; null = none yet
);
${membersTable('members')}
${memberIndexes}
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  from_id TEXT NOT NULL,
  mentions_json TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  chain_id TEXT NOT NULL,
  hop INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  direct INTEGER NOT NULL DEFAULT 0,   -- 1: the user sent it with "to" = exactly one native member; delivered without envelope
  kind TEXT NOT NULL DEFAULT 'chat',
  collab_event_id INTEGER,               -- system notifications: the collaboration event they report (v18+)
  client_message_id TEXT,                -- v23: send_message's idempotency key, unique per sender
  task_stamp_json TEXT,                  -- v23: task notifications: { taskId, revision, submissionId } when produced
  fyi INTEGER NOT NULL DEFAULT 0,        -- v26: 1 when sent with fyi=true (no wakeup, except replyTo may wake asker)
  system_kind TEXT,                      -- v27: sender-only system notice subtype ('receipt' | 'queue_warning')
  explicit_mentions_json TEXT            -- v27: NULL = not a member/plugin @all; JSON array = explicit @-named IDs inside @all
);
CREATE INDEX messages_cluster ON messages(cluster_id);
CREATE INDEX messages_chain ON messages(chain_id);
${clientMessageIndex}
${pluginRateIndex}
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  state TEXT NOT NULL,
  outcome TEXT,
  handoff_message_id TEXT REFERENCES messages(id),
  error TEXT,
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,   -- times this delivery was set running; survives restart
  batch_id TEXT,                          -- set when it starts: the id of the first delivery of its run (batch)
  reported INTEGER NOT NULL DEFAULT 0,    -- 1: its failure (failed / offline) was told to the message's sender
  queue_warned INTEGER NOT NULL DEFAULT 0, -- v23: 1: the long-queue warning for it was posted
  dismissed_at TEXT,                      -- v29: when the user marked this delivery problem as known (标为已知); null = not marked
  state_seq INTEGER NOT NULL DEFAULT 0,   -- v29: Hub-wide order of its insert or last state/outcome change (deliveryStateSeq)
  UNIQUE(message_id, member_id)
);
CREATE INDEX deliveries_member_state ON deliveries(member_id, state);
${readsTable}
${acknowledgementsTable}
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_id TEXT,
  member_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_member ON events(member_id, seq);
${settingsTable}
${deliveryStateSeq}
${filesTables}
${usageTables}
${activityTable}
${collaborationTables}
${pluginMigrationsTable}
`;

type Row = Record<string, any>;

/**
 * Store.deliveryProblems' rule, over deliveries d joined to their messages m; the one parameter is the cluster id. An
 * offline delivery (nothing reached the member) stops counting once the message has reached the member on its own
 * (reads.seen_at: read, acknowledged or delivered; a skip alone is not, a later real read is). Failed and
 * unknown-outcome deliveries go away only by hand-off, resend or 标为已知.
 */
const PROBLEM_WHERE = `m.cluster_id = ? AND d.state != 'superseded' AND d.handoff_message_id IS NULL AND d.dismissed_at IS NULL
  AND (d.state IN ('failed', 'offline') OR d.outcome = 'unknown')
  AND NOT (d.state = 'offline' AND d.outcome IS NULL AND EXISTS (SELECT 1 FROM reads r
    WHERE r.member_id = d.member_id AND r.message_id = d.message_id AND r.seen_at IS NOT NULL))`;

const toCluster = (r: Row): Cluster => ({ id: r.id, name: r.name, createdAt: r.created_at, category: r.category ?? '', deletedAt: r.deleted_at ?? null,
  pinnedAt: r.pinned_at ?? null, archivedAt: r.archived_at ?? null, userReadMessageId: r.user_read_message_id ?? null });

/** The cluster fields the user may change (PATCH /api/clusters/:id), with their columns. */
export type ClusterChanges = { name?: string; category?: string; pinnedAt?: string | null; archivedAt?: string | null };
const CLUSTER_CHANGE_COLUMNS = { name: 'name', category: 'category', pinnedAt: 'pinned_at', archivedAt: 'archived_at' } as const;
const toMember = (r: Row): StoredMember => ({
  id: r.id, clusterId: r.cluster_id, name: r.name, avatar: r.avatar, harness: r.harness, model: r.model,
  workerSessionId: r.worker_session_id, cwd: r.cwd, origin: r.origin, mode: r.mode, effort: r.effort, removedAt: r.removed_at ?? null,
  hiddenAt: r.hidden_at ?? null,
});
const toMessage = (r: Row): Message => ({
  id: r.id, clusterId: r.cluster_id, from: r.from_id, mentions: JSON.parse(r.mentions_json), body: r.body,
  replyTo: r.reply_to, chainId: r.chain_id, hop: r.hop, createdAt: r.created_at,
  ...(r.kind && r.kind !== 'chat' ? { kind: r.kind } : {}),
  ...(r.collab_event_id != null ? { collabEventId: Number(r.collab_event_id) } : {}),
  ...(r.task_stamp_json ? { taskStamp: JSON.parse(r.task_stamp_json) } : {}),
  ...(r.fyi === 1 ? { fyi: true } : {}),
  ...(r.system_kind ? { systemKind: r.system_kind } : {}),
  ...(r.explicit_mentions_json != null ? { explicitMentions: JSON.parse(r.explicit_mentions_json) } : {}),
});
const toDelivery = (r: Row): Delivery => ({
  id: r.id, messageId: r.message_id, memberId: r.member_id, state: r.state, outcome: r.outcome ?? null,
  handoffMessageId: r.handoff_message_id ?? null, error: r.error, updatedAt: r.updated_at, batchId: r.batch_id ?? null, attempts: r.attempts,
});
const QUEUED_COLUMNS = `d.*, m.direct, m.cluster_id, m.from_id, m.mentions_json, m.body, m.reply_to, m.chain_id, m.hop,
        m.created_at, m.kind, m.collab_event_id, m.task_stamp_json, m.fyi, m.system_kind, m.explicit_mentions_json`;
const toQueued = (r: Row): QueuedDelivery => ({ ...toDelivery(r), message: toMessage({ ...r, id: r.message_id }), direct: r.direct === 1 });
const QUEUE_CANDIDATE_COLUMNS = `d.id, d.member_id, d.batch_id, d.message_id, m.direct, m.from_id, m.chain_id, m.created_at`;
const toQueuedCandidate = (r: Row): QueuedCandidate => ({
  id: r.id, memberId: r.member_id, batchId: r.batch_id, direct: r.direct === 1,
  message: { id: r.message_id, from: r.from_id, chainId: r.chain_id, createdAt: r.created_at },
});
const toFile = (r: Row): FileInfo => ({
  id: r.id, clusterId: r.cluster_id, uploader: r.uploader, name: r.name, mime: r.mime, size: r.size, sha256: r.sha256, createdAt: r.created_at,
});
const toRead = (r: Row): Read => ({ memberId: r.member_id, messageId: r.message_id, via: r.via, at: r.at });
const toAcknowledgement = (r: Row): MessageAcknowledgement => ({ memberId: r.member_id, messageId: r.message_id, at: r.at });
const toEvent = (r: Row): HubEvent => ({
  seq: r.seq, clusterId: r.cluster_id, memberId: r.member_id, kind: r.kind,
  payload: JSON.parse(r.payload_json), createdAt: r.created_at,
});
export { toEvent };
const emptyCategoryCounts = (): UnreadCategoryCounts => ({ total: 0, fyi: 0, offline: 0, failedOrUnknown: 0, blocked: 0 });
export const emptyUnreadBreakdown = (): UnreadBreakdown => ({
  total: 0,
  mention: emptyCategoryCounts(),
  user: emptyCategoryCounts(),
  broadcast: emptyCategoryCounts(),
  taskNotice: emptyCategoryCounts(),
});

/** Single source of truth for categorizing a message and its delivery annotations from `memberId`'s perspective. */
export function classifyMessageForMember(
  m: Pick<Message, 'from' | 'mentions' | 'fyi' | 'systemKind' | 'explicitMentions'>,
  memberId: string,
  delivery?: Pick<Delivery, 'state' | 'error'> | null,
): { category: MessageCategory | null; annotations: UnreadAnnotation[] } {
  const annotations: UnreadAnnotation[] = [];
  if (m.fyi) annotations.push('fyi');
  if (delivery?.state === 'offline') annotations.push('offline');
  else if (delivery?.state === 'failed') annotations.push(delivery.error === CHAIN_LIMIT_ERROR ? 'blocked' : 'failed_or_unknown');

  let category: MessageCategory | null = null;
  if (m.from === 'system') {
    category = m.systemKind === 'receipt' || m.systemKind === 'queue_warning' ? 'receipt_warning' : 'task_notice';
  } else if (m.from === 'user' && m.mentions.length === 0) {
    category = 'user';
  } else if (m.explicitMentions !== undefined && m.from !== memberId && !m.explicitMentions.includes(memberId)) {
    category = 'broadcast';
  } else if (m.from !== memberId && m.mentions.includes(memberId)) {
    category = 'mention';
  }
  return { category, annotations };
}

/**
 * JSON.stringify(toEvent(row)) without parsing the payload and serializing it again: the page's replay sends the
 * whole log. Every stored payload was written by JSON.stringify, so it is valid JSON with no raw line break in it.
 */
export const eventJson = (r: Row): string => `{"seq":${r.seq},"clusterId":${JSON.stringify(r.cluster_id)},"memberId":${JSON.stringify(r.member_id)}`
  + `,"kind":${JSON.stringify(r.kind)},"payload":${r.payload_json},"createdAt":${JSON.stringify(r.created_at)}}`;

/** How the database file is opened (docs/architecture.md, storage). main.ts resolves it from the environment. */
export interface DbMode {
  /** 'wal' (the default) or 'delete' (the rollback journal: ORRERY_DB_JOURNAL=delete). */
  journal: 'wal' | 'delete';
  /** 'full' (the default: every commit is on disk before it returns). 'off' only for test Hubs: a power loss can lose commits. */
  synchronous: 'full' | 'off';
}

export const DEFAULT_DB_MODE: DbMode = { journal: 'wal', synchronous: 'full' };

/**
 * How long a statement waits for a lock another process holds (the backup, an sqlite tool) before failing with
 * "database is locked". node:sqlite is synchronous, so the Hub's event loop stands still meanwhile: each statement
 * waits at most this long. The Hub's own single connection never waits for itself.
 */
export const BUSY_TIMEOUT_MS = 3000;

/**
 * The WAL file is cut back to this size whenever it restarts from the beginning; it is not a cap at every moment (a
 * pinned log grows past it until then). SQLite checkpoints on its own every
 * 1000 pages (about 4 MiB), so ordinary use never reaches it; a log grown while a reader pinned it, or by a VACUUM,
 * shrinks again instead of keeping its largest size on disk.
 */
export const WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Runs PRAGMA journal_mode=<mode> and returns the mode SQLite reports (a test seam: a network share may say 'delete'). */
export type SetJournalMode = (db: DatabaseSync, mode: DbMode['journal']) => string;

const setJournalMode: SetJournalMode = (db, mode) => String((db.prepare(`PRAGMA journal_mode = ${mode}`).get() as Row).journal_mode);

export class Store {
  readonly db: DatabaseSync;
  readonly plugins: PluginHost;
  /** The task plugin's read side; null when no enabled plugin provides one. */
  readonly tasks: TaskView | null;
  /** The coordinator plugin's read side; null when it is disabled. */
  readonly coordinator: CoordinatorView | null;

  /** The journal mode in effect ('wal', or the old mode when SQLite kept it). */
  readonly journalMode: string;
  /** One line for the start-up log when the journal mode is not the one asked for; null when it is. */
  readonly journalWarning: string | null;

  constructor(path: string, plugins: PluginHost = new PluginHost(), mode: DbMode = DEFAULT_DB_MODE, setMode: SetJournalMode = setJournalMode) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.plugins = plugins;
    try {
      this.journalMode = this.applyMode(path, mode, setMode);
      this.journalWarning = this.journalMode === mode.journal || path === ':memory:' ? null
        : `database journal mode is '${this.journalMode}', not '${mode.journal}' as asked: SQLite kept the file's mode; the Hub runs as before`;
      this.migrate();
      this.plugins.migrate(this);
    } catch (e) {
      this.db.close();
      throw e;
    }
    this.tasks = this.plugins.taskView?.(this) ?? null;
    this.coordinator = this.plugins.coordinatorView?.(this) ?? null;
  }

  private migrate(): void {
    const version = () => (this.db.prepare('PRAGMA user_version').get() as Row).user_version as number;
    const v = version();
    if (v === 0) {
      this.tx(() => {
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      return;
    }
    if (v < 1 || v > SCHEMA_VERSION) throw new Error(`unsupported database schema version ${v}`);
    if (v === 1) {
      this.tx(() => {
        this.db.exec('ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
        // Best guess for old rows: anything that left 'queued' ran once, except chain-limit failures (never started).
        this.db.exec(`UPDATE deliveries SET attempts = 1 WHERE state != 'queued' AND (error IS NULL OR error != '链轮次超限')`);
        this.db.exec('PRAGMA user_version = 2');
      });
    }
    if (version() === 2) this.dropTokenColumn();
    if (version() === 3) {
      this.tx(() => {
        this.db.exec("ALTER TABLE members ADD COLUMN mode TEXT NOT NULL DEFAULT 'isolated'");
        this.db.exec('ALTER TABLE members ADD COLUMN effort TEXT');
        this.db.exec('ALTER TABLE messages ADD COLUMN direct INTEGER NOT NULL DEFAULT 0');
        this.db.exec('PRAGMA user_version = 4');
      });
    }
    if (version() === 4) this.addRemovalColumn();
    if (version() === 5) {
      this.tx(() => {
        this.db.exec('ALTER TABLE deliveries ADD COLUMN batch_id TEXT');
        this.db.exec(readsTableV6);
        // A turn interrupted by the upgrade is redone alone, exactly as it was started (see Hub.schedule).
        this.db.exec("UPDATE deliveries SET batch_id = id WHERE state = 'running'");
        // Old history: whatever was delivered counts as read, so it does not come back as unread.
        this.db.exec(`INSERT OR IGNORE INTO reads (member_id, message_id, via, at)
          SELECT member_id, message_id, 'delivery', updated_at FROM deliveries WHERE state = 'done'`);
        this.db.exec('PRAGMA user_version = 6');
      });
    }
    if (version() === 6) {
      this.tx(() => {
        this.db.exec(settingsTable);   // empty: nothing was saved yet
        this.db.exec('PRAGMA user_version = 7');
      });
    }
    if (version() === 7) {
      this.tx(() => {
        this.db.exec(filesTables);   // empty: no message had files before
        this.db.exec('PRAGMA user_version = 8');
      });
    }
    if (version() === 8) {
      this.tx(() => {
        // Outcomes from before the upgrade are history, not news: none of them is told to its sender.
        this.db.exec('ALTER TABLE deliveries ADD COLUMN reported INTEGER NOT NULL DEFAULT 0');
        this.db.exec('UPDATE deliveries SET reported = 1');
        this.db.exec('PRAGMA user_version = 9');
      });
    }
    if (version() === 9) {
      this.tx(() => {
        this.db.exec("ALTER TABLE clusters ADD COLUMN category TEXT NOT NULL DEFAULT ''");   // every old cluster: ungrouped
        this.db.exec('PRAGMA user_version = 10');
      });
    }
    if (version() === 10) this.addUsageTables(11);
    if (version() === 11) {
      this.tx(() => {
        this.db.exec(acknowledgementsTable);
        this.db.exec('PRAGMA user_version = 12');
      });
    }
    if (version() === 12) {
      this.tx(() => {
        this.db.exec('ALTER TABLE deliveries ADD COLUMN outcome TEXT');
        this.db.exec('ALTER TABLE deliveries ADD COLUMN handoff_message_id TEXT REFERENCES messages(id)');
        this.db.exec('PRAGMA user_version = 13');
      });
    }
    if (version() === 13) {
      this.tx(() => {
        this.db.exec('DROP INDEX members_active_session');
        this.db.exec('DROP TRIGGER IF EXISTS members_session_mode_insert; DROP TRIGGER IF EXISTS members_session_mode_update');
        this.db.exec(multiSessionIndexes);
        this.db.exec('PRAGMA user_version = 14');
      });
    }
    if (version() === 14) {
      this.tx(() => {
        this.db.exec(activityTable);
        this.db.exec('PRAGMA user_version = 15');
      });
    }
    if (version() === 15) {
      this.tx(() => {
        this.db.exec('ALTER TABLE clusters ADD COLUMN deleted_at TEXT');
        this.db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
        this.db.exec(collaborationTablesV16);
        this.db.exec('PRAGMA user_version = 16');
      });
    }
    if (version() === 16) {
      this.tx(() => {
        // Roles written before v17 have no description yet; '' means "not described", never null.
        this.db.exec("ALTER TABLE collaboration_roles ADD COLUMN description TEXT NOT NULL DEFAULT ''");
        this.db.exec('PRAGMA user_version = 17');
      });
    }
    if (version() === 17) {
      this.tx(() => {
        // System notifications written before v18 report no collaboration event; readers see no field, never an error.
        this.db.exec('ALTER TABLE messages ADD COLUMN collab_event_id INTEGER');
        this.db.exec('PRAGMA user_version = 18');
      });
    }
    if (version() === 18) {
      this.tx(() => {
        // Old clusters: not pinned, not archived, nothing read yet. No other data changes.
        this.db.exec('ALTER TABLE clusters ADD COLUMN pinned_at TEXT');
        this.db.exec('ALTER TABLE clusters ADD COLUMN archived_at TEXT');
        this.db.exec('ALTER TABLE clusters ADD COLUMN user_read_message_id TEXT');
        this.db.exec('PRAGMA user_version = 19');
      });
    }
    if (version() === 19) {
      // The new delivery state must not be opened by an older Hub that cannot display it.
      this.tx(() => this.db.exec('PRAGMA user_version = 20'));
    }
    if (version() === 20) {
      // v21 is T1's task-lifecycle schema: approval gate, submitted commit, review rounds and the merged state.
      // These live in task and record JSON, so the migration only moves the version; reads normalize old records.
      this.tx(() => this.db.exec('PRAGMA user_version = 21'));
    }
    if (version() === 21) {
      // v22 is the merge window: one held window per cluster, persisted across restarts.
      this.tx(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS merge_windows (cluster_id TEXT PRIMARY KEY REFERENCES clusters(id), data_json TEXT NOT NULL)');
        this.db.exec('PRAGMA user_version = 22');
      });
    }
    if (version() === 22) {
      this.tx(() => {
        // Nothing old is marked: a delivery still queued gets its one warning; old notices have no stamp and are never marked expired.
        this.db.exec('ALTER TABLE messages ADD COLUMN client_message_id TEXT');
        this.db.exec('ALTER TABLE messages ADD COLUMN task_stamp_json TEXT');
        this.db.exec('ALTER TABLE deliveries ADD COLUMN queue_warned INTEGER NOT NULL DEFAULT 0');
        this.db.exec(clientMessageIndex);
        this.db.exec('PRAGMA user_version = 23');
      });
    }
    if (version() === 23) {
      this.tx(() => {
        this.db.exec(pluginMigrationsTable);   // plugins' tables that already exist are picked up by their own IF NOT EXISTS migrations
        this.db.exec('PRAGMA user_version = 24');
      });
    }
    if (version() === 24) {
      this.tx(() => {
        this.db.exec(pluginRateIndex);
        this.db.exec('PRAGMA user_version = 25');
      });
    }
    if (version() === 25) {
      this.tx(() => {
        this.db.exec('ALTER TABLE messages ADD COLUMN fyi INTEGER NOT NULL DEFAULT 0');
        this.db.exec('PRAGMA user_version = 26');
      });
    }
    if (version() === 26) {
      this.tx(() => {
        this.db.exec('ALTER TABLE messages ADD COLUMN system_kind TEXT');
        this.db.exec('ALTER TABLE messages ADD COLUMN explicit_mentions_json TEXT');
        this.db.exec('ALTER TABLE members ADD COLUMN unread_after_rowid INTEGER NOT NULL DEFAULT 0');
        this.db.exec("UPDATE messages SET system_kind = 'receipt' WHERE from_id = 'system' AND kind = 'system' AND body LIKE '确认回执：%'");
        this.db.exec("UPDATE messages SET system_kind = 'queue_warning' WHERE from_id = 'system' AND kind = 'system' AND body LIKE '排队预警：%'");
        this.db.exec(`UPDATE members SET unread_after_rowid = COALESCE(
          (SELECT MAX(m.rowid) FROM messages m WHERE m.cluster_id = members.cluster_id AND m.created_at < members.created_at), 0)`);
        this.db.exec('PRAGMA user_version = 27');
      });
    }
    if (version() === 27) {
      this.tx(() => {
        this.db.exec('ALTER TABLE members ADD COLUMN hidden_at TEXT');   // nobody is hidden after the upgrade
        this.db.exec('PRAGMA user_version = 28');
      });
    }
    if (version() === 28) {
      this.tx(() => {
        this.db.exec('ALTER TABLE deliveries ADD COLUMN dismissed_at TEXT');   // no problem is marked known after the upgrade
        // Old rows all count as before any listing (0); later changes are numbered by the triggers.
        this.db.exec('ALTER TABLE deliveries ADD COLUMN state_seq INTEGER NOT NULL DEFAULT 0');
        this.db.exec(deliveryStateSeq);
        // A skipped receipt may already have separate evidence that the member saw it.
        this.db.exec('ALTER TABLE reads ADD COLUMN seen_at TEXT');
        this.db.exec("UPDATE reads SET seen_at = at WHERE via != 'skip'");
        this.db.exec(`UPDATE reads SET seen_at = a.at FROM message_acknowledgements a
          WHERE reads.via = 'skip' AND a.member_id = reads.member_id AND a.message_id = reads.message_id`);
        this.db.exec('PRAGMA user_version = 29');
      });
    }
  }

  /** v10 → v11, the usage migration: empty tables (nothing was recorded before). Idempotent. */
  private addUsageTables(to: number): void {
    this.tx(() => {
      this.db.exec(usageTables);
      this.db.exec(`PRAGMA user_version = ${to}`);
    });
  }

  /** v4 → v5: replace table-level uniqueness with active-members-only indexes; keep every rowid and reference. */
  private addRemovalColumn(): void {
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.tx(() => {
        this.db.exec(membersTableV5('members_v5'));
        this.db.exec(`INSERT INTO members_v5 (rowid, ${MEMBER_COLUMNS_V4}) SELECT rowid, ${MEMBER_COLUMNS_V4} FROM members`);
        this.db.exec('DROP TABLE members');
        this.db.exec('ALTER TABLE members_v5 RENAME TO members');
        this.db.exec(memberIndexesV5);
        const broken = this.db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`schema v5 migration broke ${broken.length} foreign key(s)`);
        this.db.exec('PRAGMA user_version = 5');
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * v2 → v3: MCP tokens now live only in the Hub's memory. SQLite cannot drop a UNIQUE column, so `members` is
   * rebuilt (same columns minus mcp_token, same constraints, same rowids) in one transaction. Foreign keys are off
   * meanwhile, or dropping the old table would trip deliveries.member_id; they are checked before commit.
   * The version becomes 3 only after VACUUM and, in WAL mode, a complete TRUNCATE checkpoint (the VACUUM's pages are
   * in the WAL until then, and the old ones still in both files): if the cleanup fails, the next open redoes the
   * (idempotent) rebuild and the VACUUM.
   */
  private dropTokenColumn(): void {
    this.db.exec('PRAGMA foreign_keys = OFF');   // a no-op inside a transaction, so set before BEGIN
    try {
      this.tx(() => {
        this.db.exec(membersTableV3('members_v3'));
        this.db.exec(`INSERT INTO members_v3 (rowid, ${MEMBER_COLUMNS_V3}) SELECT rowid, ${MEMBER_COLUMNS_V3} FROM members`);
        this.db.exec('DROP TABLE members');
        this.db.exec('ALTER TABLE members_v3 RENAME TO members');
        const broken = this.db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`schema v3 migration broke ${broken.length} foreign key(s)`);
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
    // Freed pages still hold the old tokens; rewrite the file so they are gone from disk.
    this.db.exec('VACUUM');
    this.writeBackAll();
    this.db.exec('PRAGMA user_version = 3');
  }

  /**
   * Copies the whole WAL into the database file and truncates the WAL to zero bytes, or throws: for a step whose point
   * is that old bytes are gone from disk when it returns. Waits up to the busy timeout for other readers. Outside WAL
   * SQLite answers busy 0, log -1, checkpointed -1, which passes.
   */
  private writeBackAll(): void {
    const r = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row;
    if (r.busy !== 0 || r.log !== r.checkpointed) {
      throw new Error(`could not write the WAL back into the database file (busy ${r.busy}, log ${r.log}, checkpointed ${r.checkpointed}); the next start retries`);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Before migrations, which run inside transactions (journal_mode cannot change in one). The busy timeout comes
   * first, so switching the mode can wait for another process's brief lock. synchronous is not kept in the file and
   * is set on every open. Returns the mode in effect: a mode SQLite refuses (a network share, read-only media) is
   * kept, not an error.
   */
  private applyMode(path: string, mode: DbMode, setMode: SetJournalMode): string {
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.exec(`PRAGMA synchronous = ${mode.synchronous.toUpperCase()}`);
    this.db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
    if (path === ':memory:') return 'memory';
    try {
      return setMode(this.db, mode.journal);
    } catch {
      return String((this.db.prepare('PRAGMA journal_mode').get() as Row).journal_mode);
    }
  }

  private checkpointedChanges = -1;   // total_changes() at the last complete checkpoint; -1: none yet

  /**
   * Hands the WAL back to the database file and empties it, when anything was written since the last complete one
   * (the Hub's idle sweep calls it; closing does it too). Never waits: a reader holding an older snapshot (a backup)
   * leaves part of the log for the next call. Never throws. True when the WAL is empty afterwards (or there is none).
   */
  checkpoint(): boolean {
    if (this.journalMode !== 'wal') return true;
    if (this.depth > 0) return false;
    try {
      const changes = Number((this.db.prepare('SELECT total_changes() AS n').get() as Row).n);
      if (changes === this.checkpointedChanges) return true;
      this.db.exec('PRAGMA busy_timeout = 0');
      try {
        const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row;
        if (result.busy === 0) this.checkpointedChanges = changes;
        return result.busy === 0;
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      }
    } catch { return false; /* closed or busy: the next sweep tries again */ }
  }

  private readonly statements = new Map<string, StatementSync>();

  /** The statement for `sql`, prepared on first use and kept. Only for SQL text that is the same on every call. */
  prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql));
    return statement;
  }

  /** Runs `fn` as one transaction: all of its writes commit together or none do. A nested call joins the outer one. */
  transaction<T>(fn: () => T): T {
    return this.tx(fn);
  }

  private depth = 0;   // > 0 while inside a transaction

  private tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ---- clusters and members ----

  /** IDs in the cluster equal to `ref` or, when it is long enough, starting with it. instr, unlike LIKE, is case-sensitive and has no wildcards. */
  idsMatching(table: string, clusterId: string, ref: string, minPrefix: number): string[] {
    return this.db.prepare(`SELECT id FROM ${table} WHERE cluster_id = ? AND (id = ? OR (length(?) >= ? AND instr(id, ?) = 1))`)
      .all(clusterId, ref, ref, minPrefix, ref).map((row) => (row as Row).id as string);
  }

  collaborationOperation(clusterId: string, actor: string, operationId: string): { request: string; result: string } | null {
    const row = this.db.prepare('SELECT request_json, result_json FROM collaboration_operations WHERE cluster_id = ? AND actor = ? AND operation_id = ?')
      .get(clusterId, actor, operationId) as Row | undefined;
    return row ? { request: row.request_json, result: row.result_json } : null;
  }

  saveCollaborationOperation(clusterId: string, actor: string, operationId: string, request: string, result: string): void {
    this.db.prepare('INSERT INTO collaboration_operations VALUES (?, ?, ?, ?, ?)').run(clusterId, actor, operationId, request, result);
  }

  collaborationRoles(clusterId: string): Role[] {
    return this.db.prepare('SELECT id, cluster_id, name, description FROM collaboration_roles WHERE cluster_id = ? ORDER BY rowid').all(clusterId)
      .map((r) => ({ id: String(r.id), clusterId: String(r.cluster_id), name: String(r.name), description: String(r.description ?? '') }));
  }

  saveCollaborationRole(role: Role): void {
    this.db.prepare('INSERT INTO collaboration_roles (id, cluster_id, name, description) VALUES (?, ?, ?, ?)')
      .run(role.id, role.clusterId, role.name, role.description);
  }

  /** The description is the only editable role field (role.edit); the name stays the identifier tasks refer to. */
  setCollaborationRoleDescription(roleId: string, description: string): void {
    this.db.prepare('UPDATE collaboration_roles SET description = ? WHERE id = ?').run(description, roleId);
  }

  deleteCollaborationRole(roleId: string): void {
    this.db.prepare('DELETE FROM collaboration_member_roles WHERE role_id = ?').run(roleId);
    this.db.prepare('DELETE FROM collaboration_roles WHERE id = ?').run(roleId);
  }

  collaborationMemberRoles(clusterId: string): MemberRoles[] {
    const members = this.listMembers(clusterId);
    const q = this.db.prepare('SELECT role_id FROM collaboration_member_roles WHERE member_id = ? ORDER BY rowid');
    return members.map((m) => ({ memberId: m.id, roleIds: q.all(m.id).map((r) => String(r.role_id)) }));
  }

  setCollaborationMemberRoles(memberId: string, roleIds: string[]): void {
    this.db.prepare('DELETE FROM collaboration_member_roles WHERE member_id = ?').run(memberId);
    const ins = this.db.prepare('INSERT INTO collaboration_member_roles VALUES (?, ?)');
    for (const roleId of roleIds) ins.run(memberId, roleId);
  }

  // The cluster pause: the core's columns of collaboration_policies. The coordinator plugin owns data_json and generation on the same row (docs/plugins.md).
  clusterPause(clusterId: string): { paused: boolean; pausedBy: string | null } {
    const row = this.db.prepare('SELECT paused, paused_by FROM collaboration_policies WHERE cluster_id = ?').get(clusterId) as Row | undefined;
    return row ? { paused: row.paused === 1, pausedBy: row.paused_by } : { paused: false, pausedBy: null };
  }

  /** 'null' and 0 are what the plugin's columns hold for a cluster that never had a coordinator. */
  setClusterPaused(clusterId: string, paused: boolean, pausedBy: string | null): void {
    this.db.prepare(`INSERT INTO collaboration_policies (cluster_id, data_json, paused, generation, paused_by) VALUES (?, 'null', ?, 0, ?)
      ON CONFLICT(cluster_id) DO UPDATE SET paused = excluded.paused, paused_by = excluded.paused_by`).run(clusterId, paused ? 1 : 0, pausedBy);
  }

  /** The enabled plugins' extra fields for this message's JSON. */
  pluginFields(messageId: string): Record<string, unknown> {
    return this.plugins.messageFields(this, messageId);
  }

  /** A page of the cluster's messages (alias m). `where`: code-authored SQL conditions with their parameters, never user text. */
  collaborationCollection(clusterId: string, opts: { limit: number; cursor?: string; q?: string; sender?: string; since?: string; until?: string; where?: { sql: string; args: (string | number)[] }[] }): { items: CollectionItem[]; nextCursor: string | null } {
    const clauses = ['m.cluster_id = ?', 'm.rowid > ?'];
    const args: (string | number)[] = [clusterId, Number(opts.cursor) || 0];
    for (const condition of opts.where ?? []) { clauses.push(condition.sql); args.push(...condition.args); }
    if (opts.q) { clauses.push('instr(lower(m.body), lower(?)) > 0'); args.push(opts.q); }
    if (opts.sender) { clauses.push('m.from_id = ?'); args.push(opts.sender); }
    if (opts.since) { clauses.push('m.created_at >= ?'); args.push(opts.since); }
    if (opts.until) { clauses.push('m.created_at <= ?'); args.push(opts.until); }
    const rows = this.db.prepare(`SELECT m.rowid AS cursor, m.* FROM messages m WHERE ${clauses.join(' AND ')} ORDER BY m.rowid LIMIT ?`)
      .all(...args, opts.limit + 1) as Row[];
    const page = rows.slice(0, opts.limit);
    return { items: page.map((r) => ({ message: toMessage(r),
      ...this.pluginFields(r.id), attachments: this.attachmentsOf(r.id) })),
      nextCursor: rows.length > opts.limit ? String(page.at(-1)!.cursor) : null };
  }

  eventInCluster(clusterId: string, seq: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM events WHERE cluster_id = ? AND seq = ?').get(clusterId, seq);
  }

  /** One stored event by sequence, or null. The caller still checks its cluster and kind. */
  getEvent(seq: number): HubEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq);
    return r ? toEvent(r) : null;
  }

  /** Writes a cluster and all its members atomically. */
  insertCluster(cluster: Pick<Cluster, 'id' | 'name' | 'createdAt' | 'category'>, members: NewMember[]): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO clusters (id, name, created_at, category) VALUES (?, ?, ?, ?)')
        .run(cluster.id, cluster.name, cluster.createdAt, cluster.category);
      this.writeMembers(members, cluster.createdAt);
    });
  }

  private writeMembers(members: NewMember[], createdAt = new Date().toISOString()): void {
    const afterRowid = Number((this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS r FROM messages').get() as Row).r);
    const ins = this.db.prepare(`INSERT INTO members (${MEMBER_COLUMNS}, unread_after_rowid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of members) {
      ins.run(m.id, m.clusterId, m.name, m.avatar, m.harness, m.model, m.workerSessionId, m.cwd, m.origin,
        createdAt, m.mode, m.effort, m.removedAt, afterRowid);
    }
  }

  /** Adds the entire batch atomically; active unique indexes arbitrate concurrent additions. */
  insertMembers(members: NewMember[]): void {
    this.tx(() => {
      if (members.some((m) => !this.getCluster(m.clusterId))) throw new Error('unknown cluster');
      this.writeMembers(members);
    });
  }

  /** Invalidates membership and cancels pending work in the same transaction. History is retained. */
  removeMember(clusterId: string, memberId: string): { member: StoredMember; cancelled: Delivery[] } {
    return this.tx(() => {
      const member = this.getMember(memberId, { includeRemoved: true });
      if (!member || member.clusterId !== clusterId) throw new Error(`unknown member ${memberId} in this cluster`);
      if (member.removedAt) return { member, cancelled: [] };
      const removedAt = new Date().toISOString();
      this.db.prepare('UPDATE members SET removed_at = ?, hidden_at = NULL WHERE id = ?').run(removedAt, memberId);   // removal clears hiding
      const pending = this.db.prepare("SELECT * FROM deliveries WHERE member_id = ? AND state IN ('queued', 'running')").all(memberId);
      const cancelled = pending.map((d) => d.state === 'running'
        ? this.setDeliveryState(d.id as string, 'failed', '成员已移出集群，投递结果未知；原执行可能仍在继续', 'unknown')
        : this.setDeliveryState(d.id as string, 'failed', '成员已移出集群，投递已取消'));
      return { member: { ...member, removedAt, hiddenAt: null }, cancelled };
    });
  }

  /**
   * Hides or shows an active member (docs/cluster-members.md「隐身」); the Hub checks who may. Hiding supersedes its
   * deliveries that have not started (a running one goes on). Showing moves its unread starting point to now, so
   * nothing written while it was hidden, or before, counts as its unread. Joins a surrounding transaction.
   */
  setMemberHidden(memberId: string, hidden: boolean, reason: string): { member: StoredMember; superseded: Delivery[] } {
    return this.tx(() => {
      const now = new Date().toISOString();
      const changed = hidden
        ? this.db.prepare('UPDATE members SET hidden_at = ? WHERE id = ? AND removed_at IS NULL AND hidden_at IS NULL').run(now, memberId)
        : this.db.prepare(`UPDATE members SET hidden_at = NULL,
            unread_after_rowid = (SELECT COALESCE(MAX(rowid), 0) FROM messages) WHERE id = ? AND removed_at IS NULL AND hidden_at IS NOT NULL`).run(memberId);
      const member = this.getMember(memberId);
      if (!member) throw new Error(`unknown active member ${memberId}`);
      if (changed.changes === 0 || !hidden) return { member, superseded: [] };
      const superseded = this.db.prepare(`UPDATE deliveries SET state = 'superseded', outcome = NULL, error = ?, updated_at = ?
        WHERE member_id = ? AND state = 'queued' RETURNING *`).all(reason, now, memberId).map(toDelivery);
      return { member, superseded };
    });
  }

  /**
   * Moves an active native member to another conversation (Hub.rebindMember checks who may). Queued deliveries stay
   * queued and follow the member; running ones went to the old conversation, so their result is unknown (still unread).
   */
  rebindMember(memberId: string, to: Pick<StoredMember, 'workerSessionId' | 'cwd' | 'model'>): { member: StoredMember; interrupted: Delivery[] } {
    return this.tx(() => {
      const changed = this.db.prepare("UPDATE members SET worker_session_id = ?, cwd = ?, model = ?, origin = 'attached', effort = NULL WHERE id = ? AND removed_at IS NULL")
        .run(to.workerSessionId, to.cwd, to.model, memberId);
      if (changed.changes !== 1) throw new Error(`unknown active member ${memberId}`);
      this.db.prepare('DELETE FROM activity_snapshots WHERE member_id = ?').run(memberId);   // it described the old conversation
      const running = this.db.prepare("SELECT id FROM deliveries WHERE member_id = ? AND state = 'running'").all(memberId);
      const interrupted = running.map((d) => this.setDeliveryState(d.id as string, 'failed', '成员已换对话，投递结果未知；原对话可能仍在继续', 'unknown'));
      return { member: this.getMember(memberId)!, interrupted };
    });
  }

  /**
   * Work that landed on a hidden member at or after `since` (its hiding time), oldest first: the Hub's 'guard' events of
   * reason hidden_work (Hub.hiddenWorkLanded). The event log is the record, so a Hub restart keeps them.
   */
  hiddenWork(memberId: string, since: string): { seq: number; taskId: string; kind: string; role: string; revision: number | null; status: string | null; at: string }[] {
    return this.prepared(`SELECT seq, json_extract(payload_json, '$.taskId') AS task_id, json_extract(payload_json, '$.kind') AS kind,
        json_extract(payload_json, '$.role') AS role, json_extract(payload_json, '$.revision') AS revision,
        json_extract(payload_json, '$.status') AS status, created_at FROM events
      WHERE member_id = ? AND kind = 'guard' AND json_extract(payload_json, '$.reason') = 'hidden_work' AND created_at >= ? ORDER BY seq`)
      .all(memberId, since).map((r) => ({ seq: Number(r.seq), taskId: String(r.task_id), kind: String(r.kind), role: String(r.role),
        revision: r.revision == null ? null : Number(r.revision), status: r.status == null ? null : String(r.status), at: String(r.created_at) }));
  }

  /** The member's moves to another conversation, oldest first. The event log is append-only, so these records are too. */
  memberRebinds(memberId: string): (MemberRebind & { eventId: number })[] {
    return this.db.prepare("SELECT seq, json_extract(payload_json, '$.rebind') AS rebind FROM events WHERE member_id = ? AND kind = 'member' AND json_extract(payload_json, '$.rebind') IS NOT NULL ORDER BY seq")
      .all(memberId).map((r) => ({ ...JSON.parse(r.rebind as string), eventId: Number(r.seq) }));
  }

  /**
   * Clusters in creation order, each with its newest message time (its creation time when it has none). The value is
   * computed from messages in the same query: no extra column or table.
   */
  listClusters(deleted = false): ClusterListing[] {
    // The recycle bin also says what a permanent delete would remove (messages_cluster index; files are few).
    const counts = deleted ? `, (SELECT COUNT(*) FROM messages m WHERE m.cluster_id = c.id) AS message_count,
        (SELECT COUNT(*) FROM files f WHERE f.cluster_id = c.id) AS file_count,
        (SELECT COALESCE(MAX(e.seq), 0) FROM events e WHERE e.cluster_id = c.id AND e.kind = 'cluster'
          AND json_extract(e.payload_json, '$.cluster.deletedAt') IS NOT NULL) AS trash_version` : '';
    return this.db.prepare(`SELECT c.*,
        COALESCE((SELECT m.created_at FROM messages m WHERE m.cluster_id = c.id ORDER BY m.rowid DESC LIMIT 1), c.created_at)
          AS last_message_at,
        (SELECT p.paused FROM collaboration_policies p WHERE p.cluster_id = c.id) AS paused${counts}
      FROM clusters c WHERE (c.deleted_at IS NOT NULL) = ? ORDER BY c.rowid`).all(deleted ? 1 : 0)
      .map((r) => ({ ...toCluster(r), lastMessageAt: String(r.last_message_at), paused: r.paused === 1,
        ...(deleted ? { messageCount: Number(r.message_count), fileCount: Number(r.file_count), trashVersion: Number(r.trash_version) } : {}) }));
  }

  /** Changes the given fields of an active cluster in one statement; the values are checked by the Hub. */
  updateCluster(id: string, changes: ClusterChanges): Cluster {
    const keys = Object.keys(changes) as (keyof ClusterChanges)[];
    if (keys.length) {
      this.db.prepare(`UPDATE clusters SET ${keys.map((k) => `${CLUSTER_CHANGE_COLUMNS[k]} = ?`).join(', ')} WHERE id = ? AND deleted_at IS NULL`)
        .run(...keys.map((k) => changes[k] ?? null), id);
    }
    const cluster = this.getCluster(id);
    if (!cluster) throw new Error(`unknown cluster ${id}`);
    return cluster;
  }

  /**
   * Moves the user's read position in an active cluster to `messageId`, a message of that cluster, but only forward
   * (by storage order). `changed` is false when the message is not newer than the current position.
   */
  advanceUserRead(id: string, messageId: string): { cluster: Cluster; changed: boolean } {
    return this.tx(() => {
      const cluster = this.getCluster(id);
      if (!cluster) throw new Error(`unknown cluster ${id}`);
      const target = this.db.prepare('SELECT rowid FROM messages WHERE id = ? AND cluster_id = ?').get(messageId, id);
      if (!target) throw new Error(`unknown message ${messageId} in this cluster`);
      const current = cluster.userReadMessageId === null ? undefined
        : this.db.prepare('SELECT rowid FROM messages WHERE id = ?').get(cluster.userReadMessageId);
      if (current && Number(current.rowid) >= Number(target.rowid)) return { cluster, changed: false };
      this.db.prepare('UPDATE clusters SET user_read_message_id = ? WHERE id = ?').run(messageId, id);
      return { cluster: this.getCluster(id)!, changed: true };
    });
  }

  getCluster(id: string, options: { includeDeleted?: boolean } = {}): Cluster | null {
    const r = this.db.prepare('SELECT * FROM clusters WHERE id = ?' + (options.includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    return r ? toCluster(r) : null;
  }

  listMembers(clusterId?: string, options: { includeRemoved?: boolean } = {}): StoredMember[] {
    const filters = [options.includeRemoved ? '' : 'removed_at IS NULL', 'cluster_id IN (SELECT id FROM clusters WHERE deleted_at IS NULL)', clusterId === undefined ? '' : 'cluster_id = ?'].filter(Boolean);
    return this.db.prepare('SELECT * FROM members' + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDER BY rowid')
      .all(...(clusterId === undefined ? [] : [clusterId])).map(toMember);
  }

  getMember(id: string, options: { includeRemoved?: boolean } = {}): StoredMember | null {
    const r = this.db.prepare('SELECT * FROM members WHERE id = ?' + (options.includeRemoved ? '' : ' AND removed_at IS NULL AND cluster_id IN (SELECT id FROM clusters WHERE deleted_at IS NULL)')).get(id);
    return r ? toMember(r) : null;
  }

  getMembersBySession(harness: string, sessionId: string): StoredMember[] {
    return this.db.prepare('SELECT * FROM members WHERE harness = ? AND worker_session_id = ? AND removed_at IS NULL AND cluster_id IN (SELECT id FROM clusters WHERE deleted_at IS NULL) ORDER BY rowid')
      .all(harness, sessionId).map(toMember);
  }

  /** Eligibility is per current membership, derived from existing collaboration records. */
  hasActivityParticipation(memberId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM members m JOIN clusters c ON c.id = m.cluster_id WHERE m.id = ? AND m.removed_at IS NULL AND c.deleted_at IS NULL AND (
      EXISTS (SELECT 1 FROM deliveries d WHERE d.member_id = m.id AND d.attempts > 0)
      OR EXISTS (SELECT 1 FROM messages msg WHERE msg.from_id = m.id)
      OR EXISTS (SELECT 1 FROM reads r WHERE r.member_id = m.id AND r.via IN ('read_messages', 'ack_messages'))
      OR EXISTS (SELECT 1 FROM message_acknowledgements a WHERE a.member_id = m.id)
    )`).get(memberId);
  }

  activitySnapshot(memberId: string): { source: string; lastSeenAt: string; lastActivityAt: string | null; event: unknown } | null {
    const r = this.db.prepare('SELECT source, last_seen_at, last_activity_at, event_json FROM activity_snapshots WHERE member_id = ?').get(memberId) as Row | undefined;
    if (!r) return null;
    return { source: r.source, lastSeenAt: r.last_seen_at, lastActivityAt: r.last_activity_at,
      event: r.event_json === null ? null : JSON.parse(r.event_json) };
  }

  /**
   * The newest activity the Hub has recorded for a member, or null when it has any evidence at all: a message it
   * sent, a delivery to it that started or ended (merely queued does not count), an activity event or heartbeat, a
   * read receipt or an acknowledgement. Used by the stalled-member reminder (Hub.checkStalled).
   */
  lastActivity(memberId: string): { at: string; source: 'message' | 'delivery' | 'activity' | 'read' | 'acknowledgement'; event: unknown } | null {
    const r = this.db.prepare(`SELECT at, source, event_json FROM (
      SELECT created_at AS at, 'message' AS source, NULL AS event_json FROM messages WHERE from_id = ?
      UNION ALL SELECT updated_at, 'delivery', NULL FROM deliveries
        WHERE member_id = ? AND (attempts > 0 OR state != 'queued')
      UNION ALL SELECT last_seen_at, 'activity', event_json FROM activity_snapshots WHERE member_id = ?
      UNION ALL SELECT at, 'read', NULL FROM reads WHERE member_id = ?
      UNION ALL SELECT at, 'acknowledgement', NULL FROM message_acknowledgements WHERE member_id = ?
    ) ORDER BY at DESC LIMIT 1`).get(memberId, memberId, memberId, memberId, memberId) as Row | undefined;
    if (!r) return null;
    return { at: r.at, source: r.source, event: r.event_json === null ? null : JSON.parse(r.event_json) };
  }

  /** One latest row per member; heartbeats preserve the last actual event and its time. */
  saveActivity(memberId: string, source: string, at: string, event?: ActivityObservation): void {
    if (event === undefined) {
      this.db.prepare(`INSERT INTO activity_snapshots (member_id, source, last_seen_at) VALUES (?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET source = excluded.source, last_seen_at = excluded.last_seen_at`).run(memberId, source, at);
    } else {
      this.db.prepare(`INSERT INTO activity_snapshots (member_id, source, last_seen_at, last_activity_at, event_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET source = excluded.source, last_seen_at = excluded.last_seen_at,
        last_activity_at = excluded.last_activity_at, event_json = excluded.event_json`)
        .run(memberId, source, at, at, JSON.stringify(event));
    }
  }

  /** Oldest queue head across runnable bindings, including pending checks. Exclude one binding to find its FIFO barrier. */
  firstQueuedSession(harness: string, sessionId: string, except: string | null = null): QueuedCandidate | null {
    const row = this.prepared(`SELECT ${QUEUE_CANDIDATE_COLUMNS} FROM members r
      JOIN clusters c ON c.id = r.cluster_id LEFT JOIN collaboration_policies p ON p.cluster_id = r.cluster_id
      JOIN deliveries d ON d.rowid = (SELECT rowid FROM deliveries WHERE member_id = r.id AND state = 'queued' ORDER BY rowid LIMIT 1)
      JOIN messages m ON m.id = d.message_id
      WHERE r.harness = ? AND r.worker_session_id = ? AND r.mode = 'native' AND r.removed_at IS NULL
        AND (? IS NULL OR r.id != ?) AND c.deleted_at IS NULL AND COALESCE(p.paused, 0) = 0 ORDER BY d.rowid LIMIT 1`)
      .get(harness, sessionId, except, except);
    return row ? toQueuedCandidate(row) : null;
  }

  updateMember(id: string, fields: { name?: string; avatar?: string | null }): StoredMember {
    if (!this.getMember(id)) throw new Error(`unknown active member ${id}`);
    if (fields.name !== undefined) this.db.prepare('UPDATE members SET name = ? WHERE id = ? AND removed_at IS NULL').run(fields.name, id);
    if (fields.avatar !== undefined) this.db.prepare('UPDATE members SET avatar = ? WHERE id = ? AND removed_at IS NULL').run(fields.avatar, id);
    return this.getMember(id)!;
  }

  // ---- messages and deliveries ----

  /**
   * Writes the message, its file links (`fileIds`, in order) and one queued delivery per recipient atomically.
   * `direct`: deliver the body without envelope. `clientMessageId`: the sender's idempotency key (see messageByClientId).
   */
  insertMessage(msg: Message, recipientIds: string[], direct = false, fileIds: string[] = [], clientMessageId?: string): Delivery[] {
    return this.tx(() => {
      this.db.prepare(`INSERT INTO messages
        (id, cluster_id, from_id, mentions_json, body, reply_to, chain_id, hop, created_at, direct, kind, collab_event_id, client_message_id, task_stamp_json, fyi, system_kind, explicit_mentions_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(msg.id, msg.clusterId, msg.from, JSON.stringify(msg.mentions), msg.body, msg.replyTo, msg.chainId, msg.hop, msg.createdAt, direct ? 1 : 0, msg.kind ?? 'chat', msg.collabEventId ?? null,
          clientMessageId ?? null, msg.taskStamp ? JSON.stringify(msg.taskStamp) : null, msg.fyi ? 1 : 0, msg.systemKind ?? null,
          msg.explicitMentions !== undefined ? JSON.stringify(msg.explicitMentions) : null);
      const link = this.db.prepare('INSERT INTO message_files (message_id, file_id, position) VALUES (?, ?, ?)');
      fileIds.forEach((id, i) => link.run(msg.id, id, i));
      const ins = this.db.prepare(
        'INSERT INTO deliveries (id, message_id, member_id, state, error, updated_at) VALUES (?, ?, ?, ?, NULL, ?)',
      );
      // The one place deliveries are created: a hidden member gets none of any kind (docs/cluster-members.md「隐身」).
      const hidden = this.prepared('SELECT 1 FROM members WHERE id = ? AND hidden_at IS NOT NULL');
      return recipientIds.filter((memberId) => !hidden.get(memberId)).map((memberId) => {
        const d: Delivery = { id: randomUUID(), messageId: msg.id, memberId, state: 'queued', outcome: null, handoffMessageId: null, error: null, updatedAt: msg.createdAt, batchId: null, attempts: 0 };
        ins.run(d.id, d.messageId, d.memberId, d.state, d.updatedAt);
        return d;
      });
    });
  }

  getMessage(id: string): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return r ? toMessage(r) : null;
  }

  /** The message this sender already wrote with this idempotency key, if any. */
  messageByClientId(fromId: string, clientMessageId: string): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE from_id = ? AND client_message_id = ?').get(fromId, clientMessageId);
    return r ? toMessage(r) : null;
  }

  getDelivery(id: string): Delivery | null {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
    return r ? toDelivery(r) : null;
  }

  /** Use the member event index; a later handoff changes updated_at without ending the delivery again. */
  deliveryTimes(delivery: Delivery): { startedAt?: string; endedAt?: string } {
    const row = this.db.prepare(`SELECT
      MIN(CASE WHEN json_extract(payload_json, '$.delivery.state') = 'running'
        THEN json_extract(payload_json, '$.delivery.updatedAt') END) AS started_at,
      MIN(CASE WHEN json_extract(payload_json, '$.delivery.state') IN ('done', 'failed', 'offline', 'superseded')
        AND json_extract(payload_json, '$.delivery.handoffMessageId') IS NULL
        THEN json_extract(payload_json, '$.delivery.updatedAt') END) AS ended_at
      FROM events WHERE member_id = ? AND kind = 'delivery'
        AND json_extract(payload_json, '$.delivery.id') = ?`).get(delivery.memberId, delivery.id) as Row;
    const terminal = delivery.state === 'done' || delivery.state === 'failed' || delivery.state === 'offline' || delivery.state === 'superseded';
    const endedAt = terminal ? row.ended_at ?? (delivery.handoffMessageId ? undefined : delivery.updatedAt) : undefined;
    return { ...(row.started_at ? { startedAt: row.started_at } : {}), ...(endedAt ? { endedAt } : {}) };
  }

  /** deliveryTimes for many deliveries: one aggregate over these members' delivery events, keyed by delivery id. */
  deliveryEventTimes(memberIds: string[]): Map<string, { startedAt?: string; endedAt?: string }> {
    const ids = [...new Set(memberIds)];
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT json_extract(payload_json, '$.delivery.id') AS id,
      MIN(CASE WHEN json_extract(payload_json, '$.delivery.state') = 'running'
        THEN json_extract(payload_json, '$.delivery.updatedAt') END) AS started_at,
      MIN(CASE WHEN json_extract(payload_json, '$.delivery.state') IN ('done', 'failed', 'offline', 'superseded')
        AND json_extract(payload_json, '$.delivery.handoffMessageId') IS NULL
        THEN json_extract(payload_json, '$.delivery.updatedAt') END) AS ended_at
      FROM events WHERE member_id IN (${ids.map(() => '?').join(',')}) AND kind = 'delivery'
      GROUP BY id`).all(...ids) as Row[];
    return new Map(rows.map((row) => [String(row.id), {
      ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
      ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
    }]));
  }

  setHandoff(id: string, messageId: string): Delivery {
    const r = this.db.prepare('UPDATE deliveries SET handoff_message_id = ?, updated_at = ? WHERE id = ? AND handoff_message_id IS NULL')
      .run(messageId, new Date().toISOString(), id);
    if (r.changes !== 1) throw new Error('delivery already has a handoff');
    return this.getDelivery(id)!;
  }

  isDirect(messageId: string): boolean {
    return (this.db.prepare('SELECT direct FROM messages WHERE id = ?').get(messageId) as Row | undefined)?.direct === 1;
  }

  /** A session's newest delivery with evidence of an attempt, including removed memberships and uncertain results. */
  lastDeliveredToSession(harness: string, sessionId: string, messageId?: string): Message | null {
    const r = this.db.prepare(`SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id
      JOIN members recipient ON recipient.id = d.member_id
      WHERE recipient.harness = ? AND recipient.worker_session_id = ?
        AND (d.state IN ('running', 'done') OR d.attempts > 0) AND (? IS NULL OR m.id = ?)
      ORDER BY d.rowid DESC LIMIT 1`).get(harness, sessionId, messageId ?? null, messageId ?? null);
    return r ? toMessage(r) : null;
  }

  /** Each delivery's own terminal-event time (the MIN rule lastDeliveryProblem explains), keyed by delivery id. */
  private terminalDeliveryTimes(memberId: string): Map<string, string> {
    const ended = this.db.prepare(`SELECT json_extract(payload_json, '$.delivery.id') AS id,
        MIN(json_extract(payload_json, '$.delivery.updatedAt')) AS ended_at
      FROM events WHERE member_id = ? AND kind = 'delivery'
        AND json_extract(payload_json, '$.delivery.state') IN ('done', 'failed', 'offline', 'superseded')
        AND json_extract(payload_json, '$.delivery.handoffMessageId') IS NULL
      GROUP BY id`).all(memberId) as Row[];
    return new Map(ended.map((row) => [String(row.id), String(row.ended_at)]));
  }

  /**
   * The member's recent deliveries that ended failed, offline, or with a failed/unknown outcome, newest first, each
   * with the message that did not get through (the handover package's delivery section). The time is the delivery's
   * own terminal event, as lastDeliveryProblem reads it; after a handoff it stays unknown (null).
   */
  recentDeliveryProblems(memberId: string, limit: number): { delivery: Delivery; message: Message; at: string | null }[] {
    const rows = this.db.prepare(`SELECT ${QUEUED_COLUMNS}, m.created_at AS message_created_at FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      WHERE d.member_id = ? AND (d.state IN ('failed', 'offline') OR d.outcome IN ('failed', 'unknown'))`).all(memberId) as Row[];
    if (!rows.length) return [];
    const endedAt = this.terminalDeliveryTimes(memberId);
    const problems = rows.map((row) => {
      const delivery = toDelivery(row);
      const at = endedAt.get(delivery.id) ?? (delivery.handoffMessageId ? null : delivery.updatedAt);
      return { delivery, message: toMessage({ ...row, id: row.message_id }), at, order: at ?? String(row.message_created_at) };
    });
    problems.sort((a, b) => b.order.localeCompare(a.order) || b.message.id.localeCompare(a.message.id));
    return problems.slice(0, limit).map(({ delivery, message, at }) => ({ delivery, message, at }));
  }

  /**
   * The newest delivery to this member that ended failed or offline, for the member page's last-problem line.
   * The time comes from each delivery's own failure event (the same MIN rule as deliveryTimes). A later handoff
   * rewrites the row's updated_at without ending the delivery again, so such a row's updated_at is not a failure
   * time: the row is then ordered by its message's creation time but reports `at: null` (unknown time).
   * The member's terminal delivery events are aggregated in one query, not scanned once per failed delivery.
   */
  lastDeliveryProblem(memberId: string): { state: 'failed' | 'offline'; error: string | null; at: string | null; messageId: string } | null {
    const rows = this.db.prepare(`SELECT d.*, m.created_at AS message_created_at FROM deliveries d
      JOIN messages m ON m.id = d.message_id
      WHERE d.member_id = ? AND d.state IN ('failed', 'offline')`).all(memberId) as Row[];
    if (!rows.length) return null;
    const endedAt = this.terminalDeliveryTimes(memberId);
    let best: { delivery: Delivery; at: string | null; order: string } | null = null;
    for (const row of rows) {
      const delivery = toDelivery(row);
      const at = endedAt.get(delivery.id) ?? (delivery.handoffMessageId ? null : delivery.updatedAt);
      const order = at ?? String(row.message_created_at);
      if (!best || order > best.order) best = { delivery, at, order };
    }
    return { state: best!.delivery.state as 'failed' | 'offline', error: best!.delivery.error, at: best!.at, messageId: best!.delivery.messageId };
  }

  /** Up to `limit` most recent messages of a cluster, older than message `before` if given; oldest first. */
  listMessages(clusterId: string, limit: number, before?: string, filters: MessageFilters = {}): Message[] {
    const cursor = before
      ? (this.db.prepare('SELECT rowid AS r FROM messages WHERE id = ? AND cluster_id = ?').get(before, clusterId) as Row | undefined)?.r ?? 0
      : Number.MAX_SAFE_INTEGER;
    const where = ['m.cluster_id = ?', 'm.rowid < ?'];
    const params: (string | number)[] = [clusterId, cursor];
    this.messageFilter(where, params, filters);
    return this.db.prepare(`SELECT * FROM (
        SELECT m.rowid AS r, m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.rowid DESC LIMIT ?
      ) ORDER BY r`).all(...params, limit).map(toMessage);
  }

  /** Up to `limit` messages of a cluster newer than message `after` (unknown: none), oldest first. */
  listMessagesAfter(clusterId: string, limit: number, after: string): Message[] {
    const cursor = this.messageRowid(clusterId, after);
    if (cursor === null) return [];
    return this.db.prepare('SELECT * FROM messages WHERE cluster_id = ? AND rowid > ? ORDER BY rowid LIMIT ?')
      .all(clusterId, cursor, limit).map(toMessage);
  }

  /**
   * Per active cluster, the messages not from the user after the user's read position (all of them when there is
   * none): the page's sidebar badge (ui.js clusterUnread), counted here so the page needs no message to show it.
   */
  unreadCounts(): Map<string, number> {
    const rows = this.db.prepare(`SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.cluster_id = c.id AND m.from_id != 'user'
        AND m.rowid > COALESCE((SELECT r.rowid FROM messages r WHERE r.id = c.user_read_message_id), 0)) AS unread
      FROM clusters c WHERE c.deleted_at IS NULL`).all();
    return new Map(rows.map((r) => [String(r.id), Number(r.unread)]));
  }

  /** Deliveries in state 'running', as { id, memberId }: what the page counts as a member at work. */
  runningDeliveries(): { id: string; memberId: string }[] {
    return this.db.prepare("SELECT id, member_id FROM deliveries WHERE state = 'running' ORDER BY rowid").all()
      .map((r) => ({ id: String(r.id), memberId: String(r.member_id) }));
  }

  /**
   * A cluster's deliveries that went wrong and nobody has handed off or resent yet (ui.js canHandoff): offline,
   * failed or with an unknown outcome, not superseded, not marked known by the user, and not an offline delivery whose
   * member has since read the message (PROBLEM_WHERE). `count` is all of them; `items` the newest `limit`, newest first.
   * `version`: the current high-water mark, read with them; "全部标为已知" sends it back as its bound.
   */
  deliveryProblems(clusterId: string, limit: number): { count: number; items: { message: Message; delivery: Delivery }[]; version: number } {
    const where = PROBLEM_WHERE;
    const version = Number(this.settingValue(DELIVERY_STATE_SEQUENCE_KEY) ?? 0);
    const count = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE ${where}`)
      .get(clusterId) as Row).n);
    const rows = this.db.prepare(`SELECT d.*, m.rowid AS message_rowid FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE ${where} ORDER BY m.rowid DESC, d.rowid DESC LIMIT ?`).all(clusterId, limit);
    const messages = new Map(this.db.prepare('SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...new Set(rows.map((r) => r.message_id))])).map((r) => [String(r.id), toMessage(r)]));
    return { count, items: rows.map((r) => ({ message: messages.get(String(r.message_id))!, delivery: toDelivery(r) })), version };
  }

  /**
   * The user marks one of the cluster's delivery problems as known (标为已知): true when this marked it, false when it
   * was marked before. Throws for a delivery of another cluster or one that is no problem. Nothing else of it changes.
   */
  dismissDeliveryProblem(clusterId: string, deliveryId: string, at: string): boolean {
    const row = this.db.prepare('SELECT d.dismissed_at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.id = ? AND m.cluster_id = ?')
      .get(deliveryId, clusterId) as Row | undefined;
    if (!row) throw new Error('unknown delivery in this cluster');
    if (row.dismissed_at) return false;
    const marked = this.db.prepare(`UPDATE deliveries SET dismissed_at = ? WHERE id IN (
        SELECT d.id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE ${PROBLEM_WHERE} AND d.id = ?)`).run(at, clusterId, deliveryId);
    if (!marked.changes) throw new Error('delivery is not a delivery problem');
    return true;
  }

  /**
   * Marks known every delivery problem of the cluster that was already in that state at `version` (deliveryProblems'
   * version, read with the listing the user saw): a delivery inserted or changed since has a larger state_seq and stays,
   * whatever the clock says. Returns their ids.
   */
  dismissDeliveryProblems(clusterId: string, version: number, at: string): string[] {
    return this.db.prepare(`UPDATE deliveries SET dismissed_at = ? WHERE id IN (
        SELECT d.id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE ${PROBLEM_WHERE} AND d.state_seq <= ?) RETURNING id`)
      .all(at, clusterId, version).map((r) => String(r.id));
  }

  /**
   * One page of a member page's lines, newest `limit` before event `before` (none: the newest), oldest first: the
   * member's own agent, delivery, guard and unread_hint events, and the delivery each 'message' event created for it
   * (that event has no member, the deliveries are in its payload). A delivery line carries `message` { from, body },
   * the body cut to 200 characters, so the page can name it without holding the message.
   */
  memberEventPage(memberId: string, limit: number, before?: number): HubEvent[] {
    const member = this.getMember(memberId, { includeRemoved: true });
    if (!member) return [];
    const cursor = before ?? Number.MAX_SAFE_INTEGER;
    const own = this.db.prepare(`SELECT * FROM events WHERE member_id = ? AND seq < ?
      AND kind IN ('agent', 'delivery', 'guard', 'unread_hint') ORDER BY seq DESC LIMIT ?`).all(memberId, cursor, limit).map(toEvent);
    // The member id is a UUID: a plain text search finds its 'message' events; the payload check below confirms each.
    // shortcut: no index reaches a member inside a payload, so this walks back from `cursor` until `limit` match (the
    // whole log for a member with few); add one with a schema change if long logs make member pages slow (docs/security.md).
    const created = this.db.prepare(`SELECT * FROM events WHERE seq < ? AND kind = 'message' AND cluster_id = ?
      AND instr(payload_json, ?) > 0 ORDER BY seq DESC LIMIT ?`).all(cursor, member.clusterId, `"memberId":${JSON.stringify(memberId)}`, limit)
      .map(toEvent).flatMap((e) => {
        const p = e.payload as { message: Message; deliveries: Delivery[] };
        const delivery = p.deliveries?.find((d) => d.memberId === memberId);
        return delivery ? [{ ...e, memberId, kind: 'delivery' as const, payload: { delivery } }] : [];
      });
    const page = [...own, ...created].sort((a, b) => b.seq - a.seq).slice(0, limit).reverse();
    const ids = [...new Set(page.flatMap((e) => e.kind === 'delivery' ? [(e.payload as { delivery: Delivery }).delivery.messageId] : []))];
    const about = new Map(this.db.prepare('SELECT id, from_id, substr(body, 1, 200) AS body FROM messages WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(ids)).map((r) => [String(r.id), { from: String(r.from_id), body: String(r.body) }]));
    return page.map((e) => {
      if (e.kind !== 'delivery') return e;
      const message = about.get((e.payload as { delivery: Delivery }).delivery.messageId);
      return message ? { ...e, payload: { ...(e.payload as object), message } } : e;
    });
  }

  /** The rowid of a message in the cluster, or null. */
  messageRowid(clusterId: string, messageId: string): number | null {
    const row = this.db.prepare('SELECT rowid AS r FROM messages WHERE id = ? AND cluster_id = ?').get(messageId, clusterId) as Row | undefined;
    return row ? Number(row.r) : null;
  }

  /**
   * One page of the user's history search (docs/collaboration-api.md「搜索群聊记录」): the cluster's messages matching
   * `search`, from `cursor` (a rowid, exclusive; none: the newest or the oldest end) in `order`. Each call looks at no
   * more than `scanCap` messages and no more than `scanBytes` bytes of message text in all (only the first may pass it alone) (node:sqlite is
   * synchronous: a long chat, or long messages, must not hold up the Hub), so `next` says why the page ended early:
   * `limit` results found, or `scan` (a bound was reached first); null when history is exhausted.
   * Old acknowledgement receipts are never found, as the chat never shows them.
   * A hit carries an `excerpt` instead of its body: about SEARCH_EXCERPT characters from a little before the first hit of
   * `q` (the start without `q`), cut in SQL, so a long message is never copied into JS; `cutBefore`/`cutAfter` say
   * whether text was left out on either side.
   */
  searchMessages(clusterId: string, search: MessageSearch, page: { cursor?: number; order: 'asc' | 'desc'; limit: number; scanCap: number; scanBytes: number }):
    { hits: SearchHit[]; next: { rowid: number; reason: 'limit' | 'scan' } | null } {
    const desc = page.order === 'desc';
    const capped = `SELECT rowid AS r FROM messages WHERE cluster_id = ? AND rowid ${desc ? '<' : '>'} ?
      ORDER BY rowid ${desc ? 'DESC' : 'ASC'} LIMIT ?`;
    // Of those, the rows up to the byte budget, counting each row's own text (the first row always, even when it alone
    // is larger). octet_length reads the size from the record header, not the text; it is taken in its own step so the
    // window function sorts sizes, never copies of the text.
    const window = `SELECT r FROM (SELECT r, SUM(n) OVER (ORDER BY r ${desc ? 'DESC' : 'ASC'} ROWS UNBOUNDED PRECEDING) AS total, n
      FROM (SELECT c.r, octet_length(b.body) AS n FROM (${capped}) c CROSS JOIN messages b ON b.rowid = c.r)) WHERE total <= ? OR total = n`;
    const cappedParams = [clusterId, page.cursor ?? (desc ? Number.MAX_SAFE_INTEGER : 0), page.scanCap];
    const windowParams = [...cappedParams, page.scanBytes];
    const where = ["(m.system_kind IS NULL OR m.system_kind != 'receipt')"];
    const params: (string | number)[] = [];
    this.messageFilter(where, params, { q: search.q, senderId: search.senderId, since: search.since, until: search.until });
    if (search.systemKinds) {
      const { kinds, not } = search.systemKinds;
      const list = kinds.map(() => '?').join(', ');
      where.push(not ? `(m.from_id = 'system' AND m.kind = 'system' AND (m.system_kind IS NULL OR m.system_kind NOT IN (${list})))`
        : `(m.from_id = 'system' AND m.kind = 'system' AND m.system_kind IN (${list}))`);
      params.push(...kinds);
    }
    if (search.withFiles) where.push('EXISTS (SELECT 1 FROM message_files f WHERE f.message_id = m.id)');
    // The window is the next rows of the cluster index in order, within both bounds; LIMIT and the window function keep
    // SQLite from flattening it away. The inner query finds the hits and where each excerpt starts (instr, like LIKE,
    // folds A–Z only and is literal); the outer one takes only the excerpt, never the body, into JS.
    const order = `ORDER BY r ${desc ? 'DESC' : 'ASC'}`;
    const length = SEARCH_EXCERPT + (search.q?.length ?? 0);
    // The outer query reads each hit's row again, so neither query carries a whole body through a sort.
    const rows = this.db.prepare(`SELECT x.r, h.id, h.cluster_id, h.from_id, h.mentions_json, h.reply_to, h.chain_id, h.hop, h.created_at, h.kind,
        h.collab_event_id, h.task_stamp_json, h.fyi, h.system_kind, h.explicit_mentions_json, substr(h.body, x.s, ?) AS body,
        x.s > 1 AS cut_before, length(substr(h.body, x.s, ? + 1)) > ? AS cut_after
      FROM (SELECT m.rowid AS r, ${search.q ? `max(1, instr(lower(m.body), lower(?)) - ${SEARCH_EXCERPT_BEFORE})` : '1'} AS s
        FROM (${window}) w CROSS JOIN messages m ON m.rowid = w.r WHERE ${where.join(' AND ')} ${order} LIMIT ?) x
      CROSS JOIN messages h ON h.rowid = x.r ORDER BY x.r ${desc ? 'DESC' : 'ASC'}`)
      .all(length, length, length, ...(search.q ? [search.q] : []), ...windowParams, ...params, page.limit) as Row[];
    const hits = rows.map((row): SearchHit => {
      const { body, ...message } = toMessage(row);
      return { ...message, excerpt: body, cutBefore: Boolean(row.cut_before), cutAfter: Boolean(row.cut_after) };
    });
    if (rows.length === page.limit) return { hits, next: { rowid: Number(rows.at(-1)!.r), reason: 'limit' } };
    // History goes on when the byte budget cut the capped rows short, or the cap itself was reached.
    const scanned = this.db.prepare(`SELECT COUNT(*) AS n, ${desc ? 'MIN' : 'MAX'}(r) AS edge, (SELECT COUNT(*) FROM (${capped})) AS capped
      FROM (${window})`).get(...cappedParams, ...windowParams) as Row;
    const more = Number(scanned.n) < Number(scanned.capped) || Number(scanned.capped) === page.scanCap;
    return { hits, next: more ? { rowid: Number(scanned.edge), reason: 'scan' } : null };
  }

  /** LIKE-escapes % _ and \ so a keyword matches literally; the SQL must use ESCAPE '\\'. */
  private static likePattern(value: string): string {
    return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  }

  /** Appends the shared read filters to a WHERE clause on the messages alias m. */
  private messageFilter(where: string[], params: (string | number)[], filters: MessageFilters): void {
    if (filters.kind) { where.push('m.kind = ?'); params.push(filters.kind); }
    if (filters.excludeKinds?.length) {
      where.push(`m.kind NOT IN (${filters.excludeKinds.map(() => '?').join(', ')})`);
      params.push(...filters.excludeKinds);
    }
    if (filters.since) { where.push('m.created_at >= ?'); params.push(filters.since); }
    if (filters.until) { where.push('m.created_at <= ?'); params.push(filters.until); }
    if (filters.q) {
      where.push("lower(m.body) LIKE lower(?) ESCAPE '\\'");
      params.push(Store.likePattern(filters.q));
    }
    if (filters.senderId) { where.push('m.from_id = ?'); params.push(filters.senderId); }
    if (filters.mentionId) {
      where.push('EXISTS (SELECT 1 FROM json_each(m.mentions_json) j WHERE j.value = ?)');
      params.push(filters.mentionId);
    }
    if (filters.allMentions) {
      // Member/plugin @all excludes the sender from mentions_json so explicit_mentions_json marks it; keep active-members check for user @all & legacy rows.
      where.push("(m.explicit_mentions_json IS NOT NULL OR (json_array_length(m.mentions_json) > 0 AND (SELECT COUNT(*) FROM json_each(m.mentions_json) j"
        + ' WHERE j.value IN (SELECT id FROM members WHERE cluster_id = m.cluster_id AND removed_at IS NULL))'
        + ' = (SELECT COUNT(*) FROM members WHERE cluster_id = m.cluster_id AND removed_at IS NULL)))');
    }
    if (filters.category) {
      const targetMember = filters.categoryMemberId ?? '';
      const receiptWarning = "(m.from_id = 'system' AND m.system_kind IN ('receipt', 'queue_warning'))";
      const userUnaddressed = "(m.from_id = 'user' AND m.mentions_json = '[]')";
      const broadcastExpr = "(m.explicit_mentions_json IS NOT NULL AND m.from_id != ? AND NOT EXISTS (SELECT 1 FROM json_each(m.explicit_mentions_json) j WHERE j.value = ?))";
      if (filters.category === 'receipt_warning') where.push(receiptWarning);
      else if (filters.category === 'warning') where.push(`(m.from_id = 'system' AND m.system_kind IN (${kindsOf('warning').map((kind) => `'${kind}'`).join(', ')}))`);
      else if (filters.category === 'task_notice') where.push("(m.from_id = 'system' AND (m.system_kind IS NULL OR m.system_kind NOT IN ('receipt', 'queue_warning')))");
      else if (filters.category === 'user') where.push(userUnaddressed);
      else if (filters.category === 'broadcast') {
        where.push(`m.from_id != 'system' AND NOT ${userUnaddressed} AND ${broadcastExpr}`);
        params.push(targetMember, targetMember);
      } else if (filters.category === 'mention') {
        where.push(`m.from_id != 'system' AND NOT ${userUnaddressed} AND m.from_id != ? AND EXISTS (SELECT 1 FROM json_each(m.mentions_json) j WHERE j.value = ?) AND NOT ${broadcastExpr}`);
        params.push(targetMember, targetMember, targetMember, targetMember);
      }
    }
  }

  /**
   * Messages with their deliveries and read receipts (the web's per-message state). One query per table for the whole
   * list, not one per message: reads and acknowledgements have no index on message_id, so a per-message lookup scans
   * its table once for every message. All in one transaction: outside one, every statement (the plugins' per-message
   * fields too) locks and re-checks the database file on its own.
   */
  withDeliveries(msgs: Message[]): MessageWithDeliveries[] {
    const ids = JSON.stringify(msgs.map((m) => m.id));
    const among = 'IN (SELECT value FROM json_each(?))';
    const rows = (sql: string) => Map.groupBy(this.prepared(sql).all(ids), (r) => r.message_id as string);
    return this.tx(() => {
      const deliveries = rows(`SELECT * FROM deliveries WHERE message_id ${among} ORDER BY rowid`);
      const reads = rows(`SELECT * FROM reads WHERE message_id ${among} ORDER BY at, member_id`);
      const acknowledgements = rows(`SELECT * FROM message_acknowledgements WHERE message_id ${among} ORDER BY at, member_id`);
      const files = rows(`SELECT mf.message_id, f.* FROM message_files mf JOIN files f ON f.id = mf.file_id
        WHERE mf.message_id ${among} ORDER BY mf.position`);
      return msgs.map((m) => ({
        ...m, deliveries: (deliveries.get(m.id) ?? []).map(toDelivery), reads: (reads.get(m.id) ?? []).map(toRead),
        acknowledgements: (acknowledgements.get(m.id) ?? []).map(toAcknowledgement),
        ...this.pluginFields(m.id), ...(files.has(m.id) ? { attachments: files.get(m.id)!.map(toFile) } : {}),
      }));
    });
  }

  // ---- files ----

  insertFile(f: FileInfo): void {
    if (!this.getCluster(f.clusterId)) throw new Error('unknown cluster');
    this.db.prepare('INSERT INTO files (id, cluster_id, uploader, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.id, f.clusterId, f.uploader, f.name, f.mime, f.size, f.sha256, f.createdAt);
  }

  getFile(id: string): FileInfo | null {
    const r = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    return r ? toFile(r) : null;
  }

  /** Deletes the file's row if no message carries it; returns whether it did. */
  deleteUnlinkedFile(id: string): boolean {
    return this.db.prepare('DELETE FROM files WHERE id = ? AND NOT EXISTS (SELECT 1 FROM message_files WHERE file_id = ?)').run(id, id).changes > 0;
  }

  /** The files a message carries, in the order they were attached. */
  attachmentsOf(messageId: string): FileInfo[] {
    return this.prepared(`SELECT f.* FROM message_files mf JOIN files f ON f.id = mf.file_id
      WHERE mf.message_id = ? ORDER BY mf.position`).all(messageId).map(toFile);
  }

  /** The member's queued deliveries, oldest first, each with its message. */
  queued(memberId: string): QueuedDelivery[] {
    return this.db.prepare(`SELECT ${QUEUED_COLUMNS} FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.member_id = ? AND d.state = 'queued' ORDER BY d.rowid`).all(memberId).map(toQueued);
  }

  /** One binding's scheduling metadata, stopping before the next binding's oldest delivery if supplied. */
  queuedCandidates(memberId: string, before?: string): QueuedCandidate[] {
    const barrier = before === undefined ? '' : 'AND d.rowid < (SELECT rowid FROM deliveries WHERE id = ?)';
    return this.prepared(`SELECT ${QUEUE_CANDIDATE_COLUMNS} FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.member_id = ? AND d.state = 'queued' ${barrier} ORDER BY d.rowid`)
      .all(...(before === undefined ? [memberId] : [memberId, before])).map(toQueuedCandidate);
  }

  /**
   * Still-queued deliveries of active members in unpaused clusters whose message is at or older than `cutoff` (ISO)
   * and that no long-queue warning has covered yet.
   */
  overdueQueued(cutoff: string): QueuedDelivery[] {
    return this.db.prepare(`SELECT ${QUEUED_COLUMNS} FROM members r JOIN deliveries d ON d.member_id = r.id
        JOIN messages m ON m.id = d.message_id JOIN clusters c ON c.id = r.cluster_id
        LEFT JOIN collaboration_policies p ON p.cluster_id = r.cluster_id
      WHERE r.removed_at IS NULL AND c.deleted_at IS NULL AND COALESCE(p.paused, 0) = 0
        AND d.state = 'queued' AND d.queue_warned = 0 AND m.created_at <= ? ORDER BY d.rowid`).all(cutoff).map(toQueued);
  }

  markQueueWarned(ids: string[]): void {
    const update = this.db.prepare('UPDATE deliveries SET queue_warned = 1 WHERE id = ?');
    this.tx(() => { for (const id of ids) update.run(id); });
  }

  /** The member's deliveries a long-queue warning has covered and that have not started yet. */
  countWarnedQueued(memberId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE member_id = ? AND state = 'queued' AND queue_warned = 1").get(memberId) as Row).n as number;
  }

  // ---- read state ----

  /**
   * Marks the messages read by the member (the first way of reading wins: via and at never change). Returns the ids it
   * had not read before, and, unless `via` is 'skip', the ids it had only skipped so far: their seen_at is set now.
   * Joins a surrounding transaction.
   */
  markRead(memberId: string, messageIds: string[], via: ReadVia): string[] {
    const seen = via === 'skip' ? null : new Date().toISOString();
    const ins = this.db.prepare('INSERT OR IGNORE INTO reads (member_id, message_id, via, at, seen_at) VALUES (?, ?, ?, ?, ?)');
    const reach = this.db.prepare('UPDATE reads SET seen_at = ? WHERE member_id = ? AND message_id = ? AND seen_at IS NULL');
    const at = new Date().toISOString();
    return this.tx(() => messageIds.filter((id) => ins.run(memberId, id, via, at, seen).changes > 0
      || (seen !== null && reach.run(seen, memberId, id).changes > 0)));
  }

  acknowledgementsOf(messageId: string): MessageAcknowledgement[] {
    return this.prepared('SELECT * FROM message_acknowledgements WHERE message_id = ? ORDER BY at, member_id').all(messageId).map(toAcknowledgement);
  }

  /** Inserts only new acknowledgements; joins the surrounding transaction. */
  acknowledge(memberId: string, messageIds: string[]): MessageAcknowledgement[] {
    const ins = this.db.prepare('INSERT OR IGNORE INTO message_acknowledgements (member_id, message_id, at) VALUES (?, ?, ?)');
    const at = new Date().toISOString();
    return messageIds.filter((id) => ins.run(memberId, id, at).changes > 0).map((messageId) => ({ memberId, messageId, at }));
  }

  // Relevant unread messages: not the member's own, after its unread_after_rowid, excluding sender-only receipts/warnings,
  // not read by it, and @-mentioning it (including via @all) or unaddressed by the user.
  // unreadFrom takes (memberId); unreadWhere takes (clusterId, memberId, memberId, memberId).
  private readonly unreadFrom = 'FROM messages m JOIN members mem ON mem.id = ?';
  private readonly unreadWhere = `m.cluster_id = ? AND m.from_id != ?
    AND m.rowid > mem.unread_after_rowid AND mem.hidden_at IS NULL
    AND (m.system_kind IS NULL OR m.system_kind NOT IN ('receipt', 'queue_warning'))
    AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.member_id = ? AND r.message_id = m.id)
    AND ((m.from_id = 'user' AND m.mentions_json = '[]') OR EXISTS (SELECT 1 FROM json_each(m.mentions_json) j WHERE j.value = ?))`;

  /** Up to `limit` relevant unread messages of the member, oldest first; filters only narrow that set. */
  listUnread(memberId: string, clusterId: string, limit: number, filters: MessageFilters = {}): Message[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    this.messageFilter(where, params, { ...filters, categoryMemberId: memberId });
    const extra = where.length ? ' AND ' + where.join(' AND ') : '';
    return this.db.prepare(`SELECT m.* ${this.unreadFrom} WHERE ${this.unreadWhere}${extra} ORDER BY m.rowid LIMIT ?`)
      .all(memberId, clusterId, memberId, memberId, memberId, ...params, limit).map(toMessage);
  }

  /** Ids of every relevant unread message up to a point (a message rowid or a createdAt time), optionally narrowed by category, oldest first. */
  unreadIds(memberId: string, clusterId: string, point: { beforeRowid?: number; until?: string; category?: UnreadCategory } = {}): string[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (point.beforeRowid !== undefined) { where.push('m.rowid <= ?'); params.push(point.beforeRowid); }
    if (point.until !== undefined) { where.push('m.created_at <= ?'); params.push(point.until); }
    if (point.category) this.messageFilter(where, params, { category: point.category, categoryMemberId: memberId });
    const extra = where.length ? ' AND ' + where.join(' AND ') : '';
    return this.db.prepare(`SELECT m.id ${this.unreadFrom} WHERE ${this.unreadWhere}${extra} ORDER BY m.rowid`)
      .all(memberId, clusterId, memberId, memberId, memberId, ...params).map((r) => String(r.id));
  }

  /** Categorized unread counts and per-category annotations (excluding receipts/warnings and pre-join messages). */
  unreadBreakdown(memberId: string, clusterId: string, opts: { excludeInFlight?: boolean } = {}): UnreadBreakdown {
    const rows = this.db.prepare(`SELECT m.*, d.state AS delivery_state, d.error AS delivery_error
      ${this.unreadFrom}
      LEFT JOIN deliveries d ON d.message_id = m.id AND d.member_id = ?
      WHERE ${this.unreadWhere}${opts.excludeInFlight ? " AND COALESCE(d.state, '') NOT IN ('queued', 'running')" : ''}`)
      .all(memberId, memberId, clusterId, memberId, memberId, memberId) as Row[];
    const out = emptyUnreadBreakdown();
    const bucketKey: Record<UnreadCategory, keyof Omit<UnreadBreakdown, 'total'>> = {
      mention: 'mention', user: 'user', broadcast: 'broadcast', task_notice: 'taskNotice',
    };
    for (const r of rows) {
      const msg = toMessage(r);
      const delivery = r.delivery_state ? { state: r.delivery_state as DeliveryState, error: (r.delivery_error ?? null) as string | null } : null;
      const { category, annotations } = classifyMessageForMember(msg, memberId, delivery);
      if (!category || category === 'receipt_warning') continue;
      out.total++;
      const bucket = out[bucketKey[category]];
      bucket.total++;
      for (const a of annotations) {
        if (a === 'fyi') bucket.fyi++;
        else if (a === 'offline') bucket.offline++;
        else if (a === 'failed_or_unknown') bucket.failedOrUnknown++;
        else if (a === 'blocked') bucket.blocked++;
      }
    }
    return out;
  }

  /** What the unread hint counts: categorized unread messages and annotations (including in-flight deliveries). */
  unreadHintCounts(memberId: string, clusterId: string): UnreadBreakdown {
    return this.unreadBreakdown(memberId, clusterId);
  }

  /** Relevant unread messages that are not on their way to the member (no queued or running delivery to it). */
  countUnread(memberId: string, clusterId: string): number {
    return this.unreadBreakdown(memberId, clusterId, { excludeInFlight: true }).total;
  }

  /** Computes category and delivery-failure/fyi annotations per message from `memberId`'s perspective. */
  annotateMessagesForMember(memberId: string, msgs: Message[]): Map<string, { category: MessageCategory | null; annotations: UnreadAnnotation[] }> {
    const ids = JSON.stringify(msgs.map((m) => m.id));
    const deliveries = new Map<string, { state: DeliveryState; error: string | null }>();
    if (msgs.length) {
      for (const r of this.prepared('SELECT message_id, state, error FROM deliveries WHERE member_id = ? AND message_id IN (SELECT value FROM json_each(?))').all(memberId, ids) as Row[]) {
        deliveries.set(r.message_id as string, { state: r.state as DeliveryState, error: (r.error ?? null) as string | null });
      }
    }
    return new Map(msgs.map((m) => [m.id, classifyMessageForMember(m, memberId, deliveries.get(m.id))]));
  }

  /**
   * Deliveries of the member's own messages that ended failed or offline and were not yet told to it (reported = 0),
   * oldest first, each with its message.
   */
  unreported(senderId: string): (Delivery & { message: Message })[] {
    return this.db.prepare(`SELECT d.*, m.cluster_id, m.from_id, m.mentions_json, m.body, m.reply_to, m.chain_id, m.hop, m.created_at
      FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE m.from_id = ? AND d.state IN ('failed', 'offline') AND d.reported = 0 ORDER BY d.rowid`).all(senderId)
      .map((r) => ({ ...toDelivery(r), message: toMessage({ ...r, id: r.message_id }) }));
  }

  /** Marks these deliveries' failures as told to their sender (joins a surrounding transaction). */
  markReported(ids: string[]): void {
    const upd = this.db.prepare('UPDATE deliveries SET reported = 1 WHERE id = ?');
    this.tx(() => { for (const id of ids) upd.run(id); });
  }

  setDeliveryState(id: string, state: DeliveryState, error: string | null = null, outcome: DeliveryResult | null = null): Delivery {
    this.db.prepare('UPDATE deliveries SET state = ?, error = ?, outcome = ?, updated_at = ? WHERE id = ?')
      .run(state, error, outcome, new Date().toISOString(), id);
    return toDelivery(this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row);
  }

  /**
   * Supersede only unstarted deliveries of system notices whose own collaboration event is `action` with these payload
   * values (`fields`: code-authored field names). Joins the caller's transaction.
   */
  supersedeEventNotices(clusterId: string, memberId: string, action: string, fields: Record<string, string>, reason: string): Delivery[] {
    const names = Object.keys(fields);
    const rows = this.db.prepare(`SELECT d.id FROM deliveries d JOIN messages m ON m.id = d.message_id
      JOIN events e ON e.seq = m.collab_event_id
      WHERE d.member_id = ? AND d.state = 'queued' AND d.attempts = 0 AND d.batch_id IS NULL
        AND m.cluster_id = ? AND m.from_id = 'system' AND m.kind = 'system'
        AND e.cluster_id = m.cluster_id AND e.kind = 'collaboration'
        AND json_extract(e.payload_json, '$.action') = ?
        AND COALESCE(json_extract(e.payload_json, '$.suggested'), 0) = 0
        ${names.map((name) => `AND json_extract(e.payload_json, '$.${name}') = ?`).join(' ')}`)
      .all(memberId, clusterId, action, ...names.map((name) => fields[name]));
    const update = this.db.prepare("UPDATE deliveries SET state = 'superseded', outcome = NULL, error = ?, updated_at = ? WHERE id = ? AND state = 'queued' AND attempts = 0 AND batch_id IS NULL RETURNING *");
    const now = new Date().toISOString();
    return rows.flatMap((row) => {
      const updated = update.get(reason, now, row.id as string) as Row | undefined;
      return updated ? [toDelivery(updated)] : [];
    });
  }

  /**
   * Marks a queued or running delivery 'offline' (terminal: nothing reached the member). One taken back from 'running'
   * gives back the attempt startDelivery counted, so it is no chain turn. (SET reads the row's old state.)
   */
  markOffline(id: string, error: string): Delivery {
    this.db.prepare("UPDATE deliveries SET attempts = attempts - (state = 'running'), state = 'offline', error = ?, updated_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
    return toDelivery(this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row);
  }

  /** Marks a delivery running as part of run `batchId` and counts the attempt (the chain turn limit counts attempts). */
  startDelivery(id: string, batchId: string): Delivery {
    this.db.prepare("UPDATE deliveries SET state = 'running', error = NULL, attempts = attempts + 1, batch_id = ?, updated_at = ? WHERE id = ?")
      .run(batchId, new Date().toISOString(), id);
    return toDelivery(this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row);
  }

  /** Interrupted work is not automatically retried: it may already have reached its target. */
  recoverRunning(): Delivery[] {
    const rows = this.db.prepare("SELECT d.*, m.removed_at FROM deliveries d JOIN members m ON m.id = d.member_id WHERE d.state = 'running' OR (m.removed_at IS NOT NULL AND d.state = 'queued')").all();
    return rows.map((r) => r.state === 'running'
      ? this.setDeliveryState(r.id as string, 'failed', 'Hub 重启时投递仍在进行，结果未知；原执行可能仍在继续', 'unknown')
      : this.setDeliveryState(r.id as string, 'failed', '成员已移出集群，投递已取消'));
  }

  /** Turns started on a chain, including ones interrupted by a restart. */
  countChainTurns(chainId: string): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(d.attempts), 0)
      + COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = ?), 0) AS n
      FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.chain_id = ?`).get(PURGED_CHAIN_TURNS + chainId, chainId) as Row;
    return r.n;
  }

  /** The limit-th newest committed send within this plugin's window. Its age determines when the limit can open. */
  pluginRateBoundary(clusterId: string, sender: string, since: string, limit: number): string | null {
    const row = this.db.prepare(`SELECT created_at FROM messages
      WHERE cluster_id = ? AND from_id = ? AND kind = 'plugin' AND created_at > ?
      ORDER BY created_at DESC LIMIT 1 OFFSET ?`).get(clusterId, sender, since, limit - 1) as Row | undefined;
    return row?.created_at ?? null;
  }

  // ---- settings ----

  private settingValue(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  private writeSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getExternalWriteSettings(id: string): ExternalWriteSettings | null {
    const value = this.settingValue(`external_plugin_write:${id}`);
    return value === undefined ? null : JSON.parse(value) as ExternalWriteSettings;
  }

  setExternalWriteSettings(id: string, settings: ExternalWriteSettings): void {
    this.writeSetting(`external_plugin_write:${id}`, JSON.stringify(settings));
  }

  /** The saved limit setting, or null if it was never saved. A saved value that is not a Limit is an error, not a default. */
  getLimit(setting: LimitSetting): Limit | null {
    const { key } = LIMIT_SETTINGS[setting];
    const value = this.settingValue(key);
    if (value === undefined) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { /* reported below */ }
    const limit = parseLimit(parsed);
    if (!limit) throw new Error(`saved setting ${key} is invalid: ${String(value).slice(0, 200)}`);
    return limit;
  }

  /** Saves a limit setting (joins a surrounding transaction). Refuses anything getLimit could not read back. */
  setLimit(setting: LimitSetting, limit: Limit): void {
    const { key } = LIMIT_SETTINGS[setting];
    const valid = parseLimit(limit);
    if (!valid) throw new Error(`${key} must be a Limit`);
    this.writeSetting(key, JSON.stringify(valid));
  }

  getUsageAlert(): { turnTokens: number; conversationTokens: number } {
    const raw = this.settingValue('usage_alert');
    if (raw === undefined) return { turnTokens: 20_000_000, conversationTokens: 200_000_000 };
    const value = JSON.parse(raw);
    if (!value || !Number.isSafeInteger(value.turnTokens) || value.turnTokens < 0
      || !Number.isSafeInteger(value.conversationTokens) || value.conversationTokens < 0) throw new Error('saved usage_alert is invalid');
    return { turnTokens: value.turnTokens, conversationTokens: value.conversationTokens };
  }

  setUsageAlert(value: { turnTokens: number; conversationTokens: number }): void {
    this.writeSetting('usage_alert', JSON.stringify(value));
  }

  /** A saved whole-number setting (src/core/notify-settings.ts), or null if it was never saved. A saved value that
   * is not a non-negative safe integer is an error, not a default. */
  getSavedNumber(key: string): number | null {
    const value = this.settingValue(key);
    if (value === undefined) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { /* reported below */ }
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`saved setting ${key} is invalid: ${String(value).slice(0, 200)}`);
    }
    return parsed + 0;
  }

  /** Saves a whole-number setting (joins a surrounding transaction). Refuses anything getSavedNumber could not read back. */
  saveNumber(key: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative safe integer`);
    this.writeSetting(key, JSON.stringify(value + 0));
  }

  /** The saved sidebar group list (src/core/cluster-groups.ts); [] when never saved. */
  getClusterGroups(): string[] {
    const value = this.settingValue(CLUSTER_GROUPS_KEY);
    return parseGroups(value === undefined ? null : String(value));
  }

  /** Saves the sidebar group list (joins a surrounding transaction). */
  setClusterGroups(list: readonly string[]): void {
    this.writeSetting(CLUSTER_GROUPS_KEY, JSON.stringify(list));
  }

  // ---- usage (docs/usage.md) ----

  /** Stores the tokens of one run's turn; the same batch again replaces its row. */
  recordTurnUsage(batchId: string, memberId: string, t: TokenTotals): void {
    this.db.prepare(`INSERT INTO turn_usage (batch_id, member_id, input, cached_input, cache_write, output, reasoning, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(batch_id) DO UPDATE SET member_id = excluded.member_id, input = excluded.input,
      cached_input = excluded.cached_input, cache_write = excluded.cache_write, output = excluded.output,
      reasoning = excluded.reasoning, recorded_at = excluded.recorded_at`)
      .run(batchId, memberId, t.input, t.cachedInput, t.cacheWrite, t.output, t.reasoning, new Date().toISOString());
  }

  /** Per member: the summed tokens of its recorded turns and how many turns there are. Members without any are absent. */
  turnUsage(memberIds: string[]): Map<string, { totals: TokenTotals; turns: number }> {
    const out = new Map<string, { totals: TokenTotals; turns: number }>();
    if (!memberIds.length) return out;
    const rows = this.db.prepare(`SELECT member_id, COUNT(*) AS turns, SUM(input) AS input, SUM(cached_input) AS cached_input,
      SUM(cache_write) AS cache_write, SUM(output) AS output, SUM(reasoning) AS reasoning FROM turn_usage
      WHERE member_id IN (${memberIds.map(() => '?').join(',')}) GROUP BY member_id`).all(...memberIds);
    for (const r of rows) {
      out.set(r.member_id as string, {
        turns: Number(r.turns),
        totals: { input: Number(r.input), cachedInput: Number(r.cached_input), cacheWrite: Number(r.cache_write), output: Number(r.output), reasoning: Number(r.reasoning) },
      });
    }
    return out;
  }

  /** Aggregate recorded turns once per batch, then attach every message actually delivered in each selected batch. */
  usageTurns(clusterId: string, memberId: string, limit: number) {
    const total = 'input + cached_input + cache_write + output';
    const summary = this.db.prepare(`SELECT COUNT(*) AS turns, COALESCE(SUM(${total}), 0) AS tokens,
      COALESCE(SUM(CASE WHEN output < 3000 THEN 1 ELSE 0 END), 0) AS short_turns,
      COALESCE(SUM(CASE WHEN output < 3000 THEN ${total} ELSE 0 END), 0) AS short_tokens
      FROM turn_usage WHERE member_id = ?`).get(memberId) as Row;
    const turns = this.db.prepare(`SELECT batch_id, recorded_at, ${total} AS tokens, output FROM turn_usage
      WHERE member_id = ? ORDER BY tokens DESC, recorded_at DESC, batch_id ASC LIMIT ?`).all(memberId, limit) as Row[];
    const messages = this.db.prepare(`SELECT m.id, m.from_id, m.kind, m.body FROM deliveries d
      JOIN messages m ON m.id = d.message_id WHERE d.batch_id = ? AND d.member_id = ? AND m.cluster_id = ?
      ORDER BY m.created_at ASC, m.rowid ASC`);
    const count = Number(summary.turns), tokens = Number(summary.tokens);
    const shortTurns = Number(summary.short_turns), shortTokens = Number(summary.short_tokens);
    return { clusterId, memberId, turns: count, tokens, average: count ? tokens / count : 0,
      short: { turns: shortTurns, tokens: shortTokens }, work: { turns: count - shortTurns, tokens: tokens - shortTokens },
      expensive: turns.map((turn) => ({ batchId: turn.batch_id, at: turn.recorded_at, tokens: Number(turn.tokens), output: Number(turn.output),
        messages: (messages.all(turn.batch_id, memberId, clusterId) as Row[]).map((m) => ({ messageId: m.id, from: m.from_id,
          kind: m.kind, excerpt: Array.from(m.body as string).slice(0, 40).join('') })) })) };
  }

  /** The latest recorded turn per member, including cached input but excluding cache writes and reasoning. */
  latestTurnTokens(memberIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!memberIds.length) return out;
    const rows = this.db.prepare(`SELECT member_id, input + cached_input + output AS tokens FROM turn_usage t
      WHERE member_id IN (${memberIds.map(() => '?').join(',')}) AND rowid =
        (SELECT rowid FROM turn_usage x WHERE x.member_id = t.member_id ORDER BY recorded_at DESC, rowid DESC LIMIT 1)`).all(...memberIds);
    for (const row of rows) out.set(row.member_id as string, Number(row.tokens));
    return out;
  }

  saveQuota(harness: string, snapshot: QuotaSnapshot): void {
    this.db.prepare('INSERT INTO quota_snapshots (harness, snapshot_json) VALUES (?, ?) ON CONFLICT(harness) DO UPDATE SET snapshot_json = excluded.snapshot_json')
      .run(harness, JSON.stringify(snapshot));
  }

  /** The last saved quota snapshot of every harness; an unreadable row is skipped. */
  loadQuotas(): Map<string, QuotaSnapshot> {
    const out = new Map<string, QuotaSnapshot>();
    for (const r of this.db.prepare('SELECT harness, snapshot_json FROM quota_snapshots').all()) {
      try { out.set(r.harness as string, JSON.parse(r.snapshot_json as string)); } catch { /* skipped */ }
    }
    return out;
  }

  // ---- events ----

  appendEvent(clusterId: string | null, memberId: string | null, kind: HubEvent['kind'], payload: unknown): HubEvent {
    const createdAt = new Date().toISOString();
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO events (cluster_id, member_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(clusterId, memberId, kind, JSON.stringify(payload), createdAt);
    return { seq: Number(lastInsertRowid), clusterId, memberId, kind, payload, createdAt };
  }

  /** The newest event's seq, 0 when there is none. */
  appendCollaborationEvent(clusterId: string, memberId: string | null, payload: Record<string, unknown>): HubEvent {
    const event = this.appendEvent(clusterId, memberId, 'collaboration', payload);
    event.payload = { ...payload, eventId: event.seq };
    this.db.prepare('UPDATE events SET payload_json = ? WHERE seq = ?').run(JSON.stringify(event.payload), event.seq);
    return event;
  }

  deleteCluster(id: string): { cluster: Cluster; cancelled: Delivery[] } {
    const cluster = this.getCluster(id);
    if (!cluster) throw new Error('unknown cluster');
    this.db.prepare('UPDATE clusters SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    const queued = this.db.prepare("SELECT d.id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.cluster_id = ? AND d.state = 'queued'").all(id);
    const cancelled = queued.map((r) => this.setDeliveryState(String(r.id), 'failed', '群聊已删除，尚未开始的投递已取消'));
    return { cluster: this.getCluster(id, { includeDeleted: true })!, cancelled };
  }

  restoreCluster(id: string): Cluster {
    const cluster = this.getCluster(id, { includeDeleted: true });
    if (!cluster?.deletedAt) throw new Error('unknown deleted cluster');
    this.db.prepare('UPDATE clusters SET deleted_at = NULL WHERE id = ?').run(id);
    return this.getCluster(id)!;
  }

  /**
   * Deletes a cluster for good (Hub.purgeCluster) in one transaction. `refuse` first sees the cluster as stored (null:
   * unknown) and all its member ids, and throws to change nothing. Plugin rows go first (clusterPurging, for every
   * installed plugin, enabled or not), then the core's rows, children before parents: foreign keys are on and nothing
   * cascades. Events of the cluster or its members go too; global events stay.
   * Messages have no INTEGER PRIMARY KEY, so SQLite reuses rowids once the newest rows are gone; a member of another
   * cluster whose join watermark (unread_after_rowid) lay past the new highest rowid would never see its next messages
   * as unread, so such watermarks are clamped to it. Last, one tombstone 'cluster' event without the name.
   * secure_delete overwrites the deleted content with zeros; the caller checkpoints the WAL. Returns what the caller
   * still has to do: the member ids to forget, the file ids and stored names to remove.
   */
  purgeCluster(id: string, refuse: (cluster: Cluster | null, memberIds: string[], trashVersion: number) => void):
    { memberIds: string[]; files: Pick<FileInfo, 'id' | 'name'>[]; messages: number; event: HubEvent } {
    const secure = Number((this.db.prepare('PRAGMA secure_delete').get() as Row).secure_delete);
    this.db.exec('PRAGMA secure_delete = ON');   // a connection setting: set outside the transaction, restored after it
    try {
      return this.tx(() => {
        const cluster = this.getCluster(id, { includeDeleted: true });
        const ids = (sql: string) => this.db.prepare(sql).all(id).map((r) => String(r.id));
        const memberIds = ids('SELECT id FROM members WHERE cluster_id = ? ORDER BY rowid');
        const version = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS version FROM events
          WHERE cluster_id = ? AND kind = 'cluster' AND json_extract(payload_json, '$.cluster.deletedAt') IS NOT NULL`).get(id) as Row;
        refuse(cluster, memberIds, Number(version.version));
        const files = this.db.prepare('SELECT id, name FROM files WHERE cluster_id = ? ORDER BY rowid').all(id)
          .map((r) => ({ id: String(r.id), name: String(r.name) }));
        const messages = Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE cluster_id = ?').get(id) as Row).n);
        for (const plugin of this.plugins.installed) plugin.clusterPurging?.(this, id);
        const MESSAGES = '(SELECT id FROM messages WHERE cluster_id = ?)';
        const MEMBERS = '(SELECT id FROM members WHERE cluster_id = ?)';
        const run = (sql: string) => this.db.prepare(sql).run(...sql.split('?').slice(1).map(() => id));
        this.db.prepare(`INSERT INTO settings (key, value)
          SELECT ? || spent.chain_id, spent.attempts FROM (
            SELECT m.chain_id, SUM(d.attempts) AS attempts FROM deliveries d JOIN messages m ON m.id = d.message_id
            WHERE d.attempts > 0 AND (m.cluster_id = ? OR d.member_id IN ${MEMBERS}) GROUP BY m.chain_id
          ) spent WHERE EXISTS (SELECT 1 FROM messages kept WHERE kept.cluster_id <> ? AND kept.chain_id = spent.chain_id)
          ON CONFLICT(key) DO UPDATE SET value = CAST(settings.value AS INTEGER) + CAST(excluded.value AS INTEGER)`)
          .run(PURGED_CHAIN_TURNS, id, id, id);
        this.db.prepare(`DELETE FROM settings WHERE key IN (
          SELECT ? || m.chain_id FROM messages m WHERE m.cluster_id = ?
          AND NOT EXISTS (SELECT 1 FROM messages kept WHERE kept.cluster_id <> ? AND kept.chain_id = m.chain_id))`)
          .run(PURGED_CHAIN_TURNS, id, id);
        run(`DELETE FROM message_files WHERE message_id IN ${MESSAGES} OR file_id IN (SELECT id FROM files WHERE cluster_id = ?)`);
        run('DELETE FROM files WHERE cluster_id = ?');
        for (const table of ['reads', 'message_acknowledgements', 'deliveries']) {
          run(`DELETE FROM ${table} WHERE member_id IN ${MEMBERS} OR message_id IN ${MESSAGES}`);
        }
        run(`DELETE FROM collaboration_member_roles WHERE member_id IN ${MEMBERS} OR role_id IN (SELECT id FROM collaboration_roles WHERE cluster_id = ?)`);
        for (const table of ['collaboration_roles', 'collaboration_policies', 'collaboration_operations']) run(`DELETE FROM ${table} WHERE cluster_id = ?`);
        for (const table of ['turn_usage', 'activity_snapshots']) run(`DELETE FROM ${table} WHERE member_id IN ${MEMBERS}`);
        run(`DELETE FROM events WHERE cluster_id = ? OR member_id IN ${MEMBERS}`);
        run('DELETE FROM messages WHERE cluster_id = ?');
        run('DELETE FROM members WHERE cluster_id = ?');
        run('DELETE FROM clusters WHERE id = ?');
        this.db.exec(`UPDATE members SET unread_after_rowid = (SELECT COALESCE(MAX(rowid), 0) FROM messages)
          WHERE unread_after_rowid > (SELECT COALESCE(MAX(rowid), 0) FROM messages)`);
        const event = this.appendEvent(id, null, 'cluster', {
          cluster: { id, deletedAt: cluster!.deletedAt, purgedAt: new Date().toISOString() }, members: [] });
        return { memberIds, files, messages, event };
      });
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${secure === 2 ? 'FAST' : secure}`);
    }
  }

  lastEventSeq(): number {
    return (this.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null }).seq ?? 0;
  }

  listEvents(since: number, memberId?: string, kinds?: HubEvent['kind'][]): HubEvent[] {
    let sql = 'SELECT * FROM events WHERE seq > ?';
    const args: (string | number)[] = [since];
    if (memberId !== undefined) { sql += ' AND member_id = ?'; args.push(memberId); }
    if (kinds) { sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`; args.push(...kinds); }
    return this.db.prepare(sql + ' ORDER BY seq').all(...args).map(toEvent);
  }

  /** Up to `limit` events after `since`, oldest first, each as its JSON text (eventJson): one page of the page's replay. */
  eventJsonPage(since: number, limit: number): { seq: number; json: string }[] {
    return this.prepared('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit)
      .map((r) => ({ seq: r.seq as number, json: eventJson(r) }));
  }
}
