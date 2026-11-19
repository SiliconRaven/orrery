// Third-party plugins' own web UIs (docs/external-plugins.md「网页界面」): a chip with a popover panel in the cluster's
// title bar, and a tab in the task workbench. Each frame is an <iframe sandbox="allow-scripts"> (an opaque origin: no
// cookie, storage, page DOM or Hub API) inside a shell this page draws, with the plugin's name and a 第三方插件 tag the
// plugin cannot remove. The one channel: frame → postMessage → this page → the Hub's API → the plugin process, and back;
// the plugin's pushes come over the page's event stream. A frame is known only by the window a message comes from
// (event.source), never by anything it says; the Hub derives the plugin, cluster and position from the frame id.
// Plugins granted `marks` also get small host-drawn marks on messages, members and tasks (marksSlot): the plugin gives
// text, a state and a tip, this page draws them as text nodes in a dashed pill with the third-party icon.
import { h, icon } from './ui.js';

/** No `orrery.ready` from the frame in this long: the host shows the load-timeout placeholder. */
const LOAD_TIMEOUT_MS = 10_000;
/** The JSON a request may carry (the Hub checks the same bound) and the requests one frame may have open at once. */
const MAX_DATA_BYTES = 16 * 1024;
const MAX_IN_FLIGHT = 4;
const CHIP_MAX = 24;
/** A mark's text and tip as the Hub cuts them (UI_LIMITS.markText, markTip), cut again here by code point. */
const MARK_TEXT_MAX = 16;
const MARK_TIP_MAX = 80;
const MARK_STATE_WORD = { running: '进行中', done: '完成', failed: '失败', info: '提示' };
const POSITION_LABEL = { titlebar: '标题栏面板', workbench: '工作台' };
/** The colour tokens (style.css :root) a plugin UI receives, resolved to the colours this theme shows now. */
const THEME_TOKENS = ['bg', 'surface', 'surface-2', 'line', 'text', 'muted', 'accent', 'accent-soft', 'on-accent', 'running', 'done',
  'failed', 'warn-bg', 'warn-text'];
/** Hub refusals that mean "this frame may not show now": the placeholder says which. */
const PLACEHOLDER = {
  PLUGIN_NOT_RUNNING: '插件没有在运行。它重新运行后，这里会自动重新加载。',
  UI_OFF: '这个插件的网页界面已在设置的“插件”分区里关闭。',
  FILES_MISSING: '插件的界面文件缺失：插件目录里要有 ui/index.html。',
  FILES_INVALID: '插件的界面文件不符合要求。',
  NOT_GRANTED: '这个插件没有获准在本群的这个位置显示界面。',
  LOAD_TIMEOUT: `插件界面没有在 ${LOAD_TIMEOUT_MS / 1000} 秒内就绪。`,
};

/**
 * The theme a frame gets: its name, light or dark, and each token as the colour it resolves to now. Light or dark is
 * read off the resolved background: the page never asks the system itself (style.css's light-dark() decides).
 */
