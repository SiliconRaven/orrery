import { isDeepStrictEqual } from 'node:util';
import type { ExternalInstallation } from './external-plugin-config.ts';
import { effectivePluginConfig, PluginConfigProblem, validatePluginConfigValues,
  type PluginConfigField, type PluginConfigValues, type SavedPluginConfigScope } from './external-plugin-values.ts';
import type { Store } from './store.ts';

type Scope = string | null;
type ScopeType = 'global' | 'cluster';
type MemberChoice = { id: string; name: string; clusterId: string };
export interface ConfigSnapshot {
  global: SavedPluginConfigScope;
  clusterDefaults: PluginConfigValues;
  clusters: Record<string, SavedPluginConfigScope>;
}
export interface ConfigNotice { pluginId: string; clusterId: Scope; revision: number }
type Report = { revision: number; errors: Record<string, string> };

const record = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw);
const scopeType = (clusterId: Scope): ScopeType => clusterId === null ? 'global' : 'cluster';
const idsOf = (members: MemberChoice[]) => new Set(members.map((member) => member.id));

export function configScopes(fields: PluginConfigField[]): ScopeType[] {
  return (['global', 'cluster'] as const).filter((scope) => fields.some((field) => field.scope === scope));
}

/** Configuration values travel only to the user and this plugin. The transient stream carries scope and revision. */
export class PluginPreferences {
  private readonly reports = new Map<string, Map<Scope, Report>>();
  private readonly listeners = new Set<(notice: ConfigNotice) => void>();
  private readonly store: Store;

  constructor(store: Store) { this.store = store; }

