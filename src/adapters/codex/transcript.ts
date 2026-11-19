import { promisify } from 'node:util';
import { constants, zstdDecompress } from 'node:zlib';
import { emptyTranscriptPage, type TranscriptPage, type TranscriptRequest } from '../../core/types.ts';
import { readTranscriptPage, TRANSCRIPT_ZSTD_OUTPUT_BYTES, type TranscriptDraft } from '../shared/transcript.ts';

const unknownText = '无法识别的 Codex 记录';
const decompress = promisify(zstdDecompress);
const quietRows = new Set(['session_meta', 'response_item', 'turn_context', 'compacted', 'token_usage_record',
  'inter_agent_communication', 'inter_agent_communication_metadata', 'world_state', 'retained_context', 'dynamic_tools_updated']);
const quietEvents = new Set(['task_started', 'task_complete', 'turn_started', 'turn_completed', 'token_count',
  'agent_reasoning_raw_content', 'thread_settings_applied', 'thread_rolled_back', 'item_started', 'mcp_tool_call_begin']);

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function id(value: unknown): string | undefined { return typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value) ? value : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : []; }

function blocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const block of value) {
    const part = obj(block);
    if ((part?.type === 'text' || part?.type === 'Text') && typeof part.text === 'string') out.push(part.text);
  }
  return out;
}

function user(text: string | undefined, clientId: unknown): TranscriptDraft[] | undefined {
  const deliveryId = id(clientId);
  return text === undefined ? undefined : [{ kind: 'user', text, ...(deliveryId && { source: { deliveryId } }) }];
}

function postId(result: Record<string, unknown>, text: string | undefined): string | undefined {
  if (result.isError === true || result.is_error === true) return undefined;
  const structured = obj(result.structuredContent ?? result.structured_content);
  if (structured) return id(structured.messageId);
  try { return text ? id(obj(JSON.parse(text))?.messageId) : undefined; }
  catch { return undefined; }
}

function mcp(item: Record<string, unknown>): TranscriptDraft[] | undefined {
  const toolName = id(item.tool);
  const toolServer = id(item.server);
  const callId = id(item.id);
  if (!toolName || !toolServer || !callId) return undefined;
  const source = { toolName, toolServer, toolCallId: callId };
  const name = `${toolServer}.${toolName}`;
  const args = item.arguments == null ? undefined : JSON.stringify(item.arguments);
  const out: TranscriptDraft[] = [{ kind: 'tool_call', name, callId, source, ...(args === undefined ? {} : { text: args }) }];
  const result = obj(item.result);
  const error = str(obj(item.error)?.message) ?? str(item.error);
  if (result || error !== undefined) {
    const text = blocks(result?.content);
    const successfulPost = result && error === undefined && item.status !== 'failed' && /^(?:mcp__[\w.-]+__)?send_message$/.test(toolName);
    const postMessageId = successfulPost ? postId(result, text[0]) : undefined;
    out.push({ kind: 'tool_result', name, callId, text: error ?? (text.join('\n') || '工具结果'),
      source: { ...source, ...(postMessageId && { postMessageId }) } });
  }
  return out;
}

function command(item: Record<string, unknown>): TranscriptDraft[] {
  const command = str(item.command) ?? strings(item.command).join(' ');
  const callId = id(item.id ?? item.call_id);
  const name = '命令';
  const output = str(item.aggregated_output);
  return [{ kind: 'tool_call', name, callId, text: command },
    ...(output === undefined ? [] : [{ kind: 'tool_result' as const, name, callId, text: output }])];
}

function completed(item: Record<string, unknown> | undefined): TranscriptDraft[] | undefined {
  switch (item?.type) {
    case 'UserMessage':
      return user(Array.isArray(item.content) ? blocks(item.content).join('\n') || '[附件或空消息]' : undefined, item.client_id);
    case 'AgentMessage':
      return [{ kind: 'assistant', text: obj(item.moderation)?.moderated === true ? '[消息已隐藏]' : blocks(item.content).join('\n') }];
    case 'Plan': return [{ kind: 'assistant', text: str(item.text) }];
    case 'Reasoning': return [{ kind: 'thinking', text: strings(item.summary_text).join('\n') || undefined }];
    case 'McpToolCall': return mcp(item);
    case 'CommandExecution': return command(item);
    case 'FileChange': return [{ kind: 'tool_call', name: '文件修改', callId: id(item.id) }];
    case 'ImageView': return [{ kind: 'tool_call', name: '查看图片', callId: id(item.id) }];
    case 'ContextCompaction': return [{ kind: 'system', text: '已压缩上下文' }];
    default: return undefined;
  }
}

