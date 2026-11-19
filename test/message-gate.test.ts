// Gate plugins (messages.gate, docs/external-plugins.md「发言检查」): asked before a member's message is stored; a
// refusal leaves nothing but a rate-limited record; a plugin that does not answer lets the message through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { MockScript } from './mock.ts';
import { parseExternalManifest, readExternalPlugins } from '../src/core/external-plugin-config.ts';
import { REPO_ROOT } from '../src/main.ts';
import { Store } from '../src/core/store.ts';
import type { MessageCheckOutcome } from '../src/core/hub.ts';
import type { Message } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';

// One script for every test plugin: `mode` decides how it answers message.check, `checks` returns what it was asked,
// `events` what it observed.
const script = `
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let mode = { verdict: 'allow' }; const checks = []; const events = [];
createInterface({input:process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'event') { events.push(m.params); return; }
  if (m.method === 'initialize') return send({id:m.id,result:{apiVersion:1}});
  if (m.method === 'shutdown') return send({id:m.id,result:{}});
  if (m.method === 'invoke') {
    const a = m.params.arguments;
    if (a.mode) { mode = a.mode; return send({id:m.id,result:{}}); }
    return send({id:m.id,result: a.events ? events : checks});
  }
  if (m.method === 'message.check' && mode.verdict !== 'old') {
    checks.push(m.params);
    if (mode.verdict === 'allow') return send({id:m.id,result:{allow:true}});
    if (mode.verdict === 'refuse') return send({id:m.id,result:{allow:false,reason:mode.reason}});
    if (mode.verdict === 'hang') return;
    if (mode.verdict === 'slow') return setTimeout(() => send({id:m.id,result:{allow:true}}), mode.delay);
    if (mode.verdict === 'crash') process.exit(3);
    if (mode.verdict === 'malformed') return send({id:m.id,result:{allow:'yes'}});
  }
  send({id:m.id,error:{code:-32601,message:'Method not found'}});
});
`;

interface PluginSpec { id: string; permissions: string[]; clusterIds: string[]; events?: string[]; writeClusterIds?: string[] }

/** A seeded database (clusters of native mock members named `<cluster>-<name>`) and the plugins, granted as given. */
function setup(clusters: Record<string, string[]>, plugins: PluginSpec[]): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const seed = new Store(join(dir, 'test.db'));
  for (const [clusterId, names] of Object.entries(clusters)) {
    seed.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' },
      names.map((name) => ({ id: `${clusterId}-${name}`, clusterId, name, avatar: null, harness: 'mock', model: null, effort: null,
        workerSessionId: `${clusterId}-${name}`, cwd: dir, origin: 'attached' as const, removedAt: null })));
  }
  seed.close();
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: plugins.map((plugin) => {
    const directory = join(dir, 'plugins', plugin.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'main.mjs'), script);
    writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify({ id: plugin.id, version: '1.0.0', name: `插件${plugin.id}`, apiVersion: 1,
      entry: 'main.mjs', permissions: plugin.permissions, events: plugin.events ?? [], commands: [{ id: 'test', title: 'Test' }] }));
    return { manifest: join(directory, 'orrery-plugin.json'), permissions: plugin.permissions, clusterIds: plugin.clusterIds,
      events: plugin.events ?? [], writeClusterIds: plugin.writeClusterIds ?? [] };
  }) }));
  return dir;
}

type App = Awaited<ReturnType<typeof startTestHub>>;
const invoke = async (app: App, id: string, args: object) =>
  (await app.api('POST', `/api/plugins/${id}/invoke`, { command: 'test', arguments: args })).result;
const mode = (app: App, id: string, verdict: string, reason?: string, delay?: number) => invoke(app, id, { mode: { verdict, reason, delay } });
const checks = (app: App, id: string): Promise<any[]> => invoke(app, id, {});

/** send_message as the native member whose conversation is `session`, over MCP with the bridge secret. */
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

const fromMember = (app: App, clusterId: string, memberId: string): Message[] =>
  app.store.listMessages(clusterId, 200).filter((m) => m.from === memberId);
