// docs/launcher.md 测试 6：resolveConfig gives the same absolute paths from any working directory, and keeps
// the environment variable rules main.ts had before it was extracted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { REPO_ROOT as CONFIG_ROOT, resolveConfig, skillsDirOf } from '../src/config.ts';
import { REPO_ROOT } from '../src/main.ts';
import { tempDir } from './helpers.ts';

test('launcher 6: resolveConfig defaults and overrides match the old main.ts rules', () => {
  assert.equal(CONFIG_ROOT, REPO_ROOT);
  const defaults = {
    home: join(homedir(), '.orrery'), port: 4317, dbPath: join(REPO_ROOT, '.tmp', 'orrery.db'),
    registryDir: join(homedir(), '.orrery', 'registry'),
  };
  assert.deepEqual(resolveConfig({}), defaults);
  // Empty values count as unset, as with `||` before.
  assert.deepEqual(resolveConfig({ ORRERY_HOME: '', ORRERY_PORT: '', ORRERY_DB: '' }), defaults);
  const dir = tempDir();
  assert.deepEqual(resolveConfig({
    ORRERY_HOME: join(dir, 'h'), ORRERY_PORT: '0', ORRERY_DB: join(dir, 'x.db'), ORRERY_REGISTRY: join(dir, 'registry'),
  }), { home: join(dir, 'h'), port: 0, dbPath: join(dir, 'x.db'), registryDir: join(dir, 'registry') });
  // The shared skills folder (docs/files.md): ORRERY_SKILLS_DIR, else ~/.agents/skills; empty counts as unset.
  assert.equal(skillsDirOf({}), join(homedir(), '.agents', 'skills'));
  assert.equal(skillsDirOf({ ORRERY_SKILLS_DIR: '' }), join(homedir(), '.agents', 'skills'));
  assert.equal(skillsDirOf({ ORRERY_SKILLS_DIR: join(dir, 's') }), join(dir, 's'));
  for (const bad of ['abc', '-1', '1.5']) {
    assert.throws(() => resolveConfig({ ORRERY_PORT: bad }), /ORRERY_PORT must be a non-negative integer/);
  }
});

test('launcher 6: the working directory and spaces in paths do not change the result', () => {
  const dir = join(tempDir(), 'with space');
  const other = join(dir, 'other cwd');
  mkdirSync(other, { recursive: true });
  const env = { ORRERY_HOME: join(dir, 'my home'), ORRERY_DB: join(dir, 'data dir', 'o.db') };
  const before = process.cwd();
  try {
    const here = [resolveConfig({}), resolveConfig(env)];
    process.chdir(other);
    assert.deepEqual([resolveConfig({}), resolveConfig(env)], here);
    process.chdir(tmpdir());
    assert.deepEqual([resolveConfig({}), resolveConfig(env)], here);
    for (const c of here) for (const p of [c.home, c.dbPath]) assert.ok(isAbsolute(p), p);
    assert.equal(here[1].home, join(dir, 'my home'));
  } finally {
    process.chdir(before);
  }
});
