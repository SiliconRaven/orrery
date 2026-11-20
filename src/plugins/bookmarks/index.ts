// Member bookmarks on messages: the built-in copy runs from the same payload that `npm run plugin:pack-official` signs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OfficialPlugin } from '../../core/plugin.ts';
import { OFFICIAL_PLUGIN_HOST } from '../../official-plugin-host.ts';
import createPlugin, { bookmarksOf, type Bookmark } from './package/hub/index.mts';

export { bookmarksOf, type Bookmark };

const metadata = JSON.parse(readFileSync(new URL('./release.json', import.meta.url), 'utf8'));

export const bookmarks: OfficialPlugin = {
  ...createPlugin(OFFICIAL_PLUGIN_HOST),
  id: metadata.id,
  version: metadata.version,
  packageSource: { directory: fileURLToPath(new URL('./package/', import.meta.url)), metadata },
};
