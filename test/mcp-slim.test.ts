// MCP tool results stay in the caller's conversation and are re-read on every later model call: the defaults are
// small, parameters bring back the full shape, and the HTTP API the web page uses is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nativeHeaders, holdScript, startTestHub, waitFor } from './helpers.ts';

test('mcp slim: list_tasks, get_task, get_task_context and list_bookmarks default to small results; parameters give the full shape', async (t) => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [member] } = await app.cluster('slim', ['A']);
    const path = `/api/clusters/${cluster.id}`;
    const cmd = (body: Record<string, unknown>) => app.api('POST', `${path}/collaboration`, body);
    const long = 'scope line with enough words to matter. '.repeat(40).trim();   // the Hub trims text fields
    const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const { task } = await cmd({ action: 'task.create', operationId: `t${i}`, title: `Task ${i}`, scope: long, acceptance: long, labels: ['slim'] });
      ids.push(task.id);
    }
    // 22 of them closed: the default list shows the 10 open ones only.
    for (let i = 0; i < 22; i++) await cmd({ action: 'task.cancel', operationId: `c${i}`, taskId: ids[i], expectedRevision: 1, reason: 'not needed' });
    // A task with a dependency and a history of edits.
    const { task: dep } = await cmd({ action: 'task.create', operationId: 'dep', title: 'Dependent', scope: 's0', acceptance: 'a', dependencyIds: [ids[31]] });
    let revision = dep.revision;
    for (let i = 1; i <= 7; i++) revision = (await cmd({ action: 'task.edit', operationId: `e${i}`, taskId: dep.id, expectedRevision: revision, scope: `s${i}` })).task.revision;
    const message = await app.api('POST', `${path}/messages`, { body: 'x'.repeat(2500), taskIds: [dep.id] });

    await app.api('POST', `${path}/messages`, { body: '@A hold' });
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: nativeHeaders(app, member.id) },
    }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text as string;
      assert.equal(result.isError === true, false, text);
      return { bytes: Buffer.byteLength(text), data: JSON.parse(text) };
    };

    // list_tasks: open tasks only, summaries, 20 per page, no roles/labels/rules unless asked.
    const list = await call('list_tasks');
    assert.equal(list.data.tasks.length, 11, '10 open + the dependent task');
    assert.ok(list.data.tasks.every((task: any) => task.status !== 'cancelled'));
    assert.equal(list.data.tasks[0].scope, undefined, 'summary: no scope');
    assert.deepEqual(Object.keys(list.data.tasks[0]).sort(), ['completionValid', 'dependenciesChanged', 'dependenciesReady', 'dependencyIds',
      'id', 'number', 'labels', 'assignedMemberId', 'priority', 'proposalState', 'reviewer', 'revision', 'status', 'title', 'updatedAt', 'approvedSubmissionId', 'createdBy',
      'requiresApproval', 'mergeRequired', 'mergedCommitSha', 'mergedSubmissionId'].sort());
    for (const key of ['roles', 'memberRoles', 'labels']) assert.equal(list.data[key], undefined, key);
    assert.equal(list.data.coordinator, null);
    const all = await call('list_tasks', { includeClosed: true });
    assert.equal(all.data.tasks.length, 20, 'default page size');
    assert.ok(all.data.nextCursor);
    assert.equal((await call('list_tasks', { status: 'cancelled', limit: 50 })).data.tasks.length, 22, 'a status filter still finds closed tasks');
    const full = await call('list_tasks', { detail: 'full', include: ['roles', 'memberRoles', 'labels'] });
    assert.equal(full.data.tasks[0].scope, long);
    assert.ok(Array.isArray(full.data.roles) && Array.isArray(full.data.memberRoles));
    // include labels is this cluster's label catalog (task-labels.test.ts): the auto-created label is ungrouped.
    assert.deepEqual(full.data.labels, { groups: [], ungrouped: [{ name: 'slim' }] });
    const http = await app.api('GET', `${path}/workspace`);
    assert.equal(http.tasks.length, 33, 'HTTP: every task, full records, as before');
    assert.equal(http.tasks[0].scope, long);
    assert.ok(Array.isArray(http.roles));

    // get_task: newest events first, 5 per page, changedFields; dependencies as summaries.
    const task = await call('get_task', { taskId: dep.id });
    assert.equal(task.data.events.length, 5);
    const seqs = task.data.events.map((e: any) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => b - a), 'newest first');
    assert.deepEqual(task.data.events[0].payload.changedFields, ['scope']);
    assert.equal(task.data.events[0].payload.changes, undefined);
    assert.equal(task.data.dependencies[0].scope, undefined);
    assert.equal(task.data.dependencies[0].id, ids[31]);
    const older = await call('get_task', { taskId: dep.id, eventsCursor: task.data.eventsNextCursor });
    assert.ok(older.data.events.every((e: any) => e.seq < seqs.at(-1)), 'the cursor pages back');
    assert.equal(older.data.events.at(-1).payload.action, 'task.create');
    const fullEvents = await call('get_task', { taskId: dep.id, eventDetail: 'full', eventsLimit: 50 });
    assert.equal(fullEvents.data.events.length, 8);
    assert.deepEqual(fullEvents.data.events[0].payload.changes, [{ field: 'scope', before: 's6', after: 's7' }]);
    const httpTask = await app.api('GET', `${path}/tasks/${dep.id}`);
    assert.equal(httpTask.events[0].payload.action, 'task.create', 'HTTP: oldest first, as before');
    assert.ok(Array.isArray(httpTask.events[0].payload.changes));
    assert.equal(httpTask.dependencies[0].scope, long);

    // get_task_context: the same event and dependency views; 10 messages per page.
    const context = await call('get_task_context', { taskId: dep.id });
    assert.equal(context.data.events.length, 5);
    assert.deepEqual(context.data.events[0].payload.changedFields, ['scope']);
    assert.equal(context.data.dependencies[0].scope, undefined);
    assert.ok(context.data.messages.length <= 10, 'messages: 10 per page');
    assert.ok(context.data.messages.some((item: any) => item.message.id === message.id) || context.data.messagesNextCursor);

    // list_bookmarks: long bodies cut unless detail is full.
    await call('bookmark_message', { action: 'set', operationId: 'star', messageId: message.id, labels: ['keep'] });
    const marks = await call('list_bookmarks');
    assert.equal(marks.data.items[0].message.body.length, 2000);
    assert.equal(marks.data.items[0].message.truncated, true);
    assert.equal((await call('list_bookmarks', { detail: 'full' })).data.items[0].message.body.length, 2500);

    // The old default: every task (limit 50), full records, roles, member roles, labels and rules.
    const old = await call('list_tasks', { includeClosed: true, limit: 50, detail: 'full', include: ['roles', 'memberRoles', 'labels', 'rules'] });
    assert.equal(old.data.tasks.length, 33);
    t.diagnostic(`list_tasks bytes: old default ${old.bytes} → new default ${list.bytes}`);
    t.diagnostic(`get_task bytes: full events ${fullEvents.bytes} → default ${task.bytes}`);
    assert.ok(list.bytes * 10 < old.bytes, 'the default list is a small fraction of the old one');
  } finally {
    await client?.close();
    hold.release();
    await app.close();
  }
});

