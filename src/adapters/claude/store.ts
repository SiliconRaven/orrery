// Claude Code session store reader (~/.claude/projects, read-only). Used by the native Claude adapter.
import { open, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProjectInfo, SessionInfo } from '../../core/types.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024;    // the first user entry (and its cwd) sits well inside this
const TAIL_BYTES = 256 * 1024;   // custom-title / ai-title are re-appended through the file; the last model is near the end
const TITLE_MAX = 80;

interface Entry {
  type?: string;
  cwd?: string;
  sessionId?: string;
  customTitle?: string;
  aiTitle?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { model?: string; content?: unknown };
}

/** Text of a user message, or null for tool results and empty content. */
function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((c) => c?.type === 'tool_result')) return null;
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

function shorten(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Builds SessionInfo from transcript entries (head entries first, then tail entries).
 * Title: last custom title, else last AI title, else the first real user prompt. Returns null without a cwd.
 */
export function summarizeTranscript(id: string, entries: Entry[], mtime: Date | null): SessionInfo | null {
  let cwd: string | null = null;
  let custom: string | null = null;
  let ai: string | null = null;
  let prompt: string | null = null;
  let model: string | null = null;
  for (const e of entries) {
    if (!cwd && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) ai = e.aiTitle;
    if (e.isSidechain) continue;
    if (e.type === 'user' && !prompt && !e.isMeta) {
      const text = userText(e.message?.content)?.trim();
      // '<command-name>…', '<local-command-stdout>…' and similar wrappers are not what the user typed.
      if (text && !text.startsWith('<')) prompt = text;
    }
    if (e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>') model = e.message.model;
  }
  if (!cwd) return null;
  return {
    id,
    title: custom ?? ai ?? (prompt ? shorten(prompt, TITLE_MAX) : id),
    model,
    cwd,
    updatedAt: mtime ? mtime.toISOString() : null,
  };
}

function parseLines(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch { /* a torn or foreign line: skip */ }
  }
  return out;
}

// ── fields of a record cut by the read window ──
// A record bigger than the window never parses. Its few fields we need are read with a small JSON tokenizer
// that understands strings and escapes and tracks nesting depth, so it only accepts the record's own top-level
// `cwd`, `type`, `customTitle`, `aiTitle`, and `model`/`role` directly inside its top-level `message`; the same
// names inside tool inputs, nested objects or string contents never match.

type Tok = { s: string } | { p: string } | { lit: string };

const PUNCT = '{}[]:,';

/** Tokens from the start of a record, up to where it is cut off. */
function tokensForward(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) i++;
    else if (PUNCT.includes(ch)) {
      out.push({ p: ch });
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) break;   // cut inside a string
      out.push({ s: text.slice(i + 1, j) });
      i = j + 1;
    } else {
      const start = i;
      while (i < text.length && !/\s/.test(text[i]) && !PUNCT.includes(text[i]) && text[i] !== '"') i++;
      out.push({ lit: text.slice(start, i) });
    }
  }
  return out;
}

/** Tokens of the end of a record whose beginning is cut off, in forward order. */
function tokensBackward(text: string): Tok[] {
  const out: Tok[] = [];
  let i = text.length - 1;
  const escaped = (q: number) => {   // a quote is escaped when an odd number of backslashes precede it
    let n = 0;
    for (let k = q - 1; k >= 0 && text[k] === '\\'; k--) n++;
    return n % 2 === 1;
  };
  while (i >= 0) {
    const ch = text[i];
    if (/\s/.test(ch)) i--;
    else if (PUNCT.includes(ch)) {
      out.push({ p: ch });
      i--;
    } else if (ch === '"') {
      let j = i - 1;
      while (j >= 0 && (text[j] !== '"' || escaped(j))) j--;
      if (j < 0) break;   // cut inside a string
      out.push({ s: text.slice(j + 1, i) });
      i = j - 1;
    } else {
      const end = i + 1;
      while (i >= 0 && !/\s/.test(text[i]) && !PUNCT.includes(text[i]) && text[i] !== '"') i--;
      out.push({ lit: text.slice(i + 1, end) });
    }
  }
  return out.reverse();
}

const TOP_FIELDS = ['cwd', 'type', 'customTitle', 'aiTitle', 'sessionId'];

