import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

const path = (clusterId: string) => '/api/clusters/' + clusterId + '/members';

test('members: adding reuses creation rules, avoids active names, publishes SSE members, and rejects batches atomically', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [first] } = await app.cluster('team', ['mock-1']);
    const added = await app.api('POST', path(cluster.id), { members: [
      { harness: 'mock', mode: 'native', sessionId: 's1' },
      { harness: 'mock', model: 'chosen', effort: 'high', projectPath: join(app.dir, 'project-2') },
      { projectPath: tempDir(), harness: 'mock', name: 'mock-1' },
    ] });
    assert.deepEqual(added.members.map((m: any) => m.name), ['mock-1-2', 'chosen', 'mock-1-3']);
    assert.deepEqual(added.members.map((m: any) => m.removedAt), [null, null, null]);
    assert.equal(added.members[1].effort, 'high');
    assert.equal(added.members[1].cwd, join(app.dir, 'project-2'));
    assert.deepEqual(app.events.filter((e) => e.kind === 'member').map((e: any) => e.payload.member.id), added.members.map((m: any) => m.id));
    for (const specs of [[], null, [{}], [null], [{ projectPath: tempDir(), harness: 'nope' }], [{ projectPath: tempDir(), harness: 'mock', name: 'bad name' }],
[{ harness: 'mock', mode: 'native', sessionId: 's2', model: 'bad' }],
      [{ projectPath: tempDir(), harness: 'mock' }, { harness: 'mock', mode: 'native', sessionId: 'missing' }],
      [{ harness: 'mock', mode: 'native', sessionId: 's1' }],
      [{ harness: 'mock', mode: 'native', sessionId: 's2' }, { harness: 'mock', mode: 'native', sessionId: 's2' }]]) {
      await assert.rejects(app.api('POST', path(cluster.id), { members: specs }));
      assert.equal(app.hub.listMembers(cluster.id).length, 4);
    }
    await assert.rejects(app.api('POST', path('missing'), { members: [{ projectPath: tempDir(), harness: 'mock' }] }), /unknown cluster/);
    assert.ok(app.hub.listMembers(cluster.id).some((m) => m.id === first.id));
  } finally { await app.close(); }
});

test('members: removal cancels busy and queued work, revokes token, rejects late events/completion and direct sends', async () => {
  const gate = Promise.withResolvers<void>();
  const app = await startTestHub();
  let late!: () => void;
  let deliverySignal!: AbortSignal;
  app.native.deliver = async (_id, _input, ctx) => {
    const {onEvent:emit,signal}=ctx;
    deliverySignal = signal;
    late = () => emit({ type: 'text', text: 'too late' });
    signal.addEventListener('abort', late, { once: true });
    await gate.promise; // Deliberately ignore abort to simulate an already accepted native-like turn.
    late();
    return 'completed';
  };
  try {
    const { cluster, members: [member] } = await app.cluster('team', ['A']);
    const sessionId = member.workerSessionId;
    await app.api('POST', '/api/clusters/' + cluster.id + '/messages', { body: '@all one' });
    await waitFor(() => app.hub.nativeCallers('mock', sessionId)[0]);
    await app.api('POST', '/api/clusters/' + cluster.id + '/messages', { body: '@all two' });
    assert.equal(deliverySignal.aborted, false, 'native delivery is running before removal');
    const { member: removed } = await app.api('DELETE', path(cluster.id) + '/' + member.id, {});
    assert.equal(deliverySignal.aborted, true, 'removal aborts the native delivery');
    assert.ok(removed.removedAt);
    assert.equal(removed.status, 'offline');
    assert.deepEqual(app.hub.nativeCallers('mock',sessionId), []);
    assert.deepEqual(app.hub.listMembers(cluster.id), []);
    assert.equal(app.hub.listMembers(cluster.id, { includeRemoved: true })[0].name, 'A');
    assert.throws(() => app.hub.sendFromMember(member.id, 'late'), /unknown member/);
    assert.throws(() => app.hub.updateMember(member.id, { name: 'new' }), /unknown member/);
    assert.throws(() => app.hub.sendFromUser(cluster.id, 'late', [member.id]), /not in this cluster/);
    const before = await app.messages(cluster.id);
    assert.ok(before.every((m) => m.deliveries.every((d) => d.state === 'failed' && d.error?.includes('移出集群'))));
    const last = app.events.at(-1)!.seq;
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await app.messages(cluster.id), before);
    assert.equal(app.events.filter((e) => e.seq > last).length, 0, 'late output and finish publish nothing');
    assert.deepEqual((await app.api('DELETE', path(cluster.id) + '/' + member.id, {})).member, removed);
    assert.equal((await app.api('GET', '/api/state')).members.length, 0);
    assert.equal((await app.api('GET', '/api/state?includeRemoved=true')).members[0].id, member.id);
    assert.equal(app.hub.listClusters().length, 1, 'last-member removal retains the cluster');
    const record = app.hub.sendFromUser(cluster.id, 'record in an empty cluster');
    assert.deepEqual(app.store.withDeliveries([record])[0].deliveries, [], 'empty clusters can still record chat');
  } finally { gate.resolve(); await app.close(); }
});

