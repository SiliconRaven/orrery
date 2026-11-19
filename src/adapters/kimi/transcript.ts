// Kimi Code owns this on-disk format. Hub resolves any Orrery attribution after reading the bound session.
import { emptyTranscriptPage, truncateTranscriptText, type TranscriptItem, type TranscriptPage, type TranscriptRequest, type TranscriptSource } from '../../core/types.ts';
import { confinedFile, inspectTranscriptPrefix, readTranscriptPage, type TranscriptDraft } from '../shared/transcript.ts';
import { SESSION_ID_RE } from './store.ts';

// Redundant or internal wire records; turn.prompt, user turn.steer and main loop events are canonical.
const QUIET_ROWS = new Set([
  'metadata', 'environment.set_binding', 'runtime.set_binding', 'profile.bind', 'mcp.tools_discovered',
  'changeNotifier.snapshot', 'config.update', 'permission.set_mode', 'plugin.session_start', 'tool_select.initialized',
  'llm.tools_snapshot', 'llm.request', 'usage.record', 'token_counting.measured', 'token_counting.turn_recorded',
  'agent.turn.started', 'agent.turn.ended', 'prompt.completed', 'prompt.steered', 'tools.update_store',
  'file_history.tracked', 'file_history.checkpoint',
  'turn.step.retrying', 'agent.message.appended', 'context.append_message',
]);

type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const label = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;

function isoTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function inputText(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return undefined;
  const parts: string[] = [];
  for (const item of input) {
    const block = obj(item);
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  if (parts.length) return parts.join('\n');
  return input.length ? '[附件或空消息]' : '';
}

function toolOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const block = obj(item);
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    if (parts.length) return parts.join('\n');
    return output.length ? '[Non-text tool output]' : undefined;
  }
  if (output !== undefined && output !== null) return '[Non-text tool output]';
  return undefined;
}

function postId(output: unknown): string | undefined {
  let first: string | undefined;
  if (typeof output === 'string') first = output;
  else if (Array.isArray(output) && output.length > 0) {
    const block = obj(output[0]);
    if (block?.type === 'text' && typeof block.text === 'string') first = block.text;
  }
  if (!first || first.length > 64 * 1024) return undefined;
  try {
    const value = obj(JSON.parse(first));
    if (value && Array.isArray(value.deliveredTo) && value.deliveredTo.every((name) => typeof name === 'string')) {
      return label(value.messageId);
    }
  } catch { /* regular tool output */ }
  return undefined;
}

function stateIdentity(prefix: Buffer, sessionId: string): 'match' | 'conflict' {
  try {
    const state = obj(JSON.parse(prefix.toString('utf8')));
    if (typeof state?.id === 'string' && state.id.toLowerCase() === sessionId.toLowerCase()) return 'match';
  } catch { /* invalid state.json */ }
  return 'conflict';
}

