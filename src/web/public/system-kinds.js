// The page's door to the Hub's system-kind table (src/core/system-kinds.js): the Hub serves that one file at
// /core/system-kinds.js (src/web/server.ts), so the page and the Hub read the same table.
export * from '../../core/system-kinds.js';
import { t } from './i18n.js';

// The core owns category identifiers; these labels are read in the viewer's language.
export const SYSTEM_CATEGORY_LABELS = Object.freeze({
  get warning() { return t('警告'); },
  get task() { return t('任务进度'); },
  get coordinator() { return t('协调'); },
  get member() { return t('成员与群'); },
  get other() { return t('其他'); },
});
export const WARNING_LEVEL_LABELS = Object.freeze({
  get problem() { return t('问题'); },
  get attention() { return t('提醒'); },
});
