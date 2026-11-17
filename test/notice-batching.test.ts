// System notifications (from=system): a burst waits noticeWindowMs and runs as one turn; a batch of only system
// notifications neither counts toward nor is blocked by the per-hour limit, while any member or user message in the
// batch counts one turn (docs/collaboration.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { parseEnvelopes } from './mock.ts';
import type { Limits } from '../src/core/hub.ts';
import type { Message } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { linkCollaborationMessage } from '../src/plugins/tasks/store.ts';

const WAIT_MS = 15_000;
const WINDOW_MS = 300;   // a real timer, short enough for a test

/** Two native mock members A and B; the Hub's system-notice window is on so the tests exercise it. */
async function fixture(name: string, limits: Partial<Limits> = {}) {
  const dir = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native },
    limits: { noticeWindowMs: WINDOW_MS, idleCheckMs: 600_000, ...limits } });
  const { cluster, members: [a, b] } = await app.hub.createCluster(name, [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
  ]);
  let serial = 0;
  const send = (command: Record<string, unknown>) => app.hub.collaboration.command({ kind: 'user' }, cluster.id,
    { ...command, operationId: `${name}-${++serial}` } as never) as never as { task?: any; eventId: number };
  const create = (title: string) => send({ action: 'task.create', title, scope: 'scope', acceptance: 'done' }).task!;
  const nominate = (task: any, memberId: string) =>
    send({ action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId });
  const noticeOf = (eventId: number) => app.store.listMessages(cluster.id, 200)
    .find((m) => m.from === 'system' && m.collabEventId === eventId)!;
  const deliveryOf = (messageId: string, memberId = a.id) =>
    app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries.find((d) => d.memberId === memberId)!;
  const turns = (member = a) => (app.hub as any).turnStarts.get(JSON.stringify(['native', member.harness, member.workerSessionId])) ?? [];
  return { app, cluster, a, b, native, send, create, nominate, noticeOf, deliveryOf, turns };
}

test('a burst of system notifications runs as one turn, keeping every body and messageId', async () => {
  const f = await fixture('notice-batch');
  try {
    f.app.hub.setPaused(true);
    const one = f.create('first task');
    const two = f.create('second task');
    assert.equal(f.native.delivered.length, 0, 'nothing runs while paused');
    f.app.hub.setPaused(false);
    // The first notice starts the window; the second arrives inside it and joins the same batch.
    const n1 = f.noticeOf(f.nominate(one, f.a.id).eventId);
    const n2 = f.noticeOf(f.nominate(two, f.a.id).eventId);
    await waitFor(() => f.deliveryOf(n1.id).state === 'done' && f.deliveryOf(n2.id).state === 'done',
      'both system notices delivered', WAIT_MS);
    assert.equal(f.native.delivered.length, 1, 'one turn for both notices');
    const text = f.native.delivered[0].text;
    for (const notice of [n1, n2]) {
      assert.ok(text.includes(notice.body), notice.id);
      assert.equal((text.match(new RegExp(`messageId=${notice.id}`, 'g')) ?? []).length, 1, notice.id);
    }
    assert.deepEqual(parseEnvelopes(text).map((m) => m.messageId), [n1.id, n2.id], 'order and IDs are kept');
    const batchId = f.deliveryOf(n1.id).id;
    assert.deepEqual([f.deliveryOf(n1.id).batchId, f.deliveryOf(n2.id).batchId], [batchId, batchId]);
    assert.equal(f.native.delivered[0].deliveryId, batchId, 'the batch id is its first delivery id');
    assert.deepEqual(f.turns(), [], 'a batch of only system notifications is not an hourly turn');
    assert.ok(!f.app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'));
  } finally { await f.app.close(); }
});

test('the "superseded" marker survives the batching window', async () => {
  const f = await fixture('notice-superseded');
  try {
    const task = f.create('superseded task');
    f.app.hub.setPaused(true);
    const claimed = f.app.store.appendCollaborationEvent(f.cluster.id, null, { action: 'task.claim', taskId: task.id });
    const started = f.app.store.appendCollaborationEvent(f.cluster.id, null, { action: 'task.start', taskId: task.id });
    const insert = (eventId: number, body: string) => {
      const id = randomUUID();
      const message: Message = { id, clusterId: f.cluster.id, from: 'system', kind: 'system', mentions: [f.a.id], body,
        replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString(), collabEventId: eventId };
      f.app.store.insertMessage(message, [f.a.id]);
      linkCollaborationMessage(f.app.store, id, task.id, 'system');
      return message;
    };
    const claimMessage = insert(claimed.seq, '原句：已接取');
    const startMessage = insert(started.seq, '原句：已开始');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(claimMessage.id).state === 'done' && f.deliveryOf(startMessage.id).state === 'done',
      'both notices delivered', WAIT_MS);
    assert.equal(f.native.delivered.length, 1, 'one turn');
    const text = f.native.delivered[0].text;
    assert.ok(text.includes(claimMessage.body) && text.includes(startMessage.body));
    assert.ok(text.includes(`已被后来的状态取代（事件 ${started.seq}，messageId ${startMessage.id}）`), text);
    assert.equal((text.match(new RegExp(`messageId=${claimMessage.id}`, 'g')) ?? []).length, 1);
    assert.equal((text.match(new RegExp(`messageId=${startMessage.id}`, 'g')) ?? []).length, 1);
    assert.deepEqual(f.turns(), [], 'still not an hourly turn');
  } finally { await f.app.close(); }
});

