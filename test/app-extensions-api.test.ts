// 技能与 MCP over HTTP (src/web/server.ts, docs/files.md「安装 skill」): only the user's API token reaches the routes;
// the bridge secret, a member's bridge identity and no token are refused; no MCP tool, plugin or other module can call them;
// answers carry no secret and nothing is logged; the $ list (GET /api/skills) sees an installed skill at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';
import { fixtureHome, SECRETS, skillMd, write, zip } from './extensions-fixture.ts';
import { memberHeaders, rawFetch, startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

test('extensions api: user token only; list, install from an app and a ZIP, exists is 409, $ list refreshed, nothing secret leaves', async (t) => {
  const { home, shared } = fixtureHome(realpathSync(tempDir()));
  const hub = await startTestHub({ skillsDir: shared, appHome: home });
  t.after(() => hub.close());
  const logged: string[] = [];
  for (const k of ['log', 'error', 'warn', 'info'] as const) t.mock.method(console, k, (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });

  // Who may call: the API token, nobody else.
  const { secret } = JSON.parse(readFileSync(join(hub.home, 'hub.json'), 'utf8'));
  const { members: [member] } = await hub.cluster('c', ['m']);
  const install = (headers: Record<string, string>) => rawFetch(`${hub.url}/api/extensions/skills/install`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ fromApp: 'claude', skill: 'alpha' }) });
  const callers: Record<string, string>[] = [{}, { 'x-orrery-bridge': secret }, { authorization: `Bearer ${secret}` }, memberHeaders(hub, member.id)];
  for (const headers of callers) {
    assert.equal((await rawFetch(`${hub.url}/api/extensions`, { headers })).status, 401, JSON.stringify(Object.keys(headers)));
    assert.equal((await install(headers)).status, 401);
  }
  assert.deepEqual(readdirSync(shared), ['already'], 'nothing was installed by a refused caller');

  const list = await hub.api('GET', '/api/extensions');
  const text = JSON.stringify(list);
  for (const s of SECRETS) assert.ok(!text.includes(s), s);
  assert.ok(!text.includes(home));
  assert.deepEqual(list.shared.skills.map((s: { name: string }) => s.name), ['already']);
  assert.ok(list.apps.find((a: { app: string }) => a.app === 'claude').skills.some((s: { name: string }) => s.name === 'alpha'));
  write(join(home, '.codex', 'config.toml'), 'command = "FAKE_PRIVATE_PARSE_012" trailing');
  const invalid = await hub.api('GET', '/api/extensions');
  assert.equal(invalid.apps.find((a: { app: string }) => a.app === 'codex').locations.find((l: { kind: string }) => l.kind === 'mcp').state, 'invalid');
  for (const secret of SECRETS) assert.ok(!JSON.stringify(invalid).includes(secret), 'TOML parser diagnostics do not leave the API');

  assert.deepEqual(await hub.api('GET', '/api/skills'), [{ name: 'already', description: 'in the shared folder' }]);
  assert.equal((await install({ authorization: `Bearer ${TEST_TOKEN}` })).status, 200);
  const again = await install({ authorization: `Bearer ${TEST_TOKEN}` });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'a skill with this name is already in the shared folder', code: 'exists', skill: 'alpha' });
  const zipped = await fetch(`${hub.url}/api/extensions/skills/install?overwrite=1`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-orrery-filename': encodeURIComponent('我的.zip') },
    body: new Uint8Array(zip([{ name: 'from-zip/SKILL.md', data: skillMd(null, 'zipped') }])) });
  assert.deepEqual(await zipped.json(), { name: 'from-zip', description: 'zipped', replaced: false });
  assert.deepEqual((await hub.api('GET', '/api/skills')).map((s: { name: string }) => s.name), ['alpha', 'already', 'from-zip'], 'the $ list reads the folder on each request');

  // Refusals answer a code and no path; the wrong content type never reaches the handler; size is capped before reading.
  const bad = await fetch(`${hub.url}/api/extensions/skills/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromPath: join(home, 'nope') }) });
  const badBody = await bad.json();
  assert.deepEqual([bad.status, badBody.code], [400, 'path_not_found']);
  assert.ok(!JSON.stringify(badBody).includes(home), 'the answer does not repeat the path');
  assert.equal((await fetch(`${hub.url}/api/extensions/skills/install`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  const big = await new Promise<number>((ok, fail) => {
    const req = request(`${hub.url}/api/extensions/skills/install`, { method: 'POST', headers: {
      authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/octet-stream', 'content-length': String(20 * 1024 * 1024 + 1) } }, (res) => { res.resume(); ok(res.statusCode!); });
    req.on('error', fail);
    req.end();
  });
  assert.equal(big, 413, 'declared too large: refused before reading');
  assert.equal((await fetch(`${hub.url}/api/extensions/skills/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromApp: 'claude' }) })).status, 400);
  assert.equal((await fetch(`${hub.url}/api/extensions`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  for (const line of logged) for (const s of SECRETS) assert.ok(!line.includes(s), `logged ${s}`);
});

test('extensions api: no MCP tool, bridge route, plugin or adapter can reach the listing or the installer', () => {
  // Only the composition root and the web API import them: members (src/mcp), plugins (src/plugins) and adapters never do.
  const src = join(REPO_ROOT, 'src');
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.(ts|js|mjs)$/.test(f));
  const importers = files.filter((f) => /(app-extensions|skill-install|zip)\.ts['"]/.test(readFileSync(join(src, f), 'utf8')))
    .map((f) => relative(src, join(src, f)).replaceAll('\\', '/')).sort();
  assert.deepEqual(importers, ['core/app-extensions.ts', 'core/skill-install.ts', 'main.ts', 'web/server.ts']);
  const mcp = files.filter((f) => /^(mcp|plugins|adapters)[\\/]/.test(f)).filter((f) => /\/api\/extensions|installFrom/.test(readFileSync(join(src, f), 'utf8')));
  assert.deepEqual(mcp, []);
});
