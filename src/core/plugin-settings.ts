// Which plugins the user wants on after the next start (docs/plugins.md). The running set never changes: no hot reload.
import type { PluginHost, PluginManifest } from './plugin.ts';

export interface InstalledPlugin {
  id: string;
  version: string;
  requires: string[];
  name: string;
  description: string;
  /** The longer text for the plugin's card; '' when there is none. */
  details: string;
  /** Where the page loads the icon from; null: the page's default icon. A third-party plugin's comes from ExternalPlugins.info. */
  iconUrl: string | null;
  /** Running in this Hub. */
  enabled: boolean;
  disabledByEnv: boolean;
  /** What the next start will do. */
  pendingEnabled: boolean;
}

export class PluginSettings {
  private readonly host: PluginHost;
  private readonly envDisabled: ReadonlySet<string>;
  private readonly save: (disabled: string[]) => void;
  private fileDisabled: string[];
  /** Registered full-trust plugins that are not running this start (unconfirmed, failed, safe mode): data only. */
  private readonly extra: readonly PluginManifest[];

  /** `save` replaces the stored list; it may throw, and then nothing changes. */
  constructor(host: PluginHost, envDisabled: readonly string[], fileDisabled: readonly string[], save: (disabled: string[]) => void,
    extra: readonly PluginManifest[] = []) {
    this.host = host;
    this.envDisabled = new Set(envDisabled);
    this.fileDisabled = [...fileDisabled];
    this.save = save;
    this.extra = extra;
  }

  private get all(): readonly PluginManifest[] { return [...this.host.installed, ...this.extra]; }
  private off(id: string): boolean { return this.envDisabled.has(id) || this.fileDisabled.includes(id); }
  private label(id: string): string { return `“${this.all.find((p) => p.id === id)?.name ?? id}”`; }

  has(id: string): boolean { return this.all.some((p) => p.id === id); }
  /** What the next start does with a plugin's switch (a full-trust plugin that did not load has no row in list()). */
  pendingEnabled(id: string): boolean { return !this.off(id); }
  disabledByEnv(id: string): boolean { return this.envDisabled.has(id); }

  list(): InstalledPlugin[] {
    return this.host.installed.map((p) => ({
      id: p.id, version: p.version, requires: p.requires ?? [], name: p.name ?? p.id, description: p.description ?? '',
      details: p.details ?? '', iconUrl: p.icon ? `/official-plugins/${p.icon}` : null,
      enabled: this.host.enabled.includes(p), disabledByEnv: this.envDisabled.has(p.id), pendingEnabled: !this.off(p.id),
    }));
  }

  /**
   * Checks against what the next start will run, not what runs now, so the stored list always lets the Hub start.
   * The messages are shown on the page as they are.
   */
  setEnabled(id: string, enabled: boolean): void {
    const names = (ids: string[]) => ids.map((x) => this.label(x)).join('、');
    if (enabled) {
      if (this.envDisabled.has(id)) throw new Error(`${this.label(id)}由环境变量 ORRERY_DISABLED_PLUGINS 禁用，不能在页面上开启。`);
      const missing = (this.all.find((p) => p.id === id)?.requires ?? []).filter((dep) => this.off(dep));
      if (missing.length) throw new Error(`不能启用${this.label(id)}：它依赖的${names(missing)}没有启用，请先启用。`);
    } else {
      const users = this.all.filter((p) => p.requires?.includes(id) && !this.off(p.id)).map((p) => p.id);
      if (users.length) throw new Error(`不能禁用${this.label(id)}：${names(users)}依赖它，请先禁用${names(users)}。`);
    }
    const next = this.fileDisabled.filter((x) => x !== id);
    if (!enabled) next.push(id);
    this.save(next);
    this.fileDisabled = next;
  }
}
