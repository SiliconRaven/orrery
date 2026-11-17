// The loop-limit settings a user can change on the web page (the hop limit and the per-chain turn limit), their value
// type and its one validation rule, shared by the Store (reading what was saved) and the Hub (checking what a caller
// asks for). See docs/hop-limit.md.

/** Unlimited is its own kind, never null or Infinity: a `??` default or a text template cannot reinterpret it. */
export type Limit = { kind: 'finite'; value: number } | { kind: 'unlimited' };

export type LimitSource = 'saved' | 'startup' | 'default';

/** The settings, by their API name. The per-hour turn limit and the pause switch are not settings: always on. */
export type LimitSetting = 'maxHops' | 'maxTurnsPerChain';

export const LIMIT_SETTINGS = {
  // key: the `settings` table row; env: the start-up variable; sourceKey: where GET /api/settings and the `settings`
  // event put the source (`source` for the hop limit, which had the API to itself first).
  maxHops: { key: 'max_hops', env: 'ORRERY_MAX_HOPS', sourceKey: 'source' },
  maxTurnsPerChain: { key: 'max_turns_per_chain', env: 'ORRERY_MAX_TURNS_PER_CHAIN', sourceKey: 'maxTurnsPerChainSource' },
} as const satisfies Record<LimitSetting, { key: string; env: string; sourceKey: string }>;

export const isLimitSetting = (v: unknown): v is LimitSetting => v === 'maxHops' || v === 'maxTurnsPerChain';

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** The Limit `v` spells exactly (no other keys), or null. Finite: a non-negative safe integer; 0 is a limit, not unlimited. */
export function parseLimit(v: unknown): Limit | null {
  if (!isPlain(v)) return null;
  const keys = Object.keys(v).sort().join(',');
  if (v.kind === 'unlimited' && keys === 'kind') return { kind: 'unlimited' };
  if (v.kind === 'finite' && keys === 'kind,value' && typeof v.value === 'number' && Number.isSafeInteger(v.value) && v.value >= 0) {
    return { kind: 'finite', value: v.value + 0 };   // + 0 turns -0 into 0
  }
  return null;
}
