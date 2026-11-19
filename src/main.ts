// Composition root: the only module that imports everything.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { registries } from './adapters/index.ts';
import { automaticUpgradeBackup } from './backup.ts';
import { SIGNATURE_HEADER } from './bridge-protocol.ts';
import { API_TOKEN_RE, dbModeOf, defaultRegistryDir, disabledPluginsOf, HUB_CLOSE_PLUGIN_GRACE_MS, intEnv, readPluginsFile, REPO_ROOT, resolveConfig, safeModeOf, skillsDirOf, updateChecksOf,
  writeDisabledPlugins, writePluginsFile } from './config.ts';
import { AppExtensions } from './core/app-extensions.ts';
import { loadAvatarPresets } from './core/avatars.ts';
import { Hub, type Limits } from './core/hub.ts';
import { HOST_API_VERSION, readExternalPlugin, readExternalPlugins } from './core/external-plugin-config.ts';
import { ExternalPlugins, type LifecycleOptions } from './core/external-plugins.ts';
import type { CommandLimits } from './core/external-plugin-commands.ts';
import { PluginHost, type OfficialPlugin } from './core/plugin.ts';
import { PluginSettings } from './core/plugin-settings.ts';
import { Store, type DbMode } from './core/store.ts';
import { TrustedPlugins } from './core/trusted-plugins.ts';
import { ToolListMemory } from './core/tool-list.ts';
import type { NativeAdapter } from './core/types.ts';
import { officialPlugins } from './plugins/index.ts';
import { registerHub } from './hub-registry.ts';
import { handleBridge } from './mcp/bridge.ts';
import { createBridgeAuthenticator } from './mcp/bridge-auth.ts';
import { handleMcp, toolLists } from './mcp/server.ts';
import { cacheToolFingerprints, fingerprintsOf } from './mcp/tool-fingerprint.ts';
import { handleWeb, type WebControl } from './web/server.ts';
import { PluginInstaller } from './plugin-install.ts';
import { UpdateChecker } from './update-check.ts';

export { REPO_ROOT };

export interface StartOptions {
  dbPath: string;
  port: number;               // 0 = pick a free port
  limits?: Partial<Limits>;
  /** Default: one of each native factory. Tests pass only what they need. */
  nativeAdapters?: Record<string, NativeAdapter>;
  /** Also register the demo harness `mock` in the default registry (ORRERY_MOCK=1). Ignored with `nativeAdapters`. */
  withMock?: boolean;
  /** Where the bridge secret and the discovery file hub.json live. Default: .orrery in the user's home directory. */
  home?: string;
  registryDir: string;        // CLI defaults to the account registry; tests pass an isolated directory
  secondary?: boolean;
  name?: string;
  /** When given, POST /api/shutdown answers 202 and then calls it (main.ts: close, then exit). Without it, 404. */
  onShutdown?: () => void;
  /** The user's shared skills folder for the `$` picker, and where 技能与 MCP installs skills. Absent: no skills (tests never read the real one). */
  skillsDir?: string;
  /**
   * The home folder whose apps 技能与 MCP lists (read-only), and the environment for the location overrides
   * (CODEX_HOME …). Absent: no app is listed (tests pass a fixture home and leave appEnv empty).
   */
  appHome?: string;
  appEnv?: Record<string, string | undefined>;
  /** Optional fixture directory for listing and serving preset avatars. */
  avatarDir?: string;
  /** The web API token (ORRERY_API_TOKEN). Absent: <home>/api-token, made on the first start. Never logged. */
  apiToken?: string;
  /** The registered plugins. Default: the official registry (tests add their own). */
  plugins?: OfficialPlugin[];
  /** Plugin ids switched off by ORRERY_DISABLED_PLUGINS, on top of <home>/plugins.json. Their tables stay; see docs/plugins.md. */
  disabledPlugins?: string[];
  /** How the database is opened (ORRERY_DB_JOURNAL, ORRERY_TEST_DB_SYNC). Absent: WAL with every commit flushed to disk. */
  dbMode?: DbMode;
  /** Plugin command run limits (docs/external-plugins.md「命令」); tests shorten them. Absent: COMMAND_LIMITS. */
  pluginCommandLimits?: Partial<CommandLimits>;
  /** ORRERY_SAFE_MODE=1: import no full-trust plugin this start (docs/external-plugins.md「完全信任的插件」). */
  safeMode?: boolean;
  /** Tests inject providers. The CLI opts into background network checks on startup. */
  updateChecker?: UpdateChecker;
  enableUpdateChecks?: boolean;
  pluginInstaller?: WebControl['pluginInstaller'];
  /** How long a full-trust entry may take to import and answer its default export; tests shorten LOAD_TIMEOUT_MS. */
  trustedLoadTimeoutMs?: number;
  /** Third-party plugin lifecycle timings (backoff, window, debounce, grace, watch); tests shorten them. Absent: the defaults. */
  pluginLifecycle?: Pick<LifecycleOptions, 'backoffMs' | 'restartWindowMs' | 'debounceMs' | 'shutdownGraceMs' | 'watch' | 'toolTimeoutMs' | 'toolRecordMs' | 'uiTimeoutMs' | 'now'>;
}

