import { t } from './i18n.js';
// The 插件 section of the settings dialog (docs/plugins.md): one card per plugin, official and third-party in two groups.
// Everything a plugin's manifest says (name, description, details, commands) reaches the page only as text nodes, and
// its icon only as an <img src> the Hub serves; nothing from a plugin is ever parsed as HTML.
import { markdownBlocks } from './markdown.js';
import { confirmDialog, emptyState, h, noticeDialog } from './ui.js';

const RATES = [
  { key: 'perMinute', get label() { return t("每分钟上限"); } },
  { key: 'perHour', get label() { return t("每小时上限"); } },
];
const canMention = (plugin) => plugin.permissions.includes('messages.mention');
const pluginText = (plugin, text) => plugin.origin === 'external' || plugin.origin === 'trusted' ? text : t(text);
const WAKE_WARNING = '开启后，插件点名可能唤醒成员并消耗模型用量。';
const GATE_NOTE = '发言检查（messages.gate）：可以在群员发言前拒绝这条发言（不能修改内容），只在上面的群里生效。每次拒绝都在群聊里留一条记录；插件没有及时回答时，发言照常放行。';
// Only the two places the Hub serves icons from (GET /api/plugins builds them); anything else gets the default icon.
const ICON_URL = /^\/(?:official-plugins\/[a-z][a-z0-9-]*\.svg|api\/plugins\/[^/?#]+\/icon)$/;

export function pluginWriteSubmission(plugin, form) {
  const current = plugin.writeSettings;
  const body = {};
  const warnings = [];
  if (canMention(plugin) && form.mentionEnabled !== current.mentionEnabled) {
    body.mentionEnabled = form.mentionEnabled;
    if (form.mentionEnabled) warnings.push(t(WAKE_WARNING));
  }
  const unlimited = [];
  for (const { key, label } of RATES) {
    const field = form[key];
    const value = field.value.trim();
    const limit = field.unlimited ? null : Number(value);
    if (limit !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1)) {
      return { error: t("{label}要填正整数，或勾选“无限”。", { label: label }) };
    }
    if (limit === current[key]) continue;
    body[key] = limit;
    if (limit === null) unlimited.push(label);
  }
  if (unlimited.length) {
    body.confirmUnlimited = true;
    warnings.push(t("将{value1}设为无限后，插件可能刷屏，在未读列表和群聊历史里堆积大量消息。开启唤醒时，还可能消耗更多模型用量。", { value1: unlimited.join(t("和")) }));
  }
  return { body, confirm: warnings.length ? {
    title: t("确认保存插件发言设置？"), message: warnings.join('\n\n'), confirmText: t("确认保存"), danger: true,
  } : null };
}

function pluginWriteForm(plugin, busy, saveWrite) {
  const settings = plugin.writeSettings;
  const disabled = busy || plugin.unavailable;
  const wake = canMention(plugin) ? h('input', {
    type: 'checkbox', role: 'switch', checked: settings.mentionEnabled, disabled,
    'aria-label': t("允许{name}唤醒成员", { name: pluginText(plugin, plugin.name) }),
  }) : null;
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const rates = RATES.map(({ key, label }) => {
    const value = h('input', { type: 'number', min: 1, step: 1, value: settings[key] ?? '', disabled: disabled || settings[key] === null });
    const unlimited = h('input', {
      type: 'checkbox', checked: settings[key] === null, disabled, 'aria-label': t("{label}设为无限", { label: label }),
      onchange: (event) => { value.disabled = event.target.checked; },
    });
    const row = h('div', { class: 'limit-form plugin-rate' },
      h('label', {}, label, value), h('label', { class: 'limit-unlimited risk-option', title: t("设为无限前会要求确认") }, unlimited, t("无限")));
    return { key, value, unlimited, row };
  });
  const save = h('button', { type: 'submit', class: 'small', disabled, 'data-plugin-write': plugin.id }, t("保存发言设置"));
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
    h('div', { class: 'plugin-write-heading' }, h('b', {}, t("发言设置")),
      wake && settings.mentionEnabled ? h('span', { class: 'plugin-risk' }, t("唤醒已开启")) : null,
      RATES.filter(({ key }) => settings[key] === null).map(({ label }) => h('span', { class: 'plugin-risk' }, t("{label}：无限", { label: label })))),
    h('p', { class: 'limit-source muted' }, t("可发言的群：{length} 个", { length: plugin.writeClusterIds.length })),
    wake ? h('label', { class: 'plugin-switch risk-option', title: t("开启前会要求确认") }, wake, t("允许插件唤醒成员")) : null,
    h('p', { class: 'limit-source muted' }, wake ? t(WAKE_WARNING) : t("此插件只有发言权限，不能唤醒成员。")),
    rates.map(({ row }) => row), error, h('div', {}, save));
}

// ---- events: what a third-party plugin subscribes to and publishes (docs/external-plugins.md「事件订阅」「发布事件」) ----

const WILDCARD_NOTE = '通配符：以后新增的同类事件也会推给它。';

