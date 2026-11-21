import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tempDir } from './helpers.ts';

const { createDesktopUpdater } = await import(new URL('../desktop/lib/desktop-update.mjs', import.meta.url).href);
const currentVersion = '0.10.0-beta.4';
const target = '0.10.0-beta.5';
const metadata = 'https://api.github.com/repos/SiliconRaven/orrery/releases?per_page=100';
const artifact = (version: string) => `Orrery-${version}-Setup-x64.exe`;
const assetUrl = (version: string, suffix = '') => `https://github.com/SiliconRaven/orrery/releases/download/v${version}/${artifact(version)}${suffix}`;
const sample = Buffer.from('inert test installer payload');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const checksum = (version: string) => `${sha256(sample)}  ${artifact(version)}\n`;
const installer = (version: string, overrides: object = {}) => ({
  name: artifact(version), state: 'uploaded', size: sample.length, digest: `sha256:${sha256(sample)}`, ...overrides,
});
const checksumAsset = (version: string) => ({
  name: artifact(version) + '.sha256', state: 'uploaded', size: Buffer.byteLength(checksum(version)),
});
const release = (version: string, assets: object[] = [installer(version)], overrides: object = {}) => ({
  tag_name: 'v' + version, draft: false, prerelease: version.includes('-'), assets, ...overrides,
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
type Options = {
  currentVersion?: string;
  openInstaller?: (path: string) => unknown;
  onChange?: (state: { status: string; percent: number | null }) => void;
};

function fixture(handler: Handler, opts: Options = {}) {
  const tempRoot = tempDir();
  const requests: { url: string; redirect?: string }[] = [];
  const launches: string[] = [];
  const updater = createDesktopUpdater({
    currentVersion, tempRoot,
    fetchImpl(url: string, init?: RequestInit) {
      requests.push({ url, redirect: init?.redirect });
      return handler(url, init);
    },
    openInstaller(path: string) {
      launches.push(path);
      return opts.openInstaller?.(path) ?? true;
    },
    ...('currentVersion' in opts ? { currentVersion: opts.currentVersion } : {}),
    ...(opts.onChange ? { onChange: opts.onChange } : {}),
  });
  return { updater, requests, launches, tempRoot };
}

test('desktop updater selects a newer exact published x64 installer and honors stable versus beta', async () => {
  const data = [
    release('8.0.0', [installer('8.0.0')], { draft: true }),
    release('7.0.0', [installer('7.0.0')], { yanked: true }),
    release('6.0.0', [installer('6.0.0')], { published_at: null }),
    release('5.0.0', [installer('5.0.0', { size: 513 * 1024 * 1024 })]),
    release('4.0.0', [installer('4.0.0', { state: 'new' })]),
    release('3.0.0', [installer('4.0.0')]),
    release('2.0.0', undefined, { tag_name: '2.0.0' }),
    release('2.0.0-beta.00'),
    release('2.0.0-beta.9'),
    release('2.0.0-beta.10'),
    release('1.1.0', [installer('1.1.0', { browser_download_url: 'https://example.invalid/not-used' })]),
  ];
  const stable = fixture(url => {
    assert.equal(url, metadata);
    return Response.json(data);
  }, { currentVersion: '1.0.0' });
  assert.equal((await stable.updater.check()).latestVersion, '1.1.0');
  assert.equal(stable.updater.snapshot().status, 'available');
  const beta = fixture(() => Response.json(data), { currentVersion: '2.0.0-beta.4' });
  assert.equal((await beta.updater.check()).latestVersion, '2.0.0-beta.10');
  const current = fixture(() => Response.json(data), { currentVersion: '2.0.0' });
  assert.equal((await current.updater.check()).status, 'current');
  assert.equal((await current.updater.download()).status, 'current');
  assert.equal(await current.updater.install(), false);
  assert.equal(current.requests.length, 1);
  assert.throws(() => fixture(() => Response.json(data), { currentVersion: '../version' }), /Invalid current desktop version/);
  const empty = fixture(() => Response.json([release(target, [])]));
  assert.equal((await empty.updater.check()).status, 'no-release');
  assert.equal(await empty.updater.install(), false);
  await Promise.all([stable.updater.dispose(), beta.updater.dispose(), current.updater.dispose(), empty.updater.dispose()]);
});

test('desktop updater downloads from the fixed release URL and launches only after explicit install', async () => {
  const statuses: string[] = [];
  const percentages: (number | null)[] = [];
  const { updater, requests, launches } = fixture(url => {
    if (url === metadata) return Response.json([
      release(target, [installer(target, { browser_download_url: 'https://example.invalid/no' })]),
    ]);
    assert.equal(url, assetUrl(target));
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sample.subarray(0, 6));
        controller.enqueue(sample.subarray(6));
        controller.close();
      },
    }));
  }, {
    onChange(state) { statuses.push(state.status); percentages.push(state.percent); },
    async openInstaller(path) {
      assert.equal(basename(path), artifact(target));
      assert.deepEqual(await readFile(path), sample);
      return '';
    },
  });

  assert.deepEqual(updater.snapshot(), { currentVersion, status: 'idle', latestVersion: null, percent: null, error: null });
  assert.equal(await updater.install(), false);
  const firstCheck = updater.check();
  assert.equal(firstCheck, updater.check());
  assert.equal((await firstCheck).status, 'available');
  const download = updater.download();
  assert.equal(download, updater.download());
  assert.equal(await updater.install(), false);
  assert.equal((await download).status, 'ready');
  assert.deepEqual(launches, []);
  assert.deepEqual(requests, [
    { url: metadata, redirect: 'error' },
    { url: assetUrl(target), redirect: 'manual' },
  ]);
  assert.ok(statuses.includes('checking') && statuses.includes('downloading') && statuses.includes('ready'));
  assert.ok(percentages.some(percent => percent !== null && percent > 0 && percent < 100));
  assert.equal(updater.snapshot().percent, 100);
  assert.equal(await updater.install(), true);
  assert.equal(updater.snapshot().status, 'installing');
  assert.equal(await updater.install(), false, 'the same updater never opens the installer twice');
  assert.equal(launches.length, 1);
  await updater.dispose();
  assert.deepEqual(await readFile(launches[0]), sample, 'the installer still owns its file');
});

