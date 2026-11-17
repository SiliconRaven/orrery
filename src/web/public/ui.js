// DOM helpers. Untrusted strings (names, message bodies, agent output) only ever become text nodes or
// attribute values — never HTML.
import { inlineText, markdownBlocks } from './markdown.js';
import { inRanges, quotedRanges, TASK_REF, taskRefMatches, taskStatusChip } from './task-refs.js';
import { SYSTEM_CATEGORIES, systemClass, WARNING_LEVEL_LABELS } from './system-kinds.js';

/** Keep a bridge's source-list report separate from a client's own declaration. */
export function toolVersionView(report, memberId, harness, now = Date.now()) {
  const row = report?.members?.find((item) => item.memberId === memberId);
  const current = row && report?.hub?.[row.profile];
  const obs = row?.observation;
  const describe = (claim) => {
    if (!claim || !current || claim.profile !== row.profile) return { text: '未知', state: 'unknown' };
    const callAt = Date.parse(obs?.lastCallAt);
    const stale = !Number.isFinite(callAt) || now - callAt > obs.staleAfterMs;
    const match = claim.fingerprint === current;
    const partial = claim.registered && claim.registered.succeeded !== claim.registered.total;
    const registrations = claim.registered ? ` · 注册 ${claim.registered.succeeded}/${claim.registered.total}` : '';
    const source = { 'claude-forwarded': 'Claude 桥转发', 'claude-fallback': 'Claude 桥内置', 'dsh-source': 'DeepSeek 插件清单', client: '客户端自报' }[claim.source] || '声明';
    return { text: `${source}：${match ? '与 Hub 一致' : '与 Hub 不同'} · ${claim.fingerprint.slice(7, 19)}${registrations}${partial ? '（未全部注册）' : ''}${stale ? ' · 记录已过期' : ''}`,
      state: stale ? 'unknown' : match && !partial ? 'match' : 'different' };
  };
  const client = describe(obs?.client), bridge = describe(obs?.bridge);
  const advice = harness === 'claude' ? '在 Claude 中重连 MCP；若对话仍使用旧工具，重开对话。'
    : harness === 'deepseek' ? '在 DeepSeek 中重载 orrery 插件；若对话仍使用旧工具，重开对话。'
      : harness === 'antigravity' ? '在 Antigravity 的 MCP Servers 设置里刷新 orrery；必要时重启应用。'
        : harness === 'zcode' ? '在应用中重载 orrery 插件并重连 MCP；必要时重开对话。'
          : harness === 'workbuddy' ? '在 WorkBuddy 的 MCP 设置里重连 orrery 服务器；必要时新开对话。'
            : harness === 'qoder' ? '在 Qoder 里重载 orrery 插件；若对话仍使用旧工具，重开对话。'
              : harness === 'cursor' ? '在 Cursor 里重新加载窗口，确认 orrery MCP 服务器开着；若对话仍使用旧工具，重开对话。'
              : '在应用中重连 orrery MCP；若仍使用旧工具，重开对话。';
  return { hub: current ? current.slice(7, 19) : '未知', client, bridge,
    lastCall: obs?.lastCallAt ?? null, advice: client.state === 'different' || bridge.state === 'different' ? advice : null };
}

/**
 * The member page's read-only health lines from GET /api/tool-versions: the Hub's connection check
 * (state, basis, when it ran) and the newest failed or offline delivery. Missing data stays unknown:
 * "no failure record" is only said when the report really carries a null lastProblem.
 */
export function memberHealth(report, member) {
  const row = report?.members?.find((item) => item.memberId === member.id);
  const observed = row?.connection?.observedAt ? fmtTime(row.connection.observedAt) : null;
  let connection;
  if (member.removedAt) connection = { state: 'offline', label: '离线', basis: '已移出集群', observed: null };
  else if (!row?.connection) {
    connection = { state: 'unknown', label: '未知', basis: report ? '报告里没有这个成员的连接信息' : '工具版本报告读取失败', observed: null };
  } else {
    const state = row.connection.state === 'online' || row.connection.state === 'offline' ? row.connection.state : 'unknown';
    connection = { state, label: state === 'online' ? '在线' : state === 'offline' ? '离线' : '未知',
      basis: row.connection.basis ?? '未知', observed };
  }
  let problem;
  if (!report) problem = { known: false, text: '工具版本报告读取失败' };
  else if (!row) problem = { known: false, text: '报告里没有这个成员的投递记录' };
  else if (!Object.hasOwn(row, 'lastProblem')) problem = { known: false, text: '报告缺少投递记录字段' };
  else if (!row.lastProblem) problem = { known: true, text: null };
  else if (row.lastProblem.state !== 'failed' && row.lastProblem.state !== 'offline') {
    problem = { known: false, text: '投递记录格式不可识别' };
  } else {
    const label = row.lastProblem.state === 'offline' ? '离线未投递' : '投递失败';
    problem = { known: true, text: (row.lastProblem.at ? fmtTime(row.lastProblem.at) : '时间未知') + ' · ' + label
      + (row.lastProblem.error ? '：' + snippet(row.lastProblem.error, 80) : '') };
  }
  return { connection, problem };
}

/** h('div', { class: 'x', onclick: fn }, 'text', child) — strings become text nodes. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * A line icon from index.html's sprite (h() cannot make SVG elements); decorative, so the control around it keeps its
 * own name. `cls`: extra classes, such as 'ico-sm' beside small text.
 */
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `ico ${cls}` : 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const svgEl = (tag, attrs) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
/** The empty-state picture shares the brand's single orbit and two stars, in currentColor. */
function orbitArt() {
  const svg = svgEl('svg', { class: 'empty-art', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('use', { href: '#i-orbit' }));
  return svg;
}

/**
 * The one empty state of every empty list or panel: the orbit picture, one sentence (`text`: a string or nodes) and an
 * optional `action` ({ label, onclick } for a small button, or a node). `compact`: a 20 px picture beside the sentence, for
 * a row inside a card where a 48 px picture would weigh too much. test/ui-empty-state.test.ts keeps other code from
 * building its own.
 */
export function emptyState(text, { action = null, compact = false } = {}) {
  const button = typeof action?.label === 'string' && typeof action.onclick === 'function' ? h('button', { type: 'button', class: 'small', onclick: action.onclick }, action.label) : action;
  return h('div', { class: compact ? 'empty-state compact' : 'empty-state' }, orbitArt(), h('p', {}, text), button);
}

// Only raster images; an SVG data URL could carry script.
export const DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
export const MAX_AVATAR = 256 * 1024;

/** One of 12 hues 30° apart, so similar names (mock-1, mock-1-2) still tend to differ visibly. */
function nameHue(name) {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b) >>> 0;   // mix, so the last character moves the result
  return (((n ^ (n >>> 16)) >>> 0) % 12) * 30;
}

/**
 * The preset name of a `preset:<name>` avatar, or null. Kept to the Hub's rule (lowercase letters, digits, single
 * hyphens between them), so a stored value can only ever address a file the Hub ships.
 */
export function presetName(avatar) {
  if (typeof avatar !== 'string' || !avatar.startsWith('preset:')) return null;
  const name = avatar.slice('preset:'.length);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : null;
}

/**
 * Each supported app by the Hub's harness id (src/adapters/index.ts): the name the desktop shell's tab strip uses
 * (desktop/lib/apps.mjs; a test keeps the two the same) and its icon: a static copy of the app's own program icon in
 * src/web/public/app-icons, named by the desktop app id (Hub `kimi` is the desktop's `kimi-code`).
 */
const HARNESS_APPS = {
  claude: { name: 'Claude', icon: '/app-icons/claude.ico' },
  codex: { name: 'ChatGPT / Codex', icon: '/app-icons/codex.png' },
  deepseek: { name: 'DeepSeek Harness', icon: '/app-icons/deepseek.png' },
  kimi: { name: 'Kimi Code', icon: '/app-icons/kimi-code.png' },
  zcode: { name: 'ZCode', icon: '/app-icons/zcode.png' },
  antigravity: { name: 'Antigravity', icon: '/app-icons/antigravity.png' },
  qoder: { name: 'Qoder', icon: '/app-icons/qoder.png' },
  workbuddy: { name: 'WorkBuddy', icon: '/app-icons/workbuddy.png' },
  cursor: { name: 'Cursor', icon: '/app-icons/cursor.ico' },
};

/** { name, icon } of a harness: its app, or for one the page does not know (the test `mock`, a newer adapter) its id and no picture. */
export function harnessApp(harness) {
  const id = String(harness ?? '');
  return Object.hasOwn(HARNESS_APPS, id) ? HARNESS_APPS[id] : { name: id, icon: null };
}

/**
 * How a default avatar (the member's app icon) tells members of one app apart: 'badge', a small corner disc with the
 * name's initial on the member's colour, or 'ring', the icon inside a ring of that colour. Changing it is this one line.
 */
export const APP_AVATAR_MARK = 'badge';

// Lightness of the member colour per hue (index: hue / 30): the name's hue as before (42% 46%), darkened only where a
// white letter would fall below 4.5:1 (yellow to green); the hue, so each member's colour identity, is unchanged.
const MARK_LIGHTNESS = [46, 42, 33, 35, 36, 36, 35, 46, 46, 46, 46, 46];
const hueColor = (hue) => `hsl(${hue} 42% ${MARK_LIGHTNESS[hue / 30]}%)`;
/** A member's own colour: the fill of the initial tile and of the default avatar's mark; white text on it is at least 4.5:1. */
export function memberColor(name) {
  return hueColor(nameHue(name));
}

/**
 * Which avatar a member shows: 'image' (upload), 'preset', 'emoji', else the default: 'app' (its app's icon) or
 * 'initial'. A member who has left keeps the rule it had (its own avatar, else the initial tile) in the history.
 */
export function avatarKind(member) {
  const a = member.avatar;
  if (typeof a === 'string' && DATA_URL_RE.test(a)) return 'image';
  if (presetName(a)) return 'preset';
  if (typeof a === 'string' && a && !a.startsWith('data:') && a.length <= 16) return 'emoji';
  return harnessApp(member.harness).icon && !member.removedAt ? 'app' : 'initial';
}

const initialOf = (member) => ([...member.name][0] ?? '?').toUpperCase();

const graphemes = (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(String(text ?? ''))].map((s) => s.segment);
const isWordChar = (g) => /^[\p{L}\p{N}]/u.test(g);
const upper = (g) => g.toUpperCase();

/**
 * The marks of the default avatars of one cluster's current members (`members`, in join order): id → { label, color }
 * for each member whose avatar is its app's icon. Within one app, labels and colours differ where they can:
 * - label: the name's first character, unless another member of the app starts with the same one; then, in join
 *   order, the first free of: the first letter or digit after the longest prefix it shares with those members
 *   (claude-2 → 2), the first of its last name part (claude-opus → O), the letters and digits after the prefix all of
 *   them share, the rest of its letters and digits, 1–9; with all of those taken, its first character again. One
 *   grapheme (a CJK character or an emoji stays whole), Latin letters in capitals.
 * - colour: the name's hue; if an earlier member of the app has it, the next free of the 12 hues (same lightness rule).
 * So a label or colour changes only when a member of the same app whose name starts with the same character (label) or
 * hashes to the same hue (colour) joins or leaves; members of other apps and other initials never move it.
 */
export function memberMarks(members) {
  const marks = new Map();
  const byApp = new Map();
  for (const m of members) {
    if (m.removedAt || avatarKind(m) !== 'app') continue;
    if (!byApp.has(m.harness)) byApp.set(m.harness, []);
    byApp.get(m.harness).push(m);
  }
  for (const group of byApp.values()) {
    const chars = new Map(group.map((m) => [m.id, graphemes(m.name)]));
    const first = (m) => upper(chars.get(m.id)[0] ?? '?');
    const taken = new Set(group.filter((m) => group.every((o) => o === m || first(o) !== first(m))).map(first));
    const hues = new Set();
    for (const m of group) {
      const g = chars.get(m.id);
      const peers = group.filter((o) => o !== m && first(o) === first(m)).map((o) => chars.get(o.id));
      const shared = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
      let label = first(m);
      if (peers.length) {
        const own = peers.reduce((n, p) => Math.max(n, shared(g, p)), 0);
        const common = peers.reduce((n, p) => Math.min(n, shared(g, p)), g.length);
        const after = (from) => g.slice(from).filter(isWordChar);
        const lastPart = g.join('').split(/[^\p{L}\p{N}]+/u).filter(Boolean).at(-1);
        const candidates = [after(own)[0], lastPart ? graphemes(lastPart)[0] : undefined, ...after(common), ...g.filter(isWordChar),
          ...'123456789'].filter(Boolean).map(upper);
        label = candidates.find((c) => !taken.has(c)) ?? label;
      }
      taken.add(label);
      let hue = nameHue(m.name);
      for (let step = 0; step < 12 && hues.has(hue); step++) hue = (hue + 30) % 360;
      hues.add(hue);
      marks.set(m.id, { label, color: hueColor(hue) });
    }
  }
  return marks;
}

// Where avatarEl finds a member's mark (the page sets it to memberMarks over the member's cluster); without one, or for
// a member it does not cover, the name's first character and the member's own colour.
let markSource = () => null;
export function setAvatarMarks(source) { markSource = source; }

