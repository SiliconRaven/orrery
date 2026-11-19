import { language, forcedLanguage, setLanguage, t } from './i18n.js';
// The settings dialog's frame: its section tabs and the theme choice (外观). The settings themselves are wired in
// app.js and plugins.js by element id; nothing here reads or writes the Hub.

const SECTION_KEY = 'orrery.settingsSection';

/** The tab after `current` for a key press (wrapping), or null for any other key. */
export function nextTab(tabs, current, key) {
  const i = tabs.indexOf(current);
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[key];
  if (step) return tabs[(i + step + tabs.length) % tabs.length];
  if (key === 'Home') return tabs[0];
  if (key === 'End') return tabs.at(-1);
  return null;
}

/**
 * Tabs: a click or Enter/Space shows that section; the arrow keys, Home and End move between tabs and show the one they
 * land on (focus stays on the tab, Tab then goes into the section). The section last shown is remembered per browser.
 * `theme` is theme.js's globalThis.orreryTheme.
 */
export function initSettings(dialog, theme = globalThis.orreryTheme, { beforeLanguageChange = () => true } = {}) {
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const show = (tab, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      dialog.querySelector(`#${t.getAttribute('aria-controls')}`).hidden = !on;
    }
    dialog.querySelector('.settings-panels').scrollTop = 0;
    tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });   // the row of tabs scrolls sideways on a narrow screen
    if (focus) tab.focus();
    try { localStorage.setItem(SECTION_KEY, tab.id); } catch { /* forget the choice */ }
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab));
    tab.addEventListener('keydown', (event) => {
      const next = nextTab(tabs, tab, event.key);
      if (!next) return;
      event.preventDefault();
      show(next, true);
    });
  }
  // The rail turns into a row of tabs on a narrow screen (settings.css); say so to assistive technology.
  const narrow = globalThis.matchMedia?.('(max-width: 640px)');
  const orient = () => dialog.querySelector('[role="tablist"]')?.setAttribute('aria-orientation', narrow?.matches ? 'horizontal' : 'vertical');
  orient();
  narrow?.addEventListener?.('change', orient);
  let remembered = null;
  try { remembered = localStorage.getItem(SECTION_KEY); } catch { /* the first section */ }
  show(tabs.find((t) => t.id === remembered) ?? tabs[0]);

  const radios = [...dialog.querySelectorAll('input[name="theme"]')];
  // The applied theme, not the stored one: a store that refused the write must not make the control lie.
  const mark = () => { const now = theme?.current() ?? 'system'; for (const r of radios) r.checked = r.value === now; };
  for (const radio of radios) radio.addEventListener('change', () => { if (radio.checked) theme?.set(radio.value); });
  mark();
  globalThis.addEventListener?.('storage', mark);   // another tab changed it (theme.js applies it, this shows it)
  const choice = dialog.querySelector('#ui-language');
  const languageNote = dialog.querySelector('#language-note');
  const markLanguage = () => {
    if (!choice) return;
    choice.value = language();
    choice.disabled = Boolean(forcedLanguage());
    if (languageNote) languageNote.textContent = t(forcedLanguage()
      ? '语言由桌面版控制，请在桌面设置中修改。'
      : '语言保存在这个浏览器里，切换后会重新加载页面。');
  };
  let changingLanguage = false;
  choice?.addEventListener('change', async () => {
    const next = choice.value;
    if (changingLanguage || forcedLanguage() || next === language()) { markLanguage(); return; }
    changingLanguage = true;
    choice.disabled = true;
    try {
      if (!await beforeLanguageChange()) return;
      setLanguage(next);
      globalThis.location?.reload();
    } finally {
      changingLanguage = false;
      markLanguage();
    }
  });
  markLanguage();
  return { opened: () => { mark(); markLanguage(); } };
}
