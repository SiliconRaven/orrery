// Tasks' own words: host.i18n (its English table in i18n/en.json), handed over by register(host).
let i18n = null;

export function useWords(words) { i18n = words; }

const fill = (text, params = {}) => text.replace(/{([A-Za-z_]\w*)}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
export const t = (msgid, params) => (i18n ? i18n.t(msgid, params) : fill(String(msgid), params));
