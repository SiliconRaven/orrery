import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerHub } from '../src/hub-registry.ts';

// Uses only built-in modules so the Windows CI runner can check ACLs before installing dependencies.
test('Windows registry starts with private ACLs and rejects wider directory or key permissions',
  { skip: process.platform !== 'win32' }, async (t) => {
    for (const relative of ['bridge-secret', '.']) {
      const root = mkdtempSync(join(tmpdir(), 'orrery-test-acl-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = join(root, 'home');
      const registry = join(root, 'registry');
      mkdirSync(home);
      const opts = { home, name: 'ACL test', url: 'http://127.0.0.1:1' };
      await (await registerHub(registry, opts)).close();
      await (await registerHub(registry, opts)).close();

      const path = join(registry, relative);
      execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
      await assert.rejects(registerHub(registry, opts), (error: Error) =>
        error.message === `Orrery registry ACL could not be verified as private: ${path} (ACL rejected)`);
    }
  });
