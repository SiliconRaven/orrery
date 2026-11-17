// Idle member senders are proactively woken by a system notice when a non-fyi message ends failed or offline
// (docs/collaboration.md), while busy, excluded, paused, capped, or cooldown-bound failures stay unreported for the
// next envelope without loss or loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { DEFAULT_LIMITS, type Limits } from '../src/core/hub.ts';
import { startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

async function mcpCall(app: TestHub, session: string, name: string, args: Record<string, unknown>) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-orrery-bridge': secret, 'x-orrery-session': session, 'x-orrery-harness': 'mock',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const { result } = await res.json();
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

interface SetupOpts {
  limits?: Partial<Limits>;
  onDeliver?: (sessionId: string, text: string) => Promise<any>;
  isOnline?: (sessionId: string) => boolean;
  confirmOnline?: (sessionId: string) => Promise<boolean>;
}

async function setup(opts: SetupOpts = {}) {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3', 's4'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({
    sessions,
    onDeliver: opts.onDeliver ?? (async () => 'completed'),
  });
  if (opts.isOnline) native.isOnline = opts.isOnline;
  if (opts.confirmOnline) native.confirmOnline = opts.confirmOnline;
  const app = await startTestHub({
    dir,
    nativeAdapters: { mock: native },
    limits: { noticeWindowMs: 0, ...opts.limits },
  });
  const { cluster, members } = await app.hub.createCluster('proactive', [
    { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
    { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    { harness: 'mock', mode: 'native', sessionId: 's3', name: 'C' },
    { harness: 'mock', mode: 'native', sessionId: 's4', name: 'D' },
  ]);
  const toSession = (s: string) => native.delivered.filter((d) => d.sessionId === s).map((d) => d.text);
  return { app, cluster, members, native, toSession };
}

test('DEFAULT_LIMITS sets failedNoticeGapMs to 10 minutes', () => {
  assert.equal(DEFAULT_LIMITS.failedNoticeGapMs, 600_000);
});

test('idle sender gets immediate system notice on failed (unknown and null outcome), offline, confirmOnline-offline, and chain-blocked, linking taskIds and not repeating in later envelopes', async () => {
  let cOutcome: 'unknown' | 'null' = 'unknown';
  let confirmResult = false;
  const { app, cluster, members: [a], toSession } = await setup({
    limits: { failedNoticeGapMs: 0 },
    isOnline: (s) => s !== 's2', // s2 is cached offline (no confirmOnline)
    onDeliver: async (s) => {
      if (s === 's3') {
        if (cOutcome === 'unknown') return { outcome: 'unknown', error: 'ack timeout' };
        throw new Error('direct throw null outcome');
      }
      return 'completed';
    },
  });
  try {
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.create', operationId: 't1', title: 'Track failure', scope: 's', acceptance: 'a',
    }).task!;

    // 1. Offline recipient (cached offline at post) + linked task
    const mOffline = await mcpCall(app, 's1', 'send_message', { body: '@B ping offline', taskIds: [task.id] });
    await waitFor(() => toSession('s1').length === 1, 'notice for offline B');
    const offlineText = toSession('s1')[0];
    assert.match(offlineText, /B（离线，未投递）/);
    assert.match(offlineText, /这些投递不会自动重发。/);
    assert.match(offlineText, new RegExp(`"messageId":"${mOffline.messageId}"`));
    const noticeMsg = app.store.listMessages(cluster.id, 50).find((m) => m.from === 'system' && m.body.includes(mOffline.messageId))!;
    assert.ok(noticeMsg);
    assert.deepEqual(noticeMsg.mentions, [a.id]);
    assert.equal(noticeMsg.systemKind, 'delivery_failed', 'the report to the sender is a problem-level warning');
    assert.deepEqual(app.store.tasks?.links(noticeMsg.id), [task.id]);

    // 2. Failed with outcome = 'unknown'
    cOutcome = 'unknown';
    await mcpCall(app, 's1', 'send_message', { body: '@C unknown case' });
    await waitFor(() => toSession('s1').length === 2, 'notice for unknown C');
    assert.match(toSession('s1')[1], /C（结果未知，可能已送达或仍会执行：ack timeout）/);
    assert.match(toSession('s1')[1], /这些投递不会自动重发。/);

    // 3. Failed with outcome = null (throw)
    cOutcome = 'null';
    await mcpCall(app, 's1', 'send_message', { body: '@C null case' });
    await waitFor(() => toSession('s1').length === 3, 'notice for null-outcome C');
    assert.match(toSession('s1')[2], /C（投递流程失败：direct throw null outcome）/);

    // 4. Blocked by maxTurnsPerChain (on its own chain past turn 1)
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 1 });
    await app.hub.sendFromUser(cluster.id, '@A start chain');
    await waitFor(() => toSession('s1').length === 4, 'user turn delivered');
    const chainId = app.store.listMessages(cluster.id, 50).find((m) => m.body === '@A start chain')!.chainId;
    app.store.setDeliveryState(
      app.store.withDeliveries([app.store.listMessages(cluster.id, 50).find((m) => m.body === '@A start chain')!])[0].deliveries[0].id,
      'done', null, 'completed',
    );
    const parentMsg = app.store.listMessages(cluster.id, 50).find((m) => m.chainId === chainId)!;
    const blockedMsg = await mcpCall(app, 's1', 'send_message', { body: '@D blocked chain', replyTo: parentMsg.id });
    await waitFor(() => toSession('s1').length === 5, 'notice for blocked D');
    assert.match(toSession('s1')[4], /D（被拦下：链轮次超限）/);
    assert.match(toSession('s1')[4], new RegExp(blockedMsg.messageId));
    app.hub.setLimit('maxTurnsPerChain', { kind: 'finite', value: 20 });

    // 5. Subsequent normal envelope must NOT repeat already-notified failures
    await app.hub.sendFromUser(cluster.id, '@A followup');
    await waitFor(() => toSession('s1').length === 6, 'followup envelope');
    assert.ok(!toSession('s1')[5].includes('的投递结果：'), 'already reported via proactive notices');
    assert.ok(!toSession('s1')[5].includes('这些投递不会自动重发。'));

    // Recipient B got zero extra wakeups, C got 2 (the two attempts), D got 0
    assert.equal(toSession('s2').length, 0);
    assert.equal(toSession('s4').length, 0);
    void confirmResult;
  } finally {
    await app.close();
  }
});

