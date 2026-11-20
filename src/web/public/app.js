import { t, language, languageInAddress, onLanguageChange, setLanguage, translateStatic } from './i18n.js';
// orrery web UI: cluster list, group chat, member page. Live state comes from the Hub's SSE event log.
// See docs/architecture.md and docs/native-mode.md (HTTP API, event kinds, @ rules).
import {
  unwrittenRecipients,
  handoverText,
  toolVersionView,
  usageAlertText,
  attachmentNode, fileLabel, fileUrl, pendingFileNode, rebindWarnings, activeMember, activeMembers, activitySummary, attachMentions, attachTaskRefs, hubRestartAction, longWaitingHint, reloadWouldLose, clusterUsageText, memberTokensText, memberDetails, memberDetailsView, projectName, usageView, attachSkills, autogrowHeight, avatarEl, bodySegments, canHandoff, deliveryAdvice, timelineStageView, resendBlockedText, categoryInput, clampPane, clusterNameInput, clusterOrder, clusterUnread, sidebarSections, unreadLabel, clusterGroups, moveGroup, moveTargets, refreshRelativeTimes, relativeTimeEl, COLLAPSED_GROUPS_KEY, collapsedFromStored, collapsedSignature, confirmDialog, conversationActivity, conversations, deliveryProblem, deliveryView, editFields, effortChoices, expandedFromStored, fmtTime, h, handoffNeedsConfirmation, appRowSummary, createRequest, focusAfterTick, memberNameProblem, rowAfterKey, isSystemMessage, plainTextRecord, chatRowState, chatShowsMessage, jumpCurrent, jumpExceptionId, jumpPending, nextJump, CHAT_FILTER_DEFAULT, CHAT_FILTER_KEY, chatFilterCount, chatFilterFromStored, systemMark, limitFormEdited, limitSubmission, limitView, memberDefaultName, memberHealth, memberStatus, memberStatusLabel, memberSummary, HIDDEN_MARK, memberCounts, heldTasks, heldTasksPath, allPages, hiddenConfirmText, hiddenMentionHint, mergeMemberAt, messageAuthorName, noticeBoard, noticeDialog, notifyFormEdited, notifySubmission, notifyView, offlineHint, PANEL_OPEN_KEY, paneFromStored, paneKey, PANES, pastedFiles, pickFiles, presetName, receiptMembers, recordOnlyNotice, sessionAvailability, snippet, splitReceiptMembers, stackedMembers, submitOnEnter, systemAvatar, UNGROUPED, userAvatar, withLastMessage,
} from './ui.js';
import { attachMenu } from './ui.js';
import { SYSTEM_CATEGORIES, SYSTEM_CATEGORY_LABELS } from './system-kinds.js';
import { dismissAllRequest, problemsDescription } from './ui.js';
import { inlineText, markdownBlocks } from './markdown.js';
import { createWorkbench } from './workbench.js';
import { createUsageRenderer } from './usage-view.js';
import { createStalledWatch, stalledBadge, stalledSummary } from './stalled.js';
import { createPluginSettings } from './plugins.js';
import { createPluginConfig } from './plugin-config.js';
import { initSettings } from './settings.js';
import { mountPluginInstall } from './plugin-install.js';
import { mountUpdates } from './updates.js';
import { detachPluginSlots, loadPluginSlots, staleOfficialPackages, trustedChange, trustNoticeText } from './plugin-slots.js';
import { createViewHost } from './plugin-view.js';
import { formDialog } from './workbench-form.js';
import { createPluginUi, themeSnapshot } from './plugin-ui.js';
import { isTaskChangeNotice, parseLegacyTaskNotice, shipFailureNotice } from './task-diff.js';
import { createTaskCandidates, createTaskRefs, inRanges, quotedRanges, taskRefIds } from './task-refs.js';
import { conversationMatrix, CONVERSATIONS_VIEW_KEY, harnessApp, mountKeepingScroll, STATUS_WORD, viewFromStored } from './conversation-matrix.js';
import { avatarKind, emptyState, hiddenMark, icon, liveAsk, lt, memberAppText, memberMarks, memberPresence, memberRowActions, removeMemberConfirm, setAvatarMarks } from './ui.js';   // the member list's icons (kept apart from the long import above)
import { createShipFailureView, createTaskDiffView } from './task-diff-view.js';
import { openTrash } from './trash.js';
import { openExtensions } from './extensions.js';
import { createChatSearch, criteriaFromFilter, hiddenWarnings, senderChoices, warningBadge, FIXED_SENDERS } from './chat-search.js';
import { attachCommands, chatSubmitAllowed, commandForm, createCommandState, drawNotices, drawRuns, mountCommandForm, unmountCommandForm } from './plugin-commands.js';

const $ = (id) => document.getElementById(id);
translateStatic(document);
// The desktop shell switches this page's language with this event (desktop/ui/language.mjs pageLanguageScript); the
// page accepts zh or en only, and only where its address carries the language (the desktop's collaboration page).
addEventListener('orrery:desktop-language', (event) => {
  if (languageInAddress() && (event.detail === 'zh' || event.detail === 'en')) setLanguage(event.detail);
});
let pluginSlots = { message: [] };

// ---- state ----

const hiding = new Set();   // member ids whose hide/show request is in flight (toggleHidden)
const S = {
  harnesses: [],
  modes: [],                 // GET /api/harness-modes: [{ harness, native, nativeCreate }]
  paused: false,
  settings: null,            // GET /api/settings as the Hub has it: { maxHops, source, maxTurnsPerChain, maxTurnsPerChainSource }
  clusters: new Map(),       // id -> Cluster
  members: new Map(),        // id -> Member
  messages: new Map(),       // id -> Message & { deliveries: Map<memberId, Delivery>, reads: [{ memberId, via }] }; loaded windows only
  handoffs: new Set(),       // message ids created as handoffs or resends; their quoted @ text is not a routing instruction
  clusterMsgs: new Map(),    // clusterId -> the loaded window of its message ids, oldest first (see chatWindows)
  memberLogs: new Map(),     // memberId -> { events, older, loading, pending, prepended, error }: its page's lines, once opened
  rebinds: new Map(),        // memberId -> its moves to another conversation, oldest first ('member' events with `rebind`)
  running: new Map(),        // memberId -> Set<deliveryId> currently running (from /api/state, then delivery events)
  identity: 0,               // bumped when a name or avatar changes, so rendered messages refresh
  skills: [],                // GET /api/skills: [{ name, description }], read when the page loads and after an install (loadSkills)
  skillNames: new Set(),
  avatars: [],               // GET /api/avatars: preset avatar names, read once when the page loads
  skillsVersion: 0,          // bumped when the skills list arrives, so rendered messages highlight $name
  lastSeq: 0,
  sel: { cluster: null, member: null, overview: false },
  usage: null,               // GET /api/usage?cluster=<selected> (docs/usage.md), or null until loaded
  turnUsage: null,
  turnUsageError: false,
  activity: new Map(),       // latest snapshot by membership ID, never by shared physical session
  toolVersions: null,
  activityFailed: false,
  coordinators: new Map(),   // clusterId -> its enabled coordinator's member id (/api/state, then coordinator.set events)
};
// Rendering a message only reads this shared cache; it never requests tasks (see task-refs.js).
const taskRefs = createTaskRefs({
  load: async (clusterId, refs) => {
    if (workbench.tasksEnabled?.() === false) return [];
    const ids = refs.filter((r) => r.includes('-'));
    const numbers = refs.filter((r) => /^[1-9][0-9]{0,14}$/.test(r));
    const params = new URLSearchParams();
    if (ids.length) params.set('ids', ids.join(','));
    if (numbers.length) params.set('numbers', numbers.join(','));
    return params.toString() ? (await api('GET', `/api/clusters/${encodeURIComponent(clusterId)}/task-refs?${params}`)).tasks : [];
  },
  onChange: () => render(),
});
const taskCandidates = createTaskCandidates({
  load: async (clusterId, query) => (workbench.tasksEnabled?.() === false ? [] : (await api('GET', `/api/clusters/${encodeURIComponent(clusterId)}/task-refs?includeClosed=1&q=${encodeURIComponent(query)}`)).tasks),
  onChange: () => taskKeys.refresh(),
});
let activityReady = false;
let clusterSnapshotSeq = -1;
let clusterSnapshotIds = new Set();
const clusterVersions = new Map();
const messageMetadata = new Map();   // message id -> pending collaboration metadata refresh
let metadataFetching = 0;

function queueMessageMetadata(clusterId, id) {
  if (!clusterId || !id) return;
  const entry = messageMetadata.get(id) ?? { clusterId, version: 0, inFlight: false, failed: false, retryAfterFlight: false, reportedFailure: false };
  entry.version++;
  entry.failed = false;
  messageMetadata.set(id, entry);
  pumpMessageMetadata();
}

function retryMessageMetadata(clusterId) {
  if (!clusterId) return;
  for (const item of messageMetadata.values()) if (item.clusterId === clusterId) {
    if (item.inFlight) item.retryAfterFlight = true;
    else item.failed = false;
  }
  pumpMessageMetadata();
}

function pumpMessageMetadata() {
  while (metadataFetching < 4) {
    const entry = [...messageMetadata.entries()].find(([, item]) => item.clusterId === S.sel.cluster && !item.inFlight && !item.failed);
    if (!entry) return;
    const [id, item] = entry;
    item.inFlight = true;
    const version = item.version;
    let applied = false;
    metadataFetching++;
    api('GET', `/api/clusters/${encodeURIComponent(item.clusterId)}/messages/${encodeURIComponent(id)}`, undefined, true).then(({ data, seq }) => {
      if (messageMetadata.get(id) !== item || item.version !== version) return;
      const msg = S.messages.get(id);
      // A copy read later than this one (a window read meanwhile) is kept: it already holds the change asked for.
      if (msg) setFields(msg, data, seq + 0.5);
      applied = true;   // no longer loaded: the next load of its window reads the new fields
    }).catch(() => { /* keep the entry for the next reconnect or explicit selection */ }).finally(() => {
      metadataFetching--;
      if (messageMetadata.get(id) === item && item.version === version && applied) messageMetadata.delete(id);
      else if (messageMetadata.get(id) === item) {
        item.inFlight = false;
        if (item.version === version && !applied) item.reportedFailure = true;
        item.failed = item.version === version && !item.retryAfterFlight;
        item.retryAfterFlight = false;
      }
      render();
      pumpMessageMetadata();
    });
  }
}

// ---- remembered UI choices (localStorage; unreadable storage just means the default) ----

/** Whether the right-hand member panel is open on its list; closed by default and remembered across page loads. */
let panelOpen = readPanelOpen();
function readPanelOpen() {
  try { return expandedFromStored(localStorage.getItem(PANEL_OPEN_KEY)); } catch { return false; }
}
function writePanelOpen(open) {
  try { localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0'); } catch { /* blocked or full: just forget the choice */ }
}

/** Sidebar groups the user collapsed (names; '' = ungrouped). */
let collapsedGroups = readCollapsedGroups();
function readCollapsedGroups() {
  try { return collapsedFromStored(localStorage.getItem(COLLAPSED_GROUPS_KEY)); } catch { return new Set(); }
}
function writeCollapsedGroups() {
  try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups])); } catch { /* forget the choice */ }
}

/** A pane's remembered width (ui.js PANES); unreadable storage means the default. */
function readPane(pane) {
  try { return paneFromStored(pane, localStorage.getItem(PANES[pane].key)); } catch { return PANES[pane].def; }
}
function writePane(pane, width) {
  try { localStorage.setItem(PANES[pane].key, String(width)); } catch { /* forget the choice */ }
}

const membersOf = (clusterId) => activeMembers([...S.members.values()], clusterId);
const nameOf = (id) => messageAuthorName({ from: id }, S.members);
const messageName = (message) => messageAuthorName(message, S.members);
const usageRenderer = createUsageRenderer({ element: $, nameOf, showMessage: (cid, id) => void openMessage(cid, id) });

// Each cluster's default-avatar marks (ui.js memberMarks), recomputed after any member is added, renamed or removed
// (S.identity), so two members of one app never show the same letter and colour.
const markCache = new Map();
setAvatarMarks((m) => {
  let entry = markCache.get(m.clusterId);
  if (entry?.identity !== S.identity) markCache.set(m.clusterId, entry = { identity: S.identity, marks: memberMarks(membersOf(m.clusterId)) });
  return entry.marks.get(m.id) ?? null;
});

/**
 * A local running delivery and a native sibling's shared Hub channel both count as busy. The payload status comes
 * from the newer of the /api/state snapshot and member events after it; see mergeMemberAt.
 */
function statusOf(m) {
  return memberStatus(m, S.harnesses.includes(m.harness), Boolean(S.running.get(m.id)?.size));
}
/** The orbit and dot avatarEl draws for a member's status (ui.js memberPresence). */
const presenceOf = (m) => memberPresence(m, statusOf(m));

/** A streamed line for a member page that has been opened; a page not opened yet reads its newest lines when it opens. */
function pushMemberEvent(memberId, e) {
  const log = S.memberLogs.get(memberId);
  if (log) (log.pending ?? log.events).push(e);
}

/** `at`: where the status comes from (see mergeMemberAt); omitted for an API reply. */
function upsertMember(m, at) {
  const old = S.members.get(m.id);
  m = mergeMemberAt(old, m, at);
  if (!old || old.name !== m.name || old.avatar !== m.avatar || old.removedAt !== m.removedAt || (old.hiddenAt ?? null) !== (m.hiddenAt ?? null)) S.identity++;
  S.members.set(m.id, m);
  if (m.removedAt) S.activity.delete(m.id);
}

/**
 * A cluster from the REST snapshot (lastMessageAt included) or from a 'cluster' event (creation time only). An
 * older event never moves the activity time back: after a Hub restart the snapshot may already know newer messages.
 */
function upsertCluster(c, at) {
  if (at !== undefined && at < (clusterVersions.get(c.id) ?? -1)) return;
  if (at !== undefined) clusterVersions.set(c.id, at);
  if (c.deletedAt) { S.clusters.delete(c.id); return; }
  const known = S.clusters.get(c.id);
  const last = c.lastMessageAt ?? c.createdAt;
  const kept = known?.lastMessageAt && Date.parse(known.lastMessageAt) > Date.parse(last) ? known.lastMessageAt : last;
  S.clusters.set(c.id, { ...c, lastMessageAt: kept });
}

/**
 * Every write of a message's state on this page is ordered by event seq, its position `at`: an event's own seq, or
 * S + 0.5 for an answer the Hub read at event seq S (X-Orrery-Seq: it holds every event up to S and none after) — the
 * window reads, the single-message read of the metadata refresh, and the handoff and resend answers alike. Deliveries
 * (per member) and the task links / plugin fields (per message) keep the position they were set at and take only a
 * later one; within the window, reads, acknowledgements and handoff markers are additive; the rest of
 * a message never changes. There is no write without a position.
 */

/**
 * A delivery's state at position `at`, unless a later one is shown. Only the stream (`live`) moves S.running: an
 * answer may predate an event already applied, and /api/state seeds it.
 */
function setDelivery(d, live, at) {
  if (typeof at !== 'number') throw new Error('a delivery state needs its event position');
  const msg = S.messages.get(d.messageId);
  if (msg && !(msg.deliveryAt.get(d.memberId) >= at)) {
    msg.deliveries.set(d.memberId, d);
    msg.deliveryAt.set(d.memberId, at);
    msg.rev++;   // the one place deliveries change: renderChat rebuilds the message when this moves
  }
  if (d.handoffMessageId && (msg || S.messages.has(d.handoffMessageId))) S.handoffs.add(d.handoffMessageId);
  if (!live) return;
  if (!S.running.has(d.memberId)) S.running.set(d.memberId, new Set());
  if (d.state === 'running') S.running.get(d.memberId).add(d.id);
  else S.running.get(d.memberId).delete(d.id);
}

/** A message's task links and plugin fields (bookmarks) from a REST copy at position `at`, unless a later copy is shown. */
function setFields(msg, data, at) {
  if (msg.fieldsAt >= at) return;
  msg.fieldsAt = at;
  msg.taskIds = data.taskIds ?? [];
  for (const slot of pluginSlots.message) slot.update?.(msg, data);
}

/**
 * Keeps a message from a REST answer (`rest`: with deliveries, reads, acknowledgements and fields) or a 'message'
 * event, merged into what the page already holds of it at position `at`: the same message may come both ways. The
 * object is never replaced, so the positions it carries stay with it until it is dropped from its window.
 */
function addMessage(m, { deliveries = m.deliveries ?? [], reads = m.reads ?? [], acknowledgements = m.acknowledgements ?? [], attachments = m.attachments ?? [], at, rest = false } = {}) {
  if (typeof at !== 'number') throw new Error('a message needs its event position');
  let msg = S.messages.get(m.id);
  if (!msg) {
    msg = { ...m, deliveries: new Map(), deliveryAt: new Map(), fieldsAt: at, rev: 0, reads: [], acknowledgements: [], attachments };
    S.messages.set(m.id, msg);
  } else if (rest) setFields(msg, m, at);
  // A handoff or resend quotes the original: its @ text is not who it went to (also known from the source delivery).
  if (m.kind === 'handoff' || m.kind === 'resend') S.handoffs.add(m.id);
  for (const d of deliveries) setDelivery(d, false, at);
  for (const r of reads) addRead(msg, r);
  for (const a of acknowledgements) addAcknowledgement(msg, a);
  return msg;
}
/** A member's read receipt, once per member (a 'read' event and a REST answer can both carry it). */
function addRead(msg, read) {
  if (!msg.reads.some((r) => r.memberId === read.memberId)) msg.reads.push({ memberId: read.memberId, via: read.via });
}

/** A member's acknowledgement, once per member. */
function addAcknowledgement(msg, a) {
  if (!msg.acknowledgements.some((old) => old.memberId === a.memberId)) msg.acknowledgements.push(a);
}

/**
 * The messages of a REST answer read at event seq `seq`, merged in; then the streamed events after `seq` that touch
 * them are applied again from recentEvents, in seq order: they may have arrived while the request ran, when the message
 * was not loaded yet (or before the answer's older copy). Reads and acknowledgements count once per member, deliveries
 * are ordered by seq, so applying an event twice changes nothing. Returns the ids, in the answer's order.
 */
function fillMessages(list, seq) {
  const ids = list.map((m) => addMessage(m, { at: seq + 0.5, rest: true }).id);
  const filled = new Set(ids);
  for (const e of recentEvents) {
    if (e.seq <= seq) continue;
    const p = e.payload;
    if (e.kind === 'message' && filled.has(p.message.id)) for (const d of p.deliveries) setDelivery(d, false, e.seq);
    else if (e.kind === 'delivery' && filled.has(p.delivery.messageId)) setDelivery(p.delivery, false, e.seq);
    else if (e.kind === 'read') for (const id of p.messageIds) { if (filled.has(id)) addRead(S.messages.get(id), p); }
    else if (e.kind === 'acknowledgement') for (const a of p.acknowledgements ?? []) { if (filled.has(a.messageId)) addAcknowledgement(S.messages.get(a.messageId), a); }
    else if (e.kind === 'collaboration') for (const id of messageIdsOf(p)) { if (filled.has(id)) queueMessageMetadata(e.clusterId, id); }
  }
  return ids;
}

/** The messages a collaboration event changes the task links or bookmarks of. */
const messageIdsOf = (p) => [...(p.messageId ? [p.messageId] : []), ...(Array.isArray(p.messageIds) ? p.messageIds : [])];

// ---- what the page holds of a cluster's messages: one contiguous window (docs/architecture.md「网页的数据流」) ----
// On load the page reads /api/state, then the newest PAGE messages of the cluster it shows, and streams events after
// the state's seq; another cluster's messages are read when it is opened, older ones when the chat is scrolled to the top.

const PAGE = 200;
const CHAT_WINDOW_LIMIT = 3 * PAGE;
/**
 * Only the selected cluster keeps a contiguous window. `older` and `live` describe which ends more can be read from.
 * `pending` keeps one page of streamed messages at their event positions while a request may reach the newest one.
 * `pendingGapAt` records the last event evicted from that page. `token` invalidates answers of replaced requests.
 */
const chatWindows = new Map();
/** The chat's one jump (openMessage), or null: its state and every way it ends are in ui.js nextJump. */
let jump = null;

/** A message event: appended to its cluster's window only where that window shows the newest messages. */
function messageArrived(m, seq, add) {
  const w = chatWindows.get(m.clusterId);
  if (!w) return;   // not opened: nothing to keep, it is read when the cluster is opened
  const ids = S.clusterMsgs.get(m.clusterId);
  if (ids?.includes(m.id)) { add(); return; }   // a snapshot may already include this event
  if (w.pending) {
    add();
    if (w.pending.length === PAGE) {
      const evicted = w.pending.shift();
      w.pendingGapAt = evicted.seq;
      dropMessages([evicted.id]);
    }
    w.pending.push({ id: m.id, seq });
    return;
  }
  if (!w.live) { w.newer = true; return; }   // an older window: never put the new message into the middle of history
  if (ids.length === CHAT_WINDOW_LIMIT) {
    const box = $('messages');
    // Keep the page the reader is looking at, and keep an older request's cursor in the window while it runs.
    if (w.loading === 'older' || jumpPending(jump, m.clusterId)
      || (box.dataset?.cluster === m.clusterId && box.scrollHeight - box.scrollTop - box.clientHeight >= 60)) {
      w.live = false;
      w.newer = true;
      return;
    }
    // Trim a page at a time, so a busy live chat does not evict and scan references on every single message.
    dropMessages(ids.splice(0, PAGE));
    pruneMessageRefs(ids);
    w.older = true;
  }
  add();
  ids.push(m.id);
}

/**
 * The last streamed events that change messages (message, delivery, read, acknowledgement, collaboration on messages),
 * kept before anything is dropped for a message not loaded: a REST answer (fillMessages) or a /api/state answer
 * (syncPaused) read before them applies them again. Complete after `ringFloor`: older ones may have been dropped.
 */
// shortcut: 1000 events cover a request's round trip; a message answer older than the ring is asked for once more
// (fetchWindow), a /api/state answer is not (an unread count or a busy dot stays off until the next snapshot).
const recentEvents = [];
let ringFloor = 0;
function remember(e) {
  recentEvents.push(e);
  if (recentEvents.length > 1000) ringFloor = recentEvents.shift().seq;
}

// Unread counts per cluster: /api/state's `unread` at its seq, plus each later message not from the user. When the read
// position moves, the loaded window counts again if it holds that message and everything after it; otherwise the Hub does.
const unread = new Map();   // clusterId -> { count, seq }
function readMoved(cid, seq) {
  const readId = S.clusters.get(cid)?.userReadMessageId;
  const messages = (S.clusterMsgs.get(cid) ?? []).map((id) => S.messages.get(id)).filter(Boolean);
  if (chatWindows.get(cid)?.live && messages.some((m) => m.id === readId)) unread.set(cid, { count: clusterUnread(messages, readId), seq });
  else resyncSoon();   // moved by another page past what this one holds
}

// Pause state is in Hub memory only (not replayable), so it comes from /api/state. A pause event is newer than
// that snapshot only if it was created after the snapshot request started (Hub and browser share one clock).
let pauseCutoff = Infinity;
let livePause = false;

// The limit settings are saved, and every change is a 'settings' event carrying that one setting (and its source),
// so per setting the newest such event is always the Hub's value: one applied while a sync is under way wins over that
// sync's snapshot. Events merge into S.settings; older events hold only maxHops and source.
const liveSettings = new Set();   // keys of S.settings set by a 'settings' event since the current sync started
// The sidebar forms (docs/hop-limit.md), by setting: the element id prefix, and whether the form shows a value the user
// has not edited (refill it from S.settings).
const LIMIT_FORMS = [
  { setting: 'maxHops', id: 'hop', stale: true },
  { setting: 'maxTurnsPerChain', id: 'chain', stale: true },
];
let usageAlertStale = true;
// The coordinator notification forms (docs/collaboration.md), by setting: an id prefix and whether the form still
// shows a value the user has not edited.
const NOTIFY_FORMS = [
  { setting: 'stalledMemberMinutes', id: 'stalled', stale: true },
];

function setSettings(s) {
  const next = { ...S.settings, ...s };
  if (JSON.stringify(next) === JSON.stringify(S.settings)) return;
  for (const f of LIMIT_FORMS) if (JSON.stringify(next[f.setting]) !== JSON.stringify(S.settings?.[f.setting])) f.stale = true;
  if (JSON.stringify(next.usageAlert) !== JSON.stringify(S.settings?.usageAlert)) usageAlertStale = true;
  for (const f of NOTIFY_FORMS) if (next[f.setting] !== S.settings?.[f.setting]) f.stale = true;
  S.settings = next;
}

/** A coordinator.set collaboration event: who coordinates the cluster now (none when cleared or disabled). */
const coordinatorSeq = new Map();   // clusterId -> seq of the last coordinator.set event applied
function applyCoordinator(clusterId, p, seq) {
  if (p?.action !== 'coordinator.set' || p.suggested || !clusterId) return;
  coordinatorSeq.set(clusterId, seq);
  if (p.memberId && p.enabled === true) S.coordinators.set(clusterId, p.memberId);
  else S.coordinators.delete(clusterId);
}

let syncs = 0;   // only the latest /api/state sync may apply; an older one can answer last
const pausedClusters = new Set();   // clusters paused on their own; the sidebar switch only shows the Hub-wide pause

async function syncPaused() {
  const mine = ++syncs;
  pauseCutoff = Date.now();
  livePause = false;
  liveSettings.clear();
  const st = await api('GET', '/api/state?includeRemoved=true');
  if (mine !== syncs) return;
  clusterSnapshotSeq = st.seq;
  clusterSnapshotIds = new Set(st.clusters.map((c) => c.id));
  for (const id of S.clusters.keys()) if (!clusterSnapshotIds.has(id) && (clusterVersions.get(id) ?? -1) <= st.seq) {
    S.clusters.delete(id); clusterVersions.set(id, st.seq + 0.5);
  }
  for (const c of st.clusters) upsertCluster(c, st.seq + 0.5);
  if (S.sel.cluster && !S.clusters.has(S.sel.cluster)) {
    workbench.removed(S.sel.cluster);
    select(null);
  }
  for (const m of st.members) upsertMember(m, st.seq + 0.5);
  // The snapshot's coordinators, except where a coordinator.set event newer than it was already applied.
  const coordinators = new Map(Object.entries(st.coordinators ?? {}));
  for (const [cid, seq] of coordinatorSeq) if (seq > st.seq) { if (S.coordinators.has(cid)) coordinators.set(cid, S.coordinators.get(cid)); else coordinators.delete(cid); }
  S.coordinators = coordinators;
  const after = recentEvents.filter((r) => r.seq > st.seq);   // streamed before this answer arrived, newer than its snapshot
  S.running.clear();
  for (const d of st.running ?? []) setDelivery({ ...d, state: 'running' }, true, st.seq + 0.5);
  for (const r of after) if (r.kind === 'delivery') setDelivery(r.payload.delivery, true, r.seq);
  for (const c of st.clusters) {
    // A read position moved by a newer event is counted by readMoved; the snapshot's count is for its older position.
    if (S.clusters.get(c.id)?.userReadMessageId !== c.userReadMessageId) continue;
    const newer = after.filter((r) => r.kind === 'message' && r.payload.message.clusterId === c.id && r.payload.message.from !== 'user').length;
    unread.set(c.id, { count: (c.unread ?? 0) + newer, seq: st.seq });
  }
  activityReady = true;
  const snapshot = { ...st.settings };
  for (const k of liveSettings) delete snapshot[k];
  setSettings(snapshot);
  if (mine !== syncs || livePause) return;
  S.paused = st.paused;
  pausedClusters.clear();
  for (const c of st.clusters) if (c.paused) pausedClusters.add(c.id);
  if (activityScope) loadActivity();
  render();
}

/** A fresh /api/state in a second, for what the stream alone cannot tell (an unread count after another page read). */
let resyncTimer = null;
let trashRemoved = null;
function resyncSoon() {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => syncPaused().catch(() => {}), 1000);
}

function applyEvent(e) {
  if (e.seq <= S.lastSeq) return;   // a reconnect never applies an event twice
  const live = replayComplete();   // false while the log is still catching up: the event that ends that must be drawn
  S.lastSeq = e.seq;
  const p = e.payload;
  stalled.changed();   // activity, a task change or a pause may end a hint: one read for a burst
  switch (e.kind) {
    case 'cluster': {
      if (p.cluster.purgedAt) trashRemoved?.(p.cluster.id);
      if (e.seq <= clusterSnapshotSeq && !clusterSnapshotIds.has(p.cluster.id)) break;
      const existed = S.clusters.has(p.cluster.id);
      const readBefore = S.clusters.get(p.cluster.id)?.userReadMessageId;
      upsertCluster(p.cluster, e.seq);
      const now = S.clusters.get(p.cluster.id);
      if (now && !unread.has(now.id)) unread.set(now.id, { count: 0, seq: e.seq });   // new: no messages yet
      else if (now && existed && (now.userReadMessageId ?? null) !== (readBefore ?? null)) readMoved(now.id, e.seq);
      for (const m of p.members) upsertMember(m, e.seq);
      if (p.cluster.deletedAt && !S.clusters.has(p.cluster.id)) {
        workbench.removed(p.cluster.id);
        if (S.sel.cluster === p.cluster.id) select(null);
      } else if (!existed && S.clusters.has(p.cluster.id) && !p.members.length) {
        syncPaused().catch(() => {});   // restored membership is returned by the fresh active snapshot
      }
      workbench.clustersChanged();
      break;
    }
    case 'member':
      upsertMember(p.member, e.seq);
      if (p.rebind) {
        S.rebinds.set(p.member.id, [...(S.rebinds.get(p.member.id) ?? []), p.rebind]);
        // The old conversation's title and model stop showing at once (memberDetails checks the binding); fetch the new one.
        if (p.member.clusterId === S.sel.cluster) loadUsageSoon(0);
      }
      if (p.member.removedAt) workbench.watchersChanged(p.member.clusterId);   // its watches went with it: the open detail re-reads once
      refreshHandoffTargets?.();
      break;
    case 'message': {
      const m = p.message;
      remember(e);
      const counted = unread.get(m.clusterId);
      if (counted && e.seq > counted.seq && m.from !== 'user') counted.count++;
      messageArrived(m, e.seq, () => addMessage(m, { deliveries: [], acknowledgements: p.acknowledgements ?? [], attachments: p.attachments ?? [], at: e.seq }));
      hiddenWarningArrived(m);
      allowRead(m.clusterId);
      for (const d of p.deliveries) {
        setDelivery(d, true, e.seq);
        pushMemberEvent(d.memberId, { ...e, memberId: d.memberId, kind: 'delivery', payload: { delivery: d, message: { from: m.from, body: m.body } } });
      }
      if (m.clusterId === S.sel.cluster) loadProblemsSoon();
      // The sidebar lists clusters by their newest message; this event is the only live signal for that.
      const cluster = S.clusters.get(m.clusterId);
      if (cluster) S.clusters.set(cluster.id, withLastMessage(cluster, m.createdAt));
      break;
    }
    case 'delivery':
      remember(e);
      setDelivery(p.delivery, true, e.seq);
      pushMemberEvent(p.delivery.memberId, e);
      if (e.clusterId === S.sel.cluster) loadProblemsSoon();
      break;
    case 'read':
      remember(e);   // a message read while not loaded gets it when it is (fillMessages)
      // Read receipts of loaded messages; the event carries only receipts that are new.
      for (const id of p.messageIds) {
        const msg = S.messages.get(id);
        if (msg) addRead(msg, p);
      }
      // A member reading an offline delivery's message takes it off the problem count (Store.deliveryProblems).
      if (e.clusterId === S.sel.cluster) loadProblemsSoon();
      break;
    case 'delivery_dismissed':   // 标为已知 on this or another page
      if (e.clusterId === S.sel.cluster) loadProblemsSoon();
      break;
    case 'acknowledgement':
      remember(e);
      for (const a of p.acknowledgements ?? []) {
        const msg = S.messages.get(a.messageId);
        if (msg) addAcknowledgement(msg, a);
      }
      break;
    case 'agent':
    case 'guard':
    case 'unread_hint':
      if (e.memberId) pushMemberEvent(e.memberId, e);
      // Only a line on that member's page. Members at work send these all the time: no pass unless the page is open.
      if (live && e.memberId !== S.sel.member) return;
      break;
    case 'settings':
      setSettings(p);
      for (const k of Object.keys(p)) liveSettings.add(k);
      if (p.usageAlert) loadUsageSoon(0);
      break;
    case 'usage':
      loadUsageSoon();   // quota numbers changed, or a turn's tokens were recorded
      if (live) return;   // nothing to draw yet: loadUsage draws the numbers when they arrive
      break;
    case 'collaboration':
      // A watch changes only an open task detail's watchers: not the task list, the references or the candidates.
      if (p.action === 'task.watch' || p.action === 'task.unwatch') { workbench.watchersChanged(e.clusterId, { taskId: p.watchedTaskId }); break; }
      if (p.action === 'cluster.pause' && !p.suggested) pausedClusters[p.paused ? 'add' : 'delete'](e.clusterId);
      applyCoordinator(e.clusterId, p, e.seq);
      // Only loaded messages: one being read now gets it from fillMessages, a later read has the current links.
      // task.delete removes message links without a message event (messageIds): refresh every row it unlinked.
      if (messageIdsOf(p).length) remember(e);
      for (const messageId of messageIdsOf(p)) if (S.messages.has(messageId)) queueMessageMetadata(e.clusterId, messageId);
      workbench.changed(e);
      taskRefs.changed(e.clusterId);
      taskCandidates.reset();
      break;
    case 'pause':
      if (Date.parse(e.createdAt) >= pauseCutoff) {
        S.paused = p.paused;
        livePause = true;
      }
      break;
  }
  render();
}

