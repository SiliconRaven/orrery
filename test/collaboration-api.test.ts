import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { saveCollaborationTask } from '../src/plugins/tasks/store.ts';
import { bearer, holdScript, rawFetch, startTestHub, TEST_TOKEN, waitFor, turnsOf, memberHeaders } from './helpers.ts';

test('the HTTP workbench pages 300 tasks newest first with a stable cursor and optional metadata', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('large workbench', ['A']);
    const path = `/api/clusters/${cluster.id}`;
    const { task } = await app.api('POST', `${path}/collaboration`, {
      action: 'task.create', operationId: 'first', title: 'Task 1', scope: 'mentions #12', acceptance: 'Done',
    });
    app.store.transaction(() => {
      for (let number = 1; number <= 300; number++) {
        saveCollaborationTask(app.store, { ...task, number, id: number === 1 ? task.id : `task-${number}`,
          title: `Task ${number}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(number / 10))).toISOString() });
      }
    });

    const workspace = `${path}/workspace`;
    const first = await app.api('GET', `${workspace}?sort=created-desc`);
    assert.deepEqual(first.tasks.map((t: any) => t.number), Array.from({ length: 50 }, (_, i) => 300 - i));
    assert.ok(first.labelLibrary && first.roles && first.nextCursor);

    app.store.db.prepare('DELETE FROM collaboration_tasks WHERE id = ?').run('task-251');
    const next = await app.api('GET', `${workspace}?sort=created-desc&pageOnly=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.deepEqual(Object.keys(next).sort(), ['nextCursor', 'tasks']);
    assert.deepEqual(next.tasks.map((t: any) => t.number), Array.from({ length: 50 }, (_, i) => 250 - i));
    assert.ok(next.tasks.every((t: any) => t.dependenciesReady));
    assert.equal((await app.api('GET', `${workspace}?limit=1`)).tasks[0].number, 1, 'oldest-first callers are unchanged');
    const ranked = await app.api('GET', `${workspace}?sort=created-desc&q=%2312&limit=1`);
    assert.equal(ranked.tasks[0].number, 12);
    assert.equal((await app.api('GET', `${workspace}?sort=created-desc&q=%2312&limit=1&cursor=${encodeURIComponent(ranked.nextCursor)}`)).tasks[0].number, 300);
  } finally { await app.close(); }
});

test('HTTP and MCP share tasks and bookmarks, preserve caller identity, and delete/restore a cluster', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [member] } = await app.cluster('tasks', ['A']);
    const { cluster: other } = await app.cluster('other', ['X']);
    const path = `/api/clusters/${cluster.id}`;
    const created = await app.api('POST', `${path}/collaboration`, {
      action: 'task.create', operationId: 'user-task', title: 'Task', scope: 'Scope', acceptance: 'Done',
    });
    const taskId = created.task.id;
    assert.equal((await app.api('GET', `${path}/workspace`)).tasks[0].id, taskId);
    assert.equal((await app.api('GET', `${path}/workspace?status=pending&q=Task`)).tasks[0].id, taskId);
    assert.equal((await app.api('GET', `${path}/tasks/${taskId}`)).task.id, taskId);
    const message = await app.api('POST', `${path}/messages`, { body: 'Evidence', taskIds: [taskId] });
    const messageEvent = app.events.find((e) => e.kind === 'message' && (e.payload as any).message.id === message.id)!;
    assert.deepEqual((messageEvent.payload as any).message.taskIds, [taskId]);
    assert.deepEqual((messageEvent.payload as any).message.bookmarks, []);
    await app.api('POST', `${path}/collaboration`, { action: 'bookmark.set', operationId: 'user-star', messageId: message.id, labels: ['user'] });
    await app.api('POST', `${path}/messages`, { body: '@A hold' });
    await waitFor(() => turnsOf(app, member.id) > 0, 'member turn');
    const token = memberHeaders(app, member.id);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: token } }));
    const tools = (await client.listTools()).tools;
    for (const name of ['raise_attention', 'resolve_attention', 'set_task_summary']) {
      assert.ok(tools.find((tool) => tool.name === name)?.inputSchema.required?.includes('expectedRevision'), name);
    }
    const taskAction = tools.find((tool) => tool.name === 'task_action')!;
    // Optional in the schema only because watch and unwatch go without it; the Hub still requires it for every other action.
    assert.ok(!taskAction.inputSchema.required?.includes('expectedRevision'));
    assert.match(String((taskAction.inputSchema.properties as any).expectedRevision.description), /required for every action except watch and unwatch/);
    assert.ok(taskAction.inputSchema.required?.includes('taskId'));
    for (const name of ['manage_roles', 'set_cluster_paused']) {
      assert.ok(tools.find((tool) => tool.name === name)?.inputSchema.required?.includes('generation'), name);
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text;
      return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
    };
    const memberTask = await call('create_task', {
      operationId: 'member-task', title: 'Member task', scope: 'Scope', acceptance: 'Done', priority: 'high', actor: { kind: 'user' },
    });
    assert.equal(memberTask.data.task.createdBy, member.id);
    assert.equal(memberTask.data.task.priority, 'high');
    assert.equal(memberTask.data.task.requiresApproval, false);
    assert.equal(memberTask.data.task.mergeRequired, true);
    const claim = await call('task_action', { action: 'claim', operationId: 'claim', taskId: memberTask.data.task.id,
      expectedRevision: memberTask.data.task.revision });
    const start = await call('task_action', { action: 'start', operationId: 'start', taskId: memberTask.data.task.id,
      expectedRevision: claim.data.task.revision, assignmentId: claim.data.assignment.id });
    const submit = { action: 'submit', taskId: memberTask.data.task.id, expectedRevision: start.data.task.revision,
      assignmentId: claim.data.assignment.id, summary: 'result', commitSha: 'abcdef0', evidenceMessageIds: [message.id] };
    const wrongVersions = await call('task_action', { ...submit, operationId: 'submit-wrong', expectedDependencyVersions: { unknown: 'old' } });
    assert.equal(wrongVersions.isError, true);
    assert.match(wrongVersions.text, /DEPENDENCIES_CHANGED/);
    const submitted = await call('task_action', { ...submit, operationId: 'submit-current', expectedDependencyVersions: {} });
    assert.deepEqual(submitted.data.submission.dependencyVersions, {});
    assert.equal((await call('manage_roles', { action: 'create', operationId: 'no-role', name: 'admin', memberId: 'user', generation: 1 })).isError, true);
    // A business role's description is editable by the user and readable by members through list_tasks.
    const role = await app.api('POST', `${path}/collaboration`, {
      action: 'role.create', operationId: 'user-role', name: '专职验收者', description: '检查结果是否满足验收条件',
    });
    assert.equal(role.role.description, '检查结果是否满足验收条件');
    const withRole = await call('list_tasks', { include: ['roles'] });
    assert.equal(withRole.data.roles.find((item: any) => item.id === role.role.id).description, '检查结果是否满足验收条件');
    const editedRole = await app.api('POST', `${path}/collaboration`, {
      action: 'role.edit', operationId: 'user-role-edit', roleId: role.role.id, description: '',
    });
    assert.equal(editedRole.role.description, '');
    const clearedRole = await call('list_tasks', { include: ['roles'] });
    assert.equal(clearedRole.data.roles.find((item: any) => item.id === role.role.id).description, '');
    assert.equal((await call('list_tasks', { clusterId: other.id })).isError, true);
    assert.equal((await call('bookmark_message', { action: 'set', operationId: 'member-star', messageId: message.id, labels: ['member'], memberId: 'user' })).isError, false);
    const sent = await call('send_message', { body: 'Member evidence', taskIds: [taskId] });
    assert.deepEqual(sent.data.taskIds, [taskId]);

    const single = await app.api('GET', `${path}/messages/${message.id}`);
    assert.deepEqual(single.taskIds.sort(), [taskId, memberTask.data.task.id].sort());
    assert.deepEqual(single.bookmarks.map((b: any) => b.memberId).sort(), ['user', member.id].sort());
    const history = (await call('read_messages', { history: true })).data;
    const read = history.find((m: any) => m.id === message.id);
    assert.deepEqual(read.taskIds.sort(), [taskId, memberTask.data.task.id].sort());
    assert.deepEqual(read.bookmarks.map((b: any) => b.memberId).sort(), ['user', member.id].sort());
    assert.equal((await app.api('GET', `${path}/collections?memberId=user`)).items[0].message.id, message.id);
    assert.equal((await app.api('GET', `${path}/tasks/${taskId}/context`)).task.id, taskId);
    const wrongCluster = await rawFetch(`${app.url}/api/clusters/${other.id}/messages/${message.id}`, { headers: bearer(TEST_TOKEN) });
    assert.equal(wrongCluster.status, 404);

    const foreign = await rawFetch(`${app.url}${path}`, {
      method: 'DELETE', headers: { ...bearer(TEST_TOKEN), origin: 'https://foreign.example', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(foreign.status, 403);
    await app.api('DELETE', path, {});
    assert.ok(!(await app.api('GET', '/api/clusters')).some((c: any) => c.id === cluster.id));
    assert.ok((await app.api('GET', '/api/clusters?deleted=true')).some((c: any) => c.id === cluster.id));
    await assert.rejects(app.api('POST', `${path}/messages`, { body: 'after deletion' }));
    await app.api('POST', `${path}/restore`, {});
    assert.equal((await app.api('GET', `${path}/messages/${message.id}`)).id, message.id);
  } finally {
    hold.release();
    await client?.close();
    await app.close();
  }
});

