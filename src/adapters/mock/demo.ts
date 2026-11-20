// The demo `mock` harness (ORRERY_MOCK=1, README「试用」): lets a first-time user try orrery without a real app. It is
// the 'queue' native mock over one demo project with two existing conversations, and it answers every delivery with
// an obviously fake one-line reply, posted the way a Kimi member's answer is (`replies`, NativeDeliverContext.reply):
// as the member's own message, through the Hub's member-send path, so @ routing, the hop and turn limits and the pause
// switch apply. The reply never @-mentions anyone (it names senders without "@" and never echoes the body), so it is
// delivered to nobody and two demo mocks cannot keep each other busy. Tests use the scripted mock in test/mock.ts.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeAdapter, TranscriptItem, TranscriptPage } from '../../core/types.ts';
import { createMockNativeAdapter, MOCK_MODEL } from './native.ts';

const DEMO_PROJECT = join(tmpdir(), 'orrery-mock-project');

/** The fake answer to one delivery: who it came from (names, 'user' for the user) and how many messages, nothing else. */
export function demoReply(from: string[] | undefined, count: number): string {
  const who = (from ?? []).map((n) => (n === 'user' ? '你' : n)).join('、') || '群里';
  return `（演示用 mock 的自动回复，不是真的模型）收到${who}的 ${count} 条消息。`;
}

/**
 * The demo conversations' "native transcript" (docs/starmap.md: the star map's member window needs one to show): kept
 * in memory, a few fixed lines per conversation and then each delivery as the user line the Hub verifies by its
 * delivery id (shown as an orrery delivery) plus the fake reply. Cursors are plain item indexes; the Hub seals them.
 */
function demoTranscripts() {
  const logs = new Map<string, TranscriptItem[]>();
  const log = (sessionId: string) => {
    let items = logs.get(sessionId);
    if (!items) {
      const at = new Date().toISOString();
      items = [
        { id: `${sessionId}-1`, kind: 'user', text: '（演示）你好，这是在应用里直接打的一句话。', timestamp: at },
        { id: `${sessionId}-2`, kind: 'thinking', text: '（演示的思考摘要）', timestamp: at },
        { id: `${sessionId}-3`, kind: 'tool_call', name: 'read_file', callId: `${sessionId}-c1`, text: '{"path":"README.md"}', timestamp: at },
        { id: `${sessionId}-4`, kind: 'tool_result', name: 'read_file', callId: `${sessionId}-c1`, text: '# orrery（演示内容）', timestamp: at },
        { id: `${sessionId}-5`, kind: 'assistant', text: '（演示用 mock 的回答）你好，我是假的模型。', timestamp: at },
      ];
      logs.set(sessionId, items);
    }
    return items;
  };
  return {
    record(sessionId: string, deliveryId: string, text: string, reply: string) {
      const items = log(sessionId);
      const at = new Date().toISOString();
      items.push({ id: `${sessionId}-${items.length + 1}`, kind: 'user', text, timestamp: at, source: { deliveryId } },
        { id: `${sessionId}-${items.length + 2}`, kind: 'assistant', text: reply, timestamp: at });
    },
    page(sessionId: string, { cursor, direction, limit = 200 }: { cursor?: string; direction?: 'before' | 'after'; limit?: number }): TranscriptPage {
      const items = log(sessionId);
      const at = cursor === undefined ? null : Number(cursor);
      if (at !== null && (!Number.isSafeInteger(at) || at < 0 || at > items.length)) return { status: 'reset', items: [], hasMore: false, unknownCount: 0 };
      let start: number, end: number;
      if (at === null) { end = items.length; start = Math.max(0, end - limit); }
      else if (direction === 'after') { start = at; end = Math.min(items.length, at + limit); }
      else { end = at; start = Math.max(0, at - limit); }
      const hasMore = direction === 'after' ? end < items.length : start > 0;
      return { status: 'ok', items: items.slice(start, end), before: String(start), after: String(end), hasMore, unknownCount: 0 };
    },
  };
}

export function createDemoMockAdapter(): NativeAdapter {
  const transcripts = demoTranscripts();
  const adapter = createMockNativeAdapter({
    projects: [{ path: DEMO_PROJECT, label: 'mock-project', updatedAt: null }],
    sessions: [
      { id: 'mock-session-1', title: 'mock session 1', model: MOCK_MODEL, cwd: DEMO_PROJECT, updatedAt: null },
      { id: 'mock-session-2', title: 'mock session 2', model: MOCK_MODEL, cwd: DEMO_PROJECT, updatedAt: null },
    ],
    onDeliver: async (sessionId, text, ctx) => {
      // One "[orrery] cluster=..." header per delivered message (a batch carries several).
      const count = Math.max(1, text.match(/^\[orrery\] cluster=/gm)?.length ?? 0);
      const reply = demoReply(ctx.from, count);
      ctx.onEvent({ type: 'text', text: reply });
      transcripts.record(sessionId, ctx.deliveryId, text, reply);
      ctx.reply?.(reply);
      return 'completed';
    },
  });
  return Object.assign(adapter, {
    replies: true as const,
    async transcript(sessionId: string, request: { cursor?: string; direction?: 'before' | 'after'; limit?: number }) { return transcripts.page(sessionId, request); },
  });
}
