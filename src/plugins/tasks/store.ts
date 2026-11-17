// The task tables and all SQL over them. Their names predate the plugin system; the rows are unchanged.
import { type Store, toEvent } from '../../core/store.ts';
import type { Task, TaskRef, TaskStatus } from '../../core/collaboration-types.ts';
import type { HubEvent } from '../../core/types.ts';
import { LABEL_MIGRATION } from './labels.ts';

type Row = Record<string, any>;

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS collaboration_tasks (id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id), data_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS collaboration_tasks_cluster ON collaboration_tasks(cluster_id);
   CREATE TABLE IF NOT EXISTS collaboration_links (message_id TEXT NOT NULL REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES collaboration_tasks(id), linked_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(message_id, task_id));
   CREATE TABLE IF NOT EXISTS collaboration_records (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES collaboration_tasks(id), kind TEXT NOT NULL, data_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS collaboration_records_task ON collaboration_records(task_id, kind);
   CREATE TABLE IF NOT EXISTS merge_windows (cluster_id TEXT PRIMARY KEY REFERENCES clusters(id), data_json TEXT NOT NULL);`,
  // Per-cluster task numbers (#12, docs/collaboration.md): the counter keeps a number from being given twice, also after
  // a delete; the unique expression index finds a task by its number and refuses a duplicate. Existing tasks without
  // a number are numbered after the cluster's highest number or counter, by creation time then insertion order, so
  // running this again renumbers nothing.
  `CREATE TABLE IF NOT EXISTS task_counters (cluster_id TEXT PRIMARY KEY REFERENCES clusters(id), last_number INTEGER NOT NULL);
   UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.number', numbered.number)
     FROM (SELECT t.id, ROW_NUMBER() OVER (PARTITION BY t.cluster_id ORDER BY json_extract(t.data_json, '$.createdAt'), t.rowid)
         + MAX(COALESCE((SELECT MAX(json_extract(o.data_json, '$.number')) FROM collaboration_tasks o WHERE o.cluster_id = t.cluster_id), 0),
               COALESCE((SELECT c.last_number FROM task_counters c WHERE c.cluster_id = t.cluster_id), 0)) AS number
       FROM collaboration_tasks t WHERE json_extract(t.data_json, '$.number') IS NULL) AS numbered
     WHERE collaboration_tasks.id = numbered.id;
   INSERT INTO task_counters (cluster_id, last_number)
     SELECT cluster_id, MAX(json_extract(data_json, '$.number')) FROM collaboration_tasks WHERE true GROUP BY cluster_id
     ON CONFLICT(cluster_id) DO UPDATE SET last_number = MAX(last_number, excluded.last_number);
   CREATE UNIQUE INDEX IF NOT EXISTS collaboration_tasks_number ON collaboration_tasks(cluster_id, json_extract(data_json, '$.number'));`,
  // The label library (./labels.ts): empty after the upgrade, no cluster has chosen a group, task labels untouched.
  LABEL_MIGRATION,
  // Task watches (./watches.ts): one row per watching member and task, empty after the upgrade.
  `CREATE TABLE IF NOT EXISTS task_watches (task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
     member_id TEXT NOT NULL REFERENCES members(id), note TEXT, created_at TEXT NOT NULL, PRIMARY KEY (task_id, member_id));
   CREATE INDEX IF NOT EXISTS task_watches_member ON task_watches(member_id);`,
  // Per-cluster task settings (./takeover.ts): one row per cluster the user changed; no row reads as every setting off.
  `CREATE TABLE IF NOT EXISTS task_cluster_settings (cluster_id TEXT PRIMARY KEY REFERENCES clusters(id),
     takeover_self_review INTEGER NOT NULL DEFAULT 0);`,
];

/** Takes this cluster's next task number. Call it in the transaction that saves the task, so a failure gives it back. */
export function nextTaskNumber(store: Store, clusterId: string): number {
  const row = store.db.prepare('INSERT INTO task_counters (cluster_id, last_number) VALUES (?, 1)'
    + ' ON CONFLICT(cluster_id) DO UPDATE SET last_number = last_number + 1 RETURNING last_number').get(clusterId) as Row;
  return Number(row.last_number);
}

/** The id of this cluster's task with that number, or null. The expression matches collaboration_tasks_number. */
export function collaborationTaskIdByNumber(store: Store, clusterId: string, number: number): string | null {
  const row = store.db.prepare("SELECT id FROM collaboration_tasks WHERE cluster_id = ? AND json_extract(data_json, '$.number') = ?")
    .get(clusterId, number) as Row | undefined;
  return row ? String(row.id) : null;
}

/**
 * What a stored row means now (docs/collaboration.md). Old rows are read this way and never rewritten: 'accepted' is a
 * pending task whose executor is its unstarted assignment's member, and a pending task's nominee is its executor.
 */
const readTask = (json: string): Task => {
  const { nominatedMemberId, ...task } = { requiresApproval: false, mergeRequired: false, mergedCommitSha: null, mergedSubmissionId: null, fileIds: [], ...JSON.parse(json) };
  if (task.status === 'accepted') task.status = 'pending';
  if (task.status === 'pending') task.assignedMemberId ??= nominatedMemberId ?? null;
  return task as Task;
};

export function collaborationTask(store: Store, clusterId: string, taskId: string): Task | null {
  const row = store.db.prepare('SELECT data_json FROM collaboration_tasks WHERE cluster_id = ? AND id = ?').get(clusterId, taskId) as Row | undefined;
  return row ? readTask(row.data_json) : null;
}

export function collaborationTasks(store: Store, clusterId: string, limit: number, cursor?: string,
  filters: { q?: string; memberId?: string; holder?: string; label?: string | string[]; status?: string; open?: boolean; sort?: 'created-desc' } = {}): { tasks: Task[]; nextCursor: string | null } {
  const where = ['cluster_id = ?'];
  const params: (string | number)[] = [clusterId];
  const q = (filters.q ?? '').trim();
  // #12 or bare positive digits match task.number exactly; 4+ hex chars also prefix-match task.id. Number hits sort first.
  const numMatch = /^#?([1-9]\d*)$/.exec(q);
  const numVal = numMatch ? Number(numMatch[1]) : NaN;
  const numberCond = Number.isSafeInteger(numVal) ? `json_extract(data_json, '$.number') = ${numVal}` : null;
  const hex = q.toLowerCase().replace(/-/g, '');
  const idQuery = /^[0-9a-f]{4,32}$/.test(hex);
  const idPattern = idQuery ? `'${hex}%'` : null;
  const idCond = idPattern ? `REPLACE(lower(id), '-', '') LIKE ${idPattern}` : null;
  const idRank = numberCond || idCond
    ? `CASE ${numberCond ? `WHEN ${numberCond} THEN 0 ` : ''}${idCond ? `WHEN ${idCond} THEN 1 ` : ''}ELSE 2 END`
    : null;
  if (q) {
    const text = "instr(lower(json_extract(data_json, '$.title') || ' ' || json_extract(data_json, '$.scope') || ' ' || json_extract(data_json, '$.acceptance')), lower(?)) > 0";
    where.push(numberCond || idCond ? `(${[text, numberCond, idCond].filter(Boolean).join(' OR ')})` : text);
    params.push(q);
  }
  const newest = filters.sort === 'created-desc';
  const created = "COALESCE(julianday(json_extract(data_json, '$.createdAt')), -1)";
  if (newest) {
    // Keep the full sort key in the cursor so a delete of the last row cannot break paging.
    let key: unknown;
    try { key = JSON.parse(cursor ?? 'null'); } catch { /* an invalid cursor starts the list again */ }
    if (Array.isArray(key) && key.length === 3 && Number.isInteger(key[0]) && key[0] >= 0 && key[0] <= 2
      && Number.isFinite(key[1]) && Number.isSafeInteger(key[2]) && key[2] > 0) {
      const [rank, at, row] = key;
      const older = `(${created} < ? OR (${created} = ? AND rowid < ?))`;
      if (idRank) { where.push(`(${idRank} > ? OR (${idRank} = ? AND ${older}))`); params.push(rank, rank); }
      else where.push(older);
      params.push(at, at, row);
    }
  } else {
    // Existing oldest-first cursors: rowid, or rank:rowid if exact number/id hits sort first.
    const ranked = /^(\d+):(\d+)$/.exec(cursor ?? '');
    const cursorRank = Number(ranked?.[1] ?? '');
    const cursorRow = Number(ranked?.[2] ?? cursor);
    const afterRank = Number.isSafeInteger(cursorRank) && cursorRank >= 0 ? cursorRank : 0;
    const after = Number.isSafeInteger(cursorRow) && cursorRow >= 0 ? cursorRow : 0;
    if (idRank) where.push(`(${idRank} > ${afterRank} OR (${idRank} = ${afterRank} AND rowid > ${after}))`);
    else { where.push('rowid > ?'); params.push(after); }
  }
  if (filters.memberId) {   // an old pending row names its executor as the nominee (readTask)
    where.push("(json_extract(data_json, '$.assignedMemberId') = ? OR (json_extract(data_json, '$.status') = 'pending' AND json_extract(data_json, '$.nominatedMemberId') = ?))");
    params.push(filters.memberId, filters.memberId);
  }
  if (filters.holder) {   // what the member holds now: the hide confirmation and the brief on showing (docs/cluster-members.md「隐身」)
    where.push(`((json_extract(data_json, '$.status') IN ('pending', 'accepted', 'working', 'review')
        AND (json_extract(data_json, '$.assignedMemberId') = ? OR (json_extract(data_json, '$.status') = 'pending' AND json_extract(data_json, '$.nominatedMemberId') = ?)))
      OR (json_extract(data_json, '$.status') = 'review' AND json_extract(data_json, '$.reviewer.kind') = 'member' AND json_extract(data_json, '$.reviewer.memberId') = ?))`);
    params.push(filters.holder, filters.holder, filters.holder);
  }
  const labels = typeof filters.label === 'string' ? [filters.label] : Array.isArray(filters.label) ? filters.label : [];
  for (const label of labels) {
    if (!label) continue;
    where.push("EXISTS (SELECT 1 FROM json_each(data_json, '$.labels') WHERE value = ?)");
    params.push(label);
  }
  if (filters.status === 'pending') where.push("json_extract(data_json, '$.status') IN ('pending', 'accepted')");
  else if (filters.status) { where.push("json_extract(data_json, '$.status') = ?"); params.push(filters.status); }
  else if (filters.open) where.push("json_extract(data_json, '$.status') NOT IN ('completed', 'merged', 'cancelled')");
  const rows = store.db.prepare(`SELECT rowid AS cursor, ${idRank ? `${idRank} AS id_rank, ` : ''}${newest ? `${created} AS created, ` : ''}data_json`
    + ' FROM collaboration_tasks WHERE ' + where.join(' AND ')
    + ` ORDER BY ${idRank ? 'id_rank, ' : ''}${newest ? 'created DESC, rowid DESC' : 'rowid'} LIMIT ?`)
    .all(...params, limit + 1) as Row[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last
    ? (newest ? JSON.stringify([last.id_rank ?? 0, last.created, last.cursor]) : idRank ? `${last.id_rank}:${last.cursor}` : String(last.cursor))
    : null;
  return { tasks: page.map((r) => readTask(r.data_json)), nextCursor };
}

/**
 * The # picker / related-task picker, by title, #number or id prefix: an exact #number first, then unfinished tasks
 * before completed, merged and cancelled ones, each of the two most recently updated first.
 */
export function collaborationTaskCandidates(store: Store, clusterId: string, q: string, limit: number, includeClosed = false): TaskRef[] {
  const where = ['cluster_id = ?', ...(includeClosed ? [] : ["json_extract(data_json, '$.status') NOT IN ('merged', 'cancelled')"])];
  const params: (string | number)[] = [clusterId];
  const text = q.trim().toLowerCase();
  let exactNumber: number | null = null;
  if (text) {
    const numMatch = /^#?([1-9]\d*)$/.exec(text);
    const parsed = numMatch ? Number(numMatch[1]) : NaN;
    if (Number.isSafeInteger(parsed)) exactNumber = parsed;
    const hex = text.replace(/-/g, '');
    const byId = /^[0-9a-f]+$/.test(hex);
    where.push(`(instr(lower(json_extract(data_json, '$.title')), ?) > 0${exactNumber !== null ? " OR json_extract(data_json, '$.number') = ?" : ''}${byId ? " OR instr(REPLACE(lower(id), '-', ''), ?) = 1" : ''})`);
    params.push(text, ...(exactNumber !== null ? [exactNumber] : []), ...(byId ? [hex] : []));
  }
  const order = [
    ...(exactNumber !== null ? [`CASE WHEN json_extract(data_json, '$.number') = ${exactNumber} THEN 0 ELSE 1 END`] : []),
    "CASE WHEN json_extract(data_json, '$.status') IN ('completed', 'merged', 'cancelled') THEN 1 ELSE 0 END",
    "json_extract(data_json, '$.updatedAt') DESC", 'rowid DESC',
  ].join(', ');
  const rows = store.db.prepare(`SELECT id, json_extract(data_json, '$.number') AS number, json_extract(data_json, '$.title') AS title, json_extract(data_json, '$.status') AS status FROM collaboration_tasks WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
    .all(...params, limit) as Row[];
  return rows.map((row) => ({ id: String(row.id), number: Number(row.number), title: String(row.title), status: String(row.status) as TaskStatus }));
}

