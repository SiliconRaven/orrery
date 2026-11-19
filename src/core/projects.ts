// Git repository identity for project listings and task branch links; adapter paths remain untouched.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, normalize } from 'node:path';
import type { ProjectInfo } from './types.ts';

const keyPath = (path: string) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
/**
 * Every git the Hub starts only reads (docs/security.md「Hub 读本地 Git」). A partial clone would otherwise fetch a missing
 * object on demand, running the transport the repository config names: GIT_NO_LAZY_FETCH (git 2.44+) stops that, and
 * GIT_ALLOW_PROTOCOL naming no real protocol refuses every transport on older git too. No prompt can open: the terminal
 * prompt and the credential manager's UI are off and no askpass program is named.
 */
const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: 'none', GCM_INTERACTIVE: 'never' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER']) delete gitEnv[name];
/** The environment every Hub-started git gets (read by its test). */
export const GIT_READ_ENV: Readonly<NodeJS.ProcessEnv> = gitEnv;

/** Characters a shell would interpret: a path holding one cannot be put into a generated command line. */
export const UNSAFE_PATH = /["$`%!\\\r\n]/;

/** Ends git and everything it started (a transport, an alias's shell): killing git alone would leave those running. */
function killGitTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => child.kill()).on('exit', (code) => { if (code !== 0) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

let killTree = killGitTree;
/** Tests count or replace the tree kill; no argument restores it. */
export function setGitTreeKill(kill?: (child: ChildProcess) => void): void { killTree = kill ?? killGitTree; }

const abortError = () => Object.assign(new Error('git aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

/**
 * git's stdout. Rejects with `code`: the exit code (a number; `stdout` holds what git printed) or null when git was ended
 * by a signal, the spawn error's code (ENOENT), ETIMEDOUT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, or an AbortError. Once it
 * has settled git is killed at most once and later output is dropped.
 */
function run(cwd: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number; maxChars: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) return reject(abortError());
    // On POSIX its own process group, so the whole tree can be killed.
    const child = spawn('git', args, { cwd, env: gitEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    let out = '';
    let settled = false;
    const onData = (chunk: string) => {
      out += chunk;
      if (out.length > options.maxChars) stop(Object.assign(new Error('git output too large'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    };
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout!.off('data', onData);
      const value = out;
      out = '';
      if (error) reject(error); else resolve(value);
    };
    // Settles first, so a second reason (more output, the timer, the abort) finds it settled and kills nothing more.
    const stop = (error: Error) => {
      if (settled) return;
      finish(error);
      child.stdout!.resume();   // keep draining what is still in the pipe until the kill closes it
      killTree(child);
    };
    const onAbort = () => stop(abortError());
    const timer = setTimeout(() => stop(Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' })), options.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', onData);
    child.on('error', (error) => finish(error));
    child.on('close', (code, killed) => finish(code === 0 ? null : Object.assign(new Error(`git exited with ${code ?? killed}`), { code, stdout: out })));
  });
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return run(cwd, args, { timeoutMs: 5000, maxChars: 4 * 1024 * 1024 });
}

/** A small read under the caller's deadline: aborting the signal kills git and what it started. Output over 1 MB is an error. */
export function gitRead(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  return run(cwd, args, { signal, timeoutMs: 5000, maxChars: 1024 * 1024 });
}

/**
 * For a check that must finish inside a synchronous command; the Hub waits for it. shortcut: on its 5 s timeout only git
 * itself is killed, not a child it started; with the environment above a read starts none. Make it async if that changes.
 */
export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

interface Identity { key: string; path: string }

export const worktreeList = ['worktree', 'list', '--porcelain', '-z'];

/** The first working tree of a repository is the path shown by the project picker. */
export function representativeWorktree(gitOutput: string): string {
  const records = gitOutput.split('\0\0');
  const first = records.find((record) => record.startsWith('worktree ') && !record.split('\0').includes('bare'));
  if (!first) throw new Error('no working tree');
  return normalize(first.split('\0')[0].slice('worktree '.length));
}

/** Task writes resolve a path before saving the link in the collaboration transaction. */
export function gitRepositoryPathSync(cwd: string): string {
  return representativeWorktree(gitSync(cwd, ...worktreeList));
}

/**
 * Task branch links compare the representative path Git reports with the stored one, including inside a transaction.
 * Compare spellings only: resolving aliases here could block the Hub beyond the lookup deadline.
 */
export function sameRepositoryPath(a: string, b: string): boolean {
  return keyPath(a) === keyPath(b);
}

/** One request's cache; failures deliberately leave a directory as its own project. */
export function projectResolver() {
  const paths = new Map<string, Promise<Identity>>();
  const repos = new Map<string, Promise<string>>();
  return (path: string): Promise<Identity> => {
    let found = paths.get(path);
    if (!found) {
      found = (async () => {
        try {
          const common = await realpath((await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).replace(/\r?\n$/, ''));
          const key = keyPath(common);
          let representative = repos.get(key);
          if (!representative) {
            representative = git(path, ...worktreeList).then(representativeWorktree);
            repos.set(key, representative);
          }
          return { key: `git:${key}`, path: await representative };
        } catch {
          return { key: `path:${path}`, path };
        }
      })();
      paths.set(path, found);
    }
    return found;
  };
}

/** Resolve in small batches so a large history does not spawn hundreds of Git processes at once. */
export async function projectIdentities(paths: string[]): Promise<Identity[]> {
  const resolve = projectResolver();
  const result: Identity[] = [];
  for (let i = 0; i < paths.length; i += 8) result.push(...await Promise.all(paths.slice(i, i + 8).map(resolve)));
  return result;
}

export function groupedProjects(projects: ProjectInfo[], identities: Identity[]): ProjectInfo[] {
  const groups = new Map<string, ProjectInfo>();
  projects.forEach((project, i) => {
    const identity = identities[i];
    const previous = groups.get(identity.key);
    if (!previous) groups.set(identity.key, {
      path: identity.path,
      label: identity.key.startsWith('git:') ? basename(identity.path) : project.label,
      updatedAt: project.updatedAt,
    });
    else if (project.updatedAt && (!previous.updatedAt || project.updatedAt > previous.updatedAt)) previous.updatedAt = project.updatedAt;
  });
  return [...groups.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