test('dropOffline via confirmOnline triggers proactive notice for idle sender', async () => {
  const { app, cluster, toSession } = await setup({
    isOnline: (s) => s !== 's2',
    confirmOnline: async (s) => s !== 's2',
  });
  try {
    await mcpCall(app, 's1', 'send_message', { body: '@B confirm offline' });
    await waitFor(() => toSession('s1').length === 1 && app.settled(cluster.id), 'notice after confirmOnline false');
    assert.match(toSession('s1')[0], /B（离线，未投递）/);
  } finally {
    await app.close();
  }
});

test('busy sender (running turn or queued delivery) receives no extra notice; failure stays in next envelope', async () => {
  let releaseHold!: () => void;
  const holdA = new Promise<void>((r) => { releaseHold = r; });
  let hold = true;
  const { app, cluster, toSession } = await setup({
    limits: { maxTurnsPerHour: 2, recheckMs: 60_000 },
    isOnline: (s) => s !== 's2',
    onDeliver: async (s) => {
      if (s === 's1' && hold) { hold = false; await holdA; }
      return 'completed';
    },
  });
  try {
    await app.hub.sendFromUser(cluster.id, '@A busy');
    await mcpCall(app, 's1', 'send_message', { body: '@B while busy' });
    assert.equal(
      app.store.listMessages(cluster.id, 50).filter((m) => m.from === 'system' && m.body.includes('投递结果')).length,
      0,
      'no proactive notice while A is running',
    );
    releaseHold();
    await waitFor(() => app.settled(cluster.id));
    assert.equal(toSession('s1').length, 1, 'still only the initial turn ran');

    // A's next envelope reports the failure once
    await app.hub.sendFromUser(cluster.id, '@A next envelope');
    await waitFor(() => toSession('s1').length === 2);
    assert.match(toSession('s1')[1], /B（离线，未投递）/);
    assert.match(toSession('s1')[1], /这些投递不会自动重发。/);

    // Queued delivery waiting for A while unpaused (at per-hour turn cap) -> also suppresses proactive wakeup
    await app.hub.sendFromUser(cluster.id, '@A queued over cap');
    await mcpCall(app, 's1', 'send_message', { body: '@B while queued' });
    assert.equal(
      app.store.listMessages(cluster.id, 50).filter((m) => m.from === 'system' && m.body.includes('投递结果')).length,
      0,
      'no proactive notice while A already has a queued delivery',
    );
    const [a] = app.store.listMembers(cluster.id);
    clearTimeout((app.hub as any).throttled.get(a.id));
    (app.hub as any).throttled.delete(a.id);
    (app.hub as any).turnStarts.clear();
    (app.hub as any).schedule(a.id);
    await waitFor(() => toSession('s1').length === 3 && app.settled(cluster.id));
    assert.match(toSession('s1')[2], /B（离线，未投递）/);
  } finally {
    releaseHold();
    await app.close();
  }
});

