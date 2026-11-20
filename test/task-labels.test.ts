// The global label library (docs/collaboration.md「标签库」): normalization and auto-create on task create/edit,
// required groups, archiving, preset pack, member permissions, rename and merge across clusters, new-cluster
// defaults, the plugin migration, and the HTTP / MCP surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaborationActor, CollaborationCommand } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { PRESET_PACKS } from '../src/plugins/tasks/package/hub/labels.mts';
import { collaborationTask, MIGRATIONS } from '../src/plugins/tasks/package/hub/store.mts';
import { rawFetch, startTestHub, tempDir, type TestHub } from './helpers.ts';

const user: CollaborationActor = { kind: 'user' };
const a: CollaborationActor = { kind: 'member', memberId: 'a' };
const b: CollaborationActor = { kind: 'member', memberId: 'b' };

function fixture(path = ':memory:') {
  const store = new Store(path, new PluginHost(officialPlugins));
  const member = (id: string, clusterId: string) => ({ id, clusterId, name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null });
  for (const [clusterId, members] of [['c', ['a', 'b', 'coord']], ['other', ['x']]] as const) {
    if (!store.getCluster(clusterId, { includeDeleted: true })) {
      store.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' }, members.map((id) => member(id, clusterId)));
    }
  }
  const hub = new Hub({ store, nativeAdapters: {} });
  const send = (actor: CollaborationActor, command: Record<string, unknown>, clusterId = 'c') =>
    hub.collaboration.command(actor, clusterId, { operationId: randomUUID(), ...command } as unknown as CollaborationCommand) as any;
  const create = (labels: string[], actor: CollaborationActor = user, clusterId = 'c', title = 'task') =>
    send(actor, { action: 'task.create', title, scope: 's', acceptance: 'a', memberId: null, labels }, clusterId).task;
  const task = (id: string, clusterId = 'c') => collaborationTask(store, clusterId, id)!;
  const editLabels = (id: string, labels: string[], actor: CollaborationActor = user, clusterId = 'c') =>
    send(actor, { action: 'task.edit', taskId: id, expectedRevision: task(id, clusterId).revision, labels }, clusterId).task;
  const library = () => hub.collaboration.query(user, 'c', { kind: 'labels' }) as any;
  const labelNamed = (name: string) => {
    const view = library();
    return [...view.groups.flatMap((g: any) => g.labels), ...view.ungrouped].find((l: any) => l.name === name);
  };
  return { store, hub, send, create, task, editLabels, library, labelNamed };
}

const invalid = (pattern: RegExp) => (error: any) => error.code === 'INVALID_REQUEST' && pattern.test(error.message);
const forbidden = (error: any) => error.code === 'FORBIDDEN' && /created by someone else/.test(error.message);

test('task labels are trimmed and matched without case to the library; unknown names are created ungrouped by the caller', () => {
  const { store, send, create, library, labelNamed } = fixture();
  try {
    send(user, { action: 'label.create', name: 'Hub' });
    const first = create([' hub ', 'HUB', 'NewThing'], a);
    assert.deepEqual(first.labels, ['Hub', 'NewThing'], 'stored in the library spelling, duplicates dropped');
    const created = labelNamed('NewThing');
    assert.equal(created.groupId, null);
    assert.equal(created.createdBy, 'a', 'the caller created it');
    assert.equal(create(['newthing']).labels[0], 'NewThing', 'the next task reuses it');
    assert.equal(library().ungrouped.filter((l: any) => l.name === 'NewThing').length, 1);
    assert.throws(() => create(['x'.repeat(21)]), invalid(/new label .* must be 1-20 characters/));
    assert.equal(labelNamed('x'.repeat(21)), undefined);
    // A label of a group this cluster did not choose may still be used.
    const group = send(user, { action: 'label.group_create', name: 'Elsewhere' }).group;
    send(user, { action: 'label.create', name: 'far', groupId: group.id });
    assert.deepEqual(create(['FAR']).labels, ['far']);
    // A create that fails later gives back the labels it created.
    assert.throws(() => send(user, { action: 'task.create', title: 't', scope: 's', acceptance: 'a', labels: ['rolled back'], dependencyIds: ['nope'] }));
    assert.equal(labelNamed('rolled back'), undefined);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM task_labels').get() as { n: number }).n, 3);
  } finally { store.close(); }
});

