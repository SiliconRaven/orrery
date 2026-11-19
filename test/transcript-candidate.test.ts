import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { Hub } from '../src/core/hub.ts';
import type { TranscriptItem, TranscriptPage, TranscriptSource } from '../src/core/native-transcript.ts';
import { Store, type NewMember } from '../src/core/store.ts';
import type { NativeAdapter } from '../src/core/types.ts';

// Synthetic harness without a trusted host marker: every delivery hint arrives as an unverified candidate.
const at = '2026-01-02T12:00:00.000Z';
const page = (items: TranscriptItem[]): TranscriptPage => ({ status: 'ok', items, hasMore: false, unknownCount: 0 });
const envelope = (clusterId: string, messageId: string) =>
  `[orrery] cluster=Synthetic clusterId=${clusterId} from=Untrusted Name messageId=${messageId} hop=0 to=all\nrendered text`;

function fixture(t: TestContext) {
  const member = (id: string, clusterId: string, workerSessionId = id): NewMember => ({
    id, name: id, clusterId, harness: 'synthetic', workerSessionId, avatar: null, cwd: process.cwd(),
    model: null, effort: null, origin: 'attached', removedAt: null,
  });
  const store = new Store(':memory:');
  store.insertCluster({ id: 'group', name: 'Synthetic', category: '', createdAt: at },
    [member('reader', 'group', 'shared-session'), member('peer', 'group')]);
  store.insertCluster({ id: 'other', name: 'Other', category: '', createdAt: at }, [member('sibling', 'other', 'shared-session')]);
  store.insertFile({ id: 'file', clusterId: 'group', uploader: 'user', name: 'a.txt', mime: 'application/octet-stream', size: 1, sha256: 'x', createdAt: at });
  let items: TranscriptItem[] = [];
  const adapter: NativeAdapter = {
    harness: 'synthetic', listProjects: async () => [], listSessions: async () => [], isOnline: () => false,
    deliver: async () => { throw new Error('test does not deliver'); },
    attachSession: async (id) => ({ id, title: id, model: null, cwd: process.cwd(), updatedAt: null }),
    transcript: async () => page(items),
  };
  const hub = new Hub({ store, avatarPresets: [], nativeAdapters: { synthetic: adapter } });
  t.after(async () => { await hub.close(); store.close(); });
  /** Insert and deliver a message; returns the delivery id. */
  const deliver = (id: string, body: string, to: string, opts: { clusterId?: string; direct?: boolean; files?: string[] } = {}) => {
    const clusterId = opts.clusterId ?? 'group';
    const [d] = store.insertMessage({ id, clusterId, from: 'user', body, mentions: [to], replyTo: null,
      chainId: id, hop: 0, createdAt: at }, [to], opts.direct ?? false, opts.files ?? []);
    const running = store.startDelivery(d.id, d.id);
    store.appendEvent(clusterId, to, 'delivery', { delivery: { ...running, updatedAt: at } });
    store.setDeliveryState(d.id, 'done', null, 'accepted');
    return d.id;
  };
  const read = async (input: TranscriptItem[]) => {
    items = input;
    const result = (await hub.memberTranscript('reader')).items;
    assert.ok(result.every((item) => !('source' in item)), 'source never leaves the Hub');
    return result;
  };
  return { store, deliver, read };
}

const item = (id: string, candidate: NonNullable<TranscriptSource['candidate']>, kind: TranscriptItem['kind'] = 'tool_result'): TranscriptItem =>
  ({ id, kind, text: `raw ${id}`, timestamp: at, callId: `call-${id}`, truncated: true, source: { candidate } });

function assertUnchanged(actual: TranscriptItem, input: TranscriptItem) {
  const { source: _source, ...expected } = input;
  assert.deepEqual(actual, expected);
}

test('each candidate evidence promotes on a verified hit and leaves a miss unchanged', async (t) => {
  const { deliver, read } = fixture(t);
  const byId = deliver('by-id', 'body by id', 'reader');
  deliver('by-envelope', 'body by envelope', 'reader');
  deliver('direct', 'direct body', 'reader', { direct: true });
  const input = [
    item('id-hit', { deliveryId: byId }), item('id-miss', { deliveryId: 'not-a-delivery' }),
    item('env-hit', { envelope: envelope('group', 'by-envelope') }), item('env-miss', { envelope: envelope('group', 'absent') }),
    item('direct-hit', { direct: { body: 'direct body' } }), item('direct-miss', { direct: { body: 'never delivered' } }),
    item('direct-timed', { direct: { body: 'direct body', at: '2026-01-02T12:05:00.000Z' } }),
    item('direct-too-early', { direct: { body: 'direct body', at: '2026-01-02T11:00:00.000Z' } }),
  ];
  const out = await read(input);
  for (const [i, messageId, body] of [[0, 'by-id', 'body by id'], [2, 'by-envelope', 'body by envelope'], [4, 'direct', 'direct body'], [6, 'direct', 'direct body']] as const) {
    assert.deepEqual(out[i], { id: input[i].id, kind: 'orrery_delivery', timestamp: at, callId: input[i].callId,
      parts: [{ messageId, from: 'user', kind: 'chat', body }] });
  }
  for (const i of [1, 3, 5, 7]) assertUnchanged(out[i], input[i]);
});