test('HTTP user approval and MCP submission, immutable review and merge records share one lifecycle', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  const clients: Client[] = [];
  try {
    const { cluster, members: [executor, reviewer] } = await app.cluster('lifecycle', ['Executor', 'Reviewer']);
    const path = `/api/clusters/${cluster.id}`;
    await app.api('POST', `${path}/messages`, { body: '@all hold' });
    for (const member of [executor, reviewer]) {
      await waitFor(() => turnsOf(app, member.id) > 0, 'held member turn');
      const token = memberHeaders(app, member.id);
      const client = new Client({ name: 'lifecycle-test', version: '0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: token } }));
    }
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text;
      return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
    };
    const tools = (await clients[0].listTools()).tools;
    assert.equal(tools.length, 23);
    for (const name of ['get_batch', 'manage_batch']) assert.equal(tools.find((tool) => tool.name === name)?.inputSchema.type, 'object', name);
    const actionSchema = tools.find((tool) => tool.name === 'task_action')!.inputSchema as any;
    assert.ok(actionSchema.properties.action.enum.includes('merge'));
    assert.ok(!actionSchema.properties.action.enum.includes('approve'), 'user approval is not a member tool action');
    assert.equal(actionSchema.properties.reason.maxLength, 50_000);
    const created = await call(clients[0], 'create_task', { operationId: 'create', title: 'Code', scope: 'Scope', acceptance: 'Done',
      requiresApproval: true, mergeRequired: false, reviewer: { kind: 'member', memberId: reviewer.id } });
    assert.equal(created.isError, false, created.text);
    let task = created.data.task;
    assert.equal(task.requiresApproval, true);
    assert.equal(task.mergeRequired, false);
    assert.equal(task.proposalState, 'proposed');
    const act = async (client: Client, action: string, operationId: string, fields: Record<string, unknown> = {}) =>
      call(client, 'task_action', { action, operationId, taskId: task.id, expectedRevision: task.revision, ...fields });
    const edited = await act(clients[0], 'edit', 'edit-flags', { requiresApproval: true, mergeRequired: true });
    assert.equal(edited.isError, false, edited.text);
    task = edited.data.task;
    assert.equal(task.mergeRequired, true);
    const blocked = await act(clients[0], 'claim', 'blocked-claim');
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /APPROVAL_REQUIRED/);
    const cannotApprove = await act(clients[0], 'approve', 'member-approve', { verdict: 'approve', actor: { kind: 'user' } });
    assert.equal(cannotApprove.isError, true);
    assert.throws(() => app.hub.collaboration.command({ kind: 'member', memberId: executor.id }, cluster.id, {
      action: 'task.approve', operationId: 'direct-member-approve', taskId: task.id, expectedRevision: task.revision, verdict: 'approve',
    }), { code: 'FORBIDDEN' });
    task = (await app.api('POST', `${path}/collaboration`, {
      action: 'task.approve', operationId: 'user-approve', taskId: task.id, expectedRevision: task.revision, verdict: 'approve',
    })).task;
    assert.equal(task.proposalState, 'active');
    const claim = await act(clients[0], 'claim', 'claim');
    assert.equal(claim.isError, false, claim.text);
    task = claim.data.task;
    const assignmentId = claim.data.assignment.id;
    const start = await act(clients[0], 'start', 'start', { assignmentId });
    assert.equal(start.isError, false, start.text);
    task = start.data.task;
    const evidence = await app.api('POST', `${path}/messages`, { body: 'Validation evidence', taskIds: [task.id] });
    const submit = { assignmentId, summary: 'Implemented', evidenceMessageIds: [evidence.id] };
    const missingSha = await act(clients[0], 'submit', 'missing-sha', submit);
    assert.equal(missingSha.isError, true);
    assert.match(missingSha.text, /commitSha/);
    const first = await act(clients[0], 'submit', 'first', { ...submit, commitSha: 'ABCDEF0' });
    assert.equal(first.isError, false, first.text);
    assert.equal(first.data.submission.commitSha, 'abcdef0');
    task = first.data.task;
    const replacement = await act(clients[0], 'submit', 'replacement', { ...submit, commitSha: 'bcdef01' });
    assert.equal(replacement.isError, false, replacement.text);
    task = replacement.data.task;
    const stale = await act(clients[1], 'review', 'stale-review', {
      submissionId: first.data.submission.id, verdict: 'approve', reason: 'Reviewed old revision',
    });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /STALE_SUBMISSION/);
    const review = { submissionId: replacement.data.submission.id, verdict: 'approve' };
    const missingReason = await act(clients[1], 'review', 'missing-reason', review);
    assert.equal(missingReason.isError, true);
    assert.match(missingReason.text, /reason/);
    const oversized = await act(clients[1], 'review', 'oversized-reason', { ...review, reason: 'x'.repeat(50_001) });
    assert.equal(oversized.isError, true);
    const rejected = await act(clients[1], 'review', 'reject', { ...review, verdict: 'reject', reason: 'Please fix the result' });
    assert.equal(rejected.isError, false, rejected.text);
    task = rejected.data.task;
    const finalSubmission = await act(clients[0], 'submit', 'fixed', { ...submit, commitSha: 'cdef012' });
    assert.equal(finalSubmission.isError, false, finalSubmission.text);
    task = finalSubmission.data.task;
    const approved = await act(clients[1], 'review', 'review-approve', {
      submissionId: finalSubmission.data.submission.id, verdict: 'approve', reason: 'x'.repeat(50_000),
    });
    assert.equal(approved.isError, false, approved.text);
    task = approved.data.task;
    assert.equal(task.status, 'completed');
    // task_action merge needs a real merge in git (test/ship.test.ts); a ship report records the same fields.
    task = app.hub.collaboration.command({ kind: 'system' }, cluster.id, { action: 'task.shipped', operationId: 'merge', taskId: task.id,
      expectedRevision: task.revision, submissionId: finalSubmission.data.submission.id, commitSha: 'DEF0123', reason: 'Merged approved branch' }).task!;
    assert.equal(task.status, 'merged');
    assert.equal(task.mergedCommitSha, 'def0123');
    assert.equal(task.mergedSubmissionId, finalSubmission.data.submission.id);
    const details = (await call(clients[0], 'get_task', { taskId: task.id })).data;
    const viaHttp = await app.api('GET', `${path}/tasks/${task.id}`);
    for (const key of ['task', 'assignments', 'submissions', 'reviews', 'approvals', 'merges', 'attentions']) {
      assert.deepEqual(details[key], viaHttp[key], `HTTP and MCP return the same ${key}`);
    }
    const reviewEvent = details.events.find((event: any) => event.payload.action === 'task.review');
    assert.equal(reviewEvent.payload.verdict, 'approve');
    assert.equal(reviewEvent.payload.reason, undefined, 'the 50 000 character review text is only in reviews by default');
    const fullEvents = (await call(clients[0], 'get_task', { taskId: task.id, eventDetail: 'full' })).data.events;
    assert.equal(fullEvents.find((event: any) => event.payload.action === 'task.review').payload.reason.length, 50_000);
    for (const key of ['assignments', 'submissions', 'reviews', 'dependencies', 'attentions', 'events', 'approvals', 'merges']) {
      assert.ok(Array.isArray(details[key]), key);
    }
    assert.deepEqual(details.submissions.map((item: any) => [item.commitSha, item.superseded]),
      [['abcdef0', true], ['bcdef01', true], ['cdef012', false]]);
    assert.deepEqual(details.reviews.map((item: any) => [item.round, item.commitSha]), [[1, 'bcdef01'], [2, 'cdef012']]);
    assert.equal(details.reviews[1].reason.length, 50_000);
    assert.equal(details.approvals[0].definitionVersion, task.definitionVersion);
    assert.equal(details.merges[0].submissionId, task.approvedSubmissionId);
    assert.deepEqual(details.merges[0].recordedBy, { kind: 'system' });
    const page1 = (await call(clients[0], 'get_task', { taskId: task.id, limit: 1 })).data;
    const page2 = (await call(clients[0], 'get_task', { taskId: task.id, limit: 1, cursor: page1.nextCursor })).data;
    assert.equal(page2.reviews[0].round, 2, 'review rounds do not restart on the next page');
    assert.deepEqual(page2.approvals, []);
    assert.deepEqual(page2.merges, []);
    const [summary] = (await call(clients[0], 'list_tasks', { status: 'merged' })).data.tasks;
    assert.deepEqual(summary.id, task.id);
    assert.deepEqual([summary.status, summary.requiresApproval, summary.mergeRequired, summary.mergedCommitSha, summary.mergedSubmissionId, summary.approvedSubmissionId],
      ['merged', true, true, 'def0123', finalSubmission.data.submission.id, finalSubmission.data.submission.id]);
    assert.equal(summary.scope, undefined, 'the summary stays small');
    assert.deepEqual((await app.api('GET', `${path}/workspace?status=merged`)).tasks.map((item: any) => item.id), [task.id]);
  } finally {
    hold.release();
    for (const client of clients) await client.close();
    await app.close();
  }
});

