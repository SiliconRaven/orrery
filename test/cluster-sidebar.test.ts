// The left cluster list's Hub side: PATCH /api/clusters/:id (category, name, pinned, archived) and the user's read
// position (POST /api/clusters/:id/read). See docs/architecture.md, "群聊列表".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CLUSTER_NAME } from '../src/core/hub.ts';
import { startTestHub, waitFor, type TestHub } from './helpers.ts';

const clusterEvents = (app: TestHub, from: number) => app.events.slice(from).filter((e) => e.kind === 'cluster') as any[];
const patch = (app: TestHub, id: string, body: unknown) => app.api('PATCH', `/api/clusters/${id}`, body).then((r) => r.cluster);
const read = (app: TestHub, id: string, messageId: unknown) => app.api('POST', `/api/clusters/${id}/read`, { messageId }).then((r) => r.cluster);

test('cluster list: a new cluster is unpinned, unarchived and unread, and listings carry the three fields', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('fresh', ['a']);
    assert.deepEqual([cluster.pinnedAt, cluster.archivedAt, cluster.userReadMessageId], [null, null, null]);
    const [listed] = (await app.api('GET', '/api/state')).clusters;
    assert.deepEqual([listed.pinnedAt, listed.archivedAt, listed.userReadMessageId], [null, null, null]);
  } finally { await app.close(); }
});

test('cluster list: PATCH sets each field alone or together, atomically, with exactly one cluster event', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('team', ['a']);
    let seq = app.events.length;
    const pinned = await patch(app, cluster.id, { pinned: true });
    assert.ok(pinned.pinnedAt && !Number.isNaN(Date.parse(pinned.pinnedAt)), 'pinned now');
    assert.equal(clusterEvents(app, seq).length, 1);
    const ev = clusterEvents(app, seq)[0];
    assert.deepEqual([ev.payload.cluster.id, ev.payload.cluster.pinnedAt, ev.payload.members], [cluster.id, pinned.pinnedAt, []]);
    assert.equal((await patch(app, cluster.id, { pinned: true })).pinnedAt, pinned.pinnedAt, 'pinning again keeps the pin time');
    assert.equal((await patch(app, cluster.id, { pinned: false })).pinnedAt, null);

    seq = app.events.length;
    const all = await patch(app, cluster.id, { name: '  新名字 ', category: ' 前端 ', pinned: true, archived: false });
    assert.deepEqual([all.name, all.category, !!all.pinnedAt, all.archivedAt], ['新名字', '前端', true, null]);
    assert.equal(clusterEvents(app, seq).length, 1, 'one PATCH, one event');
    assert.deepEqual(clusterEvents(app, seq)[0].payload.cluster, all);

    seq = app.events.length;
    const archived = await patch(app, cluster.id, { archived: true });
    assert.ok(archived.archivedAt);
    assert.equal(archived.pinnedAt, null, 'archiving unpins');
    assert.equal(clusterEvents(app, seq).length, 1);
    await assert.rejects(patch(app, cluster.id, { pinned: true }), /400.*archived/, 'an archived cluster is unarchived before pinning');
    const back = await patch(app, cluster.id, { archived: false, pinned: true });
    assert.deepEqual([back.archivedAt, !!back.pinnedAt], [null, true], 'unarchive and pin in one request');
    assert.deepEqual(app.hub.store.getCluster(cluster.id), back, 'stored');
    assert.deepEqual((await app.api('GET', '/api/clusters')).find((c: any) => c.id === cluster.id).name, '新名字');
  } finally { await app.close(); }
});

test('cluster list: bad PATCH bodies are refused whole, with no change and no event', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('strict', ['a']);
    const before = app.hub.store.getCluster(cluster.id);
    const seq = app.events.length;
    const bad = [{}, [], { color: 'red' }, { category: 'ok', color: 'red' }, { pinned: 'yes' }, { archived: 1 }, { pinned: null },
      { name: 3 }, { name: '   ' }, { category: 3 }, { pinned: true, archived: true }, { name: 'ok', category: 'a\nb' },
      { name: 'a/b', pinned: true }];
    for (const body of bad) await assert.rejects(patch(app, cluster.id, body), /400/, JSON.stringify(body));
    assert.deepEqual(app.hub.store.getCluster(cluster.id), before);
    assert.equal(clusterEvents(app, seq).length, 0);
    await assert.rejects(patch(app, 'nope', { pinned: true }), /400.*unknown cluster/);
  } finally { await app.close(); }
});

