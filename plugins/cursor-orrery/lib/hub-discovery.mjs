// How an orrery plug-in finds the Hub and talks to it (docs/hub-discovery.md, sections 3-6). Standalone: Node built-ins
// only. Plug-ins installed by copying carry a byte-identical copy next to their own files (test/hub-discovery-client.test.ts
// checks every copy); the Hub's side is src/hub-registry.ts, src/bridge-protocol.ts and src/mcp/bridge-auth.ts.
//
// - Which Hub: the account's registry (ORRERY_REGISTRY, default ~/.orrery/registry): active.json, or the record in
//   hubs/ that ORRERY_HUB=<hubId or name> pins. A missing, invalid or stale record stops here and nothing is sent; a
//   pinned Hub that is not valid is never replaced by another one.
// - Signed requests: x-orrery-sig carries an HMAC over the Hub, this start of it (claim), the address, the method and
//   path, every x-orrery-* header and the body. The registry key itself never goes on the wire.
// - A 401 with reason `claim` (the Hub restarted): the registry is read once more and, only when it still names the same
//   Hub at the same address with a new claim, the request is signed again and sent once more to that one Hub.
// - Explicit legacy fallback: only with ORRERY_LEGACY_HUB=<home>, and only when the registry has no running active Hub,
//   <home>/hub.json is read (its process must be alive, its address loopback) and the key goes as x-orrery-bridge.
// - Every request goes straight to the loopback address, on an agent of our own (with NODE_USE_ENV_PROXY=1 the global
//   agent and fetch would use HTTP_PROXY); node:http never follows redirects. Nothing here prints or logs the key.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SIGNATURE_HEADER = 'x-orrery-sig';
export const SECRET_HEADER = 'x-orrery-bridge';
const HUB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CLAIM_RE = /^[a-f0-9]{32}$/;
const KEY_RE = /^[a-f0-9]{64}$/;
const REGISTRY_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
const LEGACY_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const IDENTITY_HEADERS = ['x-orrery-harness', 'x-orrery-session'];
const MAX_REJECTION = 4096;

/**
 * Why a Hub request did not work. kind:
 *   'not-sent'    nothing was sent (no valid Hub record, no key, a header that cannot be signed);
 *   'rejected'    the Hub answered 401 (reason: claim, expired, replay, mac or host; none from a legacy Hub);
 *   'unreachable' no complete answer: `sent` says whether a connection was made (the Hub may then have run it).
 */
export class HubError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'HubError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const notSent = (why) => new HubError('not-sent', `接入件没有发送请求：${why}`, { sent: false });
const codeOf = (e) => (e && typeof e === 'object' ? e.code : undefined);
const errText = (e) => (e instanceof Error ? e.message : String(e));

/** The registry directory: ORRERY_REGISTRY, default ~/.orrery/registry (the same rule as the Hub's). */
export const registryDirOf = (env = process.env) => resolve(env.ORRERY_REGISTRY || join(homedir(), '.orrery', 'registry'));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return codeOf(e) !== 'ESRCH';   // EPERM: alive, just not ours to signal
  }
}

function isRecord(r) {
  const port = r && typeof r === 'object' && typeof r.url === 'string' ? REGISTRY_URL.exec(r.url)?.[1] : undefined;
  return !!port && Number(port) <= 65535 && r.version === 1
    && typeof r.hubId === 'string' && HUB_ID_RE.test(r.hubId) && typeof r.claim === 'string' && CLAIM_RE.test(r.claim)
    && Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.name === 'string' && (r.role === 'active' || r.role === 'secondary');
}

/** A registry record, undefined when the file does not exist; throws not-sent when it is not a valid record. */
function readRecord(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return undefined;
    throw notSent(`登记处文件无效（${path}）`);
  }
  if (!isRecord(data)) throw notSent(`登记处文件无效（${path}）`);
  return data;
}

/** The shared bridge key K from the registry. Throws not-sent when it is missing, not a plain file or malformed. */
export function readBridgeKey(env = process.env) {
  const path = join(registryDirOf(env), 'bridge-secret');
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.isSymbolicLink()
    || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) throw notSent(`读不到接入密钥（${path}）`);
  let key;
  try { key = readFileSync(path, 'utf8').trim(); } catch { throw notSent(`读不到接入密钥（${path}）`); }
  if (!KEY_RE.test(key)) throw notSent(`接入密钥无效（${path}）`);
  return key;
}

/**
 * The record ORRERY_HUB names: hubs/<hubId>.json whose own hubId is that id, or the one record whose name it is (its
 * file named after its own hubId). A record copied or restored under another file name is not this Hub: stop, since a
 * signature for its hubId and address would be accepted by whichever Hub that is (they share the key). Never another Hub.
 */
