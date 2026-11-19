// 技能与 MCP (docs/files.md「各应用的 skill 和 MCP」「安装 skill」): the shared skills folder and each app's skills and
// MCP servers, read-only, and installing a skill into the shared folder (from an app, a local folder or a ZIP). Built on
// the settings dialog's frame (settings.css): a rail of places and one panel. The pure helpers at the top run in node
// (test/extensions-ui.test.ts).
import { confirmDialog, emptyState, h, harnessApp, icon } from './ui.js';
import { nextTab } from './settings.js';

/** What each refusal code means, in plain words (the codes are listed in docs/files.md). */
const REFUSALS = {
  bad_request: '请求的格式不对。',
  not_configured: '没有设置共享 skill 文件夹。',
  shared_dir_link: '共享 skill 文件夹或它的上级文件夹是链接（或目录联接）。为了不把文件写到别处，orrery 不往这样的位置安装。',
  shared_dir_invalid: '共享 skill 文件夹不能用（不是文件夹，或建不起来）。',
  unknown_app: '没有这个应用。',
  unknown_skill: '这个应用里已经没有这个 skill 了，请刷新列表。',
  skill_is_link: '这个 skill 是指向别处的链接，orrery 不跟随链接。请改用“从文件夹安装”，选它实际所在的文件夹。',
  path_not_absolute: '请填完整的路径，以盘符开头，例如 D:\\skills\\my-skill。',
  path_not_local: '不支持网络路径和设备路径，请填本机磁盘上的文件夹。',
  path_not_found: '找不到这个文件夹。',
  path_not_directory: '这个路径不是文件夹。',
  source_has_link: '来源里有链接（符号链接或目录联接）。为了不读到别处的文件，orrery 不安装含链接的 skill。',
  source_bad_entry: '来源里有既不是文件也不是文件夹的东西。',
  source_unreadable: '来源里有读不了的文件或文件夹。',
  source_changed: '复制时来源里的文件被改动了，请再试一次。',
  source_contains_shared: '这个文件夹包含共享 skill 文件夹本身，不能装进它自己。',
  missing_skill_md: '最上层没有 SKILL.md，不是一个 skill。ZIP 里的 SKILL.md 要在根上，或在唯一的顶层文件夹里。',
  invalid_name: 'skill 没有合法的名字：SKILL.md 里的 name（或文件夹名）只能用字母、数字和 _ . : -，最长 64 个字符。',
  too_many_files: '文件太多（最多 1000 个文件和文件夹）。',
  too_large: '太大了（ZIP 最大 20 MB，解压后合计最多 50 MB）。',
  too_deep: '文件夹层次太深（最多 16 层）。',
  exists: '共享文件夹里已经有同名的 skill。',
  target_is_link: '共享文件夹里同名的是一个链接，orrery 不替换链接，请自己处理。',
  target_not_folder: '共享文件夹里有一个同名的文件（不是文件夹）。',
  existing_has_link: '已安装的那一份里有链接，orrery 不删除含链接的文件夹，请自己处理后再覆盖。',
  existing_too_large: '已安装的那一份太大，没法先检查再替换。',
  busy: '文件正被别的程序占用（可能是某个应用或杀毒软件），请稍后再试。',
  io_error: '复制时出错了。',
  zip_invalid: '这不是一个完整的 ZIP 文件（可能已损坏）。',
  zip_unsupported: '不支持这种 ZIP（分卷、zip64 或特殊的压缩方式）。',
  zip_encrypted: 'ZIP 加了密码，不支持。',
  zip_symlink: 'ZIP 里有链接，不支持。',
  zip_bad_name: 'ZIP 里有不安全的文件名（绝对路径、盘符、..、反斜杠或 Windows 不允许的名字）。',
  zip_duplicate: 'ZIP 里有重名的文件（只差大小写也算）。',
  zip_ratio: 'ZIP 里有压缩比异常高的文件，为安全起见不解压。',
  zip_crc: 'ZIP 里有文件校验不通过（文件已损坏）。',
};

/** One line for a failed install: the refusal's plain text, else the Hub's message, else the HTTP status. */
export function installErrorText(error) {
  const code = error?.data?.code ?? error?.code;
  if (code && Object.hasOwn(REFUSALS, code)) return REFUSALS[code];
  return `安装失败：${error?.data?.error || error?.message || `HTTP ${error?.status ?? '?'}`}`;
}

