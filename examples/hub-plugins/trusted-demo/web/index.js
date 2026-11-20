// A full-trust plugin's page module (docs/external-plugins.md「完全信任的插件」): the Hub serves this folder read-only at
// /plugin-web/<id>/ once the plugin loaded this start. It imports no page file: everything it uses comes in `host`
// (the page helpers in host.ui, api, nameOf, command, onDispose). Its id is the second part of its own address, so a
// copy under another id talks to its own routes.
const id = decodeURIComponent(new URL(import.meta.url).pathname.split('/')[2]);
const tool = `${id.replaceAll('-', '_')}_note`;

export function register({ api, ui, onDispose }) {
  const { h, noticeDialog, formDialog } = ui;
  const notesPath = (clusterId) => `/api/x/${id}/clusters/${encodeURIComponent(clusterId)}/notes`;
  let currentCluster = () => null;

  async function open(clusterId) {
    if (!clusterId) return noticeDialog('先选一个群聊。', '群便签');
    let notes;
    try { ({ notes } = await api('GET', notesPath(clusterId))); } catch (e) {
      return noticeDialog(e.message, '读取便签失败');
    }
    const input = h('textarea', { rows: 3, maxlength: 500, required: true, placeholder: '写一条便签（最多 500 字）', 'data-trusted-demo': 'input' });
    const list = notes.length
      ? h('ul', { 'data-trusted-demo': 'list' }, notes.map((n) => h('li', {}, `${n.author}：${n.body}`)))
      : h('p', { class: 'muted', 'data-trusted-demo': 'list' }, `这个群还没有便签。群员也可以用工具 ${tool} 留便签。`);
    formDialog('群便签（完全信任示例）', [list, h('label', {}, '新便签', input)], () => api('POST', notesPath(clusterId), { body: input.value }), () => {}, '添加');
  }

  // Alt+Shift+N opens the notes too. A listener on the page outlives the plugin unless it removes it itself: onDispose
  // runs when the plugin is detached from an open page (its trust revoked, switched off, safe mode).
  const shortcut = (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyN') { event.preventDefault(); open(currentCluster()); }
  };
  document.addEventListener('keydown', shortcut);
  onDispose(() => document.removeEventListener('keydown', shortcut));

  const panelCleanups = new Map();

  function detachPanel(el) {
    if (el) {
      const fn = panelCleanups.get(el);
      panelCleanups.delete(el);
      fn?.();
      return;
    }
    for (const fn of panelCleanups.values()) fn?.();
    panelCleanups.clear();
  }

  function mountPanel(el, panelCtx) {
    detachPanel(el);
    if (!panelCtx.clusterId) {
      el.replaceChildren(h('p', { class: 'muted', style: 'padding:12px' }, '请先进入一个群聊再打开群便签。'));
      return () => {};
    }
    let alive = true;
    const listBox = h('div', { 'data-trusted-demo': 'panel-list', style: 'flex:1;overflow:auto;padding:12px;' });
    const input = h('textarea', { rows: 2, maxlength: 500, placeholder: '写一条群便签…', 'data-trusted-demo': 'panel-input' });
    const err = h('p', { class: 'form-error', hidden: true });
    const sendBtn = h('button', { type: 'submit', class: 'primary small' }, '添加便签');
    const form = h('form', { style: 'display:grid;gap:8px;padding:10px 12px;border-top:1px solid var(--line);' }, input, err, h('div', { class: 'row end' }, sendBtn));
    const wrap = h('div', { style: 'display:flex;flex-direction:column;height:100%;min-height:0;' }, listBox, form);
    el.replaceChildren(wrap);

    async function refresh() {
      try {
        const { notes } = await panelCtx.api('GET', notesPath(panelCtx.clusterId));
        if (!alive) return;
        listBox.replaceChildren(notes.length
          ? h('ul', { style: 'margin:0;padding-left:18px;display:grid;gap:6px;' }, notes.map((n) => h('li', {}, `${n.author}：${n.body}`)))
          : h('p', { class: 'muted' }, `这个群还没有便签。群员也可以用工具 ${tool} 留便签。`));
      } catch (e) {
        if (alive) listBox.replaceChildren(h('p', { class: 'form-error' }, e.message));
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      err.hidden = true;
      sendBtn.disabled = true;
      try {
        await panelCtx.api('POST', notesPath(panelCtx.clusterId), { body });
        if (!alive) return;
        input.value = '';
        await refresh();
      } catch (e) {
        if (alive) { err.textContent = e.message; err.hidden = false; }
      } finally {
        sendBtn.disabled = false;
      }
    });

    void refresh();
    const cleanup = () => { alive = false; };
    panelCleanups.set(el, cleanup);
    return () => detachPanel(el);
  }

  return {
    composer({ getClusterId }) {
      currentCluster = getClusterId;
      return h('button', { type: 'button', class: 'small', 'data-trusted-demo': 'open', title: `本群便签（完全信任示例插件 ${id}，Alt+Shift+N）`,
        onclick: () => open(getClusterId()) }, '便签');
    },
    panel: {
      id: 'notes',
      title: '群便签',
      icon: 'file',
      scope: 'cluster',
      defaultSize: { w: 460, h: 400 },
      mount: mountPanel,
      unmount(el) { detachPanel(el); },
    },
  };
}