function pinnedRecord(dir, pin) {
  const invalid = () => notSent(`ORRERY_HUB=${pin} 指定的 Hub 没有有效记录（${join(dir, 'hubs')}）。`);
  const hubs = join(dir, 'hubs');
  let record;
  if (HUB_ID_RE.test(pin)) {
    try { record = readRecord(join(hubs, `${pin}.json`)); } catch { throw invalid(); }
    if (record && record.hubId !== pin) throw invalid();
  } else {
    let names = [];
    try { names = readdirSync(hubs).filter((f) => f.endsWith('.json')); } catch { /* no records */ }
    const found = [];
    for (const f of names) {
      try {
        const r = readRecord(join(hubs, f));
        if (r?.name === pin && f === `${r.hubId}.json`) found.push(r);
      } catch { /* another Hub's broken record does not decide this one */ }
    }
    if (found.length > 1) throw notSent(`ORRERY_HUB=${pin} 对应多个 Hub，请改用 hubId 指定。`);
    record = found[0];
  }
  if (!record || !pidAlive(record.pid)) throw invalid();
  return record;
}

function legacyHub(home, { secret, log }) {
  const file = join(resolve(home), 'hub.json');
  let d;
  try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { d = null; }
  if (!d || typeof d !== 'object') throw notSent(`ORRERY_LEGACY_HUB 指向的 ${file} 不存在或无效。`);
  if (typeof d.url !== 'string' || !LEGACY_URL.test(d.url)) throw notSent(`${file} 里的地址不是本机回环地址。`);
  if (!Number.isSafeInteger(d.pid) || d.pid <= 0 || !pidAlive(d.pid)) throw notSent(`${file} 记录的 Hub 进程已经退出。`);
  if (secret && (typeof d.secret !== 'string' || !d.secret)) throw notSent(`${file} 里没有接入密钥。`);
  (log ?? defaultLog)(`按用户设置的旧版回退连接 ${file}`);
  return { mode: 'legacy', url: d.url, name: `旧版 Hub（${file}）`, file, ...(secret ? { secret: d.secret } : {}) };
}

const defaultLog = (m) => process.stderr.write(`orrery: ${m}\n`);

/**
 * The one Hub to talk to, read fresh from the registry: { mode: 'signed', hubId, claim, url, name, secret } or, only
 * with ORRERY_LEGACY_HUB, { mode: 'legacy', url, name, file, secret }. Throws HubError (not-sent) instead of guessing.
 * Options: env (default process.env), secret (false: the key is not read, e.g. for a URL only), log (legacy notes).
 */
export function findHub({ env = process.env, secret = true, log } = {}) {
  const dir = registryDirOf(env);
  let record;
  if (env.ORRERY_HUB) record = pinnedRecord(dir, env.ORRERY_HUB);
  else {
    const path = join(dir, 'active.json');
    record = readRecord(path);
    if (!record || record.role !== 'active' || !pidAlive(record.pid)) {
      if (env.ORRERY_LEGACY_HUB) return legacyHub(env.ORRERY_LEGACY_HUB, { secret, log });
      throw notSent(`未找到活动 Hub（${path} 不存在，或者记录的进程已经退出）。要连旧版 Hub，请设置 ORRERY_LEGACY_HUB。`);
    }
  }
  return { mode: 'signed', hubId: record.hubId, claim: record.claim, url: record.url, name: record.name,
    ...(secret ? { secret: readBridgeKey(env) } : {}) };
}

/**
 * What a failed call means, for the text a model reads: nothing was sent (safe to retry), the Hub refused it (it did
 * not run), or it reached the Hub and the answer was lost (it may have run: check before doing it again).
 */
export function callOutcome(e) {
  if (!(e instanceof HubError)) return `orrery 调用失败：${errText(e)}`;
  const what = e.message.replace(/[。.]$/, '');
  if (e.kind === 'rejected') return `${what}。这次调用没有执行。`;
  if (!e.sent) return `${what}。这次调用没有发出，可以放心重试。`;
  return `${what}。请求已经发给 Hub，但没有收到完整回答，结果未知：如果它会发消息或改动任务，先用 read_messages（history: true）`
    + '或 get_task 查一下是否已经生效，再决定要不要重试。';
}

/** Only the address of the Hub findHub would choose, without reading the key (the wait command holds a ticket). */
export const hubUrl = (opts = {}) => findHub({ ...opts, secret: false }).url;

/** x-orrery-sig for one request (v1, docs/hub-discovery.md 4.1). `headers` are the request's own headers. */
export function signRequest(hub, method, path, headers = {}, body = Buffer.alloc(0),
  ts = String(Date.now()), nonce = randomBytes(16).toString('hex')) {
  const values = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const names = new Set(IDENTITY_HEADERS);
  for (const name of values.keys()) if (name.startsWith('x-orrery-') && name !== SIGNATURE_HEADER) names.add(name);
  const lines = [...names].sort().map((name) => `${name}:${values.get(name) ?? ''}`);
  const digest = createHash('sha256').update(body).digest('hex');
  const canonical = ['orrery-req-v1', hub.hubId, hub.claim, hub.url.slice(7), method, path, ...lines, ts, nonce, digest].join('\n');
  return ['v1', hub.hubId, hub.claim, ts, nonce, createHmac('sha256', hub.secret).update(canonical).digest('hex')].join(' ');
}

