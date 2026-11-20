import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CollaborationActor, CollaborationCommand, TaskPermissions, WorkspaceResult } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { memberHeaders, rawFetch, startTestHub, tempDir } from './helpers.ts';

const USER = { kind: 'user' } as const;
const asMember = (memberId: string) => ({ kind: 'member' as const, memberId });
const definition = { title: 'Task', scope: 'Scope', acceptance: 'Done', mergeRequired: false };
const defaults: TaskPermissions = { createRoleIds: [], executeRoleIds: [], reviewRoleIds: [] };

function fixture(path = ':memory:') {
  const store = new Store(path, new PluginHost(officialPlugins));
  const insert = (id: string, names: string[]) => store.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' },
    names.map((name) => ({ id: name, clusterId: id, name, avatar: null, harness: 'mock', model: null, effort: null,
      workerSessionId: 'session-' + name, cwd: '/tmp', origin: 'attached' as const, removedAt: null })));
  insert('test', ['creator', 'executor', 'reviewer', 'outsider', 'coord']);
  insert('other', []);
  const hub = new Hub({ store, nativeAdapters: {} });
  const command = (actor: CollaborationActor, body: Omit<CollaborationCommand, 'operationId'>, cluster = 'test') =>
    hub.collaboration.command(actor, cluster, { ...body, operationId: randomUUID() });
  const workspace = (cluster = 'test') => hub.collaboration.query(USER, cluster, { kind: 'workspace' }) as WorkspaceResult;
  const role = (name: string, members: string[], cluster = 'test') => {
    const { role } = command(USER, { action: 'role.create', name }, cluster);
    for (const member of members) {
      const held = store.collaborationMemberRoles(cluster).find((m) => m.memberId === member)?.roleIds ?? [];
      command(USER, { action: 'member.roles', memberId: member, roleIds: [...held, role!.id] }, cluster);
    }
    return role!.id;
  };
  const set = (fields: Partial<TaskPermissions>) => command(USER, { action: 'tasks.permissions', taskPermissions: { ...defaults, ...fields } });
  return { hub, store, command, workspace, role, set };
}

const roleError = (field: string, name: string) => ({ code: 'ROLE_REQUIRED', message: new RegExp('group task permissions.*' + field + '.*' + name) });

test('role deletion preserves saved group task permissions until the user removes the role from them', () => {
  const path = join(tempDir(), 'permissions.db');
  const initial = fixture(path);
  const blocked = { code: 'ROLE_IN_USE', message: /Remove it from Task permissions first/ };
  let roleId: string;
  try {
    roleId = initial.role('author', ['creator']);
    initial.set({ createRoleIds: [roleId] });
    const response = initial.command(USER, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
      permissions: { roleManagement: true } });
    assert.throws(() => initial.command(USER, { action: 'role.delete', roleId }), blocked);
    assert.throws(() => initial.command(asMember('coord'), { action: 'role.delete', roleId, generation: response.coordinator!.generation }), blocked);
    assert.deepEqual(initial.workspace().taskPermissions?.createRoleIds, [roleId]);
  } finally { initial.store.close(); }

  const disabled = new Store(path, new PluginHost(officialPlugins, ['tasks', 'coordinator']));
  try {
    const hub = new Hub({ store: disabled, nativeAdapters: {} });
    assert.equal(disabled.tasks, null);
    assert.throws(() => hub.collaboration.command(USER, 'test', { action: 'role.delete', operationId: randomUUID(), roleId }), blocked);
  } finally { disabled.close(); }

  const enabled = new Store(path, new PluginHost(officialPlugins));
  try {
    const hub = new Hub({ store: enabled, nativeAdapters: {} });
    hub.collaboration.command(USER, 'test', { action: 'tasks.permissions', operationId: randomUUID(), taskPermissions: defaults });
    hub.collaboration.command(USER, 'test', { action: 'role.delete', operationId: randomUUID(), roleId });
    assert.ok(!enabled.collaborationRoles('test').some((role) => role.id === roleId));
  } finally { enabled.close(); }
});

