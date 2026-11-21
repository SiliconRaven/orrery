// Operator entry point for the dedicated official plugin release. Hub clients verify the signed ZIP independently.
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unpackPlugin } from '../src/plugin-install-archive.ts';
import { verifyOfficialPackage, type OfficialKeys, type OfficialManifest } from '../src/official-plugin-package.ts';
import { RELEASE_KEYS } from '../src/official-plugin-updates.ts';
import { compareVersions } from '../src/update-check.ts';
import { packOfficialPlugin } from './pack-official-plugin.ts';

const REPOSITORY = 'SiliconRaven/orrery';
const TAG = 'official-plugins-v1';
const INDEX = 'index.json';
const NEXT_INDEX = 'index.next.json';
const PREVIOUS_INDEX = 'index.previous.json';
const INDEX_LIMIT = 1024 * 1024;
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type CatalogEntry = { id: string; version: string; tag: string; asset: string; sha256: string; hub?: OfficialManifest['hub'] };
type Catalog = { format: 1; releases: CatalogEntry[] };
type Publication = { entry: CatalogEntry; bytes: Buffer };
type Release = { id: number; tag_name: string; draft: boolean; prerelease: boolean; immutable?: boolean };
type Asset = { id: number; name: string; digest: string | null; state: string; size: number };

export interface OfficialReleaseChannel {
  find(): Promise<Release | undefined>;
  create(commit: string): Promise<Release>;
  assets(release: Release): Promise<Asset[]>;
  read(asset: Asset, maxBytes: number): Promise<Buffer>;
  upload(release: Release, name: string, bytes: Buffer): Promise<Asset>;
  rename(asset: Asset, name: string): Promise<void>;
  remove(asset: Asset): Promise<void>;
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function semver(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value || value.startsWith('v') || value.includes('+')) return false;
  try { compareVersions(value, value); return true; } catch { return false; }
}

function readCatalog(bytes: Buffer): Catalog {
  const data: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(data) || data.format !== 1 || !Array.isArray(data.releases)) throw new Error('The official plugin catalog is invalid.');
  const seen = new Set<string>();
  for (const item of data.releases) {
    if (!record(item) || typeof item.id !== 'string' || !PLUGIN_ID.test(item.id) || !semver(item.version)
      || typeof item.tag !== 'string' || !SEGMENT.test(item.tag) || typeof item.asset !== 'string' || !SEGMENT.test(item.asset)
      || !/\.zip$/i.test(item.asset) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)
      || (item.hub !== undefined && (!record(item.hub) || !Number.isSafeInteger(item.hub.api) || !semver(item.hub.minVersion)))) {
      throw new Error('The official plugin catalog has an invalid entry.');
    }
    const key = `${item.id}/${item.version}`;
    if (seen.has(key)) throw new Error('The official plugin catalog has a duplicate version.');
    seen.add(key);
  }
  return { format: 1, releases: data.releases };
}

function verifyAsset(asset: Asset, name: string, bytes: Buffer): void {
  if (asset.state !== 'uploaded' || asset.name !== name || asset.size !== bytes.length || asset.digest !== `sha256:${digest(bytes)}`) {
    throw new Error(`Release asset ${name} differs from the verified local bytes. Use a new plugin version for changed content.`);
  }
}

async function upload(channel: OfficialReleaseChannel, release: Release, name: string, bytes: Buffer): Promise<Asset> {
  const asset = await channel.upload(release, name, bytes);
  verifyAsset(asset, name, bytes);
  return asset;
}

async function openCatalog(channel: OfficialReleaseChannel, release: Release, allowEmpty: boolean) {
  if (release.tag_name !== TAG || release.draft || !release.prerelease || release.immutable) {
    throw new Error('The official plugin channel must be the dedicated mutable prerelease.');
  }
  const assets = new Map((await channel.assets(release)).map(asset => [asset.name, asset]));
  let current = assets.get(INDEX);
  const previous = assets.get(PREVIOUS_INDEX);
  if (current?.state === 'starter' && current.size === 0 && !current.digest) {
    await channel.remove(current);
    current = undefined;
  }
  if (!current && previous) {
    const bytes = await channel.read(previous, INDEX_LIMIT);
    verifyAsset(previous, PREVIOUS_INDEX, bytes);
    readCatalog(bytes);
    await channel.rename(previous, INDEX);
    current = { ...previous, name: INDEX };
    assets.delete(PREVIOUS_INDEX);
  }
  if (!current && allowEmpty && ![...assets.keys()].some(name => name.endsWith('.zip'))) {
    current = await upload(channel, release, INDEX, Buffer.from('{"format":1,"releases":[]}\n'));
  }
  if (!current) throw new Error('The official plugin catalog is missing. Initialize the channel or restore its previous catalog.');
  const bytes = await channel.read(current, INDEX_LIMIT);
  verifyAsset(current, INDEX, bytes);
  return { assets, current, catalog: readCatalog(bytes) };
}

