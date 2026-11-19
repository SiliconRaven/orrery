// Permanent delete from the recycle bin (Hub.purgeCluster, POST /api/clusters/:id/purge; docs/architecture.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../src/core/store.ts';
import type { NativeDeliverContext } from '../src/core/types.ts';
import { toolLists } from '../src/mcp/server.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { insertMessageWithEvent, startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

test('every official plugin whose tables tie rows to a cluster, member, message, task or file has the purge hook', () => {
  // The seeded purge test below catches a forgotten table only when it seeds it; this catches a new plugin table cheaply.
  for (const plugin of officialPlugins) {
    const tied = (plugin.migrations ?? []).some((sql) => /\b(cluster|member|message|task|file|role)_id\b/.test(sql));
    assert.ok(!tied || plugin.clusterPurging, `plugin ${plugin.id} has cluster-tied tables but no clusterPurging hook`);
  }
});

type Snapshot = Map<string, Map<string, string>>;

/** Every row of every table (sqlite_* aside), by rowid, as JSON. */
function snapshot(store: Store): Snapshot {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((r) => String(r.name));
  return new Map(tables.map((t) => [t, new Map(store.db.prepare(`SELECT rowid AS __rowid, * FROM "${t}"`).all()
    .map(({ __rowid, ...row }) => [String(__rowid), JSON.stringify(row)]))]));
}

const bytes = async function* (text: string) { yield Buffer.from(text); };
const settled = (app: TestHub, clusterId: string) => waitFor(() => app.store.db.prepare(`SELECT COUNT(*) AS n FROM deliveries d
  JOIN messages m ON m.id = d.message_id WHERE m.cluster_id = ? AND d.state IN ('queued', 'running')`).get(clusterId)!.n === 0, 'deliveries to settle');
const trashVersion = (app: TestHub, id: string) => app.hub.listDeletedClusters().find((row) => row.id === id)?.trashVersion ?? 0;

/**
 * A cluster with a row in every cluster-tied table: members attached to sessions (A on s1, C on s2) and a new conversation (B),
 * messages with replies and attachments, an offline delivery handed off, reads and an acknowledgement, files on
 * messages and on a task, tasks with records, links, a dependency, labels and a watch, a chosen label group, a bookmark, a
 * role, the pause row and an idempotent operation, a merge window, usage and activity rows, and their events.
 */
async function seed(app: TestHub, name: string, marker: string) {
  const { cluster, members } = await app.hub.createCluster(name, [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', name: 'B', projectPath: '/work' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'C' },
  ]);
  const [a, , c] = members;
  const user = { kind: 'user' } as const;
  let op = 0;
  const command = (body: Record<string, unknown>) => app.hub.collaboration.command(user, cluster.id, { operationId: `seed-${++op}`,
    ...(typeof body.taskId === 'string' ? { expectedRevision: app.store.tasks!.task(cluster.id, body.taskId)!.revision } : {}), ...body } as never) as Record<string, any>;
  const onMessage = await app.hub.uploadFile(cluster.id, 'note.txt', bytes(`message file ${marker}`));
  const onTask = await app.hub.uploadFile(cluster.id, 'task.txt', bytes(`task file ${marker}`));
  const first = app.hub.sendFromUser(cluster.id, `@A hello ${marker} ${'x'.repeat(6000)}`, undefined, [onMessage.id]);
  await settled(app, cluster.id);
  app.hub.sendFromMember(a.id, `@B chat reply ${marker}`, first.id);
  await settled(app, cluster.id);
  app.hub.ackMessages(a.id, [first.id]);
  app.native.isOnline = (session) => session !== 's2';
  const offline = app.hub.sendFromUser(cluster.id, `@C offline ${marker}`);
  app.native.isOnline = () => true;
  const delivery = app.store.withDeliveries([offline])[0].deliveries.find((d) => d.memberId === c.id)!;
  app.hub.handoffDelivery(cluster.id, delivery.id, { targetMemberId: a.id });
  const pack = command({ action: 'label.add_pack', pack: 'task-types' });
  command({ action: 'label.select_group', groupId: (pack.group as { id: string }).id, selected: true });
  const t1 = command({ action: 'task.create', title: `first ${marker}`, scope: 's', acceptance: 'a', labels: ['åŠŸèƒ½'], fileIds: [onTask.id] }).task!;
  command({ action: 'task.create', title: 'second', scope: 's', acceptance: 'a', dependencyIds: [t1.id] });
  command({ action: 'task.assign', taskId: t1.id, memberId: a.id });
  command({ action: 'task.attention', taskId: t1.id, kind: 'question', question: `why ${marker}?`, targetMemberId: a.id });
  app.hub.sendFromUser(cluster.id, `@A about the task ${marker}`, undefined, undefined, [t1.id]);
  app.hub.collaboration.command({ kind: 'member', memberId: a.id }, cluster.id, { action: 'bookmark.set', operationId: 'bookmark', messageId: first.id, labels: ['keep'] });
  app.hub.collaboration.command({ kind: 'member', memberId: a.id }, cluster.id, { action: 'task.watch', operationId: 'watch', taskId: t1.id, note: `after ${marker}` });
  const role = command({ action: 'role.create', name: `role-${marker}` }).role!;
  command({ action: 'member.roles', memberId: a.id, roleIds: [role.id] });
  command({ action: 'tasks.settings', takeoverSelfReview: true });
  command({ action: 'tasks.permissions', taskPermissions: { createRoleIds: [role.id], executeRoleIds: [role.id], reviewRoleIds: [] } });
  command({ action: 'cluster.pause', operationId: `pause-${marker}`, paused: true });
  command({ action: 'cluster.pause', operationId: `resume-${marker}`, paused: false });
  app.store.db.prepare('INSERT INTO merge_windows (cluster_id, data_json) VALUES (?, ?)').run(cluster.id, JSON.stringify({ marker }));
  app.store.recordTurnUsage(randomUUID(), a.id, { input: 1, cachedInput: 2, cacheWrite: 3, output: 4, reasoning: 5 });
  app.store.saveActivity(a.id, 'test', new Date().toISOString(), { kind: 'turn', phase: 'started' });
  await settled(app, cluster.id);
  return { cluster, members, files: [onMessage, onTask] };
}

