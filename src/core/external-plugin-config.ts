// Local, explicit installation only. These manifests are data, never imported into the Hub process.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isEventName, isEventPattern, MAX_EVENT_TYPE_LENGTH, patternCovers, PLUGIN_NAMESPACE } from './event-registry.ts';
import type { PluginManifest } from './plugin.ts';
import { MAX_DURATION_SECONDS, MAX_TEXT_ARGUMENT, paramBounds } from './command-args.js';
import { parsePluginConfigFields, type PluginConfigField } from './external-plugin-values.ts';
import { parseTools, type ExternalTool } from './external-plugin-tools.ts';
import { cleanText } from './external-plugin-commands.ts';
import { parseUi, parseUiGrant, type ExternalUi, type UiPosition } from './external-plugin-ui.ts';

export const EXTERNAL_API_VERSION = 1;
// messages.gate: asked before a member's message is stored (message.check) in its read clusters; it can refuse, never rewrite.
// events.publish: may publish the event types its manifest declares, under plugin.<id>. (host.events.publish).
// tools.provide: the tools named in the grant's `tools` are listed to the members of its read clusters (tool.call).
// ui.show: its own web UI at the positions named in the grant's `ui`, in its read clusters (external-plugin-ui.ts).
export const EXTERNAL_PERMISSIONS = ['clusters.read', 'messages.read', 'events.read', 'events.publish', 'messages.send', 'messages.mention', 'messages.gate', 'tools.provide', 'ui.show'] as const;
export type ExternalPermission = typeof EXTERNAL_PERMISSIONS[number];
/** At most this many subscription patterns in a manifest or a grant, and published types in a manifest. */
const MAX_EVENT_PATTERNS = 64;
const MAX_PUBLISHED_TYPES = 32;
/** A type the plugin declares it publishes; `type` is the full name, always `plugin.<id>.<name>`. */
export interface PublishedEventType { type: string; name: string; description: string; fields?: string }

/**
 * A command's declared parameter (docs/external-plugins.md「命令」). `duration` is whole seconds; `member` a member id of
 * the cluster the command runs in (so it has no default); `enum` one of `options`. `min`/`max` only for number and duration.
 */
export const COMMAND_PARAM_TYPES = ['text', 'number', 'duration', 'boolean', 'member', 'enum'] as const;
export type CommandParamType = typeof COMMAND_PARAM_TYPES[number];
export interface CommandParam {
  name: string; type: CommandParamType; label: string; required: boolean;
  default?: string | number | boolean; description?: string; options?: string[]; min?: number; max?: number;
}
/**
 * An old `{id, title}` command parses to exactly that (the settings list shows what it always did). `clusterScoped`
 * is stored only when false: such a command is not offered in a cluster's "/" menu (only POST /api/plugins/:id/invoke).
 * `longRunning` only when true: only such a command may answer `{accepted:true}` and report with command.progress /
 * command.done; any other command's answer is its final result, whatever it contains.
 */
export interface ExternalCommand {
  id: string; title: string; description?: string; params?: CommandParam[]; clusterScoped?: false; longRunning?: true;
}
const MAX_COMMAND_PARAMS = 16;
const PARAM_NAME = /^[a-z][A-Za-z0-9_]{0,31}$/;
const MAX_ENUM_OPTIONS = 50;
export interface ExternalManifest extends PluginManifest {
  apiVersion: 1;
  entry: string;
  permissions: ExternalPermission[];
  /** Subscription patterns it asks for: exact types, `<prefix>.*` or `*` (event-registry.ts). */
  events: string[];
  publishes: PublishedEventType[];
  commands: ExternalCommand[];
  /** Tools for members (external-plugin-tools.ts); offered only once the user grants tools.provide and names them. */
  memberTools: ExternalTool[];
  /** User-configurable preferences. An older manifest has no configuration fields. */
  config?: PluginConfigField[];
  /** Its own web UI (external-plugin-ui.ts); shown only once the user grants ui.show and names the positions. */
  ui?: ExternalUi;
  /** The manifest's `icon`, as written (checked when it is read: plugin-icon.ts); null: present but not a string. */
  iconPath?: string | null;
  /** `details` was longer than MAX_DETAILS and was cut. */
  detailsTruncated?: true;
  /** How long the Hub waits for its `shutdown` answer before it kills the process (absent: the Hub's default). */
  shutdownGraceMs?: number;
}
/**
 * A manifest's `shutdownGraceMs` bounds: at least 100 ms, at most 30 s. A stop, a restart and the Hub's close wait at
 * most this long for the plugin to finish (a snapshot, say) and answer; the Hub closes every plugin at once, so its own
 * close waits for the longest one, never for the sum.
 */
