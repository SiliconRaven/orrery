// Plugin icons and details (docs/external-plugins.md「图标和详细说明」): the manifest fields, the icon checks, the icon
// route and what GET /api/plugins says about them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_DETAILS, parseExternalManifest } from '../src/core/external-plugin-config.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { isSvgDocument, MAX_ICON_BYTES, readPluginIcon } from '../src/core/plugin-icon.ts';
import { REPO_ROOT } from '../src/main.ts';
import { officialPlugins } from '../src/plugins/index.ts';
import { rawFetch, startTestHub, tempDir } from './helpers.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
const SVG = '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
const manifest = { id: 'icon-test', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', permissions: [], commands: [] };

function pluginDir(files: Record<string, string | Buffer> = {}): string {
  const dir = tempDir();
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  return dir;
}

test('plugin icon: one png, webp, ico or svg file inside the directory, its content matching its extension', () => {
  const dir = pluginDir({ 'a.png': PNG, 'img/b.webp': WEBP, 'c.ICO': ICO, 'd.svg': SVG, 'bom.svg': `\uFEFF  ${SVG}` });
  assert.deepEqual(readPluginIcon(dir, 'a.png'), { type: 'image/png', data: PNG });
  assert.equal((readPluginIcon(dir, 'img/b.webp') as any).type, 'image/webp');
  assert.equal((readPluginIcon(dir, 'img\\b.webp') as any).type, 'image/webp', 'a Windows separator inside the directory is fine');
  assert.equal((readPluginIcon(dir, './c.ICO') as any).type, 'image/x-icon');
  assert.equal((readPluginIcon(dir, 'd.svg') as any).type, 'image/svg+xml');
  assert.equal((readPluginIcon(dir, 'bom.svg') as any).type, 'image/svg+xml');
});

test('plugin icon: paths that leave the directory, other types, wrong content and oversize are refused with a reason', () => {
  const outside = pluginDir({ 'x.png': PNG });
  const dir = pluginDir({ 'a.png': PNG, 'svg-as.png': SVG, 'png-as.svg': PNG, 'page.svg': '<html><script>alert(1)</script></html>',
    'big.png': Buffer.concat([PNG, Buffer.alloc(MAX_ICON_BYTES)]), 'a.jpg': Buffer.from([0xff, 0xd8, 0xff, 0]), 'a.html': '<svg/>' });
  mkdirSync(join(dir, 'folder.png'));
  const reason = (icon: unknown) => {
    const result = readPluginIcon(dir, icon);
    assert.ok('error' in result, `${JSON.stringify(icon)} must be refused`);
    return result.error;
  };
  for (const icon of ['../x.png', 'img/../../x.png', '..\\x.png', join(outside, 'x.png'), '/x.png', '\\x.png', 'C:\\x.png', 'C:x.png',
    '\\\\server\\share\\x.png', '//server/share/x.png', 'https://example.invalid/x.png', 'file:///C:/x.png', 'data:image/png;base64,AA==', '', 'a'.repeat(300) + '.png', 'a.png\0']) {
    assert.match(reason(icon), /相对路径/, JSON.stringify(icon));
  }
  assert.match(reason(42), /字符串/);
  assert.match(reason(null), /字符串/);
  assert.match(reason('a.jpg'), /png、webp、ico 或 svg/);
  assert.match(reason('a.html'), /png、webp、ico 或 svg/);
  assert.match(reason('svg-as.png'), /不符/);
  assert.match(reason('png-as.svg'), /不符/);
  assert.match(reason('page.svg'), /不符/, 'an HTML page named .svg is not an SVG');
  assert.match(reason('big.png'), /256 KiB/);
  assert.match(reason('missing.png'), /找不到/);
  assert.match(reason('folder.png'), /找不到/);
  for (const text of ['../x.png', 'big.png', 'svg-as.png'].map(reason)) assert.ok(!text.includes(dir) && !text.includes('x.png'), 'no path in a reason');
});

test('plugin icon: a link or junction inside the directory that points outside it is refused', (t) => {
  const outside = pluginDir({ 'x.png': PNG, 'sub/y.png': PNG });
  const dir = pluginDir({ 'a.png': PNG });
  try {
    symlinkSync(join(outside, 'sub'), join(dir, 'linked'), 'junction');   // a junction needs no privilege on Windows
  } catch (error) { return t.skip(`cannot create a junction here: ${(error as Error).message}`); }
  assert.match((readPluginIcon(dir, 'linked/y.png') as any).error, /目录之外/);
  try { symlinkSync(join(outside, 'x.png'), join(dir, 'file-link.png'), 'file'); } catch { return; }   // file links need privilege on Windows
  assert.match((readPluginIcon(dir, 'file-link.png') as any).error, /目录之外/);
});

test('plugin icon: the SVG check accepts a prolog token by token and refuses the rest', () => {
  for (const ok of [SVG, '<svg>', '<svg/>', '<svg\nviewBox="0 0 1 1">', '﻿\n <svg>', '<!-- a -- b --><svg>', '<?xml-stylesheet x?><svg>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg>', ' '.repeat(4000) + '<svg>']) {
    assert.equal(isSvgDocument(ok), true, JSON.stringify(ok.slice(0, 60)));
  }
  for (const bad of ['', 'x', '<svgx>', '<svg', '<html><svg>', '<!-- <svg> ', '<?xml <svg>', '<!DOCTYPE svg [<!ENTITY a "b">]><svg>',
    '<!DOCTYPE html><svg>', '<!DOCTYPEsvg><svg>', '<!DOCTYPE svg><!DOCTYPE svg><svg>', '<!doctype svg><svg>', '<SVG>']) {
    assert.equal(isSvgDocument(bad), false, JSON.stringify(bad));
  }
});

// A child process with a hard timeout: a regression to super-linear matching would otherwise hang this file (a
// synchronous loop never lets the test runner's own timeout fire). Each shape must finish well inside 200 ms.
test('plugin icon and details: shapes that made the old SVG regex backtrack, and hostile details, take linear time', () => {
  const reviewerDir = pluginDir({ 'icon.svg': '<!---->'.repeat(40) + 'x' });   // 281 bytes that hung the old regex for seconds
  const code = `
    const { isSvgDocument, readPluginIcon } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src/core/plugin-icon.ts')).href)});
    const { markdownBlocks } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src/web/public/markdown.js')).href)});
    const time = (fn) => { const t = performance.now(); const r = fn(); return [r, performance.now() - t]; };
    const svg = { reviewer: '<!---->'.repeat(40) + 'x', comments4k: '<!---->'.repeat(585) + 'x', unterminated: '<!--' + '-'.repeat(4090),
      dashes: '<!-- a -- b -->'.repeat(270) + 'x', spaces: ' '.repeat(4095) + 'x', openers: '<!--'.repeat(1024), pis: '<?'.repeat(2048),
      mixed: '<!-- --><?x?>'.repeat(300) + '<svgx' };
    const details = { stars: '*'.repeat(4000), brackets: '['.repeat(4000), links: '[a]('.repeat(1000), ticks: '\`'.repeat(4000),
      pipes: '|'.repeat(1999) + '\\n' + '|-'.repeat(1000), lists: '- '.repeat(2000), quotes: '> '.repeat(2000), escapes: '\\\\'.repeat(4000),
      urls: 'https://'.repeat(500), tildes: '~~a'.repeat(1333), spaces: ' \\t'.repeat(2000) + 'x', nested: '  - '.repeat(1000) };
    const out = {};
    for (const [k, v] of Object.entries(svg)) out['svg:' + k] = time(() => isSvgDocument(v));
    for (const [k, v] of Object.entries(details)) out['md:' + k] = time(() => (markdownBlocks(v), false));
    out['file:reviewer'] = time(() => 'error' in readPluginIcon(${JSON.stringify(reviewerDir)}, 'icon.svg', false) ? false : true);
    console.log(JSON.stringify(out));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.signal, null, `killed after 15 s: something went super-linear\n${run.stderr}`);
  assert.equal(run.status, 0, run.stderr);
  const results: Record<string, [boolean, number]> = JSON.parse(run.stdout);
  for (const [name, [result, ms]] of Object.entries(results)) {
    assert.equal(result, false, `${name} is not an SVG`);
    assert.ok(ms < 200, `${name} took ${ms.toFixed(1)} ms`);
  }
});

test('plugin icon: a FIFO is refused before it is opened, so a pipe with no writer cannot block the Hub', { skip: process.platform === 'win32'
  ? 'Windows has no FIFOs in the file system (named pipes live under \\\\.\\pipe\\, which the relative-path check already refuses)' : false }, () => {
  const dir = pluginDir();
  const made = spawnSync('mkfifo', [join(dir, 'pipe.png')]);
  if (made.status !== 0) return;   // no mkfifo here: nothing to test
  const begin = Date.now();
  assert.match((readPluginIcon(dir, 'pipe.png') as any).error, /找不到/);
  assert.ok(Date.now() - begin < 1000);
});

test('plugin manifest: icon and details never make a plugin unavailable; long details are cut and marked', () => {
  assert.equal(parseExternalManifest({ ...manifest, icon: 'icon.png' }).iconPath, 'icon.png');
  assert.equal(parseExternalManifest({ ...manifest, icon: { url: 'x' } }).iconPath, null, 'a non-string icon is kept as a reason, not a failure');
  assert.equal(parseExternalManifest({ ...manifest, icon: '../../etc/passwd' }).iconPath, '../../etc/passwd', 'paths are checked when read');
  assert.equal(parseExternalManifest(manifest).iconPath, undefined);
  assert.equal(parseExternalManifest({ ...manifest, details: '## 说明\n正文' }).details, '## 说明\n正文');
  for (const details of [42, '   ', null, ['a']]) assert.equal(parseExternalManifest({ ...manifest, details }).details, undefined);
  const long = parseExternalManifest({ ...manifest, details: '长'.repeat(MAX_DETAILS - 1) + '😀' + 'x'.repeat(10) });
  assert.equal(long.detailsTruncated, true);
  assert.ok(long.details!.length <= MAX_DETAILS);
  assert.equal(long.details, long.details!.toWellFormed(), 'a cut never leaves half a surrogate pair');
  assert.equal(parseExternalManifest({ ...manifest, details: 'x'.repeat(MAX_DETAILS) }).detailsTruncated, undefined);
});

test('official plugins: each has an icon file served from official-plugins/ and a details text; a wrong icon name is refused', () => {
  for (const plugin of officialPlugins) {
    assert.equal(plugin.icon, `${plugin.id}.svg`);
    const file = join(REPO_ROOT, 'src/web/public/official-plugins', plugin.icon!);
    assert.ok(existsSync(file), file);
    assert.match(readFileSync(file, 'utf8'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>/);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /<script|on\w+=|href=/i);
    assert.ok((plugin.details ?? '').length > 40 && plugin.details!.length <= MAX_DETAILS, plugin.id);
  }
  assert.throws(() => new PluginHost([{ id: 'one', version: '1.0.0', icon: '../app.js' }]), /invalid icon for plugin one/);
});

test('GET /api/plugins and the icon route: official and third-party icons, reasons, details and headers', async () => {
  const dir = tempDir();
  const home = join(dir, 'home'); mkdirSync(home);
  const script = readFileSync(join(REPO_ROOT, 'examples/hub-plugins/message-counter/main.mjs'));
  const plugin = (id: string, extra: Record<string, unknown>, files: Record<string, string | Buffer> = {}, entry = true) => {
    const at = pluginDir({ ...files, ...(entry ? { 'main.mjs': script } : {}) });
    writeFileSync(join(at, 'orrery-plugin.json'), JSON.stringify({ ...manifest, id, ...extra }));
    return { manifest: join(at, 'orrery-plugin.json'), dir: at };
  };
  const good = plugin('good-icon', { icon: 'logo.svg', details: '**粗体** <script>x</script>', name: '<img src=x onerror=alert(1)>' }, { 'logo.svg': SVG });
  const png = plugin('png-icon', { icon: 'logo.png' }, { 'logo.png': PNG });
  const bad = plugin('bad-icon', { icon: '../good/logo.svg' });
  const failed = plugin('failed-icon', { icon: 'logo.svg', details: 'd' }, { 'logo.svg': SVG }, false);
  writeFileSync(join(home, 'external-plugins.json'), JSON.stringify({ plugins: [good, png, bad, failed].map((p) => ({ manifest: p.manifest })) }));
  const app = await startTestHub({ dir });
  try {
    const { installed } = await app.api('GET', '/api/plugins');
    const row = (id: string) => installed.find((p: any) => p.id === id);
    assert.equal(row('tasks').iconUrl, '/official-plugins/tasks.svg');
    assert.match(row('tasks').details, /关闭后/);
    assert.equal(row('tasks').iconError, undefined);
    assert.equal((await rawFetch(app.url + row('tasks').iconUrl)).headers.get('content-type'), 'image/svg+xml');
    assert.equal(row('good-icon').iconUrl, '/api/plugins/good-icon/icon');
    assert.equal(row('good-icon').details, '**粗体** <script>x</script>', 'details travel as data; the page renders them as text');
    assert.equal(row('bad-icon').iconUrl, null);
    assert.match(row('bad-icon').iconError, /相对路径/);
    assert.equal(row('bad-icon').runtime.state, 'ready', 'a bad icon does not stop the plugin');
    assert.equal(row('failed-icon').unavailable, true);
    assert.equal(row('failed-icon').iconUrl, null);
    assert.equal(row('failed-icon').details, 'd');
    for (const p of installed) assert.ok('iconUrl' in p && typeof p.details === 'string', `${p.id} has the card fields`);

    const icon = await fetch(app.url + '/api/plugins/good-icon/icon');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(icon.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(await icon.text(), SVG);
    assert.equal((await fetch(app.url + '/api/plugins/png-icon/icon')).headers.get('content-type'), 'image/png');
    assert.equal((await rawFetch(app.url + '/api/plugins/good-icon/icon')).status, 401, 'the API token is required, as for every /api/* route');
    assert.equal((await rawFetch(app.url + '/api/plugins/good-icon/icon', { headers: { authorization: 'Bearer x', origin: 'https://evil.invalid' } })).status, 403);
    for (const id of ['bad-icon', 'failed-icon', 'tasks', 'nobody', '..%2Fapp.js']) {
      assert.equal((await fetch(app.url + `/api/plugins/${id}/icon`)).status, 404, id);
    }
    // Checked on every read: a file that changes after start-up is refused from then on.
    writeFileSync(join(good.dir, 'logo.svg'), '<html><script>alert(1)</script></html>');
    assert.equal((await fetch(app.url + '/api/plugins/good-icon/icon')).status, 404);
    assert.match((await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'good-icon').iconError, /不符/);
  } finally { await app.close(); }
});
