// User-facing configuration for external plugins. The card and the cluster menu share this dialog.
import { emptyState, h, icon } from './ui.js';
import { parseDuration } from './command-args.js';
import { formatDuration } from './plugin-commands.js';

const valueUrl = (id, clusterId) => `/api/plugins/${encodeURIComponent(id)}/config${clusterId === null ? '' : `?clusterId=${encodeURIComponent(clusterId)}`}`;
const groupUrl = (id) => `/api/clusters/${encodeURIComponent(id)}/plugin-configs`;
const option = (value, label, selected) => h('option', { value, selected: value === selected }, label);
const labelOf = (field) => field.label ?? field.name;

function fieldControl(field, value, members, clusters) {
  const props = { id: `plugin-config-field-${field.name}`, name: field.name, 'aria-required': String(!!field.required) };
  switch (field.type) {
    case 'boolean':
      // With no default, "not set" and an explicit false are different settings.
      if (typeof field.default === 'boolean') return h('input', { ...props, type: 'checkbox', checked: value === true });
      return h('select', props, ...[['', '未设置'], ['true', '是'], ['false', '否']].map(([v, text]) => option(v, text, value == null ? '' : String(value))));
    case 'enum':
    case 'member': {
      const rows = field.type === 'enum' ? field.options.map((v) => [v, v]) : members.map((m) => {
        const groupName = clusters.find((c) => c.id === m.clusterId)?.name;
        return [m.id, groupName ? `${m.name} · ${groupName}` : m.name];
      });
      return h('select', props, option('', field.required ? '请选择' : '未设置', value ?? ''), ...rows.map(([v, text]) => option(v, text, value)));
    }
    case 'list':
    case 'text':
      return h('textarea', { ...props, rows: field.type === 'list' ? 3 : 1 }, field.type === 'list' ? (value ?? []).join('\n') : value ?? '');
    case 'number':
      return h('input', { ...props, type: 'number', step: 'any', min: field.min, max: field.max, value: value ?? '' });
    case 'duration':
      return h('input', { ...props, type: 'text', value: value == null ? '' : formatDuration(value), placeholder: '例如 15m', autocomplete: 'off' });
    case 'path':
      return h('input', { ...props, type: 'text', value: value ?? '', autocomplete: 'off', spellcheck: 'false' });
  }
}

const fieldHints = { list: '每行一项，按输入顺序保存。', path: '使用本机绝对路径。Hub 只校验格式。' };

/** Read the control as data. Omitted optional values fall back to the declaration on the Hub. */
function configValue(field, control) {
  const raw = control.value;
  if (field.type === 'boolean') return control.type === 'checkbox' ? control.checked : raw === '' ? undefined : raw === 'true';
  if (field.type === 'list') return raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (field.type === 'text') return raw;
  if (field.type === 'number' && control.validity?.badInput) throw new Error('请输入有效数字。');
  if (raw === '') return undefined;
  if (field.type === 'duration') {
    const seconds = parseDuration(raw);
    if (seconds === null) throw new Error('请输入秒数或带单位的时长，例如 15m。');
    return seconds;
  }
  if (field.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error('请输入有效数字。');
    return n;
  }
  return raw;
}