export async function initializeOfficialChannel(channel: OfficialReleaseChannel, commit: string): Promise<void> {
  const release = await channel.find() ?? await channel.create(commit);
  await openCatalog(channel, release, true);
}

export async function buildOfficialPublication(root: string, id: string, version: string, signingKey: KeyObject, keys: OfficialKeys): Promise<Publication> {
  if (!PLUGIN_ID.test(id) || !semver(version) || ![...keys.values()].some(key => key.ids.includes(id))) {
    throw new Error('Choose an official plugin ID and its exact committed version.');
  }
  const directory = join(root, 'src', 'plugins', id);
  const metadata: Omit<OfficialManifest, 'files'> = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
  if (metadata.id !== id || metadata.version !== version) throw new Error('Plugin ID and version must match the committed release.json.');
  const bytes = packOfficialPlugin(join(directory, 'package'), metadata, signingKey);
  const temporary = mkdtempSync(join(tmpdir(), 'orrery-release-'));
  try {
    await unpackPlugin(bytes, temporary);
    const { manifest } = verifyOfficialPackage(temporary, keys, { id, version });
    const entry = { id, version, tag: TAG, asset: `${id}-${version}.zip`, sha256: digest(bytes), hub: manifest.hub };
    if (!SEGMENT.test(entry.asset)) throw new Error('The official plugin asset name is too long.');
    return { entry, bytes };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function publishOfficialPlugin(channel: OfficialReleaseChannel, { entry, bytes }: Publication): Promise<void> {
  const release = await channel.find();
  if (!release) throw new Error('Initialize the official plugin channel before publishing.');
  const { assets, current, catalog } = await openCatalog(channel, release, false);
  const existing = catalog.releases.find(item => item.id === entry.id && item.version === entry.version);
  if (existing && (existing.tag !== entry.tag || existing.asset !== entry.asset || existing.sha256 !== entry.sha256)) {
    throw new Error('The catalog already assigns different bytes to this plugin version. Use a new plugin version.');
  }
  const asset = assets.get(entry.asset);
  if (asset && asset.state !== 'starter') verifyAsset(asset, entry.asset, bytes);
  else {
    // GitHub can leave an empty starter asset after a failed upload. Never remove a published ZIP.
    if (asset) {
      if (asset.size || asset.digest) throw new Error('A starter asset already has content.');
      await channel.remove(asset);
    }
    await upload(channel, release, entry.asset, bytes);
  }
  if (existing) return;

  catalog.releases.push(entry);
  catalog.releases.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(b.version, a.version));
  const next = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
  if (next.length > INDEX_LIMIT) throw new Error('The official plugin catalog exceeds the Hub size limit.');
  for (const name of [NEXT_INDEX, PREVIOUS_INDEX]) {
    const old = assets.get(name);
    if (old) await channel.remove(old);
  }
  const staged = await upload(channel, release, NEXT_INDEX, next);
  // Ship the new catalog only after verifying both uploads. Keep the prior catalog available for an interrupted swap.
  await channel.rename(current, PREVIOUS_INDEX);
  try { await channel.rename(staged, INDEX); }
  catch (cause) {
    try { await channel.rename(current, INDEX); } catch { /* The next dispatch can recover from PREVIOUS_INDEX. */ }
    throw cause;
  }
}

/** REST transport is pinned to the public repository; the asset redirect receives no Actions token. */
function githubChannel(token: string): OfficialReleaseChannel {
  const repo = `https://api.github.com/repos/${REPOSITORY}`;
  const repoUpload = `https://uploads.github.com/repos/${REPOSITORY}`;
  const assetUrl = ({ id }: Asset) => `${repo}/releases/assets/${id}`;
  const json = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const request = (url: string, options: RequestInit = {}, accept = 'application/vnd.github+json') => fetch(url, {
    ...options, redirect: 'manual', signal: AbortSignal.timeout(45_000),
    headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2026-03-10', ...options.headers },
  });
  const checked = (response: Response, operation: string) => {
    if (!response.ok) throw new Error(`GitHub ${operation} failed (HTTP ${response.status}).`);
    return response;
  };
  return {
    async find() {
      const response = await request(`${repo}/releases/tags/${TAG}`);
      if (response.status === 404) return undefined;
      return checked(response, 'find release').json();
    },
    async create(commit) {
      const response = await request(`${repo}/releases`, { method: 'POST', ...json({
        tag_name: TAG, target_commitish: commit, name: 'Official plugin update channel',
        body: 'Signed Orrery plugin packages and their update catalog.', prerelease: true, make_latest: 'false',
      }) });
      return checked(response, 'create release').json();
    },
    async assets(release) {
      const result: Asset[] = [];
      for (let page = 1; ; page++) {
        const response = await request(`${repo}/releases/${release.id}/assets?per_page=100&page=${page}`);
        const entries: Asset[] = await checked(response, 'list assets').json();
        result.push(...entries);
        if (entries.length < 100) return result;
      }
    },
    async read(asset, maxBytes) {
      if (asset.size > maxBytes) throw new Error('The official plugin catalog exceeds the Hub size limit.');
      let response = await request(assetUrl(asset), {}, 'application/octet-stream');
      if (response.status === 302) {
        const target = new URL(response.headers.get('location') ?? '');
        if (target.protocol !== 'https:' || target.port || target.username || target.password || !ASSET_HOSTS.has(target.hostname)) {
          throw new Error('GitHub redirected the catalog outside the release asset hosts.');
        }
        await response.body?.cancel();
        response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(45_000) });
      }
      const body = checked(response, 'read catalog').body;
      if (!body) throw new Error('GitHub returned an empty catalog response.');
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > maxBytes) throw new Error('The official plugin catalog exceeds the Hub size limit.');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks);
    },
    async upload(release, name, bytes) {
      const response = await request(`${repoUpload}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'content-type': name.endsWith('.zip') ? 'application/zip' : 'application/json' }, body: new Uint8Array(bytes),
      });
      return checked(response, 'upload asset').json();
    },
    async rename(asset, name) {
      checked(await request(assetUrl(asset), { method: 'PATCH', ...json({ name }) }), 'rename catalog');
    },
    async remove(asset) {
      checked(await request(assetUrl(asset), { method: 'DELETE' }), 'remove asset');
    },
  };
}

async function main(): Promise<void> {
  const [operation, id, version, ...rest] = process.argv.slice(2);
  const { GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_SHA, GH_TOKEN } = process.env;
  if (GITHUB_EVENT_NAME !== 'workflow_dispatch' || GITHUB_REF !== 'refs/heads/main'
    || GITHUB_REPOSITORY?.toLowerCase() !== REPOSITORY.toLowerCase() || GITHUB_SERVER_URL !== 'https://github.com'
    || !GH_TOKEN || !GITHUB_SHA || !/^[a-f0-9]{40}$/.test(GITHUB_SHA)) {
    throw new Error('Run the manual release workflow from main in the public repository.');
  }
  const channel = githubChannel(GH_TOKEN);
  if (operation === 'initialize' && !id && !version && !rest.length) {
    await initializeOfficialChannel(channel, GITHUB_SHA);
    console.log('Official plugin channel is ready.');
    return;
  }
  if (operation !== 'publish' || !id || !version || rest.length) throw new Error('Usage: publish-official-plugin.ts initialize | publish <id> <version>');
  const pem = process.env.ORRERY_OFFICIAL_PLUGIN_SIGNING_KEY;
  if (!pem) throw new Error('Configure the ORRERY_OFFICIAL_PLUGIN_SIGNING_KEY Actions secret.');
  let key: KeyObject;
  try { key = createPrivateKey(pem); } catch { throw new Error('The signing secret is not a private key in PEM format.'); }
  const publication = await buildOfficialPublication(process.cwd(), id, version, key, RELEASE_KEYS);
  await publishOfficialPlugin(channel, publication);
  console.log(`Published ${publication.entry.asset} through ${TAG}.`);
}

if (import.meta.main) {
  try { await main(); }
  catch (cause) { console.error((cause as Error).message); process.exitCode = 1; }
}
