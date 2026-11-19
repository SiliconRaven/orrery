// Newline-delimited JSON-RPC over owned stdio pipes. Process separation is fault containment, NOT an OS sandbox.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EXTERNAL_API_VERSION, object, type ExternalInstallation } from './external-plugin-config.ts';

export const EXTERNAL_MAX_FRAME = 64 * 1024;
/**
 * Requests to one plugin waiting for an answer: at most MAX_PENDING in all, and at most MAX_OTHER_PENDING that are not
 * message checks (invokes, command runs, tool calls). So message checks always have MAX_PENDING - MAX_OTHER_PENDING (8)
 * slots of their own, however busy the plugin is otherwise; a ninth check at the same moment may still find none
 * (then it counts as not answering: fail-open, recorded).
 */
const MAX_PENDING = 16;
const MAX_OTHER_PENDING = 8;
const MAX_QUEUED_EVENTS = 256;
/** The plugin cannot take this request now (a pending cap is full); nothing was written to it. */
class PluginBusy extends Error {
  constructor() { super('too many pending plugin calls'); }
}
/**
 * The longest a member's send waits for one gate plugin's answer (all holders are asked at once, so also for all of
 * them). Long enough for a local process that answers from memory, short enough that a hung one barely delays the
 * cluster; without an answer in time the send goes through (fail-open, docs/external-plugins.md).
 */
const MESSAGE_CHECK_TIMEOUT_MS = 1500;
/**
 * A single late check answer (a GC pause, a disk hiccup) must not switch a referee off for the rest of the session, so
 * a check timeout lets that one message through and keeps the plugin. This many in a row, with no answer in between,
 * means it is not answering at all: it is stopped like any other timed-out plugin, so it stops delaying every send.
 */
const MAX_CHECK_TIMEOUTS = 3;
/** Requests whose timeout ends only that request (message.check, tool.call, ui.request): a late answer is told apart by its id. */
const EXPIRING_ID = /^hub-(?:check|tool|ui)-(\d+)$/;
/** `clusterId`: the cluster the Hub checked it for, sent next to `data`; absent or null for a global event. */
export interface ExternalEvent { type: string; clusterId?: string | null; data: Record<string, unknown> }
/**
 * Hub → plugin notifications besides `event`. A plugin gets one only if its initialize result lists it in
 * `notifications`: an older plugin that answers every unknown method (or crashes on one) never sees them.
 */
const EXTERNAL_NOTIFICATIONS = ['message.check.result', 'writeSettings.changed', 'command.cancel'] as const;
type ExternalNotification = typeof EXTERNAL_NOTIFICATIONS[number];
/**
 * Plugin → Hub notifications (no `id`, never answered): a run's progress and end (external-plugin-commands.ts). Any other
 * frame without an id is still a protocol error. Malformed params are dropped there, quietly.
 */
const PLUGIN_NOTIFICATIONS: ReadonlySet<string> = new Set(['command.progress', 'command.done', 'config.errors']);
/** What the owner hears from the process besides host calls: run notifications, and the moment it stops serving. */
export interface ProcessHooks {
  notification?(method: string, params: unknown): void;
  /** The process left `ready`/`starting` for good (failed, or stopping); called once. */
  inactive?(): void;
  /** `state`, `error` or `errorCode` changed. */
  changed?(): void;
  /**
   * It failed on its own (crash, protocol error, timeout, CHECK_TIMEOUT, a failed start), not as part of a stop the owner
   * asked for with close(); called once, after state, error and errorCode are set.
   */
  failed?(): void;
}
/**
 * How long a stop waits for the plugin's `shutdown` answer before it kills the process, when the manifest does not say
 * (`shutdownGraceMs`, at most SHUTDOWN_GRACE_LIMITS.max). Long enough to write a small snapshot; a plugin that needs
 * longer asks for it in its manifest.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5000;
/** After the kill, how long a stop waits to see the direct child exit before it reports STOP_TIMEOUT. */
export const EXIT_WAIT_MS = 1000;
/** A plugin call (initialize, invoke) without an answer in this long fails the plugin (TIMEOUT). */
export const DEFAULT_CALL_TIMEOUT_MS = 5000;
/**
 * One frame waiting behind a slow reader: an event, or an opted-in notification. A notification's `allowed`, like
 * eventAllowed for an event, is asked right before it is written (e.g. its cluster is still granted and not deleted).
 */
