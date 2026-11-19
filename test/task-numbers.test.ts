// Per-cluster task numbers (#12, docs/collaboration.md): assignment in the create transaction, the plugin migration
// that numbers old tasks, the reads that carry the number, and the one resolver for task references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CollaborationActor, CollaborationCommand, ContextResult, TaskResult, WorkspaceResult } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { collaborationTask, MIGRATIONS, saveCollaborationTask } from '../src/plugins/tasks/store.ts';
import { taskSummary } from '../src/plugins/tasks/tools.ts';
import { bearer, holdScript, startTestHub, tempDir, waitFor, turnsOf, memberHeaders } from './helpers.ts';

const user: CollaborationActor = { kind: 'user' };

function fixture(path = ':memory:', host = new PluginHost(officialPlugins)) {
  const store = new Store(path, host);
  const member = (id: string, clusterId: string) => ({ id, clusterId, name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null });
  for (const [clusterId, members] of [['c', ['a', 'coord']], ['other', ['x']], ['empty', []]] as const) {
    if (!store.getCluster(clusterId, { includeDeleted: true })) {
      store.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' }, members.map((id) => member(id, clusterId)));
    }
  }
  const hub = new Hub({ store, nativeAdapters: {} });
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'> & { operationId?: string }, clusterId = 'c') =>
    hub.collaboration.command(actor, clusterId, { operationId: randomUUID(), ...command });
  const create = (title = 'task', extra: Partial<CollaborationCommand> = {}, clusterId = 'c') =>
    send(user, { action: 'task.create', title, scope: 's', acceptance: 'a', memberId: null, ...extra }, clusterId).task!;
  const counter = (clusterId: string) =>
    (store.db.prepare('SELECT last_number FROM task_counters WHERE cluster_id = ?').get(clusterId) as { last_number: number } | undefined)?.last_number;
  const numbers = (clusterId: string) => (store.db.prepare("SELECT id, json_extract(data_json, '$.number') AS number FROM collaboration_tasks WHERE cluster_id = ? ORDER BY rowid")
    .all(clusterId) as { id: string; number: number | null }[]).map((row) => [row.id, row.number]);
  /** task.edit by reference; `target` is the task it should reach (for its current revision), none for a refusal. */
  const edit = (taskId: string, target?: { id: string }) => send(user, { action: 'task.edit', taskId,
    expectedRevision: target ? collaborationTask(store, 'c', target.id)!.revision : 1, title: 'edited' });
  return { store, hub, send, create, counter, numbers, edit };
}

const refusal = (pattern: RegExp) => (error: any) => error.code === 'OUT_OF_SCOPE' && pattern.test(error.message)
  && /#number \(e\.g\. #12\), its full ID, or a unique prefix of its ID of at least 8 characters/.test(error.message);

test('numbers start at 1 per cluster, follow each other, and stay with the task', () => {
  const { store, create, counter } = fixture();
  try {
    const first = create('first'); const second = create('second');
    assert.deepEqual([first.number, second.number], [1, 2]);
    assert.equal(create('elsewhere', {}, 'other').number, 1, 'another cluster counts on its own');
    assert.equal(create('third').number, 3);
    assert.deepEqual([counter('c'), counter('other'), counter('empty')], [3, 1, undefined]);
    assert.equal(collaborationTask(store, 'c', first.id)!.number, 1, 'stored in the task JSON');
  } finally { store.close(); }
});

test('a failed create gives its number back: refused before or after the number is taken', () => {
  const { store, hub, send, create, counter } = fixture();
  try {
    create('one');
    assert.throws(() => send(user, { action: 'task.create', title: '', scope: 's', acceptance: 'a' }), /title is required/);
    // Fail after the task was saved with its number: the event write is the next step of the same transaction.
    const append = store.appendCollaborationEvent;
    store.appendCollaborationEvent = () => { throw new Error('disk full'); };
    try {
      assert.throws(() => send(user, { action: 'task.create', title: 'lost', scope: 's', acceptance: 'a' }), /disk full/);
    } finally { store.appendCollaborationEvent = append; }
    assert.equal(counter('c'), 1, 'the counter rolled back');
    assert.equal((hub.collaboration.query(user, 'c', { kind: 'workspace' }) as WorkspaceResult).tasks.length, 1, 'the task rolled back');
    assert.equal(create('two').number, 2, 'no number was skipped');
  } finally { store.close(); }
});

