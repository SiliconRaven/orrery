// The global label library (docs/collaboration.md「标签库」): groups and labels shared by every cluster, each cluster's
// chosen groups, the preset pack, what task.create / task.edit do with labels, and the label.* actions.
// Tasks still store plain label names; the library only decides spelling, recommendations and required groups.
import { randomUUID } from 'node:crypto';
import { CollaborationError } from '../../core/collaboration.ts';
import type { CollaborationResult } from '../../core/collaboration-types.ts';
import type { PluginActionContext } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import type { Hub } from '../../core/hub.ts';
import type { HubEvent } from '../../core/types.ts';

type Row = Record<string, any>;

/** Tasks plugin migration step 3: the library starts empty and no cluster has chosen a group. */
export const LABEL_MIGRATION = `CREATE TABLE IF NOT EXISTS task_label_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
     description TEXT NOT NULL DEFAULT '', required INTEGER NOT NULL DEFAULT 0, new_cluster_default INTEGER NOT NULL DEFAULT 0,
     created_by TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS task_labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
     group_id TEXT REFERENCES task_label_groups(id), color INTEGER, description TEXT NOT NULL DEFAULT '',
     archived INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS cluster_label_groups (cluster_id TEXT NOT NULL REFERENCES clusters(id),
     group_id TEXT NOT NULL REFERENCES task_label_groups(id), PRIMARY KEY (cluster_id, group_id));`;

export const NAME_MAX = 20;
export const DESCRIPTION_MAX = 200;
/** Colours are the page's tag tones; null lets the page pick one from the name. */
export const COLOR_COUNT = 8;

/** The preset packs: written to the library only when someone adds one. Generic names only. */
export const PRESET_PACKS = [
  { id: 'task-types', name: '任务类型', description: '这项工作属于哪一类', required: false, newClusterDefault: true,
    labels: ['功能', '修复', '改进', '设计', '文档', '测试', '调研'] },
] as const;

export interface LabelInfo {
  id: string; name: string; groupId: string | null; color: number | null; description: string; archived: boolean;
  createdBy: string; createdAt: string;
}
export interface LabelGroupInfo {
  id: string; name: string; description: string; required: boolean; newClusterDefault: boolean; createdBy: string; createdAt: string;
}

const fail = (code: string, message: string): never => { throw new CollaborationError(code, message); };
/** Names compare without case: hub and Hub are one label. */
export const nameKey = (name: string): string => name.toLowerCase();

const toLabel = (row: Row): LabelInfo => ({ id: String(row.id), name: String(row.name), groupId: row.group_id == null ? null : String(row.group_id),
  color: row.color == null ? null : Number(row.color), description: String(row.description), archived: Number(row.archived) === 1,
  createdBy: String(row.created_by), createdAt: String(row.created_at) });
const toGroup = (row: Row): LabelGroupInfo => ({ id: String(row.id), name: String(row.name), description: String(row.description),
  required: Number(row.required) === 1, newClusterDefault: Number(row.new_cluster_default) === 1,
  createdBy: String(row.created_by), createdAt: String(row.created_at) });

export const allLabels = (store: Store): LabelInfo[] =>
  store.db.prepare('SELECT * FROM task_labels ORDER BY rowid').all().map(toLabel);
export const allGroups = (store: Store): LabelGroupInfo[] =>
  store.db.prepare('SELECT * FROM task_label_groups ORDER BY rowid').all().map(toGroup);
const labelByKey = (store: Store, key: string): LabelInfo | null => {
  const row = store.db.prepare('SELECT * FROM task_labels WHERE name_key = ?').get(key) as Row | undefined;
  return row ? toLabel(row) : null;
};
const groupByKey = (store: Store, key: string): LabelGroupInfo | null => {
  const row = store.db.prepare('SELECT * FROM task_label_groups WHERE name_key = ?').get(key) as Row | undefined;
  return row ? toGroup(row) : null;
};
export const clusterGroupIds = (store: Store, clusterId: string): string[] =>
  store.db.prepare('SELECT group_id FROM cluster_label_groups WHERE cluster_id = ? ORDER BY rowid').all(clusterId).map((row) => String(row.group_id));

