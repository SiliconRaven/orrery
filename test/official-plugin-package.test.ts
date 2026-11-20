import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync, linkSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_MANIFEST, OFFICIAL_SIGNATURE, officialPackageFile, parseOfficialManifest, verifyOfficialPackage, type OfficialManifest,
} from '../src/official-plugin-package.ts';
import { unpackPlugin } from '../src/plugin-install-archive.ts';
import { packOfficialPlugin } from '../scripts/pack-official-plugin.ts';
import { tempDir } from './helpers.ts';

const metadata: Omit<OfficialManifest, 'files'> = { format: 1, id: 'starmap', version: '1.0.1', keyId: 'test-key',
  hub: { api: 1, minVersion: '0.10.0-beta.3' }, requires: [], migrationVersion: 0,
  entry: 'hub/index.mts', web: { entry: 'web/index.js', english: 'web/i18n/en.json' }, icon: 'web/icon.svg' };

function fixture() {
  const folder = tempDir();
  const payload = join(folder, 'payload');
  const staging = join(folder, 'staging');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = new Map([['test-key', { publicKey, ids: ['starmap'] }]]);
  const add = (path: string, bytes: string) => {
    const out = join(payload, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
  };
  add('hub/index.mts', 'import { readFileSync } from "node:fs";\nimport { fixture } from "./fixture.mjs";\nexport default () => ({fixture, readFileSync});\n');
  add('hub/fixture.mjs', 'export const fixture = true;\n');
  add('web/index.js', 'import { h } from "/plugin-host/v1.js";\nexport async function register() {\n  await import("./scene.js");\n  return new URL("./style.css", import.meta.url);\n}\n');
  add('web/scene.js', 'export const fromScene = true;\n');
  add('web/style.css', '.official { color: red; }');
  add('web/icon.svg', '<svg/>');
  add('web/i18n/en.json', '{"星图":"Starmap"}');
  mkdirSync(staging);
  return { folder, payload, staging, add, keys, privateKey };
}

test('official plugin: build a deterministic archive and verify the exact signed manifest and resource bytes', async () => {
  const { payload, privateKey, keys, staging } = fixture();
  const bytes = packOfficialPlugin(payload, metadata, privateKey);
  assert.deepEqual(bytes, packOfficialPlugin(payload, metadata, privateKey));
  const names = await unpackPlugin(bytes, staging);
  assert.ok(names.includes(OFFICIAL_SIGNATURE));
  const raw = readFileSync(join(staging, OFFICIAL_MANIFEST));
  const digest = createHash('sha256').update(raw).digest('hex');
  const pkg = verifyOfficialPackage(staging, keys, { id: 'starmap', version: '1.0.1', digest });
  assert.equal(pkg.manifest.entry, 'hub/index.mts');
  assert.equal(pkg.digest, digest);
  assert.equal(officialPackageFile(pkg, 'web/style.css').toString(), '.official { color: red; }');
  assert.throws(() => verifyOfficialPackage(staging, keys, { id: 'tasks' }), /does not match/);
  assert.throws(() => verifyOfficialPackage(staging, new Map()), /not trusted/);
  assert.throws(() => verifyOfficialPackage(staging, new Map([['test-key', { publicKey: keys.get('test-key')!.publicKey, ids: ['tasks'] }]])), /not trusted/);
  assert.throws(() => verifyOfficialPackage(staging, new Map([['test-key', { publicKey: generateKeyPairSync('ed25519').publicKey, ids: ['starmap'] }]])), /signature is invalid/);

  writeFileSync(join(staging, OFFICIAL_MANIFEST), Buffer.concat([raw, Buffer.from(' ')]));
  assert.throws(() => verifyOfficialPackage(staging, keys), /signature is invalid/);
  writeFileSync(join(staging, OFFICIAL_MANIFEST), raw);
  writeFileSync(join(staging, 'web', 'style.css'), 'changed');
  assert.throws(() => officialPackageFile(pkg, 'web/style.css'), /signed hash/);
  assert.throws(() => verifyOfficialPackage(staging, keys), /signed hash/);
  writeFileSync(join(staging, 'web', 'style.css'), '.official { color: red; }');
  writeFileSync(join(staging, 'web', 'unsigned.js'), 'throw new Error("unlisted");');
  assert.throws(() => verifyOfficialPackage(staging, keys), /unsigned file/);
  assert.throws(() => officialPackageFile(pkg, 'web/unsigned.js'), /unsigned file/);
  rmSync(join(staging, 'web', 'unsigned.js'));
  rmSync(join(staging, 'web', 'scene.js'));
  assert.throws(() => verifyOfficialPackage(staging, keys), /missing a signed file/);
});

test('official plugin: malformed manifests, reserved paths and case aliases fail before use', () => {
  const hash = 'sha256:' + '0'.repeat(64);
  const files = { [metadata.entry]: hash, 'web/index.js': hash, 'web/i18n/en.json': hash, 'web/icon.svg': hash };
  assert.equal(parseOfficialManifest({ ...metadata, files }).web?.english, 'web/i18n/en.json');
  for (const path of ['../escape', './web/file', 'web/CON.txt', 'web/NUL', 'web/COM¹.txt', 'web/with?query', 'web/a.']) {
    assert.throws(() => parseOfficialManifest({ ...metadata, files: { ...files, [path]: hash } }), /unsafe path/);
  }
  assert.throws(() => parseOfficialManifest({ ...metadata, files: { ...files, 'Web/a.js': hash } }), /case-colliding/);
  assert.throws(() => parseOfficialManifest({ ...metadata, files: { ...files, 'official-plugin.sig/leaf': hash } }), /invalid metadata/);
  assert.throws(() => parseOfficialManifest({ ...metadata, files: { ...files, 'web/index.js/sub/leaf': hash } }), /overlaps a directory/);
  for (const version of ['v1.0.1', '1.0.1\n', '1.0.1+suffix', '1.0.1-beta.00']) {
    assert.throws(() => parseOfficialManifest({ ...metadata, version, files }), /semantic version/);
  }
  assert.throws(() => parseOfficialManifest({ ...metadata, files, requires: [{ id: 'tasks', minVersion: '2.0.0', beforeVersion: '1.0.0' }] }), /range is empty/);
});

test('official plugin: a matching hash cannot authorize a linked resource or a linked parent', async () => {
  const { folder, payload, privateKey, keys, staging } = fixture();
  await unpackPlugin(packOfficialPlugin(payload, metadata, privateKey), staging);
  const pkg = verifyOfficialPackage(staging, keys);
  const destination = join(staging, 'web', 'style.css');
  rmSync(destination);
  linkSync(join(payload, 'web', 'style.css'), destination);
  assert.throws(() => officialPackageFile(pkg, 'web/style.css'), /is a link/);
  rmSync(destination);
  const alternative = join(folder, 'alternative');
  mkdirSync(alternative);
  writeFileSync(join(alternative, 'en.json'), '{"星图":"Starmap"}');
  rmSync(join(staging, 'web', 'i18n', 'en.json'));
  rmdirSync(join(staging, 'web', 'i18n'));
  symlinkSync(alternative, join(staging, 'web', 'i18n'), 'junction');
  assert.throws(() => officialPackageFile(pkg, 'web/i18n/en.json'), /unsafe parent directory/);
  assert.throws(() => verifyOfficialPackage(staging, keys), /link|unsafe directory/);
});

test('official plugin: packer restricts browser and Hub imports to the release payload and public interfaces', () => {
  const { payload, privateKey, add } = fixture();
  for (const source of [
    'import { api } from "../../src/web/public/app.js";',
    'import{api}from"../../src/web/public/app.js";',
    'export const lazy = import("https://example.invalid/module.js");',
    'export const lazy = import(dynamicPath);',
    'export const style = new URL("./missing.css", import.meta.url);',
    'import { fixture } from "../hub/fixture.mjs";',
  ]) {
    add('web/index.js', source);
    assert.throws(() => packOfficialPlugin(payload, metadata, privateKey), /unsupported import or asset path/);
  }
  add('web/index.js', 'export const ok = true;');
  add('hub/index.mts', 'import { api } from "../../src/main.ts";');
  assert.throws(() => packOfficialPlugin(payload, metadata, privateKey), /unsupported import or asset path/);
});

test('official plugin: pack command produces a verifiable ZIP and refuses to include the signing key', async () => {
  const { folder, payload, privateKey, keys, staging } = fixture();
  const script = fileURLToPath(new URL('../scripts/pack-official-plugin.ts', import.meta.url));
  const input = join(folder, 'metadata.json');
  const key = join(folder, 'fixture.pem');
  const output = join(folder, 'artifact.zip');
  writeFileSync(input, JSON.stringify(metadata));
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const run = (keyPath: string, outputPath: string) => spawnSync(process.execPath, [script, payload, input, keyPath, outputPath], { encoding: 'utf8' });
  const packed = run(key, output);
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(output);
  assert.equal(packed.stdout.trim(), 'SHA-256 ' + createHash('sha256').update(bytes).digest('hex'));
  await unpackPlugin(bytes, staging);
  assert.equal(verifyOfficialPackage(staging, keys).manifest.version, metadata.version);
  assert.equal(run(key, output).status, 1, 'output is not overwritten');
  const inside = join(payload, 'signer.pem');
  writeFileSync(inside, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  assert.match(run(inside, join(folder, 'refused.zip')).stderr, /must be outside the payload directory/);
});
