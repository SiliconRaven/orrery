// The automatic branch link at submit (docs/collaboration.md「任务关联本地 Git 分支」): read-only git before the submit's
// transaction (prepareSubmit, the plugin's `prepare` step), and the decision inside it (decideBranchLink), which trusts
// only what it can check again there.
import { stat } from 'node:fs/promises';
import { batchShipFixAffectedTasks, batchShipState, canBatchShipFix } from './batches.mts';
import { host } from './host.mts';
import { approvedResult, canShipFixTask, completionValid, resolveTaskRef } from './model.mts';
import { collaborationRecords, collaborationTask, taskBatch } from './store.mts';
import { takeoverRecords } from './takeover.mts';
import type { Assignment, BranchLinkOutcome, PluginPrepare, Store, Submission, Task, TaskGitBranch } from './types.mts';

/** The whole lookup's time, waiting for a slot included: past it the submit goes on without a link and git is killed. */
export const BRANCH_LOOKUP_BUDGET_MS = 1500;
/** Lookups that may run at once; a submit that gets no slot within its budget goes on unlinked (reason busy). */
export const MAX_CONCURRENT_LOOKUPS = 4;
/** Branch names a result lists when several branches point at the commit, and their total length. */
const MAX_BRANCH_CANDIDATES = 5;
const MAX_CANDIDATE_CHARS = 2048;

type Reason = NonNullable<BranchLinkOutcome['reason']>;
export type GitRunner = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;
let run: GitRunner | undefined;
const gitRunner = (): GitRunner => run ?? host().projects.gitRead;
let budget = BRANCH_LOOKUP_BUDGET_MS;
/** Tests replace the git runner and the budget; no argument restores both. */
export function setBranchLookup(options: { runner?: GitRunner; budgetMs?: number } = {}): void {
  run = options.runner;
  budget = options.budgetMs ?? BRANCH_LOOKUP_BUDGET_MS;
}

// The shared slots. A slot is held until its submit stops waiting (the budget aborts git), not until a git that ignores
// the abort returns.
let active = 0;
const queue: (() => void)[] = [];
/** `slot.held` turns true the moment a slot is given, so whoever stops waiting first knows to give it back. */
function acquire(signal: AbortSignal, slot: { held: boolean }): Promise<boolean> {
  if (active < MAX_CONCURRENT_LOOKUPS) { active++; slot.held = true; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const grant = () => { signal.removeEventListener('abort', give); active++; slot.held = true; resolve(true); };
    const give = () => { const at = queue.indexOf(grant); if (at >= 0) queue.splice(at, 1); resolve(false); };
    queue.push(grant);
    signal.addEventListener('abort', give, { once: true });
  });
}
function release(): void {
  active--;
  queue.shift()?.();
}

/** What the takeover / ship_fix diff inspection found between two commits. */
export interface ProductCodeDiff {
  changed: boolean;
  files: string[];
  unverified?: boolean;
}

/** Snapshot captured at request arrival before any async prepare work, so omitted expectedRevision still detects concurrent submits. */
export interface SubmitPreparedSnapshot {
  taskId: string;
  revision: number;
  assignmentId: string | null;
  latestSubmissionId: string | null;
}

/** What the lookup read, and for which submit; the decision checks the first five against what it reads in the transaction. */
export interface BranchFacts {
  kind: 'branch-facts';
  taskId: string; memberId: string; commitSha: string;
  snapshot?: SubmitPreparedSnapshot;
  /** The executor's saved project folder and the task's link, as the lookup read them. */
  cwd: string | null; link: TaskGitBranch | null;
  /** The repository looked in: the link's when the task had one, else the executor's (its representative worktree). */
  repositoryPath?: string;
  /** Local branches whose tip is the commit, as git listed them (at most MAX_BRANCH_CANDIDATES + 1); [] when the commit is unknown. */
  names?: string[];
  unknownCommit?: boolean;
  /** Whether `link`'s branch contains the commit; left out when not checked. */
  linkContains?: boolean;
  error?: Reason;
  /** When submitting a taken-over self-review task by another member: whether product files outside tests/docs changed. */
  takeoverBaseSha?: string | null;
  productCodeDiff?: ProductCodeDiff;
}

