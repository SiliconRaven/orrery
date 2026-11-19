import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMAND_PARAM_TYPES, EXTERNAL_API_VERSION, EXTERNAL_PERMISSIONS } from '../src/core/external-plugin-config.ts';
import { MARK_STATES, MARK_TARGETS, UI_POSITIONS } from '../src/core/external-plugin-ui.ts';
import { FIELD_TYPES } from '../src/core/external-plugin-values.ts';

const script = fileURLToPath(new URL('../scripts/plugin-inspect.ts', import.meta.url));
const manifest = {
  id: 'inspect-demo', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', requires: ['tasks'],
  permissions: ['events.read'], events: ['task.submitted'],
  commands: [{ id: 'review', title: 'Review' }],
  config: [{ name: 'note', type: 'text', label: 'Note', scope: 'global' }],
};

test('plugin preflight checks the manifest and entry without running plugin code or registering it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'orrery-test-plugin-inspect-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = '-plugin with spaces.json';
  const path = join(directory, name);
  const marker = join(directory, 'executed');
  const registration = join(directory, 'external-plugins.json');
  const inspect = () => spawnSync(process.execPath, [script, name], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, ORRERY_HOME: directory },
  });

  writeFileSync(path, JSON.stringify(manifest));
  const missing = inspect();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT.*main\.mjs/);

  writeFileSync(join(directory, 'main.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  const valid = inspect();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Plugin dependencies \(declared\): tasks/);
  assert.match(valid.stdout, /Permissions requested: events\.read/);
  assert.match(valid.stdout, /Event subscriptions requested: task\.submitted/);
  assert.match(valid.stdout, /Configuration fields declared: note/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(registration), false);

  writeFileSync(path, JSON.stringify({ ...manifest, apiVersion: 2 }));
  const invalid = inspect();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /unsupported apiVersion/);
});

test('the plugin capabilities catalog follows the local validation constants', () => {
  const result = spawnSync(process.execPath, [script, '--capabilities'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    apiVersion: EXTERNAL_API_VERSION,
    permissions: EXTERNAL_PERMISSIONS,
    uiPositions: UI_POSITIONS,
    commandParamTypes: COMMAND_PARAM_TYPES,
    configFieldTypes: FIELD_TYPES,
    markTargets: MARK_TARGETS,
    markStates: MARK_STATES,
  });
});
