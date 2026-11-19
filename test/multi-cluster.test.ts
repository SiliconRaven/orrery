import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeDeliverContext } from '../src/core/types.ts';
import { startTestHub, waitFor, type TestHub } from './helpers.ts';

async function call(app: TestHub, name: string, args: Record<string, unknown>, session = 's1') {
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-orrery-bridge': JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret, 'x-orrery-harness': 'mock', 'x-orrery-session': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const result = (await res.json()).result;
  return { isError: result.isError === true, text: result.content[0].text,
    data: result.isError ? null : JSON.parse(result.content[0].text) };
}

async function pair(app: TestHub) {
  const one = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
  const two = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'B' }]);
  return { one: one.cluster, a: one.members[0], two: two.cluster, b: two.members[0] };
}

test('one native conversation joins two clusters and MCP selects only an authorized cluster', async () => {
  const app = await startTestHub();
  try {
    const { cluster: one, members: [a] } = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    assert.deepEqual((await call(app, 'list_agents', {})).data.map((m: any) => m.name), ['A'], 'old single-cluster call');
    const { cluster: two, members: [b] } = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'B' }]);
    await assert.rejects(app.hub.addMembers(one.id, [{ harness: 'mock', mode: 'native', sessionId: 's1' }]), /already a member/);
    const listing = (await app.hub.listSessions('mock', join(app.dir, 'project-1'))).find((s) => s.id === 's1')!;
    assert.equal(listing.memberId, a.id);
    assert.deepEqual(listing.memberships, [
      { clusterId: one.id, clusterName: 'one', memberId: a.id, memberName: 'A' },
      { clusterId: two.id, clusterName: 'two', memberId: b.id, memberName: 'B' },
    ]);

    const ambiguous = await call(app, 'list_agents', {});
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, new RegExp(one.id));
    assert.match(ambiguous.text, new RegExp(two.id));
    assert.deepEqual((await call(app, 'list_agents', { clusterId: two.id })).data.map((m: any) => m.name), ['B']);
    assert.equal((await call(app, 'send_message', { body: 'wrong', clusterId: 'outside', memberId: a.id })).isError, true);
    assert.equal((await call(app, 'send_message', { body: 'ambiguous' })).isError, true);
    assert.deepEqual((await call(app, 'list_agents', {}, 's2')).data, [], 'another conversation cannot select either membership');

    const msgOne = app.hub.sendFromUser(one.id, 'one user');
    const msgTwo = app.hub.sendFromUser(two.id, 'two user');
    const sent = await call(app, 'send_message', { clusterId: one.id, body: 'from A', memberId: b.id });
    assert.equal(app.store.getMessage(sent.data.messageId)?.from, a.id);
    const reply = await call(app, 'send_message', { body: 'from B', replyTo: msgTwo.id });
    assert.equal(app.store.getMessage(reply.data.messageId)?.from, b.id, 'replyTo identifies its authorized cluster');
    assert.deepEqual((await call(app, 'get_deliveries', { messageId: reply.data.messageId })).data, { fyi: false, deliveries: [] }, 'message ID selects only an existing membership');
    assert.equal((await call(app, 'get_deliveries', { clusterId: one.id, messageId: reply.data.messageId })).isError, true);
    assert.equal((await call(app, 'get_deliveries', { messageId: reply.data.messageId }, 's2')).isError, true, 'an ID never grants membership');
    const prior = await call(app, 'read_messages', { before: reply.data.messageId });
    assert.deepEqual(prior.data.map((m: any) => m.id), [msgTwo.id]);
    assert.equal((await call(app, 'send_message', { clusterId: one.id, body: 'cross reply', replyTo: msgTwo.id })).isError, true);
    for (const args of [{ messageIds: [msgOne.id, msgTwo.id] }, { clusterId: one.id, messageIds: [msgOne.id, msgTwo.id] }]) {
      assert.equal((await call(app, 'ack_messages', args)).isError, true, 'a cross-cluster batch fails whole');
    }
    assert.deepEqual(app.store.acknowledgementsOf(msgOne.id), []);
    assert.deepEqual(app.store.acknowledgementsOf(msgTwo.id), []);
    assert.deepEqual((await call(app, 'ack_messages', { messageIds: [msgTwo.id] })).data.acknowledged, [msgTwo.id]);

    app.hub.removeMember(one.id, a.id);
    assert.deepEqual((await call(app, 'list_agents', {})).data.map((m: any) => m.name), ['B']);
    assert.equal((await app.hub.listSessions('mock', join(app.dir, 'project-1'))).find((s) => s.id === 's1')!.memberId, b.id);
  } finally { await app.close(); }
});

