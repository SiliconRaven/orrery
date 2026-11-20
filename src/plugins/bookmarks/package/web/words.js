// Bookmarks' own words: host.i18n (its English table in i18n/en.json, live switching from the page), handed over
// by register(host) before any interaction runs. Without host.i18n (unit tests) the source text is formatted directly.
let i18n = null;

export function useWords(words) { i18n = words; }

const fill = (text, params = {}) => text.replace(/{([A-Za-z_]\w*)}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
export const t = (msgid, params) => (i18n ? i18n.t(msgid, params) : fill(String(msgid), params));
/** Text that follows a language switch where h() placed it. */
export const lt = (msgid, params) => (i18n ? i18n.lt(msgid, params) : t(msgid, params));
export const language = () => (i18n?.language ? i18n.language() : 'zh');
