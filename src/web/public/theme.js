// The page's colour theme (设置 → 外观). 'light', 'dark' or 'orrery' (星仪, a dark palette) puts data-theme on <html>,
// which sets `color-scheme` (and for 'orrery' its own tokens) in style.css; 'system' (the default, and whatever else is
// stored) removes it, so the system decides between light and dark. Kept per browser in localStorage, never in the Hub.
// A classic script loaded in <head> before the stylesheets: the attribute is set before the first paint, so a reload
// never flashes the other theme. settings.js uses globalThis.orreryTheme.
(() => {
  const KEY = 'orrery.theme';
  const THEMES = ['light', 'dark', 'orrery'];
  const valid = (value) => (THEMES.includes(value) ? value : 'system');
  const stored = () => {
    try { return valid(localStorage.getItem(KEY)); } catch { return 'system'; }   // blocked storage: follow the system
  };
  const apply = (theme) => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  };
  /** Applies the choice at once and remembers it; returns what is now in effect. */
  const set = (value) => {
    const theme = valid(value);
    apply(theme);
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch { /* blocked or full: the choice lasts until the page is reloaded */ }
    return theme;
  };
  /** What this page shows now, which is what the control must show: storage may have refused the last choice. */
  const current = () => valid(document.documentElement.getAttribute('data-theme'));
  apply(stored());
  // Another tab changed it (or cleared storage): follow.
  addEventListener('storage', (event) => { if (event.key === KEY || event.key === null) apply(stored()); });
  globalThis.orreryTheme = { KEY, stored, current, set };
})();
