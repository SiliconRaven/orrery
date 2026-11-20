// Signed first-party bundles and their per-Hub activation state. Third-party registration never reaches this module.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { TRANSCRIPT_MAX_ITEMS } from './core/native-transcript.ts';
import { PluginHost, pluginEnabledBySettings, shortError, type OfficialPlugin } from './core/plugin.ts';
import { MAX_ARCHIVE_BYTES, unpackPlugin } from './plugin-install-archive.ts';
import {
  officialPackageFile, sourceOfficialPackage, verifyOfficialPackage, type OfficialKeys, type VerifiedOfficialPackage,
} from './official-plugin-package.ts';
import { selectOfficialVersions, type OfficialChoice, type OfficialVariants } from './official-plugin-selection.ts';
import { compareVersions } from './update-check.ts';

const HOST_API = 1;
// The first release with official ZIPs pins the production publishers here. Never load keys from local state.
const RELEASE_KEYS: OfficialKeys = new Map();
const RELEASE_ROOT = 'https://github.com/SiliconRaven/orrery/releases/download/';
const INDEX = RELEASE_ROOT + 'official-plugins-v1/index.json';
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const DIGEST = /^[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const PREVIEW_MS = 30 * 60_000;
const LOAD_MS = 10_000;
const INDEX_LIMIT = 1024 * 1024;
const OFFICIAL_FILE_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'], ['.txt', 'text/plain; charset=utf-8'], ['.md', 'text/plain; charset=utf-8'],
]);

export interface OfficialUpdateOptions {
  /** Production keys are supplied by the Hub release. Tests inject only an ephemeral fixture publisher. */
  keys?: OfficialKeys;
  fetcher?: typeof fetch;
  /** Tests can exercise host compatibility without changing the Hub's installed package.json. */
  hubVersion?: string;
}

type Switches = { disabled: string[]; enabled: string[] };
type Ref = { version: string; digest: string };
type Pending = Ref & { id: string };
type Problem = { id: string; code: string; message: string };
type Saved = { format: 1; active: Record<string, Ref>; previous?: Record<string, Ref>; pending: Pending | null; lastFailure?: Problem };
type Choice = OfficialChoice & { plugin: OfficialPlugin; pkg?: VerifiedOfficialPackage };
type Release = { id: string; version: string; tag: string; asset: string; sha256: string; compatible: boolean };
type Preview = { prepareId: string; directory: string; version: string; id: string; migrationVersion: number; expires: number; digest: string };
type Confirmation = { id: string; version: string; restartRequired: true };

export class OfficialUpdateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const error = (code: string, message: string) => new OfficialUpdateError(code, message);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const version = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 128 || v.startsWith('v') || v.includes('+')) return false;
  try { compareVersions(v, v); return true; } catch { return false; }
};
const sameRef = (a: Ref | undefined, b: Ref | undefined) => a?.version === b?.version && a?.digest === b?.digest;
const refOf = ({ digest, manifest }: VerifiedOfficialPackage): Ref => ({ version: manifest.version, digest });
const reportOf = (id: string, cause: unknown): Problem => ({
  id, code: cause instanceof OfficialUpdateError ? cause.code : 'OFFICIAL_PACKAGE_INVALID', message: shortError(cause),
});

function directory(path: string, create = false): boolean {
  let stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat && create) {
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('OFFICIAL_STATE_INVALID', '官方插件目录须为本地普通目录。');
  return true;
}

function appliedMigrations(path: string): Map<string, number> {
  if (path === ':memory:' || !existsSync(path)) return new Map();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'plugin_migrations'").get()) return new Map();
    return new Map(db.prepare('SELECT plugin_id, version FROM plugin_migrations').all().map((r) => {
      const count = Number(r.version);
      if (!Number.isSafeInteger(count) || count < 0) throw error('OFFICIAL_DATABASE_INVALID', '插件迁移记录无效。');
      return [String(r.plugin_id), count];
    }));
  } finally { db.close(); }
}

