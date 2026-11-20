// dsh-orrery: the orrery plugin for DeepSeek Harness (DSH). It runs inside the DSH Desktop Host process and connects
// that process to a running orrery Hub on this machine, like the orrery bridge does for Claude Code:
//   - delivery: holds the Hub's shared stream for the `deepseek` harness (GET /bridge/stream?harness=deepseek) and puts
//     each delivered message into its DSH session as a queued user message (sessionController.prompt, mode 'queue'),
//     then acks it (POST /bridge/ack). While the stream is connected, the Hub counts every DSH session as online.
//     DSH runs every queued prompt as a turn of its own, so the plugin also reports when the turn a delivery started
//     has ended (POST /bridge/done): until then the Hub holds further messages for that member and sends them together.
//   - tools: registers the orrery MCP tools. Each call is one JSON-RPC tools/call
//     to the Hub's /mcp, carrying the calling session's id, so the Hub knows which member speaks.
//   - unread hint: after every tool call, asks the Hub (POST /bridge/unread-hint) whether this conversation's unread
//     count changed; a one-line answer becomes one additional context for the next step. The tool result itself is
//     never changed, and every failure leaves the downstream tools/post-execute decision untouched.
// Standalone: Node built-ins only, no dependencies, nothing from the orrery repository at run time. Which Hub and how
// to talk to it: ./hub-discovery.mjs, a byte-identical copy of orrery's plugins/shared/hub-discovery.mjs (the account's
// Hub registry, requests signed with x-orrery-sig, the key never sent; no valid record: nothing is sent). It talks only
// to the loopback address there, never logs the key, never reads DSH credentials and never writes anything. Disabling the plugin (Cordis dispose) closes the stream, stops
// reconnecting, aborts tool calls in progress, sends no further Hub request and unregisters the tools. Contract: docs/adapters/deepseek.md in the orrery repository.
//
// DSH APIs used, checked against upstream github.com/deepseek-ai/deepseek-harness at tag dsh-v0.2.1-rc.2:
//   - plugin shape (name, inject, apply) and ctx.effect cleanup: docs/user/develop/basic/index.md
//   - ctx.sessionController.prompt(request, signal): packages/api/session-controller/src/index.ts:461-486 (signal is
//     required), request type types.ts:344-352; a requestId already accepted is not queued again (commands.ts:321)
//   - turn ends: ctx.on('session/event', (session, event)). A queued prompt is claimed one per turn and logged inside
//     that turn as `user/message` with data.source.rpcId = requestId; the turn closes with `turn/end`
//     { turn, reason: { kind: 'completed' | 'error' | 'aborted' | ... } } (agent-loop ReactLoopAgent.turn, inbox claim).
//     An `aborted` turn/end also ends the wait of prompts not yet seen, with their outcome unknown.
//   - a turn's tokens: every model call of the turn ends with `assistant/message` (or `assistant/attempt` for a failed
//     try) whose data.usage, or else the last `usage` chunk of data.stream, is { inputTokens (uncached), outputTokens,
//     cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }; the plugin sums them from the delivery's user/message to
//     its turn/end and sends the sum with POST /bridge/done (token-meter's turn-usage.js in the 0.2.1 app bundle;
//     not yet checked on a real turn).
//   - ctx.tools.register(definition) → disposer: packages/core/tools/src/index.ts:1071; definition = name, description,
//     parameters (passed through as JSON Schema, as dsh-mcp-client does: packages/mcp/mcp-client/src/tools.ts:234),
//     output { schema, render } (required, index.ts:224-237), execute(args, exec); a throw is the tool's error result
//   - the calling session: exec.agent.id, "Session-backed Agent identity" (packages/core/agent/src/types.ts:17)
//   - tools/post-execute: waterfall (exec, result, next); a listener that does not own the decision returns next(). An
//     accept decision may add additionalContexts (UserMessage[]), which the loop appends as a user/message in the next
//     step. A user message needs a nonempty id, role 'user', a content array and a nonempty source.kind (dsh-session
//     assertMessageEventShape); session format v4 refuses the retired source.kind 'plugin', so the producer kind is
//     'dsh-orrery'. Checked against the installed 0.2.1-rc.2 packages dsh-tools/dsh-session/dsh-agent-loop and the
//     shipped dsh-repeat-tool-reminder plugin's tools/post-execute listener.
//   - tool names: DSH's base bundle already registers global `send_message` and `list_agents` (subagent control), so the
//     Hub's tool names get the prefix dsh-mcp-client would give an MCP server named orrery (mcp-client tools.ts:81-87)
import { randomUUID } from 'node:crypto';
import { Agent } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { callOutcome, HubError, hubFetch, hubStream } from './hub-discovery.mjs';

export const name = 'dsh-orrery';
export const inject = ['sessionController', 'tools'];

const HARNESS = 'deepseek';
const WATCHED = new Set(['user/message', 'turn/end', 'assistant/message', 'assistant/attempt']);

const tokenCount = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Adds one model call's usage (data.usage, or the last `usage` chunk of data.stream) into `sum`. */
export function addUsage(sum, data) {
  let u = data?.usage;
  if (!u && Array.isArray(data?.stream)) {
    for (let i = data.stream.length - 1; i >= 0 && !u; i--) {
      const r = data.stream[i];
      if (r?.type === 'chunk' && r.chunk?.type === 'usage') u = r.chunk.usage;
    }
  }
  if (typeof u !== 'object' || u === null) return;
  sum.input += tokenCount(u.inputTokens);
  sum.cachedInput += tokenCount(u.cacheReadTokens);
  sum.cacheWrite += tokenCount(u.cacheWriteTokens);
  sum.output += tokenCount(u.outputTokens);
  sum.reasoning += tokenCount(u.reasoningTokens);
  sum.calls++;
}
const TOOL_PREFIX = 'mcp__orrery__';
const RETRY_MS = 5000;
const ACTIVITY_HEARTBEAT_MS = 15_000;
const TURN_WAIT_MS = 30 * 60_000;   // stop watching a turn after this long (the Hub stops waiting after the same time)
const KEEP_FINISHED = 1000;         // recently observed results, remembered if a Hub redoes a delivery
const HINT_TIMEOUT_MS = 500;        // a hung Hub must not hold up a tool result
const HINT_SOURCE = { kind: 'dsh-orrery', form: 'notice', summary: 'orrery unread hint' };

