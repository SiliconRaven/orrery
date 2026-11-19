// Collaboration MCP tools over Streamable HTTP (stateless). Every tool is scoped to the caller's cluster.
// Caller kinds, checked in this order (docs/native-mode.md, "身份认证"); every one needs the bridge secret:
//   1. x-orrery-bridge: <secret> + x-orrery-session: <session id> (+ x-orrery-harness: <h>, default claude): a native
//      member whose bridge names its session: Claude via the orrery bridge, DeepSeek Harness via its plugin.
//   2. x-orrery-bridge: <secret>, thread id in each tools/call's _meta.threadId: a native Codex member.
//   3. x-orrery-bridge: <secret> + x-orrery-harness: antigravity, no session header: a native Antigravity member, named
//      by the hook-signed `orreryCaller` argument of each tools/call (./antigravity.ts). Only this caller's arguments
//      are ever read for identity.
//   4. The same bridge secret + x-orrery-harness: kimi: the runtime names its session in each call's
//      _meta["kimi/sessionId"]; without it, Kimi is nobody (docs/adapters/kimi.md).
//   5. The same bridge secret + x-orrery-harness: zcode: the runtime names its session in each call's _meta
//      (root_session_id ?? session_id, ./zcode.ts). Only this caller gets wait_for_messages (docs/adapters/zcode.md).
//   6. A session header from a bridge of a harness on the background-wait route (x-orrery-harness: workbuddy): the
//      bridge took the id from CODEBUDDY_SESSION_ID or else its WorkBuddy.exe parent's --session-id, never from tool
//      arguments. Its callers also get wait_for_messages (docs/adapters/workbuddy.md).
//   7. The same bridge secret + x-orrery-harness: qoder (its plugin's MCP relay): each call's
//      _meta["com.qoder/turnContext"].sessionId, nothing else, not even x-orrery-session (./qoder.ts, docs/adapters/qoder.md).
// Any other harness without a session header is nobody, never the Codex path.
// A missing or wrong secret is 401; an Authorization header names nobody (there are no member tokens). A conversation that is no native member gets an empty list_agents and an error from the
// other tools, and writes nothing. Identity is checked when the request arrives and again when each tool runs:
// the body can arrive long after the headers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { HIDDEN_TOOL_TEXT, memberLabel } from '../core/collaboration.ts';
import { MAX_FILES_PER_MESSAGE } from '../core/files.ts';
import type { CollaborationCommand, CollaborationQuery, CollaborationResult } from '../core/collaboration-types.ts';
import type { Hub } from '../core/hub.ts';
import { asyncRefused, isThenable, type PluginToolApi } from '../core/plugin.ts';
import { isPluginToolName } from '../core/external-plugin-tools.ts';
import type { ToolListSnapshot } from '../core/tool-list.ts';
import { WORKBUDDY_WAIT, ZCODE_WAIT, type Member, type ToolProfile, type WaitHarness } from '../core/types.ts';
import { ANTIGRAVITY, CALLER_ARG, CALLER_ARG_HELP, signedConversation } from './antigravity.ts';
import { hasSecret, SECRET_HEADER } from './bridge.ts';
import { hubUrlOf, ticketFor, waitCommand, WAIT_DESCRIPTION, waitsOf, ZCODE, zcodeCaller } from './zcode.ts';
import { QODER, QODER_WAIT_TOOL, qoderSession, qoderWaitReply } from './qoder.ts';
import { WORKBUDDY, ticketFor as workbuddyTicketFor, waitCommand as workbuddyWaitCommand, waitsOf as workbuddyWaitsOf } from './workbuddy.ts';
import { fingerprintTools, summarizeTools } from './tool-fingerprint.ts';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
// K2 item 5: every tool response except read_messages/ack_messages carries the changed unread hint as an extra block.
const reply = (hub: Hub, me: { id: string; clusterId: string }, data: unknown) => {
  const hint = hub.unreadHint([me]);
  const base = text(data);
  return hint ? { content: [...base.content, { type: 'text' as const, text: hint }] } : base;
};

const fail = (e: unknown) => ({
  content: [{ type: 'text' as const, text: e instanceof Error
    ? `${'code' in e && typeof e.code === 'string' ? `${e.code}: ` : ''}${e.message}` : String(e) }],
  isError: true,
});

type ToolError = ReturnType<typeof fail>;
const NOT_MEMBER = fail(new Error('这个对话还不是任何 orrery 集群的成员'));
// A hidden membership (docs/cluster-members.md「隐身」): every tool, reading ones too, answers this and does nothing.
const HIDDEN = fail(new Error(HIDDEN_TOOL_TEXT));
const UNSIGNED = fail(new Error('这次调用没有 orrery hook 的签名，Hub 认不出是哪个 Antigravity 对话：请按 orrery 的 Antigravity 设置说明安装 hook'));

const SET_CLUSTER_PAUSED = 'Pause or resume this cluster’s delivery when the coordinator policy permits it (paused). '
  + 'The enabled coordinator with deliveryControl may instead hide a member (memberId and hidden: true): a hidden member receives no messages, '
  + 'is not shown to the other members and its orrery tools do nothing; hidden: false shows it again. Nobody can hide itself, and the coordinator cannot be hidden.';

/** Each request's server: its plugin tools of plugins that are not running (not listed; a call of one is answered). */
const dormantTools = new WeakMap<McpServer, Set<string>>();

export const SESSION_HEADER = 'x-orrery-session';
export const HARNESS_HEADER = 'x-orrery-harness';

