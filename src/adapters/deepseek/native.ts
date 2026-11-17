// Native DeepSeek Harness (DSH): the member is a session the user sees in the DSH desktop app. The Hub delivers into
// it through the orrery plugin (plugins/dsh-orrery) that the user installed in DSH: the plugin holds the harness's
// shared bridge stream, so online = that stream is connected (DSH is running with the plugin). Sessions are listed
// from DSH's projection cache, read-only. No createSession: the user creates sessions in the app.
// deliver stays busy until the turn the delivery starts has ended (the plugin's POST /bridge/done), so messages that
// arrive meanwhile reach DSH together in the next batch: DSH itself runs every queued prompt as a turn of its own.
// docs/adapters/deepseek.md.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeAdapter } from '../../core/types.ts';
import { createSessionStore } from './store.ts';

const HARNESS = 'deepseek';

/** How long deliver waits for the end of the turn before giving the member free anyway (as Codex and Kimi wait for a pickup). */
const TURN_WAIT_MS = 30 * 60_000;

export function createDeepseekNativeAdapter(opts: { dshHome?: string; turnWaitMs?: number } = {}): NativeAdapter {
  const dshHome = resolve(opts.dshHome ?? (process.env.DSH_HOME || join(homedir(), '.dsh')));
  const turnWaitMs = opts.turnWaitMs ?? TURN_WAIT_MS;
  const store = createSessionStore(dshHome);
  return {
    harness: HARNESS,
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: () => store.listProjects(),
    listSessions: (projectPath) => store.listSessions(projectPath),
    async attachSession(sessionId) {
      const info = await store.get(sessionId);
      if (!info) throw new Error(`deepseek session ${sessionId} not found in the DeepSeek Harness session cache under ${dshHome}`);
      return info;
    },
    isOnline: (sessionId, bridge) => bridge.isOnline(HARNESS, sessionId),
    // No quota: DSH is pay-as-you-go, without time windows; the balance needs the API key (docs/usage.md).
    // A turn's tokens come with the plugin's POST /bridge/done (the Hub records them itself).
    conversationTokens: (sessionId) => store.tokens(sessionId),
    async deliver(sessionId, text, ctx) {
      if (!ctx.bridge.isOnline(HARNESS, sessionId)) return 'offline';
      let ack;
      try {
        ack = await ctx.bridge.push(HARNESS, sessionId, ctx.deliveryId, text);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { outcome: 'unknown', error: `DeepSeek bridge push failed (${why}); the message may have been delivered` };
      }
      if (!ack.ok) {
        if (ack.outcome === 'unknown') return { outcome: 'unknown', error: ack.error };
        throw new Error(ack.error);
      }
      // A plugin that does not report turn ends (an older one, still loaded in DSH): DSH queued it, nothing more to know.
      if (!ack.follows) return 'accepted';
      // A missing result or a stopped wait does not tell us how the turn ended.
      const end = await ctx.bridge.waitDone(HARNESS, sessionId, ctx.deliveryId, turnWaitMs, ctx.signal);
      if (typeof end === 'object') {
        if (end.outcome === 'completed') return 'completed';
        return { outcome: end.outcome, error: end.error ?? (end.outcome === 'failed' ? 'DeepSeek turn failed' : 'DeepSeek turn outcome is unknown') };
      }
      const why = {
        done: 'the plugin did not report a turn result',
        dropped: 'the plugin connection closed',
        timeout: 'waiting for the turn timed out',
        aborted: 'waiting for the turn was cancelled',
      }[end];
      return { outcome: 'unknown', error: `DeepSeek accepted the message, but ${why}; its outcome is unknown` };
    },
  };
}
