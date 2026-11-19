import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { PluginInstaller, PluginInstallError, type InstallGrants } from '../src/plugin-install.ts';
import { MAX_ARCHIVE_BYTES } from '../src/plugin-install-archive.ts';
import { readExternalPlugins } from '../src/core/external-plugin-config.ts';
import { tempDir } from './helpers.ts';

const manifest = { id: 'sample-plugin', version: '0.1.0-beta.1', apiVersion: 1, entry: 'main.mjs',
  permissions: ['messages.read', 'events.read', 'messages.send', 'tools.provide', 'ui.show'], events: ['task.*'], commands: [],
  tools: [{ name: 'echo', description: 'Echo a short message.', inputSchema: { type: 'object', properties: {} } }],
  ui: { positions: ['titlebar', 'workbench'] } };
const noGrants: InstallGrants = { permissions: [], events: [], clusterIds: [], writeClusterIds: [] };
const grants: InstallGrants = { permissions: [...manifest.permissions], events: ['task.submitted'], clusterIds: ['read-one'],
  writeClusterIds: ['write-one'], tools: ['echo'], ui: ['workbench'] };

/** A small stored ZIP for self-contained upload fixtures. */
function zip(entries: { name: string; body?: string }[]): Buffer {
  const files: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    files.push(header, name, body);
    central.push(directory, name);
    offset += header.length + name.length + body.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}

function packageZip(prefix = 'release/', extra: { name: string; body?: string }[] = []): Buffer {
  return zip([{ name: prefix + 'orrery-plugin.json', body: JSON.stringify(manifest) },
    { name: prefix + 'main.mjs', body: 'throw new Error("previews must not execute this file");' }, ...extra]);
}