// BEGIN GENERATED MCP TOOLS
export const TOOLS = [
  {"name":"list_agents","description":"List the members of your orrery cluster: memberId, name, harness, model, status, observed activity, business roles (id and name) and current load (working, assigned, reviewing). Load counts active tasks of this cluster only.","inputSchema":{"type":"object","properties":{"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"send_message","description":"Post a message to your cluster chat. Write @name in the body to deliver it to that member (@all = a broadcast: every member keeps it unread, but only members you also name explicitly receive a delivery); write the member's full name and follow it with a space, punctuation or the end of the text: a letter or digit right after the name makes it another name (@name你好 reaches nobody); @ inside inline code, code blocks or quotes is plain text. Without any @ the message reaches nobody and only stays in the chat record; @name the coordinator when you need it to act. Pass to: [member names] to deliver only to those members and treat the body as plain text. Write #number (e.g. #12) or #<full task ID> to show a link to that task of this cluster in the chat (# inside inline code, code blocks or quotes is plain text). Returns immediately: `deliveredTo` lists who it was queued for, not who got it; `unresolvedMentions` lists @names in the body that match no member (`mentionHints` says when one starts with a member's name), and when there is no recipient at all, `warning` says the message only stays in the chat record and names the members available in this cluster (both come from the first send; a repeat with the same `clientMessageId` returns only the original messageId and deliveredTo). Whether each did shows later as `deliveries` on your own messages in read_messages (`history: true`); recipients it did not reach or whose result is unknown are also named in your next orrery delivery. Speak only to ask, deliver a result, report a blockage or ask someone to act; acknowledgement belongs to ack_messages. Set `fyi: true` when nobody has to act (a progress note, thanks): never set `fyi` when answering someone's question; when `fyi: true` is used, named members keep it unread without being woken, except if `replyTo` is set and the sender of the replied-to message is still an active member explicitly named in this message, that asker IS woken and `fyiOverridden` lists their name. Task results and evidence go into the `summary` of task_action submit: the Hub notifies the reviewer, so do not @ the reviewer separately; @ the coordinator only to ask for reassignment or when the flow is stuck. A plugin the user installed may refuse a send (error REFUSED_BY_PLUGIN with its reason): nothing was stored or delivered; wait or rephrase, and do not resend it unchanged in a loop.","inputSchema":{"type":"object","properties":{"body":{"type":"string"},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"},"replyTo":{"description":"messageId being replied to: a full ID or a unique prefix of at least 8 characters in this cluster","type":"string"},"to":{"description":"member names to deliver to; when set, the body is plain text","type":"array","items":{"type":"string"}},"taskIds":{"description":"Tasks in this cluster to link to this message: #number (e.g. #12), full ID, or a unique prefix of at least 8 characters (bare 8+ digit numbers remain ID prefixes).","type":"array","items":{"type":"string"}},"attachments":{"description":"native members only: names of files you copied into your own orrery outbox folder (its path is in each orrery delivery); bare file names, no paths; real copies, not links; at most 10, 20 MB each. The Hub copies them and never deletes anything in the outbox","maxItems":10,"type":"array","items":{"type":"string"}},"clientMessageId":{"description":"an id you generate for this message. Sending again with the same value returns the existing messageId with `duplicate: true` and writes nothing new, even if the body differs; use it to retry after a lost response. The Hub never resends by itself","type":"string","minLength":1,"maxLength":200},"fyi":{"description":"true: for information only (never set when answering a question). Named members keep it unread without being woken, except an explicitly addressed active sender of `replyTo` is still woken (`fyiOverridden`)","type":"boolean"}},"required":["body"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"read_messages","description":"Read your cluster chat, oldest first. By default returns only your unread messages that concern you since you joined: ones that @-mention you (or @all) and user messages without any @, not your own, excluding sender-only receipts and queue warnings (a member's @all counts unread for everyone but delivers only to the members named explicitly in the same body); each message is returned once, then counts as read. Member messages without any @ and sender-only receipts (no longer written)/queue warnings stay in the chat record; read them with `history: true`. A delivery accepted by the channel or completed also counts as read, but does not mean you explicitly confirmed seeing it. Set `history: true` for the full recent chat instead (all senders, read or not); page back with `before`. Messages with files list them as `attachments` (name, size and, for native members, a local path to read). Your own messages (in the history) carry `deliveries`: per recipient `{to, status, outcome, reason?}`; status is queued, running, done, failed, offline (the member was offline: not delivered and never resent), superseded (replaced before delivery) or blocked (stopped by a loop guard); `outcome` is accepted, completed, failed, unknown, or null when no evidence is available; `reason` comes with failed, blocked and superseded. Every returned message carries `category` (mention, user, broadcast, task_notice, receipt_warning, or null in history when unaddressed to you), `annotations` (parallel tags: fyi, offline, failed_or_unknown, blocked), `acknowledgements` (members who explicitly confirmed seeing it and when; this does not mean task completion), `taskIds` and `bookmarks` (member IDs, labels and times). Optional filters narrow either mode by intersection (AND — every given filter, including `category` alongside `sender` and `mentions`, must match): since/until (ISO time, inclusive), q (case-insensitive body substring, % and _ are literal), sender (member name, user or system), mentions (member name or all) and category (mention, user, broadcast, task_notice, receipt_warning, or warning: system warnings such as failed deliveries, failed ships, queue warnings, stalled members, quota, rejected results and open questions). Unread mode only filters your relevant unread set; filtered-out messages stay unread.","inputSchema":{"type":"object","properties":{"limit":{"description":"default 20 (history: 10), max 100","type":"integer","minimum":1,"maximum":100},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"},"history":{"description":"true: the recent chat history instead of your unread messages","type":"boolean"},"before":{"description":"history only (implies history: true): messages older than this messageId","type":"string"},"since":{"description":"only messages created at or after this ISO time","type":"string"},"until":{"description":"only messages created at or before this ISO time","type":"string"},"q":{"description":"case-insensitive substring of the body; % and _ match literally; max 200 characters","type":"string","maxLength":200},"sender":{"description":"only messages from this member name, or user or system","type":"string"},"mentions":{"description":"only messages @-mentioning this member name, or all","type":"string"},"category":{"description":"only messages in this category (combines with sender/mentions by AND): mention, user, broadcast, task_notice, receipt_warning (history only), or warning (system warnings; overlaps task_notice and receipt_warning)","type":"string","enum":["mention","user","broadcast","task_notice","receipt_warning","warning"]},"detail":{"description":"history only. summary (default): 10 messages, done deliveries as {to, status}, acknowledgements as member names; full: everything.","type":"string","enum":["summary","full"]}},"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"skip_unread","description":"Mark your relevant unread messages as read without acknowledging them. Give at most one of before (a messageId in this cluster; up to and including it) or until (ISO time, inclusive), and optionally `category` (mention, user, broadcast, task_notice) to skip only that unread category. Without `category`, one of before or until is required. Returns {skipped}. Not a confirmation: no acknowledgement is written and queued deliveries are untouched.","inputSchema":{"type":"object","properties":{"before":{"description":"skip relevant unread up to and including this messageId","type":"string"},"until":{"description":"skip relevant unread created at or before this ISO time","type":"string"},"category":{"description":"only skip unread messages in this category: mention, user, broadcast, or task_notice","type":"string","enum":["mention","user","broadcast","task_notice"]},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"get_deliveries","description":"Inspect delivery info for a message in your cluster, returning {fyi, deliveries} where fyi is whether the message was sent with fyi=true and deliveries lists per-recipient to, status, outcome, reason and available queuedAt/startedAt/endedAt. Senders may inspect their own messages; the currently enabled coordinator with deliveryControl may inspect other senders, in execute or suggest mode. Missing outcome evidence is unknown; superseded means the delivery never started. Times describe Hub delivery records, not proof that a native turn ended. This read-only query never marks messages read, acknowledges them or retries delivery.","inputSchema":{"type":"object","properties":{"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"},"messageId":{"type":"string"}},"required":["messageId"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"ack_messages","description":"Explicitly confirm that you saw messages in your cluster. Use their message IDs; up to 100 unique IDs per call. A retry is safe. This ack (a 👍) IS the receipt: do not send a separate message just to say you got it.","inputSchema":{"type":"object","properties":{"messageIds":{"minItems":1,"maxItems":100,"type":"array","items":{"type":"string"},"description":"1 to 100 unique message IDs from other senders"},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["messageIds"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"manage_roles","description":"Manage business roles when the coordinator policy permits it: create requires name and takes an optional description; edit requires roleId and description (an empty string clears it); delete requires roleId; assign requires memberId and roleIds (an empty array clears the roles).","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"action":{"type":"string","enum":["create","edit","delete","assign"]},"name":{"type":"string"},"roleId":{"type":"string"},"memberId":{"type":"string"},"roleIds":{"type":"array","items":{"type":"string"}},"description":{"type":"string"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","action","generation"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"set_cluster_paused","description":"Pause or resume this cluster’s delivery when the coordinator policy permits it (paused). The enabled coordinator with deliveryControl may instead hide a member (memberId and hidden: true): a hidden member receives no messages, is not shown to the other members and its orrery tools do nothing; hidden: false shows it again. Nobody can hide itself, and the coordinator cannot be hidden.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"paused":{"description":"true pauses this cluster’s delivery, false resumes it; leave out when hiding or showing a member","type":"boolean"},"memberId":{"description":"coordinator only: the member to hide or show (ID or unique name); not yourself","type":"string"},"hidden":{"description":"with memberId: true hides the member, false shows it again","type":"boolean"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","generation"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"list_tasks","description":"List this cluster’s tasks and coordinator policy, 20 per page with a cursor for more. By default only unfinished tasks (no completed, merged or cancelled ones unless status asks for them, or includeClosed), each as a summary (id, number, title, status, proposalState, priority, revision, executor (assignedMemberId), reviewer, labels, dependencies and their readiness, approvedSubmissionId, requiresApproval, mergeRequired, mergedCommitSha, mergedSubmissionId, and closeReason on a cancelled task); detail: \"full\" returns whole tasks, get_task returns one. The coordinator is summarized as memberId, enabled, mode, generation, permissions and rulesVersion; include adds roles, memberRoles, labels (the label groups this cluster uses, each with name, description, required and its labels, plus the ungrouped labels; archived labels are left out; list_labels shows the whole library) or rules (the coordinator rules text and the user’s standing instructions). Include taskPermissions to see the group role gates for creating, executing and reviewing tasks. An empty group role list allows every member. q matches title/scope/acceptance text, task numbers (#12 or bare digits, sorting first), and task ids (full UUID or a 4+ character id prefix; id hits follow number hits). label may be repeated (array) to require every label (AND). The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"limit":{"description":"Maximum number of results, up to 100.","type":"integer","minimum":1,"maximum":100},"cursor":{"description":"Continue from a previous nextCursor.","type":"string"},"q":{"description":"Keyword for title/scope/acceptance, a task number (#12 or bare digits, sorted first), or a task id (full UUID or 4+ character id prefix).","type":"string"},"memberId":{"type":"string"},"label":{"description":"A label, or several labels that must all match (AND).","anyOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}]},"status":{"type":"string","enum":["pending","working","review","completed","merged","cancelled"]},"includeClosed":{"description":"true: also completed, merged and cancelled tasks (default false; a status filter overrides it).","type":"boolean"},"detail":{"description":"summary (default) or full task records.","type":"string","enum":["summary","full"]},"include":{"description":"Extra parts to return; none by default.","type":"array","items":{"type":"string","enum":["roles","memberRoles","labels","rules","taskPermissions"]}},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"list_labels","description":"Read the label library shared by every cluster: groups (id, name, description, required, newClusterDefault, createdBy, and selected: whether this cluster uses it) with their labels (id, name, description, color, archived, createdBy, usage: how many tasks and clusters carry it), the ungrouped labels, and the preset packs add_pack can add. list_tasks with include: [\"labels\"] is the short view of this cluster’s groups.","inputSchema":{"type":"object","properties":{"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"manage_labels","description":"Change the label library shared by every cluster. create: name (1-20 characters, no commas; group names too), optional groupId, description, color. edit: labelId and any of name, groupId (null: ungrouped), description, color (null: automatic), archived; a name another label already has merges this label into it. merge: labelId into intoLabelId. delete: labelId; tasks keep the text. create_group: name, optional description, required (every cluster using the group needs one of its labels on each new task), newClusterDefault (new clusters use the group). edit_group: groupId and any of those fields. delete_group: groupId; its labels become ungrouped. add_pack: pack; names that already exist are skipped. select_group: groupId and selected, whether this cluster uses the group. labelId, intoLabelId and groupId take an ID or a name. A member may delete, or merge away, only labels and groups it created itself; ask the user for others. A rename or merge changes every task with that label in every cluster, closed ones too, without a revision change or notice; each affected cluster records the changed tasks with their labels before and after in an event.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"action":{"type":"string","enum":["create","edit","merge","delete","create_group","edit_group","delete_group","add_pack","select_group"]},"name":{"type":"string"},"description":{"type":"string"},"labelId":{"type":"string"},"intoLabelId":{"type":"string"},"groupId":{"type":["string","null"]},"color":{"description":"A tag colour 0-7; null picks one from the name.","anyOf":[{"type":"integer","minimum":0,"maximum":7},{"type":"null"}]},"archived":{"description":"Archived labels stay on tasks but cannot be added to more.","type":"boolean"},"required":{"type":"boolean"},"newClusterDefault":{"type":"boolean"},"pack":{"type":"string","enum":["task-types"]},"selected":{"type":"boolean"},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","action"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"get_task","description":"Read a task and its attachments (name, size and, for native members, a local path to read), assignments, submissions (with commitSha and superseded), reviews (full text, with round and commitSha), approvals, merges, dependencies (as summaries), history, watchers (every member watching it, with its note) and watching (your own entry, or null). Records come 20 per page (limit, cursor). Events come newest first, 5 per page (eventsLimit); eventsCursor pages back to older ones; each event lists changedFields unless eventDetail is \"full\". The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes)."},"limit":{"description":"Maximum number of results, up to 100.","type":"integer","minimum":1,"maximum":100},"cursor":{"description":"Continue from a previous nextCursor.","type":"string"},"eventsCursor":{"description":"Continue to older events from eventsNextCursor.","type":"string"},"eventsLimit":{"description":"Events per page, newest first; default 5.","type":"integer","minimum":1,"maximum":50},"eventDetail":{"description":"summary (default): each event lists changedFields instead of the before/after values in changes, and review events leave out their reason (get_task has it in reviews); full: everything.","type":"string","enum":["summary","full"]},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["taskId"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"get_task_context","description":"Read a task context: definition, dependencies (as summaries), evidence messages (10 per page), unresolved questions (20 per page) and events (newest first, 5 per page; nextCursor pages back to older ones; changedFields unless eventDetail is \"full\"). The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"taskId":{"type":"string","description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes)."},"limit":{"description":"Maximum number of results, up to 100.","type":"integer","minimum":1,"maximum":100},"cursor":{"description":"Continue from a previous nextCursor.","type":"string"},"messagesCursor":{"description":"Continue messages from messagesNextCursor.","type":"string"},"attentionsCursor":{"description":"Continue unresolved issues from attentionsNextCursor.","type":"string"},"q":{"type":"string"},"sender":{"type":"string"},"since":{"type":"string"},"until":{"type":"string"},"eventsLimit":{"description":"Events per page, newest first; default 5.","type":"integer","minimum":1,"maximum":50},"eventDetail":{"description":"summary (default): each event lists changedFields instead of the before/after values in changes, and review events leave out their reason (get_task has it in reviews); full: everything.","type":"string","enum":["summary","full"]},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["taskId"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"create_task","description":"Group task permissions may restrict the creator, the chosen executor and the chosen reviewer. Check list_tasks with include: [\"taskPermissions\"]. Create a task in this cluster with a goal, scope and acceptance criteria. memberId names its executor; left out, a member who may execute it becomes the executor, and null leaves it unassigned. requiresApproval defaults false; mergeRequired defaults true (set false for work with no code merge). reviewer may be {kind:\"self\"} for a low-risk task the executor checks itself; only the user, the creator or the coordinator with reviewerManagement may set it; the creator may change it only until the first review of the task. dependencyIds accept #number (e.g. #12), a full ID, or a unique prefix of at least 8 characters in this cluster (bare 8+ digit numbers remain ID prefixes); originMessageId accepts a full ID or a unique prefix of at least 8 characters; memberId and reviewer.memberId also accept a unique member name. The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"title":{"type":"string"},"scope":{"type":"string"},"acceptance":{"type":"string"},"priority":{"description":"Task priority; default normal.","type":"string","enum":["low","normal","high"]},"dependencyIds":{"type":"array","items":{"type":"string"}},"executeRoleIds":{"type":"array","items":{"type":"string"}},"reviewRoleIds":{"type":"array","items":{"type":"string"}},"labels":{"description":"Prefer this cluster’s labels (list_tasks with include: [\"labels\"]). Names match the shared label library without case and are stored in its spelling; a name the library lacks is created there as an ungrouped label (1-20 characters, no commas). Each required group this cluster uses needs at least one label (on edit, only when labels change); archived labels cannot be added.","type":"array","items":{"type":"string"}},"reviewer":{"description":"Who should review the result: the user, a member, or self (the executor records their own checks on submit; no reviewer is woken). This is a target, not the caller identity.","anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"user"}},"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"member"},"memberId":{"type":"string"}},"required":["kind","memberId"]},{"type":"object","properties":{"kind":{"type":"string","const":"self"}},"required":["kind"]}]},"requiresApproval":{"description":"Require user approval before assignment or start; default false. Only the user can turn this off.","type":"boolean"},"mergeRequired":{"description":"Require a recorded merge before dependencies are ready; default true for new tasks. Editable before work starts.","type":"boolean"},"fileIds":{"description":"Files attached to the task definition: at most 10 IDs of files stored in this cluster (the folder name in an attachment path is its ID). Edit replaces the whole list and is refused once work has started.","type":"array","items":{"type":"string"}},"batchId":{"description":"Review batch to put it in (B3, ID or prefix; see manage_batch): it takes the batch reviewer.","type":"string"},"memberId":{"description":"Executor of the task; null leaves it unassigned. Left out: the creator when eligible.","type":["string","null"]},"originMessageId":{"type":["string","null"]},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"sourceEventId":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","title","scope","acceptance"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"task_action","description":"New assignments, starts and member reviews also check the group task permissions shown by list_tasks. Edit, assign, start, submit, review, ship_fix, merge, release, cancel, reopen, hand off or take over a task. Edit accepts requiresApproval and mergeRequired; approval itself is user-only through HTTP. Any member may edit only the title, priority and labels of an unfinished task; other edit fields need the creator, the user or the coordinator. The creator may change the reviewer until the first review of the task, but not to self review once work has started. Assign sets or changes the executor before work starts: it requires memberId (or null to clear it). Deprecated, kept for one version: nominate is another name for assign, and claim assigns the task to yourself. The executor starts the task directly; start returns the assignment, and submit requires its assignmentId. Submit requires summary, and commitSha when mergeRequired is true; evidenceMessageIds and evidenceFileIds are optional. Resubmit during review to replace the latest submission. After dependencies change or when resubmitting an invalid completed result, use get_task_context to obtain each dependency’s current approvedSubmissionId and provide expectedDependencyVersions. Review requires the latest submissionId, verdict and reason (immutable review notes, up to 50000 characters); when verdict is reject on a member-reviewed task, pass takeover: true to reject and take over directly into working state with self review bound to the reviewer. Merge is the way out when ship landed the merge but could not report it: commitSha is that merge commit, and it is refused unless read-only git shows it on the target branch with the reviewed commit as its second parent. When ship fails, completed state is preserved so the ticket holder can rerun the existing command, use reopen to return to pending, or (if authorised as the independent member reviewer or self-review executor) call ship_fix with a forward descendant commitSha, summary, active failureEventId and optional baseCommitSha to refresh the ship ticket without reverting to pending. Release, cancel, reopen and handoff require reason; include assignmentId when an assignment exists, and memberId for handoff. Cancel takes an optional closeReason (default other); duplicate and superseded also require relatedTaskId, another task of this cluster, and reopen clears it. On task.* actions, taskId, dependencyIds and relatedTaskId accept #number (e.g. #12), a full ID, or a unique prefix of at least 8 characters in this cluster (bare 8+ digit numbers remain ID prefixes); evidenceMessageIds accept a full ID or a unique prefix of at least 8 characters; memberId (assign, handoff) and reviewer.memberId also accept a unique member name. The current executor may release or hand off their own started assignment without user confirmation; a handoff target needs the execute roles and cannot be the task reviewer (use takeover for that). Takeover hands a task with a member reviewer to that reviewer, who becomes its executor with self review bound through merge: only the designated reviewer (from review or submitted working state) or the user (from pending, working or review) may invoke it, and explicit non-self reviewer options are refused. The previous assignment ends, a result waiting for review is superseded, earlier submissions and reviews stay, and review rounds keep counting. On a task that was taken over, self review is bound to one executor: switching it to self with edit, or giving a self-reviewed task to another executor (assign, claim, handoff), needs the user, and only the bound executor can submit a self review. On a self-review task submit writes the self review and completes the task immediately. Submit links the task to the one local branch whose tip is commitSha in your saved project folder, unless a branch was set by hand; the result's gitBranch says what happened. The current executor can use set_git_branch with gitBranch to set a branch by hand or clear it; the Hub uses the task's linked repository or the executor's saved project folder. Watch: use it when you want to do something after a task finishes but do not depend on it (with a real dependency, use dependencyIds instead); you are woken once when the task is merged, completed without needing a merge, or cancelled, and the watch then ends. A watch and its optional note are visible to everyone in the cluster (members and the user): get_task lists them, and the notice at the end names each watcher with its note. Watching again replaces the note; unwatch stops it. Watch and unwatch need no expectedRevision and change nothing on the task. The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"action":{"type":"string","enum":["edit","assign","start","submit","review","ship_fix","merge","release","cancel","reopen","handoff","takeover","nominate","claim","set_git_branch","watch","unwatch"]},"expectedRevision":{"description":"Current task revision from get_task; required for every action except watch and unwatch.","type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"assignmentId":{"type":"string"},"submissionId":{"type":"string"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"taskId":{"type":"string","description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes)."},"title":{"type":"string"},"scope":{"type":"string"},"acceptance":{"type":"string"},"priority":{"description":"Task priority; default normal.","type":"string","enum":["low","normal","high"]},"dependencyIds":{"type":"array","items":{"type":"string"}},"executeRoleIds":{"type":"array","items":{"type":"string"}},"reviewRoleIds":{"type":"array","items":{"type":"string"}},"labels":{"description":"Prefer this cluster’s labels (list_tasks with include: [\"labels\"]). Names match the shared label library without case and are stored in its spelling; a name the library lacks is created there as an ungrouped label (1-20 characters, no commas). Each required group this cluster uses needs at least one label (on edit, only when labels change); archived labels cannot be added.","type":"array","items":{"type":"string"}},"reviewer":{"description":"Who should review the result: the user, a member, or self (the executor records their own checks on submit; no reviewer is woken). This is a target, not the caller identity.","anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"user"}},"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"member"},"memberId":{"type":"string"}},"required":["kind","memberId"]},{"type":"object","properties":{"kind":{"type":"string","const":"self"}},"required":["kind"]}]},"requiresApproval":{"description":"Require user approval before assignment or start; default false. Only the user can turn this off.","type":"boolean"},"mergeRequired":{"description":"Require a recorded merge before dependencies are ready; default true for new tasks. Editable before work starts.","type":"boolean"},"fileIds":{"description":"Files attached to the task definition: at most 10 IDs of files stored in this cluster (the folder name in an attachment path is its ID). Edit replaces the whole list and is refused once work has started.","type":"array","items":{"type":"string"}},"memberId":{"type":["string","null"]},"summary":{"type":"string"},"evidenceMessageIds":{"type":"array","items":{"type":"string"}},"evidenceFileIds":{"type":"array","items":{"type":"string"}},"expectedDependencyVersions":{"description":"For submit after dependency versions change, map each dependency task ID to its current approved submission ID.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{"type":"string"}},"verdict":{"type":"string","enum":["approve","reject"]},"reason":{"type":"string","maxLength":50000},"takeover":{"description":"Review only when verdict is reject: true takes the task over directly with self review; false/omitted returns to executor.","type":"boolean"},"failureEventId":{"description":"For ship_fix: active task or batch shipFailure eventId.","type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"baseCommitSha":{"description":"For ship_fix (optional): approved commit SHA the forward fix is built on (7-40 hex).","type":"string"},"closeReason":{"description":"Cancel only: why the task is closed; default other.","type":"string","enum":["not_planned","duplicate","superseded","other"]},"relatedTaskId":{"description":"Cancel with duplicate or superseded only: the task this one duplicates or is replaced by (#number e.g. #12, full ID, or unique 8+ character prefix; bare 8+ digit numbers remain ID prefixes).","type":"string"},"commitSha":{"description":"Reviewed branch commit for submit, forward descendant commit for ship_fix, or the merge commit for merge; 7-40 hexadecimal characters, stored lowercase.","type":"string"},"gitBranch":{"description":"For set_git_branch, set a local branch name or pass null to clear the link.","anyOf":[{"type":"object","properties":{"branch":{"type":"string"}},"required":["branch"],"additionalProperties":false},{"type":"null"}]},"note":{"description":"Watch only: a short note, visible to everyone in the cluster and repeated in the notice when the task ends (e.g. \"start #12 after the merge\"); trimmed, then at most 200 characters (UTF-16 code units).","type":"string"},"sourceEventId":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","action","taskId"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"get_batch","description":"Read a review batch (batchId: B3, ID or prefix): its tasks in dependency order with state and commit, progress, whether it is complete (every task submitted) or all approved, and, for the member who runs it, the batch ship command. Without batchId: every open batch. The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"batchId":{"type":"string"},"includeClosed":{"description":"Also cancelled batches.","type":"boolean"},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"manage_batch","description":"Review batches: tasks one reviewer reviews together once all are submitted (woken once, one verdict per task) and ships in one merge. Inside a batch a dependent may start once its upstream is submitted. create: title, reviewer (user or member). add/remove: batchId, taskId, expectedRevision (batch creator or user may add/remove tasks before work starts; adding user-reviewed or requiresApproval tasks requires user); add only before the batch's first review. attribute_failure: batchId, failureEventId, taskIds, reason; by the independent batch member reviewer once per active checks failure before ship_fix. cancel: batchId, reason; its tasks become ordinary tasks. merge: batchId, commitSha, only when ship landed but could not report. The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"action":{"type":"string","enum":["create","add","remove","cancel","merge","attribute_failure"]},"title":{"type":"string"},"reviewer":{"anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"user"}},"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"member"},"memberId":{"type":"string"}},"required":["kind","memberId"]}]},"batchId":{"type":"string"},"taskId":{"description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes).","type":"string"},"expectedRevision":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"failureEventId":{"description":"For attribute_failure: active batch shipFailure eventId.","type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"taskIds":{"description":"For attribute_failure: batch task refs responsible for the checks failure (Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes).).","type":"array","items":{"type":"string"}},"reason":{"type":"string"},"commitSha":{"type":"string"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","action"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"raise_attention","description":"Record a question, blocker or other issue on a task. The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"taskId":{"type":"string","description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes)."},"expectedRevision":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Current task revision from get_task."},"assignmentId":{"type":"string"},"submissionId":{"type":"string"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"kind":{"type":"string"},"question":{"type":"string"},"targetMemberId":{"type":["string","null"]},"sourceEventId":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","taskId","expectedRevision","kind","question"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"resolve_attention","description":"Resolve a recorded task issue with an explanation. The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"taskId":{"type":"string","description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes)."},"attentionId":{"type":"string"},"resolution":{"type":"string"},"expectedRevision":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Current task revision from get_task."},"assignmentId":{"type":"string"},"submissionId":{"type":"string"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","taskId","attentionId","resolution","expectedRevision"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"set_task_summary","description":"Save a task summary with its source messages and the latest event it covers. The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"taskId":{"type":"string","description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes)."},"summary":{"type":"string"},"throughEventId":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"sourceMessageIds":{"type":"array","items":{"type":"string"}},"expectedRevision":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Current task revision from get_task."},"assignmentId":{"type":"string"},"submissionId":{"type":"string"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","taskId","summary","throughEventId","sourceMessageIds","expectedRevision"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"link_message_tasks","description":"Add or remove task links on an existing message in this cluster. messageId accepts a full ID or a unique prefix of at least 8 characters in this cluster; taskIds and removeTaskIds accept #number (e.g. #12), a full ID, or a unique prefix of at least 8 characters (bare 8+ digit numbers remain ID prefixes). The result includes members, keyed by referenced member ID, with name and removed for each visible member.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"messageId":{"type":"string"},"taskIds":{"description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes).","type":"array","items":{"type":"string"}},"removeTaskIds":{"description":"Accepts #number (e.g. #12), full ID, or a unique 8+ character ID prefix (bare 8+ digit numbers remain ID prefixes).","type":"array","items":{"type":"string"}},"reason":{"type":"string"},"generation":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Required when acting as coordinator; use list_tasks.coordinator.generation."},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","messageId"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"list_bookmarks","description":"Find cluster bookmarks by member, task, label, sender, time or keyword; 20 per page. Message bodies over 2000 characters are cut and marked truncated unless detail is \"full\".","inputSchema":{"type":"object","properties":{"limit":{"description":"Maximum number of results, up to 100.","type":"integer","minimum":1,"maximum":100},"cursor":{"description":"Continue from a previous nextCursor.","type":"string"},"memberId":{"type":"string"},"taskId":{"type":"string"},"label":{"type":"string"},"q":{"type":"string"},"sender":{"type":"string"},"since":{"type":"string"},"until":{"type":"string"},"detail":{"description":"summary (default): long bodies cut; full: whole bodies.","type":"string","enum":["summary","full"]},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
  {"name":"bookmark_message","description":"Set your bookmark and labels on a message, or remove your own bookmark. messageId accepts a full ID or a unique prefix of at least 8 characters in this cluster.","inputSchema":{"type":"object","properties":{"operationId":{"type":"string","description":"Unique ID for this operation; reuse it when retrying the same request."},"action":{"type":"string","enum":["set","remove"]},"messageId":{"type":"string"},"labels":{"type":"array","items":{"type":"string"}},"clusterId":{"description":"Cluster ID from the orrery envelope; required for a conversation in multiple clusters unless message IDs identify one cluster.","type":"string"}},"required":["operationId","action","messageId"],"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}},
];
// END GENERATED MCP TOOLS

// This is the plugin's source list, not proof of what a model has cached.
function fingerprintTools(tools) {
  const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';
  const copy = JSON.parse(JSON.stringify(tools));
  copy.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return `sha256:${createHash('sha256').update(canonical(copy), 'utf8').digest('hex')}`;
}
const errText = (e) => (e instanceof Error ? (e.code ? `${e.code}: ${e.message}` : e.message) : String(e));

/** Project the Hub's current tool schemas to the JSON Schema subset understood by DSH's PTC type renderer. */
export function projectToolParameters(schema) {
  const description = schema.description ? { description: schema.description } : {};
  if (Array.isArray(schema.type)) return { ...description, oneOf: schema.type.map((type) => ({ type })) };
  // The Hub uses anyOf for exclusive alternatives, such as reviewer kinds or the branch object and null.
  if (schema.anyOf) return { ...description, oneOf: schema.anyOf.map(projectToolParameters) };
  const projected = { ...description, ...(schema.type ? { type: schema.type } : {}) };
  if (schema.properties) projected.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, projectToolParameters(value)]));
  if (schema.required) projected.required = schema.required;
  if (schema.items) projected.items = projectToolParameters(schema.items);
  if (schema.enum) projected.enum = schema.enum;
  if (schema.const !== undefined) projected.const = schema.const;
  if (typeof schema.additionalProperties === 'boolean') projected.additionalProperties = schema.additionalProperties;
  else if (schema.additionalProperties) {
    // The only current typed record is expectedDependencyVersions; DSH supports only an open object here.
    projected.additionalProperties = true;
    projected.description = `${schema.description ?? ''} Values must be strings; the Hub validates them.`.trim();
  }
  return projected;
}

/** Cordis entry point. */
export function apply(ctx) {
  start(ctx);
}

/**
 * The plugin's work, with test-only options: `env` (default process.env: ORRERY_REGISTRY, ORRERY_HUB, ORRERY_LEGACY_HUB), `retryMs`, `turnWaitMs`,
 * `activityHeartbeatMs` and `hintTimeoutMs`.
 * Everything it starts lives in one ctx.effect, so Cordis disposing the plugin ends all of it.
 */
export function start(ctx, opts = {}) {
  const env = opts.env ?? process.env;
  const retryMs = opts.retryMs ?? RETRY_MS;
  const turnWaitMs = opts.turnWaitMs ?? TURN_WAIT_MS;
  const hintTimeoutMs = opts.hintTimeoutMs ?? HINT_TIMEOUT_MS;
  const log = typeof ctx.logger === 'function' ? ctx.logger('orrery') : console;

  ctx.effect(() => {
    const stop = new AbortController();
    // Every Hub request goes straight to the loopback address the registry names, on an agent of our own: with
    // NODE_USE_ENV_PROXY=1, fetch and the global agent would send it to HTTP_PROXY. node:http never follows redirects.
    const direct = new Agent();
    const hubLog = (m) => log.info(m);
    // ───────────── Hub ─────────────

    /** Every Hub request goes through here with a signal that stop aborts, so none starts after dispose. */
    async function hubPost(path, headers, body, signal, hub) {
      await null;   // a call started just before dispose finds the signal aborted here and sends nothing
      signal.throwIfAborted();
      return hubFetch('POST', path, { headers, body, signal, env, log: hubLog, agent: direct, ...(hub ? { hub } : {}) });
    }

    const isOk = (status) => status >= 200 && status < 300;

    let bridgeToolVersion = null;
    // ───────────── tools ─────────────

    function toolDefinition(tool) {
      return {
        name: TOOL_PREFIX + tool.name,
        description: tool.description,
        parameters: projectToolParameters(tool.inputSchema),
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (args, exec) => callTool(tool.name, args, exec),
      };
    }

    /** One tools/call to the Hub as the calling session. Resolves with the result text; throws the error text. */
    async function callTool(tool, args, exec) {
      const sessionId = exec?.agent?.id;
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('orrery 插件拿不到调用方会话的 ID，无法代表它调用 orrery');
      // Aborted by the caller or by disabling the plugin, whichever comes first.
      const signal = exec?.signal ? AbortSignal.any([stop.signal, exec.signal]) : stop.signal;
      signal.throwIfAborted();
      const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args && typeof args === 'object' ? args : {}, _meta: { 'orrery/bridgeToolVersion': bridgeToolVersion } } };
      let status;
      let body;
      try {
        ({ status, text: body } = await hubPost('/mcp', {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-orrery-session': sessionId,
          'x-orrery-harness': HARNESS,
        }, JSON.stringify(call), signal));
      } catch (e) {
        if (signal.aborted) throw e;
        // Says whether the plugin sent nothing, the Hub refused, or the Hub could not be reached.
        throw new Error(callOutcome(e));
      }
      if (!isOk(status)) throw new Error(`orrery Hub 拒绝了请求（HTTP ${status}）`);
      let reply;
      try {
        reply = JSON.parse(body);
      } catch {
        throw new Error('orrery Hub 的回答不是 JSON');
      }
      if (reply?.error) throw new Error(String(reply.error.message ?? 'orrery Hub 返回了错误'));
      const result = reply?.result;
      const text = (Array.isArray(result?.content) ? result.content : [])
        .filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
      if (result?.isError) throw new Error(text || 'orrery 工具调用失败');
      return text;
    }

    // ───────────── unread hint: tools/post-execute → one line in the next step ─────────────

    /**
     * The Hub's one-line unread hint for this conversation, or null for "no hint" and for every failure.
     * Never throws and never logs: a tool call that worked must keep working when the Hub is absent or slow.
     */
    async function unreadHint(sessionId, signal) {
      try {
        const { status, text: body } = await hubPost('/bridge/unread-hint', { 'content-type': 'application/json' },
          JSON.stringify({ harness: HARNESS, session: sessionId }), AbortSignal.any([signal, AbortSignal.timeout(hintTimeoutMs)]));
        if (!isOk(status)) return null;
        const reply = JSON.parse(body);
        return typeof reply?.hint === 'string' && reply.hint ? reply.hint : null;
      } catch {
        return null;
      }
    }

    /** The downstream decision with the hint as its first additional context; `next()` already ran once. */
    function withUnreadHint(decision, hint) {
      const context = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: hint }],
        source: { ...HINT_SOURCE },
      };
      const additionalContexts = [context, ...(decision.additionalContexts ?? [])];
      if (decision.kind === 'block') return { kind: 'block', feedback: decision.feedback, additionalContexts };
      return { ...decision, additionalContexts };
    }

    // The Hub request runs beside the downstream waterfall; the hint is only added when the downstream decision is
    // still available and the Hub answered one. Any failure returns next()'s decision exactly as it was.
    const offPost = typeof ctx.on === 'function' ? ctx.on('tools/post-execute', async (exec, _result, next) => {
      let pending = null;
      try {
        const sessionId = exec?.agent?.id;
        if (typeof sessionId === 'string' && sessionId) pending = unreadHint(sessionId, stop.signal);
      } catch { /* no request: the tool result is unaffected */ }
      const downstream = await next();
      if (!pending) return downstream;
      const hint = await pending;
      if (!hint) return downstream;
      try { return withUnreadHint(downstream, hint); } catch { return downstream; }
    }) : null;

    // ───────────── delivery: Hub stream → DSH sessions ─────────────

    /** To the Hub whose stream this belongs to: never to another Hub the registry may name by now. */
    async function post(hub, path, body, signal = stop.signal) {
      const { status } = await hubPost(path, { 'content-type': 'application/json' }, JSON.stringify(body), signal, hub);
      if (!isOk(status)) throw new Error(`HTTP ${status}`);
    }

    // Only the Hub's current target list is observed. Raw calls stay in memory and are never serialized.
    let observation = null;
    const safeTool = (name) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : null;
    const callKey = (prefix, id) => typeof id === 'string' && id.length > 0 && id.length <= 200 ? `${prefix}:${id}` : null;

    function reportActivity(link, sessionId) {
      const state = link.sessions.get(sessionId);
      if (!state || observation !== link || link.signal.aborted) return;
      void post(link.hub, '/bridge/activity', {
        observerId: link.observerId, sessionId, seq: state.seq, event: state.event,
      }, link.signal).catch(() => {});
    }

    function watchActivity(sessionId, event) {
      const link = observation;
      const state = link?.sessions.get(sessionId);
      if (!state) return;
      const d = event?.data;
      let next = null;
      if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
        const ptc = event.type === 'tool/ptc-dispatch-start';
        const key = callKey(ptc ? 'ptc' : 'tool', ptc ? d?.subCallId : d?.callId);
        const toolName = safeTool(d?.name);
        if (key) {
          state.calls.set(key, toolName);
          if (state.calls.size > 1000) state.calls.delete(state.calls.keys().next().value);
        }
        next = { kind: 'tool', phase: ptc ? 'started' : 'requested', toolName };
      } else if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
        const ptc = event.type === 'tool/ptc-dispatch';
        const id = ptc ? d?.subCallId : d?.message?.toolCallId ?? d?.message?.source?.callId;
        const key = callKey(ptc ? 'ptc' : 'tool', id);
        const isError = ptc ? d?.isError : d?.message?.isError;
        const toolName = key && state.calls.has(key) ? state.calls.get(key) : ptc ? safeTool(d?.name) : null;
        if (key) state.calls.delete(key);
        if (typeof isError === 'boolean') next = { kind: 'tool', phase: isError ? 'failed' : 'finished', toolName };
      } else if (event.type === 'turn/start') {
        next = { kind: 'turn', phase: 'started' };
      } else if (event.type === 'turn/end') {
        state.calls.clear();
        const kind = d?.reason?.kind;
        if (kind === 'completed') next = { kind: 'turn', phase: 'finished' };
        else if (kind === 'error' || kind === 'aborted') next = { kind: 'turn', phase: 'failed' };
      }
      if (!next) return;
      state.seq++;
      state.event = next;
      reportActivity(link, sessionId);
    }

    // ───────────── turn ends: DSH session events → POST /bridge/done ─────────────

    // Deliveries whose turn is being watched, by delivery id: { sessionId, seen (its user/message), ended, finish }.
    const turns = new Map();
    const finished = new Map();
    // Without session events (a DSH that does not offer them) nothing is watched and the ack promises no done.
    const offOn = typeof ctx.on === 'function' ? ctx.on('session/event', (session, event) => {
      const sessionId = session?.id;
      if (typeof sessionId === 'string') {
        try { watchActivity(sessionId, event); } catch { /* observation cannot affect DSH execution */ }
      }
      const type = event?.type;
      if (typeof sessionId !== 'string' || !WATCHED.has(type)) return;
      for (const [deliveryId, w] of [...turns]) {
        if (w.sessionId !== sessionId) continue;
        if (type === 'assistant/message' || type === 'assistant/attempt') {
          if (w.seen) addUsage(w.usage, event.data);
        } else if (type === 'user/message') {
          if (event.data?.source?.rpcId === deliveryId) w.seen = true;
        } else {
          const reason = event.data?.reason?.kind;
          if (w.seen && reason === 'completed') w.finish({ outcome: 'completed' });
          else if (w.seen && (reason === 'error' || reason === 'aborted')) {
            w.finish({ outcome: 'failed', error: reason === 'error' ? 'DeepSeek turn failed' : 'DeepSeek turn was interrupted' });
          } else if (w.seen || reason === 'aborted') {
            w.finish({ outcome: 'unknown', error: w.seen ? 'DeepSeek turn ended with an unknown reason' : 'DeepSeek stopped before this delivery was observed; its outcome is unknown' });
          }
        }
      }
    }) : null;

    const heartbeat = offOn ? setInterval(() => {
      const link = observation;
      if (link) for (const sessionId of link.sessions.keys()) reportActivity(link, sessionId);
    }, opts.activityHeartbeatMs ?? ACTIVITY_HEARTBEAT_MS) : null;
    heartbeat?.unref?.();

    /** Starts watching a delivery's turn (before the prompt, so its user/message cannot be missed). */
    function watch(sessionId, deliveryId) {
      let finish;
      const ended = new Promise((resolve) => { finish = resolve; });
      const w = {
        sessionId, seen: false, ended, usage: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0 },
        finish(result) {
          clearTimeout(timer);
          if (turns.get(deliveryId) !== w) return;
          turns.delete(deliveryId);
          finished.set(deliveryId, w);
          if (finished.size > KEEP_FINISHED) finished.delete(finished.keys().next().value);
          finish(result);
        },
        cancel() {
          clearTimeout(timer);
          if (turns.get(deliveryId) === w) turns.delete(deliveryId);
        },
      };
      const timer = setTimeout(() => w.finish({ outcome: 'unknown', error: 'DeepSeek turn observation timed out' }), turnWaitMs);
      turns.set(deliveryId, w);
      return w;
    }

    async function deliver(hub, data) {
      let e;
      try {
        e = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof e?.deliveryId !== 'string' || typeof e.sessionId !== 'string' || typeof e.text !== 'string') return;
      const id = e.deliveryId;
      // If a Hub sends the same id again, reuse the turn being watched or its cached result.
      let w = turns.get(id) ?? finished.get(id) ?? null;
      let error = null;
      if (!w) {
        if (offOn) w = watch(e.sessionId, id);
        try {
          // queue, never steer: the message waits for the current turn, as one the user typed would.
          // The model, permission preset and other session settings are left as they are.
          await ctx.sessionController.prompt(
            { requestId: id, sessionId: e.sessionId, mode: 'queue', content: [{ type: 'text', text: e.text }] },
            stop.signal,
          );
        } catch (err) {
          w?.cancel();
          w = null;
          if (stop.signal.aborted) return;
          error = errText(err);
        }
      }
      const receipt = error !== null ? { deliveryId: id, ok: false, error } : w ? { deliveryId: id, ok: true, follows: true } : { deliveryId: id, ok: true };
      try {
        await post(hub, '/bridge/ack', receipt);
      } catch (err) {
        if (!stop.signal.aborted) log.warn(`ack failed: ${errText(err)}`);
        return;
      }
      if (!w) return;
      // Sent after the ack, so the Hub is already waiting for it. A Hub that stopped waiting ignores it, and so does a
      // Hub that delivered this id into another session.
      const result = await w.ended;
      const { calls, ...usage } = w.usage;
      const done = { deliveryId: id, harness: HARNESS, sessionId: w.sessionId, ...result, ...(calls ? { usage } : {}) };
      if (!stop.signal.aborted) await post(hub, '/bridge/done', done).catch(() => {});
    }

    /** One stream connection: resolves when it ends. Deliveries for different sessions are handled side by side. */
    async function stream(signal) {
      const connection = new AbortController();
      const streamSignal = AbortSignal.any([signal, connection.signal]);
      try {
        signal.throwIfAborted();
        const { res, hub } = await hubStream(`/bridge/stream?harness=${HARNESS}${offOn ? '&activity=1' : ''}`,
          { signal: streamSignal, env, log: hubLog, agent: direct });
        if (!isOk(res.statusCode)) {
          res.resume();
          throw new Error(`stream refused (HTTP ${res.statusCode})`);
        }
        log.info(`connected to the orrery Hub「${hub.name}」`);
        res.setEncoding('utf8');
        let buf = '';
        for await (const chunk of res) {
          buf += chunk;
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            // Fields split on '\n' only (the Hub writes no '\r'): a text may hold U+2028 / U+2029.
            let event = '';
            const lines = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trimStart();
              else if (line.startsWith('data:')) lines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
            }
            // The Hub sends a session's next delivery only after this one's ack (and done), so order within a session holds.
            if (event === 'deliver' && lines.length) void deliver(hub, lines.join('\n'));
            else if (event === 'activity-targets' && lines.length) {
              let frame;
              try { frame = JSON.parse(lines.join('\n')); } catch { continue; }
              if (typeof frame?.observerId !== 'string' || !frame.observerId || frame.observerId.length > 200
                || !Array.isArray(frame.sessions) || frame.sessions.some((id) => typeof id !== 'string' || !id || id.length > 200)) continue;
              if (observation?.observerId === frame.observerId && observation.connection === connection) continue;
              observation = { hub, signal: streamSignal, connection, observerId: frame.observerId,
                sessions: new Map(frame.sessions.map((id) => [id, { seq: 0, event: null, calls: new Map() }])) };
              for (const sessionId of observation.sessions.keys()) reportActivity(observation, sessionId);
            }
          }
        }
      } finally {
        connection.abort();
        if (observation?.connection === connection) observation = null;
      }
    }

    /** Keeps a stream open until disposed, retrying every retryMs with a fresh look at the registry. */
    async function streamLoop(signal) {
      let reported = '';
      while (!signal.aborted) {
        try {
          await stream(signal);
          reported = '';
          if (!signal.aborted) log.info('orrery Hub stream ended, reconnecting');
        } catch (e) {
          if (signal.aborted) return;
          // Once per kind of trouble: another reason (a refusal after a restart, another Hub) is logged again.
          const why = e instanceof HubError ? e.message : `orrery Hub not reachable (${errText(e)})`;
          if (why !== reported) log.info(`${why}; retrying every ${retryMs} ms`);
          reported = why;
        }
        // Removes its abort listener when the time is up, so waiting while the Hub is down does not pile them up.
        await sleep(retryMs, undefined, { signal }).catch(() => {});
      }
    }

    // ───────────── start ─────────────

    const unregister = [];
    for (const tool of TOOLS) {
      try {
        unregister.push(ctx.tools.register(toolDefinition(tool)));
      } catch (e) {
        // e.g. another plugin already holds the name: delivery still works.
        log.warn(`could not register ${TOOL_PREFIX}${tool.name}: ${errText(e)}`);
      }
    }
    bridgeToolVersion = { source: 'dsh-source', scope: 'plugin', profile: 'standard', fingerprint: fingerprintTools(TOOLS),
      observedAt: new Date().toISOString(), registered: { succeeded: unregister.length, total: TOOLS.length } };
    void streamLoop(stop.signal);
    return () => {
      stop.abort();
      if (heartbeat) clearInterval(heartbeat);
      observation = null;
      offOn?.();
      offPost?.();
      for (const w of [...turns.values()]) w.finish();   // ends the waits; stop keeps them from sending anything
      direct.destroy();
      for (const dispose of unregister) dispose?.();   // Cordis also does this on unload; a second call is a no-op
    };
  }, 'dsh-orrery');
}
