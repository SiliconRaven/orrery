// The Hub's side of ship (docs/collaboration.md, docs/collaboration.md). scripts/ship.ts merges with the permissions of
// the member who runs it; the Hub only signs what may be merged, answers what the script asks, and records the result.
//   - the ticket: s1.<base64url of clusterId, taskId, approved submissionId, commitSha, reviewer>.<hex HMAC-SHA256(bridge
//     secret, "orrery-ship\n" + that base64url)>. Not stored: every use is checked against the task's current state, so a
//     task that moved on (merged, reopened, a new approved submission) makes its old tickets worthless;
//   - POST /bridge/ship-verify: what the script may merge, and the fields of its Reviewed-by line;
//   - POST /bridge/ship-result: success only counts once read-only git confirms it. The Hub never writes to a repository.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { Hub } from '../../core/hub.ts';
import { gitSync, UNSAFE_PATH } from '../../core/projects.ts';
import { shipState } from './model.ts';

export class ShipRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const TICKET_RE = /^s1\.([A-Za-z0-9_-]{1,2048})\.([0-9a-f]{64})$/;
const FAILURE_KINDS = new Set(['conflict', 'checks']);
// scripts/ship.ts sends a 4,000-character output tail plus the check name and status.
const MAX_DETAIL = 4600;
/** The script in the Hub's own checkout, never the one in the branch under review: that one could rewrite ship itself. */
export const SHIP_SCRIPT = resolve(import.meta.dirname, '../../../scripts/ship.ts').replaceAll('\\', '/');

interface Claims { clusterId: string; taskId: string; submissionId: string; commitSha: string; reviewer: string }
const FIELDS = ['clusterId', 'taskId', 'submissionId', 'commitSha', 'reviewer'] as const;

const tagOf = (secret: string, body: string) => createHmac('sha256', secret).update(`orrery-ship\n${body}`).digest('hex');

export function shipTicket(secret: string, claims: Claims): string {
  const body = Buffer.from(JSON.stringify(FIELDS.map((f) => claims[f]))).toString('base64url');
  return `s1.${body}.${tagOf(secret, body)}`;
}

/** The claims a ticket makes, or null when it is malformed or not signed with this secret. Constant-time. */
export function readShipTicket(secret: string, ticket: unknown): Claims | null {
  const m = typeof ticket === 'string' ? TICKET_RE.exec(ticket) : null;
  if (!m || !timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(tagOf(secret, m[1]), 'hex'))) return null;
  const values = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as string[];
  return Object.fromEntries(FIELDS.map((f, i) => [f, values[i]])) as unknown as Claims;
}

export function shipCommand(ticket: string, hubUrl: string, script = SHIP_SCRIPT): string {
  if (UNSAFE_PATH.test(script)) throw new Error(`orrery 所在的路径 ${script} 含有 shell 会解释的字符，ship 命令放不进去`);
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(hubUrl)) throw new Error(`not a loopback Hub address: ${hubUrl}`);
  return `node "${script}" --ticket ${ticket} --hub ${hubUrl} --agent <name> --type <type> --summary "<English summary>" [--trailer "..."]`;
}

type ShipState = NonNullable<ReturnType<typeof shipState>>;

