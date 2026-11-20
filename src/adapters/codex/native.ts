// Native Codex adapter (docs/native-mode.md, "原生 Codex"): a member is a thread the user sees in the ChatGPT/Codex
// desktop app. orrery never loads that thread and never starts a turn on it. It puts the message into the thread's
// queue (thread/queue/add), asks the app to wake the thread (codex://threads/wake/<id>) every time it queued one,
// and watches the outcome read-only (thread/turns/list). The desktop app's own backend runs the turn. The wake also
// helps when the app already has the thread loaded: its backend then runs the queue at once instead of on its own
// timer (about 10 s).
//
// Every operation runs in its own short-lived `codex app-server`, which exits right after: holding a process would
// keep any thread it touched loaded, and a loaded thread's writer lock would lock the desktop app out of it.
// Protocol facts: `codex app-server generate-ts --experimental` (desktop backend 0.165.0-alpha.1.2, CLI 0.164.0);
// see docs/adapters/codex.md.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentEvent, NativeAdapter, NativeDeliverContext, NativeDeliveryResult, ProjectInfo, SessionInfo, TokenTotals } from '../../core/types.ts';
import { decideServerRequest, fetchModels, toSessionInfo, type CodexProcess, type CodexThread } from './protocol.ts';
import { RpcPeer } from './rpc.ts';
import { codexTranscript } from './transcript.ts';
import { createCodexUsage, fromAppServer } from './usage.ts';

/** v2/ThreadItem.ts and v2/Turn.ts, the subset read here. */
interface ObservedItem { type: string; clientId?: string | null; text?: string }
interface ObservedTurn { id: string; status: string; items: ObservedItem[]; error: { message: string } | null }
interface QueuedSubmission { id: string; clientUserMessageId: string }

export type WriterLockState = { state: 'held' } | { state: 'unknown'; reason: string };

export interface CodexNativeOptions {
  /** Starts one app-server. Default: `codexBinary()` with `app-server`, on stdio. */
  launch?: () => CodexProcess;
  /** Where Codex keeps its data, for the writer-lock check. Default: $CODEX_HOME or ~/.codex. */
  codexHome?: string;
  /** Replaces the writer-lock check (tests). */
  lockHeld?: (threadId: string) => WriterLockState;
  /** Opens the wake link. Default: the Windows shell's `start`. Only ever called with a checked UUID. */
  openWake?: (url: string) => void;
  /** The "is the desktop app running" check itself (tests). Default: `codexAppRunning()`. */
  appRunning?: () => Promise<boolean | null>;
  /**
   * Does an app instance run that a wake link goes to, so opening it starts no new process (tests)? Asked right before
   * each wake, after `appRunning` confirmed the app runs. Default: `codexWakeTargetRunning()`.
   */
  wakeTarget?: () => Promise<boolean | null>;
  /** How old the answer isOnline returns may get before an isOnline call starts a refresh. Default 10 s. */
  appCheckMs?: number;
  /** Longest one try of the app check may take; a try still running then counts as unanswered. Default 25 s. */
  appQueryTimeoutMs?: number;
  /** Base interval for observing a delivery. An established running turn is observed at twice this interval. */
  pollMs?: number;
  /**
   * How long a queued delivery may wait for the app to pick it up before it is taken out of the queue again. Only time
   * the thread is idle counts: the app takes queued messages only between turns, so time behind a running turn is free.
   */
  pickupTimeoutMs?: number;
  /**
   * A queued delivery that is neither in the queue nor visible as a turn on this many polls in a row, spanning at least
   * `vanishedMs`, left the queue without running: the delivery fails. One such poll alone can be the normal handover
   * (the app takes an item off the queue a moment before its turn becomes visible).
   */
  vanishedPolls?: number;
  vanishedMs?: number;
  /** Most app-server processes alive at once; further operations wait for a free slot. */
  maxProcesses?: number;
  /** Longest a single operation (one process) may take. */
  opTimeoutMs?: number;
  /** How long a finished operation waits for its app-server to exit after stdin closes, and again after a kill. */
  exitWaitMs?: number;
  /** Longest the init turn of createSession (only when a model or effort was chosen) may take. */
  initTimeoutMs?: number;
  /** How often, and how many times, a completed turn's tokens are looked for in its rollout file (it may lag). */
  usageRetryMs?: number;
  usageTries?: number;
}

/** The fixed input of the init turn that makes a new thread keep its chosen model and effort. */
export function initPrompt(clusterName: string, memberName: string): string {
  return `你是 orrery 集群「${clusterName}」的群员「${memberName}」。只回复 ok。`;
}

