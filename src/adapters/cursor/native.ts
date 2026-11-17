// Native Cursor: the member is an agent conversation the user sees in the Cursor desktop app (docs/adapters/cursor.md).
// The user's orrery plugin (plugins/cursor-orrery) runs three hooks in every conversation: stop reports the end of a
// turn and then parks at the Hub (src/mcp/hook-park.ts) until a batch comes, which it returns as followup_message;
// Cursor submits that as the next user message. beforeSubmitPrompt reports the start of every turn, with the batch's
// 8-hex hand-over id when the prompt's first line carries one: only that confirms Cursor submitted the batch (it
// silently drops an older park's answer). postToolUse speaks for the model (the Hub knows it by the session header).
// Per session, in memory: whether a turn runs, and the reports a delivery waits for. A batch is handed out at most
// once; every outcome after the hand-out is final, nothing is redone automatically.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { NativeAdapter, NativeDeliveryResult, TokenTotals, TurnHookHarness, TurnReport } from '../../core/types.ts';
import { marker } from '../shared/marker.ts';
import { appProcessRunning, appRunningCache } from '../shared/wait-native.ts';
import { createCursorStore, defaultCursorData } from './store.ts';

export const CURSOR = 'cursor';
export const CURSOR_APP = 'Cursor.exe';

export const NOT_CONFIRMED = '交给了 Cursor，但没看到它提交这条消息：多半是你同时在这个对话里发了消息，Cursor 丢弃了旧等待的回答；也可能是 beforeSubmitPrompt hook 没有运行';

/** The defaults; tests pass shorter ones. */
const TIMES = {
  confirmMs: 30_000,          // ack → the start report with the hand-over id
  turnMs: 30 * 60_000,        // the start → the end of that turn; also how long a turn counts as running without an end
  reparkMs: 10_000,           // after a turn's end, how long the next park may take before the conversation counts as gone
  pollMs: 100,
};
/** Sessions whose turn state is kept; the oldest is forgotten first. */
const MAX_SESSIONS = 1000;

/** The 8-hex hand-over id of a batch: the first 8 hex digits of its delivery id. */
export function handoutOf(deliveryId: string): string {
  const hex = deliveryId.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length >= 8 ? hex.slice(0, 8) : hex.padEnd(8, '0');
}

/** Cursor's raw counts to TokenTotals: input_tokens includes the cached part (inferred, not reconciled with Cursor's UI). */
export function cursorTokens(u: NonNullable<TurnReport['usage']>): TokenTotals {
  return { input: Math.max(0, u.input - u.cacheRead - u.cacheWrite), cachedInput: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, reasoning: 0 };
}

interface SessionState { running: { generationId: string; at: number } | null; endedAt: number }

