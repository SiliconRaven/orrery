// Fixtures for 技能与 MCP tests (test/app-extensions*.test.ts, the demo Hub): a fake home with several apps' skills and
// MCP configs stuffed with fake secrets, a small ZIP writer, and a junction helper. Never the real home folder.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** Strings planted where a reader must never copy from: env, headers, args, URL user info/path/query, cwd. */
export const SECRETS = ['sk-SECRET-ENV-1', 'SECRET-HEADER-VALUE', 'secret-arg-token', 'userinfo-pass', 'secret-path-seg', 'SECRETQUERY', 'SECRET-CWD', 'SECRET-TOML-ENV', 'TOKEN=inline-secret',
  'FAKE_PRIVATE_ARG_123', 'FAKE_PRIVATE_ENV_456', 'FAKE_PRIVATE_MULTILINE_789', 'FAKE_PRIVATE_PARSE_012'];

export const skillMd = (name: string | null, description = 'does things') => `---\n${name ? `name: ${name}\n` : ''}description: ${description}\n---\n# body\n`;

export function write(path: string, text: string | Buffer) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** A real junction (Windows) or symbolic link to a folder; false when the OS refuses. */
export function junction(target: string, path: string): boolean {
  try { symlinkSync(target, path, 'junction'); return true; } catch { return false; }
}

/** A fixture home with skills and MCP configs of several apps; every secret is somewhere a reader must not copy from. */
export function fixtureHome(root: string): { home: string; shared: string } {
  const home = join(root, 'home');
  const shared = join(home, '.agents', 'skills');
  write(join(shared, 'already', 'SKILL.md'), skillMd('already', 'in the shared folder'));
  write(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha skill'));
  write(join(home, '.claude', 'skills', 'alpha', 'docs', 'more.md'), 'more');
  write(join(home, '.claude', 'skills', 'already', 'SKILL.md'), skillMd(null, 'same name as a shared one'));
  write(join(home, '.claude', 'skills', 'no-skill-md', 'README.md'), 'not a skill');
  write(join(home, '.claude.json'), JSON.stringify({
    projects: { 'C:/SECRET-CWD': { mcpServers: { local: { command: 'node' } } } },
    mcpServers: {
      github: { type: 'stdio', command: 'npx', args: ['-y', 'server', '--token', 'secret-arg-token'], env: { GITHUB_TOKEN: 'sk-SECRET-ENV-1' }, cwd: 'C:/SECRET-CWD' },
      remote: { type: 'http', url: 'https://user:userinfo-pass@api.example.com:8443/secret-path-seg?key=SECRETQUERY#x', headers: { Authorization: 'Bearer SECRET-HEADER-VALUE' } },
      envprefix: { command: 'TOKEN=inline-secret npx server' },
      winpath: { command: 'C:\\Program Files\\nodejs\\node.exe --api-key=secret-arg-token' },
    },
  }));
  write(join(home, '.codex', 'config.toml'), [
    'model = "x"',
    '[mcp_servers.fusion]', 'url = "https://fusion.example.com/secret-path-seg?t=SECRETQUERY"',
    '[mcp_servers."colab mcp"]', 'command = "uvx"', 'args = ["secret-arg-token"]',
    '[mcp_servers."colab mcp".env]', 'API_KEY = "SECRET-TOML-ENV"',
    '[mcp_servers]', `inline = { command = "python", args = ["secret-arg-token", "command = 'FAKE_PRIVATE_ARG_123'"], env = { command = "FAKE_PRIVATE_ENV_456" } }`,
    '[mcp_servers.multiline]', 'command = "node"', 'args = ["""',
    "command = 'FAKE_PRIVATE_MULTILINE_789'", '[mcp_servers.not-a-real-server]', "command = 'FAKE_PRIVATE_ARG_123'", '"""]',
    '[[skills.config]]', 'path = "C:/SECRET-CWD"',
  ].join('\n'));
  write(join(home, '.codex', 'skills', '.system', 'sys-skill', 'SKILL.md'), skillMd('sys-skill', 'built in'));
  write(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { sse1: { url: 'http://127.0.0.1:9000/sse', headers: { 'x-api-key': 'SECRET-HEADER-VALUE' } } } }));
  write(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { orrery: { type: 'http', url: 'http://127.0.0.1:4400/mcp', headers: { 'x-orrery-bridge': 'SECRET-HEADER-VALUE' } } } } }));
  write(join(home, '.zcode', 'skills', 'zed', 'SKILL.md'), skillMd('zed', 'ZCode skill'));
  write(join(home, '.workbuddy', 'mcp.json'), '{ this is not json SECRET-HEADER-VALUE');
  write(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { ag: { serverUrl: 'https://ag.example.com/secret-path-seg' } } }));
  return { home, shared };
}

/** A ZIP with the given entries (stored or deflated); the optional fields make broken or hostile archives. */
export function zip(entries: { name: string; data?: string | Buffer; deflate?: boolean; flags?: number; madeBy?: number; external?: number; crc?: number }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const packed = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x800;
    const crc = e.crc ?? crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(e.madeBy ?? 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(e.external ?? 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
