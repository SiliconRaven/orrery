// Local, explicit installation only. These manifests are data, never imported into the Hub process.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PluginManifest } from './plugin.ts';

export const EXTERNAL_API_VERSION = 1;
export const EXTERNAL_PERMISSIONS = ['clusters.read', 'messages.read', 'events.read', 'messages.send', 'messages.mention'] as const;
export type ExternalPermission = typeof EXTERNAL_PERMISSIONS[number];
export const EXTERNAL_EVENTS = ['message.created', 'task.submitted', 'task.approved', 'task.rejected', 'task.merged', 'member.status'] as const;
export type ExternalEventType = typeof EXTERNAL_EVENTS[number];
export interface ExternalManifest extends PluginManifest {
  apiVersion: 1;
  entry: string;
  permissions: ExternalPermission[];
  events: ExternalEventType[];
  commands: { id: string; title: string }[];
  /** The manifest's `icon`, as written (checked when it is read: plugin-icon.ts); null: present but not a string. */
  iconPath?: string | null;
  /** `details` was longer than MAX_DETAILS and was cut. */
  detailsTruncated?: true;
}
/** `details` is cut to this many UTF-16 units: a long text costs the plugin its tail, never its start. */
export const MAX_DETAILS = 4000;
export interface ExternalInstallation {
  manifest: ExternalManifest;
  directory: string;
  entry: string;
  permissions: ExternalPermission[];
  events: ExternalEventType[];
  clusterIds: string[];
  writeClusterIds: string[];
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
function eventTypes(value: unknown): ExternalEventType[] {
  const list = strings(value, 'events', EXTERNAL_EVENTS.length);
  if (list.some((e) => !(EXTERNAL_EVENTS as readonly string[]).includes(e))) throw new Error('unsupported external plugin event');
  return list as ExternalEventType[];
}
function readJson(file: string): unknown {
  if (!statSync(file).isFile() || statSync(file).size > 64 * 1024) throw new Error('external plugin JSON must be a file of at most 64 KiB');
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));   // Windows editors may save UTF-8 with a BOM
}

export function parseExternalManifest(value: unknown): ExternalManifest {
  const data = object(value);
  keys(data, ['id', 'version', 'name', 'description', 'details', 'icon', 'requires', 'apiVersion', 'entry', 'permissions', 'events', 'commands']);
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
  const commands = data.commands.map((value) => {
    const command = object(value);
    keys(command, ['id', 'title']);
    const commandId = text(command.id, 'command id', 64);
    if (!ID.test(commandId)) throw new Error(`plugin ${id}: invalid command id`);
    return { id: commandId, title: text(command.title, 'command title', 200) };
  });
  if (new Set(commands.map((c) => c.id)).size !== commands.length) throw new Error(`plugin ${id}: duplicate command`);
  const requested = permissions(data.permissions);
  if (requested.includes('messages.mention') && !requested.includes('messages.send')) throw new Error(`plugin ${id}: messages.mention needs messages.send`);
  const events = eventTypes(data.events ?? []);
  if (events.length && !requested.includes('events.read')) throw new Error(`plugin ${id}: events need the events.read permission`);
  return {
    id, version, apiVersion: EXTERNAL_API_VERSION, entry, permissions: requested, events, commands, requires,
    ...(data.name === undefined ? {} : { name: text(data.name, 'name', 200) }),
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
  /** 1-based position in external-plugins.json (0 for one skipped because a plugin it requires was skipped). */
  index: number;
  /** The manifest path as written, when it was a string. */
  manifestPath: string | null;
  /** Parsed manifest when it could be read: the settings page shows the plugin as failed; null: only the log names it. */
  manifest: ExternalManifest | null;
  /** What went wrong, naming the plugin (and path) like the old start-up error did. */
  error: string;
}
export interface ExternalPluginsConfig {
  installations: ExternalInstallation[];
  failures: ExternalPluginFailure[];
}

/**
 * No discovery, download, install hooks or implicit grants. Editing this file opts into running trusted local code.
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
  const failures: ExternalPluginFailure[] = [];
  const seen = new Set<string>();
  const skip = (index: number, manifestPath: string | null, manifest: ExternalManifest | null, error: unknown) => {
    failures.push({ index, manifestPath, manifest,
      error: `external plugin #${index || '?'} (${manifestPath ?? 'no manifest path'}): ${(error as Error).message}` });
  };
  config.plugins.forEach((value, position) => {
    const index = position + 1;
    let manifestPath: string | null = null;
    let manifest: ExternalManifest | null = null;
    try {
      const item = object(value);
      keys(item, ['manifest', 'permissions', 'events', 'clusterIds', 'writeClusterIds']);
      manifestPath = text(item.manifest, 'manifest path', 4096);
      if (!isAbsolute(manifestPath)) throw new Error('external plugin manifest path must be absolute');
      const manifestFile = realpathSync(manifestPath);
      const directory = dirname(manifestFile);
      const parsed = parseExternalManifest(readJson(manifestFile));
      manifest = parsed;
      if (seen.has(parsed.id)) throw new Error(`duplicate external plugin ${parsed.id}`);
      const entry = realpathSync(resolve(directory, parsed.entry));
      const rel = relative(directory, entry);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !statSync(entry).isFile()) throw new Error(`plugin ${parsed.id}: entry escapes its directory`);
      const grants = permissions(item.permissions ?? []);
      if (grants.some((p) => !parsed.permissions.includes(p))) throw new Error(`plugin ${parsed.id}: grant was not requested by its manifest`);
      const writeClusterIds = strings(item.writeClusterIds ?? [], 'writeClusterIds', 100);
      if ((writeClusterIds.length || grants.includes('messages.mention')) && !grants.includes('messages.send')) {
        throw new Error(`plugin ${parsed.id}: write clusters and mention grants need messages.send`);
      }
      const events = eventTypes(item.events ?? []);
      if (events.some((e) => !parsed.events.includes(e))) throw new Error(`plugin ${parsed.id}: event grant was not requested by its manifest`);
      if (events.length && !grants.includes('events.read')) throw new Error(`plugin ${parsed.id}: granted events need the events.read permission`);
      installations.push({ manifest: parsed, directory, entry, permissions: grants, events,
        clusterIds: strings(item.clusterIds ?? [], 'clusterIds', 100), writeClusterIds });
      seen.add(parsed.id);
    } catch (error) { skip(index, manifestPath, manifest, error); }
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
      failures.push({ index: 0, manifestPath: null, manifest: installation.manifest,
        error: `external plugin ${installation.manifest.id} was skipped: it requires ${missing.join(', ')}, which is not available` });
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
    failures.push({ index: 0, manifestPath: null, manifest: installation.manifest,
      error: `external plugin ${installation.manifest.id} was skipped: its dependencies form a cycle` });
  }
  return { installations: ordered, failures };
}
