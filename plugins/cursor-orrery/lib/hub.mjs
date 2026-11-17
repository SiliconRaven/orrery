// What the Cursor hooks and the MCP program share: finding the Hub and talking to it (docs/adapters/cursor.md).
// Standalone: Node built-ins only and no fetch (with NODE_USE_ENV_PROXY=1 the global agent or fetch would send the secret
// to a proxy). It reads <ORRERY_HOME or ~/.orrery>/hub.json fresh each time and talks only to the loopback address there.
// The bridge secret stays in memory; nothing here prints it, logs it or writes any file.
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HARNESS = 'cursor';
export const PLACEHOLDER = 'orrery-cursor-placeholder';
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const MAX_ANSWER = 4 * 1024 * 1024;

const home = () => process.env.ORRERY_HOME || join(homedir(), '.orrery');
const direct = new Agent();

/** The Hub from hub.json ({ url, secret }); null when there is none or it is not on the loopback address. */
export async function findHub() {
  try {
    const d = JSON.parse(await readFile(join(home(), 'hub.json'), 'utf8'));
    if (typeof d?.url === 'string' && LOOPBACK_URL.test(d.url) && typeof d.secret === 'string' && d.secret) return { url: d.url, secret: d.secret };
  } catch { /* no Hub */ }
  return null;
}

/**
 * POSTs JSON with the bridge secret; resolves { status, body } (body parsed, or null). Rejects when no complete answer
 * came; the error's `sent` says whether the connection to the Hub was made (then the Hub may have received and run the
 * request), `timeout` whether it gave up waiting.
 */
export function post(hub, path, data, { headers = {}, timeoutMs = 5000 } = {}) {
  let sent = false;
  return new Promise((ok, fail) => {
    const failed = (e) => fail(Object.assign(e instanceof Error ? e : new Error(String(e)), { sent }));
    const req = request(`${hub.url}${path}`, {
      method: 'POST', agent: direct, timeout: timeoutMs,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': hub.secret, ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (text.length > MAX_ANSWER) req.destroy(new Error('answer too large'));
      });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        ok({ status: res.statusCode, body });
      });
      res.on('error', failed);
      res.on('close', () => { if (!res.complete) failed(new Error('the answer was cut off')); });
    });
    // Connected: from here on the Hub may have the request, so a failure no longer means "not sent".
    req.on('socket', (socket) => {
      if (!socket.connecting) sent = true;
      else socket.once('connect', () => { sent = true; });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { timeout: true })));
    req.on('error', failed);
    req.end(JSON.stringify(data));
  });
}

/**
 * Opens an SSE GET with the bridge secret. onEvent(event, data) for each event; resolves 'closed' when the Hub ends the
 * stream (or drops it), 'refused' on a non-200 answer, 'error' when it cannot be reached. close() hangs up.
 */
export function stream(hub, path, onEvent) {
  let req;
  const done = new Promise((ok) => {
    req = request(`${hub.url}${path}`, { agent: direct, headers: { accept: 'text/event-stream', 'x-orrery-bridge': hub.secret } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return ok('refused');
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || data === undefined) continue;
          try { onEvent(event, JSON.parse(data)); } catch { /* a malformed event is ignored */ }
        }
      });
      res.on('close', () => ok('closed'));
      res.on('error', () => ok('closed'));
    });
    req.on('error', () => ok('error'));
    req.end();
  });
  return { done, close: () => req.destroy() };
}

/** The hook's input from stdin: an object, or {} when it is not JSON. */
export async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Writes the hook's one answer to Cursor; resolves once it is flushed. */
export function answer(obj) {
  return new Promise((ok) => process.stdout.write(JSON.stringify(obj), () => ok()));
}

/** A short error on stderr: never an id, a message text or the secret. */
export function warn(what) {
  process.stderr.write(`orrery: ${what}\n`);
}

export const id = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);
