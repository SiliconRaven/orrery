// Native Kimi Code: a member is a session the user sees in the Kimi Code desktop app. The app runs Kimi's local
// service (REST + WebSocket) in its own process, on a random 127.0.0.1 port, and registers it under
// <KIMI_CODE_HOME or ~/.kimi-code>/server/instances/<id>.json. The Hub only talks to a service that is already
// running: no instance → offline. It never starts, opens or wakes Kimi (no `kimi` command, no kimi-code:// link).
//
// - online: an instance file on a loopback host whose pid is the app (Kimi Code.exe, or kimi.exe for `kimi web`) and
//   owns the listener on 127.0.0.1:<port> (netstat), checked before the token is sent anywhere; then
//   GET /api/v1/meta answers code 0. (Since 2.4.0 /meta's server_id differs from the instance file's; not compared.)
//   tasklist/netstat can be slow on a busy machine; a query that cannot answer (timeout) is "unknown": it keeps the
//   last real answer, and it never counts as a confirmation, so no connection or wake is attempted on it. At the
//   boundary it is an error (confirmOnline rejects, deliver fails): only a definite "not running" is offline.
// - deliver: POST /api/v1/sessions/<id>/prompts with only `content` and `prompt_id` (= the delivery id), never a model,
//   permission or tool setting and never the session-lock takeover; the turn comes back on the transcript stream
//   (subscribe_v2 at grade 'block', so whole frames and no per-token ones), recognised by turn.triggerPromptId;
// - the member's voice: Kimi's MCP calls name no conversation, so a Kimi member has no orrery tools. When the turn
//   this delivery started ends completed, its answer goes back to the Hub (ctx.reply), which posts it as the member.
// Auth: the user's ~/.kimi-code/server.token, read into memory only, sent only to that 127.0.0.1 service, never logged.
// Protocol facts: read from the desktop app 1.3.2 (embedded service 2.5.1); docs/adapters/kimi.md.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { emptyTranscriptPage, type NativeAdapter, type ProjectInfo, type QuotaSnapshot, type SessionInfo, type TokenTotals } from '../../core/types.ts';
import { createSessionStore, SESSION_ID_RE } from './store.ts';
import { addTokens } from '../shared/jsonl.ts';
import { marker } from '../shared/marker.ts';
import { readKimiTranscript } from './transcript.ts';
import { createKimiUsage, fromOauthUsage, normalize as normalizeUsage } from './usage.ts';
import { connectWs, type WsConnection } from './ws.ts';

const HARNESS = 'kimi';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const APP_IMAGES = new Set(['kimi code.exe', 'kimi.exe']);
const CODE = { ok: 0, unauthorized: 40101, promptNotFound: 40402, promptCompleted: 40903, promptInFlight: 40927, sessionOccupied: 40931 };
const MAIN_AGENT = 'main';
/** tasklist and netstat can take many seconds on a busy machine; a timeout says nothing about the app. */
const APP_QUERY_TIMEOUT_MS = 20_000;
const TURN_ACTIVE = new Set(['queued', 'running']);   // the service reports a blocked turn as failed

export interface KimiNativeOptions {
  /** Kimi's data directory. Default: $KIMI_CODE_HOME or ~/.kimi-code. */
  kimiHome?: string;
  /** Image name of a running process, null when it does not run, undefined when the query could not answer (tests). Default: tasklist on Windows. */
  processImage?: (pid: number) => Promise<string | null | undefined>;
  /** The pid that owns the TCP listener on 127.0.0.1:<port>, null when nobody does, undefined when the query could not answer (tests). Default: netstat on Windows. */
  listenerPid?: (port: number) => Promise<number | null | undefined>;
  /** How old isOnline's cached answer may get before an isOnline call starts a fresh check. */
  appCheckMs?: number;

  /** A session busy in another Kimi process (40931): wait this long between tries, at most this many times. */
  occupiedRetryMs?: number;
  occupiedRetries?: number;
  /** How long a delivered message may wait in Kimi's queue for its turn to start before it is taken back. */
  pickupTimeoutMs?: number;
  /** Longest a single request to the Kimi service may take. */
  requestTimeoutMs?: number;
  /** Longest the event subscription may take: its ack comes after Kimi has loaded the session and its history. */
  subscribeTimeoutMs?: number;
  /** Quota: at most one oauth/usage request per this long without an explicit refresh, and per refreshMinMs with one. */
  quotaEveryMs?: number;
  quotaRefreshMinMs?: number;
}

