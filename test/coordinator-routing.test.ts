import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CoordinatorPolicy } from '../src/core/collaboration-types.ts';
import { coordinatorSnapshot, saveCoordinator } from '../src/plugins/coordinator/package/hub/store.mts';
import { startTestHub, waitFor } from './helpers.ts';

async function fixture(options: Parameters<typeof startTestHub>[0] = {}) {
  const app = await startTestHub({ ...options });
  const { cluster, members: [a, b] } = await app.hub.createCluster('routing', [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
  ]);
  const policy = (memberId: string | null, enabled = true, mode: CoordinatorPolicy['mode'] = 'execute') => {
    const previous = coordinatorSnapshot(app.store, cluster.id);
    const generation = previous.generation + 1;
    saveCoordinator(app.store, cluster.id, memberId === null ? null : {
      memberId, enabled, mode, generation,
      permissions: { taskPlanning: true, assignment: true, roleManagement: true, reviewerManagement: true,
        knowledgeCommunication: true, recovery: true, cancelReopen: false, deliveryControl: false },
    }, generation);
  };
  const deliveries = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries;
  return { app, cluster, a, b, policy, deliveries };
}

test('unaddressed user messages route once to the enabled coordinator, without changing mentions', async () => {
  const { app, cluster, a, b, policy, deliveries } = await fixture();
  try {
    app.hub.setPaused(true);
    const none = app.hub.sendFromUser(cluster.id, 'no coordinator');
    assert.deepEqual(deliveries(none.id), []);
    policy(a.id, false);
    const disabled = app.hub.sendFromUser(cluster.id, 'disabled');
    assert.deepEqual(deliveries(disabled.id), []);
    policy(a.id, true, 'suggest');
    const plain = app.hub.sendFromUser(cluster.id, 'please coordinate');
    assert.deepEqual(plain.mentions, []);
    assert.deepEqual(deliveries(plain.id).map((d) => d.memberId), [a.id]);
    const unknown = app.hub.sendFromUser(cluster.id, 'please @unknown check');
    assert.deepEqual(deliveries(unknown.id), []);
    app.hub.updateMember(b.id, { name: 'Bee' });
    const oldName = app.hub.sendFromUser(cluster.id, '@B check');
    assert.deepEqual(deliveries(oldName.id), []);
    const email = app.hub.sendFromUser(cluster.id, 'contact a@example.com');
    assert.deepEqual(deliveries(email.id).map((d) => d.memberId), [a.id]);
    const mentioned = app.hub.sendFromUser(cluster.id, '@Bee only B');
    const direct = app.hub.sendFromUser(cluster.id, 'direct to B', [b.id]);
    assert.deepEqual(deliveries(mentioned.id).map((d) => d.memberId), [b.id]);
    assert.deepEqual(deliveries(direct.id).map((d) => d.memberId), [b.id]);
    const member = app.hub.sendFromMember(b.id, 'member chat').message;
    assert.deepEqual(deliveries(member.id), [], 'unaddressed member chat stays in the record');
    const explicitly = app.hub.sendFromUser(cluster.id, '@A hello');
    const all = app.hub.sendFromUser(cluster.id, '@all hello');
    assert.equal(deliveries(explicitly.id).filter((d) => d.memberId === a.id).length, 1);
    assert.equal(deliveries(all.id).filter((d) => d.memberId === a.id).length, 1);
    policy(null);
    const revoked = app.hub.sendFromUser(cluster.id, 'revoked');
    assert.deepEqual(deliveries(revoked.id), []);

    app.hub.setPaused(false);
    await waitFor(() => deliveries(plain.id)[0].state === 'done', 'coordinator delivery');
    const envelope = app.native.delivered.find((entry) => entry.text.includes(plain.id))!.text;
    assert.match(envelope, /这是群里没有点名任何人的用户消息；你作为本群协调员收到它，请判断其中是否有需要安排的工作。/);
    assert.equal(app.store.getMessage(plain.id)!.body, 'please coordinate');
  } finally { await app.close(); }
});

test('paused unaddressed deliveries stay with the old coordinator across restart and are not transferred', async () => {
  const first = await fixture();
  const { app, cluster, a, b, policy, deliveries } = first;
  app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'pause-routing', paused: true });
  policy(a.id);
  const old = app.hub.sendFromUser(cluster.id, 'old coordinator');
  policy(b.id);
  const newer = app.hub.sendFromUser(cluster.id, 'new coordinator');
  assert.deepEqual(deliveries(old.id).map((d) => [d.memberId, d.state]), [[a.id, 'queued']]);
  assert.deepEqual(deliveries(newer.id).map((d) => [d.memberId, d.state]), [[b.id, 'queued']]);
  await app.close();

  const restarted = await startTestHub({ dir: app.dir });
  try {
    restarted.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'resume-routing', paused: false });
    await waitFor(() => restarted.native.delivered.length >= 2, 'queued deliveries after restart');
    const oldEnvelope = restarted.native.delivered.find((entry) => entry.text.includes(old.id))!;
    const newEnvelope = restarted.native.delivered.find((entry) => entry.text.includes(newer.id))!;
    assert.equal(oldEnvelope.sessionId, 's1');
    assert.equal(newEnvelope.sessionId, 's2');
    assert.match(oldEnvelope.text, /这是群里没有点名任何人的用户消息；你作为本群协调员收到它/);
    assert.match(newEnvelope.text, /这是群里没有点名任何人的用户消息；你作为本群协调员收到它/);
  } finally { await restarted.close(); }
});