test('members: removal and all cancellation events commit together or roll back, including after restart', async () => {
  const gate = Promise.withResolvers<void>();
  const app = await startTestHub();
  let signal!: AbortSignal;
  app.native.deliver = async (_id, _input, ctx) => { signal = ctx.signal; await gate.promise; return 'completed'; };
  let clusterId = '';
  let memberId = '';
  let committed: { id: string; state: string; outcome: string | null; error: string | null }[] = [];
  let eventSeqs: number[] = [];
  try {
    const { cluster, members: [member] } = await app.cluster('atomic-removal', ['A']);
    clusterId = cluster.id;
    memberId = member.id;
    const sessionId = member.workerSessionId;
    app.hub.sendFromUser(clusterId, '@A first');
    await waitFor(() => app.hub.nativeCallers('mock', sessionId)[0], 'running member');
    app.hub.sendFromUser(clusterId, '@A second');
    const before = await app.messages(clusterId);
    assert.deepEqual(before.map((m) => m.deliveries[0].state), ['running', 'queued']);
    const oldEvents = app.store.listEvents(0);
    const notified = app.events.length;
    const append = app.store.appendEvent;
    for (const failAt of ['delivery', 'member'] as const) {
      let deliveryWrites = 0;
      app.store.appendEvent = (...args) => {
        if (args[2] === 'delivery') deliveryWrites++;
        if ((failAt === 'delivery' && deliveryWrites === 2) || (failAt === 'member' && args[2] === 'member')) {
          throw new Error(`injected ${failAt} event failure`);
        }
        return append.apply(app.store, args);
      };
      try { assert.throws(() => app.hub.removeMember(clusterId, memberId), /injected .* event failure/); }
      finally { app.store.appendEvent = append; }
      assert.equal(signal.aborted, false, 'a rolled-back removal does not stop the running turn');
      assert.ok(app.hub.nativeCallers('mock', sessionId)[0], 'a rolled-back removal does not revoke identity');
      assert.equal(app.hub.listMembers(clusterId).length, 1);
      assert.deepEqual(await app.messages(clusterId), before);
      assert.deepEqual(app.store.listEvents(0), oldEvents, 'no partial cancellation events remain');
      assert.equal(app.events.length, notified, 'no subscriber hears a rolled-back event');
    }

    const removed = app.hub.removeMember(clusterId, memberId);
    assert.ok(removed.removedAt);
    assert.equal(signal.aborted, true);
    const messages = await app.messages(clusterId);
    committed = messages.map((m) => {
      const d = m.deliveries[0];
      return { id: d.id, state: d.state, outcome: d.outcome, error: d.error };
    });
    assert.deepEqual(committed.map((d) => [d.state, d.outcome]), [['failed', 'unknown'], ['failed', null]]);
    const events = app.store.listEvents(0).filter((e) => e.seq > (oldEvents.at(-1)?.seq ?? 0));
    assert.deepEqual(events.map((e) => e.kind), ['delivery', 'delivery', 'member']);
    const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(events.slice(0, 2).map((e) => {
      const d = (e.payload as any).delivery;
      return { id: d.id, state: d.state, outcome: d.outcome, error: d.error };
    })), byId([...committed]));
    assert.equal((events[2].payload as any).member.removedAt, removed.removedAt);
    eventSeqs = events.map((e) => e.seq);
  } finally {
    gate.resolve();
    await app.close();
  }
  const again = await startTestHub({ dir: app.dir });
  try {
    assert.equal(again.hub.listMembers(clusterId).length, 0);
    assert.ok(again.hub.listMembers(clusterId, { includeRemoved: true })[0].removedAt);
    const replay = again.store.listEvents(0).filter((e) => eventSeqs.includes(e.seq));
    assert.deepEqual(replay.map((e) => e.seq), eventSeqs);
    assert.deepEqual(replay.slice(0, 2).map((e) => {
      const d = (e.payload as any).delivery;
      return { id: d.id, state: d.state, outcome: d.outcome, error: d.error };
    }).sort((a, b) => a.id.localeCompare(b.id)), [...committed].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual((await again.messages(clusterId)).map((m) => [m.deliveries[0].state, m.deliveries[0].outcome]), [['failed', 'unknown'], ['failed', null]]);
    assert.equal(again.store.listEvents(0).filter((e) => e.kind === 'delivery' && (e.payload as any).delivery.outcome === 'unknown').length, 1);
  } finally { await again.close(); }
});

