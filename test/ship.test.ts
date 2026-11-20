import { TEST_HUB_ID } from './helpers.ts';
// ship: the merge script, its signed ticket, and the Hub's read-only check of the result (docs/collaboration.md).
// Every git action happens in temporary repositories under the system temp directory.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { acquireLock, docsOnly, parseCommandLine, redactPaths, redactSecrets, ship, ShipRefused as ScriptRefused, type ShipOptions, type ShipReport, type Verified } from '../scripts/ship.ts';
import type { CollaborationActor, CollaborationCommand, Task, TaskResult } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { gitRead } from '../src/core/projects.ts';
import { Store } from '../src/core/store.ts';
import { shipState } from '../src/plugins/tasks/model.ts';
import { setBranchLookup } from '../src/plugins/tasks/branch-link.ts';
import { readShipTicket, reportShip, SHIP_SCRIPT, shipCommand, shipFor, shipForRunner, ShipRefused, shipTicket, verifyShip } from '../src/plugins/tasks/ship.ts';
import { ticketFor } from '../src/mcp/wait-core.ts';
import { ZCODE_WAIT } from '../src/core/types.ts';
import { bearer, holdScript, startTestHub, tempDir, waitFor, turnsOf, memberHeaders } from './helpers.ts';
import { collaborationRecords, saveCollaborationRecord } from '../src/plugins/tasks/store.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';

const SECRET = 'a'.repeat(64);
const SCRIPT = resolve(import.meta.dirname, '../scripts/ship.ts');

/** A repository with main checked out, a clean tree and the given check list on main. */
function repo(t: TestContext, code = 'require("fs").appendFileSync(process.argv[1], "x")', arg?: string) {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const log = join(dir, 'runs.txt');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const write = (file: string, content: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); };
  const commit = (message: string) => { g('add', '-A'); g('commit', '-qm', message); return g('rev-parse', 'HEAD'); };
  const checks = (body: string, argument: string) => JSON.stringify({ checks: [{ name: 'probe', argv: ['node', '-e', body, argument], timeout_seconds: 60 }] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'tester');
  g('config', 'user.email', 'tester@example.invalid');
  g('config', 'core.autocrlf', 'false');
  write('README.md', 'hello\n');
  write('.premerge/checks.json', checks(code, arg ?? log));
  commit('base');
  /** A branch with `files`, left unmerged; main stays checked out. */
  const branch = (name: string, files: Record<string, string>) => {
    g('checkout', '-q', '-b', name);
    for (const [file, content] of Object.entries(files)) write(file, content);
    const sha = commit(`work on ${name}`);
    g('checkout', '-q', 'main');
    return sha;
  };
  const runs = () => existsSync(log) ? readFileSync(log, 'utf8').length : 0;
  return { dir, root, log, g, write, commit, branch, checks, runs };
}

function fakeHub(commitSha: string, extra: Partial<Verified> = {}) {
  const reports: ShipReport[] = [];
  return { reports, verify: async (): Promise<Verified> => ({ taskId: 'task-id', shortId: 'abcd1234', commitSha, reviewer: 'kimi', round: 2, verdict: 'pass', ...extra }),
    report: async (r: ShipReport) => { reports.push(r); } };
}

const options = (root: string, hub: ShipOptions['hub'], extra: Partial<ShipOptions> = {}): ShipOptions => ({
  agent: 'claude-code', type: 'fix', summary: 'Fix the thing', trailers: ['Co-Authored-By: Someone <someone@example.invalid>'], cwd: root, lockWaitMs: 5000, hub, ...extra,
});
const refused = (pattern: RegExp) => (e: unknown) => e instanceof ScriptRefused && pattern.test(e.message);
const noLeftovers = (r: ReturnType<typeof repo>) => {
  assert.equal(existsSync(join(r.root, '.git', 'ship.lock')), false, 'lock released');
  assert.equal(r.g('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1, 'temporary worktree removed');
};

test('ship merges with --no-ff, the Reviewed-by line and trailers, and lands the checked commit on main', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const before = r.g('rev-parse', 'main');
  const hub = fakeHub(sha);
  const out = await ship(options(r.root, hub));
  assert.equal(out.merged, true);
  assert.ok(out.merged);
  assert.equal(r.g('rev-parse', 'main'), out.mergeCommit);
  assert.equal(r.g('rev-parse', 'main^1'), before);
  assert.equal(r.g('rev-parse', 'main^2'), sha);
  assert.equal(r.g('log', '-1', '--format=%B', 'main'), `[claude-code] fix: Fix the thing\n\nReviewed-by: kimi (task abcd1234, r2, pass, ${sha.slice(0, 7)})\nCo-Authored-By: Someone <someone@example.invalid>`);
  assert.equal(r.runs(), 1, 'checks ran once');
  assert.deepEqual(hub.reports, [{ mergeCommit: out.mergeCommit, pushed: false, retried: [] }], 'no origin: pushed is false');
  assert.equal(out.pushError, undefined, 'no origin is not a push failure');
  noLeftovers(r);
});

test('ship writes "self" for a self-reviewed task', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  await ship(options(r.root, fakeHub(sha, { verdict: 'self', reviewer: 'codex' })));
  assert.match(r.g('log', '-1', '--format=%B', 'main'), /Reviewed-by: codex \(task abcd1234, r2, self, /);
});

test('ship refuses when the branch moved after review, and no longer needs the old commit to be a branch head to say so', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  r.g('checkout', '-q', 'feature');
  r.write('src.txt', 'changed after review\n');
  r.commit('later commit');
  r.g('checkout', '-q', 'main');
  const hub = fakeHub(sha);
  await assert.rejects(ship(options(r.root, hub)), refused(/no local branch points at/));
  assert.deepEqual(hub.reports, [], 'a refusal is not reported');
  noLeftovers(r);
});

test('ship refuses a main worktree with uncommitted changes, tracked or untracked', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const before = r.g('rev-parse', 'main');
  r.write('stray.txt', 'not committed\n');
  await assert.rejects(ship(options(r.root, fakeHub(sha))), refused(/uncommitted changes/));
  assert.equal(r.g('rev-parse', 'main'), before);
  noLeftovers(r);
});

test('a merge conflict is reported, not resolved, and leaves main alone', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'README.md': 'branch version\n' });
  r.write('README.md', 'main version\n');
  const before = r.commit('main moves on');
  const hub = fakeHub(sha);
  const out = await ship(options(r.root, hub));
  assert.equal(out.merged, false);
  assert.ok(!out.merged);
  assert.equal(out.kind, 'conflict');
  assert.match(out.detail, /README\.md/);
  assert.deepEqual(hub.reports, [{ failed: { kind: 'conflict', conflictFiles: ['README.md'], detail: out.detail } }]);
  assert.equal(r.g('rev-parse', 'main'), before);
  assert.equal(r.runs(), 0, 'no checks on a conflict');
  noLeftovers(r);
});

test('only docs and markdown changed: the checks do not run', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'docs/guide.md': 'guide\n', 'notes.md': 'notes\n' });
  const out = await ship(options(r.root, fakeHub(sha)));
  assert.equal(out.merged, true);
  assert.equal(r.runs(), 0);
  assert.equal(docsOnly(['docs/a.md', 'b.md']), true);
  assert.equal(docsOnly(['docs/a.md', 'src/a.ts']), false);
  assert.equal(docsOnly([]), false);
});

test('a check that fails twice goes back to the executor; main\'s check list is the one that counts', async (t) => {
  const r = repo(t, 'require("fs").appendFileSync(process.argv[1], "x"); process.exit(1)');
  const sha = r.branch('feature', { '.premerge/checks.json': r.checks('process.exit(0)', 'ignored'), 'src.txt': 'code\n' });
  const before = r.g('rev-parse', 'main');
  const hub = fakeHub(sha);
  const out = await ship(options(r.root, hub));
  assert.equal(out.merged, false);
  assert.ok(!out.merged);
  assert.equal(out.kind, 'checks');
  assert.equal(r.runs(), 2, 'one automatic rerun, then stop');
  assert.deepEqual(hub.reports, [{ failed: { kind: 'checks', failedCheck: 'probe', detail: out.detail } }]);
  assert.equal(r.g('rev-parse', 'main'), before);
  noLeftovers(r);
});

test('a check that fails once and passes on the rerun merges, and the rerun is recorded', async (t) => {
  const r = repo(t, 'const fs = require("fs"), p = process.argv[1]; fs.appendFileSync(p, "x"); process.exit(fs.readFileSync(p, "utf8").length > 1 ? 0 : 1)');
  const hub = fakeHub(r.branch('feature', { 'src.txt': 'code\n' }));
  const out = await ship(options(r.root, hub));
  assert.equal(out.merged, true);
  assert.equal(r.runs(), 2);
  assert.deepEqual((hub.reports[0] as { retried: string[] }).retried, ['probe']);
});

test('main moving during the checks refuses the landing', async (t) => {
  const r = repo(t, 'require("child_process").execFileSync("git", ["-C", process.argv[1], "commit", "--allow-empty", "-qm", "moved"])', '.');
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  r.write('.premerge/checks.json', r.checks('require("child_process").execFileSync("git", ["-C", process.argv[1], "commit", "--allow-empty", "-qm", "moved"])', r.root));
  r.commit('checks that move main');
  const hub = fakeHub(sha);
  await assert.rejects(ship(options(r.root, hub)), refused(/main moved/));
  assert.notEqual(r.g('log', '-1', '--format=%s', 'main'), `[claude-code] fix: Fix the thing`);
  assert.deepEqual(hub.reports, []);
  noLeftovers(r);
});

test('a task that changes during the checks is not landed', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const before = r.g('rev-parse', 'main');
  const hub = fakeHub(sha), verify = hub.verify;
  let calls = 0;
  hub.verify = async () => { if (++calls === 3) throw new ScriptRefused('the Hub refused: reopened'); return verify(); };
  await assert.rejects(ship(options(r.root, hub)), refused(/reopened/));
  assert.equal(r.runs(), 1, 'the checks had run');
  assert.equal(r.g('rev-parse', 'main'), before);
  assert.deepEqual(hub.reports, []);
  noLeftovers(r);
});

test('the main worktree switching branch during the checks refuses the landing', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  r.write('.premerge/checks.json', r.checks('require("child_process").execFileSync("git", ["-C", process.argv[1], "checkout", "-q", "-b", "elsewhere"])', r.root));
  const before = r.commit('checks that switch the branch');
  await assert.rejects(ship(options(r.root, fakeHub(sha))), refused(/no longer has main checked out/));
  assert.equal(r.g('rev-parse', 'main'), before);
  assert.equal(r.g('rev-parse', 'elsewhere'), before, 'the other branch did not move');
});

