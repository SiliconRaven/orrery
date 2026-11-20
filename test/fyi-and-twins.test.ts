import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { REPO_ROOT } from '../src/main.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

async function mcpCall(app: Awaited<ReturnType<typeof startTestHub>>, session: string, name: string, args: Record<string, unknown>, harness = 'mock') {
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
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  const parsed = body.result.isError ? body.result.content[0].text : JSON.parse(body.result.content[0].text);
  return { isError: body.result.isError === true, data: parsed };
}

function makeNative(dir: string, sessionIds: string[], offline = new Set<string>()) {
  const delivered: { sessionId: string; text: string }[] = [];
  const adapter = createMockNativeAdapter({
    sessions: sessionIds.map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null })),
    onDeliver: async (sessionId, text) => {
      delivered.push({ sessionId, text });
      return 'completed';
    },
  });
  adapter.isOnline = (sessionId) => !offline.has(sessionId);
  return { adapter, delivered, offline };
}

test('fyi flag persists across DB/API/read_messages and get_deliveries returns { fyi, deliveries }', async () => {
  const dir = tempDir();
  const { adapter } = makeNative(dir, ['sa', 'sb']);
  const app = await startTestHub({ dir, nativeAdapters: { mock: adapter } });
  try {
    const { cluster } = await app.hub.createCluster('fyi', [
      { harness: 'mock', mode: 'native', sessionId: 'sa', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 'sb', name: 'B' },
    ]);
    const normal = await mcpCall(app, 'sa', 'send_message', { body: '@B regular ping' });
    assert.equal(normal.isError, false);
    assert.deepEqual(normal.data.deliveredTo, ['B']);
    assert.equal('fyiOverridden' in normal.data, false);
    const normalDeliveries = await mcpCall(app, 'sa', 'get_deliveries', { messageId: normal.data.messageId });
    assert.equal(normalDeliveries.data.fyi, false);
    assert.equal(normalDeliveries.data.deliveries.length, 1);

    const noted = await mcpCall(app, 'sa', 'send_message', { body: '@B status update', fyi: true });
    assert.equal(noted.isError, false);
    assert.deepEqual(noted.data.deliveredTo, []);
    assert.equal('fyiOverridden' in noted.data, false);
    assert.equal((await app.api('GET', `/api/clusters/${cluster.id}/messages/${noted.data.messageId}`)).fyi, true);
    assert.equal((await app.api('GET', `/api/clusters/${cluster.id}/messages/${normal.data.messageId}`)).fyi, undefined);

    const fyiDeliveries = await mcpCall(app, 'sa', 'get_deliveries', { messageId: noted.data.messageId });
    assert.deepEqual(fyiDeliveries.data, { fyi: true, deliveries: [] });

    const bRead = await mcpCall(app, 'sb', 'read_messages', { history: true });
    const readNoted = bRead.data.find((m: any) => m.id === noted.data.messageId);
    const readNormal = bRead.data.find((m: any) => m.id === normal.data.messageId);
    assert.equal(readNoted.fyi, true);
    assert.equal('fyi' in readNormal, false);
  } finally {
    await app.close();
  }
});

