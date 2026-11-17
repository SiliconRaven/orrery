// The long-queue warning, send_message's idempotency key and the expired mark on late task notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { NativeDeliverContext } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { collaborationLinks, collaborationTask } from '../src/plugins/tasks/store.ts';

const OFF = 600_000;   // an automatic check that never comes within a test
const PREFIX = '排队预警';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Native members Coord, Worker and Sender (coordinator enabled); `hold` keeps Worker's turn open until `release`. */
async function fixture(name: string, queueWarnMs = 1, workerResult: 'completed' | 'offline' = 'completed') {
  const dir = tempDir();
  const sessions = ['coord', 'worker', 'sender', 'spare'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  let releaseTurn: (() => void) | undefined;
  let holding = false;
  let ctxOf: NativeDeliverContext | undefined;
  const native = createMockNativeAdapter({ sessions, onDeliver: (sessionId, _text, ctx) => {
    if (sessionId !== 'worker' || !holding) return Promise.resolve(sessionId === 'worker' ? workerResult : 'completed');
    ctxOf = ctx;
    return new Promise((resolve) => {
      releaseTurn = () => resolve('completed');
      ctx.signal.addEventListener('abort', () => resolve('completed'), { once: true });
    });
  } });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, limits: { recheckMs: OFF, startupGraceMs: 0, queueWarnMs } });
  const { cluster, members: [coord, worker, sender] } = await app.hub.createCluster(name, [
    { harness: 'mock', mode: 'native', sessionId: 'coord', name: 'Coord' },
    { harness: 'mock', mode: 'native', sessionId: 'worker', name: 'Worker' },
    { harness: 'mock', mode: 'native', sessionId: 'sender', name: 'Sender' },
  ]);
  app.hub.collaboration.command({ kind: 'user' }, cluster.id,
    { action: 'coordinator.set', operationId: 'set', memberId: coord.id, enabled: true, mode: 'execute' });
  const member = (id: string) => app.hub.listMembers(cluster.id).find((m) => m.id === id)!;
  const hold = async () => {
    holding = true;
    app.hub.sendFromUser(cluster.id, 'hold', [worker.id]);
    await waitFor(() => member(worker.id).status === 'busy', 'worker busy');
  };
  const release = async () => {
    holding = false;
    releaseTurn?.();
    await waitFor(() => member(worker.id).status === 'idle' && !app.store.queued(worker.id).length, 'worker idle, queue empty');
  };
  const check = () => (app.hub as unknown as { warnLongQueues(): void }).warnLongQueues();
  const warnings = () => app.store.listMessages(cluster.id, 500).filter((m) => m.body.startsWith(PREFIX));
  return { app, native, cluster, coord, worker, sender, member, hold, release, check, warnings, ctx: () => ctxOf! };
}

test('a delivery queued too long warns the sender and the coordinator once, as an info notice', async () => {
  const f = await fixture('queue-warning');
  const { app, cluster, coord, worker, sender, hold, release, check, warnings, member } = f;
  try {
    await hold();
    const { message } = app.hub.sendFromMember(sender.id, '@Worker 这条要等');
    app.hub.limits.queueWarnMs = OFF;
    check();
    assert.equal(warnings().length, 0, 'not yet: younger than queueWarnMs');
    app.hub.limits.queueWarnMs = 1;
    await sleep(5);
    check();
    assert.equal(warnings().length, 1);
    const [warning] = warnings();
    assert.equal(warning.kind, 'system');
    assert.deepEqual(new Set(warning.mentions), new Set([sender.id, coord.id]), 'the recipient itself is not told');
    assert.match(warning.body, /投给 Worker 的 1 条消息还没开始，最久已等 1 分钟；Worker 正在一轮中/);
    assert.ok(warning.body.includes(message.id));
    assert.deepEqual(app.store.withDeliveries([warning])[0].deliveries, [], 'info tier: no delivery, no turn');
    assert.ok(!app.hub.readMessages(sender.id).some((m) => m.id === warning.id), 'excluded from sender unread');
    assert.ok(app.hub.readMessages(sender.id, { history: true }).some((m) => m.id === warning.id), 'still readable in history');
    assert.equal(member(worker.id).longWaiting, 1, 'the member page count');

    await sleep(5);
    check();
    assert.equal(warnings().length, 1, 'once per delivery');

    await release();
    assert.equal(member(worker.id).longWaiting, undefined, 'started: no longer counted');
    assert.equal(app.store.listMessages(cluster.id, 500).filter((m) => m.body.startsWith(PREFIX)).length, 1);
  } finally { await app.close(); }
});

