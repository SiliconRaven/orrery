// A minimal, strict ZIP reader for installing a skill the user uploads (docs/files.md「安装 skill」). It reads the
// central directory of an in-memory archive and returns each entry's path and bytes; it never touches the disk. Only
// what a plain archive needs: stored and deflate entries, one disk, no zip64, no encryption. Anything else, and every
// name that could leave the destination folder or mean something special on Windows, is refused with a code.
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  entries: number;      // central directory entries, folders included
  fileBytes: number;    // one entry, uncompressed
  totalBytes: number;   // all entries, uncompressed
  ratio: number;        // uncompressed / compressed, checked for entries above RATIO_FLOOR
  depth: number;        // path segments
}

export const ZIP_LIMITS: ZipLimits = { entries: 1000, fileBytes: 20 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, ratio: 100, depth: 16 };
const RATIO_FLOOR = 64 * 1024;   // small entries (a run of spaces) may compress far better than 100:1 and are harmless

export interface ZipEntry { path: string; dir: boolean; data: Buffer }

/** A refusal; `code` is what the page explains (docs/files.md lists them). The message never holds archive content. */
export class ZipRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * The segments of an entry name, or a refusal: forward slashes only (a backslash is refused, not converted), relative,
 * no drive letter or colon (alternate data streams), no `.`/`..`/empty segment, no control character, nothing Windows
 * forbids or treats as a device, no trailing dot or space (Windows drops them, so two names could become one).
 */
function zipPathSegments(name: string, depth = ZIP_LIMITS.depth): string[] {
  const bad = () => new ZipRefused('zip_bad_name', 'the archive has an entry name that is not a plain relative path');
  if (!name || name.length > 512 || /[\u0000-\u001f\u007f\\:]/.test(name) || name.startsWith('/')) throw bad();
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  for (const s of segments) {
    if (!s || s === '.' || s === '..' || s.length > 255 || /[<>"|?*]/.test(s) || /[. ]$/.test(s) || WINDOWS_RESERVED.test(s)) throw bad();
  }
  if (segments.length > depth) throw new ZipRefused('too_deep', `the archive nests folders more than ${depth} deep`);
  return segments;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Every entry of `buf`, checked and inflated, in central directory order. Throws ZipRefused. */
export function readZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipEntry[] {
  const invalid = (why: string) => new ZipRefused('zip_invalid', `not a readable ZIP archive (${why})`);
  const unsupported = (why: string) => new ZipRefused('zip_unsupported', `this kind of ZIP archive is not supported (${why})`);
  // End of central directory: 22 bytes plus a comment of at most 65535, so it is in the last 65557 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw invalid('no end of central directory');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw unsupported('zip64');
  const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8), total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw unsupported('zip64');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw unsupported('split across several disks');
  if (total > limits.entries) throw new ZipRefused('too_many_files', `the archive has more than ${limits.entries} entries`);
  if (cdOffset + cdSize > eocd) throw invalid('central directory out of range');

  type Raw = { name: string; dir: boolean; method: number; crc: number; csize: number; usize: number; local: number; nameBytes: Buffer };
  const raws: Raw[] = [];
  const seen = new Set<string>(), files = new Set<string>(), dirs = new Set<string>();
  let totalBytes = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== 0x02014b50) throw invalid('bad central directory entry');
    const madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cdOffset + cdSize) throw invalid('central directory entry out of range');
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    if (flags & 0x41 || method === 99) throw new ZipRefused('zip_encrypted', 'the archive is encrypted');
    if (method !== 0 && method !== 8) throw unsupported(`compression method ${method}`);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw unsupported('zip64');
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
      if (buf.readUInt16LE(e) === 0x0001) throw unsupported('zip64');
      e += 4 + buf.readUInt16LE(e + 2);
    }
    // Links: a Unix mode of S_IFLNK, or the Windows reparse-point attribute.
    if (((madeBy >> 8) === 3 && ((external >>> 16) & 0xf000) === 0xa000) || (external & 0x400)) {
      throw new ZipRefused('zip_symlink', 'the archive contains a link (symbolic link or junction)');
    }
    let name: string;
    try {
      if (flags & 0x800) name = utf8.decode(nameBytes);
      else if (nameBytes.every((b) => b < 0x80)) name = nameBytes.toString('latin1');
      else throw new Error('not utf-8');
    } catch {
      throw new ZipRefused('zip_bad_name', 'the archive has an entry name that is not UTF-8');
    }
    const segments = zipPathSegments(name, limits.depth);
    const dir = name.endsWith('/');
    if (dir && usize !== 0) throw invalid('a folder entry with content');
    // Windows compares names without case: two entries that differ only in case, or a file where a folder must be, clash.
    const key = segments.join('/').normalize('NFC').toLowerCase();
    if (seen.has(key) || (!dir && dirs.has(key)) || (dir && files.has(key))) throw new ZipRefused('zip_duplicate', 'the archive has two entries with the same name');
    seen.add(key);
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/').normalize('NFC').toLowerCase();
      if (files.has(parent)) throw new ZipRefused('zip_duplicate', 'the archive has a file where a folder must be');
      dirs.add(parent);
    }
    (dir ? dirs : files).add(key);
    if (usize > limits.fileBytes) throw new ZipRefused('too_large', `a file in the archive is larger than ${limits.fileBytes / 1024 / 1024} MB`);
    totalBytes += usize;
    if (totalBytes > limits.totalBytes) throw new ZipRefused('too_large', `the archive unpacks to more than ${limits.totalBytes / 1024 / 1024} MB`);
    if (usize > RATIO_FLOOR && (csize === 0 || usize / csize > limits.ratio)) throw new ZipRefused('zip_ratio', `a file in the archive is compressed more than ${limits.ratio}:1`);
    raws.push({ name: segments.join('/'), dir, method, crc, csize, usize, local, nameBytes });
    p = end;
  }

  // Local headers: the same name, data inside the area before the central directory, no two entries overlapping.
  const placed = raws.map((r) => {
    if (r.local + 30 > cdOffset || buf.readUInt32LE(r.local) !== 0x04034b50) throw invalid('bad local header');
    const nameLen = buf.readUInt16LE(r.local + 26), extraLen = buf.readUInt16LE(r.local + 28);
    if (buf.readUInt16LE(r.local + 6) & 0x41) throw new ZipRefused('zip_encrypted', 'the archive is encrypted');
    if (!buf.subarray(r.local + 30, r.local + 30 + nameLen).equals(r.nameBytes)) throw invalid('local and central names differ');
    const start = r.local + 30 + nameLen + extraLen;
    if (start + r.csize > cdOffset) throw invalid('entry data out of range');
    return { r, start, end: start + r.csize };
  });
  const byOffset = [...placed].sort((a, b) => a.r.local - b.r.local);
  for (let i = 1; i < byOffset.length; i++) if (byOffset[i].r.local < byOffset[i - 1].end) throw invalid('overlapping entries');

  return placed.map(({ r, start, end }) => {
    const packed = buf.subarray(start, end);
    let data: Buffer;
    if (r.method === 0) data = Buffer.from(packed);
    else {
      try {
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, r.usize) });
      } catch {
        throw invalid('an entry does not inflate to its declared size');
      }
    }
    if (data.length !== r.usize) throw invalid('an entry does not inflate to its declared size');
    if ((crc32(data) >>> 0) !== r.crc) throw new ZipRefused('zip_crc', 'a file in the archive fails its checksum (the archive is damaged)');
    return { path: r.name, dir: r.dir, data };
  });
}
