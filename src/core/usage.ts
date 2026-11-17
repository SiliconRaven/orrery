// Subscription quota and token counts per member and cluster (docs/usage.md). The Hub owns one UsageTracker:
// it polls the native adapters' quota (cheap sources only) while they have members, keeps the last snapshot per
// harness (also in the database, so a restart still shows it), records the tokens of turns orrery started, and builds
// the report GET /api/usage serves. Conversation totals are read on demand from the harnesses' own files (adapters).
import type { Store } from './store.ts';
import type { Member, NativeAdapter, QuotaSnapshot, QuotaWindow, SessionInfo, TokenTotals } from './types.ts';

export interface QuotaView {
  harness: string;
  supported: boolean;               // the adapter has a quota source at all
  snapshot: QuotaSnapshot | null;   // the last one seen (may be old: see observedAt)
  error?: string;                   // why the last attempt to read it failed
}

export interface MemberUsage {
  memberId: string;
  harness: string;
  viaOrrery: { totals: TokenTotals; turns: number } | null;   // turns orrery started whose tokens were reported
  conversationSupported: boolean;
  conversation: TokenTotals | null;   // the whole conversation, from the harness's own files
  latestTurnTokens: number | null;
  alert?: { turnTokens: number | null; conversationTokens: number | null } | null;
  /** The native conversation's title and model as last read (observedAt), or null when not known this Hub run. */
  session?: SessionSeen | null;   // always set by report(); optional for rows built elsewhere
}

/**
 * A native conversation's title and model as the adapter last gave them (docs/cluster-members.md). `sessionId` is the
 * conversation they were read for: the page shows them only while the member is still bound to it.
 */
export interface SessionSeen { sessionId: string; title: string | null; model: string | null; observedAt: string }

/** A successful reading (adapters with `localSessions`) is reused for up to this long; a failed read is retried on the next report. */
export const SESSION_INFO_TTL_MS = 5 * 60_000;

/** A zero threshold disables that signal. A missing measurement is never treated as zero evidence. */
export function usageAlert(row: MemberUsage, limits: { turnTokens: number; conversationTokens: number }) {
  const turn = row.latestTurnTokens;
  const t = row.conversation;
  const conversation = t ? t.input + t.cachedInput + t.cacheWrite + t.output : null;
  return (limits.turnTokens > 0 && turn !== null && turn > limits.turnTokens)
    || (limits.conversationTokens > 0 && conversation !== null && conversation > limits.conversationTokens)
    ? { turnTokens: turn, conversationTokens: conversation } : null;
}

export interface UsageReport {
  clusterId: string | null;
  quotas: QuotaView[];
  members: MemberUsage[];
  cluster: { viaOrrery: TokenTotals; conversation: TokenTotals };
}

export const noTokens = (): TokenTotals => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 });

function add(a: TokenTotals, b: TokenTotals): TokenTotals {
  a.input += b.input; a.cachedInput += b.cachedInput; a.cacheWrite += b.cacheWrite; a.output += b.output; a.reasoning += b.reasoning;
  return a;
}

const FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const;

/** Token totals from outside (a bridge, an adapter): an object whose counts are non-negative safe integers (missing: 0). */
export function parseTotals(v: unknown): TokenTotals | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out = noTokens();
  for (const k of FIELDS) {
    const n = (v as Record<string, unknown>)[k];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
    out[k] = n;
  }
  return out;
}

export type QuotaLevel = 'none' | 'warning' | 'exhausted';
export const QUOTA_WARNING_PERCENT = 90;
export const QUOTA_EXHAUSTED_PERCENT = 100;

/**
 * How close a harness account is to its limit (docs/usage.md「额度提醒」): each window is 'exhausted' at 100% used,
 * 'warning' at 90%, and nothing once its resetsAt has passed, however old the snapshot is. The harness takes its
 * most severe window; between equally severe ones, the one that resets last (it is what keeps the account limited).
 * No snapshot (unsupported, never read) is 'none'. A failed read never gets here: the tracker keeps the last snapshot.
 */
