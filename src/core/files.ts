// Files the Hub keeps for messages (docs/files.md): <dir>/<file id>/<sanitized name>, one row each in `files`.
// Bytes come from the web page's upload (the user), or from a native member's own outbox folder
// <outbox root>/<member id>/, where the member puts a file with its own tools (its own permissions and approvals)
// before naming it in send_message. The Hub never opens a path a member names, only a bare file name directly in
// that member's folder, and it only copies: it never deletes or changes anything in an outbox.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, rmdir, stat, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Store } from './store.ts';
import type { FileInfo } from './types.ts';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
const MAX_NAME = 120;
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export const isFileId = (id: unknown): id is string => typeof id === 'string' && FILE_ID_RE.test(id);

/**
 * A name that is safe as one path segment on Windows and elsewhere, or a throw. Path separators, control characters
 * and the characters Windows forbids become '_'; leading/trailing dots and spaces go; device names get a '_' prefix.
 */
export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('file name is required');
  let s = name.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"/\\|?*]/gu, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (WINDOWS_DEVICE.test(s)) s = `_${s}`;
  if ([...s].length > MAX_NAME) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = [...s.slice(0, s.length - ext.length)].slice(0, MAX_NAME - [...ext].length).join('') + ext;
  }
  if (!s || /^_+$/.test(s)) throw new Error(`invalid file name ${JSON.stringify(name.slice(0, 200))}`);
  return s;
}

