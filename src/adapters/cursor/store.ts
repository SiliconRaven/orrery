// Cursor's projects and conversations, read-only (docs/adapters/cursor.md, "认人和接入对话"). Nothing is copied or
// changed, and no state.vscdb is ever opened (the global one holds Cursor's sign-in token):
//   projects: <Cursor data>/User/workspaceStorage/*/workspace.json, its `folder` (local file:// folders only);
//   conversations: <Cursor home>/projects/<encoded project path>/agent-transcripts/<id>/<id>.jsonl; the id is the folder
//   name, the time the file's, the title the first user message that is not an orrery delivery.
// The encoding of the project path and the transcript lines' shape are not checked against a real Cursor yet: the
// encoding is matched case-insensitively, and a user message is looked for in a few likely shapes.
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ProjectInfo, SessionInfo } from '../../core/types.ts';

export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TITLE_MAX = 60;
const UNTITLED = '（无标题）';
/** How much of a transcript is read looking for its first user message. */
const TITLE_SCAN_LINES = 200;

/** Cursor's data folder: %APPDATA%\Cursor. */
export const defaultCursorData = (appData: string | undefined, home: string): string => join(appData || join(home, 'AppData', 'Roaming'), 'Cursor');

/** The folder name Cursor gives a project under ~/.cursor/projects (assumed: every run of other characters → '-'). */
export const projectKey = (path: string): string => path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

const iso = (ms: number) => new Date(ms).toISOString();

/** The text of a transcript line's user message, or null when the line is something else. */
export function userText(line: string): string | null {
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const role = o.role ?? o.message?.role ?? o.type;
  if (role !== 'user') return null;
  const content = o.message?.content ?? o.content ?? o.text;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((c: any) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : '')).join(' ') : '';
  // Cursor wraps what the user typed (and a submitted batch) in <user_query>, after a <timestamp> line.
  const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1];
  const body = query ?? text.replace(/^\s*<timestamp>[\s\S]*?<\/timestamp>/, '');
  return body.replace(/<\/?user_query>/g, '').replace(/\s+/g, ' ').trim() || null;
}

async function titleOf(file: string): Promise<string> {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of lines) {
      if (++n > TITLE_SCAN_LINES) break;
      const text = userText(line);
      if (text && !text.startsWith('[orrery')) return text.slice(0, TITLE_MAX);
    }
  } catch { /* unreadable: untitled */ } finally {
    lines.close();
    input.destroy();
  }
  return UNTITLED;
}

export function createCursorStore(cursorHome: string, cursorData: string) {
  const projectsDir = join(cursorHome, 'projects');

  async function listProjects(): Promise<ProjectInfo[]> {
    const root = join(cursorData, 'User', 'workspaceStorage');
    const byPath = new Map<string, ProjectInfo>();
    let dirs: string[] = [];
    try { dirs = await readdir(root); } catch { return []; }
    for (const d of dirs) {
      const file = join(root, d, 'workspace.json');
      try {
        const folder = JSON.parse(await readFile(file, 'utf8'))?.folder;
        if (typeof folder !== 'string' || !folder.startsWith('file:///')) continue;
        const path = fileURLToPath(folder);
        const updatedAt = iso((await stat(file)).mtimeMs);
        const known = byPath.get(path);
        if (!known || (known.updatedAt ?? '') < updatedAt) byPath.set(path, { path, label: basename(path) || path, updatedAt });
      } catch { /* not a folder workspace, or unreadable */ }
    }
    return [...byPath.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  /** The transcripts folder of a project, matched case-insensitively against the folders Cursor made. */
  async function transcriptsOf(projectPath: string): Promise<string | null> {
    const key = projectKey(projectPath);
    try {
      const hit = (await readdir(projectsDir)).find((d) => d.toLowerCase() === key);
      return hit ? join(projectsDir, hit, 'agent-transcripts') : null;
    } catch { return null; }
  }

  async function session(dir: string, id: string, cwd: string): Promise<SessionInfo | null> {
    if (!SESSION_ID_RE.test(id)) return null;
    const file = join(dir, id, `${id}.jsonl`);
    try {
      const { mtimeMs } = await stat(file);
      return { id, title: await titleOf(file), model: null, cwd, updatedAt: iso(mtimeMs) };
    } catch { return null; }
  }

  async function listSessions(projectPath: string): Promise<SessionInfo[]> {
    const dir = await transcriptsOf(projectPath);
    if (!dir) return [];
    let ids: string[] = [];
    try { ids = await readdir(dir); } catch { return []; }
    const found = (await Promise.all(ids.map((id) => session(dir, id, projectPath)))).filter((s): s is SessionInfo => s !== null);
    return found.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  /** A conversation by id, in any project; its cwd is the project whose folder it is in, when that project is known. */
  async function get(id: string): Promise<SessionInfo | null> {
    if (!SESSION_ID_RE.test(id)) return null;
    let keys: string[] = [];
    try { keys = await readdir(projectsDir); } catch { return null; }
    for (const key of keys) {
      const dir = join(projectsDir, key, 'agent-transcripts');
      const s = await session(dir, id, '');
      if (!s) continue;
      const project = (await listProjects()).find((p) => projectKey(p.path) === key.toLowerCase());
      return { ...s, cwd: project?.path ?? '' };
    }
    return null;
  }

  return { listProjects, listSessions, get };
}
