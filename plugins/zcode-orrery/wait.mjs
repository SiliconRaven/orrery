// orrery wait command, shared by every harness on the background-wait route (it stays in this folder because ZCode's
// command names this path, and an "always allow" there is byte-exact). A conversation that is an orrery member runs it
// in the background, as the orrery tool wait_for_messages tells it:
//   node "<this file>" <ticket> <Hub url>                          ZCode
//   node "<this file>" <ticket> <Hub url> <harness> [<ancestor>]   any other harness
// It waits on the Hub (GET /bridge/<harness>-wait) until the Hub has messages for this conversation, prints them to
// stdout (the app's output file of the command), confirms that (POST /bridge/<harness>-ack) and exits; the app then
// starts a turn in which the member reads the output. Exiting always costs a turn, so it exits only when the Hub
// delivers or tells it to stop (or the ticket is wrong). When the Hub is down or restarting it keeps retrying instead.
// Standalone: Node built-ins only, no fetch (a proxy must never see the ticket). It talks to the Hub URL in its
// command (http://127.0.0.1:<port> or http://localhost:<port> only); an older command without one falls back to `url`
// from <ORRERY_HOME or ~/.orrery>/hub.json (loopback only, nothing else from it). On Windows it reads the process
// table once (one read-only PowerShell Get-CimInstance call) to find the app's process above its shell (the named
// <ancestor>, else the first ancestor that is not a shell), and leaves silently when that or the shell is gone.
// Contract: docs/adapters/zcode.md.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const RETRY_MS = 5000;
const PARENT_CHECK_MS = 5000;
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const TICKET_BODY = /^[A-Za-z0-9._-]{1,128}\.[0-9a-f]{64}$/;
const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ANCESTOR_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A command with no harness argument is ZCode's. */
const DEFAULT_HARNESS = 'zcode';
const SHELLS = new Set(['bash.exe', 'sh.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe']);

export const STARTED = 'orrery：正在等群消息。如果这条命令被停止（不是正常结束），不要重新运行，也不要再处理之前已经处理过的消息。\n';
export const BAD_TICKET = 'orrery：命令格式不对。调用 orrery 的 wait_for_messages 重新取命令，原样运行。\n';
export const VOID_TICKET = 'orrery：这张等待票据已经作废（Hub 换了密钥，或者不是这个 Hub 签发的），不要重新运行这条命令。要重新加入，调用 orrery 的 wait_for_messages 取新命令。\n';

/** The Hub's url from hub.json, read fresh every time (it may restart on another port). Null when there is none. */
async function findHub(home) {
  try {
    const d = JSON.parse(await readFile(join(home, 'hub.json'), 'utf8'));
    if (typeof d?.url === 'string' && LOOPBACK_URL.test(d.url)) return d.url;
  } catch { /* no Hub */ }
  return null;
}

/**
 * Waits until the Hub delivers or ends the wait; resolves with the text to print and, for a delivery, its id.
 * Options: `harness` (default zcode), `url` (the Hub named in the command; without it hub.json in `home`), `home`, `retryMs`, `log` (one line per kind of trouble, to stderr), `signal`.
 */
export async function waitOnce(ticket, opts = {}) {
  const harness = opts.harness ?? DEFAULT_HARNESS;
  const home = opts.home ?? (process.env.ORRERY_HOME || join(homedir(), '.orrery'));
  const retryMs = opts.retryMs ?? RETRY_MS;
  const log = opts.log ?? ((s) => process.stderr.write(`${s}\n`));
  const agent = new Agent({ keepAlive: false });
  let reported = false;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const url = opts.url ?? await findHub(home);
      try {
        if (!url) throw new Error('no hub.json');
        const got = await stream(url, harness, ticket, agent, opts.signal);
        if (got) return got;
        // The stream ended without a word: the Hub is closing. Reconnect to the next one.
      } catch (e) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (!reported) log(`orrery Hub not reachable (${e instanceof Error ? e.message : String(e)}), retrying every ${retryMs} ms`);
        reported = true;
      }
      await sleep(retryMs, undefined, opts.signal ? { signal: opts.signal } : undefined);
    }
  } finally {
    agent.destroy();
  }
}

