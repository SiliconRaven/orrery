// Release tool: build a deterministic ZIP and sign the actual UTF-8 manifest bytes.
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isBuiltin } from 'node:module';
import { crc32, deflateRawSync } from 'node:zlib';
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, MAX_EXPANDED_BYTES } from '../src/plugin-install-archive.ts';
import {
  OFFICIAL_MANIFEST, OFFICIAL_MANIFEST_LIMIT, OFFICIAL_SIGNATURE, officialDirectoryFiles, parseOfficialManifest, type OfficialManifest,
} from '../src/official-plugin-package.ts';

const USAGE = 'npm run plugin:pack-official -- <payload-directory> <manifest-metadata.json> <private-key.pem> <output.zip>';

function zip(entries: ReadonlyMap<string, Buffer>): Buffer {
  const files: Buffer[] = [];
  const index: Buffer[] = [];
  let offset = 0;
  let indexSize = 0;
  for (const [path, bytes] of entries) {
    const name = Buffer.from(path, 'utf8');
    const body = deflateRawSync(bytes);
    const checksum = crc32(bytes);
    const entry = Buffer.alloc(30);
    entry.writeUInt32LE(0x04034b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(0x800, 6);  // UTF-8 name
    entry.writeUInt16LE(8, 8);     // deflate
    entry.writeUInt16LE(0x21, 12); // DOS date 1980-01-01
    entry.writeUInt32LE(checksum, 14);
    entry.writeUInt32LE(body.length, 18);
    entry.writeUInt32LE(bytes.length, 22);
    entry.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    entry.copy(central, 6, 4, 30);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    files.push(entry, name, body);
    index.push(central, name);
    offset += entry.length + name.length + body.length;
    indexSize += central.length + name.length;
    if (offset + indexSize + 22 > MAX_ARCHIVE_BYTES) throw new Error('The official ZIP exceeds the download size limit.');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(indexSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...index, end]);
}

// shortcut: this release-time import check covers the repository's literal ESM forms, not arbitrary evaluated code.
// If the official sources need richer computed imports, use a parser and test the expanded artifact graph.
const IMPORT = /\b(?:import|export)(?!\s+type\b)\s*(?:[\w$]+\s*,\s*)?(?:\{[^{}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s*from\s*(['"])([^'"]+)\1|\bimport\s*(['"])([^'"]+)\3|\b(?:import|require)\s*\(([^)]*)\)|\bnew\s+URL\s*\(([^,()]+),\s*import\.meta\.url\s*\)/g;

function checkImports(path: string, source: string, payload: ReadonlyMap<string, Buffer>): void {
  const web = path.startsWith('web/');
  for (const match of source.matchAll(IMPORT)) {
    const expression = (match[5] ?? match[6])?.trim();
    const specifier = match[2] ?? match[4] ?? (/^(['"])([^'"]+)\1$/.exec(expression ?? '')?.[2]);
    if (specifier && !match[6]) {
      if (web && specifier === '/plugin-host/v1.js') continue;
      if (!web && specifier.startsWith('node:') && isBuiltin(specifier)) continue;
    }
    if (specifier && /^\.\.?\//.test(specifier) && !/[%#?\\]/.test(specifier)) {
      const local = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (payload.has(local) && local.startsWith('web/') === web) continue;
    }
    throw new Error(`The official plugin contains an unsupported import or asset path in ${path}.`);
  }
}

export function packOfficialPlugin(directory: string, metadata: Omit<OfficialManifest, 'files'>, privateKey: KeyObject): Buffer {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The signing key must be an Ed25519 private key.');
  }
  const payload = new Map(officialDirectoryFiles(directory));
  for (const path of payload.keys()) {
    if ([OFFICIAL_MANIFEST, OFFICIAL_SIGNATURE].includes(path.split('/')[0].toLowerCase())) {
      throw new Error('The payload must leave room for the generated manifest and signature.');
    }
  }
  const files = Object.fromEntries([...payload].map(([path, bytes]) => [path, `sha256:${createHash('sha256').update(bytes).digest('hex')}`]));
  const manifest = parseOfficialManifest({ ...metadata, files });
  for (const [path, bytes] of payload) {
    if (/\.(?:js|mjs|mts|ts)$/.test(path)) checkImports(path, bytes.toString('utf8'), payload);
  }
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const signature = Buffer.from(sign(null, raw, privateKey).toString('base64url') + '\n');
  payload.set(OFFICIAL_MANIFEST, raw);
  payload.set(OFFICIAL_SIGNATURE, signature);
  const paths = new Set<string>();
  let size = 0;
  for (const [path, bytes] of payload) {
    size += bytes.length;
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
  }
  if (raw.length > OFFICIAL_MANIFEST_LIMIT || size > MAX_EXPANDED_BYTES || paths.size > MAX_ARCHIVE_FILES) {
    throw new Error('The manifest or expanded plugin package exceeds the size limit.');
  }
  return zip(payload);
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    console.error('Usage: ' + USAGE);
    process.exitCode = 2;
  } else {
    try {
      const [directory, metadataPath, keyPath, outputPath] = args;
      const root = realpathSync(directory);
      const metadata = realpathSync(metadataPath);
      const key = realpathSync(keyPath);
      const output = join(realpathSync(dirname(resolve(outputPath))), basename(outputPath));
      if ([metadata, key, output].some((path) => within(root, path))) {
        throw new Error('The metadata, signing key and ZIP output must be outside the payload directory.');
      }
      const bytes = packOfficialPlugin(root, JSON.parse(readFileSync(metadata, 'utf8')), createPrivateKey(readFileSync(key)));
      writeFileSync(output, bytes, { flag: 'wx' });
      console.log(`SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`);
    } catch (error) {
      console.error('Official plugin packaging failed: ' + (error as Error).message);
      process.exitCode = 1;
    }
  }
}
