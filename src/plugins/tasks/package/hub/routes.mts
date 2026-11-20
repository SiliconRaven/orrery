// The web API of tasks. Registered through the plugin route slot, so all of these 404 when the plugin is disabled.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute } from 'node:path';
import { host } from './host.mts';
import { libraryView, runGlobalLabelCommand } from './labels.mts';
import { taskEvent } from './queries.mts';
import type { TasksService } from './service.mts';
import { reportBatchShip, reportShip, ShipRefused, verifyBatchShip, verifyShip } from './ship.mts';
import type { PluginBridgeRoute, PluginRoute, TaskStatus } from './types.mts';

const USER = { kind: 'user' } as const;
const limitOf = (url: URL) => (url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined);

export const taskRoutes: PluginRoute[] = [
  { method: 'GET', pattern: /^\/api\/labels$/, handle: ({ hub }) => libraryView(hub.store, null, true) },
  { method: 'POST', pattern: /^\/api\/labels$/, handle: ({ hub, body }) => runGlobalLabelCommand(hub, body) },
  { method: 'GET', pattern: /^\/api\/stalled$/, handle: ({ hub }) => ({ hints: (hub.services.get('tasks') as TasksService | undefined)?.stalledHints() ?? [] }) },
  { method: 'GET', pattern: /^\/api\/clusters\/([^/]+)\/task-repositories$/, handle: async ({ hub, params, url }) => {
    const { CollaborationError } = host().collaboration;
    const { git, projectIdentities } = host().projects;
    const clusterId = params[0];
    if (!hub.store.getCluster(clusterId)) throw new CollaborationError('OUT_OF_SCOPE', 'unknown cluster');
    const path = url.searchParams.get('path')?.trim();
    const repo = (path: string) => ({ path, label: basename(path) || path });
    if (path === undefined) {
      const paths = [...new Set(hub.store.listMembers(clusterId).map((member) => member.cwd).filter(isAbsolute))];
      const repositories = new Map<string, ReturnType<typeof repo>>();
      for (const identity of await projectIdentities(paths)) {
        if (identity.key.startsWith('git:')) repositories.set(identity.key, repo(identity.path));
      }
      return { repositories: [...repositories.values()] };
    }
    if (!isAbsolute(path)) throw new CollaborationError('INVALID_REQUEST', 'path must be an absolute local path');
    const [identity] = await projectIdentities([path]);
    if (!identity.key.startsWith('git:')) throw new CollaborationError('INVALID_REQUEST', 'could not resolve a local Git repository at path');
    let refs: string;
    try { refs = await git(path, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/'); }
    catch { throw new CollaborationError('INVALID_REQUEST', 'could not read local Git branches at path'); }
    return { repository: repo(identity.path), branches: refs.split(/\r?\n/).filter(Boolean) };
  } },
  { method: 'GET', pattern: /^\/api\/clusters\/([^/]+)\/workspace$/, handle: ({ hub, params, url }) => {
    const status = url.searchParams.get('status') ?? undefined;
    if (status !== undefined && !['pending', 'working', 'review', 'completed', 'merged', 'cancelled'].includes(status)) {
      throw new Error('invalid task status');
    }
    const sort = url.searchParams.get('sort') ?? undefined;
    if (sort !== undefined && sort !== 'created-desc') throw new Error('invalid task sort');
    return hub.collaboration.query(USER, params[0], {
      kind: 'workspace', limit: limitOf(url),
      cursor: url.searchParams.get('cursor') ?? undefined, q: url.searchParams.get('q') ?? undefined,
      sort, pageOnly: url.searchParams.get('pageOnly') === '1',
      memberId: url.searchParams.get('memberId') ?? undefined,
      holder: url.searchParams.get('holder') ?? undefined,
      label: url.searchParams.getAll('label').filter(Boolean).length ? url.searchParams.getAll('label').filter(Boolean) : undefined,
      status: status as TaskStatus | undefined,
    });
  } },
  { method: 'GET', pattern: /^\/api\/clusters\/([^/]+)\/task-refs$/, handle: ({ hub, params, url }) => {
    const { CollaborationError } = host().collaboration;
    const ids = url.searchParams.get('ids');
    const rawNumbers = url.searchParams.get('numbers');
    const numbers = rawNumbers === null ? undefined : rawNumbers.split(',').map((s) => s.trim()).filter(Boolean).map((token) => {
      const stripped = token.startsWith('#') ? token.slice(1) : token;
      const n = /^[1-9]\d*$/.test(stripped) ? Number(stripped) : NaN;
      if (!Number.isSafeInteger(n)) throw new CollaborationError('INVALID_REQUEST', 'numbers must be positive task numbers');
      return n;
    });
    const includeClosed = url.searchParams.get('includeClosed') === '1' || url.searchParams.get('includeClosed') === 'true';
    return hub.collaboration.query(USER, params[0], {
      kind: 'task_refs', q: url.searchParams.get('q') ?? undefined,
      ids: ids === null ? undefined : ids.split(',').filter(Boolean),
      numbers, includeClosed,
    });
  } },
  { method: 'GET', pattern: /^\/api\/clusters\/([^/]+)\/tasks\/([^/]+)\/context$/, handle: ({ hub, params, url }) => hub.collaboration.query(USER, params[0], {
    kind: 'context', taskId: params[1], limit: limitOf(url),
    cursor: url.searchParams.get('cursor') ?? undefined, messagesCursor: url.searchParams.get('messagesCursor') ?? undefined,
    attentionsCursor: url.searchParams.get('attentionsCursor') ?? undefined,
    q: url.searchParams.get('q') ?? undefined, sender: url.searchParams.get('sender') ?? undefined,
    since: url.searchParams.get('since') ?? undefined, until: url.searchParams.get('until') ?? undefined,
  }) },
  { method: 'GET', pattern: /^\/api\/clusters\/([^/]+)\/tasks\/([^/]+)\/events\/([^/]+)$/, handle: ({ hub, params }) => {
    const eventId = Number(params[2]);
    if (!Number.isSafeInteger(eventId) || eventId < 0) throw new Error('invalid event id');
    return taskEvent(hub.store, hub.collaboration, USER, params[0], params[1], eventId);
  } },
  { method: 'GET', pattern: /^\/api\/clusters\/([^/]+)\/tasks\/([^/]+)$/, handle: ({ hub, params, url }) => hub.collaboration.query(USER, params[0], {
    kind: 'task', taskId: params[1], limit: limitOf(url),
    cursor: url.searchParams.get('cursor') ?? undefined, eventsCursor: url.searchParams.get('eventsCursor') ?? undefined,
  }) },
];

const MAX_BODY = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const json = (res: ServerResponse, status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)); };

/** The ship script's two routes: it authenticates by its signed ticket, never the bridge secret (./ship.mts). */
export const shipRoute: PluginBridgeRoute = {
  method: 'POST',
  pattern: /^\/bridge\/ship-(verify|result)$/,
  handle: async ({ hub, secret, params, req, res }) => {
    const { CollaborationError } = host().collaboration;
    let body: any;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid ship request' }); }
    try {
      const batch = typeof body?.ticket === 'string' && body.ticket.startsWith('b1.');
      return json(res, 200, params[0] === 'verify' ? (batch ? verifyBatchShip : verifyShip)(hub, secret, body?.ticket)
        : await (batch ? reportBatchShip : reportShip)(hub, secret, body));
    } catch (e) {
      return json(res, e instanceof ShipRefused ? e.status : e instanceof CollaborationError ? 409 : 500, { error: e instanceof Error ? e.message : String(e) });
    }
  },
};
