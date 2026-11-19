// Native DeepSeek Harness without DSH or a model (docs/adapters/deepseek.md, "测试和验收" items 3-5):
// the session store over fictional projection-cache fixtures, the adapter against a fake BridgePort, and the real
// plugin (plugins/dsh-orrery) loaded into this process with a fake Cordis ctx, talking to a real test Hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeepseekNativeAdapter } from '../src/adapters/deepseek/native.ts';
import { REPO_ROOT } from '../src/main.ts';
import type { BridgePort, Member, NativeDeliverContext } from '../src/core/types.ts';
import { startTestHub, tempDir, waitFor, writeRegistry, type TestHub } from './helpers.ts';

const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'dsh-orrery');
const plugin = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href);
const DSH_HOME = join(REPO_ROOT, 'test', 'fixtures', 'deepseek');
const S1 = '11111111-1111-4111-8111-111111111111';   // /work/alpha, titled, prompted later
const S2 = '22222222-2222-4222-8222-222222222222';   // /work/alpha, no title, never prompted
const SUB = '33333333-3333-4333-8333-333333333333';  // /work/alpha, a subagent's session
const S4 = '44444444-4444-4444-8444-444444444444';   // /work/beta
const NO_CWD = '55555555-5555-4555-8555-555555555555';
const BROKEN = '66666666-6666-4666-8666-666666666666';
const NOT_SENT = /^接入件没有发送请求：未找到活动 Hub/;
const RETRY_MS = 100;

// ───────────── store and adapter ─────────────