// ---- quota and token counts (docs/usage.md) ----
// Fetched for the selected cluster: when it changes, after a 'usage' event (debounced: a replay brings many), and
// every minute (whole-conversation totals change without events).

let usageFor = null;      // the cluster S.usage belongs to
let usageTimer = null;
let usageRequest = 0;     // only the newest GET /api/usage may apply: an older answer can arrive last
let turnRequestSeq = 0;
function loadUsageSoon(delay = 1000) {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(loadUsage, delay);
}
async function loadUsage() {
  const cid = S.sel.cluster;
  if (!cid) return;
  const mine = ++usageRequest;
  try {
    const u = await api('GET', `/api/usage?cluster=${encodeURIComponent(cid)}`);
    if (S.sel.cluster !== cid || mine !== usageRequest) return;
    S.usage = u;
    usageFor = cid;
    if (S.sel.member) void loadTurnUsage();
    render();
  } catch { /* keep the last numbers; the next tick tries again */ }
}

async function loadTurnUsage() {
  const cid = S.sel.cluster, mid = S.sel.member;
  if (!cid || !mid) return;
  const request = ++turnRequestSeq;
  try {
    const data = await api('GET', `/api/usage/turns?clusterId=${encodeURIComponent(cid)}&memberId=${encodeURIComponent(mid)}`);
    if (request !== turnRequestSeq || S.sel.cluster !== cid || S.sel.member !== mid) return;
    S.turnUsage = data;
    S.turnUsageError = false;
  } catch {
    if (request !== turnRequestSeq || S.sel.cluster !== cid || S.sel.member !== mid) return;
    S.turnUsage = null;
    S.turnUsageError = true;
  }
  render();
}
setInterval(() => { if (document.visibilityState === 'visible') loadUsage(); }, 60_000);

async function loadToolVersions() {
  try { S.toolVersions = await api('GET', '/api/tool-versions'); }
  catch { S.toolVersions = null; }
  if (S.sel.member) render();
}
setInterval(() => { if (S.sel.member && document.visibilityState === 'visible') loadToolVersions(); }, 60_000);

// Activity is a read-only snapshot, separate from delivery and receipt state. Keep historical timestamps when a
// query fails, but invalidate requests on navigation or hiding the page so late replies cannot update another view.
let activityScope = null;
let activityRequest = null;
let activityExpiryTimer = null;
const selectedActivityScope = () => S.sel.overview ? '*' : S.sel.cluster ? `c:${S.sel.cluster}` : null;
function hashActivityScope() {
  const q = new URLSearchParams(location.hash.slice(1));
  return q.get('view') === 'conversations' ? '*' : q.get('c') ? `c:${q.get('c')}` : null;
}
function syncActivityScope() {
  if (!activityReady) return;
  const next = selectedActivityScope();
  if (next === activityScope) return;
  cancelActivityRequest();
  activityScope = next;
  S.activityFailed = false;
  scheduleActivityExpiry();
  if (next && document.visibilityState === 'visible') loadActivity();
}
function cancelActivityRequest() {
  if (!activityRequest) return;
  const request = activityRequest;
  activityRequest = null;
  clearTimeout(request.timeout);
  request.controller.abort();
}
function scheduleActivityExpiry() {
  clearTimeout(activityExpiryTimer);
  if (document.visibilityState !== 'visible' || !activityScope) return;
  const now = Date.now();
  const deadlines = [...S.members.values()].filter((m) => !m.removedAt && (activityScope === '*' || `c:${m.clusterId}` === activityScope))
    .map((m) => S.activity.get(m.id)).filter((s) => s?.state === 'observing' && s.lastSeenAt)
    .map((s) => Date.parse(s.lastSeenAt) + (s.staleAfterMs || 45_000)).filter((t) => Number.isFinite(t) && t >= now);
  if (deadlines.length) activityExpiryTimer = setTimeout(() => { render(); scheduleActivityExpiry(); }, Math.min(...deadlines) - now + 1);
}
async function loadActivity() {
  const scope = activityScope;
  if (!activityReady || !scope || scope !== hashActivityScope() || document.visibilityState !== 'visible' || activityRequest) return;
  const request = { controller: new AbortController(), timeout: null };
  activityRequest = request;
  request.timeout = setTimeout(() => {
    if (activityRequest !== request) return;
    const sameView = scope === hashActivityScope() && document.visibilityState === 'visible';
    cancelActivityRequest();
    if (sameView) { S.activityFailed = true; render(); }
  }, 25_000);
  const current = () => request === activityRequest && scope === activityScope && scope === hashActivityScope()
    && document.visibilityState === 'visible';
  try {
    const path = scope === '*' ? '/api/activity' : `/api/activity?cluster=${encodeURIComponent(scope.slice(2))}`;
    const response = await fetch(path, { method: 'GET', signal: request.controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!current()) return;
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (!Array.isArray(data.members)) throw new Error('invalid activity response');
    const relevant = [...S.members.values()].filter((m) => !m.removedAt && (scope === '*' || `c:${m.clusterId}` === scope));
    const ids = new Set(relevant.map((m) => m.id));
    for (const id of ids) S.activity.delete(id);
    for (const row of data.members) if (ids.has(row.memberId)) S.activity.set(row.memberId, row.activity);
    S.activityFailed = false;
    scheduleActivityExpiry();
  } catch {
    if (!current()) return;
    S.activityFailed = true;
  } finally {
    clearTimeout(request.timeout);
    if (activityRequest === request) activityRequest = null;
  }
  render();
}
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  render();   // a slow or hung request must not keep an old observing state fresh
  loadActivity();
  if (hubCheckPending) checkHub();   // the health check or the plugin list could not be read yet
}, 10_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') cancelActivityRequest();
  scheduleActivityExpiry();
  if (document.visibilityState === 'visible') { render(); loadActivity(); }
});

function activityEl(summary, group = null) {
  const name = group ? t('活动观察（{group}）', { group: group }) : t('活动观察');
  const source = summary.source ? ` · ${summary.source}` : '';
  const { hasChannel } = summary;
  const seen = hasChannel ? t(' · 最近响应 {value}', { value: summary.seen ?? t('未知') }) : '';
  const heading = `${name}：${summary.state}${source}${seen}`;
  const detail = summary.activity ? t('最近活动 {activity}', { activity: summary.activity }) : hasChannel ? t('最近活动 暂无记录') : null;
  return h('div', { class: 'activity-summary' },
    h('span', { class: 'activity-head', title: heading }, h('span', { class: 'activity-scope' }, name),
      h('span', {}, `：${summary.state}${seen}`)), detail ? h('span', { title: detail }, detail) : null);
}
async function refreshQuota() {
  try { await api('POST', '/api/usage/refresh', {}); } catch { /* the report carries the error */ }
  await loadUsage();
}

// ---- server ----

/** `withSeq`: answers { data, seq }, seq being the event seq the Hub read the rows at (X-Orrery-Seq; 0 if missing). */
async function api(method, path, body, withSeq = false, fetchOptions = {}) {
  const headers = new Headers(fetchOptions.headers);
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const init = { ...fetchOptions, method, headers };
  if (body !== undefined) init.body = headers.get('content-type') === 'application/octet-stream' ? body : JSON.stringify(body);
  const res = await fetch(path, init);
  if (res.status === 401) unauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return withSeq ? { data, seq: Number(res.headers.get('x-orrery-seq')) || 0 } : data;
}

const featureApi = (method, path, body, options) => api(method, path, body, false, options);

// Every /api/* request needs the API token (docs/security.md); the page carries it as a session cookie. A 401 means
// this browser has no valid one: say so once and stop reconnecting.
let denied = false;
function unauthorized() {
  if (denied) return;
  denied = true;
  stream?.close();
  setConn(false);   // shows 未通过验证 (review api-token r1, P2)
  noticeDialog(lt('这个页面没有通过 Hub 的验证（没有令牌，或令牌已失效）。请从 orrery 启动器或桌面版重新打开页面。'), lt('需要重新打开页面'));
}

// An EventSource cannot see a 401: before rebuilding a closed stream, /api/health tells.
async function reconnect() {
  try {
    if ((await fetch('/api/health', { cache: 'no-store' })).status === 401) return unauthorized();
  } catch { /* no Hub right now: the stream retries */ }
  connect(S.lastSeq, true);
}

let stream = null;   // the current EventSource
let quitting = false;   // set by "退出 orrery": no more reconnects

/** The stream from `since`, the /api/state snapshot's seq or the last event seen: never the whole log from 0. */
function connect(since, rebuilt = false) {
  if (quitting || denied) return;
  // The browser's own reconnect keeps this URL and adds Last-Event-ID; the Hub resumes from the newer of the two.
  const es = new EventSource(`/api/stream?since=${since}`);
  stream = es;
  let down = rebuilt;   // a rebuilt stream follows an outage (maybe a Hub restart), so it re-syncs pause on first open
  es.onmessage = (m) => {
    applyEvent(JSON.parse(m.data));
    viewHost.emit(m.data);   // an open full-page view's listeners (ctx.onEvent) get their own copy
  };
  // A plugin command run (docs/external-plugins.md「命令」): a named frame outside the event log, for this page only.
  es.addEventListener('plugin-run', (m) => { try { runState.apply(JSON.parse(m.data)); } catch { /* a bad frame changes nothing */ } render(); });
  // A third-party plugin's state (docs/external-plugins.md「生命周期」): its card on the settings page, if drawn, keeps the newer copy.
  es.addEventListener('plugin-state', (m) => {
    try { pluginSettings.applyState(JSON.parse(m.data)); } catch { /* a bad frame changes nothing */ }
    pluginUi.pluginState();   // its UI may have stopped, come back or been switched off
  });
  // A third-party plugin's own UI (docs/external-plugins.md「网页界面」): pushes to its frames, its chip, revoked frames.
  es.addEventListener('plugin-ui', (m) => { try { pluginUi.event(JSON.parse(m.data)); } catch { /* a bad frame changes nothing */ } });
  es.addEventListener('plugin-config', (m) => { try { pluginConfig.changed(JSON.parse(m.data)); } catch { /* ignore a malformed frame */ } });
  es.onopen = () => {
    setConn(true);
    if (down || loadedPid === null || hubCheckPending) checkHub();
    if (down) {   // the Hub may have restarted, which resets pause and may bring new web code
      syncPaused().catch(() => {});
      retryMessageMetadata(S.sel.cluster);
      loadProblemsSoon();
      if (S.sel.cluster) loadCommands(S.sel.cluster).catch(() => {});   // runs that ended while the stream was down drop out
      pluginUi.reconnected();   // a restarted Hub knows none of the open frames: they load again
    }
    down = false;
  };
  es.onerror = () => {
    if (quitting || denied) { es.close(); return; }
    setConn(false);
    down = true;
    if (es.readyState === EventSource.CLOSED) setTimeout(reconnect, 3000);
  };
}

// ---- Hub restarts: a new Hub process may serve newer web code, which only loads with a reload ----
// The desktop shell has no reload button (F5 / Ctrl+R only), so the page reloads itself when nothing would be lost,
// else it shows a banner and the user decides.

let loadedPid = null;   // the Hub process this page was loaded from (first answer of /api/health)
let pagePlugins = null;   // the GET /api/plugins answer this page loaded its plugin modules from
let pluginsStart = null;  // the Hub start (`instance`) whose plugin list the page loaded or compared last
let legacyPluginsPid = null;  // Hub versions without an instance use the health PID
const detachedNames = new Map();   // full-trust plugin id -> its name, for the plugins detached from this page
const triedContinuouslyListed = new Set();   // a failed attempt is offered again only after the module disappears and returns
let hubCheckPending = false;
let checkingHub = false;

async function readPagePlugins() {
  const list = await api('GET', '/api/plugins', undefined, false, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!Array.isArray(list?.plugins) || !list.plugins.every((plugin) => typeof plugin?.id === 'string')) return null;
  if (typeof list.instance === 'string' && Array.isArray(list.trustedFrontend)
    && list.trustedFrontend.every((id) => typeof id === 'string')) return list;
  // Hub versions before page modules had neither field.
  if (list.instance === undefined && list.trustedFrontend === undefined) return { ...list, trustedFrontend: [] };
  return null;
}

async function checkHub() {
  if (quitting || denied || checkingHub) return;
  checkingHub = true;
  const retry = hubCheckPending;
  hubCheckPending = true;
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.status === 401) return unauthorized();
    if (!res.ok) return;
    const health = await res.json();
    if (health?.app !== 'orrery' || !Number.isInteger(health.pid)
      || (health.instance !== undefined && typeof health.instance !== 'string')) return;
    const start = health.instance ?? null;
    loadedPid ??= health.pid;
    const restarted = pagePlugins !== null && (pagePlugins.instance ?? null) !== start;
    if (retry || start !== pluginsStart || (start === null && health.pid !== legacyPluginsPid)) {
      const now = await readPagePlugins();
      // A restart between these GETs must be checked against the health of the same start.
      if (now === null || (now.instance ?? null) !== start || denied || quitting) return;
      pluginsStart = start;
      legacyPluginsPid = start === null ? health.pid : null;
      trustedPluginsChanged(now);
      detachPluginSlots(pluginSlots, staleOfficialPackages(pluginSlots, now));
    }
    hubCheckPending = false;
    const content = unsaved();
    const action = restarted ? (reloadWouldLose(content) ? 'banner' : 'reload') : hubRestartAction(loadedPid, health, content);
    // While the plugin notice is up the page reloads only when the user says so; the usual banner still shows.
    if (action === 'reload' && $('trust-banner').hidden) location.reload();
    else if (action !== 'none') $('update-banner').hidden = false;
  } catch { /* no Hub right now: the next reconnect checks again */ } finally {
    checkingHub = false;
  }
}

/**
 * What a reload would lose: composer drafts, attachments waiting to be sent, open dialogs and edits, sends in flight,
 * and unsaved limit edits (the settings forms keep them when the dialog is closed).
 */
function unsaved() {
  return {
    drafts: [chat.input.value, direct.input.value, ...drafts.values()],
    uploads: [...uploads.values()].reduce((n, list) => n + list.length, 0),
    editing: sending.size > 0 || editingId !== null || panelEditor.dirty() || Boolean(openForm) || [...taskDrafts.values()].some((ids) => ids.length)
      || viewHost.hasTypedInput()
      || [...document.querySelectorAll('dialog[open]')].some((d) => d.id !== 'viewer')
      || Boolean(S.settings?.usageAlert && (String(S.settings.usageAlert.turnTokens) !== $('usage-alert-turn').value
        || String(S.settings.usageAlert.conversationTokens) !== $('usage-alert-conversation').value))
      || LIMIT_FORMS.some((f) => limitFormEdited(f.setting, S.settings, { unlimited: $(`${f.id}-unlimited`).checked, value: $(`${f.id}-value`).value }))
      || NOTIFY_FORMS.some((f) => notifyFormEdited(f.setting, S.settings, $(`${f.id}-value`).value)),
  };
}

window.addEventListener('focus', () => { if (loadedPid !== null || hubCheckPending) checkHub(); allowRead(S.sel.cluster); render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') allowRead(S.sel.cluster); render(); });
// Here as well as in the workbench, which is gone when the tasks plugin is off: a paused cluster must stay resumable.
$('cluster-resume').addEventListener('click', async () => {
  try {
    await api('POST', `/api/clusters/${encodeURIComponent(S.sel.cluster)}/collaboration`, { action: 'cluster.pause', paused: false, operationId: crypto.randomUUID() });
  } catch (e) { await noticeDialog(e.message, lt('恢复投递失败')); }
});

/**
 * After a Hub restart: full-trust plugins this page runs that the Hub no longer lists are detached at once (no more
 * calls, what they rendered removed, their onDispose run), and the notice says what is true and offers the reload. The
 * page never reloads by itself for this and leaves every input alone. An unchanged list changes nothing here.
 */
function trustedPluginsChanged(now) {
  const listed = new Set(now.trustedFrontend);
  for (const id of triedContinuouslyListed) if (!listed.has(id)) triedContinuouslyListed.delete(id);
  const { stale, fresh } = trustedChange({ trusted: pluginSlots.trusted, tried: [...triedContinuouslyListed] }, now);
  const pluginName = (id) => [...(pagePlugins?.installed ?? []), ...(now.installed ?? [])].find((p) => p.id === id && typeof p.name === 'string')?.name ?? id;
  for (const id of stale) detachedNames.set(id, pluginName(id));
  detachPluginSlots(pluginSlots, stale);   // pluginSlots.onRelease follows in the workbench and redraws
  $('safe-mode-banner').hidden = now.safeMode !== true;   // the notice describes this list; so does this banner
  const unavailable = [...detachedNames].filter(([id]) => !listed.has(id)).map(([, name]) => name);
  const reappeared = fresh.some((id) => detachedNames.has(id));
  const text = trustNoticeText(unavailable, fresh.map(pluginName))
    + (reappeared ? t(' 重新列出的已摘除插件仍需刷新页面才能恢复。') : '');
  $('trust-banner-text').textContent = text;
  $('trust-banner').hidden = text === '';
}

async function reloadUnlessUnsaved() {
  if (reloadWouldLose(unsaved())) {
    const ok = await confirmDialog({
      title: lt('现在刷新页面？'), message: lt('未发送的草稿、附件和没保存的编辑会丢失。可以先发送或复制它们，再点横幅刷新。'),
      confirmText: lt('刷新'), danger: true,
    });
    if (!ok) return;
  }
  location.reload();
}
$('update-reload').addEventListener('click', reloadUnlessUnsaved);
$('trust-reload').addEventListener('click', reloadUnlessUnsaved);

let connOk = null;   // the last state shown, drawn again after a language switch
function setConn(ok) {
  connOk = ok;
  const el = $('conn');
  el.className = `conn ${ok ? 'ok' : 'bad'}`;
  el.textContent = ok ? t('已连接') : denied ? t('未通过验证') : t('已断开，重连中…');
}

// ---- selection (kept in the URL hash so a reload stays put) ----

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const overview = q.get('view') === 'conversations';
  const previousCluster = S.sel.cluster;
  const previousMember = S.sel.member;
  S.sel = { cluster: overview ? null : q.get('c'), member: overview ? null : q.get('m'), overview };
  if (previousMember !== S.sel.member || previousCluster !== S.sel.cluster) {
    turnRequestSeq++;
    S.turnUsage = null;
    S.turnUsageError = false;
    if (S.sel.member) void loadTurnUsage();
  }
  if (S.sel.member && previousMember !== S.sel.member) loadToolVersions();
  if (previousCluster !== S.sel.cluster) {
    forgetWindow(previousCluster);
    retryMessageMetadata(S.sel.cluster);
    allowRead(S.sel.cluster);
  } else pumpMessageMetadata();
  syncActivityScope();
}

function select(cluster, member = null) {
  const q = new URLSearchParams();
  if (cluster) q.set('c', cluster);
  if (member) q.set('m', member);
  location.hash = q.toString();
  readHash();
  retryMessageMetadata(cluster);
  render();
  $('app').classList.remove('sidebar-open');
}

const readRequests = new Map();   // cluster id -> last request, in-flight flag and deferred timer
// The stream starts at the snapshot's seq, so this holds once /api/state has answered; after a reconnect's fresh
// snapshot it waits until the stream has caught up with it.
const replayComplete = () => clusterSnapshotSeq >= 0 && S.lastSeq >= clusterSnapshotSeq;
/** The sidebar badge: kept by syncPaused, the 'message' events and readMoved; no message needs to be loaded. */
const unreadOf = (cluster) => unread.get(cluster.id)?.count ?? 0;

function allowRead(id) {
  const state = readRequests.get(id);
  if (state) { state.blocked = false; if (state.inFlight) state.retryRequested = true; }
}

function scheduleSelectedRead() {
  const id = S.sel.cluster;
  const cluster = S.clusters.get(id);
  if (!cluster || S.sel.overview || !replayComplete() || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  // A full-page plugin view covers the chat: nothing in it is being read. Closing the view redraws, which reads again.
  if ($('app').classList.contains('view-open')) return;
  // Only a window that shows the newest message: reading older history does not read what came after it. The old read
  // position need not be loaded; the Hub only ever moves it forward.
  const w = chatWindows.get(id);
  if (!w?.live || w.pending) return;
  const latest = S.clusterMsgs.get(id)?.at(-1);
  if (!latest || latest === cluster.userReadMessageId) return;
  const state = readRequests.get(id) ?? { lastSent: 0, inFlight: false, timer: null, blocked: false, retryRequested: false, lastSuccess: null };
  readRequests.set(id, state);
  if (state.inFlight || state.blocked || state.lastSuccess === latest) return;
  const delay = Math.max(0, state.lastSent + 2000 - Date.now());
  if (delay) {
    if (!state.timer) state.timer = setTimeout(() => { state.timer = null; scheduleSelectedRead(); }, delay);
    return;
  }
  state.lastSent = Date.now();
  state.inFlight = true;
  state.retryRequested = false;
  let succeeded = false;
  api('POST', `/api/clusters/${encodeURIComponent(id)}/read`, { messageId: latest })
    .then(() => { state.lastSuccess = latest; succeeded = true; }, () => { state.blocked = !state.retryRequested; })
    .finally(() => { state.inFlight = false; if (succeeded || state.retryRequested) scheduleSelectedRead(); });
}

window.addEventListener('hashchange', () => { readHash(); render(); });
$('open-conversations').addEventListener('click', () => {
  location.hash = 'view=conversations';
  $('app').classList.remove('sidebar-open');
  readHash();
  render();
});

// ---- rendering (batched: one pass per ~frame) ----
// setTimeout, not requestAnimationFrame: rAF stalls while the page is not painted (a hidden pane or a
// minimised host window), and a page that resumes later should already be up to date.

/** Sets text that a pass writes again and again: assigning the same text still replaces the node, and the next size read lays the page out. */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** No cluster in the URL: select the newest non-archived one without adding a history entry. */
function defaultSelection(clusters = [...S.clusters.values()]) {
  const defaultCluster = clusterOrder(clusters.filter((cluster) => !cluster.archivedAt))[0];
  if (!S.sel.overview && !S.sel.cluster && defaultCluster) {
    S.sel = { cluster: defaultCluster.id, member: null, overview: false };
    history.replaceState(null, '', `#c=${S.sel.cluster}`);
  }
}

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    const clusters = [...S.clusters.values()];
    defaultSelection(clusters);
    const m = S.members.get(S.sel.member);
    if (m && m.clusterId !== S.sel.cluster) S.sel.member = null;
    syncActivityScope();
    expandSelectedGroup();
    renderSidebar(clusters);
    const view = panelView();
    $('member-panel').hidden = !view;
    $('panel-divider').hidden = !view;
    $('members-view').hidden = view !== 'members';
    $('member-view').hidden = view !== 'member';
    if (panelShown !== Boolean(view)) {   // the chat's room changed: refit both panes
      panelShown = Boolean(view);
      fitPanes();
    }
    renderChat();
    renderMemberPanel();
    renderManage();
    scheduleSelectedRead();
    $('scrim').hidden = !($('app').classList.contains('sidebar-open') || (view && innerWidth <= 900));
  }, 16);
}

// ---- right-hand panel: the cluster's member list (with the membership actions) or one member's page ----

let panelShown = false;

/** What the panel shows: 'member' (S.sel.member's page, from #m=), 'members' (the list), or null (closed). */
function panelView() {
  if (S.sel.overview) return null;
  if (S.members.get(S.sel.member)) return 'member';
  return panelOpen && S.clusters.has(S.sel.cluster) ? 'members' : null;
}

function setPanelOpen(open) {
  panelOpen = open;
  writePanelOpen(open);
}

/** Opens the panel on the member list (from a member page: back to the list). */
function openMembers() {
  setPanelOpen(true);
  if (S.sel.member) select(S.sel.cluster);
  else render();
}

/** Closes the panel; focus inside it goes back to the header toggle. */
function closePanel() {
  const inside = $('member-panel').contains(document.activeElement);
  setPanelOpen(false);
  if (S.sel.member) select(S.sel.cluster);
  else render();
  if (inside) $('members-toggle').focus();
}

$('members-toggle').addEventListener('click', () => (panelView() ? closePanel() : openMembers()));
$('close-panel').addEventListener('click', closePanel);
$('close-member').addEventListener('click', closePanel);
$('back-members').addEventListener('click', openMembers);
$('member-panel').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
  e.preventDefault();
  closePanel();
});

// ---- resizable panes: drag a divider, arrow keys on a focused one, double-click to reset (ui.js PANES, clampPane) ----

const panes = {
  side: { divider: $('side-divider'), prop: '--side-w', want: readPane('side'), width: 0 },
  panel: { divider: $('panel-divider'), prop: '--panel-w', want: readPane('panel'), width: 0 },
};

/** The window width minus the other pane (the member panel only while it is shown). */
function roomFor(pane) {
  const other = pane === 'side' ? (panelShown ? panes.panel.width : 0) : panes.side.width;
  return document.documentElement.clientWidth - other;
}

/** Shows `pane` at its wanted width, narrowed if the window cannot fit it next to a usable chat. */
function fitPane(pane) {
  const p = panes[pane];
  p.width = clampPane(pane, p.want, roomFor(pane));
  $('app').style.setProperty(p.prop, `${p.width}px`);
  p.divider.setAttribute('aria-valuenow', String(p.width));
  p.divider.setAttribute('aria-valuemin', String(PANES[pane].min));
  p.divider.setAttribute('aria-valuemax', String(PANES[pane].max));
  p.divider.setAttribute('aria-valuetext', t('{width} 像素', { width: p.width }));
}
function fitPanes() {
  fitPane('side');
  fitPane('panel');
}

/** Sets a width the user chose (what is shown is what is remembered); `save` writes it to localStorage. */
function setPane(pane, px, save) {
  const p = panes[pane];
  p.want = clampPane(pane, px, roomFor(pane));
  fitPane(pane);
  if (save) writePane(pane, p.want);
}

for (const [pane, p] of Object.entries(panes)) {
  const d = p.divider;
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();   // no text selection while dragging
    d.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = p.width;
    const sign = pane === 'side' ? 1 : -1;   // the panel's divider is on its left edge
    d.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev) => setPane(pane, w0 + sign * (ev.clientX - x0), false);
    const end = () => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', end);
      d.removeEventListener('pointercancel', end);
      d.classList.remove('dragging');
      document.body.classList.remove('resizing');
      writePane(pane, p.want);
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
  });
  d.addEventListener('dblclick', () => setPane(pane, PANES[pane].def, true));
  d.addEventListener('keydown', (e) => {
    const next = paneKey(pane, p.width, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    setPane(pane, next, true);
  });
}
fitPanes();
// The window's size, also when it first gets one: a page loaded hidden (a minimised or background window) has none.
new ResizeObserver(() => {
  fitPanes();
  for (const c of [chat, direct]) autogrow(c.input);   // the cap is a share of the window height
}).observe(document.documentElement);

// ---- redraws that never swap the element under a pressed pointer ----
// Rebuilding buttons between pointerdown and pointerup would swap the button under the pointer and the click would
// never arrive (the same failure as the desktop tab bar, docs/desktop.md). A list is redrawn only when what it shows
// changes (its signature), and a redraw due while a pointer is down on it waits for the release.

function stableList(el) {
  let shown = null;    // the signature drawn now; null until drawn
  let down = false;    // a pointer is pressed on the list
  let pending = false;
  el.addEventListener('pointerdown', () => { down = true; });
  const released = () => {
    if (!down) return;
    down = false;
    if (!pending) return;
    pending = false;
    setTimeout(render, 0);   // after this press' click was dispatched on the old button
  };
  window.addEventListener('pointerup', released);
  window.addEventListener('pointercancel', released);
  return (signature, draw) => {
    const sig = `${language()}\n${signature}`;   // a language switch redraws the list
    if (sig === shown) return;
    if (down) { pending = true; return; }
    shown = sig;
    draw();
  };
}

function activityOf(members) {
  const busy = members.filter((m) => statusOf(m) === 'busy');
  return busy.length ? t('投递中') : '';
}
const clusterActivity = (c) => activityOf(membersOf(c.id));

const ARCHIVE_OPEN_KEY = 'orrery.archiveOpen';
let archiveOpen = (() => { try { return localStorage.getItem(ARCHIVE_OPEN_KEY) === '1'; } catch { return false; } })();
let clusterMenu = null;

/** Include every field that changes a section, badge or selected row. */
function clusterListSignature(clusters) {
  return [archiveOpen, collapsedSignature(collapsedGroups), groupList().join('\u0001'), ...clusterOrder(clusters).map((c) => [
    c.id, c.name, c.category ?? '', c.pinnedAt ?? '', c.archivedAt ?? '', c.userReadMessageId ?? '', unreadOf(c),
    membersOf(c.id).length, clusterActivity(c), c.id === S.sel.cluster ? 1 : 0, c.lastMessageAt ?? '', stalledSummary(stalled.forCluster(c.id)),
  ].join('|'))].join('\n');
}

/** Every group, in the Hub's order: what PUT /api/cluster-groups takes (the Hub's list plus any group a cluster names). */
function groupList() {
  return clusterGroups([...S.clusters.values()], S.settings?.clusterGroups ?? []).map((g) => g.name).filter(Boolean);
}

