// Preset avatars shipped with the web page (src/web/public/avatars). They are referenced, never copied into the
// database: a member's avatar is "preset:<name>", and the page renders <img src="/avatars/<name>.png">.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A preset's name (its file name without .png): lowercase letters, digits and single hyphens between them. */
export const PRESET_SOURCE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where the web page's preset avatars live, next to the other public files (src/web/server.ts serves them). */
export const AVATARS_DIR = join(import.meta.dirname, '..', 'web', 'public', 'avatars');

/**
 * The preset names the Hub accepts, read once at start-up: <name>.png in `dir`, sorted. A missing or unreadable
 * directory means no presets, and the page falls back to generated initials; malformed names are ignored.
 */
export function loadAvatarPresets(dir: string = AVATARS_DIR): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .filter((file) => file.endsWith('.png') && PRESET_SOURCE.test(file.slice(0, -4)))
    .map((file) => file.slice(0, -4))
    .sort();
}