export function themeSnapshot(doc = document) {
  const name = globalThis.orreryTheme?.current?.() ?? 'system';
  const probe = h('span', { hidden: true });
  doc.body.append(probe);
  const colors = {};
  for (const token of THEME_TOKENS) {
    probe.style.color = `var(--${token})`;
    colors[token] = getComputedStyle(probe).color;
  }
  probe.remove();
  const [r = 255, g = 255, b = 255] = (colors.bg.match(/[\d.]+/g) ?? []).map(Number);
  return { name, scheme: 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light', colors };
}

const jsonSize = (value) => {
  try { return new Blob([JSON.stringify(value ?? null)]).size; } catch { return Infinity; }
};

/**
 * `api`: the page's fetch helper. `itemsChanged(clusterId)`: the UIs a cluster offers changed (the workbench redraws its
 * tabs). `chipsHost`: where the title bar chips go.
 */
export function createPluginUi({ api, chipsHost, itemsChanged = () => {} }) {
  const records = new Map();    // the frame's window → its record; the only way a message is matched to a frame
  const byId = new Map();       // frame id → record (for the stream's pushes and revocations)
  // cluster id → { items, request, frames, marks } as read last; `request` counts reads, `frames` the chip and mark
  // frames applied (loadItems); `marks` is the index of its plugins' marks by target (built when asked, dropped
  // whenever the items or a mark change).
  const items = new Map();
  const hosts = new Set();      // every open frame host (panel and workbench), to update when the items change
  let chatCluster = null;
  let panel = null;             // { pluginId, host, wrap } of the open title bar panel
  let workbenchHost = null;
  let reloadTimer = null;

  const send = (record, message) => {
    try { record.iframe.contentWindow?.postMessage(message, '*'); } catch { /* the frame is gone */ }
  };
  const live = (record) => byId.get(record.frameId) === record;

  // ---- one frame in its host-drawn shell ----

  /**
   * A shell with a frame for one plugin, cluster and position. It asks the Hub for a frame id when the plugin may show,
   * else draws the placeholder; `update(item)` follows a newer listing (a stopped plugin's placeholder, a reload once it
   * runs again). `close()` gives the frame id back.
   */
  function frameHost(item, clusterId, position, closeButton = null) {
    let current = item;
    let record = null;
    let attempt = 0;
    let closed = false;
    let waiting = null;   // the placeholder's reason while there is no frame
    const body = h('div', { class: 'pui-body' });
    const name = h('span', { class: 'pui-name' }, item.name);
    const shell = h('section', { class: `pui-shell pui-at-${position}`, 'data-plugin-ui': item.pluginId, 'data-position': position,
      'aria-label': `${item.name}（第三方插件）` },
    h('header', { class: 'pui-head' }, icon('layers', 'ico-sm'), name, h('span', { class: 'plugin-chip third-party pui-tag' }, '第三方插件'), closeButton),
    body);
    if (position === 'titlebar') body.style.height = `${item.panelHeight}px`;

    const placeholder = (code, text) => {
      waiting = code;
      body.replaceChildren(h('div', { class: 'pui-placeholder', role: 'status', 'data-placeholder': code },
        h('p', {}, text ?? PLACEHOLDER[code] ?? '插件界面打不开。'),
        code === 'LOAD_TIMEOUT' || code === 'FAILED' ? h('button', { type: 'button', class: 'small', onclick: () => load() }, '重试') : null));
    };
    const release = () => {
      if (!record) return;
      const old = record;
      record = null;
      clearTimeout(old.timer);
      records.delete(old.window);
      if (byId.get(old.frameId) === old) {
        byId.delete(old.frameId);
        void api('DELETE', `/api/plugin-ui/frames/${encodeURIComponent(old.frameId)}`, {}).catch(() => {});
      }
    };
    const host = {
      shell,
      get frameId() { return record?.frameId ?? null; },
      revoked(frameId, code) {
        if (record?.frameId !== frameId) return;
        clearTimeout(record.timer);
        records.delete(record.window);
        byId.delete(record.frameId);
        record = null;
        placeholder(code === 'EVICTED' ? 'FAILED' : code, code === 'EVICTED' ? '同一个插件打开的界面太多，这一个被关掉了。' : undefined);
        scheduleReload();
      },
      timedOut() { release(); placeholder('LOAD_TIMEOUT'); },
      reload() { if (!closed) void load(); },
      update(next) {
        current = next;
        name.textContent = next.name;
        // attempt++: a frame still being opened (its POST pending) is given back when it answers, never shown.
        if (!next.on) { attempt++; release(); placeholder('UI_OFF'); return; }
        if (!next.running) { attempt++; release(); placeholder('PLUGIN_NOT_RUNNING'); return; }
        // Back from a stop or a switch-off: a new frame with a new id.
        if (!record && (waiting === 'PLUGIN_NOT_RUNNING' || waiting === 'UI_OFF')) void load();
      },
      close() { closed = true; attempt++; release(); hosts.delete(host); },
    };

    async function load() {
      const mine = ++attempt;
      release();
      if (!current.on) return placeholder('UI_OFF');
      if (!current.running) return placeholder('PLUGIN_NOT_RUNNING');
      waiting = 'LOADING';
      body.replaceChildren(h('p', { class: 'pui-placeholder muted', 'data-placeholder': 'LOADING' }, '正在加载插件界面…'));
      let frame;
      try {
        frame = await api('POST', `/api/clusters/${encodeURIComponent(clusterId)}/plugin-ui/frames`, { pluginId: current.pluginId, position });
      } catch (error) {
        if (mine === attempt && !closed) placeholder(error.data?.code in PLACEHOLDER ? error.data.code : 'FAILED', error.data?.code in PLACEHOLDER ? undefined : error.message);
        return;
      }
      if (mine !== attempt || closed) {
        void api('DELETE', `/api/plugin-ui/frames/${encodeURIComponent(frame.frameId)}`, {}).catch(() => {});
        return;
      }
      // sandbox is set before src, and both before the frame is in the page: it never runs unsandboxed.
      const iframe = h('iframe', { sandbox: 'allow-scripts', src: frame.url, class: 'pui-frame', referrerpolicy: 'no-referrer',
        title: `${current.name} · ${POSITION_LABEL[position]}` });
      waiting = null;
      body.replaceChildren(iframe);
      record = { frameId: frame.frameId, pluginId: current.pluginId, clusterId, position, iframe, window: iframe.contentWindow, host,
        ready: false, inFlight: 0, timer: setTimeout(() => { if (record?.frameId === frame.frameId && !record.ready) host.timedOut(); }, LOAD_TIMEOUT_MS) };
      records.set(record.window, record);
      byId.set(record.frameId, record);
    }

    hosts.add(host);
    void load();
    return host;
  }

  // ---- the channel ----

  async function request(record, message) {
    const id = message.id;
    if (typeof id !== 'string' || !id || id.length > 64) return;
    const reply = (answer) => { if (live(record)) send(record, { type: 'orrery.response', id, ...answer }); };
    const fail = (code, text) => reply({ ok: false, error: { code, message: text } });
    if (jsonSize(message.data) > MAX_DATA_BYTES) return fail('TOO_LARGE', `请求的数据须是 JSON，最多 ${MAX_DATA_BYTES / 1024} KiB。`);
    if (record.inFlight >= MAX_IN_FLIGHT) return fail('BUSY', `同时最多 ${MAX_IN_FLIGHT} 个请求。`);
    record.inFlight++;
    try {
      const answer = await api('POST', `/api/plugin-ui/frames/${encodeURIComponent(record.frameId)}/request`, { data: message.data ?? null });
      reply({ ok: true, result: answer.result });
    } catch (error) {
      fail(error.data?.code ?? 'FAILED', error.message);
    } finally { record.inFlight--; }
  }

  // Only windows this page made frames for are heard; what a frame says about itself (plugin, cluster) is never read.
  // The colours the frames got last: a theme frame goes out only when they change.
  let lastTheme = '';
  addEventListener('message', (event) => {
    const record = records.get(event.source);
    if (!record || !live(record)) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'orrery.ready') {
      clearTimeout(record.timer);
      record.ready = true;
      const theme = themeSnapshot();
      lastTheme = JSON.stringify(theme);
      send(record, { type: 'orrery.init', position: record.position, clusterId: record.clusterId, theme,
        language: document.documentElement.lang || 'zh-CN' });
    } else if (message.type === 'orrery.request') void request(record, message);
  });

  // The theme changed (设置 → 外观): every ready frame gets the new colours. While the page follows the system, a switch
  // of the system's light or dark shows when the page is looked at again (focus, visible): sent then if the colours differ.
  const themeChanged = () => {
    const theme = themeSnapshot();
    const key = JSON.stringify(theme);
    if (key === lastTheme) return;
    lastTheme = key;
    for (const record of byId.values()) if (record.ready) send(record, { type: 'orrery.theme', theme });
  };
  new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  addEventListener('focus', themeChanged);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) themeChanged(); });

  // The page goes away (reload, close, another address): every open frame id is given back, by requests that outlive the
  // page (keepalive). A page that dies without this event leaves its ids until the plugin stops or the per-plugin cap
  // evicts them. Back from the back/forward cache, those ids are gone: each host loads a new frame.
  addEventListener('pagehide', () => {
    for (const id of byId.keys()) {
      fetch(`/api/plugin-ui/frames/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true,
        headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    }
  });
  addEventListener('pageshow', (event) => { if (event.persisted) for (const host of hosts) host.reload(); });

  // ---- what the clusters offer ----

  const itemsOf = (clusterId) => items.get(clusterId)?.items ?? [];

  /**
   * Reads a cluster's list. The one rule: an answer is applied only if it is the newest request's and no chip or mark
   * frame of that cluster was applied after it was sent. Otherwise it may predate what the page already shows: it is
   * dropped unseen and the list is read again (the page keeps what it has; a failed read changes nothing).
   */
  async function loadItems(clusterId) {
    const entry = items.get(clusterId) ?? { items: [], request: 0, frames: 0, marks: null };
    items.set(clusterId, entry);
    const mine = ++entry.request;
    const frames = entry.frames;
    let answer;
    try { answer = await api('GET', `/api/clusters/${encodeURIComponent(clusterId)}/plugin-ui`); } catch { return; }
    if (entry.request !== mine || items.get(clusterId) !== entry) return;
    if (entry.frames !== frames) { void loadItems(clusterId); return; }
    entry.items = Array.isArray(answer.items) ? answer.items : [];
    entry.marks = null;
    refreshMarks(clusterId);
    if (clusterId === chatCluster) drawChips();
    if (workbenchHost?.clusterId === clusterId) {
      const item = entry.items.find((i) => i.pluginId === workbenchHost.pluginId && i.positions.includes('workbench'));
      if (item) workbenchHost.host.update(item);
    }
    itemsChanged(clusterId);
  }

  /**
   * Reads the listings again soon (a plugin started, stopped or its switch changed; the Hub may have restarted): the
   * shown cluster's, the workbench's and those of clusters with marks on the page now. Any other cluster read before is
   * forgotten; a slot of it shown later reads it again.
   */
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      const shown = [...document.querySelectorAll('[data-pui-marks]')].map((slot) => slot.dataset.puiCluster);
      const keep = new Set([chatCluster, workbenchHost?.clusterId, ...shown].filter(Boolean));
      for (const clusterId of [...items.keys()]) if (!keep.has(clusterId)) items.delete(clusterId);
      for (const clusterId of keep) void loadItems(clusterId);
    }, 150);
  }

  // ---- marks on messages, members and tasks: drawn here from the plugins' data, never their markup ----

  const markKey = (target, id) => `${target}\n${id}`;
  /** A cluster's marks by target, each list sorted by plugin name; only of plugins that run with their UI on. */
  function markIndex(clusterId) {
    const entry = items.get(clusterId);
    if (!entry) return null;
    if (!entry.marks) {
      const index = new Map();
      for (const item of entry.items) {
        if (!item.running || !item.on || !item.positions?.includes('marks') || !Array.isArray(item.marks)) continue;
        for (const mark of item.marks) {
          if (typeof mark?.text !== 'string' || typeof mark.targetId !== 'string') continue;
          const key = markKey(mark.target, mark.targetId);
          if (!index.has(key)) index.set(key, []);
          index.get(key).push({ pluginId: item.pluginId, name: String(item.name), text: [...mark.text].slice(0, MARK_TEXT_MAX).join(''),
            state: MARK_STATE_WORD[mark.state] ? mark.state : null,
            tip: typeof mark.tip === 'string' ? [...mark.tip].slice(0, MARK_TIP_MAX).join('') : null });
        }
      }
      for (const list of index.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || (a.pluginId < b.pluginId ? -1 : 1));
      entry.marks = index;
    }
    return entry.marks;
  }

  /**
   * One mark: a dashed pill with the host's third-party icon, the state's dot and the text, all text nodes. Its accessible
   * name starts with 第三方插件：and names the plugin; hovering it or focusing it by keyboard shows the plugin's name and the tip.
   */
  function markEl(mark) {
    const word = MARK_STATE_WORD[mark.state];
    return h('span', { class: `pui-mark${mark.state ? ` pui-mark-${mark.state}` : ''}`, tabindex: '0', role: 'img',
      'aria-label': `第三方插件：${mark.name}：${mark.text}${word ? `（${word}）` : ''}${mark.tip ? `。${mark.tip}` : ''}`,
      'data-plugin-mark': mark.pluginId },
    icon('layers', 'ico-xs pui-mark-icon'),
    mark.state ? h('span', { class: 'pui-dot', 'aria-hidden': 'true' }) : null,
    h('span', { class: 'pui-mark-text' }, mark.text),
    h('span', { class: 'pui-mark-tip', 'aria-hidden': 'true' }, h('b', {}, `${mark.name}（第三方插件）`), mark.tip ? h('span', {}, mark.tip) : null));
  }

  /** What each slot shows now (fillSlot leaves a slot alone while this is unchanged: focus and the open list stay). */
  const drawn = new WeakMap();

  /**
   * Fills one slot from the index: at most data-pui-max marks, the rest behind "+N", which lists them all. A slot of a
   * cluster not read yet starts the read (and is filled when it arrives). Redrawn only when what it shows changed; then a
   * focused mark or "+N" keeps focus by its position.
   */
  function fillSlot(slot) {
    const { puiCluster: clusterId, puiMarks: target, puiId: id } = slot.dataset;
    if (!items.has(clusterId)) void loadItems(clusterId);
    const list = markIndex(clusterId)?.get(markKey(target, id)) ?? [];
    const max = Number(slot.dataset.puiMax) || 1;
    const hidden = list.length - max;
    if (hidden <= 0) delete slot.dataset.open;
    const open = slot.dataset.open === '1';
    const key = JSON.stringify([list, open]);
    if (drawn.get(slot) === key) return;
    drawn.set(slot, key);
    const focusable = () => [...slot.querySelectorAll('[tabindex]')];
    const focused = focusable().indexOf(document.activeElement);
    slot.hidden = !list.length;
    const more = hidden > 0 ? h('span', { class: 'pui-marks-more', role: 'button', tabindex: '0', 'aria-expanded': String(open),
      'aria-label': `还有 ${hidden} 个第三方插件标记，${open ? '收起' : '展开全部'}`, title: open ? '收起' : '查看全部标记' }, `+${hidden}`) : null;
    const all = open ? h('span', { class: 'pui-marks-all', role: 'group', 'aria-label': '全部第三方插件标记' },
      list.map((mark) => h('span', { class: 'pui-marks-all-row' }, markEl(mark),
        h('span', { class: 'pui-marks-all-who' }, mark.name), mark.tip ? h('span', { class: 'pui-marks-all-tip' }, mark.tip) : null))) : null;
    slot.replaceChildren(...list.slice(0, max).map(markEl), more ?? '', all ?? '');
    if (all) fit(all);
    if (focused >= 0) { const now = focusable(); now[Math.min(focused, now.length - 1)]?.focus({ preventScroll: true }); }
  }

  /** "+N" opens or closes the full list; focus stays on it. */
  function toggleSlot(slot) {
    if (slot.dataset.open === '1') delete slot.dataset.open; else slot.dataset.open = '1';
    fillSlot(slot);
    slot.querySelector('.pui-marks-more')?.focus();
  }

  /**
   * The part of the viewport where `el` can be seen: the viewport cut by every ancestor that clips or scrolls (the chat,
   * the member panel, the workbench dialog and its panes).
   */
  function visibleArea(el) {
    const area = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.overflowX === 'visible' && style.overflowY === 'visible' && up.tagName !== 'DIALOG') continue;
      const r = up.getBoundingClientRect();
      area.left = Math.max(area.left, r.left); area.top = Math.max(area.top, r.top);
      // The inside of its scrollbars and borders: what it shows.
      area.right = Math.min(area.right, r.left + up.clientLeft + up.clientWidth); area.bottom = Math.min(area.bottom, r.top + up.clientTop + up.clientHeight);
    }
    return area;
  }

  /**
   * Keeps a shown popover (a tip, the "+N" list; CSS puts it under its anchor, left-aligned) inside the visible area
   * around it (visibleArea). Narrowed to the width there is, moved left as far as it sticks out on the right, and put
   * above its anchor when it would run past the bottom and there is more room above.
   */
  function fit(pop) {
    pop.style.left = pop.style.top = pop.style.bottom = pop.style.maxWidth = '';
    if (!pop.getClientRects().length) return;   // not shown
    const margin = 4;
    const seen = visibleArea(pop.parentElement);
    const area = { left: seen.left + margin, right: seen.right - margin, top: seen.top + margin, bottom: seen.bottom - margin };
    if (pop.getBoundingClientRect().width > area.right - area.left) pop.style.maxWidth = `${area.right - area.left}px`;
    let box = pop.getBoundingClientRect();
    const shift = box.right > area.right ? area.right - box.right : 0;
    pop.style.left = `${Math.max(shift, area.left - box.left)}px`;
    box = pop.getBoundingClientRect();
    const anchor = pop.parentElement.getBoundingClientRect();
    if (box.bottom > area.bottom && anchor.top - area.top > area.bottom - anchor.bottom) {
      pop.style.top = 'auto';
      pop.style.bottom = 'calc(100% + 4px)';
    }
  }
  // A tip is placed when it shows: on hover and on focus (CSS shows it for :hover and :focus-visible).
  const fitTip = (event) => {
    const tip = event.target.closest?.('.pui-mark')?.querySelector(':scope > .pui-mark-tip');
    if (tip) fit(tip);
  };

  /** Redraws the slots on the page for this cluster (and target, and id, when given). */
  function refreshMarks(clusterId, target = null, id = null) {
    for (const slot of document.querySelectorAll(`[data-pui-cluster="${CSS.escape(clusterId)}"]`)) {
      if ((target === null || slot.dataset.puiMarks === target) && (id === null || slot.dataset.puiId === id)) fillSlot(slot);
    }
  }

  /** A mark frame from the stream, for a cluster this page has read: the one mark set or cleared, or all of a plugin's gone. */
  function markEvent(frame) {
    if (typeof frame.clusterId !== 'string' || typeof frame.pluginId !== 'string') return;
    const entry = items.get(frame.clusterId);
    if (!entry) return;
    entry.frames++;   // a list read before this frame must not be applied over it (loadItems)
    const item = entry.items.find((i) => i.pluginId === frame.pluginId);
    if (!item) return;
    if (frame.kind === 'marks-cleared') {
      item.marks = [];
      entry.marks = null;
      refreshMarks(frame.clusterId);
      return;
    }
    if (typeof frame.targetId !== 'string' || typeof frame.target !== 'string') return;
    const others = (Array.isArray(item.marks) ? item.marks : []).filter((m) => m.target !== frame.target || m.targetId !== frame.targetId);
    item.marks = frame.mark ? [...others, { ...frame.mark, target: frame.target, targetId: frame.targetId }] : others;
    entry.marks = null;
    refreshMarks(frame.clusterId, frame.target, frame.targetId);
  }

  // ---- the title bar: a chip per plugin, one popover panel open at a time ----

  function closePanel(focusChip = false) {
    if (!panel) return;
    const { pluginId, host, wrap } = panel;
    panel = null;
    host.close();
    wrap.querySelector('.pui-panel')?.remove();
    const chip = chipsHost.querySelector(`[data-plugin-chip="${CSS.escape(pluginId)}"] .pui-chip`);
    chip?.setAttribute('aria-expanded', 'false');
    if (focusChip) chip?.focus();
  }

  function openPanel(item, wrap) {
    closePanel();
    const close = h('button', { type: 'button', class: 'icon pui-close', 'aria-label': `关闭${item.name}的面板`, title: '关闭（Esc）',
      onclick: () => closePanel(true) }, icon('close'));
    const host = frameHost(item, chatCluster, 'titlebar', close);
    const box = h('div', { class: 'pui-panel', id: `pui-panel-${item.pluginId}`, role: 'group', 'aria-label': `${item.name}的面板`,
      onkeydown: (event) => { if (event.key === 'Escape') { event.stopPropagation(); closePanel(true); } } }, host.shell);
    wrap.append(box);
    wrap.querySelector('.pui-chip')?.setAttribute('aria-expanded', 'true');
    panel = { pluginId: item.pluginId, host, wrap };
  }

  function chipButton(item, wrap) {
    const state = item.chip?.state;
    const text = [...(item.chip?.text ?? item.name)].slice(0, CHIP_MAX).join('');
    return h('button', { type: 'button', class: `pui-chip${state ? ` pui-${state}` : ''}${item.running && item.on ? '' : ' pui-idle'}`,
      'aria-expanded': String(panel?.pluginId === item.pluginId), 'aria-controls': `pui-panel-${item.pluginId}`,
      title: `${item.name}（第三方插件）`, onclick: () => (panel?.pluginId === item.pluginId ? closePanel(true) : openPanel(item, wrap)) },
    // The host's mark, the same as on the frame's shell: no plugin text can make the chip look like orrery's own.
    icon('layers', 'ico-xs pui-mark'), h('span', { class: 'sr-only' }, '第三方插件：'),
    state ? h('span', { class: 'pui-dot', 'aria-hidden': 'true' }) : null, h('span', { class: 'pui-chip-text' }, text),
    state ? h('span', { class: 'sr-only' }, { running: '（进行中）', done: '（完成）', failed: '（失败）' }[state]) : null);
  }

  function drawChips() {
    const list = chatCluster ? itemsOf(chatCluster).filter((item) => item.positions.includes('titlebar')) : [];
    if (panel && !list.some((item) => item.pluginId === panel.pluginId)) closePanel();
    // In place: a wrap that holds the open panel is never moved (a moved iframe reloads as a new window).
    const ids = new Set(list.map((item) => item.pluginId));
    for (const el of [...chipsHost.children]) if (!ids.has(el.dataset.pluginChip)) el.remove();
    for (const item of list) {
      let wrap = [...chipsHost.children].find((el) => el.dataset.pluginChip === item.pluginId);
      if (!wrap) { wrap = h('div', { class: 'pui-chip-wrap', 'data-plugin-chip': item.pluginId }); chipsHost.append(wrap); }
      const chip = chipButton(item, wrap);
      const old = wrap.querySelector('.pui-chip');
      const focused = old && document.activeElement === old;
      if (old) old.replaceWith(chip); else wrap.prepend(chip);
      if (focused) chip.focus();
      if (panel?.pluginId === item.pluginId) panel.host.update(item);
    }
    chipsHost.hidden = !list.length;
  }

  return {
    /** The cluster the chat shows (null: none, or 全部对话): its chips; another cluster closes the open panel. */
    showCluster(clusterId) {
      if (clusterId === chatCluster) return;
      closePanel();
      chatCluster = clusterId;
      drawChips();
      if (clusterId) void loadItems(clusterId);
    },
    /** A plugin-state frame from the stream: a plugin started, stopped or changed its switch. */
    pluginState() { scheduleReload(); },
    /** The stream reconnected (the Hub may have restarted: every frame id is gone). */
    reconnected() {
      for (const host of hosts) host.reload();
      scheduleReload();
    },
    /** A `plugin-ui` frame from the stream: a push to named frames, a chip, or revoked frames. */
    event(frame) {
      if (frame?.kind === 'push' && Array.isArray(frame.frameIds)) {
        for (const id of frame.frameIds) {
          const record = byId.get(id);
          // A push is for the frames the Hub named, of that plugin: a ready frame gets it, one still loading does not.
          if (record?.ready && record.pluginId === frame.pluginId) send(record, { type: 'orrery.push', data: frame.data });
        }
      } else if (frame?.kind === 'revoked' && Array.isArray(frame.frameIds)) {
        for (const id of frame.frameIds) byId.get(id)?.host.revoked(id, frame.reason);
      } else if (frame?.kind === 'chip' && typeof frame.clusterId === 'string') {
        const entry = items.get(frame.clusterId);
        if (entry) entry.frames++;   // as for marks: a list read before this frame is not applied over it
        const item = itemsOf(frame.clusterId).find((i) => i.pluginId === frame.pluginId);
        if (item) { item.chip = frame.chip; if (frame.clusterId === chatCluster) drawChips(); }
      } else if (frame?.kind === 'mark' || frame?.kind === 'marks-cleared') markEvent(frame);
    },
    /**
     * A place for the third-party marks on a message, member or task of a cluster (at most `max` shown, the rest behind
     * "+N"). It fills itself now and follows every later change in place; hidden while there is none. The cluster's
     * list is read the first time it is asked for.
     */
    marksSlot(clusterId, target, id, max) {
      // Clicks anywhere in it (a mark, "+N", the list, a gap) stop here: inside a task card or a member row they must not
      // open the task or the member page. "+N" toggles the list; Esc closes an open list and goes no further (the
      // member panel or the workbench around it stays open).
      const slot = h(target === 'message' ? 'div' : 'span', { class: `pui-marks pui-marks-${target}`, 'data-pui-cluster': clusterId,
        'data-pui-marks': target, 'data-pui-id': id, 'data-pui-max': String(max), hidden: true,
        onmouseover: fitTip, onfocusin: fitTip,
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.target.closest?.('.pui-marks-more')) toggleSlot(slot);
        },
        onkeydown: (event) => {
          const onMore = event.target.closest?.('.pui-marks-more');
          if ((event.key === 'Enter' || event.key === ' ') && onMore) toggleSlot(slot);
          else if (event.key === 'Escape' && slot.dataset.open === '1') toggleSlot(slot);
          else return;
          event.preventDefault();
          event.stopPropagation();
        } });
      if (clusterId && id) fillSlot(slot);
      return slot;
    },
    /** A cached element put back into the page (the chat keeps message elements a filter or a jump took out): its marks as they are now. */
    refreshMarksIn(el) {
      for (const slot of el.querySelectorAll('[data-pui-marks]')) fillSlot(slot);
    },
    /** The workbench's plugin tabs for a cluster (read when it is not known yet; `itemsChanged` follows). */
    workbenchTabs(clusterId) {
      if (!clusterId) return [];
      if (!items.has(clusterId)) void loadItems(clusterId);
      return itemsOf(clusterId).filter((item) => item.positions.includes('workbench')).map((item) => ({ id: item.pluginId, name: item.name }));
    },
    /** Shows this plugin's workbench frame in `pane` (kept while the same plugin and cluster stay chosen). */
    showWorkbench(clusterId, pluginId, pane) {
      if (workbenchHost?.clusterId === clusterId && workbenchHost.pluginId === pluginId && pane.contains(workbenchHost.host.shell)) return;
      this.hideWorkbench();
      const item = itemsOf(clusterId).find((i) => i.pluginId === pluginId && i.positions.includes('workbench'));
      if (!item) return;
      const host = frameHost(item, clusterId, 'workbench');
      pane.replaceChildren(host.shell);
      workbenchHost = { clusterId, pluginId, host };
    },
    hideWorkbench() {
      if (!workbenchHost) return;
      workbenchHost.host.close();
      workbenchHost.host.shell.remove();
      workbenchHost = null;
    },
  };
}