/** A new cluster starts with every group marked for new clusters (runs in the cluster's insert transaction). */
export function selectDefaultGroups(store: Store, clusterId: string): void {
  store.db.prepare('INSERT OR IGNORE INTO cluster_label_groups (cluster_id, group_id) SELECT ?, id FROM task_label_groups WHERE new_cluster_default = 1 ORDER BY rowid')
    .run(clusterId);
}

/**
 * How many tasks carry each label (by name, without case) and in how many clusters, over every cluster and status. A
 * task counts once per name, also when an old task carries two spellings of it (Hub and hub).
 */
export function labelUsage(store: Store): Map<string, { tasks: number; clusters: number }> {
  const rows = store.db.prepare("SELECT t.id AS task_id, t.cluster_id AS cluster_id, j.value AS label FROM collaboration_tasks t, json_each(t.data_json, '$.labels') j").all() as Row[];
  const usage = new Map<string, { tasks: Set<string>; clusters: Set<string> }>();
  for (const row of rows) {
    const key = nameKey(String(row.label));
    const entry = usage.get(key) ?? { tasks: new Set<string>(), clusters: new Set<string>() };
    entry.tasks.add(String(row.task_id));
    entry.clusters.add(String(row.cluster_id));
    usage.set(key, entry);
  }
  return new Map([...usage].map(([key, entry]) => [key, { tasks: entry.tasks.size, clusters: entry.clusters.size }]));
}

export interface LibraryView {
  groups: (LabelGroupInfo & { selected?: boolean; labels: (LabelInfo & { usage?: { tasks: number; clusters: number } })[] })[];
  ungrouped: (LabelInfo & { usage?: { tasks: number; clusters: number } })[];
  packs: { id: string; name: string; labels: string[] }[];
}

/** The whole library, grouped; `clusterId` adds whether that cluster chose each group, `usage` the task counts. */
export function libraryView(store: Store, clusterId: string | null, usage = false): LibraryView {
  const counts = usage ? labelUsage(store) : null;
  const selected = clusterId ? new Set(clusterGroupIds(store, clusterId)) : null;
  const withUsage = (label: LabelInfo) => (counts ? { ...label, usage: counts.get(nameKey(label.name)) ?? { tasks: 0, clusters: 0 } } : label);
  const labels = allLabels(store);
  return {
    groups: allGroups(store).map((group) => ({ ...group, ...(selected ? { selected: selected.has(group.id) } : {}),
      labels: labels.filter((label) => label.groupId === group.id).map(withUsage) })),
    ungrouped: labels.filter((label) => label.groupId === null).map(withUsage),
    packs: PRESET_PACKS.map((pack) => ({ id: pack.id, name: pack.name, labels: [...pack.labels] })),
  };
}

/** What list_tasks include: ["labels"] returns: this cluster's chosen groups and the ungrouped labels, archived ones left out. */
export function clusterLabelCatalog(store: Store, clusterId: string) {
  const view = libraryView(store, clusterId);
  const usable = (labels: LabelInfo[]) => labels.filter((label) => !label.archived)
    .map((label) => ({ name: label.name, ...(label.description ? { description: label.description } : {}) }));
  return {
    groups: view.groups.filter((group) => group.selected).map((group) => ({ name: group.name,
      ...(group.description ? { description: group.description } : {}), required: group.required, labels: usable(group.labels) })),
    ungrouped: usable(view.ungrouped),
  };
}

