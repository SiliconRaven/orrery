// The Hub's side of ship (docs/collaboration.md). scripts/ship.ts merges with the permissions of
// the member who runs it; the Hub only signs what may be merged, answers what the script asks, and records the result.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { batchShipState, type BatchShipState } from './batches.mts';
import { host } from './host.mts';
import { shipState } from './model.mts';
import { collaborationTask } from './store.mts';
import type { Hub } from './types.mts';

export class ShipRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const TICKET_RE = /^s1\.([A-Za-z0-9_-]{1,2048})\.([0-9a-f]{64})$/;
const FAILURE_KINDS = new Set(['conflict', 'checks']);
const MAX_DETAIL = 4600;

/** The script in the Hub's own checkout, supplied by the Hub host so installed packages never run a copy from package state. */
export const shipScript = (): string => host().hub.shipScript;

interface Claims { clusterId: string; taskId: string; submissionId: string; commitSha: string; reviewer: string }
const FIELDS = ['clusterId', 'taskId', 'submissionId', 'commitSha', 'reviewer'] as const;

const tagOf = (secret: string, body: string) => createHmac('sha256', secret).update(`orrery-ship\n${body}`).digest('hex');

export function shipTicket(secret: string, claims: Claims): string {
  const body = Buffer.from(JSON.stringify(FIELDS.map((f) => claims[f]))).toString('base64url');
  return `s1.${body}.${tagOf(secret, body)}`;
}

export function readShipTicket(secret: string, ticket: unknown): Claims | null {
  const m = typeof ticket === 'string' ? TICKET_RE.exec(ticket) : null;
  if (!m || !timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(tagOf(secret, m[1]), 'hex'))) return null;
  const values = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as string[];
  return Object.fromEntries(FIELDS.map((f, i) => [f, values[i]])) as unknown as Claims;
}

export function shipCommand(ticket: string, hubUrl: string, script = shipScript()): string {
  if (host().projects.UNSAFE_PATH.test(script)) throw new Error(`orrery 所在的路径 ${script} 含有 shell 会解释的字符，ship 命令放不进去`);
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(hubUrl)) throw new Error(`not a loopback Hub address: ${hubUrl}`);
  return `node "${script}" --ticket ${ticket} --hub ${hubUrl} --agent <name> --type <type> --summary "<English summary>" [--trailer "..."]`;
}

type ShipState = NonNullable<ReturnType<typeof shipState>>;

export function shipFor(hub: Hub, secret: string, hubUrl: string, clusterId: string, taskId: string): { ship?: { command: string } | { error: string } } {
  const state = shipState(hub.store, clusterId, taskId);
  if (!state) return {};
  try {
    return { ship: { command: shipCommand(shipTicket(secret, { clusterId, taskId, submissionId: state.submission.id, commitSha: state.commitSha, reviewer: state.reviewer }), hubUrl) } };
  } catch (e) {
    return { ship: { error: e instanceof Error ? e.message : String(e) } };
  }
}

export const shipRunner = (state: ShipState) => (state.reviewer === 'user' || state.self ? state.executorId : state.reviewer);

export function shipForRunner(hub: Hub, secret: string, hubUrl: string, clusterId: string, taskId: string, memberId: string) {
  const state = shipState(hub.store, clusterId, taskId);
  return state && shipRunner(state) === memberId ? shipFor(hub, secret, hubUrl, clusterId, taskId) : {};
}

function checked(hub: Hub, secret: string, ticket: unknown): { claims: Claims; state: ShipState } {
  const claims = readShipTicket(secret, ticket);
  if (!claims) throw new ShipRefused(403, 'ship ticket invalid');
  if (collaborationTask(hub.store, claims.clusterId, claims.taskId)?.batchId) {
    throw new ShipRefused(409, 'this task is in a review batch, which is merged as a whole: run the batch ship command from get_batch');
  }
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
    verdict: state.self ? 'self' : 'pass', ...(state.takeover ? { takeover: true } : {}), ...(state.shipFix ? { shipFix: true } : {}) };
}

function shipBranch(cwd: string): string {
  const { gitSync } = host().projects;
  try {
    return gitSync(cwd, 'config', '--get', 'orrery.shipBranch').trim() || 'main';
  } catch (e) {
    if ((e as { status?: number }).status === 1) return 'main';
    throw e;
  }
}

export function mergedOnTarget(cwds: string[], mergeCommit: string, commitSha: string): boolean {
  const { gitSync } = host().projects;
  for (const cwd of cwds) {
    try {
      gitSync(cwd, 'merge-base', '--is-ancestor', mergeCommit, `refs/heads/${shipBranch(cwd)}`);
      if (gitSync(cwd, 'rev-parse', '--verify', `${mergeCommit}^2`).trim().startsWith(commitSha)) return true;
    } catch { /* not this directory's repository, or not an ancestor: try the next */ }
  }
  return false;
}

