import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { LANGUAGE_KEY, language, forcedLanguage, languageInAddress, onLanguageChange, setLanguage, t, translateStatic } from '../shared/i18n/index.js';

test('UI language defaults to Chinese, persists browser choices, and preserves interpolation values', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '' } });
  try {
    assert.equal(language(), 'zh');
    assert.equal(t('语言'), '语言');
    setLanguage('en');
    assert.equal(values.get(LANGUAGE_KEY), 'en');
    assert.equal(t('语言'), 'Language');
    assert.equal(t('未收录 {name} {count}', { name: '<b>用户名字</b>', count: 0 }), '未收录 <b>用户名字</b> 0');
    assert.throws(() => setLanguage('fr' as any), /zh or en/);
    (globalThis as any).location.search = '?uiLang=zh';
    assert.equal(forcedLanguage(), 'zh');
    assert.equal(setLanguage('en'), 'zh');
    assert.equal(t('语言'), '语言');
    assert.equal(values.get(LANGUAGE_KEY), 'en', 'forced pages do not overwrite browser preferences');
    globalThis.location.search = '?uiLang=bad';
    assert.equal(language(), 'zh', 'an invalid uiLang keeps the language the address had');
    assert.equal(languageInAddress(), true, 'and the page stays desktop-owned');
    globalThis.location.search = '';
    assert.equal(language(), 'en', 'a browser page follows the browser preference again');
    const attrs = new Map([['data-i18n', '语言'], ['data-i18n-title', '中文']]);
    const marked = { textContent: '', getAttribute: (name: string) => attrs.get(name) ?? null, setAttribute: (name: string, value: string) => attrs.set(name, value) };
    const userMessage = { textContent: '语言' };
    translateStatic({ querySelectorAll: () => [marked] });
    assert.equal(marked.textContent, 'Language');
    assert.equal(attrs.get('title'), 'Chinese');
    assert.equal(userMessage.textContent, '语言');
  } finally {
    setLanguage('zh');
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete (globalThis as any).localStorage;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else delete (globalThis as any).location;
  }
});

