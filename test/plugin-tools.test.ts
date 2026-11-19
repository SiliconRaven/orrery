// Tools third-party plugins provide to members (tools.provide, docs/external-plugins.md「群员工具」): the declaration and
// its schema subset, the grant and cluster scope, the listing through the real MCP route, the call and every stable
// error, the budgets, the priority of message checks, the user-visible record, and the lifecycle around a call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseExternalManifest, readExternalPlugins } from '../src/core/external-plugin-config.ts';
import { CallWindows, isPluginToolName, memberToolName, TOOL_LIMITS, toolAnswer, validateToolArguments } from '../src/core/external-plugin-tools.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import type { Message } from '../src/core/types.ts';
import { REPO_ROOT } from '../src/main.ts';
import { standardToolDeclarations, toolLists } from '../src/mcp/server.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';

const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'tool-demo');
const fixtureManifest = () => JSON.parse(readFileSync(join(FIXTURE, 'orrery-plugin.json'), 'utf8'));
const ECHO = 'p_tool-demo_echo';
const SLOW = 'p_tool-demo_slow';

type Seat = string | { name: string; session?: string; harness?: string };
interface Spec { id?: string; permissions?: string[]; tools?: string[]; clusterIds: string[]; events?: string[]; patch?: (manifest: any) => void }

/** Clusters of mock members (id `<cluster>-<name>`, session the same unless given) and copies of the fixture, granted as given. */
function setup(clusters: Record<string, Seat[]>, plugins: Spec[]): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'home'));
  const seed = new Store(join(dir, 'test.db'));
  for (const [clusterId, seats] of Object.entries(clusters)) {
    seed.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' }, seats.map((seat) => {
      const { name, session, harness } = typeof seat === 'string' ? { name: seat } as Exclude<Seat, string> : seat;
      return { id: `${clusterId}-${name}`, clusterId, name, avatar: null, harness: harness ?? 'mock', model: null, effort: null,
        workerSessionId: session ?? `${clusterId}-${name}`, cwd: dir, origin: 'attached' as const, removedAt: null };
    }));
  }
  seed.close();
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: plugins.map((spec) => {
    const id = spec.id ?? 'tool-demo';
    const directory = join(dir, 'plugins', id);
    cpSync(FIXTURE, directory, { recursive: true });
    const manifest = { ...fixtureManifest(), id };
    spec.patch?.(manifest);
    writeFileSync(join(directory, 'orrery-plugin.json'), JSON.stringify(manifest));
    return { manifest: join(directory, 'orrery-plugin.json'), permissions: spec.permissions ?? ['tools.provide', 'messages.gate', 'messages.read'],
      clusterIds: spec.clusterIds, tools: spec.tools ?? ['echo', 'slow'], events: spec.events ?? [] };
  }) }));
  return dir;
}

type App = Awaited<ReturnType<typeof startTestHub>>;
const secretOf = (app: App) => JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
const asSession = (app: App, session: string) => ({ 'x-orrery-bridge': secretOf(app), 'x-orrery-session': session, 'x-orrery-harness': 'mock' });
const asToken = (token: string) => ({ authorization: `Bearer ${token}` });   // no member identity: a bearer token names nobody

