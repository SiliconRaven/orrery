// A transcript that a writer appends to one zstd frame at a time (a JSONL record stream split across frames).
// Frame ends are found from the zstd headers alone (RFC 8878: frame header, then 3-byte block headers), so a page
// inflates only the frames it shows. Node's zstd decoder silently stops after the first frame and accepts a frame
// whose checksum is cut off, so it is only ever given one complete frame. Positions are (frame start, record, item):
// appending frames keeps them valid. docs/adapters/deepseek.md「读原生对话」.
import { lstat, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { relative } from 'node:path';
import { promisify } from 'node:util';
import { constants, zstdDecompress } from 'node:zlib';
import { emptyTranscriptPage, TRANSCRIPT_MAX_ITEMS, type TranscriptItem, type TranscriptPage } from '../../core/types.ts';
import { digest, openCursor, openTranscript, readExactly, records, sameFile, sealCursor, signing, TranscriptChanged,
  type ReadOptions } from './transcript.ts';

/** A compressed file larger than this is not read at all: the page is `archived`. */
export const FRAMED_INPUT_BYTES = 32 * 1024 * 1024;
/** One frame inflates to at most this; a larger or invalid frame becomes one unknown item. */
export const FRAMED_FRAME_BYTES = 4 * 1024 * 1024;
/** A page stops inflating further frames after this many output bytes or frames and continues with a cursor. */
export const FRAMED_PAGE_BYTES = 8 * 1024 * 1024;
export const FRAMED_PAGE_FRAMES = 1024;
const WINDOW_LOG_MAX = 23;          // 8 MiB decoder window
const PREFIX_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const ANCHOR_BYTES = 4096;
const SPAN = 2 ** 23;               // > FRAMED_FRAME_BYTES: item ids use frame start * SPAN + record start
const BLOCK_MAX = 128 * 1024;
const inflate = promisify(zstdDecompress);

interface Frame { start: number; end: number; skip: boolean }
/** The boundary before item `i` of record `r` in the frame that starts at byte `f` (or at the end of the frames). */
interface Boundary { f: number; r: number; i: number }
interface Cursor { binding: string; identity: string; size: number; position: Boundary; seal: string }
interface Entry { r: number; i: number; item: TranscriptItem }

const atOrAfter = (e: Entry, b: Boundary) => e.r > b.r || e.r === b.r && e.i >= b.i;

/** Complete frames from byte 0, read in bounded chunks. A partly written last frame is left out until it is complete. */
async function walk(handle: FileHandle, size: number): Promise<{ frames: Frame[]; end: number } | 'unsupported'> {
  let base = 0;
  let chunk: Buffer = Buffer.alloc(0);
  const view = async (at: number, length: number) => {
    if (at + length > size) return undefined;
    if (at < base || at + length > base + chunk.length) {
      base = at;
      chunk = await readExactly(handle, at, Math.min(CHUNK_BYTES, size - at));
    }
    return chunk.subarray(at - base, at - base + length);
  };
  const frames: Frame[] = [];
  for (let at = 0; ;) {
    const magic = (await view(at, 4))?.readUInt32LE(0);
    if (magic === undefined) return { frames, end: at };
    let end: number;
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {          // skippable frame
      const length = (await view(at + 4, 4))?.readUInt32LE(0);
      if (length === undefined) return { frames, end: at };
      end = at + 8 + length;
    } else {
      if (magic !== 0xfd2fb528) return 'unsupported';
      const fhd = (await view(at + 4, 1))?.[0];
      if (fhd === undefined) return { frames, end: at };
      if (fhd & 0x08) return 'unsupported';                    // reserved bit
      const single = (fhd >> 5) & 1;
      let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3]! + [single, 2, 4, 8][fhd >> 6]!;
      for (let last = 0; !last;) {
        const header = await view(p, 3);
        if (!header) return { frames, end: at };
        const value = header[0]! | header[1]! << 8 | header[2]! << 16;
        const type = (value >> 1) & 3;
        if (type === 3 || value >>> 3 > BLOCK_MAX) return 'unsupported';
        last = value & 1;
        p += 3 + (type === 1 ? 1 : value >>> 3);
      }
      end = p + ((fhd >> 2) & 1 ? 4 : 0);
    }
    if (end > size) return { frames, end: at };
    frames.push({ start: at, end, skip: magic !== 0xfd2fb528 });
    at = end;
  }
}

