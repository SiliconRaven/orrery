import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROLES } from '../src/core/default-roles.ts';
import type { CollaborationActor, CollaborationCommand } from '../src/core/collaboration-types.ts';
import { startTestHub } from './helpers.ts';

test('a new cluster creates the default roles atomically without assigning them', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members } = await app.hub.createCluster('defaults', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const roles = app.store.collaborationRoles(cluster.id);
    assert.deepEqual(roles.map(({ name, description }) => ({ name, description })), DEFAULT_ROLES);
    assert.deepEqual(roles.map((role) => role.name), ['设计者', '验收者', '执行者']);
    assert.ok(roles.every((role) => role.description));
    assert.deepEqual(app.store.collaborationMemberRoles(cluster.id), members.map((member) => ({ memberId: member.id, roleIds: [] })));
  } finally { await app.close(); }
});

test('a role-write failure rolls back the cluster, members and earlier default roles', async () => {
  const app = await startTestHub();
  const save = app.store.saveCollaborationRole;
  let clusterId = '';
  let writes = 0;
  try {
    app.store.saveCollaborationRole = (role) => {
      clusterId = role.clusterId;
      if (++writes === 2) throw new Error('injected default role failure');
      save.call(app.store, role);
    };
    await assert.rejects(app.hub.createCluster('rollback', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    ]), /injected default role failure/);
    assert.ok(clusterId);
    assert.equal(app.store.getCluster(clusterId), null);
    assert.deepEqual(app.store.listMembers(clusterId), []);
    assert.deepEqual(app.store.collaborationRoles(clusterId), []);
    app.store.saveCollaborationRole = save;
    const retry = await app.hub.createCluster('rollback', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    assert.equal(app.store.collaborationRoles(retry.cluster.id).length, 3);
  } finally { app.store.saveCollaborationRole = save; await app.close(); }
});

test('explicit completion fills only missing defaults or blank descriptions in old clusters', async () => {
  const app = await startTestHub();
  try {
    const cluster = { id: 'legacy', name: 'legacy', category: '', createdAt: new Date().toISOString() };
    app.store.insertCluster(cluster, []);
    assert.deepEqual(app.store.collaborationRoles(cluster.id), [], 'existing groups are not automatically migrated');
    const user: CollaborationActor = { kind: 'user' };
    const send = (command: CollaborationCommand) => app.hub.collaboration.command(user, cluster.id, command);
    const designer = send({ action: 'role.create', operationId: 'designer', name: '设计者', description: '' }).role!;
    const reviewer = send({ action: 'role.create', operationId: 'reviewer', name: '验收者', description: '自定义验收说明' }).role!;
    const other = send({ action: 'role.create', operationId: 'other', name: '自定义', description: '保留' }).role!;
    const ensure: CollaborationCommand = { action: 'role.ensure_defaults', operationId: 'ensure' };
    const first = send(ensure);
    const roles = app.store.collaborationRoles(cluster.id);
    assert.equal(roles.length, 4);
    assert.equal(roles.find((role) => role.name === '设计者')!.id, designer.id);
    assert.equal(roles.find((role) => role.name === '设计者')!.description, DEFAULT_ROLES[0].description);
    assert.equal(roles.find((role) => role.id === reviewer.id)!.description, '自定义验收说明');
    assert.equal(roles.find((role) => role.id === other.id)!.description, '保留');
    assert.equal(roles.find((role) => role.name === '执行者')!.description, DEFAULT_ROLES[2].description);
    assert.deepEqual(send(ensure), first, 'same operation retries without changes');
    send({ ...ensure, operationId: 'ensure-again' });
    assert.deepEqual(app.store.collaborationRoles(cluster.id), roles, 'a new operation is also idempotent');
  } finally { await app.close(); }
});

test('manual completion obeys coordinator permissions, generations and suggestion mode', async () => {
  const app = await startTestHub();
  try {
    app.hub.setPaused(true);
    const { cluster, members: [a, b] } = await app.hub.createCluster('permissions', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const user: CollaborationActor = { kind: 'user' };
    const coordinator: CollaborationActor = { kind: 'member', memberId: a.id };
    const member: CollaborationActor = { kind: 'member', memberId: b.id };
    let serial = 0;
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command(actor, cluster.id, { ...command, operationId: `defaults-${++serial}` });
    const designer = app.store.collaborationRoles(cluster.id).find((role) => role.name === '设计者')!;
    send(user, { action: 'role.delete', roleId: designer.id });
    assert.throws(() => send(member, { action: 'role.ensure_defaults' }), /not permitted/);
    let policy = send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute',
      permissions: { roleManagement: false } }).coordinator!;
    assert.throws(() => send(coordinator, { action: 'role.ensure_defaults', generation: policy.generation }), /permission is disabled/);
    assert.throws(() => send(coordinator, { action: 'role.ensure_defaults', generation: policy.generation - 1 }), /policy changed/);
    policy = send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'suggest' }).coordinator!;
    const suggestion = send(coordinator, { action: 'role.ensure_defaults', generation: policy.generation });
    assert.equal(suggestion.suggestion?.action, 'role.ensure_defaults');
    assert.ok(!app.store.collaborationRoles(cluster.id).some((role) => role.name === '设计者'));
    policy = send(user, { action: 'coordinator.set', memberId: a.id, enabled: true, mode: 'execute' }).coordinator!;
    send(coordinator, { action: 'role.ensure_defaults', generation: policy.generation });
    const restored = app.store.collaborationRoles(cluster.id).find((role) => role.name === '设计者')!;
    assert.notEqual(restored.id, designer.id);
    send(user, { action: 'role.edit', roleId: restored.id, description: '自己的说明' });
    assert.equal(app.store.collaborationRoles(cluster.id).find((role) => role.id === restored.id)!.description, '自己的说明');
    send(user, { action: 'task.create', title: 'work', scope: 'scope', acceptance: 'done', executeRoleIds: [restored.id] });
    assert.throws(() => send(user, { action: 'role.delete', roleId: restored.id }), /required by a task/);
  } finally { await app.close(); }
});
