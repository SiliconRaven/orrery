// Browser entries: local assets named by the Hub's enabled first-party registry, and the page modules of the enabled
// full-trust plugins that loaded this start, which the Hub serves read-only from their folder (/plugin-web/<id>/).
// A full-trust plugin is one unit in the page: everything it gets through its host (slots, cleanup functions, dialogs)
// is released together (release), when its registration fails or when its trust ends while the page is open
// (detachPluginSlots). Its code itself stays in the page until the page reloads (docs/external-plugins.md「网页模块」).

const ID = /^[a-z][a-z0-9-]*$/;
/** How long a full-trust page module may take to import before the page starts without it. */
const IMPORT_TIMEOUT_MS = 5000;
/** Full-trust plugins released in this page (detached, or failed): never called again, never attached again. */
const released = new Set();
const pendingRelease = new Set();
/** Whether a full-trust plugin is released, or about to be, in this page (its callbacks are no longer called). */
export const isInactive = (id) => released.has(id) || pendingRelease.has(id);
/** Each full-trust plugin's own cleanup functions (host.onDispose), run once when it is released. */
const disposers = new Map();

const warnOf = (label) => (error) => { console.warn(`plugin UI failed in ${label}`, error); };
const isThenable = (value) => typeof value?.then === 'function';
const catchThenable = (value, label) => Promise.resolve(value).catch(warnOf(label));

/**
 * The shapes a full-trust module must hand back (checked before anything of it is attached). `hooks`: methods, the
 * `required` ones present; `data`: plain fields of a given type. Anything else is refused. `register(host)` returns an
 * object with any of the five slots; `message` is an object of hooks, `view` an object checked by checkView, the other
 * three are functions (factories) the host calls; a workbench factory returns a TAB.
 */
const MESSAGE = { required: ['render'], optional: ['key', 'capture', 'restore', 'update'] };
const TAB = { required: ['render', 'load'], optional: ['reset', 'itemRow'], data: { id: 'string', label: 'string' } };
const SLOTS = ['message', 'composer', 'workbench', 'settings', 'view'];
const VIEW_KEYS = ['id', 'title', 'icon', 'mount', 'unmount'];
/** Whether the page's sprite has the icon `i-<name>` (a view names its icon, it never brings its own markup). */
const spriteHas = (name) => globalThis.document?.getElementById(`i-${name}`)?.localName === 'symbol';

function checkShape(what, value, { required, optional, data = {} }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isThenable(value)) throw new Error(`${what} must be an object (not a promise)`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key) && !Object.hasOwn(data, key)) throw new Error(`${what}.${key} is not part of the slot`);
  }
  for (const key of [...required, ...optional]) {
    if ((required.includes(key) || value[key] !== undefined) && typeof value[key] !== 'function') throw new Error(`${what}.${key} must be a function`);
  }
  for (const [key, type] of Object.entries(data)) if (typeof value[key] !== type || !value[key]) throw new Error(`${what}.${key} must be a non-empty ${type}`);
}

/**
 * A full-page view (docs/plugins.md「官方网页插槽」): `id` is the plugin's own id (so one plugin cannot take another's
 * place), `title` plain text or a function returning it, `icon` the name of an icon of the page's sprite, `mount(el, ctx)`
 * and `unmount()`; nothing else, and not a promise.
 */
function checkView(view, id, hasIcon) {
  if (!view || typeof view !== 'object' || Array.isArray(view) || isThenable(view)) throw new Error('view must be an object (not a promise)');
  for (const key of Object.keys(view)) if (!VIEW_KEYS.includes(key)) throw new Error(`view.${key} is not part of the slot`);
  if (view.id !== id) throw new Error(`view.id must be the plugin's id (${id})`);
  if (typeof view.title !== 'function' && (typeof view.title !== 'string' || !view.title.trim())) throw new Error('view.title must be a non-empty string or a function');
  if (typeof view.icon !== 'string' || !ID.test(view.icon) || !hasIcon(view.icon)) throw new Error('view.icon must name an icon of the page (i-<name>)');
  for (const key of ['mount', 'unmount']) if (typeof view[key] !== 'function') throw new Error(`view.${key} must be a function`);
}

/** What register(host) returned, checked as a whole: one bad slot refuses the module. */
function checkHooks(hooks) {
  if (isThenable(hooks)) throw new Error('register(host) must return the slots synchronously, not a promise');
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('register(host) must return an object of slots');
  for (const key of Object.keys(hooks)) if (!SLOTS.includes(key)) throw new Error(`${key} is not a page slot`);
  if (hooks.message !== undefined) checkShape('message', hooks.message, MESSAGE);
  for (const name of ['composer', 'workbench', 'settings']) {
    if (hooks[name] !== undefined && typeof hooks[name] !== 'function') throw new Error(`${name} must be a function`);
  }
}