test('a failed push keeps the local merge, reports pushed:false, and the next ship pushes both', async (t) => {
  const r = repo(t);
  const bare = join(r.dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
  r.g('remote', 'add', 'origin', join(r.dir, 'no-such-remote.git'));
  const first = r.branch('one', { 'one.txt': '1\n' });
  const hub = fakeHub(first);
  const failed = await ship(options(r.root, hub));
  assert.ok(failed.merged);
  assert.equal(failed.pushed, false);
  assert.ok(failed.pushError, 'the push failure is surfaced');
  assert.equal(r.g('rev-parse', 'main'), failed.mergeCommit, 'local merge stays');
  assert.deepEqual(hub.reports, [{ mergeCommit: failed.mergeCommit, pushed: false, retried: [] }]);

  r.g('remote', 'set-url', 'origin', bare);
  const second = await ship(options(r.root, fakeHub(r.branch('two', { 'two.txt': '2\n' }))));
  assert.ok(second.merged);
  assert.equal(second.pushed, true);
  assert.equal(execFileSync('git', ['-C', bare, 'rev-parse', 'main'], { encoding: 'utf8', windowsHide: true }).trim(), second.mergeCommit);
  assert.equal(execFileSync('git', ['-C', bare, 'merge-base', '--is-ancestor', failed.mergeCommit, 'main'], { windowsHide: true }).length, 0, 'the earlier merge went up too');
});

test('lock: waits out a live holder and names it, takes over from a dead one', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(dir, 'ship.lock');
  const holder = (pid: number) => JSON.stringify({ pid, cwd: 'elsewhere', startedAt: 1000, token: 'earlier' });
  writeFileSync(path, holder(process.pid));
  await assert.rejects(acquireLock(path, 100), refused(new RegExp(`held by pid ${process.pid} since 1970`)));
  const gone = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  writeFileSync(path, holder(gone));
  const release = await acquireLock(path, 100);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
  release();
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(dir), [], 'no stale file left');
});

test('two ship processes run one at a time and both land', async (t) => {
  const r = repo(t, 'const fs = require("fs"), p = process.argv[1]; fs.appendFileSync(p, "s"); setTimeout(() => fs.appendFileSync(p, "e"), 400)');
  const shas: Record<string, string> = { one: r.branch('one', { 'one.txt': '1\n' }), two: r.branch('two', { 'two.txt': '2\n' }) };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { ticket } = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/bridge/ship-verify' ? { taskId: ticket, shortId: ticket, commitSha: shas[ticket], reviewer: 'kimi', round: 1, verdict: 'pass' } : {}));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const run = (ticket: string) => new Promise<number | null>((done) => {
    const child = spawn(process.execPath, [SCRIPT, '--ticket', ticket, '--hub', `http://127.0.0.1:${port}`, '--agent', 'claude-code', '--type', 'test', '--summary', `Ship ${ticket}`], { cwd: r.root, stdio: 'ignore', windowsHide: true });
    child.on('close', done);
  });
  assert.deepEqual(await Promise.all([run('one'), run('two')]), [0, 0]);
  assert.equal(readFileSync(r.log, 'utf8'), 'sese', 'checks never overlapped');
  assert.equal(r.g('merge-base', '--is-ancestor', shas.one, 'main'), '');
  assert.equal(r.g('merge-base', '--is-ancestor', shas.two, 'main'), '');
  noLeftovers(r);
});

test('the command line rejects placeholders left in and non-English summaries', () => {
  const base = ['--ticket', 't', '--hub', 'http://127.0.0.1:1', '--agent', 'claude-code/ship', '--type', 'fix', '--summary', 'Fix it'];
  assert.equal(parseCommandLine(base).summary, 'Fix it');
  const swap = (flag: string, value: string) => base.map((item, i) => (base[i - 1] === flag ? value : item));
  assert.throws(() => parseCommandLine(swap('--summary', '<English summary>')), ScriptRefused);
  assert.throws(() => parseCommandLine(swap('--summary', '修复问题')), ScriptRefused);
  assert.throws(() => parseCommandLine(swap('--type', '<type>')), ScriptRefused);
  assert.throws(() => parseCommandLine(swap('--agent', '<name>')), ScriptRefused);
  assert.throws(() => parseCommandLine([...base, '--trailer', 'no colon here']), ScriptRefused);
});

// ---- the Hub's side ----

const user: CollaborationActor = { kind: 'user' };
const member = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
const a = member('a'), b = member('b');

/** A Hub with members a (executor) and b, working in `cwd`, driven through the collaboration commands. */
function hubFixture(t: TestContext, cwd = '/tmp') {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, ['a', 'b'].map((id) => ({
    id, clusterId: 'c', name: `name-${id}`, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd, origin: 'attached' as const, removedAt: null,
  })));
  const hub = new Hub({ store, nativeAdapters: {} });
  t.after(async () => { await hub.close(); store.close(); });
  let serial = 0;
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) => hub.collaboration.command(actor, 'c', { ...command, operationId: 'op-' + ++serial });
  const read = (id: string) => hub.collaboration.query(user, 'c', { kind: 'task', taskId: id }) as TaskResult;
  const act = (actor: CollaborationActor, task: Task, command: Partial<CollaborationCommand> & { action: CollaborationCommand['action'] }) =>
    send(actor, { taskId: task.id, expectedRevision: read(task.id).task.revision, ...command });
  const evidence = hub.sendFromUser('c', 'proof');
  /** A task of a, submitted for `reviewer`, with `sha`; returns the task as it stands then. */
  const submitted = (sha: string, reviewer: CollaborationActor = b, extra: Partial<CollaborationCommand> = {}) => {
    const task = send(user, { action: 'task.create', title: 'work', scope: 's', acceptance: 'a', reviewer, ...extra }).task!;
    const claim = act(a, task, { action: 'task.claim' });
    act(a, task, { action: 'task.start', assignmentId: claim.assignment!.id });
    return { task, submission: act(a, task, { action: 'task.submit', assignmentId: claim.assignment!.id, summary: 'done', evidenceMessageIds: [evidence.id], commitSha: sha }).submission! };
  };
  const approved = (sha: string, extra: Partial<CollaborationCommand> = {}) => {
    const { task, submission } = submitted(sha, b, extra);
    act(b, task, { action: 'task.review', submissionId: submission.id, verdict: 'approve', reason: 'ok' });
    const state = shipState(store, 'c', task.id)!;
    return { task, submission, ticket: shipTicket(SECRET, { clusterId: 'c', taskId: task.id, submissionId: submission.id, commitSha: state.commitSha, reviewer: state.reviewer }) };
  };
  return { store, hub, send, read, act, submitted, approved };
}

const status = (expected: number) => (e: unknown) => e instanceof ShipRefused && e.status === expected;

test('ticket: forged, rebound or wrong-domain tickets are refused; a good one yields the Reviewed-by fields', (t) => {
  const f = hubFixture(t), { task, submission, ticket } = f.approved('abcdef0');
  assert.deepEqual(readShipTicket(SECRET, ticket), { clusterId: 'c', taskId: task.id, submissionId: submission.id, commitSha: 'abcdef0', reviewer: 'b' });
  const v = verifyShip(f.hub, SECRET, ticket);
  assert.deepEqual(v, { taskId: task.id, shortId: task.id.slice(0, 8), commitSha: 'abcdef0', reviewer: 'name-b', round: 1, verdict: 'pass' });
  assert.throws(() => verifyShip(f.hub, 'b'.repeat(64), ticket), status(403), 'signed with another secret');
  assert.throws(() => verifyShip(f.hub, SECRET, `${ticket.slice(0, -1)}${ticket.endsWith('0') ? '1' : '0'}`), status(403), 'tampered signature');
  assert.throws(() => verifyShip(f.hub, SECRET, undefined), status(403));
  assert.throws(() => verifyShip(f.hub, SECRET, ticketFor(ZCODE_WAIT, SECRET, 'abc', TEST_HUB_ID)), status(403), 'a wait ticket is not a ship ticket');
  const rebound = (claims: Partial<Parameters<typeof shipTicket>[1]>) => shipTicket(SECRET, { clusterId: 'c', taskId: task.id, submissionId: submission.id, commitSha: 'abcdef0', reviewer: 'b', ...claims });
  assert.throws(() => verifyShip(f.hub, SECRET, rebound({ commitSha: '1234567' })), status(409), 'another commit');
  assert.throws(() => verifyShip(f.hub, SECRET, rebound({ submissionId: 'other' })), status(409), 'another submission');
  assert.throws(() => verifyShip(f.hub, SECRET, rebound({ reviewer: 'a' })), status(409), 'another reviewer');
  assert.throws(() => verifyShip(f.hub, SECRET, rebound({ taskId: 'other' })), status(409), 'another task');
  assert.throws(() => verifyShip(f.hub, SECRET, rebound({ clusterId: 'other' })), status(409), 'another cluster');
});

test('ticket: a reviewer who is also the executor is refused', (t) => {
  const f = hubFixture(t), { task, submission } = f.approved('abcdef0');
  const record = collaborationRecords<any>(f.store, task.id, 'review')[0];
  saveCollaborationRecord(f.store, task.id, 'review', { ...record, reviewer: a });
  const ticket = shipTicket(SECRET, { clusterId: 'c', taskId: task.id, submissionId: submission.id, commitSha: 'abcdef0', reviewer: 'a' });
  assert.throws(() => verifyShip(f.hub, SECRET, ticket), status(403));
});

test('only a ship report can record task.shipped or task.ship_failed', (t) => {
  const f = hubFixture(t), { task, submission } = f.approved('abcdef0');
  for (const action of ['task.shipped', 'task.ship_failed'] as const) {
    for (const actor of [user, a, b]) {
      assert.throws(() => f.act(actor, task, { action, submissionId: submission.id, commitSha: 'abcdef0', reason: 'x' }), (e: any) => e.code === 'FORBIDDEN');
    }
  }
  assert.equal(f.read(task.id).task.status, 'completed');
});

test('the target branch comes from git config: ship lands there, main stays and nothing is pushed', async (t) => {
  const r = repo(t);
  const bare = join(r.dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { windowsHide: true });
  r.g('remote', 'add', 'origin', bare);
  const before = r.g('rev-parse', 'main');
  r.g('branch', 'develop');
  r.g('worktree', 'add', '-q', join(r.dir, 'develop'), 'develop');
  r.g('config', 'orrery.shipBranch', 'develop');
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const out = await ship(options(r.root, fakeHub(sha)));
  assert.ok(out.merged);
  assert.equal(out.pushed, false, 'only a landing on main is pushed');
  assert.equal(r.g('rev-parse', 'develop'), out.mergeCommit);
  assert.equal(r.g('rev-parse', 'develop^2'), sha);
  assert.equal(r.g('rev-parse', 'main'), before, 'main stays where it was');
  assert.equal(execFileSync('git', ['-C', bare, 'for-each-ref'], { encoding: 'utf8', windowsHide: true }), '', 'the remote got nothing');
});

test('a setting that names no branch refuses instead of falling back to main', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const before = r.g('rev-parse', 'main');
  r.g('config', 'orrery.shipBranch', 'not a branch');
  await assert.rejects(ship(options(r.root, fakeHub(sha))), refused(/does not name a branch/));
  assert.equal(r.g('rev-parse', 'main'), before);
});

test('the Hub checks the merge against the configured branch, not main', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const f = hubFixture(t, r.root);
  const { task, ticket } = f.approved(sha);
  r.g('merge', '-q', '--no-ff', '-m', 'merged on main', sha);
  const onMain = r.g('rev-parse', 'HEAD');
  r.g('reset', '-q', '--hard', 'HEAD^');
  r.g('checkout', '-q', '-b', 'develop');
  r.g('merge', '-q', '--no-ff', '-m', 'merged on develop', sha);
  const onDevelop = r.g('rev-parse', 'HEAD');
  r.g('checkout', '-q', 'main');
  r.g('merge', '-q', '--ff-only', onMain);
  r.g('config', 'orrery.shipBranch', 'develop');
  await assert.rejects(reportShip(f.hub, SECRET, { ticket, mergeCommit: onMain, pushed: false }), status(409), 'on main, but main is not the target');
  assert.deepEqual(await reportShip(f.hub, SECRET, { ticket, mergeCommit: onDevelop, pushed: false }), { status: 'merged' });
  assert.equal(f.read(task.id).task.status, 'merged');
});

