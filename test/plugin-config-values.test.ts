import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase } from '../src/backup.ts';
import { parseExternalManifest, readExternalPlugins } from '../src/core/external-plugin-config.ts';
import {
  effectivePluginConfig, parsePluginConfigFields, PluginConfigProblem, validatePluginConfigValues,
} from '../src/core/external-plugin-values.ts';
import { Store } from '../src/core/store.ts';
import { tempDir } from './helpers.ts';

const manifest = { id: 'preferences', version: '1.0.0', apiVersion: 1, entry: 'index.mjs', permissions: [], commands: [] };
const noMembers = new Set<string>();
const members = new Set(['member-one']);
const specs = [
  { name: 'title', label: '标题', type: 'text', scope: 'global', required: true, default: '简报' },
  { name: 'count', label: '条数', type: 'number', scope: 'global', min: 0, max: 20 },
  { name: 'enabled', label: '显示日期', type: 'boolean', scope: 'global', default: true },
  { name: 'format', label: '格式', type: 'enum', scope: 'global', options: ['md', 'txt'], default: 'md' },
  { name: 'folder', label: '本机目录', type: 'path', scope: 'global' },
  { name: 'wait', label: '间隔', type: 'duration', scope: 'cluster', min: 1, max: 7200, default: 90 },
  { name: 'owner', label: '负责人', type: 'member', scope: 'cluster', required: true, default: 'member-one' },
  { name: 'sections', label: '栏目', type: 'list', scope: 'cluster', default: ['进展', '计划'] },
];
const fields = parsePluginConfigFields(specs);

test('manifests opt into config and reject invalid declarations or defaults before the plugin runs', () => {
  assert.equal(Object.hasOwn(parseExternalManifest(manifest), 'config'), false);
  assert.deepEqual(parseExternalManifest({ ...manifest, config: specs }).config, fields);
  assert.deepEqual(parsePluginConfigFields([]), []);
  const invalid: unknown[] = [
    null, {}, [null], Array(33).fill(specs[0]), [specs[0], { ...specs[0], scope: 'cluster' }],
    [{ ...specs[0], name: 'two words' }], [{ ...specs[0], label: '  ' }], [{ ...specs[0], type: 'password' }],
    [{ ...specs[0], scope: 'private' }], [{ ...specs[0], extra: true }], [{ ...specs[0], required: 'yes' }],
    [{ ...specs[0], default: false }], [{ ...specs[0], default: ' ' }], [{ ...specs[1], min: 21 }],
    [{ ...specs[1], default: 25 }], [{ ...specs[1], default: '2' }], [{ ...specs[2], default: 0 }],
    [{ ...specs[2], min: 0 }], [{ ...specs[2], options: ['a'] }], [{ ...specs[3], options: [] }],
    [{ ...specs[3], options: ['md', 'md'] }], [{ ...specs[3], default: 'other' }], [{ ...specs[4], default: 'relative' }],
    [{ ...specs[5], default: '15m' }], [{ ...specs[5], min: 1.5 }], [{ ...specs[6], default: '' }],
    [{ ...specs[7], default: [1] }], [{ ...specs[7], default: ['a\nb'] }],
  ];
  for (const config of invalid) assert.throws(() => parseExternalManifest({ ...manifest, config }), /config/);
  const dir = tempDir();
  const file = join(dir, 'orrery-plugin.json');
  writeFileSync(join(dir, 'external-plugins.json'), JSON.stringify({ plugins: [{ manifest: file }] }));
  writeFileSync(file, '{"config":[{"default":PRIVATEVALUE}]}');
  const [failure] = readExternalPlugins(dir).failures;
  assert.match(failure.error, /invalid external plugin JSON/);
  assert.doesNotMatch(failure.error, /PRIVATE/);
});

test('saves typed explicit overrides, applies defaults and checks required values in the edited scope', () => {
  const input = { title: '简报', enabled: false, count: 0, format: 'txt', folder: 'C:\\missing\\sample',
    wait: '15m', owner: null, sections: ['同名', '同名'] };
  const saved = validatePluginConfigValues(fields, input, members);
  assert.deepEqual(saved, { enabled: false, count: 0, format: 'txt', folder: input.folder, wait: 900, sections: input.sections });
  assert.deepEqual(effectivePluginConfig(fields, saved, members), { ...input, owner: 'member-one', wait: 900 });
  assert.deepEqual(validatePluginConfigValues(fields, { sections: ['进展', '计划'], format: null }, members), {});
  assert.deepEqual(validatePluginConfigValues(fields, { sections: [] }, members), { sections: [] });
  const required = parsePluginConfigFields([{ name: 'selected', type: 'boolean', label: '显示', scope: 'global', required: true }]);
  assert.deepEqual(validatePluginConfigValues(required, { selected: false }, noMembers), { selected: false });
  assert.deepEqual(effectivePluginConfig(required, {}, noMembers), {});
  assert.throws(() => validatePluginConfigValues(required, {}, noMembers), { code: 'CONFIG_INVALID', field: 'selected' });

  for (const path of ['/', '/not/a/real/dir', 'X:/not-a-real-dir', 'D:\\']) {
    assert.equal(validatePluginConfigValues(fields, { folder: path }, members).folder, path);
  }
  for (const [name, value] of Object.entries({ count: '0', enabled: 'false', title: ' ', owner: 'outside', format: 'other',
    sections: Array(65).fill('x'), wait: '1m30', folder: '/server\u0000path' })) {
    assert.throws(() => validatePluginConfigValues(fields, { [name]: value }, members), { code: 'CONFIG_INVALID', field: name });
  }
  for (const folder of ['X:relative', '\\rooted', '\\\\server\\share', '//server/share', 'file:///tmp', '/' + 'x'.repeat(4096)]) {
    assert.throws(() => validatePluginConfigValues(fields, { folder }, members), { code: 'CONFIG_INVALID', field: 'folder' });
  }
  assert.throws(() => validatePluginConfigValues(fields, { undeclared: 'private-note' }, members), (e) => {
    assert.ok(e instanceof PluginConfigProblem);
    assert.equal(e.field, null);
    assert.doesNotMatch(e.message, /private-note/);
    return true;
  });
});

