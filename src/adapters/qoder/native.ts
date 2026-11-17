// Native Qoder: the member is a conversation the user sees in the Qoder desktop app. Same background-wait route as
// ZCode (../shared/wait-native.ts with Qoder's settings, src/mcp/wait-core.ts); the identity comes from the plugin's MCP
// calls (src/mcp/qoder.ts). Conversations are read from a copy of Qoder's database (./store.ts). No createSession: the
// user creates conversations in the app. No quota, no token counts yet. docs/adapters/qoder.md.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { QODER_WAIT, type NativeAdapter } from '../../core/types.ts';
import { createWaitDelivery } from '../shared/wait-native.ts';
import { createQoderStore, defaultQoderData } from './store.ts';

export const NOT_REARMED = 'Qoder 没有重新挂上等待：在 Qoder 里对这个对话说一句「重新挂上 orrery」（或用 orrery skill）。在那之前它离线，发给它的消息不会投递。';

export function createQoderNativeAdapter(opts: {
  qoderData?: string; rearmGraceMs?: number; pollMs?: number;
  /** Is Qoder running for this user? Default: tasklist. Null: unknown (counts as running). */
  qoderRunning?: () => Promise<boolean | null>;
} = {}): NativeAdapter {
  // ORRERY_QODER_DATA: orrery's own override of where it reads Qoder's data (tests, another account's copy).
  const qoderData = resolve(opts.qoderData ?? (process.env.ORRERY_QODER_DATA || defaultQoderData(process.env.APPDATA, homedir())));
  const store = createQoderStore(qoderData);
  const delivery = createWaitDelivery(QODER_WAIT, { notRearmed: NOT_REARMED, rearmGraceMs: opts.rearmGraceMs, pollMs: opts.pollMs, appRunning: opts.qoderRunning });
  return {
    harness: QODER_WAIT.harness,
    wait: QODER_WAIT,
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: () => store.listProjects(),
    listSessions: (projectPath) => store.listSessions(projectPath),
    async attachSession(sessionId) {
      const info = await store.get(sessionId);
      if (!info) throw new Error(`qoder conversation ${sessionId} not found among the Qoder conversations under ${qoderData}`);
      return info;
    },
    isOnline: delivery.isOnline,
    deliver: delivery.deliver,
  };
}