test('exclusions: fyi, user, system, and external plugin messages never trigger proactive sender notices', async () => {
  const { app, cluster, members: [, b], toSession } = await setup({
    isOnline: (s) => s !== 's2',
    onDeliver: async (s) => { if (s === 's3') throw new Error('C fails'); return 'completed'; },
  });
  try {
    // 1. fyi=true + replyTo override creates a delivery to C which fails -> fyi message must NOT trigger proactive notice
    const question = await mcpCall(app, 's3', 'send_message', { body: '@A any updates?' });
    await waitFor(() => toSession('s1').length === 1);
    await mcpCall(app, 's1', 'send_message', { body: '@C fyi reply', fyi: true, replyTo: question.messageId });
    // Also plain fyi to offline B
    await mcpCall(app, 's1', 'send_message', { body: '@B plain fyi', fyi: true });
    await waitFor(() => app.settled(cluster.id));

    // 2. user message to offline B
    await app.hub.sendFromUser(cluster.id, '@B from user');
    await waitFor(() => app.settled(cluster.id));

    // 3. system notice to offline B
    const sysTask = app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.create', operationId: 't-sys', title: 'sys', scope: 's', acceptance: 'a',
    }).task!;
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.nominate', operationId: 't-sys-nom', taskId: sysTask.id, expectedRevision: sysTask.revision, memberId: b.id,
    });
    await waitFor(() => app.settled(cluster.id));

    // 4. external plugin message to offline B
    app.hub.sendFromExternalPlugin('notifier-ext', cluster.id, '@B from plugin', null, true);
    await waitFor(() => app.settled(cluster.id));

    const proactiveMsgs = app.store.listMessages(cluster.id, 100).filter(
      (m) => m.from === 'system' && m.body.includes('你之前发的消息'),
    );
    assert.equal(proactiveMsgs.length, 0, 'none of fyi/user/system/plugin created a proactive sender notice');
  } finally {
    await app.close();
  }
});

test('cooldown per (sender, recipient): second failure within interval stays for next envelope; other recipient or post-interval still notifies', async () => {
  const { app, cluster, members: [a, b], toSession } = await setup({
    limits: { failedNoticeGapMs: 5_000 },
    isOnline: (s) => s !== 's2' && s !== 's3',
  });
  try {
    // 1st failure to B -> wakes A
    await mcpCall(app, 's1', 'send_message', { body: '@B first' });
    await waitFor(() => toSession('s1').length === 1, '1st B notice');

    // 2nd failure to B inside cooldown -> suppressed for proactive notice, stays reported=0
    const m2 = await mcpCall(app, 's1', 'send_message', { body: '@B second' });
    await waitFor(() => app.settled(cluster.id));
    assert.equal(toSession('s1').length, 1, 'no second wakeup within cooldown');

    // Different recipient C fails inside B's cooldown -> wakes A AND its envelope tail includes suppressed m2!
    const m3 = await mcpCall(app, 's1', 'send_message', { body: '@C other recipient' });
    await waitFor(() => toSession('s1').length === 2, 'C wakes A immediately');
    assert.match(toSession('s1')[1], new RegExp(m3.messageId));
    assert.match(toSession('s1')[1], new RegExp(m2.messageId), 'earlier suppressed failure rides along in envelope tail');

    // Simulate elapsed cooldown -> failure to B wakes A again
    (app.hub as any).failedNoticeAt.set(`${a.id}\0${b.id}`, Date.now() - 6_000);
    const m4 = await mcpCall(app, 's1', 'send_message', { body: '@B after cooldown' });
    await waitFor(() => toSession('s1').length === 3, 'B wakes again after cooldown');
    assert.match(toSession('s1')[2], new RegExp(m4.messageId));
  } finally {
    await app.close();
  }
});

