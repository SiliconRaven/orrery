// HTTP API + SSE + static files for the web UI. See the HTTP API table in docs/architecture.md.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { MAX_FILE_BYTES, sniffImage } from '../core/files.ts';
import { extname, join, normalize, sep } from 'node:path';
import { PurgeRefused, type Hub } from '../core/hub.ts';
import type { ExternalPlugins } from '../core/external-plugins.ts';
import { isLimitSetting } from '../core/limits.ts';
import { isNotifySetting, NOTIFY_SETTINGS } from '../core/notify-settings.ts';
import type { PluginSettings } from '../core/plugin-settings.ts';
import type { HubEvent, ToolFingerprints } from '../core/types.ts';
import { searchClusterMessages } from './message-search.ts';

const PUBLIC_DIR = join(import.meta.dirname, 'public');
// The one core module the page loads as it is: the system-kind table (public/system-kinds.js re-exports it).
const CORE_FOR_PAGE: Record<string, string> = { '/core/system-kinds.js': join(import.meta.dirname, '..', 'core', 'system-kinds.js') };
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const MAX_BODY = 1_000_000;

/**
 * What the composition root adds to the web API: the health answer, the exit (absent = no /api/shutdown), and the
 * API token every /api/* request must carry (docs/security.md), with the name of the cookie the page keeps it in.
 */
export interface WebControl {
  health(): { app: 'orrery'; pid: number; state: 'running' | 'stopping'; home: string; db: string };
  shutdown?: () => void;
  auth: { token: string; cookie: string };
  toolFingerprints?: () => Promise<ToolFingerprints>;
  plugins: PluginSettings;
  externalPlugins?: ExternalPlugins;
}

