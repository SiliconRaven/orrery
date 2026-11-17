// The user's shared skills (docs/files.md「skill」): <dir>/<folder>/SKILL.md, read-only. The Hub only lists their
// names and descriptions for the composer's `$` picker and the envelope note; it never runs a skill, and no other
// file content leaves this module.
import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillInfo { name: string; description: string }

const MAX_READ = 16 * 1024;     // only the start of SKILL.md is read: the frontmatter
const MAX_SKILLS = 500;
const MAX_DESCRIPTION = 300;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function head(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(MAX_READ);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, MAX_READ, 0));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const unquote = (v: string) => (/^(["']).*\1$/s.test(v) ? v.slice(1, -1) : v);

/** `name` and `description` from a YAML frontmatter block: plain or quoted scalars, and `>` / `|` blocks. Nothing else. */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    }
    out[kv[1]] = unquote(value).trim();
  }
  return out;
}

/** Every readable skill under `dir`, by name; a folder without a valid name or a readable SKILL.md is skipped. */
export function listSkills(dir: string | undefined): SkillInfo[] {
  if (!dir) return [];
  let folders: string[];
  try {
    folders = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
  const byName = new Map<string, SkillInfo>();
  for (const folder of folders.sort().slice(0, MAX_SKILLS)) {
    const text = head(join(dir, folder, 'SKILL.md'));
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    const name = fm.name && NAME_RE.test(fm.name) ? fm.name : folder;
    if (!NAME_RE.test(name) || byName.has(name)) continue;
    const description = (fm.description ?? '').replace(/\s+/g, ' ').trim();
    byName.set(name, { name, description: [...description].length > MAX_DESCRIPTION ? `${[...description].slice(0, MAX_DESCRIPTION - 1).join('')}…` : description });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Known skill names a text refers to as `$name`, distinct, in order of appearance. `$` must start a word; trailing
 * `.` `:` `-` are punctuation unless the name itself has them (`$ponytail.` → ponytail). The web page's bodySegments
 * (src/web/public/ui.js) follows the same rule.
 */
export function skillRefs(text: string, names: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/g)) {
    let token = m[1];
    while (token && !names.has(token) && /[.:-]$/.test(token)) token = token.slice(0, -1);
    if (names.has(token) && !found.includes(token)) found.push(token);
  }
  return found;
}
