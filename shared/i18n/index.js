// UI strings only. Callers keep user content, paths, model IDs and external errors outside the catalog.
import english from './catalog.js';

export const LANGUAGE_KEY = 'orrery.language';
const valid = (value) => value === 'zh' || value === 'en';
const stored = () => {
  try { const value = globalThis.localStorage?.getItem(LANGUAGE_KEY); return valid(value) ? value : 'zh'; }
  catch { return 'zh'; }
};
let selected = stored();

/** A desktop-owned page can force the locale without changing browser preferences. */
export function forcedLanguage() {
  const value = new URLSearchParams(globalThis.location?.search ?? '').get('uiLang');
  return valid(value) ? value : null;
}

export const language = () => forcedLanguage() ?? selected;

/** Persist a browser choice. A forced desktop locale stays controlled by the desktop settings. */
export function setLanguage(value) {
  if (!valid(value)) throw new TypeError('language must be zh or en');
  if (forcedLanguage()) return language();
  selected = value;
  try { globalThis.localStorage?.setItem(LANGUAGE_KEY, value); } catch { /* retain this page's choice */ }
  return language();
}

/** Named interpolation does not translate or interpret parameter values. The result is plain text. */
export function t(msgid, params = {}) {
  const source = String(msgid);
  const text = language() === 'en' && Object.hasOwn(english, source) ? english[source] : source;
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