function positionClusterMenu() {
  if (!clusterMenu?.trigger?.isConnected) return;
  const anchor = clusterMenu.trigger.getBoundingClientRect();
  const box = clusterMenu.el.getBoundingClientRect();
  clusterMenu.el.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8))}px`;
  clusterMenu.el.style.top = `${Math.max(8, Math.min(anchor.bottom, innerHeight - box.height - 8))}px`;
}

function closeClusterMenu(restore = false) {
  if (!clusterMenu) return;
  const previous = clusterMenu;
  clusterMenu = null;
  previous.el.remove();
  previous.trigger?.setAttribute('aria-expanded', 'false');
  if (restore && previous.trigger?.isConnected) previous.trigger.focus({ preventScroll: true });
}

function syncClusterMenuAnchor() {
  if (!clusterMenu) return;
  const trigger = clusterMenuTrigger(clusterMenu.id);
  if (!trigger) return closeClusterMenu(false);
  clusterMenu.trigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  positionClusterMenu();
}

function clusterMenuTrigger(id) {
  return [...$('cluster-list').querySelectorAll('[data-cluster-menu]')].find((item) => item.dataset.clusterMenu === id);
}

function showClusterMenu(id, trigger, menu) {
  closeClusterMenu(false);
  const itemSelector = '[role="menuitem"]:not([disabled])';
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeClusterMenu(true); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...menu.querySelectorAll(itemSelector)];
    const current = items.indexOf(document.activeElement);
    items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  menu.addEventListener('focusout', () => setTimeout(() => {
    if (clusterMenu?.el === menu && !menu.contains(document.activeElement) && document.activeElement !== clusterMenu.trigger) closeClusterMenu(false);
  }, 0));
  document.body.append(menu);
  clusterMenu = { id, trigger, el: menu };
  trigger.setAttribute('aria-expanded', 'true');
  positionClusterMenu();
  menu.querySelector(itemSelector)?.focus();
}

async function clusterMenuAction(id, action) {
  const cluster = S.clusters.get(id);
  const trigger = clusterMenu?.trigger;
  closeClusterMenu(false);
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  if (!cluster) return;
  if (action === 'plugin-config') return pluginConfig.openCluster(id, () => clusterMenuTrigger(id));
  if (action === 'rename') return renameCluster(cluster);
  if (action === 'delete') return deleteCluster(cluster);
  if (action === 'new-group') {
    return groupNameDialog(lt('新建分组'), '', async (name) => {
      await api('POST', '/api/cluster-groups', { name });
      await moveToGroup(id, name);
    }, t('“{name}”会移进这个新分组。', { name: cluster.name }));
  }
  if (action.startsWith('group:')) return moveToGroup(id, action.slice('group:'.length));
  try {
    await api('PATCH', `/api/clusters/${encodeURIComponent(id)}`, action === 'pin'
      ? cluster.archivedAt ? { archived: false, pinned: true } : { pinned: !cluster.pinnedAt }
      : { archived: !cluster.archivedAt });
  } catch (error) { await noticeDialog(error.message, lt('更新群聊失败')); }
}

function openClusterMenu(id, trigger) {
  const cluster = S.clusters.get(id);
  if (!cluster) return;
  const actions = [
    { key: 'pin', label: cluster.pinnedAt ? t('取消置顶') : t('置顶群聊') },
    { key: 'archive', label: cluster.archivedAt ? t('取消归档') : t('归档') },
    { key: 'move', label: t('移到分组…') },
    { key: 'plugin-config', label: t('插件配置') },
    { key: 'rename', label: t('改名') }, { key: 'delete', label: t('删除') },
  ];
  const item = (key, label, extra = {}) => h('button', { type: 'button', role: 'menuitem', 'data-menu-action': key,
    onclick: () => { void clusterMenuAction(id, key); }, ...extra }, label);
  // "移到分组…" turns the same menu into the list of groups (keyboard and touch reach it like any other item).
  const showTargets = () => {
    menu.setAttribute('aria-label', t('移到分组：{name}', { name: cluster.name }));
    menu.replaceChildren(h('div', { class: 'cluster-menu-title' }, t('移到分组')),
      ...moveTargets(groupList(), cluster.category).map((targetGroup) => item(`group:${targetGroup.name}`, targetGroup.current ? [icon('check', 'ico-sm'), targetGroup.label, h('span', { class: 'sr-only' }, t('（当前分组）'))] : targetGroup.label,
        targetGroup.current ? { 'aria-disabled': 'true', disabled: true } : {})),
      item('new-group', t('新建分组…')));
    positionClusterMenu();
    menu.querySelector('[role="menuitem"]:not([disabled])')?.focus();
  };
  const menu = h('div', { class: 'cluster-menu', role: 'menu', 'aria-label': t('群聊操作：{name}', { name: cluster.name }) },
    actions.map((action) => action.key === 'move'
      ? h('button', { type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'data-menu-action': 'move', onclick: showTargets }, action.label)
      : item(action.key, action.label)));
  showClusterMenu(id, trigger, menu);
}

document.addEventListener('pointerdown', (event) => {
  if (clusterMenu && !clusterMenu.el.contains(event.target) && !clusterMenu.trigger.contains(event.target)) closeClusterMenu(false);
});

function renameCluster(cluster) {
  sidebarNameDialog({
    title: lt('改名'), label: lt('群聊名称'), initial: cluster.name, note: lt('允许与其他群聊重名。'),
    validate: clusterNameInput, invalidTitle: lt('改名失败'),
    save: (name) => api('PATCH', `/api/clusters/${encodeURIComponent(cluster.id)}`, { name }),
    findOpener: () => clusterMenuTrigger(cluster.id),
  });
}

function sidebarNameDialog({ title, label, initial, note, maxLength, validate, save, invalidTitle = title, findOpener }) {
  const opener = document.activeElement;
  const input = h('input', { 'aria-label': label, maxlength: maxLength });
  input.value = initial;
  let saving = false;
  const cancel = h('button', { type: 'button', onclick: () => { if (!saving) dialog.close(); } }, lt('取消'));
  const ok = h('button', { type: 'submit', class: 'primary' }, lt('保存'));
  const dialog = h('dialog', { 'aria-label': title }, h('form', { class: 'workbench-form' }, h('h2', {}, title),
    note ? h('p', { class: 'muted' }, note) : null, h('label', {}, label, input), h('div', { class: 'row end' }, cancel, ok)));
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    const value = input.value;
    const result = validate(value);
    if (result.error) { await noticeDialog(lt(() => validate(value).error), invalidTitle); input.focus(); return; }
    saving = true;
    ok.disabled = true; cancel.disabled = true; input.disabled = true;
    try { await save(result.name); dialog.close(); }
    catch (error) { await noticeDialog(error.message, lt('{title}失败', { title: title })); }
    finally { saving = false; ok.disabled = false; cancel.disabled = false; input.disabled = false; }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    const trigger = findOpener ? findOpener() : opener;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
  input.select();
}

// ---- sidebar groups: the Hub's group list (GET/POST/PATCH/DELETE/PUT /api/cluster-groups, docs/architecture.md) ----

/** Moves a cluster into a group ('' = 未分组). */
async function moveToGroup(id, category) {
  const cluster = S.clusters.get(id);
  if (!cluster || (cluster.category ?? '') === category) return;
  try { await api('PATCH', `/api/clusters/${encodeURIComponent(id)}`, { category }); }
  catch (error) { await noticeDialog(error.message, lt('移动失败')); }
}

/** A group name dialog; `save(name)` runs on submit and the dialog stays open, with the Hub's answer, if it throws. */
function groupNameDialog(title, initial, save, note = '') {
  sidebarNameDialog({
    title, label: lt('分组名'), initial, save, note, maxLength: 80,
    validate: (value) => {
      const { category, error } = categoryInput(value);
      return { name: category, error: error || (!category && t('分组名不能为空')) };
    },
  });
}

async function groupAction(name, action) {
  const trigger = clusterMenu?.trigger;
  closeClusterMenu(false);
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });   // dialogs opened below return focus here
  const groups = groupList();
  try {
    if (action === 'rename') return groupNameDialog(lt('分组改名'), name, (to) => renameGroupKeepingView(name, to));
    if (action === 'up' || action === 'down') {
      const next = moveGroup(groups, name, action === 'up' ? -1 : 1);
      if (next) await api('PUT', '/api/cluster-groups', { groups: next });
      return;
    }
    if (action === 'delete') {
      const count = [...S.clusters.values()].filter((c) => (c.category ?? '').trim() === name).length;
      const ok = await confirmDialog({ title: lt('删除分组？'), message: count
        ? lt('“{name}”里的 {count} 个群聊会移到“{UNGROUPED}”，群聊本身不变。', { name: name, count: count, UNGROUPED: lt(UNGROUPED) })
        : lt('“{name}”是空分组。', { name: name }), confirmText: lt('删除分组'), danger: true });
      if (!ok) return;
      await api('DELETE', '/api/cluster-groups', { name });
      // Its clusters are drawn under 未分组 by the events; the name's collapse must not carry over to a new group of that name.
      if (collapsedGroups.delete(name)) { writeCollapsedGroups(); render(); }
    }
  } catch (error) { await noticeDialog(error.message, lt('分组操作失败')); }
}

/**
 * Renames a group on the Hub and carries what this page keys by its name (collapsed or not, and which group was last
 * opened for the selected cluster) to the new name. The Hub's events and its answer can arrive in either order, so the
 * new name takes the old one's state before the request and both are drawn the same until the answer: the group keeps
 * its look whichever comes first, and after the answer the page shows what a reload would. A refused rename undoes it.
 */
async function renameGroupKeepingView(from, to) {
  if (from === to) return api('PATCH', '/api/cluster-groups', { from, to });
  const collapsed = collapsedGroups.has(from);
  const hadTo = collapsedGroups.has(to);
  if (collapsed) collapsedGroups.add(to); else collapsedGroups.delete(to);
  groupRenames.set(to, from);
  writeCollapsedGroups();
  render();
  try {
    await api('PATCH', '/api/cluster-groups', { from, to });
  } catch (error) {
    if (hadTo) collapsedGroups.add(to); else collapsedGroups.delete(to);
    groupRenames.delete(to);
    writeCollapsedGroups();
    render();
    throw error;
  }
  collapsedGroups.delete(from);
  // Kept only while the selected cluster's remembered group is still the old name (its events not drawn yet).
  if (expandedFor !== `${S.sel.cluster}\n${from}`) groupRenames.delete(to);
  writeCollapsedGroups();
  render();
}

/** A named group's menu (改名, 上移, 下移, 删除); it shares the cluster menu's popup, keys and closing. */
function openGroupMenu(name, trigger) {
  const groups = groupList();
  const at = groups.indexOf(name);
  const items = [{ key: 'rename', label: t('改名') }, { key: 'up', label: t('上移'), off: at <= 0 },
    { key: 'down', label: t('下移'), off: at < 0 || at >= groups.length - 1 }, { key: 'delete', label: t('删除分组') }];
  const menu = h('div', { class: 'cluster-menu', role: 'menu', 'aria-label': t('分组操作：{name}', { name: name }) },
    items.map((i) => h('button', { type: 'button', role: 'menuitem', disabled: i.off, onclick: () => { void groupAction(name, i.key); } }, i.label)));
  showClusterMenu(`group:${name}`, trigger, menu);
}

$('new-group').addEventListener('click', () => groupNameDialog(lt('新建分组'), '', (name) => api('POST', '/api/cluster-groups', { name }),
  t('可以先建空分组，再把群聊拖进来，或用群聊菜单里的“移到分组”。')));

// Dragging a cluster onto a group moves it there. The cluster menu's "移到分组…" does the same without a pointer.
const CLUSTER_DRAG = 'application/x-orrery-cluster';
function dropTarget(name) {
  return {
    ondragover: (event) => {
      if (!event.dataTransfer?.types.includes(CLUSTER_DRAG)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      event.currentTarget.classList.add('drop-target');
    },
    ondragleave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('drop-target'); },
    ondrop: (event) => {
      event.currentTarget.classList.remove('drop-target');
      const id = event.dataTransfer?.getData(CLUSTER_DRAG);
      if (!id) return;
      event.preventDefault();
      void moveToGroup(id, name);
    },
  };
}

function clusterItem(c) {
  const ms = membersOf(c.id);
  const activity = activityOf(ms);
  const unread = unreadOf(c);
  const stalledHere = stalled.forCluster(c.id);
  const stalledLook = stalledBadge(stalledHere, true);
  const stalledTitle = stalledLook.title;
  const trigger = h('button', { type: 'button', class: 'cluster-menu-trigger', 'aria-label': t('群聊操作：{name}', { name: c.name }),
    'aria-haspopup': 'menu', 'aria-expanded': String(clusterMenu?.id === c.id), 'data-cluster-menu': c.id,
    onclick: () => clusterMenu?.id === c.id ? closeClusterMenu(true) : openClusterMenu(c.id, trigger),
    onkeydown: (event) => { if (event.key === 'ArrowDown') { event.preventDefault(); openClusterMenu(c.id, trigger); } } }, icon('more'));
  return h('div', { class: 'cluster-row', draggable: 'true', oncontextmenu: (event) => { event.preventDefault(); openClusterMenu(c.id, trigger); },
    ondragstart: (event) => { event.dataTransfer.setData(CLUSTER_DRAG, c.id); event.dataTransfer.effectAllowed = 'move'; } },
    h('button', {
    type: 'button', class: `cluster-item${c.id === S.sel.cluster ? ' active' : ''}${unread ? ' cluster-unread' : ''}`, onclick: () => select(c.id),
    'aria-current': c.id === S.sel.cluster ? 'true' : null,
  },
  h('span', { class: 'cluster-title' }, h('span', { class: 'name' }, c.name),
    stalledHere.length ? h('span', { class: 'stalled-badge', title: stalledTitle, 'aria-label': stalledTitle }, stalledLook.text) : null,
    unread ? h('span', { class: 'unread-badge', 'aria-label': t('{unread} 条未读', { unread: unread }) }, unreadLabel(unread)) : null),
  h('span', { class: 'sub muted' }, h('span', { class: 'sub-text' }, t('{count} 个群员', { count: ms.length }), activity ? ` · ${activity}` : ''),
    c.lastMessageAt ? relativeTimeEl(c.lastMessageAt, 'rel-time cluster-time') : null)), trigger);
}

/** Pinned, ordinary categories, then the initially collapsed archive. */
function drawClusterList(clusters) {
  const list = $('cluster-list');
  const sections = sidebarSections(clusters, groupList());
  if (!sections.pinned.length && !sections.groups.length && !sections.archived.length) {
    list.replaceChildren(emptyState(t('还没有集群。'), { compact: true }));
    return;
  }
  const groups = sections.groups.map((g) => {
    const open = !collapsedGroups.has(g.name);
    const label = g.name || t(UNGROUPED);
    const activity = open ? '' : activityOf(g.clusters.flatMap((c) => membersOf(c.id)));
    const unread = open ? 0 : g.clusters.reduce((sum, c) => sum + unreadOf(c), 0);
    const menuId = `group:${g.name}`;
    const trigger = g.name ? h('button', { type: 'button', class: 'cluster-menu-trigger group-menu-trigger', 'aria-label': t('分组操作：{label}', { label: label }),
      'aria-haspopup': 'menu', 'aria-expanded': String(clusterMenu?.id === menuId), 'data-cluster-menu': menuId,
      onclick: () => clusterMenu?.id === menuId ? closeClusterMenu(true) : openGroupMenu(g.name, trigger),
      onkeydown: (event) => { if (event.key === 'ArrowDown') { event.preventDefault(); openGroupMenu(g.name, trigger); } } }, icon('more')) : null;
    return h('div', { class: 'group', role: 'group', 'aria-label': label, ...dropTarget(g.name) },
      h('div', { class: 'group-row', oncontextmenu: trigger ? (event) => { event.preventDefault(); openGroupMenu(g.name, trigger); } : null },
        h('button', {
          type: 'button', class: 'group-head', 'aria-expanded': String(open), title: open ? t('折叠「{label}」', { label: label }) : t('展开「{label}」', { label: label }),
          onclick: () => toggleGroup(g.name),
        },
        icon('chevron-down', 'caret'), h('span', { class: 'group-name' }, label),
        activity ? h('span', { class: 'busy' }, activity) : null,
        unread ? h('span', { class: 'unread-badge', 'aria-label': t('{unread} 条未读', { unread: unread }) }, unreadLabel(unread)) : null,
        h('span', { class: 'count' }, String(g.clusters.length))), trigger),
      open ? g.clusters.length ? g.clusters.map(clusterItem) : emptyState(t('空分组：把群聊拖到这里，或用群聊菜单的“移到分组”'), { compact: true }) : null);
  });
  const archivedUnread = sections.archived.reduce((sum, c) => sum + unreadOf(c), 0);
  list.replaceChildren(...[
    sections.pinned.length ? h('section', { class: 'sidebar-section', 'aria-label': t('置顶') },
      h('div', { class: 'sidebar-section-title' }, t('置顶')), sections.pinned.map(clusterItem)) : null,
    ...groups,
    sections.archived.length ? h('section', { class: 'sidebar-section', 'data-archive-group': '', 'aria-label': t('已归档') },
      h('button', { type: 'button', class: 'group-head', 'aria-expanded': String(archiveOpen), onclick: () => {
        archiveOpen = !archiveOpen;
        try { localStorage.setItem(ARCHIVE_OPEN_KEY, archiveOpen ? '1' : '0'); } catch { /* keep the in-memory choice */ }
        render();
      } },
        icon('chevron-down', 'caret'), h('span', { class: 'group-name' }, t('已归档')),
        !archiveOpen && archivedUnread ? h('span', { class: 'unread-badge', 'aria-label': t('{archivedUnread} 条未读', { archivedUnread: archivedUnread }) }, unreadLabel(archivedUnread)) : null,
        h('span', { class: 'count' }, String(sections.archived.length))), archiveOpen ? sections.archived.map(clusterItem) : null) : null,
  ].filter(Boolean));
}

function toggleGroup(name) {
  if (!collapsedGroups.delete(name)) collapsedGroups.add(name);
  writeCollapsedGroups();
  render();
}

// The selected cluster's group opens when it is selected, or moved into another group; collapsing it afterwards sticks.
let expandedFor = null;
// Groups this page renamed: new name -> old name. Renaming the selected cluster's group is not a move into another group.
const groupRenames = new Map();
function expandSelectedGroup() {
  const c = S.clusters.get(S.sel.cluster);
  if (!c) return;
  if (c.archivedAt || c.pinnedAt) { expandedFor = null; return; }
  const name = (c.category ?? '').trim();
  const key = `${c.id}\n${name}`;
  if (key === expandedFor) return;
  const renamed = groupRenames.has(name) && expandedFor === `${c.id}\n${groupRenames.get(name)}`;
  expandedFor = key;
  if (renamed) { groupRenames.delete(name); return; }
  if (collapsedGroups.delete(name)) writeCollapsedGroups();
}

const drawClusters = stableList($('cluster-list'));

function renderSidebar(clusters) {
  drawClusters(clusterListSignature(clusters), () => {
    const focusedId = document.activeElement?.dataset?.clusterMenu;
    drawClusterList(clusters);
    syncClusterMenuAnchor();
    if (focusedId) {
      const target = [...$('cluster-list').querySelectorAll('[data-cluster-menu]')].find((item) => item.dataset.clusterMenu === focusedId);
      (target ?? $('cluster-list').querySelector('[data-archive-group] .group-head'))?.focus({ preventScroll: true });
    }
  });
  $('open-conversations').classList.toggle('active', S.sel.overview);
  if (S.sel.overview) $('open-conversations').setAttribute('aria-current', 'page');
  else $('open-conversations').removeAttribute('aria-current');
  const btn = $('pause');
  btn.setAttribute('aria-pressed', String(S.paused));
  setText($('pause-label'), S.paused ? t('投递已暂停') : t('投递进行中'));
  btn.title = S.paused ? t('点击恢复投递') : t('点击暂停全部投递');
  $('paused-banner').hidden = !S.paused || !S.sel.cluster;
  $('cluster-paused-banner').hidden = !pausedClusters.has(S.sel.cluster);
  $('settings-pause').textContent = S.paused
    ? t('已暂停：不会开始新的轮次，正在跑的轮次会跑完。用左栏底部的开关恢复。')
    : t('投递进行中。左栏底部的开关可以随时暂停全部投递。');
  renderLimits();
}

function renderLimits() {
  $('limits').hidden = !S.settings;
  if (usageAlertStale && S.settings?.usageAlert) {
    usageAlertStale = false;
    $('usage-alert-turn').value = String(S.settings.usageAlert.turnTokens);
    $('usage-alert-conversation').value = String(S.settings.usageAlert.conversationTokens);
  }
  $('notifications').hidden = !S.settings || workbench.coordinatorEnabled?.() === false;
  for (const f of LIMIT_FORMS) {
    const view = limitView(f.setting, S.settings);
    $(f.id).hidden = !view;
    if (!view) continue;
    $(f.id).classList.toggle('unlimited', view.unlimited);
    $(`${f.id}-label`).textContent = view.label;
    $(`${f.id}-source`).textContent = view.source;
    if (f.stale) {
      f.stale = false;
      const limit = S.settings[f.setting];
      $(`${f.id}-value`).value = limit.kind === 'finite' ? String(limit.value) : '';
      $(`${f.id}-unlimited`).checked = limit.kind === 'unlimited';
    }
    $(`${f.id}-value`).disabled = $(`${f.id}-unlimited`).checked;
  }
  for (const f of NOTIFY_FORMS) {
    const view = notifyView(f.setting, S.settings);
    $(f.id).hidden = !view;
    if (!view) continue;
    $(`${f.id}-label`).textContent = view.label;
    $(`${f.id}-source`).textContent = view.source;
    if (f.stale) {
      f.stale = false;
      $(`${f.id}-value`).value = String(view.value);
    }
  }
}

const msgEls = new Map();   // message id -> { el, sig }
let refreshHandoffTargets = null;  // update an open handoff dialog when membership changes

// ---- the header's member panel toggle: up to five stacked avatars + "N 个群员 · M 在线" ----

let toggleSig = null;   // what the toggle shows; its content is redrawn only when this changes

function renderMemberToggle(cluster) {
  const btn = $('members-toggle');
  btn.hidden = !cluster;
  const open = Boolean(panelView());
  btn.setAttribute('aria-expanded', String(open));
  btn.title = open ? t('收起群员面板') : t('打开群员面板：成员页、改名和头像、移出、添加成员');
  const members = cluster ? membersOf(cluster.id) : [];
  const sig = [S.identity, language(), ...members.map((m) => [m.id, statusOf(m)].join('|'))].join('\n');
  if (sig === toggleSig) return;
  toggleSig = sig;
  const counts = memberCounts(members, statusOf);   // hidden members are not counted online (docs/cluster-members.md「隐身」)
  btn.replaceChildren(
    // No names beside these: each avatar's accessible name is the member's (members of one app share the icon).
    h('span', { class: 'member-stack' }, stackedMembers(members).map((m) => avatarEl(m, 'sm', { named: true, presence: presenceOf(m) }))),
    h('span', { class: 'label' }, memberSummary(counts.total, counts.online, counts.hidden)));
}

/** An icon button has no text: the tooltip and the accessible name say what it is. */
function iconLabel(button, text) {
  if (button.title === text) return;
  button.title = text;
  button.setAttribute('aria-label', text);
}

function renderChat() {
  const cid = S.sel.cluster;
  const cluster = S.clusters.get(cid);
  // A jump belongs to the chat it was made in: the overview or another cluster ends it (ui.js nextJump).
  jump = nextJump(jump, { type: 'view', cid: cluster && !S.sel.overview ? cid : null });
  const unsynced = [...messageMetadata.values()].filter((item) => item.clusterId === cid && item.reportedFailure);
  $('message-sync-banner').hidden = !unsynced.length;
  $('message-sync-retry').disabled = !unsynced.some((item) => item.failed && !item.inFlight);
  $('message-sync-retry').textContent = $('message-sync-retry').disabled ? t('正在重试…') : t('重试同步');
  const box = $('messages');
  box.hidden = S.sel.overview;
  $('conversations-view').hidden = !S.sel.overview;
  $('composer').hidden = !cluster;
  $('open-workbench').hidden = !cluster || workbench.tasksEnabled?.() === false;
  if (cluster && problems.asked !== cid) loadProblemsSoon(0);
  const problemCount = cluster && problems.cid === cid ? problems.count : 0;
  $('delivery-problems').hidden = !problemCount;
  $('delivery-problems').dataset.count = problemCount > 99 ? '99+' : problemCount;
  iconLabel($('delivery-problems'), t('有问题的投递 {problemCount}', { problemCount: problemCount }));
  const noMembers = Boolean(cluster && !membersOf(cid).length);
  $('empty-members').hidden = !noMembers;
  setText($('chat-title'), S.sel.overview ? t('全部对话') : cluster ? cluster.name : 'orrery');
  if (cluster && usageFor !== cid) { usageFor = cid; S.usage = null; loadUsageSoon(0); }
  renderCommandRuns(cluster && !S.sel.overview ? cid : null);
  pluginUi.showCluster(cluster && !S.sel.overview ? cid : null);
  setText($('chat-usage'), cluster && S.usage?.clusterId === cid ? clusterUsageText(S.usage) : '');
  renderMemberToggle(cluster);
  renderWindowBar(cluster);
  renderChatFilter(cluster);
  $('chat-search-open').hidden = !cluster || S.sel.overview;
  chatSearch.sync(cluster && !S.sel.overview ? cid : null);

  if (S.sel.overview) {
    if (box.dataset.cluster) { box.replaceChildren(); box.dataset.cluster = ''; }
    renderConversations();
    return;
  }

  if (!cluster) {
    box.dataset.cluster = '';
    box.replaceChildren(S.clusters.size
      ? emptyState(t('从左侧选择一个集群。'))
      : emptyState(t('集群是一个群聊：成员是各家 coding agent 的对话。'),
        { action: h('button', { type: 'button', class: 'primary', onclick: openCreate }, t('新建第一个集群')) }));
    return;
  }
  renderComposer(chat, `c:${cid}`);
  const switched = box.dataset.cluster !== cid;
  if (switched) {
    box.replaceChildren();
    box.dataset.cluster = cid;
  }
  const w = chatWindows.get(cid);
  if (!w || (w.failed && switched)) void loadLatest(cid);   // opened for the first time (or again after a failed read)
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const loaded = S.clusterMsgs.get(cid) ?? [];
  const ids = loaded.filter((id) => chatRowState(S.messages.get(id), chatFilter, jumpExceptionId(jump, cid)) !== 'hidden');
  // A page may add rows at one end and evict them at the other. Anchor to a surviving row, since the change in
  // the total height cannot tell how far a row on screen moved.
  const anchor = w?.anchor && !switched ? chatAnchor(box, ids) : null;
  if (w) w.anchor = false;
  if (!ids.length) {
    const placeholder = !w || w.loading === 'latest' ? t('正在读取消息…')
      : w.failed ? t('读取消息失败。可以切到别的群再回来重试。')
        : loaded.length ? t('已加载的消息里没有符合筛选的。可以在“筛选”里放宽条件。') : t('还没有消息。用 @名字 或 @all 选择接收成员。');
    // Everything loaded is filtered out: the same criteria can still be looked for in the whole history.
    const filtered = !w?.failed && w?.loading !== 'latest' && loaded.length > 0;
    if (box.firstElementChild?.dataset.placeholder !== placeholder) {
      const el = emptyState(placeholder, { action: filtered ? h('button', { type: 'button', class: 'small search-history', onclick: () => chatSearch.open(cid, criteriaFromFilter(chatFilter, cid)) }, t('在全部历史里搜索')) : null });
      el.dataset.placeholder = placeholder;
      box.replaceChildren(el);
    }
  }
  ids.forEach((id, i) => {
    const msg = S.messages.get(id);
    const taskTitles = (msg.taskIds ?? []).map((taskId) => workbench.lookup(msg.clusterId, 'task', taskId));
    // The ids a body references are read once per message; only a message whose references resolved gets rebuilt.
    const refs = taskRefIdsOf.get(msg) ?? taskRefIds(msg.body);
    taskRefIdsOf.set(msg, refs);
    // Deliveries count as one number (msg.rev) instead of being spelled out as JSON for every message on every pass.
    // A handoff's receipt also names who took over, and a reply shows its original: known once that message is read
    // (messageRef reads one that is not loaded).
    let handoffs = '';
    for (const d of msg.deliveries.values()) if (d.handoffMessageId) handoffs += `${messageRef(msg.clusterId, d.handoffMessageId)?.mentions ?? '?'};`;
    const reply = msg.replyTo ? Boolean(messageRef(msg.clusterId, msg.replyTo)) : '';
    const sig = `${S.identity}|${language()}|${S.skillsVersion}|${receiptTimelines.get(id)?.version ?? 0}|${S.handoffs.has(id)}|${msg.rev}|${handoffs}|${reply}|${msg.reads.length}|${msg.acknowledgements.length}|${JSON.stringify([msg.taskIds, pluginSlots.message.map((slot) => slot.key?.(msg))])}|${taskRefs.track(msg.clusterId, refs)}|${chatRowState(msg, chatFilter, jumpExceptionId(jump, cid))}`;
    // Task titles arrive when the workbench loads; they only rename the linked-task buttons, so they are patched in
    // place instead of rebuilding (and re-rendering the Markdown of) every linked message.
    const titles = JSON.stringify(taskTitles);
    let c = msgEls.get(id);
    if (c && c.sig === sig && c.titles !== titles) {
      c.el.querySelectorAll('.message-task-list > button').forEach((button, k) => {
        const taskId = msg.taskIds[k];
        if (taskId) button.textContent = taskTitles[k] ?? t('任务 {value}', { value: taskId.slice(0, 8) });
      });
      c.titles = titles;
    }
    if (!c || c.sig !== sig) {
      const details = c?.el.querySelector('.receipts');
      // Only an open receipt list has a scroll position to keep. Reading scrollTop forces a layout of the whole chat,
      // so asking every rebuilt message for it made a full re-render quadratic (a minute and more with ~1000 messages).
      const list = details?.open ? details.querySelector('.receipt-list') : null;
      const scrollTop = list?.scrollTop;
      const action = details?.contains(document.activeElement) ? document.activeElement.closest('[data-receipt-delivery]')?.dataset.receiptDelivery : null;
      const focused = document.activeElement === details?.querySelector('summary') ? 'summary'
        : document.activeElement === list ? '.receipt-list' : null;
      const slotState = c ? pluginSlots.message.map((slot) => slot.capture?.(c.el)) : [];
      const diff = c?.el.querySelector('.task-diff');
      const diffFocus = diff?.contains(document.activeElement) ? document.activeElement : null;
      const el = buildMessage(msg, details?.open, slotState);
      if (c?.el.isConnected) c.el.replaceWith(el);
      if (list) el.querySelector('.receipt-list').scrollTop = scrollTop;
      if (el.isConnected) {
        if (diffFocus?.isConnected) diffFocus.focus({ preventScroll: true });
        else if (action) (receiptAction(el, action) ?? el.querySelector('summary'))?.focus({ preventScroll: true });
        else if (focused) el.querySelector(focused)?.focus({ preventScroll: true });
        else pluginSlots.message.forEach((slot, i) => slot.restore?.(el, slotState[i]));
      }
      c = { el, sig, titles };
      msgEls.set(id, c);
    }
    // In window order: older messages put in front, a replaced window's messages moved; the leftovers are cut below.
    if (box.children[i] !== c.el) {
      // A kept element coming back (a filter, a jump or another cluster took it out): plugin marks may have changed meanwhile.
      if (!c.el.isConnected) pluginUi.refreshMarksIn(c.el);
      box.insertBefore(c.el, box.children[i] ?? null);
    }
  });
  while (ids.length && box.children.length > ids.length) box.lastChild.remove();
  const toBottom = Boolean(w?.toBottom && !w.loading && ids.length);   // "回到最新" (or the first open) has its window
  if (toBottom) w.toBottom = false;
  if (toBottom) box.scrollTop = box.scrollHeight;
  else if (anchor) box.scrollTop += msgEls.get(anchor.id).el.getBoundingClientRect().top - anchor.top;
  else if (switched || atBottom) box.scrollTop = box.scrollHeight;
  if (jumpPending(jump, cid) && msgEls.get(jump.id)?.el.parentElement === box) {
    const { id, receipts, token } = jump;
    jump = nextJump(jump, { type: 'landed', token });
    const details = receipts ? msgEls.get(id).el.querySelector('.receipts') : null;
    if (details) details.open = true;
    jumpToMessage(id);
  }
  for (const id of openReceipts) if (S.messages.get(id)?.clusterId === cid) loadTimelines(S.messages.get(id));
}

function chatAnchor(box, ids) {
  const top = box.getBoundingClientRect().top;
  for (const id of ids) {
    const el = msgEls.get(id)?.el;
    if (el?.parentElement !== box) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top) return { id, top: rect.top };
  }
  return null;
}

// ---- loading a cluster's messages (the window in chatWindows / S.clusterMsgs) ----

const windowOf = (cid) => chatWindows.get(cid) ?? chatWindows.set(cid, { older: false, live: false, loading: null, pending: null, newer: false, token: 0 }).get(cid);
const messagesPath = (cid, query = '') => `/api/clusters/${encodeURIComponent(cid)}/messages?limit=${PAGE}${query}`;

/**
 * A window's messages with the event seq the Hub read them at. An answer older than what recentEvents still holds could
 * miss updates streamed meanwhile (fillMessages applies them), so it is asked for once more.
 */
// shortcut: one retry; a second answer still older than the ring is taken as it is (a delivery state, read or
// acknowledgement streamed in between may be missing until the window is read again).
async function fetchWindow(path) {
  const answer = await api('GET', path, undefined, true);
  return answer.seq < ringFloor ? api('GET', path, undefined, true) : answer;
}

/** Forgets loaded messages and what was built for them. */
function dropMessages(ids) {
  for (const id of ids) {
    S.messages.delete(id);
    msgEls.delete(id);
    attachEls.delete(id);
    messageDiffViews.delete(id);
    receiptTimelines.delete(id);
    openReceipts.delete(id);
    openTaskLinks.delete(id);
    messageMetadata.delete(id);
    S.handoffs.delete(id);
  }
}

/** Keeps only auxiliary data still referenced by the visible window. */
function pruneMessageRefs(ids) {
  const refs = new Set();
  for (const id of ids) {
    const msg = S.messages.get(id);
    if (msg?.replyTo) refs.add(msg.replyTo);
    for (const d of msg?.deliveries?.values() ?? []) if (d.handoffMessageId) refs.add(d.handoffMessageId);
  }
  for (const id of refMessages.keys()) if (!refs.has(id)) refMessages.delete(id);
  for (const id of S.handoffs) if (!S.messages.has(id) && !refs.has(id)) S.handoffs.delete(id);
}

function forgetWindow(cid) {
  const w = chatWindows.get(cid);
  if (!w) return;
  w.token++;   // an answer from the previous visit must not recreate the window
  chatWindows.delete(cid);
  dropMessages([...(S.clusterMsgs.get(cid) ?? []), ...(w.pending ?? []).map(({ id }) => id)]);
  S.clusterMsgs.delete(cid);
  pruneMessageRefs([]);
  jump = nextJump(jump, { type: 'latest', cid });   // its window is gone, so is the jump into it
}

/**
 * Makes `ids` the cluster's window and ends the request that read it. Messages streamed meanwhile (`pending`) are
 * appended only when newer than the answer and contiguous with it. On a burst, the rolling pending page itself
 * is the latest window, while an older or around read keeps the requested page and the way back to the latest.
 */
function commitWindow(cid, ids, older, live, seq = -Infinity) {
  const w = windowOf(cid);
  const pending = w.pending ?? [];
  const later = pending.filter((event) => event.seq > seq).map(({ id }) => id);
  const gap = w.pendingGapAt > seq;
  let next = ids;
  if (live && gap && w.loading === 'latest') { next = later; older = true; }
  else if (live && gap) live = false;
  else if (live && later.length) next = [...new Set([...ids, ...later])];
  if (next.length > CHAT_WINDOW_LIMIT) older = true;
  next = next.slice(-CHAT_WINDOW_LIMIT);
  const keep = new Set(next);
  dropMessages([...(S.clusterMsgs.get(cid) ?? []), ...ids, ...pending.map(({ id }) => id)].filter((id) => !keep.has(id)));
  S.clusterMsgs.set(cid, next);
  pruneMessageRefs(next);
  const newer = !live && (w.newer || gap || pending.some(({ id }) => !keep.has(id)));
  Object.assign(w, { older, live, newer, pending: null, pendingGapAt: undefined, loading: null, failed: false });
}

/** Reads a cluster's newest messages: its first open, and "回到最新" from an older window. */
async function loadLatest(cid) {
  const w = windowOf(cid);
  if (w.loading === 'latest') return;
  jump = nextJump(jump, { type: 'latest', cid });   // the newest messages replace whatever a jump was heading for
  const token = ++w.token;
  Object.assign(w, { loading: 'latest', pending: w.pending ?? [], failed: false, toBottom: true });
  render();
  try {
    const { data: list, seq } = await fetchWindow(messagesPath(cid));
    if (w.token !== token) return;
    commitWindow(cid, fillMessages(list, seq), list.length === PAGE, true, seq);
  } catch {
    if (w.token !== token) return;
    commitWindow(cid, [...(S.clusterMsgs.get(cid) ?? [])], w.older, w.live);
    w.failed = true;
  } finally {
    render();
  }
}

/** Scrolled to the top: the PAGE messages before the window, put in front of it. */
async function loadOlder(cid) {
  const w = chatWindows.get(cid);
  const ids = S.clusterMsgs.get(cid);
  if (!w?.older || w.loading || !ids?.length || Date.now() - (w.olderFailedAt ?? 0) < 3000) return;
  const token = w.token;
  w.loading = 'older';
  try {
    const { data: list, seq } = await fetchWindow(messagesPath(cid, `&before=${encodeURIComponent(ids[0])}`));
    if (w.token !== token) return;
    const known = new Set(ids);
    const next = [...fillMessages(list, seq).filter((id) => !known.has(id)), ...S.clusterMsgs.get(cid)];
    S.clusterMsgs.set(cid, next.slice(0, CHAT_WINDOW_LIMIT));
    if (next.length > CHAT_WINDOW_LIMIT) {
      dropMessages(next.slice(CHAT_WINDOW_LIMIT));
      pruneMessageRefs(S.clusterMsgs.get(cid));
      w.live = false;
    }
    w.older = list.length === PAGE;
    w.anchor = true;
  } catch {
    w.olderFailedAt = Date.now();   // the next scroll at the top asks again, not every scroll event
  } finally {
    if (w.token === token) w.loading = null;
    render();
  }
}

/** Scrolled to the bottom of an older window: the PAGE messages after it; reaching the newest makes the window live. */
async function loadNewer(cid) {
  const w = chatWindows.get(cid);
  const ids = S.clusterMsgs.get(cid);
  if (!w || w.live || w.loading || !ids?.length || Date.now() - (w.newerFailedAt ?? 0) < 3000) return;
  const token = w.token;
  Object.assign(w, { loading: 'newer', pending: [], pendingGapAt: undefined });
  try {
    const { data: list, seq } = await fetchWindow(messagesPath(cid, `&after=${encodeURIComponent(ids.at(-1))}`));
    if (w.token !== token) return;
    const known = new Set(ids);
    commitWindow(cid, [...ids, ...fillMessages(list, seq).filter((id) => !known.has(id))], w.older, list.length < PAGE, seq);
    w.anchor = true;
  } catch {
    if (w.token !== token) return;
    commitWindow(cid, [...ids], w.older, false);
    w.newerFailedAt = Date.now();
  } finally {
    render();
  }
}

let jumpTokens = 0;   // each jump's own token (ui.js nextJump)

/**
 * Shows message `id` of cluster `cid`, wherever it is: in the loaded window, or else in a window read around it (then
 * "回到最新" goes back to the newest messages). `receipts` opens its receipt list. The jump lets its target through the
 * chat filter until it ends (ui.js nextJump); a jump ended while the read was out leaves the chat's window as it was.
 */
async function openMessage(cid, id, { receipts = false } = {}) {
  if (S.sel.cluster !== cid || S.sel.member || S.sel.overview) select(cid);
  const jumpToken = ++jumpTokens;
  jump = nextJump(jump, { type: 'open', cid, id, receipts, token: jumpToken });
  if ((S.clusterMsgs.get(cid) ?? []).includes(id)) return render();
  const w = windowOf(cid);
  const token = ++w.token;
  Object.assign(w, { loading: 'around', pending: w.pending ?? [], toBottom: false });
  const keep = () => {
    const previous = S.clusterMsgs.get(cid);
    if (previous) commitWindow(cid, [...previous], w.older, w.live);
    else forgetWindow(cid);   // a provisional window is not an empty chat; renderChat will load the latest messages
  };
  try {
    const { data: list, seq } = await fetchWindow(messagesPath(cid, `&around=${encodeURIComponent(id)}`));
    if (w.token !== token) return;
    const at = list.findIndex((m) => m.id === id);
    if (!jumpCurrent(jump, jumpToken)) return keep();   // cancelled meanwhile (filter, another jump): nothing more happens
    jump = nextJump(jump, { type: 'answer', token: jumpToken, found: at >= 0 });
    if (at < 0) { keep(); noticeDialog(lt('读不到这条消息：它不在这个群的记录里。'), lt('无法跳转')); return; }
    // Asked for PAGE / 2 older and PAGE - PAGE / 2 - 1 newer: fewer means that end of the cluster was reached.
    commitWindow(cid, fillMessages(list, seq), at >= PAGE / 2, list.length - at - 1 < PAGE - PAGE / 2 - 1, seq);
  } catch (e) {
    if (w.token !== token) return;
    const current = jumpCurrent(jump, jumpToken);
    jump = nextJump(jump, { type: 'failed', token: jumpToken });
    keep();
    if (current) noticeDialog(lt('读不到这条消息：{message}', { message: e.message }), lt('无法跳转'));
  } finally {
    render();
  }
}

// The bar above the composer while an older window is shown: back to the newest messages.
$('message-window-latest').addEventListener('click', () => { if (S.sel.cluster) void loadLatest(S.sel.cluster); });
function renderWindowBar(cluster) {
  const w = cluster && !S.sel.overview ? chatWindows.get(cluster.id) : null;
  const shown = Boolean(w && !w.live && (S.clusterMsgs.get(cluster.id) ?? []).length);
  if ($('message-window').hidden === shown) $('message-window').hidden = !shown;
  if (shown) setText($('message-window-text'), w.newer ? t('有新消息。') : t('正在查看较早的消息。'));
  const older = w?.loading === 'older';
  if ($('messages').classList.contains('loading-older') !== older) $('messages').classList.toggle('loading-older', older);
}

$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  const cid = box.dataset.cluster;
  if (!cid || cid !== S.sel.cluster || chatWindows.get(cid)?.anchor) return;
  if (box.scrollTop < 400) void loadOlder(cid);
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) void loadNewer(cid);
}, { passive: true });

// ---- one message the page may not hold: a reply's original, a handoff's new message, a member page line's ----

const refMessages = new Map();   // message id -> message, null when it cannot be read, or the Promise of the read

/** Message `id` (of cluster `cid`), read by id once when it is not loaded. */
function loadMessageRef(cid, id) {
  const known = S.messages.get(id) ?? refMessages.get(id);
  if (known !== undefined) return Promise.resolve(known);
  const read = api('GET', `/api/clusters/${encodeURIComponent(cid)}/messages/${encodeURIComponent(id)}`)
    .catch(() => null)
    .then((m) => { if (refMessages.get(id) === read) refMessages.set(id, m); return m; });
  refMessages.set(id, read);
  return read;
}

/** The message if it is at hand now, else null; one not read yet is read, and the page redrawn when it arrives. */
function messageRef(cid, id) {
  const known = S.messages.get(id) ?? refMessages.get(id);
  if (known === undefined && cid && id) loadMessageRef(cid, id).then(render);
  return known instanceof Promise ? null : known ?? null;
}

// ---- the header's count of deliveries with problems (GET /api/clusters/:id/delivery-problems) ----

const problems = { asked: null, cid: null, count: 0, timer: null, request: 0 };
/** Asks again after a delivery or message event of the shown cluster; several events in a second make one request. */
function loadProblemsSoon(delay = 1000) {
  if (!problems.timer) problems.timer = setTimeout(loadProblems, delay);
}
async function loadProblems() {
  problems.timer = null;
  const cid = S.sel.cluster;
  if (!cid || S.sel.overview) return;
  problems.asked = cid;
  const request = ++problems.request;
  try {
    const { count } = await api('GET', `/api/clusters/${encodeURIComponent(cid)}/delivery-problems?limit=1`);
    if (request !== problems.request) return;
    Object.assign(problems, { cid, count });
    render();
  } catch { /* keep the last count; the next event or reconnect asks again */ }
}

const drawConversations = stableList($('conversation-list'));

// ---- 全部对话: the list or the matrix (conversation-matrix.js); the choice is remembered in this browser ----
let conversationsView = (() => { try { return viewFromStored(localStorage.getItem(CONVERSATIONS_VIEW_KEY)); } catch { return 'list'; } })();
let matrixArchived = false;
const narrowScreen = matchMedia('(max-width: 600px)');
narrowScreen.addEventListener('change', () => render());
function setConversationsView(view) {
  conversationsView = viewFromStored(view);
  try { localStorage.setItem(CONVERSATIONS_VIEW_KEY, conversationsView); } catch { /* remembered for this page only */ }
  render();
}
$('conversations-list-view').addEventListener('click', () => setConversationsView('list'));
$('conversations-matrix-view').addEventListener('click', () => setConversationsView('matrix'));
$('matrix-archived').addEventListener('change', (event) => { matrixArchived = event.target.checked; render(); });

function renderConversations() {
  const matrix = conversationsView === 'matrix' && !narrowScreen.matches;
  $('conversations-list-view').setAttribute('aria-pressed', String(conversationsView === 'list'));
  $('conversations-matrix-view').setAttribute('aria-pressed', String(conversationsView === 'matrix'));
  $('matrix-narrow-hint').hidden = !(conversationsView === 'matrix' && narrowScreen.matches);
  $('conversations-list-intro').hidden = matrix;
  $('conversations-matrix-intro').hidden = !matrix;
  if (matrix) return renderMatrix();
  $('matrix-archived-label').hidden = true;
  const rows = conversations([...S.members.values()].filter((member) => S.clusters.has(member.clusterId)), [...S.clusters.values()]);
  const cards = rows.map((row) => {
    const picked = conversationActivity(row.memberships, S.activity);
    return { row, group: picked?.membership.clusterName ?? null, summary: activitySummary(picked?.snapshot, S.activityFailed),
      lastAt: row.memberships.map((m) => S.clusters.get(m.clusterId)?.lastMessageAt ?? null) };
  });
  drawConversations(`list:${JSON.stringify(cards)}`, () => {
    const list = $('conversation-list');
    const active = document.activeElement;
    const focusedMember = list.contains(active) ? active.closest('[data-conversation-member]')?.dataset.conversationMember : null;
    const items = cards.map(({ row, group, summary, lastAt }) => {
      const groups = row.memberships.map((m, i) => h('button', {
        type: 'button', class: 'conversation-group', title: t('打开 {clusterName} 中的 {memberName}', { clusterName: m.clusterName, memberName: m.memberName }),
        'data-conversation-member': m.memberId,
        onclick: () => select(m.clusterId, m.memberId),
      }, h('span', { class: 'conversation-group-name' }, m.clusterName), h('span', { class: 'muted' }, t('群内名：{memberName}', { memberName: m.memberName })),
      lastAt[i] ? relativeTimeEl(lastAt[i]) : null));
      return h('li', { class: 'conversation-row' },
        h('div', { class: 'conversation-identity' },
          h('div', { class: 'conversation-kind' }, h('strong', {}, row.harness)),
          h('span', { class: 'conversation-session' }, t('会话 ID：{value}', { value: row.sessionId ?? t('不可用') })),
          activityEl(summary, group)),
        h('div', { class: 'conversation-groups' }, groups));
    });
    list.replaceChildren(rows.length
      ? h('ul', { class: 'conversation-list' }, items)
      : emptyState(t('还没有加入集群的对话。可以新建集群或向已有集群添加成员。')));
    if (focusedMember) {
      const replacement = [...list.querySelectorAll('[data-conversation-member]')].find((el) => el.dataset.conversationMember === focusedMember);
      (replacement ?? list).focus({ preventScroll: true });
    }
  });
}

/** The latest observed activity of a membership (GET /api/activity, already loaded for this page), or null. */
function memberActivityAt(m) {
  const at = S.activity.get(m.id)?.lastActivityAt;
  return at && Number.isFinite(Date.parse(at)) ? at : null;
}

/** A row group's app icon: the app's own icon (src/web/public/app-icons), else, for a harness the page does not know, a neutral badge with the first letter (the name follows as text). */
function appIcon(group) {
  return group.icon ? h('img', { class: 'app-icon', src: group.icon, alt: '', 'aria-hidden': 'true' })
    : h('span', { class: 'app-icon app-icon-letter', 'aria-hidden': 'true' }, ([...group.label][0] ?? '?').toUpperCase());
}

/** The matrix: conversations (rows) × clusters (columns), redrawn only when its model changes. */
function renderMatrix() {
  const clusters = [...S.clusters.values()];
  const model = conversationMatrix({ members: [...S.members.values()], clusters, groups: groupList(),
    coordinators: Object.fromEntries(S.coordinators), statusOf, activityAt: memberActivityAt, showArchived: matrixArchived });
  const archivedCount = clusters.filter((c) => c.archivedAt).length;
  $('matrix-archived-label').hidden = !archivedCount;
  $('matrix-archived').checked = matrixArchived;
  setText($('matrix-archived-count'), String(archivedCount));
  drawConversations(`matrix:${JSON.stringify(model)}`, () => {
    const list = $('conversation-list');
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.matrixKey : null;
    if (!model.columns.length) {
      list.replaceChildren(emptyState(clusters.length
        ? t('没有可显示的群：已归档的群默认不显示，可以勾选上面的“显示已归档的群”。')
        : t('还没有集群。新建集群并添加群员后，这里会按对话和群列出每个对话在哪些群里。')));
      return;
    }
    if (!model.rowCount) {
      list.replaceChildren(emptyState(t('这些群里还没有群员。向群里添加成员后，这里会显示每个对话加入了哪些群。')));
      return;
    }
    const span = model.columns.length + 1;
    const groupRow = h('tr', { class: 'matrix-col-groups' }, h('th', { class: 'matrix-corner', scope: 'col', rowspan: '2' }, t('对话 ＼ 群')),
      model.columnGroups.map((g) => h('th', { scope: 'colgroup', colspan: String(g.columns.length), class: 'matrix-col-group', title: g.name }, g.name)));
    const clusterRow = h('tr', { class: 'matrix-cols' }, model.columns.map((c) => h('th', { scope: 'col', class: 'matrix-col' },
      h('button', { type: 'button', class: 'matrix-col-button', 'data-matrix-key': `col:${c.id}`, title: t('打开群“{name}”', { name: c.name }), onclick: () => select(c.id) },
        h('span', { class: 'matrix-col-name' }, c.name, c.archived ? h('span', { class: 'muted' }, t('（已归档）')) : null),
        h('span', { class: 'muted matrix-col-count' }, t('{memberCount} 人 · {onlineCount} 在线{value}', { memberCount: c.memberCount, onlineCount: c.onlineCount, value: c.hiddenCount ? t(' · {hiddenCount} 隐身', { hiddenCount: c.hiddenCount }) : '' }))))));
    const body = model.rowGroups.flatMap((g) => [
      h('tr', { class: 'matrix-row-group' }, h('th', { scope: 'rowgroup', colspan: String(span) },
        h('span', { class: 'matrix-row-group-name' }, appIcon(g), g.label, h('span', { class: 'muted' }, ` ${g.rows.length}`)))),
      ...g.rows.map((r) => h('tr', {},
        h('th', { scope: 'row', class: 'matrix-row-head', title: r.sessionId ? t('会话 ID：{sessionId}', { sessionId: r.sessionId }) : '' },
          h('span', { class: 'matrix-row-title' }, r.label),
          r.cwd ? h('span', { class: 'matrix-row-project muted', title: t('项目（工作目录）：{cwd}', { cwd: r.cwd }) }, projectName(r.cwd)) : null,
          h('span', { class: 'matrix-row-meta muted' }, harnessApp(r.harness).name,
            h('span', { class: `matrix-status ${r.status}` }, h('span', { class: `status-dot ${r.status}`, 'aria-hidden': 'true' }), STATUS_WORD[r.status]),
            r.lastActivityAt ? relativeTimeEl(r.lastActivityAt) : h('span', {}, t('暂无活动')))),
        model.columns.map((c) => {
          const cell = r.cells[c.id];
          if (!cell) return h('td', { class: 'matrix-empty' });
          return h('td', {}, h('button', { type: 'button', class: `matrix-cell ${cell.status}`, 'data-matrix-key': `cell:${cell.memberId}`,
            title: t('打开 {name} 中的 {name2}（{value}{value2}{value3}）', { name: c.name, name2: cell.name, value: STATUS_WORD[cell.status], value2: cell.coordinator ? t('，协调员') : '', value3: cell.hidden ? t('，隐身中') : '' }), onclick: () => select(c.id, cell.memberId) },
          h('span', { class: 'matrix-cell-name' }, cell.name),
          h('span', { class: 'matrix-cell-status' }, h('span', { class: `status-dot ${cell.status}`, 'aria-hidden': 'true' }), STATUS_WORD[cell.status]),
          cell.coordinator ? h('span', { class: 'matrix-coordinator' }, t('协调员')) : null,
          cell.hidden ? hiddenMark() : null));
        }))),
    ]);
    // The same scroll box across redraws, so a live update keeps where the user scrolled to.
    mountKeepingScroll(list, () => h('div', { class: 'matrix-scroll', tabindex: '0', role: 'region', 'aria-label': t('对话与群的矩阵') }),
      h('table', { class: 'matrix' }, h('thead', {}, groupRow, clusterRow), h('tbody', {}, body)));
    if (focused) list.querySelector(`[data-matrix-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  });
}