const records = (app: App, clusterId: string, kind: string): Message[] =>
  app.store.listMessages(clusterId, 200).filter((m) => m.systemKind === kind);
const messageEvents = (app: App, body: string) =>
  app.events.filter((e) => e.kind === 'message' && (e.payload as { message: Message }).message.body === body);

test('messages.gate is a declared permission, granted explicitly and without messages.send, and is told at initialize', () => {
  const manifest = { id: 'gate', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', commands: [] };
  assert.deepEqual(parseExternalManifest({ ...manifest, permissions: ['messages.gate'] }).permissions, ['messages.gate']);
  const dir = setup({}, [{ id: 'gate', permissions: ['messages.gate'], clusterIds: ['one'] }]);
  assert.deepEqual(readExternalPlugins(join(dir, 'home')).installations[0].permissions, ['messages.gate']);
  const ungranted = setup({}, [{ id: 'gate', permissions: [], clusterIds: ['one'] }]);
  assert.deepEqual(readExternalPlugins(join(ungranted, 'home')).installations[0].permissions, [], 'requested is not granted');
});

test('a refusal stores, delivers and announces nothing; the sender gets the code and reason; the user sees one record without the body', async () => {
  const dir = setup({ one: ['Alice', 'Bob', 'Carol'], three: ['Dan', 'Eve'] }, [
    { id: 'gate-a', permissions: ['messages.read', 'messages.gate'], clusterIds: ['one'] },
    { id: 'gate-b', permissions: ['messages.gate'], clusterIds: ['one'] },
    { id: 'outside', permissions: ['messages.read', 'messages.gate'], clusterIds: ['two'] },
    { id: 'reader', permissions: ['messages.read', 'events.read', 'messages.send'], clusterIds: ['one', 'three'], events: ['message.created'], writeClusterIds: ['one'] },
  ]);
  const app = await startTestHub({ dir });
  try {
    // Allowed by both: exactly what a send without plugins does.
    const sent = await mcpSend(app, 'one-Alice', { body: '@Bob please look', replyTo: undefined });
    assert.equal(sent.isError, false);
    assert.deepEqual(sent.data.deliveredTo, ['Bob']);
    const stored = app.store.getMessage(sent.data.messageId)!;
    assert.deepEqual([stored.from, stored.body, stored.mentions, stored.hop], ['one-Alice', '@Bob please look', ['one-Bob'], 0]);
    await waitFor(() => app.native.delivered.some((d) => d.sessionId === 'one-Bob' && d.text.includes('@Bob please look')), 'delivery to Bob');
    assert.equal(messageEvents(app, '@Bob please look').length, 1);
    await waitFor(async () => (await invoke(app, 'reader', { events: true })).some((e: any) => e.data.messageId === stored.id), 'message.created');

    // What each plugin was asked: the body only with messages.read; a plugin outside the cluster or without the grant is never asked.
    const [a] = await checks(app, 'gate-a');
    assert.match(a.checkId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(a, { checkId: a.checkId, clusterId: 'one', sender: { id: 'one-Alice', name: 'Alice' }, mentions: ['one-Bob'], recipients: ['one-Bob'],
      fyi: false, replyTo: null, attachments: 0, bodyLength: 16, body: '@Bob please look' });
    const [b] = await checks(app, 'gate-b');
    assert.equal(b.body, undefined, 'no body without messages.read');
    assert.equal(b.bodyLength, 16);
    assert.deepEqual(await checks(app, 'outside'), []);
    assert.deepEqual(await checks(app, 'reader'), []);
    const fyi = await mcpSend(app, 'one-Bob', { body: '@all noted @Carol', fyi: true, replyTo: stored.id });
    assert.equal(fyi.isError, false);
    const asked = (await checks(app, 'gate-a')).at(-1);
    assert.deepEqual([asked.mentions, asked.recipients, asked.fyi, asked.replyTo], [['one-Alice', 'one-Carol'], [], true, stored.id]);
    // A cluster no gate plugin covers waits for nothing.
    assert.equal((await mcpSend(app, 'three-Dan', { body: '@Eve unchecked' })).isError, false);
    assert.equal((await checks(app, 'gate-a')).length, 2);

    // One refusal is enough.
    await mode(app, 'gate-b', 'refuse', 'Bob 先说完。\u0007‮多余的控制字符\n' + 'x'.repeat(400));
    const delivered = app.native.delivered.length;
    const refused = await mcpSend(app, 'one-Alice', { body: '@Bob secret words', clientMessageId: 'r1' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /^REFUSED_BY_PLUGIN: 插件「插件gate-b」拒绝了这条发言：Bob 先说完。 多余的控制字符 x+。这条消息没有存进群聊/);
    assert.match(refused.text, /不要原样反复重试/);
    assert.ok(!/[\u0007‮]/.test(refused.text), 'control and format characters stripped');
    assert.ok(refused.text.length < 600, 'the reason is capped');
    assert.equal(fromMember(app, 'one', 'one-Alice').length, 1, 'not stored');
    assert.equal(messageEvents(app, '@Bob secret words').length, 0, 'no message event');
    const [record] = records(app, 'one', 'plugin_refused');
    assert.match(record.body, /^插件「插件gate-b」拒绝了 Alice 的一条发言：Bob 先说完。/);
    assert.ok(!record.body.includes('secret words'), 'the record never holds the refused text');
    assert.deepEqual([record.from, record.mentions], ['system', []]);
    assert.equal(app.store.withDeliveries([record])[0].deliveries.length, 0, 'the record wakes nobody');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.native.delivered.length, delivered, 'nothing delivered');
    const seen = await invoke(app, 'reader', { events: true });
    assert.ok(seen.some((e: any) => e.data.messageId === record.id), 'other plugins see the record');
    assert.ok(!(await invoke(app, 'gate-b', { events: true })).length);

    // Repeats from the same member inside the window are only counted; another member gets its own record.
    assert.equal((await mcpSend(app, 'one-Alice', { body: '@Bob again' })).isError, true);
    assert.equal((await mcpSend(app, 'one-Alice', { body: '@Bob and again' })).isError, true);
    assert.equal(records(app, 'one', 'plugin_refused').length, 1);
    assert.equal((await mcpSend(app, 'one-Carol', { body: 'me too' })).isError, true);
    assert.deepEqual(records(app, 'one', 'plugin_refused').map((m) => m.body.includes('Carol')), [false, true]);

    // clientMessageId: a refused key was never stored, so it is asked again; an accepted one is answered without asking.
    await mode(app, 'gate-b', 'allow');
    const before = (await checks(app, 'gate-a')).length;
    const accepted = await mcpSend(app, 'one-Alice', { body: '@Bob secret words', clientMessageId: 'r1' });
    assert.equal(accepted.isError, false);
    assert.equal(accepted.data.duplicate, undefined);
    assert.equal((await checks(app, 'gate-a')).length, before + 1);
    await mode(app, 'gate-b', 'refuse', 'no');
    const repeat = await mcpSend(app, 'one-Alice', { body: '@Bob secret words', clientMessageId: 'r1' });
    assert.deepEqual([repeat.data.messageId, repeat.data.duplicate], [accepted.data.messageId, true]);
    assert.equal((await checks(app, 'gate-a')).length, before + 1, 'the repeat of an accepted message asks nobody');

    // Not checked: the user, system records, plugin messages (including a gate plugin's own source).
    const count = (await checks(app, 'gate-a')).length;
    app.hub.sendFromUser('one', '@Alice from the user');
    assert.ok(app.hub.sendFromExternalPlugin('reader', 'one', 'from a plugin', null, false).messageId);
    assert.equal((await checks(app, 'gate-a')).length, count);
    assert.equal(records(app, 'one', 'plugin_check_failed').length, 0, 'no plugin failed');
  } finally { await app.close(); }
});

test('fail-open: timeout, crash, malformed and "method not found" let the message through, bounded in time and recorded once', async () => {
  const clusters = { hang: ['A', 'B'], crash: ['A', 'B'], malformed: ['A', 'B'], old: ['A', 'B'] };
  const dir = setup(clusters, Object.keys(clusters).map((id) => ({ id, permissions: ['messages.gate'], clusterIds: [id] })));
  const app = await startTestHub({ dir });
  try {
    for (const id of Object.keys(clusters)) await mode(app, id, id);
    // Three concurrent sends to a plugin that never answers: all return within one timeout, not one after another,
    // and three timeouts in a row stop it.
    const start = Date.now();
    const results = await Promise.all(['1', '2', '3'].map((n) => mcpSend(app, 'hang-A', { body: `@B hang ${n}` })));
    const elapsed = Date.now() - start;
    assert.ok(results.every((r) => !r.isError), JSON.stringify(results));
    assert.ok(elapsed >= 1400 && elapsed < 2800, `bounded by the 1.5 s timeout: ${elapsed} ms`);
    assert.equal(fromMember(app, 'hang', 'hang-A').length, 3);
    const quick = Date.now();
    assert.equal((await mcpSend(app, 'hang-A', { body: '@B after the timeout' })).isError, false);
    assert.ok(Date.now() - quick < 1000, 'a stopped plugin is not waited for');
    for (const [clusterId, text] of [['crash', '插件进程退出了'], ['malformed', '插件的回答格式不对'], ['old', '可能不支持 message.check']]) {
      const sent = await mcpSend(app, `${clusterId}-A`, { body: `@B ${clusterId}` });
      assert.equal(sent.isError, false, clusterId);
      assert.equal(fromMember(app, clusterId, `${clusterId}-A`).length, 1);
      const [record] = records(app, clusterId, 'plugin_check_failed');
      assert.match(record.body, new RegExp(`插件「插件${clusterId}」没有完成发言检查（.*${text}.*），这一次该插件未拦截 A 的发言`));
    }
    // One record per plugin and cluster in the window, however many sends went through, and one saying it was stopped.
    const hang = records(app, 'hang', 'plugin_check_failed').map((m) => m.body);
    assert.equal(hang.length, 2, hang.join('\n'));
    assert.match(hang[0], /没有在时限内回答；插件仍在运行/);
    assert.match(hang[1], /连续 3 次没有在时限内回答，插件已被停止；在它重新启动之前不再检查发言/);
    const plugins = (await app.api('GET', '/api/plugins')).installed;
    assert.equal(plugins.find((p: any) => p.id === 'hang').runtime.errorCode, 'CHECK_TIMEOUT');
    assert.equal(plugins.find((p: any) => p.id === 'old').runtime.state, 'ready', 'an error answer does not stop the plugin');
  } finally { await app.close(); }
});

test('one late answer lets that message through and keeps the plugin: the late answer is dropped, the next check is answered', async () => {
  const dir = setup({ one: ['A', 'B'] }, [{ id: 'gate', permissions: ['messages.gate'], clusterIds: ['one'] }]);
  const app = await startTestHub({ dir });
  const state = async () => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'gate').runtime;
  try {
    await mode(app, 'gate', 'slow', undefined, 1800);
    const start = Date.now();
    const late = await mcpSend(app, 'one-A', { body: '@B late' });
    assert.equal(late.isError, false);
    assert.ok(Date.now() - start < 1900, 'the send did not wait for the late answer');
    assert.match(records(app, 'one', 'plugin_check_failed')[0].body, /插件仍在运行，下一条发言照常检查/);
    await mode(app, 'gate', 'refuse', 'in time');
    await new Promise((r) => setTimeout(r, 500));   // the late answer arrives meanwhile and is dropped
    assert.deepEqual(await state(), { state: 'ready', error: null, errorCode: null });
    const answered = await mcpSend(app, 'one-A', { body: '@B in time' });
    assert.match(answered.text, /^REFUSED_BY_PLUGIN: .*in time/, 'the next check got its own answer');
    assert.equal((await checks(app, 'gate')).length, 2);
    assert.equal((await state()).state, 'ready');
  } finally { await app.close(); }
});

test('an answer in time resets the timeout count, and expired checks do not hold the 16 pending slots', async () => {
  const dir = setup({ one: ['A', 'B'] }, [{ id: 'gate', permissions: ['messages.gate'], clusterIds: ['one'] }]);
  const app = await startTestHub({ dir });
  const state = async () => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'gate').runtime.state;
  const late = () => Promise.all([1, 2].map((n) => mcpSend(app, 'one-A', { body: `late ${n}` })));
  try {
    // 2 timeouts, an answer in time, 2 more: never 3 in a row. The late answers come and are dropped.
    for (let round = 0; round < 3; round++) {
      await mode(app, 'gate', 'slow', undefined, 1600);
      assert.ok((await late()).every((r) => !r.isError));
      await mode(app, 'gate', 'allow');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await mcpSend(app, 'one-A', { body: `in time ${round}` })).isError, false);
      assert.equal(await state(), 'ready');
    }
    const asked = (await checks(app, 'gate')).length;
    const many = await Promise.all(Array.from({ length: 16 }, (_, n) => mcpSend(app, 'one-A', { body: `together ${n}` })));
    assert.ok(many.every((r) => !r.isError));
    assert.equal((await checks(app, 'gate')).length, asked + 16, 'all 16 were asked: no pending slot leaked');
    assert.ok(!records(app, 'one', 'plugin_check_failed').some((m) => /收不下/.test(m.body)));
    // Now 3 in a row: stopped, and later sends do not wait.
    await mode(app, 'gate', 'hang');
    await Promise.all([1, 2, 3].map((n) => mcpSend(app, 'one-A', { body: `hang ${n}` })));
    assert.equal(await state(), 'failed');
    const start = Date.now();
    assert.equal((await mcpSend(app, 'one-A', { body: 'after' })).isError, false);
    assert.ok(Date.now() - start < 1000);
  } finally { await app.close(); }
});