/**
 * Answers to server requests during the init turn: every approval and prompt is declined (the init needs no tools),
 * in the shape each request expects; unknown requests get a JSON-RPC error.
 */
function declineAll(method: string, params: unknown): unknown {
  return decideServerRequest(method, (params ?? {}) as Record<string, unknown>).result;
}

/** Codex thread ids are UUIDs (v7). Checked before an id reaches the queue, the wake link or a command line. */
export const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_PAGE = 100;
const PROJECT_PAGES = 5;
// shortcut: listProjects scans at most LIST_PAGE * PROJECT_PAGES recent threads; page further when users have more projects.
const SESSION_PAGES = 100;
const TURNS_PAGE = 20;
// shortcut: a delivery is looked for among the newest TURNS_PAGE turns; follow nextCursor if users ever outpace a poll.

/**
 * The desktop app's own backend binary (newest %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe), so orrery speaks the
 * same version as the process that runs the thread; else `codex` on PATH. $ORRERY_CODEX_NATIVE_BIN overrides both.
 */
export function codexBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORRERY_CODEX_NATIVE_BIN) return env.ORRERY_CODEX_NATIVE_BIN;
  const base = join(env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  try {
    const found = readdirSync(base).map((d) => join(base, d, 'codex.exe')).filter((p) => existsSync(p));
    found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (found[0]) return found[0];
  } catch { /* no desktop app */ }
  return 'codex';
}

/** Kills the app-server and whatever it started (on Windows `kill()` would leave e.g. a git child running). */
function killTree(pid: number | undefined, kill: () => void): void {
  if (process.platform === 'win32' && pid !== undefined) {
    // taskkill failing to start or exiting non-zero (e.g. access denied): fall back to killing the process itself.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => kill())
      .on('exit', (code) => { if (code !== 0) kill(); });
  } else kill();
}

function launchNative(): CodexProcess {
  // Plugin and app sync are switched off for this process only (command-line overrides; no config file is touched).
  const child = spawn(codexBinary(), ['-c', 'features.plugins=false', '-c', 'features.apps=false', 'app-server'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => killTree(child.pid, () => void child.kill()),
    onExit: (cb) => {
      child.once('error', (e) => cb(`app-server failed to start: ${e.message}`));
      child.once('exit', (code, sig) => cb(`app-server exited (${sig ?? code})`));
    },
  };
}

/**
 * The desktop app registers the `codex` URL scheme; this link makes it load the thread in its own backend, which then
 * runs the queue. `start` goes through cmd.exe, so the URL must be fixed text plus a checked UUID: nothing else is
 * ever put on that command line.
 */
function openWakeLink(url: string): void {
  // shortcut: Windows only (the desktop app is Windows-first here); add `open`/`xdg-open` when other platforms matter.
  if (process.platform !== 'win32') return;
  spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => {})
    .unref();
}

/**
 * Is the ChatGPT/Codex desktop app running? `tasklist /APPS` lists only the processes of packaged (Store) apps, each
 * with its package name; the app's own processes belong to the `OpenAI.Codex_…` package. Only the app's own executable
 * (ChatGPT.exe) counts: a helper of the package (RuntimeBroker.exe) can outlive the quit app by tens of seconds. Its
 * backend codex.exe and the short-lived app-servers orrery starts (the same binary) are not packaged processes, so they
 * never count.
 * shortcut: Windows only; elsewhere the app counts as running (and the wake link is never opened there anyway).
 * Null when tasklist failed or timed out: on a busy machine it can take many seconds, and that says nothing about the app.
 */
export function codexAppRunning(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('tasklist', ['/APPS', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 20_000 }, (err, stdout) => resolve(err ? null : codexAppIn(stdout)));
  });
}

/**
 * Does `tasklist /APPS /FO CSV /NH` output list the desktop app's own executable? Each line reads
 * `"<image> (<app id>)","<pid>","<memory>","<package>"`; only an image ChatGPT.exe of an `OpenAI.Codex_…` package counts.
 */
export function codexAppIn(tasklistCsv: string): boolean {
  return /^"ChatGPT\.exe(?: \([^"\r\n]*\))?",[^\r\n]*,"OpenAI\.Codex_[^"\r\n]*"[ \t]*\r?$/im.test(tasklistCsv);
}

/**
 * Command lines of the running ChatGPT.exe processes: Win32_Process through PowerShell's Get-CimInstance, reading only
 * that one property (an entry is null when Windows does not give it, e.g. an elevated process). About 1-2 s here.
 * Fixed script text, no input of any kind. Null when the query failed or timed out.
 */