test('members: offline removal stays cancelled after restart; same conversation rejoins with new identity', async () => {
  const dir = tempDir();
  const native = createMockNativeAdapter({ kind: 'bridge', sessions: [{ id: 's', title: 'old', model: null, cwd: dir, updatedAt: null }, { id: 'other', title: 'other', model: null, cwd: dir, updatedAt: null }] });
  // A start-up grace longer than the test keeps the offline member's delivery queued until its removal cancels it.
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, limits: { startupGraceMs: 60_000 } });
  let clusterId!: string;
  let oldId!: string;
  try {
    const { cluster, members: [m] } = await app.api('POST', '/api/clusters', { name: 'offline', members: [{ harness: 'mock', mode: 'native', sessionId: 's', name: 'A', avatar: '🐭' }] });
    clusterId = cluster.id; oldId = m.id;
    await app.api('POST', '/api/clusters/' + clusterId + '/messages', { body: '@A waiting' });
    assert.equal((await app.messages(clusterId))[0].deliveries[0].state, 'queued');
    const other = await app.api('POST', '/api/clusters', { name: 'other', members: [{ harness: 'mock', sessionId: 'other', name: 'B' }] });
    await assert.rejects(app.api('DELETE', path(other.cluster.id) + '/' + oldId, {}), /unknown member/);
    assert.equal(app.hub.nativeCallers('mock', 's')[0]?.id, oldId);
    await app.api('DELETE', path(clusterId) + '/' + oldId, {});
    assert.deepEqual(app.hub.nativeCallers('mock', 's'), []);
    const raw = await fetch(app.url + path(clusterId) + '/' + oldId, { method: 'DELETE', body: '{}' });
    assert.equal(raw.status, 415, 'JSON write request checks also cover DELETE');
  } finally { await app.close(); }
  const again = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    assert.deepEqual(again.hub.nativeCallers('mock', 's'), []);
    assert.equal((await again.messages(clusterId))[0].deliveries[0].state, 'failed');
    const { members: [rejoined] } = await again.api('POST', path(clusterId), { members: [{ harness: 'mock', mode: 'native', sessionId: 's', name: 'A' }] });
    assert.notEqual(rejoined.id, oldId);
    assert.equal(rejoined.name, 'A');
    assert.equal(again.hub.nativeCallers('mock', 's')[0]?.id, rejoined.id);
    const historical = again.hub.listMembers(clusterId, { includeRemoved: true });
    assert.equal(historical.length, 2);
    assert.equal(historical[0].avatar, '🐭');
    assert.equal((await again.messages(clusterId))[0].deliveries[0].memberId, oldId);
    await assert.rejects(again.api('POST', path(clusterId), { members: [{ harness: 'mock', mode: 'native', sessionId: 's' }] }), /already a member/);
  } finally { await again.close(); }
});

test('members: concurrent attachments are settled by active unique indexes without partial batches', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('race', ['A']);
    const results = await Promise.allSettled([1, 2].map(() => app.hub.addMembers(cluster.id, [
      { projectPath: tempDir(), harness: 'mock' }, { harness: 'mock', mode: 'native', sessionId: 's1' },
    ])));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(app.hub.listMembers(cluster.id).length, 3);
  } finally { await app.close(); }
});

test('members: restart recovery never requeues removed pending work; throttled members never restart', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerHour: 0, recheckMs: 10 } });
  try {
    const { cluster, members: [m] } = await app.cluster('limited', ['A']);
    app.hub.sendFromUser(cluster.id, '@A queued');
    app.hub.removeMember(cluster.id, m.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(app.native.delivered.length, 0);
    // Simulate interrupted migration-era or externally persisted pending work for an inactive member.
    app.store.db.exec("UPDATE deliveries SET state = 'running'");
    const recovered = app.store.recoverRunning();
    assert.equal(recovered[0].state, 'failed');
    assert.equal(recovered[0].outcome, 'unknown');
  } finally { await app.close(); }
});

