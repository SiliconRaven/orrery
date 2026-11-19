// Archive contents are inspected as data before any regular files are written.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { Parser } from 'tar';
import { fromBuffer, type ZipFile } from 'yauzl';

export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 5000;
export const MAX_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024;

type PackedFile = { path: string; chunks: Buffer[]; size: number };
const unzipTar = promisify(gunzip);

/** Archive paths are portable relative paths, including on a Windows installation. */
export function archivePath(value: string): string {
  const relative = value.replace(/^(?:\.\/)+/, '');
  const name = relative.endsWith('/') ? relative.slice(0, -1) : relative;
  const parts = name.split('/');
  if (!name || name.length > 4096 || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(name)
    || parts.length > 40 || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('The archive contains an unsafe path.');
  }
  return parts.join('/');
}

class ArchiveContents {
  readonly files: PackedFile[] = [];
  readonly directories: string[] = [];
  private readonly names = new Set<string>();
  private readonly spellings = new Map<string, string>();
  private bytes = 0;
  private entries = 0;

  add(name: string, directory: boolean, declaredSize: number): PackedFile | null {
    if (++this.entries > MAX_ARCHIVE_FILES) throw new Error('The archive contains too many entries.');
    if (directory && declaredSize !== 0) throw new Error('An archive directory must not carry file contents.');
    if (directory && /^(?:\.\/)*\.?\/?$/.test(name)) return null;
    const path = archivePath(name);
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/');
      const key = prefix.normalize('NFC').toLowerCase();
      const previous = this.spellings.get(key);
      if (previous !== undefined && previous !== prefix) throw new Error('The archive contains case-colliding paths.');
      this.spellings.set(key, prefix);
    }
    if (this.spellings.size > MAX_ARCHIVE_FILES) throw new Error('The archive contains too many files and directories.');
    const key = path.normalize('NFC').toLowerCase();
    if (this.names.has(key)) throw new Error('The archive contains duplicate or case-colliding paths.');
    this.names.add(key);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error('An archive entry exceeds the size limit.');
    }
    if (directory) { this.directories.push(path); return null; }
    const file = { path, chunks: [] as Buffer[], size: 0 };
    this.files.push(file);
    return file;
  }

  append(file: PackedFile, chunk: Buffer): void {
    this.bytes += chunk.length;
    file.size += chunk.length;
    if (this.bytes > MAX_EXPANDED_BYTES || file.size > MAX_ARCHIVE_FILE_BYTES) {
      throw new Error('The expanded archive exceeds the size limit.');
    }
    file.chunks.push(chunk);
  }
}

async function readZip(bytes: Buffer): Promise<ArchiveContents> {
  const contents = new ArchiveContents();
  await new Promise<void>((done, reject) => {
    let opened: ZipFile | undefined;
    const fail = (error: Error) => { opened?.close(); reject(error); };
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return fail(error ?? new Error('Could not read the ZIP archive.'));
      opened = zip;
      zip.on('error', fail);
      zip.on('end', done);
      zip.on('entry', (entry) => {
        try {
          const path = new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          const directory = path.endsWith('/');
          if (entry.isEncrypted() || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)
            || (mode === 0x4000 && !directory)) throw new Error('The archive contains a link or unsupported entry.');
          const file = contents.add(path, directory, entry.uncompressedSize);
          if (!file) { zip.readEntry(); return; }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) return fail(error ?? new Error('Could not read a ZIP entry.'));
            stream.on('error', fail);
            stream.on('data', (chunk: Buffer) => {
              try { contents.append(file, chunk); } catch (error) { stream.destroy(); fail(error as Error); }
            });
            stream.on('end', () => zip.readEntry());
          });
        } catch (error) { fail(error as Error); }
      });
      zip.readEntry();
    });
  });
  return contents;
}

async function readTar(bytes: Buffer): Promise<ArchiveContents> {
  const contents = new ArchiveContents();
  // Bound metadata and padding too, before the TAR parser consumes any records.
  const expanded = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await unzipTar(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }) : bytes;
  await new Promise<void>((done, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024, maxDecompressionRatio: 1000 });
    const fail = (error: Error) => { reject(error); parser.abort(error); };
    parser.on('error', reject);
    parser.on('end', done);
    parser.on('entry', (entry) => {
      try {
        if (!['File', 'OldFile', 'Directory'].includes(entry.type)) throw new Error('The archive contains a link or unsupported entry.');
        const file = contents.add(entry.path, entry.type === 'Directory', entry.size);
        entry.on('error', reject);
        entry.on('data', (chunk: Buffer) => {
          if (!file) return;
          try { contents.append(file, chunk); } catch (error) { fail(error as Error); }
        });
        entry.resume();
      } catch (error) { fail(error as Error); }
    });
    parser.end(expanded);
  });
  return contents;
}

/** The caller creates a new, empty, owned directory and removes it if preparation fails. */
export async function unpackPlugin(bytes: Buffer, directory: string): Promise<string[]> {
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('The plugin package exceeds the download size limit.');
  const { files, directories } = bytes[0] === 0x50 && bytes[1] === 0x4b ? await readZip(bytes) : await readTar(bytes);
  if (!files.length) throw new Error('The plugin archive contains no files.');
  for (const name of directories) await mkdir(resolve(directory, name), { recursive: true });
  for (const file of files) {
    const path = resolve(directory, file.path);
    if (!path.startsWith(resolve(directory) + sep)) throw new Error('The archive path escapes its installation directory.');
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, Buffer.concat(file.chunks), { flag: 'wx', mode: 0o600 });
  }
  return files.map((file) => file.path);
}
