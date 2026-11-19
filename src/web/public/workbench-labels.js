import { t } from "./i18n.js";
// The label library on the page (docs/collaboration.md「标签库」): the grouped label picker of the task form, the grouped
// filter list, and the library manager. The Hub owns every rule; the page only lays the library out and sends label.*.
import { confirmDialog, emptyState, h, icon, noticeDialog } from './ui.js';
import { formDialog } from './workbench-form.js';

export const LABEL_COLORS = 8;
export const labelKey = (name) => String(name ?? '').toLowerCase();
const groupsOf = (library) => (Array.isArray(library?.groups) ? library.groups : []);
const ungroupedOf = (library) => (Array.isArray(library?.ungrouped) ? library.ungrouped : []);
const allLabels = (library) => [...groupsOf(library).flatMap((group) => group.labels ?? []), ...ungroupedOf(library)];

/** name key → { label, group } for every library label; group is null for an ungrouped one. */
export function labelIndex(library) {
  const index = new Map();
  for (const group of groupsOf(library)) for (const label of group.labels ?? []) index.set(labelKey(label.name), { label, group });
  for (const label of ungroupedOf(library)) index.set(labelKey(label.name), { label, group: null });
  return index;
}

/** A label's library colour (0-7), or null: the caller then derives one from the name. */
export const libraryColor = (index, name) => {
  const color = index.get(labelKey(name))?.label.color;
  return Number.isInteger(color) ? color : null;
};

/** Names in library spelling when the library knows them, duplicates (any case) dropped; each name stays whole. */
export function chosenLabels(names, index = new Map()) {
  const out = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string' || !name || out.some((item) => labelKey(item) === labelKey(name))) continue;
    out.push(index.get(labelKey(name))?.label.name ?? name);
  }
  return out;
}

/** What the user typed into the new-label box: the only place a comma separates names. */
export const typedLabels = (text, index = new Map()) =>
  chosenLabels(String(text ?? '').split(/[,，]/).map((raw) => raw.trim()), index);

/**
 * The task form's sections: the groups this cluster uses (required ones marked), then the ungrouped labels, then the
 * chosen labels neither lists (another group's, or from before the library). Archived labels show only when chosen.
 */
export function pickerSections(library, chosen = []) {
  const keys = new Set(chosen.map(labelKey));
  const usable = (labels) => (labels ?? []).filter((label) => !label.archived || keys.has(labelKey(label.name))).map((label) => label.name);
  const sections = groupsOf(library).filter((group) => group.selected)
    .map((group) => ({ id: group.id, title: group.name, required: group.required === true, description: group.description ?? '', labels: usable(group.labels) }));
  const ungrouped = usable(ungroupedOf(library));
  if (ungrouped.length) sections.push({ id: 'ungrouped', title: t("未分组"), required: false, description: '', labels: ungrouped });
  const listed = new Set(sections.flatMap((section) => section.labels.map(labelKey)));
  const rest = chosen.filter((name) => !listed.has(labelKey(name)));
  if (rest.length) sections.push({ id: 'other', title: t("其他"), required: false, description: t("本群没使用的组，或不在标签库里"), labels: rest });
  return sections;
}

/** Required groups this cluster uses that none of the chosen labels covers, each with the labels that would. */
export function missingRequired(library, chosen = []) {
  const keys = new Set(chosen.map(labelKey));
  return groupsOf(library).filter((group) => group.selected && group.required && !(group.labels ?? []).some((label) => keys.has(labelKey(label.name))))
    .map((group) => ({ name: group.name, labels: (group.labels ?? []).filter((label) => !label.archived).map((label) => label.name) }));
}

/** One line for the form: what is still missing. */
export const missingText = (missing) => missing.map((group) => (group.labels.length
  ? t("必选组「{group}」还没选：{labels} 中选一个", { group: group.name, labels: group.labels.join('、') })
  : t("必选组「{name}」还没有标签，请先在标签库里给它加标签", { name: group.name }))).join('；');

/**
 * The filter list: labels in use, under their library group (groups this cluster uses first), then 未分组, then the
 * ones the library does not have. Empty sections are left out.
 */