export interface SubmitPreparedSkip {
  kind: 'submit-snapshot';
  snapshot: SubmitPreparedSnapshot;
}

export function preparedSubmitSnapshot(prepared: unknown): SubmitPreparedSnapshot | undefined {
  if (!prepared || typeof prepared !== 'object') return undefined;
  const candidate = prepared as Partial<BranchFacts | SubmitPreparedSkip>;
  return candidate.kind === 'branch-facts' || candidate.kind === 'submit-snapshot' ? candidate.snapshot : undefined;
}

/** Read-only git verification before `task.ship_fix` opens its transaction. */
export type ShipFixFacts =
  | { kind: 'ship-fix-precheck-skip' }
  | {
      kind: 'ship-fix-facts';
      taskId: string;
      memberId: string;
      baseSubmissionId: string;
      baseCommitSha: string;
      fixInputSha: string;
      failureEventId: number;
      fullApprovedSha?: string;
      fullFixSha?: string;
      branchFacts?: BranchFacts;
      productCodeDiff?: ProductCodeDiff;
      error?: 'same_commit' | 'not_ancestor' | 'no_repository' | 'unknown_commit' | 'timeout' | 'busy' | 'git_error';
    };

const SHA = /^[0-9a-f]{7,40}$/i;
/** A name that can be shown: not overlong, no control characters. */
const showable = (name: string) => name.length > 0 && name.length <= 1024 && !/[\x00-\x1f\x7f]/.test(name);
/** What set_git_branch also refuses; a name git itself listed already passed check-ref-format. */
const usableBranch = (name: string) => showable(name) && !name.startsWith('-') && name !== 'HEAD';
const exitCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

class Stop extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) { super(reason); this.reason = reason; }
}
const reasonOf = (error: unknown, signal: AbortSignal): Reason => error instanceof Stop ? error.reason
  : signal.aborted ? 'timeout' : exitCode(error) === 'ENOENT' ? 'git_unavailable' : 'git_error';

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