/** Every id the purged cluster owned, collected before the purge. */
function ownedIds(store: Store, clusterId: string): string[] {
  const all = (sql: string) => store.db.prepare(sql).all(clusterId).map((r) => String(r.id));
  return [clusterId, ...all('SELECT id FROM members WHERE cluster_id = ?'), ...all('SELECT id FROM messages WHERE cluster_id = ?'),
    ...all('SELECT id FROM files WHERE cluster_id = ?'), ...all('SELECT id FROM collaboration_tasks WHERE cluster_id = ?'),
    ...all('SELECT id FROM collaboration_roles WHERE cluster_id = ?'),
    ...all('SELECT r.id FROM collaboration_records r JOIN collaboration_tasks t ON t.id = r.task_id WHERE t.cluster_id = ?'),
    ...all('SELECT d.id FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.cluster_id = ?')];
}

/**
 * After a purge: no value of any row still names a purged id (the tombstone event aside, which names only the cluster),
 * every surviving row is byte-for-byte what it was (a member's clamped watermark aside), every row that went named a
 * purged id, and the foreign keys hold.
 */
function assertPurged(store: Store, before: Snapshot, owned: string[], clusterId: string): void {
  const after = snapshot(store);
  const tombstones: string[] = [];
  for (const [table, rows] of after) {
    for (const [rowid, json] of rows) {
      const row = JSON.parse(json);
      if (table === 'events' && row.kind === 'cluster' && JSON.parse(row.payload_json).cluster.purgedAt) { tombstones.push(json); continue; }
      const hit = owned.find((id) => json.includes(id));
      assert.equal(hit, undefined, `${table} row ${rowid} still names purged id ${hit}: ${json.slice(0, 300)}`);
      const old = before.get(table)?.get(rowid);
      if (old === json) continue;
      const clampedOnly = table === 'members' && old && JSON.stringify({ ...JSON.parse(old), unread_after_rowid: 0 }) === JSON.stringify({ ...row, unread_after_rowid: 0 });
      assert.ok(clampedOnly, `${table} row ${rowid} changed or appeared: ${json.slice(0, 300)}`);
    }
  }
  assert.equal(tombstones.length, 1, 'one tombstone');
  const tombstone = JSON.parse(tombstones[0]);
  assert.equal(tombstone.cluster_id, clusterId);
  assert.deepEqual(Object.keys(JSON.parse(tombstone.payload_json).cluster).sort(), ['deletedAt', 'id', 'purgedAt'], 'the tombstone has no name');
  for (const [table, rows] of before) {
    for (const [rowid, json] of rows) {
      if (after.get(table)?.has(rowid)) continue;
      assert.ok(owned.some((id) => json.includes(id)), `${table} row ${rowid} was removed but belonged to no purged id: ${json.slice(0, 300)}`);
    }
  }
  // The column walk the task asked for: every id-like column of every table, including any a future plugin adds.
  for (const table of after.keys()) {
    const columns = store.db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => String(c.name))
      .filter((name) => name === 'id' || name.endsWith('_id') || name === 'reply_to');
    for (const column of columns) {
      const left = store.db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" IN (SELECT value FROM json_each(?))`
        + (table === 'events' && column === 'cluster_id' ? " AND kind != 'cluster'" : '')).get(JSON.stringify(owned))!.n;
      assert.equal(left, 0, `${table}.${column} still holds a purged id`);
    }
  }
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('a purge removes every row of the cluster in core and plugin tables and leaves another cluster sharing a session byte for byte', async () => {
  const app = await startTestHub();
  try {
    const keep = await seed(app, 'keep', 'KEEP-MARK');
    const gone = await seed(app, 'gone-cluster-name', 'GONE-MARK');
    // Files and folders a purge must never touch: an outbox, a project folder.
    const outbox = app.hub.files!.memberOutbox(gone.members[0].id);
    writeFileSync(join(outbox, 'mine.txt'), 'member file');
    writeFileSync(join(app.dir, 'project-1', 'code.txt'), 'project');
    for (const table of ['members', 'messages', 'deliveries', 'reads', 'message_acknowledgements', 'files', 'message_files', 'turn_usage',
      'activity_snapshots', 'collaboration_roles', 'collaboration_member_roles', 'collaboration_policies', 'collaboration_operations',
      'collaboration_tasks', 'collaboration_records', 'collaboration_links', 'merge_windows', 'task_counters', 'cluster_label_groups', 'collaboration_bookmarks', 'task_watches', 'task_cluster_settings', 'task_cluster_permissions']) {
      const where = table === 'members' || table === 'messages' || table === 'files' || table.startsWith('collaboration_tasks') || table === 'collaboration_roles'
        || table === 'collaboration_policies' || table === 'collaboration_operations' || table === 'merge_windows' || table === 'task_counters' || table === 'cluster_label_groups'
        || table === 'task_cluster_settings' || table === 'task_cluster_permissions'
        ? 'cluster_id = ?' : null;
      const n = where ? app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(gone.cluster.id)!.n : app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
      assert.ok(Number(n) > 0, `the seed wrote ${table}`);
    }
    assert.ok(app.store.db.prepare("SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE m.cluster_id = ? AND d.handoff_message_id IS NOT NULL").get(gone.cluster.id), 'a hand-off');
    assert.ok(app.store.db.prepare('SELECT 1 FROM messages WHERE cluster_id = ? AND reply_to IS NOT NULL').get(gone.cluster.id), 'a reply');
    assert.ok(app.store.db.prepare("SELECT 1 FROM members WHERE cluster_id = ? AND origin = 'created'").get(gone.cluster.id), 'a created conversation');

    app.hub.deleteCluster(gone.cluster.id);
    const owned = ownedIds(app.store, gone.cluster.id);
    const [trashed] = app.hub.listDeletedClusters();
    assert.equal(trashed.messageCount, app.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE cluster_id = ?').get(gone.cluster.id)!.n);
    assert.equal(trashed.fileCount, 2);
    const before = snapshot(app.store);
    const result = await app.api('POST', `/api/clusters/${gone.cluster.id}/purge`, { name: 'gone-cluster-name', trashVersion: trashed.trashVersion });
    assert.equal(result.clusterId, gone.cluster.id);
    assert.equal(result.files, 2);
    assert.deepEqual(result.filesFailed, []);
    assert.equal(result.walCheckpointed, true);
    assertPurged(app.store, before, owned, gone.cluster.id);

    for (const f of gone.files) assert.equal(existsSync(join(app.dir, 'home', 'files', f.id)), false, 'the upload folder is gone');
    for (const f of keep.files) assert.equal(existsSync(join(app.dir, 'home', 'files', f.id, f.name)), true, 'the other cluster keeps its files');
    assert.equal(readFileSync(join(outbox, 'mine.txt'), 'utf8'), 'member file');
    assert.equal(readFileSync(join(app.dir, 'project-1', 'code.txt'), 'utf8'), 'project');

    // The replay from the start shows nothing of it but the tombstone, and the page's 'cluster' rule drops it.
    const replay = await fetch(`${app.url}/api/stream?since=0`).then(async (res) => {
      const reader = res.body!.getReader();
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
        if (text.includes('purgedAt')) break;
      }
      await reader.cancel();
      return text;
    });
    const lines = replay.split('\n').filter((l) => l.startsWith('data:') && l.includes(gone.cluster.id));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /purgedAt/);
    assert.doesNotMatch(replay, /gone-cluster-name|GONE-MARK/);

    // The other cluster, and the native session it shares, keep working.
    app.hub.sendFromUser(keep.cluster.id, '@A still here');
    await settled(app, keep.cluster.id);
    assert.deepEqual(app.hub.nativeCallers('mock', 's1').map((m) => m.id), [keep.members[0].id]);
    assert.deepEqual(app.hub.listDeletedClusters(), []);
  } finally { await app.close(); }
});