function buildMessage(msg, receiptsOpen = false, slotState = []) {
  const system = isSystemMessage(msg);
  const plugin = msg.kind === 'plugin';
  const legacy = parseLegacyTaskNotice(msg);
  const failure = shipFailureNotice(msg);
  const body = failure ?? (legacy ? legacy.action === 'task.create' ? t('任务【{taskTitle}】已创建，事件 {eventId}。', { taskTitle: legacy.taskTitle, eventId: legacy.eventId })
    : legacy.action === 'task.edit' ? t('任务【{taskTitle}】已更新，事件 {eventId}。', { taskTitle: legacy.taskTitle, eventId: legacy.eventId })
      : t('{actionLabel}：任务【{taskTitle}】，事件 {eventId}。', { actionLabel: legacy.actionLabel, taskTitle: legacy.taskTitle, eventId: legacy.eventId }) : msg.body);
  const from = msg.from === 'user' || system || plugin ? null : S.members.get(msg.from);
  const reply = msg.replyTo && messageRef(msg.clusterId, msg.replyTo);
  const deliveries = [...msg.deliveries.values()];
  const receipts = splitReceiptMembers(msg, deliveries, msg.reads, msg.acknowledgements);
  const noticeLine = recordOnlyNotice(msg, deliveries, msg.reads, msg.acknowledgements, nameOf);
  const recipients = unwrittenRecipients(msg, S.members, S.handoffs);
  const mark = systemMark(msg);
  const jumped = chatRowState(msg, chatFilter, jumpExceptionId(jump, msg.clusterId)) === 'jump';
  return h('article', { class: `msg ${system ? 'system' : plugin ? 'plugin-message' : from ? 'agent' : 'user'}${mark ? ` notice-${mark.level}` : ''}`, tabindex: '-1' },
    system ? systemAvatar() : plugin ? h('span', { class: 'avatar plugin-avatar', 'aria-hidden': 'true' }, t('插件')) : from ? avatarEl(from) : userAvatar(),
    h('div', {},
      h('div', { class: 'msg-head' },
        h('span', { class: `who${from ? ' link' : ''}`, onclick: from ? () => select(msg.clusterId, from.id) : null }, messageName(msg)),
        // Not colour alone: an icon and a word say it is a warning, and which level.
        mark ? h('span', { class: `notice-mark ${mark.level}` }, h('span', { class: 'notice-icon', role: 'img', 'aria-label': t('警告') }, mark.level === 'problem' ? icon('ban', 'ico-sm') : icon('alert', 'ico-sm')), mark.label) : null,
        h('span', { class: 'time', title: msg.createdAt }, fmtTime(msg.createdAt)),
        reply ? h('span', { class: 'reply', title: reply.body }, icon('reply', 'ico-sm'), t(' 回复 {value}：{value2}', { value: messageName(reply), value2: snippet(reply.body, 24) })) : null),
      recipients.length ? h('div', { class: 'msg-recipients' }, recipients.map((id) =>
        h('span', { class: 'mention link', title: t('查看 {value}', { value: nameOf(id) }), onclick: () => select(msg.clusterId, id) }, `@${nameOf(id)}`))) : null,
      body ? h('div', { class: 'msg-body' }, legacy || failure || plainTextRecord(msg) ? body : mdBlocks(markdownBlocks(body), msg)) : null,
      pluginUi.marksSlot(msg.clusterId, 'message', msg.id, 2),
      jumped ? h('div', { class: 'jump-shown' }, t('因跳转显示：当前的“筛选”会隐藏这条消息，改动筛选或切换群后不再显示。')) : null,
      messageTaskDiff(msg, legacy, failure),
      msg.attachments.length ? attachmentsEl(msg) : null,
      noticeLine ? h('div', { class: 'record-only' }, noticeLine) : null,
      receipts.recipients.length || receipts.readOnly.length ? receiptsEl(msg, receipts, receiptsOpen) : null,
      messageCollaboration(msg, slotState)));
}

/** The chat's message filter (ui.js chatShowsMessage), remembered per browser; unreadable storage means show everything. */
let chatFilter = readChatFilter();
function readChatFilter() {
  try { return chatFilterFromStored(localStorage.getItem(CHAT_FILTER_KEY)); } catch { return CHAT_FILTER_DEFAULT; }
}
function writeChatFilter() {
  try { localStorage.setItem(CHAT_FILTER_KEY, JSON.stringify(chatFilter)); } catch { /* forget the choice */ }
}

/**
 * The 筛选 control: only warnings, only one sender's messages (per cluster), and which system message categories show.
 * Built once; its state redrawn each pass. The warning badge (chat-search.js warningBadge) shows the loaded warnings the
 * filter hides in the current window, and the hidden warnings streamed in since the panel was last closed or the filter
 * changed, per cluster: in an older window those are not loaded, so they are counted apart. Each arrival is announced.
 */
const arrivedWarnings = new Map();   // clusterId -> hidden warnings streamed in since the user last looked
function renderChatFilter(cluster) {
  $('chat-filter').hidden = !cluster || S.sel.overview;
  const panel = $('chat-filter-panel');
  if (!panel.childElementCount) {
    const option = (key, label) => h('label', { class: 'chat-filter-option' },
      h('input', { type: 'checkbox', 'data-filter': key, onchange: (e) => setChatFilter(key, e.target.checked) }), label);
    panel.append(option('warningsOnly', t('只看警告（问题和提醒）')),
      h('label', { class: 'chat-filter-sender' }, h('span', { class: 'chat-filter-group' }, t('只看谁的发言')),
        h('select', { 'data-filter-sender': '', onchange: (e) => setChatSender(e.target.value) })),
      h('div', { class: 'chat-filter-group' }, t('显示的系统消息')),
      ...SYSTEM_CATEGORIES.map((category) => option(category, t(SYSTEM_CATEGORY_LABELS[category]))),
      h('p', { class: 'chat-filter-hidden', hidden: true }),
      h('button', { type: 'button', class: 'small chat-filter-search', onclick: () => {
        $('chat-filter').open = false;
        chatSearch.open(S.sel.cluster, criteriaFromFilter(chatFilter, S.sel.cluster));
      } }, t('在全部历史里搜索')));
  }
  if (!cluster) return;
  const cid = cluster.id;
  for (const input of panel.querySelectorAll('input[data-filter]')) {
    const key = input.dataset.filter;
    input.checked = key === 'warningsOnly' ? chatFilter.warningsOnly : !chatFilter.hide.includes(key);
    input.disabled = key !== 'warningsOnly' && chatFilter.warningsOnly;
  }
  // The sender list: you, the system, and every member by identity, removed ones too; a member gone from it is forgotten.
  const choices = senderChoices(S.members.values(), cid, (harness) => harnessApp(harness).name);
  const select = panel.querySelector('select[data-filter-sender]');
  const sig = `${cid}|${JSON.stringify(choices)}`;
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.replaceChildren(h('option', { value: '' }, t('所有人')), ...FIXED_SENDERS.map((s) => h('option', { value: s.value }, s.label)),
      ...choices.map((c) => h('option', { value: c.value }, c.label)));
  }
  const sender = chatFilter.senders[cid];
  if (sender && !FIXED_SENDERS.some((s) => s.value === sender) && !choices.some((c) => c.value === sender)
    && [...S.members.values()].some((m) => m.clusterId === cid)) {
    const { [cid]: _gone, ...senders } = chatFilter.senders;
    chatFilter = { ...chatFilter, senders };
    arrivedWarnings.delete(cid);   // what this cluster's filter hides changed
    writeChatFilter();
  }
  select.value = chatFilter.senders[cid] ?? '';
  const count = chatFilterCount(chatFilter, cid);
  $('chat-filter-count').hidden = !count;
  setText($('chat-filter-count'), count ? ` · ${count}` : '');
  const view = warningBadge(hiddenWarnings((S.clusterMsgs.get(cid) ?? []).map((id) => S.messages.get(id)), chatFilter, jumpExceptionId(jump, cid)),
    arrivedWarnings.get(cid) ?? 0);
  const badge = $('chat-filter-warnings');
  badge.hidden = !view.shown;
  badge.classList.toggle('new', view.fresh);
  setText(badge.querySelector('.chat-filter-warnings-text'), view.text);   // after the alert icon and the words 警告 (index.html)
  badge.title = view.title;
  const note = panel.querySelector('.chat-filter-hidden');
  note.hidden = !view.shown;
  setText(note, view.note);
}
function setChatFilter(key, checked) {
  chatFilter = key === 'warningsOnly' ? { ...chatFilter, warningsOnly: checked }
    : { ...chatFilter, hide: checked ? chatFilter.hide.filter((category) => category !== key) : [...chatFilter.hide, key] };
  arrivedWarnings.clear();   // these switches apply to every cluster: earlier arrivals no longer say anything about any of them
  filterChanged();
}
function setChatSender(sender) {
  const { [S.sel.cluster]: _old, ...senders } = chatFilter.senders;
  chatFilter = { ...chatFilter, senders: sender ? { ...senders, [S.sel.cluster]: sender } : senders };
  arrivedWarnings.delete(S.sel.cluster);   // this cluster's choice only: the others' arrivals still stand
  filterChanged();
}
function filterChanged() {
  jump = nextJump(jump, { type: 'filter' });   // a filter the user just chose applies to every message again; a jump still loading is dropped
  writeChatFilter();
  renderChat();
}
/** A streamed warning the filter hides: counted as arrived for its cluster, and announced in the chat being read. */
function hiddenWarningArrived(m) {
  if (!hiddenWarnings([m], chatFilter)) return;
  const count = (arrivedWarnings.get(m.clusterId) ?? 0) + 1;
  arrivedWarnings.set(m.clusterId, count);
  if (m.clusterId === S.sel.cluster && !S.sel.overview) setText($('chat-filter-live'), t('筛选隐藏了 {count} 条新到的警告。', { count: count }));
}
$('chat-filter').addEventListener('toggle', () => {
  // Closing the panel after it showed them: the arrivals are seen, no longer new.
  if ($('chat-filter').open || !arrivedWarnings.has(S.sel.cluster)) return;
  arrivedWarnings.delete(S.sel.cluster);
  renderChatFilter(S.clusters.get(S.sel.cluster));
});

/** The history search sheet (chat-search.js); it jumps to a result through openMessage. */
const chatSearch = createChatSearch({
  api,
  members: () => S.members.values(),
  appName: (harness) => harnessApp(harness).name,
  openMessage: (cid, id) => void openMessage(cid, id),
  narrow: () => matchMedia('(max-width: 900px)').matches,
  onToggle: (open, hadFocus) => {
    $('chat-search-open').setAttribute('aria-expanded', String(open));
    if (!open && hadFocus) $('chat-search-open').focus();
  },
});
$('chat-search-open').addEventListener('click', () => {
  if ($('chat-search-open').getAttribute('aria-expanded') === 'true') chatSearch.close();
  else chatSearch.open(S.sel.cluster);
});

/** Related-task rows the reader expanded, by message id: page memory only, survives message re-renders. */
const openTaskLinks = new Set();
const taskRefIdsOf = new WeakMap();   // message object -> the task ids its body references
const messageDiffViews = new Map();

function messageTaskDiff(msg, legacy, failure = shipFailureNotice(msg)) {
  if (workbench.tasksEnabled?.() === false) return null;   // old messages keep their taskIds, but the task routes are gone
  if (!legacy && (!msg.taskIds?.length || (!failure && !isTaskChangeNotice(msg)))) return null;
  let view = messageDiffViews.get(msg.id);
  if (!view) {
    const cid = msg.clusterId;
    const load = async () => {
      let lastError;
      for (const taskId of msg.taskIds ?? []) {
        try {
          const event = await api('GET', `/api/clusters/${encodeURIComponent(cid)}/tasks/${encodeURIComponent(taskId)}/events/${msg.collabEventId}`);
          if (event.taskId === taskId && event.eventId === msg.collabEventId
            && (!failure || event.action === 'task.ship_failed')) return event;
        } catch (error) { lastError = error; }
      }
      throw lastError ?? new Error('task event unavailable');
    };
    view = failure ? createShipFailureView({ load })
      : createTaskDiffView({ legacy: Boolean(legacy), resolve: (kind, id) => workbench.lookup(cid, kind, id), load });
    messageDiffViews.set(msg.id, view);
  }
  return view;
}