  onChange(listener: (notice: ConfigNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void { this.reports.clear(); this.listeners.clear(); }

  private emit(pluginId: string, clusterId: Scope, revision: number): void {
    for (const listener of this.listeners) {
      try { listener({ pluginId, clusterId, revision }); } catch { /* a disconnected page */ }
    }
  }

  resetReports(pluginId: string): void {
    const old = this.reports.get(pluginId);
    if (!old) return;
    this.reports.delete(pluginId);
    for (const [clusterId, report] of old) this.emit(pluginId, clusterId, report.revision);
  }

  private groups(installation: ExternalInstallation) {
    const ids = new Set([...installation.clusterIds, ...installation.writeClusterIds]);
    return [...ids].flatMap((id) => {
      const c = this.store.getCluster(id);
      return c ? [{ id: c.id, name: c.name }] : [];
    });
  }

  private members(groups: {id: string}[]): MemberChoice[] {
    return groups.flatMap((c) => this.store.listMembers(c.id).map(({ id, name, clusterId }) => ({ id, name, clusterId })));
  }

  private scope(installation: ExternalInstallation, clusterId: Scope, form = false) {
    const schema = installation.manifest.config;
    if (!schema?.length) throw new PluginConfigProblem('CONFIG_NOT_FOUND', '插件没有声明配置项。');
    const clusters = this.groups(installation);
    const selected = clusterId === null ? clusters : clusters.filter((group) => group.id === clusterId);
    const fields = schema.filter((f) => f.scope === scopeType(clusterId));
    if (clusterId !== null && (!selected.length || !fields.length)) {
      throw new PluginConfigProblem('CONFIG_NOT_FOUND', '没有这个群的插件配置。');
    }
    const members = form || fields.some((f) => f.type === 'member') ? this.members(selected) : [];
    return { fields, clusters, members };
  }

  view(installation: ExternalInstallation, clusterId: Scope) {
    const { id: pluginId, name, config } = installation.manifest;
    const { fields, clusters, members } = this.scope(installation, clusterId, true);
    const saved = this.store.getPluginConfig(pluginId, clusterId);
    const report = this.reports.get(pluginId)?.get(clusterId);
    const memberIds = idsOf(members);
    const defaults = effectivePluginConfig(fields, {}, memberIds);
    const overrides = effectivePluginConfig(fields.map(({ default: _default, ...field }) => field), saved.values, memberIds);
    return { pluginId, pluginName: name ?? pluginId, clusterId, scopes: configScopes(config!), fields,
      values: { ...defaults, ...overrides }, defaults, overriddenFields: Object.keys(overrides), revision: saved.revision,
      errors: report?.revision === saved.revision ? report.errors : {}, clusters, members };
  }

  /** Non-default scopes carry complete effective values. Shared cluster defaults are sent only once. */
  snapshot(installation: ExternalInstallation, replacement?: { clusterId: Scope; saved: SavedPluginConfigScope }): ConfigSnapshot {
    const { id, config = [] } = installation.manifest;
    const globalFields = config.filter((field) => field.scope === 'global');
    const clusterFields = config.filter((field) => field.scope === 'cluster');
    const groups = this.groups(installation);
    const memberField = config.some((f) => f.type === 'member');
    const members = memberField ? this.members(groups) : [];
    const state = (fields: PluginConfigField[], clusterId: Scope, choices: MemberChoice[]): SavedPluginConfigScope => {
      const saved = replacement?.clusterId === clusterId ? replacement.saved : this.store.getPluginConfig(id, clusterId);
      return { revision: saved.revision, values: effectivePluginConfig(fields, saved.values, idsOf(choices)) };
    };
    const global = state(globalFields, null, members);
    const clusterDefaults = effectivePluginConfig(clusterFields, {}, new Set());
    const entries: [string, SavedPluginConfigScope][] = [];
    if (clusterFields.length) for (const group of groups) {
      const one = state(clusterFields, group.id, members.filter((m) => m.clusterId === group.id));
      if (one.revision || !isDeepStrictEqual(one.values, clusterDefaults)) entries.push([group.id, one]);
    }
    return { global, clusterDefaults, clusters: Object.fromEntries(entries) };
  }

  save(installation: ExternalInstallation, clusterId: Scope, raw: unknown, fits: (snapshot: ConfigSnapshot) => boolean): void {
    if (!record(raw) || Object.keys(raw).some((key) => key !== 'revision' && key !== 'values')
      || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !record(raw.values)) {
      throw new PluginConfigProblem('CONFIG_INVALID', '保存配置需要当前版本和一组字段值。');
    }
    const id = installation.manifest.id;
    const revision = this.store.transaction(() => {
      const { fields, members } = this.scope(installation, clusterId);
      if (!fields.length) throw new PluginConfigProblem('CONFIG_NOT_FOUND', '这个范围没有配置项。');
      const current = this.store.getPluginConfig(id, clusterId);
      if (current.revision !== raw.revision) throw new PluginConfigProblem('CONFIG_CONFLICT', '配置已更新，请重新读取后保存。');
      const values = validatePluginConfigValues(fields, raw.values, idsOf(members));
      const saved = { revision: current.revision + 1, values };
      if (!fits(this.snapshot(installation, { clusterId, saved }))) {
        throw new PluginConfigProblem('CONFIG_TOO_LARGE', '配置超过插件初始化消息的容量，请缩短配置值。');
      }
      this.store.setPluginConfig(id, clusterId, saved);
      return saved.revision;
    });
    this.reports.get(id)?.delete(clusterId);
    this.emit(id, clusterId, revision);
  }

  /** Resolve late, when the child can read: a deleted cluster or a member removed since the save must stay out. */
  notification(installation: ExternalInstallation, clusterId: Scope) {
    const { fields, members } = this.scope(installation, clusterId);
    if (!fields.length) return null;
    const saved = this.store.getPluginConfig(installation.manifest.id, clusterId);
    return { clusterId, revision: saved.revision, values: effectivePluginConfig(fields, saved.values, idsOf(members)) };
  }

  /** A plugin can replace only its current scope's diagnostics. Reasons stay in memory and are read by the user. */
  report(installation: ExternalInstallation, raw: unknown): void {
    if (!record(raw) || (raw.clusterId !== null && typeof raw.clusterId !== 'string') || !Number.isSafeInteger(raw.revision)
      || !record(raw.errors) || Object.keys(raw).some((k) => !['clusterId', 'revision', 'errors'].includes(k))) return;
    const id = installation.manifest.id;
    const clusterId = raw.clusterId;
    const fields = installation.manifest.config?.filter((field) => field.scope === scopeType(clusterId));
    if (!fields?.length) return;
    if (clusterId !== null && ((!installation.clusterIds.includes(clusterId) && !installation.writeClusterIds.includes(clusterId))
      || !this.store.getCluster(clusterId))) return;
    const { revision } = this.store.getPluginConfig(id, clusterId);
    if (raw.revision !== revision) return;
    const entries: [string, string][] = [];
    for (const [key, reason] of Object.entries(raw.errors)) {
      if (!fields.some((f) => f.name === key) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) return;
      entries.push([key, reason.trim()]);
    }
    const errors = Object.fromEntries(entries);
    let reports = this.reports.get(id);
    if (isDeepStrictEqual(reports?.get(clusterId)?.errors ?? {}, errors)) return;
    if (entries.length) {
      if (!reports) this.reports.set(id, reports = new Map());
      reports.set(clusterId, { revision, errors });
    } else reports?.delete(clusterId);
    this.emit(id, clusterId, revision);
  }
}
