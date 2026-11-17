// Kimi Code quota and token counts (docs/usage.md).
// - Quota: the running app's GET /api/v1/oauth/usage answers
//   { kind: 'ok', quota: { usages: { limit5h?, limit7d?, monthTotal?, monthCode? }: { usedRatio, resetAt? }, extraUsage } }
//   or { kind: 'error', message }. Seen with the embedded service 2.4.0.
// - A turn's tokens: the transcript stream's `step.upsert` ops carry step.usage
//   { inputOther, output, inputCacheRead, inputCacheCreation } (inputOther excludes the cache).
// - A session's tokens: <KIMI_CODE_HOME>/sessions/<wd>/<session>/agents/<agent>/wire.jsonl lines
//   { type: 'usage.record', usage: {...same fields} }, one per model call, main agent and subagents alike. Read-only.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QuotaSnapshot, QuotaWindow, TokenTotals } from '../../core/types.ts';
import { addTokens, count, JsonlFold, noTokens } from '../shared/jsonl.ts';

const WINDOWS: [string, string][] = [['limit5h', '5 小时'], ['limit7d', '每周'], ['monthTotal', '本月（全部）'], ['monthCode', '本月（Code）']];

/** The `data` of an oauth/usage answer as a snapshot; throws with Kimi's message on `kind: 'error'`. */
export function fromOauthUsage(data: any, observedAt: string): QuotaSnapshot | null {
  if (data?.kind === 'error') throw new Error(`Kimi Code could not read the usage: ${String(data.message ?? '').slice(0, 200)}`);
  const usages = data?.kind === 'ok' ? data.quota?.usages : null;
  if (typeof usages !== 'object' || usages === null) return null;
  const windows: QuotaWindow[] = [];
  for (const [id, label] of WINDOWS) {
    const w = usages[id];
    if (typeof w?.usedRatio !== 'number' || !Number.isFinite(w.usedRatio)) continue;
    const reset = typeof w.resetAt === 'string' ? new Date(w.resetAt) : null;
    windows.push({
      id, label, usedPercent: Math.max(0, Math.min(100, w.usedRatio * 100)),
      resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null,
    });
  }
  return windows.length ? { windows, observedAt, source: 'oauth/usage' } : null;
}

/** A Kimi usage object as normalized totals (Kimi reports no reasoning count). */
export function normalize(u: any): TokenTotals | null {
  if (typeof u !== 'object' || u === null) return null;
  return { input: count(u.inputOther), cachedInput: count(u.inputCacheRead), cacheWrite: count(u.inputCacheCreation), output: count(u.output), reasoning: 0 };
}

export function createKimiUsage(kimiHome: string) {
  const sessionsDir = join(kimiHome, 'sessions');
  const fold = new JsonlFold<TokenTotals>(noTokens, (sum, e) => {
    if (e?.type === 'usage.record') {
      const t = normalize(e.usage);
      if (t) addTokens(sum, t);
    }
  });

  async function list(dir: string): Promise<string[]> {
    try { return await readdir(dir); } catch { return []; }
  }

  return {
    /**
     * The session's tokens over all its agents' wire.jsonl files. null when the session folder is not found or none
     * of its wire.jsonl files could be read (an agents folder alone does not prove nothing was spent); when only
     * some could be read, the sum of those.
     */
    async sessionTokens(sessionId: string): Promise<TokenTotals | null> {
      for (const wd of await list(sessionsDir)) {
        const dir = join(sessionsDir, wd, sessionId, 'agents');
        const agents = await list(dir);
        if (!agents.length) continue;
        const total = noTokens();
        let read = false;
        for (const a of agents) {
          const t = await fold.read(join(dir, a, 'wire.jsonl'));
          if (t) { addTokens(total, t); read = true; }
        }
        return read ? total : null;
      }
      return null;
    },
  };
}
