// The demo mock of ORRERY_MOCK=1 (src/adapters/mock/demo.ts): it answers in the chat as its member, the way a native
// member speaks, never @-mentions anyone, and the pause switch holds it like any member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoMockAdapter, demoReply } from '../src/adapters/mock/demo.ts';
import { registries } from '../src/adapters/index.ts';
import { startTestHub, waitFor } from './helpers.ts';

test('demo mock: a fake reply per delivery, posted as the member, addressed to nobody, so two mocks never ping-pong', async () => {
  const app = await startTestHub({ nativeAdapters: { mock: createDemoMockAdapter() } });
  try {
    const projects = await app.api('GET', '/api/harnesses/mock/projects');
    assert.equal(projects.length, 1, 'one demo project, so a new demo conversation has a project to pick');
    const { cluster, members: [a, b, c] } = await app.api('POST', '/api/clusters', { name: 'demo', members: [
      { harness: 'mock', sessionId: 'mock-session-1', name: 'A' }, { harness: 'mock', sessionId: 'mock-session-2', name: 'B' },
      { harness: 'mock', mode: 'native', projectPath: projects[0].path, name: 'C' }] });
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A @B @C hello @all' });
    await waitFor(async () => (await app.messages(cluster.id)).length === 4 && app.settled(cluster.id), 'three replies');
    const replies = (await app.messages(cluster.id)).slice(1);
    assert.deepEqual(replies.map((m) => m.from).sort(), [a.id, b.id, c.id].sort());
    for (const r of replies) {
      assert.equal(r.body, demoReply(['user'], 1));
      assert.doesNotMatch(r.body, /@/, 'the reply never names anyone with @');
      assert.deepEqual([r.mentions, r.deliveries], [[], []], 'delivered to nobody');
    }
    // A member's message to another demo mock: one reply, which goes nowhere.
    app.hub.sendFromMember(a.id, '@B ping');
    await waitFor(async () => (await app.messages(cluster.id)).length === 6 && app.settled(cluster.id), 'B answered A');
    const last = (await app.messages(cluster.id)).at(-1)!;
    assert.deepEqual([last.from, last.body, last.deliveries], [b.id, demoReply(['A'], 1), []]);
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal((await app.messages(cluster.id)).length, 6, 'no ping-pong');

    // The pause switch holds a demo mock like any member: no turn, no reply.
    await app.api('POST', '/api/pause', { paused: true });
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A while paused' });
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal((await app.messages(cluster.id)).length, 7, 'no reply while paused');
  } finally {
    await app.close();
  }
});

test('demo mock: it is the mock of ORRERY_MOCK=1 and nothing else registers it', () => {
  assert.equal(registries(false).mock, undefined);
  const demo = registries(true).mock();
  assert.equal(demo.harness, 'mock');
  assert.equal(demo.replies, true, 'answers in the chat as its member');
});

test('demo mock: its conversation reads back as a transcript, a delivery shown as the verified orrery delivery, paged by cursor', async () => {
  const app = await startTestHub({ nativeAdapters: { mock: createDemoMockAdapter() } });
  try {
    const { cluster, members: [a] } = await app.api('POST', '/api/clusters', { name: 'demo', members: [
      { harness: 'mock', sessionId: 'mock-session-1', name: 'A' }] });
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A star map test' });
    await waitFor(async () => (await app.messages(cluster.id)).length === 2 && app.settled(cluster.id), 'the reply');
    const page = await app.hub.memberTranscript(a.id, { limit: 200 });
    assert.equal(page.status, 'ok');
    assert.deepEqual(page.items.map((i) => i.kind), ['user', 'thinking', 'tool_call', 'tool_result', 'assistant', 'orrery_delivery', 'assistant']);
    const delivery = page.items[5];
    assert.equal(delivery.parts?.[0]?.body, '@A star map test', 'the Hub matched the delivery id to the real message');
    assert.ok(page.items.every((i) => !('source' in i)), 'adapter evidence never leaves the Hub');
    const latest = await app.hub.memberTranscript(a.id, { limit: 2 });
    assert.deepEqual(latest.items.map((i) => i.kind), ['orrery_delivery', 'assistant']);
    assert.equal(latest.hasMore, true);
    const older = await app.hub.memberTranscript(a.id, { cursor: latest.before, direction: 'before', limit: 2 });
    assert.deepEqual(older.items.map((i) => i.kind), ['tool_result', 'assistant']);
  } finally {
    await app.close();
  }
});
