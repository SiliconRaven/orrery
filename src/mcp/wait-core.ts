// The background-wait route, shared by every harness on it (docs/adapters/zcode.md, "共用等待核心"). A harness whose app
// starts a turn when a background command exits needs no way in for a Hub: the member, asked once by its user, runs
// orrery's wait command (plugins/zcode-orrery/wait.mjs) with a ticket for this conversation. It holds
// GET /bridge/<harness>-wait; the Hub ends it only to deliver (the envelope, printed into the command's output, then the
// command exits and the app runs a turn), and the member runs the same command again at the end of that turn. This
// module holds, per harness (core/types.ts WaitHarness):
//   - who a caller is: the conversation id at _meta[metaKey];
//   - a v2 ticket scoped to the issuing Hub and conversation. The same Hub accepts it after a restart.
//   - the wait connections, per session (in memory). Anti-loop rules, since every exit costs a turn:
//       1. the Hub ends a wait only to deliver, or (3) when the conversation is no member any more;
//       2. a second wait of the same session is held aside (kept open, never delivered to) and takes over when the
//          active one is used for a delivery, so a duplicate never makes the old one exit;
//       4. at most ARM_LIMIT waits per session per ARM_WINDOW_MS are taken; later ones are only held, never used.
//     A wait that delivered is gone from the Hub's bridge registry at once, so the next connection of the session is
//     the member's re-arm: the adapter (src/adapters/shared/wait-native.ts) takes that as the end of the batch.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { HUB_ID_RE } from '../bridge-protocol.ts';
import type { Hub } from '../core/hub.ts';
import { UNSAFE_PATH } from '../core/projects.ts';
import type { WaitHarness } from '../core/types.ts';

export const TICKET_HEADER = 'x-orrery-ticket';
export const WAIT_DESCRIPTION = 'orrery：等群消息';
export const ARM_LIMIT = 10;
export const ARM_WINDOW_MS = 10 * 60_000;
const HEARTBEAT_MS = 25_000;
const MAX_BODY = 4096;
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TICKET_BODY = /^([A-Za-z0-9._-]{1,128})\.([0-9a-f]{64})$/;
/** What wait.mjs accepts for its harness and ancestor arguments: nothing a shell would interpret. */
const HARNESS_ARG = /^[a-z][a-z0-9-]{0,31}$/;
const PROCESS_ARG = /^[A-Za-z0-9._-]{1,64}$/;

/** The wait script, with forward slashes (bash and cmd both take them). */
export const WAIT_SCRIPT = resolve(import.meta.dirname, '../../plugins/zcode-orrery/wait.mjs').replaceAll('\\', '/');

const prefixOf = (h: WaitHarness, hubId: string) => `${h.harness[0]}2.${hubId}.`;
const tagOf = (h: WaitHarness, secret: string, hubId: string, sessionId: string) =>
  createHmac('sha256', secret).update(`orrery-${h.harness}-wait-v2\n${hubId}\n${sessionId}`).digest('hex');

export function ticketFor(h: WaitHarness, secret: string, sessionId: string, hubId: string): string {
  if (!HUB_ID_RE.test(hubId)) throw new Error('Invalid Hub ID for wait ticket');
  if (!SESSION_RE.test(sessionId)) throw new Error(`这个 ${h.appProcess.replace(/\.exe$/i, '')} 会话 id 含有不能放进命令行的字符`);
  return `${prefixOf(h, hubId)}${sessionId}.${tagOf(h, secret, hubId, sessionId)}`;
}

/** The session a ticket was made for, or null when it is malformed or not signed with this secret. Constant-time. */
export function ticketSession(h: WaitHarness, secret: string, ticket: unknown, hubId: string): string | null {
  const prefix = prefixOf(h, hubId);
  const m = typeof ticket === 'string' && ticket.startsWith(prefix) ? TICKET_BODY.exec(ticket.slice(prefix.length)) : null;
  if (!m) return null;
  return timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(tagOf(h, secret, hubId, m[1]), 'hex')) ? m[1] : null;
}

/** The issuing Hub's own address, from the port the request came in on (the Hub listens on 127.0.0.1 only). */
export const hubUrlOf = (req: IncomingMessage): string => `http://127.0.0.1:${req.socket.localPort}`;

/**
 * The command the member runs in the background. It names the Hub that issued it: the app's shell has no ORRERY_HOME,
 * so hub.json would point at whichever Hub owns ~/.orrery. Byte-identical for a session as long as the secret, the
 * orrery path and the Hub's port stay.
 */