/**
 * What a full-trust plugin's render slot hands the page, marked with its id so release finds it again: an element
 * itself, anything else (text, a fragment, a list) inside a layout-neutral wrapper. Strings stay text nodes.
 */
function tagged(id, result) {
  if (result === null || result === undefined || result === false || typeof document === 'undefined') return result;   // no page (node tests)
  if (result instanceof Element) {
    trackTypedInput(result, id);
    return result;
  }
  const wrap = document.createElement('span');
  wrap.style.display = 'contents';
  wrap.append(...[result].flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  trackTypedInput(wrap, id);
  return wrap;
}

/**
 * A slot callback that cannot break the page: a throw or a rejected promise is logged. `id` (full-trust plugins only):
 * once released the callback is never called again; `dom`: its result goes into the page and is marked (tagged), and a
 * promise there gives the page nothing.
 */
function protect(label, callback, id = null, dom = false) {
  const warn = warnOf(label);
  return function (...args) {
    if (id !== null && isInactive(id)) return undefined;
    try {
      const result = callback.apply(this, args);
      if (isThenable(result)) {
        const caught = Promise.resolve(result).catch(warn);
        return dom && id !== null ? undefined : caught;
      }
      return dom && id !== null ? tagged(id, result) : result;
    } catch (error) {
      warn(error);
    }
  };
}

function protectMethods(label, owner, methods, id = null, domMethods = []) {
  const hooks = { ...owner };
  for (const name of methods) {
    if (typeof owner[name] === 'function') hooks[name] = protect(`${label}.${name}`, owner[name].bind(owner), id, domMethods.includes(name));
  }
  return hooks;
}

/** One cleanup function of a released plugin: a throw, a rejection or a promise that never settles holds nothing up. */
function runDispose(id, fn) {
  try {
    Promise.resolve(fn()).catch(warnOf(`${id}.dispose`));
  } catch (error) { warnOf(`${id}.dispose`)(error); }
}

const trackedNodes = new WeakSet();
const initialValues = new WeakMap();
const typedValues = new WeakMap();
const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'textarea']);
const controlSelector = 'input, textarea, select';

function draftControl(control) {
  return control?.matches?.(controlSelector) && !control.readOnly && !control.closest('[hidden]')
    && !(control.autocomplete ?? '').split(/\s+/).some((part) => /^(?:current-password|new-password|one-time-code|cc-)/i.test(part))
    && (textTypes.has(control.type) || control.matches('select, input[type=checkbox], input[type=radio]'));
}

function draftControls(node) {
  return [...(node.matches(controlSelector) ? [node] : []), ...node.querySelectorAll(controlSelector)].filter(draftControl);
}

function draftValue(control) {
  if (control.matches('select')) return [...control.selectedOptions].map((option) => option.index).join(',');
  if (control.type === 'checkbox' || control.type === 'radio') return control.checked;
  return control.value;
}

function draftText(control) {
  if (control.matches('select')) return [...control.selectedOptions].map((option) => option.label).join('、') || '未选';
  if (control.type === 'checkbox' || control.type === 'radio') return control.checked ? '已选' : '未选';
  return control.value;
}

export function trackTypedInput(node, id) {
  node.setAttribute('data-plugin-slot', id);
  if (trackedNodes.has(node)) return;
  trackedNodes.add(node);
  const rememberInitial = (control) => {
    if (!initialValues.has(control)) initialValues.set(control, draftValue(control));
  };
  for (const control of draftControls(node)) rememberInitial(control);
  // Controls added after the slot renders first get a baseline on focus.
  for (const name of ['focusin', 'beforeinput']) node.addEventListener(name, (event) => {
    const control = event.target;
    if (event.isTrusted && draftControl(control)) rememberInitial(control);
  }, true);
  node.addEventListener('input', (event) => {
    const control = event.target;
    if (event.isTrusted && draftControl(control)) typedValues.set(control, draftValue(control));
  }, true);
}

