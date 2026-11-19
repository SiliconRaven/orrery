// Reading one session of a harness's own SQLite conversation store, in place and read-only (docs/adapters/zcode.md,
// "读对话原文"). Users: ZCode (cli/db/db.sqlite) and, next, Qoder. Paging and cursors behave like the JSONL reader
// (./transcript.ts): latest page first, `before` pages backwards, `after` reads forward; a cursor resets when the
// database file was replaced, the row it points at is gone, or that row was finished and has changed since. A page
// reads at most SCAN_ROWS keys and fetches each row's payload by its key, so a session is never loaded whole. Nothing
// is written (measured on Node 24.19 with SQLite 3.53.3, see the ZCode page):
// - with a -wal and a -shm file: mode=ro&readonly_shm=1, so the -shm is never written (a plain read-only open writes
//   read marks);
// - with a -wal but no -shm (left by a crash): not opened at all, 'unsupported', since any open would create a -shm;
// - without a -wal (no connection open): immutable=1, so no -wal/-shm is created. An immutable read takes no lock, so
//   the file and the absence of -wal are checked again afterwards; if the app opened the database meanwhile, read again
//   under the same checks.
// One race is left: the app closing the database cleanly (deleting -wal and -shm) between the check and the open makes
// SQLite create both again, empty (measured); there is no way to open a WAL database on the -wal without that risk.
import { lstat } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { emptyTranscriptPage, TRANSCRIPT_MAX_ITEMS, truncateTranscriptText, type TranscriptItem, type TranscriptPage,
  type TranscriptRequest } from '../../core/types.ts';
import { confinedFile, digest, openCursor, sameFile, sealCursor, type TranscriptDraft } from './transcript.ts';

export const SQLITE_ROW_BYTES = 256 * 1024;
const BATCH_ROWS = 100;
const SCAN_ROWS = 1000;
/** A row the app may still update is read again by the next forward read, if it is this close to the end. */
const PENDING_ROWS = 32;
const BUSY_MS = 1000;

export type SqliteRow = Record<string, SQLOutputValue>;
type Key = (string | number)[];
/** Before item `skip` of the row at `key`; a null key is the start of the session. `print`: the row's content, if final. */
interface Position { key: Key | null; skip: number; print?: string }
interface Cursor { binding: string; identity: string; position: Position }
interface Row { key: Key; items: TranscriptItem[]; final: boolean; raw: SqliteRow }

export interface SqliteTranscriptOptions {
  /** The harness's own directory; `file` must be a plain file under it, reached without links. */
  root: string;
  file: string;
  sessionKey: string;
  request: TranscriptRequest;
  /** Every table and column the queries use. A database without one of them reads as 'unsupported'. */
  schema: Record<string, string[]>;
  /** Returns a row when the session exists; 'missing' otherwise. */
  session: { sql: string; params: SQLInputValue[] };
  /** `FROM <from> WHERE <where>` selects the session's rows. */
  from: string;
  where: string;
  params: SQLInputValue[];
  /** Columns that order the rows strictly (the last one unique), best covered by an index. Never NULL. */
  order: string[];
  /** The payload columns, read row by row. Wrap large columns in `bounded`. */
  select: string;
  /** The `select` columns that hold a row's content; a cursor on a finished row resets when they change. Default: all. */
  content?: string[];
  /** undefined: an unrecognised row. final false: the app may still update the row. */
  parse(row: SqliteRow): { items: TranscriptDraft[]; final?: boolean } | undefined;
  unknownText: string;
}

/** The column, or NULL when it is larger than one row may be (octet_length reads only the record header). */
export const bounded = (column: string) => `CASE WHEN octet_length(${column}) <= ${SQLITE_ROW_BYTES} THEN ${column} END`;

class Unsupported extends Error {}
const same = (a: Key | null, b: Key | null) => JSON.stringify(a) === JSON.stringify(b);

