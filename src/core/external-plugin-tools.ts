// Tools a third-party plugin provides to members (docs/external-plugins.md「群员工具」): the manifest declaration and its
// restricted JSON-Schema subset, the name members see, the argument and result checks, and the call budgets. Pure
// except for the clock the budgets are given. Every dictionary keyed by an outside name is a Map or read as an own key.
import { cleanText } from './external-plugin-commands.ts';

/**
 * The bounds of plugin tools. Every member pays for each listed tool on every model call (its name, description and
 * schema sit in the tool list), so a plugin may declare few and short ones. A call waits at most `timeoutMs`; a
 * timeout fails only that call, never the plugin. `inFlightPerPlugin` bounds tool calls inside the 8 pending requests a
 * plugin may have that are not message checks (MAX_OTHER_PENDING in external-plugin-process.ts), which leaves its message
 * checks (messages.gate) at least 8 of its 16 slots. The two rates are sliding windows of one minute; only calls
 * actually written to the plugin count against them.
 */
export const TOOL_LIMITS = Object.freeze({
  maxTools: 8,
  maxDescription: 300,
  maxProperties: 16,
  maxPropertyDescription: 200,
  maxEnum: 50,
  maxEnumValue: 100,
  /** The JSON of one tool's name, description and inputSchema, and of all of a plugin's tools together. */
  maxToolBytes: 4 * 1024,
  maxPluginToolBytes: 16 * 1024,
  /** The name members see: `mcp__orrery__` (13 characters, how Claude Code names MCP tools) + 48 stays within the 64 of model APIs. */
  maxMemberName: 48,
  timeoutMs: 10_000,
  /** The arguments' JSON (UTF-8) a call may carry: well inside one 64 KiB protocol frame with its envelope and context. */
  maxArgumentBytes: 16 * 1024,
  /** The JSON (UTF-8) of the plugin's `{text, data}` answer. */
  maxResultBytes: 16 * 1024,
  perMemberPerMinute: 30,
  perPluginPerMinute: 120,
  inFlightPerPlugin: 4,
  /** The plugin's own error text the member gets (never the chat record). */
  maxErrorText: 300,
});

/** Every name members see starts with this; no official tool may (a test checks), so none can collide. */
const MEMBER_TOOL_PREFIX = 'p_';
const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const PROPERTY_NAME = /^[a-z][A-Za-z0-9_]{0,31}$/;
/** The Hub adds this argument itself (which of the conversation's clusters the call is for); a tool cannot declare it. */
const CLUSTER_ARGUMENT = 'clusterId';
const CLUSTER_ARGUMENT_HELP = 'Cluster ID from the orrery envelope; needed when this conversation is in several clusters.';

/**
 * A plugin id has no `_` (lowercase letters, digits and `-`), so the first `_` after the prefix ends it: no two
 * plugin-tool pairs give the same name, and none is an official tool (MEMBER_TOOL_PREFIX).
 */
export const memberToolName = (pluginId: string, tool: string): string => `${MEMBER_TOOL_PREFIX}${pluginId}_${tool}`;

type Scalar =
  | { type: 'string'; minLength?: number; maxLength?: number; enum?: string[] }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' };
type ToolProperty = (Scalar | { type: 'array'; items: Scalar; minItems?: number; maxItems?: number }) & { description?: string };
export interface ExternalTool {
  name: string;
  description: string;
  /** In declaration order; a Map, so a property may be called `constructor` or `toString`. */
  properties: Map<string, ToolProperty>;
  required: string[];
}

/**
 * Whether a tool name is a third-party plugin's (the prefix no official tool has). The Claude bridge keeps a copy of
 * this rule (it may import no Hub module) to leave plugin tools out of the fingerprint it reports.
 */
export const isPluginToolName = (name: string): boolean => name.startsWith(MEMBER_TOOL_PREFIX);

const SCALARS = ['string', 'number', 'integer', 'boolean'];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Text the model reads (a description, an enum value) may hold no control, format or line characters. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A description as members' models see it: one line, control, format and bidi characters removed, newlines and runs of
 * spaces turned into one space (cleanText), at most `max` characters. Blank before or after cleaning: refused.
 */
