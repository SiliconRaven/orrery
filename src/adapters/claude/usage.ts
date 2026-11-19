// Claude Code token counts (docs/usage.md), read-only from the session's transcript
// (<claude dir>/projects/<folder>/<session id>.jsonl) and its subagents' transcripts (<folder>/<session id>/subagents/*.jsonl).
// Each assistant line carries message.usage { input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
// output_tokens }; the same message is written once per content block, so lines are counted once per message.id
// (the last line of a message wins). Claude reports input without the cache, as normalized.
// Quota: the CLI's experimental `get_usage` control request, asked of a short-lived `claude -p` (askUsage).
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuotaSnapshot, QuotaWindow, TokenTotals } from '../../core/types.ts';
import { addTokens, count, JsonlFold, noTokens } from '../shared/jsonl.ts';
import { stopHelper, type ClaudeCommand, type StopHelperOptions } from './cli.ts';

/** A Claude usage object as normalized totals; reasoning is the thinking tokens where the transcript reports them. */
export function normalize(u: any): TokenTotals | null {
  if (typeof u !== 'object' || u === null) return null;
  return {
    input: count(u.input_tokens), cachedInput: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens),
    output: count(u.output_tokens), reasoning: count(u.output_tokens_details?.thinking_tokens),
  };
}

/** The get_usage windows orrery shows, in display order. */
const USAGE_WINDOWS = [['five_hour', '5 小时'], ['seven_day', '每周'], ['seven_day_opus', '每周 Opus'], ['seven_day_sonnet', '每周 Sonnet']];

/**
 * The answer to get_usage (response.response), seen at `observedAt`. Null when it has no window at all; throws when
 * the CLI says rate limits are available but gives none, so the web shows why there is no number.
 */
export function fromGetUsage(r: any, observedAt: string): QuotaSnapshot | null {
  if (r?.rate_limits_available !== true) return null;
  if (r.rate_limits == null) throw new Error('claude get_usage gave no rate limits (rate_limits: null)');
  const windows: QuotaWindow[] = [];
  for (const [id, label] of USAGE_WINDOWS) {
    const w = r.rate_limits?.[id];
    if (typeof w?.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const reset = typeof w.resets_at === 'string' ? new Date(w.resets_at) : null;
    windows.push({
      id, label, usedPercent: Math.max(0, Math.min(100, w.utilization)),
      resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null,
    });
  }
  if (!windows.length) return null;
  const plan = r.subscription_type;
  return { ...(typeof plan === 'string' && plan ? { plan: plan.slice(0, 40) } : {}), windows, observedAt, source: 'get_usage' };
}

/** No tools, settings, hooks or MCP servers, and nothing kept: the request sends no prompt, so no model runs. */
const GET_USAGE_ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
  '--settings', JSON.stringify({ disableAllHooks: true }), '--permission-mode', 'dontAsk', '--no-session-persistence',
];
const USAGE_REQUEST_ID = 'orrery-usage';
const USAGE_OUTPUT_MAX = 1024 * 1024;

/**
 * Asks a short-lived CLI for get_usage and returns the answer (response.response). Closes stdin on the answer and
 * waits for the process to leave; at `timeoutMs`, or past USAGE_OUTPUT_MAX, stops it. Errors never quote its output.
 */
export function askUsage(cmd: ClaudeCommand, env: NodeJS.ProcessEnv, timeoutMs: number, stop?: StopHelperOptions): Promise<unknown> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd.command, [...cmd.args, ...GET_USAGE_ARGS], {
      cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      detached: process.platform !== 'win32',   // own process group, so stopHelper can kill what it started
    });
    let answer: { value: unknown } | { error: string } | null = null;
    let finished = false;
    const finish = async (exited: boolean, why: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const notDead = exited || child.pid === undefined ? null : await stopHelper(child, stop);
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      if (notDead) fail(new Error(`${answer && 'error' in answer ? answer.error : why}; ${notDead}`));
      else if (answer && 'value' in answer) ok(answer.value);   // a process that lingers after answering costs no answer when cleanup succeeded
      else fail(new Error(answer?.error ?? why));
    };
    const onLine = (line: string) => {
      if (answer) return;
      let e: any;
      try { e = JSON.parse(line); } catch { return; }
      if (e?.type !== 'control_response' || e.response?.request_id !== USAGE_REQUEST_ID) return;
      answer = e.response.subtype === 'success' ? { value: e.response.response } : { error: 'claude get_usage answered with an error' };
      child.stdin.end();
    };
    const timer = setTimeout(() => void finish(false, `claude get_usage timed out after ${timeoutMs} ms`), timeoutMs);
    let seen = 0;
    let tail = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      seen += d.length;
      if (seen > USAGE_OUTPUT_MAX) {
        void finish(false, 'claude get_usage: too much output');
        return;
      }
      const lines = (tail + d).split('\n');
      tail = lines.pop()!;
      lines.forEach(onLine);
    });
    child.stdout.on('error', () => { /* 'close' reports it */ });
    child.stdin.on('error', () => { /* the process died early (EPIPE); 'close' reports it */ });
    child.on('error', (e) => void finish(false, `cannot start claude: ${e.message}`));
    child.on('close', (code) => void finish(true, `claude exited with code ${code} before answering get_usage`));
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: USAGE_REQUEST_ID, request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
  });
}

interface Folded { byMessage: Map<string, TokenTotals>; loose: TokenTotals }

export function createClaudeUsage() {
  const fold = new JsonlFold<Folded>(() => ({ byMessage: new Map(), loose: noTokens() }), (s, e) => {
    if (e?.type !== 'assistant') return;
    const t = normalize(e.message?.usage);
    if (!t) return;
    const id = e.message?.id;
    if (typeof id === 'string' && id) s.byMessage.set(id, t);
    else addTokens(s.loose, t);
  });

  return {
    /** The session's tokens: its transcript (`file`) plus its subagents' transcripts. Null when `file` is unreadable. */
    async transcriptTokens(file: string): Promise<TokenTotals | null> {
      const files = [file];
      const sub = join(file.slice(0, -'.jsonl'.length), 'subagents');
      try {
        for (const n of await readdir(sub)) if (n.endsWith('.jsonl')) files.push(join(sub, n));
      } catch { /* no subagents */ }
      // One message id counts once even if it shows up in several files.
      const seen = new Map<string, TokenTotals>();
      const total = noTokens();
      let any = false;
      for (const f of files) {
        const s = await fold.read(f);
        if (!s) continue;
        any = true;
        for (const [id, t] of s.byMessage) seen.set(id, t);
        addTokens(total, s.loose);
      }
      if (!any) return null;
      for (const t of seen.values()) addTokens(total, t);
      return total;
    },
  };
}
