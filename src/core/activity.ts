import type { Store } from './store.ts';
import type { ActivityObservation, ActivityObserver, ActivitySnapshot } from './types.ts';

export const ACTIVITY_STALE_AFTER_MS = 45_000;

/** No source has established an observation in this Hub process. */
export function unknownActivity(): ActivitySnapshot {
  return { state: 'unknown', source: null, lastSeenAt: null, lastActivityAt: null, event: null, staleAfterMs: ACTIVITY_STALE_AFTER_MS };
}

/** Drop all unapproved metadata before anything is stored or returned. */
export function normalizeActivity(value: unknown): ActivityObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'tool' && v.kind !== 'turn') return null;
  if (v.phase !== 'started' && v.phase !== 'finished' && v.phase !== 'failed' && !(v.kind === 'tool' && v.phase === 'requested')) return null;
  if (v.kind === 'turn') return { kind: 'turn', phase: v.phase };
  const toolName = typeof v.toolName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v.toolName) ? v.toolName : null;
  return { kind: 'tool', phase: v.phase, toolName };
}

interface ActiveSource { source: string; seenAt: number | null }

/** Owns live source handles; persisted snapshots remain history after this process exits. */
export class ActivityTracker {
  private readonly active = new Map<string, ActiveSource>();
  private readonly disconnected = new Set<string>();
  private readonly store: Store;

  constructor(store: Store) { this.store = store; }

  open(memberId: string, source: string): ActivityObserver {
    if (!this.store.getMember(memberId)) throw new Error('unknown active member');
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(source)) throw new Error('invalid activity source');
    const current: ActiveSource = { source, seenAt: null };
    this.active.set(memberId, current);
    this.disconnected.delete(memberId);
    const save = (value?: unknown): boolean => {
      if (this.active.get(memberId) !== current) return false;
      try {
        const event = value === undefined ? undefined : normalizeActivity(value);
        if (event === null) return false;
        if (!this.store.hasActivityParticipation(memberId)) return false;
        const now = Date.now();
        this.store.saveActivity(memberId, source, new Date(now).toISOString(), event);
        current.seenAt = now;
        return true;
      } catch {
        return false;
      }
    };
    return {
      record: (event) => event !== undefined && save(event),
      heartbeat: () => save(),
      close: () => {
        if (this.active.get(memberId) !== current) return;
        this.active.delete(memberId);
        this.disconnected.add(memberId);
      },
    };
  }

  snapshot(memberId: string): ActivitySnapshot {
    try {
      if (!this.store.hasActivityParticipation(memberId)) return unknownActivity();
      const row = this.store.activitySnapshot(memberId);
      const current = this.active.get(memberId);
      const state = current?.seenAt != null ? (Date.now() - current.seenAt > ACTIVITY_STALE_AFTER_MS ? 'stale' : 'observing')
        : this.disconnected.has(memberId) ? 'disconnected' : 'unknown';
      return { state, source: row?.source ?? null, lastSeenAt: row?.lastSeenAt ?? null,
        lastActivityAt: row?.lastActivityAt ?? null, event: normalizeActivity(row?.event), staleAfterMs: ACTIVITY_STALE_AFTER_MS };
    } catch {
      return unknownActivity();
    }
  }

  /** The member is gone for good (a purged cluster): a source still open for it saves nothing more. */
  forget(memberId: string): void {
    this.active.delete(memberId);
    this.disconnected.delete(memberId);
  }

  close(): void {
    this.active.clear();
    this.disconnected.clear();
  }
}
