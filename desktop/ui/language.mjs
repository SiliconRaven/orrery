import { setLanguage, translateStatic } from '../../shared/i18n/index.js';

export const isDesktopLanguage = (value) => value === 'zh' || value === 'en';
export const desktopLanguage = (value) => isDesktopLanguage(value) ? value : 'zh';

/** The desktop owns this query; URL parsing preserves the launch token fragment and other parameters. */
export function desktopPageUrl(page, value) {
  const url = new URL(page);
  url.searchParams.set('uiLang', desktopLanguage(value));
  return url.href;
}

export function translateDesktopPage(value) {
  setLanguage(desktopLanguage(value));
  translateStatic(document);
}
