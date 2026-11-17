// The adapter side of the background-wait route, shared by the harnesses on it (src/mcp/wait-core.ts holds the Hub side):
//   online = a wait is connected, or a delivery is waiting for the member to run it again (the re-arm grace);
//   a wait left behind by an app that quit (its shell survived) is offline: no process of h.appProcess runs for this
//   user. That check only ever turns a connected wait offline, never anything online; it is cached, and redone before
//   each delivery;
//   deliver = push through the wait, then hold the session busy until the re-arm (messages meanwhile queue and go
//   together on the next wait) or until the grace ends (then the member turns offline and its queue ends 'offline').
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import type { NativeAdapter, WaitHarness } from '../../core/types.ts';

/** How long a delivered conversation counts as online (busy) while waiting for the member to run the wait again. */
const REARM_GRACE_MS = 30 * 60_000;
const POLL_MS = 250;
const RUNNING_CACHE_MS = 10_000;

/** Whether a process of that image name runs for this Windows user; null when unknown (not Windows, or tasklist failed). */
export function appProcessRunning(appProcess: string): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const line = `"${appProcess.toLowerCase()}",`;
  return new Promise((done) => {
    // The username filter makes tasklist take seconds on a busy machine; a timeout only means "unknown" (counts as
    // running), so wait rather than misread it.
    execFile('tasklist', ['/FI', `IMAGENAME eq ${appProcess}`, '/FI', `USERNAME eq ${userInfo().username}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 20_000 }, (err, stdout) => done(err ? null : String(stdout).toLowerCase().split(/\r?\n/).some((l) => l.startsWith(line))));
  });
}

/**
 * The app-running answer, cached: `check()` asks now (one question at a time), `gone()` answers from the cache (asking
 * again in the background when it is stale) and is true only when the app was seen not running.
 */
export function appRunningCache(lister: () => Promise<boolean | null>): { check(): Promise<boolean | null>; gone(): boolean } {
  let running: { at: number; value: boolean | null } = { at: 0, value: null };
  let checking: Promise<boolean | null> | null = null;
  const check = (): Promise<boolean | null> => checking ??= lister().catch(() => null).then((value) => {
    running = { at: Date.now(), value };
    checking = null;
    return value;
  });
  return {
    check,
    gone: () => {
      if (Date.now() - running.at > RUNNING_CACHE_MS) void check();
      return running.value === false;
    },
  };
}

export function createWaitDelivery(h: WaitHarness, opts: {
  /** The event shown when the member does not run the wait again within the grace. */
  notRearmed: string;
  rearmGraceMs?: number; pollMs?: number;
  /** Is the app running for this user? Default: tasklist. Null: unknown (counts as running). */
  appRunning?: () => Promise<boolean | null>;
}): Pick<NativeAdapter, 'isOnline' | 'deliver'> {
  const graceMs = opts.rearmGraceMs ?? REARM_GRACE_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const app = h.appProcess.replace(/\.exe$/i, '');
  const awaiting = new Set<string>();   // sessions in their re-arm grace
  const { check, gone } = appRunningCache(opts.appRunning ?? (() => appProcessRunning(h.appProcess)));
  return {
    isOnline: (sessionId, bridge) => awaiting.has(sessionId) || (bridge.isOnline(h.harness, sessionId) && !gone()),
    async deliver(sessionId, text, ctx) {
      if (!ctx.bridge.isOnline(h.harness, sessionId) || (await check()) === false) return 'offline';
      if (!ctx.bridge.isOnline(h.harness, sessionId)) return 'offline';   // the wait went away during the check
      // Before the push: the wait leaves the bridge registry the moment it takes the delivery.
      awaiting.add(sessionId);
      try {
        let ack;
        try {
          ack = await ctx.bridge.push(h.harness, sessionId, ctx.deliveryId, text);
        } catch (e) {
          return { outcome: 'unknown', error: `${app} wait could not take the delivery: ${e instanceof Error ? e.message : String(e)}` };
        }
        // Printed (or maybe printed, when the ack is missing): the member re-arms at the end of the turn it starts.
        // shortcut: polls the bridge registry (an in-memory lookup); upgrade to a callback if the delay matters.
        const end = Date.now() + graceMs;
        while (!ctx.signal.aborted && !ctx.bridge.isOnline(h.harness, sessionId) && Date.now() < end) {
          await new Promise((ok) => setTimeout(ok, pollMs));
        }
        if (!ctx.signal.aborted && !ctx.bridge.isOnline(h.harness, sessionId)) ctx.onEvent({ type: 'error', message: opts.notRearmed });
        return ack.ok ? 'accepted' : { outcome: 'unknown', error: `the ${app} wait printed nothing it confirmed: ${ack.error}` };
      } finally {
        awaiting.delete(sessionId);
      }
    },
  };
}
