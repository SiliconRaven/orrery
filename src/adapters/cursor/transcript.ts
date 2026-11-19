// Cursor owns this on-disk format: <cursorHome>/projects/<encoded>/agent-transcripts/<id>/<id>.jsonl.
// Never reads any sqlite database, never executes external commands, and returns unverified delivery candidates to the Hub.
import { emptyTranscriptPage, truncateTranscriptText, type TranscriptPage, type TranscriptRequest, type TranscriptSource } from '../../core/types.ts';
import { confinedFile, readTranscriptPage, TRANSCRIPT_LINE_BYTES, type TranscriptDraft } from '../shared/transcript.ts';
import { SESSION_ID_RE } from './store.ts';

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const label = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const CURSOR_STAMP_RE = /^(?:[A-Za-z]+,\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s*\(UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?\)$/i;
const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parse Cursor's `<timestamp>` text (minute resolution, explicit `(UTC±H[:M])` offset) without local-TZ drift. */
export function parseCursorTimestamp(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  const m = trimmed.match(CURSOR_STAMP_RE);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    const day = Number(m[2]);
    const year = Number(m[3]);
    const hour12 = Number(m[4]);
    const minute = Number(m[5]);
    const ampm = m[6]!.toUpperCase();
    const offSign = m[7] === '-' ? -1 : 1;
    const offHours = m[8] === undefined ? 0 : Number(m[8]);
    const offMinutes = m[9] === undefined ? 0 : Number(m[9]);
    if (month === undefined || year < 1970 || year > 2999 || day < 1 || day > 31
      || hour12 < 1 || hour12 > 12 || minute > 59 || offHours > 23 || offMinutes > 59) return undefined;
    let hour24 = hour12 === 12 ? 0 : hour12;
    if (ampm === 'PM') hour24 += 12;
    const check = new Date(Date.UTC(year, month, day, hour24, minute, 0, 0));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return undefined;
    const offsetMs = offSign * (offHours * 60 + offMinutes) * 60_000;
    return new Date(check.getTime() - offsetMs).toISOString();
  }
  if (ISO_OFFSET_RE.test(trimmed) && Number.isFinite(Date.parse(trimmed))) {
    return new Date(trimmed).toISOString();
  }
  return undefined;
}

function extractUserText(rawContent: unknown): string | undefined {
  if (typeof rawContent === 'string') return rawContent;
  if (!Array.isArray(rawContent)) return undefined;
  const parts: string[] = [];
  for (const item of rawContent) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const block = obj(item);
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  if (parts.length) return parts.join('\n');
  return rawContent.length ? '[Non-text user content]' : '';
}

function unwrapCursorUser(raw: string): { body: string; timestamp?: string } {
  let rest = raw;
  let timestamp: string | undefined;
  const ts = rest.match(/^\s*<timestamp>([\s\S]*?)<\/timestamp>(?:\r?\n)?/);
  if (ts) {
    timestamp = parseCursorTimestamp(ts[1]!);
    rest = rest.slice(ts[0].length);
  }
  const uq = rest.match(/^\s*<user_query>([\s\S]*)<\/user_query>\s*$/);
  const body = uq ? uq[1]!.replace(/^\r?\n/, '').replace(/\r?\n$/, '') : rest;
  return { body, timestamp };
}