const normRepoRelPath = (file: string) => file.replaceAll('\\', '/').replace(/^\.\//, '').trim();
export function isDocOrTestPath(file: string): boolean {
  const norm = normRepoRelPath(file);
  if (!norm) return true;
  return /\.md$/i.test(norm) || /(?:^|\/)docs\//i.test(norm) || /(?:^|\/)test\//i.test(norm)
    || /(?:^|\/)__tests__\//i.test(norm) || /[^/]+\.(?:test|spec)\.[^/]+$/i.test(norm);
}

/**
 * Inspects `baseSha..newSha` for non-doc/non-test product code changes (excluding pure conflict resolutions in
 * `conflictFiles` for merge commits). Fails safe to `{ changed: true, files: [], unverified: true }` when history
 * cannot be verified (timeout, missing commit, non-ancestor base).
 */
export async function detectProductCodeChanges(
  gitFn: (cwd: string, ...args: string[]) => Promise<string>,
  cwd: string,
  baseSha: string,
  newSha: string,
  signal: AbortSignal,
  conflictFiles?: string[],
): Promise<ProductCodeDiff> {
  const notFound = (error: unknown) => !signal.aborted && exitCode(error) === 1;
  try {
    const parseCommit = async (sha: string) => {
      const out = (await gitFn(cwd, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`)).trim().toLowerCase();
      return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out) ? out : null;
    };
    const [fullBase, fullNew] = await Promise.all([parseCommit(baseSha), parseCommit(newSha)]);
    if (!fullBase || !fullNew) return { changed: true, files: [], unverified: true };
    if (fullBase === fullNew) return { changed: false, files: [] };
    try { await gitFn(cwd, 'merge-base', '--is-ancestor', fullBase, fullNew); }
    catch { return { changed: true, files: [], unverified: true }; }

    let shipBranch = 'main';
    try {
      shipBranch = (await gitFn(cwd, 'config', '--get', 'orrery.shipBranch')).trim() || 'main';
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    let shipRefExists = true;
    try { await gitFn(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${shipBranch}`); }
    catch (error) { if (notFound(error)) shipRefExists = false; else throw error; }
    const exclude = shipRefExists ? [`^refs/heads/${shipBranch}`] : [];
    const range = `${fullBase}..${fullNew}`;

    const nonMergeRaw = await gitFn(cwd, 'log', '--no-merges', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--pretty=format:', ...exclude, range);
    const productFiles = new Set<string>();
    for (const entry of nonMergeRaw.split('\0')) {
      const file = normRepoRelPath(entry);
      if (file && !isDocOrTestPath(file)) productFiles.add(file);
    }

    const diffTree = async (aSha: string, bSha: string): Promise<Set<string>> => {
      const raw = await gitFn(cwd, 'diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-ext-diff', '--no-textconv', aSha, bSha);
      const out = new Set<string>();
      for (const entry of raw.split('\0')) {
        const file = normRepoRelPath(entry);
        if (file) out.add(file);
      }
      return out;
    };

    // Inspect merge commits via pure read-only object/tree comparisons (never invoke any merge engine or merge drivers).
    const mergesRaw = await gitFn(cwd, 'rev-list', '--merges', '--parents', ...exclude, range);
    const conflictSet = new Set((conflictFiles ?? []).map((f) => normRepoRelPath(f).toLowerCase()).filter(Boolean));
    let unverified = false;
    for (const line of mergesRaw.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const [mergeSha, ...parents] = parts;
      if (parents.length !== 2) {
        unverified = true;
        continue;
      }
      const [p1, p2] = parents;
      let mergeBases: string[] = [];
      try {
        const mbRaw = await gitFn(cwd, 'merge-base', '--all', p1, p2);
        mergeBases = mbRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
      if (mergeBases.length !== 1) {
        unverified = true;
        continue;
      }
      const mb = mergeBases[0];
      const [d1, d2, t1, t2] = await Promise.all([
        diffTree(p1, mergeSha),
        diffTree(p2, mergeSha),
        diffTree(mb, p1),
        diffTree(mb, p2),
      ]);
      for (const file of new Set([...d1, ...d2])) {
        if (isDocOrTestPath(file) || conflictSet.has(file.toLowerCase())) continue;
        const inD1 = d1.has(file);
        const inD2 = d2.has(file);
        const inT1 = t1.has(file);
        const inT2 = t2.has(file);
        if (inD1 && inD2) {
          if (inT1 && inT2) unverified = true;
          else productFiles.add(file);
        } else if (inD1 && !inD2 && inT1) {
          productFiles.add(file);
        } else if (!inD1 && inD2 && inT2) {
          productFiles.add(file);
        }
      }
    }
    const files = [...productFiles].sort();
    return { changed: files.length > 0 || unverified, files, ...(unverified ? { unverified: true } : {}) };
  } catch {
    return { changed: true, files: [], unverified: true };
  }
}

const isNotFound = (error: unknown, signal: AbortSignal) =>
  !signal.aborted && exitCode(error) === 1 && !String((error as { stdout?: unknown }).stdout ?? '').trim();

type GitCall = (cwd: string, ...args: string[]) => Promise<string>;

async function resolveCommitObject(gitFn: GitCall, signal: AbortSignal, cwd: string, shaInput: string): Promise<string | null> {
  try {
    const full = (await gitFn(cwd, 'rev-parse', '--verify', '--quiet', `${shaInput}^{commit}`)).trim().toLowerCase();
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(full) && full.startsWith(shaInput.toLowerCase()) ? full : null;
  } catch (error) {
    if (isNotFound(error, signal)) return null;
    throw error;
  }
}

async function branchContainsCommit(gitFn: GitCall, signal: AbortSignal, cwd: string, full: string | null, branch: string): Promise<boolean> {
  if (!full || !usableBranch(branch)) return false;
  try { await gitFn(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); }
  catch (error) { if (isNotFound(error, signal)) return false; throw error; }
  // Both sides exist now, so only exit 1 means "not an ancestor"; 128 and the rest are failures.
  try { await gitFn(cwd, 'merge-base', '--is-ancestor', full, `refs/heads/${branch}`); return true; }
  catch (error) { if (!signal.aborted && exitCode(error) === 1) return false; throw error; }
}

/**
 * The repository git finds from `path` (its representative worktree, as links store it); null when git finds none.
 * shortcut: any exit code reads as "no repository" (128 is both "not a repository" and a damaged one): for a linked task
 * either way the link cannot be verified and stays; with no link none is made. Read stderr if the two ever need different answers.
 */
async function repositoryAtPath(gitFn: GitCall, path: string): Promise<string | null> {
  const { representativeWorktree, worktreeList } = host().projects;
  try { return representativeWorktree(await gitFn(path, ...worktreeList)); }
  catch (error) { if (typeof exitCode(error) === 'number' || error instanceof Error && error.message === 'no working tree') return null; throw error; }
}

async function tipsForCommit(
  gitFn: GitCall,
  signal: AbortSignal,
  base: BranchFacts,
  cwd: string,
  repositoryPath: string,
  full: string | null,
): Promise<BranchFacts> {
  if (!full) return { ...base, repositoryPath, names: [], unknownCommit: true };
  // --points-at keeps the listing to the branches at this commit, however many the repository has.
  const listed = await gitFn(cwd, 'for-each-ref', `--points-at=${full}`, `--count=${MAX_BRANCH_CANDIDATES + 1}`, '--format=%(refname)', 'refs/heads/');
  const names = listed.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.startsWith('refs/heads/'))
    .map((line) => line.slice('refs/heads/'.length));
  const facts: BranchFacts = { ...base, repositoryPath, names };
  if (base.link?.automatic && !(names.length === 1 && usableBranch(names[0]))) facts.linkContains = await branchContainsCommit(gitFn, signal, cwd, full, base.link.branch);
  if (base.takeoverBaseSha) {
    facts.productCodeDiff = await detectProductCodeChanges(gitFn, cwd, base.takeoverBaseSha, full, signal);
  }
  return facts;
}

async function runWithLookupBudget<T>(
  outerSignal: AbortSignal,
  fn: (signal: AbortSignal, gitFn: GitCall) => Promise<T>,
  onTimeout: (heldSlot: boolean) => T,
): Promise<T> {
  const controller = new AbortController();
  const slot = { held: false };
  let timer: NodeJS.Timeout | undefined;
  const onOuterAbort = () => controller.abort();
  outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  const gitFn: GitCall = (cwd, ...args) => {
    if (controller.signal.aborted) throw new Stop('timeout');
    return gitRunner()(cwd, args, controller.signal);
  };
  const work = (async (): Promise<T> => {
    if (!(await acquire(controller.signal, slot))) return onTimeout(false);
    return fn(controller.signal, gitFn);
  })();
  // The budget covers waiting for a slot and git; a git that ignores the abort cannot hold the request either.
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => { resolve(onTimeout(slot.held)); controller.abort(); }, budget);
  });
  try { return await Promise.race([work, late]); }
  finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
    if (slot.held) { slot.held = false; release(); }
  }
}