/** Constant-time compare, as the bridge secret's. */
function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` (programs) or the cookie (the page). */
function authorized(req: IncomingMessage, auth: WebControl['auth']): boolean {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (sameToken(bearer, auth.token)) return true;
  const prefix = `${auth.cookie}=`;
  return (req.headers.cookie ?? '').split(';').some((c) => {
    const pair = c.trim();
    return pair.startsWith(prefix) && sameToken(pair.slice(prefix.length), auth.token);
  });
}

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  // Serialize before the headers: if this throws (e.g. a plugin's deeply nested result overflowing the stack), the
  // request handler can still answer 500 instead of leaving a half-written response open.
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const data = text ? JSON.parse(text) : {};
  if (typeof data !== 'object' || data === null) throw new Error('body must be a JSON object');
  return data;
}

/** "attachment" or "inline" with the name in both forms (RFC 6266): an ASCII fallback and the UTF-8 original. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /api/files/:id (docs/files.md). Looked up by id only. Inline only for a PNG/JPEG/GIF/WebP its own magic bytes
 * prove (never the declared type, never SVG or HTML), and not with ?download=1; everything else is an
 * application/octet-stream attachment. Every answer forbids sniffing, scripts and use by other sites.
 */
async function serveFile(hub: Hub, id: string, download: boolean, res: ServerResponse): Promise<void> {
  const found = hub.file(id);
  if (!found) return json(res, 404, { error: 'not found' });
  let data: Buffer;
  try {
    data = await readFile(found.path);
  } catch {
    return json(res, 404, { error: 'file is gone from disk' });
  }
  const image = download ? null : sniffImage(data);
  res.writeHead(200, {
    'content-type': image ?? 'application/octet-stream',
    'content-disposition': disposition(image ? 'inline' : 'attachment', found.info.name),
    'content-length': data.length,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=31536000, immutable',   // a file id's bytes never change
  });
  res.end(data);
}

/**
 * GET /api/plugins/:id/icon: a registered third-party plugin's icon, checked again on this read (plugin-icon.ts). The
 * type is the one its extension and first bytes agree on; the page shows it only through <img src>. The policy keeps an
 * SVG opened on its own from running script or loading anything.
 */
function servePluginIcon(control: WebControl, id: string, res: ServerResponse): void {
  const icon = control.externalPlugins?.icon(id);
  if (!icon || 'error' in icon) return json(res, 404, { error: icon ? icon.error : 'no icon' });
  res.writeHead(200, {
    'content-type': icon.type,
    'content-length': icon.data.length,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-cache',
  });
  res.end(icon.data);
}

/** POST /api/files?cluster=<id>, raw body, name in x-orrery-filename (URI-encoded). */
async function upload(hub: Hub, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cluster = url.searchParams.get('cluster');
  if (!cluster) throw new Error('cluster is required');
  const raw = req.headers['x-orrery-filename'];
  let name: string;
  try {
    name = decodeURIComponent(typeof raw === 'string' ? raw : '');
  } catch {
    throw new Error('x-orrery-filename must be URI-encoded');
  }
  if (Number(req.headers['content-length']) > MAX_FILE_BYTES) {
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: `file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` }));
    return;
  }
  return json(res, 201, await hub.uploadFile(cluster, name, req));
}

/** GET /api/settings, and `settings` in /api/state: the effective limit and notification settings and where each comes from. */
function settingsOf(hub: Hub) {
  const hops = hub.getLimit('maxHops');
  const turns = hub.getLimit('maxTurnsPerChain');
  const stalled = hub.getNotifySetting('stalledMemberMinutes');
  return { maxHops: hops.limit, source: hops.source, maxTurnsPerChain: turns.limit, maxTurnsPerChainSource: turns.source,
    stalledMemberMinutes: stalled.value, [NOTIFY_SETTINGS.stalledMemberMinutes.sourceKey]: stalled.source, usageAlert: hub.getUsageAlert(),
    clusterGroups: hub.clusterGroups() };
}

/** Running plugins, their trusted browser entries, and the full settings list. */
function pluginsOf(hub: Hub, control: WebControl) {
  const external = control.externalPlugins;
  return {
    plugins: hub.store.plugins.enabled.filter(({ id }) => !external?.has(id) || external.info(id).runtime?.state === 'ready').map(({ id, version }) => ({ id, version })),
    frontend: hub.store.plugins.enabled.flatMap(({ id, webModule }) => webModule && !external?.has(id) ? [webModule] : []),
    installed: [
      ...control.plugins.list().map((p) => ({ ...p, ...external?.info(p.id) })),
      // Skipped at start-up, with a readable manifest: shown as failed so the user sees why it is not running. An id
      // that a registered plugin already uses (an official one, say) keeps its own row; the skip stays in the log.
      ...(external?.failedInstalled() ?? []).filter((p) => !control.plugins.has(p.id)),
    ],
  };
}

/**
 * Where a stream or member event list resumes: the newer of ?since= and Last-Event-ID. The page opens its stream with
 * ?since=<the snapshot's seq>; when the browser reconnects that stream on its own it keeps the query and adds the
 * last id it saw, which is newer.
 */
function sinceParam(url: URL, req: IncomingMessage): number {
  const seq = (raw: unknown) => {
    const n = Number(raw ?? 0);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return Math.max(seq(url.searchParams.get('since')), seq(req.headers['last-event-id']));
}

/**
 * `X-Orrery-Seq`: the newest event seq, read in the same tick as the rows of the answer (no await in between, and only
 * this process writes the database), so the rows contain every event up to it and none after. The page replays the
 * events after it that it already streamed onto these rows.
 */
function seqHeader(hub: Hub): Record<string, string> {
  return { 'x-orrery-seq': String(hub.store.lastEventSeq()) };
}

/**
 * A handoff or resend answer: the page writes its source delivery into what it shows, so it is read again here, in
 * the same tick as the seq header. Hub returns it from an earlier point (before its own events were published and the
 * target scheduled, or before an await for resend), when later events could already have changed it.
 */
function answerHandoff(hub: Hub, res: ServerResponse, result: { message: unknown; sourceDelivery: { id: string } }): void {
  const sourceDelivery = hub.store.getDelivery(result.sourceDelivery.id) ?? result.sourceDelivery;
  json(res, 200, { ...result, sourceDelivery }, seqHeader(hub));
}

/** An optional positive integer query parameter, at most `max`; `def` when absent. */
function intParam(url: URL, name: string, def: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return Math.min(n, max);
}

/** Events per replay page: a few milliseconds of Hub time, then other requests get their turn. */
export const REPLAY_PAGE = 500;

function stream(hub: Hub, req: IncomingMessage, res: ServerResponse, since: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();   // otherwise clients wait for headers until the first event
  const frame = (seq: number, json: string) => `id: ${seq}\ndata: ${json}\n\n`;
  let replayed = 0;   // the highest seq the replay wrote to this connection
  let closed = false;
  let off = () => {};
  req.on('close', () => { closed = true; off(); });
  const live = (e: HubEvent) => {
    // An event stored before the last page was read, but announced only afterwards, was already sent.
    if (e.seq > replayed) res.write(frame(e.seq, JSON.stringify(e)));
  };
  // The log is replayed a page at a time, yielding to the event loop in between, so a long log does not hold up the
  // Hub's other work. Events appended meanwhile are read by a later page.
  const replay = (after: number) => {
    if (closed) return;
    try {
      const page = hub.store.eventJsonPage(after, REPLAY_PAGE);
      if (page.length) {
        res.write(page.map((e) => frame(e.seq, e.json)).join(''));
        replayed = page.at(-1)!.seq;
      }
      // A short page: the replay has caught up. Subscribing in the same tick as that read lets no event fall in between.
      if (page.length < REPLAY_PAGE) off = hub.subscribe(live);
      else setImmediate(replay, replayed);
    } catch (e) {
      // Not inside the request handler's promise: a failed read (the store closed for shutdown) ends this response, not the process.
      console.error('event replay failed:', e instanceof Error ? e.message : e);
      res.destroy();
    }
  };
  replay(since);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const file = Object.hasOwn(CORE_FOR_PAGE, pathname) ? CORE_FOR_PAGE[pathname]
    : normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + sep) && !Object.hasOwn(CORE_FOR_PAGE, pathname)) return json(res, 404, { error: 'not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

export async function handleWeb(hub: Hub, req: IncomingMessage, res: ServerResponse, control: WebControl): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const route = (re: RegExp) => re.exec(path)?.slice(1).map(decodeURIComponent);
  let m: string[] | undefined;
  try {
    if (path.startsWith('/api/')) {
      // The page's login: the token from its #token= fragment becomes a session cookie (HttpOnly: page scripts and
      // the URL never hold it after this). The only /api/* route without the token.
      if (method === 'POST' && path === '/api/session') {
        const { token } = await readJson(req);
        if (typeof token !== 'string' || !sameToken(token, control.auth.token)) return json(res, 401, { error: 'unauthorized' });
        res.writeHead(204, { 'set-cookie': `${control.auth.cookie}=${control.auth.token}; HttpOnly; SameSite=Strict; Path=/` }).end();
        return;
      }
      if (!authorized(req, control.auth)) return json(res, 401, { error: 'unauthorized' });
    }
    // Never carries the bridge secret or the API token: the launcher and the page read it.
    if (method === 'GET' && path === '/api/health') return json(res, 200, control.health());
    if (method === 'POST' && path === '/api/shutdown' && control.shutdown) {
      await readJson(req);
      const shutdown = control.shutdown;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{}', () => shutdown());   // after the answer is out: closing drops every connection
      return;
    }
    if (method === 'GET' && path === '/api/harnesses') return json(res, 200, hub.harnesses());
    if (method === 'GET' && path === '/api/harness-modes') return json(res, 200, hub.harnessModes());
    if (method === 'GET' && path === '/api/tool-versions') {
      const fingerprints = await control.toolFingerprints?.().catch(() => null);
      return json(res, 200, { hub: fingerprints ?? null, members: hub.toolVersionReport() });
    }
    if (method === 'GET' && (m = route(/^\/api\/harnesses\/([^/]+)\/projects$/))) {
      return json(res, 200, await hub.listProjects(m[0]));
    }
    if (method === 'GET' && (m = route(/^\/api\/harnesses\/([^/]+)\/sessions$/))) {
      const project = url.searchParams.get('project');
      if (!project) throw new Error('project is required');
      return json(res, 200, await hub.listSessions(m[0], project));
    }
    if (method === 'GET' && (m = route(/^\/api\/harnesses\/([^/]+)\/models$/))) {
      return json(res, 200, await hub.listModels(m[0]));
    }
    if (method === 'GET' && path === '/api/state') {
      // `seq`: the newest event when the snapshot was taken (all in one tick); the page streams events after it. Each
      // cluster's `unread` and the `running` deliveries are what the page used to rebuild from the whole event log.
      const unread = hub.store.unreadCounts();
      const clusters = hub.listClusters();
      // Each cluster's enabled coordinator (member id), for marking it on 全部对话; none when the plugin is off.
      const coordinators: Record<string, string> = {};
      for (const c of clusters) {
        const policy = hub.store.coordinator?.policy(c.id);
        if (policy?.enabled) coordinators[c.id] = policy.memberId;
      }
      return json(res, 200, {
        clusters: clusters.map((c) => ({ ...c, unread: unread.get(c.id) ?? 0 })), coordinators,
        members: hub.listMembers(undefined, { includeRemoved: url.searchParams.get('includeRemoved') === 'true' }),
        paused: hub.isPaused(), settings: settingsOf(hub), running: hub.store.runningDeliveries(), seq: hub.store.lastEventSeq(),
      });
    }
    if (method === 'GET' && path === '/api/settings') return json(res, 200, settingsOf(hub));
    if (method === 'GET' && path === '/api/activity') return json(res, 200, hub.activityReport(url.searchParams.get('cluster') ?? undefined));
    if (method === 'GET' && path === '/api/skills') return json(res, 200, hub.listSkills());
    if (method === 'GET' && path === '/api/avatars') return json(res, 200, hub.avatarPresets());
    if (method === 'GET' && path === '/api/plugins') return json(res, 200, pluginsOf(hub, control));
    if (method === 'GET' && (m = route(/^\/api\/plugins\/([^/]+)\/icon$/))) return servePluginIcon(control, m[0], res);
    if (method === 'POST' && (m = route(/^\/api\/plugins\/([^/]+)\/(invoke|stop)$/))) {
      if (!control.externalPlugins?.has(m[0])) return json(res, 404, { error: 'unknown external plugin' });
      const body = await readJson(req);
      if (m[1] === 'invoke') return json(res, 200, { result: await control.externalPlugins.invoke(m[0], body) });
      if (!body || Array.isArray(body) || Object.keys(body).length) throw new Error('stop body must be {}');
      await control.externalPlugins.stop(m[0]);
      return json(res, 200, pluginsOf(hub, control));
    }
    if (method === 'PATCH' && (m = route(/^\/api\/plugins\/([^/]+)\/write-settings$/))) {
      if (!control.externalPlugins?.has(m[0])) return json(res, 404, { error: 'unknown external plugin' });
      control.externalPlugins.setWriteSettings(m[0], await readJson(req));
      return json(res, 200, pluginsOf(hub, control));
    }
    if (method === 'PUT' && (m = route(/^\/api\/plugins\/([^/]+)$/))) {
      if (!control.plugins.has(m[0])) return json(res, 404, { error: 'unknown plugin' });
      const { enabled } = await readJson(req);
      if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
      control.plugins.setEnabled(m[0], enabled);
      return json(res, 200, pluginsOf(hub, control));
    }
    if (method === 'POST' && path === '/api/files') return await upload(hub, url, req, res);
    if (method === 'GET' && (m = route(/^\/api\/files\/([^/]+)$/))) return await serveFile(hub, m[0], url.searchParams.get('download') === '1', res);
    if (method === 'PATCH' && path === '/api/settings') {
      // One setting per request: a limit setting ({<setting>: finite}, or {<setting>: unlimited, confirmUnlimited}),
      // or a notification setting ({<setting>: non-negative integer}). The Hub checks the values.
      const body = await readJson(req);
      const keys = Object.keys(body).sort().join(',');
      if (!Array.isArray(body) && keys === 'usageAlert') {
        hub.setUsageAlert(body.usageAlert);
        return json(res, 200, settingsOf(hub));
      }
      const notify = keys.split(',').find(isNotifySetting);
      if (!Array.isArray(body) && notify && keys === notify) {
        hub.setNotifySetting(notify, body[notify]);
        return json(res, 200, settingsOf(hub));
      }
      const setting = keys.split(',').find(isLimitSetting);
      const unlimited = setting !== undefined && typeof body[setting] === 'object' && body[setting]?.kind === 'unlimited';
      if (Array.isArray(body) || !setting || keys !== (unlimited ? `confirmUnlimited,${setting}` : setting)) {
        throw new Error('body must be {"<setting>":{"kind":"finite","value":n}} or {"<setting>":{"kind":"unlimited"},"confirmUnlimited":true}, '
          + '<setting> being maxHops or maxTurnsPerChain; or {"<setting>":n}, <setting> being stalledMemberMinutes');
      }
      hub.setLimit(setting, body[setting], { confirmUnlimited: body.confirmUnlimited });
      return json(res, 200, settingsOf(hub));
    }
    if (path === '/api/cluster-groups') {
      // The sidebar's group list; names travel in the body, so a group may hold any character a category may.
      const only = (body: unknown, keys: string): Record<string, unknown> => {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys) throw new Error(`body must be {${keys}}`);
        return body as Record<string, unknown>;
      };
      if (method === 'GET') return json(res, 200, { groups: hub.clusterGroups() });
      if (method === 'POST') return json(res, 200, { groups: hub.createClusterGroup(only(await readJson(req), 'name').name) });
      if (method === 'PATCH') {
        const body = only(await readJson(req), 'from,to');
        return json(res, 200, { groups: hub.renameClusterGroup(body.from, body.to) });
      }
      if (method === 'DELETE') return json(res, 200, { groups: hub.deleteClusterGroup(only(await readJson(req), 'name').name) });
      if (method === 'PUT') return json(res, 200, { groups: hub.reorderClusterGroups(only(await readJson(req), 'groups').groups) });
    }
    if (method === 'GET' && path === '/api/clusters') {
      return json(res, 200, url.searchParams.get('deleted') === 'true' ? hub.listDeletedClusters() : hub.listClusters());
    }
    if (method === 'POST' && path === '/api/clusters') {
      const { name, members } = await readJson(req);
      return json(res, 201, await hub.createCluster(name, members));
    }
    if (method === 'DELETE' && (m = route(/^\/api\/clusters\/([^/]+)$/))) {
      await readJson(req);
      return json(res, 200, { cluster: hub.deleteCluster(m[0]) });
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/restore$/))) {
      await readJson(req);
      return json(res, 200, { cluster: hub.restoreCluster(m[0]) });
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/purge$/))) {
      // Permanent delete from the recycle bin, confirmed against the listed trash entry.
      const body = await readJson(req);
      if (Array.isArray(body) || Object.keys(body).sort().join(',') !== 'name,trashVersion'
        || typeof body.trashVersion !== 'number' || !Number.isSafeInteger(body.trashVersion) || body.trashVersion < 0) {
        throw new Error('body must contain the exact cluster name and its trashVersion');
      }
      try {
        return json(res, 200, await hub.purgeCluster(m[0], body.name, body.trashVersion));
      } catch (e) {
        if (!(e instanceof PurgeRefused)) throw e;
        return json(res, e.code === 'NOT_FOUND' ? 404 : 409, { error: e.message, code: e.code, ...(e.member ? { member: e.member } : {}) });
      }
    }
    for (const plugin of hub.store.plugins.routes) {
      if (method === plugin.method && (m = route(plugin.pattern))) {
        return json(res, 200, await plugin.handle({ hub, params: m, url, body: method === 'GET' ? undefined : await readJson(req) }));
      }
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/collaboration$/))) {
      return json(res, 200, hub.collaboration.command({ kind: 'user' }, m[0], await readJson(req)));
    }
    if (method === 'PATCH' && (m = route(/^\/api\/clusters\/([^/]+)$/))) {
      // A non-empty subset of { category, name, pinned, archived }; Hub.updateCluster checks keys and values.
      return json(res, 200, { cluster: hub.updateCluster(m[0], await readJson(req)) });
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/read$/))) {
      // Exactly { messageId }: the user's read position, which only moves forward.
      const body = await readJson(req);
      if (Array.isArray(body) || Object.keys(body).join(',') !== 'messageId') throw new Error('body must be {"messageId":"<id>"}');
      return json(res, 200, { cluster: hub.markClusterRead(m[0], body.messageId) });
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/members$/))) {
      const { members } = await readJson(req);
      return json(res, 201, await hub.addMembers(m[0], members));
    }
    if (method === 'DELETE' && (m = route(/^\/api\/clusters\/([^/]+)\/members\/([^/]+)$/))) {
      await readJson(req);
      return json(res, 200, { member: hub.removeMember(m[0], m[1]) });
    }
    if (method === 'PATCH' && (m = route(/^\/api\/members\/([^/]+)$/))) {
      const { name, avatar } = await readJson(req);
      return json(res, 200, hub.updateMember(m[0], { name, avatar }));
    }
    // Only the user, from the web page: there is no MCP tool or collaboration action for this.
    if (method === 'POST' && (m = route(/^\/api\/members\/([^/]+)\/session$/))) {
      return json(res, 200, await hub.rebindMember(m[0], await readJson(req)));
    }
    if (method === 'GET' && (m = route(/^\/api\/members\/([^/]+)\/session-history$/))) return json(res, 200, hub.memberRebinds(m[0]));
    // The user hides or shows a member (docs/cluster-members.md「隐身」); the coordinator uses set_cluster_paused instead.
    if (method === 'POST' && (m = route(/^\/api\/members\/([^/]+)\/hidden$/))) {
      const { hidden } = await readJson(req);
      return json(res, 200, { member: hub.setMemberHidden(m[0], hidden) });
    }
    // The member page's handover package: read-only records, never sent or applied by the Hub (docs/cluster-members.md「交接包」).
    if (method === 'GET' && (m = route(/^\/api\/members\/([^/]+)\/handover$/))) return json(res, 200, hub.handover(m[0]));
    if (method === 'GET' && (m = route(/^\/api\/clusters\/([^/]+)\/messages$/))) {
      // The newest `limit` (before `before`), the next `limit` after `after`, or a window of `limit` around `around`
      // (half older, the message, the rest newer); always oldest first.
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 1000);
      const around = url.searchParams.get('around'), after = url.searchParams.get('after');
      let msgs;
      if (around !== null) {
        const message = hub.store.getMessage(around);
        if (message?.clusterId !== m[0]) return json(res, 404, { error: 'not found' });
        const older = Math.floor(limit / 2);
        msgs = [...hub.listMessages(m[0], older, around), message, ...hub.store.listMessagesAfter(m[0], limit - older - 1, around)];
      } else if (after !== null) msgs = hub.store.listMessagesAfter(m[0], limit, after);
      else msgs = hub.listMessages(m[0], limit, url.searchParams.get('before') ?? undefined);
      return json(res, 200, hub.store.withDeliveries(msgs), seqHeader(hub));
    }
    if (method === 'GET' && (m = route(/^\/api\/clusters\/([^/]+)\/delivery-problems$/))) {
      if (!hub.store.getCluster(m[0])) return json(res, 404, { error: 'not found' });
      // `version` comes with the rows; "全部标为已知" sends it back so a later problem is not marked with them.
      return json(res, 200, hub.store.deliveryProblems(m[0], intParam(url, 'limit', 100, 500)));
    }
    // Only the user, from the web page (标为已知): there is no MCP tool or collaboration action for these two.
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/delivery-problems\/dismiss$/))) {
      return json(res, 200, hub.dismissDeliveryProblems(m[0], { all: await readJson(req) }));
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/deliveries\/([^/]+)\/dismiss$/))) {
      const body = await readJson(req);
      if (Array.isArray(body) || Object.keys(body).length) throw new Error('body must be {}');
      return json(res, 200, hub.dismissDeliveryProblems(m[0], { deliveryId: m[1] }));
    }
    // The user's history search: read-only, every message of the cluster (removed and hidden members' too), bounded per call.
    if (method === 'GET' && (m = route(/^\/api\/clusters\/([^/]+)\/messages\/search$/))) {
      const answer = searchClusterMessages(hub.store, m[0], url.searchParams);
      return answer ? json(res, 200, answer) : json(res, 404, { error: 'not found' });
    }
    if (method === 'GET' && (m = route(/^\/api\/clusters\/([^/]+)\/messages\/([^/]+)$/))) {
      const message = hub.store.getMessage(m[1]);
      if (!hub.store.getCluster(m[0]) || message?.clusterId !== m[0]) return json(res, 404, { error: 'not found' });
      return json(res, 200, hub.store.withDeliveries([message])[0], seqHeader(hub));
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/messages$/))) {
      const { body, to, attachments, taskIds, handover } = await readJson(req);
      if (handover !== undefined && handover !== true) throw new Error('handover must be true when given');
      const message = hub.sendFromUser(m[0], body, to, attachments, taskIds, handover ? 'handover' : undefined);
      // An @-text that ran into the text after a member's name (`@张三你好`) reached nobody: the page shows why.
      const mentionHints = to === undefined ? hub.userMentionHints(m[0], body) : [];
      return json(res, 201, mentionHints.length ? { ...message, mentionHints } : message);
    }
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/deliveries\/([^/]+)\/handoff$/))) {
      return answerHandoff(hub, res, hub.handoffDelivery(m[0], m[1], await readJson(req)));
    }
    // Only the user, from the web page: there is no MCP tool or collaboration action for this.
    if (method === 'POST' && (m = route(/^\/api\/clusters\/([^/]+)\/deliveries\/([^/]+)\/resend$/))) {
      return answerHandoff(hub, res, await hub.resendDelivery(m[0], m[1], await readJson(req)));
    }
    if (method === 'GET' && (m = route(/^\/api\/clusters\/([^/]+)\/deliveries\/([^/]+)\/timeline$/))) {
      return json(res, 200, await hub.deliveryTimeline(m[0], m[1]));
    }
    if (method === 'GET' && (m = route(/^\/api\/clusters\/([^/]+)\/messages\/([^/]+)\/delivery-timelines$/))) {
      return json(res, 200, { timelines: await hub.messageTimelines(m[0], m[1]) });
    }
    if (method === 'GET' && (m = route(/^\/api\/members\/([^/]+)\/events$/))) {
      // With ?limit= (and ?before=<seq> for older pages): the member page's lines (Store.memberEventPage). Without it,
      // as before: the member's agent and delivery events after ?since=.
      if (url.searchParams.has('limit')) {
        const before = url.searchParams.has('before') ? intParam(url, 'before', 0, Number.MAX_SAFE_INTEGER) : undefined;
        return json(res, 200, hub.store.memberEventPage(m[0], intParam(url, 'limit', 200, 1000), before));
      }
      return json(res, 200, hub.store.listEvents(sinceParam(url, req), m[0], ['agent', 'delivery']));
    }
    if (method === 'POST' && path === '/api/pause') {
      const { paused } = await readJson(req);
      if (typeof paused !== 'boolean') throw new Error('paused must be a boolean');
      hub.setPaused(paused);
      return json(res, 200, { paused: hub.isPaused() });
    }
    // Quota and token counts (docs/usage.md). Reading conversation totals reads the harnesses' files: on demand only.
    if (method === 'GET' && path === '/api/usage/turns') {
      const clusterId = url.searchParams.get('clusterId'), memberId = url.searchParams.get('memberId');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 10 : Number(rawLimit);
      if (!clusterId || !memberId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('clusterId, memberId and limit (1–100) are required');
      if (!hub.store.getCluster(clusterId) || hub.store.getMember(memberId)?.clusterId !== clusterId) throw new Error('unknown member in cluster');
      return json(res, 200, hub.store.usageTurns(clusterId, memberId, limit));
    }
    if (method === 'GET' && path === '/api/usage') return json(res, 200, await hub.usageReport(url.searchParams.get('cluster') || undefined));
    if (method === 'POST' && path === '/api/usage/refresh') {
      await readJson(req);
      return json(res, 200, { results: await hub.refreshUsage() });
    }
    if (method === 'GET' && path === '/api/stream') return stream(hub, req, res, sinceParam(url, req));
    if (method === 'GET' && !path.startsWith('/api/')) return serveStatic(path, res);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
    json(res, 400, { error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) });
  }
}
