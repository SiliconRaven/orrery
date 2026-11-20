import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { taskSummary } from '../src/plugins/tasks/package/hub/tools.mts';
import { bearer, holdScript, startTestHub, waitFor, turnsOf, memberHeaders } from './helpers.ts';

async function fixture() {
  const app = await startTestHub();
  const { cluster, members: [a, b] } = await app.cluster('close', ['A', 'B']);
  const { cluster: elsewhere } = await app.cluster('elsewhere', ['X']);
  let serial = 0;
  const send = (actor: unknown, command: Record<string, unknown>, clusterId = cluster.id) =>
    app.hub.collaboration.command(actor as never, clusterId, { operationId: `close-${++serial}`, ...command } as never) as any;
  const user = { kind: 'user' };
  const create = (title: string, clusterId = cluster.id) =>
    send(user, { action: 'task.create', title, scope: 's', acceptance: 'a', memberId: null }, clusterId).task;
  const get = (taskId: string) => (app.hub.collaboration.query(user as never, cluster.id, { kind: 'task', taskId }) as any).task;
  const cancel = (task: any, extra: Record<string, unknown> = {}, actor: unknown = user) =>
    send(actor, { action: 'task.cancel', taskId: task.id, expectedRevision: get(task.id).revision, reason: 'why', ...extra });
  const notice = (eventId: number) => app.store.listMessages(cluster.id, 200).find((m) => m.kind === 'system' && m.collabEventId === eventId);
  return { app, cluster, elsewhere, a, b, send, user, create, get, cancel, notice };
}

test('cancel stores each close reason on the task and in the event, and reopen clears it', async () => {
  const { app, cluster, create, get, cancel, send, user } = await fixture();
  try {
    const target = create('the real one');
    const kinds = [
      ['not_planned', {}, { kind: 'not_planned' }],
      ['duplicate', { relatedTaskId: target.id }, { kind: 'duplicate', taskId: target.id }],
      ['superseded', { relatedTaskId: target.id.slice(0, 8) }, { kind: 'superseded', taskId: target.id }],
      ['other', {}, { kind: 'other' }],
    ] as const;
    for (const [kind, extra, stored] of kinds) {
      const task = create(kind);
      const result = cancel(task, { closeReason: kind, ...extra });
      assert.deepEqual(result.task.closeReason, stored, `${kind} is returned`);
      assert.deepEqual(get(task.id).closeReason, stored, `${kind} is stored`);
      assert.deepEqual((app.store.getEvent(result.eventId)!.payload as any).closeReason, stored, `${kind} is in the event`);
      assert.equal((app.store.getEvent(result.eventId)!.payload as any).reason, 'why', 'the free-text reason stays');
      const listed = (app.hub.collaboration.query(user as never, cluster.id, { kind: 'workspace', status: 'cancelled' }) as any).tasks;
      assert.deepEqual(listed.find((t: any) => t.id === task.id).closeReason, stored, 'the workspace list carries it');
      assert.deepEqual(taskSummary(result.task).closeReason, stored, 'the MCP summary carries it');
    }
    const plain = create('plain');
    const defaulted = cancel(plain);
    assert.deepEqual(defaulted.task.closeReason, { kind: 'other' }, 'left out, the reason is other');
    const reopened = send(user, { action: 'task.reopen', taskId: plain.id, expectedRevision: defaulted.task.revision, reason: 'back' });
    assert.equal('closeReason' in reopened.task, false, 'reopen clears it');
    assert.equal('closeReason' in get(plain.id), false);
    assert.equal('closeReason' in taskSummary(reopened.task), false, 'an open task summary has no closeReason');
  } finally { await app.close(); }
});

