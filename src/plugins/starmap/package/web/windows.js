// The star map's chat windows (docs/starmap.md「聊天窗口」): a window manager over the scene and two kinds of windows,
// a simplified Hub chat of a cluster and a read-only view of a member's native conversation as the Hub reads it.
// Everything from the Hub (message bodies, transcript text, names) reaches the page through h() as text nodes and
// attribute values; Markdown goes through markdown.js, whose links are http(s) only. Nothing here loads an image or
// other URL from that content, and nothing is parsed as HTML (test/starmap-windows.test.ts checks the source).
import {
  avatarEl, confirmDialog, fmtTime, h, harnessApp, icon, isSystemMessage, markdownBlocks, messageAuthorName, plainTextRecord, systemAvatar,
  systemClass, userAvatar,
} from '/plugin-host/v1.js';
import { lt, onLanguageChange, t } from './words.js';
import {
  allCardsOpen, applyPage, applyPrivateDeliveryEvent, bindingChange, deliveryCaption, dmStatusOf, eventMessage, eventPrivateMessage,
  HUB_PAGE, hasOlder, isCard, isGoneError, isMemberActivity, isPrivateDeliveryEntry, MAX_CHAIN, mergeMessages,
  messagesPath, nextWant, oneLine, prependMessages, privateMessagesPath, readTarget, requestFor, toggleAllCards,
  transcriptEntries, transcriptPath, transcriptPrivateIds, transcriptState, wantOnActivity,
} from './transcript.js';

const enc = encodeURIComponent;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const MIN_W = 300, MIN_H = 240;
const READ_GAP_MS = 2000;   // at most one read position per window every two seconds, as the chat does
const ACTIVITY_DELAY_MS = 700;   // a burst of events for one member becomes one read

/** The key of a window target, or null for a malformed one. */
export function windowKey(target) {
  const id = (v) => typeof v === 'string' && v.length > 0;
  if (target?.kind === 'hub' && id(target.clusterId)) return `hub|${target.clusterId}`;
  if (target?.kind === 'member' && id(target.clusterId) && id(target.memberId)) return `member|${target.clusterId}|${target.memberId}`;
  if (target?.kind === 'panel' && id(target.panel?.key)) {
    if (target.panel.scope === 'cluster') return id(target.clusterId) ? `panel|${target.panel.key}|${target.clusterId}` : null;
    if (target.panel.scope === 'global') return `panel|${target.panel.key}|global`;
  }
  if (target?.kind === 'external-panel' && id(target.item?.pluginId) && id(target.clusterId)) {
    return `ext|${target.item.pluginId}|${target.clusterId}`;
  }
  return null;
}

/** The windows' stacking order, bottom to top; the top one is the focused window. */
export function windowStack() {
  let order = [];
  return {
    /** Puts `key` on top; true when it was not open before. */
    open(key) {
      const fresh = !order.includes(key);
      order = [...order.filter((k) => k !== key), key];
      return fresh;
    },
    /** Raises an open window; false when it is not open or already on top. */
    raise(key) {
      if (!order.includes(key) || order.at(-1) === key) return false;
      order = [...order.filter((k) => k !== key), key];
      return true;
    },
    /** Removes `key`; the window below becomes the top. */
    close(key) {
      const had = order.includes(key);
      order = order.filter((k) => k !== key);
      return had;
    },
    /** Removes every window and returns their keys, top first. */
    clear() {
      const keys = order.reverse();
      order = [];
      return keys;
    },
    top: () => order.at(-1) ?? null,
    keys: () => [...order],
    has: (key) => order.includes(key),
  };
}

// ---- Markdown as DOM: markdown.js gives a data structure, this turns it into elements and text nodes ----

function mdInlines(nodes) {
  return nodes.flatMap((n) => {
    if (typeof n === 'string') return n;
    if (n.type === 'code') return h('code', {}, n.text);
    // markdown.js only makes links whose address parsed as http: or https:.
    if (n.type === 'link') return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer', title: n.href }, mdInlines(n.children));
    return h(n.type, {}, mdInlines(n.children));   // strong, em, del
  });
}

function mdBlock(b) {
  switch (b.type) {
    case 'p': return h('p', {}, mdInlines(b.inlines));
    case 'h': return h('p', { class: 'smw-h' }, h('strong', {}, mdInlines(b.inlines)));
    case 'code': return h('pre', {}, h('code', {}, b.text));
    case 'hr': return h('hr');
    case 'quote': return h('blockquote', {}, b.blocks.map(mdBlock));
    case 'ul': case 'ol': return h(b.type, { start: b.start === 1 ? null : b.start }, b.items.map((item) => h('li', {}, item.map(mdBlock))));
    case 'table': return h('div', { class: 'smw-table' }, h('table', {},
      h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, mdInlines(c))))),
      h('tbody', {}, b.rows.map((row) => h('tr', {}, row.map((c) => h('td', {}, mdInlines(c))))))));
    default: return null;
  }
}

/** A body as Markdown, or as plain text (`plain`); a truncated one says so. */
function textBody(text, { plain = false, truncated = false } = {}) {
  const value = String(text ?? '');
  return h('div', { class: plain ? 'smw-md smw-plain' : 'smw-md' }, plain ? value : markdownBlocks(value).map(mdBlock),
    truncated ? h('p', { class: 'smw-note' }, t('（正文已截断）')) : null);
}

/** The stylesheet, once per document; the page's CSP allows same-origin stylesheets. */
const styled = new WeakSet();
function ensureStyles(doc) {
  if (!doc?.head || styled.has(doc)) return;
  styled.add(doc);
  const link = doc.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('data-starmap-windows', '');
  link.setAttribute('href', new URL('./windows.css', import.meta.url).href);
  doc.head.append(link);
}

