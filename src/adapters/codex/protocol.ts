// The few `codex app-server` protocol pieces the native Codex adapter uses (stdio JSON-RPC). Protocol facts come from
// `codex app-server generate-ts` (codex-cli 0.164.0); see docs/adapters/codex.md.
import type { Readable, Writable } from 'node:stream';
import type { ModelInfo, SessionInfo } from '../../core/types.ts';
import type { RpcPeer } from './rpc.ts';

/** v2/Thread.ts (subset). Timestamps are unix seconds. */
export interface CodexThread {
  id: string;
  preview: string;
  model: string | null;
  cwd: string;
  name: string | null;
  updatedAt: number;
}

/** A running app-server, or a test double speaking the same protocol. */
export interface CodexProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  /** Called once when the process exits. */
  onExit(cb: (reason: string) => void): void;
}

/** v2/Model.ts (subset). `model` is what thread/start and turn/start take; `id` names the catalog entry. */
interface CodexModel { model: string; displayName: string; isDefault: boolean; supportedReasoningEfforts: { reasoningEffort: string }[] }
const MODEL_PAGES = 10;

/**
 * The models this app-server offers in its picker (model/list, hidden ones left out), one entry per model name.
 * Entries without a usable model name are skipped (the web would otherwise submit something else as the model);
 * efforts that are not strings are dropped.
 */
export async function fetchModels(rpc: RpcPeer): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MODEL_PAGES; i++) {
    const res: { data: CodexModel[]; nextCursor: string | null } = await rpc.request('model/list', { cursor });
    for (const m of Array.isArray(res?.data) ? res.data : []) {
      if (typeof m?.model !== 'string' || !m.model.trim() || out.some((o) => o.id === m.model)) continue;
      const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [];
      out.push({
        id: m.model,
        ...(typeof m.displayName === 'string' && m.displayName ? { label: m.displayName } : {}),
        efforts: efforts.map((e) => e?.reasoningEffort).filter((e): e is string => typeof e === 'string' && e !== ''),
        ...(m.isDefault === true ? { isDefault: true } : {}),
      });
    }
    if (!res.nextCursor || res.nextCursor === cursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

export function toSessionInfo(t: CodexThread): SessionInfo {
  const title = t.name || t.preview.split('\n')[0].slice(0, 80) || '(untitled)';
  return { id: t.id, title, model: t.model, cwd: t.cwd, updatedAt: t.updatedAt ? new Date(t.updatedAt * 1000).toISOString() : null };
}

export interface ApprovalDecision {
  result: unknown;
  /** What to show the user about what was declined. */
  declined: string;
}

/**
 * Server→client requests during an orrery-run operation (the native init turn needs no tools): every one is declined
 * in the shape its generated *Response type expects. Throws for requests we do not know (sent back as an error).
 */
export function decideServerRequest(method: string, params: Record<string, unknown>): ApprovalDecision {
  const p = params ?? {};
  switch (method) {
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null }, declined: `MCP prompt from ${String(p.serverName)}: ${String(p.message ?? '')}` };
    case 'item/commandExecution/requestApproval':
      return { result: { decision: 'decline' }, declined: `command: ${String(p.command ?? '(unknown)')}${p.reason ? ` (${String(p.reason)})` : ''}` };
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' }, declined: `file change${p.reason ? ` (${String(p.reason)})` : ''}` };
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' }, declined: `extra permissions${p.reason ? ` (${String(p.reason)})` : ''}` };
    case 'item/tool/requestUserInput':
      return { result: { answers: {} }, declined: 'request for user input' };
    case 'item/tool/call':
      return { result: { contentItems: [], success: false }, declined: `dynamic tool ${String(p.tool)}` };
    case 'execCommandApproval':
      return { result: { decision: { denied: { rejection: 'declined by orrery' } } }, declined: `command: ${Array.isArray(p.command) ? p.command.join(' ') : '?'}` };
    case 'applyPatchApproval':
      return { result: { decision: { denied: { rejection: 'declined by orrery' } } }, declined: 'patch' };
    default:
      throw new Error(`orrery does not handle ${method}`);
  }
}
