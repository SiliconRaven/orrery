// Read-only helpers for the harnesses' own JSONL files (docs/usage.md): the last matching line of a file, read from
// the end; and a fold over a growing file that reads only what was appended since the last call. Neither ever writes.
import { open, stat } from 'node:fs/promises';
import type { TokenTotals } from '../../core/types.ts';

const BLOCK = 256 * 1024;

/**
 * The newest line of `file` (read backwards in blocks) that contains `needle` and for which `pick` returns a value;
 * undefined when none does. Lines that are not JSON (e.g. one still being written) are skipped.
 */
export async function lastMatch<T>(file: string, needle: string, pick: (entry: any) => T | undefined): Promise<T | undefined> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const want = Buffer.from(needle, 'utf8');
    let end = size;
    let carry = Buffer.alloc(0);   // the start of a line whose beginning lies before the block read last
    const check = (line: Buffer): T | undefined => {
      if (line.indexOf(want) < 0) return undefined;
      try { return pick(JSON.parse(line.toString('utf8'))); } catch { return undefined; }
    };
    while (end > 0) {
      const start = Math.max(0, end - BLOCK);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      let lineEnd = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        const found = check(data.subarray(i + 1, lineEnd));
        if (found !== undefined) return found;
        lineEnd = i;
      }
      carry = data.subarray(0, lineEnd);
      if (start === 0) return check(carry);
      end = start;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

interface FoldState<S> { size: number; offset: number; ino: number; state: S }

/**
 * Folds every JSON line of a file into a state, incrementally: each call reads only complete lines appended since the
 * previous one. A file that shrank or was replaced (another inode) is folded again from the start.
 */
export class JsonlFold<S> {
  private readonly files = new Map<string, FoldState<S>>();
  private readonly init: () => S;
  private readonly step: (state: S, entry: any) => void;
  constructor(init: () => S, step: (state: S, entry: any) => void) {
    this.init = init;
    this.step = step;
  }

  private readonly busy = new Map<string, Promise<unknown>>();

  /**
   * The state after the whole file; null when it cannot be read. Reads of the same file run one after another: two at
   * once would both fold the same new lines into the one state.
   */
  read(file: string): Promise<S | null> {
    const run = () => this.readNow(file);
    const p = (this.busy.get(file) ?? Promise.resolve()).then(run, run);
    const tail = p.catch(() => {});
    this.busy.set(file, tail);
    void tail.then(() => { if (this.busy.get(file) === tail) this.busy.delete(file); });
    return p;
  }

  private async readNow(file: string): Promise<S | null> {
    let s;
    try { s = await stat(file); } catch { this.files.delete(file); return null; }
    let f = this.files.get(file);
    if (!f || s.size < f.offset || s.ino !== f.ino) f = { size: 0, offset: 0, ino: s.ino, state: this.init() };
    if (s.size === f.size) { this.files.set(file, f); return f.state; }
    try {
      const fh = await open(file, 'r');
      try {
        let rest = Buffer.alloc(0);
        let pos = f.offset;
        while (pos < s.size) {
          const buf = Buffer.alloc(Math.min(4 * BLOCK, s.size - pos));
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          pos += bytesRead;
          const data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          let lineStart = 0;
          for (let i = 0; i < data.length; i++) {
            if (data[i] !== 0x0a) continue;
            const line = data.subarray(lineStart, i);
            lineStart = i + 1;
            if (!line.length) continue;
            let entry: unknown;
            try { entry = JSON.parse(line.toString('utf8')); } catch { continue; }
            this.step(f.state, entry);
          }
          rest = Buffer.from(data.subarray(lineStart));
        }
        // An unfinished last line is read again next time.
        f.offset = pos - rest.length;
        f.size = s.size;
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
    this.files.set(file, f);
    return f.state;
  }
}

/** Zero tokens. */
export const noTokens = (): TokenTotals => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 });

/** Adds `b` into `a` (in place) and returns `a`. */
export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  a.input += b.input;
  a.cachedInput += b.cachedInput;
  a.cacheWrite += b.cacheWrite;
  a.output += b.output;
  a.reasoning += b.reasoning;
  return a;
}

/** A non-negative safe integer, else 0 (counts from files are data, not trusted). */
export const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
