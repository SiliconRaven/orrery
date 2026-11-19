// Antigravity owns this on-disk format: <geminiHome>/antigravity/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
// (falling back to transcript.jsonl only when transcript_full.jsonl is absent). Never reads encrypted .pb or sqlite logs.
import { join } from 'node:path';
import { emptyTranscriptPage, truncateTranscriptText, type TranscriptItem, type TranscriptPage, type TranscriptRequest, type TranscriptSource } from '../../core/types.ts';
import { confinedFile, readTranscriptPage, TRANSCRIPT_LINE_BYTES, type TranscriptDraft } from '../shared/transcript.ts';
import { UUID } from './store.ts';

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const label = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;

function isoTime(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

function unquoteJsonString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const inner = JSON.parse(trimmed);
      if (typeof inner === 'string') return inner;
    } catch { /* keep literal */ }
  }
  return value;
}

const CALLER_TAG_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}\b/i;
const CALLER_TAG_GLOBAL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}\b/gi;
const WAIT_TICKET_GLOBAL_RE = /\b[a-z]1\.[A-Za-z0-9._-]{1,128}\.[0-9a-f]{64}\b/g;

function sanitizeCallerString(text: string): string {
  return text
    .replace(/("?orreryCaller"?\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/("?x-orrery-(?:bridge|ticket|secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/(x-orrery-(?:bridge|ticket|secret)\s*[:=]\s*)[^\s"',;}\]]+/gi, '$1[redacted]')
    .replace(CALLER_TAG_GLOBAL_RE, '[redacted]')
    .replace(WAIT_TICKET_GLOBAL_RE, '[redacted]');
}

/** Remove `orreryCaller` HMAC signatures and echoed Orrery credentials before returning items in memory. */
export function sanitizeToolArgs(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[truncated]';
  if (typeof value === 'string') return sanitizeCallerString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeToolArgs(item, depth + 1));
  const record = obj(value);
  if (!record) return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(record)) {
    const lower = k.toLowerCase();
    if (lower === 'orrerycaller' || lower === 'x-orrery-bridge' || lower === 'x-orrery-ticket' || lower === 'x-orrery-secret') continue;
    if (lower === 'arguments' && typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        out[k] = JSON.stringify(sanitizeToolArgs(parsed, depth + 1));
        continue;
      } catch {
        out[k] = /orrerycaller|x-orrery-(?:bridge|ticket|secret)/i.test(v) || CALLER_TAG_RE.test(v) ? sanitizeCallerString(v) : v;
        continue;
      }
    }
    out[k] = sanitizeToolArgs(v, depth + 1);
  }
  return out;
}

function extractSystemCandidate(raw: string, fallbackAt?: string): NonNullable<TranscriptSource['candidate']> | undefined {
  // Boilerplate prose mentions `<SYSTEM_MESSAGE>` inline; only unwrap a standalone `<SYSTEM_MESSAGE>` block line.
  const openMatch = raw.match(/(?:^|\r?\n)<SYSTEM_MESSAGE>\r?\n/);
  const openEnd = openMatch ? (openMatch.index ?? 0) + openMatch[0].length : -1;
  const closeIdx = openEnd >= 0 ? raw.lastIndexOf('</SYSTEM_MESSAGE>') : -1;
  const inner = openEnd >= 0 && closeIdx >= openEnd ? raw.slice(openEnd, closeIdx) : raw;
  const m = inner.match(/^\s*\[Message\]\s+timestamp=(\S+)\s+sender=(\S+)\s+priority=(\S+)\s+content=([\s\S]*)$/);
  if (!m) return undefined;
  const [, rawTime, sender, priority, rawBody] = m;
  if (sender !== 'system' || priority !== 'MESSAGE_PRIORITY_HIGH') return undefined;
  const body = rawBody!.replace(/\r?\n$/, '');
  if (!body) return undefined;
  if (body.startsWith('[orrery] cluster=')) {
    return { envelope: body.split(/\r?\n/, 1)[0]! };
  }
  const at = isoTime(rawTime) ?? fallbackAt;
  return { direct: { body, ...(at ? { at } : {}) } };
}

function postIdFromGeneric(rawContent: string): string | undefined {
  const bounded = rawContent.length > 64 * 1024 ? rawContent.slice(0, 64 * 1024) : rawContent;
  const lines = bounded.replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length && i < 16; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    if (t.startsWith('Created At:') || t.startsWith('Completed At:') || t.startsWith('A pre-tool hook ')) continue;
    if (t.startsWith('{')) start = i;
    break;
  }
  if (start < 0) return undefined;

  const tryExtract = (jsonText: string): string | undefined => {
    try {
      const value = obj(JSON.parse(jsonText));
      if (value && Array.isArray(value.deliveredTo) && value.deliveredTo.every((n) => typeof n === 'string')) {
        return label(value.messageId);
      }
    } catch { /* continue checking multi-line block */ }
    return undefined;
  };

  const single = tryExtract(lines[start]!.trim());
  if (single) return single;

  const endLimit = Math.min(lines.length, start + 128);
  for (let j = start + 1; j < endLimit; j++) {
    if (!lines[j]!.trimEnd().endsWith('}')) continue;
    const hit = tryExtract(lines.slice(start, j + 1).join('\n'));
    if (hit) return hit;
  }
  return undefined;
}

