// orrery sidecar for Antigravity 2.0. The user copies this folder to ~/.gemini/config/sidecars/orrery/ and enables it
// in Antigravity; Antigravity then runs it as a background process of the app (sidecar.json). It connects the app to a
// running orrery Hub on this machine, like the orrery bridge does for Claude Code:
//   - holds the Hub's shared stream for the `antigravity` harness (GET /bridge/stream?harness=antigravity), so while it
//     runs the Hub counts every Antigravity conversation as online; it reports the language server version with it;
//   - puts each delivered message into its conversation with the official `agentapi send-message <id> <text>`
//     (run with execFile, no shell; the id must be a UUID), then acks it (POST /bridge/ack).
// It does nothing else with Antigravity: no other agentapi command, no private RPC, never opens a link or starts a
// program other than agentapi. The language server's CSRF token, which Antigravity puts in this process's environment
// for agentapi, stays there: it is never sent to the Hub and never logged (error texts are scrubbed of it).
// Standalone: Node built-ins only, nothing from the orrery repository at run time. It reads only
// <ORRERY_HOME or ~/.orrery>/hub.json and talks only to the loopback address in it. Contract: docs/adapters/antigravity.md.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const HARNESS = 'antigravity';
const RETRY_MS = 5000;
const PARENT_CHECK_MS = 5000;
const SEND_TIMEOUT_MS = 60_000;
const MAX_TEXT = 30_000;   // a Windows command line ends at 32 767 characters
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[\w.+-]{1,40}$/;

const errText = (e) => (e instanceof Error ? (e.code ? `${e.code}: ${e.message}` : e.message) : String(e));

/**
 * How to run agentapi, or null when there is no way without a shell. Antigravity names the executable in
 * ANTIGRAVITY_AGENTAPI_EXE (its language server, which takes `agentapi` as the first argument, as Antigravity's own
 * sidecar runtime calls it). Otherwise `agentapi` from PATH, except on Windows, where that is a .bat file and a .bat
 * runs only through cmd.exe, which would parse the message text.
 */
export function agentapiCommand(env, platform = process.platform) {
  if (env.ANTIGRAVITY_AGENTAPI_EXE) return { file: env.ANTIGRAVITY_AGENTAPI_EXE, args: ['agentapi'] };
  return platform === 'win32' ? null : { file: 'agentapi', args: [] };
}

/**
 * The arguments after the agentapi command for one message. `--` ends option parsing before a text that starts with
 * `-`; other texts go without it.
 * shortcut: real-device check that agentapi accepts `--` here; until then only texts starting with `-` depend on it.
 */
export function sendMessageArgs(conversationId, text) {
  return text.startsWith('-') ? ['send-message', '--', conversationId, text] : ['send-message', conversationId, text];
}

/**
 * Runs the sidecar until stop(). Options: `home` (where hub.json is), `env` (default process.env), `agentapi`
 * ({ file, args }, default from env), `retryMs`, `log` ({ info, warn }).
 */
