import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, type MessageAudience, type NewMember } from '../src/core/store.ts';
import type { Message } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';

const createdAt = '2026-01-01T00:00:00.000Z';
const member = (id: string): NewMember => ({
  id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
  workerSessionId: 'session-' + id, cwd: '/p', origin: 'attached', removedAt: null,
});
const ids = (messages: Message[]) => messages.map((m) => m.id);

function seed(store: Store) {
  store.insertCluster({ id: 'c', name: 'cluster', createdAt, category: '' }, [member('a'), member('b')]);
  return (id: string, privateTo?: string) => {
    const privateBindingGen = privateTo === undefined ? undefined : store.getMember(privateTo)!.bindingGen!;
    const mentions = privateTo === undefined ? [] : [privateTo];
    const message: Message = { id, clusterId: 'c', from: 'user', body: id, mentions, replyTo: null, chainId: id, hop: 0, createdAt,
      ...(privateTo === undefined ? {} : { privateTo, privateBindingGen }) };
    const [delivery] = store.insertMessage(message, mentions, privateTo !== undefined);
    return { message, delivery };
  };
}

test('v31 upgrades existing memberships and messages without widening private history', () => {
  const path = join(tempDir(), 'v30-test.db');
  const old = new Store(path);
  seed(old)('legacy');
  old.db.exec(`ALTER TABLE members DROP COLUMN binding_gen;
    ALTER TABLE messages DROP COLUMN private_to;
    ALTER TABLE messages DROP COLUMN private_binding_gen;
    PRAGMA user_version = 30`);
  old.close();

  const upgraded = new Store(path);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version, 31);
    assert.equal(upgraded.getMember('a')?.bindingGen, 1);
    assert.deepEqual(ids(upgraded.listMessages('c', 1)), ['legacy']);
    assert.equal('privateTo' in upgraded.getMessage('legacy')!, false);
    assert.deepEqual(upgraded.listMessages('c', 10, undefined, {}, { privateWith: 'a' }), []);
    assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { upgraded.close(); }
});

test('public history, anchors, collection and unread queries enforce private recipients and bindings before paging', () => {
  const store = new Store(':memory:');
  try {
    const add = seed(store);
    add('first');
    const { message: dm } = add('shared-prefix-dm', 'a');
    add('shared-prefix-public');
    add('recipient-b', 'b');
    const a: MessageAudience = { viewerMemberId: 'a', viewerBindingGen: 1 };
    const b: MessageAudience = { viewerMemberId: 'b', viewerBindingGen: 1 };
    const own: MessageAudience = { privateWith: 'a' };

    assert.deepEqual(ids(store.listMessages('c', 1)), ['shared-prefix-public']);
    assert.deepEqual(ids(store.listMessages('c', 10, dm.id)), []);
    assert.deepEqual(ids(store.listMessages('c', 10, dm.id, {}, a)), ['first']);
    assert.deepEqual(ids(store.listMessages('c', 10, dm.id, {}, b)), []);
    assert.deepEqual(ids(store.listMessagesAfter('c', 1, 'first')), ['shared-prefix-public']);
    assert.deepEqual(ids(store.listMessagesAfter('c', 1, 'first', a)), [dm.id]);
    assert.deepEqual(ids(store.listMessagesAfter('c', 2, dm.id)), []);
    assert.deepEqual(ids(store.listMessages('c', 10, undefined, {}, own)), [dm.id]);
    assert.equal(store.messageRowid('c', dm.id), null);
    assert.equal(store.messageRowid('c', dm.id, b), null);
    assert.ok(store.messageRowid('c', dm.id, own));
    assert.deepEqual(store.idsMatching('messages', 'c', dm.id, 8), []);
    assert.deepEqual(store.idsMatching('messages', 'c', 'shared-prefix-', 8), ['shared-prefix-public']);
    assert.deepEqual(store.collaborationCollection('c', { limit: 10 }).items.map((item) => item.message.id),
      ['first', 'shared-prefix-public']);
    const page = { order: 'asc' as const, limit: 10, scanCap: 2, scanBytes: 100 };
    assert.deepEqual(store.searchMessages('c', { q: 'shared-prefix' }, page).hits.map((hit) => hit.id), ['shared-prefix-public']);
    assert.throws(() => store.advanceUserRead('c', dm.id), /unknown message/);
    assert.deepEqual(ids(store.listUnread('a', 'c', 10)), ['first', dm.id, 'shared-prefix-public']);
    assert.deepEqual(ids(store.listUnread('b', 'c', 10)), ['first', 'shared-prefix-public', 'recipient-b']);
    assert.deepEqual(store.unreadIds('a', 'c'), ['first', dm.id, 'shared-prefix-public']);
    assert.equal(store.unreadBreakdown('a', 'c').total, 3);
  } finally { store.close(); }
});

