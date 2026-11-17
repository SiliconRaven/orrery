#!/usr/bin/env node
// ship: merge a reviewed commit into the target branch (docs/collaboration.md). Run by a member, with that member's own permissions,
// from any worktree of the repository, using the command the Hub handed over. It never imports the Hub: all it knows
// comes over HTTP, and the Hub takes the result only after checking it with read-only git (src/plugins/tasks/ship.ts).
// A file lock in the git common dir serializes ship runs. Exit 0 only when merged and, with an origin, pushed.
// `--release` reuses the same lock, merge and checks to merge the ship target branch into main without the Hub.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { acquireTestQueue, TestQueueTimeoutError, type TestQueueWaitInfo } from './test-queue.ts';

/** `takeover`: a self review by the member who took the task over from its review (docs/collaboration.md「验收者接手」). */
export interface Verified { taskId: string; shortId: string; commitSha: string; reviewer: string; round: number; verdict: 'pass' | 'self'; takeover?: boolean }
export type ShipReport = { mergeCommit: string; pushed: boolean; retried: string[] } | { failed: { kind: 'conflict' | 'checks'; detail: string } };
export interface HubClient {
  verify(): Promise<Verified>;
  report(result: ShipReport): Promise<void>;
}
export interface ShipOptions {
  agent: string; type: string; summary: string; trailers: string[];
  /** Any directory inside the repository. */
  cwd: string;
  lockWaitMs: number;
  hub: HubClient;
  log?: (line: string) => void;
}
export type ShipOutcome = { merged: true; mergeCommit: string; pushed: boolean; pushError?: string } | { merged: false; kind: 'conflict' | 'checks'; detail: string };

/** A refusal: nothing changed, the Hub is not told, the ticket stays valid. */
export class ShipRefused extends Error {}

const TYPES = new Set(['feat', 'fix', 'docs', 'refactor', 'test', 'chore']);
const DEFAULT_LOCK_WAIT_S = 1800;
const GIT_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 200;
const OUTPUT_TAIL = 4000;

const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[name];

function tryGit(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, status: r.status, out: r.stdout ?? '', err: (r.stderr || r.error?.message || '').trim() };
}

function git(cwd: string, ...args: string[]): string {
  const r = tryGit(cwd, ...args);
  if (!r.ok) throw new ShipRefused(`git ${args[0]} failed: ${r.err.slice(-1000)}`);
  return r.out.trim();
}

const dirty = (cwd: string) => git(cwd, 'status', '--porcelain', '--untracked-files=all') !== '';

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const validBranch = (cwd: string, name: string) => BRANCH_NAME.test(name) && tryGit(cwd, 'check-ref-format', `refs/heads/${name}`).ok;

/** The branch ship lands on: `git config orrery.shipBranch`, shared by the repository's worktrees; main when it is not set. */
export function targetBranch(cwd: string): string {
  const r = tryGit(cwd, 'config', '--get', 'orrery.shipBranch');
  if (r.status === 1) return 'main';   // not set; any other failure must not fall back to landing on main
  const name = r.out.trim();
  if (!r.ok || !validBranch(cwd, name)) {
    throw new ShipRefused(`git config orrery.shipBranch does not name a branch: ${r.ok ? JSON.stringify(name) : r.err.slice(-300)}`);
  }
  return name;
}

/** The working tree that has the branch checked out, or null. */
function worktreeOf(cwd: string, branch: string): string | null {
  for (const record of git(cwd, 'worktree', 'list', '--porcelain', '-z').split('\0\0')) {
    const fields = record.split('\0');
    if (fields.includes(`branch refs/heads/${branch}`)) return fields[0].slice('worktree '.length);
  }
  return null;
}

/** The working tree that has the branch checked out. */
export function branchWorktree(cwd: string, branch: string): string {
  const tree = worktreeOf(cwd, branch);
  if (tree === null) throw new ShipRefused(`no working tree has ${branch} checked out`);
  return tree;
}

/**
 * Waits for the lock file, taking over from a dead holder, and returns the release function. The file lock of the
 * full-test queue is the same problem: one holder at a time, and one waiter at a time clears a dead holder's lock.
 */
