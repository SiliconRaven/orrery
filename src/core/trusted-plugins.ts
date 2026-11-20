// Full-trust third-party plugins (docs/external-plugins.md「完全信任的插件」): the user registers one with
// `"trust": "full"` in external-plugins.json and confirms it on the settings page; from the next start it runs in the
// Hub process with the official plugins' slots. This module decides, before anything is imported, which registrations
// may load, checks what a loaded entry hands back, keeps the confirmations and each plugin's state for its card, and
// serves the page module folder of a loaded one. It never imports a plugin itself: the composition root passes the
// importer.
import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { TrustedRegistration } from './external-plugin-config.ts';
import { uiSegments, UI_LIMITS } from './external-plugin-ui.ts';
import { readPluginIcon, type PluginIcon } from './plugin-icon.ts';
import { PluginHost, shortError, tablePrefixOf, type OfficialPlugin, type PluginManifest, type PluginRoute } from './plugin.ts';

/** Where a full-trust plugin's HTTP routes must live: /api/x/<id>/… */
export const routePrefix = (id: string): string => `/api/x/${id}/`;
/** The prefix its tables, indexes, triggers and views must carry: x_<id with - as _>_ (PluginHost.migrate checks it). */
export const tablePrefix = tablePrefixOf;

/** The official interface slots a full-trust plugin may fill, by the shape each must have. */
const FUNCTION_SLOTS = ['tools', 'service', 'memberRebinding', 'memberRebound', 'memberRemoved', 'clusterCreated', 'clusterPurging', 'eventSource'] as const;
const MAP_SLOTS = ['actions', 'prepare', 'queries', 'messageFields', 'refs'] as const;
const LIST_SLOTS = ['migrations', 'prepareRequired', 'managementActions'] as const;
/** Manifest fields an entry may repeat; the manifest's values always win. */
const MANIFEST_KEYS = ['id', 'version', 'name', 'description', 'details', 'requires'];
/**
 * Not open to full-trust plugins in this version: bridgeRoutes and the single-provider views the Store and the Hub build
 * on their start path (taskView, coordinatorView, envelope); the page module (webEntry) and icon are manifest data.
 */
const SINGLE = 'is not open to third-party plugins in this version (one provider at most, built on the start path)';
const REFUSED = { bridgeRoutes: 'bridgeRoutes are not open to third-party plugins', taskView: SINGLE, coordinatorView: SINGLE, envelope: SINGLE,
  webModule: 'the page module is named in the manifest (webEntry)', icon: 'the icon is named in the manifest (icon)' };
/** How long importing an entry and calling its default export may take before the plugin is skipped. */
export const LOAD_TIMEOUT_MS = 10_000;
/** A refusal decided only after the import: the card must not say none of its code ran. */
const IMPORTED_REFUSED = '已导入但被拒绝（它的顶层代码和默认导出已经运行过）：';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** One confirmation in plugins.json (config.ts TrustConfirmation): the plugin id and the real path of its Hub entry. */
export interface TrustConfirmationRecord { id: string; entry: string }

/**
 * A route whose pattern does not start with ^/api/x/<id>/ refuses the plugin. The pattern that is kept also carries
 * the prefix as a lookahead, so even an alternation (`^/api/x/a/b|/api/tasks`) can never match outside it.
 */
function checkRoute(id: string, raw: unknown, index: number): PluginRoute {
  if (!isObject(raw) || typeof raw.method !== 'string' || !METHODS.has(raw.method) || !(raw.pattern instanceof RegExp) || typeof raw.handle !== 'function') {
    throw new Error(`route ${index + 1} must be { method: GET|POST|PUT|PATCH|DELETE, pattern: RegExp, handle: function }`);
  }
  const { source, flags } = raw.pattern;
  const prefix = routePrefix(id);
  // The prefix is [a-z0-9/-] only: written as is, or with each / escaped as a regular expression literal writes it.
  if (!source.startsWith(`^${prefix}`) && !source.startsWith(`^${prefix.replaceAll('/', '\\/')}`)) {
    throw new Error(`route ${index + 1} (${source}) is outside ${prefix}: every route of a full-trust plugin must start with ^${prefix}`);
  }
  if (/[gy]/.test(flags)) throw new Error(`route ${index + 1} must not use the g or y flag`);
  return { method: raw.method, pattern: new RegExp(`^(?=${prefix})(?:${source})`, flags), handle: raw.handle as PluginRoute['handle'] };
}