test('a merge is recorded only once git shows it on main with the reviewed commit as second parent', async (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const f = hubFixture(t, r.root);
  const { task, submission, ticket } = f.approved(sha);

  r.g('checkout', '-q', '-b', 'side');
  r.g('merge', '-q', '--no-ff', '-m', 'merge on a side branch', sha);
  const offMain = r.g('rev-parse', 'HEAD');
  r.g('checkout', '-q', 'main');
  await assert.rejects(reportShip(f.hub, SECRET, { ticket, mergeCommit: offMain, pushed: true }), status(409), 'not on main');

  const other = r.branch('other', { 'other.txt': 'x\n' });
  r.g('merge', '-q', '--no-ff', '-m', 'merge of something else', other);
  await assert.rejects(reportShip(f.hub, SECRET, { ticket, mergeCommit: r.g('rev-parse', 'HEAD'), pushed: true }), status(409), 'second parent is not the reviewed commit');
  await assert.rejects(reportShip(f.hub, SECRET, { ticket, mergeCommit: '--help', pushed: true }), status(400), 'not a commit id');
  await assert.rejects(reportShip(f.hub, SECRET, { ticket: 'bad', mergeCommit: offMain, pushed: true }), status(403));
  assert.equal(f.read(task.id).task.status, 'completed', 'nothing recorded yet');

  // A dependent task, held by the reviewer, becomes ready when this one merges.
  const dependent = f.send(user, { action: 'task.create', title: 'next', scope: 's', acceptance: 'a', dependencyIds: [task.id], reviewer: a }).task!;
  f.act(user, dependent, { action: 'task.nominate', memberId: 'b' });

  r.g('merge', '-q', '--no-ff', '-m', 'the real merge', sha);
  const mergeCommit = r.g('rev-parse', 'HEAD');
  assert.deepEqual(await reportShip(f.hub, SECRET, { ticket, mergeCommit, pushed: false, retried: ['test'] }), { status: 'merged' });
  const after = f.read(task.id);
  assert.equal(after.task.status, 'merged');
  assert.equal(after.task.mergedCommitSha, mergeCommit);
  assert.equal(after.task.mergedSubmissionId, submission.id);
  assert.deepEqual(after.merges[0].recordedBy, { kind: 'system' });
  assert.match(after.merges[0].reason, /pushed: false; checks retried: test/);
  assert.ok(f.store.listMessages('c', 100).some((m) => m.mentions.includes('b') && /前置依赖已就绪/.test(m.body)), 'downstream owner told');

  await assert.rejects(reportShip(f.hub, SECRET, { ticket, mergeCommit, pushed: false }), status(409), 'a replayed ticket is refused');
  assert.throws(() => verifyShip(f.hub, SECRET, ticket), status(409), 'and cannot start another merge');
});

test('task.merge is only the way out for a ship that landed: git must show the merge', (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const f = hubFixture(t, r.root);
  const { task, submission } = f.approved(sha);
  const merge = (commitSha: string) => f.act(b, task, { action: 'task.merge', commitSha });
  const refused = (e: any) => e.code === 'MERGE_NOT_VERIFIED';

  assert.throws(() => merge('abcdef1'), refused, 'no such commit');
  r.g('checkout', '-q', '-b', 'side');
  r.g('merge', '-q', '--no-ff', '-m', 'merge on a side branch', sha);
  const offMain = r.g('rev-parse', 'HEAD');
  r.g('checkout', '-q', 'main');
  assert.throws(() => merge(offMain), refused, 'not on main');
  const other = r.branch('other', { 'other.txt': 'x\n' });
  r.g('merge', '-q', '--no-ff', '-m', 'merge of something else', other);
  assert.throws(() => merge(r.g('rev-parse', 'HEAD')), refused, 'second parent is not the reviewed commit');
  assert.equal(f.read(task.id).task.status, 'completed', 'nothing recorded yet');

  r.g('merge', '-q', '--no-ff', '-m', 'the real merge', sha);
  const mergeCommit = r.g('rev-parse', 'HEAD');
  const done = merge(mergeCommit.slice(0, 10)).task!;
  assert.deepEqual([done.status, done.mergedCommitSha, done.mergedSubmissionId], ['merged', mergeCommit.slice(0, 10), submission.id]);
});

test('an executor recording the merge of its self-reviewed task leaves one record that names nobody', (t) => {
  const r = repo(t);
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const f = hubFixture(t, r.root);
  const { task } = f.submitted(sha, { kind: 'self' });
  assert.equal(f.read(task.id).task.status, 'completed');
  r.g('merge', '-q', '--no-ff', '-m', 'the real merge', sha);
  const recorded = f.act(a, task, { action: 'task.merge', commitSha: r.g('rev-parse', 'HEAD') });
  const records = f.store.listMessages('c', 100).filter((m) => m.kind === 'system' && m.collabEventId === recorded.eventId);
  assert.equal(records.length, 1);
  assert.match(records[0].body, /^任务 #1【work】已合并（提交 [0-9a-f]{7}），事件 \d+。$/);
  assert.deepEqual(records[0].mentions, []);
  assert.deepEqual(f.store.withDeliveries([records[0]])[0].deliveries, []);
});

test('a failed ship preserves completed state, records structured shipFailure, notifies infoOnly and leaves the ticket reusable', async (t) => {
  const f = hubFixture(t), { task, submission, ticket } = f.approved('abcdef0');
  await assert.rejects(reportShip(f.hub, SECRET, { ticket, failed: { kind: 'other', detail: 'x' } }), status(400));
  assert.deepEqual(await reportShip(f.hub, SECRET, { ticket, failed: { kind: 'conflict', conflictFiles: ['README.md'], detail: 'conflicting files:\nREADME.md' } }), { status: 'failed' });
  const now = f.read(task.id).task;
  assert.equal(now.status, 'completed');
  assert.equal(now.assignedMemberId, null, 'completed task stays completed without reverting to pending');
  assert.equal(now.approvedSubmissionId, submission.id);
  const notice = f.store.listMessages('c', 100).at(-1)!;
  assert.deepEqual(notice.mentions.sort(), ['a', 'b']);
  assert.deepEqual(f.store.withDeliveries([notice])[0].deliveries, [], 'ship_failed sends infoOnly with zero wakes');
  assert.equal(notice.body, `任务 #1【work】合并失败：文件有合并冲突，保留已通过状态（可原样重跑、ship_fix 或 reopen），事件 ${notice.collabEventId}。`);
  assert.deepEqual(now.shipFailure, {
    kind: 'conflict',
    reason: 'conflict: conflicting files:\nREADME.md',
    detail: 'conflicting files:\nREADME.md',
    conflictFiles: ['README.md'],
    at: now.shipFailure!.at,
    eventId: notice.collabEventId!,
    approvedSubmissionId: submission.id,
    approvedCommitSha: 'abcdef0',
    runnerId: 'b',
  });
  assert.deepEqual(f.store.getEvent(notice.collabEventId!)?.payload, {
    action: 'task.ship_failed',
    taskId: task.id,
    reason: 'conflict: conflicting files:\nREADME.md',
    failure: { kind: 'conflict', conflictFiles: ['README.md'] },
    eventId: notice.collabEventId,
  });
  assert.deepEqual(verifyShip(f.hub, SECRET, ticket).commitSha, 'abcdef0', 'the existing ticket remains valid for a verbatim rerun');
});

test('ship check notices are short and save the full normal output tail or the bounded end of oversized output', async (t) => {
  const f = hubFixture(t);
  const tail = 'x'.repeat(3977) + '\nlast assertion failed.\n';
  const detail = 'npm test failed twice:\n' + tail;
  for (const diagnostic of [detail, 'earliest output\n' + 'x'.repeat(5000) + '\n' + detail]) {
    const { ticket } = f.approved('abcdef0');
    assert.deepEqual(await reportShip(f.hub, SECRET, { ticket, failed: { kind: 'checks', failedCheck: 'probe', detail: diagnostic } }), { status: 'failed' });
    const notice = f.store.listMessages('c', 100).at(-1)!;
    assert.equal(notice.body, `任务 #${diagnostic === detail ? 1 : 2}【work】合并失败：合并前检查未通过，保留已通过状态（可原样重跑、ship_fix 或 reopen），事件 ${notice.collabEventId}。`);
    const payload = f.store.getEvent(notice.collabEventId!)?.payload as { reason: string; failure?: { kind: string; failedCheck?: string } };
    const expected = diagnostic === detail ? detail : '…（仅保留末尾）\n' + diagnostic.slice(-4600);
    assert.equal(payload.reason, 'checks: ' + expected);
    assert.equal(payload.failure?.failedCheck, 'probe');
    assert.match(payload.reason, /last assertion failed\.\n$/);
  }
});

test('get_task shows ship only to the member who runs it: the approving member, else the executor', (t) => {
  const f = hubFixture(t);
  const url = 'http://127.0.0.1:9';
  const of = (task: Task, member: string) => shipForRunner(f.hub, SECRET, url, 'c', task.id, member);

  const userTask = f.submitted('abcdef0', user);
  f.act(user, userTask.task, { action: 'task.review', submissionId: userTask.submission.id, verdict: 'approve' });
  const command = (of(userTask.task, 'a').ship as { command: string }).command;
  assert.ok(command.includes(`node "${SHIP_SCRIPT}" --ticket s1.`), command);
  assert.ok(command.includes(`--hub ${url} --agent <name> --type <type> --summary "<English summary>" [--trailer "..."]`), command);
  assert.deepEqual(of(userTask.task, 'b'), {}, 'not the executor');

  const selfTask = f.submitted('1234567', { kind: 'self' });
  assert.ok('ship' in of(selfTask.task, 'a'), 'self-reviewed: its executor');
  assert.equal(verifyShip(f.hub, SECRET, /--ticket (\S+)/.exec((of(selfTask.task, 'a').ship as { command: string }).command)![1]).verdict, 'self');

  const memberTask = f.approved('7654321');
  assert.deepEqual(of(memberTask.task, 'a'), {}, 'a member review hands the command to the reviewer');
  assert.ok('command' in (shipFor(f.hub, SECRET, url, 'c', memberTask.task.id).ship ?? {}));
  assert.ok('ship' in of(memberTask.task, 'b'), 'the approving reviewer can read the command again');

  const approvedByUser = f.submitted('abc1234', b);
  f.act(user, approvedByUser.task, { action: 'task.review', submissionId: approvedByUser.submission.id, verdict: 'approve' });
  assert.ok('ship' in of(approvedByUser.task, 'a'), 'the user approved in the member reviewer\'s place: its executor');
  assert.deepEqual(of(approvedByUser.task, 'b'), {}, 'that reviewer did not approve it');

  const noMerge = f.submitted('abcdef1', b, { mergeRequired: false });
  f.act(b, noMerge.task, { action: 'task.review', submissionId: noMerge.submission.id, verdict: 'approve', reason: 'ok' });
  assert.deepEqual(shipFor(f.hub, SECRET, url, 'c', noMerge.task.id), {}, 'nothing to merge');
});

test('the ship command uses the Hub\'s own checkout and refuses an address or path it cannot put in a shell', () => {
  assert.ok(SHIP_SCRIPT.endsWith('/scripts/ship.ts') && !SHIP_SCRIPT.includes('\\'));
  assert.throws(() => shipCommand('s1.x.y', 'http://example.com:80'));
  assert.throws(() => shipCommand('s1.x.y', 'http://127.0.0.1:1', 'C:/a"b/ship.ts'));
});

test('the Hub\'s ship code only ever runs read-only git', () => {
  const code = readFileSync(resolve(import.meta.dirname, '../src/plugins/tasks/ship.ts'), 'utf8');
  assert.equal(/child_process|execFile|spawn/.test(code), false, 'no way to start a process but the read-only helper');
  const calls = [...code.matchAll(/\bgitSync\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.match(call, /^cwd, ('merge-base'|'rev-parse'|'config', '--get'),/, call);
});

test('the whole new flow over HTTP, from a linked worktree: create with an executor, start, submit, review, ship', async (t) => {
  const r = repo(t);
  const sha = r.branch('agent/one', { 'src.txt': 'code\n' });
  const linked = join(r.dir, 'reviewer');
  r.g('worktree', 'add', '-q', '--detach', linked, 'main');
  const app = await startTestHub();
  t.after(async () => { await app.close(); rmSync(app.dir, { recursive: true, force: true, maxRetries: 5 }); });
  app.hub.store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, ['a', 'b'].map((id) => ({
    id, clusterId: 'c', name: `name-${id}`, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: r.root, origin: 'attached' as const, removedAt: null,
  })));
  const secret = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>) => app.hub.collaboration.command(actor, 'c', { ...command, operationId: crypto.randomUUID() });
  const created = send(user, { action: 'task.create', title: 'work', scope: 's', acceptance: 'a', reviewer: b, memberId: 'a' }).task!;
  assert.equal(created.assignedMemberId, 'a');
  const start = send(a, { action: 'task.start', taskId: created.id, expectedRevision: created.revision });
  const task = () => (app.hub.collaboration.query(user, 'c', { kind: 'task', taskId: created.id }) as TaskResult).task;
  const submit = send(a, { action: 'task.submit', taskId: created.id, expectedRevision: task().revision, assignmentId: start.assignment!.id, summary: 'done', commitSha: sha });
  send(b, { action: 'task.review', taskId: created.id, expectedRevision: task().revision, submissionId: submit.submission!.id, verdict: 'approve', reason: 'ok' });
  const command = (shipFor(app.hub, secret, app.url, 'c', created.id).ship as { command: string }).command;
  const ticket = /--ticket (\S+)/.exec(command)![1];
  // Not spawnSync: the Hub answering this script runs in this very process.
  const run = await new Promise<{ status: number | null; stderr: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT, '--ticket', ticket, '--hub', app.url, '--agent', 'claude-code', '--type', 'feat', '--summary', 'Land the work'], { cwd: linked, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => done({ status, stderr }));
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(r.g('rev-parse', 'main^2'), sha);
  assert.match(r.g('log', '-1', '--format=%B', 'main'), new RegExp(`^\\[claude-code\\] feat: Land the work\\n\\nReviewed-by: name-b \\(task ${created.id.slice(0, 8)}, r1, pass, ${sha.slice(0, 7)}\\)$`));
  assert.equal(task().status, 'merged');
  assert.equal(task().mergedCommitSha, r.g('rev-parse', 'main'));
  const bad = await fetch(`${app.url}/bridge/ship-verify`, { method: 'POST', body: JSON.stringify({ ticket: 'forged' }) });
  assert.equal(bad.status, 403, 'a forged ticket gets nowhere');
});

test('over MCP: an approving reviewer gets ship.command; the executor of a self-reviewed task gets it from get_task', async (t) => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  t.after(async () => { hold.release(); await app.close(); });
  const { cluster, members: [m1, m2] } = await app.cluster('ship', ['A', 'B']);
  const path = `/api/clusters/${cluster.id}`;
  const cmd = (body: Record<string, unknown>) => app.api('POST', `${path}/collaboration`, body);
  const { task } = await cmd({ action: 'task.create', operationId: 't1', title: 'one', scope: 's', acceptance: 'a', reviewer: { kind: 'member', memberId: m2.id } });
  const { task: self } = await cmd({ action: 'task.create', operationId: 't2', title: 'two', scope: 's', acceptance: 'a', reviewer: { kind: 'self' } });
  const message = await app.api('POST', `${path}/messages`, { body: 'proof' });
  await app.api('POST', `${path}/messages`, { body: '@A @B hold' });
  await waitFor(() => [m1.id, m2.id].every((id) => turnsOf(app, id) > 0), 'both turns');
  const connect = async (memberId: string) => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, memberId) } }));
    t.after(() => client.close());
    return async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as any)[0].text as string;
      assert.equal(result.isError === true, false, text);
      return JSON.parse(text);
    };
  };
  const [callA, callB] = [await connect(m1.id), await connect(m2.id)];
  let serial = 0;
  const work = async (id: string, sha: string) => {
    const claim = await callA('task_action', { operationId: `w${++serial}`, action: 'claim', taskId: id, expectedRevision: 1 });
    const started = await callA('task_action', { operationId: `w${++serial}`, action: 'start', taskId: id, expectedRevision: claim.task.revision, assignmentId: claim.assignment.id });
    return callA('task_action', { operationId: `w${++serial}`, action: 'submit', taskId: id, expectedRevision: started.task.revision, assignmentId: claim.assignment.id, summary: 'done', evidenceMessageIds: [message.id], commitSha: sha });
  };
  const submitted = await work(task.id, 'abcdef0');
  const reviewed = await callB('task_action', { operationId: 'r1', action: 'review', taskId: task.id, expectedRevision: submitted.task.revision, submissionId: submitted.submission.id, verdict: 'approve', reason: 'fine' });
  assert.match(reviewed.ship.command, new RegExp(`^node ".+/scripts/ship\\.ts" --ticket s1\\.\\S+ --hub http://127\\.0\\.0\\.1:\\d+ --agent <name>`));
  assert.equal((await callA('get_task', { taskId: task.id })).ship, undefined, 'the executor of a member-reviewed task is not handed the command');

  await work(self.id, '1234567');
  assert.match((await callA('get_task', { taskId: self.id })).ship.command, /--ticket s1\./);
  assert.equal((await callB('get_task', { taskId: self.id })).ship, undefined, 'other members do not see it');
});