test('language change: listeners run once per real change, in place; a page with uiLang rewrites only its own address', () => {
  const saved = ['location', 'localStorage', 'history'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const stored = new Map<string, string>();
  const location = { href: '', search: '' };
  const go = (href: string) => { location.href = href; location.search = new URL(href).search; };
  const states: unknown[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', { configurable: true, value: { state: { page: 1 }, replaceState: (state: unknown, _title: string, url: string) => { states.push(state); go(url); } } });
  const seen: string[] = [];
  const errors: unknown[] = [];
  const previousError = console.error;
  console.error = (e: unknown) => errors.push(e);
  const stops = [onLanguageChange(() => { throw new Error('a broken listener'); }), onLanguageChange((value) => seen.push(value))];
  try {
    go('http://127.0.0.1:4391/#c=1');
    assert.equal(setLanguage('en'), 'en');
    assert.equal(setLanguage('en'), 'en');
    assert.deepEqual(seen, ['en'], 'the same language again changes nothing; a throwing listener does not stop the next one');
    assert.equal(errors.length, 1);
    assert.equal(stored.get(LANGUAGE_KEY), 'en');

    go('http://127.0.0.1:4391/?uiLang=en&keep=1#c=1');
    assert.equal(setLanguage('zh'), 'zh');
    assert.equal(location.href, 'http://127.0.0.1:4391/?uiLang=zh&keep=1#c=1', 'only uiLang changes; the fragment stays');
    assert.deepEqual(states, [{ page: 1 }], 'history state kept');
    assert.equal(stored.get(LANGUAGE_KEY), 'en', 'the browser preference is untouched');
    assert.equal(forcedLanguage(), 'zh');
    assert.deepEqual(seen, ['en', 'zh']);
    // An invalid value written into the address: no change, no event, and the page is still desktop-owned, so the next
    // valid change (the desktop shell's event goes through setLanguage) applies and repairs the address.
    go('http://127.0.0.1:4391/?uiLang=fr&keep=1#c=1');
    assert.equal(language(), 'zh');
    assert.equal(languageInAddress(), true);
    assert.deepEqual(seen, ['en', 'zh']);
    assert.equal(setLanguage('en'), 'en');
    assert.equal(location.href, 'http://127.0.0.1:4391/?uiLang=en&keep=1#c=1');
    assert.equal(stored.get(LANGUAGE_KEY), 'en', 'still not the browser preference (it was en before)');
    assert.deepEqual(seen, ['en', 'zh', 'en']);
    go('http://127.0.0.1:4391/?uiLang=&keep=1#c=1');
    assert.equal(language(), 'en', 'an empty value is invalid too');
    assert.equal(setLanguage('zh'), 'zh');
    assert.deepEqual(seen, ['en', 'zh', 'en', 'zh']);
    (globalThis as any).history.replaceState = () => { throw new Error('refused'); };
    assert.equal(setLanguage('en'), 'zh', 'an address that cannot be rewritten keeps the page as it is');
    assert.deepEqual(seen, ['en', 'zh', 'en', 'zh']);
    stops[1]();
    go('http://127.0.0.1:4391/');
    setLanguage('zh');
    assert.deepEqual(seen, ['en', 'zh', 'en', 'zh'], 'unsubscribed');
  } finally {
    for (const stop of stops) stop();
    console.error = previousError;
    location.search = '';
    setLanguage('zh');
    for (const [name, value] of saved) { if (value) Object.defineProperty(globalThis, name, value); else delete (globalThis as any)[name]; }
  }
});

test('lt(): text built once follows a switch where h() placed it, and nothing else in the page', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const make = (tagName: string) => ({ tagName, attrs: {} as Record<string, string>, children: [] as any[],
    setAttribute(name: string, value: string) { this.attrs[name] = value; }, addEventListener() {},
    append(...children: any[]) { this.children.push(...children); } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: make, createTextNode: (value: string) => ({ nodeValue: value }) } });
  try {
    const { h, lt } = await import(new URL('../src/web/public/ui.js', import.meta.url).href);
    const name = '中文名字';
    const el = h('button', { title: lt('关闭搜索'), 'aria-label': lt('{label}：成员信息', { label: name }), class: 'x' },
      lt('清空条件'), '设置', lt(() => t('关键词')));
    assert.deepEqual([el.attrs.title, el.attrs['aria-label'], el.children[0].nodeValue, el.children[1], el.children[2].nodeValue],
      ['关闭搜索', '中文名字：成员信息', '清空条件', '设置', '关键词']);
    assert.equal(String(lt('清空条件')), '清空条件', 'outside h() it is its translation now');
    setLanguage('en');
    assert.deepEqual([el.attrs.title, el.attrs['aria-label'], el.children[0].nodeValue, el.children[1], el.children[2].nodeValue],
      ['Close search', '中文名字: member details', 'Clear filters', '设置', 'Keywords'], 'plain strings are never touched');
    setLanguage('zh');
    assert.equal(el.children[0].nodeValue, '清空条件');
  } finally {
    setLanguage('zh');
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as any).document;
  }
});


function assertCatalogsCompatible(catalogs: [string, Record<string, string>][]) {
  const seen = new Map<string, { file: string; value: string }>();
  for (const [file, entries] of catalogs) for (const [msgid, value] of Object.entries(entries)) {
    const previous = seen.get(msgid);
    if (previous) assert.equal(value, previous.value, 'Conflicting translation: ' + JSON.stringify(msgid) + ' in ' + previous.file + ' and ' + file);
    else seen.set(msgid, { file, value });
  }
}

test('English catalogs reject conflicting translations and allow identical shared wording', async () => {
  assert.doesNotThrow(() => assertCatalogsCompatible([['a', { '共享': 'Shared' }], ['b', { '共享': 'Shared' }]]));
  assert.throws(() => assertCatalogsCompatible([['a', { '共享': 'Shared' }], ['b', { '共享': 'Different' }]]), /Conflicting translation/);
  const directory = new URL('../shared/i18n/', import.meta.url);
  const catalogs: [string, Record<string, string>][] = [];
  for (const file of readdirSync(directory).filter((name) => /^en-.*\.js$/.test(name))) {
    catalogs.push([file, (await import(new URL(file, directory).href)).default]);
  }
  assertCatalogsCompatible(catalogs);
  const stalled = await import(new URL('../src/web/public/stalled.js', import.meta.url).href);
  setLanguage('en');
  try {
    assert.equal(t('标签'), 'Labels');
    assert.equal(t('标签页'), 'Tabs');
    assert.equal(t('置顶群聊'), 'Pin');
    assert.equal(t('置顶'), 'Pinned');
    assert.match(t(stalled.STALLED_CAVEAT), /observations available to the Hub/);
  } finally { setLanguage('zh'); }
  assert.equal(t('标签'), '标签');
  assert.equal(t('标签页'), '标签页');
  assert.equal(t('置顶群聊'), '置顶群聊');
  assert.equal(t(stalled.STALLED_CAVEAT), stalled.STALLED_CAVEAT);
});
