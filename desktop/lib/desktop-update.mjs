// The packaged desktop downloads only an exact x64 installer from its own public release.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, realpath, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RELEASES = 'https://api.github.com/repos/SiliconRaven/orrery/releases?per_page=100';
const ASSET_ROOT = 'https://github.com/SiliconRaven/orrery/releases/download/';
const ASSET_REDIRECT = /^https:\/\/(?:release-assets\.githubusercontent\.com|objects\.githubusercontent\.com)\//i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const METADATA_BYTES = 4 * 1024 * 1024;
const METADATA_MS = 8_000;
const DOWNLOAD_MS = 10 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/i;
const REQUEST_HEADERS = { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

class UpdateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const problem = code => new UpdateError(code);

// Keep precedence in step with src/update-check.ts. The packaged desktop cannot import the source Hub.
function version(text) {
  if (typeof text !== 'string' || text.length > 128 || text.trim() !== text) return null;
  const match = text.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(id => /^0\d+$/.test(id))) return null;
  return { text, core: match.slice(1, 4), pre };
}

function compare(a, b) {
  const lexical = (left, right) => left === right ? 0 : left < right ? -1 : 1;
  const numeric = (left, right) => left.length - right.length || lexical(left, right);
  for (let i = 0; i < 3; i++) {
    const order = numeric(a.core[i], b.core[i]);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i], right = b.pre[i];
    const digitsLeft = /^\d+$/.test(left), digitsRight = /^\d+$/.test(right);
    const order = digitsLeft && digitsRight ? numeric(left, right)
      : digitsLeft !== digitsRight ? Number(digitsRight) - Number(digitsLeft) : lexical(left, right);
    if (order) return order;
  }
  return a.pre.length - b.pre.length;
}

function asset(assets, name, limit) {
  const matches = assets.filter(item => item?.name === name);
  if (matches.length !== 1) return null;
  const item = matches[0];
  return item.state === 'uploaded' && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= limit ? item : null;
}

function newestRelease(data, current) {
  if (!Array.isArray(data)) throw problem('invalid-response');
  let result = null;
  for (const row of data) {
    if (typeof row?.tag_name !== 'string' || !row.tag_name.startsWith('v') || row.draft !== false
      || row.yanked === true || row.published_at === null || !Array.isArray(row.assets)) continue;
    const target = version(row.tag_name.slice(1));
    if (!target || (!current.pre.length && (row.prerelease === true || target.pre.length))) continue;
    const name = `Orrery-${target.text}-Setup-x64.exe`;
    const binary = asset(row.assets, name, MAX_INSTALLER_BYTES);
    if (!binary || (result && compare(target, result.target) <= 0)) continue;
    const checksum = asset(row.assets, name + '.sha256', 1024);
    result = { target, tag: row.tag_name, name, size: binary.size, digest: binary.digest, companion: checksum?.size ?? null };
  }
  return result;
}

async function smallText(response, limit, signal, code) {
  if (!response.body) throw problem(code);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw problem(code);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw problem(code); }
}

function checkedRedirect(location) {
  if (typeof location !== 'string' || !ASSET_REDIRECT.test(location) || /[\\\s]/.test(location)) throw problem('unsafe-redirect');
  const url = new URL(location);
  if (url.username || url.password || url.port || url.hash) throw problem('unsafe-redirect');
  return url.href;
}

async function itemResponse(fetchImpl, entry, name, signal) {
  let url = ASSET_ROOT + entry.tag + '/' + name;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(url, { signal, redirect: 'manual' });
    if (REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (redirects === 3) throw problem('unsafe-redirect');
      url = checkedRedirect(response.headers.get('location'));
    } else {
      if (response.ok && response.body && response.status === 200) return response;
      await response.body?.cancel().catch(() => {});
      throw problem('network');
    }
  }
  throw problem('unsafe-redirect');
}

async function expectedHash(fetchImpl, entry, signal) {
  if (entry.digest !== null && entry.digest !== undefined) {
    const match = typeof entry.digest === 'string' && entry.digest.match(/^sha256:([a-f0-9]{64})$/i);
    if (!match || match[0] !== entry.digest) throw problem('checksum-unavailable');
    return match[1].toLowerCase();
  }
  if (entry.companion === null) throw problem('checksum-unavailable');
  const response = await itemResponse(fetchImpl, entry, entry.name + '.sha256', signal);
  const raw = await smallText(response, 1024, signal, 'checksum-unavailable');
  const line = raw.replace(/\r?\n$/, '');
  const digest = line.slice(0, 64);
  if (!SHA256.test(digest) || line !== `${digest}  ${entry.name}`) throw problem('checksum-unavailable');
  return digest.toLowerCase();
}

const sameFile = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
async function ownsDirectory(staged) {
  const file = await lstat(staged.directory);
  return file.isDirectory() && !file.isSymbolicLink() && sameFile(file, staged.identity)
    && await realpath(staged.directory) === staged.directory;
}

/** Both names were generated in this process. Never delete files recursively or through a replaced directory. */
async function discard(staged) {
  if (!staged) return;
  try {
    if (!await ownsDirectory(staged)) return;
    await unlink(staged.path).catch(() => {});
    await rmdir(staged.directory).catch(() => {});
  } catch { /* already gone or no longer ours */ }
}