test('ship failure diagnostics: redacts secrets and host paths, saves logs and screenshots before worktree cleanup, and rotates old runs', async (t) => {
  assert.equal(
    redactSecrets('http://127.0.0.1/#token=tok_123&api_key=k99 Authorization: Bearer secret_hdr x-orrery-bridge=br_99 s1.abcdefghij.klmnopqrst'),
    'http://127.0.0.1/#token=<redacted>&api_key=<redacted> Authorization: Bearer <redacted> x-orrery-bridge=<redacted> <redacted-ticket>',
  );
  const sampleBase = join(tmpdir(), 'redact-paths-base');
  const sampleDiag = join(sampleBase, 'repo', '.tmp', 'ship-failures');
  const sampleRepo = join(sampleBase, 'repo');
  const sampleWork = join(sampleBase, 'orrery-ship-1');
  const sampleHome = join(sampleBase, 'home');
  const sampleInput = [
    `diag=${sampleDiag}/r1`,
    `repo=${sampleRepo.replaceAll('\\', '/')}/test/ship.test.ts`,
    `url=${pathToFileURL(join(sampleWork, 'test', 'a.test.ts')).href}:12:3`,
    `home=${sampleHome}/notes`,
    `other=${sampleHome}-other/keep`,
  ].join(' ');
  const redactedSample = redactPaths(sampleInput, {
    diagnostics: sampleDiag, worktree: sampleWork, repo: sampleRepo, tmp: tmpdir(), home: sampleHome,
  });
  assert.ok(!redactedSample.includes(sampleRepo), redactedSample);
  assert.ok(!redactedSample.includes(sampleWork), redactedSample);
  assert.ok(!redactedSample.includes(sampleHome + '/notes'), redactedSample);
  assert.match(redactedSample, /diag=<diagnostics>\/r1/);
  assert.match(redactedSample, /repo=<repo>\/test\/ship\.test\.ts/);
  assert.match(redactedSample, /url=<worktree>\/test\/a\.test\.ts:12:3/);
  assert.match(redactedSample, /home=<home>\/notes/);
  assert.ok(redactedSample.includes('-other/keep'), 'boundary prevents replacing sibling directories');

  const checkScript = `
    const fs = require("fs"), os = require("os"), path = require("path"), { pathToFileURL } = require("url");
    fs.mkdirSync(".tmp/test-logs", { recursive: true });
    fs.mkdirSync(".tmp/plugin-ui-shots", { recursive: true });
    const seq = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").length + 1 : 1;
    fs.appendFileSync(process.argv[1], "x");
    fs.writeFileSync(".tmp/test-logs/20261119-00000" + seq + ".log", [
      "✖ broken case (12.3ms)",
      "✖ failing tests:",
      "✖ broken case (12.3ms)",
      "  Error: expected a === b",
      "  at " + pathToFileURL(path.join(process.cwd(), "test", "a.test.ts")).href + ":4:2",
      "  repo=" + process.argv[2] + " home=" + os.homedir(),
      "  http://127.0.0.1/#token=tok_secret Authorization: Bearer hdr_secret",
    ].join("\\n"));
    fs.writeFileSync(".tmp/plugin-ui-shots/failure.png", "PNGFAIL" + seq);
    fs.writeFileSync(".tmp/plugin-ui-shots/step-1.png", "PNGSTEP" + seq);
    console.log("tail token check #token=tok_tail Bearer hdr_tail at " + process.cwd() + " home=" + os.homedir());
    process.exit(1);
  `;
  const r = repo(t, checkScript);
  r.write('.gitignore', '.tmp/\n');
  r.write('.premerge/checks.json', JSON.stringify({
    checks: [{ name: 'probe', argv: [process.execPath, '-e', checkScript, r.log, r.root], timeout_seconds: 30 }],
  }));
  r.commit('ignore .tmp and configure host-path probe');
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const logs: string[] = [];
  const runOnce = () => ship({ ...options(r.root, fakeHub(sha)), log: (line) => logs.push(line) });

  const out = await runOnce();
  assert.equal(out.merged, false);
  assert.ok(!out.merged && out.kind === 'checks');
  assert.ok(out.detail.length <= 4600, `detail within MAX_DETAIL (${out.detail.length})`);
  assert.match(out.detail, /^probe failed twice:/);
  assert.match(out.detail, /✖ broken case/);
  assert.match(out.detail, /saved diagnostics: \.tmp\/ship-failures\//);
  assert.match(out.detail, /logs \(2\): attempt-1\/test-logs\/20261119-000001\.log, attempt-2\/test-logs\/20261119-000002\.log/);
  assert.match(out.detail, /failure screenshots: attempt-1\/shots\/plugin-ui-shots\/failure\.png, attempt-2\/shots\/plugin-ui-shots\/failure\.png/);
  assert.doesNotMatch(out.detail, /tok_secret|hdr_secret|tok_tail|hdr_tail/);
  assert.equal(out.detail.includes(r.root), false, 'shared detail must not leak repo root');
  assert.equal(out.detail.includes(tmpdir()), false, 'shared detail must not leak tmpdir');
  assert.equal(out.detail.includes(homedir()), false, 'shared detail must not leak homedir');
  const localSavedLine = logs.find((line) => line.startsWith('saved failure diagnostics to '));
  assert.ok(localSavedLine, 'local log prints full archive path');

  const failuresRoot = join(r.root, '.tmp', 'ship-failures');
  const runs = readdirSync(failuresRoot);
  assert.equal(runs.length, 1);
  const runDir = join(failuresRoot, runs[0]);
  assert.ok(localSavedLine.endsWith(runDir));
  const savedLog1 = readFileSync(join(runDir, 'attempt-1', 'test-logs', '20261119-000001.log'), 'utf8');
  const savedLog2 = readFileSync(join(runDir, 'attempt-2', 'test-logs', '20261119-000002.log'), 'utf8');
  assert.match(savedLog1, /Error: expected a === b/);
  assert.match(savedLog2, /Error: expected a === b/);
  assert.doesNotMatch(savedLog1, /tok_secret|hdr_secret/);
  assert.doesNotMatch(savedLog2, /tok_secret|hdr_secret/);
  assert.equal(readFileSync(join(runDir, 'attempt-1', 'shots', 'plugin-ui-shots', 'failure.png'), 'utf8'), 'PNGFAIL1');
  assert.equal(readFileSync(join(runDir, 'attempt-2', 'shots', 'plugin-ui-shots', 'failure.png'), 'utf8'), 'PNGFAIL2');
  assert.equal(readFileSync(join(runDir, 'attempt-1', 'shots', 'plugin-ui-shots', 'step-1.png'), 'utf8'), 'PNGSTEP1');
  assert.equal(readFileSync(join(runDir, 'attempt-2', 'shots', 'plugin-ui-shots', 'step-1.png'), 'utf8'), 'PNGSTEP2');
  assert.equal(r.g('status', '--porcelain', '--untracked-files=all'), '', 'main worktree stays clean');
  noLeftovers(r);

  for (let i = 0; i < 11; i++) {
    const next = await runOnce();
    assert.equal(next.merged, false);
  }
  const kept = readdirSync(failuresRoot).sort();
  assert.equal(kept.length, 10, 'rotates to at most 10 failure runs');
  assert.ok(!kept.includes(runs[0]), 'the oldest run was rotated out');
});

test('ship failure diagnostics: preserves attempt-1 failure screenshot deleted during rerun and cleans staging on pass', async (t) => {
  const r1DeleteR2Fail = `
    const fs = require("fs");
    fs.mkdirSync(".tmp/test-logs", { recursive: true });
    fs.mkdirSync(".tmp/plugin-ui-shots", { recursive: true });
    fs.mkdirSync(".tmp/plugin-commands-shots", { recursive: true });
    const seq = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").length + 1 : 1;
    fs.appendFileSync(process.argv[1], "x");
    if (seq === 1) {
      fs.writeFileSync(".tmp/test-logs/20261119-100001.log", "✖ marks failed\\n✖ failing tests:\\n✖ marks failed\\n");
      fs.writeFileSync(".tmp/plugin-ui-shots/failure.png", "ROUND1_MARKS_FAIL");
    } else {
      fs.rmSync(".tmp/plugin-ui-shots/failure.png", { force: true });
      fs.writeFileSync(".tmp/test-logs/20261119-100002.log", "✖ commands failed\\n✖ failing tests:\\n✖ commands failed\\n");
      fs.writeFileSync(".tmp/plugin-commands-shots/failure.png", "ROUND2_CMDS_FAIL");
    }
    process.exit(1);
  `;
  const r = repo(t, r1DeleteR2Fail);
  r.write('.gitignore', '.tmp/\n');
  r.commit('ignore .tmp');
  const sha = r.branch('feature', { 'src.txt': 'code\n' });
  const beforeTmp = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith('orrery-ship-r1-')));

  const out = await ship(options(r.root, fakeHub(sha)));
  assert.equal(out.merged, false);
  assert.ok(!out.merged && out.kind === 'checks');
  assert.match(out.detail, /attempt-1\/shots\/plugin-ui-shots\/failure\.png/);
  assert.match(out.detail, /attempt-2\/shots\/plugin-commands-shots\/failure\.png/);
  const runs = readdirSync(join(r.root, '.tmp', 'ship-failures'));
  assert.equal(runs.length, 1);
  const runDir = join(r.root, '.tmp', 'ship-failures', runs[0]);
  assert.equal(readFileSync(join(runDir, 'attempt-1', 'shots', 'plugin-ui-shots', 'failure.png'), 'utf8'), 'ROUND1_MARKS_FAIL');
  assert.equal(existsSync(join(runDir, 'attempt-2', 'shots', 'plugin-ui-shots', 'failure.png')), false);
  assert.equal(existsSync(join(runDir, 'attempt-2', 'test-logs', '20261119-100001.log')), false, 'unchanged attempt-1 log not duplicated into attempt-2');
  assert.equal(readFileSync(join(runDir, 'attempt-2', 'shots', 'plugin-commands-shots', 'failure.png'), 'utf8'), 'ROUND2_CMDS_FAIL');
  assert.deepEqual(readdirSync(tmpdir()).filter((d) => d.startsWith('orrery-ship-r1-') && !beforeTmp.has(d)), [], 'attempt-1 staging cleaned');

  // If attempt 2 passes, attempt-1 staging is discarded cleanly and no failure directory is kept.
  const passOnRetry = `
    const fs = require("fs");
    fs.mkdirSync(".tmp/test-logs", { recursive: true });
    fs.mkdirSync(".tmp/plugin-ui-shots", { recursive: true });
    const seq = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").length + 1 : 1;
    fs.appendFileSync(process.argv[1], "x");
    if (seq === 1) {
      fs.writeFileSync(".tmp/test-logs/20261119-100003.log", "✖ flaky");
      fs.writeFileSync(".tmp/plugin-ui-shots/failure.png", "FLAKY");
      process.exit(1);
    }
    process.exit(0);
  `;
  const rPass = repo(t, passOnRetry);
  rPass.write('.gitignore', '.tmp/\n');
  rPass.commit('ignore .tmp pass on retry');
  const sha2 = rPass.branch('feature', { 'src.txt': 'code\n' });
  const merged = await ship(options(rPass.root, fakeHub(sha2)));
  assert.equal(merged.merged, true);
  assert.equal(existsSync(join(rPass.root, '.tmp', 'ship-failures')), false);
  assert.deepEqual(readdirSync(tmpdir()).filter((d) => d.startsWith('orrery-ship-r1-') && !beforeTmp.has(d)), [], 'attempt-1 staging cleaned on pass');
});