test('records collapse repeats inside the window and the next one says how many', async (t) => {
  const dir = setup({ one: ['A', 'B'] }, [{ id: 'gate', permissions: ['messages.gate'], clusterIds: ['one'] }]);
  const app = await startTestHub({ dir });
  try {
    await mode(app, 'gate', 'refuse', 'wait');
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (let i = 0; i < 4; i++) assert.equal((await mcpSend(app, 'one-A', { body: `try ${i}` })).isError, true);
    assert.equal(records(app, 'one', 'plugin_refused').length, 1);
    t.mock.timers.tick(60_000);
    assert.equal((await mcpSend(app, 'one-A', { body: 'later' })).isError, true);
    const [, second] = records(app, 'one', 'plugin_refused');
    assert.match(second.body, /1 分钟内另有 3 条被拒绝的发言，没有单独记录/);
  } finally { await app.close(); }
});

test('the Hub refuses first: hop limit, pause and hourly turns behave as before with an allow-all gate installed', async () => {
  const dir = setup({ one: ['A', 'B'] }, [{ id: 'gate', permissions: ['messages.gate'], clusterIds: ['one'] }]);
  const app = await startTestHub({ dir, limits: { maxHops: 1, maxTurnsPerHour: 1 } });
  try {
    app.hub.sendFromUser('one', '@A start');
    await waitFor(() => app.native.delivered.some((d) => d.sessionId === 'one-A'), 'A got the user message');
    const first = await mcpSend(app, 'one-A', { body: '@B hop one' });
    assert.equal(app.store.getMessage(first.data.messageId)!.hop, 1);
    await waitFor(() => app.native.delivered.some((d) => d.sessionId === 'one-B'), 'B got hop 1');
    const asked = (await checks(app, 'gate')).length;
    const tooFar = await mcpSend(app, 'one-B', { body: '@A hop two' });
    assert.match(tooFar.text, /hop 2 exceeds the limit of 1/);
    assert.equal((await checks(app, 'gate')).length, asked, 'a message the Hub refuses itself is never shown to the plugin');
    assert.equal(app.events.filter((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_hops').length, 1);

    // The pause holds a checked message's delivery, and B (one turn this hour) stays guarded afterwards, as without a gate.
    app.hub.setPaused(true);
    const paused = await mcpSend(app, 'one-A', { body: '@B during the pause' });
    assert.equal(paused.isError, false);
    assert.equal((await checks(app, 'gate')).length, asked + 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.native.delivered.filter((d) => d.text.includes('during the pause')).length, 0, 'the pause holds the delivery');
    app.hub.setPaused(false);
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_turns_per_hour'), 'hourly guard');
    assert.equal(app.native.delivered.filter((d) => d.text.includes('during the pause')).length, 0, 'the hourly limit holds it');
  } finally { await app.close(); }
});

test('a replies member (its answer becomes its message) goes through the same check', async () => {
  const dir = setup({ one: ['A', 'B'] }, [{ id: 'gate', permissions: ['messages.gate'], clusterIds: ['one'] }]);
  const native = createMockNativeAdapter({ onDeliver: async (_session, _text, ctx) => { ctx.reply?.('@B the answer'); return 'completed'; } });
  (native as { replies?: boolean }).replies = true;
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    await mode(app, 'gate', 'refuse', 'not now');
    app.hub.sendFromUser('one', '@A question');
    await waitFor(() => records(app, 'one', 'plugin_refused').length, 'refusal record');
    assert.equal(fromMember(app, 'one', 'one-A').length, 0);
    await mode(app, 'gate', 'allow');
    app.hub.sendFromUser('one', '@A question two');
    const [answer] = await waitFor(() => { const said = fromMember(app, 'one', 'one-A'); return said.length ? said : null; }, 'answer posted');
    assert.equal(answer.body, '@B the answer');
    // The refused answer is told to the member in its next envelope, as other rejected answers are.
    assert.match(native.delivered.find((d) => d.text.includes('question two'))!.text, /拒绝了这条发言：not now/);
  } finally { await app.close(); }
});

test('a pending native MCP send cannot follow a rebind, and its copied attachments are discarded', async () => {
  const dir = tempDir();
  const native = createMockNativeAdapter({ sessions: ['old-session', 'new-session'].map((id) =>
    ({ id, title: id, model: null, cwd: dir, updatedAt: null })) });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  const verdict = Promise.withResolvers<MessageCheckOutcome[]>();
  let asked = false;
  app.hub.setMessageGate({ checkMessage() { asked = true; return verdict.promise; } });
  try {
    const { cluster, members: [a] } = await app.hub.createCluster('binding', [{ harness: 'mock', mode: 'native', sessionId: 'old-session', name: 'A' }]);
    const outbox = join(app.home, 'outbox', a.id);
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'note.txt'), 'kept in the old sender outbox');
    const pending = mcpSend(app, 'old-session', { body: 'old conversation words', attachments: ['note.txt'] });
    await waitFor(() => asked, 'the old caller waiting for its check');
    await app.hub.rebindMember(a.id, { harness: 'mock', sessionId: 'new-session', confirmStopped: true });
    assert.equal(app.hub.nativeCallers('mock', 'old-session').length, 0);
    verdict.resolve([{ pluginId: 'gate', name: 'gate', verdict: 'allow' }]);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.text, /sender conversation changed/);
    assert.deepEqual(fromMember(app, cluster.id, a.id), []);
    assert.equal(messageEvents(app, 'old conversation words').length, 0);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM files').get()!.n, 0);
    assert.deepEqual(readdirSync(join(app.home, 'files')), []);
    assert.equal(readFileSync(join(outbox, 'note.txt'), 'utf8'), 'kept in the old sender outbox');
  } finally { verdict.resolve([]); await app.close(); }
});

