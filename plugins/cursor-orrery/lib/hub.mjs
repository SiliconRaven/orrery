// What the Cursor hooks and the MCP program share: finding the Hub and talking to it (docs/adapters/cursor.md).
// Standalone: Node built-ins only and no fetch (with NODE_USE_ENV_PROXY=1 the global agent or fetch would send requests
// to a proxy). Which Hub and how: ./hub-discovery.mjs, a byte-identical copy of orrery's plugins/shared/hub-discovery.mjs
// (the account's Hub registry, read fresh each time; requests signed with x-orrery-sig, the key itself never sent; no
// valid record: nothing is sent). Nothing here prints the key, logs it or writes any file.
import { findHub as discover, HubError, hubFetch, hubStream } from './hub-discovery.mjs';

export { HubError };
export const HARNESS = 'cursor';
export const PLACEHOLDER = 'orrery-cursor-placeholder';
const MAX_ANSWER = 4 * 1024 * 1024;

/** A short error on stderr: never an id, a message text or the key. */
export function warn(what) {
  process.stderr.write(`orrery: ${what}\n`);
}

let problem = '';
/** Why the last findHub() found no Hub (the plug-in sent nothing), for the answer the model reads. */
export const whyNoHub = () => problem;

/** The Hub to talk to, from the registry; null when there is none it may send to (see whyNoHub()). */
export function findHub() {
  try {
    return discover({ log: warn });
  } catch (e) {
    if (!(e instanceof HubError)) throw e;
    problem = e.message;
    return null;
  }
}

/**
 * POSTs JSON, signed; resolves { status, body } (body parsed, or null). Rejects with a HubError when no complete answer
 * came: kind 'rejected' (the Hub refused it, 401: it ran nothing), else `sent` says whether the connection to the Hub
 * was made (then the Hub may have received and run the request) and `timeout` whether it gave up waiting.
 */
export async function post(hub, path, data, { headers = {}, timeoutMs = 5000 } = {}) {
  const { status, text } = await hubFetch('POST', path, {
    hub, log: warn, timeoutMs, maxBytes: MAX_ANSWER, body: JSON.stringify(data),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  });
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status, body };
}

/**
 * Opens a signed SSE GET. onEvent(event, data) for each event; resolves 'closed' when the Hub ends the stream (or drops
 * it), 'refused' on a non-200 answer (a 401 included), 'error' when it cannot be reached. close() hangs up.
 */
export function stream(hub, path, onEvent) {
  const hangUp = new AbortController();
  const done = (async () => {
    let res;
    try {
      ({ res } = await hubStream(path, { hub, log: warn, signal: hangUp.signal, headers: { accept: 'text/event-stream' } }));
    } catch (e) {
      return e instanceof HubError && e.kind === 'rejected' ? 'refused' : 'error';
    }
    if (res.statusCode !== 200) {
      res.resume();
      return 'refused';
    }
    return new Promise((ok) => {
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
  })();
  return { done, close: () => hangUp.abort() };
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

export const id = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);