/** Each error is attached to the declaring field; plugin text is never interpreted as markup. */
function configFields(view, onEdit) {
  const controls = new Map();
  const touched = new Set();
  const resets = new Set();
  // An older Hub can serve this script from disk before it restarts.
  const hasSources = !!view.defaults && Array.isArray(view.overriddenFields);
  const overridden = new Set(hasSources ? view.overriddenFields : Object.keys(view.values));
  const names = view.clusterId === null ? view.clusters : [];
  const fields = view.fields.map((field) => {
    const initial = Object.hasOwn(view.values, field.name) ? view.values[field.name] : undefined;
    const control = fieldControl(field, initial, view.members, names);
    const id = control.id;
    const description = [field.description, fieldHints[field.type]].filter(Boolean).join(' ');
    const hint = description ? h('p', { id: `${id}-hint`, class: 'muted' }, description) : null;
    const error = h('p', { id: `${id}-error`, class: 'form-error', 'data-config-error': field.name, hidden: true });
    const status = h('span', { id: `${id}-source`, class: 'muted', 'data-config-source': field.name });
    const hasDefault = hasSources && Object.hasOwn(view.defaults, field.name);
    const resetLabel = hasDefault ? '恢复默认' : '清除设置';
    const fallback = () => {
      const defaultControl = fieldControl(field, hasDefault ? view.defaults[field.name] : undefined, view.members, names);
      if (control.type === 'checkbox') control.checked = defaultControl.checked;
      else control.value = defaultControl.value;
    };
    const reset = h('button', { type: 'button', class: 'small', 'data-config-reset': field.name,
      'aria-label': `${labelOf(field)} · ${resetLabel}`, onclick: () => {
        update(undefined);
        control.focus();
        onEdit();
      } }, resetLabel);
    const showSource = () => {
      if (!hasSources) return;
      const inherited = resets.has(field.name);
      const edited = touched.has(field.name);
      status.textContent = edited && !inherited ? '已修改 · 待保存'
        : !inherited && overridden.has(field.name) ? '已保存自定义'
          : `${hasDefault ? '清单默认' : '未设置'}${edited ? ' · 待保存' : ''}`;
      reset.disabled = inherited || !(edited || overridden.has(field.name));
    };
    const setError = (message) => {
      error.textContent = message ?? '';
      error.hidden = !message;
      control.setAttribute('aria-invalid', String(Boolean(message)));
    };
    control.setAttribute('aria-describedby', [hasSources && status.id, hint?.id, error.id].filter(Boolean).join(' '));
    const rawValue = () => control.type === 'checkbox' ? control.checked : control.value;
    function update(raw) {
      if (raw === undefined) {
        resets.add(field.name);
        fallback();
      } else {
        resets.delete(field.name);
        if (control.type === 'checkbox') control.checked = raw;
        else if (control.value !== raw) control.value = raw;
      }
      touched.add(field.name);
      setError('');
      showSource();
    }
    showSource();
    controls.set(field.name, { control, field, setError, rawValue, update });
    const edit = () => { update(rawValue()); onEdit(); };
    control.addEventListener('input', edit);
    control.addEventListener('change', edit);
    const title = h('label', { for: id }, labelOf(field), field.required ? h('span', { class: 'muted' }, '（必填）') : null);
    const checkbox = control.type === 'checkbox';
    return h('div', { class: `config-field${['text', 'path', 'list'].includes(field.type) || checkbox ? ' config-wide' : ''}` },
      checkbox ? h('div', { class: 'config-check' }, control, title) : [title, control],
      hasSources ? h('div', { class: 'config-source' }, status, reset) : null, hint, error);
  });
  const el = h('div', { class: 'config-fields' }, fields);
  return {
    el, touched,
    errors(messages, focus = false, keepEdits = false) {
      let first;
      for (const [key, item] of controls) {
        const message = Object.hasOwn(messages, key) && !(keepEdits && touched.has(key)) ? messages[key] : '';
        item.setError(message);
        if (message && !first) first = item.control;
      }
      if (focus) first?.focus();
    },
    read() {
      const values = [], errors = [];
      for (const [name, { field, control }] of controls) {
        if (resets.has(name)) continue;
        if (!touched.has(name)) {
          if (overridden.has(name)) values.push([name, view.values[name]]);
          continue;
        }
        try {
          const value = configValue(field, control);
          if (value !== undefined) values.push([name, value]);
        } catch (e) { errors.push([name, e.message]); }
      }
      return { values: Object.fromEntries(values), errors: Object.fromEntries(errors) };
    },
    snapshot() {
      return [...controls].filter(([name]) => touched.has(name)).map(([name, { rawValue }]) =>
        [name, resets.has(name) ? undefined : rawValue()]);
    },
    restore(entries) {
      for (const [name, raw] of entries) controls.get(name)?.update(raw);
    },
  };
}