export async function acquireLock(path: string, waitMs: number, log: (line: string) => void = () => {}): Promise<() => void> {
  let holder: TestQueueWaitInfo | undefined;
  const who = () => (holder ? `held by pid ${holder.pid} since ${new Date(holder.startedAt).toISOString()}` : 'holder unknown');
  try {
    const { release } = await acquireTestQueue({ lockPath: path, timeoutMs: waitMs, pollMs: LOCK_POLL_MS, onWait: (h) => {
      holder = h;
      log(`waiting for the ship lock (${who()})`);
    } });
    return release;
  } catch (e) {
    if (e instanceof TestQueueTimeoutError) throw new ShipRefused(`timed out waiting for the ship lock (${who()})`);
    throw e;
  }
}

export function buildMessage(o: Pick<ShipOptions, 'agent' | 'type' | 'summary' | 'trailers'>, v: Verified): string {
  const reviewer = v.reviewer.replace(/[\x00-\x1f\x7f]+/g, ' ');
  return [`[${o.agent}] ${o.type}: ${o.summary}`, '',
    `Reviewed-by: ${reviewer} (task ${v.shortId}, r${v.round}, ${v.verdict}, ${v.commitSha.slice(0, 7)}${v.takeover === true ? ', reviewer takeover' : ''})`, ...o.trailers].join('\n');
}

/** True when every changed path is documentation; renames count as both their paths. */
export function docsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => p.startsWith('docs/') || p.endsWith('.md'));
}

interface Check { name: string; argv: string[]; timeout_seconds: number }

/** The check list as the target branch has it: a branch under review must not be able to weaken its own checks. */
export function loadChecks(cwd: string, commit: string): Check[] {
  const relative = '.premerge/checks.json';
  const shown = tryGit(cwd, 'show', `${commit}:${relative}`);
  if (!shown.ok) throw new ShipRefused(`the target branch has no ${relative}`);
  let checks: unknown;
  try { checks = JSON.parse(shown.out)?.checks; } catch { throw new ShipRefused(`${relative} on the target branch is not valid JSON`); }
  if (!Array.isArray(checks) || !checks.length || !checks.every((c) => typeof c?.name === 'string' && c.name
    && Array.isArray(c.argv) && c.argv.length && c.argv.every((a: unknown) => typeof a === 'string' && a)
    && typeof c.timeout_seconds === 'number' && c.timeout_seconds >= 1 && c.timeout_seconds <= 3600)) {
    throw new ShipRefused(`${relative} on the target branch must hold a nonempty checks list of { name, argv, timeout_seconds }`);
  }
  return checks as Check[];
}

