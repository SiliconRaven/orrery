// Qoder owns this format (docs/adapters/qoder.md, "读对话原文"): <Qoder app data>/main.sqlite, table
// chat_session_messages, one row per user prompt, assistant turn or hook activity, ordered by `sequence` (unique per
// session), JSON in `payload_json` whose `parts` are text, thinking, tool (call and response in one part) and hook.
// Read in place through the shared read-only reader. The Hub links orrery evidence after the read:
// - a delivery: the wait command prints only the envelope (or a direct message's body) into its background task's
//   output file; the turn the finished task starts is an assistant row naming that task (`backgroundTaskId`). Only a
//   whole-file Read of `<that task>.output` in that row, where the task is a background shell command of this session
//   that is exactly this session's wait command, carries the text as a candidate. Text the user types is a user row,
//   never a tool result, so it is never a candidate;
// - a post: a successful send_message through Qoder's mcp_call (or a direct MCP tool name), its server as recorded in
//   `mcp__<server>__send_message`, and the messageId it returned.
// Every returned text has orrery tickets masked (../shared/wait-ticket.ts): the wait command shown holds this session's
// reusable ticket. The evidence above is taken from the raw row.
import { join } from 'node:path';
import { emptyTranscriptPage, type TranscriptPage, type TranscriptRequest, type TranscriptSource } from '../../core/types.ts';
import { bounded, readSqliteTranscript, SQLITE_ROW_BYTES, type SqliteRow } from '../shared/sqlite-transcript.ts';
import type { TranscriptDraft } from '../shared/transcript.ts';
import { maskDrafts } from '../shared/wait-ticket.ts';

const DB = 'main.sqlite';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** How many earlier assistant rows are searched for the shell command that started a delivery turn's task. */
// shortcut: a wait started more than this many assistant turns before its delivery stays unlinked; widen if seen.
const WAIT_ROWS = 16;
const ENVELOPE = '[orrery] cluster=';
/** Row and tool statuses after which Qoder no longer changes the record. Anything else is read again later. */
const DONE = new Set(['completed', 'interrupted', 'failed', 'error', 'cancelled', 'canceled', 'aborted']);

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const label = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const iso = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const ms = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
const json = (value: unknown): Json | undefined => {
  if (typeof value !== 'string') return undefined;
  try { return object(JSON.parse(value)); } catch { return undefined; }
};

type Candidate = NonNullable<TranscriptSource['candidate']>;

/** The session id in the exact command wait_for_messages gives a Qoder member (src/mcp/wait-core.ts), else undefined. */
export function waitCommandSession(command: unknown): string | undefined {
  const match = typeof command === 'string'
    ? /^node "[^"\r\n]*\/wait\.mjs" q(?:1\.|2\.[0-9a-f-]{36}\.)([0-9a-f-]{36})\.[0-9a-f]{64} http:\/\/127\.0\.0\.1:\d{1,5} qoder Qoder\.exe$/.exec(command) : null;
  return match?.[1];
}

/** The envelope or direct body of a whole-file Read (lines numbered from 1, `N<tab>`), else undefined. */
export function waitOutput(output: string): Candidate | undefined {
  const lines: string[] = [];
  for (const line of output.replace(/\r?\n$/, '').split('\n')) {
    const numbered = /^(\d+)\t(.*?)\r?$/.exec(line);
    if (numbered?.[1] !== String(lines.length + 1)) return undefined;
    lines.push(numbered[2]!);
  }
  while (lines.at(-1) === '') lines.pop();
  if (!lines.length) return undefined;
  return lines[0]!.startsWith(ENVELOPE) ? { envelope: lines.join('\n') } : { direct: { body: lines.join('\n') } };
}

function postId(output: string | undefined): string | undefined {
  if (!output) return undefined;
  // orrery answers with one JSON line, sometimes followed by an unread hint.
  for (const text of [output, output.split('\n', 1)[0]!]) {
    try {
      const value = object(JSON.parse(text));
      if (value && Array.isArray(value.deliveredTo) && value.deliveredTo.every(name => typeof name === 'string')) return label(value.messageId);
    } catch { /* regular output */ }
  }
  return undefined;
}