export function createPluginConfig(api) {
  let active;
  function open(plugin, entryCluster, opener) {
    active?.close();
    let options = plugin ? [plugin] : [];
    let pluginId = plugin?.id;
    let clusterId = entryCluster;
    let view, editor, saving = false, syncPending = false, syncing = false, generation = 0;
    const drafts = new Map();
    const lastGroups = new Map();
    const draftKey = () => JSON.stringify([pluginId, clusterId]);
    const preferredGroup = (data) => {
      const previous = lastGroups.get(data.pluginId) ?? entryCluster;
      return data.clusters.find((group) => group.id === previous)?.id ?? data.clusters[0]?.id;
    };
    const subtitle = h('p', { class: 'muted' }, plugin?.name ?? '');
    const notice = h('p', { class: 'config-notice muted', role: 'status' });
    const tell = (text, error = false) => { notice.textContent = text; notice.classList.toggle('form-error', error); };
    const nav = h('div', { class: 'config-navigation' });
    const inputs = h('div');
    const pane = h('div', { class: 'config-pane' }, nav, inputs);
    const close = h('button', { type: 'button', class: 'icon', 'aria-label': '关闭', onclick: () => dialog.close() }, icon('close'));
    const save = h('button', { type: 'submit', class: 'primary', disabled: true }, '保存');
    const reload = h('button', { type: 'button', class: 'small', hidden: true, onclick: () => {
      drafts.delete(draftKey()); editor = null; void load(pluginId, clusterId);
    } }, '重新载入');
    const form = h('form', { novalidate: true, onsubmit: (event) => { event.preventDefault(); void submit(); } },
      pane, h('div', { class: 'config-footer' }, notice, reload, save));
    const dialog = h('dialog', { id: 'plugin-config-dialog', class: 'plugin-config-dialog', 'aria-labelledby': 'plugin-config-title' },
      h('header', { class: 'workbench-head' }, h('span', { class: 'settings-mark' }, icon('gear')),
        h('div', { class: 'settings-heading' }, h('h2', { id: 'plugin-config-title' }, '插件配置'), subtitle), close), form);
    const alive = () => active?.dialog === dialog && dialog.open;
    dialog.addEventListener('close', () => {
      if (active?.dialog === dialog) {
        active = null;
        const trigger = typeof opener === 'function' ? opener() : opener;
        if (trigger?.isConnected) trigger.focus();
      }
      dialog.remove();
    });
    function conflict() {
      reload.hidden = false;
      save.disabled = true;
      tell('配置已在别处更新。重新载入会替换当前输入。', true);
    }
    function show(data) {
      view = data;
      if (clusterId !== null) lastGroups.set(pluginId, clusterId);
      subtitle.textContent = data.pluginName;
      const scope = (kind, text, target) => h('button', { type: 'button', 'data-config-scope': kind,
        disabled: kind === 'cluster' && !data.clusters.length,
        'aria-pressed': String(kind === (clusterId === null ? 'global' : 'cluster')),
        onclick: () => { if (clusterId !== target) void load(pluginId, target, `[data-config-scope="${kind}"]`); } }, text);
      const picker = (label, attrs, choices, selected, change) => h('label', { class: 'config-pick' },
        h('span', {}, label), h('select', { ...attrs, onchange: (e) => change(e.target.value) },
          choices.map((item) => option(item.id, item.name, selected))));
      nav.replaceChildren(...[
        options.length > 1 ? picker('插件', { 'data-config-plugin': '' }, options, pluginId, (v) => load(v, null, '[data-config-plugin]', true)) : null,
        data.scopes.length > 1 ? h('div', { class: 'view-switch config-scopes', role: 'group', 'aria-label': '配置范围' },
          scope('global', '全局配置', null), scope('cluster', '群配置', preferredGroup(data))) : null,
        clusterId !== null ? picker('群聊', { 'data-config-cluster': '' }, data.clusters, clusterId, (v) => load(pluginId, v, '[data-config-cluster]')) : null,
      ].filter(Boolean));
      if (!data.fields.length) {
        editor = null; save.disabled = true;
        inputs.replaceChildren(emptyState('目前没有可编辑的配置。', { compact: true }));
        tell('');
        return;
      }
      editor = configFields(data, () => { if (reload.hidden) tell('有未保存的修改'); });
      const draft = drafts.get(draftKey());
      if (draft) editor.restore(draft.entries);
      inputs.replaceChildren(editor.el);
      editor.errors(data.errors, false, true);
      save.disabled = false;
      reload.hidden = true;
      if (draft && draft.revision !== view.revision) conflict();
      else tell(draft ? '有未保存的修改' : '');
    }
    async function load(id, group, restoreFocus, preferCluster = false) {
      if (editor?.touched.size) {
        const key = draftKey();
        drafts.set(key, { revision: drafts.get(key)?.revision ?? view.revision, entries: editor.snapshot() });
      }
      const mine = ++generation;
      pluginId = id; clusterId = group;
      view = null; editor = null; saving = false; syncPending = false;
      nav.replaceChildren(); inputs.replaceChildren(); save.disabled = true; reload.hidden = true; tell('正在读取…');
      try {
        const data = await api('GET', valueUrl(id, group));
        if (!alive() || mine !== generation) return;
        if (group === null && data.scopes.includes('cluster') && (preferCluster || !data.scopes.includes('global')) && data.clusters.length) {
          return load(id, preferredGroup(data), restoreFocus);
        }
        show(data);
        if (restoreFocus) nav.querySelector(restoreFocus)?.focus();
        if (syncPending) void refresh();
      } catch (e) { if (alive() && mine === generation) { tell(e.message, true); reload.hidden = false; } }
    }
    async function submit() {
      if (!view || saving || save.disabled) return;
      const { values, errors } = editor.read();
      editor.errors(errors, true);
      if (Object.keys(errors).length) return;
      const mine = generation;
      saving = true; save.disabled = true;
      // A save owns this scope while it is in flight. A closed dialog cannot be redrawn by its reply.
      pane.inert = true;
      tell('正在保存…');
      try {
        const result = await api('PUT', valueUrl(pluginId, clusterId), { revision: view.revision, values });
        if (!alive() || mine !== generation) return;
        drafts.delete(draftKey());
        show(result); tell('已保存');
      } catch (e) {
        if (!alive() || mine !== generation) return;
        pane.inert = false;
        if (e.data?.code === 'CONFIG_CONFLICT') conflict();
        else if (e.data?.field) { editor.errors({ [e.data.field]: e.message }, true); tell('请检查标出的配置项。', true); }
        else tell(e.message, true);
      } finally {
        if (alive() && mine === generation) {
          saving = false; pane.inert = false; save.disabled = !reload.hidden;
          if (syncPending) void refresh();
        }
      }
    }
    async function refresh() {
      syncPending = true;
      if (!view || saving || syncing) return;
      syncPending = false; syncing = true;
      const mine = generation, previous = view;
      try {
        const next = await api('GET', valueUrl(pluginId, clusterId));
        if (!alive() || mine !== generation || previous !== view || saving || next.revision < view.revision) return;
        if (next.revision === view.revision) editor?.errors(next.errors, false, true);
        else if (editor?.touched.size) conflict();
        else show(next);
      } catch (e) { if (alive() && mine === generation && previous === view) tell(e.message, true); }
      finally { syncing = false; if (alive() && syncPending && !saving && view) void refresh(); }
    }
    active = { dialog, close: () => dialog.close(), changed(frame) {
      if (frame && frame.pluginId === pluginId && frame.clusterId === clusterId) void refresh();
    } };
    document.body.append(dialog); dialog.showModal();
    if (plugin) return load(plugin.id, entryCluster);
    tell('正在读取…');
    return api('GET', groupUrl(entryCluster)).then(({ plugins }) => {
      if (!alive()) return;
      options = plugins;
      if (plugins.length) return load(plugins[0].id, entryCluster);
      inputs.replaceChildren(emptyState('这个群没有可配置的插件。', { compact: true })); tell('');
    }).catch((e) => { if (alive()) tell(e.message, true); });
  }
  return {
    openPlugin: (plugin, opener) => open(plugin, null, opener),
    openCluster: (id, opener) => open(null, id, opener),
    changed: (frame) => active?.changed(frame),
  };
}