function messageCollaboration(msg, slotState = []) {
  const entries = pluginSlots.message.map((slot, i) => slot.render(msg, slotState[i]));
  // Several related tasks used to spread over many lines under the message. They now collapse into one
  // details row (native click and Enter/Space); an expanded row keeps its state when the message is redrawn.
  const tasks = workbench.tasksEnabled?.() === false ? [] : msg.taskIds ?? [];
  if (!tasks.length) openTaskLinks.delete(msg.id);
  const taskLinks = tasks.length ? h('details', { class: 'message-task-links', open: openTaskLinks.has(msg.id),
    ontoggle: (event) => {
      if (S.messages.get(msg.id) !== msg) return;
      if (event.target.open) openTaskLinks.add(msg.id); else openTaskLinks.delete(msg.id);
    } },
  h('summary', {}, t('关联任务 {count}', { count: tasks.length })),
  h('div', { class: 'message-task-list' }, tasks.map((id) => h('button', { type: 'button', class: 'small',
    onclick: () => workbench.openTask(msg.clusterId, id) }, workbench.lookup(msg.clusterId, 'task', id) ?? t('任务 {value}', { value: id.slice(0, 8) }))))) : null;
  // The link/unlink entry stays outside the fold, so it is reachable while the row is collapsed.
  const linkButton = workbench.tasksEnabled?.() === false ? null : h('button', { type: 'button', class: 'small', onclick: () => workbench.linkMessage(msg.clusterId, msg) }, t('关联任务'));
  return h('div', { class: 'message-collaboration' }, entries, taskLinks, linkButton);
}

// A delivery's timeline (docs/native-mode.md) is fetched when its receipt panel opens, and again when what it depends on
// changes. Message rebuilds only read this cache.
const receiptTimelines = new Map();   // message id -> { key, items: Map<delivery id, timeline>, version, loading, failed }
const openReceipts = new Set();       // message ids whose receipt panel is open

const timelineKey = (msg) => JSON.stringify([...msg.deliveries.values()].map((d) => {
  const member = S.members.get(d.memberId);
  return [d.id, d.state, d.outcome, d.updatedAt, d.handoffMessageId, member && statusOf(member)];
}).concat([msg.acknowledgements.length, S.paused, pausedClusters.has(msg.clusterId)]));

function loadTimelines(msg) {
  const key = timelineKey(msg);
  const entry = receiptTimelines.get(msg.id) ?? { key: null, items: new Map(), version: 0, loading: false, failed: false };
  receiptTimelines.set(msg.id, entry);
  if (entry.loading || entry.key === key) return;
  entry.loading = true;
  entry.key = key;
  api('GET', `/api/clusters/${encodeURIComponent(msg.clusterId)}/messages/${encodeURIComponent(msg.id)}/delivery-timelines`)
    .then(({ timelines }) => { entry.items = new Map(timelines.map((t) => [t.deliveryId, t])); entry.failed = false; })
    .catch(() => { entry.failed = true; })
    .finally(() => { entry.loading = false; entry.version++; render(); });
}

function receiptsToggled(msg, open) {
  if (S.messages.get(msg.id) !== msg) return;
  if (!open) { openReceipts.delete(msg.id); return; }
  if (openReceipts.has(msg.id)) return;   // redrawing an open panel fires 'toggle' too
  openReceipts.add(msg.id);
  const entry = receiptTimelines.get(msg.id);
  if (entry) entry.key = null;   // opened again: the answer may be old even if nothing visible changed
  loadTimelines(msg);
}

function receiptDiagnosis(timeline) {
  const advice = deliveryAdvice(timeline);
  return h('div', { class: 'receipt-diagnosis' },
    h('div', {}, h('strong', {}, t('当前阶段：{stage}', { stage: advice.stage }))),
    h('div', {}, advice.reason),
    h('div', {}, t('下一步：{next}', { next: advice.next })),
    h('ol', { class: 'receipt-timeline' }, timeline.stages.map((stage) => {
      const view = timelineStageView(stage);
      return h('li', { class: `stage-${stage.status}` }, h('span', {}, view.label), h('span', { title: stage.at ?? '' }, view.value),
        stage.reason ? h('span', { class: 'receipt-error' }, t('原因：{reason}', { reason: stage.reason })) : null);
    })),
    timeline.batchId ? h('div', { class: 'muted' }, t('批次 {value}', { value: timeline.batchId.slice(0, 8) })) : null);
}

function resendAction(msg, d, timeline) {
  if (!timeline?.resend) return null;
  return [h('button', { type: 'button', class: 'receipt-action', 'data-receipt-delivery': `${d.id}:resend`, disabled: !timeline.resend.available,
    onclick: () => openResend(msg, d, timeline) }, t('重发给该成员')),
  timeline.resend.available ? null : h('span', { class: 'receipt-blocked' }, resendBlockedText(timeline.resend.blockedBy))];
}

function receiptsEl(msg, groups, open) {
  const { recipients, readOnly } = groups;
  const all = [...recipients, ...readOnly];
  const retrieved = all.filter((r) => r.read?.via === 'read_messages').length;
  const acknowledged = all.filter((r) => r.acknowledgement).length;
  const problems = recipients.filter((r) => r.delivery && deliveryProblem(r.delivery)).length;
  const timelines = receiptTimelines.get(msg.id);
  const receiptRow = (r, isRecipient) => {
    const d = r.delivery;
    const look = d && deliveryView(d);
    const timeline = d && timelines?.items.get(d.id);
    const handoff = d?.handoffMessageId && messageRef(msg.clusterId, d.handoffMessageId);
    const target = handoff?.mentions?.[0];
    const fyiStatus = isRecipient && !d
      ? h('span', { class: 'receipt-fyi' }, r.read || r.acknowledgement ? t('仅知会，已读') : t('仅知会，未读')) : null;
    const ackNode = (!isRecipient || d || r.read || r.acknowledgement)
      ? (r.acknowledgement
        ? h('span', { title: r.acknowledgement.at }, icon('thumb', 'ico-sm'), t(' 主动确认 {value}', { value: new Date(r.acknowledgement.at).toLocaleString(language() === 'en' ? 'en-US' : 'zh-CN') }))
        : h('span', {}, t('尚未主动确认')))
      : null;
    return h('div', { class: 'receipt-row' },
      h('span', { class: 'receipt-name' }, nameOf(r.memberId)),
      h('div', { class: 'receipt-status' },
        d ? h('span', { class: `receipt-delivery ${d.outcome ?? d.state}` }, icon(look.icon, 'ico-sm'), ` ${look.label}`) : fyiStatus,
        r.read?.via === 'read_messages' ? h('span', {}, t('已取回')) : null,
        r.read && !r.read.via ? h('span', {}, t('读取记录（来源未知）')) : null,
        ackNode,
        d?.error && !timeline ? h('span', { class: 'receipt-error' }, t('原因：{error}', { error: d.error })) : null,
        d?.handoffMessageId
          ? h('button', { type: 'button', class: 'receipt-action', 'data-receipt-delivery': d.id, disabled: !handoff,
            onclick: () => openMessage(msg.clusterId, d.handoffMessageId) }, handoff ? t('{value} · 查看消息', { value: target === d.memberId ? t('已重发') : t('已交接给 {value}', { value: target ? nameOf(target) : t('接手成员') }) }) : t('已交接 · 消息同步中'))
          : d && canHandoff(d) ? h('button', { type: 'button', class: 'receipt-action', 'data-receipt-delivery': d.id,
            onclick: () => openHandoff(msg, d) }, t('指定接手')) : null,
        d ? resendAction(msg, d, timeline) : null,
        timeline ? receiptDiagnosis(timeline) : null));
  };
  return h('details', { class: 'receipts', open, ontoggle: (e) => receiptsToggled(msg, e.target.open) },
    h('summary', {},
      h('span', { class: 'receipt-counts' }, t('回执 {count} 人 · 取回 {retrieved} · ', { count: all.length, retrieved: retrieved }),
        h('span', { role: 'img', 'aria-label': t('主动确认 {acknowledged}', { acknowledged: acknowledged }) }, icon('thumb', 'ico-sm'), ` ${acknowledged}`)),
      problems ? h('span', { class: 'receipt-warning' }, icon('alert', 'ico-sm'), t(' 异常 {problems}', { problems: problems })) : null),
    timelines?.failed ? h('p', { class: 'receipt-error' }, t('读不到投递诊断，收起再展开可以重试。')) : null,
    h('div', { class: 'receipt-list', tabindex: '0', 'aria-label': t('成员回执明细') },
      recipients.length ? h('div', { class: 'receipt-group' }, t('投递对象')) : null,
      recipients.map((r) => receiptRow(r, true)),
      readOnly.length ? h('div', { class: 'receipt-group' }, t('读过的人')) : null,
      readOnly.map((r) => receiptRow(r, false))));
}

function receiptAction(article, deliveryId) {
  return [...article.querySelectorAll('[data-receipt-delivery]')].find((el) => el.dataset.receiptDelivery === deliveryId && !el.disabled);
}

function jumpToMessage(id) {
  const el = msgEls.get(id)?.el;
  if (!el?.isConnected) return;
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
  el.classList.add('jump-target');
  setTimeout(() => el.classList.remove('jump-target'), 3000);
}

/**
 * Offline, failed or uncertain deliveries of the cluster that nobody has handed off, resent or marked known yet, newest
 * first (the Hub lists them). Each can be marked known (标为已知), or all of them; the list is read again after each.
 */