test('rebind cancels pending DMs, preserves group deliveries and keeps old DMs in the user view until purge', () => {
  const store = new Store(':memory:');
  try {
    const add = seed(store);
    const { message: dm, delivery } = add('private-before-rebind', 'a');
    const { message: historical, delivery: done } = add('private-completed', 'a');
    store.setDeliveryState(done.id, 'done', null, 'completed');
    const group = { ...add('group-history').message, id: 'group-pending', mentions: ['a'] };
    const [pending] = store.insertMessage(group, ['a']);
    assert.deepEqual(store.queuedCandidates('a').map((candidate) => candidate.message), [
      { id: dm.id, from: 'user', chainId: dm.chainId, createdAt, privateTo: 'a', privateBindingGen: 1 },
      { id: group.id, from: 'user', chainId: group.chainId, createdAt },
    ]);
    assert.deepEqual(store.overdueQueued(createdAt).map((row) => row.id), [pending.id]);

    const rebound = store.rebindMember('a', { workerSessionId: 'new-session', cwd: '/p', model: null });
    assert.equal(rebound.member.bindingGen, 2);
    assert.deepEqual(rebound.cancelled.map((d) => [d.id, d.state]), [[delivery.id, 'failed']]);
    assert.deepEqual(rebound.interrupted, []);
    assert.deepEqual(store.queued('a').map((row) => row.id), [pending.id]);
    assert.equal(store.getDelivery(done.id)?.state, 'done');
    assert.deepEqual(ids(store.listUnread('a', 'c', 10)), ['group-history', 'group-pending']);
    assert.deepEqual(ids(store.listMessages('c', 10, undefined, {}, { viewerMemberId: 'a', viewerBindingGen: 2 })),
      ['group-history', 'group-pending']);
    assert.deepEqual(ids(store.listMessages('c', 10, undefined, {}, { privateWith: 'a' })), [dm.id, historical.id]);
    assert.equal(store.deliveryProblems('c', 10).count, 0);
    assert.deepEqual(store.recentDeliveryProblems('a', 10), []);
    assert.equal(store.lastDeliveryProblem('a'), null);

    store.deleteCluster('c');
    store.purgeCluster('c', () => {});
    assert.equal(store.getMessage(dm.id), null);
    assert.equal(store.getDelivery(delivery.id), null);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); }
});

test('private message and related events cannot be sources of public collaboration actions', () => {
  const store = new Store(':memory:');
  try {
    const add = seed(store);
    const { message, delivery } = add('private-ref', 'a');
    const publicMessage = add('public-ref').message;
    const publicEvent = store.appendEvent('c', null, 'message', { message: publicMessage, deliveries: [] });
    const events = [
      store.appendEvent('c', null, 'message', { message, deliveries: [delivery] }),
      store.appendEvent('c', 'a', 'read', { messageIds: [publicMessage.id, message.id], via: 'read_messages' }),
      store.appendEvent('c', 'a', 'acknowledgement', { acknowledgements: [{ memberId: 'a', messageId: message.id, at: createdAt }] }),
      store.appendEvent('c', 'a', 'delivery', { delivery }),
      store.appendEvent('c', 'a', 'agent', { messageId: message.id }),
      store.appendEvent('c', 'a', 'guard', { chainId: message.chainId, reason: 'max_turns_per_chain' }),
    ];
    assert.ok(store.eventInCluster('c', publicEvent.seq));
    for (const event of events) {
      assert.ok(store.eventHasPrivateMessage(event), event.kind);
      assert.equal(store.eventInCluster('c', event.seq), false, event.kind);
    }
  } finally { store.close(); }
});