async function readFacts(base: BranchFacts, signal: AbortSignal): Promise<BranchFacts> {
  const { sameRepositoryPath } = host().projects;
  const git: GitCall = (cwd, ...args) => {
    if (signal.aborted) throw new Stop('timeout');
    return gitRunner()(cwd, args, signal);
  };
  // The repository: the task's linked one when it has a link (set_git_branch's order), else the executor's folder.
  const repositoryPath = base.link?.repositoryPath;
  try {
    if (base.link) {
      // The stored path must still be that repository: git also finds a repository upward from a plain directory, and
      // what it would answer from a parent repository is not about the link.
      if (!(await isDirectory(base.link.repositoryPath))) return { ...base, repositoryPath, error: 'no_repository' };
      const found = await repositoryAtPath(git, base.link.repositoryPath);
      if (!found || !sameRepositoryPath(found, base.link.repositoryPath)) return { ...base, repositoryPath, error: 'no_repository' };
      const full = await resolveCommitObject(git, signal, base.link.repositoryPath, base.commitSha);
      // A manual link is never changed: only whether its branch has the commit.
      if (!base.link.automatic) {
        const linkContains = await branchContainsCommit(git, signal, base.link.repositoryPath, full, base.link.branch);
        const productCodeDiff = full && base.takeoverBaseSha
          ? await detectProductCodeChanges(git, base.link.repositoryPath, base.takeoverBaseSha, full, signal)
          : undefined;
        return { ...base, repositoryPath, linkContains, ...(productCodeDiff ? { productCodeDiff } : {}) };
      }
      return await tipsForCommit(git, signal, base, base.link.repositoryPath, base.link.repositoryPath, full);
    }
    // No link: whatever repository git finds from the executor's folder (a subdirectory or a linked worktree included).
    if (!base.cwd || !(await isDirectory(base.cwd))) return { ...base, error: 'no_repository' };
    const folderRepository = await repositoryAtPath(git, base.cwd);
    if (!folderRepository) return { ...base, error: 'no_repository' };
    return await tipsForCommit(git, signal, base, base.cwd, folderRepository, await resolveCommitObject(git, signal, base.cwd, base.commitSha));
  } catch (error) {
    return { ...base, repositoryPath, error: reasonOf(error, signal) };
  }
}

