// The star map's pure parts (docs/starmap.md「星空里的东西」): what the Hub's groups, clusters and members become in the
// sky, which system notices are satellites, the local "知道了" record, the cluster list search and the live state kept
// from /api/state and the event stream. No DOM and no three.js: test/starmap-scene.test.ts runs all of it in node, and
// the chat windows import satellitesOf from here so a chat line and its satellite agree.
import { clusterUnread, harnessApp, isSystemMessage, memberStatus, systemMark } from '/plugin-host/v1.js';

// ---- groups, clusters and members as the sky ----

/** The colour and display name of each harness's planet; others get a colour from their name. */
export const HARNESS = Object.freeze({
  claude: { label: 'Claude Code', color: '#e3895c' },
  codex: { label: 'Codex', color: '#6fd8b9' },
  kimi: { label: 'Kimi Code', color: '#b9a2ff' },
  deepseek: { label: 'DeepSeek Harness', color: '#6b93ff' },
  cursor: { label: 'Cursor', color: '#e7e1d3' },
  qoder: { label: 'Qoder', color: '#8d97a3' },
  antigravity: { label: 'Antigravity', color: '#f2c45a' },
  zcode: { label: 'ZCode', color: '#7fc7e8' },
  workbuddy: { label: 'WorkBuddy', color: '#e89ab8' },
  mock: { label: 'Mock', color: '#a7b0bf' },
});

/** FNV-1a of a string, 1..2^31-2: the seed of everything drawn "at random" for a name (stable across reloads). */
export function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 2147483646) + 1;
}

/** A small seeded generator (Park–Miller), 0 <= r() < 1. */
export function rng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function harnessInfo(harness) {
  if (Object.hasOwn(HARNESS, harness)) return HARNESS[harness];
  const hue = hashStr(harness) % 360;
  return { label: String(harness), color: hslHex(hue, 0.45, 0.68) };
}

const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
const AVATAR_PRESET_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What is painted on the front of a member's planet, matching ui.js avatarEl priority:
 * uploaded raster image → shipped preset avatar → emoji → real host app icon (`/app-icons/*`) → name initial.
 */
export function planetFace(member) {
  const a = member?.avatar;
  const initial = ([...String(member?.name ?? '')][0] ?? '?').toUpperCase();
  const appIcon = harnessApp(member?.harness).icon ?? null;
  if (typeof a === 'string' && AVATAR_DATA_URL_RE.test(a)) return { kind: 'image', src: a, fallbackSrc: appIcon, initial };
  if (typeof a === 'string' && a.startsWith('preset:')) {
    const preset = a.slice('preset:'.length);
    if (AVATAR_PRESET_RE.test(preset)) return { kind: 'preset', src: `/avatars/${preset}.png`, fallbackSrc: appIcon, initial };
  }
  if (typeof a === 'string' && a && !a.startsWith('data:') && !a.startsWith('preset:') && a.length <= 16) return { kind: 'emoji', text: a, initial };
  if (appIcon) return { kind: 'app', src: appIcon, initial };
  return { kind: 'initial', text: initial };
}

