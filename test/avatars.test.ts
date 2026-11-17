// The public distribution has no character presets. Custom avatars and optional local preset names still work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';
import { AVATARS_DIR, loadAvatarPresets } from '../src/core/avatars.ts';
import { startTestHub, tempDir } from './helpers.ts';

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

test('avatars: the public repository has no bundled character presets', () => {
  const files = existsSync(AVATARS_DIR) ? readdirSync(AVATARS_DIR).filter((f) => f.endsWith('.png')) : [];
  assert.deepEqual(files, []);
  assert.deepEqual(loadAvatarPresets(), []);
});

test('avatars: no bundled presets leaves defaults and custom emoji or image avatars usable', async () => {
  const app = await startTestHub();
  try {
    assert.deepEqual(await app.api('GET', '/api/avatars'), []);
    assert.equal((await fetch(app.url + '/avatars/claude.png')).status, 404);
    const { members: [m] } = await app.cluster('c', ['A']);
    assert.equal(m.avatar, null, 'no preset is selected by default');
    const patch = (avatar: unknown) => app.api('PATCH', `/api/members/${m.id}`, { avatar });
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    assert.equal((await patch(image)).avatar, image, 'custom images remain supported');
    assert.equal((await patch('🦊')).avatar, '🦊', 'an emoji is still allowed');
    for (const bad of ['preset:claude', 'preset:codex', 'preset:../secret', 'preset:', 'preset:Claude']) {
      await assert.rejects(patch(bad), /400/, String(bad));
    }
    assert.equal((await app.api('GET', '/api/state')).members.find((x: any) => x.id === m.id).avatar, '🦊',
      'a refused preset changes nothing');
    assert.equal((await patch(null)).avatar, null, 'custom avatars can return to the default');
  } finally {
    await app.close();
  }
});
