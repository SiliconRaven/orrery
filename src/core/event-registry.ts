// The generic event channel for third-party plugins (docs/external-plugins.md「事件订阅」). Each event TYPE is declared by
// its owner (the core, or an official plugin through OfficialPlugin.eventSource) with a description and a builder that
// copies an explicit whitelist of fields. This file only registers, matches names and translates: it knows no type.
import type { HubEvent, Member } from './types.ts';

export const MAX_EVENT_TYPE_LENGTH = 128;
/**
 * Dotted lowercase segments. One anchored pass: '.' is outside the segment class, so the engine never has two ways to
 * split a name and the match is linear in its length (no backtracking on input a plugin chose).
 */
const NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
/** Third-party published types live under `plugin.<pluginId>.`; no core or official type may take this namespace. */
export const PLUGIN_NAMESPACE = 'plugin';

/** One or more segments: a published type's own name, or the part of a prefix pattern before `.*`. */
export const isEventName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_EVENT_TYPE_LENGTH && NAME.test(value);
/** A full type name has at least two segments: `message.created`. */
export const isEventType = (value: unknown): value is string => isEventName(value) && value.includes('.');
/** `*`, an exact type, or `<name>.*` (every type that starts with `<name>.`, at any depth). */
export function isEventPattern(value: unknown): value is string {
  if (value === '*') return true;
  if (typeof value !== 'string') return false;
  return value.endsWith('.*') ? isEventName(value.slice(0, -2)) : isEventType(value);
}
/** Linear: a string comparison, never a regex built from the pattern. */
export function patternMatches(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  return pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}
/**
 * Whether `granted` can only ever match types `requested` matches: it equals it or is narrower. `*` covers everything;
 * `<p>.*` covers every exact type or pattern that starts with `<p>.` (itself included); an exact type covers only itself.
 * So a wildcard grant needs a request at least as wide, and a later type never slips past the manifest's request.
 */
export function patternCovers(requested: string, granted: string): boolean {
  if (requested === '*') return true;
  if (granted === '*') return false;
  return requested.endsWith('.*') ? granted.startsWith(requested.slice(0, -1)) : requested === granted;
}

export interface EventBuildContext {
  /** True only for a plugin that holds messages.read for the event's cluster: message bodies may be copied. */
  withBody: boolean;
}

export interface EventTypeSpec {
  /** Dotted lowercase name, e.g. `message.created`. */
  type: string;
  /** Chinese, one line: what happened. */
  description: string;
  /** Chinese: the fields of `data`, for the docs and the settings page. */
  fields: string;
  /** The Hub event kind it is built from. */
  from: HubEvent['kind'];
  /** global: no cluster (every subscriber with the type grant gets it). Default: the Hub event's cluster; none, no event. */
  scope?: 'cluster' | 'global';
  /** The builder reads a message body: built a second time with `withBody` for plugins that hold messages.read. */
  body?: true;
  /**
   * The outward `data` (one or several records), or null when this Hub event is not of this type. Body variants must
   * have the same order and count. Copy each field by name from a whitelist:
   * never spread a Hub payload or a stored object (secrets, session ids, paths and future fields would leak).
   */
  build(event: HubEvent, ctx: EventBuildContext): Record<string, unknown> | Record<string, unknown>[] | null;
}

export interface EventSource {
  types: EventTypeSpec[];
  /** After every type was built from a Hub event: update what the builders compare with (e.g. a member's last status). */
  observed?(event: HubEvent): void;
  /** The members that exist when the Hub starts, with their current state. */
  baseline?(members: readonly MemberBaseline[]): void;
}
export type MemberBaseline = Pick<Member, 'id' | 'status'> & Partial<Pick<Member, 'name' | 'hiddenAt'>>;
export interface OwnedEventSource { owner: string; source: EventSource }

/** scope `either`: a third-party published type, cluster or global per publish. */
export interface CatalogEntry { type: string; owner: string; description: string; fields: string; scope: 'cluster' | 'global' | 'either' }

/** One outward event; `bodyData` is the variant for plugins allowed to read message bodies. */
export interface OutwardEvent { type: string; clusterId: string | null; data: Record<string, unknown>; bodyData?: Record<string, unknown> }

export class EventRegistry {
  private readonly specs = new Map<string, { owner: string; spec: EventTypeSpec }>();
  private readonly byKind = new Map<HubEvent['kind'], EventTypeSpec[]>();
  private readonly sources: readonly EventSource[];

  /** Throws on a bad or duplicate declaration: that is a bug in the code that declares it, found at startup. */
  constructor(owned: readonly OwnedEventSource[]) {
    this.sources = owned.map((o) => o.source);
    for (const { owner, source } of owned) {
      for (const spec of source.types) {
        if (!isEventType(spec.type)) throw new Error(`${owner} declares an invalid event type ${JSON.stringify(spec.type)}`);
        if (spec.type.split('.')[0] === PLUGIN_NAMESPACE) throw new Error(`${owner} may not declare ${spec.type}: plugin.* is for third-party plugins`);
        if (this.specs.has(spec.type)) throw new Error(`${owner} declares event type ${spec.type}, which ${this.specs.get(spec.type)!.owner} already declares`);
        if (!spec.description.trim() || !spec.fields.trim()) throw new Error(`${owner} must describe event type ${spec.type}`);
        this.specs.set(spec.type, { owner, spec });
        const list = this.byKind.get(spec.from) ?? [];
        list.push(spec);
        this.byKind.set(spec.from, list);
      }
    }
  }

  catalog(): CatalogEntry[] {
    return [...this.specs.values()].map(({ owner, spec }) => ({ type: spec.type, owner, description: spec.description, fields: spec.fields,
      scope: spec.scope ?? 'cluster' }));
  }

  has(type: string): boolean { return this.specs.has(type); }

  baseline(members: readonly MemberBaseline[]): void {
    for (const source of this.sources) source.baseline?.(members);
  }

  /**
   * Every declared type this committed Hub event is, in declaration order. A failing builder only loses its own type.
   * `wanted`: skip building types nobody subscribes to; the sources still observe every event.
   */
  translate(event: HubEvent, wanted: (type: string) => boolean = () => true): OutwardEvent[] {
    const out: OutwardEvent[] = [];
    for (const spec of this.byKind.get(event.kind) ?? []) {
      const global = spec.scope === 'global';
      if ((!global && !event.clusterId) || !wanted(spec.type)) continue;
      try {
        const built = spec.build(event, { withBody: false });
        if (!built) continue;
        const data = Array.isArray(built) ? built : [built];
        const withBody = spec.body ? spec.build(event, { withBody: true }) : null;
        const bodies = withBody ? (Array.isArray(withBody) ? withBody : [withBody]) : [];
        for (const [i, item] of data.entries()) {
          out.push({ type: spec.type, clusterId: global ? null : event.clusterId, data: item,
            ...(bodies.length === data.length ? { bodyData: bodies[i] } : {}) });
        }
      } catch { /* observation must not change collaboration */ }
    }
    for (const source of this.sources) {
      try { source.observed?.(event); } catch { /* as above */ }
    }
    return out;
  }
}
