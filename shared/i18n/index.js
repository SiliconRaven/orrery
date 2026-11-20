// UI strings only. Callers keep user content, paths, model IDs and external errors outside the catalog.
import english from './catalog.js';

export const LANGUAGE_KEY = 'orrery.language';
const valid = (value) => value === 'zh' || value === 'en';
const stored = () => {
  try { const value = globalThis.localStorage?.getItem(LANGUAGE_KEY); return valid(value) ? value : 'zh'; }
  catch { return 'zh'; }
};
let selected = stored();
const listeners = new Set();

const addressValue = () => new URLSearchParams(globalThis.location?.search ?? '').get('uiLang');
let lastAddressLanguage = null;   // the last valid uiLang this page's address had

/**
 * Is this a desktop-owned page? Such a page carries its locale in its own address (`uiLang`), apart from the browser
 * preference. Whether it is one does not depend on the value being valid: an invalid value written into the address
 * leaves the page desktop-owned, in the language it had, and the next valid change (from the page or the desktop)
 * applies as usual.
 */
export const languageInAddress = () => addressValue() !== null;

/** The address's `uiLang` when it is zh or en, else null. */
export function forcedLanguage() {
  const value = addressValue();
  if (!valid(value)) return null;
  lastAddressLanguage = value;
  return value;
}

export const language = () => forcedLanguage() ?? (languageInAddress() ? lastAddressLanguage : null) ?? selected;

/**
 * Calls `fn(language)` after every change of the page's language (setLanguage here, or another tab's browser choice).
 * Returns the unsubscribe function. A listener that throws does not stop the others.
 */
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(before) {
  const now = language();
  if (now === before) return now;
  for (const fn of [...listeners]) {
    try { fn(now); } catch (error) { globalThis.console?.error?.(error); }
  }
  return now;
}

/**
 * Switches the page's language in place; nothing reloads. A browser page saves the choice in this browser. A page whose
 * address carries `uiLang` (the desktop's own pages and its collaboration page) keeps the browser preference as it is
 * and rewrites `uiLang` in its own address with history.replaceState, which is no navigation: the desktop shell reads
 * the new value from there (docs/desktop.md「界面语言」).
 */
export function setLanguage(value) {
  if (!valid(value)) throw new TypeError('language must be zh or en');
  const before = language();
  if (languageInAddress()) {
    try {
      const url = new URL(globalThis.location.href);
      url.searchParams.set('uiLang', value);
      globalThis.history.replaceState(globalThis.history.state, '', url.href);
    } catch { /* no address to rewrite: the page keeps its locale */ }
  } else {
    selected = value;
    try { globalThis.localStorage?.setItem(LANGUAGE_KEY, value); } catch { /* retain this page's choice */ }
  }
  return changed(before);
}

// Another tab of this browser saved a choice: a page that follows the browser preference follows it at once.
globalThis.addEventListener?.('storage', (event) => {
  if (event.key !== LANGUAGE_KEY && event.key !== null) return;
  const before = language();
  selected = stored();
  changed(before);
});

/** Named interpolation does not translate or interpret parameter values. The result is plain text. */
export function t(msgid, params = {}) {
  const source = String(msgid);
  const text = language() === 'en' && Object.hasOwn(english, source) ? english[source] : source;
  return interpolate(text, params);
}

export function interpolate(text, params = {}) {
  return text.replace(/{([A-Za-z_]\w*)}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

const attributes = ['title', 'placeholder', 'aria-label', 'alt'];
/** Translate only explicitly marked static leaves and attributes; never scan arbitrary text or observe mutations. */
export function translateStatic(root = globalThis.document) {
  if (!root) return;
  const selector = ['[data-i18n]', ...attributes.map((name) => '[data-i18n-' + name + ']')].join(',');
  const nodes = [...(root.matches?.(selector) ? [root] : []), ...(root.querySelectorAll?.(selector) ?? [])];
  for (const element of nodes) {
    const msgid = element.getAttribute('data-i18n');
    if (msgid !== null) element.textContent = t(msgid);
    for (const name of attributes) {
      const key = element.getAttribute('data-i18n-' + name);
      if (key !== null) element.setAttribute(name, t(key));
    }
  }
  const html = root.documentElement ?? (root.tagName?.toLowerCase() === 'html' ? root : null);
  if (html) html.setAttribute('lang', language() === 'en' ? 'en' : 'zh-CN');
}