async function receive(response, staged, signal, onPercent) {
  const hash = createHash('sha256');
  let total = 0;
  let percent = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, done) {
      total += chunk.byteLength;
      if (total > staged.size) return done(problem('size-mismatch'));
      hash.update(chunk);
      const next = Math.min(99, Math.floor(total * 100 / staged.size));
      if (next !== percent) { percent = next; onPercent(next); }
      done(null, chunk);
    },
  }), createWriteStream(staged.path, { flags: 'wx', mode: 0o600 }), { signal });
  if (total !== staged.size) throw problem('size-mismatch');
  if (hash.digest('hex') !== staged.hash) throw problem('checksum-mismatch');
}

async function verifyInstaller(staged, signal) {
  if (!await ownsDirectory(staged)) throw problem('checksum-mismatch');
  const file = await lstat(staged.path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size !== staged.size
    || await realpath(staged.path) !== staged.path) throw problem('checksum-mismatch');
  const hash = createHash('sha256');
  let total = 0;
  for await (const chunk of createReadStream(staged.path, { signal })) {
    total += chunk.byteLength;
    if (total > staged.size) throw problem('size-mismatch');
    hash.update(chunk);
  }
  const after = await lstat(staged.path);
  if (total !== staged.size || !sameFile(file, after) || after.size !== staged.size || after.nlink !== 1
    || !await ownsDirectory(staged) || hash.digest('hex') !== staged.hash) throw problem('checksum-mismatch');
}

/** The only method that can hand an installer to Windows is install(), after two hash checks. */
export function createDesktopUpdater({ currentVersion, tempRoot, fetchImpl = globalThis.fetch, openInstaller, onChange = () => {} }) {
  const current = version(currentVersion);
  if (!current) throw new Error('Invalid current desktop version.');
  let state = { currentVersion, status: 'idle', latestVersion: null, percent: null, error: null };
  let entry = null;
  let staged = null;
  let busy = null;
  let disposed = false;
  let handoff = false;
  let disposing;

  const snapshot = () => ({ ...state });
  const publish = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    try { onChange(snapshot()); } catch { /* a closing window must not interrupt the update */ }
  };
  const fail = (error, fallback) => publish({ status: 'error', percent: null, error: error instanceof UpdateError ? error.code : fallback });
  const operate = (kind, work, skipped) => {
    if (disposed || handoff) return Promise.resolve(skipped);
    if (busy) return busy.kind === kind ? busy.promise : Promise.resolve(skipped);
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => controller.signal.aborted ? skipped : work(controller.signal))
      .finally(() => { busy = null; });
    busy = { kind, controller, promise };
    return promise;
  };

  return {
    snapshot,
    check() {
      return operate('check', async cancel => {
        if (staged) return snapshot();
        publish({ status: 'checking', percent: null, error: null });
        const signal = AbortSignal.any([cancel, AbortSignal.timeout(METADATA_MS)]);
        try {
          const response = await fetchImpl(RELEASES, { signal, redirect: 'error', headers: REQUEST_HEADERS });
          if (!response.ok || response.status !== 200) {
            await response.body?.cancel().catch(() => {});
            throw problem('network');
          }
          const raw = await smallText(response, METADATA_BYTES, signal, 'invalid-response');
          let data;
          try { data = JSON.parse(raw); } catch { throw problem('invalid-response'); }
          const latest = newestRelease(data, current);
          signal.throwIfAborted();
          entry = latest && compare(latest.target, current) > 0 ? latest : null;
          publish({ latestVersion: latest?.target.text ?? null, status: !latest ? 'no-release' : entry ? 'available' : 'current' });
        } catch (error) { fail(error, 'network'); }
        return snapshot();
      }, snapshot());
    },
    download() {
      return operate('download', async cancel => {
        if (!entry || staged) return snapshot();
        const target = entry;
        publish({ status: 'downloading', percent: 0, error: null });
        const signal = AbortSignal.any([cancel, AbortSignal.timeout(DOWNLOAD_MS)]);
        let pending;
        try {
          const hash = await expectedHash(fetchImpl, target, AbortSignal.any([signal, AbortSignal.timeout(METADATA_MS)]));
          signal.throwIfAborted();
          const root = await realpath(tempRoot);
          const directory = await mkdtemp(join(root, 'orrery-desktop-update-'));
          pending = { directory, path: join(directory, target.name), identity: await lstat(directory), hash, size: target.size };
          signal.throwIfAborted();
          const response = await itemResponse(fetchImpl, target, target.name, signal);
          await receive(response, pending, signal, percent => publish({ percent }));
          signal.throwIfAborted();
          staged = pending;
          pending = null;
          publish({ status: 'ready', percent: 100 });
        } catch (error) {
          await discard(pending);
          fail(error, 'download-failed');
        }
        return snapshot();
      }, snapshot());
    },
    install() {
      return operate('install', async signal => {
        if (!staged) return false;
        publish({ status: 'installing', error: null });
        try {
          await verifyInstaller(staged, signal);
          signal.throwIfAborted();
        } catch (error) {
          await discard(staged);
          staged = null;
          fail(error, 'checksum-mismatch');
          return false;
        }
        try {
          // The native opener returns an empty error string on success; injected openers may return true.
          const result = await openInstaller(staged.path);
          if (result !== true && result !== '') throw problem('install-failed');
          handoff = true;
          return true;
        } catch {
          publish({ status: 'ready', error: 'install-failed' });
          return false;
        }
      }, false);
    },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      busy?.controller.abort();
      disposing = (async () => {
        await busy?.promise;
        if (!handoff) {
          await discard(staged);
          staged = null;
          state = { currentVersion, status: 'idle', latestVersion: null, percent: null, error: null };
        }
      })();
      return disposing;
    },
  };
}