const checkName = (value: unknown, what: string): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    return fail('INVALID_REQUEST', `${what} must be 1-${NAME_MAX} characters without control characters`);
  }
  // Pages and filters list names separated by commas; a label from before this rule keeps its comma on its tasks.
  if (/[,，]/.test(name)) return fail('INVALID_REQUEST', `${what} must not contain a comma (, or ，); use another separator such as - or /`);
  return name;
};
const checkDescription = (value: unknown): string => {
  if (typeof value !== 'string') return fail('INVALID_REQUEST', 'description must be a string');
  const text = value.trim();
  if ([...text].length > DESCRIPTION_MAX) return fail('INVALID_REQUEST', `description must be at most ${DESCRIPTION_MAX} characters`);
  return text;
};
const checkColor = (value: unknown): number | null => {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= COLOR_COUNT) {
    return fail('INVALID_REQUEST', `color must be an integer from 0 to ${COLOR_COUNT - 1}, or null for automatic`);
  }
  return value as number;
};
const checkBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') return fail('INVALID_REQUEST', `${field} must be boolean`);
  return value;
};

function insertLabel(store: Store, name: string, groupId: string | null, createdBy: string, now: string,
  extra: { color?: number | null; description?: string } = {}): LabelInfo {
  const label: LabelInfo = { id: randomUUID(), name, groupId, color: extra.color ?? null, description: extra.description ?? '',
    archived: false, createdBy, createdAt: now };
  store.db.prepare('INSERT INTO task_labels (id, name, name_key, group_id, color, description, archived, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(label.id, label.name, nameKey(label.name), label.groupId, label.color, label.description, label.createdBy, label.createdAt);
  return label;
}

function insertGroup(store: Store, fields: Omit<LabelGroupInfo, 'id'>): LabelGroupInfo {
  const group: LabelGroupInfo = { id: randomUUID(), ...fields };
  store.db.prepare('INSERT INTO task_label_groups (id, name, name_key, description, required, new_cluster_default, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(group.id, group.name, nameKey(group.name), group.description, group.required ? 1 : 0, group.newClusterDefault ? 1 : 0, group.createdBy, group.createdAt);
  return group;
}

/**
 * The labels a task.create / task.edit stores (docs/collaboration.md「标签库」). Each name is trimmed and matched
 * without case to the library, which gives the stored spelling; a name the library lacks is created there ungrouped,
 * by the caller, unless `write` is false (a coordinator suggestion writes nothing). Labels the task already had stay as
 * they are, even when archived or not in the library. Archived labels cannot be added. When `check` is set, every
 * required group this cluster chose must be covered by at least one label.
 */
export function applyTaskLabels(store: Store, clusterId: string, actorId: string, raw: string[], before: string[],
  opts: { write: boolean; now: string; check: boolean | 'changed'; onCreated?: () => void }): string[] {
  const had = new Map(before.map((name) => [nameKey(name), name]));
  let created = false;
  const out = new Map<string, string>();
  for (const value of raw) {
    const name = value.trim();
    const key = nameKey(name);
    if (out.has(key)) continue;
    const label = labelByKey(store, key);
    if (label) {
      if (label.archived && !had.has(key)) {
        return fail('INVALID_REQUEST', `label ${label.name} is archived and cannot be added to a task; choose another label (list_tasks with include: ["labels"] lists them)`);
      }
      out.set(key, label.name);
    } else if (had.has(key)) {
      out.set(key, had.get(key)!);   // a label from before the library, kept as it was
    } else {
      const checked = checkName(name, `new label ${JSON.stringify(name)}`);
      if (opts.write) { insertLabel(store, checked, null, actorId, opts.now); created = true; }
      out.set(key, checked);
    }
  }
  if (created) opts.onCreated?.();
  const labels = [...out.values()];
  const changed = labels.length !== before.length || labels.some((name) => !had.has(nameKey(name)) || had.get(nameKey(name)) !== name);
  if (opts.check === true || (opts.check === 'changed' && changed)) checkRequiredGroups(store, clusterId, labels);
  return labels;
}

/** Refuse a label set that misses a required group this cluster chose; the message lists each group's labels. */
function checkRequiredGroups(store: Store, clusterId: string, labels: string[]): void {
  const chosen = new Set(clusterGroupIds(store, clusterId));
  const groups = allGroups(store).filter((group) => group.required && chosen.has(group.id));
  if (!groups.length) return;
  const keys = new Set(labels.map(nameKey));
  const library = allLabels(store);
  const missing = groups.filter((group) => !library.some((label) => label.groupId === group.id && keys.has(nameKey(label.name))));
  if (!missing.length) return;
  const parts = missing.map((group) => {
    const names = library.filter((label) => label.groupId === group.id && !label.archived).map((label) => label.name);
    return names.length ? `${group.name} (one of: ${names.join(', ')})` : `${group.name} (the group has no labels yet; add one to it first)`;
  });
  fail('INVALID_REQUEST', `this cluster requires a label from each of these label groups: ${parts.join('; ')}`);
}

/** Label or group by ID, else by name (without case). */
function labelRef(store: Store, ref: unknown, field: string): LabelInfo {
  if (typeof ref !== 'string' || !ref.trim()) return fail('INVALID_REQUEST', `${field} is required (a label ID or name)`);
  const row = store.db.prepare('SELECT * FROM task_labels WHERE id = ?').get(ref) as Row | undefined;
  const label = row ? toLabel(row) : labelByKey(store, nameKey(ref.trim()));
  if (!label) return fail('OUT_OF_SCOPE', `unknown label ${ref}; list_labels shows the library`);
  return label;
}
function groupRef(store: Store, ref: unknown, field: string): LabelGroupInfo {
  if (typeof ref !== 'string' || !ref.trim()) return fail('INVALID_REQUEST', `${field} is required (a label group ID or name)`);
  const row = store.db.prepare('SELECT * FROM task_label_groups WHERE id = ?').get(ref) as Row | undefined;
  const group = row ? toGroup(row) : groupByKey(store, nameKey(ref.trim()));
  if (!group) return fail('OUT_OF_SCOPE', `unknown label group ${ref}; list_labels shows the library`);
  return group;
}

/** Members may remove only what they created; the user may remove anything. */
function ownOnly(actorId: string, createdBy: string, what: string): void {
  if (actorId !== 'user' && actorId !== createdBy) {
    fail('FORBIDDEN', `${what} was created by someone else; a member may delete or merge away only labels and groups it created itself; ask the user`);
  }
}

export interface AffectedTask { taskId: string; number: number | null; before: string[]; after: string[] }

/**
 * Rename (or merge) a label on every task of every cluster, any status, without a revision bump or a notice. Only
 * `$.labels` is rewritten. Returns the changed tasks by cluster, with their labels before and after, so the events
 * that record them can be undone by hand.
 */
function relabelTasks(store: Store, fromKey: string, to: string): Map<string, AffectedTask[]> {
  const rows = store.db.prepare("SELECT id, cluster_id, json_extract(data_json, '$.number') AS number, json_extract(data_json, '$.labels') AS labels FROM collaboration_tasks WHERE json_array_length(data_json, '$.labels') > 0 ORDER BY rowid").all() as Row[];
  const update = store.db.prepare("UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.labels', json(?)) WHERE id = ?");
  const byCluster = new Map<string, AffectedTask[]>();
  for (const row of rows) {
    const before = JSON.parse(String(row.labels)) as string[];
    if (!before.some((name) => nameKey(name) === fromKey)) continue;
    const after: string[] = [];
    for (const name of before.map((item) => (nameKey(item) === fromKey ? to : item))) {
      if (!after.some((item) => nameKey(item) === nameKey(name))) after.push(name);
    }
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    update.run(JSON.stringify(after), String(row.id));
    const list = byCluster.get(String(row.cluster_id)) ?? [];
    list.push({ taskId: String(row.id), number: row.number == null ? null : Number(row.number), before, after });
    byCluster.set(String(row.cluster_id), list);
  }
  return byCluster;
}

export const LABEL_ACTIONS = ['label.create', 'label.edit', 'label.merge', 'label.delete', 'label.group_create', 'label.group_edit',
  'label.group_delete', 'label.add_pack', 'label.select_group'];

/** The payload of the cluster-less event every library change writes, so every open page reloads the library. */
export const LIBRARY_SIGNAL = 'label.library';
const librarySignal = (store: Store, action: string): HubEvent => store.appendEvent(null, null, 'collaboration', { action: LIBRARY_SIGNAL, source: action });
/** A task action created labels: signal it once the command commits. */
export function announceLibrary(ctx: PluginActionContext, source: string): void {
  const event = librarySignal(ctx.store, source);
  ctx.afterCommit(() => ctx.hub.publishEvents([event]));
}

/**
 * The label.* actions through a cluster's command route. Anyone in the cluster may run them, the user through HTTP and
 * members through manage_labels; a member may delete or merge away only what it created. The core writes this
 * cluster's event; a rename or merge also writes one event in every other cluster whose tasks it changed.
 */
export function runLabelAction(ctx: PluginActionContext): Partial<CollaborationResult> & Record<string, unknown> {
  const { store, actorId, clusterId, now, hub } = ctx;
  const { out, base, affected } = applyLabelCommand(store, actorId, clusterId, ctx.command as unknown as Record<string, unknown>, now);
  const here = affected.get(clusterId) ?? [];
  ctx.outcome.payload = () => ({ ...base, ...(here.length ? { affected: here } : {}) });
  ctx.outcome.afterEvent = (event) => {
    // Every other cluster whose tasks changed records the same change with its own tasks, for undoing by hand.
    const events = affectedEvents(store, base, affected, actorId, { originClusterId: clusterId, originEventId: event.seq });
    if (base.action !== 'label.select_group') events.push(librarySignal(store, String(base.action)));
    ctx.afterCommit(() => hub.publishEvents(events));
  };
  return out;
}

function affectedEvents(store: Store, base: Record<string, unknown>, affected: Map<string, AffectedTask[]>, actorId: string,
  origin: { originClusterId: string; originEventId: number } | null): HubEvent[] {
  return [...affected].filter(([id]) => id !== origin?.originClusterId)
    .map(([id, tasks]) => store.appendCollaborationEvent(id, null, { ...base, affected: tasks, by: actorId, ...(origin ?? {}) }));
}

/**
 * The user's library change without a cluster (POST /api/labels): the same rules as the cluster route, every label.*
 * action but label.select_group. Each cluster whose tasks it changed gets an event without originClusterId; no
 * operationId is kept, so a retried command runs again (and a create or a merge then fails as already done).
 */
export function runGlobalLabelCommand(hub: Hub, body: unknown): Record<string, unknown> {
  const command = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof command.action !== 'string' || !LABEL_ACTIONS.includes(command.action) || command.action === 'label.select_group') {
    return fail('INVALID_REQUEST', `action must be one of ${LABEL_ACTIONS.filter((a) => a !== 'label.select_group').join(', ')}; choosing a cluster's groups goes through that cluster`);
  }
  const store = hub.store;
  let events: HubEvent[] = [];
  const result = store.transaction(() => {
    const { out, base, affected } = applyLabelCommand(store, 'user', null, command, new Date().toISOString());
    events = [...affectedEvents(store, base, affected, 'user', null), librarySignal(store, String(base.action))];
    return { action: command.action, ...out };
  });
  hub.publishEvents(events);
  return result;
}

/** Runs one label.* command's rules and writes; `clusterId` is null for the cluster-less route. */
function applyLabelCommand(store: Store, actorId: string, clusterId: string | null, command: Record<string, unknown>, now: string) {
  const action = String(command.action);
  const out: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  let affected = new Map<string, AffectedTask[]>();

  /** Rename `label` to `name`, or merge it into the label that already has that name. */
  const rename = (label: LabelInfo, name: string): void => {
    const target = labelByKey(store, nameKey(name));
    if (target && target.id !== label.id) return merge(label, target);
    store.db.prepare('UPDATE task_labels SET name = ?, name_key = ? WHERE id = ?').run(name, nameKey(name), label.id);
    affected = relabelTasks(store, nameKey(label.name), name);
    Object.assign(details, { from: label.name, to: name });
    label.name = name;
  };
  const merge = (from: LabelInfo, into: LabelInfo): void => {
    if (from.id === into.id) return fail('INVALID_REQUEST', 'a label cannot be merged into itself');
    ownOnly(actorId, from.createdBy, `label ${from.name}`);
    store.db.prepare('DELETE FROM task_labels WHERE id = ?').run(from.id);
    affected = relabelTasks(store, nameKey(from.name), into.name);
    Object.assign(details, { from: from.name, to: into.name, merged: true, intoLabelId: into.id });
    out.label = into;
    out.removedLabelId = from.id;
  };

  if (action === 'label.create') {
    const name = checkName(command.name, 'name');
    if (labelByKey(store, nameKey(name))) return fail('INVALID_REQUEST', `label ${name} already exists (names ignore case); edit it instead`);
    const groupId = command.groupId == null ? null : groupRef(store, command.groupId, 'groupId').id;
    out.label = insertLabel(store, name, groupId, actorId, now, {
      color: command.color === undefined ? null : checkColor(command.color),
      description: command.description === undefined ? '' : checkDescription(command.description) });
  } else if (action === 'label.edit') {
    const label = labelRef(store, command.labelId, 'labelId');
    const fields = ['name', 'groupId', 'color', 'description', 'archived'].filter((field) => command[field] !== undefined);
    if (!fields.length) return fail('INVALID_REQUEST', 'no editable fields were provided (name, groupId, color, description, archived)');
    const groupId = command.groupId === undefined ? label.groupId : command.groupId === null ? null : groupRef(store, command.groupId, 'groupId').id;
    const color = command.color === undefined ? label.color : checkColor(command.color);
    const description = command.description === undefined ? label.description : checkDescription(command.description);
    const archived = command.archived === undefined ? label.archived : checkBoolean(command.archived, 'archived');
    const name = command.name === undefined ? label.name : checkName(command.name, 'name');
    store.db.prepare('UPDATE task_labels SET group_id = ?, color = ?, description = ?, archived = ? WHERE id = ?')
      .run(groupId, color, description, archived ? 1 : 0, label.id);
    Object.assign(label, { groupId, color, description, archived });
    out.label = label;
    if (name !== label.name) rename(label, name);
  } else if (action === 'label.merge') {
    merge(labelRef(store, command.labelId, 'labelId'), labelRef(store, command.intoLabelId, 'intoLabelId'));
  } else if (action === 'label.delete') {
    const label = labelRef(store, command.labelId, 'labelId');
    ownOnly(actorId, label.createdBy, `label ${label.name}`);
    store.db.prepare('DELETE FROM task_labels WHERE id = ?').run(label.id);
    out.label = label;
    details.name = label.name;
  } else if (action === 'label.group_create') {
    const name = checkName(command.name, 'name');
    if (groupByKey(store, nameKey(name))) return fail('INVALID_REQUEST', `label group ${name} already exists (names ignore case); edit it instead`);
    out.group = insertGroup(store, { name, description: command.description === undefined ? '' : checkDescription(command.description),
      required: command.required === undefined ? false : checkBoolean(command.required, 'required'),
      newClusterDefault: command.newClusterDefault === undefined ? false : checkBoolean(command.newClusterDefault, 'newClusterDefault'),
      createdBy: actorId, createdAt: now });
  } else if (action === 'label.group_edit') {
    const group = groupRef(store, command.groupId, 'groupId');
    const fields = ['name', 'description', 'required', 'newClusterDefault'].filter((field) => command[field] !== undefined);
    if (!fields.length) return fail('INVALID_REQUEST', 'no editable fields were provided (name, description, required, newClusterDefault)');
    if (command.name !== undefined) {
      const name = checkName(command.name, 'name');
      const other = groupByKey(store, nameKey(name));
      if (other && other.id !== group.id) return fail('INVALID_REQUEST', `label group ${other.name} already exists (names ignore case)`);
      if (name !== group.name) details.from = group.name;
      group.name = name;
    }
    if (command.description !== undefined) group.description = checkDescription(command.description);
    if (command.required !== undefined) group.required = checkBoolean(command.required, 'required');
    if (command.newClusterDefault !== undefined) group.newClusterDefault = checkBoolean(command.newClusterDefault, 'newClusterDefault');
    store.db.prepare('UPDATE task_label_groups SET name = ?, name_key = ?, description = ?, required = ?, new_cluster_default = ? WHERE id = ?')
      .run(group.name, nameKey(group.name), group.description, group.required ? 1 : 0, group.newClusterDefault ? 1 : 0, group.id);
    out.group = group;
  } else if (action === 'label.group_delete') {
    const group = groupRef(store, command.groupId, 'groupId');
    ownOnly(actorId, group.createdBy, `label group ${group.name}`);
    // Its labels stay in the library, ungrouped; no cluster keeps the group chosen.
    store.db.prepare('UPDATE task_labels SET group_id = NULL WHERE group_id = ?').run(group.id);
    store.db.prepare('DELETE FROM cluster_label_groups WHERE group_id = ?').run(group.id);
    store.db.prepare('DELETE FROM task_label_groups WHERE id = ?').run(group.id);
    out.group = group;
  } else if (action === 'label.add_pack') {
    const pack = PRESET_PACKS.find((item) => item.id === command.pack);
    if (!pack) return fail('INVALID_REQUEST', `unknown pack; available: ${PRESET_PACKS.map((item) => item.id).join(', ')}`);
    // Whatever already exists by name is left as it is: adding a pack twice changes nothing.
    const existing = groupByKey(store, nameKey(pack.name));
    const group = existing ?? insertGroup(store, { name: pack.name, description: pack.description, required: pack.required,
      newClusterDefault: pack.newClusterDefault, createdBy: actorId, createdAt: now });
    const added = pack.labels.filter((name) => !labelByKey(store, nameKey(name))).map((name) => insertLabel(store, name, group.id, actorId, now));
    out.group = group;
    Object.assign(details, { pack: pack.id, groupCreated: !existing, addedLabels: added.map((label) => label.name) });
  } else if (action === 'label.select_group' && clusterId) {
    const group = groupRef(store, command.groupId, 'groupId');
    const selected = checkBoolean(command.selected, 'selected');
    if (selected) store.db.prepare('INSERT OR IGNORE INTO cluster_label_groups (cluster_id, group_id) VALUES (?, ?)').run(clusterId, group.id);
    else store.db.prepare('DELETE FROM cluster_label_groups WHERE cluster_id = ? AND group_id = ?').run(clusterId, group.id);
    out.group = group;
    details.selected = selected;
  } else {
    return fail('INVALID_REQUEST', 'unsupported label action');
  }

  const label = out.label as LabelInfo | undefined;
  const group = out.group as LabelGroupInfo | undefined;
  const base: Record<string, unknown> = { action, ...(label ? { labelId: label.id, name: label.name } : {}), ...(group ? { groupId: group.id, name: group.name } : {}), ...details };
  out.affectedTasks = [...affected.values()].reduce((sum, tasks) => sum + tasks.length, 0);
  out.affectedClusters = affected.size;
  return { out, base, affected };
}
