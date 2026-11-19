// The automatic branch link at submit (docs/collaboration.md「任务关联本地 Git 分支」, src/plugins/tasks/branch-link.ts):
// read-only git before the transaction, the decision inside it, and the paths that create a submission.
import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CollaborationActor, CollaborationCommand, CollaborationResult } from '../src/core/collaboration-types.ts';
import { git as gitAsync, GIT_READ_ENV, gitRead, gitSync, setGitTreeKill } from '../src/core/projects.ts';
import { BRANCH_LOOKUP_BUDGET_MS, setBranchLookup, type GitRunner } from '../src/plugins/tasks/branch-link.ts';
import { saveCollaborationRecord } from '../src/plugins/tasks/store.ts';
import { bearer, holdScript, startTestHub, tempDir, waitFor, type TestHub, turnsOf, memberHeaders } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim();
const commit = (repo: string, message: string) => {
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};
/** A repository: c1 on main; topic at c2; other at c4 (c3 below it); adv at c6 (c5 below it, the tip of nothing). */
function repository(dir: string) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  const c1 = commit(repo, 'c1');
  git(repo, 'checkout', '-b', 'topic');
  const c2 = commit(repo, 'c2');
  git(repo, 'checkout', '-b', 'other', c1);
  const c3 = commit(repo, 'c3');
  const c4 = commit(repo, 'c4');
  git(repo, 'checkout', '-b', 'adv', c1);
  const c5 = commit(repo, 'c5');
  const c6 = commit(repo, 'c6');
  git(repo, 'checkout', '--detach', c1);
  return { repo, c1, c2, c3, c4, c5, c6 };
}

/** The git subcommands the lookup ran (the read-only set is asserted by the tests). */
function recording(inner: GitRunner = gitRead) {
  const seen: string[][] = [];
  const runner: GitRunner = (cwd, args, signal) => { seen.push(args); return inner(cwd, args, signal); };
  return { seen, runner, subcommands: () => [...new Set(seen.map((args) => args[0]))].sort() };
}

interface Flow {
  app: TestHub; clusterId: string; a: string; b: string; repo: ReturnType<typeof repository>;
  member(id?: string): CollaborationActor;
  task(extra?: Record<string, unknown>): Promise<{ id: string; revision: number }>;
  start(taskId: string, by?: string): { revision: number; assignmentId: string };
  submit(taskId: string, sha: string | undefined, extra?: Record<string, unknown>, by?: string): Promise<CollaborationResult>;
  current(taskId: string): Promise<any>;
}

let serial = 0;
async function flow(t: { after(fn: () => unknown): void }, options: { projectPath?: (dir: string, repo: string) => string } = {}): Promise<Flow> {
  const dir = tempDir();
  const repo = repository(dir);
  const app = await startTestHub({ dir });
  t.after(async () => { setBranchLookup(); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const projectPath = options.projectPath ? options.projectPath(dir, repo.repo) : repo.repo;
  const { cluster, members: [a, b] } = await app.api('POST', '/api/clusters', { name: 'branch link', members: [
    { harness: 'mock', mode: 'native', name: 'A', projectPath }, { harness: 'mock', mode: 'native', name: 'B', projectPath: repo.repo }] });
  const clusterId = cluster.id;
  const member = (id = a.id): CollaborationActor => ({ kind: 'member', memberId: id });
  const current = async (taskId: string) => (await app.api('GET', `/api/clusters/${clusterId}/tasks/${taskId}`)).task;
  return {
    app, clusterId, a: a.id, b: b.id, repo, member, current,
    task: async (extra = {}) => (await app.api('POST', `/api/clusters/${clusterId}/collaboration`, { action: 'task.create', operationId: `create-${++serial}`,
      title: 'Work', scope: 'Scope', acceptance: 'Done', memberId: a.id, ...extra })).task,
    start: (taskId, by = a.id) => {
      const task = app.hub.collaboration.query({ kind: 'user' }, clusterId, { kind: 'task', taskId } as never) as { task: { revision: number } };
      const started = app.hub.collaboration.command(member(by), clusterId, { action: 'task.start', taskId, expectedRevision: task.task.revision, operationId: `start-${++serial}` } as CollaborationCommand);
      return { revision: started.task!.revision, assignmentId: started.assignment!.id };
    },
    submit: async (taskId, sha, extra = {}, by = a.id) => {
      const task = await current(taskId);
      const assignmentId = (await app.api('GET', `/api/clusters/${clusterId}/tasks/${taskId}`)).task.currentAssignmentId;
      return app.hub.collaboration.commandAsync(member(by), clusterId, { action: 'task.submit', taskId, expectedRevision: task.revision, assignmentId,
        summary: 'done', ...(sha === undefined ? {} : { commitSha: sha }), operationId: `submit-${++serial}`, ...extra } as CollaborationCommand);
    },
  };
}

const submitEvents = async (f: Flow, taskId: string) => (await f.app.api('GET', `/api/clusters/${f.clusterId}/tasks/${taskId}`)).events
  .filter((event: any) => event.payload.action === 'task.submit');

test('over MCP: a commit at the tip of one branch links it automatically; get_task, history and a Hub restart keep it', async (t) => {
  const dir = tempDir();
  const repo = repository(dir);
  const hold = holdScript();
  const rec = recording();
  setBranchLookup({ runner: rec.runner });
  let app = await startTestHub({ dir, mock: { script: hold.script } });
  t.after(async () => { setBranchLookup(); hold.release(); await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const { cluster, members: [a] } = await app.api('POST', '/api/clusters', { name: 'mcp link', members: [{ harness: 'mock', mode: 'native', name: 'A', projectPath: join(repo.repo) }] });
  await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hold' });
  await waitFor(() => turnsOf(app, a.id) > 0, 'the turn');
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: memberHeaders(app, a.id) } }));
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as any)[0].text as string;
    assert.notEqual(result.isError, true, text);
    return JSON.parse(text);
  };
  const created = (await call('create_task', { operationId: 'c', title: 'Work', scope: 's', acceptance: 'a' })).task;
  const started = await call('task_action', { operationId: 's', action: 'start', taskId: created.id, expectedRevision: created.revision });
  const submitted = await call('task_action', { operationId: 'u', action: 'submit', taskId: created.id, expectedRevision: started.task.revision,
    assignmentId: started.assignment.id, summary: 'done', commitSha: repo.c2.slice(0, 7).toUpperCase() });
  const link = { repositoryPath: repo.repo, branch: 'topic', automatic: true };
  assert.deepEqual(submitted.gitBranch, { status: 'linked', branch: 'topic', automatic: true });
  assert.deepEqual(submitted.task.gitBranch, link);
  assert.deepEqual(rec.subcommands(), ['for-each-ref', 'rev-parse', 'worktree'], 'only reads');
  assert.deepEqual(rec.seen.find((args) => args[0] === 'for-each-ref'), ['for-each-ref', `--points-at=${repo.c2}`, '--count=6', '--format=%(refname)', 'refs/heads/'],
    'a filtered listing with the full commit');
  const read = await call('get_task', { taskId: created.id, eventDetail: 'full' });
  assert.deepEqual(read.task.gitBranch, link);
  const event = read.events.find((e: any) => e.payload.action === 'task.submit');
  assert.deepEqual(event.payload.changes, [{ field: 'gitBranch', before: null, after: link }], 'the history says it was automatic');
  // A retry of the same operation replays the stored result and does not look again.
  const before = rec.seen.length;
  assert.deepEqual((await call('task_action', { operationId: 'u', action: 'submit', taskId: created.id, expectedRevision: started.task.revision,
    assignmentId: started.assignment.id, summary: 'done', commitSha: repo.c2.slice(0, 7).toUpperCase() })).gitBranch, submitted.gitBranch);
  assert.equal(rec.seen.length, before);
  await client.close();
  hold.release();
  await app.close();
  app = await startTestHub({ dir });
  assert.deepEqual((await app.api('GET', `/api/clusters/${cluster.id}/tasks/${created.id}`)).task.gitBranch, link, 'stored with the task');
});

