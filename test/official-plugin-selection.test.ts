import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectOfficialVersions, type OfficialChoice, type OfficialVariants } from '../src/official-plugin-selection.ts';

const plugin = (id: string, version: string, requires: OfficialChoice['requires'] = []): OfficialChoice => ({ id, version, requires });
const tasksBefore2 = [{ id: 'tasks', minVersion: '1.0.0', beforeVersion: '2.0.0' }];

test('an ineligible active version can fall back to the previous compatible signed package', () => {
  const v2 = plugin('fixture', '2.0.0');
  // The caller ruled out corrupt v3, and bundled v1 cannot read the database after the first migration.
  assert.deepEqual(selectOfficialVersions([{ id: 'fixture', enabled: true, previous: v2 }]), [v2]);
});

test('returns no selection if the current migration floor rules out every candidate for an ID', () => {
  const tasks = plugin('tasks', '1.0.0');
  assert.equal(selectOfficialVersions([{ id: 'tasks', enabled: true, original: tasks }, { id: 'fixture', enabled: false }]), null);
});

test('a newer bundled choice may replace one ID only when the whole original group still works', () => {
  const tasks1 = plugin('tasks', '1.9.0');
  const tasks2 = plugin('tasks', '2.0.0');
  const coordinator = plugin('coordinator', '1.0.0', tasksBefore2);
  const starmap1 = plugin('starmap', '1.0.0');
  const starmap2 = plugin('starmap', '2.0.0');
  const variants = [
    { id: 'tasks', enabled: true, original: tasks1, active: tasks1, bundled: tasks2 },
    { id: 'coordinator', enabled: true, original: coordinator, bundled: coordinator },
    { id: 'starmap', enabled: false, original: starmap1, active: starmap1, bundled: starmap2 },
  ];
  assert.deepEqual(selectOfficialVersions(variants), [tasks1, coordinator, starmap2]);
});

test('fallback tries active then previous then bundled in registry order and prunes incompatible combinations', () => {
  const tasks1 = plugin('tasks', '1.0.0');
  const tasks2 = plugin('tasks', '2.0.0');
  const coordinator1 = plugin('coordinator', '1.0.0', tasksBefore2);
  const coordinator2 = plugin('coordinator', '2.0.0', [{ id: 'tasks', minVersion: '2.0.0' }]);
  // The original coordinator is unavailable. Previous is incompatible with active tasks, but bundled works with it.
  const variants: OfficialVariants<OfficialChoice>[] = [
    { id: 'tasks', enabled: true, original: tasks2, active: tasks2, previous: tasks1 },
    { id: 'coordinator', enabled: true, previous: coordinator1, bundled: coordinator2 },
  ];
  assert.deepEqual(selectOfficialVersions(variants), [tasks2, coordinator2]);
  assert.deepEqual(selectOfficialVersions(variants.with(1, { ...variants[1], bundled: undefined })), [tasks1, coordinator1]);
});

test('pending must be newer and preserve the other choices, and pins its ID against a bundled upgrade', () => {
  const tasks1 = plugin('tasks', '1.0.0');
  const tasks2 = plugin('tasks', '2.0.0');
  const coordinator1 = plugin('coordinator', '1.0.0', tasksBefore2);
  const coordinator2 = plugin('coordinator', '2.0.0', tasksBefore2);
  const coordinator3 = plugin('coordinator', '3.0.0', tasksBefore2);
  const variants = [
    { id: 'tasks', enabled: true, original: tasks1, active: tasks1, bundled: tasks2 },
    { id: 'coordinator', enabled: true, original: coordinator1, active: coordinator1, bundled: coordinator3 },
  ];
  assert.deepEqual(selectOfficialVersions(variants, tasks2), [tasks1, coordinator3]);
  assert.deepEqual(selectOfficialVersions(variants, coordinator1), [tasks1, coordinator3]);
  assert.deepEqual(selectOfficialVersions(variants, coordinator2), [tasks1, coordinator2]);
});

test('a pending package compatible with partially migrated data can restart without a compatible baseline', () => {
  const pending = plugin('tasks', '2.0.0');
  const coordinator1 = plugin('coordinator', '1.0.0', tasksBefore2);
  const coordinator2 = plugin('coordinator', '2.0.0', [{ id: 'tasks', minVersion: '2.0.0' }]);
  const variants: OfficialVariants<OfficialChoice>[] = [
    { id: 'tasks', enabled: true },
    { id: 'coordinator', enabled: true, original: coordinator1, active: coordinator1, previous: coordinator2 },
  ];
  assert.equal(selectOfficialVersions(variants), null);
  assert.deepEqual(selectOfficialVersions(variants, pending), [pending, coordinator2]);
});

test('registration order and dependencies apply even if both plugins are disabled', () => {
  const tasks1 = plugin('tasks', '1.0.0');
  const tasks2 = plugin('tasks', '2.0.0');
  const coordinator = plugin('coordinator', '1.0.0', tasksBefore2);
  const taskSlot = { id: 'tasks', enabled: false, original: tasks1, bundled: tasks1 };
  const coordinatorSlot = { id: 'coordinator', enabled: false, original: coordinator, bundled: coordinator };
  assert.deepEqual(selectOfficialVersions([taskSlot, coordinatorSlot]), [tasks1, coordinator]);
  assert.equal(selectOfficialVersions([taskSlot, { ...coordinatorSlot, enabled: true }]), null);
  assert.equal(selectOfficialVersions([coordinatorSlot, taskSlot]), null);
  assert.equal(selectOfficialVersions([coordinatorSlot]), null);
  assert.equal(selectOfficialVersions([{ ...taskSlot, original: tasks2, bundled: tasks2 }, coordinatorSlot]), null);
});
