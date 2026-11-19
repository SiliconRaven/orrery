import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { LANGUAGE_KEY, language, forcedLanguage, setLanguage, t, translateStatic } from '../shared/i18n/index.js';

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
    assert.equal(language(), 'en');
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