export function filterSections(names, library) {
  const index = labelIndex(library);
  const groups = [...groupsOf(library)].sort((a, b) => Number(Boolean(b.selected)) - Number(Boolean(a.selected)));
  const order = (group) => new Map((group.labels ?? []).map((label, i) => [labelKey(label.name), i]));
  const sections = groups.map((group) => {
    const at = order(group);
    return { title: group.name, labels: names.filter((name) => index.get(labelKey(name))?.group?.id === group.id)
      .sort((a, b) => at.get(labelKey(a)) - at.get(labelKey(b))) };   // in the group's own order
  });
  sections.push({ title: t("未分组"), labels: names.filter((name) => { const hit = index.get(labelKey(name)); return hit && !hit.group; }) });
  sections.push({ title: t("不在标签库"), labels: names.filter((name) => !index.has(labelKey(name))) });
  return sections.filter((section) => section.labels.length);
}

/** "3 个群的 12 个任务" for a rename or merge confirmation. */
export const impactText = (usage) => (usage?.tasks ? t("{clusters} 个群的 {tasks} 个任务", { clusters: usage.clusters, tasks: usage.tasks }) : t("没有任务"));

/**
 * The task form's label field: clickable labels by group, a box for names the library lacks (they are created when the
 * task is saved), and a live note for required groups. `tone(name)` gives a label's colour class number.
 */
export function labelPicker(library, initial, tone) {
  const index = labelIndex(library);
  // The task's own labels exactly as stored (a comma in one stays, its spelling too), so an edit that does not touch
  // them sends them back unchanged.
  let chosen = (Array.isArray(initial) ? initial : []).filter((name) => typeof name === 'string' && name);
  const body = h('div', { class: 'wb-lp-sections' });
  const note = h('p', { class: 'wb-lp-note', role: 'status', hidden: true });
  const input = h('input', { class: 'wb-lp-input', placeholder: t("输入新标签，逗号分隔；库里没有的会自动创建"), 'aria-label': t("输入新标签"),
    autocomplete: 'off', spellcheck: 'false' });
  const add = () => {
    const typed = typedLabels(input.value, index).filter((name) => !chosen.some((item) => labelKey(item) === labelKey(name)));
    if (typed.length) { chosen = [...chosen, ...typed]; draw(); }
    input.value = '';
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); add(); } });
  input.addEventListener('blur', () => { if (input.value.trim()) add(); });
  const toggle = (name) => {
    chosen = chosen.some((item) => labelKey(item) === labelKey(name)) ? chosen.filter((item) => labelKey(item) !== labelKey(name)) : [...chosen, name];
    draw();
  };
  function draw() {
    const on = new Set(chosen.map(labelKey));
    const sections = pickerSections(library, chosen);
    const missing = new Set(missingRequired(library, chosen).map((group) => group.name));
    body.replaceChildren(...(sections.length ? sections.map((section) => h('div', { class: `wb-lp-group${missing.has(section.title) ? ' wb-lp-missing' : ''}`,
      role: 'group', 'aria-label': section.title },
    h('div', { class: 'wb-lp-head' }, h('span', { class: 'wb-lp-title' }, section.title),
      section.required ? h('span', { class: 'wb-lp-required', title: t("本群每个新任务至少要带这一组的一个标签") }, t("必选")) : null,
      section.description ? h('span', { class: 'wb-lp-desc' }, section.description) : null),
    h('div', { class: 'wb-lp-chips' }, section.labels.length ? section.labels.map((name) => {
      const hit = index.get(labelKey(name));
      return h('button', { type: 'button', class: `wb-tag wb-tone-${tone(name)} wb-lp-chip${hit?.label.archived ? ' wb-lp-archived' : ''}`,
        'aria-pressed': String(on.has(labelKey(name))), title: [hit?.label.description, hit?.label.archived ? t("已归档：去掉后不能再加回") : ''].filter(Boolean).join('\n') || undefined,
        onclick: () => toggle(name) }, h('span', { class: 'wb-lp-tick', 'aria-hidden': 'true' }), name);
    }) : emptyState(t("这一组还没有标签"), { compact: true }))))
      : [emptyState(t("本群还没有使用任何标签组，可以直接输入标签。"), { compact: true })]));
    const problem = missingText(missingRequired(library, chosen));
    note.textContent = problem;
    note.hidden = !problem;
  }
  draw();
  return {
    el: h('div', { class: 'wb-label-picker' }, body, input, note),
    /** The chosen labels; typed text not yet added counts too. */
    value: () => { if (input.value.trim()) add(); return [...chosen]; },
  };
}

