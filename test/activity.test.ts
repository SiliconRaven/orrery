import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixtureNativeMock, startTestHub, tempDir } from './helpers.ts';

test('activity query returns the same unknown shape for active members in the requested cluster', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.cluster('activity-a', ['A', 'B']);
    const { members: [c] } = await app.cluster('activity-b', ['C']);
    const unknown = { state: 'unknown', source: null, lastSeenAt: null, lastActivityAt: null, event: null, staleAfterMs: 45_000 };
    assert.deepEqual(await app.api('GET', `/api/activity?cluster=${cluster.id}`), {
      members: [a, b].map((m) => ({ memberId: m.id, activity: unknown })),
    });
    assert.deepEqual((await app.api('GET', '/api/activity')).members.map((m: any) => m.memberId), [a.id, b.id, c.id]);
    await assert.rejects(app.api('GET', '/api/activity?cluster=missing'));
    await app.api('DELETE', `/api/clusters/${cluster.id}/members/${a.id}`, {});
    assert.deepEqual((await app.api('GET', `/api/activity?cluster=${cluster.id}`)).members.map((m: any) => m.memberId), [b.id]);
  } finally { await app.close(); }
});

test('activity observations require participation, normalize metadata, and expire independently of delivery status', async () => {
  const app = await startTestHub();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const { cluster, members: [member] } = await app.api('POST', '/api/clusters', {
      name: 'activity-native', members: [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'Native' }],
    });
    const first = app.hub.openActivityObserver(member.id, 'deepseek');
    assert.equal(first.heartbeat(), false, 'joining alone is not participation');
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM activity_snapshots').get()?.n, 0);
    app.hub.sendFromMember(member.id, 'participated');
    const beforeEvents = app.store.lastEventSeq();
    assert.equal(first.record({ kind: 'tool', phase: 'requested', toolName: 'bash', arguments: 'do-not-save' } as any), true);
    const recorded = app.hub.activityFor(member.id);
    assert.deepEqual(recorded.event, { kind: 'tool', phase: 'requested', toolName: 'bash' });
    assert.equal(recorded.state, 'observing');
    assert.equal(recorded.lastSeenAt, new Date(now).toISOString());
    assert.equal(recorded.lastActivityAt, recorded.lastSeenAt);
    now += 1000;
    assert.equal(first.heartbeat(), true);
    assert.equal(app.hub.activityFor(member.id).lastActivityAt, recorded.lastActivityAt, 'a heartbeat is not activity');
    assert.equal(app.store.lastEventSeq(), beforeEvents, 'heartbeats and activity do not append history events');
    assert.equal(first.record({ kind: 'tool', phase: 'failed', toolName: '../secret', output: 'do-not-save' } as any), true);
    assert.deepEqual(app.hub.activityFor(member.id).event, { kind: 'tool', phase: 'failed', toolName: null });
    const out = JSON.stringify(await app.api('GET', `/api/activity?cluster=${cluster.id}`));
    assert.doesNotMatch(out, /secret|do-not-save/);
    assert.doesNotMatch(JSON.stringify(app.store.db.prepare('SELECT * FROM activity_snapshots').all()), /secret|do-not-save/);
    now += 45_001;
    assert.equal(app.hub.activityFor(member.id).state, 'stale');
    const second = app.hub.openActivityObserver(member.id, 'other');
    assert.equal(app.hub.activityFor(member.id).state, 'unknown', 'a replacement is not fresh before its own response');
    assert.equal(first.heartbeat(), false, 'the replaced source is invalid');
    assert.equal(second.heartbeat(), true);
    assert.equal(app.hub.activityFor(member.id).state, 'observing');
    const saved = app.hub.activityFor(member.id);
    const save = app.store.saveActivity;
    app.store.saveActivity = () => { throw new Error('storage unavailable'); };
    now += 1000;
    assert.equal(second.record({ kind: 'turn', phase: 'started' }), false);
    assert.deepEqual(app.hub.activityFor(member.id), saved, 'failed persistence cannot advance the in-memory snapshot');
    app.store.saveActivity = save;
    second.close();
    assert.equal(app.hub.activityFor(member.id).state, 'disconnected');
    await app.api('DELETE', `/api/clusters/${cluster.id}/members/${member.id}`, {});
    assert.equal(second.heartbeat(), false);
  } finally { Date.now = realNow; await app.close(); }
});

