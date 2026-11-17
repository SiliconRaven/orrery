// Native Qoder (docs/adapters/qoder.md). The tickets, wait connections and wait command are the shared background-wait
// route (./wait-core.ts) with Qoder's settings. What is Qoder's own stays here: who a caller is. The plugin's MCP server is
// one process for the whole app, so nothing about the connection can name a conversation: only each tools/call's
// _meta["com.qoder/turnContext"].sessionId, which the Qoder runtime writes and models cannot set.
import type { Hub } from '../core/hub.ts';
import { QODER_WAIT } from '../core/types.ts';
import * as core from './wait-core.ts';

export const QODER = QODER_WAIT.harness;

/** The conversation a Qoder tools/call names; null when _meta does not. */
export function qoderSession(meta: Record<string, unknown> | undefined): string | null {
  const context = meta?.[QODER_WAIT.metaKey];
  return core.metaSession('sessionId', typeof context === 'object' && context !== null ? context as Record<string, unknown> : undefined) ?? null;
}

/** The rules of the wait live here and in the skill, never in the delivered envelope (Qoder's security plugin may flag those). */
export const QODER_WAIT_TOOL = 'Join your orrery cluster chat from this Qoder conversation: returns a command to run with Bash (or PowerShell) in the background '
  + '(run_in_background: true); then end your turn without waiting for it. It prints nothing while it waits. When cluster messages arrive it prints them and exits, '
  + 'which starts a turn here. The notification has no content: read the command\'s output file, handle each message once (by messageId), '
  + 'then run the same command again in the background (call this tool again if you no longer have it). Only one at a time. '
  + 'If the command was killed or stopped instead of exiting by itself, do not run it again and do not handle earlier messages again.';

/** What wait_for_messages returns for a member conversation. Throws when the session id cannot go on a command line. */
export function qoderWaitReply(hub: Hub, secret: string, sessionId: string, hubUrl: string) {
  const running = core.waitsOf(QODER_WAIT, hub, secret).count(sessionId);
  return {
    command: core.waitCommand(QODER_WAIT, core.ticketFor(QODER_WAIT, secret, sessionId), hubUrl),
    run_in_background: true, description: core.WAIT_DESCRIPTION, running,
    ...(running ? { instructions: `这个对话现在已经有 ${running} 条这样的命令连着 orrery：不要再运行，照常结束这一轮。` } : {}),
  };
}