/** `mcp__<server>__<tool>`: the tool is the last segment, so a server name may itself contain `__`. */
function mcpName(name: string | undefined): { server: string; tool: string } | undefined {
  if (!name?.startsWith('mcp__')) return undefined;
  const cut = name.lastIndexOf('__');
  const server = name.slice(5, cut);
  const tool = name.slice(cut + 2);
  return cut > 5 && server && tool ? { server, tool } : undefined;
}

interface Row { id: string; sessionId: string; at?: string; wait?: Json; task?: string }

/** Is this Read the delivery turn's own read of its task's output, and was that task this session's wait command? */
function waitRead(row: Row, input: Json | undefined): boolean {
  const { task, wait } = row;
  if (!task || !wait || (wait.name !== 'Bash' && wait.name !== 'PowerShell') || (wait.background !== 1 && wait.background !== true)) return false;
  if (waitCommandSession(wait.command) !== row.sessionId) return false;
  // Only file_path: an offset or limit would be part of the file.
  const path = input && Object.keys(input).length === 1 ? str(input.file_path) : undefined;
  return !!path && path.replaceAll('\\', '/').endsWith(`/${task}.output`);
}

function tool(row: Row, partId: string, part: Json, at: string | undefined): TranscriptDraft[] {
  const t = object(part.tool) ?? {};
  const input = object(t.input);
  const callName = label(t.name);
  // Qoder calls MCP tools through its own mcp_call tool, naming the real one in input.toolName.
  const name = callName === 'mcp_call' ? label(input?.toolName) ?? callName : callName;
  const mcp = mcpName(name);
  const callId = label(t.id);
  const source: TranscriptSource = { ...(callId && { toolCallId: callId }), ...(mcp ? { toolName: mcp.tool, toolServer: mcp.server } : name && { toolName: name }) };
  const timestamp = iso(t.startedAt) ?? at;
  const args = callName === 'mcp_call' ? input?.arguments : t.input;
  const items: TranscriptDraft[] = [{ id: `qoder:${row.id}:${partId}:call`, kind: 'tool_call', name, callId, timestamp, source,
    ...(args === undefined ? {} : { text: JSON.stringify(args) }) }];
  const status = str(t.status);
  const response = str(t.response);
  if (!status || !DONE.has(status)) return items;
  const ok = status === 'completed';
  const result: TranscriptDraft = { id: `qoder:${row.id}:${partId}:result`, kind: 'tool_result', name, callId, timestamp: iso(t.completedAt) ?? timestamp,
    text: response ?? (ok ? '工具结果' : '工具出错'), source: { ...source } };
  if (ok && mcp?.tool === 'send_message') {
    const messageId = postId(response);
    if (messageId) result.source!.postMessageId = messageId;
  }
  if (ok && response !== undefined && callName === 'Read' && waitRead(row, input)) {
    const candidate = waitOutput(response);
    if (candidate?.direct) candidate.direct.at = timestamp;
    if (candidate) result.source!.candidate = candidate;
  }
  items.push(result);
  return items;
}