test('several, none, unknown and unusual branches: nothing is linked and the result says why', async (t) => {
  const f = await flow(t);
  const { repo, c3, c5 } = f.repo;
  const names = ['b1', 'b2', '__proto__', 'constructor', 'x/y', 'ünï', 'z'];
  for (const name of names) git(repo, 'branch', name, c3);
  const rec = recording();
  setBranchLookup({ runner: rec.runner });
  const several = await f.task();
  f.start(several.id);
  const one = await f.submit(several.id, c3);
  assert.deepEqual(one.gitBranch, { status: 'not_linked', reason: 'several_branches',
    candidates: ['__proto__', 'b1', 'b2', 'constructor', 'x/y'], more: true });
  assert.equal(one.task!.gitBranch, undefined);
  for (const name of names.slice(2)) git(repo, 'branch', '-D', name);
  const two = await f.submit(several.id, c3);
  assert.deepEqual(two.gitBranch, { status: 'not_linked', reason: 'several_branches', candidates: ['b1', 'b2'] });

  const none = await f.task();
  f.start(none.id);
  assert.deepEqual((await f.submit(none.id, c5)).gitBranch, { status: 'not_linked', reason: 'no_branch' });
  assert.deepEqual((await f.submit(none.id, 'deadbeefdeadbeef')).gitBranch, { status: 'not_linked', reason: 'unknown_commit' });
  // A short hex string that names a branch is a ref, not the commit: rev-parse would pick the branch.
  git(repo, 'branch', 'abcdef1', f.repo.c2);
  assert.deepEqual((await f.submit(none.id, 'abcdef1')).gitBranch, { status: 'not_linked', reason: 'unknown_commit' });

  // A branch named like an option is listed but never linked or passed to git as one.
  git(repo, 'update-ref', 'refs/heads/-x', f.repo.c6);
  git(repo, 'branch', '-D', 'adv');
  assert.deepEqual((await f.submit(none.id, f.repo.c6)).gitBranch, { status: 'not_linked', reason: 'invalid_branch', candidates: ['-x'] });
  // A branch called HEAD, alone at the tip, is never linked either.
  git(repo, 'update-ref', 'refs/heads/HEAD', f.repo.c5);
  assert.deepEqual((await f.submit(none.id, f.repo.c5)).gitBranch, { status: 'not_linked', reason: 'invalid_branch', candidates: ['HEAD'] });
  git(repo, 'update-ref', '-d', 'refs/heads/HEAD');
  // Candidate names are bounded: an overlong one is left out, and all of them together stay under 2048 characters.
  const long = (letter: string, size: number) => letter.repeat(size);
  writeFileSync(join(repo, '.git', 'packed-refs'), [long('a', 1100), long('b', 600), long('c', 600), long('d', 600), long('e', 600)]
    .map((name) => `${f.repo.c4} refs/heads/${name}`).join('\n') + '\n', { flag: 'a' });
  const bounded = (await f.submit(none.id, f.repo.c4)).gitBranch!;
  assert.deepEqual([bounded.status, bounded.reason, bounded.candidates!.map((name) => name[0] + name.length), bounded.more],
    ['not_linked', 'several_branches', ['b600', 'c600', 'd600'], true]);
  // A name like __proto__ at the tip alone links like any other.
  git(repo, 'branch', '__proto__', f.repo.c5);
  const odd = await f.submit(none.id, f.repo.c5);
  assert.deepEqual(odd.gitBranch, { status: 'linked', branch: '__proto__', automatic: true });
  assert.deepEqual(rec.subcommands(), ['for-each-ref', 'rev-parse', 'worktree']);
  assert.ok(rec.seen.every((args) => args.slice(1).every((arg) => !arg.startsWith('-') || /^--(points-at|count|format)=|^--(verify|quiet|is-ancestor|porcelain)$|^-z$/.test(arg))),
    'no argument from a branch name or sha reads as an option');

  // A hostile commitSha is refused before any git runs.
  const runs = rec.seen.length;
  await assert.rejects(f.submit(none.id, '--upload-pack=calc'), /commitSha must be/);
  assert.equal(rec.seen.length, runs);
});

