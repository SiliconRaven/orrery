import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setLanguage, t } from '../shared/i18n/index.js';

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

test('language setting confirms before writing preferences or reloading, and cancel restores the selection', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) } });
  let reloads = 0;
  let allowed = false;
  let confirmations = 0;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?uiLang=en', reload: () => reloads++ } });
  const handlers: Record<string, () => void> = {};
  const choice = { value: '', disabled: false, addEventListener: (name: string, fn: () => void) => { handlers[name] = fn; } };
  const note = { textContent: '' };
  const tab = { id: 'appearance', getAttribute: () => 'panel', setAttribute() {}, addEventListener() {}, scrollIntoView() {} };
  const dialog = {
    querySelectorAll: (selector: string) => selector === '[role="tab"]' ? [tab] : [],
    querySelector: (selector: string) => selector === '#ui-language' ? choice : selector === '#language-note' ? note : { hidden: false, scrollTop: 0, setAttribute() {} },
  };
  try {
    const frame = initSettings(dialog, { current: () => 'system', set() {} }, { beforeLanguageChange: async () => { confirmations++; return allowed; } });
    assert.equal(choice.value, 'en');
    assert.equal(choice.disabled, true);
    assert.match(note.textContent, /desktop settings/);
    choice.value = 'zh';
    await handlers.change();
    assert.equal(choice.value, 'en');
    assert.equal(confirmations, 0, 'a desktop-controlled page cannot initiate the change');
    (globalThis as any).location.search = '';
    frame.opened();
    assert.equal(choice.value, 'zh');
    assert.equal(choice.disabled, false);
    choice.value = 'en';
    await handlers.change();
    assert.equal(reloads, 0);
    assert.equal(choice.value, 'zh');
    assert.equal(choice.disabled, false);
    assert.equal(stored.get('orrery.language'), undefined, 'cancel never writes the locale');
    assert.equal(t('设置'), '设置');
    allowed = true;
    choice.value = 'en';
    await handlers.change();
    assert.equal(confirmations, 2);
    assert.equal(reloads, 1);
    assert.equal(stored.get('orrery.language'), 'en');
    assert.equal(t('设置'), 'Settings');
  } finally {
    (globalThis as any).location.search = '';
    setLanguage('zh');
    if (previous) Object.defineProperty(globalThis, 'location', previous); else delete (globalThis as any).location;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete (globalThis as any).localStorage;
  }
});


test('language reload ignores an empty settings dialog and guards message and settings edits', async () => {
  const unsaved = /^function unsaved\([\s\S]*?^\}/m.exec(source)![0];
  const confirm = /^async function confirmLanguageReload\(\) \{[\s\S]*?^\}/m.exec(source)![0];
  const settings = { id: 'settings-dialog', fields: [] as object[], querySelectorAll() { return this.fields; } };
  const dialogs = [settings];
  const chat = { input: { value: '' } };
  const uploads = new Map<string, string[]>();
  let approved = false;
  let prompts = 0;
  const guard = runInNewContext(unsaved + '\n' + confirm + '\nconfirmLanguageReload', {
    reloadWouldLose, t: (text: string) => text,
    chat, direct: { input: { value: '' } }, drafts: new Map(), uploads, sending: new Set(), editingId: null,
    panelEditor: { dirty: () => false }, openForm: null, taskDrafts: new Map(), S: {},
    document: { querySelectorAll: () => dialogs }, $: () => settings, LIMIT_FORMS: [], NOTIFY_FORMS: [],
    installPanel: null,
    confirmDialog: async () => { prompts++; return approved; },
  });
  assert.equal(await guard(), true);
  assert.equal(prompts, 0, 'a fresh appearance panel can change languages directly');
  chat.input.value = 'unsent';
  assert.equal(await guard(), false);
  assert.equal(prompts, 1);
  assert.equal(chat.input.value, 'unsent');
  chat.input.value = '';
  settings.fields = [{ type: 'checkbox', checked: true, defaultChecked: false }];
  assert.equal(await guard(), false);
  assert.equal(prompts, 2, 'a staged plugin write edit is guarded even on another settings tab');
  settings.fields = [];
  uploads.set('chat', ['attachment']);
  approved = true;
  assert.equal(await guard(), true);
  assert.equal(prompts, 3, 'an attachment alone is guarded');
});