test('cross-cluster deliveries serialize in FIFO order without batching across a sibling', async () => {
  const app = await startTestHub();
  const runs: { text: string; gate: PromiseWithResolvers<'completed'> }[] = [];
  app.native.deliver = async (_session, text) => {
    const gate = Promise.withResolvers<'completed'>();
    runs.push({ text, gate });
    return gate.promise;
  };
  try {
    const { one, a, two, b } = await pair(app);
    const msgs = [app.hub.sendFromUser(one.id, '@A first'), app.hub.sendFromUser(two.id, '@B second'),
      app.hub.sendFromUser(one.id, '@A third'), app.hub.sendFromUser(two.id, '@B fourth')];
    assert.equal(runs.length, 1);
    assert.equal(app.hub.listMembers(two.id)[0].status, 'busy', 'sibling shares the occupied channel');
    for (let i = 0; i < msgs.length; i++) {
      await waitFor(() => runs.length === i + 1, `run ${i + 1}`);
      assert.match(runs[i].text, new RegExp(msgs[i].id));
      assert.match(runs[i].text, new RegExp(`clusterId=${i % 2 ? two.id : one.id}`));
      if (i + 1 < msgs.length) assert.doesNotMatch(runs[i].text, new RegExp(msgs[i + 1].id));
      runs[i].gate.resolve('completed');
    }
    await waitFor(() => app.store.getDelivery(app.store.withDeliveries([msgs[3]])[0].deliveries[0].id)?.state === 'done');
    assert.deepEqual(app.hub.listMembers(one.id).map((m) => m.status), ['idle']);
    assert.deepEqual(app.hub.listMembers(two.id).map((m) => m.status), ['idle']);
    assert.notEqual(a.id, b.id);
  } finally { for (const run of runs) run.gate.resolve('completed'); await app.close(); }
});

test('queued native direct sends read only the selected message and keep shared FIFO', async (t) => {
  const app = await startTestHub();
  try {
    const { one, a, two, b } = await pair(app);
    app.hub.setPaused(true);
    const messages = Array.from({ length: 8 }, (_, i) => {
      const [cluster, member] = i % 2 ? [one, a] : [two, b];
      return app.hub.sendFromUser(cluster.id, `${i} ${'正文'.repeat(4_096)}`, [member.id]);
    });
    const lastDeliveryId = app.store.withDeliveries([messages.at(-1)!])[0].deliveries[0].id;
    const fullQueue = t.mock.method(app.store, 'queued');
    const candidates = t.mock.method(app.store, 'queuedCandidates');
    const message = t.mock.method(app.store, 'getMessage');
    app.hub.setPaused(false);
    await waitFor(() => app.store.getDelivery(lastDeliveryId)?.state === 'done', 'last shared delivery done');

    assert.deepEqual(app.native.delivered.map((d) => d.text), messages.map((m) => m.body));
    assert.equal(fullQueue.mock.callCount(), 0, 'direct draining never materializes an entire queue');
    assert.equal(candidates.mock.callCount(), 0, 'the direct head needs no candidates from the tail');
    assert.deepEqual(message.mock.calls.map((call) => call.arguments[0]), messages.map((m) => m.id));
  } finally { await app.close(); }
});

