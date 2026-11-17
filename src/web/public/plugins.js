// The 插件 section of the settings dialog (docs/plugins.md): one card per plugin, official and third-party in two groups.
// Everything a plugin's manifest says (name, description, details, commands) reaches the page only as text nodes, and
// its icon only as an <img src> the Hub serves; nothing from a plugin is ever parsed as HTML.
import { markdownBlocks } from './markdown.js';
import { confirmDialog, emptyState, h, noticeDialog } from './ui.js';

const RATES = [
  { key: 'perMinute', label: '每分钟上限' },
  { key: 'perHour', label: '每小时上限' },
];
const canMention = (plugin) => plugin.permissions.includes('messages.mention');
const WAKE_WARNING = '开启后，插件点名可能唤醒成员并消耗模型用量。';
// Only the two places the Hub serves icons from (GET /api/plugins builds them); anything else gets the default icon.
const ICON_URL = /^\/(?:official-plugins\/[a-z][a-z0-9-]*\.svg|api\/plugins\/[^/?#]+\/icon)$/;

export function pluginWriteSubmission(plugin, form) {
  const current = plugin.writeSettings;
  const body = {};
  const warnings = [];
  if (canMention(plugin) && form.mentionEnabled !== current.mentionEnabled) {
    body.mentionEnabled = form.mentionEnabled;
    if (form.mentionEnabled) warnings.push(WAKE_WARNING);
  }
  const unlimited = [];
  for (const { key, label } of RATES) {
    const field = form[key];
    const value = field.value.trim();
    const limit = field.unlimited ? null : Number(value);
    if (limit !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1)) {
      return { error: `${label}要填正整数，或勾选“无限”。` };
    }
    if (limit === current[key]) continue;
    body[key] = limit;
    if (limit === null) unlimited.push(label);
  }
  if (unlimited.length) {
    body.confirmUnlimited = true;
    warnings.push(`将${unlimited.join('和')}设为无限后，插件可能刷屏，在未读列表和群聊历史里堆积大量消息。开启唤醒时，还可能消耗更多模型用量。`);
  }
  return { body, confirm: warnings.length ? {
    title: '确认保存插件发言设置？', message: warnings.join('\n\n'), confirmText: '确认保存', danger: true,
  } : null };
}

function pluginWriteForm(plugin, busy, saveWrite) {
  const settings = plugin.writeSettings;
  const disabled = busy || plugin.unavailable;
  const wake = canMention(plugin) ? h('input', {
    type: 'checkbox', role: 'switch', checked: settings.mentionEnabled, disabled,
    'aria-label': `允许${plugin.name}唤醒成员`,
  }) : null;
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const rates = RATES.map(({ key, label }) => {
    const value = h('input', { type: 'number', min: 1, step: 1, value: settings[key] ?? '', disabled: disabled || settings[key] === null });
    const unlimited = h('input', {
      type: 'checkbox', checked: settings[key] === null, disabled, 'aria-label': `${label}设为无限`,
      onchange: (event) => { value.disabled = event.target.checked; },
    });
    const row = h('div', { class: 'limit-form plugin-rate' },
      h('label', {}, label, value), h('label', { class: 'limit-unlimited risk-option', title: '设为无限前会要求确认' }, unlimited, '无限'));
    return { key, value, unlimited, row };
  });
  const save = h('button', { type: 'submit', class: 'small', disabled, 'data-plugin-write': plugin.id }, '保存发言设置');
  const submit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const form = { mentionEnabled: wake?.checked, ...Object.fromEntries(rates.map(({ key, value, unlimited }) =>
      [key, { value: value.value, unlimited: unlimited.checked }])) };
    const submission = pluginWriteSubmission(plugin, form);
    error.textContent = submission.error ?? '';
    error.hidden = !submission.error;
    if (submission.error || !Object.keys(submission.body).length) return;
    save.disabled = true;
    try { await saveWrite(plugin, submission); } finally { save.disabled = false; }
  };
  return h('form', { class: 'plugin-write', novalidate: true, onsubmit: submit },
    h('div', { class: 'plugin-write-heading' }, h('b', {}, '发言设置'),
      wake && settings.mentionEnabled ? h('span', { class: 'plugin-risk' }, '唤醒已开启') : null,
      RATES.filter(({ key }) => settings[key] === null).map(({ label }) => h('span', { class: 'plugin-risk' }, `${label}：无限`))),
    h('p', { class: 'limit-source muted' }, `可发言的群：${plugin.writeClusterIds.length} 个`),
    wake ? h('label', { class: 'plugin-switch risk-option', title: '开启前会要求确认' }, wake, '允许插件唤醒成员') : null,
    h('p', { class: 'limit-source muted' }, wake ? WAKE_WARNING : '此插件只有发言权限，不能唤醒成员。'),
    rates.map(({ row }) => row), error, h('div', {}, save));
}