export function waitCommand(h: WaitHarness, ticket: string, hubUrl: string, script = WAIT_SCRIPT): string {
  if (UNSAFE_PATH.test(script)) throw new Error(`orrery 所在的路径 ${script} 含有 shell 会解释的字符，等待命令放不进去`);
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(hubUrl)) throw new Error(`not a loopback Hub address: ${hubUrl}`);
  const command = `node "${script}" ${ticket} ${hubUrl}`;
  if (h.legacyWire) return command;
  if (!HARNESS_ARG.test(h.harness) || (h.ancestorProcess !== null && !PROCESS_ARG.test(h.ancestorProcess))) throw new Error(`harness settings cannot go into the command: ${h.harness}`);
  return `${command} ${h.harness}${h.ancestorProcess === null ? '' : ` ${h.ancestorProcess}`}`;
}

/** A session id at `key` of a tools/call's _meta (or of `nested`, when the runtime keeps a second copy there). */
export function metaSession(key: string | undefined, meta: Record<string, unknown> | undefined, nested?: Record<string, unknown>): string | undefined {
  if (!key) return undefined;   // this harness names its conversation in trusted request headers instead
  const v = meta?.[key] ?? nested?.[key];
  return typeof v === 'string' && v ? v : undefined;
}

/** What a legacyWire member reads after the envelope: handle each message once, then run the same command again. */
export function tail(command: string): string {
  return '\n\n----------\n（orrery 等待命令）上面是 orrery 投给你的消息。每条消息只处理一次：按 messageId 认，已经处理过的不要再回复。'
    + `处理完以后，用 Bash 在后台（run_in_background: true）再运行同一条命令，description 写「${WAIT_DESCRIPTION}」：\n${command}\n`
    + '这一轮已经有这条命令在后台运行时，不要再运行第二条。如果这条命令是被停止的（不是正常结束），不要重新运行，也不要再处理之前已经处理过的消息。\n';
}

export const NOT_MEMBER_TEXT = 'orrery：这个对话已不在任何 orrery 群里（或已被移出），不要重新运行这条命令。\n';

interface Wait { res: ServerResponse; usable: boolean; hubUrl: string }
interface SessionWaits {
  active: { wait: Wait; disconnect: () => void; replaced: boolean } | null;
  held: Wait[];
  arms: number[];
  told: Set<string>;   // guard notices already raised in this state (cleared when it changes)
}

/** The wait connections of one harness on one Hub. Made on first use (waitsOf). */
export class WaitRegistry {
  private readonly sessions = new Map<string, SessionWaits>();
  // Per session, the last delivery a wait took, until acked (a session has one at a time). Kept after the wait's
  // connection closes: wait.mjs may hang up before its ack arrives.
  private readonly sent = new Map<string, { deliveryId: string; wait: Wait }>();
  private readonly unsubscribe: () => void;
  private readonly h: WaitHarness;
  private readonly hub: Hub;
  private readonly secret: string;
  private readonly now: () => number;

  constructor(h: WaitHarness, hub: Hub, secret: string, now = () => Date.now()) {
    this.h = h;
    this.hub = hub;
    this.secret = secret;
    this.now = now;
    // Rule 3: a conversation that is no member any more (removed, or the member moved away from it) is told once to stop.
    this.unsubscribe = hub.subscribe((e) => {
      if (e.kind !== 'member') return;
      const { member: m, rebind } = e.payload as { member?: { harness?: string; workerSessionId?: string; removedAt?: string | null }; rebind?: { fromSessionId: string } };
      const left = rebind?.fromSessionId ?? (m?.removedAt ? m.workerSessionId : undefined);
      if (m?.harness === h.harness && left && this.sessions.has(left) && !hub.nativeCallers(h.harness, left).length) this.endAll(left, NOT_MEMBER_TEXT);
    });
  }

  close(): void {
    this.unsubscribe();
  }

  /** How many waits the session has open (active and held). */
  count(sessionId: string): number {
    const s = this.sessions.get(sessionId);
    return s ? (s.active ? 1 : 0) + s.held.length : 0;
  }

  /** GET /bridge/<harness>-wait, ticket in x-orrery-ticket. */
  open(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = ticketSession(this.h, this.secret, req.headers[TICKET_HEADER], this.hub.bridgeHubId);
    if (sessionId === null) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'ticket invalid' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    if (!this.hub.nativeCallers(this.h.harness, sessionId).length) {
      end(res, NOT_MEMBER_TEXT);
      return;
    }
    const s = this.sessions.get(sessionId) ?? { active: null, held: [], arms: [], told: new Set<string>() };
    this.sessions.set(sessionId, s);
    const t = this.now();
    s.arms = s.arms.filter((a) => t - a < ARM_WINDOW_MS);
    const usable = s.arms.length < ARM_LIMIT;
    if (usable) s.arms.push(t);
    const wait: Wait = { res, usable, hubUrl: hubUrlOf(req) };
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    beat.unref();
    res.on('close', () => {
      clearInterval(beat);
      this.closed(sessionId, wait);
    });
    if (!usable) this.notice(sessionId, s, `${this.h.harness}_arm_rate`, { maxArms: ARM_LIMIT, windowMinutes: ARM_WINDOW_MS / 60_000 });
    if (usable && !s.active) this.activate(sessionId, s, wait);
    else {
      s.held.push(wait);
      if (usable) this.notice(sessionId, s, `${this.h.harness}_extra_wait`, { waits: this.count(sessionId) });
    }
  }

