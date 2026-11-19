// 技能与 MCP (src/core/app-extensions.ts, skill-install.ts, zip.ts; docs/files.md「各应用的 skill 和 MCP」「安装 skill」):
// the location table over a fixture home (never the real one), MCP entries reduced to name/transport/target with no
// secret leaving, and every install path and refusal, checked by directory snapshots outside the shared folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AppExtensions, appLocations, programName, reduceServer, tomlServers, urlTarget } from '../src/core/app-extensions.ts';
import { INSTALL_LIMITS, InstallRefused } from '../src/core/skill-install.ts';
import { listSkills } from '../src/core/skills.ts';
import { readZip, ZipRefused, type ZipLimits } from '../src/core/zip.ts';
import { fixtureHome, junction, SECRETS, skillMd, write, zip } from './extensions-fixture.ts';
import { tempDir } from './helpers.ts';

/** Every path under `root` (except `skip`) with its kind and size: what must not change outside the shared folder. */
function snapshot(root: string, skip: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (p === skip) continue;
      const st = lstatSync(p);
      out.push(`${relative(root, p)} ${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.size}`);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
  return out;
}

function setup() {
  const root = realpathSync(tempDir());
  const { home, shared } = fixtureHome(root);
  const ext = new AppExtensions({ home, sharedDir: shared });
  return { root, home, shared, ext };
}

async function refused(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof InstallRefused || e instanceof ZipRefused, `a refusal, not ${e}`);
    assert.equal((e as InstallRefused).code, code);
    assert.doesNotMatch((e as Error).message, /[A-Za-z]:\\|\/home\/|\\Users\\/, 'no path in the message');
    return true;
  });
}

test('extensions: the location table covers every supported app and uses ~ or variable labels only', () => {
  const locs = appLocations('/h', { CODEX_HOME: '/elsewhere/codex' });
  assert.deepEqual(locs.map((l) => l.app), ['claude', 'codex', 'deepseek', 'kimi', 'zcode', 'antigravity', 'qoder', 'workbuddy', 'cursor']);
  const labels = locs.flatMap((l) => [...(l.skills ?? []).map((s) => s.label), ...(l.mcp ?? []).map((m) => m.label)]);
  assert.ok(labels.every((l) => /^(~\/|\$[A-Z_]+|%APPDATA%)/.test(l)), labels.join(' '));
  assert.ok(labels.includes('$CODEX_HOME/config.toml'));
  assert.equal(locs.find((l) => l.app === 'kimi')!.skills, null, 'unknown locations are null, not guessed');
});

test('extensions: MCP entries are reduced to name, transport and a program name or scheme+host', () => {
  assert.equal(programName('npx'), 'npx');
  assert.equal(programName('C:\\Program Files\\nodejs\\node.exe --api-key=x'), 'node.exe');
  assert.equal(programName('"C:\\Program Files\\x\\tool.exe" --a b'), 'tool.exe');
  assert.equal(programName('/usr/bin/python3 -m s'), 'python3');
  assert.equal(programName('TOKEN=abc npx s'), '', 'an environment prefix is not a program');
  assert.equal(programName({ cmd: 'x' }), '');
  assert.equal(urlTarget('https://u:p@h.example.com:8443/p?q=1#f'), 'https://h.example.com:8443');
  assert.equal(urlTarget('file:///C:/x'), '');
  assert.equal(urlTarget('not a url'), '');
  assert.deepEqual(reduceServer('a', { type: 'sse', url: 'http://x/sse' }), { name: 'a', transport: 'sse', target: 'http://x' });
  assert.deepEqual(reduceServer('b', { httpUrl: 'https://y/z' }), { name: 'b', transport: 'http', target: 'https://y' });
  assert.deepEqual(reduceServer('c', 'nonsense'), { name: 'c', transport: 'unknown', target: '' });
  const servers = tomlServers('[mcp_servers.a]\ncommand = "node"\n[mcp_servers.a.env]\ncommand = "evil"\n[other]\ncommand = "x"');
  assert.deepEqual(Object.entries(servers ?? {}).map(([name, raw]) => reduceServer(name, raw)), [{ name: 'a', transport: 'stdio', target: 'node' }]);
});