test('cluster list: rename uses the create rules; 60 characters and duplicates are fine, 61 is not (create too)', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('one', ['a']);
    await app.cluster('two', ['b']);
    assert.equal(MAX_CLUSTER_NAME, 60);
    for (const name of ['a\\b', 'a/b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\nb', 'a b', '.hidden', '  .hidden', 'x'.repeat(61), '']) {
      await assert.rejects(patch(app, cluster.id, { name }), /400.*cluster name/, `rename to ${JSON.stringify(name)}`);
      await assert.rejects(app.cluster(name, ['a']), /400.*cluster name/, `create ${JSON.stringify(name)}`);
    }
    assert.equal((await patch(app, cluster.id, { name: '字'.repeat(60) })).name, '字'.repeat(60), '60 code points');
    assert.equal((await app.cluster(`  ${'😀'.repeat(60)}  `, ['a'])).cluster.name, '😀'.repeat(60), 'counted in code points, after trimming');
    assert.equal((await patch(app, cluster.id, { name: 'two' })).name, 'two', 'duplicate names are allowed');
  } finally { await app.close(); }
});

test('cluster list: a deleted cluster can be neither patched nor marked read until restored', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('binned', ['a']);
    const msg = app.hub.sendFromUser(cluster.id, 'note');
    await app.api('DELETE', `/api/clusters/${cluster.id}`);
    const seq = app.events.length;
    await assert.rejects(patch(app, cluster.id, { name: 'renamed' }), /400.*unknown cluster/);
    await assert.rejects(patch(app, cluster.id, { pinned: true }), /400.*unknown cluster/);
    await assert.rejects(read(app, cluster.id, msg.id), /400.*unknown cluster/);
    assert.equal(clusterEvents(app, seq).length, 0);
    assert.deepEqual([app.hub.store.getCluster(cluster.id, { includeDeleted: true })!.name, app.hub.store.getCluster(cluster.id, { includeDeleted: true })!.userReadMessageId],
      ['binned', null]);
    await app.api('POST', `/api/clusters/${cluster.id}/restore`);
    assert.equal((await patch(app, cluster.id, { name: 'renamed' })).name, 'renamed');
  } finally { await app.close(); }
});

test('cluster list: the read position only moves forward, belongs to the cluster, and survives a Hub restart', async () => {
  const app = await startTestHub();
  const dir = app.dir;
  let clusterId = '', newest = '';
  try {
    const { cluster } = await app.cluster('reader', ['a']);
    const { cluster: other } = await app.cluster('other', ['b']);
    clusterId = cluster.id;
    const [m1, m2, m3] = ['one', 'two', 'three'].map((body) => app.hub.sendFromUser(cluster.id, body));
    const foreign = app.hub.sendFromUser(other.id, 'elsewhere');
    newest = m3.id;

    await assert.rejects(read(app, cluster.id, foreign.id), /400.*unknown message/, "another cluster's message");
    await assert.rejects(read(app, cluster.id, 'missing'), /400.*unknown message/);
    for (const body of [{}, { messageId: 3 }, { messageId: m1.id, extra: true }]) {
      await assert.rejects(app.api('POST', `/api/clusters/${cluster.id}/read`, body), /400/, JSON.stringify(body));
    }

    let seq = app.events.length;
    assert.equal((await read(app, cluster.id, m2.id)).userReadMessageId, m2.id);
    assert.equal(clusterEvents(app, seq).length, 1, 'moving forward emits one cluster event');
    assert.deepEqual(clusterEvents(app, seq)[0].payload, { cluster: app.hub.store.getCluster(cluster.id), members: [] });

    seq = app.events.length;
    assert.equal((await read(app, cluster.id, m1.id)).userReadMessageId, m2.id, 'backward is ignored');
    assert.equal((await read(app, cluster.id, m2.id)).userReadMessageId, m2.id, 'equal is ignored');
    assert.equal(clusterEvents(app, seq).length, 0, 'no event when nothing changed');

    assert.equal((await read(app, cluster.id, m3.id)).userReadMessageId, m3.id);
    assert.equal(app.hub.store.getCluster(other.id)!.userReadMessageId, null, 'other clusters are untouched');
  } finally { await app.close(); }

  const reopened = await startTestHub({ dir });
  try {
    const listed = (await reopened.api('GET', '/api/clusters')).find((c: any) => c.id === clusterId);
    assert.equal(listed.userReadMessageId, newest, 'persisted');
  } finally { await reopened.close(); }
});

