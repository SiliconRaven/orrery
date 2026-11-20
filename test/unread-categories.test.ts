import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { CHAIN_LIMIT_ERROR } from '../src/core/delivery-timeline.ts';
import { REPO_ROOT } from '../src/main.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

async function mcpJsonRpc(app: Awaited<ReturnType<typeof startTestHub>>, session: string, method: string, params: Record<string, unknown>, harness = 'mock') {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-orrery-bridge': secret,
      'x-orrery-session': session,
      'x-orrery-harness': harness,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { result: any };
}

function makeNative(dir: string, sessionIds: string[], offline = new Set<string>(), onDeliver?: (sessionId: string, text: string) => Promise<'completed'>) {
  const adapter = createMockNativeAdapter({
    sessions: sessionIds.map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null })),
    ...(onDeliver ? { onDeliver } : {}),
  });
  adapter.isOnline = (s) => !offline.has(s);
  return adapter;
}

test('receipts and queue warnings stay out of unread, keep deliveries empty, and stay readable in history', async () => {
  const dir = tempDir();
  let holding = true;
  let releaseTurn: (() => void) | undefined;
  const native = createMockNativeAdapter({
    sessions: ['sa', 'sb'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null })),
    onDeliver: (sessionId, _text, ctx) => {
      if (sessionId !== 'sb' || !holding) return Promise.resolve('completed');
      return new Promise((resolve) => {
        releaseTurn = () => resolve('completed');
        ctx.signal.addEventListener('abort', () => resolve('completed'), { once: true });
      });
    },
  });
  const app = await startTestHub({
    dir,
    nativeAdapters: { mock: native },
    limits: { recheckMs: 600_000, startupGraceMs: 0, queueWarnMs: 1 },
  });
  try {
    const { cluster, members: [a, b] } = await app.hub.createCluster('receipt-warning', [
      { harness: 'mock', mode: 'native', sessionId: 'sa', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 'sb', name: 'B' },
    ]);
    // 1. Trigger a real queue warning on a delayed delivery to B while B is held busy.
    app.hub.sendFromUser(cluster.id, '@B busy first');
    await waitFor(() => app.hub.listMembers(cluster.id).find((m) => m.id === b.id)?.status === 'busy', 'B busy');
    const secondToB = app.hub.sendFromMember(a.id, '@B delayed second');
    await sleep(10);
    (app.hub as unknown as { warnLongQueues(): void }).warnLongQueues();
    holding = false;
    releaseTurn?.();
    await waitFor(() => app.settled(cluster.id), 'cluster settled');

    // A sends a message to B, then B explicitly acknowledges it so A gets a receipt.
    const msgToAckId = randomUUID();
    app.store.insertMessage({
      id: msgToAckId, clusterId: cluster.id, from: a.id, mentions: [b.id],
      body: '@B please confirm', replyTo: null, chainId: msgToAckId, hop: 0, createdAt: new Date().toISOString(),
    }, []);
    app.store.markRead(a.id, app.store.unreadIds(a.id, cluster.id), 'read_messages');
    app.store.markRead(b.id, app.store.unreadIds(b.id, cluster.id), 'read_messages');

    const unreadBeforeAck = app.store.countUnread(a.id, cluster.id);
    app.hub.ackMessages(b.id, [msgToAckId]);
    assert.ok(!app.store.listMessages(cluster.id, 200).some((m) => m.systemKind === 'receipt'), 'acknowledging writes no receipt message');
    // A receipt written before receipts were dropped keeps its old category.
    const oldReceiptId = randomUUID();
    app.store.insertMessage({ id: oldReceiptId, clusterId: cluster.id, from: 'system', kind: 'system', systemKind: 'receipt', mentions: [a.id],
      body: '确认回执：B 确认看到了你发的 1 条消息（最近一条：「@B please confirm」）。', replyTo: null, chainId: oldReceiptId, hop: 0,
      createdAt: new Date().toISOString() }, []);

    const msgs = app.store.listMessages(cluster.id, 200);
    const receipt = msgs.find((m) => m.id === oldReceiptId);
    const warning = msgs.find((m) => m.body.startsWith('排队预警：'));
    assert.ok(receipt, `receipt missing; bodies=${JSON.stringify(msgs.map((m) => [m.from, m.kind, m.systemKind, m.body]))}`);
    assert.ok(warning, `warning missing; bodies=${JSON.stringify(msgs.map((m) => [m.from, m.kind, m.systemKind, m.body]))}`);
    assert.equal(receipt.systemKind, 'receipt');
    assert.equal(warning.systemKind, 'queue_warning');
    assert.deepEqual(app.store.withDeliveries([receipt])[0].deliveries, []);
    assert.deepEqual(app.store.withDeliveries([warning])[0].deliveries, []);

    assert.equal(app.store.countUnread(a.id, cluster.id), unreadBeforeAck);
    assert.equal(app.store.unreadBreakdown(a.id, cluster.id).total, 0);
    assert.deepEqual(app.hub.readMessages(a.id), []);
    assert.equal(app.hub.skipUnread(a.id, { before: receipt.id }), 0);

    // Readable via history & category: 'receipt_warning', annotated cleanly via store helper.
    const rwHistory = app.hub.readMessages(a.id, { history: true, category: 'receipt_warning' });
    const rwAnn = app.store.annotateMessagesForMember(a.id, rwHistory);
    assert.ok(rwHistory.some((m) => m.id === receipt.id && rwAnn.get(m.id)?.category === 'receipt_warning'));
    const filteredStore = app.store.listMessages(cluster.id, 200, undefined, { category: 'receipt_warning', categoryMemberId: a.id });
    assert.ok(filteredStore.some((m) => m.id === warning.id));
    assert.ok(filteredStore.some((m) => m.id === receipt.id));
    assert.ok(!app.store.listMessages(cluster.id, 200).some((m) => m.id === secondToB.message.id && m.systemKind));
    // category 'warning' (system-kinds.js): the queue warning, not the old receipt nor an old system row without a kind.
    const oldRowId = randomUUID();
    app.store.insertMessage({ id: oldRowId, clusterId: cluster.id, from: 'system', kind: 'system', mentions: [a.id],
      body: '投递失败或离线：an old notice without a kind', replyTo: null, chainId: oldRowId, hop: 0, createdAt: new Date().toISOString() }, []);
    const warnings = app.hub.readMessages(a.id, { history: true, category: 'warning' }).map((m) => m.id);
    assert.ok(warnings.includes(warning.id));
    assert.ok(!warnings.includes(receipt.id) && !warnings.includes(oldRowId), 'old rows are never classified by their text');
    assert.equal(app.store.annotateMessagesForMember(a.id, [app.store.getMessage(oldRowId)!]).get(oldRowId)?.category, 'task_notice',
      'the unread categories are unchanged');
    assert.throws(() => app.hub.readMessages(a.id, { history: true, category: 'nope' as never }), /warning/);
  } finally {
    holding = false;
    releaseTurn?.();
    await app.close();
  }
});

