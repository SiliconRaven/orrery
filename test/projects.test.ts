import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { CollaborationError } from '../src/core/collaboration.ts';
import { sameRepositoryPath } from '../src/core/projects.ts';
import type { ProjectInfo, SessionInfo } from '../src/core/types.ts';
import { startTestHub, tempDir } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
function init(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, 'init');
  git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
}

test('task repository paths are compared lexically without filesystem lookups', (t) => {
  const path = process.platform === 'win32' ? 'C:\\Work\\Repo' : '/work/repo';
  const native = t.mock.method(realpathSync, 'native', () => { throw new Error('unexpected filesystem lookup'); });
  assert.equal(sameRepositoryPath(path, path.replaceAll('\\', '/') + '/sub/..'), true);
  assert.equal(sameRepositoryPath(path, path.toUpperCase()), process.platform === 'win32');
  assert.equal(sameRepositoryPath(path, path + '-alias'), false);
  assert.equal(native.mock.callCount(), 0);
});

test('Hub groups discovered Git worktrees while retaining session cwd', async () => {
  const dir = tempDir();
  const main = join(dir, 'main', 'repo');
  const external = join(dir, 'external worktree');
  const child = join(main, 'subdirectory');
  const nested = join(main, 'nested');
  const other = join(dir, 'other', 'repo');
  const plain = join(dir, 'plain');
  const missing = join(dir, 'missing');
  init(main);
  git(main, 'worktree', 'add', '-b', 'external', external);
  mkdirSync(child);
  init(nested);
  init(other);
  mkdirSync(plain);
  const paths = [main, external, child, nested, other, plain, missing];
  const projects: ProjectInfo[] = paths.map((path, i) => ({ path, label: basename(path), updatedAt: `2026-01-0${i + 1}` }));
  const sessions: SessionInfo[] = paths.map((cwd, i) => ({ id: `s${i}`, title: `session ${i}`, cwd, model: null, updatedAt: projects[i].updatedAt }));
  const native = createMockNativeAdapter({ projects, sessions });
  const app = await startTestHub({ nativeAdapters: { mock: native } });
  try {
    const grouped = await app.hub.listProjects('mock');
    assert.equal(grouped.length, 5);
    assert.deepEqual(grouped.find((p) => p.path === main), { path: main, label: 'repo', updatedAt: projects[2].updatedAt });
    assert.ok(grouped.some((p) => p.path === nested));
    assert.ok(grouped.some((p) => p.path === other));
    assert.ok(grouped.some((p) => p.path === plain));
    assert.ok(grouped.some((p) => p.path === missing));
    for (const path of [main, external, child]) {
      assert.deepEqual((await app.hub.listSessions('mock', path)).map((s) => [s.id, s.cwd]),
        [['s2', child], ['s1', external], ['s0', main]]);
    }
    assert.deepEqual((await app.hub.listSessions('mock', nested)).map((s) => s.id), ['s3']);
    assert.deepEqual((await app.hub.listSessions('mock', missing)).map((s) => s.id), ['s6']);
    const query = encodeURIComponent(main);
    const webProjects = await app.api('GET', '/api/harnesses/mock/projects?mode=native');
    assert.equal(webProjects.filter((p: ProjectInfo) => p.path === main).length, 1);
    const webSessions = await app.api('GET', `/api/harnesses/mock/sessions?mode=native&project=${query}`);
    assert.equal(webSessions.find((s: SessionInfo) => s.id === 's1').cwd, external);
    const { members } = await app.api('POST', '/api/clusters', { name: 'group', members: [{ harness: 'mock', mode: 'native', sessionId: 's1' }] });
    assert.equal(members[0].cwd, external);

    const later = join(dir, 'later worktree');
    git(main, 'worktree', 'add', '-b', 'later', later);
    projects.push({ path: later, label: 'later', updatedAt: '2026-02-01' });
    // Native mock copies sessions on construction; mutate its test lister to simulate a refreshed discovery.
    const laterSession = { id: 'later', title: 'later', model: null, cwd: later, updatedAt: '2026-02-01' };
    const list = native.listSessions;
    native.listSessions = async (path) => path === later ? [laterSession, sessions[0]] : list(path);
    assert.equal((await app.hub.listProjects('mock')).find((p) => p.path === main)?.updatedAt, '2026-02-01');
    const refreshed = await app.hub.listSessions('mock', main);
    assert.equal(refreshed[0].cwd, later);
    assert.equal(refreshed.filter((s) => s.id === 's0').length, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Git unavailable falls back to the original path', () => {
  const dir = tempDir();
  try {
    init(dir);
    const source = new URL('../src/core/projects.ts', import.meta.url).href;
    const script = `import { projectIdentities } from ${JSON.stringify(source)}; console.log(JSON.stringify(await projectIdentities([process.argv[1]])));`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script, dir], {
      env: { ...process.env, PATH: '' }, encoding: 'utf8', windowsHide: true,
    });
    assert.deepEqual(JSON.parse(result), [{ key: `path:${dir}`, path: dir }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a task links to local Git without a remote, records history and limits edits to the user and executor', async () => {
  const dir = tempDir();
  const main = join(dir, 'repo');
  const linked = join(dir, 'linked worktree');
  const child = join(linked, 'subdirectory');
  const outside = join(dir, 'another repo');
  init(main);
  init(outside);
  git(main, 'worktree', 'add', '-b', 'topic/worktree', linked);
  mkdirSync(child);
  assert.equal(git(main, 'remote').toString().trim(), '');
  const native = createMockNativeAdapter({ sessions: [
    { id: 'main', title: 'Primary', model: null, cwd: main, updatedAt: null },
    { id: 'linked', title: 'Linked', model: null, cwd: child, updatedAt: null },
  ] });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native } });
  try {
    const { cluster, members: [executor, other] } = await app.api('POST', '/api/clusters', { name: 'task branch link', members: [
      { harness: 'mock', mode: 'native', sessionId: 'linked', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 'main', name: 'B' },
    ] });
    const path = `/api/clusters/${cluster.id}`;
    const repositories = `${path}/task-repositories`;
    assert.deepEqual(await app.api('GET', repositories), { repositories: [{ path: main, label: 'repo' }] });
    const listed = await app.api('GET', `${repositories}?path=${encodeURIComponent(child)}`);
    assert.deepEqual(listed.repository, { path: main, label: 'repo' });
    assert.ok(listed.branches.includes('topic/worktree'));
    assert.equal((await app.api('GET', `${repositories}?path=${encodeURIComponent(outside)}`)).repository.path, outside);
    await assert.rejects(app.api('GET', `${repositories}?path=relative`), /INVALID_REQUEST/);
    await assert.rejects(app.api('GET', `/api/clusters/missing/task-repositories`), /OUT_OF_SCOPE/);

    const command = `${path}/collaboration`;
    const created = (await app.api('POST', command, { action: 'task.create', operationId: 'create', title: 'Work',
      scope: 'Scope', acceptance: 'Done', memberId: executor.id })).task;
    assert.equal(created.gitBranch, undefined);
    const binding = { action: 'task.set_git_branch' as const, taskId: created.id, expectedRevision: created.revision };
    const update = (memberId: string, branch: string, repositoryPath?: string) => app.hub.collaboration.command({ kind: 'member', memberId }, cluster.id,
      { ...binding, operationId: `member-${branch}`, gitBranch: { branch, repositoryPath } });
    const forbidden = (err: unknown) => err instanceof CollaborationError && err.code === 'FORBIDDEN';
    assert.throws(() => update(other.id, 'unassigned'), forbidden);
    assert.throws(() => update(executor.id, 'arbitrary', outside), forbidden);
    assert.deepEqual(update(executor.id, 'future/topic').task?.gitBranch, { repositoryPath: main, branch: 'future/topic' });
    const detail = `${path}/tasks/${created.id}`;
    const task = (await app.api('GET', detail)).task;
    assert.equal(task.definitionVersion, created.definitionVersion);
    assert.ok(!git(main, 'branch', '--list', 'future/topic').toString().trim());
    await assert.rejects(app.api('POST', command, { ...binding, operationId: 'stale', gitBranch: null }), /STALE_REVISION/);
    for (const branch of ['invalid..branch', '-planned', 'HEAD', '@{-1}']) {
      await assert.rejects(app.api('POST', command, { ...binding, expectedRevision: task.revision, operationId: `invalid-${branch}`,
        gitBranch: { repositoryPath: child, branch } }), /INVALID_REQUEST/);
    }

    const outcome = (await app.api('POST', command, { action: 'task.mark_completed', taskId: task.id, expectedRevision: task.revision,
      operationId: 'complete' })).task;
    const next = (await app.api('POST', command, { ...binding, expectedRevision: outcome.revision, operationId: 'change',
      gitBranch: { repositoryPath: outside, branch: 'external' } })).task;
    assert.deepEqual(next.gitBranch, { repositoryPath: outside, branch: 'external' });
    assert.equal(next.status, outcome.status);
    assert.equal(next.definitionVersion, outcome.definitionVersion);
    assert.equal(next.approvedSubmissionId, outcome.approvedSubmissionId);
    const cleared = (await app.api('POST', command, { ...binding, expectedRevision: next.revision, operationId: 'clear', gitBranch: null })).task;
    assert.equal(cleared.gitBranch, undefined);

    const history = (await app.api('GET', detail)).events.filter((event: any) => event.payload.action === 'task.set_git_branch');
    assert.deepEqual(history.map((event: any) => event.payload.changes[0]), [
      { field: 'gitBranch', before: null, after: { repositoryPath: main, branch: 'future/topic' } },
      { field: 'gitBranch', before: { repositoryPath: main, branch: 'future/topic' }, after: { repositoryPath: outside, branch: 'external' } },
      { field: 'gitBranch', before: { repositoryPath: outside, branch: 'external' }, after: null },
    ]);
    const notices = (await app.messages(cluster.id)).filter((message) => message.body.includes('Git 分支关联'));
    assert.equal(notices.length, 3);
    assert.ok(notices.every((message) => message.deliveries.length === 0));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
