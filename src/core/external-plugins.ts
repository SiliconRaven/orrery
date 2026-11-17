// The external host brokers only explicitly granted calls. Never pass Hub, Store, tokens or SQL over the wire.
import { externalPluginSender, object, type ExternalEventType, type ExternalInstallation, type ExternalPermission,
  type ExternalPluginFailure, type ExternalWriteSettings } from './external-plugin-config.ts';
import type { Hub } from './hub.ts';
import { readPluginIcon, type PluginIcon } from './plugin-icon.ts';
import { ExternalEventTranslator } from './external-plugin-events.ts';
import { EXTERNAL_MAX_FRAME, ExternalPluginProcess, type ExternalEvent } from './external-plugin-process.ts';
import type { Store } from './store.ts';
import type { HubEvent, Member, Message } from './types.ts';

const eventGranted = (plugin: ExternalInstallation, type: ExternalEventType, clusterId: string) =>
  plugin.permissions.includes('events.read') && plugin.events.includes(type) && plugin.clusterIds.includes(clusterId);

const MAX_BODY_CHARS = 8000;
const MAX_PAGE_BYTES = EXTERNAL_MAX_FRAME - 1024;   // the 1 KiB holds the envelope, even a 128-char request id fully escaped
const DEFAULT_WRITE_SETTINGS: Readonly<ExternalWriteSettings> = { mentionEnabled: false, perMinute: 10, perHour: 200 };
const RATE_WINDOWS = [
  { setting: 'perMinute', window: 'minute', ms: 60_000 },
  { setting: 'perHour', window: 'hour', ms: 3_600_000 },
] as const;

