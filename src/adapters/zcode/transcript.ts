// ZCode owns this format (docs/adapters/zcode.md, "读对话原文"): <zcode home>/cli/db/db.sqlite, table message (one row
// per user or assistant message, JSON in `data`) and table part (its parts in order: text, reasoning, tool, ...). Read
// in place through the shared read-only reader. The Hub links orrery evidence after the read:
// - a delivery: the wait command prints it into its output file and the member reads that file with Read. Only a Read
//   result that is exactly that output (wait.mjs's first line, then the envelope, then the rearm tail naming this
//   session's ticket) carries the envelope (or a direct message's body) as a candidate. Text the user types is a user
//   message, never a tool result, so it is never a candidate;
// - a post: a successful MCP send_message, its server and tool name as ZCode recorded them, and the messageId it returned.
// Every returned text has orrery tickets masked (../shared/wait-ticket.ts); the evidence above is taken from the raw row.
import { join } from 'node:path';
import { emptyTranscriptPage, type TranscriptPage, type TranscriptRequest, type TranscriptSource } from '../../core/types.ts';
import { bounded, readSqliteTranscript, type SqliteRow } from '../shared/sqlite-transcript.ts';
import type { TranscriptDraft } from '../shared/transcript.ts';
import { maskDrafts } from '../shared/wait-ticket.ts';

const DB = join('cli', 'db', 'db.sqlite');
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** The first line plugins/zcode-orrery/wait.mjs prints (STARTED, a test keeps them equal). */
export const WAIT_STARTED = 'orrery：正在等群消息。如果这条命令被停止（不是正常结束），不要重新运行，也不要再处理之前已经处理过的消息。';
const ENVELOPE = '[orrery] cluster=';

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const label = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const time = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
const json = (value: unknown): Json | undefined => {
  if (typeof value !== 'string') return undefined;
  try { return object(JSON.parse(value)); } catch { return undefined; }
};

type Candidate = NonNullable<TranscriptSource['candidate']>;

