// The star map's cluster list (/ or Ctrl+K): search clusters, groups and members (data.js searchSky), choose one and the
// camera flies to its star system; the recycle bin is the last line. Text goes in as text; a match is wrapped in <mark>.
import { h, icon } from '/plugin-host/v1.js';
import { lt, t } from './words.js';
import { harnessInfo, searchSky } from './data.js';

/** `text` as nodes with the first case-insensitive match of `q` (already lower-cased) in a <mark>. */
function marked(text, q) {
  const s = String(text);
  const at = q ? s.toLocaleLowerCase('zh-CN').indexOf(q) : -1;
  return at < 0 ? [s] : [s.slice(0, at), h('mark', {}, s.slice(at, at + q.length)), s.slice(at + q.length)];
}

/**
 * `model()` the sky model now, `trashCount()` clusters in the bin, `current()` the cluster in view (or null),
 * `onOpen()` before it opens (other popups close), `choose(row)` with a searchSky row; `signal` ends its listeners.
 * Returns { el, open, close(refocus = true), toggle, isOpen, refresh }.
 */
export function createFinder({ button, model, trashCount, current, onOpen, choose, signal }) {
  const input = h('input', { type: 'search', class: 'sm-fq', placeholder: lt('搜索群聊、分组或群员'), 'aria-label': lt('搜索群聊、分组或群员'),
    autocomplete: 'off', spellcheck: 'false', 'aria-controls': 'sm-flist' });
  const list = h('div', { class: 'sm-flist', id: 'sm-flist', role: 'listbox', 'aria-label': lt('群聊') });
  const closeBtn = h('button', { type: 'button', class: 'sm-wb', title: lt('关闭（Esc）'), 'aria-label': lt('关闭') }, icon('close', 'ico-sm'));
  const el = h('aside', { class: 'sm-finder', role: 'dialog', 'aria-label': lt('群聊列表'), hidden: true },
    h('div', { class: 'sm-fhead' }, input, closeBtn), list, h('div', { class: 'sm-ffoot' }, lt('方向键选择 · 回车打开 · Esc 关闭 · 按 / 随时打开')));
  let rows = [], active = 0, nodes = [];

  function render() {
    const raw = input.value.trim(), q = raw.toLocaleLowerCase('zh-CN');
    const found = searchSky(model(), raw, t('回收站'));
    rows = found.rows;
    active = found.active;
    const out = [];
    let group = null;
    nodes = rows.map((r, i) => {
      const id = `sm-fr${i}`;
      if (r.type === 'trash') {
        return h('div', { class: 'sm-fr sm-fbin', role: 'option', id, 'aria-selected': 'false' }, icon('trash', 'ico-sm'),
          h('span', { class: 'sm-fn' }, ...marked(t('回收站（{count}）', { count: trashCount() }), q)));
      }
      const { system } = r;
      if (r.type === 'member') {
        const m = r.planet.member;
        return h('div', { class: 'sm-fr sm-fm', role: 'option', id, 'aria-selected': 'false' },
          h('span', { class: 'sm-av sm-av-xs', style: `--c:${harnessInfo(m.harness).color}` }),
          h('span', { class: 'sm-fn' }, ...marked(m.name, q), h('em', {}, ...marked(harnessInfo(m.harness).label, q))),
          h('span', { class: `sm-st sm-st-${r.planet.status}`, title: { online: t('在线'), busy: t('工作中'), offline: t('离线') }[r.planet.status] }));
      }
      const s = system.stats;
      const summary = [t('{count} 名群员', { count: s.n }), s.busy ? t('{count} 工作中', { count: s.busy }) : '',
        system.cluster.unread ? t('未读 {count}', { count: system.cluster.unread }) : '',
        s.notices ? t('{count} 条通知', { count: s.notices }) : '', !q || !r.group ? '' : galaxyLabel(r.group)].filter(Boolean).join(' · ');
      return h('div', { class: 'sm-fr', role: 'option', id, 'aria-selected': 'false' }, h('span', { class: 'sm-hubav' }),
        h('span', { class: 'sm-fn' }, h('b', {}, ...marked(system.cluster.name, q)), current() === system.cluster.id ? h('i', {}, t('当前')) : null, h('small', {}, summary)));
    });
    for (const [i, r] of rows.entries()) {
      if (!q && r.type === 'cluster' && r.group !== group) {
        group = r.group;
        out.push(h('div', { class: 'sm-fgroup', role: 'presentation' }, galaxyLabel(group), group ? null : h('small', {}, t('没有分组的群聊'))));
      }
      out.push(nodes[i]);
    }
    list.replaceChildren(...(out.length ? out : [h('div', { class: 'sm-fempty' }, t('没有匹配「{query}」的群聊、分组或群员', { query: raw }))]));
    sync();
  }
  const galaxyLabel = (name) => (name ? name : t('未分组'));
  function sync() {
    nodes.forEach((node, i) => {
      const on = i === active;
      node.classList.toggle('sm-on', on);
      node.setAttribute('aria-selected', String(on));
      if (on) node.scrollIntoView?.({ block: 'nearest' });
    });
    if (rows.length) input.setAttribute('aria-activedescendant', `sm-fr${active}`); else input.removeAttribute('aria-activedescendant');
  }
  function open() {
    onOpen?.();
    el.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    input.value = '';
    render();
    input.focus();
  }
  function close(refocus = true) {
    if (el.hidden) return;
    const had = el.contains(document.activeElement);
    el.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus && had) button.focus();
  }
  function pick(i) {
    const r = rows[i];
    if (!r) return;
    close(false);
    choose(r);
  }
  const on = (target, type, fn) => target.addEventListener(type, fn, { signal });
  on(input, 'input', render);
  on(input, 'keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; sync(); }
    } else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  on(list, 'pointermove', (e) => {
    const i = nodes.indexOf(e.target.closest?.('.sm-fr'));
    if (i >= 0 && i !== active) { active = i; sync(); }
  });
  on(list, 'click', (e) => {
    const i = nodes.indexOf(e.target.closest?.('.sm-fr'));
    if (i >= 0) pick(i);
  });
  on(closeBtn, 'click', () => close());
  on(button, 'click', (e) => { e.stopPropagation(); if (el.hidden) open(); else close(); });
  on(document, 'pointerdown', (e) => { if (!el.hidden && !el.contains(e.target) && !button.contains(e.target)) close(false); });
  return {
    el, open, close,
    toggle: () => (el.hidden ? open() : close()),
    isOpen: () => !el.hidden,
    refresh: () => { if (!el.hidden) render(); },
  };
}
