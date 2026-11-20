// Where the Hub keeps its data and which port it uses, from environment variables. Shared by main.ts and the
// launcher so both agree on "the same data". Node built-ins only.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The repository root, from this module's own location (not the current directory). */
export const REPO_ROOT = resolve(import.meta.dirname, '..');

export const DEFAULT_PORT = 4317;

export interface Config {
  home: string;     // bridge secret, API token, hub.json, hub.log
  registryDir: string;
  port: number;
  dbPath: string;
  /** ORRERY_API_TOKEN: the web API token (docs/security.md). Absent: the Hub makes one in <home>/api-token. */
  apiToken?: string;
}

export type Env = Record<string, string | undefined>;

export const defaultRegistryDir = (): string => join(homedir(), '.orrery', 'registry');

/** ORRERY_UPDATE_CHECKS=0 disables background release checks for this CLI process. */
export const updateChecksOf = (env: Env): boolean => env.ORRERY_UPDATE_CHECKS !== '0';

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

/**
 * ORRERY_SAFE_MODE=1: this start imports no full-trust plugin at all (docs/external-plugins.md「完全信任的插件」), so a
 * plugin that breaks the Hub can be turned off from the page. Anything else but unset, empty or 0 is refused.
 */
export function safeModeOf(env: Env): boolean {
  const v = env.ORRERY_SAFE_MODE ?? '';
  if (v !== '' && v !== '0' && v !== '1') throw new Error(`ORRERY_SAFE_MODE must be 1, 0 or unset, not ${JSON.stringify(v)}`);
  return v === '1';
}

/**
 * The Hub's close gives each third-party plugin at most this long to answer `shutdown` (its manifest may ask for up to
 * 30 s for its own stop and restart). The plugins stop together, so with the initialize wait a close may still be in
 * (5 s) and the exit wait (1 s), a stopping Hub is gone in about 16 s: under the launcher's START_TIMEOUT_MS, which waits
 * out a stopping Hub. test/plugin-lifecycle.test.ts keeps the two from drifting apart.
 */
export const HUB_CLOSE_PLUGIN_GRACE_MS = 10_000;

/**
 * <home>/plugins.json: explicit switch choices for the next start (`disabled`/`enabled`), and the third-party
 * plugins whose automatic restart after a failure (`autoRestart`) or development reload (`devReload`) the user turned
 * on (docs/external-plugins.md「生命周期」), and those whose web UI the user turned off (`uiOff`,「网页界面」). The three
 * lifecycle lists and `enabled` are optional and empty when absent. `trusted`: the full-trust plugins the user confirmed on the settings page,
 * each bound to the real path of its Hub entry file (「完全信任的插件」); only the page's confirmation writes it.
 */
export interface PluginsFile { disabled: string[]; enabled: string[]; autoRestart: string[]; devReload: string[]; uiOff: string[]; trusted?: TrustConfirmation[] }
export interface TrustConfirmation { id: string; entry: string }
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');
const trustList = (value: unknown): value is TrustConfirmation[] => Array.isArray(value) && value.every((t) =>
  !!t && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).sort().join(',') === 'entry,id'
  && typeof (t as TrustConfirmation).id === 'string' && typeof (t as TrustConfirmation).entry === 'string');

/** No file: all lists empty. A damaged file throws: the Hub must not quietly turn plugins back on. */
export function readPluginsFile(home: string): PluginsFile {
  const file = join(home, 'plugins.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { disabled: [], enabled: [], autoRestart: [], devReload: [], uiOff: [] };
    throw e;
  }
  const hint = 'fix the file, or delete it to restore plugin defaults';
  let data: { disabled?: unknown; enabled?: unknown; autoRestart?: unknown; devReload?: unknown; uiOff?: unknown; trusted?: unknown } | null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}); ${hint}`);
  }
  const { disabled, enabled = [], autoRestart = [], devReload = [], uiOff = [], trusted } = data && typeof data === 'object' ? data : {};
  if (!stringList(disabled) || !stringList(enabled) || !stringList(autoRestart) || !stringList(devReload) || !stringList(uiOff)
    || (trusted !== undefined && !trustList(trusted))) {
    throw new Error(`${file} must look like {"disabled":["plugin-id"]} (optionally with "enabled", "autoRestart", "devReload" and "uiOff" lists of ids, `
      + `and "trusted": [{"id","entry"}]); ${hint}`);
  }
  return { disabled, enabled, autoRestart, devReload, uiOff, ...(trusted?.length ? { trusted } : {}) };
}

/** The ids the settings page switched off, from <home>/plugins.json (readPluginsFile). */
export function readDisabledPlugins(home: string): string[] {
  return readPluginsFile(home).disabled;
}

/**
 * Changes some lists of <home>/plugins.json and keeps the others as the file has them. Replaces the file whole (temp
 * file + rename), so a crash never leaves half of it. The empty optional lists are left out.
 */
export function writePluginsFile(home: string, patch: Partial<PluginsFile>): void {
  const file = join(home, 'plugins.json');
  const next = { ...readPluginsFile(home), ...patch };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ disabled: next.disabled, ...(next.enabled.length ? { enabled: next.enabled } : {}),
    ...(next.autoRestart.length ? { autoRestart: next.autoRestart } : {}),
    ...(next.devReload.length ? { devReload: next.devReload } : {}), ...(next.uiOff.length ? { uiOff: next.uiOff } : {}),
    ...(next.trusted?.length ? { trusted: next.trusted } : {}) }, null, 2) + '\n');
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeDisabledPlugins(home: string, disabled: readonly string[]): void {
  writePluginsFile(home, { disabled: [...disabled] });
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
    registryDir: resolve(env.ORRERY_REGISTRY || defaultRegistryDir()),
    port: intEnv(env, 'ORRERY_PORT') ?? DEFAULT_PORT,
    dbPath: resolve(env.ORRERY_DB || join(REPO_ROOT, '.tmp', 'orrery.db')),
    ...(apiToken ? { apiToken } : {}),
  };
}
