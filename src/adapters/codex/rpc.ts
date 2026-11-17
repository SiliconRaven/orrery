// JSON-RPC over stdio for `codex app-server`: one JSON object per line, both directions. app-server omits "jsonrpc"
// on what it sends; we send it anyway (it is accepted). Used by the native Codex adapter.
import type { Readable, Writable } from 'node:stream';

export type RpcId = string | number;

export interface RpcError { code: number; message: string; data?: unknown }

export interface RpcHandlers {
  /** A server→client notification (no id). */
  onNotification(method: string, params: unknown): void;
  /** A server→client request; the returned value is sent back as the result. Throwing sends a JSON-RPC error. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  /** The stream ended or a line could not be parsed as JSON. */
  onClose(reason: string): void;
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve(v: unknown): void; reject(e: Error): void; method: string }>();
  private buffer = '';
  private closedReason: string | null = null;
  private readonly out: Writable;
  private readonly handlers: RpcHandlers;

  constructor(out: Writable, input: Readable, handlers: RpcHandlers) {
    this.out = out;
    this.handlers = handlers;
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.feed(chunk));
    input.on('end', () => this.close('app-server output ended'));
    input.on('error', (e) => this.close(`app-server output error: ${e.message}`));
    // A dead app-server makes stdin writes fail (EPIPE). Unhandled, that 'error' event would crash the whole Hub.
    out.on('error', (e) => this.close(`app-server input error: ${e.message}`));
  }

  /** With a signal, an abort stops the wait (rejects); the request itself has already been sent. */
  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    if (signal?.aborted) return Promise.reject(new Error(`${method}: aborted`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => { if (this.pending.delete(id)) reject(new Error(`${method}: aborted`)); };
      const unlisten = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => { unlisten(); resolve(v as T); },
        reject: (e) => { unlisten(); reject(e); },
        method,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closedReason) this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /** Rejects every pending request; later requests reject immediately. */
  close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const p of this.pending.values()) p.reject(new Error(`${p.method}: ${reason}`));
    this.pending.clear();
    this.handlers.onClose(reason);
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** Requests still waiting for an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private send(msg: object): void {
    if (this.closedReason || this.out.destroyed || this.out.writableEnded) return;
    this.out.write(JSON.stringify(msg) + '\n');
  }

  /** Exposed for tests: feed raw stdout bytes. */
  feed(chunk: string): void {
    this.buffer += chunk;
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    // Last line of defence: nothing a handler throws may escape into the stdout reader (it would crash the process).
    try {
      this.route(line);
    } catch (e) {
      this.close(`handling an app-server message failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private route(line: string): void {
    let msg: { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: RpcError };
    try {
      msg = JSON.parse(line);
    } catch {
      this.close('app-server sent a line that is not JSON');
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      this.handlers.onRequest(msg.method, msg.params).then(
        (result) => this.send({ jsonrpc: '2.0', id, result }),
        (e) => this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }),
      );
    } else if (msg.method !== undefined) {
      this.handlers.onNotification(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method} failed: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }
}