test('deepseek store: projects and sessions from the projection cache; subagent, cwd-less and broken records left out', async () => {
  const adapter = createDeepseekNativeAdapter({ dshHome: DSH_HOME });
  const alpha = resolve('/work/alpha');
  assert.deepEqual((await adapter.listProjects()).map((p) => [resolve(p.path), p.label, p.updatedAt]), [
    [alpha, 'alpha', '2026-01-03T00:00:00.000Z'],
    [resolve('/work/beta'), 'beta', '2025-12-30T13:06:40.000Z'],
  ]);
  assert.deepEqual(await adapter.listSessions('/work/alpha'), [
    { id: S2, title: S2, model: null, cwd: '/work/alpha', updatedAt: '2026-01-03T00:00:00.000Z' },
    { id: S1, title: 'Fix the parser', model: null, cwd: '/work/alpha', updatedAt: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.deepEqual((await adapter.listSessions(alpha.toUpperCase())).length, process.platform === 'win32' ? 2 : 0, 'paths compare like the OS does');
  assert.equal((await adapter.attachSession(S4)).title, 'Draft release notes');
  for (const id of [SUB, NO_CWD, BROKEN, 'no-such-session', '../storages', '']) {
    await assert.rejects(adapter.attachSession(id), /not found/, id);
  }
  assert.deepEqual(await createDeepseekNativeAdapter({ dshHome: tempDir() }).listProjects(), [], 'no cache: nothing listed');
});

type DoneEnd = Awaited<ReturnType<BridgePort['waitDone']>>;

function fakePort(online: boolean, push: BridgePort['push'], waitDone: () => Promise<DoneEnd> = async () => 'dropped'):
  BridgePort & { pushed: string[]; waits: string[]; online: boolean } {
  const port = {
    online, pushed: [] as string[], waits: [] as string[],
    isOnline: (h: string, id: string) => h === 'deepseek' && id === 'S' && port.online,
    push: (h: string, id: string, deliveryId: string, text: string) => (port.pushed.push(`${h}/${id}/${deliveryId}/${text}`), push(h, id, deliveryId, text)),
    waitDone: (h: string, id: string, deliveryId: string, timeoutMs: number) => (port.waits.push(`${h}/${id}/${deliveryId}/${timeoutMs}`), waitDone()),
  };
  return port;
}

test('deepseek native adapter: online from the bridge; deliver → accepted / offline / rejected; no createSession', async () => {
  const adapter = createDeepseekNativeAdapter({ dshHome: DSH_HOME });
  const ctx = (bridge: BridgePort): NativeDeliverContext => ({ deliveryId: 'd1', bridge, onEvent: () => {}, signal: new AbortController().signal });
  assert.equal(adapter.harness, 'deepseek');
  assert.equal(adapter.createSession, undefined, 'the user creates sessions in DSH');
  assert.equal(adapter.confirmOnline, undefined, 'the stream state is exact');

  const ok = fakePort(true, async () => ({ ok: true }));
  assert.equal(adapter.isOnline('S', ok), true);
  assert.equal(await adapter.deliver('S', 'hi', ctx(ok)), 'accepted');
  assert.deepEqual(ok.pushed, ['deepseek/S/d1/hi']);
  const off = fakePort(false, async () => { throw new Error('must not push'); });
  assert.equal(adapter.isOnline('S', off), false);
  assert.equal(await adapter.deliver('S', 'hi', ctx(off)), 'offline');
  const bad = fakePort(true, async () => ({ ok: false, error: 'session/writer-held: held by another process' }));
  await assert.rejects(adapter.deliver('S', 'hi', ctx(bad)), /^Error: session\/writer-held: held by another process$/);
  const ackTimeout = fakePort(true, async () => ({ ok: false, outcome: 'unknown', error: 'bridge ack timed out' }));
  assert.deepEqual(await adapter.deliver('S', 'hi', ctx(ackTimeout)), { outcome: 'unknown', error: 'bridge ack timed out' });
  const dropped = fakePort(true, async () => { dropped.online = false; throw new Error('no bridge connected'); });
  assert.deepEqual(await adapter.deliver('S', 'hi', ctx(dropped)), { outcome: 'unknown', error: 'DeepSeek bridge push failed (no bridge connected); the message may have been delivered' });
  assert.deepEqual(ok.waits, [], 'an ack without follows (an older plugin): nothing to wait for');
});

test('deepseek native adapter: only an explicit completed result proves success; legacy and lost results are unknown', async () => {
  const adapter = createDeepseekNativeAdapter({ dshHome: DSH_HOME, turnWaitMs: 1234 });
  const ctx = (bridge: BridgePort): NativeDeliverContext => ({ deliveryId: 'd1', bridge, onEvent: () => {}, signal: new AbortController().signal });
  const results: [DoneEnd, unknown][] = [
    [{ outcome: 'completed' }, 'completed'],
    [{ outcome: 'failed', error: 'turn interrupted' }, { outcome: 'failed', error: 'turn interrupted' }],
    [{ outcome: 'failed' }, { outcome: 'failed', error: 'DeepSeek turn failed' }],
    [{ outcome: 'unknown', error: 'not observed' }, { outcome: 'unknown', error: 'not observed' }],
    [{ outcome: 'unknown' }, { outcome: 'unknown', error: 'DeepSeek turn outcome is unknown' }],
    ['done', { outcome: 'unknown', error: 'DeepSeek accepted the message, but the plugin did not report a turn result; its outcome is unknown' }],
    ['dropped', { outcome: 'unknown', error: 'DeepSeek accepted the message, but the plugin connection closed; its outcome is unknown' }],
    ['timeout', { outcome: 'unknown', error: 'DeepSeek accepted the message, but waiting for the turn timed out; its outcome is unknown' }],
    ['aborted', { outcome: 'unknown', error: 'DeepSeek accepted the message, but waiting for the turn was cancelled; its outcome is unknown' }],
  ];
  for (const [end, result] of results) {
    const port = fakePort(true, async () => ({ ok: true, follows: true }), async () => end);
    assert.deepEqual(await adapter.deliver('S', 'hi', ctx(port)), result);
    assert.deepEqual(port.waits, ['deepseek/S/d1/1234'], 'waits for this delivery with the time limit');
  }
});

// ───────────── the plugin, with a fake Cordis ctx ─────────────

interface Prompt { requestId: string; sessionId: string; mode: string; content: { type: string; text: string }[] }

/**
 * What the plugin sees of DSH: sessionController.prompt, tools.register, on('session/event'), effect, logger.
 * `dispose` = Cordis unloading it. `autoTurn` (default): every accepted prompt runs at once as its own turn
 * (user/message with its rpcId, then turn/end); without it the test plays the turns with `turn`. `events: false`: a
 * DSH without session events.
 */
function fakeDsh(onPrompt: (p: Prompt) => Promise<unknown> = async () => ({ accepted: true }), opts: { autoTurn?: boolean; events?: boolean } = {}) {
  const tools = new Map<string, any>();
  const prompts: Prompt[] = [];
  const logs: string[] = [];
  const listeners = new Set<(session: { id: string }, event: unknown) => void>();
  const postExecutes = new Set<(exec: any, result: any, next: () => Promise<any>) => Promise<any>>();
  let disposers: (() => void)[] = [];
  let turnNo = 0;
  const emit = (sessionId: string, event: unknown) => { for (const l of [...listeners]) l({ id: sessionId }, event); };
  /** One DSH turn of `sessionId` that runs the prompt `rpcId` (none: a turn the user typed), ending with `kind`. */
  const turn = (sessionId: string, rpcId: string | null, kind = 'completed') => {
    const t = ++turnNo;
    emit(sessionId, { type: 'turn/start', data: { turn: t } });
    emit(sessionId, { type: 'user/message', data: { content: [], source: rpcId === null ? { kind: 'user' } : { kind: 'user', rpcId } } });
    emit(sessionId, { type: 'turn/end', data: { turn: t, reason: { kind } } });
  };
  const ctx = {
    logger: () => ({ info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) }),
    sessionController: {
      async prompt(p: Prompt, signal: AbortSignal) {
        assert.ok(signal instanceof AbortSignal, 'prompt gets a signal (DSH requires one)');
        prompts.push(p);
        const r = await onPrompt(p);
        if (opts.autoTurn !== false) setImmediate(() => turn(p.sessionId, p.requestId));
        return r;
      },
    },
    ...(opts.events === false ? {} : {
      on(name: string, fn: any) {
        if (name === 'tools/post-execute') {
          postExecutes.add(fn);
          return () => { postExecutes.delete(fn); };
        }
        assert.equal(name, 'session/event');
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      },
    }),
    tools: {
      register(def: any) {
        if (tools.has(def.name)) throw new Error(`tool "${def.name}" is already registered`);
        assert.equal(typeof def.output?.render, 'function', 'DSH requires output { schema, render }');
        tools.set(def.name, def);
        return () => { tools.delete(def.name); };
      },
    },
    effect(fn: () => () => void) { disposers.push(fn()); },
  };
  return {
    ctx, tools, prompts, logs, listeners, postExecutes, emit, turn,
    /** Starts the plugin with `registry` as its ORRERY_REGISTRY (a test Hub's, or a fixture's). */
    start: (registry: string, retryMs = RETRY_MS, turnWaitMs?: number, activityHeartbeatMs?: number) =>
      plugin.start(ctx, { env: { ORRERY_REGISTRY: registry }, retryMs, turnWaitMs, activityHeartbeatMs }),
    dispose() {
      for (const d of disposers.reverse()) d();
      disposers = [];
    },
    /** A tool call as the DSH agent of `sessionId` makes it. Resolves with the text, rejects with the error text. */
    call: (tool: string, args: unknown, sessionId?: string, signal: AbortSignal | undefined = new AbortController().signal) =>
      tools.get(`mcp__orrery__${tool}`).execute(args, { agent: sessionId === undefined ? undefined : { id: sessionId }, signal }),
  };
}

/** A Hub with the real deepseek adapter over the fixtures; cluster "ds": D1 (S1), D2 (S2) and mock A. */
async function deepseekHub(dir = tempDir(), turnWaitMs?: number) {
  const app = await startTestHub({ dir, nativeAdapters: { deepseek: createDeepseekNativeAdapter({ dshHome: DSH_HOME, turnWaitMs }) }, limits: { recheckMs: 60_000 } });
  return app;
}

async function dsCluster(app: TestHub) {
  const { cluster, members: [d1, d2, a] } = await app.api('POST', '/api/clusters', {
    name: 'ds',
    members: [
      { harness: 'deepseek', mode: 'native', sessionId: S1, name: 'D1' },
      { harness: 'deepseek', mode: 'native', sessionId: S2, name: 'D2' },
      { harness: 'mock', mode: 'native', name: 'A', projectPath: '/work' },
    ],
  });
  return { cluster, d1, d2, a };
}

const statusOf = async (app: TestHub, id: string) =>
  ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status;
const deliveryTo = async (app: TestHub, clusterId: string, messageId: string, memberId: string) =>
  (await app.messages(clusterId)).find((m) => m.id === messageId)?.deliveries.find((d) => d.memberId === memberId);

test('dsh activity: collects only eligible sessions, normalizes native and PTC events, and stops on disposal', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh();
  try {
    const { cluster, d1, d2 } = await dsCluster(app);
    dsh.start(app.registryDir, RETRY_MS, undefined, 40);
    await waitFor(() => app.hub.bridge.isOnline('deepseek', S1), 'DSH bridge');
    dsh.emit(S1, { type: 'tool/call', data: { callId: 'before', name: 'bash', arguments: 'private-before' } });
    assert.equal(app.hub.activityFor(d1.id).state, 'unknown', 'joining does not enable observation');
    app.hub.sendFromMember(d1.id, 'participated');
    await waitFor(() => app.hub.activityFor(d1.id).state === 'observing', 'eligible DSH heartbeat');
    const expected = async (phase: string, toolName: string | null) => waitFor(() => {
      const event = app.hub.activityFor(d1.id).event;
      return event?.kind === 'tool' && event.phase === phase && event.toolName === toolName;
    }, `tool ${phase} ${toolName}`);

    dsh.emit(S1, { type: 'tool/call', data: { callId: 'one', name: 'bash', arguments: { command: 'private-command' } } });
    await expected('requested', 'bash');
    dsh.emit(S1, { type: 'tool/call', data: { callId: 'two', name: 'read', arguments: { path: '/private-path' } } });
    await expected('requested', 'read');
    dsh.emit(S1, { type: 'tool/result', data: { message: { toolCallId: 'one', isError: true, content: 'private-output' } } });
    await expected('failed', 'bash');
    dsh.emit(S1, { type: 'tool/result', data: { message: { source: { callId: 'two' }, isError: false, content: 'private-output' } } });
    await expected('finished', 'read');
    dsh.emit(S1, { type: 'tool/ptc-dispatch-start', data: { subCallId: 'p1', name: 'search', arguments: 'private-args' } });
    await expected('started', 'search');
    dsh.emit(S1, { type: 'tool/ptc-dispatch', data: { subCallId: 'p1', name: 'search', isError: true, content: 'private-output' } });
    await expected('failed', 'search');
    dsh.emit(S1, { type: 'tool/call', data: { callId: 'bad', name: '../private-name', arguments: 'private-args' } });
    await expected('requested', null);
    dsh.emit(S2, { type: 'tool/call', data: { callId: 'other', name: 'other-tool', arguments: 'private-other' } });
    assert.equal(app.hub.activityFor(d2.id).state, 'unknown', 'an unqualified session stays unobserved');
    dsh.emit(S1, { type: 'turn/start', data: { turn: 1 } });
    await waitFor(() => app.hub.activityFor(d1.id).event?.kind === 'turn', 'turn start');
    dsh.emit(S1, { type: 'turn/end', data: { reason: { kind: 'error', message: 'private-error' } } });
    await waitFor(() => app.hub.activityFor(d1.id).event?.phase === 'failed', 'turn failure');
    const last = app.hub.activityFor(d1.id);
    const historySeq = app.store.lastEventSeq();
    await waitFor(() => (app.hub.activityFor(d1.id).lastSeenAt ?? '') > (last.lastSeenAt ?? ''), 'heartbeat refresh');
    assert.equal(app.hub.activityFor(d1.id).lastActivityAt, last.lastActivityAt);
    assert.equal(app.store.lastEventSeq(), historySeq, 'heartbeats do not grow the event history');
    const outputs = JSON.stringify([await app.api('GET', `/api/activity?cluster=${cluster.id}`),
      app.store.db.prepare('SELECT * FROM activity_snapshots').all()]);
    assert.doesNotMatch(outputs, /private-|other-tool/);
    dsh.dispose();
    await waitFor(() => app.hub.activityFor(d1.id).state === 'disconnected', 'DSH observer disconnected');
    dsh.emit(S1, { type: 'turn/start', data: { turn: 2 } });
    assert.deepEqual(app.hub.activityFor(d1.id).event, last.event, 'disposed plugin reports no later activity');
  } finally { dsh.dispose(); await app.close(); }
});

test('dsh activity: an older Hub without target frames still completes deliveries', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh();
  const connect = app.hub.connectBridge;
  app.hub.connectBridge = function (harness, sessionId, conn) {
    const { sendActivity: _ignored, ...legacy } = conn;
    return connect.call(this, harness, sessionId, legacy);
  };
  try {
    const { cluster, d1 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(() => app.hub.bridge.isOnline('deepseek', S1), 'legacy bridge online');
    const message = app.hub.sendFromUser(cluster.id, '@D1 old hub');
    await waitFor(async () => (await deliveryTo(app, cluster.id, message.id, d1.id))?.outcome === 'completed', 'legacy delivery completed');
    assert.equal(dsh.prompts.length, 1);
    assert.equal(app.hub.activityFor(d1.id).state, 'unknown');
  } finally { dsh.dispose(); await app.close(); }
});

test('dsh activity: the first delivery enables observation before the turn starts', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh();
  try {
    const { cluster, d1 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(() => app.hub.bridge.isOnline('deepseek', S1), 'DSH bridge online');
    assert.equal(app.hub.activityFor(d1.id).state, 'unknown');
    const message = app.hub.sendFromUser(cluster.id, '@D1 first delivery');
    await waitFor(async () => (await deliveryTo(app, cluster.id, message.id, d1.id))?.outcome === 'completed', 'first delivery completed');
    await waitFor(() => app.hub.activityFor(d1.id).event?.kind === 'turn'
      && app.hub.activityFor(d1.id).event?.phase === 'finished', 'first turn observed');
  } finally { dsh.dispose(); await app.close(); }
});

function observedEnds(app: TestHub): DoneEnd[] {
  const results: DoneEnd[] = [];
  const wait = app.hub.bridge.waitDone;
  app.hub.bridge.waitDone = async (...args) => {
    const result = await wait(...args);
    results.push(result);
    return result;
  };
  return results;
}

test('dsh plugin: tool names and DSH subset preserve Hub validation; package is self-contained', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh();
  try {
    await dsCluster(app);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const res = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, 'x-orrery-session': S1, 'x-orrery-harness': 'deepseek' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const hubTools = (await res.json()).result.tools;
    const create = hubTools.find((t: any) => t.name === 'create_task');
    const action = hubTools.find((t: any) => t.name === 'task_action');
    const roles = hubTools.find((t: any) => t.name === 'manage_roles');
    assert.ok(create.inputSchema.properties.originMessageId);
    assert.equal(create.inputSchema.properties.proposalState, undefined);
    assert.equal(action.inputSchema.properties.originMessageId, undefined);
    assert.equal(action.inputSchema.properties.proposalState, undefined, 'proposal approval is user-only');
    for (const field of ['requiresApproval', 'mergeRequired']) {
      assert.equal(create.inputSchema.properties[field].type, 'boolean');
      assert.equal(action.inputSchema.properties[field].type, 'boolean');
    }
    assert.equal(action.inputSchema.properties.commitSha.type, 'string');
    assert.equal(action.inputSchema.properties.reason.maxLength, 50_000);
    assert.ok(action.inputSchema.properties.action.enum.includes('merge'));
    assert.ok(action.inputSchema.properties.action.enum.includes('set_git_branch'));
    assert.ok(!action.inputSchema.properties.action.enum.includes('approve'));
    assert.ok(hubTools.find((t: any) => t.name === 'list_tasks').inputSchema.properties.status.enum.includes('merged'));
    for (const field of ['memberId', 'assignmentId', 'summary', 'evidenceMessageIds', 'evidenceFileIds',
      'expectedDependencyVersions', 'get_task_context', 'submissionId', 'verdict', 'reason']) assert.ok(action.description.includes(field), field);
    for (const field of ['name', 'roleId', 'memberId', 'roleIds', 'description']) assert.ok(roles.description.includes(field), field);
    dsh.start(app.registryDir);
    const registered = [...dsh.tools.values()];
    const asHub = (t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    assert.deepEqual(plugin.TOOLS.map(asHub), hubTools.map(asHub), 'the plugin retains the Hub schemas');
    assert.deepEqual(
      registered.map((d) => ({ name: d.name.replace(/^mcp__orrery__/, ''), description: d.description, inputSchema: d.parameters })).sort((a, b) => a.name.localeCompare(b.name)),
      hubTools.map((t: any) => ({ ...asHub(t), inputSchema: plugin.projectToolParameters(t.inputSchema) })).sort((a: any, b: any) => a.name.localeCompare(b.name)),
    );
    const params = (name: string) => dsh.tools.get(`mcp__orrery__${name}`).parameters;
    assert.equal(params('get_batch').properties.batchId.type, 'string');
    assert.ok(params('manage_batch').properties.action.enum.includes('merge'));
    assert.deepEqual(params('task_action').properties.gitBranch.oneOf, [
      { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'], additionalProperties: false },
      { type: 'null' },
    ]);
    assert.deepEqual(params('create_task').properties.originMessageId.oneOf, [{ type: 'string' }, { type: 'null' }]);
    assert.deepEqual(params('create_task').properties.reviewer.oneOf.map((s: any) => s.properties.kind.const), ['user', 'member', 'self']);
    const versions = params('task_action').properties.expectedDependencyVersions;
    assert.equal(versions.additionalProperties, true);
    assert.match(versions.description, /Values must be strings/);
    assert.equal(params('send_message').properties.attachments.maxItems, undefined);
    assert.equal(hubTools.find((t: any) => t.name === 'send_message').inputSchema.properties.attachments.maxItems, 10);
    await assert.rejects(dsh.call('send_message', { body: 'too many', attachments: Array(11).fill('x') }, S1), /attachments|10|too big/i);
    assert.ok(registered.every((d) => d.name.startsWith('mcp__orrery__')), 'DSH itself holds send_message and list_agents');
  } finally {
    dsh.dispose();
    await app.close();
  }

  // The package: a DSH bundle with its own metadata, no dependencies, and nothing imported from outside its folder.
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-orrery');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.match(pkg.engines.dsh, /^>=0\.2\.1-rc\.2 /);
  for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[k], undefined, k);
  assert.match(readFileSync(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8'), /^- insert:\n {4}- id: dsh-orrery\n {6}name: dsh-orrery$/m);
  for (const lang of ['en', 'zh']) assert.ok(JSON.parse(readFileSync(join(PLUGIN_DIR, 'locale', `${lang}.json`), 'utf8')).meta.title);
  const code = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  const imports = [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  // Its own copy of the shared discovery module (test/hub-discovery-client.test.ts checks it), else Node built-ins.
  assert.deepEqual(imports.filter((s) => !s.startsWith('node:')), ['./hub-discovery.mjs'], 'Node built-ins only');
  assert.doesNotMatch(code, /\bfetch\(/, 'no fetch: it would honour NODE_USE_ENV_PROXY and send the secret to a proxy');
  assert.deepEqual([plugin.name, plugin.inject], ['dsh-orrery', ['sessionController', 'tools']]);
});

test('dsh plugin: a delivery becomes a queued prompt with requestId = deliveryId and is acked; a prompt error fails it', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh(async (p) => {
    if (p.content[0].text.includes('busy')) throw Object.assign(new Error('Session is held by another writer'), { code: 'session/writer-held' });
    return { accepted: true };
  });
  try {
    const { cluster, d1, d2 } = await dsCluster(app);
    assert.equal(await statusOf(app, d1.id), 'offline', 'no plugin yet');
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle' && (await statusOf(app, d2.id)) === 'idle', 'both online');

    const m1 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'hello d1', to: [d1.id] });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m1.id, d1.id))?.state === 'done', 'd1 done');
    assert.equal(dsh.prompts.length, 1);
    const [p] = dsh.prompts;
    assert.deepEqual({ ...p, requestId: typeof p.requestId }, { requestId: 'string', sessionId: S1, mode: 'queue', content: [{ type: 'text', text: 'hello d1' }] });
    assert.equal(p.requestId, (await deliveryTo(app, cluster.id, m1.id, d1.id))!.batchId, 'requestId is the deliveryId (batch id)');

    const m2 = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@D2 you are busy' });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m2.id, d2.id))?.state === 'failed', 'd2 failed');
    assert.equal((await deliveryTo(app, cluster.id, m2.id, d2.id))!.error, 'session/writer-held: Session is held by another writer');
    assert.equal(dsh.prompts.at(-1)!.sessionId, S2);
    await waitFor(() => app.settled(cluster.id), 'settled');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: the tools speak as the calling session; no session id or no member is an error', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh();
  try {
    const { cluster, d1, a } = await dsCluster(app);
    dsh.start(app.registryDir);
    assert.deepEqual(JSON.parse(await dsh.call('list_agents', {}, S1)).map((m: any) => m.name), ['D1', 'D2', 'A']);
    const observed = app.hub.toolVersionReport().find((row) => row.memberId === d1.id)?.observation;
    const versions = await app.api('GET', '/api/tool-versions');
    assert.equal(observed?.bridge?.source, 'dsh-source');
    assert.equal(observed?.bridge?.fingerprint, versions.hub.standard);
    assert.equal(observed?.bridge?.registered?.succeeded, observed?.bridge?.registered?.total);
    assert.equal(observed?.client, null);
    const task = JSON.parse(await dsh.call('create_task', { operationId: 'dsh-create', title: 'Task', scope: 'Scope', acceptance: 'Done', memberId: a.id }, S1));
    assert.equal(task.task.createdBy, d1.id, 'the plugin attributes the task to its calling session');
    const sent = JSON.parse(await dsh.call('send_message', { body: '@A hi from D1' }, S1));
    assert.deepEqual(sent.deliveredTo, ['A']);
    assert.equal((await app.messages(cluster.id)).at(-1)!.from, d1.id);
    assert.deepEqual(JSON.parse(await dsh.call('ack_messages', { messageIds: [sent.messageId] }, S2)), { acknowledged: [sent.messageId] });
    await waitFor(() => app.settled(cluster.id), 'A replied');
    const unread = JSON.parse(await dsh.call('read_messages', {}, S1));
    // D2 acknowledged D1's message: no receipt message is written; the acknowledgement is on D1's own message.
    assert.ok(unread.every((m: any) => m.from === 'A'), 'D1 reads what concerns it');
    assert.deepEqual(JSON.parse(await dsh.call('read_messages', { history: true, category: 'receipt_warning' }, S1)), []);
    const own = JSON.parse(await dsh.call('read_messages', { history: true }, S1)).find((m: any) => m.id === sent.messageId);
    assert.deepEqual(own.acknowledgements.map((ack: any) => ack.member), ['D2'], 'the sender sees who acknowledged it');
    assert.equal(JSON.parse(await dsh.call('read_messages', { history: true, limit: 1 }, S1)).length, 1);

    await assert.rejects(dsh.call('send_message', { body: 'x' }, S4), { message: '这个对话还不是任何 orrery 集群的成员' });
    await assert.rejects(dsh.call('send_message', { body: 'x' }, a.workerSessionId), /不是任何 orrery 集群的成员/, 'a mock member is no deepseek session');
    await assert.rejects(dsh.call('send_message', { body: 'x' }), /拿不到调用方会话的 ID/);
    await assert.rejects(dsh.call('send_message', {}, S1), (e: Error) => /body/.test(e.message), 'the Hub validates the arguments');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: Hub down → tools say so and it keeps retrying; it reconnects when the Hub comes back on another port', async () => {
  const dir = tempDir();
  const first = await deepseekHub(dir);
  const { cluster, d1 } = await dsCluster(first);
  const registry = first.registryDir;
  await first.close();   // its registry record is gone
  const dsh = fakeDsh();
  let second: TestHub | undefined;
  try {
    dsh.start(registry);
    await assert.rejects(dsh.call('list_agents', {}, S1), { message: NOT_SENT });
    await new Promise((ok) => setTimeout(ok, RETRY_MS * 3));
    assert.equal(dsh.logs.filter((l) => /未找到活动 Hub/.test(l)).length, 1, 'reported once, not on every retry');
    second = await deepseekHub(dir);
    assert.notEqual(second.url, first.url);
    await waitFor(async () => (await statusOf(second!, d1.id)) === 'idle', 'online through the new Hub');
    const m = await second.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'back again', to: [d1.id] });
    await waitFor(async () => (await deliveryTo(second!, cluster.id, m.id, d1.id))?.state === 'done', 'delivered');
    assert.equal(JSON.parse(await dsh.call('list_agents', {}, S1)).length, 3);
  } finally {
    dsh.dispose();
    await second?.close();
  }
});