/**
 * What a full-trust entry's default export handed back, as an official-plugin object under the manifest's identity.
 * Throws a readable reason for anything that is not an official slot of the right shape (the plugin is skipped).
 */
export function trustedPluginOf(manifest: { id: string; version: string; name?: string; description?: string; details?: string; requires: string[] },
  value: unknown): OfficialPlugin {
  if (!isObject(value)) throw new Error('the entry\'s default export must return an object of plugin slots');
  if (value.id !== undefined && value.id !== manifest.id) throw new Error(`the entry says it is ${JSON.stringify(value.id)}, the manifest says ${manifest.id}`);
  const plugin: Record<string, unknown> = {
    id: manifest.id, version: manifest.version, requires: manifest.requires,
    ...(manifest.name ? { name: manifest.name } : {}), ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.details ? { details: manifest.details } : {}),
  };
  for (const [key, slot] of Object.entries(value)) {
    if (MANIFEST_KEYS.includes(key) || slot === undefined) continue;
    if (Object.hasOwn(REFUSED, key)) throw new Error(`${key}: ${REFUSED[key as keyof typeof REFUSED]}`);
    if ((FUNCTION_SLOTS as readonly string[]).includes(key)) {
      if (typeof slot !== 'function') throw new Error(`${key} must be a function`);
    } else if ((MAP_SLOTS as readonly string[]).includes(key)) {
      if (!isObject(slot) || Object.values(slot).some((f) => typeof f !== 'function')) throw new Error(`${key} must be an object of functions`);
      plugin[key] = { ...slot };   // copies: the plugin changing its own objects later cannot change what was checked
      continue;
    } else if ((LIST_SLOTS as readonly string[]).includes(key)) {
      if (!Array.isArray(slot) || slot.some((s) => typeof s !== 'string')) throw new Error(`${key} must be an array of strings`);
      plugin[key] = [...slot];
      continue;
    } else if (key === 'routes') {
      if (!Array.isArray(slot)) throw new Error('routes must be an array');
      plugin.routes = slot.map((route, index) => checkRoute(manifest.id, route, index));
      continue;
    } else throw new Error(`unknown slot ${key}`);
    plugin[key] = slot;
  }
  return plugin as unknown as OfficialPlugin;
}

/** What the card says about a full-trust plugin (GET /api/plugins `trust`). */
export type TrustState = 'loaded' | 'unconfirmed' | 'path-changed' | 'safe-mode' | 'failed';
export interface TrustView {
  state: TrustState;
  /** The real path of the Hub entry (what a confirmation binds to); null when it cannot be resolved. */
  entry: string | null;
  manifestPath: string;
  /** Confirmed in plugins.json now, for this entry path: what the next start does. */
  confirmed: boolean;
  /**
   * Why it is not running this start; null when it loaded or was never tried. The text says whether any of its code ran:
   * refused before the import (nothing ran), 加载失败 (the import or default export failed or timed out), 已导入但被拒绝
   * (its top-level code and default export ran, then a check refused it), or a migration failure.
   */
  error: string | null;
  /** plugins.json could not be read just now: the confirmations shown are the ones read at start-up. */
  fileError?: string;
  /** The plugin's own tables' prefix and route prefix, for the details panel. */
  tablePrefix: string;
  routePrefix: string;
}

export interface TrustedOptions {
  safeMode: boolean;
  /** The confirmations in plugins.json now. */
  confirmations(): readonly TrustConfirmationRecord[];
  /** Replaces the confirmations in plugins.json; may throw, then nothing changed. */
  save(next: TrustConfirmationRecord[]): void;
  /** Tests shorten LOAD_TIMEOUT_MS. */
  loadTimeoutMs?: number;
}

/** Loads one entry module: the composition root's `import()`, so the core never imports plugin code itself. */
export type ImportEntry = (file: string) => Promise<unknown>;

export class TrustedPlugins {
  private readonly registrations: readonly TrustedRegistration[];
  /** Registrations whose id another registered plugin already used: never loaded, shown on that plugin's card. */
  readonly conflicts: readonly { id: string; manifestPath: string; error: string }[];
  private readonly opts: TrustedOptions;
  private readonly errors = new Map<string, string>();
  private readonly loaded = new Set<string>();
  /** Whether each was confirmed for its entry at this start. */
  private readonly confirmedAtStart = new Map<string, boolean>();
  /** The confirmations read at start-up: what the cards fall back to while plugins.json cannot be read. */
  private readonly startConfirmations: readonly TrustConfirmationRecord[];

