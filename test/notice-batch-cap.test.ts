// The hourly fallback cap for batches of only system notifications (docs/collaboration.md): 300 per conversation and
// hour by default (ORRERY_MAX_NOTICE_BATCHES_PER_HOUR), counted separately from the member turn cap. At the cap the
// system notices stay queued and are retried by the recheck; a batch with a member or user message still counts one
// turn and never enters this count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNativeAdapter, type MockNativeOptions } from '../src/adapters/mock/native.ts';
import { intEnv } from '../src/config.ts';
import { DEFAULT_LIMITS, type Limits } from '../src/core/hub.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

const WAIT_MS = 15_000;
const HOUR_MS = 3_600_000;

/** Two native mock members A and B; immediate scheduling (no notice window) and a quick recheck. */
async function fixture(limits: Partial<Limits> = {}, nativeOptions: MockNativeOptions = {}) {
  const dir = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions, ...nativeOptions });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native },
    limits: { noticeWindowMs: 0, recheckMs: 30, ...limits } });
  const { cluster, members: [a, b] } = await app.hub.createCluster('notice-cap', [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
  ]);
  let serial = 0;
  const send = (command: Record<string, unknown>) => app.hub.collaboration.command({ kind: 'user' }, cluster.id,
    { ...command, operationId: `notice-cap-${++serial}` } as never) as never as { task?: any; eventId: number };
  const create = (title: string) => send({ action: 'task.create', title, scope: 'scope', acceptance: 'done' }).task!;
  const nominate = (task: any, memberId: string) =>
    send({ action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId });
  const noticeOf = (eventId: number) => app.store.listMessages(cluster.id, 200)
    .find((m) => m.from === 'system' && m.collabEventId === eventId)!;
  const deliveryOf = (messageId: string, member: typeof a = a) =>
    app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries.find((d) => d.memberId === member.id)!;
  const key = (member: typeof a = a) => JSON.stringify(['native', member.harness, member.workerSessionId]);
  const noticeTurns = (member: typeof a = a) => (app.hub as any).noticeStarts.get(key(member)) ?? [];
  const turnTurns = (member: typeof a = a) => (app.hub as any).turnStarts.get(key(member)) ?? [];
  const seedNoticeTurns = (count: number, member: typeof a = a) =>
    (app.hub as any).noticeStarts.set(key(member), Array(count).fill(Date.now()));
  const seedTurnTurns = (count: number, member: typeof a = a) =>
    (app.hub as any).turnStarts.set(key(member), Array(count).fill(Date.now()));
  const ageNoticeTurns = (member: typeof a = a) =>
    (app.hub as any).noticeStarts.set(key(member), Array(300).fill(Date.now() - HOUR_MS - 1));
  const guards = (reason: string, member: typeof a = a) => app.events.filter((e) => e.kind === 'guard'
    && e.memberId === member.id && (e.payload as any).reason === reason);
  /** Queues one system notice for the member (a fresh task's nomination); the caller sets the Hub running again. */
  const queueNotice = (member: typeof a = a, title = 'cap task') => {
    app.hub.setPaused(true);
    const task = create(title);
    return noticeOf(nominate(task, member.id).eventId);
  };
  return { app, cluster, a, b, native, create, send, nominate, noticeOf, deliveryOf, noticeTurns, turnTurns,
    seedNoticeTurns, seedTurnTurns, ageNoticeTurns, guards, queueNotice };
}

test('the 300th system-only batch runs and the 301st waits without being dropped; another member is unaffected', async () => {
  const f = await fixture();
  try {
    f.seedNoticeTurns(299);
    const allowed = f.queueNotice(f.a, 'notice 300');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(allowed.id).state === 'done', 'the 300th batch runs', WAIT_MS);
    assert.equal(f.noticeTurns().length, 300, 'the 300th batch is counted');

    const held = f.queueNotice(f.a, 'notice 301');
    f.app.hub.setPaused(false);
    await waitFor(() => f.guards('max_notice_batches_per_hour').length > 0, 'notice cap guard', WAIT_MS);
    assert.equal(f.deliveryOf(held.id).state, 'queued', 'the 301st batch stays queued');
    assert.equal(f.noticeTurns().length, 300, 'the held batch adds no count');
    assert.ok(f.app.store.getMessage(held.id), 'the held message is kept');
    assert.equal(f.native.delivered.length, 1, 'only the allowed batch ran');
    assert.deepEqual(f.guards('max_notice_batches_per_hour').map((e) => (e.payload as any).maxNoticeBatchesPerHour), [300]);
    assert.equal(f.guards('max_turns_per_hour').length, 0, 'the member turn cap is not involved');
    assert.equal(f.turnTurns().length, 0, 'a system-only batch is not a member turn');

    const other = f.queueNotice(f.b, 'notice for B');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(other.id, f.b).state === 'done', 'the other member still runs', WAIT_MS);
    assert.equal(f.noticeTurns(f.b).length, 1, 'the cap is counted per conversation');
    assert.equal(f.noticeTurns(f.a).length, 300, 'the capped member keeps its own count');
  } finally { await f.app.close(); }
});