/** Depth of each token: forward counts from the record's opening brace, backward from its closing brace. */
function recordFields(toks: Tok[], fromEnd: boolean): Entry | null {
  const depth: number[] = new Array(toks.length);
  if (fromEnd) {
    let d = 0;
    for (let i = toks.length - 1; i >= 0; i--) {
      const p = 'p' in toks[i] ? (toks[i] as { p: string }).p : '';
      if (p === '}' || p === ']') depth[i] = d++;
      else if (p === '{' || p === '[') depth[i] = --d;
      else depth[i] = d;
    }
  } else {
    let d = 0;
    for (let i = 0; i < toks.length; i++) {
      const p = 'p' in toks[i] ? (toks[i] as { p: string }).p : '';
      if (p === '{' || p === '[') depth[i] = d++;
      else if (p === '}' || p === ']') depth[i] = --d;
      else depth[i] = d;
    }
  }
  const str = (t: Tok | undefined) => (t && 's' in t ? decode(t.s) : null);
  const top: Record<string, string> = {};
  const msg: Record<string, string> = {};
  let topKey: string | null = null;
  let sidechain: string | null = null;   // 'true' | 'false' once the record's own isSidechain was seen
  for (let i = 0; i + 2 < toks.length; i++) {
    const key = str(toks[i]);
    if (key === null || !('p' in toks[i + 1]) || (toks[i + 1] as { p: string }).p !== ':') continue;
    if (depth[i] === 1) topKey = key;
    const next = toks[i + 2];
    if (depth[i] === 1 && key === 'isSidechain' && next && 'lit' in next) sidechain = next.lit;
    const value = str(next);
    if (value === null) continue;
    if (depth[i] === 1 && TOP_FIELDS.includes(key)) top[key] = value;
    if (depth[i] === 2 && topKey === 'message' && (key === 'model' || key === 'role')) msg[key] = value;
  }
  const e: Entry = {};
  if (top.cwd) e.cwd = top.cwd;
  if (!fromEnd && top.sessionId) e.sessionId = top.sessionId;
  if (top.customTitle) e.customTitle = top.customTitle;
  if (top.aiTitle) e.aiTitle = top.aiTitle;
  e.type = top.type ?? (top.customTitle ? 'custom-title' : top.aiTitle ? 'ai-title' : msg.role === 'assistant' ? 'assistant' : undefined);
  if (sidechain === 'true') e.isSidechain = true;
  // A model counts only from a record known to be on the main chain: never from a sidechain (subagent) record,
  // and not when isSidechain was cut off and ownership is unknown.
  if (msg.model && msg.role === 'assistant' && sidechain === 'false') e.message = { model: msg.model };
  return e.cwd || e.customTitle || e.aiTitle || e.message || e.sessionId ? e : null;
}

function decode(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return null;
  }
}

/** Fields of a record that starts in `text` and is cut at its end (the last line of the head window). */
export function cutRecordHead(text: string): Entry | null {
  const t = text.trimStart();
  return t.startsWith('{') ? recordFields(tokensForward(t), false) : null;
}

/** Fields of a record that ends in `text` and whose start is cut off (the first line of the tail window). */
export function cutRecordTail(text: string): Entry | null {
  const t = text.trimEnd();
  return t.endsWith('}') ? recordFields(tokensBackward(t), true) : null;
}

/** Identify a candidate by its main conversation rows. Older logs identify a readable workspace by cwd. */
export function transcriptIdentity(prefix: Buffer, sessionId: string): 'match' | 'legacy' | 'refused' {
  const end = prefix.lastIndexOf(10) + 1;
  const entries = parseLines(prefix.subarray(0, end).toString('utf8'));
  const cut = cutRecordHead(prefix.subarray(end).toString('utf8'));
  if (cut) entries.push(cut);
  let match = false;
  let hasCwd = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.isSidechain === true) continue;
    if (typeof entry.sessionId === 'string') {
      if (entry.sessionId.toLowerCase() !== sessionId.toLowerCase()) return 'refused';
      match = true;
    }
    if (typeof entry.cwd === 'string' && entry.cwd) hasCwd = true;
  }
  if (match) return 'match';
  return hasCwd ? 'legacy' : 'refused';
}

/**
 * Reads the head of a transcript, plus the tail when `withTail` is set or the head holds no cwd. Never reads
 * more than HEAD_BYTES + TAIL_BYTES. Opens read-only. Whole lines are JSON-parsed; only the two lines cut by
 * the window edges go through the field scanner. A cwd that sits only between the two windows is not found.
 */