test('removing a running membership wakes its sibling after the adapter settles', async () => {
  const app = await startTestHub();
  const runs: { gate: PromiseWithResolvers<'completed'>; ctx: NativeDeliverContext }[] = [];
  app.native.deliver = async (_session, _text, ctx) => {
    const gate = Promise.withResolvers<'completed'>();
    runs.push({ gate, ctx });
    return gate.promise; // deliberately ignore abort until the adapter really settles
  };
  try {
    const { one, a, two } = await pair(app);
    const first = app.hub.sendFromUser(one.id, '@A running');
    app.hub.sendFromUser(two.id, '@B waiting');
    app.hub.removeMember(one.id, a.id);
    assert.equal(runs[0].ctx.signal.aborted, true);
    assert.equal(runs.length, 1, 'the still-in-flight adapter owns the channel');
    assert.equal(app.hub.listMembers(two.id)[0].status, 'busy');
    runs[0].gate.resolve('completed');
    await waitFor(() => runs.length === 2, 'sibling runs after release');
    assert.equal(app.store.withDeliveries([first])[0].deliveries[0].outcome, 'unknown');
    runs[1].gate.resolve('completed');
  } finally { for (const run of runs) run.gate.resolve('completed'); await app.close(); }
});

test('the hourly limit survives removal of another binding and the waiting sibling is rechecked', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerHour: 1, recheckMs: 20 } });
  try {
    const { one, a, two, b } = await pair(app);
    const first = app.hub.sendFromUser(one.id, '@A once');
    await waitFor(() => app.store.withDeliveries([first])[0].deliveries[0].state === 'done');
    const second = app.hub.sendFromUser(two.id, '@B limited');
    assert.equal(app.native.delivered.length, 1);
    app.hub.removeMember(one.id, a.id);
    assert.equal(app.store.withDeliveries([second])[0].deliveries[0].state, 'queued');
    assert.equal(app.native.delivered.length, 1, 'removing a sibling does not reset the shared limit');
    const key = JSON.stringify(['native', b.harness, b.workerSessionId]);
    (app.hub as any).turnStarts.set(key, [Date.now() - 3_600_001]);
    await waitFor(() => app.store.withDeliveries([second])[0].deliveries[0].state === 'done', 'throttled sibling rechecked');
    assert.equal(app.native.delivered.length, 2);
  } finally { await app.close(); }
});

test('a newer confirmed delivery resumes when an older sibling is confirmed offline', async () => {
  const app = await startTestHub();
  let online = true;
  const checks: PromiseWithResolvers<boolean>[] = [];
  app.native.isOnline = () => online;
  app.native.confirmOnline = async () => {
    const check = Promise.withResolvers<boolean>();
    checks.push(check);
    const result = await check.promise;
    online = result;
    return result;
  };
  try {
    const { one, two } = await pair(app);
    const first = app.hub.sendFromUser(one.id, '@A older');
    const second = app.hub.sendFromUser(two.id, '@B newer');
    assert.equal(checks.length, 2);
    const delivery = (id: string) => app.store.withDeliveries([app.store.getMessage(id)!])[0].deliveries[0];
    checks[1].resolve(true);
    await waitFor(() => !(app.hub as any).pending.has(delivery(second.id).id), 'newer check completed');
    assert.equal(app.native.delivered.length, 0, 'the earlier pending delivery still owns FIFO');
    checks[0].resolve(false);
    await waitFor(() => checks.length === 3, 'the sibling is woken for a fresh online check', 1000);
    assert.equal(delivery(first.id).state, 'offline');
    checks[2].resolve(true);
    await waitFor(() => delivery(second.id).state === 'done', 'the confirmed sibling is delivered');
    assert.equal(app.native.delivered.length, 1);
  } finally {
    for (const check of checks) check.resolve(false);
    await app.close();
  }
});

test('bridge done attributes usage to the membership owning its delivery', async () => {
  const app = await startTestHub();
  app.native.deliver = async (session, text, ctx) => {
    const ack = await ctx.bridge.push('mock', session, ctx.deliveryId, text);
    if (!ack.ok) return 'offline';
    await ctx.bridge.waitDone('mock', session, ctx.deliveryId, 5000, ctx.signal);
    return 'completed';
  };
  try {
    const { a, two, b } = await pair(app);
    app.hub.connectBridge('mock', 's1', { send: (event) => { queueMicrotask(() => app.hub.ackBridge(event.deliveryId, true, undefined, true)); }, close: () => {} });
    const msg = app.hub.sendFromUser(two.id, '@B usage');
    const id = app.store.withDeliveries([msg])[0].deliveries[0].id;
    await waitFor(() => (app.hub as any).dones.has(id), 'bridge done wait');
    assert.equal(app.hub.doneBridge(id, 'mock', 's1', { input: 5, cachedInput: 1, cacheWrite: 0, output: 2, reasoning: 0 }, { outcome: 'completed' }), true);
    await waitFor(() => app.store.withDeliveries([msg])[0].deliveries[0].state === 'done');
    const usage = app.store.turnUsage([a.id, b.id]);
    assert.equal(usage.has(a.id), false);
    assert.equal(usage.get(b.id)?.totals.input, 5);
  } finally { await app.close(); }
});