/** One wait connection: { text, deliveryId?, url } when the Hub spoke, null when the stream just ended. */
function stream(url, harness, ticket, agent, signal) {
  return new Promise((ok, fail) => {
    const req = request(`${url}/bridge/${harness}-wait`, { headers: { 'x-orrery-ticket': ticket }, agent, signal }, (res) => {
      if (res.statusCode === 403) {
        res.resume();
        return ok({ text: VOID_TICKET, url });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${res.statusCode}`));
      }
      res.setEncoding('utf8');
      let buf = '';
      let done = false;
      res.on('data', (chunk) => {
        buf += chunk;
        for (let i = buf.indexOf('\n\n'); i >= 0 && !done; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = '';
          const lines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trimStart();
            else if (line.startsWith('data:')) lines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
          }
          let data;
          try { data = JSON.parse(lines.join('\n')); } catch { continue; }
          if (typeof data?.text !== 'string') continue;
          if (event === 'deliver' && typeof data.deliveryId === 'string') {
            done = true;
            ok({ text: data.text, deliveryId: data.deliveryId, url });
          } else if (event === 'end') {
            done = true;
            ok({ text: data.text, url });
          }
        }
      });
      res.on('end', () => { if (!done) ok(null); });
      res.on('error', (e) => { if (!done) fail(e); });
      res.on('close', () => { if (!done) ok(null); });
    });
    req.on('error', fail);
    req.end();
  });
}

/** Tells the Hub the delivery is printed. Errors are only logged: the text is in the output file either way. */
function ack(url, harness, ticket, deliveryId) {
  return new Promise((ok) => {
    const agent = new Agent({ keepAlive: false });
    const req = request(`${url}/bridge/${harness}-ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, agent, timeout: 10_000 }, (res) => {
      res.resume();
      res.on('end', () => { agent.destroy(); ok(); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { process.stderr.write(`orrery ack failed: ${e.message}\n`); agent.destroy(); ok(); });
    req.end(JSON.stringify({ ticket, deliveryId }));
  });
}

/**
 * The app-level ancestor, from a process table [{ pid, ppid, name }] and our parent's pid: the first ancestor called
 * `name`, or without a name the first that is not a shell (on Windows the program that started the shell, for ZCode
 * its agent process). Null when the chain cannot be followed.
 */
export function anchorOf(processes, parentPid, name) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const wanted = name?.toLowerCase();
  let pid = parentPid;
  for (let i = 0; i < 32; i++) {
    const p = byPid.get(pid);
    if (!p) return null;
    const own = p.name.toLowerCase();
    if (wanted ? own === wanted : !SHELLS.has(own)) return pid;
    pid = p.ppid;
  }
  return null;
}

/** Every process as { pid, ppid, name }, from one read-only PowerShell call; null off Windows or when it fails. */
export function processTable() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
    { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return done(null);
      const rows = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^(\d+) (\d+) (.+)$/.exec(line.trim());
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] });
      }
      done(rows.length ? rows : null);
    });
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';   // alive, just not ours to signal
  }
};

const write = (s) => new Promise((ok) => process.stdout.write(s, () => ok()));

async function main() {
  const [ticket, url, named, ancestor] = process.argv.slice(2);
  const harness = named ?? DEFAULT_HARNESS;
  const ticketOk = HARNESS_RE.test(harness) && (ticket ?? '').startsWith(`${harness[0]}1.`) && TICKET_BODY.test(ticket.slice(3));
  if (!ticketOk || process.argv.length > 6 || (url !== undefined && !LOOPBACK_URL.test(url)) || (ancestor !== undefined && !ANCESTOR_RE.test(ancestor))) {
    await write(BAD_TICKET);
    process.exit(0);
  }
  // Leave with the app: when the shell it started us in is gone, or the app-level process above it, since a quitting
  // app can leave the shell behind. Exiting then starts no turn anywhere, so say nothing.
  // Unknown chain (not Windows, or the process table unreadable): only the shell is watched.
  const parent = process.ppid;
  let anchor = null;
  processTable().then((table) => { if (table) anchor = anchorOf(table, parent, ancestor); }, () => {});
  setInterval(() => {
    if (!alive(parent) || (anchor !== null && !alive(anchor))) process.exit(0);
  }, PARENT_CHECK_MS).unref();
  // A named harness prints nothing while it waits: its output is the envelope only (an app's guard may flag the
  // "do not re-run" wording, and Qoder inspects a silent command's last line for prompts).
  if (named === undefined) await write(STARTED);
  const got = await waitOnce(ticket, url === undefined ? { harness } : { harness, url });
  // Printed in full before the Hub hears of it, and only then do we exit.
  await write(got.text);
  if (got.deliveryId) await ack(got.url, harness, ticket, got.deliveryId);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
