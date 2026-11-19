// Where each supported app keeps its user-level skills and MCP servers, and a read-only view of them for the
// "技能与 MCP" page (docs/files.md「各应用的 skill 和 MCP」, location table in docs/architecture.md). orrery only reads
// these places; the one place it writes is the shared skills folder (skill-install.ts).
//
// What leaves this module from an app's MCP config is a server's name, its transport and a target reduced to the
// program's base name or the URL's scheme and host. Arguments, environment, headers, URL path/query/user info and
// working directories are never copied out, and config contents are never logged: a parse error is only a state.
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { installFromFolder, installFromZip, localFolderPath, InstallRefused, type Installed } from './skill-install.ts';
import { head, isSkillName, MAX_SKILLS, skillInfoOf } from './skills.ts';

export type SkillSource = 'user' | 'builtin';
interface SkillLocation { dir: string; label: string; source: SkillSource }
interface McpLocation { file: string; label: string; format: 'json' | 'toml'; key: string[] }
/** null: orrery does not know where this app keeps them (the page says 暂不支持). */
export interface AppLocations { app: string; skills: SkillLocation[] | null; mcp: McpLocation[] | null }

type Env = Record<string, string | undefined>;

/**
 * The location table. `home` is the user's home folder, `env` the environment (the same overrides the adapters honour:
 * CLAUDE_CONFIG_DIR, CODEX_HOME, ZCODE_HOME, WORKBUDDY_CONFIG_DIR, DSH_HOME, APPDATA). Labels are what the page shows:
 * `~/…` or the variable's name, never the user's own path.
 */
export function appLocations(home: string, env: Env = {}): AppLocations[] {
  const base = (variable: string | null, rel: string) => variable && env[variable]
    ? { path: env[variable]!, label: `$${variable}` } : { path: join(home, ...rel.split('/')), label: `~/${rel}` };
  const under = (b: { path: string; label: string }, rel: string) => ({ path: join(b.path, ...rel.split('/')), label: `${b.label}/${rel}` });
  const skills = (b: { path: string; label: string }, source: SkillSource = 'user'): SkillLocation => ({ dir: b.path, label: b.label, source });
  const json = (b: { path: string; label: string }, ...key: string[]): McpLocation => ({ file: b.path, label: b.label, format: 'json', key });
  const claude = base('CLAUDE_CONFIG_DIR', '.claude');
  const appData = env.APPDATA ? { path: env.APPDATA, label: '%APPDATA%' } : { path: join(home, 'AppData', 'Roaming'), label: '%APPDATA%' };
  const codex = base('CODEX_HOME', '.codex');
  const zcode = base('ZCODE_HOME', '.zcode');
  const workbuddy = base('WORKBUDDY_CONFIG_DIR', '.workbuddy');
  const dsh = base('DSH_HOME', '.dsh');
  return [
    { app: 'claude', skills: [skills(under(claude, 'skills'))], mcp: [
      // Claude Code keeps user-scope servers in ~/.claude.json, or in <CLAUDE_CONFIG_DIR>/.claude.json when that is set.
      json(env.CLAUDE_CONFIG_DIR ? under(claude, '.claude.json') : base(null, '.claude.json'), 'mcpServers'),
      json(under(appData, 'Claude/claude_desktop_config.json'), 'mcpServers'),
    ] },
    { app: 'codex', skills: [skills(under(codex, 'skills')), skills(under(codex, 'skills/.system'), 'builtin')],
      mcp: [{ ...json(under(codex, 'config.toml')), format: 'toml', key: ['mcp_servers'] }] },
    { app: 'deepseek', skills: [skills(under(dsh, 'skills'))], mcp: null },
    { app: 'kimi', skills: null, mcp: null },
    { app: 'zcode', skills: [skills(under(zcode, 'skills'))], mcp: [json(under(zcode, 'cli/config.json'), 'mcp', 'servers')] },
    { app: 'antigravity', skills: [skills(base(null, '.gemini/config/skills')), skills(base(null, '.gemini/antigravity/builtin/skills'), 'builtin')],
      mcp: [json(base(null, '.gemini/config/mcp_config.json'), 'mcpServers')] },
    { app: 'qoder', skills: [skills(base(null, '.qoder/skills'))], mcp: null },
    { app: 'workbuddy', skills: [skills(under(workbuddy, 'skills'))], mcp: [json(under(workbuddy, 'mcp.json'), 'mcpServers')] },
    { app: 'cursor', skills: [skills(base(null, '.cursor/skills')), skills(base(null, '.cursor/skills-cursor'), 'builtin')],
      mcp: [json(base(null, '.cursor/mcp.json'), 'mcpServers')] },
  ];
}

export type LocationState = 'ok' | 'missing' | 'unreadable' | 'invalid' | 'too_large';
export interface SkillEntry { name: string; description: string; link: boolean; folder: string }

/**
 * The skills directly in `dir`: each folder holding a SKILL.md that is a regular file. Entries are lstat'ed, never
 * followed: a link or junction is listed by its own name, marked `link`, without reading anything behind it. Dot
 * folders are skipped; at most MAX_SKILLS entries are looked at.
 */