/** One line for a successful install. */
export function installedText(result) {
  if (!result.replaced) return `已安装 ${result.name}。`;
  return result.oldRemoved === false
    ? `已用新版本覆盖 ${result.name}；旧版本里有删不掉的内容，留在共享文件夹的隐藏文件夹 .orrery-old-… 里。`
    : `已用新版本覆盖 ${result.name}。`;
}

const STATES = { ok: '已读取', missing: '未找到', unreadable: '读不了', invalid: '格式不对', too_large: '文件太大' };
const TRANSPORTS = { stdio: '本机程序', http: 'HTTP', sse: 'SSE', ws: 'WebSocket', unknown: '未知' };

/** The rail: the shared folder first, then each app with its name, icon and how many skills and servers were found. */
export function railItems(report) {
  const shared = { id: 'shared', name: '共享文件夹', icon: null, count: report.shared.skills.length, title: `${report.shared.skills.length} 个 skill` };
  return [shared, ...report.apps.map((a) => {
    const app = harnessApp(a.app);
    const unsupported = a.status === 'unsupported';
    return { id: a.app, name: app.name, icon: app.icon, count: unsupported ? null : a.skills.length + a.mcpServers.length,
      title: unsupported ? '暂不支持' : `${a.skills.length} 个 skill，${a.mcpServers.length} 个 MCP 服务器` };
  })];
}

/** The one sentence under an app's name: what was found, or why nothing is shown. */
export function appSummary(app) {
  if (app.status === 'unsupported') return '暂不支持：orrery 还不知道这个应用把 skill 和 MCP 配置放在哪里，所以这里不显示。';
  if (app.status === 'not_found') return '未找到：这台电脑上没有它的 skill 文件夹和 MCP 配置文件（可能没装，或没用过这些功能）。';
  return '只读。要用某个 skill，可以把它装进共享文件夹；orrery 不改这个应用自己的文件夹。';
}

/**
 * Opens the page. `api(method, path, body)` throws with `status` and `data` on a non-2xx answer; `skillsChanged()`
 * re-reads the `$` list after an install; `uploadZip(file, overwrite)` posts a ZIP's bytes and resolves with the
 * answer (throwing like api).
 */