type Caller =
  | { kind: 'session'; harness: string; sessionId: string }   // through a bridge (Claude, WorkBuddy) or plugin (DeepSeek)
  | { kind: 'thread' }                       // native Codex: the thread id comes with each tools/call
  | { kind: 'antigravity' }                 // native Antigravity: the hook-signed conversation id comes in each call's arguments
  | { kind: 'kimi' }                        // native Kimi: the runtime session id comes in each call's _meta
  | { kind: 'zcode' }                       // native ZCode: likewise, in _meta.root_session_id / session_id
  | { kind: 'qoder' }                       // native Qoder: likewise, in _meta["com.qoder/turnContext"].sessionId
  | { kind: 'nobody' };                      // another harness header without a session: no conversation can be named

/** Who is calling, from the headers; null → 401. */
function callerOf(secret: string, req: IncomingMessage): Caller | null {
  if (req.headers[SECRET_HEADER] === undefined || !hasSecret(req, secret)) return null;
  if (req.headers[HARNESS_HEADER] === QODER) return { kind: 'qoder' };   // before the session header: Qoder's identity is _meta only
  const session = req.headers[SESSION_HEADER];
  if (session === undefined) {
    const named = req.headers[HARNESS_HEADER];
    if (named === undefined) return { kind: 'thread' };
    if (named === ANTIGRAVITY) return { kind: 'antigravity' };
    if (named === 'kimi') return { kind: 'kimi' };
    if (named === ZCODE) return { kind: 'zcode' };
    return typeof named === 'string' && named ? { kind: 'nobody' } : null;
  }
  const harness = req.headers[HARNESS_HEADER] ?? 'claude';   // the Claude bridge predates the header
  return typeof session === 'string' && session && typeof harness === 'string' && harness
    ? { kind: 'session', harness, sessionId: session }
    : null;
}

/**
 * The caller's memberships that may act now: a hidden one may not. When every membership of the caller is hidden, the
 * answer is HIDDEN, which names nobody. Every tool of every transport goes through here or through `select` below.
 */
function currentMembers(hub: Hub, secret: string, caller: Caller, meta: Record<string, unknown> | undefined,
  args?: Record<string, unknown>): Member[] | ToolError {
  const members = resolveMembers(hub, secret, caller, meta, args);
  if (!Array.isArray(members)) return members;
  const shown = members.filter((m) => !m.hiddenAt);
  return shown.length || !members.length ? shown : HIDDEN;
}

/** Resolve only the trusted caller identity, before selecting a cluster or validating tool arguments. */
function resolveMembers(hub: Hub, secret: string, caller: Caller, meta: Record<string, unknown> | undefined,
  args?: Record<string, unknown>): Member[] | ToolError {
  if (caller.kind === 'nobody') return NOT_MEMBER;
  if (caller.kind === 'antigravity') {
    const id = signedConversation(secret, args?.[CALLER_ARG]);
    return id === null ? UNSIGNED : hub.nativeCallers(ANTIGRAVITY, id);
  }
  if (caller.kind === 'zcode') {
    const who = zcodeCaller(meta);
    return who ? hub.nativeCallers(ZCODE, who.sessionId) : [];
  }
  if (caller.kind === 'qoder') {
    const sessionId = qoderSession(meta);
    return sessionId ? hub.nativeCallers(QODER, sessionId) : [];
  }
  const [harness, id] = caller.kind === 'session'
    ? [caller.harness, caller.sessionId]
    : caller.kind === 'kimi' ? ['kimi', meta?.['kimi/sessionId']] : ['codex', meta?.threadId];
  return typeof id === 'string' && id ? hub.nativeCallers(harness, id) : [];
}

