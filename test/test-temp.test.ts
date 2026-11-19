// Test temp cleanup (scripts/test-temp.ts, desktop/test/temp-dir.mjs): the sweep's pure core, its guards on a real
// directory tree in a fake temp root, and tempDir()'s removal at process exit. Never touches the real temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasOwnName, KEEP_ENV, keepTestTemp, listEntries, pickStale, removeTestDir, selectTemp, sweep, SWEEP_AGE_MS, type Entry } from '../scripts/test-temp.ts';
import { cleanTemp } from '../scripts/clean-temp.ts';
import { tempDir, waitFor } from './helpers.ts';

const DESKTOP_TEST = join(import.meta.dirname, '..', 'desktop', 'test');
const { removeCheckTempDir } = await import(pathToFileURL(join(DESKTOP_TEST, 'temp-dir.mjs')).href);

const NOW = 1_800_000_000_000;
const OLD = NOW - SWEEP_AGE_MS - 1;

test('pickStale: only old directories directly under the root with the exact prefix', () => {
  const entries: Entry[] = [
    { name: 'orrery-test-old', type: 'dir', mtimeMs: OLD },
    { name: 'orrery-test-named-abcdef', type: 'dir', mtimeMs: OLD },   // extra hyphens: still the prefix
    { name: 'orrery-test-edge', type: 'dir', mtimeMs: NOW - SWEEP_AGE_MS },
    { name: 'orrery-test-fresh', type: 'dir', mtimeMs: NOW - SWEEP_AGE_MS + 1 },
    { name: 'orrery-test-file', type: 'file', mtimeMs: OLD },
    { name: 'orrery-test-link', type: 'link', mtimeMs: OLD },
    { name: 'orrery-test-other', type: 'other', mtimeMs: OLD },
    { name: 'orrery-test-', type: 'dir', mtimeMs: OLD },            // the bare prefix
    { name: 'orrery-desktop-x', type: 'dir', mtimeMs: OLD },        // another prefix
    { name: 'ORRERY-TEST-upper', type: 'dir', mtimeMs: OLD },       // not the exact prefix
    { name: 'x-orrery-test-y', type: 'dir', mtimeMs: OLD },
    { name: 'sub/orrery-test-nested', type: 'dir', mtimeMs: OLD },  // never a direct child
    { name: 'sub\\orrery-test-nested', type: 'dir', mtimeMs: OLD },
  ];
  const root = join('fake', 'root');
  assert.deepEqual(pickStale(root, NOW, entries, { env: {} }), ['orrery-test-edge', 'orrery-test-named-abcdef', 'orrery-test-old'].map((n) => join(root, n)));
  assert.deepEqual(pickStale(root, NOW, entries, { env: {}, maxAgeMs: 0 }).length, 4, 'clean:temp: any age, still only real matches');
  assert.deepEqual(pickStale(root, NOW, entries, { env: { [KEEP_ENV]: '1' } }), [], 'the opt-out keeps everything');
  assert.deepEqual(pickStale(root, NOW, entries, { env: {}, prefix: '' }), [], 'an empty prefix matches nothing');
  assert.equal(keepTestTemp({ [KEEP_ENV]: '0' }), false);
  assert.equal(keepTestTemp({ [KEEP_ENV]: '' }), false);
  assert.equal(keepTestTemp({ [KEEP_ENV]: 'yes' }), true);
  assert.equal(hasOwnName('..', '.'), false);
  const selection = selectTemp(NOW, [...entries, { name: 'orrery-sandbox', type: 'dir', mtimeMs: OLD }], { env: {} });
  assert.deepEqual(selection.delete, ['orrery-test-edge', 'orrery-test-named-abcdef', 'orrery-test-old']);
  assert.deepEqual(selection.fresh, ['orrery-test-fresh'], 'kept by the age rule');
  assert.deepEqual(Object.fromEntries(selection.kept), { 'orrery-test-': 1, 'orrery-desktop-': 1, 'orrery-sandbox': 1 }, 'everything else orrery-*, by prefix');
});

