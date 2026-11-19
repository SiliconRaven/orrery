// Native Claude: the member is a Claude Code conversation the user sees (Claude Desktop or a terminal). The Hub
// delivers into it through the orrery bridge (src/bridge/claude-bridge.ts) that the session runs as an MCP child:
// online = that bridge's stream is connected. Sessions are listed from Claude's local store, read-only.
// No createSession: the user creates conversations in the app. docs/adapters/claude-adapter.md, "原生模式".
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeAdapter, QuotaSnapshot } from '../../core/types.ts';
import { cliEnv, resolveClaudeCommand, type ClaudeCommand } from './cli.ts';
import { createSessionStore } from './store.ts';
import { readClaudeTranscript } from './transcript.ts';
import { askUsage, createClaudeUsage, fromGetUsage } from './usage.ts';

export interface ClaudeNativeOptions {
  claudeDir?: string;
  /** How to start the CLI for get_usage; default found on PATH at the first refresh. */
  command?: ClaudeCommand;
  quotaRefreshMinMs?: number;
  quotaTimeoutMs?: number;
}

export function createClaudeNativeAdapter(opts: ClaudeNativeOptions = {}): NativeAdapter {
  const claudeDir = resolve(opts.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')));
  const store = createSessionStore(claudeDir);
  const usage = createClaudeUsage();
  const quotaRefreshMinMs = opts.quotaRefreshMinMs ?? 10_000;
  const quotaTimeoutMs = opts.quotaTimeoutMs ?? 20_000;
  let command = opts.command ?? null;
  let quotaAt = -Infinity;   // when get_usage was last asked
  let quotaLast: QuotaSnapshot | null = null;
  return {
    harness: 'claude',
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: () => store.listProjects(),
    listSessions: (projectPath) => store.listSessions(projectPath),
    async attachSession(sessionId) {
      const info = await store.get(sessionId);
      if (!info) throw new Error(`claude session ${sessionId} not found under ${join(claudeDir, 'projects')}`);
      return info;
    },
    isOnline: (sessionId, bridge) => bridge.isOnline('claude', sessionId),
    /** A get_usage process only when the user asks, at most every quotaRefreshMinMs; otherwise the last answer. */
    async quota({ refresh }) {
      if (!refresh || Date.now() - quotaAt < quotaRefreshMinMs) return quotaLast;
      quotaAt = Date.now();   // before the process starts: a refresh meanwhile must not start another
      command ??= resolveClaudeCommand();
      // Without the traffic switch: with it the CLI may not fetch the rate limits, and get_usage gives rate_limits: null.
      const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _, ...env } = cliEnv(process.env, claudeDir);
      const answer = await askUsage(command, env, quotaTimeoutMs);
      quotaLast = fromGetUsage(answer, new Date().toISOString());
      return quotaLast;
    },
    async conversationTokens(sessionId) {
      const file = await store.file(sessionId);
      return file ? usage.transcriptTokens(file) : null;
    },
    async transcript(sessionId, request) {
      const files = await store.transcriptFiles(sessionId);
      return readClaudeTranscript(join(claudeDir, 'projects'), files, sessionId, request);
    },
    async deliver(sessionId, text, ctx) {
      if (!ctx.bridge.isOnline('claude', sessionId)) return 'offline';
      let ack;
      try {
        ack = await ctx.bridge.push('claude', sessionId, ctx.deliveryId, text);
      } catch (e) {
        return { outcome: 'unknown', error: `Claude bridge delivery could not be confirmed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!ack.ok) return { outcome: 'unknown', error: ack.error };
      return 'accepted';
    },
  };
}
