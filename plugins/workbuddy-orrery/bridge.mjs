// orrery bridge for WorkBuddy: a stdio MCP server the user adds once as a user-level MCP server (and trusts in
// WorkBuddy's connector page), so WorkBuddy starts one for every conversation. It relays newline-delimited JSON-RPC to
// <hub>/mcp with the Hub's bridge secret, the harness name workbuddy and this conversation's id. The id is
// CODEBUDDY_SESSION_ID when this process has it; WorkBuddy does not pass that to MCP child processes, so otherwise it is
// the --session-id on the command line of this process's parent, a WorkBuddy.exe (read once at startup with one read-only
// PowerShell Get-CimInstance call; Windows only). Neither tool arguments nor _meta take part, so a model cannot name
// another conversation in a tool call; an agent that can read local files can read the bridge secret, and that is
// outside this boundary (docs/security.md). Without an id nothing is sent to the Hub and no conversation is named.
// Delivery does not pass through here: the member runs orrery's wait command (plugins/zcode-orrery/wait.mjs) through the
// background-wait route. Contract: docs/adapters/workbuddy.md.
// Standalone: Node built-ins and the MCP SDK's protocol constants only; reads <ORRERY_HOME or ~/.orrery>/hub.json.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

const HARNESS = 'workbuddy';
/** This conversation's id, set once in main() before the first message is read; null when there is none. */
let SESSION_ID = null;
const HOME = process.env.ORRERY_HOME || join(homedir(), '.orrery');
const HUB_DOWN = 'orrery Hub 未运行';
const NO_ID = 'orrery 桥没有拿到这个对话的 ID（没有 CODEBUDDY_SESSION_ID，从父进程 WorkBuddy.exe 的命令行也没取到）';
const NO_SESSION = `${NO_ID}：orrery 工具不可用，也收不到 orrery 的投递。`
  + '确认 orrery 已作为 WorkBuddy 的 MCP 服务器添加并信任，命令直接是 node（中间不要隔一层 cmd 之类的程序），且 Node 24 在 PATH 上；改动后要新开对话。';
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const SESSION_VALUE = /^[A-Za-z0-9._-]{1,128}$/;
// Group 1 is the text after the separator, quotes included.
const SESSION_FLAG = /(?<![\w-])--session-id(?![\w-])(?:(?:=|\s+)(\S*))?/g;
// Below 30 s: the client is waiting for the answer to initialize, and how long WorkBuddy waits is unverified.
const PARENT_LOOKUP_MS = 15_000;

const log = (m) => process.stderr.write(`orrery bridge: ${m}\n`);   // WorkBuddy keeps MCP stderr in its log
const errText = (e) => (e instanceof Error ? e.message : String(e));

// What the Hub's MCP server says about itself; initialize is answered here so a missing id is reported without asking
// the Hub anything.
const SERVER_INFO = { name: 'orrery', version: '0.10.0-beta.1' };
const CAPABILITIES = { tools: { listChanged: true } };
const NO_ID_INSTRUCTIONS = `${NO_ID}，无法识别这个对话：orrery 工具不可用，也收不到 orrery 的投递。`
  + '确认 orrery 已作为 WorkBuddy 的 MCP 服务器添加并信任，命令直接是 node；改动后要新开对话。';

/**
 * The conversation id on a WorkBuddy.exe command line, or null. A scan of the raw text, not an argument parser, on
 * purpose: every occurrence counts wherever it is, so no quoting trick can hide the app's own --session-id behind another
 * one. The cost is failing closed if some other argument ever contains a different "--session-id x".
 */
export function sessionIdFromParent(imageName, commandLine) {
  if (typeof imageName !== 'string' || imageName.toLowerCase() !== 'workbuddy.exe' || typeof commandLine !== 'string') return null;
  const values = [...commandLine.matchAll(SESSION_FLAG)].map((m) => (m[1] ?? '').replace(/^"(.*)"$/, '$1'));
  if (values.length === 0 || new Set(values).size !== 1) return null;
  // A value starting with -- is the next flag: the id itself is missing.
  return SESSION_VALUE.test(values[0]) && !values[0].startsWith('--') ? values[0] : null;
}

