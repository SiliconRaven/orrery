// Download and inspect plugin packages, then register only the grants the user confirms.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { object, parseExternalGrants, parseExternalManifest, resolveExternalEntry, readExternalPlugins,
  type ExternalManifest } from './core/external-plugin-config.ts';
import { externalEnvironment } from './core/external-plugin-process.ts';
import { archivePath, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, MAX_EXPANDED_BYTES, unpackPlugin } from './plugin-install-archive.ts';

export type InstallInput = { source: string; manifestPath?: string }
  | { bytes: Uint8Array; filename: string; manifestPath?: string };
export interface InstallSource {
  kind: 'github' | 'npm' | 'upload';
  requested: string;
  resolved: string;
  version?: string;
}
export interface InstallPreview {
  id: string;
  manifest: ExternalManifest;
  source: InstallSource;
  digest: string;
  manifestPath: string;
  restartRequired: true;
}
export interface InstallGrants {
  permissions: string[];
  events: string[];
  clusterIds: string[];
  writeClusterIds: string[];
  tools?: string[];
  ui?: string[];
}
export interface PluginInstallerOptions {
  home: string;
  knownPluginIds: readonly string[];
  npmCli?: string;
  nodePath?: string;
  fetcher?: typeof fetch;
}
export class PluginInstallError extends Error {
  readonly code: string;
  readonly manifestPaths?: string[];
  constructor(code: string, message: string, manifestPaths?: string[]) {
    super(message);
    this.name = 'PluginInstallError';
    this.code = code;
    this.manifestPaths = manifestPaths;
  }
}

type Prepared = { preview: InstallPreview; staging: string; directory: string; createdAt: number };
type Registration = { manifest: string } & InstallGrants;
const MANIFEST = 'orrery-plugin.json';
const REGISTRY = 'https://registry.npmjs.org';
const REQUEST_TIMEOUT_MS = 30_000;
const PREVIEW_TTL_MS = 30 * 60_000;
const PACKAGE_NAME = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';

function fail(code: string, message: string): never { throw new PluginInstallError(code, message); }

function jsonFile(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) fail('INVALID_PACKAGE', 'A plugin JSON file must be a regular file of at most 64 KiB.');
  return object(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
}

function confined(root: string, path: string): void {
  const fromRoot = relative(root, path);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot)) {
    fail('INVALID_PACKAGE', 'A plugin path escapes its owned directory.');
  }
}

/** Every file contributes to the preview, including files the entry could import later. */
function treeDigest(directory: string): string {
  const hash = createHash('sha256');
  let count = 0;
  let size = 0;
  const visit = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const key = prefix ? `${prefix}/${name}` : name;
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail('PACKAGE_CHANGED', 'The prepared package contains a link or unsupported file.');
      if (++count > MAX_ARCHIVE_FILES) fail('INVALID_PACKAGE', 'The package contains too many files.');
      hash.update(stat.isDirectory() ? 'd\0' : 'f\0').update(key).update('\0');
      if (stat.isDirectory()) visit(file, key);
      else {
        size += stat.size;
        if (stat.size > MAX_ARCHIVE_BYTES || size > MAX_EXPANDED_BYTES) fail('INVALID_PACKAGE', 'The package exceeds the expanded size limit.');
        hash.update(readFileSync(file));
      }
    }
  };
  visit(directory, '');
  return `sha256:${hash.digest('hex')}`;
}

function manifestAt(directory: string): ExternalManifest {
  const manifest = parseExternalManifest(jsonFile(join(directory, MANIFEST)));
  resolveExternalEntry(directory, manifest);
  return manifest;
}

function grantsOf(value: InstallGrants, manifest: ExternalManifest) {
  const data = object(value);
  if (Object.keys(data).some((key) => !['permissions', 'events', 'clusterIds', 'writeClusterIds', 'tools', 'ui'].includes(key))) fail('INVALID_GRANTS', 'Unknown plugin grant field.');
  try { return parseExternalGrants(data, manifest); }
  catch (error) { return fail('INVALID_GRANTS', (error as Error).message); }
}

function dependencySpec(value: unknown): void {
  if (typeof value !== 'string' || !value || value.length > 1024) fail('INVALID_DEPENDENCY', 'Invalid npm dependency version.');
  if (value.startsWith('npm:')) {
    const alias = new RegExp(`^npm:(${PACKAGE_NAME})@(.+)$`).exec(value);
    if (!alias) fail('INVALID_DEPENDENCY', 'Only public npm dependencies are supported.');
    dependencySpec(alias[2]);
    return;
  }
  if (!/^[a-zA-Z0-9*^~<>=|+., _-]+$/.test(value)) fail('INVALID_DEPENDENCY', 'Local, Git, URL and linked dependencies are not supported.');
}