test('fyi + replyTo overrides fyi and wakes only the explicitly addressed active asker while preserving fyi=true', async () => {
  const dir = tempDir();
  const { adapter, delivered } = makeNative(dir, ['sa', 'sb', 'sc']);
  const app = await startTestHub({ dir, nativeAdapters: { mock: adapter } });
  try {
    const { cluster, members: [a, b, c] } = await app.hub.createCluster('reply-override', [
      { harness: 'mock', mode: 'native', sessionId: 'sa', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 'sb', name: 'B' },
      { harness: 'mock', mode: 'native', sessionId: 'sc', name: 'C' },
    ]);
    const q = await mcpCall(app, 'sa', 'send_message', { body: '@B question for you' });
    await waitFor(() => app.settled(cluster.id));

    // Case 1: replyTo=A's question with @A @C and fyi=true -> wakes A only, C remains fyi-unread; fyi=true saved.
    const ans = await mcpCall(app, 'sb', 'send_message', {
      body: '@A @C here is the answer',
      replyTo: q.data.messageId,
      fyi: true,
    });
    assert.deepEqual(ans.data.deliveredTo, ['A']);
    assert.deepEqual(ans.data.fyiOverridden, ['A']);
    assert.equal('note' in ans.data, false);
    assert.equal(app.store.getMessage(ans.data.messageId)?.fyi, true);
    const ansDeliveries = await mcpCall(app, 'sb', 'get_deliveries', { messageId: ans.data.messageId });
    assert.equal(ansDeliveries.data.fyi, true);
    assert.deepEqual(ansDeliveries.data.deliveries.map((d: any) => d.to), ['A']);
    await waitFor(() => app.settled(cluster.id));

    // Also works with explicit `to: ['A', 'C']`.
    const viaTo = await mcpCall(app, 'sb', 'send_message', {
      body: 'answer via to',
      replyTo: q.data.messageId,
      to: ['A', 'C'],
      fyi: true,
    });
    assert.deepEqual(viaTo.data.deliveredTo, ['A']);
    assert.deepEqual(viaTo.data.fyiOverridden, ['A']);

    // Cases that MUST NOT override fyi: @all (not explicitly naming A), mentioning only @C, or user parent message.
    const allOnly = await mcpCall(app, 'sb', 'send_message', { body: '@all note', replyTo: q.data.messageId, fyi: true });
    assert.deepEqual(allOnly.data.deliveredTo, []);
    assert.equal('fyiOverridden' in allOnly.data, false);

    const otherOnly = await mcpCall(app, 'sb', 'send_message', { body: '@C side note', replyTo: q.data.messageId, fyi: true });
    assert.deepEqual(otherOnly.data.deliveredTo, []);
    assert.equal('fyiOverridden' in otherOnly.data, false);

    const userMsg = app.hub.sendFromUser(cluster.id, '@B user question');
    await waitFor(() => app.settled(cluster.id));
    const replyUser = await mcpCall(app, 'sb', 'send_message', { body: '@A fyi', replyTo: userMsg.id, fyi: true });
    assert.deepEqual(replyUser.data.deliveredTo, []);
    assert.equal('fyiOverridden' in replyUser.data, false);

    // Removed asker cannot be overridden.
    app.hub.removeMember(cluster.id, a.id);
    const replyGone = await mcpCall(app, 'sb', 'send_message', { body: '@A @C reply', replyTo: q.data.messageId, fyi: true });
    assert.deepEqual(replyGone.data.deliveredTo, []);
    assert.equal('fyiOverridden' in replyGone.data, false);

    // Check updated prompt/tool descriptions & envelope guidance.
    assert.ok(b.id && c.id);
    const toolsText = [
      readFileSync(join(REPO_ROOT, 'src/mcp/server.ts'), 'utf8'),
      readFileSync(join(REPO_ROOT, 'src/bridge/claude-bridge.ts'), 'utf8'),
      readFileSync(join(REPO_ROOT, 'plugins/dsh-orrery/lib/index.js'), 'utf8'),
    ];
    for (const src of toolsText) {
      assert.equal(src.includes('an answer that needs no follow-up'), false);
      assert.match(src, /never set `fyi` when answering.*question/);
      assert.match(src, /returning \{fyi, deliveries\}/);
    }
    assert.ok(delivered.some((d) => d.text.includes('回答别人问你的问题不要带 fyi')));
  } finally {
    await app.close();
  }
});

