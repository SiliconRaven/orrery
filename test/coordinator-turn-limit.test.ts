// The per-hour turn limit by identity: an enabled coordinator of the cluster being scheduled gets its own cap
// (default 120, ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR), every other member the ordinary 30. The count itself stays
// per conversation, as before (docs/native-mode.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinatorPolicy } from '../src/core/collaboration-types.ts';
import type { Limits } from '../src/core/hub.ts';
import { intEnv } from '../src/config.ts';
import { coordinatorSnapshot, saveCoordinator } from '../src/plugins/coordinator/package/hub/store.mts';
import { startTestHub, waitFor } from './helpers.ts';

const COORDINATOR_PERMISSIONS: CoordinatorPolicy['permissions'] = {
  taskPlanning: true, assignment: true, roleManagement: true, reviewerManagement: true,
  knowledgeCommunication: true, recovery: true, cancelReopen: false, deliveryControl: false,
};

type TestApp = Awaited<ReturnType<typeof startTestHub>>;

/** Replaces the cluster's coordinator policy, as a handover or a disable would. */
function setCoordinator(app: TestApp, clusterId: string, memberId: string | null, enabled = true): void {
  const previous = coordinatorSnapshot(app.store, clusterId);
  const generation = previous.generation + 1;
  saveCoordinator(app.store, clusterId, memberId === null ? null : {
    memberId, enabled, mode: 'execute', generation, permissions: COORDINATOR_PERMISSIONS,
  }, generation);
}

async function fixture(limits: Partial<Limits> = {}) {
  const app = await startTestHub({ limits });
  const { cluster, members: [a, b] } = await app.hub.createCluster('hourly', [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
  ]);
  const coordinate = (memberId: string | null, enabled = true) => setCoordinator(app, cluster.id, memberId, enabled);
  const deliveryOf = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries[0];
  const guardsFor = (memberId: string) => app.events.filter((e) => e.kind === 'guard' && e.memberId === memberId
    && (e.payload as any).reason === 'max_turns_per_hour');
  /**
   * Queues one direct message per turn (a batch would count as one turn), then lets the scheduler run. `to` with a
   * single native member is the member page's direct send, so each delivery runs alone.
   */
  const queueTurns = (memberId: string, count: number, prefix: string): string[] => {
    app.hub.setPaused(true);
    const ids = Array.from({ length: count }, (_, i) => app.hub.sendFromUser(cluster.id, prefix + ' ' + (i + 1), [memberId]).id);
    app.hub.setPaused(false);
    return ids;
  };
  return { app, cluster, a, b, coordinate, deliveryOf, guardsFor, queueTurns };
}

test('defaults: an enabled coordinator may start its 31st turn and is stopped at 121; an ordinary member is stopped at 31', async () => {
  const { app, a, b, coordinate, deliveryOf, guardsFor, queueTurns } = await fixture();
  // Seed the hour's starts instead of running 121 real rounds; schedule() reads exactly this count. The key is the
  // same sessionKey the Hub uses (multi-cluster.test.ts seeds it the same way to clear a shared count).
  const seedStarts = (member: typeof a, count: number) =>
    (app.hub as any).turnStarts.set(JSON.stringify(['native', member.harness, member.workerSessionId]), Array(count).fill(Date.now()));
  try {
    coordinate(a.id);
    seedStarts(a, 30);
    const turn31 = queueTurns(a.id, 1, 'coordinator turn')[0];
    await waitFor(() => deliveryOf(turn31).state === 'done', 'coordinator turn 31');
    assert.equal(guardsFor(a.id).length, 0, 'turn 31 is below the coordinator cap');

    seedStarts(a, 120);
    const turn121 = queueTurns(a.id, 1, 'coordinator turn')[0];
    await waitFor(() => guardsFor(a.id).length > 0, 'coordinator hourly guard', 20_000);
    assert.equal(deliveryOf(turn121).state, 'queued', 'turn 121 is over the coordinator cap');
    assert.deepEqual(guardsFor(a.id).map((e) => (e.payload as any).maxTurnsPerHour), [120]);

    seedStarts(b, 30);
    const ordinary31 = queueTurns(b.id, 1, 'ordinary turn')[0];
    await waitFor(() => guardsFor(b.id).length > 0, 'ordinary hourly guard', 20_000);
    assert.equal(deliveryOf(ordinary31).state, 'queued', 'turn 31 is over the ordinary cap');
    assert.deepEqual(guardsFor(b.id).map((e) => (e.payload as any).maxTurnsPerHour), [30]);
  } finally { await app.close(); }
});