/** What the user typed into these elements (each a slot's element) and is still visible there: [label, text] pairs. */
export function typedInput(nodes) {
  const fields = [];
  for (const control of new Set(nodes.flatMap(draftControls))) {
    const value = draftValue(control);
    if (!control.getClientRects().length || getComputedStyle(control).visibility !== 'visible'
      || !typedValues.has(control) || !initialValues.has(control)
      || typedValues.get(control) !== value || initialValues.get(control) === value) continue;
    const content = draftText(control);
    if (!content) continue;
    const label = [...(control.closest('label')?.childNodes ?? [])].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim()
      || control.getAttribute('aria-label') || control.getAttribute('placeholder') || control.name || '内容';
    fields.push([label, content]);
  }
  return fields;
}

/**
 * The host's own notice with what the user typed into a plugin's elements that are being removed: read-only, selectable,
 * a copy and a close button. Not a modal: the page stays usable; while it is open it counts as unsaved (an open dialog).
 */
function keepTypedInput(fields) {
  const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };
  const text = el('textarea', { readOnly: true, rows: Math.min(10, 2 + fields.length * 2), className: 'kept-input-text' });
  text.setAttribute('aria-label', '尚未提交的内容');
  text.value = fields.map(([label, value]) => `${label}：\n${value}`).join('\n\n');
  const copy = el('button', { type: 'button', className: 'small' }, '复制');
  copy.addEventListener('click', async () => {
    text.focus();
    text.select();
    try {
      await navigator.clipboard.writeText(text.value);
      copy.textContent = '已复制';
    } catch {
      if (document.execCommand('copy')) copy.textContent = '已复制';
    }
  });
  const close = el('button', { type: 'button', className: 'small primary' }, '关闭');
  const dialog = el('dialog', { className: 'kept-input' }, el('form', { method: 'dialog' },
    el('h2', {}, '插件已卸下，下面是你还没提交的内容'),
    el('p', { className: 'muted' }, '插件不会再收到它。需要的话先复制，关闭后就没有了。'),
    text, el('div', { className: 'row end' }, copy, close)));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  const focused = document.activeElement;
  document.body.append(dialog);
  dialog.show();
  if (focused !== document.body && focused?.isConnected) focused.focus({ preventScroll: true });
}

/**
 * Releases one full-trust plugin, at once and for good: its slots leave `slots`, every element it rendered through a
 * slot or its host's dialogs is removed (what the user typed into them is kept in the host's own notice), its cleanup
 * functions run once, and its host handles refuse from now on. `slots.onRelease` lets the page follow (workbench tabs,
 * a redraw). Used for a registration that failed and for a detach. Its open full-page view, if any, is closed in between
 * (`slots.closeView`): after what was typed there is read, before the cleanup functions run.
 */
function release(slots, id, root = globalThis.document) {
  if (released.has(id)) return;
  released.add(id);
  pendingRelease.delete(id);
  for (const name of SLOTS) {
    const list = slots[name] ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].pluginId === id) list.splice(i, 1);
  }
  const nodes = [...(root?.querySelectorAll?.(`[data-plugin-slot="${CSS.escape(id)}"]`) ?? [])];
  const fields = nodes.length ? typedInput(nodes) : [];
  slots.closeView?.(id);
  for (const node of nodes) {
    if (node.open && typeof node.close === 'function') node.close();
    node.remove();
  }
  if (fields.length) keepTypedInput(fields);
  const fns = disposers.get(id) ?? [];
  disposers.delete(id);
  for (const fn of fns) runDispose(id, fn);
  slots.onRelease?.([id]);
}

/**
 * The host a full-trust page module's register gets: the shared page helpers (`ui`), `api`, `nameOf`, `command` and
 * `onDispose(fn)` for its own cleanup (timers, listeners). Once the plugin is released, `api`, `command` and the dialog
 * helpers refuse; the dialogs it opened are removed with the rest of what it rendered, and its notice or confirm
 * dialogs still waiting in the page's dialog queue are dropped (`skip`) instead of opening.
 */
function trustedHost(id, host) {
  const refusal = () => new Error(`plugin ${id} was detached from this page; reload the page`);
  const live = (fn) => (...args) => (isInactive(id) ? Promise.reject(refusal()) : fn(...args));
  const ui = host.ui ?? {};
  const own = { tag: id, skip: () => isInactive(id) };
  return Object.freeze({
    ...host,
    api: live(host.api),
    command: live(host.command),
    ui: Object.freeze({
      ...ui,
      noticeDialog: live((message, title) => ui.noticeDialog(message, title, own)),
      confirmDialog: live((options) => ui.confirmDialog({ ...options, ...own })),
      formDialog: (title, fields, submit, setBusy, saveText) => {
        if (isInactive(id)) throw refusal();
        const dialog = ui.formDialog(title, fields,
          () => { if (!isInactive(id)) return submit(); },
          (busy) => { if (!isInactive(id)) setBusy?.(busy); }, saveText);
        if (typeof Element !== 'undefined' && dialog instanceof Element) trackTypedInput(dialog, id);
        return dialog;
      },
    }),
    onDispose(fn) {
      if (typeof fn !== 'function') return;
      if (released.has(id)) runDispose(id, fn);   // registered after the release: cleaned up at once
      else disposers.set(id, [...(disposers.get(id) ?? []), fn]);
    },
  });
}

