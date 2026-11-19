// The tab bar (docs/desktop.md). Renders the state the main process sends and turns clicks into calls with a tab id,
// a pane number, two divider positions or where "+" is, at most. Tabs show icons only (data URLs the main process
// read); titles, app names and messages are set as text (tooltips, accessible names), never as HTML. The apps that
// "+" offers are in a panel of their own (ui/strip.html), opened and closed by the main process.
//
// Nothing the user may be pressing is replaced when the state is drawn again: a button replaced between mouse-down and
// mouse-up gets no click (a first click on the inactive shell activates it, and the shell then sends its state again,
// possibly with another active pane), and a divider replaced while it is dragged loses the pointer capture. So tabs are
// kept per id and only updated, a pane's content is rebuilt only when that pane's own content changed, and the panes
// and dividers are fixed elements of the page, positioned by CSS variables.
import { t, translateStatic } from '../../shared/i18n/index.js';
import { translateDesktopPage } from './language.mjs';

translateStatic(document);
const api = window.orrery;
const $ = (id) => document.getElementById(id);
const panel = $('panel');
const panes = [...panel.querySelectorAll('.pane')];

function make(tag, props = {}, text) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  if (text !== undefined) el.textContent = text;
  return el;
}

const button = (text, onClick) => {
  const b = make('button', { type: 'button' }, text);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
};

/** The last state drawn, and per tab id its elements. */
let current = null;
let drawn = '';
const tabEls = new Map();

/**
 * An app's icon: the image the main process read from the app's program file (a data URL), or, when there is none,
 * the first character of its name on a neutral square. Both elements stay; only which one shows changes.
 */
function glyph() {
  const box = make('span', { className: 'glyph' });
  const img = make('img', { className: 'icon', alt: '', draggable: false });
  const letter = make('span', { className: 'letter' });
  box.append(img, letter);
  return {
    box,
    set(src, name) {
      if (src) { if (img.getAttribute('src') !== src) img.src = src; } else img.removeAttribute('src');
      img.hidden = !src;
      letter.hidden = !!src;
      letter.textContent = src ? '' : [...String(name).trim()][0] ?? '?';
    },
  };
}

function tabElement(id) {
  const box = make('div', { className: 'tab' });
  box.setAttribute('role', 'tab');
  const pick = make('button', { type: 'button', className: 'pick' });
  const icon = glyph();
  const mark = make('span', { className: 'mark', hidden: true });   // "需要重新选择"
  icon.box.append(mark);
  pick.append(icon.box);
  pick.addEventListener('click', () => api.select(id));
  box.append(pick);
  let close = null;
  if (id !== 'orrery') {
    close = make('button', { type: 'button', className: 'close' }, '×');
    close.addEventListener('click', () => api.close(id));
    box.append(close);
  }
  return { box, pick, icon, mark, close, key: '' };
}

/** A newly selected tab scrolled out of the (overflowing) tab row comes into view; nothing else is scrolled. */
function reveal(box) {
  const row = $('tabs');
  const r = box.getBoundingClientRect();
  const v = row.getBoundingClientRect();
  if (r.left < v.left) row.scrollLeft -= v.left - r.left;
  else if (r.right > v.right) row.scrollLeft += r.right - v.right;
}

/** Only the icon shows; the app name and window title are the tooltip and the accessible name. */
function updateTab(el, tab, s) {
  const selected = s.selected === tab.id;
  if (selected && el.box.getAttribute('aria-selected') !== 'true') reveal(el.box);
  el.box.setAttribute('aria-selected', String(selected));
  el.box.classList.toggle('in-pane', s.layout !== 'single' && s.panes.includes(tab.id));
  const src = s.icons?.[tab.app] ?? '';
  const key = JSON.stringify([tab.name, tab.title, tab.status, src, s.language]);
  if (key === el.key) return;
  el.key = key;
  el.icon.set(src, tab.name);
  const lost = tab.status === 'choose';
  el.mark.hidden = !lost;
  el.box.classList.toggle('lost', lost);
  const label = tab.title && tab.title !== tab.name ? `${tab.name} — ${tab.title}` : tab.name;
  el.pick.title = lost ? t('{label}\n需要重新选择：窗口已经关了或身份变了。点这里，从正在运行的窗口里重新选一个', { label }) : label;
  el.pick.setAttribute('aria-label', lost ? t('{label}（需要重新选择）', { label }) : label);
  el.close?.setAttribute('aria-label', t('关闭 {name} 标签', { name: tab.name }));
  if (el.close) el.close.title = t('关闭 {name} 标签（窗口回到原来的位置）', { name: tab.name });
}

function renderTabs(s) {
  const list = [{ id: 'orrery', app: 'orrery', name: t('协作页'), title: '', status: 'bound' }, ...s.tabs];
  for (const [id, el] of tabEls) {
    if (!list.some((t) => t.id === id)) { el.box.remove(); tabEls.delete(id); }
  }
  const row = $('tabs');
  list.forEach((t, i) => {
    let el = tabEls.get(t.id);
    if (!el) { el = tabElement(t.id); tabEls.set(t.id, el); }
    if (row.children[i] !== el.box) row.insertBefore(el.box, row.children[i] ?? null);   // new tabs only: nothing else moves
    updateTab(el, t, s);
  });
}

