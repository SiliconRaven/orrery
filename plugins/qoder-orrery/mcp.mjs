// orrery's MCP server for the Qoder plugin. Qoder starts it once for the whole app (stdio) and writes each conversation's
// id into every tools/call, in _meta["com.qoder/turnContext"].sessionId; this process cannot tell conversations apart, so
// it never names one itself: it relays the JSON-RPC messages unchanged to the Hub, which reads that _meta (src/mcp/qoder.ts).
// Standalone: Node built-ins only and no fetch: a proxy must never see a request. Which Hub and how: ./hub-discovery.mjs,
// a byte-identical copy of orrery's plugins/shared/hub-discovery.mjs (the account's Hub registry, read fresh for every
// request; requests signed with x-orrery-sig over the body, so the _meta that names the conversation is covered; the key
// itself is never sent; no valid record: nothing is sent). Contract: docs/adapters/qoder.md.
import { createInterface } from 'node:readline';
import { callOutcome, hubFetch } from './hub-discovery.mjs';

const HARNESS = 'qoder';
const RETRY_MS = 5000;
const PROTOCOL_VERSION = '2025-06-18';
const log = (m) => process.stderr.write(`orrery: ${m}\n`);   // Qoder keeps MCP stderr in its log

/**
 * Forwards one JSON-RPC message. Resolves with the Hub's JSON-RPC response; throws when it cannot get one, saying
 * whether the plugin sent nothing, the Hub refused it, or the Hub could not be reached.
 */
async function relay(msg) {
  let status;
  let text;
  try {
    ({ status, text } = await hubFetch('POST', '/mcp', { log, body: JSON.stringify(msg),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-harness': HARNESS } }));
  } catch (e) {
    // Not sent (retry is safe), refused (it did not run), or unknown (it may have run): see callOutcome.
    throw new Error(callOutcome(e));
  }
  if (status !== 200) throw new Error(`orrery Hub 拒绝了请求（HTTP ${status}）`);
  return JSON.parse(text);
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
      serverInfo: { name: 'orrery', version: '0.10.0-beta.2' },
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