function buildServer(hub: Hub, secret: string, caller: Caller, hubUrl: string): McpServer {
  const server = new McpServer({ name: 'orrery', version: '0.10.0-beta.2' });
  /** Only trusted credentials name the conversation; model arguments do not choose an identity. */
  const current = (meta: Record<string, unknown> | undefined, args?: Record<string, unknown>) => currentMembers(hub, secret, caller, meta, args);
  /** A clusterId naming a membership that is hidden gets HIDDEN, not the list of the caller's other clusters. */
  const hiddenIn = (meta: Record<string, unknown> | undefined, args: Record<string, unknown>) => {
    const all = resolveMembers(hub, secret, caller, meta, args);
    return Array.isArray(all) && typeof args.clusterId === 'string' && all.some((m) => m.clusterId === args.clusterId && m.hiddenAt);
  };

  /** Select only within that identity's memberships. Message IDs may identify one cluster but never grant access. */
  const select = (meta: Record<string, unknown> | undefined, args: Record<string, unknown>, hints: string[] = []): Member | ToolError => {
    const members = current(meta, args);
    if (!Array.isArray(members)) return members;
    if (hiddenIn(meta, args)) return HIDDEN;
    if (!members.length) return NOT_MEMBER;
    const choices = members.map((m) => ({ clusterId: m.clusterId, name: hub.store.getCluster(m.clusterId)?.name ?? m.clusterId }));
    const choose = () => fail(new Error(`请选择 clusterId；这个对话所属的集群：${JSON.stringify(choices)}`));
    if (typeof args.clusterId === 'string') return members.find((m) => m.clusterId === args.clusterId) ?? choose();
    if (members.length === 1) return members[0];
    if (hints.length) {
      const messages = hints.map((id) => hub.store.getMessage(id));
      const clusterId = messages[0]?.clusterId;
      if (clusterId && messages.every((m) => m?.clusterId === clusterId)) return members.find((m) => m.clusterId === clusterId) ?? choose();
    }
    return choose();
  };

  // An Antigravity caller's tools take the hook's argument too: arguments outside the schema never reach a handler.
  const signed: Record<string, z.ZodOptional<z.ZodString>> = caller.kind === 'antigravity' ? { [CALLER_ARG]: z.string().optional().describe(CALLER_ARG_HELP) } : {};
  const clusterId = z.string().optional().describe('Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.');

  const LIST_AGENTS = 'List the members of your orrery cluster: memberId, name, harness, model, status, observed activity, '
    + 'business roles (id and name) and current load (working, assigned, reviewing). Load counts active tasks of this cluster only.';
  /** Per-member active-task load for list_agents: working, assigned, reviewing. The aggregation reads every
   * active task, so a long completed history can never hide one (no page/cursor limit). Absent without a task plugin. */
  const loadOf = (clusterId: string) => {
    const tasks = hub.store.tasks?.activeLoads(clusterId);
    return tasks && ((memberId: string) => ({
      working: tasks.filter((task) => task.status === 'working' && task.assignedMemberId === memberId).length,
      assigned: tasks.filter((task) => task.status === 'pending' && task.assignedMemberId === memberId).length,
      reviewing: tasks.filter((task) => task.status === 'review' && task.reviewerMemberId === memberId).length,
    }));
  };
  const listAgents = (me: Member | ToolError) => {
    if (me === NOT_MEMBER) return text([]);
    if ('isError' in me) return me;
    const roles = new Map(hub.store.collaborationRoles(me.clusterId).map((role) => [role.id, { id: role.id, name: role.name }]));
    const memberRoles = new Map(hub.store.collaborationMemberRoles(me.clusterId).map((item) => [item.memberId, item.roleIds]));
    const load = loadOf(me.clusterId);
    // Hidden members exist only for the user and the enabled coordinator, who sees them marked.
    return reply(hub, me, hub.visibleMembers(me.clusterId, me.id, hub.listMembers(me.clusterId)).map(({ id, name, harness, model, status, hiddenAt }) => ({
      memberId: id, name, harness, model, status, ...(hiddenAt ? { hidden: true } : {}), activity: hub.activityFor(id),
      roles: (memberRoles.get(id) ?? []).map((roleId) => roles.get(roleId) ?? { id: roleId, name: `已删除角色（${roleId}）` }),
      ...(load ? { load: load(id) } : {}),
    })));
  };
  server.registerTool('list_agents', { description: LIST_AGENTS, inputSchema: { clusterId, ...signed } },
    async (args, extra) => listAgents(select(extra._meta, args)));

  server.registerTool('send_message', {
    description: 'Post a message to your cluster chat. Write @name in the body to deliver it to that member (@all = a broadcast: every member keeps it unread, but only members you also name explicitly receive a delivery); '
      + 'write the member\'s full name and follow it with a space, punctuation or the end of the text: a letter or digit right after the name makes it another name (@name你好 reaches nobody); '
      + '@ inside inline code, code blocks or quotes is plain text. Without any @ the message reaches nobody and only stays '
      + 'in the chat record; @name the coordinator when you need it to act. Pass to: [member names] to deliver '
      + 'only to those members and treat the body as plain text. Write #number (e.g. #12) or #<full task ID> to show a link to that task of this cluster in the chat '
      + '(# inside inline code, code blocks or quotes is plain text). Returns immediately: `deliveredTo` lists who it was queued for, '
      + 'not who got it; `unresolvedMentions` lists @names in the body that match no member (`mentionHints` says when one starts with a member\'s name), and when there is no recipient at all, '
      + '`warning` says the message only stays in the chat record and names the members available in this cluster (both come from the first send; '
      + 'a repeat with the same `clientMessageId` returns only the original messageId and deliveredTo). '
      + 'Whether each did shows later as `deliveries` on your own messages in read_messages (`history: true`); '
      + 'recipients it did not reach or whose result is unknown are also named in your next orrery delivery. '
      + 'Speak only to ask, deliver a result, report a blockage or ask someone to act; acknowledgement belongs to ack_messages. '
      + 'Set `fyi: true` when nobody has to act (a progress note, thanks): never set `fyi` when answering someone\'s question; when `fyi: true` is used, named members keep it unread without being woken, except if `replyTo` is set and the sender of the replied-to message is still an active member explicitly named in this message, that asker IS woken and `fyiOverridden` lists their name. '
      + 'Task results and evidence go into the `summary` of task_action submit: the Hub notifies the reviewer, so do not @ the reviewer separately; '
      + '@ the coordinator only to ask for reassignment or when the flow is stuck. '
      + 'A plugin the user installed may refuse a send (error REFUSED_BY_PLUGIN with its reason): nothing was stored or delivered; wait or rephrase, and do not resend it unchanged in a loop.',
    inputSchema: {
      body: z.string(),
      clusterId,
      replyTo: z.string().optional().describe('messageId being replied to: a full ID or a unique prefix of at least 8 characters in this cluster'),
      to: z.array(z.string()).optional().describe('member names to deliver to; when set, the body is plain text'),
      taskIds: z.array(z.string()).optional().describe('Tasks in this cluster to link to this message: #number (e.g. #12), full ID, or a unique prefix of at least 8 characters (bare 8+ digit numbers remain ID prefixes).'),
      attachments: z.array(z.string()).max(MAX_FILES_PER_MESSAGE).optional()
        .describe(`native members only: names of files you copied into your own orrery outbox folder (its path is in each orrery delivery); bare file names, no paths; real copies, not links; at most ${MAX_FILES_PER_MESSAGE}, 20 MB each. The Hub copies them and never deletes anything in the outbox`),
      clientMessageId: z.string().min(1).max(200).optional()
        .describe('an id you generate for this message. Sending again with the same value returns the existing messageId with `duplicate: true` and writes nothing new, even if the body differs; use it to retry after a lost response. The Hub never resends by itself'),
      fyi: z.boolean().optional().describe('true: for information only (never set when answering a question). Named members keep it unread without being woken, except an explicitly addressed active sender of `replyTo` is still woken (`fyiOverridden`)'),
      ...signed,
    },
  }, async (args, extra) => {
    const { body, replyTo, attachments, taskIds, to, clientMessageId, fyi } = args;
    let me = select(extra._meta, args, replyTo ? [replyTo] : []);
    if ('isError' in me) return me;
    // Files are copied from the caller's own outbox folder first; identity is checked again before sending. A refused
    // send drops the Hub's copies. The outbox is never changed.
    let ids: string[] = [];
    if (attachments?.length) {
      try {
        // Copying the files would already write something, so a repeat stops here; sendFromMember checks again after the wait.
        const earlier = hub.resentMessage(me.id, clientMessageId);
        if (earlier) return reply(hub, me, { messageId: earlier.message.id, deliveredTo: earlier.deliveredTo, duplicate: true });
        ids = await hub.importFiles(me.id, attachments);
      } catch (e) {
        return fail(e);
      }
      const again = select(extra._meta, args, replyTo ? [replyTo] : []);
      if ('isError' in again || again.id !== me.id) {
        await hub.discardFiles(ids);
        return 'isError' in again ? again : NOT_MEMBER;
      }
      me = again;
    }
    try {
      const { message, deliveredTo, unresolvedMentions, mentionHints, fyiOverridden, warning, duplicate } = await hub.sendFromMemberGated(me.id, body, replyTo, ids, taskIds, to, clientMessageId, fyi);
      if (duplicate) {
        await hub.discardFiles(ids);   // the same id won the race during the copy
        return reply(hub, me, { messageId: message.id, deliveredTo, duplicate });
      }
      const resolvedTaskIds = taskIds?.length ? (hub.store.tasks?.links(message.id) ?? taskIds) : undefined;
      return reply(hub, me, {
        messageId: message.id, deliveredTo, unresolvedMentions,
        ...(mentionHints ? { mentionHints } : {}),
        ...(fyiOverridden ? { fyiOverridden } : {}),
        ...(warning ? { warning } : {}),
        ...(resolvedTaskIds?.length ? { taskIds: resolvedTaskIds } : {}), ...(ids.length ? { attachments: ids.length } : {}),
      });
    } catch (e) {
      await hub.discardFiles(ids);
      return fail(e);
    }
  });

  server.registerTool('read_messages', {
    description: 'Read your cluster chat, oldest first. By default returns only your unread messages that concern you since you joined: '
      + 'ones that @-mention you (or @all) and user messages without any @, not your own, excluding sender-only receipts and queue warnings (a member\'s @all counts unread for everyone but delivers only to the members named explicitly in the same body); each message is returned once, '
      + 'then counts as read. Member messages without any @ and sender-only receipts (no longer written)/queue warnings stay in the chat record; read them with `history: true`. '
      + 'A delivery accepted by the channel or completed also counts as read, but does not mean you explicitly confirmed seeing it. '
      + 'Set `history: true` for the full recent chat instead (all senders, read or not); page back with `before`. '
      + 'Messages with files list them as `attachments` (name, size and, for native members, a local path to read). '
      + 'Your own messages (in the history) carry `deliveries`: per recipient `{to, status, outcome, reason?}`; status is queued, running, '
      + 'done, failed, offline (the member was offline: not delivered and never resent), superseded (replaced before delivery) or blocked (stopped by a loop guard); '
      + '`outcome` is accepted, completed, failed, unknown, or null when no evidence is available; `reason` comes with failed, blocked and superseded. '
      + 'Every returned message carries `category` (mention, user, broadcast, task_notice, receipt_warning, or null in history when unaddressed to you), '
      + '`annotations` (parallel tags: fyi, offline, failed_or_unknown, blocked), `acknowledgements` (members who explicitly confirmed seeing it and when; this does not mean task completion), '
      + '`taskIds` and `bookmarks` (member IDs, labels and times). '
      + 'Optional filters narrow either mode by intersection (AND — every given filter, including `category` alongside `sender` and `mentions`, must match): since/until (ISO time, inclusive), q (case-insensitive body substring, % and _ are literal), '
      + 'sender (member name, user or system), mentions (member name or all) and category (mention, user, broadcast, task_notice, receipt_warning, or warning: system warnings such as failed deliveries, failed ships, queue warnings, stalled members, quota, rejected results and open questions). Unread mode only filters your relevant unread set; filtered-out messages stay unread.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('default 20 (history: 10), max 100'),
      clusterId,
      history: z.boolean().optional().describe('true: the recent chat history instead of your unread messages'),
      before: z.string().optional().describe('history only (implies history: true): messages older than this messageId'),
      since: z.string().optional().describe('only messages created at or after this ISO time'),
      until: z.string().optional().describe('only messages created at or before this ISO time'),
      q: z.string().max(200).optional().describe('case-insensitive substring of the body; % and _ match literally; max 200 characters'),
      sender: z.string().optional().describe('only messages from this member name, or user or system'),
      mentions: z.string().optional().describe('only messages @-mentioning this member name, or all'),
      category: z.enum(['mention', 'user', 'broadcast', 'task_notice', 'receipt_warning', 'warning']).optional()
        .describe('only messages in this category (combines with sender/mentions by AND): mention, user, broadcast, task_notice, receipt_warning (history only), or warning (system warnings; overlaps task_notice and receipt_warning)'),
      detail: z.enum(['summary', 'full']).optional().describe('history only. summary (default): 10 messages, done deliveries as {to, status}, acknowledgements as member names; full: everything.'),
      ...signed,
    },
  }, async (args, extra) => {
    const { history, before, since, until, q, sender, mentions, category } = args;
    // The history is the big read: by default fewer messages and short delivery and acknowledgement entries.
    const compact = (history === true || before !== undefined) && args.detail !== 'full';
    const limit = args.limit ?? (compact ? 10 : undefined);
    const me = select(extra._meta, args, before ? [before] : []);
    if ('isError' in me) return me;
    const members = hub.listMembers(me.clusterId, { includeRemoved: true });
    const nameOf = (id: string) => memberLabel(members, id, 'user');
    // Who a message named and reached leaves out hidden members for anyone but the coordinator; authors stay as written.
    const unseen = new Set(hub.seesHidden(me.clusterId, me.id) ? [] : members.filter((m) => m.hiddenAt && !m.removedAt).map((m) => m.id));
    const msgs = hub.readMessages(me.id, { limit, history, before, since, until, q, sender, mentions, category });
    const annotations = hub.store.annotateMessagesForMember(me.id, msgs);
    return text(hub.store.withDeliveries(msgs).map((m) => {
      // Attachments: name and size, plus the local path for a native member (docs/files.md).
      const attachments = hub.attachmentsFor(m.id);
      const classified = annotations.get(m.id)!;
      // Delivery outcomes only on the caller's own messages: who got someone else's message is not its business.
      return {
        id: m.id, from: nameOf(m.from), mentions: m.mentions.filter((id) => !unseen.has(id)).map(nameOf), body: m.body, replyTo: m.replyTo, createdAt: m.createdAt,
        category: classified.category,
        annotations: classified.annotations,
        ...(m.fyi ? { fyi: true } : {}),
        ...(attachments.length ? { attachments } : {}),
        acknowledgements: m.acknowledgements.map((a) => (compact ? { member: nameOf(a.memberId) } : { member: nameOf(a.memberId), at: a.at })),
        ...hub.store.plugins.pickMessageFields(m),
        ...(m.from === me.id ? { deliveries: hub.deliveryOutcomes(m.id, me.id).map((d) => (compact && d.status === 'done' ? { to: d.to, status: d.status } : d)) } : {}),
      };
    }));
  });

  server.registerTool('skip_unread', {
    description: 'Mark your relevant unread messages as read without acknowledging them. '
      + 'Give at most one of before (a messageId in this cluster; up to and including it) or until (ISO time, inclusive), and optionally `category` (mention, user, broadcast, task_notice) to skip only that unread category. Without `category`, one of before or until is required. '
      + 'Returns {skipped}. Not a confirmation: no acknowledgement is written and queued deliveries are untouched.',
    inputSchema: {
      before: z.string().optional().describe('skip relevant unread up to and including this messageId'),
      until: z.string().optional().describe('skip relevant unread created at or before this ISO time'),
      category: z.enum(['mention', 'user', 'broadcast', 'task_notice']).optional()
        .describe('only skip unread messages in this category: mention, user, broadcast, or task_notice'),
      clusterId,
      ...signed,
    },
  }, async (args, extra) => {
    const { before, until, category } = args;
    const me = select(extra._meta, args, before ? [before] : []);
    if ('isError' in me) return me;
    try { return reply(hub, me, { skipped: hub.skipUnread(me.id, { before, until, category }) }); } catch (e) { return fail(e); }
  });

  server.registerTool('get_deliveries', {
    description: 'Inspect delivery info for a message in your cluster, returning {fyi, deliveries} where fyi is whether the message was sent with fyi=true and deliveries lists per-recipient to, status, outcome, reason and available queuedAt/startedAt/endedAt. '
      + 'Senders may inspect their own messages; the currently enabled coordinator with deliveryControl may inspect other senders, in execute or suggest mode. '
      + 'Missing outcome evidence is unknown; superseded means the delivery never started. Times describe Hub delivery records, not proof that a native turn ended. This read-only query never marks messages read, acknowledges them or retries delivery.',
    inputSchema: { clusterId, messageId: z.string(), ...signed },
  }, async (args, extra) => {
    const me = select(extra._meta, args, [args.messageId]);
    if ('isError' in me) return me;
    try { return reply(hub, me, hub.getDeliveries(me.id, args.messageId)); } catch (e) { return fail(e); }
  });

  server.registerTool('ack_messages', {
    description: 'Explicitly confirm that you saw messages in your cluster. Use their message IDs; up to 100 unique IDs per call. A retry is safe. This ack (a 👍) IS the receipt: do not send a separate message just to say you got it.',
    inputSchema: {
      messageIds: z.array(z.string()).min(1).max(100).describe('1 to 100 unique message IDs from other senders'),
      clusterId,
      ...signed,
    },
  }, async (args, extra) => {
    const me = select(extra._meta, args, args.messageIds);
    if ('isError' in me) return me;
    try {
      return text({ acknowledged: hub.ackMessages(me.id, args.messageIds) });
    } catch (e) {
      return fail(e);
    }
  });

  /**
   * wait_for_messages for a harness on the background-wait route. `who` names the conversation from trusted input only
   * (the runtime's _meta for ZCode, the bridge's session header for WorkBuddy); the tickets, waits and command are the
   * shared core (./wait-core.ts). The re-arm rule lives here and in the skill, never in the envelope.
   */
  const waitTool = (h: WaitHarness, o: {
    description: string;
    who: (meta: Record<string, unknown> | undefined) => { sessionId: string } | ToolError;
    ticket: (secret: string, sessionId: string) => string;
    command: (ticket: string, hubUrl: string) => string;
    waitsOf: (hub: Hub, secret: string) => { count(sessionId: string): number };
    instructions: (running: number) => string;
  }) => server.registerTool('wait_for_messages', { description: o.description, inputSchema: {} }, async (_args, extra) => {
    const who = o.who(extra._meta);
    if ('isError' in who) return who;
    const callers = hub.nativeCallers(h.harness, who.sessionId);
    if (!callers.length) return NOT_MEMBER;
    if (callers.every((m) => m.hiddenAt)) return HIDDEN;
    try {
      const command = o.command(o.ticket(secret, who.sessionId), hubUrl);
      const running = o.waitsOf(hub, secret).count(who.sessionId);
      return text({ command, run_in_background: true, description: WAIT_DESCRIPTION, running, instructions: o.instructions(running) });
    } catch (e) {
      return fail(e);
    }
  });

  if (caller.kind === 'zcode') {
    waitTool(ZCODE_WAIT, {
      description: 'Join your orrery cluster chat from this ZCode conversation: returns a command to run with Bash in the background '
        + '(run_in_background: true). It waits for cluster messages; when some arrive it prints them and exits, which starts a turn here. '
        + 'Read its output file, handle each message once, then run the same command again in the background. Only one at a time.',
      who: (meta) => {
        const who = zcodeCaller(meta);
        if (who?.subagent) return fail(new Error('只能在主对话里挂等待：子代理里的后台命令最多运行 1 小时，结束后它的通知不会送到主对话'));
        if (who?.remote) return fail(new Error('远程工作区（SSH、WSL）的对话不能挂等待：等待命令在远程机器上运行，连不到本机的 orrery'));
        return who ? { sessionId: who.sessionId } : NOT_MEMBER;
      },
      ticket: ticketFor,
      command: waitCommand,
      waitsOf,
      instructions: (running) => (running ? `这个对话现在已经有 ${running} 条这样的命令连着 orrery：不要再运行，照常结束这一轮。` : '')
        + `用 Bash 在后台运行 command（run_in_background: true，description 写「${WAIT_DESCRIPTION}」），然后照常结束这一轮。`
        + '它等群里发给你的消息，收到就打印出来并退出，这会开一轮：读它的输出文件，每条消息只处理一次（按 messageId 认），'
        + '处理完再在后台运行同一条命令。这个对话里已经有这条命令在运行时，不要再运行第二条。'
        + '如果这条命令是被停止的（不是正常结束），不要重新运行，也不要再处理之前已经处理过的消息。',
    });
  }

  // WorkBuddy's bridge names the conversation in every request's x-orrery-session header, taken from its own process
  // environment: the model cannot choose it. The envelope carries chat content only (WorkBuddy's AI guard may block
  // "run it again" wording in command output), so the re-arm rule is in this description and the skill.
  if (caller.kind === 'session' && caller.harness === WORKBUDDY) {
    const sessionId = caller.sessionId;
    waitTool(WORKBUDDY_WAIT, {
      description: '在 WorkBuddy 的这个对话里加入 orrery 群聊：返回一条等待命令，用终端在后台运行（run_in_background: true）。'
        + '命令等群里的消息，收到就把消息打印出来并退出，WorkBuddy 因此在这个对话里开一轮。'
        + '读它的输出文件，每条消息只处理一次（按 messageId 认），处理完把同一条命令再挂到后台；同一时间只挂一条。'
        + '这条命令被停止（不是正常结束）时，不要再把它挂到后台，也不要再处理之前处理过的消息。',
      who: () => ({ sessionId }),
      ticket: workbuddyTicketFor,
      command: workbuddyWaitCommand,
      waitsOf: workbuddyWaitsOf,
      instructions: (running) => (running ? `这个对话现在已经有 ${running} 条这样的命令连着 orrery：不要再运行，照常结束这一轮。` : '')
        + `用终端在后台运行 command（run_in_background: true，description 写「${WAIT_DESCRIPTION}」），然后照常结束这一轮。`
        + '它等群里发给你的消息，收到就打印出来并退出，这会开一轮：读它的输出文件，每条消息只处理一次（按 messageId 认），'
        + '处理完把同一条命令再挂到后台。这个对话里已经有这条命令在运行时，不要再运行第二条。'
        + '如果这条命令是被停止的（不是正常结束），不要再把它挂到后台，也不要再处理之前已经处理过的消息。',
    });
  }

  if (caller.kind === 'qoder') {
    server.registerTool('wait_for_messages', { description: QODER_WAIT_TOOL, inputSchema: {} }, async (_args, extra) => {
      const sessionId = qoderSession(extra._meta);
      const callers = sessionId ? hub.nativeCallers(QODER, sessionId) : [];
      if (!sessionId || !callers.length) return NOT_MEMBER;
      if (callers.every((m) => m.hiddenAt)) return HIDDEN;
      try {
        return text(qoderWaitReply(hub, secret, sessionId, hubUrl));
      } catch (e) {
        return fail(e);
      }
    });
  }

  // The same authenticated member and cluster selection as the chat tools; no tool argument chooses the caller.
  const page = {
    limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results, up to 100.'),
    cursor: z.string().optional().describe('Continue from a previous nextCursor.'),
  };
  const operationId = z.string().describe('Unique ID for this operation; reuse it when retrying the same request.');
  const generation = z.number().int().describe('Required when acting as coordinator; use list_tasks.coordinator.generation.');
  // A tool result stays in the caller's conversation and is read again on every later model call, so the defaults
  // are small and parameters bring back the full shape (docs/collaboration-api.md). Fields are only left out, never
  // renamed; the HTTP API is unchanged.
  const query = (name: string, description: string, kind: CollaborationQuery['kind'], schema: Record<string, z.ZodType>,
    prepare: (params: Record<string, unknown>) => Record<string, unknown> = (p) => p,
    project: (result: never, params: Record<string, unknown>, me: { id: string; clusterId: string }) => unknown = (r) => r) =>
    server.registerTool(name, { description, inputSchema: { ...schema, clusterId, ...signed } }, async (args, extra) => {
      const me = select(extra._meta, args);
      if ('isError' in me) return me;
      const { clusterId: _cluster, [CALLER_ARG]: _signature, ...params } = args as Record<string, unknown>;
      try {
        // A plugin's argument mapping and projection may be async: they run in this async handler and are awaited.
        const result = hub.collaboration.query({ kind: 'member', memberId: me.id }, me.clusterId, { ...(await prepare(params)), kind } as CollaborationQuery);
        return reply(hub, me, await project(result as never, params, me));
      } catch (e) { return fail(e); }
    });
  const command = (name: string, description: string, schema: Record<string, z.ZodType>,
    action: CollaborationCommand['action'] | ((args: Record<string, unknown>) => CollaborationCommand['action']),
    extend: (result: CollaborationResult, me: { id: string; clusterId: string }) => unknown = (r) => r) =>
    server.registerTool(name, { description, inputSchema: { operationId, ...schema, clusterId, ...signed } }, async (args, extra) => {
      const toolArgs = args as Record<string, unknown>;
      const me = select(extra._meta, args, typeof toolArgs.messageId === 'string' ? [toolArgs.messageId] : []);
      if ('isError' in me) return me;
      const { clusterId: _cluster, [CALLER_ARG]: _signature, ...params } = toolArgs;
      try {
        return reply(hub, me, await extend(await hub.collaboration.commandAsync({ kind: 'member', memberId: me.id }, me.clusterId,
          { ...params, action: typeof action === 'function' ? action(toolArgs) : action } as CollaborationCommand), me));
      } catch (e) { return fail(e); }
    });

  command('manage_roles', 'Manage business roles when the coordinator policy permits it: create requires name and takes an optional description; edit requires roleId and description (an empty string clears it); delete requires roleId; assign requires memberId and roleIds (an empty array clears the roles).', {
    action: z.enum(['create', 'edit', 'delete', 'assign']), name: z.string().optional(), roleId: z.string().optional(),
    memberId: z.string().optional(), roleIds: z.array(z.string()).optional(), description: z.string().optional(), generation,
  }, (args) => args.action === 'assign' ? 'member.roles' : `role.${args.action}` as CollaborationCommand['action']);
  // Hiding a member rides on this tool (no new tool): it is the coordinator's other switch over delivery (deliveryControl).
  command('set_cluster_paused', SET_CLUSTER_PAUSED, {
    paused: z.boolean().optional().describe('true pauses this cluster’s delivery, false resumes it; leave out when hiding or showing a member'),
    memberId: z.string().optional().describe('coordinator only: the member to hide or show (ID or unique name); not yourself'),
    hidden: z.boolean().optional().describe('with memberId: true hides the member, false shows it again'),
    generation,
  }, (args) => (args.memberId !== undefined || args.hidden !== undefined ? 'member.hidden' : 'cluster.pause'));

  // Each plugin's tools are collected first and registered as one set (docs/plugins.md「故障隔离」): a plugin whose
  // tools(api) throws, or one of whose names is already taken (a core tool, an earlier plugin's) or belongs to the
  // restricted plugins' namespace (p_…, registered after these), loses only its own tools, every one of them, and the
  // failure shows on its settings card.
  const own = (name: string, sealed: boolean) => {
    if (sealed) throw new Error(`tool ${name} was declared after tools(api) returned`);
    if (isPluginToolName(name)) throw new Error(`tool name ${name} is reserved for restricted third-party plugins (p_<plugin>_<tool>)`);
  };
  for (const plugin of hub.store.plugins.enabled) {
    if (!plugin.tools) continue;
    const declared: (() => RegisteredTool)[] = [];
    let sealed = false;   // declarations after the build (an async tools continuing later) are refused
    const toolApi = { page, hub, secret, hubUrl,
      query: (...args: Parameters<typeof query>) => { own(args[0], sealed); declared.push(() => query(...args)); },
      command: (...args: Parameters<typeof command>) => { own(args[0], sealed); declared.push(() => command(...args)); } } as unknown as PluginToolApi;   // zod shapes are opaque to core's plugin types
    const registered: RegisteredTool[] = [];
    try {
      // tools(api) declares synchronously: a promise (an async tools) is refused whole, so nothing it declared before or
      // after an await is registered, and its rejection is caught.
      const answer: unknown = plugin.tools(toolApi);
      if (isThenable(answer)) { sealed = true; throw asyncRefused(answer, 'tools(api)'); }
      for (const register of declared) registered.push(register());
    } catch (e) {
      for (const tool of registered) tool.remove();
      hub.pluginFault(plugin.id, 'tools', e);
    } finally { sealed = true; }
  }

  // Third-party plugin tools (docs/external-plugins.md「群员工具」): only for a caller whose conversation is known when
  // it lists tools (a bridge's session header), so the list is that conversation's own. The catalogs
  // built without a member (fingerprints, offline catalogs) never contain one. Listed with exactly the declared schema;
  // the SDK lets every object through and the Hub checks the arguments itself. (The transport's own parsing already
  // drops a `__proto__` key, so no plugin can ever receive one.)
  // A tool of a plugin that is not running is registered too, so a tools/call of it (an app still showing an older list)
  // gets PLUGIN_NOT_RUNNING; handleMcp takes it out of every tools/list answer of this request, a batch's included.
  if (caller.kind === 'session') {
    const members = current(undefined);
    const dormant = new Set<string>();
    for (const tool of Array.isArray(members) ? hub.pluginTools(members) : []) {
      // One tool that cannot be registered (a name taken some other way) is left out; it never fails the whole build.
      try {
        server.registerTool(tool.name, { description: tool.description, inputSchema: z.looseObject({}).meta(tool.inputSchema) },
          async (args, extra) => pluginTool(tool.name, args, extra._meta));
      } catch (e) {
        console.warn(`plugin tool ${tool.name} left out: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (!tool.running) dormant.add(tool.name);
    }
    if (dormant.size) dormantTools.set(server, dormant);
  }

  /**
   * One plugin tool call: the caller and its cluster resolved as for every tool (the `clusterId` argument chooses among
   * the conversation's own memberships, never another identity), then the Hub's checks and the plugin's answer. Once the
   * plugin answered, the same caller is resolved again: the answer goes back only to the same shown membership.
   */
  async function pluginTool(name: string, raw: unknown, meta: Record<string, unknown> | undefined) {
    const input = raw === undefined || raw === null ? {} : raw;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(Object.assign(new Error('参数须是一个 JSON 对象。'), { code: 'INVALID_ARGUMENT' }));
    const fields = input as Record<string, unknown>;
    const cluster = Object.hasOwn(fields, 'clusterId') ? fields.clusterId : undefined;
    if (cluster !== undefined && typeof cluster !== 'string') return fail(Object.assign(new Error('clusterId 须是字符串。'), { code: 'INVALID_ARGUMENT' }));
    const me = select(meta, cluster === undefined ? {} : { clusterId: cluster });
    if ('isError' in me) return me;
    const outcome = await hub.callPluginTool({
      name, clusterId: me.clusterId, member: { id: me.id, name: me.name },
      arguments: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'clusterId')),
      still: () => {
        const now = current(meta);
        return Array.isArray(now) && now.some((m) => m.id === me.id && m.clusterId === me.clusterId) && !!hub.store.getCluster(me.clusterId);
      },
    });
    if (!outcome.ok) return fail(Object.assign(new Error(outcome.message), { code: outcome.code }));
    const blocks = [...(outcome.text !== undefined ? [outcome.text] : []), ...(outcome.data !== undefined ? [JSON.stringify(outcome.data)] : [])];
    const hint = hub.unreadHint([me]);
    return { content: [...blocks, ...(hint ? [hint] : [])].map((text) => ({ type: 'text' as const, text })) };
  }

  return server;
}

/** List the registered declarations through the same SDK path as a remote tools/list. */
async function registeredTools(hub: Hub, secret: string, caller: Caller, hubUrl: string) {
  const server = buildServer(hub, secret, caller, hubUrl);
  const client = new Client({ name: 'orrery-tool-list', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

/** Default-profile declarations for the offline catalogs. No tool is called. */
export function standardToolDeclarations(hub: Hub) {
  return registeredTools(hub, '', { kind: 'thread' }, '');
}

/** Fingerprint and parameter summary for each profile, captured once per Hub start. */
export async function toolLists(hub: Hub, secret: string, hubUrl: string): Promise<Record<ToolProfile, ToolListSnapshot>> {
  const callers: Record<ToolProfile, Caller> = {
    standard: { kind: 'thread' }, antigravity: { kind: 'antigravity' }, zcode: { kind: 'zcode' }, qoder: { kind: 'qoder' },
    // A bridge caller: the id itself names no member, and tools/list never resolves one.
    workbuddy: { kind: 'session', harness: WORKBUDDY, sessionId: 'fingerprint' },
  };
  const lists = {} as Record<ToolProfile, ToolListSnapshot>;
  for (const profile of Object.keys(callers) as ToolProfile[]) {
    const tools = await registeredTools(hub, secret, callers[profile], hubUrl);
    lists[profile] = { fingerprint: fingerprintTools(tools), tools: summarizeTools(tools) };
  }
  return lists;
}

export async function handleMcp(hub: Hub, secret: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const caller = callerOf(secret, req);
  if (!caller) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (req.method !== 'POST') {
    // Stateless mode: no standalone GET stream, no session DELETE.
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  const server = buildServer(hub, secret, caller, hubUrlOf(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  const receive = transport.onmessage;
  // The tools of plugins that are not running are registered (a call of one is answered PLUGIN_NOT_RUNNING) but taken
  // out of every tools/list answer of this request, also when a batch carries a tools/call and a tools/list together.
  const dormant = dormantTools.get(server);
  const lists = new Set<unknown>();
  if (dormant) {
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      const result = 'result' in message && lists.has(message.id) ? message.result as { tools?: { name: string }[] } : undefined;
      return send(Array.isArray(result?.tools)
        ? { ...message, result: { ...result, tools: result.tools.filter((tool) => !dormant.has(tool.name)) } } as typeof message
        : message, options);
    };
  }
  transport.onmessage = (message, extra) => {
    if ('method' in message && message.method === 'tools/list' && 'id' in message) lists.add(message.id);
    try {
      if ('method' in message && message.method === 'tools/call') {
        const params = message.params as { _meta?: Record<string, unknown>; arguments?: unknown } | undefined;
        const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments as Record<string, unknown> : undefined;
        const members = currentMembers(hub, secret, caller, params?._meta, args);
        if (Array.isArray(members) && members.length) {
          const profile: ToolProfile = caller.kind === 'antigravity' ? 'antigravity' : caller.kind === 'zcode' ? 'zcode'
            : caller.kind === 'qoder' ? 'qoder'
              : caller.kind === 'session' && caller.harness === WORKBUDDY ? 'workbuddy' : 'standard';
          const bridge = caller.kind === 'session' && (caller.harness === 'claude' || caller.harness === 'deepseek') ? caller.harness : null;
          hub.recordToolCall(members, profile, params?._meta, bridge);
        }
      }
    } catch { /* diagnostics must never affect the request */ }
    receive?.(message, extra);
  };
  await transport.handleRequest(req, res);
}