/**
 * A per-home web API token, made once and reused on every start. The launcher reads it and it is never logged.
 */
function loadSecret(file: string, valid: RegExp, make: () => string): string {
  try {
    const s = readFileSync(file, 'utf8').trim();
    if (valid.test(s)) return s;
  } catch { /* first start */ }
  const s = make();
  writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}

/** Codes Windows gives a rename onto a file another process has open (a bridge or launcher reading it, a scanner). */
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Waits between rename attempts: about 1.5 s in all, far longer than one read of a small file. */
export const DISCOVERY_RETRY_MS = [10, 20, 40, 80, 160, 300, 400, 500];

/**
 * Writes hub.json whole (temp file + rename), so a bridge never reads half of it. On Windows the rename fails with
 * EPERM while another process has hub.json open (bridges re-read it on every reconnect), so a busy rename is retried
 * a few times; after the last try the temp file is removed and the rename's own error is thrown (its code, path and
 * dest name the file), with the number of tries added to its message.
 */
export async function writeDiscovery(home: string, data: { url: string; secret: string; pid: number; hubId?: string },
  rename: (from: string, to: string) => void = renameSync, delays: readonly number[] = DISCOVERY_RETRY_MS): Promise<void> {
  const tmp = join(home, `hub.json.${process.pid}.tmp`);
  const file = join(home, 'hub.json');
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!BUSY_CODES.has(code) || attempt >= delays.length) {
        try { rmSync(tmp, { force: true }); } catch { /* keep the rename error */ }
        if (e instanceof Error) {
          e.message += ` (writing ${file}: ${code || 'error'} after ${attempt + 1} tries)`;
          throw e;
        }
        throw new Error(`could not write ${file} after ${attempt + 1} tries`, { cause: e });
      }
      await new Promise((ok) => setTimeout(ok, delays[attempt]));
    }
  }
}

/** Removes hub.json if it still describes this Hub (another Hub may have started since). */
function removeDiscovery(home: string, url: string): void {
  const file = join(home, 'hub.json');
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d.url === url && d.pid === process.pid) rmSync(file);
  } catch { /* gone or unreadable: leave it */ }
}

/**
 * Keeps websites in the user's browser out of the local API: a wrong Host means DNS rebinding,
 * a foreign Origin or a non-JSON write means a cross-site request (JSON forces a CORS preflight we never answer).
 * The one raw-body write, POST /api/files, takes application/octet-stream only: not a CORS-safelisted type either,
 * so it needs the same preflight (and its x-orrery-filename header does too).
 * A plugin UI's files (GET /plugin-ui/...) with `Origin: null` are the one exception to the Origin check: the frame is a
 * sandboxed, opaque-origin document, so its module scripts and fonts arrive with exactly that. They need no login,
 * change nothing and are reachable only by an unguessable frame id (docs/external-plugins.md「网页界面」); the Host check
 * stays. `path` is the URL's parsed pathname (`..` resolved), the same one the request is routed by.
 */