test('desktop updater accepts the workflow checksum and official CDN redirects, and refuses another filename', async () => {
  const cdn = 'https://release-assets.githubusercontent.com/download/fixture?sig=stub';
  let line = '0'.repeat(64) + '  wrong.exe\n';
  const { updater, requests, launches, tempRoot } = fixture(url => {
    if (url === metadata) return Response.json([release(target, [installer(target, { digest: null }), checksumAsset(target)])]);
    if (url === assetUrl(target, '.sha256')) return new Response(line);
    if (url === assetUrl(target)) return new Response(null, { status: 302, headers: { location: cdn } });
    assert.equal(url, cdn);
    return new Response(sample);
  });
  await updater.check();
  assert.equal((await updater.download()).error, 'checksum-unavailable');
  assert.equal(requests.length, 2, 'a malformed checksum prevents executable download');
  assert.deepEqual(await readdir(tempRoot), []);
  line = checksum(target);
  assert.equal((await updater.download()).status, 'ready');
  assert.equal(requests.at(-1)?.url, cdn);
  assert.deepEqual(launches, []);
  await updater.dispose();
  assert.deepEqual(await readdir(tempRoot), [], 'verified but unused installers are cleaned on dispose');
});

test('desktop updater rejects unsafe redirects and stops following a redirect loop', async () => {
  const good = 'https://objects.githubusercontent.com/releases/fixture';
  const withUserInfo = new URL('/installer', good);
  withUserInfo.username = 'name';
  for (const location of [
    'https://example.invalid/installer',
    'http://objects.githubusercontent.com/installer',
    'https://objects.githubusercontent.com:443/installer',
    withUserInfo.href,
    'https://objects.githubusercontent.com.example.invalid/installer',
    good,
  ]) {
    const { updater, requests, tempRoot } = fixture(url => {
      if (url === metadata) return Response.json([release(target)]);
      return new Response(null, { status: 302, headers: { location } });
    });
    await updater.check();
    assert.equal((await updater.download()).error, 'unsafe-redirect');
    assert.equal(requests.length, location === good ? 5 : 2);
    assert.equal(await updater.install(), false);
    assert.deepEqual(await readdir(tempRoot), []);
    await updater.dispose();
  }
});

test('desktop updater keeps a candidate retryable after download or launch errors', async () => {
  let body = Buffer.alloc(sample.length, 0);
  let open = 'controlled failure';
  const { updater, launches, tempRoot } = fixture(url => {
    if (url === metadata) return Response.json([release(target)]);
    return new Response(body);
  }, { openInstaller() { return open; } });

  await updater.check();
  assert.equal((await updater.download()).error, 'checksum-mismatch');
  assert.deepEqual(await readdir(tempRoot), []);
  body = sample.subarray(1);
  assert.equal((await updater.download()).error, 'size-mismatch');
  assert.deepEqual(await readdir(tempRoot), []);
  body = Buffer.concat([sample, Buffer.of(0)]);
  assert.equal((await updater.download()).error, 'size-mismatch');
  body = sample;
  assert.equal((await updater.download()).status, 'ready');
  const [pending] = await readdir(tempRoot);
  await writeFile(join(tempRoot, pending, artifact(target)), Buffer.alloc(sample.length, 0));
  assert.equal(await updater.install(), false, 'a changed file is detected before use');
  assert.equal(updater.snapshot().error, 'checksum-mismatch');
  assert.deepEqual(launches, []);
  assert.deepEqual(await readdir(tempRoot), []);

  await updater.download();
  assert.equal(await updater.install(), false);
  assert.equal(updater.snapshot().error, 'install-failed');
  assert.equal(updater.snapshot().status, 'ready', 'the settings page keeps the install action available');
  open = '';
  assert.equal(await updater.install(), true, 'a launch error preserves the verified file for retry');
  assert.equal(launches[0], launches[1]);
  await updater.dispose();
});

test('desktop updater cancels an in-flight download and removes only its unused file', async () => {
  const received = Promise.withResolvers<void>();
  const { updater, launches, tempRoot } = fixture(url => {
    if (url === metadata) return Response.json([release(target)]);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(sample.subarray(0, 5)); },
    }));
  }, {
    onChange(state) {
      if (state.status === 'downloading' && state.percent) received.resolve();
    },
  });
  await updater.check();
  const downloading = updater.download();
  await received.promise;
  const unrelated = join(tempRoot, 'unrelated.txt');
  await writeFile(unrelated, 'keep');
  await updater.dispose();
  await downloading;
  assert.deepEqual(await readdir(tempRoot), ['unrelated.txt']);
  assert.deepEqual(launches, []);
  assert.equal(updater.snapshot().status, 'idle');
});
test('desktop packaging uses the orrery display name and preserves the existing upgrade identity', async () => {
  const pkg = JSON.parse(await readFile(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.productName, 'orrery');
  assert.equal(pkg.build.productName, 'orrery');
  assert.equal(pkg.build.nsis.shortcutName, 'orrery');
  assert.equal(pkg.build.appId, 'dev.orrery.beta');
  assert.equal(pkg.build.win.executableName, 'Orrery Beta');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
});