export interface KimiInstance { serverId: string; pid: number; port: number; startedAt: number }

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Instance files on a loopback host with sane fields, newest first. A file may outlive its app: check the pid. */
export async function readInstances(kimiHome: string): Promise<KimiInstance[]> {
  const dir = join(kimiHome, 'server', 'instances');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: KimiInstance[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const f = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (!isObject(f) || typeof f.server_id !== 'string' || !f.server_id || !Number.isInteger(f.pid) || f.pid <= 0) continue;
      if (!LOOPBACK.has(f.host) || !Number.isInteger(f.port) || f.port <= 0 || f.port > 65535) continue;
      out.push({ serverId: f.server_id, pid: f.pid, port: f.port, startedAt: typeof f.started_at === 'number' ? f.started_at : 0 });
    } catch { /* being written, or not JSON */ }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The image name of process `pid`; null when it does not run; undefined when tasklist could not answer (it timed out
 * or failed), which says nothing about the app. Checks the pid exists first, so stale instance files cost no process
 * start. shortcut: the image is checked on Windows only; elsewhere a live pid counts as the app.
 */
export function processImage(pid: number): Promise<string | null | undefined> {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return Promise.resolve(null);
  }
  if (process.platform !== 'win32') return Promise.resolve('kimi.exe');
  return new Promise((done) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: APP_QUERY_TIMEOUT_MS }, (err, stdout) => {
      if (err) return done(undefined);   // no answer: unknown, not "not running"
      const m = /^"([^"]+)","(\d+)"/m.exec(stdout);
      done(m && Number(m[2]) === pid ? m[1] : null);
    });
  });
}

/**
 * Who listens on 127.0.0.1:<port>, from `netstat -ano -p TCP` output: the pid of the listening rows for 127.0.0.1:<port>
 * and 0.0.0.0:<port> (both take connections to 127.0.0.1), when there is at least one 127.0.0.1 row and they all name
 * the same pid; else null. A listening row is recognised by its foreign address 0.0.0.0:0, so the state word may be
 * in any language.
 */
export function listenerOwner(netstat: string, port: number): number | null {
  const pids = new Set<number>();
  let loopback = false;
  for (const line of netstat.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(127\.0\.0\.1|0\.0\.0\.0):(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/.exec(line);
    if (!m || Number(m[2]) !== port) continue;
    if (m[1] === '127.0.0.1') loopback = true;
    pids.add(Number(m[3]));
  }
  return loopback && pids.size === 1 ? [...pids][0] : null;
}

/**
 * The pid owning the listener on 127.0.0.1:<port>; null when nobody does; undefined when netstat could not answer
 * (it timed out or failed), which says nothing about the app. shortcut: Windows only (netstat's format); elsewhere the
 * listener is not checked and the instance file's pid is taken. Upgrade with lsof / ss when other platforms matter.
 */
export function listenerPid(port: number, filePid: number): Promise<number | null | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(filePid);
  return new Promise((done) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: APP_QUERY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      done(err ? undefined : listenerOwner(stdout, port));   // no answer: unknown, not "nobody listens"
    });
  });
}

/** The first line of everything delivered into Kimi, which shows it as the user's own message (shared with Cursor). */
export { marker };

interface Reply { status: number; code: number | null; msg: string; data: unknown }

