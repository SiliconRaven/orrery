// WorkBuddy conversations, read-only (docs/adapters/workbuddy.md, "列对话"). WorkBuddy has no list API for orrery, so
// this reads the app's private SQLite database <workbuddy home>/workbuddy.db (WAL mode), never in place: the database
// and its -wal are copied into a temp folder, the copy is read, then both are deleted. Its structure is an implementation
// detail of WorkBuddy and may change with any update, so every column but the id is optional and a missing table reads
// as nothing.
//   sessions: id, cwd, title/custom_title, last_activity_at/updated_at/created_at, deleted_at, is_playground,
//     is_background_automation, transport. Listed: not deleted, not a playground or automation conversation, and
//     transport 'local' (a cloud task cannot reach this machine's Hub).
//   workspaces: path, last_opened_at. Projects are the workspaces plus the folders of listable conversations.
// Only rows whose id can name a wait ticket ([A-Za-z0-9._-]) are listed: the id goes into the wait command.
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectInfo, SessionInfo } from '../../core/types.ts';
import { pathKey, tableRows, timeOf, truthy, withCopy } from '../shared/sqlite-copy.ts';

const DB = 'workbuddy.db';
export const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TITLE_MAX = 200;

const absent = (v: unknown) => v === null || v === undefined || v === '';
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A failed read of one table must still leave projects from the other table visible. */
function rows(...args: Parameters<typeof tableRows>): ReturnType<typeof tableRows> {
  try { return tableRows(...args); } catch { return []; }
}

const SESSION_COLUMNS = ['id', 'cwd', 'title', 'custom_title', 'last_activity_at', 'updated_at', 'created_at',
  'deleted_at', 'is_playground', 'is_background_automation', 'transport'];
const WORKSPACE_COLUMNS = ['path', 'last_opened_at'];

const newestFirst = (a: { updatedAt: string | null }, b: { updatedAt: string | null }) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

function sessions(db: DatabaseSync): SessionInfo[] {
  const list: SessionInfo[] = [];
  for (const r of rows(db, 'sessions', SESSION_COLUMNS, ['id', 'cwd'])) {
    if (typeof r.id !== 'string' || !SESSION_RE.test(r.id)) continue;
    if (typeof r.cwd !== 'string' || !r.cwd.trim()) continue;
    if (!absent(r.deleted_at) || truthy(r.is_playground) || truthy(r.is_background_automation)) continue;
    const transport = text(r.transport);
    if (transport !== null && transport !== 'local') continue;   // cloud tasks and other transports
    const title = (text(r.custom_title) ?? text(r.title) ?? r.id).slice(0, TITLE_MAX);
    list.push({
      id: r.id, title, model: null, cwd: r.cwd,
      updatedAt: timeOf(r.last_activity_at) ?? timeOf(r.updated_at) ?? timeOf(r.created_at),
    });
  }
  return list.sort(newestFirst);
}

export function createWorkbuddyStore(workbuddyHome: string) {
  const readSessions = () => withCopy<SessionInfo[]>(workbuddyHome, DB, [], sessions);

  return {
    listProjects(): Promise<ProjectInfo[]> {
      return withCopy<ProjectInfo[]>(workbuddyHome, DB, [], (db) => {
        const byPath = new Map<string, ProjectInfo>();
        const add = (path: string, updatedAt: string | null) => {
          const key = pathKey(path);
          const p = byPath.get(key);
          if (!p) byPath.set(key, { path, label: basename(path) || path, updatedAt });
          else if ((updatedAt ?? '') > (p.updatedAt ?? '')) p.updatedAt = updatedAt;
        };
        for (const w of rows(db, 'workspaces', WORKSPACE_COLUMNS, ['path'])) {
          if (typeof w.path === 'string' && w.path.trim()) add(w.path, timeOf(w.last_opened_at));
        }
        for (const s of sessions(db)) add(s.cwd, s.updatedAt);
        return [...byPath.values()].sort(newestFirst);
      });
    },
    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      const key = pathKey(projectPath);
      return (await readSessions()).filter((s) => pathKey(s.cwd) === key);
    },
    async get(sessionId: string): Promise<SessionInfo | null> {
      return SESSION_RE.test(sessionId) ? (await readSessions()).find((s) => s.id === sessionId) ?? null : null;
    },
    async transcriptCandidates(sessionId: string): Promise<string[]> {
      if (!SESSION_RE.test(sessionId) || sessionId === '.' || sessionId === '..') return [];
      const projectsDir = join(workbuddyHome, 'projects');
      let projects: string[] = [];
      try { projects = await readdir(projectsDir); } catch { return []; }
      return projects.map((proj) => join(projectsDir, proj, `${sessionId}.jsonl`));
    },
  };
}