async function mcpCall(app: TestHub, name: string, args: Record<string, unknown>, session = 's1') {
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'x-orrery-bridge': JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret, 'x-orrery-harness': 'mock', 'x-orrery-session': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const result = (await res.json()).result;
  return { isError: result.isError === true, text: result.content[0].text as string };
}

test('cluster list: a rename shows in listings, MCP cluster choices, sessions and the next envelope; old envelopes stay', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a] } = await app.hub.createCluster('old-name', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const { cluster: two } = await app.hub.createCluster('second', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'B' }]);
    app.hub.sendFromUser(cluster.id, '@A before');
    await waitFor(() => app.native.delivered.length === 1, 'first delivery');
    assert.match(app.native.delivered[0].text, new RegExp(`^\\[orrery\\] cluster=old-name clusterId=${cluster.id} `));

    await patch(app, cluster.id, { name: '新的 名字' });
    app.hub.sendFromUser(cluster.id, '@A after');
    await waitFor(() => app.native.delivered.length === 2, 'second delivery');
    assert.match(app.native.delivered[1].text, new RegExp(`^\\[orrery\\] cluster=新的 名字 clusterId=${cluster.id} `), 'the next envelope reads the new name');
    assert.match(app.native.delivered[0].text, /cluster=old-name /, 'what was delivered stays as it was');

    assert.equal(app.hub.listClusters().find((c) => c.id === cluster.id)!.name, '新的 名字');
    const choice = await mcpCall(app, 'list_agents', {});
    assert.equal(choice.isError, true, 'a conversation in two clusters must choose');
    assert.match(choice.text, /新的 名字/);
    assert.doesNotMatch(choice.text, /old-name/);
    assert.match(choice.text, new RegExp(two.id));
    const listing = (await app.hub.listSessions('mock', join(app.dir, 'project-1'))).find((s) => s.id === 's1')!;
    assert.deepEqual(listing.memberships.map((m) => m.clusterName), ['新的 名字', 'second']);
    assert.equal(app.hub.store.getMember(a.id)!.name, 'A', 'members are untouched');
  } finally { await app.close(); }
});

// ---- the sidebar's group list (src/core/cluster-groups.ts; /api/cluster-groups) ----

const groupsApi = (app: TestHub, method: string, body?: unknown) => app.api(method, '/api/cluster-groups', body).then((r) => r.groups);
const settingsEvents = (app: TestHub, from: number) => app.events.slice(from).filter((e) => e.kind === 'settings').map((e) => e.payload) as any[];

