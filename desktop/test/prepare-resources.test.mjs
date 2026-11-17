import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { stageHub, verifySha256 } from '../scripts/prepare-resources.mjs';

test('resource staging rejects changed archives and excludes untracked runtime data and dependencies', async () => {
  const bytes = Buffer.from('verified fixture');
  const sha = createHash('sha256').update(bytes).digest('hex');
  verifySha256(bytes, sha);
  assert.throws(() => verifySha256(Buffer.from('changed fixture'), sha), /SHA256 mismatch/);
  const temp = await mkdtemp(join(tmpdir(), 'orrery-resources-'));
  try {
    const source = join(temp, 'source');
    const staged = join(temp, 'hub');
    const tracked = ['src/main.ts', 'plugins/demo/main.mjs', 'package.json', 'package-lock.json', 'LICENSE', 'scripts/ship.ts', 'scripts/test-queue.ts'];
    for (const file of [...tracked, 'plugins/demo/node_modules/dev/index.js', 'plugins/demo/local.log', '.env']) {
      await mkdir(dirname(join(source, file)), { recursive: true });
      await writeFile(join(source, file), file);
    }
    for (const args of [['init', '-q'], ['add', '--', ...tracked]]) {
      const result = spawnSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    await stageHub(source, staged);
    for (const file of tracked) assert.equal(await readFile(join(staged, file), 'utf8'), file);
    for (const file of ['plugins/demo/node_modules', 'plugins/demo/local.log', '.env']) assert.equal(existsSync(join(staged, file)), false, file);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
