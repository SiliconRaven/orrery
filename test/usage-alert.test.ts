import { tempDir } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageAlert, type MemberUsage } from '../src/core/usage.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { startTestHub } from './helpers.ts';

const { usageAlertText } = await import(new URL('../src/web/public/ui.js', import.meta.url).href);

const totals = (input: number, cachedInput = 0, cacheWrite = 0, output = 0) => ({ input, cachedInput, cacheWrite, output, reasoning: 0 });
const row = (turn: number | null, conversation: ReturnType<typeof totals> | null): MemberUsage => ({
  memberId: 'm', harness: 'mock', viaOrrery: null, conversationSupported: true, latestTurnTokens: turn, conversation,
});

test('a long native conversation shows on the usage report without a recorded turn, and tells the coordinator nothing', async () => {
  const native = createMockNativeAdapter({ harness: 'mock', sessions: [{ id: 'session', title: 'session', model: null, cwd: '.', updatedAt: null }] });
  native.conversationTokens = async () => totals(70, 20, 5, 6);
  const app = await startTestHub({ nativeAdapters: { mock: native }, limits: { idleSweepMs: 60_000, quotaPollMs: 0 } });
  try {
    const { cluster, members: [coordinator, member] } = await app.hub.createCluster('conversation', [
      { projectPath: tempDir(), harness: 'mock', mode: 'native', name: 'Coordinator' },
      { harness: 'mock', mode: 'native', sessionId: 'session', name: 'Member' },
    ]);
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'coordinator.set', operationId: 'coord', memberId: coordinator.id, enabled: true, mode: 'execute' });
    await app.api('PATCH', '/api/settings', { usageAlert: { turnTokens: 0, conversationTokens: 100 } });
    const row = (await app.hub.usageReport(cluster.id)).members.find((m) => m.memberId === member.id)!;
    assert.deepEqual(row.alert, { turnTokens: null, conversationTokens: 101 });
    assert.equal(usageAlertText(row), '对话已很长（单轮 未知 / 合计 101），建议在应用里开新对话或压缩。', 'the member page and list show this text');
    assert.deepEqual(app.store.listMessages(cluster.id, 500).filter((message) => message.body.includes('对话已很长')), [],
      'no chat message, so no delivery to the coordinator');
  } finally { await app.close(); }
});

test('usage thresholds are strict, independent, and zero disables a signal', () => {
  const limits = { turnTokens: 100, conversationTokens: 200 };
  assert.equal(usageAlert(row(100, totals(200)), limits), null);
  assert.deepEqual(usageAlert(row(101, null), limits), { turnTokens: 101, conversationTokens: null });
  assert.deepEqual(usageAlert(row(null, totals(100, 50, 30, 21)), limits), { turnTokens: null, conversationTokens: 201 });
  assert.equal(usageAlert(row(999, totals(999)), { turnTokens: 0, conversationTokens: 0 }), null);
});

test('settings persist and a long turn shows only on the usage report', async () => {
  const app = await startTestHub({ limits: { idleSweepMs: 60_000, quotaPollMs: 0 } });
  try {
    const { cluster, members: [coordinator, member] } = await app.cluster('alerts', ['Coordinator', 'Member']);
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'coordinator.set', operationId: 'coord',
      memberId: coordinator.id, enabled: true, mode: 'execute' });
    const settings = await app.api('GET', '/api/settings');
    assert.deepEqual(settings.usageAlert, { turnTokens: 20_000_000, conversationTokens: 200_000_000 });
    await assert.rejects(app.api('PATCH', '/api/settings', { usageAlert: { turnTokens: -1, conversationTokens: 0 } }));
    await app.api('PATCH', '/api/settings', { usageAlert: { turnTokens: 10, conversationTokens: 0 } });
    assert.deepEqual((await app.api('GET', '/api/settings')).usageAlert, { turnTokens: 10, conversationTokens: 0 });
    const withNotifications = await app.api('PATCH', '/api/settings', { stalledMemberMinutes: 12 });
    assert.equal(withNotifications.stalledMemberMinutes, 12);
    assert.deepEqual(withNotifications.usageAlert, { turnTokens: 10, conversationTokens: 0 });
    const hub = app.hub as any;
    const alert = async () => (await app.hub.usageReport(cluster.id)).members.find((m) => m.memberId === member.id)?.alert;
    hub.usage.recordTurn(member, 'turn-a', totals(4, 3, 100, 3));
    assert.equal(await alert(), null, 'exactly at threshold does not alert, and cache writes are excluded');
    hub.usage.recordTurn(member, 'turn-b', totals(4, 3, 0, 4));
    assert.equal((await alert())?.turnTokens, 11);
    assert.deepEqual(app.store.listMessages(cluster.id, 500).filter((m) => m.body.includes('对话已很长')), [],
      'no chat message, so no delivery to the coordinator');
    await app.api('PATCH', '/api/settings', { usageAlert: { turnTokens: 0, conversationTokens: 0 } });
    assert.equal((await app.hub.usageReport(cluster.id)).members.find((m) => m.memberId === member.id)?.alert, null);
    assert.deepEqual(app.store.getUsageAlert(), { turnTokens: 0, conversationTokens: 0 });
  } finally { await app.close(); }
  const reopened = await startTestHub({ dir: app.dir, limits: { quotaPollMs: 0 } });
  try { assert.deepEqual((await reopened.api('GET', '/api/settings')).usageAlert, { turnTokens: 0, conversationTokens: 0 }); }
  finally { await reopened.close(); }
});