function patchedRate(input: Record<string, unknown>, setting: 'perMinute' | 'perHour', current: number | null): number | null {
  if (!Object.hasOwn(input, setting)) return current;
  const value = input[setting];
  if (value === null) {
    if (input.confirmUnlimited !== true) throw new Error(`${setting} 不限额需要 confirmUnlimited: true。`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${setting} 必须是正整数或 null。`);
  return value;
}

/** Fills one frame newest first: what gets dropped is older, so the page's first id still works as `before`. */
function messagesPage(messages: readonly Message[]) {
  const page: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const message of messages.toReversed()) {
    const long = message.body.length > MAX_BODY_CHARS;
    const item = { id: message.id, clusterId: message.clusterId, from: message.from,
      body: long ? message.body.slice(0, MAX_BODY_CHARS).toWellFormed() : message.body, createdAt: message.createdAt,
      ...(long ? { bodyTruncated: true } : {}) };
    // JSON needs at most 6 bytes a character, so one cut body always fits: a page is never empty just because of size.
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > MAX_PAGE_BYTES) return { messages: page.reverse(), truncated: true };
    page.push(item);
  }
  return { messages: page.reverse() };
}

export class ExternalPlugins {
  private readonly processes = new Map<string, ExternalPluginProcess>();
  private readonly installations: readonly ExternalInstallation[];
  private readonly enabled: ReadonlySet<string>;
  private readonly translator: ExternalEventTranslator;

  private readonly failures: readonly ExternalPluginFailure[];
  private readonly store: Store;
  private readonly hub?: Pick<Hub, 'sendFromExternalPlugin' | 'externalPluginRateNotice'>;
  // Only known-exhausted windows, at most one deadline per configured plugin and write cluster.
  private readonly rateBlocks = new Map<string, Map<string, number>>();

  constructor(installations: readonly ExternalInstallation[], store: Store, enabled: readonly string[], timeoutMs?: number,
    failures: readonly ExternalPluginFailure[] = [], hub?: Pick<Hub, 'sendFromExternalPlugin' | 'externalPluginRateNotice'>) {
    this.store = store;
    this.hub = hub;
    this.installations = installations;
    this.enabled = new Set(enabled);
    this.translator = new ExternalEventTranslator(store);
    this.failures = failures;
    for (const installation of installations) {
      const allowed = (permission: ExternalPermission) => {
        if (!installation.permissions.includes(permission)) throw new Error('permission denied');
      };
      const broker = (method: string, params: Record<string, unknown>) => {
        if (method === 'host.clusters.list') {
          allowed('clusters.read');
          return { clusters: installation.clusterIds.flatMap((id) => {
            const cluster = store.getCluster(id);
            return cluster ? [{ id: cluster.id, name: cluster.name }] : [];
          }) };
        }
        if (method === 'host.messages.list') {
          allowed('messages.read');
          if (typeof params.clusterId !== 'string' || !installation.clusterIds.includes(params.clusterId) || !store.getCluster(params.clusterId)) throw new Error('cluster out of scope');
          const limit = params.limit ?? 20;
          if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid limit');
          if (params.before !== undefined && (typeof params.before !== 'string' || params.before.length > 128)) throw new Error('invalid cursor');
          if (typeof params.before === 'string' && store.getMessage(params.before)?.clusterId !== params.clusterId) throw new Error('cursor out of scope');
          return messagesPage(store.listMessages(params.clusterId, limit, params.before as string | undefined));
        }
        if (method === 'host.messages.send') {
          allowed('messages.send');
          return this.send(installation, params);
        }
        throw new Error('unsupported host method');
      };
      const eventAllowed = (event: ExternalEvent) => {
        const clusterId = event.data.clusterId as string;
        return eventGranted(installation, event.type, clusterId) && !!store.getCluster(clusterId);
      };
      this.processes.set(installation.manifest.id, new ExternalPluginProcess(installation, broker, timeoutMs, eventAllowed));
    }
  }

  private writeSettings(installation: ExternalInstallation): ExternalWriteSettings {
    const saved = this.store.getExternalWriteSettings(installation.manifest.id) ?? DEFAULT_WRITE_SETTINGS;
    return { ...saved, mentionEnabled: saved.mentionEnabled === true && installation.permissions.includes('messages.mention') };
  }

  setWriteSettings(id: string, value: unknown): void {
    const installation = this.installations.find((item) => item.manifest.id === id);
    if (!installation?.permissions.includes('messages.send')) throw new Error('该插件未获发送消息的权限。');
    const input = object(value);
    const fields = ['mentionEnabled', 'perMinute', 'perHour'];
    if (!fields.some((field) => Object.hasOwn(input, field)) || Object.keys(input).some((field) => !fields.includes(field) && field !== 'confirmUnlimited')) {
      throw new Error('请提供 mentionEnabled、perMinute 或 perHour。');
    }
    const current = this.writeSettings(installation);
    const mentionEnabled = Object.hasOwn(input, 'mentionEnabled') ? input.mentionEnabled : current.mentionEnabled;
    if (typeof mentionEnabled !== 'boolean') throw new Error('mentionEnabled 必须是布尔值。');
    if (mentionEnabled && !installation.permissions.includes('messages.mention')) throw new Error('该插件未获 messages.mention 权限。');
    const perMinute = patchedRate(input, 'perMinute', current.perMinute);
    const perHour = patchedRate(input, 'perHour', current.perHour);
    this.store.setExternalWriteSettings(id, { mentionEnabled, perMinute, perHour });
    this.rateBlocks.delete(id);
  }

  private send(installation: ExternalInstallation, params: Record<string, unknown>) {
    if (!this.hub) throw new Error('plugin writes are unavailable');
    const { clusterId, body, causedBy } = params;
    if (Object.keys(params).some((key) => !['clusterId', 'body', 'causedBy'].includes(key))) throw new Error('unexpected send field');
    if (typeof clusterId !== 'string' || !installation.writeClusterIds.includes(clusterId)) throw new Error('write cluster out of scope');
    if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_CHARS) throw new Error('invalid plugin message body');
    if (causedBy !== undefined && (typeof causedBy !== 'string' || !causedBy || causedBy.length > 128)) throw new Error('invalid causedBy');
    const pluginId = installation.manifest.id;
    const now = Date.now();
    const blocks = this.rateBlocks.get(pluginId);
    if (now < (blocks?.get(clusterId) ?? 0)) throw new Error('plugin message rate limit');
    blocks?.delete(clusterId);

    if (!this.store.getCluster(clusterId)) throw new Error('write cluster out of scope');
    const cause = causedBy === undefined ? null : this.store.getMessage(causedBy);
    if (causedBy !== undefined && cause?.clusterId !== clusterId) throw new Error('causedBy message out of scope');
    const settings = this.writeSettings(installation);
    const sender = externalPluginSender(pluginId);
    for (const { setting, window, ms } of RATE_WINDOWS) {
      const limit = settings[setting];
      if (limit === null) continue;
      const boundary = this.store.pluginRateBoundary(clusterId, sender, new Date(now - ms).toISOString(), limit);
      if (boundary === null) continue;
      const blocked = blocks ?? new Map<string, number>();
      blocked.set(clusterId, Date.parse(boundary) + ms);
      this.rateBlocks.set(pluginId, blocked);
      this.hub.externalPluginRateNotice(pluginId, clusterId, window, limit);
      throw new Error('plugin message rate limit');
    }
    return this.hub.sendFromExternalPlugin(pluginId, clusterId, body, cause, settings.mentionEnabled);
  }

  has(id: string): boolean { return this.processes.has(id); }
  /**
   * A registered plugin's icon, read and checked now; undefined when it declares none or is not registered. `full:
   * false` (the plugin list, which only needs the verdict) reads at most the first few KiB of the file.
   */
  icon(id: string, full = true): PluginIcon | undefined {
    const installation = this.installations.find((p) => p.manifest.id === id);
    if (!installation || installation.manifest.iconPath === undefined) return undefined;
    return readPluginIcon(installation.directory, installation.manifest.iconPath, full);
  }
  info(id: string) {
    const installation = this.installations.find((p) => p.manifest.id === id);
    const process = this.processes.get(id);
    if (!installation || !process) return { runtime: undefined };   // skipped plugins are listed by failedInstalled(), never as a registered id
    const icon = this.icon(id, false);   // the list shows the reason on the card, so it checks; the route reads the file
    return { origin: 'external' as const, apiVersion: installation.manifest.apiVersion,
      iconUrl: icon && 'data' in icon ? `/api/plugins/${encodeURIComponent(id)}/icon` : null,
      ...(icon && 'error' in icon ? { iconError: icon.error } : {}),
      ...(installation.manifest.detailsTruncated ? { detailsTruncated: true } : {}),
      permissions: installation.permissions, events: installation.events, clusterIds: installation.clusterIds, commands: installation.manifest.commands,
      ...(installation.permissions.includes('messages.send') ? { writeClusterIds: installation.writeClusterIds, writeSettings: this.writeSettings(installation) } : {}),
      runtime: { state: process.state, error: process.error, errorCode: process.errorCode } };
  }

  /** Skipped plugins whose manifest could be read: the settings page lists them as failed (they never registered). */
  failedInstalled() {
    return this.failures.flatMap((failure) => {
      const manifest = failure.manifest;
      if (!manifest || this.installations.some((p) => p.manifest.id === manifest.id)) return [];
      return [{ id: manifest.id, version: manifest.version, requires: manifest.requires ?? [],
        name: manifest.name ?? manifest.id, description: manifest.description ?? '',
        details: manifest.details ?? '', ...(manifest.detailsTruncated ? { detailsTruncated: true } : {}), iconUrl: null,
        enabled: false, disabledByEnv: false, pendingEnabled: false, unavailable: true,
        origin: 'external' as const, apiVersion: manifest.apiVersion, commands: manifest.commands,
        runtime: { state: 'failed' as const, error: failure.error, errorCode: 'START_FAILED' as const } }];
    });
  }
  async start(): Promise<void> {
    await Promise.all([...this.processes].filter(([id]) => this.enabled.has(id)).map(([, process]) => process.start()));
  }
  invoke(id: string, value: unknown): Promise<unknown> {
    const process = this.processes.get(id);
    if (!process) return Promise.reject(new Error('unknown external plugin'));
    const input = object(value);
    if (Object.keys(input).some((key) => !['command', 'arguments'].includes(key)) || typeof input.command !== 'string') throw new Error('expected {command, arguments}');
    return process.invoke(input.command, object(input.arguments ?? {}));
  }
  /** Call before subscribing to the Hub: what "changed" means for a member's first status event (see the translator). */
  baselineMembers(members: readonly Pick<Member, 'id' | 'status'>[]): void { this.translator.baseline(members); }

  /** Hub listener, called after the commit. Routes by grant; each process re-checks right before writing. A stopped process ignores the push. */
  publish(event: HubEvent): void {
    const clusterId = event.clusterId;
    if (!clusterId) return;
    try {   // a throwing listener would break the Hub's own delivery path
      const sourcePluginId = event.kind === 'message' ? (event.payload as { sourcePluginId?: string }).sourcePluginId : undefined;
      for (const item of this.translator.translate(event, clusterId)) {
        for (const plugin of this.installations) {
          const id = plugin.manifest.id;
          if (id !== sourcePluginId && eventGranted(plugin, item.type, clusterId)) this.processes.get(id)?.pushEvent(item);
        }
      }
    } catch { /* observation must not change collaboration */ }
  }
  async stop(id: string): Promise<void> { await this.processes.get(id)?.close(); }
  async close(): Promise<void> { await Promise.all([...this.processes.values()].map((process) => process.close())); }
}
