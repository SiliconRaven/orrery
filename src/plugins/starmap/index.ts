// The built-in star map runs from the same payload that `npm run plugin:pack-official` signs (docs/starmap.md「制品」):
// package/ holds its Hub entry and web module, release.json its manifest without `files`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OfficialPlugin } from '../../core/plugin.ts';
import { OFFICIAL_PLUGIN_HOST } from '../../official-plugin-host.ts';
import createPlugin from './package/hub/index.mts';

const metadata = JSON.parse(readFileSync(new URL('./release.json', import.meta.url), 'utf8'));

export const starmap: OfficialPlugin = {
  // What the entry reads of the host a signed package gets (official-plugin-updates.ts, host API 1).
  ...createPlugin(OFFICIAL_PLUGIN_HOST),
  id: metadata.id,
  version: metadata.version,
  defaultEnabled: false,
  packageSource: { directory: fileURLToPath(new URL('./package/', import.meta.url)), metadata },
};
