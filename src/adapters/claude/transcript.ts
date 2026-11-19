// Claude owns this on-disk format. Hub resolves any Orrery attribution after reading the bound session.
import { createHash } from 'node:crypto';
import { emptyTranscriptPage, truncateTranscriptText, type TranscriptItem, type TranscriptPage, type TranscriptRequest, type TranscriptSource } from '../../core/types.ts';
import { inspectTranscriptPrefix, readTranscriptPage, type TranscriptDraft } from '../shared/transcript.ts';
import { transcriptIdentity } from './store.ts';

const SKIP = new Set([
  'api-request-blob', 'api-response-blob', 'file-history-snapshot', 'queue-operation', 'progress',
  'custom-title', 'ai-title', 'summary', 'last-prompt', 'agent-name', 'agent-color', 'agent-setting',
]);
const SYNTHETIC_PROMPT = /^(?:This session is being continued\b|\[Request interrupted\b|Stop hook feedback:|<(?:local-command-caveat|local-command-stdout|command-name|task-notification|cross-session-message|ide_opened_file|ide_selection)\b)/;
const remindersOnly = (text: string): boolean =>
  text.trimStart().startsWith('<system-reminder>') && text.replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() === '';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const label = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const date = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24);

// Claude Code 2.1.312 English peer notices: exact footer fingerprints for idle and busy delivery.
const LEGACY_PEER_FOOTERS = new Set([
  '13f1ea4702b0f10626f19265', '7596e05e06b0593c1bb5bb7d', 'b943b0419d02b2f5f5c2497c',
]);

function unwrapPeerPrompt(text: string): string {
  const xml = /^<cross-session-message\b[^>]*>\r?\n([\s\S]*?)\r?\n<\/cross-session-message>$/.exec(text);
  if (xml) return xml[1]!;
  const header = /^Another Claude session sent a message(?: while you were working)?:\n/.exec(text);
  if (header) {
    const footer = text.lastIndexOf('\n\nThis came from another Claude session ');
    if (footer >= header[0].length && LEGACY_PEER_FOOTERS.has(digest(text.slice(footer + 2)))) {
      return text.slice(header[0].length, footer);
    }
  }
  return text;
}

