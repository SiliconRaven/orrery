import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

async function fixture(name = 'mentions') {
  const dir = tempDir();
  const sessions = ['s1', 's2', 's3'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  const { cluster, members: [a, b, c] } = await app.hub.createCluster(name, ['A', 'B', 'C'].map((memberName, index) =>
    ({ harness: 'claude', sessionId: sessions[index].id, name: memberName })));
  const deliveries = (message: { id: string }) => app.store.withDeliveries([app.store.getMessage(message.id)!])[0].deliveries;
  return { app, cluster, a, b, c, deliveries };
}

test('@mentions inside inline code, code blocks and quotes deliver nothing', async () => {
  const f = await fixture('quoted');
  try {
    const bt = String.fromCharCode(96);
    const quoted = f.app.hub.sendFromUser(f.cluster.id, '示例 ' + bt + '@all' + bt + ' 和 "@B" 以及 “@all”、‘@C’。');
    assert.deepEqual(quoted.mentions, [], 'quoted/code mentions are plain text');
    assert.equal(f.deliveries(quoted).length, 0);
    const fenced = f.app.hub.sendFromUser(f.cluster.id, bt + bt + bt + '\n@B 在代码块里\n' + bt + bt + bt);
    assert.deepEqual(fenced.mentions, []);
    const escaped = f.app.hub.sendFromUser(f.cluster.id, '他说 "你好 \\"@all\\""，仍不算点名');
    assert.deepEqual(escaped.mentions, [], 'a backslash-escaped quote does not end the mask');
    const plain = f.app.hub.sendFromUser(f.cluster.id, '@B 正常点名');
    assert.deepEqual(plain.mentions, [f.b.id]);
    await waitFor(() => f.deliveries(plain).length === 1, 'normal mention delivers');
    assert.equal(f.deliveries(plain)[0].memberId, f.b.id);
  } finally { await f.app.close(); }
});

test('send_message reports @names that match no member, and warns when nobody is addressed', async () => {
  const f = await fixture('unresolved');
  try {
    const unknown = f.app.hub.sendFromMember(f.a.id, '@claude 你收到吗');
    assert.deepEqual(unknown.deliveredTo, []);
    assert.deepEqual(unknown.unresolvedMentions, ['claude'], 'the name as written, without the @');
    assert.match(unknown.warning ?? '', /only stays in the chat record/);
    assert.match(unknown.warning ?? '', /Available member names: A, B, C\./);
    assert.equal(f.deliveries(unknown.message).length, 0);
    assert.equal(f.app.store.getMessage(unknown.message.id)?.body, '@claude 你收到吗', 'the message is still saved');

    // A known name in the same body still delivers; only the other name is unresolved, and nobody is warned.
    const mixed = f.app.hub.sendFromMember(f.b.id, '@claude 和 @C 你们好');
    assert.deepEqual(mixed.deliveredTo, ['C']);
    assert.deepEqual(mixed.unresolvedMentions, ['claude']);
    assert.equal(mixed.warning, undefined);
    await waitFor(() => f.deliveries(mixed.message).length === 1, 'C receives the mixed message');

    // Known names, @all, and @ inside code/quotes are not reported; no recipient still warns.
    assert.deepEqual(f.app.hub.sendFromMember(f.a.id, '@B @all 你好').unresolvedMentions, []);
    const bt = String.fromCharCode(96);
    const quoted = f.app.hub.sendFromMember(f.a.id, bt + '@ghost' + bt + ' "@ghost" ' + bt + bt + bt + '\n@ghost\n' + bt + bt + bt);
    assert.deepEqual(quoted.unresolvedMentions, []);
    assert.match(quoted.warning ?? '', /Available member names: A, B, C\./);

    // to: sends treat the body as plain text, and a retried send reports the first message's result.
    const direct = f.app.hub.sendFromMember(f.b.id, '@ghost plain text', undefined, [], undefined, ['C']);
    assert.deepEqual([direct.deliveredTo, direct.unresolvedMentions, direct.warning], [['C'], [], undefined]);
    const first = f.app.hub.sendFromMember(f.a.id, '@claude 第一次', undefined, [], undefined, undefined, 'unresolved-1');
    const again = f.app.hub.sendFromMember(f.a.id, 'different body', undefined, [], undefined, undefined, 'unresolved-1');
    assert.deepEqual([again.message.id, again.duplicate, again.unresolvedMentions, again.warning],
      [first.message.id, true, undefined, undefined], 'a repeat does not replay the first send\'s diagnosis');

    // A retry with another `to` (or after a member rename) must not re-diagnose the stored body: the first send with
    // `to` treated it as plain text, so the repeat without `to` still reports nothing.
    const plain = f.app.hub.sendFromMember(f.b.id, '@Ghost is plain text', undefined, [], undefined, ['C'], 'plain-1');
    assert.deepEqual([plain.deliveredTo, plain.unresolvedMentions], [['C'], []]);
    const replay = f.app.hub.sendFromMember(f.b.id, '@Ghost is plain text', undefined, [], undefined, undefined, 'plain-1');
    assert.deepEqual([replay.message.id, replay.duplicate, replay.unresolvedMentions, replay.warning],
      [plain.message.id, true, undefined, undefined], 'the repeat\'s own to must not re-diagnose the first send');
  } finally { await f.app.close(); }
});

test('send_message to: names delivers only there and treats the body as plain text', async () => {
  const f = await fixture('to-names');
  try {
    const sent = f.app.hub.sendFromMember(f.a.id, '@C 这段 @all 只是文字', undefined, [], undefined, ['B']);
    assert.deepEqual(sent.message.mentions, [f.b.id], 'only the named recipient');
    assert.deepEqual(sent.deliveredTo, ['B']);
    assert.equal(f.deliveries(sent.message).length, 1);
    const self = f.app.hub.sendFromMember(f.a.id, '只发给自己', undefined, [], undefined, ['A']);
    assert.deepEqual(self.message.mentions, [], 'an agent never delivers to itself');
    assert.equal(f.deliveries(self.message).length, 0);
    assert.throws(() => f.app.hub.sendFromMember(f.a.id, 'hi', undefined, [], undefined, ['Nope']),
      /unknown member name/);
  } finally { await f.app.close(); }
});