test('the queue warning waits while paused and groups a recipient\'s overdue deliveries', async () => {
  const f = await fixture('queue-warning-paused');
  const { app, sender, hold, check, warnings, worker, member } = f;
  try {
    await hold();
    for (let i = 0; i < 7; i++) app.hub.sendFromMember(sender.id, `@Worker m${i}`);
    await sleep(5);
    app.hub.setPaused(true);
    check();
    assert.equal(warnings().length, 0, 'paused on purpose: nothing to warn about');
    app.hub.setPaused(false);
    check();
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].body, /7 条消息/);
    assert.match(warnings()[0].body, /另有 2 条/);
    assert.equal(member(worker.id).longWaiting, 7);
  } finally { await app.close(); }
});

test('a delivery still in the harness\'s own queue is warned about too, and counted until a turn picks it up', async () => {
  const f = await fixture('queue-warning-app');
  const { app, worker, hold, check, warnings, member, ctx } = f;
  try {
    await hold();
    ctx().waiting!({ busy: false });
    await sleep(5);
    check();
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0].body, /Worker 现在不在轮次中/);
    assert.equal(member(worker.id).longWaiting, 1);
    check();
    assert.equal(warnings().length, 1, 'once per run');
    ctx().waiting!(null);
    assert.equal(member(worker.id).longWaiting, undefined);
    assert.equal(warnings().length, 1);
  } finally { await app.close(); }
});

test('queueWarnMs 0 turns the warning off', async () => {
  const f = await fixture('queue-warning-off', 0);
  const { app, sender, hold, check, warnings } = f;
  try {
    await hold();
    app.hub.sendFromMember(sender.id, '@Worker later');
    await sleep(10);
    check();
    assert.equal(warnings().length, 0);
  } finally { await app.close(); }
});

