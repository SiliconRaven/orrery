// Composition root: the only module that imports everything.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { registries } from './adapters/index.ts';
import { API_TOKEN_RE, dbModeOf, disabledPluginsOf, intEnv, readDisabledPlugins, REPO_ROOT, resolveConfig, skillsDirOf, writeDisabledPlugins } from './config.ts';
import { Hub, type Limits } from './core/hub.ts';
import { readExternalPlugins } from './core/external-plugin-config.ts';
import { ExternalPlugins } from './core/external-plugins.ts';
import { PluginHost, type OfficialPlugin } from './core/plugin.ts';
import { PluginSettings } from './core/plugin-settings.ts';
import { Store, type DbMode } from './core/store.ts';
import { ToolListMemory } from './core/tool-list.ts';
import type { NativeAdapter } from './core/types.ts';
import { officialPlugins } from './plugins/index.ts';
import { handleBridge } from './mcp/bridge.ts';
import { handleMcp, toolLists } from './mcp/server.ts';
import { cacheToolFingerprints, fingerprintsOf } from './mcp/tool-fingerprint.ts';
import { handleWeb, type WebControl } from './web/server.ts';

export { REPO_ROOT };

export interface StartOptions {
  dbPath: string;
  port: number;               // 0 = pick a free port
  limits?: Partial<Limits>;
  /** Default: one of each native factory. Tests pass only their own mock adapters. */
  nativeAdapters?: Record<string, NativeAdapter>;
  /** Also register the test harness `mock` in the default registry (ORRERY_MOCK=1). */
  withMock?: boolean;
  /** Where the bridge secret and the discovery file hub.json live. Default: .orrery in the user's home directory. */
  home?: string;
  /** When given, POST /api/shutdown answers 202 and then calls it (main.ts: close, then exit). Without it, 404. */
  onShutdown?: () => void;
  /** The user's shared skills folder for the `$` picker (read-only). Absent: no skills (tests never read the real one). */
  skillsDir?: string;
  /** Preset avatar names the Hub accepts. Absent: read src/web/public/avatars at start-up (tests inject their own). */
  avatarPresets?: string[];
  /** The web API token (ORRERY_API_TOKEN). Absent: <home>/api-token, made on the first start. Never logged. */
  apiToken?: string;
  /** The registered plugins. Default: the official registry (tests add their own). */
  plugins?: OfficialPlugin[];
  /** Plugin ids switched off by ORRERY_DISABLED_PLUGINS, on top of <home>/plugins.json. Their tables stay; see docs/plugins.md. */
  disabledPlugins?: string[];
  /** How the database is opened (ORRERY_DB_JOURNAL, ORRERY_TEST_DB_SYNC). Absent: WAL with every commit flushed to disk. */
  dbMode?: DbMode;
}

/**
 * A secret kept in a file: made once, then reused on every start. Never logged. The bridge secret (the user's Codex
 * MCP config holds it) and the web API token (the launcher reads it) both live this way.
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
export async function writeDiscovery(home: string, data: { url: string; secret: string; pid: number },
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
 */
function checkRequest(req: IncomingMessage, path: string, port: number): { status: number; error: string } | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? '')) return { status: 403, error: 'forbidden host' };
  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return { status: 403, error: 'forbidden origin' };
  if (path.startsWith('/api/') && req.method !== 'GET') {
    const type = path === '/api/files' ? 'application/octet-stream' : 'application/json';
    const given = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (given !== type) return { status: 415, error: `content-type must be ${type}` };
  }
  return null;
}