function tar(entries: { name: string; body?: string; type?: 'File' | 'Directory' }[]): Buffer {
  const buffers: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = new Header({ path: entry.name, type: entry.type ?? 'File', size: body.length, mode: 0o644 });
    header.encode();
    buffers.push(header.block!, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  buffers.push(Buffer.alloc(1024));
  return Buffer.concat(buffers);
}

test('plugin installer: upload preview is data only, explicit grants register atomically and cancellation is confined', async () => {
  const home = tempDir();
  const installer = new PluginInstaller({ home, knownPluginIds: ['tasks'] });
  const preview = await installer.prepare({ bytes: packageZip(), filename: 'sample.zip' });
  assert.equal(preview.manifest.id, manifest.id);
  assert.equal(preview.manifestPath, 'orrery-plugin.json');
  assert.match(preview.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(existsSync(join(home, 'external-plugins.json')), false, 'a preview never registers runnable code');
  await assert.rejects(installer.confirm(preview.id, { ...grants, permissions: [...grants.permissions, 'clusters.read'] }), { code: 'INVALID_GRANTS' });
  assert.equal(existsSync(join(home, 'external-plugins.json')), false);
  const installed = await installer.confirm(preview.id, grants);
  assert.deepEqual(installed, { pluginId: manifest.id, version: manifest.version, restartRequired: true });
  const parsed = readExternalPlugins(home, ['tasks']);
  assert.deepEqual(parsed.failures, []);
  assert.deepEqual(parsed.installations[0].clusterIds, ['read-one']);
  assert.deepEqual(parsed.installations[0].writeClusterIds, ['write-one']);
  assert.deepEqual(parsed.installations[0].permissions, manifest.permissions);
  assert.deepEqual(parsed.installations[0].events, ['task.submitted']);
  assert.deepEqual(parsed.installations[0].tools, ['echo']);
  assert.deepEqual(parsed.installations[0].ui, ['workbench']);
  const second = await installer.prepare({ bytes: packageZip(), filename: 'second.zip' });
  await installer.cancel(second.id);
  assert.equal(existsSync(join(home, 'plugin-packages', '.staging', second.id)), false);
});

test('plugin installer: changed previews and built-in IDs cannot be confirmed', async () => {
  const home = tempDir();
  const installer = new PluginInstaller({ home, knownPluginIds: [] });
  const preview = await installer.prepare({ bytes: packageZip(), filename: 'sample.zip' });
  writeFileSync(join(home, 'plugin-packages', '.staging', preview.id, 'release', 'main.mjs'), 'changed');
  await assert.rejects(installer.confirm(preview.id, noGrants), { code: 'PACKAGE_CHANGED' });
  assert.equal(existsSync(join(home, 'external-plugins.json')), false);
  await installer.cancel(preview.id);
  await assert.rejects(new PluginInstaller({ home, knownPluginIds: [manifest.id] }).prepare({ bytes: packageZip(), filename: 'sample.zip' }), { code: 'PLUGIN_CONFLICT' });
});

test('plugin installer: a restricted package cannot replace a configured full-trust plugin', async () => {
  const home = tempDir();
  const directory = join(home, 'trusted-plugin');
  mkdirSync(directory);
  const manifestPath = join(directory, 'orrery-plugin.json');
  writeFileSync(manifestPath, JSON.stringify({ id: manifest.id, version: '1.0.0', hostApi: 1, hubEntry: 'index.mjs' }));
  writeFileSync(join(directory, 'index.mjs'), 'export {};');
  const registrations = JSON.stringify({ plugins: [{ manifest: manifestPath, trust: 'full' }] });
  const config = join(home, 'external-plugins.json');
  writeFileSync(config, registrations);
  const installer = new PluginInstaller({ home, knownPluginIds: [] });
  const preview = await installer.prepare({ bytes: packageZip(), filename: 'sample.zip' });
  await assert.rejects(installer.confirm(preview.id, noGrants), { code: 'PLUGIN_CONFLICT' });
  assert.equal(readFileSync(config, 'utf8'), registrations);
  await installer.cancel(preview.id);
});

test('plugin installer: archive size limit is reported before preview', async () => {
  const home = tempDir();
  const installer = new PluginInstaller({ home, knownPluginIds: [] });
  await assert.rejects(installer.prepare({ bytes: Buffer.alloc(MAX_ARCHIVE_BYTES + 1), filename: 'large.zip' }), { code: 'PACKAGE_TOO_LARGE' });
  assert.deepEqual(readdirSync(join(home, 'plugin-packages', '.staging')), []);
});

test('plugin installer: tar packages can be prepared, and packages with several manifests require a selection', async () => {
  const home = tempDir();
  const installer = new PluginInstaller({ home, knownPluginIds: [] });
  const files = [{ name: 'package/orrery-plugin.json', body: JSON.stringify(manifest) }, { name: 'package/main.mjs', body: 'export {}' }];
  const preview = await installer.prepare({ bytes: tar(files), filename: 'package.tgz' });
  await installer.cancel(preview.id);
  const dotted = await installer.prepare({ bytes: tar([{ name: './', type: 'Directory' },
    { name: './orrery-plugin.json', body: JSON.stringify(manifest) }, { name: './main.mjs', body: '' }]), filename: 'directory.tar' });
  await installer.cancel(dotted.id);
  const two = zip([{ name: 'repository/a/orrery-plugin.json', body: JSON.stringify(manifest) }, { name: 'repository/a/main.mjs', body: '' },
    { name: 'repository/b/orrery-plugin.json', body: JSON.stringify({ ...manifest, id: 'other-plugin' }) }, { name: 'repository/b/main.mjs', body: '' }]);
  await assert.rejects(installer.prepare({ bytes: two, filename: 'two.zip' }), (error) => {
    assert.ok(error instanceof PluginInstallError);
    assert.equal(error.code, 'MANIFEST_SELECTION_REQUIRED');
    assert.deepEqual(error.manifestPaths, ['a/orrery-plugin.json', 'b/orrery-plugin.json']);
    return true;
  });
  const chosen = await installer.prepare({ bytes: two, filename: 'two.zip', manifestPath: 'b/orrery-plugin.json' });
  assert.equal(chosen.manifest.id, 'other-plugin');
  await installer.cancel(chosen.id);
});

test('plugin installer: public npm metadata resolves an exact package and verifies its tarball before preview', async () => {
  const bytes = gzipSync(tar([{ name: 'package/orrery-plugin.json', body: JSON.stringify(manifest) }, { name: 'package/main.mjs', body: 'export {}' }]));
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/latest')) return Response.json({ version: '2.0.0', dist: { tarball: 'https://registry.npmjs.org/test/-/test-2.0.0.tgz', integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } });
    return new Response(Uint8Array.from(bytes));
  }) as typeof fetch;
  const installer = new PluginInstaller({ home: tempDir(), knownPluginIds: [], fetcher });
  const preview = await installer.prepare({ source: '@test/plugin' });
  assert.equal(preview.source.resolved, '@test/plugin@2.0.0');
  assert.equal(requests[0], 'https://registry.npmjs.org/%40test%2Fplugin/latest');
  await installer.cancel(preview.id);
  const broken = new PluginInstaller({ home: tempDir(), knownPluginIds: [], fetcher: (async () => Response.json({ version: '2.0.0', dist: { tarball: 'https://registry.npmjs.org/a.tgz', integrity: 'sha512-eA==' } })) as typeof fetch });
  await assert.rejects(broken.prepare({ source: 'test' }), { code: 'INTEGRITY_FAILED' });
});

