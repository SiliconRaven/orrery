import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { compareVersions, UpdateChecker } from '../src/update-check.ts';

function fixture(t: TestContext, currentVersion: string, fetcher: typeof fetch, timeoutMs?: number) {
  const home = mkdtempSync(join(tmpdir(), 'orrery-update-check-'));
  const checker = new UpdateChecker({ home, currentVersion, fetcher, timeoutMs });
  t.after(() => { checker.close(); rmSync(home, { recursive: true, force: true }); });
  return { checker, home };
}
const release = (tag_name: string, prerelease = true, draft = false) => ({ tag_name, prerelease, draft });
const response = (releases: unknown, etag = '"fixture-v1"') => Response.json(releases, { headers: { etag } });

test('SemVer gives numeric beta precedence and stable priority, ignoring build metadata', () => {
  assert.ok(compareVersions('0.10.0-beta.11', '0.10.0-beta.2') > 0);
  assert.ok(compareVersions('0.10.0', '0.10.0-beta.99') > 0);
  assert.ok(compareVersions('1.10.0', '1.9.99') > 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0-beta') > 0);
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
  assert.equal(compareVersions('v1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.throws(() => compareVersions('1.0.0-beta.01', '1.0.0'), /Invalid/);
});

test('Beta picks the highest release, caches ETag and never trusts a provider download URL', async (t) => {
  let calls = 0;
  const { checker, home } = fixture(t, '0.10.0-beta.1', async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/SiliconRaven/orrery/releases?per_page=100');
    const headers = new Headers(options?.headers);
    assert.equal(headers.has('authorization'), false);
    if (calls === 2) {
      assert.equal(headers.get('if-none-match'), '"fixture-v1"');
      return new Response(null, { status: 304 });
    }
    return response([release('v0.10.0-beta.2'), release('v0.10.0-beta.11'), release('v9.0.0', false, true),
      release('not-a-version'), { ...release('v0.10.0-beta.3'), html_url: 'https://example.invalid' }]);
  });
  assert.equal(calls, 0);
  const state = await checker.check();
  assert.equal(state.status, 'available');
  assert.equal(state.channel, 'beta');
  assert.equal(state.latestVersion, '0.10.0-beta.11');
  assert.equal(state.releaseUrl, 'https://github.com/SiliconRaven/orrery/releases/tag/v0.10.0-beta.11');
  assert.equal((await checker.check()).status, 'available');
  assert.equal(calls, 2);
  const cached = new UpdateChecker({ home, currentVersion: '0.10.0-beta.1', fetcher: async () => { throw new Error('Unexpected network request.'); } });
  t.after(() => cached.close());
  cached.start();
  assert.equal(cached.snapshot().status, 'available');
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'updates.json'), 'utf8')).etag, '"fixture-v1"');
});

test('stable ignores previews; empty published channel is distinct from current', async (t) => {
  const { checker } = fixture(t, '1.0.0', async () => response([release('v2.0.0-beta.1'), release('v1.0.0', false)]));
  assert.equal((await checker.check()).status, 'current');
  const { checker: previewsOnly } = fixture(t, '1.0.0', async () => response([release('v2.0.0-beta.1')]));
  assert.equal((await previewsOnly.check()).status, 'no-release');
});

test('manual/background requests coalesce and a changed automatic setting survives an in-flight response', async (t) => {
  let deliver!: (response: Response) => void;
  let calls = 0;
  const result = new Promise<Response>((done) => { deliver = done; });
  const { checker, home } = fixture(t, '1.0.0', async () => { calls++; return result; });
  checker.start();
  const first = checker.check();
  assert.equal(checker.check(), first);
  checker.setAutoCheck(false);
  deliver(response([release('v1.0.1', false)]));
  assert.equal((await first).autoCheck, false);
  assert.equal(calls, 1);
  const disabled = new UpdateChecker({ home, currentVersion: '1.0.0', fetcher: async () => { calls++; return response([]); } });
  t.after(() => disabled.close());
  disabled.start();
  assert.equal(disabled.snapshot().autoCheck, false);
  assert.equal(calls, 1);
  assert.throws(() => disabled.setAutoCheck('false'), /boolean/);
});

test('404 and invalid JSON are errors, retain the last successful release, and never claim current', async (t) => {
  const replies = [response([release('v1.0.1', false)]), new Response('', { status: 404 }), new Response('not-json')];
  const { checker } = fixture(t, '1.0.0', async () => replies.shift()!);
  await checker.check();
  const unavailable = await checker.check();
  assert.equal(unavailable.status, 'error');
  assert.equal(unavailable.error, 'not-found');
  assert.equal(unavailable.latestVersion, '1.0.1');
  assert.equal((await checker.check()).error, 'invalid-response');
});

test('timeout bounds an uncooperative provider; closing cancels a pending check', async (t) => {
  const { checker } = fixture(t, '1.0.0', () => new Promise(() => {}), 5);
  assert.equal((await checker.check()).error, 'timeout');
  const pending = checker.check();
  checker.close();
  await pending;
});

test('rate limits pause retries and corrupted preferences do not enable automatic networking', async (t) => {
  let calls = 0;
  const { checker, home } = fixture(t, '1.0.0', async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); });
  assert.equal((await checker.check()).error, 'rate-limited');
  await checker.check();
  assert.equal(calls, 1);
  writeFileSync(join(home, 'updates.json'), '{broken');
  const broken = new UpdateChecker({ home, currentVersion: '1.0.0', fetcher: async () => { calls++; return response([]); } });
  t.after(() => broken.close());
  broken.start();
  assert.equal(broken.snapshot().autoCheck, false);
  assert.equal(broken.snapshot().status, 'error');
  assert.equal(calls, 1);
});
