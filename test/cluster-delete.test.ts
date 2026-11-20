import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeDeliverContext } from '../src/core/types.ts';
import { startTestHub, waitFor } from './helpers.ts';
import { collaborationLinks } from '../src/plugins/tasks/package/hub/store.mts';

test('deletion retains history, cancels only queued deliveries and preserves a shared native session', async () => {
  const app = await startTestHub();
  const runs: { gate: PromiseWithResolvers<'completed'>; ctx: NativeDeliverContext }[] = [];
  app.native.deliver = async (_session, _text, ctx) => {
    const gate = Promise.withResolvers<'completed'>();
    runs.push({ gate, ctx }); return gate.promise;
  };
  try {
    const one = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const two = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'B' }]);
    const first = app.hub.sendFromUser(one.cluster.id, '@A running');
    const queued = app.hub.sendFromUser(one.cluster.id, '@A waiting');
    const sibling = app.hub.sendFromUser(two.cluster.id, '@B shared');
    assert.equal(runs.length, 1);
    const deleted = app.hub.deleteCluster(one.cluster.id);
    assert.ok(deleted.deletedAt);
    assert.deepEqual(app.hub.listDeletedClusters().map((c) => c.id), [one.cluster.id]);
    assert.deepEqual(app.hub.listClusters().map((c) => c.id), [two.cluster.id]);
    assert.deepEqual(app.hub.nativeCallers('mock', 's1').map((m) => m.id), [two.members[0].id]);
    assert.equal(runs[0].ctx.signal.aborted, false, 'an already started native call is not stopped');
    assert.equal(app.store.withDeliveries([first])[0].deliveries[0].state, 'running');
    assert.equal(app.store.withDeliveries([queued])[0].deliveries[0].state, 'failed');
    assert.equal(runs.length, 1, 'the sibling still waits for the same native conversation');
    assert.throws(() => app.hub.sendFromUser(one.cluster.id, 'new'), /unknown cluster/);
    assert.throws(() => app.hub.collaboration.query({ kind: 'user' }, one.cluster.id, { kind: 'workspace' }), /unknown cluster/);
    runs[0].gate.resolve('completed');
    await waitFor(() => runs.length === 2, 'sibling delivery');
    assert.equal(app.store.withDeliveries([first])[0].deliveries[0].outcome, 'completed');
    runs[1].gate.resolve('completed');
    await waitFor(() => app.store.withDeliveries([sibling])[0].deliveries[0].state === 'done');
    const restored = app.hub.restoreCluster(one.cluster.id);
    assert.equal(restored.deletedAt, null);
    const event = app.events.findLast((e) => e.kind === 'cluster' && e.clusterId === one.cluster.id)!;
    assert.deepEqual((event.payload as { members: { id: string }[] }).members.map((m) => m.id), [one.members[0].id]);
    assert.equal(app.store.withDeliveries([queued])[0].deliveries[0].state, 'failed', 'old work is not resent');
    assert.equal(app.hub.nativeCallers('mock', 's1').length, 2);
    assert.equal(app.hub.listMessages(one.cluster.id, 50).some((m) => m.id === first.id), true);
  } finally {
    for (const run of runs) run.gate.resolve('completed');
    await app.close();
  }
});

test('a paused cluster still records an offline native recipient and does not deliver on resume', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.hub.createCluster('offline', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    app.native.isOnline = () => false;
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'pause', paused: true });
    const message = app.hub.sendFromUser(cluster.id, '@A while offline');
    assert.equal(app.store.withDeliveries([message])[0].deliveries[0].state, 'offline');
    app.native.isOnline = () => true;
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'resume', paused: false });
    assert.equal(app.native.delivered.length, 0);
    assert.equal(app.store.withDeliveries([message])[0].deliveries[0].state, 'offline');
  } finally { await app.close(); }
});

test('an offline delivery generates one coordinator notice in the original message chain', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.hub.createCluster('coordination', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'C' },
    ]);
    const members = app.hub.listMembers(cluster.id);
    app.native.isOnline = (sessionId) => sessionId === 's2';
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'coordinator.set', operationId: 'enable', memberId: members[1].id, enabled: true, mode: 'execute',
    });
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.create', operationId: 'create', title: 'work', scope: 'scope', acceptance: 'done',
    }).task!;
    const original = app.hub.sendFromUser(cluster.id, '@A offline', undefined, undefined, [task.id]);
    const notices = app.hub.listMessages(cluster.id, 100).filter((m) => m.kind === 'system' && m.body.includes('投递失败或离线'));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].chainId, original.chainId);
    assert.equal(notices[0].hop, original.hop + 1);
    assert.deepEqual(collaborationLinks(app.store, notices[0].id), [task.id]);
  } finally { await app.close(); }
});