// ---- details: markdown.js blocks as text nodes. Links stay text (label and address): a plugin's text opens nothing. ----

function inlineNodes(nodes) {
  return nodes.flatMap((n) => {
    if (typeof n === 'string') return n;
    if (n.type === 'code') return h('code', {}, n.text);
    if (n.type === 'link') {
      const label = inlineNodes(n.children);
      const plain = label.every((c) => typeof c === 'string') && label.join('') === n.href;
      return plain ? n.href : [...label, `（${n.href}）`];
    }
    return h(n.type, {}, inlineNodes(n.children));   // strong, em, del
  });
}

function blockNodes(blocks) {
  return blocks.map((b) => {
    switch (b.type) {
      case 'p': return h('p', {}, inlineNodes(b.inlines));
      case 'h': return h('h4', {}, inlineNodes(b.inlines));
      case 'code': return h('pre', {}, h('code', {}, b.text));
      case 'hr': return h('hr');
      case 'quote': return h('blockquote', {}, blockNodes(b.blocks));
      case 'ul': case 'ol': return h(b.type, { start: b.start === 1 ? null : b.start }, b.items.map((item) => h('li', {}, blockNodes(item))));
      case 'table': return h('div', { class: 'md-table' }, h('table', {},
        h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, inlineNodes(c))))),
        h('tbody', {}, b.rows.map((row) => h('tr', {}, row.map((c) => h('td', {}, inlineNodes(c))))))));
      default: return null;
    }
  });
}

/** A plugin's `details` as page elements, every piece of its text a text node. */
export function detailsView(text) {
  return h('div', { class: 'plugin-md' }, blockNodes(markdownBlocks(text)));
}

// ---- the card ----

/** The plugin's picture; the default one (a puzzle piece drawn by settings.css) when there is none. */
function pluginIcon(plugin) {
  if (typeof plugin.iconUrl !== 'string' || !ICON_URL.test(plugin.iconUrl)) return h('span', { class: 'plugin-icon default', 'aria-hidden': 'true' });
  const tile = h('span', { class: 'plugin-icon', 'aria-hidden': 'true' });
  // A file that fails to load (gone since the list was read) falls back to the default picture.
  tile.append(h('img', { src: plugin.iconUrl, alt: '', width: 40, height: 40, decoding: 'async',
    onerror: () => { tile.classList.add('default'); tile.replaceChildren(); } }));
  return tile;
}

/** The one chip that says what this plugin is doing now, and its tone. */
export function pluginState(plugin) {
  if (plugin.unavailable) return { text: '启动时被跳过', tone: 'bad' };
  if (plugin.disabledByEnv) return { text: '由环境变量禁用', tone: 'off' };
  if (plugin.pendingEnabled !== plugin.enabled) return { text: `重启 Hub 后生效：将${plugin.pendingEnabled ? '启用' : '禁用'}`, tone: 'pending' };
  return plugin.enabled ? { text: '已启用', tone: 'on' } : { text: '已停用', tone: 'off' };
}

const chip = (text, tone = '') => h('span', { class: `plugin-chip ${tone}`.trim() }, text);