test('late native replies retain their original chain and never suppress a later turn', async () => {
  const dir = setup({ one: ['A'] }, []);
  const secondTurn = Promise.withResolvers<void>();
  let started = 0;
  const native = createMockNativeAdapter({ onDeliver: async (_session, _text, ctx) => {
    const turn = ++started;
    if (turn === 2) await secondTurn.promise;
    ctx.reply?.(turn === 1 ? 'first answer' : 'second answer');
    return 'completed';
  } });
  (native as { replies?: boolean }).replies = true;
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  const checks: ReturnType<typeof Promise.withResolvers<MessageCheckOutcome[]>>[] = [];
  app.hub.setMessageGate({ checkMessage() { const check = Promise.withResolvers<MessageCheckOutcome[]>(); checks.push(check); return check.promise; } });
  try {
    const first = app.hub.sendFromUser('one', '@A first');
    await waitFor(() => checks.length === 1 && app.hub.listMembers('one')[0].status === 'idle', 'first turn ended while its reply is checked');
    const second = app.hub.sendFromUser('one', '@A second');
    await waitFor(() => started === 2, 'second turn started');
    checks[0].resolve([{ pluginId: 'gate', name: 'gate', verdict: 'allow' }]);
    const [answer] = await waitFor(() => { const said = fromMember(app, 'one', 'one-A'); return said.length ? said : null; }, 'first reply committed');
    assert.deepEqual([answer.replyTo, answer.chainId, answer.hop], [first.id, first.chainId, first.hop + 1]);
    secondTurn.resolve();
    await waitFor(() => checks.length === 2, 'second reply was not suppressed');
    checks[1].resolve([{ pluginId: 'gate', name: 'gate', verdict: 'allow' }]);
    await waitFor(() => fromMember(app, 'one', 'one-A').length === 2, 'second reply committed');
    const later = fromMember(app, 'one', 'one-A').find((message) => message.body === 'second answer')!;
    assert.deepEqual([later.replyTo, later.chainId, later.hop], [second.id, second.chainId, second.hop + 1]);
  } finally { secondTurn.resolve(); checks.forEach((check) => check.resolve([])); await app.close(); }
});

