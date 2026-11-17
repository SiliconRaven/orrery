import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Row = { kind: 'equal' | 'remove' | 'add'; text: string };
type LegacyNotice = { action: string; actionLabel: string; taskId: string; taskTitle: string; eventId: string; hasHistoryDiff: false };
const helpers = await import(pathToFileURL(join(process.cwd(), 'src/web/public/task-diff.js')).href) as {
  diffLines(before: string, after: string): { rows: Row[]; exact: boolean };
  diffList<T>(before: T[], after: T[]): { removed: T[]; added: T[] };
  parseLegacyTaskNotice(message: unknown): LegacyNotice | null;
  isTaskChangeNotice(message: unknown): boolean;
};
const rebuild = (rows: Row[], side: 'before' | 'after') => rows
  .filter((row) => row.kind === 'equal' || row.kind === (side === 'before' ? 'remove' : 'add'))
  .map((row) => row.text).join('\n');

test('line diff distinguishes unchanged, removed and added lines and preserves either input', () => {
  const cases: [string, string][] = [
    ['', ''], ['', 'new'], ['old', ''], ['same', 'same'], ['first\nold\nlast', 'first\nnew\nlast'],
    ['a\nb\nc', 'a\nc'], ['a\nc', 'a\nb\nc'], ['a\n', 'a'], ['a', '\na'], ['\n', ''],
    ['甲\r\n😀\r\n结束', '甲\r\n新😀\r\n结束'], ['<img src=x onerror=alert(1)>', '<script>不执行</script>'],
  ];
  for (const [before, after] of cases) {
    const result = helpers.diffLines(before, after);
    assert.equal(result.exact, true);
    assert.equal(rebuild(result.rows, 'before'), before);
    assert.equal(rebuild(result.rows, 'after'), after);
  }
  assert.deepEqual(helpers.diffLines('first\nold\nlast', 'first\nnew\nlast').rows, [
    { kind: 'equal', text: 'first' }, { kind: 'remove', text: 'old' },
    { kind: 'add', text: 'new' }, { kind: 'equal', text: 'last' },
  ]);
  assert.equal(helpers.diffLines('<img src=x onerror=alert(1)>', '').rows[0].text, '<img src=x onerror=alert(1)>');
});

test('current create/edit notices are identified without mistaking titles for event types', () => {
  const message = (body: string, extra: Record<string, unknown> = {}) => ({ from: 'system', kind: 'system', collabEventId: 42, body, ...extra });
  assert.equal(helpers.isTaskChangeNotice(message('任务【标题】已创建（建单人 用户），事件 42。')), true);
  assert.equal(helpers.isTaskChangeNotice(message('任务 #12【标题】已创建（建单人 用户），事件 42。')), true);
  assert.equal(helpers.isTaskChangeNotice(message('任务【标题】已更新：改了 附件，事件 42。')), true);
  assert.equal(helpers.isTaskChangeNotice(message('任务 #12【标题】已更新：改了 附件，事件 42。')), true);
  assert.equal(helpers.isTaskChangeNotice(message('任务【标题】已更新：改了 范围、附件，事件 42。')), true);
  assert.equal(helpers.isTaskChangeNotice(message('任务【含】已更新：改了 标题\n的标题】已更新：改了 范围、优先级，事件 42。')), true);
  assert.equal(helpers.isTaskChangeNotice(message('任务【含】已更新：改了 标题】已取消，事件 42。')), false);
  assert.equal(helpers.isTaskChangeNotice(message('任务【标题】已更新：改了 范围，事件 43。')), false);
  assert.equal(helpers.isTaskChangeNotice(message('任务【标题】已更新：改了 范围，事件 42。', { from: 'user' })), false);
  assert.equal(helpers.isTaskChangeNotice(message('任务【标题】已更新：改了 范围，事件 42。', { collabEventId: undefined })), false);
});

test('line diff handles repeated lines deterministically with an exact common subsequence', () => {
  const result = helpers.diffLines('A\nx\nA\nz', 'A\nA\ny\nz');
  assert.equal(result.exact, true);
  assert.deepEqual(result.rows, [
    { kind: 'equal', text: 'A' }, { kind: 'remove', text: 'x' }, { kind: 'equal', text: 'A' },
    { kind: 'add', text: 'y' }, { kind: 'equal', text: 'z' },
  ]);
  assert.deepEqual(helpers.diffLines('same\nsame', 'same').rows, [
    { kind: 'equal', text: 'same' }, { kind: 'remove', text: 'same' },
  ]);
});