/** Each granted pattern with the types it matches now, and the types the plugin declares it publishes. All text nodes. */
export function pluginEventsView(plugin) {
  const note = (text) => h('p', { class: 'limit-source muted' }, text);
  const patterns = plugin.events ?? [];
  const grants = Array.isArray(plugin.eventGrants) ? plugin.eventGrants : patterns.map((pattern) => ({ pattern, wildcard: false, types: [] }));
  const typeLine = (t) => h('li', {}, h('code', {}, t.type), `：${t.description}`, t.fields ? `（字段：${t.fields}）` : '');
  const subscribed = patterns.length ? h('div', { class: 'plugin-events' }, note(`订阅的事件：${patterns.join('、')}`),
    h('ul', {}, grants.map((g) => (g.wildcard
      ? h('li', {}, h('code', {}, g.pattern), `（${WILDCARD_NOTE}现在有 ${g.types.length} 种）`, g.types.length ? h('ul', {}, g.types.map(typeLine)) : null)
      : g.types.length ? typeLine(g.types[0]) : h('li', {}, h('code', {}, g.pattern), '：现在没有这种事件（所属插件可能已停用或未安装）'))))) : null;
  const publishes = plugin.publishes ?? [];
  const published = publishes.length ? h('div', { class: 'plugin-events' },
    note(plugin.permissions?.includes('events.publish') ? '发布的事件（给其他插件订阅）：' : '清单声明了下面这些事件，但没有授予 events.publish，不能发布：'),
    h('ul', {}, publishes.map((t) => h('li', {}, h('code', {}, t.type), `：${t.description}`, t.fields ? `（字段：${t.fields}）` : '')))) : null;
  return [subscribed, published];
}

// ---- tools for members (docs/external-plugins.md「群员工具」) ----

const TOOLS_COST_NOTE = '群员工具（tools.provide）：上面这些群的群员可以调用已授予的工具。每个提供的工具的名字、说明和参数都会进入这些群员的工具清单，'
  + '每次模型调用都要为它付 token，所以只授予需要的工具。每次调用都在群聊里留一条记录（只有谁、哪个工具、结果码、用时和大小，不含参数和结果的内容）。';
/** Which clusters' members get the tools: every name (text, wrapping), however many; the card's details are the full scope. */
function toolClustersText(clusters) {
  if (!clusters?.length) return '给群员的工具：现在没有群能用（授权的群都不存在或在回收站里）。';
  return `给群员的工具只在这 ${clusters.length} 个群提供：${clusters.map((c) => `「${c.name}」`).join('、')}。`;
}

/** The tools the manifest declares, by the name members see, which are granted, and where. All text nodes. */
export function pluginToolsView(plugin) {
  const tools = plugin.memberTools ?? [];
  if (!tools.length) return null;
  const note = (text, cls = 'limit-source muted') => h('p', { class: cls }, text);
  const permitted = plugin.permissions?.includes('tools.provide');
  const offered = permitted && tools.some((t) => t.granted);
  return h('div', { class: 'plugin-events', 'data-plugin-tools': plugin.id },
    note(permitted ? '提供给群员的工具（群员看到的名字）：' : '清单声明了下面这些工具，但没有授予 tools.provide，不会提供给群员：'),
    h('ul', {}, tools.map((t) => h('li', {}, h('code', {}, t.name), `：${t.description}`,
      permitted && !t.granted ? '（未授予，不提供）' : ''))),
    offered ? note(toolClustersText(plugin.memberToolClusters), 'plugin-trust') : null,
    permitted ? note(TOOLS_COST_NOTE, 'plugin-trust') : null);
}

// ---- its own web UI (docs/external-plugins.md「网页界面」) ----

const UI_PLACES = { titlebar: '群聊标题栏（一个状态标签和它的面板）', workbench: '任务工作台（一个以插件命名的标签页）',
  marks: '消息、成员和任务上的小标记（由 orrery 画，插件只给文字和状态）' };
const UI_NOTE = '网页界面（ui.show）：插件自己的页面在隔离的框架里显示，外面由 orrery 画一圈写着插件名和“第三方插件”的边框。'
  + '它读不到你的登录、页面内容和 Hub 接口，只能和这个插件自己的进程通信；插件进程本身仍是不受限的本地程序。';
/** Where the manifest asks to show its UI, which places are granted, and in which clusters (its read clusters). */
export function pluginUiView(plugin) {
  const ui = plugin.ui;
  if (!ui) return null;
  const note = (text, cls = 'limit-source muted') => h('p', { class: cls }, text);
  const permitted = plugin.permissions?.includes('ui.show');
  return h('div', { class: 'plugin-events', 'data-plugin-ui-grant': plugin.id },
    note(permitted ? '网页界面显示的位置：' : '清单声明了网页界面，但没有授予 ui.show，不会显示：'),
    h('ul', {}, ui.positions.map((position) => h('li', {}, UI_PLACES[position] ?? position,
      permitted && !ui.granted.includes(position) ? '（未授予，不显示）' : ''))),
    permitted && ui.granted.length ? note(`只在读取范围内的 ${plugin.clusterIds?.length ?? 0} 个群显示。`, 'plugin-trust') : null,
    permitted ? note(UI_NOTE, 'plugin-trust') : null);
}

// ---- details: markdown.js blocks as text nodes. Links stay text (label and address): a plugin's text opens nothing. ----

