// Process-level update detection. It reads public release metadata only; it never downloads or executes an installer.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RELEASES = 'https://api.github.com/repos/SiliconRaven/orrery/releases?per_page=100';
const RELEASE_PAGE = 'https://github.com/SiliconRaven/orrery/releases/tag/';
const INTERVAL = 6 * 60 * 60 * 1000;
type UpdateError = 'not-found' | 'rate-limited' | 'timeout' | 'network' | 'invalid-response';
type Release = { tag: string; prerelease: boolean };
type Saved = { autoCheck: boolean; releases?: Release[]; etag?: string; checkedAt?: number };
export type UpdateState = {
  currentVersion: string; channel: 'stable' | 'beta'; autoCheck: boolean;
  status: 'idle' | 'checking' | 'current' | 'available' | 'no-release' | 'error';
  latestVersion: string | null; releaseUrl: string | null; checkedAt: number | null; error: UpdateError | null;
};

function version(input: string) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(input);
  if (!m) return null;
  const pre = m[4]?.split('.') ?? [];
  if (pre.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) return null;
  return { core: m.slice(1, 4), pre, text: input.replace(/^v/, '') };
}
const numeric = (a: string, b: string) => a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : a.length < b.length ? -1 : 1;

/** SemVer precedence, including numeric prerelease identifiers and ignoring build metadata. */
export function compareVersions(a: string, b: string): number {
  const left = version(a), right = version(b);
  if (!left || !right) throw new Error('Invalid semantic version.');
  for (let i = 0; i < 3; i++) { const order = numeric(left.core[i], right.core[i]); if (order) return order; }
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    return nx && ny ? numeric(x, y) : nx !== ny ? nx ? -1 : 1 : x < y ? -1 : 1;
  }
  return 0;
}

class CheckError extends Error {
  code: UpdateError;
  constructor(code: UpdateError) { super(code); this.code = code; }
}

export class UpdateChecker {
  private saved: Saved = { autoCheck: true };
  private state: UpdateState;
  private file: string;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private pending?: Promise<UpdateState>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private retryAt = 0;