/**
 * A member's avatar: uploaded image, shipped preset, emoji, or by default its app's icon with the member's mark
 * (APP_AVATAR_MARK, setAvatarMarks); for an app without an icon, a member who has left, or an icon that fails to load,
 * the name's initial on the member's colour. Its tooltip is the member's name; `named` also makes the name its
 * accessible name, for an avatar shown without the name beside it.
 * `presence` ({ state, label }, memberPresence): the avatar sits on an orbit, a thin ring in the state's colour with the
 * state's dot on it at the upper right (45°), clear of the app badge at the lower right; offline is a hollow dot. Not
 * colour alone: the tooltip says the state, and so does the accessible name when `named` (the state's words are beside
 * the avatar elsewhere). The orbit is the returned element and carries the tooltip; the avatar inside is the same as without.
 */
export function avatarEl(member, size = '', { named = false, presence = null } = {}) {
  if (presence) {
    const said = `${member.name} · ${presence.label}`;
    return h('span', { class: ['avatar-orbit', size, `presence-${presence.state}`].filter(Boolean).join(' '), title: said,
      ...(named ? { role: 'img', 'aria-label': `${member.name}，${presence.label}` } : {}) },
    avatarFace(member, size, {}), h('span', { class: 'presence-dot', 'aria-hidden': 'true' }));
  }
  return avatarFace(member, size, { title: member.name, ...(named ? { role: 'img', 'aria-label': member.name } : {}) });
}

/** The avatar itself; `who`: its tooltip and accessible name (none inside an orbit, which carries them). */
function avatarFace(member, size, who) {
  const cls = `avatar ${size}`;
  const a = member.avatar;
  const kind = avatarKind(member);
  if (kind === 'image') return h('span', { class: cls, ...who }, h('img', { src: a, alt: '' }));
  const preset = presetName(a);
  if (preset) return h('span', { class: cls, ...who }, h('img', { src: `/avatars/${preset}.png`, alt: '' }));
  if (kind === 'emoji') return h('span', { class: `${cls} emoji`, ...who }, a);
  const tile = `background: ${memberColor(member.name)}`;
  if (kind === 'initial') return h('span', { class: cls, style: tile, ...who }, initialOf(member));
  const mark = markSource(member) ?? { label: initialOf(member), color: memberColor(member.name) };
  // A broken icon turns this element into the initial tile in place (callers may hold it), never a broken-image glyph.
  const fallback = (e) => {
    const el = e.target.parentElement;
    el.className = cls;
    el.setAttribute('style', tile);
    el.replaceChildren(initialOf(member));
  };
  return h('span', { class: `${cls} app ${APP_AVATAR_MARK}`, style: `--mark: ${mark.color}`, ...who },
    h('img', { src: harnessApp(member.harness).icon, alt: '', onerror: fallback }),
    // Decorative: the name is beside the avatar or is its accessible name.
    APP_AVATAR_MARK === 'badge' ? h('span', { class: 'avatar-mark', 'aria-hidden': 'true' }, mark.label) : null);
}

export function userAvatar(size = '') {
  return h('span', { class: `avatar user ${size}` }, '你');
}

export const isSystemMessage = (message) => message?.from === 'system' && message.kind === 'system';

/**
 * The chat's message filter, kept per browser. `hide`: system message categories not shown; `warningsOnly`: only warnings
 * (every other message hidden); both apply to every cluster. `senders`: per cluster id, the one sender whose messages
 * alone are shown ('user', 'system' or a member id), since member ids belong to one cluster. New kinds of filter add
 * fields here, and `chatShowsMessage` reads them. A stored value of the older { hide, warningsOnly } shape reads as is.
 */
export const CHAT_FILTER_KEY = 'orrery.chatFilter';
export const CHAT_FILTER_DEFAULT = Object.freeze({ hide: [], warningsOnly: false, senders: Object.freeze({}) });

export function chatFilterFromStored(raw) {
  let value = null;
  try { value = JSON.parse(raw); } catch { /* absent or damaged: the default */ }
  if (!value || typeof value !== 'object') return CHAT_FILTER_DEFAULT;
  const hide = Array.isArray(value.hide) ? SYSTEM_CATEGORIES.filter((category) => value.hide.includes(category)) : [];
  const senders = {};
  if (value.senders && typeof value.senders === 'object' && !Array.isArray(value.senders)) {
    for (const [cid, sender] of Object.entries(value.senders)) if (typeof sender === 'string' && sender) senders[cid] = sender;
  }
  return { hide, warningsOnly: value.warningsOnly === true, senders };
}

/** How many filter settings differ from showing everything in cluster `cid` (0: nothing hidden). */
export const chatFilterCount = (filter, cid) => filter.hide.length + (filter.warningsOnly ? 1 : 0) + (cid && filter.senders?.[cid] ? 1 : 0);

/**
 * Whether the chat list shows a message under `filter`. Acknowledgement receipts are no longer written; old ones stay in
 * the record (read_messages history) but never in the chat.
 */
export function chatShowsMessage(message, filter = CHAT_FILTER_DEFAULT) {
  const system = isSystemMessage(message);
  if (system && message.systemKind === 'receipt') return false;
  const sender = filter.senders?.[message.clusterId];
  if (sender && message.from !== sender) return false;
  const { category } = system ? systemClass(message.systemKind) : { category: null };
  if (filter.warningsOnly) return category === 'warning';
  return !category || !filter.hide.includes(category);
}

/**
 * How the chat list treats a message: 'shown', 'hidden' by the filter, or 'jump': hidden by the filter but the target of
 * an explicit jump (openMessage), so it is shown anyway and marked as such until the filter changes or the chat moves on.
 */
export function chatRowState(message, filter, jumpId = null) {
  if (chatShowsMessage(message, filter)) return 'shown';
  return jumpId !== null && message?.id === jumpId ? 'jump' : 'hidden';
}

/**
 * The chat's one jump (openMessage) as a value: `{ cid, id, receipts, token, landed }`, or null when there is none.
 * While it exists its target is let through the chat filter (`jumpExceptionId`); until it has `landed` the chat scrolls
 * to the target once it is drawn and keeps the page it shows (`jumpPending`). `token` is unique per jump, so an answer
 * meant for an earlier or cancelled jump changes nothing. Every other event ends it:
 * - open {cid, id, receipts, token}: a new jump replaces any earlier one;
 * - answer {token, found}: the window read around the target came back, without the target: ended;
 * - failed {token}: that read failed: ended;
 * - landed {token}: the target was drawn, scrolled to and its receipts opened: it stays let through, no longer pending;
 * - view {cid}: the chat shows cluster `cid` (null: the overview or nothing): a jump into another cluster ends;
 * - filter: the user changed the chat filter: ended;
 * - latest {cid}: the newest messages were asked for (回到最新, a fresh read) in that cluster: ended.
 */
export function nextJump(jump, event) {
  const current = jump !== null && jump.token === event.token;
  switch (event.type) {
    case 'open': return { cid: event.cid, id: event.id, receipts: Boolean(event.receipts), token: event.token, landed: false };
    case 'answer': return current && !event.found ? null : jump;
    case 'failed': return current ? null : jump;
    case 'landed': return current ? { ...jump, landed: true } : jump;
    case 'view': case 'latest': return jump !== null && (event.type === 'view' ? jump.cid === event.cid : jump.cid !== event.cid) ? jump : null;
    case 'filter': return null;
    default: return jump;
  }
}
/** Whether `token` is still the jump in progress (a stale answer must not touch anything). */
export const jumpCurrent = (jump, token) => jump !== null && jump.token === token;
/** The message a jump lets through the filter in cluster `cid`, or null. */
export const jumpExceptionId = (jump, cid) => (jump !== null && jump.cid === cid ? jump.id : null);
/** Whether a jump in cluster `cid` still waits to scroll to its target (the live window then keeps its page). */
export const jumpPending = (jump, cid) => jump !== null && jump.cid === cid && !jump.landed;

/** The warning mark of a system message: { level, label } for a problem or an attention item, else null. */
export function systemMark(message) {
  if (!isSystemMessage(message)) return null;
  const { category, level } = systemClass(message.systemKind);
  return category === 'warning' && level ? { level, label: WARNING_LEVEL_LABELS[level] } : null;
}

export function messageAuthorName(message, members) {
  if (isSystemMessage(message)) return 'Orrery 系统';
  if (typeof message.from === 'string' && message.from.startsWith('plugin:')) return `插件 ${message.from.slice(7)}`;
  if (message.from === 'user') return '你';
  const member = members.get(message.from);
  if (!member) return '(未知成员)';
  if (member.removedAt) {
    for (const other of members.values()) {
      if (other && !other.removedAt && other.name === member.name
        && (!member.clusterId || !other.clusterId || other.clusterId === member.clusterId)) {
        return `${member.name}（已移出）`;
      }
    }
  }
  return member.name;
}

export function systemAvatar() {
  return h('span', { class: 'avatar system', 'aria-hidden': 'true' }, icon('orbit'));
}

export function fmtTime(iso) {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * How long ago `iso` was, in local time: 刚刚 (under a minute, and any time ahead of `now` from clock skew),
 * N 分钟前, N 小时前 (same day), 昨天, N 天前 (up to six days), then the date (with the year when it is another year).
 * '' for a missing or unreadable time.
 */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const ms = Math.max(0, now - t);
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  const then = new Date(t);
  const today = new Date(now);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(then)) / 86_400_000);   // calendar days; round: a DST day is 23 or 25 hours
  if (days <= 0) return `${Math.floor(ms / 3_600_000)} 小时前`;
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const date = `${then.getMonth() + 1}月${then.getDate()}日`;
  return then.getFullYear() === today.getFullYear() ? date : `${then.getFullYear()}年${date}`;
}

/** The full local time for a relative time's tooltip. */
export const fullTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
};

/** A `<time>` showing relativeTime(iso); refreshRelativeTimes() updates every one of them in place. */
export function relativeTimeEl(iso, className = 'rel-time') {
  return h('time', { class: className, datetime: iso, 'data-rel-at': iso, title: fullTime(iso) }, relativeTime(iso));
}

/** Rewrites the text of every relativeTimeEl under `root` whose words changed; nothing is redrawn. */
export function refreshRelativeTimes(root, now = Date.now()) {
  for (const el of root.querySelectorAll('time[data-rel-at]')) {
    const text = relativeTime(el.dataset.relAt, now);
    if (el.textContent !== text) el.textContent = text;
  }
}

