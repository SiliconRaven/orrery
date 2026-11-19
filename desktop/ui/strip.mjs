// The "+" panel (docs/desktop.md): one icon per supported app, laid out in rows under "+". Renders what the main
// process sends (each app's state, lib/strip.mjs, and icons as data URLs) and sends back a supported app's id when one
// is clicked, or a close on Escape. Names and states are text (tooltips, accessible names), never HTML. Buttons are
// kept per app id and only updated, so a redraw between mouse-down and mouse-up never swallows a click.
import { t, translateStatic } from '../../shared/i18n/index.js';
import { translateDesktopPage } from './language.mjs';

translateStatic(document);
const api = window.orrery;
const box = document.getElementById('apps');
const els = new Map();
let opened = -1;

// The window is sized for whole rows of 44px cells (lib/strip.mjs panelBounds); at some display scales it comes out a
// pixel narrower, so the number of columns is rounded, never floored (a floored count would wrap the last icon).
const fit = () => box.style.setProperty('--cols', String(Math.max(1, Math.round((innerWidth - 2 * 7 + 4) / 48))));
addEventListener('resize', fit);
fit();

function make(tag, props = {}) {
  return Object.assign(document.createElement(tag), props);
}

/** What an icon says when pointed at, by its state. */
function tip(e) {
  if (e.status === 'add') return e.windows === 1 ? t('{name}：加成标签', { name: e.name }) : t('{name}：{count} 个窗口，选一个加成标签', { name: e.name, count: e.windows });
  if (e.status === 'docked') return t('{name}：窗口都已经在标签里了', { name: e.name });
  if (e.status === 'launch') return t('{name}：没有在运行，点一下启动它', { name: e.name });
  if (e.status === 'starting') return t('{name}：正在启动，等它的窗口出现', { name: e.name });
  return t('{name}：没有在运行，也没法启动（{reason}）', { name: e.name, reason: t(e.reason) });
}

function element(id) {
  const b = make('button', { type: 'button', className: 'app' });
  const glyph = make('span', { className: 'glyph' });
  const img = make('img', { className: 'icon', alt: '', draggable: false });
  const letter = make('span', { className: 'letter' });
  const count = make('span', { className: 'count', hidden: true });
  glyph.append(img, letter, count);
  b.append(glyph);
  b.addEventListener('click', () => { if (b.getAttribute('aria-disabled') !== 'true') api.pick(id); });
  return { b, img, letter, count, key: '' };
}

api.onState((s) => {
  translateDesktopPage(s.language);
  s.entries.forEach((e, i) => {
    let el = els.get(e.id);
    if (!el) { el = element(e.id); els.set(e.id, el); }
    if (box.children[i] !== el.b) box.insertBefore(el.b, box.children[i] ?? null);
    const src = s.icons?.[e.id] ?? '';
    const key = JSON.stringify([e, src, s.language]);
    if (key === el.key) return;
    el.key = key;
    if (src) { if (el.img.getAttribute('src') !== src) el.img.src = src; } else el.img.removeAttribute('src');
    el.img.hidden = !src;
    el.letter.hidden = !!src;
    el.letter.textContent = src ? '' : [...String(e.name).trim()][0] ?? '?';
    el.b.dataset.status = e.status;
    el.b.setAttribute('aria-disabled', String(e.status !== 'add' && e.status !== 'launch'));
    el.b.title = tip(e);
    el.b.setAttribute('aria-label', tip(e));
    el.count.hidden = e.windows < 2;
    el.count.textContent = e.windows > 9 ? '9+' : String(e.windows);
  });
  // Opened again: start from the panel itself (no button looks chosen); arrows, Tab, Home and End go to the buttons.
  if (s.opened !== opened) { opened = s.opened; box.focus(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.close(); return; }
  const buttons = [...box.children];
  if (!buttons.length) return;
  const cols = Math.max(1, buttons.filter((b) => b.offsetTop === buttons[0].offsetTop).length);
  const i = buttons.indexOf(document.activeElement);
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
  let next = null;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = buttons.length - 1;
  else if (step !== undefined) next = i < 0 ? 0 : Math.min(buttons.length - 1, Math.max(0, i + step));
  if (next === null) return;
  e.preventDefault();
  buttons[next].focus();
});