test('the cancel notice names the close reason and the related task', async () => {
  const { app, a, b, create, cancel, send, user, notice } = await fixture();
  try {
    const target = create('the real one');
    const cases = [
      [{ closeReason: 'not_planned' }, /任务 #2【t0】已取消（不做了）（原因：why），事件 \d+。/],
      [{ closeReason: 'duplicate', relatedTaskId: target.id }, /任务 #3【t1】已取消（重复，见任务 #1【the real one】）（原因：why），事件 \d+。/],
      [{ closeReason: 'superseded', relatedTaskId: target.id }, /任务 #4【t2】已取消（被取代，见任务 #1【the real one】）（原因：why），事件 \d+。/],
      [{ closeReason: 'other' }, /任务 #5【t3】已取消（原因：why），事件 \d+。/],
      [{}, /任务 #6【t4】已取消（原因：why），事件 \d+。/],
    ] as const;
    for (const [i, [extra, body]] of cases.entries()) {
      // A member reviewer hears about a cancel (unread), so there is a notice to read.
      const task = send(user, { action: 'task.create', title: `t${i}`, scope: 's', acceptance: 'a', memberId: a.id,
        reviewer: { kind: 'member', memberId: b.id } }).task;
      const result = cancel(task, extra);
      assert.match(notice(result.eventId)!.body, body);
    }
  } finally { await app.close(); }
});

test('cancel refuses a bad close reason and changes nothing', async () => {
  const { app, cluster, elsewhere, create, get, cancel } = await fixture();
  try {
    const task = create('keep');
    const other = create('other');
    const foreign = create('foreign', elsewhere.id);
    const refusals = [
      [{ closeReason: 'duplicate' }, /relatedTaskId is required when closeReason is duplicate/, 'INVALID_REQUEST'],
      [{ closeReason: 'superseded' }, /relatedTaskId is required when closeReason is superseded/, 'INVALID_REQUEST'],
      [{ closeReason: 'duplicate', relatedTaskId: foreign.id }, /unknown task in this cluster/, 'OUT_OF_SCOPE'],
      [{ closeReason: 'superseded', relatedTaskId: task.id }, /relatedTaskId must name another task/, 'INVALID_REQUEST'],
      [{ closeReason: 'superseded', relatedTaskId: task.id.slice(0, 8) }, /relatedTaskId must name another task/, 'INVALID_REQUEST'],
      [{ closeReason: 'duplicate', relatedTaskId: '00000000-0000-0000-0000-000000000000' }, /unknown task in this cluster/, 'OUT_OF_SCOPE'],
      [{ closeReason: 'not_planned', relatedTaskId: other.id }, /relatedTaskId is only accepted with closeReason duplicate or superseded/, 'INVALID_REQUEST'],
      [{ closeReason: 'other', relatedTaskId: other.id }, /relatedTaskId is only accepted/, 'INVALID_REQUEST'],
      [{ relatedTaskId: other.id }, /relatedTaskId is only accepted/, 'INVALID_REQUEST'],
      [{ closeReason: 'wontfix' }, /closeReason must be not_planned, duplicate, superseded or other/, 'INVALID_REQUEST'],
    ] as const;
    const before = JSON.stringify(get(task.id));
    const eventsBefore = (app.hub.collaboration.query({ kind: 'user' }, cluster.id, { kind: 'task', taskId: task.id }) as any).events.length;
    for (const [extra, message, code] of refusals) {
      assert.throws(() => cancel(task, extra), (e: any) => message.test(e.message) && e.code === code, JSON.stringify(extra));
      assert.equal(JSON.stringify(get(task.id)), before, `${JSON.stringify(extra)} changed nothing`);
    }
    assert.equal((app.hub.collaboration.query({ kind: 'user' }, cluster.id, { kind: 'task', taskId: task.id }) as any).events.length, eventsBefore,
      'no event was written');
  } finally { await app.close(); }
});

test('an old cancelled task without a reason and a deleted related task both read fine', async () => {
  const { app, cluster, create, get, cancel, send, user } = await fixture();
  try {
    const old = create('old');
    cancel(old);
    // A task cancelled before close reasons existed has no field at all.
    const row = app.store.db.prepare('SELECT data_json FROM collaboration_tasks WHERE id = ?').get(old.id) as { data_json: string };
    const { closeReason: _drop, ...legacy } = JSON.parse(row.data_json);
    app.store.db.prepare('UPDATE collaboration_tasks SET data_json = ? WHERE id = ?').run(JSON.stringify(legacy), old.id);
    assert.equal(get(old.id).status, 'cancelled');
    assert.equal('closeReason' in get(old.id), false);
    assert.equal('closeReason' in taskSummary(get(old.id)), false);
    const reopened = send(user, { action: 'task.reopen', taskId: old.id, expectedRevision: get(old.id).revision, reason: 'back' });
    assert.equal(reopened.task.status, 'pending');

    const gone = create('gone');
    const dup = create('dup');
    cancel(dup, { closeReason: 'duplicate', relatedTaskId: gone.id });
    cancel(gone);
    send(user, { action: 'task.delete', taskId: gone.id, expectedRevision: get(gone.id).revision });
    assert.deepEqual(get(dup.id).closeReason, { kind: 'duplicate', taskId: gone.id }, 'the stored id may point at nothing');
    const listed = (app.hub.collaboration.query(user as never, cluster.id, { kind: 'workspace', status: 'cancelled' }) as any).tasks;
    assert.ok(listed.some((t: any) => t.id === dup.id));
    const back = send(user, { action: 'task.reopen', taskId: dup.id, expectedRevision: get(dup.id).revision, reason: 'back' });
    assert.equal('closeReason' in back.task, false);
  } finally { await app.close(); }
});

test('a suggest-mode coordinator gets the close reason back as a suggestion and nothing changes', async () => {
  const { app, a, create, get, cancel, send, user } = await fixture();
  try {
    const policy = send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'suggest',
      permissions: { cancelReopen: true } }).coordinator;
    const target = create('target');
    const task = create('task');
    const coordinator = { kind: 'member', memberId: a.id };
    const result = cancel(task, { closeReason: 'duplicate', relatedTaskId: target.id.slice(0, 8), generation: policy.generation }, coordinator);
    assert.equal(result.suggestion.closeReason, 'duplicate');
    assert.equal(result.suggestion.relatedTaskId, target.id, 'the suggestion carries the full id');
    assert.equal(get(task.id).status, 'pending');
    assert.equal('closeReason' in get(task.id), false);
    assert.equal((app.store.getEvent(result.eventId)!.payload as any).suggested, true);
    assert.throws(() => cancel(task, { closeReason: 'duplicate', generation: policy.generation }, coordinator), /relatedTaskId is required/,
      'a suggestion is checked like the real thing');
  } finally { await app.close(); }
});

test('HTTP and the MCP task_action pass closeReason and relatedTaskId through', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [a] } = await app.cluster('close-mcp', ['A']);
    const base = { scope: 's', acceptance: 'a', memberId: null };
    const web = (body: Record<string, unknown>) => app.api('POST', `/api/clusters/${cluster.id}/collaboration`, body);
    const target = (await web({ operationId: 'h1', action: 'task.create', title: 'target', ...base })).task;
    const viaWeb = (await web({ operationId: 'h2', action: 'task.create', title: 'web', ...base })).task;
    const cancelled = await web({ operationId: 'h3', action: 'task.cancel', taskId: viaWeb.id, expectedRevision: viaWeb.revision,
      reason: 'r', closeReason: 'superseded', relatedTaskId: target.id });
    assert.deepEqual(cancelled.task.closeReason, { kind: 'superseded', taskId: target.id });

    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hold' });
    await waitFor(() => turnsOf(app, a.id) > 0, 'member turn');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: memberHeaders(app, a.id) },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text as string;
      return { error: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
    };
    const mine = (await call('create_task', { operationId: 'm1', title: 'mine', scope: 's', acceptance: 'a' })).data.task;
    const refused = await call('task_action', { operationId: 'm2', action: 'cancel', taskId: mine.id, expectedRevision: mine.revision,
      reason: 'r', closeReason: 'not_planned', relatedTaskId: target.id });
    assert.equal(refused.error, true);
    assert.match(refused.text, /relatedTaskId is only accepted/);
    const done = await call('task_action', { operationId: 'm3', action: 'cancel', taskId: mine.id, expectedRevision: mine.revision,
      reason: 'r', closeReason: 'duplicate', relatedTaskId: target.id.slice(0, 8) });
    assert.equal(done.error, false, done.text);
    assert.deepEqual(done.data.task.closeReason, { kind: 'duplicate', taskId: target.id });
    const listed = (await call('list_tasks', { status: 'cancelled' })).data.tasks;
    assert.deepEqual(listed.find((t: any) => t.id === mine.id).closeReason, { kind: 'duplicate', taskId: target.id });

    // User cancel leaves text reason optional for not_planned / duplicate / superseded, but keeps it required for other/default and for MCP members.
    const u1 = (await web({ operationId: 'hu1', action: 'task.create', title: 'u1', ...base, memberId: a.id })).task;
    const c1 = await web({ operationId: 'hc1', action: 'task.cancel', taskId: `#${u1.number}`, expectedRevision: u1.revision,
      closeReason: 'not_planned' });
    assert.deepEqual(c1.task.closeReason, { kind: 'not_planned' });
    const notice1 = app.store.listMessages(cluster.id, 100).find((m) => m.collabEventId === c1.eventId)!;
    assert.match(notice1.body, new RegExp(`^任务 #${u1.number}【u1】已取消（不做了），事件 ${c1.eventId}。$`));

    const u2 = (await web({ operationId: 'hu2', action: 'task.create', title: 'u2', ...base, memberId: a.id })).task;
    const c2 = await web({ operationId: 'hc2', action: 'task.cancel', taskId: `#${u2.number}`, expectedRevision: u2.revision,
      reason: '   ', closeReason: 'duplicate', relatedTaskId: '#1' });
    assert.deepEqual(c2.task.closeReason, { kind: 'duplicate', taskId: target.id });
    const notice2 = app.store.listMessages(cluster.id, 100).find((m) => m.collabEventId === c2.eventId)!;
    assert.match(notice2.body, new RegExp(`^任务 #${u2.number}【u2】已取消（重复，见任务 #1【target】），事件 ${c2.eventId}。$`));

    const u3 = (await web({ operationId: 'hu3', action: 'task.create', title: 'u3', ...base })).task;
    const c3 = await web({ operationId: 'hc3', action: 'task.cancel', taskId: `#${u3.number}`, expectedRevision: u3.revision,
      closeReason: 'superseded', relatedTaskId: '#1' });
    assert.deepEqual(c3.task.closeReason, { kind: 'superseded', taskId: target.id });

    const u4 = (await web({ operationId: 'hu4', action: 'task.create', title: 'u4', ...base })).task;
    await assert.rejects(
      web({ operationId: 'hc4', action: 'task.cancel', taskId: u4.id, expectedRevision: u4.revision, closeReason: 'other' }),
      /reason is required/i);
    await assert.rejects(
      web({ operationId: 'hc5', action: 'task.cancel', taskId: u4.id, expectedRevision: u4.revision }),
      /reason is required/i);

    const m2 = (await call('create_task', { operationId: 'mm2', title: 'm2', scope: 's', acceptance: 'a' })).data.task;
    const memberRefused = await call('task_action', { operationId: 'mm3', action: 'cancel', taskId: `#${m2.number}`,
      expectedRevision: m2.revision, closeReason: 'not_planned' });
    assert.equal(memberRefused.error, true);
    assert.match(memberRefused.text, /reason is required/i);
  } finally {
    hold.release();
    await client?.close().catch(() => {});
    await app.close();
  }
});