function legacyEvent(event: Record<string, unknown>): TranscriptDraft[] | undefined {
  switch (event.type) {
    case 'user_message': return user(str(event.message), event.client_id);
    case 'agent_message': return [{ kind: 'assistant', text: str(event.message) }];
    case 'agent_reasoning': return [{ kind: 'thinking', text: str(event.text) }];
    case 'mcp_tool_call_end': {
      const result = obj(event.result);
      return mcp({ ...obj(event.invocation), id: event.call_id, result: result?.Ok, error: result?.Err });
    }
    case 'exec_command_end': return command(event);
    case 'patch_apply_end': return [{ kind: 'tool_call', name: '文件修改', callId: id(event.call_id) }];
    case 'view_image_tool_call': return [{ kind: 'tool_call', name: '查看图片', callId: id(event.call_id) }];
    case 'context_compacted': return [{ kind: 'system', text: '已压缩上下文' }];
    case 'task_aborted': case 'turn_aborted': return [{ kind: 'system', text: '轮次已中断' }];
    default: return undefined;
  }
}

function rowAt(prefix: Buffer, start: number, end: number): Record<string, unknown> | undefined {
  if (end <= start) return undefined;
  try { return obj(JSON.parse(prefix.toString('utf8', start, end))); }
  catch { return undefined; }
}

export async function codexTranscript(root: string, file: string | null, sessionId: string, request: TranscriptRequest): Promise<TranscriptPage> {
  if (!file) return emptyTranscriptPage('missing');
  const compressed = file.toLowerCase().endsWith('.zst');
  let paginated = false;
  let inherited = false;
  const sessionKey = sessionId.toLowerCase();
  return readTranscriptPage({
    root, file, sessionKey, request, unknownText,
    ...(compressed && {
      decompress: (input: Buffer) => decompress(input, {
        maxOutputLength: TRANSCRIPT_ZSTD_OUTPUT_BYTES, params: { [constants.ZSTD_d_windowLogMax]: 26 },
      }),
    }),
    prepare(prefix) {
      const firstEnd = prefix.indexOf(10);
      const first = rowAt(prefix, 0, firstEnd);
      const meta = obj(first?.payload);
      if (first?.type !== 'session_meta' || !meta) return 'unsupported';
      if (str(meta.id)?.toLowerCase() !== sessionKey) return 'refused';
      if (meta.history_mode != null && meta.history_mode !== 'legacy' && meta.history_mode !== 'paginated') return 'unsupported';
      paginated = meta.history_mode === 'paginated';
      inherited = Boolean(meta.forked_from_id || meta.parent_thread_id || obj(meta.source)?.subagent
        || meta.thread_source === 'subagent' || meta.thread_source === 'guardian_review');
      if (!inherited) {
        // Old forks may only identify the parent in the SessionMeta at the start of the copied prefix.
        const second = rowAt(prefix, firstEnd + 1, prefix.indexOf(10, firstEnd + 1));
        inherited = second?.type === 'session_meta' && str(obj(second.payload)?.id)?.toLowerCase() !== sessionKey;
      }
      // shortcut: old copied events have no owning thread id. Wait for an unambiguous boundary before showing them.
      if (inherited && !paginated) return 'unsupported';
    },
    parse(value) {
      const row = obj(value);
      if (quietRows.has(str(row?.type) ?? '')) return [];
      const event = obj(row?.payload);
      if (row?.type !== 'event_msg' || !event) return undefined;
      const owner = str(event.thread_id)?.toLowerCase();
      if (owner ? owner !== sessionKey : inherited) return [];
      const type = str(event.type) ?? '';
      if (quietEvents.has(type)) return [];
      let items: TranscriptDraft[] | undefined;
      if (type === 'item_completed') {
        const item = obj(event.item);
        items = paginated || item?.type === 'Plan' ? completed(item) : [];
      } else if (paginated && type !== 'task_aborted' && type !== 'turn_aborted') {
        // Ignore legacy display events when completed items own the display history.
        items = ['user_message', 'agent_message', 'agent_reasoning', 'mcp_tool_call_end', 'exec_command_end',
          'patch_apply_end', 'view_image_tool_call', 'context_compacted'].includes(type) ? [] : undefined;
      } else items = legacyEvent(event);
      const stamp = str(row.timestamp);
      const timestamp = stamp && !Number.isNaN(Date.parse(stamp)) ? stamp : undefined;
      return items?.map((item) => ({ ...item, timestamp }));
    },
  });
}
