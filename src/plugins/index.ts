// The official plugins, in dependency order. Each new plugin adds one line here (docs/plugins.md).
import type { OfficialPlugin } from '../core/plugin.ts';
import { bookmarks } from './bookmarks/index.ts';
import { coordinator } from './coordinator/index.ts';
import { starmap } from './starmap/index.ts';
import { tasks } from './tasks/index.ts';

export const officialPlugins: OfficialPlugin[] = [tasks, bookmarks, coordinator, starmap];