test('a member message ends the notice wait and joins the batch as one turn', async () => {
  const f = await fixture('notice-flush');
  try {
    f.app.hub.setPaused(true);
    const task = f.create('flush task');
    f.app.hub.setPaused(false);
    const notice = f.noticeOf(f.nominate(task, f.a.id).eventId);   // starts the window
    const user = f.app.hub.sendFromUser(f.cluster.id, '@A joined');   // arrives inside it
    await waitFor(() => f.deliveryOf(notice.id).state === 'done' && f.deliveryOf(user.id).state === 'done',
      'mixed batch delivered', WAIT_MS);
    assert.equal(f.native.delivered.length, 1, 'the wait ended and both went out in one turn');
    const batchId = f.deliveryOf(notice.id).id;
    assert.deepEqual([f.deliveryOf(notice.id).batchId, f.deliveryOf(user.id).batchId], [batchId, batchId]);
    assert.deepEqual(f.turns().map(() => 'turn'), ['turn'], 'the mixed batch adds one hourly turn');
    const text = f.native.delivered[0].text;
    assert.ok(text.includes(notice.id) && text.includes(user.id));
  } finally { await f.app.close(); }
});

test('a batch with a user message counts one hourly turn', async () => {
  const f = await fixture('notice-mixed');
  try {
    f.app.hub.setPaused(true);
    const task = f.create('mixed task');
    const notice = f.noticeOf(f.nominate(task, f.a.id).eventId);
    const user = f.app.hub.sendFromUser(f.cluster.id, '@A joined');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(notice.id).state === 'done' && f.deliveryOf(user.id).state === 'done',
      'mixed batch delivered', WAIT_MS);
    assert.equal(f.native.delivered.length, 1, 'both deliveries in one turn');
    const batchId = f.deliveryOf(notice.id).id;
    assert.deepEqual([f.deliveryOf(notice.id).batchId, f.deliveryOf(user.id).batchId], [batchId, batchId]);
    assert.deepEqual(f.turns().map(() => 'turn'), ['turn'], 'the mixed batch adds exactly one hourly turn');
    const text = f.native.delivered[0].text;
    assert.ok(text.includes(notice.id) && text.includes(user.id));
  } finally { await f.app.close(); }
});

test('when the hourly cap is used up the queued system notices run first and member messages stay queued', async () => {
  const f = await fixture('notice-cap', { maxTurnsPerHour: 0, maxCoordinatorTurnsPerHour: 0, recheckMs: 30 });
  try {
    f.app.hub.setPaused(true);
    // The member message is older than the notices: the cap holds, so the notices are picked out of the queue.
    const waiting = f.app.hub.sendFromUser(f.cluster.id, '@A waiting');
    const one = f.create('first task');
    const two = f.create('second task');
    const n1 = f.noticeOf(f.nominate(one, f.a.id).eventId);
    const n2 = f.noticeOf(f.nominate(two, f.a.id).eventId);
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(n1.id).state === 'done' && f.deliveryOf(n2.id).state === 'done',
      'exempt system batch', WAIT_MS);
    assert.equal(f.native.delivered.length, 1, 'the two notices are delivered in one turn');
    assert.ok(!f.native.delivered[0].text.includes(waiting.id), 'the member message is not in the system batch');
    await waitFor(() => f.app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'
      && e.memberId === f.a.id), 'member message guard', WAIT_MS);
    assert.equal(f.deliveryOf(waiting.id).state, 'queued', 'the member message stays over the cap');
    assert.deepEqual(f.turns(), [], 'the system batch added no turn');
  } finally { await f.app.close(); }
});

test('a paused Hub delivers no system batch', async () => {
  const f = await fixture('notice-paused');
  try {
    f.app.hub.setPaused(true);
    const task = f.create('paused task');
    const notice = f.noticeOf(f.nominate(task, f.a.id).eventId);
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2 + 100));
    assert.equal(f.native.delivered.length, 0, 'nothing is delivered while paused');
    assert.equal(f.deliveryOf(notice.id).state, 'queued');
  } finally { await f.app.close(); }
});

test('a coordinator gets the same exemption, up to its own cap', async () => {
  const f = await fixture('notice-coordinator', { maxTurnsPerHour: 5, maxCoordinatorTurnsPerHour: 1 });
  try {
    f.send({ action: 'coordinator.set', memberId: f.a.id, enabled: true, mode: 'execute' });
    const greeting = f.app.store.listMessages(f.cluster.id, 100)
      .find((m) => m.from === 'system' && m.body.includes('协调员已改为'))!;
    await waitFor(() => f.deliveryOf(greeting.id).state === 'done', 'coordinator notice', WAIT_MS);
    assert.deepEqual(f.turns(), [], 'the coordinator notice is a system-only batch');
    const hello = f.app.hub.sendFromUser(f.cluster.id, '@A hello');
    await waitFor(() => f.deliveryOf(hello.id).state === 'done', 'counted turn', WAIT_MS);
    assert.equal(f.turns().length, 1, 'the user message uses the coordinator cap');
    const delivered = f.native.delivered.length;

    f.app.hub.setPaused(true);
    const task = f.create('coordinator task');
    // An attention notice wakes the coordinator; ordinary task progress is info-only for it.
    const attention = f.send({ action: 'task.attention', taskId: task.id, expectedRevision: task.revision,
      kind: 'question', question: 'please look', targetMemberId: f.a.id });
    const notice = f.noticeOf(attention.eventId);
    assert.ok(notice, 'the attention notice exists');
    f.app.hub.setPaused(false);
    await waitFor(() => f.deliveryOf(notice.id).state === 'done', 'exempt notice at the coordinator cap', WAIT_MS);
    assert.equal(f.native.delivered.length, delivered + 1, 'one system turn');
    assert.equal(f.turns().length, 1, 'the system batch did not add a coordinator turn');
    assert.ok(!f.app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'),
      'no hourly guard for the coordinator');
  } finally { await f.app.close(); }
});