function packageDependencies(directory: string): boolean {
  if (existsSync(join(directory, '.npmrc'))) fail('INVALID_DEPENDENCY', 'Plugin packages must not include a project .npmrc.');
  const path = join(directory, 'package.json');
  if (!existsSync(path)) return false;
  const pkg = jsonFile(path);
  let needsInstall = false;
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    if (pkg[field] === undefined) continue;
    for (const spec of Object.values(object(pkg[field]))) {
      dependencySpec(spec);
      if (field !== 'devDependencies') needsInstall = true;
    }
  }
  const overrides = (value: unknown): void => {
    for (const child of Object.values(object(value))) {
      if (typeof child === 'string') dependencySpec(child);
      else overrides(child);
    }
  };
  if (pkg.overrides !== undefined) overrides(pkg.overrides);
  return needsInstall;
}

/** The generated lock is checked before npm writes dependency contents. */
function checkDependencyLock(directory: string): void {
  const path = ['npm-shrinkwrap.json', 'package-lock.json'].map((name) => join(directory, name)).find(existsSync);
  if (!path) fail('DEPENDENCIES_FAILED', 'npm did not produce a dependency lock.');
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) fail('INVALID_DEPENDENCY', 'The dependency lock is too large.');
  const lock = object(JSON.parse(raw));
  const inspect = (item: unknown): void => {
    const pkg = object(item);
    if (pkg.link) fail('INVALID_DEPENDENCY', 'Linked npm dependencies are not supported.');
    if (pkg.resolved !== undefined && (typeof pkg.resolved !== 'string' || !pkg.resolved.startsWith(REGISTRY + '/'))) {
      fail('INVALID_DEPENDENCY', 'Dependencies must resolve to the public npm registry.');
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (pkg[field] !== undefined) for (const spec of Object.values(object(pkg[field]))) {
        if (lock.lockfileVersion === 1 && typeof spec === 'object') inspect(spec);
        else dependencySpec(spec);
      }
    }
    if (pkg.requires !== undefined) for (const spec of Object.values(object(pkg.requires))) dependencySpec(spec);
    if (typeof pkg.version === 'string') dependencySpec(pkg.version);
  };
  if (lock.packages !== undefined) for (const item of Object.values(object(lock.packages))) inspect(item);
  else if (lock.lockfileVersion === 1 && lock.dependencies !== undefined) for (const item of Object.values(object(lock.dependencies))) inspect(item);
  else fail('INVALID_DEPENDENCY', 'The npm dependency lock is invalid.');
}

