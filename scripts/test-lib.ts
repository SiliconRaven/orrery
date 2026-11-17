// Pure helpers for scripts/test.mjs, kept in TypeScript so tsc and node --test can check them.

/** Local-time name for a log file: YYYYMMDD-HHmmss.log. */
export function logName(date = new Date()): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-`
    + `${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}.log`;
}

/** Keep only the newest `keep` logs (file names sort by time). Returns the kept names. */
export function pruneLogs(directory: string, keep = 20): string[] {
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory).filter((name) => name.endsWith('.log')).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) rmSync(join(directory, name), { force: true });
  return names.slice(Math.max(0, names.length - keep));
}

/** Parse the node --test spec summary lines; missing numbers become null. */
export function parseSummary(text: string): { tests: number | null; pass: number | null; fail: number | null; skipped: number | null } {
  const number = (label: string) => {
    const match = new RegExp(`ℹ ${label} (\\d+)`).exec(text);
    return match ? Number(match[1]) : null;
  };
  return { tests: number('tests'), pass: number('pass'), fail: number('fail'), skipped: number('skipped') };
}

const CONCURRENCY_ENV = 'ORRERY_TEST_CONCURRENCY';

/** `--test-concurrency=N` when ORRERY_TEST_CONCURRENCY asks for it; unset or empty keeps node's default (CPUs − 1). */
export function concurrencyArgs(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[CONCURRENCY_ENV];
  if (raw === undefined || raw === '') return [];
  if (!/^[1-9]\d{0,2}$/.test(raw)) throw new Error(`${CONCURRENCY_ENV} must be a whole number from 1 to 999, got ${JSON.stringify(raw)}`);
  return [`--test-concurrency=${raw}`];
}

const TEST_TIMEOUT_ENV = 'ORRERY_TEST_TIMEOUT_MS';

/**
 * `--test-timeout=N` when ORRERY_TEST_TIMEOUT_MS asks for it (CI): a hung test becomes one named failure. Unset or
 * empty: no per-test limit. Not with --test-force-exit: on Windows it sometimes crashed a test file at exit with a
 * libuv assertion (UV_HANDLE_CLOSING in async.c), so a hung test that leaves handles open still keeps its file alive.
 */
export function timeoutArgs(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[TEST_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return [];
  if (!/^\d+$/.test(raw) || Number(raw) < 1000 || Number(raw) > 3_600_000) throw new Error(`${TEST_TIMEOUT_ENV} must be milliseconds from 1000 to 3600000, got ${JSON.stringify(raw)}`);
  return [`--test-timeout=${raw}`];
}

/** Parent tests a killed spec log opened (▶) but never closed with a result, outermost first. */
export function openTests(lines: string[]): string[] {
  const open: { indent: number; name: string }[] = [];
  for (const line of lines) {
    const m = /^(\s*)(▶|✔|✖|﹣) (.*?)(?: \([\d.]+ms\))?(?: # .*)?$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    if (m[2] === '▶') { open.push({ indent, name: m[3] }); continue; }
    const at = open.findLastIndex((o) => o.indent === indent && o.name === m[3]);
    if (at >= 0) open.splice(at, 1);
  }
  return open.map((o) => o.name);
}

/**
 * The failures in one spec log. A finished run has a "✖ failing tests:" section with each name and its error;
 * a run that was killed has none, so only the names of the ✖ lines written so far can be given.
 */
export function failureReport(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const section = lines.findIndex((line) => line.startsWith('✖ failing tests:'));
  if (section >= 0) return lines.slice(section);
  const failed = lines.filter((line) => line.trimStart().startsWith('✖ '));
  const open = openTests(lines);
  if (!failed.length && !open.length) return [];
  return [
    '(the run did not finish: names only, the errors are written at the end of a run)',
    ...failed,
    ...(open.length ? [`still running when the log ends: ${open.join(' > ')} (its next subtest, or a test in a later file)`] : []),
  ];
}

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