test('members: native MCP loses removed membership, lists active peers, and retains historical sender names', async () => {
  const dir = tempDir();
  const native = createMockNativeAdapter({ harness: 'claude', kind: 'queue', sessions: ['a', 'b'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null })) });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const clients: Client[] = [];
  try {
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const { cluster, members: [a] } = await app.api('POST', '/api/clusters', { name: 'mcp', members: [
      { harness: 'claude', mode: 'native', sessionId: 'a', name: 'Alice' }, { harness: 'claude', mode: 'native', sessionId: 'b', name: 'Bob' },
    ] });
    for (const id of ['a', 'b']) {
      const client = new Client({ name: 'membership-test', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: { 'x-orrery-bridge': secret, 'x-orrery-session': id } } }));
      clients.push(client);
    }
    app.hub.sendFromMember(a.id, 'history by Alice');
    app.hub.removeMember(cluster.id, a.id);
    const call = async (client: Client, name: string, args = {}) => client.callTool({ name, arguments: args });
    const data = (r: any) => JSON.parse(r.content[0].text);
    assert.deepEqual(data(await call(clients[0], 'list_agents')), []);
    assert.equal((await call(clients[0], 'send_message', { body: '@Bob late' })).isError, true);
    assert.deepEqual(data(await call(clients[1], 'list_agents')).map((m: any) => m.name), ['Bob']);
    assert.deepEqual(data(await call(clients[1], 'read_messages', { history: true })).map((m: any) => [m.from, m.body]), [['Alice', 'history by Alice']]);
    assert.equal(app.hub.listMessages(cluster.id, 20).length, 1, 'removed caller writes nothing');
  } finally { for (const c of clients) await c.close(); await app.close(); }
});

test('members: native late completion/offline results cannot undo removal, and bridge ack waits are cleared', async () => {
  for (const outcome of ['completed', 'offline'] as const) {
    const app = await startTestHub();
    const gate = Promise.withResolvers<void>();
    let events!: (e: any) => void;
    let deliverySignal!: AbortSignal;
    app.native.deliver = async (_session, _text, ctx) => {
      events = ctx.onEvent;
      deliverySignal = ctx.signal;
      await gate.promise;
      ctx.onEvent({ type: 'text', text: 'late native output' });
      return outcome;
    };
    try {
      const { cluster, members: [m] } = await app.api('POST', '/api/clusters', { name: 'native-late', members: [{ harness: 'mock', mode: 'native', sessionId: 's1' }] });
      app.hub.sendFromUser(cluster.id, '@all one');
      app.hub.sendFromUser(cluster.id, '@all two');
      assert.equal(deliverySignal.aborted, false, 'native delivery is running before removal');
      app.hub.removeMember(cluster.id, m.id);
      assert.equal(deliverySignal.aborted, true, 'removal aborts the native delivery');
      const seq = app.events.at(-1)!.seq;
      events({ type: 'text', text: 'late' });
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(app.events.filter((e) => e.seq > seq).length, 0);
      assert.ok((await app.messages(cluster.id)).every((msg) => msg.deliveries.every((d) => d.state === 'failed')));
      assert.deepEqual(app.hub.nativeCallers('mock', 's1'), []);
    } finally { gate.resolve(); await app.close(); }
  }
  const dir = tempDir();
  const bridgeAdapter = createMockNativeAdapter({ kind: 'bridge', sessions: [{ id: 's', title: 's', model: null, cwd: dir, updatedAt: null }] });
  const app = await startTestHub({ dir, nativeAdapters: { mock: bridgeAdapter }, limits: { bridgeAckMs: 60_000 } });
  try {
    const { cluster, members: [m] } = await app.api('POST', '/api/clusters', { name: 'bridge', members: [{ harness: 'mock', mode: 'native', sessionId: 's' }] });
    let deliveryId = '';
    const disconnect = app.hub.connectBridge('mock', 's', { send: (e) => { deliveryId = e.deliveryId; }, close() {} });
    app.hub.sendFromUser(cluster.id, '@all pending receipt');
    assert.ok(deliveryId);
    app.hub.removeMember(cluster.id, m.id);
    assert.equal(app.hub.ackBridge(deliveryId, true), false, 'removed delivery no longer awaits acknowledgement');
    disconnect();
    assert.equal((await app.messages(cluster.id))[0].deliveries[0].state, 'failed');
  } finally { await app.close(); }
});