export const snippet = (s, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

/**
 * A picker on a textarea: typing `trigger` at a word start (after `lead`, a character class) lists `candidates(query)`
 * ([{ name, ... }]) that `match` what follows ('prefix', 'includes' or a function of (candidate, query)); picking
 * replaces that with `name `. `item(c)` is a candidate's menu row content. Returns a keydown handler that reports
 * whether it consumed the key; its `refresh()` redraws the menu when candidates arrive later.
 */
export function attachPicker(input, menu, { trigger, lead, candidates, item, match = 'prefix' }) {
  let items = [];
  let index = 0;
  const esc = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|${lead})${esc}([^\\s${esc}]*)$`);

  /** The token that ends at the caret, read fresh each time: { start (just after the trigger), query } or null. */
  const token = () => {
    if (input.selectionStart !== input.selectionEnd) return null;
    const before = input.value.slice(0, input.selectionStart);
    const m = re.exec(before);
    return m ? { start: before.length - m[1].length, query: m[1].toLowerCase() } : null;
  };
  const matches = (c, t) => {
    if (typeof match === 'function') return match(c, t.query);
    return match === 'includes' ? c.name.toLowerCase().includes(t.query) : c.name.toLowerCase().startsWith(t.query);
  };
  const close = () => { menu.hidden = true; items = []; };
  const update = () => {
    const t = token();
    if (!t) return close();
    items = candidates(t.query).filter((c) => matches(c, t));
    index = 0;
    draw();
  };
  /** Replaces the token at the caret; if the caret moved off the token the menu was drawn for, just refreshes. */
  const pick = (c) => {
    const t = token();
    if (!t || !matches(c, t)) return update();
    const end = input.selectionStart;
    input.value = `${input.value.slice(0, t.start)}${c.name} ${input.value.slice(end)}`;
    const pos = t.start + c.name.length + 1;
    input.setSelectionRange(pos, pos);
    close();
    input.focus();
    input.dispatchEvent(new Event('input'));   // the value changed: the composer regrows (the menu stays closed)
  };
  const draw = () => {
    menu.replaceChildren(...items.map((c, i) => h('li', {
      role: 'option',
      'aria-selected': String(i === index),
      onmousedown: (e) => { e.preventDefault(); pick(c); },
    }, item(c))));
    menu.hidden = items.length === 0;
    menu.children[index]?.scrollIntoView?.({ block: 'nearest' });   // the list scrolls past 240px; keep the highlight in view
  };
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', close);
  // Caret moves that fire no input event. Up/Down are left out: while the menu is open they move the highlight.
  input.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) update();
  });
  const keydown = (e) => {
    if (menu.hidden || e.isComposing) return false;
    const plain = !(e.shiftKey || e.ctrlKey || e.altKey || e.metaKey);
    if (plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (plain && (e.key === 'Enter' || e.key === 'Tab')) pick(items[index]);
    else if (e.key === 'Escape') close();
    else return false;   // includes Shift+Enter, which stays a newline
    e.preventDefault();
    return true;
  };
  keydown.refresh = () => { if (document.activeElement === input) update(); };
  return keydown;
}

/** @-autocomplete: `candidates()` returns [{ name, member|null }]. */
export function attachMentions(input, menu, candidates) {
  return attachPicker(input, menu, {
    trigger: '@', lead: '[^A-Za-z0-9]', candidates,
    item: (c) => [c.member ? avatarEl(c.member, 'sm') : h('span', { class: 'avatar sm all-members', 'aria-hidden': 'true' }, icon('users')), c.name],
  });
}

/**
 * $-skill picker: `candidates()` returns [{ name, description }]; any part of the name matches. `$` after a letter,
 * digit, `_` or `$` is not a skill reference (the Hub's skillRefs uses the same rule), so no menu there.
 */
export function attachSkills(input, menu, candidates) {
  return attachPicker(input, menu, {
    trigger: '$', lead: '[^A-Za-z0-9_$]', candidates, match: 'includes',
    item: (c) => [h('b', { class: 'skill-name' }, `$${c.name}`), c.description ? h('span', { class: 'muted skill-desc' }, snippet(c.description, 80)) : null],
  });
}

/**
 * #-task picker: `candidates(query)` returns [{ name: task number or id, number?, id?, title, status? }]; picking inserts
 * `#<number> ` (or `#<id> ` when unnumbered). A row is `#number title` and the status chip of the task workbench.
 */
export function attachTaskRefs(input, menu, candidates) {
  return attachPicker(input, menu, {
    trigger: '#', lead: '[^A-Za-z0-9_#]', candidates, match: taskRefMatches,
    item: (c) => {
      const chip = taskStatusChip(c.status);
      return [h('b', { class: 'skill-name' }, c.number != null ? `#${c.number}` : `#${c.name.slice(0, 8)}`), h('span', { class: 'muted skill-desc' }, snippet(c.title, 80)),
        chip ? h('span', { class: `${chip.className} task-pick-status` }, h('span', { class: 'wb-status-dot', 'aria-hidden': 'true' }), chip.label) : null];
    },
  });
}

/** Enter sends, Shift+Enter is a newline, and IME composition (Chinese input) is left alone. */
export function submitOnEnter(input, form, before = () => false) {
  input.addEventListener('keydown', (e) => {
    if (before(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}

/**
 * A button that opens a small menu of role="menuitem" buttons (the composer's "+"). The menu is in the page, hidden.
 * Click (so Enter and Space too) toggles it, ↓/↑ on the button open it at the first/last item, ↓/↑ move between items,
 * Esc closes it and returns focus to the button; so does choosing an item. A press or focus elsewhere just closes it.
 * The page-wide press listener exists only while the menu is open, so a menu rebuilt on every redraw leaks nothing.
 * `onClose` runs after each close (e.g. to apply a redraw that waited for the menu).
 */
export function attachMenu(button, menu, onClose = () => {}) {
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter((item) => !item.hidden);
  const outside = (e) => { if (!menu.contains(e.target) && !button.contains(e.target)) close(); };
  const show = (open) => {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) document.addEventListener('pointerdown', outside);
    else document.removeEventListener('pointerdown', outside);
  };
  const open = (last = false) => { show(true); items().at(last ? -1 : 0)?.focus(); };
  const close = (restore = false) => {
    if (menu.hidden) return;
    show(false);
    if (restore) button.focus();
    onClose();
  };
  button.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    open(e.key === 'ArrowUp');
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    list[(list.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  });
  menu.addEventListener('click', (e) => { if (e.target.closest('[role="menuitem"]')) close(true); });
  menu.addEventListener('focusout', () => setTimeout(() => {
    if (!menu.contains(document.activeElement) && document.activeElement !== button) close();
  }, 0));
}

// ---- confirm and notice dialogs: in the page, never the browser's own (they block the page and cannot be styled) ----

/** Wraps an async `open` so calls run one after another: a later dialog opens only once the earlier one has closed. */
export function oneAtATime(open) {
  let tail = Promise.resolve();
  return (arg) => {
    const run = tail.then(() => open(arg));
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * Shows one modal dialog and resolves true only when its confirm button is pressed. Esc and the cancel button resolve
 * false. Focus starts on cancel (or on the only button), so Enter does not confirm by accident, and goes back to the
 * element that had it when the dialog closes. Text is set as text nodes, never parsed as HTML.
 */
const showDialog = oneAtATime(({ title, message, confirmText, cancelText, danger }) => new Promise((resolve) => {
  const trigger = document.activeElement;
  const cancel = cancelText ? h('button', { type: 'submit', value: 'cancel' }, cancelText) : null;
  const ok = h('button', { type: 'submit', value: 'confirm', class: danger ? 'primary danger' : 'primary' }, confirmText);
  const dialog = h('dialog', {
    class: 'ask', role: 'alertdialog', 'aria-labelledby': title ? 'ask-title' : 'ask-message', 'aria-describedby': title ? 'ask-message' : null,
  }, h('form', { method: 'dialog' },
    title ? h('h2', { id: 'ask-title' }, title) : null,
    h('p', { id: 'ask-message', class: 'ask-message' }, message),
    h('div', { class: 'row end' }, cancel, ok)));
  // A button's value becomes returnValue; Esc closes with returnValue still ''.
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (trigger?.isConnected) trigger.focus();
    resolve(dialog.returnValue === 'confirm');
  });
  document.body.append(dialog);
  dialog.showModal();
  (cancel ?? ok).focus();
}));

/** Replaces window.confirm in the page: resolves true when confirmed, false on cancel or Esc. */
export function confirmDialog({ title = '', message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return showDialog({ title, message, confirmText, cancelText, danger });
}

/** Replaces window.alert in the page: one "确定" button; resolves when closed. */
export function noticeDialog(message, title = '') {
  return showDialog({ title, message, confirmText: '确定', cancelText: null, danger: false }).then(() => {});
}

// ---- create dialog: pure helpers (no DOM, so test/web-ui.test.ts can run them in node) ----

/**
 * Efforts to offer for `modelId` from a models listing (GET /api/harnesses/:h/models). A picked model: its own.
 * '' (the harness default): the default model's when the listing marks one, else every effort any model has.
 */
export function effortChoices(models, modelId) {
  if (modelId) return models.find((m) => m.id === modelId)?.efforts ?? [];
  const def = models.find((m) => m.isDefault);
  return def ? def.efforts : [...new Set(models.flatMap((m) => m.efforts))];
}

export const RESERVED_NAMES = new Set(['all', 'user']);

/**
 * Model names like "vendor/model x" become "vendor-model-x"; nothing usable left → the harness name.
 */
export function defaultName(model, harness) {
  const name = (model ?? '').replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '');
  return name && !RESERVED_NAMES.has(name) ? name : harness;
}

/**
 * The name the Hub gives a member added without one (src/core/hub.ts buildMembers): the model's name, or the
 * harness's own default from its catalog (`models`, isDefault) when none is picked, made unique within `taken`
 * (the cluster's current member names) with -2, -3, ...
 */
export function memberDefaultName({ harness, model = '', models = [], taken = new Set() }) {
  const base = defaultName(model || models.find((m) => m.isDefault)?.id || null, harness);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * One checked harness of the create dialog → `{ specs }` for POST /api/clusters, or `{ error }`.
 * `c`: { harness, nativeCreate, project, sessions: [{ sessionId, name, avatar }], create,
 *   name, avatar, model, effort }.
 * One member per picked conversation, plus a new one only when `create` is ticked, the harness supports it,
 * and a project is explicitly selected. Existing conversations do not need a project selection.
 * `mode` is always sent; name / avatar / model / effort only when filled; model / effort only on a new member.
 */
export function harnessSpecs(c) {
  const filled = (o, k) => (o[k]?.trim() ? { [k]: o[k].trim() } : {});
  const attach = c.sessions.map((s) => ({ harness: c.harness, mode: 'native', sessionId: s.sessionId, ...filled(s, 'name'), ...filled(s, 'avatar') }));
  if (c.create) {
    if (!c.nativeCreate) return { error: `${c.harness} 只能接入已有会话：先在桌面应用里新建会话，再点「刷新」勾选它` };
    const projectPath = c.project?.trim();
    if (!projectPath) return { error: '请选择新建对话的项目目录' };
    const fresh = { harness: c.harness, mode: 'native', projectPath, ...filled(c, 'name'), ...filled(c, 'avatar'), ...filled(c, 'model'), ...filled(c, 'effort') };
    return { specs: [...attach, fresh] };
  }
  return attach.length ? { specs: attach } : { error: '请选择已有对话，或勾选新建对话' };
}

// ---- member page: pure helpers ----

/**
 * The banner on an offline native member's page, or null. `harnessAvailable` false: this Hub does not provide the
 * harness, so no bridge or session can bring it online. Otherwise the Hub cannot tell "bridge not installed" from
 * "conversation not open", so for Claude it names both. For Antigravity (one sidecar for the whole app) it names the sidecar; for ZCode, how to re-arm the wait.
 */
export function offlineHint(member, status, harnessAvailable = true) {
  if (status !== 'offline') return null;
  if (!harnessAvailable) {
    return `这个 Hub 现在没有提供 ${member.harness}，发给它的消息不会投递，只留在群聊记录里（要投递，需在 ${member.harness} 适配器可用时重启 Hub）。`;
  }
  const dropped = '这个对话现在离线，发给它的消息不会投递，上线后也不补发；消息留在群聊记录里，它之后可以用 read_messages 自己读。';
  if (member.harness === 'antigravity') {
    return `${dropped}如果 Antigravity 开着却一直离线：检查是否按 README「原生模式：Antigravity」放好了 orrery sidecar，并在 Antigravity 里启用了它。`;
  }
  if (member.harness === 'zcode') {
    return `${dropped}ZCode 开着时，在这个对话里说一句「重新挂上 orrery」（或用 orrery skill）：它运行 orrery 的等待命令后显示在线。ZCode 重启后、或上一轮没有重新挂上时都要这样做一次。`;
  }
  if (member.harness === 'workbuddy') {
    return `${dropped}WorkBuddy 开着时，在这个对话里说一句「挂上 orrery」（或用 orrery skill）：它运行 orrery 的等待命令后显示在线。对话进程被回收后要再说一次。`;
  }
  if (member.harness === 'qoder') {
    return `${dropped}Qoder 开着时，在这个对话里说一句「重新挂上 orrery」（或用 orrery skill）：它运行 orrery 的等待命令后显示在线。Qoder 重启后、或上一轮没有重新挂上时都要这样做一次。`;
  }
  if (member.harness === 'cursor') {
    return `${dropped}Cursor 对话只在每轮结束后挂着等待时在线：Cursor 开着时，在 Cursor 里对这个对话说一句话，这一轮结束后它重新上线。一直离线的话，检查是否按 README「原生模式：Cursor」装好了 orrery 插件。`;
  }
  if (member.harness !== 'claude') return dropped;
  return `${dropped}如果它在 Claude Desktop 或终端里开着却一直离线：检查是否按 README「原生模式：Claude」加了 orrery 桥（claude mcp add …）；`
    + '加完要重开这个会话，因为桥只在会话启动时加载。';
}

/** The member page's note about deliveries the Hub has warned about and that have still not started. */
export function longWaitingHint(member) {
  const n = member.removedAt ? 0 : member.longWaiting ?? 0;
  return n ? `${n} 条消息已经等了很久，这个成员还没开始处理。` : null;
}

// ---- group chat: pure helpers ----

/** Merge the three independent kinds of evidence without inventing a delivery or confirmation. */
export function receiptMembers(deliveries, reads, acknowledgements) {
  const members = new Map();
  const member = (id) => {
    if (!members.has(id)) members.set(id, { memberId: id, delivery: null, read: null, acknowledgement: null });
    return members.get(id);
  };
  for (const d of deliveries) member(d.memberId).delivery = d;
  for (const r of reads) if (!member(r.memberId).read) member(r.memberId).read = r;
  for (const a of acknowledgements) if (!member(a.memberId).acknowledgement) member(a.memberId).acknowledgement = a;
  return [...members.values()];
}

/**
 * Separate actual delivery / fyi recipients (`recipients`) from non-recipient readers (`readOnly`, e.g. read_messages
 * with history: true or ack_messages). Keeps pre-v26 / non-fyi messages without deliveries labeled as record-only.
 */
export function splitReceiptMembers(message, deliveries, reads, acknowledgements) {
  const rows = receiptMembers(deliveries, reads, acknowledgements);
  const byId = new Map(rows.map((r) => [r.memberId, r]));
  const deliveredIds = new Set(rows.filter((r) => r.delivery).map((r) => r.memberId));
  const fyiIds = new Set(message?.fyi ? (message.mentions ?? []).filter((id) => !deliveredIds.has(id)) : []);
  const recipients = rows.filter((r) => r.delivery).map((r) => ({ ...r, fyiOnly: false }));
  for (const id of fyiIds) {
    const existing = byId.get(id);
    recipients.push(existing ? { ...existing, fyiOnly: true } : { memberId: id, delivery: null, read: null, acknowledgement: null, fyiOnly: true });
  }
  const readOnly = rows.filter((r) => !r.delivery && !fyiIds.has(r.memberId));
  return { recipients, readOnly };
}

/** One-line status note below a message when it was not delivered to everyone (or fyi kept @names unread). */
export function recordOnlyNotice(message, deliveries, reads, acknowledgements, nameOf) {
  if (!message?.fyi) return deliveries.length ? null : '没有投递对象，只留在群聊记录里';
  const deliveredIds = new Set(deliveries.map((d) => d.memberId));
  const fyiIds = [...new Set(message.mentions ?? [])].filter((id) => !deliveredIds.has(id));
  const readSet = new Set([
    ...[...reads].map((r) => r.memberId),
    ...[...acknowledgements].map((a) => a.memberId),
  ]);
  const unread = fyiIds.filter((id) => !readSet.has(id));
  const read = fyiIds.filter((id) => readSet.has(id));
  if (unread.length && read.length) return `仅知会：${unread.map(nameOf).join('、')}未读，${read.map(nameOf).join('、')}已读，不唤醒`;
  if (unread.length) return `仅知会：${unread.map(nameOf).join('、')}未读，不唤醒`;
  if (read.length) return `仅知会：${read.map(nameOf).join('、')}已读，不唤醒`;
  return deliveries.length ? null : '仅知会，不唤醒';
}

// icon: the sprite icon drawn before the label (index.html).
const DELIVERY_STATE = {
  queued: { icon: 'circle', label: '排队中' }, running: { icon: 'half', label: '处理中' },
  done: { icon: 'check', label: '投递流程结束' }, failed: { icon: 'close', label: '失败' },
  offline: { icon: 'minus', label: '离线，未投递' },
  superseded: { icon: 'minus', label: '已被新的提名取代，未投递' },
};
const DELIVERY_OUTCOME = {
  accepted: { icon: 'check', label: '已接收' }, completed: { icon: 'check', label: '轮次完成' },
  failed: { icon: 'close', label: '轮次失败' }, unknown: { icon: 'help', label: '结果未知' },
};

/** Outcome describes only what the adapter can substantiate; old deliveries have no outcome. */
export function deliveryView(delivery) {
  if (delivery.state === 'superseded') return DELIVERY_STATE.superseded;
  return DELIVERY_OUTCOME[delivery.outcome] ?? DELIVERY_STATE[delivery.state];
}

export function deliveryProblem(delivery) {
  return delivery.state !== 'superseded' && (['failed', 'offline'].includes(delivery.state) || ['failed', 'unknown'].includes(delivery.outcome));
}

export function canHandoff(delivery) {
  return delivery.state !== 'superseded' && !delivery.handoffMessageId && (['failed', 'offline'].includes(delivery.state) || delivery.outcome === 'unknown');
}

export function handoffNeedsConfirmation(delivery) {
  return delivery.state !== 'superseded' && (delivery.outcome === 'unknown' || (delivery.state === 'failed' && delivery.outcome !== 'failed'));
}

/** The 有问题的投递 dialog's line under its title (GET delivery-problems: `count` in all, `shown` listed). */
export function problemsDescription(count, shown) {
  if (!count) return '没有需要处理的投递了。';
  return '离线、失败或结果未知，而且还没有交接或重发的投递。点一条跳到原消息，在回执里看原因和下一步。'
    + '交接、重发或标为已知后，它不再列出；离线的投递在那个成员自己读到这条消息后也会消失。'
    + (count > shown ? `这里列出最新的 ${shown} 条。` : '');
}

/** "全部标为已知" asks first when it marks more than five; null: it does not ask. */
export function dismissAllConfirmation(count, shown) {
  if (count <= 5) return null;
  return {
    title: '全部标为已知？',
    message: `会把 ${count} 条有问题的投递标为已知${count > shown ? `（包括列表外较早的 ${count - shown} 条）` : ''}，它们不再计数。`
      + '投递记录、回执、交接和重发都不变，之后新出现的问题照常显示。标记不能撤销。',
    confirmText: '全部标为已知',
  };
}

/**
 * "全部标为已知" for one listing (GET delivery-problems), taken when the button is pressed: the question to ask first
 * (null: none) and the body to send, its version bound fixed now so a later listing cannot change what is confirmed.
 */
export function dismissAllRequest(listing) {
  return { ask: dismissAllConfirmation(listing.count, listing.items.length), body: { version: listing.version } };
}

// ---- handover package (docs/cluster-members.md「交接包」) ----

// The task state names the workbench also uses; ui.js cannot import workbench.js (it imports this file).
const HANDOVER_STATUS = { pending: '待开工', working: '进行中', review: '待验收', completed: '已完成', merged: '已合并', cancelled: '已取消' };
const HANDOVER_ROLE = { executor: '执行者', reviewer: '验收人（等它验收）', former: '曾经负责' };
/** A full date-time for text that leaves this page: a bare HH:MM is ambiguous once the package is in another conversation. */
const handoverStamp = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
};

/** A value a Hub record does not have is said as 未知, never filled in. */
const known = (value) => (value === null || value === undefined || value === '' ? '未知' : String(value));

/**
 * The editable text of GET /api/members/:id/handover. It carries only what the records have; the two fields the Hub
 * never records (the task's branch, the commands it ran) are named as 未知 with why. The user edits it before copying
 * or sending it: nothing here sends or rebinds anything.
 */
export function handoverText(pkg) {
  if (!pkg) return '';
  const lines = [
    `交接包 · ${pkg.member.name}（${pkg.member.harness}${pkg.member.model ? ` · ${pkg.member.model}` : ''}）· 集群 ${pkg.cluster.name}`,
    `生成时间：${handoverStamp(pkg.generatedAt)} · 内容只来自 Hub 记录，没有记录的写“未知”；可以改完再复制或发送。`,
    `工作目录：${known(pkg.member.cwd)}`,
    `对话 ID：${known(pkg.member.sessionId)}`,
    '', '## 一、集群目标（用户最近的要求）',
  ];
  if (pkg.requests.length) lines.push(...pkg.requests.map((r) => `- ${handoverStamp(r.at)}「${r.body || '（无正文）'}」`));
  else lines.push('- 未知（Hub 里没有这个群用户的发言记录）');
  lines.push('', '## 二、当前与最近的任务');
  if (!pkg.tasks.length) lines.push('- 未知（Hub 的任务记录里没有这个成员的任务）');
  for (const task of pkg.tasks) {
    const status = task.proposalState === 'proposed' ? '待批准' : HANDOVER_STATUS[task.status] ?? task.status;
    lines.push(`### ${task.title}（${status}）`);
    lines.push(`- 任务 ID：${task.id}`, `- 这个成员的角色：${HANDOVER_ROLE[task.role] ?? task.role}`, `- 最近更新：${handoverStamp(task.updatedAt)}`);
    lines.push('- 分支：未知（Hub 没有记录分支，只记录提交）');
    // The submission may be another member's: a reviewer's package needs it, a former executor must not claim it.
    const own = task.submissionBy === null || task.submissionBy === pkg.member.name;
    const whose = own ? '' : `执行者的提交，${task.submissionBy}`;
    lines.push(`- 提交：${known(task.commitSha)}${task.commitSha && !own ? `（${whose}）` : ''}`);
    if (task.mergedCommitSha) lines.push(`- 合并提交：${task.mergedCommitSha}`);
    if (task.summary) lines.push(`- 提交说明${own ? '' : `（${whose}）`}：${task.summary}`);
    lines.push(task.review
      ? `- 最近验收意见：${task.review.verdict === 'approve' ? '通过' : '退回'}${task.review.self ? '（自查）' : ''} · ${task.review.reviewer} · ${handoverStamp(task.review.at)}${task.review.reason ? `：${task.review.reason}` : ''}`
      : '- 最近验收意见：未知（这个任务还没有验收记录）');
    lines.push('- 实际跑过的命令：未知（Hub 的任务记录没有命令字段）');
    lines.push(task.questions.length ? '- 未解决的问题：' : '- 未解决的问题：无');
    for (const question of task.questions) lines.push(`  - ${question}`);
  }
  if (pkg.tasksOmitted > 0) lines.push(`- 另有 ${pkg.tasksOmitted} 个任务未显示（未结束的优先，其余按最近更新排序，最多 10 个）`);
  lines.push('', '## 三、最近的投递失败');
  if (!pkg.deliveries.length) lines.push('- 未知（没有失败或离线的投递记录）');
  for (const delivery of pkg.deliveries) {
    const look = deliveryView(delivery);
    lines.push(`- ${delivery.at ? handoverStamp(delivery.at) : '时间未知'} · ${look.label}${delivery.error ? ` · ${delivery.error}` : ''} · 消息「${delivery.message || '（无正文）'}」`);
  }
  return lines.join('\n');
}

const STAGE_LABEL = { queued: '入队', started: '开始投递', accepted: '桥或应用接受', acknowledged: '成员主动确认', ended: '结束' };
const STAGE_STATUS = { pending: '还没有', not_reached: '没有发生', unknown: '未知' };

/** One stage of a delivery's timeline. Unknown stays "未知": the page never fills in a time the Hub did not record. */
export function timelineStageView(stage) {
  if (stage.status !== 'reached') return { label: STAGE_LABEL[stage.key], value: STAGE_STATUS[stage.status] };
  return { label: STAGE_LABEL[stage.key], value: stage.at ? new Date(stage.at).toLocaleString('zh-CN') : '已发生，时间未知' };
}

const WAITING = '不用重发，会自动投递。';
const DIAGNOSIS = {
  paused_global: { stage: '排队中', reason: '全部投递已暂停，这条在队列里等着，还没有发出去。', next: '用左栏底部的开关恢复投递，恢复后会自动投递。' },
  paused_cluster: { stage: '排队中', reason: '本群已暂停投递，这条在队列里等着，还没有发出去。', next: '点页面上方的“恢复本群投递”，恢复后会自动投递。' },
  checking_online: { stage: '排队中', reason: 'Hub 正在确认这个成员是否在线。', next: '稍等。确认离线的话这条会标成离线，不会投递。' },
  hourly_limit: { stage: '排队中', reason: '防循环：这个对话这一小时的轮次已经用完，这条先留在队列里。', next: `额度恢复后再投。${WAITING}` },
  notice_limit: { stage: '排队中', reason: '防循环：这个对话这一小时能收的系统通知批次已经用完，这条先留在队列里。', next: `额度恢复后再投。${WAITING}` },
  busy: { stage: '排队中', reason: '这个成员正在处理上一轮，这条排在后面。', next: `上一轮结束后接着投。${WAITING}` },
  queued: { stage: '排队中', reason: '在队列里等待调度。', next: '稍等。' },
  running: { stage: '投递中', reason: '已经开始投递，还没有结果。', next: '等待结果，不用重发。' },
  offline: { stage: '离线，未投递', reason: '该投的时候成员离线，这条没有发出去，以后也不会自动补发。消息留在群聊记录里，对它算未读。', next: '成员上线后可以重发，也可以指定别的成员接手。' },
  chain_limit: { stage: '被防循环拦下', reason: '防循环：这条消息链的轮次已经到上限，这条没有投递。', next: '确实要继续的话，到设置里调高每条链的轮次上限后重发，或者发一条新消息。' },
  failed: { stage: '失败', reason: '投递失败，没有拿到成功的结果。', next: '看下面的原因。问题解决后可以重发，也可以指定别的成员接手。' },
  unknown: { stage: '结果未知', reason: 'Hub 不知道这条有没有送到：可能已经送达，甚至还在执行。', next: '先到应用里看这个对话，确认没有在执行，再重发或指定别的成员接手。' },
  superseded: { stage: '已被取代，未投递', reason: '尚未开始的旧提名已被新的提名取代，这不是投递失败。', next: '不用处理。' },
  accepted: { stage: '已接收', reason: '桥或应用已经接受这条投递。接受不代表这一轮做完了，也不代表模型看过。', next: '不用处理；要确认对方看到，看主动确认。' },
  completed: { stage: '轮次完成', reason: '这一轮已经结束。', next: '不用处理。' },
  done: { stage: '投递流程结束', reason: '投递流程结束，但没有记录接收结果（较早的记录）。', next: '不用处理。' },
};

/** What the receipt panel tells the user about a delivery's timeline: where it is, why, and what to do. */
export function deliveryAdvice(timeline) {
  const view = DIAGNOSIS[timeline.diagnosis];
  return timeline.handoffMessageId ? { ...view, next: '已经交接或重发，看新消息的回执。' } : view;
}

const RESEND_BLOCK = {
  offline: '成员现在不在线，不能重发。',
  removed: '成员已移出，不能重发，可以指定别的成员接手。',
  hidden: '成员隐身中，不会收到任何消息，不能重发；先取消隐身，或指定别的成员接手。',
  hop_limit: '这条消息链的跳数已到上限，不能重发。',
  chain_limit: '这条消息链的轮次已到上限，不能重发。',
};

export const resendBlockedText = (blockedBy) => RESEND_BLOCK[blockedBy];

// ---- cluster list and member bar: pure helpers (test/web-ui.test.ts) ----

/** When a cluster last had activity: its newest message, else its creation time. Missing/invalid dates sort last. */
const activityAt = (cluster) => {
  const t = Date.parse(cluster.lastMessageAt ?? cluster.createdAt);
  return Number.isFinite(t) ? t : 0;
};

/**
 * The sidebar's order: newest activity first. The incoming order is the Hub's creation order, and the sort is
 * stable, so clusters with equal times (e.g. all created in one test second) keep that order.
 */
export function clusterOrder(clusters) {
  return [...clusters].sort((a, b) => activityAt(b) - activityAt(a));
}

/**
 * `cluster` with lastMessageAt moved to a live message's `createdAt` when that is newer. Returns the same object
 * when nothing changes, so the page can skip a redraw; the REST snapshot stays authoritative on page load.
 */
export function withLastMessage(cluster, createdAt) {
  const next = Date.parse(createdAt);
  if (!Number.isFinite(next) || activityAt(cluster) >= next) return cluster;
  return { ...cluster, lastMessageAt: createdAt };
}

/** The member panel toggle's summary in the chat header: "3 个群员 · 2 在线", plus " · 1 隐身" when some are hidden. */
export function memberSummary(total, online, hidden = 0) {
  return `${total} 个群员 · ${online} 在线${hidden ? ` · ${hidden} 隐身` : ''}`;
}

// ---- hidden members (docs/cluster-members.md「隐身」): only the user and the coordinator see them ----

/** The words of the mark a hidden member carries wherever the page shows it; in a line of text, the words alone. */
export const HIDDEN_MARK = '隐身中';
/** The mark as a chip: the crossed-out eye and the words, never colour alone. `text`: other words, same icon. */
export const hiddenMark = (text = HIDDEN_MARK, cls = 'hidden-mark') => h('span', { class: cls }, icon('eye-off', 'ico-xs'), text);

/** Online members are counted without the hidden ones, which are counted on their own. */
export function memberCounts(members, statusOf) {
  const shown = members.filter((m) => !m.hiddenAt);
  return { total: members.length, online: shown.filter((m) => statusOf(m) !== 'offline').length, hidden: members.length - shown.length };
}

/** The workspace request for the tasks a member holds (the Hub's `holder` filter), one page at a time. */
export const heldTasksPath = (clusterId, memberId, cursor = null) => `/api/clusters/${encodeURIComponent(clusterId)}/workspace?holder=${encodeURIComponent(memberId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

/** Every page of a paged listing: `fetchPage(cursor)` returns { tasks, nextCursor }; follows the cursor to the end. */
export async function allPages(fetchPage) {
  const out = [];
  let cursor = null;
  do {
    const page = await fetchPage(cursor);
    out.push(...(page.tasks ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return out;
}

/** The open tasks a member holds: as executor (pending, working, review) and as reviewer (in review). */
export function heldTasks(tasks, memberId) {
  const open = tasks.filter((t) => t.proposalState !== 'proposed' || t.status === 'pending');
  return {
    executing: open.filter((t) => ['pending', 'working', 'review'].includes(t.status) && t.assignedMemberId === memberId),
    reviewing: open.filter((t) => t.status === 'review' && t.reviewer?.kind === 'member' && t.reviewer.memberId === memberId),
  };
}

const taskLine = (t) => `- ${t.number != null ? `#${t.number} ` : ''}${t.title}`;

/** The confirmation text for hiding (`hide` true) or showing a member, listing the tasks it holds. */
export function hiddenConfirmText(member, held, hide) {
  if (!hide) {
    return `取消 ${member.name} 的隐身？取消后它重新出现在其他成员的成员列表里，从这一刻起照常收消息；隐身期间的消息不会补发，也不算它的未读。`;
  }
  const lines = [`把 ${member.name} 设为隐身？`,
    '隐身期间它收不到任何消息（@、@all、任务通知都不投递，也不算未读），除你和协调员外其他成员看不到它；它调用 orrery 工具只会得到“已被设为隐身”的说明，什么也不执行。已经排队还没开始的投递会取消，正在进行的一轮不会被打断。取消隐身后从那一刻起恢复正常。'];
  if (held.executing.length || held.reviewing.length) {
    lines.push('', '它手上的任务保持不变（不会自动改派，需要时请你或协调员改派）：');
    if (held.executing.length) lines.push('执行：', ...held.executing.map(taskLine));
    if (held.reviewing.length) lines.push('验收：', ...held.reviewing.map(taskLine));
  } else {
    lines.push('', '它手上没有未完成的任务。');
  }
  return lines.join('\n');
}

/**
 * The composer's note when `text` @-mentions hidden members of the cluster: the message is still sent and kept in the
 * record, they just do not receive it. '' when none is mentioned. Same full-name rule as the Hub's @ (mentionAt).
 */
export function hiddenMentionHint(text, members) {
  const names = members.filter((m) => !m.removedAt).map((m) => m.name);
  const hidden = new Set(members.filter((m) => !m.removedAt && m.hiddenAt).map((m) => m.name));
  if (!hidden.size) return '';
  const hit = new Set();
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (i > 0 && /[A-Za-z0-9]/.test(text[i - 1])) continue;
    const name = mentionAt(text, i, names);
    if (name && hidden.has(name)) hit.add(name);
  }
  return hit.size ? `${[...hit].map((n) => `@${n}`).join('、')} 隐身中，不会收到（消息照常发出，留在群聊记录里）。` : '';
}

/** How many avatars the member panel toggle stacks; the rest are only counted in the summary. */
export const MEMBER_STACK = 5;

/** The avatars the member panel toggle draws, in member order. */
export const stackedMembers = (members) => members.slice(0, MEMBER_STACK);

/** localStorage key of whether the right-hand member panel is open (on its member list). Missing or unreadable: closed. */
export const PANEL_OPEN_KEY = 'orrery.panelOpen';

/** Only "1" is open; anything else (missing, "0", garbage) means the default: closed. */
export const expandedFromStored = (value) => value === '1';

// ---- sidebar groups (a cluster's `category`; PATCH /api/clusters/:id): pure helpers ----

/** Longest group name, in characters after trimming; the Hub (src/core/hub.ts MAX_CATEGORY) checks the same. */
export const MAX_CATEGORY = 40;
/** What the sidebar calls the clusters without a group. */
export const UNGROUPED = '未分组';

/** The group field's text → { category } (trimmed; '' = ungrouped) for PATCH /api/clusters/:id, or { error }. */
export function categoryInput(text) {
  const raw = String(text ?? '');
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(raw)) return { error: '分组名不能含换行或控制字符' };
  const category = raw.trim();
  if ([...category].length > MAX_CATEGORY) return { error: `分组名最多 ${MAX_CATEGORY} 个字` };
  return { category };
}

/**
 * The sidebar's groups: [{ name, clusters }]: first the Hub's group list `order` (settings.clusterGroups), in its
 * order and also when empty; then any other group a cluster names, in Chinese collation order (Han by pinyin, then
 * Latin A–Z); the ungrouped ('') last and only when it holds a cluster. Inside a group the clusterOrder (newest
 * activity first). A cluster from an old event has no category: ungrouped.
 */
export function clusterGroups(clusters, order = []) {
  const by = new Map();
  for (const c of clusterOrder(clusters)) {
    const name = (c.category ?? '').trim();
    if (!by.has(name)) by.set(name, []);
    by.get(name).push(c);
  }
  const listed = [...new Set(order.filter((name) => typeof name === 'string' && name))];
  const known = new Set(listed);
  const others = [...by.keys()].filter((name) => name && !known.has(name)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [...listed, ...others, ...(by.has('') ? [''] : [])].map((name) => ({ name, clusters: by.get(name) ?? [] }));
}

/** Exclusive sidebar sections; archived wins over pinned; the groups follow the Hub's group list `order`. */
export function sidebarSections(clusters, order = []) {
  const ordered = clusterOrder(clusters);
  return { pinned: ordered.filter((c) => c.pinnedAt && !c.archivedAt),
    groups: clusterGroups(ordered.filter((c) => !c.pinnedAt && !c.archivedAt), order),
    archived: ordered.filter((c) => c.archivedAt) };
}

/** The group list with `name` moved one place up (delta -1) or down (+1), for PUT /api/cluster-groups; null at an end. */
export function moveGroup(groups, name, delta) {
  const from = groups.indexOf(name);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= groups.length) return null;
  const next = [...groups];
  next.splice(from, 1);
  next.splice(to, 0, name);
  return next;
}

/** The "移到分组" menu of a cluster in `current` ('' = ungrouped): every group, then 未分组; the current one is marked. */
export function moveTargets(groups, current) {
  return [...groups.map((name) => ({ name, label: name })), { name: '', label: UNGROUPED }]
    .map((t) => ({ ...t, current: t.name === (current ?? '').trim() }));
}

/** An unknown saved position is not guessed while the event log is still being replayed. */
export function clusterUnread(messages, readId) {
  const index = readId == null ? -1 : messages.findIndex((message) => message.id === readId);
  if (readId != null && index < 0) return 0;
  return messages.slice(index + 1).filter((message) => message.from !== 'user').length;
}

export const unreadLabel = (count) => count > 99 ? '99+' : count > 0 ? String(count) : '';

/** Same Unicode length and character rules as Hub.checkClusterName. */
export function clusterNameInput(value) {
  if (typeof value !== 'string' || !value.trim() || /[\\/:*?"<>|\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    || value.trim().startsWith('.') || [...value.trim()].length > 60) return { error: '群名不能为空、不能以点开头，最多 60 个字符，且不能包含路径符号或控制字符。' };
  return { name: value.trim() };
}

/** localStorage key of the collapsed groups: a JSON array of group names ('' = ungrouped). */
export const COLLAPSED_GROUPS_KEY = 'orrery.collapsedGroups';

/** The stored collapsed groups as a Set; missing or garbage means none collapsed. */
export function collapsedFromStored(value) {
  try {
    const list = JSON.parse(value);
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * The collapsed groups as one string for the sidebar's redraw check. JSON, not a joined list: joined, the ungrouped
 * key '' alone would read the same as nothing collapsed and its collapse would never be drawn.
 */
export const collapsedSignature = (collapsed) => JSON.stringify([...collapsed].sort());

// ---- resizable panes (sidebar | chat | member panel): pure helpers ----

/** Each pane's width limits and default in CSS pixels, and where its width is remembered. */
export const PANES = {
  side: { key: 'orrery.width.side', min: 180, max: 480, def: 248 },
  panel: { key: 'orrery.width.panel', min: 280, max: 720, def: 360 },
};
/** The chat column keeps at least this much when a pane is widened. */
export const CHAT_MIN = 320;

/**
 * `px` for `pane`, kept within its min and max and so that `room` (the window width minus the other pane) still
 * leaves CHAT_MIN for the chat; the pane's min wins over that. Not a number: the default.
 */
export function clampPane(pane, px, room = Infinity) {
  const { min, max, def } = PANES[pane];
  const v = Number.isFinite(px) ? Math.round(px) : def;
  return Math.max(min, Math.min(max, room - CHAT_MIN, v));
}

/** A remembered width (a localStorage string) → the width to use; missing or garbage: the default. */
export function paneFromStored(pane, value) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return clampPane(pane, Number.isFinite(n) ? n : PANES[pane].def);
}

/**
 * The width a key on a pane's divider asks for (clamp it), or null for other keys. The divider moves with the arrow:
 * → widens the sidebar and narrows the member panel. Shift takes bigger steps; Home / End go to the min / max.
 */
export function paneKey(pane, width, key, shift = false) {
  const step = shift ? 64 : 16;
  if (key === 'ArrowRight') return pane === 'side' ? width + step : width - step;
  if (key === 'ArrowLeft') return pane === 'side' ? width - step : width + step;
  if (key === 'Home') return PANES[pane].min;
  if (key === 'End') return PANES[pane].max;
  return null;
}

// ---- auto-growing composers: pure helper ----

/** Lines a composer grows to before it scrolls (unless 40% of the window is less). */
export const COMPOSER_LINES = 12;

/**
 * A composer textarea's height: its content's (`content`, border box), at least `min` (its rows), at most the smaller
 * of COMPOSER_LINES lines (`lineHeight` each, plus `chrome`: padding and borders) and 40% of `viewport`; `scroll` when
 * the content is taller than that.
 */
export function autogrowHeight({ content, min, lineHeight, chrome, viewport }) {
  const cap = Math.max(min, Math.min(Math.round(lineHeight * COMPOSER_LINES + chrome), Math.floor(viewport * 0.4)));
  return { height: Math.max(min, Math.min(content, cap)), scroll: content > cap };
}

/**
 * A missing removal field is a legacy active event; removal itself is monotonic for a member id. A missing `hiddenAt`
 * (events from before schema v28) means not hidden: the page keeps the Hub's one shape, null when not hidden.
 */
export function mergeMember(previous, incoming) {
  if (previous?.removedAt && !incoming.removedAt) return previous;
  return { ...incoming, removedAt: incoming.removedAt ?? null, hiddenAt: incoming.hiddenAt ?? null };
}

/**
 * mergeMember, plus whose status wins. `at` orders the sources: a member event's seq, or an /api/state snapshot's
 * seq + 0.5 (taken after that event, before the next). The newer status wins, so replaying events older than the
 * snapshot cannot bring back an online state the Hub no longer has (e.g. after a restart). A tie wins too: an event
 * (whole seq) never ties a snapshot (half seq) and is applied once, so a tie is a later snapshot at the same seq, e.g.
 * after a Hub restart with no new events; only the latest sync is applied, so it is the newer one. Without `at`
 * (an API reply) the status already held stays.
 */
export function mergeMemberAt(previous, incoming, at) {
  const m = mergeMember(previous, incoming);
  if (previous && !(at >= (previous.statusAt ?? -1))) return { ...m, status: previous.status, statusAt: previous.statusAt };
  return { ...m, statusAt: at };
}

export const activeMembers = (members, clusterId) => members.filter((m) => m.clusterId === clusterId && !m.removedAt);
/** The member, if it is still in that cluster; a removed member cannot be edited. */
export const activeMember = (members, clusterId, id) => activeMembers(members, clusterId).find((m) => m.id === id) ?? null;

/** The Hub's channel status for a member; native siblings can share a busy channel. */
export function memberStatus(member, harnessAvailable, running) {
  if (member.removedAt || !harnessAvailable) return 'offline';
  if (running || member.status === 'busy') return 'busy';
  return member.status === 'offline' ? 'offline' : 'idle';
}

export function memberStatusLabel(member, status) {
  if (status === 'busy') return '投递通道占用';
  return status === 'offline' ? '离线' : '空闲';
}

/** What avatarEl's orbit shows for a member status (memberStatus: 'idle', 'busy' or 'offline'). */
export const memberPresence = (member, status) => ({ state: status, label: memberStatusLabel(member, status) });

/** Active memberships grouped by physical conversation, without treating a group alias as an application title. */
export function conversations(members, clusters) {
  const byCluster = new Map(clusters.map((c) => [c.id, c]));
  const grouped = new Map();
  for (const m of members) {
    if (m.removedAt) continue;
    const sessionId = m.workerSessionId || null;
    const key = JSON.stringify([m.harness, sessionId, sessionId ? null : m.id]);
    if (!grouped.has(key)) grouped.set(key, { harness: m.harness, mode: 'native', sessionId, memberships: [] });
    grouped.get(key).memberships.push({ clusterId: m.clusterId, clusterName: byCluster.get(m.clusterId)?.name ?? '(未知集群)', memberId: m.id, memberName: m.name });
  }
  return [...grouped.values()].sort((a, b) => a.harness.localeCompare(b.harness) || (a.sessionId ?? '').localeCompare(b.sessionId ?? ''));
}

/** Pick one membership's most recent observation for a shared physical conversation, without copying its data. */
export function conversationActivity(memberships, activity) {
  let picked = null;
  let newest = -Infinity;
  for (const membership of memberships) {
    const snapshot = activity.get(membership.memberId);
    const time = Math.max(Date.parse(snapshot?.lastSeenAt) || 0, Date.parse(snapshot?.lastActivityAt) || 0);
    if (snapshot && time > 0 && time > newest) {
      newest = time;
      picked = { membership, snapshot };
    }
  }
  return picked;
}

/** Only facts reported by the observer; neither a tool return nor a quiet channel implies task completion. */
export function activitySummary(snapshot, failed = false, now = Date.now()) {
  const seen = snapshot?.lastSeenAt && Number.isFinite(Date.parse(snapshot.lastSeenAt)) ? snapshot.lastSeenAt : null;
  const at = snapshot?.lastActivityAt && Number.isFinite(Date.parse(snapshot.lastActivityAt)) ? snapshot.lastActivityAt : null;
  const labels = { unknown: '暂无观察', observing: '观察中', stale: '观察已过期', disconnected: '观察已断开' };
  let state = labels[snapshot?.state] ?? labels.unknown;
  if (snapshot?.state === 'unknown' && (seen || at)) state = '仅历史';
  if (snapshot?.state === 'observing' && (!seen || now - Date.parse(seen) > (snapshot.staleAfterMs || 45_000))) state = labels.stale;
  if (failed) state = seen ? '观察查询暂不可用' : '暂无观察 · 查询暂不可用';
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '未知';
  const event = snapshot?.event;
  const phases = event?.kind === 'tool'
    ? { requested: '工具请求', started: '工具开始/分派', finished: '工具返回', failed: '工具失败' }
    : event?.kind === 'turn' ? { started: '轮次开始', finished: '轮次结束', failed: '轮次失败' } : {};
  const label = phases[event?.phase];
  const toolName = event?.kind === 'tool' && typeof event.toolName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(event.toolName)
    ? ` ${event.toolName}` : '';
  const source = typeof snapshot?.source === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(snapshot.source) ? snapshot.source : null;
  return {
    state,
    source,
    seen: seen ? fmt(seen) : null,
    activity: at ? `${fmt(at)}${label ? ` · ${label}${toolName}` : ''}` : null,
  };
}

/** An existing session is unavailable only when it already belongs to the target cluster. */
export function sessionAvailability(session, clusterId) {
  const memberships = Array.isArray(session.memberships) ? session.memberships : null;
  if (!memberships) return { disabled: false, reason: '', memberships: [] };
  const inCluster = clusterId && memberships.some((m) => m.clusterId === clusterId);
  return { disabled: Boolean(inCluster), reason: inCluster ? '已在当前群' : '', memberships };
}

/** What the user should read before moving `member` to the listed conversation `session` (the dialog of docs/cluster-members.md). */
export function rebindWarnings(member, session, { busy = false } = {}) {
  const path = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const others = (session.memberships ?? []).filter((m) => m.clusterId !== member.clusterId);
  return [
    others.length ? `这个对话已在其他群：${others.map((m) => `${m.clusterName}（群内名：${m.memberName}）`).join('、')}。换过去后它同时在这些群里。` : null,
    session.online === false ? '这个对话现在离线：排队给这个成员的消息会记为离线、不会重发，换对话的通知也一样；消息留在未读里，它上线后自己读。orrery 不会替你打开应用。' : null,
    path(member.cwd) !== path(session.cwd) ? `工作目录和原对话不同：原来是 ${member.cwd}，换过去是 ${session.cwd}。原目录里的改动不会跟过去。` : null,
    busy ? '这个成员现在有投递在途：结果会记为未知，那些消息保持未读。' : null,
  ].filter(Boolean);
}

/**
 * The name/avatar editor's values (member page and manage dialog) as the PATCH /api/members/:id body: only what
 * changed. An uploaded image wins over an emoji, which wins over a picked preset; the editor keeps the emoji field and
 * the preset choice mutually exclusive anyway. `preset` is a name from GET /api/avatars or null.
 * `readDataUrl(file)` resolves to the file as a data URL (FileReader in the page). Returns { fields } or { error }.
 */
export async function editFields(member, { name, emoji, file, preset = null }, readDataUrl) {
  const fields = {};
  name = name.trim();
  emoji = emoji.trim();
  if (name !== member.name) fields.name = name;
  if (file) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return { error: '只支持 PNG、JPEG、GIF、WebP 图片' };
    const url = await readDataUrl(file);
    if (url.length > MAX_AVATAR) return { error: `图片太大：转换后 ${Math.ceil(url.length / 1024)} KB，上限 256 KB` };
    if (!DATA_URL_RE.test(url)) return { error: '图片格式无法识别' };
    fields.avatar = url;
  } else if (emoji && emoji !== member.avatar) {
    fields.avatar = emoji;
  } else if (preset) {
    const ref = `preset:${preset}`;
    if (ref !== member.avatar) fields.avatar = ref;
  }
  return { fields };
}

/** Shared create/add submission keeps the member spec construction identical in both dialog modes. */
export function memberSubmission(clusterId, name, members) {
  return clusterId
    ? { path: `/api/clusters/${encodeURIComponent(clusterId)}/members`, body: { members } }
    : { path: '/api/clusters', body: { name, members } };
}

/**
 * The create / add-member dialog's whole submission: `choices` are the ticked apps' harnessSpecs inputs, in list
 * order. → `{ request }` (memberSubmission), or `{ error, harness }` for the first app whose choice is incomplete
 * (the page shows that app), or `{ error }` when nothing is ticked.
 */
export function createRequest(clusterId, name, choices) {
  const specs = [];
  for (const c of choices) {
    const r = harnessSpecs(c);
    if (r.error) return { error: r.error, harness: c.harness };
    specs.push(...r.specs);
  }
  if (!specs.length) return { error: '至少勾选一个 harness' };
  return { request: memberSubmission(clusterId, name, specs) };
}

/**
 * One app row of the create dialog's list: `{ text, problem }`, readable without opening the app. `c` is the app's
 * harnessSpecs input with `sessions` only counted, plus `checked`, `loadFailed` (its project or conversation list
 * did not load) and `memberProblem` (a picked entry has a memberNameProblem). Only a ticked app can have a problem:
 * an unticked one is not submitted.
 */
export function appRowSummary(c) {
  const picked = c.sessions.length;
  if (!c.checked) return { text: picked ? `未勾选 · 已选 ${picked} 个对话` : '未勾选', problem: null };
  if (c.loadFailed) return { text: '', problem: '列表加载失败' };
  const r = harnessSpecs(c);
  if (r.error) return { text: '', problem: c.create ? r.error : '还没选对话' };
  const what = [picked && `选了 ${picked} 个对话`, c.create && '新建 1 个对话'].filter(Boolean).join('，');
  return { text: [what, `添加 ${r.specs.length} 个成员`].filter(Boolean).join(' · '), problem: c.memberProblem ? '成员名字有问题' : null };
}

/**
 * What is wrong with the name a picked entry of the create dialog will send, or null. '' is fine (the Hub names the
 * member). Invalid: the Hub's member-name rule (src/core/hub.ts checkName) rejects the whole submission. Duplicate:
 * the cluster has it (`taken`) or another picked entry of the same app sends it (`others`); the Hub then adds -2.
 */
export function memberNameProblem(name, taken = new Set(), others = []) {
  if (!name) return null;
  if (!/^[\p{L}\p{N}_.-]+$/u.test(name) || RESERVED_NAMES.has(name)) return '名字无效';
  return taken.has(name) || others.includes(name) ? '重名（会自动加 -2）' : null;
}

/**
 * The row the dialog shows after a row's tick box changes, in the app list and in an app's conversation list alike:
 * ticking shows the ticked row, unticking leaves the shown row where it is (what was filled in stays, the row is just
 * not submitted).
 */
export const focusAfterTick = (focused, harness, checked) => (checked ? harness : focused);

/** Index of the row an arrow / Home / End key moves to in a list of `count` rows (no wrap), or null for other keys. */
export function rowAfterKey(index, count, key) {
  const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: count - 1 }[key];
  return next === undefined ? null : Math.max(0, Math.min(count - 1, next));
}

// ---- limit settings: hop limit, per-chain turn limit (docs/hop-limit.md): pure helpers ----

/** Shown in a confirm dialog before a setting is saved as unlimited; cancelling sends nothing. */
export const UNLIMITED_WARNING = {
  maxHops: '无限仅取消消息链跳数限制，可能增加代理自动往返、运行时间和模型用量。每条链轮次上限按它自己的设置生效，每小时轮次上限和暂停始终有效。',
  maxTurnsPerChain: '设为无限后，代理之间可以一直互相 @ 下去，直到每小时轮次上限或暂停开关让它们停下（跳数上限是有限值时，也会在那里停下），运行时间和模型用量可能明显增加。',
};

// name: shown in the sidebar; env: the start-up variable; sourceKey: where GET /api/settings puts the source.
const LIMITS = {
  maxHops: { name: '跳数上限', env: 'ORRERY_MAX_HOPS', sourceKey: 'source' },
  maxTurnsPerChain: { name: '每条链轮次上限', env: 'ORRERY_MAX_TURNS_PER_CHAIN', sourceKey: 'maxTurnsPerChainSource' },
};

const sourceText = (env, source) =>
  ({ saved: `已在网页上保存；${env} 不再起作用`, startup: `来自 ${env}，保存后以这里为准`, default: '默认值' })[source] ?? '';

/** What the sidebar shows for one setting (`maxHops` or `maxTurnsPerChain`) of GET /api/settings; null while unknown. */
export function limitView(setting, settings) {
  const limit = settings?.[setting];
  if (!limit) return null;
  const { name, env, sourceKey } = LIMITS[setting];
  const unlimited = limit.kind === 'unlimited';
  return { label: `${name}：${unlimited ? '无限' : limit.value}`, unlimited, source: sourceText(env, settings[sourceKey]) };
}

/**
 * Whether one setting's form ({ unlimited, value: the input's text }) holds an edit the Hub does not have. The form
 * keeps its values when the settings dialog is closed, so a reload would lose such an edit (review reload r1, P1).
 */
export function limitFormEdited(setting, settings, { unlimited, value }) {
  const limit = settings?.[setting];
  if (!limit) return false;
  if (limit.kind === 'unlimited') return !unlimited;
  return unlimited || value.trim() !== String(limit.value);
}

/**
 * The PATCH /api/settings body for one setting's form ({ unlimited, value: the input's text }), or { error }.
 * An unlimited body comes with `confirm`: the confirmDialog options (the warning) to accept first.
 */
export function limitSubmission(setting, { unlimited, value }) {
  const { name } = LIMITS[setting];
  if (unlimited) {
    return {
      body: { [setting]: { kind: 'unlimited' }, confirmUnlimited: true },
      confirm: { title: `把${name}设为无限？`, message: UNLIMITED_WARNING[setting], confirmText: '设为无限', danger: true },
    };
  }
  const v = value.trim();
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return { error: `${name}要填非负整数，或勾选"无限"` };
  return { body: { [setting]: { kind: 'finite', value: Number(v) } } };
}


// ---- coordinator notification settings (docs/collaboration.md): stalled-member threshold ----

const NOTIFIES = {
  stalledMemberMinutes: { name: '成员无活动提醒阈值', unit: '分钟', defaultValue: 30,
    sourceKey: 'stalledMemberMinutesSource' },
};

/** What the settings dialog shows for one notification setting; null while unknown. */
export function notifyView(setting, settings) {
  const value = settings?.[setting];
  if (typeof value !== 'number') return null;
  const { name, unit, defaultValue, sourceKey } = NOTIFIES[setting];
  const source = ({ saved: '已在网页上保存', default: `默认值（${defaultValue} ${unit}）` })[settings[sourceKey]] ?? '';
  return { label: `${name}：${value} ${unit}`, value, source };
}

/** The PATCH /api/settings body for one notification setting's value, or { error }. */
export function notifySubmission(setting, value) {
  const { name, unit } = NOTIFIES[setting];
  const v = String(value ?? '').trim();
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return { error: `${name}要填非负整数（${unit}）` };
  return { body: { [setting]: Number(v) } };
}

/** Whether the form holds an edit the Hub does not have (the settings dialog keeps form values when closed). */
export function notifyFormEdited(setting, settings, value) {
  const current = settings?.[setting];
  if (typeof current !== 'number') return false;
  return String(value ?? '').trim() !== String(current);
}

// ---- files and skills (docs/files.md): pure helpers ----

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 10;

/** 1536 → "1.5 KB"; matches the Hub's fmtSize, so the page and the envelope say the same size. */
export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The Hub shows a file inline only for these (from its magic bytes; docs/files.md). */
export const isImage = (mime) => /^image\/(png|jpeg|gif|webp)$/.test(mime ?? '');

export const fileUrl = (id, download = false) => `/api/files/${encodeURIComponent(id)}${download ? '?download=1' : ''}`;

/** "name（1.5 KB）", or just the name of a file known only by its id. */
export const fileLabel = (f) => (f.size == null ? f.name : `${f.name}（${fmtSize(f.size)}）`);

/** One pending attachment row; its owner keeps the upload state and remove/lock behavior. */
export function pendingFileNode(file, remove, preview = null, disabled = false) {
  // `preview`: a node (an image's thumbnail, another icon) shown once the file is uploaded; the clip by default.
  const mark = file.state === 'uploading' ? icon('clock', 'ico-sm') : file.state === 'error' ? icon('alert', 'ico-sm') : preview ?? icon('clip', 'ico-sm');
  return h('li', { class: `pending-file ${file.state}`, title: file.error ?? fileLabel(file) },
    mark,
    h('span', { class: 'file-name' }, file.name),
    h('span', { class: 'muted' }, file.state === 'uploading' ? '上传中…' : file.state === 'error' ? `上传失败：${file.error}` : fmtSize(file.size)),
    h('button', { type: 'button', class: 'icon', 'aria-label': `移除 ${file.name}`, disabled, onclick: remove }, icon('close', 'ico-sm')));
}

/**
 * One attachment: an image thumbnail that calls openViewer, anything else a download chip. A file without metadata (`mime`
 * undefined, a bare evidence file id) is tried as an image: the Hub serves inline only what its magic bytes prove, so anything
 * else fails to load and stays a download. File names reach text nodes and attribute values only.
 */
export function attachmentNode(f, openViewer) {
  const chip = () => h('a', { class: 'file-chip', href: fileUrl(f.id, true), download: f.name, title: `下载 ${fileLabel(f)}` },
    icon('file', 'ico-sm'), h('span', { class: 'file-name' }, f.name), f.size == null ? null : h('span', { class: 'muted' }, fmtSize(f.size)));
  if (f.mime !== undefined && !isImage(f.mime)) return chip();
  const missing = () => h('span', { class: 'thumb-missing', title: `${f.name} 加载失败` }, '图片加载失败');
  const thumb = h('button', { type: 'button', class: 'thumb', title: `${fileLabel(f)}，点击查看`, onclick: () => openViewer(f) },
    h('img', { src: fileUrl(f.id), alt: f.name, loading: 'lazy', onerror: () => thumb.replaceWith(f.mime === undefined ? chip() : missing()) }));
  return thumb;
}

/**
 * Which of `incoming` ([{ name, size }]) may join the `pending` files of one message (or `owner`): each at most 20 MB,
 * at most 10 in all. Returns { accepted, errors } with one Chinese line per refusal, shown in the page.
 */
export function pickFiles(pending, incoming, owner = '一条消息') {
  const accepted = [];
  const errors = [];
  for (const f of incoming) {
    if (f.size > MAX_FILE_BYTES) errors.push(`「${f.name}」有 ${fmtSize(f.size)}，超过单个文件 20 MB 的上限`);
    else if (pending + accepted.length >= MAX_FILES) {
      errors.push(`${owner}最多带 ${MAX_FILES} 个文件，「${f.name}」没有加上`);
    } else accepted.push(f);
  }
  return { accepted, errors };
}

/**
 * Notices kept per composer target ('c:<cluster>', 'm:<member>'), like drafts: each target shows only its own, and
 * clearing one (e.g. when its send completes) never touches another's. `text(target)` is '' when it has none.
 */
export function noticeBoard() {
  const byTarget = new Map();
  return {
    set(target, lines) {
      if (lines.length) byTarget.set(target, [...lines]);
      else byTarget.delete(target);
    },
    clear(target) { byTarget.delete(target); },
    text(target) { return (byTarget.get(target) ?? []).join('\n'); },
  };
}

/** A name for a pasted image (the clipboard calls them all "image.png"): 粘贴的图片-YYYYMMDD-HHMMSS.<ext>. */
export function pasteName(type, date) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type] ?? 'png';
  const p = (n) => String(n).padStart(2, '0');
  return `粘贴的图片-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${ext}`;
}

/** The files a paste attaches, each clipboard image with a usable name in `as`; null for a paste that also carries text. */
export function pastedFiles(data, now) {
  if (!data?.files.length || data.types.includes('text/plain')) return null;
  return [...data.files].map((f) => {
    if (f.type.startsWith('image/') && (!f.name || /^image\.\w+$/i.test(f.name))) f.as = pasteName(f.type, now);
    return f;
  });
}

// The Hub's @-name rule (core/hub.ts nameEnds and mentionAt), copied because the page cannot import the Hub's
// TypeScript; test/mention-rule.test.ts runs one table of examples through both copies and requires the same results.
const NAME_GOES_ON = /[._-]*[\p{L}\p{N}\p{M}]/uy;

/**
 * Whether an @-name that stops at `end` really ends there: at the end of the text, or before anything but a letter,
 * digit or combining mark of any script, where a run of `.` `-` `_` followed by a letter or digit continues the name.
 */
export function nameEnds(text, end) {
  NAME_GOES_ON.lastIndex = end;
  return !NAME_GOES_ON.test(text);
}

/** The name of `names` the `@` at index `at` mentions, or null: full names only, the longest when several end there. */
export function mentionAt(text, at, names) {
  let hit = null;
  for (const name of names) {
    if (name && text.startsWith(name, at + 1) && nameEnds(text, at + 1 + name.length) && (hit === null || name.length > hit.length)) hit = name;
  }
  return hit;
}

/**
 * A message body split for display: plain strings, { skill, text } for each known skill reference (`$name`),
 * { mention, text } for each delivered mention (`@name` or `@all`), and { task, text } for each `#<task id>` that
 * `tasks(id, offset)` resolves to a task (null leaves it as plain text).
 *
 * Untrusted strings only ever become text nodes or attribute values — never HTML.
 */
export function bodySegments(text, { skills, mentions, members, tasks } = {}) {
  if (!text || typeof text !== 'string') return [];

  const skillSet = skills instanceof Set ? skills : (skills ? new Set(skills) : null);
  const mentionSet = mentions instanceof Set ? mentions : (mentions ? new Set(mentions) : null);

  const candidates = [];
  if (mentionSet !== null && mentionSet.size > 0) {
    if (members instanceof Map) {
      for (const id of mentionSet) {
        const m = members.get(id);
        if (m?.name) candidates.push({ id: m.id, name: m.name });
      }
    } else if (Array.isArray(members)) {
      for (const m of members) {
        if (m?.id && mentionSet.has(m.id) && m?.name) candidates.push({ id: m.id, name: m.name });
      }
    } else if (typeof members === 'function') {
      for (const id of mentionSet) {
        const m = members(id);
        if (m?.name) candidates.push({ id: m.id, name: m.name });
      }
    }
    candidates.push({ id: 'all', name: 'all' });
  }

  const tokens = [];

  if (candidates.length > 0) {
    const byName = new Map(candidates.map((c) => [c.name, c.id]));
    for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
      if (i > 0 && /[A-Za-z0-9]/.test(text[i - 1])) continue;
      const name = mentionAt(text, i, byName.keys());
      if (name !== null) {
        tokens.push({
          start: i,
          end: i + 1 + name.length,
          seg: { mention: byName.get(name), text: text.slice(i, i + 1 + name.length) },
        });
        i += name.length;
      }
    }
  }

  if (skillSet && skillSet.size > 0) {
    for (const m of text.matchAll(/(?<![A-Za-z0-9_$])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/g)) {
      let token = m[1];
      while (token && !skillSet.has(token) && /[.:-]$/.test(token)) token = token.slice(0, -1);
      if (!skillSet.has(token)) continue;
      tokens.push({
        start: m.index,
        end: m.index + 1 + token.length,
        seg: { skill: token, text: `$${token}` },
      });
    }
  }

  if (tasks && text.includes('#')) {
    for (const m of text.matchAll(TASK_REF)) {
      const task = tasks(m[1], m.index);
      if (task) tokens.push({ start: m.index, end: m.index + m[0].length, seg: { task, text: m[0] } });
    }
  }

  tokens.sort((a, b) => a.start - b.start);

  const out = [];
  let last = 0;
  for (const t of tokens) {
    if (t.start < last) continue;
    if (t.start > last) out.push(text.slice(last, t.start));
    out.push(t.seg);
    last = t.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The texts of a body where a written @ counts: code and block quotes are left out. */
const speechTexts = (blocks) => blocks.flatMap((b) => {
  if (b.type === 'p' || b.type === 'h') return [inlineText(b.inlines)];
  if (b.type === 'ul' || b.type === 'ol') return b.items.flatMap(speechTexts);
  if (b.type === 'table') return [...b.head, ...b.rows.flat()].map(inlineText);
  return [];
});

/**
 * Who to show above a message body: the ids in `mentions` its text does not @. `to` sends store recipients without
 * writing them into the body. A real @all already says who it is for, so it shows nobody, as do system and handoff
 * messages (see bodyNodes).
 */
export function unwrittenRecipients(msg, members, handoffs) {
  if (msg.from === 'system' || handoffs.has(msg.id) || !msg.mentions?.length) return [];
  const written = new Set();
  for (const text of speechTexts(markdownBlocks(msg.body))) {
    const quoted = quotedRanges(text);
    let at = 0;
    for (const seg of bodySegments(text, { mentions: msg.mentions, members })) {
      if (seg.mention && !inRanges(quoted, at)) written.add(seg.mention);
      at += (seg.text ?? seg).length;
    }
  }
  // shortcut: members carry no join time, so someone who joins later turns an old @all into a list of names; add a join time if that gets noisy.
  const others = [...members.values()].filter((m) => m.clusterId === msg.clusterId && m.id !== msg.from && !m.removedAt);
  if (written.has('all') && others.every((m) => msg.mentions.includes(m.id))) return [];
  return msg.mentions.filter((id) => !written.has(id));
}

// ---- quota and token counts (docs/usage.md). Self-contained: usageView(member, usage) renders one member's part ----

/** 950 → "950", 12_345 → "12.3K", 3_400_000 → "3.4M". */
export function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function usageAlertText(row) {
  const alert = row?.alert;
  if (!alert) return '';
  const fmt = (n) => n === null ? '未知' : fmtTokens(n);
  return `对话已很长（单轮 ${fmt(alert.turnTokens)} / 合计 ${fmt(alert.conversationTokens)}），建议在应用里开新对话或压缩。`;
}

/** Every token of a TokenTotals (output includes reasoning). */
export const tokenSum = (t) => t.input + t.cachedInput + t.cacheWrite + t.output;

/** "共 1.2M：输入 3.4K · 缓存读 1.1M · 缓存写 0 · 输出 12K（推理 2K）". */
export function tokenText(t) {
  const reasoning = t.reasoning ? `（推理 ${fmtTokens(t.reasoning)}）` : '';
  return `共 ${fmtTokens(tokenSum(t))}：输入 ${fmtTokens(t.input)} · 缓存读 ${fmtTokens(t.cachedInput)} · 缓存写 ${fmtTokens(t.cacheWrite)} · 输出 ${fmtTokens(t.output)}${reasoning}`;
}

/** When a window resets, said plainly: "已重置" once the time has passed, else "2 小时 5 分后重置" / "3 天后重置". */
export function resetText(resetsAt, now = Date.now()) {
  if (!resetsAt) return '';
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '已重置';
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins} 分后重置`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} 小时 ${mins % 60} 分后重置`;
  return `${Math.floor(hours / 24)} 天后重置`;
}

/** One harness's quota as lines: { label, percent (null when reset), note }, or one "暂不支持" / "还没有读到" line. */
export function quotaLines(quota, now = Date.now()) {
  if (!quota?.supported) return [{ label: '额度', percent: null, note: '暂不支持' }];
  const s = quota.snapshot;
  if (!s) return [{ label: '额度', percent: null, note: quota.error ? `读取失败：${quota.error}` : '还没有读到' }];
  return s.windows.map((w) => {
    const reset = resetText(w.resetsAt, now);
    // Past its reset the old percentage no longer holds: shown as reset, not as the stale number.
    return reset === '已重置' ? { label: w.label, percent: null, note: '已重置' } : { label: w.label, percent: Math.round(w.usedPercent), note: reset };
  });
}

/** "截至 14:05" (fmtTime) plus the source's last error, if any. */
export function quotaAsOf(quota, fmt = fmtTime) {
  if (!quota?.snapshot) return '';
  return `截至 ${fmt(quota.snapshot.observedAt)}${quota.error ? `（最近一次读取失败：${quota.error}）` : ''}`;
}

/** The cluster total next to the chat title: "token：经 orrery 1.2M · 对话合计 3.4M", or '' when nothing is known. */
export function clusterUsageText(usage) {
  if (!usage?.members?.length) return '';
  const via = usage.members.some((m) => m.viaOrrery) ? `经 orrery ${fmtTokens(tokenSum(usage.cluster.viaOrrery))}` : '';
  const conv = usage.members.some((m) => m.conversation) ? `对话合计 ${fmtTokens(tokenSum(usage.cluster.conversation))}` : '';
  return via || conv ? `token：${[via, conv].filter(Boolean).join(' · ')}` : '';
}

/** One harness's quota lines and "截至 …" (shared by usageView and quotaPanel). */
function quotaRows(quota, now) {
  const rows = quotaLines(quota, now).map((l) => h('div', { class: 'quota-line' },
    h('span', { class: 'quota-label' }, l.label),
    l.percent === null ? h('span', { class: 'muted quota-note' }, l.note)
      : [h('span', { class: 'quota-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': l.percent, title: `已用 ${l.percent}%` },
        h('span', { style: `width: ${Math.max(0, Math.min(100, l.percent))}%` })),
      h('span', { class: 'quota-pct' }, `已用 ${l.percent}%${l.note ? ` · ${l.note}` : ''}`)]));
  const asOf = quotaAsOf(quota);
  return asOf ? [...rows, h('p', { class: 'muted usage-note' }, asOf)] : rows;
}

const refreshButton = (onRefresh) => h('button', { type: 'button', class: 'small', onclick: onRefresh }, '刷新额度');

/** A member row's short token line: "经 orrery 47K（1 轮）· 对话 10M", or '' when nothing is known. */
export function memberTokensText(row) {
  if (!row) return '';
  const parts = [];
  if (row.viaOrrery) parts.push(`经 orrery ${fmtTokens(tokenSum(row.viaOrrery.totals))}（${row.viaOrrery.turns} 轮）`);
  if (row.conversation) parts.push(`对话 ${fmtTokens(tokenSum(row.conversation))}`);
  return parts.join(' · ');
}

// ---- a member row's model, project, conversation and quota (docs/cluster-members.md「群员列表」) ----

/** The last folder of a working directory ("D:\\work\\shop" → "shop"), or '' for none. */
export function projectName(cwd) {
  const parts = String(cwd ?? '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

const SESSION_STALE_MS = 10 * 60_000;   // older than the Hub's re-read interval: shown as "HH:MM 读到", not as now
const QUOTA_STALE_MS = 30 * 60_000;

/**
 * What a member row shows besides name and status, as { text, title, prefix? } (title: the hover text; prefix: when
 * an old value was read, put before it; the row marks each part with an icon, not a word): `model`,
 * `project`, `conversation`, and `quota` (plus `level`: 'ok' | 'warning' | 'exhausted' | 'unknown'; null until
 * GET /api/usage has answered). `row` is the member's GET /api/usage row, `quota` its harness's entry in `quotas`.
 * Nothing is guessed: unknown values say so, and a value read a while ago says when.
 */
export function memberDetails(member, row, quota, { usageLoaded = Boolean(row || quota), now = Date.now(), fmt = fmtTime } = {}) {
  const session = currentSession(member, row);
  const old = (at, ms) => Number.isFinite(Date.parse(at)) && now - Date.parse(at) > ms;
  let model;
  if (session?.model) {
    model = { text: old(session.observedAt, SESSION_STALE_MS) ? `${session.model}（${fmt(session.observedAt)} 读到）` : session.model,
      title: `模型：${session.model}，${fmt(session.observedAt)} 从应用的本机记录读到` };
  } else if (member.model) {
    model = { text: `${member.model}（加入时）`, title: `模型：${member.model}，是加入群或换对话时读到的；之后在应用里换了模型这里不会知道` };
  } else {
    model = { text: '模型未知', title: '应用没有给出这个对话的模型' };
  }
  const name = projectName(member.cwd);
  const project = name ? { text: name, title: `项目（工作目录）：${member.cwd}` } : { text: '项目未知', title: '没有记录工作目录' };
  let conversation;
  if (session?.title) {
    conversation = { text: session.title, prefix: old(session.observedAt, SESSION_STALE_MS) ? `（${fmt(session.observedAt)} 读到）` : undefined,
      title: `对话标题：${session.title}\n${fmt(session.observedAt)} 读到\n会话 ID：${member.workerSessionId}` };
  } else {
    conversation = { text: '对话标题未知',
      title: `这次 Hub 运行中还没读到这个对话的标题（加入、换对话或在添加成员里列出对话时会读到）\n会话 ID：${member.workerSessionId}` };
  }
  return { model, project, conversation, quota: usageLoaded ? quotaChip(member, quota, { now, fmt, old: (at) => old(at, QUOTA_STALE_MS) }) : null };
}

/**
 * The report's conversation info only when it was read for the member's current binding: after the member moved to
 * another conversation, a report (or a late answer) about the old one is not this member's any more. Else null.
 */
export function currentSession(member, row) {
  const s = row?.session;
  return s && s.sessionId === member.workerSessionId ? s : null;
}

/**
 * The compact quota of the member's app account: its most used window, marked as shared, the rest on hover. `text`
 * is the whole sentence (hover and screen readers); `short` is what the row shows beside a meter of `percent`: a normal
 * reading is just the number (the app is the row's icon, the words and the window are in the hover text); a nearly
 * used up or used up one says so in words, with its window.
 */
function quotaChip(member, quota, { now, fmt, old }) {
  const head = `${member.harness} 账号的额度，同一应用的群员共用`;
  const plain = (text, title, level = 'unknown') => ({ text, short: text, percent: null, title, level });
  if (!quota) return plain('额度未知', '只统计原生群员所在应用的额度');
  if (!quota.supported) return plain('额度不支持', `${member.harness} 没有可读的额度来源`);
  if (!quota.snapshot) return plain('额度未读到', quota.error ? `读取失败：${quota.error}` : '还没有读到');
  const lines = quotaLines(quota, now);
  const detail = [head, ...lines.map((l) => `${l.label}：${l.percent === null ? l.note : `已用 ${l.percent}%${l.note ? ` · ${l.note}` : ''}`}`), quotaAsOf(quota, fmt)].join('\n');
  const top = lines.filter((l) => l.percent !== null).sort((a, b) => b.percent - a.percent)[0];
  if (!top) return { ...plain(`${member.harness} 额度已重置`, detail, 'ok'), short: '额度已重置' };
  const level = top.percent >= 100 ? 'exhausted' : top.percent >= 90 ? 'warning' : 'ok';
  const word = level === 'exhausted' ? '已用完 ' : level === 'warning' ? '快用完 ' : '';
  const asOf = old(quota.snapshot.observedAt) ? `，截至 ${fmt(quota.snapshot.observedAt)}` : '';
  const short = level === 'ok' ? `${top.percent}%${asOf ? `（截至 ${fmt(quota.snapshot.observedAt)}）` : ''}` : `额度${word}${top.percent}%（${top.label}${asOf}）`;
  return { text: `${member.harness} 额度 ${word}${top.percent}%（${top.label}${asOf}）`, short, percent: top.percent, title: detail, level };
}

/**
 * The details under a member row's name, in two tiers (docs/cluster-members.md「群员列表的每一行」): the model, then
 * project and conversation; then a quiet usage line (the quota as a meter and a short number, the token counts) and,
 * only for a long conversation, its warning. Each part truncates on its own, its full text on hover. Model, project
 * and conversation are marked by an icon (the word stays for screen readers). `tokens` is memberTokensText, `alert`
 * usageAlertText ('' for none).
 */
export function memberDetailsView(d, { tokens = '', alert = '' } = {}) {
  const part = (cls, p, mark) => h('span', { class: `member-detail ${cls}`, title: p.title },
    mark ? [icon(mark[0]), h('span', { class: 'sr-only' }, mark[1])] : null, `${p.prefix ?? ''}${p.text}`);
  const q = d.quota;
  // The short form is shown; screen readers get the whole sentence once.
  const quota = q && h('span', { class: `member-detail member-quota quota-${q.level}`, title: q.title },
    q.percent === null ? null : h('span', { class: 'member-meter', 'aria-hidden': 'true' },
      h('span', { style: `width: ${Math.max(0, Math.min(100, q.percent))}%` })),
    q.short === q.text ? q.text : [h('span', { 'aria-hidden': 'true' }, q.short), h('span', { class: 'sr-only' }, q.text)]);
  return h('div', { class: 'member-details' },
    h('div', { class: 'member-line member-line-model' }, part('member-model', d.model, ['chip', '模型 '])),
    h('div', { class: 'member-line member-line-where' },
      part('member-project', d.project, ['project', '项目 ']), part('member-conversation', d.conversation, ['comment', '对话 '])),
    quota || tokens ? h('div', { class: 'member-line member-usage' }, quota,
      // The token parts break only between each other, never inside, and are never cut short.
      tokens ? h('span', { class: 'member-tokens', title: '不同模型的 token 不能直接比较' },
        tokens.split(' · ').flatMap((t, i) => [i ? ' · ' : null, h('span', { class: 'nowrap' }, t)])) : null) : null,
    alert ? h('p', { class: 'member-length-alert' }, icon('alert'), h('span', {}, alert)) : null);
}

/**
 * The confirmation before removing a member (confirmDialog options): what ends and what is kept, said for the
 * attached application conversation (docs/cluster-members.md「移出成员」).
 */
export function removeMemberConfirm(member) {
  const kept = '群聊和投递记录都会保留，历史里仍显示它的名字和头像。还在排队的投递会取消。';
  const message = `${kept}应用里的这个对话不会被删除或改动；它已经开始的一轮可能继续运行。以后可以把这个对话重新加进来，会成为一个新成员。`;
  return { title: `将“${member.name}”移出集群？`, message, confirmText: '移出集群', danger: true };
}

/** A member row's app name, for the app icon's tooltip and accessible name. */
export function memberAppText(appName) {
  return appName;
}

/**
 * The icon buttons of a member row, in order: { key, icon (index.html sprite id without "i-"), label (the tooltip),
 * name (the accessible name, which says whose row), danger? }. Changing the conversation is always available;
 * hide/show says which way it goes.
 */
export function memberRowActions(member) {
  const hidden = Boolean(member.hiddenAt);
  return [
    { key: 'edit', icon: 'pencil', label: '改名/头像' },
    { key: 'rebind', icon: 'swap', label: '换对话' },
    { key: 'hide', icon: hidden ? 'eye' : 'eye-off', label: hidden ? '取消隐身' : '设为隐身' },
    { key: 'remove', icon: 'user-minus', label: '移出集群', danger: true },
  ].map((a) => ({ ...a, name: `${a.label}：${member.name}` }));
}

/**
 * One member's quota (its harness's) and tokens, as a self-contained block. `usage` is GET /api/usage; `onRefresh`
 * (optional) adds a "刷新额度" button. Counts of different models are not comparable and are never shown as money.
 */
export function usageView(member, usage, { onRefresh = null, now = Date.now() } = {}) {
  const row = usage?.members?.find((m) => m.memberId === member.id) ?? null;
  const quota = usage?.quotas?.find((q) => q.harness === member.harness) ?? null;
  const box = h('section', { class: 'usage', 'aria-label': '额度与 token' });
  if (!usage) return box;
  box.append(h('div', { class: 'usage-head' }, h('span', {}, `${member.harness} 额度`),
    onRefresh && quota?.supported ? refreshButton(onRefresh) : null));
  box.append(...quotaRows(quota, now));
  const via = row?.viaOrrery ? `${tokenText(row.viaOrrery.totals)}（${row.viaOrrery.turns} 轮）` : '暂无记录';
  const conv = row?.conversation ? tokenText(row.conversation) : row?.conversationSupported ? '读不到' : '暂不支持';
  box.append(h('dl', { class: 'info usage-tokens' },
    h('dt', {}, '经 orrery'), h('dd', {}, via),
    h('dt', {}, '整个对话'), h('dd', {}, conv)));
  return box;
}

// ---- Hub restarts: new web code only loads with a reload (docs/desktop.md, README「网页」) ----

/**
 * What to do after a check of GET /api/health (on an SSE reconnect or when the page gets focus). `loadedPid` is the
 * Hub process the page was loaded from. 'none': the same Hub, or no answer to compare. 'reload': another Hub process
 * and nothing would be lost. 'banner': another Hub process, but a draft (`drafts`, the composer texts), an attachment
 * waiting to be sent (`uploads`) or open edits elsewhere (`editing`: a dialog, an edited form, a send in flight)
 * would be lost by a reload, so the user decides.
 */
export function hubRestartAction(loadedPid, health, unsaved = {}) {
  if (!Number.isInteger(loadedPid) || health?.app !== 'orrery' || !Number.isInteger(health.pid) || health.pid === loadedPid) return 'none';
  return reloadWouldLose(unsaved) ? 'banner' : 'reload';
}

/** True when a reload would lose something: a non-blank draft, an attachment waiting to be sent, open edits. */
export function reloadWouldLose({ drafts = [], uploads = 0, editing = false } = {}) {
  return drafts.some((d) => d.trim() !== '') || uploads > 0 || editing;
}