type Outgoing = { event: ExternalEvent } | { method: ExternalNotification; params: Record<string, unknown>; allowed?: () => boolean };

/** A refused host call with a stable code the plugin sees as `error.data.code`; the message stays the generic one. */
export class HostRefusal extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export type ExternalState = 'disabled' | 'starting' | 'ready' | 'stopping' | 'failed' | 'stopped';
export type ExternalErrorCode = 'START_FAILED' | 'INITIALIZE_FAILED' | 'PROTOCOL_ERROR' | 'PROCESS_EXITED' | 'IO_ERROR' | 'TIMEOUT' | 'CHECK_TIMEOUT' | 'OUTPUT_LIMIT' | 'STOP_TIMEOUT';
type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Deliberately exclude Hub secrets and runtime injection variables (NODE_OPTIONS, NODE_PATH, etc.). */
export function externalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())));
}

/** A message.check that was not answered in time; the plugin is still running unless the code says otherwise. */
/** Starts a plugin's direct child process; tests pass one that returns a stand-in (an exit that is never seen, say). */
export type SpawnPlugin = (entry: string, directory: string) => ChildProcessWithoutNullStreams;
const spawnPlugin: SpawnPlugin = (entry, directory) => spawn(process.execPath, [entry], {
  cwd: directory, env: externalEnvironment(process.env), shell: false, windowsHide: true, stdio: 'pipe',
});

export class CheckTimeout extends Error {
  constructor() { super('message check timed out'); }
}

/** A tool.call that was not answered in time; the plugin keeps running and its late answer is dropped. */
export class ToolTimeout extends Error {
  constructor() { super('tool call timed out'); }
}

/** A ui.request that was not answered in time; like ToolTimeout, only that request ends. */
export class UiTimeout extends Error {
  constructor() { super('ui request timed out'); }
}

/**
 * The plugin answered a request with a JSON-RPC error. The message stays the generic one for every caller; `detail` is
 * the plugin's own `error.message` (a string, else ''), which only a tool call passes on, cleaned and short.
 */
export class PluginAnswerError extends Error {
  readonly detail: string;
  constructor(detail: unknown) { super('plugin command failed'); this.detail = typeof detail === 'string' ? detail : ''; }
}

/** A lifecycle stop interrupted this request before the plugin answered. */
export class PluginStopping extends Error {}

function initializeParams(installation: ExternalInstallation, extras: Record<string, unknown>) {
  return { apiVersion: EXTERNAL_API_VERSION, pluginId: installation.manifest.id, permissions: installation.permissions,
    events: installation.events, clusterIds: installation.clusterIds,
    ...(installation.permissions.includes('messages.send') ? { writeClusterIds: installation.writeClusterIds } : {}), ...extras };
}

/** A fresh process starts with hub-1. Check the whole outgoing frame before committing new configuration. */
export function fitsPluginInitialize(installation: ExternalInstallation, extras: Record<string, unknown>): boolean {
  const frame = { jsonrpc: '2.0', id: 'hub-1', method: 'initialize', params: initializeParams(installation, extras) };
  return Buffer.byteLength(JSON.stringify(frame)) + 1 <= EXTERNAL_MAX_FRAME;
}