test('large inputs explicitly report the bounded fallback and reconstruct both versions', () => {
  const longLine = helpers.diffLines('a'.repeat(20_000), 'a'.repeat(19_999) + 'b');
  assert.equal(longLine.exact, true);
  assert.equal(rebuild(longLine.rows, 'before'), 'a'.repeat(20_000));
  assert.equal(rebuild(longLine.rows, 'after'), 'a'.repeat(19_999) + 'b');
  const left = Array(10100).fill('a');
  const right = Array(10100).fill('b');
  left[4000] = right[4000] = 'shared';
  const before = ['prefix', ...left, 'suffix'].join('\n');
  const after = ['prefix', ...right, 'suffix'].join('\n');
  assert.ok(Buffer.byteLength(before) > 20_000 && Buffer.byteLength(before) <= 20_480);
  assert.ok(Buffer.byteLength(after) > 20_000 && Buffer.byteLength(after) <= 20_480);
  const result = helpers.diffLines(before, after);
  assert.equal(result.exact, false);
  assert.equal(rebuild(result.rows, 'before'), before);
  assert.equal(rebuild(result.rows, 'after'), after);
  assert.deepEqual(result.rows[0], { kind: 'equal', text: 'prefix' });
  assert.deepEqual(result.rows.at(-1), { kind: 'equal', text: 'suffix' });
  assert.ok(result.rows.some((row) => row.kind === 'remove' && row.text === 'shared'));
  assert.ok(result.rows.some((row) => row.kind === 'add' && row.text === 'shared'));
});

test('list changes retain each side’s order and account for duplicate values', () => {
  assert.deepEqual(helpers.diffList(['a', 'b', 'a', 'c'], ['a', 'c', 'd', 'd']), {
    removed: ['b', 'a'], added: ['d', 'd'],
  });
  assert.deepEqual(helpers.diffList([], ['角色', '依赖']), { removed: [], added: ['角色', '依赖'] });
  assert.deepEqual(helpers.diffList(['x', 'y'], ['y', 'x']), { removed: [], added: [] });
});

test('legacy task notices require system identity and never infer actor or review outcome', () => {
  const body = '协作事件 task.review：任务「中文😀「草稿」」（task-123），事件 9007199254740993。请按需读取任务上下文。';
  const result = helpers.parseLegacyTaskNotice({ from: 'system', kind: 'system', body });
  assert.deepEqual(result, { action: 'task.review', actionLabel: '记录验收', taskId: 'task-123',
    taskTitle: '中文😀「草稿」', eventId: '9007199254740993', hasHistoryDiff: false });
  assert.equal(Object.hasOwn(result!, 'actor'), false);
  assert.equal(Object.hasOwn(result!, 'verdict'), false);
  for (const message of [
    { from: 'user', kind: 'system', body }, { from: 'system', kind: 'task_comment', body },
    { from: 'system', body }, { from: 'member', kind: 'system', body },
    { from: 'system', kind: 'system', body: '引用：' + body },
    { from: 'system', kind: 'system', body: body + '多余内容' },
    { from: 'system', kind: 'system', body: '协调设置已更新。' },
  ]) assert.equal(helpers.parseLegacyTaskNotice(message), null);
});

test('legacy task actions use Chinese labels and unknown actions have a neutral fallback', () => {
  const make = (action: string) => ({ from: 'system', kind: 'system',
    body: `协作事件 ${action}：任务「标题」（abc-123），事件 42。请按需读取任务上下文。` });
  assert.equal(helpers.parseLegacyTaskNotice(make('task.create'))?.actionLabel, '创建任务');
  assert.equal(helpers.parseLegacyTaskNotice(make('task.claim'))?.actionLabel, '接取任务');
  assert.equal(helpers.parseLegacyTaskNotice(make('task.resolve_attention'))?.actionLabel, '处理待处理事项');
  assert.equal(helpers.parseLegacyTaskNotice({ from: 'system', kind: 'system',
    body: '协作事件 task.edit：任务「<img src=x>」（abc-123），事件 42。请按需读取任务上下文。' })?.taskTitle, '<img src=x>');
  assert.deepEqual(helpers.parseLegacyTaskNotice(make('task.future_event')), {
    action: 'task.future_event', actionLabel: '其他任务事件', taskId: 'abc-123', taskTitle: '标题', eventId: '42', hasHistoryDiff: false,
  });
});