test('categorized unread breakdown, parallel annotations across categories, dedup signature, envelope, and zero new wakeups', async () => {
  const dir = tempDir();
  const offlineSet = new Set(['sa']);
  const delivered: { sessionId: string; text: string }[] = [];
  const adapter = makeNative(dir, ['sa', 'sb'], offlineSet, async (sessionId, text) => {
    delivered.push({ sessionId, text });
    return 'completed';
  });

  const app = await startTestHub({ dir, nativeAdapters: { mock: adapter } });
  try {
    const { cluster, members: [a, b] } = await app.hub.createCluster('cat', [
      { harness: 'mock', mode: 'native', sessionId: 'sa', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 'sb', name: 'B' },
    ]);

    const t0 = Date.now();
    const ts = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
    const insertWithDelivery = (
      opts: { id: string; from: string; kind?: 'chat' | 'system'; mentions: string[]; body: string; fyi?: boolean; explicitMentions?: string[]; offsetMs: number },
      delivery?: { state: 'offline' | 'failed'; error: string | null; outcome: 'unknown' | null },
    ) => {
      app.store.insertMessage({
        id: opts.id, clusterId: cluster.id, from: opts.from, kind: opts.kind, mentions: opts.mentions,
        body: opts.body, replyTo: null, chainId: opts.id, hop: 0, createdAt: ts(opts.offsetMs),
        ...(opts.fyi ? { fyi: true } : {}), ...(opts.explicitMentions !== undefined ? { explicitMentions: opts.explicitMentions } : {}),
      }, []);
      if (delivery) {
        app.store.db.prepare(
          'INSERT INTO deliveries (id, message_id, member_id, state, error, updated_at, attempts, reported, outcome) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
        ).run(randomUUID(), opts.id, a.id, delivery.state, delivery.error, ts(opts.offsetMs), delivery.outcome);
      }
    };

    // mention (6 total): fyi, offline, failed(outcome='unknown'), failed(outcome=null), explicit @A inside member @all, AND user @all blocked
    insertWithDelivery({ id: 'm-fyi', from: b.id, mentions: [a.id], body: '@A fyi note', fyi: true, offsetMs: 1 });
    insertWithDelivery({ id: 'm-off', from: 'user', mentions: [a.id], body: '@A while offline', offsetMs: 2 },
      { state: 'offline', error: '成员离线，未投递', outcome: null });
    insertWithDelivery({ id: 'm-unk', from: b.id, mentions: [a.id], body: '@A unknown outcome', offsetMs: 3 },
      { state: 'failed', error: 'timeout', outcome: 'unknown' });
    insertWithDelivery({ id: 'm-null', from: b.id, mentions: [a.id], body: '@A legacy null outcome', offsetMs: 4 },
      { state: 'failed', error: 'adapter died', outcome: null });
    insertWithDelivery({ id: 'm-all-exp', from: b.id, mentions: [a.id], body: '@all @A explicit inside broadcast', explicitMentions: [a.id], offsetMs: 5 },
      { state: 'offline', error: '成员离线，未投递', outcome: null });
    insertWithDelivery({ id: 'm-all-blk', from: 'user', mentions: [a.id, b.id], body: '@all urgent notice', offsetMs: 8 },
      { state: 'failed', error: CHAIN_LIMIT_ERROR, outcome: 'unknown' });

    // user (2 total): plain user + coordinator fallback user (mentions=[]) with failed delivery
    insertWithDelivery({ id: 'u-plain', from: 'user', mentions: [], body: 'user note to chat', offsetMs: 6 });
    insertWithDelivery({ id: 'u-fail', from: 'user', mentions: [], body: 'user fallback failed', offsetMs: 7 },
      { state: 'failed', error: 'adapter crash', outcome: 'unknown' });

    // broadcast (1 total): member @all with fyi annotation (non-mention category carries parallel annotation)
    insertWithDelivery({ id: 'bc-fyi', from: b.id, mentions: [a.id], body: '@all member fyi notice', fyi: true, explicitMentions: [], offsetMs: 8 });

    // task_notice (1 total): system notice without systemKind, offline delivery
    insertWithDelivery({ id: 'tn-off', from: 'system', kind: 'system', mentions: [a.id], body: '任务提醒：请检查', offsetMs: 9 },
      { state: 'offline', error: '成员离线，未投递', outcome: null });

    const breakdown = app.store.unreadBreakdown(a.id, cluster.id);
    assert.deepEqual(breakdown, {
      total: 10,
      mention: { total: 6, fyi: 1, offline: 2, failedOrUnknown: 2, blocked: 1 },
      user: { total: 2, fyi: 0, offline: 0, failedOrUnknown: 1, blocked: 0 },
      broadcast: { total: 1, fyi: 1, offline: 0, failedOrUnknown: 0, blocked: 0 },
      taskNotice: { total: 1, fyi: 0, offline: 1, failedOrUnknown: 0, blocked: 0 },
    });

    const deliveriesBeforeHint = app.store.listEvents(0).filter((e) => e.kind === 'delivery').length;
    const hint1 = app.hub.unreadHintFor('mock', 'sa');
    assert.equal(
      hint1,
      'orrery：未读 10：点名你 6（仅知会 1，离线 2，失败或结果未知 2，被上限拦住 1） · 用户 2（失败或结果未知 1） · 广播 1（仅知会 1） · 任务通知 1（离线 1），方便时用 read_messages 查看',
    );
    assert.equal(app.hub.unreadHintFor('mock', 'sa'), '');
    assert.equal(app.store.listEvents(0).filter((e) => e.kind === 'delivery').length, deliveriesBeforeHint);
    assert.equal(delivered.length, 0);

    // Same total count (10 -> 10), different breakdown (read 1 user msg, add 1 task_notice): MUST produce a new hint!
    app.store.markRead(a.id, ['u-plain'], 'read_messages');
    insertWithDelivery({ id: 'tn-2', from: 'system', kind: 'system', mentions: [a.id], body: '新系统通知', offsetMs: 10 });
    const hint2 = app.hub.unreadHintFor('mock', 'sa');
    assert.equal(
      hint2,
      'orrery：未读 10：点名你 6（仅知会 1，离线 2，失败或结果未知 2，被上限拦住 1） · 用户 1（失败或结果未知 1） · 广播 1（仅知会 1） · 任务通知 2（离线 1），方便时用 read_messages 查看',
    );

    // Multi-cluster suffix check:
    const secondCluster = await app.hub.createCluster('cat2', [{ harness: 'mock', mode: 'native', sessionId: 'sa', name: 'A2' }]);
    app.store.insertMessage({
      id: 'c2-u', clusterId: secondCluster.cluster.id, from: 'user', mentions: [], body: 'hi c2', replyTo: null, chainId: 'c2-u', hop: 0, createdAt: ts(11),
    }, []);
    assert.equal(
      app.hub.unreadHintFor('mock', 'sa'),
      'orrery：未读 11：点名你 6（仅知会 1，离线 2，失败或结果未知 2，被上限拦住 1） · 用户 2（失败或结果未知 1） · 广播 1（仅知会 1） · 任务通知 2（离线 1），方便时用 read_messages 查看，分布在 2 个群',
    );

    // Verify envelope unseenHint format when A comes back online and receives a live delivery:
    offlineSet.delete('sa');
    app.hub.connectBridge('mock', 'sa', { send() {}, close() {} });
    const live = app.hub.sendFromUser(cluster.id, '@A new live ping');
    await waitFor(() => delivered.some((d) => d.sessionId === 'sa' && d.text.includes('@A new live ping')), 'A delivered');
    const envText = delivered[0].text;
    assert.match(envText, /群里还有未读 10：点名你 6（仅知会 1，离线 2，失败或结果未知 2，被上限拦住 1） · 用户 1（失败或结果未知 1） · 广播 1（仅知会 1） · 任务通知 2（离线 1），可用 read_messages 查看。/);
    assert.ok(!envText.includes(live.id + ' 未读'));
  } finally {
    await app.close();
  }
});

