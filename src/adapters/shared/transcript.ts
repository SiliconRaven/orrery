import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { emptyTranscriptPage, TRANSCRIPT_MAX_ITEMS, truncateTranscriptText, type TranscriptItem,
  type TranscriptPage, type TranscriptRequest } from '../../core/types.ts';

export const TRANSCRIPT_ZSTD_INPUT_BYTES = 16 * 1024 * 1024;
export const TRANSCRIPT_ZSTD_OUTPUT_BYTES = 64 * 1024 * 1024;
const SCAN_BYTES = 1024 * 1024;
const LINE_BYTES = 256 * 1024;
export const TRANSCRIPT_LINE_BYTES = LINE_BYTES;
const PREFIX_BYTES = 64 * 1024;
const ANCHOR_BYTES = 4096;
const LF = 0x0a;
const cursorKey = randomBytes(32);

export type TranscriptDraft = Omit<TranscriptItem, 'id'> & { id?: string };

export interface ReadOptions {
  root: string;
  file: string;
  sessionKey: string;
  request: TranscriptRequest;
  parse: (value: unknown, raw: string, offset: number) => TranscriptDraft[] | undefined;
  prepare?: (prefix: Buffer) => 'unsupported' | 'refused' | void;
  /** Bytes passed to prepare; defaults to PREFIX_BYTES (64 KiB), capped at SCAN_BYTES. */
  prefixBytes?: number;
  unknownText?: string;
  /** Longest record parsed; longer ones become one unknown item. Defaults to LINE_BYTES. */
  lineBytes?: number;
  /** Must impose its own decoding window and output limits as well. */
  decompress?: (input: Buffer) => Promise<Buffer>;
}

type Position =
  | { offset: number; mode: 'line' }
  | { offset: number; mode: 'items'; end: number; index: number }
  | { offset: number; mode: 'backward'; end: number; partial: boolean }
  | { offset: number; mode: 'forward'; start?: number };
interface Cursor {
  binding: string;
  identity: string;
  size: number;
  stamp: string;
  position: Position;
  seal: string;
}
interface Source {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}
interface Scan {
  items: TranscriptItem[];
  first?: Position;
  last: Position;
  more: boolean;
}

const line = (offset: number): Position => ({ offset, mode: 'line' });
const item = (offset: number, end: number, index: number): Position => index === 0
  ? line(offset) : { offset, mode: 'items', end, index };
export const signing = () => createHmac('sha256', cursorKey);
/** Keyed with this process's cursor key: the same input gives the same value until the Hub restarts. */
export const digest = (value: string) => signing().update(value).digest('base64url');
const stamp = (s: BigIntStats) => `${s.mtimeNs}:${s.ctimeNs}`;
export const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const within = (path: string) => path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);