test('an hour later the held system notice is delivered; the old starts no longer count', async () => {
  const f = await fixture();
  try {
    f.seedNoticeTurns(300);
    const held = f.queueNotice(f.a, 'waiting for the hour');
    f.app.hub.setPaused(false);
    await waitFor(() => f.guards('max_notice_batches_per_hour').length > 0, 'notice cap guard', WAIT_MS);
    assert.equal(f.deliveryOf(held.id).state, 'queued');

    f.ageNoticeTurns();   // the rolling window drops every seeded start without waiting a real hour
    await waitFor(() => f.deliveryOf(held.id).state === 'done', 'delivered after the hour', WAIT_MS);
    assert.equal(f.noticeTurns().length, 1, 'only the batch of the new hour is counted');
    assert.equal(f.turnTurns().length, 0);
  } finally { await f.app.close(); }
});

test('at the notice cap member messages and mixed batches still run; a mixed batch is not a notice batch', async () => {
  const f = await fixture();
  try {
    f.seedNoticeTurns(300);
    const user = f.app.hub.sendFromUser(f.cluster.id, '@A plain user message');
    await waitFor(() => f.deliveryOf(user.id).state === 'done', 'a member message is not held by the notice cap', WAIT_MS);
    assert.equal(f.turnTurns().length, 1, 'it counts one member turn');

    f.app.hub.setPaused(true);
    const task = f.create('mixed at the cap');
    const notice = f.noticeOf(f.nominate(task, f.a.id).eventId);
    const joined = f.app.hub.sendFromUser(f.cluster.id, '@A joined');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(notice.id).state === 'done' && f.deliveryOf(joined.id).state === 'done',
      'the mixed batch runs', WAIT_MS);
    assert.equal(f.noticeTurns().length, 300, 'the mixed batch did not enter the notice count');
    assert.equal(f.turnTurns().length, 2, 'the mixed batch counts one turn');
    assert.equal(f.guards('max_notice_batches_per_hour').length, 0, 'the notice cap was not reported for a mixed batch');
  } finally { await f.app.close(); }
});

test('a system batch that reaches nobody gives its notice slot back', async () => {
  const f = await fixture({}, { onDeliver: async () => 'offline' });
  try {
    const notice = f.queueNotice(f.a, 'nobody home');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(notice.id).state === 'offline', 'the run ends offline', WAIT_MS);
    assert.deepEqual(f.noticeTurns(), [], 'a batch nobody received is not counted');
  } finally { await f.app.close(); }
});

test('system-only batches do not use the ordinary hourly turn cap', async () => {
  const f = await fixture({ maxTurnsPerHour: 1 });
  try {
    const one = f.queueNotice(f.a, 'turn-free one');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(one.id).state === 'done', 'first system batch', WAIT_MS);
    const two = f.queueNotice(f.a, 'turn-free two');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(two.id).state === 'done', 'second system batch', WAIT_MS);
    assert.equal(f.turnTurns().length, 0, 'two system batches used no turn');
    assert.equal(f.noticeTurns().length, 2);

    const firstTurn = f.app.hub.sendFromUser(f.cluster.id, '@A first turn');
    await waitFor(() => f.deliveryOf(firstTurn.id).state === 'done', 'the one allowed turn', WAIT_MS);
    assert.equal(f.turnTurns().length, 1, 'the system batches left the whole turn cap free');
    const over = f.app.hub.sendFromUser(f.cluster.id, '@A second turn');
    await waitFor(() => f.guards('max_turns_per_hour').length > 0, 'turn cap guard', WAIT_MS);
    assert.equal(f.deliveryOf(over.id).state, 'queued');
  } finally { await f.app.close(); }
});