  constructor(registrations: readonly TrustedRegistration[], opts: TrustedOptions) {
    const ids = new Set<string>();
    const conflicts: { id: string; manifestPath: string; error: string }[] = [];
    this.registrations = registrations.filter((r) => {
      const duplicate = ids.has(r.manifest.id) || (r.error !== null && r.entry === null && /already uses this id/.test(r.error));
      ids.add(r.manifest.id);
      if (duplicate) conflicts.push({ id: r.manifest.id, manifestPath: r.manifestPath, error: r.error ?? `plugin ${r.manifest.id}: another registered plugin already uses this id` });
      return !duplicate;
    });
    this.conflicts = conflicts;
    this.opts = opts;
    const confirmations = opts.confirmations();
    this.startConfirmations = confirmations;
    for (const r of this.registrations) {
      this.confirmedAtStart.set(r.manifest.id, r.entry !== null && confirmations.some((c) => c.id === r.manifest.id && c.entry === r.entry));
      if (r.error) {
        this.errors.set(r.manifest.id, r.error);
        console.error(`full-trust plugin ${r.manifest.id} skipped: ${r.error}`);
      }
    }
  }

  get safeMode(): boolean { return this.opts.safeMode; }
  ids(): string[] { return this.registrations.map((r) => r.manifest.id); }
  has(id: string): boolean { return this.registrations.some((r) => r.manifest.id === id); }
  isLoaded(id: string): boolean { return this.loaded.has(id); }
  private registration(id: string): TrustedRegistration | undefined { return this.registrations.find((r) => r.manifest.id === id); }

  /** The manifests as data (no code), for the settings switch's dependency checks of plugins that did not load. */
  manifests(): PluginManifest[] {
    return this.registrations.map(({ manifest: m }) => ({ id: m.id, version: m.version, requires: m.requires, name: m.name, description: m.description, details: m.details }));
  }

  /**
   * Imports the registrations that may run this start and returns them as official-plugin objects, in dependency order,
   * to go after the official plugins in the registry. Before any import: safe mode, no confirmation for the current
   * entry path, a registration error, or a dependency that is neither official nor loaded skip a plugin without running
   * a line of it. After the import: a failing import or default export, a refused slot, or anything PluginHost would
   * refuse (an id, slot or name collision, a dependency switched off) skip only that plugin and those depending on it.
   * `registry` is what is registered before them (official plugins, then the restricted manifests); `disabled` the ids
   * switched off for this start. `explicitlyEnabled` carries user opt-ins to the same registry validation as the Hub.
   */
  async load(registry: readonly OfficialPlugin[], disabled: readonly string[], importEntry: ImportEntry,
    host: { hostApi: number; z: unknown }, explicitlyEnabled: readonly string[]): Promise<OfficialPlugin[]> {
    if (this.opts.safeMode) return [];
    const accepted: OfficialPlugin[] = [];
    const pending = this.registrations.filter((r) => !this.errors.has(r.manifest.id) && this.confirmedAtStart.get(r.manifest.id));
    // Dependency order: a plugin goes once everything it needs is registered (official) or accepted; the rest are skipped.
    for (let progress = true; progress;) {
      progress = false;
      for (const r of [...pending]) {
        const known = new Set([...registry.map((p) => p.id), ...accepted.map((p) => p.id)]);
        const waiting = r.manifest.requires.filter((dep) => !known.has(dep));
        if (waiting.some((dep) => pending.some((other) => other.manifest.id === dep))) continue;
        pending.splice(pending.indexOf(r), 1);
        progress = true;
        // Everything the manifest alone decides is checked before the import, so none of the plugin's code runs for it.
        if (registry.some((p) => p.id === r.manifest.id)) { this.fail(r.manifest.id, `和已登记的插件 ${r.manifest.id} 重名（没有导入）`); continue; }
        if (waiting.length) { this.fail(r.manifest.id, `它依赖的插件 ${waiting.join('、')} 没有加载（没有导入）`); continue; }
        const off = disabled.includes(r.manifest.id) ? [] : r.manifest.requires.filter((dep) => disabled.includes(dep));
        if (off.length) { this.fail(r.manifest.id, `它依赖的插件 ${off.join('、')} 已关闭；先打开它，或也关掉这个插件（没有导入）`); continue; }
        const plugin = await this.loadOne(r, importEntry, host);
        if (!plugin) continue;
        try {
          const ids = new Set([...registry, ...accepted, plugin].map((p) => p.id));
          // Only the ids this registry knows: PluginHost refuses an unknown one. The real start passes the same lists.
          new PluginHost([...registry, ...accepted, plugin], disabled.filter((id) => ids.has(id)), { explicitlyEnabled });
        } catch (e) { this.fail(r.manifest.id, `${IMPORTED_REFUSED}${shortError(e)}`); continue; }
        accepted.push(plugin);
        this.loaded.add(r.manifest.id);
      }
    }
    for (const r of pending) this.fail(r.manifest.id, `它依赖的插件 ${r.manifest.requires.join('、')} 形成循环`);
    return accepted;
  }

