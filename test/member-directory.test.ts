import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nativeHeaders, holdScript, startTestHub, waitFor } from './helpers.ts';

test('task results carry role names and errors name the member and the missing roles', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.cluster('member-directory', ['A', 'B']);
    const user = { kind: 'user' as const };
    let serial = 0;
    const send = (actor: any, command: any) => app.hub.collaboration.command(actor, cluster.id,
      { operationId: `dir-${++serial}`, ...command });
    const as = (member: any) => ({ kind: 'member' as const, memberId: member.id });
    const workspace = app.hub.collaboration.query(user, cluster.id, { kind: 'workspace' }) as any;
    const executor = workspace.roles.find((role: any) => role.name === '执行者')!;
    const reviewer = workspace.roles.find((role: any) => role.name === '验收者')!;
    send(user, { action: 'member.roles', memberId: a.id, roleIds: [executor.id, reviewer.id] });
    const created = send(user, { action: 'task.create', title: 'named roles', scope: 's', acceptance: 'a',
      executeRoleIds: [executor.id], reviewRoleIds: [reviewer.id], reviewer: as(a) });
    assert.deepEqual(created.task!.executeRoles, [{ id: executor.id, name: '执行者' }]);
    assert.deepEqual(created.task!.reviewRoles, [{ id: reviewer.id, name: '验收者' }]);
    // Deleting a role keeps a clear placeholder instead of failing.
    const temp = send(user, { action: 'role.create', name: '临时角色' }).role!;
    const withTemp = send(user, { action: 'task.create', title: 'temp role', scope: 's', acceptance: 'a',
      executeRoleIds: [temp.id] });
    // A role cannot be deleted while a task still references it; simulate a data drift for the display fallback.
    app.store.db.prepare('DELETE FROM collaboration_roles WHERE id = ?').run(temp.id);
    assert.deepEqual(withTemp.task!.executeRoles, [{ id: temp.id, name: '临时角色' }]);
    const afterDelete = app.hub.collaboration.query(user, cluster.id, { kind: 'task', taskId: withTemp.task!.id });
    assert.ok('task' in afterDelete && afterDelete.task.executeRoles?.[0].id === temp.id);
    assert.match(afterDelete.task.executeRoles![0].name, /已删除角色/);
    const revision = afterDelete.task.revision;
    // B lacks the execute role: the message names B and the role.
    const task = send(user, { action: 'task.edit', taskId: created.task!.id, expectedRevision: revision,
      reviewRoleIds: [], reviewer: as(a) }).task!;
    assert.throws(() => send(as(b), { action: 'task.claim', taskId: task.id, expectedRevision: task.revision }),
      (error: any) => /B lacks roles: 执行者/.test(error.message) && error.code === 'ROLE_REQUIRED');
    // Reviewer lacking the review role also gets a readable error.
    const reviewTask = send(user, { action: 'task.create', title: 'review roles', scope: 's', acceptance: 'a',
      reviewer: as(a), reviewRoleIds: [reviewer.id] }).task!;
    // A loses the reviewer role after the task requires it: the review fails with a readable message.
    send(user, { action: 'member.roles', memberId: a.id, roleIds: [executor.id] });
    let flow = send(user, { action: 'task.nominate', taskId: reviewTask.id, expectedRevision: reviewTask.revision, memberId: b.id }).task!;
    const claim = send(as(b), { action: 'task.claim', taskId: flow.id, expectedRevision: flow.revision });
    flow = send(as(b), { action: 'task.start', taskId: claim.task!.id, expectedRevision: claim.task!.revision,
      assignmentId: claim.assignment!.id }).task!;
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    const submittedFlow = send(as(b), { action: 'task.submit', commitSha: 'abcdef0', taskId: flow.id, expectedRevision: flow.revision,
      assignmentId: claim.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    assert.throws(() => send(as(a), { action: 'task.review', taskId: submittedFlow.task!.id,
      expectedRevision: submittedFlow.task!.revision, submissionId: submittedFlow.submission!.id, verdict: 'approve', reason: 'Independent review passed' }),
      (error: any) => /reviewer A lacks roles:/.test(error.message) && error.code === 'ROLE_REQUIRED');
    // STALE_POLICY names the current generation.
    const setup = send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' });
    const generation = setup.coordinator!.generation;
    assert.throws(() => send(as(a), { action: 'role.create', name: 'late', generation: generation - 1 }),
      (error: any) => new RegExp(`coordinator policy changed \\(current generation ${generation}\\)`).test(error.message)
        && error.code === 'STALE_POLICY');
    // Clearing the coordinator keeps its generation: a stale member action names that number, never "undefined".
    send(user, { action: 'coordinator.set', memberId: null });
    const cleared = app.hub.collaboration.query(user, cluster.id, { kind: 'workspace' }) as any;
    const clearedGeneration = cleared.generation;
    assert.equal(cleared.coordinator, null);
    assert.equal(typeof clearedGeneration, 'number');
    assert.throws(() => send(as(a), { action: 'role.create', name: 'after clear', generation: clearedGeneration - 1 }),
      (error: any) => error.code === 'STALE_POLICY'
        && new RegExp(`current generation ${clearedGeneration}`).test(error.message)
        && !/undefined/.test(error.message));
    // REVIEW_NOT_INDEPENDENT names the member who cannot do the work they would review.
    const own = send(user, { action: 'task.create', title: 'own result', scope: 's', acceptance: 'a', reviewer: as(b) }).task!;
    assert.throws(() => send(user, { action: 'task.assign', taskId: own.id, expectedRevision: own.revision, memberId: b.id }),
      (error: any) => /B is the task reviewer/.test(error.message) && error.code === 'REVIEW_NOT_INDEPENDENT');
  } finally { await app.close(); }
});

