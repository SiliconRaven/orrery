import { createHash } from 'node:crypto';
import type { ToolListSnapshot } from '../core/tool-list.ts';
import type { ToolFingerprints, ToolProfile } from '../core/types.ts';

/** Canonical JSON: object-key order is irrelevant; array order and every serialized field are retained. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Fingerprint the tools as transmitted by MCP, not the SDK's internal registered objects. */
export function fingerprintTools<T extends { name: string }>(tools: readonly T[]): string {
  const transmitted = JSON.parse(JSON.stringify(tools)) as { name: string }[];
  transmitted.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return `sha256:${createHash('sha256').update(canonical(transmitted), 'utf8').digest('hex')}`;
}

/** Each tool's parameter names (inputSchema.properties, sorted): what the tool-update hint compares across starts. */
export function summarizeTools(tools: readonly { name: string; inputSchema?: { properties?: object } }[]): Record<string, string[]> {
  return Object.fromEntries(tools.map((t) => [t.name, Object.keys(t.inputSchema?.properties ?? {}).sort()]));
}

/** Just the fingerprints of each profile's list (the member page's tool versions). */
export function fingerprintsOf(lists: Record<ToolProfile, ToolListSnapshot>): ToolFingerprints {
  return Object.fromEntries(Object.entries(lists).map(([profile, list]) => [profile, list.fingerprint])) as ToolFingerprints;
}

/** Share one successful calculation per Hub instance; a failed diagnostic can be retried. */
export function cacheToolFingerprints<T = ToolFingerprints>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => cached ??= load().catch((error) => { cached = undefined; throw error; });
}