test('a required group the cluster chose needs a label on create, and on edit only when the labels change', () => {
  const { store, send, create, editLabels, task } = fixture();
  try {
    const before = create(['old']);   // no group yet
    const group = send(user, { action: 'label.group_create', name: 'Kind', required: true }).group;
    for (const name of ['k1', 'k2']) send(user, { action: 'label.create', name, groupId: group.id });
    assert.deepEqual(create([]).labels, [], 'not chosen by this cluster: not required');
    send(user, { action: 'label.select_group', groupId: 'kind', selected: true });
    assert.throws(() => create(['other']), invalid(/requires a label from each of these label groups: Kind \(one of: k1, k2\)/));
    assert.deepEqual(create(['K1']).labels, ['k1']);
    assert.deepEqual(create([], user, 'other').labels, [], 'another cluster did not choose it');
    // Editing: other fields, or the same labels, pass on a task from before; changed labels must satisfy the group.
    const titled = (send(user, { action: 'task.edit', taskId: before.id, expectedRevision: before.revision, title: 'renamed' })).task;
    assert.equal(titled.title, 'renamed');
    assert.deepEqual(editLabels(before.id, ['old']).labels, ['old'], 'unchanged labels are not checked');
    assert.throws(() => editLabels(before.id, ['old', 'new']), invalid(/Kind \(one of: k1, k2\)/));
    assert.deepEqual(editLabels(before.id, ['old', 'k2']).labels, ['old', 'k2']);
    assert.equal(task(before.id).labels.length, 2);
    // An empty required group says so.
    const empty = send(user, { action: 'label.group_create', name: 'Empty', required: true }).group;
    send(user, { action: 'label.select_group', groupId: empty.id, selected: true });
    assert.throws(() => create(['k1']), invalid(/Empty \(the group has no labels yet/));
  } finally { store.close(); }
});

test('an archived label cannot be added, but a task keeps it', () => {
  const { store, send, create, editLabels } = fixture();
  try {
    send(user, { action: 'label.create', name: 'old' });
    const kept = create(['old']);
    send(user, { action: 'label.edit', labelId: 'old', archived: true });
    assert.throws(() => create(['OLD']), invalid(/label old is archived/));
    assert.deepEqual(editLabels(kept.id, ['old', 'fresh']).labels, ['old', 'fresh'], 'already on the task: kept');
    const other = create(['fresh']);
    assert.throws(() => editLabels(other.id, ['fresh', 'old']), invalid(/archived/));
    send(user, { action: 'label.edit', labelId: 'old', archived: false });
    assert.deepEqual(editLabels(other.id, ['fresh', 'old']).labels, ['fresh', 'old']);
  } finally { store.close(); }
});

test('the preset pack is added only on request, and adding it again changes nothing', () => {
  const { store, send, library } = fixture();
  try {
    assert.deepEqual(library().groups, [], 'the library starts empty');
    send(user, { action: 'label.create', name: '修复' });   // already there, ungrouped: left alone
    const first = send(a, { action: 'label.add_pack', pack: 'task-types' });
    assert.equal(first.group.name, '任务类型');
    assert.equal(first.group.newClusterDefault, true);
    const view = library();
    assert.equal(view.groups.length, 1);
    assert.deepEqual(view.groups[0].labels.map((l: any) => l.name), ['功能', '改进', '设计', '文档', '测试', '调研']);
    assert.ok(view.groups[0].labels.every((l: any) => l.createdBy === 'a'));
    assert.deepEqual(view.ungrouped.map((l: any) => l.name), ['修复']);
    const again = send(user, { action: 'label.add_pack', pack: 'task-types' });
    assert.equal(again.group.id, first.group.id);
    assert.deepEqual(library(), view, 'nothing changed');
    assert.throws(() => send(user, { action: 'label.add_pack', pack: 'nope' }), invalid(/unknown pack/));
    assert.deepEqual(PRESET_PACKS.map((pack) => pack.id), ['task-types'], 'one pack, generic names only');
  } finally { store.close(); }
});

test('a member deletes or merges away only what it created; the user may do anything', () => {
  const { store, send, labelNamed, library } = fixture();
  try {
    send(a, { action: 'label.create', name: 'A1' });
    send(b, { action: 'label.create', name: 'B1' });
    send(b, { action: 'label.create', name: 'B2' });
    const groupA = send(a, { action: 'label.group_create', name: 'GA' }).group;
    assert.throws(() => send(b, { action: 'label.delete', labelId: 'A1' }), forbidden);
    assert.throws(() => send(b, { action: 'label.merge', labelId: 'A1', intoLabelId: 'B1' }), forbidden);
    assert.throws(() => send(b, { action: 'label.edit', labelId: 'A1', name: 'b1' }), forbidden, 'renaming onto another name merges it away');
    assert.throws(() => send(b, { action: 'label.group_delete', groupId: groupA.id }), forbidden);
    // Anyone may still change it otherwise.
    send(b, { action: 'label.edit', labelId: 'A1', description: 'tidied', color: 3, groupId: 'GA' });
    assert.equal(labelNamed('A1').description, 'tidied');
    send(b, { action: 'label.edit', labelId: 'a1', name: 'A-one' });
    assert.equal(labelNamed('A-one').createdBy, 'a', 'a rename keeps the creator');
    // Merging away its own label into someone else's is fine.
    send(b, { action: 'label.merge', labelId: 'B1', intoLabelId: 'A-one' });
    assert.equal(labelNamed('B1'), undefined);
    send(a, { action: 'label.delete', labelId: 'A-one' });
    send(user, { action: 'label.delete', labelId: 'B2' });
    send(user, { action: 'label.group_delete', groupId: groupA.id });
    assert.deepEqual(library().groups, []);
    assert.deepEqual(library().ungrouped, []);
  } finally { store.close(); }
});

test('deleting a group leaves its labels ungrouped and unchosen everywhere', () => {
  const { store, send, labelNamed, hub } = fixture();
  try {
    const group = send(a, { action: 'label.group_create', name: 'G' }).group;
    send(user, { action: 'label.create', name: 'g1', groupId: group.id });
    send(user, { action: 'label.select_group', groupId: group.id, selected: true });
    send(user, { action: 'label.select_group', groupId: group.id, selected: true }, 'other');
    send(a, { action: 'label.group_delete', groupId: 'g' });
    assert.equal(labelNamed('g1').groupId, null);
    assert.deepEqual((hub.collaboration.query(user, 'other', { kind: 'labels' }) as any).groups, []);
  } finally { store.close(); }
});

test('rename and merge reach every cluster and status without a revision bump, and each cluster records what changed', () => {
  const { store, send, create, task } = fixture();
  try {
    send(user, { action: 'label.create', name: 'Hub' });
    const here = create(['Hub', 'keep']);
    const closed = create(['Hub']);
    send(user, { action: 'task.cancel', taskId: closed.id, expectedRevision: closed.revision, reason: 'no' });
    const there = create(['x', 'Hub'], user, 'other');
    // A label from before the library, spelled another way.
    store.db.prepare("UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.labels', json('[\"hub\"]')) WHERE id = ?").run(closed.id);
    const untouched = create(['keep']);
    const revisions = [here, closed, there, untouched].map((t) => task(t.id, t.clusterId).revision);

    const result = send(a, { action: 'label.edit', labelId: 'hub', name: 'Core' });
    assert.equal(result.affectedTasks, 3);
    assert.equal(result.affectedClusters, 2);
    assert.deepEqual(task(here.id).labels, ['Core', 'keep']);
    assert.deepEqual(task(closed.id).labels, ['Core'], 'a closed task and another spelling are renamed too');
    assert.deepEqual(task(there.id, 'other').labels, ['x', 'Core']);
    assert.deepEqual([here, closed, there, untouched].map((t) => task(t.id, t.clusterId).revision), revisions, 'no revision changes');
    const own = store.getEvent(result.eventId)!.payload as any;
    assert.equal(own.from, 'Hub');
    assert.equal(own.to, 'Core');
    assert.deepEqual(own.affected.map((t: any) => t.taskId).sort(), [here.id, closed.id].sort());
    const foreign = store.listEvents(0).filter((e) => e.clusterId === 'other' && (e.payload as any)?.action === 'label.edit');
    assert.equal(foreign.length, 1, 'the other cluster gets its own event');
    const payload = foreign[0].payload as any;
    assert.deepEqual(payload.affected, [{ taskId: there.id, number: there.number, before: ['x', 'Hub'], after: ['x', 'Core'] }]);
    assert.equal(payload.originEventId, result.eventId);
    assert.equal(payload.by, 'a');
    // The event is enough to undo it by hand.
    for (const item of [...own.affected, ...payload.affected]) {
      store.db.prepare("UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.labels', json(?)) WHERE id = ?").run(JSON.stringify(item.before), item.taskId);
    }
    assert.deepEqual(task(closed.id).labels, ['hub']);
    assert.deepEqual(task(there.id, 'other').labels, ['x', 'Hub']);

    // Merge: the two labels on one task become one.
    send(user, { action: 'label.create', name: 'A' });
    const both = create(['A', 'Core', 'z']);
    const merged = send(user, { action: 'label.merge', labelId: 'A', intoLabelId: 'core' });
    assert.equal(merged.label.name, 'Core');
    assert.deepEqual(task(both.id).labels, ['Core', 'z']);
    const mergedEvent = store.getEvent(merged.eventId)!.payload as any;
    assert.equal(mergedEvent.merged, true);
    assert.deepEqual(mergedEvent.affected, [{ taskId: both.id, number: both.number, before: ['A', 'Core', 'z'], after: ['Core', 'z'] }]);
    // Renaming onto an existing name merges.
    send(user, { action: 'label.create', name: 'B' });
    const onB = create(['B']);
    const renamed = send(user, { action: 'label.edit', labelId: 'B', name: 'core' });
    assert.equal(renamed.removedLabelId !== undefined, true);
    assert.deepEqual(task(onB.id).labels, ['Core']);
  } finally { store.close(); }
});

test('new label and group names may not contain a comma; a comma label already on a task is kept', () => {
  const { store, send, create, editLabels, task, labelNamed } = fixture();
  try {
    const comma = invalid(/must not contain a comma \(, or ，\)/);
    assert.throws(() => send(user, { action: 'label.create', name: 'a,b' }), comma);
    assert.throws(() => send(user, { action: 'label.group_create', name: 'x，y' }), comma);
    send(user, { action: 'label.create', name: 'plain' });
    assert.throws(() => send(user, { action: 'label.edit', labelId: 'plain', name: 'pl,ain' }), comma, 'rename');
    assert.throws(() => create(['p,q'], a), comma, 'auto-create on task.create');
    const legacy = create(['plain']);
    store.db.prepare("UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.labels', json(?)) WHERE id = ?")
      .run(JSON.stringify(['alpha,beta', 'plain']), legacy.id);
    assert.throws(() => editLabels(legacy.id, ['alpha,beta', 'plain', 'p，q']), comma, 'auto-create on task.edit');
    const titled = send(user, { action: 'task.edit', taskId: legacy.id, expectedRevision: task(legacy.id).revision, title: 'only the title' }).task;
    assert.deepEqual(titled.labels, ['alpha,beta', 'plain'], 'a title edit leaves the labels');
    assert.deepEqual(editLabels(legacy.id, ['alpha,beta', 'plain', 'new']).labels, ['alpha,beta', 'plain', 'new'], 'the old comma label stays on edit');
    assert.equal(labelNamed('alpha'), undefined);
    assert.equal(labelNamed('alpha,beta'), undefined, 'and is not pulled into the library');
  } finally { store.close(); }
});

test('usage and the affected list count a task once when an old task carries two spellings of a label', () => {
  const { store, send, create, library } = fixture();
  try {
    const old = create(['x']);
    store.db.prepare("UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.labels', json(?)) WHERE id = ?")
      .run(JSON.stringify(['Hub', 'hub']), old.id);   // allowed before the library
    send(user, { action: 'label.create', name: 'Hub' });
    assert.deepEqual(library().ungrouped.find((l: any) => l.name === 'Hub').usage, { tasks: 1, clusters: 1 });
    const renamed = send(user, { action: 'label.edit', labelId: 'Hub', name: 'Core' });
    assert.equal(renamed.affectedTasks, 1);
    assert.deepEqual((store.getEvent(renamed.eventId)!.payload as any).affected,
      [{ taskId: old.id, number: old.number, before: ['Hub', 'hub'], after: ['Core'] }]);
  } finally { store.close(); }
});

test('labels a task command creates are signalled after the task event, in the order a live page keeps them', async () => {
  const { store, hub, send, create, task } = fixture();
  const labels = await import(new URL('../src/web/public/workbench-labels.js', import.meta.url).href);
  try {
    const published: any[] = [];
    hub.subscribe((event) => published.push(event));
    // What app.applyEvent does: an event at or below the newest seq seen is dropped.
    const kept = () => { let last = 0; return published.filter((event) => (event.seq > last ? (last = event.seq, true) : false)); };
    const made = create(['AutoFresh']);
    assert.deepEqual(published.map((e) => e.seq), [...published.map((e) => e.seq)].sort((x, y) => x - y), 'published in seq order');
    assert.equal(kept().length, published.length, 'nothing is dropped');
    const createSignal = published.filter((e) => labels.isLibrarySignal(e));
    assert.deepEqual(createSignal.map((e) => e.payload.source), ['task.create']);
    assert.ok(createSignal[0].seq > published.find((e) => e.payload?.action === 'task.create').seq);
    published.length = 0;
    send(user, { action: 'task.edit', taskId: made.id, expectedRevision: task(made.id).revision, labels: ['AutoFresh', 'Fresher'] });
    assert.deepEqual(published.map((e) => e.seq), [...published.map((e) => e.seq)].sort((x, y) => x - y));
    assert.equal(kept().length, published.length);
    assert.deepEqual(kept().filter((e) => labels.isLibrarySignal(e)).map((e) => e.payload.source), ['task.edit'], 'the page reloads the library');
    assert.ok(published.at(-1).payload.action === 'label.library', 'the signal comes last');
  } finally { store.close(); }
});

test('a coordinator suggestion creates no labels', () => {
  const { store, send, labelNamed } = fixture();
  try {
    const policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'suggest' }).coordinator;
    const result = send({ kind: 'member', memberId: 'coord' }, { action: 'task.create', title: 't', scope: 's', acceptance: 'a',
      labels: ['suggested'], generation: policy.generation });
    assert.ok(result.suggestion);
    assert.equal(labelNamed('suggested'), undefined);
  } finally { store.close(); }
});

