// orrery PreToolUse hook for Antigravity: tells the orrery Hub which conversation is calling an orrery tool.
// Antigravity's MCP connection to the Hub is shared by all conversations, so the Hub cannot see the caller. Antigravity
// runs this hook before a tool call with the conversation's id on stdin; for a call to the MCP server named `orrery`
// the hook answers with an `overwrite` that sets the argument
//   orreryCaller = "<conversationId>.<hex HMAC-SHA256(bridge secret, 'orrery-antigravity-caller\n' + conversationId)>"
// replacing whatever the model wrote there. Without a readable hub.json or a conversation id it still overwrites, with
// '', so a model-written value never reaches the Hub. The Hub accepts the id only with a valid tag (src/mcp/antigravity.ts).
// It never allows anything: the decision is always "ask", so the user's own permission settings decide as before.
// Standalone: Node built-ins only; reads only <ORRERY_HOME or ~/.orrery>/hub.json; prints only its answer, never the
// secret. Contract: docs/adapters/antigravity.md in the orrery repository.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CALLER_ARG = 'orreryCaller';
const SERVER = 'orrery';
// The model-facing name of an orrery tool: mcp_orrery_send_message, mcp__orrery__send_message, orrery/send_message …
const TOOL_NAME = /(?:^|[^a-z0-9])orrery[^a-z0-9]+(?:list_agents|send_message|read_messages|skip_unread|get_deliveries|ack_messages|list_tasks|list_labels|manage_labels|get_task|get_task_context|list_bookmarks|create_task|task_action|get_batch|manage_batch|raise_attention|resolve_attention|set_task_summary|link_message_tasks|bookmark_message|manage_roles|set_cluster_paused)$/i;
const SERVER_KEYS = ['servername', 'server_name', 'server', 'mcpservername'];
const ARGS_KEYS = ['arguments', 'args', 'toolarguments', 'tool_arguments', 'input', 'parameters'];
const ASK = { decision: 'ask' };

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const keyOf = (obj, names) => Object.keys(obj).find((k) => names.includes(k.toLowerCase()));

/** The value for orreryCaller, or '' when the hook cannot sign (no Hub secret or no conversation id). */
export function callerValue(conversationId, secret) {
  if (typeof conversationId !== 'string' || !conversationId || typeof secret !== 'string' || !secret) return '';
  return `${conversationId}.${createHmac('sha256', secret).update(`orrery-antigravity-caller\n${conversationId}`).digest('hex')}`;
}

/**
 * The hook's answer for one PreToolUse payload. Two shapes of an orrery call are recognised, because which one
 * Antigravity uses for MCP tools is not documented (real-device check):
 *   1. toolCall.name is the orrery tool's model-facing name; its args are the tool's arguments;
 *   2. toolCall.args names the server (serverName …) as `orrery`; the tool's arguments are in a nested object or JSON
 *      string (arguments …), which the overwrite replaces whole (the merge is shallow), keeping its other keys.
 * Anything else: no overwrite.
 */
export function answer(payload, secret) {
  const call = isObject(payload) ? payload.toolCall : undefined;
  if (!isObject(call)) return ASK;
  const value = callerValue(payload.conversationId, secret);
  if (typeof call.name === 'string' && TOOL_NAME.test(call.name)) return { ...ASK, overwrite: { [CALLER_ARG]: value } };
  const args = call.args;
  if (!isObject(args)) return ASK;
  const serverKey = keyOf(args, SERVER_KEYS);
  if (!serverKey || typeof args[serverKey] !== 'string' || args[serverKey].toLowerCase() !== SERVER) return ASK;
  const argsKey = keyOf(args, ARGS_KEYS);
  const inner = argsKey === undefined ? undefined : args[argsKey];
  if (isObject(inner)) return { ...ASK, overwrite: { [argsKey]: { ...inner, [CALLER_ARG]: value } } };
  if (typeof inner === 'string') {
    let parsed;
    try {
      parsed = inner.trim() ? JSON.parse(inner) : {};
    } catch {
      parsed = null;
    }
    if (isObject(parsed)) return { ...ASK, overwrite: { [argsKey]: JSON.stringify({ ...parsed, [CALLER_ARG]: value }) } };
  }
  // An orrery call whose arguments we cannot place: sign at the top level and let the Hub refuse it if that is wrong.
  return { ...ASK, overwrite: { [CALLER_ARG]: value } };
}

/** The Hub's bridge secret from hub.json, or null. */
export function hubSecret(env = process.env) {
  try {
    const d = JSON.parse(readFileSync(join(env.ORRERY_HOME || join(homedir(), '.orrery'), 'hub.json'), 'utf8'));
    return typeof d?.secret === 'string' && d.secret ? d.secret : null;
  } catch {
    return null;
  }
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    payload = null;
  }
  process.stdout.write(JSON.stringify(answer(payload, hubSecret())));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
