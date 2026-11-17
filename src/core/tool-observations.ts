import type { ToolCallObservation, ToolProfile, ToolVersionClaim } from './types.ts';

export const TOOL_OBSERVATION_STALE_MS = 15 * 60_000;
const HASH = /^sha256:[0-9a-f]{64}$/;
const PROFILES = new Set<ToolProfile>(['standard', 'antigravity', 'zcode', 'qoder', 'workbuddy']);
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

function claim(value: unknown, source: ToolVersionClaim['source'], scope: ToolVersionClaim['scope'], now: number): ToolVersionClaim | null {
  const data = object(value);
  if (!data || data.source !== source || data.scope !== scope || !PROFILES.has(data.profile as ToolProfile)
    || typeof data.fingerprint !== 'string' || !HASH.test(data.fingerprint)) return null;
  const at = source === 'client' ? now : typeof data.observedAt === 'string' ? Date.parse(data.observedAt) : NaN;
  if (!Number.isFinite(at) || at > now + 60_000) return null;
  let registered: ToolVersionClaim['registered'];
  if (data.registered !== undefined) {
    const counts = object(data.registered);
    if (source !== 'dsh-source' || !counts || !Number.isSafeInteger(counts.succeeded) || !Number.isSafeInteger(counts.total)
      || (counts.succeeded as number) < 0 || (counts.total as number) < (counts.succeeded as number) || (counts.total as number) > 1000) return null;
    registered = { succeeded: counts.succeeded as number, total: counts.total as number };
  }
  return { source, scope, profile: data.profile as ToolProfile, fingerprint: data.fingerprint,
    observedAt: new Date(at).toISOString(), ...(registered ? { registered } : {}) };
}

/** Per-membership observations: every call replaces missing or unrecognized declarations with unknown. */
export class ToolObservations {
  private readonly byMember = new Map<string, ToolCallObservation>();

  record(memberIds: readonly string[], profile: ToolProfile, meta: unknown, bridge: 'claude' | 'deepseek' | null, now = Date.now()): void {
    const data = object(meta);
    const client = claim(data?.['orrery/toolVersion'], 'client', 'session', now);
    const bridgeData = object(data?.['orrery/bridgeToolVersion']);
    const source = bridge === 'claude' && (bridgeData?.source === 'claude-forwarded' || bridgeData?.source === 'claude-fallback')
      ? bridgeData.source : bridge === 'deepseek' && bridgeData?.source === 'dsh-source' ? 'dsh-source' : null;
    const reported = source ? claim(bridgeData, source, source === 'dsh-source' ? 'plugin' : 'session', now) : null;
    const observation: ToolCallObservation = { profile, lastCallAt: new Date(now).toISOString(), staleAfterMs: TOOL_OBSERVATION_STALE_MS,
      client, bridge: reported };
    for (const id of memberIds) this.byMember.set(id, observation);
  }

  get(memberId: string): ToolCallObservation | null { return this.byMember.get(memberId) ?? null; }
  remove(memberId: string): void { this.byMember.delete(memberId); }
}