async function openDeliveryProblems() {
  const cid = S.sel.cluster;
  const path = `/api/clusters/${encodeURIComponent(cid)}/delivery-problems`;
  let data;
  try {
    data = await api('GET', path);
  } catch (e) {
    return noticeDialog(lt('读不到有问题的投递：{message}', { message: e.message }), lt('有问题的投递'));
  }
  const title = h('h2', { id: 'problems-title' });
  const description = h('p', { id: 'problems-description', class: 'muted' });
  const list = h('ul', { class: 'problem-list' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const dismissAll = h('button', { type: 'button' }, t('全部标为已知'));
  const close = h('button', { type: 'button' }, t('关闭'));
  const dialog = h('dialog', { class: 'handoff-dialog', 'aria-labelledby': 'problems-title', 'aria-describedby': 'problems-description' },
    h('form', {}, title, description, list, error, h('div', { class: 'row end' }, dismissAll, close)));
  let busy = false;
  const showError = (text) => { error.textContent = text; error.hidden = !text; };
  /** Draws `data`; after a write, focus goes to the mark button now at `focusAt` (or the last one, or 关闭). */
  const draw = (focusAt) => {
    Object.assign(problems, { cid, count: data.count });
    render();
    title.textContent = t('有问题的投递（{count}）', { count: data.count });
    description.textContent = problemsDescription(data.count, data.items.length);
    dismissAll.hidden = !data.count;
    list.hidden = !data.items.length;
    list.replaceChildren(...data.items.map(({ message: msg, delivery }, i) => h('li', {},
      h('button', { type: 'button', class: 'receipt-action', onclick: () => {
        dialog.close();
        void openMessage(cid, msg.id, { receipts: true });
      } },
      h('strong', {}, `${nameOf(delivery.memberId)} · ${deliveryView(delivery).label}`),
      h('span', { class: 'muted' }, ` ${fmtTime(delivery.updatedAt)}`),
      h('div', {}, snippet(msg.body, 60)),
      delivery.error ? h('div', { class: 'receipt-error' }, delivery.error) : null),
      h('button', { type: 'button', class: 'small problem-dismiss', 'aria-label': t('标为已知：{value} 的「{value2}」', { value: nameOf(delivery.memberId), value2: snippet(msg.body, 30) }),
        onclick: () => exclusive(() => write(`/api/clusters/${encodeURIComponent(cid)}/deliveries/${encodeURIComponent(delivery.id)}/dismiss`, {}, i)) },
      t('标为已知')))));
    if (focusAt === undefined) return;
    const marks = list.querySelectorAll('.problem-dismiss');
    (marks[Math.min(focusAt, marks.length - 1)] ?? close).focus();
  };
  /** One action at a time: `data` changes only inside one, so nothing can replace it under a running action. */
  const exclusive = async (action) => {
    if (busy) return;
    busy = true;
    try { await action(); } finally { busy = false; }
  };
  const write = async (url, body, focusAt) => {
    showError('');
    dismissAll.disabled = true;
    try {
      await api('POST', url, body);
    } catch (e) {
      showError(t('没能标为已知：{message}', { message: e.message }));   // e.g. it stopped being a problem meanwhile: the list read below shows that
    }
    try {
      data = await api('GET', path);
      if (dialog.open) draw(focusAt);
    } catch (e) {
      showError(t('读不到有问题的投递：{message}', { message: e.message }));
    } finally {
      dismissAll.disabled = false;
      if (dialog.open && !dialog.contains(document.activeElement)) close.focus();
    }
  };
  dismissAll.addEventListener('click', () => exclusive(async () => {
    // Taken before asking: the confirmation describes exactly the listing whose version is sent.
    const listing = data;
    const request = dismissAllRequest(listing);
    if (request.ask && !await confirmDialog(liveAsk(() => dismissAllRequest(listing).ask))) return;
    await write(`${path}/dismiss`, request.body, 0);
  }));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  draw();
  document.body.append(dialog);
  dialog.showModal();
}

function openResend(msg, delivery, timeline) {
  const confirmation = timeline.resend.needsConfirmation ? h('input', { type: 'checkbox', required: true }) : null;
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const cancel = h('button', { type: 'button' }, t('取消'));
  const submit = h('button', { type: 'submit', class: 'primary' }, t('重发'));
  const dialog = h('dialog', { class: 'handoff-dialog', 'aria-labelledby': 'resend-title', 'aria-describedby': 'resend-description' },
    h('form', {},
      h('h2', { id: 'resend-title' }, t('重发给 {value}', { value: nameOf(delivery.memberId) })),
      h('p', { id: 'resend-description', class: 'muted' }, t('会给这个成员发一条引用原文和附件的新消息，原投递记录不变。发送前 Hub 会再确认一次成员在线，不在线就不发，也不会唤醒应用。')),
      confirmation ? h('label', { class: 'handoff-confirm' }, confirmation, t('我知道原消息可能已经执行过，这次重发可能重复执行')) : null,
      error,
      h('div', { class: 'row end' }, cancel, submit)));
  let pending = false;
  const showError = (text) => { error.textContent = text; error.hidden = !text; };
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (e) => { if (pending) e.preventDefault(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    const article = msgEls.get(msg.id)?.el;
    (article && (receiptAction(article, `${delivery.id}:resend`) ?? article.querySelector('summary')))?.focus({ preventScroll: true });
  });
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending) return;
    pending = true;
    cancel.disabled = true;
    submit.disabled = true;
    showError('');
    try {
      const { data: result, seq } = await api('POST', `/api/clusters/${encodeURIComponent(msg.clusterId)}/deliveries/${encodeURIComponent(delivery.id)}/resend`,
        confirmation?.checked ? { confirmDuplicate: true } : {}, true);
      setDelivery(result.sourceDelivery, false, seq + 0.5);   // read at seq: a window read before it cannot undo it
      render();
      dialog.close();
    } catch (e) {
      showError(e instanceof TypeError ? t('未能确认是否已重发，请先查看群聊，再决定要不要重试。') : t('没有重发。原因：{message}', { message: e.message }));
      const entry = receiptTimelines.get(msg.id);
      if (entry) entry.key = null;   // the member may have gone offline: ask again
      loadTimelines(msg);
    } finally {
      pending = false;
      cancel.disabled = false;
      submit.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  (confirmation ?? submit).focus();
}

function openHandoff(msg, delivery) {
  const target = h('select', { id: 'handoff-target', required: true });
  const note = h('textarea', { id: 'handoff-note', rows: '4', maxlength: '4000', placeholder: t('可填写已完成事项、证据和下一步') });
  const confirmation = handoffNeedsConfirmation(delivery) ? h('input', { type: 'checkbox', required: true }) : null;
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const cancel = h('button', { type: 'button' }, t('取消'));
  const submit = h('button', { type: 'submit', class: 'primary' }, t('发送交接'));
  const dialog = h('dialog', { class: 'handoff-dialog', 'aria-labelledby': 'handoff-title', 'aria-describedby': 'handoff-description' },
    h('form', {},
      h('h2', { id: 'handoff-title' }, t('指定成员接手 {value} 的投递', { value: nameOf(delivery.memberId) })),
      h('p', { id: 'handoff-description', class: 'muted' }, t('交接会发送新的群聊消息，包含原消息、附件、投递原因和你的补充说明。原生应用中的私有上下文不会自动带入，请补充已完成事项、证据和下一步。')),
      h('label', { for: 'handoff-target' }, t('接手成员'), target),
      h('label', { for: 'handoff-note' }, t('补充说明（可选）'), note),
      confirmation ? h('label', { class: 'handoff-confirm' }, confirmation, t('我已确认原执行已停止')) : null,
      error,
      h('div', { class: 'row end' }, cancel, submit)));
  let pending = false;
  const showError = (text) => { error.textContent = text; error.hidden = !text; };
  refreshHandoffTargets = () => {
    const selected = target.value;
    const available = membersOf(msg.clusterId).filter((m) => m.id !== delivery.memberId);
    target.replaceChildren(h('option', { value: '', disabled: true, selected: true }, available.length ? t('请选择接手成员') : t('没有其他可接手的成员')),
      ...available.map((m) => h('option', { value: m.id }, m.name)));
    if (available.some((m) => m.id === selected)) target.value = selected;
    else if (selected) showError(t('接手成员已移出，请重新选择。'));
  };
  refreshHandoffTargets();
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (e) => { if (pending) e.preventDefault(); });
  dialog.addEventListener('close', () => {
    refreshHandoffTargets = null;
    dialog.remove();
    const article = msgEls.get(msg.id)?.el;
    (article && (receiptAction(article, delivery.id) ?? article.querySelector('summary')))?.focus({ preventScroll: true });
  });
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending) return;
    pending = true;
    cancel.disabled = true;
    submit.disabled = true;
    target.disabled = true;
    note.disabled = true;
    if (confirmation) confirmation.disabled = true;
    showError('');
    const text = note.value.trim();
    try {
      const body = { targetMemberId: target.value, ...(text ? { note: text } : {}), ...(confirmation?.checked ? { confirmStopped: true } : {}) };
      const { data: result, seq } = await api('POST', `/api/clusters/${encodeURIComponent(msg.clusterId)}/deliveries/${encodeURIComponent(delivery.id)}/handoff`, body, true);
      setDelivery(result.sourceDelivery, false, seq + 0.5);   // read at seq: a window read before it cannot undo it
      render();
      dialog.close();
    } catch (e) {
      refreshHandoffTargets();
      if (e instanceof TypeError) showError(t('未能确认交接是否成功；可能已发送，请查看群聊或对同一成员重试。'));
      else if (!target.value) showError(t('接手成员已移出，请先查看群聊确认是否已有交接，再重新选择。'));
      else showError(t('未能确认交接是否成功，请查看群聊或对同一成员重试。原因：{message}', { message: e.message }));
    } finally {
      pending = false;
      cancel.disabled = false;
      submit.disabled = false;
      target.disabled = false;
      note.disabled = false;
      if (confirmation) confirmation.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  target.focus();
}

// A message's Markdown as DOM (markdown.js has the node shapes). Everything from the message goes through h(), as text
// nodes or attribute values: tags in a message stay text, and nothing here loads a URL from one.

function mdBlocks(blocks, msg) {
  return blocks.map((b) => mdBlock(b, msg));
}

function mdBlock(b, msg) {
  const cell = (tag, inlines, align) => h(tag, { style: align ? `text-align: ${align}` : null }, mdInlines(inlines, msg));
  switch (b.type) {
    case 'p': return h('p', {}, mdInlines(b.inlines, msg));
    case 'h': return h(`h${b.level}`, {}, mdInlines(b.inlines, msg));
    case 'code': return h('pre', {}, h('code', {}, b.text));
    case 'hr': return h('hr');
    case 'quote': return h('blockquote', {}, mdBlocks(b.blocks, { ...msg, noTaskRefs: true }));
    case 'ul':
    case 'ol':
      return h(b.type, { start: b.start === 1 ? null : b.start }, b.items.map((item) => h('li', {}, mdBlocks(item, msg))));
    case 'table':
      return h('div', { class: 'md-table' }, h('table', {},
        h('thead', {}, h('tr', {}, b.head.map((c, i) => cell('th', c, b.align[i])))),
        h('tbody', {}, b.rows.map((row) => h('tr', {}, row.map((c, i) => cell('td', c, b.align[i])))))));
  }
}

/** Where task references may appear in a block: `quoted` are its quoted ranges, null means nowhere (block quotes, link labels). */
function taskRefScope(nodes, msg) {
  if (msg?.noTaskRefs) return { at: 0, quoted: null };
  const text = inlineText(nodes);
  return { at: 0, quoted: text.includes('#') ? quotedRanges(text) : [] };
}

function mdInlines(nodes, msg, scope = taskRefScope(nodes, msg)) {
  return nodes.flatMap((n) => {
    if (typeof n === 'string') {
      const out = bodyNodes(n, msg, scope);
      scope.at += n.length;
      return out;
    }
    if (n.type === 'code') {
      scope.at += n.text.length;
      return h('code', {}, n.text);
    }
    if (n.type === 'link') {
      scope.at += inlineText(n.children).length;
      return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer', title: n.href }, mdInlines(n.children, msg, { at: 0, quoted: null }));
    }
    return h(n.type, {}, mdInlines(n.children, msg, scope));   // strong, em, del
  });
}

/** A piece of text as text nodes, with each $name of a known skill, delivered @mention and resolved #task highlighted (text too, never HTML). */
function bodyNodes(body, msg, scope) {
  return bodySegments(body, {
    skills: S.skillNames,
    mentions: S.handoffs.has(msg?.id) ? null : msg?.mentions,
    members: S.members,
    tasks: msg?.clusterId && scope.quoted ? (id, offset) => (inRanges(scope.quoted, scope.at + offset) ? null : taskRefs.get(msg.clusterId, id) ?? null) : null,
  }).map((seg) => {
    if (typeof seg === 'string') return seg;
    if (seg.task) {
      const ref = seg.task.number != null ? `#${seg.task.number}` : `#${seg.task.id.slice(0, 8)}`;
      return h('a', { class: 'task-ref', href: '#', title: t('任务 {value}{id}：{title}', { value: seg.task.number != null ? `#${seg.task.number} ` : '', id: seg.task.id, title: seg.task.title }), onclick: (e) => {
        e.preventDefault();
        workbench.openTask(msg.clusterId, seg.task.id);
      } }, `${ref} ${snippet(seg.task.title, 40)}`);
    }
    if (seg.skill) {
      return h('span', { class: 'skill', title: S.skills.find((k) => k.name === seg.skill)?.description || 'skill' }, seg.text);
    }
    if (seg.mention === 'all') {
      return h('span', { class: 'mention' }, seg.text);
    }
    if (seg.mention) {
      return h('span', {
        class: 'mention link',
        title: t('查看 {value}', { value: nameOf(seg.mention) }),
        onclick: msg?.clusterId ? () => select(msg.clusterId, seg.mention) : null,
      }, seg.text);
    }
    return seg.text;
  });
}

// A message's attachments never change, so their element is built once and moved into each rebuilt message
// (a delivery update rebuilds the message; the thumbnails must not reload or flicker).
const attachEls = new Map();   // message id -> element
function attachmentsEl(msg) {
  let el = attachEls.get(msg.id);
  if (el) return el;
  el = h('div', { class: 'attachments' }, msg.attachments.map((f) => attachmentNode(f, openViewer)));
  attachEls.set(msg.id, el);
  return el;
}

// ---- image viewer (in the page: a <dialog>, never a new window) ----

const viewer = $('viewer');
function openViewer(f) {
  $('viewer-name').textContent = fileLabel(f);
  $('viewer-img').src = fileUrl(f.id);
  $('viewer-img').alt = f.name;
  $('viewer-download').href = fileUrl(f.id, true);
  $('viewer-download').setAttribute('download', f.name);
  viewer.showModal();
}
$('viewer-close').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', (e) => { if (e.target === viewer || e.target.classList.contains('viewer-body')) viewer.close(); });
viewer.addEventListener('close', () => { $('viewer-img').removeAttribute('src'); });

// ---- member page ----

let panelFor = null;   // member id the panel was last built for
let panelIdentity = -1;
let panelLanguage = null;   // the language its event lines were drawn in
let panelCount = 0;    // member events already rendered

const GUARD = {
  hidden_work: (p) => t('隐身中：任务的工作落到它身上（{kind}），它收不到，没有人会处理', { kind: p.kind }),
  max_hops: (p) => t('防循环：跳数超过上限 {maxHops}，这条发言被拒收', { maxHops: p.maxHops }),
  max_turns_per_chain: (p) => t('防循环：消息链轮次超过上限 {maxTurnsPerChain}，不再开始', { maxTurnsPerChain: p.maxTurnsPerChain }),
  max_turns_per_hour: (p) => t('防循环：每小时轮次超过上限 {maxTurnsPerHour}，暂缓开始新轮次', { maxTurnsPerHour: p.maxTurnsPerHour }),
  max_notice_batches_per_hour: (p) => t('防循环：每小时系统通知批次超过上限 {maxNoticeBatchesPerHour}，系统通知暂缓投递（留在队列里等待）', { maxNoticeBatchesPerHour: p.maxNoticeBatchesPerHour }),
  zcode_arm_rate: (p) => t('防循环：这个 ZCode 对话 {windowMinutes} 分钟内挂起等待超过 {maxArms} 次，之后挂的等待只挂着、不再使用（已暂停）', { windowMinutes: p.windowMinutes, maxArms: p.maxArms }),
  zcode_extra_wait: (p) => t('这个 ZCode 对话同时挂了 {waits} 条等待：多出的先挂在一边，可以在 ZCode 里停掉多余的后台任务', { waits: p.waits }),
  qoder_arm_rate: (p) => t('防循环：这个 Qoder 对话 {windowMinutes} 分钟内挂起等待超过 {maxArms} 次，之后挂的等待只挂着、不再使用（已暂停）', { windowMinutes: p.windowMinutes, maxArms: p.maxArms }),
  qoder_extra_wait: (p) => t('这个 Qoder 对话同时挂了 {waits} 条等待：多出的先挂在一边，可以在 Qoder 的后台进程面板里停掉多余的', { waits: p.waits }),
  workbuddy_arm_rate: (p) => t('防循环：这个 WorkBuddy 对话 {windowMinutes} 分钟内挂起等待超过 {maxArms} 次，之后挂的等待只挂着、不再使用（已暂停）', { windowMinutes: p.windowMinutes, maxArms: p.maxArms }),
  workbuddy_extra_wait: (p) => t('这个 WorkBuddy 对话同时挂了 {waits} 条等待：多出的先挂在一边，可以在 WorkBuddy 里停掉多余的后台任务', { waits: p.waits }),
};

function buildEvent(e) {
  const time = h('span', { class: 'time', title: e.createdAt }, fmtTime(e.createdAt).slice(-5));
  let cls = e.kind;
  let what;
  if (e.kind === 'delivery') {
    const d = e.payload.delivery;
    // Which message: carried by the line (REST pages and 'message' events), loaded, or read by id and filled in.
    const about = h('span', {});
    const fill = (msg) => { if (msg) about.textContent = t('「{value}」（来自 {value2}）', { value: snippet(msg.body), value2: nameOf(msg.from) }); };
    const known = e.payload.message ?? S.messages.get(d.messageId);
    if (known) fill(known);
    else if (e.clusterId) void loadMessageRef(e.clusterId, d.messageId).then(fill);
    // A line records a past state; whether the member is offline right now is in the panel header.
    const look = deliveryView(d);
    what = [icon(look.icon, 'ico-sm'), ` ${look.label} `, about, d.error ? `：${d.error}` : ''];
    if (d.state === 'failed') cls = 'error';
  } else if (e.kind === 'guard') {
    what = (GUARD[e.payload.reason] ?? (() => t('防循环：{reason}', { reason: e.payload.reason })))(e.payload);
  } else if (e.kind === 'unread_hint') {
    what = t('向这个对话插入了一行未读提示：{count} 条未读', { count: e.payload.count });
  } else {
    const ev = e.payload.event;
    cls = ev.type;
    if (ev.type === 'text') what = ev.text;
    else if (ev.type === 'error') what = t('错误：{message}', { message: ev.message });
    else {
      what = [ev.phase === 'start' ? t('调用工具 ') : t('工具返回 '), h('b', {}, ev.name),
        ev.detail ? h('span', { class: 'detail' }, ev.detail) : null];
    }
  }
  return h('div', { class: `ev ${cls}` }, time, h('div', { class: 'what' }, what));
}

function renderMemberPanel() {
  const m = S.members.get(S.sel.member);
  if (!m) { panelFor = null; return; }

  const removed = Boolean(m.removedAt);
  $('member-edit').hidden = removed;
  $('member-composer').hidden = removed;
  $('member-handover-row').hidden = removed;
  $('removed-banner').hidden = !removed;
  const status = statusOf(m);
  $('member-avatar').replaceChildren(avatarEl(m, 'lg', { presence: removed ? null : presenceOf(m) }));
  $('member-name').textContent = m.name;
  $('member-meta').textContent = `${m.harness}${m.model ? ` · ${m.model}` : ''} · ${removed ? t('已移出集群') : memberStatusLabel(m, status)}${!removed && m.hiddenAt ? ` · ${t(HIDDEN_MARK)}` : ''}`;
  const hiddenNow = !removed && Boolean(m.hiddenAt);
  $('hidden-banner').textContent = hiddenNow ? t('{HIDDEN_MARK}：它收不到任何消息，其他成员看不到它，它的 orrery 工具什么也不执行。可以在群员面板或下面的按钮取消隐身。', { HIDDEN_MARK: t(HIDDEN_MARK) }) : '';
  $('hidden-banner').hidden = !hiddenNow;
  $('member-hidden-row').hidden = removed;
  $('member-hidden').textContent = hiddenNow ? t('取消隐身…') : t('设为隐身…');
  $('member-hidden').disabled = hiding.has(m.id);
  $('member-hidden-note').textContent = hiddenNow ? t('取消后从那一刻起照常收消息。') : t('隐身期间不收消息，除你和协调员外没人看得到它。');
  const hint = offlineHint(m, status, S.harnesses.includes(m.harness));
  $('offline-banner').textContent = hint ?? '';
  $('offline-banner').hidden = !hint;
  const waiting = longWaitingHint(m);
  $('waiting-banner').textContent = waiting ?? '';
  $('waiting-banner').hidden = !waiting;
  const unset = t('由应用决定');
  const pageUsage = S.usage?.clusterId === m.clusterId ? S.usage : null;
  const details = memberDetails(m, pageUsage?.members.find((r) => r.memberId === m.id), null, { usageLoaded: false });
  $('member-info').replaceChildren(...[
    [t('模型'), details.model],
    [t('思考强度'), m.effort ?? unset],
    [t('来源'), m.origin === 'attached' ? t('接入的已有对话') : t('orrery 新建的对话')],
    [t('对话标题'), details.conversation],
    [t('工作目录'), m.cwd],
    [t('会话 ID'), m.workerSessionId],
  ].flatMap(([k, v]) => [h('dt', {}, k), typeof v === 'string' ? h('dd', {}, v) : h('dd', { title: v.title }, v.text)]));
  const rebinds = S.rebinds.get(m.id) ?? [];
  if (panelFor !== m.id) $('member-rebind').open = rebinds.length > 0;
  $('member-rebind-title').textContent = rebinds.length ? t('换对话（已换 {count} 次）', { count: rebinds.length }) : t('换对话');
  $('member-rebind-open').hidden = removed;
  $('member-rebind-list').replaceChildren(...(rebinds.length ? [...rebinds].reverse().map((r) => h('li', {},
    h('div', { class: 'muted' }, t('{value} · 用户已确认原对话停止', { value: fmtTime(r.at) })),
    h('div', {}, t('原对话 {fromSessionId}', { fromSessionId: r.fromSessionId })), h('div', {}, t('新对话 {toSessionId}', { toSessionId: r.toSessionId })),
    r.fromCwd === r.toCwd ? null : h('div', { class: 'muted' }, t('工作目录 {fromCwd} → {toCwd}', { fromCwd: r.fromCwd, toCwd: r.toCwd }))))
    : [h('li', {}, emptyState(t('还没有换过对话。'), { compact: true }))]));
  $('member-activity').hidden = removed;
  $('member-activity').replaceChildren(activityEl(activitySummary(S.activity.get(m.id), S.activityFailed)));
  const versions = toolVersionView(S.toolVersions, m.id, m.harness);
  const health = memberHealth(S.toolVersions, m);
  usageRenderer.draw('member-tool-versions', [m.id, versions, health], () => h('details', {}, h('summary', {}, t('工具版本')),
    h('div', {}, t('连接状态：{label} · 依据：{basis}{value}', { label: health.connection.label, basis: health.connection.basis, value: health.connection.observed ? t(' · 观测时间：{observed}', { observed: health.connection.observed }) : '' })),
    h('div', {}, health.problem.known
      ? (health.problem.text ? t('最近投递问题：{text}', { text: health.problem.text }) : t('最近投递问题：没有失败或离线记录'))
      : t('最近投递问题：未知（{text}）', { text: health.problem.text })),
    h('div', {}, `Hub：${versions.hub}`), h('div', {}, t('对话最近调用声明：{text}', { text: versions.client.text })),
    h('div', {}, t('桥 / 插件声明：{text}', { text: versions.bridge.text })),
    h('div', { class: 'muted' }, versions.lastCall ? t('最近调用：{value}。桥 / 插件声明不代表对话已刷新。', { value: fmtTime(versions.lastCall) }) : t('尚无调用记录；客户端未声明时显示未知。')),
    versions.advice ? h('div', { class: 'muted' }, versions.advice) : null), { perMinute: false, preserveOpen: true });
  const usage = S.usage?.clusterId === m.clusterId ? S.usage : null;
  const alert = usageAlertText(usage?.members.find((r) => r.memberId === m.id));
  $('member-usage-alert').textContent = alert;
  $('member-usage-alert').hidden = !alert;
  usageRenderer.draw('member-usage', [m.id, m.harness, usage?.quotas, usage?.members.find((r) => r.memberId === m.id)],
    () => usageView(m, usage, { onRefresh: refreshQuota }));
  usageRenderer.renderTurns(m, { data: S.turnUsage, identity: S.identity, error: S.turnUsageError });

  // Reset the edit form and rebuild the stream only for another member, or after a name/avatar changed
  // (event lines mention names); otherwise just append new events.
  const box = $('member-events');
  let log = S.memberLogs.get(m.id);
  if (!log || (log.error && panelFor !== m.id)) log = loadMemberLog(m.id);   // opened (again after a failed read)
  const events = log.events;
  if (panelFor !== m.id || panelIdentity !== S.identity) {
    panelEditor.fill(m);
    panelCount = 0;
    panelIdentity = S.identity;
  } else if (panelLanguage !== language() && panelCount) {
    // A language switch is not another member: the editor keeps what is typed and picked (its labels are translated
    // in place), and the same lines are drawn again in the new language where they were, scrolled as they were.
    const top = box.scrollTop;
    box.replaceChildren(...events.slice(log.prepended, log.prepended + panelCount).map(buildEvent));
    box.scrollTop = top;
  }
  panelLanguage = language();
  panelFor = m.id;
  // Every member is a conversation of its native app since isolated mode was removed; that removal dropped this name
  // but kept its uses, so the page threw here and never drew the member's lines.
  const native = true;
  const note = $('member-composer-note');
  note.textContent = native
    ? t('原样投进这个对话，不加 orrery 的信封，和你在应用里自己输入一样。{value}{value2}{value3}{value4}', { value: m.harness === 'claude' ? t('Claude Desktop 里它显示为一张「来自另一个会话」（Message from another session）的消息卡片。') : '', value2: m.harness === 'antigravity' ? t('Antigravity 里它显示为一条高优先级的系统消息，并马上开始一轮。') : '', value3: m.harness === 'kimi' ? t('Kimi Code 会把它显示成你自己发的消息，所以开头会多一行 [orrery · 来自 user]。') : '', value4: m.harness === 'cursor' ? t('Cursor 会把它显示成你自己发的消息，所以开头会多一行 [orrery · 来自 user · #交接号]（交接号用来确认 Cursor 真的提交了）。') : '' })
    : '';
  note.hidden = !native;
  direct.input.placeholder = native ? t('直接发给这个对话') : t('单独发给这个群员（等同于在群里 @它）');
  renderComposer(direct, `m:${m.id}`);
  if (!events.length) {
    const empty = log.loading ? t('正在读取…') : log.error ? t('读取失败。关掉这一页再打开可以重试。') : t('这个群员还没有收到过消息。');
    if (box.firstElementChild?.textContent !== empty) box.replaceChildren(emptyState(empty));
  } else if (panelCount === 0) box.replaceChildren();
  if (log.prepended && panelCount) {
    // Older lines read on scrolling up go in front; what is on screen stays where it is.
    const height = box.scrollHeight;
    box.prepend(...events.slice(0, log.prepended).map(buildEvent));
    box.scrollTop += box.scrollHeight - height;
    panelCount += log.prepended;
  }
  log.prepended = 0;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.append(...events.slice(panelCount).map(buildEvent));
  if (panelCount === 0 || atBottom) box.scrollTop = box.scrollHeight;
  panelCount = events.length;
}

/** A member page's newest lines over REST; lines streamed meanwhile wait in `pending` and are added after them. */
function loadMemberLog(id) {
  const log = { events: [], older: false, loading: true, pending: [], prepended: 0, error: false };
  S.memberLogs.set(id, log);
  api('GET', `/api/members/${encodeURIComponent(id)}/events?limit=${PAGE}`).then((list) => {
    const last = list.at(-1)?.seq ?? 0;
    log.events = [...list, ...log.pending.filter((e) => e.seq > last)];
    log.older = list.length === PAGE;
  }, () => { log.error = true; }).finally(() => {
    log.loading = false;
    log.pending = null;
    if (log.error) log.events = [];
    render();
  });
  return log;
}

/** Scrolled to the top of a member page: the PAGE lines before the first one shown. */
async function loadOlderMemberLines(id) {
  const log = S.memberLogs.get(id);
  if (!log?.older || log.loading || !log.events.length || Date.now() - (log.failedAt ?? 0) < 3000) return;
  log.loading = true;
  try {
    const list = await api('GET', `/api/members/${encodeURIComponent(id)}/events?limit=${PAGE}&before=${log.events[0].seq}`);
    if (S.memberLogs.get(id) !== log) return;
    log.events = [...list, ...log.events];
    log.older = list.length === PAGE;
    log.prepended += list.length;
  } catch {
    log.failedAt = Date.now();   // the next scroll at the top asks again, not every scroll event
  } finally {
    log.loading = false;
    render();
  }
}
$('member-events').addEventListener('scroll', () => {
  if ($('member-events').scrollTop < 200 && S.sel.member) void loadOlderMemberLines(S.sel.member);
}, { passive: true });

// ---- actions ----

function showError(id, err) {
  const el = $(id);
  el.textContent = err ? (err.message ?? String(err)) : '';
  el.hidden = !err;
}

// ---- composers: one draft per target ----
// A target is 'c:<cluster>' (group chat) or 'm:<member>' (member page). Each textarea shows the draft of the
// target it is bound to; switching targets saves and restores drafts. Sending never clears text up front:
// on success the target's draft is cleared only if it still holds exactly the sent text, and on failure the
// text simply stays where it is, so it can be neither lost nor moved to another target.

const drafts = new Map();     // target -> text, for targets not currently shown
const taskDrafts = new Map(); // target -> task ids selected for the next message
const sending = new Set();    // targets with a POST in flight
const sendErrors = new Map(); // target -> last send error, shown under that target

function makeComposer(form, input, errorId, scroller) {
  input.addEventListener('input', () => autogrow(input));
  return { form, input, errorId, scroller, button: form.querySelector('button[type=submit]'), target: null };
}
const chat = makeComposer($('composer'), $('composer-input'), 'composer-error', $('messages'));
const direct = makeComposer($('member-composer'), $('member-input'), 'member-error', $('member-events'));

/**
 * Grows a composer with its text up to a cap (ui.js autogrowHeight), then it scrolls; shrinks back when text goes.
 * A stream that was at its newest line stays there while the composer takes or gives back room.
 */
function autogrow(input) {
  if (!input.offsetParent) return;   // hidden: measured when shown (renderComposer)
  // Still at its rows (no height set below) and the text fits: nothing to grow or shrink. Measuring resets the
  // height, and each of its reads would lay the chat out again on every keystroke.
  if (!input.style.height && input.scrollHeight <= input.clientHeight) return;
  const box = [chat, direct].find((c) => c?.input === input)?.scroller;
  const atBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const scrolled = input.scrollTop;
  input.style.height = '';   // back to its rows, so scrollHeight measures the text
  if (!input.value) {   // empty: its rows (the placeholder would count as content, and wraps a lot when narrow)
    input.style.overflowY = 'hidden';
    if (atBottom) box.scrollTop = box.scrollHeight;
    return;
  }
  const cs = getComputedStyle(input);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const min = input.offsetHeight;
  const { height, scroll } = autogrowHeight({
    content: input.scrollHeight + border, min, lineHeight: parseFloat(cs.lineHeight) || 20,
    chrome: border + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), viewport: innerHeight,
  });
  input.style.height = height > min ? `${height}px` : '';   // at its rows: no height, which the check above reads
  input.style.overflowY = scroll ? 'auto' : 'hidden';
  input.scrollTop = scrolled;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** Binds the composer to `target` (saving the old draft, loading the new one) and shows that target's state. */
function renderComposer(c, target) {
  if (c.target !== target) {
    if (c.target) drafts.set(c.target, c.input.value);
    c.target = target;
    c.input.value = drafts.get(target) ?? '';
    drafts.delete(target);
    autogrow(c.input);
  }
  const err = sendErrors.get(target);
  showError(c.errorId, err ? t('发送失败：{err}', { err: err }) : null);
  c.button.disabled = sending.has(target) || (target.startsWith('m:') && Boolean(S.members.get(target.slice(2))?.removedAt));
  if (c === chat) {
    renderUploads();
    const count = taskDrafts.get(target)?.length ?? 0;
    $('composer-task-count').textContent = count ? String(count) : '';
    $('composer-add').dataset.count = count || '';   // the same count on the "+" itself, seen while the menu is closed
    $('composer-add').setAttribute('aria-label', count ? t('添加（已关联 {count} 个任务）', { count: count }) : t('添加'));
    const refused = attachErrors.text(target);
    $('attach-error').textContent = refused;
    $('attach-error').hidden = !refused;
    renderMentionHint();
  }
}

// ---- attachments waiting to be sent (group chat composer; docs/files.md) ----
// Each file is uploaded as soon as it is picked, dropped or pasted, into the cluster of the target it was added to;
// the message then carries the uploaded ids. Per target, like drafts, so switching clusters keeps them apart.

const uploads = new Map();   // target -> [{ key, name, size, state: 'uploading' | 'done' | 'error', id?, error? }]
let uploadsVersion = 0;      // bumped on every change; the chips are redrawn only then (or for another target)
let drawnUploads = '';
let uploadKey = 0;

function renderUploads() {
  const target = chat.target;
  const key = `${target}|${uploadsVersion}|${language()}`;   // the chips' words follow a language switch; the files stay
  if (key === drawnUploads) return;
  drawnUploads = key;
  const list = uploads.get(target) ?? [];
  const box = $('composer-files');
  box.hidden = !list.length;
  box.replaceChildren(...list.map((u) => pendingFileNode(u, () => removeUpload(target, u.key))));
}

function changeUploads(target, fn) {
  const list = fn(uploads.get(target) ?? []);
  if (list.length) uploads.set(target, list);
  else uploads.delete(target);
  uploadsVersion++;
  render();
}
// shortcut: a removed upload stays on the Hub's disk unsent (docs/backlog.md); delete it there if that matters.
const removeUpload = (target, key) => changeUploads(target, (list) => list.filter((u) => u.key !== key));

// Files refused when picked (too big, too many), shown under the target they were added to (ui.js noticeBoard).
const attachErrors = noticeBoard();
// The Hub's mentionHints for the last message sent to a target (`@张三你好` reached nobody): sent anyway, the
// note only says how to write the name; the next send to that target replaces it.
const mentionNotes = noticeBoard();

/** The Hub's hints after a send, plus a live note while the draft @-mentions a hidden member (it will not receive it). */
function renderMentionHint() {
  const target = chat.target;
  const hidden = target?.startsWith('c:') ? hiddenMentionHint(chat.input.value, membersOf(target.slice(2))) : '';
  const hint = [target ? mentionNotes.text(target) : '', hidden].filter(Boolean).join(' ');
  $('mention-hint').textContent = hint;
  $('mention-hint').hidden = !hint;
}
chat.input.addEventListener('input', renderMentionHint);

// ---- hiding a member (docs/cluster-members.md「隐身」): the user, from the member panel or the member page ----

async function toggleHidden(memberId) {
  const m = S.members.get(memberId);
  if (!m || m.removedAt || hiding.has(memberId)) return;
  const hide = !m.hiddenAt;
  let tasks = [];
  if (hide && workbench.tasksEnabled?.() !== false) {
    try {
      // Only what it holds, every page of it: a member may hold tasks far down a long list.
      tasks = await allPages((cursor) => api('GET', heldTasksPath(m.clusterId, memberId, cursor)));
    } catch { tasks = null; }   // the dialog then says it could not read them
  }
  const held = tasks ? heldTasks(tasks, memberId) : { executing: [], reviewing: [] };
  const text = lt(() => hiddenConfirmText(m, held, hide) + (tasks === null ? t('\n（没有读到任务列表，请在任务工作台确认它手上的任务。）') : ''));
  if (!await confirmDialog({ title: hide ? lt('设为隐身') : lt('取消隐身'), message: text, confirmText: hide ? lt('设为隐身') : lt('取消隐身'), danger: hide })) return;
  hiding.add(memberId);
  render();
  try {
    upsertMember((await api('POST', `/api/members/${encodeURIComponent(memberId)}/hidden`, { hidden: hide })).member);
  } catch (e) {
    await noticeDialog(lt('没有{value}：{value2}', { value: hide ? lt('设为隐身') : lt('取消隐身'), value2: e.message ?? e }));
  } finally {
    hiding.delete(memberId);
    render();
  }
}

/** Uploads `files` ([File] with an optional `as` name) for the chat composer's current target. */
function addFiles(files) {
  const target = chat.target;
  if (!target || !files.length) return;
  const clusterId = target.slice(2);
  const named = files.map((file) => ({ file, name: file.as ?? file.name, size: file.size }));
  const { accepted, errors } = pickFiles((uploads.get(target) ?? []).length, named);
  attachErrors.set(target, errors);
  render();
  for (const f of accepted) {
    const u = { key: ++uploadKey, name: f.name, size: f.size, state: 'uploading' };
    changeUploads(target, (list) => [...list, u]);
    uploadFile(clusterId, f.file, f.name).then((info) => {
      changeUploads(target, (list) => list.map((x) => (x.key === u.key ? { ...x, state: 'done', id: info.id, name: info.name } : x)));
    }, (e) => {
      changeUploads(target, (list) => list.map((x) => (x.key === u.key ? { ...x, state: 'error', error: e.message } : x)));
    });
  }
}

async function uploadFile(clusterId, file, name) {
  const res = await fetch(`/api/files?cluster=${encodeURIComponent(clusterId)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-orrery-filename': encodeURIComponent(name) }, body: file,
  });
  if (res.status === 401) unauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

$('composer-file').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
// Pasting files (e.g. a screenshot) attaches them; a paste that also carries text stays a text paste.
chat.input.addEventListener('paste', (e) => {
  const files = pastedFiles(e.clipboardData, new Date());
  if (!files) return;
  e.preventDefault();
  addFiles(files);
});
// Dropping files anywhere on the chat column attaches them to the open cluster's message.
const dropZone = $('chat');
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
dropZone.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || $('composer').hidden) return;
  e.preventDefault();
  dropZone.classList.add('dropping');
});
dropZone.addEventListener('dragleave', (e) => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dropping'); });
dropZone.addEventListener('drop', (e) => {
  dropZone.classList.remove('dropping');
  if (!hasFiles(e) || $('composer').hidden) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});

const shownIn = (target) => [chat, direct].find((c) => c.target === target);
const draftOf = (target) => shownIn(target)?.input.value ?? drafts.get(target) ?? '';
function clearDraft(target) {
  const c = shownIn(target);
  if (c) {
    c.input.value = '';
    autogrow(c.input);
  } else drafts.delete(target);
}

/**
 * `payload(text)` is the POST body: { body } for the group chat, { body, to } for a member page; the target's
 * uploaded attachments are added. Files alone are a message; files still uploading hold the send back.
 */
async function send(c, clusterId, payload, onSuccess = null) {
  const target = c.target;
  const text = c.input.value;
  const files = uploads.get(target) ?? [];
  if (sending.has(target)) return;
  if (files.some((u) => u.state === 'uploading')) {
    sendErrors.set(target, t('还有附件在上传，等上传完再发'));
    return render();
  }
  const ready = files.filter((u) => u.state === 'done');
  if (!text.trim() && !ready.length) return;
  sending.add(target);
  sendErrors.delete(target);
  render();
  try {
    const sent = await api('POST', `/api/clusters/${encodeURIComponent(clusterId)}/messages`, {
      ...payload(text), ...(ready.length ? { attachments: ready.map((u) => u.id) } : {}),
    });
    mentionNotes.set(target, Array.isArray(sent?.mentionHints) ? sent.mentionHints.map(String) : []);
    const sameDraft = draftOf(target) === text;
    if (sameDraft) clearDraft(target);   // edited meanwhile: leave the user's text alone
    if (ready.length) changeUploads(target, (list) => list.filter((u) => !ready.includes(u)));
    onSuccess?.(sameDraft);
    attachErrors.clear(target);   // this send's target only: another cluster's notice stays
  } catch (e) {
    sendErrors.set(target, e.message);
  } finally {
    sending.delete(target);
    render();
  }
}

// ---- plugin commands: "/" at the start of the group chat composer (docs/external-plugins.md「命令」) ----
// Never a message: choosing a command clears the "/…" text and opens its form (or runs it at once when it has no
// parameters); the run shows as a chip in the cluster header and ends in a notice on this page only. A "/" that matches
// no command stays text and is sent as usual.

const runState = createCommandState({ onChange: () => render() });
const commandLists = new Map();   // clusterId -> { commands, at }: the cluster's "/" list (GET …/plugin-commands)
const commandLoads = new Map();   // clusterId -> that listing's request in flight
let commandsFor = null;           // the cluster whose list was last asked for on a switch
let openForm = null;              // { clusterId, form } while a parameter form is open
let drawnRuns = '';               // what the chip and the notices last drew (redrawn only when it changes)

function loadCommands(cid) {
  if (commandLoads.has(cid)) return commandLoads.get(cid);
  const since = runState.mark();   // runs heard of after this are newer than the listing and stay
  const load = api('GET', `/api/clusters/${encodeURIComponent(cid)}/plugin-commands`).then((listing) => {
    commandLists.set(cid, { commands: listing.commands, at: Date.now() });
    runState.replace(cid, listing.runs, since);
    commandKeys.refresh();
    render();
  }).finally(() => commandLoads.delete(cid));
  commandLoads.set(cid, load);
  return load;
}
/** The "/" list of the composer's cluster; a list older than 30 s is read again (the menu redraws when it arrives). */
function commandCandidates() {
  const cid = chat.target?.slice(2);
  if (!cid) return [];
  const list = commandLists.get(cid);
  if (!list || Date.now() - list.at > 30_000) loadCommands(cid).catch(() => {});
  return list?.commands ?? [];
}
function closeCommandForm(focus = true) {
  unmountCommandForm($('command-form-slot'));
  openForm = null;
  if (focus) chat.input.focus();
}
function chooseCommand(c) {
  const cid = chat.target?.slice(2);
  if (!cid) return;
  closeCommandForm(false);
  if (!c.params.length) { void startCommand(cid, c, {}, null); return; }
  const form = commandForm(c, {
    members: membersOf(cid).map((m) => ({ id: m.id, name: m.name })),
    onRun: (values) => startCommand(cid, c, values, form),
    onCancel: () => closeCommandForm(),
  });
  openForm = { clusterId: cid, form };
  // Directly above the composer but outside its <form>: nothing typed in the command form can submit the chat message.
  mountCommandForm($('command-form-slot'), form.el);
  form.focus();
}
async function startCommand(cid, c, values, form) {
  const since = runState.mark();
  try {
    const { run } = await api('POST', `/api/clusters/${encodeURIComponent(cid)}/plugin-commands/run`, { pluginId: c.pluginId, command: c.id, arguments: values });
    if (form && openForm?.form === form) closeCommandForm();
    runState.apply(run, false, since);
  } catch (e) {
    const message = e.message ?? String(e);
    if (form && openForm?.form === form) {
      if (e.data?.field) form.showErrors({ [e.data.field]: message });
      else form.setError(message);
    } else runState.local(cid, 'failed', t('「{title}」没有运行', { title: c.title }), message);
  }
  render();
}
async function cancelCommandRun(run) {
  const since = runState.mark();
  try {
    runState.apply((await api('POST', `/api/clusters/${encodeURIComponent(run.clusterId)}/plugin-runs/${encodeURIComponent(run.runId)}/cancel`, {})).run, false, since);
  } catch (e) {
    runState.local(run.clusterId, 'failed', t('「{title}」没有取消', { title: run.title }), e.message ?? String(e));
  }
  render();
}
/** The header chip and the notices of the shown cluster only (`cid` null: none); a form of another cluster closes. */
function renderCommandRuns(cid) {
  if (cid && commandsFor !== cid) { commandsFor = cid; loadCommands(cid).catch(() => {}); }
  if (openForm && openForm.clusterId !== cid) closeCommandForm(false);
  const runs = cid ? runState.active(cid) : [];
  const notices = cid ? runState.notices(cid) : [];
  const drawn = JSON.stringify([cid, runs, notices.map((n) => n.key)]);
  if (drawn === drawnRuns) return;
  drawnRuns = drawn;
  drawRuns({ details: $('plugin-runs'), summary: $('plugin-run-chip'), panel: $('plugin-run-panel') }, runs, { onCancel: cancelCommandRun });
  drawNotices($('run-notices'), notices, (key) => { runState.dismiss(key); render(); });
}
const commandKeys = attachCommands(chat.input, $('command-menu'), commandCandidates, chooseCommand);

const mentionKeys = attachMentions(chat.input, $('mention-menu'), () => [
  ...membersOf(S.sel.cluster).map((m) => ({ name: m.name, member: m })),
  { name: 'all', member: null },
]);
const skillKeys = attachSkills(chat.input, $('skill-menu'), () => S.skills);
const taskKeys = attachTaskRefs(chat.input, $('task-menu'), (query) => taskCandidates(chat.target?.slice(2), query));
submitOnEnter(chat.input, chat.form, (e) => commandKeys(e) || mentionKeys(e) || skillKeys(e) || taskKeys(e));
chat.form.addEventListener('submit', (e) => {
  e.preventDefault();
  // A second guard besides the form living outside: while focus is in an open command form, no chat message goes.
  if (!chatSubmitAllowed(openForm?.form.el, document.activeElement)) return;
  // The target comes from the binding, not S.sel: right after a switch the textarea still shows the old target.
  if (chat.target) {
    const target = chat.target;
    const ids = [...(taskDrafts.get(target) ?? [])];
    send(chat, target.slice(2), (text) => ({ body: text, ...(ids.length ? { taskIds: ids } : {}) }), (sameDraft) => {
      if (sameDraft && JSON.stringify(taskDrafts.get(target) ?? []) === JSON.stringify(ids)) taskDrafts.delete(target);
    });
  }
});
attachMenu($('composer-add'), $('composer-menu'));
$('composer-attach').addEventListener('click', () => $('composer-file').click());
$('composer-tasks').addEventListener('click', () => {
  const target = chat.target;
  if (!target) return;
  workbench.pickTasks(target.slice(2), taskDrafts.get(target) ?? [], (ids) => { taskDrafts.set(target, ids); render(); }, { persisted: false });
});

submitOnEnter(direct.input, direct.form);
direct.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const m = S.members.get(direct.target?.slice(2));
  // Addressed by id, so a rename (or an @name in the text) cannot redirect it.
  if (m && !m.removedAt) send(direct, m.clusterId, (text) => ({ body: text, to: [m.id] }));
});

$('open-sidebar').addEventListener('click', () => { $('app').classList.add('sidebar-open'); render(); });
$('scrim').addEventListener('click', () => {
  if ($('app').classList.contains('sidebar-open')) { $('app').classList.remove('sidebar-open'); render(); }
  else closePanel();
});

// ---- settings dialog (anti-loop limits; the pause switch stays in the sidebar, the dialog shows its state) ----

const settingsDialog = $('settings-dialog');
const pluginConfig = createPluginConfig(api);
const pluginSettings = createPluginSettings(api, $('plugin-list'), pluginConfig.openPlugin);
let installPanel = null;
function disposeInstallPanel() {
  const panel = installPanel;
  installPanel = null;
  // If a request is still running, its old panel cleans up only its own preview when it finishes.
  void panel?.dispose().catch(() => {});
}

function mountUpdatePanel() {
  mountUpdates($('updates-settings'), { api: featureApi, onState: (state) => {
    const button = $('open-settings');
    button.toggleAttribute('data-update-available', state.status === 'available');
    const label = state.status === 'available' ? t('设置 · 新版本 {version}', { version: state.latestVersion }) : t('设置');
    button.title = label;
    button.setAttribute('aria-label', label);
  } });
}

const settingsFrame = initSettings(settingsDialog);
let bridgeSettingsRevision = 0;   // ignore responses after this dialog was closed or reopened
let bridgeSettingsState;

function drawBridgeSettings(state) {
  bridgeSettingsState = state;
  $('bridge-settings').hidden = false;
  $('bridge-allow-legacy').checked = state.allowLegacy;
  $('bridge-native-delivery').checked = state.nativeDelivery;
  $('bridge-secondary-setting').hidden = state.role !== 'secondary';
  $('bridge-key-migrated').hidden = !state.keyMigrated;
  // data-i18n: a language switch (translateStatic) keeps this line, and the key button below, in step with the state.
  const role = state.role === 'active' ? '活动 Hub' : state.nativeDelivery ? '第二实例，已允许投递' : '第二实例：不投递';
  $('bridge-hub-role').dataset.i18n = role;
  $('bridge-hub-role').textContent = t(role);
}

function hideBridgeKey() {
  $('bridge-key-text').textContent = '';
  $('bridge-key-value').hidden = true;
  $('bridge-reveal-key').setAttribute('aria-expanded', 'false');
  $('bridge-reveal-key').dataset.i18n = '显示接入密钥';
  $('bridge-reveal-key').textContent = t('显示接入密钥');
}

async function loadBridgeSettings() {
  const revision = ++bridgeSettingsRevision;
  $('bridge-settings').hidden = true;
  hideBridgeKey();
  showError('bridge-settings-error', null);
  try {
    const state = await api('GET', '/api/bridge-settings');
    if (revision === bridgeSettingsRevision) drawBridgeSettings(state);
  } catch { /* an old Hub has no bridge settings */ }
}

async function saveBridgeSettings(input, data, revision) {
  input.disabled = true;
  showError('bridge-settings-error', null);
  try {
    const state = await api('PATCH', '/api/bridge-settings', data);
    if (revision === bridgeSettingsRevision) drawBridgeSettings(state);
  } catch (e) {
    if (revision === bridgeSettingsRevision) {
      drawBridgeSettings(bridgeSettingsState);
      showError('bridge-settings-error', e.message);
    }
  } finally { input.disabled = false; }
}

$('bridge-allow-legacy').addEventListener('change', (event) => {
  const input = event.currentTarget;
  void saveBridgeSettings(input, { allowLegacy: input.checked }, bridgeSettingsRevision);
});
$('bridge-native-delivery').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const nativeDelivery = input.checked;
  const revision = bridgeSettingsRevision;
  if (nativeDelivery && !await confirmDialog({
    title: lt('允许第二实例投递？'),
    message: lt('请确认同一个原生对话只绑定在一个正在投递的 Hub 上。'),
    confirmText: lt('允许投递'),
  })) {
    if (revision === bridgeSettingsRevision) drawBridgeSettings(bridgeSettingsState);
    return;
  }
  if (revision === bridgeSettingsRevision) void saveBridgeSettings(input, nativeDelivery ? { nativeDelivery, confirmed: true } : { nativeDelivery }, revision);
});
$('bridge-reveal-key').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!$('bridge-key-value').hidden) return hideBridgeKey();
  const revision = bridgeSettingsRevision;
  button.disabled = true;
  showError('bridge-settings-error', null);
  try {
    const { key } = await api('POST', '/api/bridge-settings/reveal', {});
    if (revision !== bridgeSettingsRevision) return;
    $('bridge-key-text').textContent = key;
    $('bridge-key-value').hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.dataset.i18n = '隐藏接入密钥';
    button.textContent = t('隐藏接入密钥');
  } catch (e) {
    if (revision === bridgeSettingsRevision) showError('bridge-settings-error', e.message);
  } finally { button.disabled = false; }
});
$('open-settings').addEventListener('click', () => {
  render();
  settingsFrame.opened();
  settingsDialog.showModal();
  void loadBridgeSettings();
  pluginSettings.load();
  disposeInstallPanel();
  installPanel = mountPluginInstall($('plugin-install-settings'), { api: featureApi, onInstalled: () => pluginSettings.load() });
});
$('settings-close').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('close', () => {
  ++bridgeSettingsRevision;
  hideBridgeKey();
  disposeInstallPanel();
  $('open-settings').focus();
});
$('usage-alert-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const turnTokens = Number($('usage-alert-turn').value), conversationTokens = Number($('usage-alert-conversation').value);
  if (!Number.isSafeInteger(turnTokens) || turnTokens < 0 || !Number.isSafeInteger(conversationTokens) || conversationTokens < 0) {
    return showError('usage-alert-error', t('请输入非负整数。'));
  }
  $('usage-alert-save').disabled = true;
  showError('usage-alert-error', null);
  try { await api('PATCH', '/api/settings', { usageAlert: { turnTokens, conversationTokens } }); }
  catch (error) { showError('usage-alert-error', t('保存失败：{message}', { message: error.message })); }
  finally { $('usage-alert-save').disabled = false; }
});

$('quit').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: lt('退出 orrery？'), message: lt('退出后 Hub 停止，群员收不到新消息，直到你再次打开 orrery。'), confirmText: lt('退出'), danger: true,
  });
  if (!ok) return;   // cancelled: nothing is sent
  quitting = true;   // before the request: the Hub drops this page's stream while it closes
  try {
    await api('POST', '/api/shutdown', {});
    stream?.close();
    $('quit-screen').hidden = false;
  } catch (e) {
    quitting = false;
    if (stream?.readyState === EventSource.CLOSED) connect(S.lastSeq, true);
    noticeDialog(lt('退出失败：{message}', { message: e.message }));
  }
});

$('pause').addEventListener('click', async () => {
  try {
    // The resulting 'pause' event updates S.paused; the response could be older than a newer event.
    await api('POST', '/api/pause', { paused: !S.paused });
  } catch (e) {
    noticeDialog(lt('切换暂停失败：{message}', { message: e.message }));
  }
});

for (const f of NOTIFY_FORMS) {
  const $f = (part) => $(`${f.id}-${part}`);
  $f('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $f('error');
    const sub = notifySubmission(f.setting, $f('value').value);
    if (sub.error) {
      err.textContent = sub.error;
      err.hidden = false;
      return;
    }
    err.hidden = true;
    $f('save').disabled = true;
    try {
      // The resulting 'settings' event updates S.settings; the response could be older.
      await api('PATCH', '/api/settings', sub.body);
      f.stale = true;
    } catch (e) {
      err.textContent = t('保存失败：{message}', { message: e.message });
      err.hidden = false;
      try { setSettings(await api('GET', '/api/settings')); } catch { /* keep what we have */ }
      f.stale = true;
    } finally {
      $f('save').disabled = false;
      render();
    }
  });
}

for (const f of LIMIT_FORMS) {
  const $f = (part) => $(`${f.id}-${part}`);
  $f('unlimited').addEventListener('change', () => { $f('value').disabled = $f('unlimited').checked; });
  $f('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $f('error');
    const input = { unlimited: $f('unlimited').checked, value: $f('value').value };
    const sub = limitSubmission(f.setting, input);
    if (sub.error) {
      err.textContent = sub.error;
      err.hidden = false;
      return;
    }
    err.hidden = true;
    if (sub.confirm && !(await confirmDialog(liveAsk(() => limitSubmission(f.setting, input).confirm)))) {   // cancelled: nothing is sent, the form shows the Hub's value again
      f.stale = true;
      render();
      return;
    }
    $f('save').disabled = true;
    try {
      // The resulting 'settings' event updates S.settings (and every other open page); the response could be older.
      await api('PATCH', '/api/settings', sub.body);
      f.stale = true;
    } catch (e) {
      err.textContent = t('保存失败：{message}', { message: e.message });
      err.hidden = false;
      try { setSettings(await api('GET', '/api/settings')); } catch { /* keep what we have */ }
      f.stale = true;
    } finally {
      $f('save').disabled = false;
      render();
    }
  });
}

function readAsDataUrl(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * A reusable preset avatar picker component. Returns { el, value(), set(name), refresh() }.
 */
function presetPicker(onPick = () => {}, container = null) {
  let selected = null;
  const el = container || h('div', { class: 'preset-avatars' });
  const render = () => {
    el.replaceChildren(...S.avatars.map((name) => h('button', {
      type: 'button', class: `preset-avatar${selected === name ? ' selected' : ''}`, 'aria-pressed': String(selected === name),
      title: lt('使用预设头像 {name}', { name: name }),
      onclick: () => {
        selected = selected === name ? null : name;
        onPick(selected);
        render();
      },
    }, h('img', { src: `/avatars/${name}.png`, alt: '' }))));
    el.hidden = !S.avatars.length;
  };
  render();
  return {
    el,
    value: () => selected,
    set(name) { selected = name || null; render(); },
    refresh: render,
  };
}

/**
 * A name/avatar editor from #editor-template, used on the member page and in the manage dialog. `member()` is the
 * member being edited, or null once it is gone or removed; `onSaved` runs after a successful PATCH.
 */
function memberEditor(member, onSaved = () => {}) {
  const form = $('editor-template').content.firstElementChild.cloneNode(true);
  let dirty = false;   // changed since the last fill or save (a reload after a Hub restart would lose it)
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });
  const field = (n) => form.querySelector(`[name=${n}]`);
  const part = (r) => form.querySelector(`[data-role=${r}]`);
  const setError = (text) => { part('error').textContent = text ?? ''; part('error').hidden = !text; };
  const presets = presetPicker((p) => {
    dirty = true;
    if (p) field('emoji').value = '';
  }, part('presets'));

  field('emoji').addEventListener('input', () => {
    if (!presets.value() || !field('emoji').value.trim()) return;   // an emoji typed over a pick replaces it
    presets.set(null);
  });
  const save = async (m, fields) => {
    setError(null);
    part('save').disabled = true;
    try {
      // The resulting 'member' event updates the page; applying the response could undo a newer rename.
      await api('PATCH', `/api/members/${encodeURIComponent(m.id)}`, fields);
      dirty = false;
      onSaved();
    } catch (e) {
      setError(t('保存失败：{message}', { message: e.message }));
    } finally {
      part('save').disabled = false;
    }
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = member();
    if (!m) return;
    const { fields, error } = await editFields(m, {
      name: field('name').value, emoji: field('emoji').value, file: field('file').files[0], preset: presets.value(),
    }, readAsDataUrl);
    if (error) return setError(error);
    if (Object.keys(fields).length) await save(m, fields);
  });
  field('file').addEventListener('change', () => {
    part('file-name').textContent = field('file').files[0]?.name ?? '';
    if (field('file').files[0] && presets.value()) presets.set(null);   // an upload wins over a pick
  });
  part('reset-avatar').addEventListener('click', () => {
    presets.set(null);
    field('emoji').value = '';
    field('file').value = '';
    part('file-name').textContent = '';
    const m = member();
    if (m) save(m, { avatar: null });
  });
  return {
    form,
    actions: part('actions'),
    /** Redraws the preset row (avatars arrive after the editors are built, when the page loads). */
    refreshPresets: presets.refresh,
    dirty: () => dirty,
    fill(m) {
      dirty = false;
      field('name').value = m.name;
      part('default-avatar').replaceChildren(avatarEl({ ...m, avatar: null }, 'xs'));   // what 恢复默认头像 returns to
      presets.set(presetName(m.avatar));
      field('emoji').value = m.avatar && !m.avatar.startsWith('data:') && !presets.value() ? m.avatar : '';
      field('file').value = '';
      part('file-name').textContent = '';
      setError(null);
    },
  };
}

const panelEditor = memberEditor(() => {
  const m = S.members.get(S.sel.member);
  return m && !m.removedAt ? m : null;
});
$('member-edit').append(panelEditor.form);

// ---- create cluster ----

const dialog = $('create-dialog');
let addToCluster = null;
let harnessForms = [];   // [{ harness, check, pick, row, body, setShown(on), revealProblem(), refreshPresets(), choice() }] — async choice() returns the input of harnessSpecs (ui.js)

const NAME_HINT = lt('只允许字母、数字、汉字、_ . -，不含空格；不填按模型命名');
const CLAUDE_HINT = lt('原生 Claude 只能接入已有会话：先在 Claude Desktop 里新建一个本地会话并发一句话（会话要能加载 orrery 桥，见 README「原生模式：Claude」），再点「刷新」，选它的项目并勾选它。会话在 Desktop 里开着时显示在线。');
const ANTIGRAVITY_HINT = lt('原生 Antigravity 只能接入 Antigravity 2.0 里已有、并且打开过工作区的对话：先按 README「原生模式：Antigravity」装好并启用 orrery sidecar、hook 和 MCP 条目，在应用里新建对话并发一句话，再点「刷新」，选它的项目并勾选它。应用开着、sidecar 已启用时显示在线。');
const ZCODE_HINT = lt('原生 ZCode 只能接入 ZCode 里已有的本地工作区对话：先按 README「原生模式：ZCode」在 ZCode 里加好 orrery 的 MCP 条目，在应用里新建对话并发一句话，再点「刷新」，选它的项目并勾选它。接入后在那个对话里说一句「加入 orrery」，它挂上等待命令后才显示在线；ZCode 每次重启后要再说一次。');
const WORKBUDDY_HINT = lt('原生 WorkBuddy 只能接入 WorkBuddy 里已有的本地对话：先按 README「原生模式：WorkBuddy」在 WorkBuddy 里添加并信任 orrery 的 stdio MCP 服务器，在应用里新建对话并发一句话，再点「刷新」，选它的项目并勾选它。接入后在那个对话里说一句「加入 orrery」，它挂上等待命令后才显示在线；对话进程被回收后要再说一次。');
const QODER_HINT = lt('原生 Qoder 只能接入 Qoder 里已有的对话：先按 README「原生模式：Qoder」装好 orrery 的 Qoder 插件，在应用里新建对话并发一句话，再点「刷新」，选它的项目并勾选它。接入后在那个对话里说一句「加入 orrery」，它挂上等待命令后才显示在线；Qoder 每次重启后要再说一次。「每次询问」审批模式下等待命令每次都要你点允许，不承诺无人值守。');
const CURSOR_HINT = lt('原生 Cursor 只能接入 Cursor 里已有、跑过至少一轮的 agent 对话：先按 README「原生模式：Cursor」装好 orrery 的 Cursor 插件（hook 和 MCP），在应用里新建对话并发一句话，再点「刷新」，选它的项目并勾选它。每轮结束后对话挂着等待时显示在线；离线时在 Cursor 里对它说一句话，这一轮结束后重新上线。投进来的消息显示成你自己发的、首行带 [orrery · 来自 …]。');
/** The Antigravity hint, plus the language server version the connected sidecar reported (read when the form opens). */
function antigravityHint() {
  const version = h('span');
  api('GET', '/api/harness-modes').then((modes) => {
    const v = modes.find((m) => m.harness === 'antigravity')?.bridgeVersion;
    version.textContent = v ? t(' 当前连着的 Antigravity 语言服务器版本：{v}。', { v: v }) : t(' 现在没有 sidecar 连着 Hub。');
  }, () => {});
  return h('p', { class: 'hint' }, ANTIGRAVITY_HINT, version);
}
const harnessPath = (harness, rest) => `/api/harnesses/${encodeURIComponent(harness)}/${rest}`;

// Project and session lists being (re)loaded. Create and refresh wait for them: a submit while a list is reloading
// would not see the conversations picked in it.
let listLoads = 0;
let creating = false;
function syncCreateButtons() {
  $('create-submit').disabled = creating || listLoads > 0;
  $('create-cancel').disabled = creating;
  $('create-harnesses').disabled = creating;
  for (const b of document.querySelectorAll('#create-harnesses .refresh')) b.disabled = listLoads > 0;
}
function trackLoad(promise) {
  listLoads++;
  syncCreateButtons();
  return promise.finally(() => { listLoads--; syncCreateButtons(); });
}

const projectRequests = new WeakMap();   // select → number of its latest request; older answers are dropped
/**
 * (Re)fills a project select, keeping its first (placeholder) option and the choice the select has when
 * the answer arrives (the user may have switched meanwhile), if it is still listed. Resolves false for a stale answer.
 */
function loadProjects(select, harness) {
  const mine = (projectRequests.get(select) ?? 0) + 1;
  projectRequests.set(select, mine);
  return trackLoad((async () => {
    const projects = await api('GET', harnessPath(harness, 'projects'));
    if (projectRequests.get(select) !== mine) return false;
    const keep = select.value;
    select.replaceChildren(select.options[0], ...projects.map((p) => h('option', { value: p.path, title: p.path }, p.label || p.path)));
    if ([...select.options].some((o) => o.value === keep)) select.value = keep;
    return true;
  })());
}

/** Names of the cluster the dialog adds to; the Hub makes a default name unique among them (memberDefaultName). */
const takenNames = () => new Set(addToCluster ? membersOf(addToCluster).map((m) => m.name) : []);

/**
 * The name input of one member being added. It shows `auto()`, the name the Hub would give the member, until the
 * user types another one. What it shows is what is sent, so the member gets the name the user saw (the Hub still
 * adds -2 when two members of one submission would share it); emptied, the Hub names the member itself.
 */
function nameField(auto) {
  const input = h('input', { placeholder: lt('不填按模型命名'), title: NAME_HINT });
  let edited = false;
  input.addEventListener('input', () => { edited = Boolean(input.value.trim()); });
  const update = () => { if (!edited) input.value = auto(); };
  update();
  return {
    input, update,
    value: () => input.value.trim(),
  };
}

/**
 * The avatar inputs of one member being added: an emoji, a preset, or an uploaded image. `value()` resolves the one
 * that is sent ('' for none) with the editors' precedence (editFields: upload, then emoji, then preset).
 */
function avatarFields(harness) {
  const emoji = h('input', { placeholder: lt('例如 🦊'), maxlength: 16 });
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
  const fileName = h('span', { class: 'muted' });
  const presets = presetPicker((p) => { if (p) emoji.value = ''; });
  emoji.addEventListener('input', () => { if (emoji.value.trim()) presets.set(null); });
  fileInput.addEventListener('change', () => {
    fileName.textContent = fileInput.files[0]?.name ?? '';
    if (fileInput.files[0]) presets.set(null);
  });
  const reset = h('button', {
    type: 'button', class: 'small with-avatar',
    onclick: () => { presets.set(null); emoji.value = ''; fileInput.value = ''; fileName.textContent = ''; },
  }, harnessApp(harness).icon ? avatarEl({ name: '', harness, avatar: null }, 'xs') : null, lt('清除头像'));   // the default it returns to
  return {
    el: h('div', { class: 'avatar-fields' },
      h('label', {}, lt('头像 emoji'), emoji),
      h('div', {}, h('span', { class: 'muted' }, lt('或选一个预设头像')), presets.el),
      h('div', {},
        h('span', { class: 'muted' }, lt('或上传图片（PNG/JPEG/GIF/WebP，≤256 KB）')),
        h('div', { class: 'row' }, h('label', { class: 'button small' }, lt('选择图片…'), fileInput), fileName, reset))),
    refreshPresets: presets.refresh,
    async value() {
      const { fields, error } = await editFields({ name: '', avatar: null },
        { name: '', emoji: emoji.value, file: fileInput.files[0], preset: presets.value() }, readAsDataUrl);
      if (error) throw new Error(error);
      return fields.avatar ?? '';
    },
  };
}

/** Name / avatar / model / effort for one new member. Model and effort are selects from the models endpoint, free text when it lists none. */
function newMemberFields(harness) {
  const model = h('select', {}, h('option', { value: '' }, lt('默认')));
  const effort = h('select', {}, h('option', { value: '' }, lt('默认')));
  const modelText = h('input', { placeholder: lt('默认（可填模型名）'), hidden: true });
  const effortText = h('input', { placeholder: lt('默认'), hidden: true });
  const note = h('p', { class: 'muted', hidden: true });
  let models = [];
  let loaded = false;
  const name = nameField(() => memberDefaultName({
    harness, model: models.length ? model.value : modelText.value.trim(), models, taken: takenNames(),
  }));
  const avatar = avatarFields(harness);
  const fillEfforts = () => {
    const keep = effort.value;
    const list = effortChoices(models, model.value);
    effort.replaceChildren(h('option', { value: '' }, lt('默认')), ...list.map((e) => h('option', { value: e }, e)));
    effort.value = list.includes(keep) ? keep : '';
    effort.disabled = list.length === 0;
  };
  model.addEventListener('change', () => { name.update(); fillEfforts(); });
  modelText.addEventListener('input', name.update);
  return {
    el: h('div', { class: 'fields' },
      h('label', {}, lt('名字'), name.input), h('label', {}, lt('模型'), model, modelText), h('label', {}, lt('思考强度'), effort, effortText),
      avatar.el, note),
    refreshPresets: avatar.refreshPresets,
    name: name.value,
    async load() {
      if (loaded) return;
      loaded = true;
      try {
        models = await api('GET', harnessPath(harness, 'models'));
      } catch (e) {
        models = [];
        note.textContent = t('模型列表加载失败（{message}），可以手填。', { message: e.message });
        note.hidden = false;
      }
      if (models.length) {
        model.append(...models.map((m) => h('option', { value: m.id, title: m.id }, `${m.label || m.id}${m.isDefault ? t('（默认）') : ''}`)));
        fillEfforts();
      } else {
        model.hidden = effort.hidden = true;
        modelText.hidden = effortText.hidden = false;
      }
      name.update();
    },
    async value() {
      return {
        name: name.value(), avatar: await avatar.value(),
        ...(models.length ? { model: model.value, effort: effort.value } : { model: modelText.value, effort: effortText.value }),
      };
    },
  };
}

/** Name / avatar for one picked existing conversation; its default name follows the model the conversation lists. */
function attachEditor(s, harness) {
  const name = nameField(() => memberDefaultName({ harness, model: s.model ?? '', taken: takenNames() }));
  const avatar = avatarFields(harness);
  return {
    el: h('div', { class: 'attach-member' }, h('b', { class: 't', title: s.id }, s.title || s.id),
      h('div', { class: 'fields' }, h('label', {}, lt('名字'), name.input), avatar.el)),
    refreshPresets: avatar.refreshPresets,
    name: name.value,
    async value() { return { sessionId: s.id, name: name.value(), avatar: await avatar.value() }; },
  };
}

/** A listed conversation's availability to `clusterId`, and the line under its title (why not, where it is, or model · time). */
function sessionInfo(s, clusterId) {
  const { disabled, reason, memberships } = sessionAvailability(s, clusterId);
  const groups = memberships.map((m) => t('{clusterName}（群内名：{memberName}{value}）', { clusterName: m.clusterName, memberName: m.memberName, value: m.hidden ? `，${t(HIDDEN_MARK)}` : '' })).join('、');
  const description = [reason, groups ? t('已在：{groups}', { groups: groups }) : '', !groups && !reason ? [s.model, s.updatedAt && fmtTime(s.updatedAt)].filter(Boolean).join(' · ') : ''].filter(Boolean).join(' · ');
  return { disabled, reason, description };
}

/** One listed conversation; its checkbox picks it (`toggle(s, checked)`). */
function sessionRow(s, picked, toggle, { clusterId = addToCluster, type = 'checkbox', name = null } = {}) {
  const { disabled, reason, description } = sessionInfo(s, clusterId);
  return h('label', { class: `session${disabled ? ' taken' : ''}`, title: reason || s.id },
    h('input', {
      type, name, value: s.id, disabled, checked: picked.has(s.id) && !disabled,
      onchange: (e) => toggle(s, e.target.checked),
    }),
    h('span', { class: 'session-details' }, h('span', { class: 't' }, s.title || s.id),
      description ? h('span', { class: 'muted session-groups' }, description) : null),
    typeof s.online === 'boolean' ? h('span', { class: `online ${s.online ? 'on' : 'off'}` }, s.online ? lt('在线') : lt('离线')) : null);
}

// The create dialog is two panes (docs/cluster-members.md「添加成员」): the app list on the left, the one app in
// focus on the right. Focusing shows an app; ticking decides whether it is submitted.
let createFocus = null;   // harness whose settings the right pane shows
/** Shows `harness` in the right pane; `open` also turns a narrow dialog to that pane (on a wide one both are shown). */
function focusApp(harness, { open = false } = {}) {
  createFocus = harness;
  for (const f of harnessForms) f.setShown(f.harness === harness);
  if (open) $('create-harnesses').classList.add('show-detail');
}

/**
 * The member entries of one app in the create dialog (its listed conversations and a new conversation) and one editor
 * area for the entry in focus: only that entry's name / avatar inputs are shown, so picking
 * many conversations does not lengthen the pane. Rows work like the app list: a click shows the entry, ticking shows
 * it too, unticking keeps the editor where it is. An entry: { key, title, details, online?, check, picked(),
 * editor() → { el } (null: it cannot be added, `reason` says why), reason, name() }.
 */
function entryList({ label, hint, onOpen, onBack, onEdit }) {
  const list = h('div', { class: 'entry-list', role: 'group', 'aria-label': label });
  const editor = h('section', { class: 'entry-editor', 'aria-label': lt('{label}：成员信息', { label: label }) });
  const back = h('button', { type: 'button', class: 'small entry-back' }, icon('chevron-left', 'ico-sm'), lt('对话列表'));
  const area = h('div', { class: 'entry-area' }, list, h('div', { class: 'entry-editor-wrap' }, back, editor));
  let rows = [];        // [{ entry, row, pick, nameEl, problemEl }]
  let focused = null;   // key of the entry the editor shows
  const show = (key, { open = false } = {}) => {
    focused = key;
    const shown = rows.find((r) => r.entry.key === key);
    const at = Math.max(0, rows.indexOf(shown));   // the one row in the Tab order: the shown one, else the first
    rows.forEach((r, i) => {
      r.row.classList.toggle('current', r === shown);
      r.pick.setAttribute('aria-current', r === shown ? 'true' : 'false');
      r.entry.check.tabIndex = r.pick.tabIndex = i === at ? 0 : -1;
    });
    const content = shown ? shown.entry.editor()?.el ?? h('p', { class: 'muted' }, lt('这个对话不能加入：{reason}', { reason: shown.entry.reason })) : h('p', { class: 'muted' }, hint);
    if (editor.firstChild !== content) editor.replaceChildren(content);   // the same editor stays put: no lost focus or input
    if (open && shown) onOpen();
  };
  const makeRow = (entry) => {
    const nameEl = h('span', { class: 'entry-name' });
    const problemEl = h('span', { class: 'app-row-problem', hidden: true });
    const pick = h('button', { type: 'button', class: 'entry-main' }, h('span', { class: 't' }, entry.title),
      entry.details ? h('span', { class: 'muted session-groups' }, entry.details) : null, nameEl, problemEl);
    const row = h('div', { class: `entry-row${entry.reason ? ' taken' : ''}`, title: entry.reason || '' }, entry.check, pick,
      typeof entry.online === 'boolean' ? h('span', { class: `online ${entry.online ? 'on' : 'off'}` }, entry.online ? lt('在线') : lt('离线')) : null);
    pick.addEventListener('click', () => show(entry.key, { open: true }));
    // Arrow keys, Home and End move between the rows and show the row they reach; Tab goes on to the editor.
    row.addEventListener('keydown', (e) => {
      const next = rowAfterKey(rows.findIndex((r) => r.entry === entry), rows.length, e.key);
      if (next === null) return;
      e.preventDefault();
      const target = rows[next];
      show(target.entry.key);
      (e.target === entry.check && !target.entry.check.disabled ? target.entry.check : target.pick).focus();
    });
    return { entry, row, pick, nameEl, problemEl };
  };
  back.addEventListener('click', () => { onBack(); rows.find((r) => r.entry.key === focused)?.pick.focus(); });
  // A name typed, or a model picked (it changes the default name), in the editor redraws the rows' names and markers.
  editor.addEventListener('input', onEdit);
  editor.addEventListener('change', onEdit);
  return {
    area, list, show,
    focused: () => focused,
    /** Replaces the rows; `note` (loading, empty, failed) goes above them. The shown entry stays if it is still listed. */
    setRows(entries, note = null) {
      rows = entries.map(makeRow);
      list.replaceChildren(...(note ? [note] : []), ...rows.map((r) => r.row));
      show(focused);
    },
    /** Each row's member name, and the marker of `problems` (key → text) on a picked row. */
    sync(problems) {
      for (const r of rows) {
        r.nameEl.textContent = t('成员名：{value}', { value: r.entry.name() || t('由 Hub 起名') });
        const p = r.entry.picked() ? problems.get(r.entry.key) : null;
        r.problemEl.replaceChildren(...(p ? [icon('alert', 'ico-sm'), ` ${p}`] : []));
        r.problemEl.hidden = !p;
      }
    },
  };
}

/** One harness in the create dialog: its list row, and its settings (its conversations; docs/native-mode.md「网页（单元 4）」). */
function harnessForm({ harness, nativeCreate }) {
  let shown = false;
  const app = harnessApp(harness);
  const appLogo = () => appIcon({ icon: app.icon, label: app.name });   // the app's logo; icon stays the sprite helper
  const check = h('input', { type: 'checkbox', 'aria-label': lt('添加 {name}', { name: app.name }) });
  const summary = h('span', { class: 'app-row-summary' });
  const problem = h('span', { class: 'app-row-problem', hidden: true });
  const pick = h('button', { type: 'button', class: 'app-row-main', 'aria-controls': 'create-detail' },
    appLogo(), h('span', { class: 'app-row-text' }, h('span', { class: 'app-row-name' }, app.name), summary, problem));
  const row = h('li', { class: 'app-row' }, check, pick);
  const error = h('p', { class: 'form-error', hidden: true });
  const fail = (what) => (e) => { error.textContent = t('{what}失败：{message}', { what: what, message: e.message }); error.hidden = false; sync(); };
  const note = (text) => h('p', { class: 'muted' }, text);
  const lists = { onOpen: () => body.classList.add('show-entry'), onBack: () => body.classList.remove('show-entry'), onEdit: () => sync() };

  // Attach existing conversations, and create one when the harness supports it.
  const nProject = h('select', {}, h('option', { value: '' }, lt('选择项目…')));
  const refresh = h('button', { type: 'button', class: 'small refresh', title: lt('重新读取项目和对话列表') }, lt('刷新'));
  const nCreate = nativeCreate ? h('input', { type: 'checkbox', 'aria-label': lt('另外新建一个对话') }) : null;
  const nFields = nativeCreate ? newMemberFields(harness) : null;
  const nList = entryList({ label: lt('已有对话'), hint: lt('点一个对话，在这里设置它加入后的名字和头像。'), ...lists });
  const nSec = h('div', { class: 'mode-body' },
    h('div', { class: 'project-row' }, h('label', {}, lt('项目'), nProject), refresh),
    h('span', { class: 'muted' }, lt('已有对话（可多选；接入后你照常在应用里用它）。点一个对话设置它的名字和头像。')),
    nList.area,
    nativeCreate
      ? h('p', { class: 'muted' }, lt('新建对话前请选择项目，并勾选「另外新建一个对话」。'))
      : harness === 'antigravity' ? antigravityHint()
        : h('p', { class: 'hint' }, harness === 'claude' ? CLAUDE_HINT : harness === 'zcode' ? ZCODE_HINT : harness === 'workbuddy' ? WORKBUDDY_HINT : harness === 'qoder' ? QODER_HINT : harness === 'cursor' ? CURSOR_HINT : lt('{harness} 的原生群员只能接入已有会话：先在应用里新建会话，再点「刷新」勾选它。', { harness: harness })));

  // Picked conversations of the shown project, in the order they were picked, and the name / avatar editor of each
  // conversation shown or picked so far (an unticked one keeps what was typed until the dialog closes). Kept apart
  // from the list, so a reload (refresh) cannot drop them; cleared when the user switches project.
  const picked = new Set();
  const editors = new Map();
  const editorFor = (s) => editors.get(s.id) ?? editors.set(s.id, attachEditor(s, harness)).get(s.id);
  const toggle = (s, on) => {
    if (on) { editorFor(s); picked.add(s.id); check.checked = true; } else picked.delete(s.id);   // picking a conversation of an unticked app means adding it
    nList.show(focusAfterTick(nList.focused(), s.id, on));
    sync();
  };
  const newEntry = nativeCreate && {
    key: 'new', title: lt('另外新建一个对话'), details: lt('在应用里新建，可选模型和思考强度'), check: nCreate, reason: '',
    picked: () => nCreate.checked, editor: () => { nFields.load(); return nFields; }, name: () => nFields.name(),
  };
  const sessionEntry = (s) => {
    const { disabled, reason, description } = sessionInfo(s, addToCluster);
    const c = h('input', { type: 'checkbox', disabled, checked: picked.has(s.id) && !disabled, 'aria-label': lt('选择 {value}', { value: s.title || s.id }) });
    c.addEventListener('change', () => toggle(s, c.checked));
    return {
      key: s.id, title: s.title || s.id, details: description, online: s.online, check: c, reason: disabled ? reason || lt('已是群员') : '',
      picked: () => picked.has(s.id), editor: () => (disabled ? null : editorFor(s)),
      name: () => editors.get(s.id)?.name() ?? memberDefaultName({ harness, model: s.model ?? '', taken: takenNames() }),
    };
  };
  const setSessions = (entries, status = null) => { nList.setRows([...entries, ...(newEntry ? [newEntry] : [])], status); sync(); };
  let request = 0;   // only the latest session-list request may touch the list
  const loadSessions = () => {
    const path = nProject.value;
    const mine = ++request;
    if (!path) {
      picked.clear();
      editors.clear();
      setSessions([], note(lt('选一个项目以列出它的已有对话。')));
      return;
    }
    setSessions([], note(lt('加载中…')));
    trackLoad(showSessions(path, mine));
  };
  const showSessions = async (path, mine) => {
    try {
      const list = await api('GET', harnessPath(harness, `sessions?project=${encodeURIComponent(path)}`));
      if (mine !== request) return;   // the user picked another project (or refreshed) meanwhile
      // Drop a picked conversation if it disappeared or became unavailable to this cluster.
      for (const id of picked) if (!list.some((s) => s.id === id && !sessionAvailability(s, addToCluster).disabled)) picked.delete(id);
      setSessions(list.map(sessionEntry), list.length ? null
        : note(nativeCreate ? lt('这个项目里没有已有对话。') : lt('这个项目里还没有会话：在桌面应用里新建并发一句话，再点「刷新」。')));
    } catch (e) {
      if (mine !== request) return;
      setSessions([], h('p', { class: 'form-error' }, lt('对话加载失败：{message}', { message: e.message })));
    }
  };
  let projectsLoaded = false;
  const projectsOnce = () => {
    if (projectsLoaded) return;
    projectsLoaded = true;
    loadProjects(nProject, harness).catch(fail(t('项目加载')));
  };
  // The picked entries with the names they send, and what is wrong with those names (key → text).
  const pickedNames = () => [...[...picked].map((id) => ({ key: id, name: editors.get(id).name() })),
    ...(nCreate?.checked ? [{ key: 'new', name: nFields.name() }] : [])];
  const problems = () => {
    const all = pickedNames();
    const taken = takenNames();
    return new Map(all.map((e) => [e.key, memberNameProblem(e.name, taken, all.filter((o) => o !== e).map((o) => o.name))]).filter(([, p]) => p));
  };
  const sync = () => {
    const found = problems();
    nList.sync(found);
    const s = appRowSummary({
      harness, nativeCreate, checked: check.checked, create: Boolean(nCreate?.checked),
      project: nProject.value, sessions: [...picked].map((sessionId) => ({ sessionId })),
      loadFailed: !error.hidden || Boolean(nList.list.querySelector('.form-error')),
      memberProblem: found.size > 0,
    });
    summary.textContent = s.text;
    problem.replaceChildren(...(s.problem ? [icon('alert', 'ico-sm'), ` ${s.problem}`] : []));
    problem.hidden = !s.problem;
    row.classList.toggle('ticked', check.checked);
    notTicked.hidden = check.checked;
  };
  // Lists load once the app is ticked or shown, whichever comes first.
  const update = () => {
    sync();
    if (!check.checked && !shown) return;
    projectsOnce();
    if (nCreate?.checked) nFields.load();
  };

  const tick = () => { check.checked = true; check.dispatchEvent(new Event('change')); };
  const notTicked = h('p', { class: 'hint not-ticked' }, lt('未勾选：这里填的内容会保留，但不会提交。'),
    h('button', { type: 'button', class: 'small', onclick: tick }, lt('勾选 {name}', { name: app.name })));
  const back = h('button', { type: 'button', class: 'small app-back', onclick: () => { $('create-harnesses').classList.remove('show-detail'); pick.focus(); } }, icon('chevron-left', 'ico-sm'), lt('应用列表'));
  const body = h('section', { class: 'harness-body', hidden: true, 'aria-label': lt('{name} 的设置', { name: app.name }) },
    h('div', { class: 'app-detail-head' }, back, appLogo(), h('h3', {}, app.name)), notTicked, nSec, error);

  check.addEventListener('change', () => { update(); focusApp(focusAfterTick(createFocus, harness, check.checked)); });
  nCreate?.addEventListener('change', () => {
    if (nCreate.checked) check.checked = true;   // a new conversation also means adding the app
    nList.show(focusAfterTick(nList.focused(), 'new', nCreate.checked));
    update();
  });
  nProject.addEventListener('change', () => { picked.clear(); editors.clear(); loadSessions(); });
  refresh.addEventListener('click', () => {
    error.hidden = true;
    loadProjects(nProject, harness).then((fresh) => { if (fresh) loadSessions(); }, (e) => { fail(t('项目加载'))(e); loadSessions(); });
  });
  // Arrow keys, Home and End move between the rows (only the shown row is in the Tab order) and show the row they reach.
  row.addEventListener('keydown', (e) => {
    const next = rowAfterKey(harnessForms.findIndex((f) => f.harness === harness), harnessForms.length, e.key);
    if (next === null) return;
    e.preventDefault();
    const target = harnessForms[next];
    focusApp(target.harness);
    (e.target === check ? target.check : target.pick).focus();
  });
  pick.addEventListener('click', () => focusApp(harness, { open: true }));
  setSessions([], note(lt('选一个项目以列出它的已有对话。')));
  update();

  // Shows the app and one of its entries, wide or narrow (a submit error about that entry).
  const reveal = (key) => {
    focusApp(harness, { open: true });
    nList.show(key, { open: true });
  };
  const valueOf = async (key, editor) => {
    try { return await editor.value(); } catch (e) { e.reveal = () => reveal(key); throw e; }
  };
  harnessForms.push({
    harness, check, pick, row, body, sync,
    setShown(on) {
      shown = on;
      body.hidden = !on;
      row.classList.toggle('current', on);
      pick.setAttribute('aria-current', on ? 'true' : 'false');
      check.tabIndex = pick.tabIndex = on ? 0 : -1;
      if (on) update();
    },
    /** Shows the first picked entry with a name problem; false when there is none. */
    revealProblem() {
      const key = check.checked ? [...problems().keys()][0] : undefined;
      if (key !== undefined) reveal(key);
      return key !== undefined;
    },
    refreshPresets() {
      for (const f of [nFields, ...editors.values()]) f?.refreshPresets();
    },
    choice: async () => ({
      harness, nativeCreate, project: nProject.value,
      sessions: await Promise.all([...picked].map((id) => valueOf(id, editors.get(id)))),
      create: Boolean(nCreate?.checked),
      ...(nCreate?.checked && nFields ? await valueOf('new', nFields) : {}),
    }),
  });
}

function openCreate(clusterId = null) {
  if (creating) return;
  addToCluster = typeof clusterId === 'string' ? clusterId : null;
  $('create-title').textContent = addToCluster ? t('添加成员') : t('新建集群');
  $('create-name-row').hidden = Boolean(addToCluster);
  $('create-name').required = !addToCluster;
  $('create-submit').textContent = addToCluster ? t('添加') : t('创建');
  $('create-form').reset();
  harnessForms = [];
  const usable = S.modes.filter((m) => S.harnesses.includes(m.harness) && m.native);
  usable.forEach(harnessForm);
  $('create-apps').replaceChildren(...harnessForms.map((f) => f.row));
  $('create-detail').replaceChildren(...harnessForms.map((f) => f.body));
  $('create-harnesses').classList.remove('show-detail');
  focusApp(harnessForms[0]?.harness ?? null);
  syncCreateButtons();
  showError('create-error', null);
  dialog.showModal();
}

$('new-cluster').addEventListener('click', () => openCreate());
dialog.addEventListener('cancel', (e) => { if (creating) e.preventDefault(); });
$('create-cancel').addEventListener('click', () => dialog.close());
$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (listLoads > 0 || creating) return;   // the button is disabled then; Enter in a field could still submit
  // Locked from the first moment: reading an uploaded avatar is asynchronous, and a second click meanwhile would
  // otherwise post the same members again.
  const btn = $('create-submit');
  creating = true;
  syncCreateButtons();
  const clusterId = addToCluster;
  btn.textContent = clusterId ? t('添加中…') : t('创建中…');
  showError('create-error', null);
  try {
    const choices = [];
    for (const f of harnessForms) if (f.check.checked) choices.push(await f.choice());
    const { request, error, harness } = createRequest(clusterId, $('create-name').value, choices);
    if (error) {
      if (harness) focusApp(harness, { open: true });   // show the app the error is about
      return showError('create-error', error);
    }
    // The cluster itself arrives through the SSE 'cluster' event, like every other state change.
    const result = await api('POST', request.path, request.body);
    dialog.close();
    select(clusterId ?? result.cluster.id);
  } catch (err) {
    // Show the entry the error is about: an avatar that did not read, else (a Hub refusal) the first marked name.
    if (err.reveal) err.reveal(); else harnessForms.some((f) => f.revealProblem());
    showError('create-error', t('{value}失败：{message}', { value: clusterId ? t('添加') : t('创建'), message: err.message }));
  } finally {
    creating = false;
    syncCreateButtons();
    btn.textContent = clusterId ? t('添加') : t('创建');
  }
});

// ---- the member panel's list: open a member page, rename / change avatar, remove, add (was the manage dialog) ----

let managedCluster = null;  // the cluster the list's state below belongs to
let removing = false;
let manageError = null;
let manageNotice = '';
let editingId = null;      // the one member whose name/avatar editor is open in the list
let recentMember = null;   // the member whose page the panel showed last: its row is marked, and back from the page focuses it
let refocusRecent = false;
const closeEditor = () => {
  const id = editingId;
  const restoreFocus = canRestoreMemberFocus(managedCluster, manageEditor.form);
  editingId = null;
  renderManage();
  if (restoreFocus) focusRow(id, 'edit');
};
const manageEditor = memberEditor(() => activeMember([...S.members.values()], managedCluster, editingId), () => {
  manageNotice = t('已保存。');
  closeEditor();
});
manageEditor.form.classList.add('manage-edit');
manageEditor.actions.append(h('button', { type: 'button', class: 'small', onclick: closeEditor }, t('取消')));
const drawMemberList = stableList($('manage-list'));

/** Focuses a row's member button ('open') or one of its action buttons (memberRowActions key) after a redraw. */
function focusRow(memberId, what = 'open') {
  const row = [...$('manage-list').children].find((r) => r.dataset.member === memberId);
  row?.querySelector(what === 'open' ? '.member-open' : `.member-action[data-action="${what}"]`)?.focus();
  return Boolean(row);
}

function startEdit(m) {
  editingId = editingId === m.id ? null : m.id;
  if (editingId) manageEditor.fill(m);
  manageError = null;
  manageNotice = '';
  renderManage();
  if (!editingId) return;
  // The editor opens inside the member's own row: bring it into view and start in the name field.
  manageEditor.form.scrollIntoView({ block: 'nearest' });
  manageEditor.form.querySelector('[name=name]')?.focus();
}

function renderManage() {
  if (managedCluster !== S.sel.cluster && !removing) {   // another cluster: its list starts fresh
    managedCluster = S.sel.cluster;
    editingId = null;
    manageError = null;
    manageNotice = '';
    recentMember = null;
  }
  if (panelView() === 'member') { recentMember = S.sel.member; refocusRecent = true; }
  if (panelView() !== 'members') return;
  const members = membersOf(managedCluster);
  if (!members.some((m) => m.id === editingId)) editingId = null;   // removed meanwhile: its editor closes
  const counts = memberCounts(members, statusOf);
  $('members-title').textContent = t('群员 · {value}', { value: S.clusters.get(managedCluster)?.name ?? '' });
  // Each count stays whole when the header is narrow ("1 隐身", never "1" / "隐身").
  $('members-meta').replaceChildren(...memberSummary(counts.total, counts.online, counts.hidden).split(' · ')
    .flatMap((part, i) => [i ? ' · ' : '', h('span', { class: 'nowrap' }, part)]));
  const usage = S.usage?.clusterId === managedCluster ? S.usage : null;
  const tokensOf = (m) => memberTokensText(usage?.members.find((r) => r.memberId === m.id));
  const alertOf = (m) => usageAlertText(usage?.members.find((r) => r.memberId === m.id));
  // Model, project, conversation and the app's quota on each row (the quota used to be a block above the list).
  const detailsOf = (m) => memberDetails(m, usage?.members.find((r) => r.memberId === m.id),
    usage?.quotas.find((q) => q.harness === m.harness), { usageLoaded: Boolean(usage) });
  const details = new Map(members.map((m) => [m.id, detailsOf(m)]));
  const sig = [managedCluster, S.identity, editingId ?? '', removing ? 1 : 0, recentMember ?? '',
    ...members.map((m) => [m.id, statusOf(m), tokensOf(m), alertOf(m), JSON.stringify(details.get(m.id))].join('|'))].join('\n');
  // Each action is an icon button with a tooltip (data-tip, also on keyboard focus) and a name saying whose row it is.
  const act = {
    edit: (m) => startEdit(m),
    rebind: (m) => openRebind(m.id),
    hide: (m) => void toggleHidden(m.id),
    remove: (m) => void removeMember(m),
  };
  const appText = (m) => memberAppText(harnessApp(m.harness).name);
  // When the avatar already is the app's icon it is not repeated here; the words stay.
  const appBadge = (m) => {
    const app = harnessApp(m.harness);
    return h('span', { class: 'member-app', role: 'img', 'aria-label': appText(m), title: appText(m) },
      avatarKind(m) === 'app' ? null : appIcon({ icon: app.icon, label: app.name }));
  };
  const rowAvatar = (m) => {
    // On its orbit: the dot is the status, whose words are on the second line of the row.
    const el = avatarEl(m, 'sm', { presence: presenceOf(m) });
    if (avatarKind(m) === 'app') el.title = `${m.name} · ${appText(m)} · ${presenceOf(m).label}`;
    return el;
  };
  drawMemberList(sig, () => {
    // The editor form is moved, not rebuilt, so typing survives redraws from live events; moving blurs, so refocus.
    const focused = manageEditor.form.contains(document.activeElement) ? document.activeElement : null;
    // One card per member. Its head holds the member button (avatar; name and app; status dot, word and the hidden mark)
    // and the action icons, which wrap under the name when the panel is narrow; then the details (ui.js memberDetailsView),
    // a long conversation's warning included, and this member's name/avatar editor when it is open.
    $('manage-list').replaceChildren(...(members.length ? members.map((m) => h('div', {
      class: `manage-row${m.id === recentMember ? ' recent' : ''}${editingId === m.id ? ' editing' : ''}`, 'data-member': m.id },
      h('div', { class: 'manage-head' },
        h('button', { type: 'button', class: 'member-open', title: t('打开 {name} 的成员页', { name: m.name }), onclick: () => select(managedCluster, m.id) },
          rowAvatar(m),
          h('span', { class: 'manage-person' },
            h('span', { class: 'member-name-line' }, h('b', {}, m.name), appBadge(m), pluginUi.marksSlot(m.clusterId, 'member', m.id, 1)),
            h('span', { class: `member-state ${statusOf(m)}` },
              memberStatusLabel(m, statusOf(m)), m.hiddenAt ? hiddenMark() : null))),
        h('div', { class: 'member-actions', role: 'group', 'aria-label': t('{name} 的操作', { name: m.name }) },
          memberRowActions(m).map((a) => h('button', { type: 'button', class: `icon-button ghost member-action${a.danger ? ' danger' : ''}`,
            'aria-label': a.name, 'data-tip': a.label, 'data-action': a.key, 'aria-expanded': a.key === 'edit' ? String(editingId === m.id) : null,
            disabled: removing || (a.key === 'hide' && hiding.has(m.id)), onclick: () => act[a.key](m) }, icon(a.icon))))),
      memberDetailsView(details.get(m.id), { tokens: tokensOf(m), alert: alertOf(m) }),
      editingId === m.id ? manageEditor.form : null))
      : [emptyState(t('集群暂无成员，可以添加成员继续协作。'))]));
    if (focused?.isConnected) focused.focus();
  });
  if (refocusRecent) {   // back from a member page: to its row, unless focus already went somewhere on purpose
    refocusRecent = false;
    const active = document.activeElement;
    if (!active || active === document.body || $('member-panel').contains(active)) focusRow(recentMember);
  }
  $('panel-add').disabled = removing;
  $('manage-notice').textContent = manageNotice;
  $('manage-notice').hidden = !manageNotice;
  showError('manage-error', manageError);
}

/**
 * Removes a member after the page's confirm dialog (ui.js removeMemberConfirm says what ends and what is kept).
 * Cancel: nothing is sent, focus back on the row's remove button. Done: focus moves to the next member (or the one
 * before, or 添加成员 when none is left).
 */
async function removeMember(m) {
  if (removing || m.removedAt) return;
  editingId = null;
  manageError = null;
  manageNotice = '';
  renderManage();
  const ok = await confirmDialog(liveAsk(() => removeMemberConfirm(m)));
  const origin = document.activeElement;
  if (!ok) { if (canRestoreMemberFocus(m.clusterId, origin)) focusRow(m.id, 'remove'); return; }
  if (removing || S.members.get(m.id)?.removedAt) return;
  const ids = membersOf(m.clusterId).map((x) => x.id);
  const at = ids.indexOf(m.id);
  const next = ids[at + 1] ?? ids[at - 1] ?? null;
  removing = true;
  manageNotice = t('正在移出“{name}”…', { name: m.name });
  renderManage();
  let restoreFocus;
  try {
    const { member } = await api('DELETE', `/api/clusters/${encodeURIComponent(m.clusterId)}/members/${encodeURIComponent(m.id)}`, {});
    upsertMember(member);
    manageNotice = t('已将“{name}”移出集群，历史已保留。', { name: member.name });
  } catch (e) {
    manageNotice = '';
    manageError = t('移出失败：{message}', { message: e.message });
  } finally {
    restoreFocus = canRestoreMemberFocus(m.clusterId, origin);
    removing = false;
    renderManage();
    render();
  }
  if (!restoreFocus) return;
  if (!S.members.get(m.id)?.removedAt) focusRow(m.id, 'remove');
  else if (!next || !focusRow(next)) $('panel-add').focus();
}

// After an asynchronous operation, another input or panel may already have the user's focus.
function canRestoreMemberFocus(clusterId, origin) {
  const active = document.activeElement;
  return S.sel.cluster === clusterId && panelView() === 'members'
    && (!active || active === document.body || (origin !== document.body && origin?.contains(active)));
}

/**
 * Moves a native member to another existing conversation of its harness (docs/cluster-members.md「换对话」). The user
 * picks the conversation and ticks that the old one has stopped; what deserves a warning is shown before confirming.
 */
function openRebind(memberId) {
  const member = S.members.get(memberId);
  if (!member || member.removedAt) return;
  const project = h('select', { id: 'rebind-project' }, h('option', { value: '' }, t('选择项目…')));
  const refresh = h('button', { type: 'button', class: 'small refresh', title: t('重新读取项目和对话列表') }, t('刷新'));
  const list = h('div', { class: 'sessions' }, h('p', { class: 'muted' }, t('选一个项目以列出它的已有对话。')));
  const warnings = h('div', { class: 'rebind-warnings' });
  const stopped = h('input', { type: 'checkbox', required: true });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const cancel = h('button', { type: 'button' }, t('取消'));
  const submit = h('button', { type: 'submit', class: 'primary', disabled: true }, t('确认换对话'));
  const dialog = h('dialog', { class: 'handoff-dialog', 'aria-labelledby': 'rebind-title', 'aria-describedby': 'rebind-description' },
    h('form', {},
      h('h2', { id: 'rebind-title' }, t('给 {name} 换对话', { name: member.name })),
      h('p', { id: 'rebind-description', class: 'muted' }, t('只能换成 {harness} 里已有的对话。成员身份、角色、未读和任务都保留，新旧两个对话都不能验收这个成员的任务。换完会叫醒这个成员和协调员，把手上的任务发给它们，并在群里留记录。', { harness: member.harness })),
      h('p', { class: 'muted' }, t('当前对话：{workerSessionId}', { workerSessionId: member.workerSessionId })),
      h('div', { class: 'project-row' }, h('label', { for: 'rebind-project' }, t('项目'), project), refresh),
      h('div', {}, h('span', { class: 'muted' }, t('目标对话')), list),
      warnings,
      h('label', { class: 'handoff-confirm' }, stopped, t('已确认原对话停止')),
      error,
      h('div', { class: 'row end' }, cancel, submit)));
  let chosen = null;
  let pending = false;
  let request = 0;   // only the latest session-list request may touch the list
  const picked = new Set();
  const sync = () => {
    warnings.replaceChildren(...(chosen ? rebindWarnings(member, chosen, { busy: statusOf(member) === 'busy' }).map((text) => h('p', { class: 'banner warn' }, text)) : []));
    submit.disabled = pending || !chosen || !stopped.checked;
  };
  const choose = (session, on) => {
    chosen = on ? session : null;
    picked.clear();
    if (on) picked.add(session.id);
    sync();
  };
  /** The list is changing: nothing picked from the old one may be submitted, even if the new one never arrives. */
  const resetList = (text) => {
    choose(null, false);
    list.replaceChildren(h('p', { class: 'muted' }, text));
    return ++request;
  };
  const loadSessions = async () => {
    const path = project.value;
    if (!path) { resetList(t('选一个项目以列出它的已有对话。')); return; }
    const mine = resetList(t('加载中…'));
    try {
      const sessions = await api('GET', harnessPath(member.harness, `sessions?project=${encodeURIComponent(path)}`));
      if (mine !== request) return;   // the user picked another project (or refreshed) meanwhile
      list.replaceChildren(...(sessions.length
        ? sessions.map((s) => sessionRow(s, picked, choose, { clusterId: member.clusterId, type: 'radio', name: 'rebind-session' }))
        : [emptyState(t('这个项目里没有已有对话：先在应用里新建对话并发一句话，再点「刷新」。'), { compact: true })]));
    } catch (e) {
      if (mine === request) list.replaceChildren(h('p', { class: 'form-error' }, t('对话加载失败：{message}', { message: e.message })));
    }
  };
  const loadAll = async (first) => {
    resetList(t('加载中…'));
    try {
      const fresh = await loadProjects(project, member.harness);
      if (fresh && first && [...project.options].some((o) => o.value === member.cwd)) project.value = member.cwd;
    } catch (e) {
      error.textContent = t('项目加载失败：{message}', { message: e.message });
      error.hidden = false;
    }
    await loadSessions();
  };
  project.addEventListener('change', loadSessions);
  refresh.addEventListener('click', () => loadAll(false));
  stopped.addEventListener('change', sync);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (e) => { if (pending) e.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending || !chosen || !stopped.checked) return;
    pending = true;
    cancel.disabled = true;
    error.hidden = true;
    sync();
    try {
      const { member: moved } = await api('POST', `/api/members/${encodeURIComponent(member.id)}/session`,
        { harness: member.harness, sessionId: chosen.id, confirmStopped: true });
      upsertMember(moved);
      manageNotice = moved.status === 'offline'
        ? t('已把“{name}”换到新对话。新对话离线：排队的消息记为离线，不会重发，它上线后自己读未读。', { name: moved.name })
        : t('已把“{name}”换到新对话，并通知了它和协调员。', { name: moved.name });
      dialog.close();
      render();
    } catch (err) {
      error.textContent = err instanceof TypeError ? t('未能确认是否换成功，请先看成员页的换对话记录。') : t('换对话失败：{message}', { message: err.message });
      error.hidden = false;
    } finally {
      pending = false;
      cancel.disabled = false;
      sync();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  project.focus();
  void loadAll(true);
}

/**
 * The member's handover package (docs/cluster-members.md「交接包」): the Hub's records as editable text that the user
 * copies or sends to one member through the ordinary group-message flow. Generating, sending and moving the member
 * stay explicit user actions — this never sends or rebinds on its own.
 */
let handoverOpening = false;   // set while the package is being read, before the dialog exists: a double click waits

async function openHandover(memberId) {
  const member = S.members.get(memberId);
  if (!member || handoverOpening || document.querySelector('.handover-dialog')) return;
  handoverOpening = true;
  let data;
  try {
    data = await api('GET', `/api/members/${encodeURIComponent(member.id)}/handover`);
  } catch (e) {
    handoverOpening = false;
    noticeDialog(lt('交接包生成失败：{message}', { message: e.message }), lt('交接包'));
    return;
  }
  handoverOpening = false;   // from here on the dialog itself blocks a second open
  const text = h('textarea', { id: 'handover-text', rows: 18, spellcheck: 'false', 'aria-label': t('交接包内容') });
  text.value = handoverText(data);
  const recipients = membersOf(member.clusterId);
  const target = h('select', { id: 'handover-target', 'aria-label': t('交接包收件人') },
    h('option', { value: '', disabled: true, selected: true }, recipients.length ? t('发送给…') : t('没有可发的群员')),
    ...recipients.map((m) => h('option', { value: m.id }, m.name)));
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const status = h('p', { class: 'muted', role: 'status', hidden: true });
  const copy = h('button', { type: 'button' }, t('复制'));
  const send = h('button', { type: 'button', class: 'primary', disabled: true }, t('发送'));
  const close = h('button', { type: 'button' }, t('关闭'));
  const showError = (message) => { error.textContent = message; error.hidden = !message; };
  const say = (message) => { status.textContent = message; status.hidden = !message; };
  let pending = false;
  const sync = () => { send.disabled = pending || !target.value; };
  const dialog = h('dialog', { class: 'handoff-dialog handover-dialog', 'aria-labelledby': 'handover-title' },
    h('form', { autocomplete: 'off' },
      h('h2', { id: 'handover-title' }, t('给 {name} 的交接包', { name: member.name })),
      h('p', { class: 'muted' }, t('内容只来自 Hub 已有的记录：不调用模型，也不读对话在本地的文件；没有记录的写“未知”。改完可以复制，或发给一个群员。不会自动发送，也不会自动换对话。')),
      text, error, status,
      h('div', { class: 'row end' }, copy, target, send, close)));
  target.addEventListener('change', sync);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', (e) => { if (pending) e.preventDefault(); });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  copy.addEventListener('click', async () => {
    say('');
    try {
      await navigator.clipboard.writeText(text.value);
      say(t('已复制。'));
    } catch {
      text.focus();
      text.select();
      say(t('浏览器不允许直接写入剪贴板：已全选，按 Ctrl+C 复制。'));
    }
  });
  send.addEventListener('click', async () => {
    const body = text.value.trim();
    if (pending) return;
    if (!body) { showError(t('交接包是空的。')); return; }
    if (!target.value) { showError(t('先选择发给谁。')); return; }
    pending = true;
    sync();
    copy.disabled = true;
    close.disabled = true;
    showError('');
    try {
      await api('POST', `/api/clusters/${encodeURIComponent(member.clusterId)}/messages`, { body, to: [target.value], handover: true });
      const to = target.value;
      dialog.close();
      noticeDialog(lt('已把交接包发给 {value}。', { value: nameOf(to) }), lt('已发送'));
    } catch (e) {
      showError(e instanceof TypeError ? t('未能确认是否发送成功，请到群聊里核对后再决定是否重发。') : t('发送失败：{message}', { message: e.message }));
    } finally {
      pending = false;
      copy.disabled = false;
      close.disabled = false;
      sync();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  text.focus();
  text.setSelectionRange(0, 0);   // start at the top of the package, not where the browser left the caret
  text.scrollTop = 0;
}

$('panel-add').addEventListener('click', () => openCreate(S.sel.cluster));
$('member-rebind-open').addEventListener('click', () => openRebind(S.sel.member));
$('member-handover').addEventListener('click', () => { if (S.sel.member) void openHandover(S.sel.member); });
$('member-hidden').addEventListener('click', () => { if (S.sel.member) void toggleHidden(S.sel.member); });
$('empty-add-members').addEventListener('click', () => openCreate(S.sel.cluster));

// Members holding tasks with no activity past the threshold (docs/collaboration.md): the sidebar entry, 全部任务 and the workbench show it.
const stalled = createStalledWatch({ api, onChange: () => { drawStalledOverview(); workbench.stalledChanged(); render(); } });
function drawStalledOverview() {
  const hints = stalled.visible();
  const badge = $('task-overview-stalled');
  badge.hidden = !hints.length;
  const look = stalledBadge(hints);
  badge.textContent = look.text;
  const title = look.title;
  badge.title = title;
  badge.setAttribute('aria-label', title);
}
// Plugins' own UIs (docs/external-plugins.md「网页界面」): title bar chips here, workbench tabs through the workbench.
const pluginUi = createPluginUi({ api, chipsHost: $('plugin-ui-chips'), itemsChanged: (clusterId) => workbench.pluginTabsChanged(clusterId) });
const workbench = createWorkbench({ api, stalled, pluginUi, getMembers: (id) => membersOf(id),
  getHistoryMembers: (id) => [...S.members.values()].filter((member) => member.clusterId === id),
  getClusters: () => [...S.clusters.values()], selectCluster: select, nameOf, messageName, openImage: openViewer, uploadFile,
  renderMarkdown: (body, clusterId) => mdBlocks(markdownBlocks(body), { clusterId, mentions: [] }),
  workspaceChanged: (clusterId) => { if (clusterId === S.sel.cluster) render(); },
  getActivity: (id) => activitySummary(S.activity.get(id), S.activityFailed), showMessage: (clusterId, id) => openMessage(clusterId, id) });
$('open-workbench').addEventListener('click', () => { if (S.sel.cluster) workbench.open(S.sel.cluster); });
$('delivery-problems').addEventListener('click', () => { if (S.sel.cluster) openDeliveryProblems(); });
$('message-sync-retry').addEventListener('click', () => { retryMessageMetadata(S.sel.cluster); render(); });
$('open-task-overview').addEventListener('click', () => { $('app').classList.remove('sidebar-open'); workbench.openAll(); });
async function deleteCluster(cluster) {
  if (!cluster) return;
  const ok = await confirmDialog({ title: lt('删除群聊？'), message: lt('“{name}”会进入回收站，可随时恢复。原生对话、消息和文件保留；未开始的投递取消，已开始的执行可能继续。恢复后旧投递不会自动重发。', { name: cluster.name }), confirmText: lt('移入回收站'), danger: true });
  if (!ok) return;
  try { await api('DELETE', `/api/clusters/${encodeURIComponent(cluster.id)}`, {}); await syncPaused().catch(() => {}); }
  catch (e) { await noticeDialog(lt('{message}。请查看回收站确认结果。', { message: e.message }), lt('删除未确认')); }
}
$('open-trash').addEventListener('click', () => {
  trashRemoved = openTrash({ api, restored: syncPaused, noticeDialog, closed: () => { trashRemoved = null; } });
});

/** POST a ZIP's bytes to the skill installer (docs/files.md「安装 skill」); throws like api(). */
async function uploadSkillZip(file, overwrite) {
  if (file.size > MAX_SKILL_ZIP) throw Object.assign(new Error('too large'), { data: { code: 'too_large' } });
  const res = await fetch(`/api/extensions/skills/install${overwrite ? '?overwrite=1' : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-orrery-filename': encodeURIComponent(file.name) }, body: file });
  if (res.status === 401) unauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}
const MAX_SKILL_ZIP = 20 * 1024 * 1024;
/** The `$` list (GET /api/skills): read when the page loads and after each install. */
let skillsRequest = 0;
async function loadSkills() {
  const request = ++skillsRequest;
  const list = await api('GET', '/api/skills');
  if (request !== skillsRequest) return;
  S.skills = list;
  S.skillNames = new Set(list.map((k) => k.name));
  S.skillsVersion++;
  render();
}
$('open-extensions').addEventListener('click', () => {
  $('app').classList.remove('sidebar-open');
  openExtensions({ api, uploadZip: uploadSkillZip, skillsChanged: loadSkills });
});

// "N 分钟前" in the sidebar and on 全部对话 moves on by itself: only those words are rewritten, nothing is redrawn.
setInterval(() => refreshRelativeTimes(document), 30_000);

// ---- 界面语言: switched in place (settings.js, the desktop shell's event above, another tab) ----
// Nothing reloads: drafts, attachments, scroll positions, open panels and dialogs, the selection and the filters stay.
// The marked static text is translated again; everything drawn from data is drawn again (the cached rows' signatures
// and stableList compare the language); what was built once is rebuilt or relabelled here. S.identity is not touched:
// it means a member changed, and the member page refills its editor for that, which would drop unsaved edits.
onLanguageChange(() => {
  translateStatic(document);
  translateStatic($('editor-template').content);   // the name/avatar editors cloned later
  if (connOk !== null) setConn(connOk);
  viewHost.relabel();   // view titles given as functions, and the third-party label
  fitPanes();   // the dividers' "N 像素"
  $('chat-filter-panel').replaceChildren();   // built once: renderChatFilter builds it again, the filter itself is kept
  if (clusterMenu) {   // an open ⋯ menu is built again in the new language, on its (redrawn) trigger
    const { id } = clusterMenu;
    closeClusterMenu(false);
    setTimeout(() => {
      const trigger = clusterMenuTrigger(id);
      if (!trigger) return;
      if (id.startsWith('group:')) openGroupMenu(id.slice('group:'.length), trigger);
      else openClusterMenu(id, trigger);
    }, 50);   // after render (16 ms) redrew the list
  }
  if (dialog.open) {   // 新建集群 / 添加成员: the inputs stay; the title, the buttons and each app's summary follow
    $('create-title').textContent = addToCluster ? t('添加成员') : t('新建集群');
    $('create-submit').textContent = addToCluster ? t('添加') : t('创建');
    for (const f of harnessForms) f.sync();
  }
  render();
});

// ---- full-page plugin views (plugin-view.js): entries in the sidebar head, the view over the main area ----

const viewHost = createViewHost({ app: $('app'), layer: $('plugin-view'), heading: $('plugin-view-title'), back: $('plugin-view-back'),
  before: $('open-settings'), api: featureApi, clusterId: () => S.sel.cluster ?? null,
  openChat: (cluster) => { if (typeof cluster === 'string' && S.clusters.has(cluster)) select(cluster); }, theme: () => themeSnapshot().scheme, onChange: render,
  // Under the view: the chat (but its global banners, raised over the view) and the member panel.
  covered: () => [...[...$('chat').children].filter((node) => !node.matches('#update-banner, #trust-banner, #safe-mode-banner')), $('panel-divider'), $('member-panel')],
  // Shown, and not in the narrow screen's closed sidebar drawer (opening a view closes it).
  canFocus: (node) => node.getClientRects().length > 0 && !(innerWidth <= 900 && !$('app').classList.contains('sidebar-open') && $('sidebar').contains(node)),
  fallbackFocus: () => [$('open-settings'), $('open-sidebar')],
  // Leaving a view that holds typed input (its drafts are lost with it): asked first, as a reload is.
  confirmLeave: () => confirmDialog({ title: lt('离开这个页面？'), message: lt('这里还有没发送或没保存的内容，离开后会丢失。可以先发送或复制它们。'),
    confirmText: lt('离开'), danger: true }) });

// ---- start ----

// The launcher and the desktop shell open <url>/#token=<token> (a fragment never reaches the server). Before any
// other request, trade it for the session cookie, then drop it from the address bar and the history entry.
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (hashToken !== null) {
  try {
    await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: hashToken }) });
  } catch { /* no Hub: the requests below say so */ }
  history.replaceState(null, '', location.pathname + location.search);
}
readHash();
render();
try {
  let plugins;
  [S.harnesses, S.modes, S.avatars, plugins] = await Promise.all([
    api('GET', '/api/harnesses'), api('GET', '/api/harness-modes'), api('GET', '/api/avatars'),
    readPagePlugins().catch(() => null),
  ]);
  // The shared page helpers reach every module through register's host (the supported way for a full-trust module).
  pluginSlots = await loadPluginSlots(plugins, { api, nameOf, command: workbench.command,
    ui: Object.freeze({ h, icon, emptyState, noticeDialog, confirmDialog, formDialog }) });
  // A plugin released later (detached, or a slot of it found wrong): its workbench tab goes, and kept message elements
  // are rebuilt without it before they are shown again.
  pluginSlots.onRelease = (ids) => { workbench.detachPlugins(ids); viewHost.setViews(pluginSlots.view); render(); };
  pluginSlots.closeView = (id) => viewHost.release(id);   // in release: after its typed input is kept, before its onDispose
  viewHost.setViews(pluginSlots.view);
  pagePlugins = plugins;
  pluginsStart = typeof plugins?.instance === 'string' ? plugins.instance : null;   // the start this list came from
  hubCheckPending = plugins === null;
  for (const id of pluginSlots.tried) triedContinuouslyListed.add(id);
  $('safe-mode-banner').hidden = plugins?.safeMode !== true;   // full-trust plugins skipped this start (docs/external-plugins.md)
  workbench.setPlugins(plugins, pluginSlots.workbench);
  chat.button.before(...pluginSlots.composer.map((renderSlot) => renderSlot({
    input: $('composer-input'), getClusterId: () => S.sel.cluster,
  })).filter(Boolean));
  $('plugin-list').after(...pluginSlots.settings.map((renderSlot) => renderSlot()).filter(Boolean));
  for (const id of ['open-task-overview', 'composer-tasks']) $(id).hidden = workbench.tasksEnabled() === false;
  if (workbench.tasksEnabled() !== false) void stalled.load();
  panelEditor.refreshPresets();   // an editor already filled before the avatars arrived gets the row now
  manageEditor.refreshPresets();
  for (const f of harnessForms) f.refreshPresets();   // so does a create dialog opened meanwhile
  await syncPaused();
  mountUpdatePanel();
  checkHub();   // remembers which Hub process served this page
  // shortcut: skills are read once per page load and after an install on 技能与 MCP; one added elsewhere shows after a reload.
  loadSkills().catch((e) => console.warn('skills not loaded', e));
} catch (e) {
  hubCheckPending = true;
  setConn(false);
  console.warn('initial load failed', e);
}
// The stream starts where the state snapshot was taken; without one (no Hub yet) the page keeps asking for it.
while (clusterSnapshotSeq < 0 && !quitting && !denied) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await syncPaused().catch(() => {});
}
S.lastSeq = Math.max(S.lastSeq, clusterSnapshotSeq);
// Then the shown cluster's newest messages, then the events after the snapshot (messages streamed while that read
// runs are merged into its answer).
defaultSelection();
if (S.clusters.has(S.sel.cluster) && !chatWindows.has(S.sel.cluster)) await loadLatest(S.sel.cluster);
connect(S.lastSeq);
