import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawFetch, startTestHub } from './helpers.ts';

test('turn report aggregates each batch once, links all triggering messages, and requires API authentication', async () => {
  const app = await startTestHub({ limits: { quotaPollMs: 0 } });
  try {
    const { cluster, members: [member, other] } = await app.cluster('turns', ['A', 'B']);
    const insert = (id: string, from: string, body: string, kind: 'chat' | 'system' = 'chat', target = member.id) =>
      app.store.insertMessage({ id, clusterId: cluster.id, from, body, kind: kind === 'chat' ? undefined : kind, mentions: [target],
        replyTo: null, chainId: id, hop: 0, createdAt: `2026-11-08T10:00:0${id.slice(-1)}.000Z` }, [target])[0];
    const a = insert('m1', 'user', 'first message');
    const b = insert('m2', 'system', '😀'.repeat(45), 'system');
    const c = insert('m3', other.id, 'work message');
    const unrelated = insert('m4', 'user', 'different recipient', 'chat', other.id);
    app.store.startDelivery(a.id, a.id);
    app.store.startDelivery(b.id, a.id);
    app.store.startDelivery(unrelated.id, a.id);
    app.store.startDelivery(c.id, c.id);
    app.store.recordTurnUsage(a.id, member.id, { input: 10, cachedInput: 20, cacheWrite: 30, output: 2999, reasoning: 100 });
    app.store.recordTurnUsage(c.id, member.id, { input: 100, cachedInput: 0, cacheWrite: 0, output: 3000, reasoning: 1 });
    const url = `/api/usage/turns?clusterId=${cluster.id}&memberId=${member.id}`;
    assert.equal((await rawFetch(app.url + url)).status, 401);
    const report = await app.api('GET', url);
    assert.deepEqual([report.turns, report.tokens, report.average], [2, 6159, 3079.5]);
    assert.deepEqual(report.short, { turns: 1, tokens: 3059 });
    assert.deepEqual(report.work, { turns: 1, tokens: 3100 });
    assert.deepEqual(report.expensive.map((turn: any) => turn.batchId), [c.id, a.id]);
    assert.deepEqual(report.expensive[1].messages.map((m: any) => [m.messageId, m.from, m.kind]),
      [['m1', 'user', 'chat'], ['m2', 'system', 'system']]);
    assert.equal([...report.expensive[1].messages[1].excerpt].length, 40);
    assert.equal((await app.api('GET', `${url}&limit=1`)).expensive.length, 1);
    await assert.rejects(app.api('GET', `${url}&limit=0`));
    await assert.rejects(app.api('GET', `/api/usage/turns?clusterId=wrong&memberId=${member.id}`));
  } finally { await app.close(); }
});