test('ship failure diagnostics: EPERM while deleting attempt-1 staging still removes temp worktree and reports check result', async (t) => {
  const leaked: string[] = [];
  t.after(() => {
    for (const dir of leaked) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const throwingRemove = (dir: string) => {
    leaked.push(dir);
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };

  // (a) Both check attempts fail while deleting attempt-1 staging throws EPERM.
  const doubleFail = `
    const fs = require("fs");
    fs.mkdirSync(".tmp/test-logs", { recursive: true });
    const seq = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").length + 1 : 1;
    fs.appendFileSync(process.argv[1], "x");
    fs.writeFileSync(".tmp/test-logs/20261119-20000" + seq + ".log", "✖ fail #" + seq + "\\n✖ failing tests:\\n✖ fail #" + seq + "\\n");
    process.exit(1);
  `;
  const rFail = repo(t, doubleFail);
  rFail.write('.gitignore', '.tmp/\n');
  rFail.commit('ignore .tmp');
  const shaFail = rFail.branch('feature', { 'src.txt': 'code\n' });
  const failHub = fakeHub(shaFail);
  const failLogs: string[] = [];
  const outFail = await ship(options(rFail.root, failHub, { log: (line) => failLogs.push(line), removeStaging: throwingRemove }));
  assert.equal(outFail.merged, false);
  assert.ok(!outFail.merged && outFail.kind === 'checks');
  assert.equal(failHub.reports.length, 1);
  assert.ok('failed' in failHub.reports[0] && failHub.reports[0].failed.kind === 'checks');
  noLeftovers(rFail);
  assert.ok(failLogs.some((line) => line.includes('could not remove attempt-1 staging') && line.includes('EPERM')));
  assert.equal(leaked.length, 1);

  // (b) Attempt 1 fails and attempt 2 passes while deleting attempt-1 staging throws EPERM.
  const passOnRetry = `
    const fs = require("fs");
    fs.mkdirSync(".tmp/test-logs", { recursive: true });
    const seq = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").length + 1 : 1;
    fs.appendFileSync(process.argv[1], "x");
    if (seq === 1) {
      fs.writeFileSync(".tmp/test-logs/20261119-200003.log", "✖ flaky");
      process.exit(1);
    }
    process.exit(0);
  `;
  const rPass = repo(t, passOnRetry);
  rPass.write('.gitignore', '.tmp/\n');
  rPass.commit('ignore .tmp pass');
  const shaPass = rPass.branch('feature', { 'src.txt': 'code\n' });
  const passHub = fakeHub(shaPass);
  const passLogs: string[] = [];
  const outPass = await ship(options(rPass.root, passHub, { log: (line) => passLogs.push(line), removeStaging: throwingRemove }));
  assert.equal(outPass.merged, true);
  assert.ok(outPass.merged);
  assert.equal(rPass.g('rev-parse', 'main'), outPass.mergeCommit);
  assert.equal(passHub.reports.length, 1);
  assert.ok('mergeCommit' in passHub.reports[0]);
  noLeftovers(rPass);
  assert.ok(passLogs.some((line) => line.includes('could not remove attempt-1 staging') && line.includes('EPERM')));
  assert.equal(leaked.length, 2);
});

function realGitHubClient(hub: Hub, secret: string, ticket: string) {
  return {
    verify: async () => verifyShip(hub, secret, ticket) as Verified,
    report: async (r: ShipReport) => { await reportShip(hub, secret, { ticket, ...r }); },
  };
}

test('single-task ship_fix: independent reviewer fixes forward, refreshes ticket, guards diffs/replay/rebase, and lands with Reviewed-by marker', async (t) => {
  setBranchLookup({ budgetMs: 60_000 });
  t.after(() => setBranchLookup());
  const r = repo(t);
  // Executor creates branch with src.txt + README edit.
  r.g('checkout', '-q', '-b', 'agent/work');
  r.write('src.txt', 'v1\n');
  r.write('README.md', 'feature readme\n');
  const sha0 = r.commit('feature work');
  r.g('checkout', '-q', 'main');
  // Main modifies README.md to trigger a merge conflict when ship runs.
  r.write('README.md', 'main updated readme\n');
  r.commit('main conflict update');

  const f = hubFixture(t, r.root);
  f.hub.collaboration.prepareTimeoutMs = 60_000;
  const { task, submission: sub0, ticket: ticket0 } = f.approved(sha0);
  const shipOut0 = await ship(options(r.root, realGitHubClient(f.hub, SECRET, ticket0)));
  assert.equal(shipOut0.merged, false);
  const failedDetail0 = f.read(task.id).task;
  assert.equal(failedDetail0.status, 'completed');
  assert.equal(failedDetail0.approvedSubmissionId, sub0.id);
  const failEvent1 = failedDetail0.shipFailure!.eventId;
  assert.deepEqual(failedDetail0.shipFailure?.conflictFiles, ['README.md']);

  const readAs = (actor: CollaborationActor) => f.hub.collaboration.query(actor, 'c', { kind: 'task', taskId: task.id }) as any;
  assert.equal(readAs(b).shipRunnerId, 'b');
  assert.equal(readAs(b).shipFixAllowed, true);
  assert.equal(readAs(a).shipFixAllowed, false);

  const shipFix = (actor: CollaborationActor, cmd: Record<string, unknown>) =>
    f.hub.collaboration.commandAsync(actor, 'c', {
      action: 'task.ship_fix', taskId: task.id, expectedRevision: f.read(task.id).task.revision,
      operationId: crypto.randomUUID(), ...cmd,
    } as any);

  // Sync command() refused with PREPARE_REQUIRED.
  assert.throws(() => f.act(b, task, { action: 'task.ship_fix', failureEventId: failEvent1, commitSha: sha0, summary: 'fix' } as any),
    (e: any) => e.code === 'PREPARE_REQUIRED');

  // Executor a cannot ship_fix an independent member-reviewed task; wrong failureEventId / baseCommitSha / sameCommit / non-ancestor are refused.
  await assert.rejects(() => shipFix(a, { failureEventId: failEvent1, commitSha: sha0, summary: 'x' }), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(() => shipFix(b, { failureEventId: failEvent1 + 99, commitSha: sha0, summary: 'x' }), (e: any) => e.code === 'INVALID_STATE');
  await assert.rejects(() => shipFix(b, { failureEventId: failEvent1, commitSha: sha0, summary: 'same' }), (e: any) => e.code === 'INVALID_REQUEST');
  await assert.rejects(() => shipFix(b, { failureEventId: failEvent1, baseCommitSha: '0000000', commitSha: sha0, summary: 'bad base' }), (e: any) => e.code === 'INVALID_STATE');

  // Rewritten / amended non-ancestor commit is refused 409.
  const amended = r.branch('agent/amended', { 'src.txt': 'amended\n' });
  await assert.rejects(() => shipFix(b, { failureEventId: failEvent1, commitSha: amended, summary: 'rebased' }),
    (e: any) => e.code === 'INVALID_STATE' && /reopen/.test(e.message));

  // Reviewer b merges main into agent/work resolving only README.md conflict + adds a test file (no product-code notice should be sent).
  r.g('checkout', '-q', 'agent/work');
  const tryMerge = spawnSync('git', ['merge', '--no-commit', 'main'], { cwd: r.root, encoding: 'utf8', windowsHide: true });
  assert.notEqual(tryMerge.status, 0);
  r.write('README.md', 'merged readme\n');
  r.write('test/extra.test.ts', 'import test from "node:test";\n');
  r.g('add', '-A');
  r.g('commit', '-qm', 'resolve README conflict and add test');
  const fixSha1 = r.g('rev-parse', 'HEAD');
  r.g('checkout', '-q', 'main');

  const msgBeforeFix1 = f.store.listMessages('c', 200).length;
  const res1 = await shipFix(b, { failureEventId: failEvent1, baseCommitSha: sha0.slice(0, 7), commitSha: fixSha1.slice(0, 10), summary: 'resolved README conflict' });
  assert.equal(res1.task!.status, 'completed');
  assert.equal(res1.task!.shipFailure, null, 'single-task shipFailure cleared after ship_fix');
  assert.equal(res1.task!.approvedSubmissionId, res1.submission!.id);
  assert.equal(res1.submission!.commitSha, fixSha1);
  assert.deepEqual(res1.submission!.shipFix, {
    runnerId: 'b', baseSubmissionId: sub0.id, baseCommitSha: sha0, originSubmissionId: sub0.id, failureEventId: failEvent1,
  });
  const afterMsgs1 = f.store.listMessages('c', 200).slice(msgBeforeFix1);
  assert.equal(afterMsgs1.some((m) => /涉及产品代码|未能只读核对/.test(m.body)), false, 'pure conflict resolution + test files skip product-code diff notice');
  // Second ship_fix without a new failure fails 409; old s1 ticket fails 409.
  await assert.rejects(() => shipFix(b, { failureEventId: failEvent1, commitSha: fixSha1, summary: 'again' }), (e: any) => e.code === 'INVALID_STATE');
  assert.throws(() => verifyShip(f.hub, SECRET, ticket0), status(409), 'old ticket invalidated after ship_fix');

  // Force a checks failure on the refreshed ticket to exercise chained ship_fix + product-code diff notice + final landing.
  const ticket1 = /--ticket (\S+)/.exec((shipForRunner(f.hub, SECRET, 'http://127.0.0.1:9', 'c', task.id, 'b').ship as { command: string }).command)![1];
  assert.equal(verifyShip(f.hub, SECRET, ticket1).shipFix, true);
  r.write('.premerge/checks.json', r.checks('process.exit(1)', r.log));
  r.commit('temporarily fail checks');
  const shipOut1 = await ship(options(r.root, realGitHubClient(f.hub, SECRET, ticket1)));
  assert.equal(shipOut1.merged, false);
  const failEvent2 = f.read(task.id).task.shipFailure!.eventId;
  assert.equal(f.read(task.id).task.shipFailure!.failedCheck, 'probe');

  r.write('.premerge/checks.json', r.checks('require("fs").appendFileSync(process.argv[1], "x")', r.log));
  r.commit('restore passing checks');
  r.g('checkout', '-q', 'agent/work');
  r.write('src/prod.ts', 'export const fixed = true;\n');
  const fixSha2 = r.commit('fix regression in product code');
  r.g('checkout', '-q', 'main');

  const msgBeforeFix2 = f.store.listMessages('c', 200).length;
  const res2 = await shipFix(b, { failureEventId: failEvent2, commitSha: fixSha2, summary: 'fixed product code regression' });
  assert.equal(res2.submission!.shipFix!.originSubmissionId, sub0.id, 'chained ship_fix preserves original originSubmissionId');
  const diffNotice = f.store.listMessages('c', 200).slice(msgBeforeFix2).find((m) => m.body.includes('涉及产品代码'));
  assert.ok(diffNotice, 'modifying product code notifies original executor a');
  assert.deepEqual(diffNotice.mentions, ['a']);
  assert.deepEqual(f.store.withDeliveries([diffNotice])[0].deliveries, [], 'product-code diff notice is infoOnly');

  const ticket2 = /--ticket (\S+)/.exec((shipForRunner(f.hub, SECRET, 'http://127.0.0.1:9', 'c', task.id, 'b').ship as { command: string }).command)![1];
  const shipOut2 = await ship(options(r.root, realGitHubClient(f.hub, SECRET, ticket2)));
  assert.equal(shipOut2.merged, true);
  assert.equal(f.read(task.id).task.status, 'merged');
  assert.equal(f.read(task.id).task.shipFailure, null);
  assert.equal(r.g('log', '-1', '--format=%B', 'main'),
    `[claude-code] fix: Fix the thing\n\nReviewed-by: name-b (task ${task.id.slice(0, 8)}, r1, pass, ${fixSha2.slice(0, 7)}, ship fix)\nCo-Authored-By: Someone <someone@example.invalid>`);
});

test('ship_fix works for both ordinary self-review (null holder) and taken-over self-review, and refuses wrong executors', async (t) => {
  setBranchLookup({ budgetMs: 60_000 });
  t.after(() => setBranchLookup());
  const r = repo(t);
  r.g('checkout', '-q', '-b', 'agent/self');
  r.write('README.md', 'self readme\n');
  const sSelf0 = r.commit('self work');
  r.g('checkout', '-q', '-b', 'agent/taken', 'main');
  r.write('README.md', 'taken readme\n');
  const sTakenOrig = r.commit('orig before takeover');
  r.g('checkout', '-q', 'main');
  r.write('README.md', 'main readme\n');
  r.commit('main advances');

  const f = hubFixture(t, r.root);
  f.hub.collaboration.prepareTimeoutMs = 60_000;

  // (1) Ordinary self-review task (never taken over; selfReviewHolder === null).
  const { task: selfTask } = f.submitted(sSelf0, { kind: 'self' });
  const tSelf0 = /--ticket (\S+)/.exec((shipForRunner(f.hub, SECRET, 'http://127.0.0.1:9', 'c', selfTask.id, 'a').ship as { command: string }).command)![1];
  assert.equal((await ship(options(r.root, realGitHubClient(f.hub, SECRET, tSelf0)))).merged, false);
  const selfFailEv = f.read(selfTask.id).task.shipFailure!.eventId;
  assert.equal((f.hub.collaboration.query(a, 'c', { kind: 'task', taskId: selfTask.id }) as any).shipFixAllowed, true);
  assert.equal((f.hub.collaboration.query(b, 'c', { kind: 'task', taskId: selfTask.id }) as any).shipFixAllowed, false);
  await assert.rejects(() => f.hub.collaboration.commandAsync(b, 'c', {
    action: 'task.ship_fix', taskId: selfTask.id, expectedRevision: f.read(selfTask.id).task.revision,
    operationId: 'self-wrong', failureEventId: selfFailEv, commitSha: sSelf0, summary: 'no',
  } as any), (e: any) => e.code === 'FORBIDDEN');

  r.g('checkout', '-q', 'agent/self');
  spawnSync('git', ['merge', '--no-commit', 'main'], { cwd: r.root, encoding: 'utf8', windowsHide: true });
  r.write('README.md', 'self resolved\n');
  r.g('add', '-A');
  r.g('commit', '-qm', 'self fix conflict');
  const sSelfFix = r.g('rev-parse', 'HEAD');
  r.g('checkout', '-q', 'main');

  await f.hub.collaboration.commandAsync(a, 'c', {
    action: 'task.ship_fix', taskId: selfTask.id, expectedRevision: f.read(selfTask.id).task.revision,
    operationId: 'self-ok', failureEventId: selfFailEv, commitSha: sSelfFix, summary: 'resolved conflict myself',
  } as any);
  const tSelf1 = /--ticket (\S+)/.exec((shipForRunner(f.hub, SECRET, 'http://127.0.0.1:9', 'c', selfTask.id, 'a').ship as { command: string }).command)![1];
  assert.deepEqual(verifyShip(f.hub, SECRET, tSelf1), {
    taskId: selfTask.id, shortId: selfTask.id.slice(0, 8), commitSha: sSelfFix, reviewer: 'name-a', round: 1, verdict: 'self', shipFix: true,
  });
  assert.equal((await ship(options(r.root, realGitHubClient(f.hub, SECRET, tSelf1)))).merged, true);
  assert.match(r.g('log', '-1', '--format=%B', 'main'), /Reviewed-by: name-a \(task .+, r1, self, [0-9a-f]{7}, ship fix\)/);

  // (2) Taken-over self-review task: reviewer b takes over and submits, then ship fails, then b runs ship_fix.
  const { task: takenTask } = f.submitted(sTakenOrig, b);
  f.act(b, takenTask, { action: 'task.takeover' });
  r.g('checkout', '-q', 'agent/taken');
  r.write('src.txt', 'taker commit\n');
  const sTaken1 = r.commit('taker commit');
  r.g('checkout', '-q', 'main');
  f.act(b, takenTask, { action: 'task.submit', assignmentId: f.read(takenTask.id).task.currentAssignmentId!, summary: 'taken over', commitSha: sTaken1 });
  const tTaken0 = /--ticket (\S+)/.exec((shipForRunner(f.hub, SECRET, 'http://127.0.0.1:9', 'c', takenTask.id, 'b').ship as { command: string }).command)![1];
  assert.equal((await ship(options(r.root, realGitHubClient(f.hub, SECRET, tTaken0)))).merged, false);
  const takenFailEv = f.read(takenTask.id).task.shipFailure!.eventId;
  await assert.rejects(() => f.hub.collaboration.commandAsync(a, 'c', {
    action: 'task.ship_fix', taskId: takenTask.id, expectedRevision: f.read(takenTask.id).task.revision,
    operationId: 'taken-wrong', failureEventId: takenFailEv, commitSha: sTaken1, summary: 'no',
  } as any), (e: any) => e.code === 'FORBIDDEN');

  r.g('checkout', '-q', 'agent/taken');
  spawnSync('git', ['merge', '--no-commit', 'main'], { cwd: r.root, encoding: 'utf8', windowsHide: true });
  r.write('README.md', 'taken resolved\n');
  r.g('add', '-A');
  r.g('commit', '-qm', 'taken fix conflict');
  const sTakenFix = r.g('rev-parse', 'HEAD');
  r.g('checkout', '-q', 'main');

  await f.hub.collaboration.commandAsync(b, 'c', {
    action: 'task.ship_fix', taskId: takenTask.id, expectedRevision: f.read(takenTask.id).task.revision,
    operationId: 'taken-ok', failureEventId: takenFailEv, commitSha: sTakenFix, summary: 'taken resolved conflict',
  } as any);
  const tTaken1 = /--ticket (\S+)/.exec((shipForRunner(f.hub, SECRET, 'http://127.0.0.1:9', 'c', takenTask.id, 'b').ship as { command: string }).command)![1];
  assert.deepEqual(verifyShip(f.hub, SECRET, tTaken1), {
    taskId: takenTask.id, shortId: takenTask.id.slice(0, 8), commitSha: sTakenFix, reviewer: 'name-b', round: 1, verdict: 'self', takeover: true, shipFix: true,
  });
  assert.equal((await ship(options(r.root, realGitHubClient(f.hub, SECRET, tTaken1)))).merged, true);
  assert.match(r.g('log', '-1', '--format=%B', 'main'), /Reviewed-by: name-b \(task .+, r1, self, [0-9a-f]{7}, reviewer takeover, ship fix\)/);
});

test('ship_fix refuses user-reviewed / user-approved / HTTP user callers and fails closed on missing repo, unknown commit, timeout and busy; reopen recovers cleanly', async (t) => {
  setBranchLookup({ budgetMs: 60_000 });
  t.after(() => setBranchLookup());
  const r = repo(t);
  const sha = r.branch('agent/u', { 'src.txt': 'code\n' });
  const nextSha = r.branch('agent/u-fix', { 'src.txt': 'code\n' }); // make u-fix a descendant of sha below:
  r.g('checkout', '-q', 'agent/u');
  r.write('src.txt', 'code2\n');
  const descSha = r.commit('forward');
  r.g('checkout', '-q', 'main');
  assert.ok(nextSha);

  const app = await startTestHub();
  t.after(async () => { await app.close(); rmSync(app.dir, { recursive: true, force: true, maxRetries: 5 }); });
  app.hub.collaboration.prepareTimeoutMs = 60_000;
  const clusterId = 'c-http';
  app.hub.store.insertCluster({ id: clusterId, name: 'c', category: '', createdAt: '2026-01-01' }, ['a', 'b'].map((id) => ({
    id, clusterId, name: `name-${id}`, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: r.root, origin: 'attached' as const, removedAt: null,
  })));
  const secret = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  let seq = 0;
  const cmd = (actor: CollaborationActor, body: Record<string, unknown>) =>
    app.hub.collaboration.commandAsync(actor, clusterId, { operationId: `op-${++seq}`, ...body } as any);
  const readTask = (taskId: string, actor: CollaborationActor = user) =>
    app.hub.collaboration.query(actor, clusterId, { kind: 'task', taskId }) as any;

  // (1) User-reviewed task & user-substituted approval both refuse ship_fix 403 and allow reopen.
  const uTask = (await cmd(user, { action: 'task.create', title: 'u', scope: 's', acceptance: 'a', reviewer: user, memberId: 'a' })).task!;
  const uStart = await cmd(a, { action: 'task.start', taskId: uTask.id, expectedRevision: uTask.revision });
  const uSub = await cmd(a, { action: 'task.submit', taskId: uTask.id, expectedRevision: uStart.task!.revision, assignmentId: uStart.assignment!.id, summary: 'ok', commitSha: sha });
  await cmd(user, { action: 'task.review', taskId: uTask.id, expectedRevision: uSub.task!.revision, submissionId: uSub.submission!.id, verdict: 'approve' });
  assert.equal(readTask(uTask.id, a).shipRunnerId, 'a');
  assert.equal(readTask(uTask.id, a).shipFixAllowed, false);
  assert.equal(readTask(uTask.id, user).shipFixAllowed, false);
  const uTicket = /--ticket (\S+)/.exec((shipFor(app.hub, secret, app.url, clusterId, uTask.id).ship as { command: string }).command)![1];
  await reportShip(app.hub, secret, { ticket: uTicket, failed: { kind: 'checks', failedCheck: 'probe', detail: 'fail' } });
  const uFailEv = readTask(uTask.id).task.shipFailure.eventId;
  await assert.rejects(() => cmd(a, { action: 'task.ship_fix', taskId: uTask.id, expectedRevision: readTask(uTask.id).task.revision, failureEventId: uFailEv, commitSha: descSha, summary: 'fix' }),
    (e: any) => e.code === 'FORBIDDEN');
  // HTTP { kind: 'user' } refused FORBIDDEN on task.ship_fix & batch.attribute_failure (HTTP 400 with code FORBIDDEN).
  const httpShipFix = await fetch(`${app.url}/api/clusters/${clusterId}/collaboration`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'task.ship_fix', operationId: 'web-sf', taskId: uTask.id, expectedRevision: readTask(uTask.id).task.revision, failureEventId: uFailEv, commitSha: descSha, summary: 'web' }),
  });
  assert.equal(httpShipFix.status, 400);
  assert.equal((await httpShipFix.json() as { code?: string }).code, 'FORBIDDEN');
  const webBatch = ((await cmd(user, { action: 'batch.create', title: 'web-b', reviewer: b })) as any).batch!;
  const httpAttr = await fetch(`${app.url}/api/clusters/${clusterId}/collaboration`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'batch.attribute_failure', operationId: 'web-attr', batchId: webBatch.id, failureEventId: 1, taskIds: [uTask.id], reason: 'web' }),
  });
  assert.equal(httpAttr.status, 400);
  assert.equal((await httpAttr.json() as { code?: string }).code, 'FORBIDDEN');
  // Verbatim rerun still permitted, and executor a can reopen from shipFailure clearing shipFailure.
  assert.equal(verifyShip(app.hub, secret, uTicket).commitSha, sha);
  const reopened = await cmd(a, { action: 'task.reopen', taskId: uTask.id, expectedRevision: readTask(uTask.id).task.revision, reason: 'need code change' });
  assert.equal(reopened.task!.status, 'pending');
  assert.equal(reopened.task!.shipFailure, null);

  // (2) User approves in place of member reviewer b: neither a nor b may ship_fix.
  const mTask = (await cmd(user, { action: 'task.create', title: 'm', scope: 's', acceptance: 'a', reviewer: b, memberId: 'a' })).task!;
  const mStart = await cmd(a, { action: 'task.start', taskId: mTask.id, expectedRevision: mTask.revision });
  const mSub = await cmd(a, { action: 'task.submit', taskId: mTask.id, expectedRevision: mStart.task!.revision, assignmentId: mStart.assignment!.id, summary: 'ok', commitSha: sha });
  await cmd(user, { action: 'task.review', taskId: mTask.id, expectedRevision: mSub.task!.revision, submissionId: mSub.submission!.id, verdict: 'approve' });
  const mTicket = /--ticket (\S+)/.exec((shipFor(app.hub, secret, app.url, clusterId, mTask.id).ship as { command: string }).command)![1];
  await reportShip(app.hub, secret, { ticket: mTicket, failed: { kind: 'conflict', conflictFiles: ['src.txt'], detail: 'conflict' } });
  const mFailEv = readTask(mTask.id).task.shipFailure.eventId;
  assert.equal(readTask(mTask.id, a).shipFixAllowed, false);
  for (const actor of [a, b]) {
    await assert.rejects(() => cmd(actor, { action: 'task.ship_fix', taskId: mTask.id, expectedRevision: readTask(mTask.id).task.revision, failureEventId: mFailEv, commitSha: descSha, summary: 'fix' }),
      (e: any) => e.code === 'FORBIDDEN');
  }

  // (3) Fail-closed git conditions on an independent member-approved task: unknown_commit, timeout, no_repository, busy.
  const okTask = (await cmd(user, { action: 'task.create', title: 'ok', scope: 's', acceptance: 'a', reviewer: b, memberId: 'a' })).task!;
  const okStart = await cmd(a, { action: 'task.start', taskId: okTask.id, expectedRevision: okTask.revision });
  const okSub = await cmd(a, { action: 'task.submit', taskId: okTask.id, expectedRevision: okStart.task!.revision, assignmentId: okStart.assignment!.id, summary: 'ok', commitSha: sha });
  await cmd(b, { action: 'task.review', taskId: okTask.id, expectedRevision: okSub.task!.revision, submissionId: okSub.submission!.id, verdict: 'approve', reason: 'ok' });
  const okTicket = /--ticket (\S+)/.exec((shipFor(app.hub, secret, app.url, clusterId, okTask.id).ship as { command: string }).command)![1];
  await reportShip(app.hub, secret, { ticket: okTicket, failed: { kind: 'checks', detail: 'fail' } });
  const okFailEv = readTask(okTask.id).task.shipFailure.eventId;

  await assert.rejects(() => cmd(b, { action: 'task.ship_fix', taskId: okTask.id, expectedRevision: readTask(okTask.id).task.revision, failureEventId: okFailEv, commitSha: 'deadbeefdead', summary: 'missing' }),
    (e: any) => e.code === 'INVALID_STATE' && /unknown_commit/.test(e.message));
  setBranchLookup({
    budgetMs: 25,
    runner: (_cwd, _args, sig) => new Promise((_res, rej) => sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
  });
  await assert.rejects(() => cmd(b, { action: 'task.ship_fix', taskId: okTask.id, expectedRevision: readTask(okTask.id).task.revision, failureEventId: okFailEv, commitSha: descSha, summary: 'timeout' }),
    (e: any) => e.code === 'INVALID_STATE' && /timeout/.test(e.message));
  setBranchLookup({ budgetMs: 60_000, runner: async () => '' });
  await assert.rejects(() => cmd(b, { action: 'task.ship_fix', taskId: okTask.id, expectedRevision: readTask(okTask.id).task.revision, failureEventId: okFailEv, commitSha: descSha, summary: 'norepo' }),
    (e: any) => e.code === 'INVALID_STATE' && /no_repository/.test(e.message));

  const gate = Promise.withResolvers<void>();
  let running = 0;
  setBranchLookup({
    budgetMs: 10_000,
    runner: async (cwd, args, sig) => {
      if (args[0] === 'worktree') { running++; try { await gate.promise; } finally { running--; } }
      return gitRead(cwd, args, sig);
    },
  });
  const blockers: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    const ht = (await cmd(user, { action: 'task.create', title: `hold-${i}`, scope: 's', acceptance: 'a', reviewer: user, memberId: 'a' })).task!;
    const hs = await cmd(a, { action: 'task.start', taskId: ht.id, expectedRevision: ht.revision });
    blockers.push(cmd(a, { action: 'task.submit', taskId: ht.id, expectedRevision: hs.task!.revision, assignmentId: hs.assignment!.id, summary: 'hold', commitSha: sha }));
  }
  await waitFor(() => running === 4, 'four lookups holding all slots');
  setBranchLookup({ budgetMs: 80, runner: async (cwd, args, sig) => gitRead(cwd, args, sig) });
  await assert.rejects(() => cmd(b, { action: 'task.ship_fix', taskId: okTask.id, expectedRevision: readTask(okTask.id).task.revision, failureEventId: okFailEv, commitSha: descSha, summary: 'busy' }),
    (e: any) => e.code === 'INVALID_STATE' && /busy/.test(e.message));
  gate.resolve();
  await Promise.all(blockers);
  assert.equal(readTask(okTask.id).task.status, 'completed');
  assert.equal(readTask(okTask.id).task.shipFailure.eventId, okFailEv);
});