test('reading or acknowledging a message establishes participation without a delivery', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.api('POST', '/api/clusters', { name: 'activity-read', members: [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    ] });
    const first = app.hub.openActivityObserver(a.id, 'test');
    const second = app.hub.openActivityObserver(b.id, 'test');
    assert.equal(first.heartbeat(), false);
    assert.equal(second.heartbeat(), false);
    const message = app.hub.sendFromUser(cluster.id, 'a message without a recipient');
    assert.deepEqual(app.hub.readMessages(a.id).map((m) => m.id), [message.id]);
    assert.equal(first.heartbeat(), true, 'an explicit read is participation');
    assert.equal(second.heartbeat(), false);
    app.hub.ackMessages(b.id, [message.id]);
    assert.equal(second.heartbeat(), true, 'an acknowledgement is participation');
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n, 0);
  } finally { await app.close(); }
});

test('shared bridge limits activity to participating memberships and rejects old epochs and sequences', async () => {
  const dir = tempDir();
  const native = { ...fixtureNativeMock(dir), harness: 'deepseek' };
  const app = await startTestHub({ dir, nativeAdapters: { deepseek: native } });
  const frames: { observerId: string; sessions: string[] }[] = [];
  try {
    const makeCluster = (name: string) => app.api('POST', '/api/clusters', {
      name, members: [{ harness: 'deepseek', mode: 'native', sessionId: 's1', name: 'D' }],
    });
    const { cluster: c1, members: [a] } = await makeCluster('activity-one');
    const { cluster: c2, members: [b] } = await makeCluster('activity-two');
    const disconnect = app.hub.connectBridge('deepseek', null, {
      send() {}, close() {}, sendActivity(frame) { frames.push(frame); },
    });
    assert.deepEqual(frames.at(-1)?.sessions, [], 'membership alone grants no observation');
    app.hub.sendFromMember(a.id, 'first participation');
    const first = frames.at(-1)!;
    assert.deepEqual(first.sessions, ['s1']);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const post = async (payload: unknown, key = secret) => {
      const res = await fetch(`${app.url}/bridge/activity`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-orrery-bridge': key,
      }, body: JSON.stringify(payload) });
      return { status: res.status, body: await res.json() as any };
    };
    const client = new Client({ name: 'activity-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: {
      'x-orrery-bridge': secret, 'x-orrery-harness': 'deepseek', 'x-orrery-session': 's1',
    } } }));
    const list = (clusterId: string) => client.callTool({ name: 'list_agents', arguments: { clusterId } });
    try {
      const before = await list(c2.id);
      assert.equal(JSON.parse((before.content as any)[0].text)[0].activity.state, 'unknown');
      assert.deepEqual(frames.at(-1)?.sessions, ['s1'], 'list_agents alone does not enroll a second membership');
      assert.equal(app.store.hasActivityParticipation(b.id), false);
      assert.equal((await list('unrelated-cluster')).isError, true);
    } finally { await client.close(); }
    const payload = { observerId: first.observerId, sessionId: 's1', seq: 1,
      event: { kind: 'tool', phase: 'requested', toolName: 'bash', arguments: 'hidden-argument', output: 'hidden-output' }, source: 'forged' };
    assert.equal((await post(payload, 'bad-secret')).status, 401);
    assert.deepEqual((await post(payload)).body, { accepted: true });
    assert.deepEqual(app.hub.activityFor(a.id).event, { kind: 'tool', phase: 'requested', toolName: 'bash' });
    assert.equal(app.hub.activityFor(b.id).event, null, 'other membership is not yet eligible');
    const scoped = new Client({ name: 'activity-scope-test', version: '1' });
    await scoped.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: {
      'x-orrery-bridge': secret, 'x-orrery-harness': 'deepseek', 'x-orrery-session': 's1',
    } } }));
    try {
      const listCluster = async (clusterId: string) => {
        const reply = await scoped.callTool({ name: 'list_agents', arguments: { clusterId } });
        return JSON.parse((reply.content as any)[0].text);
      };
      assert.equal((await listCluster(c1.id))[0].activity.event.toolName, 'bash');
      assert.equal((await listCluster(c2.id))[0].activity.event, null);
      assert.equal(app.store.hasActivityParticipation(b.id), false, 'activity query does not grant participation');
    } finally { await scoped.close(); }
    const lastActivityAt = app.hub.activityFor(a.id).lastActivityAt;
    const eventSeq = app.store.lastEventSeq();
    const sameSeq = { ...payload, event: { kind: 'tool', phase: 'failed', toolName: 'different' } };
    assert.equal((await post(sameSeq)).body.accepted, true);
    assert.deepEqual(app.hub.activityFor(a.id).event, { kind: 'tool', phase: 'requested', toolName: 'bash' });
    assert.equal(app.hub.activityFor(a.id).lastActivityAt, lastActivityAt);
    assert.equal(app.store.lastEventSeq(), eventSeq, 'activity and heartbeat never enter historical SSE events');

    app.hub.sendFromMember(b.id, 'second participation');
    const second = frames.at(-1)!;
    assert.notEqual(second.observerId, first.observerId);
    assert.deepEqual(second.sessions, ['s1'], 'one physical session is observed once');
    assert.equal((await post(payload)).body.accepted, false, 'old epoch is rejected');
    assert.equal(app.hub.activityFor(b.id).event, null, 'no old snapshot is copied into the new membership');
    assert.equal((await post({ observerId: second.observerId, sessionId: 's1', seq: 0, event: null })).body.accepted, true);
    const save = app.store.saveActivity;
    app.store.saveActivity = (...args) => {
      if (args[0] === b.id) throw new Error('injected storage failure');
      return save.call(app.store, ...args);
    };
    const next = { observerId: second.observerId, sessionId: 's1', seq: 1,
      event: { kind: 'tool', phase: 'finished', toolName: 'read' } };
    assert.equal((await post(next)).body.accepted, false, 'partial persistence is not acknowledged as complete');
    assert.equal(app.hub.activityFor(a.id).event?.toolName, 'read');
    const alreadyRecordedAt = app.hub.activityFor(a.id).lastActivityAt;
    assert.equal(app.hub.activityFor(b.id).event, null);
    app.store.saveActivity = save;
    assert.equal((await post({ ...next, event: { kind: 'tool', phase: 'failed', toolName: 'injected' } })).body.accepted, true);
    assert.equal(app.hub.activityFor(a.id).lastActivityAt, alreadyRecordedAt, 'a retry is only a heartbeat for a successful member');
    assert.equal(app.hub.activityFor(b.id).event?.toolName, 'read');
    assert.equal((await post({ observerId: second.observerId, sessionId: 's1', seq: 0, event: null })).body.accepted, false);
    const outputs = JSON.stringify([await app.api('GET', '/api/activity'), app.store.db.prepare('SELECT * FROM activity_snapshots').all()]);
    assert.doesNotMatch(outputs, /hidden-argument|hidden-output|forged/);
    await app.api('DELETE', `/api/clusters/${c1.id}/members/${a.id}`, {});
    const third = frames.at(-1)!;
    assert.notEqual(third.observerId, second.observerId);
    assert.deepEqual(third.sessions, ['s1']);
    assert.equal((await post({ observerId: second.observerId, sessionId: 's1', seq: 2,
      event: { kind: 'turn', phase: 'started' } })).body.accepted, false);
    await app.api('DELETE', `/api/clusters/${c2.id}/members/${b.id}`, {});
    assert.deepEqual(frames.at(-1)?.sessions, []);
    disconnect();
  } finally { await app.close(); }
});