/**
 * Only a submit that could succeed gets a lookup: the task's current executor with its active assignment, or the prior
 * executor resubmitting an invalidated completed result. The transaction stays the authority; this only keeps anyone
 * else from making the Hub start git.
 */
function couldSubmit(store: Store, task: Task, actorId: string, assignmentId: unknown, expectedRevision: unknown): boolean {
  const { actorKey } = host().collaboration;
  const assignments = collaborationRecords<Assignment>(store, task.id, 'assignment');
  if (task.status === 'working' || task.status === 'review') {
    const current = assignments.find((a) => a.id === task.currentAssignmentId);
    if (!current || current.endedAt || current.memberId !== actorId || task.assignedMemberId !== actorId) return false;
    if (assignmentId !== undefined) return assignmentId === current.id;
    // After same-member reassignment, bare submit without assignmentId or expectedRevision is ambiguous and will be refused.
    if (expectedRevision === undefined && assignments.some((a) => a.id !== current.id && (a.memberId === actorId || a.actorKey === current.actorKey))) {
      return false;
    }
    return true;
  }
  if (task.status !== 'completed' || completionValid(store, task)) return false;
  const approved = collaborationRecords<Submission>(store, task.id, 'submission').find((s) => s.id === task.approvedSubmissionId);
  const prior = approved && assignments.find((a) => a.id === approved.assignmentId);
  const member = store.getMember(actorId);
  return !!prior && !!member && assignmentId === approved.assignmentId && prior.actorKey === actorKey(member);
}

/**
 * task.submit's `prepare`: captures the task snapshot synchronously at arrival, then reads what git says about the
 * submitted commit before the transaction under one time budget. Even when git is skipped (no commitSha or not
 * submittable), returns the arrival snapshot so omitted expectedRevision still detects concurrent mutations.
 */
