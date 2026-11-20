// Coordinator contributes the Roles & Coordination tab inside the unified Tasks workbench (no duplicate Dock icon).
import { useWords } from './words.js';

export function register(host = {}) {
  useWords(host?.i18n ?? null);
  return {};
}
