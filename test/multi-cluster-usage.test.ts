import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './helpers.ts';

test('global usage reads and counts the same conversation once across its memberships', async () => {
  const app = await startTestHub();
  let reads = 0;
  app.native.conversationTokens = async () => (reads++, { input: 10, cachedInput: 1, cacheWrite: 0, output: 2, reasoning: 0 });
  try {
    const { members: [a] } = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const { members: [b] } = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'B' }]);
    const report = await app.hub.usageReport();
    assert.equal(reads, 1);
    assert.deepEqual(report.members.map((m) => [m.memberId, m.conversation?.input]), [[a.id, 10], [b.id, 10]]);
    assert.equal(report.cluster.conversation.input, 10);
    app.native.conversationTokens = () => { reads++; throw new Error('unavailable'); };
    const unknown = await app.hub.usageReport();
    assert.equal(reads, 2, 'one failed read is shared too');
    assert.deepEqual(unknown.members.map((m) => m.conversation), [null, null], 'a read error remains unknown');
  } finally { await app.close(); }
});
