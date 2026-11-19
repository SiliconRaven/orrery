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
// Standalone: Node built-ins only, nothing from the orrery repository at run time. Which Hub and how: ./hub-discovery.mjs,
// a byte-identical copy of orrery's plugins/shared/hub-discovery.mjs (the account's Hub registry, read for every
// connection; requests signed with x-orrery-sig, the key itself never sent; no valid record: nothing is sent). It talks
// only to the loopback address there. Contract: docs/adapters/antigravity.md.
import { execFile } from 'node:child_process';
import { Agent } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { HubError, hubFetch, hubStream } from './hub-discovery.mjs';

const HARNESS = 'antigravity';
const RETRY_MS = 5000;
const PARENT_CHECK_MS = 5000;
const SEND_TIMEOUT_MS = 60_000;
const MAX_TEXT = 30_000;   // a Windows command line ends at 32 767 characters
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
 * Runs the sidecar until stop(). Options: `env` (default process.env; ORRERY_REGISTRY, ORRERY_HUB and ORRERY_LEGACY_HUB
 * choose the Hub), `agentapi`
 * ({ file, args }, default from env), `retryMs`, `log` ({ info, warn }).
 */
export function start(opts = {}) {
  const env = opts.env ?? process.env;
  const retryMs = opts.retryMs ?? RETRY_MS;
  const log = opts.log ?? console;
  const agentapi = opts.agentapi ?? agentapiCommand(env);
  const version = VERSION_RE.test(env.ANTIGRAVITY_LS_VERSION ?? '') ? env.ANTIGRAVITY_LS_VERSION : null;
  const token = env.ANTIGRAVITY_CSRF_TOKEN;
  const scrub = (s) => (token ? s.split(token).join('[redacted]') : s);
  const stop = new AbortController();
  // Every Hub request goes straight to the loopback address the registry names, on an agent of our own: with
  // NODE_USE_ENV_PROXY=1, fetch and the global agent would send it to HTTP_PROXY.
  const direct = new Agent();
  const hubOpts = { env, agent: direct, signal: stop.signal, log: (m) => log.info(m) };

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

  /** To the Hub whose stream delivered it: never to another Hub the registry may name by now. */
  async function ack(hub, deliveryId, error) {
    stop.signal.throwIfAborted();
    const { status } = await hubFetch('POST', '/bridge/ack', { ...hubOpts, hub, headers: { 'content-type': 'application/json' },
      body: JSON.stringify(error === null ? { deliveryId, ok: true } : { deliveryId, ok: false, error }) });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
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
  async function stream() {
    const query = `harness=${HARNESS}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
    stop.signal.throwIfAborted();
    const { res, hub } = await hubStream(`/bridge/stream?${query}`, hubOpts);
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`stream refused (HTTP ${res.statusCode})`);
    }
    log.info(`connected to the orrery Hub「${hub.name}」`);
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
    let reported = '';
    while (!stop.signal.aborted) {
      try {
        await stream();
        reported = '';
        if (!stop.signal.aborted) log.info('orrery Hub stream ended, reconnecting');
      } catch (e) {
        if (stop.signal.aborted) return;
        // Once per kind of trouble: another reason (a refusal after a restart, another Hub) is logged again.
        const why = e instanceof HubError ? e.message : `orrery Hub not reachable (${errText(e)})`;
        if (why !== reported) log.info(`${why}; retrying every ${retryMs} ms`);
        reported = why;
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
