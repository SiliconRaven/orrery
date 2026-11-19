// DeepSeek Harness (DSH) session log, read-only, for the member's bound session only:
// <DSH_HOME or ~/.dsh>/sessions/<project folder>/<session id>/session.v<N>.jsonl.zstd. Every append is one zstd frame
// of JSONL records { type, seq, time, data, surfaceOp? }; the first record is the header { type: 'session', id, version }.
// The newest generation (highest N) is read. Record shapes checked on DSH 0.2.1-rc.2 session files (structure only).
// docs/adapters/deepseek.md「读原生对话」.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyTranscriptPage, type TranscriptPage, type TranscriptRequest, type TranscriptSource } from '../../core/types.ts';
import type { TranscriptDraft } from '../shared/transcript.ts';
import { readFramedTranscriptPage } from '../shared/zstd-frames.ts';

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const GENERATION = /^session\.v(\d{1,6})\.jsonl\.zstd$/;
const unknownText = '无法识别的 DeepSeek Harness 记录';
/** DSH writes assistant records with their stream deltas; the largest seen were under 1 MiB. */
const LINE_BYTES = 1024 * 1024;

// Bookkeeping and model-context records with nothing to show (the system prompt, request headers, steps, jobs, titles…).
const quietTypes = new Set(['step/start', 'step/end', 'turn/start', 'job/registered', 'job/settled', 'agent/inbox/spliced',
  'session/title', 'session/title-llm-request', 'approval/policy', 'request/header', 'request/context', 'sandbox/mode',
  'permission/preset', 'system/message', 'developer/message', 'compaction/start', 'compaction/prune', 'compaction/summary',
  'workspace/changes', 'subagent/descriptor', 'subagent/catalog', 'session/end-seed', 'todo/write', 'team/task', 'team/member',
  'assistant/attempt', 'model/selection', 'llm/retry', 'llm/retry-started', 'working-directory/change',
  'deliverables/presented', 'goal/change', 'web/deepseek-search-llm-request', 'session-log-deepseek/delivery-accepted']);
// user/message sources that are context DSH or a plugin injects for the model, not something anybody said.
const quietSources = new Set(['time-context', 'runtime-context', 'agent-instructions', 'ptc-mode', 'skill-catalog',
  'dsh-mnemon', 'tool-jobs', 'dsh-orrery', 'working-directory', 'model-selection', 'compact-checkpoint']);
const systemSources: Record<string, string> = { 'agent-message': '其他代理的消息', 'subagent-settled': '子代理结果',
  'user-approval': '审批', 'skill-invocation': '技能', goal: '目标' };

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function id(value: unknown): string | undefined { return typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value) ? value : undefined; }

function text(content: unknown): string {
  const parts = Array.isArray(content) ? content.map((part) => {
    const block = obj(part);
    return block?.type === 'text' ? str(block.text) : block?.type === 'image' ? '[图片]' : undefined;
  }).filter((part) => part !== undefined) : [];
  return parts.join('\n');
}

/** `mcp__<server>__<tool>` as DSH names MCP tools (and the orrery plugin names its tools); the server is not fixed. */
function tool(name: string | undefined, callId: string | undefined): TranscriptSource {
  const split = name?.startsWith('mcp__') ? name.lastIndexOf('__') : -1;
  return { ...(callId && { toolCallId: callId }),
    ...(split > 'mcp__'.length ? { toolServer: name!.slice(5, split), toolName: name!.slice(split + 2) } : name ? { toolName: name } : {}) };
}

function postId(body: string, failed: boolean): string | undefined {
  if (failed) return undefined;
  try { return id(obj(JSON.parse(body))?.messageId); } catch { return undefined; }
}

function result(name: string | undefined, callId: string | undefined, content: unknown, failed: boolean, error: unknown): TranscriptDraft[] {
  const body = text(content);
  const source = tool(name, callId);
  const post = source.toolName === 'send_message' || !name ? postId(body, failed) : undefined;
  return [{ kind: 'tool_result', ...(name && { name }), callId, text: body || str(obj(error)?.code) || '工具结果',
    source: { ...source, ...(post && { postMessageId: post }) } }];
}

function userMessage(data: Record<string, unknown>): TranscriptDraft[] | undefined {
  const source = obj(data.source);
  const kind = str(source?.kind) ?? '';
  const body = text(data.content) || '[空消息]';
  if (kind === 'user') {
    // The orrery plugin queues each delivery with requestId = the Hub's delivery id, which DSH records as source.rpcId.
    // That id is the only delivery evidence: the text is never offered, so typed envelope or direct text stays user.
    const rpcId = id(source?.rpcId);
    return [{ kind: 'user', text: body, ...(rpcId && { source: { candidate: { deliveryId: rpcId } } }) }];
  }
  if (systemSources[kind]) return [{ kind: 'system', name: systemSources[kind], text: body }];
  return quietSources.has(kind) ? [] : undefined;
}