test('dsh plugin: disabling it (dispose) closes the stream, unregisters the tools and stops reconnecting; enabling it again restores all', async () => {
  const dir = tempDir();
  let app = await deepseekHub(dir);
  const dsh = fakeDsh();
  try {
    const { cluster, d1 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    assert.equal(dsh.tools.size, 23);

    dsh.dispose();
    assert.equal(dsh.tools.size, 0, 'tools unregistered');
    await waitFor(async () => (await statusOf(app, d1.id)) === 'offline', 'offline once disabled');
    const off = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'while disabled', to: [d1.id] });
    assert.equal((await deliveryTo(app, cluster.id, off.id, d1.id))!.state, 'offline');
    // No retry timer survives: a Hub that comes up on another port is never reached.
    await app.close();
    app = await deepseekHub(dir);
    await new Promise((ok) => setTimeout(ok, RETRY_MS * 5));
    assert.equal(await statusOf(app, d1.id), 'offline', 'no reconnect after dispose');
    assert.equal(dsh.prompts.length, 0);

    dsh.start(app.registryDir);   // enabled again
    assert.equal(dsh.tools.size, 23, 'tools back');
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online again');
    const m = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'welcome back', to: [d1.id] });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m.id, d1.id))?.state === 'done', 'delivered');
    assert.deepEqual(dsh.prompts.map((p) => p.content[0].text), ['welcome back'], 'nothing from the disabled time is replayed');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: a tool call started just before the plugin is disabled sends nothing to the Hub', async () => {
  // A plain HTTP server stands in for the Hub and counts every request it gets.
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const registry = join(tempDir(), 'registry');
  writeRegistry(registry, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const dsh = fakeDsh();
  try {
    dsh.start(registry);
    // Both calls have started; the plugin is disabled before either reaches the Hub.
    const calls = [dsh.call('send_message', { body: 'late' }, S1), dsh.call('list_agents', {}, S1, undefined)];
    dsh.dispose();
    // Wait on both at once: awaiting one by one leaves the other's rejection briefly unhandled.
    await Promise.all(calls.map((c) => assert.rejects(c, (e: Error) => e.name === 'AbortError', 'the call is aborted')));
    await new Promise((ok) => setTimeout(ok, RETRY_MS * 3));
    assert.deepEqual(requests, [], 'no request after dispose, neither the tool calls nor the stream');
  } finally {
    dsh.dispose();
    await new Promise((ok) => server.close(ok));
  }
});

