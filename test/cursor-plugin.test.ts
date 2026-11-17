// The Cursor plugin's real scripts (plugins/cursor-orrery) as child processes against a test Hub, fed hook inputs shaped
// like Cursor's (docs/adapters/cursor.md, "已测到的事实"; every value here is made up). A recording relay sits between
// the scripts and the Hub so the privacy checks see every request. Nothing here runs Cursor or reads its data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createCursorNativeAdapter } from '../src/adapters/cursor/native.ts';
import type { Member } from '../src/core/types.ts';
import { REPO_ROOT } from '../src/main.ts';
import { freePort, startTestHub, tempDir, waitFor } from './helpers.ts';

const PLUGIN = join(REPO_ROOT, 'plugins', 'cursor-orrery');
const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const OUTSIDER = 'cccccccc-3333-4333-8333-333333333333';
const EMAIL = 'someone@example.invalid';
const PROMPT_SECRET = 'my private prompt about the launch';
const ANSWER_SECRET = 'the private answer text';
const TRANSCRIPT = 'C:\\private\\transcripts\\conversation.jsonl';

/** A hook input shaped like Cursor 3.29.9's, with the private fields filled in. */
const hookInput = (conversationId: string, extra: Record<string, unknown> = {}) => ({
  conversation_id: conversationId, session_id: conversationId, generation_id: 'gen-1', model: 'some-model', cursor_version: '3.29.9',
  workspace_roots: ['C:\\private\\project'], transcript_path: TRANSCRIPT, user_email: EMAIL, hook_event_name: 'stop', ...extra,
});

/** A relay that records every request (path, headers, body) and forwards it to the Hub. */
async function recorder(target: string) {
  const seen: { path: string; body: string; headers: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ path: req.url!, body, headers: req.headers });
      const { host: _host, ...headers } = req.headers;   // the Hub checks Host: let the request carry its own address
      // A fresh connection each time (agent: false): no pooled socket is shared between a stream and a request.
      const out = request(`${target}${req.url}`, { method: req.method, headers, agent: false }, (r) => {
        res.writeHead(r.statusCode!, r.headers);
        r.pipe(res);
      });
      out.on('error', () => res.destroy());
      res.on('close', () => out.destroy());
      out.end(body);
    });
  });
  const port = await freePort();
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}

async function pHub(opts: { port?: number; dir?: string } = {}) {
  const fake = tempDir();   // a fake ~/.cursor with the member's transcript, so it can be attached
  mkdirSync(join(fake, 'projects', 'c-work', 'agent-transcripts', S1), { recursive: true });
  writeFileSync(join(fake, 'projects', 'c-work', 'agent-transcripts', S1, `${S1}.jsonl`), `${JSON.stringify({ role: 'user', message: { content: 'hi' } })}\n`);
  const adapter = createCursorNativeAdapter({ cursorHome: fake, cursorData: fake, cursorRunning: async () => true, times: { reparkMs: 500, pollMs: 10 } });
  const app = await startTestHub({ ...opts, nativeAdapters: { cursor: adapter }, limits: { recheckMs: 60_000, bridgeAckMs: 2000 } });
  const hubJson = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  return Object.assign(app, { secret: hubJson.secret as string });
}
type PHub = Awaited<ReturnType<typeof pHub>>;

async function member(app: PHub) {
  const { cluster, members: [c1] } = await app.api('POST', '/api/clusters', {
    name: 'cp', members: [{ harness: 'cursor', mode: 'native', sessionId: S1, name: 'C1' }, { projectPath: tempDir(), harness: 'mock', name: 'A' }],
  });
  return { cluster, c1 };
}

/** An ORRERY_HOME whose hub.json points the scripts at `url` with the Hub's secret. */
function homeFor(url: string, secret: string) {
  const home = tempDir();
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ url, secret, pid: 1 }));
  return home;
}

const TEST_ENV = { ORRERY_CURSOR_PARENT_MS: '200', ORRERY_CURSOR_RETRY_MS: '100' };