function killTree(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
  else try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

function runCheck(check: Check, cwd: string): Promise<{ ok: boolean; tail: string }> {
  return new Promise((done) => {
    const child = spawn(check.argv[0], check.argv.slice(1), { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let tail = '';
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid!); }, check.timeout_seconds * 1000);
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, tail: `could not start: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0 && !timedOut, tail: timedOut ? `timed out\n${tail}` : tail }); });
  });
}

/** Each check gets one automatic rerun; two failures in a row end the run. */
async function runChecks(checks: Check[], cwd: string, log: (line: string) => void): Promise<{ failed: string | null; retried: string[] }> {
  const retried: string[] = [];
  for (const check of checks) {
    let result = await runCheck(check, cwd);
    if (!result.ok) {
      log(`check ${check.name} failed; running it once more`);
      retried.push(check.name);
      result = await runCheck(check, cwd);
    }
    if (!result.ok) return { failed: `${check.name} failed twice:\n${result.tail}`, retried };
    log(`check ${check.name} passed`);
  }
  return { failed: null, retried };
}

function removeWorktree(root: string, path: string, log: (line: string) => void): void {
  try {
    tryGit(root, 'worktree', 'remove', '--force', path);
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    tryGit(root, 'worktree', 'prune');
  } catch (e) { log(`could not remove the temporary worktree ${path}: ${e instanceof Error ? e.message : String(e)}`); }
}

type Failed = { kind: 'conflict' | 'checks'; detail: string };
type Landed = { mergeCommit: string; retried: string[]; checksSkipped: boolean; target: string } | Failed;

interface MergeSpec {
  cwd: string; target: string;
  /** The worktree that has the target checked out, or null to move the ref directly. */
  tree: string | null;
  /** The target tip the merge is based on; landing is refused when the target no longer points here. */
  base: string;
  commit: string; message: string;
  /** Runs after the checks, right before landing. */
  beforeLand?: () => Promise<unknown>;
  log: (line: string) => void;
}

/** Merges with --no-ff in a temporary worktree, runs the target's checks there and fast-forwards the target. Call under the lock. */
async function mergeChecked(s: MergeSpec): Promise<Landed> {
  const { target, tree, base, log } = s;
  const ref = `refs/heads/${target}`;
  const at = tree ?? s.cwd;
  const temp = mkdtempSync(join(tmpdir(), 'orrery-ship-'));
  try {
    git(at, 'worktree', 'add', '--detach', temp, base);
    const merge = tryGit(temp, 'merge', '--no-ff', '-m', s.message, s.commit);
    if (!merge.ok) {
      const conflicts = git(temp, 'diff', '--name-only', '--diff-filter=U');
      if (!conflicts) throw new ShipRefused(`git merge failed: ${merge.err.slice(-1000)}`);
      return { kind: 'conflict', detail: `conflicting files:\n${conflicts}` };
    }
    const mergeCommit = git(temp, 'rev-parse', 'HEAD');
    const changed = git(temp, 'diff', '--name-only', '--no-renames', '-z', base, mergeCommit).split('\0').filter(Boolean);
    let retried: string[] = [];
    const checksSkipped = docsOnly(changed);
    if (checksSkipped) log('only documentation changed: skipping the checks');
    else {
      const result = await runChecks(loadChecks(s.cwd, base), temp, log);
      retried = result.retried;
      if (result.failed) return { kind: 'checks', detail: result.failed };
    }
    await s.beforeLand?.();
    if (git(at, 'rev-parse', ref) !== base) throw new ShipRefused(`${target} moved while the checks were running: run ship again`);
    if (tree) {
      if (tryGit(tree, 'symbolic-ref', '-q', 'HEAD').out.trim() !== ref) throw new ShipRefused(`the ${target} worktree ${tree} no longer has ${target} checked out`);
      if (dirty(tree)) throw new ShipRefused(`the ${target} worktree ${tree} got uncommitted changes while the checks were running`);
      git(tree, 'merge', '--ff-only', mergeCommit);
    } else {
      if (worktreeOf(s.cwd, target) !== null) throw new ShipRefused(`${target} got checked out while the checks were running: run ship again`);
      git(s.cwd, 'update-ref', ref, mergeCommit, base);   // refuses when the ref is no longer base
    }
    return { mergeCommit, retried, checksSkipped, target };
  } finally {
    removeWorktree(at, temp, log);
  }
}

async function underLock<T>(cwd: string, waitMs: number, log: (line: string) => void, run: () => Promise<T>): Promise<T> {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const release = await acquireLock(join(common, 'ship.lock'), waitMs, log);
  try {
    return await run();
  } finally {
    release();
  }
}

/** Pushes the branch to origin without force; null when there is no origin. */
function pushToOrigin(cwd: string, branch: string): { pushed: boolean; pushError?: string } | null {
  if (!tryGit(cwd, 'remote', 'get-url', 'origin').ok) return null;
  const push = tryGit(cwd, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  return push.ok ? { pushed: true } : { pushed: false, pushError: push.err.slice(-1000) || 'git push failed' };
}

async function mergeUnderLock(o: ShipOptions, v: Verified, log: (line: string) => void): Promise<Landed> {
  const target = targetBranch(o.cwd);
  const ref = `refs/heads/${target}`;
  const tree = branchWorktree(o.cwd, target);
  if (dirty(tree)) throw new ShipRefused(`the ${target} worktree ${tree} has uncommitted changes`);
  const commit = tryGit(o.cwd, 'rev-parse', '--verify', '--end-of-options', `${v.commitSha}^{commit}`);
  if (!commit.ok) throw new ShipRefused(`reviewed commit ${v.commitSha} is not in this repository`);
  const sha = commit.out.trim();
  const branches = git(o.cwd, 'for-each-ref', '--points-at', sha, '--format=%(refname)', 'refs/heads').split('\n').filter((name) => name && name !== ref);
  if (!branches.length) throw new ShipRefused(`no local branch points at the reviewed commit ${sha.slice(0, 7)}: the branch moved on after review, or it was never fetched here`);
  const base = git(tree, 'rev-parse', ref);
  if (tryGit(o.cwd, 'merge-base', '--is-ancestor', sha, base).ok) throw new ShipRefused(`commit ${sha.slice(0, 7)} is already on ${target}`);
  return mergeChecked({ cwd: o.cwd, target, tree, base, commit: sha, message: buildMessage(o, v), log,
    beforeLand: () => o.hub.verify() });   // the checks can take long enough for the task to be reopened or cancelled
}

export async function ship(o: ShipOptions): Promise<ShipOutcome> {
  const log = o.log ?? (() => {});
  await o.hub.verify();
  // Again under the lock: waiting may have taken long enough for the task to change.
  const landed = await underLock(o.cwd, o.lockWaitMs, log, async () => mergeUnderLock(o, await o.hub.verify(), log));
  if ('kind' in landed) {
    await o.hub.report({ failed: landed });
    return { merged: false, ...landed };
  }
  let pushed = false;
  let pushError: string | undefined;
  // Only a landing on main is pushed: any other target is an integration branch, pushed when someone asks for it.
  if (landed.target === 'main') ({ pushed, pushError } = pushToOrigin(o.cwd, 'main') ?? { pushed: false });
  try {
    await o.hub.report({ mergeCommit: landed.mergeCommit, pushed, retried: landed.retried });
  } catch (e) {
    throw new Error(`${landed.mergeCommit} is on ${landed.target}${pushed ? ' and pushed' : ''}, but the Hub did not record it (${e instanceof Error ? e.message : String(e)}); record it with task_action merge`);
  }
  return { merged: true, mergeCommit: landed.mergeCommit, pushed, ...(pushError ? { pushError } : {}) };
}

export interface ReleaseOptions {
  agent: string; summary: string; trailers: string[];
  cwd: string; lockWaitMs: number;
  /** Defaults to the ship target branch. */
  from?: string;
  /** Defaults to main. */
  into?: string;
  push: boolean;
  log?: (line: string) => void;
}
export type ReleaseOutcome = {
  merged: true; mergeCommit: string; source: string; target: string; checksSkipped: boolean; retried: string[];
  push: 'pushed' | 'failed' | 'disabled' | 'no origin' | 'not main'; pushError?: string;
  /** Why the source branch was not fast-forwarded to the release commit; absent when it was. */
  syncNote?: string;
} | ({ merged: false } & Failed);

/** Every `Reviewed-by:` line in the commits being released, oldest first, each once. */
export function reviewedByLines(cwd: string, base: string, tip: string): string[] {
  const lines = git(cwd, 'log', '--topo-order', '--reverse', '--format=%B', `${base}..${tip}`).split('\n').map((line) => line.trimEnd());
  return [...new Set(lines.filter((line) => /^Reviewed-by: \S/.test(line)))];
}

/** Fast-forwards the source to the release commit when that is safe; returns why not otherwise. Call under the lock. */
function syncSource(cwd: string, source: string, mergeCommit: string): string | undefined {
  const ref = `refs/heads/${source}`;
  try {
    const now = git(cwd, 'rev-parse', ref);
    if (!tryGit(cwd, 'merge-base', '--is-ancestor', now, mergeCommit).ok) return `${source} moved on after the merge`;
    const tree = worktreeOf(cwd, source);
    if (tree === null) git(cwd, 'update-ref', ref, mergeCommit, now);
    else if (dirty(tree)) return `the ${source} worktree ${tree} has uncommitted changes`;
    else git(tree, 'merge', '--ff-only', mergeCommit);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Merges the source branch (the ship target, develop here) into the release branch (main) under the ship lock, without the Hub. */
export async function release(o: ReleaseOptions): Promise<ReleaseOutcome> {
  const log = o.log ?? (() => {});
  const source = o.from ?? targetBranch(o.cwd);
  const target = o.into ?? 'main';
  for (const name of [source, target]) if (!validBranch(o.cwd, name)) throw new ShipRefused(`not a branch name: ${JSON.stringify(name)}`);
  if (source === target) throw new ShipRefused(`nothing to release: the source and the target are both ${target}`);
  const result = await underLock(o.cwd, o.lockWaitMs, log, async () => {
    const tip = (name: string) => {
      const r = tryGit(o.cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`);
      if (!r.ok) throw new ShipRefused(`there is no branch ${name}`);
      return r.out.trim();
    };
    const sourceSha = tip(source), base = tip(target);
    if (tryGit(o.cwd, 'merge-base', '--is-ancestor', sourceSha, base).ok) throw new ShipRefused(`nothing to release: ${target} already contains ${source}`);
    const tree = worktreeOf(o.cwd, target);
    if (tree && dirty(tree)) throw new ShipRefused(`the ${target} worktree ${tree} has uncommitted changes`);
    const message = [`[${o.agent}] chore: ${o.summary}`, '', ...reviewedByLines(o.cwd, base, sourceSha), ...o.trailers].join('\n').trimEnd();
    const landed = await mergeChecked({ cwd: o.cwd, target, tree, base, commit: sourceSha, message, log });
    if ('kind' in landed) return landed;
    return { ...landed, syncNote: syncSource(o.cwd, source, landed.mergeCommit) };
  });
  if ('kind' in result) return { merged: false, ...result };
  // As with ship, only main is pushed automatically: any other target is pushed when someone asks for it.
  const pushed = o.push && target === 'main' ? pushToOrigin(o.cwd, target) : null;
  const push = !o.push ? 'disabled' : target !== 'main' ? 'not main' : !pushed ? 'no origin' : pushed.pushed ? 'pushed' : 'failed';
  return { merged: true, mergeCommit: result.mergeCommit, source, target, checksSkipped: result.checksSkipped, retried: result.retried, push,
    ...(pushed?.pushError ? { pushError: pushed.pushError } : {}), ...(result.syncNote ? { syncNote: result.syncNote } : {}) };
}