test('cluster groups: create (empty allowed), reorder and the list in settings; saved in the settings table, kept across a Hub restart', async () => {
  const app = await startTestHub();
  const dir = app.dir;
  try {
    assert.deepEqual(await groupsApi(app, 'GET'), []);
    await app.cluster('legacy', ['a']).then(({ cluster }) => app.hub.store.updateCluster(cluster.id, { category: '旧组' }));
    assert.deepEqual(await groupsApi(app, 'GET'), ['旧组'], 'a group a cluster names shows before the list was ever saved');
    const seq = app.events.length;
    assert.deepEqual(await groupsApi(app, 'POST', { name: '  前端 ' }), ['旧组', '前端'], 'trimmed, appended, the unsaved group kept in place');
    assert.deepEqual(await groupsApi(app, 'POST', { name: 'empty' }), ['旧组', '前端', 'empty']);
    assert.deepEqual(settingsEvents(app, seq), [{ clusterGroups: ['旧组', '前端'] }, { clusterGroups: ['旧组', '前端', 'empty'] }], 'one settings event each');
    assert.deepEqual(await groupsApi(app, 'PUT', { groups: ['empty', '旧组', '前端'] }), ['empty', '旧组', '前端']);
    assert.deepEqual((await app.api('GET', '/api/state')).settings.clusterGroups, ['empty', '旧组', '前端']);
    assert.equal(app.hub.store.db.prepare("SELECT value FROM settings WHERE key = 'cluster_groups'").get()!.value, '["empty","旧组","前端"]', 'one JSON array row');

    const before = app.events.length;
    for (const body of [{ name: '前端' }, { name: '' }, { name: '   ' }, { name: 'a\nb' }, { name: 'x'.repeat(41) }, { name: 3 }, {}, { name: 'ok', extra: 1 }]) {
      await assert.rejects(groupsApi(app, 'POST', body), /400/, JSON.stringify(body));
    }
    for (const groups of [['empty', '旧组'], ['empty', '旧组', '前端', 'x'], ['empty', 'empty', '前端'], 'empty', null]) {
      await assert.rejects(groupsApi(app, 'PUT', { groups }), /400.*every existing group/, JSON.stringify(groups));
    }
    assert.equal(app.events.length, before, 'refused requests change nothing and emit nothing');
  } finally { await app.close(); }
  const reopened = await startTestHub({ dir });
  try {
    assert.deepEqual(await groupsApi(reopened, 'GET'), ['empty', '旧组', '前端'], 'empty groups and the order persist');
  } finally { await reopened.close(); }
});

test('cluster groups: rename moves every cluster in it at once, delete makes them ungrouped; a failure leaves everything as it was', async () => {
  const app = await startTestHub();
  try {
    const ids: string[] = [];
    for (const name of ['one', 'two', 'three']) ids.push((await app.cluster(name, ['a'])).cluster.id);
    await groupsApi(app, 'POST', { name: 'ops' });
    await groupsApi(app, 'POST', { name: 'dev' });
    await patch(app, ids[0], { category: 'ops' });
    await patch(app, ids[1], { category: 'ops', archived: true });
    await patch(app, ids[2], { category: 'dev', pinned: true });

    let seq = app.events.length;
    assert.deepEqual(await groupsApi(app, 'PATCH', { from: 'ops', to: ' 运维 ' }), ['运维', 'dev'], 'renamed in place');
    assert.deepEqual(ids.map((id) => app.hub.store.getCluster(id)!.category), ['运维', '运维', 'dev'], 'archived ones move too');
    assert.deepEqual(clusterEvents(app, seq).map((e) => [e.payload.cluster.id, e.payload.cluster.category]), [[ids[0], '运维'], [ids[1], '运维']]);
    assert.deepEqual(settingsEvents(app, seq), [{ clusterGroups: ['运维', 'dev'] }]);
    assert.equal(app.hub.store.getCluster(ids[1])!.archivedAt !== null, true, 'nothing else about a cluster changes');

    for (const body of [{ from: 'nope', to: 'x' }, { from: '运维', to: 'dev' }, { from: '运维', to: '' }, { from: 3, to: 'x' }, { from: '运维' }]) {
      await assert.rejects(groupsApi(app, 'PATCH', body), /400/, JSON.stringify(body));
    }

    // A write that fails half-way (after the first cluster moved) is rolled back whole.
    const store = app.hub.store;
    const real = store.updateCluster.bind(store);
    let calls = 0;
    store.updateCluster = (id, changes) => { if (++calls === 2) throw new Error('disk full'); return real(id, changes); };
    seq = app.events.length;
    await assert.rejects(groupsApi(app, 'PATCH', { from: '运维', to: 'ops2' }), /disk full/);
    store.updateCluster = real;
    assert.deepEqual(ids.map((id) => store.getCluster(id)!.category), ['运维', '运维', 'dev'], 'no half-renamed group');
    assert.deepEqual(await groupsApi(app, 'GET'), ['运维', 'dev']);
    assert.equal(app.events.length, seq, 'and no event');

    seq = app.events.length;
    assert.deepEqual(await groupsApi(app, 'DELETE', { name: '运维' }), ['dev']);
    assert.deepEqual(ids.map((id) => store.getCluster(id)!.category), ['', '', 'dev'], 'its clusters are ungrouped');
    assert.equal(clusterEvents(app, seq).length, 2);
    assert.deepEqual([store.getCluster(ids[0])!.name, store.listClusters().length], ['one', 3], 'the clusters themselves stay');
    await assert.rejects(groupsApi(app, 'DELETE', { name: '运维' }), /400.*unknown group/);
  } finally { await app.close(); }
});

