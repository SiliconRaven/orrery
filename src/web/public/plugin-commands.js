// Plugin commands in the cluster composer (docs/external-plugins.md「命令」): "/" at the start lists the commands of the
// cluster's running plugins; choosing one opens a form from its declared parameters (or runs it), and the run shows as a
// chip in the cluster header and, when it ends, a notice in the corner. Nothing here sends a chat message.
// Untrusted strings (plugin names, titles, result text) only become text nodes.
import { checkArgument, invalidArgument, MAX_TEXT_ARGUMENT, missingArgument } from './command-args.js';
import { attachPicker, h, icon, snippet } from './ui.js';

/** Seconds as the form shows a default: `1h30m`, `15m`, `1m30s`. */
export function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${rest || (!hours && !minutes) ? `${rest}s` : ''}`;
}

/** A command matches the text after "/" by its id, title or plugin name. */
export const commandMatches = (c, query) => !query || [c.id, c.title, c.pluginName].some((s) => String(s).toLowerCase().includes(query));
/** The command whose id or title is exactly the typed query (case-insensitive), or null. */
export const exactCommand = (items, query) => (query ? items.find((c) => c.id.toLowerCase() === query || c.title.toLowerCase() === query) ?? null : null);

/**
 * The "/" menu: only at the very start of the composer (the lead never matches, so `^` alone does). `candidates()` gives
 * the listed commands ({ pluginId, pluginName, id, title, description, params }); `choose(c)` gets the picked one after
 * the "/…" text is removed. Enter runs a command only when the user chose a row (arrow keys or a click) or typed a
 * command's id or title exactly; otherwise Enter sends the text as an ordinary message. Tab picks the highlighted row.
 */
export function attachCommands(input, menu, candidates, choose) {
  return attachPicker(input, menu, {
    trigger: '/', lead: '(?!)', candidates: () => candidates().map((c) => ({ ...c, name: `${c.pluginId}/${c.id}` })), match: commandMatches,
    onPick: choose, enter: exactCommand,
    footer: '用上下键选中或输入完整的命令名，再按 Enter 运行（Tab 运行高亮的一项）；否则 Enter 照常把文字发到群聊。命令本身不会发到群聊。',
    item: (c) => [h('span', { class: 'command-row' }, h('b', { class: 'skill-name' }, c.title), h('span', { class: 'muted' }, c.pluginName)),
      c.description ? h('span', { class: 'muted skill-desc' }, snippet(c.description, 80)) : null],
  });
}

/**
 * The form's raw values ({ name: string | boolean }) checked against the declared params with the Hub's own rules
 * (command-args.js): { values, errors }, values being what to send (empty optional fields left out, so the Hub fills a
 * default) and errors a param name → the sentence shown next to it. `members`: ids of the cluster's current members.
 * Names are read as own properties only (a param may be called `constructor`); both answers are built fresh.
 */
export function readArguments(params, raw, members) {
  const values = [], errors = [];
  for (const p of params) {
    const value = Object.hasOwn(raw, p.name) ? raw[p.name] : undefined;
    if (p.type === 'boolean') { values.push([p.name, value === true]); continue; }
    const text = typeof value === 'string' ? value : '';
    if (!text.trim()) {
      if (p.required && p.default === undefined) errors.push([p.name, missingArgument(p)]);
      continue;
    }
    const checked = checkArgument(p, p.type === 'number' ? Number(text) : text, members);
    if (checked === undefined) errors.push([p.name, invalidArgument(p)]);
    else values.push([p.name, checked]);
  }
  return { values: Object.fromEntries(values), errors: Object.fromEntries(errors) };
}

/**
 * A key in the parameter form. Esc cancels. Enter in a field (with or without Shift, Ctrl, Alt or Meta) never reaches a
 * browser default: plain Enter runs the command, any modified Enter does nothing. While an IME is composing, and on a
 * button (whose own Enter is its click), the key is left alone. Returns what it did, for tests.
 */
export function formKey(e, { submit, cancel }) {
  if (e.isComposing) return 'none';
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return 'cancel'; }
  if (e.key !== 'Enter' || e.target?.tagName === 'BUTTON') return 'none';
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return 'blocked';
  submit();
  return 'submit';
}

/**
 * The form goes into its slot (index.html #command-form-slot): right above the composer, a sibling of the composer's
 * <form>, never inside it, so no key in the command form can submit the chat message.
 */
export function mountCommandForm(slot, el) {
  slot.replaceChildren(el);
  slot.hidden = false;
}
export function unmountCommandForm(slot) {
  slot.replaceChildren();
  slot.hidden = true;
}
/** The chat form's submit goes ahead unless focus is inside an open command form (`formEl`). */
export const chatSubmitAllowed = (formEl, active) => !(formEl && active && (formEl === active || formEl.contains(active)));

let formSerial = 0;
/**
 * The parameter form, built from `command.params`: text and number inputs, a duration input (`15m`), a checkbox, a member
 * or option select. `members`: [{ id, name }] of the cluster. `onRun(values)` resolves when the run was accepted or
 * refused (it shows refusals with showErrors / setError); 取消 and Esc call `onCancel()`.
 */
export function commandForm(command, { members, onRun, onCancel }) {
  const serial = ++formSerial;
  const controls = new Map(), errorEls = new Map();
  const fields = command.params.map((p) => {
    const id = `command-${serial}-${p.name}`;
    const err = h('p', { class: 'form-error', id: `${id}-error`, role: 'alert', hidden: true });
    errorEls.set(p.name, err);
    const hint = p.description ? h('p', { class: 'muted' }, p.description) : null;
    const described = `${id}-error`;
    let control;
    if (p.type === 'boolean') {
      control = h('input', { type: 'checkbox', id, checked: p.default === true, 'aria-describedby': described });
      controls.set(p.name, control);
      return h('div', { class: 'command-field' }, h('label', { class: 'command-check', for: id }, control, p.label), hint, err);
    }
    if (p.type === 'member' || p.type === 'enum') {
      const choices = p.type === 'member' ? members.map((m) => [m.id, m.name]) : p.options.map((o) => [o, o]);
      // With a default there is no empty choice (the Hub would fill the default anyway): the default is preselected
      // and marked. Only a param without one offers 请选择 / （不选）.
      const blank = p.default === undefined ? [h('option', { value: '' }, p.required ? '请选择' : '（不选）')] : [];
      control = h('select', { id, 'aria-describedby': described }, ...blank,
        ...choices.map(([value, label]) => h('option', { value, selected: value === p.default }, value === p.default ? `${label}（默认）` : label)));
    } else {
      const initial = p.default === undefined ? '' : p.type === 'duration' ? formatDuration(p.default) : String(p.default);
      control = h('input', { id, value: initial, 'aria-describedby': described,
        ...(p.type === 'number' ? { type: 'number', inputmode: 'decimal', step: 'any', min: p.min, max: p.max }
          : p.type === 'duration' ? { type: 'text', placeholder: '例如 15m、900s、1h30m', autocomplete: 'off' }
            : { type: 'text', maxlength: MAX_TEXT_ARGUMENT, autocomplete: 'off' }) });
    }
    controls.set(p.name, control);
    return h('div', { class: 'command-field' },
      h('label', { for: id }, p.label, p.required ? h('span', { class: 'muted' }, '（必填）') : null), control, hint, err);
  });
  const general = h('p', { class: 'form-error', role: 'alert', hidden: true });
  // A div with type=button buttons, mounted outside the composer's <form> (app.js); every Enter in a field is handled
  // here, so no browser default (implicit submission of whatever form is around) ever runs from inside it.
  const submit = async () => {
    if (run.disabled) return;
    const raw = Object.fromEntries([...controls].map(([name, c]) => [name, c.type === 'checkbox' ? c.checked : c.value]));
    const { values, errors } = readArguments(command.params, raw, new Set(members.map((m) => m.id)));
    showErrors(errors);
    setError('');
    if (Object.keys(errors).length) return;
    setBusy(true);
    try { await onRun(values); } finally { setBusy(false); }
  };
  const run = h('button', { type: 'button', class: 'primary', onclick: () => submit() }, '运行');
  const cancel = h('button', { type: 'button', onclick: () => onCancel() }, '取消');
  const showErrors = (errors) => {
    let first = null;
    for (const [name, el] of errorEls) {
      const error = Object.hasOwn(errors, name) ? errors[name] : '';
      el.textContent = error;
      el.hidden = !error;
      controls.get(name).setAttribute('aria-invalid', String(Boolean(error)));
      if (error && !first) first = controls.get(name);
    }
    first?.focus?.();
  };
  const setError = (text) => { general.textContent = text ?? ''; general.hidden = !text; };
  const setBusy = (busy) => { run.disabled = busy; run.textContent = busy ? '运行中…' : '运行'; };
  const el = h('div', { class: 'command-form', role: 'dialog', 'aria-label': `运行命令：${command.title}`,
    onkeydown: (e) => formKey(e, { submit, cancel: onCancel }),
  }, h('div', { class: 'command-form-head' }, h('b', {}, command.title), h('span', { class: 'muted' }, command.pluginName)),
  command.description ? h('p', { class: 'muted command-form-desc' }, command.description) : null,
  ...fields, general,
  h('p', { class: 'muted' }, '运行结果只显示在这个页面上，不会发到群聊。'),
  h('div', { class: 'row end' }, cancel, run));
  return { el, submit, showErrors, setError, focus: () => (controls.values().next().value ?? run).focus?.() };
}

// ---- runs: the header chip and the corner notices ----

const ACTIVE = { starting: 1, running: 2, cancelling: 3 };
const ENDED = new Set(['succeeded', 'failed', 'cancelled']);
const STATE_LABEL = { starting: '启动中', running: '运行中', cancelling: '正在取消' };

/** The notice for a run that ended: { kind: 'ok' | 'failed', title, text }. */
export function runNotice(run) {
  if (run.state === 'succeeded') return { kind: 'ok', title: `「${run.title}」已完成`, text: run.text || '命令已完成。' };
  if (run.state === 'cancelled') return { kind: 'ok', title: `「${run.title}」已取消`, text: run.text || '命令已取消。' };
  return { kind: 'failed', title: `「${run.title}」失败`, text: run.text || '命令没有完成。' };
}

/**
 * The page's runs, from the run endpoint's answers, the stream's plugin-run frames and the command listing. Active runs
 * by id; a run that ended becomes one notice (once, whichever source told first) and is never revived by a later, older
 * frame. Notices belong to the cluster of their run: `notices(cid)` shows only that cluster's, and a success notice is
 * dismissed `autoDismissMs` after it was first shown (a failure stays until closed).
 */
export function createCommandState({ autoDismissMs = 6000, setTimer = setTimeout, onChange = () => {} } = {}) {
  const runs = new Map();
  const learned = new Map();   // runId -> the tick at which a run frame or answer last told about it
  const ended = new Set();
  const notices = [];
  let key = 0;
  let tick = 0;
  const push = (clusterId, notice, pluginName) => {
    notices.push({ key: ++key, clusterId, ...notice, pluginName, shown: false, dismissed: false });
    // At most 20 kept: the oldest go, shown or not.
    while (notices.length > 20) notices.shift();
  };
  const state = {
    /** `since`: mark() before a snapshot request; only stream frames have no age bound. Listings aren't newer news. */
    apply(run, fromListing = false, since = Infinity) {
      if (!run || typeof run.runId !== 'string' || ended.has(run.runId)) return;
      if (ENDED.has(run.state)) {
        ended.add(run.runId);
        runs.delete(run.runId);
        learned.delete(run.runId);
        push(run.clusterId, runNotice(run), run.pluginName);
        return;
      }
      const known = runs.get(run.runId);
      // Frames of one run come over two connections (the answer and the stream): never step back to an earlier state.
      if (known && ACTIVE[known.state] > ACTIVE[run.state]) return;
      // A same-state snapshot cannot replace progress heard since its request; a later state still advances.
      if (known?.state === run.state && (learned.get(run.runId) ?? 0) > since) return;
      runs.set(run.runId, run);
      if (!fromListing) learned.set(run.runId, ++tick);
    },
    /** Take before asking for the listing; pass to replace() with its answer. */
    mark: () => tick,
    /**
     * The listing's runs for a cluster (after a load or a reconnect), asked for at `since` (mark()): a run it does not
     * have ended while unseen and goes, unless a frame or answer told about it after the listing was asked for (it
     * started after the Hub read the listing, or its newer frame raced the answer).
     */
    replace(clusterId, list, since = Infinity) {
      for (const [id, run] of runs) {
        if (run.clusterId === clusterId && !list.some((r) => r.runId === id) && (learned.get(id) ?? 0) <= since) { runs.delete(id); learned.delete(id); }
      }
      for (const run of list) if (run.clusterId === clusterId) state.apply(run, true, since);
    },
    active: (clusterId) => [...runs.values()].filter((r) => r.clusterId === clusterId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    /** A notice the page itself makes (a refused run), for that cluster. */
    local(clusterId, kind, title, text) { push(clusterId, { kind, title, text }, ''); },
    notices(clusterId) {
      const list = notices.filter((n) => n.clusterId === clusterId && !n.dismissed);
      for (const n of list) {
        if (n.shown) continue;
        n.shown = true;
        if (n.kind === 'ok') setTimer(() => { state.dismiss(n.key); onChange(); }, autoDismissMs);
      }
      return list;
    },
    dismiss(k) { const n = notices.find((x) => x.key === k); if (n) n.dismissed = true; },
  };
  return state;
}

/**
 * The header chip for this cluster's active runs: `details` (hidden when there are none) holding `summary` (the chip:
 * the newest run's title and progress, +N for more) and `panel` (each run, its progress and a 取消 button).
 */
export function drawRuns({ details, summary, panel }, runs, { onCancel }) {
  details.hidden = !runs.length;
  if (!runs.length) { details.open = false; return; }
  const latest = runs.at(-1);
  const words = `${latest.title}${latest.progress ? ` · ${latest.progress}` : ` · ${STATE_LABEL[latest.state]}`}`;
  summary.replaceChildren(icon('clock', 'ico-xs'), h('span', { class: 'plugin-run-text' }, words), ...(runs.length > 1 ? [h('span', {}, `+${runs.length - 1}`)] : []));
  summary.setAttribute('title', `${runs.length} 个插件命令正在运行：${words}`);
  panel.replaceChildren(...runs.map((run) => h('div', { class: 'plugin-run' },
    h('div', { class: 'plugin-run-head' }, h('b', {}, run.title), h('span', { class: 'muted' }, `${run.pluginName} · ${STATE_LABEL[run.state]}`)),
    run.progress ? h('p', { class: 'plugin-run-progress' }, run.progress) : null,
    typeof run.fraction === 'number' ? h('div', { class: 'plugin-run-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100,
      'aria-valuenow': Math.round(run.fraction * 100), style: `--fraction: ${Math.round(run.fraction * 100)}%` }) : null,
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'small danger', disabled: run.state !== 'running',
      title: run.state === 'starting' ? '命令还在启动，稍后再取消' : null, onclick: () => onCancel(run) },
    run.state === 'cancelling' ? '正在取消…' : '取消')))));
}

/** The corner notices of the shown cluster; each has a close button. */
export function drawNotices(container, notices, onDismiss) {
  container.replaceChildren(...notices.map((n) => h('div', { class: `run-notice ${n.kind}`, role: n.kind === 'failed' ? 'alert' : 'status' },
    icon(n.kind === 'failed' ? 'alert' : 'check'),
    h('b', { class: 'run-notice-title' }, n.title),
    h('button', { type: 'button', class: 'icon', 'aria-label': '关闭通知', title: '关闭', onclick: () => onDismiss(n.key) }, icon('close')),
    n.pluginName ? h('span', { class: 'muted run-notice-plugin' }, n.pluginName) : null,
    h('p', { class: 'run-notice-text' }, n.text))));
}
