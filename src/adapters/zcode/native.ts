// Native ZCode: the member is a conversation the user sees in the ZCode desktop app. The Hub cannot reach into ZCode;
// the member itself runs orrery's wait command in the background (src/mcp/wait-core.ts, plugins/zcode-orrery/wait.mjs),
// which the Hub registers as this session's bridge stream. A delivery is printed by that command, which then exits;
// ZCode runs a turn on it (after the current one, if busy), and at its end the member runs the same command again.
// Being online and delivering are the shared wait route (../shared/wait-native.ts) with ZCode's settings.
// Conversations and tokens are read from copies of ZCode's databases (./store.ts); the bound conversation's body is
// read in place, read-only (./transcript.ts). No createSession: the user creates
// conversations in the app. No quota: ZCode reads it with the user's API key. docs/adapters/zcode.md.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ZCODE_WAIT, type NativeAdapter } from '../../core/types.ts';
import { createWaitDelivery } from '../shared/wait-native.ts';
import { createZcodeStore } from './store.ts';
import { zcodeTranscript } from './transcript.ts';

export const NOT_REARMED = 'ZCode 没有重新挂上等待：在 ZCode 里对这个对话说一句「重新挂上 orrery」（或用 orrery skill）。在那之前它离线，发给它的消息不会投递。';

export function createZcodeNativeAdapter(opts: {
  zcodeHome?: string; rearmGraceMs?: number; pollMs?: number;
  /** Is ZCode running for this user? Default: tasklist. Null: unknown (counts as running). */
  zcodeRunning?: () => Promise<boolean | null>;
} = {}): NativeAdapter {
  // ZCODE_HOME: orrery's own override of where it reads ZCode's data (tests, another account's copy).
  const zcodeHome = resolve(opts.zcodeHome ?? (process.env.ZCODE_HOME || join(homedir(), '.zcode')));
  const store = createZcodeStore(zcodeHome);
  const delivery = createWaitDelivery(ZCODE_WAIT, { notRearmed: NOT_REARMED, rearmGraceMs: opts.rearmGraceMs, pollMs: opts.pollMs, appRunning: opts.zcodeRunning });
  return {
    harness: ZCODE_WAIT.harness,
    wait: ZCODE_WAIT,
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: () => store.listProjects(),
    listSessions: (projectPath) => store.listSessions(projectPath),
    async attachSession(sessionId) {
      const info = await store.get(sessionId);
      if (!info) throw new Error(`zcode conversation ${sessionId} not found among the local-workspace ZCode conversations under ${zcodeHome}`);
      return info;
    },
    isOnline: delivery.isOnline,
    conversationTokens: (sessionId) => store.tokens(sessionId),
    transcript: (sessionId, request) => zcodeTranscript(zcodeHome, sessionId, request),
    deliver: delivery.deliver,
  };
}