export function createCursorNativeAdapter(opts: {
  cursorHome?: string; cursorData?: string;
  /** Is Cursor running for this user? Default: tasklist. Null: unknown (counts as running). */
  cursorRunning?: () => Promise<boolean | null>;
  times?: Partial<typeof TIMES>;
} = {}): NativeAdapter & { turnHooks: TurnHookHarness } {
  // ORRERY_CURSOR_HOME / ORRERY_CURSOR_DATA: orrery's own overrides of where it reads Cursor's files (tests).
  const cursorHome = resolve(opts.cursorHome ?? (process.env.ORRERY_CURSOR_HOME || join(homedir(), '.cursor')));
  const cursorData = resolve(opts.cursorData ?? (process.env.ORRERY_CURSOR_DATA || defaultCursorData(process.env.APPDATA, homedir())));
  const store = createCursorStore(cursorHome, cursorData);
  const t = { ...TIMES, ...opts.times };
  const app = appRunningCache(opts.cursorRunning ?? (() => appProcessRunning(CURSOR_APP)));
  const sessions = new Map<string, SessionState>();
  const listeners = new Set<(r: TurnReport) => void>();
  const delivering = new Set<string>();

  const stateOf = (id: string): SessionState => {
    let s = sessions.get(id);
    if (!s) {
      sessions.set(id, s = { running: null, endedAt: 0 });
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    }
    return s;
  };
  const turnRunning = (id: string): boolean => {
    const r = sessions.get(id)?.running;
    return !!r && Date.now() - r.at < t.turnMs;
  };
  const justEnded = (id: string): boolean => Date.now() - (sessions.get(id)?.endedAt ?? 0) < t.reparkMs;

  /** The first report of the session that `match` accepts, or null after `ms` or on abort. */
  function nextReport(sessionId: string, match: (r: TurnReport) => boolean, ms: number, signal: AbortSignal): { report: Promise<TurnReport | null>; cancel(): void } {
    let listener!: (r: TurnReport) => void;
    let cancel!: () => void;
    const report = new Promise<TurnReport | null>((done) => {
      const timer = setTimeout(() => finish(null), ms);
      const onAbort = () => finish(null);
      const finish = (r: TurnReport | null) => {
        clearTimeout(timer);
        listeners.delete(listener);
        signal.removeEventListener('abort', onAbort);
        done(r);
      };
      listener = (r) => { if (r.sessionId === sessionId && match(r)) finish(r); };
      cancel = () => finish(null);
      listeners.add(listener);
      if (signal.aborted) finish(null);
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    return { report, cancel };
  }

  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

  /**
   * Waits until the session has a park. While a turn runs (the user's own, most likely) it waits for it to end; after
   * an end it gives the stop hook reparkMs to park. False when none came.
   */
  async function parkReady(sessionId: string, ctx: Parameters<NativeAdapter['deliver']>[2]): Promise<boolean> {
    let toldBusy = false;
    let idleSince = Date.now();
    while (!ctx.signal.aborted) {
      if (ctx.bridge.isOnline(CURSOR, sessionId)) return true;
      if (turnRunning(sessionId)) {
        if (!toldBusy) ctx.waiting?.({ busy: true });
        toldBusy = true;
        idleSince = Date.now();
      } else if (Date.now() - Math.max(idleSince, sessions.get(sessionId)?.endedAt ?? 0) > t.reparkMs) return false;
      await sleep(t.pollMs);
    }
    return false;
  }

  const turnHooks: TurnHookHarness = {
    harness: CURSOR,
    turn(r) {
      const s = stateOf(r.sessionId);
      if (r.event === 'start') s.running = { generationId: r.generationId, at: Date.now() };
      else if (!s.running || s.running.generationId === r.generationId) {
        // The end of the turn that runs (or of one whose start this Hub never saw). A late end of an older turn
        // leaves the newer one's state alone; it still reaches a delivery waiting for that older turn below.
        s.running = null;
        s.endedAt = Date.now();
      }
      for (const l of [...listeners]) l(r);
    },
  };

  return {
    harness: CURSOR,
    turnHooks,
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: () => store.listProjects(),
    listSessions: (projectPath) => store.listSessions(projectPath),
    async attachSession(sessionId) {
      const info = await store.get(sessionId);
      if (!info) throw new Error(`cursor conversation ${sessionId} not found among the Cursor agent transcripts under ${cursorHome}`);
      return info;
    },
    // A parked stop hook, a turn running (or just ended: its stop hook parks right after reporting the end), or a batch on
    // its way; and Cursor not seen gone (that only ever turns it offline).
    isOnline: (sessionId, bridge) => (bridge.isOnline(CURSOR, sessionId) || turnRunning(sessionId) || justEnded(sessionId)
      || delivering.has(sessionId)) && !app.gone(),
    async deliver(sessionId, text, ctx): Promise<NativeDeliveryResult> {
      if (!(ctx.bridge.isOnline(CURSOR, sessionId) || turnRunning(sessionId) || justEnded(sessionId)) || (await app.check()) === false) return 'offline';
      delivering.add(sessionId);
      try {
        const handout = handoutOf(ctx.deliveryId);
        const body = `${marker(ctx.from, handout)}\n${text}`;
        let ack;
        let started: ReturnType<typeof nextReport>;
        for (;;) {
          // Until it is handed out, the text never left the Hub: offline is safe to say.
          if (!(await parkReady(sessionId, ctx))) return ctx.signal.aborted ? { outcome: 'unknown', error: 'Hub 中止了这次投递，这一批没有交给 Cursor' } : 'offline';
          // Listening before the push: Cursor submits the followup within about a second of the hook's answer.
          // Its own limit only covers a push that never settles; after the ack, confirmMs applies.
          started = nextReport(sessionId, (r) => r.event === 'start' && r.handout === handout, t.confirmMs + 120_000, ctx.signal);
          try {
            ack = await ctx.bridge.push(CURSOR, sessionId, ctx.deliveryId, body);
            break;
          } catch {
            started.cancel();   // the park went away just before the push: nothing was sent, wait for the next one
          }
        }
        if (!ack.ok) {
          started.cancel();
          return { outcome: 'unknown', error: `Cursor 的 stop hook 可能已经输出了这一批，但没有确认：${ack.error}` };
        }
        ctx.waiting?.({ busy: false });
        const giveUp = setTimeout(() => started.cancel(), t.confirmMs);
        const confirm = await started.report;
        clearTimeout(giveUp);
        if (!confirm) return { outcome: 'unknown', error: ctx.signal.aborted ? 'Hub 中止了等待，Cursor 是否提交了这一批未知' : NOT_CONFIRMED };
        ctx.waiting?.(null);
        const end = await nextReport(sessionId, (r) => r.event === 'end' && r.generationId === confirm.generationId, t.turnMs, ctx.signal).report;
        if (!end) return { outcome: 'unknown', error: ctx.signal.aborted ? 'Hub 中止了等待，Cursor 这一轮的结果未知' : 'Cursor 这一轮 30 分钟内没有报告结束，结果未知' };
        if (end.usage) ctx.usage?.(cursorTokens(end.usage));
        // The same stop hook parks right after its report: give it a moment, so the next batch does not find no park.
        const until = Date.now() + t.reparkMs;
        while (!ctx.signal.aborted && !ctx.bridge.isOnline(CURSOR, sessionId) && !turnRunning(sessionId) && Date.now() < until) await sleep(t.pollMs);
        if (end.status === 'error') return { outcome: 'failed', error: 'Cursor 报告这一轮出错' };
        if (end.status === 'aborted') return { outcome: 'failed', error: '这一轮在 Cursor 里被停止' };
        return 'completed';
      } finally {
        delivering.delete(sessionId);
      }
    },
  };
}