function resolveMcpCall(tc: JsonObject): { displayName: string; toolName?: string; toolServer?: string } {
  const rawName = label(tc.name) ?? 'unknown_tool';
  if (rawName === 'call_mcp_tool') {
    const argsObj = obj(tc.args);
    const toolServer = label(unquoteJsonString(argsObj?.ServerName ?? argsObj?.serverName));
    const toolName = label(unquoteJsonString(argsObj?.ToolName ?? argsObj?.toolName));
    const displayName = toolServer && toolName ? `mcp:${toolServer}/${toolName}` : rawName;
    return { displayName, ...(toolName ? { toolName } : {}), ...(toolServer ? { toolServer } : {}) };
  }
  const dbl = rawName.match(/^mcp__(.+?)__(.+)$/);
  if (dbl) return { displayName: rawName, toolServer: dbl[1], toolName: dbl[2] };
  const sgl = rawName.match(/^mcp_([^_]+)_(.+)$/);
  if (sgl) return { displayName: rawName, toolServer: sgl[1], toolName: sgl[2] };
  return { displayName: rawName, toolName: rawName };
}

function parse(value: unknown): TranscriptDraft[] | undefined {
  const row = obj(value);
  if (!row) return undefined;
  const stepId = typeof row.step_index === 'number' && Number.isSafeInteger(row.step_index) && row.step_index >= 0
    ? row.step_index : undefined;
  const timestamp = isoTime(row.created_at);
  const type = label(row.type);

  const unknown = (name?: string): TranscriptDraft => ({
    kind: 'unknown',
    name,
    text: '[Unrecognized Antigravity record]',
    timestamp,
  });

  switch (row.type) {
    case 'CHECKPOINT':
      return [];

    case 'USER_INPUT': {
      const content = str(row.content);
      const text = content ?? (Array.isArray(row.media) && row.media.length ? '[Non-text user input]' : undefined);
      return [{
        ...(stepId !== undefined ? { id: `ag:${stepId}` } : {}),
        kind: 'user',
        ...(text === undefined ? {} : truncateTranscriptText(text)),
        timestamp,
      }];
    }

    case 'SYSTEM_MESSAGE': {
      const raw = str(row.content) ?? '';
      const candidate = row.source === 'SYSTEM' ? extractSystemCandidate(raw, timestamp) : undefined;
      return [{
        ...(stepId !== undefined ? { id: `ag:${stepId}` } : {}),
        kind: 'system',
        name: 'system_message',
        ...truncateTranscriptText(raw),
        timestamp,
        ...(candidate ? { source: { candidate } } : {}),
      }];
    }

    case 'ERROR_MESSAGE': {
      const text = sanitizeCallerString(str(row.error) ?? str(row.content) ?? 'Antigravity error');
      return [{
        ...(stepId !== undefined ? { id: `ag:${stepId}` } : {}),
        kind: 'system',
        name: 'error',
        ...truncateTranscriptText(text),
        timestamp,
      }];
    }

    case 'PLANNER_RESPONSE': {
      const drafts: TranscriptDraft[] = [];
      if (row.thinking !== undefined && row.thinking !== null && row.thinking !== '') {
        // Never expose raw thinking text.
        drafts.push({
          ...(stepId !== undefined ? { id: `ag:${stepId}:thinking` } : {}),
          kind: 'thinking',
          timestamp,
        });
      }
      if (typeof row.content === 'string' && row.content.length > 0) {
        drafts.push({
          ...(stepId !== undefined ? { id: `ag:${stepId}:text` } : {}),
          kind: 'assistant',
          ...truncateTranscriptText(row.content),
          timestamp,
        });
      }
      if (Array.isArray(row.tool_calls)) {
        for (let k = 0; k < row.tool_calls.length; k++) {
          const tc = obj(row.tool_calls[k]);
          if (!tc) continue;
          const callId = stepId !== undefined ? `ag:step:${stepId + 1 + k}` : undefined;
          const { displayName, toolName, toolServer } = resolveMcpCall(tc);
          const safeArgs = tc.args === undefined ? undefined : sanitizeToolArgs(tc.args);
          const argsText = safeArgs === undefined ? undefined : JSON.stringify(safeArgs);
          drafts.push({
            ...(stepId !== undefined ? { id: `ag:${stepId}:call:${k}`, callId } : {}),
            kind: 'tool_call',
            name: displayName,
            ...(argsText === undefined ? {} : truncateTranscriptText(argsText)),
            timestamp,
            ...(callId ? {
              source: {
                toolCallId: callId,
                ...(toolName ? { toolName } : {}),
                ...(toolServer ? { toolServer } : {}),
              },
            } : {}),
          });
        }
      }
      return drafts;
    }

    case 'GENERIC': {
      const callId = stepId !== undefined ? `ag:step:${stepId}` : undefined;
      const rawContent = str(row.content);
      const text = rawContent ?? str(row.error) ?? (Array.isArray(row.media) && row.media.length ? '[Non-text tool output]' : undefined);
      const postMessageId = row.status === 'DONE' && callId && rawContent !== undefined
        ? postIdFromGeneric(rawContent) : undefined;
      const safeText = text === undefined ? undefined : sanitizeCallerString(text);
      return [{
        ...(stepId !== undefined ? { id: `ag:${stepId}:result`, callId } : {}),
        kind: 'tool_result',
        ...(safeText === undefined ? {} : truncateTranscriptText(safeText)),
        timestamp,
        ...(callId ? {
          source: {
            toolCallId: callId,
            ...(postMessageId ? { postMessageId } : {}),
          },
        } : {}),
      }];
    }

    default:
      return [unknown(type)];
  }
}