function inlineNodes(nodes) {
  return nodes.flatMap((n) => {
    if (typeof n === 'string') return n;
    if (n.type === 'code') return h('code', {}, n.text);
    if (n.type === 'link') {
      const label = inlineNodes(n.children);
      const plain = label.every((c) => typeof c === 'string') && label.join('') === n.href;
      return plain ? n.href : [...label, t("（{href}）", { href: n.href })];
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

// ---- a third-party plugin's lifecycle (docs/external-plugins.md「生命周期」): state, start/stop/restart, the two switches ----

/**
 * Whether `incoming` (a plugin-state frame, or a row of a GET /api/plugins answer) is newer than `current`. Both carry
 * `lifecycle: {hub, seq}`: within one Hub run the higher seq wins; a different run (the Hub restarted) always wins. The
 * HTTP answer and the stream travel separately, so whichever arrives last is not necessarily the newest.
 */
export function newerState(current, incoming) {
  const now = current?.lifecycle;
  const next = incoming?.lifecycle;
  if (!next || typeof next.seq !== 'number') return false;
  if (!now || now.hub !== next.hub) return true;
  return next.seq > now.seq;
}

const LIVE_FIELDS = ['enabled', 'runtime', 'lifecycle'];
/** The list with one plugin's state replaced by `frame` when the frame is newer; the same array when nothing changes. */
export function applyStateFrame(installed, frame) {
  const index = installed.findIndex((p) => p.id === frame?.id);
  if (index < 0 || !newerState(installed[index], frame)) return installed;
  const next = [...installed];
  next[index] = { ...installed[index], ...Object.fromEntries(LIVE_FIELDS.map((key) => [key, frame[key]])) };
  return next;
}

/**
 * An answer's rows, each keeping the page's own state only where that is newer from the SAME Hub run (a frame that came
 * after the request was answered). A list from another run (the Hub restarted while the page stayed open) always
 * replaces: the page's copy is from a run that is gone.
 */
export function mergeInstalled(previous, answer) {
  return answer.map((row) => {
    const old = previous.find((p) => p.id === row.id);
    const keep = old?.lifecycle && row.lifecycle && old.lifecycle.hub === row.lifecycle.hub && old.lifecycle.seq > row.lifecycle.seq;
    return keep ? { ...row, ...Object.fromEntries(LIVE_FIELDS.map((key) => [key, old[key]])) } : row;
  });
}

const RUNNING = new Set(['starting', 'ready']);
const time = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch { return iso; } };

/**
 * The buttons a plugin offers in its state: a running one stops or restarts, a stopped or failed one starts (a failed
 * one waiting for its automatic restart can also be stopped, which cancels it), a stopping one waits.
 */
export function lifecycleActions(plugin) {
  const state = plugin.runtime?.state;
  if (plugin.unavailable || !state || state === 'stopping') return [];
  if (RUNNING.has(state)) return ['stop', 'restart'];
  const start = plugin.disabledByEnv ? [] : ['start'];
  return state === 'failed' && plugin.lifecycle?.restartAt ? [...start, 'stop'] : start;
}
const ACTION_LABELS = { start: '启动', stop: '停止', restart: '重启' };

/**
 * The live part of a third-party card: its process state, the error, what the automatic restart is doing, the buttons
 * and the two switches. Redrawn alone when a plugin-state frame arrives, so the rest of the card (an open details panel,
 * a half-typed write setting) stays as it is. All text is the Hub's, and goes in as text nodes.
 */
export function pluginRuntimeView(plugin, busy, act = () => {}) {
  const runtime = plugin.runtime;
  const life = plugin.lifecycle;
  const note = (text, cls = 'limit-source muted') => h('p', { class: cls }, text);
  const error = runtime?.error ? `${runtime.error}${runtime.errorCode ? ` [${runtime.errorCode}]` : ''}` : null;
  const lines = [];
  const within = `${life?.windowMinutes ?? 10} 分钟内`;
  if (life?.restartAt) lines.push(note(`出错停止，将在 ${time(life.restartAt)} 自动重启（${within}第 ${life.autoRestarts + 1} 次，最多 ${life.maxAutoRestarts} 次）。`, 'plugin-error'));
  else if (life?.gaveUp && life.gaveUpReason === 'total') {
    lines.push(note(`自动重启已达累计上限：自你上次启动以来已自动重启 ${life.maxAutoRestartsTotal} 次，不再自动重启；点“启动”再试。`, 'plugin-error'));
  } else if (life?.gaveUp) lines.push(note(`${within}已自动重启 ${life.maxAutoRestarts} 次仍然出错，不再自动重启；点“启动”再试。`, 'plugin-error'));
  else if (life?.autoRestarts) lines.push(note(`${within}已自动重启 ${life.autoRestarts} 次。`));
  if (life?.autoRestart && typeof life.maxAutoRestartsTotal === 'number') {
    lines.push(note(`自动重启累计：已用 ${life.autoRestartsTotal ?? 0} 次，还剩 ${Math.max(0, life.maxAutoRestartsTotal - (life.autoRestartsTotal ?? 0))} 次（共 ${life.maxAutoRestartsTotal} 次，你点启动或重启后重新计算）。`));
  }
  if (life?.lastFailure && runtime?.state !== 'failed') {
    lines.push(note(`上次出错：${time(life.lastFailure.at)} ${life.lastFailure.error ?? ''}${life.lastFailure.errorCode ? ` [${life.lastFailure.errorCode}]` : ''}`));
  }
  if (life?.registrationError) lines.push(note(`重新读取登记失败，插件仍按原来的登记运行：${life.registrationError}`, 'plugin-error'));
  if (life?.reloadPaused) lines.push(note('开发重载已暂停：重启过于频繁。点“启动”或“重启”，或关掉再打开开关后恢复。', 'plugin-error'));
  if (life?.devReloadError) lines.push(note(life.devReloadError, 'plugin-error'));
  const actions = plugin.unavailable ? [] : lifecycleActions(plugin);
  const key = (what) => `${what}:${plugin.id}`;
  const toggles = life && !plugin.unavailable ? [
    ['autoRestart', '出错后自动重启', `出错停止后依次等 ${(life.backoffSeconds ?? []).join('、')} 秒自动重启，${within}最多 ${life.maxAutoRestarts} 次；你点“停止”后不会自动重启。`],
    ['devReload', '开发用：文件改动后自动重启', '监视插件目录（不含 node_modules 和 data），文件改动约半秒后重新读取登记和清单并重启。只在开发插件时打开。'],
    // The UI's master switch, only for a plugin granted a UI position: off closes its open frames at once.
    ...(plugin.ui?.granted?.length && typeof life.ui === 'boolean'
      ? [['ui', '显示网页界面', '关闭后，这个插件在群聊标题栏和任务工作台里的界面立即移除，已打开的界面地址失效。']] : []),
  ].map(([field, label, hint]) => h('label', { class: 'plugin-switch', title: hint },
    h('input', { type: 'checkbox', role: 'switch', checked: Boolean(life[field]), disabled: busy, 'data-key': key(field), 'data-plugin-switch': field,
      'aria-label': `${plugin.name}：${label}`,
      onchange: (event) => act(plugin, { [field]: event.target.checked }) }), h('span', {}, label))) : [];
  return h('div', { class: 'plugin-runtime', 'data-plugin-live': plugin.id },
    runtime && !plugin.unavailable ? h('div', { class: 'plugin-chips' },
      chip(`外部进程：${runtime.state}`, runtime.state === 'ready' ? 'on' : runtime.state === 'failed' ? 'bad' : 'off'),
      life?.shutdownGraceMs ? chip(`停止时最多等 ${life.shutdownGraceMs / 1000} 秒`) : null) : null,
    error ? note(`外部进程错误：${error}`, 'plugin-error') : null,
    lines,
    actions.length || toggles.length ? h('div', { class: 'plugin-actions' },
      actions.map((action) => h('button', { type: 'button', class: 'small', disabled: busy, 'data-key': key(action), 'data-plugin-action': action,
        onclick: () => act(plugin, action) }, ACTION_LABELS[action])),
      toggles) : null);
}

// ---- a full-trust plugin (docs/external-plugins.md「完全信任的插件」): the mark, the confirmation, revoking ----

/** The confirmation dialog's text: what confirming gives the plugin, and the entry file it is bound to. */
export function trustConfirmText(plugin) {
  return {
    title: `完全信任“${plugin.name}”？`,
    message: `确认后，“${plugin.name}”和 orrery 本身拥有相同的权限：它的代码在 Hub 进程里运行，可以读写 Hub 数据库里的全部数据（所有群聊的消息、成员、任务和设置），`
      + '参与投递和 Hub 内部的处理，给群员注册工具、提供自己的接口；它的网页模块（如果有）和 orrery 的页面在同一页里运行，能读写这个页面上的一切。\n\n'
      + '它出错可能让 Hub 停止工作或弄坏页面，改坏的数据不会自动恢复；“用户能看到每个成员收到了什么”、防循环上限这些保护管不到它。只确认你信任作者的插件。\n\n'
      + `入口文件：${plugin.trust.entry}\n这个确认绑定的是这个路径：文件换了位置要重新确认；文件内容和它导入的其他模块以后改了，不会要求重新确认。重启 Hub 后生效。`,
    confirmText: '确认信任', danger: true,
  };
}

/**
 * The trust part of a full-trust card: the mark's meaning, the entry it is bound to, why it did not load, what the
 * next start does, and the confirm / revoke button. Every plugin-supplied string goes in as a text node.
 */
export function pluginTrustView(plugin, busy, setTrust = () => {}) {
  const trust = plugin.trust;
  if (!trust) return null;
  const note = (text, cls = 'limit-source muted') => h('p', { class: cls }, text);
  const off = trust.state === 'loaded' && !plugin.enabled;
  const button = trust.confirmed
    ? h('button', { type: 'button', class: 'small', disabled: busy, 'data-plugin-trust': 'revoke', 'data-key': `trust:${plugin.id}`,
      onclick: () => setTrust(plugin, false) }, '撤销信任')
    : trust.entry && trust.state !== 'failed' ? h('button', { type: 'button', class: 'small danger', disabled: busy, 'data-plugin-trust': 'confirm',
      'data-key': `trust:${plugin.id}`, 'aria-haspopup': 'dialog', onclick: () => setTrust(plugin, true) }, '确认信任…') : null;
  return h('div', { class: 'plugin-runtime', 'data-plugin-trust-view': plugin.id },
    note('完全信任：和 orrery 本身权限相同，在 Hub 进程里运行，不受第三方插件的授权和沙盒限制。', 'plugin-trust'),
    trust.entry ? note(`入口文件：${trust.entry}`) : null,
    trust.error ? note(`跳过的原因：${trust.error}`, 'plugin-error') : null,
    trust.fileError ? note(`现在读不到 plugins.json（${trust.fileError}），这里显示的是 Hub 启动时读到的确认；修好文件后再确认或撤销。`, 'plugin-error') : null,
    trust.state === 'safe-mode' ? note('安全模式（ORRERY_SAFE_MODE=1）：这次启动没有加载任何完全信任插件。') : null,
    trust.state === 'path-changed' ? note('入口文件的路径和你确认时不同，旧的确认不再有效。确认前先核对路径。', 'plugin-error') : null,
    off ? note('功能已关闭：仍会运行它的数据表迁移，以及移出成员、永久删除群聊时清理它的数据；其他部分都不运行。') : null,
    h('div', { class: 'plugin-actions' }, button, h('span', { class: 'muted' }, '确认、撤销和启用开关都在重启 Hub 后生效。')));
}

// ---- the card ----

const PHASES = { service: '创建后台服务', start: '启动后台服务', sweep: '定时检查', close: '关闭后台服务', onQuotaChanged: '额度变化通知',
  onEvent: '协作事件通知', onMemberStatus: '成员状态通知', onClusterPurged: '群永久删除通知', tools: '注册群员工具', eventSource: '声明事件' };
/**
 * The plugin's recorded failures in this Hub run (docs/plugins.md「故障隔离」): which step failed and the error's first
 * line, as text nodes. The Hub and the other plugins kept running; null when there is none.
 */
export function pluginFaultsView(plugin) {
  const faults = Array.isArray(plugin.faults) ? plugin.faults : [];
  if (!faults.length) return null;
  return h('div', { class: 'plugin-faults', 'data-plugin-faults': plugin.id },
    faults.map((f) => h('p', { class: 'plugin-error' }, `${time(f.at)} 插件出错（${PHASES[f.phase] ?? f.phase}，${f.phase}）：${f.error}`)),
    h('p', { class: 'limit-source muted' }, faultsHint(faults)));
}
const faultsHint = (faults) => faults.some((f) => f.phase === 'start' || f.phase === 'service')
  ? '后台服务没有运行，其他功能和其他插件照常；修好后重启 Hub。' : 'Hub 和其他插件照常运行。';

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
  const trust = plugin.trust;
  if (trust) {
    // A full-trust plugin: whether it runs depends on the confirmation first, then on its switch.
    if (trust.state === 'loaded' && !trust.confirmed) return { text: t('重启 Hub 后生效：将不再加载（已撤销信任）'), tone: 'pending' };
    if (trust.state !== 'loaded' && trust.confirmed && trust.state !== 'failed' && trust.state !== 'safe-mode') return { text: t('重启 Hub 后生效：将加载'), tone: 'pending' };
    if (trust.state === 'safe-mode') return { text: t('安全模式：这次没有加载'), tone: 'off' };
    if (trust.state === 'failed') return { text: t('启动时被跳过'), tone: 'bad' };
    if (trust.state === 'path-changed') return { text: t('入口路径变了，需要重新确认'), tone: 'bad' };
    if (trust.state === 'unconfirmed') return { text: t('未确认信任，没有运行'), tone: 'off' };
    if (plugin.pendingEnabled === plugin.enabled && !plugin.enabled && !plugin.disabledByEnv) return { text: t('已停用：只运行迁移和清理'), tone: 'off' };
  }
  if (plugin.unavailable) return { text: t("启动时被跳过"), tone: 'bad' };
  if (plugin.disabledByEnv) return { text: t("由环境变量禁用"), tone: 'off' };
  if (plugin.pendingEnabled !== plugin.enabled) return { text: t("重启 Hub 后生效：将{value1}", { value1: plugin.pendingEnabled ? t("启用") : t("禁用") }), tone: 'pending' };
  return plugin.enabled ? { text: t("已启用"), tone: 'on' } : { text: t("已停用"), tone: 'off' };
}

const chip = (text, tone = '') => h('span', { class: `plugin-chip ${tone}`.trim() }, text);
/** The card's state chip; marked so a plugin-state frame can replace it alone. */
function stateChip(plugin) {
  const state = pluginState(plugin);
  return h('span', { class: `plugin-chip ${state.tone}`.trim(), 'data-plugin-state-chip': plugin.id }, state.text);
}

/**
 * What a third-party plugin's registration grants, as its details show it: commands, events, tools and where they are
 * offered, permissions. One element (data-plugin-grant), so a restart that re-reads the registration can replace it
 * alone; it holds no inputs.
 */
function pluginGrantView(plugin) {
  const note = (text, cls = 'limit-source muted') => h('p', { class: cls }, text);
  return h('div', { 'data-plugin-grant': plugin.id },
    plugin.commands?.length ? note(`命令：${plugin.commands.map((c) => `${c.title}（${c.id}）`).join('、')}`) : null,
    pluginEventsView(plugin),
    pluginToolsView(plugin),
    pluginUiView(plugin),
    plugin.permissions ? note(`已授权：${plugin.permissions.join('、') || '无'}；${plugin.writeSettings ? '读取和订阅范围' : '限定'} ${plugin.clusterIds.length} 个群。独立进程不是安全沙箱。`, 'plugin-trust') : null,
    plugin.permissions?.includes('messages.gate') ? note(GATE_NOTE, 'plugin-trust') : null);
}

/** The chip with the number of granted tools; an empty marker when there are none, so a refresh knows where it goes. */
function toolsChip(plugin) {
  const count = plugin.permissions?.includes('tools.provide') ? (plugin.memberTools ?? []).filter((t) => t.granted).length : 0;
  return count ? h('span', { class: 'plugin-chip', 'data-plugin-tools-chip': plugin.id }, `给群员的工具：${count} 个`)
    : h('span', { 'data-plugin-tools-chip': plugin.id, hidden: true });
}

/**
 * One card for a row of GET /api/plugins' `installed`. The switch shows what the next start will do. A third-party
 * card's live part (pluginRuntimeView) calls `act(plugin, action)` with 'start', 'stop', 'restart' or a switch change
 * `{autoRestart}` / `{devReload}`. `grant` is the last snapshot read for the details and tool count; editable controls use `plugin`.
 */
export function pluginRow(plugin, installed, busy, toggle, saveWrite, expanded = new Set(), act = () => {}, configure, grant = plugin, setTrust) {
  const nameOf = (id) => {
    const dependency = installed.find((p) => p.id === id);
    return dependency ? pluginText(dependency, dependency.name) : id;
  };
  const note = (text, cls = 'limit-source muted') => h('p', { class: cls }, text);
  const external = plugin.origin === 'external';
  const users = installed.filter((p) => p.requires?.includes(plugin.id)).map((p) => p.name ? pluginText(p, p.name) : p.id);
  const state = pluginState(plugin);
  const detailsId = `plugin-details-${plugin.id}`;
  const open = expanded.has(plugin.id);
  const panel = h('div', { id: detailsId, class: 'plugin-details', hidden: !open },
    plugin.details ? detailsView(pluginText(plugin, plugin.details)) : note(t("这个插件没有写详细说明。")),
    plugin.detailsTruncated ? note(t("说明超过 4000 字，后面的部分没有显示。")) : null,
    external ? pluginGrantView(grant) : null,
    plugin.writeSettings ? pluginWriteForm(plugin, busy, saveWrite) : null);
  const disclosure = h('button', { type: 'button', class: 'plugin-disclosure small', 'aria-expanded': String(open), 'aria-controls': detailsId,
    'data-plugin-details': plugin.id, onclick: () => {
      const now = !expanded.has(plugin.id);
      if (now) expanded.add(plugin.id); else expanded.delete(plugin.id);
      disclosure.setAttribute('aria-expanded', String(now));
      panel.hidden = !now;
    } }, h('span', {}, t("详情")));
  return h('article', { class: `plugin-card ${state.tone}`, 'aria-label': pluginText(plugin, plugin.name) },
    h('div', { class: 'plugin-card-head' },
      pluginIcon(plugin),
      h('div', { class: 'plugin-title' },
        h('p', {}, h('b', { class: 'limit-label' }, pluginText(plugin, plugin.name)), ' ', h('span', { class: 'muted' }, plugin.version),
          external ? h('span', { class: 'plugin-chip third-party' }, t("第三方")) : null,
          plugin.trust ? h('span', { class: 'plugin-chip third-party full-trust', 'data-full-trust': plugin.id }, t('完全信任')) : null),
        plugin.description ? h('p', { class: 'muted' }, pluginText(plugin, plugin.description)) : null),
      h('label', { class: 'plugin-switch' },
        h('input', {
          type: 'checkbox', role: 'switch', 'aria-label': t("启用{name}", { name: pluginText(plugin, plugin.name) }), 'aria-describedby': 'plugin-restart-note', 'data-plugin': plugin.id,
          checked: plugin.pendingEnabled, disabled: busy || plugin.disabledByEnv || plugin.unavailable,
          onchange: (event) => toggle(plugin, event.target.checked),
        }), h('span', {}, t("启用")))),
    h('div', { class: 'plugin-chips' },
      stateChip(plugin),
      plugin.requires.length ? chip(t("依赖：{value1}", { value1: plugin.requires.map(nameOf).join(t("、")) })) : null,
      users.length ? chip(t("被依赖：{value1}", { value1: users.join(t("、")) })) : null,
      external ? toolsChip(grant) : null,
      external && plugin.configScopes?.length && configure ? h('button', { type: 'button', class: 'small',
        'data-plugin-config': plugin.id, 'aria-haspopup': 'dialog', disabled: busy,
        onclick: (event) => configure(plugin, event.currentTarget) }, t('配置')) : null,
      disclosure),
    external ? pluginRuntimeView(plugin, busy, act) : null,
    pluginTrustView(plugin, busy, setTrust),
    plugin.trustConflict ? note(t('另一个完全信任插件的登记用了同样的 ID，没有加载：{conflict}', { conflict: plugin.trustConflict }), 'plugin-error') : null,
    external && plugin.eventPublishLimit ? note(t('最近事件发布限流：{at}（每分钟 {limit} 条）', { at: plugin.eventPublishLimit.at, limit: plugin.eventPublishLimit.perMinute }), 'plugin-error') : null,
    plugin.unavailable ? note(t("修好清单或目录后重启 Hub。")) : null,
    pluginFaultsView(plugin),
    plugin.iconError ? note(t("图标没有显示：{iconError}", { iconError: plugin.iconError })) : null,
    panel);
}

function pluginGroup(title, hint, cards, empty) {
  return h('section', { class: 'plugin-group', 'aria-label': title },
    h('div', { class: 'plugin-group-head' }, h('h4', {}, title), h('p', { class: 'muted' }, hint)),
    cards.length ? cards : emptyState(empty, { compact: true }));
}

function skippedRegistrationCard({ index, manifestPath, reason }) {
  const title = index ? `登记项 #${index} 加载失败` : '登记项加载失败';
  return h('article', { class: 'plugin-card bad', 'aria-label': title },
    h('div', { class: 'plugin-title' },
      h('p', {}, h('b', { class: 'limit-label' }, title)),
      manifestPath ? h('p', { class: 'muted' }, manifestPath) : null),
    h('p', { class: 'plugin-error' }, reason),
    h('p', { class: 'limit-source muted' }, '检查 external-plugins.json 和清单，修正后重启 Hub。'));
}

/**
 * `api` is the page's fetch helper, `list` the element to fill. `load()` reads the list again; `applyState(frame)` takes
 * a plugin-state frame from the stream and redraws only that card's live part (when the frame is newer).
 */
export function createPluginSettings(api, list, configure) {
  let installed = [];
  let skippedRegistrations = [];
  let busy = false;
  const expanded = new Set();   // ids whose details are open; kept across redraws
  const cards = new Map();      // id → its card as drawn last
  const early = new Map();      // id → newest frame and last transition to ready before the first list
  const grants = new Map();     // id → last HTTP row used for grant details; a live frame has no grant data
  let request = 0;              // also orders HTTP snapshots taken at the same lifecycle seq
  const draw = (isBusy) => {
    busy = isBusy;
    cards.clear();
    const card = (plugin) => {
      const grant = grants.get(plugin.id)?.row;
      const el = pluginRow(plugin, installed, busy, toggle, saveWrite, expanded, act, configure, grant, setTrust);
      cards.set(plugin.id, el);
      return el;
    };
    list.replaceChildren(
      pluginGroup(t('官方插件'), t('随 orrery 提供，在 Hub 进程里运行。'), installed.filter((p) => p.origin !== 'external' && p.origin !== 'trusted').map(card), t('没有官方插件。')),
      pluginGroup(t('第三方插件'), t('你在 external-plugins.json 里登记的插件：受限插件是独立进程，按授权工作；标着“完全信任”的在 Hub 进程里运行，和 orrery 权限相同。只运行你信任的代码。'),
        [...installed.filter((p) => p.origin === 'external' || p.origin === 'trusted').map(card), ...skippedRegistrations.map(skippedRegistrationCard)],
        t('还没有第三方插件。可以在下方安装。')));
  };

  let latest = 0;   // only the newest request may change the page: a slow older read must not undo a confirmed change

  function rememberGrant(row, order) {
    if (!row.lifecycle) { grants.delete(row.id); return false; }
    const previous = grants.get(row.id);
    const seen = previous?.row.lifecycle;
    if (seen && seen.hub === row.lifecycle.hub
      && (seen.seq > row.lifecycle.seq || (seen.seq === row.lifecycle.seq && previous.order >= order))) return false;
    grants.set(row.id, { row, order });
    return true;
  }

  function updateGrant(row, order) {
    if (!rememberGrant(row, order)) return;
    const card = cards.get(row.id);
    card?.querySelector?.('[data-plugin-grant]')?.replaceWith(pluginGrantView(row));
    card?.querySelector?.('[data-plugin-tools-chip]')?.replaceWith(toolsChip(row));
  }

  // On a failure the last good list is drawn again, so a switch the Hub refused flips back. Any answer's plugin states
  // are kept where they are newer (they are sequenced), even when a newer request owns the rest of the page.
  async function run(call, title, focusSelector) {
    const mine = ++request;
    latest = mine;
    draw(true);
    let error = null;
    let snapshot = null;
    try { snapshot = await call(); } catch (e) { error = e; }
    const answer = snapshot?.installed;
    if (mine !== latest) {
      // This answer can supply a newer grant or state for the same Hub, but never replace the editable settings.
      for (const row of answer ?? []) {
        const now = installed.find((p) => p.id === row.id);
        if (!now?.lifecycle || row.lifecycle?.hub !== now.lifecycle.hub) continue;
        updateGrant(row, mine);
        if (row.lifecycle.seq > now.lifecycle.seq) applyState(row);
      }
      return;
    }
    if (answer) {
      skippedRegistrations = snapshot.skippedRegistrations ?? [];
      installed = mergeInstalled(installed, answer);
      const ids = new Set(answer.map((row) => row.id));
      for (const id of grants.keys()) if (!ids.has(id)) grants.delete(id);
      for (const row of answer) rememberGrant(row, mine);
      // Frames that came before their plugin was listed (the first read still on its way): only one of the list's own
      // Hub run, and newer; a frame of an earlier run (buffered across a Hub restart) is dropped, the list is newer.
      for (const { frame, readySeq } of early.values()) {
        const row = installed.find((p) => p.id === frame.id);
        if (!row?.lifecycle || frame.lifecycle?.hub !== row.lifecycle.hub) continue;
        installed = applyStateFrame(installed, frame);
        if (readySeq !== undefined) void refreshGrant(frame.id, frame.lifecycle.hub, readySeq);
      }
      early.clear();
    }
    draw(false);
    // The first selector that still matches: a button that went away with the new state hands focus to its neighbour.
    for (const selector of [focusSelector ?? []].flat()) {
      const el = list.querySelector(selector);
      if (el) { el.focus(); break; }
    }
    if (error) await noticeDialog(error.message, title);
  }

  /** A newer state for one plugin: its state chip and live part are replaced; focus stays on the same control. */
  function applyState(frame) {
    if (typeof frame?.id !== 'string') return;
    const old = installed.find((p) => p.id === frame.id);
    if (!old) {
      const before = early.get(frame.id);
      if (!newerState(before?.frame, frame)) return;
      const sameRun = before?.frame.lifecycle.hub === frame.lifecycle.hub ? before : undefined;
      const readySeq = frame.runtime?.state === 'ready' && sameRun?.frame.runtime?.state !== 'ready'
        ? frame.lifecycle.seq : sameRun?.readySeq;
      early.set(frame.id, { frame, readySeq });
      return;
    }
    const next = applyStateFrame(installed, frame);
    if (next === installed) return;
    installed = next;
    // A new instance became ready: it runs a registration read again (a changed grant, an upgraded manifest). The frame
    // carries only the state, so the card's grant part is read again from the list.
    if (frame.runtime?.state === 'ready' && (old.runtime?.state !== 'ready' || old.lifecycle?.hub !== frame.lifecycle.hub)) {
      void refreshGrant(frame.id, frame.lifecycle.hub, frame.lifecycle.seq);
    }
    const plugin = installed.find((p) => p.id === frame.id);
    const card = cards.get(frame.id);
    const live = card?.querySelector?.('[data-plugin-live]');
    if (!plugin || !live) return;
    const focused = globalThis.document?.activeElement;
    const key = live.contains?.(focused) ? focused.getAttribute('data-key') : null;
    const fresh = pluginRuntimeView(plugin, busy, act);
    live.replaceWith(fresh);
    card.querySelector('[data-plugin-state-chip]')?.replaceWith(stateChip(plugin));
    card.className = `plugin-card ${pluginState(plugin).tone}`;
    if (key) [...fresh.querySelectorAll('[data-key]')].find((el) => el.getAttribute('data-key') === key)?.focus();
  }

  /**
   * Reads one plugin's row again and replaces only its card's grant part (pluginGrantView) and tools chip: no input,
   * focus, scroll or open details elsewhere is touched. Only the newest request per plugin counts, and only an answer
   * of the same Hub run at least as new as the frame that asked. A full list that has already covered that transition
   * needs no second read. A failed read leaves the card as it was.
   */
  const grantReads = new Map();   // id → the number of its newest read
  async function refreshGrant(id, hub, seq) {
    const seen = grants.get(id)?.row.lifecycle;
    if (seen && seen.hub === hub && seen.seq >= seq) return;
    const mine = ++request;
    grantReads.set(id, mine);
    let row;
    try { row = (await api('GET', '/api/plugins')).installed?.find((p) => p.id === id); } catch { return; }
    const now = installed.find((p) => p.id === id);
    if (grantReads.get(id) !== mine || now?.lifecycle?.hub !== hub || row?.lifecycle?.hub !== hub || row.lifecycle.seq < seq) return;
    updateGrant(row, mine);
  }

  /** A lifecycle button ('start', 'stop', 'restart') or switch ({autoRestart} / {devReload} / {ui}) on a third-party card. */
  function act(plugin, action) {
    const id = encodeURIComponent(plugin.id);
    const key = `${typeof action === 'string' ? action : Object.keys(action)[0]}:${plugin.id}`;
    const focus = [`[data-key="${key}"]`, `[data-plugin-live="${plugin.id}"] [data-plugin-action]`];
    return typeof action === 'string'
      ? run(() => api('POST', `/api/plugins/${id}/${action}`, {}), `${ACTION_LABELS[action]}插件失败`, focus)
      : run(() => api('PATCH', `/api/plugins/${id}/lifecycle`, action), '保存插件设置失败', focus);
  }

  /** Confirm (after the dialog) or revoke trust in a full-trust plugin; effective at the next start. */
  async function setTrust(plugin, trusted) {
    const focus = `[data-key="trust:${plugin.id}"]`;
    if (trusted && !(await confirmDialog(trustConfirmText(plugin)))) { list.querySelector(focus)?.focus(); return; }
    const body = trusted ? { trusted: true, entry: plugin.trust.entry } : { trusted: false };
    return run(() => api('PUT', `/api/plugins/${encodeURIComponent(plugin.id)}/trust`, body), trusted ? '确认信任失败' : '撤销信任失败', focus);
  }

  function toggle(plugin, enabled) {
    return run(() => api('PUT', `/api/plugins/${encodeURIComponent(plugin.id)}`, { enabled }), t("操作插件失败"), `[data-plugin="${plugin.id}"]`);
  }

  async function saveWrite(plugin, { body, confirm }) {
    const selector = `[data-plugin-write="${plugin.id}"]`;
    if (confirm && !(await confirmDialog(confirm))) {
      draw(false);
      list.querySelector(selector)?.focus();
      return;
    }
    await run(() => api('PATCH', `/api/plugins/${encodeURIComponent(plugin.id)}/write-settings`, body), t("保存插件发言设置失败"), selector);
  }

  return { load: () => run(() => api('GET', '/api/plugins'), t('读取插件失败')), applyState };
}
