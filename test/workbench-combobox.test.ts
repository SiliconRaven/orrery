// The task form's suggestion list (src/web/public/workbench-combobox.js): the filter and every key's effect, as pure
// state. The real page (scrolling, placement, the dialog's Enter and Esc) is in test/workbench-combobox-browser.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const { COMBO_LIMIT, COMBO_START, comboOptions, comboStatus, filterCombo, fold, matchParts, nextCombo } =
  await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench-combobox.js')).href);

type State = typeof COMBO_START;
const run = (state: State, ...events: object[]): State => events.reduce((s: State, e) => nextCombo(s, e), state);
const loaded = (items: unknown[]) => run(COMBO_START, { type: 'load' }, { type: 'loaded', gen: 1, items });
const values = (state: State) => state.shown.map((option: { value: string }) => option.value);
const key = (k: string, value = '', composing = false) => ({ type: 'key', key: k, value, composing });
const BRANCHES = ['main', 'develop', 'feature/Login', 'agent/a/login-fix', 'release'];

test('the filter matches any part of the value or label in any case, and cuts at the limit', () => {
  const options = comboOptions(['main', 'Feature/LOGIN', { value: 'C:\\repo', label: 'Orrery' }, { value: 'same', label: 'same' }]);
  assert.deepEqual(options[3], { value: 'same', label: '', key: 'same\nsame' }, 'a label equal to the value is not shown twice');
  assert.deepEqual(filterCombo(options, 'login').shown.map((o: { value: string }) => o.value), ['Feature/LOGIN']);
  assert.deepEqual(filterCombo(options, ' orr ').shown.map((o: { value: string }) => o.value), ['C:\\repo'], 'labels match, blanks trimmed');
  assert.equal(filterCombo(options, '').total, 4);
  const many = comboOptions(Array.from({ length: 2000 }, (_, i) => `agent/x/topic-${i}`));
  const started = performance.now();
  const all = filterCombo(many, 'topic');
  const some = filterCombo(many, 'topic-19');
  assert.ok(performance.now() - started < 50, 'filtering 2,000 branches is instant');
  assert.deepEqual([all.shown.length, all.total, COMBO_LIMIT], [200, 2000, 200]);
  assert.deepEqual([some.shown.length, some.total], [111, 111]);
  assert.deepEqual(matchParts('Feature/LOGIN', 'log'), ['Feature/', 'LOG', 'IN'], 'the match keeps its own case');
  assert.equal(matchParts('main', 'x'), null);
  assert.equal(matchParts('main', ''), null);
});

test('typing opens the matches with nothing highlighted, so Enter keeps free text; no match closes the list', () => {
  let s = run(loaded(BRANCHES), { type: 'input', value: 'LOG' });
  assert.deepEqual([s.open, s.active, values(s)], [true, -1, ['feature/Login', 'agent/a/login-fix']]);
  s = nextCombo(s, key('Enter', 'LOG'));
  assert.deepEqual([s.open, s.handled, s.chosen], [false, true, null], 'Enter closes the list, keeps the typed text and does not submit');
  s = nextCombo(s, key('Enter', 'LOG'));
  assert.deepEqual([s.handled, s.chosen], [false, null], 'with the list closed, Enter submits the form');
  s = run(s, { type: 'input', value: 'feature/new-name' });
  assert.deepEqual([s.open, s.shown.length], [false, 0], 'a name that is not in the list: no empty popup');
  assert.equal(nextCombo(s, key('Escape')).handled, false, 'nothing open: Esc closes the dialog');
});