test('a handover or a disable takes the new identity at the next scheduling', async () => {
  const { app, a, b, coordinate, deliveryOf, guardsFor, queueTurns } = await fixture({ maxTurnsPerHour: 2, maxCoordinatorTurnsPerHour: 3, recheckMs: 30 });
  try {
    coordinate(a.id);
    const asCoordinator = queueTurns(a.id, 3, 'A as coordinator');
    await waitFor(() => asCoordinator.every((id) => deliveryOf(id).state === 'done'), 'coordinator turns 1-3');
    assert.equal(guardsFor(a.id).length, 0, '3 turns are under the coordinator cap');

    const overCoordinatorCap = queueTurns(a.id, 1, 'A over its coordinator cap')[0];
    await waitFor(() => guardsFor(a.id).length > 0, 'coordinator cap guard', 20_000);
    assert.deepEqual(guardsFor(a.id).map((e) => (e.payload as any).maxTurnsPerHour), [3], 'A reports the coordinator cap');
    assert.equal(deliveryOf(overCoordinatorCap).state, 'queued');

    coordinate(b.id);   // A is now an ordinary member, B the enabled coordinator
    const demoted = queueTurns(a.id, 1, 'A after handover');
    await waitFor(() => guardsFor(a.id).length > 1, 'demoted A hourly guard', 20_000);
    assert.deepEqual(guardsFor(a.id).map((e) => (e.payload as any).maxTurnsPerHour), [3, 2],
      'the new identity cap is reported even though A was already over the old one');
    assert.equal(deliveryOf(demoted[0]).state, 'queued', 'A is already over the ordinary cap');

    const promoted = queueTurns(b.id, 3, 'B as coordinator');
    await waitFor(() => promoted.every((id) => deliveryOf(id).state === 'done'), 'promoted B turns 1-3');
    assert.equal(guardsFor(b.id).length, 0, 'B may use the coordinator cap');

    coordinate(b.id, false);   // the coordinator role is disabled, the member is ordinary again
    const disabled = queueTurns(b.id, 1, 'B after disable');
    await waitFor(() => guardsFor(b.id).length > 0, 'disabled coordinator hourly guard', 20_000);
    assert.deepEqual(guardsFor(b.id).map((e) => (e.payload as any).maxTurnsPerHour), [2], 'disabled B has the ordinary cap');
    assert.equal(deliveryOf(disabled[0]).state, 'queued', 'B is already over the ordinary cap');
  } finally { await app.close(); }
});

test('ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR overrides the coordinator cap', async () => {
  const env = { ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR: '2' };
  const limit = intEnv(env, 'ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR');
  assert.equal(limit, 2);
  assert.equal(intEnv({}, 'ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR'), undefined, 'unset counts as unset');
  for (const bad of ['abc', '-1', '1.5']) {
    assert.throws(() => intEnv({ ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR: bad }, 'ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR'),
      /ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR must be a non-negative integer/);
  }

  // This is the value main.ts passes in Limits.maxCoordinatorTurnsPerHour.
  const { app, a, coordinate, deliveryOf, guardsFor, queueTurns } = await fixture({ maxTurnsPerHour: 1, maxCoordinatorTurnsPerHour: limit, recheckMs: 30 });
  try {
    coordinate(a.id);
    const allowed = queueTurns(a.id, 2, 'overridden coordinator');
    await waitFor(() => allowed.every((id) => deliveryOf(id).state === 'done'), 'overridden coordinator turns 1-2');
    assert.equal(guardsFor(a.id).length, 0, 'the environment value raises the ordinary cap');
    queueTurns(a.id, 1, 'overridden coordinator over');
    await waitFor(() => guardsFor(a.id).length > 0, 'overridden coordinator guard', 20_000);
    assert.deepEqual(guardsFor(a.id).map((e) => (e.payload as any).maxTurnsPerHour), [2], 'the guard reports the override');
  } finally { await app.close(); }
});

test('one native conversation in two clusters keeps one count but takes each cluster identity', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerHour: 2, maxCoordinatorTurnsPerHour: 3, recheckMs: 30 } });
  try {
    const first = await app.hub.createCluster('first', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const second = await app.hub.createCluster('second', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const inFirst = first.members[0];
    const inSecond = second.members[0];
    setCoordinator(app, first.cluster.id, inFirst.id);
    const deliveryOf = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries[0];
    const queue = (clusterId: string, memberId: string, count: number, prefix: string) => {
      app.hub.setPaused(true);
      const ids = Array.from({ length: count }, (_, i) => app.hub.sendFromUser(clusterId, prefix + ' ' + (i + 1), [memberId]).id);
      app.hub.setPaused(false);
      return ids;
    };

    const coordinated = queue(first.cluster.id, inFirst.id, 3, 'coordinator in first');
    await waitFor(() => coordinated.every((id) => deliveryOf(id).state === 'done'), 'first cluster coordinator turns');
    assert.equal(app.native.delivered.length, 3, 'the coordinator cap allows three turns in the first cluster');

    // The same conversation is ordinary in the second cluster: the count (already 3) is shared, so its first turn
    // is already over its ordinary cap and the guard reports 2, not the 3 that the first cluster used.
    const blocked = queue(second.cluster.id, inSecond.id, 1, 'ordinary in second');
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && e.memberId === inSecond.id
      && (e.payload as any).reason === 'max_turns_per_hour'), 'second cluster hourly guard', 20_000);
    assert.equal(deliveryOf(blocked[0]).state, 'queued');
    const guard = app.events.find((e) => e.kind === 'guard' && e.memberId === inSecond.id)!;
    assert.equal((guard.payload as any).maxTurnsPerHour, 2, 'the second cluster uses the ordinary identity cap');
    assert.equal(app.native.delivered.length, 3, 'the shared count is not reset by switching clusters');
  } finally { await app.close(); }
});

