// Where the Hub keeps its data and which port it uses, from environment variables. Shared by main.ts and the
// launcher so both agree on "the same data". Node built-ins only.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The repository root, from this module's own location (not the current directory). */
export const REPO_ROOT = resolve(import.meta.dirname, '..');

const DEFAULT_PORT = 4317;

export interface Config {
  home: string;     // bridge secret, API token, hub.json, hub.log
  port: number;
  dbPath: string;
  /** ORRERY_API_TOKEN: the web API token (docs/security.md). Absent: the Hub makes one in <home>/api-token. */
  apiToken?: string;
}

export type Env = Record<string, string | undefined>;

/** A non-negative integer variable, or undefined when unset or empty. */
export function intEnv(env: Env, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/** The user's shared skills folder the `$` picker lists (docs/files.md): ORRERY_SKILLS_DIR, else ~/.agents/skills. */
export function skillsDirOf(env: Env): string {
  return resolve(env.ORRERY_SKILLS_DIR || join(homedir(), '.agents', 'skills'));
}

/**
 * How the Hub opens its database (docs/architecture.md, storage). ORRERY_DB_JOURNAL: wal (default) or delete, the
 * old rollback journal (a WAL file is switched back when no other connection has it open). ORRERY_TEST_DB_SYNC: test
 * Hubs only; off skips every flush to disk, so a power loss can lose commits; unset or full is the product's setting.
 * Unknown values throw, so a typo stops the start instead of being ignored.
 */
export function dbModeOf(env: Env): { journal: 'wal' | 'delete'; synchronous: 'full' | 'off' } {
  const journal = (env.ORRERY_DB_JOURNAL || 'wal').toLowerCase();
  if (journal !== 'wal' && journal !== 'delete') throw new Error(`ORRERY_DB_JOURNAL must be wal or delete, not ${JSON.stringify(env.ORRERY_DB_JOURNAL)}`);
  const synchronous = (env.ORRERY_TEST_DB_SYNC || 'full').toLowerCase();
  if (synchronous !== 'full' && synchronous !== 'off') throw new Error(`ORRERY_TEST_DB_SYNC must be full or off, not ${JSON.stringify(env.ORRERY_TEST_DB_SYNC)}`);
  return { journal, synchronous };
}

/** ORRERY_DISABLED_PLUGINS: comma-separated plugin ids, for the whole Hub. Adds to <home>/plugins.json and wins over it. */
export function disabledPluginsOf(env: Env): string[] {
  return (env.ORRERY_DISABLED_PLUGINS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
}

/** The ids the settings page switched off, from <home>/plugins.json. No file: none. A damaged file throws: the Hub must not quietly turn plugins back on. */
export function readDisabledPlugins(home: string): string[] {
  const file = join(home, 'plugins.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const hint = 'fix the file, or delete it to enable every plugin';
  let data: { disabled?: unknown } | null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}); ${hint}`);
  }
  const disabled = data?.disabled;
  if (!Array.isArray(disabled) || !disabled.every((id) => typeof id === 'string')) {
    throw new Error(`${file} must look like {"disabled":["plugin-id"]}; ${hint}`);
  }
  return disabled;
}

/** Replaces <home>/plugins.json whole (temp file + rename), so a crash never leaves half of it. */
export function writeDisabledPlugins(home: string, disabled: readonly string[]): void {
  const file = join(home, 'plugins.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ disabled }, null, 2) + '\n');
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** What an API token may be: long enough, and safe in a URL fragment and a cookie value as it is. */
export const API_TOKEN_RE = /^[A-Za-z0-9._~-]{32,}$/;

/** Empty values count as unset. Every path comes back absolute. */
export function resolveConfig(env: Env): Config {
  const apiToken = env.ORRERY_API_TOKEN || undefined;
  // Never echo the value: it is a password.
  if (apiToken !== undefined && !API_TOKEN_RE.test(apiToken)) {
    throw new Error('ORRERY_API_TOKEN must be at least 32 characters of A-Z a-z 0-9 . _ ~ - (the value is not shown)');
  }
  return {
    home: resolve(env.ORRERY_HOME || join(homedir(), '.orrery')),
    port: intEnv(env, 'ORRERY_PORT') ?? DEFAULT_PORT,
    dbPath: resolve(env.ORRERY_DB || join(REPO_ROOT, '.tmp', 'orrery.db')),
    ...(apiToken ? { apiToken } : {}),
  };
}
