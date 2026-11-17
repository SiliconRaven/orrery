// Qoder conversations, read-only (docs/adapters/qoder.md, "列对话"). Qoder has no list API; this reads a private SQLite
// database of the desktop app, <Qoder app data>/main.sqlite, only through a temp copy (shared/sqlite-copy.ts):
//   workspaces(workspace_id, name, root_paths_json, archived, deleted_at): the projects; a conversation's cwd is the
//     first root.
//   chat_sessions(session_id, session_kind, conversation_mode, workspace_id, ...): the conversations. session_id is the
//     UUID that tool calls carry in _meta["com.qoder/turnContext"].sessionId. Listed: standard kind, normal mode, not
//     deleted or archived, in a live workspace.
// shortcut: only the table names and workspaces' columns come from notes on Qoder 0.5.6; chat_sessions.workspace_id,
// title, model and the time columns are assumed from those notes, read tolerantly (missing means no value, or nothing
// when the link column is missing). Check against a real main.sqlite at real-app acceptance and adjust the columns.
import { join } from 'node:path';
import type { ProjectInfo, SessionInfo } from '../../core/types.ts';
import { pathKey, tableRows, timeOf, truthy, withCopy } from '../shared/sqlite-copy.ts';

const MAIN_DB = 'main.sqlite';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_COLUMNS = ['workspace_id', 'name', 'root_paths_json', 'archived', 'deleted_at'];
const SESSION_COLUMNS = ['session_id', 'session_kind', 'conversation_mode', 'workspace_id', 'title', 'model', 'created_at', 'updated_at', 'archived', 'deleted_at'];

const gone = (r: Record<string, unknown>) => truthy(r.archived) || (r.deleted_at !== null && r.deleted_at !== undefined && r.deleted_at !== '' && r.deleted_at !== 0 && r.deleted_at !== 0n);

function firstRoot(json: unknown): string | null {
  try {
    const roots = JSON.parse(String(json)) as unknown;
    // shortcut: a multi-root workspace lists under its first root only; upgrade if real multi-root members need another.
    return Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] ? roots[0] : null;
  } catch {
    return null;
  }
}

export function createQoderStore(qoderData: string) {
  async function read(): Promise<{ workspaces: Map<string, { root: string; name: string | null }>; sessions: SessionInfo[] }> {
    const [workspaceRows, sessionRows] = await withCopy(qoderData, MAIN_DB, [[], []] as Record<string, unknown>[][], (db) => [
      tableRows(db, 'workspaces', WORKSPACE_COLUMNS, ['workspace_id', 'root_paths_json']),
      tableRows(db, 'chat_sessions', SESSION_COLUMNS, ['session_id', 'workspace_id']),
    ]);
    const workspaces = new Map<string, { root: string; name: string | null }>();
    for (const w of workspaceRows) {
      const root = firstRoot(w.root_paths_json);
      if (typeof w.workspace_id !== 'string' || !root || gone(w)) continue;
      workspaces.set(w.workspace_id, { root, name: typeof w.name === 'string' && w.name.trim() ? w.name.trim() : null });
    }
    const sessions: SessionInfo[] = [];
    for (const s of sessionRows) {
      if (typeof s.session_id !== 'string' || !UUID_RE.test(s.session_id) || typeof s.workspace_id !== 'string') continue;
      if ((s.session_kind !== undefined && s.session_kind !== 'standard') || (s.conversation_mode !== undefined && s.conversation_mode !== 'normal') || gone(s)) continue;
      const workspace = workspaces.get(s.workspace_id);
      if (!workspace) continue;
      sessions.push({
        id: s.session_id,
        title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : s.session_id,
        model: typeof s.model === 'string' && s.model ? s.model : null,
        cwd: workspace.root,
        updatedAt: timeOf(s.updated_at) ?? timeOf(s.created_at),
      });
    }
    sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { workspaces, sessions };
  }

  return {
    async listProjects(): Promise<ProjectInfo[]> {
      const { workspaces, sessions } = await read();
      const names = new Map([...workspaces.values()].map((w) => [pathKey(w.root), w.name]));
      const byPath = new Map<string, ProjectInfo>();
      for (const s of sessions) {
        const key = pathKey(s.cwd);
        const p = byPath.get(key);
        if (!p) byPath.set(key, { path: s.cwd, label: names.get(key) ?? s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd, updatedAt: s.updatedAt });
        else if ((s.updatedAt ?? '') > (p.updatedAt ?? '')) p.updatedAt = s.updatedAt;
      }
      return [...byPath.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    },
    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      const key = pathKey(projectPath);
      return (await read()).sessions.filter((s) => pathKey(s.cwd) === key);
    },
    async get(sessionId: string): Promise<SessionInfo | null> {
      return UUID_RE.test(sessionId) ? (await read()).sessions.find((s) => s.id === sessionId) ?? null : null;
    },
  };
}

/** Where Qoder keeps its desktop data: <APPDATA>/com.qoder.app.stable. */
export function defaultQoderData(appData: string | undefined, home: string): string {
  return join(appData || join(home, 'AppData', 'Roaming'), 'com.qoder.app.stable');
}
