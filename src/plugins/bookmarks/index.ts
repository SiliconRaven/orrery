// Member bookmarks on messages: the first official plugin (docs/plugins.md). Its table name predates the plugin system.
import { z } from 'zod';
import { CollaborationError, strings } from '../../core/collaboration.ts';
import type { CollectionsResult } from '../../core/collaboration-types.ts';
import type { OfficialPlugin, PluginActionContext } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';

export interface Bookmark { memberId: string; labels: string[]; createdAt: string; }

const BODY_MAX = 2000;

export function bookmarksOf(store: Store, messageId: string): Bookmark[] {
  return store.prepared('SELECT member_id, labels_json, created_at FROM collaboration_bookmarks WHERE message_id = ? ORDER BY rowid').all(messageId)
    .map((r) => ({ memberId: String(r.member_id), labels: JSON.parse(String(r.labels_json)) as string[], createdAt: String(r.created_at) }));
}

/** The message a bookmark action names, in the caller's cluster. */
function target({ store, clusterId, command }: PluginActionContext) {
  const message = command.messageId && store.getMessage(command.messageId);
  if (!message || message.clusterId !== clusterId) throw new CollaborationError('OUT_OF_SCOPE', 'unknown message');
  return message;
}

export const bookmarks: OfficialPlugin = {
  id: 'bookmarks',
  webModule: 'bookmarks',
  version: '0.10.0-beta.1',
  name: '收藏',
  description: 'Beta 测试版。成员可以收藏消息并加标签，收藏显示在消息下和工作台的“成员收藏”页签。',
  icon: 'bookmarks.svg',
  details: `成员可以收藏群里的消息并加标签，以后按成员、任务、标签或关键词找回。

**提供**
- 消息下的收藏入口
- 任务工作台资料库里的“成员收藏”页签
- 成员可用的两个工具：收藏或取消收藏消息、查找收藏

**关闭后**
收藏入口和“成员收藏”页签不再显示，两个工具也不再提供。已有的收藏保留，重新启用后都在。`,
  migrations: [
    `CREATE TABLE IF NOT EXISTS collaboration_bookmarks (member_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), labels_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(member_id, message_id));`,
  ],
  actions: {
    'bookmark.set': (ctx) => {
      const message = target(ctx);
      ctx.store.db.prepare(`INSERT INTO collaboration_bookmarks VALUES (?, ?, ?, ?) ON CONFLICT(member_id, message_id)
        DO UPDATE SET labels_json = excluded.labels_json`).run(ctx.actorId, message.id, JSON.stringify(strings(ctx.command.labels, 'labels')), new Date().toISOString());
      return { bookmark: bookmarksOf(ctx.store, message.id).find((b) => b.memberId === ctx.actorId), messageId: message.id };
    },
    'bookmark.remove': (ctx) => {
      const message = target(ctx);
      ctx.store.db.prepare('DELETE FROM collaboration_bookmarks WHERE member_id = ? AND message_id = ?').run(ctx.actorId, message.id);
      return { bookmark: null, messageId: message.id };
    },
  },
  queries: {
    collections: ({ store, clusterId, query, limit, task }) => {
      if (query.memberId && query.memberId !== 'user') {
        const member = store.getMember(query.memberId, { includeRemoved: true });
        if (!member || member.clusterId !== clusterId) throw new CollaborationError('OUT_OF_SCOPE', 'unknown member in this cluster; list_agents shows each memberId and name');
      }
      if (query.taskId) task(query.taskId);   // with the tasks plugin off this refuses with a clear error
      const filters = ['b.message_id = m.id'];
      const args: string[] = [];
      if (query.memberId) { filters.push('b.member_id = ?'); args.push(query.memberId); }
      if (typeof query.label === 'string' && query.label) { filters.push('EXISTS (SELECT 1 FROM json_each(b.labels_json) WHERE value = ?)'); args.push(query.label); }
      const where = [{ sql: `EXISTS (SELECT 1 FROM collaboration_bookmarks b WHERE ${filters.join(' AND ')})`, args }];
      if (query.taskId) where.push(store.tasks!.linkedClause(query.taskId));
      return store.collaborationCollection(clusterId, { ...query, limit, where });
    },
  },
  tools(api) {
    api.query('list_bookmarks', 'Find cluster bookmarks by member, task, label, sender, time or keyword; 20 per page. '
      + `Message bodies over ${BODY_MAX} characters are cut and marked truncated unless detail is "full".`, 'collections', {
      ...api.page, memberId: z.string().optional(), taskId: z.string().optional(), label: z.string().optional(),
      q: z.string().optional(), sender: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
      detail: z.enum(['summary', 'full']).optional().describe('summary (default): long bodies cut; full: whole bodies.'),
    }, ({ detail: _d, ...p }) => ({ ...p, limit: p.limit ?? 20 }),
    (result: CollectionsResult, p) => (p.detail === 'full' ? result : {
      ...result,
      items: result.items.map((item) => (item.message.body.length > BODY_MAX
        ? { ...item, message: { ...item.message, body: item.message.body.slice(0, BODY_MAX), truncated: true } } : item)),
    }));
    api.command('bookmark_message', 'Set your bookmark and labels on a message, or remove your own bookmark. messageId accepts a full ID or a unique prefix of at least 8 characters in this cluster.', {
      action: z.enum(['set', 'remove']), messageId: z.string(), labels: z.array(z.string()).optional(),
    }, (args) => args.action === 'set' ? 'bookmark.set' : 'bookmark.remove');
  },
  routes: [{
    method: 'GET',
    pattern: /^\/api\/clusters\/([^/]+)\/collections$/,
    handle: ({ hub, params, url }) => hub.collaboration.query({ kind: 'user' }, params[0], {
      kind: 'collections', limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      cursor: url.searchParams.get('cursor') ?? undefined, memberId: url.searchParams.get('memberId') ?? undefined,
      taskId: url.searchParams.get('taskId') ?? undefined, label: url.searchParams.get('label') ?? undefined,
      q: url.searchParams.get('q') ?? undefined, sender: url.searchParams.get('sender') ?? undefined,
      since: url.searchParams.get('since') ?? undefined, until: url.searchParams.get('until') ?? undefined,
    }),
  }],
  messageFields: { bookmarks: bookmarksOf },
  // The cluster's messages, and anything its members bookmarked.
  clusterPurging: (store, clusterId) => store.db.prepare(`DELETE FROM collaboration_bookmarks
    WHERE message_id IN (SELECT id FROM messages WHERE cluster_id = ?) OR member_id IN (SELECT id FROM members WHERE cluster_id = ?)`)
    .run(clusterId, clusterId),
};
