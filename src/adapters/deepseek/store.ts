// DeepSeek Harness (DSH) session list, read-only, from DSH's session projection cache:
// <DSH_HOME or ~/.dsh>/storages/session_projcache/sessions/<session id>.json, one file per session:
//   { version, record: { identity: { cwd?, createdAt, … }, rows: { <projection key>: { ver, seq, val } } } }
// Shape: upstream packages/session/session-projection-cache/src/spec.ts (tag dsh-v0.2.1-rc.2). Never reads the session
// logs themselves (zstd jsonl under ~/.dsh/sessions; only transcript.ts does, for a bound member) and never writes
// anything. docs/adapters/deepseek.md, "适配器".
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProjectInfo, SessionInfo, TokenTotals } from '../../core/types.ts';

// What a session id may look like before it becomes part of a file name.
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

interface CacheFile {
  record?: {
    identity?: { cwd?: unknown; createdAt?: unknown };
    rows?: Record<string, { val?: unknown } | undefined>;
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One cache record as SessionInfo, or null when it is not listable: no cwd, no creation time, or a subagent's own
 * session. updatedAt follows DSH's own session list: max(createdAt, sessionListMetadata.lastPromptAt), both epoch ms
 * (upstream packages/api/session-controller/src/list.ts:349-351).
 * shortcut: a subagent session is recognised by the `subagent` projection's identity (its own subagent/descriptor
 * event); the header's parentSession is not in the cache. Upgrade if real sessions show up wrongly listed or missing.
 */
export function toSessionInfo(id: string, file: unknown): SessionInfo | null {
  const record = (file as CacheFile | null)?.record;
  const cwd = record?.identity?.cwd;
  const createdAt = record?.identity?.createdAt;
  if (typeof cwd !== 'string' || !cwd || typeof createdAt !== 'number') return null;
  const rows = isObject(record?.rows) ? record.rows : {};
  const subagent = rows.subagent?.val;
  if (isObject(subagent) && subagent.identity) return null;
  const title = rows.title?.val;
  const meta = rows.sessionListMetadata?.val;
  const lastPromptAt = isObject(meta) && typeof meta.lastPromptAt === 'number' ? meta.lastPromptAt : 0;
  const updated = new Date(Math.max(createdAt, lastPromptAt));
  return {
    id,
    title: typeof title === 'string' && title.trim() ? title.trim() : id,
    model: null,
    cwd,
    updatedAt: Number.isNaN(updated.getTime()) ? null : updated.toISOString(),
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/**
 * The session's tokens from one cache record: the `tokenUsage` projection's totals
 * { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } (provider-reported, over the whole durable
 * log; DSH reports no reasoning count here). Null without that projection. docs/usage.md.
 */
export function tokensOf(file: unknown): TokenTotals | null {
  const totals = (file as CacheFile | null)?.record?.rows?.tokenUsage?.val;
  const t = isObject(totals) && isObject(totals.totals) ? totals.totals : null;
  if (!t) return null;
  return { input: num(t.uncachedInputTokens), cachedInput: num(t.cacheReadTokens), cacheWrite: num(t.cacheWriteTokens), output: num(t.outputTokens), reasoning: 0 };
}

export function pathKey(p: string): string {
  return process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
}

const newestFirst = (a: { updatedAt: string | null }, b: { updatedAt: string | null }) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

export function createSessionStore(dshHome: string) {
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');

  async function read(id: string): Promise<SessionInfo | null> {
    try {
      return toSessionInfo(id, JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')));
    } catch {
      return null;   // missing, being rewritten, or not JSON
    }
  }

  /** shortcut: sessions the cache does not have yet are not listed; upgrade by reading the session log's header. */
  async function all(): Promise<SessionInfo[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const ids = names.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).filter((id) => SAFE_ID.test(id));
    return (await Promise.all(ids.map(read))).filter((s): s is SessionInfo => s !== null);
  }

  return {
    async listProjects(): Promise<ProjectInfo[]> {
      const byCwd = new Map<string, ProjectInfo>();
      for (const s of await all()) {
        const p = byCwd.get(pathKey(s.cwd));
        if (!p) byCwd.set(pathKey(s.cwd), { path: s.cwd, label: s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd, updatedAt: s.updatedAt });
        else if ((s.updatedAt ?? '') > (p.updatedAt ?? '')) p.updatedAt = s.updatedAt;
      }
      return [...byCwd.values()].sort(newestFirst);
    },
    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      return (await all()).filter((s) => pathKey(s.cwd) === pathKey(projectPath)).sort(newestFirst);
    },
    async get(sessionId: string): Promise<SessionInfo | null> {
      return SAFE_ID.test(sessionId) ? read(sessionId) : null;
    },
    /** shortcut: the cache is DSH's projection cache, written when DSH saves it; it can lag the running session. */
    async tokens(sessionId: string): Promise<TokenTotals | null> {
      if (!SAFE_ID.test(sessionId)) return null;
      try {
        return tokensOf(JSON.parse(await readFile(join(dir, `${sessionId}.json`), 'utf8')));
      } catch {
        return null;
      }
    },
  };
}
