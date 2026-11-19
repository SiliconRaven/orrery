import { checkArgument, MAX_DURATION_SECONDS, MAX_TEXT_ARGUMENT } from './command-args.js';

export const FIELD_TYPES = ['text', 'number', 'duration', 'boolean', 'enum', 'member', 'path', 'list'] as const;
const FIELD_NAME = /^[a-z][A-Za-z0-9_]{0,31}$/;
const FIELD_PROPERTIES = new Set(['name', 'type', 'label', 'scope', 'required', 'default', 'description', 'options', 'min', 'max']);
const NO_MEMBERS: ReadonlySet<string> = new Set();

export type PluginConfigValue = string | number | boolean | string[];
export type PluginConfigValues = Record<string, PluginConfigValue>;
export interface SavedPluginConfigScope { revision: number; values: PluginConfigValues }
export interface PluginConfigField {
  name: string;
  type: typeof FIELD_TYPES[number];
  label: string;
  scope: 'global' | 'cluster';
  required: boolean;
  default?: PluginConfigValue;
  description?: string;
  options?: string[];
  min?: number;
  max?: number;
}

/** Errors sent to the user identify the declared field without quoting its value. */
export class PluginConfigProblem extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonblank(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0;
}

/** Absolute drive paths or POSIX paths. This is string validation only: no resolving, opening or checking the target. */
function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
    && (/^[A-Za-z]:[\\/]/.test(value) || (value.startsWith('/') && !/^\/[\\/]/.test(value)));
}

/** Member defaults are syntax-checked at registration and checked against the live member set when they are applied. */
function checked(field: PluginConfigField, value: unknown, members: ReadonlySet<string> | undefined, userInput = false): PluginConfigValue | undefined {
  switch (field.type) {
    case 'path': return localPath(value) ? value : undefined;
    case 'member': return nonblank(value, 128) && (!members || members.has(value)) ? value : undefined;
    case 'list': return Array.isArray(value) && value.length <= 64 && (!field.required || value.length > 0)
      && value.every((item) => nonblank(item, MAX_TEXT_ARGUMENT) && !/[\r\n]/.test(item)) ? value.slice() as string[] : undefined;
    case 'text': if (field.required && !nonblank(value, MAX_TEXT_ARGUMENT)) return undefined; break;
    case 'duration': if (!userInput && typeof value !== 'number') return undefined; break;
  }
  // The scalar rules, including how an entered duration becomes integer seconds, also serve plugin command arguments.
  return checkArgument({ ...field, default: undefined }, value, NO_MEMBERS);
}

function parseField(raw: unknown): PluginConfigField {
  if (!record(raw) || typeof raw.name !== 'string' || !FIELD_NAME.test(raw.name)) throw new Error('invalid plugin config field name');
  const bad = (part: string) => new Error('invalid plugin config field ' + raw.name + ' (' + part + ')');
  if (Object.keys(raw).some((key) => !FIELD_PROPERTIES.has(key))) throw bad('unknown property');
  if (!FIELD_TYPES.some((type) => type === raw.type)) throw bad('type');
  if (raw.scope !== 'global' && raw.scope !== 'cluster') throw bad('scope');
  if (!nonblank(raw.label, 60)) throw bad('label');
  if (raw.required !== undefined && typeof raw.required !== 'boolean') throw bad('required');

  const field: PluginConfigField = { name: raw.name, label: raw.label, type: raw.type as PluginConfigField['type'],
    scope: raw.scope, required: raw.required === true };
  if (raw.description !== undefined) {
    if (!nonblank(raw.description, 200)) throw bad('description');
    field.description = raw.description;
  }
  if (field.type === 'enum') {
    const options = raw.options;
    if (!Array.isArray(options) || !options.length || options.length > 50 || !options.every((option) => nonblank(option, 100))
      || new Set(options).size !== options.length) throw bad('options');
    field.options = options.slice() as string[];
  } else if (raw.options !== undefined) throw bad('options');
  for (const key of ['min', 'max'] as const) {
    const bound = raw[key];
    if (bound === undefined) continue;
    if ((field.type !== 'number' && field.type !== 'duration') || typeof bound !== 'number' || !Number.isFinite(bound)
      || (field.type === 'duration' && (!Number.isInteger(bound) || bound < 1 || bound > MAX_DURATION_SECONDS))) throw bad(key);
    field[key] = bound;
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw bad('bounds');
  if (Object.hasOwn(raw, 'default')) {
    const value = checked(field, raw.default, undefined);
    if (value === undefined) throw bad('default');
    field.default = value;
  }
  return field;
}

export function parsePluginConfigFields(raw: unknown): PluginConfigField[] {
  if (!Array.isArray(raw) || raw.length > 32) throw new Error('plugin config must be an array of up to 32 fields');
  const fields = Array.from(raw, parseField);
  if (new Set(fields.map((field) => field.name)).size !== fields.length) throw new Error('duplicate plugin config field name');
  return fields;
}

function sameValue(value: PluginConfigValue, other: PluginConfigValue | undefined): boolean {
  return value === other || (Array.isArray(value) && Array.isArray(other) && value.length === other.length
    && value.every((item, i) => item === other[i]));
}

/** Validate the full submitted scope. Omission/null uses the current default, so later manifest defaults still take effect. */
export function validatePluginConfigValues(fields: readonly PluginConfigField[], raw: unknown, members: ReadonlySet<string>): PluginConfigValues {
  if (!record(raw) || Object.keys(raw).some((name) => !fields.some((field) => field.name === name))) {
    throw new PluginConfigProblem('CONFIG_INVALID', '请提供本范围已声明的配置项。');
  }
  const overrides: [string, PluginConfigValue][] = [];
  for (const field of fields) {
    const input = Object.hasOwn(raw, field.name) ? raw[field.name] : undefined;
    const fallback = checked(field, field.default, members);
    if (input === null || input === undefined) {
      if (field.required && fallback === undefined) throw new PluginConfigProblem('CONFIG_INVALID', '请填写这一项。', field.name);
      continue;
    }
    const value = checked(field, input, members, true);
    if (value === undefined) throw new PluginConfigProblem('CONFIG_INVALID', '此值不符合该项的类型或范围。', field.name);
    if (!sameValue(value, fallback)) overrides.push([field.name, value]);
  }
  return Object.fromEntries(overrides);
}

/** Reinterpret persisted overrides with today's schema and membership. Unconfigured required fields may be filled in later. */
export function effectivePluginConfig(fields: readonly PluginConfigField[], overrides: PluginConfigValues, members: ReadonlySet<string>): PluginConfigValues {
  const values: [string, PluginConfigValue][] = [];
  for (const field of fields) {
    const saved = Object.hasOwn(overrides, field.name) ? checked(field, overrides[field.name], members) : undefined;
    const value = saved ?? checked(field, field.default, members);
    if (value !== undefined) values.push([field.name, value]);
  }
  return Object.fromEntries(values);
}