function parse(sessionId: string, r: SqliteRow): { items: TranscriptDraft[]; final?: boolean } | undefined {
  const id = label(r.id);
  if (!id) return undefined;
  const payload = json(r.payload);
  if (!payload) return r.payload === null ? { items: [{ kind: 'unknown', text: '记录超过读取上限', truncated: true }] } : undefined;
  const parts = payload.parts;
  if (!Array.isArray(parts)) return undefined;
  const status = str(r.status);
  const role = str(r.role);
  const task = str(payload.backgroundTaskId);
  const row: Row = { id, sessionId, at: ms(r.created), wait: json(r.wait), ...(task && TASK_RE.test(task) && { task }) };
  const items: TranscriptDraft[] = [];
  parts.forEach((value, index) => {
    const part = object(value) ?? {};
    const partId = label(part.id) ?? String(index);
    const at = iso(part.startedAt) ?? row.at;
    const base = { id: `qoder:${id}:${partId}`, timestamp: at };
    switch (`${role}:${str(part.type)}`) {
      case 'user:text': items.push({ ...base, kind: 'user', text: str(part.text) }); break;
      case 'assistant:text': items.push({ ...base, kind: 'assistant', text: str(part.text) }); break;
      // Reasoning text is not shown: only what the app itself presents as a summary may be (docs/security.md).
      case 'assistant:thinking': items.push({ ...base, kind: 'thinking' }); break;
      case 'assistant:tool': items.push(...tool(row, partId, part, at)); break;
      case 'assistant:hook': case 'system:hook': {
        const hook = object(part.hook);
        items.push({ ...base, kind: 'system', name: label(hook?.event) ?? 'hook', timestamp: iso(hook?.startedAt) ?? at,
          text: [label(hook?.name), label(hook?.status)].filter(Boolean).join(' · ') || undefined });
        break;
      }
      default: items.push({ ...base, kind: 'unknown', text: '无法识别的 Qoder 记录' });
    }
  });
  return { items, final: !!status && DONE.has(status) };
}

/** The shell command, if any, that started the background task naming this row; null for other rows. */
const WAIT_SQL = `CASE WHEN octet_length(m.payload_json) <= ${SQLITE_ROW_BYTES} AND json_valid(m.payload_json)
    AND json_type(m.payload_json, '$.backgroundTaskId') = 'text' THEN (
  SELECT json_object('name', json_extract(p.value, '$.tool.name'), 'command', json_extract(p.value, '$.tool.input.command'),
    'background', json_extract(p.value, '$.tool.input.run_in_background'))
  FROM chat_session_messages w, json_each(CASE WHEN octet_length(w.payload_json) <= ${SQLITE_ROW_BYTES} AND json_valid(w.payload_json)
    THEN w.payload_json ELSE '{}' END, '$.parts') p
  WHERE w.session_id = m.session_id AND w.sequence IN (SELECT sequence FROM chat_session_messages WHERE session_id = m.session_id AND role = 'assistant'
      AND sequence < m.sequence ORDER BY sequence DESC LIMIT ${WAIT_ROWS})
    AND json_extract(p.value, '$.type') = 'tool' AND json_extract(p.value, '$.tool.taskId') = json_extract(m.payload_json, '$.backgroundTaskId')
  ORDER BY w.sequence DESC LIMIT 1) END`;

/** A bounded page of the bound Qoder session, read in place without writing any file. */
export function qoderTranscript(qoderData: string, sessionId: string, request: TranscriptRequest): Promise<TranscriptPage> {
  if (!UUID_RE.test(sessionId)) return Promise.resolve(emptyTranscriptPage('refused'));
  return readSqliteTranscript({
    root: qoderData, file: join(qoderData, DB), sessionKey: sessionId, request,
    schema: { chat_sessions: ['session_id', 'deleted_at'],
      chat_session_messages: ['session_id', 'message_id', 'sequence', 'role', 'status', 'created_at', 'payload_json'] },
    session: { sql: 'SELECT 1 FROM chat_sessions WHERE session_id = ? AND deleted_at IS NULL', params: [sessionId] },
    from: 'chat_session_messages m', where: 'm.session_id = ?', params: [sessionId],
    order: ['m.sequence'],
    select: `m.message_id AS id, m.role AS role, m.status AS status, m.created_at AS created, ${bounded('m.payload_json')} AS payload, ${WAIT_SQL} AS wait`,
    // `wait` is looked up from earlier rows, not this row's own content.
    content: ['id', 'role', 'status', 'payload'],
    parse: (row) => {
      const result = parse(sessionId, row);
      return result && { ...result, items: maskDrafts(result.items) };
    },
    unknownText: '无法识别的 Qoder 记录',
  });
}