function descriptor(raw: unknown, choice: Choice): OfficialPlugin {
  const manifest = choice.pkg!.manifest;
  if (!object(raw)) throw error('OFFICIAL_PACKAGE_INVALID', '官方包入口必须返回插件插槽对象。');
  const requires = manifest.requires.map(({ id }) => id);
  const identity = { id: manifest.id, version: manifest.version, defaultEnabled: choice.plugin.defaultEnabled };
  for (const [key, value] of Object.entries(identity)) {
    if (raw[key] !== undefined && raw[key] !== value) throw error('OFFICIAL_PACKAGE_INVALID', '入口与已验证清单的身份不一致。');
  }
  if (raw.requires !== undefined && (!Array.isArray(raw.requires) || raw.requires.length !== requires.length
    || raw.requires.some((dep, i) => dep !== requires[i]))) throw error('OFFICIAL_PACKAGE_INVALID', '入口与已验证清单的依赖不一致。');
  const migrations = raw.migrations ?? [];
  if (!Array.isArray(migrations) || migrations.length !== manifest.migrationVersion || migrations.some((step) => typeof step !== 'string')) {
    throw error('OFFICIAL_PACKAGE_INVALID', '入口与已验证清单的迁移步数不一致。');
  }
  const functions = ['tools', 'service', 'taskView', 'coordinatorView', 'envelope', 'clusterCreated', 'clusterPurging',
    'memberRebinding', 'memberRebound', 'memberRemoved', 'eventSource'];
  for (const key of functions) {
    if (raw[key] !== undefined && typeof raw[key] !== 'function') throw error('OFFICIAL_PACKAGE_INVALID', '官方包的插槽不是函数。');
  }
  for (const [key, owner] of [['taskView', 'tasks'], ['envelope', 'tasks'], ['bridgeRoutes', 'tasks'], ['coordinatorView', 'coordinator']]) {
    if (raw[key] !== undefined && manifest.id !== owner) throw error('OFFICIAL_PACKAGE_INVALID', '官方包占用了其他插件专属的插槽。');
  }
  for (const key of ['actions', 'queries', 'refs', 'prepare', 'messageFields']) {
    const slot = raw[key];
    if (slot !== undefined && (!object(slot) || Object.values(slot).some((item) => typeof item !== 'function'))) {
      throw error('OFFICIAL_PACKAGE_INVALID', '官方包的插槽映射无效。');
    }
  }
  for (const key of ['managementActions', 'prepareRequired']) {
    const slot = raw[key];
    if (slot !== undefined && (!Array.isArray(slot) || slot.some((item) => typeof item !== 'string'))) {
      throw error('OFFICIAL_PACKAGE_INVALID', '官方包的动作列表无效。');
    }
  }
  for (const key of ['routes', 'bridgeRoutes']) {
    const routes = raw[key];
    if (routes !== undefined && (!Array.isArray(routes) || routes.some((route: unknown) => !object(route)
      || typeof route.method !== 'string' || !(route.pattern instanceof RegExp) || route.pattern.global || route.pattern.sticky
      || typeof route.handle !== 'function'))) throw error('OFFICIAL_PACKAGE_INVALID', '官方包的路由声明无效。');
  }
  for (const key of ['name', 'description', 'details']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw error('OFFICIAL_PACKAGE_INVALID', '官方包的显示文字无效。');
  }
  return {
    name: choice.plugin.name, description: choice.plugin.description, details: choice.plugin.details,
    ...raw, ...identity, requires, migrations, webModule: undefined, icon: choice.plugin.icon,
  } as OfficialPlugin;
}

function dictionary(pkg: VerifiedOfficialPackage, path: string): Record<string, unknown> {
  const strings: unknown = JSON.parse(officialPackageFile(pkg, path).toString('utf8'));
  if (!object(strings) || Object.values(strings).some((value) => typeof value !== 'string')) throw error('OFFICIAL_PACKAGE_INVALID', '官方包的英文词表无效。');
  return strings;
}