test('a manual link is never changed; it warns when its branch lacks the commit', async (t) => {
  const f = await flow(t);
  const task = await f.task();
  f.start(task.id);
  const revision = (await f.current(task.id)).revision;
  await f.app.api('POST', `/api/clusters/${f.clusterId}/collaboration`, { action: 'task.set_git_branch', taskId: task.id, expectedRevision: revision,
    operationId: 'manual', gitBranch: { repositoryPath: f.repo.repo, branch: 'other' } });
  const manual = { repositoryPath: f.repo.repo, branch: 'other' };
  const away = await f.submit(task.id, f.repo.c2);
  assert.deepEqual(away.gitBranch, { status: 'kept', branch: 'other', warning: 'not_on_branch' });
  assert.deepEqual(away.task!.gitBranch, manual);
  const on = await f.submit(task.id, f.repo.c3);
  assert.deepEqual(on.gitBranch, { status: 'kept', branch: 'other' }, 'c3 is below the tip of other');
  assert.deepEqual(on.task!.gitBranch, manual);
  assert.ok((await submitEvents(f, task.id)).every((event: any) => event.payload.changes === undefined), 'nothing changed');

  // A manual link whose repository is gone stays; the result says it could not be checked.
  const gone = join(f.app.dir, 'gone');
  mkdirSync(gone);
  git(gone, 'init', '-b', 'main');
  commit(gone, 'g');
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: task.id,
    expectedRevision: (await f.current(task.id)).revision, operationId: 'gone', gitBranch: { repositoryPath: gone, branch: 'main' } } as CollaborationCommand);
  rmSync(gone, { recursive: true, force: true });
  assert.deepEqual((await f.submit(task.id, f.repo.c2)).gitBranch, { status: 'kept', branch: 'main', reason: 'no_repository' });

  // A manual link removed while the lookup checked it: git answered, the link it checked is gone.
  const gate = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: task.id,
    expectedRevision: (await f.current(task.id)).revision, operationId: 'again', gitBranch: { repositoryPath: f.repo.repo, branch: 'other' } } as CollaborationCommand);
  setBranchLookup({ runner: async (cwd, args, signal) => { if (args[0] === 'merge-base') { blocked.resolve(); await gate.promise; } return gitRead(cwd, args, signal); } });
  const pending = f.submit(task.id, f.repo.c3, { expectedRevision: (await f.current(task.id)).revision + 1 });
  await blocked.promise;
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: task.id,
    expectedRevision: (await f.current(task.id)).revision, operationId: 'cleared', gitBranch: null } as CollaborationCommand);
  gate.resolve();
  assert.deepEqual((await pending).gitBranch, { status: 'not_linked', reason: 'changed' });
});

test('an automatic link follows the next submit: moved, kept while it holds the commit, cleared when it does not', async (t) => {
  const f = await flow(t);
  const rec = recording();
  setBranchLookup({ runner: rec.runner });
  const task = await f.task();
  f.start(task.id);
  const auto = (branch: string) => ({ repositoryPath: f.repo.repo, branch, automatic: true });
  assert.deepEqual((await f.submit(task.id, f.repo.c2)).gitBranch, { status: 'linked', branch: 'topic', automatic: true });
  const moved = await f.submit(task.id, f.repo.c4);   // a replacement submit while in review
  assert.deepEqual(moved.gitBranch, { status: 'linked', branch: 'other', automatic: true });
  assert.deepEqual(moved.task!.gitBranch, auto('other'));
  const same = await f.submit(task.id, f.repo.c4);
  assert.deepEqual(same.gitBranch, { status: 'kept', branch: 'other', automatic: true });
  const below = await f.submit(task.id, f.repo.c3);
  assert.deepEqual(below.gitBranch, { status: 'kept', branch: 'other', automatic: true, reason: 'no_branch' }, 'other still contains c3');
  const away = await f.submit(task.id, f.repo.c5);
  assert.deepEqual(away.gitBranch, { status: 'cleared', branch: 'other', reason: 'no_branch' });
  assert.equal(away.task!.gitBranch, undefined);
  assert.deepEqual((await submitEvents(f, task.id)).map((event: any) => event.payload.changes ?? null), [
    [{ field: 'gitBranch', before: null, after: auto('topic') }],
    [{ field: 'gitBranch', before: auto('topic'), after: auto('other') }],
    null, null,
    [{ field: 'gitBranch', before: auto('other'), after: null }],
  ]);
  assert.deepEqual(rec.subcommands(), ['for-each-ref', 'merge-base', 'rev-parse', 'worktree'], 'only reads, the containment check included');

  // An unknown commit (made in another clone, say) is not on the linked branch: the automatic link goes.
  await f.submit(task.id, f.repo.c2);
  assert.deepEqual((await f.submit(task.id, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).gitBranch,
    { status: 'cleared', branch: 'topic', reason: 'unknown_commit' });
  // A tag named like the linked branch is not the branch: topic does not hold c5, although the tag topic does.
  await f.submit(task.id, f.repo.c2);
  git(f.repo.repo, 'tag', 'topic', f.repo.c6);
  assert.deepEqual((await f.submit(task.id, f.repo.c5)).gitBranch, { status: 'cleared', branch: 'topic', reason: 'no_branch' });
});

test('a linked task is looked up in its linked repository; the executor\'s folder only counts without a link', async (t) => {
  const f = await flow(t);
  // Clone B has the same commits, with another branch name at c2.
  const clone = join(f.app.dir, 'clone');
  git(f.app.dir, 'clone', '--quiet', '--no-checkout', f.repo.repo, clone);
  git(clone, 'branch', 'different-topic', f.repo.c2);
  const task = await f.task();
  f.start(task.id);
  const inA = (branch: string) => ({ repositoryPath: f.repo.repo, branch, automatic: true });
  assert.deepEqual((await f.submit(task.id, f.repo.c2)).task!.gitBranch, inA('topic'));
  // The executor's folder moves to clone B: the same commit stays on A's topic, a new one moves within A.
  f.app.hub.store.db.prepare('UPDATE members SET cwd = ? WHERE id = ?').run(clone, f.a);
  const again = await f.submit(task.id, f.repo.c2);
  assert.deepEqual([again.gitBranch, again.task!.gitBranch], [{ status: 'kept', branch: 'topic', automatic: true }, inA('topic')]);
  const next = await f.submit(task.id, f.repo.c4);
  assert.deepEqual([next.gitBranch, next.task!.gitBranch], [{ status: 'linked', branch: 'other', automatic: true }, inA('other')]);
  // Without a link the executor's folder is used: B's branch.
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: task.id,
    expectedRevision: (await f.current(task.id)).revision, operationId: 'clear', gitBranch: null } as CollaborationCommand);
  const inB = await f.submit(task.id, f.repo.c2);
  assert.deepEqual([inB.gitBranch, inB.task!.gitBranch], [{ status: 'linked', branch: 'different-topic', automatic: true },
    { repositoryPath: clone, branch: 'different-topic', automatic: true }]);
  // The linked repository is gone: the link stays and the result says so; nothing moves to another repository.
  f.app.hub.store.db.prepare('UPDATE members SET cwd = ? WHERE id = ?').run(f.repo.repo, f.a);
  rmSync(clone, { recursive: true, force: true });
  const gone = await f.submit(task.id, f.repo.c2);
  assert.deepEqual([gone.gitBranch, gone.task!.gitBranch], [{ status: 'kept', branch: 'different-topic', automatic: true, reason: 'no_repository' },
    { repositoryPath: clone, branch: 'different-topic', automatic: true }]);
});