function parse(value: unknown): TranscriptDraft[] | undefined {
  const row = obj(value);
  const type = str(row?.type) ?? '';
  const data = obj(row?.data) ?? {};
  // A replacement edits what the model sees (pruned tool output, a compaction checkpoint); the original stays shown.
  if (type === 'session' || quietTypes.has(type) || obj(row?.surfaceOp)?.op === 'replace') return [];
  let items: TranscriptDraft[] | undefined;
  switch (type) {
    case 'user/message': items = userMessage(data); break;
    case 'assistant/message': {
      const blocks = Array.isArray(obj(data.message)?.content) ? obj(data.message)!.content as unknown[] : [];
      const of = (kind: string) => blocks.map(obj).filter((b) => b?.type === kind).map((b) => str(b!.text) ?? '').join('\n');
      const answer = of('text');
      // Tool-call blocks are shown from their own tool/call records. Reasoning text is not shown, only a placeholder:
      // nothing shows that DSH presents it as a summary (docs/security.md).
      items = [...(of('reasoning') ? [{ kind: 'thinking' as const }] : []), ...(answer ? [{ kind: 'assistant' as const, text: answer }] : [])];
      break;
    }
    case 'tool/call': {
      const name = str(data.name);
      const callId = id(data.callId);
      items = [{ kind: 'tool_call', name: name ?? '工具', callId, text: str(data.arguments), source: tool(name, callId) }];
      break;
    }
    case 'tool/result': {
      const message = obj(data.message) ?? {};
      items = result(undefined, id(message.toolCallId), message.content, message.isError === true || !!data.error, data.error);
      break;
    }
    case 'tool/ptc-dispatch-start': {
      const name = str(data.name);
      const callId = id(data.subCallId);
      items = [{ kind: 'tool_call', name: name ?? '工具', callId,
        ...(data.arguments === undefined ? {} : { text: JSON.stringify(data.arguments) }), source: tool(name, callId) }];
      break;
    }
    case 'tool/ptc-dispatch':
      items = result(str(data.name), id(data.subCallId), data.content, data.isError === true || !!data.error, data.error);
      break;
    case 'turn/end': {
      const reason = str(obj(data.reason)?.kind);
      items = reason === 'completed' ? [] : reason === 'aborted' || reason === 'interrupted'
        ? [{ kind: 'system', text: '轮次已中断' }] : reason === 'error' ? [{ kind: 'system', text: '轮次出错' }] : undefined;
      break;
    }
    case 'compaction/end': items = [{ kind: 'system', text: '已压缩上下文' }]; break;
    case 'command/run':
      items = [{ kind: 'tool_call', name: '命令', callId: id(data.commandId), text: `/${str(data.name) ?? ''} ${str(data.args) ?? ''}`.trim() }];
      break;
    case 'command/done': items = [{ kind: 'tool_result', name: '命令', callId: id(data.commandId), text: str(data.text) }]; break;
    case 'approval/asked': items = [{ kind: 'system', name: '审批', text: `等待审批：${str(data.toolName) ?? ''}` }]; break;
    case 'approval/decided': items = [{ kind: 'system', name: '审批', text: `审批结果：${str(data.outcome) ?? ''}` }]; break;
  }
  const time = row?.time;
  const timestamp = typeof time === 'number' && Number.isFinite(new Date(time).getTime()) ? new Date(time).toISOString() : undefined;
  return items?.map((item) => ({ ...item, ...(timestamp && { timestamp }) }));
}

/** The newest session log of this session id under any project folder, or null. Two folders with the id: refused. */
export async function sessionLog(sessionsRoot: string, sessionId: string): Promise<string | null | 'ambiguous'> {
  let projects: string[];
  try { projects = await readdir(sessionsRoot); } catch { return null; }
  const found: string[] = [];
  for (const project of projects) {
    let names: string[];
    try { names = await readdir(join(sessionsRoot, project, sessionId)); } catch { continue; }
    const newest = names.map((name) => GENERATION.exec(name)).filter((m) => m !== null)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    if (newest) found.push(join(sessionsRoot, project, sessionId, newest[0]));
  }
  return found.length > 1 ? 'ambiguous' : found[0] ?? null;
}

export async function deepseekTranscript(sessionsRoot: string, sessionId: string, request: TranscriptRequest): Promise<TranscriptPage> {
  if (!SAFE_ID.test(sessionId)) return emptyTranscriptPage('refused');
  const file = await sessionLog(sessionsRoot, sessionId);
  if (file === 'ambiguous') return emptyTranscriptPage('refused');
  if (!file) return emptyTranscriptPage('missing');
  return readFramedTranscriptPage({
    root: sessionsRoot, file, sessionKey: sessionId, request, unknownText, lineBytes: LINE_BYTES, parse,
    prepare(prefix) {
      const newline = prefix.indexOf(10);
      let header: Record<string, unknown> | undefined;
      try { header = obj(JSON.parse(prefix.toString('utf8', 0, newline < 0 ? prefix.length : newline))); } catch { /* below */ }
      if (header?.type !== 'session') return 'unsupported';
      if (header.id !== sessionId) return 'refused';
    },
  });
}