test('plugin installer: a GitHub tree URL resolves refs with slashes and selects its plugin directory', async () => {
  const sha = 'a'.repeat(40);
  const bytes = zip([{ name: `repository-${sha}/examples/one/orrery-plugin.json`, body: JSON.stringify(manifest) }, { name: `repository-${sha}/examples/one/main.mjs`, body: '' },
    { name: `repository-${sha}/examples/two/orrery-plugin.json`, body: JSON.stringify({ ...manifest, id: 'other-plugin' }) }, { name: `repository-${sha}/examples/two/main.mjs`, body: '' }]);
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/git/matching-refs/heads/')) return Response.json([{ ref: 'refs/heads/feature/new', object: { sha } }]);
    if (url.includes('/git/matching-refs/tags/')) return Response.json([]);
    return new Response(Uint8Array.from(bytes));
  }) as typeof fetch;
  const installer = new PluginInstaller({ home: tempDir(), knownPluginIds: [], fetcher });
  const preview = await installer.prepare({ source: 'https://github.com/example/repository/tree/feature/new/examples/one' });
  assert.equal(preview.manifest.id, manifest.id);
  assert.equal(preview.manifestPath, 'examples/one/orrery-plugin.json');
  assert.equal(preview.source.version, sha);
  assert.equal(requested.at(-1), `https://codeload.github.com/example/repository/zip/${sha}`);
  await installer.cancel(preview.id);
});

test('plugin installer: npm only runs after confirmation with scripts disabled and isolated config', async () => {
  const home = tempDir();
  const npmCli = join(home, 'fake-npm-cli.mjs');
  const log = join(home, 'npm-calls.jsonl');
  writeFileSync(npmCli, `import { appendFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, leak:process.env.ORRERY_TEST_INSTALL_SECRET})+'\\n');
    writeFileSync('package-lock.json', JSON.stringify({packages:{'':{},'node_modules/example':{version:'1.0.0',resolved:'https://registry.npmjs.org/example/-/example-1.0.0.tgz'}}}));`);
  const packageJson = { name: 'sample-plugin', version: '1.0.0', dependencies: { example: '^1.0.0' }, scripts: { preinstall: 'node should-not-run.js' } };
  process.env.ORRERY_TEST_INSTALL_SECRET = 'must-not-reach-npm';
  const installer = new PluginInstaller({ home, knownPluginIds: [], npmCli });
  try {
    const preview = await installer.prepare({ bytes: packageZip('release/', [{ name: 'release/package.json', body: JSON.stringify(packageJson) }]), filename: 'dependency.zip' });
    assert.equal(existsSync(log), false, 'prepare only inspects data');
    await installer.confirm(preview.id, noGrants);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(call.args.includes('--ignore-scripts') && call.args.includes('--omit=dev'));
      assert.ok(call.args.includes('--workspaces=false') && call.args.includes('--bin-links=false'));
      assert.equal(call.leak, undefined);
      const user = call.args.find((arg: string) => arg.startsWith('--userconfig='));
      const global = call.args.find((arg: string) => arg.startsWith('--globalconfig='));
      assert.notEqual(user.slice(user.indexOf('=') + 1), global.slice(global.indexOf('=') + 1));
    }
  } finally { delete process.env.ORRERY_TEST_INSTALL_SECRET; }
});
