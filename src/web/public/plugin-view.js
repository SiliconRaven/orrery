// The full-page view slot (docs/plugins.md「官方网页插槽」): one entry button per view in the sidebar head; opening one
// covers the main area with a fresh container the view mounts into, while the chat stays laid out underneath (drafts,
// attachments, scroll positions and open panels are never touched), and closing it gives the chat back with its focus.
// One view is open at a time. Its `unmount` is called once per opening, whatever ends it: closing, switching to another
// view, a failed mount, or its full-trust plugin being released (plugin-slots.js release calls `release(id)` after
// reading what was typed into the view and before the plugin's cleanup functions). The user leaving a view that holds
// typed input (back button, Esc, its entry button, another view's, ctx.openChat) is asked first (`confirmLeave`).
import { t } from './i18n.js';
import { isInactive, trackTypedInput, typedInput } from './plugin-slots.js';

const isThenable = (value) => typeof value?.then === 'function';
/** The methods ctx.api aborts when the opening ends; a write already sent may still take effect and is left alone. */
const READS = new Set(['GET', 'HEAD']);
const warnOf = (label) => (error) => { console.warn(`plugin UI failed in ${label}`, error); };

/**
 * `layer`: the host's section over the main area, hidden while no view is open, holding `heading` (the view's title)
 * and `back` (its back button); a view's container is appended to it. `app` gets the class `view-open` while one is
 * open. Entry buttons go right before `before`. `api(method, path, body, fetchOptions)`, `clusterId()`,
 * `openChat(clusterId)` and `theme()` come from the page; `onChange()` after a view opened or closed (the page redraws).
 * `covered()`: the page's elements under the view, inert while one is open (out of the focus order and the
 * accessibility tree; the host's banners are not among them). On close, focus goes back to where it was if that is
 * still there, `canFocus(node)` (the page's own check: shown and on screen) and not part of a released plugin;
 * otherwise to the first such element of `fallbackFocus()`.
 * `confirmLeave()`: the page's confirm dialog (a promise of true or false), asked before the user leaves a view that
 * holds input typed and not submitted (typedInput); a view's own ctx.close() is its decision and is not asked.
 */