/** One request to the Kimi service on 127.0.0.1. No agent, no proxy, no redirects; errors never carry the token. */
function call(port: number, token: string, method: string, path: string, timeoutMs: number, body?: unknown): Promise<Reply> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = request({
      host: '127.0.0.1', port, path, method, agent: false, timeout: timeoutMs,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', () => fail(new Error('the Kimi service connection broke')));
      res.on('end', () => {
        let env: unknown = null;
        try { env = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        const e = isObject(env) ? env : {};
        done({ status: res.statusCode ?? 0, code: typeof e.code === 'number' ? e.code : null, msg: typeof e.msg === 'string' ? e.msg : '', data: e.data });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) => fail(Object.assign(new Error(`the Kimi service did not answer (${e.code ?? 'error'})`), { code: e.code })));
    req.end(payload);
  });
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((done, fail) => {
  if (signal.aborted) return fail(new Error('aborted'));
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); done(); }, ms);
  const onAbort = () => { clearTimeout(t); fail(new Error('aborted')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

interface Service { serverId: string; port: number; token: string }

/** A frame of Kimi's event stream: `{ type, session_id?, timestamp, payload }`; an ack: `{ type: 'ack', id, code, payload }`. */
interface Frame { type?: unknown; id?: unknown; code?: unknown; session_id?: unknown; payload?: any }

/** The one event connection to the running service, shared by the deliveries. */
interface Link {
  conn: WsConnection | null;
  serverId: string;
  acks: Map<string, (f: Frame | null) => void>;
  listeners: Set<(f: Frame) => void>;
  onClose: Set<() => void>;
  nextId: number;
}

export function createKimiNativeAdapter(opts: KimiNativeOptions = {}): NativeAdapter {
  const kimiHome = resolve(opts.kimiHome ?? (process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')));
  const store = createSessionStore(kimiHome);
  const imageOf = opts.processImage ?? processImage;
  const ownerOf = (inst: KimiInstance) => (opts.listenerPid ? opts.listenerPid(inst.port) : listenerPid(inst.port, inst.pid));
  // The Hub's status check (recheckMs, 10 s) asks confirmOnline anyway; a shorter age only added tasklist + netstat runs.
  const appCheckMs = opts.appCheckMs ?? 10_000;

  const occupiedRetryMs = opts.occupiedRetryMs ?? 2_000;
  const occupiedRetries = opts.occupiedRetries ?? 15;
  const pickupTimeoutMs = opts.pickupTimeoutMs ?? 30 * 60_000;
  const timeoutMs = opts.requestTimeoutMs ?? 15_000;
  const subscribeTimeoutMs = opts.subscribeTimeoutMs ?? 60_000;
  const quotaEveryMs = opts.quotaEveryMs ?? 5 * 60_000;
  const quotaRefreshMinMs = opts.quotaRefreshMinMs ?? 10_000;
  const usage = createKimiUsage(kimiHome);
  let quotaAt = -Infinity;   // when oauth/usage was last asked
  let quotaLast: QuotaSnapshot | null = null;
  let closed = false;

  const readToken = async (): Promise<string | null> => {
    try {
      const t = (await readFile(join(kimiHome, 'server.token'), 'utf8')).trim();
      return /^[\x21-\x7e]{1,4096}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  };

  /**
   * The running service, checked now: instance file → process image → the app's pid owns the 127.0.0.1 listener on the
   * file's port → /api/v1/meta answers code 0. The token goes out only after the listener check. Null: not running.
   * 'unknown': a tasklist/netstat/meta query could not answer (busy machine); that is not proof it stopped.
   * The service is known by the instance file's server_id (since 2.4.0 /meta reports a different one).
   */
  const discover = async (): Promise<Service | null | 'unknown'> => {
    const instances = await readInstances(kimiHome);
    let unanswered = false;
    for (const inst of instances) {
      const image = await imageOf(inst.pid).catch(() => undefined);
      if (image === undefined) return 'unknown';
      if (!image || !APP_IMAGES.has(image.toLowerCase())) continue;
      const owner = await ownerOf(inst).catch(() => undefined);
      if (owner === undefined) return 'unknown';
      if (owner !== inst.pid) continue;
      const token = await readToken();
      if (!token) return null;
      try {
        const meta = await call(inst.port, token, 'GET', '/api/v1/meta', timeoutMs);
        if (meta.code === CODE.ok && isObject(meta.data)) return { serverId: inst.serverId, port: inst.port, token };
      } catch { unanswered = true; /* no answer: could be busy, not proof it is gone */ }
    }
    return unanswered ? 'unknown' : null;
  };

  // isOnline answers from a cache that its own calls refresh once older than appCheckMs (no timer of its own), and
  // never while any check is running: the age counts from when a check's answer arrived, so a check slower than
  // appCheckMs (netstat on a busy machine) does not start the next one at once.
  // A check that cannot answer only delays the next refresh and keeps the last real answer; it never confirms the
  // app runs, so deliver()/quota() make no connection or wake on it. Each try is its own query, numbered when it
  // starts: an older query's real answer never overwrites a newer one and never confirms over a newer "not running".
  // The cache time goes with the answer: it is set only by a try whose answer is applied (or, for an unanswered try,
  // that is newer than every applied or unanswered one), so a late stale answer cannot make an old state look fresh.
  let service: Service | null = null;
  let checkedAt = -Infinity;
  let seq = 0;
  let applied = 0;
  let unknownSeq = 0;
  let downSeq = 0;
  let checking = 0;   // checks running now (background refresh, confirmOnline, deliveries, quota)
  /**
   * A check made now: true only on a confirmation, false only on a definite "not running", 'unknown' when a query could
   * not answer.
   */
  const fresh = async (): Promise<boolean | 'unknown'> => {
    checking++;
    try { return await freshTries(); } finally { checking--; }
  };
  const freshTries = async (): Promise<boolean | 'unknown'> => {
    let found: Service | null = null;
    let known = false;
    let last = 0;
    for (let tries = 0; tries < 2 && !known; tries++) {
      last = ++seq;
      let result: Service | null | 'unknown';
      try { result = closed ? null : await discover(); } catch { result = 'unknown'; }
      if (result === 'unknown') {
        // A try without an answer only delays the next refresh (a short back-off), and only when it is the newest.
        if (last > Math.max(applied, unknownSeq)) { unknownSeq = last; checkedAt = Date.now(); }
        continue;
      }
      known = true;
      found = result;
      if (last > applied) {
        applied = last;
        checkedAt = Date.now();
        service = found;
        if (!found || (link && link.serverId !== found.serverId)) dropLink();
      }
      if (!found) downSeq = Math.max(downSeq, last);
    }
    if (!known) return 'unknown';   // not confirmed: no connection and no wake, and never "not running"
    return found !== null && downSeq < last;
  };
  const isUp = (): boolean => {
    if (checking === 0 && Date.now() - checkedAt >= appCheckMs) void fresh();
    return service !== null;
  };
  /**
   * Whether anything may be connected to or woken. False is a definite "not running" (the caller reports 'offline');
   * an unanswered check throws, so nothing is sent and the Hub records a failed delivery, not an offline one — the app
   * may well be running.
   */
  const UNKNOWN = 'could not check whether Kimi Code is running (tasklist/netstat did not answer)';
  const confirmedNow = async (): Promise<boolean> => {
    const up = await fresh();
    if (up === 'unknown') throw new Error(`${UNKNOWN}; the delivery was not sent`);
    return up;
  };

  // ---- the event connection ----
  let link: Link | null = null;
  const linking = new Map<string, Promise<Link>>();   // connections being opened, by server id


  const dropLink = () => {
    const l = link;
    link = null;
    l?.conn?.close();
  };

  const onFrame = (l: Link, text: string) => {
    let f: Frame;
    try { f = JSON.parse(text); } catch { return; }
    if (!isObject(f)) return;
    if (f.type === 'ping') {
      // The service closes a connection that stays silent for two heartbeats.
      l.conn?.send(JSON.stringify({ type: 'pong', payload: { nonce: isObject(f.payload) ? f.payload.nonce : undefined } }));
      return;
    }
    if (f.type === 'ack' && typeof f.id === 'string') {
      l.acks.get(f.id)?.(f);
      return;
    }
    for (const fn of l.listeners) fn(f);
  };

  /** The event connection to service `s`: never one being opened to another instance (Kimi restarted meanwhile). */
  const getLink = (s: Service): Promise<Link> => {
    if (link && link.serverId === s.serverId && link.conn && !link.conn.closed) return Promise.resolve(link);
    const opening = linking.get(s.serverId);
    if (opening) return opening;
    const p = (async () => {
      const l: Link = { conn: null, serverId: s.serverId, acks: new Map(), listeners: new Set(), onClose: new Set(), nextId: 1 };
      l.conn = await connectWs({
        port: s.port, path: '/api/v1/ws', protocols: [`kimi-code.bearer.${s.token}`], timeoutMs,
        onMessage: (text) => onFrame(l, text),
        onClose: () => {
          if (link === l) link = null;
          for (const ack of l.acks.values()) ack(null);
          for (const fn of l.onClose) fn();
        },
      });
      // A newer check may have found another instance while this one was connecting: then this connection is stale.
      if (closed || l.conn.closed || service?.serverId !== l.serverId) {
        l.conn.close();
        throw new Error('the Kimi event connection closed (Kimi Code restarted?)');
      }
      if (link !== l) dropLink();
      link = l;
      l.conn.send(JSON.stringify({ type: 'client_hello', id: `orrery-${l.nextId++}`, payload: { client_id: 'orrery' } }));
      return l;
    })().finally(() => { linking.delete(s.serverId); });
    linking.set(s.serverId, p);
    return p;
  };

  /**
   * Subscribes the link to the main agent's transcript of this session; resolves with whether the service knows the
   * session. Done for every delivery: the same grade again leaves a live stream as it is, and the ack only comes once
   * the stream is ready, also after Kimi closed and reopened the session.
   */
  const subscribe = (l: Link, sessionId: string, signal: AbortSignal): Promise<boolean> => new Promise((done, fail) => {
    const id = `orrery-${l.nextId++}`;
    const closed = 'the Kimi event connection closed before the subscription was confirmed';
    const finish = (error: string | null, known = false) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      l.acks.delete(id);
      if (error) fail(new Error(error));
      else done(known);
    };
    const onAbort = () => finish('delivery aborted');
    const timer = setTimeout(() => {
      finish(`the Kimi service did not confirm the event subscription within ${Math.round(subscribeTimeoutMs / 1000)} s; this Kimi Code version may be incompatible with orrery`);
    }, subscribeTimeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    l.acks.set(id, (f) => {
      if (!f) finish(closed);
      else if (f.code !== 0) finish(`the Kimi service refused the event subscription (${String(f.code)})`);
      else finish(null, isObject(f.payload) && Array.isArray(f.payload.accepted) && f.payload.accepted.includes(sessionId));
    });
    const frame = { type: 'subscribe_v2', id, payload: { session_id: sessionId, transcript: { [MAIN_AGENT]: 'block' } } };
    if (!l.conn?.send(JSON.stringify(frame))) finish(closed);
  });


  const checkId = (sessionId: string) => {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`not a Kimi session id: ${JSON.stringify(sessionId)}`);
  };

  return {
    harness: HARNESS,
    replies: true,
    localSessions: true,   // attachSession reads only local files: the member list shows the current title and model
    listProjects: (): Promise<ProjectInfo[]> => store.listProjects(),
    listSessions: (projectPath: string): Promise<SessionInfo[]> => store.listSessions(projectPath),
    async attachSession(sessionId) {
      checkId(sessionId);
      const info = await store.get(sessionId);
      if (!info) throw new Error(`kimi session ${sessionId} not found under ${kimiHome}`);
      return info;
    },

    isOnline: () => isUp(),
    confirmOnline: () => confirmedNow(),

    /**
     * oauth/usage of the running app (it asks Kimi's server): at most every quotaEveryMs, or on refresh at most every
     * quotaRefreshMinMs; in between the last answer. Not running, or not confirmed by a check made now → null, and
     * nothing is asked: a cached isOnline (the last real answer) is no licence to send the token.
     */
    async quota({ refresh }) {
      const since = Date.now() - quotaAt;
      if (since < (refresh ? quotaRefreshMinMs : quotaEveryMs)) return quotaLast;
      if ((await fresh()) !== true) return null;
      const s = service;
      if (!s) return null;
      quotaAt = Date.now();
      const r = await call(s.port, s.token, 'GET', '/api/v1/oauth/usage', timeoutMs);
      if (r.code !== CODE.ok) throw new Error(`Kimi Code refused the usage request: ${r.code ?? `HTTP ${r.status}`} ${r.msg}`.trim());
      quotaLast = fromOauthUsage(r.data, new Date().toISOString());
      return quotaLast;
    },

    conversationTokens: (sessionId: string) => (SESSION_ID_RE.test(sessionId) ? usage.sessionTokens(sessionId) : Promise.resolve(null)),

    async transcript(sessionId, request) {
      if (!SESSION_ID_RE.test(sessionId)) return emptyTranscriptPage('refused');
      const candidates = await store.transcriptCandidates(sessionId);
      return readKimiTranscript(join(kimiHome, 'sessions'), candidates, sessionId, request);
    },


    async deliver(sessionId, text, ctx) {
      checkId(sessionId);
      const { deliveryId, signal } = ctx;
      if (!(await confirmedNow())) return 'offline';
      const s = service!;
      let l: Link;
      try {
        l = await getLink(s);
      } catch (e) {
        if (!(await confirmedNow())) return 'offline';
        throw e;
      }
      // Events and the submit must go to the same service.
      if (l.serverId !== s.serverId) throw new Error('the Kimi event connection belongs to another Kimi Code instance');

      // Listen before submitting: the turn can start before the submit answers.
      let turn: string | null = null;
      let started = false;
      // By id, because the service upserts: a text frame comes empty and again whole, a step again once it has usage.
      const texts = new Map<unknown, string>();
      const steps = new Map<unknown, TokenTotals>();
      type End = { state: unknown; error?: unknown } | { lost: true } | { timeout: true } | { aborted: true };
      const end = Promise.withResolvers<End>();
      const listener = (f: Frame) => {
        if (f.type !== 'transcript.ops' || f.session_id !== sessionId || !isObject(f.payload)) return;
        if (f.payload.agent_id !== MAIN_AGENT || !Array.isArray(f.payload.ops)) return;
        for (const op of f.payload.ops) {
          if (op?.op === 'turn.upsert' && isObject(op.turn)) {
            if (op.turn.triggerPromptId === deliveryId && typeof op.turn.turnId === 'string') turn = op.turn.turnId;
            if (turn !== null && op.turn.turnId === turn) {
              if (op.turn.state === 'running') started = true;
              if (typeof op.turn.state === 'string' && !TURN_ACTIVE.has(op.turn.state)) {
                end.resolve({ state: op.turn.state, error: op.turn.error });
              }
            }
          } else if (turn === null || op?.turnId !== turn) continue;
          else if (op.op === 'frame.upsert' && op.frame?.kind === 'text' && op.frame.role === 'assistant' && typeof op.frame.text === 'string') {
            texts.set(op.frame.frameId, op.frame.text);
          } else if (op.op === 'step.upsert') {
            const t = normalizeUsage(op.step?.usage);
            if (t) steps.set(op.step.stepId, t);
          }
        }
      };
      const lost = () => end.resolve({ lost: true });
      const onAbort = () => end.resolve({ aborted: true });
      const pickup = setTimeout(() => { if (!started) end.resolve({ timeout: true }); }, pickupTimeoutMs);
      l.listeners.add(listener);
      l.onClose.add(lost);
      signal.addEventListener('abort', onAbort, { once: true });
      /** Attempts withdrawal; a response does not prove whether the prompt was actually taken back. */
      const abortPrompt = async (): Promise<string> => {
        try {
          const r = await call(s.port, s.token, 'POST', `/api/v1/sessions/${sessionId}/prompts/${encodeURIComponent(deliveryId)}:abort`, timeoutMs);
          if (r.code === CODE.promptCompleted) return '; Kimi reports the prompt already ran (40903); its outcome is unknown';
          if (r.code === CODE.ok) return '; Kimi acknowledged the abort (0), but withdrawal is unconfirmed; the prompt may have run or may still run';
          if (r.code === CODE.promptNotFound) return '; Kimi did not find the prompt (40402); it may have run or may still run';
          return `; taking it back out of the Kimi queue failed (${r.code ?? `HTTP ${r.status}`}); it may have run or may still run`;
        } catch (e) {
          return `; taking it back out of the Kimi queue failed (${e instanceof Error ? e.message : String(e)}); it may have run or may still run`;
        }
      };
      try {
        if (!(await subscribe(l, sessionId, signal))) {
          throw new Error(`kimi session ${sessionId} was not found by the running Kimi Code`);
        }
        // Only content and prompt_id: anything else (model, thinking, permission_mode, disabled_tools, ...) would
        // change the user's session settings.
        const body = { content: [{ type: 'text', text: `${marker(ctx.from)}\n${text}` }], prompt_id: deliveryId };
        let retriedAuth = false;
        for (let attempt = 0; ; attempt++) {
          if (signal.aborted) throw new Error('delivery aborted');
          let r: Reply;
          try {
            r = await call(s.port, s.token, 'POST', `/api/v1/sessions/${sessionId}/prompts`, timeoutMs, body);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
              // Never reached Kimi. Offline only on a definite "not running"; an unanswered check keeps the error.
              const up = await fresh();
              if (up === 'unknown') throw new Error(`${msg}; ${UNKNOWN}`);
              if (!up) return 'offline';
              throw e;
            }
            // A timeout or reset may follow acceptance; only attempt withdrawal before an observed start.
            const note = started ? '; the turn may still be running' : await abortPrompt();
            return { outcome: 'unknown', error: `${msg}${note}` };
          }
          if (r.code === CODE.ok) break;
          // These duplicate-ID replies do not establish that the earlier turn succeeded.
          if (r.code === CODE.promptInFlight || r.code === CODE.promptCompleted) {
            return { outcome: 'unknown', error: `Kimi already knows this prompt ID (${r.code}); its turn outcome is unknown` };
          }
          if ((r.status === 401 || r.code === CODE.unauthorized) && !retriedAuth) {
            retriedAuth = true;   // the token may have been rotated (kimi web rotate-token)
            const t = await readToken();
            if (t) s.token = t;
            continue;
          }
          // Another Kimi process is running this session: wait for it, never take the session over.
          if (r.code === CODE.sessionOccupied && attempt < occupiedRetries) {
            await sleep(occupiedRetryMs, signal).catch(() => {});
            continue;
          }
          if (r.code === CODE.sessionOccupied) throw new Error('the Kimi session stayed busy in another Kimi Code process; the message was not delivered');
          throw new Error(`Kimi Code refused the message: ${r.code ?? `HTTP ${r.status}`} ${r.msg}`.trim());
        }

        const outcome = await end.promise;
        if ('aborted' in outcome) {
          const note = started ? '; the turn may still be running' : await abortPrompt();
          return { outcome: 'unknown', error: `delivery aborted${note}` };
        }
        if ('timeout' in outcome) {
          const note = await abortPrompt();
          return { outcome: 'unknown', error: `Kimi did not report starting the message within ${Math.round(pickupTimeoutMs / 60_000)} min${note}` };
        }
        // shortcut: no version-verified, side-effect-free recovery for this turn yet; recheck when such an API is verified.
        if ('lost' in outcome) return { outcome: 'unknown', error: 'Kimi accepted the message, but the event connection closed before its outcome was observed' };
        // Tokens were spent whether or not the turn completed.
        if (steps.size) ctx.usage?.([...steps.values()].reduce((sum, t) => addTokens(sum, t)));
        if (outcome.state === 'completed') {
          // Only this turn's text (the one this delivery triggered); an empty answer posts nothing.
          const reply = [...texts.values()].join('');
          if (reply.trim()) {
            ctx.onEvent({ type: 'text', text: reply });
            ctx.reply?.(reply.trim());
          }
          return 'completed';
        }
        const why = typeof outcome.error === 'string' && outcome.error ? `: ${outcome.error}` : '';
        if (outcome.state === 'failed' || outcome.state === 'cancelled') {
          return { outcome: 'failed', error: `the Kimi turn ended ${outcome.state}${why}` };
        }
        return { outcome: 'unknown', error: `Kimi reported an unrecognized turn state (${String(outcome.state)}); it may still be running${why}` };
      } finally {
        clearTimeout(pickup);
        signal.removeEventListener('abort', onAbort);
        l.listeners.delete(listener);
        l.onClose.delete(lost);
      }
    },

    async close() {
      closed = true;
      dropLink();
    },
  };
}
