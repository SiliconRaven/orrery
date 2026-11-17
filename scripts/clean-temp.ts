// npm run clean:temp [-- --dry-run]: deletes the orrery-test-* directories directly in the system temp folder that
// are older than 2 hours, like the sweep at the start of npm test, so a running test's fresh directories stay. The
// preview and the deletion come from one selectTemp call, so what is listed is what is deleted. Same guards as the
// sweep (scripts/test-temp.ts): direct children with the exact prefix, real directories only, never links or reparse points.
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { listEntries, removeSelected, selectTemp, SWEEP_AGE_MS, TEST_TEMP_PREFIX, type Selection, type SweepResult } from './test-temp.ts';

/** How many names of the delete set are printed; the rest is counted. */
const SHOW_NAMES = 20;
const USAGE = 'usage: npm run clean:temp [-- --dry-run]';

export interface CleanResult { code: number; selection: Selection | null; result: SweepResult | null }

export function cleanTemp({ root = tmpdir(), argv = [] as string[], now = Date.now(), log = console.log as (line: string) => void } = {}): CleanResult {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length) {
    log(`unknown argument ${unknown.join(' ')}; ${USAGE}`);
    return { code: 2, selection: null, result: null };
  }
  const dryRun = argv.includes('--dry-run');
  // Run explicitly, ORRERY_KEEP_TEST_TEMP does not apply; the age rule does.
  const selection = selectTemp(now, listEntries(root), { maxAgeMs: SWEEP_AGE_MS, env: {} });
  const verb = dryRun ? 'would delete' : 'deleting';
  log(`${root}: ${verb} ${selection.delete.length} ${TEST_TEMP_PREFIX}* director${selection.delete.length === 1 ? 'y' : 'ies'} older than 2h`);
  for (const name of selection.delete.slice(0, SHOW_NAMES)) log(`  ${name}`);
  if (selection.delete.length > SHOW_NAMES) log(`  ... and ${selection.delete.length - SHOW_NAMES} more`);
  if (selection.fresh.length || selection.kept.size) log('kept:');
  if (selection.fresh.length) log(`  ${`${TEST_TEMP_PREFIX}*`.padEnd(32)} ${String(selection.fresh.length).padStart(7)}  newer than 2h (a test may be using them)`);
  for (const [prefix, count] of [...selection.kept].sort((a, b) => b[1] - a[1])) {
    log(`  ${`${prefix}*`.padEnd(32)} ${String(count).padStart(7)}`);
  }
  if (dryRun) return { code: 0, selection, result: null };
  const result = removeSelected(root, selection.delete);
  log(`deleted ${result.removed.length}${result.failed.length ? `, ${result.failed.length} could not be deleted (in use?)` : ''}`);
  return { code: 0, selection, result };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = cleanTemp({ argv: process.argv.slice(2) }).code;
}