test('a concurrent accepted idempotency key wins over a later gate refusal', async () => {
  const dir = setup({ one: ['A'] }, []);
  const app = await startTestHub({ dir });
  const checks: ReturnType<typeof Promise.withResolvers<MessageCheckOutcome[]>>[] = [];
  app.hub.setMessageGate({ checkMessage() { const check = Promise.withResolvers<MessageCheckOutcome[]>(); checks.push(check); return check.promise; } });
  try {
    const first = app.hub.sendFromMemberGated('one-A', 'same words', undefined, [], undefined, undefined, 'same-key');
    const retry = app.hub.sendFromMemberGated('one-A', 'same words', undefined, [], undefined, undefined, 'same-key');
    checks[0].resolve([{ pluginId: 'gate', name: 'gate', verdict: 'allow' }]);
    const accepted = await first;
    checks[1].resolve([{ pluginId: 'gate', name: 'gate', verdict: 'refuse', reason: 'already spoke' }]);
    const repeated = await retry;
    assert.deepEqual([repeated.message.id, repeated.duplicate], [accepted.message.id, true]);
    assert.equal(fromMember(app, 'one', 'one-A').length, 1);
    assert.equal(messageEvents(app, 'same words').length, 1);
    assert.deepEqual(records(app, 'one', 'plugin_refused'), []);
  } finally { checks.forEach((check) => check.resolve([])); await app.close(); }
});