test('migration: a step-2 database gets an empty library, no chosen groups, and keeps its task labels; a new one starts at the last step', () => {
  const path = join(tempDir(), 'labels.db');
  let f = fixture(path);
  const old = f.create(['legacy']);
  f.store.db.prepare("UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.labels', json(?)) WHERE id = ?")
    .run(JSON.stringify(['legacy', 'Mixed Case', 'a label longer than twenty characters']), old.id);
  f.store.db.exec(`DROP TABLE cluster_label_groups; DROP TABLE task_labels; DROP TABLE task_label_groups;
    UPDATE plugin_migrations SET version = 2 WHERE plugin_id = 'tasks';`);
  f.store.close();
  f = fixture(path);
  try {
    assert.equal((f.store.db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'tasks'").get() as { version: number }).version, MIGRATIONS.length);
    for (const table of ['task_label_groups', 'task_labels', 'cluster_label_groups']) {
      assert.equal((f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} is empty`);
    }
    assert.deepEqual(f.task(old.id).labels, ['legacy', 'Mixed Case', 'a label longer than twenty characters']);
    // The old task edits as before: its labels are kept, not pulled into the library.
    assert.deepEqual(f.editLabels(old.id, ['legacy', 'Mixed Case', 'a label longer than twenty characters']).labels,
      ['legacy', 'Mixed Case', 'a label longer than twenty characters']);
    assert.deepEqual(f.library().ungrouped, []);
    f.store.transaction(() => f.store.db.exec(MIGRATIONS[2]));   // running it again is harmless
  } finally { f.store.close(); }
  const fresh = new Store(':memory:', new PluginHost(officialPlugins));
  try {
    assert.equal((fresh.db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'tasks'").get() as { version: number }).version, MIGRATIONS.length);
  } finally { fresh.close(); }
});

test('HTTP: POST /api/labels changes the library without a cluster, by the same rules, and only for the user', async () => {
  const app = await startTestHub();
  try {
    const { cluster: one } = await app.cluster('one', ['A']);
    const { cluster: two } = await app.cluster('two', ['B']);
    const post = (body: Record<string, unknown>) => app.api('POST', '/api/labels', body);
    const task = (clusterId: string, labels: string[]) => app.api('POST', `/api/clusters/${clusterId}/collaboration`,
      { operationId: randomUUID(), action: 'task.create', title: 't', scope: 's', acceptance: 'a', memberId: null, labels });
    const seen = app.events.length;
    // Each command, with the same results as through a cluster.
    const group = (await post({ action: 'label.group_create', name: 'Area', required: true })).group;
    assert.equal(group.createdBy, 'user');
    assert.equal((await post({ action: 'label.group_edit', groupId: 'area', description: 'where' })).group.description, 'where');
    const label = (await post({ action: 'label.create', name: 'Hub', groupId: group.id, color: 2 })).label;
    assert.equal(label.color, 2);
    await post({ action: 'label.create', name: 'Spare' });
    assert.equal((await post({ action: 'label.add_pack', pack: 'task-types' })).group.name, '任务类型');
    await assert.rejects(post({ action: 'label.create', name: 'hub' }), /400.*already exists/, 'the same rules');
    await assert.rejects(post({ action: 'label.select_group', groupId: group.id, selected: true }), /400.*action must be one of/,
      'choosing groups belongs to a cluster');
    await assert.rejects(post({ action: 'task.create' }), /400.*action must be one of/);
    await assert.rejects(post({ action: 'label.create', name: 'x'.repeat(21) }), /400.*1-20 characters/);
    // Rename and merge: each affected cluster gets its own event, none is the origin.
    const first = (await task(one.id, ['Hub'])).task;
    const second = (await task(two.id, ['hub', 'Spare'])).task;
    const renamed = await post({ action: 'label.edit', labelId: label.id, name: 'Core' });
    assert.deepEqual([renamed.affectedTasks, renamed.affectedClusters], [2, 2]);
    const renameEvents = app.store.listEvents(0).filter((e) => (e.payload as any)?.action === 'label.edit' && (e.payload as any).to === 'Core');
    assert.deepEqual(renameEvents.map((e) => e.clusterId).sort(), [one.id, two.id].sort());
    for (const event of renameEvents) {
      const payload = event.payload as any;
      assert.equal('originClusterId' in payload, false, 'no origin cluster');
      assert.equal(payload.by, 'user');
      assert.equal(payload.affected.length, 1);
    }
    const merged = await post({ action: 'label.merge', labelId: 'Spare', intoLabelId: 'core' });
    assert.equal(merged.label.name, 'Core');
    const labelsOf = async (clusterId: string, id: string) => (await app.api('GET', `/api/clusters/${clusterId}/tasks/${id}`)).task.labels;
    assert.deepEqual(await labelsOf(one.id, first.id), ['Core']);
    assert.deepEqual(await labelsOf(two.id, second.id), ['Core']);
    await post({ action: 'label.delete', labelId: 'core' });
    assert.deepEqual(await labelsOf(two.id, second.id), ['Core'], 'delete keeps the text on tasks');
    await post({ action: 'label.group_delete', groupId: group.id });
    assert.deepEqual((await app.api('GET', '/api/labels')).groups.map((g: any) => g.name), ['任务类型']);
    // Every change also broadcasts one cluster-less signal, so open pages reload the library.
    const signals = app.events.slice(seen).filter((e) => e.kind === 'collaboration' && e.clusterId === null);
    assert.equal(signals.length, 9, 'one per successful library change (group_create, group_edit, 2 creates, pack, rename, merge, delete, group_delete)');
    assert.ok(signals.every((e) => (e.payload as any).action === 'label.library'));
    // Only the user: without the page's token the route answers 401.
    assert.equal((await rawFetch(`${app.url}/api/labels`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'label.create', name: 'sneaky' }) })).status, 401);
    // The cluster route signals too, except for choosing a cluster's groups.
    const before = app.events.length;
    await app.api('POST', `/api/clusters/${one.id}/collaboration`, { operationId: 'c1', action: 'label.create', name: 'viaCluster' });
    const pack = (await app.api('GET', '/api/labels')).groups[0];
    await app.api('POST', `/api/clusters/${one.id}/collaboration`, { operationId: 'c2', action: 'label.select_group', groupId: pack.id, selected: false });
    await task(one.id, ['viaCluster']);   // nothing new for the library: no signal
    await task(one.id, ['Fresh', 'Fresher']);   // two labels created by a task: one signal
    assert.deepEqual(app.events.slice(before).filter((e) => e.clusterId === null).map((e) => (e.payload as any).source), ['label.create', 'task.create']);
  } finally { await app.close(); }
});

const NATIVE = (name: string, sessionId: string) => ({ harness: 'mock', sessionId, name });

test('HTTP: the library route, label actions through the collaboration route, and new-cluster defaults', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('first', ['A']);
    const post = (body: Record<string, unknown>, clusterId = cluster.id) =>
      app.api('POST', `/api/clusters/${clusterId}/collaboration`, { operationId: randomUUID(), ...body });
    const pack = await post({ action: 'label.add_pack', pack: 'task-types' });
    const own = await post({ action: 'label.group_create', name: 'Mine', required: true });
    await post({ action: 'label.create', name: 'm1', groupId: own.group.id });
    await post({ action: 'task.create', title: 't', scope: 's', acceptance: 'a', labels: ['功能', 'free'] });
    const listed = await app.api('GET', '/api/labels');
    assert.deepEqual(listed.groups.map((g: any) => g.name), ['任务类型', 'Mine']);
    assert.deepEqual(listed.groups[0].labels.find((l: any) => l.name === '功能').usage, { tasks: 1, clusters: 1 });
    assert.equal('selected' in listed.groups[0], false, 'the global route is not about a cluster');
    assert.deepEqual(listed.ungrouped.map((l: any) => l.name), ['free']);
    // The first cluster existed before the groups: nothing chosen.
    const workspace = await app.api('GET', `/api/clusters/${cluster.id}/workspace`);
    assert.deepEqual(workspace.labelLibrary.groups.map((g: any) => g.selected), [false, false]);
    assert.deepEqual(workspace.labels, ['free', '功能'], 'labels in use stay for the filter');
    // A new cluster chooses the groups marked for new clusters: the pack's, not the user's own group.
    const { cluster: second } = await app.cluster('second', ['B']);
    const fresh = await app.api('GET', `/api/clusters/${second.id}/workspace`);
    assert.deepEqual(fresh.labelLibrary.groups.map((g: any) => [g.name, g.selected]), [['任务类型', true], ['Mine', false]]);
    await post({ action: 'label.group_edit', groupId: own.group.id, newClusterDefault: true });
    const { cluster: third } = await app.cluster('third', ['C']);
    await assert.rejects(post({ action: 'task.create', title: 't', scope: 's', acceptance: 'a', labels: ['功能'] }, third.id), /Mine \(one of: m1\)/);
    assert.equal(pack.group.id, listed.groups[0].id);
  } finally { await app.close(); }
});

/** A tools/call from a native mock conversation. */
async function callTool(app: TestHub, name: string, args: Record<string, unknown>, session: string) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const response = await fetch(`${app.url}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-harness': 'mock', 'x-orrery-session': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const { result } = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: result.isError === true, text: result.content[0].text };
}

test('MCP: manage_labels and list_labels for members, and list_tasks include labels returns this cluster’s groups', async () => {
  const app = await startTestHub();
  try {
    const [sa, sb] = ['s1', 's2'];
    const { cluster } = await app.hub.createCluster('mcp', [NATIVE('A', sa), NATIVE('B', sb)]);
    const ok = async (name: string, args: Record<string, unknown>, session = sa) => {
      const r = await callTool(app, name, args, session);
      assert.equal(r.isError, false, r.text);
      return JSON.parse(r.text);
    };
    const group = (await ok('manage_labels', { operationId: 'g', action: 'create_group', name: 'Area', required: true, description: 'which part' })).group;
    await ok('manage_labels', { operationId: 'l1', action: 'create', name: 'front', groupId: 'Area' });
    await ok('manage_labels', { operationId: 'l2', action: 'create', name: 'back', groupId: group.id, description: 'server side' });
    await ok('manage_labels', { operationId: 'l3', action: 'create', name: 'gone', groupId: 'Area' });
    await ok('manage_labels', { operationId: 'l4', action: 'edit', labelId: 'gone', archived: true });
    await ok('manage_labels', { operationId: 's', action: 'select_group', groupId: 'area', selected: true });
    await ok('manage_labels', { operationId: 'p', action: 'add_pack', pack: 'task-types' });
    const refused = await callTool(app, 'manage_labels', { operationId: 'd', action: 'delete', labelId: 'front' }, sb);
    assert.ok(refused.isError && /created by someone else/.test(refused.text), refused.text);
    const missing = await callTool(app, 'create_task', { operationId: 't0', title: 't', scope: 's', acceptance: 'a', labels: ['other'] }, sa);
    assert.ok(missing.isError && /Area \(one of: front, back\)/.test(missing.text), missing.text);
    const created = await ok('create_task', { operationId: 't1', title: 't', scope: 's', acceptance: 'a', labels: ['Front', 'brand new'] });
    assert.deepEqual(created.task.labels, ['front', 'brand new']);
    const catalog = (await ok('list_tasks', { include: ['labels'] })).labels;
    assert.deepEqual(catalog, {
      groups: [{ name: 'Area', description: 'which part', required: true, labels: [{ name: 'front' }, { name: 'back', description: 'server side' }] }],
      ungrouped: [{ name: 'brand new' }],
    }, 'only the chosen group, archived labels left out, plus ungrouped');
    const library = await ok('list_labels', {});
    assert.deepEqual(library.groups.map((g: any) => [g.name, g.selected]), [['Area', true], ['任务类型', false]]);
    assert.deepEqual(library.groups[0].labels.find((l: any) => l.name === 'front').usage, { tasks: 1, clusters: 1 });
    assert.equal(cluster.id.length > 0, true);
  } finally { await app.close(); }
});
