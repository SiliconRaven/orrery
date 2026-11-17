// ZCode conversations and tokens, read-only (docs/adapters/zcode.md, "列对话"). ZCode has no list API; this reads two
// private SQLite databases of the desktop app, never in place: each database and its -wal are copied into a temp
// folder and the copy is read, then deleted. Their structure is an implementation detail of ZCode (it may change with
// any update), so every column but the id and the folder is optional and a missing table reads as nothing.
//   <zcode home>/v2/tasks-index.sqlite, table tasks: the desktop's conversation list. task_id is the session id that
//     tool calls carry in _meta.session_id. Listed: not deleted / archived / cli_deleted, local workspace only
//     (workspace_identity empty: an SSH or WSL conversation cannot reach this machine's Hub).
//   <zcode home>/cli/db/db.sqlite, table turn_usage: per-turn tokens of each session (conversationTokens).
import { join } from 'node:path';
import type { ProjectInfo, SessionInfo, TokenTotals } from '../../core/types.ts';
import { pathKey, tableRows, timeOf, truthy, withCopy } from '../shared/sqlite-copy.ts';

export { pathKey, timeOf } from '../shared/sqlite-copy.ts';

const TASKS_DB = join('v2', 'tasks-index.sqlite');
const USAGE_DB = join('cli', 'db', 'db.sqlite');
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TOKENS_CACHE_MS = 15_000;

const empty = (v: unknown) => v === null || v === undefined || v === '' || v === '{}' || v === 'null';

const readCopy = (home: string, file: string, table: string, columns: string[], required: string[]) =>
  withCopy(home, file, [], (db) => tableRows(db, table, columns, required));

const TASK_COLUMNS = ['task_id', 'workspace_path', 'workspace_identity', 'title', 'cli_title', 'model', 'updated_at', 'created_at', 'archived', 'deleted', 'cli_deleted'];

export function createZcodeStore(zcodeHome: string) {
  async function sessions(): Promise<SessionInfo[]> {
    const rows = await readCopy(zcodeHome, TASKS_DB, 'tasks', TASK_COLUMNS, ['task_id', 'workspace_path']);
    const list: SessionInfo[] = [];
    for (const r of rows) {
      if (typeof r.task_id !== 'string' || !SESSION_RE.test(r.task_id) || typeof r.workspace_path !== 'string' || !r.workspace_path) continue;
      if (truthy(r.deleted) || truthy(r.archived) || truthy(r.cli_deleted) || !empty(r.workspace_identity)) continue;
      const title = [r.title, r.cli_title].find((t): t is string => typeof t === 'string' && t.trim() !== '')?.trim() ?? r.task_id;
      list.push({
        id: r.task_id, title, model: typeof r.model === 'string' && r.model ? r.model : null, cwd: r.workspace_path,
        updatedAt: timeOf(r.updated_at) ?? timeOf(r.created_at),
      });
    }
    return list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  let tokenCache: { at: number; read: Promise<Map<string, TokenTotals>> } | null = null;
  /** Every session's token sums, one copy of db.sqlite per TOKENS_CACHE_MS (it holds the conversations and grows). */
  function allTokens(): Promise<Map<string, TokenTotals>> {
    if (tokenCache && Date.now() - tokenCache.at < TOKENS_CACHE_MS) return tokenCache.read;
    const read = readCopy(zcodeHome, USAGE_DB, 'turn_usage',
      ['session_id', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'], ['session_id'])
      .then((rows) => {
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'bigint' && v > 0n ? Number(v) : 0);
        const sums = new Map<string, TokenTotals>();
        for (const r of rows) {
          if (typeof r.session_id !== 'string') continue;
          const t = sums.get(r.session_id) ?? { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };
          // shortcut: assumes input_tokens excludes cache reads/writes and output_tokens includes reasoning (Anthropic-
          // style, as the column names suggest); check against a real ZCode turn and adjust if the totals look off.
          t.input += n(r.input_tokens);
          t.cachedInput += n(r.cache_read_input_tokens);
          t.cacheWrite += n(r.cache_creation_input_tokens);
          t.output += n(r.output_tokens);
          t.reasoning += n(r.reasoning_tokens);
          sums.set(r.session_id, t);
        }
        return sums;
      });
    tokenCache = { at: Date.now(), read };
    return read;
  }

  return {
    async listProjects(): Promise<ProjectInfo[]> {
      const byPath = new Map<string, ProjectInfo>();
      for (const s of await sessions()) {
        const p = byPath.get(pathKey(s.cwd));
        if (!p) byPath.set(pathKey(s.cwd), { path: s.cwd, label: s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd, updatedAt: s.updatedAt });
        else if ((s.updatedAt ?? '') > (p.updatedAt ?? '')) p.updatedAt = s.updatedAt;
      }
      return [...byPath.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    },
    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      const key = pathKey(projectPath);
      return (await sessions()).filter((s) => pathKey(s.cwd) === key);
    },
    async get(sessionId: string): Promise<SessionInfo | null> {
      return SESSION_RE.test(sessionId) ? (await sessions()).find((s) => s.id === sessionId) ?? null : null;
    },
    /** The session's token totals over every turn ZCode recorded; null when it has none. */
    async tokens(sessionId: string): Promise<TokenTotals | null> {
      return (await allTokens()).get(sessionId) ?? null;
    },
  };
}
