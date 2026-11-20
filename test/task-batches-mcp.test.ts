// Review batches over MCP (docs/collaboration-api.md): manage_batch, get_batch, create_task's batchId, the batch in
// list_tasks / get_task, the in-batch commit to build on, and the batch ship command for the member who runs it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setBranchLookup } from '../src/plugins/tasks/package/hub/branch-link.mts';
import { reportBatchShip } from '../src/plugins/tasks/package/hub/ship.mts';
import { bearer, holdScript, startTestHub, waitFor, turnsOf, memberHeaders, tempDir } from './helpers.ts';

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

test('over MCP: manage_batch attribute_failure + task_action ship_fix refresh batch ship.command and expose members', async (t) => {
  setBranchLookup({ budgetMs: 60_000 });
  const hold = holdScript();
  const gitDir = tempDir();
  const repoDir = join(gitDir, 'repo');
  mkdirSync(repoDir);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'tester');
  g('config', 'user.email', 'tester@example.invalid');
  writeFileSync(join(repoDir, 'base.txt'), '0\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('checkout', '-q', '-b', 'agent/one');
  writeFileSync(join(repoDir, 'one.txt'), '1\n');
  g('add', '-A');
  g('commit', '-qm', 'one');
  const s1Sha = g('rev-parse', 'HEAD');
  writeFileSync(join(repoDir, 'one.txt'), '1-fixed\n');
  g('add', '-A');
  g('commit', '-qm', 'one fix');
  const s1FixSha = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');

  const app = await startTestHub({ mock: { script: hold.script } });
  app.hub.collaboration.prepareTimeoutMs = 60_000;
  t.after(async () => {
    setBranchLookup();
    hold.release();
    await app.close();
    rmSync(gitDir, { recursive: true, force: true, maxRetries: 5 });
  });
  const createdCluster = await app.api('POST', '/api/clusters', {
    name: 'batch-mcp-shipfix',
    members: [
      { harness: 'mock', mode: 'native', name: 'Exec', projectPath: repoDir },
      { harness: 'mock', mode: 'native', name: 'Rev', projectPath: repoDir },
    ],
  });
  const cluster = createdCluster.cluster;
  const [mExec, mRev] = createdCluster.members;
  await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@Exec @Rev hold' });
  await waitFor(() => [mExec.id, mRev.id].every((id) => turnsOf(app, id) > 0), 'both turns');

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
  const [callExec, callRev] = [await connect(mExec.id), await connect(mRev.id)];
  let serial = 0;
  const op = () => `sf-${++serial}`;

  await callExec('manage_batch', { operationId: op(), action: 'create', title: 'fix-batch', reviewer: { kind: 'member', memberId: 'Rev' } });
  const t1 = (await callExec('create_task', { operationId: op(), title: 'one', scope: 's', acceptance: 'a', batchId: 'B1' })).task;
  const st = await callExec('task_action', { operationId: op(), action: 'start', taskId: t1.id, expectedRevision: t1.revision });
  const sub = await callExec('task_action', { operationId: op(), action: 'submit', taskId: t1.id, expectedRevision: st.task.revision, assignmentId: st.assignment.id, summary: 'v1', commitSha: s1Sha });
  const appRes = await callRev('task_action', { operationId: op(), action: 'review', taskId: t1.id, expectedRevision: sub.task.revision, submissionId: sub.submission.id, verdict: 'approve', reason: 'ok' });
  const oldTicket = /--batch (\S+)/.exec(appRes.ship.command)![1];

  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  await reportBatchShip(app.hub, secret, { ticket: oldTicket, failed: { kind: 'checks', failedCheck: 'probe', detail: 'probe failed' } });
  const bView = await callRev('get_batch', { batchId: 'B1' });
  assert.equal(bView.batch.shipRunnerId, mRev.id);
  assert.equal(bView.batch.shipFixAllowed, true);
  assert.equal(bView.batch.shipFailure.runnerId, mRev.id);
  assert.deepEqual(bView.members[mRev.id], { name: 'Rev', removed: false });

  const failEv = bView.batch.shipFailure.eventId;
  const attr = await callRev('manage_batch', { operationId: op(), action: 'attribute_failure', batchId: 'B1', failureEventId: failEv, taskIds: ['#1'], reason: 'probe hit one' });
  assert.deepEqual(attr.batch.shipFailure.attribution.taskIds, [t1.id]);
  assert.deepEqual(attr.members[mRev.id], { name: 'Rev', removed: false });

  const fixed = await callRev('task_action', {
    operationId: op(), action: 'ship_fix', taskId: '#1',
    expectedRevision: (await callRev('get_task', { taskId: t1.id })).task.revision,
    failureEventId: failEv, commitSha: s1FixSha.slice(0, 10), summary: 'forward fix over MCP',
  });
  assert.equal(fixed.task.status, 'completed');
  assert.equal(fixed.submission.commitSha, s1FixSha);
  assert.match(fixed.ship.command, /--batch b1\./);
  assert.notEqual(/--batch (\S+)/.exec(fixed.ship.command)![1], oldTicket, 'refreshed batch ship ticket returned directly');
  const bAfter = await callRev('get_batch', { batchId: 'B1' });
  assert.notEqual(bAfter.batch.shipFailure.digest, bAfter.batch.currentDigest);
});