function hslHex(hue, s, l) {
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * How a planet is drawn: `status` is the Hub's channel status as the chat page reads it (ui.js memberStatus), named
 * for the sky: 'online' (idle), 'busy' or 'offline'; `hidden` for a member that is 隐身 (still online or busy, drawn
 * as a ghost). `harnessAvailable` false or no `running` deliveries as on the page.
 */
export function planetState(member, harnessAvailable, running) {
  const status = memberStatus(member, harnessAvailable, running);
  return { status: status === 'idle' ? 'online' : status, hidden: Boolean(member.hiddenAt) };
}

const byCreated = (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * The galaxies: one per group, in the Hub's group order (settings.clusterGroups), then any other group a cluster names
 * (Chinese collation), then the ungrouped clusters as one galaxy named '' (shown as 未分组), only when there are any.
 * Inside a galaxy the clusters keep their creation order, so a new message never moves a star system. A listed group
 * with no cluster has no galaxy (nothing to fly into). Each cluster becomes a system with its active members as planets.
 *
 * `state`: { clusters, members, groupOrder, harnesses (array or null = unknown, all available), running: Map
 * memberId -> Set, messages: Map clusterId -> [message] }; `dismissed(clusterId)` -> the Set of hidden notice ids.
 */
export function skyModel(state, dismissed = () => new Set()) {
  const by = new Map();
  for (const c of [...state.clusters.values()].filter((c) => !c.deletedAt).sort(byCreated)) {
    const name = String(c.category ?? '').trim();
    if (!by.has(name)) by.set(name, []);
    by.get(name).push(c);
  }
  const listed = [...new Set((state.groupOrder ?? []).filter((n) => typeof n === 'string' && n && by.has(n)))];
  const known = new Set(listed);
  const others = [...by.keys()].filter((n) => n && !known.has(n)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const names = [...listed, ...others, ...(by.has('') ? [''] : [])];
  const membersOf = new Map();
  for (const m of [...state.members.values()].sort(byCreated)) {
    if (m.removedAt) continue;
    if (!membersOf.has(m.clusterId)) membersOf.set(m.clusterId, []);
    membersOf.get(m.clusterId).push(m);
  }
  const available = (h) => !state.harnesses || state.harnesses.includes(h);
  const galaxies = names.map((name) => ({
    name,
    ungrouped: name === '',
    systems: by.get(name).map((cluster) => {
      const planets = (membersOf.get(cluster.id) ?? []).map((member) => ({
        member, ...planetState(member, available(member.harness), Boolean(state.running?.get(member.id)?.size)),
      }));
      const ids = new Set(planets.map((p) => p.member.id));
      const satellites = satellitesOf(state.messages?.get(cluster.id) ?? [], dismissed(cluster.id))
        .map((s) => (s.target && !ids.has(s.target) ? { ...s, target: null } : s));
      return { cluster, group: name, planets, satellites, stats: systemStats(planets, satellites) };
    }),
  }));
  return { galaxies, systems: new Map(galaxies.flatMap((g) => g.systems.map((s) => [s.cluster.id, s]))) };
}

/** Counts for cards and labels; `level` is the most urgent satellite's ('problem' over 'attention'), or null. */
export function systemStats(planets, satellites) {
  const shown = planets.filter((p) => !p.hidden);
  return {
    n: planets.length,
    busy: planets.filter((p) => p.status === 'busy').length,
    online: shown.filter((p) => p.status !== 'offline').length,
    offline: planets.filter((p) => p.status === 'offline').length,
    hidden: planets.length - shown.length,
    notices: satellites.length,
    level: satellites.some((s) => s.level === 'problem') ? 'problem' : satellites.length ? 'attention' : null,
  };
}

/** A structure fingerprint: when it changes the sky is laid out again (a status or a notice only restyles it). */
export function skyKey(model) {
  return JSON.stringify(model.galaxies.map((g) => [g.name, g.systems.map((s) => [s.cluster.id, s.planets.map((p) => p.member.id)])]));
}

/**
 * Where everything goes, deterministic from the galaxies' order and names: galaxies on a wide ring (alternating a
 * little up and down), each with a size for its number of clusters, a shape (spiral or elliptical; the ungrouped one is
 * a loose cloud), a tilt and a seed; inside each, its clusters' positions in the galaxy's own plane (y = 0; the scene
 * applies the tilt); the black hole outside the ring. Positions are plain [x, y, z] arrays.
 */
export function layoutSky(galaxies) {
  const n = galaxies.length;
  const sizes = galaxies.map((g) => Math.min(220, Math.max(86, 64 + 14 * g.systems.length)));
  const ring = n <= 1 ? 0 : Math.max(330, (sizes.reduce((a, b) => a + b, 0) * 2.3) / (2 * Math.PI));
  const out = galaxies.map((g, idx) => {
    const seed = hashStr(`galaxy:${g.name}`);
    const r = rng(seed);
    const R = sizes[idx];
    const a = (idx / Math.max(1, n)) * Math.PI * 2 + 0.6;
    const pos = [Math.cos(a) * ring, (idx % 2 ? -1 : 1) * (20 + r() * 50) * (n > 1 ? 1 : 0), -Math.sin(a) * ring];
    const type = g.ungrouped ? 'cloud' : seed % 3 === 0 ? 'elliptical' : 'spiral';
    const k = g.systems.length;
    const systems = g.systems.map((s, j) => {
      const ang = j * 2.35 + 0.7, rr = R * (0.34 + (0.46 * (j + 1)) / (k + 1));
      return { id: s.cluster.id, local: [Math.cos(ang) * rr, 0, -Math.sin(ang) * rr] };
    });
    return {
      name: g.name, ungrouped: g.ungrouped, idx: idx % 4, seed, R, type, pos,
      arms: 2 + (seed % 2), twist: 2.4 + r() * 1.0,
      rot: [(r() - 0.5) * 0.6, r() * Math.PI * 2, (r() - 0.5) * 0.5],
      spin: g.ungrouped ? 0.15 : type === 'elliptical' ? 0.3 : 0.6 + r() * 0.4,
      core: g.ungrouped ? 0.35 : 1, dim: g.ungrouped ? 0.7 : 1,
      systems,
    };
  });
  const outer = ring + Math.max(...sizes, 86) + 160;
  return { galaxies: out, blackHole: [Math.cos(-2.3) * outer, 30, -Math.sin(-2.3) * outer] };
}

/** Orbit radii as fractions of the system's radius, inner to outer (the mockup's spacing). */
export function orbitFractions(n) {
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0.6 : 0.36 + (0.6 * i) / Math.max(1, n - 1)));
}

// ---- satellites: system notices that wait for the user ----

/**
 * The satellites of a cluster's `messages` (its loaded chat, oldest first): its warnings, system messages whose kind
 * is in the warning category (a problem, such as a failed delivery, or an attention item, such as a rejected task),
 * that this browser has not hidden with 知道了 (`dismissed`: anything with has(messageId)). A notice addressed to
 * exactly one member circles that member's planet (`target` its id); any other circles the star (`target` null).
 */
export function satellitesOf(messages, dismissed = new Set()) {
  const out = [];
  for (const message of messages ?? []) {
    if (!isSystemMessage(message) || dismissed.has(message.id)) continue;
    const mark = systemMark(message);
    if (!mark) continue;
    const to = Array.isArray(message.mentions) ? message.mentions : [];
    out.push({ id: message.id, message, level: mark.level, target: to.length === 1 ? to[0] : null });
  }
  return out;
}

/**
 * A satellite's glyph, the same shape in the sky, on its card and beside its line in a chat window: a triangle for a
 * problem, a diamond for an attention item, as SVG element specs [tag, attributes] on a 16-unit grid (static drawings,
 * built with createElementNS). Their colour is the theme's `SATELLITE_COLOR[level]` CSS variable.
 */
export const SAT_ICON = Object.freeze({
  problem: [['path', { d: 'M8 1.4 15.2 14.2H.8z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linejoin': 'round' }],
    ['path', { d: 'M8 6v3.8', stroke: '#170906', 'stroke-width': 1.8, 'stroke-linecap': 'round' }], ['circle', { cx: 8, cy: 12, r: 1, fill: '#170906' }]],
  attention: [['path', { d: 'M8 1.2 14.8 8 8 14.8 1.2 8z', fill: 'currentColor' }], ['path', { d: 'M8 5.2 10.8 8 8 10.8 5.2 8z', fill: '#0b0f1c', opacity: '.6' }]],
});
export const SATELLITE_COLOR = Object.freeze({ problem: '--k-warn', attention: '--k-task' });

// ---- 知道了: hidden satellites, per browser (docs/starmap.md default C) ----

export const DISMISSED_KEY = 'orrery.starmapDismissed';
/** Most records kept; past it the oldest go (their notices are long gone from the latest messages anyway). */
export const DISMISSED_CAP = 2000;

/** The stored list, oldest first: [{ hub, cluster, id, at }]; anything unreadable reads as empty. */
export function parseDismissed(raw) {
  let rows;
  try { rows = JSON.parse(raw ?? '[]'); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => Array.isArray(r) && r.length === 4 && r.slice(0, 3).every((v) => typeof v === 'string' && v) && Number.isFinite(r[3]))
    .map(([hub, cluster, id, at]) => ({ hub, cluster, id, at }));
}

export const serializeDismissed = (list) => JSON.stringify(list.map((r) => [r.hub, r.cluster, r.id, r.at]));

/** `list` plus `ids` hidden now in `cluster` of `hub` (one record per notice, newest last), at most `cap` records. */
export function addDismissed(list, hub, cluster, ids, now = Date.now(), cap = DISMISSED_CAP) {
  const fresh = new Set(ids);
  const kept = list.filter((r) => !(r.hub === hub && r.cluster === cluster && fresh.has(r.id)));
  const next = [...kept, ...[...fresh].map((id) => ({ hub, cluster, id, at: now }))];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** The notice ids hidden in `cluster` of `hub`. */
export const dismissedSet = (list, hub, cluster) => new Set(list.filter((r) => r.hub === hub && r.cluster === cluster).map((r) => r.id));

/**
 * The record in `storage` (localStorage) for one Hub (`hub`: the page's host). Storage that is blocked or full only
 * means the choice lasts this visit: reads and writes never throw.
 */
export function dismissedStore(storage, hub) {
  let memory = null;
  const read = () => {
    if (memory) return memory;
    try { return parseDismissed(storage?.getItem(DISMISSED_KEY)); } catch { return []; }
  };
  return {
    of: (cluster) => dismissedSet(read(), hub, cluster),
    add(cluster, ids) {
      const next = addDismissed(read(), hub, cluster, ids);
      try { storage.setItem(DISMISSED_KEY, serializeDismissed(next)); memory = null; } catch { memory = next; }
    },
  };
}

// ---- burst / message-rate activity (60s sliding window, pure) ----

/** Sliding window for message-rate calculation (ms). */
export const ACTIVITY_WINDOW_MS = 60_000;
/** Messages per minute to treat a cluster as clearly active / bursting. */
export const ACTIVITY_ACTIVE_RATE = 3;
export const ACTIVITY_BURST_RATE = 8;
/** Cap stored timestamps per cluster so a heavy flood stays bounded. */
export const ACTIVITY_MAX_STAMPS = 120;

const LEVEL_RANK = { burst: 2, active: 1, quiet: 0 };

/** Per-cluster recent public message records: Map<clusterId, Array<{ id: string | null, at: number }>>. */
export function createActivityTracker() {
  return new Map();
}

function pruneList(list, cutoff) {
  if (!list.length || list[0].at >= cutoff) return list;
  let i = 0;
  while (i < list.length && list[i].at < cutoff) i++;
  return i >= list.length ? [] : list.slice(i);
}

/**
 * Records one public cluster message at timestamp `at` (ms) relative to `now` (ms).
 * Deduplicates by `id` when present and prunes records older than `now - windowMs`.
 */
export function recordClusterActivity(tracker, clusterId, { id = null, at = Date.now() } = {}, now = at, windowMs = ACTIVITY_WINDOW_MS) {
  if (!clusterId || !Number.isFinite(at) || !Number.isFinite(now) || windowMs <= 0) return 0;
  const cutoff = now - windowMs;
  if (at < cutoff) return clusterActivity(tracker, clusterId, now, windowMs).count;
  const prev = pruneList(tracker.get(clusterId) ?? [], cutoff);
  if (id && prev.some((r) => r.id === id)) {
    if (prev.length) tracker.set(clusterId, prev); else tracker.delete(clusterId);
    return prev.length;
  }
  const next = [...prev, { id, at }];
  if (next.length > 1 && next[next.length - 2].at > at) next.sort((a, b) => a.at - b.at);
  const bounded = next.length > ACTIVITY_MAX_STAMPS ? next.slice(next.length - ACTIVITY_MAX_STAMPS) : next;
  tracker.set(clusterId, bounded);
  return bounded.length;
}

/**
 * Seeds the tracker from an already-fetched page of public messages (ignoring private messages and anything
 * outside `[now - windowMs, now + 5000]`). Safe to call repeatedly: deduplicates by message id.
 */
export function seedClusterActivity(tracker, clusterId, messages, now = Date.now(), windowMs = ACTIVITY_WINDOW_MS) {
  if (!clusterId || !Array.isArray(messages) || !messages.length || windowMs <= 0) return 0;
  const cutoff = now - windowMs, ceiling = now + 5000;
  for (const m of messages) {
    if (!m || m.privateTo) continue;
    const at = Date.parse(m.createdAt ?? '');
    if (!Number.isFinite(at) || at < cutoff || at > ceiling) continue;
    recordClusterActivity(tracker, clusterId, { id: m.id ?? null, at }, now, windowMs);
  }
  return clusterActivity(tracker, clusterId, now, windowMs).count;
}

/** Drops expired entries across all clusters. Returns true while at least one cluster still has entries in window. */
export function pruneActivity(tracker, now = Date.now(), windowMs = ACTIVITY_WINDOW_MS) {
  const cutoff = now - windowMs;
  for (const [cid, list] of [...tracker]) {
    const kept = pruneList(list, cutoff);
    if (kept.length) tracker.set(cid, kept);
    else tracker.delete(cid);
  }
  return tracker.size > 0;
}

/** Milliseconds until the earliest tracked message leaves the window, or null when completely quiet. */
export function nextActivityExpiry(tracker, now = Date.now(), windowMs = ACTIVITY_WINDOW_MS) {
  let oldest = Infinity;
  for (const list of tracker.values()) {
    if (list.length && list[0].at < oldest) oldest = list[0].at;
  }
  if (!Number.isFinite(oldest)) return null;
  return Math.max(100, oldest + windowMs - now);
}

/**
 * Current activity metrics for one cluster at `now` (pure read; does not mutate `tracker`).
 * `rate`: public messages per minute; `level`: 'burst' | 'active' | 'quiet'; `intensity`: 0..1 visual weight.
 */
export function clusterActivity(tracker, clusterId, now = Date.now(), windowMs = ACTIVITY_WINDOW_MS) {
  const list = tracker?.get?.(clusterId);
  if (!list?.length || windowMs <= 0) return { count: 0, rate: 0, level: 'quiet', intensity: 0 };
  const cutoff = now - windowMs;
  let count = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].at < cutoff) break;
    count++;
  }
  if (!count) return { count: 0, rate: 0, level: 'quiet', intensity: 0 };
  const rate = Math.max(1, Math.round((count * 60_000) / windowMs));
  const level = rate >= ACTIVITY_BURST_RATE ? 'burst' : rate >= ACTIVITY_ACTIVE_RATE ? 'active' : 'quiet';
  const intensity = level === 'burst'
    ? Math.min(1, 0.55 + ((rate - ACTIVITY_BURST_RATE) / 16) * 0.45)
    : level === 'active'
      ? 0.25 + ((rate - ACTIVITY_ACTIVE_RATE) / Math.max(1, ACTIVITY_BURST_RATE - ACTIVITY_ACTIVE_RATE)) * 0.3
      : Math.min(0.22, (rate / ACTIVITY_ACTIVE_RATE) * 0.22);
  return { count, rate, level, intensity };
}