test('an offline coordinator is not sent an old message after coming online', async () => {
  const { app, cluster, a, policy, deliveries } = await fixture();
  try {
    let online = false;
    app.native.isOnline = () => online;
    policy(a.id);
    const message = app.hub.sendFromUser(cluster.id, 'while offline');
    assert.equal(deliveries(message.id)[0].state, 'offline');
    online = true;
    app.hub.setPaused(true);
    app.hub.setPaused(false);
    await sleep(30);
    assert.equal(deliveries(message.id)[0].state, 'offline');
    assert.equal(app.native.delivered.length, 0);
    assert.ok(app.hub.readMessages(a.id).some((m) => m.id === message.id));
  } finally { await app.close(); }
});

test('the existing hop, chain-turn and hourly guards apply to coordinator deliveries', async (t) => {
  await t.test('hop limit', async () => {
    const { app, cluster, a, policy, deliveries } = await fixture({ limits: { maxHops: 0 } });
    try {
      policy(a.id);
      const message = app.hub.sendFromUser(cluster.id, 'start');
      await waitFor(() => deliveries(message.id)[0].state === 'done', 'initial delivery');
      assert.throws(() => app.hub.sendFromMember(a.id, '@B onward', message.id), /hop 1 exceeds/);
      assert.ok(app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_hops'));
    } finally { await app.close(); }
  });
  await t.test('chain turn limit', async () => {
    const { app, cluster, a, policy, deliveries } = await fixture({ limits: { maxTurnsPerChain: 0 } });
    try {
      policy(a.id);
      const message = app.hub.sendFromUser(cluster.id, 'blocked by chain limit');
      await waitFor(() => deliveries(message.id)[0].state === 'failed', 'chain guard');
      assert.equal(deliveries(message.id)[0].error, '链轮次超限');
      assert.equal(app.native.delivered.length, 0);
    } finally { await app.close(); }
  });
  await t.test('hourly limit', async () => {
    const { app, cluster, a, policy, deliveries } = await fixture({ limits: { maxTurnsPerHour: 1, maxCoordinatorTurnsPerHour: 1, recheckMs: 30 } });
    try {
      policy(a.id);
      const first = app.hub.sendFromUser(cluster.id, 'first');
      await waitFor(() => deliveries(first.id)[0].state === 'done', 'first turn');
      const second = app.hub.sendFromUser(cluster.id, 'second');
      await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'), 'hourly guard');
      assert.equal(deliveries(second.id)[0].state, 'queued');
      assert.equal(app.native.delivered.length, 1);
    } finally { await app.close(); }
  });
});

test('unaddressed member chat and task comments never reach the coordinator; only a named one or a user message does', async () => {
  const { app, cluster, a, b, policy, deliveries } = await fixture();
  try {
    const { members: [c] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', name: 'C', projectPath: '/work' }]);
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.create', operationId: 'routing-quiet-task', title: 'task', scope: 'scope', acceptance: 'done',
    }).task!;
    policy(a.id);
    const quiet = [
      app.hub.sendFromMember(b.id, 'chat without @'),
      app.hub.sendFromMember(b.id, 'contact a@example.com'),
      app.hub.sendFromMember(b.id, 'ordinary @unknown text'),
      app.hub.sendFromMember(b.id, '@B thinking'),
      app.hub.sendFromMember(b.id, 'task comment', undefined, [], [task.id]),
      app.hub.sendFromMember(a.id, 'coordinator chat'),
    ];
    assert.equal(app.store.getMessage(quiet[4].message.id)!.kind, 'task_comment');
    assert.deepEqual(quiet[3].message.mentions, [], 'mentioning only the sender names nobody else');
    for (const { message, deliveredTo } of quiet) {
      assert.deepEqual(deliveries(message.id), [], message.body);
      assert.deepEqual(deliveredTo, [], message.body);
    }
    assert.deepEqual(app.hub.readMessages(a.id), [], 'default read_messages does not return them to the coordinator');
    assert.equal(app.store.countUnread(a.id, cluster.id), 0);
    await sleep(30);
    assert.equal(app.native.delivered.length, 0, 'nothing woke the coordinator');
    const history = app.hub.readMessages(a.id, { history: true, limit: 100 }).map((m) => m.id);
    for (const { message } of quiet) assert.ok(history.includes(message.id), 'they stay in the chat record');

    const toC = app.hub.sendFromMember(b.id, '@C only C').message;
    assert.deepEqual(deliveries(toC.id).map((d) => d.memberId), [c.id], 'naming someone else does not involve the coordinator');
    const named = app.hub.sendFromMember(b.id, '@A please look').message;
    assert.deepEqual(deliveries(named.id).map((d) => d.memberId), [a.id], 'a named coordinator is delivered to');
    const fromUser = app.hub.sendFromUser(cluster.id, 'nobody named by the user');
    assert.deepEqual(deliveries(fromUser.id).map((d) => d.memberId), [a.id], 'the user still reaches the coordinator');
    await waitFor(() => app.native.delivered.some((entry) => entry.text.includes(named.id)) && app.native.delivered.some((entry) => entry.text.includes(fromUser.id)), 'coordinator wakes');
    const envelope = app.native.delivered.find((entry) => entry.text.includes(fromUser.id))!.text;
    assert.match(envelope, /这是群里没有点名任何人的用户消息/);
    assert.doesNotMatch(envelope, /没有点名任何人的成员消息/);
    const id = randomUUID();
    app.store.insertMessage({ id, clusterId: cluster.id, from: 'system', mentions: [], body: 'system notice', replyTo: null,
      chainId: id, hop: 0, createdAt: new Date().toISOString(), kind: 'system' }, []);
    assert.deepEqual(deliveries(id), [], 'a system notice is not routed');
    assert.equal(app.store.listUnread(a.id, cluster.id, 20).some((m) => m.id === id), false, 'nor is it coordinator unread');
  } finally { await app.close(); }
});