test('a suggestion takes no number, and a retried operationId takes none again', () => {
  const { store, send, create, counter } = fixture();
  try {
    create('one');
    const policy = send(user, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'suggest' }).coordinator!;
    const suggestion = send({ kind: 'member', memberId: 'coord' }, { action: 'task.create', title: 'idea', scope: 's', acceptance: 'a', generation: policy.generation });
    assert.ok(suggestion.suggestion);
    assert.equal(suggestion.task, undefined);
    assert.equal(counter('c'), 1, 'suggest mode leaves the counter');

    const command = { action: 'task.create', operationId: 'same', title: 'retried', scope: 's', acceptance: 'a' } as const;
    const first = send(user, command);
    const again = send(user, command);
    assert.equal(first.task!.number, 2);
    assert.deepEqual(again, first, 'the retry replays the stored result');
    assert.equal(counter('c'), 2);
    assert.equal(create('next').number, 3);
  } finally { store.close(); }
});

test('a permanently deleted task keeps its number used', () => {
  const { store, send, create, edit } = fixture();
  try {
    create('one');
    let gone = create('two');
    gone = send(user, { action: 'task.cancel', taskId: gone.id, expectedRevision: gone.revision, reason: 'not needed' }).task!;
    send(user, { action: 'task.delete', taskId: gone.id, expectedRevision: gone.revision });
    assert.equal(create('three').number, 3, 'number 2 is not given again');
    assert.throws(() => edit('#2'), refusal(/unknown task in this cluster: there is no task #2/));
  } finally { store.close(); }
});

test('the database refuses two tasks with the same number in one cluster', () => {
  const { store, create } = fixture();
  try {
    const one = create('one');
    assert.throws(() => saveCollaborationTask(store, { ...one, id: 'copy' }), /UNIQUE constraint failed/);
    saveCollaborationTask(store, { ...one, id: 'copy', clusterId: 'other' });   // another cluster may have its own #1
  } finally { store.close(); }
});

test('every task read carries the number: workspace, task, context, dependencies and the MCP summary', () => {
  const { store, hub, create } = fixture();
  try {
    const dependency = create('dependency');
    const task = create('dependent', { dependencyIds: [dependency.id] });
    assert.equal(task.number, 2, 'the create result');
    const workspace = hub.collaboration.query(user, 'c', { kind: 'workspace' }) as WorkspaceResult;
    assert.deepEqual(workspace.tasks.map((t) => t.number), [1, 2]);
    assert.deepEqual(workspace.tasks.map((t) => taskSummary(t).number), [1, 2], 'list_tasks summaries');
    const detail = hub.collaboration.query(user, 'c', { kind: 'task', taskId: task.id }) as TaskResult;
    assert.equal(detail.task.number, 2);
    assert.equal(taskSummary(detail.dependencies[0]).number, 1, 'get_task dependencies');
    const context = hub.collaboration.query(user, 'c', { kind: 'context', taskId: task.id }) as ContextResult;
    assert.equal(context.task.number, 2);
    assert.equal(taskSummary(context.dependencies[0]).number, 1, 'get_task_context dependencies');
  } finally { store.close(); }
});

test('task references: #number, a full ID or a unique 8+ prefix; everything else is refused naming the three forms', () => {
  const { store, send, create, edit } = fixture();
  try {
    const one = create('one'); const two = create('two');
    for (const title of ['a', 'b', 'c']) create(title);
    for (let i = 0; i < 10; i++) create('elsewhere ' + i, {}, 'other');   // other: #1..#10; c ends at #7 below
    assert.equal(edit('#2', two).task!.id, two.id, '#number');
    assert.equal(edit(two.id, two).task!.id, two.id, 'full ID');
    assert.equal(edit(two.id.slice(0, 8), two).task!.id, two.id, '8-character prefix');
    assert.deepEqual(create('deps', { dependencyIds: ['#1', two.id.slice(0, 8)] }).dependencyIds, [one.id, two.id], 'dependencyIds');
    let dup = create('dup');
    dup = send(user, { action: 'task.cancel', taskId: `#${dup.number}`, expectedRevision: dup.revision, reason: 'same',
      closeReason: 'duplicate', relatedTaskId: '#1' }).task!;
    assert.deepEqual(dup.closeReason, { kind: 'duplicate', taskId: one.id }, 'relatedTaskId');

    for (const ref of ['#', '#abc', '#0', '#00', '#01', '#-1', '#1.5', '# 1', '#1 ', '#1#', '#99999999999999999999']) {
      const literal = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.throws(() => edit(ref), refusal(new RegExp(`unknown task in this cluster: ${literal} is not a task number`)), ref);
    }
    assert.throws(() => edit('#99'), refusal(/there is no task #99/), 'a number nobody has');
    assert.throws(() => edit('#9'), refusal(/there is no task #9;/), 'a number only another cluster has');
    assert.throws(() => edit('1'), refusal(/prefix 1 matched 0 items \(a prefix needs at least 8 characters\)/), 'a bare number is an ID prefix');
    assert.throws(() => edit('00000000'), refusal(/prefix 00000000 matched 0 items/), 'an unknown prefix');
    assert.throws(() => edit(two.id.slice(0, 7)), refusal(/matched 0 items/), 'a short prefix');
    saveCollaborationTask(store, { ...one, id: 'abcdef12-one', number: 101 });
    saveCollaborationTask(store, { ...one, id: 'abcdef12-two', number: 102 });
    assert.throws(() => edit('abcdef12'), refusal(/prefix abcdef12 matched 2 items/), 'an ambiguous prefix');
    // An 8-digit numeric prefix is still a prefix, never a number.
    saveCollaborationTask(store, { ...one, id: '12345678-0000-4000-8000-000000000000', number: 103 });
    assert.equal(edit('12345678', { id: '12345678-0000-4000-8000-000000000000' }).task!.id, '12345678-0000-4000-8000-000000000000');
    assert.throws(() => edit('#12345678'), refusal(/there is no task #12345678/));
  } finally { store.close(); }
});

/** A database at tasks migration step 1, written by today's code and then stripped of what step 2 adds. */
function stepOneDatabase() {
  const path = join(tempDir(), 'numbers.db');
  const f = fixture(path);
  const tasks = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((title) => [title, f.create(title)]));
  const doomed = f.create('deleted');
  f.create('x1', {}, 'other'); f.create('x2', {}, 'other');
  const cancelled = f.send(user, { action: 'task.cancel', taskId: doomed.id, expectedRevision: doomed.revision, reason: 'gone' }).task!;
  f.send(user, { action: 'task.delete', taskId: doomed.id, expectedRevision: cancelled.revision });
  f.store.deleteCluster('other');   // in the recycle bin: its tasks stay and must be numbered too
  const at = (title: string, createdAt: string | null) => f.store.db.prepare(createdAt === null
    ? "UPDATE collaboration_tasks SET data_json = json_remove(data_json, '$.createdAt') WHERE id = ?"
    : "UPDATE collaboration_tasks SET data_json = json_set(data_json, '$.createdAt', ?) WHERE id = ?")
    .run(...(createdAt === null ? [tasks[title].id] : [createdAt, tasks[title].id]));
  at('A', '2026-01-03T00:00:00.000Z'); at('B', '2026-01-01T00:00:00.000Z');
  at('C', '2026-01-02T00:00:00.000Z'); at('D', '2026-01-02T00:00:00.000Z');   // a tie: inserted order decides, C before D
  at('E', null);                                                            // no createdAt: counts as oldest
  f.store.db.exec(`UPDATE collaboration_tasks SET data_json = json_remove(data_json, '$.number');
    DROP INDEX collaboration_tasks_number; DROP TABLE task_counters;
    UPDATE plugin_migrations SET version = 1 WHERE plugin_id = 'tasks';`);
  f.store.close();
  return { path, tasks };
}

test('migration: old tasks are numbered per cluster by creation time, recycle-bin clusters too, and the counters set', () => {
  const { path, tasks } = stepOneDatabase();
  const f = fixture(path);
  try {
    assert.equal((f.store.db.prepare("SELECT version FROM plugin_migrations WHERE plugin_id = 'tasks'").get() as { version: number }).version, MIGRATIONS.length);
    const byId = Object.fromEntries(f.numbers('c'));
    assert.deepEqual(['E', 'B', 'C', 'D', 'A'].map((title) => byId[tasks[title].id]), [1, 2, 3, 4, 5]);
    assert.deepEqual(f.numbers('other').map(([, n]) => n), [1, 2]);
    assert.deepEqual([f.counter('c'), f.counter('other'), f.counter('empty')], [5, 2, undefined],
      'the deleted task took no number: the highest number is the counter');
    assert.equal(f.create('new').number, 6);
    assert.equal(f.create('first', {}, 'empty').number, 1);
    f.store.restoreCluster('other');
    assert.equal(f.create('x3', {}, 'other').number, 3);
    assert.equal(f.edit('#2', tasks.B).task!.id, tasks.B.id, 'migrated numbers resolve');
  } finally { f.store.close(); }
});

test('migration: a second run and a reopen renumber nothing; a late unnumbered row goes after the counter', () => {
  const { path } = stepOneDatabase();
  let f = fixture(path);
  const before = [f.numbers('c'), f.numbers('other'), f.counter('c'), f.counter('other')];
  f.store.close();
  f = fixture(path);   // reopening runs no step again
  try {
    assert.deepEqual([f.numbers('c'), f.numbers('other'), f.counter('c'), f.counter('other')], before);
    f.store.transaction(() => f.store.db.exec(MIGRATIONS[1]));
    assert.deepEqual([f.numbers('c'), f.numbers('other'), f.counter('c'), f.counter('other')], before, 'running step 2 again changes nothing');
    // Counter ahead of the highest number (the newest tasks were deleted), and a row without a number: it must not reuse.
    f.store.db.prepare("UPDATE task_counters SET last_number = 9 WHERE cluster_id = 'c'").run();
    const row = f.store.db.prepare("SELECT data_json FROM collaboration_tasks WHERE cluster_id = 'c' LIMIT 1").get() as { data_json: string };
    f.store.db.prepare("INSERT INTO collaboration_tasks VALUES ('late', 'c', json_remove(?, '$.number'))").run(row.data_json);
    f.store.transaction(() => f.store.db.exec(MIGRATIONS[1]));
    assert.equal(Object.fromEntries(f.numbers('c')).late, 10);
    assert.equal(f.counter('c'), 10);
  } finally { f.store.close(); }
});

test('HTTP workspace and the MCP task tools carry the number, and MCP task commands accept #number', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [a] } = await app.cluster('numbers', ['A']);
    const web = (body: Record<string, unknown>) => app.api('POST', `/api/clusters/${cluster.id}/collaboration`, body);
    const first = (await web({ operationId: 'h1', action: 'task.create', title: 'first', scope: 's', acceptance: 'a', memberId: null })).task;
    assert.equal(first.number, 1);
    const workspace = await app.api('GET', `/api/clusters/${cluster.id}/workspace`);
    assert.deepEqual(workspace.tasks.map((t: any) => t.number), [1], 'the web workspace, which the all-tasks page also reads');

    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hold' });
    await waitFor(() => turnsOf(app, a.id) > 0, 'member turn');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: memberHeaders(app, a.id) },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text as string;
      assert.equal(result.isError === true, false, text);
      return JSON.parse(text);
    };
    const second = (await call('create_task', { operationId: 'm1', title: 'second', scope: 's', acceptance: 'a', dependencyIds: ['#1'] })).task;
    assert.equal(second.number, 2);
    assert.deepEqual(second.dependencyIds, [first.id], 'create_task dependencyIds accept #number');
    assert.deepEqual((await call('list_tasks', {})).tasks.map((t: any) => t.number), [1, 2]);
    const got = await call('get_task', { taskId: second.id });
    assert.equal(got.task.number, 2);
    assert.equal(got.dependencies[0].number, 1);
    assert.equal((await call('get_task_context', { taskId: second.id })).dependencies[0].number, 1);
    const edited = await call('task_action', { operationId: 'm2', action: 'edit', taskId: '#2', expectedRevision: second.revision, title: 'renamed' });
    assert.equal(edited.task.title, 'renamed', 'task_action taskId accepts #number');
  } finally {
    hold.release();
    await client?.close().catch(() => {});
    await app.close();
  }
});

test('every task-referencing MCP tool accepts #number, full ID and 8+ prefix, keeps 8+ digits as prefixes, and list_tasks q ranks exact number first', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [a] } = await app.cluster('mcp-refs', ['A']);
    const other = (await app.cluster('other', ['B'])).cluster;
    const web = (body: Record<string, unknown>, cid = cluster.id) => app.api('POST', `/api/clusters/${cid}/collaboration`, body);
    const t1 = (await web({ operationId: 'h1', action: 'task.create', title: 'base', scope: 's', acceptance: 'a', memberId: a.id })).task;
    const t2 = (await web({ operationId: 'h2', action: 'task.create', title: 'follow #1 and 2 details', scope: 's', acceptance: 'a', memberId: null })).task;
    const t3 = (await web({ operationId: 'h3', action: 'task.create', title: 'third', scope: 's', acceptance: 'a', memberId: null })).task;
    const f1 = (await web({ operationId: 'hf1', action: 'task.create', title: 'foreign 1', scope: 's', acceptance: 'a', memberId: null }, other.id)).task;
    const f4 = (await web({ operationId: 'hf4', action: 'task.create', title: 'foreign 4', scope: 's', acceptance: 'a', memberId: null }, other.id)).task;
    await web({ operationId: 'hf2', action: 'task.create', title: 'foreign 2', scope: 's', acceptance: 'a', memberId: null }, other.id);
    await web({ operationId: 'hf3', action: 'task.create', title: 'foreign 3', scope: 's', acceptance: 'a', memberId: null }, other.id);
    assert.equal(f1.number, 1);
    assert.ok(f4);

    // 8+ bare digits remain ID prefixes, not numbers.
    saveCollaborationTask(app.store, { ...t1, id: '12345678-0000-4000-8000-000000000001', number: 4, title: 'numeric prefix' });

    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hold' });
    await waitFor(() => turnsOf(app, a.id) > 0, 'member turn');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: memberHeaders(app, a.id) },
    }));
    const raw = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: args });
    const ok = async (name: string, args: Record<string, unknown>) => {
      const result = await raw(name, args);
      const text = (result.content as any)[0].text as string;
      assert.equal(result.isError === true, false, text);
      return JSON.parse(text);
    };
    const err = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
      const result = await raw(name, args);
      const text = (result.content as any)[0].text as string;
      assert.equal(result.isError, true, `${name} should fail: ${text}`);
      assert.match(text, pattern);
    };

    // get_task & get_task_context across all 3 forms + errors
    assert.equal((await ok('get_task', { taskId: '#1' })).task.id, t1.id);
    assert.equal((await ok('get_task', { taskId: t2.id })).task.id, t2.id);
    assert.equal((await ok('get_task', { taskId: t3.id.slice(0, 8) })).task.id, t3.id);
    assert.equal((await ok('get_task', { taskId: '12345678' })).task.id, '12345678-0000-4000-8000-000000000001');
    assert.equal((await ok('get_task_context', { taskId: '#2' })).task.id, t2.id);
    assert.equal((await ok('get_task_context', { taskId: t2.id.slice(0, 8) })).task.id, t2.id);
    await err('get_task', { taskId: '#999' }, /there is no task #999/);
    await err('get_task', { taskId: f1.id }, /unknown task in this cluster/);
    await err('get_task', { taskId: '123456789' }, /matched 0 items/);
    await err('get_task_context', { taskId: '#999' }, /there is no task #999/);

    // raise_attention, resolve_attention, set_task_summary
    const att = await ok('raise_attention', { operationId: 'ra1', taskId: '#1', expectedRevision: t1.revision, kind: 'question', question: 'q?' });
    assert.equal(att.task.id, t1.id);
    const res = await ok('resolve_attention', { operationId: 'ra2', taskId: t1.id.slice(0, 8), expectedRevision: att.task.revision,
      attentionId: att.attention.id, resolution: 'done' });
    assert.equal(res.task.id, t1.id);
    await ok('set_task_summary', { operationId: 'ss1', taskId: '#1', expectedRevision: res.task.revision,
      summary: 'summary ok', throughEventId: res.eventId, sourceMessageIds: [] });
    assert.equal((await ok('get_task_context', { taskId: '#1' })).summary.content, 'summary ok');
    await err('raise_attention', { operationId: 'ra3', taskId: '#99', expectedRevision: 1, kind: 'question', question: 'q?' }, /there is no task #99/);
    await err('set_task_summary', { operationId: 'ss2', taskId: '#99', expectedRevision: 1,
      summary: 'x', throughEventId: 1, sourceMessageIds: [] }, /there is no task #99/);

    // send_message taskIds & link_message_tasks taskIds / removeTaskIds
    const sent = await ok('send_message', { body: 'hello refs', taskIds: ['#1', t2.id.slice(0, 8)] });
    assert.deepEqual(sent.taskIds.sort(), [t1.id, t2.id].sort());
    await err('send_message', { body: 'bad ref', taskIds: ['#99'] }, /there is no task #99/);
    await err('send_message', { body: 'foreign uuid', taskIds: [f1.id] }, /unknown task in this cluster/);

    const linked = await ok('link_message_tasks', { operationId: 'lm1', messageId: sent.messageId, taskIds: ['#3'], removeTaskIds: ['#1', t2.id.slice(0, 8)], reason: 'relink' });
    assert.equal(linked.messageId, sent.messageId);
    const read = await ok('read_messages', { history: true, limit: 10 });
    const msg = read.find((m: any) => m.id === sent.messageId);
    assert.deepEqual(msg.taskIds, [t3.id]);
    await err('link_message_tasks', { operationId: 'lm2', messageId: sent.messageId, removeTaskIds: ['#99'], reason: 'bad' }, /there is no task #99/);

    // list_tasks q: #N and bare digits exact match number & sort first
    const byHash = (await ok('list_tasks', { q: '#1' })).tasks;
    assert.equal(byHash[0].number, 1, 'exact #1 hit sorts before #2 whose title mentions #1');
    assert.deepEqual(byHash.map((t: any) => t.number), [1, 2]);
    const byDigits = (await ok('list_tasks', { q: '1' })).tasks;
    assert.equal(byDigits[0].number, 1, 'exact digit match #1 sorts first');
    const byTwo = (await ok('list_tasks', { q: '2' })).tasks;
    assert.equal(byTwo[0].number, 2);

    // task-refs HTTP endpoint: numbers=..., q=..., includeClosed=1
    const closed = await web({ operationId: 'hc1', action: 'task.cancel', taskId: `#${t3.number}`, expectedRevision: t3.revision,
      closeReason: 'not_planned' });
    assert.equal(closed.task.status, 'cancelled');
    const refsByNum = await app.api('GET', `/api/clusters/${cluster.id}/task-refs?numbers=1,3,99`);
    assert.deepEqual(refsByNum.tasks.map((t: any) => ({ id: t.id, number: t.number, title: t.title, status: t.status })), [
      { id: t1.id, number: 1, title: 'base', status: 'pending' },
      { id: t3.id, number: 3, title: 'third', status: 'cancelled' },
    ]);
    const openCandidates = await app.api('GET', `/api/clusters/${cluster.id}/task-refs?q=3`);
    assert.equal(openCandidates.tasks.some((t: any) => t.id === t3.id), false, 'default candidates exclude closed tasks');
    const allCandidates = await app.api('GET', `/api/clusters/${cluster.id}/task-refs?q=3&includeClosed=1`);
    assert.equal(allCandidates.tasks[0].id, t3.id, 'includeClosed=1 includes cancelled task first on #/digit match');
  } finally {
    hold.release();
    await client?.close().catch(() => {});
    await app.close();
  }
});