/**
 * A cluster with large message bodies, purged; the marker's occurrences in the database file before and after (the
 * WAL written back), and the connection's secure_delete afterwards. `alwaysOn`: the connection had it on from the start.
 */
async function erase(alwaysOn: boolean) {
  const dir = tempDir();
  const app = await startTestHub({ dir });
  try {
    if (alwaysOn) app.store.db.exec('PRAGMA secure_delete = ON');
    const { cluster } = await app.hub.createCluster('erase-me-name', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const keep = await app.hub.createCluster('kept', [{ harness: 'mock', mode: 'native', sessionId: 's2', name: 'K' }]);
    for (let i = 0; i < 5; i++) app.hub.sendFromUser(cluster.id, `@A ERASE-MARKER-${i} ${'y'.repeat(8000)}`);
    app.hub.sendFromUser(keep.cluster.id, '@K KEEP-MARKER');
    await settled(app, cluster.id);
    await settled(app, keep.cluster.id);
    assert.equal(app.store.checkpoint(), true);
    const db = () => readFileSync(join(dir, 'test.db')).toString('latin1');
    const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
    const before = count(db(), /ERASE-MARKER/g);
    app.hub.deleteCluster(cluster.id);
    const result = await app.hub.purgeCluster(cluster.id, 'erase-me-name', trashVersion(app, cluster.id));
    assert.equal(result.walCheckpointed, true);
    const file = db();
    assert.match(file, /KEEP-MARKER/);
    const wal = join(dir, 'test.db-wal');
    if (existsSync(wal)) assert.equal(count(readFileSync(wal).toString('latin1'), /ERASE-MARKER/g), 0, 'the WAL was truncated');
    return { before, after: count(file, /ERASE-MARKER/g), name: count(file, /erase-me-name/g),
      setting: Number(app.store.db.prepare('PRAGMA secure_delete').get()!.secure_delete) };
  } finally { await app.close(); }
}

// What secure_delete does and does not do (docs/architecture.md「永久删除」): the purge turns it on, so the rows it
// deletes are overwritten with zeros. Copies that earlier writes left in a page's free space while it was off (a row an
// UPDATE moved, cells a page split copied) are not: only VACUUM, or the setting being on from the start, removes them.
test('the purge overwrites the rows it deletes; older free-space copies stay unless secure_delete was always on', async () => {
  const off = await erase(false);
  assert.ok(off.before >= 10, `the marker is in the file before (${off.before})`);
  assert.ok(off.after * 4 < off.before, `the deleted rows were zeroed (${off.before} → ${off.after})`);
  assert.equal(off.setting, 0, 'the connection setting is restored');
  const on = await erase(true);
  assert.deepEqual([on.after, on.name], [0, 0], 'nothing of the cluster is left in the file');
  assert.equal(on.setting, 1);
});

test('a purge is refused and changes nothing: active, restored meanwhile, wrong name, unknown, still running', async () => {
  const app = await startTestHub();
  const runs: { gate: PromiseWithResolvers<'completed'>; ctx: NativeDeliverContext }[] = [];
  try {
    const { cluster } = await app.hub.createCluster('target', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    app.hub.sendFromUser(cluster.id, '@A first');
    await settled(app, cluster.id);
    const refused = async (id: string, name: unknown, status: number, code: string, version = trashVersion(app, id)) => {
      const before = snapshot(app.store);
      const res = await fetch(`${app.url}/api/clusters/${id}/purge`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, trashVersion: version }),
      });
      const body = await res.json();
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(body.code, code);
      assert.deepEqual(snapshot(app.store), before, `${code}: nothing changed`);
      return body;
    };
    await refused(cluster.id, 'target', 409, 'NOT_IN_TRASH');
    app.hub.deleteCluster(cluster.id);
    await refused(cluster.id, 'target ', 409, 'NAME_MISMATCH');
    await refused(cluster.id, 'Target', 409, 'NAME_MISMATCH');
    await refused(cluster.id, 42, 409, 'NAME_MISMATCH');
    await refused(randomUUID(), 'target', 404, 'NOT_FOUND');
    const shape = await fetch(`${app.url}/api/clusters/${cluster.id}/purge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'target', force: true }) });
    assert.equal(shape.status, 400);
    app.hub.restoreCluster(cluster.id);
    await refused(cluster.id, 'target', 409, 'NOT_IN_TRASH');
    app.hub.deleteCluster(cluster.id);
    const oldVersion = trashVersion(app, cluster.id);
    app.hub.restoreCluster(cluster.id);
    app.hub.sendFromUser(cluster.id, 'message added after the old confirmation');
    app.hub.deleteCluster(cluster.id);
    assert.ok(trashVersion(app, cluster.id) > oldVersion);
    await refused(cluster.id, 'target', 409, 'TRASH_CHANGED', oldVersion);
    app.hub.restoreCluster(cluster.id);

    // A native run that started before the delete keeps going: refused, naming the member, until it ends.
    app.native.deliver = async (_session, _text, ctx) => {
      const gate = Promise.withResolvers<'completed'>();
      runs.push({ gate, ctx });
      return gate.promise;
    };
    app.hub.sendFromUser(cluster.id, '@A long');
    await waitFor(() => runs.length === 1, 'the run');
    app.hub.deleteCluster(cluster.id);
    const body = await refused(cluster.id, 'target', 409, 'RUNNING');
    assert.equal(body.member, 'A');
    runs[0].gate.resolve('completed');
    await settled(app, cluster.id);
    await app.hub.purgeCluster(cluster.id, 'target', trashVersion(app, cluster.id));
    assert.equal(app.store.getCluster(cluster.id, { includeDeleted: true }), null);
  } finally {
    for (const run of runs) run.gate.resolve('completed');
    await app.close();
  }
});

test('a stored running delivery without a Hub run also refuses the purge', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members } = await app.hub.createCluster('stuck', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    app.hub.deleteCluster(cluster.id);
    const message = { id: randomUUID(), clusterId: cluster.id, from: 'user', mentions: [members[0].id], body: 'x', replyTo: null,
      chainId: randomUUID(), hop: 0, createdAt: new Date().toISOString() };
    const [delivery] = insertMessageWithEvent(app.store, message, [members[0].id]).deliveries;
    app.store.db.prepare("UPDATE deliveries SET state = 'running' WHERE id = ?").run(delivery.id);
    await assert.rejects(app.hub.purgeCluster(cluster.id, 'stuck', trashVersion(app, cluster.id)), (e: Error & { code?: string; member?: string }) => e.code === 'RUNNING' && e.member === 'A');
    assert.ok(app.store.getCluster(cluster.id, { includeDeleted: true }));
  } finally { await app.close(); }
});

test('a purge clamps other members\' join watermark, so rowids reused after it still count as unread', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.hub.createCluster('newest', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    for (let i = 0; i < 5; i++) app.hub.sendFromUser(cluster.id, `@A ${i}`);
    await settled(app, cluster.id);
    // Joins after those: its watermark is the highest message rowid, which lies in the cluster about to go.
    const other = await app.hub.createCluster('other', [{ harness: 'mock', mode: 'native', sessionId: 's2', name: 'M' }]);
    const m = other.members[0];
    app.hub.deleteCluster(cluster.id);
    await app.hub.purgeCluster(cluster.id, 'newest', trashVersion(app, cluster.id));
    const message = { id: randomUUID(), clusterId: other.cluster.id, from: 'user', mentions: [], body: 'to everyone', replyTo: null,
      chainId: randomUUID(), hop: 0, createdAt: new Date().toISOString() };
    insertMessageWithEvent(app.store, message);
    assert.equal(app.store.messageRowid(other.cluster.id, message.id), 1, 'the rowid was reused');
    assert.deepEqual(app.store.unreadIds(m.id, other.cluster.id), [message.id]);
  } finally { await app.close(); }
});

test('disabled tasks and bookmarks plugins still lose the purged cluster\'s rows', async () => {
  const dir = tempDir();
  let app = await startTestHub({ dir });
  let clusterId = '';
  try {
    const seeded = await seed(app, 'plugins-off', 'OFF-MARK');
    clusterId = seeded.cluster.id;
    app.hub.deleteCluster(clusterId);
  } finally { await app.close(); }
  app = await startTestHub({ dir, disabledPlugins: ['coordinator', 'tasks', 'bookmarks'] });   // the coordinator requires tasks
  try {
    assert.equal(app.store.tasks, null, 'tasks plugin is off');
    const owned = ownedIds(app.store, clusterId);
    const before = snapshot(app.store);
    assert.ok(before.get('collaboration_bookmarks')!.size > 0 && before.get('collaboration_tasks')!.size > 0);
    await app.hub.purgeCluster(clusterId, 'plugins-off', trashVersion(app, clusterId));
    assertPurged(app.store, before, owned, clusterId);
  } finally { await app.close(); }
});

test('a file folder replaced by a link, or by a file, is not followed and is reported', async (t) => {
  const app = await startTestHub();
  const outside = join(tempDir(), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'canary.txt'), 'must survive');
  try {
    const { cluster } = await app.hub.createCluster('links', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const linked = await app.hub.uploadFile(cluster.id, 'a.txt', bytes('a'));
    const flat = await app.hub.uploadFile(cluster.id, 'b.txt', bytes('b'));
    const plain = await app.hub.uploadFile(cluster.id, 'c.txt', bytes('c'));
    const filesDir = join(app.dir, 'home', 'files');
    rmSync(join(filesDir, linked.id), { recursive: true });
    try {
      symlinkSync(outside, join(filesDir, linked.id), 'junction');
    } catch (e) {
      t.skip(`cannot create a link here: ${(e as Error).message}`);
      return;
    }
    rmSync(join(filesDir, flat.id), { recursive: true });
    writeFileSync(join(filesDir, flat.id), 'a file where the folder was');
    app.hub.deleteCluster(cluster.id);
    const result = await app.hub.purgeCluster(cluster.id, 'links', trashVersion(app, cluster.id));
    assert.deepEqual(result.filesFailed.sort(), [linked.id, flat.id].sort());
    assert.equal(readFileSync(join(outside, 'canary.txt'), 'utf8'), 'must survive');
    assert.equal(existsSync(join(filesDir, plain.id)), false);
    assert.equal(app.store.getFile(linked.id), null, 'the rows are gone all the same');
  } finally { await app.close(); }
});

test('a substituted upload root leaves a matching file at the destination untouched', async (t) => {
  const app = await startTestHub();
  const filesDir = join(app.dir, 'home', 'files');
  const held = join(app.dir, 'held-uploads');
  const replacement = join(app.dir, 'other-files');
  let linked = false;
  try {
    const { cluster } = await app.cluster('linked root', ['A']);
    const file = await app.hub.uploadFile(cluster.id, 'uploaded.txt', bytes('original'));
    mkdirSync(join(replacement, file.id), { recursive: true });
    const canary = join(replacement, file.id, file.name);
    writeFileSync(canary, 'outside of the upload root');
    renameSync(filesDir, held);
    try {
      symlinkSync(replacement, filesDir, 'junction');
      linked = true;
    } catch (e) {
      t.skip(`cannot create a link here: ${(e as Error).message}`);
      return;
    }
    app.hub.deleteCluster(cluster.id);
    const result = await app.hub.purgeCluster(cluster.id, cluster.name, trashVersion(app, cluster.id));
    assert.deepEqual(result.filesFailed, [file.id]);
    assert.equal(readFileSync(canary, 'utf8'), 'outside of the upload root');
    assert.equal(readFileSync(join(held, file.id, file.name), 'utf8'), 'original');
  } finally {
    if (linked) unlinkSync(filesDir);
    await app.close();
  }
});

test('a shared chain keeps its spent turns until its last group is purged', async () => {
  const app = await startTestHub();
  try {
    const first = await app.cluster('first', ['A']);
    const second = await app.cluster('second', ['B']);
    const origin = app.hub.sendFromUser(first.cluster.id, '@A start');
    const followup = app.hub.sendFromUser(second.cluster.id, '@B continue');
    await settled(app, first.cluster.id);
    await settled(app, second.cluster.id);
    app.store.db.prepare('UPDATE messages SET chain_id = ? WHERE id = ?').run(origin.chainId, followup.id);
    assert.equal(app.store.countChainTurns(origin.chainId), 2);
    app.hub.deleteCluster(first.cluster.id);
    await app.hub.purgeCluster(first.cluster.id, first.cluster.name, trashVersion(app, first.cluster.id));
    assert.equal(app.store.countChainTurns(origin.chainId), 2);
    app.hub.deleteCluster(second.cluster.id);
    await app.hub.purgeCluster(second.cluster.id, second.cluster.name, trashVersion(app, second.cluster.id));
    assert.equal(app.store.countChainTurns(origin.chainId), 0);
  } finally { await app.close(); }
});

test('a group cannot be purged during an in-flight member addition', async () => {
  const app = await startTestHub();
  const gate = Promise.withResolvers<void>();
  let adding: ReturnType<typeof app.hub.addMembers> | undefined;
  try {
    const { cluster } = await app.cluster('adding a member', ['A']);
    const started = Promise.withResolvers<void>();
    const create = app.native.createSession!;
    app.native.createSession = async (spec) => { started.resolve(); await gate.promise; return create(spec); };
    adding = app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', name: 'B', projectPath: '/work' }]);
    await started.promise;
    app.hub.deleteCluster(cluster.id);
    await assert.rejects(app.hub.purgeCluster(cluster.id, cluster.name, trashVersion(app, cluster.id)), { code: 'ADDING_MEMBERS' });
    app.hub.restoreCluster(cluster.id);
    gate.resolve();
    assert.equal((await adding).members[0].name, 'B');
    app.hub.deleteCluster(cluster.id);
    await app.hub.purgeCluster(cluster.id, cluster.name, trashVersion(app, cluster.id));
  } finally {
    gate.resolve();
    await adding?.catch(() => {});
    await app.close();
  }
});

test('late callbacks after a purge fail quietly: usage, agent events, an upload in flight', async () => {
  const app = await startTestHub();
  let ctx: NativeDeliverContext | null = null;
  const failures: unknown[] = [];
  const onRejection = (e: unknown) => failures.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    app.native.deliver = async (_session, _text, c) => { ctx = c; return 'completed'; };
    const { cluster } = await app.hub.createCluster('late', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    app.hub.sendFromUser(cluster.id, '@A go');
    await settled(app, cluster.id);
    const gate = Promise.withResolvers<void>();
    const upload = app.hub.uploadFile(cluster.id, 'late.txt', (async function* () { yield Buffer.from('start'); await gate.promise; yield Buffer.from('end'); })());
    const { readdirSync } = await import('node:fs');
    await waitFor(() => readdirSync(join(app.dir, 'home', 'files')).length > 0, 'the upload folder');
    app.hub.deleteCluster(cluster.id);
    await app.hub.purgeCluster(cluster.id, 'late', trashVersion(app, cluster.id));
    const rows = () => Number(app.store.db.prepare('SELECT (SELECT COUNT(*) FROM turn_usage) + (SELECT COUNT(*) FROM files) + (SELECT COUNT(*) FROM events WHERE kind != \'cluster\' AND cluster_id = ?) AS n').get(cluster.id)!.n);
    const at = rows();
    ctx!.usage!({ input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 });
    ctx!.onEvent({ type: 'text', text: 'late' });
    ctx!.waiting?.(null);
    gate.resolve();
    await assert.rejects(upload);
    assert.equal(rows(), at, 'nothing was written');
    assert.deepEqual(readdirSync(join(app.dir, 'home', 'files')), [], 'no orphan upload folder');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, []);
  } finally {
    process.off('unhandledRejection', onRejection);
    await app.close();
  }
});

test('no MCP tool can purge a cluster', async () => {
  const app = await startTestHub();
  try {
    const lists = await toolLists(app.hub, 'f'.repeat(64), `${app.url}/mcp`);
    for (const [profile, list] of Object.entries(lists)) {
      for (const [name, params] of Object.entries(list.tools)) {
        assert.doesNotMatch(`${name} ${params.join(' ')}`, /purge|permanent/i, `${profile}: ${name}`);
      }
    }
  } finally { await app.close(); }
});