export function quotaLevel(snapshot: QuotaSnapshot | null, now: number): { level: QuotaLevel; window: QuotaWindow | null } {
  const rank = { none: 0, warning: 1, exhausted: 2 } as const;
  let best: { level: QuotaLevel; window: QuotaWindow | null } = { level: 'none', window: null };
  for (const w of snapshot?.windows ?? []) {
    if (w.resetsAt && Date.parse(w.resetsAt) <= now) continue;
    const level: QuotaLevel = w.usedPercent >= QUOTA_EXHAUSTED_PERCENT ? 'exhausted' : w.usedPercent >= QUOTA_WARNING_PERCENT ? 'warning' : 'none';
    if (level === 'none') continue;
    const later = (a: string | null, b: string | null) => (a === null ? b !== null : b !== null && Date.parse(a) > Date.parse(b));
    if (rank[level] > rank[best.level] || (level === best.level && later(w.resetsAt, best.window!.resetsAt))) best = { level, window: w };
  }
  return best;
}

/** What a snapshot says, without when it was seen: a change here is news (an event); a newer observedAt alone is not. */
const numbers = (s: QuotaSnapshot) => JSON.stringify([s.plan ?? null, s.extra ?? null, s.windows]);

export interface UsageTrackerOptions {
  store: Store;
  adapters: Record<string, NativeAdapter>;
  /** Harnesses with at least one active native member: only their quota is polled. */
  harnessesInUse: () => string[];
  /** Emits a 'usage' event (clusterId and memberId may be null). */
  emit: (clusterId: string | null, memberId: string | null, payload: unknown) => void;
  pollMs: number;
}

export class UsageTracker {
  private readonly quotas: Map<string, QuotaSnapshot>;
  /** Native conversations' title/model by [harness, sessionId], in memory only: a restart starts empty. */
  private readonly sessions = new Map<string, SessionSeen>();
  private readonly sessionReads = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();   // polls run one at a time
  private closed = false;
  private readonly o: UsageTrackerOptions;

  constructor(o: UsageTrackerOptions) {
    this.o = o;
    this.quotas = o.store.loadQuotas();
  }

  private started = false;

  start(): void {
    if (this.o.pollMs <= 0) return;
    this.started = true;
    void this.poll(false);
    this.timer = setInterval(() => void this.poll(false), this.o.pollMs);
    this.timer.unref();
  }

  /** Native members were added: their harness's quota shows up now rather than at the next poll. */
  membersAdded(): void {
    if (this.started && !this.closed) void this.poll(false);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.chain.catch(() => {});
  }

  private own(harness: string): NativeAdapter | undefined {
    return Object.hasOwn(this.o.adapters, harness) ? this.o.adapters[harness] : undefined;
  }