test('every key with the list closed', () => {
  const closed = loaded(BRANCHES);
  for (const k of ['Enter', 'Escape', 'Tab', 'Home', 'End', 'a']) {
    const s = nextCombo(closed, key(k, 'ma'));
    assert.deepEqual([s.open, s.handled, s.chosen], [false, false, null], `${k} is left to the field and the form`);
  }
  let s = nextCombo(closed, key('ArrowDown', ''));
  assert.deepEqual([s.open, s.active, s.handled, s.shown.length], [true, 0, true, 5], '↓ opens on the first row');
  s = nextCombo(closed, key('ArrowUp', ''));
  assert.deepEqual([s.open, s.active, s.handled], [true, 4, true], '↑ opens on the last row');
  s = nextCombo(closed, key('ArrowDown', 'develop'));
  assert.deepEqual([s.active, values(s).length], [1, 5], 'the field holds an option: every option, that one highlighted');
  s = nextCombo(closed, key('ArrowDown', 'LOGIN'));
  assert.deepEqual([s.active, values(s)], [0, ['feature/Login', 'agent/a/login-fix']], 'partial text: its matches');
  for (const k of ['ArrowDown', 'ArrowUp']) {
    s = nextCombo(closed, key(k, 'nothing-like-it'));
    assert.deepEqual([s.open, s.active, values(s).length], [true, -1, 5], `${k} on text that matches nothing: every option, none highlighted`);
    const entered = nextCombo(s, key('Enter', 'nothing-like-it'));
    assert.deepEqual([entered.open, entered.chosen, entered.handled], [false, null, true], 'so Enter just closes and keeps the text');
  }
  s = run(closed, key('ArrowDown', 'nothing-like-it'), key('ArrowUp'));
  assert.equal(s.active, 4, '↑ from no row goes to the last, as ↓ goes to the first');
  s = nextCombo(closed, key('ArrowUp', 'LOGIN'));
  assert.deepEqual([s.active, values(s)], [1, ['feature/Login', 'agent/a/login-fix']], '↑ on partial text: the last of its matches');
  s = nextCombo(COMBO_START, key('ArrowDown'));
  assert.deepEqual([s.open, s.handled], [false, false], 'no options: the arrows are the field’s');
});

test('every key with the list open', () => {
  const open = nextCombo(loaded(BRANCHES), { type: 'show', value: '' });
  assert.deepEqual([open.open, open.active], [true, -1], 'a click shows every option, none highlighted');
  const moves: [string, number, number][] = [['ArrowDown', -1, 0], ['ArrowDown', 3, 4], ['ArrowDown', 4, 4], ['ArrowUp', -1, 4],
    ['ArrowUp', 2, 1], ['ArrowUp', 0, 0], ['Home', 3, 0], ['End', 1, 4]];
  for (const [k, from, to] of moves) {
    const s = nextCombo({ ...open, active: from }, key(k));
    assert.deepEqual([s.open, s.active, s.handled], [true, to, true], `${k} from ${from}`);
  }
  let s = nextCombo({ ...open, active: 4 }, key('Enter'));
  assert.deepEqual([s.open, s.chosen, s.handled], [false, 'release', true], 'Enter takes the highlighted row');
  s = nextCombo({ ...open, active: 2 }, key('Escape'));
  assert.deepEqual([s.open, s.chosen, s.handled], [false, null, true], 'Esc closes only the list');
  s = nextCombo({ ...open, active: 2 }, key('Tab'));
  assert.deepEqual([s.open, s.chosen, s.handled], [false, null, false], 'Tab closes and moves on');
  s = nextCombo({ ...open, active: 2 }, key('x'));
  assert.deepEqual([s.open, s.active, s.handled], [true, 2, false], 'other keys type');
  for (const k of ['Enter', 'Escape', 'ArrowDown', 'Tab']) {
    s = nextCombo({ ...open, active: 2 }, key(k, '', true));
    assert.deepEqual([s.open, s.active, s.handled, s.chosen], [true, 2, false, null], `${k} during IME composition is the input method's`);
  }
  s = nextCombo(open, { type: 'pick', index: 3 });
  assert.deepEqual([s.open, s.chosen], [false, 'agent/a/login-fix'], 'a click on a row takes it');
  assert.equal(nextCombo(open, { type: 'pick', index: 9 }).chosen, null);
  assert.equal(nextCombo(open, { type: 'show', value: 'main' }).active, -1, 'a click while open leaves the list as it is');
  assert.equal(nextCombo(open, { type: 'toggle', value: '' }).open, false, 'the arrow button closes it');
  assert.equal(nextCombo(open, { type: 'close' }).open, false);
  assert.equal(nextCombo(open, { type: 'other' }), open);
});

test('an answer for an older load is dropped; a new load empties and closes the list', () => {
  let s = run(COMBO_START, { type: 'load' }, { type: 'load' });
  assert.equal(s.gen, 2);
  s = nextCombo(s, { type: 'loaded', gen: 2, items: ['new-a', 'new-b'] });
  s = nextCombo(s, { type: 'loaded', gen: 1, items: ['stale'] });
  assert.deepEqual(values(s), ['new-a', 'new-b'], 'the late answer of the first load does not replace the newer options');
  s = run(s, key('ArrowDown'), key('ArrowDown'));
  assert.deepEqual([s.open, s.active], [true, 1]);
  s = nextCombo(s, { type: 'load' });
  assert.deepEqual([s.open, s.active, s.shown.length, s.gen], [false, -1, 0, 3], 'the repository changed while the list was open');
  s = nextCombo(s, { type: 'loaded', gen: 3, items: ['x'] });
  assert.deepEqual([s.open, values(s)], [false, ['x']], 'options arriving do not pop the list open');
});