export const SHUTDOWN_GRACE_LIMITS = { min: 100, max: 30_000 } as const;
/** `details` is cut to this many UTF-16 units: a long text costs the plugin its tail, never its start. */
export const MAX_DETAILS = 4000;
export interface ExternalInstallation {
  manifest: ExternalManifest;
  directory: string;
  entry: string;
  permissions: ExternalPermission[];
  /** Granted subscription patterns, each covered by a requested one (patternCovers). */
  events: string[];
  clusterIds: string[];
  writeClusterIds: string[];
  /** The declared tools the user granted (with tools.provide); omitted in the file: none. */
  tools: string[];
  /** The declared UI positions the user granted (with ui.show); omitted in the file: none. */
  ui?: UiPosition[];
}

export interface ExternalWriteSettings {
  mentionEnabled: boolean;
  perMinute: number | null;
  perHour: number | null;
}

export const externalPluginSender = (pluginId: string): string => `plugin:${pluginId}`;

const ID = /^[a-z][a-z0-9-]{0,63}$/;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
  return value as Record<string, unknown>;
}
function keys(data: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(data).some((key) => !allowed.includes(key))) throw new Error('unknown external plugin field');
}
function text(value: unknown, label: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid external plugin ${label}`);
  return value;
}
function strings(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`invalid external plugin ${label}`);
  const result = value.map((v) => text(v, label, 128));
  if (new Set(result).size !== result.length) throw new Error(`duplicate external plugin ${label}`);
  return result;
}
function permissions(value: unknown): ExternalPermission[] {
  const list = strings(value, 'permissions', EXTERNAL_PERMISSIONS.length);
  if (list.some((p) => !(EXTERNAL_PERMISSIONS as readonly string[]).includes(p))) throw new Error('unsupported external plugin permission');
  return list as ExternalPermission[];
}
/** Syntax only: a type that no enabled owner declares (a disabled official plugin, an uninstalled publisher) matches nothing. */
function eventPatterns(value: unknown): string[] {
  const list = strings(value, 'events', MAX_EVENT_PATTERNS);
  if (list.some((e) => !isEventPattern(e))) throw new Error('unsupported external plugin event pattern');
  return list;
}
function publishedTypes(value: unknown, id: string): PublishedEventType[] {
  if (!Array.isArray(value) || value.length > MAX_PUBLISHED_TYPES) throw new Error(`plugin ${id}: invalid publishes`);
  const list = value.map((item) => {
    const entry = object(item);
    keys(entry, ['name', 'description', 'fields']);
    const name = entry.name;
    const type = `${PLUGIN_NAMESPACE}.${id}.${String(name)}`;
    if (!isEventName(name) || type.length > MAX_EVENT_TYPE_LENGTH) throw new Error(`plugin ${id}: invalid published event name`);
    return { type, name, description: text(entry.description, 'published event description', 200),
      ...(entry.fields === undefined ? {} : { fields: text(entry.fields, 'published event fields', 1000) }) };
  });
  if (new Set(list.map((p) => p.type)).size !== list.length) throw new Error(`plugin ${id}: duplicate published event`);
  return list;
}
function commandParam(value: unknown, id: string): CommandParam {
  const entry = object(value);
  keys(entry, ['name', 'type', 'label', 'required', 'default', 'description', 'options', 'min', 'max']);
  const bad = (what: string) => new Error(`plugin ${id}: invalid command parameter ${what}`);
  if (typeof entry.name !== 'string' || !PARAM_NAME.test(entry.name)) throw bad('name');
  const name = entry.name;
  const type = entry.type;
  if (typeof type !== 'string' || !(COMMAND_PARAM_TYPES as readonly string[]).includes(type)) throw bad(`type of ${name}`);
  const param: CommandParam = { name, type: type as CommandParamType, label: text(entry.label, 'command parameter label', 60), required: false };
  if (entry.required !== undefined) {
    if (typeof entry.required !== 'boolean') throw bad(`required of ${name}`);
    param.required = entry.required;
  }
  if (entry.description !== undefined) param.description = text(entry.description, 'command parameter description', 200);
  const numeric = type === 'number' || type === 'duration';
  for (const bound of ['min', 'max'] as const) {
    if (entry[bound] === undefined) continue;
    const n = entry[bound];
    if (!numeric || typeof n !== 'number' || !Number.isFinite(n)
      || (type === 'duration' && (!Number.isInteger(n) || n < 1 || n > MAX_DURATION_SECONDS))) throw bad(`${bound} of ${name}`);
    param[bound] = n;
  }
  if (param.min !== undefined && param.max !== undefined && param.min > param.max) throw bad(`bounds of ${name}`);
  if (entry.options !== undefined) {
    if (type !== 'enum') throw bad(`options of ${name}`);
    param.options = strings(entry.options, 'command parameter options', MAX_ENUM_OPTIONS);
    if (!param.options.length || param.options.some((o) => o.length > 100)) throw bad(`options of ${name}`);
  } else if (type === 'enum') throw bad(`options of ${name}`);
  if (entry.default !== undefined) {
    const d = entry.default;
    const { min, max } = paramBounds(param);
    const ok = type === 'text' ? typeof d === 'string' && d.length <= MAX_TEXT_ARGUMENT && (!param.required || !!d.trim())
      : type === 'number' ? typeof d === 'number' && Number.isFinite(d) && d >= min && d <= max
        : type === 'duration' ? typeof d === 'number' && Number.isInteger(d) && d >= min && d <= max
          : type === 'boolean' ? typeof d === 'boolean'
            : type === 'enum' ? typeof d === 'string' && param.options!.includes(d)
              : false;   // member: ids differ per cluster, so no default
    if (!ok) throw bad(`default of ${name}`);
    param.default = d as string | number | boolean;
  }
  return param;
}

function command(value: unknown, id: string): ExternalCommand {
  const entry = object(value);
  keys(entry, ['id', 'title', 'description', 'params', 'clusterScoped', 'longRunning']);
  const commandId = text(entry.id, 'command id', 64);
  if (!ID.test(commandId)) throw new Error(`plugin ${id}: invalid command id`);
  const result: ExternalCommand = { id: commandId, title: text(entry.title, 'command title', 200) };
  if (entry.description !== undefined) result.description = text(entry.description, 'command description', 200);
  if (entry.params !== undefined) {
    if (!Array.isArray(entry.params) || entry.params.length > MAX_COMMAND_PARAMS) throw new Error(`plugin ${id}: invalid command params`);
    const params = entry.params.map((p) => commandParam(p, id));
    if (new Set(params.map((p) => p.name)).size !== params.length) throw new Error(`plugin ${id}: duplicate command parameter`);
    result.params = params;
  }
  if (entry.clusterScoped !== undefined) {
    if (typeof entry.clusterScoped !== 'boolean') throw new Error(`plugin ${id}: invalid command clusterScoped`);
    if (!entry.clusterScoped) result.clusterScoped = false;
  }
  if (entry.longRunning !== undefined) {
    if (typeof entry.longRunning !== 'boolean') throw new Error(`plugin ${id}: invalid command longRunning`);
    if (entry.longRunning) result.longRunning = true;
  }
  return result;
}

/**
 * The plugin's `name` as every Hub text quotes it (chat records, errors a member gets, the settings card): one line,
 * no control, format or bidi characters, at most MAX_NAME characters. Cleaned once here, so no consumer can miss it.
 */
const MAX_NAME = 80;
function displayName(value: unknown): string {
  const clean = cleanText(text(value, 'name', 200), MAX_NAME);
  if (!clean) throw new Error('invalid external plugin name');
  return clean;
}

function readJson(file: string): unknown {
  if (!statSync(file).isFile() || statSync(file).size > 64 * 1024) throw new Error('external plugin JSON must be a file of at most 64 KiB');
  const source = readFileSync(file, 'utf8').replace(/^﻿/, '');   // Windows editors may save UTF-8 with a BOM
  try { return JSON.parse(source); } catch { throw new Error('invalid external plugin JSON'); }   // parser errors can quote manifest defaults
}

export function readExternalManifest(path: string): { manifest: ExternalManifest; directory: string } {
  const file = realpathSync(path);
  return { manifest: parseExternalManifest(readJson(file)), directory: dirname(file) };
}

export function resolveExternalEntry(directory: string, manifest: ExternalManifest): string {
  const entry = realpathSync(resolve(directory, manifest.entry));
  const rel = relative(directory, entry);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !statSync(entry).isFile()) {
    throw new Error(`plugin ${manifest.id}: entry escapes its directory`);
  }
  return entry;
}

export function parseExternalManifest(value: unknown): ExternalManifest {
  const data = object(value);
  keys(data, ['id', 'version', 'name', 'description', 'details', 'icon', 'requires', 'apiVersion', 'entry', 'permissions', 'events', 'publishes', 'commands', 'shutdownGraceMs', 'config', 'tools', 'ui']);
  const id = text(data.id, 'id', 64);
  if (!ID.test(id)) throw new Error('invalid external plugin id');
  if (data.apiVersion !== EXTERNAL_API_VERSION) throw new Error(`plugin ${id}: unsupported apiVersion`);
  const version = text(data.version, 'version', 64);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`plugin ${id}: invalid version`);
  const entry = text(data.entry, 'entry');
  if (isAbsolute(entry) || !['.js', '.mjs', '.cjs'].includes(extname(entry))) throw new Error(`plugin ${id}: entry must be a relative JavaScript file`);
  const requires = strings(data.requires ?? [], 'requires', 32);
  if (requires.some((dep) => !ID.test(dep))) throw new Error(`plugin ${id}: invalid dependency`);
  if (!Array.isArray(data.commands) || data.commands.length > 32) throw new Error(`plugin ${id}: invalid commands`);
  const commands = data.commands.map((value) => command(value, id));
  if (new Set(commands.map((c) => c.id)).size !== commands.length) throw new Error(`plugin ${id}: duplicate command`);
  const requested = permissions(data.permissions);
  if (requested.includes('messages.mention') && !requested.includes('messages.send')) throw new Error(`plugin ${id}: messages.mention needs messages.send`);
  const events = eventPatterns(data.events ?? []);
  if (events.length && !requested.includes('events.read')) throw new Error(`plugin ${id}: events need the events.read permission`);
  const publishes = publishedTypes(data.publishes ?? [], id);
  if (publishes.length && !requested.includes('events.publish')) throw new Error(`plugin ${id}: publishes need the events.publish permission`);
  const tools = parseTools(data.tools ?? [], id);
  if (tools.length && !requested.includes('tools.provide')) throw new Error(`plugin ${id}: tools need the tools.provide permission`);
  const ui = data.ui === undefined ? undefined : parseUi(data.ui, id);
  if (ui && !requested.includes('ui.show')) throw new Error(`plugin ${id}: ui needs the ui.show permission`);
  const grace = data.shutdownGraceMs;
  if (grace !== undefined && (typeof grace !== 'number' || !Number.isInteger(grace) || grace < SHUTDOWN_GRACE_LIMITS.min || grace > SHUTDOWN_GRACE_LIMITS.max)) {
    throw new Error(`plugin ${id}: shutdownGraceMs must be an integer from ${SHUTDOWN_GRACE_LIMITS.min} to ${SHUTDOWN_GRACE_LIMITS.max}`);
  }
  return {
    id, version, apiVersion: EXTERNAL_API_VERSION, entry, permissions: requested, events, publishes, commands, memberTools: tools, requires,
    ...(data.config === undefined ? {} : { config: parsePluginConfigFields(data.config) }),
    ...(ui ? { ui } : {}),
    ...(grace === undefined ? {} : { shutdownGraceMs: grace }),
    ...(data.name === undefined ? {} : { name: displayName(data.name) }),
    ...(data.description === undefined ? {} : { description: text(data.description, 'description') }),
    // Display only: a wrong icon or details never makes the plugin unavailable (icon: the page shows why; details: a
    // non-string or blank value is ignored, a long one cut).
    ...(data.icon === undefined ? {} : { iconPath: typeof data.icon === 'string' ? data.icon : null }),
    ...(typeof data.details !== 'string' || !data.details.trim() ? {} : data.details.length > MAX_DETAILS
      ? { details: data.details.slice(0, MAX_DETAILS).toWellFormed(), detailsTruncated: true as const } : { details: data.details }),
  };
}

/** A registered plugin the Hub could not load; the rest of the Hub and the other plugins keep running. */
export interface ExternalPluginFailure {
  /** A full-trust registration that failed before it could produce a TrustedRegistration. */
  trust?: 'full';
  /** 1-based position in external-plugins.json (0 for one skipped because a plugin it requires was skipped). */
  index: number;
  /** The manifest path as written, when it was a string. */
  manifestPath: string | null;
  /** Parsed manifest when it could be read. */
  manifest: ExternalManifest | null;
  /** What went wrong, naming the plugin (and path) like the old start-up error did. */
  error: string;
  /** Validation detail for settings, without raw filesystem errors that can quote resolved paths. */
  reason: string;
}
export interface ExternalPluginsConfig {
  installations: ExternalInstallation[];
  failures: ExternalPluginFailure[];
  /** `"trust": "full"` registrations (docs/external-plugins.md「完全信任的插件」), in file order: data only, never imported here. */
  trusted?: TrustedRegistration[];
}

/** The interface version a full-trust plugin's manifest names in `hostApi` (the shape of the official plugin slots). */
export const HOST_API_VERSION = 1;
/** A full-trust plugin's manifest: what the settings page shows, and where its Hub entry and optional page module are. */
export interface TrustedManifest {
  id: string;
  version: string;
  name?: string;
  description?: string;
  details?: string;
  requires: string[];
  hostApi: number;
  /** Relative path of the Hub entry module (.js or .mjs) inside the plugin's folder. */
  hubEntry: string;
  /** Relative path of the page module (.js) in a sub-folder of the plugin's folder; that sub-folder is what the Hub serves. */
  webEntry?: string;
  /** The manifest names `webModule` (an official plugin's field): refused, a full-trust plugin names its page module in webEntry. */
  webModule?: true;
  /** The manifest's `icon`, as written, checked like a restricted plugin's (plugin-icon.ts); null: present but not a string. */
  iconPath?: string | null;
}
/**
 * One full-trust registration as read at start-up. `entry` is the real path of the Hub entry file (what a confirmation
 * is bound to), null when it cannot be resolved; `error` is set when the registration itself is unusable (a hostApi
 * this Hub does not speak, an entry outside the folder, a duplicate id): such a plugin is never imported.
 */
export interface TrustedRegistration {
  manifest: TrustedManifest;
  manifestPath: string;
  directory: string;
  entry: string | null;
  /**
   * The page module's folder (real path, on-disk spelling) and the module's file name in it, when the manifest names a
   * webEntry: the folder is what GET /plugin-web/<id>/ serves (TrustedPlugins.webFile). Never the Hub entry's folder.
   */
  web: { root: string; entry: string } | null;
  error: string | null;
}

/** Whether `path` is `folder` itself or anything below it (both real, on-disk spellings). */
const within = (folder: string, path: string) => { const rel = relative(folder, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)); };

/**
 * The real path of `relativePath` inside `directory`, or an error naming what is wrong. realpathSync.native gives the
 * spelling on disk (case included on Windows), so two names for one file compare equal and a confirmation bound to
 * the old spelling of a path no longer matches.
 */
function insideFile(directory: string, relativePath: string, id: string, what: string): string {
  let file: string;
  try { file = realpathSync.native(resolve(directory, relativePath)); } catch { throw new Error(`plugin ${id}: ${what} ${relativePath} does not exist`); }
  if (!within(directory, file) || file === directory || !statSync(file).isFile()) throw new Error(`plugin ${id}: ${what} escapes its directory`);
  return file;
}

/**
 * A full-trust manifest, read as data (never imported). Strict keys like the restricted manifest. `hostApi` is only
 * checked for being an integer here: a version this Hub does not speak is a per-plugin load error the card shows.
 */
export function parseTrustedManifest(value: unknown): TrustedManifest {
  const data = object(value);
  keys(data, ['id', 'version', 'name', 'description', 'details', 'icon', 'requires', 'hostApi', 'hubEntry', 'webEntry', 'webModule']);
  const id = text(data.id, 'id', 64);
  if (!ID.test(id)) throw new Error('invalid external plugin id');
  const version = text(data.version, 'version', 64);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`plugin ${id}: invalid version`);
  if (!Number.isSafeInteger(data.hostApi)) throw new Error(`plugin ${id}: hostApi must be an integer`);
  const hubEntry = text(data.hubEntry, 'hubEntry');
  if (isAbsolute(hubEntry) || !['.js', '.mjs'].includes(extname(hubEntry))) throw new Error(`plugin ${id}: hubEntry must be a relative .js or .mjs file`);
  let webEntry: string | undefined;
  if (data.webEntry !== undefined) {
    webEntry = text(data.webEntry, 'webEntry');
    const parts = webEntry.split(/[\\/]/);
    if (isAbsolute(webEntry) || extname(webEntry) !== '.js' || parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..')) {
      throw new Error(`plugin ${id}: webEntry must be a relative .js file in a sub-folder (its folder is served to the page)`);
    }
  }
  const requires = strings(data.requires ?? [], 'requires', 32);
  if (requires.some((dep) => !ID.test(dep))) throw new Error(`plugin ${id}: invalid dependency`);
  return {
    id, version, requires, hostApi: data.hostApi as number, hubEntry, ...(webEntry ? { webEntry } : {}),
    // Read so the card can say why: refused in trustedRegistration, before any import.
    ...(data.webModule !== undefined ? { webModule: true as const } : {}),
    ...(data.name === undefined ? {} : { name: displayName(data.name) }),
    ...(data.description === undefined ? {} : { description: text(data.description, 'description') }),
    ...(typeof data.details !== 'string' || !data.details.trim() ? {} : { details: data.details.slice(0, MAX_DETAILS).toWellFormed() }),
    // Display only, exactly as for a restricted plugin: a wrong icon never keeps the plugin from loading.
    ...(data.icon === undefined ? {} : { iconPath: typeof data.icon === 'string' ? data.icon : null }),
  };
}

function trustedRegistration(manifestPath: string, manifestFile: string, manifest: TrustedManifest, duplicate: boolean): TrustedRegistration {
  const directory = dirname(manifestFile);
  const registration: TrustedRegistration = { manifest, manifestPath, directory, entry: null, web: null, error: null };
  try {
    if (duplicate) throw new Error(`plugin ${manifest.id}: another registered plugin already uses this id`);
    if (manifest.webModule) throw new Error(`plugin ${manifest.id}: webModule is an official plugin's field; a full-trust plugin names its page module in webEntry`);
    if (manifest.hostApi !== HOST_API_VERSION) throw new Error(`plugin ${manifest.id}: hostApi ${manifest.hostApi} is not supported; this Hub speaks hostApi ${HOST_API_VERSION}`);
    registration.entry = insideFile(directory, manifest.hubEntry, manifest.id, 'hubEntry');
    if (manifest.webEntry) {
      // Both real paths with their on-disk spelling: `WEB/index.js` next to `web/hub.mjs` is the Hub entry's folder.
      const file = insideFile(directory, manifest.webEntry, manifest.id, 'webEntry');
      const root = dirname(file);
      if (within(root, directory) || within(root, registration.entry)) {
        throw new Error(`plugin ${manifest.id}: the web module's folder must be a sub-folder that does not hold the Hub entry`);
      }
      registration.web = { root, entry: relative(root, file).split(sep).join('/') };
    }
  } catch (e) { registration.error = (e as Error).message; }
  return registration;
}

