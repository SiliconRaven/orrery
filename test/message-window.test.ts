// Member messages wait messageWindowMs from the oldest queued one, so what arrives meanwhile runs in the same turn; a
// user message ends the wait at once (docs/collaboration.md).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { Limits } from '../src/core/hub.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

const WAIT_MS = 15_000;
const WINDOW_MS = 300;   // a real timer, short enough for a test
const EARLY_MS = 20;     // a real timer may fire up to one Windows clock tick (~15.6 ms) early

/** Two native mock members A and B; B writes to A. `startedAt` records when each of A's turns began. */
async function fixture(name: string, limits: Partial<Limits> = {}) {
  const dir = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const startedAt: number[] = [];
  const native = createMockNativeAdapter({ sessions, onDeliver: async () => { startedAt.push(Date.now()); return 'completed'; } });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native },
    limits: { messageWindowMs: WINDOW_MS, idleCheckMs: 600_000, ...limits } });
  const { cluster, members: [a, b] } = await app.hub.createCluster(name, [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
  ]);
  const key = JSON.stringify(['native', a.harness, a.workerSessionId]);
  const say = (body: string) => app.hub.sendFromMember(b.id, body).message;
  const deliveryOf = (messageId: string) =>
    app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries.find((d) => d.memberId === a.id)!;
  const done = (...ids: string[]) => waitFor(() => ids.every((id) => deliveryOf(id).state === 'done'), 'delivered', WAIT_MS);
  const wait = () => (app.hub as any).noticeWaits.get(key) as { deadline: number } | undefined;
  const turns = () => ((app.hub as any).turnStarts.get(key) ?? []).length;
  /** What the window's timer does when it fires. */
  const recheck = () => (app.hub as any).schedule(a.id);
  return { app, cluster, a, b, native, startedAt, say, deliveryOf, done, wait, turns, recheck };
}

// Where a test needs "a moment later, still inside the window", it moves a fake clock (Date only) instead of sleeping:
// on a busy machine a real sleep can outlast the window, and then the Hub rightly runs the turn. The Hub's timers stay
// real, and nothing awaits while the clock is fake, so no timer fires in between. The clock is real again before the
// turn runs, so the times the turn records are real ones.
const fakeClock = (t: TestContext) => t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

test('a member message to an idle member starts one window after it was written, not before', async (t) => {
  const f = await fixture('window-wait');
  try {
    fakeClock(t);
    const message = f.say('@A hello');
    const deadline = Date.parse(message.createdAt) + WINDOW_MS;
    assert.equal(f.deliveryOf(message.id).state, 'queued', 'not started at once');
    assert.equal(f.wait()?.deadline, deadline);
    t.mock.timers.tick(WINDOW_MS - 1);
    f.recheck();
    assert.equal(f.deliveryOf(message.id).state, 'queued', 'still waiting inside the window');
    assert.equal(f.wait()?.deadline, deadline);
    t.mock.timers.reset();
    await f.done(message.id);
    assert.ok(f.startedAt[0] >= deadline - EARLY_MS, 'the turn began after the window');
    assert.equal(f.wait(), undefined, 'the wait is gone once the turn runs');
  } finally { await f.app.close(); }
});

test('a system notice and a second member message inside the window join the same turn', async () => {
  const f = await fixture('window-batch', { noticeWindowMs: 100 });
  try {
    const user = { kind: 'user' as const };
    const task = f.app.hub.collaboration.command(user, f.cluster.id,
      { operationId: 'create', action: 'task.create', title: 'work', scope: 's', acceptance: 'a' } as never).task!;
    // The notice alone would run after its own short window; the member message behind it holds the turn for the longer one.
    const assigned = f.app.hub.collaboration.command(user, f.cluster.id,
      { operationId: 'assign', action: 'task.assign', taskId: task.id, expectedRevision: task.revision, memberId: f.a.id } as never);
    const notice = f.app.store.listMessages(f.cluster.id, 50).find((m) => m.from === 'system' && m.collabEventId === assigned.eventId)!;
    const first = f.say('@A one');
    const second = f.say('@A two');
    await f.done(notice.id, first.id, second.id);
    assert.equal(f.native.delivered.length, 1, 'one turn for all three');
    const batchId = f.deliveryOf(notice.id).id;
    assert.deepEqual([notice, first, second].map((m) => f.deliveryOf(m.id).batchId), [batchId, batchId, batchId]);
    assert.ok(f.startedAt[0] >= Date.parse(first.createdAt) + WINDOW_MS - EARLY_MS, 'held until the member message window ended');
    assert.equal(f.turns(), 1, 'the batch counts one hourly turn');
  } finally { await f.app.close(); }
});