test('a failed checker does not claim the send succeeded when another checker refuses it', async () => {
  const dir = setup({ one: ['A'] }, []);
  const app = await startTestHub({ dir });
  app.hub.setMessageGate({ checkMessage() { return Promise.resolve([
    { pluginId: 'late', name: 'late', verdict: 'failed', failure: 'timeout' },
    { pluginId: 'judge', name: 'judge', verdict: 'refuse', reason: 'no' },
  ]); } });
  try {
    await assert.rejects(app.hub.sendFromMemberGated('one-A', 'refused words'), /REFUSED|拒绝/);
    assert.deepEqual(fromMember(app, 'one', 'one-A'), []);
    const [record] = records(app, 'one', 'plugin_check_failed');
    assert.match(record.body, /该插件未拦截 A 的发言；最终结果仍以其他检查为准/);
    assert.doesNotMatch(record.body, /已照常放行/);
    assert.equal(records(app, 'one', 'plugin_refused').length, 1);
  } finally { await app.close(); }
});

test('example referee: after the lead speaks, every other member may reply once (three mock members)', async () => {
  const outcomes: { body: string; isError: boolean; text: string }[] = [];
  const script: MockScript = async (msg, tools) => {
    const say = async (body: string) => outcomes.push({ body, ...(await tools.send(body)) });
    const body = msg.body.replace(/^(@\S+\s+)+/, '').trim();
    if (body === 'ask') await say('@A @B 请各回答一次');
    else if (body === 'speak first') await say('@Lead 我先说');
    else if (body === '请各回答一次') { await say('@Lead 回答'); await say('@Lead 再补充一句'); }
  };
  const dir = tempDir();
  let app = await startTestHub({ dir, mock: { script } });
  let clusterId: string;
  let ids: Record<string, string>;
  try {
    const { cluster, members } = await app.cluster('referee', ['Lead', 'A', 'B']);
    clusterId = cluster.id;
    ids = Object.fromEntries(members.map((m: any) => [m.name, m.id]));
  } finally { await app.close(); }
  const plugin = join(dir, 'reply-once-gate');
  cpSync(join(REPO_ROOT, 'test', 'fixtures', 'reply-once-gate'), plugin, { recursive: true });
  writeFileSync(join(plugin, 'lead.json'), JSON.stringify({ lead: 'Lead' }));
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: [
    { manifest: join(plugin, 'orrery-plugin.json'), permissions: ['messages.gate'], clusterIds: [clusterId] }] }));
  app = await startTestHub({ dir, mock: { script } });
  try {
    app.hub.sendFromUser(clusterId, '@A speak first');
    await waitFor(() => outcomes.length === 1, 'A tried to speak first');
    assert.equal(outcomes[0].isError, true, 'refused: the lead has not spoken');
    assert.match(outcomes[0].text, /REFUSED_BY_PLUGIN: 插件「一问一答裁判（测试用）」拒绝了这条发言：Lead 还没有发言/);

    app.hub.sendFromUser(clusterId, '@Lead ask');
    await waitFor(() => outcomes.length === 6, 'the lead asked, both answered twice', 10_000);
    const byBody = (body: string) => outcomes.filter((o) => o.body === body).map((o) => o.isError);
    assert.deepEqual(byBody('@A @B 请各回答一次'), [false]);
    assert.deepEqual(byBody('@Lead 回答'), [false, false]);
    assert.deepEqual(byBody('@Lead 再补充一句'), [true, true]);
    assert.ok(outcomes.filter((o) => o.isError).slice(1).every((o) => /这一轮你已经回复过一次/.test(o.text)));
    const said = (name: string) => fromMember(app, clusterId, ids[name]).map((m) => m.body);
    assert.deepEqual([said('Lead'), said('A'), said('B')], [['@A @B 请各回答一次'], ['@Lead 回答'], ['@Lead 回答']]);
    // A was refused twice within a minute: one record, the repeat counted; B has its own.
    const refusals = records(app, clusterId, 'plugin_refused').map((m) => m.body);
    assert.equal(refusals.length, 2, refusals.join('\n'));
    assert.ok(refusals.some((b) => b.includes(' A 的一条发言')) && refusals.some((b) => b.includes(' B 的一条发言')));
  } finally { await app.close(); }
});

test('every member write path in src goes through the gate: only the Hub itself calls the unchecked sendFromMember', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|js|mjs)$/.test(entry.name) && path !== join(REPO_ROOT, 'src', 'core', 'hub.ts')
        && /\.sendFromMember\(/.test(readFileSync(path, 'utf8'))) offenders.push(path);
    }
  };
  walk(join(REPO_ROOT, 'src'));
  assert.deepEqual(offenders, []);
  const hub = readFileSync(join(REPO_ROOT, 'src', 'core', 'hub.ts'), 'utf8');
  assert.deepEqual([...hub.matchAll(/this\.sendFromMember(Gated)?\(/g)].map((m) => m[0]), ['this.sendFromMemberGated(']);
});
