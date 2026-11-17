// The page's history search (GET /api/clusters/:id/messages/search, docs/collaboration-api.md「搜索群聊记录」): strict
// parameter checks, then one bounded Store.searchMessages call, answered as result rows with a snippet around the hit.
import type { Store, MessageSearch } from '../core/store.ts';
import { SYSTEM_CATEGORIES, SYSTEM_KINDS, type SystemCategory } from '../core/system-kinds.js';

export const SEARCH_LIMIT = 30;
export const SEARCH_MAX_LIMIT = 100;
/** Messages one call looks at, at most. */
export const SEARCH_SCAN_CAP = 5000;
/** Bytes of message text one call looks at, at most (only its first message may pass it alone): long messages stop a call early. */
export const SEARCH_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_QUERY = 200;
const PARAMS = new Set(['q', 'sender', 'category', 'level', 'from', 'to', 'files', 'order', 'cursor', 'limit']);
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** C0 controls and DEL; a keyword may still hold a tab or a line break (\t \n \r), as message text does. */
const CONTROL = /[\u0000-\u001F\u007F]/;
const KEYWORD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface SearchItem {
  id: string; from: string; createdAt: string; kind: string; systemKind?: string;
  /** One line around the first hit; `marks` are the [start, end) ranges of the hits within it. */
  snippet: string; marks: [number, number][];
}
export interface SearchAnswer { items: SearchItem[]; cursor: string | null; reason: 'limit' | 'scan' | null }

/** An ISO time with an offset that names a real instant, as the stored form (toISOString); throws for anything else. */
export function timeParam(raw: string | null, name: string): string | undefined {
  if (raw === null) return undefined;
  const m = ISO_TIME.exec(raw);
  const [y, mo, d, h, mi, s = '0', oh = '0', om = '0'] = m ? m.slice(1).map((v) => v ?? undefined) : [];
  const n = (v: string | undefined) => Number(v);
  // Date would roll 02-30 over into March: every component must be in range for its month, the offset within ±14:00.
  const real = m && n(mo) >= 1 && n(mo) <= 12 && n(d) >= 1 && n(d) <= new Date(Date.UTC(n(y), n(mo), 0)).getUTCDate()
    && n(h) <= 23 && n(mi) <= 59 && n(s) <= 59 && n(om) <= 59 && n(oh) * 60 + n(om) <= 14 * 60;
  const at = new Date(raw);
  // Stored times have four-figure years; an offset could carry 0001-01-01 or 9999-12-31 outside them, and a "+010000-…"
  // or "0000-…" string would then compare wrongly against them.
  const iso = real && !Number.isNaN(at.getTime()) ? at.toISOString() : '';
  if (!/^(?!0000)\d{4}-/.test(iso)) throw new Error(`${name} must be a real ISO time with an offset in years 0001–9999 (UTC), e.g. 2026-11-16T00:00:00+08:00`);
  return iso;
}

/** Lowercases A–Z only, as SQLite's lower() and instr do; lengths stay the same, so indexes carry over. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/**
 * A character that always starts a grapheme, whatever came before it: ASCII, kana and CJK ideographs, Hangul syllables
 * (none of them extends, joins or pairs). Segmenting from one keeps flag pairs, ZWJ sequences and marks whole.
 */
const ANCHOR = /[\t -~぀-゘゛-ヿ㐀-䶿一-鿿가-힣]/;

/**
 * About `width` characters on one line around the first hit of `q` in `excerpt` (Store.searchMessages: up to about 800
 * characters of the body, `cut` saying whether the body goes on before or after it), with … where cut, and the hit
 * ranges in it. The hits are found in the excerpt as SQLite found the row (A–Z folded, literal), then carried through
 * the whitespace collapsing by an index map; a hit longer than the line is cut at its end. Cut points fall on grapheme
 * boundaries, segmented from the excerpt's start or, when the body went on before it, from its first ANCHOR character.
 * No `q`: the start, no marks. All work is on the excerpt, never on a whole long body.
 */
