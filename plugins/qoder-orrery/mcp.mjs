// orrery's MCP server for the Qoder plugin. Qoder starts it once for the whole app (stdio) and writes each conversation's
// id into every tools/call, in _meta["com.qoder/turnContext"].sessionId; this process cannot tell conversations apart, so
// it never names one itself: it relays the JSON-RPC messages unchanged to the Hub, which reads that _meta (src/mcp/qoder.ts).
// Standalone: Node built-ins only and no fetch: a proxy must never see the secret. It reads <ORRERY_HOME or ~/.orrery>/hub.json
// fresh for every request and talks only to the loopback address there. Contract: docs/adapters/qoder.md.
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const HARNESS = 'qoder';
const RETRY_MS = 5000;
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const PROTOCOL_VERSION = '2025-06-18';
const HUB_DOWN ='orrery Hub 没有运行或连不上（在 orrery 目录运行 npm start），这次调用没有送达';

const home = () => process.env.ORRERY_HOME || join(homedir(), '.orrery');
// An agent of our own: with NODE_USE_ENV_PROXY=1 the global agent would send the secret to HTTP_PROXY.
const direct = new Agent();

/** The Hub from hub.json; null when there is none. */
async function findHub() {
  try {
    const d = JSON.parse(await readFile(join(home(), 'hub.json'), 'utf8'));
    if (typeof d?.url === 'string' && LOOPBACK_URL.test(d.url) && typeof d.secret === 'string' && d.secret) return d;
  } catch { /* no Hub */ }
  return null;
}

/** Forwards one JSON-RPC message. Resolves with the Hub's JSON-RPC response; throws when it cannot get one. */
async function relay(msg) {
  const hub = await findHub();
  if (!hub) throw new Error(HUB_DOWN);
  const body = await new Promise((ok, fail) => {
    const req = request(`${hub.url}/mcp`, {
      method: 'POST', agent: direct,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': hub.secret, 'x-orrery-harness': HARNESS },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => (res.statusCode === 200 ? ok(text) : fail(new Error(`orrery Hub 拒绝了请求（HTTP ${res.statusCode}）`))));
      res.on('error', fail);
    });
    req.on('error', () => fail(new Error(HUB_DOWN)));
    req.end(JSON.stringify(msg));
  });
  return JSON.parse(body);
}

// U+2028 / U+2029 are valid raw inside JSON strings, but line readers split on them.
const send = (msg) => process.stdout.write(`${JSON.stringify(msg).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`);
const result = (id, r) => send({ jsonrpc: '2.0', id, result: r });

// Qoder starts this process with the app, often before the Hub: an empty list now, list_changed once the Hub answers.
// shortcut: only a Hub that was down when tools/list was asked triggers list_changed, not a later Hub restart with
// changed tools (Qoder keeps the old list until the plugin reloads); upgrade to a poll of the Hub's tools if that bites.
let retrying = false;
function retryTools() {
  if (retrying) return;
  retrying = true;
  const timer = setInterval(async () => {
    try {
      await relay({ jsonrpc: '2.0', id: 'orrery-tools-retry', method: 'tools/list' });
    } catch {
      return;
    }
    clearInterval(timer);
    retrying = false;
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }, RETRY_MS);
  timer.unref();
}

async function handle(msg) {
  if (typeof msg?.method !== 'string' || (typeof msg.id !== 'string' && typeof msg.id !== 'number')) return;   // notifications: the stateless Hub needs none
  const { id, method } = msg;
  if (method === 'initialize') {   // answered here so the MCP connects even with no Hub; the stateless Hub needs none
    return result(id, {
      protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'orrery', version: '0.10.0-beta.1' },
    });
  }
  if (method === 'ping') return result(id, {});
  try {
    send(await relay(msg));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (method === 'tools/list') {
      retryTools();
      result(id, { tools: [] });
    } else if (method === 'tools/call') result(id, { content: [{ type: 'text', text: why }], isError: true });
    else send({ jsonrpc: '2.0', id, error: { code: -32603, message: why } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // One process serves every conversation: a slow call must not hold up the others.
  handle(msg).catch((e) => process.stderr.write(`orrery relay failed: ${e instanceof Error ? e.message : String(e)}\n`));
});
lines.on('close', () => process.exit(0));
