// A text field with the page's own suggestion list (the task form's Git repository and branch). Typing filters, the
// list scrolls, and free text stays allowed. It replaces <datalist>, whose popup cannot scroll a long list there.
// The state and every key's effect are in nextCombo (like ui.js nextJump); combobox() only draws it.
import { h } from './ui.js';

/** At most this many matches are drawn; the status line says how many more there are. */
export const COMBO_LIMIT = 200;
const MAX_HEIGHT = 320;   // px, the list's tallest; it scrolls past that
const GAP = 4;            // px between the field and the list
const MARGIN = 8;         // px the list keeps from the viewport's edges
const ROOM = 200;         // px below the field that is enough to open downwards, even when more fits above

/**
 * Lower case that keeps the length: each code point becomes its lower case only when that is as long (İ, whose lower
 * case is two code units, stays), so an index in the folded text is the same index in the original. The filter and
 * the highlight both use it, so they cannot disagree.
 */
export function fold(text) {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Suggestions as [{ value, label, key }]: strings or { value, label }; `key` is what the filter reads. */
export const comboOptions = (items) => items.map((item) => {
  const { value, label = '' } = typeof item === 'string' ? { value: item } : item;
  return { value, label: label === value ? '' : label, key: fold(`${value}\n${label}`) };
});

/** The options whose value or label contains `query` (any case), at most `limit` of them, and how many matched. */
export function filterCombo(options, query, limit = COMBO_LIMIT) {
  const q = fold(query.trim());
  const hits = q ? options.filter((option) => option.key.includes(q)) : options;
  return { shown: hits.slice(0, limit), total: hits.length };
}

/** `text` split around the first match of `query` (any case): [before, match, after], or null. */
export function matchParts(text, query) {
  const q = fold(query.trim());
  const at = q ? fold(text).indexOf(q) : -1;
  return at < 0 ? null : [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}

/**
 * `gen` counts option loads (an answer for an older load is dropped); `active` is the highlighted row of `shown` or -1.
 * `handled` (the key is the list's: no default, no dialog Esc) and `chosen` (a value to put in the field) are this
 * event's outputs only.
 */
export const COMBO_START = Object.freeze({ options: [], gen: 0, query: '', open: false, active: -1, shown: [], total: 0,
  handled: false, chosen: null });

/** `patch` applied; the list is refiltered when the options or query changed, and an empty list is never open. */
function view(state, patch) {
  const next = { ...state, handled: false, chosen: null, ...patch };
  if ('options' in patch || 'query' in patch) Object.assign(next, filterCombo(next.options, next.query));
  next.open = next.open && next.shown.length > 0;
  if (!next.open || next.active >= next.shown.length) next.active = -1;
  return next;
}

/**
 * Opens on the field's text. Text that is an option: every option, that one highlighted (moved to the top when it is
 * past the drawn rows, so Enter never swaps it for another). Other text: its matches, `from` ('first' | 'last')
 * highlighting an end; text that matches nothing: every option, none highlighted, so Enter keeps the text.
 */
function show(state, value, from) {
  const text = value.trim();
  const exact = state.options.find((option) => option.value === text);
  let next = view(state, { query: exact ? '' : text, open: true });
  const unmatched = !next.open;
  if (unmatched) next = view(state, { query: '', open: true });
  if (!next.open) return next;
  if (exact) {
    if (next.shown.includes(exact)) return { ...next, active: next.shown.indexOf(exact) };
    return { ...next, shown: [exact, ...next.shown.slice(0, COMBO_LIMIT - 1)], active: 0 };
  }
  return { ...next, active: unmatched ? -1 : from === 'first' ? 0 : from === 'last' ? next.shown.length - 1 : -1 };
}

/** While open: ↓/↑ (↑ from no row goes to the last), Home/End move; Enter takes the row (or just closes); Esc closes; Tab closes and moves on. */
function key(state, { key, value = '', composing = false }) {
  if (composing) return view(state, {});   // the key belongs to the input method
  if (!state.open) {
    if ((key === 'ArrowDown' || key === 'ArrowUp') && state.options.length) {
      return { ...show(state, value, key === 'ArrowDown' ? 'first' : 'last'), handled: true };
    }
    return view(state, {});   // Enter submits, Esc closes the dialog, Home/End move the caret
  }
  const last = state.shown.length - 1;
  const move = { ArrowDown: Math.min(last, state.active + 1), ArrowUp: state.active < 0 ? last : Math.max(0, state.active - 1),
    Home: 0, End: last }[key];
  if (move !== undefined) return { ...view(state, { active: move }), handled: true };
  if (key === 'Enter') return { ...view(state, { open: false }), handled: true, chosen: state.shown[state.active]?.value ?? null };
  if (key === 'Escape') return { ...view(state, { open: false }), handled: true };
  if (key === 'Tab') return view(state, { open: false });
  return view(state, {});
}

/**
 * Events: load (forget the options, start a new load), loaded { gen, items }, input { value } (typed), show { value }
 * (a click on the field), toggle { value } (the arrow button), close, pick { index } (a click on a row), key { key, value, composing }.
 */
export function nextCombo(state, event) {
  switch (event.type) {
    case 'load': return view(state, { gen: state.gen + 1, options: [] });
    case 'loaded': return event.gen === state.gen ? view(state, { options: comboOptions(event.items), active: -1 }) : view(state, {});
    case 'input': return view(state, { query: event.value, open: true, active: -1 });
    case 'show': return state.open ? view(state, {}) : show(state, event.value);
    case 'toggle': return state.open ? view(state, { open: false }) : show(state, event.value);
    case 'close': return view(state, { open: false });
    case 'pick': {
      const option = state.shown[event.index];
      return option ? { ...view(state, { open: false }), chosen: option.value } : view(state, {});
    }
    case 'key': return key(state, event);
    default: return state;
  }
}

/** The status line: empty unless the matches were cut. */
export const comboStatus = (state, noun) => state.total > state.shown.length
  ? `${state.total} 个${noun}，显示前 ${state.shown.length} 个，输入可筛选` : '';

let ids = 0;

/**
 * Turns `input` into a combobox with its own list. Put `el` where the input was (outside any <label>: a label would
 * pass clicks on the list to the input). Picking a row sets the value and fires `change`. The list is fixed to the
 * viewport (the dialog's scrolling never clips it), below the field or above it when there is more room there.
 * Page-wide listeners exist only while the list is open; `destroy()` when the dialog closes.
 */
export function combobox(input, { noun, label }) {
  const id = `wb-combo-${++ids}`;
  let state = COMBO_START;
  let drawn = null;
  let active = null;
  let dead = false;
  if (!input.getAttribute('id')) input.setAttribute('id', `${id}-input`);
  const list = h('ul', { id: `${id}-list`, class: 'wb-combo-list', role: 'listbox', 'aria-label': label });
  const status = h('p', { class: 'wb-combo-status', role: 'status', hidden: true });
  const popup = h('div', { class: 'wb-combo-popup', hidden: true }, list, status);
  const toggle = h('button', { type: 'button', class: 'wb-combo-toggle', tabindex: '-1', 'aria-label': `显示${noun}候选`,
    onclick: () => { if (input.disabled) return; dispatch({ type: 'toggle', value: input.value }); input.focus(); } },
  h('span', { class: 'wb-combo-chevron', 'aria-hidden': 'true' }));
  for (const [name, value] of Object.entries({ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
    'aria-controls': list.getAttribute('id'), autocomplete: 'off', spellcheck: 'false' })) input.setAttribute(name, value);

  const outside = (event) => { if (!el.contains(event.target)) dispatch({ type: 'close' }); };
  const follow = (event) => { if (event.target !== list) place(); };
  const listen = (on) => {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', outside, true);
    document[method]('focusin', outside, true);
    document[method]('scroll', follow, true);
    window[method]('resize', follow);
    window.visualViewport?.[method]('resize', follow);
  };

  function place() {
    const field = input.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv?.offsetTop ?? 0;
    const bottom = top + (vv?.height ?? window.innerHeight);
    const right = (vv?.offsetLeft ?? 0) + (vv?.width ?? window.innerWidth);
    const natural = Math.min(MAX_HEIGHT, list.scrollHeight + popup.offsetHeight - list.clientHeight);
    const below = bottom - field.bottom - GAP - MARGIN;
    const above = field.top - top - GAP - MARGIN;
    const down = below >= Math.min(natural, ROOM) || below >= above;
    const height = Math.max(0, Math.min(natural, down ? below : above));
    const width = Math.min(field.width, right - 2 * MARGIN);
    popup.style.maxHeight = `${height}px`;
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(MARGIN, Math.min(field.left, right - width - MARGIN))}px`;
    popup.style.top = `${down ? field.bottom + GAP : field.top - GAP - height}px`;
  }

  function draw(wasOpen) {
    if (state.shown !== drawn) {
      drawn = state.shown;
      active = null;
      list.replaceChildren(...state.shown.map((option, i) => h('li', { id: `${id}-${i}`, class: 'wb-combo-option', role: 'option',
        'aria-selected': 'false', 'data-index': String(i), 'data-value': option.value }, marked(option.value, state.query),
      option.label ? h('span', { class: 'wb-combo-label' }, marked(option.label, state.query)) : null)));
      status.textContent = comboStatus(state, noun);
      status.hidden = !status.textContent;
    }
    const row = state.active >= 0 ? list.children[state.active] : null;
    if (row !== active) {
      active?.setAttribute('aria-selected', 'false');
      row?.setAttribute('aria-selected', 'true');
      active = row;
    }
    input.setAttribute('aria-expanded', String(state.open));
    if (row) input.setAttribute('aria-activedescendant', row.getAttribute('id'));
    else input.removeAttribute('aria-activedescendant');
    popup.hidden = !state.open;
    if (state.open !== wasOpen) listen(state.open);
    if (state.open) {
      place();
      row?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  function dispatch(event) {
    if (dead) return state;
    const wasOpen = state.open;
    state = nextCombo(state, event);
    draw(wasOpen);
    if (state.chosen !== null) {
      input.value = state.chosen;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return state;
  }

  input.addEventListener('input', () => dispatch({ type: 'input', value: input.value }));
  input.addEventListener('click', () => dispatch({ type: 'show', value: input.value }));
  input.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const { handled } = dispatch({ type: 'key', key: event.key, value: input.value, composing: event.isComposing || event.keyCode === 229 });
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  });
  popup.addEventListener('mousedown', (event) => event.preventDefault());   // keep the focus (and the caret) in the field
  list.addEventListener('click', (event) => {
    const row = event.target.closest?.('[role="option"]');
    if (row) dispatch({ type: 'pick', index: Number(row.dataset.index) });
  });
  const el = h('div', { class: 'wb-combo' }, input, toggle, popup);

  return {
    el,
    /** Forgets the options and starts a new load; returns its generation for `loaded`. */
    load: () => dispatch({ type: 'load' }).gen,
    /** Whether `gen` is still the newest load (a newer one, or destroy, makes an answer stale). */
    isCurrent: (gen) => !dead && gen === state.gen,
    loaded: (gen, items) => { dispatch({ type: 'loaded', gen, items }); },
    close: () => { dispatch({ type: 'close' }); },
    destroy: () => { dispatch({ type: 'close' }); dead = true; },
  };
}

/** `text` with the first match of `query` in a <mark>. */
function marked(text, query) {
  const parts = matchParts(text, query);
  return parts ? h('span', {}, parts[0], h('mark', {}, parts[1]), parts[2]) : h('span', {}, text);
}