test('a failed git query is not an answer: links stay, no warning, at the commit and at the branch check', async (t) => {
  const f = await flow(t);
  const fatal = (when: (args: string[]) => boolean): GitRunner => async (cwd, args, signal) => {
    if (when(args)) throw Object.assign(new Error('fatal'), { code: 128, stdout: '' });
    return gitRead(cwd, args, signal);
  };
  const atCommit = (args: string[]) => args[0] === 'rev-parse' && args[3]?.endsWith('^{commit}');
  const atBranch = (args: string[]) => args[0] === 'rev-parse' && args[3]?.startsWith('refs/heads/');
  // An automatic link to topic.
  const auto = await f.task();
  f.start(auto.id);
  await f.submit(auto.id, f.repo.c2);
  const kept = { status: 'kept', branch: 'topic', automatic: true, reason: 'git_error' };
  setBranchLookup({ runner: fatal(atCommit) });
  assert.deepEqual((await f.submit(auto.id, f.repo.c5)).gitBranch, kept, 'resolving the commit failed');
  setBranchLookup({ runner: fatal(atBranch) });
  assert.deepEqual((await f.submit(auto.id, f.repo.c5)).gitBranch, kept, 'checking that topic exists failed');
  // A failure that is a real "not found" (exit 1, nothing printed) is still an answer: the unknown commit clears it.
  setBranchLookup({ runner: async (cwd, args, signal) => {
    if (atCommit(args)) throw Object.assign(new Error('not found'), { code: 1, stdout: '' });
    return gitRead(cwd, args, signal);
  } });
  assert.deepEqual((await f.submit(auto.id, f.repo.c5)).gitBranch, { status: 'cleared', branch: 'topic', reason: 'unknown_commit' });
  // A manual link: kept with git_error, and no unproven warning.
  setBranchLookup();
  const manual = await f.task();
  f.start(manual.id);
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: manual.id,
    expectedRevision: (await f.current(manual.id)).revision, operationId: 'manual', gitBranch: { repositoryPath: f.repo.repo, branch: 'other' } } as CollaborationCommand);
  for (const when of [atCommit, atBranch]) {
    setBranchLookup({ runner: fatal(when) });
    assert.deepEqual((await f.submit(manual.id, f.repo.c2)).gitBranch, { status: 'kept', branch: 'other', reason: 'git_error' });
  }
});

test('set_git_branch after an automatic link makes it manual; after a clear the next submit links again', async (t) => {
  const f = await flow(t);
  const task = await f.task();
  f.start(task.id);
  await f.submit(task.id, f.repo.c2);
  const command = (actor: CollaborationActor, gitBranch: unknown) => f.app.hub.collaboration.command(actor, f.clusterId,
    { action: 'task.set_git_branch', taskId: task.id, expectedRevision: f.app.hub.store.tasks!.task(f.clusterId, task.id)!.revision,
      operationId: `set-${++serial}`, gitBranch } as CollaborationCommand);
  const manual = command(f.member(), { branch: 'topic' });
  assert.deepEqual(manual.task!.gitBranch, { repositoryPath: f.repo.repo, branch: 'topic' }, 'the executor confirmed it: manual now');
  const events = (await f.app.api('GET', `/api/clusters/${f.clusterId}/tasks/${task.id}`)).events;
  assert.deepEqual(events.find((event: any) => event.seq === manual.eventId).payload.changes, [
    { field: 'gitBranch', before: { repositoryPath: f.repo.repo, branch: 'topic', automatic: true }, after: { repositoryPath: f.repo.repo, branch: 'topic' } }]);
  assert.deepEqual((await f.submit(task.id, f.repo.c4)).gitBranch, { status: 'kept', branch: 'topic', warning: 'not_on_branch' });
  command({ kind: 'user' }, null);
  const again = await f.submit(task.id, f.repo.c4);
  assert.deepEqual(again.gitBranch, { status: 'linked', branch: 'other', automatic: true });
});

