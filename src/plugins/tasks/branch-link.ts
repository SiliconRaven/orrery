// The automatic branch link at submit (docs/collaboration.md「任务关联本地 Git 分支」): read-only git before the submit's
// transaction (prepareSubmit, the plugin's `prepare` step), and the decision inside it (decideBranchLink), which trusts
// only what it can check again there.
import { stat } from 'node:fs/promises';
import { actorKey, canonical } from '../../core/collaboration.ts';
import type { Assignment, BranchLinkOutcome, Submission, Task, TaskGitBranch } from '../../core/collaboration-types.ts';
import type { PluginPrepare } from '../../core/plugin.ts';
import { gitRead, representativeWorktree, sameRepositoryPath, worktreeList } from '../../core/projects.ts';
import type { Store } from '../../core/store.ts';
import { completionValid, resolveTaskRef } from './model.ts';
import { collaborationRecords, collaborationTask } from './store.ts';

/** The whole lookup's time, waiting for a slot included: past it the submit goes on without a link and git is killed. */
export const BRANCH_LOOKUP_BUDGET_MS = 1500;
/** Lookups that may run at once; a submit that gets no slot within its budget goes on unlinked (reason busy). */
export const MAX_CONCURRENT_LOOKUPS = 4;
/** Branch names a result lists when several branches point at the commit, and their total length. */
const MAX_BRANCH_CANDIDATES = 5;
const MAX_CANDIDATE_CHARS = 2048;