/**
 * Top active or unread clusters for the HUD radar strip: sorted by burst/active level, message rate, unread count,
 * and non-current preference on ties. Quiet read clusters — and clusters the user is already viewing (current system
 * or open Hub chat) with 0 unread — are omitted so reading a flooding cluster immediately clears the alert.
 */
export function activeClusterRows(
  model,
  tracker,
  now = Date.now(),
  { currentCid = null, openHubCids = null, limit = 5, windowMs = ACTIVITY_WINDOW_MS } = {},
) {
  const rows = [];
  for (const system of model.systems.values()) {
    const cid = system.cluster.id;
    const activity = clusterActivity(tracker, cid, now, windowMs);
    const unread = Number(system.cluster.unread) || 0;
    const isCurrent = cid === currentCid;
    const hubOpen = Boolean(openHubCids?.has?.(cid));
    if (unread <= 0 && (isCurrent || hubOpen)) continue;
    if (activity.rate <= 0 && unread <= 0) continue;
    rows.push({ system, activity, unread, isCurrent });
  }
  rows.sort((a, b) => (LEVEL_RANK[b.activity.level] - LEVEL_RANK[a.activity.level])
    || (b.activity.rate - a.activity.rate)
    || (b.unread - a.unread)
    || (Number(a.isCurrent) - Number(b.isCurrent))
    || String(a.system.cluster.name).localeCompare(String(b.system.cluster.name), 'zh-CN'));
  return rows.slice(0, Math.max(0, limit));
}

