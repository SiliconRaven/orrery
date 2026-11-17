// Cursor's postToolUse hook (docs/adapters/cursor.md, "发言"). orrery's MCP program (../mcp.mjs) only answers each call
// with a placeholder; this hook, given Cursor's trusted conversation_id, runs the call at the Hub (the bridge secret plus
// x-orrery-session and x-orrery-harness: cursor name the member) and puts the Hub's result in place of the placeholder
// (updated_mcp_tool_output). Any result without the placeholder (every other tool and MCP server) is left alone: {}.
import { answer, findHub, HARNESS, id, PLACEHOLDER, post, readInput } from '../lib/hub.mjs';

// Each failure says only what is known. Not sent: no Hub, or no connection was made. Refused: the Hub answered that it
// did not run the call. Otherwise the request reached the Hub and may have run: say it cannot be confirmed, never that
// nothing was sent, and ask the model to check before doing it again (there is no idempotency id; nothing is retried).
const HUB_DOWN = 'orrery Hub 没有运行或连不上：这次调用没有执行，消息没有发出。';
const refused = (why) => `orrery Hub 拒绝了这次调用（${why}），没有执行，消息没有发出。`;
const unknown = (why) => `orrery：这次调用已经发给了 Hub，但没有收到完整的回答（${why}），无法确认它是否已经执行。`
  + '不要直接重做：如果它会发消息或改动任务，先用 read_messages（history: true）看群聊记录、或用对应的查询工具核对，确认没有生效再做。';
/** JSON-RPC errors the Hub's MCP server raises before running any tool: parse, invalid request, unknown method, invalid params. */
const BEFORE_RUNNING = new Set([-32700, -32600, -32601, -32602]);
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

const replace = (content) => answer({ updated_mcp_tool_output: { content } });
const textOnly = (text) => replace([{ type: 'text', text }]);

/** Whether a tool_output is orrery's placeholder: as text, as an MCP result, or as its JSON. */
function isPlaceholder(output) {
  let v = output;
  if (typeof v === 'string') {
    if (v.startsWith(PLACEHOLDER)) return true;
    try { v = JSON.parse(v); } catch { return false; }
  }
  const content = Array.isArray(v) ? v : v?.content;
  return Array.isArray(content) && typeof content[0]?.text === 'string' && content[0].text.startsWith(PLACEHOLDER);
}

let attempted = false;   // the request to the Hub was started: a crash after it must not claim nothing happened

async function main() {
  const input = await readInput();
  const sessionId = id(input.conversation_id);
  const name = typeof input.tool_name === 'string' && input.tool_name.startsWith('MCP:') ? input.tool_name.slice(4) : '';
  if (!sessionId || !NAME.test(name) || !isPlaceholder(input.tool_output)) return answer({});
  const args = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input) ? input.tool_input : {};
  const hub = await findHub();
  if (!hub) return textOnly(HUB_DOWN);
  let r;
  attempted = true;
  try {
    r = await post(hub, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { headers: { 'x-orrery-session': sessionId, 'x-orrery-harness': HARNESS }, timeoutMs: 50_000 });
  } catch (e) {
    if (!e?.sent) return textOnly(HUB_DOWN);
    return textOnly(unknown(e.timeout ? '等了 50 秒没有回答' : '连接在回答之前断开'));
  }
  const result = r.body?.result;
  if (r.status >= 400 && r.status < 500) return textOnly(refused(`HTTP ${r.status}`));
  const error = r.body?.error;
  if (r.status === 200 && BEFORE_RUNNING.has(error?.code)) return textOnly(refused(String(error.message ?? error.code).slice(0, 200)));
  if (r.status !== 200 || !Array.isArray(result?.content)) return textOnly(unknown(r.status !== 200 ? `HTTP ${r.status}` : '回答里没有调用结果'));
  const content = result.content.map((c) => (c && typeof c === 'object' ? c : { type: 'text', text: String(c) }));
  if (result.isError && content[0]?.type === 'text') content[0] = { ...content[0], text: `错误：${content[0].text}` };
  return replace(content);
}

main().then(() => process.exit(0), () => (attempted ? textOnly(unknown('orrery hook 出错')) : answer({})).then(() => process.exit(0)));