  /** POST /bridge/<harness>-ack { ticket, deliveryId }: wait.mjs printed the delivery. */
  async ack(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid ack' }));
      return;
    }
    const sessionId = ticketSession(this.h, this.secret, body?.ticket, this.hub.bridgeHubId);
    if (sessionId === null) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'ticket invalid' }));
      return;
    }
    const id = body?.deliveryId;
    const sent = this.sent.get(sessionId);
    const acked = typeof id === 'string' && sent?.deliveryId === id && this.hub.ackBridge(id, true);
    if (acked) {
      this.sent.delete(sessionId);
      sent.wait.res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ acked }));
  }

  private activate(sessionId: string, s: SessionWaits, wait: Wait): void {
    s.told.delete(`${this.h.harness}_extra_wait`);
    const entry: NonNullable<SessionWaits['active']> = { wait, disconnect: () => {}, replaced: false };
    s.active = entry;
    entry.disconnect = this.hub.connectBridge(this.h.harness, sessionId, {
      send: (e) => {
        // Spent at once: off the bridge registry before anything else can be pushed, so the next connection of this
        // session is the member's re-arm. A held wait takes over (rule 2).
        this.sent.set(sessionId, { deliveryId: e.deliveryId, wait });
        this.release(sessionId, s, entry);
        const text = this.h.legacyWire ? e.text + tail(waitCommand(this.h, ticketFor(this.h, this.secret, sessionId, this.hub.bridgeHubId), wait.hubUrl)) : e.text;
        wait.res.write(`event: deliver\ndata: ${JSON.stringify({ deliveryId: e.deliveryId, text })}\n\n`);
      },
      // The Hub is closing: end the stream without a delivery; wait.mjs reconnects to the next Hub instead of exiting.
      // Not when a held wait replaces this one in the registry (release): this stream may still carry its delivery.
      close: () => { if (!entry.replaced) wait.res.end(); },
    });
    // Used up while registering (the Hub delivered at once): release ran with the placeholder disconnect.
    if (s.active !== entry) entry.disconnect();
  }

  /**
   * The active wait is used up (delivered) or gone: the oldest usable held wait takes over, then the old one leaves the
   * registry. In that order, so the scheduler never sees the session without a wait in between (it would mark the
   * queued deliveries offline for good).
   */
  private release(sessionId: string, s: SessionWaits, entry: NonNullable<SessionWaits['active']>): void {
    if (s.active !== entry) return;
    s.active = null;
    const next = s.held.findIndex((w) => w.usable);
    if (next >= 0) {
      entry.replaced = true;   // connectBridge replaces it: no bridgeChanged for it, and its stream stays open
      this.activate(sessionId, s, s.held.splice(next, 1)[0]);
    }
    entry.disconnect();
  }

  private closed(sessionId: string, wait: Wait): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.active?.wait === wait) this.release(sessionId, s, s.active);
    else s.held = s.held.filter((w) => w !== wait);
    if (!s.active && !s.held.length && !s.arms.length) this.sessions.delete(sessionId);
  }

  private endAll(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const waits = [...(s.active ? [s.active.wait] : []), ...s.held];
    if (s.active) {
      const { disconnect } = s.active;
      s.active = null;
      disconnect();
    }
    s.held = [];
    for (const w of waits) end(w.res, text);
  }

  /** A loop-guard notice on the member pages, once per state. */
  private notice(sessionId: string, s: SessionWaits, reason: string, extra: Record<string, unknown>): void {
    if (s.told.has(reason)) return;
    s.told.add(reason);
    this.hub.guardSession(this.h.harness, sessionId, { reason, ...extra });
  }
}

function end(res: ServerResponse, text: string): void {
  res.end(`event: end\ndata: ${JSON.stringify({ text })}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const registries = new WeakMap<Hub, Map<string, WaitRegistry>>();

/** The wait registry of this harness on this Hub, made on first use. */
export function waitsOf(h: WaitHarness, hub: Hub, secret: string): WaitRegistry {
  let perHub = registries.get(hub);
  if (!perHub) registries.set(hub, perHub = new Map());
  let w = perHub.get(h.harness);
  if (!w) perHub.set(h.harness, w = new WaitRegistry(h, hub, secret));
  return w;
}
