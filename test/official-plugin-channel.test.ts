import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildOfficialPublication, initializeOfficialChannel, publishOfficialPlugin, type OfficialReleaseChannel,
} from '../scripts/publish-official-plugin.ts';
import { tempDir } from './helpers.ts';

type Asset = Awaited<ReturnType<OfficialReleaseChannel['upload']>>;
type Release = Awaited<ReturnType<OfficialReleaseChannel['create']>>;
const sha256 = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const target = '1'.repeat(40);
const pluginVersion = '1.0.0';
const index = 'index.json';

class FakeChannel implements OfficialReleaseChannel {
  release?: Release;
  readonly byName = new Map<string, Asset & { bytes: Buffer }>();
  readonly activity: string[] = [];
  failPromote = false;
  failRestore = false;
  badUpload?: string;
  private nextId = 1;

  async find() { return this.release; }
  async create(commit: string) {
    this.activity.push('create:' + commit);
    return this.release = { id: 1, tag_name: 'official-plugins-v1', draft: false, prerelease: true };
  }
  async assets(_release: Release) { return [...this.byName.values()].map(({ bytes: _bytes, ...asset }) => asset); }
  async read(asset: Asset, maxBytes: number) {
    const stored = this.findAsset(asset);
    assert.ok(stored.bytes.length <= maxBytes);
    return stored.bytes;
  }
  async upload(_release: Release, name: string, bytes: Buffer) {
    this.activity.push('upload:' + name);
    assert.ok(!this.byName.has(name), 'An existing asset must never be overwritten by upload.');
    const asset = { id: this.nextId++, name, size: bytes.length, digest: sha256(bytes), state: 'uploaded', bytes };
    this.byName.set(name, asset);
    return name === this.badUpload ? { ...asset, digest: sha256(Buffer.alloc(0)) } : asset;
  }
  async rename(asset: Asset, name: string) {
    const stored = this.findAsset(asset);
    this.activity.push(`rename:${stored.name}:${name}`);
    assert.ok(!this.byName.has(name), 'Rename must never overwrite an existing asset.');
    if (name === index && ((stored.name === 'index.next.json' && this.failPromote)
      || (stored.name === 'index.previous.json' && this.failRestore))) throw new Error('Fake GitHub rename failed.');
    this.byName.delete(stored.name);
    this.byName.set(name, { ...stored, name });
  }
  async remove(asset: Asset) {
    const stored = this.findAsset(asset);
    this.activity.push('remove:' + stored.name);
    this.byName.delete(stored.name);
  }
  private findAsset(asset: Asset) {
    const result = [...this.byName.values()].find(item => item.id === asset.id);
    assert.ok(result);
    return result;
  }
  catalog() { return JSON.parse(this.byName.get(index)!.bytes.toString('utf8')); }
}

function fixture() {
  const root = tempDir();
  const plugin = join(root, 'src', 'plugins', 'starmap');
  mkdirSync(join(plugin, 'package', 'hub'), { recursive: true });
  const source = join(plugin, 'package', 'hub', 'index.mts');
  writeFileSync(source, 'export default () => ({ displayName: "Fixture" });');
  writeFileSync(join(plugin, 'release.json'), JSON.stringify({
    format: 1, id: 'starmap', version: pluginVersion, keyId: 'fixture', hub: { api: 1, minVersion: '0.10.0-beta.4' },
    requires: [], migrationVersion: 0, entry: 'hub/index.mts',
  }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = new Map([['fixture', { publicKey, ids: ['starmap'] }]]);
  const build = () => buildOfficialPublication(root, 'starmap', pluginVersion, privateKey, keys);
  return { root, keys, privateKey, source, build };
}

test('channel initialization needs no signer, publishes an empty catalog, and is repeatable', async () => {
  const channel = new FakeChannel();
  await initializeOfficialChannel(channel, target);
  assert.deepEqual(channel.catalog(), { format: 1, releases: [] });
  const expected = ['create:' + target, 'upload:index.json'];
  assert.deepEqual(channel.activity, expected);
  await initializeOfficialChannel(channel, target);
  assert.deepEqual(channel.activity, expected);
});

test('package builder verifies the committed version and the same trust root as the updater', async () => {
  const { root, keys, privateKey, build } = fixture();
  await assert.rejects(buildOfficialPublication(root, 'starmap', '2.0.0', privateKey, keys), /committed release.json/);
  await assert.rejects(
    buildOfficialPublication(root, 'starmap', pluginVersion, generateKeyPairSync('ed25519').privateKey, keys),
    /signature is invalid/,
  );
  const publication = await build();
  assert.equal(publication.entry.sha256, sha256(publication.bytes).slice('sha256:'.length));
  assert.equal(publication.entry.asset, 'starmap-1.0.0.zip');
  assert.deepEqual(publication.entry.hub, { api: 1, minVersion: '0.10.0-beta.4' });
});

test('only a verified upload advances the catalog and repeat publication preserves immutable bytes', async () => {
  const channel = new FakeChannel();
  const { source, build } = fixture();
  const publication = await build();
  await initializeOfficialChannel(channel, target);
  const name = publication.entry.asset;
  channel.badUpload = name;
  await assert.rejects(publishOfficialPlugin(channel, publication), /differs from the verified local bytes/);
  assert.deepEqual(channel.catalog().releases, []);
  channel.badUpload = undefined;
  await publishOfficialPlugin(channel, publication);
  assert.deepEqual(channel.catalog().releases, [publication.entry]);
  const expected = ['create:' + target, 'upload:index.json', 'upload:' + name, 'upload:index.next.json',
    'rename:index.json:index.previous.json', 'rename:index.next.json:index.json'];
  assert.deepEqual(channel.activity, expected);
  await publishOfficialPlugin(channel, await build());
  assert.deepEqual(channel.activity, expected);
  writeFileSync(source, 'export default () => ({ displayName: "Changed" });');
  await assert.rejects(publishOfficialPlugin(channel, await build()), /different bytes to this plugin version/);
  assert.deepEqual(channel.activity, expected);
  assert.deepEqual(channel.catalog().releases, [publication.entry]);
});

test('an interrupted catalog swap recovers the previous catalog and reuses the existing ZIP', async () => {
  const channel = new FakeChannel();
  const publication = await fixture().build();
  await initializeOfficialChannel(channel, target);
  channel.failPromote = channel.failRestore = true;
  await assert.rejects(publishOfficialPlugin(channel, publication), /Fake GitHub rename failed/);
  assert.equal(channel.byName.has(index), false);
  assert.ok(channel.byName.has('index.previous.json'));
  channel.failPromote = channel.failRestore = false;
  await publishOfficialPlugin(channel, publication);
  assert.deepEqual(channel.catalog().releases, [publication.entry]);
  assert.equal(channel.activity.filter(entry => entry === 'upload:' + publication.entry.asset).length, 1);
});