function chatgptCommandLines(): Promise<(string | null)[] | null> {
  const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ConvertTo-Json -Compress -InputObject @('
    + `Get-CimInstance -ClassName Win32_Process -Filter "Name='ChatGPT.exe'" -Property CommandLine | ForEach-Object { $_.CommandLine })`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const lines: unknown = JSON.parse(stdout);
        resolve(Array.isArray(lines) ? lines.map((l) => (typeof l === 'string' ? l : null)) : null);
      } catch { resolve(null); }
    });
  });
}

/**
 * Is an instance of the desktop app running that a `codex://` wake link goes to, so the link starts no new process?
 * Observed (docs/adapters/codex.md "唤醒链接交给哪个实例"): the app keeps its single-instance lock in a user-data folder
 * named after how it was started. Started from the Start menu or by a link, its main process runs the package's own
 * `app\ChatGPT.exe` and uses the folder `Codex`, the one a link is handed to; started through the execution alias
 * `chatgpt-desktop.exe`, it uses a folder of that name, and a link then starts a second, windowless instance. So only a
 * main process (no `--type=`) whose program is the package's `app\ChatGPT.exe` counts. Undocumented app behaviour.
 * shortcut: Windows only; elsewhere true (the wake link is never opened there anyway).
 */
export function codexWakeTargetRunning(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return chatgptCommandLines().then((lines) => (lines === null ? null : codexWakeTargetIn(lines)));
}

/** Does one of these ChatGPT.exe command lines belong to an app instance that wake links go to (see above)? */
export function codexWakeTargetIn(commandLines: readonly (string | null)[]): boolean {
  return commandLines.some((c) => typeof c === 'string'
    && /^\s*"?[A-Za-z]:\\[^"\r\n]*\\WindowsApps\\OpenAI\.Codex_[^\\"\r\n]*\\app\\ChatGPT\.exe(?:"|\s|$)/i.test(c)
    && !/\s--type=/i.test(c));
}

export function wakeUrl(threadId: string): string {
  if (!THREAD_ID_RE.test(threadId)) throw new Error(`not a Codex thread id: ${JSON.stringify(threadId)}`);
  return `codex://threads/wake/${threadId}`;
}

/**
 * A Windows EBUSY is evidence the file is held, so keep watching. An accessible file cannot prove the desktop app
 * uses this home; other errors and platforms cannot establish whether this turn is still running either.
 */