function readSkillFolder(dir: string): { state: LocationState; skills: SkillEntry[] } {
  let names: string[];
  try {
    const st = lstatSync(dir);   // the folder itself may be a link the user made; what is inside is never followed
    if (!st.isDirectory() && !st.isSymbolicLink()) return { state: 'invalid', skills: [] };
    names = readdirSync(dir);
  } catch (e) {
    return { state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', skills: [] };
  }
  const skills: SkillEntry[] = [];
  for (const folder of names.filter((n) => !n.startsWith('.')).sort().slice(0, MAX_SKILLS)) {
    try {
      const st = lstatSync(join(dir, folder));
      if (st.isSymbolicLink()) {
        if (isSkillName(folder)) skills.push({ name: folder, description: '', link: true, folder });
        continue;
      }
      if (!st.isDirectory() || !lstatSync(join(dir, folder, 'SKILL.md')).isFile()) continue;
      const info = skillInfoOf(folder, head(join(dir, folder, 'SKILL.md')) ?? '');
      if (info) skills.push({ ...info, link: false, folder });
    } catch { /* gone or unreadable: skipped */ }
  }
  return { state: 'ok', skills };
}

// ---- MCP configs ----

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_SERVERS = 200;
export interface McpServer { name: string; transport: string; target: string }

/** A file's text, at most MAX_CONFIG_BYTES, read through one handle; never followed when it is a link. */
function readConfig(file: string): { state: LocationState; text?: string } {
  let fd: number | undefined;
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return { state: 'invalid' };
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > MAX_CONFIG_BYTES) return { state: 'too_large' };
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (!n) break;
      read += n;
    }
    return { state: 'ok', text: buf.toString('utf8', 0, read).replace(/^﻿/, '') };
  } catch (e) {
    return { state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The program's base name from a `command` value, or '' when it does not look like a plain program name. Only the
 * first token: a quoted path, a Windows path up to its .exe/.cmd/.bat/.com, else up to the first space. A token with
 * anything but letters, digits and `. _ + -` (an `A=B` environment prefix, say) gives ''.
 */
export function programName(command: unknown): string {
  if (typeof command !== 'string') return '';
  const s = command.trim();
  let first: string;
  const quoted = /^(["'])(.*?)\1/.exec(s);
  if (quoted) first = quoted[2];
  else if (/^[A-Za-z]:[\\/]/.test(s)) first = /^.*?\.(exe|cmd|bat|com)(?=\s|$)/i.exec(s)?.[0] ?? s.split(/\s/)[0];
  else first = s.split(/\s/)[0];
  const name = first.split(/[\\/]/).pop() ?? '';
  return /^[A-Za-z0-9._+-]{1,64}$/.test(name) ? name : '';
}

/** `scheme://host[:port]` of a URL value (http, https, ws, wss), or ''. Never the user info, path, query or fragment. */
export function urlTarget(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url.trim());
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) || !u.hostname) return '';
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '';
  }
}

const TRANSPORTS: Record<string, string> = { stdio: 'stdio', http: 'http', 'streamable-http': 'http', streamablehttp: 'http', sse: 'sse', ws: 'ws', websocket: 'ws' };

/** One server entry reduced to what the page shows. `raw` is the app's object for it; only a few keys are looked at. */
export function reduceServer(name: string, raw: unknown): McpServer {
  const safeName = [...name.replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, 64).join('') || '(无名)';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { name: safeName, transport: 'unknown', target: '' };
  const r = raw as Record<string, unknown>;
  const declared = ['type', 'transport'].map((key) => Object.hasOwn(r, key) ? r[key] : undefined)
    .find((v) => typeof v === 'string' && Object.hasOwn(TRANSPORTS, v.toLowerCase())) as string | undefined;
  const command = Object.hasOwn(r, 'command') ? r.command : undefined;
  const urls = ['url', 'serverUrl', 'httpUrl'].map((key) => Object.hasOwn(r, key) ? r[key] : undefined);
  const url = urls.find((v) => typeof v === 'string');
  const transport = declared ? TRANSPORTS[declared.toLowerCase()] : typeof command === 'string' ? 'stdio'
    : typeof urls[2] === 'string' ? 'http' : url !== undefined ? 'http' : 'unknown';
  const target = transport === 'stdio' ? programName(command) : urlTarget(url);
  return { name: safeName, transport, target };
}

/** The object at `key` in a JSON config, as name → entry, or null when it is not there. */
function jsonServers(text: string, key: string[]): Record<string, unknown> | null | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  for (const k of key) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    value = Object.hasOwn(value, k) ? (value as Record<string, unknown>)[k] : null;
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Parse the whole TOML document, then select only its own MCP server table. */
export function tomlServers(text: string): Record<string, unknown> | null | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text, { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'keep' });
  } catch {
    return undefined;   // parser diagnostics can contain config values; only the invalid state leaves this module
  }
  const servers = Object.hasOwn(parsed, 'mcp_servers') ? parsed.mcp_servers : null;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers as Record<string, unknown> : null;
}

