import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { Store } from '../src/core/store.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { ToolObservations, TOOL_OBSERVATION_STALE_MS } from '../src/core/tool-observations.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const client = { source: 'client', scope: 'session', profile: 'standard', fingerprint: hash };
const bridge = { source: 'dsh-source', scope: 'plugin', profile: 'standard', fingerprint: hash,
  observedAt: '2026-11-08T00:00:00.000Z', registered: { succeeded: 18, total: 19 } };

test('only recognized, scoped declarations survive and each call replaces missing values', () => {
  const observations = new ToolObservations();
  const now = Date.parse('2026-11-08T00:00:10.000Z');
  observations.record(['a', 'b'], 'standard', { 'orrery/toolVersion': client, 'orrery/bridgeToolVersion': bridge }, 'deepseek', now);
  assert.deepEqual(observations.get('a'), observations.get('b'));
  assert.equal(observations.get('a')?.client?.source, 'client');
  assert.equal(observations.get('a')?.bridge?.registered?.succeeded, 18);
  assert.equal(observations.get('a')?.staleAfterMs, TOOL_OBSERVATION_STALE_MS);
  observations.record(['a'], 'standard', { 'orrery/toolVersion': { ...client, fingerprint: 'bad' },
    'orrery/bridgeToolVersion': bridge }, 'claude', now + 1);
  assert.equal(observations.get('a')?.client, null);
  assert.equal(observations.get('a')?.bridge, null, 'a plugin report cannot impersonate a Claude bridge');
  assert.ok(observations.get('b')?.client, 'other memberships do not change without a call');
  observations.record(['b'], 'standard', {}, 'deepseek', now + 2);
  assert.equal(observations.get('b')?.client, null);
  assert.equal(observations.get('b')?.bridge, null);
  observations.remove('a');
  assert.equal(observations.get('a'), null);
});