test('hop limit follows the physical conversation across clusters and removed delivery history', async () => {
  const app = await startTestHub({ limits: { maxHops: 0 } });
  const gate = Promise.withResolvers<'completed'>();
  app.native.deliver = async () => gate.promise;
  try {
    const { one, a, two } = await pair(app);
    const initial = await call(app, 'send_message', { clusterId: two.id, body: 'before any delivery' });
    assert.equal(app.store.getMessage(initial.data.messageId)?.hop, 0, 'a genuinely new conversation starts a chain');
    const trigger = app.hub.sendFromUser(one.id, '@A trigger');
    await waitFor(() => app.store.withDeliveries([trigger])[0].deliveries[0].state === 'running');
    for (const clusterId of [one.id, two.id]) {
      const rejected = await call(app, 'send_message', { clusterId, body: 'cannot reset hops' });
      assert.equal(rejected.isError, true);
      assert.match(rejected.text, /hop 1 exceeds/);
    }
    app.hub.removeMember(one.id, a.id);
    const whileRemoving = await call(app, 'send_message', { clusterId: two.id, body: 'still running' });
    assert.equal(whileRemoving.isError, true, 'removed membership still has an in-flight run');
    gate.resolve('completed');
    await waitFor(() => (app.hub as any).running.size === 0, 'removed adapter settled');
    assert.equal(app.store.withDeliveries([trigger])[0].deliveries[0].outcome, 'unknown');
    const afterRemoval = await call(app, 'send_message', { clusterId: two.id, body: 'history still counts' });
    assert.equal(afterRemoval.isError, true);
    assert.match(afterRemoval.text, /hop 1 exceeds/);
  } finally { gate.resolve('completed'); await app.close(); }
});

test('two native conversations cannot restart a chain by alternating clusters', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerChain: 2 } });
  const runs: { session: string; gate: PromiseWithResolvers<'completed'> }[] = [];
  app.native.deliver = async (session) => {
    const gate = Promise.withResolvers<'completed'>();
    runs.push({ session, gate });
    return gate.promise;
  };
  try {
    const one = await app.hub.createCluster('one', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A1' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B1' },
    ]);
    const two = await app.hub.createCluster('two', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A2' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B2' },
    ]);
    const trigger = app.hub.sendFromUser(one.cluster.id, '@A1 start');
    await waitFor(() => runs.length === 1);
    const first = await call(app, 'send_message', { clusterId: two.cluster.id, body: '@B2 first' }, 's1');
    const m1 = app.store.getMessage(first.data.messageId)!;
    assert.deepEqual([m1.chainId, m1.hop], [trigger.chainId, 1]);
    await waitFor(() => runs.length === 2);
    const second = await call(app, 'send_message', { clusterId: one.cluster.id, body: '@A1 second' }, 's2');
    const m2 = app.store.getMessage(second.data.messageId)!;
    assert.deepEqual([m2.chainId, m2.hop], [trigger.chainId, 2]);
    runs[0].gate.resolve('completed');
    const blocked = await waitFor(() => {
      const d = app.store.withDeliveries([m2])[0].deliveries[0];
      return d.state === 'failed' ? d : null;
    }, 'chain limit blocks the third turn');
    assert.equal(blocked.error, '链轮次超限');
    assert.equal(runs.length, 2);
  } finally { for (const run of runs) run.gate.resolve('completed'); await app.close(); }
});