export function createViewHost({ doc = globalThis.document, app, layer, heading, back, before, api, clusterId, openChat, theme,
  onChange = () => {}, covered = () => [], canFocus = () => true, fallbackFocus = () => [], confirmLeave = async () => true }) {
  let views = [];   // the page's slots.view
  const buttons = new Map();   // view entry -> its entry button
  /** The open view: { entry, el, listeners, reads (its AbortController), returnFocus }; null when none is. */
  let open = null;
  /** The covered elements this host made inert (one already inert stays so on close). */
  let inerted = [];
  /** The opening a leave is being asked about (one question at a time); null when none is. */
  let asking = null;

  const label = (entry) => (entry.trusted ? t('第三方插件：{title}', { title: entry.title() }) : entry.title());

  function entryButton(entry) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'icon-button ghost';
    button.setAttribute('data-plugin-slot', entry.pluginId);
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${entry.icon}`);
    svg.append(use);
    button.append(svg);
    button.addEventListener('click', () => (open?.entry === entry ? leave() : open ? leave(() => show(entry)) : show(entry)));
    return button;
  }

  /** The entry buttons follow `views` (a released plugin's goes) and the language; the open view's title too. */
  function draw() {
    for (const [entry, button] of buttons) if (!views.includes(entry)) { button.remove(); buttons.delete(entry); }
    for (const entry of views) {
      let button = buttons.get(entry);
      if (!button) {
        button = entryButton(entry);
        buttons.set(entry, button);
        before.before(button);
      }
      const text = label(entry);   // plain text: title and aria-label are attributes, never markup
      button.title = text;
      button.setAttribute('aria-label', text);
      button.setAttribute('aria-pressed', String(open?.entry === entry));
    }
    if (open) heading.textContent = open.entry.title();
  }

  /** Ends the open view: its listeners go, its unmount runs once (a throw or a promise holds nothing up), its container leaves. */
  function finish() {
    const session = open;
    open = null;
    session.reads.abort();   // its reads still on the way: a late answer never reaches it
    session.listeners.clear();
    try {
      const result = session.entry.unmount();
      if (isThenable(result)) Promise.resolve(result).catch(warnOf(`${session.entry.pluginId}.view.unmount`));
    } catch (error) { warnOf(`${session.entry.pluginId}.view.unmount`)(error); }
    session.el.remove();
    return session;
  }

  /** Whether focus may go to `node` on close: still in the page, usable, not about to leave with its plugin, on screen. */
  function focusable(node) {
    if (!node?.isConnected || node === doc.body || node.disabled) return false;
    const slot = node.closest?.('[data-plugin-slot]')?.getAttribute('data-plugin-slot');
    return !(slot && isInactive(slot)) && canFocus(node);   // a released plugin's elements (its entry too) are removed next
  }

  /**
   * Closes the open view and gives the chat back: the layer hides, the covered area is usable again, focus returns to
   * where it was before the view opened (or to a fallback when that is gone or off screen).
   */
  function close() {
    if (!open) return;
    const { returnFocus } = finish();
    layer.hidden = true;
    app.classList.remove('view-open');
    for (const node of inerted) node.inert = false;
    inerted = [];
    draw();
    [returnFocus, ...fallbackFocus()].find(focusable)?.focus({ preventScroll: true });
    onChange();
  }

  /**
   * The user leaves the open view: `proceed` (closing it by default) runs at once when nothing typed there would be
   * lost; otherwise only after `confirmLeave()` says yes and the same opening is still the open one.
   */
  function leave(proceed = close) {
    const session = open;
    if (!session || asking === session) return;
    if (!typedInput([session.el]).length) { proceed(); return; }
    asking = session;
    let answer;
    try { answer = confirmLeave(); } catch { answer = false; }
    Promise.resolve(answer).catch(() => false).then((ok) => {
      asking = null;
      if (ok === true && open === session && !isInactive(session.entry.pluginId)) proceed();
    });
  }

  /** What a view gets: each function works only while this opening is the open view and its plugin is not released. */
  function contextFor(session) {
    const id = session.entry.pluginId;
    const live = () => open === session && !isInactive(id);
    const closed = () => new Error(`view ${id} is closed`);
    return Object.freeze({
      // A read is aborted when this opening ends and its late answer is refused; a write is sent as is (once sent it may
      // take effect even if the view closes meanwhile).
      api(method, path, body) {
        if (!live()) return Promise.reject(closed());
        if (!READS.has(String(method).toUpperCase())) return api(method, path, body);
        return api(method, path, body, { signal: session.reads.signal }).then((data) => (live() ? data : Promise.reject(closed())));
      },
      clusterId: clusterId() ?? null,
      openChat(cluster) {
        if (live()) leave(() => { close(); openChat(cluster); });
      },
      close() { if (live()) close(); },
      onEvent(fn) {
        if (!live() || typeof fn !== 'function') return () => {};
        session.listeners.add(fn);
        return () => { session.listeners.delete(fn); };
      },
      get theme() { return theme(); },
    });
  }

  function show(entry) {
    if (!views.includes(entry) || isInactive(entry.pluginId) || open?.entry === entry) return;
    const returnFocus = open ? open.returnFocus : doc.activeElement;
    if (open) finish();   // switching: the other view unmounts, the layer and the inert covered area stay
    else {
      inerted = [...covered()].filter((node) => node && !node.inert);
      for (const node of inerted) node.inert = true;
    }
    const el = doc.createElement('div');
    el.className = 'plugin-view-body';
    trackTypedInput(el, entry.pluginId);
    const session = { entry, el, listeners: new Set(), reads: new AbortController(), returnFocus };
    open = session;
    layer.append(el);
    layer.hidden = false;
    app.classList.add('view-open');
    app.classList.remove('sidebar-open');   // narrow screens: the drawer it was opened from closes
    draw();
    const failed = (error) => {
      warnOf(`${entry.pluginId}.view.mount`)(error);
      if (open === session) close();
    };
    try {
      const result = entry.mount(el, contextFor(session));
      if (isThenable(result)) Promise.resolve(result).catch(failed);
    } catch (error) { failed(error); }
    if (open === session && !layer.contains(doc.activeElement)) back.focus({ preventScroll: true });
    onChange();
  }

  back.addEventListener('click', () => leave());
  // Esc leaves the view (asking first when typed input would be lost) unless an input method is composing or the view
  // used it itself (preventDefault on its container or the document, which run before this). Only from inside the view
  // or with nothing focused: an Esc in the sidebar or a host dialog is theirs.
  doc.defaultView?.addEventListener('keydown', (e) => {
    if (!open || e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    if (e.target !== doc.body && e.target !== doc.documentElement && !layer.contains(e.target)) return;
    e.preventDefault();
    leave();
  });

  return {
    /** The views to offer (slots.view, again after a release); an open view no longer offered closes. */
    setViews(list) {
      views = [...(list ?? [])];
      if (open && !views.includes(open.entry)) close();
      draw();
    },
    /** Called by release (plugin-slots.js) for a full-trust plugin: its open view unmounts and closes now. */
    release(id) {
      if (open?.entry.pluginId === id) close();
    },
    /** After a language switch: titles given as functions are read again. */
    relabel: draw,
    /** One frame of the page's event stream (its raw JSON), for the open view's listeners; each gets the same fresh copy. */
    emit(data) {
      const session = open;
      if (!session?.listeners.size) return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      const warn = warnOf(`${session.entry.pluginId}.view.onEvent`);
      for (const fn of [...session.listeners]) {
        if (!session.listeners.has(fn)) continue;   // unsubscribed meanwhile, or the view closed
        try {
          const result = fn(event);
          if (isThenable(result)) Promise.resolve(result).catch(warn);
        } catch (error) { warn(error); }
      }
    },
    /** Whether the open view holds input the user typed and has not submitted (a reload would lose it). */
    hasTypedInput: () => Boolean(open && typedInput([open.el]).length),
  };
}