test('reopen after ship_failed restores and wakes eligible approved executor, and explains when unavailable', (t) => {
  const f = hubFixture(t);
  const { store, send, act, read } = f;
  const user: CollaborationActor = { kind: 'user' };
  const a: CollaborationActor = { kind: 'member', memberId: 'a' };
  const b: CollaborationActor = { kind: 'member', memberId: 'b' };
  const addRole = (name: string) => send(user, { action: 'role.create', name } as any).role!.id;
  const woke = (eventId: number) => {
    const msg = store.listMessages('c', 200).find((m) => m.collabEventId === eventId);
    if (!msg) return [];
    return store.withDeliveries([msg])[0].deliveries.map((d) => d.memberId).sort();
  };
  const reopenNotice = (eventId: number) => store.listMessages('c', 200).find((m) => m.collabEventId === eventId);

  // (1) Member reviewer reopens ship_failed independent-review task -> assignedMemberId = 'a', 'a' woken, 'b' infoOnly
  const tMember = send(user, { action: 'task.create', title: 'm-reopen', scope: 's', acceptance: 'a', reviewer: b, memberId: 'a' }).task!;
  const st1 = act(a, tMember, { action: 'task.start' });
  const sub1 = act(a, tMember, { action: 'task.submit', assignmentId: st1.assignment!.id, commitSha: 'abcdef0', summary: 'v1' });
  act(b, tMember, { action: 'task.review', submissionId: sub1.submission!.id, verdict: 'approve', reason: 'ok' });
  const ticket1 = /--ticket (\S+)/.exec((shipForRunner(f.hub, SECRET, 'http://127.0.0.1:9', 'c', tMember.id, 'b').ship as { command: string }).command)![1];
  send({ kind: 'system' }, { action: 'task.ship_failed', taskId: tMember.id, expectedRevision: read(tMember.id).task.revision,
    submissionId: read(tMember.id).task.approvedSubmissionId!, reason: 'checks: failed twice' });
  const revReopen1 = act(b, tMember, { action: 'task.reopen', reason: 'fix check' });
  assert.equal(revReopen1.task!.status, 'pending');
  assert.equal(revReopen1.task!.assignedMemberId, 'a');
  assert.deepEqual(woke(revReopen1.eventId), ['a']);
  assert.match(reopenNotice(revReopen1.eventId)!.body, /退回给原执行者 name-a/);

  // (2) User reopens ship_failed independent-review task -> 'a' woken, 'b' infoOnly
  const st2 = act(a, tMember, { action: 'task.start' });
  const sub2 = act(a, tMember, { action: 'task.submit', assignmentId: st2.assignment!.id, commitSha: 'abcdef1', summary: 'v2' });
  act(b, tMember, { action: 'task.review', submissionId: sub2.submission!.id, verdict: 'approve', reason: 'ok2' });
  send({ kind: 'system' }, { action: 'task.ship_failed', taskId: tMember.id, expectedRevision: read(tMember.id).task.revision,
    submissionId: read(tMember.id).task.approvedSubmissionId!, reason: 'conflict: file' });
  const userReopen = act(user, tMember, { action: 'task.reopen', reason: 'rebase needed' });
  assert.equal(userReopen.task!.assignedMemberId, 'a');
  assert.deepEqual(woke(userReopen.eventId), ['a']);
  assert.ok(reopenNotice(userReopen.eventId)!.mentions.includes('b'));
  assert.ok(ticket1);

  // (3) User-reviewed task: user reopen wakes 'a'; executor 'a' reopen keeps assignedMemberId = 'a' without self-wake
  const tUser = send(user, { action: 'task.create', title: 'u-reopen', scope: 's', acceptance: 'a', reviewer: user, memberId: 'a' }).task!;
  const stU1 = act(a, tUser, { action: 'task.start' });
  const subU1 = act(a, tUser, { action: 'task.submit', assignmentId: stU1.assignment!.id, commitSha: 'abcdef2', summary: 'u1' });
  act(user, tUser, { action: 'task.review', submissionId: subU1.submission!.id, verdict: 'approve' });
  send({ kind: 'system' }, { action: 'task.ship_failed', taskId: tUser.id, expectedRevision: read(tUser.id).task.revision,
    submissionId: read(tUser.id).task.approvedSubmissionId!, reason: 'checks: fail' });
  const uReopenByUser = act(user, tUser, { action: 'task.reopen', reason: 'user reopen' });
  assert.equal(uReopenByUser.task!.assignedMemberId, 'a');
  assert.deepEqual(woke(uReopenByUser.eventId), ['a']);

  const stU2 = act(a, tUser, { action: 'task.start' });
  const subU2 = act(a, tUser, { action: 'task.submit', assignmentId: stU2.assignment!.id, commitSha: 'abcdef3', summary: 'u2' });
  act(user, tUser, { action: 'task.review', submissionId: subU2.submission!.id, verdict: 'approve' });
  send({ kind: 'system' }, { action: 'task.ship_failed', taskId: tUser.id, expectedRevision: read(tUser.id).task.revision,
    submissionId: read(tUser.id).task.approvedSubmissionId!, reason: 'checks: fail 2' });
  const uReopenBySelf = act(a, tUser, { action: 'task.reopen', reason: 'self reopen' });
  assert.equal(uReopenBySelf.task!.assignedMemberId, 'a');
  assert.deepEqual(woke(uReopenBySelf.eventId), []);

  // (4) Unavailable prior executor: hidden (never leaks '隐身' to shared chat), coordinator, missing role, removed
  store.insertMembers([{ id: 'extra', clusterId: 'c', name: 'Extra', avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-extra', cwd: '/tmp', origin: 'attached', removedAt: null }]);

  const makeShipFailed = (title: string, extraFields: Record<string, unknown> = {}) => {
    const tk = send(user, { action: 'task.create', title, scope: 's', acceptance: 'a', reviewer: b, memberId: 'extra', ...extraFields }).task!;
    const st = act({ kind: 'member', memberId: 'extra' }, tk, { action: 'task.start' });
    const sb = act({ kind: 'member', memberId: 'extra' }, tk, { action: 'task.submit', assignmentId: st.assignment!.id, commitSha: 'abcdef4', summary: 'done' });
    act(b, tk, { action: 'task.review', submissionId: sb.submission!.id, verdict: 'approve', reason: 'ok' });
    send({ kind: 'system' }, { action: 'task.ship_failed', taskId: tk.id, expectedRevision: read(tk.id).task.revision,
      submissionId: read(tk.id).task.approvedSubmissionId!, reason: 'checks: failed' });
    return tk;
  };

  // (4a) Hidden executor: neither member reopen nor user reopen leaks '隐身' into shared group chat
  const tkHidden1 = makeShipFailed('hidden-by-member');
  const tkHidden2 = makeShipFailed('hidden-by-user');
  f.hub.setMemberHidden('extra', true);
  const hidByMember = act(b, tkHidden1, { action: 'task.reopen', reason: 'reopen hidden 1' });
  assert.equal(hidByMember.task!.assignedMemberId, null);
  assert.deepEqual(woke(hidByMember.eventId), []);
  const hidNoticeM = reopenNotice(hidByMember.eventId)!;
  assert.match(hidNoticeM.body, /不可接受派工/);
  assert.doesNotMatch(hidNoticeM.body, /隐身/, 'member reopen must not leak hidden state to group chat');
  assert.match(hidNoticeM.body, /task_action assign/);

  const hidByUser = act(user, tkHidden2, { action: 'task.reopen', reason: 'reopen hidden 2' });
  assert.equal(hidByUser.task!.assignedMemberId, null);
  const hidNoticeU = reopenNotice(hidByUser.eventId)!;
  assert.match(hidNoticeU.body, /不可接受派工/);
  assert.doesNotMatch(hidNoticeU.body, /隐身/, 'user reopen must not leak hidden state into shared group chat');
  assert.match(hidNoticeU.body, /task_action assign/);
  f.hub.setMemberHidden('extra', false);

  // (4b) Coordinator cannot execute (left unassigned; woken only as enabled coordinator to reassign)
  const tkCoord = makeShipFailed('became-coord');
  send(user, { action: 'coordinator.set', memberId: 'extra', enabled: true, mode: 'suggest' });
  const coordReopen = act(b, tkCoord, { action: 'task.reopen', reason: 'now coordinator' });
  assert.equal(coordReopen.task!.assignedMemberId, null);
  assert.deepEqual(woke(coordReopen.eventId), ['extra']);
  assert.match(reopenNotice(coordReopen.eventId)!.body, /协调员.*task_action assign/);
  send(user, { action: 'coordinator.set', memberId: 'a', enabled: false, mode: 'suggest' });

  // (4c) Missing execute role
  const devRole = addRole('dev');
  store.setCollaborationMemberRoles('extra', [devRole]);
  const tkRole = makeShipFailed('lost-role', { executeRoleIds: [devRole] });
  store.setCollaborationMemberRoles('extra', []);
  const roleReopen = act(b, tkRole, { action: 'task.reopen', reason: 'role missing' });
  assert.equal(roleReopen.task!.assignedMemberId, null);
  assert.deepEqual(woke(roleReopen.eventId), []);
  assert.match(reopenNotice(roleReopen.eventId)!.body, /缺少任务所需执行角色.*task_action assign/);

  // (4d) Removed from cluster
  const tkRemoved = makeShipFailed('removed-member');
  f.hub.removeMember('c', 'extra');
  const remReopen = act(b, tkRemoved, { action: 'task.reopen', reason: 'member left' });
  assert.equal(remReopen.task!.assignedMemberId, null);
  assert.deepEqual(woke(remReopen.eventId), []);
  assert.match(reopenNotice(remReopen.eventId)!.body, /成员已不在本群.*task_action assign/);
});
