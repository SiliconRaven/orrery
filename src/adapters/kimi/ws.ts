// A minimal WebSocket client (RFC 6455: text frames, fragmentation, ping/pong, close) over node:http, for Kimi Code's
// local event stream. Not the global WebSocket: that one may go through a proxy (NODE_USE_ENV_PROXY), and the
// handshake carries the user's Kimi token. This one only ever connects to 127.0.0.1, with no agent and no proxy.
// The frame codec is exported so tests can play the server side.
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;   // a larger message closes the connection

export const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

/** One frame. Clients mask what they send (`mask: true`); servers do not. */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = len;
  else if (len < 65536) { out[1] = 126; out.writeUInt16BE(len, 2); }
  else { out[1] = 127; out.writeBigUInt64BE(BigInt(len), 2); }
  if (mask) {
    out[1] |= 0x80;
    const key = randomBytes(4);
    key.copy(out, head);
    for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ key[i & 3];
  } else payload.copy(out, head);
  return out;
}

/** Turns a byte stream into whole messages: data frames are reassembled, control frames come out as they arrive. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partsOp = 0;

  /** Throws when the stream breaks the protocol or a message is too large. */
  push(chunk: Buffer): { opcode: number; payload: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: { opcode: number; payload: Buffer }[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error('websocket frame too large');
        len = Number(big);
        at = 10;
      }
      if (len > MAX_MESSAGE) throw new Error('websocket frame too large');
      const need = at + (masked ? 4 : 0) + len;
      if (this.buf.length < need) break;
      let payload = Buffer.from(this.buf.subarray(at + (masked ? 4 : 0), need));
      if (masked) {
        const key = this.buf.subarray(at, at + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      this.buf = this.buf.subarray(need);
      if (opcode >= 8) { out.push({ opcode, payload }); continue; }
      if (opcode !== OP.continuation) { this.parts = []; this.partsOp = opcode; }
      this.parts.push(payload);
      if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) throw new Error('websocket message too large');
      if (fin) {
        payload = Buffer.concat(this.parts);
        this.parts = [];
        out.push({ opcode: this.partsOp, payload });
      }
    }
    return out;
  }
}

export interface WsConnection {
  /** Sends one text message; false when the connection is already closed. */
  send(text: string): boolean;
  close(): void;
  readonly closed: boolean;
}

export interface WsOptions {
  port: number;                     // always on 127.0.0.1
  path: string;
  protocols?: string[];
  timeoutMs: number;                // for the handshake
  onMessage(text: string): void;
  onClose(reason: string): void;    // called once, also after close()
}

/** Opens a WebSocket to 127.0.0.1:<port><path>. Rejects when the handshake fails (the error never contains headers). */
export function connectWs(opts: WsOptions): Promise<WsConnection> {
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: opts.port, path: opts.path, method: 'GET', agent: false, timeout: opts.timeoutMs,
      headers: {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key,
        ...(opts.protocols?.length ? { 'sec-websocket-protocol': opts.protocols.join(', ') } : {}),
      },
    });
    req.on('timeout', () => req.destroy(new Error('websocket handshake timed out')));
    req.on('error', (e) => reject(new Error(`websocket connect failed: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`websocket handshake refused: HTTP ${res.statusCode}`));
    });
    req.on('upgrade', (res, socket: Socket, head: Buffer) => {
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        reject(new Error('websocket handshake: bad accept key'));
        return;
      }
      socket.setNoDelay(true);
      socket.setTimeout(0);
      let closed = false;
      const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        socket.destroy();
        opts.onClose(reason);
      };
      const reader = new FrameReader();
      const onData = (chunk: Buffer) => {
        let frames;
        try {
          frames = reader.push(chunk);
        } catch (e) {
          finish(e instanceof Error ? e.message : String(e));
          return;
        }
        for (const f of frames) {
          if (closed) return;
          if (f.opcode === OP.text) opts.onMessage(f.payload.toString('utf8'));
          else if (f.opcode === OP.ping) socket.write(encodeFrame(OP.pong, f.payload, true));
          else if (f.opcode === OP.close) {
            socket.write(encodeFrame(OP.close, Buffer.alloc(0), true));
            finish('closed by the server');
          }
        }
      };
      socket.on('data', onData);
      socket.on('close', () => finish('connection lost'));
      socket.on('error', () => finish('connection lost'));
      const conn: WsConnection = {
        send: (text) => {
          if (closed) return false;
          socket.write(encodeFrame(OP.text, Buffer.from(text, 'utf8'), true));
          return true;
        },
        close: () => {
          if (!closed) socket.write(encodeFrame(OP.close, Buffer.alloc(0), true));
          finish('closed');
        },
        get closed() { return closed; },
      };
      resolve(conn);
      if (head.length) onData(head);
    });
    req.end();
  });
}
