import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';
import { setLanguage, t } from '../shared/i18n/index.js';

const load = (name: string) => import(pathToFileURL(join(REPO_ROOT, 'src/web/public', name)).href);
const workbench = await load('workbench.js');
const labels = await load('workbench-labels.js');
const graph = await load('workbench-graph.js');
const combo = await load('workbench-combobox.js');
const refs = await load('task-refs.js');
const notices = await load('task-diff.js');
const form = await load('workbench-form.js');
const english = (await import(pathToFileURL(join(REPO_ROOT, 'shared/i18n/en-workbench.js')).href)).default;

test('workbench language is selected at display time and leaves user task content intact', () => {
  const task = { id: 'id', number: 12, title: '新建任务', status: 'pending', proposalState: 'active', priority: 'high' };
  try {
    setLanguage('zh');
    assert.equal(workbench.closeCandidateText(task), '#12 新建任务 · 待开工');
    setLanguage('en');
    assert.equal(workbench.closeCandidateText(task), '#12 新建任务 · Pending');
    assert.equal(workbench.statusText({ ...task, status: 'cancelled', closeReason: { kind: 'duplicate' } }), 'Cancelled · Duplicate');
    assert.equal(workbench.taskStatus({ ...task, dependenciesChanged: true }), 'Pending · Dependencies changed; recheck required');
    assert.equal(workbench.reviewModeText({ kind: 'member', memberId: 'a' }, () => '验收者'), 'Member review (验收者)');
    assert.equal(workbench.taskGroups([task])[0].title, 'Pending');
    assert.equal(refs.taskStatusChip('review').label, 'Awaiting review');
    assert.equal(workbench.taskLabel(task), '#12 新建任务');
    assert.match(workbench.taskDeleteWarning(task, 3), /“新建任务”.*permanently deleted/);
    assert.match(workbench.taskDeleteWarning(task, 3), /3 linked chat messages/);
  } finally { setLanguage('zh'); }
});

test('graph, labels, form feedback and combobox use the same English catalog', () => {
  try {
    setLanguage('en');
    assert.equal(combo.comboStatus({ total: 400, shown: Array(200) }, 'branches'), '400 branches; showing the first 200. Type to filter.');
    assert.equal(form.formFilesProblem([{ state: 'uploading' }]), 'Wait for the uploads to finish before saving.');
    assert.equal(labels.missingText([{ name: '用户标签组', labels: ['修复', '功能'] }]), 'Required group “用户标签组”: choose one of 修复、功能.');
    assert.equal(labels.pickerSections({ groups: [], ungrouped: [{ name: '用户标签' }] })[0].title, 'Ungrouped');
    const layout = graph.arrangeGraphLayout({ nodes: [{ id: 'a', task: { status: 'working' } }], layers: [], edges: [] });
    assert.match(layout.sections[0].label, /^In progress \(1\)$/);
    const notice = notices.parseLegacyTaskNotice({ from: 'system', kind: 'system', body: '协作事件 task.create：任务「标题原文」（task-id），事件 9。请按需读取任务上下文。' });
    assert.equal(notice.actionLabel, 'Create task');
    assert.equal(notice.taskTitle, '标题原文');
  } finally { setLanguage('zh'); }
});

test('every workbench English entry preserves its named interpolation fields', () => {
  const fields = (text: string) => [...new Set([...text.matchAll(/{([A-Za-z_]\w*)}/g)].map((match) => match[1]))].sort();
  try {
    setLanguage('en');
    for (const [msgid, translation] of Object.entries(english) as [string, string][]) {
      assert.doesNotMatch(translation, /\p{Script=Han}/u, msgid);
      assert.deepEqual(fields(translation), fields(msgid), msgid);
      assert.notEqual(t(msgid), msgid, msgid);
    }
  } finally { setLanguage('zh'); }
});
