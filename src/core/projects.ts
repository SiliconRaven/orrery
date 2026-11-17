// Git repository identity for project listings and task branch links; adapter paths remain untouched.
import { execFile, execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, normalize } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectInfo } from './types.ts';

const exec = promisify(execFile);
const keyPath = (path: string) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[name];

/** Characters a shell would interpret: a path holding one cannot be put into a generated command line. */
export const UNSAFE_PATH = /["$`%!\\\r\n]/;

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, env: gitEnv, windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** For a check that must finish inside a synchronous command; the Hub waits for it. */
export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

interface Identity { key: string; path: string }

const worktreeList = ['worktree', 'list', '--porcelain', '-z'];

/** The first working tree of a repository is the path shown by the project picker. */
function representativeWorktree(gitOutput: string): string {
  const records = gitOutput.split('\0\0');
  const first = records.find((record) => record.startsWith('worktree ') && !record.split('\0').includes('bare'));
  if (!first) throw new Error('no working tree');
  return normalize(first.split('\0')[0].slice('worktree '.length));
}

/** Task writes resolve a path before saving the link in the collaboration transaction. */
export function gitRepositoryPathSync(cwd: string): string {
  return representativeWorktree(gitSync(cwd, ...worktreeList));
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