function source(db: DatabaseSync, o: SqliteTranscriptOptions, identity: string) {
  const tuple = `(${o.order.join(', ')})`;
  const marks = `(${o.order.map(() => '?').join(', ')})`;
  const payload = db.prepare(`SELECT ${o.select} FROM ${o.from} WHERE (${o.where}) AND ${tuple} = ${marks}`);
  const keys = (desc: boolean, op?: string) => db.prepare(`SELECT ${o.order.map((c, i) => `${c} AS k${i}`).join(', ')}
    FROM ${o.from} WHERE (${o.where})${op ? ` AND ${tuple} ${op} ${marks}` : ''}
    ORDER BY ${o.order.map(c => `${c} ${desc ? 'DESC' : 'ASC'}`).join(', ')} LIMIT ?`);
  const scans = { all: keys(false), from: keys(false, '>='), after: keys(false, '>'), newest: keys(true), before: keys(true, '<') };

  const parse = (key: Key, row: SqliteRow): Row => {
    let result: ReturnType<SqliteTranscriptOptions['parse']>;
    try { result = o.parse(row); } catch { /* one bad row does not stop the page */ }
    const drafts = result?.items ?? [{ kind: 'unknown' as const, text: o.unknownText }];
    const base = digest(JSON.stringify([identity, key])).slice(0, 16);
    return {
      key, final: result?.final !== false, raw: row,
      items: drafts.map((draft, index) => ({ ...draft, id: draft.id ?? `${base}:${index}`,
        ...(draft.text === undefined ? {} : truncateTranscriptText(draft.text)) })),
    };
  };
  /** A digest of a finished row's content columns (each at most SQLITE_ROW_BYTES when wrapped in `bounded`). */
  const print = (row: Row) => row.final ? digest(JSON.stringify((o.content ?? Object.keys(row.raw)).map((column) => {
    const value = row.raw[column];
    return value instanceof Uint8Array ? Buffer.from(value).toString('base64') : typeof value === 'bigint' ? String(value) : value;
  }))).slice(0, 22) : undefined;
  /** Before item `skip` of `row`, remembering the content of a finished row. */
  const mark = (row: Row, skip: number): Position => {
    const fingerprint = print(row);
    return { key: row.key, skip, ...(fingerprint && { print: fingerprint }) };
  };
  const at = (key: Key): Row | undefined => {
    const row = payload.get(...o.params, ...key) as SqliteRow | undefined;
    return row && parse(key, row);
  };
  /** Up to `limit` row keys next to `key`: ascending from it (inclusive or not), or descending before it. */
  const scan = (direction: 'from' | 'after' | 'before', key: Key | null, limit: number): Key[] => {
    const statement = key ? scans[direction] : direction === 'before' ? scans.newest : scans.all;
    return statement.all(...o.params, ...(key ?? []), limit).map((found) => {
      const next = o.order.map((_, i) => found[`k${i}`]);
      if (!next.every(v => typeof v === 'string' || typeof v === 'number')) throw new Unsupported();
      return next as Key;
    });
  };
  /** The rows of the keys, payloads read one at a time as the caller goes. */
  function* rows(keys: Key[]): Generator<Row> {
    for (const key of keys) {
      const row = at(key);
      if (row) yield row;
    }
  }
  return { at, scan, rows, print, mark };
}

type Source = ReturnType<typeof source>;

function forward(src: Source, from: Position, limit: number) {
  const items: TranscriptItem[] = [];
  const seen: Row[] = [];
  let after = from;
  let more = false;
  for (let key = from.key, direction: 'from' | 'after' = 'from'; ; direction = 'after') {
    const batch = src.scan(direction, key, BATCH_ROWS);
    for (const row of src.rows(batch)) {
      seen.push(row);
      const skip = same(row.key, from.key) ? from.skip : 0;
      const take = row.items.slice(skip, skip + limit - items.length);
      items.push(...take);
      after = src.mark(row, skip + take.length);
      if (after.skip < row.items.length) return { items, after, more: true };
      if (items.length >= limit || seen.length >= SCAN_ROWS) {
        more = src.scan('after', row.key, 1).length > 0;
        break;
      }
    }
    if (more || items.length >= limit || seen.length >= SCAN_ROWS || batch.length < BATCH_ROWS) break;
    key = batch.at(-1)!;
  }
  // At the end, read a row the app is still writing again next time (its items keep their IDs and replace).
  const pending = more ? undefined : seen.slice(-PENDING_ROWS).find(row => !row.final);
  return { items, after: pending ? { key: pending.key, skip: 0 } : after, more };
}

function backward(src: Source, from: Position | undefined, limit: number) {
  const items: TranscriptItem[] = [];   // newest first until the end
  const seen: Row[] = [];
  let first: Position | undefined;
  let more = false;
  const take = (row: Row, end: number) => {
    const start = Math.max(0, end - (limit - items.length));
    items.push(...row.items.slice(start, end).reverse());
    first = src.mark(row, start);
    return start > 0;
  };
  let key = from?.key ?? null;
  if (from && key === null) return { items, more, seen };
  if (from && key) {
    const anchor = src.at(key);
    if (anchor && take(anchor, Math.min(from.skip, anchor.items.length))) more = true;
    else if (items.length >= limit) more = src.scan('before', key, 1).length > 0;
  }
  while (!more && items.length < limit && seen.length < SCAN_ROWS) {
    const batch = src.scan('before', key, BATCH_ROWS);
    for (const row of src.rows(batch)) {
      seen.push(row);
      if (take(row, row.items.length)) { more = true; break; }
      if (items.length >= limit || seen.length >= SCAN_ROWS) { more = src.scan('before', row.key, 1).length > 0; break; }
    }
    if (batch.length < BATCH_ROWS) break;
    key = batch.at(-1)!;
  }
  return { items: items.reverse(), before: more ? first : undefined, more, seen };
}