export class ExternalPluginProcess {
  state: ExternalState = 'disabled';
  error: string | null = null;
  errorCode: ExternalErrorCode | null = null;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private serial = 0;
  private checkTimeouts = 0;   // message.check timeouts since the plugin last answered one
  private closing?: Promise<void>;
  /** When the `shutdown` request went out and when its wait ends (0: none sent). */
  private shutdownSince = 0;
  private shutdownUntil = 0;
  private exited?: Promise<void>;
  private exitObserved = false;
  /** The Hub sent the kill (a failure or the end of a stop): an exit after it is ours, not the plugin's. */
  private killedByUs = false;
  private shutdownAnswered = false;
  /** The plugin exited on its own with a non-zero code (or a signal) during a stop, before answering shutdown. */
  shutdownTrouble: string | null = null;
  private readonly spawnChild: SpawnPlugin;
  private rateWindow = 0;
  private rateCount = 0;
  private events: Outgoing[] = [];
  private readonly configChanges = new Map<string | null, () => Record<string, unknown> | null>();
  private droppedEvents = 0;
  private awaitingDrain = false;
  /** The notifications the plugin's initialize result asked for (EXTERNAL_NOTIFICATIONS only). */
  private accepts = new Set<string>();
  private readonly installation: ExternalInstallation;
  private readonly hostCall: (method: string, params: unknown) => unknown;
  private readonly timeoutMs: number;
  private readonly eventAllowed: (event: ExternalEvent) => boolean;
  private readonly initializeExtras: () => Record<string, unknown>;
  private readonly hooks: ProcessHooks;
  /** The bound on waiting for the `shutdown` answer (the manifest's shutdownGraceMs, or the owner's default). */
  readonly shutdownGraceMs: number;
  private ended = false;

  /**
   * `eventAllowed` is the last word on an event, asked right before it is written. Without one, nothing is delivered.
   * `initializeExtras`: more initialize params, read when the request is sent (e.g. the effective write settings).
   * `hostCall` gets the request's params as sent (`{}` when absent or null): it checks their shape itself, so a call
   * with a stable-code contract can refuse a missing permission before it looks at the params.
   */
  constructor(installation: ExternalInstallation, hostCall: (method: string, params: unknown) => unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    eventAllowed: (event: ExternalEvent) => boolean = () => false, initializeExtras: () => Record<string, unknown> = () => ({}),
    hooks: ProcessHooks = {}, shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS, spawnChild: SpawnPlugin = spawnPlugin) {
    this.spawnChild = spawnChild;
    this.installation = installation;
    this.hostCall = hostCall;
    this.timeoutMs = timeoutMs;
    this.eventAllowed = eventAllowed;
    this.initializeExtras = initializeExtras;
    this.hooks = hooks;
    this.shutdownGraceMs = installation.manifest.shutdownGraceMs ?? shutdownGraceMs;
  }

  /** Whether the plugin asked for this notification at initialize. */
  wants(method: ExternalNotification): boolean { return this.accepts.has(method); }

  private setState(state: ExternalState): void {
    if (this.state === state) return;
    this.state = state;
    this.tell();
    if (state === 'ready' && this.configChanges.size) this.pumpEvents();
  }
  private tell(): void {
    try { this.hooks.changed?.(); } catch { /* the owner's bookkeeping must not change the process */ }
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.configChanges.clear();
    try { this.hooks.inactive?.(); } catch { /* the owner's bookkeeping must not stop the shutdown */ }
  }

  async start(): Promise<void> {
    if (this.state !== 'disabled' || this.closing) return;
    this.setState('starting');
    try {
      this.child = this.spawnChild(this.installation.entry, this.installation.directory);
      const child = this.child;
      // `close` waits for inherited pipes, possibly held by descendants after this direct child has exited.
      this.exited = new Promise((resolve) => {
        child.once('exit', (code: number | null, signal: string | null) => {
          this.exitObserved = true;
          if (this.closing) {
            // During a stop the owner asked for, exiting is the stop: the wait for the shutdown answer ends at once and
            // the state stays clean. A non-zero exit before the answer is kept as a note (its snapshot may be partial).
            if (!this.killedByUs && !this.shutdownAnswered && code !== 0) {
              this.shutdownTrouble = code !== null ? `plugin exited with code ${code} during shutdown` : `plugin ended by ${signal ?? 'a signal'} during shutdown`;
            }
            this.rejectPending(new Error('plugin process exited'));
            // Seen only after the stop gave up waiting (STOP_TIMEOUT): it is gone now, so a new start may follow.
            if (this.errorCode === 'STOP_TIMEOUT') { this.state = 'stopped'; this.error = null; this.errorCode = null; this.tell(); }
          } else this.fail('plugin process exited', 'PROCESS_EXITED');
          resolve();
        });
        child.once('error', () => {
          // A spawn failure has no owned process left to wait for. Other child errors are not exit evidence.
          if (!child.pid) { this.exitObserved = true; resolve(); }
        });
      });
      child.once('error', () => this.fail('plugin process could not start', 'START_FAILED'));
      // A pipe that breaks during a stop (the plugin exited on `shutdown`) is part of the stop; its exit settles the wait.
      child.stdin.on('error', () => { if (!this.closing) this.fail('plugin input closed', 'IO_ERROR'); });
      child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
      // Drain, but do not reflect third-party stderr (which may contain secrets) into logs or HTTP responses.
      child.stderr.resume();
      const result = object(await this.request('initialize', initializeParams(this.installation, this.initializeExtras())));
      if (result.apiVersion !== EXTERNAL_API_VERSION) throw new Error('unsupported protocol');
      if ((this.state as ExternalState) === 'starting') this.setState('ready');   // the await may have changed it
    } catch {
      // A stop during the start rejected initialize: that is the stop, not a failure of the plugin.
      if (!this.closing) this.fail('plugin initialization failed', 'INITIALIZE_FAILED');
    }
  }

