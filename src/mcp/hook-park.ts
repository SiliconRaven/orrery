// The parked-hook route, for a harness whose app runs orrery's hooks at the start and end of every turn (Cursor,
// docs/adapters/cursor.md). Both routes sit behind the bridge secret (./bridge.ts dispatches them after its check):
//   POST /bridge/<h>-turn  { sessionId, event: start|end, generationId, handout?, status?, usage? }  → { park }
//        a turn started (beforeSubmitPrompt) or ended (stop). Validated field by field, other fields dropped, handed to
//        the adapter's TurnHookHarness.turn. park: the conversation is a native member of <h>, the stop hook should park.
//   GET  /bridge/<h>-park?session=<id>&since=<ms>&version=<v>   SSE: the stop hook waits here for a batch.
//        events: deliver { deliveryId, text } (then the stream ends), end { reason: superseded | not-member }.
// The app only uses the answer of a conversation's newest waiting hook and silently drops an older one's, so, per
// session (in memory):
//   1. not a member: `end not-member` at once;
//   2. a park whose `since` (its hook process's start) is older than the session's last turn start, or than the park
//      registered now, is stale: `end superseded` at once;
//   3. otherwise it is the session's only park: registered through connectBridge, the one before it gets `end superseded`;
//   4. a park carries one delivery: off the registry the moment it takes it, then the stream ends;
//   5. a turn start ends every park of the session (superseded); a conversation that is no member any more ends its parks;
//   6. the Hub closing just drops the streams, without `end`: the hooks reconnect to the next Hub.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub } from '../core/hub.ts';
import type { TurnHookHarness, TurnReport } from '../core/types.ts';
import { readBridgeBody } from './request-body.ts';

const HEARTBEAT_MS = 25_000;
const MAX_BODY = 4096;
const MAX_ID = 200;
const HANDOUT_RE = /^[0-9a-f]{8}$/;
const VERSION_RE = /^[\w.+-]{1,40}$/;
const STATUSES = new Set(['completed', 'aborted', 'error']);
/** Sessions whose last turn start is remembered; the oldest is forgotten first. */
const MAX_SESSIONS = 1000;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** A validated report with only the known fields, or null. */
export function turnReport(body: unknown): TurnReport | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || !isId(b.sessionId) || !isId(b.generationId)) return null;
  if (b.event === 'start') {
    if (b.status !== undefined || b.usage !== undefined) return null;
    if (b.handout !== undefined && (typeof b.handout !== 'string' || !HANDOUT_RE.test(b.handout))) return null;
    return { sessionId: b.sessionId, event: 'start', generationId: b.generationId, ...(b.handout === undefined ? {} : { handout: b.handout as string }) };
  }
  if (b.event !== 'end' || b.handout !== undefined) return null;
  if (b.status !== undefined && !STATUSES.has(b.status as string)) return null;
  let usage: TurnReport['usage'];
  if (b.usage !== undefined) {
    const u = b.usage as Record<string, unknown> | null;
    if (!u || typeof u !== 'object' || ![u.input, u.output, u.cacheRead, u.cacheWrite].every(isCount)) return null;
    usage = { input: u.input as number, output: u.output as number, cacheRead: u.cacheRead as number, cacheWrite: u.cacheWrite as number };
  }
  return { sessionId: b.sessionId, event: 'end', generationId: b.generationId,
    ...(b.status === undefined ? {} : { status: b.status as TurnReport['status'] }), ...(usage ? { usage } : {}) };
}

interface Park { res: ServerResponse; since: number; disconnect: () => void; done: boolean }

/** The parked hooks of one turn-hook harness on one Hub. Made on first use (parksOf). */
export class ParkRegistry {
  private readonly parks = new Map<string, Park>();
  private readonly starts = new Map<string, number>();   // session → when its last turn started (Hub clock)
  private readonly unsubscribe: () => void;
  private readonly h: TurnHookHarness;
  private readonly hub: Hub;

  constructor(h: TurnHookHarness, hub: Hub) {
    this.h = h;
    this.hub = hub;
    // Rule 5: a conversation that is no member any more (removed, or the member moved away from it).
    this.unsubscribe = hub.subscribe((e) => {
      if (e.kind !== 'member') return;
      const { member: m, rebind } = e.payload as { member?: { harness?: string; workerSessionId?: string; removedAt?: string | null }; rebind?: { fromSessionId: string } };
      const left = rebind?.fromSessionId ?? (m?.removedAt ? m.workerSessionId : undefined);
      if (m?.harness === h.harness && left && this.parks.has(left) && !hub.nativeCallers(h.harness, left).length) this.end(left, 'not-member');
    });
  }

