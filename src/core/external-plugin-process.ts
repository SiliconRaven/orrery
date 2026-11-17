// Newline-delimited JSON-RPC over owned stdio pipes. Process separation is fault containment, NOT an OS sandbox.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EXTERNAL_API_VERSION, object, type ExternalEventType, type ExternalInstallation } from './external-plugin-config.ts';

export const EXTERNAL_MAX_FRAME = 64 * 1024;
const MAX_PENDING = 16;
const MAX_QUEUED_EVENTS = 256;
export interface ExternalEvent { type: ExternalEventType; data: Record<string, unknown> }
export type ExternalState = 'disabled' | 'starting' | 'ready' | 'stopping' | 'failed' | 'stopped';
export type ExternalErrorCode = 'START_FAILED' | 'INITIALIZE_FAILED' | 'PROTOCOL_ERROR' | 'PROCESS_EXITED' | 'IO_ERROR' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'STOP_TIMEOUT';
type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Deliberately exclude Hub secrets and runtime injection variables (NODE_OPTIONS, NODE_PATH, etc.). */
export function externalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())));
}

export class ExternalPluginProcess {
  state: ExternalState = 'disabled';
  error: string | null = null;
  errorCode: ExternalErrorCode | null = null;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private serial = 0;
  private closing?: Promise<void>;
  private exited?: Promise<void>;
  private exitObserved = false;
  private rateWindow = 0;
  private rateCount = 0;
  private events: ExternalEvent[] = [];
  private droppedEvents = 0;
  private awaitingDrain = false;
  private readonly installation: ExternalInstallation;
  private readonly hostCall: (method: string, params: Record<string, unknown>) => unknown;
  private readonly timeoutMs: number;
  private readonly eventAllowed: (event: ExternalEvent) => boolean;

  /** `eventAllowed` is the last word on an event, asked right before it is written. Without one, nothing is delivered. */
  constructor(installation: ExternalInstallation, hostCall: (method: string, params: Record<string, unknown>) => unknown, timeoutMs = 5000,
    eventAllowed: (event: ExternalEvent) => boolean = () => false) {
    this.installation = installation;
    this.hostCall = hostCall;
    this.timeoutMs = timeoutMs;
    this.eventAllowed = eventAllowed;
  }

  async start(): Promise<void> {
    if (this.state !== 'disabled') return;
    this.state = 'starting';
    try {
      this.child = spawn(process.execPath, [this.installation.entry], {
        cwd: this.installation.directory, env: externalEnvironment(process.env), shell: false, windowsHide: true, stdio: 'pipe',
      });
      const child = this.child;
      // `close` waits for inherited pipes, possibly held by descendants after this direct child has exited.
      this.exited = new Promise((resolve) => {
        child.once('exit', () => {
          this.exitObserved = true;
          if (this.state !== 'stopping') this.fail('plugin process exited', 'PROCESS_EXITED');
          resolve();
        });
        child.once('error', () => {
          // A spawn failure has no owned process left to wait for. Other child errors are not exit evidence.
          if (!child.pid) { this.exitObserved = true; resolve(); }
        });
      });
      child.once('error', () => this.fail('plugin process could not start', 'START_FAILED'));
      child.stdin.on('error', () => { if (this.state !== 'stopped') this.fail('plugin input closed', 'IO_ERROR'); });
      child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
      // Drain, but do not reflect third-party stderr (which may contain secrets) into logs or HTTP responses.
      child.stderr.resume();
      const result = object(await this.request('initialize', {
        apiVersion: EXTERNAL_API_VERSION, pluginId: this.installation.manifest.id,
        permissions: this.installation.permissions, events: this.installation.events, clusterIds: this.installation.clusterIds,
        ...(this.installation.permissions.includes('messages.send') ? { writeClusterIds: this.installation.writeClusterIds } : {}),
      }));
      if (result.apiVersion !== EXTERNAL_API_VERSION) throw new Error('unsupported protocol');
      if (this.state === 'starting') this.state = 'ready';
    } catch { this.fail('plugin initialization failed', 'INITIALIZE_FAILED'); }
  }

  invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'ready') return Promise.reject(new Error(`plugin is ${this.state}`));
    if (!this.installation.manifest.commands.some((c) => c.id === command)) return Promise.reject(new Error('unknown plugin command'));
    return this.request('invoke', { command, arguments: args });
  }

  /** Fire and forget: never throws or waits, so a plugin that stops reading only ever loses its own oldest events. */
  pushEvent(event: ExternalEvent): void {
    if (this.state !== 'ready') return;
    if (this.events.push(event) > MAX_QUEUED_EVENTS) { this.events.shift(); this.droppedEvents++; }
    this.pumpEvents();
  }

  /** A throw here could reach the 'drain' callback, where nothing catches it and the Hub would crash. */
  private mayDeliver(event: ExternalEvent): boolean {
    try { return this.eventAllowed(event); } catch { return false; }
  }

  private pumpEvents(): void {
    const stdin = this.child?.stdin;
    if (this.state !== 'ready' || !stdin || stdin.destroyed || this.awaitingDrain) return;
    // Stopping at the stream's high-water mark keeps most of write()'s 256 KiB input limit free for requests.
    while (this.events.length && !stdin.writableNeedDrain) {
      const event = this.events.shift()!;
      // Authorization can end while an event waits behind a slow reader; once written it cannot be recalled.
      if (!this.mayDeliver(event)) { this.droppedEvents++; continue; }
      const line = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: this.droppedEvents ? { ...event, dropped: this.droppedEvents } : event }) + '\n';
      if (Buffer.byteLength(line) > EXTERNAL_MAX_FRAME) { this.droppedEvents++; continue; }
      this.droppedEvents = 0;
      stdin.write(line);
    }
    if (this.events.length) {
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

  private request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('too many pending plugin calls'));
    const id = `hub-${++this.serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('plugin request timed out', 'TIMEOUT'), timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
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
    if (message.jsonrpc !== '2.0' || typeof message.id !== 'string' || !message.id || message.id.length > 128) throw new Error('invalid JSON-RPC envelope');
    const id = message.id;
    if (typeof message.method === 'string') {
      if ('result' in message || 'error' in message) throw new Error('invalid request');
      try {
        if (this.state !== 'ready') throw new Error('plugin is not ready');
        const result = this.hostCall(message.method, object(message.params ?? {}));
        this.write({ jsonrpc: '2.0', id, result });
      } catch {
        // No exception text from the database, OS or host internals crosses this boundary.
        this.write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'host request denied or invalid' } });
      }
      return;
    }
    const pending = this.pending.get(id);
    if (!pending || ('result' in message) === ('error' in message)) throw new Error('unexpected response');
    if (pending.method === 'initialize' && 'result' in message) {
      if (object(message.result).apiVersion !== EXTERNAL_API_VERSION) throw new Error('unsupported protocol');
      // The next frame may be a host request in this same chunk, before start() resumes its await.
      if (this.state === 'starting') this.state = 'ready';
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if ('error' in message) pending.reject(new Error('plugin command failed'));
    else pending.resolve(message.result);
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.pending.clear();
  }
  private destroyPipes(): void {
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
  }
  private fail(reason: string, code: ExternalErrorCode = 'PROTOCOL_ERROR'): void {
    if (this.inactive()) return;
    this.state = 'failed';
    this.error = reason;
    this.errorCode = code;
    this.buffer = Buffer.alloc(0);
    this.events = [];
    this.rejectPending(reason);
    this.destroyPipes();
    this.child?.kill('SIGKILL');
  }

  /** Bounded shutdown of the process we own. Plugins are responsible for any descendants they create. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.events = [];
      if (this.state === 'ready') {
        this.state = 'stopping';
        try { await this.request('shutdown', {}, 300); } catch { /* force termination below */ }
      }
      this.state = 'stopping';
      this.rejectPending('plugin stopped');
      this.buffer = Buffer.alloc(0);
      this.destroyPipes();
      this.child?.kill('SIGKILL');
      if (this.exited) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
        clearTimeout(timer);
      }
      if (!this.child || this.exitObserved) this.state = 'stopped';
      else {
        this.state = 'failed';
        this.error = 'plugin stop requested but process exit was not observed';
        this.errorCode = 'STOP_TIMEOUT';
      }
    })();
    return this.closing;
  }
}
