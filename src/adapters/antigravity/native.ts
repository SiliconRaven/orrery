// Native Antigravity: the member is a conversation the user sees in the Antigravity 2.0 desktop app. The Hub delivers
// into it through the orrery sidecar the user installed and enabled in Antigravity (plugins/antigravity-orrery): the
// sidecar runs inside the app, holds the harness's shared bridge stream and hands each delivery to the official
// `agentapi send-message`. So online = that stream is connected (the app is running with the sidecar enabled); the
// Hub never runs any Antigravity program itself. Conversations are listed read-only from the app's summaries database
// (./store.ts). No createSession: the user creates conversations in the app. docs/adapters/antigravity.md.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeAdapter } from '../../core/types.ts';
import { createConversationStore } from './store.ts';
import { readAntigravityTranscript } from './transcript.ts';

const HARNESS = 'antigravity';

export function createAntigravityNativeAdapter(opts: { geminiHome?: string } = {}): NativeAdapter {
  const geminiHome = resolve(opts.geminiHome ?? join(homedir(), '.gemini'));
  const store = createConversationStore(geminiHome);
  return {
    harness: HARNESS,
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: () => store.listProjects(),
    listSessions: (projectPath) => store.listSessions(projectPath),
    transcript: (sessionId, request) => readAntigravityTranscript(join(geminiHome, 'antigravity', 'brain'), sessionId, request),
    async attachSession(sessionId) {
      const info = await store.get(sessionId);
      if (!info) throw new Error(`antigravity conversation ${sessionId} not found among the Antigravity 2.0 conversations with a workspace under ${geminiHome}`);
      return info;
    },
    isOnline: (sessionId, bridge) => bridge.isOnline(HARNESS, sessionId),
    async deliver(sessionId, text, ctx) {
      if (!ctx.bridge.isOnline(HARNESS, sessionId)) return 'offline';
      let ack;
      try {
        ack = await ctx.bridge.push(HARNESS, sessionId, ctx.deliveryId, text);
      } catch (e) {
        return { outcome: 'unknown', error: `Antigravity bridge delivery could not be confirmed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!ack.ok) return { outcome: 'unknown', error: ack.error };
      // shortcut: 'accepted' only (agentapi took it); upgrade to 'completed' with a Stop hook or the summaries status.
      return 'accepted';
    },
  };
}
