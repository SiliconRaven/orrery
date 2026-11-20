// Host bridge for the tasks official package (hostApi: 1; zero external imports).
import type { CollaborationActor, HubEvent, StoredMember } from './types.mts';

export interface TasksHost {
  z: any;
  collaboration: {
    CollaborationError: new (code: string, message: string) => Error;
    MIN_ID_PREFIX: number;
    actorKey(member: Pick<StoredMember, 'harness' | 'workerSessionId'>): string;
    canonical(value: unknown): string;
    personName(store: any, clusterId: string, id: unknown, showHidden?: boolean): string;
    required(value: unknown, field: string, max?: number): string;
    strings(value: unknown, field: string, max?: number): string[];
  };
  files: {
    MAX_FILES_PER_MESSAGE: number;
  };
  projects: {
    UNSAFE_PATH: RegExp;
    git(cwd: string, ...args: string[]): Promise<string>;
    gitRead(cwd: string, args: string[], signal: AbortSignal): Promise<string>;
    gitSync(cwd: string, ...args: string[]): string;
    gitRepositoryPathSync(cwd: string): string;
    projectIdentities(paths: string[]): Promise<{ key: string; path: string }[]>;
    representativeWorktree(gitOutput: string): string;
    sameRepositoryPath(a: string, b: string): boolean;
    worktreeList: readonly string[];
  };
  store: {
    toEvent(row: any): HubEvent;
  };
  hub: {
    shipScript: string;
  };
}

let current: TasksHost | undefined;

export function setHost(h: TasksHost): void { current = h; }

export function host(): TasksHost {
  if (!current) throw new Error('Tasks host is not attached yet.');
  return current;
}

export type { CollaborationActor };