/**
 * Adds one module's slots; every entry carries its plugin's id (`pluginId`) so release can take it out. `fail` (full-
 * trust only): a factory the host calls later that hands back a promise or a value of the wrong shape releases the whole
 * plugin (after the current call, so the host's own loop over the slots is not disturbed).
 */
function addSlots(slots, id, hooks, own, fail = null, hasIcon = spriteHas) {
  const mark = (entry) => Object.assign(entry, { pluginId: id });
  const view = hooks.view;
  if (isThenable(view)) catchThenable(view, `${id}.view`);   // refused below; its later rejection is only logged
  if (view !== undefined) checkView(view, id, hasIcon);   // before anything of the module is added
  if (hooks.message) slots.message.push(mark(protectMethods(`${id}.message`, hooks.message, ['render', 'key', 'capture', 'restore', 'update'], own, ['render'])));
  for (const name of ['composer', 'settings']) {
    if (!hooks[name]) continue;
    const factory = own === null ? hooks[name] : function (...args) {
      const result = hooks[name].apply(this, args);
      if (isThenable(result)) { catchThenable(result, `${id}.${name}`); fail(new Error(`${name} must return its element synchronously, not a promise`)); return undefined; }
      if (result !== null && result !== undefined && result !== false && typeof result !== 'string' && !(result instanceof Node)) {
        fail(new Error(`${name} must return an element, text or nothing`));
        return undefined;
      }
      return result;
    };
    slots[name].push(mark(protect(`${id}.${name}`, factory, own, true)));
  }
  // The view host (plugin-view.js) calls mount and unmount itself, each in its own guard, and unmount once per opening.
  if (view) slots.view.push(mark({ icon: view.icon, trusted: own !== null,
    title() {
      if (typeof view.title === 'string') return view.title;
      try {
        if (own === null || !isInactive(id)) {
          const text = view.title();
          if (isThenable(text)) catchThenable(text, `${id}.view.title`);   // not a title: the id stands in
          if (typeof text === 'string' && text.trim()) return text;
        }
      } catch (error) { warnOf(`${id}.view.title`)(error); }
      return id;
    },
    mount: (el, ctx) => view.mount(el, ctx),
    unmount: () => view.unmount(),
  }));
  const createTab = hooks.workbench;
  if (createTab) slots.workbench.push(mark(protect(`${id}.workbench`, function (...args) {
    const tab = createTab.apply(this, args);
    if (own === null) return tab && mark(protectMethods(`${id}.workbench`, tab, ['render', 'load', 'reset', 'itemRow']));
    if (isThenable(tab)) catchThenable(tab, `${id}.workbench`);
    try { checkShape('the workbench tab', tab, TAB); } catch (error) { fail(error); return undefined; }
    return mark(protectMethods(`${id}.workbench`, tab, ['render', 'load', 'reset', 'itemRow'], own, ['render', 'itemRow']));
  }, own)));
}

const withTimeout = (promise, what) => {
  let timer;
  return Promise.race([promise, new Promise((_ok, fail) => { timer = setTimeout(() => fail(new Error(`${what} took longer than ${IMPORT_TIMEOUT_MS / 1000} s`)), IMPORT_TIMEOUT_MS); })])
    .finally(() => clearTimeout(timer));
};

/**
 * Loads each listed module and collects its slots. `result` is GET /api/plugins: `frontend` names official modules,
 * `trustedFrontend` the full-trust plugins whose page module may load; either must also be running (`plugins`). A
 * module exports `register(host)` and returns the slots message, composer, workbench, settings and view (checked: SLOTS,
 * MESSAGE, TAB, checkView; `hasIcon` tells the page's icons). A full-trust module that fails to load, register or fit is
 * released as a whole (release). For a later comparison: `tried`, the full-trust plugins this page tried to load, and
 * `trusted`, those attached (registered their slots and not failed since).
 */