test('broadcast from Hub/MCP: explicit @name inside @all (normal and fyi=true), plain @all, fyi+replyTo override, and three sender rules', async () => {
  const dir = tempDir();
  const offlineSet = new Set(['na', 'nb', 'nc']);
  const app = await startTestHub({ dir, nativeAdapters: { mock: makeNative(dir, ['na', 'nb', 'nc'], offlineSet) } });
  try {
    const nat = await app.hub.createCluster('bcast-nat', [
      { harness: 'mock', mode: 'native', sessionId: 'na', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 'nb', name: 'B' },
      { harness: 'mock', mode: 'native', sessionId: 'nc', name: 'C' },
    ]);
    const [na, nb, nc] = nat.members;

    // 1) Member sends `@all @A explicit FYI` with fyi=true via real MCP send_message (creates ZERO deliveries):
    const fyiSendRes = await mcpJsonRpc(app, 'nb', 'tools/call', {
      name: 'send_message',
      arguments: { body: '@all @A explicit FYI', fyi: true },
    });
    const fyiSent = JSON.parse(fyiSendRes.result.content[0].text);
    assert.deepEqual(fyiSent.deliveredTo, [], 'fyi=true broadcast creates no deliveries');
    assert.deepEqual(app.hub.deliveryOutcomes(fyiSent.messageId), [], 'deliveries table has 0 rows for fyi=true');
    assert.deepEqual(app.store.db.prepare('SELECT id FROM deliveries WHERE message_id = ?').all(fyiSent.messageId), []);
    assert.deepEqual(app.store.getMessage(fyiSent.messageId)!.explicitMentions, [na.id]);

    // A MUST classify this message as mention + ['fyi'], NEVER broadcast:
    assert.deepEqual(app.store.unreadBreakdown(na.id, nat.cluster.id), {
      total: 1,
      mention: { total: 1, fyi: 1, offline: 0, failedOrUnknown: 0, blocked: 0 },
      user: { total: 0, fyi: 0, offline: 0, failedOrUnknown: 0, blocked: 0 },
      broadcast: { total: 0, fyi: 0, offline: 0, failedOrUnknown: 0, blocked: 0 },
      taskNotice: { total: 0, fyi: 0, offline: 0, failedOrUnknown: 0, blocked: 0 },
    });
    // C (not explicitly @-named) sees broadcast + ['fyi']:
    assert.deepEqual(app.store.unreadBreakdown(nc.id, nat.cluster.id), {
      total: 1,
      mention: { total: 0, fyi: 0, offline: 0, failedOrUnknown: 0, blocked: 0 },
      user: { total: 0, fyi: 0, offline: 0, failedOrUnknown: 0, blocked: 0 },
      broadcast: { total: 1, fyi: 1, offline: 0, failedOrUnknown: 0, blocked: 0 },
      taskNotice: { total: 0, fyi: 0, offline: 0, failedOrUnknown: 0, blocked: 0 },
    });

    // A reading or skipping category='broadcast' MUST NOT touch A's explicit @A fyi mention:
    const aReadBc = await mcpJsonRpc(app, 'na', 'tools/call', { name: 'read_messages', arguments: { category: 'broadcast' } });
    assert.deepEqual(JSON.parse(aReadBc.result.content[0].text), []);
    const aSkipBc = await mcpJsonRpc(app, 'na', 'tools/call', { name: 'skip_unread', arguments: { category: 'broadcast' } });
    assert.equal(JSON.parse(aSkipBc.result.content[0].text).skipped, 0);

    const aReadMention = await mcpJsonRpc(app, 'na', 'tools/call', { name: 'read_messages', arguments: { category: 'mention' } });
    const aMentionItems = JSON.parse(aReadMention.result.content[0].text);
    assert.equal(aMentionItems.length, 1);
    assert.equal(aMentionItems[0].id, fyiSent.messageId);
    assert.equal(aMentionItems[0].category, 'mention');
    assert.deepEqual(aMentionItems[0].annotations, ['fyi']);

    // C reading category='broadcast' gets the message as broadcast + ['fyi'] (or skip_unread skips only C):
    const cSkipBc = await mcpJsonRpc(app, 'nc', 'tools/call', { name: 'skip_unread', arguments: { category: 'broadcast' } });
    assert.equal(JSON.parse(cSkipBc.result.content[0].text).skipped, 1);
    assert.equal(app.store.countUnread(nc.id, nat.cluster.id), 0);
    // Sender B sees category: null in history for its own @all message:
    const bHist = JSON.parse((await mcpJsonRpc(app, 'nb', 'tools/call', { name: 'read_messages', arguments: { history: true } })).result.content[0].text);
    assert.equal(bHist.find((m: any) => m.id === fyiSent.messageId).category, null);

    // 2) Normal (non-fyi) member `@all @A`: explicit A gets mention+['offline'], C gets broadcast, plain @all -> broadcast for A and C:
    const normalSent = app.hub.sendFromMember(nb.id, '@all @A look at this');
    assert.deepEqual(normalSent.message.explicitMentions, [na.id]);
    assert.deepEqual(normalSent.deliveredTo, ['A']);
    const plainAll = app.hub.sendFromMember(nb.id, '@all plain broadcast');
    assert.deepEqual(plainAll.message.explicitMentions, []);
    assert.deepEqual(plainAll.deliveredTo, []);

    const aHist = JSON.parse((await mcpJsonRpc(app, 'na', 'tools/call', { name: 'read_messages', arguments: { history: true } })).result.content[0].text);
    const cHist = JSON.parse((await mcpJsonRpc(app, 'nc', 'tools/call', { name: 'read_messages', arguments: { history: true } })).result.content[0].text);
    const aNormal = aHist.find((m: any) => m.id === normalSent.message.id);
    const cNormal = cHist.find((m: any) => m.id === normalSent.message.id);
    assert.equal(aNormal.category, 'mention');
    assert.deepEqual(aNormal.annotations, ['offline']);
    assert.equal(cNormal.category, 'broadcast');
    assert.deepEqual(cNormal.annotations, []);
    assert.equal(aHist.find((m: any) => m.id === plainAll.message.id).category, 'broadcast');
    assert.equal(cHist.find((m: any) => m.id === plainAll.message.id).category, 'broadcast');

    // 3) Member `@all @A` with fyi=true AND replyTo asker A preserves fyiOverride while remaining mention+fyi+offline for A and broadcast+fyi for C:
    const qFromA = app.hub.sendFromMember(na.id, '@B any update?');
    const overrideSent = app.hub.sendFromMember(nb.id, '@all @A still checking', qFromA.message.id, [], undefined, undefined, undefined, true);
    assert.deepEqual(overrideSent.deliveredTo, ['A']);
    assert.deepEqual(overrideSent.fyiOverridden, ['A']);
    assert.deepEqual(overrideSent.message.explicitMentions, [na.id]);
    const aUnread = JSON.parse((await mcpJsonRpc(app, 'na', 'tools/call', { name: 'read_messages', arguments: {} })).result.content[0].text);
    const aOverride = aUnread.find((m: any) => m.id === overrideSent.message.id);
    assert.equal(aOverride.category, 'mention');
    assert.deepEqual(aOverride.annotations, ['fyi', 'offline']);
    const cUnread = JSON.parse((await mcpJsonRpc(app, 'nc', 'tools/call', { name: 'read_messages', arguments: {} })).result.content[0].text);
    const cOverride = cUnread.find((m: any) => m.id === overrideSent.message.id);
    assert.equal(cOverride.category, 'broadcast');
    assert.deepEqual(cOverride.annotations, ['fyi']);

    // 4) Three sender rules check:
    //    (a) user: `@all` and `@all @A` wake everyone -> explicitMentions undefined -> mention for everyone (plain user without @ stays user).
    //    (b) member: `@all` -> explicitMentions=[] (broadcast), `@all @A` -> explicitMentions=[A] (mention for A, broadcast for C).
    //    (c) externalPlugin: behaves like member (`@all` -> explicitMentions=[], `@all @A` -> explicitMentions=[A]).
    const uPlain = app.hub.sendFromUser(nat.cluster.id, 'user unaddressed note');
    const uAll = app.hub.sendFromUser(nat.cluster.id, '@all user wakes everyone');
    const uAllNamed = app.hub.sendFromUser(nat.cluster.id, '@all @A user plus explicit');
    assert.equal(uAll.explicitMentions, undefined);
    assert.equal(uAllNamed.explicitMentions, undefined);

    const pPlain = app.hub.sendFromExternalPlugin('ext-demo', nat.cluster.id, '@all plugin broadcast', null, true);
    const pNamed = app.hub.sendFromExternalPlugin('ext-demo', nat.cluster.id, '@all @A plugin explicit', null, true);
    assert.deepEqual(app.store.getMessage(pPlain.messageId)!.explicitMentions, []);
    assert.deepEqual(app.store.getMessage(pNamed.messageId)!.explicitMentions, [na.id]);
    assert.deepEqual(pNamed.deliveredTo, ['A']);

    const aAfter = JSON.parse((await mcpJsonRpc(app, 'na', 'tools/call', { name: 'read_messages', arguments: { limit: 50 } })).result.content[0].text);
    const cAfter = JSON.parse((await mcpJsonRpc(app, 'nc', 'tools/call', { name: 'read_messages', arguments: { limit: 50 } })).result.content[0].text);
    const catOf = (list: any[], id: string) => list.find((m: any) => m.id === id)?.category;
    assert.equal(catOf(aAfter, uPlain.id), 'user');
    assert.equal(catOf(aAfter, uAll.id), 'mention');
    assert.equal(catOf(cAfter, uAll.id), 'mention');
    assert.equal(catOf(aAfter, uAllNamed.id), 'mention');
    assert.equal(catOf(cAfter, uAllNamed.id), 'mention');
    assert.equal(catOf(aAfter, pPlain.messageId), 'broadcast');
    assert.equal(catOf(cAfter, pPlain.messageId), 'broadcast');
    assert.equal(catOf(aAfter, pNamed.messageId), 'mention');
    assert.equal(catOf(cAfter, pNamed.messageId), 'broadcast');
  } finally {
    await app.close();
  }
});