export const prepareSubmit: PluginPrepare = async ({ store, actor, actorId, clusterId, command, signal }) => {
  if (actor.kind !== 'member') return undefined;
  let task: Task | null = null;
  try {
    task = collaborationTask(store, clusterId, resolveTaskRef(store, clusterId, command.taskId as string));
  } catch {
    return undefined;
  }
  if (!task) return undefined;
  const snapshot: SubmitPreparedSnapshot = {
    taskId: task.id,
    revision: task.revision,
    assignmentId: task.currentAssignmentId,
    latestSubmissionId: task.latestSubmissionId,
  };
  if (typeof command.commitSha !== 'string' || !SHA.test(command.commitSha)
    || !couldSubmit(store, task, actorId, command.assignmentId, command.expectedRevision)) {
    return { kind: 'submit-snapshot', snapshot } satisfies SubmitPreparedSkip;
  }
  const latestTakeover = task.reviewer.kind === 'self' ? takeoverRecords(store, task.id).at(-1) : undefined;
  const takeoverBaseSha = latestTakeover?.fromMemberId && latestTakeover.fromMemberId !== actorId ? (latestTakeover.baseCommitSha ?? null) : null;
  const base: BranchFacts = { kind: 'branch-facts', taskId: task.id, memberId: actorId, commitSha: command.commitSha.toLowerCase(),
    snapshot, cwd: store.getMember(actorId)?.cwd ?? null, link: task.gitBranch ? { ...task.gitBranch } : null,
    ...(takeoverBaseSha ? { takeoverBaseSha } : {}),
    // A linked task is looked up in its linked repository, so even a lookup that times out or waits in vain names it.
    ...(task.gitBranch ? { repositoryPath: task.gitBranch.repositoryPath } : {}) };
  return runWithLookupBudget<BranchFacts>(
    signal,
    (lookupSignal) => readFacts(base, lookupSignal),
    (heldSlot) => ({ ...base, error: heldSlot ? 'timeout' : 'busy' }),
  );
};

/**
 * task.ship_fix's `prepare` (fail-closed in actions.mts): pre-checks eligibility before touching git, then resolves canonical
 * SHAs, verifies `git merge-base --is-ancestor <approved> <fix>`, inspects branch tips and checks product code diff.
 */