export async function readTranscript(file: string, withTail = true): Promise<{ entries: Entry[]; mtime: Date }> {
  const fh = await open(file, 'r');
  try {
    const { size, mtime } = await fh.stat();
    const read = async (start: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    };
    if (size <= HEAD_BYTES + TAIL_BYTES) return { entries: parseLines((await read(0, size)).toString('utf8')), mtime };
    // Cut at newlines on the byte level, so a multi-byte character is never split.
    const head = await read(0, HEAD_BYTES);
    const headEnd = head.lastIndexOf(10) + 1;
    const entries = parseLines(head.subarray(0, headEnd).toString('utf8'));
    const cutHead = cutRecordHead(head.subarray(headEnd).toString('utf8'));
    if (cutHead) entries.push(cutHead);
    if (withTail || !entries.some((e) => typeof e.cwd === 'string')) {
      const tail = await read(size - TAIL_BYTES, TAIL_BYTES);
      const tailStart = tail.indexOf(10) + 1;
      // Only a record that ends with a newline is finished. No newline in the whole tail window means the window
      // lies inside the last record, still being written: its end is not a record end, so nothing is recovered.
      if (tailStart > 0) {
        const cutTail = cutRecordTail(tail.subarray(0, tailStart).toString('utf8'));
        if (cutTail) entries.push(cutTail);
        entries.push(...parseLines(tail.subarray(tailStart).toString('utf8')));
      }
    }
    return { entries, mtime };
  } finally {
    await fh.close();
  }
}

export function pathKey(p: string): string {
  return process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

interface Copy { id: string; file: string; mtimeMs: number }

const newestFirst = (a: { updatedAt: string | null }, b: { updatedAt: string | null }) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

export function createSessionStore(claudeDir: string) {
  const projectsDir = join(claudeDir, 'projects');

  /** Every transcript file per session id, newest first. One id can sit in several folders. */
  async function copiesById(onlyId?: string): Promise<Map<string, Copy[]>> {
    const byId = new Map<string, Copy[]>();
    for (const d of await listDir(projectsDir)) {
      const names = onlyId ? [`${onlyId}.jsonl`] : await listDir(join(projectsDir, d));
      for (const f of names) {
        const id = f.slice(0, -'.jsonl'.length);
        if (!f.endsWith('.jsonl') || !UUID_RE.test(id)) continue;
        const file = join(projectsDir, d, f);
        try {
          const s = await stat(file);
          if (s.isFile()) byId.set(id, [...(byId.get(id) ?? []), { id, file, mtimeMs: s.mtimeMs }]);
        } catch { /* not there */ }
      }
    }
    for (const copies of byId.values()) copies.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return byId;
  }

  async function summarize(c: Copy, withTail: boolean): Promise<SessionInfo | null> {
    try {
      const { entries, mtime } = await readTranscript(c.file, withTail);
      return summarizeTranscript(c.id, entries, mtime);
    } catch {
      return null;   // vanished or unreadable
    }
  }

  /** The one selection rule for list and attach: the newest copy that is readable and has a cwd. */
  async function pick(copies: Copy[]): Promise<{ copy: Copy; head: SessionInfo } | null> {
    for (const copy of copies) {
      const head = await summarize(copy, false);
      if (head) return { copy, head };
    }
    return null;
  }

  return {
    async listProjects(): Promise<ProjectInfo[]> {
      const byCwd = new Map<string, ProjectInfo>();
      for (const copies of (await copiesById()).values()) {
        const s = (await pick(copies))?.head;
        if (!s) continue;
        const p = byCwd.get(pathKey(s.cwd));
        if (!p) byCwd.set(pathKey(s.cwd), { path: s.cwd, label: s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd, updatedAt: s.updatedAt });
        else if ((s.updatedAt ?? '') > (p.updatedAt ?? '')) p.updatedAt = s.updatedAt;
      }
      return [...byCwd.values()].sort(newestFirst);
    },
    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      // The folder name is not a reliable key (a worktree session is filed under the main checkout's folder),
      // so pick each id's copy first, filter by the cwd in its head, and read the tail only for matches.
      const out: SessionInfo[] = [];
      for (const copies of (await copiesById()).values()) {
        const picked = await pick(copies);
        if (!picked || pathKey(picked.head.cwd) !== pathKey(projectPath)) continue;
        const s = await summarize(picked.copy, true);
        if (s) out.push(s);
      }
      return out.sort(newestFirst);
    },
    async exists(sessionId: string): Promise<boolean> {
      return UUID_RE.test(sessionId) && (await copiesById(sessionId)).size > 0;
    },
    /** The transcript file of the session (the copy list and attach pick), or null. */
    async file(sessionId: string): Promise<string | null> {
      if (!UUID_RE.test(sessionId)) return null;
      const copies = (await copiesById(sessionId)).get(sessionId) ?? [];
      return (await pick(copies))?.copy.file ?? null;
    },
    async transcriptFiles(sessionId: string): Promise<string[]> {
      if (!UUID_RE.test(sessionId)) return [];
      return ((await copiesById(sessionId)).get(sessionId) ?? []).map(({ file }) => file);
    },
    async get(sessionId: string): Promise<SessionInfo | null> {
      if (!UUID_RE.test(sessionId)) return null;
      const picked = await pick((await copiesById(sessionId)).get(sessionId) ?? []);
      return picked ? summarize(picked.copy, true) : null;
    },
  };
}