export function start(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.ORRERY_HOME || join(homedir(), '.orrery'));
  const retryMs = opts.retryMs ?? RETRY_MS;
  const log = opts.log ?? console;
  const agentapi = opts.agentapi ?? agentapiCommand(env);
  const version = VERSION_RE.test(env.ANTIGRAVITY_LS_VERSION ?? '') ? env.ANTIGRAVITY_LS_VERSION : null;
  const token = env.ANTIGRAVITY_CSRF_TOKEN;
  const scrub = (s) => (token ? s.split(token).join('[redacted]') : s);
  const stop = new AbortController();
  // Every Hub request goes straight to the loopback address in hub.json on an agent of our own: with
  // NODE_USE_ENV_PROXY=1, fetch and the global agent would send it (secret included) to HTTP_PROXY.
  const direct = new Agent();

  /** The Hub from hub.json, read fresh every time (it may restart on another port). Null when there is none. */
  async function findHub() {
    try {
      const d = JSON.parse(await readFile(join(home, 'hub.json'), 'utf8'));
      if (typeof d?.url === 'string' && LOOPBACK_URL.test(d.url) && typeof d.secret === 'string' && d.secret) return { url: d.url, secret: d.secret };
    } catch { /* no Hub */ }
    return null;
  }

  function hubRequest(hub, method, path, headers, body) {
    return new Promise((ok, fail) => {
      if (stop.signal.aborted) return fail(stop.signal.reason);
      const req = request(`${hub.url}${path}`, { method, headers, agent: direct, signal: stop.signal }, ok);
      req.on('error', fail);
      req.end(body);
    });
  }

  /** agentapi send-message for one delivery; resolves with null or the error text, never rejects. */
  function send(conversationId, text) {
    if (!agentapi) return Promise.resolve('this sidecar has no agentapi to run (ANTIGRAVITY_AGENTAPI_EXE is not set)');
    if (!UUID.test(conversationId)) return Promise.resolve(`not an Antigravity conversation id: ${conversationId.slice(0, 80)}`);
    if (text.length > MAX_TEXT) return Promise.resolve(`message too long for agentapi (${text.length} > ${MAX_TEXT} characters)`);
    // A command-line argument cannot hold NUL: execFile would throw instead of running.
    if (text.includes('\0')) return Promise.resolve('message contains a NUL character, which agentapi cannot take as an argument');
    return new Promise((done) => {
      try {
        execFile(agentapi.file, [...agentapi.args, ...sendMessageArgs(conversationId, text)],
          { env, windowsHide: true, timeout: SEND_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal: stop.signal },
          (err, _stdout, stderr) => {
            if (!err) return done(null);
            // Scrub before cutting: a token cut in half would no longer match.
            const detail = scrub(String(stderr ?? '').trim()).slice(-500);
            done(scrub(`agentapi send-message failed (${err.code ?? err.signal ?? 'error'})${detail ? `: ${detail}` : ''}`));
          });
      } catch (err) {
        done(scrub(`agentapi send-message could not start: ${errText(err)}`));
      }
    });
  }

  async function ack(hub, deliveryId, error) {
    const res = await hubRequest(hub, 'POST', '/bridge/ack', { 'content-type': 'application/json', 'x-orrery-bridge': hub.secret },
      JSON.stringify(error === null ? { deliveryId, ok: true } : { deliveryId, ok: false, error }));
    res.resume();
    if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  }

  async function deliver(hub, data) {
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof e?.deliveryId !== 'string' || typeof e.sessionId !== 'string' || typeof e.text !== 'string') return;
    let error;
    try {
      error = await send(e.sessionId, e.text);
    } catch (err) {
      error = scrub(`delivery failed: ${errText(err)}`);   // one bad delivery must not end the sidecar
    }
    if (stop.signal.aborted) return;
    if (error) log.warn(`delivery ${e.deliveryId} failed: ${error}`);
    await ack(hub, e.deliveryId, error).catch((err) => { if (!stop.signal.aborted) log.warn(`ack failed: ${errText(err)}`); });
  }

  /** One stream connection: resolves when it ends. Deliveries for different conversations run side by side. */
  async function stream(hub) {
    const query = `harness=${HARNESS}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
    const res = await hubRequest(hub, 'GET', `/bridge/stream?${query}`, { 'x-orrery-bridge': hub.secret });
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`stream refused (HTTP ${res.statusCode})`);
    }
    log.info('connected to the orrery Hub');
    res.setEncoding('utf8');
    let buf = '';
    for await (const chunk of res) {
      buf += chunk;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = '';
        const lines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trimStart();
          else if (line.startsWith('data:')) lines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
        }
        // The Hub sends a conversation's next delivery only after this one's ack, so order within it holds.
        if (event === 'deliver' && lines.length) deliver(hub, lines.join('\n')).catch((err) => log.warn(`delivery failed: ${scrub(errText(err))}`));
      }
    }
  }

  async function loop() {
    let reported = false;
    while (!stop.signal.aborted) {
      const hub = await findHub();
      try {
        if (!hub) throw new Error('no hub.json');
        await stream(hub);
        reported = false;
        if (!stop.signal.aborted) log.info('orrery Hub stream ended, reconnecting');
      } catch (e) {
        if (stop.signal.aborted) return;
        if (!reported) log.info(`orrery Hub not reachable (${errText(e)}), retrying every ${retryMs} ms`);
        reported = true;
      }
      await sleep(retryMs, undefined, { signal: stop.signal }).catch(() => {});
    }
  }

  void loop();
  return {
    stop() {
      stop.abort();
      direct.destroy();
    },
  };
}

/** Run by Antigravity: only inside the app (its language server address is set), and only with agentapi to run. */
function main() {
  if (!process.env.ANTIGRAVITY_LS_ADDRESS) {
    console.error('orrery sidecar: ANTIGRAVITY_LS_ADDRESS is not set; it runs only as an Antigravity sidecar');
    process.exit(1);
  }
  if (!agentapiCommand(process.env)) {
    console.error('orrery sidecar: ANTIGRAVITY_AGENTAPI_EXE is not set, so agentapi cannot run without a shell');
    process.exit(1);
  }
  const sidecar = start();
  // Leave with the app: when the process that started this one is gone, the member must turn offline.
  // shortcut: polls the parent pid; real-device check whether Antigravity ends its sidecars itself.
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (e) {
      if (e?.code === 'EPERM') return;   // alive, just not ours to signal
      sidecar.stop();
      process.exit(0);
    }
  }, PARENT_CHECK_MS).unref();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { sidecar.stop(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