type Reason = NonNullable<BranchLinkOutcome['reason']>;
export type GitRunner = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;
let run: GitRunner = gitRead;
let budget = BRANCH_LOOKUP_BUDGET_MS;
/** Tests replace the git runner and the budget; no argument restores both. */
export function setBranchLookup(options: { runner?: GitRunner; budgetMs?: number } = {}): void {
  run = options.runner ?? gitRead;
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

/** What the lookup read, and for which submit; the decision checks the first five against what it reads in the transaction. */
interface BranchFacts {
  kind: 'branch-facts';
  taskId: string; memberId: string; commitSha: string;
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
}

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

async function readFacts(base: BranchFacts, signal: AbortSignal): Promise<BranchFacts> {
  const git = (cwd: string, ...args: string[]) => {
    if (signal.aborted) throw new Stop('timeout');
    return run(cwd, args, signal);
  };
  /**
   * `rev-parse --verify --quiet` answered "no such object": exit 1 and nothing printed. It says so for an unknown,
   * ambiguous or non-commit sha, a missing ref, and an object missing from a partial clone (lazy fetch is off). Any other
   * end (128 outside a repository, a signal, a spawn error) is a failed query, not an answer.
   */
  const notFound = (error: unknown) => !signal.aborted && exitCode(error) === 1 && !String((error as { stdout?: unknown }).stdout ?? '').trim();
  /** The full commit for the submitted (maybe abbreviated) sha; null when git says there is none (or a ref of that name answered). */
  const commit = async (cwd: string): Promise<string | null> => {
    try {
      const full = (await git(cwd, 'rev-parse', '--verify', '--quiet', `${base.commitSha}^{commit}`)).trim().toLowerCase();
      return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(full) && full.startsWith(base.commitSha) ? full : null;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  };
  /** Whether the branch (refs/heads/ only, never a tag of that name) exists and contains the commit. */
  const contains = async (cwd: string, full: string | null, branch: string): Promise<boolean> => {
    if (!full || !usableBranch(branch)) return false;
    try { await git(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); }
    catch (error) { if (notFound(error)) return false; throw error; }
    // Both sides exist now, so only exit 1 means "not an ancestor"; 128 and the rest are failures.
    try { await git(cwd, 'merge-base', '--is-ancestor', full, `refs/heads/${branch}`); return true; }
    catch (error) { if (!signal.aborted && exitCode(error) === 1) return false; throw error; }
  };
  /**
   * The repository git finds from `path` (its representative worktree, as links store it); null when git finds none.
   * shortcut: any exit code reads as "no repository" (128 is both "not a repository" and a damaged one): for a linked task
   * either way the link cannot be verified and stays; with no link none is made. Read stderr if the two ever need different answers.
   */
  const repositoryAt = async (path: string): Promise<string | null> => {
    try { return representativeWorktree(await git(path, ...worktreeList)); }
    catch (error) { if (typeof exitCode(error) === 'number' || error instanceof Error && error.message === 'no working tree') return null; throw error; }
  };
  // The repository: the task's linked one when it has a link (set_git_branch's order), else the executor's folder.
  const repositoryPath = base.link?.repositoryPath;
  try {
    if (base.link) {
      // The stored path must still be that repository: git also finds a repository upward from a plain directory, and
      // what it would answer from a parent repository is not about the link.
      if (!(await isDirectory(base.link.repositoryPath))) return { ...base, repositoryPath, error: 'no_repository' };
      const found = await repositoryAt(base.link.repositoryPath);
      if (!found || !sameRepositoryPath(found, base.link.repositoryPath)) return { ...base, repositoryPath, error: 'no_repository' };
      const full = await commit(base.link.repositoryPath);
      // A manual link is never changed: only whether its branch has the commit.
      if (!base.link.automatic) return { ...base, repositoryPath, linkContains: await contains(base.link.repositoryPath, full, base.link.branch) };
      return await tipsAndLink(base.link.repositoryPath, base.link.repositoryPath, full);
    }
    // No link: whatever repository git finds from the executor's folder (a subdirectory or a linked worktree included).
    if (!base.cwd || !(await isDirectory(base.cwd))) return { ...base, error: 'no_repository' };
    const folderRepository = await repositoryAt(base.cwd);
    if (!folderRepository) return { ...base, error: 'no_repository' };
    return await tipsAndLink(base.cwd, folderRepository, await commit(base.cwd));
  } catch (error) {
    return { ...base, repositoryPath, error: reasonOf(error, signal) };
  }

  /** The branches at the commit in `cwd` (its repository is `path`), and whether an automatic link there still holds it. */
  async function tipsAndLink(cwd: string, path: string, full: string | null): Promise<BranchFacts> {
    if (!full) return { ...base, repositoryPath: path, names: [], unknownCommit: true };
    // --points-at keeps the listing to the branches at this commit, however many the repository has.
    const listed = await git(cwd, 'for-each-ref', `--points-at=${full}`, `--count=${MAX_BRANCH_CANDIDATES + 1}`, '--format=%(refname)', 'refs/heads/');
    const names = listed.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.startsWith('refs/heads/'))
      .map((line) => line.slice('refs/heads/'.length));
    const facts: BranchFacts = { ...base, repositoryPath: path, names };
    if (base.link?.automatic && !(names.length === 1 && usableBranch(names[0]))) facts.linkContains = await contains(cwd, full, base.link.branch);
    return facts;
  }
}

/**
 * Only a submit that could succeed gets a lookup: the task's current executor with its active assignment, or the prior
 * executor resubmitting an invalidated completed result. The transaction stays the authority; this only keeps anyone
 * else from making the Hub start git.
 */
function couldSubmit(store: Store, task: Task, actorId: string, assignmentId: unknown): boolean {
  const assignments = collaborationRecords<Assignment>(store, task.id, 'assignment');
  if (task.status === 'working' || task.status === 'review') {
    const current = assignments.find((a) => a.id === task.currentAssignmentId);
    return !!current && !current.endedAt && current.memberId === actorId && task.assignedMemberId === actorId && assignmentId === current.id;
  }
  if (task.status !== 'completed' || completionValid(store, task)) return false;
  const approved = collaborationRecords<Submission>(store, task.id, 'submission').find((s) => s.id === task.approvedSubmissionId);
  const prior = approved && assignments.find((a) => a.id === approved.assignmentId);
  const member = store.getMember(actorId);
  return !!prior && !!member && assignmentId === approved.assignmentId && prior.actorKey === actorKey(member);
}

/**
 * task.submit's `prepare`: what git says about the submitted commit, read before the transaction under one time budget.
 * Nothing for a submit without a valid commitSha, by someone who could not submit it, or for a task it cannot find.
 */
export const prepareSubmit: PluginPrepare = async ({ store, actor, actorId, clusterId, command }) => {
  if (actor.kind !== 'member' || typeof command.commitSha !== 'string' || !SHA.test(command.commitSha)) return undefined;
  const task = collaborationTask(store, clusterId, resolveTaskRef(store, clusterId, command.taskId as string));
  if (!task || !couldSubmit(store, task, actorId, command.assignmentId)) return undefined;
  const base: BranchFacts = { kind: 'branch-facts', taskId: task.id, memberId: actorId, commitSha: command.commitSha.toLowerCase(),
    cwd: store.getMember(actorId)?.cwd ?? null, link: task.gitBranch ? { ...task.gitBranch } : null,
    // A linked task is looked up in its linked repository, so even a lookup that times out or waits in vain names it.
    ...(task.gitBranch ? { repositoryPath: task.gitBranch.repositoryPath } : {}) };
  const controller = new AbortController();
  const slot = { held: false };
  let timer: NodeJS.Timeout | undefined;
  const work = (async (): Promise<BranchFacts> => {
    if (!(await acquire(controller.signal, slot))) return { ...base, error: 'busy' };
    return readFacts(base, controller.signal);
  })();
  // The budget covers waiting for a slot and git; a git that ignores the abort cannot hold the submit either.
  const late = new Promise<BranchFacts>((resolve) => {
    timer = setTimeout(() => { resolve({ ...base, error: slot.held ? 'timeout' : 'busy' }); controller.abort(); }, budget);
  });
  try { return await Promise.race([work, late]); }
  finally {
    // The timer's abort (the only one) already took a still-waiting request out of the queue; work that won holds its slot.
    clearTimeout(timer);
    if (slot.held) { slot.held = false; release(); }
  }
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