/** A signed, opaque cursor. Only this process can make one that openCursor accepts. */
export function sealCursor(cursor: object): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${body}.${digest(body)}`;
}

export function openCursor<T>(cursor: string): T | undefined {
  if (!/^[\w-]{1,1024}\.[\w-]{43}$/.test(cursor)) return undefined;
  const [body, signature] = cursor.split('.') as [string, string];
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(digest(body)))) return undefined;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
}
const encode = (cursor: Cursor) => sealCursor(cursor);
const decode = (cursor: string) => openCursor<Cursor>(cursor);

export class TranscriptChanged extends Error {}

export async function readExactly(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const data = Buffer.alloc(length);
  for (let done = 0; done < length;) {
    const { bytesRead } = await handle.read(data, done, length - done, offset + done);
    if (bytesRead === 0) throw new TranscriptChanged();
    done += bytesRead;
  }
  return data;
}

/**
 * The path must resolve to the adapter's named child: a plain file with one link. A link to another file is refused
 * even within the root. Throws ENOENT when it does not exist.
 */
export async function confinedFile(root: string, file: string) {
  const child = relative(root, file);
  if (!within(child)) return undefined;
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(file);
  const actualChild = relative(canonicalRoot, canonicalFile);
  if (!within(actualChild) || relative(child, actualChild) !== '') return undefined;
  const checked = await lstat(file, { bigint: true });
  return checked.isFile() && checked.nlink === 1n ? { canonicalRoot, canonicalFile, checked } : undefined;
}

export async function openTranscript(root: string, file: string) {
  const confined = await confinedFile(root, file);
  if (!confined) return undefined;
  const { canonicalRoot, canonicalFile, checked } = confined;
  const handle = await open(canonicalFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = await handle.stat({ bigint: true });
    if (stats.isFile() && stats.nlink === 1n && sameFile(checked, stats)
      && relative(canonicalRoot, await realpath(root)) === '' && relative(canonicalFile, await realpath(file)) === '') {
      return { handle, stats, canonicalFile };
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return undefined;
}

/** Inspect the same bounded prefix and confined file used by the page reader. */
export async function inspectTranscriptPrefix<T>(root: string, file: string, inspect: (prefix: Buffer) => T): Promise<T | undefined> {
  try {
    const opened = await openTranscript(root, file);
    if (!opened) return undefined;
    const { handle, stats } = opened;
    try {
      return inspect(await readExactly(handle, 0, Math.min(PREFIX_BYTES, Number(stats.size))));
    } finally { await handle.close(); }
  } catch { return undefined; }
}

async function seal(source: Source, size: number, position: Position): Promise<string> {
  // shortcut: an in-place edit combined with growth can evade sampled anchors, use a full prefix digest if writers
  // stop appending or observable file generations become available. Same-size rewrites use the stat stamp as well.
  const hash = signing();
  const starts = new Set([0, Math.max(0, size - ANCHOR_BYTES), Math.max(0, position.offset - ANCHOR_BYTES / 2)]);
  for (const offset of starts) hash.update(await source.read(offset, Math.min(ANCHOR_BYTES, size - offset)));
  return hash.digest('base64url');
}

export function records(options: ReadOptions, identity: string) {
  return (offset: number, data?: Buffer): TranscriptItem[] => {
    let drafts: TranscriptDraft[] | undefined;
    if (data && data.length <= (options.lineBytes ?? LINE_BYTES)) {
      const raw = data.toString('utf8').replace(/\r$/, '');
      if (!raw.trim()) return [];
      try { drafts = options.parse(JSON.parse(raw), raw, offset); } catch { /* One bad record does not stop the page. */ }
      drafts ??= [{ kind: 'unknown', text: options.unknownText ?? raw }];
    } else {
      drafts = [{ kind: 'unknown', text: options.unknownText ?? 'Record exceeds the read limit.', truncated: true }];
    }
    return drafts.map((draft, index) => ({ ...draft, id: draft.id ?? `${identity.slice(0, 16)}:${offset}:${index}`,
      ...(draft.text === undefined ? {} : truncateTranscriptText(draft.text)) }));
  };
}

function takeBackward(data: Buffer, low: number, high: number, position: Position, limit: number,
  parse: ReturnType<typeof records>, initial: boolean): Scan {
  const items: TranscriptItem[] = [];
  let end = high;
  let first = position;
  let skip = position.mode === 'backward' ? position : undefined;
  let last: Position = skip ? (skip.partial ? { offset: skip.end, mode: 'forward' } : line(skip.end)) : position;
  if (initial) {
    end = low + data.lastIndexOf(LF) + 1;
    first = last = line(end);
    if (end === low && low > 0) {
      return { items, first: { offset: low, mode: 'backward', end: high, partial: true },
        last: { offset: high, mode: 'forward' }, more: true };
    }
  }

  while (end > low && items.length < limit) {
    const max = end - low - (skip ? 1 : 2);
    const previous = max >= 0 ? data.lastIndexOf(LF, max) : -1;
    if (previous < 0 && low > 0) {
      // Resume from the boundary on a fresh window. A full window with no boundary belongs to one oversized row.
      if (skip || end === high) first = { offset: low, mode: 'backward', end: skip?.end ?? end, partial: skip?.partial ?? false };
      break;
    }
    const start = low + previous + 1;
    const rowEnd = skip?.end ?? end;
    const parsed = skip?.partial ? [] : parse(start, skip ? undefined : data.subarray(start - low, end - low - 1));
    const stop = position.mode === 'items' && end === high ? position.index : parsed.length;
    const from = Math.max(0, stop - (limit - items.length));
    for (let i = stop - 1; i >= from; i--) items.push(parsed[i]!);
    first = item(start, rowEnd, from);
    if (skip) last = skip.partial ? line(start) : line(rowEnd);
    skip = undefined;
    end = start;
  }
  return { items: items.reverse(), first, last, more: first.offset > 0 || first.mode !== 'line' };
}

function takeForward(data: Buffer, position: Position, size: number, limit: number,
  parse: ReturnType<typeof records>): Scan {
  const items: TranscriptItem[] = [];
  const low = position.offset;
  let start = 0;
  let first = position.mode === 'forward' ? (position.start === undefined ? undefined : line(position.start)) : position;
  let last = position;
  let more = false;
  while (start < data.length && items.length < limit) {
    const newline = data.indexOf(LF, start);
    const skipping = start === 0 && position.mode === 'forward';
    if (newline < 0) {
      more = low + data.length < size;
      // The rest of an oversized record may take several bounded reads before its newline is written.
      if (skipping || data.length - start > LINE_BYTES) {
        last = { offset: low + data.length, mode: 'forward', start: skipping ? position.start : low + start };
      }
      break;
    }
    const rowStart = skipping ? (position.start ?? low) : low + start;
    const end = low + newline + 1;
    const parsed = parse(rowStart, skipping ? undefined : data.subarray(start, newline));
    const from = position.mode === 'items' && start === 0 ? position.index : 0;
    const stop = Math.min(parsed.length, from + limit - items.length);
    if (!items.length && stop > from && (!skipping || position.start !== undefined)) first = item(rowStart, end, from);
    items.push(...parsed.slice(from, stop));
    last = stop < parsed.length ? item(rowStart, end, stop) : line(end);
    more = stop < parsed.length || low + data.length < size || data.indexOf(LF, newline + 1) >= 0;
    start = newline + 1;
  }
  return { items, first, last, more };
}

/** Read a bounded page of complete records using only the checked native transcript file. */
export async function readTranscriptPage(options: ReadOptions): Promise<TranscriptPage> {
  const { request } = options;
  const cursor = request.cursor === undefined ? undefined : decode(request.cursor);
  const binding = digest(JSON.stringify([options.sessionKey, options.root, options.file, !!options.decompress]));
  if (request.cursor !== undefined && (!cursor || cursor.binding !== binding)) return emptyTranscriptPage('reset');
  try {
    const opened = await openTranscript(options.root, options.file);
    if (!opened) return emptyTranscriptPage('refused');
    const { handle, stats, canonicalFile } = opened;
    try {
      const fileSize = Number(stats.size);
      if (!Number.isSafeInteger(fileSize)) return emptyTranscriptPage('refused');
      const identity = digest(JSON.stringify([binding, canonicalFile, String(stats.dev), String(stats.ino), String(stats.birthtimeNs)]));
      const time = stamp(stats);
      if (cursor && (cursor.identity !== identity || options.decompress && cursor.stamp !== time)) return emptyTranscriptPage('reset');
      let source: Source = { size: fileSize, read: (offset, length) => readExactly(handle, offset, length) };
      if (options.decompress) {
        if (fileSize > TRANSCRIPT_ZSTD_INPUT_BYTES) return emptyTranscriptPage('archived');
        const input = await source.read(0, fileSize);
        try {
          const output = await options.decompress(input);
          if (output.length > TRANSCRIPT_ZSTD_OUTPUT_BYTES) return emptyTranscriptPage('archived');
          source = { size: output.length, read: async (offset, length) => output.subarray(offset, offset + length) };
        } catch { return emptyTranscriptPage('archived'); }
      }
      if (cursor && (source.size < cursor.size || source.size === cursor.size && time !== cursor.stamp
        || cursor.seal !== await seal(source, cursor.size, cursor.position))) return emptyTranscriptPage('reset');
      const prefixBytes = Math.max(0, Math.min(options.prefixBytes ?? PREFIX_BYTES, SCAN_BYTES));
      const denied = options.prepare?.(await source.read(0, Math.min(prefixBytes, source.size)));
      if (denied) return emptyTranscriptPage(denied);

      const backwards = !cursor || request.direction !== 'after';
      const limit = Number.isFinite(request.limit) ? Math.max(1, Math.min(TRANSCRIPT_MAX_ITEMS, Math.floor(request.limit!))) : TRANSCRIPT_MAX_ITEMS;
      const position = cursor?.position ?? line(source.size);
      const parse = records(options, identity);
      let result: Scan;
      if (backwards) {
        const high = position.mode === 'items' ? position.end : position.offset;
        const low = Math.max(0, high - SCAN_BYTES);
        result = takeBackward(await source.read(low, high - low), low, high, position, limit, parse, !cursor);
      } else {
        const low = position.offset;
        result = takeForward(await source.read(low, Math.min(source.size - low, SCAN_BYTES)), position, source.size, limit, parse);
      }
      const makeCursor = async (next: Position) => encode({ binding, identity, size: source.size, stamp: time, position: next,
        seal: await seal(source, source.size, next) });
      const before = result.first && (result.first.offset > 0 || result.first.mode === 'items') ? await makeCursor(result.first) : undefined;
      const after = await makeCursor(result.last);
      const current = await handle.stat({ bigint: true });
      const named = await lstat(options.file, { bigint: true }).catch(() => undefined);
      if (current.nlink !== 1n || current.size < stats.size || current.size === stats.size && stamp(current) !== time) {
        return emptyTranscriptPage('reset');
      }
      if (!named?.isFile() || named.nlink !== 1n || !sameFile(named, stats)
        || relative(canonicalFile, await realpath(options.file)) !== '') return emptyTranscriptPage('reset');
      const latest = new Map(result.items.map((entry, index) => [entry.id, index]));
      const items = result.items.filter((entry, index) => latest.get(entry.id) === index);
      return { status: 'ok', items, before, after, hasMore: result.more,
        unknownCount: items.filter(entry => entry.kind === 'unknown').length };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof TranscriptChanged) return emptyTranscriptPage('reset');
    const code = (error as NodeJS.ErrnoException)?.code;
    return emptyTranscriptPage(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'refused');
  }
}