test('extensions: TOML server names stay own properties and inherited fields cannot become targets', () => {
  const protectedObjects = [Object.prototype, Object];
  const before = protectedObjects.map((object) => Object.getOwnPropertyDescriptors(object));
  try {
    const servers = tomlServers('[mcp_servers.__proto__]\ncommand = "node"\n[mcp_servers.constructor]\ncommand = "python"\n[mcp_servers.toString]\ncommand = "uvx"');
    assert.deepEqual(Object.keys(servers ?? {}), ['__proto__', 'constructor', 'toString']);
    assert.deepEqual(Object.entries(servers ?? {}).map(([name, raw]) => reduceServer(name, raw).target), ['node', 'python', 'uvx']);
    for (let i = 0; i < protectedObjects.length; i++) assert.deepEqual(Object.getOwnPropertyDescriptors(protectedObjects[i]), before[i]);
    const inherited = Object.create({ command: 'FAKE_PRIVATE_ARG_123', type: 'stdio', url: 'https://FAKE_PRIVATE_ENV_456.invalid' });
    assert.deepEqual(reduceServer('inherited', inherited), { name: 'inherited', transport: 'unknown', target: '' });
    inherited.command = 'node';
    assert.deepEqual(reduceServer('own', inherited), { name: 'own', transport: 'stdio', target: 'node' });
  } finally {
    // Keep a regression in the old parser from contaminating the remaining tests.
    for (let i = 0; i < protectedObjects.length; i++) {
      for (const key of Reflect.ownKeys(protectedObjects[i])) if (!Object.hasOwn(before[i], key)) Reflect.deleteProperty(protectedObjects[i], key);
      Object.defineProperties(protectedObjects[i], before[i]);
    }
  }
});