  /** `context`: who ran it, where and its runId, for a command the user ran from a cluster; absent on the old HTTP route. */
  invoke(command: string, args: Record<string, unknown>, context?: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'ready') return Promise.reject(new Error(`plugin is ${this.state}`));
    if (!this.installation.manifest.commands.some((c) => c.id === command)) return Promise.reject(new Error('unknown plugin command'));
    return this.request('invoke', { command, arguments: args, ...(context ? { context } : {}) });
  }

  /**
   * A member's send waits on this (messages.gate), so it has its own short timeout. Unlike other requests, a timeout
   * only rejects this call (CheckTimeout) and frees its pending slot; the late answer is dropped quietly when it comes
   * (receiveMessage). MAX_CHECK_TIMEOUTS in a row stop the plugin (CHECK_TIMEOUT). An answer in time, even an error, resets the count.
   */
  check(params: Record<string, unknown>, sent?: () => void): Promise<unknown> {
    if (this.state !== 'ready') return Promise.reject(new Error(`plugin is ${this.state}`));
    return this.request('message.check', params, MESSAGE_CHECK_TIMEOUT_MS, (id, pending) => {
      this.pending.delete(id);
      pending.reject(new CheckTimeout());
      if (++this.checkTimeouts >= MAX_CHECK_TIMEOUTS) this.fail(`plugin did not answer ${MAX_CHECK_TIMEOUTS} message checks in a row`, 'CHECK_TIMEOUT');
    }, sent, 'check');
  }

  /**
   * A member's call of one of the plugin's tools (docs/external-plugins.md「群员工具」). Like a message check, a timeout
   * ends only this call (ToolTimeout) and frees its pending slot at once; the late answer is dropped when it comes. It
   * never fails or stops the plugin. A stop settles it at once like any pending request (PluginStopping). `sent` is
   * called (synchronously) once the request was written; a rejection without it means the plugin never got the call.
   */
  toolCall(params: Record<string, unknown>, timeoutMs: number, sent: () => void): Promise<unknown> {
    if (this.state !== 'ready') return Promise.reject(new Error(`plugin is ${this.state}`));
    return this.request('tool.call', params, timeoutMs, (id, pending) => {
      this.pending.delete(id);
      pending.reject(new ToolTimeout());
    }, sent, 'tool');
  }

  /**
   * A request from the plugin's own web UI (docs/external-plugins.md「网页界面」), handled like a tool call: a timeout ends
   * only this request (UiTimeout) and frees its slot, the late answer is dropped, a stop settles it (PluginStopping).
   * `sent` is called once the request was written.
   */
  uiRequest(params: Record<string, unknown>, timeoutMs: number, sent: () => void): Promise<unknown> {
    if (this.state !== 'ready') return Promise.reject(new Error(`plugin is ${this.state}`));
    return this.request('ui.request', params, timeoutMs, (id, pending) => {
      this.pending.delete(id);
      pending.reject(new UiTimeout());
    }, sent, 'ui');
  }

  /** Requests of this method still waiting for an answer (a timeout or a stop removes them at once). */
  inFlight(method: 'tool.call' | 'ui.request'): number {
    let n = 0;
    for (const pending of this.pending.values()) if (pending.method === method) n++;
    return n;
  }

  /** Fire and forget: never throws or waits, so a plugin that stops reading only ever loses its own oldest events. */
  pushEvent(event: ExternalEvent): void { this.enqueue({ event }); }

  /** A manifest declaration opts into preferences. Keep the latest update per scope across initialize and backpressure. */
  configChanged(clusterId: string | null, read: () => Record<string, unknown> | null): void {
    if (!this.installation.manifest.config?.length || (this.state !== 'ready' && this.state !== 'starting')) return;
    this.configChanges.set(clusterId, read);
    this.pumpEvents();
  }

  /** As pushEvent, in the same queue and order; dropped unless the plugin opted in to this method at initialize. */
  pushNotification(method: ExternalNotification, params: Record<string, unknown>, allowed?: () => boolean): void {
    if (this.accepts.has(method)) this.enqueue({ method, params, ...(allowed ? { allowed } : {}) });
  }

  private enqueue(item: Outgoing): void {
    if (this.state !== 'ready') return;
    if (this.events.push(item) > MAX_QUEUED_EVENTS) { this.events.shift(); this.droppedEvents++; }
    this.pumpEvents();
  }

  /** A throw here could reach the 'drain' callback, where nothing catches it and the Hub would crash. */
  private mayDeliver(event: ExternalEvent): boolean {
    try { return this.eventAllowed(event); } catch { return false; }
  }

  private pumpEvents(): void {
    const stdin = this.child?.stdin;
    if (this.state !== 'ready' || !stdin || stdin.destroyed || this.awaitingDrain) return;
    for (const [scope, read] of this.configChanges) {
      if (stdin.writableNeedDrain) break;
      this.configChanges.delete(scope);
      try {
        const params = read();
        if (params) this.write({ jsonrpc: '2.0', method: 'config.changed', params });
      } catch { this.fail('plugin configuration could not be delivered', 'IO_ERROR'); return; }
    }
    // Stopping at the stream's high-water mark keeps most of write()'s 256 KiB input limit free for requests.
    while (this.events.length && !stdin.writableNeedDrain) {
      const item = this.events.shift()!;
      if (!('event' in item)) {
        let allowed = true;
        try { allowed = item.allowed?.() ?? true; } catch { allowed = false; }
        if (!allowed) { this.droppedEvents++; continue; }
        // `dropped` rides on notifications too: a gate plugin without events.read gets no events to carry it.
        const params = { ...item.params, ...(this.droppedEvents ? { dropped: this.droppedEvents } : {}) };
        const line = JSON.stringify({ jsonrpc: '2.0', method: item.method, params }) + '\n';
        if (Buffer.byteLength(line) > EXTERNAL_MAX_FRAME) { this.droppedEvents++; continue; }
        this.droppedEvents = 0;
        stdin.write(line);
        continue;
      }
      const { event } = item;
      // Authorization can end while an event waits behind a slow reader; once written it cannot be recalled.
      if (!this.mayDeliver(event)) { this.droppedEvents++; continue; }
      const params = { type: event.type, ...(event.clusterId ? { clusterId: event.clusterId } : {}), data: event.data,
        ...(this.droppedEvents ? { dropped: this.droppedEvents } : {}) };
      const line = JSON.stringify({ jsonrpc: '2.0', method: 'event', params }) + '\n';
      if (Buffer.byteLength(line) > EXTERNAL_MAX_FRAME) { this.droppedEvents++; continue; }
      this.droppedEvents = 0;
      stdin.write(line);
    }
    if (this.events.length || this.configChanges.size) {
      this.awaitingDrain = true;
      stdin.once('drain', () => { this.awaitingDrain = false; this.pumpEvents(); });
    }
  }

  private write(message: unknown): void {
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > EXTERNAL_MAX_FRAME) throw new Error('plugin frame exceeds 64 KiB');
    if (!this.child || this.child.stdin.destroyed) throw new Error('plugin input closed');
    if (this.child.stdin.writableLength + Buffer.byteLength(line) > EXTERNAL_MAX_FRAME * 4) throw new Error('plugin input backpressure limit exceeded');
    this.child.stdin.write(line);
  }

  /**
   * `expire`: what a timeout does instead of failing the plugin (message.check and tool.call have one; `kind` names it
   * in the id). `sent`: called once the request was written to the plugin (not when it was refused before that).
   */
  private request(method: string, params: unknown, timeoutMs = this.timeoutMs, expire?: (id: string, pending: Pending) => void,
    sent?: () => void, kind?: 'check' | 'tool' | 'ui'): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new PluginBusy());
    if (method !== 'message.check') {
      let others = 0;
      for (const pending of this.pending.values()) if (pending.method !== 'message.check') others++;
      if (others >= MAX_OTHER_PENDING) return Promise.reject(new PluginBusy());
    }
    // Expiring ids carry their kind, so a late answer to any such request the Hub ever sent can be told from a stray response.
    const id = `hub-${kind ? `${kind}-` : ''}${++this.serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (expire && pending) expire(id, pending); else this.fail('plugin request timed out', 'TIMEOUT');
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
        return;
      }
      sent?.();
    });
  }

  private inactive(): boolean { return this.state === 'failed' || this.state === 'stopped'; }

  private receive(chunk: Buffer): void {
    if (this.inactive()) return;
    // Bound even an unterminated line; consume each frame without retaining an arbitrary stdout backlog.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      if (this.buffer.length + part.length > EXTERNAL_MAX_FRAME) { this.fail('plugin output frame exceeds 64 KiB', 'OUTPUT_LIMIT'); return; }
      this.buffer = Buffer.concat([this.buffer, part]);
      offset = end;
      if (newline < 0) return;
      const frame = this.buffer;
      this.buffer = Buffer.alloc(0);
      try {
        const now = Date.now();
        if (now - this.rateWindow >= 1000) { this.rateWindow = now; this.rateCount = 0; }
        if (++this.rateCount > 200) throw new Error('too many frames');
        this.receiveMessage(object(JSON.parse(frame.toString('utf8'))));
      } catch { this.fail('invalid plugin protocol or output rate exceeded'); return; }
      if (this.inactive()) return;
    }
  }

  private receiveMessage(message: Record<string, unknown>): void {
    if (message.jsonrpc === '2.0' && message.id === undefined && typeof message.method === 'string' && PLUGIN_NOTIFICATIONS.has(message.method)
      && !('result' in message) && !('error' in message)) {
      // Never answered; a notification before ready, or one the owner cannot use, is dropped like a late answer.
      if (this.state === 'ready') {
        try { this.hooks.notification?.(message.method, message.params); } catch { /* dropped */ }
      }
      return;
    }
    if (message.jsonrpc !== '2.0' || typeof message.id !== 'string' || !message.id || message.id.length > 128) throw new Error('invalid JSON-RPC envelope');
    const id = message.id;
    if (typeof message.method === 'string') {
      if ('result' in message || 'error' in message) throw new Error('invalid request');
      try {
        if (this.state !== 'ready') throw new Error('plugin is not ready');
        const result = this.hostCall(message.method, message.params ?? {});
        this.write({ jsonrpc: '2.0', id, result });
      } catch (error) {
        // No exception text from the database, OS or host internals crosses this boundary: only a HostRefusal's own code.
        this.write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'host request denied or invalid',
          ...(error instanceof HostRefusal ? { data: { code: error.code } } : {}) } });
      }
      return;
    }
    const pending = this.pending.get(id);
    // During a stop, an answer to a request that the stop already ended is late, not a protocol error: dropped.
    if (!pending && this.closing && ('result' in message) !== ('error' in message) && /^hub-/.test(id)) return;
    const expiring = EXPIRING_ID.exec(id);
    // A check or tool call the Hub sent and already gave up on (timed out): its late answer is dropped, without memory per id.
    if (!pending && expiring && Number(expiring[1]) <= this.serial && ('result' in message) !== ('error' in message)) {
      return;   // a late check answer does not reset the count: always answering late costs every send the full wait
    }
    if (!pending || ('result' in message) === ('error' in message)) throw new Error('unexpected response');
    if (pending.method === 'message.check') this.checkTimeouts = 0;
    if (pending.method === 'shutdown') this.shutdownAnswered = true;
    if (pending.method === 'initialize' && 'result' in message) {
      const result = object(message.result);
      if (result.apiVersion !== EXTERNAL_API_VERSION) throw new Error('unsupported protocol');
      // Opt-in; unknown names and anything that is not an array of strings are ignored (a later Hub may offer more).
      if (Array.isArray(result.notifications)) {
        this.accepts = new Set(EXTERNAL_NOTIFICATIONS.filter((name) => (result.notifications as unknown[]).includes(name)));
      }
      // The next frame may be a host request in this same chunk, before start() resumes its await.
      if (this.state === 'starting') this.setState('ready');
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if ('error' in message) {
      const error = message.error;
      pending.reject(new PluginAnswerError(error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined));
    } else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private destroyPipes(): void {
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
  }
  private fail(reason: string, code: ExternalErrorCode = 'PROTOCOL_ERROR'): void {
    if (this.inactive()) return;
    const own = !this.closing;   // during a stop the owner asked for, a failure is part of that stop
    this.state = 'failed';
    this.error = reason;
    this.errorCode = code;
    this.buffer = Buffer.alloc(0);
    this.events = [];
    this.end();
    this.rejectPending(new Error(reason));
    this.destroyPipes();
    this.killedByUs = true;
    this.child?.kill('SIGKILL');
    this.tell();
    if (own) {
      try { this.hooks.failed?.(); } catch { /* the owner's restart bookkeeping must not change the failure */ }
    }
  }

  /**
   * Bounded shutdown of the process we own: `shutdown`, then up to shutdownGraceMs for its answer (the plugin finishes
   * its work before it answers), then the kill and up to EXIT_WAIT_MS to see the exit. Plugins are responsible for any
   * descendants they create. Called again, it returns the same promise.
   */
  close(graceMs = this.shutdownGraceMs): Promise<void> {
    if (this.closing) { this.shortenGrace(graceMs); return this.closing; }
    this.closing = (async () => {
      this.events = [];
      this.end();
      if (this.state === 'ready') {
        this.setState('stopping');
        // `shutdown` gets its own wait: requests already out (an invoke, a message.check) end now for their callers
        // (`plugin is stopping`), so none of their timers can end the grace early; their late answers are dropped.
        this.rejectPending(new PluginStopping('plugin is stopping'));
        this.shutdownSince = Date.now();
        this.shutdownUntil = this.shutdownSince + graceMs;
        try { await this.request('shutdown', {}, graceMs); } catch { /* force termination below */ }
      }
      this.setState('stopping');
      this.rejectPending(new Error('plugin stopped'));
      this.buffer = Buffer.alloc(0);
      this.destroyPipes();
      this.killedByUs = true;
      this.child?.kill('SIGKILL');
      if (this.exited) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_WAIT_MS); })]);
        clearTimeout(timer);
      }
      if (!this.child || this.exitObserved) this.setState('stopped');
      else {
        this.state = 'failed';
        this.error = 'plugin stop requested but process exit was not observed';
        this.errorCode = 'STOP_TIMEOUT';
        this.tell();
      }
    })();
    return this.closing;
  }

  /**
   * A stop already waiting for the `shutdown` answer gets a shorter grace (the Hub's close caps every plugin's grace,
   * also one a user's stop started with a longer one): the wait now ends `graceMs` after it began, if that is sooner.
   */
  private shortenGrace(graceMs: number): void {
    const until = this.shutdownSince + graceMs;
    if (!this.shutdownSince || until >= this.shutdownUntil) return;
    this.shutdownUntil = until;
    for (const [id, pending] of this.pending) {
      if (pending.method !== 'shutdown') continue;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => { if (this.pending.get(id) === pending) this.fail('plugin request timed out', 'TIMEOUT'); }, Math.max(0, until - Date.now()));
    }
  }

  /** The direct child was started and its exit has not been seen: a new instance must not start next to it. */
  get exitPending(): boolean { return !!this.child?.pid && !this.exitObserved; }
}