test('dsh plugin: retrying while the Hub is down does not pile up abort listeners', async () => {
  // Record every AbortSignal the plugin hangs an abort listener on, to count what stays attached.
  const signals = new Set<AbortSignal>();
  let added = 0;
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: any[]) {
    if (type === 'abort' && this instanceof AbortSignal) (signals.add(this), added++);
    return (original as any).call(this, type, ...rest);
  } as typeof original;
  const dsh = fakeDsh();
  try {
    dsh.start(tempDir(), 1);   // no registry: retry every 1 ms
    await waitFor(() => added >= 20, 'many retries');
    const attached = () => [...signals].reduce((n, s) => n + getEventListeners(s, 'abort').length, 0);
    assert.ok(attached() <= 1, `abort listeners after ${added} retries: ${attached()}`);
  } finally {
    EventTarget.prototype.addEventListener = original;
    dsh.dispose();
  }
});

// ───────────── busy sessions: the Hub waits for the turn end, so messages arriving meanwhile come together ─────────────

const headers = (p: Prompt) => (p.content[0].text.match(/^\[orrery\] /gm) ?? []).length;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const post = (app: TestHub, clusterId: string, body: string) => app.api('POST', `/api/clusters/${clusterId}/messages`, { body });
async function bridgePost(app: TestHub, path: string, body: unknown, secret?: string) {
  const s = secret ?? JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret;
  const res = await fetch(`${app.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-bridge': s }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('dsh plugin: 3 messages 200 ms apart to a busy session reach DSH as two prompts, 1 then 2, each after the turn before ends', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh(undefined, { autoTurn: false });
  try {
    const { cluster, d1 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    const m1 = await post(app, cluster.id, '@D1 one');
    await waitFor(() => dsh.prompts.length === 1, 'first prompt');
    for (const body of ['@D1 two', '@D1 three']) {
      await sleep(200);
      await post(app, cluster.id, body);
    }
    await sleep(200);
    assert.equal(dsh.prompts.length, 1, 'held by the Hub while the turn of the first runs');
    assert.equal((await deliveryTo(app, cluster.id, m1.id, d1.id))!.state, 'running', 'the member is busy until its turn ends');

    dsh.turn(S1, null);   // a turn the user typed ends first: not the delivery's
    await sleep(200);
    assert.equal(dsh.prompts.length, 1, 'only the turn that ran the delivery counts');
    dsh.turn(S1, dsh.prompts[0].requestId);
    await waitFor(() => dsh.prompts.length === 2, 'second prompt');
    assert.equal((await deliveryTo(app, cluster.id, m1.id, d1.id))!.state, 'done');
    assert.deepEqual(dsh.prompts.map(headers), [1, 2], 'two and three in one envelope');
    assert.match(dsh.prompts[1].content[0].text, /two[\s\S]*three/);
    dsh.turn(S1, dsh.prompts[1].requestId);
    await waitFor(() => app.settled(cluster.id), 'settled');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: without session events the ack promises nothing and every message is its own prompt (as before)', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh(undefined, { autoTurn: false, events: false });
  try {
    const { cluster, d1 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    for (const body of ['@D1 one', '@D1 two', '@D1 three']) {
      await post(app, cluster.id, body);
      await sleep(200);
    }
    await waitFor(() => app.settled(cluster.id), 'settled');
    assert.deepEqual(dsh.prompts.map(headers), [1, 1, 1]);
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: a matched turn reports its actual end reason; an observation timeout is unknown', async () => {
  const app = await deepseekHub();
  const ends = observedEnds(app);
  const dsh = fakeDsh(undefined, { autoTurn: false });
  try {
    const { cluster, d1 } = await dsCluster(app);
    dsh.start(app.registryDir, RETRY_MS, 1000);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    const cases = [
      ['completed', { outcome: 'completed' }],
      ['error', { outcome: 'failed', error: 'DeepSeek turn failed' }],
      ['aborted', { outcome: 'failed', error: 'DeepSeek turn was interrupted' }],
      ['other', { outcome: 'unknown', error: 'DeepSeek turn ended with an unknown reason' }],
    ] as const;
    for (const [index, [kind, expected]] of cases.entries()) {
      const m = await post(app, cluster.id, `@D1 ${kind}`);
      await waitFor(() => dsh.prompts.length === index + 1, 'prompted');
      dsh.turn(S1, dsh.prompts[index].requestId, kind);
      await waitFor(() => ends.length === index + 1, 'turn result');
      assert.deepEqual(ends[index], expected);
      const delivery = await waitFor(async () => {
        const d = await deliveryTo(app, cluster.id, m.id, d1.id);
        return d?.state === (expected.outcome === 'completed' ? 'done' : 'failed') ? d : null;
      }, 'settled');
      assert.equal(delivery.outcome, expected.outcome);
    }
    const timed = await post(app, cluster.id, '@D1 wait');
    await waitFor(() => dsh.prompts.length === cases.length + 1, 'last prompt');
    await waitFor(() => ends.length === cases.length + 1, 'plugin timeout');
    assert.deepEqual(ends.at(-1), { outcome: 'unknown', error: 'DeepSeek turn observation timed out' });
    const delivery = await waitFor(async () => {
      const d = await deliveryTo(app, cluster.id, timed.id, d1.id);
      return d?.state === 'failed' ? d : null;
    }, 'timeout result');
    assert.equal(delivery.outcome, 'unknown');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: a repeated delivery ID replays the cached result without prompting again', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh(undefined, { autoTurn: false });
  try {
    const { d1 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    const send = () => app.hub.bridge.push('deepseek', S1, 'repeat-id', 'hi');
    assert.deepEqual(await send(), { ok: true, follows: true });
    const first = app.hub.bridge.waitDone('deepseek', S1, 'repeat-id', 1000, new AbortController().signal);
    dsh.turn(S1, 'repeat-id', 'error');
    assert.deepEqual(await first, { outcome: 'failed', error: 'DeepSeek turn failed' });
    assert.deepEqual(await send(), { ok: true, follows: true });
    assert.deepEqual(await app.hub.bridge.waitDone('deepseek', S1, 'repeat-id', 1000, new AbortController().signal),
      { outcome: 'failed', error: 'DeepSeek turn failed' });
    assert.equal(dsh.prompts.length, 1);
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: an unrelated aborted turn leaves the unobserved delivery outcome unknown', async () => {
  const app = await deepseekHub();
  const ends = observedEnds(app);
  const dsh = fakeDsh(undefined, { autoTurn: false });
  try {
    const { cluster, d1 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    const m = await post(app, cluster.id, '@D1 queued behind the user');
    await waitFor(() => dsh.prompts.length === 1, 'prompted');
    dsh.turn(S2, null, 'aborted');   // another session's stop: not this one
    await sleep(200);
    assert.equal((await deliveryTo(app, cluster.id, m.id, d1.id))!.state, 'running');
    dsh.turn(S1, null, 'aborted');
    await waitFor(() => ends.length === 1, 'released');
    assert.deepEqual(ends[0], { outcome: 'unknown', error: 'DeepSeek stopped before this delivery was observed; its outcome is unknown' });
    const delivery = await waitFor(async () => {
      const d = await deliveryTo(app, cluster.id, m.id, d1.id);
      return d?.state === 'failed' ? d : null;
    }, 'unknown delivery');
    assert.equal(delivery.outcome, 'unknown');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('deepseek: a lost connection or a time limit stops the wait; removing a member cancels it', async () => {
  // The plugin goes away (disabled, DSH quits): its stream drops, so no done can come.
  {
    const app = await deepseekHub();
    const dsh = fakeDsh(undefined, { autoTurn: false });
    try {
      const { cluster, d1 } = await dsCluster(app);
      dsh.start(app.registryDir);
      await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
      const m = await post(app, cluster.id, '@D1 hi');
      await waitFor(async () => dsh.prompts.length === 1 && (await deliveryTo(app, cluster.id, m.id, d1.id))?.state === 'running', 'waiting');
      dsh.dispose();
      await waitFor(async () => (await deliveryTo(app, cluster.id, m.id, d1.id))?.state === 'failed', 'finished once the stream drops');
      assert.equal((await deliveryTo(app, cluster.id, m.id, d1.id))?.outcome, 'unknown');
      assert.equal(dsh.listeners.size, 0, 'session events unsubscribed');
      assert.equal(dsh.postExecutes.size, 0, 'the unread hint hook unsubscribed');
    } finally {
      dsh.dispose();
      await app.close();
    }
  }
  // A turn end that never comes (missed, or a redo the plugin cannot match): the time limit frees the member.
  {
    const app = await deepseekHub(tempDir(), 300);
    const dsh = fakeDsh(undefined, { autoTurn: false });
    try {
      const { cluster, d1 } = await dsCluster(app);
      dsh.start(app.registryDir);
      await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
      const m = await post(app, cluster.id, '@D1 hi');
      await waitFor(() => dsh.prompts.length === 1, 'prompted');
      await sleep(100);
      assert.equal((await deliveryTo(app, cluster.id, m.id, d1.id))!.state, 'running');
      await waitFor(async () => (await deliveryTo(app, cluster.id, m.id, d1.id))?.state === 'failed', 'finished after the limit');
      assert.equal((await deliveryTo(app, cluster.id, m.id, d1.id))?.outcome, 'unknown');
      await post(app, cluster.id, '@D1 next');
      await waitFor(() => dsh.prompts.length === 2, 'the member takes the next message');
    } finally {
      dsh.dispose();
      await app.close();
    }
  }
  // The member is removed while it waits (the run is aborted); then the Hub closes while another member waits.
  {
    const app = await deepseekHub();
    let closing: Promise<void> | undefined;
    const dsh = fakeDsh(undefined, { autoTurn: false });
    try {
      const { cluster, d1, d2 } = await dsCluster(app);
      dsh.start(app.registryDir);
      await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
      const m = await post(app, cluster.id, '@D1 @D2 hi');
      await waitFor(() => dsh.prompts.length === 2, 'both prompted');
      await app.api('DELETE', `/api/clusters/${cluster.id}/members/${d1.id}`, {});
      assert.equal((await deliveryTo(app, cluster.id, m.id, d2.id))!.state, 'running');
      const t = Date.now();
      closing = app.close();
      await closing;
      assert.ok(Date.now() - t < 3000, 'close does not wait for the turn');
    } finally {
      dsh.dispose();
      await (closing ?? app.close());
    }
  }
});

test('bridge: /bridge/done ends only the wait of that delivery in its own session; unknown, finished or other-session reports are ignored; bad requests refused', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh(undefined, { autoTurn: false });
  try {
    const { cluster, d1, d2 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    const first = await post(app, cluster.id, '@D2 finished one');
    await waitFor(() => dsh.prompts.length === 1, 'd2 prompted');
    dsh.turn(S2, dsh.prompts[0].requestId);
    await waitFor(async () => (await deliveryTo(app, cluster.id, first.id, d2.id))?.state === 'done', 'd2 done');

    const m = await post(app, cluster.id, '@D1 hi');
    await waitFor(() => dsh.prompts.length === 2, 'd1 prompted');
    const id = dsh.prompts[1].requestId;
    assert.equal(dsh.prompts[1].sessionId, S1);
    const done = (deliveryId: string, sessionId = S1, harness = 'deepseek') => bridgePost(app, '/bridge/done', { deliveryId, harness, sessionId });
    assert.deepEqual(await done('no-such-delivery'), { status: 200, body: { done: false } });
    assert.deepEqual(await done(dsh.prompts[0].requestId, S2), { status: 200, body: { done: false } }, 'a finished delivery');
    // A report from another session or harness does not end this wait, even with the right delivery id.
    assert.deepEqual(await done(id, S2), { status: 200, body: { done: false } }, 'another session');
    assert.deepEqual(await done(id, S1, 'claude'), { status: 200, body: { done: false } }, 'another harness');
    assert.equal((await bridgePost(app, '/bridge/done', {})).status, 400);
    assert.equal((await bridgePost(app, '/bridge/done', { deliveryId: id })).status, 400, 'harness and session are required');
    assert.equal((await bridgePost(app, '/bridge/done', { deliveryId: id, harness: 'deepseek', sessionId: S1 }, 'wrong-secret')).status, 401);
    assert.equal((await bridgePost(app, '/bridge/ack', { deliveryId: 'x', ok: true, follows: 'yes' })).status, 400);
    await sleep(100);
    assert.equal((await deliveryTo(app, cluster.id, m.id, d1.id))!.state, 'running', 'still waiting');
    assert.deepEqual(await done(id), { status: 200, body: { done: true } });
    await waitFor(async () => (await deliveryTo(app, cluster.id, m.id, d1.id))?.state === 'failed', 'legacy done has unknown outcome');
    assert.equal((await deliveryTo(app, cluster.id, m.id, d1.id))?.outcome, 'unknown');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin: a Hub restart leaves in-flight deliveries unknown and does not prompt again', async () => {
  const dir = tempDir();
  const hubAt = () => startTestHub({ dir, nativeAdapters: { deepseek: createDeepseekNativeAdapter({ dshHome: DSH_HOME }) }, limits: { recheckMs: 60_000, startupGraceMs: 5000 } });
  let app = await hubAt();
  const dsh = fakeDsh(undefined, { autoTurn: false });
  try {
    const { cluster, d1, d2 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    const m = await post(app, cluster.id, '@D1 @D2 long job');
    await waitFor(() => dsh.prompts.length === 2, 'both prompted');
    const [p1, p2] = [S1, S2].map((s) => dsh.prompts.find((p) => p.sessionId === s)!);
    await app.close();   // both deliveries stay 'running' until restart recovery
    dsh.turn(S2, p2.requestId);   // D2's turn ends while no Hub runs
    app = await hubAt();
    for (const member of [d1, d2]) {
      const delivery = await deliveryTo(app, cluster.id, m.id, member.id);
      assert.equal(delivery?.state, 'failed');
      assert.equal(delivery?.outcome, 'unknown');
    }
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'plugin reconnected');
    assert.equal(dsh.prompts.length, 2, 'nothing prompted twice after the Hub restart');
    dsh.turn(S1, p1.requestId);
    await sleep(100);
    assert.equal((await deliveryTo(app, cluster.id, m.id, d1.id))?.outcome, 'unknown', 'a late report cannot rewrite the recovered result');
  } finally {
    dsh.dispose();
    await app.close();
  }
});

test('dsh plugin usage: the model calls of the delivery\'s turn are summed and sent with /bridge/done; the Hub records them for the member', async () => {
  const app = await deepseekHub();
  const dsh = fakeDsh(undefined, { autoTurn: false });
  try {
    const { cluster, d1, d2 } = await dsCluster(app);
    dsh.start(app.registryDir);
    await waitFor(async () => (await statusOf(app, d1.id)) === 'idle', 'online');
    await post(app, cluster.id, '@D1 count me');
    await waitFor(() => dsh.prompts.length === 1, 'prompt');
    const rpcId = dsh.prompts[0].requestId;
    const call = (type: string, data: unknown) => dsh.emit(S1, { type, data });
    call('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 999, outputTokens: 999 } });   // before its turn: not counted
    call('turn/start', { turn: 2 });
    call('user/message', { content: [], source: { kind: 'user', rpcId } });
    call('assistant/message', { turn: 2, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5000, cacheWriteTokens: 0, reasoningTokens: 4 } });
    call('assistant/attempt', { turn: 2, step: 2, stream: [{ type: 'chunk', chunk: { type: 'text' } }, { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } } }] });
    dsh.emit(S2, { type: 'assistant/message', data: { usage: { inputTokens: 5555, outputTokens: 5 } } });   // another session
    call('turn/end', { turn: 2, reason: { kind: 'completed' } });
    await waitFor(() => app.settled(cluster.id), 'done');
    const r = await waitFor(async () => {
      const u = await app.api('GET', `/api/usage?cluster=${cluster.id}`);
      return u.members.find((m: any) => m.memberId === d1.id).viaOrrery ? u : null;
    }, 'recorded');
    assert.deepEqual(r.members.find((m: any) => m.memberId === d1.id).viaOrrery, { totals: { input: 107, cachedInput: 5000, cacheWrite: 0, output: 11, reasoning: 4 }, turns: 1 });
    assert.equal(r.members.find((m: any) => m.memberId === d2.id).viaOrrery, null);
    assert.deepEqual(r.quotas.find((q: any) => q.harness === 'deepseek'), { harness: 'deepseek', supported: false, snapshot: null });
  } finally {
    dsh.dispose();
    await app.close();
  }
});