export function writerLockHeld(codexHome: string, threadId: string, opts: {
  platform?: NodeJS.Platform; read?: (path: string) => unknown;
} = {}): WriterLockState {
  if ((opts.platform ?? process.platform) !== 'win32') return { state: 'unknown', reason: 'writer lock checks are not supported on this platform' };
  try {
    (opts.read ?? readFileSync)(join(codexHome, 'thread-writer-locks', `${threadId}.lock`));
    return { state: 'unknown', reason: 'cannot verify that this writer lock belongs to the desktop app' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EBUSY') return { state: 'held' };
    return { state: 'unknown', reason: `writer lock check failed (${code ?? 'unknown error'})` };
  }
}

/** A counting semaphore: at most `n` holders; waiters are served in order and can give up through a signal. */
class Slots {
  private free: number;
  private readonly waiting: { go(): void; fail(e: Error): void }[] = [];
  constructor(n: number) { this.free = n; }
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (this.free > 0) { this.free--; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = {
        go: () => { signal?.removeEventListener('abort', onAbort); resolve(); },
        fail: (e: Error) => { signal?.removeEventListener('abort', onAbort); reject(e); },
      };
      const onAbort = () => { const i = this.waiting.indexOf(w); if (i >= 0) { this.waiting.splice(i, 1); reject(new Error('aborted')); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(w);
    });
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next.go(); else this.free++;
  }
  failAll(e: Error): void {
    for (const w of this.waiting.splice(0)) w.fail(e);
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('aborted')); return; }
  const done = () => { signal.removeEventListener('abort', onAbort); resolve(); };
  const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
  const t = setTimeout(done, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

/** The turn whose user message carries this delivery id, if it is among `turns`; and whether a later turn exists. */
function findTurn(turns: ObservedTurn[], deliveryId: string): { turn: ObservedTurn; newer: boolean } | null {
  // thread/turns/list is newest first, so anything before index i is a later turn.
  const i = turns.findIndex((t) => (t.items ?? []).some((it) => it.type === 'userMessage' && it.clientId === deliveryId));
  return i < 0 ? null : { turn: turns[i], newer: i > 0 };
}

export function createCodexNativeAdapter(opts: CodexNativeOptions = {}): NativeAdapter {
  const launch = opts.launch ?? launchNative;
  const codexHome = opts.codexHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
  const lockHeld = opts.lockHeld ?? ((threadId: string) => writerLockHeld(codexHome, threadId));
  const openWake = opts.openWake ?? openWakeLink;
  const pollMs = opts.pollMs ?? 3_000;
  const pickupTimeoutMs = opts.pickupTimeoutMs ?? 30 * 60_000;
  const vanishedPolls = opts.vanishedPolls ?? 3;
  const vanishedMs = opts.vanishedMs ?? 15_000;
  const opTimeoutMs = opts.opTimeoutMs ?? 60_000;
  const exitWaitMs = opts.exitWaitMs ?? 3_000;
  const initTimeoutMs = opts.initTimeoutMs ?? 120_000;
  const slots = new Slots(opts.maxProcesses ?? 3);
  const usage = createCodexUsage(codexHome);
  const usageRetryMs = opts.usageRetryMs ?? 1_000;
  const usageTries = opts.usageTries ?? 3;
  // The wake link launches the desktop app when it is not running, and orrery must never launch it. So a member counts
  // as online only while the app runs; "not known yet" counts as not running. isOnline answers from a cache that its
  // own calls refresh once it is older than appCheckMs, counted from when the answer arrived, and never while a check
  // runs. 10 s is the Hub's own status check interval (recheckMs, which calls confirmOnline): the cache is renewed that
  // often anyway, so a shorter age only added a tasklist run between two of the Hub's. A query that cannot answer (or
  // takes longer than appQueryTimeoutMs) is tried once more and then keeps the last known state, but never counts as
  // confirming the app runs.
  const appRunning = opts.appRunning ?? codexAppRunning;
  const wakeTarget = opts.wakeTarget ?? codexWakeTargetRunning;
  const appCheckMs = opts.appCheckMs ?? 10_000;
  const appQueryTimeoutMs = opts.appQueryTimeoutMs ?? 25_000;   // the queries' own limit (20 s) normally ends them first
  const bounded = (query: () => Promise<boolean | null>): Promise<boolean | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      (async () => query())().catch(() => null),   // a throw (even a synchronous one) is no answer
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), appQueryTimeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  };
  const appQuery = () => bounded(appRunning);
  // Wake-target checks are numbered like the app checks below: wakeSeq when a try starts, wakeNoSeq the newest try that
  // answered "no receiver". An older "yes" never outweighs a newer completed "no", from this delivery or another.
  let wakeSeq = 0;
  let wakeNoSeq = 0;
  /** Opening the wake link now starts no new app process: asked afresh before each wake, one retry, unknown = no. */
  const wakeSafe = async (): Promise<{ ok: boolean; seq: number }> => {
    let ok: boolean | null = null;
    let seq = 0;
    for (let tries = 0; tries < 2 && ok === null; tries++) {
      seq = ++wakeSeq;
      ok = await bounded(wakeTarget);
    }
    if (ok === false) wakeNoSeq = Math.max(wakeNoSeq, seq);
    return { ok: ok === true, seq };
  };
  let appUp = false;
  let appAt = -Infinity;   // when the newest completed check returned, including a failed check
  let appSeq = 0;          // a query's result never overwrites that of a query started after it
  let appSeen = 0;
  let appUnknownSeq = 0;   // an unanswered check can be newer than the last known state
  let appDownSeq = 0;      // the newest query that answered "not running"
  let appChecks = 0;
  let scheduledCheck: Promise<boolean | null> | null = null;
  const unknownApp = 'Could not confirm whether Codex is running: the process check did not answer';

  /** A new query, updating the cache. Null means the state is unknown; seq numbers the query that answered. */
  const appCheck = async (): Promise<{ up: boolean | null; seq: number }> => {
    appChecks++;
    let up: boolean | null = null;
    let seq = 0;
    // Each try is its own query, numbered when it starts: a retry is newer than a query that began during the first try.
    for (let tries = 0; tries < 2 && up === null; tries++) {
      seq = ++appSeq;
      up = await appQuery();
    }
    appChecks--;
    if (seq > Math.max(appSeen, appUnknownSeq)) appAt = Date.now();
    if (up === null) { appUnknownSeq = Math.max(appUnknownSeq, seq); return { up: null, seq }; }
    if (seq > appSeen) { appSeen = seq; appUp = up; }
    if (up === false) appDownSeq = Math.max(appDownSeq, seq);
    // "Running" from a query that a newer one has already contradicted is stale (e.g. two deliveries checking at once).
    return { up: up === true && appDownSeq < seq, seq };
  };
  const appFresh = async (): Promise<boolean | null> => (await appCheck()).up;

  // One synchronous burst (e.g. a Hub fan-out) can share a check. Start it after every caller has captured its pending
  // deliveries, then clear the slot before sampling: a later burst needs a new check of its own.
  const appCheckSoon = () => scheduledCheck ??= Promise.resolve().then(() => {
    scheduledCheck = null;
    return appFresh();
  });
  const appIsUp = (): boolean => {
    if (appChecks === 0 && Date.now() - appAt >= appCheckMs) void appCheckSoon();
    return appUp;
  };
  const live = new Set<() => void>();   // kill functions of the app-servers running now
  let closed = false;

  /** Runs `work` in a fresh app-server (experimental API on, for thread/queue/*), then lets the process exit. */
  /** `hooks`: notification and server-request handlers, and a longer time limit (only the init turn needs them). */
  const op = async <T>(work: (rpc: RpcPeer) => Promise<T>, signal?: AbortSignal, hooks: {
    onNotification?: (method: string, params: unknown) => void;
    onRequest?: (method: string, params: unknown) => unknown;
    onClose?: (reason: string) => void;
    timeoutMs?: number;
  } = {}): Promise<T> => {
    if (closed) throw new Error('codex native adapter is closed');
    await slots.acquire(signal);
    let proc: CodexProcess | null = null;
    let exited!: Promise<void>;
    let gone = false;
    // Never kill a process that already exited: on Windows its pid may already belong to something else.
    const kill = () => { if (!gone && proc) proc.kill(); };
    try {
      if (closed) throw new Error('codex native adapter is closed');
      // An abort that came while this call was getting its slot: do not start a process at all.
      if (signal?.aborted) throw new Error('aborted');
      proc = launch();
      live.add(kill);
      const rpc = new RpcPeer(proc.stdin, proc.stdout, {
        onNotification: (method, params) => hooks.onNotification?.(method, params),
        // Nothing orrery does here asks for approval; anything the server asks is refused.
        onRequest: async (method, params) => {
          if (hooks.onRequest) return hooks.onRequest(method, params);
          throw new Error(`orrery does not handle ${method}`);
        },
        onClose: (reason) => hooks.onClose?.(reason),
      });
      exited = new Promise<void>((resolve) => proc!.onExit((reason) => { gone = true; rpc.close(reason); resolve(); }));
      // A hung app-server or an abort ends every pending request of this operation at once.
      const life = AbortSignal.any([AbortSignal.timeout(hooks.timeoutMs ?? opTimeoutMs), ...(signal ? [signal] : [])]);
      const onEnd = () => rpc.close(signal?.aborted ? 'aborted' : 'codex app-server did not answer in time');
      life.addEventListener('abort', onEnd, { once: true });
      // An already-aborted signal never fires 'abort' again: without this check such an operation would wait forever.
      if (life.aborted) onEnd();
      try {
        await rpc.request('initialize', { clientInfo: { name: 'orrery', title: 'orrery', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
        rpc.notify('initialized');
        return await work(rpc);
      } finally {
        life.removeEventListener('abort', onEnd);
      }
    } finally {
      if (proc) {
        // Closing stdin makes app-server exit on its own (and release whatever it loaded); kill it if it does not.
        // The slot is freed only once the process is gone (or did not go even after a kill and a second wait), so
        // maxProcesses really bounds the processes alive.
        proc.stdin.end();
        const waitExit = async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([exited, new Promise<void>((r) => { timer = setTimeout(r, exitWaitMs); })]);
          clearTimeout(timer);
        };
        await waitExit();
        if (!gone) { kill(); await waitExit(); }
        live.delete(kill);
      }
      slots.release();
    }
  };

  const listThreads = (params: Record<string, unknown>, maxPages: number) => op(async (rpc) => {
    const out: CodexThread[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < maxPages; i++) {
      const res: { data: CodexThread[]; nextCursor: string | null } = await rpc.request('thread/list', { ...params, limit: LIST_PAGE, cursor });
      out.push(...res.data);
      if (!res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
    return out;
  });

  const turnsOf = async (rpc: RpcPeer, threadId: string) =>
    (await rpc.request<{ data: ObservedTurn[] }>('thread/turns/list', { threadId, limit: TURNS_PAGE })).data;

  const queuedOf = async (rpc: RpcPeer, threadId: string, deliveryId: string) => {
    const out: QueuedSubmission[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const res: { data: QueuedSubmission[]; nextCursor: string | null } = await rpc.request('thread/queue/list', { threadId, cursor });
      out.push(...res.data.filter((q) => q.clientUserMessageId === deliveryId));
      if (!res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
    return out;
  };

  /** Takes the delivery out of the queue if it is still there. Returns its turn when the app picked it up first. */
  const unqueue = (threadId: string, deliveryId: string) => op(async (rpc) => {
    for (const q of await queuedOf(rpc, threadId, deliveryId)) {
      await rpc.request('thread/queue/delete', { threadId, queuedSubmissionId: q.id });
    }
    return findTurn(await turnsOf(rpc, threadId), deliveryId);
  });

  const checkId = (threadId: string) => {
    if (!THREAD_ID_RE.test(threadId)) throw new Error(`not a Codex thread id: ${JSON.stringify(threadId)}`);
  };

  /** An ended turn's tokens from the thread's rollout file, if they show up within a few tries. Never throws. */
  const reportTurnTokens = async (threadId: string, turnId: string, report: (t: TokenTotals) => void, signal: AbortSignal) => {
    for (let i = 0; i < usageTries; i++) {
      try {
        if (!(await usage.rolloutOf(threadId))) return;   // no rollout file (another CODEX_HOME?): nothing to wait for
        const t = await usage.turnTokens(threadId, turnId);
        if (t) { report(t); return; }
        await sleep(usageRetryMs, signal);
      } catch {
        return;   // unreadable, or aborted: the delivery's outcome does not depend on it
      }
    }
  };

  return {
    harness: 'codex',

    async transcript(sessionId, request) {
      checkId(sessionId);
      return codexTranscript(codexHome, await usage.transcriptRolloutOf(sessionId), sessionId, request);
    },

    async listProjects(): Promise<ProjectInfo[]> {
      const byCwd = new Map<string, number>();
      for (const t of await listThreads({ sortKey: 'updated_at' }, PROJECT_PAGES)) byCwd.set(t.cwd, Math.max(byCwd.get(t.cwd) ?? 0, t.updatedAt));
      return [...byCwd].sort((a, b) => b[1] - a[1])
        .map(([path, at]) => ({ path, label: basename(path) || path, updatedAt: at ? new Date(at * 1000).toISOString() : null }));
    },

    async listSessions(projectPath: string): Promise<SessionInfo[]> {
      return (await listThreads({ cwd: projectPath, sortKey: 'updated_at' }, SESSION_PAGES)).map(toSessionInfo);
    },

    /** The desktop backend's own model picker list, so a new thread gets a model the app knows. */
    listModels: () => op(fetchModels),

    async attachSession(sessionId: string): Promise<SessionInfo> {
      checkId(sessionId);
      return op(async (rpc) => toSessionInfo((await rpc.request<{ thread: CodexThread }>('thread/read', { threadId: sessionId, includeTurns: false })).thread));
    },

    /**
     * A new thread with the user's own settings: no sandbox, approval or reviewer override. Without a chosen model or
     * effort it gets no turn: its first turn is the first delivery, run by the desktop app. With one, the same
     * short-lived app-server runs one init turn with them before exiting, because Codex saves a thread's model and
     * effort only with a turn (and the queue cannot carry them). Approvals during that turn are declined.
     */
    createSession({ cwd, title, model, effort, memberName }) {
      const init = Boolean(model || effort);
      // turn/completed may arrive before the turn/start answer names the turn, so every completion is kept.
      const completed = new Map<string, { status: string; error: { message: string } | null }>();
      let onCompleted: (() => void) | null = null;
      let onGone: ((reason: string) => void) | null = null;
      // The process can exit right after answering turn/start, before the waiter below exists: keep the reason.
      let closedReason: string | null = null;
      return op(async (rpc) => {
        const res = await rpc.request<{ thread: CodexThread; model: string | null }>('thread/start', {
          cwd,
          ...(model ? { model } : {}),
          ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
        });
        const threadId = res.thread.id;
        await rpc.request('thread/name/set', { threadId, name: title });
        if (init) {
          const input = initPrompt(title.replace(/^orrery: /, ''), memberName ?? 'codex');
          const started = await rpc.request<{ turn: { id: string } }>('turn/start', {
            threadId,
            input: [{ type: 'text', text: input, text_elements: [] }],
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          });
          const turnId = started.turn.id;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await new Promise<void>((resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`the init turn of the new Codex thread did not finish within ${Math.round(initTimeoutMs / 1000)} s`)), initTimeoutMs);
              onCompleted = () => { if (completed.has(turnId)) resolve(); };
              onGone = (reason) => reject(new Error(`the init turn of the new Codex thread did not finish: ${reason}`));
              onCompleted();
              if (closedReason !== null) onGone(closedReason);
            });
          } finally {
            clearTimeout(timer);
          }
          const t = completed.get(turnId)!;
          if (t.status !== 'completed') throw new Error(`the init turn of the new Codex thread ended ${t.status}${t.error ? `: ${t.error.message}` : ''}`);
        }
        return { sessionId: threadId, model: res.model ?? res.thread.model ?? null };
      }, undefined, init ? {
        timeoutMs: opTimeoutMs + initTimeoutMs,
        onNotification: (method, params) => {
          const p = params as { turn?: { id?: unknown; status?: unknown; error?: { message: string } | null } } | null;
          if (method !== 'turn/completed' || typeof p?.turn?.id !== 'string') return;
          completed.set(p.turn.id, { status: String(p.turn.status), error: p.turn.error ?? null });
          onCompleted?.();
        },
        onRequest: declineAll,
        onClose: (reason) => { closedReason ??= reason; onGone?.(reason); },
      } : {});
    },

    /**
     * Without refresh: the newest rate limits a rollout file recorded (Codex writes them after every model call; no
     * network). With refresh: ask account/rateLimits/read in a short-lived app-server (it asks OpenAI).
     */
    async quota({ refresh }) {
      if (!refresh) return usage.quotaFromRollouts();
      return fromAppServer(await op((rpc) => rpc.request('account/rateLimits/read', {})), new Date().toISOString());
    },

    conversationTokens: (threadId: string) => (THREAD_ID_RE.test(threadId) ? usage.threadTokens(threadId) : Promise.resolve(null)),

    isOnline: () => appIsUp(),
    // The cache above may be stale or not known yet; the Hub asks this before it gives a delivery up as offline.
    async confirmOnline() {
      const up = await appCheckSoon();
      if (up === null) throw new Error(unknownApp);
      return up;
    },

    async deliver(threadId: string, text: string, ctx: NativeDeliverContext): Promise<NativeDeliveryResult> {
      checkId(threadId);
      const { deliveryId, signal, onEvent } = ctx;
      let pickedUp = false;
      let vanished = false;   // absent from the observed queue: no item to take out
      let submitted = false;  // the queue may already have received this ID
      try {
        // The Hub lets deliver decide after an unanswered confirmation. Require a new answer before writing the queue.
        if (appUnknownSeq > appSeen) {
          const up = await appFresh();
          if (up === null) return { outcome: 'failed', error: `${unknownApp}; the delivery was not queued` };
          if (!up) return 'offline';
        }
        // Check whether the same delivery is already queued or has run. The queue is read first:
        // an item picked up between the two reads then shows up as a turn in the second. Best effort only: the app
        // may take an item off the queue a moment before its turn becomes visible, and then it is queued again.
        const found = await op(async (rpc) => {
          if ((await queuedOf(rpc, threadId, deliveryId)).length > 0) { submitted = true; return false; }
          if (findTurn(await turnsOf(rpc, threadId), deliveryId)) { submitted = true; return true; }
          submitted = true;   // a lost queue/add answer does not prove the request was rejected
          await rpc.request('thread/queue/add', { threadId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: deliveryId });
          return false;
        }, signal);
        // Queued now: ask the desktop app to wake the thread, whether or not it has it loaded already. Unloaded, the
        // app loads it; loaded, its backend runs the queue now instead of on its own timer. But the link would launch
        // an app that is not running: right before it, check again with a new query (never the cache or a query
        // already under way, which may predate the app closing). If the check does not confirm it runs, try to take the
        // message back out. It may already have been picked up. Accepted residual risk: the user closing the app in the
        // moment between this query and the link.
        // A running app is not enough: the link must go to an instance that is already there (wakeSafe), or Windows
        // starts a second one. Without such an instance (or an answer) the message just stays queued; an app that has
        // the thread loaded runs it on its own queue check (about 10 s), otherwise the pickup timeout applies as usual.
        // Both answers must still stand when the link opens: a check of either kind that started later and has already
        // answered "not running" (the app closed: withdraw as above) or "no receiver" (keep it queued) overrides them.
        if (!found) {
          const app = await appCheck();
          let up = app.up;
          if (up) {
            const wake = await wakeSafe();
            if (appDownSeq > app.seq) up = false;
            else if (wake.ok && wakeNoSeq < wake.seq) openWake(wakeUrl(threadId));
          }
          if (!up && !(await unqueue(threadId, deliveryId))) {
            const reason = up === null ? unknownApp : 'Codex closed after queueing';
            return { outcome: 'unknown', error: `${reason}; removal was attempted, but the message may still run` };
          }
        }

        // Idle time spent waiting for the pickup; time behind another running turn is not counted.
        let idleMs = 0;
        let lastPoll = Date.now();
        pickedUp = found;
        let misses = 0;
        let firstMissAt = 0;
        let runningPolls = 0;
        for (;;) {
          await sleep(runningPolls >= 3 ? 2 * pollMs : pollMs, signal);
          // Until its turn has been seen, also check that it is still queued: queue first, as in the dedupe above.
          const poll = await op(async (rpc) => {
            const queued = !pickedUp && (await queuedOf(rpc, threadId, deliveryId)).length > 0;
            const turns = await turnsOf(rpc, threadId);
            return { queued, seen: findTurn(turns, deliveryId), newest: turns[0] };
          }, signal);
          let seen = poll.seen;
          // The app runs the queue only between turns, so while another turn runs (a long one can take hours) the wait
          // does not use up the pickup budget. From another process a running turn reads as 'interrupted' (or
          // 'inProgress'); the held writer lock tells it apart from one that really was interrupted.
          const now = Date.now();
          const busy = !seen && !pickedUp && poll.queued && !!poll.newest
            && (poll.newest.status === 'inProgress' || (poll.newest.status === 'interrupted' && lockHeld(threadId).state === 'held'));
          ctx.waiting?.(seen || pickedUp ? null : { busy });
          if (!busy) idleMs += now - lastPoll;
          lastPoll = now;
          if (!seen && !pickedUp && idleMs > pickupTimeoutMs) {
            seen = await unqueue(threadId, deliveryId);
            if (!seen) throw new Error(`nobody picked the message up within ${Math.round(pickupTimeoutMs / 60_000)} min; queue removal was attempted and the result is unknown`);
          }
          if (!seen && !pickedUp) {
            if (poll.queued) misses = 0;
            else if (++misses === 1) firstMissAt = Date.now();
            if (misses >= vanishedPolls && Date.now() - firstMissAt >= vanishedMs) {
              vanished = true;
              throw new Error('the message left the Codex queue and no matching turn was found; it may still run');
            }
          }
          if (!seen) { runningPolls = 0; continue; }
          pickedUp = true;
          const { turn, newer } = seen;
          if (turn.status === 'completed') {
            for (const it of turn.items ?? []) {
              if (it.type === 'agentMessage' && it.text) onEvent({ type: 'text', text: it.text } satisfies AgentEvent);
            }
            if (ctx.usage) await reportTurnTokens(threadId, turn.id, ctx.usage, signal);
            return 'completed';
          }
          // A turn that ended without completing still spent tokens: report them too (docs/usage.md).
          if (turn.status === 'failed') {
            if (ctx.usage) await reportTurnTokens(threadId, turn.id, ctx.usage, signal);
            return { outcome: 'failed', error: `codex turn failed: ${turn.error?.message ?? 'unknown error'}` };
          }
          // Another process may report a running turn as interrupted. Only a newer turn confirms this one ended.
          if (turn.status === 'interrupted') {
            if (newer) {
              if (ctx.usage) await reportTurnTokens(threadId, turn.id, ctx.usage, signal);
              return { outcome: 'failed', error: `codex turn interrupted${turn.error ? `: ${turn.error.message}` : ''}` };
            }
            const lock = lockHeld(threadId);
            if (lock.state === 'unknown') return { outcome: 'unknown', error: `codex turn reports interrupted, but ${lock.reason}; it may still be running` };
            // shortcut: a held lock with no newer turn may keep the member busy indefinitely; add a bounded wait if needed.
          }
          runningPolls = turn.status === 'inProgress' || turn.status === 'interrupted' ? runningPolls + 1 : 0;
        }
      } catch (e) {
        // Aborted (cancel or Hub shutdown) or failed before the app took it: a message the Hub no longer counts as
        // in flight must not run later.
        let unqueueFailed = '';
        if (signal.aborted || (!pickedUp && !vanished)) {
          try {
            await unqueue(threadId, deliveryId);
          } catch (u) {
            unqueueFailed = `; taking it out of the Codex queue failed, so it may still run: ${u instanceof Error ? u.message : String(u)}`;
          }
        }
        const error = signal.aborted ? `delivery aborted${unqueueFailed}` : `${e instanceof Error ? e.message : String(e)}${unqueueFailed}`;
        if (submitted) return { outcome: 'unknown', error };
        throw new Error(error);
      }
    },

    async close() {
      closed = true;
      slots.failAll(new Error('codex native adapter is closed'));
      for (const kill of live) kill();
      live.clear();
    },
  };
}