/** The cluster-less event the Hub writes after every library change: every open workbench and manager reloads. */
export const isLibrarySignal = (event) => event?.kind === 'collaboration' && !event.clusterId && event.payload?.action === 'label.library';

/**
 * The library manager: every group with its labels, then the ungrouped labels with their use counts. It belongs to no
 * cluster: changes go to POST /api/labels as the user, and a refusal shows in a dialog. `gate(root, draw, hold)` is
 * the workbench's redrawGate. Returns { dialog, reload } (reload: after a library change from anywhere); `onClose`
 * runs once it is closed.
 */
export function openLabelManager({ api, tone, gate, onClose = () => {} }) {
  let library = null;
  let error = null;
  const command = (body) => api('POST', '/api/labels', body);
  const content = h('div', { class: 'wb-lm-content' });
  const dialog = h('dialog', { class: 'wb-label-manager', 'aria-label': t("标签库") },
    h('div', { class: 'wb-lm-shell' }, h('header', { class: 'wb-lm-head' }, h('h2', {}, t("标签库")),
      h('button', { class: 'icon', type: 'button', 'aria-label': t("关闭标签库"), onclick: () => dialog.close() }, icon('close'))), content));
  // A reload must not drop an open 放进组 list or the click being pressed; the gate draws once they are done.
  const redraws = gate(dialog, () => draw(), () => document.activeElement?.tagName === 'SELECT' && dialog.contains(document.activeElement));
  dialog.addEventListener('close', () => { redraws.dispose(); dialog.remove(); onClose(); });
  document.body.append(dialog);
  dialog.showModal();

  let request = 0;
  async function load() {
    const mine = ++request;
    try {
      const next = await api('GET', '/api/labels');
      if (mine !== request) return;
      library = next; error = null;
    } catch (e) { if (mine !== request) return; error = e.message; }
    if (redraws.request()) draw();
  }
  /** Runs one label action; a refusal goes to a notice, the list reloads either way. */
  async function run(body) {
    try { await command(body); } catch (e) { await noticeDialog(e.message, t("没有完成")); }
    await load();
  }
  const labelsOf = () => allLabels(library);
  const groupSelect = (current) => {
    const select = h('select', {}, h('option', { value: '' }, t("未分组")), groupsOf(library).map((group) => h('option', { value: group.id }, group.name)));
    select.value = current ?? '';
    return select;
  };
  const colorSelect = (current) => {
    const select = h('select', {}, h('option', { value: '' }, t("自动（按名字）")),
      Array.from({ length: LABEL_COLORS }, (_, i) => h('option', { value: String(i) }, t("颜色 {color}", { color: i + 1 }))));
    select.value = Number.isInteger(current) ? String(current) : '';
    return select;
  };
  const chip = (label) => h('span', { class: `wb-tag wb-tone-${Number.isInteger(label.color) ? label.color : tone(label.name)}${label.archived ? ' wb-lp-archived' : ''}` },
    h('span', { class: 'wb-role-dot', 'aria-hidden': 'true' }), label.name);

  function groupForm(group = null) {
    const name = h('input', { required: true, maxlength: 20, value: group?.name ?? '' });
    const description = h('textarea', { placeholder: t("这一组是做什么用的（可留空）") });
    description.value = group?.description ?? '';
    const required = h('input', { type: 'checkbox', checked: group?.required === true });
    const fresh = h('input', { type: 'checkbox', checked: group?.newClusterDefault === true });
    formDialog(group ? t("编辑组 · {name}", { name: group.name }) : t("新建组"), [h('label', {}, t("组名（1～20 字）"), name), h('label', {}, t("说明"), description),
      h('label', { class: 'workbench-check' }, required, h('span', {}, t("必选：使用这个组的群，每个新任务至少带它的一个标签"))),
      h('label', { class: 'workbench-check' }, fresh, h('span', {}, t("新群默认使用（只影响以后新建的群）")))], async () => {
      const fields = { name: name.value.trim(), description: description.value.trim(), required: required.checked, newClusterDefault: fresh.checked };
      await command(group ? { action: 'label.group_edit', groupId: group.id, ...fields } : { action: 'label.group_create', ...fields });
      await load();
    });
  }

  function labelForm(label = null, groupId = null) {
    const name = h('input', { required: true, maxlength: 20, value: label?.name ?? '' });
    const group = groupSelect(label ? label.groupId : groupId);
    const color = colorSelect(label?.color);
    const description = h('textarea', { placeholder: t("什么时候用这个标签（可留空）") });
    description.value = label?.description ?? '';
    const archived = h('input', { type: 'checkbox', checked: label?.archived === true });
    formDialog(label ? t("编辑标签 · {name}", { name: label.name }) : t("新建标签"), [h('label', {}, t("名字（1～20 字）"), name), h('label', {}, t("组"), group),
      h('label', {}, t("颜色"), color), h('label', {}, t("说明"), description),
      label ? h('label', { class: 'workbench-check' }, archived, h('span', {}, t("归档：已带着的任务保留，不能再加到任务上"))) : null], async () => {
      const fields = { name: name.value.trim(), groupId: group.value || null, color: color.value === '' ? null : Number(color.value), description: description.value.trim() };
      if (!label) { await command({ action: 'label.create', ...fields }); await load(); return; }
      if (fields.name !== label.name) {
        const target = labelsOf().find((item) => item.id !== label.id && labelKey(item.name) === labelKey(fields.name));
        const ok = await confirmDialog(target
          ? { title: t("改成已有的名字会合并"), message: t("「{source}」会并进「{target}」并从库里消失，{usage}上的「{source}」都会换成「{target}」。", { source: label.name, target: target.name, usage: impactText(label.usage) }), confirmText: t("合并"), danger: true }
          : { title: t("改名会影响所有群"), message: t("{usage}上的「{oldName}」都会改成「{newName}」；各群会记下改了哪些任务。", { usage: impactText(label.usage), oldName: label.name, newName: fields.name }), confirmText: t("改名") });
        if (!ok) throw new Error(t("已取消，没有保存。"));
      }
      await command({ action: 'label.edit', labelId: label.id, ...fields, archived: archived.checked });
      await load();
    });
  }

  function mergeForm(label) {
    const others = labelsOf().filter((item) => item.id !== label.id);
    if (!others.length) { void noticeDialog(t("库里没有别的标签可以合并进去。"), t("不能合并")); return; }
    const target = h('select', {}, others.map((item) => h('option', { value: item.id }, item.name)));
    formDialog(t("合并标签 · {name}", { name: label.name }), [h('p', { class: 'muted' }, t("「{name}」会从库里消失，{impactText}上的它都换成所选的标签。", { name: label.name, impactText: impactText(label.usage) })),
      h('label', {}, t("并进"), target)], async () => {
      const into = others.find((item) => item.id === target.value);
      const ok = await confirmDialog({ title: t("确认合并？"), message: t("把「{source}」并进「{target}」，影响{usage}。", { source: label.name, target: into?.name, usage: impactText(label.usage) }), confirmText: t("合并"), danger: true });
      if (!ok) throw new Error(t("已取消，没有合并。"));
      await command({ action: 'label.merge', labelId: label.id, intoLabelId: target.value });
      await load();
    });
  }

  async function deleteLabel(label) {
    const ok = await confirmDialog({ title: t("删除标签？"), message: t("「{name}」会从标签库里去掉；{usage}", { name: label.name, usage: label.usage?.tasks ? t("{impactText}上的文字保留。", { impactText: impactText(label.usage) }) : t("没有任务用它。") }), confirmText: t("删除"), danger: true });
    if (ok) await run({ action: 'label.delete', labelId: label.id });
  }
  async function deleteGroup(group) {
    const ok = await confirmDialog({ title: t("删除组？"), message: t("「{name}」里的 {count} 个标签会变成未分组，所有群都不再使用这个组。", { name: group.name, count: group.labels.length }), confirmText: t("删除"), danger: true });
    if (ok) await run({ action: 'label.group_delete', groupId: group.id });
  }

  const labelRow = (label) => h('div', { class: 'wb-lm-label' },
    h('span', { class: 'wb-lm-label-main' }, chip(label), label.archived ? h('span', { class: 'wb-lm-badge' }, t("已归档")) : null,
      h('span', { class: 'wb-lm-usage', title: impactText(label.usage) }, t("{count} 个任务", { count: label.usage?.tasks ?? 0 })),
      label.description ? h('span', { class: 'wb-role-description' }, label.description) : null),
    h('span', { class: 'workbench-setting-actions' },
      h('button', { type: 'button', class: 'small', onclick: () => labelForm(label) }, t("编辑")),
      h('button', { type: 'button', class: 'small', onclick: () => mergeForm(label) }, t("合并")),
      h('button', { type: 'button', class: 'small', onclick: () => deleteLabel(label) }, t("删除"))));

  function draw() {
    if (!library) { content.replaceChildren(h('p', { class: error ? 'form-error' : 'muted' }, error ? t("加载失败：{error}", { error }) : t("正在加载…"))); return; }
    const existing = new Set(labelsOf().map((label) => labelKey(label.name)));
    const packs = (library.packs ?? []).map((pack) => {
      const missing = pack.labels.filter((name) => !existing.has(labelKey(name)));
      return h('button', { type: 'button', class: 'small', disabled: !missing.length || undefined,
        title: missing.length ? t("加入：{labels}", { labels: missing.join('、') }) : t("都已在库里"),
        onclick: () => run({ action: 'label.add_pack', pack: pack.id }) }, t("加入预制套装「{name}」", { name: pack.name }));
    });
    content.replaceChildren(
      h('p', { class: 'muted' }, t("所有群共用。改名、合并会改到所有群里带这个标签的任务；成员只能删除自己建的标签和组，你可以删除任何一个。")),
      h('div', { class: 'workbench-actions wb-lm-actions' },
        h('button', { type: 'button', class: 'small primary', onclick: () => groupForm() }, t("新建组")),
        h('button', { type: 'button', class: 'small', onclick: () => labelForm() }, t("新建标签")), ...packs),
      ...groupsOf(library).map((group) => h('section', { class: 'workbench-detail wb-lm-group' },
        h('div', { class: 'wb-lm-group-head' },
          h('h3', {}, group.name, group.required ? h('span', { class: 'wb-lp-required' }, t("必选")) : null,
            group.newClusterDefault ? h('span', { class: 'wb-lm-badge' }, t("新群默认使用")) : null),
          h('span', { class: 'workbench-setting-actions' },
            h('button', { type: 'button', class: 'small', onclick: () => labelForm(null, group.id) }, t("加标签")),
            h('button', { type: 'button', class: 'small', onclick: () => groupForm(group) }, t("编辑组")),
            h('button', { type: 'button', class: 'small', onclick: () => deleteGroup(group) }, t("删除组")))),
        group.description ? h('p', { class: 'wb-role-description' }, group.description) : null,
        group.labels.length ? group.labels.map(labelRow) : emptyState(t("这一组还没有标签"), { compact: true }))),
      h('section', { class: 'workbench-detail wb-lm-group wb-lm-ungrouped' }, h('h3', {}, t("未分组的标签")),
        ungroupedOf(library).length ? ungroupedOf(library).map((label) => h('div', { class: 'wb-lm-ungrouped-row' }, labelRow(label),
          groupsOf(library).length ? h('label', { class: 'wb-lm-move' }, t("放进组 "), h('select', { 'aria-label': t("把「{name}」放进组", { name: label.name }),
            onchange: (event) => { if (event.target.value) void run({ action: 'label.edit', labelId: label.id, groupId: event.target.value }); } },
          h('option', { value: '' }, t("选择…")), groupsOf(library).map((group) => h('option', { value: group.id }, group.name)))) : null))
          : emptyState(t("没有未分组的标签。"), { compact: true })));
  }
  draw();
  void load();
  return { dialog, reload: () => { if (dialog.open) void load(); } };
}