export async function startHub(opts: StartOptions) {
  const home = resolve(opts.home ?? join(homedir(), '.orrery'));
  const dbPath = resolve(opts.dbPath);
  let opened: { hub: Hub; store: Store; secret: string; control: WebControl } | undefined;   // set once the port is held
  let closing: Promise<void> | undefined;
  let port = 0;   // known after listen
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const rejected = checkRequest(req, path, port);
    if (rejected) {
      res.writeHead(rejected.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: rejected.error }));
      return;
    }
    if (!opened) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'hub is starting' }));
      return;
    }
    const { hub, secret, control } = opened;
    const handled = path === '/mcp' ? handleMcp(hub, secret, req, res)
      : path.startsWith('/bridge/') ? handleBridge(hub, secret, req, res)
      : handleWeb(hub, req, res, control);
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
  try {
    const build = <T>(factories: Record<string, () => T>) => Object.fromEntries(Object.entries(factories).map(([k, make]) => [k, make()]));
    const factories = registries(opts.withMock ?? false);
    const nativeAdapters = opts.nativeAdapters ?? build(factories);
    mkdirSync(home, { recursive: true });
    const secret = loadSecret(join(home, 'secret'), /^[0-9a-f]{64}$/, () => randomBytes(32).toString('hex'));
    const apiToken = opts.apiToken ?? loadSecret(join(home, 'api-token'), API_TOKEN_RE, () => randomBytes(32).toString('base64url'));
    const base = opts.plugins ?? officialPlugins;
    const external = readExternalPlugins(home, base.map((p) => p.id));
    // A broken plugin entry no longer stops the Hub: it is skipped (and logged), and so is anything requiring it.
    for (const failure of external.failures) console.error(`external plugin skipped: ${failure.error}`);
    const registered = [...base, ...external.installations.map((p) => p.manifest)];
    const registeredIds = new Set(registered.map((p) => p.id));
    const envDisabled = opts.disabledPlugins ?? [];
    const fileDisabled = readDisabledPlugins(home);
    // An id only the file names (a plugin this version does not have) stays in the file and is skipped; a typo in the
    // variable still stops the start. A skipped plugin may still be named by the variable: keep that flag, but do not
    // hand the id to PluginHost, which would refuse an id it does not know.
    const skippedIds = new Set(external.failures.flatMap((f) => (f.manifest ? [f.manifest.id] : [])));
    const pluginHost = new PluginHost(registered, [
      ...envDisabled.filter((id) => registeredIds.has(id) || !skippedIds.has(id)),
      ...fileDisabled.filter((id) => registeredIds.has(id)),
    ]);
    store = new Store(opts.dbPath, pluginHost, opts.dbMode);
    if (store.journalWarning) console.error(store.journalWarning);
    // Attachments live in <home>/files; native members attach only what they put in <home>/outbox, never orrery's
    // own files under any name (docs/files.md).
    const files = {
      dir: join(home, 'files'), outbox: join(home, 'outbox'),
      protectedFiles: [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`, join(home, 'secret'), join(home, 'api-token'), join(home, 'hub.json'), join(home, 'tool-list.json')],
    };
    const hub = new Hub({
      store, nativeAdapters, limits: opts.limits, files,
      skillsDir: opts.skillsDir, avatarPresets: opts.avatarPresets, toolList: new ToolListMemory(join(home, 'tool-list.json')),
    });
    externalPlugins = new ExternalPlugins(external.installations, store, pluginHost.enabled.map((p) => p.id), undefined, external.failures, hub);
    if (external.installations.length) {
      externalPlugins.baselineMembers(hub.listMembers());
      hub.subscribe((event) => externalPlugins?.publish(event));
    }
    const getToolLists = cacheToolFingerprints(() => toolLists(hub, secret, `${url}/mcp`));
    const control: WebControl = {
      health: () => ({ app: 'orrery', pid: process.pid, state: closing ? 'stopping' : 'running', home, db: dbPath, executable: process.execPath }),
      shutdown: opts.onShutdown,
      // Cookies are not port-scoped: the port in the name keeps two Hubs open in one browser apart.
      auth: { token: apiToken, cookie: `orrery_${port}` },
      toolFingerprints: () => getToolLists().then(fingerprintsOf),
      plugins: new PluginSettings(pluginHost, envDisabled, fileDisabled, (disabled) => writeDisabledPlugins(home, disabled)),
      externalPlugins,
    };
    opened = { hub, store, secret, control };
    await writeDiscovery(home, { url, secret, pid: process.pid });
    discoveryWritten = true;
    // The members are taken here, with no await before hub.start: one added while the lists are computed is not told.
    const checkToolList = hub.checkToolList();
    hub.start();
    // Not awaited: deliveries begin now; one that starts before the comparison simply carries no tool-update hint.
    void getToolLists().then(checkToolList)
      .catch((e) => console.error('tool list check failed:', e instanceof Error ? e.message : e));
    await externalPlugins.start();
  } catch (e) {
    const failedHub = opened?.hub;
    opened = undefined;
    await externalPlugins?.close().catch(() => {});
    await failedHub?.close().catch(() => {});
    try { store?.close(); } catch { /* preserve the startup error */ }
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    if (discoveryWritten) removeDiscovery(home, url);
    throw e;
  }
  const { hub } = opened;
  const ready = opened.store;
  return {
    url,
    hub,
    store: ready,
    home,
    /**
     * Once only: Ctrl+C, the web exit and tests share it; /api/health says 'stopping' from the first call until the
     * server closes. hub.json goes last, so a launcher keeps finding this Hub (stopping) until the data is released.
     * Requests that reach the closed store meanwhile may fail or be disconnected; the process does not crash.
     */
    close(): Promise<void> {
      closing ??= (async () => {
        await externalPlugins?.close();
        await hub.close();
        ready.close();
        server.closeAllConnections();
        await new Promise<void>((ok) => server.close(() => ok()));
        removeDiscovery(home, url);
      })();
      return closing;
    },
  };
}

if (import.meta.main) {
  const config = resolveConfig(process.env);
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
    apiToken: config.apiToken,
    withMock: process.env.ORRERY_MOCK === '1',
    skillsDir: skillsDirOf(process.env),
    disabledPlugins: disabledPluginsOf(process.env),
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
