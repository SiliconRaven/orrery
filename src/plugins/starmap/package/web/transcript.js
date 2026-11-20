// The star map's chat windows, their pure part (docs/starmap.md「聊天窗口」): no DOM, no network, so it runs in node.
// A member window reads the member's native conversation from the star map transcript route page by page; this file
// holds the paging state (cursors, `reset`, merging pages), the grouping of transcript items into what the window
// draws, and the small helpers the Hub chat window needs. windows.js does the drawing and the requests.

/** Items per transcript page (the route allows 1–200). */
export const TRANSCRIPT_LIMIT = 50;
/** Messages per Hub chat page. */
export const HUB_PAGE = 50;
/** `reset` answers in a row before the window stops reloading and shows the reason instead. */
export const MAX_RESETS = 2;
/** Follow-up pages one trigger may chain (an `after` read with `hasMore`, or an empty `before` page with a cursor). */
export const MAX_CHAIN = 8;

const enc = encodeURIComponent;

/** The transcript route for one read: `request` is { direction?, cursor?, limit? }; no cursor reads the latest page. */
export function transcriptPath(clusterId, memberId, request = {}) {
  const query = new URLSearchParams();
  if (request.direction) query.set('direction', request.direction);
  query.set('limit', String(request.limit ?? TRANSCRIPT_LIMIT));
  if (request.cursor) query.set('cursor', request.cursor);
  return `/api/clusters/${enc(clusterId)}/members/${enc(memberId)}/transcript?${query}`;
}

/** The Hub chat route: the newest page, or the page before message `before`. */
export const messagesPath = (clusterId, before = null) =>
  `/api/clusters/${enc(clusterId)}/messages?limit=${HUB_PAGE}${before ? `&before=${enc(before)}` : ''}`;

/** The user's private DM history route for a member in a cluster. */
export const privateMessagesPath = (clusterId, memberId, before = null) =>
  `/api/clusters/${enc(clusterId)}/messages?privateWith=${enc(memberId)}&limit=${HUB_PAGE}${before ? `&before=${enc(before)}` : ''}`;

/**
 * Two runs of transcript items in file order, `older` first, as one run. A later record with the same id replaces the
 * earlier one and takes its place, as the Hub's reader does within one page; items without an id are kept as they are.
 */
export function mergeItems(older, newer) {
  const all = [...older, ...newer];
  const last = new Map();
  all.forEach((item, index) => { if (typeof item?.id === 'string') last.set(item.id, index); });
  return all.filter((item, index) => item && (typeof item.id !== 'string' || last.get(item.id) === index));
}

// ---- the transcript paging state ----
// One read at a time for each window: `want` is what the window asks for: 'latest' (no cursor: the newest page), 'before'
// (older, with the `before` cursor) or 'after' (newer, with the `after` cursor). State is replaced, never mutated.

/**
 * A window that has read nothing yet. `status` is 'loading' until the first answer, then the page's status; the window
 * sets 'ended' itself when the member's binding ended (bindingChange).
 */
export function transcriptState() {
  return { status: 'loading', items: [], before: null, after: null, unknownCount: 0, resets: 0 };
}

/** Whether there is an older page to read. */
export const hasOlder = (state) => state.status === 'ok' && Boolean(state.before);

/** The request for `want` in this state, or null when there is nothing to ask (no older page; no cursor yet). */
export function requestFor(state, want) {
  if (want === 'latest') return {};
  if (state.status !== 'ok') return null;
  if (want === 'before') return state.before ? { direction: 'before', cursor: state.before } : null;
  if (want === 'after') return state.after ? { direction: 'after', cursor: state.after } : null;
  return null;
}

/** What to read when the event stream shows the member at work: newer records, or the whole page again after a failure. */
export function wantOnActivity(state) {
  if (state.status === 'ok') return 'after';
  // Nothing new can make these readable (an ended binding comes back only with a rebind); the refresh button still reloads.
  if (['unsupported', 'archived', 'loading', 'ended'].includes(state.status)) return null;
  return 'latest';
}