test('MCP list_tasks finds a task by a short id prefix and keeps it first', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [member] } = await app.cluster('search', ['A']);
    const path = `/api/clusters/${cluster.id}`;
    const target = (await app.api('POST', `${path}/collaboration`, { action: 'task.create', operationId: 'target',
      title: 'Target', scope: 'plain', acceptance: 'done' })).task;
    const mention = (await app.api('POST', `${path}/collaboration`, { action: 'task.create', operationId: 'mention',
      title: 'Mention', scope: `refers to ${target.id}`, acceptance: 'done' })).task;
    const prefix = target.id.replace(/-/g, '').slice(0, 8);
    assert.equal((await app.api('GET', `${path}/workspace?q=${prefix}`)).tasks[0].id, target.id,
      'the HTTP workspace uses the same id search');
    await app.api('POST', `${path}/messages`, { body: '@A hold' });
    await waitFor(() => turnsOf(app, member.id) > 0, 'member turn');
    const token = memberHeaders(app, member.id);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: token } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      return JSON.parse((result.content as any)[0].text);
    };
    const byPrefix = await call('list_tasks', { q: prefix });
    assert.deepEqual(byPrefix.tasks.map((task: any) => task.id), [target.id, mention.id], 'the id hit comes first');
    const byFull = await call('list_tasks', { q: target.id });
    assert.equal(byFull.tasks[0].id, target.id);
    assert.equal((await call('list_tasks', { q: 'Target' })).tasks[0].id, target.id);
  } finally {
    hold.release();
    await client?.close();
    await app.close();
  }
});