export const prepareShipFix: PluginPrepare = async ({ store, actor, actorId, clusterId, command, signal }): Promise<ShipFixFacts> => {
  const { sameRepositoryPath } = host().projects;
  const skip: ShipFixFacts = { kind: 'ship-fix-precheck-skip' };
  if (actor.kind !== 'member') return skip;
  if (typeof command.commitSha !== 'string' || !SHA.test(command.commitSha.trim())) return skip;
  const failureEventId = command.failureEventId;
  if (typeof failureEventId !== 'number' || !Number.isSafeInteger(failureEventId) || failureEventId <= 0) return skip;
  if (command.baseCommitSha !== undefined && (typeof command.baseCommitSha !== 'string' || !SHA.test(command.baseCommitSha.trim()))) return skip;
  let resolvedTaskId: string;
  try {
    resolvedTaskId = resolveTaskRef(store, clusterId, command.taskId as string);
  } catch {
    return skip;
  }
  const task = collaborationTask(store, clusterId, resolvedTaskId);
  if (!task || task.status !== 'completed' || !task.mergeRequired) return skip;
  const batch = task.batchId ? taskBatch(store, clusterId, task.batchId) : null;
  if (task.batchId) {
    const state = batch ? batchShipState(store, clusterId, batch.id) : null;
    if (!state || !canBatchShipFix(state, actorId) || !batch?.shipFailure || batch.shipFailure.eventId !== failureEventId) return skip;
    if ((batch.shipFailure.fixes ?? []).some((fix) => fix.taskId === task.id)) return skip;
    if (!batchShipFixAffectedTasks(state, batch.shipFailure).has(task.id)) return skip;
  } else {
    if (!canShipFixTask(store, task, actorId) || !task.shipFailure || task.shipFailure.eventId !== failureEventId) return skip;
  }
  const approved = approvedResult(store, task);
  if (!approved) return skip;
  const baseCommitSha = approved.commitSha.toLowerCase();
  if (typeof command.baseCommitSha === 'string') {
    const inputBase = command.baseCommitSha.trim().toLowerCase();
    if (!baseCommitSha.startsWith(inputBase) && !inputBase.startsWith(baseCommitSha)) return skip;
  }
  const fixInputSha = command.commitSha.trim().toLowerCase();
  const base: Extract<ShipFixFacts, { kind: 'ship-fix-facts' }> = {
    kind: 'ship-fix-facts',
    taskId: task.id,
    memberId: actorId,
    baseSubmissionId: approved.submission.id,
    baseCommitSha,
    fixInputSha,
    failureEventId,
  };
  const conflictFiles = task.shipFailure?.conflictFiles ?? batch?.shipFailure?.conflictFiles;
  const actorCwd = store.getMember(actorId)?.cwd ?? null;
  return runWithLookupBudget<ShipFixFacts>(
    signal,
    async (lookupSignal, git) => {
      try {
        let cwd: string;
        let repositoryPath: string;
        if (task.gitBranch) {
          if (!(await isDirectory(task.gitBranch.repositoryPath))) return { ...base, error: 'no_repository' };
          const found = await repositoryAtPath(git, task.gitBranch.repositoryPath);
          if (!found || !sameRepositoryPath(found, task.gitBranch.repositoryPath)) return { ...base, error: 'no_repository' };
          cwd = task.gitBranch.repositoryPath;
          repositoryPath = task.gitBranch.repositoryPath;
        } else {
          if (!actorCwd || !(await isDirectory(actorCwd))) return { ...base, error: 'no_repository' };
          const found = await repositoryAtPath(git, actorCwd);
          if (!found) return { ...base, error: 'no_repository' };
          cwd = actorCwd;
          repositoryPath = found;
        }
        const [fullApprovedSha, fullFixSha] = await Promise.all([
          resolveCommitObject(git, lookupSignal, cwd, baseCommitSha),
          resolveCommitObject(git, lookupSignal, cwd, fixInputSha),
        ]);
        if (!fullApprovedSha || !fullFixSha) return { ...base, error: 'unknown_commit' };
        if (fullApprovedSha === fullFixSha) return { ...base, fullApprovedSha, fullFixSha, error: 'same_commit' };
        try {
          await git(cwd, 'merge-base', '--is-ancestor', fullApprovedSha, fullFixSha);
        } catch (error) {
          if (!lookupSignal.aborted && exitCode(error) === 1) {
            return { ...base, fullApprovedSha, fullFixSha, error: 'not_ancestor' };
          }
          throw error;
        }
        const branchBase: BranchFacts = {
          kind: 'branch-facts',
          taskId: task.id,
          memberId: actorId,
          commitSha: fullFixSha,
          cwd: actorCwd,
          link: task.gitBranch ? { ...task.gitBranch } : null,
          ...(task.gitBranch ? { repositoryPath } : {}),
        };
        const branchFacts = task.gitBranch && !task.gitBranch.automatic
          ? {
              ...branchBase,
              repositoryPath,
              linkContains: await branchContainsCommit(git, lookupSignal, cwd, fullFixSha, task.gitBranch.branch),
            }
          : await tipsForCommit(git, lookupSignal, branchBase, cwd, repositoryPath, fullFixSha);
        const productCodeDiff = actorId !== approved.executorId
          ? await detectProductCodeChanges(git, cwd, fullApprovedSha, fullFixSha, lookupSignal, conflictFiles)
          : undefined;
        return {
          ...base,
          fullApprovedSha,
          fullFixSha,
          branchFacts,
          ...(productCodeDiff ? { productCodeDiff } : {}),
        };
      } catch (error) {
        return { ...base, error: reasonOf(error, lookupSignal) === 'timeout' ? 'timeout' : 'git_error' };
      }
    },
    (heldSlot) => ({ ...base, error: heldSlot ? 'timeout' : 'busy' }),
  );
};