/** The ship command for a task's approved result, as a field to spread into a tool result; {} when it awaits no merge. */
export function shipFor(hub: Hub, secret: string, hubUrl: string, clusterId: string, taskId: string): { ship?: { command: string } | { error: string } } {
  const state = shipState(hub.store, clusterId, taskId);
  if (!state) return {};
  try {   // the review or read that asked has already happened: losing the command must not turn it into an error
    return { ship: { command: shipCommand(shipTicket(secret, { clusterId, taskId, submissionId: state.submission.id, commitSha: state.commitSha, reviewer: state.reviewer }), hubUrl) } };
  } catch (e) {
    return { ship: { error: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * Who runs ship: the member who approved the result, else its executor (the user approved it, even in a member reviewer's
 * place, or it was self-reviewed). Who runs it for user-approved tasks is not settled: change it here.
 */
export const shipRunner = (state: ShipState) => (state.reviewer === 'user' || state.self ? state.executorId : state.reviewer);

/** get_task's ship field: only for the member who runs ship, who can also read the command again here. */
export function shipForRunner(hub: Hub, secret: string, hubUrl: string, clusterId: string, taskId: string, memberId: string) {
  const state = shipState(hub.store, clusterId, taskId);
  return state && shipRunner(state) === memberId ? shipFor(hub, secret, hubUrl, clusterId, taskId) : {};
}

/** The signature and the task's current state; ShipRefused unless this ticket may still be used. */
function checked(hub: Hub, secret: string, ticket: unknown): { claims: Claims; state: ShipState } {
  const claims = readShipTicket(secret, ticket);
  if (!claims) throw new ShipRefused(403, 'ship ticket invalid');
  const state = shipState(hub.store, claims.clusterId, claims.taskId);
  if (!state || state.submission.id !== claims.submissionId || state.commitSha !== claims.commitSha || state.reviewer !== claims.reviewer) {
    throw new ShipRefused(409, 'this ship ticket no longer matches the task: it has no approved result awaiting merge for this commit and reviewer');
  }
  if (!state.self && !state.independent) throw new ShipRefused(403, 'the reviewer worked on this task, so its review cannot be shipped');
  if (state.self && state.takenOver && !state.takeover) throw new ShipRefused(403, 'this self review on a taken-over task was not authorised for its executor, so it cannot be shipped');
  return { claims, state };
}

export function verifyShip(hub: Hub, secret: string, ticket: unknown) {
  const { claims, state } = checked(hub, secret, ticket);
  return { taskId: claims.taskId, shortId: claims.taskId.slice(0, 8), commitSha: claims.commitSha, reviewer: state.reviewerName, round: state.round,
    verdict: state.self ? 'self' : 'pass', ...(state.takeover ? { takeover: true } : {}) };
}

/** The script's rule (scripts/ship.ts): this setting names the branch, main when it is not set (git exits 1). */
function shipBranch(cwd: string): string {
  try {
    return gitSync(cwd, 'config', '--get', 'orrery.shipBranch').trim() || 'main';
  } catch (e) {
    if ((e as { status?: number }).status === 1) return 'main';
    throw e;
  }
}

/**
 * Whether mergeCommit is on the target branch with the reviewed commit as its second parent, by read-only git in the
 * task's own working directories. Only the subcommands below run (test/ship.test.ts keeps it so).
 * shortcut: synchronous because task.merge checks inside its transaction, so the Hub waits for a few git calls; move the
 * check out of the transaction if that ever shows, since a merge is rare.
 */
export function mergedOnTarget(cwds: string[], mergeCommit: string, commitSha: string): boolean {
  for (const cwd of cwds) {
    try {
      gitSync(cwd, 'merge-base', '--is-ancestor', mergeCommit, `refs/heads/${shipBranch(cwd)}`);
      if (gitSync(cwd, 'rev-parse', '--verify', `${mergeCommit}^2`).trim().startsWith(commitSha)) return true;
    } catch { /* not this directory's repository, or not an ancestor: try the next */ }
  }
  return false;
}

/** POST /bridge/ship-result. Any path in the request is ignored: git runs where the task's own members work. */
export async function reportShip(hub: Hub, secret: string, body: any): Promise<{ status: 'merged' | 'returned' }> {
  const { claims, state } = checked(hub, secret, body?.ticket);
  const command = { taskId: claims.taskId, expectedRevision: state.task.revision, operationId: `ship-${randomUUID()}`, submissionId: claims.submissionId };
  if (body.failed) {
    const { kind, detail } = body.failed;
    if (!FAILURE_KINDS.has(kind) || typeof detail !== 'string') throw new ShipRefused(400, 'failed must be { kind: conflict|checks, detail: string }');
    const diagnostic = detail.length > MAX_DETAIL ? `…（仅保留末尾）\n${detail.slice(-MAX_DETAIL).toWellFormed()}` : detail;
    hub.collaboration.command({ kind: 'system' }, claims.clusterId, { ...command, action: 'task.ship_failed', reason: `${kind}: ${diagnostic || 'no detail'}` });
    return { status: 'returned' };
  }
  const { mergeCommit, pushed, retried } = body;
  if (typeof mergeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(mergeCommit) || typeof pushed !== 'boolean') throw new ShipRefused(400, 'expected { ticket, mergeCommit: 40 hex characters, pushed: boolean }');
  if (!mergedOnTarget(state.cwds, mergeCommit, claims.commitSha)) throw new ShipRefused(409, `${mergeCommit} is not on the target branch with the reviewed commit as its second parent`);
  hub.collaboration.command({ kind: 'system' }, claims.clusterId, { ...command, action: 'task.shipped', commitSha: mergeCommit,
    reason: `ship; pushed: ${pushed}${Array.isArray(retried) && retried.length ? `; checks retried: ${retried.join(', ').slice(0, 200)}` : ''}` });
  return { status: 'merged' };
}