/** The raster image type the first bytes prove (PNG, JPEG, GIF, WebP), else null. SVG, HTML and the rest never are. */
export function sniffImage(head: Uint8Array): string | null {
  const b = Buffer.from(head.buffer, head.byteOffset, Math.min(head.byteLength, 16));
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * A file name as a member names it in send_message: one plain segment that sanitizeName leaves unchanged. No
 * separators, `..`, drive or UNC prefix, colon (so no alternate data stream), control or Windows-forbidden character.
 */
export function outboxName(name: unknown): string {
  const refuse = () => new Error(`attachment ${JSON.stringify(typeof name === 'string' ? name.slice(0, 200) : name)} must be the bare name of a file in the orrery outbox (no folders or paths)`);
  if (typeof name !== 'string' || /[\\/:]/.test(name)) throw refuse();
  let safe: string;
  try {
    safe = sanitizeName(name);
  } catch {
    throw refuse();
  }
  if (safe !== name) throw refuse();
  return name;
}

export interface FileStoreOptions {
  dir: string;                 // where the bytes go: <ORRERY_HOME>/files
  outbox: string;              // the outbox root, <ORRERY_HOME>/outbox: one folder per native member under it (created)
  protectedFiles: string[];    // never attachable, under any name (hard link): secret, hub.json, the database and its journals
}

const MEMBER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FileStore {
  readonly dir: string;
  readonly outbox: string;
  private readonly store: Store;
  private readonly protectedFiles: string[];
  // The outbox root as it was at start-up: its identity and real path. An import refuses a root that was replaced,
  // turned into a link, or was a link to begin with (null), instead of following it.
  private readonly root: { dev: bigint; ino: bigint; real: string } | null;
  private readonly uploadRoot: { dev: bigint; ino: bigint; real: string } | null;

  constructor(store: Store, opts: FileStoreOptions) {
    this.store = store;
    this.dir = resolve(opts.dir);
    this.outbox = resolve(opts.outbox);
    this.protectedFiles = opts.protectedFiles.map((f) => resolve(f));
    mkdirSync(this.outbox, { recursive: true });
    const st = lstatSync(this.outbox, { bigint: true });
    this.root = st.isDirectory() && !st.isSymbolicLink() ? { dev: st.dev, ino: st.ino, real: realpathSync.native(this.outbox) } : null;
    try {
      mkdirSync(this.dir, { recursive: true });
      const uploads = lstatSync(this.dir, { bigint: true });
      this.uploadRoot = uploads.isDirectory() && !uploads.isSymbolicLink()
        ? { dev: uploads.dev, ino: uploads.ino, real: realpathSync.native(this.dir) } : null;
    } catch { this.uploadRoot = null; }
  }

  /** A member's own outbox folder (created if missing); the envelope tells the member this path. */
  memberOutbox(memberId: string): string {
    if (!MEMBER_ID_RE.test(memberId)) throw new Error(`invalid member id ${memberId}`);
    const folder = join(this.outbox, memberId);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  /** Where a stored file's bytes are. Built from the row only (id and the name sanitized when it was stored). */
  pathOf(f: FileInfo): string {
    return join(this.dir, f.id, f.name);
  }

  /**
   * Streams `source` into a new file of the cluster and records it. More than MAX_FILE_BYTES fails (nothing is kept).
   */
  async save(clusterId: string, uploader: string, name: unknown, source: AsyncIterable<Uint8Array>): Promise<FileInfo> {
    const safe = sanitizeName(name);
    if (!this.store.getCluster(clusterId)) throw new Error(`unknown cluster ${clusterId}`);
    const id = randomUUID();
    const folder = join(this.dir, id);
    await mkdir(folder, { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      await pipeline(source, async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          size += chunk.byteLength;
          if (size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
          hash.update(chunk);
          if (head.length < 16) head = Buffer.concat([head, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]).subarray(0, 16);
          yield chunk;
        }
      }, createWriteStream(join(folder, safe), { flags: 'wx' }));
      const info: FileInfo = {
        id, clusterId, uploader, name: safe, mime: sniffImage(head) ?? 'application/octet-stream', size,
        sha256: hash.digest('hex'), createdAt: new Date().toISOString(),
      };
      this.store.insertFile(info);
      return info;
    } catch (e) {
      await rm(folder, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * Copies a file the member put in its own outbox folder, named by its bare file name (outboxName: checked as a
   * string before any filesystem call). The member comes from the authenticated caller, never from a parameter.
   * Refused: an outbox root that is not the one recorded at start-up (replaced, or a link), a member folder that is a
   * link or does not resolve directly under that root, a missing file, a link or other reparse point, anything that
   * is not a regular file directly in the member folder, a file with more than one link (hard links: only real
   * copies), more than MAX_FILE_BYTES, and orrery's own files under any name. The file is opened, then the open handle
   * must be the very file that was checked (volume and file number), so nothing swapped in between is read.
   * Nothing in the outbox is ever deleted or changed.
   */
  async importFromOutbox(clusterId: string, memberId: string, name: unknown): Promise<FileInfo> {
    const safe = outboxName(name);
    if (!MEMBER_ID_RE.test(memberId)) throw new Error(`invalid member id ${memberId}`);
    const folder = join(this.outbox, memberId);
    const rootNow = await lstat(this.outbox, { bigint: true }).catch(() => null);
    if (!this.root || !rootNow || rootNow.isSymbolicLink() || rootNow.dev !== this.root.dev || rootNow.ino !== this.root.ino) {
      throw new Error('the orrery outbox folder was replaced or is a link; restart the Hub to use it');
    }
    const folderNow = await lstat(folder, { bigint: true }).catch(() => null);
    if (!folderNow || folderNow.isSymbolicLink() || !folderNow.isDirectory()) throw new Error(`your orrery outbox ${folder} is missing or is a link`);
    const realFolder = await realpath(folder);
    if (relative(this.root.real, realFolder) !== memberId) throw new Error(`your orrery outbox ${folder} does not resolve under the outbox root`);
    const path = join(folder, safe);
    const checked = await lstat(path, { bigint: true }).catch(() => null);
    if (!checked) throw new Error(`attachment ${safe} is not a file in your orrery outbox ${folder}`);
    if (checked.isSymbolicLink()) throw new Error(`attachment ${safe} is a link; put a copy of the file itself in your orrery outbox`);
    if (!checked.isFile()) throw new Error(`attachment ${safe} is not a file in your orrery outbox ${folder}`);
    if (relative(realFolder, dirname(await realpath(path))) !== '') throw new Error(`attachment ${safe} does not resolve to a file directly in your orrery outbox`);
    if (checked.size > BigInt(MAX_FILE_BYTES)) throw new Error(`attachment ${safe} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const handle = await this.openStaged(path);
    try {
      const st = await handle.stat({ bigint: true });
      if (!st.isFile() || st.dev !== checked.dev || st.ino !== checked.ino) throw new Error(`attachment ${safe} changed while it was being checked`);
      for (const f of this.protectedFiles) {
        const p = await stat(f, { bigint: true }).catch(() => null);
        if (p && p.dev === st.dev && p.ino === st.ino && p.ino !== 0n) throw new Error(`attachment ${safe} is orrery's database or secret, which members may not attach`);
      }
      if (st.nlink !== 1n) throw new Error(`attachment ${safe} has more than one link (a hard link); put a real copy in your orrery outbox`);
      if (st.size > BigInt(MAX_FILE_BYTES)) throw new Error(`attachment ${safe} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      // shortcut: the same handle identity does not prove the content did not change during the copy; accepted, the
      // member writing its own outbox is the sender (docs/files.md).
      return await this.save(clusterId, memberId, safe, handle.createReadStream({ autoClose: false }));
    } finally {
      await handle.close();
    }
  }

  /** Opens a checked outbox file for reading; a seam for the test that swaps the file between check and open. */
  protected openStaged(path: string): Promise<FileHandle> {
    return open(path, 'r');
  }

  /**
   * Removes the folders of files whose rows a permanent cluster delete removed (Hub.purgeCluster). Only a valid file
   * id's real folder in the upload root pinned at startup. The only file eligible for unlink is the name from the
   * deleted database row; a linked or replaced root, a linked folder, or unexpected entries leave it untouched.
   * Returns the ids it could not remove; a folder already gone is fine.
   */
  async removeFolders(files: Pick<FileInfo, 'id' | 'name'>[]): Promise<string[]> {
    const failed: string[] = [];
    const root = this.uploadRoot;
    const checkedRoot = async () => {
      const current = await lstat(this.dir, { bigint: true });
      if (!root || !current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev
        || current.ino !== root.ino || await realpath(this.dir) !== root.real) throw new Error('upload root changed');
      return root.real;
    };
    for (const { id, name } of files) {
      try {
        if (!isFileId(id)) throw new Error('invalid file id');
        outboxName(name);
        const realRoot = await checkedRoot();
        const folder = join(this.dir, id);
        const st = await lstat(folder).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
        if (!st) continue;
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('not a real folder');
        if (relative(realRoot, await realpath(folder)) !== id) throw new Error('not directly in the files folder');
        const entries = await readdir(folder, { withFileTypes: true });
        if (entries.some((e) => !e.isFile() || e.name !== name)) throw new Error('holds unexpected entries');
        await checkedRoot();
        if (relative(realRoot, await realpath(folder)) !== id) throw new Error('file folder changed');
        if (entries.length) await unlink(join(folder, name));
        await rmdir(folder);
      } catch {
        failed.push(id);
      }
    }
    return failed;
  }

  /** Removes files no message carries (an attach whose message was then refused). Linked files are kept. */
  async discard(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (isFileId(id) && this.store.deleteUnlinkedFile(id)) await rm(join(this.dir, id), { recursive: true, force: true });
    }
  }
}