test('MCP list_tasks filters several labels with AND and pages without repeats', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [member] } = await app.cluster('labels', ['A']);
    const path = `/api/clusters/${cluster.id}`;
    const create = (operationId: string, title: string, labels: string[]) =>
      app.api('POST', `${path}/collaboration`, { action: 'task.create', operationId, title, scope: 's', acceptance: 'a', labels });
    const both = await create('both', 'both', ['ui', 'high']);
    await create('ui', 'ui only', ['ui']);
    await create('high', 'high only', ['high']);
    for (let i = 0; i < 3; i++) await create(`page-${i}`, `page ${i}`, ['ui', 'page']);
    await app.api('POST', `${path}/messages`, { body: '@A hold' });
    await waitFor(() => turnsOf(app, member.id) > 0, 'member turn');
    const token = memberHeaders(app, member.id);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: token } }));
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client!.callTool({ name, arguments: args })) as any).content[0].text);
    const and = await call('list_tasks', { label: ['ui', 'high'] });
    assert.deepEqual(and.tasks.map((task: any) => task.id), [both.task.id], 'every label must match');
    const first = await call('list_tasks', { label: 'ui', limit: 2 });
    assert.equal(first.tasks.length, 2);
    assert.ok(first.nextCursor);
    const second = await call('list_tasks', { label: 'ui', limit: 2, cursor: first.nextCursor });
    assert.equal(second.tasks.length, 2);
    const ids = new Set([...first.tasks, ...second.tasks].map((task: any) => task.id));
    assert.equal(ids.size, 4, 'pages never repeat a task');
  } finally {
    hold.release();
    await client?.close();
    await app.close();
  }
});