test('activity request rechecks membership after the entire body arrives', async () => {
  const dir = tempDir();
  const native = { ...fixtureNativeMock(dir), harness: 'deepseek' };
  const app = await startTestHub({ dir, nativeAdapters: { deepseek: native } });
  try {
    const { cluster, members: [member] } = await app.api('POST', '/api/clusters', {
      name: 'activity-body-race', members: [{ harness: 'deepseek', mode: 'native', sessionId: 's1', name: 'D' }],
    });
    const frames: { observerId: string; sessions: string[] }[] = [];
    const disconnect = app.hub.connectBridge('deepseek', null, {
      send() {}, close() {}, sendActivity(frame) { frames.push(frame); },
    });
    app.hub.sendFromMember(member.id, 'participated');
    const observerId = frames.at(-1)!.observerId;
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const malformed = await fetch(`${app.url}/bridge/activity`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-orrery-bridge': secret,
    }, body: '{"credential":"do-not-echo' });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /do-not-echo/);
    const body = JSON.stringify({ observerId, sessionId: 's1', seq: 1,
      event: { kind: 'tool', phase: 'requested', toolName: 'bash' } });
    const result = Promise.withResolvers<{ status: number; body: any }>();
    const req = request(app.url + '/bridge/activity', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-orrery-bridge': secret,
    } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => result.resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on('error', result.reject);
    req.flushHeaders();
    req.write(body.slice(0, 20));
    await app.api('DELETE', `/api/clusters/${cluster.id}/members/${member.id}`, {});
    req.end(body.slice(20));
    assert.deepEqual(await result.promise, { status: 200, body: { accepted: false } });
    assert.deepEqual(app.store.db.prepare('SELECT * FROM activity_snapshots').all(), []);
    disconnect();
  } finally { await app.close(); }
});