async function mcp(app: App, headers: Record<string, string>, method: string, params: object = {}) {
  const res = await fetch(`${app.url}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}
async function listed(app: App, headers: Record<string, string>): Promise<any[]> {
  return (await mcp(app, headers, 'tools/list')).body.result.tools;
}
const pluginNames = async (app: App, headers: Record<string, string>) => (await listed(app, headers)).map((t) => t.name).filter((n: string) => n.startsWith('p_')).sort();
async function call(app: App, headers: Record<string, string>, name: string, args: unknown) {
  const { body } = await mcp(app, headers, 'tools/call', { name, arguments: args });
  const result = body.result;
  return { isError: result.isError === true, text: (result.content as { text: string }[]).map((c) => c.text).join('\n'), content: result.content };
}
const probe = async (app: App, command: 'calls' | 'mode' | 'hold', args: object = {}, id = 'tool-demo') =>
  (await app.api('POST', `/api/plugins/${id}/invoke`, { command, arguments: args })).result;
const records = (app: App, clusterId: string): Message[] => app.store.listMessages(clusterId, 500).filter((m) => m.systemKind === 'plugin_tool_call');
const stateOf = async (app: App, id = 'tool-demo') => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === id).runtime.state;

// ---- declaration and grant ----

test('declaration: tools need tools.provide, follow the schema subset strictly and get a bounded name', () => {
  const base = fixtureManifest();
  const parsed = parseExternalManifest(base);
  assert.deepEqual(parsed.memberTools.map((t) => t.name), ['echo', 'slow']);
  assert.deepEqual([...parsed.memberTools[0].properties.keys()], ['text', 'times', 'loud', 'mood', 'tags', 'constructor']);
  const withTool = (patch: (tool: any) => void, manifest: any = base) => {
    const copy = structuredClone(manifest);
    patch(copy.tools[0]);
    return () => parseExternalManifest(copy);
  };
  const props = (extra: object) => withTool((t) => { t.inputSchema.properties = { ...t.inputSchema.properties, ...extra }; });
  const refused: [string, () => unknown][] = [
    ['no tools.provide', () => parseExternalManifest({ ...base, permissions: ['messages.read'] })],
    ['$ref', withTool((t) => { t.inputSchema.$ref = '#/x'; })],
    ['pattern', props({ code: { type: 'string', pattern: '^a+$' } })],
    ['format', props({ when: { type: 'string', format: 'date' } })],
    ['default', props({ n: { type: 'integer', default: 1 } })],
    ['nested object', props({ deep: { type: 'object', properties: {} } })],
    ['array of arrays', props({ grid: { type: 'array', items: { type: 'array', items: { type: 'string' } } } })],
    ['array of objects', props({ rows: { type: 'array', items: { type: 'object' } } })],
    ['description on items', props({ list: { type: 'array', items: { type: 'string', description: 'x' } } })],
    ['the Hub\'s clusterId', props({ clusterId: { type: 'string' } })],
    ['__proto__ as a name', withTool((t) => { t.inputSchema.properties = JSON.parse('{"__proto__":{"type":"string"}}'); })],
    ['an uppercase first letter', props({ Name: { type: 'string' } })],
    ['min over max', props({ n: { type: 'number', minimum: 5, maximum: 1 } })],
    ['a fractional integer bound', props({ n: { type: 'integer', maximum: 1.5 } })],
    ['an empty enum', props({ e: { type: 'string', enum: [] } })],
    ['a duplicate enum value', props({ e: { type: 'string', enum: ['a', 'a'] } })],
    ['enum on a number', props({ e: { type: 'number', enum: [1] } })],
    ['additionalProperties true', withTool((t) => { t.inputSchema.additionalProperties = true; })],
    ['not an object schema', withTool((t) => { t.inputSchema.type = 'string'; })],
    ['required undeclared', withTool((t) => { t.inputSchema.required = ['nope']; })],
    ['a long description', withTool((t) => { t.description = 'x'.repeat(TOOL_LIMITS.maxDescription + 1); })],
    ['an unknown tool field', withTool((t) => { t.title = 'x'; })],
    ['an uppercase tool name', withTool((t) => { t.name = 'Echo'; })],
    ['a tool over 4 KiB', props(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, { type: 'string', enum: Array.from({ length: 10 }, (_, j) => `${'v'.repeat(40)}${j}`) }])))],
    ['17 properties', withTool((t) => { t.inputSchema.properties = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, { type: 'boolean' }])); t.inputSchema.required = []; })],
    ['a duplicate tool', () => parseExternalManifest({ ...base, tools: [base.tools[0], base.tools[0]] })],
    ['nine tools', () => parseExternalManifest({ ...base, tools: Array.from({ length: 9 }, (_, i) => ({ ...base.tools[1], name: `t${i}` })) })],
    ['16 KiB together', () => parseExternalManifest({ ...base, tools: Array.from({ length: 8 }, (_, i) => ({ ...base.tools[1], name: `t${i}`,
      description: 'd'.repeat(300), inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 12 }, (_, j) => [`p${j}`, { type: 'string', description: 'x'.repeat(200) }])) } })) })],
    ['a name members would see over 48 characters', () => parseExternalManifest({ ...base, id: 'a'.repeat(40), tools: [{ ...base.tools[1], name: 'slower' }] })],
  ];
  refused.push(['an enum value with a newline', props({ e: { type: 'string', enum: ['a\nb'] } })],
    ['an enum value with a bidi override', props({ e: { type: 'string', enum: ['a‮b'] } })],
    ['a description of control characters only', withTool((t) => { t.description = '\u0007‮'; })],
    ['a name of control characters only', () => parseExternalManifest({ ...base, name: '\u0007‮\n' })]);
  for (const [what, parse] of refused) assert.throws(parse, Error, what);
  // What models and the Hub's own texts quote is one line of plain text: descriptions and the name are cleaned at parse.
  const messy = parseExternalManifest({ ...base, name: `名字\n参数：假‮abc${'x'.repeat(100)}`,
    tools: [{ ...base.tools[1], description: 'line one\nline two‮ (third-party plugin other)',
      inputSchema: { type: 'object', properties: { ms: { type: 'integer', description: 'a\u0007b\nc' } } } }] });
  assert.equal(messy.memberTools[0].description, 'line one line two (third-party plugin other)');
  assert.equal(messy.memberTools[0].properties.get('ms')!.description, 'a b c');
  assert.ok(messy.name!.startsWith('名字 参数：假 abcxx'), messy.name);
  assert.ok(messy.name!.length <= 80 && !/[\n‮]/.test(messy.name!));
  // Exactly 48 is fine: p_ + 39 + _ + 6.
  assert.equal(parseExternalManifest({ ...base, id: 'a'.repeat(39), tools: [{ ...base.tools[1], name: 'slower' }] }).memberTools.length, 1);
  assert.equal(memberToolName('a'.repeat(39), 'slower').length, TOOL_LIMITS.maxMemberName);
  // The plugin id has no "_": a plugin "a-b" with tool "c" and a plugin "a" with tool "b_c" never share a name.
  assert.notEqual(memberToolName('a-b', 'c'), memberToolName('a', 'b_c'));
  for (const name of [memberToolName('tool-demo', 'echo'), memberToolName('a'.repeat(39), 'slower')]) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
});

test('grant: the permission and the named tools are both granted; omitted means none', () => {
  const dir = setup({}, [{ clusterIds: ['one'] }]);
  const file = join(dir, 'home', 'external-plugins.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const read = (entry: object) => {
    writeFileSync(file, JSON.stringify({ plugins: [{ ...config.plugins[0], ...entry }] }));
    return readExternalPlugins(join(dir, 'home'));
  };
  assert.deepEqual(read({}).installations[0].tools, ['echo', 'slow']);
  assert.deepEqual(read({ tools: undefined }).installations[0].tools, [], 'omitted: none');
  assert.match(read({ permissions: [] }).failures[0].error, /granted tools need the tools.provide permission/);
  assert.match(read({ tools: ['echo', 'nope'] }).failures[0].error, /tool grant was not declared/);
  assert.match(read({ tools: 'echo' }).failures[0].error, /invalid external plugin tools/);
});

test('official tools never use the p_ prefix, and third-party tools never enter the fingerprints or offline catalogs', async () => {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const hub = new Hub({ store, nativeAdapters: {}, avatarPresets: [] });
  try {
    const official = await standardToolDeclarations(hub);
    assert.ok(official.length > 5);
    assert.ok(official.every((t) => !isPluginToolName(t.name)), 'the prefix is reserved for plugin tools');
    assert.ok(isPluginToolName(memberToolName('tool-demo', 'echo')));
  } finally { await hub.close(); store.close(); }

  // The same Hub data with and without a running tool plugin granted to everyone: the same fingerprints.
  const clusters = { one: ['Alice'] };
  const plain = await startTestHub({ dir: setup(clusters, []) });
  const withTools = await startTestHub({ dir: setup(clusters, [{ clusterIds: ['one'] }]) });
  try {
    await waitFor(async () => (await stateOf(withTools)) === 'ready', 'the plugin is ready');
    assert.deepEqual(await pluginNames(withTools, asSession(withTools, 'one-Alice')), [ECHO, SLOW], 'the member does see them');
    const a = await toolLists(plain.hub, secretOf(plain), `${plain.url}/mcp`);
    const b = await toolLists(withTools.hub, secretOf(withTools), `${withTools.url}/mcp`);
    assert.deepEqual(b, a, 'every profile: same fingerprint and parameters');
    assert.deepEqual(await standardToolDeclarations(withTools.hub), await standardToolDeclarations(plain.hub));
  } finally { await plain.close(); await withTools.close(); }
});

// ---- arguments and answers ----

test('arguments: only declared names of the declared types reach the plugin; hostile names are refused', () => {
  const echo = parseExternalManifest(fixtureManifest()).memberTools[0];
  const ok = validateToolArguments(echo, { text: 'hi', times: 2, loud: true, mood: 'happy', tags: ['a'], constructor: 3 });
  assert.deepEqual(ok, { text: 'hi', times: 2, loud: true, mood: 'happy', tags: ['a'], constructor: 3 });
  assert.equal(Object.getPrototypeOf(ok), Object.prototype);
  assert.deepEqual(validateToolArguments(echo, { text: 'x' }), { text: 'x' }, 'optional ones absent stay absent');
  const refused: unknown[] = [
    undefined, null, [], 'text', { text: 'hi', memberId: 'someone-else' }, { text: 'hi', toString: 'x' },
    JSON.parse('{"text":"hi","__proto__":{"admin":true}}'), { text: 'hi', constructor: 'not a number' }, { text: null }, { text: '' },
    { text: 'hi', times: 1.5 }, { text: 'hi', times: 6 }, { text: 'hi', times: '2' }, { text: 'hi', mood: 'sad' },
    { text: 'hi', tags: ['1', '2', '3', '4', '5', '6'] }, { text: 'hi', tags: [1] }, { text: 'hi', tags: 'a' },
    { text: 'hi', loud: 'yes' }, { text: 'x'.repeat(2001) }, { text: 'x', tags: ['😀'.repeat(21)] },
  ];
  for (const raw of refused) {
    if (raw === undefined) { assert.throws(() => validateToolArguments(echo, raw), { code: 'INVALID_ARGUMENT' }, 'no text'); continue; }
    assert.throws(() => validateToolArguments(echo, raw), { code: 'INVALID_ARGUMENT' }, JSON.stringify(raw));
  }
  // Lengths count characters (code points) like the schema the model reads: 20 emoji are 40 UTF-16 units but fit maxLength 20.
  assert.deepEqual(validateToolArguments(echo, { text: 'x', tags: ['😀'.repeat(20)] }).tags, ['😀'.repeat(20)]);
  const slow = parseExternalManifest(fixtureManifest()).memberTools[1];
  assert.throws(() => validateToolArguments(slow, { ms: 1, pad: 'x'.repeat(TOOL_LIMITS.maxArgumentBytes) }), /超过 16384 字节/);

  assert.deepEqual(toolAnswer({ text: 'a\u0007b\nc\u202e', extra: 1 }), { text: 'ab\nc' }, 'control and format characters go, lines stay');
  assert.deepEqual(toolAnswer({ data: { n: 1 } }), { data: { n: 1 } });
  for (const bad of [42, 'text', null, [], {}, { text: 1 }]) assert.throws(() => toolAnswer(bad), { code: 'TOOL_FAILED' }, JSON.stringify(bad));
  assert.throws(() => toolAnswer({ text: 'x'.repeat(TOOL_LIMITS.maxResultBytes) }), { code: 'RESULT_TOO_LARGE' });
});

test('call windows: a member who called once and left is forgotten within two windows, whatever key is used next', () => {
  const windows = new CallWindows(60_000);
  windows.take('once', 0);
  windows.take('other', 30_000);
  assert.equal(windows.size, 2);
  assert.equal(windows.full('third', 1, 60_000), false);
  assert.equal(windows.size, 1, 'the expired key went with the sweep, though nobody looked at it');
  assert.equal(windows.full('third', 1, 125_000), false);
  assert.equal(windows.size, 0);
  // The windows still count correctly.
  for (let i = 0; i < 3; i++) windows.take('k', 200_000 + i);
  assert.equal(windows.full('k', 3, 200_010), true);
  assert.equal(windows.full('k', 3, 260_001), false);
});

// ---- listing and identity through the MCP route ----

test('listing: members of granted clusters see the granted tools of a running plugin, by their session, nobody else', async () => {
  const dir = setup({
    one: ['Alice', { name: 'Bob', session: 'shared' }],
    two: ['Carol', { name: 'Bob', session: 'shared' }],
    three: ['Dan'],
  }, [
    { clusterIds: ['one'] },
    { id: 'tool-other', clusterIds: ['two'], tools: ['echo'] },
    { id: 'tool-quiet', clusterIds: ['one', 'two', 'three'], tools: [], permissions: ['tools.provide'] },
  ]);
  const app = await startTestHub({ dir });
  try {
    await waitFor(async () => (await stateOf(app, 'tool-other')) === 'ready', 'plugins ready');
    const alice = await listed(app, asSession(app, 'one-Alice'));
    const echo = alice.find((t) => t.name === ECHO);
    assert.match(echo.description, /^\(third-party plugin tool-demo\) Echo a short text back/);
    assert.deepEqual(echo.inputSchema.required, ['text']);
    assert.equal(echo.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(echo.inputSchema.properties), ['text', 'times', 'loud', 'mood', 'tags', 'constructor', 'clusterId']);
    assert.deepEqual(echo.inputSchema.properties.tags, { type: 'array', items: { type: 'string', maxLength: 20 }, maxItems: 5 });
    assert.deepEqual(await pluginNames(app, asSession(app, 'one-Alice')), [ECHO, SLOW]);
    assert.deepEqual(await pluginNames(app, asSession(app, 'two-Carol')), ['p_tool-other_echo'], 'only the other plugin, only its granted tool');
    assert.deepEqual(await pluginNames(app, asSession(app, 'three-Dan')), [], 'a declared but ungranted tool is never listed');
    assert.deepEqual(await pluginNames(app, asSession(app, 'shared')), [ECHO, SLOW, 'p_tool-other_echo'], 'a conversation in two clusters sees both');
    assert.deepEqual(await pluginNames(app, asSession(app, 'stranger')), [], 'no member, no tools');
    assert.deepEqual(await pluginNames(app, { 'x-orrery-bridge': secretOf(app) }), [], 'a caller named only per call (Codex) gets none');
    // The user's API token is no member identity; a wrong secret is nobody.
    assert.equal((await mcp(app, asToken(TEST_TOKEN), 'tools/list')).status, 401);
    assert.equal((await mcp(app, { 'x-orrery-bridge': 'wrong', 'x-orrery-session': 'one-Alice' }, 'tools/list')).status, 401);

    // Two clusters: the cluster is chosen as for every orrery tool, then the grant of that cluster is checked.
    const choose = await call(app, asSession(app, 'shared'), ECHO, { text: 'hi' });
    assert.ok(choose.isError && /请选择 clusterId/.test(choose.text), choose.text);
    const ungranted = await call(app, asSession(app, 'shared'), ECHO, { text: 'hi', clusterId: 'two' });
    assert.match(ungranted.text, /^NOT_GRANTED: /);
    const foreign = await call(app, asSession(app, 'shared'), ECHO, { text: 'hi', clusterId: 'three' });
    assert.ok(foreign.isError && /请选择 clusterId/.test(foreign.text), 'a cluster the conversation is not in names nobody');
    const shared = await call(app, asSession(app, 'shared'), ECHO, { text: 'hi', clusterId: 'one' });
    assert.equal(shared.isError, false, shared.text);
    const [first] = (await probe(app, 'calls')).calls;
    assert.deepEqual(Object.keys(first).sort(), ['arguments', 'context', 'tool']);
    assert.deepEqual(first.arguments, { text: 'hi' }, 'the Hub\'s clusterId is not passed as an argument');
    assert.deepEqual(Object.keys(first.context).sort(), ['at', 'callId', 'clusterId', 'member']);
    assert.deepEqual([first.tool, first.context.clusterId, first.context.member], ['echo', 'one', { id: 'one-Bob', name: 'Bob' }]);
    // Never a member id from the arguments: the caller is the authenticated conversation.
    const posing = await call(app, asSession(app, 'one-Alice'), ECHO, { text: 'hi', memberId: 'one-Bob' });
    assert.match(posing.text, /^INVALID_ARGUMENT: /);
    // None of the refused calls (no cluster chosen, not granted, not a member there, an unknown argument) reached the plugin.
    assert.equal((await probe(app, 'calls')).calls.length, 1, 'refused calls never reached the plugin');
  } finally { await app.close(); }
});

// ---- calls ----

test('calls: the answer goes back as text and JSON; every failure has a stable code and the plugin keeps running', async () => {
  const app = await startTestHub({ dir: setup({ one: ['Alice'] }, [{ clusterIds: ['one'] }]) });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const me = asSession(app, 'one-Alice');
    const ok = await call(app, me, ECHO, { text: 'hi', times: 2, loud: true });
    assert.equal(ok.isError, false);
    assert.deepEqual(ok.content.slice(0, 2).map((c: any) => c.text), ['HI HI', '{"length":5}']);
    const cases: [string, string, RegExp][] = [
      ['error', 'TOOL_FAILED', /^TOOL_FAILED: 插件「工具示例（测试用）」报告失败：lookup service is down please retry$/],
      ['malformed', 'TOOL_FAILED', /^TOOL_FAILED: 插件的回答格式不对。$/],
      ['big', 'RESULT_TOO_LARGE', /^RESULT_TOO_LARGE: /],
    ];
    for (const [mode, , expected] of cases) {
      await probe(app, 'mode', { mode });
      const failed = await call(app, me, ECHO, { text: 'hi' });
      assert.ok(failed.isError, mode);
      assert.match(failed.text, expected, mode);
    }
    await probe(app, 'mode', { mode: 'data' });
    assert.deepEqual((await call(app, me, ECHO, { text: 'hi' })).content.map((c: any) => c.text), ['{"echoed":"hi","n":1}']);
    await probe(app, 'mode', { mode: 'control' });
    assert.equal((await call(app, me, ECHO, { text: 'hi' })).content[0].text, 'bell and[31m escape\nsecond line');
    assert.equal(await stateOf(app), 'ready', 'failed calls never stop the plugin');
    const unknown = await call(app, me, 'p_tool-demo_nope', {});
    assert.ok(unknown.isError && /not found/.test(unknown.text));

    // A crash during the call: PLUGIN_NOT_RUNNING; afterwards the tools are not listed and a call is refused at once.
    await probe(app, 'mode', { mode: 'crash' });
    assert.match((await call(app, me, ECHO, { text: 'hi' })).text, /^PLUGIN_NOT_RUNNING: /);
    await waitFor(async () => (await stateOf(app)) === 'failed', 'failed');
    assert.deepEqual(await pluginNames(app, me), []);
    const started = Date.now();
    assert.match((await call(app, me, ECHO, { text: 'hi' })).text, /^PLUGIN_NOT_RUNNING: .*failed/);
    assert.ok(Date.now() - started < 1000, 'no waiting');
  } finally { await app.close(); }
});

test('timeout: only that call fails, the plugin keeps running, the late answer is dropped and later calls work', async () => {
  const app = await startTestHub({ dir: setup({ one: ['Alice'] }, [{ clusterIds: ['one'] }]), pluginLifecycle: { toolTimeoutMs: 300 } });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const me = asSession(app, 'one-Alice');
    const timedOut = await call(app, me, SLOW, { ms: 700 });
    assert.match(timedOut.text, /^TOOL_TIMEOUT: .*0.3 秒内/);
    await probe(app, 'mode', { mode: 'hang' });
    assert.match((await call(app, me, ECHO, { text: 'hi' })).text, /^TOOL_TIMEOUT: /);
    await probe(app, 'mode', { mode: 'normal' });
    // The slow answer arrives ~400 ms after its timeout: it must be dropped quietly, not taken for a protocol error.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(await stateOf(app), 'ready');
    assert.equal((await call(app, me, ECHO, { text: 'still here' })).content[0].text, 'still here');
    assert.match(records(app, 'one')[0].body, /失败（TOOL_TIMEOUT）/);
  } finally { await app.close(); }
});

// ---- budgets and priority ----

test('budgets: per member and per plugin a minute, totals across members; refused calls use none; the windows slide', async () => {
  let clock = Date.parse('2026-11-18T10:00:00Z');
  const names = ['A', 'B', 'C', 'D', 'E'];
  const app = await startTestHub({ dir: setup({ one: names }, [{ clusterIds: ['one'] }]), pluginLifecycle: { now: () => clock } });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const as = (name: string) => asSession(app, `one-${name}`);
    for (let i = 0; i < 5; i++) assert.match((await call(app, as('A'), ECHO, { nope: i })).text, /^INVALID_ARGUMENT/);
    for (let i = 0; i < TOOL_LIMITS.perMemberPerMinute; i++) assert.equal((await call(app, as('A'), ECHO, { text: `a${i}` })).isError, false, `A ${i}`);
    const over = await call(app, as('A'), ECHO, { text: 'one more' });
    assert.match(over.text, /^RATE_LIMITED: 你每分钟最多调用/);
    // The plugin's total over all members: B, C and D take the rest of its 120, E is refused though it called nothing yet.
    for (const name of ['B', 'C', 'D']) {
      for (let i = 0; i < TOOL_LIMITS.perMemberPerMinute; i++) assert.equal((await call(app, as(name), ECHO, { text: 'x' })).isError, false, `${name} ${i}`);
    }
    assert.match((await call(app, as('E'), ECHO, { text: 'x' })).text, /^RATE_LIMITED: .*所有成员合计/);
    assert.equal((await probe(app, 'calls')).calls.length, 4 * TOOL_LIMITS.perMemberPerMinute, 'the refused ones never reached the plugin');
    clock += 30_000;
    assert.match((await call(app, as('E'), ECHO, { text: 'x' })).text, /^RATE_LIMITED/, 'still inside the minute');
    clock += 30_001;
    assert.equal((await call(app, as('E'), ECHO, { text: 'x' })).isError, false, 'the window slid');
    assert.equal((await call(app, as('A'), ECHO, { text: 'x' })).isError, false);
  } finally { await app.close(); }
});

test('priority: a gate plugin flooded with tool calls still answers message checks', async () => {
  const app = await startTestHub({ dir: setup({ one: ['Alice', 'Bob'] }, [{ clusterIds: ['one'] }]) });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const me = asSession(app, 'one-Alice');
    // 16 slow calls at once (the plugin's whole pending-request cap): only TOOL_LIMITS.inFlightPerPlugin are sent.
    const flood = Array.from({ length: 16 }, () => call(app, me, SLOW, { ms: 1500 }));
    await waitFor(async () => (await probe(app, 'calls')).calls.length === TOOL_LIMITS.inFlightPerPlugin, 'in flight');
    const send = async (body: string) => {
      const { body: res } = await mcp(app, me, 'tools/call', { name: 'send_message', arguments: { body } });
      return res.result as { isError?: boolean; content: { text: string }[] };
    };
    const refused = await send('this is forbidden');
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^REFUSED_BY_PLUGIN: .*no forbidden words/, 'the check was asked and answered');
    assert.equal((await send('this is fine')).isError, undefined);
    const results = await Promise.all(flood);
    assert.equal(results.filter((r) => !r.isError).length, TOOL_LIMITS.inFlightPerPlugin);
    assert.ok(results.filter((r) => r.isError).every((r) => /^RATE_LIMITED: .*同时最多处理/.test(r.text)));
    assert.equal(app.store.listMessages('one', 200).filter((m) => m.systemKind === 'plugin_check_failed').length, 0, 'no check went unanswered');
    assert.equal((await probe(app, 'calls')).checks, 2);
  } finally { await app.close(); }
});

test('priority: with every slot for other requests taken (tool calls and invokes), 8 concurrent sends are all checked', async () => {
  const names = ['Alice', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'];
  const app = await startTestHub({ dir: setup({ one: names }, [{ clusterIds: ['one'] }]) });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    await probe(app, 'mode', { mode: 'normal', checkDelay: 800 });
    const tools = Array.from({ length: TOOL_LIMITS.inFlightPerPlugin }, () => call(app, asSession(app, 'one-Alice'), SLOW, { ms: 3000 }));
    await waitFor(async () => (await probe(app, 'calls')).calls.length === TOOL_LIMITS.inFlightPerPlugin, 'tool calls out');
    // Eight more slow requests that are not checks: only four find a slot (8 in all for requests other than checks).
    const holds = Array.from({ length: 8 }, () => fetch(`${app.url}/api/plugins/tool-demo/invoke`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'hold', arguments: { ms: 3000 } }) }));
    const refusedHolds = (await Promise.all(holds.map((h) => Promise.race([h.then((r) => r.status), new Promise((ok) => setTimeout(() => ok('waiting'), 500))]))))
      .filter((s) => s !== 'waiting');
    assert.equal(refusedHolds.length, 4, 'the other four were refused at once');
    // A tool call now finds no slot either: refused, never sent, no budget used.
    const busy = await call(app, asSession(app, 'one-B8'), SLOW, { ms: 1 });
    assert.match(busy.text, /^RATE_LIMITED: .*(同时最多处理|暂时收不下)/);
    const sends = names.slice(1).map((name) => mcp(app, asSession(app, `one-${name}`), 'tools/call', { name: 'send_message', arguments: { body: `checked ${name}` } }));
    const sent = await Promise.all(sends);
    assert.ok(sent.every((r) => !r.body.result.isError), 'all eight stored');
    assert.equal(app.store.listMessages('one', 200).filter((m) => m.systemKind === 'plugin_check_failed').length, 0, 'none went through unchecked');
    await Promise.all([...tools, ...holds]);
    assert.equal((await probe(app, 'calls')).checks, 8, 'all eight were asked');
  } finally { await app.close(); }
});

test('a tool call the plugin cannot take (its slots for other requests are full) is refused, not sent, and uses no budget', async () => {
  const app = await startTestHub({ dir: setup({ one: ['Alice'] }, [{ clusterIds: ['one'] }]) });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const me = asSession(app, 'one-Alice');
    const holds = Array.from({ length: 8 }, () => app.api('POST', '/api/plugins/tool-demo/invoke', { command: 'hold', arguments: { ms: 1500 } }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const busy = await call(app, me, ECHO, { text: 'cannot go' });
    assert.match(busy.text, /^RATE_LIMITED: .*暂时收不下更多请求，这次调用没有交给它/);
    await Promise.all(holds);
    assert.equal((await probe(app, 'calls')).calls.length, 0, 'the plugin never got it');
    assert.match(records(app, 'one')[0].body, /被拒绝（RATE_LIMITED），没有交给插件/);
    // The whole per-member minute is still there: the refused call was not charged.
    for (let i = 0; i < TOOL_LIMITS.perMemberPerMinute; i++) assert.equal((await call(app, me, ECHO, { text: `n${i}` })).isError, false, `call ${i}`);
    assert.match((await call(app, me, ECHO, { text: 'over' })).text, /^RATE_LIMITED: 你每分钟最多调用/);
  } finally { await app.close(); }
});

// ---- what a call leaves behind ----

test('a call writes no message, delivery or wake and uses no loop budget; its record has no recipients and skips its plugin', async () => {
  const dir = setup({ one: ['Alice', 'Bob'] }, [
    { clusterIds: ['one'], permissions: ['tools.provide', 'messages.gate', 'messages.read', 'events.read'], events: ['message.created'] },
    { id: 'tool-watch', clusterIds: ['one'], tools: [], permissions: ['events.read', 'messages.read'], events: ['message.created'] },
  ]);
  const app = await startTestHub({ dir });
  try {
    await waitFor(async () => (await stateOf(app, 'tool-watch')) === 'ready', 'ready');
    const before = app.events.length;
    const { isError } = await call(app, asSession(app, 'one-Alice'), ECHO, { text: '@Bob look' });
    assert.equal(isError, false);
    const [record] = records(app, 'one');
    assert.deepEqual([record.from, record.kind, record.mentions, record.hop], ['system', 'system', [], 0]);
    const added = app.events.slice(before);
    assert.deepEqual(added.map((e) => e.kind), ['message'], 'one event: the record itself');
    assert.equal(app.store.listMessages('one', 200).length, 1, 'no other message');
    assert.deepEqual((await app.messages('one'))[0].deliveries, [], 'no delivery');
    assert.equal(app.native.delivered.length, 0, 'nobody woken, though the text names Bob');
    const seen = await waitFor(async () => (await probe(app, 'calls', {}, 'tool-watch')).events.find((e: any) => e.data.messageId === record.id), 'the other plugin sees it');
    assert.deepEqual([seen.data.body, seen.data.bodyOmitted, seen.data.recipients, seen.data.systemKind], [undefined, true, [], 'plugin_tool_call'],
      'without the body (a Hub-written system message), even with messages.read');
    assert.ok(!(await probe(app, 'calls')).events.some((e: any) => e.data.messageId === record.id), 'its own plugin does not');
    // Unread: not for the caller, not for the other member; only the history shows it.
    for (const session of ['one-Alice', 'one-Bob']) {
      const read = async (args: object) => JSON.parse((await mcp(app, asSession(app, session), 'tools/call', { name: 'read_messages', arguments: args })).body.result.content[0].text);
      assert.deepEqual(await read({}), [], `${session}: nothing unread`);
      assert.ok((await read({ history: true })).some((m: any) => m.id === record.id), `${session}: in the history`);
    }
  } finally { await app.close(); }
});

test('record: safe metadata only (who, tool, code, reached, handed back, time, sizes); one per window, then a summary', async () => {
  const cluster = 'c-7f3a9e';
  const app = await startTestHub({ dir: setup({ [cluster]: ['Alice', 'Bob'] }, [{ clusterIds: [cluster] }]), pluginLifecycle: { toolRecordMs: 600 } });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const alice = asSession(app, `${cluster}-Alice`);
    const args = { text: 'hello', times: 2 };
    assert.equal((await call(app, alice, ECHO, args)).isError, false);
    const [first] = records(app, cluster);
    const bytes = Buffer.byteLength(JSON.stringify(args));
    const resultBytes = Buffer.byteLength(JSON.stringify({ text: 'hello hello', data: { length: 11 } }));
    assert.match(first.body, new RegExp(`^「Alice」调用了插件「工具示例（测试用）」的工具 p_tool-demo_echo：成功（OK），交给了插件，结果交回了调用者，用时 \\d+\\.\\d 秒。`
      + `参数 2 项、${bytes} 字节；结果 ${resultBytes} 字节。记录不含参数和结果的内容。$`));
    const callId = (await probe(app, 'calls')).calls[0].context.callId;
    for (const secret of [cluster, `${cluster}-Alice`, callId, secretOf(app), TEST_TOKEN, app.home, app.dir, 'hello']) {
      assert.ok(!first.body.includes(secret), `the record does not carry ${secret.slice(0, 12)}`);
    }
    for (let i = 0; i < 4; i++) await call(app, alice, ECHO, { text: `again ${i}` });
    assert.equal(records(app, cluster).length, 1, 'one per window');
    const bob = await call(app, asSession(app, `${cluster}-Bob`), ECHO, { nope: 1 });
    assert.match(bob.text, /^INVALID_ARGUMENT: .*"nope"/, 'the member itself is told which argument');
    assert.equal(records(app, cluster)[1].body, '「Bob」调用了插件「工具示例（测试用）」的工具 p_tool-demo_echo：被拒绝（INVALID_ARGUMENT），没有交给插件。参数 1 项、10 字节。记录不含参数和结果的内容。');
    // Alice stops calling: the window's count is still written, by the window's own end.
    const summary = await waitFor(() => records(app, cluster).find((m) => m.body.includes('又调用了')), 'the summary', 3000);
    assert.equal(summary.body, '「Alice」在上一条记录之后又调用了插件「工具示例（测试用）」的工具 p_tool-demo_echo 4 次（都交给了插件：OK 4 次），没有逐条记录。');
    assert.equal(records(app, cluster).length, 3, 'Bob\'s single call needs no summary');
    // A new window starts with a full record again.
    await call(app, alice, ECHO, { text: 'later' });
    assert.match(records(app, cluster)[3].body, /^「Alice」调用了.*成功（OK）/);
  } finally { await app.close(); }
});

test('record: no argument value or key, result or error text ever reaches the shared chat; the caller still gets them', async () => {
  const dir = setup({ one: ['Alice', 'Bob', 'Carol'] }, [{ clusterIds: ['one'] }]);
  const app = await startTestHub({ dir });   // the default one-minute window: the summaries are written by the close
  const markers = ['MARK-ARGVAL', 'MARK-KEY', 'MARK-RESULT', 'lookup service is down', 'MARK-CHANGED'];
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const alice = asSession(app, 'one-Alice');
    // (a) an argument value the result does not echo, (c) a result, three times (one record, two counted)
    for (let i = 0; i < 3; i++) {
      const ok = await call(app, alice, ECHO, { text: 'MARK-RESULT', tags: ['MARK-ARGVAL'] });
      assert.equal(ok.content[0].text, 'MARK-RESULT', '(c) the caller gets the result');
    }
    // (b) an argument key
    assert.match((await call(app, alice, ECHO, { text: 'x', 'MARK-KEY': 1 })).text, /^INVALID_ARGUMENT: .*MARK-KEY/);
    // (d) the plugin's error detail
    await probe(app, 'mode', { mode: 'error' });
    assert.match((await call(app, asSession(app, 'one-Bob'), ECHO, { text: 'x' })).text, /^TOOL_FAILED: .*lookup service is down/, '(d) the caller gets it');
    await probe(app, 'mode', { mode: 'normal' });
    // (e) a result that is not handed back
    const pending = call(app, asSession(app, 'one-Carol'), SLOW, { ms: 500, note: 'MARK-CHANGED' });
    await waitFor(async () => (await probe(app, 'calls')).calls.some((c: any) => c.arguments.note === 'MARK-CHANGED'), 'sent');
    app.hub.setMemberHidden('one-Carol', true);
    assert.match((await pending).text, /^CALLER_CHANGED: /);
  } finally { await app.close(); }
  // A normal close settles the open windows; read what was stored back from the database file.
  const store = new Store(join(dir, 'test.db'));
  try {
    const stored = store.listMessages('one', 500).filter((m) => m.from === 'system');
    const tool = stored.filter((m) => m.systemKind === 'plugin_tool_call');
    assert.ok(tool.length >= 5, `records written: ${tool.length}`);
    for (const message of stored) for (const marker of markers) assert.ok(!message.body.includes(marker), `${marker} in: ${message.body}`);
    const summary = tool.find((m) => m.body.startsWith('「Alice」在上一条记录之后又调用了'));
    assert.ok(summary, 'the summary written at close');
    assert.match(summary!.body, / 2 次（都交给了插件：OK 2 次）/);
    assert.match(tool.find((m) => m.body.startsWith('「Carol」'))!.body, /结果没有交回（CALLER_CHANGED/);
    assert.match(tool.find((m) => m.body.startsWith('「Bob」'))!.body, /失败（TOOL_FAILED）/);
  } finally { store.close(); }
});

test('record: a call refused before the plugin never hides calls that reached it', async () => {
  const app = await startTestHub({ dir: setup({ one: ['Alice'] }, [{ clusterIds: ['one'] }]), pluginLifecycle: { toolRecordMs: 600 } });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const me = asSession(app, 'one-Alice');
    assert.match((await call(app, me, ECHO, { nope: 1 })).text, /^INVALID_ARGUMENT/);
    for (let i = 0; i < 5; i++) assert.equal((await call(app, me, ECHO, { text: `sent-${i}` })).isError, false);
    const now = records(app, 'one').map((m) => m.body);
    assert.equal(now.length, 2);
    assert.match(now[0], /被拒绝（INVALID_ARGUMENT），没有交给插件/);
    assert.match(now[1], /成功（OK），交给了插件/, 'the first call that reached the plugin has its own record');
    const summary = await waitFor(() => records(app, 'one').find((m) => m.body.includes('又调用了')), 'the summary', 3000);
    assert.match(summary.body, /4 次（都交给了插件：OK 4 次）/);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(records(app, 'one').length, 3, 'one summary, and none for the refused window that counted nothing');
  } finally { await app.close(); }
});

test('the caller changed during the call (removed, rebound, hidden): the result is not handed over and the record says so', async () => {
  const app = await startTestHub({ dir: setup({ one: ['Alice', 'Bob', 'Carol', { name: 'Dan', session: 's2' }] },
    [{ clusterIds: ['one'] }]) });
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const during = async (session: Record<string, string>, change: () => Promise<unknown>) => {
      const pending = call(app, session, SLOW, { ms: 600 });
      await waitFor(async () => (await probe(app, 'calls')).calls.length > before(), 'sent');
      await change();
      return pending;
    };
    let sent = 0;
    const before = () => sent;
    const expectChanged = async (result: { text: string }) => {
      sent++;
      assert.match(result.text, /^CALLER_CHANGED: /);
      assert.ok(!result.text.includes('waited'), 'not the result');
    };
    // ABA: rebound away and back to the same conversation before the answer. That conversation is again this member, and
    // the answer goes back to the conversation that asked: handed over, which is what the member would get anyway.
    const rebind = (sessionId: string) => app.api('POST', '/api/members/one-Dan/session', { harness: 'mock', sessionId, confirmStopped: true });
    const aba = await during(asSession(app, 's2'), async () => { await rebind('s1'); await rebind('s2'); });
    sent++;
    assert.equal(aba.text, 'waited 600 ms');
    await expectChanged(await during(asSession(app, 'one-Alice'), () => app.api('DELETE', '/api/clusters/one/members/one-Alice', {})));
    await expectChanged(await during(asSession(app, 'one-Bob'), () => app.api('POST', '/api/members/one-Bob/session', { harness: 'mock', sessionId: 's1', confirmStopped: true })));
    await expectChanged(await during(asSession(app, 'one-Carol'), async () => app.hub.setMemberHidden('one-Carol', true)));
    const bodies = records(app, 'one').map((m) => m.body).filter((body) => !body.startsWith('「Dan」'));
    assert.equal(bodies.length, 3);
    for (const body of bodies) assert.match(body, /成功（OK），交给了插件，结果没有交回（CALLER_CHANGED/);
    // Bob, now bound to another conversation, is the same member there.
    assert.equal((await call(app, asSession(app, 's1'), ECHO, { text: 'hi' })).isError, false);
  } finally { await app.close(); }
});

// ---- lifecycle ----

test('lifecycle: a stop settles calls at once, unlists the tools and tells bridges; a restart applies new declarations', async () => {
  const dir = setup({ one: ['Alice'], two: ['Carol'], three: ['Dan'] }, [{ clusterIds: ['one'] }]);
  const app = await startTestHub({ dir });
  const stream = new AbortController();
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    const me = asSession(app, 'one-Alice');
    const open = async (session: string) => {
      const frames: string[] = [];
      const res = await fetch(`${app.url}/bridge/stream?harness=mock&session=${session}`, { headers: { 'x-orrery-bridge': secretOf(app) }, signal: stream.signal });
      void (async () => {
        const decoder = new TextDecoder();
        try { for await (const chunk of res.body!) frames.push(decoder.decode(chunk)); } catch { /* aborted */ }
      })();
      return () => frames.join('').split('event: tools-changed').length - 1;
    };
    const changed = await open('one-Alice');
    const carol = await open('two-Carol');      // granted only by the restart below
    const elsewhere = await open('three-Dan');   // a conversation only in a cluster the plugin is never granted

    const slow = call(app, me, SLOW, { ms: 20_000 });
    await waitFor(async () => (await probe(app, 'calls')).calls.length === 1, 'sent');
    const stopping = Date.now();
    await app.api('POST', '/api/plugins/tool-demo/stop', {});
    const settled = await slow;
    assert.match(settled.text, /^PLUGIN_NOT_RUNNING: .*调用期间停止/);
    assert.ok(Date.now() - stopping < 5000, 'not after the 20 s');
    await waitFor(() => changed() >= 1, 'tools-changed on the session stream');
    assert.deepEqual(await pluginNames(app, me), [], 'not listed while stopped');
    const at = Date.now();
    assert.match((await call(app, me, ECHO, { text: 'hi' })).text, /^PLUGIN_NOT_RUNNING: .*stopped/, 'an app with the old list gets the code');
    assert.ok(Date.now() - at < 1000);
    // A JSON-RPC batch with the call and a listing: the call is answered, the listing still leaves the tools out.
    const batch = await fetch(`${app.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...me },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: ECHO, arguments: { text: 'x' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]) });
    const answers = await batch.json() as any[];
    assert.match(answers.find((a) => a.id === 1).result.content[0].text, /^PLUGIN_NOT_RUNNING: /);
    const batchList = answers.find((a) => a.id === 2).result.tools.map((t: any) => t.name);
    assert.ok(batchList.includes('send_message') && !batchList.some((n: string) => n.startsWith('p_')), 'not listed in the batch either');

    // Changed declarations and grant: read again at the restart.
    const manifestFile = join(dir, 'plugins', 'tool-demo', 'orrery-plugin.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.tools.push({ ...manifest.tools[1], name: 'nap', description: 'A new tool.' });
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const configFile = join(dir, 'home', 'external-plugins.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.plugins[0].tools = ['echo', 'nap'];
    config.plugins[0].clusterIds = ['one', 'two'];
    assert.equal(carol(), 0, 'not told about the stop: the plugin was not granted there');
    writeFileSync(configFile, JSON.stringify(config));
    const count = changed();
    await app.api('POST', '/api/plugins/tool-demo/restart', {});
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready again');
    await waitFor(() => changed() > count, 'tools-changed again');
    assert.deepEqual(await pluginNames(app, me), [ECHO, 'p_tool-demo_nap']);
    assert.ok((await call(app, me, SLOW, { ms: 1 })).isError, 'the tool no longer granted is gone');
    assert.equal((await call(app, me, 'p_tool-demo_nap', { ms: 1 })).content[0].text, 'waited 1 ms');
    const row = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'tool-demo');
    assert.deepEqual(row.memberTools.map((t: any) => [t.name, t.granted]), [[ECHO, true], [SLOW, false], ['p_tool-demo_nap', true]]);
    assert.deepEqual(row.memberToolClusters, [{ id: 'one', name: 'one' }, { id: 'two', name: 'two' }], 'the card names where the tools are offered');
    await waitFor(() => carol() >= 1, 'the newly granted cluster is told');
    assert.equal(elsewhere(), 0, 'a conversation outside the granted clusters is never told');
    // A granted cluster in the bin is no longer named: the card follows what the listing uses.
    app.hub.deleteCluster('two');
    const binned = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'tool-demo');
    assert.deepEqual(binned.memberToolClusters, [{ id: 'one', name: 'one' }]);
  } finally { stream.abort(); await app.close(); }
});