export class PluginInstaller {
  readonly maxArchiveBytes = MAX_ARCHIVE_BYTES;
  private readonly options: PluginInstallerOptions;
  private readonly fetcher: typeof fetch;
  private readonly prepared = new Map<string, Prepared>();
  private preparing = 0;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(options: PluginInstallerOptions) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
  }

  private directories() {
    mkdirSync(this.options.home, { recursive: true });
    const home = realpathSync(this.options.home);
    const packages = join(home, 'plugin-packages');
    const staging = join(packages, '.staging');
    for (const path of [packages, staging]) {
      mkdirSync(path, { recursive: true });
      if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) fail('INSTALL_DIRECTORY', 'The plugin installation directory must not be a link.');
    }
    return { home, packages, staging };
  }

  private async response(address: string): Promise<Response> {
    let url = new URL(address);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password) fail('INVALID_SOURCE', 'Plugin sources must use HTTPS without embedded credentials.');
      const response = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json, application/json, application/octet-stream', 'user-agent': 'orrery-plugin-installer' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) fail('DOWNLOAD_FAILED', 'The plugin download redirected too many times.');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); fail('DOWNLOAD_FAILED', `The plugin source returned HTTP ${response.status}.`); }
      return response;
    }
    return fail('DOWNLOAD_FAILED', 'Could not download the plugin package.');
  }

  private async download(address: string, limit = MAX_ARCHIVE_BYTES): Promise<Buffer> {
    const response = await this.response(address);
    const length = Number(response.headers.get('content-length'));
    if (length > limit) { await response.body?.cancel(); fail('PACKAGE_TOO_LARGE', 'The plugin download exceeds the size limit.'); }
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (!response.body) fail('DOWNLOAD_FAILED', 'The plugin download was empty.');
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) fail('PACKAGE_TOO_LARGE', 'The plugin download exceeds the size limit.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async metadata(address: string): Promise<Record<string, unknown>> {
    return object(JSON.parse((await this.download(address, 4 * 1024 * 1024)).toString('utf8')));
  }

  private async source(input: InstallInput): Promise<{ bytes: Buffer; source: InstallSource; subdirectory?: string }> {
    if ('bytes' in input) {
      if (!(input.bytes instanceof Uint8Array) || typeof input.filename !== 'string' || !input.filename) fail('INVALID_SOURCE', 'Choose a ZIP or tgz plugin package.');
      if (input.bytes.length > MAX_ARCHIVE_BYTES) fail('PACKAGE_TOO_LARGE', 'The plugin package exceeds the download size limit.');
      return { bytes: Buffer.from(input.bytes), source: { kind: 'upload', requested: basename(input.filename), resolved: basename(input.filename) } };
    }
    if (typeof input.source !== 'string' || !input.source.trim() || input.source.length > 2048) fail('INVALID_SOURCE', 'Enter a GitHub URL or npm package name.');
    const requested = input.source.trim();
    if (/^https:\/\//i.test(requested)) {
      const url = new URL(requested);
      if (url.username || url.password) fail('INVALID_SOURCE', 'Plugin sources must not contain embedded credentials.');
      if (url.hostname === 'github.com') {
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const [owner, rawRepo, action, ...rest] = parts;
        const repo = rawRepo?.replace(/\.git$/, '');
        if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) fail('INVALID_SOURCE', 'Invalid GitHub repository URL.');
        if (action === 'archive' || action === 'releases') {
          return { bytes: await this.download(requested), source: { kind: 'github', requested, resolved: requested } };
        }
        const api = `https://api.github.com/repos/${owner}/${repo}`;
        let ref: string;
        let sha: string;
        let subdirectory: string | undefined;
        if (action === 'tree' && rest.length) {
          const matches: { ref: string; sha: string }[] = [];
          for (const kind of ['heads', 'tags']) {
            const rows = JSON.parse((await this.download(`${api}/git/matching-refs/${kind}/${encodeURIComponent(rest[0])}`, 4 * 1024 * 1024)).toString('utf8'));
            if (!Array.isArray(rows)) fail('INVALID_SOURCE', 'Could not resolve the GitHub tree reference.');
            for (const item of rows) {
              const name = typeof item?.ref === 'string' ? item.ref.replace(`refs/${kind}/`, '') : '';
              if (name && (rest.join('/') === name || rest.join('/').startsWith(name + '/')) && /^[a-f0-9]{40}$/i.test(item?.object?.sha)) matches.push({ ref: name, sha: item.object.sha });
            }
          }
          const selected = matches.sort((a, b) => b.ref.length - a.ref.length)[0];
          if (!selected) fail('INVALID_SOURCE', 'The GitHub branch or tag was not found.');
          ref = selected.ref;
          sha = selected.sha;
          const directory = rest.join('/').slice(ref.length).replace(/^\//, '');
          subdirectory = directory ? archivePath(directory) : undefined;
        } else if (action === undefined) {
          const info = await this.metadata(api);
          if (typeof info.default_branch !== 'string') fail('INVALID_SOURCE', 'The GitHub repository has no default branch.');
          ref = info.default_branch;
          const commit = await this.metadata(`${api}/commits/${encodeURIComponent(ref)}`);
          if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commit.sha)) fail('INVALID_SOURCE', 'Could not resolve the GitHub revision.');
          sha = commit.sha;
        } else return fail('INVALID_SOURCE', 'Use a GitHub repository, tree or archive URL.');
        const resolved = `https://codeload.github.com/${owner}/${repo}/zip/${sha}`;
        return { bytes: await this.download(resolved), source: { kind: 'github', requested, resolved, version: sha }, subdirectory };
      }
      return { bytes: await this.download(requested), source: { kind: 'upload', requested, resolved: requested } };
    }
    const spec = new RegExp(`^(${PACKAGE_NAME})(?:@([a-zA-Z0-9][a-zA-Z0-9.+_-]*))?$`).exec(requested.replace(/^npm:/, ''));
    if (!spec) fail('INVALID_SOURCE', 'Use a public npm package name with an optional exact version or tag.');
    const metadata = await this.metadata(`${REGISTRY}/${encodeURIComponent(spec[1])}/${encodeURIComponent(spec[2] ?? 'latest')}`);
    const dist = object(metadata.dist);
    if (typeof metadata.version !== 'string' || typeof dist.tarball !== 'string') fail('INVALID_SOURCE', 'The npm registry did not return a package version.');
    const bytes = await this.download(dist.tarball);
    const integrity = typeof dist.integrity === 'string' ? /(?:^|\s)(sha512|sha384|sha256)-([A-Za-z0-9+/]+=*)(?:\s|$)/.exec(dist.integrity) : null;
    const digest = integrity ? createHash(integrity[1]).update(bytes).digest() : typeof dist.shasum === 'string' && /^[a-f0-9]{40}$/i.test(dist.shasum) ? createHash('sha1').update(bytes).digest() : null;
    const expected = integrity ? Buffer.from(integrity[2], 'base64') : typeof dist.shasum === 'string' ? Buffer.from(dist.shasum, 'hex') : null;
    if (!digest || !expected || digest.length !== expected.length || !timingSafeEqual(digest, expected)) fail('INTEGRITY_FAILED', 'The npm package integrity check failed.');
    return { bytes, source: { kind: 'npm', requested, resolved: `${spec[1]}@${metadata.version}`, version: metadata.version } };
  }

  async prepare(input: InstallInput): Promise<InstallPreview> {
    const roots = this.directories();
    for (const [id, job] of this.prepared) if (Date.now() - job.createdAt > PREVIEW_TTL_MS) await this.cancel(id);
    if (this.prepared.size + this.preparing >= 4) fail('TOO_MANY_INSTALLS', 'Finish or cancel an existing plugin installation first.');
    const id = randomUUID();
    const staging = join(roots.staging, id);
    mkdirSync(staging, { mode: 0o700 });
    this.preparing++;
    try {
      const downloaded = await this.source(input);
      const files = await unpackPlugin(downloaded.bytes, staging);
      const first = files[0].split('/')[0];
      const wrapper = files.every((file) => file.startsWith(first + '/')) ? first + '/' : '';
      const candidates = files.filter((file) => file === MANIFEST || file.endsWith('/' + MANIFEST))
        .map((file) => file.slice(wrapper.length))
        .filter((file) => !downloaded.subdirectory || file.startsWith(downloaded.subdirectory + '/'));
      const rootManifest = downloaded.subdirectory ? `${downloaded.subdirectory}/${MANIFEST}` : MANIFEST;
      const selected = input.manifestPath === undefined
        ? candidates.includes(rootManifest) ? rootManifest : candidates.length === 1 ? candidates[0] : undefined
        : archivePath(input.manifestPath);
      if (!selected || !candidates.includes(selected)) {
        if (candidates.length > 1) throw new PluginInstallError('MANIFEST_SELECTION_REQUIRED', 'Choose which plugin in the archive to install.', candidates);
        fail('INVALID_PACKAGE', 'The archive does not contain the selected orrery-plugin.json.');
      }
      const manifestFile = resolve(staging, wrapper + selected);
      const directory = resolve(manifestFile, '..');
      const manifest = manifestAt(directory);
      if (this.options.knownPluginIds.includes(manifest.id)) fail('PLUGIN_CONFLICT', 'This plugin ID belongs to a built-in plugin.');
      packageDependencies(directory);
      const preview: InstallPreview = { id, manifest, source: downloaded.source, digest: treeDigest(directory), manifestPath: selected, restartRequired: true };
      this.prepared.set(id, { preview, staging, directory, createdAt: Date.now() });
      return structuredClone(preview);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (error instanceof PluginInstallError) throw error;
      throw new PluginInstallError('INVALID_PACKAGE', error instanceof Error ? error.message : 'Could not prepare the plugin package.');
    } finally {
      this.preparing--;
    }
  }

  private npm(directory: string, packageLockOnly: boolean): Promise<void> {
    if (!this.options.npmCli || !isAbsolute(this.options.npmCli) || !existsSync(this.options.npmCli)) fail('NPM_UNAVAILABLE', 'The bundled npm CLI is unavailable.');
    const roots = this.directories();
    const config = join(roots.staging, `npm-user-${randomUUID()}.npmrc`);
    const globalConfig = join(roots.staging, `npm-global-${randomUUID()}.npmrc`);
    for (const path of [config, globalConfig]) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    const args = [this.options.npmCli, 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--bin-links=false',
      '--registry=' + REGISTRY, '--userconfig=' + config, '--globalconfig=' + globalConfig, '--cache=' + join(roots.packages, '.npm-cache'),
      '--git=' + config + '.git-disabled', '--workspaces=false',
      ...(packageLockOnly ? ['--package-lock-only'] : [])];
    return new Promise<void>((done, reject) => {
      const child = spawn(this.options.nodePath ?? process.execPath, args, { cwd: directory, env: externalEnvironment(process.env),
        shell: false, windowsHide: true, stdio: 'ignore' });
      let timer: NodeJS.Timeout;
      let timedOut = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const path of [config, globalConfig]) rmSync(path, { force: true });
        if (error) reject(error); else done();
      };
      child.once('error', () => finish(new PluginInstallError('DEPENDENCIES_FAILED', 'Could not start the bundled npm CLI.')));
      child.once('exit', (code) => finish(timedOut
        ? new PluginInstallError('DEPENDENCIES_FAILED', 'npm dependency installation timed out.')
        : code === 0 ? undefined : new PluginInstallError('DEPENDENCIES_FAILED', 'npm could not install the plugin dependencies with scripts disabled.')));
      timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    });
  }

  async confirm(id: string, grants: InstallGrants): Promise<{ pluginId: string; version: string; restartRequired: true }> {
    const operation = this.serial.then(async () => {
      const job = this.prepared.get(id);
      if (!job || Date.now() - job.createdAt > PREVIEW_TTL_MS) fail('PREVIEW_EXPIRED', 'Prepare this plugin package again.');
      const currentManifest = manifestAt(job.directory);
      if (treeDigest(job.directory) !== job.preview.digest) fail('PACKAGE_CHANGED', 'The prepared package changed. Prepare it again before confirming.');
      const allowed = grantsOf(grants, currentManifest);
      if (packageDependencies(job.directory)) {
        if (['npm-shrinkwrap.json', 'package-lock.json'].some((name) => existsSync(join(job.directory, name)))) checkDependencyLock(job.directory);
        await this.npm(job.directory, true);
        checkDependencyLock(job.directory);
        await this.npm(job.directory, false);
        manifestAt(job.directory);
        treeDigest(job.directory);   // installed dependencies must still fit the regular-file and size limits
      }
      const roots = this.directories();
      const file = join(roots.home, 'external-plugins.json');
      const config = existsSync(file) ? jsonFile(file) : { plugins: [] };
      if (Object.keys(config).some((key) => key !== 'plugins') || !Array.isArray(config.plugins)) fail('CONFIG_INVALID', 'The existing external plugin configuration is invalid.');
      const existing = readExternalPlugins(roots.home, this.options.knownPluginIds);
      if (existing.trusted?.some((entry) => entry.manifest.id === currentManifest.id)) {
        fail('PLUGIN_CONFLICT', 'This plugin ID belongs to a full-trust registration.');
      }
      const ids = new Set([...this.options.knownPluginIds, ...existing.installations.map((item) => item.manifest.id)]);
      if ((currentManifest.requires ?? []).some((dependency) => dependency === currentManifest.id || !ids.has(dependency))) fail('MISSING_DEPENDENCY', 'A required Orrery plugin is not installed.');
      const records = config.plugins.filter((item) => {
        const registration = object(item);
        if (registration.trust !== undefined) return true;
        const path = registration.manifest;
        if (typeof path !== 'string' || !isAbsolute(path)) return true;
        try { return parseExternalManifest(jsonFile(path)).id !== currentManifest.id; } catch { return true; }
      });
      if (records.length >= 16) fail('PLUGIN_LIMIT', 'At most 16 external plugins may be registered.');
      const parent = join(roots.packages, currentManifest.id);
      mkdirSync(parent, { recursive: true });
      if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) fail('INSTALL_DIRECTORY', 'The plugin directory must not be a link.');
      const destination = join(parent, `${currentManifest.version}-${randomUUID()}`);
      const record: Registration = { manifest: join(destination, MANIFEST), ...allowed };
      const data = JSON.stringify({ plugins: [...records, record] }, null, 2) + '\n';
      if (Buffer.byteLength(data) > 64 * 1024) fail('CONFIG_INVALID', 'The external plugin configuration exceeds 64 KiB.');
      const temporary = `${file}.${randomUUID()}.tmp`;
      renameSync(job.directory, destination);
      try {
        writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, file);
      } catch (error) {
        rmSync(temporary, { force: true });
        renameSync(destination, job.directory);
        throw error;
      }
      this.prepared.delete(id);
      rmSync(job.staging, { recursive: true, force: true });
      return { pluginId: currentManifest.id, version: currentManifest.version, restartRequired: true as const };
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  async cancel(id: string): Promise<void> {
    const operation = this.serial.then(() => {
      const job = this.prepared.get(id);
      if (!job) return;
      const roots = this.directories();
      confined(roots.staging, job.staging);
      if (lstatSync(job.staging).isSymbolicLink() || realpathSync(job.staging) !== job.staging) fail('INSTALL_DIRECTORY', 'The staging directory changed.');
      rmSync(job.staging, { recursive: true, force: true });
      this.prepared.delete(id);
    });
    this.serial = operation.catch(() => {});
    await operation;
  }
}