test('the status line appears only when the matches are cut', () => {
  const many = loaded(Array.from({ length: 450 }, (_, i) => `agent/b/${i}`));
  let s = nextCombo(many, { type: 'show', value: '' });
  assert.equal(comboStatus(s, '分支'), '450 个分支，显示前 200 个，输入可筛选');
  s = nextCombo(s, { type: 'input', value: 'b/1' });
  assert.equal(s.total, 111);
  assert.equal(comboStatus(s, '分支'), '');
  s = run(s, key('End'));
  assert.equal(s.active, 110, 'End reaches the last drawn row');
});

test('the current branch past the drawn rows is pinned on top and highlighted, so Enter keeps it', () => {
  const names = [...Array.from({ length: 450 }, (_, i) => `agent/task-${String(i).padStart(3, '0')}`), 'main'];
  for (const event of [key('ArrowDown', 'main'), key('ArrowUp', 'main'), { type: 'show', value: 'main' }, { type: 'toggle', value: ' main ' }]) {
    let s = nextCombo(loaded(names), event);
    assert.deepEqual([s.open, s.shown.length, s.active, s.shown[0].value, s.shown[1].value], [true, 200, 0, 'main', 'agent/task-000'],
      `${JSON.stringify(event)}: main drawn first and highlighted`);
    assert.equal(comboStatus(s, '分支'), '451 个分支，显示前 200 个，输入可筛选');
    s = nextCombo(s, key('Enter', 'main'));
    assert.equal(s.chosen, 'main', 'Enter keeps main');
  }
  const within = nextCombo(loaded(names), key('ArrowDown', 'agent/task-150'));
  assert.deepEqual([within.active, within.shown[0].value], [150, 'agent/task-000'], 'a current branch among the drawn rows stays in place');
});

test('case folding keeps every index, so the highlight is the filtered match for any text', () => {
  for (const text of ['İstanbul/feature', 'Straße/ẞ', '𐐀𐐁-Deseret', 'Café/É', 'MAIN']) assert.equal(fold(text).length, text.length, text);
  assert.deepEqual(matchParts('İstanbul/feature', 'feat'), ['İstanbul/', 'feat', 'ure'], 'İ (two units in lower case) does not shift the match');
  assert.deepEqual(matchParts('İstanbul/feature', 'İst'), ['', 'İst', 'anbul/feature']);
  assert.deepEqual(matchParts('Straße/x', 'SSE'), null, 'ß is not expanded to ss, in the filter or the highlight');
  assert.deepEqual(matchParts('Straße/x', 'AßE'), ['Str', 'aße', '/x']);
  assert.deepEqual(matchParts('x/𐐀𐐁', '𐐨𐐩'), ['x/', '𐐀𐐁', ''], 'a surrogate pair folds as one code point');
  assert.deepEqual(matchParts('Café-x', 'É'), ['Caf', 'é', '-x'], 'a combining sequence keeps its mark');
  // Property: whenever the filter keeps an option, the highlighted slice of the value or label, folded, is the folded query.
  const texts = ['İstanbul/feature', 'Straße/ẞ-big', 'x/𐐀𐐁-y', 'Café/É', 'ΣΊΣΥΦΟΣ/ς', 'agent/İİ-ı', 'ǅungla/Ǆ'];
  const options = comboOptions(texts);
  for (const text of texts) {
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      for (let j = i + 1; j <= Math.min(chars.length, i + 4); j++) {
        for (const query of [chars.slice(i, j).join(''), chars.slice(i, j).join('').toUpperCase(), chars.slice(i, j).join('').toLowerCase()]) {
          if (!query.trim()) continue;
          for (const option of filterCombo(options, query).shown) {
            const parts = matchParts(option.value, query);
            assert.ok(parts, `${option.value} kept by the filter for ${query} has a highlight`);
            assert.equal(fold(parts[1]), fold(query.trim()), `${option.value} / ${query}`);
            assert.equal(parts.join(''), option.value);
          }
        }
      }
    }
  }
});
