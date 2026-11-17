// Owns <home>/tool-list.json: each tool profile's MCP tool list as of the last start, and the native members whose next
// envelope still has to say what changed (docs/native-mode.md「工具清单更新提示」). Failures are logged, never thrown.
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { ToolProfile } from './types.ts';

/** One profile's tools/list: its fingerprint, and each tool's parameter names (inputSchema.properties, sorted). */
export interface ToolListSnapshot { fingerprint: string; tools: Record<string, string[]> }
export type ToolLists = Partial<Record<ToolProfile, ToolListSnapshot>>;
/** The file: `pending` maps a member id to the changes it has not been told yet. */
interface ToolListFile { profiles: ToolLists; pending: Record<string, string[]> }

const MAX_ITEMS = 6;
export const DESCRIPTIONS_ONLY = '工具说明有更新';

/** What changed between two summaries: parameter changes first, then added and removed tools. Empty: same names. */
export function toolChanges(before: Record<string, string[]>, after: Record<string, string[]>): string[] {
  const params: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const name of Object.keys(after).sort()) {
    if (!Object.hasOwn(before, name)) { added.push(`新增工具 ${name}`); continue; }
    const more = after[name].filter((p) => !before[name].includes(p));
    const less = before[name].filter((p) => !after[name].includes(p));
    if (more.length) params.push(`${name} 新增参数 ${more.join('、')}`);
    if (less.length) params.push(`${name} 移除参数 ${less.join('、')}`);
  }
  for (const name of Object.keys(before).sort()) if (!Object.hasOwn(after, name)) removed.push(`移除工具 ${name}`);
  return [...params, ...added, ...removed];
}

/** The envelope sentence for these changes ('' for none). Conditional: the Hub cannot know if the session refreshed. */
export function toolHintText(items: string[]): string {
  if (!items.length) return '';
  const list = items.length > MAX_ITEMS ? `${items.slice(0, MAX_ITEMS).join('；')}，等 ${items.length} 项` : items.join('；');
  return `orrery 工具在 Hub 重启后有更新：${list}。如果你的工具说明里没有这些，说明你的会话还在用旧的工具清单：新参数可以试着直接传，或请用户重连 orrery、重新打开对话。`;
}

function parse(text: string): ToolListFile | null {
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  const recordOf = (x: unknown, ok: (v: unknown) => boolean) =>
    !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every(ok);
  try {
    const v = JSON.parse(text);
    const profile = (p: unknown) => recordOf(p, () => true) && typeof (p as ToolListSnapshot).fingerprint === 'string'
      && recordOf((p as ToolListSnapshot).tools, strings);
    return recordOf(v?.profiles, profile) && recordOf(v.pending, strings) ? v : null;
  } catch { return null; }
}

export class ToolListMemory {
  private readonly file: string;
  private readonly log: (line: string) => void;
  private profiles: ToolLists = {};
  private pending = new Map<string, string[]>();   // empty until compare(): a delivery before it carries no hint

  constructor(file: string, log: (line: string) => void = (line) => console.error(line)) {
    this.file = file;
    this.log = log;
  }

  /**
   * Once per start, with the current lists and the current native members. A changed profile makes its members
   * pending; a member already pending keeps its older changes and gains the new ones (deduplicated). Ids no longer
   * among `members` are dropped. No file or a broken one: nothing pending, the current lists are stored.
   */
  compare(current: ToolLists, members: { id: string; profile: ToolProfile }[]): void {
    let stored: ToolListFile | null = null;
    try {
      stored = parse(readFileSync(this.file, 'utf8'));
      if (!stored) this.log('tool list file unreadable, starting over');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`tool list file not read: ${e instanceof Error ? e.message : e}`);
    }
    const ids = new Set(members.map((m) => m.id));
    const pending = new Map(Object.entries(stored?.pending ?? {}).filter(([id]) => ids.has(id)));
    for (const [profile, now] of Object.entries(current) as [ToolProfile, ToolListSnapshot][]) {
      const before = stored?.profiles[profile];
      if (!before || before.fingerprint === now.fingerprint) continue;
      const changes = toolChanges(before.tools, now.tools);
      if (!changes.length) changes.push(DESCRIPTIONS_ONLY);
      for (const m of members) if (m.profile === profile) pending.set(m.id, [...new Set([...(pending.get(m.id) ?? []), ...changes])]);
    }
    this.profiles = current;
    this.pending = pending;
    this.save();
  }

  /** The sentence for the member's next envelope, or ''. */
  hint(memberId: string): string {
    return toolHintText(this.pending.get(memberId) ?? []);
  }

  /** A run that carried the hint ended done. Forgotten in memory even if the file cannot be written (told again next start). */
  told(memberId: string): void {
    if (this.pending.delete(memberId)) this.save();
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data: ToolListFile = { profiles: this.profiles, pending: Object.fromEntries(this.pending) };
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      renameSync(tmp, this.file);   // whole file or the old one, never half
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* keep the write error */ }
      this.log(`tool list file not saved: ${e instanceof Error ? e.message : e}`);
    }
  }
}
