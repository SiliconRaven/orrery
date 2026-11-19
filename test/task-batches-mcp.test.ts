// Review batches over MCP (docs/collaboration-api.md): manage_batch, get_batch, create_task's batchId, the batch in
// list_tasks / get_task, the in-batch commit to build on, and the batch ship command for the member who runs it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bearer, holdScript, startTestHub, waitFor, turnsOf, memberHeaders } from './helpers.ts';

test('over MCP: create a batch, fill it, read its progress; the approving reviewer gets the batch ship command', async (t) => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  t.after(async () => { hold.release(); await app.close(); });
  const { cluster, members: [m1, m2, watcher] } = await app.cluster('batches', ['A', 'B', 'Watcher']);
  await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A @B hold' });
  await waitFor(() => [m1.id, m2.id].every((id) => turnsOf(app, id) > 0), 'both turns');
  const connect = async (memberId: string) => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, memberId) } }));
    t.after(() => client.close());
    return async (name: string, args: Record<string, unknown>, error = false) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text as string;
      assert.equal(result.isError === true, error, text);
      return error ? text : JSON.parse(text);
    };
  };
  const [callA, callB, callWatcher] = [await connect(m1.id), await connect(m2.id), await connect(watcher.id)];
  let serial = 0;
  const op = () => `op-${++serial}`;
  const people = { [m1.id]: { name: 'A', removed: false }, [m2.id]: { name: 'B', removed: false } };

  const created = await callA('manage_batch', { operationId: op(), action: 'create', title: 'chain', reviewer: { kind: 'member', memberId: 'B' } });
  assert.equal(created.batch.number, 1);
  assert.deepEqual(created.members, people);
  const first = await callA('create_task', { operationId: op(), title: 'one', scope: `Unrelated text: ${watcher.id}`, acceptance: 'a', batchId: 'B1' });
  assert.deepEqual(first.members, people, 'an ID in task prose does not count as a reference');
  const one = first.task;
  const two = (await callA('create_task', { operationId: op(), title: 'two', scope: 's', acceptance: 'a', batchId: 'B1', dependencyIds: ['#1'] })).task;
  assert.deepEqual([one.assignedMemberId, one.reviewer], [m1.id, { kind: 'member', memberId: m2.id }], 'the creator executes, the batch reviewer reviews');
  const listed = await callA('list_tasks', {});
  assert.deepEqual(listed.tasks.map((task: { batchId?: string }) => task.batchId), [created.batch.id, created.batch.id]);
  assert.deepEqual(listed.members, people);
  const batch = await callA('get_batch', { batchId: 'B1' });
  assert.deepEqual(batch.members, people);
  let view = batch.batch;
  assert.deepEqual([view.total, view.submitted, view.complete], [2, 0, false]);
  assert.deepEqual(view.missing, ['#1 待开工', '#2 待开工']);
  assert.equal((await callA('get_batch', {})).batches.length, 1, 'without batchId: every open batch');

  const watch = await callWatcher('task_action', { operationId: op(), action: 'watch', taskId: one.id });
  const watcherName = { name: 'Watcher', removed: false };
  assert.deepEqual(watch.members, { [watcher.id]: watcherName });
  assert.deepEqual((await callA('get_task', { taskId: one.id })).members, { ...people, [watcher.id]: watcherName });

  const work = async (task: { id: string }, sha: string) => {
    const started = await callA('task_action', { operationId: op(), action: 'start', taskId: task.id, expectedRevision: (await callA('get_task', { taskId: task.id })).task.revision });
    assert.equal(started.assignment.memberId, m1.id);
    assert.deepEqual(started.members, people);
    return callA('task_action', { operationId: op(), action: 'submit', taskId: task.id, expectedRevision: started.task.revision, assignmentId: started.assignment.id, summary: 'done', commitSha: sha });
  };
  const s1 = await work(one, 'abcdef0');
  const early = await callB('task_action', { operationId: op(), action: 'review', taskId: one.id, expectedRevision: s1.task.revision, submissionId: s1.submission.id, verdict: 'approve', reason: 'ok' }, true);
  assert.match(early, /BATCH_INCOMPLETE.*#2 待开工/);
  const context = await callA('get_task', { taskId: two.id });
  assert.equal(context.dependencies[0].batchBase.commitSha, 'abcdef0', 'the commit to build on');
  assert.equal(context.batch.number, 1);
  const s2 = await work(two, '1234567');
  view = (await callB('get_batch', { batchId: 'B1' })).batch;
  assert.equal(view.complete, true);
  await callB('task_action', { operationId: op(), action: 'review', taskId: one.id, expectedRevision: (await callB('get_task', { taskId: one.id })).task.revision, submissionId: s1.submission.id, verdict: 'approve', reason: 'ok' });
  const last = await callB('task_action', { operationId: op(), action: 'review', taskId: two.id, expectedRevision: (await callB('get_task', { taskId: two.id })).task.revision, submissionId: s2.submission.id, verdict: 'approve', reason: 'ok' });
  assert.deepEqual(last.review.reviewer, { kind: 'member', memberId: m2.id });
  assert.deepEqual(last.members, people);
  assert.match(last.ship.command, /^node ".+\/scripts\/ship\.ts" --batch b1\.\S+ --hub http:\/\/127\.0\.0\.1:\d+ --agent <name>/);
  assert.match((await callB('get_batch', { batchId: 'B1' })).ship.command, /--batch b1\./, 'the reviewer reads it again');
  assert.equal((await callA('get_batch', { batchId: 'B1' })).ship, undefined, 'nobody else gets it');
  assert.equal((await callA('get_task', { taskId: one.id })).ship, undefined, 'no single-task command for a batched task');

  app.hub.updateMember(m2.id, { name: 'ReviewerNew' });
  const renamed = { name: 'ReviewerNew', removed: false };
  const readTask = () => callA('get_task', { taskId: two.id });
  assert.deepEqual((await readTask()).members[m2.id], renamed);
  assert.deepEqual((await callA('get_batch', { batchId: 'B1' })).members[m2.id], renamed);

  app.hub.setMemberHidden(m2.id, true);
  const hidden = await readTask();
  assert.equal(hidden.task.reviewer.memberId, m2.id, 'the historical ID stays intact');
  assert.equal(hidden.members[m2.id], undefined, 'a hidden member’s name is not disclosed to peers');

  app.hub.removeMember(cluster.id, m2.id);
  assert.deepEqual((await readTask()).members[m2.id], { ...renamed, removed: true });

  const path = `/api/clusters/${cluster.id}`;
  const { task: userTask } = await app.api('POST', `${path}/collaboration`, { action: 'task.create', operationId: op(),
    title: 'User task', scope: 's', acceptance: 'a', reviewer: { kind: 'user' } });
  const userView = await callA('get_task', { taskId: userTask.id });
  assert.equal(userView.task.createdBy, 'user');
  assert.deepEqual(userView.task.reviewer, { kind: 'user' });
  assert.deepEqual(userView.members, {});
  assert.equal((await app.api('GET', `${path}/tasks/${two.id}`)).members, undefined, 'HTTP does not receive the map');
});