test('every path that submits a commit links: self review, after a reject, after a failed ship, in a batch', async (t) => {
  const f = await flow(t);
  const user = { kind: 'user' } as const;
  const linked = { status: 'linked', branch: 'topic', automatic: true };
  // Self review completes the task in the same transaction as the link.
  const self = await f.task({ reviewer: { kind: 'self' } });
  f.start(self.id);
  const done = await f.submit(self.id, f.repo.c2);
  assert.deepEqual([done.task!.status, done.gitBranch], ['completed', linked]);

  // After a reject, and after a failed ship: the executor submits again and the link follows.
  const reviewed = await f.task();
  f.start(reviewed.id);
  const first = await f.submit(reviewed.id, f.repo.c2);
  const review = (verdict: string, submissionId: string) => f.app.hub.collaboration.command(user, f.clusterId, { action: 'task.review', taskId: reviewed.id,
    expectedRevision: f.app.hub.store.tasks!.task(f.clusterId, reviewed.id)!.revision, submissionId, verdict, reason: 'r', operationId: `review-${++serial}` } as CollaborationCommand);
  review('reject', first.submission!.id);
  const fixed = await f.submit(reviewed.id, f.repo.c4);
  assert.deepEqual(fixed.gitBranch, { status: 'linked', branch: 'other', automatic: true });
  const approved = review('approve', fixed.submission!.id);
  f.app.hub.collaboration.command({ kind: 'system' }, f.clusterId, { action: 'task.ship_failed', taskId: reviewed.id, expectedRevision: approved.task!.revision,
    submissionId: fixed.submission!.id, reason: 'conflict: x', operationId: `ship-${++serial}` } as CollaborationCommand);
  f.start(reviewed.id);
  const afterShip = await f.submit(reviewed.id, f.repo.c2);
  assert.deepEqual(afterShip.gitBranch, { status: 'linked', branch: 'topic', automatic: true });

  // The resubmission of a completed result whose dependency changed (a new assignment is made inside the submit).
  const userDo = (action: string, taskId: string, extra: Record<string, unknown> = {}) => f.app.hub.collaboration.command(user, f.clusterId, { action, taskId,
    expectedRevision: f.app.hub.store.tasks!.task(f.clusterId, taskId)!.revision, operationId: `user-${++serial}`, ...extra } as CollaborationCommand);
  const upstream = await f.task({ reviewer: { kind: 'self' }, mergeRequired: false, memberId: f.b });
  f.start(upstream.id, f.b);
  await f.submit(upstream.id, undefined, {}, f.b);
  const downstream = await f.task({ dependencyIds: [upstream.id] });
  f.start(downstream.id);
  const result = await f.submit(downstream.id, f.repo.c2);
  userDo('task.review', downstream.id, { submissionId: result.submission!.id, verdict: 'approve' });
  userDo('task.reopen', upstream.id, { reason: 'again' });
  userDo('task.assign', upstream.id, { memberId: f.b });
  f.start(upstream.id, f.b);
  const redone = await f.submit(upstream.id, undefined, {}, f.b);
  const resubmitted = await f.submit(downstream.id, f.repo.c4, { assignmentId: result.submission!.assignmentId,
    expectedDependencyVersions: { [upstream.id]: redone.submission!.id } });
  assert.notEqual(resubmitted.assignment?.id, undefined, 'the resubmission path made a new assignment');
  assert.deepEqual(resubmitted.gitBranch, { status: 'linked', branch: 'other', automatic: true });

  // In a review batch the downstream reads the upstream's branch as the base to build on.
  const batch = (await f.app.api('POST', `/api/clusters/${f.clusterId}/collaboration`, { action: 'batch.create', operationId: 'batch', title: 'b', reviewer: { kind: 'user' } })).batch;
  const up = await f.task({ batchId: batch.id });
  const down = await f.task({ batchId: batch.id, dependencyIds: [up.id], memberId: f.b });
  f.start(up.id);
  assert.deepEqual((await f.submit(up.id, f.repo.c4)).gitBranch, { status: 'linked', branch: 'other', automatic: true });
  const detail = await f.app.api('GET', `/api/clusters/${f.clusterId}/tasks/${down.id}`);
  assert.deepEqual(detail.dependencies[0].batchBase, { submissionId: (await f.current(up.id)).latestSubmissionId, commitSha: f.repo.c4, branch: 'other' });
  const notice = (await f.app.messages(f.clusterId)).find((m) => m.body.includes('前置依赖已就绪（批次内'));
  assert.match(notice!.body, /分支 other/);
});

test('a submit without a commit, by the sync entry or refused, links nothing', async (t) => {
  const f = await flow(t);
  const rec = recording();
  setBranchLookup({ runner: rec.runner });
  const free = await f.task({ mergeRequired: false });
  f.start(free.id);
  const plain = await f.submit(free.id, undefined);
  assert.equal(plain.gitBranch, undefined);
  assert.equal(rec.seen.length, 0, 'no commit, no git');
  // The synchronous entry (HTTP and other callers without the prepare step) does not look.
  const sync = await f.task();
  const started = f.start(sync.id);
  const result = f.app.hub.collaboration.command(f.member(), f.clusterId, { action: 'task.submit', taskId: sync.id, expectedRevision: started.revision,
    assignmentId: started.assignmentId, summary: 's', commitSha: f.repo.c2, operationId: 'sync' } as CollaborationCommand);
  assert.equal(result.gitBranch, undefined);
  assert.equal(result.task!.gitBranch, undefined);
  // Refused after the decision linked (the self-review binding is checked after it): the transaction rolls back.
  const refused = await f.task({ reviewer: { kind: 'self' } });
  f.start(refused.id);
  saveCollaborationRecord(f.app.hub.store, refused.id, 'takeover', { id: 'bound-elsewhere', taskId: refused.id, action: 'task.takeover', by: f.b,
    fromMemberId: f.a, toMemberId: f.b, reviewFrom: { kind: 'self' }, reviewTo: { kind: 'self' }, basis: 'user', previousStatus: 'working',
    previousRejected: false, createdAt: new Date().toISOString() } as { id: string });
  const before = rec.seen.length;
  await assert.rejects(f.submit(refused.id, f.repo.c2), (error: any) => error.code === 'FORBIDDEN' && /self review on this taken-over task/.test(error.message));
  assert.ok(rec.seen.some((args, i) => i >= before && args[0] === 'for-each-ref'), 'the lookup ran to the branch listing');
  const after = await f.current(refused.id);
  assert.deepEqual([after.gitBranch, after.latestSubmissionId], [undefined, null], 'neither the submission nor the link was stored');
});

test('only a submit that could succeed starts git: not another member, not a wrong assignment, not a malformed request', async (t) => {
  const f = await flow(t);
  const rec = recording();
  setBranchLookup({ runner: rec.runner });
  const task = await f.task();
  f.start(task.id);
  const refuse = async (extra: Record<string, unknown>, by: string, code: string) =>
    assert.rejects(f.submit(task.id, f.repo.c2, extra, by), (error: any) => error.code === code);
  await refuse({}, f.b, 'STALE_ASSIGNMENT');
  await refuse({ assignmentId: 'not-the-assignment' }, f.a, 'STALE_ASSIGNMENT');
  await refuse({ operationId: 'x'.repeat(201) }, f.a, 'INVALID_REQUEST');
  await refuse({ operationId: '   ' }, f.a, 'INVALID_REQUEST');
  assert.equal(rec.seen.length, 0, 'no git process was started');
  // A manual link elsewhere does not let another member make the Hub read that repository either.
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: task.id,
    expectedRevision: (await f.current(task.id)).revision, operationId: 'manual', gitBranch: { repositoryPath: f.repo.repo, branch: 'other' } } as CollaborationCommand);
  await refuse({}, f.b, 'STALE_ASSIGNMENT');
  assert.equal(rec.seen.length, 0);
  assert.equal((await f.submit(task.id, f.repo.c2)).gitBranch?.status, 'kept', 'the executor still gets a lookup');
  assert.ok(rec.seen.length > 0);
});