function description(value: unknown, max: number, bad: () => Error): string {
  if (typeof value !== 'string' || value.length > max) throw bad();
  const clean = cleanText(value, max);
  if (!clean) throw bad();
  return clean;
}

function scalar(entry: Record<string, unknown>, bad: (what: string) => Error, allowDescription: boolean): Scalar & { description?: string } {
  const type = entry.type;
  if (typeof type !== 'string' || !SCALARS.includes(type)) throw bad('type');
  const allowed = [...(allowDescription ? ['description'] : []), 'type',
    ...(type === 'string' ? ['minLength', 'maxLength', 'enum'] : type === 'boolean' ? [] : ['minimum', 'maximum'])];
  if (Object.keys(entry).some((key) => !allowed.includes(key))) throw bad('field');
  const out: Record<string, unknown> = { type };
  if (entry.description !== undefined) {
    out.description = description(entry.description, TOOL_LIMITS.maxPropertyDescription, () => bad('description'));
  }
  const count = (key: string) => {
    const n = entry[key];
    if (n === undefined) return;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw bad(key);
    out[key] = n;
  };
  const finite = (key: string) => {
    const n = entry[key];
    if (n === undefined) return;
    if (typeof n !== 'number' || !Number.isFinite(n) || (type === 'integer' && !Number.isSafeInteger(n))) throw bad(key);
    out[key] = n;
  };
  if (type === 'string') {
    count('minLength'); count('maxLength');
    if (entry.enum !== undefined) {
      const list = entry.enum;
      if (!Array.isArray(list) || !list.length || list.length > TOOL_LIMITS.maxEnum
        || list.some((v) => typeof v !== 'string' || !v || v.length > TOOL_LIMITS.maxEnumValue || CONTROL.test(v)) || new Set(list).size !== list.length) throw bad('enum');
      out.enum = [...list];
    }
    if ((out.minLength as number ?? 0) > (out.maxLength as number ?? Infinity)) throw bad('bounds');
  } else if (type !== 'boolean') {
    finite('minimum'); finite('maximum');
    if ((out.minimum as number ?? -Infinity) > (out.maximum as number ?? Infinity)) throw bad('bounds');
  }
  return out as Scalar & { description?: string };
}

function property(value: unknown, bad: (what: string) => Error): ToolProperty {
  if (!isObject(value)) throw bad('property');
  if (value.type !== 'array') return scalar(value, bad, true);
  if (Object.keys(value).some((key) => !['type', 'description', 'items', 'minItems', 'maxItems'].includes(key))) throw bad('field');
  if (!isObject(value.items)) throw bad('items');
  const items = scalar(value.items, bad, false);   // one level: arrays of scalars only, no nested arrays or objects
  const out: Record<string, unknown> = { type: 'array', items };
  if (value.description !== undefined) {
    out.description = description(value.description, TOOL_LIMITS.maxPropertyDescription, () => bad('description'));
  }
  for (const key of ['minItems', 'maxItems']) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw bad(key);
    out[key] = n;
  }
  if ((out.minItems as number ?? 0) > (out.maxItems as number ?? Infinity)) throw bad('bounds');
  return out as ToolProperty;
}

/** The inputSchema members see: exactly the declared subset, plus the Hub's own clusterId; nothing else is accepted. */
export function listedSchema(tool: ExternalTool): Record<string, unknown> {
  return {
    properties: Object.fromEntries([...tool.properties, [CLUSTER_ARGUMENT, { type: 'string', description: CLUSTER_ARGUMENT_HELP }]]),
    ...(tool.required.length ? { required: [...tool.required] } : {}),
    additionalProperties: false,
  };
}

const declarationBytes = (tool: ExternalTool) => Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description,
  inputSchema: { type: 'object', properties: Object.fromEntries(tool.properties), required: tool.required } }));

/**
 * A manifest's `tools`. Strict: an unknown field, type or keyword (`$ref`, `pattern`, nested objects, `default`...), a
 * bad bound, a duplicate name or a name members would see longer than maxMemberName skips the plugin like any other
 * manifest error. `clusterId` is reserved (the Hub adds it).
 */
