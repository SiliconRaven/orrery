// The read side of the plugin API added for referee-style plugins (docs/external-plugins.md): host.members.list,
// host.messages.get, the plugin's own send settings, and checkId with message.check.result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { createCodexNativeAdapter } from '../src/adapters/codex/native.ts';
import { createMockNativeAdapter, type MockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { MockScript } from './mock.ts';
import type { MessageGate } from '../src/core/hub.ts';
import { REPO_ROOT } from '../src/main.ts';
import { Store } from '../src/core/store.ts';
import type { Message } from '../src/core/types.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { hubSecret, startTestHub, tempDir, waitFor } from './helpers.ts';

// One script for every test plugin. OPT_IN decides whether its initialize result asks for the new notifications; a
// plugin that did not opt in exits on any notification other than `event`, so getting one would fail it.
const script = (optIn: boolean) => `
import { createInterface } from 'node:readline';
const OPT_IN = ${optIn};
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let mode = { verdict: 'allow' }; let init = null;
const checks = [], results = [], events = [], settings = [];
const pending = new Map(); let serial = 0;
createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.method) { const id = pending.get(m.id); pending.delete(m.id); send({id, result: m}); return; }
  if (m.method === 'event') { events.push(m.params); return; }
  if (!m.id) {
    if (!OPT_IN) process.exit(9);
    if (m.method === 'message.check.result') results.push(m.params);
    else if (m.method === 'writeSettings.changed') settings.push(m.params);
    return;
  }
  if (m.method === 'initialize') {
    init = m.params;
    return send({id:m.id,result:{apiVersion:1, ...(OPT_IN ? {notifications:['message.check.result','writeSettings.changed','not.a.method']} : {})}});
  }
  if (m.method === 'shutdown') return send({id:m.id,result:{}});
  if (m.method === 'message.check') {
    checks.push(m.params);
    if (mode.verdict === 'allow') return send({id:m.id,result:{allow:true}});
    if (mode.verdict === 'refuse') return send({id:m.id,result:{allow:false,reason:'no'}});
    if (mode.verdict === 'slow') return setTimeout(() => send({id:m.id,result:{allow:true}}), mode.delay);
  }
  if (m.method === 'invoke') {
    const a = m.params.arguments;
    if (a.mode) { mode = a.mode; return send({id:m.id,result:{}}); }
    if (a.host) { const id = 'p-' + (++serial); pending.set(id, m.id); send({id, method:a.host, params:a.params}); return; }
    return send({id:m.id,result:{checks,results,events,settings,init}});
  }
  send({id:m.id,error:{code:-32601,message:'Method not found'}});
});
`;

interface PluginSpec { id: string; permissions: string[]; clusterIds?: string[]; events?: string[]; writeClusterIds?: string[]; optIn?: boolean }
type SeedMember = { name: string; session?: string; harness?: string; hidden?: boolean; removed?: boolean };

/** A database with clusters of native mock members (`<cluster>-<name>`, session `<cluster>-<name>` unless given) and the plugins. */
function setup(clusters: Record<string, SeedMember[]>, plugins: PluginSpec[], seed?: (store: Store, dir: string) => void): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const store = new Store(join(dir, 'test.db'));
  for (const [clusterId, members] of Object.entries(clusters)) {
    store.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' }, members.map((m) => ({
      id: `${clusterId}-${m.name}`, clusterId, name: m.name, avatar: 'data:image/png;base64,UFJJVkFURS1BVkFUQVI=', harness: m.harness ?? 'mock',
      model: 'private-model-name', effort: null, workerSessionId: m.session ?? `${clusterId}-${m.name}`,
      cwd: join(dir, 'private-cwd'), origin: 'attached' as const, removedAt: null })));
    for (const m of members) {
      if (m.hidden) store.db.prepare('UPDATE members SET hidden_at = ? WHERE id = ?').run('2026-01-02', `${clusterId}-${m.name}`);
      if (m.removed) store.db.prepare('UPDATE members SET removed_at = ? WHERE id = ?').run('2026-01-02', `${clusterId}-${m.name}`);
    }
  }
  seed?.(store, dir);
  store.close();
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: plugins.map((plugin) => {
    const directory = join(dir, 'plugins', plugin.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'main.mjs'), script(plugin.optIn !== false));
    writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ id: plugin.id, version: '1.0.0', name: `插件${plugin.id}`, apiVersion: 1,
      entry: 'main.mjs', permissions: plugin.permissions, events: plugin.events ?? [], commands: [{ id: 'test', title: 'Test' }] }));
    return { manifest: join(directory, 'orrery-plugin.json'), permissions: plugin.permissions, clusterIds: plugin.clusterIds ?? ['one'],
      events: plugin.events ?? [], writeClusterIds: plugin.writeClusterIds ?? [] };
  }) }));
  return dir;
}

type App = Awaited<ReturnType<typeof startTestHub>>;
interface Seen { checks: any[]; results: any[]; events: any[]; settings: any[]; init: any }
const invoke = async (app: App, id: string, args: object) =>
  (await app.api('POST', `/api/plugins/${id}/invoke`, { command: 'test', arguments: args })).result;
const seen = (app: App, id: string): Promise<Seen> => invoke(app, id, {});
const mode = (app: App, id: string, verdict: string, delay?: number) => invoke(app, id, { mode: { verdict, delay } });
/** The JSON-RPC answer to a host call made by the plugin: `{result}` or `{error}`. */
const host = (app: App, id: string, method: string, params: unknown) => invoke(app, id, { host: method, params });
const runtime = async (app: App, id: string) => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === id).runtime;