  /**
   * Asks every in-use harness with a quota source; refresh: the user asked (adapters may then ask their server).
   * `only`: just these harnesses, in use or not (the Hub's Claude poll). Returns per harness whether it worked. Never throws.
   */
  poll(refresh: boolean, only?: string[]): Promise<Record<string, { ok: boolean; error?: string }>> {
    const run = async () => {
      const out: Record<string, { ok: boolean; error?: string }> = {};
      for (const harness of only ?? this.o.harnessesInUse()) {
        const adapter = this.own(harness);
        if (!adapter?.quota || this.closed) continue;
        try {
          const snap = await adapter.quota({ refresh });
          if (this.closed) break;
          this.errors.delete(harness);
          if (snap) this.keep(harness, snap);
          out[harness] = { ok: true };
        } catch (e) {
          const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          this.errors.set(harness, error);
          out[harness] = { ok: false, error };
        }
      }
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  /** The last snapshot kept for the harness (a failed read leaves the previous one), or null. */
  snapshot(harness: string): QuotaSnapshot | null {
    return this.quotas.get(harness) ?? null;
  }

  /** Harnesses with a kept snapshot. */
  harnessesWithSnapshot(): string[] {
    return [...this.quotas.keys()];
  }

  private keep(harness: string, snap: QuotaSnapshot): void {
    const before = this.quotas.get(harness);
    if (before && before.observedAt === snap.observedAt && numbers(before) === numbers(snap)) return;
    // An older reading (e.g. a rollout line older than the last app-server answer) never replaces a newer one.
    if (before && Date.parse(snap.observedAt) < Date.parse(before.observedAt)) return;
    this.quotas.set(harness, snap);
    this.o.store.saveQuota(harness, snap);
    if (!before || numbers(before) !== numbers(snap)) this.o.emit(null, null, { quota: { harness, snapshot: snap } });
  }

  /** The tokens of the turn run `batchId` of `member` started; a batch recorded again replaces its earlier count. */
  recordTurn(member: { id: string; clusterId: string }, batchId: string, totals: unknown): void {
    const t = parseTotals(totals);
    // A late report for a member deleted for good (a purged cluster) has nowhere to go.
    if (!t || this.closed || !this.o.store.getMember(member.id, { includeRemoved: true })) return;
    this.o.store.recordTurnUsage(batchId, member.id, t);
    this.o.emit(member.clusterId, member.id, { turn: { memberId: member.id, batchId, totals: t } });
  }

  /**
   * A native conversation's info the Hub got anyway (adding or moving a member, a session listing): kept for the member
   * list. Every adapter feeds this; only those with `localSessions` are also asked again by the report.
   */
  sessionSeen(harness: string, info: Pick<SessionInfo, 'id' | 'title' | 'model'>, at = new Date().toISOString()): void {
    this.sessions.set(JSON.stringify([harness, info.id]), { sessionId: info.id, title: info.title || null, model: info.model ?? null, observedAt: at });
  }

  /** The kept info of a member's conversation, re-read first when its adapter reads only local files and it is old. */
  private async sessionOf(m: Member, adapter: NativeAdapter | undefined): Promise<SessionSeen | null> {
    const key = JSON.stringify([m.harness, m.workerSessionId]);
    const kept = this.sessions.get(key);
    const fresh = kept && Date.now() - Date.parse(kept.observedAt) < SESSION_INFO_TTL_MS;
    if (adapter?.localSessions && !fresh && !this.closed) {
      let read = this.sessionReads.get(key);
      if (!read) {
        // A failed read keeps the last info with its own (old) observedAt, so the next report tries again; shown as "read at", never as now.
        read = Promise.resolve().then(() => adapter.attachSession(m.workerSessionId))
          .then((info) => this.sessionSeen(m.harness, { ...info, id: m.workerSessionId }), () => {})
          .finally(() => this.sessionReads.delete(key));
        this.sessionReads.set(key, read);
      }
      await read;
    }
    return this.sessions.get(key) ?? null;
  }

  /** The report for these members (one cluster's, or every active one). */
  async report(clusterId: string | null, members: Member[]): Promise<UsageReport> {
    const recorded = this.o.store.turnUsage(members.map((m) => m.id));
    const latest = this.o.store.latestTurnTokens(members.map((m) => m.id));
    const conversations = new Map<string, Promise<TokenTotals | null>>();
    const rows = await Promise.all(members.map(async (m): Promise<MemberUsage> => {
      const adapter = this.own(m.harness);
      let conversation: TokenTotals | null = null;
      if (adapter?.conversationTokens) {
        const key = JSON.stringify([m.harness, m.workerSessionId]);
        let read = conversations.get(key);
        if (!read) {
          read = Promise.resolve().then(() => adapter.conversationTokens!(m.workerSessionId)).then(parseTotals).catch(() => null);
          conversations.set(key, read);
        }
        conversation = await read;
      }
      const session = await this.sessionOf(m, adapter);
      return { memberId: m.id, harness: m.harness, viaOrrery: recorded.get(m.id) ?? null, conversationSupported: Boolean(adapter?.conversationTokens), conversation, latestTurnTokens: latest.get(m.id) ?? null, session };
    }));
    const harnesses = [...new Set(members.map((m) => m.harness))];
    const quotas = harnesses.map((harness): QuotaView => {
      const error = this.errors.get(harness);
      return { harness, supported: Boolean(this.own(harness)?.quota), snapshot: this.quotas.get(harness) ?? null, ...(error ? { error } : {}) };
    });
    const cluster = { viaOrrery: noTokens(), conversation: noTokens() };
    const counted = new Set<string>();
    for (const [i, r] of rows.entries()) {
      if (r.viaOrrery) add(cluster.viaOrrery, r.viaOrrery.totals);
      const key = JSON.stringify([members[i].harness, members[i].workerSessionId]);
      if (r.conversation && !counted.has(key)) {
        add(cluster.conversation, r.conversation);
        counted.add(key);
      }
    }
    return { clusterId, quotas, members: rows, cluster };
  }
}