const STATUSES = new Set(['ok', 'reset', 'missing', 'unsupported', 'archived', 'refused']);

/**
 * The state after answer `page` to a read for `want`, and `then`: the read to chain right away, or null.
 * - `reset`: the cursors are dropped and the latest page is read again; after MAX_RESETS in a row, the window stops
 *   and shows the reason (`status: 'reset'`).
 * - `missing`, `unsupported`, `archived`, `refused` (and a malformed answer, as `refused`): the items go and the reason shows.
 * - `ok`: 'latest' replaces the items; 'before' puts the page in front (an empty page with a cursor goes on: the
 *   reader may have scanned a stretch with no complete record); 'after' appends and goes on while `hasMore`.
 */
export function applyPage(state, want, page) {
  const status = page && typeof page === 'object' && Array.isArray(page.items) && STATUSES.has(page.status) ? page.status : 'refused';
  if (status === 'reset') {
    const resets = state.resets + 1;
    return resets > MAX_RESETS
      ? { state: { ...transcriptState(), status: 'reset', resets }, then: null }
      : { state: { ...transcriptState(), resets }, then: 'latest' };
  }
  if (status !== 'ok') return { state: { ...transcriptState(), status }, then: null };
  const items = page.items.filter((item) => item && typeof item === 'object');
  const unknown = Number.isSafeInteger(page.unknownCount) && page.unknownCount > 0 ? page.unknownCount : 0;
  const cursor = (value) => (typeof value === 'string' && value ? value : null);
  if (want === 'latest' || state.status !== 'ok') {
    return { state: { status: 'ok', items: mergeItems([], items), before: cursor(page.before), after: cursor(page.after), unknownCount: unknown, resets: 0 }, then: null };
  }
  if (want === 'before') {
    const before = cursor(page.before);
    return {
      state: { ...state, items: mergeItems(items, state.items), before, unknownCount: state.unknownCount + unknown, resets: 0 },
      then: !items.length && before && page.hasMore ? 'before' : null,
    };
  }
  return {
    state: { ...state, items: mergeItems(state.items, items), after: cursor(page.after) ?? state.after, unknownCount: state.unknownCount + unknown, resets: 0 },
    then: page.hasMore ? 'after' : null,
  };
}

/** The next read among those waiting: a reload first (it makes the others moot), then newer records, then older ones. */
export function nextWant(pending) {
  for (const want of ['latest', 'after', 'before']) if (pending.has(want)) return want;
  return null;
}

// ---- what the member window draws ----

/**
 * Transcript items as the window's entries, in order:
 * - `user`, `assistant`, `system`: { type, key, item };
 * - `thinking`: { type, key, text } with only the summary the app gave (null: a placeholder is shown);
 * - `tool`: { type, key, call, result } — a call with its result (paired by `callId`), or a result whose call is not loaded;
 * - `delivery` (orrery_delivery) and `post` (orrery_post, with the send call it answers): one compact card each;
 * - `unknown` items are left out (the page's `unknownCount` says how many).
 */
export function transcriptEntries(items) {
  const calls = new Map(), results = new Map(), posts = new Set();
  for (const item of items) {
    if (!item.callId) continue;
    if (item.kind === 'tool_call') calls.set(item.callId, item);
    else if (item.kind === 'tool_result') results.set(item.callId, item);
    else if (item.kind === 'orrery_post') posts.add(item.callId);
  }
  const entries = [];
  for (const item of items) {
    const key = String(item.id ?? entries.length);
    switch (item.kind) {
      case 'user': case 'assistant': case 'system':
        entries.push({ type: item.kind, key, item });
        break;
      case 'thinking':
        entries.push({ type: 'thinking', key, text: typeof item.text === 'string' && item.text.trim() ? item.text.trim() : null });
        break;
      case 'tool_call':
        if (item.callId && posts.has(item.callId)) break;   // shown inside its post card
        entries.push({ type: 'tool', key, call: item, result: (item.callId && results.get(item.callId)) || null });
        break;
      case 'tool_result':
        if (item.callId && calls.has(item.callId)) break;   // shown inside its call
        entries.push({ type: 'tool', key, call: null, result: item });
        break;
      case 'orrery_delivery':
        entries.push({ type: 'delivery', key, item });
        break;
      case 'orrery_post':
        entries.push({ type: 'post', key, item, call: (item.callId && calls.get(item.callId)) || null });
        break;
      default: break;   // unknown
    }
  }
  return entries;
}