/** The headers to send: the signature (signed) or the key (legacy) added. Throws not-sent for an unsignable header. */
function authHeaders(hub, method, path, headers, body) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name === SIGNATURE_HEADER || name === SECRET_HEADER || name === 'host') continue;
    if (name.startsWith('x-orrery-') && (typeof v !== 'string' || !HEADER_VALUE.test(v) || v.includes(','))) {
      throw notSent(`请求头 ${name} 的值不能签名。`);
    }
    out[name] = v;
  }
  if (hub.mode === 'legacy') return { ...out, [SECRET_HEADER]: hub.secret };
  return { ...out, host: hub.url.slice(7), [SIGNATURE_HEADER]: signRequest(hub, method, path, out, body) };
}

// shortcut: one agent per process, never destroyed; a program that must exit with requests open calls process.exit.
const direct = new Agent();

/** One HTTP exchange up to the response headers. Rejects with HubError; `sent` says whether a connection was made. */
function exchange(hub, method, path, headers, body, { signal, timeoutMs, agent }) {
  return new Promise((ok, fail) => {
    let sent = false;
    let timedOut = false;
    let timer;
    const failed = (e) => {
      clearTimeout(timer);
      fail(e instanceof HubError ? e : new HubError('unreachable', `连不上 Hub「${hub.name}」（${hub.url}）：${errText(e)}`,
        { hub, sent, timeout: timedOut, cause: e }));
    };
    let req;
    try {
      req = request(`${hub.url}${path}`, { method, agent: agent ?? direct, signal, headers: authHeaders(hub, method, path, headers, body) }, (res) => {
        res.once('close', () => clearTimeout(timer));
        ok({ res, timedOut: () => timedOut, stopTimer: () => clearTimeout(timer) });
      });
    } catch (e) {
      return failed(e);
    }
    req.on('socket', (socket) => {
      if (!socket.connecting) sent = true;
      else socket.once('connect', () => { sent = true; });
    });
    if (timeoutMs) timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error(`等了 ${timeoutMs} ms 没有完整的回答`));
    }, timeoutMs);
    req.on('error', failed);
    req.end(body);
  });
}

async function readText(res, max) {
  let text = '';
  res.setEncoding('utf8');
  for await (const chunk of res) {
    text += chunk;
    if (text.length > max) {
      res.destroy();
      throw new Error('answer too large');
    }
  }
  return text;
}

function reasonOf(text) {
  try {
    const reason = JSON.parse(text)?.reason;
    return typeof reason === 'string' && /^[a-z]{1,20}$/.test(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sends one request; resolves with the exchange once the response is not a 401. A 401 `claim` is retried once at the
 * same Hub after re-reading the registry (see the top of this file); any other 401 rejects with kind 'rejected'.
 */
async function send(method, path, opts, finish) {
  const { headers = {}, body, env = process.env, log } = opts;
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  let hub = opts.hub ?? findHub({ env, log });
  for (let retried = false; ; retried = true) {
    const x = await exchange(hub, method, path, headers, bytes, opts);
    if (x.res.statusCode !== 401) return finish(x, hub);
    let reason;
    try { reason = reasonOf(await readText(x.res, MAX_REJECTION)); } catch { /* no reason */ }
    x.stopTimer();
    if (hub.mode === 'signed' && reason === 'claim' && !retried) {
      let fresh = null;
      try { fresh = findHub({ env, log }); } catch { /* reported as the rejection below */ }
      if (fresh?.mode === 'signed' && fresh.hubId === hub.hubId && fresh.url === hub.url && fresh.claim !== hub.claim) {
        hub = fresh;
        continue;
      }
    }
    throw new HubError('rejected', `Hub「${hub.name}」拒收：${reason ?? 'unauthorized'}`, { hub, reason, status: 401, sent: true });
  }
}

/**
 * One request with a whole answer: resolves { status, text, hub }. Options: headers, body (string or Buffer), signal,
 * timeoutMs (the whole exchange), maxBytes (default 4 MB), env, log, hub (a target from findHub).
 */
export function hubFetch(method, path, opts = {}) {
  return send(method, path, opts, async (x, hub) => {
    try {
      const text = await readText(x.res, opts.maxBytes ?? 4 * 1024 * 1024);
      if (!x.res.complete) throw new Error('连接在回答完整之前断开');
      x.stopTimer();
      return { status: x.res.statusCode, text, hub };
    } catch (e) {
      x.stopTimer();
      throw new HubError('unreachable', `Hub「${hub.name}」的回答不完整：${errText(e)}`, { hub, sent: true, timeout: x.timedOut(), cause: e });
    }
  });
}

/** A GET whose answer is read by the caller (an event stream): resolves { res, hub } once the headers arrive. */
export function hubStream(path, opts = {}) {
  return send('GET', path, opts, (x, hub) => ({ res: x.res, hub }));
}