/** The Hub, over the loopback HTTP routes in src/plugins/tasks/routes.ts. */
export function httpHub(hubUrl: string, ticket: string): HubClient {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(hubUrl)) throw new ShipRefused(`--hub must be a loopback Hub address: ${hubUrl}`);
  const post = async (route: string, body: object) => {
    const res = await fetch(`${hubUrl}/bridge/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, ...body }) });
    const data = await res.json() as { error?: string };
    if (!res.ok) throw new ShipRefused(`the Hub refused: ${data.error ?? res.status}`);
    return data;
  };
  return { verify: () => post('ship-verify', {}) as Promise<Verified>, report: async (result) => { await post('ship-result', result); } };
}

/** The command line, validated: Hub-issued placeholders that were not filled in fail here. */
export function parseCommandLine(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    ticket: { type: 'string' }, hub: { type: 'string' }, agent: { type: 'string' }, type: { type: 'string' }, summary: { type: 'string' },
    trailer: { type: 'string', multiple: true }, 'lock-wait': { type: 'string' },
    release: { type: 'boolean' }, 'user-approved': { type: 'boolean' }, from: { type: 'string' }, into: { type: 'string' }, 'no-push': { type: 'boolean' },
  } });
  const { ticket, hub, agent, type, summary, trailer: trailers = [], from, into } = values;
  if (values.release) {
    if (ticket !== undefined || hub !== undefined) throw new ShipRefused('--release does not talk to the Hub: leave out --ticket and --hub');
    if (type !== undefined) throw new ShipRefused('--release always commits as chore: leave out --type');
    // A speed bump, not a security control: whoever can run this can also add the flag or merge with git by hand.
    // It makes the agent state, in its own command, that the user asked for this release.
    if (!values['user-approved']) throw new ShipRefused('--release needs --user-approved: a release happens only when the user explicitly asked for one');
    for (const name of [from, into]) if (name !== undefined && !BRANCH_NAME.test(name)) throw new ShipRefused(`--from and --into must name branches: ${name}`);
  } else {
    if (values['user-approved'] || from !== undefined || into !== undefined || values['no-push']) throw new ShipRefused('--user-approved, --from, --into and --no-push only go with --release');
    if (!ticket || !hub) throw new ShipRefused('--ticket and --hub are required');
  }
  if (!agent || !/^[a-z0-9][a-z0-9/_.-]{0,63}$/.test(agent)) throw new ShipRefused('--agent must be a lowercase short name such as claude-code or claude-code/topic');
  if (!values.release && (!type || !TYPES.has(type))) throw new ShipRefused(`--type must be one of ${[...TYPES].join(', ')}`);
  if (!summary || summary.length > 120 || /[^\x20-\x7e]/.test(summary) || /<.*>/.test(summary)) throw new ShipRefused('--summary must be one line of English (ASCII, at most 120 characters)');
  for (const t of trailers) if (!/^[A-Za-z][A-Za-z0-9-]*: \S/.test(t) || /[\r\n]/.test(t)) throw new ShipRefused(`--trailer must look like "Key: value": ${t}`);
  const lockWait = Number(values['lock-wait'] ?? DEFAULT_LOCK_WAIT_S);
  if (!Number.isFinite(lockWait) || lockWait < 0) throw new ShipRefused('--lock-wait must be seconds');
  const lockWaitMs = lockWait * 1000;
  if (values.release) return { mode: 'release' as const, agent, summary, trailers, lockWaitMs, from, into, push: !values['no-push'] };
  return { mode: 'ship' as const, ticket: ticket!, hub: hub!, agent, type: type!, summary, trailers, lockWaitMs };
}

async function releaseMain(o: ReleaseOptions): Promise<number> {
  const out = await release(o);
  if (!out.merged) {
    o.log!(`not released (${out.kind}), ${o.into ?? 'main'} is untouched:\n${out.detail}`);
    return 1;
  }
  console.log([
    `released ${out.source} into ${out.target}: ${out.mergeCommit}`,
    `checks: ${out.checksSkipped ? 'skipped (only documentation changed)' : out.retried.length ? `passed, rerun once: ${out.retried.join(', ')}` : 'passed'}`,
    `push: ${{ pushed: 'pushed to origin', failed: 'merged locally, push failed', disabled: 'not pushed (--no-push)', 'no origin': 'not pushed (no origin remote)', 'not main': 'not pushed (only main is pushed automatically)' }[out.push]}`,
    `${out.source}: ${out.syncNote ? `not fast-forwarded (${out.syncNote})` : `fast-forwarded to ${out.mergeCommit}`}`,
  ].join('\n'));
  if (out.pushError) { o.log!(`merged locally, push failed; push ${out.target} by hand once origin is reachable:\n${out.pushError}`); return 1; }
  return 0;
}

async function main(): Promise<number> {
  const args = parseCommandLine(process.argv.slice(2));
  const log = (line: string) => console.error(`ship: ${line}`);
  if (args.mode === 'release') return releaseMain({ ...args, cwd: resolve('.'), log });
  const outcome = await ship({ ...args, cwd: resolve('.'), hub: httpHub(args.hub, args.ticket), log });
  if (!outcome.merged) {
    log(`not merged (${outcome.kind}); the task went back to its executor:\n${outcome.detail}`);
    return 1;
  }
  console.log(`merged ${outcome.mergeCommit}${outcome.pushed ? ' and pushed' : ''}`);
  if (outcome.pushError) { log(`the merge stays local; pushing it failed, the next ship pushes both:\n${outcome.pushError}`); return 1; }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(`ship: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