test('a user message inside the window starts the turn at once, with the waiting member message in it', async () => {
  const f = await fixture('window-user', { messageWindowMs: 60_000 });
  try {
    const waiting = f.say('@A when you have time');
    assert.equal(f.deliveryOf(waiting.id).state, 'queued');
    const user = f.app.hub.sendFromUser(f.cluster.id, '@A now please');
    assert.notEqual(f.deliveryOf(waiting.id).state, 'queued', 'the user message ended the wait');
    assert.equal(f.wait(), undefined);
    await f.done(waiting.id, user.id);
    assert.equal(f.native.delivered.length, 1, 'both in one turn');
    assert.equal(f.deliveryOf(user.id).batchId, f.deliveryOf(waiting.id).id);
  } finally { await f.app.close(); }
});

test('the window is measured from the first message: a later one does not push the start back', async (t) => {
  const f = await fixture('window-fixed');
  try {
    fakeClock(t);
    const first = f.say('@A one');
    const deadline = Date.parse(first.createdAt) + WINDOW_MS;
    t.mock.timers.tick(WINDOW_MS * 0.6);
    const second = f.say('@A two');
    assert.ok(Date.parse(second.createdAt) > Date.parse(first.createdAt), 'written later');
    assert.equal(f.wait()?.deadline, deadline, 'the deadline did not move');
    t.mock.timers.reset();
    await f.done(first.id, second.id);
    assert.equal(f.native.delivered.length, 1, 'one turn for both');
    assert.ok(f.startedAt[0] >= deadline - EARLY_MS);
  } finally { await f.app.close(); }
});

test('a message already older than the window starts as soon as the member can run', async () => {
  const f = await fixture('window-old');
  try {
    f.app.hub.setPaused(true);
    const message = f.say('@A while paused');
    await sleep(WINDOW_MS + 50);
    assert.equal(f.deliveryOf(message.id).state, 'queued', 'nothing runs while paused');
    f.app.hub.setPaused(false);
    assert.notEqual(f.deliveryOf(message.id).state, 'queued', 'no second wait after the pause');
    await f.done(message.id);
  } finally { await f.app.close(); }
});

test('a resumed queue takes at most 32 new deliveries per batch and leaves the rest in order', async () => {
  const f = await fixture('window-batch-size', { messageWindowMs: 0 });
  try {
    f.app.hub.setPaused(true);
    const messages = Array.from({ length: 35 }, (_, i) => f.app.hub.sendFromUser(f.cluster.id, `@A message ${i}`));
    f.app.hub.setPaused(false);
    assert.deepEqual(messages.slice(32).map((m) => f.deliveryOf(m.id).state), ['queued', 'queued', 'queued']);
    await f.done(...messages.map((m) => m.id));

    const batches = [f.deliveryOf(messages[0].id).id, f.deliveryOf(messages[32].id).id];
    assert.deepEqual(messages.map((m) => f.deliveryOf(m.id).batchId), messages.map((_, i) => batches[i < 32 ? 0 : 1]));
    assert.deepEqual(f.native.delivered.map((d) => d.deliveryId), batches);
  } finally { await f.app.close(); }
});

test('messageWindowMs 0 starts a member message at once', async () => {
  const f = await fixture('window-off', { messageWindowMs: 0 });
  try {
    const message = f.say('@A hello');
    assert.notEqual(f.deliveryOf(message.id).state, 'queued');
    assert.equal(f.wait(), undefined);
    await f.done(message.id);
  } finally { await f.app.close(); }
});