test('sweep on a real tree: deletes old matching directories only, never through links or into nested matches', () => {
  const root = join(tempDir(), 'temp');   // a fake temp root; the real temp folder is never swept here
  const OLD = Date.now() - SWEEP_AGE_MS - 60_000;
  const outside = join(root, '..', 'outside');
  mkdirSync(join(outside, 'orrery-test-victim'), { recursive: true });
  writeFileSync(join(outside, 'orrery-test-victim', 'keep.txt'), 'x');
  const dir = (name: string, old = true) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'test.db'), 'db');
    if (old) utimesSync(join(root, name), new Date(OLD), new Date(OLD));
  };
  dir('orrery-test-old');
  dir('orrery-test-fresh', false);
  dir('orrery-desktop-old');
  dir('keep/orrery-test-nested');
  utimesSync(join(root, 'keep'), new Date(OLD), new Date(OLD));
  writeFileSync(join(root, 'orrery-test-file'), 'x');
  utimesSync(join(root, 'orrery-test-file'), new Date(OLD), new Date(OLD));
  symlinkSync(join(outside, 'orrery-test-victim'), join(root, 'orrery-test-link'), 'junction');   // a junction on Windows

  const types = Object.fromEntries(listEntries(root).map((e) => [e.name, e.type]));
  assert.equal(types['orrery-test-link'], 'link', 'a junction is listed as a link, not a directory');
  const result = sweep(root, { now: Date.now(), env: {} });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.removed, [join(root, 'orrery-test-old')]);
  assert.deepEqual(readdirSync(root).sort(), ['keep', 'orrery-desktop-old', 'orrery-test-file', 'orrery-test-fresh', 'orrery-test-link']);
  assert.ok(existsSync(join(root, 'keep', 'orrery-test-nested', 'test.db')), 'a nested match stays');

  // Explicit (clean:temp): any age, but a link is still refused and its target untouched.
  assert.equal(removeTestDir(root, 'orrery-test-link'), 'refused');
  assert.equal(removeTestDir(root, 'orrery-test-file'), 'refused');
  assert.equal(removeTestDir(root, 'orrery-desktop-old'), 'refused');
  assert.equal(removeTestDir(root, '../outside/orrery-test-victim'), 'refused');
  assert.equal(removeTestDir(root, 'orrery-test-gone'), 'missing');
  assert.deepEqual(sweep(root, { now: Date.now(), maxAgeMs: 0, env: { [KEEP_ENV]: '1' } }).removed, [], 'the opt-out keeps everything');
  assert.deepEqual(sweep(root, { now: Date.now(), maxAgeMs: 0, env: {} }).removed, [join(root, 'orrery-test-fresh')]);
  assert.ok(existsSync(join(outside, 'orrery-test-victim', 'keep.txt')), 'the link target is untouched');
  assert.ok(existsSync(join(root, 'orrery-test-link')));
});

test('desktop checks: removeCheckTempDir has the same guard', () => {
  const root = join(tempDir(), 'temp');
  const outside = join(root, '..', 'outside');
  mkdirSync(join(root, 'orrery-desktop-strip-abc', 'shell'), { recursive: true });
  mkdirSync(join(root, 'nested', 'orrery-desktop-strip-def'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, 'orrery-desktop-strip-link'), 'junction');
  assert.equal(removeCheckTempDir(join(root, 'orrery-desktop-strip-link'), 'orrery-desktop-strip-', root), 'refused');
  assert.equal(removeCheckTempDir(join(root, 'nested', 'orrery-desktop-strip-def'), 'orrery-desktop-strip-', root), 'refused');
  assert.equal(removeCheckTempDir(join(root, 'orrery-desktop-strip-abc'), 'orrery-desktop-', root), 'removed');
  assert.equal(removeCheckTempDir(join(root, 'orrery-desktop-strip-abc'), 'orrery-desktop-', root), 'missing');
  assert.equal(removeCheckTempDir(join(root, 'nested'), 'nested', root), 'refused', 'only orrery- prefixes');
  assert.ok(existsSync(outside) && existsSync(join(root, 'nested', 'orrery-desktop-strip-def')));
});

test('desktop checks: the reaper deletes the directory once the owning process has exited', async () => {
  const root = join(tempDir(), 'temp');
  const dir = join(root, 'orrery-desktop-strip-xyz');
  mkdirSync(join(dir, 'shell'), { recursive: true });
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'ignore', windowsHide: true });
  const reaper = spawn(process.execPath, [join(DESKTOP_TEST, 'temp-reaper.mjs'), String(owner.pid), dir, 'orrery-desktop-strip-'],
    { stdio: 'ignore', windowsHide: true, env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(existsSync(dir), 'kept while the owner runs');
  await waitFor(() => !existsSync(dir), 'the reaper to delete the directory', 10_000);
  await waitFor(() => reaper.exitCode !== null, 'the reaper to exit', 10_000);
});

