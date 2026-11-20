// The generic event channel (docs/external-plugins.md「事件订阅」「事件目录」): who declares types, wildcard grants,
// full content without secrets, and what each subscriber receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaborationActor, CollaborationCommand } from '../src/core/collaboration-types.ts';
import { coreEventSource } from '../src/core/core-events.ts';
import { EventRegistry, isEventPattern, patternCovers, patternMatches, type EventTypeSpec } from '../src/core/event-registry.ts';
import { parseExternalManifest, readExternalPlugins } from '../src/core/external-plugin-config.ts';
import { ExternalPlugins } from '../src/core/external-plugins.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import type { HubEvent, Message } from '../src/core/types.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { REPO_ROOT } from '../src/main.ts';
import { startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';
import { a, b, batchFixture, r, user } from './batch-fixture.ts';

// A plugin that appends every event it gets to events.jsonl in its own folder (no frame limit on what the test reads).
const recorder = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const pending = new Map(); let serial = 0;
createInterface({input:process.stdin}).on('line', (line) => {
 const m = JSON.parse(line);
 if (!m.method) { const id = pending.get(m.id); pending.delete(m.id); send({id, result: m}); return; }
 if (m.method === 'event') { appendFileSync('events.jsonl', JSON.stringify(m.params) + '\\n'); return; }
 if (m.method === 'initialize') { send({id:m.id, result:{apiVersion:1}}); return; }
 if (m.method === 'shutdown') { send({id:m.id, result:{}}); return; }
 const a = m.params.arguments;
 if (a.action === 'host') { const id = 'p-' + (++serial); pending.set(id, m.id); send({id, method:a.method, params:a.params}); return; }
 send({id:m.id, result:'ok'});
});
`;

interface PluginSpec { id: string; permissions: string[]; events?: string[]; publishes?: object[]; ui?: { positions: string[] }; grant?: Record<string, unknown> }
/** Writes plugin folders and an external-plugins.json under `home`; returns each plugin's folder. */
function installPlugins(home: string, specs: PluginSpec[]): Record<string, string> {
  mkdirSync(home, { recursive: true });
  const folders: Record<string, string> = Object.create(null);
  const plugins = specs.map((spec) => {
    const directory = tempDir();
    folders[spec.id] = directory;
    writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ id: spec.id, version: '1.0.0', apiVersion: 1, entry: 'main.mjs',
      permissions: spec.permissions, events: spec.events ?? [], ...(spec.publishes ? { publishes: spec.publishes } : {}),
      ...(spec.ui ? { ui: spec.ui } : {}),
      commands: [{ id: 'test', title: 'Test' }] }));
    writeFileSync(join(directory, 'main.mjs'), recorder);
    return { manifest: join(directory, 'orrery-plugin.json'), permissions: spec.permissions, events: spec.events ?? [], clusterIds: ['one'], ...spec.grant };
  });
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins }));
  return folders;
}
const received = (folder: string): { type: string; clusterId?: string; data: Record<string, any>; dropped?: number }[] => {
  try { return readFileSync(join(folder, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const registryOf = (store: Store) => new EventRegistry([{ owner: 'core', source: coreEventSource(store) }, ...store.plugins.eventSources(store)]);
const hubEvent = (kind: HubEvent['kind'], clusterId: string | null, payload: unknown, memberId: string | null = null): HubEvent =>
  ({ seq: 1, clusterId, memberId, kind, payload, createdAt: '2026-01-02T00:00:00.000Z' });

test('event names, patterns, matching and coverage are exact and linear', () => {
  for (const ok of ['*', 'task.*', 'plugin.foo.*', 'message.created', 'plugin.my-plugin.build.done', 'a.b']) assert.ok(isEventPattern(ok), ok);
  for (const bad of ['', 'task', 'Task.created', 'task.*.x', 'task.**', '*.created', 'task..x', '.x', 'x.', '__proto__', 'a.b c', 'a.'.repeat(70) + 'b', 7, null]) {
    assert.ok(!isEventPattern(bad), String(bad));
  }
  assert.ok(patternMatches('*', 'anything.at.all'));
  assert.ok(patternMatches('task.*', 'task.approved'));
  assert.ok(patternMatches('task.*', 'task.deep.er'), 'a prefix matches at any depth');
  assert.ok(!patternMatches('task.*', 'tasks.approved'), 'a prefix ends at a dot');
  assert.ok(!patternMatches('task.*', 'task'));
  assert.ok(patternMatches('task.approved', 'task.approved'));
  assert.ok(!patternMatches('task.approved', 'task.approved.x'));
  assert.ok(!patternMatches('plugin.foo.*', 'plugin.foobar.x'));
  // granted must be equal to or narrower than requested
  const covers: [string, string, boolean][] = [
    ['*', '*', true], ['*', 'task.*', true], ['*', 'task.a', true],
    ['task.*', 'task.*', true], ['task.*', 'task.a', true], ['task.*', 'task.a.*', true], ['task.*', 'task.a.b', true],
    ['task.*', '*', false], ['task.*', 'tasks.a', false], ['task.*', 'tasks.*', false], ['task.*', 'message.created', false],
    ['task.a', 'task.a', true], ['task.a', 'task.*', false], ['task.a', '*', false], ['task.a', 'task.a.*', false],
    ['plugin.*', 'plugin.foo.*', true], ['plugin.foo.*', 'plugin.*', false], ['plugin.foo.*', 'plugin.foobar.x', false],
  ];
  for (const [requested, granted, expected] of covers) assert.equal(patternCovers(requested, granted), expected, `${requested} covers ${granted}`);
  // Linear: a long adversarial name is checked at once.
  const long = 'a'.repeat(127) + '!';
  const started = performance.now();
  for (let i = 0; i < 1000; i++) isEventPattern(long);
  assert.ok(performance.now() - started < 500);
});

test('the core and each official plugin declare their types; a disabled official plugin has none', () => {
  const typesWith = (disabled: string[]) => {
    const store = new Store(':memory:', new PluginHost(officialPlugins, disabled));
    try {
      return new EventRegistry([{ owner: 'core', source: coreEventSource(store) }, ...store.plugins.eventSources(store)]).catalog();
    } finally { store.close(); }
  };
  const all = typesWith([]);
  const owners = new Map(all.map((t) => [t.type, t.owner]));
  for (const type of ['message.created', 'member.status', 'hub.paused', 'delivery.updated']) assert.equal(owners.get(type), 'core', type);
  for (const type of ['task.created', 'task.submitted', 'task.approved', 'task.rejected', 'task.merged', 'task.changed', 'task.deleted']) assert.equal(owners.get(type), 'tasks', type);
  for (const type of ['bookmark.saved', 'bookmark.removed']) assert.equal(owners.get(type), 'bookmarks', type);
  assert.equal(owners.get('coordinator.changed'), 'coordinator');
  for (const t of all) assert.ok(t.description && t.fields, `${t.type} is described`);
  assert.equal(all.find((t) => t.type === 'hub.paused')!.scope, 'global');
  const noCoordinator = typesWith(['coordinator']).map((t) => t.type);
  assert.ok(!noCoordinator.includes('coordinator.changed'));
  assert.ok(noCoordinator.includes('task.approved'));
  const noTasks = typesWith(['coordinator', 'tasks', 'bookmarks']).map((t) => t.type);
  assert.ok(!noTasks.some((t) => t.startsWith('task.') || t.startsWith('bookmark.')), 'a disabled plugin\'s types do not exist');
  assert.ok(noTasks.includes('message.created'));
});

test('a bad or colliding declaration stops the start; plugin.* is reserved for third-party plugins', () => {
  const spec = (type: string): EventTypeSpec => ({ type, from: 'message', description: 'd', fields: 'f', build: () => ({}) });
  const registry = (...owned: [string, string[]][]) => new EventRegistry(owned.map(([owner, types]) => ({ owner, source: { types: types.map(spec) } })));
  assert.throws(() => registry(['a', ['x.y']], ['b', ['x.y']]), /already declares/);
  assert.throws(() => registry(['a', ['plugin.a.x']]), /plugin\.\*/);
  assert.throws(() => registry(['a', ['Bad.name']]), /invalid/);
  assert.throws(() => new EventRegistry([{ owner: 'a', source: { types: [{ ...spec('x.y'), description: ' ' }] } }]), /describe/);
  assert.equal(registry(['a', ['x.y']]).has('x.y'), true);
});

test('registry expands records and pairs body variants only when their counts agree', () => {
  let mismatch = false;
  const registry = new EventRegistry([{ owner: 'example', source: { types: [{
    type: 'example.changed', from: 'collaboration', description: 'd', fields: 'id, body', body: true,
    build: (_event, { withBody }) => withBody
      ? [{ id: 'one', body: 'first' }, ...(mismatch ? [] : [{ id: 'two', body: 'second' }])]
      : [{ id: 'one' }, { id: 'two' }],
  }] } }]);
  const event = hubEvent('collaboration', 'one', {});
  assert.deepEqual(registry.translate(event).map((item) => [item.data.id, item.bodyData?.body]), [['one', 'first'], ['two', 'second']]);
  mismatch = true;
  assert.deepEqual(registry.translate(event).map((item) => [item.data.id, item.bodyData]), [['one', undefined], ['two', undefined]]);
});

test('batch actions preserve each affected task lifecycle event and subscriber scope', async (t) => {
  const f = batchFixture(t);
  const home = join(tempDir(), 'home');
  const folders = installPlugins(home, [
    { id: 'exact', permissions: ['events.read'], events: ['task.merged'], grant: { clusterIds: ['k'] } },
    { id: 'prefix', permissions: ['events.read'], events: ['task.*'], grant: { clusterIds: ['k'] } },
    { id: 'outside', permissions: ['events.read'], events: ['task.*'], grant: { clusterIds: ['other'] } },
    { id: 'no-read', permissions: [], grant: { clusterIds: ['k'] } },
  ]);
  const config = readExternalPlugins(home);
  const manager = new ExternalPlugins(config.installations, f.store, config.installations.map((p) => p.manifest.id));
  try {
    await manager.start();
    f.hub.subscribe((event) => manager.publish(event));
    const batch = f.batch('events');
    const loose = f.create('loose', undefined, { reviewer: r });
    f.act(user, loose, { action: 'batch.add', batchId: batch.id });
    f.act(user, loose, { action: 'batch.remove', batchId: batch.id });
    f.act(user, loose, { action: 'task.cancel', reason: 'no longer needed' });
    f.act(user, loose, { action: 'task.delete', reason: 'no longer needed' });
    const cancelled = f.batch('cancel');
    const released = [f.create('released one', cancelled.id), f.create('released two', cancelled.id)];
    f.send(user, { action: 'batch.cancel', batchId: cancelled.id, reason: 'separate work' });
    const tasks = [f.create('one', batch.id, { memberId: 'a' }), f.create('two', batch.id, { memberId: 'b' })];
    const approve = () => tasks.forEach((task, i) => {
      const executor = [a, b][i];
      f.start(executor, task); f.submit(executor, task, String(i + 1).repeat(40));
    });
    const submissions = () => tasks.map((task) => ({ taskId: task.id, submissionId: f.read(task.id).task.latestSubmissionId! }));
    approve();
    for (const task of tasks) f.review(r, task);
    const conflictFail = f.send({ kind: 'system' }, { action: 'batch.ship_failed', batchId: batch.id, batchSubmissions: submissions(),
      failure: { kind: 'conflict', taskId: tasks[0].id }, reason: 'conflict failed' });
    assert.ok(conflictFail.eventId > 0);
    const mergedCommitSha = 'f'.repeat(40);
    f.send({ kind: 'system' }, { action: 'batch.shipped', batchId: batch.id, batchSubmissions: submissions(), commitSha: mergedCommitSha });
    for (const id of Object.keys(folders)) await manager.invoke(id, { command: 'test' });
    const merged = received(folders.exact);
    assert.deepEqual(merged.map((e) => [e.type, e.clusterId, e.data.taskId, e.data.status, e.data.mergedCommitSha]),
      tasks.map((task) => ['task.merged', 'k', task.id, 'merged', mergedCommitSha]));
    const changed = received(folders.prefix).filter((e) => e.type === 'task.changed');
    for (const [action, affected] of [['batch.add', [loose]], ['batch.remove', [loose]], ['batch.cancel', released], ['batch.ship_failed', [tasks[0]]]] as const) {
      assert.deepEqual(changed.filter((e) => e.data.action === action).map((e) => e.data.taskId), affected.map((task) => task.id), action);
    }
    assert.equal(received(folders.prefix).filter((e) => e.type === 'task.merged').length, tasks.length);
    const deleted = received(folders.prefix).find((e) => e.type === 'task.deleted')!;
    assert.deepEqual([Object.keys(deleted.data), deleted.data.taskId], [['clusterId', 'taskId', 'by', 'at'], loose.id]);
    assert.deepEqual(received(folders.outside), []);
    assert.deepEqual(received(folders['no-read']), []);
  } finally { await manager.close(); }
});

test('a grant must be covered by the manifest request, wildcards included', () => {
  const home = join(tempDir(), 'home');
  const check = (requested: string[], granted: string[]) => {
    installPlugins(home, [{ id: 'p', permissions: ['events.read'], events: requested, grant: { events: granted } }]);
    const config = readExternalPlugins(home);
    return config.installations.length ? 'ok' : config.failures[0].error;
  };
  assert.equal(check(['task.*'], ['task.approved']), 'ok');
  assert.equal(check(['task.*'], ['task.*']), 'ok');
  assert.equal(check(['task.*'], ['task.review.*']), 'ok');
  assert.equal(check(['*'], ['*', 'message.created']), 'ok');
  assert.match(check(['task.*'], ['*']), /not requested/);
  assert.match(check(['task.approved'], ['task.*']), /not requested/, 'a wildcard grant would include later types the manifest never asked for');
  assert.match(check(['task.*'], ['tasks.created']), /not requested/);
  assert.match(check(['message.created'], ['message.*']), /not requested/);
  installPlugins(home, [{ id: 'p', permissions: [], events: ['task.*'], grant: { permissions: [], events: [] } }]);
  assert.match(readExternalPlugins(home).failures[0].error, /events\.read/, 'events still need events.read');
});

test('names like __proto__, constructor and toString are plain names: no prototype lookups', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  // A plugin id and a published name that are Object.prototype keys; a subscriber to constructor.* and plugin.constructor.*.
  installPlugins(home, [
    { id: 'constructor', permissions: ['events.publish'], publishes: [{ name: 'constructor', description: '原型键名' }, { name: 'tostring.value-of', description: '另一个' }] },
    { id: 'listener', permissions: ['events.read'], events: ['constructor.*', 'plugin.constructor.*'] },
  ]);
  const config = readExternalPlugins(home);
  assert.deepEqual(config.failures, []);
  assert.deepEqual(config.installations[0].manifest.publishes.map((p) => p.type), ['plugin.constructor.constructor', 'plugin.constructor.tostring.value-of']);
  const store = new Store(':memory:');
  store.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, []);
  const manager = new ExternalPlugins(config.installations, store, ['constructor', 'listener']);
  try {
    await manager.start();
    // Nothing the core declares is named after a prototype key, and asking does not find one.
    assert.equal(manager.events.has('constructor'), false);
    assert.equal(manager.events.has('__proto__'), false);
    assert.equal(manager.events.has('toString'), false);
    manager.publish(hubEvent('message', 'one', { message: { id: 'm', from: 'user', mentions: [], body: 'b', createdAt: 'x' }, deliveries: [] }));
    const listing = (manager.info('listener') as { eventGrants: { pattern: string; types: { type: string }[] }[] }).eventGrants;
    assert.deepEqual(listing.map((g) => [g.pattern, g.types.map((t) => t.type)]),
      [['constructor.*', []], ['plugin.constructor.*', ['plugin.constructor.constructor', 'plugin.constructor.tostring.value-of']]]);
  } finally { await manager.close(); store.close(); }
});

test('the parsed manifest refuses a __proto__ key like any unknown field', () => {
  const base = '"id":"x","version":"1.0.0","apiVersion":1,"entry":"main.mjs","permissions":[],"commands":[]';
  assert.throws(() => parseExternalManifest(JSON.parse(`{${base},"__proto__":{"events":["*"]}}`)), /unknown external plugin field/);
  assert.throws(() => parseExternalManifest(JSON.parse(`{${base},"publishes":[{"name":"a","description":"d","__proto__":{}}]}`)), /unknown external plugin field/);
});

test('exact, prefix and * grants; the cluster whitelist; the body only with messages.read; global events', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const folders = installPlugins(home, [
    { id: 'exact', permissions: ['events.read'], events: ['message.created'] },
    { id: 'prefix', permissions: ['events.read'], events: ['member.*'] },
    { id: 'all', permissions: ['events.read', 'messages.read'], events: ['*'] },
    { id: 'other-cluster', permissions: ['events.read', 'messages.read'], events: ['*'], grant: { clusterIds: ['two'] } },
    { id: 'no-read', permissions: [], events: [], grant: { events: [] } },
  ]);
  const config = readExternalPlugins(home);
  assert.deepEqual(config.failures, []);
  const store = new Store(':memory:');
  for (const id of ['one', 'two']) store.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, []);
  const manager = new ExternalPlugins(config.installations, store, config.installations.map((p) => p.manifest.id));
  try {
    await manager.start();
    manager.baselineMembers([{ id: 'a', status: 'idle', name: 'A', hiddenAt: null }]);
    manager.publish(hubEvent('message', 'one', { message: { id: 'm1', clusterId: 'one', from: 'user', mentions: [], body: 'the body', createdAt: 'x' }, deliveries: [] }));
    manager.publish(hubEvent('member', 'one', { member: { id: 'a', clusterId: 'one', name: 'A', status: 'busy', removedAt: null, hiddenAt: null } }));
    manager.publish(hubEvent('pause', null, { paused: true }));
    manager.publish(hubEvent('message', 'two', { message: { id: 'm2', clusterId: 'two', from: 'user', mentions: [], body: 'two body', createdAt: 'x' }, deliveries: [] }));
    for (const id of Object.keys(folders)) await manager.invoke(id, { command: 'test' });   // answers after every earlier event was read
    const types = (id: string) => received(folders[id]).map((e) => e.type);
    assert.deepEqual(types('exact'), ['message.created']);
    assert.deepEqual(types('prefix'), ['member.status']);
    assert.deepEqual(types('all'), ['message.created', 'member.status', 'hub.paused']);
    assert.deepEqual(types('other-cluster'), ['hub.paused', 'message.created'], 'a global event reaches every type grant; cluster events only the whitelist');
    assert.deepEqual(types('no-read'), []);
    const [exactMessage] = received(folders.exact);
    const [allMessage, , paused] = received(folders.all);
    assert.equal(exactMessage.data.body, undefined, 'no messages.read, no body');
    assert.equal(allMessage.data.body, 'the body');
    assert.equal(allMessage.clusterId, 'one', 'the checked cluster is next to data');
    assert.equal(paused.clusterId, undefined, 'a global event has no cluster');
    assert.deepEqual(paused.data, { paused: true, at: '2026-01-02T00:00:00.000Z' });
  } finally { await manager.close(); store.close(); }
});

test('message.created keeps the v1 kind for old plugins and names every stored kind in messageKind', () => {
  const registry = registryOf(new Store(':memory:'));
  const kinds = [undefined, 'chat', 'task_comment', 'system', 'plugin', 'handover', 'handoff', 'resend'];
  const out = kinds.map((kind) => registry.translate(hubEvent('message', 'one', { message: { id: 'm', clusterId: 'one', from: 'user', mentions: [], body: 'b',
    createdAt: 'x', ...(kind ? { kind } : {}) }, deliveries: [] }))[0].data);
  assert.deepEqual(out.map((d) => d.kind), [null, null, 'task_comment', 'system', 'plugin', null, null, null]);
  assert.deepEqual(out.map((d) => d.messageKind), ['chat', 'chat', 'task_comment', 'system', 'plugin', 'handover', 'handoff', 'resend']);
});

test('restricted plugin messages and events exclude private notes and their receipts, deliveries and guards', async () => {
  const dir = tempDir();
  const pluginHome = join(dir, 'probe-home');
  const { probe } = installPlugins(pluginHome, [{ id: 'probe', permissions: ['events.read', 'messages.read', 'messages.send', 'ui.show'],
    events: ['*'], ui: { positions: ['marks'] }, grant: { ui: ['marks'], writeClusterIds: ['one'] } }]);
  const { installations, failures } = readExternalPlugins(pluginHome);
  assert.deepEqual(failures, []);
  const app = await startTestHub({ dir, plugins: [...officialPlugins, {
    id: 'probe-source', name: 'Probe source', version: '1.0.0', description: 'Synthetic receipt projection',
    eventSource: () => ({ types: [{
      type: 'probe.receipt', from: 'read', description: 'A test event source', fields: 'messageIds',
      build: (event) => ({ messageIds: (event.payload as { messageIds: string[] }).messageIds }),
    }] }),
  }] });
  const manager = new ExternalPlugins(installations, app.store, ['probe'], undefined, [], app.hub);
  try {
    await manager.start();
    const cluster = 'one';
    const memberId = 'one-a';
    app.store.insertCluster({ id: cluster, name: cluster, category: '', createdAt: '2026-01-01' }, [{
      id: memberId, clusterId: cluster, name: 'a', avatar: null, harness: 'mock', model: null, effort: null,
      workerSessionId: 'session-a', cwd: dir, origin: 'attached', removedAt: null,
    }]);
    const shared = app.hub.sendFromUser(cluster, 'Public message.');
    const note: Message = { ...shared, id: 'hidden-note-id', chainId: 'hidden-note-id', body: 'Private note content.',
      mentions: [memberId], privateTo: memberId, privateBindingGen: 1 };
    const [delivery] = app.store.insertMessage(note, [memberId], true);
    const post = (kind: HubEvent['kind'], payload: unknown) => manager.publish(hubEvent(kind, cluster, payload, memberId));
    post('message', { message: note, deliveries: [delivery] });
    post('message', { message: shared, deliveries: [] });
    post('delivery', { delivery });
    post('delivery', { delivery: { ...delivery, id: 'public-delivery', messageId: shared.id } });
    post('read', { memberId, messageIds: [note.id], via: 'delivery' });
    post('read', { memberId, messageIds: [note.id, shared.id], via: 'read_messages' });
    post('read', { memberId, messageIds: [shared.id], via: 'read_messages' });
    post('acknowledgement', { acknowledgements: [{ messageId: note.id }] });
    post('acknowledgement', { acknowledgements: [{ messageId: shared.id }, { messageId: note.id }] });
    post('guard', { reason: 'max_turns_per_chain', chainId: note.chainId, maxTurnsPerChain: 1 });
    post('guard', { reason: 'max_turns_per_chain', chainId: shared.chainId, maxTurnsPerChain: 1 });
    post('cluster', { cluster: { name: cluster, userReadMessageId: note.id } });
    await manager.invoke('probe', { command: 'test' });
    const events = received(probe);
    assert.deepEqual(events.map((e) => e.type), ['message.created', 'delivery.updated', 'message.read', 'message.read', 'probe.receipt',
      'message.acknowledged', 'guard.triggered', 'cluster.updated']);
    assert.equal(events[0].data.body, shared.body);
    assert.equal(events[1].data.messageId, shared.id);
    assert.deepEqual(events[2].data.messageIds, [shared.id]);
    for (const receipt of events.slice(3, 6)) assert.deepEqual(receipt.data.messageIds, [shared.id]);
    assert.equal(events[6].data.chainId, shared.chainId);
    assert.equal(events[7].data.userReadMessageId, null);
    assert.ok(!JSON.stringify(events).includes(note.id));

    const call = async (method: string, params: unknown) => {
      const answer = await manager.invoke('probe', { command: 'test', arguments: { action: 'host', method, params } });
      return answer as { result?: { messages?: { id: string }[]; message?: { body: string } }; error?: { code: number; data?: { code: string } } };
    };
    const page = await call('host.messages.list', { clusterId: cluster, limit: 1 });
    assert.deepEqual(page.result?.messages?.map((message) => message.id), [shared.id], 'the page limit counts only shared rows');
    assert.equal((await call('host.messages.get', { clusterId: cluster, messageId: shared.id })).result?.message?.body, shared.body);
    for (const [method, fields, code] of [
      ['host.messages.get', (id: string) => ({ messageId: id }), 'NOT_FOUND'],
      ['host.messages.list', (id: string) => ({ before: id }), undefined],
      ['host.messages.send', (id: string) => ({ causedBy: id, body: 'Plugin post.' }), undefined],
      ['host.ui.mark', (id: string) => ({ targetId: id, target: 'message', text: 'probe' }), 'NOT_FOUND'],
    ] as const) {
      const hidden = await call(method, { clusterId: cluster, ...fields(note.id) });
      const absent = await call(method, { clusterId: cluster, ...fields('absent-message-id') });
      assert.ok(hidden.error, method);
      assert.deepEqual(hidden.error, absent.error, method);
      assert.equal(hidden.error.data?.code, code, method);
    }
    assert.deepEqual(app.store.listMessages(cluster, 10).map((message) => message.id), [shared.id], 'the refused writes stored nothing');
    assert.equal((await call('host.messages.list', { clusterId: cluster, before: shared.id })).error, undefined);
    assert.equal((await call('host.ui.mark', { clusterId: cluster, target: 'message', targetId: shared.id, text: 'probe' })).error, undefined);
    assert.equal((await call('host.messages.send', { clusterId: cluster, causedBy: shared.id, body: 'Plugin post.' })).error, undefined);
    assert.equal(app.store.listMessages(cluster, 10).at(-1)?.replyTo, shared.id, 'the public cause remains usable');
  } finally { await manager.close(); await app.close(); }
});

test('Hub-generated bodies stay internal in events and host queries, while ordinary authored text stays intact', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const folders = installPlugins(home, [{ id: 'reader', permissions: ['events.read', 'messages.read'], events: ['message.created'] }]);
  const native = createMockNativeAdapter({ sessions: ['internal-old-session', 'internal-new-session'].map((id) =>
    ({ id, title: id, model: null, cwd: dir, updatedAt: null })) });
  const seed = new Store(join(dir, 'test.db'));
  seed.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, [{
    id: 'one-a', clusterId: 'one', name: 'a', avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'internal-old-session', cwd: dir, origin: 'attached', removedAt: null,
  }]);
  seed.close();
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  const query = async () => (await app.api('POST', '/api/plugins/reader/invoke', {
    command: 'test', arguments: { action: 'host', method: 'host.messages.list', params: { clusterId: 'one', limit: 100 } },
  })).result.result.messages as { id: string; body: string; bodyOmitted?: boolean }[];
  try {
    const authored = app.hub.sendFromUser('one', 'User text keeps C:\\private\\user-file and secret-looking-token verbatim.');
    await app.hub.rebindMember('one-a', { harness: 'mock', sessionId: 'internal-new-session', confirmStopped: true });
    const rebind = app.store.listMessages('one', 100).find((message) => message.systemKind === 'rebind')!;
    assert.ok(rebind.body.includes(dir) && rebind.body.includes('internal-old-session') && rebind.body.includes('internal-new-session'));
    const outward = await waitFor(() => received(folders.reader).find((event) => event.data.messageId === rebind.id), 'the rebind metadata event');
    assert.equal(outward.data.body, undefined);
    assert.equal(outward.data.bodyOmitted, true);
    assert.ok(!JSON.stringify(outward).includes(dir));
    assert.ok(!JSON.stringify(outward).includes('internal-old-session'));
    const userEvent = received(folders.reader).find((event) => event.data.messageId === authored.id)!;
    assert.equal(userEvent.data.body, authored.body);

    const registry = registryOf(app.store);
    const synthetic: { from: string; kind?: Message['kind'] }[] = [
      { from: 'system' }, { from: 'user', kind: 'system' }, { from: 'user', kind: 'handover' },
      { from: 'user', kind: 'handoff' }, { from: 'user', kind: 'resend' },
    ];
    const generated = synthetic.map((part, index): Message => ({ id: `template-${index}`, clusterId: 'one', ...part, body: `internal:${dir}`,
      mentions: [], replyTo: null, chainId: 'test-chain', hop: 0, createdAt: '2026-01-02' }));
    const authoredCopies = [
      { from: 'user', kind: 'chat' as const }, { from: 'one-a', kind: 'task_comment' as const }, { from: 'plugin:example', kind: 'plugin' as const },
    ].map((part, index): Message => ({ ...authored, ...part, id: `authored-${index}` }));
    for (const message of [...generated, ...authoredCopies]) {
      app.store.insertMessage(message, []);
      const event = registry.translate(hubEvent('message', 'one', { message, deliveries: [] }))[0];
      if (message.id.startsWith('template-')) {
        assert.equal(event.bodyData?.body, undefined);
        assert.equal(event.bodyData?.bodyOmitted, true);
      } else {
        assert.equal(event.bodyData?.body, authored.body);
        assert.equal(event.bodyData?.bodyOmitted, undefined);
      }
    }
    const listed = await query();
    for (const message of [rebind, ...generated]) {
      const result = listed.find((item) => item.id === message.id)!;
      assert.deepEqual([result.body, result.bodyOmitted], ['', true]);
      assert.equal(app.store.getMessage(message.id)!.body, message.body, 'the original chat record is retained');
    }
    for (const message of [authored, ...authoredCopies]) {
      const result = listed.find((item) => item.id === message.id)!;
      assert.deepEqual([result.body, result.bodyOmitted], [authored.body, undefined]);
    }
  } finally { await app.close(); }
});

test('host.events.publish returns INVALID_DATA for non-object params and keeps the plugin ready', async () => {
  const home = join(tempDir(), 'home');
  installPlugins(home, [{ id: 'publisher', permissions: ['events.publish'], publishes: [{ name: 'progress', description: 'progress' }] }]);
  const config = readExternalPlugins(home);
  const store = new Store(':memory:');
  const manager = new ExternalPlugins(config.installations, store, ['publisher']);
  try {
    await manager.start();
    for (const params of [[], 'text', 7, true, null]) {
      const answer = await manager.invoke('publisher', { command: 'test',
        arguments: { action: 'host', method: 'host.events.publish', params } }) as { error: { data?: { code: string } } };
      assert.equal(answer.error.data?.code, 'INVALID_DATA', JSON.stringify(params));
    }
    const accepted = await manager.invoke('publisher', { command: 'test',
      arguments: { action: 'host', method: 'host.events.publish', params: { type: 'plugin.publisher.progress', data: {} } } }) as { result: unknown };
    assert.deepEqual(accepted.result, { published: true });
  } finally { await manager.close(); store.close(); }
});

test('every event type reaches a * subscriber from the real Hub with content but no secret, token, session id or local path', async () => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const folders = installPlugins(home, [
    { id: 'everything', permissions: ['events.read', 'messages.read'], events: ['*'] },
    { id: 'no-body', permissions: ['events.read'], events: ['*'] },
  ]);
  const repo = join(dir, 'secret-repo-zz9');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'base');
  git('checkout', '-q', '-b', 'work'); git('commit', '-q', '--allow-empty', '-m', 'reviewed');
  const reviewed = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main'); git('merge', '-q', '--no-ff', 'work', '-m', 'merge');
  const mergeCommit = git('rev-parse', 'HEAD');
  const seed = new Store(join(dir, 'test.db'));
  seed.insertCluster({ id: 'one', name: 'one', category: '', createdAt: '2026-01-01' }, ['a', 'b', 'c'].map((name) => ({ id: `one-${name}`, clusterId: 'one', name,
    avatar: null, harness: 'mock', model: 'secret-model-zz9', effort: null, workerSessionId: `secret-session-${name}`, cwd: repo,
    origin: 'attached' as const, removedAt: null })));
  seed.close();
  const app = await startTestHub({ dir });
  try {
    const user: CollaborationActor = { kind: 'user' };
    const as = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
    let serial = 0;
    const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) => app.hub.collaboration.command(actor, 'one', { ...command, operationId: `op-${++serial}` });
    const revision = (taskId: string) => (app.hub.collaboration.query(user, 'one', { kind: 'task', taskId }) as { task: { revision: number } }).task.revision;
    const act = (actor: CollaborationActor, taskId: string, command: Omit<CollaborationCommand, 'operationId' | 'taskId' | 'expectedRevision'>) =>
      send(actor, { ...command, taskId, expectedRevision: revision(taskId) });

    const sent = app.hub.sendFromUser('one', '@a hello body-zz9');
    await waitFor(async () => (await app.messages('one')).every((m) => m.deliveries.every((d: any) => d.state === 'done')), 'the delivery to finish');
    app.hub.ackMessages('one-b', [sent.id]);
    app.hub.updateMember('one-c', { name: 'renamed' });
    app.hub.updateCluster('one', { name: 'one-renamed' });
    app.hub.setPaused(true); app.hub.setPaused(false);
    send(user, { action: 'cluster.pause', paused: true }); send(user, { action: 'cluster.pause', paused: false });
    const role = send(user, { action: 'role.create', name: 'checker', description: 'checks' }).role!;
    send(user, { action: 'member.roles', memberId: 'one-a', roleIds: [role.id] });
    const task = send(user, { action: 'task.create', title: 'Reviewed work', scope: 'scope text', acceptance: 'acceptance text', reviewer: as('one-b') }).task!;
    const claim = act(as('one-a'), task.id, { action: 'task.claim' });
    act(as('one-a'), task.id, { action: 'task.start', assignmentId: claim.assignment!.id });
    act(user, task.id, { action: 'task.set_git_branch', gitBranch: { repositoryPath: repo, branch: 'work' } });
    const first = act(as('one-a'), task.id, { action: 'task.submit', assignmentId: claim.assignment!.id, summary: 'done', commitSha: reviewed });
    act(as('one-b'), task.id, { action: 'task.review', submissionId: first.submission!.id, verdict: 'reject', reason: 'reason text' });
    const second = act(as('one-a'), task.id, { action: 'task.submit', assignmentId: claim.assignment!.id, summary: 'again', commitSha: reviewed });
    act(as('one-b'), task.id, { action: 'task.review', submissionId: second.submission!.id, verdict: 'approve', reason: 'fine' });
    act(user, task.id, { action: 'task.merge', commitSha: mergeCommit });
    const doomed = send(user, { action: 'task.create', title: 'Doomed', scope: 's', acceptance: 'a' }).task!;
    act(user, doomed.id, { action: 'task.cancel', reason: 'not needed' });
    act(user, doomed.id, { action: 'task.delete', reason: 'not needed' });
    send(as('one-a'), { action: 'bookmark.set', messageId: sent.id, labels: ['keep'] });
    send(as('one-a'), { action: 'bookmark.remove', messageId: sent.id });
    send(user, { action: 'coordinator.set', memberId: 'one-c', enabled: true, mode: 'execute' });
    app.hub.guardSession('mock', 'secret-session-a', { reason: 'wait_limit', chainId: 'chain', secretPath: repo, token: 'token-zz9', taskId: 'x' } as never);
    const { members: [added] } = await app.hub.addMembers('one', [{ harness: 'mock', mode: 'native', name: 'D', projectPath: '/work' }]);
    app.hub.removeMember('one', added.id);

    const catalog = new Set(registryOf(app.store).catalog().map((t) => t.type));
    for (const id of Object.keys(folders)) await app.api('POST', `/api/plugins/${id}/invoke`, { command: 'test', arguments: {} });
    const everything = await waitFor(() => {
      const events = received(folders.everything);
      return [...catalog].every((type) => events.some((e) => e.type === type)) ? events : null;
    }, 'every catalogue type', 10_000).catch(() => {
      const seen = new Set(received(folders.everything).map((e) => e.type));
      throw new Error(`never received: ${[...catalog].filter((t) => !seen.has(t)).join(', ')}`);
    });
    const noBody = received(folders['no-body']);
    const escaped = (s: string) => JSON.stringify(s).slice(1, -1);
    const bridgeSecret = readFileSync(join(home, 'secret'), 'utf8').trim();
    const secrets = [escaped(repo), escaped(app.dir), 'secret-session', 'secret-model-zz9', 'token-zz9', TEST_TOKEN, bridgeSecret];
    for (const event of everything) {
      const text = JSON.stringify(event);
      // A chat message's body is the one place text written by people appears; it is checked separately below.
      const withoutBody = JSON.stringify({ ...event, data: { ...event.data, body: undefined } });
      for (const secret of secrets) assert.ok(!withoutBody.includes(secret), `${event.type} leaks ${secret}: ${text}`);
    }
    for (const event of noBody) {
      for (const secret of secrets) assert.ok(!JSON.stringify(event).includes(secret), `${event.type} leaks ${secret}`);
      assert.equal(event.data.body, undefined);
    }
    assert.ok(everything.some((e) => e.type === 'message.created' && e.data.body === '@a hello body-zz9'), 'messages.read brings the body');
    const guard = everything.find((e) => e.type === 'guard.triggered')!;
    assert.deepEqual(Object.keys(guard.data).sort(), ['at', 'chainId', 'clusterId', 'memberId', 'reason']);
  } finally { await app.close(); }
});

test('publishing: subscribers by exact and wildcard grant, never the publisher, every refusal code, no message, wake or budget', async (t) => {
  const dir = tempDir();
  const home = join(dir, 'home');
  const publishes = [{ name: 'progress', description: '进度', fields: 'percent' }, { name: 'build.done', description: '构建完成' }];
  const folders = installPlugins(home, [
    { id: 'pub', permissions: ['events.publish', 'events.read'], events: ['*'], publishes },
    { id: 'exact-sub', permissions: ['events.read'], events: ['plugin.pub.progress'] },
    { id: 'wild-sub', permissions: ['events.read'], events: ['plugin.*'], grant: { events: ['plugin.pub.*'] } },
    { id: 'two-sub', permissions: ['events.read'], events: ['*'], grant: { clusterIds: ['two'] } },
    { id: 'no-perm', permissions: ['events.publish'], publishes, grant: { permissions: [] } },
  ]);
  const seed = new Store(join(dir, 'test.db'));
  for (const id of ['one', 'two']) {
    seed.insertCluster({ id, name: id, category: '', createdAt: '2026-01-01' }, [{ id: `${id}-a`, clusterId: id, name: 'a', avatar: null, harness: 'mock',
      model: null, effort: null, workerSessionId: `session-${id}`, cwd: dir, origin: 'attached' as const, removedAt: null }]);
  }
  seed.close();
  const app = await startTestHub({ dir });
  const call = async (id: string, params: unknown) => (await app.api('POST', `/api/plugins/${id}/invoke`,
    { command: 'test', arguments: { action: 'host', method: 'host.events.publish', params } })).result as { result?: unknown; error?: { code: number; data?: { code: string } } };
  const code = async (id: string, params: unknown) => (await call(id, params)).error?.data?.code;
  const flush = async () => { for (const id of Object.keys(folders)) await app.api('POST', `/api/plugins/${id}/invoke`, { command: 'test', arguments: {} }); };
  try {
    const listed = (await app.api('GET', '/api/plugins')).installed as any[];
    assert.deepEqual(listed.find((p) => p.id === 'pub').publishes, [{ type: 'plugin.pub.progress', description: '进度', fields: 'percent' },
      { type: 'plugin.pub.build.done', description: '构建完成' }]);
    const wild = listed.find((p) => p.id === 'wild-sub').eventGrants;
    assert.deepEqual(wild.map((g: any) => [g.pattern, g.wildcard, g.types.map((t: any) => t.type)]),
      [['plugin.pub.*', true, ['plugin.pub.progress', 'plugin.pub.build.done']]], 'the settings card lists other plugins\' published types');
    assert.equal(wild[0].types[0].fields, 'percent', 'the settings API retains the event owner\'s field description');
    assert.equal(listed.find((p) => p.id === 'pub').eventPublishLimit, null);
    const before = { events: app.events.length, messages: (await app.messages('one')).length };
    assert.deepEqual((await call('pub', { type: 'plugin.pub.progress', clusterId: 'one', data: { percent: 40 } })).result, { published: true });
    assert.deepEqual((await call('pub', { type: 'plugin.pub.build.done', data: { ok: true } })).result, { published: true }, 'a global event');
    await flush();
    const got = (id: string) => received(folders[id]).map((e) => [e.type, e.clusterId ?? null, e.data]);
    assert.deepEqual(got('exact-sub'), [['plugin.pub.progress', 'one', { percent: 40 }]]);
    assert.deepEqual(got('wild-sub'), [['plugin.pub.progress', 'one', { percent: 40 }], ['plugin.pub.build.done', null, { ok: true }]]);
    assert.deepEqual(got('two-sub'), [['plugin.pub.build.done', null, { ok: true }]], 'a cluster event stays in its cluster; a global one reaches every * grant');
    assert.deepEqual(got('pub'), [], 'the publisher never gets its own event');

    // Every refusal has its stable code, and none of them is forwarded or counted.
    assert.equal(await code('no-perm', { type: 'plugin.no-perm.progress', data: {} }), 'PERMISSION_DENIED');
    assert.equal(await code('pub', { type: 'plugin.other.progress', data: {} }), 'WRONG_NAMESPACE');
    assert.equal(await code('pub', { type: 'message.created', clusterId: 'one', data: {} }), 'WRONG_NAMESPACE', 'no impersonating a core type');
    assert.equal(await code('pub', { type: 'plugin.pubx.progress', data: {} }), 'WRONG_NAMESPACE');
    assert.equal(await code('pub', { type: 'plugin.pub.unknown', data: {} }), 'TYPE_NOT_DECLARED');
    assert.equal(await code('pub', { type: 'plugin.pub.progress', clusterId: 'two', data: {} }), 'CLUSTER_NOT_GRANTED');
    assert.equal(await code('pub', { type: 'plugin.pub.progress', clusterId: 'nope', data: {} }), 'CLUSTER_NOT_GRANTED');
    for (const bad of [{ type: 'plugin.pub.progress', data: 'text' }, { type: 'plugin.pub.progress', data: [1] }, { type: 'plugin.pub.progress' },
      { type: 'plugin.pub.progress', data: {}, extra: 1 }, { type: 7, data: {} }, { type: 'plugin.pub.progress', clusterId: 3, data: {} }]) {
      assert.equal(await code('pub', bad), 'INVALID_DATA', JSON.stringify(bad));
    }
    assert.equal(await code('pub', { type: 'plugin.pub.progress', data: { blob: 'x'.repeat(16 * 1024) } }), 'TOO_LARGE');
    await flush();
    assert.equal(received(folders['wild-sub']).length, 2, 'refused events go nowhere');

    // No message, delivery, member wake-up or loop budget: the Hub recorded nothing at all.
    assert.deepEqual(app.events.slice(before.events).map((e) => e.kind), []);
    assert.equal((await app.messages('one')).length, before.messages);
    assert.equal(app.hub.listMembers('one')[0].status, 'idle', 'nobody was woken');

    // 60 a minute per plugin: 2 accepted so far.
    for (let i = 0; i < 58; i++) assert.deepEqual((await call('pub', { type: 'plugin.pub.progress', clusterId: 'one', data: { i } })).result, { published: true });
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.equal(await code('pub', { type: 'plugin.pub.build.done', data: {} }), 'RATE_LIMITED', 'a global refusal is visible even without a cluster message');
    const latestLimit = async () => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'pub').eventPublishLimit;
    const firstLimit = await latestLimit();
    assert.deepEqual(firstLimit, { at: new Date().toISOString(), perMinute: 60 });
    t.mock.timers.tick(1_000);
    assert.equal(await code('pub', { type: 'plugin.pub.progress', clusterId: 'one', data: {} }), 'RATE_LIMITED');
    assert.equal(await code('pub', { type: 'plugin.pub.progress', clusterId: 'one', data: {} }), 'RATE_LIMITED');
    assert.equal(await code('pub', { type: 'plugin.pub.build.done', data: {} }), 'RATE_LIMITED', 'one budget for all clusters and global');
    assert.deepEqual(await latestLimit(), firstLimit, 'one latest record per plugin, shared by global and cluster refusals within a minute');
    await flush();
    assert.equal(received(folders['exact-sub']).length, 59);
    const notices = (await app.messages('one')).filter((m) => m.systemKind === 'plugin_rate_limit');
    assert.equal(notices.length, 1, 'one notice a minute, however many are refused');
    assert.match(notices[0].body, /插件「pub」发布事件达到上限（每分钟 60 条），超出上限的事件被拒绝/);
    assert.deepEqual(notices[0].mentions, []);
    assert.deepEqual(notices[0].deliveries, [], 'the notice wakes nobody');
    const guards = app.events.filter((e) => e.kind === 'guard').map((e) => [e.clusterId, (e.payload as { reason: string }).reason]);
    assert.deepEqual(guards, [[null, 'external_plugin_publish_rate_limit'], ['one', 'external_plugin_publish_rate_limit']]);
    assert.deepEqual(received(folders.pub), [], 'a * subscriber still gets neither its own events nor its own limit records');
    assert.ok(received(folders['two-sub']).every((e) => e.type === 'plugin.pub.build.done'), 'the notice stays in its cluster');
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 60; i++) assert.deepEqual((await call('pub', { type: 'plugin.pub.build.done', data: { i } })).result, { published: true });
    assert.equal(await code('pub', { type: 'plugin.pub.build.done', data: {} }), 'RATE_LIMITED');
    assert.deepEqual(await latestLimit(), { at: new Date().toISOString(), perMinute: 60 }, 'the next exhausted window replaces the one record');
  } finally { await app.close(); }
});

test('docs/external-plugins.md lists every type the core and the official plugins declare', () => {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  try {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'external-plugins.md'), 'utf8');
    const catalog = registryOf(store).catalog();
    for (const { type } of catalog) assert.ok(doc.includes(`| \`${type}\` |`), `${type} is in the catalogue table`);
  } finally { store.close(); }
});