function readOnce(o: SqliteTranscriptOptions, file: string, shared: boolean, identity: string, binding: string,
  cursor: Cursor | undefined): TranscriptPage {
  const url = pathToFileURL(file);
  if (shared) { url.searchParams.set('mode', 'ro'); url.searchParams.set('readonly_shm', '1'); }
  else url.searchParams.set('immutable', '1');
  const db = new DatabaseSync(url, { readOnly: true, timeout: BUSY_MS });
  try {
    db.exec('BEGIN');
    try {
      for (const [table, columns] of Object.entries(o.schema)) {
        const have = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(c => c.name));
        if (columns.some(column => !have.has(column))) return emptyTranscriptPage('unsupported');
      }
      if (!db.prepare(o.session.sql).get(...o.session.params)) return emptyTranscriptPage('missing');
      const src = source(db, o, identity);
      const position = cursor?.position;
      if (position?.key) {
        // Gone, or a finished row rewritten in place: what the client holds no longer matches. A row the app was still
        // writing has no print: it is read again under the same item IDs instead.
        const anchor = src.at(position.key);
        if (!anchor || position.print !== undefined && src.print(anchor) !== position.print) return emptyTranscriptPage('reset');
      }
      const limit = Number.isFinite(o.request.limit)
        ? Math.max(1, Math.min(TRANSCRIPT_MAX_ITEMS, Math.floor(o.request.limit!))) : TRANSCRIPT_MAX_ITEMS;
      const seal = (next: Position) => sealCursor({ binding, identity, position: next } satisfies Cursor);
      let page: { items: TranscriptItem[]; before?: Position; after: Position; more: boolean };
      if (position && o.request.direction === 'after') {
        page = forward(src, position, limit);
      } else {
        const result = backward(src, position, limit);
        let after = position;
        if (!after) {
          const newest = result.seen[0];
          const pending = result.seen.slice(0, PENDING_ROWS).findLast(row => !row.final);
          after = pending ? { key: pending.key, skip: 0 } : newest ? src.mark(newest, newest.items.length) : { key: null, skip: 0 };
        }
        page = { ...result, after };
      }
      const latest = new Map(page.items.map((item, index) => [item.id, index]));
      const items = page.items.filter((item, index) => latest.get(item.id) === index);
      return { status: 'ok', items, before: page.before && seal(page.before), after: seal(page.after), hasMore: page.more,
        unknownCount: items.filter(item => item.kind === 'unknown').length };
    } finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

const absent = (path: string) => lstat(path, { bigint: true }).then(
  (stats) => stats,
  (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });

/** Read a bounded page of one session from the checked database file without writing any file. */
export async function readSqliteTranscript(o: SqliteTranscriptOptions): Promise<TranscriptPage> {
  const binding = digest(JSON.stringify([o.sessionKey, o.root, o.file, o.from, o.where, o.order]));
  const cursor = o.request.cursor === undefined ? undefined : openCursor<Cursor>(o.request.cursor);
  if (o.request.cursor !== undefined && (!cursor || cursor.binding !== binding)) return emptyTranscriptPage('reset');
  try {
    const confined = await confinedFile(o.root, o.file);
    if (!confined) return emptyTranscriptPage('refused');
    const { canonicalFile, checked } = confined;
    const identity = digest(JSON.stringify([binding, canonicalFile, String(checked.dev), String(checked.ino), String(checked.birthtimeNs)]));
    if (cursor && cursor.identity !== identity) return emptyTranscriptPage('reset');
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await lstat(canonicalFile, { bigint: true });
      const sides = await Promise.all([absent(`${canonicalFile}-wal`), absent(`${canonicalFile}-shm`)]);
      if (sides.some(side => side && (!side.isFile() || side.nlink !== 1n))) return emptyTranscriptPage('refused');
      // A -wal without its -shm: any open would create the -shm. Readable again once the app has opened the database.
      if (sides[0] && !sides[1]) return emptyTranscriptPage('unsupported');
      const shared = sides[0] !== undefined;
      const page = readOnce(o, canonicalFile, shared, identity, binding, cursor);
      const now = await lstat(canonicalFile, { bigint: true });
      if (!now.isFile() || now.nlink !== 1n || !sameFile(now, checked)) return emptyTranscriptPage('reset');
      // An immutable read is only valid if no writer touched the file meanwhile.
      if (shared || (now.size === before.size && now.mtimeNs === before.mtimeNs && !await absent(`${canonicalFile}-wal`))) return page;
    }
    return emptyTranscriptPage('refused');
  } catch (error) {
    if (error instanceof Unsupported) return emptyTranscriptPage('unsupported');
    const { code, errcode } = error as NodeJS.ErrnoException & { errcode?: number };
    if (code === 'ENOENT' || code === 'ENOTDIR') return emptyTranscriptPage('missing');
    // SQLITE_CORRUPT, SQLITE_NOTADB: not a database this reader understands.
    return emptyTranscriptPage(errcode === 11 || errcode === 26 ? 'unsupported' : 'refused');
  }
}
