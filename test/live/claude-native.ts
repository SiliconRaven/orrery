// Free live check of native Claude (not part of `npm test`): `node test/live/claude-native.ts [parent dir]`.
// Each run works in a new directory made under the parent (default <temp>/orrery-sandbox) and removes only that one.
// The real `claude -p` (stream-json in and out, --replay-user-messages like Claude Desktop) runs in a sandbox project
// whose .mcp.json starts the real orrery bridge; a fake local Anthropic API answers every model request; a real Hub
// runs the native Claude adapter. The Claude config dir, Hub home and database all live in the sandbox, and the
// parent's CLAUDE_CODE_* / ANTHROPIC_* variables are dropped, so no real model, login or session is touched.
// Checks: the CLI starts the bridge, the bridge registers, a Hub delivery reaches the session inbox and starts a turn
// (a user event with origin kind "peer"), and the model's send_message call is attributed to the member; a message
// posted while the session is closed ends "offline" and is not sent after it is resumed, the next one is.
// Rerun after every Claude Code upgrade (docs/adapters/claude-adapter.md).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createClaudeNativeAdapter } from '../../src/adapters/claude/native.ts';
import { REPO_ROOT, startHub } from '../../src/main.ts';

const parent = process.argv[2] ?? join(tmpdir(), 'orrery-sandbox');
mkdirSync(parent, { recursive: true });
const S = mkdtempSync(join(parent, 'claude-native-'));   // this run's own directory; the parent is never cleaned
// A failure before the try below (Hub or claude fails to start) skips its finally: remove the directory at exit too.
process.once('exit', () => { try { rmSync(S, { recursive: true, force: true }); } catch { /* best effort */ } });
const BRIDGE = join(REPO_ROOT, 'src', 'bridge', 'claude-bridge.ts');