export async function loadPluginSlots(result, host, load = (id) => import(`./official-plugins/${id}.js`),
  loadTrusted = (id) => import(`/plugin-web/${id}/`), hasIcon = spriteHas) {
  const slots = { message: [], composer: [], workbench: [], settings: [], view: [], trusted: [], tried: [], onRelease: null, closeView: null };
  const running = new Set(result?.plugins.map((plugin) => plugin.id));
  for (const id of new Set(result?.frontend)) {
    if (typeof id !== 'string' || !ID.test(id) || !running.has(id)) continue;
    try {
      const { register } = await load(id);
      addSlots(slots, id, register(host), null, null, hasIcon);
    } catch (error) {
      console.warn(`plugin UI failed to load: ${id}`, error);
    }
  }
  const trusted = [...new Set(Array.isArray(result?.trustedFrontend) ? result.trustedFrontend : [])]
    .filter((id) => typeof id === 'string' && ID.test(id) && running.has(id));
  // Imported side by side, each within its time limit, so a module that never finishes cannot hold up the page.
  const modules = await Promise.allSettled(trusted.map((id) => withTimeout(Promise.resolve().then(() => loadTrusted(id)), `importing plugin ${id}'s page module`)));
  for (const [i, id] of trusted.entries()) {
    slots.tried.push(id);
    // A factory found wrong later: no longer attached (no notice, nothing to offer), released after the host's call.
    const fail = (error) => {
      if (isInactive(id)) return;
      pendingRelease.add(id);
      console.warn(`plugin UI failed: ${id}`, error);
      const at = slots.trusted.indexOf(id);
      if (at >= 0) slots.trusted.splice(at, 1);
      queueMicrotask(() => release(slots, id));
    };
    try {
      if (modules[i].status === 'rejected') throw modules[i].reason;
      const hooks = modules[i].value.register(trustedHost(id, host));
      if (isThenable(hooks)) catchThenable(hooks, `${id}.register`);
      checkHooks(hooks);
      addSlots(slots, id, hooks, id, fail, hasIcon);
      slots.trusted.push(id);
    } catch (error) {
      console.warn(`plugin UI failed to load: ${id}`, error);
      release(slots, id);   // whatever it took during register: cleanup functions, dialogs, host handles
    }
  }
  return slots;
}

/**
 * Detaches full-trust plugins from this page (their trust ended, they were switched off or not loaded at the Hub's last
 * start): release, for each. A plugin detached here stays detached until the page reloads. The caller redraws, which
 * also rebuilds kept message elements without them.
 */
export function detachPluginSlots(slots, ids, root = globalThis.document) {
  for (const id of ids) release(slots, id, root);
}

/** Whether a full-trust plugin was released in this page. */
const isReleased = (id) => released.has(id);

/**
 * After a Hub restart, from the Hub's GET /api/plugins answer `now` and loadPluginSlots' `slots`: the full-trust
 * plugins attached in this page that are no longer listed (`stale`: detach them), and those listed now that this page
 * never tried or detached earlier (`fresh`: only a reload loads them). A module that failed to load, register or fit
 * here is neither: nothing of it runs through the host, and a reload would only try again.
 */
export function trustedChange({ trusted = [], tried = [] }, now, isOff = isReleased) {
  const listed = [...new Set(Array.isArray(now?.trustedFrontend) ? now.trustedFrontend : [])];
  return { stale: trusted.filter((id) => !isOff(id) && !listed.includes(id)),
    fresh: listed.filter((id) => !tried.includes(id) || (trusted.includes(id) && isOff(id))) };
}

/**
 * Whether the plugin list must be compared after a GET /api/health answer: `seen` is the Hub start (`instance`) whose
 * list the page compared last, from GET /api/plugins when the page loaded. A restart during the page's load is a
 * change too, because the list the page loaded came from the earlier start.
 */
export const hubStartChanged = (seen, health) => health?.app === 'orrery' && typeof health.instance === 'string' && seen !== null && health.instance !== seen;

/** The notice's text: what was detached (by name) and what a reload would load; '' when neither. */
export function trustNoticeText(detachedNames, freshNames) {
  const quote = (names) => names.map((name) => `“${name}”`).join('、');
  const parts = [];
  if (detachedNames.length) {
    const it = detachedNames.length > 1 ? '它们' : '它';
    parts.push(`Hub 重启后不再加载完全信任插件${quote(detachedNames)}（撤销了信任、关掉了、进入安全模式或加载失败）。页面已移除${it}经插件接口加入的内容，`
      + `不再调用${it}；${it}的代码还留在这个页面里，刷新页面后彻底生效。`);
  }
  if (freshNames.length) parts.push(`完全信任插件${quote(freshNames)}现在可以加载，刷新页面后加载。`);
  return parts.join(' ');
}