export function openExtensions({ api, uploadZip, skillsChanged, closed }) {
  let report = null;
  let current = 'shared';
  let busy = false;
  let message = null;   // { tone: 'ok' | 'error', text } shown at the top of the panel until the next action
  const rail = h('div', { class: 'settings-nav', role: 'tablist', 'aria-label': '位置', 'aria-orientation': 'vertical' });
  const panel = h('section', { id: 'ext-panel', class: 'settings-panel ext-panel', role: 'tabpanel', tabindex: '-1' }, emptyState('正在读取…'));
  const panels = h('div', { class: 'settings-panels' }, panel);
  const box = h('dialog', { class: 'settings-dialog extensions-dialog', 'aria-labelledby': 'ext-title' },
    h('div', { class: 'settings-content' },
      h('div', { class: 'settings-head' },
        h('span', { class: 'settings-mark', 'aria-hidden': 'true' }, icon('layers')),
        h('div', { class: 'settings-heading' }, h('h2', { id: 'ext-title' }, '技能与 MCP'),
          h('p', { class: 'muted' }, '各应用的 skill 和 MCP 服务器。skill 只会装进共享文件夹，orrery 不改任何应用自己的文件夹。')),
        h('button', { type: 'button', class: 'icon ext-close', 'aria-label': '关闭', title: '关闭', onclick: () => box.close() }, icon('close'))),
      h('div', { class: 'settings-body' }, rail, panels)));
  box.addEventListener('close', () => { box.remove(); closed?.(); });
  document.body.append(box);
  box.showModal();

  const narrow = globalThis.matchMedia?.('(max-width: 640px)');
  const orient = () => rail.setAttribute('aria-orientation', narrow?.matches ? 'horizontal' : 'vertical');
  orient();
  narrow?.addEventListener?.('change', orient);

  const confirmOverwrite = (name, from) => confirmDialog({ title: `覆盖 ${name}？`,
    message: `共享文件夹里已经有 ${name}。覆盖会用${from ? ` ${from} 里的` : '新的'}这一份替换它，旧的那一份会被删除，不能撤销。所有读共享文件夹的应用都会用到新的这一份。`,
    confirmText: '覆盖', danger: true });
  /**
   * Runs one install (`doIt(overwrite)`). `overwriteOf`: the name already in the shared folder, confirmed first (`from`:
   * the app it comes from). A folder or ZIP whose name turns out to be taken asks then, and runs again with overwrite.
   */
  const install = async (doIt, { overwriteOf = null, from = null } = {}) => {
    if (busy) return;
    if (overwriteOf && !(await confirmOverwrite(overwriteOf, from))) return;
    busy = true;
    message = null;
    drawPanel();
    try {
      let result;
      try {
        result = await doIt(!!overwriteOf);
      } catch (e) {
        const taken = e?.data?.code === 'exists' ? e.data.skill : null;
        if (overwriteOf || !taken) throw e;
        if (!(await confirmOverwrite(taken))) { message = { tone: 'error', text: `没有安装：共享文件夹里已经有 ${taken}。` }; return; }
        result = await doIt(true);
      }
      const installed = { tone: 'ok', text: installedText(result), refreshFailed: false };
      message = installed;
      pathDraft = '';
      pathOpen = false;
      try { await skillsChanged?.(); } catch { installed.refreshFailed = true; }
    } catch (e) {
      message = { tone: 'error', text: installErrorText(e) };
    } finally {
      busy = false;
      await load();
      panel.querySelector('.ext-result')?.focus();   // the outcome, where a keyboard user is taken after the button went away
    }
  };

  let pathOpen = false;
  let pathDraft = '';
  const status = () => message ? h('div', {},
    h('p', { class: message.tone === 'ok' ? 'ext-result ok' : 'ext-result form-error', role: message.tone === 'ok' ? 'status' : 'alert', tabindex: '-1' }, message.text),
    message.refreshFailed ? h('p', { class: 'form-error', role: 'alert' }, 'skill 已安装，但输入框的 $ 列表刷新失败。',
      h('button', { type: 'button', class: 'small', disabled: busy, onclick: async () => {
        if (busy) return;
        const outcome = message;
        busy = true;
        drawPanel();
        try { await skillsChanged?.(); outcome.refreshFailed = false; } catch { /* keep the refresh warning and retry */ }
        finally { busy = false; drawPanel(); panel.querySelector('.ext-result')?.focus(); }
      } }, '重试刷新')) : null) : null;
  const chip = (text, cls = '', title = '') => h('span', { class: `ext-chip${cls ? ` ${cls}` : ''}`, title: title || null }, text);
  const section = (title, count, ...body) => h('section', { class: 'ext-section', 'aria-label': title },
    h('h4', {}, title, count === null ? null : h('span', { class: 'ext-count' }, String(count))), ...body);

  function sharedView() {
    const shared = report.shared;
    if (!shared.configured) return [h('div', { class: 'settings-panel-head' }, h('h3', {}, '共享文件夹')), emptyState('没有设置共享 skill 文件夹。')];
    const pathInput = h('input', { id: 'ext-path', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '例如 D:\\skills\\my-skill',
      'aria-describedby': 'ext-path-hint', disabled: busy });
    pathInput.value = pathDraft;
    pathInput.addEventListener('input', () => { pathDraft = pathInput.value; });
    const pathForm = h('form', { id: 'ext-path-form', class: 'ext-path-form', hidden: !pathOpen, onsubmit: (event) => {
      event.preventDefault();
      const path = pathInput.value.trim();
      if (!path) { pathInput.focus(); return; }
      void install((overwrite) => api('POST', '/api/extensions/skills/install', { fromPath: path, overwrite }));
    } },
      h('label', { for: 'ext-path', class: 'ext-path-label' }, '文件夹的完整路径'),
      h('div', { class: 'ext-path-row' }, pathInput, h('button', { type: 'submit', class: 'small primary', disabled: busy }, '安装'),
        h('button', { type: 'button', class: 'small', disabled: busy, onclick: () => { pathOpen = false; pathForm.hidden = true; folderButton.setAttribute('aria-expanded', 'false'); folderButton.focus(); } }, '取消')),
      h('p', { id: 'ext-path-hint', class: 'muted ext-hint' }, '这个文件夹的最上层要有 SKILL.md。里面不能有链接，最多 1000 个文件、合计 50 MB。'));
    const folderButton = h('button', { type: 'button', class: 'small with-icon', 'aria-expanded': String(pathOpen), 'aria-controls': 'ext-path-form', disabled: busy, onclick: () => {
      pathOpen = pathForm.hidden;
      pathForm.hidden = !pathOpen;
      folderButton.setAttribute('aria-expanded', String(pathOpen));
      if (pathOpen) pathInput.focus();
    } }, icon('folder', 'ico-sm'), '从文件夹安装…');
    const fileInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) void install((overwrite) => uploadZip(file, overwrite));
    });
    const zipButton = h('button', { type: 'button', class: 'small with-icon', disabled: busy, onclick: () => fileInput.click() }, icon('file', 'ico-sm'), '从 ZIP 安装…');
    const rows = shared.skills.map((s) => h('li', { class: 'ext-row' },
      h('div', { class: 'ext-row-main' },
        h('div', { class: 'ext-row-title' }, h('span', { class: 'ext-name' }, s.name),
          s.link ? chip('链接', '', '指向别处的链接；orrery 不跟随链接，所以不显示它的说明') : null),
        s.description ? h('p', { class: 'ext-desc' }, s.description)
          : s.link ? h('p', { class: 'ext-desc' }, '指向别处的链接。orrery 不跟随链接，所以不显示说明。') : null)));
    return [
      h('div', { class: 'settings-panel-head' }, h('h3', {}, '共享文件夹'),
        h('p', { class: 'muted' }, `位置：${shared.label}。输入框里打 $ 列出的就是这里的 skill；orrery 只往这个文件夹里安装。`)),
      status(),
      h('div', { class: 'settings-card ext-install' },
        h('h4', {}, '安装 skill'),
        h('p', { class: 'muted' }, '从你电脑上的文件夹，或一个 ZIP 文件安装。也可以在左边选一个应用，把它的 skill 装进来。不会从网络下载。'),
        h('div', { class: 'ext-actions' }, folderButton, zipButton, fileInput), pathForm),
      section('Skills', shared.skills.length, rows.length ? h('ul', { class: 'ext-list' }, rows) : emptyState('共享文件夹里还没有 skill。', { compact: true })),
    ];
  }

  function appView(app) {
    const meta = harnessApp(app.app);
    const head = h('div', { class: 'settings-panel-head' },
      h('h3', { class: 'ext-app-title' }, meta.icon ? h('img', { class: 'app-icon', src: meta.icon, alt: '' }) : null, meta.name),
      h('p', { class: 'muted' }, appSummary(app)),
      app.locations.length ? h('ul', { class: 'ext-locations' }, app.locations.map((l) =>
        h('li', {}, h('span', { class: 'ext-target' }, l.label), `：${STATES[l.state] ?? l.state}`))) : null);
    if (app.status === 'unsupported') return [head, emptyState('暂不支持这个应用。')];
    const skillRows = app.skills.map((s) => {
      let action = null;
      if (!s.link && !s.inShared) {
        action = h('button', { type: 'button', class: 'small', disabled: busy, 'aria-label': `把 ${s.name} 安装到共享文件夹`,
          onclick: () => install((overwrite) => api('POST', '/api/extensions/skills/install', { fromApp: app.app, skill: s.name, source: s.source, overwrite })) }, '安装到共享文件夹');
      } else if (!s.link) {
        action = h('button', { type: 'button', class: 'small', disabled: busy, 'aria-label': `用 ${meta.name} 的 ${s.name} 覆盖共享文件夹里的那一份`,
          onclick: () => install((overwrite) => api('POST', '/api/extensions/skills/install', { fromApp: app.app, skill: s.name, source: s.source, overwrite }), { overwriteOf: s.name, from: meta.name }) }, '覆盖…');
      }
      return h('li', { class: 'ext-row' },
        h('div', { class: 'ext-row-main' },
          h('div', { class: 'ext-row-title' }, h('span', { class: 'ext-name' }, s.name),
            s.source === 'builtin' ? chip('应用自带', '', '应用自己带的 skill') : null,
            s.link ? chip('链接', '', '指向别处的链接；orrery 不跟随链接，不能从这里安装') : null,
            s.inShared ? chip('已在共享文件夹', 'on') : null),
          s.description ? h('p', { class: 'ext-desc' }, s.description)
            : s.link ? h('p', { class: 'ext-desc' }, '指向别处的链接。orrery 不跟随链接，所以不显示说明，也不能从这里安装。') : null),
        action);
    });
    const serverRows = app.mcpServers.map((m) => h('li', { class: 'ext-row' },
      h('div', { class: 'ext-row-main' },
        h('div', { class: 'ext-row-title' }, h('span', { class: 'ext-name' }, m.name), chip(TRANSPORTS[m.transport] ?? m.transport)),
        h('p', { class: 'ext-desc' }, m.target ? h('span', { class: 'ext-target' }, m.target) : '（没有可显示的目标）', h('span', { class: 'ext-config' }, ` · ${m.config}`)))));
    return [head, status(),
      app.skillsSupported
        ? section('Skills', app.skills.length, skillRows.length ? h('ul', { class: 'ext-list' }, skillRows) : emptyState('没有找到 skill。', { compact: true }))
        : section('Skills', null, emptyState('暂不支持读取这个应用的 skill。', { compact: true })),
      section('MCP 服务器', app.mcpSupported ? app.mcpServers.length : null,
        h('p', { class: 'muted ext-hint' }, '只显示名字、连接方式和程序名或网址的主机；参数、环境变量、请求头和密钥从不读出。'),
        !app.mcpSupported ? emptyState('暂不支持读取这个应用的 MCP 配置。', { compact: true })
          : serverRows.length ? h('ul', { class: 'ext-list' }, serverRows) : emptyState('没有找到 MCP 服务器。', { compact: true })),
    ];
  }

  function drawRail() {
    const items = railItems(report);
    rail.replaceChildren(...items.map((item) => {
      const on = item.id === current;
      return h('button', { type: 'button', role: 'tab', id: `ext-tab-${item.id}`, 'aria-controls': 'ext-panel', 'aria-selected': String(on),
        tabindex: on ? '0' : '-1', title: item.title, 'data-place': item.id },
      item.icon ? h('img', { class: 'app-icon', src: item.icon, alt: '' }) : icon(item.id === 'shared' ? 'project' : 'layers'),
      h('span', { class: 'ext-tab-name' }, item.name),
      item.count === null ? null : h('span', { class: 'ext-count', 'aria-label': item.title }, String(item.count)));
    }));
    const tabs = [...rail.children];
    for (const tab of tabs) {
      tab.addEventListener('click', () => select(tab.dataset.place));
      tab.addEventListener('keydown', (event) => {
        const next = nextTab(tabs, tab, event.key);
        if (!next) return;
        event.preventDefault();
        select(next.dataset.place, true);
      });
    }
  }

  function drawPanel() {
    if (!report) return;
    const app = report.apps.find((a) => a.app === current);
    panel.setAttribute('aria-labelledby', `ext-tab-${current}`);
    panel.replaceChildren(...(app ? appView(app) : sharedView()).filter(Boolean));
  }

  function select(place, focus = false) {
    if (place !== current) message = null;
    current = place;
    drawRail();
    drawPanel();
    panels.scrollTop = 0;
    const tab = rail.querySelector(`[data-place="${CSS.escape(place)}"]`);
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focus) tab?.focus();
  }

  async function load() {
    try {
      report = await api('GET', '/api/extensions');
      if (!box.open) return;
      if (current !== 'shared' && !report.apps.some((a) => a.app === current)) current = 'shared';
      const focused = rail.contains(document.activeElement) ? document.activeElement.dataset.place : null;
      drawRail();
      drawPanel();
      if (focused) rail.querySelector(`[data-place="${CSS.escape(focused)}"]`)?.focus();
    } catch (e) {
      if (box.open) panel.replaceChildren(emptyState(`读取失败：${e.message}`, { action: { label: '重试', onclick: () => load() } }));
    }
  }
  void load();
  return box;
}