test('real MCP calls observe only authenticated sessions, including invalid arguments, without changing responses', async () => {
  const dir = tempDir();
  const sessions = ['same', 'other'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  let reopened: Awaited<ReturnType<typeof startTestHub>> | undefined;
  let closed = false;
  try {
    const first = await app.hub.createCluster('first', [{ harness: 'mock', mode: 'native', sessionId: 'same', name: 'A' }]);
    const second = await app.hub.createCluster('second', [{ harness: 'mock', mode: 'native', sessionId: 'same', name: 'A' }]);
    const third = await app.hub.createCluster('third', [{ harness: 'mock', mode: 'native', sessionId: 'other', name: 'B' }]);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const call = async (session: string, args: unknown, meta?: unknown) => {
      const response = await fetch(`${app.url}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'x-orrery-bridge': secret, 'x-orrery-harness': 'mock', 'x-orrery-session': session },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_agents', arguments: args,
          ...(meta === undefined ? {} : { _meta: meta }) } }),
      });
      return response.json() as Promise<any>;
    };
    const report = () => app.hub.toolVersionReport();
    const obs = (id: string) => report().find((item) => item.memberId === id)?.observation;
    const declared = { 'orrery/toolVersion': client };
    const invalidWithMeta = await call('same', { clusterId: 123 }, declared);
    assert.ok(invalidWithMeta.result?.isError || invalidWithMeta.error, 'invalid arguments still fail normally');
    assert.equal(obs(first.members[0].id)?.client?.fingerprint, hash);
    assert.equal(obs(second.members[0].id)?.client?.fingerprint, hash, 'the same authenticated conversation shares the observation');
    assert.equal(obs(third.members[0].id), null);
    const added = await app.hub.createCluster('added', [{ harness: 'mock', mode: 'native', sessionId: 'same', name: 'A' }]);
    assert.equal(obs(added.members[0].id), null, 'a membership added after the call does not inherit history');
    const invalidWithoutMeta = await call('same', { clusterId: 123 });
    assert.deepEqual(invalidWithMeta, invalidWithoutMeta, 'observation changes no tool response');
    assert.equal(obs(first.members[0].id)?.client, null, 'a later undeclared call clears the old claim');
    await call('missing-session', { clusterId: first.cluster.id }, declared);
    assert.equal(obs(third.members[0].id), null, 'an unknown session cannot write another member observation');
    await call('same', { clusterId: first.cluster.id }, declared);
    app.hub.removeMember(first.cluster.id, first.members[0].id);
    assert.equal(report().some((item) => item.memberId === first.members[0].id), false);
    assert.ok(obs(second.members[0].id)?.client);
    app.hub.deleteCluster(second.cluster.id);
    app.hub.restoreCluster(second.cluster.id);
    assert.equal(obs(second.members[0].id), null, 'restoring a deleted cluster cannot revive stale observations');
    await app.close(); closed = true;
    reopened = await startTestHub({ dir, nativeAdapters: { mock: native } });
    assert.equal(reopened.hub.toolVersionReport().find((item) => item.memberId === added.members[0].id)?.observation, null);
  } finally {
    if (!closed) await app.close();
    if (reopened) await reopened.close();
  }
});

test('the tool-version report carries the online check and the newest failed delivery', async () => {
  const dir = tempDir();
  const sessions = ['on', 'off'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions, kind: 'bridge' });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    const { cluster, members } = await app.hub.createCluster('health', [
      { harness: 'mock', mode: 'native', sessionId: 'on', name: 'ON' },
      { harness: 'mock', mode: 'native', sessionId: 'off', name: 'OFF' },
    ]);
    native.isOnline = (sessionId) => sessionId === 'on';
    const report = () => app.hub.toolVersionReport();
    const row = (id: string) => report().find((item) => item.memberId === id)!;
    const online = row(members[0].id), offline = row(members[1].id);
    assert.equal(online.connection.state, 'online');
    assert.match(online.connection.basis, /桥或等待通道/);
    assert.ok(Number.isFinite(Date.parse(online.connection.observedAt)), 'the report carries when the check ran');
    assert.equal(online.lastProblem, null);
    assert.equal(offline.connection.state, 'offline');
    const message = app.hub.sendFromUser(cluster.id, '@OFF hello');
    await waitFor(() => app.store.withDeliveries([message])[0].deliveries[0].state === 'offline', 'offline delivery');
    const problem = row(members[1].id).lastProblem!;
    assert.equal(problem.state, 'offline');
    assert.equal(problem.messageId, message.id);
    assert.ok(problem.error, 'the failure reason is carried');
  } finally { await app.close(); }
});

test('the connection line uses the adapter check, not the busy work state', async () => {
  const dir = tempDir();
  const sessions = [{ id: 'busy', title: 'busy', model: null, cwd: dir, updatedAt: null }];
  const gate = Promise.withResolvers<void>();
  const native = createMockNativeAdapter({ sessions, onDeliver: () => gate.promise.then(() => 'completed') });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    const { cluster, members } = await app.hub.createCluster('busy', [{ harness: 'mock', mode: 'native', sessionId: 'busy', name: 'B' }]);
    const member = members[0];
    const report = () => app.hub.toolVersionReport().find((item) => item.memberId === member.id)!;
    assert.equal(report().connection.state, 'online');
    app.hub.sendFromUser(cluster.id, '@B work');
    await waitFor(() => app.hub.listMembers().find((m) => m.id === member.id)?.status === 'busy', 'busy delivery');
    native.isOnline = () => false;
    assert.equal(report().connection.state, 'offline', 'a broken connection during a delivery is not shown as online');
    assert.match(report().connection.basis, /桥或等待通道/, 'the basis is the check that actually ran');
    gate.resolve();
    await waitFor(() => app.hub.listMembers().find((m) => m.id === member.id)?.status !== 'busy', 'delivery finished');
  } finally { await app.close(); }
});

test('a handoff of an older failure does not become the newest failure', async () => {
  const dir = tempDir();
  const sessions = ['off', 'target'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions, kind: 'bridge' });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    const { cluster, members } = await app.hub.createCluster('handoff', [
      { harness: 'mock', mode: 'native', sessionId: 'off', name: 'OFF' },
      { harness: 'mock', mode: 'native', sessionId: 'target', name: 'TARGET' },
    ]);
    const lastProblem = () => app.hub.toolVersionReport().find((item) => item.memberId === members[0].id)!.lastProblem;
    const first = app.hub.sendFromUser(cluster.id, '@OFF first');
    await waitFor(() => app.store.withDeliveries([first])[0].deliveries[0].state === 'offline', 'first offline');
    const second = app.hub.sendFromUser(cluster.id, '@OFF second');
    await waitFor(() => app.store.withDeliveries([second])[0].deliveries[0].state === 'offline', 'second offline');
    const before = lastProblem()!;
    assert.equal(before.messageId, second.id);
    assert.ok(before.at);
    const firstDelivery = app.store.withDeliveries([first])[0].deliveries[0];
    app.hub.handoffDelivery(cluster.id, firstDelivery.id, { targetMemberId: members[1].id });
    const after = lastProblem()!;
    assert.equal(after.messageId, second.id, 'the newer failure stays selected after handing off the older one');
    assert.equal(after.at, before.at, 'the shown time is the original failure time, not the handoff time');
  } finally { await app.close(); }
});

test('the newest failure aggregates the delivery events once, not once per failure', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T10:00:00.000Z') });
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  try {
    const member = { id: 'm', clusterId: 'c', name: 'm', avatar: null, harness: 'mock', model: null, effort: null,
      workerSessionId: 's', cwd: '/tmp', origin: 'attached' as const, removedAt: null };
    store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: new Date().toISOString() }, [member]);
    const failures = [];
    for (let i = 0; i < 20; i++) {
      t.mock.timers.tick(1000);
      const id = `m${i}`;
      const message = { id, clusterId: 'c', from: 'user', mentions: [member.id], body: `b${i}`, replyTo: null,
        chainId: id, hop: 0, createdAt: new Date().toISOString() };
      const [delivery] = store.insertMessage(message, [member.id]);
      const failure = store.setDeliveryState(delivery.id, 'offline', '成员离线，未投递');
      store.appendEvent('c', null, 'message', { message, deliveries: [failure] });
      store.appendEvent('c', member.id, 'delivery', { delivery: failure });
      failures.push(failure);
    }
    const db = store.db as unknown as { prepare(sql: string): unknown };
    const original = db.prepare.bind(db);
    let queries = 0;
    db.prepare = (sql: string) => { queries++; return (original as (sql: string) => unknown)(sql); };
    const problem = store.lastDeliveryProblem(member.id)!;
    assert.equal(problem.messageId, failures.at(-1)!.messageId);
    assert.equal(problem.at, failures.at(-1)!.updatedAt);
    assert.ok(queries <= 2, `failure events are aggregated once, not once per failure (saw ${queries} queries)`);
  } finally { store.close(); t.mock.timers.reset(); }
});
