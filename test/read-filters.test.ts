import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nativeHeaders, holdScript, startTestHub, waitFor } from './helpers.ts';

/** A message written by a member or the Hub; mentions decide which members see it as relevant unread. */
function rawMessage(app: any, clusterId: string, from: string, body: string, mentions: string[] = [], kind = 'chat') {
  const id = randomUUID();
  app.store.insertMessage({ id, clusterId, from, mentions, body, replyTo: null, chainId: id, hop: 0,
    createdAt: new Date().toISOString(), kind: kind as any }, []);
  return app.store.getMessage(id)!;
}
const fromB = (app: any, clusterId: string, b: any, body: string, mentions: string[] = []) =>
  rawMessage(app, clusterId, b.id, body, mentions);
const systemMessage = (app: any, clusterId: string, body: string, mentions: string[]) =>
  rawMessage(app, clusterId, 'system', body, mentions, 'system');

test('read_messages filters narrow unread and history reads without widening them', async (t) => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.cluster('read-filters', ['A', 'B']);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const user1 = app.hub.sendFromUser(cluster.id, 'First note');
    t.mock.timers.tick(1);
    const direct = fromB(app, cluster.id, b, '@A Alpha need', [a.id]);
    t.mock.timers.tick(1);
    const all = app.hub.sendFromUser(cluster.id, '@all for everyone');
    const percent = fromB(app, cluster.id, b, 'plain 100% done');
    const underscore = fromB(app, cluster.id, b, 'a_b literal');
    const other = app.hub.sendFromUser(cluster.id, '@B only b');
    const system = systemMessage(app, cluster.id, 'System notice', [a.id]);
    t.mock.timers.reset();
    const bodies = (msgs: any[]) => msgs.map((m) => m.body);

    // History mode: each filter alone and combined.
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, q: 'alpha' })), ['@A Alpha need']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, q: '%' })), ['plain 100% done'],
      '% matches literally');
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, q: '_' })), ['a_b literal'],
      '_ matches literally');
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, sender: 'B' })),
      ['@A Alpha need', 'plain 100% done', 'a_b literal']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, sender: 'system' })), ['System notice']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, sender: 'user' })),
      ['First note', '@all for everyone', '@B only b']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, mentions: 'A' })),
      ['@A Alpha need', '@all for everyone', 'System notice']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, mentions: 'all' })), ['@all for everyone']);
    // since/until are inclusive at both ends.
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, until: direct.createdAt })),
      ['First note', '@A Alpha need']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, since: direct.createdAt })),
      ['@A Alpha need', '@all for everyone', 'plain 100% done', 'a_b literal', '@B only b', 'System notice']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, sender: 'B', q: 'need' })), ['@A Alpha need']);
    // Unknown names and bad times fail clearly.
    assert.throws(() => app.hub.readMessages(a.id, { history: true, sender: 'nobody' }), /unknown member name/);
    assert.throws(() => app.hub.readMessages(a.id, { history: true, since: 'not-a-time' }), /ISO time/);
    assert.throws(() => app.hub.readMessages(a.id, { history: true, q: 'x'.repeat(201) }), /200/);

    // Unread mode: filters narrow the relevant unread set; non-matching unread stays unread. (Reading history
    // above already marked those messages read, so this part uses fresh messages.)
    app.hub.sendFromUser(cluster.id, 'Fresh note');
    fromB(app, cluster.id, b, '@A Fresh alpha', [a.id]);
    app.hub.sendFromUser(cluster.id, '@all Fresh all');
    fromB(app, cluster.id, b, 'fresh plain');
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { limit: 100, q: 'alpha' })), ['@A Fresh alpha']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { limit: 100, mentions: 'all' })), ['@all Fresh all']);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { limit: 100, sender: 'user' })), ['Fresh note'],
      'only relevant unread from user messages');
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { limit: 100 })), [],
      'everything not yet read is gone; unrelated messages never appear');

    // History mode: filters plus before pagination, no duplicates and no gaps.
    const p1 = app.hub.readMessages(a.id, { history: true, limit: 2, sender: 'B' });
    const p2 = app.hub.readMessages(a.id, { history: true, limit: 2, sender: 'B', before: p1[0].id });
    assert.deepEqual(bodies([...p1, ...p2]), ['@A Fresh alpha', 'fresh plain', 'plain 100% done', 'a_b literal']);
    assert.equal(new Set([...p1, ...p2].map((m) => m.id)).size, 4, 'no duplicate page entries');

    // Another cluster's messages never leak in.
    const { cluster: otherCluster } = await app.cluster('read-filters-other', ['C']);
    app.hub.sendFromUser(otherCluster.id, 'needle elsewhere');
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, q: 'elsewhere' })), []);
    assert.deepEqual(bodies(app.hub.readMessages(a.id, { history: true, limit: 100, q: 'first', sender: 'user' })), ['First note']);
    assert.ok(other.id);
    assert.ok(underscore.id);
    assert.ok(percent.id);
  } finally { await app.close(); }
});