test('coordinator auto-disables on member removal and on startup, without re-emitting on second start', async () => {
  const dir = tempDir();
  const { adapter } = makeNative(dir, ['sc', 'sb', 'sc2']);
  let clusterId = '';
  let coordId = '';
  const app = await startTestHub({ dir, nativeAdapters: { mock: adapter } });
  try {
    const created = await app.hub.createCluster('coord-remove', [
      { harness: 'mock', mode: 'native', sessionId: 'sc', name: 'coord' },
      { harness: 'mock', mode: 'native', sessionId: 'sb', name: 'worker' },
    ]);
    clusterId = created.cluster.id;
    coordId = created.members[0].id;
    app.hub.collaboration.command({ kind: 'user' }, clusterId, {
      action: 'coordinator.set', operationId: 'set-c', memberId: coordId, enabled: true, mode: 'execute',
    });

    app.hub.removeMember(clusterId, coordId);
    const policy = app.store.coordinator!.policy(clusterId)!;
    assert.equal(policy.enabled, false);
    assert.equal(policy.memberId, coordId, 'removed coordinator memberId stays kept');
    assert.equal(policy.generation, 2);

    const collabEvent = app.events.findLast((e) => e.kind === 'collaboration' && (e.payload as any)?.action === 'coordinator.set')!;
    assert.equal((collabEvent.payload as any).memberId, coordId);
    assert.equal((collabEvent.payload as any).enabled, false);

    const notice = app.store.listMessages(clusterId, 50).find((m) => m.body.includes('协调员 coord 已被移出'));
    assert.ok(notice);
    assert.equal(notice!.body, '协调员 coord 已被移出，协调功能已停用，不 @ 任何人的消息将只留在群聊记录里');
    assert.equal(notice!.kind, 'system');
    assert.deepEqual(notice!.mentions, []);
    assert.deepEqual(app.store.withDeliveries([notice!])[0].deliveries, []);

    // Adding a replacement member with the same name must not inherit coordinator role or unaddressed user messages.
    const { members: [twin] } = await app.hub.addMembers(clusterId, [{ harness: 'mock', mode: 'native', sessionId: 'sc2', name: 'coord' }]);
    assert.equal(app.store.coordinator!.policy(clusterId)!.memberId, coordId);
    assert.notEqual(twin.id, coordId);
    const unaddressed = app.hub.sendFromUser(clusterId, 'nobody named');
    assert.deepEqual(app.store.withDeliveries([unaddressed])[0].deliveries, []);

    // Simulate legacy DB state: enabled coordinator whose member is already removed before restart.
    app.hub.collaboration.command({ kind: 'user' }, clusterId, {
      action: 'coordinator.set', operationId: 're-enable', memberId: twin.id, enabled: true, mode: 'suggest',
    });
    const legacyId = twin.id;
    await app.close();

    const raw = new DatabaseSync(join(dir, 'test.db'));
    raw.prepare('UPDATE members SET removed_at = ? WHERE id = ?').run('2026-11-13T00:00:00Z', legacyId);
    raw.close();

    const restarted = await startTestHub({ dir, nativeAdapters: { mock: adapter } });
    try {
      const afterStart = restarted.store.coordinator!.policy(clusterId)!;
      assert.equal(afterStart.enabled, false);
      assert.equal(afterStart.memberId, legacyId);
      const msgsAfterFirstStart = restarted.store.listMessages(clusterId, 100).filter((m) => m.body.includes('协调员 coord 已被移出'));
      assert.equal(msgsAfterFirstStart.length, 2);
      const genAfterFirst = afterStart.generation;
      await restarted.close();

      // Second restart: already disabled -> must NOT emit again or bump generation.
      const third = await startTestHub({ dir, nativeAdapters: { mock: adapter } });
      try {
        assert.equal(third.store.coordinator!.policy(clusterId)!.generation, genAfterFirst);
        assert.equal(third.store.listMessages(clusterId, 100).filter((m) => m.body.includes('协调员 coord 已被移出')).length, 2);
      } finally {
        await third.close();
      }
    } catch (e) {
      await restarted.close().catch(() => {});
      throw e;
    }
  } finally {
    await app.close().catch(() => {});
  }
});