test('read_messages category filter + AND intersection + skip_unread category skipping + MCP response metadata', async () => {
  const dir = tempDir();
  const offlineSet = new Set(['sa', 'sb']);
  const app = await startTestHub({ dir, nativeAdapters: { mock: makeNative(dir, ['sa', 'sb'], offlineSet) } });
  try {
    const { cluster, members: [a, b] } = await app.hub.createCluster('mcp-read', [
      { harness: 'mock', mode: 'native', sessionId: 'sa', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 'sb', name: 'B' },
    ]);

    const t0 = Date.now();
    const iso = (n: number) => new Date(t0 + n * 1000).toISOString();
    app.store.insertMessage({ id: 'u1', clusterId: cluster.id, from: 'user', mentions: [], body: 'plain user 1', replyTo: null, chainId: 'u1', hop: 0, createdAt: iso(1) }, []);
    app.store.insertMessage({ id: 'm1', clusterId: cluster.id, from: b.id, mentions: [a.id], body: '@A from B 1', replyTo: null, chainId: 'm1', hop: 0, createdAt: iso(2) }, []);
    app.store.insertMessage({ id: 'm2', clusterId: cluster.id, from: 'user', mentions: [a.id], body: '@A from user 2', replyTo: null, chainId: 'm2', hop: 0, createdAt: iso(3) }, []);
    app.store.insertMessage({ id: 'm3', clusterId: cluster.id, from: b.id, mentions: [a.id], body: '@A from B 3', replyTo: null, chainId: 'm3', hop: 0, createdAt: iso(4), fyi: true }, []);
    app.store.insertMessage({ id: 'bc1', clusterId: cluster.id, from: b.id, mentions: [a.id], body: '@all heads up 1', replyTo: null, chainId: 'bc1', hop: 0, createdAt: iso(5), explicitMentions: [] }, []);
    app.store.insertMessage({ id: 'bc2', clusterId: cluster.id, from: b.id, mentions: [a.id], body: '@all heads up 2', replyTo: null, chainId: 'bc2', hop: 0, createdAt: iso(6), explicitMentions: [] }, []);
    app.store.insertMessage({ id: 'tn1', clusterId: cluster.id, from: 'system', kind: 'system', mentions: [a.id], body: '系统通知 1', replyTo: null, chainId: 'tn1', hop: 0, createdAt: iso(7) }, []);

    // AND intersection via MCP read_messages: category='mention' AND sender='user' returns only m2
    const mUserRes = await mcpJsonRpc(app, 'sa', 'tools/call', { name: 'read_messages', arguments: { category: 'mention', sender: 'user' } });
    const mUserBody = JSON.parse(mUserRes.result.content[0].text);
    assert.equal(mUserBody.length, 1);
    assert.equal(mUserBody[0].id, 'm2');
    assert.equal(mUserBody[0].category, 'mention');
    assert.deepEqual(mUserBody[0].annotations, []);

    assert.equal(app.store.countUnread(a.id, cluster.id), 6);

    // Filter unread by category='user' returns u1 only and leaves mention/broadcast/task_notice unread.
    const userOnly = await mcpJsonRpc(app, 'sa', 'tools/call', { name: 'read_messages', arguments: { category: 'user' } });
    const userParsed = JSON.parse(userOnly.result.content[0].text);
    assert.deepEqual(userParsed.map((m: any) => [m.id, m.category]), [['u1', 'user']]);
    assert.equal(app.store.countUnread(a.id, cluster.id), 5);

    // skip_unread without before/until OR category still fails:
    const badSkip = await mcpJsonRpc(app, 'sa', 'tools/call', { name: 'skip_unread', arguments: {} });
    assert.equal(badSkip.result.isError, true);

    // skip_unread({ category: 'broadcast' }) skips bc1 & bc2 without before/until and leaves mention & task_notice unread!
    const skipBc = await mcpJsonRpc(app, 'sa', 'tools/call', { name: 'skip_unread', arguments: { category: 'broadcast' } });
    const skipBcParsed = JSON.parse(skipBc.result.content[0].text);
    assert.equal(skipBcParsed.skipped, 2);
    assert.deepEqual(app.store.acknowledgementsOf('bc1'), [], 'skip does not acknowledge');

    // skip_unread({ category: 'mention', until: iso(2) }) skips m1 only, leaving m3 (fyi) and tn1 unread!
    const skipM1 = await mcpJsonRpc(app, 'sa', 'tools/call', { name: 'skip_unread', arguments: { category: 'mention', until: iso(2) } });
    assert.equal(JSON.parse(skipM1.result.content[0].text).skipped, 1);

    const remainingRes = await mcpJsonRpc(app, 'sa', 'tools/call', { name: 'read_messages', arguments: {} });
    const remaining = JSON.parse(remainingRes.result.content[0].text);
    assert.deepEqual(
      remaining.map((m: any) => [m.id, m.category, m.annotations]),
      [['m3', 'mention', ['fyi']], ['tn1', 'task_notice', []]],
    );

    // Invalid category throws cleanly:
    assert.throws(() => app.hub.readMessages(a.id, { category: 'bogus' as any }), /category/);
    assert.throws(() => app.hub.skipUnread(a.id, { category: 'receipt_warning' as any }), /category/);
  } finally {
    await app.close();
  }
});

