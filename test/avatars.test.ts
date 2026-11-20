// Preset avatars are optional assets. The HTTP and browser tests supply a one-pixel PNG on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';
import { AVATARS_DIR, loadAvatarPresets, PRESET_SOURCE } from '../src/core/avatars.ts';
import { findBrowser, launchBrowser } from './browser.ts';
import { startTestHub, TEST_TOKEN, tempDir } from './helpers.ts';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const browsers = findBrowser();
const skipBrowser = browsers.path === null && process.env.ORRERY_REQUIRE_BROWSER !== '1' ? browsers.reason : false;

test('web: browser icon is served and matches the desktop icon', async () => {
  const app = await startTestHub();
  try {
    const page = await fetch(app.url + '/');
    assert.match(await page.text(), /href="\/orrery-icon\.ico"/);
    const icon = await fetch(app.url + '/orrery-icon.ico');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/x-icon');
    assert.deepEqual(Buffer.from(await icon.arrayBuffer()), readFileSync(join(REPO_ROOT, 'desktop', 'assets', 'orrery-icon.ico')));
  } finally {
    await app.close();
  }
});

test('avatars: preset names are <name>.png with lowercase letters, digits and hyphens; other files are ignored', () => {
  const dir = tempDir();
  for (const name of ['chatgpt-2.png', 'claude.png', 'z9.png', 'Bad Name.png', 'UPPER.PNG', 'a-b-.png', '-lead.png', 'x_y.png', 'q.jpg', '.png']) {
    writeFileSync(join(dir, name), 'x');
  }
  mkdirSync(join(dir, 'folder.png'));
  assert.deepEqual(loadAvatarPresets(dir), ['chatgpt-2', 'claude', 'z9']);
  assert.deepEqual(loadAvatarPresets(join(dir, 'missing')), [], 'a missing folder means no presets (generated initials stay)');
});

test('avatars: the shipped bundle has all 11 presets, or none in a copy without artwork', async () => {
  let files: string[];
  try {
    files = readdirSync(AVATARS_DIR).filter((f) => f.endsWith('.png')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    files = [];
  }
  if (files.length > 0) {
    assert.equal(files.length, 11);
    for (const file of files) assert.match(file.slice(0, -4), PRESET_SOURCE, file);
    assert.ok(files.includes('claude.png') && files.includes('deepseek.png'));
  }
  const app = await startTestHub();
  try {
    assert.deepEqual(await app.api('GET', '/api/avatars'), files.map((f) => f.slice(0, -4)).sort());
  } finally {
    await app.close();
  }
});

test('avatars: GET /api/avatars lists the start-up set, the PNGs are served, and only listed presets can become an avatar', async () => {
  const dir = tempDir();
  const bytes = Buffer.from(pixel, 'base64');
  for (const name of ['fixture-dot', 'another-dot']) writeFileSync(join(dir, name + '.png'), bytes);
  const app = await startTestHub({ avatarDir: dir });
  try {
    assert.deepEqual(await app.api('GET', '/api/avatars'), ['another-dot', 'fixture-dot']);
    const png = await fetch(app.url + '/avatars/fixture-dot.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await png.arrayBuffer()), bytes);
    assert.equal((await fetch(app.url + '/avatars/absent.png')).status, 404);
    const { members: [m] } = await app.cluster('c', ['A']);
    const patch = (avatar: unknown) => app.api('PATCH', `/api/members/${m.id}`, { avatar });
    assert.equal((await patch('preset:fixture-dot')).avatar, 'preset:fixture-dot');
    assert.equal((await patch('🦊')).avatar, '🦊', 'an emoji is still allowed');
    for (const bad of ['preset:absent', 'preset:../secret', 'preset:', 'preset:Fixture-dot']) {
      await assert.rejects(patch(bad), /400/, String(bad));
    }
    assert.equal(app.store.getMember(m.id)?.avatar, '🦊', 'a refused preset changes nothing');
  } finally {
    await app.close();
  }
});

test('avatars: with no presets the page falls back to the initial and still saves an uploaded image', { skip: skipBrowser, timeout: 180_000 }, async () => {
  assert.ok(browsers.path, browsers.path === null ? browsers.reason : undefined);
  const avatarDir = loadAvatarPresets().length ? join(tempDir(), 'missing-avatars') : undefined;
  const app = await startTestHub({ avatarDir });
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    assert.deepEqual(await app.api('GET', '/api/avatars'), []);
    const { members: [member] } = await app.cluster('Avatar fallback', ['Aster']);
    // Represent an older database that still references a preset absent from this copy.
    app.store.updateMember(member.id, { avatar: 'preset:fixture-dot' });
    browser = await launchBrowser(browsers.path, { redact: [TEST_TOKEN] });
    const page = browser.page;
    await page.navigate(`${app.url}/#token=${TEST_TOKEN}`);
    const tab = "document.querySelector('#cluster-list .cluster-item')";
    await page.waitFor(tab, 'test cluster to load');
    await page.click(tab, 'test cluster');
    await page.waitFor("document.querySelector('#members-toggle .avatar')?.textContent === 'A'", 'initial instead of a missing PNG');
    await page.click("document.querySelector('#members-toggle')", 'member list');
    const edit = "document.querySelector('#manage-list [data-action=edit]')";
    await page.waitFor(edit, 'member edit button');
    await page.click(edit, 'member avatar editor');
    const editor = "document.querySelector('#manage-list .manage-edit')";
    await page.waitFor(editor, 'avatar editor');
    assert.equal(await page.evaluate(`${editor}.querySelector('[data-role=presets]').hidden`), true);
    await page.evaluate(`(() => {
      const input = ${editor}.querySelector('[name=file]');
      const files = new DataTransfer();
      const bytes = Uint8Array.from(atob(${JSON.stringify(pixel)}), (ch) => ch.charCodeAt(0));
      files.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.click(`${editor}.querySelector('[data-role=save]')`, 'save uploaded avatar');
    const custom = 'data:image/png;base64,' + pixel;
    await page.waitFor(`(() => {
      const img = document.querySelector('#members-toggle .avatar img');
      return img?.getAttribute('src') === ${JSON.stringify(custom)} && img.naturalWidth === 1;
    })()`, 'uploaded PNG to render');
    assert.equal(app.store.getMember(member.id)?.avatar, custom);
    assert.deepEqual(browser.problems().exceptions, []);
  } finally {
    await browser?.close();
    await app.close();
  }
});