test('lookups share four slots; a submit that waits past its budget goes on unlinked as busy', { timeout: 30_000 }, async (t) => {
  const f = await flow(t);
  const gate = Promise.withResolvers<void>();
  let running = 0, most = 0;
  const runner: GitRunner = async (cwd, args, signal) => {
    if (args[0] === 'worktree') { running++; most = Math.max(most, running); try { await gate.promise; } finally { running--; } }
    return gitRead(cwd, args, signal);
  };
  const tasks = [];
  for (let i = 0; i < 6; i++) { const task = await f.task(); f.start(task.id); tasks.push(task); }
  // Four lookups hold the slots (with a long budget) ...
  setBranchLookup({ budgetMs: 10_000, runner });
  const holders = tasks.slice(0, 4).map((task) => f.submit(task.id, f.repo.c2));
  await waitFor(() => running === 4, 'four lookups running');
  // ... so two more wait for a slot, and their budget runs out while they wait.
  setBranchLookup({ budgetMs: 300, runner });
  const begun = performance.now();
  const waiting = await Promise.all(tasks.slice(4).map((task) => f.submit(task.id, f.repo.c2)));
  const took = performance.now() - begun;
  assert.deepEqual(waiting.map((result) => result.gitBranch), [{ status: 'not_linked', reason: 'busy' }, { status: 'not_linked', reason: 'busy' }]);
  assert.ok(took < 300 + 1000, `waiting for a slot stays inside the budget (took ${took} ms)`);
  assert.equal(most, 4, 'never more than four lookups at once');
  gate.resolve();
  assert.deepEqual((await Promise.all(holders)).map((result) => result.gitBranch!.status), ['linked', 'linked', 'linked', 'linked']);
  setBranchLookup({ runner });
  const later = await f.task();
  f.start(later.id);
  assert.equal((await f.submit(later.id, f.repo.c2)).gitBranch?.status, 'linked', 'the slots were given back');
  assert.equal(most, 4);
});

test('a missing folder, no repository, no git, a git error or a hung git never fail or hold a submit', { timeout: 30_000 }, async (t) => {
  const f = await flow(t, { projectPath: (dir) => { const plain = join(dir, 'plain'); mkdirSync(plain); return plain; } });
  const task = await f.task();
  f.start(task.id);
  assert.deepEqual((await f.submit(task.id, f.repo.c2)).gitBranch, { status: 'not_linked', reason: 'no_repository' }, 'a folder that is not a repository');
  rmSync(join(f.app.dir, 'plain'), { recursive: true, force: true });
  assert.deepEqual((await f.submit(task.id, f.repo.c2)).gitBranch, { status: 'not_linked', reason: 'no_repository' }, 'a folder that is gone');

  // B works in the repository and gets an automatic link; failures afterwards keep it.
  const other = await f.task({ memberId: f.b });
  f.start(other.id, f.b);
  assert.equal((await f.submit(other.id, f.repo.c2, {}, f.b)).gitBranch?.status, 'linked');
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  setBranchLookup({ runner: async () => { throw missing; } });
  assert.deepEqual((await f.submit(other.id, f.repo.c4, {}, f.b)).gitBranch, { status: 'kept', branch: 'topic', automatic: true, reason: 'git_unavailable' });
  setBranchLookup({ runner: async (cwd, args, signal) => { if (args[0] === 'for-each-ref') throw Object.assign(new Error('fatal'), { code: 128 }); return gitRead(cwd, args, signal); } });
  assert.deepEqual((await f.submit(other.id, f.repo.c4, {}, f.b)).gitBranch, { status: 'kept', branch: 'topic', automatic: true, reason: 'git_error' });

  // A git that never answers (and ignores the abort): the submit returns once the budget is spent.
  let aborted = false;
  setBranchLookup({ runner: (_cwd, _args, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } });
  const begun = performance.now();
  const hung = await f.submit(other.id, f.repo.c4, {}, f.b);
  const took = performance.now() - begun;
  assert.deepEqual(hung.gitBranch, { status: 'kept', branch: 'topic', automatic: true, reason: 'timeout' });
  assert.equal(hung.submission!.commitSha, f.repo.c4, 'the submission is stored');
  assert.ok(took >= BRANCH_LOOKUP_BUDGET_MS - 50 && took < BRANCH_LOOKUP_BUDGET_MS + 1000, `took ${took} ms`);
  assert.ok(aborted, 'git is told to stop');
});

test('concurrent submits: the link follows the submission stored last, and a link changed meanwhile is re-read', async (t) => {
  const f = await flow(t);
  const task = await f.task();
  f.start(task.id);
  // The lookup for the later-stored submit waits in for-each-ref until the other submit has committed.
  const gate = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  setBranchLookup({ runner: async (cwd, args, signal) => {
    if (args[0] === 'for-each-ref' && args[1] === `--points-at=${f.repo.c5}`) { blocked.resolve(); await gate.promise; }
    return gitRead(cwd, args, signal);
  } });
  const revision = (await f.current(task.id)).revision;
  const assignmentId = (await f.current(task.id)).currentAssignmentId;
  const send = (sha: string, expectedRevision: number) => f.app.hub.collaboration.commandAsync(f.member(), f.clusterId, { action: 'task.submit', taskId: task.id,
    expectedRevision, assignmentId, summary: 's', commitSha: sha, operationId: `race-${sha}` } as CollaborationCommand);
  const late = send(f.repo.c5, revision + 1);   // looked up while the task had no link
  await blocked.promise;
  const early = await send(f.repo.c2, revision);
  assert.deepEqual(early.gitBranch, { status: 'linked', branch: 'topic', automatic: true });
  gate.resolve();
  const last = await late;
  // c5 is on no branch tip and topic does not hold it: the link made meanwhile must not survive for the latest submission.
  assert.deepEqual(last.gitBranch, { status: 'cleared', branch: 'topic', reason: 'changed' }, 'the lookup checked no link; topic came later');
  const stored = await f.current(task.id);
  assert.equal(stored.latestSubmissionId, last.submission!.id);
  assert.equal(stored.gitBranch, undefined);

  // A manual link set while a lookup runs is kept as it is.
  const gate2 = Promise.withResolvers<void>();
  const blocked2 = Promise.withResolvers<void>();
  setBranchLookup({ runner: async (cwd, args, signal) => {
    if (args[0] === 'for-each-ref') { blocked2.resolve(); await gate2.promise; }
    return gitRead(cwd, args, signal);
  } });
  const now = await f.current(task.id);
  const pending = send(f.repo.c4, now.revision + 1);
  await blocked2.promise;
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: task.id, expectedRevision: now.revision,
    operationId: 'manual-meanwhile', gitBranch: { repositoryPath: f.repo.repo, branch: 'adv' } } as CollaborationCommand);
  gate2.resolve();
  assert.deepEqual((await pending).gitBranch, { status: 'kept', branch: 'adv', reason: 'changed' });
  assert.deepEqual((await f.current(task.id)).gitBranch, { repositoryPath: f.repo.repo, branch: 'adv' });

  // The executor's folder changed while its lookup ran: what was read there no longer counts.
  const fresh = await f.task();
  f.start(fresh.id);
  const gate3 = Promise.withResolvers<void>();
  const blocked3 = Promise.withResolvers<void>();
  setBranchLookup({ runner: async (cwd, args, signal) => {
    if (args[0] === 'for-each-ref') { blocked3.resolve(); await gate3.promise; }
    return gitRead(cwd, args, signal);
  } });
  const moving = f.submit(fresh.id, f.repo.c2);
  await blocked3.promise;
  f.app.hub.store.db.prepare('UPDATE members SET cwd = ? WHERE id = ?').run(f.app.dir, f.a);
  gate3.resolve();
  assert.deepEqual((await moving).gitBranch, { status: 'not_linked', reason: 'changed' });
  assert.equal((await f.current(fresh.id)).gitBranch, undefined);
});

