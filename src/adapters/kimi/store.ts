// Kimi Code's projects and sessions, read-only, straight from its data directory (<KIMI_CODE_HOME or ~/.kimi-code>):
//   projects.json                                { projects: { <wd id>: { root, name, last_opened_at } }, deleted_project_ids }
//   workspaces.json                              the same as { workspaces, deleted_workspace_ids }, before app 1.3.1
//   sessions/<wd id>/<session id>/state.json     { id, cwd, title, archived, createdAt, updatedAt }  (times: epoch ms)
// Never starts a Kimi process (`kimi session list` would start the core) and never writes anything.
// docs/adapters/kimi.md, "列项目和会话".
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ProjectInfo, SessionInfo } from '../../core/types.ts';

/** Kimi session ids: `session_` + a UUID. Checked before an id becomes part of a path or a URL. */
export const SESSION_ID_RE = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An epoch-ms number or a date string as ISO, else null. */
function iso(v: unknown): string | null {
  const d = typeof v === 'number' ? new Date(v) : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export function pathKey(p: string): string {
  return process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
}

const newestFirst = (a: { updatedAt: string | null }, b: { updatedAt: string | null }) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

/** One state.json as SessionInfo, or null when it is not listable (wrong id, archived, not an object). */
export function toSessionInfo(dirName: string, state: unknown, fallbackCwd: string): SessionInfo | null {
  if (!isObject(state) || !SESSION_ID_RE.test(dirName)) return null;
  if (state.id !== undefined && state.id !== dirName) return null;
  if (state.archived === true) return null;
  const title = typeof state.title === 'string' && state.title.trim() ? state.title.trim() : dirName;
  return {
    id: dirName,
    title,
    model: null,
    cwd: typeof state.cwd === 'string' && state.cwd ? state.cwd : fallbackCwd,
    updatedAt: iso(state.updatedAt) ?? iso(state.createdAt),
  };
}

interface Workspace { id: string; root: string; name: string; lastOpened: string | null }

export function createSessionStore(kimiHome: string) {
  const sessionsDir = join(kimiHome, 'sessions');

  /** The project list; projects.json first, because the migration to it leaves workspaces.json behind, going stale. */
  async function catalog(): Promise<{ entries: Record<string, unknown>; deleted: unknown } | null> {
    for (const [name, list, gone] of [['projects.json', 'projects', 'deleted_project_ids'], ['workspaces.json', 'workspaces', 'deleted_workspace_ids']]) {
      try {
        const file = JSON.parse(await readFile(join(kimiHome, name), 'utf8'));
        if (isObject(file) && isObject(file[list])) return { entries: file[list], deleted: file[gone] };
      } catch { /* missing, being rewritten, or not JSON */ }
    }
    return null;
  }

  async function workspaces(): Promise<Workspace[]> {
    const found = await catalog();
    if (!found) return [];
    const deleted = new Set(Array.isArray(found.deleted) ? found.deleted : []);
    const out: Workspace[] = [];
    for (const [id, w] of Object.entries(found.entries)) {
      if (!WORKSPACE_ID_RE.test(id) || deleted.has(id) || !isObject(w) || typeof w.root !== 'string' || !w.root) continue;
      const name = typeof w.name === 'string' && w.name ? w.name : basename(w.root) || w.root;
      out.push({ id, root: w.root, name, lastOpened: iso(w.last_opened_at) });
    }
    return out;
  }

  async function read(workspace: Workspace, sessionId: string): Promise<SessionInfo | null> {
    try {
      const state = JSON.parse(await readFile(join(sessionsDir, workspace.id, sessionId, 'state.json'), 'utf8'));
      return toSessionInfo(sessionId, state, workspace.root);
    } catch {
      return null;   // missing, being rewritten, or not JSON
    }
  }

  async function sessionsOf(workspace: Workspace): Promise<SessionInfo[]> {
    let names: string[];
    try {
      names = await readdir(join(sessionsDir, workspace.id));
    } catch {
      return [];
    }
    const found = await Promise.all(names.filter((n) => SESSION_ID_RE.test(n)).map((n) => read(workspace, n)));
    return found.filter((s): s is SessionInfo => s !== null);
  }

  return {
    async listProjects(): Promise<ProjectInfo[]> {
      return (await workspaces()).map((w) => ({ path: w.root, label: w.name, updatedAt: w.lastOpened })).sort(newestFirst);
    },
    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      const mine = (await workspaces()).filter((w) => pathKey(w.root) === pathKey(projectPath));
      return (await Promise.all(mine.map(sessionsOf))).flat().sort(newestFirst);
    },
    async get(sessionId: string): Promise<SessionInfo | null> {
      if (!SESSION_ID_RE.test(sessionId)) return null;
      for (const w of await workspaces()) {
        const s = await read(w, sessionId);
        if (s) return s;
      }
      return null;
    },
    async transcriptCandidates(sessionId: string): Promise<{ workspace: string; stateFile: string; wireFile: string }[]> {
      if (!SESSION_ID_RE.test(sessionId)) return [];
      let dirs: string[];
      try {
        dirs = await readdir(sessionsDir);
      } catch {
        return [];
      }
      const candidates: { workspace: string; stateFile: string; wireFile: string }[] = [];
      for (const wd of dirs) {
        if (!WORKSPACE_ID_RE.test(wd)) continue;
        const sessionDir = join(sessionsDir, wd, sessionId);
        const stateFile = join(sessionDir, 'state.json');
        const wireFile = join(sessionDir, 'agents', 'main', 'wire.jsonl');
        const [hasState, hasWire] = await Promise.all([
          lstat(stateFile).then(() => true, (e: NodeJS.ErrnoException) => e.code !== 'ENOENT' && e.code !== 'ENOTDIR'),
          lstat(wireFile).then(() => true, (e: NodeJS.ErrnoException) => e.code !== 'ENOENT' && e.code !== 'ENOTDIR'),
        ]);
        if (hasState || hasWire) candidates.push({ workspace: wd, stateFile, wireFile });
      }
      return candidates;
    },
  };
}