test('ORRERY_MAX_NOTICE_BATCHES_PER_HOUR overrides the cap and its guard number', async () => {
  const env = { ORRERY_MAX_NOTICE_BATCHES_PER_HOUR: '2' };
  const limit = intEnv(env, 'ORRERY_MAX_NOTICE_BATCHES_PER_HOUR');
  assert.equal(limit, 2);
  assert.equal(intEnv({}, 'ORRERY_MAX_NOTICE_BATCHES_PER_HOUR'), undefined, 'unset counts as unset');
  for (const bad of ['abc', '-1', '1.5']) {
    assert.throws(() => intEnv({ ORRERY_MAX_NOTICE_BATCHES_PER_HOUR: bad }, 'ORRERY_MAX_NOTICE_BATCHES_PER_HOUR'),
      /ORRERY_MAX_NOTICE_BATCHES_PER_HOUR must be a non-negative integer/);
  }
  assert.equal(DEFAULT_LIMITS.maxNoticeBatchesPerHour, 300, 'the default is 300');

  // This is the value main.ts passes in Limits.maxNoticeBatchesPerHour.
  const f = await fixture({ maxNoticeBatchesPerHour: limit });
  try {
    f.seedNoticeTurns(1);
    const second = f.queueNotice(f.a, 'overridden 2');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(second.id).state === 'done', 'the overridden cap allows the 2nd batch', WAIT_MS);
    assert.equal(f.noticeTurns().length, 2);

    const held = f.queueNotice(f.a, 'overridden 3');
    f.app.hub.setPaused(false);
    await waitFor(() => f.guards('max_notice_batches_per_hour').length > 0, 'override guard', WAIT_MS);
    assert.equal(f.deliveryOf(held.id).state, 'queued');
    assert.deepEqual(f.guards('max_notice_batches_per_hour').map((e) => (e.payload as any).maxNoticeBatchesPerHour), [2],
      'the guard reports the override');
  } finally { await f.app.close(); }
});

test('at the notice cap a held system batch does not hold a direct user message behind it', async () => {
  const f = await fixture({ maxNoticeBatchesPerHour: 1 });
  try {
    f.seedNoticeTurns(1);   // the independent notice quota is already used up
    const notice = f.queueNotice(f.a, 'held notice');
    const direct = f.app.hub.sendFromUser(f.cluster.id, 'direct while the notice is held', [f.a.id]);
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(direct.id).state === 'done', 'the direct message runs', WAIT_MS);
    assert.equal(f.deliveryOf(notice.id).state, 'queued', 'the capped system batch stays queued');
    const directDelivery = f.deliveryOf(direct.id);
    assert.equal(directDelivery.batchId, directDelivery.id, 'the direct message ran on its own, not mixed into the notice batch');
    assert.equal(f.deliveryOf(notice.id).batchId, null, 'the held system batch never started');
    assert.equal(f.native.delivered.length, 1, 'only the direct message ran');
    assert.equal(f.native.delivered[0].text, 'direct while the notice is held');
    assert.equal(f.turnTurns().length, 1, 'the direct message counts one ordinary turn');
    assert.equal(f.noticeTurns().length, 1, 'the held notice adds no notice count');
    assert.deepEqual(f.guards('max_notice_batches_per_hour').map((e) => (e.payload as any).maxNoticeBatchesPerHour), [1]);

    f.ageNoticeTurns();   // the notice window recovers without waiting a real hour
    await waitFor(() => f.deliveryOf(notice.id).state === 'done', 'the held system batch runs after the cap frees', WAIT_MS);
    assert.equal(f.noticeTurns().length, 1, 'the recovered system batch counts one notice batch');
    assert.equal(f.turnTurns().length, 1, 'the recovered system batch is not an ordinary turn');
    assert.equal(f.guards('max_notice_batches_per_hour').length, 1, 'the notice cap guard is reported once');
  } finally { await f.app.close(); }
});

test('when the ordinary turn cap is full too, a direct message behind a capped system batch still waits', async () => {
  const f = await fixture({ maxNoticeBatchesPerHour: 1, maxTurnsPerHour: 1 });
  try {
    f.seedTurnTurns(1);
    f.seedNoticeTurns(1);
    const notice = f.queueNotice(f.a, 'held at both caps');
    const direct = f.app.hub.sendFromUser(f.cluster.id, 'direct at both caps', [f.a.id]);
    f.app.hub.setPaused(false);
    await waitFor(() => f.guards('max_turns_per_hour').length > 0 && f.guards('max_notice_batches_per_hour').length > 0,
      'both cap guards', WAIT_MS);
    assert.equal(f.deliveryOf(direct.id).state, 'queued', 'the direct message waits for the ordinary cap');
    assert.equal(f.deliveryOf(notice.id).state, 'queued', 'the system notice waits for the notice cap');
    assert.equal(f.native.delivered.length, 0, 'nothing may run while the ordinary cap holds too');
    assert.equal(f.turnTurns().length, 1, 'the seeded turn start is kept');
    assert.equal(f.noticeTurns().length, 1, 'the seeded notice start is kept');
  } finally { await f.app.close(); }
});
