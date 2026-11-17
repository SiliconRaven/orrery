#!/usr/bin/env node
// CI failure step: for every spec log under .tmp/test-logs (oldest first) prints the failing tests with their
// errors, then the last lines of the newest log. Prints only; nothing is uploaded.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { failureReport } from './test-lib.ts';

export function report(directory: string, tail = 100): string[] {
  const names = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.log')).sort() : [];
  if (!names.length) return ['no test log was written'];
  const out: string[] = [];
  for (const name of names) {
    const failures = failureReport(readFileSync(join(directory, name), 'utf8'));
    out.push(`== ${name}: ${failures.length ? 'failures' : 'no failed test recorded'}`, ...failures);
  }
  const newest = readFileSync(join(directory, names.at(-1)!), 'utf8').split(/\r?\n/);
  out.push(`== last ${tail} lines of ${names.at(-1)}`, ...(tail > 0 ? newest.slice(-tail) : []));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  console.log(report(join(resolve(import.meta.dirname, '..'), '.tmp', 'test-logs')).join('\n'));
}
