// Signed update artifacts are data until the Hub accepts the publisher and every declared byte.
import { createHash, verify, type KeyObject } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { archivePath, MAX_ARCHIVE_FILES, MAX_ARCHIVE_FILE_BYTES, MAX_EXPANDED_BYTES } from './plugin-install-archive.ts';
import { compareVersions } from './update-check.ts';

export const OFFICIAL_MANIFEST = 'official-plugin.json';
export const OFFICIAL_SIGNATURE = 'official-plugin.sig';
export const OFFICIAL_MANIFEST_LIMIT = 4 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}(?:\r?\n)?$/;

export interface OfficialDependency { id: string; minVersion: string; beforeVersion?: string }
export interface OfficialManifest {
  format: 1;
  id: string;
  version: string;
  keyId: string;
  hub: { api: number; minVersion: string };
  requires: OfficialDependency[];
  migrationVersion: number;
  entry: string;
  icon?: string;
  web?: { entry: string; english?: string };
  files: Record<string, string>;
}
export type OfficialKeys = ReadonlyMap<string, { publicKey: KeyObject; ids: readonly string[] }>;
export interface VerifiedOfficialPackage { directory: string; manifest: OfficialManifest; digest: string }

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function idOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || !ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function versionOf(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value || value.startsWith('v') || value.includes('+')) {
    throw new Error(`${label} must be a semantic version without a prefix or build metadata.`);
  }
  try { compareVersions(value, value); } catch { throw new Error(`${label} must be a semantic version without a prefix or build metadata.`); }
  return value;
}