test('defaults, scope isolation and user-only edits; coordinator create bypass retains taskPlanning', () => {
  const { store, command, workspace, role, set } = fixture();
  try {
    const outsider = asMember('outsider');
    const coordinator = asMember('coord');
    assert.deepEqual(workspace().taskPermissions, defaults);
    assert.equal(command(outsider, { action: 'task.create', ...definition }).task!.assignedMemberId, 'outsider');
    const create = role('author', ['creator']);
    const another = role('other-author', [], 'other');
    assert.throws(() => set({ createRoleIds: [another] }), { code: 'OUT_OF_SCOPE' });
    const { coordinator: config } = command(USER, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
      permissions: { taskPlanning: true } });
    set({ createRoleIds: [create] });
    assert.deepEqual(workspace('other').taskPermissions, defaults);
    const write = { action: 'tasks.permissions', taskPermissions: defaults, generation: config!.generation };
    assert.throws(() => command(outsider, write), { code: 'FORBIDDEN' });
    assert.throws(() => command(coordinator, write), { code: 'FORBIDDEN' });
    assert.throws(() => command(outsider, { action: 'task.create', ...definition }), roleError('createRoleIds', 'author'));
    assert.throws(() => command(coordinator, { action: 'task.create', ...definition, generation: config!.generation }), roleError('createRoleIds', 'author'));
    assert.ok(command(USER, { action: 'task.create', ...definition }).task);
    assert.ok(command(asMember('creator'), { action: 'task.create', ...definition }).task);
    const allow = { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute' as const,
      permissions: { taskPlanning: true }, taskPlanningRoleBypass: true };
    assert.throws(() => command(coordinator, { ...allow, generation: config!.generation }), { code: 'FORBIDDEN' });
    const bypass = command(USER, allow).coordinator!;
    assert.ok(command(coordinator, { action: 'task.create', ...definition, generation: bypass.generation }).task);
    const removed = command(USER, { action: 'coordinator.set', memberId: 'coord', enabled: true, mode: 'execute',
      permissions: { taskPlanning: false } }).coordinator!;
    assert.throws(() => command(coordinator, { action: 'task.create', ...definition, generation: removed.generation }), { code: 'FORBIDDEN' });
  } finally { store.close(); }
});

test('group execution uses any listed role and also requires all roles on the task', () => {
  const { store, command, role, set } = fixture();
  const executor = asMember('executor'), outsider = asMember('outsider');
  try {
    const groupA = role('group-a', []);
    const groupB = role('group-b', ['executor']);
    const perTask = role('specialist', ['executor', 'outsider']);
    const perTaskExtra = role('second-specialty', ['outsider']);
    const old = command(USER, { action: 'task.create', ...definition, memberId: 'outsider', executeRoleIds: [perTask] }).task!;
    set({ executeRoleIds: [groupA, groupB] });
    const gate = roleError('executeRoleIds', 'group-b');
    assert.throws(() => command(outsider, { action: 'task.start', taskId: old.id, expectedRevision: old.revision }), gate);
    assert.throws(() => command(USER, { action: 'task.create', ...definition, memberId: 'outsider', executeRoleIds: [perTask] }), gate);
    assert.equal(command(outsider, { action: 'task.create', ...definition }).task!.assignedMemberId, null, 'a creator without an execute role leaves the task unassigned');
    const pending = command(USER, { action: 'task.create', ...definition, executeRoleIds: [perTask] }).task!;
    const taskRef = { taskId: pending.id, expectedRevision: pending.revision };
    assert.throws(() => command(USER, { action: 'task.assign', ...taskRef, memberId: 'outsider' }), gate);
    assert.throws(() => command(outsider, { action: 'task.claim', ...taskRef }), gate);
    assert.throws(() => command(USER, { action: 'task.create', ...definition, memberId: 'executor', executeRoleIds: [perTask, perTaskExtra] }),
      { code: 'ROLE_REQUIRED', message: /second-specialty/ });
    const claimed = command(executor, { action: 'task.claim', ...taskRef }).task!;
    const started = command(executor, { action: 'task.start', taskId: claimed.id, expectedRevision: claimed.revision });
    const workingRef = { taskId: claimed.id, expectedRevision: started.task!.revision, assignmentId: started.assignment!.id };
    assert.throws(() => command(executor, { action: 'task.handoff', ...workingRef, memberId: 'outsider', reason: 'handoff' }), gate);
    const takeover = command(USER, { action: 'task.create', ...definition, reviewer: asMember('outsider') }).task!;
    const takeoverClaimed = command(executor, { action: 'task.claim', taskId: takeover.id, expectedRevision: takeover.revision }).task!;
    const takeoverStarted = command(executor, { action: 'task.start', taskId: takeover.id, expectedRevision: takeoverClaimed.revision });
    const takeoverSubmitted = command(executor, {
      action: 'task.submit',
      taskId: takeover.id,
      expectedRevision: takeoverStarted.task!.revision,
      assignmentId: takeoverStarted.assignment!.id,
      summary: 'ready for review',
    }).task!;
    assert.throws(() => command(outsider, { action: 'task.takeover', taskId: takeover.id, expectedRevision: takeoverSubmitted.revision, reason: 'take over' }), gate);
    set({ executeRoleIds: [groupA] });
    assert.equal(command(executor, { action: 'task.submit', ...workingRef, summary: 'already assigned' }).task!.status, 'review');
  } finally { store.close(); }
});