test('user, system and tool_result can be promoted; other kinds with a candidate are unchanged', async (t) => {
  const { deliver, read } = fixture(t);
  const id = deliver('m', 'body', 'reader');
  const input = (['user', 'system', 'tool_result', 'assistant', 'tool_call', 'thinking'] as const).map((kind) => item(kind, { deliveryId: id }, kind));
  const out = await read(input);
  assert.deepEqual(out.map((i) => i.kind), ['orrery_delivery', 'orrery_delivery', 'orrery_delivery', 'assistant', 'tool_call', 'thinking']);
  for (const i of [3, 4, 5]) assertUnchanged(out[i], input[i]);
});

test('precedence is deliveryId, then envelope, then direct', async (t) => {
  const { deliver, read } = fixture(t);
  const id = deliver('first', 'first body', 'reader');
  deliver('second', 'second body', 'reader');
  deliver('third', 'third body', 'reader', { direct: true });
  const out = await read([
    item('all', { deliveryId: id, envelope: envelope('group', 'second'), direct: { body: 'third body' } }),
    item('fallback', { deliveryId: 'missing', envelope: envelope('group', 'second'), direct: { body: 'third body' } }),
    item('last', { deliveryId: 'missing', envelope: envelope('group', 'absent'), direct: { body: 'third body' } }),
  ]);
  assert.deepEqual(out.map((i) => i.parts?.[0].messageId), ['first', 'second', 'third']);
});

test('no match across clusters, members, attachments, prefixes or ambiguous direct bodies', async (t) => {
  const { deliver, read } = fixture(t);
  deliver('foreign', 'foreign body', 'sibling', { clusterId: 'other' });
  const toPeer = deliver('to-peer', 'peer body', 'peer');
  deliver('peer-direct', 'peer direct body', 'peer', { direct: true });
  deliver('with-file', 'direct with file', 'reader', { direct: true, files: ['file'] });
  const direct = deliver('direct', 'unique direct body', 'reader', { direct: true });
  const twin1 = deliver('twin-1', 'twin body', 'reader', { direct: true });
  const twin2 = deliver('twin-2', 'twin body', 'reader', { direct: true });
  deliver('shared-session', 'shared session body', 'sibling', { clusterId: 'other', direct: true });
  const wrongPrefix = (direct[0] === 'f' ? '0' : 'f') + direct.slice(1, 8);
  const input = [
    item('other-cluster', { envelope: envelope('other', 'foreign') }),
    item('forged-cluster', { envelope: envelope('group', 'foreign') }),
    item('other-member-id', { deliveryId: toPeer }),
    item('other-member-env', { envelope: envelope('group', 'to-peer') }),
    item('other-member-direct', { direct: { body: 'peer direct body' } }),
    item('other-cluster-same-session', { direct: { body: 'shared session body' } }),
    item('attachments', { direct: { body: 'direct with file' } }),
    item('wrong-prefix', { direct: { body: 'unique direct body', deliveryIdPrefix: wrongPrefix } }),
    item('short-prefix', { direct: { body: 'unique direct body', deliveryIdPrefix: direct.slice(0, 7) } }),
    item('twins', { direct: { body: 'twin body' } }),
    item('bad-time', { direct: { body: 'unique direct body', at: 'not a time' } }),
  ];
  const out = await read([
    ...input,
    item('prefix-ok', { direct: { body: 'unique direct body', deliveryIdPrefix: direct.slice(0, 13).toUpperCase() } }),
    item('twin-1-ok', { direct: { body: 'twin body', deliveryIdPrefix: twin1.slice(0, 8) } }),
    item('twin-2-ok', { direct: { body: 'twin body', deliveryIdPrefix: twin2.slice(0, 8) } }),
  ]);
  input.forEach((entry, i) => assertUnchanged(out[i], entry));
  assert.equal(out[input.length]?.parts?.[0].messageId, 'direct');
  assert.equal(out[input.length + 1]?.parts?.[0].messageId, 'twin-1');
  assert.equal(out[input.length + 2]?.parts?.[0].messageId, 'twin-2');
});