test('proactive notice failure creates no recursive notice and keeps original delivery unreported until next envelope', async () => {
  let failA = true;
  const { app, cluster, toSession } = await setup({
    isOnline: (s) => s !== 's2',
    onDeliver: async (s) => {
      if (s === 's1' && failA) { failA = false; throw new Error('sender unreachable'); }
      return 'completed';
    },
  });
  try {
    const orig = await mcpCall(app, 's1', 'send_message', { body: '@B while A failing' });
    await waitFor(() => toSession('s1').length === 1 && app.settled(cluster.id), 'notice attempt failed');
    const systemNotices = app.store.listMessages(cluster.id, 100).filter((m) => m.from === 'system' && m.body.includes('投递结果'));
    assert.equal(systemNotices.length, 1, 'failed system notice creates no new notice for itself');

    // A's next envelope still reports original failure
    await app.hub.sendFromUser(cluster.id, '@A recover');
    await waitFor(() => toSession('s1').length === 2);
    assert.match(toSession('s1')[1], new RegExp(orig.messageId));
    assert.match(toSession('s1')[1], /B（离线，未投递）/);
  } finally {
    await app.close();
  }
});

test('hourly notice limit and pause suppress proactive notice without losing delivery in next envelope', async () => {
  // 1. Hourly notice limit = 0
  {
    const { app, cluster, toSession } = await setup({
      limits: { maxNoticeBatchesPerHour: 0 },
      isOnline: (s) => s !== 's2',
    });
    try {
      const sent = await mcpCall(app, 's1', 'send_message', { body: '@B capped' });
      await waitFor(() => app.settled(cluster.id));
      assert.equal(toSession('s1').length, 0, 'blocked by maxNoticeBatchesPerHour=0');
      await app.hub.sendFromUser(cluster.id, '@A user turn');
      await waitFor(() => toSession('s1').length === 1);
      assert.match(toSession('s1')[0], new RegExp(sent.messageId));
      assert.match(toSession('s1')[0], /B（离线，未投递）/);
    } finally {
      await app.close();
    }
  }

  // 2. Cluster pause & global pause
  {
    const { app, cluster, toSession } = await setup({ isOnline: (s) => s !== 's2' });
    try {
      app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'p1', paused: true });
      const sent1 = await mcpCall(app, 's1', 'send_message', { body: '@B cluster paused' });
      app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId: 'p2', paused: false });
      await waitFor(() => app.settled(cluster.id));
      assert.equal(toSession('s1').length, 0, 'cluster pause suppressed proactive notice');

      app.hub.setPaused(true);
      const sent2 = await mcpCall(app, 's1', 'send_message', { body: '@B global paused' });
      app.hub.setPaused(false);
      await waitFor(() => app.settled(cluster.id));
      assert.equal(toSession('s1').length, 0, 'global pause suppressed proactive notice');

      await app.hub.sendFromUser(cluster.id, '@A see both');
      await waitFor(() => toSession('s1').length === 1);
      assert.match(toSession('s1')[0], new RegExp(sent1.messageId));
      assert.match(toSession('s1')[0], new RegExp(sent2.messageId));
    } finally {
      await app.close();
    }
  }
});

