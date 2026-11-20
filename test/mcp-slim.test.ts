// MCP tool results stay in the caller's conversation and are re-read on every later model call: the defaults are
// small, parameters bring back the full shape, and the HTTP API the web page uses is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { reportBatchShip } from '../src/plugins/tasks/package/hub/ship.mts';
import { bearer, holdScript, startTestHub, waitFor, turnsOf, memberHeaders } from './helpers.ts';

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
    await waitFor(() => turnsOf(app, member.id) > 0, 'member turn');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: memberHeaders(app, member.id) },
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
    await waitFor(() => turnsOf(app, member.id) > 0, 'member turn');
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: memberHeaders(app, member.id) },
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

test('mcp slim: taskCommand write tools drop long prose, keep IDs/ship/members/nextStep, and leave HTTP full', async (t) => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  const clients: Client[] = [];
  try {
    const { cluster, members: [mA, mB] } = await app.cluster('slim-writes', ['A', 'B']);
    const path = `/api/clusters/${cluster.id}`;
    const longProse = 'long prose payload that stays in get_task and HTTP. '.repeat(20).trim();
    await app.api('POST', `${path}/messages`, { body: '@A @B hold' });
    for (const m of [mA, mB]) await waitFor(() => turnsOf(app, m.id) > 0, `turn ${m.name}`);

    const connect = async (memberId: string) => {
      const client = new Client({ name: 'test', version: '0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, memberId) } }));
      return async (name: string, args: Record<string, unknown>, expectError = false) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as any)[0].text as string;
        assert.equal(res.isError === true, expectError, text);
        return { text, data: res.isError ? null : JSON.parse(text) };
      };
    };
    const [callA, callB] = [await connect(mA.id), await connect(mB.id)];

    // HTTP collaboration endpoint still returns full prose unchanged.
    const httpCreated = await app.api('POST', `${path}/collaboration`, {
      action: 'task.create', operationId: 'http-create', title: 'HTTP full', scope: longProse, acceptance: longProse,
    });
    assert.equal(httpCreated.task.scope, longProse);
    assert.equal(httpCreated.task.acceptance, longProse);
    assert.equal(httpCreated.nextStep, undefined);

    // 1. create_task
    const created = (await callA('create_task', {
      operationId: 'w-create', title: 'Slim work', scope: longProse, acceptance: longProse,
      reviewer: { kind: 'member', memberId: mB.id }, mergeRequired: false,
    })).data;
    assert.equal(created.task.scope, undefined);
    assert.equal(created.task.acceptance, undefined);
    assert.equal(created.task.id !== undefined && created.task.revision === 1, true);
    assert.ok(created.members[mA.id] && created.members[mB.id]);
    assert.ok(typeof created.nextStep === 'string' && created.nextStep.includes('start'));
    const tid = created.task.id as string;

    // 2. task_action start
    const started = (await callA('task_action', { operationId: 'w-start', action: 'start', taskId: tid })).data;
    assert.equal(started.task.scope, undefined);
    assert.equal(started.assignment.id, started.task.currentAssignmentId);
    assert.equal(started.assignment.taskId, undefined);
    assert.ok(started.nextStep.includes('submit'));

    // 3 & 4. raise_attention + resolve_attention
    const raised = (await callA('raise_attention', {
      operationId: 'w-att', taskId: tid, expectedRevision: started.task.revision, kind: 'question', question: longProse, targetMemberId: mB.id,
    })).data;
    assert.equal(raised.attention.question, undefined);
    assert.equal(raised.attention.kind, 'question');
    assert.ok(raised.members[mB.id]);
    assert.ok(raised.nextStep.includes('get_task_context'));
    const resolved = (await callB('resolve_attention', {
      operationId: 'w-res', taskId: tid, attentionId: raised.attention.id, expectedRevision: raised.task.revision, resolution: longProse,
    })).data;
    assert.equal(resolved.attention.resolution, undefined);
    assert.ok(resolved.attention.resolvedAt);
    assert.ok(typeof resolved.nextStep === 'string' && resolved.nextStep.length > 0);

    // 5. set_task_summary
    const summarized = (await callA('set_task_summary', {
      operationId: 'w-sum', taskId: tid, expectedRevision: resolved.task.revision, summary: longProse, throughEventId: 0, sourceMessageIds: [],
    })).data;
    assert.equal(summarized.summary, undefined);
    assert.ok(summarized.nextStep.includes('get_task_context'));
    assert.equal((await callA('get_task_context', { taskId: tid })).data.summary.content, longProse);

    // 6. link_message_tasks
    const msg = await app.api('POST', `${path}/messages`, { body: 'link target' });
    const linked = (await callA('link_message_tasks', {
      operationId: 'w-link', messageId: msg.id, taskIds: [tid], reason: longProse,
    })).data;
    assert.equal(linked.messageId, msg.id);
    assert.ok(linked.nextStep.includes('get_task_context'));

    // 7. task_action submit + review (reject & approve)
    const submitted = (await callA('task_action', { operationId: 'w-sub1', action: 'submit', taskId: tid, summary: longProse })).data;
    assert.equal(submitted.submission.summary, undefined);
    assert.equal(submitted.submission.dependencyVersions, undefined);
    assert.ok(submitted.submission.id);
    assert.ok(submitted.nextStep.includes('review'));

    const rejected = (await callB('task_action', {
      operationId: 'w-rej', action: 'review', taskId: tid, submissionId: submitted.submission.id, verdict: 'reject', reason: longProse,
    })).data;
    assert.equal(rejected.review.reason, undefined);
    assert.equal(rejected.review.verdict, 'reject');
    assert.ok(rejected.nextStep.includes('submit'));

    const rejTake = (await callA('task_action', { operationId: 'w-sub2', action: 'submit', taskId: tid, summary: 'v2' })).data;
    const takeoverRev = (await callB('task_action', {
      operationId: 'w-rej-take', action: 'review', taskId: tid, submissionId: rejTake.submission.id, verdict: 'reject', takeover: true, reason: longProse,
    })).data;
    assert.equal(takeoverRev.review.reason, undefined);
    assert.equal(takeoverRev.takeover.reason, undefined);
    assert.ok(takeoverRev.takeover.toMemberId === mB.id);

    // 8. manage_batch (create, add, attribute_failure, cancel) + ship.command on batch approve
    const batchCreated = (await callA('manage_batch', {
      operationId: 'b-create', action: 'create', title: 'Slim Batch', reviewer: { kind: 'member', memberId: mB.id },
    })).data;
    assert.equal(batchCreated.batch.number, 1);
    assert.ok(batchCreated.nextStep.includes('add'));

    const shipTask = (await callA('create_task', {
      operationId: 'b-task', title: 'Batched task', scope: longProse, acceptance: longProse, batchId: 'B1', mergeRequired: true,
    })).data.task;
    await callA('task_action', { operationId: 'b-start', action: 'start', taskId: shipTask.id });
    const bSub = (await callA('task_action', {
      operationId: 'b-sub', action: 'submit', taskId: shipTask.id, summary: longProse, commitSha: 'abcdef0',
    })).data;
    const bApp = (await callB('task_action', {
      operationId: 'b-app', action: 'review', taskId: shipTask.id, submissionId: bSub.submission.id, verdict: 'approve', reason: longProse,
    })).data;
    assert.equal(bApp.review.reason, undefined);
    assert.match(bApp.ship.command, /--batch b1\./);
    assert.ok(bApp.nextStep.includes('ship.command'));

    const ticket = /--batch (\S+)/.exec(bApp.ship.command)![1];
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    await reportBatchShip(app.hub, secret, { ticket, failed: { kind: 'checks', failedCheck: 'probe', detail: longProse } });
    const bView = (await callB('get_batch', { batchId: 'B1' })).data.batch;
    assert.equal(bView.shipFailure.detail, longProse, 'get_batch keeps full failure details');

    const attr = (await callB('manage_batch', {
      operationId: 'b-attr', action: 'attribute_failure', batchId: 'B1', failureEventId: bView.shipFailure.eventId, taskIds: [shipTask.id], reason: longProse,
    })).data;
    assert.equal(attr.batch.shipFailure.reason, undefined);
    assert.equal(attr.batch.shipFailure.detail, undefined);
    assert.equal(attr.batch.shipFailure.attribution.reason, undefined);
    assert.deepEqual(attr.batch.shipFailure.attribution.taskIds, [shipTask.id]);
    assert.ok(attr.nextStep.includes('ship_fix'));
    // Note: longProse never leaked into any slimmed command result.
    for (const obj of [created, started, raised, resolved, summarized, linked, submitted, rejected, takeoverRev, bApp, attr]) {
      assert.equal(JSON.stringify(obj).includes(longProse), false, `prose leaked into ${obj.action}`);
    }
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    hold.release();
    await app.close();
  }
});