async function seal(handle: FileHandle, size: number, f: number): Promise<string> {
  // shortcut: sampled anchors as in transcript.ts; a same-size rewrite that keeps the frame layout and these bytes is
  // not detected. Use a digest of the whole prefix if a writer is seen rewriting logs in place.
  const hash = signing();
  for (const offset of new Set([0, Math.max(0, size - ANCHOR_BYTES), Math.max(0, f - ANCHOR_BYTES / 2)])) {
    hash.update(await readExactly(handle, offset, Math.min(ANCHOR_BYTES, size - offset)));
  }
  return hash.digest('base64url');
}

/** Read a bounded page of records from a file of appended zstd frames, with the same contract as readTranscriptPage. */
export async function readFramedTranscriptPage(options: ReadOptions): Promise<TranscriptPage> {
  const { request } = options;
  const cursor = request.cursor === undefined ? undefined : openCursor<Cursor>(request.cursor);
  const binding = digest(JSON.stringify([options.sessionKey, options.root, options.file, 'zstd-frames']));
  if (request.cursor !== undefined && (!cursor || cursor.binding !== binding)) return emptyTranscriptPage('reset');
  try {
    const opened = await openTranscript(options.root, options.file);
    if (!opened) return emptyTranscriptPage('refused');
    const { handle, stats, canonicalFile } = opened;
    try {
      const size = Number(stats.size);
      if (!Number.isSafeInteger(size)) return emptyTranscriptPage('refused');
      if (size > FRAMED_INPUT_BYTES) return emptyTranscriptPage('archived');
      const identity = digest(JSON.stringify([binding, canonicalFile, String(stats.dev), String(stats.ino), String(stats.birthtimeNs)]));
      if (cursor && cursor.identity !== identity) return emptyTranscriptPage('reset');
      const walked = await walk(handle, size);
      if (walked === 'unsupported') return emptyTranscriptPage('unsupported');
      const { frames, end } = walked;
      const index = (f: number) => f === end ? frames.length : frames.findIndex((frame) => frame.start === f);
      if (cursor && (end < cursor.size || index(cursor.position.f) < 0
        || cursor.seal !== await seal(handle, cursor.size, cursor.position.f))) return emptyTranscriptPage('reset');

      // Every byte inflated counts against the page, the header probe included; its frame is not inflated twice.
      let spent = 0;
      let pageFrames = 0;
      let probe: { start: number; data: Buffer | undefined } | undefined;
      const output = async (frame: Frame): Promise<Buffer | undefined> => {
        if (frame.skip) return Buffer.alloc(0);
        if (frame.start === probe?.start) return probe.data;
        // A frame cannot shrink much below its compressed size, so this one would exceed the output limit anyway.
        if (frame.end - frame.start > 2 * FRAMED_FRAME_BYTES) return undefined;
        const input = await readExactly(handle, frame.start, frame.end - frame.start);
        try {
          const data = await inflate(input, { maxOutputLength: FRAMED_FRAME_BYTES, params: { [constants.ZSTD_d_windowLogMax]: WINDOW_LOG_MAX } });
          spent += data.length;
          return data;
        } catch { return undefined; }   // corrupt, checksum mismatch, window or output over the limit
      };
      const first = frames.find((frame) => !frame.skip);
      if (first && options.prepare) {
        const data = await output(first);
        probe = { start: first.start, data };
        const denied = data ? options.prepare(data.subarray(0, PREFIX_BYTES)) : 'unsupported';
        if (denied) return emptyTranscriptPage(denied);
      }
      const parse = records(options, identity);
      const entries = async (frame: Frame): Promise<Entry[]> => {
        const data = await output(frame);
        pageFrames++;
        if (!data) return parse(frame.start * SPAN, undefined).map((item, i) => ({ r: 0, i, item }));
        const list: Entry[] = [];
        for (let start = 0, r = 0; start < data.length; r++) {
          const newline = data.indexOf(10, start);
          const stop = newline < 0 ? data.length : newline;
          parse(frame.start * SPAN + start, data.subarray(start, stop)).forEach((item, i) => list.push({ r, i, item }));
          start = stop + 1;
        }
        return list;
      };
      // A frame's output size is known only once inflated, so a frame is started only while one frame's limit still fits
      // the page: a page never inflates more than FRAMED_PAGE_BYTES. Its first frame is always read, so a page advances.
      const fits = (frame: Frame) => pageFrames === 0 || pageFrames < FRAMED_PAGE_FRAMES
        && (frame.skip || frame.start === probe?.start || FRAMED_PAGE_BYTES - spent >= FRAMED_FRAME_BYTES);

      const limit = Number.isFinite(request.limit) ? Math.max(1, Math.min(TRANSCRIPT_MAX_ITEMS, Math.floor(request.limit!))) : TRANSCRIPT_MAX_ITEMS;
      const position: Boundary = cursor?.position ?? { f: end, r: 0, i: 0 };
      const home = index(position.f);
      const taken: TranscriptItem[] = [];
      let before: Boundary | undefined;
      let after = position;
      let more: boolean;
      if (!cursor || request.direction !== 'after') {
        before = position;
        for (let k = Math.min(home, frames.length - 1); k >= 0 && taken.length < limit && fits(frames[k]!); k--) {
          if (k === home && position.r === 0 && position.i === 0) continue;
          const list = await entries(frames[k]!);
          let from = k === home ? list.findIndex((e) => atOrAfter(e, position)) : list.length;
          if (from < 0) from = list.length;
          while (from > 0 && taken.length < limit) taken.push(list[--from]!.item);
          before = from === 0 ? { f: frames[k]!.start, r: 0, i: 0 } : { f: frames[k]!.start, r: list[from]!.r, i: list[from]!.i };
        }
        taken.reverse();
        more = before.f > 0 || before.r > 0 || before.i > 0;
      } else {
        let k = home;
        for (; k < frames.length && taken.length < limit && fits(frames[k]!); k++) {
          const list = await entries(frames[k]!);
          let from = k === home ? list.findIndex((e) => atOrAfter(e, position)) : 0;
          if (from < 0) from = list.length;
          if (from < list.length && !before) before = { f: frames[k]!.start, r: list[from]!.r, i: list[from]!.i };
          while (from < list.length && taken.length < limit) taken.push(list[from++]!.item);
          after = from < list.length ? { f: frames[k]!.start, r: list[from]!.r, i: list[from]!.i } : { f: frames[k + 1]?.start ?? end, r: 0, i: 0 };
          if (from < list.length) break;
        }
        before ??= position;
        more = index(after.f) < frames.length;
      }

      const makeCursor = async (next: Boundary) => sealCursor({ binding, identity, size: end, position: next,
        seal: await seal(handle, end, next.f) } satisfies Cursor);
      const page = { before: before.f > 0 || before.r > 0 || before.i > 0 ? await makeCursor(before) : undefined, after: await makeCursor(after) };
      const current = await handle.stat({ bigint: true });
      const named = await lstat(options.file, { bigint: true }).catch(() => undefined);
      if (current.nlink !== 1n || current.size < stats.size || !named?.isFile() || named.nlink !== 1n || !sameFile(named, stats)
        || relative(canonicalFile, await realpath(options.file)) !== '') return emptyTranscriptPage('reset');
      const latest = new Map(taken.map((entry, i) => [entry.id, i]));
      const items = taken.filter((entry, i) => latest.get(entry.id) === i);
      return { status: 'ok', items, ...page, hasMore: more, unknownCount: items.filter((entry) => entry.kind === 'unknown').length };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof TranscriptChanged) return emptyTranscriptPage('reset');
    const code = (error as NodeJS.ErrnoException)?.code;
    return emptyTranscriptPage(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'refused');
  }
}