/** The envelope or direct body of a Read of the wait command's output for this session, else undefined. */
export function waitOutput(output: string, sessionId: string): Candidate | undefined {
  const lines: string[] = [];
  for (const line of output.replace(/\r?\n$/, '').split('\n')) {
    const numbered = /^(\d+)\t(.*?)\r?$/.exec(line);
    // Every line numbered from 1: a Read of the whole output file, not part of it or something else.
    if (numbered?.[1] !== String(lines.length + 1)) return undefined;
    lines.push(numbered[2]!);
  }
  if (lines[0] !== WAIT_STARTED) return undefined;
  const tail = lines.findIndex((line, i) => line === '----------' && lines[i + 1]?.startsWith('（orrery 等待命令）'));
  if (tail < 2) return undefined;
  // The rearm tail names the ticket of the session it was delivered to: z1.<session id>.<64 hex>.
  const ticket = new RegExp(`wait\\.mjs" z1\\.${sessionId.replaceAll('.', '\\.')}\\.[0-9a-f]{64} http://127\\.0\\.0\\.1:\\d+$`);
  if (!lines.slice(tail).some(line => ticket.test(line))) return undefined;
  const content = lines.slice(1, tail);
  while (content.at(-1) === '') content.pop();
  const start = content.findIndex(line => line.startsWith(ENVELOPE));
  if (start >= 0) return { envelope: content.slice(start).join('\n') };
  return content.length ? { direct: { body: content.join('\n') } } : undefined;
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

function tool(sessionId: string, id: string, part: Json, at: string | undefined): { items: TranscriptDraft[]; final: boolean } {
  const state = object(part.state);
  const name = label(part.tool);
  const callId = label(part.callID);
  const display = object(object(state?.metadata)?.display);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
  const fromDisplay = display?.kind === 'mcp_tool';
  const toolServer = (fromDisplay ? label(display.serverName) : undefined) ?? mcp?.[1];
  const toolName = (fromDisplay ? label(display.toolName) : undefined) ?? mcp?.[2] ?? name;
  const source: TranscriptSource = { ...(callId && { toolCallId: callId }), ...(toolName && { toolName }), ...(toolServer && { toolServer }) };
  const timestamp = time(object(state?.time)?.start) ?? at;
  const input = state?.input === undefined ? undefined : JSON.stringify(state.input);
  const items: TranscriptDraft[] = [{ id: `zcode:${id}:call`, kind: 'tool_call', name, callId, timestamp, source,
    ...(input === undefined ? {} : { text: input }) }];
  const status = state?.status;
  if (status !== 'completed' && status !== 'error') return { items, final: false };
  const output = status === 'completed' ? str(state?.output) : undefined;
  const result: TranscriptDraft = { id: `zcode:${id}:result`, kind: 'tool_result', name, callId, timestamp,
    text: output ?? str(state?.error) ?? (status === 'error' ? '工具出错' : '工具结果'), source: { ...source } };
  if (output !== undefined && toolServer && toolName === 'send_message') {
    const messageId = postId(output);
    if (messageId) result.source!.postMessageId = messageId;
  }
  if (output !== undefined && name === 'Read') {
    const candidate = waitOutput(output, sessionId);
    if (candidate?.direct) candidate.direct.at = timestamp;
    if (candidate) result.source!.candidate = candidate;
  }
  items.push(result);
  return { items, final: true };
}

function parse(sessionId: string, row: SqliteRow): { items: TranscriptDraft[]; final?: boolean } | undefined {
  const id = label(row.pid);
  const message = json(row.mdata);
  const part = json(row.pdata);
  if (!id) return undefined;
  if (!message || !part) {
    if (row.mdata === null || row.pdata === null) return { items: [{ kind: 'unknown', text: '记录超过读取上限', truncated: true }] };
    return undefined;
  }
  const at = time(object(part.time)?.start) ?? time(object(message.time)?.created);
  const ended = typeof object(part.time)?.end === 'number';
  const text = str(part.text);
  switch (`${str(message.role)}:${str(part.type)}`) {
    case 'user:text': {
      // ZCode's own context (reminders, background task notices, environment) is marked synthetic and model-only.
      const meta = object(part.metadata) ?? object(message.metadata);
      const injected = part.synthetic === true || message.synthetic === true || meta?.visibility === 'model-only';
      return { items: [{ id: `zcode:${id}`, timestamp: at, text, ...(injected
        ? { kind: 'system', name: label(meta?.source) ?? label(message.source) } : { kind: 'user' }) }] };
    }
    case 'assistant:text': return { items: [{ id: `zcode:${id}`, kind: 'assistant', timestamp: at, text }], final: ended };
    // Reasoning text is not shown: only what the app itself presents as a summary may be (docs/security.md).
    case 'assistant:reasoning': return { items: [{ id: `zcode:${id}`, kind: 'thinking', timestamp: at }], final: ended };
    case 'assistant:tool': return tool(sessionId, id, part, at);
    case 'assistant:step-start': case 'assistant:step-finish': return { items: [] };
    case 'assistant:timeline': return { items: [{ id: `zcode:${id}`, kind: 'system', name: label(part.timelineType), timestamp: at, text: str(part.display) }] };
    default: return undefined;
  }
}

/** A bounded page of the bound ZCode session, read in place without writing any file. */
export function zcodeTranscript(zcodeHome: string, sessionId: string, request: TranscriptRequest): Promise<TranscriptPage> {
  if (!SESSION_RE.test(sessionId)) return Promise.resolve(emptyTranscriptPage('refused'));
  return readSqliteTranscript({
    root: zcodeHome, file: join(zcodeHome, DB), sessionKey: sessionId, request,
    schema: { session: ['id', 'time_deleted'], message: ['id', 'session_id', 'time_created', 'data', 'sequence'],
      part: ['id', 'message_id', 'time_created', 'data', 'sequence'] },
    session: { sql: 'SELECT 1 FROM session WHERE id = ? AND time_deleted IS NULL', params: [sessionId] },
    from: 'message m JOIN part p ON p.message_id = m.id', where: 'm.session_id = ?', params: [sessionId],
    order: ['m.sequence', 'm.time_created', 'm.id', 'p.sequence', 'p.time_created', 'p.id'],
    select: `p.id AS pid, ${bounded('m.data')} AS mdata, ${bounded('p.data')} AS pdata`,
    // The message's data changes while later parts are written; a finished part's own data does not.
    content: ['pdata'],
    parse: (row) => {
      const result = parse(sessionId, row);
      return result && { ...result, items: maskDrafts(result.items) };
    },
    unknownText: '无法识别的 ZCode 记录',
  });
}
