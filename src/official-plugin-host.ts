// Host capabilities passed to signed official Hub packages and built-in package wrappers (hostApi: 1).
import { resolve } from 'node:path';
import { z } from 'zod';
import { REPO_ROOT } from './config.ts';
import { CollaborationError, MIN_ID_PREFIX, actorKey, canonical, personName, required, strings } from './core/collaboration.ts';
import { MAX_FILES_PER_MESSAGE } from './core/files.ts';
import { OPEN_STATUS_LABEL } from './core/hub.ts';
import { TRANSCRIPT_MAX_ITEMS } from './core/native-transcript.ts';
import {
  UNSAFE_PATH, git, gitRead, gitRepositoryPathSync, gitSync, projectIdentities, representativeWorktree, sameRepositoryPath, worktreeList,
} from './core/projects.ts';
import { toEvent } from './core/store.ts';

export const OFFICIAL_PLUGIN_HOST = Object.freeze({
  hostApi: 1 as const,
  z,
  transcriptMaxItems: TRANSCRIPT_MAX_ITEMS,
  collaboration: Object.freeze({ CollaborationError, actorKey, canonical, personName, required, strings, MIN_ID_PREFIX }),
  files: Object.freeze({ MAX_FILES_PER_MESSAGE }),
  projects: Object.freeze({
    git, gitRead, gitSync, gitRepositoryPathSync, projectIdentities, representativeWorktree, sameRepositoryPath, worktreeList, UNSAFE_PATH,
  }),
  store: Object.freeze({ toEvent }),
  hub: Object.freeze({
    OPEN_STATUS_LABEL,
    shipScript: resolve(REPO_ROOT, 'scripts/ship.ts').replaceAll('\\', '/'),
  }),
});

export type OfficialPluginHost = typeof OFFICIAL_PLUGIN_HOST;
