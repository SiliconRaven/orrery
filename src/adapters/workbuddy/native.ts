// Native WorkBuddy: the member is a conversation the user sees in the WorkBuddy desktop app. The Hub cannot reach into
// WorkBuddy; the member itself runs orrery's wait command in the background (src/mcp/wait-core.ts,
// plugins/zcode-orrery/wait.mjs), which the Hub registers as this session's bridge stream. A delivery is printed by that
// command, which then exits; WorkBuddy runs a turn on it (at the end of the current one, if busy), and at its end the
// member runs the same command again. Being online and delivering are the shared wait route
// (../shared/wait-native.ts) with WorkBuddy's settings. Conversations are read from a copy of WorkBuddy's database
// (./store.ts). No createSession: the user creates conversations in the app. No quota or token totals: neither is
// readable without the app's cloud account. docs/adapters/workbuddy.md.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WORKBUDDY_WAIT, type NativeAdapter } from '../../core/types.ts';
import { createWaitDelivery } from '../shared/wait-native.ts';
import { createWorkbuddyStore } from './store.ts';

export const NOT_REARMED = 'WorkBuddy 没有重新挂上等待：在这个对话里说一句「挂上 orrery」（或用 orrery skill），它运行等待命令后才会在线。在那之前它离线，发给它的消息不会投递。';

export function createWorkbuddyNativeAdapter(opts: {
  workbuddyHome?: string; rearmGraceMs?: number; pollMs?: number;
  /** Is WorkBuddy running for this user? Default: tasklist. Null: unknown (counts as running). */
  workbuddyRunning?: () => Promise<boolean | null>;
} = {}): NativeAdapter {
  // WORKBUDDY_CONFIG_DIR is WorkBuddy's own variable for where its data lives (read here, never written).
  const workbuddyHome = resolve(opts.workbuddyHome ?? (process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy')));
  const store = createWorkbuddyStore(workbuddyHome);
  const delivery = createWaitDelivery(WORKBUDDY_WAIT, {
    notRearmed: NOT_REARMED, rearmGraceMs: opts.rearmGraceMs, pollMs: opts.pollMs, appRunning: opts.workbuddyRunning,
  });
  return {
    harness: WORKBUDDY_WAIT.harness,
    wait: WORKBUDDY_WAIT,
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: () => store.listProjects(),
    listSessions: (projectPath) => store.listSessions(projectPath),
    async attachSession(sessionId) {
      const info = await store.get(sessionId);
      if (!info) throw new Error(`workbuddy conversation ${sessionId} not found among the local WorkBuddy conversations under ${workbuddyHome}`);
      return info;
    },
    isOnline: delivery.isOnline,
    deliver: delivery.deliver,
  };
}