/**
 * One plugin's registration and manifest read again from disk, for the user's start or restart of it: a changed grant
 * or an upgraded plugin takes effect then, never by itself. The whole file is read with the same rules as at start-up;
 * a file that cannot be read, a plugin no longer registered under this id, or one that is skipped now throws a readable
 * error, which fails only this plugin.
 */
export function readExternalPlugin(home: string, known: readonly string[], id: string, directory?: string): ExternalInstallation {
  let config: ExternalPluginsConfig;
  try { config = readExternalPlugins(home, known); } catch (error) {
    throw new Error(`external-plugins.json cannot be read now: ${(error as Error).message}`);
  }
  const found = config.installations.find((p) => p.manifest.id === id);
  if (found) return found;
  // A manifest that cannot be read has no id: its entry is found by the folder the plugin was registered in.
  const folderOf = (path: string) => { try { return dirname(realpathSync(path)); } catch { return dirname(resolve(path)); } };
  const failure = config.failures.find((f) => f.manifest?.id === id)
    ?? config.failures.find((f) => !f.manifest && directory !== undefined && f.manifestPath !== null && folderOf(f.manifestPath) === directory);
  throw new Error(failure?.error ?? `external-plugins.json no longer registers a plugin with id ${id} (a changed id or a new registration needs a Hub restart)`);
}