/** Runs a hook script with the input on stdin. */
function hook(script: string, input: unknown, home: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(PLUGIN, 'hooks', script)], { env: { ...process.env, ...TEST_ENV, ORRERY_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
  const exited = new Promise<number>((ok) => child.on('exit', (code) => ok(code ?? -1)));
  child.stdin.end(JSON.stringify(input));
  return { child, exited, out: () => stdout, err: () => stderr, json: async () => { await exited; return JSON.parse(stdout); } };
}

/** A member's status; null while the Hub cannot answer (a pooled connection to a Hub that restarted on the same port). */
const statusOf = async (app: PHub, id: string) => {
  try { return ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status; } catch { return null; }
};

test('cursor plugin end to end: stop parks, a batch becomes followup_message, prompt confirms it, stop ends the turn; nothing private leaves', async () => {
  const app = await pHub();
  const rec = await recorder(app.url);
  const outputs: string[] = [];
  try {
    const { cluster, c1 } = await member(app);
    const home = homeFor(rec.url, app.secret);
    const stop1 = hook('stop.mjs', hookInput(S1, { status: 'completed', input_tokens: 10, output_tokens: 2, cache_read_tokens: 4, cache_write_tokens: 0, loop_count: 0 }), home);
    await waitFor(async () => (await statusOf(app, c1.id)) === 'idle', 'parked');
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C1 please review' });
    const answer = await stop1.json();
    outputs.push(stop1.out(), stop1.err());
    assert.deepEqual(Object.keys(answer), ['followup_message']);
    const first = answer.followup_message.split('\n')[0];
    assert.match(first, /^\[orrery · 来自 user · #[0-9a-f]{8}\]$/);
    assert.match(answer.followup_message, /please review/);
    await waitFor(() => rec.seen.some((r) => r.path === '/bridge/ack'), 'acked');

    // Cursor submits it: beforeSubmitPrompt sees the hand-over id.
    const prompt = hook('prompt.mjs', hookInput(S1, { hook_event_name: 'beforeSubmitPrompt', generation_id: 'gen-2', prompt: answer.followup_message, attachments: [] }), home);
    assert.deepEqual(await prompt.json(), { continue: true });
    outputs.push(prompt.out(), prompt.err());
    await waitFor(async () => (await statusOf(app, c1.id)) === 'busy', 'busy with the turn');

    // The turn ends: the next stop hook reports it (with the turn's tokens) and parks again.
    const stop2 = hook('stop.mjs', hookInput(S1, { generation_id: 'gen-2', status: 'completed', input_tokens: 500, output_tokens: 20, cache_read_tokens: 400, cache_write_tokens: 0, loop_count: 1 }), home);
    const mine = async () => (await app.messages(cluster.id)).flatMap((m) => m.deliveries).filter((d) => d.memberId === c1.id);
    await waitFor(async () => (await mine()).every((d) => d.state === 'done'), 'done', 8000);
    assert.deepEqual(app.store.turnUsage([c1.id]).get(c1.id)?.totals, { input: 100, cachedInput: 400, cacheWrite: 0, output: 20, reasoning: 0 });
    await waitFor(async () => (await statusOf(app, c1.id)) === 'idle', 'parked again');

    // A user prompt in Cursor ends the parked hook empty-handed.
    const userPrompt = hook('prompt.mjs', hookInput(S1, { generation_id: 'gen-3', prompt: PROMPT_SECRET }), home);
    await userPrompt.exited;
    assert.deepEqual(await stop2.json(), {});
    outputs.push(stop2.out(), stop2.err(), userPrompt.out(), userPrompt.err());

    // The answer text of afterAgentResponse-like fields never travels either.
    const stop3 = hook('stop.mjs', hookInput(OUTSIDER, { text: ANSWER_SECRET, prompt: PROMPT_SECRET }), home);
    assert.deepEqual(await stop3.json(), {}, 'not a member: no park');
    outputs.push(stop3.out(), stop3.err());

    const sent = rec.seen.map((r) => `${r.path}\n${r.body}`).join('\n');
    for (const secret of [EMAIL, PROMPT_SECRET, ANSWER_SECRET, TRANSCRIPT, 'C:\\\\private\\\\project', 'some-model', 'private']) {
      assert.ok(!sent.includes(secret), `the Hub never receives ${secret}`);
      assert.ok(!outputs.join('\n').includes(secret), `no script prints ${secret}`);
    }
    for (const r of rec.seen.filter((x) => x.path === '/bridge/cursor-turn')) {
      const keys = Object.keys(JSON.parse(r.body)).sort();
      assert.ok(keys.every((k) => ['event', 'generationId', 'handout', 'sessionId', 'status', 'usage'].includes(k)), keys.join());
    }
    assert.ok(rec.seen.some((r) => r.path.startsWith('/bridge/cursor-park') && r.path.includes('version=3.29.9')), 'the Cursor version is shown');
    assert.ok(!outputs.join('\n').includes(app.secret), 'the secret is never printed');
  } finally {
    await rec.close();
    await app.close();
  }
});

test('cursor plugin stop hook: superseded, Hub down, not loopback, its own park limit and a gone parent all end it without a batch', async () => {
  const app = await pHub();
  try {
    const { c1 } = await member(app);
    const home = homeFor(app.url, app.secret);
    const older = hook('stop.mjs', hookInput(S1), home);
    await waitFor(async () => (await statusOf(app, c1.id)) === 'idle', 'parked');
    await new Promise((ok) => setTimeout(ok, 20));
    const newer = hook('stop.mjs', hookInput(S1), home, { ORRERY_CURSOR_PARK_MS: '600' });
    const t = Date.now();
    assert.deepEqual(await older.json(), {}, 'superseded by the newer park');
    assert.ok(Date.now() - t < 1500);
    assert.deepEqual(await newer.json(), {}, 'its own park limit');

    assert.deepEqual(await hook('stop.mjs', hookInput(S1), tempDir()).json(), {}, 'no hub.json');
    assert.deepEqual(await hook('stop.mjs', hookInput(S1), homeFor('http://10.0.0.1:4318', app.secret)).json(), {}, 'not a loopback address');
    assert.deepEqual(await hook('stop.mjs', hookInput(S1), homeFor(app.url, 'wrong-secret')).json(), {}, 'refused');
    assert.deepEqual(await hook('stop.mjs', 'not an object', home).json(), {});

    // A parent that goes away: the hook leaves without printing anything.
    const out = join(tempDir(), 'out.txt');
    const launcher = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
      const c = spawn(process.execPath, [${JSON.stringify(join(PLUGIN, 'hooks', 'stop.mjs'))}], { stdio: ['pipe', fs.openSync(${JSON.stringify(out)}, 'w'), 'ignore'], detached: true });
      c.stdin.end(${JSON.stringify(JSON.stringify(hookInput(S1)))}); console.log(c.pid); setTimeout(() => process.exit(0), 700);`;
    const parent = spawn(process.execPath, ['-e', launcher], { env: { ...process.env, ...TEST_ENV, ORRERY_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    const pid = Number((await createInterface({ input: parent.stdout })[Symbol.asyncIterator]().next()).value);
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the orphaned hook exits', 5000);
    assert.equal(readFileSync(out, 'utf8'), '', 'nothing printed');
  } finally {
    await app.close();
  }
});

test('cursor plugin stop hook: the Hub restarting drops the park, the hook reconnects to the new Hub and gets the batch there', async () => {
  const port = await freePort();
  const dir = tempDir();
  let app = await pHub({ port, dir });
  try {
    const { cluster, c1 } = await member(app);
    const home = homeFor(app.url, app.secret);
    const stop = hook('stop.mjs', hookInput(S1), home);
    await waitFor(async () => (await statusOf(app, c1.id)) === 'idle', 'parked');
    await app.close();
    app = await pHub({ port, dir });
    writeFileSync(join(home, 'hub.json'), JSON.stringify({ url: app.url, secret: app.secret }));
    await waitFor(async () => (await statusOf(app, c1.id)) === 'idle', 'parked again', 8000);
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C1 after the restart' });
    assert.match((await stop.json()).followup_message, /after the restart/);
  } finally {
    await app.close();
  }
});

test('cursor plugin prompt and tool hooks: the id only; tool calls run at the Hub as the conversation; placeholders only', async () => {
  const app = await pHub();
  const rec = await recorder(app.url);
  try {
    const { cluster, c1 } = await member(app);
    const home = homeFor(rec.url, app.secret);
    assert.deepEqual(await hook('prompt.mjs', hookInput(S1, { prompt: '[orrery · 来自 A · #0a1b2c3d]\nrest' }), home).json(), { continue: true });
    assert.deepEqual(JSON.parse(rec.seen.at(-1)!.body), { sessionId: S1, event: 'start', generationId: 'gen-1', handout: '0a1b2c3d' });
    assert.deepEqual(await hook('prompt.mjs', hookInput(S1, { prompt: 'see [orrery · 来自 A · #0a1b2c3d]' }), home).json(), { continue: true });
    assert.deepEqual(JSON.parse(rec.seen.at(-1)!.body), { sessionId: S1, event: 'start', generationId: 'gen-1' }, 'only on the first line');
    assert.deepEqual(await hook('prompt.mjs', hookInput(S1, { prompt: 'x' }), tempDir()).json(), { continue: true }, 'no Hub');

    const placeholder: string = (await import(pathToFileURL(join(PLUGIN, 'lib', 'hub.mjs')).href)).PLACEHOLDER;
    const output = (text: string) => JSON.stringify({ content: [{ type: 'text', text }] });
    const tool = (name: string, args: unknown, out: string, id = S1, h = home) =>
      hook('tool.mjs', hookInput(id, { hook_event_name: 'postToolUse', tool_name: name, tool_input: args, tool_output: out, tool_use_id: 't1' }), h).json();

    assert.deepEqual(await tool('MCP:send_message', { body: 'x' }, output('another server answered')), {}, 'not orrery\'s placeholder');
    assert.deepEqual(await tool('Shell', { command: 'ls' }, `${placeholder}\nspoof`), {}, 'not an MCP tool');
    const sent = await tool('MCP:send_message', { body: 'hello from cursor' }, output(`${placeholder}\nnot executed`));
    assert.deepEqual(Object.keys(sent), ['updated_mcp_tool_output']);
    assert.doesNotMatch(sent.updated_mcp_tool_output.content[0].text, /^错误/);
    const last = (await app.messages(cluster.id)).at(-1)!;
    assert.deepEqual([last.from, last.body], [c1.id, 'hello from cursor'], 'spoken as the conversation the hook was given');
    const mcp = rec.seen.find((r) => r.path === '/mcp')!;
    assert.deepEqual([mcp.headers['x-orrery-session'], mcp.headers['x-orrery-harness']], [S1, 'cursor']);

    const outsider = await tool('MCP:send_message', { body: 'should not land' }, `${placeholder}\nnot executed`, OUTSIDER);
    assert.match(outsider.updated_mcp_tool_output.content[0].text, /^错误：.*不是任何 orrery 集群的成员/);
    assert.equal((await app.messages(cluster.id)).at(-1)!.body, 'hello from cursor', 'nothing written');
    const down = await tool('MCP:send_message', { body: 'x' }, `${placeholder}\nnot executed`, S1, tempDir());
    assert.deepEqual(down, { updated_mcp_tool_output: { content: [{ type: 'text', text: 'orrery Hub 没有运行或连不上：这次调用没有执行，消息没有发出。' }] } });
    // hub.json names a port nobody listens on: the request never left, so "not executed" is true.
    const refused = await tool('MCP:send_message', { body: 'x' }, `${placeholder}\nnot executed`, S1, homeFor(`http://127.0.0.1:${await freePort()}`, app.secret));
    assert.equal(refused.updated_mcp_tool_output.content[0].text, 'orrery Hub 没有运行或连不上：这次调用没有执行，消息没有发出。');
    // A tool the Hub does not have: rejected before anything runs, so no "cannot be confirmed".
    const noSuchTool = await tool('MCP:no_such_tool', {}, `${placeholder}\nnot executed`);
    assert.match(noSuchTool.updated_mcp_tool_output.content[0].text, /^(错误：|orrery Hub 拒绝了这次调用)/);
    // The Hub refuses the request (wrong secret: 401): it ran nothing.
    const unauthorized = await tool('MCP:send_message', { body: 'x' }, `${placeholder}\nnot executed`, S1, homeFor(app.url, 'wrong-secret'));
    assert.equal(unauthorized.updated_mcp_tool_output.content[0].text, 'orrery Hub 拒绝了这次调用（HTTP 401），没有执行，消息没有发出。');
  } finally {
    await rec.close();
    await app.close();
  }
});

test('cursor plugin tool hook: the Hub ran the call but the answer was lost: the model is told it cannot be confirmed, never that it was not sent', async () => {
  const app = await pHub();
  // Forwards each request to the Hub, waits for the Hub's whole answer, then drops the hook's connection instead of answering.
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const { host: _host, ...headers } = req.headers;
      const out = request(`${app.url}${req.url}`, { method: req.method, headers, agent: false }, (r) => {
        r.resume();
        r.on('end', () => res.socket?.destroy());
      });
      out.end(Buffer.concat(chunks));
    });
  });
  const port = await freePort();
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  try {
    const { cluster, c1 } = await member(app);
    const placeholder: string = (await import(pathToFileURL(join(PLUGIN, 'lib', 'hub.mjs')).href)).PLACEHOLDER;
    const lost = await hook('tool.mjs', hookInput(S1, { tool_name: 'MCP:send_message', tool_input: { body: 'stored but unanswered' },
      tool_output: `${placeholder}\nnot executed` }), homeFor(`http://127.0.0.1:${port}`, app.secret)).json();
    const last = (await app.messages(cluster.id)).at(-1)!;
    assert.deepEqual([last.from, last.body], [c1.id, 'stored but unanswered'], 'the Hub did run it');
    const text: string = lost.updated_mcp_tool_output.content[0].text;
    assert.match(text, /无法确认/);
    assert.match(text, /read_messages/);
    assert.doesNotMatch(text, /没有执行|没有发出/, 'never claims it was not done');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    await app.close();
  }
});

