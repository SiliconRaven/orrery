import { setLanguage, translateStatic } from '../../shared/i18n/index.js';

export const isDesktopLanguage = (value) => value === 'zh' || value === 'en';
export const desktopLanguage = (value) => isDesktopLanguage(value) ? value : 'zh';

/** The desktop owns this query; URL parsing preserves the launch token fragment and other parameters. */
export function desktopPageUrl(page, value) {
  const url = new URL(page);
  url.searchParams.set('uiLang', desktopLanguage(value));
  return url.href;
}

/**
 * The language the collaboration page switched to, read from an in-page navigation of its view (its own
 * history.replaceState of `uiLang`, docs/desktop.md「界面语言」), or null when there is nothing to adopt: not the main
 * frame, not the Hub the shell is bound to (exact origin), no valid `uiLang`, or the language the shell already has. The
 * last case is what ends the round trip of a change the shell itself sent to the page.
 */
export function pageLanguage({ hubOrigin, url, isMainFrame, current }) {
  if (isMainFrame !== true || !hubOrigin) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== hubOrigin) return null;
  const value = u.searchParams.get('uiLang');
  return isDesktopLanguage(value) && value !== current ? value : null;
}

/**
 * What the shell runs in the collaboration page to switch it: a fixed script with one of the two language codes and
 * nothing else in it. The page only gets an event; it switches itself (src/web/public/app.js) and accepts only zh or en.
 */
export function pageLanguageScript(value) {
  if (!isDesktopLanguage(value)) throw new TypeError('language must be zh or en');
  return `window.dispatchEvent(new CustomEvent('orrery:desktop-language', { detail: '${value}' })); true`;
}

export function translateDesktopPage(value) {
  setLanguage(desktopLanguage(value));
  translateStatic(document);
}