test('a submit looks only in the submitting executor’s own folder', async (t) => {
  // A's folder is another repository without these commits; B's folder holds them.
  const f = await flow(t, { projectPath: (dir) => {
    const own = join(dir, 'own'); mkdirSync(own); git(own, 'init', '-b', 'main'); commit(own, 'x'); return own;
  } });
  const task = await f.task();
  f.start(task.id);
  assert.deepEqual((await f.submit(task.id, f.repo.c2)).gitBranch, { status: 'not_linked', reason: 'unknown_commit' });
});

/** A repository configured as a partial clone whose promisor remote's upload-pack is a script that leaves a marker. */
function promisorRepository(dir: string) {
  const fwd = (path: string) => path.replace(/\\/g, '/');
  const marker = join(dir, 'MARKER');
  const program = join(dir, 'upload-pack.sh');
  writeFileSync(program, `#!/bin/sh\necho ran >> "${fwd(marker)}"\nexit 1\n`, { mode: 0o755 });
  const origin = join(dir, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-b', 'main');
  const missing = commit(origin, 'only in origin');
  const repo = join(dir, 'promisor');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  for (const [key, value] of [['remote.origin.url', fwd(origin)], ['remote.origin.uploadpack', fwd(program)], ['remote.origin.promisor', 'true'],
    ['remote.origin.partialclonefilter', 'blob:none'], ['extensions.partialClone', 'origin']]) git(repo, 'config', key, value);
  commit(repo, 'local');
  return { repo, marker, missing };
}

test('in a partial clone no Hub git fetches a missing object: no transport program runs, the commit is unknown', async (t) => {
  let made!: ReturnType<typeof promisorRepository>;
  const f = await flow(t, { projectPath: (dir) => (made = promisorRepository(dir)).repo });
  const task = await f.task();
  f.start(task.id);
  assert.deepEqual((await f.submit(task.id, made.missing)).gitBranch, { status: 'not_linked', reason: 'unknown_commit' });
  assert.equal(existsSync(made.marker), false, 'the configured upload-pack did not run');
  // The sibling read paths share the environment: git (project listing, branch picker), gitSync (ship's checks, set_git_branch).
  for (const args of [['rev-parse', '--verify', '--quiet', `${made.missing}^{commit}`], ['merge-base', '--is-ancestor', made.missing, 'refs/heads/main'],
    ['cat-file', '-e', made.missing]]) {
    await assert.rejects(gitAsync(made.repo, ...args));
    assert.throws(() => gitSync(made.repo, ...args));
    await assert.rejects(gitRead(made.repo, args, new AbortController().signal));
  }
  assert.equal(existsSync(made.marker), false, 'no read path started the transport');
  assert.deepEqual([GIT_READ_ENV.GIT_NO_LAZY_FETCH, GIT_READ_ENV.GIT_ALLOW_PROTOCOL, GIT_READ_ENV.GIT_TERMINAL_PROMPT, GIT_READ_ENV.GCM_INTERACTIVE],
    ['1', 'none', '0', 'never']);
  // Control: plain git with the same read does start the transport, so the marker above would have shown it.
  const plain = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  try { execFileSync('git', ['rev-parse', '--verify', '--quiet', `${made.missing}^{commit}`], { cwd: made.repo, env: plain, stdio: 'pipe', windowsHide: true }); } catch { /* fails either way */ }
  assert.equal(existsSync(made.marker), true, 'control: without the Hub environment git runs the program');
});

test('an aborted read ends git and everything it started', { timeout: 30_000 }, async (t) => {
  const dir = tempDir();
  git(dir, 'init', '-b', 'main');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  t.after(() => { server.close(); });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  // Only this descendant holds the other end of the connection. If the tree kill misses it, it exits on its own.
  writeFileSync(join(dir, 'hold.cjs'), `
    const socket = require('node:net').connect(${port}, '127.0.0.1', () => socket.write('!'));
    setTimeout(() => {
      require('node:fs').writeFileSync('expired', '');
      process.exit(0);
    }, 15_000);
  `);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const connected = once(server, 'connection', { signal: AbortSignal.timeout(5000) });
  const result = gitRead(dir, ['-c', 'alias.hold=!node ./hold.cjs', 'hold'], controller.signal)
    .then(() => undefined, (error: Error) => error);
  const [peer] = await connected as [Socket];
  t.after(() => { peer.destroy(); });
  const [ready] = await once(peer, 'data', { signal: AbortSignal.timeout(5000) });
  assert.equal(ready.toString(), '!');
  let socketError: NodeJS.ErrnoException | undefined;
  peer.on('error', (error) => { socketError = error; });
  controller.abort();
  assert.equal((await result)?.name, 'AbortError');
  await waitFor(() => peer.destroyed, 'the descendant to release its connection', 8000);
  if (socketError) assert.equal(socketError.code, 'ECONNRESET');
  assert.equal(existsSync(join(dir, 'expired')), false, 'the descendant stopped before its own deadline');
});

test('output past the cap: the read rejects once, git is asked to stop once, later output is dropped', { timeout: 20_000 }, async (t) => {
  const dir = tempDir();
  git(dir, 'init', '-b', 'main');
  writeFileSync(join(dir, 'large-blob'), Buffer.alloc(4 * 1024 * 1024, 'x'));
  const oid = git(dir, 'hash-object', '-w', 'large-blob');
  const closed = Promise.withResolvers<number | null>();
  let observed: ChildProcess | undefined;
  let kills = 0;
  let rejections = 0;
  // The hook observes the exact child and lets cat-file finish writing its finite blob.
  setGitTreeKill((child) => {
    kills++;
    if (observed) return;
    observed = child;
    child.once('close', (code) => closed.resolve(code));
  });
  t.after(() => { setGitTreeKill(); observed?.stdout?.resume(); });
  const controller = new AbortController();
  const read = gitRead(dir, ['cat-file', 'blob', oid], controller.signal)
    .catch((error: Error) => { rejections++; throw error; });
  await assert.rejects(read, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  assert.ok(observed?.stdout);
  assert.equal(observed.stdout.listenerCount('data'), 0, 'the collector was removed at the cap');
  controller.abort();   // a second reason to stop the same read
  assert.equal(await closed.promise, 0, 'git finished writing the blob and exited naturally');
  assert.equal(observed.stdout.readableLength, 0, 'later output was drained');
  assert.equal(rejections, 1);
  assert.equal(kills, 1);
});

/** A parent repository with an ordinary clone nested inside it; commit c1 has outer-topic outside and inner-topic inside. */
function nestedRepositories(dir: string) {
  const outer = join(dir, 'outer');
  mkdirSync(outer);
  git(outer, 'init', '-b', 'main');
  commit(outer, 'c0');
  git(outer, 'checkout', '-b', 'outer-topic');
  const c1 = commit(outer, 'c1');
  git(outer, 'checkout', 'main');
  const inner = join(outer, 'inner');
  git(outer, 'clone', '--quiet', '--no-checkout', outer, inner);
  git(inner, 'branch', 'inner-topic', c1);
  return { outer, inner, c1 };
}

test('a linked repository moved away from inside a parent repository is not replaced by the parent', async (t) => {
  let nest!: ReturnType<typeof nestedRepositories>;
  const f = await flow(t, { projectPath: (dir) => (nest = nestedRepositories(dir)).inner });
  const rec = recording();
  setBranchLookup({ runner: rec.runner });
  const auto = await f.task();
  f.start(auto.id);
  const linked = await f.submit(auto.id, nest.c1);
  assert.deepEqual(linked.task!.gitBranch, { repositoryPath: nest.inner, branch: 'inner-topic', automatic: true });
  const manual = await f.task();
  f.start(manual.id);
  f.app.hub.collaboration.command({ kind: 'user' }, f.clusterId, { action: 'task.set_git_branch', taskId: manual.id,
    expectedRevision: (await f.current(manual.id)).revision, operationId: 'manual', gitBranch: { repositoryPath: nest.inner, branch: 'inner-topic' } } as CollaborationCommand);
  // The nested clone moves away; an empty directory takes its place, still inside the parent repository.
  renameSync(nest.inner, join(f.app.dir, 'moved'));
  mkdirSync(nest.inner);
  const answeredAfter = (from: number) => rec.seen.slice(from).map((args) => args[0]);
  let from = rec.seen.length;
  const again = await f.submit(auto.id, nest.c1);
  assert.deepEqual([again.gitBranch, again.task!.gitBranch], [{ status: 'kept', branch: 'inner-topic', automatic: true, reason: 'no_repository' },
    { repositoryPath: nest.inner, branch: 'inner-topic', automatic: true }]);
  assert.deepEqual(answeredAfter(from), ['worktree'], 'only the identity check ran; nothing was asked of the parent repository');
  from = rec.seen.length;
  const kept = await f.submit(manual.id, nest.c1);
  assert.deepEqual(kept.gitBranch, { status: 'kept', branch: 'inner-topic', reason: 'no_repository' }, 'no warning from the parent repository');
  assert.deepEqual(answeredAfter(from), ['worktree']);
  // set_git_branch by the executor does not quietly re-point the link to the parent either.
  assert.throws(() => f.app.hub.collaboration.command(f.member(), f.clusterId, { action: 'task.set_git_branch', taskId: auto.id,
    expectedRevision: f.app.hub.store.tasks!.task(f.clusterId, auto.id)!.revision, operationId: 'repoint', gitBranch: { branch: 'outer-topic' } } as CollaborationCommand),
    (error: any) => error.code === 'INVALID_REQUEST' && /no longer at its path/.test(error.message));
  assert.deepEqual((await f.current(auto.id)).gitBranch, { repositoryPath: nest.inner, branch: 'inner-topic', automatic: true });
});

test('a healthy link is recognised from a linked worktree too, with no spurious no_repository', async (t) => {
  let worktree = '';
  const f = await flow(t, { projectPath: (dir, repo) => { worktree = join(dir, 'linked worktree'); git(repo, 'worktree', 'add', '--quiet', '-b', 'wt', worktree); return worktree; } });
  const task = await f.task();
  f.start(task.id);
  const first = await f.submit(task.id, f.repo.c2);
  assert.deepEqual(first.task!.gitBranch, { repositoryPath: f.repo.repo, branch: 'topic', automatic: true }, 'stored as the main worktree');
  assert.deepEqual((await f.submit(task.id, f.repo.c4)).gitBranch, { status: 'linked', branch: 'other', automatic: true });
  // The executor confirms it by hand from the worktree: same repository, accepted.
  const confirmed = f.app.hub.collaboration.command(f.member(), f.clusterId, { action: 'task.set_git_branch', taskId: task.id,
    expectedRevision: (await f.current(task.id)).revision, operationId: 'confirm', gitBranch: { branch: 'other' } } as CollaborationCommand);
  assert.deepEqual(confirmed.task!.gitBranch, { repositoryPath: f.repo.repo, branch: 'other' });
  assert.deepEqual((await f.submit(task.id, f.repo.c3)).gitBranch, { status: 'kept', branch: 'other' });
});