/** The tasks of this cluster among `ids` or `numbers` (any status); unknown or foreign items are absent. */
export function collaborationTaskRefs(store: Store, clusterId: string, ids: string[], numbers: number[] = []): TaskRef[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [clusterId];
  if (ids.length) {
    clauses.push(`id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (numbers.length) {
    clauses.push(`json_extract(data_json, '$.number') IN (${numbers.map(() => '?').join(', ')})`);
    params.push(...numbers);
  }
  if (!clauses.length) return [];
  const rows = store.db.prepare(`SELECT id, json_extract(data_json, '$.number') AS number, json_extract(data_json, '$.title') AS title, json_extract(data_json, '$.status') AS status FROM collaboration_tasks WHERE cluster_id = ? AND (${clauses.join(' OR ')})`)
    .all(...params) as Row[];
  return rows.map((row) => ({ id: String(row.id), number: Number(row.number), title: String(row.title), status: String(row.status) as TaskStatus }));
}

/** Every label used by this cluster's tasks, sorted; used for filter autocompletion. */
export function collaborationLabels(store: Store, clusterId: string): string[] {
  return store.db.prepare("SELECT DISTINCT value AS label FROM collaboration_tasks, json_each(data_json, '$.labels')"
    + ' WHERE cluster_id = ? ORDER BY label').all(clusterId).map((row) => String(row.label));
}

export type ReminderTask = Pick<Task, 'id' | 'clusterId' | 'number' | 'title' | 'status' | 'proposalState' | 'assignedMemberId'
  | 'reviewer' | 'dependencyIds' | 'executeRoleIds' | 'reviewRoleIds' | 'updatedAt'>;

/** The facts used by idle/stalled checks. Legacy accepted tasks and nominees are read as in readTask. */
export function collaborationReminderTasks(store: Store, clusterId: string): ReminderTask[] {
  return store.db.prepare(`SELECT json_object(
      'id', id, 'clusterId', cluster_id, 'number', json_extract(data_json, '$.number'), 'title', json_extract(data_json, '$.title'),
      'status', CASE json_extract(data_json, '$.status') WHEN 'accepted' THEN 'pending' ELSE json_extract(data_json, '$.status') END,
      'assignedMemberId', COALESCE(json_extract(data_json, '$.assignedMemberId'),
        CASE WHEN json_extract(data_json, '$.status') IN ('pending', 'accepted') THEN json_extract(data_json, '$.nominatedMemberId') END),
      'proposalState', 'active', 'reviewer', json_extract(data_json, '$.reviewer'), 'updatedAt', json_extract(data_json, '$.updatedAt'),
      'dependencyIds', json_extract(data_json, '$.dependencyIds'), 'executeRoleIds', json_extract(data_json, '$.executeRoleIds'),
      'reviewRoleIds', json_extract(data_json, '$.reviewRoleIds')) AS task
    FROM collaboration_tasks WHERE cluster_id = ? AND json_extract(data_json, '$.proposalState') = 'active'
      AND json_extract(data_json, '$.status') IN ('pending', 'accepted', 'working', 'review')
    ORDER BY rowid`).all(clusterId).map((row) => JSON.parse(String(row.task)) as ReminderTask);
}

/** One row per active task of the cluster with only the fields list_agents' load needs; no page limit. */
export function collaborationActiveTaskLoads(store: Store, clusterId: string): { status: string; assignedMemberId: string | null;
  reviewerMemberId: string | null }[] {
  return store.db.prepare(`SELECT json_extract(data_json, '$.status') AS status,
      json_extract(data_json, '$.assignedMemberId') AS assigned,
      json_extract(data_json, '$.nominatedMemberId') AS nominated,
      json_extract(data_json, '$.reviewer.memberId') AS reviewer
    FROM collaboration_tasks WHERE cluster_id = ? AND json_extract(data_json, '$.proposalState') = 'active'`).all(clusterId)
    .map((row) => {
      const status = row.status === 'accepted' ? 'pending' : String(row.status);   // as readTask does for old rows
      const executor = row.assigned ?? (status === 'pending' ? row.nominated : null);
      return { status, assignedMemberId: executor == null ? null : String(executor),
      reviewerMemberId: row.reviewer == null ? null : String(row.reviewer) };
    });
}

export function saveCollaborationTask(store: Store, task: Task): void {
  store.db.prepare('INSERT INTO collaboration_tasks (id, cluster_id, data_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json')
    .run(task.id, task.clusterId, JSON.stringify(task));
}

/**
 * Remove a task and everything stored under it: its records (assignments, submissions, reviews, approvals, merges,
 * attentions, summaries) and its message links. The messages themselves stay (docs/collaboration.md); callers run
 * this in their transaction so a failure leaves the task whole.
 */
export function deleteCollaborationTask(store: Store, taskId: string): void {
  store.db.prepare('DELETE FROM task_watches WHERE task_id = ?').run(taskId);
  store.db.prepare('DELETE FROM collaboration_records WHERE task_id = ?').run(taskId);
  store.db.prepare('DELETE FROM collaboration_links WHERE task_id = ?').run(taskId);
  store.db.prepare('DELETE FROM collaboration_tasks WHERE id = ?').run(taskId);
}

/**
 * The clusterPurging hook (docs/plugins.md): every task row of the cluster, its records, links (also links from its
 * messages) and watches, its merge window, task counter, chosen label groups and task settings. The global label library stays.
 */
export function purgeClusterTasks(store: Store, clusterId: string): void {
  const tasks = 'SELECT id FROM collaboration_tasks WHERE cluster_id = ?';
  // Members watch only their own cluster's tasks, so this also clears every watch of the cluster's members.
  store.db.prepare(`DELETE FROM task_watches WHERE task_id IN (${tasks})`).run(clusterId);
  store.db.prepare(`DELETE FROM collaboration_links WHERE task_id IN (${tasks}) OR message_id IN (SELECT id FROM messages WHERE cluster_id = ?)`)
    .run(clusterId, clusterId);
  store.db.prepare(`DELETE FROM collaboration_records WHERE task_id IN (${tasks})`).run(clusterId);
  for (const table of ['collaboration_tasks', 'merge_windows', 'task_counters', 'cluster_label_groups', 'task_cluster_settings']) {
    store.db.prepare(`DELETE FROM ${table} WHERE cluster_id = ?`).run(clusterId);
  }
}

export function saveCollaborationRecord(store: Store, taskId: string, kind: string, record: { id: string }): void {
  store.db.prepare('INSERT INTO collaboration_records VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json')
    .run(record.id, taskId, kind, JSON.stringify(record));
}

function readRecord<T>(json: string, kind: string): T {
  const record = JSON.parse(json);
  return (kind === 'submission' ? { commitSha: null, ...record } : record) as T;
}

export function collaborationRecord<T>(store: Store, taskId: string, kind: string, id: string | null | undefined): T | undefined {
  if (id == null) return undefined;
  const row = store.db.prepare('SELECT data_json FROM collaboration_records WHERE id = ? AND task_id = ? AND kind = ?')
    .get(id, taskId, kind);
  return row ? readRecord<T>(String(row.data_json), kind) : undefined;
}

export function collaborationRecords<T>(store: Store, taskId: string, kind: string): T[] {
  return store.db.prepare('SELECT data_json FROM collaboration_records WHERE task_id = ? AND kind = ? ORDER BY rowid').all(taskId, kind)
    .map((r) => readRecord<T>(String(r.data_json), kind));
}

export function collaborationLinks(store: Store, messageId: string): string[] {
  return store.prepared('SELECT task_id FROM collaboration_links WHERE message_id = ? ORDER BY rowid').all(messageId).map((r) => String(r.task_id));
}

export function linkCollaborationMessage(store: Store, messageId: string, taskId: string, actorId: string): void {
  store.db.prepare('INSERT OR IGNORE INTO collaboration_links VALUES (?, ?, ?, ?)').run(messageId, taskId, actorId, new Date().toISOString());
}

export function unlinkCollaborationMessage(store: Store, messageId: string, taskId: string): void {
  store.db.prepare('DELETE FROM collaboration_links WHERE message_id = ? AND task_id = ?').run(messageId, taskId);
}

/** How many messages are linked to a task; the user's delete confirmation names that number. */
export function collaborationLinkCount(store: Store, taskId: string): number {
  const row = store.db.prepare('SELECT COUNT(*) AS count FROM collaboration_links WHERE task_id = ?').get(taskId) as Row;
  return Number(row.count);
}

/** The messages linked to a task; a task delete names them in its event so the page can refresh those rows. */
export function collaborationLinkedMessageIds(store: Store, taskId: string): string[] {
  return store.db.prepare('SELECT message_id FROM collaboration_links WHERE task_id = ? ORDER BY rowid').all(taskId)
    .map((row) => String(row.message_id));
}

/**
 * The ids of the tasks this member worked on, is nominated for or reviews (docs/cluster-members.md「交接包」):
 * the current task fields plus every assignment record, because completing, cancelling or releasing a task clears
 * assignedMemberId and the history lives only in the records.
 */
export function collaborationMemberTaskIds(store: Store, clusterId: string, memberId: string): string[] {
  return store.db.prepare(`SELECT t.id FROM collaboration_tasks t WHERE t.cluster_id = ?
      AND (json_extract(t.data_json, '$.assignedMemberId') = ?
        OR json_extract(t.data_json, '$.nominatedMemberId') = ?
        OR (json_extract(t.data_json, '$.status') = 'review' AND json_extract(t.data_json, '$.reviewer.kind') = 'member'
          AND json_extract(t.data_json, '$.reviewer.memberId') = ?)
        OR EXISTS (SELECT 1 FROM collaboration_records r WHERE r.task_id = t.id AND r.kind = 'assignment'
          AND json_extract(r.data_json, '$.memberId') = ?))`)
    .all(clusterId, memberId, memberId, memberId, memberId).map((row) => String(row.id));
}

/** A condition on a message row (alias m): linked to this task. */
export const linkedClause = (taskId: string) => ({ sql: 'EXISTS (SELECT 1 FROM collaboration_links l WHERE l.message_id = m.id AND l.task_id = ?)', args: [taskId] });

const TASK_EVENT = "(json_extract(payload_json, '$.taskId') = ? OR EXISTS (SELECT 1 FROM json_each(payload_json, '$.taskIds') WHERE value = ?)"
  + " OR EXISTS (SELECT 1 FROM json_each(payload_json, '$.removeTaskIds') WHERE value = ?))";

export function collaborationEvents(store: Store, clusterId: string, taskId: string, after: number, limit: number): HubEvent[] {
  return store.db.prepare(`SELECT * FROM events WHERE cluster_id = ? AND kind = 'collaboration' AND seq > ? AND ${TASK_EVENT} ORDER BY seq LIMIT ?`)
    .all(clusterId, after, taskId, taskId, taskId, limit).map(toEvent);
}

/** The same events newest first, older than `before` (all when null). */
export function collaborationEventsBefore(store: Store, clusterId: string, taskId: string, before: number | null, limit: number): HubEvent[] {
  return store.db.prepare(`SELECT * FROM events WHERE cluster_id = ? AND kind = 'collaboration' AND seq < ? AND ${TASK_EVENT} ORDER BY seq DESC LIMIT ?`)
    .all(clusterId, before ?? Number.MAX_SAFE_INTEGER, taskId, taskId, taskId, limit).map(toEvent);
}