function cursorCandidate(body: string): NonNullable<TranscriptSource['candidate']> | undefined {
  const m = body.match(/^\[orrery(?: · [^\r\n]*?)? · #([0-9a-f]{8})\]\r?\n([\s\S]*)$/);
  if (!m) return undefined;
  const handout = m[1]!;
  const payload = m[2]!;
  if (payload.startsWith('[orrery] cluster=')) {
    return { envelope: payload.split(/\r?\n/, 1)[0]! };
  }
  // Cursor timestamps lack seconds, so omit `at` to avoid false `created_at <= at` mismatches; use body + 8-hex prefix.
  return payload.length > 0 ? { direct: { body: payload, deliveryIdPrefix: handout } } : undefined;
}

function parse(value: unknown): TranscriptDraft[] | undefined {
  const row = obj(value);
  if (!row) return undefined;

  const unknown = (name?: string): TranscriptDraft => ({
    kind: 'unknown',
    name,
    text: '[Unrecognized Cursor record]',
  });

  const role = label(row.role) ?? label(obj(row.message)?.role);
  if (role === 'user' || (role === undefined && row.type === 'user')) {
    const rawContent = obj(row.message)?.content ?? row.content ?? row.text;
    const rawText = extractUserText(rawContent);
    if (rawText === undefined) return [unknown('user')];
    const { body, timestamp } = unwrapCursorUser(rawText);
    const candidate = cursorCandidate(body);
    return [{
      kind: 'user',
      ...truncateTranscriptText(body),
      ...(timestamp ? { timestamp } : {}),
      ...(candidate ? { source: { candidate } } : {}),
    }];
  }

  if (role === 'assistant' || (role === undefined && row.type === 'assistant')) {
    const rawContent = obj(row.message)?.content ?? row.content ?? row.text;
    if (typeof rawContent === 'string') {
      return [{ kind: 'assistant', ...truncateTranscriptText(rawContent) }];
    }
    if (!Array.isArray(rawContent)) return [unknown('assistant')];
    const items: TranscriptDraft[] = [];
    for (const entry of rawContent) {
      if (typeof entry === 'string') {
        items.push({ kind: 'assistant', ...truncateTranscriptText(entry) });
        continue;
      }
      const block = obj(entry);
      if (block?.type === 'text' && typeof block.text === 'string') {
        items.push({ kind: 'assistant', ...truncateTranscriptText(block.text) });
        continue;
      }
      if (block?.type === 'thinking') {
        // Never expose raw reasoning text.
        items.push({ kind: 'thinking' });
        continue;
      }
      if (block?.type === 'tool_use') {
        const rawName = label(block.name);
        if (rawName === 'CallDynamicTool') {
          const input = obj(block.input);
          const tn = label(input?.toolName);
          const ns = label(input?.namespace);
          if (tn) {
            const name = ns ? `${ns}:${tn}` : tn;
            const args = input?.arguments !== undefined ? JSON.stringify(input.arguments) : JSON.stringify(input);
            items.push({ kind: 'tool_call', name, ...(args !== undefined ? truncateTranscriptText(args) : {}) });
            continue;
          }
        }
        const args = block.input === undefined ? undefined : JSON.stringify(block.input);
        items.push({ kind: 'tool_call', ...(rawName ? { name: rawName } : {}), ...(args !== undefined ? truncateTranscriptText(args) : {}) });
        continue;
      }
      items.push({ kind: 'unknown', name: label(block?.type), text: '[Unrecognized Cursor content block]' });
    }
    return items;
  }

  if (row.type === 'turn_ended') {
    const status = label(row.status);
    if (status === 'success' || status === 'completed') return [];
    if (status) return [{ kind: 'system', name: 'turn_ended', text: `Cursor turn ${status}` }];
    return [unknown('turn_ended')];
  }

  return [unknown(label(row.type) ?? role)];
}

function isCursorRow(row: JsonObject | undefined): boolean {
  if (!row) return false;
  const role = label(row.role) ?? label(obj(row.message)?.role);
  if ((role === 'user' || role === 'assistant') && (obj(row.message) || row.content !== undefined || row.text !== undefined)) return true;
  return row.type === 'turn_ended' || ((row.type === 'user' || row.type === 'assistant') && (row.content !== undefined || row.text !== undefined));
}

function isCursorHeader(prefix: Buffer): 'unsupported' | undefined {
  if (prefix.length === 0) return undefined;
  const firstEnd = prefix.indexOf(10);
  if (firstEnd < 0) {
    if (prefix.length > TRANSCRIPT_LINE_BYTES || prefix.includes(0)) return 'unsupported';
    const raw = prefix.toString('utf8').replace(/\r$/, '');
    const trimmed = raw.trimStart();
    if (!trimmed) return undefined;
    if (!/^\{\s*(?:$|")/.test(trimmed)) return 'unsupported';
    try {
      return isCursorRow(obj(JSON.parse(raw))) ? undefined : 'unsupported';
    } catch {
      // Short/incomplete JSON object still being written on line 1; wait for trailing newline before emitting records.
      return undefined;
    }
  }
  if (firstEnd > TRANSCRIPT_LINE_BYTES) return 'unsupported';
  const firstLine = prefix.toString('utf8', 0, firstEnd).replace(/\r$/, '');
  if (!firstLine.trim()) return undefined;
  try {
    return isCursorRow(obj(JSON.parse(firstLine))) ? undefined : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/** Read a bound Cursor session's agent transcript under `<cursorHome>/projects`, never opening any sqlite file. */
export async function readCursorTranscript(
  projectsDir: string,
  listCandidates: () => Promise<string[]>,
  sessionId: string,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  if (!SESSION_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') return emptyTranscriptPage('refused');
  const candidates = await listCandidates();
  if (!candidates.length) return emptyTranscriptPage('missing');

  const confirmed: { file: string; mtimeNs: bigint }[] = [];
  let sawRefused = false;

  for (const file of candidates) {
    const confined = await confinedFile(projectsDir, file).catch((e: NodeJS.ErrnoException) =>
      e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : ('err' as const));
    if (confined === null) continue;
    if (confined === undefined || confined === 'err') {
      sawRefused = true;
      continue;
    }
    confirmed.push({ file, mtimeNs: confined.checked.mtimeNs });
  }

  if (!confirmed.length) return emptyTranscriptPage(sawRefused ? 'refused' : 'missing');
  confirmed.sort((a, b) => (b.mtimeNs > a.mtimeNs ? 1 : b.mtimeNs < a.mtimeNs ? -1 : 0));
  const selected = confirmed[0]!;

  return readTranscriptPage({
    root: projectsDir,
    file: selected.file,
    sessionKey: sessionId,
    request,
    prepare: isCursorHeader,
    prefixBytes: TRANSCRIPT_LINE_BYTES + 2,
    parse,
    unknownText: '[Unreadable Cursor record]',
  });
}