function checkRequest(req: IncomingMessage, path: string, port: number): { status: number; error: string } | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? '')) return { status: 403, error: 'forbidden host' };
  const origin = req.headers.origin;
  const frameFile = req.method === 'GET' && path.startsWith('/plugin-ui/') && origin === 'null';
  if (origin !== undefined && !frameFile && !hosts.some((h) => origin === `http://${h}`)) return { status: 403, error: 'forbidden origin' };
  if (path.startsWith('/api/') && req.method !== 'GET') {
    // Skill and plugin installs accept either JSON or raw archive bytes.
    const types = path === '/api/files' ? ['application/octet-stream']
      : path === '/api/extensions/skills/install' || path === '/api/plugin-installs/prepare'
        ? ['application/json', 'application/octet-stream'] : ['application/json'];
    const given = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!types.includes(given)) return { status: 415, error: `content-type must be ${types.join(' or ')}` };
  }
  return null;
}

export async function startHub(opts: StartOptions) {
  const home = resolve(opts.home ?? join(homedir(), '.orrery'));
  const dbPath = resolve(opts.dbPath);
  const registryDir = resolve(opts.registryDir);
  let registration: Awaited<ReturnType<typeof registerHub>> | undefined;
  let opened: { hub: Hub; store: Store; secret: string; control: WebControl; authenticate: ReturnType<typeof createBridgeAuthenticator> } | undefined;
  let closing: Promise<void> | undefined;
  let port = 0;   // known after listen
  const server = createServer((req, res) => {
    // Parsed as handleWeb parses it, so the checks and the routing look at the same path (`/plugin-ui/../api/x` is /api/x).
    let path: string;
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad request target' }));
      return;
    }
    const rejected = checkRequest(req, path, port);
    if (rejected) {
      res.writeHead(rejected.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: rejected.error }));
      return;
    }
    if (!opened) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'hub is starting' }));
      return;
    }
    const { hub, secret, control, authenticate } = opened;
    const handled = (async () => {
      if (path !== '/mcp' && !path.startsWith('/bridge/')) return handleWeb(hub, req, res, control);
      const auth = await authenticate(req);
      if (auth.kind === 'rejected' && (req.headers[SIGNATURE_HEADER] !== undefined || path === '/bridge/whoami')) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized', reason: auth.reason ?? 'mac' }));
        return;
      }
      if (path === '/bridge/whoami') {
        if (auth.kind !== 'signed') { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
        const { hubId, claim, name, role } = registration!.record;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify({ hubId, claim, name, role }));
        return;
      }
      const authorized = auth.kind !== 'rejected';
      return path === '/mcp' ? handleMcp(hub, secret, req, res, authorized) : handleBridge(hub, secret, req, res, authorized);
    })();
    handled.catch((e) => {
      console.error('request failed:', e instanceof Error ? e.message : e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // The port is the single-instance lock: a second Hub on the same port fails here, before it touches the secret,
  // the database (the Hub constructor requeues 'running' deliveries) or hub.json.
  await new Promise<void>((ok, fail) => server.once('error', fail).listen(opts.port, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  let store: Store | undefined;
  let discoveryWritten = false;
  let externalPlugins: ExternalPlugins | undefined;
  let updates: UpdateChecker | undefined;
  try {
    const build = <T>(factories: Record<string, () => T>) => Object.fromEntries(Object.entries(factories).map(([k, make]) => [k, make()]));
    const nativeAdapters = opts.nativeAdapters ?? build(registries(opts.withMock ?? false));
    mkdirSync(home, { recursive: true });
    registration = await registerHub(registryDir, { home, url, name: opts.name ?? 'Orrery', secondary: opts.secondary });
    const { secret, record, keyPath } = registration;
    const apiToken = opts.apiToken ?? loadSecret(join(home, 'api-token'), API_TOKEN_RE, () => randomBytes(32).toString('base64url'));
    const base = opts.plugins ?? officialPlugins;
    const builtInIds = base.map((p) => p.id);
    updates = opts.updateChecker ?? new UpdateChecker({ home,
      currentVersion: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version });
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const pluginInstaller = opts.pluginInstaller ?? new PluginInstaller({ home, knownPluginIds: builtInIds,
      ...(existsSync(npmCli) ? { npmCli } : {}) });
    const external = readExternalPlugins(home, builtInIds);
    // A broken plugin entry no longer stops the Hub: it is skipped (and logged), and so is anything requiring it.
    for (const failure of external.failures) console.error(`external plugin skipped: ${failure.error}`);
    const envDisabled = opts.disabledPlugins ?? [];
    const pluginsFile = readPluginsFile(home);
    const fileDisabled = pluginsFile.disabled;
    // Full-trust plugins (docs/external-plugins.md「完全信任的插件」): which may run is decided from data alone (safe
    // mode, the confirmation in plugins.json for the entry's real path, the registration) before anything is imported;
    // only those are imported, and each that fails to load or to fit is left out with its dependents.
    const trusted = new TrustedPlugins(external.trusted ?? [], {
      safeMode: opts.safeMode ?? false,
      confirmations: () => readPluginsFile(home).trusted ?? [],
      save: (next) => writePluginsFile(home, { trusted: next }),
      loadTimeoutMs: opts.trustedLoadTimeoutMs,
    });
    const beforeTrusted = [...base, ...external.installations.map((p) => p.manifest)];
    const loadedTrusted = await trusted.load(beforeTrusted, [...new Set([...envDisabled, ...fileDisabled])],
      (file) => import(pathToFileURL(file).href), { hostApi: HOST_API_VERSION, z });
    const registered = [...beforeTrusted, ...loadedTrusted];
    const registeredIds = new Set(registered.map((p) => p.id));
    // An id only the file names (a plugin this version does not have) stays in the file and is skipped; a typo in the
    // variable still stops the start. A skipped plugin may still be named by the variable: keep that flag, but do not
    // hand the id to PluginHost, which would refuse an id it does not know.
    const skippedIds = new Set([...external.failures.flatMap((f) => (f.manifest ? [f.manifest.id] : [])), ...trusted.ids()]);
    const pluginHost = new PluginHost(registered, [
      ...envDisabled.filter((id) => registeredIds.has(id) || !skippedIds.has(id)),
      ...fileDisabled.filter((id) => registeredIds.has(id)),
    ], { fullTrust: loadedTrusted.map((p) => p.id), registeredTrusted: trusted.ids(), onSkip: (id, reason) => trusted.fail(id, reason) });
    // Back up an existing database before its first pending schema write. Keep the earliest restore point
    // protected until the upgrade finishes (docs/architecture.md「升级前备份」).
    const upgrade = automaticUpgradeBackup(dbPath, join(home, 'backups'));
    // A full-trust plugin that could not be read or loaded this start may still owe migration steps,
    // even if it does not have a migration record yet.
    const keptOut = external.failures.some((failure) => failure.trust === 'full')
      || trusted.ids().some((id) => !loadedTrusted.some((p) => p.id === id));
    store = new Store(opts.dbPath, pluginHost, opts.dbMode, undefined, { backup: () => {
      const made = upgrade.backup();
      console.log(`database backed up before the schema upgrade: ${made}`);
      return made;
    }, done: () => { if (!keptOut) upgrade.done(); } });
    if (store.journalWarning) console.error(store.journalWarning);
    // Attachments live in <home>/files; native members attach only what they put in <home>/outbox, never orrery's
    // own files under any name (docs/files.md).
    const files = {
      dir: join(home, 'files'), outbox: join(home, 'outbox'),
      protectedFiles: [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`, join(home, 'secret'), keyPath, join(home, 'api-token'), join(home, 'hub.json'), join(home, 'tool-list.json')],
    };
    const hub = new Hub({
      store, nativeAdapters, limits: opts.limits, files, bridgeHubId: record.hubId, secondary: record.role === 'secondary',
      skillsDir: opts.skillsDir, avatarPresets: opts.avatarDir ? loadAvatarPresets(opts.avatarDir) : undefined,
      toolList: new ToolListMemory(join(home, 'tool-list.json')),
    });
    const officialIds = base.map((p) => p.id);
    externalPlugins = new ExternalPlugins(external.installations, store, pluginHost.enabled.map((p) => p.id), undefined, external.failures, hub,
      opts.pluginCommandLimits, {
        ...opts.pluginLifecycle,
        // A start or restart by the user reads the registration and manifest again (docs/security.md); a plugin
        // registered after this start is not among the slots: it needs a Hub restart.
        reread: (id, directory) => readExternalPlugin(home, officialIds, id, directory),
        startRefusal: (id) => (envDisabled.includes(id) ? '这个插件由环境变量 ORRERY_DISABLED_PLUGINS 禁用，不能在页面上启动。' : null),
        officialRunning: pluginHost.enabled.filter((p) => officialIds.includes(p.id)).map((p) => p.id),
        switches: pluginsFile,
        saveSwitches: (next) => writePluginsFile(home, next),
        closeGraceMs: HUB_CLOSE_PLUGIN_GRACE_MS,
      });
    if (external.installations.length) {
      externalPlugins.baselineMembers(hub.listMembers());
      hub.subscribe((event) => externalPlugins?.publish(event));
      hub.setMessageGate(externalPlugins);
      hub.setMemberTools(externalPlugins);
      externalPlugins.onToolsChanged((clusterIds) => hub.pluginToolsChanged(clusterIds));
    }
    const getToolLists = cacheToolFingerprints(() => toolLists(hub, secret, `${url}/mcp`));
    // This start of the Hub: a restart gets a new one even when Windows hands the new process the old pid.
    const instance = record.claim;
    let allowLegacy = store.getSavedNumber('allow_plaintext_bridge') !== 0;
    const settingsStore = store;
    const control: WebControl = {
      health: () => ({ app: 'orrery', pid: process.pid, instance, state: closing ? 'stopping' : 'running', home, db: dbPath, executable: process.execPath }),
      shutdown: opts.onShutdown,
      // Cookies are not port-scoped: the port in the name keeps two Hubs open in one browser apart.
      auth: { token: apiToken, cookie: `orrery_${port}` },
      bridgeSettings: {
        snapshot: () => ({ role: record.role, allowLegacy, nativeDelivery: hub.nativeDeliveryEnabled(), keyMigrated: registration!.keyMigrated }),
        setAllowLegacy: (enabled) => {
          settingsStore.saveNumber('allow_plaintext_bridge', enabled ? 1 : 0);
          allowLegacy = enabled;
        },
        setNativeDelivery: (enabled) => hub.setSecondaryNativeDelivery(enabled),
        reveal: () => secret,
      },
      toolFingerprints: () => getToolLists().then(fingerprintsOf),
      plugins: new PluginSettings(pluginHost, envDisabled, fileDisabled, (disabled) => writeDisabledPlugins(home, disabled),
        trusted.manifests().filter((m) => !pluginHost.installed.some((p) => p.id === m.id))),
      externalPlugins,
      avatarDir: opts.avatarDir,
      updates,
      pluginInstaller,
      trusted,
      extensions: new AppExtensions({ home: opts.appHome, env: opts.appEnv, sharedDir: opts.skillsDir }),
    };
    opened = { hub, store, secret, control, authenticate: createBridgeAuthenticator(secret, record, () => allowLegacy) };
    await writeDiscovery(home, { url, secret, pid: process.pid, hubId: record.hubId });
    discoveryWritten = true;
    // The members are taken here, with no await before hub.start: one added while the lists are computed is not told.
    const checkToolList = hub.checkToolList();
    hub.start();
    // Not awaited: deliveries begin now; one that starts before the comparison simply carries no tool-update hint.
    void getToolLists().then(checkToolList)
      .catch((e) => console.error('tool list check failed:', e instanceof Error ? e.message : e));
    await externalPlugins.start();
    if (opts.enableUpdateChecks) updates.start();
  } catch (e) {
    updates?.close();
    const failedHub = opened?.hub;
    opened = undefined;
    await externalPlugins?.close().catch(() => {});
    await failedHub?.close().catch(() => {});
    try { store?.close(); } catch { /* preserve the startup error */ }
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    if (discoveryWritten) removeDiscovery(home, url);
    await registration?.close().catch(() => {});
    throw e;
  }
  const { hub } = opened;
  const ready = opened.store;
  return {
    url,
    hub,
    store: ready,
    home,
    registry: registration!.record,
    /**
     * Once only: Ctrl+C, the web exit and tests share it; /api/health says 'stopping' from the first call until the
     * server closes. hub.json goes last, so a launcher keeps finding this Hub (stopping) until the data is released.
     * Requests that reach the closed store meanwhile may fail or be disconnected; the process does not crash.
     */
    close(): Promise<void> {
      closing ??= (async () => {
        updates?.close();
        await externalPlugins?.close();
        await hub.close();
        ready.close();
        server.closeAllConnections();
        await new Promise<void>((ok) => server.close(() => ok()));
        removeDiscovery(home, url);
        await registration!.close().catch((e) => console.error('Orrery registry cleanup failed:', e instanceof Error ? e.message : e));
      })();
      return closing;
    },
  };
}

if (import.meta.main) {
  const config = resolveConfig(process.env);
  const packagedHome = process.env.APPDATA ? join(process.env.APPDATA, 'Orrery Beta', 'hub') : '';
  const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (pathKey(config.registryDir) === pathKey(defaultRegistryDir())
    && ![join(homedir(), '.orrery'), packagedHome].some((p) => pathKey(p) === pathKey(config.home))) {
    console.warn('Using the default Orrery registry with a custom home. Set ORRERY_REGISTRY to an isolated directory for development or tests.');
  }
  let app: Awaited<ReturnType<typeof startHub>> | undefined;
  let stopRequested = false;
  // Up before startHub: /api/shutdown already answers while plugins initialize. Until app exists, only note the request.
  const stop = () => {
    stopRequested = true;
    void app?.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const queueWarnMinutes = intEnv(process.env, 'ORRERY_QUEUE_WARN_MINUTES');
  app = await startHub({
    dbPath: config.dbPath,
    port: config.port,
    home: config.home,
    registryDir: config.registryDir,
    secondary: process.env.ORRERY_SECONDARY === '1',
    name: pathKey(config.home) === pathKey(packagedHome) ? 'Orrery Beta' : 'Orrery',
    apiToken: config.apiToken,
    withMock: process.env.ORRERY_MOCK === '1',
    enableUpdateChecks: updateChecksOf(process.env),
    skillsDir: skillsDirOf(process.env),
    appHome: homedir(),
    appEnv: process.env,
    disabledPlugins: disabledPluginsOf(process.env),
    safeMode: safeModeOf(process.env),
    dbMode: dbModeOf(process.env),
    limits: {
      maxHops: intEnv(process.env, 'ORRERY_MAX_HOPS'),
      maxTurnsPerChain: intEnv(process.env, 'ORRERY_MAX_TURNS_PER_CHAIN'),
      maxTurnsPerHour: intEnv(process.env, 'ORRERY_MAX_TURNS_PER_HOUR'),
      maxCoordinatorTurnsPerHour: intEnv(process.env, 'ORRERY_MAX_COORDINATOR_TURNS_PER_HOUR'),
      maxNoticeBatchesPerHour: intEnv(process.env, 'ORRERY_MAX_NOTICE_BATCHES_PER_HOUR'),
      queueWarnMs: queueWarnMinutes === undefined ? undefined : queueWarnMinutes * 60_000,
    },
    onShutdown: stop,
  });
  console.log(`orrery hub listening on ${app.url}`);
  if (stopRequested) stop();
}