export function parseExternalGrants(item: Record<string, unknown>, parsed: ExternalManifest) {
  const grants = permissions(item.permissions ?? []);
  if (grants.some((p) => !parsed.permissions.includes(p))) throw new Error(`plugin ${parsed.id}: grant was not requested by its manifest`);
  const writeClusterIds = strings(item.writeClusterIds ?? [], 'writeClusterIds', 100);
  if ((writeClusterIds.length || grants.includes('messages.mention')) && !grants.includes('messages.send')) {
    throw new Error(`plugin ${parsed.id}: write clusters and mention grants need messages.send`);
  }
  const events = eventPatterns(item.events ?? []);
  // A wildcard grant must be no wider than a requested pattern, or a later type would slip past the request.
  if (events.some((e) => !parsed.events.some((r) => patternCovers(r, e)))) throw new Error(`plugin ${parsed.id}: event grant was not requested by its manifest`);
  if (events.length && !grants.includes('events.read')) throw new Error(`plugin ${parsed.id}: granted events need the events.read permission`);
  // Like events: the permission and the named tools are both granted explicitly; omitted means none, never all.
  const tools = strings(item.tools ?? [], 'tools', 8);
  if (tools.some((name) => !parsed.memberTools.some((t) => t.name === name))) throw new Error(`plugin ${parsed.id}: tool grant was not declared by its manifest`);
  if (tools.length && !grants.includes('tools.provide')) throw new Error(`plugin ${parsed.id}: granted tools need the tools.provide permission`);
  // The same for the UI: ui.show and the positions, both explicit; omitted means none.
  const ui = parseUiGrant(item.ui ?? [], parsed.ui?.positions, parsed.id);
  if (ui.length && !grants.includes('ui.show')) throw new Error(`plugin ${parsed.id}: granted ui positions need the ui.show permission`);
  return { permissions: grants, events, clusterIds: strings(item.clusterIds ?? [], 'clusterIds', 100), writeClusterIds, tools, ui };
}