async function mcpSend(app: App, session: string, args: Record<string, unknown>) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const res = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret,
      'x-orrery-session': session, 'x-orrery-harness': 'mock' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: args } }),
  });
  const { result } = await res.json();
  const text = result.content[0].text as string;
  return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
}

/**
 * Wraps the Hub's real gate (the ExternalPlugins) so the Hub's wait for the answers is held until the test releases
 * it: the plugins answer at once, the Hub re-checks only after release (no race with the 1.5 s check timeout).
 */
function holdGate(app: App) {
  const real = (app.hub as unknown as { gate: MessageGate }).gate;
  const held: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  app.hub.setMessageGate({
    checkMessage(request) {
      const asked = real.checkMessage(request);
      if (!asked) return null;
      const hold = Promise.withResolvers<void>();
      held.push(hold);
      return hold.promise.then(() => asked);
    },
    checkStoring: (checkId, messageId) => real.checkStoring?.(checkId, messageId),
    checkSettled: (checkId, result) => real.checkSettled?.(checkId, result),
  });
  return { real, held, release: (n: number) => held[n].resolve(), restore: () => app.hub.setMessageGate(real) };
}

const SECRETS = (dir: string) => [dir, 'private-cwd', 'private-model-name', 'UFJJVkFURS1BVkFUQVI', 'fake-session-secret', 'fake-token-value'];
const noSecrets = (value: unknown, dir: string, what: string) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS(dir)) assert.ok(!text.includes(secret) && !text.includes(JSON.stringify(secret).slice(1, -1)), `${what} leaks ${secret}`);
};

test('host.members.list and host.messages.get: granted content, stable refusals, nothing internal', async () => {
  const dir = setup({
    one: [{ name: 'Alice', session: 'fake-session-secret-alice' }, { name: 'Bob', hidden: true }, { name: 'Carol', removed: true }],
    two: [{ name: 'Dan' }],
    gone: [{ name: 'Eve' }],
  }, [
    { id: 'reader', permissions: ['clusters.read', 'messages.read'], clusterIds: ['one', 'gone'] },
    { id: 'no-members', permissions: ['messages.read'] },
    { id: 'no-messages', permissions: ['clusters.read'] },
  ], (store) => {
    store.saveCollaborationRole({ id: 'role-review', clusterId: 'one', name: 'reviewer', description: 'reviews' });
    store.setCollaborationMemberRoles('one-Alice', ['role-review']);
  });
  const native = createMockNativeAdapter({ sessions: ['fake-session-secret-alice', 'fake-session-secret-new'].map((id) =>
    ({ id, title: id, model: null, cwd: join(dir, 'private-cwd'), updatedAt: null })) });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  const code = (answer: any) => answer.error?.data?.code;
  try {
    const listed = await host(app, 'reader', 'host.members.list', { clusterId: 'one' });
    assert.deepEqual(listed.result.members.map((m: any) => Object.keys(m)), [['id', 'name', 'harness', 'status', 'hidden', 'roles'],
      ['id', 'name', 'harness', 'status', 'hidden', 'roles']]);
    const [alice, bob] = listed.result.members;
    assert.deepEqual({ ...alice, status: undefined }, { id: 'one-Alice', name: 'Alice', harness: 'mock', status: undefined,
      hidden: false, roles: [{ id: 'role-review', name: 'reviewer' }] });
    assert.deepEqual([bob.name, bob.hidden, bob.roles], ['Bob', true, []]);
    assert.ok(['idle', 'busy', 'offline'].includes(alice.status));
    assert.ok(!listed.result.members.some((m: any) => m.name === 'Carol'), 'a removed member is not listed');
    noSecrets(listed, dir, 'members.list');

    // Refusals: permission first, then parameters, then the cluster.
    assert.equal(code(await host(app, 'no-members', 'host.members.list', { clusterId: 'one' })), 'PERMISSION_DENIED');
    assert.equal(code(await host(app, 'reader', 'host.members.list', { clusterId: 'one', extra: 1 })), 'INVALID_DATA');
    assert.equal(code(await host(app, 'reader', 'host.members.list', {})), 'INVALID_DATA');
    assert.equal(code(await host(app, 'reader', 'host.members.list', { clusterId: 'two' })), 'CLUSTER_NOT_GRANTED');
    // Every params shape: without the permission PERMISSION_DENIED, with it INVALID_DATA (absent and null read as {}).
    for (const shape of [[], ['one'], 'one', '', 5, 0, false, true, null, undefined]) {
      const what = JSON.stringify(shape) ?? 'absent';
      assert.equal(code(await host(app, 'no-members', 'host.members.list', shape)), 'PERMISSION_DENIED', `members.list ${what}`);
      assert.equal(code(await host(app, 'no-messages', 'host.messages.get', shape)), 'PERMISSION_DENIED', `messages.get ${what}`);
      assert.equal(code(await host(app, 'reader', 'host.members.list', shape)), 'INVALID_DATA', `members.list ${what}`);
      assert.equal(code(await host(app, 'reader', 'host.messages.get', shape)), 'INVALID_DATA', `messages.get ${what}`);
    }
    // Parameters before the cluster; the v1 list call keeps its code-less error for a non-object params.
    assert.equal(code(await host(app, 'reader', 'host.messages.get', { clusterId: 'two', messageId: 7 })), 'INVALID_DATA');
    const old = await host(app, 'reader', 'host.messages.list', []);
    assert.deepEqual(old.error, { code: -32000, message: 'host request denied or invalid' });

    // messages.get: the same item as the list, through the same function.
    const user = app.hub.sendFromUser('one', 'User text keeps C:\\some\\user-file verbatim. ' + 'y'.repeat(9000));
    const other = app.hub.sendFromUser('two', 'another cluster');
    const got = await host(app, 'reader', 'host.messages.get', { clusterId: 'one', messageId: user.id });
    const page = await host(app, 'reader', 'host.messages.list', { clusterId: 'one', limit: 1 });
    assert.deepEqual(got.result, { message: page.result.messages[0] });
    assert.deepEqual([got.result.message.bodyTruncated, got.result.message.body.length, got.result.message.messageKind], [true, 8000, 'chat']);
    const elsewhere = await host(app, 'reader', 'host.messages.get', { clusterId: 'one', messageId: other.id });
    const unknown = await host(app, 'reader', 'host.messages.get', { clusterId: 'one', messageId: 'no-such-message' });
    assert.deepEqual(elsewhere.error, unknown.error, 'another cluster\'s message reads exactly like a missing one');
    assert.equal(code(unknown), 'NOT_FOUND');
    assert.equal(code(await host(app, 'reader', 'host.messages.get', { clusterId: 'two', messageId: other.id })), 'CLUSTER_NOT_GRANTED');
    assert.equal(code(await host(app, 'no-messages', 'host.messages.get', { clusterId: 'one', messageId: user.id })), 'PERMISSION_DENIED');
    for (const params of [{ clusterId: 'one' }, { clusterId: 'one', messageId: 7 }, { clusterId: 'one', messageId: user.id, before: 'x' }]) {
      assert.equal(code(await host(app, 'reader', 'host.messages.get', params)), 'INVALID_DATA', JSON.stringify(params));
    }

    // Hub-composed bodies: a rebind notice (session ids and the working folder) and a user's handover send.
    await app.hub.rebindMember('one-Alice', { harness: 'mock', sessionId: 'fake-session-secret-new', confirmStopped: true });
    const rebind = app.store.listMessages('one', 100).find((m) => m.systemKind === 'rebind')!;
    assert.ok(rebind.body.includes('fake-session-secret-alice') && rebind.body.includes(dir), 'the fixture notice holds internal values');
    const handover = app.hub.sendFromUser('one', '@Alice handover: session fake-session-secret-alice in ' + join(dir, 'private-cwd')
      + ' token fake-token-value', undefined, undefined, undefined, 'handover');
    for (const [message, kind] of [[rebind, 'system'], [handover, 'handover']] as [Message, string][]) {
      const answer = await host(app, 'reader', 'host.messages.get', { clusterId: 'one', messageId: message.id });
      assert.deepEqual([answer.result.message.body, answer.result.message.bodyOmitted, answer.result.message.messageKind], ['', true, kind]);
      noSecrets(answer, dir, `messages.get of ${kind}`);
      assert.equal(app.store.getMessage(message.id)!.body, message.body, 'the chat record keeps the original');
    }
    const listedAll = await host(app, 'reader', 'host.messages.list', { clusterId: 'one', limit: 100 });
    assert.equal(listedAll.result.messages.find((m: any) => m.id === handover.id).messageKind, 'handover', 'the list says handover too');
    noSecrets(listedAll.result.messages.filter((m: any) => m.id !== user.id), dir, 'messages.list');

    // A deleted cluster in the whitelist is out of scope like any other.
    app.store.deleteCluster('gone');
    assert.equal(code(await host(app, 'reader', 'host.members.list', { clusterId: 'gone' })), 'CLUSTER_NOT_GRANTED');
    assert.equal((await runtime(app, 'reader')).state, 'ready', 'refusals do not stop the plugin');
  } finally { await app.close(); }
});