export function parseTools(value: unknown, pluginId: string): ExternalTool[] {
  if (!Array.isArray(value) || value.length > TOOL_LIMITS.maxTools) throw new Error(`plugin ${pluginId}: invalid tools (at most ${TOOL_LIMITS.maxTools})`);
  let total = 0;
  const tools = value.map((item) => {
    if (!isObject(item) || Object.keys(item).some((key) => !['name', 'description', 'inputSchema'].includes(key))) throw new Error(`plugin ${pluginId}: invalid tool`);
    const name = item.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw new Error(`plugin ${pluginId}: invalid tool name`);
    if (memberToolName(pluginId, name).length > TOOL_LIMITS.maxMemberName) {
      throw new Error(`plugin ${pluginId}: tool ${name} would be named ${memberToolName(pluginId, name)}, longer than ${TOOL_LIMITS.maxMemberName} characters`);
    }
    const bad = (what: string) => new Error(`plugin ${pluginId}: tool ${name}: invalid ${what}`);
    const text = description(item.description, TOOL_LIMITS.maxDescription, () => bad('description'));
    const schema = item.inputSchema;
    if (!isObject(schema) || Object.keys(schema).some((key) => !['type', 'properties', 'required', 'additionalProperties'].includes(key))
      || schema.type !== 'object' || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) throw bad('inputSchema');
    const declared = schema.properties ?? {};
    if (!isObject(declared) || Object.keys(declared).length > TOOL_LIMITS.maxProperties) throw bad('properties');
    const properties = new Map<string, ToolProperty>();
    for (const key of Object.keys(declared)) {
      if (!PROPERTY_NAME.test(key) || key === CLUSTER_ARGUMENT) throw bad(`property name ${JSON.stringify(key.slice(0, 40))}`);
      properties.set(key, property(declared[key], bad));
    }
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string' || !properties.has(key)) || new Set(required).size !== required.length) throw bad('required');
    const tool: ExternalTool = { name, description: text, properties, required: [...required] as string[] };
    const bytes = declarationBytes(tool);
    if (bytes > TOOL_LIMITS.maxToolBytes) throw bad(`size (${bytes} bytes; at most ${TOOL_LIMITS.maxToolBytes})`);
    total += bytes;
    return tool;
  });
  if (total > TOOL_LIMITS.maxPluginToolBytes) throw new Error(`plugin ${pluginId}: tools are ${total} bytes together; at most ${TOOL_LIMITS.maxPluginToolBytes}`);
  if (new Set(tools.map((t) => t.name)).size !== tools.length) throw new Error(`plugin ${pluginId}: duplicate tool`);
  return tools;
}

/** A refused or failed tool call: a stable `code` and a sentence for the member. */
export class ToolRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const quote = (name: string) => JSON.stringify(name.length > 40 ? `${name.slice(0, 40)}…` : name);
const codePoints = (s: string) => { let n = 0; for (const _ of s) n++; return n; };

function scalarOk(spec: Scalar, value: unknown): boolean {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return false;
      if (spec.enum && !spec.enum.includes(value)) return false;
      const length = codePoints(value);   // JSON Schema counts characters (code points), as the member's model does
      return length >= (spec.minLength ?? 0) && length <= (spec.maxLength ?? Infinity);
    }
    case 'boolean': return typeof value === 'boolean';
    default:
      return typeof value === 'number' && Number.isFinite(value) && (spec.type !== 'integer' || Number.isInteger(value))
        && value >= (spec.minimum ?? -Infinity) && value <= (spec.maximum ?? Infinity);
  }
}

/**
 * The arguments the plugin gets: an object with only declared names (own keys, so `__proto__` sent by a member is an
 * unknown name, not a prototype), each of its declared type and bounds, every required one present; null is no value
 * of any type. Built fresh in declaration order. Anything else is INVALID_ARGUMENT, and the plugin never sees the call.
 */