// ---- the member page's tool versions ----

test('tool versions: a Claude conversation offered plugin tools still matches the Hub (the bridge fingerprints official tools only)', async () => {
  const { toolVersionView } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'ui.js')).href);
  const app = await startTestHub({ dir: setup({ one: [{ name: 'Cla', session: 'claude-session', harness: 'claude' }] }, [{ clusterIds: ['one'] }]) });
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDECODE$|ORRERY_|HTTPS?_PROXY$|NO_PROXY$|NODE_USE_ENV_PROXY$)/i.test(k)));
  const bridge = spawn(process.execPath, [join(REPO_ROOT, 'src', 'bridge', 'claude-bridge.ts')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...base, ORRERY_HOME: app.home, CLAUDE_CODE_SESSION_ID: 'claude-session' } as NodeJS.ProcessEnv });
  const answers = new Map<number, any>();
  createInterface({ input: bridge.stdout }).on('line', (line) => { try { const m = JSON.parse(line); if (typeof m.id === 'number') answers.set(m.id, m); } catch { /* not ours */ } });
  let next = 1;
  const rpc = async (method: string, params: object = {}) => {
    const id = next++;
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return waitFor(() => answers.get(id), method);
  };
  try {
    await waitFor(async () => (await stateOf(app)) === 'ready', 'ready');
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
    const listedHere = (await rpc('tools/list')).result.tools.map((t: any) => t.name);
    assert.ok(listedHere.includes(ECHO), 'the bridge forwards the plugin tools to Claude');
    assert.equal((await rpc('tools/call', { name: 'list_agents', arguments: {} })).result.isError, undefined);
    const view = toolVersionView(await app.api('GET', '/api/tool-versions'), 'one-Cla', 'claude');
    assert.equal(view.bridge.state, 'match', view.bridge.text);
    assert.equal(view.advice, null, 'no advice to reconnect');
  } finally {
    bridge.stdin.end();
    await new Promise((resolve) => { bridge.once('exit', resolve); setTimeout(() => { bridge.kill(); resolve(null); }, 3000); });
    await app.close();
  }
});