test('the same clientMessageId from the same sender returns the first message and writes nothing new', async () => {
  const dir = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, limits: { startupGraceMs: 0 } });
  try {
    const { cluster, members: [a, b] } = await app.hub.createCluster('idem', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }, { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    {
      const send = async (args: Record<string, unknown>) => {
        const res = await fetch(`${app.url}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-session': 's1', 'x-orrery-harness': 'mock' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: args } }),
        });
        const { result } = await res.json();
        const text = result.content[0].text as string;
        return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
      };
      const count = () => [app.store.listMessages(cluster.id, 100).length, app.store.withDeliveries(app.store.listMessages(cluster.id, 100)).flatMap((m) => m.deliveries).length];

      const first = await send({ body: '@B hello', clientMessageId: 'k1' });
      assert.equal(first.data.duplicate, undefined);
      assert.deepEqual(count(), [1, 1]);
      await waitFor(() => native.delivered.length === 1, 'delivered once');

      const again = await send({ body: '@B hello', clientMessageId: 'k1' });
      assert.equal(again.data.messageId, first.data.messageId);
      assert.deepEqual(again.data.deliveredTo, ['B']);
      assert.equal(again.data.duplicate, true);
      assert.deepEqual(count(), [1, 1], 'nothing new');
      await sleep(30);
      assert.equal(native.delivered.length, 1, 'no second delivery');

      const fresh = await send({ body: '@B hello', clientMessageId: 'k2' });
      assert.notEqual(fresh.data.messageId, first.data.messageId, 'another key is another message');
      const plain = await send({ body: '@B hello' });
      assert.notEqual(plain.data.messageId, first.data.messageId, 'no key: no deduplication');
      assert.deepEqual(count(), [3, 3]);

      const other = app.hub.sendFromMember(b.id, '@A same key, other sender', undefined, [], undefined, undefined, 'k1');
      assert.equal(other.duplicate, undefined, 'the key belongs to its sender');
      assert.notEqual(other.message.id, first.data.messageId);

      assert.match((await send({ body: 'x', clientMessageId: '' })).text, /too_small|at least|>=1/i);
      assert.throws(() => app.hub.sendFromMember(a.id, 'x', undefined, [], undefined, undefined, 'y'.repeat(201)), /clientMessageId/);

      // A repeat with attachments stops before the copy: no new file row and the outbox is untouched.
      writeFileSync(join(app.hub.files!.memberOutbox(a.id), 'f.txt'), 'data');
      const withFile = await send({ body: 'file', attachments: ['f.txt'], clientMessageId: 'k3' });
      const files = () => (app.store.db.prepare('SELECT COUNT(*) AS n FROM files').get() as any).n;
      assert.equal(files(), 1);
      const repeated = await send({ body: 'file', attachments: ['f.txt'], clientMessageId: 'k3' });
      assert.equal(repeated.data.messageId, withFile.data.messageId);
      assert.equal(repeated.data.duplicate, true);
      assert.equal(files(), 1, 'no second copy');

      // fyi goes through the tool: unread for B, no delivery and no warning; the schema refuses a non-boolean.
      const fyi = await send({ body: '@B for your information', fyi: true });
      const stored = app.store.withDeliveries([app.store.getMessage(fyi.data.messageId)!])[0];
      assert.deepEqual([fyi.data.deliveredTo, fyi.data.warning, stored.mentions, stored.deliveries], [[], undefined, [b.id], []]);
      assert.equal((await send({ body: '@B not a boolean', fyi: 'yes' })).isError, true);
    }
  } finally { await app.close(); }
});

test('a late task notice from another batch is marked expired after its text; a current one is not', async () => {
  const f = await fixture('stale-notice', 0);
  const { app, native, cluster, worker, sender, hold, release } = f;
  try {
    let serial = 0;
    const command = (input: Record<string, unknown>) => app.hub.collaboration.command({ kind: 'user' }, cluster.id,
      { operationId: `stale-${++serial}`, ...input } as never);
    let task = command({ action: 'task.create', title: 'T', scope: 's', acceptance: 'a' }).task!;
    await hold();
    const nominated = command({ action: 'task.nominate', taskId: task.id, expectedRevision: task.revision, memberId: worker.id });
    task = nominated.task!;
    const notice = app.store.listMessages(cluster.id, 100).find((m) => m.collabEventId === nominated.eventId)!;
    assert.deepEqual(notice.taskStamp, { taskId: task.id, revision: task.revision, submissionId: null });
    const moved = command({ action: 'task.edit', taskId: task.id, expectedRevision: task.revision, title: 'T 新标题' }).task!;

    await release();
    const sent = await waitFor(() => native.delivered.find((d) => d.sessionId === 'worker' && d.text.includes(notice.id)), 'late notice');
    assert.ok(sent.text.includes(notice.body), 'the original text stays');
    assert.ok(sent.text.indexOf(notice.body) < sent.text.indexOf('已过期：'), 'the mark follows the text');
    assert.match(sent.text, new RegExp(`已过期：当前状态是待开工；负责人：Worker；验收人：用户（修订 ${task.revision} → ${moved.revision}）`));

    // Nothing moved after this nomination, so its notice is delivered without the mark.
    const next = command({ action: 'task.nominate', taskId: task.id, expectedRevision: moved.revision, memberId: sender.id });
    const current = app.store.listMessages(cluster.id, 100).find((m) => m.collabEventId === next.eventId)!;
    const fresh = await waitFor(() => native.delivered.find((d) => d.sessionId === 'sender' && d.text.includes(current.id)), 'current notice');
    assert.ok(!fresh.text.includes('已过期'));
  } finally { await app.close(); }
});

test('an ordinary message and a failed-delivery notice carry no stamp and are never marked expired', async () => {
  const f = await fixture('stale-exempt', 0, 'offline');
  const { app, native, cluster, coord, sender } = f;
  try {
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id,
      { action: 'task.create', operationId: 'exempt', title: 'T', scope: 's', acceptance: 'a' }).task!;
    const { message } = app.hub.sendFromMember(sender.id, '@Worker plain', undefined, [], [task.id]);
    const sent = await waitFor(() => native.delivered.find((d) => d.text.includes(message.id)), 'plain');
    assert.equal(app.store.getMessage(message.id)!.taskStamp, undefined);
    assert.ok(!sent.text.includes('已过期'));
    const notice = await waitFor(() => app.store.listMessages(cluster.id, 100).find((m) => m.kind === 'system' && m.body.startsWith('投递失败或离线') && m.mentions.includes(coord.id)), 'failed-delivery notice');
    assert.equal(notice.taskStamp, undefined);
    assert.equal(collaborationLinks(app.store, notice.id)[0], task.id);
  } finally { await app.close(); }
});

test('a rebind keeps the warned queue counted without a new warning; the old run stops counting and stays silent', async () => {
  const f = await fixture('queue-warning-rebind');
  const { app, worker, sender, hold, check, warnings, member, ctx } = f;
  try {
    await hold();
    ctx().waiting!({ busy: true });
    const { message } = app.hub.sendFromMember(sender.id, '@Worker queued');
    await sleep(5);
    check();
    assert.equal(warnings().length, 1);
    assert.equal(member(worker.id).longWaiting, 2, 'the run still in the app queue and the Hub-queued delivery');

    app.hub.setPaused(true);   // keeps the moved delivery queued so its flag can be seen
    const oldRun = ctx();
    await app.api('POST', `/api/members/${worker.id}/session`, { harness: 'mock', sessionId: 'spare', confirmStopped: true });
    assert.equal(member(worker.id).workerSessionId, 'spare');
    assert.equal(member(worker.id).longWaiting, 1, 'the detached run is gone, the moved delivery stays');
    assert.deepEqual(app.store.overdueQueued(new Date().toISOString()).filter((q) => q.message.id === message.id), [], 'its one warning carries over');

    const seen = app.events.length;
    oldRun.waiting!(null);
    assert.deepEqual(app.events.slice(seen).filter((e) => e.kind === 'member'), [], 'no member event built from the old conversation');

    app.hub.setPaused(false);
    await waitFor(() => !app.store.queued(worker.id).length && member(worker.id).longWaiting === undefined, 'the new conversation took the queue');
    check();
    assert.equal(warnings().length, 1);
  } finally { await app.close(); }
});

test('a repeated clientMessageId reports who the first send was queued for, with to, no @ and an ID prefix', async () => {
  const f = await fixture('idem-routing', 0);
  const { app, sender } = f;
  try {
    const send = (body: string, replyTo: string | undefined, to: unknown, key: string) => app.hub.sendFromMember(sender.id, body, replyTo, [], undefined, to, key);
    const count = () => app.store.listMessages(f.cluster.id, 100).length;

    const routed = send('nobody named', undefined, undefined, 'r1');
    assert.deepEqual(routed.deliveredTo, [], 'no @: nobody, not even the coordinator');
    let before = count();
    const routedAgain = send('nobody named', undefined, undefined, 'r1');
    assert.deepEqual([routedAgain.message.id, routedAgain.deliveredTo, routedAgain.duplicate], [routed.message.id, [], true]);
    assert.equal(count(), before);

    const named = send('text', undefined, ['Worker'], 'r2');
    assert.deepEqual(named.deliveredTo, ['Worker']);
    before = count();
    const namedAgain = send('text', undefined, ['Coord'], 'r2');
    assert.deepEqual([namedAgain.message.id, namedAgain.deliveredTo, namedAgain.duplicate], [named.message.id, ['Worker'], true], 'the first send stands');
    assert.equal(count(), before);

    const prefix = routed.message.id.slice(0, 8);
    const reply = send('a reply', prefix, undefined, 'r3');
    assert.equal(reply.message.replyTo, routed.message.id, 'the prefix was resolved');
    before = count();
    const replyAgain = send('a reply', prefix, undefined, 'r3');
    assert.deepEqual([replyAgain.message.id, replyAgain.message.replyTo, replyAgain.duplicate], [reply.message.id, routed.message.id, true]);
    assert.equal(count(), before);
  } finally { await app.close(); }
});

test('a late notice whose task has since been merged is marked expired with the merged state and new submission', async () => {
  const f = await fixture('stale-merged', 0);
  const { app, native, cluster, worker, hold, release } = f;
  try {
    let serial = 0;
    const as = { kind: 'member' as const, memberId: worker.id };
    const user = { kind: 'user' as const };
    const send = (actor: typeof as | typeof user | { kind: 'system' }, input: Record<string, unknown>) =>
      app.hub.collaboration.command(actor, cluster.id, { operationId: `merged-${++serial}`, ...input } as never);
    const created = send(user, { action: 'task.create', title: 'M', scope: 's', acceptance: 'a' }).task!;
    const act = (actor: typeof as | typeof user | { kind: 'system' }, input: Record<string, unknown>) =>
      send(actor, { taskId: created.id, expectedRevision: collaborationTask(app.store, cluster.id, created.id)!.revision, ...input });
    await hold();
    const nominated = act(user, { action: 'task.nominate', memberId: worker.id });
    const notice = app.store.listMessages(cluster.id, 100).find((m) => m.collabEventId === nominated.eventId)!;
    assert.equal(notice.taskStamp!.revision, nominated.task!.revision);
    const assignment = act(as, { action: 'task.claim' }).assignment!;
    act(as, { action: 'task.start', assignmentId: assignment.id });
    const evidence = app.hub.sendFromUser(cluster.id, 'proof');
    const submission = act(as, { action: 'task.submit', assignmentId: assignment.id, summary: 'done', evidenceMessageIds: [evidence.id], commitSha: 'abcdef0' }).submission!;
    act(user, { action: 'task.review', submissionId: submission.id, verdict: 'approve' });
    const merged = act({ kind: 'system' }, { action: 'task.shipped', submissionId: submission.id, commitSha: 'abcdef1', reason: 'ship' }).task!;
    assert.equal(merged.status, 'merged');

    await release();
    const sent = await waitFor(() => native.delivered.find((d) => d.sessionId === 'worker' && d.text.includes(notice.id)), 'late notice');
    assert.ok(sent.text.includes(notice.body));
    assert.match(sent.text, new RegExp(`已过期：当前状态是已合并；负责人：未分配；验收人：用户（修订 ${notice.taskStamp!.revision} → ${merged.revision}，最新提交 ${submission.id}（这条通知时是 无））`));
  } finally { await app.close(); }
});
