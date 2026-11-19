// orrery's MCP program for the Cursor plugin (stdio; docs/adapters/cursor.md, "发言"). Cursor's tools/call names no
// conversation, so this program never runs a call: it answers each with a placeholder, and the plugin's postToolUse hook
// (hooks/tool.mjs), which Cursor gives the conversation's id, runs the call at the Hub and replaces the placeholder. When
// that hook did not run, the model reads that nothing was done. tools/list comes from the Hub (the standard tools), or
// from tools.json while the Hub is down; once the Hub answers, Cursor is told the list changed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { findHub, HARNESS, PLACEHOLDER, post, warn } from './lib/hub.mjs';

// ORRERY_CURSOR_MCP_RETRY_MS is a test knob (orrery's own variable); Cursor never sets it.
const RETRY_MS = Number(process.env.ORRERY_CURSOR_MCP_RETRY_MS) || 5000;
// After a 401 the Hub has refused this program's signed request (an old copy of the plugin, a key that does not match
// the registry, or another program on the Hub's port): retrying every 5 s cannot fix that and would only log refusals,
// so it slows down to once a minute; a Hub that was merely down is still retried every 5 s.
const REFUSED_RETRY_MS = RETRY_MS * 12;
const PROTOCOL_VERSION = '2025-06-18';
const BUILT_IN = JSON.parse(readFileSync(join(import.meta.dirname, 'tools.json'), 'utf8'));
export const NOT_EXECUTED = `${PLACEHOLDER}\n这次 orrery 调用没有执行：orrery 的 postToolUse hook 没有运行。消息没有发出，也没有读到任何内容。`
  + '不要当作已经成功；先请用户检查 orrery 插件，或用 read_messages 看看自己的消息再决定是否重试。';

// U+2028 / U+2029 are valid raw inside JSON strings, but line readers split on them.
const send = (msg) => process.stdout.write(`${JSON.stringify(msg).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`);
const result = (id, r) => send({ jsonrpc: '2.0', id, result: r });

/** The Hub's tools/list: { tools }, { refused: why } after a 401, or null when the Hub cannot be asked. */
async function hubTools() {
  const hub = findHub();
  if (!hub) return null;
  try {
    const r = await post(hub, '/mcp', { jsonrpc: '2.0', id: 'tools', method: 'tools/list' }, { headers: { 'x-orrery-harness': HARNESS } });
    return r.status === 200 && Array.isArray(r.body?.result?.tools) ? { tools: r.body.result.tools } : null;
  } catch (e) {
    return e?.kind === 'rejected' ? { refused: e.message } : null;
  }
}

// shortcut: only a Hub that was down when tools/list was asked triggers list_changed, not a later Hub restart with
// changed tools (the Hub's tool-update hint tells the member); upgrade to a poll of the Hub's tools if that bites.
let retrying = false;
let reportedRefusal = '';
/** Says once per reason, on stderr (Cursor's MCP log), why the Hub's list is not used and how often it is retried. */
function noteRefusal(why) {
  if (why === reportedRefusal) return;
  reportedRefusal = why;
  warn(`${why}; asking again every ${REFUSED_RETRY_MS / 1000} s, not every ${RETRY_MS / 1000} s (check that the Hub's registry key matches, or reinstall the plugin)`);
}

function retryTools(delay = RETRY_MS) {
  if (retrying) return;
  retrying = true;
  const again = (ms) => setTimeout(async () => {
    const got = await hubTools();
    if (got?.tools) {
      retrying = false;
      reportedRefusal = '';
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return;
    }
    if (got?.refused) noteRefusal(got.refused);
    again(got?.refused ? REFUSED_RETRY_MS : RETRY_MS);
  }, ms).unref();
  again(delay);
}

async function handle(msg) {
  if (typeof msg?.method !== 'string' || (typeof msg.id !== 'string' && typeof msg.id !== 'number')) return;   // notifications
  const { id, method } = msg;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'orrery', version: '0.10.0-beta.2' },
    });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') {
    const got = await hubTools();
    if (got?.refused) noteRefusal(got.refused);
    if (!got?.tools) retryTools(got?.refused ? REFUSED_RETRY_MS : RETRY_MS);
    return result(id, { tools: got?.tools ?? BUILT_IN });
  }
  if (method === 'tools/call') return result(id, { content: [{ type: 'text', text: NOT_EXECUTED }] });
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(() => process.stderr.write('orrery: MCP request failed\n'));
});
lines.on('close', () => process.exit(0));