function validBindingGen(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** Clusters and members by id (removed members too, for old messages), from GET /api/state and the event stream. */
function createDirectory(ctx, changed) {
  const clusters = new Map(), members = new Map();
  const clusterTick = new Map(), memberTick = new Map();
  let loading = null, loaded = false, tick = 0, appliedSnapshotTick = 0;

  function setMember(m, sourceTick, fromSnapshot) {
    if (!m?.id) return false;
    if (fromSnapshot && (memberTick.get(m.id) ?? 0) > sourceTick) return false;
    const prev = members.get(m.id);
    const prevGen = validBindingGen(prev?.bindingGen);
    const nextGen = validBindingGen(m.bindingGen);
    // Never let a late snapshot or out-of-order record regress a member's binding generation.
    if (prevGen !== null && (nextGen === null ? fromSnapshot : nextGen < prevGen)) return false;
    const next = nextGen === null && prevGen !== null ? { ...m, bindingGen: prevGen } : m;
    const renamed = prev?.name !== next.name;
    members.set(m.id, next);
    if (!fromSnapshot) memberTick.set(m.id, sourceTick);
    return renamed;
  }

  function fetchState() {
    const startedAt = ++tick;
    const p = ctx.api('GET', '/api/state?includeRemoved=true').then((state) => {
      if (startedAt < appliedSnapshotTick) return true;
      appliedSnapshotTick = startedAt;
      for (const c of state?.clusters ?? []) {
        if (!c?.id || (clusterTick.get(c.id) ?? 0) > startedAt) continue;
        clusters.set(c.id, c);
      }
      for (const m of state?.members ?? []) setMember(m, startedAt, true);
      loaded = true;
      changed(null, true);
      return true;
    }, () => false).finally(() => {
      if (loading === p) {
        loading = null;
        if (!loaded) changed(null, false);
      }
    });
    loading = p;
    return p;
  }

  return {
    clusters, members,
    get loaded() { return loaded; },
    get loading() { return Boolean(loading); },
    load() {
      if (loaded) return Promise.resolve(true);
      if (loading) return loading;
      return fetchState();
    },
    refresh() {
      return fetchState();
    },
    apply(event) {
      const p = event?.payload ?? {};
      if (event?.kind === 'cluster' && p.cluster?.id) {
        const eventTick = ++tick;
        clusters.set(p.cluster.id, p.cluster);
        clusterTick.set(p.cluster.id, eventTick);
        let renamed = false;
        for (const m of p.members ?? []) {
          if (setMember(m, eventTick, false)) renamed = true;
        }
        changed(p.cluster.id, renamed);
      } else if (event?.kind === 'member' && p.member?.id) {
        const eventTick = ++tick;
        const renamed = setMember(p.member, eventTick, false);
        changed(p.member.clusterId, renamed);
      }
    },
  };
}

/**
 * The windows over the star map: `root` is the scene's container (positioned), `ctx` the view context
 * (plugin-view.js). `open(target)` opens a window or raises the one already open for that target; `closeAll()` closes
 * them, drops reads still in flight (their answers are ignored) and the event listener. `setSatellites(clusterId, ids)`
 * lets the scene mark which system notices of a cluster still circle as satellites (the tag on their lines).
 * `askClose(options)`: the page's confirm dialog (resolves true or false), asked before a window's close button drops a
 * draft. Leaving the whole view (its back button, Esc, ctx.openChat) is guarded by the view host (plugin-view.js).
 */
export function createWindows({ root, ctx, askClose = confirmDialog, getTheme = () => ({ id: 'luna', scheme: 'dark', tokens: {} }),
  onOpenCluster = null, onOpenMember = null, onRaise = null, onChange = null }) {
  const doc = root.ownerDocument ?? globalThis.document;
  ensureStyles(doc);
  const layer = h('div', { class: 'smw-layer' });
  root.append(layer);
  const stack = windowStack();
  const wins = new Map();   // key -> window
  const satellites = new Map();   // clusterId -> Set of message ids
  const themeListeners = new Set();
  let closed = false;
  // `names`: what a window shows of names changed (the first load, a rename), so its messages are drawn again; else only its title.
  const directory = createDirectory(ctx, (clusterId, names) => {
    for (const w of wins.values()) if (!clusterId || w.clusterId === clusterId) w.names(names);
  });
  const unsubscribe = ctx.onEvent((event) => {
    if (closed) return;
    directory.apply(event);
    for (const w of [...wins.values()]) w.event(event);
  });
  const unsubLang = onLanguageChange(() => {
    if (closed) return;
    for (const w of [...wins.values()]) {
      if (w.relabel) w.relabel();
      else w.names(true);
    }
  });

  function layout() {
    const top = stack.top();
    stack.keys().forEach((key, index) => {
      const w = wins.get(key);
      w.el.style.zIndex = String(10 + index);
      w.el.classList.toggle('smw-active', key === top);
    });
    wins.get(top)?.focused();
  }

  function size() { return { W: num(layer.clientWidth, 1200) || 1200, H: num(layer.clientHeight, 800) || 800 }; }

  /** Where a new window goes: Hub chats right, member conversations left, plugin panels centered with stagger. */
  function place(kind, defaultSize = null) {
    const { W, H } = size();
    // Leave clear room below the top HUD (wraps onto two rows at <= 900px) and above the bottom Dock.
    const topSafe = W <= 900 ? 100 : 56;
    const bottomSafe = 66;
    const availH = Math.max(MIN_H, H - topSafe - bottomSafe);
    const step = ([...wins.values()].filter((w) => w.kind === kind).length % 5) * 28;
    if (kind === 'panel' || kind === 'external-panel') {
      const wantW = defaultSize?.w ?? 560;
      const wantH = defaultSize?.h ?? 480;
      const width = Math.min(clamp(wantW, MIN_W, Math.max(MIN_W, W - 28)), W);
      const height = Math.min(clamp(wantH, MIN_H, availH), Math.max(MIN_H, H - topSafe - 16));
      const left = clamp(Math.round((W - width) / 2) + step - 28, 12, Math.max(12, W - width - 12));
      const top = clamp(topSafe + step, topSafe, Math.max(topSafe, H - height - bottomSafe));
      return { left, top, width, height };
    }
    const width = Math.min(clamp(Math.round(W * 0.3), 340, 460), W);
    const top = Math.min(topSafe + step, Math.max(topSafe, H - MIN_H - bottomSafe));
    const height = Math.max(Math.min(clamp(availH, 280, 640), H - top - bottomSafe), Math.min(MIN_H, Math.max(160, H - top - 8)));
    const left = kind === 'hub' ? W - width - 20 - step : 20 + step;
    return { left: clamp(left, 0, Math.max(0, W - width)), top, width, height };
  }

  function raise(key) {
    if (stack.raise(key)) layout();
    onRaise?.();
  }

  function close(key) {
    const w = wins.get(key);
    if (!w) return;
    wins.delete(key);
    stack.close(key);
    w.destroy();
    w.el.remove();
    layout();
    onChange?.();
  }

  /**
   * The frame every window shares: title bar (drag), close button, resize handles, focus on pointer down, Esc.
   * `canClose()`: false while the window holds a draft; the close button then asks first, Esc keeps the window.
   */
  function frame(key, { label, avatar, title, subtitle, actions = [], sub = null, body, foot, canClose = () => true }) {
    const titleEl = h('b', {}, title), subEl = h('span', {}, subtitle);
    let asking = false;
    const closeAsked = async () => {
      if (canClose()) { close(key); return; }
      if (asking) return;
      asking = true;
      let ok = false;
      try {
        ok = await askClose({ title: lt('关闭这个窗口？'), message: lt('窗口里还有没发送的内容，关闭后会丢失。'), confirmText: lt('关闭'), danger: true });
      } catch { /* no answer: the window stays */ } finally { asking = false; }
      if (ok && wins.get(key)?.el === el) close(key);   // still this window (not closed, or closed and opened again, meanwhile)
    };
    const bar = h('header', { class: 'smw-bar' }, avatar, h('div', { class: 'smw-tt' }, titleEl, subEl), ...actions,
      h('button', { type: 'button', class: 'smw-wb smw-close', title: lt('关闭'), 'aria-label': lt('关闭'), onclick: closeAsked }, icon('close')));
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('i', { class: `smw-rz smw-rz-${d}`, 'data-d': d, 'aria-hidden': 'true' }));
    const el = h('section', { class: 'smw-win', role: 'dialog', 'aria-label': label, 'data-window': key }, bar, sub, body, foot, ...handles);
    el.addEventListener('pointerdown', () => raise(key));
    el.addEventListener('focusin', () => raise(key));
    // Esc closes this window (the view itself stays); a window holding a draft keeps it and stays open.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      if (canClose()) close(key);
    });
    const style = (box) => Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    const track = (handle, move) => (e) => {
      if (e.button !== 0 || e.target.closest?.('button')) return;
      e.preventDefault();
      raise(key);
      handle.setPointerCapture?.(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, l: num(el.offsetLeft), t: num(el.offsetTop), w: num(el.offsetWidth), h: num(el.offsetHeight) };
      const onMove = (ev) => style(move(start, ev.clientX - start.x, ev.clientY - start.y));
      const stop = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    };
    bar.addEventListener('pointerdown', track(bar, (s, dx, dy) => {
      const { W, H } = size();
      return { left: clamp(s.l + dx, 60 - s.w, W - 60), top: clamp(s.t + dy, 0, H - 40), width: s.w, height: s.h };
    }));
    for (const handle of handles) {
      const d = handle.getAttribute('data-d');
      handle.addEventListener('pointerdown', track(handle, (s, dx, dy) => {
        let { l: left, t: top, w: width, h: height } = s;
        if (d.includes('e')) width = Math.max(MIN_W, s.w + dx);
        if (d.includes('s')) height = Math.max(MIN_H, s.h + dy);
        if (d.includes('w')) { width = Math.max(MIN_W, s.w - dx); left = s.l + s.w - width; }
        if (d.includes('n')) { top = clamp(s.t + dy, 0, s.t + s.h - MIN_H); height = s.t + s.h - top; }
        return { left, top, width, height };
      }));
    }
    return { el, style, titleEl, subEl };
  }

  /** Keeps `body` at the bottom across a redraw when it was there (or `force`), and in place when older items went in front. */
  function redraw(body, draw, { force = false, prepended = false } = {}) {
    const height = num(body.scrollHeight), top = num(body.scrollTop);
    const atBottom = height - top - num(body.clientHeight) < 48;
    draw();
    if (prepended) body.scrollTop = top + num(body.scrollHeight) - height;
    else if (force || atBottom) body.scrollTop = num(body.scrollHeight);
  }

  /** A node per entry, rebuilt only when what it shows changed (the objects it was made from are compared). */
  function nodeCache() {
    const cache = new Map();
    return {
      get(key, refs, make) {
        const hit = cache.get(key);
        if (hit && hit.refs.length === refs.length && hit.refs.every((ref, i) => ref === refs[i])) return hit.node;
        const node = make();
        cache.set(key, { refs, node });
        return node;
      },
      keep(keys) { for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key); },
      clear() { cache.clear(); },
    };
  }

  const memberOf = (id) => directory.members.get(id) ?? null;
  const clusterName = (cid) => directory.clusters.get(cid)?.name ?? cid;
  const appName = (member) => (member ? harnessApp(member.harness).name : t('应用'));
  const authorName = (message) => messageAuthorName(message, directory.members);
  const authorAvatar = (message) => {
    if (isSystemMessage(message)) return systemAvatar();
    if (message.from === 'user') return userAvatar('sm');
    const member = memberOf(message.from);
    return member ? avatarEl(member, 'sm') : h('span', { class: 'avatar sm' }, '?');
  };
  const errorText = (error) => (error?.status === 400 && error?.data?.error === 'unknown member in cluster'
    ? t('这个群员已不在这个群里，或群已移入回收站。') : t('读取失败：{message}', { message: error?.message ?? String(error) }));

  /** A system notice's look: its category (and warning level) picks the colour, the same as its satellite's. */
  const noticeClass = (message) => {
    const { category, level } = systemClass(message.systemKind);
    return `smw-k-${category}${level ? ` smw-k-${level}` : ''}`;
  };

  // ---- the Hub chat window ----

  function hubWindow(key, clusterId) {
    let messages = [], pending = [], loaded = false, hasMore = true, loading = false, sending = false, gone = false;
    let lastRead = null, readAt = -Infinity, readTimer = null, readBlocked = false;
    // This window, not its key: one closed and opened again for the same chat is another window, and an answer to this
    // one's read that comes back later changes nothing (a message already sent stays sent).
    let dead = false;
    const alive = () => !closed && !dead;
    const cache = nodeCache();
    const list = h('div', { class: 'smw-list' });
    const older = h('button', { type: 'button', class: 'smw-more', hidden: true, onclick: () => loadOlder() }, lt('加载更早的消息'));
    const status = h('p', { class: 'smw-status' }, t('正在读取群聊消息…'));
    const body = h('div', { class: 'smw-body', tabindex: '-1' }, older, status, list);
    const input = h('textarea', { rows: '1', 'aria-label': lt('消息') });
    const send = h('button', { type: 'submit', class: 'smw-send' }, icon('send'), h('span', {}, lt('发送')));
    const error = h('p', { class: 'smw-error', hidden: true, role: 'alert' });
    const form = h('form', { class: 'smw-composer' }, input, send);
    const foot = h('div', { class: 'smw-foot' }, error, form);
    const full = h('button', { type: 'button', class: 'smw-wb', title: lt('在聊天界面打开'), 'aria-label': lt('在聊天界面打开'),
      onclick: () => ctx.openChat(clusterId) }, icon('chats'));
    const f = frame(key, {
      label: '', avatar: h('span', { class: 'smw-hubav', 'aria-hidden': 'true' }), title: '', subtitle: lt('群聊'),
      actions: [full], body, foot, canClose: () => !input.value.trim(),
    });

    function names(redrawAll = true) {
      const name = clusterName(clusterId);
      f.titleEl.textContent = name;
      f.el.setAttribute('aria-label', t('Hub 群聊：{name}', { name }));
      input.setAttribute('placeholder', t('发到「{name}」…（Enter 发送，Shift+Enter 换行）', { name }));
      gone = Boolean(directory.clusters.get(clusterId)?.deletedAt);
      input.disabled = gone;
      send.disabled = gone || sending;
      if (gone) showError(t('这个群已移入回收站。'));
      else if (error.textContent === t('这个群已移入回收站。')) showError('');
      if (!redrawAll) return;
      cache.clear();
      draw();
    }

    function showError(text) { error.textContent = text; error.hidden = !text; }

    function messageNode(message) {
      if (isSystemMessage(message)) {
        const live = satellites.get(clusterId)?.has(message.id);
        return h('div', { class: `smw-sys ${noticeClass(message)}${live ? ' smw-sat-live' : ''}`, 'data-mid': message.id },
          h('span', { class: 'smw-sat', 'aria-hidden': 'true' }),
          textBody(message.body, { plain: plainTextRecord(message) }),
          live ? h('span', { class: 'smw-sat-tag' }, t('卫星')) : null,
          h('time', { datetime: message.createdAt }, fmtTime(message.createdAt)));
      }
      const mine = message.from === 'user';
      const files = message.attachments?.length ?? 0;
      return h('div', { class: mine ? 'smw-msg smw-me' : 'smw-msg', 'data-mid': message.id }, authorAvatar(message),
        h('div', { class: 'smw-mb' },
          h('div', { class: 'smw-meta' }, h('b', {}, authorName(message)),
            message.fyi ? h('span', { class: 'smw-tag' }, t('仅知会')) : null,
            h('time', { datetime: message.createdAt }, fmtTime(message.createdAt))),
          h('div', { class: 'smw-bub' }, textBody(message.body),
            files ? h('p', { class: 'smw-note' }, t('附件 {count} 个（在聊天界面查看）', { count: files })) : null)));
    }

    function draw() {
      const keys = new Set(messages.map((m) => m.id));
      cache.keep(keys);
      list.replaceChildren(...messages.map((m) => cache.get(m.id, [m, satellites.get(clusterId)?.has(m.id) ?? false], () => messageNode(m))));
      older.hidden = !loaded || !hasMore || !messages.length;
      status.hidden = loaded && messages.length > 0;
      if (loaded && !messages.length) status.textContent = t('还没有消息。');
    }

    async function load() {
      loading = true;
      try {
        const page = await ctx.api('GET', messagesPath(clusterId));
        if (!alive()) return;
        const list = Array.isArray(page) ? page : [];
        hasMore = list.length >= HUB_PAGE;
        messages = mergeMessages(list, pending);
        pending = [];
        loaded = true;
        redraw(body, draw, { force: true });
        markRead();
      } catch (e) {
        if (!alive()) return;
        status.textContent = errorText(e);
      } finally { loading = false; }
    }

    async function loadOlder() {
      if (loading || !messages.length) return;
      loading = true;
      older.disabled = true;
      try {
        const page = await ctx.api('GET', messagesPath(clusterId, messages[0].id));
        if (!alive()) return;
        const list = Array.isArray(page) ? page : [];
        hasMore = list.length >= HUB_PAGE;
        messages = prependMessages(messages, list);
        redraw(body, draw, { prepended: true });
      } catch (e) {
        if (alive()) showError(errorText(e));
      } finally { loading = false; older.disabled = false; }
    }

    /** Marks the newest message read while this window is the focused one, at most every two seconds. */
    function markRead() {
      if (!alive() || !loaded || readBlocked || stack.top() !== key || doc.hidden) return;
      const target = readTarget(messages, directory.clusters.get(clusterId)?.userReadMessageId ?? null, lastRead);
      if (!target) return;
      const wait = readAt + READ_GAP_MS - Date.now();
      if (wait > 0) {
        if (!readTimer) readTimer = setTimeout(() => { readTimer = null; markRead(); }, wait);
        return;
      }
      readAt = Date.now();
      lastRead = target;
      ctx.api('POST', `/api/clusters/${enc(clusterId)}/read`, { messageId: target })
        .catch((e) => { if (e?.status >= 400 && e.status < 500) readBlocked = true; else lastRead = null; });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || sending || gone) return;
      sending = true;
      send.disabled = true;
      showError('');
      try {
        const message = await ctx.api('POST', `/api/clusters/${enc(clusterId)}/messages`, { body: text });
        if (!alive()) return;
        if (input.value.trim() === text) input.value = '';
        if (message?.id && loaded) {
          messages = mergeMessages(messages, [message]);
          redraw(body, draw, { force: true });
        }
      } catch (err) {
        if (alive()) showError(t('发送失败：{message}', { message: err?.message ?? String(err) }));
      } finally {
        sending = false;
        send.disabled = gone;
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit?.(); }
    });

    return {
      kind: 'hub', clusterId, el: f.el, style: f.style, names,
      start() { names(); load(); },
      event(event) {
        const message = eventMessage(event, clusterId);
        if (!message) return;
        if (!loaded) { pending.push(message); return; }
        const next = mergeMessages(messages, [message]);
        if (next.length === messages.length && next.every((m, i) => m === messages[i])) return;
        messages = next;
        redraw(body, draw);
        markRead();
      },
      focused() { markRead(); },
      satellites() { draw(); },
      focus() { (input.disabled ? body : input).focus?.({ preventScroll: true }); },
      destroy() { dead = true; clearTimeout(readTimer); readTimer = null; cache.clear(); },
    };
  }

  // ---- the member's native conversation ----

  function memberWindow(key, clusterId, memberId) {
    let state = transcriptState(), failure = null, running = false, chain = 0, activityTimer = null;
    // `dead`: this window closed (one opened again for the same member is another window); `binding`: counts the ends of
    // the binding shown (a rebind, a removal): an answer to a read sent before either changes nothing.
    let dead = false, binding = 0;
    let dmMessages = [], dmLoaded = false, dmSending = false, resending = new Set();
    const alive = () => !closed && !dead;
    const pending = new Set();
    const open = new Set();   // keys of the cards shown open
    const posts = new Map();   // Hub message id -> { body } | { error } | 'loading', fetched when a post card opens
    const cache = nodeCache();
    let entries = [];
    const list = h('div', { class: 'smw-list' });
    const older = h('button', { type: 'button', class: 'smw-more', hidden: true, onclick: () => queue('before') }, lt('加载更早的内容'));
    const banner = h('p', { class: 'smw-status' }, t('正在读取…'));
    const unknown = h('p', { class: 'smw-note', hidden: true });
    const dmTray = h('div', { class: 'smw-dm-tray', hidden: true });
    const body = h('div', { class: 'smw-body', tabindex: '-1' }, older, banner, unknown, list, dmTray);
    const all = h('button', { type: 'button', class: 'smw-chip', 'data-ox-all': '', 'aria-pressed': 'false', hidden: true,
      onclick: () => { const next = toggleAllCards(entries, open); open.clear(); for (const k of next) open.add(k); syncCards(); } }, t('全部展开'));
    // Reading again by hand also gives a conversation that kept changing (`reset`) its retries back.
    const refresh = h('button', { type: 'button', class: 'smw-chip', onclick: () => {
      state = { ...state, resets: 0 };
      void directory.refresh();
      queue('latest');
      void loadDms();
    } }, lt('刷新'));
    const sub = h('div', { class: 'smw-sub' }, refresh, all);
    const dmError = h('p', { class: 'smw-error', hidden: true, role: 'alert' });
    const currentBindingGen = () => validBindingGen(memberOf(memberId)?.bindingGen);
    let knownBindingGen = currentBindingGen();
    let handledRebindGen = knownBindingGen;
    let draftBindingGen = null;
    let reboundPending = false;
    let reboundRejectedGen = null;
    let rebindRefreshing = false;
    let rebindRefreshSeq = 0;
    const canConfirmRebind = () => {
      if (rebindRefreshing) return false;
      const gen = currentBindingGen();
      if (gen === null) return false;
      return reboundRejectedGen === null || gen > reboundRejectedGen;
    };
    const rebindText = h('span', {});
    const rebindConfirmBtn = h('button', { type: 'button', class: 'smw-chip smw-rebind-ok', onclick: () => {
      if (!canConfirmRebind()) return;
      reboundPending = false;
      reboundRejectedGen = null;
      draftBindingGen = currentBindingGen();
      showDmError('');
      syncComposer();
      dmInput.focus?.({ preventScroll: true });
    } }, lt('确认发给新对话'));
    const rebindClearBtn = h('button', { type: 'button', class: 'smw-chip', onclick: () => {
      dmInput.value = '';
      reboundPending = false;
      reboundRejectedGen = null;
      rebindRefreshing = false;
      draftBindingGen = null;
      showDmError('');
      syncComposer();
    } }, lt('清空草稿'));
    const rebindGuard = h('div', { class: 'smw-rebind-guard', role: 'alert', hidden: true },
      rebindText, h('div', { class: 'smw-rebind-acts' }, rebindConfirmBtn, rebindClearBtn));
    const dmInput = h('textarea', { rows: '1', 'aria-label': lt('私聊消息') });
    const dmSend = h('button', { type: 'submit', class: 'smw-send' }, icon('send'), h('span', {}, lt('发送')));
    const dmForm = h('form', { class: 'smw-composer smw-dm-composer' }, dmInput, dmSend);
    const footText = h('span', {});
    const footHint = h('div', { class: 'smw-dm-hint' }, icon('orbit', 'ico-xs'), footText);
    const foot = h('div', { class: 'smw-foot smw-dm-foot' }, dmError, rebindGuard, dmForm, footHint);
    const avatarSlot = h('span', { class: 'smw-av' });
    const f = frame(key, {
      label: '', avatar: avatarSlot, title: '', subtitle: '', sub, body, foot,
      canClose: () => !dmInput.value.trim(),
    });
    body.addEventListener('scroll', () => { if (num(body.scrollTop) < 24 && hasOlder(state) && !running) queue('before'); });

    function showDmError(text) { dmError.textContent = text; dmError.hidden = !text; }

    function dmDisabledReason() {
      if (directory.clusters.get(clusterId)?.deletedAt) return t('这个群已移入回收站。');
      const member = memberOf(memberId);
      if (state.status === 'ended' || member?.removedAt) return t('这个群员已不在这个群里，或群已移入回收站。');
      if (member?.hiddenAt) return t('该群员已隐身，不能发送私聊。');
      if (currentBindingGen() === null) {
        return directory.loading ? t('正在同步成员绑定状态，暂时不能发送私聊…') : t('尚未取得成员当前对话绑定，请点「刷新」后再试。');
      }
      return '';
    }

    function syncComposer() {
      const blocked = dmDisabledReason();
      const member = memberOf(memberId);
      const name = member?.name ?? memberId, app = appName(member);
      dmInput.disabled = Boolean(blocked);
      rebindGuard.hidden = !reboundPending || Boolean(blocked);
      const canConfirm = canConfirmRebind();
      rebindConfirmBtn.disabled = !canConfirm;
      rebindText.textContent = rebindRefreshing
        ? t('成员已换绑到新对话，正在同步新对话绑定，原私聊草稿已保留…')
        : canConfirm
          ? t('成员已换绑到新对话，原私聊草稿已保留。确认要发给新对话吗？')
          : t('成员已换绑到新对话，尚未同步到新绑定；请点「刷新」后再确认发送。');
      dmSend.disabled = Boolean(blocked) || dmSending || reboundPending || rebindRefreshing;
      dmInput.setAttribute('placeholder', blocked || t('私聊 {name}…（Enter 发送，Shift+Enter 换行）', { name }));
      footText.textContent = t('私聊仅发给 {name}，其他群员不可见；离线时不启动 {app}', { name, app });
    }
    dmInput.addEventListener('input', () => {
      if (dmInput.value.trim()) {
        if (draftBindingGen === null && !reboundPending) draftBindingGen = currentBindingGen();
      } else {
        draftBindingGen = null;
        if (reboundPending || reboundRejectedGen !== null || rebindRefreshing) {
          reboundPending = false;
          reboundRejectedGen = null;
          rebindRefreshing = false;
          syncComposer();
        }
      }
    });

    function names(redrawAll = true) {
      const member = memberOf(memberId);
      const gen = currentBindingGen();
      let reboundNow = false;
      if (gen !== null) {
        if (knownBindingGen === null) {
          knownBindingGen = gen;
          handledRebindGen = gen;
        } else if (gen > knownBindingGen) {
          knownBindingGen = gen;
          reboundNow = true;
        }
        if (rebindRefreshing && (reboundRejectedGen === null || gen > reboundRejectedGen)) {
          rebindRefreshing = false;
        }
      }
      const name = member?.name ?? memberId, app = appName(member);
      f.titleEl.textContent = name;
      f.subEl.textContent = `${app} · ${clusterName(clusterId)}`;
      f.el.setAttribute('aria-label', t('{name} 的对话（{cluster}）', { name, cluster: clusterName(clusterId) }));
      avatarSlot.replaceChildren(member ? avatarEl(member, 'sm') : h('span', { class: 'avatar sm' }, '?'));
      if (reboundNow) {
        end('rebind');
        return;
      }
      syncComposer();
      if (!redrawAll) return;
      cache.clear();
      draw();
    }

    async function loadDms() {
      try {
        const page = await ctx.api('GET', privateMessagesPath(clusterId, memberId));
        if (!alive()) return;
        const rows = Array.isArray(page) ? page : [];
        dmMessages = mergeMessages(dmMessages, rows);
        dmLoaded = true;
        drawDmTray();
      } catch { /* non-fatal: transcript still displays */ }
    }

    const dmStatusLabel = (status, stale, outcome = null) => {
      if (stale) return t('旧对话');
      if (outcome === 'unknown') return t('结果未知');
      switch (status) {
        case 'queued': return t('排队中');
        case 'running': return t('投递中');
        case 'done': return t('已投递');
        case 'offline': return t('离线未投递');
        case 'failed': return t('投递失败');
        case 'blocked': return t('已拦截');
        case 'superseded': return t('已替换');
        default: return t('已记录');
      }
    };

    const resendBlockedReason = (blockedBy) => {
      switch (blockedBy) {
        case 'offline': return t('成员现在不在线，不能重发。');
        case 'removed': return t('成员已移出，不能重发。');
        case 'hidden': return t('该群员已隐身，不能发送私聊。');
        case 'hop_limit': return t('这条消息链的跳数已到上限，不能重发。');
        case 'chain_limit': return t('这条消息链的轮次已到上限，不能重发。');
        default: return t('当前不能重发这条私聊。');
      }
    };

    async function resendDm(deliveryId) {
      if (!alive() || !deliveryId || resending.has(deliveryId)) return;
      resending.add(deliveryId);
      showDmError('');
      drawDmTray();
      try {
        let confirmDuplicate = false;
        const timeline = await ctx.api('GET', `/api/clusters/${enc(clusterId)}/deliveries/${enc(deliveryId)}/timeline`);
        if (!alive()) return;
        const resend = timeline?.resend;
        if (resend && !resend.available) {
          showDmError(resendBlockedReason(resend.blockedBy));
          return;
        }
        if (resend?.needsConfirmation) {
          let ok = false;
          try {
            ok = await askClose({
              title: lt('确认重发这条私聊？'),
              message: lt('原投递结果未知或可能已开始执行，重发可能导致对方重复执行。确认重发吗？'),
              confirmText: lt('确认重发'),
              danger: true,
            });
          } catch { ok = false; }
          if (!ok || !alive()) return;
          confirmDuplicate = true;
        }
        const result = await ctx.api('POST', `/api/clusters/${enc(clusterId)}/deliveries/${enc(deliveryId)}/resend`,
          confirmDuplicate ? { confirmDuplicate: true } : {});
        if (!alive()) return;
        if (result?.message?.id) {
          const entry = { ...result.message, deliveries: result.delivery ? [result.delivery] : [] };
          dmMessages = mergeMessages(dmMessages, [entry]);
        }
        void loadDms();
      } catch (err) {
        if (alive()) showDmError(t('重发失败：{message}', { message: err?.message ?? String(err) }));
      } finally {
        resending.delete(deliveryId);
        if (alive()) drawDmTray();
      }
    }

    function drawDmTray() {
      const member = memberOf(memberId);
      const currentGen = member?.bindingGen;
      const synced = transcriptPrivateIds(entries);
      const blocked = Boolean(dmDisabledReason());
      // Keep any private DM not yet attributed inside the native transcript, or any stale/non-done/uncertain DM so status is clear.
      const visible = dmMessages.filter((msg) => {
        const info = dmStatusOf(msg, currentGen);
        if (!synced.has(msg.id)) return true;
        return info.stale || info.status !== 'done' || info.outcome === 'unknown';
      });
      dmTray.hidden = visible.length === 0;
      if (!visible.length) { dmTray.replaceChildren(); return; }
      dmTray.replaceChildren(
        h('div', { class: 'smw-dm-tray-head' }, icon('orbit', 'ico-xs'), h('span', {}, t('经 Orrery 私聊'))),
        ...visible.map((msg) => {
          const { status, outcome, delivery, stale, canResend } = dmStatusOf(msg, currentGen);
          const badgeKind = stale ? 'stale' : outcome === 'unknown' ? 'failed' : status;
          const busy = delivery?.id && resending.has(delivery.id);
          return h('div', { class: `smw-u smw-u-dm smw-dm-item smw-dm-${badgeKind}`, 'data-dm-id': msg.id },
            h('div', { class: 'smw-dm-meta' },
              h('span', { class: 'smw-dm-pill' }, icon('orbit', 'ico-xs'), t('经 Orrery 私聊')),
              h('span', { class: `smw-dm-badge smw-dm-badge-${badgeKind}` }, dmStatusLabel(status, stale, outcome)),
              msg.createdAt ? h('time', { datetime: msg.createdAt }, fmtTime(msg.createdAt)) : null),
            h('div', { class: 'smw-bub smw-bub-dm' }, textBody(msg.body)),
            (delivery?.error ?? delivery?.reason) ? h('p', { class: 'smw-dm-reason' }, delivery.error ?? delivery.reason) : null,
            canResend && !blocked ? h('div', { class: 'smw-dm-acts' },
              h('button', { type: 'button', class: 'smw-chip', disabled: Boolean(busy), onclick: () => void resendDm(delivery.id) },
                busy ? t('正在重发…') : t('重试'))) : null);
        }),
      );
    }

    dmForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = dmInput.value.trim();
      const expectedGen = validBindingGen(draftBindingGen) ?? currentBindingGen();
      if (!text || dmSending || reboundPending || rebindRefreshing || dmDisabledReason() || expectedGen === null) return;
      dmSending = true;
      dmSend.disabled = true;
      showDmError('');
      try {
        const created = await ctx.api('POST', `/api/clusters/${enc(clusterId)}/messages`, {
          body: text,
          to: [memberId],
          private: true,
          expectedBindingGen: expectedGen,
        });
        if (!alive()) return;
        if (dmInput.value.trim() === text) {
          dmInput.value = '';
          draftBindingGen = null;
          reboundPending = false;
          reboundRejectedGen = null;
          rebindRefreshing = false;
        }
        if (created?.id) {
          const existing = dmMessages.find((m) => m.id === created.id);
          const deliveries = Array.isArray(created.deliveries) && created.deliveries.length ? created.deliveries : (existing?.deliveries ?? []);
          const row = { ...created, deliveries };
          dmMessages = mergeMessages(dmMessages, [row]);
          redraw(body, drawDmTray, { force: true });
        }
        void loadDms();
      } catch (err) {
        if (!alive()) return;
        if (err?.data?.code === 'BINDING_CHANGED') {
          reboundPending = true;
          reboundRejectedGen = Math.max(reboundRejectedGen ?? 0, expectedGen);
          const latestGen = currentBindingGen();
          rebindRefreshing = latestGen === null || latestGen <= reboundRejectedGen;
          const token = ++rebindRefreshSeq;
          showDmError(t('发送已拦截：成员已换绑到新对话，草稿已保留。'));
          void directory.refresh().finally(() => {
            if (!alive()) return;
            if (token === rebindRefreshSeq) rebindRefreshing = false;
            syncComposer();
          });
        } else {
          showDmError(t('发送失败：{message}', { message: err?.message ?? String(err) }));
        }
      } finally {
        dmSending = false;
        syncComposer();
      }
    });
    dmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); dmForm.requestSubmit?.(); }
    });

    /**
     * Runs the waiting reads one after another; an answer that arrives after the window closed, or after the binding it
     * was read for ended, changes nothing.
     */
    async function run() {
      running = true;
      try {
        for (let want = nextWant(pending); want && alive(); want = nextWant(pending)) {
          pending.delete(want);
          const request = requestFor(state, want);
          if (!request) continue;
          const sent = binding;
          let page;
          try {
            page = await ctx.api('GET', transcriptPath(clusterId, memberId, request));
          } catch (e) {
            if (!alive()) return;
            if (sent !== binding) continue;
            if (isGoneError(e)) { end('ended'); continue; }   // removed meanwhile: what was shown goes too
            failure = e;
            draw();
            continue;
          }
          if (!alive()) return;
          if (sent !== binding) continue;
          failure = null;
          const result = applyPage(state, want, page);
          state = result.state;
          if (want === 'latest') { open.clear(); posts.clear(); }
          redraw(body, draw, { force: want === 'latest', prepended: want === 'before' });
          if (result.then && chain++ < MAX_CHAIN) pending.add(result.then);
        }
      } finally { running = false; }
    }

    function queue(want) {
      if (!alive()) return;
      pending.add(want);
      chain = 0;
      if (!running) run();
    }

    /**
     * The binding shown ended: its text, cursors, open cards and waiting reads go, and answers still on the way are
     * dropped. 'rebind' then reads the newest page of the new conversation; 'ended' shows why there is nothing.
     */
    function end(change) {
      binding++;
      clearTimeout(activityTimer);
      activityTimer = null;
      pending.clear();
      open.clear();
      posts.clear();
      failure = null;
      if (change === 'rebind') {
        const gen = currentBindingGen();
        if (gen !== null) {
          knownBindingGen = gen;
          handledRebindGen = gen;
        }
        if (dmInput.value.trim()) {
          if (draftBindingGen === null || gen === null || draftBindingGen !== gen) reboundPending = true;
        } else {
          reboundPending = false;
          reboundRejectedGen = null;
          rebindRefreshing = false;
          draftBindingGen = null;
        }
      }
      state = change === 'rebind' ? transcriptState() : { ...transcriptState(), status: 'ended' };
      syncComposer();
      redraw(body, draw, { force: true });
      if (change === 'rebind') { queue('latest'); void loadDms(); }
    }

    function reason() {
      if (failure) return errorText(failure);
      const app = appName(memberOf(memberId));
      switch (state.status) {
        case 'loading': return t('正在读取…');
        case 'ended': return t('这个群员已不在这个群里，或群已移入回收站。');
        case 'missing': return t('这个群员没有绑定可读的对话，或对话记录已不在原处。');
        case 'unsupported': return t('{app} 的对话原文还不能在这里读取。', { app });
        case 'archived': return t('这段对话已归档或太大，无法在这里读取。');
        case 'refused': return t('无法读取这段对话。');
        case 'reset': return t('对话记录一直在变，暂时读不出来；稍后点「刷新」再试。');
        default: return state.items.length ? '' : t('这段对话还没有内容。');
      }
    }

    function syncCards() {
      for (const node of list.children ?? []) {
        const k = node.getAttribute?.('data-card');
        if (k === null || k === undefined) continue;
        const shown = open.has(k);
        node.classList.toggle('smw-open', shown);
        node.firstChild?.setAttribute?.('aria-expanded', String(shown));
      }
      const cards = entries.filter(isCard).length;
      const allOpen = allCardsOpen(entries, open);
      all.hidden = cards === 0;
      all.textContent = allOpen ? t('全部收起') : t('全部展开');
      all.setAttribute('aria-pressed', String(allOpen));
      for (const k of open) {
        const entry = entries.find((e) => e.key === k);
        if (entry?.type === 'post') loadPost(entry.item.messageId);
      }
    }

    /** A post card's text is the Hub message; it is read when the card first opens. */
    function loadPost(messageId) {
      if (!messageId || posts.has(messageId)) return;
      posts.set(messageId, 'loading');
      const sent = binding;
      const settle = (value) => {
        if (!alive() || sent !== binding) return;
        posts.set(messageId, value);
        draw();
      };
      ctx.api('GET', `/api/clusters/${enc(clusterId)}/messages/${enc(messageId)}`).then(
        (message) => settle({ body: String(message?.body ?? ''), at: message?.createdAt }),
        (e) => settle({ error: errorText(e) }),
      );
    }

    function card(entry, cls, caption, full) {
      const k = entry.key;
      const node = h('div', { class: `smw-card ${cls}${open.has(k) ? ' smw-open' : ''}`, 'data-card': k },
        h('button', { type: 'button', class: 'smw-cap', 'aria-expanded': String(open.has(k)), onclick: () => {
          if (open.has(k)) open.delete(k); else open.add(k);
          syncCards();
        } }, caption),
        h('div', { class: 'smw-full' }, full));
      return node;
    }

    function partName(part) { return messageAuthorName({ from: part.from, kind: part.kind }, directory.members); }

    function deliveryNode(entry) {
      const item = entry.item;
      const parts = Array.isArray(item.parts) ? item.parts : [];
      // 1-on-1 private Orrery DM: render expanded as a distinct user-aligned DM bubble, never collapsed into group delivery.
      if (isPrivateDeliveryEntry(entry)) {
        return h('div', { class: 'smw-u smw-u-dm', 'data-dm-entry': entry.key },
          h('div', { class: 'smw-dm-meta' },
            h('span', { class: 'smw-dm-pill' }, icon('orbit', 'ico-xs'), t('经 Orrery 私聊')),
            item.timestamp ? h('time', { datetime: item.timestamp }, fmtTime(item.timestamp)) : null),
          ...parts.map((part) => h('div', { class: 'smw-bub smw-bub-dm' }, textBody(part.body, { truncated: part.truncated }))));
      }
      const { from, text, more } = deliveryCaption(item);
      const system = parts.length > 0 && parts.every((p) => p.from === 'system');
      const caption = [
        h('span', { class: system ? 'smw-sat' : 'smw-og', 'aria-hidden': 'true' }),
        h('span', { class: 'smw-from' }, from === null ? t('orrery 投递') : partName(parts[0])),
        h('span', { class: 'smw-via' }, t('经 Hub')),
        h('span', { class: 'smw-sm' }, text),
        more ? h('span', { class: 'smw-tag' }, t('另 {count} 条', { count: more })) : null,
        icon('chevron-down', 'smw-chev'),
      ];
      const full = parts.length
        ? parts.map((part) => h('div', { class: `smw-part${part.from === 'system' ? ' smw-part-sys' : ''}` },
          h('div', { class: 'smw-meta' }, h('b', {}, partName(part))),
          textBody(part.body, { plain: part.from === 'system', truncated: part.truncated })))
        : [h('p', { class: 'smw-note' }, t('这次投递在 Hub 里没有对应的消息，下面是对话里的原文。')),
          h('pre', { class: 'smw-raw' }, String(item.text ?? ''))];
      return card(entry, system ? 'smw-card-sys' : 'smw-card-in', caption,
        [...full, item.timestamp ? h('p', { class: 'smw-note' }, fmtTime(item.timestamp)) : null]);
    }

    function postNode(entry) {
      const { item, call } = entry;
      const post = posts.get(item.messageId);
      const caption = [
        h('span', { class: 'smw-lbl' }, t('发到群里')),
        h('span', { class: 'smw-sm' }, post?.body ? oneLine(post.body, 60) : oneLine(call?.text ?? item.text ?? '', 60)),
        h('span', { class: 'smw-arrow', 'aria-hidden': 'true' }, icon('send')),
      ];
      const full = [
        post === 'loading' || !post ? h('p', { class: 'smw-note' }, t('正在读取…'))
          : post.error ? h('p', { class: 'smw-note' }, post.error) : textBody(post.body),
        call ? h('details', { class: 'smw-tool' }, h('summary', {}, icon('chip', 'smw-sym'), t('工具调用 {name}', { name: call.name ?? 'send_message' }),
          icon('chevron-down', 'smw-chev')),
          h('pre', { class: 'smw-raw' }, String(call.text ?? ''))) : null,
      ];
      return card(entry, 'smw-card-out', caption, full);
    }

    function toolNode({ call, result }) {
      const name = call?.name ?? result?.name ?? t('工具');
      return h('details', { class: 'smw-tool' },
        h('summary', {}, icon('chip', 'smw-sym'), h('span', { class: 'smw-lbl' }, name),
          h('code', {}, oneLine(call?.text ?? result?.text ?? '', 60)),
          result ? icon('check', 'smw-ok') : null, icon('chevron-down', 'smw-chev')),
        call ? h('pre', { class: 'smw-raw' }, String(call.text ?? '')) : null,
        call?.truncated ? h('p', { class: 'smw-note' }, t('（正文已截断）')) : null,
        result ? [h('p', { class: 'smw-note' }, t('结果')), h('pre', { class: 'smw-raw' }, String(result.text ?? '')),
          result.truncated ? h('p', { class: 'smw-note' }, t('（正文已截断）')) : null] : null);
    }

    function entryNode(entry) {
      const { item } = entry;
      switch (entry.type) {
        case 'user': return h('div', { class: 'smw-u' },
          h('span', { class: 'smw-who' }, t('你 · 在 {app} 里输入', { app: appName(memberOf(memberId)) })),
          h('div', { class: 'smw-bub' }, textBody(item.text, { truncated: item.truncated })));
        case 'assistant': return h('div', { class: 'smw-a' }, textBody(item.text, { truncated: item.truncated }));
        case 'system': return h('div', { class: 'smw-sysrec' }, textBody(item.text, { plain: true, truncated: item.truncated }));
        case 'thinking': return entry.text
          ? h('details', { class: 'smw-think' }, h('summary', {}, icon('more', 'smw-sym'), t('思考'), icon('chevron-down', 'smw-chev')),
            h('div', { class: 'smw-tx' }, entry.text))
          : h('div', { class: 'smw-think smw-think-empty' }, icon('more', 'smw-sym'), t('思考（应用没有给出摘要）'));
        case 'tool': return toolNode(entry);
        case 'delivery': return deliveryNode(entry);
        case 'post': return postNode(entry);
        default: return null;
      }
    }

    const refsOf = (entry) => [entry.item, entry.call, entry.result, entry.text,
      entry.type === 'post' ? posts.get(entry.item.messageId) : null, open.has(entry.key)];

    function draw() {
      entries = transcriptEntries(state.items);
      cache.keep(new Set(entries.map((e) => e.key)));
      list.replaceChildren(...entries.map((entry) => cache.get(entry.key, refsOf(entry), () => entryNode(entry))).filter(Boolean));
      const text = reason();
      banner.textContent = text;
      banner.hidden = !text;
      banner.classList.toggle('smw-warn', Boolean(failure) || !['ok', 'loading'].includes(state.status));
      unknown.hidden = !(state.status === 'ok' && state.unknownCount > 0);
      unknown.textContent = t('{count} 条记录无法识别，没有显示。', { count: state.unknownCount });
      older.hidden = !hasOlder(state);
      syncCards();
      drawDmTray();
    }

    return {
      kind: 'member', clusterId, el: f.el, style: f.style, names,
      relabel() { cache.clear(); names(); draw(); },
      start() { names(); queue('latest'); void loadDms(); },
      event(event) {
        const dm = eventPrivateMessage(event, clusterId, memberId);
        if (dm) {
          dmMessages = mergeMessages(dmMessages, [dm]);
          redraw(body, drawDmTray);
        } else if (event?.kind === 'delivery') {
          const next = applyPrivateDeliveryEvent(dmMessages, event);
          if (next !== dmMessages) { dmMessages = next; drawDmTray(); }
        }
        const change = bindingChange(event, clusterId, memberId);
        if (change) {
          if (change === 'rebind') {
            const evGen = validBindingGen(event?.payload?.member?.bindingGen);
            if (evGen !== null && evGen === handledRebindGen) return;
          }
          end(change);
          return;
        }
        if (!isMemberActivity(event, memberId)) return;
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => {
          activityTimer = null;
          const want = wantOnActivity(state);
          if (want) queue(want);
        }, ACTIVITY_DELAY_MS);
      },
      focused() {},
      satellites() {},
      focus() { (dmInput.disabled ? body : dmInput).focus?.({ preventScroll: true }); },
      destroy() { dead = true; clearTimeout(activityTimer); activityTimer = null; pending.clear(); cache.clear(); },
    };
  }

  // ---- embedded same-page plugin panel (official or full-trust) ----

  /** Whether a same-page panel container currently holds unsaved typed input (uses host typedInput when available). */
  function panelHasDraft(container) {
    if (typeof ctx.hasTypedInput === 'function') return Boolean(ctx.hasTypedInput(container));
    // Fallback for standalone DOM simulators without plugin-view's trusted-event tracker.
    const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'textarea']);
    const walk = (node) => {
      if (!node || node.hidden) return false;
      const tag = String(node.tagName ?? node.tag ?? '').toLowerCase();
      if ((tag === 'textarea' || (tag === 'input' && TEXT_TYPES.has(String(node.type ?? '').toLowerCase())))
        && !node.readOnly && typeof node.value === 'string' && node.value.trim()) return true;
      for (const child of node.children ?? []) if (walk(child)) return true;
      return false;
    };
    return walk(container);
  }

  function panelWindow(key, panel, clusterId) {
    let dead = false;
    let cleanup = null;
    const alive = () => !closed && !dead;
    const reads = new AbortController();
    const eventListeners = new Set();
    const localThemeListeners = new Set();
    const panelScopeCluster = panel.scope === 'cluster' ? clusterId : null;
    const body = h('div', { class: 'smw-body smw-panel', tabindex: '-1', 'data-plugin-slot': panel.pluginId });
    const badge = panel.trusted ? [h('span', { class: 'smw-thirdparty' }, lt('第三方插件'))] : [];
    const f = frame(key, {
      label: panel.title(),
      avatar: h('span', { class: 'smw-picon', 'aria-hidden': 'true' }, icon(panel.icon)),
      title: panel.title(),
      subtitle: panelScopeCluster ? clusterName(panelScopeCluster) : t('全局'),
      actions: badge,
      body,
      foot: null,
      canClose: () => !panelHasDraft(body),
    });
    const READS = new Set(['GET', 'HEAD']);
    const panelCtx = Object.freeze({
      clusterId: panelScopeCluster,
      api(method, path, bodyData) {
        if (!alive()) return Promise.reject(new Error(`panel ${panel.key} is closed`));
        if (!READS.has(String(method).toUpperCase())) return ctx.api(method, path, bodyData);
        return ctx.api(method, path, bodyData, { signal: reads.signal })
          .then((data) => (alive() ? data : Promise.reject(new Error(`panel ${panel.key} is closed`))));
      },
      onEvent(fn) {
        if (!alive() || typeof fn !== 'function') return () => {};
        eventListeners.add(fn);
        return () => { eventListeners.delete(fn); };
      },
      get theme() { return getTheme(); },
      onThemeChange(fn) {
        if (!alive() || typeof fn !== 'function') return () => {};
        localThemeListeners.add(fn);
        themeListeners.add(fn);
        return () => { localThemeListeners.delete(fn); themeListeners.delete(fn); };
      },
      setTitle(text) {
        if (!alive() || typeof text !== 'string' || !text.trim()) return;
        f.titleEl.textContent = text;
        f.el.setAttribute('aria-label', text);
      },
      setSubtitle(text) {
        if (!alive() || typeof text !== 'string') return;
        f.subEl.textContent = text;
      },
      close() { if (alive()) close(key); },
      openCluster(cid) { if (alive()) onOpenCluster?.(cid); },
      openMember(cid, mid) { if (alive()) onOpenMember?.(cid, mid); },
    });

    return {
      kind: 'panel', pluginId: panel.pluginId, scope: panel.scope, clusterId: panelScopeCluster, el: f.el, style: f.style,
      names() {
        f.titleEl.textContent = panel.title();
        if (panelScopeCluster) f.subEl.textContent = clusterName(panelScopeCluster);
      },
      start() {
        try {
          ctx.trackTypedInput?.(body, panel.pluginId);
          const result = panel.mount(body, panelCtx);
          if (typeof result === 'function') cleanup = result;
          else if (typeof result?.then === 'function') Promise.resolve(result).catch((err) => {
            if (alive()) body.replaceChildren(h('p', { class: 'smw-status smw-warn' }, t('面板加载失败：{message}', { message: err?.message ?? String(err) })));
          });
        } catch (err) {
          body.replaceChildren(h('p', { class: 'smw-status smw-warn' }, t('面板加载失败：{message}', { message: err?.message ?? String(err) })));
        }
      },
      event(ev) {
        if (panelScopeCluster && ev?.kind === 'cluster' && ev.payload?.cluster?.id === panelScopeCluster && ev.payload.cluster.deletedAt) {
          close(key);
          return;
        }
        for (const fn of [...eventListeners]) {
          if (!eventListeners.has(fn) || !alive()) continue;
          try { fn(ev); } catch { /* isolated */ }
        }
      },
      focused() {},
      satellites() {},
      focus() { body.focus?.({ preventScroll: true }); },
      destroy() {
        if (dead) return;
        dead = true;
        reads.abort();
        eventListeners.clear();
        for (const fn of localThemeListeners) themeListeners.delete(fn);
        localThemeListeners.clear();
        const dispose = cleanup;
        cleanup = null;
        if (dispose) {
          try {
            const res = dispose();
            if (typeof res?.then === 'function') Promise.resolve(res).catch(() => {});
          } catch { /* isolated */ }
        }
        try {
          const res = panel.unmount(body, panelCtx);
          if (typeof res?.then === 'function') Promise.resolve(res).catch(() => {});
        } catch { /* isolated */ }
      },
    };
  }

  // ---- restricted third-party plugin panel (sandboxed iframe via ctx.pluginUi) ----

  function externalPanelWindow(key, item, clusterId) {
    let dead = false;
    let handle = null;
    const body = h('div', { class: 'smw-body smw-ext-body', tabindex: '-1' });
    const f = frame(key, {
      label: `${item.name}（${t('第三方插件')}）`,
      avatar: h('span', { class: 'smw-picon', 'aria-hidden': 'true' }, icon('layers')),
      title: item.name,
      subtitle: clusterName(clusterId),
      actions: [h('span', { class: 'smw-thirdparty' }, lt('第三方插件'))],
      body,
      foot: null,
    });
    return {
      kind: 'external-panel', pluginId: item.pluginId, scope: 'cluster', clusterId, el: f.el, style: f.style,
      names() { f.subEl.textContent = clusterName(clusterId); },
      start() {
        handle = ctx.pluginUi?.mountStarmapFrame?.(item, clusterId) ?? null;
        if (handle?.shell) body.replaceChildren(handle.shell);
        else body.replaceChildren(h('p', { class: 'smw-status smw-warn' }, t('插件界面打不开。')));
      },
      event(ev) {
        if (ev?.kind === 'cluster' && ev.payload?.cluster?.id === clusterId && ev.payload.cluster.deletedAt) close(key);
      },
      focused() {},
      satellites() {},
      focus() { body.focus?.({ preventScroll: true }); },
      destroy() {
        if (dead) return;
        dead = true;
        try { handle?.close(); } catch { /* ignore */ }
        handle = null;
      },
    };
  }

  return {
    /** Opens the window for `target` (hub, member, panel, or external-panel), or raises it. */
    open(target) {
      const key = windowKey(target);
      if (closed || !key) return;
      const existing = wins.get(key);
      if (existing) {
        raise(key);
        existing.el.classList.remove('smw-flash');
        void existing.el.offsetWidth;   // restart the highlight
        existing.el.classList.add('smw-flash');
        existing.focus();
        return;
      }
      const w = target.kind === 'hub' ? hubWindow(key, target.clusterId)
        : target.kind === 'member' ? memberWindow(key, target.clusterId, target.memberId)
          : target.kind === 'panel' ? panelWindow(key, target.panel, target.clusterId)
            : externalPanelWindow(key, target.item, target.clusterId);
      w.style(place(w.kind, target.panel?.defaultSize ?? null));
      wins.set(key, w);
      stack.open(key);
      layer.append(w.el);
      layout();
      onRaise?.();
      if (!directory.loaded) directory.load();
      w.start();
      w.focus();
      onChange?.();
    },
    /** Cluster ids whose Hub chat floating window is currently open. */
    openHubClusterIds() {
      const out = new Set();
      for (const w of wins.values()) if (w.kind === 'hub' && w.clusterId) out.add(w.clusterId);
      return out;
    },
    /** Closes every open panel window owned by `pluginId` (called when a plugin is released/detached). */
    closePluginPanels(pluginId) {
      for (const [key, w] of [...wins]) {
        if ((w.kind === 'panel' || w.kind === 'external-panel') && w.pluginId === pluginId) close(key);
      }
    },
    /** Closes cluster-scoped panels belonging to a deleted cluster. */
    closeClusterPanels(clusterId) {
      for (const [key, w] of [...wins]) {
        if ((w.kind === 'panel' || w.kind === 'external-panel') && w.scope === 'cluster' && w.clusterId === clusterId) close(key);
      }
    },
    /** Broadcasts a Star Map theme change to open same-page plugin panels. */
    setTheme(themeObj) {
      for (const fn of [...themeListeners]) {
        if (!themeListeners.has(fn)) continue;
        try { fn(themeObj); } catch { /* isolated */ }
      }
    },
    /** Closes every window; reads still in flight are ignored when they come back, and the event listener goes. */
    closeAll() {
      if (closed) return;
      closed = true;
      themeListeners.clear();
      unsubLang?.();
      unsubscribe?.();
      for (const key of stack.clear()) {
        const w = wins.get(key);
        wins.delete(key);
        w?.destroy();
        w?.el.remove();
      }
      layer.remove();
    },
    /** The system notices of `clusterId` that still circle as satellites (the scene's state): their lines get a tag. */
    setSatellites(clusterId, ids) {
      satellites.set(clusterId, new Set(ids ?? []));
      for (const w of wins.values()) if (w.clusterId === clusterId) w.satellites();
    },
  };
}
