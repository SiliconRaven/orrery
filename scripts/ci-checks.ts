#!/usr/bin/env node
// Runs the checks .premerge/checks.json declares, in order, so CI runs exactly what ship runs before a merge.
// A check that exits non-zero gets one more run (like ship); one that only passed on the second run is printed
// as a GitHub Actions warning so a flaky test stays visible. A check that runs past its limit is not rerun:
// its whole process tree is killed, and the run stops once every process of that tree is gone.
// ORRERY_CHECK_TIMEOUT_SCALE multiplies every limit, for CI only; local merges keep the limits in the file.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Check { name: string; argv: string[]; timeout_seconds: number }
export type Outcome =
  | { kind: 'pass'; ms: number }
  | { kind: 'fail'; ms: number; code: number | null; error?: string }
  | { kind: 'timeout'; ms: number; leftover: number[]; listed: boolean };
export type RunOne = (check: Check, limitMs: number) => Promise<Outcome>;

export const SCALE_ENV = 'ORRERY_CHECK_TIMEOUT_SCALE';

export function parseChecks(text: string): Check[] {
  const checks = JSON.parse(text)?.checks;
  if (!Array.isArray(checks) || !checks.length || !checks.every((c) => typeof c?.name === 'string' && c.name
    && Array.isArray(c.argv) && c.argv.length && c.argv.every((a: unknown) => typeof a === 'string' && a)
    && typeof c.timeout_seconds === 'number' && c.timeout_seconds >= 1)) {
    throw new Error('.premerge/checks.json must hold a nonempty checks list of { name, argv, timeout_seconds }');
  }
  return checks;
}

/** The factor for every check's limit: unset or empty is 1; otherwise a number above 0 and at most 10. */
export function timeoutScale(env: Record<string, string | undefined> = process.env): number {
  const raw = env[SCALE_ENV];
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !(value > 0 && value <= 10)) throw new Error(`${SCALE_ENV} must be a number above 0 and at most 10, got ${JSON.stringify(raw)}`);
  return value;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Returns the process exit code: 0 when every check passed, at most on its second run. */
export async function runChecks(checks: Check[], runOne: RunOne, scale = 1, log: (line: string) => void = console.log): Promise<number> {
  for (const check of checks) {
    const limitMs = Math.round(check.timeout_seconds * scale * 1000);
    log(`== check ${check.name} (limit ${seconds(limitMs)}): ${check.argv.join(' ')}`);
    let outcome = await runOne(check, limitMs);
    if (outcome.kind === 'fail') {
      log(`== check ${check.name} ${failText(outcome)}; running it once more`);
      outcome = await runOne(check, limitMs);
      if (outcome.kind === 'pass') {
        log(`::warning::check ${check.name} failed once and passed on the second run`);
        continue;
      }
    }
    if (outcome.kind === 'pass') {
      log(`== check ${check.name} passed in ${seconds(outcome.ms)}`);
      continue;
    }
    if (outcome.kind === 'timeout') {
      const left = !outcome.listed
        ? "; its process tree could not be listed, so only the check's own process was killed and watched: child processes may still be running"
        : outcome.leftover.length ? `; processes still running after the kill: ${outcome.leftover.join(', ')}` : '; its process tree is gone';
      log(`::error::check ${check.name} timed out after ${seconds(outcome.ms)} (limit ${seconds(limitMs)}), not rerun${left}`);
    } else {
      log(`::error::check ${check.name} failed twice: ${failText(outcome)}`);
    }
    return 1;
  }
  return 0;
}

function failText(outcome: Extract<Outcome, { kind: 'fail' }>): string {
  return outcome.error ? `could not run (${outcome.error})` : `exited with code ${outcome.code} after ${seconds(outcome.ms)}`;
}

export interface ProcessRow { pid: number; parent: number; created: number }

/** The root and every process below it. A child must not be older than its parent, so a reused parent id is not followed. */
export function treeOf(rows: ProcessRow[], root: number): number[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!byPid.has(root)) return [root];
  const tree = [root];
  for (let i = 0; i < tree.length; i++) {
    const parent = byPid.get(tree[i])!;
    for (const row of rows) if (row.parent === parent.pid && row.pid !== parent.pid && row.created >= parent.created && !tree.includes(row.pid)) tree.push(row.pid);
  }
  return tree;
}

function windowsProcesses(): ProcessRow[] {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return (r.stdout ?? '').split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter((p) => p.length === 3 && p.every(Number.isFinite)).map(([pid, parent, created]) => ({ pid, parent, created }));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Of `pids`, the ones that are still the processes the snapshot recorded: running with the same creation time, so an
 * id Windows reused for a new process is not counted or killed. The root has no recorded time when the snapshot
 * failed; it is the check's own child, whose id cannot be reused while this process holds its handle. With no current
 * listing (`now` empty) nothing can be told apart, so every id is kept.
 */
export function sameProcesses(pids: number[], created: Map<number, number>, now: ProcessRow[], root: number): number[] {
  if (!now.length) return pids;
  const current = new Map(now.map((row) => [row.pid, row.created]));
  return pids.filter((pid) => current.has(pid) && (created.has(pid) ? current.get(pid) === created.get(pid) : pid === root));
}

export interface KillResult {
  /** Ids of the tree still running after the wait. */
  leftover: number[];
  /** Whether the tree could be listed; if not, only the root was killed and watched. */
  listed: boolean;
}

/** Kills the process tree of `root` and waits until it is gone. */
export async function killTree(root: number, waitMs = 60_000): Promise<KillResult> {
  if (process.platform !== 'win32') {
    try { process.kill(-root, 'SIGKILL'); } catch { /* the group is gone */ }
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      try { process.kill(-root, 0); } catch { return { leftover: [], listed: true }; }
      await sleep(200);
    }
    return { leftover: [root], listed: true };
  }
  const rows = windowsProcesses();
  const listed = rows.some((row) => row.pid === root);
  const tree = treeOf(rows, root);
  const created = new Map(rows.filter((row) => tree.includes(row.pid)).map((row) => [row.pid, row.created]));
  spawnSync('taskkill', ['/PID', String(root), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 60_000 });
  const end = Date.now() + waitMs;
  let left = tree.filter(alive);
  for (let tries = 0; left.length && Date.now() < end; tries++) {
    if (tries === 10) {
      left = sameProcesses(left, created, windowsProcesses(), root);   // never kill an id that now names another process
      for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ } }
    }
    await sleep(200);
    left = left.filter(alive);
  }
  if (left.length) left = sameProcesses(left, created, windowsProcesses(), root);
  return { leftover: left, listed };
}

export function spawnCheck(cwd: string): RunOne {
  return (check, limitMs) => new Promise((done) => {
    const started = Date.now();
    const child = spawn(check.argv[0], check.argv.slice(1), { cwd, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    child.on('error', (e) => { clearTimeout(timer); done({ kind: 'fail', ms: Date.now() - started, code: null, error: e.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!timedOut) done(code === 0 ? { kind: 'pass', ms: Date.now() - started } : { kind: 'fail', ms: Date.now() - started, code });
    });
    timer = setTimeout(() => {
      timedOut = true;
      const ms = Date.now() - started;
      killTree(child.pid!).then(({ leftover, listed }) => done({ kind: 'timeout', ms, leftover, listed }));
    }, limitMs);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..');
  const checks = parseChecks(readFileSync(join(root, '.premerge', 'checks.json'), 'utf8'));
  process.exitCode = await runChecks(checks, spawnCheck(root), timeoutScale());
}
