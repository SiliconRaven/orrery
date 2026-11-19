import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { onLanguageChange, setLanguage, t } from '../shared/i18n/index.js';

const { initSettings } = await import(new URL('../src/web/public/settings.js', import.meta.url).href);
const { reloadWouldLose } = await import(new URL('../src/web/public/ui.js', import.meta.url).href);

const source = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');

test('app English keeps interpolation data raw and includes explicit static language controls', () => {
  setLanguage('en');
  try {
    assert.equal(t('选择项目…'), 'Choose project…');
    assert.equal(t('重发给 {value}', { value: '中文名字' }), 'Resend to 中文名字');
    const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
    assert.match(html, /id="ui-language"/);
    assert.match(html, /data-i18n="设置"/);
  } finally { setLanguage('zh'); }
});

/** A settings dialog with the language select and its note, enough for initSettings. */
function languageDialog() {
  const handlers: Record<string, () => void> = {};
  const choice = { value: '', disabled: false, addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; } };
  const note = { textContent: '' };
  const tab = { id: 'appearance', getAttribute: () => 'panel', setAttribute() {}, addEventListener() {}, scrollIntoView() {} };
  const dialog = {
    querySelectorAll: (selector: string) => selector === '[role="tab"]' ? [tab] : [],
    querySelector: (selector: string) => selector === '#ui-language' ? choice : selector === '#language-note' ? note : { hidden: false, scrollTop: 0, setAttribute() {} },
  };
  return { choice, note, dialog, change: () => handlers.change() };
}