function textBlocks(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.flatMap((value) => {
    const block = object(value);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
  return blocks.length ? blocks.join('\n') : undefined;
}

function prompt(content: unknown, origin: JsonObject | undefined, isSystem: boolean, name?: string): TranscriptDraft {
  const text = textBlocks(content);
  if (origin?.kind === 'peer' && origin.from === 'orrery') {
    // The native inbox may wrap the bridge body. Unwrap exactly one outer level based on the structured origin.
    return { kind: 'user', source: { orrery: true }, ...(text === undefined ? {} : truncateTranscriptText(unwrapPeerPrompt(text))) };
  }
  return {
    kind: isSystem ? 'system' : 'user',
    ...(name ? { name } : {}),
    ...(text === undefined ? {} : truncateTranscriptText(text)),
  };
}

function toolOutput(content: unknown): string | undefined {
  const text = textBlocks(content);
  if (text !== undefined) return text;
  if (content === undefined || (Array.isArray(content) && content.length === 0)) return undefined;
  return '[Non-text tool output]';
}

function postId(content: unknown): string | undefined {
  const first = Array.isArray(content) ? textBlocks(content.slice(0, 1)) : textBlocks(content);
  if (!first || first.length > 64 * 1024) return undefined;
  try {
    // Orrery replies with one JSON text block followed by an optional unread hint.
    const value = object(JSON.parse(first));
    if (value && Array.isArray(value.deliveredTo) && value.deliveredTo.every((name) => typeof name === 'string')) return label(value.messageId);
  } catch { /* regular tool output */ }
  return undefined;
}

function toolResult(block: JsonObject): TranscriptDraft {
  const callId = label(block.tool_use_id);
  const output = toolOutput(block.content);
  const success = (block.is_error === undefined || block.is_error === false) && (block.isError === undefined || block.isError === false);
  const postMessageId = callId && success ? postId(block.content) : undefined;
  return {
    kind: 'tool_result',
    ...(callId ? {
      id: `claude:result:${callId}`, callId,
      source: { toolCallId: callId, ...(postMessageId ? { postMessageId } : {}) },
    } : {}),
    ...(output === undefined ? {} : truncateTranscriptText(output)),
  };
}

function assistantBlock(block: JsonObject): TranscriptDraft | undefined {
  switch (block.type) {
    case 'text':
      if (typeof block.text === 'string') return { kind: 'assistant', ...truncateTranscriptText(block.text) };
      break;
    case 'thinking':
    case 'redacted_thinking':
    case 'thinking_summary': {
      // A local log can also carry private thinking, signatures, and opaque reasoning data.
      const summary = block.type !== 'redacted_thinking' && typeof block.summary === 'string' ? block.summary : undefined;
      return { kind: 'thinking', ...(summary ? truncateTranscriptText(summary) : {}) };
    }
    case 'tool_use':
    case 'mcp_tool_use':
    case 'server_tool_use': {
      const name = label(block.name);
      const callId = label(block.id);
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
      const source: TranscriptSource | undefined = callId ? {
        toolCallId: callId, toolName: mcp?.[2] ?? name,
        toolServer: mcp?.[1] ?? (block.type === 'mcp_tool_use' ? label(block.server_name) : undefined),
      } : undefined;
      return {
        kind: 'tool_call', name,
        ...(callId ? { id: `claude:call:${callId}`, callId, source } : {}),
        ...(block.input === undefined ? {} : truncateTranscriptText(JSON.stringify(block.input))),
      };
    }
    case 'tool_result':
    case 'mcp_tool_result':
      return toolResult(block);
  }
}

function parse(sessionId: string, value: unknown): TranscriptDraft[] | undefined {
  const row = object(value);
  if (!row) return undefined;
  if (row.isSidechain === true || SKIP.has(label(row.type) ?? '') ||
      (typeof row.sessionId === 'string' && row.sessionId.toLowerCase() !== sessionId.toLowerCase())) return [];
  const timestamp = date(row.timestamp);
  const rowId = label(row.uuid);
  const message = object(row.message);
  const content = message?.content;
  const origin = object(row.origin);
  const originKind = label(origin?.kind);
  const attachment = object(row.attachment);
  const blocks = Array.isArray(content) ? content : [];
  const unknown = (type: unknown): TranscriptDraft => ({
    kind: 'unknown', name: label(type), text: '[Unrecognized Claude record]',
  });
  let items: TranscriptDraft[];
  switch (row.type) {
    case 'user': {
      // Some Claude input paths derive origin.kind from a textual peer wrapper. The inbox also sets native metadata.
      const trustedPeer = (originKind === 'peer' || originKind === 'channel') && row.isMeta === true &&
        (row.turnOrigin === undefined || row.turnOrigin === originKind);
      const text = textBlocks(content);
      if (row.isCompactSummary === true) {
        items = [prompt(content, undefined, true, 'compact_summary')];
      } else if (trustedPeer) {
        items = [prompt(content, origin, true, originKind)];
      } else if (blocks.some((block) => object(block)?.type === 'tool_result')) {
        items = blocks.flatMap((block) => {
          const b = object(block);
          if (b?.type === 'tool_result') return [toolResult(b)];
          if (b?.type === 'text' && typeof b.text === 'string' && !remindersOnly(b.text)) return [prompt([b], undefined, row.isMeta === true)];
          return [];
        });
      } else if (row.isMeta === true) {
        return [];
      } else if (text !== undefined) {
        const system = originKind === undefined && (SYNTHETIC_PROMPT.test(text) || remindersOnly(text));
        items = [prompt(content, undefined, system)];
      } else {
        items = [unknown('user')];
      }
      break;
    }
    case 'assistant': {
      const messageId = label(message?.id) ?? rowId;
      if (typeof content === 'string') {
        items = [{
          kind: 'assistant', ...truncateTranscriptText(content),
          ...(messageId ? { id: `claude:assistant:${messageId}:text:${digest(content)}:0` } : {}),
        }];
      } else if (blocks.length) {
        const occurrences = new Map<string, number>();
        const indices = Array.isArray(row.apiBlockIndices) ? row.apiBlockIndices : [];
        items = blocks.map((value, index) => {
          const block = object(value) ?? {};
          const item = assistantBlock(block) ?? unknown(block.type);
          if (!messageId || item.id) return item;
          const nativeIndex = indices[index] ?? (blocks.length === 1 ? row.apiBlockIndex : undefined);
          const blockId = label(block.id) ?? (Number.isSafeInteger(nativeIndex) ? `index:${nativeIndex}` : undefined);
          // Claude appends distinct blocks as separate rows with the same message.id. Collapse exact repeats and
          // preserve intentional repetition inside one row, even when the native record has no block index.
          const textKey = typeof block.text === 'string' ? digest(block.text) : '';
          const key = `${label(block.type) ?? 'unknown'}:${blockId ?? textKey}`;
          const occurrence = occurrences.get(key) ?? 0;
          occurrences.set(key, occurrence + 1);
          return { ...item, id: `claude:assistant:${messageId}:${key}:${occurrence}` };
        });
      } else {
        items = [unknown('assistant')];
      }
      break;
    }
    case 'attachment': {
      if (attachment?.type !== 'queued_command') return [];
      const queuedOrigin = object(attachment.origin) ?? origin;
      if (queuedOrigin?.kind !== 'peer' && queuedOrigin?.kind !== 'channel') return [];
      items = [{
        ...prompt(attachment.prompt, queuedOrigin, true, 'queued_command'),
        timestamp: date(attachment.timestamp) ?? timestamp,
      }];
      break;
    }
    case 'system': {
      const text = textBlocks(row.content ?? content);
      items = [{ kind: 'system', name: label(row.subtype), ...(text === undefined ? {} : truncateTranscriptText(text)) }];
      break;
    }
    case 'tool_result':
      items = [toolResult(row)];
      break;
    default:
      items = [unknown(row.type)];
  }
  return items.map((item, index) => ({
    ...item,
    id: item.id ?? (rowId ? `claude:row:${rowId}:${index}` : undefined),
    timestamp: item.timestamp ?? timestamp,
  }));
}

/** Associate a tool result only with a preceding native call; MCP server names are user-configurable. */
export async function readClaudeTranscript(root: string, files: string[], sessionId: string, request: TranscriptRequest): Promise<TranscriptPage> {
  let selected: { file: string; identity: 'match' | 'legacy' } | undefined;
  const identify = (prefix: Buffer) => transcriptIdentity(prefix, sessionId);
  for (const file of files) {
    const identity = await inspectTranscriptPrefix(root, file, identify);
    if (identity === 'match') {
      selected = { file, identity };
      break;
    }
    if (identity === 'legacy' && !selected) selected = { file, identity };
  }
  if (!selected) return emptyTranscriptPage(files.length ? 'refused' : 'missing');
  const { file, identity } = selected;
  const read = (request: TranscriptRequest) => readTranscriptPage({
    root, file, sessionKey: sessionId, request,
    prepare: (prefix) => identify(prefix) === identity ? undefined : 'refused',
    parse: (value) => parse(sessionId, value),
    unknownText: '[Unreadable Claude record]',
  });
  const page = await read(request);
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
      // A regular tool can also return JSON with these names, but it gives no attribution evidence.
      delete item.source.postMessageId;
    }
  }
  return page;
}