test('group reviewer eligibility is live at assignment and review, including batches; self review only needs execution', () => {
  const { store, command, role, set } = fixture();
  const executor = asMember('executor'), reviewer = asMember('reviewer'), outsider = asMember('outsider');
  try {
    const review = role('reviewer-role', ['reviewer']);
    const execute = role('executor-role', ['executor']);
    const later = role('later-review', []);
    set({ executeRoleIds: [execute], reviewRoleIds: [review] });
    const gate = roleError('reviewRoleIds', 'reviewer-role');
    assert.throws(() => command(USER, { action: 'task.create', ...definition, reviewer: outsider }), gate);
    const task = command(USER, { action: 'task.create', ...definition, memberId: 'executor', reviewer }).task!;
    assert.throws(() => command(USER, { action: 'task.edit', taskId: task.id, expectedRevision: task.revision, reviewer: outsider }), gate);
    assert.throws(() => command(USER, { action: 'batch.create', title: 'Blocked', reviewer: outsider }), gate);
    const made = command(USER, { action: 'batch.create', title: 'Batch', reviewer });
    const batch = (made as { batch?: { id: string } }).batch!;
    const pending = command(USER, { action: 'task.create', ...definition, mergeRequired: true }).task!;
    const started = command(executor, { action: 'task.start', taskId: task.id, expectedRevision: task.revision });
    const submitted = command(executor, { action: 'task.submit', taskId: task.id, expectedRevision: started.task!.revision,
      assignmentId: started.assignment!.id, summary: 'result' });
    const self = command(USER, { action: 'task.create', ...definition, memberId: 'executor', reviewer: { kind: 'self' } }).task!;
    const selfStart = command(executor, { action: 'task.start', taskId: self.id, expectedRevision: self.revision });
    set({ executeRoleIds: [execute], reviewRoleIds: [later] });
    const laterGate = roleError('reviewRoleIds', 'later-review');
    assert.throws(() => command(USER, { action: 'batch.add', batchId: batch.id, taskId: pending.id, expectedRevision: pending.revision }), laterGate);
    const reviewCommand = { action: 'task.review', taskId: task.id, expectedRevision: submitted.task!.revision,
      submissionId: submitted.submission!.id, verdict: 'approve' as const };
    assert.throws(() => command(reviewer, reviewCommand), laterGate);
    assert.equal(command(USER, reviewCommand).task!.status, 'completed');
    assert.equal(command(executor, { action: 'task.submit', taskId: self.id, expectedRevision: selfStart.task!.revision,
      assignmentId: selfStart.assignment!.id, summary: 'self-checked' }).task!.status, 'completed');
  } finally { store.close(); }
});

test('web task permissions require API authentication and MCP can opt into the read-only view', async () => {
  const app = await startTestHub();
  const client = new Client({ name: 'permissions-fixture', version: '1.0.0' });
  try {
    const { cluster, members: [member] } = await app.cluster('permission fixture', ['A']);
    const root = '/api/clusters/' + cluster.id;
    const role = (await app.api('POST', root + '/collaboration', { action: 'role.create', operationId: 'role', name: 'eligible' })).role.id;
    const taskPermissions = { ...defaults, createRoleIds: [role] };
    const command = { action: 'tasks.permissions', operationId: 'policy', taskPermissions };
    const response = await rawFetch(app.url + root + '/collaboration', { method: 'POST',
      headers: { 'content-type': 'application/json', ...memberHeaders(app, member.id) }, body: JSON.stringify(command) });
    assert.equal(response.status, 401);
    assert.deepEqual((await app.api('POST', root + '/collaboration', command)).taskPermissions, taskPermissions);
    assert.deepEqual((await app.api('GET', root + '/workspace')).taskPermissions, taskPermissions);
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, member.id) } }));
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'list_tasks', arguments: args });
      const content = (result.content as { type: string; text: string }[])[0];
      assert.equal(content.type, 'text');
      return JSON.parse(content.text);
    };
    assert.equal((await call({})).taskPermissions, undefined);
    assert.deepEqual((await call({ include: ['taskPermissions'] })).taskPermissions, taskPermissions);
    assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'tasks.permissions'));
  } finally {
    await client.close();
    await app.close();
  }
});