test('mcp args: optional assignmentId and tiered expectedRevision enforce stale reassignment and dependency drift guards', async (t) => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  const clients: Client[] = [];
  try {
    const { cluster, members: [mA, mB] } = await app.cluster('args-tiers', ['A', 'B']);
    const path = `/api/clusters/${cluster.id}`;
    const http = (body: Record<string, unknown>) => app.api('POST', `${path}/collaboration`, body);
    await app.api('POST', `${path}/messages`, { body: '@A @B hold' });
    for (const m of [mA, mB]) await waitFor(() => turnsOf(app, m.id) > 0, `turn ${m.name}`);

    const connect = async (memberId: string) => {
      const client = new Client({ name: 'test', version: '0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, memberId) } }));
      return async (name: string, args: Record<string, unknown>, expectError = false) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as any)[0].text as string;
        assert.equal(res.isError === true, expectError, text);
        return { text, data: res.isError ? null : JSON.parse(text) };
      };
    };
    const [callA, callB] = [await connect(mA.id), await connect(mB.id)];

    // 1. Mutating tier-2 actions still fail STALE_REVISION without expectedRevision.
    const t1 = (await callA('create_task', {
      operationId: 'arg-c1', title: 'Arg checks', scope: 's', acceptance: 'a', reviewer: { kind: 'member', memberId: mB.id }, mergeRequired: false,
    })).data.task;
    const mb = (await callA('manage_batch', {
      operationId: 'mr-batch', action: 'create', title: 'Guard Batch', reviewer: { kind: 'member', memberId: mB.id },
    })).data.batch;
    for (const missingRev of [
      { name: 'task_action', args: { operationId: 'mr-edit', action: 'edit', taskId: t1.id, title: 'x' } },
      { name: 'task_action', args: { operationId: 'mr-assign', action: 'assign', taskId: t1.id, memberId: null } },
      { name: 'task_action', args: { operationId: 'mr-cancel', action: 'cancel', taskId: t1.id, reason: 'x' } },
      { name: 'manage_batch', args: { operationId: 'mr-badd', action: 'add', batchId: mb.id, taskId: t1.id } },
      { name: 'raise_attention', args: { operationId: 'mr-att', taskId: t1.id, kind: 'blocker', question: 'q' } },
      { name: 'set_task_summary', args: { operationId: 'mr-sum', taskId: t1.id, summary: 's', throughEventId: 0, sourceMessageIds: [] } },
    ]) {
      assert.match((await callA(missingRev.name, missingRev.args, true)).text, /expectedRevision|STALE_REVISION|Required/i);
    }

    // 2. Omitting expectedRevision & assignmentId on start, active/review submit, review, and executor release/handoff works; wrong values reject.
    assert.match((await callA('task_action', { operationId: 'bad-srev', action: 'start', taskId: t1.id, expectedRevision: 99 }, true)).text, /STALE_REVISION/);
    const st1 = (await callA('task_action', { operationId: 'ok-start', action: 'start', taskId: t1.id })).data;
    assert.equal(st1.task.status, 'working');
    assert.match((await callA('task_action', { operationId: 'bad-rrev', action: 'release', taskId: t1.id, reason: 'no rev' }, true)).text, /STALE_REVISION/);
    assert.match((await callA('task_action', { operationId: 'bad-haid', action: 'handoff', taskId: t1.id, expectedRevision: st1.task.revision, assignmentId: 'stale', memberId: mB.id, reason: 'x' }, true)).text, /STALE_ASSIGNMENT/);
    const rel1 = (await callA('task_action', { operationId: 'ok-rel', action: 'release', taskId: t1.id, expectedRevision: st1.task.revision, reason: 'recheck' })).data;
    assert.equal(rel1.task.assignedMemberId, null);

    // 3. Same-member reassignment: old assignment/unstarted/bare reassigned state rejects omitted submit; passing current assignmentId or expectedRevision succeeds.
    await http({ action: 'task.assign', operationId: 'reass-1', taskId: t1.id, expectedRevision: rel1.task.revision, memberId: mA.id });
    assert.match((await callA('task_action', { operationId: 'unstarted-sub', action: 'submit', taskId: t1.id, summary: 'too early' }, true)).text, /STALE_ASSIGNMENT/);
    const st2 = (await callA('task_action', { operationId: 're-start', action: 'start', taskId: t1.id })).data;
    assert.match((await callA('task_action', { operationId: 'bare-reass-sub', action: 'submit', taskId: t1.id, summary: 'ambiguous' }, true)).text, /STALE_ASSIGNMENT/);
    assert.match((await callA('task_action', { operationId: 'old-aid-sub', action: 'submit', taskId: t1.id, assignmentId: st1.assignment.id, summary: 'old assign' }, true)).text, /STALE_ASSIGNMENT/);
    assert.match((await callA('task_action', { operationId: 'old-rev-sub', action: 'submit', taskId: t1.id, expectedRevision: st2.task.revision - 1, summary: 'old rev' }, true)).text, /STALE_REVISION/);
    const sub1 = (await callA('task_action', { operationId: 'ok-sub', action: 'submit', taskId: t1.id, assignmentId: st2.assignment.id, summary: 'v1' })).data;
    const sub2 = (await callA('task_action', { operationId: 'ok-sub2', action: 'submit', taskId: t1.id, expectedRevision: sub1.task.revision, summary: 'v2' })).data;
    assert.match((await callB('task_action', { operationId: 'rev-stale-sub', action: 'review', taskId: t1.id, submissionId: sub1.submission.id, verdict: 'approve', reason: 'old' }, true)).text, /STALE_SUBMISSION/);
    assert.match((await callB('task_action', { operationId: 'rev-stale-num', action: 'review', taskId: t1.id, expectedRevision: sub2.task.revision - 1, submissionId: sub2.submission.id, verdict: 'approve', reason: 'stale rev' }, true)).text, /STALE_REVISION/);

    // 4. Upstream dependency change: active submit enforces expectedDependencyVersions; reassigned self-review scope edit blocks bare submit; invalidated completed requires BOTH args.
    const up = (await callA('create_task', {
      operationId: 'dep-up', title: 'Up', scope: 's1', acceptance: 'a', reviewer: { kind: 'self' }, mergeRequired: false,
    })).data.task;
    await callA('task_action', { operationId: 'up-st1', action: 'start', taskId: up.id });
    const upV1 = (await callA('task_action', { operationId: 'up-sb1', action: 'submit', taskId: up.id, summary: 'self: v1' })).data.submission.id;
    const down = (await callA('create_task', {
      operationId: 'dep-down', title: 'Down', scope: 's', acceptance: 'a', reviewer: { kind: 'member', memberId: mB.id }, mergeRequired: false, dependencyIds: [up.id],
    })).data.task;
    await callA('task_action', { operationId: 'dn-st', action: 'start', taskId: down.id });

    // Upstream reopens, edits scope (definitionVersion 2), reassigns same member A, and restarts: bare submit must NOT auto-complete under new scope!
    const upCur1 = (await callA('get_task', { taskId: up.id })).data.task;
    const reopened1 = await http({ action: 'task.reopen', operationId: 'up-reopen1', taskId: up.id, expectedRevision: upCur1.revision, reason: 'update v2' });
    const editedUp1 = await http({ action: 'task.edit', operationId: 'up-ed1', taskId: up.id, expectedRevision: reopened1.task.revision, scope: 's2-updated' });
    await http({ action: 'task.assign', operationId: 'up-as1', taskId: up.id, expectedRevision: editedUp1.task.revision, memberId: mA.id });
    const upSt2 = (await callA('task_action', { operationId: 'up-st2', action: 'start', taskId: up.id })).data;
    assert.match((await callA('task_action', { operationId: 'up-bare-rej', action: 'submit', taskId: up.id, summary: 'stale bare self' }, true)).text, /STALE_ASSIGNMENT/);
    assert.equal((await callA('get_task', { taskId: up.id })).data.task.status, 'working', 'reassigned bare submit leaves self task working');
    const upV2 = (await callA('task_action', {
      operationId: 'up-sb2', action: 'submit', taskId: up.id, assignmentId: upSt2.assignment.id, summary: 'self: v2',
    })).data.submission.id;

    assert.match((await callA('task_action', { operationId: 'dn-drift', action: 'submit', taskId: down.id, summary: 'missing versions' }, true)).text, /DEPENDENCIES_CHANGED/);
    const dnSub = (await callA('task_action', {
      operationId: 'dn-sub-ok', action: 'submit', taskId: down.id, summary: 'with v2', expectedDependencyVersions: { [up.id]: upV2 },
    })).data;
    await callB('task_action', { operationId: 'dn-app', action: 'review', taskId: down.id, submissionId: dnSub.submission.id, verdict: 'approve', reason: 'good' });

    // Upstream moves to v3 -> downstream becomes invalidated completed!
    const upCur2 = (await callA('get_task', { taskId: up.id })).data.task;
    const reopened2 = await http({ action: 'task.reopen', operationId: 'up-reopen2', taskId: up.id, expectedRevision: upCur2.revision, reason: 'update v3' });
    await http({ action: 'task.assign', operationId: 'up-as2', taskId: up.id, expectedRevision: reopened2.task.revision, memberId: mA.id });
    const upSt3 = (await callA('task_action', { operationId: 'up-st3', action: 'start', taskId: up.id })).data;
    const upV3 = (await callA('task_action', {
      operationId: 'up-sb3', action: 'submit', taskId: up.id, expectedRevision: upSt3.task.revision, summary: 'self: v3',
    })).data.submission.id;

    const dnInvalid = (await callA('get_task', { taskId: down.id })).data.task;
    assert.equal(dnInvalid.completionValid, false);
    assert.match((await callA('task_action', {
      operationId: 'dn-comp-norev', action: 'submit', taskId: down.id, assignmentId: dnSub.submission.assignmentId, summary: 'missing rev', expectedDependencyVersions: { [up.id]: upV3 },
    }, true)).text, /STALE_REVISION/);
    assert.match((await callA('task_action', {
      operationId: 'dn-comp-noaid', action: 'submit', taskId: down.id, expectedRevision: dnInvalid.revision, summary: 'missing aid', expectedDependencyVersions: { [up.id]: upV3 },
    }, true)).text, /STALE_ASSIGNMENT/);
    const dnResub = (await callA('task_action', {
      operationId: 'dn-comp-ok', action: 'submit', taskId: down.id, expectedRevision: dnInvalid.revision, assignmentId: dnSub.submission.assignmentId, summary: 'v3 aligned', expectedDependencyVersions: { [up.id]: upV3 },
    })).data;
    assert.equal(dnResub.task.status, 'review');
    assert.notEqual(dnResub.submission.assignmentId, dnSub.submission.assignmentId);
    assert.ok(upV1);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    hold.release();
    await app.close();
  }
});