test('pre-join messages never count as unread for newly added or replacement members, and rebind / restore preserve unread_after_rowid', async () => {
  const dir = tempDir();
  const offlineSet = new Set(['sa', 'sb', 'sb-2', 'sa2']);
  const app = await startTestHub({ dir, nativeAdapters: { mock: makeNative(dir, ['sa', 'sb', 'sb-2', 'sa2'], offlineSet) } });
  try {
    const { cluster, members: [a] } = await app.hub.createCluster('join-cutoff', [
      { harness: 'mock', mode: 'native', sessionId: 'sa', name: 'A' },
    ]);
    // Post user, broadcast, and system messages BEFORE adding B.
    app.hub.sendFromUser(cluster.id, 'pre-join user message');
    app.hub.sendFromUser(cluster.id, '@all pre-join broadcast');
    app.store.insertMessage({
      id: 'pre-sys', clusterId: cluster.id, from: 'system', kind: 'system', mentions: [a.id],
      body: 'pre-join system', replyTo: null, chainId: 'pre-sys', hop: 0, createdAt: new Date().toISOString(),
    }, []);
    assert.equal(app.store.countUnread(a.id, cluster.id), 3);

    // Add B now: B starts with 0 unread, empty hint, empty default read_messages, but sees full history.
    const { members: [b] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 'sb', name: 'B' }]);
    assert.equal(app.store.countUnread(b.id, cluster.id), 0);
    assert.equal(app.hub.unreadHintFor('mock', 'sb'), '');
    assert.deepEqual(app.hub.readMessages(b.id), []);
    assert.equal(app.hub.readMessages(b.id, { history: true }).length, 3);

    // New post-join message IS unread for B.
    const postJoin = app.hub.sendFromUser(cluster.id, 'post-join user note');
    assert.equal(app.store.countUnread(b.id, cluster.id), 1);

    // Rebind B to a new session: keeps unread_after_rowid and postJoin unread!
    const afterBeforeRebind = (app.store.db.prepare('SELECT unread_after_rowid AS r FROM members WHERE id = ?').get(b.id) as any).r;
    assert.ok(afterBeforeRebind > 0);
    await app.hub.rebindMember(b.id, { harness: 'mock', sessionId: 'sb-2', confirmStopped: true });
    assert.equal((app.store.db.prepare('SELECT unread_after_rowid AS r FROM members WHERE id = ?').get(b.id) as any).r, afterBeforeRebind);
    // Rebind also writes a system notice mentioning B, so unread increases from 1 -> 2, and pre-join still stays 0!
    assert.equal(app.store.countUnread(b.id, cluster.id), 2);
    assert.ok(app.hub.readMessages(b.id).some((m) => m.id === postJoin.id));

    // Remove A and add replacement A2 with new ID: A2 never treats pre-join messages as unread.
    app.hub.removeMember(cluster.id, a.id);
    const { members: [a2] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 'sa2', name: 'A' }]);
    assert.equal(app.store.countUnread(a2.id, cluster.id), 0);

    // Any restore (clearing removed_at on removed row) keeps the original unread_after_rowid untouched.
    const origB = afterBeforeRebind;
    app.hub.removeMember(cluster.id, b.id);
    app.store.db.prepare('UPDATE members SET removed_at = NULL WHERE id = ?').run(b.id);
    assert.equal((app.store.db.prepare('SELECT unread_after_rowid AS r FROM members WHERE id = ?').get(b.id) as any).r, origB);
  } finally {
    await app.close();
  }
});