  /**
   * Imports one entry and calls its default export, together within the load time limit: an entry whose top-level
   * await or returned promise never settles is skipped and the Hub starts (the module may stay half-loaded in the
   * process; nothing of it is used). Then checks what came back.
   */
  private async loadOne(r: TrustedRegistration, importEntry: ImportEntry, host: { hostApi: number; z: unknown }): Promise<OfficialPlugin | null> {
    const limit = this.opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let value: unknown;
    try {
      value = await Promise.race([
        (async () => {
          const module = await importEntry(r.entry!) as { default?: unknown };
          if (typeof module?.default !== 'function') throw new Error('the entry has no default export function');
          return (module.default as (h: unknown) => unknown)({ hostApi: host.hostApi, z: host.z });
        })(),
        new Promise((_ok, fail) => { timer = setTimeout(() => fail(new Error(`importing the entry and calling its default export took longer than ${limit / 1000} s`)), limit); }),
      ]);
    } catch (e) {
      this.fail(r.manifest.id, `加载失败：${shortError(e)}`);
      return null;
    } finally { clearTimeout(timer); }
    try {
      return trustedPluginOf(r.manifest, value);
    } catch (e) {
      this.fail(r.manifest.id, `${IMPORTED_REFUSED}${shortError(e)}`);
      return null;
    }
  }

  /** A plugin left out at start-up (loading, or later its migrations or a backup): the reason shows on its card. */
  fail(id: string, reason: string): void {
    this.loaded.delete(id);
    if (!this.errors.has(id)) this.errors.set(id, reason);
    console.error(`full-trust plugin ${id} skipped: ${reason}`);
  }

  /** The confirmations in plugins.json now; while it cannot be read, the ones read at start-up and why. */
  private current(): { list: readonly TrustConfirmationRecord[]; error?: string } {
    try { return { list: this.opts.confirmations() }; } catch (e) { return { list: this.startConfirmations, error: shortError(e) }; }
  }

  private stateOf(r: TrustedRegistration, confirmations: readonly TrustConfirmationRecord[]): TrustState {
    if (this.loaded.has(r.manifest.id)) return 'loaded';
    if (this.errors.has(r.manifest.id)) return 'failed';
    if (this.opts.safeMode) return 'safe-mode';
    if (r.entry === null) return 'failed';
    return confirmations.some((c) => c.id === r.manifest.id && c.entry !== r.entry) && !this.confirmedAtStart.get(r.manifest.id)
      ? 'path-changed' : 'unconfirmed';
  }

  /** The `trust` part of a full-trust plugin's card; undefined for any other plugin. */
  info(id: string): TrustView | undefined {
    const r = this.registration(id);
    if (!r) return undefined;
    const { list, error } = this.current();
    return { state: this.stateOf(r, list), entry: r.entry, manifestPath: r.manifestPath, error: this.errors.get(id) ?? null,
      confirmed: r.entry !== null && list.some((c) => c.id === id && c.entry === r.entry),
      tablePrefix: tablePrefix(id), routePrefix: routePrefix(id), ...(error ? { fileError: error } : {}) };
  }

  /**
   * The manifest's icon, read and checked exactly like a restricted plugin's (readPluginIcon), for the card and for
   * GET /api/plugins/:id/icon. Static data from the plugin folder, never run: shown whether or not the plugin is confirmed.
   */
  icon(id: string, full = true): PluginIcon | undefined {
    const r = this.registration(id);
    if (!r || r.manifest.iconPath === undefined) return undefined;
    return readPluginIcon(r.directory, r.manifest.iconPath, full);
  }