test('noticeWindowMs batches proactive notice with incoming user message without duplicate failure text', async () => {
  const { app, cluster, toSession } = await setup({
    limits: { noticeWindowMs: 2_000 },
    isOnline: (s) => s !== 's2',
  });
  try {
    const sent = await mcpCall(app, 's1', 'send_message', { body: '@B inside window' });
    // Flush the noticeWait immediately by sending a user message inside noticeWindowMs
    await app.hub.sendFromUser(cluster.id, '@A urgent');
    await waitFor(() => toSession('s1').length === 1 && app.settled(cluster.id));
    const text = toSession('s1')[0];
    const detailMatches = [...text.matchAll(new RegExp(`"messageId":"${sent.messageId}"`, 'g'))];
    assert.equal(detailMatches.length, 1, 'failure details appear once, never duplicated in tail');
    await app.hub.sendFromUser(cluster.id, '@A next');
    await waitFor(() => toSession('s1').length === 2);
    assert.ok(!toSession('s1')[1].includes('的投递结果：'), 'already marked reported');
  } finally {
    await app.close();
  }
});

test('coordinator who is also the sender receives at most one notification for the same failure', async () => {
  const { app, cluster, members: [a], toSession } = await setup({
    isOnline: (s) => s !== 's2',
  });
  try {
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'coordinator.set', operationId: 'c1', memberId: a.id, enabled: true, mode: 'execute',
    });
    const task = app.hub.collaboration.command({ kind: 'user' }, cluster.id, {
      action: 'task.create', operationId: 't-coord', title: 'open task', scope: 's', acceptance: 'a',
    }).task!;
    await waitFor(() => app.settled(cluster.id));
    const before = toSession('s1').length;

    const sent = await mcpCall(app, 's1', 'send_message', { body: '@B coord-is-sender', taskIds: [task.id] });
    await waitFor(() => toSession('s1').length === before + 1 && app.settled(cluster.id), 'exactly one notice to A');
    const msgs = app.store.listMessages(cluster.id, 100).filter((m) => m.from === 'system' && m.body.includes(sent.messageId));
    assert.equal(msgs.length, 1, 'only one system message posted when coordinator is sender');
  } finally {
    await app.close();
  }
});

test('rebindMember interrupting a running delivery notifies idle sender once and not again on late completion', async () => {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's5'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  let bRunning = false;
  let releaseB!: () => void;
  const bGate = new Promise<void>((r) => { releaseB = r; });
  const native = createMockNativeAdapter({
    sessions,
    onDeliver: async (s) => {
      if (s === 's2' && !bRunning) { bRunning = true; await bGate; }
      return 'completed';
    },
  });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, limits: { noticeWindowMs: 0 } });
  const toA = () => native.delivered.filter((d) => d.sessionId === 's1').map((d) => d.text);
  try {
    const { cluster, members: [, b] } = await app.hub.createCluster('rebind-notice', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const sent = await mcpCall(app, 's1', 'send_message', { body: '@B hold during rebind' });
    await waitFor(() => bRunning, 'B delivery started');

    await app.hub.rebindMember(b.id, { harness: 'mock', sessionId: 's5', confirmStopped: true });
    await waitFor(() => toA().length === 1, 'sender notified after rebind');
    assert.match(toA()[0], /B（结果未知，可能已送达或仍会执行：成员已换对话/);
    assert.match(toA()[0], new RegExp(sent.messageId));

    // Releasing the detached old run must not trigger a duplicate notice, nor repeat in later envelopes.
    releaseB();
    await waitFor(() => app.settled(cluster.id));
    assert.equal(toA().length, 1);

    await app.hub.sendFromUser(cluster.id, '@A followup');
    await waitFor(() => toA().length === 2);
    assert.ok(!toA()[1].includes('的投递结果：'), 'already marked reported');
  } finally {
    releaseB();
    await app.close();
  }
});