/** What a pane shows, as a string: its content is rebuilt only when this changes. */
function paneKey(s, i) {
  const id = s.panes[i];
  if (id === undefined) return 'none';
  if (id === null) return `empty:${s.language}`;
  if (id === 'orrery') return JSON.stringify(['orrery', s.hub, s.language]);
  const tab = s.tabs.find((t) => t.id === id);
  return JSON.stringify(['tab', id, tab?.name, tab?.status, s.language]);
}

/** Shown where no window covers the pane: an empty pane, the Hub's state, or a hint behind a docked window. */
function fillPane(pane, s, i) {
  const id = s.panes[i];
  pane.replaceChildren();
  pane.classList.toggle('empty', id === null);
  if (id === undefined) return;
  if (id === null) {
    pane.append(make('div', {}, t('空栏')), make('div', { className: 'hint' }, t('点这里选中这一栏，再点上面的一个标签，把它放进来。')));
  } else if (id === 'orrery') {
    if (s.hub.status === 'starting') pane.append(make('div', {}, t('正在连接 orrery Hub…')));
    if (s.hub.status === 'error') {
      pane.append(make('div', {}, t('orrery Hub 没能启动')), make('div', { className: 'message' }, s.hub.message), button(t('重试'), () => api.retry()));
    }
  } else {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.status === 'bound') {
      pane.append(make('div', {}, t('{name} 停靠在这里。窗口被移开或被盖住了？', { name: tab.name })), button(t('放回这里'), () => api.select(tab.id)));
    } else {
      pane.append(make('div', {}, t('{name} 的窗口已经关了或身份变了，orrery 没有再动它。', { name: tab.name })), button(t('选择窗口'), () => api.select(tab.id)));
    }
  }
}

const paneKeys = [];

function render(s) {
  translateDesktopPage(s.language);
  const key = JSON.stringify(s);
  if (key === drawn) return;
  drawn = key;
  current = s;
  renderTabs(s);
  $('add').disabled = !s.canPick;
  $('add').setAttribute('aria-expanded', String(s.stripOpen));
  $('add').title = s.stripOpen ? t('收起') : t('添加应用窗口');
  $('settings').setAttribute('aria-expanded', String(!!s.settingsOpen));
  panel.dataset.layout = s.layout;
  panel.style.setProperty('--x', String(s.ratios.x));
  panel.style.setProperty('--y', String(s.ratios.y));
  panes.forEach((pane, i) => {
    pane.classList.toggle('active', i === s.active);
    const k = paneKey(s, i);
    if (paneKeys[i] !== k) { paneKeys[i] = k; fillPane(pane, s, i); }
  });
  $('notice').hidden = !s.notice;
  $('notice-text').textContent = s.notice ?? '';
}

// A click on a pane (not covered by a window) makes it the active one.
panes.forEach((pane, i) => pane.addEventListener('click', () => {
  if (current && current.layout !== 'single' && i !== current.active) api.activate(i);
}));

/**
 * A divider: dragged with the pointer captured, it sends the new position at most every 16 ms; the main process
 * clamps it and sends the state back, which moves the divider (only a CSS variable changes).
 */
function divider(el, axis) {
  let pointer = null;
  let want = null;
  let last = 0;
  let timer = 0;
  const send = () => { timer = 0; last = performance.now(); if (want) api.ratios(want); want = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !current) return;
    pointer = e.pointerId;
    el.setPointerCapture(pointer);
    el.classList.add('dragging');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    const r = panel.getBoundingClientRect();
    const v = axis === 'x' ? (e.clientX - r.left - 3) / (r.width - 6) : (e.clientY - r.top - 3) / (r.height - 6);
    want = { x: current.ratios.x, y: current.ratios.y, [axis]: v };
    const wait = 16 - (performance.now() - last);
    if (wait <= 0) send(); else if (!timer) timer = setTimeout(send, wait);
  });
  const end = (e) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('lostpointercapture', end);
}
divider($('vdiv'), 'x');
divider($('hdiv'), 'y');

// Opens or closes the "+" panel, which the main process places under this button's left edge; the gear does the same
// for the settings view. A press anywhere else in this page (a tab, the layout button, a pane, a divider) closes them;
// the empty title-row space never reaches the page (the system handles it), so a press there leaves them as they are.
$('add').addEventListener('click', () => api.add($('add').getBoundingClientRect().left));
$('settings').addEventListener('click', () => api.settings($('settings').getBoundingClientRect().left));
document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('#add, #settings')) api.pressed(); }, true);
// More tabs than fit: the row scrolls sideways (wheel), without a scroll bar.
$('tabs').addEventListener('wheel', (e) => {
  e.preventDefault();
  $('tabs').scrollLeft += e.deltaY || e.deltaX;
}, { passive: false });
$('layout').addEventListener('click', () => api.layoutMenu());
$('notice-close').addEventListener('click', () => api.dismiss());
api.onState(render);
