// Fake native adapter for tests and for trying native mode without a real app. Two kinds:
// - 'bridge': like Claude. Online only while a bridge stream for the session is connected; delivers through
//   BridgePort.push and resolves 'accepted' on a good ack. No createSession (the user creates sessions in the app).
// - 'queue': like Codex. Always online; "runs" the turn itself, emits one text event and resolves 'completed'.
import { randomUUID } from 'node:crypto';
import type { ModelInfo, NativeAdapter, NativeDeliverContext, ProjectInfo, SessionInfo } from '../../core/types.ts';
export const MOCK_MODEL = 'mock-1';
export const MOCK_MODELS: ModelInfo[] = [
  { id: MOCK_MODEL, label: 'Mock 1', efforts: ['low', 'high'], isDefault: true },
  { id: 'mock-2', efforts: [] },
];

export interface MockNativeOptions {
  harness?: string;                 // default 'mock'
  kind?: 'bridge' | 'queue';        // default 'queue'
  projects?: ProjectInfo[];
  sessions?: SessionInfo[];         // listed under the project whose path equals their cwd
  model?: string;                   // model reported for created sessions when none is asked for
  localSessions?: true;             // let the Hub re-read title and model through attachSession (like the file-based adapters)
  /** Replaces the 'queue' kind's turn; return what deliver should resolve. */
  onDeliver?: (sessionId: string, text: string, ctx: NativeDeliverContext) => Promise<'accepted' | 'completed' | 'offline'>;
}

export interface MockNativeAdapter extends NativeAdapter {
  /** Every deliver call, in order. */
  readonly delivered: { sessionId: string; text: string; deliveryId: string }[];
  /** Every createSession call, in order ('queue' kind only). */
  readonly created: { cwd: string; title: string; model?: string; effort?: string; memberName?: string }[];
}

export function createMockNativeAdapter(opts: MockNativeOptions = {}): MockNativeAdapter {
  const harness = opts.harness ?? 'mock';
  const kind = opts.kind ?? 'queue';
  const sessions = [...(opts.sessions ?? [])];
  const delivered: MockNativeAdapter['delivered'] = [];
  const created: MockNativeAdapter['created'] = [];

  const adapter: MockNativeAdapter = {
    harness,
    delivered,
    created,
    ...(opts.localSessions ? { localSessions: true as const } : {}),
    async listProjects() {
      return opts.projects ?? [];
    },
    async listSessions(projectPath) {
      return sessions.filter((s) => s.cwd === projectPath);
    },
    async attachSession(sessionId) {
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) throw new Error(`mock ${harness} session ${sessionId} not found`);
      return s;
    },
    isOnline(sessionId, bridge) {
      return kind === 'queue' || bridge.isOnline(harness, sessionId);
    },
    async deliver(sessionId, text, ctx) {
      delivered.push({ sessionId, text, deliveryId: ctx.deliveryId });
      if (opts.onDeliver) return opts.onDeliver(sessionId, text, ctx);
      if (kind === 'bridge') {
        if (!ctx.bridge.isOnline(harness, sessionId)) return 'offline';
        const ack = await ctx.bridge.push(harness, sessionId, ctx.deliveryId, text);
        if (!ack.ok) throw new Error(ack.error);
        return 'accepted';
      }
      ctx.onEvent({ type: 'text', text: `mock ${harness} received: ${text}` });
      return 'completed';
    },
  };
  if (kind === 'queue') {
    adapter.listModels = async () => MOCK_MODELS;
    adapter.createSession = async ({ cwd, title, model, effort, memberName }) => {
      created.push({ cwd, title, model, effort, ...(memberName === undefined ? {} : { memberName }) });
      const id = `mock-native-${randomUUID()}`;
      const m = model ?? opts.model ?? MOCK_MODEL;
      sessions.push({ id, title, model: m, cwd, updatedAt: null });
      return { sessionId: id, model: m };
    };
  }
  return adapter;
}