export function validateToolArguments(tool: ExternalTool, raw: unknown): Record<string, unknown> {
  const input = raw === undefined ? {} : raw;
  if (!isObject(input)) throw new ToolRefusal('INVALID_ARGUMENT', '参数须是一个 JSON 对象。');
  const bytes = Buffer.byteLength(JSON.stringify(input));
  if (bytes > TOOL_LIMITS.maxArgumentBytes) throw new ToolRefusal('INVALID_ARGUMENT', `参数合计 ${bytes} 字节，超过 ${TOOL_LIMITS.maxArgumentBytes} 字节的上限。`);
  const unknown = Object.keys(input).find((key) => !tool.properties.has(key));
  if (unknown !== undefined) throw new ToolRefusal('INVALID_ARGUMENT', `这个工具没有参数 ${quote(unknown)}。`);
  const values: [string, unknown][] = [];
  for (const [name, spec] of tool.properties) {
    if (!Object.hasOwn(input, name)) {
      if (tool.required.includes(name)) throw new ToolRefusal('INVALID_ARGUMENT', `缺少必填参数 ${quote(name)}。`);
      continue;
    }
    const value = input[name];
    const ok = spec.type === 'array'
      ? Array.isArray(value) && value.length >= (spec.minItems ?? 0) && value.length <= (spec.maxItems ?? Infinity) && value.every((v) => scalarOk(spec.items, v))
      : scalarOk(spec, value);
    if (!ok) throw new ToolRefusal('INVALID_ARGUMENT', `参数 ${quote(name)} 不符合这个工具的说明（类型、范围或选项不对）。`);
    values.push([name, spec.type === 'array' ? [...value as unknown[]] : value]);
  }
  return Object.fromEntries(values);
}

/** What the member gets back: the plugin's text (control characters removed) and/or its data as JSON. */
export interface ToolAnswer { text?: string; data?: unknown }

/**
 * The plugin's answer to tool.call: an object with a string `text` and/or any JSON `data` (other fields are ignored),
 * at most maxResultBytes of JSON together. Malformed answers are TOOL_FAILED, big ones RESULT_TOO_LARGE.
 */
export function toolAnswer(answer: unknown): ToolAnswer {
  if (!isObject(answer)) throw new ToolRefusal('TOOL_FAILED', '插件的回答格式不对。');
  const text = answer.text;
  const hasData = Object.hasOwn(answer, 'data') && answer.data !== undefined;
  if ((text !== undefined && typeof text !== 'string') || (text === undefined && !hasData)) throw new ToolRefusal('TOOL_FAILED', '插件的回答格式不对。');
  const bytes = Buffer.byteLength(JSON.stringify({ text, data: hasData ? answer.data : undefined }));
  if (bytes > TOOL_LIMITS.maxResultBytes) throw new ToolRefusal('RESULT_TOO_LARGE', `插件的回答有 ${bytes} 字节，超过 ${TOOL_LIMITS.maxResultBytes} 字节的上限，没有交回。`);
  return { ...(typeof text === 'string' ? { text: cleanText(text, TOOL_LIMITS.maxResultBytes, true) } : {}), ...(hasData ? { data: answer.data } : {}) };
}

/** The plugin's own error text, as one short line of plain text ('' when it gave none). */
export const pluginErrorText = (value: unknown): string => (typeof value === 'string' ? cleanText(value, TOOL_LIMITS.maxErrorText) : '');

/**
 * Sliding one-minute windows of sent calls, per key. A key's times are pruned whenever it is looked at, and at most
 * once a window every key is swept (amortised over the calls), so a key whose last call is older than two windows is
 * gone: the memory holds only the callers of about the last two minutes, not everyone who ever called once.
 */
export class CallWindows {
  private readonly times = new Map<string, number[]>();
  private readonly windowMs: number;
  private swept = -Infinity;
  constructor(windowMs = 60_000) { this.windowMs = windowMs; }
  private recent(key: string, now: number): number[] {
    if (now - this.swept >= this.windowMs) {
      this.swept = now;
      for (const [other, list] of this.times) if (list.every((at) => now - at >= this.windowMs)) this.times.delete(other);
    }
    const list = (this.times.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length) this.times.set(key, list); else this.times.delete(key);
    return list;
  }
  /** How many keys are remembered (for tests). */
  get size(): number { return this.times.size; }
  full(key: string, limit: number, now: number): boolean { return this.recent(key, now).length >= limit; }
  take(key: string, now: number): void { this.times.set(key, [...this.recent(key, now), now]); }
}
