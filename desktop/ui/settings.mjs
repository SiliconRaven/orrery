// The settings view (docs/desktop.md "应用位置"): one row per supported app with where the shell would start it from
// and why. Renders what the main process sends (lib/app-paths.mjs settingsRow, plus each app's last message and icon)
// and sends back an app id with one action, or a close. Paths, names and messages are set as text, never as HTML. The
// page never sends a path: "使用这个位置" saves what the main process itself finds again, "选择程序…" opens the system's
// file dialog in the main process. 清除 asks here first (a second button), then sends the app id.
import { t, translateStatic } from '../../shared/i18n/index.js';
import { translateDesktopPage } from './language.mjs';

translateStatic(document);
const api = window.orrery;
const $ = (id) => document.getElementById(id);
const list = $('rows');
let current = null;
let opened = -1;
let confirming = null;   // the app id whose 清除 waits for its confirmation
let confirmingPath = null;   // the saved path it was asked for: if that changes, the question is dropped

function make(tag, props = {}, text) {
  const el = Object.assign(document.createElement(tag), props);
  if (text !== undefined) el.textContent = text;
  return el;
}

const VIA = { saved: '你保存的位置', alias: '应用自己的启动入口（应用执行别名）', shortcut: '开始菜单快捷方式' };
const OFFER = { shortcut: '开始菜单快捷方式', window: '正在运行的窗口的程序' };

/** The status line: a short state and, where there is one, its reason. */
function statusText(r) {
  if (r.status === 'saved') return r.saved.source === 'detected' ? t('已保存（自动检测后由你确认）') : t('已保存（你选的程序）');
  if (r.status === 'invalid') return t('保存的位置已失效：{reason}', { reason: t(r.saved.reason) });
  if (r.status === 'alias') return t('找到了：应用自己的启动入口');
  if (r.status === 'shortcut') return t('找到了：开始菜单快捷方式');
  if (r.status === 'window') return t('没找到安装，但看到了它正在运行的窗口');
  return t('没找到');
}

/** A path on one line, shortened in the middle (the file name stays); the whole path on hover and when focused. */
function pathLine(path, label, cls = '') {
  const cut = path.lastIndexOf('\\') + 1;
  const box = make('div', { className: `path ${cls}`.trim(), tabIndex: 0, title: path });
  box.setAttribute('aria-label', t('{label}：{path}', { label, path }));
  if (!cls.includes('bare')) box.append(make('span', { className: 'label' }, label));
  box.append(make('span', { className: 'lead' }, path.slice(0, cut)), make('span', { className: 'file' }, path.slice(cut)));
  return box;
}

/** `arg`: with 使用这个位置, the token the main process gave the offer shown in this row. */
function button(text, action, id, cls = '', arg) {
  const b = make('button', { type: 'button', className: cls }, text);
  b.dataset.focus = `${id}:${action}`;
  b.addEventListener('click', () => act(action, id, arg));
  return b;
}

function act(action, id, arg) {
  if (current?.busy) return;
  if (action === 'clear') { confirming = id; confirmingPath = current.rows.find((r) => r.id === id)?.saved?.path ?? null; draw(); return; }
  if (action === 'cancel') { confirming = null; draw(); return; }
  if (action === 'confirm') { confirming = null; api.clear(id); return; }
  if (action === 'use') { api.use(id, arg); return; }
  api[action](id);
}

function row(r, icon) {
  const li = make('li', { className: 'row' });
  li.dataset.status = r.status;
  li.dataset.app = r.id;
  const glyph = make('span', { className: 'glyph' });
  if (icon) glyph.append(make('img', { className: 'icon', alt: '', src: icon, draggable: false }));
  else glyph.append(make('span', { className: 'letter' }, [...String(r.name).trim()][0] ?? '?'));
  const main = make('div', { className: 'main' });
  const status = make('div', { className: 'status' });
  status.append(make('span', { className: 'dot' }), make('span', {}, statusText(r)));
  main.append(make('div', { className: 'name' }, r.name), status);
  if (r.status === 'invalid') main.append(pathLine(r.saved.path, t('保存的'), 'old'));
  if (r.inUse) main.append(pathLine(r.inUse.path, r.status === 'invalid' ? t('现在用{source}', { source: t(VIA[r.inUse.source]) }) : t('启动'), 'use'));
  else if (r.status === 'invalid') main.append(make('div', { className: 'note' }, t('现在没法启动它。')));
  if (r.status === 'missing' && r.reason) main.append(make('div', { className: 'note' }, t(r.reason)));
  if (r.offer) {
    const offer = make('div', { className: 'offer' });
    const found = make('div', { className: 'found' });
    found.append(make('div', { className: 'caption' }, t('检测到：{source}', { source: t(OFFER[r.offer.source]) })), pathLine(r.offer.path, t('检测到的位置'), 'bare'));
    offer.append(found, button(t('使用这个位置'), 'use', r.id, 'primary', r.offer.token));
    main.append(offer);
  }
  if (r.msix) main.append(make('div', { className: 'note' }, t('应用商店安装的应用，只从它自己的启动入口启动。')));
  if (r.message) main.append(make('div', { className: 'message', role: 'status' }, r.message));
  const actions = make('div', { className: 'actions' });
  if (confirming === r.id && r.saved) {
    actions.append(button(t('确认清除'), 'confirm', r.id, 'danger'), button(t('取消'), 'cancel', r.id));
  } else {
    actions.append(button(t('自动检测'), 'detect', r.id));
    if (!r.msix) actions.append(button(t('选择程序…'), 'pick', r.id));
    if (r.saved) actions.append(button(t('清除'), 'clear', r.id));
  }
  li.append(glyph, main, actions);
  return li;
}

/** Redrawn whole (a few rows); the focused button or path keeps the focus across the redraw. */
function draw() {
  if (!current) return;
  const focused = document.activeElement?.dataset?.focus;
  list.replaceChildren(...current.rows.map((r) => row(r, current.icons?.[r.id] ?? '')));
  for (const b of list.querySelectorAll('button')) b.disabled = !!current.busy;
  if (focused) list.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

api.onState((s) => {
  translateDesktopPage(s.language);
  $('language').value = s.language ?? 'zh';
  $('language').disabled = !!s.busy;
  current = s;
  if (s.opened !== opened) { opened = s.opened; confirming = null; draw(); list.scrollTop = 0; $('view').focus(); return; }
  if (confirming && !s.rows.some((r) => r.id === confirming && r.saved?.path === confirmingPath)) confirming = null;
  draw();
});

$('language').addEventListener('change', () => api.language($('language').value));

$('close').addEventListener('click', () => api.close());
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (confirming) { confirming = null; draw(); } else api.close();
});
