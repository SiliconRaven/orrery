// Codex quota and token counts (docs/usage.md), read-only from Codex's own rollout files
// (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl), plus the shape of the app-server's
// account/rateLimits/read answer. Rollout lines used here:
//   { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage }, rate_limits } }
//   { timestamp, type: 'token_usage_record', payload: { turn_id, turn_token_usage, thread_token_usage } }
// Codex counts cached input inside input_tokens; normalize() takes it out.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaSnapshot, QuotaWindow, TokenTotals } from '../../core/types.ts';
import { count, lastMatch } from '../shared/jsonl.ts';

/** A Codex usage object (rollout snake_case) as normalized totals. */
export function normalize(u: any): TokenTotals | null {
  if (typeof u !== 'object' || u === null) return null;
  const input = count(u.input_tokens);
  const cached = Math.min(count(u.cached_input_tokens), input);
  return { input: input - cached, cachedInput: cached, cacheWrite: count(u.cache_write_input_tokens), output: count(u.output_tokens), reasoning: count(u.reasoning_output_tokens) };
}

/** '5 小时', '每周', … for a window length in minutes. */
export function windowLabel(mins: number): string {
  if (mins === 10080) return '每周';
  if (mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins % 60 === 0) return `${mins / 60} 小时`;
  return `${mins} 分钟`;
}

interface RawWindow { usedPercent: unknown; mins: unknown; resetsAt: unknown }

function toWindow(id: string, w: RawWindow | null): QuotaWindow | null {
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  const mins = typeof w.mins === 'number' && w.mins > 0 ? w.mins : null;
  const reset = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000) : null;
  return {
    id, label: mins ? windowLabel(mins) : id, usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
    resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null,
  };
}

function snapshot(windows: (QuotaWindow | null)[], plan: unknown, credits: { has: unknown; unlimited: unknown; balance: unknown } | null, observedAt: string, source: string): QuotaSnapshot {
  let extra: string | undefined;
  if (credits?.unlimited === true) extra = 'credits 不限';
  else if (credits?.has === true && typeof credits.balance === 'string') extra = `credits ${credits.balance.slice(0, 20)}`;
  return {
    ...(typeof plan === 'string' && plan ? { plan: plan.slice(0, 40) } : {}),
    windows: windows.filter((w): w is QuotaWindow => w !== null),
    ...(extra ? { extra } : {}),
    observedAt, source,
  };
}

/** A rollout `rate_limits` object (snake_case), seen at `observedAt`. Null when it has no window at all. */
export function fromRolloutLimits(rl: any, observedAt: string): QuotaSnapshot | null {
  if (typeof rl !== 'object' || rl === null) return null;
  const win = (w: any) => (w ? { usedPercent: w.used_percent, mins: w.window_minutes, resetsAt: w.resets_at } : null);
  const s = snapshot([toWindow('primary', win(rl.primary)), toWindow('secondary', win(rl.secondary))], rl.plan_type,
    rl.credits ? { has: rl.credits.has_credits, unlimited: rl.credits.unlimited, balance: rl.credits.balance } : null, observedAt, 'rollout');
  return s.windows.length ? s : null;
}

/** The app-server's account/rateLimits/read result (camelCase). Null when it has no window at all. */
export function fromAppServer(result: any, observedAt: string): QuotaSnapshot | null {
  const rl = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (typeof rl !== 'object' || rl === null) return null;
  const win = (w: any) => (w ? { usedPercent: w.usedPercent, mins: w.windowDurationMins, resetsAt: w.resetsAt } : null);
  const s = snapshot([toWindow('primary', win(rl.primary)), toWindow('secondary', win(rl.secondary))], rl.planType,
    rl.credits ? { has: rl.credits.hasCredits, unlimited: rl.credits.unlimited, balance: rl.credits.balance } : null, observedAt, 'app-server');
  return s.windows.length ? s : null;
}

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;

/** Every rollout file with its mtime. shortcut: stats every file on each call; index by day folder if users have many thousands. */
async function rollouts(codexHome: string): Promise<{ file: string; mtimeMs: number }[]> {
  const dir = join(codexHome, 'sessions');
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const out: { file: string; mtimeMs: number }[] = [];
  for (const n of names) {
    const base = n.split(/[\\/]/).pop()!;
    if (!ROLLOUT_RE.test(base)) continue;
    try {
      const s = await stat(join(dir, n));
      if (s.isFile()) out.push({ file: join(dir, n), mtimeMs: s.mtimeMs });
    } catch { /* gone */ }
  }
  return out;
}

export function createCodexUsage(codexHome: string) {
  const fileOf = new Map<string, string>();   // thread id -> its rollout file
  let latest: { file: string; mtimeMs: number; snap: QuotaSnapshot | null } | null = null;

  async function rolloutOf(threadId: string): Promise<string | null> {
    const known = fileOf.get(threadId);
    if (known) {
      try { await stat(known); return known; } catch { fileOf.delete(threadId); }
    }
    const found = (await rollouts(codexHome)).find((r) => r.file.endsWith(`-${threadId}.jsonl`));
    if (found) fileOf.set(threadId, found.file);
    return found?.file ?? null;
  }

  return {
    rolloutOf,

    /** The newest rate limits any rollout file recorded (no network). Read again only when the newest file changed. */
    async quotaFromRollouts(): Promise<QuotaSnapshot | null> {
      const files = (await rollouts(codexHome)).sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (!files.length) return null;
      if (latest && latest.file === files[0].file && latest.mtimeMs === files[0].mtimeMs) return latest.snap;
      // The newest file may be a thread without limits in it (e.g. nothing ran yet): look at a few more.
      let snap: QuotaSnapshot | null = null;
      for (const f of files.slice(0, 5)) {
        try {
          snap = await lastMatch(f.file, '"rate_limits"', (e) => (e?.payload?.type === 'token_count' ? fromRolloutLimits(e.payload.rate_limits, String(e.timestamp)) ?? undefined : undefined)) ?? null;
        } catch { /* unreadable */ }
        if (snap) break;
      }
      latest = { file: files[0].file, mtimeMs: files[0].mtimeMs, snap };
      return snap;
    },

    /** Tokens of one turn of the thread: its last token_usage_record. Null when not (yet) in the file. */
    async turnTokens(threadId: string, turnId: string): Promise<TokenTotals | null> {
      const file = await rolloutOf(threadId);
      if (!file) return null;
      return (await lastMatch(file, turnId, (e) => (e?.type === 'token_usage_record' && e.payload?.turn_id === turnId ? normalize(e.payload.turn_token_usage) ?? undefined : undefined))) ?? null;
    },

    /** The whole thread's tokens: the newest running total in its rollout. */
    async threadTokens(threadId: string): Promise<TokenTotals | null> {
      const file = await rolloutOf(threadId);
      if (!file) return null;
      return (await lastMatch(file, '_token_usage', (e) => {
        if (e?.type === 'token_usage_record') return normalize(e.payload?.thread_token_usage) ?? undefined;
        if (e?.payload?.type === 'token_count') return normalize(e.payload.info?.total_token_usage) ?? undefined;
        return undefined;
      })) ?? null;
    },
  };
}
