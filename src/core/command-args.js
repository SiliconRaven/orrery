// The argument rules of plugin commands (docs/external-plugins.md「命令」), one copy for both sides: the Hub checks what
// it passes to a plugin with these, and the page (served as /core/command-args.js, re-exported by
// web/public/command-args.js) checks its form with the same functions and words. Pure: no imports, no DOM, no Node.

/** Longest text argument, in UTF-16 units. */
export const MAX_TEXT_ARGUMENT = 2000;
/** A duration is at least 1 second and, unless the command says otherwise, at most 30 days. */
export const MAX_DURATION_SECONDS = 30 * 24 * 3600;

/** The bounds a number or duration argument must stay within: the declared ones, else the type's own. */
export function paramBounds(param) {
  const duration = param.type === 'duration';
  return { min: param.min ?? (duration ? 1 : -Number.MAX_VALUE), max: param.max ?? (duration ? MAX_DURATION_SECONDS : Number.MAX_VALUE) };
}

// Every number carries its unit (`1h30m`, `15m`, `900s`); a bare number alone is seconds. `1h30` is refused: it would
// read as 1 h 30 s, and people mean 90 minutes.
const WITH_UNITS = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?\s*$/i;
const SECONDS = /^\s*(\d+)\s*$/;
/** Whole seconds from a whole number of seconds or text like `15m`, `900s`, `1h30m`, `90`; null when it is neither. */
export function parseDuration(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string' || !value.trim() || value.length > 32) return null;
  const bare = SECONDS.exec(value);
  if (bare) return Number(bare[1]);
  const m = WITH_UNITS.exec(value);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const describeSeconds = (s) => (s % 3600 === 0 ? `${s / 3600} 小时` : s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒`);

/** Why one argument is not acceptable, in the words shown next to the field (and in the Hub's refusal). */
export function invalidArgument(param) {
  const { min, max } = paramBounds(param);
  const range = param.min !== undefined || param.max !== undefined;
  switch (param.type) {
    case 'text': return `「${param.label}」须是不超过 ${MAX_TEXT_ARGUMENT} 个字符的文字。`;
    case 'number': return range ? `「${param.label}」须是 ${min} 到 ${max} 之间的数字。` : `「${param.label}」须是数字。`;
    case 'duration': return `「${param.label}」须是 ${describeSeconds(min)}到 ${describeSeconds(max)}之间的时长，例如 15m、900s、1h30m；`
      + '每个数字都要带单位（1h30 请写成 1h30m），只写数字表示秒。';
    case 'boolean': return `「${param.label}」须是“是”或“否”。`;
    case 'member': return `「${param.label}」须是本群的成员。`;
    default: return `「${param.label}」须是给出的选项之一。`;
  }
}
export const missingArgument = (param) => `请填写「${param.label}」。`;

/** One argument as the plugin gets it, or undefined when it is not acceptable. `members`: a Set of member ids. */
export function checkArgument(param, value, members) {
  const { min, max } = paramBounds(param);
  switch (param.type) {
    case 'text': return typeof value === 'string' && value.length <= MAX_TEXT_ARGUMENT ? value : undefined;
    case 'number': return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
    case 'duration': {
      const seconds = parseDuration(value);
      return seconds !== null && seconds >= min && seconds <= max ? seconds : undefined;
    }
    case 'boolean': return typeof value === 'boolean' ? value : undefined;
    case 'member': return typeof value === 'string' && members.has(value) ? value : undefined;
    case 'enum': return typeof value === 'string' && (param.options ?? []).includes(value) ? value : undefined;
    default: return undefined;
  }
}