const isFacts = (value: unknown): value is BranchFacts => !!value && typeof value === 'object' && (value as BranchFacts).kind === 'branch-facts';

/** The branch names a result shows: none overlong or with control characters, at most five and 2048 characters. */
function candidatesOf(names: string[]): Pick<BranchLinkOutcome, 'candidates' | 'more'> {
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    if (!showable(name)) continue;
    if (shown.length === MAX_BRANCH_CANDIDATES || used + name.length > MAX_CANDIDATE_CHARS) break;
    shown.push(name);
    used += name.length;
  }
  const more = shown.length < names.length;
  return shown.length || more ? { ...(shown.length ? { candidates: shown } : {}), ...(more ? { more: true } : {}) } : {};
}

/**
 * Inside the submit's transaction, after the submission is written: link, keep or clear, row by row as the table in
 * docs/collaboration.md「提交时自动关联」. Changes task.gitBranch in place and returns what the executor is told; undefined
 * when nothing was looked up. The facts were read before an await, so what they say counts only while the link and the
 * repository they were read in are still the ones the rule picks now.
 */
export function decideBranchLink(task: Task, prepared: unknown, actorId: string, commitSha: string | null, cwdNow: string | null): BranchLinkOutcome | undefined {
  if (!commitSha || !isFacts(prepared)) return undefined;
  const { canonical } = host().collaboration;
  const { sameRepositoryPath } = host().projects;
  const facts = prepared;
  const link = task.gitBranch ?? null;
  const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
  const keep = (reason?: Reason): BranchLinkOutcome => link
    ? { status: 'kept', branch: link.branch, ...(link.automatic ? { automatic: true } : {}), ...(reason ? { reason } : {}) }
    : { status: 'not_linked', ...(reason ? { reason } : {}) };
  // 1: the facts are for another submit.
  if (facts.taskId !== task.id || facts.memberId !== actorId || facts.commitSha !== commitSha) return keep('changed');
  if (link && !link.automatic) {
    if (!same(facts.link, link)) return keep('changed');                                   // 2
    if (facts.error) return keep(facts.error);                                             // 3
    return facts.linkContains === false ? { ...keep(), warning: 'not_on_branch' } : keep();   // 4, 5
  }
  // 6: the lookup did not read the repository the rule picks now: the linked one (an automatic link), or with no link the
  // executor's folder as it is now. A lookup made for a manual link (removed since) looked for no branches at all.
  const manualLookup = !!facts.link && !facts.link.automatic;
  const looked = link
    ? !manualLookup && !!facts.repositoryPath && sameRepositoryPath(facts.repositoryPath, link.repositoryPath)
    : !facts.link && facts.cwd === cwdNow;
  if (!looked) return keep('changed');
  if (facts.error) return keep(facts.error);                                               // 7
  if (!facts.names || !facts.repositoryPath) return keep('git_error');
  const names = facts.names;
  const only = names.length === 1 ? names[0] : null;
  if (only !== null && usableBranch(only)) {                                               // 8
    const next: TaskGitBranch = { repositoryPath: facts.repositoryPath, branch: only, automatic: true };
    if (same(link, next)) return keep();
    task.gitBranch = next;
    return { status: 'linked', branch: only, automatic: true };
  }
  const found: Reason = facts.unknownCommit ? 'unknown_commit' : only !== null ? 'invalid_branch' : names.length ? 'several_branches' : 'no_branch';
  const candidates = candidatesOf(names);
  if (!link) return { status: 'not_linked', reason: found, ...candidates };              // 9
  // 10: a concurrent submit moved the link after this lookup read it; what was checked was another branch.
  if (!same(facts.link, link)) { delete task.gitBranch; return { status: 'cleared', branch: link.branch, reason: 'changed', ...candidates }; }
  if (facts.linkContains === true) return { ...keep(found), ...candidates };              // 11
  delete task.gitBranch;                                                                   // 12
  return { status: 'cleared', branch: link.branch, reason: found, ...candidates };
}