/** Whether a transcript delivery entry consists exclusively of private Orrery DMs (rendered as expanded DM bubbles). */
export const isPrivateDeliveryEntry = (entry) => entry?.type === 'delivery'
  && Array.isArray(entry.item?.parts) && entry.item.parts.length > 0
  && entry.item.parts.every((part) => part?.private === true);

/** Whether an entry is one of the compact orrery cards the header button opens and closes together. */
export const isCard = (entry) => (entry.type === 'delivery' && !isPrivateDeliveryEntry(entry)) || entry.type === 'post';

/** Whether every card is open (false when there are none): the header button then offers to close them all. */
export function allCardsOpen(entries, open) {
  const cards = entries.filter(isCard);
  return cards.length > 0 && cards.every((entry) => open.has(entry.key));
}

/** The open cards after the header button: all of them, or none when all were open. */
export function toggleAllCards(entries, open) {
  return allCardsOpen(entries, open) ? new Set() : new Set(entries.filter(isCard).map((entry) => entry.key));
}

/** A text on one line, at most `n` characters (with an ellipsis). */
export function oneLine(text, n = 80) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n)}…` : line;
}

/**
 * A delivery card's caption: { from, text, more } — the first part's sender id and body on one line, and how many
 * further parts the envelope carried. A delivery with no Hub parts (the batch is gone) shows the item's own text.
 */
export function deliveryCaption(item) {
  const parts = Array.isArray(item.parts) ? item.parts : [];
  if (!parts.length) return { from: null, text: oneLine(item.text ?? ''), more: 0 };
  return { from: parts[0].from, text: oneLine(parts[0].body), more: parts.length - 1 };
}

// ---- the Hub chat window ----

/** `list` (oldest first) with `incoming` merged in by id: a known message is replaced in place, a new one goes last. */
export function mergeMessages(list, incoming) {
  const at = new Map(list.map((message, index) => [message.id, index]));
  const out = [...list];
  for (const message of incoming) {
    if (!message || typeof message.id !== 'string') continue;
    if (at.has(message.id)) out[at.get(message.id)] = message;
    else { at.set(message.id, out.length); out.push(message); }
  }
  return out;
}

/** An older page (oldest first) in front of `list`, without repeating what is already there. */
export function prependMessages(list, older) {
  const known = new Set(list.map((message) => message.id));
  return [...older.filter((message) => message && typeof message.id === 'string' && !known.has(message.id)), ...list];
}

/** The message a stream event brings to cluster `clusterId`'s chat (with its attachments, which the event carries apart), or null. */
export function eventMessage(event, clusterId) {
  const message = event?.kind === 'message' ? event.payload?.message : null;
  if (!message || message.privateTo || message.clusterId !== clusterId || typeof message.id !== 'string') return null;
  const attachments = event.payload.attachments;
  return Array.isArray(attachments) && attachments.length ? { ...message, attachments } : message;
}

/**
 * Whether a stream event shows member `memberId` at work (its native conversation may have grown): its own agent,
 * guard or unread events, a delivery to it, a message it sent, or a change to the member itself (a new binding).
 */
export function isMemberActivity(event, memberId) {
  if (!event || typeof event !== 'object') return false;
  if (event.memberId === memberId) return true;
  const p = event.payload ?? {};
  if (event.kind === 'message') return p.message?.from === memberId || (p.deliveries ?? []).some((d) => d?.memberId === memberId);
  if (event.kind === 'delivery') return p.delivery?.memberId === memberId;
  if (event.kind === 'member') return p.member?.id === memberId;
  return false;
}

/**
 * How a stream event changes member `memberId`'s binding in cluster `clusterId`, apart from ordinary activity:
 * 'rebind' (the member moved to another native conversation: what the window shows is the old one's), 'ended' (the
 * member left the cluster, or the cluster moved to the recycle bin: there is no conversation to show), or null.
 */
export function bindingChange(event, clusterId, memberId) {
  const p = event?.payload ?? {};
  if (event?.kind === 'member' && p.member?.id === memberId) {
    if (p.member.removedAt) return 'ended';
    if (p.rebind) return 'rebind';
  }
  if (event?.kind === 'cluster' && p.cluster?.id === clusterId && p.cluster.deletedAt) return 'ended';
  return null;
}

/** Whether a failed read says the member is no longer in the cluster (removed, or the cluster is in the recycle bin). */
export const isGoneError = (error) => error?.status === 400 && error?.data?.error === 'unknown member in cluster';

/** The id to mark read up to (the newest message), or null when it is already the read position or was just sent. */
export function readTarget(messages, readId, lastSent) {
  const latest = messages.at(-1)?.id ?? null;
  return latest && latest !== readId && latest !== lastSent ? latest : null;
}

// ---- member private DM helpers ----

/** Extracts a private DM for `memberId` in `clusterId` from a stream `message` event (with its deliveries), or null. */
export function eventPrivateMessage(event, clusterId, memberId) {
  const message = event?.kind === 'message' ? event.payload?.message : null;
  if (!message || message.clusterId !== clusterId || message.privateTo !== memberId || typeof message.id !== 'string') return null;
  const deliveries = Array.isArray(event.payload?.deliveries) ? event.payload.deliveries : [];
  return { ...message, deliveries };
}

/** Updates one delivery inside a private DM list when a `delivery` stream event arrives; returns the list unchanged if none matched. */
export function applyPrivateDeliveryEvent(list, event) {
  const delivery = event?.kind === 'delivery' ? event.payload?.delivery : null;
  if (!delivery || typeof delivery.messageId !== 'string') return list;
  const idx = list.findIndex((m) => m.id === delivery.messageId);
  if (idx < 0) return list;
  const msg = list[idx];
  const prev = Array.isArray(msg.deliveries) ? msg.deliveries : [];
  const nextDeliveries = prev.some((d) => d.id === delivery.id)
    ? prev.map((d) => (d.id === delivery.id ? delivery : d))
    : [...prev, delivery];
  const out = [...list];
  out[idx] = { ...msg, deliveries: nextDeliveries };
  return out;
}

/** Message IDs of private DMs already attributed inside the loaded native transcript entries (used to deduplicate the DM status strip). */
export function transcriptPrivateIds(entries) {
  const ids = new Set();
  for (const entry of entries ?? []) {
    if (entry?.type !== 'delivery' || !Array.isArray(entry.item?.parts)) continue;
    for (const part of entry.item.parts) {
      if (part?.private === true && typeof part.messageId === 'string') ids.add(part.messageId);
    }
  }
  return ids;
}

/** Computes a private DM's display state and whether same-binding resend is allowed. */
export function dmStatusOf(message, memberBindingGen) {
  const delivery = Array.isArray(message?.deliveries) ? message.deliveries[message.deliveries.length - 1] ?? null : null;
  const stale = Number.isInteger(memberBindingGen) && Number.isInteger(message?.privateBindingGen)
    && message.privateBindingGen !== memberBindingGen;
  const status = delivery?.state ?? delivery?.status ?? 'unknown';
  const outcome = delivery?.outcome ?? null;
  const unresolved = status !== 'superseded'
    && (status === 'failed' || status === 'offline' || status === 'blocked' || outcome === 'unknown');
  const canResend = !stale && Boolean(delivery?.id) && unresolved;
  return { status, outcome, delivery, stale, canResend };
}
