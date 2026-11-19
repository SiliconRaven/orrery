export function isDesktopLanguage(value: unknown): value is 'zh' | 'en';
export function desktopLanguage(value: unknown): 'zh' | 'en';
export function desktopPageUrl(page: string, value: unknown): string;
export function pageLanguage(page: { hubOrigin: string | null, url: string, isMainFrame: boolean, current: 'zh' | 'en' }): 'zh' | 'en' | null;
export function pageLanguageScript(value: 'zh' | 'en'): string;
export function translateDesktopPage(value: unknown): void;