function parse(value: unknown): TranscriptDraft[] | undefined {
  const row = obj(value);
  if (!row) return undefined;
  const timestamp = isoTime(row.time);
  const type = label(row.type);
  if (type && (QUIET_ROWS.has(type) || type.startsWith('subagent.'))) return [];

  const unknown = (name?: string): TranscriptDraft => ({
    kind: 'unknown', name, text: '[Unrecognized Kimi record]', timestamp,
  });

  switch (row.type) {
    case 'turn.prompt': {
      if (row.agentId !== undefined && row.agentId !== 'main') return [];
      const text = inputText(row.input);
      if (text === undefined) return [unknown('turn.prompt')];
      const promptId = label(row.promptId);
      return [{
        kind: 'user',
        ...truncateTranscriptText(text),
        timestamp,
        ...(promptId ? { id: `kimi:prompt:${promptId}`, source: { deliveryId: promptId } } : {}),
      }];
    }
    case 'turn.steer': {
      if (row.agentId !== undefined && row.agentId !== 'main') return [];
      if (obj(row.origin)?.kind !== 'user') return [];
      const text = inputText(row.input);
      if (text === undefined) return [unknown('turn.steer')];
      const promptIds = Array.isArray(row.promptIds) ? row.promptIds : [];
      const deliveryId = promptIds.length === 1 ? label(promptIds[0]) : undefined;
      return [{
        kind: 'user',
        ...truncateTranscriptText(text),
        timestamp,
        ...(deliveryId ? { id: `kimi:prompt:${deliveryId}`, source: { deliveryId } } : {}),
      }];
    }
    case 'context.append_loop_event': {
      if (row.agentId !== 'main') return [];
      const ev = obj(row.event);
      if (!ev) return undefined;
      const evType = label(ev.type);
      switch (ev.type) {
        case 'step.begin':
        case 'step.end':
          return [];
        case 'content.part': {
          const part = obj(ev.part);
          const uuid = label(ev.uuid);
          if (part?.type === 'text' && typeof part.text === 'string') {
            return [{
              kind: 'assistant',
              ...truncateTranscriptText(part.text),
              timestamp,
              ...(uuid ? { id: `kimi:part:${uuid}` } : {}),
            }];
          }
          if (part?.type === 'think') {
            // Never expose raw reasoning text or keys from local wire logs.
            return [{
              kind: 'thinking',
              timestamp,
              ...(uuid ? { id: `kimi:part:${uuid}` } : {}),
            }];
          }
          return [unknown(label(part?.type) ?? 'content.part')];
        }
        case 'tool.call': {
          const name = label(ev.name);
          const callId = label(ev.toolCallId);
          const mcp = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
          const source: TranscriptSource | undefined = callId ? {
            toolCallId: callId,
            toolName: mcp?.[2] ?? name,
            toolServer: mcp?.[1],
          } : undefined;
          const args = ev.args === undefined ? undefined : JSON.stringify(ev.args);
          return [{
            kind: 'tool_call',
            name,
            timestamp,
            ...(callId ? { id: `kimi:call:${callId}`, callId, source } : {}),
            ...(args === undefined ? {} : truncateTranscriptText(args)),
          }];
        }
        case 'tool.result': {
          const callId = label(ev.toolCallId);
          const result = obj(ev.result);
          const isError = result?.isError === true || result?.is_error === true;
          const output = toolOutput(result?.output);
          const postMessageId = callId && !isError ? postId(result?.output) : undefined;
          return [{
            kind: 'tool_result',
            timestamp,
            ...(callId ? {
              id: `kimi:result:${callId}`,
              callId,
              source: { toolCallId: callId, ...(postMessageId ? { postMessageId } : {}) },
            } : {}),
            ...(output === undefined ? {} : truncateTranscriptText(output)),
          }];
        }
        default:
          return [unknown(evType)];
      }
    }
    case 'turn.step.interrupted': {
      if (row.agentId !== undefined && row.agentId !== 'main') return [];
      const text = str(row.message) ?? str(row.reason) ?? '轮次已中断';
      return [{ kind: 'system', name: 'interrupted', ...truncateTranscriptText(text), timestamp }];
    }
    case 'turn.ended': {
      if (row.agentId !== undefined && row.agentId !== 'main') return [];
      const error = str(row.error);
      return error ? [{ kind: 'system', name: 'turn_error', ...truncateTranscriptText(error), timestamp }] : [];
    }
    default:
      return [unknown(type)];
  }
}

export interface KimiTranscriptCandidate {
  stateFile: string;
  wireFile: string;
}

/** Read a bound Kimi Code session's main wire.jsonl after verifying its state.json identity. */
export async function readKimiTranscript(
  sessionsDir: string,
  candidates: KimiTranscriptCandidate[],
  sessionId: string,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  if (!SESSION_ID_RE.test(sessionId)) return emptyTranscriptPage('refused');
  if (!candidates.length) return emptyTranscriptPage('missing');

  const confirmed: { stateFile: string; wireFile: string; mtimeNs: bigint }[] = [];
  let sawRefused = false;

  for (const candidate of candidates) {
    const identity = await inspectTranscriptPrefix(sessionsDir, candidate.stateFile, (prefix) => stateIdentity(prefix, sessionId));
    if (identity !== 'match') {
      sawRefused = true;
      continue;
    }
    const wire = await confinedFile(sessionsDir, candidate.wireFile).catch((e: NodeJS.ErrnoException) =>
      e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : ('err' as const));
    if (wire === null) continue;
    if (wire === undefined || wire === 'err') {
      sawRefused = true;
      continue;
    }
    confirmed.push({ stateFile: candidate.stateFile, wireFile: candidate.wireFile, mtimeNs: wire.checked.mtimeNs });
  }

  if (!confirmed.length) return emptyTranscriptPage(sawRefused ? 'refused' : 'missing');
  confirmed.sort((a, b) => (b.mtimeNs > a.mtimeNs ? 1 : b.mtimeNs < a.mtimeNs ? -1 : 0));
  const selected = confirmed[0]!;

  const read = (req: TranscriptRequest) => readTranscriptPage({
    root: sessionsDir,
    file: selected.wireFile,
    sessionKey: sessionId,
    request: req,
    prepare(prefix) {
      if (prefix.length === 0) return;
      const firstEnd = prefix.indexOf(10);
      if (firstEnd < 0) return prefix.length >= 64 * 1024 ? 'unsupported' : undefined;
      const firstLine = prefix.toString('utf8', 0, firstEnd).replace(/\r$/, '');
      try {
        const first = obj(JSON.parse(firstLine));
        if (first?.type === 'metadata') return;
      } catch { /* fall through to unsupported */ }
      return 'unsupported';
    },
    parse: (value) => parse(value),
    unknownText: '[Unreadable Kimi record]',
  });

  const page = await read(request);
  if (page.status !== 'ok') return page;

  if ((await inspectTranscriptPrefix(sessionsDir, selected.stateFile, (prefix) => stateIdentity(prefix, sessionId))) !== 'match') {
    return emptyTranscriptPage('reset');
  }

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