test('new declarations and live membership bound persisted values, including ordinary field names inherited by Object', () => {
  const fresh = parsePluginConfigFields([
    { ...specs[0], default: '新版' }, { ...specs[1], max: 3, default: 2 }, specs[3], specs[6],
    { name: 'constructor', label: '构造名', type: 'text', scope: 'cluster' },
    { name: 'toString', label: '名称', type: 'text', scope: 'cluster' },
  ]);
  const old = { count: 19, owner: 'previous', format: 'removed', gone: 'only old schema', toString: '保留' };
  assert.deepEqual(effectivePluginConfig(fresh, old, noMembers), { title: '新版', count: 2, format: 'md', toString: '保留' });
  assert.equal(effectivePluginConfig(fresh, old, members).owner, 'member-one');
  assert.throws(() => validatePluginConfigValues(fresh, {}, noMembers), { code: 'CONFIG_INVALID', field: 'owner' });
  const data = validatePluginConfigValues(fresh, { constructor: '构造', toString: '显示' }, members);
  assert.deepEqual(data, { constructor: '构造', toString: '显示' });
  const bad = 'this entered value must stay out of errors';
  assert.throws(() => validatePluginConfigValues(fresh, { count: bad }, members), (e) => {
    assert.ok(e instanceof PluginConfigProblem && e.field === 'count');
    assert.ok(!e.message.includes(bad));
    return true;
  });
});

test('SQLite config survives restart and backup, detects stale writes, and purges precisely one deleted group', () => {
  const dir = tempDir();
  const path = join(dir, 'config.db');
  const id = 'group_%:a';
  const sibling = id + ':b';
  let db = new Store(path);
  try {
    for (const clusterId of [id, sibling]) db.insertCluster({ id: clusterId, name: clusterId, category: '', createdAt: '2026-01-01' }, []);
    const seq = db.lastEventSeq();
    assert.deepEqual(db.getPluginConfig('p', id), { revision: 0, values: {} });
    db.setPluginConfig('p', null, { revision: 1, values: { title: 'private global' } });
    db.setPluginConfig('p', id, { revision: 1, values: { text: 'private group' } });
    db.setPluginConfig('q', id, { revision: 1, values: {} });
    db.setPluginConfig('p', sibling, { revision: 1, values: { count: 0 } });
    const concurrent = new Store(path);
    try {
      const previous = concurrent.getPluginConfig('p', id);
      db.setPluginConfig('p', id, { revision: 2, values: { text: 'last saved' } });
      assert.throws(() => concurrent.setPluginConfig('p', id, { revision: previous.revision + 1, values: {} }), { code: 'CONFIG_CONFLICT' });
    } finally { concurrent.close(); }
    assert.throws(() => db.setPluginConfig('p', 'not-a-group', { revision: 1, values: {} }), { code: 'CONFIG_CONFLICT' });
    assert.equal(db.lastEventSeq(), seq, 'settings write no Hub events');
    const copy = new Store(backupDatabase(path, dir, join(dir, 'backup')));
    try {
      assert.deepEqual(copy.getPluginConfig('p', null), { revision: 1, values: { title: 'private global' } });
      assert.deepEqual(copy.getPluginConfig('p', id), { revision: 2, values: { text: 'last saved' } });
    } finally { copy.close(); }
    db.close();
    db = new Store(path);
    db.deleteCluster(id);
    assert.throws(() => db.setPluginConfig('p', id, { revision: 3, values: {} }), { code: 'CONFIG_CONFLICT' });
    db.restoreCluster(id);
    assert.deepEqual(db.getPluginConfig('p', id), { revision: 2, values: { text: 'last saved' } });
    db.deleteCluster(id);
    db.purgeCluster(id, () => {});
    assert.deepEqual(db.getPluginConfig('p', id), { revision: 0, values: {} });
    assert.deepEqual(db.getPluginConfig('q', id), { revision: 0, values: {} });
    assert.deepEqual(db.getPluginConfig('p', sibling), { revision: 1, values: { count: 0 } });
    assert.deepEqual(db.getPluginConfig('p', null), { revision: 1, values: { title: 'private global' } });
  } finally { db.close(); }
});