test('mcp slim: a dependency summary keeps approvedSubmissionId, so a resubmission can declare the new upstream version', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [member] } = await app.cluster('deps', ['A']);
    const path = `/api/clusters/${cluster.id}`;
    const cmd = (body: Record<string, unknown>) => app.api('POST', `${path}/collaboration`, body);
    const { task: up } = await cmd({ action: 'task.create', operationId: 'up', title: 'Upstream', scope: 's', acceptance: 'a', mergeRequired: false });
    const { task: down } = await cmd({ action: 'task.create', operationId: 'down', title: 'Downstream', scope: 's', acceptance: 'a', mergeRequired: false, dependencyIds: [up.id] });
    const evidence = await app.api('POST', `${path}/messages`, { body: 'evidence' });
    await app.api('POST', `${path}/messages`, { body: '@A hold' });
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: nativeHeaders(app, member.id) },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text as string;
      return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
    };
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      assert.equal(r.isError, false, r.text);
      return r.data;
    };
    // The member does the upstream task; the user approves it. Returns the approved submission id.
    const deliverUpstream = async (round: string) => {
      const t = (await app.api('GET', `${path}/tasks/${up.id}`)).task;
      const claim = await ok('task_action', { action: 'claim', operationId: `uc-${round}`, taskId: up.id, expectedRevision: t.revision });
      const start = await ok('task_action', { action: 'start', operationId: `us-${round}`, taskId: up.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
      const sub = await ok('task_action', { action: 'submit', operationId: `ub-${round}`, taskId: up.id, expectedRevision: start.task.revision,
        assignmentId: claim.assignment.id, summary: 'done', evidenceMessageIds: [evidence.id] });
      await cmd({ action: 'task.review', operationId: `ur-${round}`, taskId: up.id, expectedRevision: sub.task.revision, submissionId: sub.submission.id, verdict: 'approve' });
      return sub.submission.id as string;
    };
    await deliverUpstream('1');
    const claim = await ok('task_action', { action: 'claim', operationId: 'dc', taskId: down.id, expectedRevision: down.revision });
    const start = await ok('task_action', { action: 'start', operationId: 'ds', taskId: down.id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
    // The upstream task is reopened and approved again: a new version the downstream submission must declare.
    const reopened = (await app.api('GET', `${path}/tasks/${up.id}`)).task;
    await cmd({ action: 'task.reopen', operationId: 'reopen', taskId: up.id, expectedRevision: reopened.revision, reason: 'redo' });
    const v2 = await deliverUpstream('2');
    const context = await ok('get_task_context', { taskId: down.id });
    assert.equal(context.dependencies[0].approvedSubmissionId, v2, 'the summary carries the current approved version');
    const submit = { action: 'submit', taskId: down.id, expectedRevision: start.task.revision, assignmentId: claim.assignment.id,
      summary: 'downstream done', evidenceMessageIds: [evidence.id] };
    assert.match((await call('task_action', { ...submit, operationId: 'db-undeclared' })).text, /DEPENDENCIES_CHANGED/);
    const declared = await ok('task_action', { ...submit, operationId: 'db-declared',
      expectedDependencyVersions: { [up.id]: context.dependencies[0].approvedSubmissionId } });
    assert.equal(declared.task.status, 'review');
  } finally {
    await client?.close();
    hold.release();
    await app.close();
  }
});
