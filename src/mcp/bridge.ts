// Hub side of the bridge protocol. Authentication of signed and legacy traffic is performed before native dispatch.
//   GET  /bridge/stream?harness=<h>&session=<id>   SSE; connected = online; events `deliver` { deliveryId, sessionId, text },
//                                                  and `tools-changed` {} when third-party plugin tools came or went
//   GET  /bridge/stream?harness=<h>                the harness's shared stream: every session of <h> is online through it
//        &version=<v> (optional)                   the app version the bridge runs in, shown on the web page (Antigravity)
//   POST /bridge/ack   { deliveryId, ok, error?, follows? }   the receipt for one deliver; follows: a done comes later
//   POST /bridge/done  { deliveryId, harness, sessionId, usage?, outcome?, error? }   the observed turn's result
//                                                  (usage: its tokens as TokenTotals, docs/usage.md)
//                                                  (after an ack with follows); another harness or session is ignored
//   POST /bridge/unread-hint  { harness, session }   { hint } when a bound conversation's unread count changed, else {}
//   GET  /bridge/<h>-wait     (x-orrery-ticket, no secret)   SSE; a wait-route harness's wait command, see ./wait-core.ts
//   POST /bridge/<h>-ack      { ticket, deliveryId } (no secret)   the wait command printed that delivery
//   GET  /bridge/<h>-park, POST /bridge/<h>-turn   a turn-hook harness's parked stop hook and turn reports, see ./hook-park.ts
//   plugin routes (OfficialPlugin.bridgeRoutes, before the secret check: each authenticates itself), e.g. the tasks plugin's
//   POST /bridge/ship-verify and /bridge/ship-result
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hub } from '../core/hub.ts';
import { parksOf } from './hook-park.ts';
import { readBridgeBody } from './request-body.ts';
import { waitsOf } from './wait-core.ts';

const MAX_BODY = 64 * 1024;
const MAX_ID = 200;
const VERSION_RE = /^[\w.+-]{1,40}$/;

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;

async function readJson(req: IncomingMessage): Promise<any> {
  return JSON.parse((await readBridgeBody(req, MAX_BODY)).toString('utf8') || '{}');
}

export async function handleBridge(hub: Hub, secret: string, req: IncomingMessage, res: ServerResponse,
  authorized: boolean): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // A wait command authenticates by its ticket alone, never the secret (./wait-core.ts).
  const waitRoute = /^\/bridge\/([a-z0-9-]+)-(wait|ack)$/.exec(url.pathname);
  const waitHarness = waitRoute ? hub.waitHarness(waitRoute[1]) : undefined;
  if (waitHarness) {
    if (req.method === 'GET' && waitRoute![2] === 'wait') return waitsOf(waitHarness, hub, secret).open(req, res);
    if (req.method === 'POST' && waitRoute![2] === 'ack') return waitsOf(waitHarness, hub, secret).ack(req, res);
  }
  // A plugin's route authenticates itself (the ship script: by its signed ticket).
  for (const route of hub.store.plugins.bridgeRoutes) {
    const match = req.method === route.method ? route.pattern.exec(url.pathname) : null;
    if (match) return route.handle({ hub, secret, params: match.slice(1), req, res });
  }
  if (!authorized) return json(res, 401, { error: 'unauthorized' });

  // A turn-hook harness's parked stop hook and turn reports (./hook-park.ts); any other name falls through to 404.
  const hookRoute = /^\/bridge\/([a-z0-9-]+)-(park|turn)$/.exec(url.pathname);
  const turnHooks = hookRoute ? hub.turnHookHarness(hookRoute[1]) : undefined;
  if (turnHooks) {
    if (req.method === 'GET' && hookRoute![2] === 'park') return parksOf(turnHooks, hub).park(req, res);
    if (req.method === 'POST' && hookRoute![2] === 'turn') return parksOf(turnHooks, hub).turn(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/bridge/stream') {
    const harness = url.searchParams.get('harness');
    const session = url.searchParams.get('session');   // absent: the harness's shared stream
    const version = url.searchParams.get('version');
    const activity = url.searchParams.get('activity');
    if (!isId(harness) || (session !== null && !isId(session))) return json(res, 400, { error: 'harness is required; session, when given, must be an id' });
    if (version !== null && !VERSION_RE.test(version)) return json(res, 400, { error: 'version, when given, must be a short version string' });
    if (activity !== null && (activity !== '1' || harness !== 'deepseek' || session !== null)) return json(res, 400, { error: 'invalid activity capability' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    const disconnect = hub.connectBridge(harness, session, {
      send: (e) => res.write(`event: deliver\ndata: ${JSON.stringify(e)}\n\n`),
      ...(activity === '1' ? { sendActivity: (frame: { observerId: string; sessions: string[] }) => res.write(`event: activity-targets\ndata: ${JSON.stringify(frame)}\n\n`) } : {}),
      // A session's own stream serves that conversation's tool list (the Claude bridge): third-party tools changed.
      ...(session !== null ? { toolsChanged: () => res.write('event: tools-changed\ndata: {}\n\n') } : {}),
      close: () => res.end(),
      ...(version !== null ? { version } : {}),
    });
    res.on('close', disconnect);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/bridge/activity') {
    let body: any;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid activity request' }); }
    const { observerId, sessionId, seq, event } = body ?? {};
    if (!isId(observerId) || !isId(sessionId) || !Number.isSafeInteger(seq) || seq < 0 || event === undefined) {
      return json(res, 400, { error: 'invalid activity request' });
    }
    return json(res, 200, { accepted: hub.recordBridgeActivity(observerId, sessionId, seq, event) });
  }

  if (req.method === 'POST' && url.pathname === '/bridge/ack') {
    let body: any;
    try {
      body = await readJson(req);
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    const { deliveryId, ok, error, follows } = body ?? {};
    if (!isId(deliveryId) || typeof ok !== 'boolean' || (error !== undefined && typeof error !== 'string') || (follows !== undefined && typeof follows !== 'boolean')) {
      return json(res, 400, { error: 'expected { deliveryId: string, ok: boolean, error?: string, follows?: boolean }' });
    }
    return json(res, 200, { acked: hub.ackBridge(deliveryId, ok, error, follows === true) });
  }

  if (req.method === 'POST' && url.pathname === '/bridge/done') {
    let body: any;
    try {
      body = await readJson(req);
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    const { deliveryId, harness, sessionId, usage, outcome, error } = body ?? {};
    if (!isId(deliveryId) || !isId(harness) || !isId(sessionId)
      || (outcome !== undefined && !['completed', 'failed', 'unknown'].includes(outcome))
      || (error !== undefined && (typeof error !== 'string' || outcome === undefined))) {
      return json(res, 400, { error: 'expected { deliveryId: string, harness: string, sessionId: string, outcome?: completed|failed|unknown, error?: string, usage?: object }' });
    }
    // `usage`: the turn's tokens (docs/usage.md); one the Hub cannot read is ignored, the end of the turn still counts.
    return json(res, 200, { done: hub.doneBridge(deliveryId, harness, sessionId, usage, outcome === undefined ? undefined : { outcome, ...(error === undefined ? {} : { error }) }) });
  }

  if (req.method === 'POST' && url.pathname === '/bridge/unread-hint') {
    let body: any;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid unread-hint request' }); }
    const { harness, session } = body ?? {};
    if (!isId(harness) || !isId(session)) return json(res, 400, { error: 'expected { harness: string, session: string }' });
    const hint = hub.unreadHintFor(harness, session);
    return json(res, 200, hint ? { hint } : {});
  }

  json(res, 404, { error: 'not found' });
}