test('removeMember failing running or queued deliveries notifies idle sender once and skips removed senders', async () => {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  let bStarted = false;
  let releaseB!: () => void;
  const bGate = new Promise<void>((r) => { releaseB = r; });
  let cStarted = false;
  let releaseC!: () => void;
  const cGate = new Promise<void>((r) => { releaseC = r; });
  const native = createMockNativeAdapter({
    sessions,
    onDeliver: async (s) => {
      if (s === 's2' && !bStarted) { bStarted = true; await bGate; }
      if (s === 's3' && !cStarted) { cStarted = true; await cGate; }
      return 'completed';
    },
  });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native }, limits: { noticeWindowMs: 0, failedNoticeGapMs: 0 } });
  const toA = () => native.delivered.filter((d) => d.sessionId === 's1').map((d) => d.text);
  try {
    const { cluster, members: [a, b, c] } = await app.hub.createCluster('remove-notice', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
      { harness: 'mock', mode: 'native', sessionId: 's3', name: 'C' },
    ]);
    // 1. Running delivery cancelled by removeMember(B) -> A gets one notice, late finish does not duplicate
    const sentRun = await mcpCall(app, 's1', 'send_message', { body: '@B while running' });
    await waitFor(() => bStarted, 'B delivery started');
    app.hub.removeMember(cluster.id, b.id);
    await waitFor(() => toA().length === 1, 'A notified of removed B');
    assert.match(toA()[0], /B（结果未知，可能已送达或仍会执行：成员已移出集群/);
    assert.match(toA()[0], new RegExp(sentRun.messageId));
    releaseB();
    await waitFor(() => app.settled(cluster.id));
    assert.equal(toA().length, 1);

    // 2. Queued delivery behind another running turn on C, cancelled by removeMember(C) -> A gets notice
    await app.hub.sendFromUser(cluster.id, '@C hold queue');
    await waitFor(() => cStarted, 'C turn running');
    const sentQueued = await mcpCall(app, 's1', 'send_message', { body: '@C queued behind hold' });
    app.hub.removeMember(cluster.id, c.id);
    await waitFor(() => toA().length === 2, 'A notified of queued C cancelled by removal');
    assert.match(toA()[1], /C（投递流程失败：成员已移出集群，投递已取消）/);
    assert.match(toA()[1], new RegExp(sentQueued.messageId));
    releaseC();
    await waitFor(() => app.settled(cluster.id));

    // 3. Removing sender A itself triggers no notice to A and throws no error
    await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's2', name: 'D' }]);
    native.isOnline = (s) => s !== 's2';
    app.hub.setPaused(true);
    await mcpCall(app, 's1', 'send_message', { body: '@D before A removed' });
    app.hub.removeMember(cluster.id, a.id);
    app.hub.setPaused(false);
    await waitFor(() => app.settled(cluster.id));
    assert.equal(toA().length, 2);
  } finally {
    releaseB();
    releaseC();
    await app.close();
  }
});

test('restart recovery (recoverRunning) notifies idle sender once started without duplicate on subsequent envelopes', async () => {
  const dir = tempDir();
  const home = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  let bStarted = false;
  const native1 = createMockNativeAdapter({
    sessions,
    onDeliver: async (s, _t, ctx) => {
      if (s === 's2' && !bStarted) {
        bStarted = true;
        await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r(), { once: true }));
      }
      return 'completed';
    },
  });
  let sentId = '';
  let clusterId = '';
  const app1 = await startTestHub({ dir, home, nativeAdapters: { mock: native1 }, limits: { noticeWindowMs: 0 } });
  try {
    const created = await app1.hub.createCluster('restart-notice', [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    clusterId = created.cluster.id;
    sentId = (await mcpCall(app1, 's1', 'send_message', { body: '@B interrupted by restart' })).messageId;
    await waitFor(() => bStarted, 'B delivery running before shutdown');
  } finally {
    await app1.close();
  }

  const native2 = createMockNativeAdapter({ sessions });
  const toA2 = () => native2.delivered.filter((d) => d.sessionId === 's1').map((d) => d.text);
  const app2 = await startTestHub({ dir, home, nativeAdapters: { mock: native2 }, limits: { noticeWindowMs: 0, startupGraceMs: 0 } });
  try {
    await waitFor(() => toA2().length === 1 && app2.settled(clusterId), 'idle sender A notified after restart');
    assert.match(toA2()[0], /B（结果未知，可能已送达或仍会执行：Hub 重启时投递仍在进行，结果未知/);
    assert.match(toA2()[0], new RegExp(sentId));

    // Subsequent envelope must not repeat the recovered failure
    await app2.hub.sendFromUser(clusterId, '@A after restart notice');
    await waitFor(() => toA2().length === 2);
    assert.ok(!toA2()[1].includes('的投递结果：'), 'already marked reported');
  } finally {
    await app2.close();
  }
});