function integerOf(value: unknown, min: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${label} must be an integer of at least ${min}.`);
  return value;
}

/** Use the archive's portable path rules, with a single spelling across manifests and URL paths. */
function filePath(value: unknown): string {
  if (typeof value !== 'string' || archivePath(value) !== value || /[<>"|?*]/.test(value)
    || value.split('/').some((part) => /^(?:conin\$|conout\$|(?:com|lpt)[¹²³])(?:\.|$)/i.test(part))) {
    throw new Error('The official plugin contains an unsafe path.');
  }
  return value;
}

function addPath(paths: Map<string, string>, path: string): void {
  let prefix = '';
  for (const part of path.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const key = prefix.normalize('NFC').toLowerCase();
    const existing = paths.get(key);
    if (existing !== undefined && existing !== prefix) throw new Error('The official plugin contains case-colliding paths.');
    paths.set(key, prefix);
  }
  if (paths.size > MAX_ARCHIVE_FILES) throw new Error('The official plugin contains too many files or directories.');
}

function listedFile(files: Record<string, string>, value: unknown, label: string, suffix: RegExp, web = false): string {
  const name = filePath(value);
  if (!Object.hasOwn(files, name) || !suffix.test(name) || (web && !name.startsWith('web/'))) throw new Error(`${label} must be a signed file with a supported extension and location.`);
  return name;
}

export function parseOfficialManifest(data: unknown): OfficialManifest {
  const input = record(data, 'Official manifest');
  if (input.format !== 1) throw new Error('Unsupported official plugin package format.');
  const id = idOf(input.id, 'Official plugin ID');
  const version = versionOf(input.version, 'Official plugin version');
  const keyId = idOf(input.keyId, 'Official signing key ID');
  const requiredHub = record(input.hub, 'Official plugin Hub requirement');
  const hub = { api: integerOf(requiredHub.api, 1, 'Official plugin API version'),
    minVersion: versionOf(requiredHub.minVersion, 'Minimum Hub version') };
  const migrationVersion = integerOf(input.migrationVersion, 0, 'Official plugin migration version');
  if (!Array.isArray(input.requires)) throw new Error('Official plugin dependencies must be an array.');
  const known = new Set([id]);
  const requires = input.requires.map((item): OfficialDependency => {
    const dependency = record(item, 'Official plugin dependency');
    const id = idOf(dependency.id, 'Official plugin dependency ID');
    if (known.has(id)) throw new Error('The official manifest contains a duplicate or self dependency.');
    known.add(id);
    const minVersion = versionOf(dependency.minVersion, 'Minimum dependency version');
    if (dependency.beforeVersion === undefined) return { id, minVersion };
    const beforeVersion = versionOf(dependency.beforeVersion, 'Dependency version limit');
    if (compareVersions(minVersion, beforeVersion) >= 0) throw new Error('The official plugin dependency range is empty.');
    return { id, minVersion, beforeVersion };
  });

  const paths = new Map<string, string>();
  for (const path of [OFFICIAL_MANIFEST, OFFICIAL_SIGNATURE]) addPath(paths, path);
  const files: Record<string, string> = Object.create(null);
  for (const [path, hash] of Object.entries(record(input.files, 'Official plugin file list'))) {
    filePath(path);
    if (typeof hash !== 'string' || hash.length !== 71 || !DIGEST.test(hash) || [OFFICIAL_MANIFEST, OFFICIAL_SIGNATURE].includes(path.split('/')[0])) {
      throw new Error('The official plugin file list contains invalid metadata.');
    }
    addPath(paths, path);
    files[path] = hash;
  }
  for (const path of Object.keys(files)) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      if (Object.hasOwn(files, path.slice(0, slash))) throw new Error('The official plugin file list overlaps a directory.');
    }
  }

  const entry = listedFile(files, input.entry, 'Hub entry', /\.(?:mjs|mts)$/);
  const icon = input.icon === undefined ? undefined : listedFile(files, input.icon, 'Plugin icon', /\.(?:svg|png|webp|ico)$/i);
  let web: OfficialManifest['web'];
  if (input.web !== undefined) {
    const browser = record(input.web, 'Official plugin web entry');
    const entry = listedFile(files, browser.entry, 'Browser entry', /\.(?:js|mjs)$/, true);
    const english = browser.english === undefined ? undefined : listedFile(files, browser.english, 'Browser translations', /\.json$/, true);
    web = { entry, ...(english === undefined ? {} : { english }) };
  }
  return { format: 1, id, version, keyId, hub, requires, migrationVersion, entry, ...(icon && { icon }), ...(web && { web }), files };
}

function directoryOf(directory: string): string {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The official plugin directory must be a real directory.');
  return realpathSync(directory);
}

function readPackageFile(directory: string, path: string, limit = MAX_ARCHIVE_FILE_BYTES): Buffer {
  const parts = filePath(path).split('/');
  let absolute = directory;
  for (const part of parts.slice(0, -1)) {
    absolute = join(absolute, part);
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The official plugin file has an unsafe parent directory.');
  }
  absolute = join(absolute, parts.at(-1)!);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) {
    throw new Error('The official plugin file is a link, is unsupported or exceeds the size limit.');
  }
  if (realpathSync(absolute) !== absolute) throw new Error('The official plugin file resolves outside its declared path.');
  const bytes = readFileSync(absolute);
  if (bytes.length > limit) throw new Error('The official plugin file exceeds the size limit.');
  return bytes;
}

/** Walk regular files exactly as the archive will see them. All entries, including directories, count toward the cap. */
export function* officialDirectoryFiles(directory: string): Iterable<[string, Buffer]> {
  const root = directoryOf(directory);
  const paths = new Map<string, string>();
  let bytes = 0;
  function* visit(directory: string, prefix: string): Generator<[string, Buffer]> {
    for (const name of readdirSync(directory).sort()) {
      const path = filePath(prefix ? `${prefix}/${name}` : name);
      addPath(paths, path);
      const fullPath = join(directory, name);
      const stat = lstatSync(fullPath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (realpathSync(fullPath) !== fullPath) throw new Error('The official plugin contains an unsafe directory.');
        yield* visit(fullPath, path);
      } else {
        const data = readPackageFile(root, path);
        bytes += data.length;
        if (bytes > MAX_EXPANDED_BYTES) throw new Error('The official plugin exceeds the expanded size limit.');
        yield [path, data];
      }
    }
  }
  yield* visit(root, '');
}

function verifyBytes(path: string, bytes: Buffer, hash: string | undefined): void {
  if (!hash) throw new Error(`The official plugin contains an unsigned file: ${path}.`);
  if (hash !== `sha256:${sha256(bytes)}`) throw new Error(`The official plugin file does not match its signed hash: ${path}.`);
}

/** Verify the exact resource bytes that will be returned, including every ancestor below the verified package root. */
export function officialPackageFile(pkg: VerifiedOfficialPackage, path: string): Buffer {
  if (!Object.hasOwn(pkg.manifest.files, path)) throw new Error(`The official plugin contains an unsigned file: ${path}.`);
  const root = directoryOf(pkg.directory);
  if (root !== pkg.directory) throw new Error('The official plugin directory has moved.');
  const bytes = readPackageFile(root, path);
  verifyBytes(path, bytes, pkg.manifest.files[path]);
  return bytes;
}

export function verifyOfficialPackage(directory: string, keys: OfficialKeys,
  expected: { id?: string; version?: string; digest?: string } = {}): VerifiedOfficialPackage {
  const root = directoryOf(directory);
  const bytes = readPackageFile(root, OFFICIAL_MANIFEST, OFFICIAL_MANIFEST_LIMIT);
  const payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const manifest = parseOfficialManifest(JSON.parse(payload));
  const digest = sha256(bytes);
  if ((expected.id !== undefined && manifest.id !== expected.id)
    || (expected.version !== undefined && manifest.version !== expected.version)
    || (expected.digest !== undefined && digest !== expected.digest)) {
    throw new Error('The official plugin does not match the requested ID, version or digest.');
  }

  const key = keys.get(manifest.keyId);
  if (key?.publicKey.asymmetricKeyType !== 'ed25519' || key.publicKey.type !== 'public' || !key.ids.includes(manifest.id)) {
    throw new Error('The official plugin signing key is unknown or is not trusted for this ID.');
  }
  const signatureInput = readPackageFile(root, OFFICIAL_SIGNATURE, 88);
  const signatureText = signatureInput.toString('utf8');
  const signature = Buffer.from(signatureText.trimEnd(), 'base64url');
  if (!SIGNATURE.test(signatureText) || signature.toString('base64url') !== signatureText.trimEnd()
    || !verify(null, bytes, key.publicKey, signature)) {
    throw new Error('The official plugin signature is invalid.');
  }
  const remaining = new Set(Object.keys(manifest.files));
  for (const [path, data] of officialDirectoryFiles(root)) {
    if (path === OFFICIAL_MANIFEST || path === OFFICIAL_SIGNATURE) {
      if (!data.equals(path === OFFICIAL_MANIFEST ? bytes : signatureInput)) throw new Error('Official plugin metadata changed during verification.');
      continue;
    }
    verifyBytes(path, data, Object.hasOwn(manifest.files, path) ? manifest.files[path] : undefined);
    remaining.delete(path);
  }
  if (remaining.size) throw new Error('The official plugin is missing a signed file.');
  return { directory: root, manifest, digest };
}
