// Antigravity 2.0 conversation list, read-only. There is no official list API (agentapi only creates, sends and reads
// metadata), so this reads the app's private summaries database <gemini home>/antigravity/conversation_summaries.db
// (SQLite in WAL mode), table conversation_summaries. It is never opened in place: the database and its -wal are copied
// into a temp folder and the copy is read, so nothing of Antigravity's is written (not even the read marks a reader
// leaves in -shm). Conversation contents (conversations/<id>.db) are never read; only their file time, as a fallback.
// Columns used: conversation_id, title, preview, workspace_uris (JSON array of file:// URIs, '' when none),
// last_user_input_time / last_modified_time (Go time text like '2026-01-02 03:04:05.1234567+00:00', zero year 0001),
// nesting_depth (subagents > 0), killed, app_data_dir ('antigravity': the 2.0 app's data, shared with the VS Code
// extension's hub). docs/adapters/antigravity.md, "列对话".
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectInfo, SessionInfo } from '../../core/types.ts';
import { pathKey, withCopy } from '../shared/sqlite-copy.ts';

export { pathKey } from '../shared/sqlite-copy.ts';

const DB = 'conversation_summaries.db';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 80;

/** One listable conversation: its id, title, newest time and every workspace folder it belongs to. */
interface Conversation { id: string; title: string; updatedAt: string | null; workspaces: string[] }

/** A Go time text as ISO, or null for the zero time and anything unreadable. */
export function goTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v.trim().replace(' ', 'T'));
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() <= 1 ? null : d.toISOString();
}

/** Folder paths of a workspace_uris value; [] when it holds none or is not a JSON array of file URIs. */
export function workspacePaths(v: unknown): string[] {
  let uris: unknown;
  try {
    uris = typeof v === 'string' && v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(uris)) return [];
  const paths: string[] = [];
  for (const u of uris) {
    try {
      if (typeof u === 'string' && u.startsWith('file:')) paths.push(fileURLToPath(u));
    } catch { /* not a local file URI */ }
  }
  return paths;
}

const newestFirst = (a: { updatedAt: string | null }, b: { updatedAt: string | null }) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

export function createConversationStore(geminiHome: string) {
  const dataDir = join(geminiHome, 'antigravity');

  /** The summaries rows, read from a temp copy of the database and its WAL. [] when there is no database. */
  async function rows(): Promise<Record<string, unknown>[]> {
    return withCopy(dataDir, DB, [], (db) => db.prepare(
      `SELECT conversation_id, title, preview, workspace_uris, last_user_input_time, last_modified_time
       FROM conversation_summaries WHERE nesting_depth = 0 AND killed = 0 AND app_data_dir = 'antigravity'`,
    ).all(), { strictRead: true });
  }

  /** Newest of the two summary times; when both are zero, the conversation file's modification time. */
  async function updatedAt(id: string, row: Record<string, unknown>): Promise<string | null> {
    const times = [goTime(row.last_user_input_time), goTime(row.last_modified_time)].filter((t): t is string => t !== null);
    if (times.length) return times.sort().at(-1)!;
    try {
      return (await stat(join(dataDir, 'conversations', `${id}.db`))).mtime.toISOString();
    } catch {
      return null;
    }
  }

  /** Every listable conversation: a UUID id and at least one workspace folder (others cannot be picked by project). */
  async function all(): Promise<Conversation[]> {
    const list: Conversation[] = [];
    for (const row of await rows()) {
      const id = row.conversation_id;
      const workspaces = workspacePaths(row.workspace_uris);
      if (typeof id !== 'string' || !UUID.test(id) || !workspaces.length) continue;
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      const preview = typeof row.preview === 'string' ? row.preview.trim().split('\n')[0].slice(0, TITLE_MAX) : '';
      list.push({ id, title: title || preview || id, updatedAt: await updatedAt(id, row), workspaces });
    }
    return list;
  }

  const info = (c: Conversation, cwd: string): SessionInfo => ({ id: c.id, title: c.title, model: null, cwd, updatedAt: c.updatedAt });

  return {
    async listProjects(): Promise<ProjectInfo[]> {
      const byPath = new Map<string, ProjectInfo>();
      for (const c of await all()) {
        for (const w of c.workspaces) {
          const p = byPath.get(pathKey(w));
          if (!p) byPath.set(pathKey(w), { path: w, label: w.split(/[\\/]/).filter(Boolean).pop() ?? w, updatedAt: c.updatedAt });
          else if ((c.updatedAt ?? '') > (p.updatedAt ?? '')) p.updatedAt = c.updatedAt;
        }
      }
      return [...byPath.values()].sort(newestFirst);
    },
    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      const key = pathKey(projectPath);
      return (await all()).flatMap((c) => {
        const w = c.workspaces.find((p) => pathKey(p) === key);
        return w === undefined ? [] : [info(c, w)];
      }).sort(newestFirst);
    },
    async get(conversationId: string): Promise<SessionInfo | null> {
      const c = UUID.test(conversationId) ? (await all()).find((x) => x.id === conversationId) : undefined;
      return c ? info(c, c.workspaces[0]) : null;
    },
  };
}