function isAncestor(cwd: string, a: string, b: string): boolean {
  const { gitSync } = host().projects;
  try { gitSync(cwd, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; }
}

export function batchMergedOnTarget(cwds: string[], mergeCommit: string, commits: string[]): boolean {
  const { gitSync } = host().projects;
  for (const cwd of cwds) {
    try {
      gitSync(cwd, 'merge-base', '--is-ancestor', mergeCommit, `refs/heads/${shipBranch(cwd)}`);
      const reviewed = [...new Set(commits.map((commit) => gitSync(cwd, 'rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`).trim()))];
      const heads = reviewed.filter((commit) => !reviewed.some((other) => other !== commit && isAncestor(cwd, commit, other)));
      const [first, ...parents] = gitSync(cwd, 'rev-parse', `${mergeCommit}^@`).trim().split(/\r?\n/);
      if (!heads.length || parents.length !== heads.length || !heads.every((head) => parents.includes(head))) continue;
      if (reviewed.every((commit) => isAncestor(cwd, commit, mergeCommit) && !isAncestor(cwd, commit, first))) return true;
    } catch { /* not this directory's repository, or not on the target: try the next */ }
  }
  return false;
}

const BATCH_TICKET_RE = /^b1\.([A-Za-z0-9_-]{1,1024})\.([0-9a-f]{64})$/;
interface BatchClaims { clusterId: string; batchId: string; digest: string }
const batchTag = (secret: string, body: string) => createHmac('sha256', secret).update(`orrery-ship-batch\n${body}`).digest('hex');

export function batchShipTicket(secret: string, claims: BatchClaims): string {
  const body = Buffer.from(JSON.stringify([claims.clusterId, claims.batchId, claims.digest])).toString('base64url');
  return `b1.${body}.${batchTag(secret, body)}`;
}

export function readBatchShipTicket(secret: string, ticket: unknown): BatchClaims | null {
  const m = typeof ticket === 'string' ? BATCH_TICKET_RE.exec(ticket) : null;
  if (!m || !timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(batchTag(secret, m[1]), 'hex'))) return null;
  const [clusterId, batchId, digest] = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as string[];
  return { clusterId, batchId, digest };
}

export function batchShipCommand(ticket: string, hubUrl: string, script = shipScript()): string {
  return shipCommand(ticket, hubUrl, script).replace(`--ticket ${ticket}`, `--batch ${ticket}`);
}

export function batchShipFor(hub: Hub, secret: string, hubUrl: string, clusterId: string, batchId: string): { ship?: { command: string } | { error: string } } {
  const state = batchShipState(hub.store, clusterId, batchId);
  if (!state) return {};
  try {
    return { ship: { command: batchShipCommand(batchShipTicket(secret, { clusterId, batchId, digest: state.digest }), hubUrl) } };
  } catch (e) {
    return { ship: { error: e instanceof Error ? e.message : String(e) } };
  }
}

export function batchShipForRunner(hub: Hub, secret: string, hubUrl: string, clusterId: string, batchId: string | undefined, memberId: string) {
  const state = batchId ? batchShipState(hub.store, clusterId, batchId) : null;
  return state && state.runner === memberId ? batchShipFor(hub, secret, hubUrl, clusterId, batchId!) : {};
}

function checkedBatch(hub: Hub, secret: string, ticket: unknown): { claims: BatchClaims; state: BatchShipState } {
  const claims = readBatchShipTicket(secret, ticket);
  if (!claims) throw new ShipRefused(403, 'ship ticket invalid');
  const state = batchShipState(hub.store, claims.clusterId, claims.batchId);
  if (!state || state.digest !== claims.digest) {
    throw new ShipRefused(409, 'this batch ship ticket no longer matches the batch: not every task has the approved result it was signed for');
  }
  for (const task of state.tasks) {
    if (!task.independent) throw new ShipRefused(403, `the reviewer worked on task #${task.task.number}, so its review cannot be shipped`);
  }
  return { claims, state };
}

export function verifyBatchShip(hub: Hub, secret: string, ticket: unknown) {
  const { claims, state } = checkedBatch(hub, secret, ticket);
  return { batchId: claims.batchId, number: state.batch.number, title: state.batch.title,
    tasks: state.tasks.map((task) => ({ taskId: task.task.id, number: task.task.number, shortId: task.task.id.slice(0, 8), commitSha: task.commitSha,
      reviewer: task.reviewerName, round: task.round, verdict: task.self ? 'self' : 'pass',
      ...(task.takeover ? { takeover: true } : {}), ...(task.shipFix ? { shipFix: true } : {}) })) };
}

function normalizeFailureReport(bodyFailed: any, validBatchTaskIds?: Set<string>) {
  const { kind, detail, taskId, conflictFiles: rawFiles, failedCheck: rawCheck } = bodyFailed;
  if (!FAILURE_KINDS.has(kind) || typeof detail !== 'string') {
    throw new ShipRefused(400, validBatchTaskIds
      ? 'failed must be { kind: conflict|checks, detail: string, taskId? }'
      : 'failed must be { kind: conflict|checks, detail: string }');
  }
  if (validBatchTaskIds && kind === 'conflict' && !validBatchTaskIds.has(taskId)) {
    throw new ShipRefused(400, 'a conflict names the task whose branch conflicted (taskId)');
  }
  const diagnostic = detail.length > MAX_DETAIL ? `…（仅保留末尾）\n${detail.slice(-MAX_DETAIL).toWellFormed()}` : detail;
  const conflictFiles = Array.isArray(rawFiles)
    ? rawFiles.filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0).slice(0, 200).map((f: string) => f.trim().slice(0, 500))
    : [];
  const failedCheck = typeof rawCheck === 'string' && rawCheck.trim() ? rawCheck.trim().slice(0, 200) : undefined;
  return {
    kind: kind as 'conflict' | 'checks',
    detail: diagnostic || 'no detail',
    ...(validBatchTaskIds && kind === 'conflict' ? { taskId: taskId as string } : {}),
    ...(conflictFiles.length ? { conflictFiles } : {}),
    ...(failedCheck ? { failedCheck } : {}),
  };
}

export async function reportBatchShip(hub: Hub, secret: string, body: any): Promise<{ status: 'merged' | 'failed' }> {
  const { claims, state } = checkedBatch(hub, secret, body?.ticket);
  const command = { batchId: claims.batchId, operationId: `ship-${randomUUID()}`,
    batchSubmissions: state.tasks.map((task) => ({ taskId: task.task.id, submissionId: task.submission.id })) };
  if (body.failed) {
    const failure = normalizeFailureReport(body.failed, new Set(state.tasks.map((task) => task.task.id)));
    hub.collaboration.command({ kind: 'system' }, claims.clusterId, { ...command, action: 'batch.ship_failed',
      failure, reason: `${failure.kind}: ${failure.detail}` });
    return { status: 'failed' };
  }
  const { mergeCommit, pushed, retried } = body;
  if (typeof mergeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(mergeCommit) || typeof pushed !== 'boolean') throw new ShipRefused(400, 'expected { ticket, mergeCommit: 40 hex characters, pushed: boolean }');
  if (!batchMergedOnTarget(state.cwds, mergeCommit, state.tasks.map((task) => task.commitSha))) {
    throw new ShipRefused(409, `${mergeCommit} is not on the target branch with every reviewed commit of the batch merged by it`);
  }
  hub.collaboration.command({ kind: 'system' }, claims.clusterId, { ...command, action: 'batch.shipped', commitSha: mergeCommit,
    reason: `ship; pushed: ${pushed}${Array.isArray(retried) && retried.length ? `; checks retried: ${retried.join(', ').slice(0, 200)}` : ''}` });
  return { status: 'merged' };
}

export async function reportShip(hub: Hub, secret: string, body: any): Promise<{ status: 'merged' | 'failed' }> {
  const { claims, state } = checked(hub, secret, body?.ticket);
  const command = { taskId: claims.taskId, expectedRevision: state.task.revision, operationId: `ship-${randomUUID()}`, submissionId: claims.submissionId };
  if (body.failed) {
    const failure = normalizeFailureReport(body.failed);
    hub.collaboration.command({ kind: 'system' }, claims.clusterId, { ...command, action: 'task.ship_failed',
      failure, reason: `${failure.kind}: ${failure.detail}` });
    return { status: 'failed' };
  }
  const { mergeCommit, pushed, retried } = body;
  if (typeof mergeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(mergeCommit) || typeof pushed !== 'boolean') throw new ShipRefused(400, 'expected { ticket, mergeCommit: 40 hex characters, pushed: boolean }');
  if (!mergedOnTarget(state.cwds, mergeCommit, claims.commitSha)) throw new ShipRefused(409, `${mergeCommit} is not on the target branch with the reviewed commit as its second parent`);
  hub.collaboration.command({ kind: 'system' }, claims.clusterId, { ...command, action: 'task.shipped', commitSha: mergeCommit,
    reason: `ship; pushed: ${pushed}${Array.isArray(retried) && retried.length ? `; checks retried: ${retried.join(', ').slice(0, 200)}` : ''}` });
  return { status: 'merged' };
}