/**
 * Reads explicit local registrations and applies no implicit grants. Editing this file opts into running trusted local code.
 * The file itself must be valid (a broken file still stops the start); a single plugin whose manifest or entry is
 * broken is skipped and recorded in `failures`, and so is every plugin whose dependencies are not available.
 */
export function readExternalPlugins(home: string, known: readonly string[] = []): ExternalPluginsConfig {
  const file = join(home, 'external-plugins.json');
  let value: unknown;
  try { value = readJson(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installations: [], failures: [] };
    throw new Error('cannot read external-plugins.json; check its JSON and permissions', { cause: error });
  }
  const config = object(value);
  keys(config, ['plugins']);
  if (!Array.isArray(config.plugins) || config.plugins.length > 16) throw new Error('external-plugins.json must contain at most 16 plugins');
  const installations: ExternalInstallation[] = [];
  const trusted: TrustedRegistration[] = [];
  const failures: ExternalPluginFailure[] = [];
  const seen = new Set<string>();
  config.plugins.forEach((value, position) => {
    const index = position + 1;
    let manifestPath: string | null = null;
    let manifest: ExternalManifest | null = null;
    let fullTrust = false;
    try {
      const item = object(value);
      fullTrust = item.trust === 'full';
      if (item.trust !== undefined) {
        // A full-trust registration names its manifest and nothing else: no grants, the plugin has orrery's own power.
        keys(item, ['manifest', 'trust']);
        if (item.trust !== 'full') throw new Error('trust must be "full" when given');
        manifestPath = text(item.manifest, 'manifest path', 4096);
        if (!isAbsolute(manifestPath)) throw new Error('external plugin manifest path must be absolute');
        const manifestFile = realpathSync.native(manifestPath);
        const parsed = parseTrustedManifest(readJson(manifestFile));
        trusted.push(trustedRegistration(manifestPath, manifestFile, parsed, seen.has(parsed.id)));
        seen.add(parsed.id);
        return;
      }
      keys(item, ['manifest', 'permissions', 'events', 'clusterIds', 'writeClusterIds', 'tools', 'ui']);
      manifestPath = text(item.manifest, 'manifest path', 4096);
      if (!isAbsolute(manifestPath)) throw new Error('external plugin manifest path must be absolute');
      const { manifest: parsed, directory } = readExternalManifest(manifestPath);
      manifest = parsed;
      if (seen.has(parsed.id)) throw new Error(`duplicate external plugin ${parsed.id}`);
      const entry = resolveExternalEntry(directory, parsed);
      installations.push({ manifest: parsed, directory, entry, ...parseExternalGrants(item, parsed) });
      seen.add(parsed.id);
    } catch (error) {
      const { message, code } = error as NodeJS.ErrnoException;
      failures.push({ index, manifestPath, manifest, ...(fullTrust ? { trust: 'full' } : {}),
        error: `external plugin #${index} (${manifestPath ?? 'no manifest path'}): ${message}`,
        reason: code ? `无法读取清单或入口文件（${code}）。` : message });
    }
  });
  // A plugin can only start when every dependency is registered: an official plugin (known) or another external
  // plugin that survives. A provider whose manifest could not be read at all has no id to compare with, so decide
  // against the set of ids that actually exist rather than against the failure list; a failed duplicate id must not
  // take a working provider with the same id down. Repeat to a fixed point because a skipped plugin can skip more.
  const available = new Set([...known, ...installations.map((p) => p.manifest.id)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const installation of [...installations]) {
      const missing = (installation.manifest.requires ?? []).filter((dep) => !available.has(dep));
      if (!missing.length) continue;
      installations.splice(installations.indexOf(installation), 1);
      available.delete(installation.manifest.id);
      const reason = `external plugin ${installation.manifest.id} was skipped: it requires ${missing.join(', ')}, which is not available`;
      failures.push({ index: 0, manifestPath: null, manifest: installation.manifest, error: reason, reason });
      changed = true;
    }
  }
  // PluginHost wants dependencies registered before dependents; keep the config order where possible and order the
  // rest by dependency. A cycle cannot be registered either, so those plugins are isolated as well.
  const ordered: ExternalInstallation[] = [];
  const placed = new Set<string>();
  const ready = () => installations.find((p) => !placed.has(p.manifest.id)
    && (p.manifest.requires ?? []).every((dep) => placed.has(dep) || !installations.some((q) => q.manifest.id === dep)));
  for (let next = ready(); next; next = ready()) {
    ordered.push(next);
    placed.add(next.manifest.id);
  }
  for (const installation of installations) {
    if (placed.has(installation.manifest.id)) continue;
    const reason = `external plugin ${installation.manifest.id} was skipped: its dependencies form a cycle`;
    failures.push({ index: 0, manifestPath: null, manifest: installation.manifest, error: reason, reason });
  }
  return { installations: ordered, failures, ...(trusted.length ? { trusted } : {}) };
}