test('extensions: the listing reads the fixture apps, links are listed but never followed, no secret leaves and nothing is logged', (t) => {
  const { home, shared, ext } = setup();
  const linked = junction(join(shared, 'already'), join(home, '.claude', 'skills', 'linked'));
  const logged: string[] = [];
  for (const k of ['log', 'error', 'warn', 'info'] as const) t.mock.method(console, k, (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  const report = ext.list();
  const text = JSON.stringify(report);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${s} is not in the answer`);
  assert.ok(!text.includes(home), 'no real path in the answer');
  assert.deepEqual(logged, [], 'nothing is logged');

  assert.deepEqual(report.shared.skills, [{ name: 'already', description: 'in the shared folder', link: false }]);
  const claude = report.apps.find((a) => a.app === 'claude')!;
  assert.equal(claude.status, 'ok');
  assert.deepEqual(claude.skills.map((s) => [s.name, s.link, s.inShared]), [['alpha', false, false], ['already', false, true], ...(linked ? [['linked', true, false]] : [])]);
  assert.deepEqual(claude.mcpServers.map(({ name, transport, target }) => [name, transport, target]), [
    ['github', 'stdio', 'npx'], ['remote', 'http', 'https://api.example.com:8443'], ['envprefix', 'stdio', ''], ['winpath', 'stdio', 'node.exe']]);
  assert.deepEqual(claude.locations.map((l) => [l.kind, l.label, l.state]), [['skills', '~/.claude/skills', 'ok'], ['mcp', '~/.claude.json', 'ok'], ['mcp', '%APPDATA%/Claude/claude_desktop_config.json', 'missing']]);
  const codex = report.apps.find((a) => a.app === 'codex')!;
  assert.deepEqual(codex.mcpServers.map(({ name, transport, target }) => [name, transport, target]), [
    ['fusion', 'http', 'https://fusion.example.com'], ['colab mcp', 'stdio', 'uvx'], ['inline', 'stdio', 'python'], ['multiline', 'stdio', 'node']]);
  assert.deepEqual(codex.skills.map((s) => [s.name, s.source]), [['sys-skill', 'builtin']]);
  assert.equal(report.apps.find((a) => a.app === 'workbuddy')!.locations.find((l) => l.kind === 'mcp')!.state, 'invalid', 'a broken config is a state, not an error');
  assert.equal(report.apps.find((a) => a.app === 'kimi')!.status, 'unsupported');
  assert.equal(report.apps.find((a) => a.app === 'qoder')!.status, 'not_found');
  assert.deepEqual(report.apps.find((a) => a.app === 'antigravity')!.mcpServers.map((s) => s.target), ['https://ag.example.com']);
  assert.deepEqual(new AppExtensions({ sharedDir: shared }).list().apps, [], 'no home: no app is read');
  write(join(home, '.codex', 'config.toml'), 'command = "FAKE_PRIVATE_PARSE_012" trailing');
  const invalid = ext.list();
  assert.equal(invalid.apps.find((a) => a.app === 'codex')!.locations.find((l) => l.kind === 'mcp')!.state, 'invalid');
  for (const secret of SECRETS) assert.ok(!JSON.stringify(invalid).includes(secret), 'parser errors only produce an invalid state');
  assert.deepEqual(logged, [], 'parser error diagnostics are not logged');
});

test('install: from an app, from a folder and from a ZIP; the $ list sees each; nothing outside the shared folder changes', async () => {
  const { root, shared, ext } = setup();
  const source = join(root, 'src-folder', 'from-folder');
  write(join(source, 'SKILL.md'), skillMd('from-folder'));
  write(join(source, 'sub', 'file.txt'), 'hello');
  const before = snapshot(root, shared);

  assert.deepEqual(await ext.installFromApp('claude', 'alpha', 'user', false), { name: 'alpha', description: 'Alpha skill', replaced: false });
  assert.equal(readFileSync(join(shared, 'alpha', 'docs', 'more.md'), 'utf8'), 'more');
  assert.equal((await ext.installFromPath(source, false)).name, 'from-folder');
  assert.equal(readFileSync(join(shared, 'from-folder', 'sub', 'file.txt'), 'utf8'), 'hello');
  const archive = zip([{ name: 'zipped/' }, { name: 'zipped/SKILL.md', data: skillMd(null, 'from a zip'), deflate: true },
    { name: 'zipped/docs/a.md', data: 'A'.repeat(5000), deflate: true }, { name: 'zipped/..assets/file.txt', data: 'ordinary asset' }]);
  assert.deepEqual(await ext.installFromZip(archive, 'whatever.zip', false), { name: 'zipped', description: 'from a zip', replaced: false });
  assert.equal(readFileSync(join(shared, 'zipped', 'docs', 'a.md'), 'utf8'), 'A'.repeat(5000));
  assert.equal(readFileSync(join(shared, 'zipped', '..assets', 'file.txt'), 'utf8'), 'ordinary asset');
  // A ZIP with SKILL.md at its root is named by its frontmatter, else by the uploaded file's name.
  assert.equal((await ext.installFromZip(zip([{ name: 'SKILL.md', data: skillMd(null) }]), 'named-by-file.zip', false)).name, 'named-by-file');

  assert.deepEqual(ext.list().shared.skills.map((s) => s.name), ['alpha', 'already', 'from-folder', 'named-by-file', 'zipped']);
  assert.deepEqual(listSkills(shared).map((s) => s.name), ['alpha', 'already', 'from-folder', 'named-by-file', 'zipped'], 'the $ picker reads the same folder');
  assert.deepEqual(snapshot(root, shared), before, 'nothing outside the shared folder changed');
  assert.deepEqual(readdirSync(shared).filter((n) => n.startsWith('.')), [], 'no temporary folder left');
});

test('install: exists without overwrite; overwrite replaces atomically and removes the old copy', async () => {
  const { shared, ext } = setup();
  await ext.installFromApp('claude', 'alpha', undefined, false);
  write(join(shared, 'alpha', 'stale.txt'), 'old');
  await refused(ext.installFromApp('claude', 'alpha', undefined, false), 'exists');
  assert.ok(statSync(join(shared, 'alpha', 'stale.txt')).isFile(), 'a refusal changes nothing');
  assert.deepEqual(await ext.installFromApp('claude', 'alpha', undefined, true), { name: 'alpha', description: 'Alpha skill', replaced: true, oldRemoved: true });
  assert.deepEqual(readdirSync(join(shared, 'alpha')).sort(), ['SKILL.md', 'docs']);
  assert.deepEqual(readdirSync(shared).filter((n) => n.startsWith('.')), []);
  // Case does not make a second copy on Windows: ALPHA is the same folder there.
  if (process.platform === 'win32') {
    const zipped = zip([{ name: 'ALPHA/SKILL.md', data: skillMd(null) }]);
    await refused(ext.installFromZip(zipped, 'x.zip', false), 'exists');
  }
});

test('install: links are refused in the source, as the shared folder, at the destination and in an old copy', async (t) => {
  const { root, home, shared, ext } = setup();
  const source = join(root, 'linked-source');
  write(join(source, 'SKILL.md'), skillMd('linked-source'));
  if (!junction(join(home, '.claude'), join(source, 'escape'))) return t.skip('the OS refused to create a junction');
  junction(join(home, '.claude', 'skills', 'alpha'), join(home, '.claude', 'skills', 'linked'));
  const realShared = join(root, 'real-shared');
  mkdirSync(realShared);
  junction(realShared, join(root, 'shared-link'));
  write(join(shared, 'zed', 'SKILL.md'), skillMd('zed'));
  junction(realShared, join(shared, 'zed', 'inner-link'));
  junction(realShared, join(shared, 'alpha'));
  const before = snapshot(root, shared);

  await refused(ext.installFromPath(source, false), 'source_has_link');
  await refused(ext.installFromPath(join(source, 'escape'), false), 'source_has_link');
  await refused(ext.installFromApp('claude', 'linked', undefined, false), 'skill_is_link');
  // The shared folder itself, or a folder above it, being a junction.
  await refused(new AppExtensions({ home, sharedDir: join(root, 'shared-link') }).installFromApp('claude', 'alpha', undefined, false), 'shared_dir_link');
  await refused(new AppExtensions({ home, sharedDir: join(root, 'shared-link', 'inner') }).installFromApp('claude', 'alpha', undefined, false), 'shared_dir_link');
  // A junction already at the destination: refused even with overwrite.
  await refused(ext.installFromApp('claude', 'alpha', undefined, true), 'target_is_link');
  // An old copy holding a junction is not replaced (its removal would have to decide about the link).
  await refused(ext.installFromApp('zcode', 'zed', undefined, true), 'existing_has_link');

  assert.ok(lstatSync(join(shared, 'zed', 'inner-link')).isSymbolicLink(), 'the old copy is untouched');
  assert.ok(lstatSync(join(shared, 'alpha')).isSymbolicLink(), 'the link at the destination is untouched');
  assert.deepEqual(readdirSync(realShared), [], 'nothing written through a junction');
  assert.deepEqual(snapshot(root, shared), before, 'nothing outside the shared folder changed');
  assert.deepEqual(readdirSync(shared).filter((n) => n.startsWith('.')), [], 'temporary folders are removed after each refusal');
});

test('install: path, name, SKILL.md, app and cap refusals; the temporary folder is cleaned after a late failure', async (t) => {
  const { root, shared, ext } = setup();
  await refused(ext.installFromPath('relative\\path', false), 'path_not_absolute');
  await refused(ext.installFromPath('\\\\server\\share\\skill', false), 'path_not_local');
  await refused(ext.installFromPath('//server/share/skill', false), 'path_not_local');
  await refused(ext.installFromPath(42, false), 'bad_request');
  await refused(ext.installFromPath(join(root, 'nope'), false), 'path_not_found');
  write(join(root, 'a-file.txt'), 'x');
  await refused(ext.installFromPath(join(root, 'a-file.txt'), false), 'path_not_directory');
  await refused(ext.installFromPath(join(root, 'home'), false), 'source_contains_shared');
  const containing = join(root, 'source-with-shared-child');
  write(join(containing, 'SKILL.md'), skillMd('source-with-shared-child'));
  await refused(new AppExtensions({ sharedDir: join(containing, '..assets', 'shared') }).installFromPath(containing, false), 'source_contains_shared');
  write(join(root, 'no-md', 'README.md'), 'x');
  await refused(ext.installFromPath(join(root, 'no-md'), false), 'missing_skill_md');
  // Bad name: the copy is made first, then the name is read: the temporary folder must go.
  write(join(root, '!bad', 'SKILL.md'), skillMd('not valid!'));
  await refused(ext.installFromPath(join(root, '!bad'), false), 'invalid_name');
  assert.deepEqual(readdirSync(shared).filter((n) => n.startsWith('.')), [], 'the temporary folder was removed');
  await refused(ext.installFromApp('nope', 'alpha', undefined, false), 'unknown_app');
  await refused(ext.installFromApp('claude', 'missing', undefined, false), 'unknown_skill');
  await refused(ext.installFromApp('claude', '../alpha', undefined, false), 'unknown_skill');
  await refused(ext.installFromApp('claude', 'no-skill-md', undefined, false), 'unknown_skill');
  await refused(new AppExtensions({ home: join(root, 'home') }).installFromApp('claude', 'alpha', undefined, false), 'not_configured');

  const many = join(root, 'many');
  write(join(many, 'SKILL.md'), skillMd('many'));
  for (let i = 0; i < 5; i++) write(join(many, `f${i}.txt`), 'x'.repeat(100));
  const saved = { ...INSTALL_LIMITS };
  t.after(() => Object.assign(INSTALL_LIMITS, saved));
  Object.assign(INSTALL_LIMITS, { files: 3 });
  await refused(ext.installFromPath(many, false), 'too_many_files');
  Object.assign(INSTALL_LIMITS, { files: 1000, bytes: 300 });
  await refused(ext.installFromPath(many, false), 'too_large');
  Object.assign(INSTALL_LIMITS, { bytes: saved.bytes, depth: 2 });
  write(join(many, 'a', 'b', 'c.txt'), 'deep');
  await refused(ext.installFromPath(many, false), 'too_deep');
  assert.deepEqual(readdirSync(shared).sort(), ['already']);
});

test('zip: names that leave the folder, links, encryption, CRC, ratio, duplicates and caps are refused', async () => {
  const { root, shared, ext } = setup();
  const before = snapshot(root, shared);
  const md = { name: 'SKILL.md', data: skillMd('z') };
  const code = async (entries: Parameters<typeof zip>[0], expected: string) => refused(ext.installFromZip(zip(entries), 'z.zip', false), expected);
  for (const name of ['../evil.txt', '/abs.txt', 'C:/x.txt', 'C:x.txt', 'a\\b.txt', 'a/../b.txt', 'a//b.txt', './a.txt', 'con.txt', 'sub/NUL', 'trail.', 'ctl\u0001.txt', 'nul\u0000.txt', 'stream.txt:ads']) {
    await code([md, { name, data: 'x' }], 'zip_bad_name');
  }
  await code([md, { name: 'link', data: '/etc/passwd', madeBy: 0x0314, external: (0o120777 << 16) >>> 0 }], 'zip_symlink');
  await code([md, { name: 'reparse', data: 'x', external: 0x400 }], 'zip_symlink');
  await code([md, { name: 'secret.txt', data: 'x', flags: 1 }], 'zip_encrypted');
  await code([md, { name: 'bad-crc.txt', data: 'hello', crc: 1234 }], 'zip_crc');
  await code([md, { name: 'bomb.txt', data: Buffer.alloc(2 * 1024 * 1024), deflate: true }], 'zip_ratio');
  await code([md, { name: 'a.txt', data: 'x' }, { name: 'A.TXT', data: 'y' }], 'zip_duplicate');
  await code([md, { name: 'f', data: 'x' }, { name: 'f/g.txt', data: 'y' }], 'zip_duplicate');
  await code([{ name: 'README.md', data: 'x' }], 'missing_skill_md');
  await code([{ name: 'one/SKILL.md', data: 'x' }, { name: 'two/SKILL.md', data: 'x' }], 'missing_skill_md');
  // No frontmatter name, no folder, and an upload name that is no skill name either.
  await refused(ext.installFromZip(zip([{ name: 'SKILL.md', data: skillMd(null) }]), '!!.zip', false), 'invalid_name');
  await refused(ext.installFromZip(Buffer.from('not a zip at all'), 'x.zip', false), 'zip_invalid');
  const truncated = zip([md, { name: 'x.txt', data: 'hello world' }]);
  await refused(ext.installFromZip(truncated.subarray(0, truncated.length - 30), 'x.zip', false), 'zip_invalid');
  const tooMany = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }));
  await code([md, ...tooMany], 'too_many_files');
  const small: ZipLimits = { entries: 10, fileBytes: 10, totalBytes: 15, ratio: 100, depth: 3 };
  assert.throws(() => readZip(zip([{ name: 'a.txt', data: 'x'.repeat(11) }]), small), { code: 'too_large' });
  assert.throws(() => readZip(zip([{ name: 'a.txt', data: 'x'.repeat(9) }, { name: 'b.txt', data: 'x'.repeat(9) }]), small), { code: 'too_large' });
  assert.throws(() => readZip(zip([{ name: 'a/b/c/d.txt', data: 'x' }]), small), { code: 'too_deep' });
  assert.deepEqual(readdirSync(shared).sort(), ['already'], 'nothing was installed and no temporary folder is left');
  assert.deepEqual(snapshot(root, shared), before);
});