/** One card for a row of GET /api/plugins' `installed`. The switch shows what the next start will do. */
export function pluginRow(plugin, installed, busy, toggle, saveWrite, expanded = new Set()) {
  const nameOf = (id) => installed.find((p) => p.id === id)?.name ?? id;
  const note = (text, cls = 'limit-source muted') => h('p', { class: cls }, text);
  const external = plugin.origin === 'external';
  const users = installed.filter((p) => p.requires?.includes(plugin.id)).map((p) => p.name ?? p.id);
  const state = pluginState(plugin);
  const runtime = external && !plugin.unavailable && plugin.runtime ? plugin.runtime : null;
  const error = external && plugin.runtime?.error ? `${plugin.runtime.error}${plugin.runtime.errorCode ? ` [${plugin.runtime.errorCode}]` : ''}` : null;
  const detailsId = `plugin-details-${plugin.id}`;
  const open = expanded.has(plugin.id);
  const panel = h('div', { id: detailsId, class: 'plugin-details', hidden: !open },
    plugin.details ? detailsView(plugin.details) : note('这个插件没有写详细说明。'),
    plugin.detailsTruncated ? note('说明超过 4000 字，后面的部分没有显示。') : null,
    external && plugin.commands?.length ? note(`命令：${plugin.commands.map((c) => `${c.title}（${c.id}）`).join('、')}`) : null,
    external && plugin.events?.length ? note(`订阅的事件：${plugin.events.join('、')}`) : null,
    external && plugin.permissions ? note(`已授权：${plugin.permissions.join('、') || '无'}；${plugin.writeSettings ? '读取和订阅范围' : '限定'} ${plugin.clusterIds.length} 个群。独立进程不是安全沙箱。`, 'plugin-trust') : null,
    plugin.writeSettings ? pluginWriteForm(plugin, busy, saveWrite) : null);
  const disclosure = h('button', { type: 'button', class: 'plugin-disclosure small', 'aria-expanded': String(open), 'aria-controls': detailsId,
    'data-plugin-details': plugin.id, onclick: () => {
      const now = !expanded.has(plugin.id);
      if (now) expanded.add(plugin.id); else expanded.delete(plugin.id);
      disclosure.setAttribute('aria-expanded', String(now));
      panel.hidden = !now;
    } }, h('span', {}, '详情'));
  return h('article', { class: `plugin-card ${state.tone}`, 'aria-label': plugin.name },
    h('div', { class: 'plugin-card-head' },
      pluginIcon(plugin),
      h('div', { class: 'plugin-title' },
        h('p', {}, h('b', { class: 'limit-label' }, plugin.name), ' ', h('span', { class: 'muted' }, plugin.version),
          external ? h('span', { class: 'plugin-chip third-party' }, '第三方') : null),
        plugin.description ? h('p', { class: 'muted' }, plugin.description) : null),
      h('label', { class: 'plugin-switch' },
        h('input', {
          type: 'checkbox', role: 'switch', 'aria-label': `启用${plugin.name}`, 'aria-describedby': 'plugin-restart-note', 'data-plugin': plugin.id,
          checked: plugin.pendingEnabled, disabled: busy || plugin.disabledByEnv || plugin.unavailable,
          onchange: (event) => toggle(plugin, event.target.checked),
        }), h('span', {}, '启用'))),
    h('div', { class: 'plugin-chips' },
      chip(state.text, state.tone),
      runtime ? chip(`外部进程：${runtime.state}`, runtime.state === 'ready' ? 'on' : runtime.state === 'failed' ? 'bad' : 'off') : null,
      plugin.requires.length ? chip(`依赖：${plugin.requires.map(nameOf).join('、')}`) : null,
      users.length ? chip(`被依赖：${users.join('、')}`) : null,
      disclosure),
    error ? note(`外部进程错误：${error}`, 'plugin-error') : null,
    plugin.unavailable ? note('修好清单或目录后重启 Hub。') : null,
    plugin.iconError ? note(`图标没有显示：${plugin.iconError}`) : null,
    panel);
}

function pluginGroup(title, hint, cards, empty) {
  return h('section', { class: 'plugin-group', 'aria-label': title },
    h('div', { class: 'plugin-group-head' }, h('h4', {}, title), h('p', { class: 'muted' }, hint)),
    cards.length ? cards : emptyState(empty, { compact: true }));
}

/** `api` is the page's fetch helper, `list` the element to fill. `load()` reads the list again. */
export function createPluginSettings(api, list) {
  let installed = [];
  const expanded = new Set();   // ids whose details are open; kept across redraws
  const draw = (busy) => {
    const card = (plugin) => pluginRow(plugin, installed, busy, toggle, saveWrite, expanded);
    list.replaceChildren(
      pluginGroup('官方插件', '随 orrery 提供，在 Hub 进程里运行。', installed.filter((p) => p.origin !== 'external').map(card), '没有官方插件。'),
      pluginGroup('第三方插件', '你在 external-plugins.json 里登记的独立进程。只运行你信任的代码：独立进程不是安全沙箱。',
        installed.filter((p) => p.origin === 'external').map(card), '还没有第三方插件。登记方法见文档 docs/external-plugins.md。'));
  };

  let latest = 0;   // only the newest request may change the page: a slow older read must not undo a confirmed change

  // On a failure the last good list is drawn again, so a switch the Hub refused flips back.
  async function run(call, title, focusSelector) {
    const mine = ++latest;
    draw(true);
    let error = null;
    let answer = installed;
    try { answer = (await call()).installed; } catch (e) { error = e; }
    if (mine !== latest) return;
    installed = answer;
    draw(false);
    if (focusSelector) list.querySelector(focusSelector)?.focus();
    if (error) await noticeDialog(error.message, title);
  }

  function toggle(plugin, enabled) {
    return run(() => api('PUT', `/api/plugins/${encodeURIComponent(plugin.id)}`, { enabled }), '操作插件失败', `[data-plugin="${plugin.id}"]`);
  }

  async function saveWrite(plugin, { body, confirm }) {
    const selector = `[data-plugin-write="${plugin.id}"]`;
    if (confirm && !(await confirmDialog(confirm))) {
      draw(false);
      list.querySelector(selector)?.focus();
      return;
    }
    await run(() => api('PATCH', `/api/plugins/${encodeURIComponent(plugin.id)}/write-settings`, body), '保存插件发言设置失败', selector);
  }

  return { load: () => run(() => api('GET', '/api/plugins'), '读取插件失败') };
}
