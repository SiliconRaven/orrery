export type Language = 'zh' | 'en';
export const LANGUAGE_KEY: string;
export function forcedLanguage(): Language | null;
export function language(): Language;
export function setLanguage(value: Language): Language;
export function t(msgid: string, params?: Record<string, unknown>): string;
export function translateStatic(root?: unknown): void;