const project = join(S, 'project');
const config = join(S, 'claude-config');
mkdirSync(project, { recursive: true });
mkdirSync(config, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`);

// ── fake Anthropic API ──
let toolNames: string[] = []; let seenTools = 0;
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (!req.url!.startsWith('/v1/messages') || req.url!.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const j = JSON.parse(body || '{}');
    const last = j.messages?.at(-1);
    const parts = typeof last?.content === 'string' ? [{ type: 'text', text: last.content }] : (last?.content ?? []);
    const lastText = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    const hasResult = parts.some((p: any) => p.type === 'tool_result');
    if (j.tools) { toolNames = j.tools.map((t: any) => t.name); if (!seenTools++) log(`tool names: ${toolNames.join(",")}`); }
    let blocks: any[];
    if (hasResult) blocks = [{ type: 'text', text: 'done' }];
    else if (lastText.includes('ping from hub') && toolNames.includes('mcp__orrery__send_message')) {
      blocks = [{ type: 'tool_use', id: 'toolu_01', name: 'mcp__orrery__send_message', input: { body: 'pong from C' } }];
    } else blocks = [{ type: 'text', text: 'ok' }];
    log(`API ${req.url} stream=${!!j.stream} tools=${j.tools?.length ?? 0} → ${blocks.map((b) => b.type).join(',')}${lastText.includes('ping from hub') ? ' (the delivered message)' : ''}`);
    const message = { id: 'msg_' + randomUUID().slice(0, 8), type: 'message', role: 'assistant', model: j.model ?? 'fake', content: [] as any[],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content: blocks, stop_reason: stop }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message });
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      } else {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    ev('message_stop', {});
    res.end();
  });
});
await new Promise<void>((ok) => api.listen(0, '127.0.0.1', ok));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

// ── Hub ──
const app = await startHub({
  dbPath: join(S, 'hub.db'), port: 0, home: join(S, 'home'), registryDir: join(S, 'registry'),
  nativeAdapters: { claude: createClaudeNativeAdapter({ claudeDir: config }) },
  limits: { startupGraceMs: 0 },   // the offline step below must not fall into the start-up grace
});
log(`hub ${app.url}`);
writeFileSync(join(project, '.mcp.json'), JSON.stringify({
  mcpServers: { orrery: { type: 'stdio', command: process.execPath, args: [BRIDGE], env: { ORRERY_REGISTRY: join(S, 'registry') } } },
}, null, 2));

// ── claude ──
const sid = randomUUID();
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_|ORRERY_)/i.test(k)));
// ENABLE_TOOL_SEARCH=false: the orrery tools are sent with every request, so the fake model can call one directly.
Object.assign(env, {
  CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: apiUrl, ANTHROPIC_API_KEY: 'sk-ant-fake-local-only',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false',
});
/** One `claude -p` process; `first` = new session (--session-id) or resume it (--resume), like Claude Desktop reopening it. */
function startClaude(first: boolean) {
  const child = spawn('claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...(first ? ['--session-id', sid] : ['--resume', sid]),
    '--replay-user-messages', '--allowedTools', 'mcp__orrery__send_message,mcp__orrery__list_agents,mcp__orrery__read_messages',
  ], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  createInterface({ input: child.stdout }).on('line', (l) => {
    let e: any;
    try { e = JSON.parse(l); } catch { log(`stdout: ${l.slice(0, 200)}`); return; }
    events.push(e);
    if (e.type === 'system' && e.subtype === 'init') log(`init session=${e.session_id === sid ? 'sid' : e.session_id} mcp_servers=${JSON.stringify(e.mcp_servers)} model=${e.model} version=${e.claude_code_version}`);
    else if (e.type === 'user') log(`user event origin=${JSON.stringify(e.origin ?? null)} isReplay=${e.isReplay ?? false} content=${JSON.stringify(e.message?.content).slice(0, 160)}`);
    else if (e.type === 'assistant') log(`assistant ${JSON.stringify(e.message?.content).slice(0, 160)}`);
    else if (e.type === 'result') log(`result ${e.subtype} is_error=${e.is_error} ${String(e.result ?? '').slice(0, 80)}`);
    else log(`event ${e.type}${e.subtype ? '/' + e.subtype : ''}`);
  });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise<number | null>((ok) => child.on('exit', (c) => ok(c)));
  return { child, exited, type: (content: string) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n') };
}
const events: any[] = [];
let stderr = '';
let claude = startClaude(true);
const until = async (what: string, fn: () => unknown, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  log(`ok: ${what}`);
};
const results = () => events.filter((e) => e.type === 'result').length;

let verdict = 'FAIL';
const peers = () => events.filter((e) => e.type === 'user' && e.origin?.kind === 'peer');
try {
  claude.type('hi (first turn, typed)');
  await until('first turn finished', () => results() >= 1);
  await until('bridge online at the Hub', () => app.hub.bridge.isOnline('claude', sid), 15_000);
  const { cluster, members: [c] } = await app.hub.createCluster('live', [{ harness: 'claude', mode: 'native', sessionId: sid, name: 'C' }]);
  log(`member C status=${app.hub.listMembers(cluster.id)[0].status}`);
  const m = app.hub.sendFromUser(cluster.id, '@C ping from hub');
  await until('delivery done (bridge acked)', () => app.store.withDeliveries([m])[0].deliveries[0].state === 'done', 15_000);
  await until('peer user event in stream-json (turn started by the inbox)', () => peers().length === 1, 15_000);
  await until('second turn finished', () => results() >= 2, 30_000);
  const msgs = app.hub.listMessages(cluster.id, 10);
  log(`cluster messages: ${JSON.stringify(msgs.map((x: any) => ({ from: x.from === c.id ? 'C' : x.from, body: x.body, hop: x.hop })))}`);
  if (!msgs.some((x: any) => x.from === c.id && x.body === 'pong from C')) throw new Error('send_message was not attributed to C');
  log(`tools seen by the model: ${toolNames.filter((n) => n.startsWith('mcp__orrery')).join(', ') || '(none)'} of ${toolNames.length}`);
  log(`peer origin: ${JSON.stringify(peers()[0].origin)}`);

  // The session closes (member offline: a message for it ends "offline") and is resumed: the new bridge reports the
  // same session id; the missed message is not sent, the next one is.
  claude.child.stdin.end();
  log(`claude exit ${await claude.exited}`);
  await until('bridge offline after claude exits', () => !app.hub.bridge.isOnline('claude', sid), 10_000);
  const missed = app.hub.sendFromUser(cluster.id, '@C ping from hub while closed');
  const stateOf = (msg: typeof missed) => app.store.withDeliveries([msg])[0].deliveries[0].state;
  await until('delivery offline, not queued', () => stateOf(missed) === 'offline', 5_000);
  claude = startClaude(false);
  await until('bridge of the resumed session online under the same id', () => app.hub.bridge.isOnline('claude', sid), 15_000);
  const next = app.hub.sendFromUser(cluster.id, '@C ping after resume');
  await until('next delivery done after resume', () => stateOf(next) === 'done', 15_000);
  await until('its peer user event in stream-json', () => peers().length === 2, 15_000);
  if (stateOf(missed) !== 'offline' || peers().some((e) => JSON.stringify(e).includes('while closed'))) {
    throw new Error('the message posted while closed was sent after all');
  }
  verdict = 'PASS';
} catch (e) {
  log(`ERROR ${e instanceof Error ? e.message : e}`);
  log(`stderr tail: ${stderr.slice(-1500)}`);
} finally {
  claude.child.stdin.end();
  log(`claude exit ${await claude.exited}`);
  await app.close();
  api.close();
  // Only this run's directory goes; on Windows a just-exited process can hold a file for a moment, hence the retries.
  try {
    rmSync(S, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    log(`could not remove ${S}: ${e instanceof Error ? e.message : e}`);
  }
  log(`VERDICT ${verdict}`);
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}