/** Runs a tiny node:test file with TEMP/TMP pointed at `root` and returns its exit status. */
function runTiny(root: string, body: string, env: Record<string, string> = {}): number | null {
  const file = join(root, '..', `tiny-${Math.random().toString(36).slice(2)}.test.mjs`);
  writeFileSync(file, `import { test } from 'node:test';\nimport { startTestHub, tempDir } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'helpers.ts')).href)};\n${body}\n`);
  // Without NODE_TEST_CONTEXT, which would make the inner runner report to this one instead of running on its own.
  const { NODE_TEST_CONTEXT: _, ...outer } = process.env;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=dot', file], {
    stdio: 'ignore', windowsHide: true, timeout: 60_000,
    env: { ...outer, TEMP: root, TMP: root, TMPDIR: root, [KEEP_ENV]: '', ...env },
  });
  return run.status;
}

test('tempDir: a test process removes its directories when it exits, a failing one too, unless the opt-out is set', () => {
  const root = join(tempDir(), 'temp');
  mkdirSync(root);
  const body = `test('t', async () => { tempDir(); writeFile(); const app = await startTestHub(); await app.close(); });`;
  const withWrite = `import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst writeFile = () => writeFileSync(join(tempDir(), 'x.txt'), 'x');\n`;
  assert.equal(runTiny(root, withWrite + body), 0);
  assert.deepEqual(readdirSync(root), [], 'nothing left after a passing run');

  assert.equal(runTiny(root, withWrite + body.replace('await app.close(); }', 'await app.close(); throw new Error("fails"); }')), 1, 'the exit code is unchanged');
  assert.deepEqual(readdirSync(root), [], 'nothing left after a failing run');

  assert.equal(runTiny(root, withWrite + body, { [KEEP_ENV]: '1' }), 0);
  // Four: the two tempDir() calls, startTestHub's directory, and the private registry helpers.ts makes for the process.
  assert.equal(readdirSync(root).filter((name) => name.startsWith('orrery-test-')).length, 4, 'kept with the opt-out');
});

/** A fake temp root with old and fresh test directories (one with extra hyphens), another prefix and a lock file. */
function cleanTree() {
  const root = join(tempDir(), 'temp');
  const OLD = Date.now() - SWEEP_AGE_MS - 60_000;
  for (const name of ['orrery-test-old111', 'orrery-test-named-abcdef', 'orrery-test-fresh1', 'orrery-test-fresh2', 'orrery-desktop-strip-abc']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'test.db'), 'db');
    if (!name.includes('fresh')) utimesSync(join(root, name), new Date(OLD), new Date(OLD));
  }
  return root;
}

test('clean:temp: by default the age rule applies, and the preview is exactly what is deleted', () => {
  const root = cleanTree();
  const lines: string[] = [];
  const dry = cleanTemp({ root, argv: ['--dry-run'], log: (line) => lines.push(line) });
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.selection!.delete, ['orrery-test-named-abcdef', 'orrery-test-old111']);
  assert.ok(lines.some((l) => l.trim() === 'orrery-test-named-abcdef'), 'a name with extra hyphens is listed for deletion');
  assert.ok(lines.some((l) => /orrery-test-\*\s+2\s+newer than 2h/.test(l)), 'fresh ones are shown as kept');
  assert.ok(lines.some((l) => /orrery-desktop-strip-\*\s+1$/.test(l)));
  assert.equal(readdirSync(root).length, 5, 'a dry run deletes nothing');

  const real = cleanTemp({ root, argv: [], log: () => {} });
  assert.deepEqual(real.selection!.delete, dry.selection!.delete);
  assert.deepEqual(real.result!.removed, dry.selection!.delete.map((name) => join(root, name)), 'removed is exactly the preview');
  assert.deepEqual(readdirSync(root).sort(), ['orrery-desktop-strip-abc', 'orrery-test-fresh1', 'orrery-test-fresh2']);
});

test('clean:temp: an unknown argument (the removed --all included) is a usage error and deletes nothing', () => {
  const root = cleanTree();
  const lines: string[] = [];
  for (const argv of [['--all'], ['--dry-run', '--all'], ['--force']]) {
    const refused = cleanTemp({ root, argv, log: (line) => lines.push(line) });
    assert.equal(refused.code, 2);
    assert.equal(refused.selection, null);
  }
  assert.match(lines[0], /unknown argument --all; usage: npm run clean:temp \[-- --dry-run\]/);
  assert.equal(readdirSync(root).length, 5, 'nothing deleted');
});