// ---- the cluster list (/ or Ctrl+K) ----

const norm = (s) => String(s ?? '').toLocaleLowerCase('zh-CN');
/** 0 equal, 1 starts with, 2 contains, -1 no match. */
function rank(text, q) {
  const s = norm(text);
  return s === q ? 0 : s.startsWith(q) ? 1 : s.includes(q) ? 2 : -1;
}

/** A member matches by its name (0, 1 or 2 as rank) or, after those, by its harness's name (3). */
function memberRank(member, q) {
  const own = rank(member.name, q);
  return own >= 0 ? own : rank(harnessInfo(member.harness).label, q) >= 0 ? 3 : -1;
}

/**
 * The rows of the cluster list for `query`. Empty: every cluster in sky order (`group` lets the list put headings
 * between galaxies), then the recycle bin; when `activityOf` (`(cid) => { rate, level }`) is supplied, active or
 * unread clusters float to a top `active` section ordered by rate then unread, with quiet clusters grouped below.
 * Otherwise matching clusters are ranked by match score, breaking ties by activity when `activityOf` is supplied.
 */
export function searchSky(model, query, trashLabel = '回收站', activityOf = null) {
  const q = norm(query.trim());
  const rows = [];
  const trashMatches = !q || [trashLabel, '回收站'].some((s) => norm(s).includes(q));
  const rateOf = (cid) => {
    if (!activityOf) return { rate: 0, level: 'quiet' };
    const info = typeof activityOf === 'function' ? activityOf(cid) : clusterActivity(activityOf, cid);
    return { rate: Number(info?.rate) || 0, level: info?.level ?? 'quiet' };
  };
  if (!q) {
    if (activityOf) {
      const hot = [];
      const quiet = [];
      let order = 0;
      for (const g of model.galaxies) for (const s of g.systems) {
        const act = rateOf(s.cluster.id);
        const unread = Number(s.cluster.unread) || 0;
        const entry = { type: 'cluster', system: s, group: g.name, score: 0, activity: act, unread, order: order++ };
        if (act.rate > 0 || unread > 0) hot.push({ ...entry, section: 'active' });
        else quiet.push(entry);
      }
      hot.sort((a, b) => (LEVEL_RANK[b.activity.level] - LEVEL_RANK[a.activity.level])
        || (b.activity.rate - a.activity.rate)
        || (b.unread - a.unread)
        || (a.order - b.order));
      for (const r of hot) rows.push(r);
      for (const r of quiet) rows.push(r);
    } else {
      for (const g of model.galaxies) for (const s of g.systems) rows.push({ type: 'cluster', system: s, group: g.name, score: 0 });
    }
    rows.push({ type: 'trash' });
    return { rows, active: 0 };
  }
  const hits = [];
  let order = 0;
  for (const g of model.galaxies) for (const s of g.systems) {
    const own = rank(s.cluster.name, q);
    const group = g.name ? rank(g.name, q) : -1;
    const members = s.planets.map((p) => ({ p, r: memberRank(p.member, q) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r);
    const score = own >= 0 ? own : group >= 0 ? 3 : members.length ? 4 : -1;
    if (score >= 0) {
      const act = rateOf(s.cluster.id);
      hits.push({ s, g: g.name, score, members, act, unread: Number(s.cluster.unread) || 0, order: order++ });
    }
  }
  hits.sort((a, b) => (a.score - b.score)
    || (activityOf ? (LEVEL_RANK[b.act.level] - LEVEL_RANK[a.act.level]) || (b.act.rate - a.act.rate) || (b.unread - a.unread) : 0)
    || (a.order - b.order));
  for (const hit of hits) {
    rows.push({ type: 'cluster', system: hit.s, group: hit.g, score: hit.score, ...(activityOf ? { activity: hit.act } : {}) });
    for (const { p } of hit.members) rows.push({ type: 'member', system: hit.s, planet: p, group: hit.g });
  }
  if (trashMatches) rows.push({ type: 'trash' });
  const active = rows[0]?.type === 'cluster' && rows[0].score === 4 && rows[1]?.type === 'member' ? 1 : 0;
  return { rows, active };
}

// ---- the live state: /api/state, then the page's event stream (ctx.onEvent) ----

/** The newest messages kept per cluster, the ones a satellite can come from. */
export const MESSAGES_KEPT = 100;

/** `seq`: the newest event the state holds (the snapshot's, then each frame applied); older frames change nothing. */
export function createSkyState() {
  return { clusters: new Map(), members: new Map(), running: new Map(), groupOrder: [], harnesses: null, messages: new Map(), seq: 0 };
}

/**
 * Takes in GET /api/state (active members only, each cluster's `unread`, the event `seq` it was read at) and GET
 * /api/harnesses; the messages already read stay. Then `frames`, the stream's frames kept while it was read, are
 * applied again: only those newer than the snapshot change anything (applySkyEvent). Returns their changes (no nulls).
 */
export function loadSnapshot(state, snapshot, harnesses = null, frames = []) {
  state.seq = Number(snapshot.seq) || 0;
  state.clusters = new Map((snapshot.clusters ?? []).filter((c) => !c.deletedAt).map((c) => [c.id, c]));
  state.members = new Map((snapshot.members ?? []).filter((m) => !m.removedAt).map((m) => [m.id, m]));
  state.groupOrder = Array.isArray(snapshot.settings?.clusterGroups) ? snapshot.settings.clusterGroups : [];
  state.running = new Map();
  for (const d of snapshot.running ?? []) addRunning(state, d.memberId, d.id, true);
  state.harnesses = Array.isArray(harnesses) ? harnesses : null;
  // The messages these frames bring were already merged in when they streamed. Drop them before the replay, so each
  // frame meets the message list it first met: a read position moved before such a message must not count it, and its
  // own frame then counts it once (otherwise both would, once each).
  const replayed = new Set(frames.filter((e) => e?.kind === 'message' && Number(e.seq) > state.seq && e.payload?.message?.id)
    .map((e) => e.payload.message.id));
  if (replayed.size) for (const [cid, list] of state.messages) state.messages.set(cid, list.filter((m) => !replayed.has(m.id)));
  return frames.map((event) => applySkyEvent(state, event)).filter(Boolean);
}

function addRunning(state, memberId, deliveryId, on) {
  if (!memberId || !deliveryId) return;
  if (!state.running.has(memberId)) state.running.set(memberId, new Set());
  state.running.get(memberId)[on ? 'add' : 'delete'](deliveryId);
}

/** A page of messages read for `clusterId` (oldest first), merged with what the stream added meanwhile. */
export function setMessages(state, clusterId, list) {
  const seen = new Map((state.messages.get(clusterId) ?? []).map((m) => [m.id, m]));
  for (const m of list) seen.set(m.id, m);
  const all = [...seen.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  state.messages.set(clusterId, all.slice(-MESSAGES_KEPT));
}

/**
 * Applies one frame of the event stream, once: a frame not newer than `state.seq` (already in the snapshot, or seen)
 * changes nothing. Returns what changed: `trash` (the recycle bin's contents may have), `reload`
 * (read /api/state again: a restored cluster's members are not in its event), `layout`
 * (clusters, groups or members came or went: compare skyKey to see whether the sky moves), `status` (some planet may
 * look different), `notices` (the cluster ids whose satellites may have changed), `unread` (a cluster's unread count
 * changed) and `recount` (the user's read position moved past the messages held here: the Hub counts again, from
 * /api/state); null when nothing did.
 *
 * Unread counts follow the Hub's rule (Store.unreadCounts, ui.js clusterUnread): the messages after the user's read
 * position not from the user. The snapshot's count, plus each newer such message; when the position moves, counted
 * again from the held messages if they hold it.
 */
export function applySkyEvent(state, event) {
  const p = event?.payload;
  if (!p) return null;
  if (Number.isFinite(event.seq)) {
    if (event.seq <= state.seq) return null;
    state.seq = event.seq;
  }
  switch (event.kind) {
    case 'cluster': {
      const c = p.cluster;
      if (!c?.id) return null;
      const before = state.clusters.get(c.id);
      const gone = Boolean(c.deletedAt || c.purgedAt);
      // A cluster back from the recycle bin may come without its members: the caller reads /api/state again.
      const reload = !gone && !state.clusters.has(c.id) && !(p.members ?? []).length;
      if (gone) {
        state.clusters.delete(c.id);
        state.messages.delete(c.id);
        for (const [id, m] of state.members) if (m.clusterId === c.id) state.members.delete(id);
      } else {
        state.clusters.set(c.id, { ...before, ...c });
        for (const m of p.members ?? []) upsertMember(state, m);
      }
      const change = { trash: true, layout: true, status: true, notices: [c.id], reload, unread: false, recount: false };
      const readId = c.userReadMessageId ?? null;
      if (!gone && before && 'userReadMessageId' in c && readId !== (before.userReadMessageId ?? null)) {
        const held = state.messages.get(c.id) ?? [];
        if (readId !== null && held.some((m) => m.id === readId)) {
          state.clusters.get(c.id).unread = clusterUnread(held, readId);
          change.unread = true;
        } else change.recount = true;
      }
      return change;
    }
    case 'member':
      if (!p.member?.id) return null;
      upsertMember(state, p.member);
      return { trash: false, layout: true, status: true, notices: [p.member.clusterId] };
    case 'delivery':
      if (!p.delivery) return null;
      addRunning(state, p.delivery.memberId, p.delivery.id, p.delivery.state === 'running');
      return { trash: false, layout: false, status: true, notices: [] };
    case 'message': {
      const m = p.message;
      if (!m?.clusterId || m.privateTo) return null;
      for (const d of p.deliveries ?? []) addRunning(state, d.memberId, d.id, d.state === 'running');
      if (state.messages.has(m.clusterId)) setMessages(state, m.clusterId, [m]);
      const cluster = state.clusters.get(m.clusterId);
      const unread = Boolean(cluster) && m.from !== 'user';
      // in place: the model's systems hold this object, so the list and the cards show it without a rebuild
      if (unread) cluster.unread = (cluster.unread ?? 0) + 1;
      return {
        trash: false, layout: false, status: Boolean(p.deliveries?.length),
        notices: isSystemMessage(m) ? [m.clusterId] : [], unread, activity: m,
      };
    }
    case 'settings':
      if (!Array.isArray(p.clusterGroups)) return null;
      state.groupOrder = p.clusterGroups;
      return { trash: false, layout: true, status: false, notices: [] };
    default:
      return null;
  }
}

function upsertMember(state, m) {
  if (m.removedAt) state.members.delete(m.id);
  else state.members.set(m.id, { ...state.members.get(m.id), ...m });
}

// ---- keys: / and Ctrl+K the list, Esc back a level, F the frame rate ----

/**
 * What a key press does in the star map; the scene calls preventDefault for every action. `key`: the KeyboardEvent's
 * key, `mod` Ctrl or Meta held, `alt` Alt held. `where`: 'sky' (the star map's own elements, or nothing focused),
 * 'window' (a chat window: its keys are its own) or 'outside' (the sidebar, a host dialog: not ours). `typing`: focus
 * is in a text field. `open`: the star map's topmost open thing ('finder', 'ncard', 'help', 'menu') or null. `top`: the
 * view is at the universe level. Esc closes one thing at a time; at the universe, with nothing open, it is left to the
 * host, which closes the view. Returns null (not ours), 'finder-toggle', 'finder-open', 'close' (the `open` one),
 * 'leave' (focus back to the sky: a draft must not close the star map), 'up' or 'hud'.
 */
export function keyAction({ key, mod = false, alt = false }, { where, typing = false, open = null, top = false }) {
  if (where === 'outside') return null;
  if (where === 'window') return key === 'Escape' ? 'leave' : null;
  if ((key === 'k' || key === 'K') && mod && !alt) return 'finder-toggle';
  if (key === 'Escape') return open ? 'close' : typing ? 'leave' : top ? null : 'up';
  if (typing || mod || alt) return null;
  if (key === '/') return 'finder-open';
  if (key === 'f' || key === 'F') return 'hud';
  return null;
}