  constructor({ home, currentVersion, fetcher = fetch, timeoutMs = 8000 }: {
    home: string; currentVersion: string; fetcher?: typeof fetch; timeoutMs?: number;
  }) {
    const parsed = version(currentVersion);
    if (!parsed) throw new Error('Invalid current application version.');
    this.file = join(home, 'updates.json');
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.state = { currentVersion: parsed.text, channel: parsed.pre.length ? 'beta' : 'stable', autoCheck: true,
      status: 'idle', latestVersion: null, releaseUrl: null, checkedAt: null, error: null };
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof data.autoCheck !== 'boolean' || (data.etag !== undefined && typeof data.etag !== 'string')
        || (data.checkedAt !== undefined && (!Number.isFinite(data.checkedAt) || data.checkedAt < 0))
        || (data.releases !== undefined && (!Array.isArray(data.releases) || !data.releases.every((r: Release) =>
          r && typeof r.tag === 'string' && version(r.tag) && typeof r.prerelease === 'boolean')))) throw new Error('Invalid update cache.');
      this.saved = { autoCheck: data.autoCheck, etag: data.etag, checkedAt: data.checkedAt, releases: data.releases };
      this.applyCache();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A broken preference file must not silently turn network checks back on.
        this.saved.autoCheck = false;
        this.state.status = 'error'; this.state.error = 'invalid-response';
      }
    }
  }

  snapshot(): UpdateState { return { ...this.state, autoCheck: this.saved.autoCheck }; }

  setAutoCheck(value: unknown): UpdateState {
    if (typeof value !== 'boolean') throw new Error('autoCheck must be a boolean.');
    this.save({ ...this.saved, autoCheck: value });
    this.schedule();
    return this.snapshot();
  }

  /** Called only by the real process entry point; construction and tests do not start network activity. */
  start(): void { if (!this.closed && !this.started) { this.started = true; this.schedule(); } }

  close(): void {
    this.closed = true;
    clearInterval(this.timer); this.timer = undefined;
    this.controller?.abort();
  }

  private schedule(): void {
    clearInterval(this.timer); this.timer = undefined;
    if (!this.started || this.closed || !this.saved.autoCheck) return;
    const check = () => {
      const age = Date.now() - (this.saved.checkedAt ?? 0);
      if (this.saved.checkedAt === undefined || age < 0 || age >= INTERVAL) void this.check();
    };
    check();
    this.timer = setInterval(check, INTERVAL);
    this.timer.unref();
  }

  check(): Promise<UpdateState> {
    if (this.pending) return this.pending;
    if (this.closed || Date.now() < this.retryAt) return Promise.resolve(this.snapshot());
    this.pending = this.perform().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private save(data: Saved): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try { writeFileSync(temp, JSON.stringify(data) + '\n'); renameSync(temp, this.file); }
    catch (e) { rmSync(temp, { force: true }); throw e; }
    this.saved = data;
  }

  private applyCache(): void {
    let latest: Release | undefined;
    for (const release of this.saved.releases ?? []) {
      if (this.state.channel === 'stable' && (release.prerelease || version(release.tag)!.pre.length)) continue;
      if (!latest || compareVersions(release.tag, latest.tag) > 0) latest = release;
    }
    this.state = { ...this.state, checkedAt: this.saved.checkedAt ?? null, error: null,
      latestVersion: latest ? version(latest.tag)!.text : null,
      releaseUrl: latest ? `${RELEASE_PAGE}${encodeURIComponent(latest.tag)}` : null,
      status: this.saved.releases === undefined ? 'idle' : !latest ? 'no-release'
        : compareVersions(latest.tag, this.state.currentVersion) > 0 ? 'available' : 'current' };
  }

  private async perform(): Promise<UpdateState> {
    this.state = { ...this.state, status: 'checking', error: null };
    const controller = new AbortController(); this.controller = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async (): Promise<Saved> => {
        const response = await this.fetcher(RELEASES, { signal: controller.signal, redirect: 'error', headers: {
          accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          ...(this.saved.etag ? { 'If-None-Match': this.saved.etag } : {}),
        } });
        if (response.status === 304) {
          if (this.saved.releases === undefined) throw new CheckError('invalid-response');
          return { ...this.saved, checkedAt: Date.now() };
        }
        if (response.status === 404) throw new CheckError('not-found');
        if (response.status === 403 || response.status === 429) {
          const retry = Number(response.headers.get('retry-after'));
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          this.retryAt = Math.max(Date.now() + (retry > 0 ? retry * 1000 : 60_000), reset || 0);
          throw new CheckError('rate-limited');
        }
        if (!response.ok) throw new CheckError('network');
        let data: unknown;
        try { data = await response.json(); } catch { throw new CheckError('invalid-response'); }
        if (!Array.isArray(data)) throw new CheckError('invalid-response');
        // shortcut: inspect the newest 100 release records; add pagination if this project outgrows that window.
        const releases = data.filter((r) => r && r.draft !== true && typeof r.tag_name === 'string' && version(r.tag_name))
          .map((r) => ({ tag: r.tag_name as string, prerelease: r.prerelease === true }));
        return { autoCheck: this.saved.autoCheck, releases, etag: response.headers.get('etag') ?? undefined, checkedAt: Date.now() };
      };
      const result = await Promise.race([work(), new Promise<never>((_ok, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CheckError('timeout')); }, this.timeoutMs);
        controller.signal.addEventListener('abort', () => reject(new CheckError('timeout')), { once: true });
      })]);
      if (!this.closed) { this.save({ ...result, autoCheck: this.saved.autoCheck }); this.applyCache(); }
    } catch (e) {
      if (!this.closed) this.state = { ...this.state, status: 'error', error: e instanceof CheckError ? e.code : 'network' };
    } finally { clearTimeout(timer); this.controller = undefined; }
    return this.snapshot();
  }
}
