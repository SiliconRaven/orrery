import { h } from './ui.js';
import { onLanguageChange, t } from './i18n.js';

const INSTALLS = '/api/plugin-installs';
const PERMISSIONS = {
  'clusters.read': '读取群信息',
  'messages.read': '读取群消息',
  'events.read': '读取群事件',
  'events.publish': '发布插件事件',
  'messages.send': '向群发言',
  'messages.mention': '点名成员',
  'messages.gate': '检查成员发言',
  'tools.provide': '为群员提供工具',
  'ui.show': '显示插件界面',
};
const UI_POSITIONS = { titlebar: '群聊标题栏', workbench: '任务工作台', marks: '插件标记' };
const CLUSTER_PERMISSIONS = Object.keys(PERMISSIONS).filter((name) => name !== 'messages.send' && name !== 'messages.mention');
const EVENTS = {
  'message.created': '新消息',
  'task.submitted': '任务提交',
  'task.approved': '任务通过',
  'task.rejected': '任务退回',
  'task.merged': '任务合并',
  'member.status': '成员状态变化',
};

/** Install through the page's authenticated API helper. Only Confirm writes the installation. */
export function mountPluginInstall(container, { api, onInstalled } = {}) {
  let preview = null;
  let source = '';
  let archive = null;
  let sourceMode = 'source';
  let candidates = [];
  let clusters = [];
  let clusterError = false;
  let permissions = new Set();
  let events = new Set();
  let clusterIds = new Set();
  let writeClusterIds = new Set();
  const tools = new Set();
  const ui = new Set();
  let busy = false;
  let disposed = false;
  let installed = false;
  let error = '';
  let active = null;

  const removeStage = (id) => api('DELETE', `${INSTALLS}/${encodeURIComponent(id)}`);
  const run = (work) => { active = work(); };
  const note = (text, className = 'muted') => h('p', { class: className }, text);
  const errorView = () => error ? h('p', { class: 'error', role: 'alert' }, error) : null;
  const check = (label, value, selected, change, disabled = false) => h('label', { class: 'inline' }, h('input', {
    type: 'checkbox', checked: selected.has(value), disabled: busy || disabled,
    'data-install-choice': value,
    onchange: (event) => {
      if (event.target.checked) selected.add(value); else selected.delete(value);
      change();
    },
  }), ' ', label);

  async function readClusters() {
    try { clusters = await api('GET', '/api/clusters'); clusterError = false; }
    catch { clusterError = true; }
  }

  async function prepare(manifestPath) {
    if (busy || disposed) return;
    error = '';
    if (sourceMode === 'source' && !source.trim()) error = t('填写 GitHub URL 或 npm 包名。');
    if (sourceMode === 'file' && !archive) error = t('选择一个 zip 或 tgz 插件包。');
    if (error) { draw(); return; }
    busy = true;
    draw();
    try {
      const path = `${INSTALLS}/prepare${manifestPath && sourceMode === 'file' ? `?manifestPath=${encodeURIComponent(manifestPath)}` : ''}`;
      const prepared = sourceMode === 'file'
        ? await api('POST', path, await archive.arrayBuffer(), { headers: {
          'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(archive.name),
        } })
        : await api('POST', path, { source: source.trim(), ...(manifestPath ? { manifestPath } : {}) });
      preview = prepared;
      candidates = [];
      permissions = new Set(); events = new Set(); clusterIds = new Set(); writeClusterIds = new Set();
      tools.clear(); ui.clear();
      if (!disposed) await readClusters();
    } catch (e) {
      const data = e.data ?? e;
      if (data.code === 'MANIFEST_SELECTION_REQUIRED' && Array.isArray(data.manifestPaths)) {
        candidates = data.manifestPaths;
        error = '';
      } else error = e.message;
    } finally { busy = false; draw(); }
  }

  async function cancel() {
    if (busy || disposed) return;
    busy = true; error = ''; draw();
    try {
      if (preview) await removeStage(preview.id);
      preview = null; candidates = [];
    } catch (e) { error = e.message; }
    finally { busy = false; draw(); }
  }

  async function confirm() {
    if (busy || disposed || !preview) return;
    busy = true; error = ''; draw();
    try {
      const result = await api('POST', `${INSTALLS}/${encodeURIComponent(preview.id)}/confirm`, {
        permissions: [...permissions], events: [...events], clusterIds: [...clusterIds], writeClusterIds: [...writeClusterIds],
        tools: [...tools], ui: [...ui],
      });
      installed = true; preview = null;
      try { await onInstalled?.(result); }
      catch (e) { error = t('插件已安装，刷新插件列表失败。{error}', { error: e.message }); }
    } catch (e) { error = e.message; }
    finally { busy = false; draw(); }
  }

  const usesReadClusters = () => CLUSTER_PERMISSIONS.some((permission) => permissions.has(permission));

  function permissionChanged() {
    if (!permissions.has('messages.send')) { permissions.delete('messages.mention'); writeClusterIds.clear(); }
    if (!permissions.has('events.read')) events.clear();
    if (!permissions.has('tools.provide')) tools.clear();
    if (!permissions.has('ui.show')) ui.clear();
    if (!usesReadClusters()) clusterIds.clear();
    draw();
  }

  function sourceForm() {
    const remote = h('input', { type: 'text', value: source, placeholder: 'https://github.com/owner/repo · @scope/package',
      'aria-label': t('GitHub URL 或 npm 包名'), disabled: busy || candidates.length > 0, oninput: (event) => { source = event.target.value; } });
    const file = h('input', { type: 'file', accept: '.zip,.tgz,.tar.gz', disabled: busy || candidates.length > 0, 'aria-label': t('插件包文件'),
      onchange: (event) => { archive = event.target.files[0] ?? null; draw(); } });
    const mode = (value, label) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'plugin-install-source', value,
      checked: sourceMode === value, disabled: busy, onchange: () => { sourceMode = value; candidates = []; error = ''; draw(); } }), ' ', t(label));
    return h('form', { class: 'settings-card', onsubmit: (event) => { event.preventDefault(); run(() => prepare()); } },
      h('h4', {}, t('安装插件')),
      h('div', { class: 'limit-form' }, mode('source', 'GitHub 或 npm'), mode('file', '本地插件包')),
      sourceMode === 'source' ? h('label', {}, t('GitHub URL 或 npm 包名'), remote)
        : h('label', {}, t('插件包文件'), file, archive ? note(archive.name) : null),
      candidates.length ? h('fieldset', { class: 'settings-field', disabled: busy }, h('legend', {}, t('选择插件清单')),
        note(t('这个包包含多个插件，选择要安装的清单。')),
        candidates.map((path) => h('button', { type: 'button', class: 'small', 'data-install-manifest': path,
          onclick: () => run(() => prepare(path)) }, path))) : null,
      errorView(), h('div', { class: 'limit-form' },
        h('button', { type: 'submit', disabled: busy, 'data-install-prepare': '' }, t(busy ? '正在准备…' : '读取并审阅')),
        candidates.length ? h('button', { type: 'button', disabled: busy, onclick: () => { candidates = []; draw(); } }, t('取消')) : null));
  }

  function review() {
    const manifest = preview.manifest;
    const groupChoices = (title, choices, selected, enabled) => h('fieldset', { class: 'settings-field', disabled: busy || !enabled },
      h('legend', {}, t(title)), choices.length ? choices.map((c) => check(c.name, c.id, selected, () => {})) : note(t('没有可选择的群。')));
    return h('section', { class: 'plugin-card', 'aria-label': t('审阅插件安装') },
      h('h4', {}, manifest.name || manifest.id),
      note(t('版本 {version} · {id}', { version: manifest.version, id: manifest.id })),
      manifest.description ? note(manifest.description) : null,
      note(t('来源 {source}', { source: preview.source.resolved }), 'limit-source muted'),
      preview.source.requested !== preview.source.resolved ? note(t('请求的来源 {source}', { source: preview.source.requested }), 'limit-source muted') : null,
      note(t('清单 {path}', { path: preview.manifestPath }), 'limit-source muted'),
      note(t('依赖 {dependencies}', { dependencies: manifest.requires?.join(', ') || t('无') })),
      note(t('只安装你信任的插件。插件在本机运行代码，授权项限制它能使用的 Hub 接口。'), 'plugin-trust'),
      h('fieldset', { class: 'settings-field', disabled: busy }, h('legend', {}, t('允许的权限')),
        manifest.permissions.length ? manifest.permissions.map((p) => check(`${t(PERMISSIONS[p] || p)} · ${p}`, p, permissions,
          permissionChanged, p === 'messages.mention' && !permissions.has('messages.send'))) : note(t('此插件未申请权限。'))),
      manifest.permissions.includes('messages.mention') ? note(t('允许点名可能唤醒成员并消耗模型用量。'), 'plugin-trust') : null,
      manifest.events?.length ? h('fieldset', { class: 'settings-field', disabled: busy || !permissions.has('events.read') },
        h('legend', {}, t('订阅的事件')), manifest.events.map((e) => check(`${t(EVENTS[e] || e)} · ${e}`, e, events, () => {}))) : null,
      manifest.memberTools?.length ? h('fieldset', { class: 'settings-field', disabled: busy || !permissions.has('tools.provide') },
        h('legend', {}, t('允许的工具')), manifest.memberTools.map((tool) => check(tool.name, tool.name, tools, () => {}))) : null,
      manifest.ui?.positions.length ? h('fieldset', { class: 'settings-field', disabled: busy || !permissions.has('ui.show') },
        h('legend', {}, t('允许的界面位置')), manifest.ui.positions.map((position) => check(t(UI_POSITIONS[position] ?? position), position, ui, () => {}))) : null,
      groupChoices('读取和订阅的群', clusters, clusterIds, usesReadClusters()),
      groupChoices('可发言的群', clusters, writeClusterIds, permissions.has('messages.send')),
      clusterError ? h('div', {}, note(t('读取群列表失败，可以重试。'), 'error'),
        h('button', { type: 'button', disabled: busy, onclick: () => run(async () => { busy = true; draw(); await readClusters(); busy = false; draw(); }) }, t('重试读取群'))) : null,
      note(t('权限、事件和群范围默认不授权。只勾选本次要允许的项目。')),
      errorView(), h('div', { class: 'limit-form' },
        h('button', { type: 'button', disabled: busy, 'data-install-confirm': '', onclick: () => run(confirm) }, t(busy ? '正在处理…' : '确认安装')),
        h('button', { type: 'button', disabled: busy, 'data-install-cancel': '', onclick: () => run(cancel) }, t('取消安装'))));
  }

  function draw() {
    if (disposed) return;
    container.replaceChildren(installed ? h('section', { class: 'settings-card', role: 'status' },
      h('h4', {}, t('已安装，等待重启 Hub')),
      note(t('使用设置里的“退出 orrery”，然后重新打开 orrery，使插件生效。')),
      errorView(), h('button', { type: 'button', onclick: () => { installed = false; error = ''; draw(); } }, t('安装另一个插件')))
      : preview ? review() : sourceForm());
  }

  draw();
  const stopLanguage = onLanguageChange(() => draw());   // drawn from the state above: what was typed or picked stays
  return {
    hasDraft: () => !installed && Boolean(source.trim() || archive || busy || preview || candidates.length),
    async dispose() {
      disposed = true;
      stopLanguage();
      container.replaceChildren();
      await active;
      if (preview) await removeStage(preview.id);
      preview = null;
    },
  };
}