/** The servers of one MCP config file, reduced. */
function readMcpConfig(loc: Pick<McpLocation, 'file' | 'format' | 'key'>): { state: LocationState; servers: McpServer[] } {
  const { state, text } = readConfig(loc.file);
  if (text === undefined) return { state, servers: [] };
  const found = loc.format === 'toml' ? tomlServers(text) : jsonServers(text, loc.key);
  if (found === undefined) return { state: 'invalid', servers: [] };
  return { state: 'ok', servers: Object.entries(found ?? {}).slice(0, MAX_SERVERS).map(([name, raw]) => reduceServer(name, raw)) };
}

// ---- the page's view ----

export interface AppReport {
  app: string;
  status: 'ok' | 'not_found' | 'unsupported';
  skillsSupported: boolean;
  mcpSupported: boolean;
  skills: { name: string; description: string; source: SkillSource; link: boolean; inShared: boolean }[];
  mcpServers: (McpServer & { config: string })[];
  locations: { kind: 'skills' | 'mcp'; label: string; state: LocationState }[];
}
export interface ExtensionsReport {
  shared: { configured: boolean; label: string; state: LocationState; skills: { name: string; description: string; link: boolean }[] };
  apps: AppReport[];
}

const key = (name: string) => name.toLowerCase();   // Windows folder names ignore case

/**
 * The page's view and its install actions. `home` absent: no app is listed (tests never read the real home folder);
 * `sharedDir` absent: nothing can be installed.
 */
export class AppExtensions {
  private readonly home: string | undefined;
  private readonly env: Env;
  private readonly sharedDir: string | undefined;
  private readonly sharedLabel: string;

  constructor(opts: { home?: string; env?: Env; sharedDir?: string; sharedLabel?: string }) {
    this.home = opts.home;
    this.env = opts.env ?? {};
    this.sharedDir = opts.sharedDir;
    this.sharedLabel = opts.sharedLabel ?? (this.env.ORRERY_SKILLS_DIR ? '$ORRERY_SKILLS_DIR' : '~/.agents/skills');
  }

  private locations(): AppLocations[] {
    return this.home ? appLocations(this.home, this.env) : [];
  }

  list(): ExtensionsReport {
    const shared = this.sharedDir ? readSkillFolder(this.sharedDir) : { state: 'missing' as const, skills: [] };
    const inShared = new Set(shared.skills.map((s) => key(s.name)));
    const apps = this.locations().map((loc): AppReport => {
      const locations: AppReport['locations'] = [];
      const skills: AppReport['skills'] = [];
      for (const where of loc.skills ?? []) {
        const read = readSkillFolder(where.dir);
        locations.push({ kind: 'skills', label: where.label, state: read.state });
        for (const s of read.skills) skills.push({ name: s.name, description: s.description, source: where.source, link: s.link, inShared: inShared.has(key(s.name)) });
      }
      const mcpServers: AppReport['mcpServers'] = [];
      for (const where of loc.mcp ?? []) {
        const read = readMcpConfig(where);
        locations.push({ kind: 'mcp', label: where.label, state: read.state });
        mcpServers.push(...read.servers.map((s) => ({ ...s, config: where.label })));
      }
      const status = !loc.skills && !loc.mcp ? 'unsupported' : locations.every((l) => l.state === 'missing') ? 'not_found' : 'ok';
      return { app: loc.app, status, skillsSupported: !!loc.skills, mcpSupported: !!loc.mcp, skills, mcpServers, locations };
    });
    return {
      shared: { configured: !!this.sharedDir, label: this.sharedLabel, state: shared.state, skills: shared.skills.map(({ name, description, link }) => ({ name, description, link })) },
      apps,
    };
  }

  /** Copies an app's skill, found by listing the app again: the request names it, never a path. */
  async installFromApp(app: unknown, skill: unknown, source: unknown, overwrite: boolean): Promise<Installed> {
    const loc = this.locations().find((l) => l.app === app);
    if (!loc) throw new InstallRefused('unknown_app', 'no such app');
    if (!isSkillName(skill)) throw new InstallRefused('unknown_skill', 'no such skill in this app');
    const order = (loc.skills ?? []).filter((w) => source === undefined || w.source === source);
    for (const where of order) {
      const found = readSkillFolder(where.dir).skills.find((s) => s.name === skill);
      if (found?.link) throw new InstallRefused('skill_is_link', 'this skill is a link to another folder; install the folder it points to instead');
      if (found) return installFromFolder(this.sharedDir, join(where.dir, found.folder), overwrite);
    }
    throw new InstallRefused('unknown_skill', 'no such skill in this app');
  }

  async installFromPath(path: unknown, overwrite: boolean): Promise<Installed> {
    return installFromFolder(this.sharedDir, localFolderPath(path), overwrite);
  }

  async installFromZip(zip: Buffer, fileName: string, overwrite: boolean): Promise<Installed> {
    return installFromZip(this.sharedDir, zip, fileName, overwrite);
  }
}