/** A page at `search` (#c=cluster-1 as its fragment) with storage, history.replaceState and a counted reload. */
function withPage(search: string, run: (page: { stored: Map<string, string>, href: () => string, reloads: () => number }) => void) {
  const saved = ['location', 'localStorage', 'history'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const stored = new Map<string, string>();
  let reloads = 0;
  const location = { href: '', search: '', reload: () => reloads++ };
  const go = (href: string) => { location.href = href; location.search = new URL(href).search; };
  go(`http://127.0.0.1:4391/${search}#c=cluster-1`);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', { configurable: true, value: { state: null, replaceState: (_state: unknown, _title: string, url: string) => go(url) } });
  try { run({ stored, href: () => location.href, reloads: () => reloads }); }
  finally {
    location.search = '';
    setLanguage('zh');
    for (const [name, value] of saved) { if (value) Object.defineProperty(globalThis, name, value); else delete (globalThis as any)[name]; }
  }
}

test('browser page: the language select switches in place, saves the choice and never reloads', () => {
  withPage('', ({ stored, reloads }) => {
    const { choice, note, dialog, change } = languageDialog();
    initSettings(dialog, { current: () => 'system', set() {} });
    assert.equal(choice.value, 'zh');
    assert.equal(choice.disabled, false);
    assert.match(note.textContent, /立即生效/);
    const seen: string[] = [];
    const stop = onLanguageChange((value: string) => seen.push(value));
    try {
      choice.value = 'en';
      change();
      assert.deepEqual(seen, ['en'], 'one change event');
      assert.equal(stored.get('orrery.language'), 'en');
      assert.equal(t('设置'), 'Settings');
      assert.equal(reloads(), 0, 'no reload');
      assert.match(note.textContent, /changes right away/, 'the note follows the language');
      choice.value = 'en';
      change();
      assert.deepEqual(seen, ['en'], 'the same language again is no change');
    } finally { stop(); }
  });
});

test('desktop collaboration page: the select is usable and rewrites only uiLang in its own address', () => {
  withPage('?uiLang=zh&x=1', ({ stored, href, reloads }) => {
    const { choice, note, dialog, change } = languageDialog();
    const frame = initSettings(dialog, { current: () => 'system', set() {} });
    assert.equal(choice.disabled, false, 'no longer locked by the desktop');
    assert.match(note.textContent, /桌面设置/);
    choice.value = 'en';
    change();
    const url = new URL(href());
    assert.equal(url.searchParams.get('uiLang'), 'en');
    assert.equal(url.searchParams.get('x'), '1');
    assert.equal(url.hash, '#c=cluster-1', 'the selection in the fragment stays');
    assert.equal(stored.get('orrery.language'), undefined, 'the browser preference is not written');
    assert.equal(t('设置'), 'Settings');
    assert.equal(reloads(), 0);
    assert.match(note.textContent, /desktop settings/);
    // The desktop shell switched it back (its event goes through setLanguage): the select and the note follow.
    setLanguage('zh');
    assert.equal(choice.value, 'zh');
    assert.match(note.textContent, /桌面设置/);
    frame.opened();
    assert.equal(new URL(href()).searchParams.get('uiLang'), 'zh');
  });
});

test('app.js: a language switch redraws in place, and takes the desktop shell\'s event only on a desktop page', () => {
  const handler = /^onLanguageChange\(\(\) => \{([\s\S]*?)^\}\);/m.exec(source)![1];
  for (const step of ['translateStatic(document)', 'setConn(connOk)', 'fitPanes()', "$('chat-filter-panel').replaceChildren()", 'render()']) {
    assert.ok(handler.includes(step), step);
  }
  assert.doesNotMatch(handler, /reload\(/);
  // Not a member change: S.identity would make the member page refill its editor (dropping unsaved edits) and draw its
  // lines from scratch, scrolled to the bottom.
  assert.doesNotMatch(handler, /S\.identity/);
  const panel = /^function renderMemberPanel\(\) \{([\s\S]*?)^\}/m.exec(source)![1];
  const refill = /if \(panelFor !== m\.id \|\| panelIdentity !== S\.identity\) \{([\s\S]*?)\} else if \(panelLanguage !== language\(\) && panelCount\) \{([\s\S]*?)\n  \}/.exec(panel)!;
  assert.match(refill[1], /panelEditor\.fill\(m\);\n    panelCount = 0;/, 'another member, or a renamed one: refilled');
  assert.doesNotMatch(refill[2], /fill|panelCount = 0/, 'a language switch keeps the editor and the count of lines shown');
  assert.match(refill[2], /const top = box\.scrollTop;[\s\S]*box\.scrollTop = top;/, 'and the scroll position');
  // The rows and chips drawn from data compare the language in their signatures instead.
  assert.ok(source.includes('const sig = `${S.identity}|${language()}|${S.skillsVersion}|'));
  assert.ok(source.includes('const key = `${target}|${uploadsVersion}|${language()}`;'));
  assert.doesNotMatch(source, /confirmLanguageReload|beforeLanguageChange/);
  const desktop = /addEventListener\('orrery:desktop-language', \(event\) => \{([\s\S]*?)\n\}\);/.exec(source)![1];
  assert.match(desktop, /languageInAddress\(\) && \(event\.detail === 'zh' \|\| event\.detail === 'en'\)/);
  // stableList compares the language as well as the signature, so every list it guards is drawn again.
  assert.ok(source.includes('const sig = `${language()}\\n${signature}`;'));
});

test('unsaved() still guards a reload after a Hub restart: drafts, attachments and open dialogs', () => {
  const unsaved = /^function unsaved\([\s\S]*?^\}/m.exec(source)![0];
  const dialogs: object[] = [];
  const chat = { input: { value: '' } };
  const uploads = new Map<string, string[]>();
  const read = runInNewContext(unsaved + '\nunsaved', {
    chat, direct: { input: { value: '' } }, drafts: new Map(), uploads, sending: new Set(), editingId: null,
    panelEditor: { dirty: () => false }, openForm: null, taskDrafts: new Map(), S: {},
    document: { querySelectorAll: () => dialogs }, $: () => ({ value: '' }), LIMIT_FORMS: [], NOTIFY_FORMS: [],
  });
  assert.equal(reloadWouldLose(read()), false);
  chat.input.value = 'unsent';
  assert.equal(reloadWouldLose(read()), true);
  chat.input.value = '';
  uploads.set('chat', ['attachment']);
  assert.equal(reloadWouldLose(read()), true);
  uploads.clear();
  dialogs.push({ id: 'settings-dialog' });
  assert.equal(reloadWouldLose(read()), true);
});