/** A process's { name, commandLine }, from one read-only PowerShell call; null off Windows or when it fails. */
export function processInfo(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | ForEach-Object { $_.Name; $_.CommandLine }`],
    { windowsHide: true, timeout: PARENT_LOOKUP_MS }, (err, stdout) => {
      if (err) return done(null);
      const [name, ...rest] = String(stdout).split(/\r?\n/);
      done({ name, commandLine: rest.join(' ') });
    });
  });
}

/** The environment's id if there is one (no lookup then), else the one `lookup` finds on the parent; null without either. */
export async function resolveSessionId(fromEnv, lookup) {
  if (fromEnv) return fromEnv;
  const parent = await lookup();
  return parent ? sessionIdFromParent(parent.name, parent.commandLine) : null;
}

// Every Hub request goes straight to the loopback address in hub.json, on an agent of our own: with
// NODE_USE_ENV_PROXY=1, fetch and the global agent would send it (secret and session id included) to HTTP_PROXY.
const direct = new Agent();

async function findHub() {
  try {
    const d = JSON.parse(await readFile(join(HOME, 'hub.json'), 'utf8'));
    if (typeof d?.url === 'string' && LOOPBACK_URL.test(d.url) && typeof d?.secret === 'string' && d.secret) {
      return { url: d.url, secret: d.secret };
    }
  } catch { /* no Hub */ }
  return null;
}

/** One request to the Hub. Resolves with the response once its headers arrive. */
function hubRequest(hub, method, path, headers, body) {
  return new Promise((ok, fail) => {
    const req = request(`${hub.url}${path}`, { method, headers, agent: direct }, ok);
    req.on('error', fail);
    req.end(body);
  });
}

async function readAll(res) {
  let s = '';
  res.setEncoding('utf8');
  for await (const chunk of res) s += chunk;
  return s;
}

const jsonLine = (v) => `${JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`;
const send = (msg) => process.stdout.write(jsonLine(msg));
const result = (id, r) => send({ jsonrpc: '2.0', id, result: r });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** Forwards one message to the Hub. Returns its JSON-RPC response (null for a notification); throws when it cannot. */
async function relay(msg) {
  const hub = await findHub();
  if (!hub) throw new Error(HUB_DOWN);
  let res;
  let body;
  try {
    res = await hubRequest(hub, 'POST', '/mcp',
      { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'x-orrery-bridge': hub.secret, 'x-orrery-harness': HARNESS, 'x-orrery-session': SESSION_ID }, JSON.stringify(msg));
    body = await readAll(res);
  } catch {
    throw new Error(HUB_DOWN);
  }
  if (res.statusCode === 202) return null;
  if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`orrery Hub 拒绝了请求（HTTP ${res.statusCode}）`);
  }
  return JSON.parse(body);
}

/** Answers that need no Hub: a tool call is refused, the tool list is empty without an id. */
function localAnswer(msg, why) {
  if (msg.method === 'tools/list' && !SESSION_ID) result(msg.id, { tools: [] });
  else if (msg.method === 'tools/call') result(msg.id, toolError(why));
  else if (msg.method === 'ping') result(msg.id, {});
  else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: why } });
}

async function handle(msg) {
  const isRequest = typeof msg.method === 'string' && (typeof msg.id === 'string' || typeof msg.id === 'number');
  if (!isRequest) {
    // A notification: forwarded, never answered. (Responses to server requests: the Hub sends none.)
    if (typeof msg.method === 'string' && msg.id === undefined && SESSION_ID) await relay(msg).catch(() => {});
    return;
  }
  if (msg.method === 'initialize') {
    const asked = msg.params?.protocolVersion;
    result(msg.id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
      ...(SESSION_ID ? {} : { instructions: NO_ID_INSTRUCTIONS }),
    });
    return;
  }
  if (!SESSION_ID) return localAnswer(msg, NO_SESSION);
  try {
    const response = await relay(msg);
    if (response) send(response);
    else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'orrery Hub 没有返回结果' } });
  } catch (e) {
    localAnswer(msg, errText(e));
  }
}

async function main() {
  // Before stdin is read at all: what arrives meanwhile waits in the pipe, so nothing is answered without knowing who this is.
  SESSION_ID = await resolveSessionId(process.env.CODEBUDDY_SESSION_ID, () => processInfo(process.ppid));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) handle(msg).catch((e) => log(`relay failed: ${errText(e)}`));
  });
  // WorkBuddy closing stdin ends this conversation's bridge.
  lines.on('close', () => process.exit(0));
}

// realpath as Node resolves its entry point: a junction or a differently cased drive letter must not stop the bridge.
function isEntryPoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;   // imported from something with no script path
  }
}

if (isEntryPoint()) await main();