export function searchSnippet(excerpt: string, q: string | undefined, cut = { before: false, after: false }, width = 140): { snippet: string; marks: [number, number][] } {
  // flat: whitespace runs as one space, trimmed; pos[i]: where excerpt index i lands in it (a space run: its space).
  let flat = '';
  const pos = new Array<number>(excerpt.length + 1);
  let space = false;
  for (let i = 0; i < excerpt.length; i++) {
    if (/\s/.test(excerpt[i])) { space = flat.length > 0; pos[i] = flat.length; continue; }
    if (space) { flat += ' '; space = false; }
    pos[i] = flat.length;
    flat += excerpt[i];
  }
  pos[excerpt.length] = flat.length;
  const hits: [number, number][] = [];
  if (q) {
    const hay = asciiLower(excerpt), needle = asciiLower(q);
    for (let at = hay.indexOf(needle); at >= 0 && hits.length < 50; at = hay.indexOf(needle, at + needle.length)) {
      hits.push([pos[at], Math.min(flat.length, pos[at + needle.length - 1] + 1)]);
    }
  }
  let start = 0, end = Math.min(flat.length, width);
  if (hits.length) {
    const [hs, he] = hits[0];
    start = he - hs > width - 20 ? Math.max(0, hs - 10) : Math.max(0, hs - 40);
    end = Math.min(flat.length, start + width);
    if (end === flat.length) start = Math.max(0, Math.min(start, end - width));
  }
  // Grapheme starts from a known one; the excerpt's end is one only when the body ends there.
  // The anchor is looked for only up to the first hit, so the hit is never cut away.
  // shortcut: with text cut off before it and no ANCHOR character before the hit (hundreds of flags or emoji in a row),
  // segmenting starts at the cut and may pair flags wrongly; fetch more context in SQL if that ever matters.
  let anchor = 0;
  const limit = hits.length ? hits[0][0] : flat.length - 1;
  if (cut.before) for (let i = 0; i <= limit; i++) if (ANCHOR.test(flat[i] ?? '')) { anchor = i; break; }
  const bounds = [...graphemes.segment(flat.slice(anchor))].map((g) => anchor + g.index);
  if (!cut.after) bounds.push(flat.length);
  const back = (i: number) => bounds.findLast((b) => b <= i) ?? bounds[0] ?? 0;
  start = back(start);
  end = bounds.find((b) => b >= end) ?? back(end);
  // The line always reaches into the first hit, even where no grapheme boundary follows it (one huge cluster).
  if (hits.length && end <= hits[0][0]) end = hits[0][1];
  if (end < start) end = start;
  const lead = start > 0 || cut.before;
  const marks = hits.flatMap(([s, e]): [number, number][] => {
    const a = Math.max(s, start), b = Math.min(e, end);
    return a < b ? [[a - start + (lead ? 1 : 0), b - start + (lead ? 1 : 0)]] : [];
  });
  return { snippet: `${lead ? '…' : ''}${flat.slice(start, end)}${end < flat.length || cut.after ? '…' : ''}`, marks };
}

/**
 * Checks the query and runs one page of it. Throws (400) for an unknown or repeated parameter, a control character, an
 * unknown sender of this cluster, a bad category, level, time, cursor or limit. `null`: no such cluster (a deleted one
 * included).
 */
export function searchClusterMessages(store: Store, clusterId: string, params: URLSearchParams): SearchAnswer | null {
  if (!store.getCluster(clusterId)) return null;
  const keys = [...params.keys()];
  for (const key of keys) if (!PARAMS.has(key)) throw new Error(`unknown search parameter ${key}`);
  if (new Set(keys).size !== keys.length) throw new Error('each search parameter may be given once');
  // A NUL would end SQLite's LIKE pattern early (every message matching); no parameter needs a control character.
  for (const [key, value] of params) if ((key === 'q' ? KEYWORD_CONTROL : CONTROL).test(value)) throw new Error(`${key} must not contain control characters`);
  const search: MessageSearch = {};
  const q = params.get('q') ?? '';
  if (q.length > MAX_QUERY) throw new Error(`q must be at most ${MAX_QUERY} characters`);
  if (q.trim()) search.q = q;
  const sender = params.get('sender');
  if (sender !== null) {
    // Removed and hidden members' messages are the user's history too.
    if (sender !== 'user' && sender !== 'system' && store.getMember(sender, { includeRemoved: true })?.clusterId !== clusterId) throw new Error('unknown sender in this cluster');
    search.senderId = sender;
  }
  const category = params.get('category'), level = params.get('level');
  if (category !== null && !SYSTEM_CATEGORIES.includes(category as SystemCategory)) throw new Error(`category must be one of ${SYSTEM_CATEGORIES.join(', ')}`);
  if (level !== null && (category !== 'warning' || (level !== 'problem' && level !== 'attention'))) throw new Error('level must be problem or attention, with category=warning');
  if (category === 'other') {
    search.systemKinds = { kinds: Object.keys(SYSTEM_KINDS).filter((k) => SYSTEM_KINDS[k as keyof typeof SYSTEM_KINDS].category !== 'other'), not: true };
  } else if (category !== null) {
    search.systemKinds = { kinds: Object.entries(SYSTEM_KINDS).filter(([, c]) => c.category === category && (level === null || c.level === level)).map(([k]) => k) };
  }
  search.since = timeParam(params.get('from'), 'from');
  search.until = timeParam(params.get('to'), 'to');
  if (search.since && search.until && search.since > search.until) throw new Error('from must not be after to');
  const files = params.get('files');
  if (files !== null && files !== '1') throw new Error('files must be 1 when given');
  search.withFiles = files === '1';
  const order = params.get('order') ?? 'desc';
  if (order !== 'desc' && order !== 'asc') throw new Error('order must be desc or asc');
  const rawCursor = params.get('cursor');
  const cursor = rawCursor === null ? undefined : Number(rawCursor);
  if (cursor !== undefined && (!/^\d+$/.test(rawCursor!) || !Number.isSafeInteger(cursor))) throw new Error('cursor must be the cursor of a previous answer');
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? SEARCH_LIMIT : Number(rawLimit);
  if (!/^\d+$/.test(rawLimit ?? '1') || !Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const { hits, next } = store.searchMessages(clusterId, search,
    { cursor, order, limit: Math.min(limit, SEARCH_MAX_LIMIT), scanCap: SEARCH_SCAN_CAP, scanBytes: SEARCH_SCAN_BYTES });
  return {
    items: hits.map((m) => ({ id: m.id, from: m.from, createdAt: m.createdAt, kind: m.kind ?? 'chat',
      ...(m.systemKind ? { systemKind: m.systemKind } : {}), ...searchSnippet(m.excerpt, search.q, { before: m.cutBefore, after: m.cutAfter }) })),
    // The boundary message's rowid as text: opaque to the page; new messages only get larger ones, so pages never shift.
    cursor: next ? String(next.rowid) : null,
    reason: next?.reason ?? null,
  };
}
