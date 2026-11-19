// The demo `mock` harness (ORRERY_MOCK=1, README「试用」): lets a first-time user try orrery without a real app. It is
// the 'queue' native mock over one demo project with two existing conversations, and it answers every delivery with
// an obviously fake one-line reply, posted the way a Kimi member's answer is (`replies`, NativeDeliverContext.reply):
// as the member's own message, through the Hub's member-send path, so @ routing, the hop and turn limits and the pause
// switch apply. The reply never @-mentions anyone (it names senders without "@" and never echoes the body), so it is
// delivered to nobody and two demo mocks cannot keep each other busy. Tests use the scripted mock in test/mock.ts.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeAdapter } from '../../core/types.ts';
import { createMockNativeAdapter, MOCK_MODEL } from './native.ts';

const DEMO_PROJECT = join(tmpdir(), 'orrery-mock-project');

/** The fake answer to one delivery: who it came from (names, 'user' for the user) and how many messages, nothing else. */
export function demoReply(from: string[] | undefined, count: number): string {
  const who = (from ?? []).map((n) => (n === 'user' ? '你' : n)).join('、') || '群里';
  return `（演示用 mock 的自动回复，不是真的模型）收到${who}的 ${count} 条消息。`;
}

export function createDemoMockAdapter(): NativeAdapter {
  const adapter = createMockNativeAdapter({
    projects: [{ path: DEMO_PROJECT, label: 'mock-project', updatedAt: null }],
    sessions: [
      { id: 'mock-session-1', title: 'mock session 1', model: MOCK_MODEL, cwd: DEMO_PROJECT, updatedAt: null },
      { id: 'mock-session-2', title: 'mock session 2', model: MOCK_MODEL, cwd: DEMO_PROJECT, updatedAt: null },
    ],
    onDeliver: async (_sessionId, text, ctx) => {
      // One "[orrery] cluster=..." header per delivered message (a batch carries several).
      const count = Math.max(1, text.match(/^\[orrery\] cluster=/gm)?.length ?? 0);
      const reply = demoReply(ctx.from, count);
      ctx.onEvent({ type: 'text', text: reply });
      ctx.reply?.(reply);
      return 'completed';
    },
  });
  return Object.assign(adapter, { replies: true as const });
}