test('list_agents carries memberId, role names and per-member load', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [a, b] } = await app.cluster('member-load', ['A', 'B']);
    const user = { kind: 'user' as const };
    let serial = 0;
    const send = (actor: any, command: any) => app.hub.collaboration.command(actor, cluster.id,
      { operationId: `load-${++serial}`, ...command });
    const as = (member: any) => ({ kind: 'member' as const, memberId: member.id });
    const role = (app.hub.collaboration.query(user, cluster.id, { kind: 'workspace' }) as any).roles
      .find((item: any) => item.name === '执行者');
    send(user, { action: 'member.roles', memberId: a.id, roleIds: [role.id] });
    // A long completed history before the live task must not hide it from the load counts (no page limit in list_agents).
    app.store.transaction(() => {
      const insert = app.store.db.prepare('INSERT INTO collaboration_tasks (id, cluster_id, data_json) VALUES (?, ?, ?)');
      const history = JSON.stringify({ status: 'completed', proposalState: 'active' });
      for (let i = 0; i < 10_050; i++) insert.run(`history-${i}`, cluster.id, history);
    });
    // A: nominated (pending), accepted; B: working; A: reviewing.
    const nominated = send(user, { action: 'task.create', title: 'nominated', scope: 's', acceptance: 'a' }).task!;
    send(user, { action: 'task.nominate', taskId: nominated.id, expectedRevision: nominated.revision, memberId: a.id });
    const accepted = send(user, { action: 'task.create', title: 'accepted', scope: 's', acceptance: 'a' }).task!;
    send(user, { action: 'task.nominate', taskId: accepted.id, expectedRevision: accepted.revision, memberId: a.id });
    send(as(a), { action: 'task.claim', taskId: accepted.id, expectedRevision: accepted.revision + 1 });
    const working = send(user, { action: 'task.create', title: 'working', scope: 's', acceptance: 'a' }).task!;
    send(user, { action: 'task.nominate', taskId: working.id, expectedRevision: working.revision, memberId: b.id });
    const claimed = send(as(b), { action: 'task.claim', taskId: working.id, expectedRevision: working.revision + 1 });
    send(as(b), { action: 'task.start', taskId: claimed.task!.id, expectedRevision: claimed.task!.revision, assignmentId: claimed.assignment!.id });
    const reviewing = send(user, { action: 'task.create', title: 'reviewing', scope: 's', acceptance: 'a', reviewer: as(a) }).task!;
    send(user, { action: 'task.nominate', taskId: reviewing.id, expectedRevision: reviewing.revision, memberId: b.id });
    const rClaim = send(as(b), { action: 'task.claim', taskId: reviewing.id, expectedRevision: reviewing.revision + 1 });
    const rStart = send(as(b), { action: 'task.start', taskId: rClaim.task!.id, expectedRevision: rClaim.task!.revision, assignmentId: rClaim.assignment!.id });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    send(as(b), { action: 'task.submit', commitSha: 'abcdef0', taskId: rStart.task!.id, expectedRevision: rStart.task!.revision,
      assignmentId: rClaim.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id] });
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hold' });
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: nativeHeaders(app, a.id) } }));
    const result = await client.callTool({ name: 'list_agents', arguments: {} });
    const members = JSON.parse((result.content as any)[0].text);
    const byName = Object.fromEntries(members.map((member: any) => [member.name, member]));
    assert.equal(byName.A.memberId, a.id);
    assert.equal(byName.A.load.assigned, 2);
    assert.equal(byName.A.load.reviewing, 1);
    assert.equal(byName.A.load.working, 0);
    assert.deepEqual(byName.A.roles, [{ id: role.id, name: '执行者' }]);
    assert.equal(byName.B.load.working, 1);
    assert.equal(byName.B.load.assigned, 0);
  } finally {
    hold.release();
    await client?.close();
    await app.close();
  }
});