test('cluster groups: moving a cluster keeps the group it left and saves a new one it names', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('mover', ['a']);
    let seq = app.events.length;
    await patch(app, cluster.id, { category: 'fresh' });
    assert.deepEqual(settingsEvents(app, seq), [{ clusterGroups: ['fresh'] }], 'a new name joins the list');
    seq = app.events.length;
    await patch(app, cluster.id, { category: '' });
    assert.deepEqual(await groupsApi(app, 'GET'), ['fresh'], 'the group it left stays, now empty');
    assert.deepEqual(settingsEvents(app, seq), [], 'the list did not change');
    seq = app.events.length;
    await patch(app, cluster.id, { name: 'renamed' });
    assert.deepEqual(settingsEvents(app, seq), [], 'other changes leave the list alone');
    seq = app.events.length;
    await groupsApi(app, 'POST', { name: 'second' });
    await patch(app, cluster.id, { category: 'second' });
    assert.deepEqual(settingsEvents(app, seq), [{ clusterGroups: ['fresh', 'second'] }], 'moving between listed groups changes nothing there');
  } finally { await app.close(); }
});

test('cluster groups: the pure list operations and the saved format', async () => {
  const g = await import('../src/core/cluster-groups.ts');
  assert.equal(g.CLUSTER_GROUPS_KEY, 'cluster_groups');
  assert.deepEqual(g.parseGroups(null), [], 'never saved');
  assert.deepEqual(g.parseGroups('["a","前端"]'), ['a', '前端']);
  for (const bad of ['nope', '{}', '[1]', '[""]', '["a","a"]', 'null']) assert.throws(() => g.parseGroups(bad), /cluster_groups is invalid/, bad);
  assert.deepEqual(g.effectiveGroups(['z', 'a'], ['', 'beta', 'a', '前端', 'beta']), ['z', 'a', '前端', 'beta'], 'saved order, then unsaved names in Chinese order');
  assert.deepEqual(g.createGroup(['a'], 'b'), ['a', 'b']);
  assert.throws(() => g.createGroup(['a'], 'a'), /already exists/);
  assert.throws(() => g.createGroup(Array.from({ length: g.MAX_GROUPS }, (_, i) => `g${i}`), 'x'), /at most 200/);
  assert.deepEqual(g.renameGroup(['a', 'b', 'c'], 'b', 'x'), ['a', 'x', 'c'], 'keeps its place');
  assert.deepEqual(g.renameGroup(['a'], 'a', 'a'), ['a']);
  assert.throws(() => g.renameGroup(['a', 'b'], 'a', 'b'), /already exists/);
  assert.throws(() => g.renameGroup(['a'], 'z', 'y'), /unknown group/);
  assert.deepEqual(g.deleteGroup(['a', 'b'], 'a'), ['b']);
  assert.throws(() => g.deleteGroup(['a'], 'z'), /unknown group/);
  assert.deepEqual(g.reorderGroups(['a', 'b'], ['b', 'a']), ['b', 'a']);
  for (const bad of [['a'], ['a', 'a'], ['a', 'c'], 'ab', null, ['a', 'b', 'c']]) assert.throws(() => g.reorderGroups(['a', 'b'], bad), /every existing group/, JSON.stringify(bad));
});