test('MCP server, Claude bridge, and DSH plugin declare read_messages and skip_unread category schemas and descriptions consistently', async () => {
  const dir = tempDir();
  const app = await startTestHub({ dir, nativeAdapters: { mock: makeNative(dir, ['s1'], new Set(['s1'])) } });
  try {
    const { cluster } = await app.hub.createCluster('decl', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    assert.ok(cluster.id);
    const mcpList = await mcpJsonRpc(app, 's1', 'tools/list', {});
    const mcpTools = mcpList.result.tools as { name: string; description: string; inputSchema: any }[];
    const dshMod = await import(pathToFileURL(join(REPO_ROOT, 'plugins', 'dsh-orrery', 'lib', 'index.js')).href);
    const dshTools = dshMod.TOOLS as { name: string; description: string; inputSchema: any }[];
    const bridgeSrc = readFileSync(join(REPO_ROOT, 'src', 'bridge', 'claude-bridge.ts'), 'utf8');

    for (const toolName of ['read_messages', 'skip_unread'] as const) {
      const mcpTool = mcpTools.find((t) => t.name === toolName)!;
      const dshTool = dshTools.find((t) => t.name === toolName)!;
      assert.ok(mcpTool && dshTool, `${toolName} exists in MCP and DSH`);
      assert.equal(dshTool.description, mcpTool.description, `DSH ${toolName} description matches MCP`);
      assert.equal(
        dshTool.inputSchema.properties.category.description,
        mcpTool.inputSchema.properties.category.description,
        `DSH ${toolName} category description matches MCP`,
      );
      assert.deepEqual(
        dshTool.inputSchema.properties.category.enum,
        mcpTool.inputSchema.properties.category.enum,
        `DSH ${toolName} category enum matches MCP`,
      );
      assert.ok(bridgeSrc.includes(JSON.stringify(mcpTool.description)), `Claude bridge ${toolName} description matches MCP`);
      assert.ok(
        bridgeSrc.includes(JSON.stringify(mcpTool.inputSchema.properties.category.description)),
        `Claude bridge ${toolName} category description matches MCP`,
      );
    }
  } finally {
    await app.close();
  }
});
