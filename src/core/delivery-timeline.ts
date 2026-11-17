// One delivery's history for the user: rebuilt from its row and the times its 'delivery' events recorded. Read-only.
// A stage the records cannot show is 'unknown', never inferred from a neighbouring stage (docs/native-mode.md).
import type { Delivery, DeliveryResult, DeliveryState, Message } from './types.ts';

export const CHAIN_LIMIT_ERROR = '链轮次超限';

/** reached: there is evidence it happened. pending: may still happen. not_reached: there is evidence it did not. unknown: no evidence. */
export type StageStatus = 'reached' | 'pending' | 'not_reached' | 'unknown';
export type StageKey = 'queued' | 'started' | 'accepted' | 'acknowledged' | 'ended';
export interface TimelineStage { key: StageKey; status: StageStatus; at: string | null; reason?: string }

/** Why a queued delivery has not started; only the Hub's live state can tell. */
export type QueuedHold = 'paused_global' | 'paused_cluster' | 'checking_online' | 'hourly_limit' | 'notice_limit' | 'busy' | 'queued';
export type DeliveryDiagnosis = QueuedHold | 'running' | 'offline' | 'chain_limit' | 'failed' | 'unknown' | 'superseded' | 'accepted' | 'completed' | 'done';
export type ResendBlock = 'offline' | 'removed' | 'hidden' | 'hop_limit' | 'chain_limit';

export interface DeliveryTimeline {
  deliveryId: string;
  messageId: string;
  memberId: string;
  batchId: string | null;
  state: DeliveryState;
  outcome: DeliveryResult | null;
  error: string | null;
  handoffMessageId: string | null;
  diagnosis: DeliveryDiagnosis;
  stages: TimelineStage[];
  /** Null when there is nothing to resend (the delivery worked, or it was already handed off or resent). */
  resend: { available: boolean; blockedBy?: ResendBlock; needsConfirmation: boolean } | null;
}

export function deliveryDiagnosis(d: Delivery, hold: QueuedHold): DeliveryDiagnosis {
  if (d.state === 'queued') return hold;
  if (d.state === 'running') return 'running';
  if (d.state === 'offline' || d.state === 'superseded') return d.state;
  if (d.outcome === 'unknown') return 'unknown';
  if (d.state === 'failed') return d.error === CHAIN_LIMIT_ERROR ? 'chain_limit' : 'failed';
  return d.outcome === 'accepted' || d.outcome === 'completed' ? d.outcome : 'done';
}

/** A delivery that may have gone wrong: the ones a user can hand off or resend. */
export function deliveryUnresolved(d: Delivery): boolean {
  return d.state !== 'superseded' && (d.state === 'failed' || d.state === 'offline' || d.outcome === 'unknown');
}

/**
 * Proof the delivery never started: no attempt, no batch and no running event. A null batch alone proves nothing,
 * because rows older than batch ids have none; a done row ran, whatever its records say.
 */
export function deliveryNeverStarted(d: Delivery, startedAt: string | undefined): boolean {
  return d.attempts === 0 && d.batchId === null && !startedAt && d.state !== 'done';
}

/** The original may have reached the member, so a resend can run the work twice. Only proof it never started rules that out. */
export function resendNeedsConfirmation(d: Delivery, startedAt: string | undefined): boolean {
  return d.outcome === 'unknown' || (d.state === 'failed' && d.outcome !== 'failed' && !deliveryNeverStarted(d, startedAt));
}

export function timelineStages(d: Delivery, message: Message, times: { startedAt?: string; endedAt?: string }, acknowledgedAt: string | null): TimelineStage[] {
  const open = d.state === 'queued' || d.state === 'running';
  // A handoff rewrites updated_at, so only an untouched row's updated_at is the time the delivery ended.
  const endedAt = open ? null : times.endedAt ?? (d.handoffMessageId ? null : d.updatedAt);
  const neverStarted = deliveryNeverStarted(d, times.startedAt);
  const stage = (key: StageKey, status: StageStatus, at: string | null = null, reason?: string | null): TimelineStage =>
    ({ key, status, at, ...(reason ? { reason } : {}) });

  const started = times.startedAt ? stage('started', 'reached', times.startedAt)
    : d.state === 'queued' ? stage('started', 'pending')
      : neverStarted ? stage('started', 'not_reached') : stage('started', 'unknown');

  // The Hub stores no separate acceptance time: 'accepted' resolves as the delivery ends, 'completed' proves it only happened.
  const accepted = d.outcome === 'accepted' ? stage('accepted', 'reached', endedAt)
    : d.outcome === 'completed' ? stage('accepted', 'reached')
      : open ? stage('accepted', 'pending')
        : d.state === 'offline' || d.state === 'superseded' || neverStarted ? stage('accepted', 'not_reached') : stage('accepted', 'unknown');

  const acknowledged = acknowledgedAt ? stage('acknowledged', 'reached', acknowledgedAt)
    : open ? stage('acknowledged', 'pending') : stage('acknowledged', 'unknown');

  const ended = open ? stage('ended', 'pending')
    : stage('ended', endedAt ? 'reached' : 'unknown', endedAt, d.error);

  return [stage('queued', 'reached', message.createdAt), started, accepted, acknowledged, ended];
}