test('replyTo stays within the selected group and a live run takes precedence over an older reply', async () => {
  const app = await startTestHub();
  const runs: { gate: PromiseWithResolvers<'completed'> }[] = [];
  app.native.deliver = async () => {
    const gate = Promise.withResolvers<'completed'>();
    runs.push({ gate });
    return gate.promise;
  };
  try {
    const { one, two } = await pair(app);
    const older = app.hub.sendFromUser(one.id, '@A older chain');
    await waitFor(() => runs.length === 1);
    runs[0].gate.resolve('completed');
    await waitFor(() => app.store.withDeliveries([older])[0].deliveries[0].state === 'done');
    const newer = app.hub.sendFromUser(two.id, '@B newer chain');
    await waitFor(() => runs.length === 2);
    const sent = await call(app, 'send_message', { clusterId: one.id, body: 'during newer run', replyTo: older.id });
    const during = app.store.getMessage(sent.data.messageId)!;
    assert.deepEqual([during.replyTo, during.chainId, during.hop], [older.id, newer.chainId, 1]);
    assert.equal((await call(app, 'send_message', { clusterId: one.id, body: 'cross', replyTo: newer.id })).isError, true);
    runs[1].gate.resolve('completed');
    await waitFor(() => app.store.withDeliveries([newer])[0].deliveries[0].state === 'done');
    const explicit = await call(app, 'send_message', { clusterId: one.id, body: 'explicit old reply', replyTo: older.id });
    const after = app.store.getMessage(explicit.data.messageId)!;
    assert.deepEqual([after.replyTo, after.chainId, after.hop], [older.id, older.chainId, 1]);
  } finally { for (const run of runs) run.gate.resolve('completed'); await app.close(); }
});

test('a cross-cluster send suppresses the active native reply, but read and acknowledgement do not', async () => {
  const app = await startTestHub();
  const runs: { gate: PromiseWithResolvers<'completed'>; ctx: NativeDeliverContext }[] = [];
  Object.defineProperty(app.native, 'replies', { value: true });
  app.native.deliver = async (_session, _text, ctx) => {
    const gate = Promise.withResolvers<'completed'>();
    runs.push({ gate, ctx });
    return gate.promise;
  };
  try {
    const { one, two } = await pair(app);
    const first = app.hub.sendFromUser(one.id, '@A first');
    await waitFor(() => runs.length === 1);
    const sent = await call(app, 'send_message', { clusterId: two.id, body: 'posted in other group' });
    assert.equal(sent.isError, false);
    runs[0].ctx.reply!('must not be forwarded');
    assert.deepEqual(app.store.listMessages(one.id, 100).map((m) => m.id), [first.id]);
    runs[0].gate.resolve('completed');
    await waitFor(() => app.store.withDeliveries([first])[0].deliveries[0].state === 'done');

    const second = app.hub.sendFromUser(one.id, '@A second');
    const note = app.hub.sendFromUser(two.id, 'note for reading');
    await waitFor(() => runs.length === 2);
    assert.equal((await call(app, 'read_messages', { clusterId: two.id, history: true })).isError, false);
    assert.equal((await call(app, 'ack_messages', { messageIds: [note.id] })).isError, false);
    runs[1].ctx.reply!('a later independent answer');
    assert.equal(app.store.listMessages(one.id, 100).at(-1)?.body, 'a later independent answer');
    assert.equal(app.store.listMessages(one.id, 100).at(-1)?.replyTo, second.id);
  } finally { for (const run of runs) run.gate.resolve('completed'); await app.close(); }
});

test('a removed native membership still owns its running conversation until the adapter settles', async () => {
  const app = await startTestHub();
  const gate = Promise.withResolvers<'completed'>();
  app.native.deliver = async () => gate.promise;
  try {
    const { one, a, two } = await pair(app);
    const trigger = app.hub.sendFromUser(one.id, '@A still running');
    await waitFor(() => app.store.withDeliveries([trigger])[0].deliveries[0].state === 'running');
    const run = (app.hub as any).running.get(a.id);
    app.hub.removeMember(one.id, a.id);
    const sent = await call(app, 'send_message', { clusterId: two.id, body: 'other membership' });
    const message = app.store.getMessage(sent.data.messageId)!;
    assert.deepEqual([message.chainId, message.hop], [trigger.chainId, 1]);
    assert.equal(run.sentMcpMessage, true, 'the in-flight run is marked even after its membership was removed');
  } finally { gate.resolve('completed'); await app.close(); }
});