async function loadChoice(choice: Choice): Promise<OfficialPlugin> {
  const pkg = choice.pkg!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const entry = await import(pathToFileURL(join(pkg.directory, pkg.manifest.entry)).href);
        if (typeof entry.default !== 'function') throw error('OFFICIAL_PACKAGE_INVALID', '官方包没有默认入口函数。');
        return descriptor(await entry.default({ hostApi: HOST_API, z, transcriptMaxItems: TRANSCRIPT_MAX_ITEMS }), choice);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error('OFFICIAL_PACKAGE_INVALID', '官方包的入口加载超时。')), LOAD_MS);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export class OfficialPluginUpdates {
  private readonly options: OfficialUpdateOptions & {
    home: string; dbPath: string; hubVersion: string; builtins: readonly OfficialPlugin[];
    switches(): Switches; envDisabled: string[];
  };
  private readonly root: string;
  private readonly keys: OfficialKeys;
  private readonly fetcher: typeof fetch;
  private readonly hubVersion: string;
  private readonly builtins: Map<string, OfficialPlugin>;
  private saved: Saved = { format: 1, active: {}, pending: null };
  private running = new Map<string, Choice>();
  private activePlugins = new Map<string, OfficialPlugin>();
  private english = new Map<string, Record<string, unknown>>();
  /** Built-in copies that run from a repo payload: their web/ is served like a signed package's while selected. */
  private readonly sources = new Map<string, { pkg: VerifiedOfficialPackage; english?: Record<string, unknown> }>();
  private releases: Release[] = [];
  private preview?: Preview;
  private confirmation?: { prepareId: string; result: Confirmation };
  private serial: Promise<unknown> = Promise.resolve();
  private rejected?: Problem;

  constructor(options: OfficialPluginUpdates['options']) {
    this.options = options;
    this.root = resolve(options.home, 'official-plugins');
    this.keys = options.keys ?? RELEASE_KEYS;
    this.fetcher = options.fetcher ?? fetch;
    this.hubVersion = options.hubVersion;
    this.builtins = new Map(options.builtins.map((plugin) => [plugin.id, plugin]));
    if (directory(this.root)) this.saved = this.readState();
  }

  private readState(): Saved {
    const path = join(this.root, 'state.json');
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return this.saved;
    try {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error();
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const goodRef = (value: unknown): value is Ref => object(value) && version(value.version) && typeof value.digest === 'string' && DIGEST.test(value.digest);
      const goodMap = (value: unknown) => object(value) && Object.entries(value).every(([id, ref]) => this.builtins.has(id) && goodRef(ref));
      if (!object(data) || data.format !== 1 || !goodMap(data.active) || (data.previous !== undefined && !goodMap(data.previous))
        || (data.pending !== null && (!object(data.pending) || typeof data.pending.id !== 'string' || !this.builtins.has(data.pending.id) || !goodRef(data.pending)))
        || (data.lastFailure !== undefined && (!object(data.lastFailure) || typeof data.lastFailure.id !== 'string'
          || !this.builtins.has(data.lastFailure.id) || typeof data.lastFailure.code !== 'string' || typeof data.lastFailure.message !== 'string'))) {
        throw new Error();
      }
      return data as unknown as Saved;
    } catch { throw error('OFFICIAL_STATE_INVALID', '官方插件状态文件无效，已保留插件制品和数据库。'); }
  }

  private save(next: Saved): void {
    directory(this.root, true);
    const temp = join(this.root, 'state-' + randomUUID() + '.tmp');
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temp, join(this.root, 'state.json'));
      this.saved = next;
    } finally { rmSync(temp, { force: true }); }
  }

  private bundle(plugin: OfficialPlugin): Choice {
    return { id: plugin.id, version: plugin.version, plugin, requires: (plugin.requires ?? []).map((id) => ({ id, minVersion: '0.0.0-0' })) };
  }

  /** The built-in copy as a candidate. One that runs from a repo payload is one only when the payload reads back whole. */
  private bundled(plugin: OfficialPlugin): Choice | undefined {
    if (plugin.packageSource) {
      try {
        const pkg = sourceOfficialPackage(plugin.packageSource.directory, plugin.packageSource.metadata);
        if (pkg.manifest.id !== plugin.id || pkg.manifest.version !== plugin.version) throw error('OFFICIAL_PACKAGE_INVALID', '内置副本与其发布元数据不一致。');
        const english = pkg.manifest.web?.english;
        this.sources.set(plugin.id, { pkg, english: english ? dictionary(pkg, english) : undefined });
      } catch (cause) {
        this.rejected = reportOf(plugin.id, cause);
        return undefined;
      }
    }
    return this.bundle(plugin);
  }

  private cached(id: string, ref: Ref): VerifiedOfficialPackage {
    const folder = join(this.root, id);
    if (!directory(this.root) || !directory(folder)) throw error('OFFICIAL_PACKAGE_INVALID', '本地官方包文件夹不存在。');
    return verifyOfficialPackage(join(folder, ref.digest), this.keys, { id, ...ref });
  }

  private choice(pkg: VerifiedOfficialPackage, migrations: Map<string, number>): Choice {
    const m = pkg.manifest;
    const plugin = this.builtins.get(m.id);
    if (!plugin) throw error('OFFICIAL_PACKAGE_INVALID', '该 ID 未登记为官方插件。');
    if (m.hub.api !== HOST_API || compareVersions(this.hubVersion, m.hub.minVersion) < 0) {
      throw error('OFFICIAL_HUB_INCOMPATIBLE', '该插件包需要兼容的 Hub 接口与版本。');
    }
    if (m.migrationVersion < (migrations.get(m.id) ?? 0)) {
      throw error('OFFICIAL_DATABASE_INCOMPATIBLE', '该插件版本无法读取已提交的数据库迁移。');
    }
    return { id: m.id, version: m.version, requires: m.requires, plugin, pkg };
  }

  private enabled(plugin: OfficialPlugin, switches: Switches): boolean {
    return pluginEnabledBySettings(plugin, [...this.options.envDisabled, ...switches.disabled], switches.enabled);
  }

  async boot(): Promise<OfficialPlugin[]> {
    const switches = this.options.switches();
    const original = [...this.builtins.values()];
    const bundles = new Map(original.map((p) => [p.id, this.bundled(p)]));
    if (!Object.keys(this.saved.active).length && !Object.keys(this.saved.previous ?? {}).length && !this.saved.pending
      && [...bundles.values()].every(Boolean)) {
      this.running = new Map(original.map((p) => [p.id, this.bundle(p)]));
      this.activePlugins = new Map(original.map((p) => [p.id, p]));
      return original;
    }
    const migrations = appliedMigrations(this.options.dbPath);
    const references = new Map<string, VerifiedOfficialPackage | undefined>();
    const reason = new Map<string, Problem>();
    const read = (id: string, ref: Ref): VerifiedOfficialPackage | undefined => {
      const key = id + '/' + ref.digest;
      if (!references.has(key)) {
        try { references.set(key, this.cached(id, ref)); }
        catch (cause) { reason.set(key, reportOf(id, cause)); references.set(key, undefined); }
      }
      const pkg = references.get(key);
      return pkg?.manifest.version === ref.version ? pkg : undefined;
    };
    const candidate = (id: string, ref: Ref | undefined, record: boolean): Choice | undefined => {
      if (!ref) return undefined;
      try {
        const pkg = read(id, ref);
        if (pkg) return this.choice(pkg, migrations);
        if (record) this.rejected = reason.get(id + '/' + ref.digest) ?? reportOf(id, error('OFFICIAL_PACKAGE_INVALID', '版本引用与已签清单不一致。'));
      } catch (cause) { if (record) this.rejected = reportOf(id, cause); }
      return undefined;
    };
    const variants: OfficialVariants<Choice>[] = original.map((plugin) => {
      const id = plugin.id;
      const bundled = (plugin.migrations?.length ?? 0) >= (migrations.get(id) ?? 0) ? bundles.get(id) : undefined;
      const active = candidate(id, this.saved.active[id], true);
      const previous = candidate(id, this.saved.previous?.[id], false);
      return { id, enabled: this.enabled(plugin, switches), original: this.saved.active[id] ? active : bundled, active, previous, bundled };
    });
    const pendingRef = this.saved.pending;
    let pending = pendingRef ? candidate(pendingRef.id, pendingRef, true) : undefined;
    const imported = new Map<Choice, OfficialPlugin>();
    const translations = new Map<Choice, Record<string, unknown>>();
    for (;;) {
      const group = selectOfficialVersions(variants, pending);
      if (!group) {
        const ids = original.map(({ id }) => id + '=' + (migrations.get(id) ?? 0)).join(', ');
        throw error('OFFICIAL_NO_COMPATIBLE_SET', '官方插件没有兼容的启动组合（已提交的迁移 ' + ids
          + '）。' + (this.rejected ? ' ' + this.rejected.message : '') + ' 数据库与制品已保留，请检查 ' + join(this.options.home, 'backups') + ' 中的迁移前备份。');
      }
      if (pending && !group.includes(pending)) this.rejected = reportOf(pending.id, error('OFFICIAL_DEPENDENCY_CONFLICT', '待生效版本不能替换当前插件组合。'));
      let loaded: OfficialPlugin[];
      let loading: Choice | undefined;
      try {
        loaded = [];
        for (const c of group) {
          loading = c;
          const pkg = c.pkg;
          if (pkg && !imported.has(c)) {
            const plugin = await loadChoice(c);
            if (pkg.manifest.web?.english) translations.set(c, dictionary(pkg, pkg.manifest.web.english));
            imported.set(c, plugin);
          }
          loaded.push(imported.get(c) ?? c.plugin);
        }
        loading = undefined;
        const disabled = variants.filter((v) => !v.enabled).map(({ id }) => id);
        new PluginHost(loaded, disabled, { explicitlyEnabled: switches.enabled });
      } catch (cause) {
        const rejected = loading?.pkg ? loading : group.find((c) => c === pending) ?? group.find((c) => c.pkg);
        if (!rejected) throw cause;
        this.rejected = reportOf(rejected.id, cause);
        if (rejected === pending) pending = undefined;
        for (const v of variants) {
          if (v.original === rejected) delete v.original;
          if (v.active === rejected) delete v.active;
          if (v.previous === rejected) delete v.previous;
        }
        continue;
      }
      for (const c of group) {
        if (this.saved.active[c.id] && !sameRef(c.pkg && refOf(c.pkg), this.saved.active[c.id])) {
          this.rejected ??= reportOf(c.id, error('OFFICIAL_FALLBACK', '启动时采用了与当前宿主、数据库和依赖相容的版本。'));
        }
      }
      this.running = new Map(group.map((c) => [c.id, c]));
      this.activePlugins = new Map(loaded.map((p) => [p.id, p]));
      this.english = new Map(group.flatMap((c) => {
        const strings = translations.get(c);
        return strings ? [[c.id, strings]] : [];
      }));
      return loaded;
    }
  }

  /** Called after Store and its migrations are ready, before enabling the Hub's API and delivery. */
  commitBoot(): void {
    const active: Record<string, Ref> = {};
    const previous = { ...this.saved.previous };
    for (const [id, choice] of this.running) {
      if (choice.pkg) active[id] = refOf(choice.pkg);
      const old = this.saved.active[id];
      if (old && !sameRef(old, active[id])) {
        try { this.cached(id, old); previous[id] = old; } catch { /* Do not replace a recovery reference with a damaged package. */ }
      }
      if (sameRef(previous[id], active[id])) delete previous[id];
    }
    const pending = this.saved.pending;
    const prior = this.saved.lastFailure;
    const lastFailure = this.rejected ?? (pending && prior?.id === pending.id && sameRef(active[pending.id], pending) ? undefined : prior);
    const next: Saved = { format: 1, active, ...(Object.keys(previous).length ? { previous } : {}), pending: null,
      ...(lastFailure ? { lastFailure } : {}) };
    if (JSON.stringify(next) !== JSON.stringify(this.saved)) this.save(next);
  }

  private async bytes(address: string, limit: number): Promise<Buffer> {
    let url = new URL(address);
    const allows = (u: URL) => u.protocol === 'https:' && !u.username && !u.password && !u.port
      && (u.href.startsWith(RELEASE_ROOT) || ASSET_HOSTS.has(u.hostname));
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!allows(url)) throw error('OFFICIAL_DOWNLOAD_FAILED', '官方包地址超出允许的发行渠道。');
      const res = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const next = res.headers.get('location');
        await res.body?.cancel();
        if (!next) break;
        url = new URL(next, url);
        continue;
      }
      if (!res.ok || !res.body || Number(res.headers.get('content-length')) > limit) {
        await res.body?.cancel();
        throw error('OFFICIAL_DOWNLOAD_FAILED', '官方目录或安装包读取失败。');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const bytes of res.body) {
        size += bytes.length;
        if (size > limit) throw error('OFFICIAL_DOWNLOAD_FAILED', '官方目录或安装包超过大小限制。');
        chunks.push(Buffer.from(bytes));
      }
      return Buffer.concat(chunks);
    }
    throw error('OFFICIAL_DOWNLOAD_FAILED', '官方包下载跳转次数过多。');
  }

  async check() {
    const updateable = new Set([...this.keys.values()].flatMap(({ ids }) => ids.filter((id) => this.builtins.has(id))));
    if (!updateable.size) return { candidates: [] };
    let data: unknown;
    try { data = JSON.parse((await this.bytes(INDEX, INDEX_LIMIT)).toString('utf8')); }
    catch (cause) {
      if (cause instanceof OfficialUpdateError) throw cause;
      throw error('OFFICIAL_DOWNLOAD_FAILED', '无法读取官方插件发行目录。');
    }
    if (!object(data) || data.format !== 1 || !Array.isArray(data.releases)) throw error('OFFICIAL_RELEASE_INVALID', '官方插件发行目录无效。');
    const beta = this.hubVersion.split('+')[0].includes('-');
    const seen = new Set<string>();
    const found: Release[] = [];
    for (const entry of data.releases) {
      if (!object(entry) || typeof entry.id !== 'string' || !updateable.has(entry.id)) continue;
      const { id, version: v, tag, asset, sha256, hub } = entry;
      if (!version(v) || typeof tag !== 'string' || !SEGMENT.test(tag)
        || typeof asset !== 'string' || !SEGMENT.test(asset) || !/\.zip$/i.test(asset)
        || typeof sha256 !== 'string' || !DIGEST.test(sha256)) throw error('OFFICIAL_RELEASE_INVALID', '官方插件发行条目无效。');
      const key = id + '/' + v;
      if (seen.has(key)) throw error('OFFICIAL_RELEASE_INVALID', '官方插件发行目录有重复版本。');
      seen.add(key);
      if ((!beta && v.includes('-')) || compareVersions(v, this.running.get(id)!.version) <= 0) continue;
      if (hub !== undefined && (!object(hub) || !Number.isSafeInteger(hub.api) || !version(hub.minVersion))) {
        throw error('OFFICIAL_RELEASE_INVALID', '官方插件发行条目的 Hub 版本提示无效。');
      }
      const compatible = hub === undefined || (object(hub) && hub.api === HOST_API && typeof hub.minVersion === 'string'
        && compareVersions(this.hubVersion, hub.minVersion) >= 0);
      found.push({ id, version: v, tag, asset, sha256, compatible });
    }
    this.releases = found.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(b.version, a.version));
    // Index data has no authority over compatibility. The signed manifest is checked in prepare().
    return { candidates: this.releases.map(({ id, version, compatible }) => ({ id, version, compatible })) };
  }

  private ordered<T>(run: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.catch(() => {});
    return next;
  }

  private discard(): void {
    if (!this.preview) return;
    this.removeStage(this.preview.directory);
    this.preview = undefined;
  }

  private removeStage(dir: string): void {
    const staging = join(this.root, '.staging');
    if (dirname(dir) !== staging) throw error('OFFICIAL_STATE_INVALID', '临时安装目录无效。');
    if (directory(this.root) && directory(staging)) rmSync(dir, { recursive: true, force: true });
  }

  private validateUpdate(pkg: VerifiedOfficialPackage): void {
    const switches = this.options.switches();
    const migrations = appliedMigrations(this.options.dbPath);
    const choice = this.choice(pkg, migrations);
    if (compareVersions(choice.version, this.running.get(choice.id)!.version) <= 0) {
      throw error('OFFICIAL_RELEASE_INVALID', '只能准备比运行版本新的官方插件包。');
    }
    const group = [...this.running.values()].map((c) => c.id === choice.id ? choice : c);
    const variants = group.map((c) => ({ id: c.id, enabled: this.enabled(c.plugin, switches), original: c }));
    if (!selectOfficialVersions(variants)) throw error('OFFICIAL_DEPENDENCY_CONFLICT', '该版本与当前插件依赖或启用状态不相容。');
  }

  prepare(id: unknown, wanted: unknown) {
    return this.ordered(async () => {
      if (this.saved.pending) throw error('OFFICIAL_RESTART_PENDING', '已有官方插件更新等候重启。');
      const release = this.releases.find((r) => r.id === id && r.version === wanted);
      if (!release) throw error('OFFICIAL_RELEASE_INVALID', '请先检查更新，再选择官方目录中的版本。');
      if (!release.compatible) throw error('OFFICIAL_HUB_INCOMPATIBLE', '发行目录中的该版本需要更新的 Hub。');
      this.discard();
      let bytes: Buffer;
      try { bytes = await this.bytes(RELEASE_ROOT + encodeURIComponent(release.tag) + '/' + encodeURIComponent(release.asset), MAX_ARCHIVE_BYTES); }
      catch (cause) { if (cause instanceof OfficialUpdateError) throw cause; throw error('OFFICIAL_DOWNLOAD_FAILED', '官方包下载失败。'); }
      if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50
        || createHash('sha256').update(bytes).digest('hex') !== release.sha256) {
        throw error('OFFICIAL_PACKAGE_INVALID', '官方插件 ZIP 与发行记录不一致。');
      }
      directory(this.root, true);
      const staging = join(this.root, '.staging');
      directory(staging, true);
      const temporary = mkdtempSync(join(staging, 'official-'));
      try {
        await unpackPlugin(bytes, temporary);
        const pkg = verifyOfficialPackage(temporary, this.keys, { id: release.id, version: release.version });
        this.validateUpdate(pkg);
        const { id, version, migrationVersion } = pkg.manifest;
        const prepareId = randomUUID();
        this.preview = { prepareId, directory: temporary, id, version, migrationVersion, digest: pkg.digest, expires: Date.now() + PREVIEW_MS };
        return { prepareId, id, version, migrationVersion, restartRequired: true as const };
      } catch (cause) {
        this.removeStage(temporary);
        if (cause instanceof OfficialUpdateError) throw cause;
        throw error('OFFICIAL_PACKAGE_INVALID', shortError(cause));
      }
    });
  }

  confirm(prepareId: unknown) {
    return this.ordered(() => {
      if (this.confirmation && this.confirmation.prepareId === prepareId) return this.confirmation.result;
      const job = this.preview;
      if (!job || job.prepareId !== prepareId || job.expires <= Date.now()) {
        if (job && job.expires <= Date.now()) this.discard();
        throw error('OFFICIAL_PREVIEW_EXPIRED', '这次审阅已过期，请重新准备官方包。');
      }
      if (this.saved.pending) throw error('OFFICIAL_RESTART_PENDING', '已有官方插件更新等候重启。');
      const { id, version, digest } = job;
      const ref = { id, version, digest };
      const parent = join(this.root, id);
      if (!directory(this.root) || !directory(join(this.root, '.staging'))) {
        throw error('OFFICIAL_PREVIEW_EXPIRED', '临时安装目录已失效。');
      }
      let verified: VerifiedOfficialPackage;
      try { verified = verifyOfficialPackage(job.directory, this.keys, ref); }
      catch (cause) { throw error('OFFICIAL_PACKAGE_INVALID', shortError(cause)); }
      this.validateUpdate(verified);
      directory(parent, true);
      const destination = join(parent, digest);
      if (!directory(destination)) renameSync(job.directory, destination);
      else verifyOfficialPackage(destination, this.keys, ref);
      try { this.save({ ...this.saved, pending: ref }); }
      catch (cause) {
        // Keep the verified payload as a retry source if the state write failed after the directory rename.
        if (!existsSync(job.directory)) renameSync(destination, job.directory);
        throw cause;
      }
      this.discard();
      const result = { id, version, restartRequired: true as const };
      this.confirmation = { prepareId: job.prepareId, result };
      return result;
    });
  }

  cancel(prepareId: string) {
    return this.ordered(() => { if (this.preview?.prepareId === prepareId) this.discard(); });
  }

  private webUrl(pkg: VerifiedOfficialPackage, path: string): string {
    return '/official-plugin-web/' + pkg.manifest.id + '/' + pkg.digest + '/' + path.slice(4).split('/').map(encodeURIComponent).join('/');
  }

  /** The selected copy's web files: the signed package, or the payload a built-in copy runs from. */
  private web(id: string) {
    const c = this.running.get(id);
    return c?.pkg ?? (c ? this.sources.get(id)?.pkg : undefined);
  }

  card(id: string) {
    const c = this.running.get(id);
    if (!c) return undefined;
    const raw = c.pkg ? this.english.get(id) : this.sources.get(id)?.english;
    const web = this.web(id);
    const display = this.activePlugins.get(id);
    const english = raw && display ? Object.fromEntries(['name', 'description', 'details'].flatMap((key) => {
      const value = display[key as 'name' | 'description' | 'details'];
      return value && typeof raw[value] === 'string' ? [[key, raw[value]]] : [];
    })) : undefined;
    return {
      officialUpdate: {
        source: c.pkg ? 'package' : 'bundled',
        pendingVersion: this.saved.pending?.id === id ? this.saved.pending.version : undefined,
        error: this.saved.lastFailure?.id === id ? this.saved.lastFailure : undefined,
        english,
      },
      ...(web?.manifest.icon ? { iconUrl: '/api/plugins/' + id + '/icon' } : {}),
    };
  }

  frontend(id: string) {
    const pkg = this.web(id);
    const web = pkg?.manifest.web;
    return pkg && web ? { id, entry: this.webUrl(pkg, web.entry), ...(web.english ? { english: this.webUrl(pkg, web.english) } : {}) } : undefined;
  }

  private payload(pkg: VerifiedOfficialPackage, path: string) {
    const type = OFFICIAL_FILE_TYPES.get(extname(path).toLowerCase());
    if (!type || !Object.hasOwn(pkg.manifest.files, path)) return null;
    try { return { type, data: officialPackageFile(pkg, path) }; }
    catch { return null; }
  }

  webFile(id: string, digest: string, path: string) {
    const pkg = this.web(id);
    if (!pkg?.manifest.web || pkg.digest !== digest) return null;
    try { return this.payload(pkg, 'web/' + path.split('/').map(decodeURIComponent).join('/')); }
    catch { return null; }
  }

  icon(id: string) {
    const pkg = this.web(id);
    const path = pkg?.manifest.icon;
    if (!pkg || !path || !['.svg', '.png', '.webp', '.ico'].includes(extname(path).toLowerCase())) return null;
    return this.payload(pkg, path);
  }
}