test('a bound Codex transcript reaches an official plugin without publishing or persisting its contents', async (t) => {
  const session = '019abcde-1111-7777-8888-111111111111';
  const memberId = 'one-Codex';
  const timestamp = '2026-01-02T03:04:05.123Z';
  const delivered = 'synthetic Hub delivery';
  const reply = 'synthetic native-only transcript 418cd034';
  const completion = (type: string, props: Record<string, unknown>) => ({ timestamp, type: 'event_msg',
    payload: { type: 'item_completed', thread_id: session, item: { type, ...props } } });
  const dir = setup({ one: [{ name: 'Codex', session, harness: 'codex' }] }, [
    { id: 'restricted', permissions: ['clusters.read', 'messages.read', 'events.read'], events: ['message.created'] },
  ], (store, root) => {
    const [delivery] = store.insertMessage({ id: 'direct-fixture', clusterId: 'one', from: 'user', body: delivered, mentions: [memberId],
      replyTo: null, chainId: 'direct-fixture', hop: 0, createdAt: timestamp }, [memberId], true);
    store.startDelivery(delivery.id, delivery.id);
    store.setDeliveryState(delivery.id, 'done', null, 'accepted');
    const file = join(root, 'codex', 'sessions', '2026', '01', '02', `rollout-2026-01-02T03-04-05-${session}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    const rows = [
      { timestamp, type: 'session_meta', payload: { id: session, history_mode: 'paginated' } },
      completion('UserMessage', { client_id: 'manual-input', content: [{ type: 'text', text: delivered }] }),
      completion('UserMessage', { client_id: delivery.id, content: [{ type: 'text', text: delivered }] }),
      completion('AgentMessage', { content: [{ type: 'Text', text: reply }] }),
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  });
  const codex = createCodexNativeAdapter({ codexHome: join(dir, 'codex'), appRunning: async () => false,
    launch: () => assert.fail('transcript fixture never starts Codex') });
  const app = await startTestHub({ dir, nativeAdapters: { codex }, plugins: [...officialPlugins, {
    id: 'transcript-probe', version: '1.0.0', routes: [{ method: 'GET', pattern: /^\/api\/x\/transcript-probe\/members\/([^/]+)$/,
      handle: ({ hub, params, url }) => hub.memberTranscript(params[0], { limit: url.searchParams.has('cursor') ? 2 : 1,
        cursor: url.searchParams.get('cursor') ?? undefined }) }],
  }] });
  try {
    assert.equal((await host(app, 'restricted', 'host.members.list', { clusterId: 'one' })).result.members[0].id, memberId);
    const logged: string[] = [];
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logged.push(inspect(args)); });
    }
    const changes = app.store.db.prepare('SELECT total_changes() AS n');
    const before = changes.get();
    const eventSeq = app.store.lastEventSeq();
    const url = `/api/x/transcript-probe/members/${memberId}`;
    const tail = await app.api('GET', url);
    assert.equal(tail.status, 'ok');
    assert.deepEqual(tail.items.map((item: { kind: string; text: string }) => [item.kind, item.text]), [['assistant', reply]]);
    assert.ok(tail.before);
    const older = await app.api('GET', `${url}?cursor=${encodeURIComponent(tail.before)}`);
    assert.equal(older.status, 'ok');
    assert.deepEqual(older.items.map((item: { kind: string }) => item.kind), ['user', 'orrery_delivery']);
    assert.equal(older.items[0].text, delivered);
    assert.deepEqual(older.items[1].parts, [{ messageId: 'direct-fixture', from: 'user', kind: 'chat', body: delivered }]);
    assert.ok(older.items.every((item: object) => !('source' in item)));

    const restricted = await host(app, 'restricted', 'host.members.transcript', { clusterId: 'one', memberId });
    assert.deepEqual(restricted.error, { code: -32000, message: 'host request denied or invalid' });
    const core = await fetch(`${app.url}/api/members/${memberId}/transcript`);
    assert.equal(core.status, 404);
    assert.ok(!(await core.text()).includes(reply));
    const mcp = async (method: string, params: object) => {
      const response = await fetch(`${app.url}/mcp`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': hubSecret(app.home) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const listed = await mcp('tools/list', {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes('read_messages'));
    assert.ok(!names.some((name: string) => /transcript/i.test(name)));
    const called = await mcp('tools/call', { name: 'member_transcript', arguments: { memberId }, _meta: { threadId: session } });
    assert.ok(called.error || called.result?.isError);
    assert.ok(!JSON.stringify(called).includes(reply));

    assert.deepEqual((await seen(app, 'restricted')).events, []);
    assert.deepEqual(changes.get(), before, 'reading a page does not write to SQLite');
    assert.equal(app.store.lastEventSeq(), eventSeq);
    assert.deepEqual(app.events, []);
    assert.ok(!logged.some((line) => line.includes(reply)));
  } finally { await app.close(); }
});

test('message.created and list items name handover, handoff and resend messages in messageKind; the legacy kind is unchanged', async () => {
  const dir = setup({ one: [{ name: 'A' }, { name: 'B' }] }, [
    { id: 'watcher', permissions: ['events.read', 'messages.read', 'clusters.read'], events: ['message.created'] },
  ]);
  const app = await startTestHub({ dir });
  try {
    const plain = app.hub.sendFromUser('one', 'plain');
    const handover = app.hub.sendFromUser('one', 'handover text', undefined, undefined, undefined, 'handover');
    const events = await waitFor(async () => {
      const got = (await seen(app, 'watcher')).events.filter((e) => [plain.id, handover.id].includes(e.data.messageId));
      return got.length === 2 ? got : null;
    }, 'both message events');
    assert.deepEqual(events.map((e) => [e.data.kind, e.data.messageKind]), [[null, 'chat'], [null, 'handover']]);
    assert.equal(events[1].data.bodyOmitted, true);
    // The user's delivery handoff and resend are written the same way (Hub.handoff / Hub.resend); stored directly here.
    for (const kind of ['handoff', 'resend'] as const) {
      app.store.insertMessage({ id: `m-${kind}`, clusterId: 'one', from: 'user', mentions: [], body: `原请求 ${kind}`, replyTo: null,
        chainId: `m-${kind}`, hop: 0, createdAt: '2026-01-02', kind }, []);
    }
    const listed = (await host(app, 'watcher', 'host.messages.list', { clusterId: 'one', limit: 10 })).result.messages;
    assert.deepEqual(listed.map((m: any) => [m.messageKind, m.bodyOmitted ?? false]),
      [['chat', false], ['handover', true], ['handoff', true], ['resend', true]]);
  } finally { await app.close(); }
});

test('initialize carries the effective write settings; a change reaches an opted-in plugin; one that did not opt in is untouched', async () => {
  const dir = setup({ one: [{ name: 'A' }] }, [
    { id: 'writer', permissions: ['messages.send', 'messages.mention'], writeClusterIds: ['one'] },
    { id: 'quiet', permissions: ['messages.send'], writeClusterIds: ['one'], optIn: false },
    { id: 'masked', permissions: ['messages.send'], writeClusterIds: ['one'] },
    { id: 'reader', permissions: ['clusters.read'] },
  ], (store) => store.setExternalWriteSettings('masked', { mentionEnabled: true, perMinute: 4, perHour: null }));
  const app = await startTestHub({ dir });
  const patch = (id: string, body: object) => app.api('PATCH', `/api/plugins/${id}/write-settings`, body);
  try {
    const writer = await seen(app, 'writer');
    assert.deepEqual([writer.init.writeClusterIds, writer.init.writeSettings], [['one'], { mentionEnabled: false, perMinute: 10, perHour: 200 }]);
    // Saved true, but without messages.mention its mentions cannot wake anyone: the plugin is told what is in effect.
    assert.deepEqual((await seen(app, 'masked')).init.writeSettings, { mentionEnabled: false, perMinute: 4, perHour: null });
    assert.equal((await seen(app, 'reader')).init.writeSettings, undefined, 'no send grant, no write settings');
    noSecrets(writer.init, dir, 'initialize');
    assert.ok(!JSON.stringify(writer.init).includes(app.home));

    await patch('writer', { mentionEnabled: true, perMinute: 5 });
    await patch('writer', { perHour: null, confirmUnlimited: true });
    const changes = await waitFor(async () => { const s = (await seen(app, 'writer')).settings; return s.length === 2 ? s : null; }, 'two changes');
    assert.deepEqual(changes, [{ writeSettings: { mentionEnabled: true, perMinute: 5, perHour: 200 } },
      { writeSettings: { mentionEnabled: true, perMinute: 5, perHour: null } }]);
    assert.deepEqual(changes[1].writeSettings, (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'writer').writeSettings);
    // A refused change tells nothing.
    await assert.rejects(patch('writer', { perMinute: 0 }));
    // Not opted in: no notification (it would exit on one), still running and answering.
    await patch('quiet', { perMinute: 3 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await runtime(app, 'quiet')).state, 'ready');
    assert.deepEqual((await seen(app, 'quiet')).settings, []);
    assert.equal((await seen(app, 'writer')).settings.length, 2);
  } finally { await app.close(); }
});

test('checkId: allowed and stored, refused by another plugin, created events only for the asked, one result each', async () => {
  const dir = setup({ one: [{ name: 'A' }, { name: 'B' }] }, [
    { id: 'judge', permissions: ['messages.gate', 'messages.read', 'events.read'], events: ['message.created'] },
    { id: 'second', permissions: ['messages.gate'] },
    { id: 'watcher', permissions: ['events.read'], events: ['message.created'] },
    { id: 'old-gate', permissions: ['messages.gate', 'events.read'], events: ['message.created'], optIn: false },
  ]);
  const app = await startTestHub({ dir });
  try {
    const sent = await mcpSend(app, 'one-A', { body: '@B first' });
    assert.equal(sent.isError, false);
    const messageId = sent.data.messageId;
    const judge = await waitFor(async () => { const s = await seen(app, 'judge'); return s.results.length && s.events.length ? s : null; }, 'judge result');
    const checkId = judge.checks[0].checkId;
    assert.deepEqual(judge.results, [{ checkId, stored: true, messageId }]);
    assert.equal(judge.events.find((e) => e.data.messageId === messageId).data.checkId, checkId, 'the asked plugin can tie the event to its check');
    const second = await waitFor(async () => { const s = await seen(app, 'second'); return s.results.length ? s : null; }, 'second result');
    assert.equal(second.checks[0].checkId, checkId, 'one id per check, the same for every plugin asked');
    assert.deepEqual(second.results, [{ checkId, stored: true, messageId }], 'no events.read needed for the result');
    const watcher = await waitFor(async () => { const s = await seen(app, 'watcher'); return s.events.length ? s : null; }, 'watcher event');
    assert.equal(watcher.events[0].data.messageId, messageId);
    assert.equal(watcher.events[0].data.checkId, undefined, 'a plugin that was not asked never sees the checkId');
    // Asked but not opted in: the event carries the checkId (an additive field), and no notification reaches it.
    const old = await waitFor(async () => { const s = await seen(app, 'old-gate'); return s.events.length ? s : null; }, 'old gate event');
    assert.equal(old.events[0].data.checkId, checkId);
    assert.equal((await runtime(app, 'old-gate')).state, 'ready');

    // Another plugin refuses: the allower learns it was not stored and why; the refuser gets nothing.
    await mode(app, 'second', 'refuse');
    assert.equal((await mcpSend(app, 'one-A', { body: '@B refused' })).isError, true);
    const refusedId = (await seen(app, 'judge')).checks[1].checkId;
    assert.notEqual(refusedId, checkId);
    await waitFor(async () => (await seen(app, 'judge')).results.length === 2, 'refusal result');
    assert.deepEqual((await seen(app, 'judge')).results[1], { checkId: refusedId, stored: false, reason: 'refused_by_other' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await seen(app, 'second')).results.length, 1, 'the refuser is told nothing more');

    // Bounded: nothing is kept once checks end.
    const plugins = (app.hub as unknown as { gate: { checks: Map<string, unknown>; storing: Map<string, unknown> } }).gate;
    assert.deepEqual([plugins.checks.size, plugins.storing.size], [0, 0]);
  } finally { await app.close(); }
});

test('checkId: the Hub rejects after the wait (member removed, hop limit, rebind, clientMessageId stored meanwhile) and says so once', async () => {
  const dir = setup({ one: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D', session: 'old-d' }] }, [
    { id: 'judge', permissions: ['messages.gate', 'messages.read'] },
  ]);
  const native = createMockNativeAdapter({ sessions: ['old-d', 'new-d'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null })) });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  const gate = holdGate(app);
  const resultsFor = async (body: string) => {
    const s = await seen(app, 'judge');
    const ids = s.checks.filter((c) => c.body === body).map((c) => c.checkId);
    return s.results.filter((r) => ids.includes(r.checkId));
  };
  try {
    // Member removed while the plugins answered.
    const removed = mcpSend(app, 'one-C', { body: 'C words' });
    await waitFor(() => gate.held.length === 1, 'C waiting');
    app.hub.removeMember('one', 'one-C');
    gate.release(0);
    assert.equal((await removed).isError, true);
    assert.deepEqual(await waitFor(() => resultsFor('C words').then((r) => (r.length ? r : null)), 'C result'),
      [{ checkId: (await seen(app, 'judge')).checks[0].checkId, stored: false, reason: 'rejected_by_hub' }]);

    // Hop limit reached meanwhile: B answers the user's message (hop 1), the limit drops to 0 before the Hub re-checks.
    gate.restore();
    app.hub.sendFromUser('one', '@B start');
    await waitFor(() => native.delivered.some((d) => d.sessionId === 'one-B'), 'B got the user message');
    const hopGate = holdGate(app);
    const hop = mcpSend(app, 'one-B', { body: 'B hop words' });
    await waitFor(() => hopGate.held.length === 1, 'B waiting');
    app.hub.setLimit('maxHops', { kind: 'finite', value: 0 });
    hopGate.release(0);
    assert.match((await hop).text, /exceeds the limit/);
    assert.deepEqual((await waitFor(() => resultsFor('B hop words').then((r) => (r.length ? r : null)), 'B result')).map((r) => r.reason), ['rejected_by_hub']);
    app.hub.setLimit('maxHops', { kind: 'finite', value: 6 });

    // The sender's conversation is rebound during the check.
    const rebindGate = hopGate;
    const rebound = mcpSend(app, 'old-d', { body: 'D old conversation words' });
    await waitFor(() => rebindGate.held.length === 2, 'D waiting');
    await app.hub.rebindMember('one-D', { harness: 'mock', sessionId: 'new-d', confirmStopped: true });
    rebindGate.release(1);
    assert.match((await rebound).text, /sender conversation changed/);
    assert.deepEqual((await waitFor(() => resultsFor('D old conversation words').then((r) => (r.length ? r : null)), 'D result')).map((r) => r.reason), ['rejected_by_hub']);

    // Same clientMessageId twice at once: the first is stored, the retry's check ends unstored (the reply is a duplicate).
    const first = mcpSend(app, 'one-A', { body: 'A keyed words', clientMessageId: 'k1' });
    const retry = mcpSend(app, 'one-A', { body: 'A keyed words', clientMessageId: 'k1' });
    await waitFor(() => rebindGate.held.length === 4, 'both waiting');
    rebindGate.release(2);
    const accepted = await first;
    rebindGate.release(3);
    const repeated = await retry;
    assert.deepEqual([repeated.data.messageId, repeated.data.duplicate], [accepted.data.messageId, true]);
    const keyed = await waitFor(() => resultsFor('A keyed words').then((r) => (r.length === 2 ? r : null)), 'both keyed results');
    assert.deepEqual(keyed.map((r) => r.stored).sort(), [false, true]);
    assert.equal(keyed.find((r) => r.stored).messageId, accepted.data.messageId);
    assert.equal(keyed.find((r) => !r.stored).reason, 'rejected_by_hub');
    // A retry of an accepted key later asks nobody and so produces no new result.
    const checksBefore = (await seen(app, 'judge')).checks.length;
    assert.equal((await mcpSend(app, 'one-A', { body: 'A keyed words', clientMessageId: 'k1' })).data.duplicate, true);
    await new Promise((r) => setTimeout(r, 100));
    const after = await seen(app, 'judge');
    assert.equal(after.checks.length, checksBefore);
    assert.equal(new Set(after.results.map((r) => r.checkId)).size, after.results.length, 'never two results for one check');
    assert.equal(after.results.length, after.checks.length, 'every allowed check got exactly one result');
    assert.deepEqual([(gate.real as any).checks.size, (gate.real as any).storing.size], [0, 0]);
  } finally { await app.close(); }
});

test('checkId: two concurrent sends from one member get their own ids and results; a send that throws after its commit is still reported stored', async (t) => {
  const dir = setup({ one: [{ name: 'A' }, { name: 'B' }] }, [{ id: 'judge', permissions: ['messages.gate', 'messages.read'] }]);
  const app = await startTestHub({ dir });
  const gate = holdGate(app);
  try {
    const one = mcpSend(app, 'one-A', { body: '@B one' });
    const two = mcpSend(app, 'one-A', { body: '@B two' });
    await waitFor(() => gate.held.length === 2, 'both waiting');
    gate.release(1);   // the later one first
    const second = await two;
    gate.release(0);
    const first = await one;
    const judge = await waitFor(async () => { const s = await seen(app, 'judge'); return s.results.length === 2 ? s : null; }, 'two results');
    const idOf = (body: string) => judge.checks.find((c) => c.body === body).checkId;
    assert.notEqual(idOf('@B one'), idOf('@B two'));
    assert.deepEqual(judge.results, [{ checkId: idOf('@B two'), stored: true, messageId: second.data.messageId },
      { checkId: idOf('@B one'), stored: true, messageId: first.data.messageId }]);

    // A failure after the transaction escapes post() (Hub.notify swallows listener errors, scheduling a recipient does
    // not): the send rejects, yet the message is stored, and the result says so.
    gate.restore();
    const schedule = t.mock.method(app.hub as unknown as { schedule(id: string): void }, 'schedule', () => { throw new Error('schedule fixture'); });
    await assert.rejects(app.hub.sendFromMemberGated('one-A', '@B after commit'), /schedule fixture/);
    schedule.mock.restore();
    const stored = app.store.listMessages('one', 50).find((m) => m.body === '@B after commit')!;
    assert.ok(stored, 'the transaction committed');
    const last = await waitFor(async () => { const s = await seen(app, 'judge'); return s.results.length === 3 ? s.results[2] : null; }, 'third result');
    assert.deepEqual([last.stored, last.messageId], [true, stored.id]);
  } finally { await app.close(); }
});

test('checkId: a timed-out check gets no result even after its late answer; the reply path carries checkId and results', async () => {
  const dir = setup({ one: [{ name: 'A' }, { name: 'B' }] }, [
    { id: 'judge', permissions: ['messages.gate', 'events.read'], events: ['message.created'] },
    { id: 'second', permissions: ['messages.gate'] },
  ]);
  let answer = '@B the answer';
  // Only A answers (B, whom the answer names, stays silent).
  const native: MockNativeAdapter = createMockNativeAdapter({ onDeliver: async (session, _text, ctx) => {
    if (session === 'one-A') ctx.reply?.(answer);
    return 'completed';
  } });
  (native as { replies?: boolean }).replies = true;
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    // The reply path: the Hub posts A's answer through the same check.
    app.hub.sendFromUser('one', '@A question');
    const reply = await waitFor(() => app.store.listMessages('one', 50).find((m) => m.from === 'one-A'), 'answer posted');
    const judge = await waitFor(async () => { const s = await seen(app, 'judge'); return s.results.length && s.events.some((e) => e.data.messageId === reply.id) ? s : null; }, 'judge saw the answer');
    const checkId = judge.checks.at(-1).checkId;
    assert.deepEqual(judge.results, [{ checkId, stored: true, messageId: reply.id }]);
    assert.equal(judge.events.find((e) => e.data.messageId === reply.id).data.checkId, checkId);
    // A refused answer: the allower is told, nothing is stored.
    await mode(app, 'second', 'refuse');
    answer = '@B refused answer';
    app.hub.sendFromUser('one', '@A question two');
    await waitFor(async () => (await seen(app, 'judge')).results.length === 2, 'refused answer result');
    assert.deepEqual((await seen(app, 'judge')).results[1], { checkId: (await seen(app, 'judge')).checks.at(-1).checkId, stored: false, reason: 'refused_by_other' });
    await mode(app, 'second', 'allow');

    // Timed out: the message goes through (fail-open); the slow plugin never allowed in time, so it gets no result,
    // though its event still names the check it was asked about. Its late answer is dropped.
    await mode(app, 'judge', 'slow', 1800);
    const late = await mcpSend(app, 'one-A', { body: '@B late' });
    assert.equal(late.isError, false);
    await new Promise((r) => setTimeout(r, 600));   // the late answer arrives meanwhile
    const afterLate = await seen(app, 'judge');
    assert.equal(afterLate.results.length, 2, 'no result for a check it did not answer in time');
    assert.equal(afterLate.events.find((e) => e.data.messageId === late.data.messageId).data.checkId, afterLate.checks.at(-1).checkId);
    assert.equal((await seen(app, 'second')).results.at(-1).messageId, late.data.messageId, 'the plugin that allowed in time is told');
    await mode(app, 'judge', 'allow');
    const next = await mcpSend(app, 'one-A', { body: '@B next' });
    await waitFor(async () => (await seen(app, 'judge')).results.length === 3, 'next result');
    assert.deepEqual((await seen(app, 'judge')).results[2].messageId, next.data.messageId);
    assert.equal((await runtime(app, 'judge')).state, 'ready');
  } finally { await app.close(); }
});

test('a result whose cluster is gone when it is written is dropped like an event, and the next notification says so', async () => {
  const dir = setup({ one: [{ name: 'A' }, { name: 'B' }] }, [{ id: 'judge', permissions: ['messages.gate'] }]);   // no events.read
  const app = await startTestHub({ dir });
  const gate = holdGate(app);
  try {
    const pending = mcpSend(app, 'one-A', { body: '@B while deleted' });
    await waitFor(() => gate.held.length === 1, 'A waiting');
    app.hub.deleteCluster('one');
    gate.release(0);
    assert.equal((await pending).isError, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual((await seen(app, 'judge')).results, [], 'the cluster was in the recycle bin when the result was written');
    app.hub.restoreCluster('one');
    gate.restore();
    const sent = await mcpSend(app, 'one-A', { body: '@B after restore' });
    const [result] = await waitFor(async () => { const r = (await seen(app, 'judge')).results; return r.length ? r : null; }, 'next result');
    assert.deepEqual([result.stored, result.messageId, result.dropped], [true, sent.data.messageId, 1], 'dropped rides on the notification');
  } finally { await app.close(); }
});

test('a plugin whose saved write settings are malformed fails alone; the Hub and the other plugins start', async () => {
  const dir = setup({ one: [{ name: 'A' }] }, [
    { id: 'writer', permissions: ['messages.send'], writeClusterIds: ['one'] },
    { id: 'reader', permissions: ['clusters.read'] },
  ], (store) => store.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('external_plugin_write:writer', '{not json'));
  const app = await startTestHub({ dir });
  try {
    assert.deepEqual((await host(app, 'reader', 'host.clusters.list', {})).result, { clusters: [{ id: 'one', name: 'one' }] });
    await assert.rejects(seen(app, 'writer'), /failed/, 'only the plugin with the bad value is out (INITIALIZE_FAILED)');
  } finally { await app.close(); }
});

test('example referee: an undecided reply expires, so a check result that never comes does not block the member', async () => {
  const dir = setup({ one: [{ name: 'L' }, { name: 'A' }, { name: 'B' }] }, []);
  const plugin = join(dir, 'reply-once-gate');
  cpSync(join(REPO_ROOT, 'test', 'fixtures', 'reply-once-gate'), plugin, { recursive: true });
  // A's first reply is allowed only after the Hub's 1.5 s timeout: the Hub lets it through and sends no result.
  writeFileSync(join(plugin, 'lead.json'), JSON.stringify({ lead: 'L', undecidedMs: 300, delayFirstReplyMs: 1700 }));
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(plugin, 'orrery-plugin.json'), permissions: ['messages.gate'], clusterIds: ['one'] }] }));
  const app = await startTestHub({ dir });
  const count = async () => (await app.api('POST', '/api/plugins/reply-once-gate/invoke', { command: 'count', arguments: { clusterId: 'one' } })).result;
  try {
    assert.equal((await mcpSend(app, 'one-L', { body: '@A @B go' })).isError, false);
    assert.equal((await mcpSend(app, 'one-A', { body: 'late first' })).isError, false, 'fail-open: stored without a result');
    const blocked = await mcpSend(app, 'one-A', { body: 'too soon' });
    assert.match(blocked.text, /上一条回复还没有结果/);
    await waitFor(async () => (await count()).undecided === 0, 'the mark expired', 3000);
    assert.equal((await mcpSend(app, 'one-A', { body: 'counted' })).isError, false);
    const final = await waitFor(async () => { const c = await count(); return c.undecided === 0 && Object.keys(c.stored).length ? c : null; }, 'counted');
    assert.deepEqual(final.stored, { 'one-A': 1 }, 'only the reply whose result came is counted');
  } finally { await app.close(); }
});

test('example referee: kickoff names every visible member via members.list, and replies are counted exactly from the results', async () => {
  const outcomes: { body: string; isError: boolean; text: string }[] = [];
  // Every member: reply; if that was refused, reply once more; then try a second reply.
  const script: MockScript = async (msg, tools) => {
    if (!msg.body.includes('请各回答一次')) return;
    const say = async (body: string) => { const r = await tools.send(body); outcomes.push({ body, ...r }); return r; };
    if ((await say('回答')).isError) await say('回答（重发）');
    await say('再补充一句');
  };
  const dir = tempDir();
  let app = await startTestHub({ dir, mock: { script } });
  let clusterId: string;
  let ids: Record<string, string>;
  try {
    const { cluster, members } = await app.cluster('referee', ['A', 'B', 'C', 'Hidden']);
    clusterId = cluster.id;
    ids = Object.fromEntries(members.map((m: any) => [m.name, m.id]));
    await app.api('POST', `/api/members/${ids.Hidden}/hidden`, { hidden: true });
  } finally { await app.close(); }
  const plugin = join(dir, 'reply-once-gate');
  cpSync(join(REPO_ROOT, 'test', 'fixtures', 'reply-once-gate'), plugin, { recursive: true });
  writeFileSync(join(plugin, 'lead.json'), JSON.stringify({ lead: 'Host' }));   // no member is the lead: the plugin opens rounds
  // A second gate refuses B's first reply: the referee must not count it, and B may reply again.
  const other = join(dir, 'other-gate');
  mkdirSync(other);
  writeFileSync(join(other, 'orrery-plugin.json'), JSON.stringify({ id: 'other-gate', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', permissions: ['messages.gate'], commands: [] }));
  writeFileSync(join(other, 'main.mjs'), `
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let refusedB = false;
createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') return send({id:m.id,result:{apiVersion:1}});
  if (m.method === 'shutdown') return send({id:m.id,result:{}});
  if (m.method === 'message.check') {
    if (m.params.sender.name === 'B' && !refusedB) { refusedB = true; return send({id:m.id,result:{allow:false,reason:'not yet'}}); }
    return send({id:m.id,result:{allow:true}});
  }
  send({id:m.id,error:{code:-32601,message:'Method not found'}});
});`);
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(plugin, 'orrery-plugin.json'), permissions: ['messages.gate', 'clusters.read', 'messages.send', 'messages.mention'],
      clusterIds: [clusterId], writeClusterIds: [clusterId] },
    { manifest: join(other, 'orrery-plugin.json'), permissions: ['messages.gate'], clusterIds: [clusterId] },
  ] }));
  app = await startTestHub({ dir, mock: { script } });
  const command = async (name: string, args: object = {}) => (await app.api('POST', '/api/plugins/reply-once-gate/invoke', { command: name, arguments: args })).result;
  try {
    // Mentions do not wake anyone yet; the plugin learns when the user allows it.
    assert.deepEqual(await command('settings'), { mentionEnabled: false, perMinute: 10, perHour: 200 });
    await app.api('PATCH', '/api/plugins/reply-once-gate/write-settings', { mentionEnabled: true });
    await waitFor(async () => (await command('settings')).mentionEnabled === true, 'the plugin saw the change');

    const kicked = await command('kickoff', { clusterId, topic: '请各回答一次' });
    assert.deepEqual([kicked.mentioned, kicked.wakes], [['A', 'B', 'C'], true], 'every visible member, the hidden one left out');
    assert.equal(app.store.getMessage(kicked.messageId)!.body, '@A @B @C 请各回答一次');
    await waitFor(() => outcomes.length === 7, 'A and C tried twice, B three times', 10_000);
    const tries = (body: string) => outcomes.filter((o) => o.body === body).map((o) => o.isError);
    assert.deepEqual(tries('回答').sort(), [false, false, true], 'B\'s first reply was refused by the other gate');
    assert.deepEqual(tries('回答（重发）'), [false], 'and did not use B\'s turn');
    assert.deepEqual(tries('再补充一句'), [true, true, true]);
    assert.match(outcomes.find((o) => o.body === '回答' && o.isError)!.text, /not yet/);
    assert.ok(outcomes.filter((o) => o.body === '再补充一句').every((o) => /这一轮你已经回复过一次/.test(o.text)));
    const said = (name: string) => app.store.listMessages(clusterId, 100).filter((m) => m.from === ids[name]).map((m) => m.body);
    assert.deepEqual([said('A'), said('B'), said('C'), said('Hidden')], [['回答'], ['回答（重发）'], ['回答'], []]);
    const count = await waitFor(async () => { const c = await command('count', { clusterId }); return c.undecided === 0 ? c : null; }, 'all checks decided');
    assert.deepEqual(count.stored, { [ids.A]: 1, [ids.B]: 1, [ids.C]: 1 }, 'exactly the stored replies');
    assert.deepEqual(count.round.sort(), [ids.A, ids.B, ids.C].sort());
  } finally { await app.close(); }
});