/** The MCP program over stdio. */
function mcpProgram(home: string) {
  const child = spawn(process.execPath, [join(PLUGIN, 'mcp.mjs')], { env: { ...process.env, ORRERY_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<unknown, (m: any) => void>();
  const notes: any[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined) waiting.get(m.id)?.(m);
    else notes.push(m);
  });
  let n = 0;
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((ok) => {
    const id = ++n;
    waiting.set(id, ok);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { rpc, notes, close: () => child.kill() };
}

test('cursor plugin MCP program: answers initialize itself, lists the Hub\'s tools (tools.json while down, kept equal), only placeholders for calls', async () => {
  const app = await pHub();
  const down = mcpProgram(tempDir());
  const up = mcpProgram(homeFor(app.url, app.secret));
  try {
    const init = await up.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor-vscode', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'orrery');
    const hubList = (await up.rpc('tools/list')).result.tools;
    const res = await fetch(`${app.url}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': app.secret, 'x-orrery-harness': 'cursor', 'x-orrery-session': S1 } });
    const memberList = (await res.json()).result.tools;
    assert.deepEqual(hubList, memberList, 'the list a member speaking through the hook gets');
    assert.deepEqual(JSON.parse(readFileSync(join(PLUGIN, 'tools.json'), 'utf8')), memberList, 'tools.json equals the Hub\'s standard tools/list (regenerate it when the tools change)');
    assert.deepEqual((await down.rpc('tools/list')).result.tools, memberList, 'the built-in list while the Hub is down');
    const call = await up.rpc('tools/call', { name: 'send_message', arguments: { body: 'x' } });
    assert.match(call.result.content[0].text, /^orrery-cursor-placeholder\n这次 orrery 调用没有执行/);
    assert.equal(call.result.isError, undefined);
    assert.equal((await up.rpc('resources/list')).error.code, -32601);
  } finally {
    down.close();
    up.close();
    await app.close();
  }
});

test('cursor plugin files: Node built-ins only, no fetch, loopback only, no secret; hooks.json and mcp.json as documented', () => {
  const files = readdirSync(PLUGIN, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.mjs'));
  assert.deepEqual(files.map((f) => f.replaceAll('\\', '/')).sort(), ['hooks/prompt.mjs', 'hooks/stop.mjs', 'hooks/tool.mjs', 'lib/hub.mjs', 'mcp.mjs']);
  for (const f of files) {
    const code = readFileSync(join(PLUGIN, f), 'utf8');
    const imports = [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.filter((s) => !s.startsWith('node:') && !s.startsWith('./') && !s.startsWith('../')), [], `${f}: Node built-ins only`);
    for (const s of imports.filter((x) => x.startsWith('.'))) assert.ok(join(PLUGIN, f, '..', s).startsWith(PLUGIN), `${f}: nothing outside the plugin`);
    assert.doesNotMatch(code, /\bfetch\(/, `${f}: no fetch`);
    assert.doesNotMatch(code, /writeFile|appendFile|createWriteStream|console\.log/, `${f}: writes no file, logs nothing`);
    assert.doesNotMatch(code, /state\.vscdb|\.cursor[\\/]|cursor:\/\//, `${f}: reads no Cursor data, opens no cursor:// link`);
  }
  assert.match(readFileSync(join(PLUGIN, 'lib', 'hub.mjs'), 'utf8'), /LOOPBACK_URL = \/\^http:\\\/\\\/\(127\\\.0\\\.0\\\.1\|localhost\):\\d\{1,5\}\$\//);
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.stop, [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/stop.mjs"', timeout: 86400, loop_limit: null }]);
  assert.equal(hooks.hooks.beforeSubmitPrompt[0].timeout, 5);
  assert.equal(hooks.hooks.postToolUse[0].matcher, '^MCP:');
  const mcp = JSON.parse(readFileSync(join(PLUGIN, 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp, { mcpServers: { orrery: { command: 'node', args: ['${CURSOR_PLUGIN_ROOT}/mcp.mjs'] } } });
  assert.equal(JSON.parse(readFileSync(join(PLUGIN, '.cursor-plugin', 'plugin.json'), 'utf8')).name, 'orrery');
  for (const f of readdirSync(PLUGIN, { recursive: true, encoding: 'utf8' })) {
    if (!f.includes('.')) continue;
    try { assert.doesNotMatch(readFileSync(join(PLUGIN, f), 'utf8'), /"secret"\s*:/, `${f} holds no secret`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EISDIR') throw e; }
  }
});
