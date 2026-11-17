// ship --release: merging the ship target branch (develop) into main without the Hub (docs/collaboration.md#发布).
// Every git action happens in temporary repositories under the system temp directory; origin is a local bare repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseCommandLine, release, ShipRefused, type ReleaseOptions } from '../scripts/ship.ts';
import { tempDir } from './helpers.ts';

const SCRIPT = resolve(import.meta.dirname, '../scripts/ship.ts');
const KIMI = 'Reviewed-by: kimi (task aaaa1111, r1, pass, 1111111)';
const SOL = 'Reviewed-by: sol (task bbbb2222, r2, pass, 2222222)';

/**
 * main checked out in `root` and pushed to a bare origin; develop checked out in its own worktree, two commits ahead,
 * carrying Reviewed-by lines (one of them twice); orrery.shipBranch is develop.
 */
function repo(t: TestContext, code = 'require("fs").appendFileSync(process.argv[1], "x")', arg?: string) {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(dir, 'repo'), develop = join(dir, 'develop'), bare = join(dir, 'origin.git'), log = join(dir, 'runs.txt');
  mkdirSync(root);
  const gIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const g = (...args: string[]) => gIn(root, ...args);
  const write = (tree: string, file: string, content: string) => { mkdirSync(dirname(join(tree, file)), { recursive: true }); writeFileSync(join(tree, file), content); };
  const commit = (tree: string, message: string) => {
    const file = join(dir, 'message.txt');
    writeFileSync(file, message);
    gIn(tree, 'add', '-A');
    gIn(tree, 'commit', '-q', '-F', file);
    return gIn(tree, 'rev-parse', 'HEAD');
  };
  const checks = (body: string, argument: string) => JSON.stringify({ checks: [{ name: 'probe', argv: ['node', '-e', body, argument], timeout_seconds: 60 }] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'tester');
  g('config', 'user.email', 'tester@example.invalid');
  g('config', 'core.autocrlf', 'false');
  write(root, 'README.md', 'hello\n');
  write(root, '.premerge/checks.json', checks(code, arg ?? log));
  commit(root, 'base\n\nReviewed-by: old (task cccc3333, r1, pass, 3333333)\n');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
  g('remote', 'add', 'origin', bare);
  g('push', '-q', 'origin', 'main');
  g('branch', 'develop');
  g('worktree', 'add', '-q', develop, 'develop');
  g('config', 'orrery.shipBranch', 'develop');
  write(develop, 'one.txt', '1\n');
  commit(develop, `[a] feat: One\n\n${KIMI}\nCo-Authored-By: A <a@example.invalid>\n`);
  write(develop, 'two.txt', '2\n');
  commit(develop, `[b] fix: Two\n\n${SOL}\n${KIMI}\n`);
  const origin = () => execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8', windowsHide: true }).trim();
  const runs = () => existsSync(log) ? readFileSync(log, 'utf8').length : 0;
  return { dir, root, develop, bare, g, gIn, write, commit, checks, origin, runs };
}

const options = (cwd: string, extra: Partial<ReleaseOptions> = {}): ReleaseOptions => ({
  agent: 'claude-code', summary: 'Release develop', trailers: ['Co-Authored-By: Someone <someone@example.invalid>'], cwd, lockWaitMs: 5000, push: true, ...extra,
});
const refused = (pattern: RegExp) => (e: unknown) => e instanceof ShipRefused && pattern.test(e.message);
const noLeftovers = (r: ReturnType<typeof repo>) => {
  assert.equal(existsSync(join(r.root, '.git', 'ship.lock')), false, 'lock released');
  assert.equal(r.g('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 2, 'temporary worktree removed');
};
const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', windowsHide: true });
const releaseArgs = ['--release', '--user-approved', '--agent', 'claude-code', '--summary', 'Release develop'];

test('release merges develop into main with the collected Reviewed-by lines, pushes main and fast-forwards develop', async (t) => {
  const r = repo(t);
  const main = r.g('rev-parse', 'main'), tip = r.g('rev-parse', 'develop');
  const out = await release(options(r.develop));   // from any worktree of the repository
  assert.ok(out.merged);
  assert.equal(r.g('rev-parse', 'main'), out.mergeCommit);
  assert.equal(r.g('rev-parse', 'main^1'), main);
  assert.equal(r.g('rev-parse', 'main^2'), tip);
  assert.equal(r.g('log', '-1', '--format=%B', 'main'), `[claude-code] chore: Release develop\n\n${KIMI}\n${SOL}\nCo-Authored-By: Someone <someone@example.invalid>`,
    'Reviewed-by lines oldest first, each once, none from commits already on main, then the trailers');
  assert.deepEqual([out.source, out.target, out.push, out.checksSkipped, out.retried, out.syncNote], ['develop', 'main', 'pushed', false, [], undefined]);
  assert.equal(r.runs(), 1, 'checks ran once');
  assert.equal(r.origin(), out.mergeCommit, 'origin advanced');
  assert.equal(r.g('rev-parse', 'develop'), out.mergeCommit, 'develop fast-forwarded');
  assert.equal(r.gIn(r.develop, 'status', '--porcelain'), '', 'develop worktree clean and at the release commit');
  assert.equal(r.g('status', '--porcelain'), '');
  noLeftovers(r);
  await assert.rejects(release(options(r.root)), refused(/nothing to release: main already contains develop/), 'a second release has nothing to do');
});

test('the command line: --user-approved is required, --ticket and --hub are refused, ship-only and release-only flags do not mix', (t) => {
  const r = repo(t);
  const main = r.g('rev-parse', 'main');
  const missing = cli(r.root, '--release', '--agent', 'claude-code', '--summary', 'Release develop');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /only when the user explicitly asked for one/);
  const withTicket = cli(r.root, ...releaseArgs, '--ticket', 't');
  assert.equal(withTicket.status, 1);
  assert.match(withTicket.stderr, /does not talk to the Hub/);
  assert.equal(r.g('rev-parse', 'main'), main, 'nothing changed');
  assert.throws(() => parseCommandLine([...releaseArgs, '--hub', 'http://127.0.0.1:1']), ShipRefused);
  assert.throws(() => parseCommandLine([...releaseArgs, '--type', 'feat']), ShipRefused);
  assert.throws(() => parseCommandLine([...releaseArgs, '--summary', '发布']), ShipRefused);
  assert.throws(() => parseCommandLine([...releaseArgs, '--agent', '<name>']), ShipRefused);
  assert.throws(() => parseCommandLine(['--ticket', 't', '--hub', 'http://127.0.0.1:1', '--agent', 'a', '--type', 'fix', '--summary', 'S', '--into', 'main']), ShipRefused);
  assert.deepEqual(parseCommandLine([...releaseArgs, '--from', 'develop', '--into', 'main', '--no-push']),
    { mode: 'release', agent: 'claude-code', summary: 'Release develop', trailers: [], lockWaitMs: 1800_000, from: 'develop', into: 'main', push: false });
});

test('nothing to release, the same branch twice and a missing branch are refused without changes', async (t) => {
  const r = repo(t);
  const main = r.g('rev-parse', 'main');
  await assert.rejects(release(options(r.root, { from: 'main' })), refused(/both main/));
  await assert.rejects(release(options(r.root, { into: 'nope' })), refused(/there is no branch nope/));
  await assert.rejects(release(options(r.root, { from: 'nope' })), refused(/there is no branch nope/));
  r.g('branch', 'behind', 'main');
  await assert.rejects(release(options(r.root, { from: 'behind' })), refused(/nothing to release/));
  assert.equal(r.g('rev-parse', 'main'), main);
  assert.equal(r.runs(), 0);
  noLeftovers(r);
});

test('a conflict lists the files and leaves main, origin and develop alone', async (t) => {
  const r = repo(t);
  r.write(r.develop, 'README.md', 'develop version\n');
  const tip = r.commit(r.develop, 'develop edits README');
  r.write(r.root, 'README.md', 'main version\n');
  const main = r.commit(r.root, 'hotfix on main');
  const out = await release(options(r.root));
  assert.ok(!out.merged);
  assert.equal(out.kind, 'conflict');
  assert.match(out.detail, /README\.md/);
  assert.equal(r.g('rev-parse', 'main'), main);
  assert.equal(r.g('rev-parse', 'develop'), tip);
  assert.notEqual(r.origin(), main, 'nothing pushed');
  assert.equal(r.runs(), 0);
  noLeftovers(r);
});

test('a check that fails twice leaves main untouched and names the check', async (t) => {
  const r = repo(t, 'require("fs").appendFileSync(process.argv[1], "x"); console.log("probe output"); process.exit(1)');
  const main = r.g('rev-parse', 'main'), origin = r.origin();
  const out = await release(options(r.root));
  assert.ok(!out.merged);
  assert.equal(out.kind, 'checks');
  assert.match(out.detail, /^probe failed twice:\nprobe output/);
  assert.equal(r.runs(), 2, 'one automatic rerun');
  assert.equal(r.g('rev-parse', 'main'), main);
  assert.equal(r.origin(), origin);
  noLeftovers(r);
});

test('only documentation released: the checks are skipped', async (t) => {
  const r = repo(t);
  r.g('-C', r.develop, 'reset', '-q', '--hard', 'main');
  r.write(r.develop, 'docs/guide.md', 'guide\n');
  r.commit(r.develop, 'docs');
  const out = await release(options(r.root, { push: false }));
  assert.ok(out.merged);
  assert.equal(out.checksSkipped, true);
  assert.equal(r.runs(), 0);
});

test('main moving between the merge and the landing refuses the release', async (t) => {
  const r = repo(t);
  r.write(r.root, '.premerge/checks.json', r.checks('require("child_process").execFileSync("git", ["-C", process.argv[1], "commit", "--allow-empty", "-qm", "moved"])', r.root));
  r.commit(r.root, 'checks that move main');
  const tip = r.g('rev-parse', 'develop');
  await assert.rejects(release(options(r.root)), refused(/main moved/));
  assert.equal(r.g('log', '-1', '--format=%s', 'main'), 'moved');
  assert.equal(r.g('rev-parse', 'develop'), tip, 'develop not moved');
  noLeftovers(r);
});

test('a main worktree with uncommitted changes is refused', async (t) => {
  const r = repo(t);
  const main = r.g('rev-parse', 'main');
  r.write(r.root, 'stray.txt', 'not committed\n');
  await assert.rejects(release(options(r.develop)), refused(/main worktree .* has uncommitted changes/));
  assert.equal(r.g('rev-parse', 'main'), main);
  assert.equal(r.runs(), 0);
  noLeftovers(r);
});

test('--no-push leaves origin alone and the command prints the summary', (t) => {
  const r = repo(t);
  const origin = r.origin();
  const run = cli(r.root, ...releaseArgs, '--no-push');
  assert.equal(run.status, 0, run.stderr);
  const merge = r.g('rev-parse', 'main');
  assert.equal(r.origin(), origin, 'origin untouched');
  assert.equal(run.stdout, `released develop into main: ${merge}\nchecks: passed\npush: not pushed (--no-push)\ndevelop: fast-forwarded to ${merge}\n`);
});

test('a target other than main is merged locally and never pushed', (t) => {
  const r = repo(t);
  r.g('branch', 'staging', 'main');
  const origin = r.origin(), tip = r.g('rev-parse', 'develop');
  const run = cli(r.root, ...releaseArgs, '--into', 'staging');
  assert.equal(run.status, 0, run.stderr);
  const merge = r.g('rev-parse', 'staging');
  assert.equal(r.g('rev-parse', 'staging^2'), tip, 'develop was merged into staging');
  assert.match(run.stdout, /^push: not pushed \(only main is pushed automatically\)$/m);
  assert.equal(execFileSync('git', ['-C', r.bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8', windowsHide: true }).trim(), 'refs/heads/main', 'origin got no staging');
  assert.equal(r.origin(), origin, 'origin main untouched');
  assert.equal(r.g('rev-parse', 'develop'), merge, 'develop fast-forwarded');
});

test('a failed push keeps the local merge and exits non-zero with "merged locally, push failed"', (t) => {
  const r = repo(t);
  r.g('remote', 'set-url', 'origin', join(r.dir, 'no-such-remote.git'));
  const main = r.g('rev-parse', 'main');
  const run = cli(r.root, ...releaseArgs);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /push: merged locally, push failed/);
  assert.match(run.stderr, /merged locally, push failed/);
  assert.equal(r.g('rev-parse', 'main^1'), main, 'the local merge stays');
  assert.equal(r.g('rev-parse', 'develop'), r.g('rev-parse', 'main'), 'develop still synced');
});

test('develop that cannot be fast-forwarded is noted, the release still succeeds; main not checked out moves by ref', async (t) => {
  const r = repo(t);
  r.write(r.develop, 'scratch.txt', 'uncommitted\n');
  r.g('checkout', '-q', '--detach');
  const tip = r.g('rev-parse', 'develop'), head = r.g('rev-parse', 'HEAD');
  const out = await release(options(r.root, { push: false }));
  assert.ok(out.merged);
  assert.equal(out.push, 'disabled');
  assert.match(out.syncNote ?? '', /develop worktree .* has uncommitted changes/);
  assert.equal(r.g('rev-parse', 'develop'), tip, 'develop left where it was');
  assert.equal(r.g('rev-parse', 'main'), out.mergeCommit, 'main moved although no worktree has it checked out');
  assert.equal(r.g('rev-parse', 'HEAD'), head, 'the detached checkout did not move');
});