  /** The card's `iconUrl` (and `iconError`), as ExternalPlugins.info gives them for a restricted plugin. */
  iconInfo(id: string): { iconUrl: string | null; iconError?: string } {
    const icon = this.icon(id, false);
    return { iconUrl: icon && 'data' in icon ? `/api/plugins/${encodeURIComponent(id)}/icon` : null, ...(icon && 'error' in icon ? { iconError: icon.error } : {}) };
  }

  /**
   * The user confirms (`entry` must be the entry path the page showed, which must still be the real path of the
   * registered entry) or revokes trust in one plugin. Takes effect at the next start. Throws a readable refusal.
   */
  setTrust(id: string, trusted: boolean, entry?: unknown): void {
    const r = this.registration(id);
    if (!r) throw new TrustRefusal('UNKNOWN_PLUGIN', '没有这个完全信任插件。');
    const others = this.opts.confirmations().filter((c) => c.id !== id);
    if (!trusted) { this.opts.save(others); return; }
    if (r.error && !r.entry) throw new TrustRefusal('NOT_LOADABLE', `这个插件的登记有问题，不能确认：${r.error}`);
    let now: string;
    try { now = realpathSync.native(r.entry!); } catch { throw new TrustRefusal('ENTRY_CHANGED', '入口文件已经不在了；修好后重启 Hub 再确认。'); }
    if (typeof entry !== 'string' || entry !== r.entry || now !== r.entry) {
      throw new TrustRefusal('ENTRY_CHANGED', '入口文件的路径和页面上显示的不一致（文件可能被移动或替换）；重启 Hub 后重新确认。');
    }
    this.opts.save([...others, { id, entry: now }]);
  }

  /** Whether the page may import this plugin's module (GET /api/plugins `trustedFrontend`): it has one and loaded this start. */
  hasWeb(id: string): boolean {
    return this.loaded.has(id) && this.registration(id)?.web != null;
  }

  /**
   * GET /plugin-web/<id>/<rest>: a file of a loaded plugin's page module folder, `rest` '' being the module itself.
   * Like the plugin UI file service: checked segments (no `..`, hidden files, drives or device names), every folder on
   * the way and the file itself real (lstat: a link or junction anywhere is refused, never followed), the real path
   * still inside the folder and never the Hub entry, a regular file of at most UI_LIMITS.maxFileBytes, and only script,
   * style, data, image and font types (never HTML). null: 404. The caller also checks the plugin is enabled.
   */
  webFile(id: string, rest: string): { data: Buffer; type: string } | null {
    const r = this.registration(id);
    if (!r?.web || !r.entry || !this.loaded.has(id)) return null;
    const segments = rest === '' ? r.web.entry.split('/') : uiSegments(rest);
    if (!segments) return null;
    const type = WEB_TYPES.get(extname(segments.at(-1)!).toLowerCase());
    if (!type) return null;
    const stat = (path: string): Stats | null => { try { return lstatSync(path); } catch { return null; } };
    const top = stat(r.web.root);
    if (!top || top.isSymbolicLink() || !top.isDirectory()) return null;
    let path = r.web.root;
    for (const [index, segment] of segments.entries()) {
      path = join(path, segment);
      const s = stat(path);
      const last = index === segments.length - 1;
      if (!s || s.isSymbolicLink() || (last ? !s.isFile() || s.size > UI_LIMITS.maxFileBytes : !s.isDirectory())) return null;
    }
    try {
      // Real paths with the on-disk spelling (case included on Windows); relative() compares them as the platform does.
      const real = realpathSync.native(path);
      const rel = relative(realpathSync.native(r.web.root), real);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || relative(r.entry, real) === '') return null;
      // Not the Hub entry under another name either (a hard link): the same file on the same volume. An entry moved
      // or rebuilt since the start is only compared by path (above); a volume without file ids (ino 0) by path too.
      const file = statSync(real, { bigint: true });
      let entry: { ino: bigint; dev: bigint } | null = null;
      try { entry = statSync(r.entry, { bigint: true }); } catch { /* gone or moved: nothing to compare */ }
      if (entry && file.ino !== 0n && entry.ino !== 0n && file.ino === entry.ino && file.dev === entry.dev) return null;
      const data = readFileSync(real);
      return data.length > UI_LIMITS.maxFileBytes ? null : { data, type };
    } catch { return null; }
  }
}

/** What /plugin-web/ serves: scripts, styles, data, images and fonts; never HTML. */
const WEB_TYPES: ReadonlyMap<string, string> = new Map([
  ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2'],
]);

/** A refused trust change (PUT /api/plugins/:id/trust): its code picks the HTTP status. */
export class TrustRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