function isAntigravityRow(row: JsonObject | undefined): boolean {
  return Boolean(row && typeof row.step_index === 'number' && typeof row.type === 'string' && typeof row.source === 'string');
}

function isAntigravityHeader(prefix: Buffer): 'unsupported' | undefined {
  if (prefix.length === 0) return undefined;
  const firstEnd = prefix.indexOf(10);
  if (firstEnd < 0) {
    if (prefix.length > TRANSCRIPT_LINE_BYTES || prefix.includes(0)) return 'unsupported';
    const raw = prefix.toString('utf8').replace(/\r$/, '');
    const trimmed = raw.trimStart();
    if (!trimmed) return undefined;
    if (!/^\{\s*(?:$|")/.test(trimmed)) return 'unsupported';
    try {
      return isAntigravityRow(obj(JSON.parse(raw))) ? undefined : 'unsupported';
    } catch {
      // Short/incomplete JSON object still being written on line 1; wait for trailing newline before emitting records.
      return undefined;
    }
  }
  if (firstEnd > TRANSCRIPT_LINE_BYTES) return 'unsupported';
  const raw = prefix.toString('utf8', 0, firstEnd).replace(/\r$/, '');
  if (!raw.trim()) return 'unsupported';
  try {
    return isAntigravityRow(obj(JSON.parse(raw))) ? undefined : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

async function selectTranscriptFile(brainDir: string, sessionId: string): Promise<{ status: 'ok'; file: string } | { status: 'missing' | 'refused' }> {
  const logsDir = join(brainDir, sessionId, '.system_generated', 'logs');
  const full = join(logsDir, 'transcript_full.jsonl');
  const compact = join(logsDir, 'transcript.jsonl');

  const fullConfined = await confinedFile(brainDir, full).catch((e: NodeJS.ErrnoException) =>
    e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : ('err' as const));
  if (fullConfined !== null) {
    return fullConfined && fullConfined !== 'err' ? { status: 'ok', file: full } : { status: 'refused' };
  }

  const compactConfined = await confinedFile(brainDir, compact).catch((e: NodeJS.ErrnoException) =>
    e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : ('err' as const));
  if (compactConfined === null) return { status: 'missing' };
  return compactConfined && compactConfined !== 'err' ? { status: 'ok', file: compact } : { status: 'refused' };
}

/** Read a bound Antigravity session's transcript_full.jsonl (falling back to transcript.jsonl when absent). */
export async function readAntigravityTranscript(
  brainDir: string,
  sessionId: string,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  if (!UUID.test(sessionId)) return emptyTranscriptPage('refused');
  const picked = await selectTranscriptFile(brainDir, sessionId);
  if (picked.status !== 'ok') return emptyTranscriptPage(picked.status);

  const read = (req: TranscriptRequest) => readTranscriptPage({
    root: brainDir,
    file: picked.file,
    sessionKey: sessionId,
    request: req,
    prepare: isAntigravityHeader,
    prefixBytes: TRANSCRIPT_LINE_BYTES + 2,
    parse,
    unknownText: '[Unreadable Antigravity record]',
  });

  const page = await read(request);
  if (page.status !== 'ok') return page;

  const calls = new Map<string, TranscriptSource>();
  const remember = (item: TranscriptItem) => {
    if (item.kind === 'tool_call' && item.callId && item.source) calls.set(item.callId, item.source);
  };
  const unpaired = page.items.some((item) => {
    remember(item);
    return item.source?.postMessageId && item.callId && !calls.has(item.callId);
  });
  calls.clear();
  if (unpaired && page.before) {
    const earlier = await read({ cursor: page.before, direction: 'before', limit: 64 });
    if (earlier.status === 'reset') return emptyTranscriptPage('reset');
    if (earlier.status === 'ok') earlier.items.forEach(remember);
  }
  for (const item of page.items) {
    remember(item);
    if (!item.source?.postMessageId) continue;
    const call = item.callId ? calls.get(item.callId) : undefined;
    if (call?.toolName === 'send_message' && call.toolServer) {
      item.source.toolName = call.toolName;
      item.source.toolServer = call.toolServer;
    } else {
      delete item.source.postMessageId;
    }
  }
  return page;
}