test('activity control-frame failure cannot break a collaboration message', async () => {
  const dir = tempDir();
  const native = { ...fixtureNativeMock(dir), harness: 'deepseek' };
  const app = await startTestHub({ dir, nativeAdapters: { deepseek: native } });
  try {
    const { cluster, members: [member] } = await app.api('POST', '/api/clusters', {
      name: 'activity-send-failure', members: [{ harness: 'deepseek', mode: 'native', sessionId: 's1', name: 'D' }],
    });
    const disconnect = app.hub.connectBridge('deepseek', null, {
      send() {}, close() {}, sendActivity() { throw new Error('control frame failed'); },
    });
    const sent = app.hub.sendFromMember(member.id, 'still succeeds');
    assert.equal(sent.message.body, 'still succeeds');
    assert.equal((await app.messages(cluster.id)).length, 1);
    assert.equal(app.hub.activityFor(member.id).state, 'disconnected');
    disconnect();
  } finally { await app.close(); }
});

test('restart retains activity as history without making an old observer fresh', async () => {
  const dir = tempDir();
  const app = await startTestHub({ dir });
  const { members: [member] } = await app.api('POST', '/api/clusters', {
    name: 'activity-restart', members: [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'D' }],
  });
  app.hub.sendFromMember(member.id, 'participated');
  const observer = app.hub.openActivityObserver(member.id, 'deepseek');
  assert.equal(observer.record({ kind: 'turn', phase: 'started' }), true);
  const last = app.hub.activityFor(member.id);
  await app.close();
  assert.equal(observer.heartbeat(), false, 'the old handle cannot write after Hub close');
  const restarted = await startTestHub({ dir });
  try {
    const history = restarted.hub.activityFor(member.id);
    assert.equal(history.state, 'unknown');
    assert.equal(history.lastActivityAt, last.lastActivityAt);
    assert.deepEqual(history.event, last.event);
  } finally { await restarted.close(); }
});