test('skip_unread marks relevant unread up to a point without acknowledging it', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.cluster('skip-unread', ['A', 'B']);
    const m1 = fromB(app, cluster.id, b, '@A one', [a.id]);
    const m2 = fromB(app, cluster.id, b, '@A two', [a.id]);
    const m3 = app.hub.sendFromUser(cluster.id, 'three');
    assert.equal(app.store.unreadIds(a.id, cluster.id).length, 3, 'the three relevant messages are unread');
    const before = app.store.withDeliveries(app.store.listMessages(cluster.id, 100)).map((m: any) => m.deliveries.map((d: any) => d.state));
    assert.equal(app.hub.skipUnread(a.id, { before: m2.id }), 2, 'one and two are skipped');
    assert.deepEqual(app.store.listMessages(cluster.id, 100).map((m: any) => m.body), ['@A one', '@A two', 'three']);
    assert.equal(app.store.acknowledgementsOf(m1.id).length, 0, 'skipping is not an acknowledgement');
    assert.equal(before.length, 3);
    assert.deepEqual(app.hub.readMessages(a.id, { limit: 100 }).map((m) => m.body), ['three'], 'only the later unread remains');
    // until: skip everything at or before the last message's time.
    const m4 = fromB(app, cluster.id, b, '@A four', [a.id]);
    assert.equal(app.hub.skipUnread(a.id, { until: m4.createdAt }), 1);
    assert.deepEqual(app.hub.readMessages(a.id, { limit: 100 }), []);
    // exactly one point is required
    assert.throws(() => app.hub.skipUnread(a.id, {}), /exactly one of before or until/);
    assert.throws(() => app.hub.skipUnread(a.id, { before: m1.id, until: m2.createdAt }), /exactly one of before or until/);
    assert.throws(() => app.hub.skipUnread(a.id, { before: 'missing' }), /message in this cluster/);
    assert.ok(m3.id);
  } finally { await app.close(); }
});

test('MCP read_messages and skip_unread expose the filters', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [a, b] } = await app.cluster('mcp-read-filters', ['A', 'B']);
    fromB(app, cluster.id, b, '@A needle from B', [a.id]);
    fromB(app, cluster.id, b, '@A plain', [a.id]);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hold' });
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: nativeHeaders(app, a.id) } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text;
      return { isError: result.isError === true, data: result.isError ? null : JSON.parse(text), text };
    };
    const filtered = await call('read_messages', { q: 'needle', sender: 'B' });
    assert.deepEqual(filtered.data.map((m: any) => m.body), ['@A needle from B']);
    const skipped = await call('skip_unread', { until: new Date(Date.now() + 1000).toISOString() });
    assert.equal(typeof skipped.data.skipped, 'number');
    assert.equal((await call('skip_unread', {})).isError, true);
    assert.equal((await call('read_messages', { history: true, mentions: 'A' })).data.length >= 1, true);
  } finally {
    hold.release();
    await client?.close();
    await app.close();
  }
});