test('twin removed members: active-first filters and （已移出） suffix only when an active twin shares the name', async () => {
  const dir = tempDir();
  const offline = new Set<string>(['s-ghost', 's-b1', 's-keep']);
  const { adapter, delivered } = makeNative(dir, ['s-old', 's-ghost', 's-reader', 's-new', 's-r2', 's-b1', 's-b2', 's-keep', 's-rem', 's-dana2'], offline);
  const app = await startTestHub({ dir, nativeAdapters: { mock: adapter } });
  try {
    const { cluster, members: [oldTwin, ghost, reader] } = await app.hub.createCluster('twins', [
      { harness: 'mock', mode: 'native', sessionId: 's-old', name: 'codex' },
      { harness: 'mock', mode: 'native', sessionId: 's-ghost', name: 'ghost' },
      { harness: 'mock', mode: 'native', sessionId: 's-reader', name: 'reader' },
    ]);

    const mOld = await mcpCall(app, 's-old', 'send_message', { body: '@codex @ghost @reader from old twin' });
    const mFromReader = await mcpCall(app, 's-reader', 'send_message', { body: '@codex ping from reader' });
    await waitFor(() => app.settled(cluster.id));
    app.hub.ackMessages(oldTwin.id, [mFromReader.data.messageId]);
    app.hub.ackMessages(ghost.id, [mFromReader.data.messageId]);

    // Remove old codex (will soon have an active twin) and ghost (stays unique, no active twin).
    app.hub.removeMember(cluster.id, oldTwin.id);
    app.hub.removeMember(cluster.id, ghost.id);

    // Add new active codex with the same name.
    const { members: [newTwin] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-new', name: 'codex' }]);
    const mNew = await mcpCall(app, 's-new', 'send_message', { body: '@codex hello from new twin' });
    const mMentionNew = await mcpCall(app, 's-reader', 'send_message', { body: '@codex ping active' });
    await waitFor(() => app.settled(cluster.id));

    app.hub.removeMember(cluster.id, reader.id);
    const { members: [newReader] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-r2', name: 'reader2' }]);

    // read_messages sender='codex' must resolve to active newTwin, not removed oldTwin.
    const bySenderActive = await mcpCall(app, 's-r2', 'read_messages', { history: true, sender: 'codex' });
    assert.deepEqual(bySenderActive.data.map((m: any) => m.id), [mNew.data.messageId]);
    assert.equal(bySenderActive.data[0].from, 'codex');

    const byMentionsActive = await mcpCall(app, 's-r2', 'read_messages', { history: true, mentions: 'codex' });
    assert.ok(byMentionsActive.data.some((m: any) => m.id === mMentionNew.data.messageId));
    assert.equal(byMentionsActive.data.some((m: any) => m.id === mOld.data.messageId), false);

    // Unique removed member with no active twin still resolves by name and shows plain name.
    const byRemovedUnique = await mcpCall(app, 's-r2', 'read_messages', { history: true, mentions: 'ghost' });
    assert.deepEqual(byRemovedUnique.data.map((m: any) => m.id), [mOld.data.messageId]);

    app.hub.ackMessages(newReader.id, [mOld.data.messageId]);
    const hist = await mcpCall(app, 's-r2', 'read_messages', { history: true, detail: 'full' });
    const oldEntry = hist.data.find((m: any) => m.id === mOld.data.messageId);
    const readerEntry = hist.data.find((m: any) => m.id === mFromReader.data.messageId);
    assert.equal(oldEntry.from, 'codex（已移出）');
    assert.ok(oldEntry.mentions.includes('ghost'), 'removed member without active twin keeps plain name');
    assert.ok(readerEntry.acknowledgements.some((a: any) => a.member === 'codex（已移出）'));
    assert.ok(readerEntry.acknowledgements.some((a: any) => a.member === 'ghost'));

    const { members: [bOld] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-b1', name: 'bob' }]);
    // Keep paused across the offline send so the failure stays in unreported until codex's later envelope.
    app.hub.setPaused(true);
    const sentToBob = await mcpCall(app, 's-new', 'send_message', { body: '@bob offline twin check', clientMessageId: 'bob-idem' });
    await waitFor(() => app.settled(cluster.id));
    app.hub.setPaused(false);
    app.hub.removeMember(cluster.id, bOld.id);
    await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-b2', name: 'bob' }]);

    const newHist = await mcpCall(app, 's-new', 'read_messages', { history: true, detail: 'full' });
    const bobMsg = newHist.data.find((m: any) => m.id === sentToBob.data.messageId);
    assert.equal(bobMsg.deliveries[0].to, 'bob（已移出）');
    assert.equal(app.hub.deliveryOutcomes(sentToBob.data.messageId)[0].to, 'bob（已移出）');
    assert.deepEqual(app.hub.getDeliveries(newTwin.id, sentToBob.data.messageId).deliveries.map((d) => d.to), ['bob（已移出）']);
    assert.deepEqual(app.hub.resentMessage(newTwin.id, 'bob-idem')!.deliveredTo, ['bob（已移出）']);

    // Verify envelope renders twin names with （已移出） when a queued message from a removed twin is delivered.
    offline.delete('s-keep');
    await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-keep', name: 'keeper' }]);
    const { members: [willRemove] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-rem', name: 'dana' }]);
    app.hub.setPaused(true);
    const fromDana = await mcpCall(app, 's-rem', 'send_message', { body: '@keeper check twin envelope' });
    app.hub.removeMember(cluster.id, willRemove.id);
    await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-dana2', name: 'dana' }]);
    app.hub.setPaused(false);
    await waitFor(() => delivered.some((d) => d.sessionId === 's-keep' && d.text.includes('check twin envelope')));
    const keepEnvelope = delivered.find((d) => d.sessionId === 's-keep' && d.text.includes('check twin envelope'))!;
    assert.match(keepEnvelope.text, /from=dana（已移出）/);
    assert.equal(keepEnvelope.text.includes('回复这条请写 @dana'), false);
    assert.match(keepEnvelope.text, new RegExp(`原发送者 dana（已移出） 已移出群聊、无法再接收消息.*另选当前收件人写 @名字 并带 replyTo=${fromDana.data.messageId}`));

    // Next undeliveredNotice for s-new shows bob（已移出）.
    assert.ok(fromDana.data.messageId);
    app.hub.sendFromUser(cluster.id, '@codex report failed');
    await waitFor(() => delivered.some((d) => d.sessionId === 's-new' && d.text.includes('离线，未投递')));
    const noticeEnv = delivered.find((d) => d.sessionId === 's-new' && d.text.includes('离线，未投递'))!;
    assert.match(noticeEnv.text, /bob（已移出）（离线，未投递）/);
  } finally {
    await app.close();
  }
});

test('removed author envelope warns against waking twin/removed senders in single, batch, and replies envelopes', async () => {
  const dir = tempDir();
  const base = makeNative(dir, ['s-old-dana', 's-new-dana', 's-solo', 's-reader', 's-active', 's-batch-old', 's-batch-new']);
  const repliesDelivered: { sessionId: string; text: string }[] = [];
  const repliesAdapter = Object.assign(createMockNativeAdapter({
    harness: 'kimi',
    sessions: [{ id: 's-replies', title: 's-replies', model: null, cwd: dir, updatedAt: null }],
    onDeliver: async (sessionId, text) => {
      repliesDelivered.push({ sessionId, text });
      return 'completed';
    },
  }), { replies: true });
  repliesAdapter.isOnline = () => true;

  const app = await startTestHub({
    dir,
    nativeAdapters: { mock: base.adapter, kimi: repliesAdapter },
  });
  try {
    const { cluster, members: [oldDana, solo, reader, active, kimi] } = await app.hub.createCluster('removed-envelope', [
      { harness: 'mock', mode: 'native', sessionId: 's-old-dana', name: 'dana' },
      { harness: 'mock', mode: 'native', sessionId: 's-solo', name: 'solo' },
      { harness: 'mock', mode: 'native', sessionId: 's-reader', name: 'reader' },
      { harness: 'mock', mode: 'native', sessionId: 's-active', name: 'active' },
      { harness: 'kimi', mode: 'native', sessionId: 's-replies', name: 'kimi' },
    ]);

    // 1. Single removed twin author: pause -> oldDana & solo send -> remove both -> add newDana -> resume.
    app.hub.setPaused(true);
    const oldQuestion = await mcpCall(app, 's-old-dana', 'send_message', { body: '@reader @kimi question from old dana' });
    app.hub.removeMember(cluster.id, oldDana.id);
    await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-new-dana', name: 'dana' }]);
    app.hub.setPaused(false);
    await waitFor(() => app.settled(cluster.id));

    const singleTwinEnv = base.delivered.find((d) => d.sessionId === 's-reader' && d.text.includes('question from old dana'))!;
    assert.match(singleTwinEnv.text, /from=dana（已移出）/);
    assert.equal(singleTwinEnv.text.includes('回复这条请写 @dana'), false);
    assert.match(singleTwinEnv.text, /原发送者 dana（已移出） 已移出群聊、无法再接收消息/);
    assert.match(singleTwinEnv.text, /另选当前收件人写 @名字/);

    // Replies-mode envelope also excludes removed twin from @ instruction.
    const repliesEnv = repliesDelivered.find((d) => d.sessionId === 's-replies' && d.text.includes('question from old dana'))!;
    assert.match(repliesEnv.text, /from=dana（已移出）/);
    assert.match(repliesEnv.text, /回复仍在群的成员写 @发送者名字；已移出成员无法接收消息/);
    assert.match(repliesEnv.text, /其中原发送者 dana（已移出） 已移出，无法再接收消息/);

    // Following the guidance to pick an active recipient delivers only to 'active' and does not wake replacement 'dana'.
    const baseDeliveredBefore = base.delivered.length;
    const redirected = await mcpCall(app, 's-reader', 'send_message', {
      body: '@active forwarding answer instead of removed dana',
      replyTo: oldQuestion.data.messageId,
    });
    assert.deepEqual(redirected.data.deliveredTo, ['active']);
    await waitFor(() => app.settled(cluster.id));
    assert.equal(base.delivered.slice(baseDeliveredBefore).some((d) => d.sessionId === 's-new-dana'), false);

    // Active author still keeps normal instruction & FYI override.
    const activeQuestion = await mcpCall(app, 's-active', 'send_message', { body: '@reader active question' });
    await waitFor(() => app.settled(cluster.id));
    const activeEnv = base.delivered.find((d) => d.sessionId === 's-reader' && d.text.includes('active question'))!;
    assert.match(activeEnv.text, new RegExp(`回复这条请写 @active 并带 replyTo=${activeQuestion.data.messageId}`));
    const fyiAnswer = await mcpCall(app, 's-reader', 'send_message', {
      body: '@active answer still wakes active asker',
      replyTo: activeQuestion.data.messageId,
      fyi: true,
    });
    assert.deepEqual(fyiAnswer.data.deliveredTo, ['active']);
    assert.deepEqual(fyiAnswer.data.fyiOverridden, ['active']);
    await waitFor(() => app.settled(cluster.id));

    // 2. Single removed non-twin author: checked by memberId, not by label suffix.
    app.hub.setPaused(true);
    const soloMsg = await mcpCall(app, 's-solo', 'send_message', { body: '@reader question from solo' });
    app.hub.removeMember(cluster.id, solo.id);
    app.hub.setPaused(false);
    await waitFor(() => app.settled(cluster.id));
    const soloEnv = base.delivered.find((d) => d.sessionId === 's-reader' && d.text.includes('question from solo'))!;
    assert.match(soloEnv.text, /from=solo /);
    assert.equal(soloEnv.text.includes('回复这条请写 @solo'), false);
    assert.match(soloEnv.text, new RegExp(`原发送者 solo 已移出群聊、无法再接收消息.*replyTo=${soloMsg.data.messageId}`));

    // 3. Batch envelope containing both removed twin and active sender.
    assert.ok(kimi.id && active.id && reader.id);
    const { members: [oldTwinBatch] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-batch-old', name: 'bmember' }]);
    app.hub.setPaused(true);
    await mcpCall(app, 's-batch-old', 'send_message', { body: '@reader batch msg from removed twin' });
    await mcpCall(app, 's-active', 'send_message', { body: '@reader batch msg from active' });
    app.hub.removeMember(cluster.id, oldTwinBatch.id);
    await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 's-batch-new', name: 'bmember' }]);
    app.hub.setPaused(false);
    await waitFor(() => app.settled(cluster.id));

    const batchEnv = base.delivered.find((d) =>
      d.sessionId === 's-reader' && d.text.includes('batch msg from removed twin') && d.text.includes('batch msg from active'),
    )!;
    assert.match(batchEnv.text, /from=bmember（已移出）/);
    assert.match(batchEnv.text, /回复仍在群的成员还要写 @发送者名字（已移出成员无法接收消息，请另选当前收件人）/);
    assert.match(batchEnv.text, /其中 bmember（已移出） 已移出群聊、无法再接收消息/);
    assert.equal(batchEnv.text.includes('active 已移出'), false);
  } finally {
    await app.close();
  }
});