  close(): void {
    this.unsubscribe();
  }

  /** Whether the session has a parked hook registered. */
  parked(sessionId: string): boolean {
    return this.parks.has(sessionId);
  }

  /** POST /bridge/<h>-turn (the secret is already checked). */
  async turn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let report: TurnReport | null;
    try {
      report = turnReport(JSON.parse(await readBody(req)));
    } catch {
      report = null;
    }
    if (!report) return json(res, 400, { error: 'invalid turn report' });
    // Every report goes to the adapter, member or not: the conversation may have just been added. First: the adapter
    // must know a turn runs before the parks end, or the scheduler would see the member offline in between (and end
    // its queued deliveries 'offline').
    try { this.h.turn(report); } catch { /* the adapter's bookkeeping must not fail the hook */ }
    if (report.event === 'start') {
      this.starts.delete(report.sessionId);
      this.starts.set(report.sessionId, Date.now());
      if (this.starts.size > MAX_SESSIONS) this.starts.delete(this.starts.keys().next().value!);
      this.end(report.sessionId, 'superseded');
    }
    json(res, 200, { park: this.hub.nativeCallers(this.h.harness, report.sessionId).length > 0 });
  }

  /** GET /bridge/<h>-park (the secret is already checked). */
  park(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.searchParams.get('session');
    const since = Number(url.searchParams.get('since'));
    const version = url.searchParams.get('version');
    if (!isId(sessionId) || !Number.isSafeInteger(since) || since < 0) return json(res, 400, { error: 'session and since are required' });
    if (version !== null && !VERSION_RE.test(version)) return json(res, 400, { error: 'version, when given, must be a short version string' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    if (!this.hub.nativeCallers(this.h.harness, sessionId).length) return end(res, 'not-member');
    const current = this.parks.get(sessionId);
    if (since < (this.starts.get(sessionId) ?? 0) || (current && since < current.since)) return end(res, 'superseded');
    if (current) {
      // Ended but left in the Hub's bridge registry: connectBridge below replaces it, so the scheduler never sees the
      // session without a park in between (it would end its queued deliveries 'offline').
      current.done = true;
      end(current.res, 'superseded');
    }
    const park: Park = { res, since, disconnect: () => {}, done: false };
    this.parks.set(sessionId, park);
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    beat.unref();
    res.on('close', () => {
      clearInterval(beat);
      this.drop(sessionId, park);
    });
    park.disconnect = this.hub.connectBridge(this.h.harness, sessionId, {
      send: (e) => {
        // Spent at once (rule 4): off the registry before anything else can be pushed.
        this.drop(sessionId, park);
        park.done = true;
        res.end(`event: deliver\ndata: ${JSON.stringify({ deliveryId: e.deliveryId, text: e.text })}\n\n`);
      },
      // The Hub is closing (rule 6), or a newer park replaced this one (already ended): no `end` event.
      close: () => {
        if (park.done) return;
        park.done = true;
        res.end();
      },
      ...(version !== null ? { version } : {}),
    });
    // Delivered while registering: drop ran with the placeholder disconnect.
    if (this.parks.get(sessionId) !== park) park.disconnect();
  }

  private drop(sessionId: string, park: Park): void {
    if (this.parks.get(sessionId) !== park) return;
    this.parks.delete(sessionId);
    park.disconnect();
  }

  private end(sessionId: string, reason: 'superseded' | 'not-member'): void {
    const park = this.parks.get(sessionId);
    if (!park) return;
    this.drop(sessionId, park);
    if (park.done) return;
    park.done = true;
    end(park.res, reason);
  }
}

function end(res: ServerResponse, reason: string): void {
  res.end(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBridgeBody(req, MAX_BODY)).toString('utf8') || '{}';
}

const registries = new WeakMap<Hub, Map<string, ParkRegistry>>();

/** The park registry of this harness on this Hub, made on first use. */
export function parksOf(h: TurnHookHarness, hub: Hub): ParkRegistry {
  let perHub = registries.get(hub);
  if (!perHub) registries.set(hub, perHub = new Map());
  let p = perHub.get(h.harness);
  if (!p) perHub.set(h.harness, p = new ParkRegistry(h, hub));
  return p;
}
