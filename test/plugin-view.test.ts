// The full-page view slot: its shape checks (plugin-slots.js) and the host's open/close/unmount/release order
// (plugin-view.js), on a small fake DOM; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const pub = join(REPO_ROOT, 'src/web/public');
const { detachPluginSlots, loadPluginSlots } = await import(pathToFileURL(join(pub, 'plugin-slots.js')).href);
const { createViewHost } = await import(pathToFileURL(join(pub, 'plugin-view.js')).href);
const { reloadWouldLose } = await import(pathToFileURL(join(pub, 'ui.js')).href);

const CONTROLS = 'input, textarea, select';
const hasIcon = (name: string) => name === 'orbit';
const noOfficial = async () => assert.fail('no official module');

/** Just enough of an element for plugin-view.js, trackTypedInput, typedInput and the kept-input notice. */
class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attrs = new Map<string, string>();
  listeners = new Map<string, ((event: any) => void)[]>();
  classes = new Set<string>();
  classList = { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c), contains: (c: string) => this.classes.has(c) };
  hidden = false; textContent = ''; title = ''; type = ''; className = ''; readOnly = false; autocomplete = ''; open = false; value = '';
  inert = false; disabled = false;
  localName: string;
  doc: FakeDoc;
  constructor(localName: string, doc: FakeDoc) { this.localName = localName; this.doc = doc; }
  setAttribute(name: string, value: unknown) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  append(...nodes: unknown[]) {
    for (const node of nodes) if (node instanceof FakeElement) { node.remove(); node.parent = this; this.children.push(node); }
  }
  before(node: FakeElement) {
    const parent = this.parent!;
    node.remove();
    node.parent = parent;
    parent.children.splice(parent.children.indexOf(this), 0, node);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  get isConnected() {
    let node: FakeElement = this;
    while (node.parent) node = node.parent;
    return node === this.doc.documentElement;
  }
  contains(node: unknown) {
    for (let at = node instanceof FakeElement ? node : null; at; at = at.parent) if (at === this) return true;
    return false;
  }
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  matches(selector: string) {
    if (selector === CONTROLS) return ['input', 'textarea', 'select'].includes(this.localName);
    return selector === this.localName;
  }
  querySelectorAll(selector: string) {
    const slot = /^\[data-plugin-slot="(.+)"\]$/.exec(selector);
    return this.descendants().filter((node) => (slot ? node.getAttribute('data-plugin-slot') === slot[1] : node.matches(selector)));
  }
  closest(selector: string) {
    if (selector !== '[data-plugin-slot]') return null;
    for (let at: FakeElement | null = this; at; at = at.parent) if (at.attrs.has('data-plugin-slot')) return at;
    return null;
  }
  getClientRects() { return this.isConnected ? [{}] : []; }
  addEventListener(type: string, fn: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  dispatch(type: string, event: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    if (this.parent && !event.stopped) this.parent.dispatch(type, event);
    else if (!this.parent && this === this.doc.documentElement) this.doc.window.dispatch(type, event);
  }
  focus() { this.doc.activeElement = this; }
  show() { this.open = true; }
  close() { this.open = false; this.dispatch('close', {}); }
}

class FakeDoc {
  documentElement: FakeElement;
  body: FakeElement;
  activeElement: FakeElement;
  window = { listeners: new Map<string, ((event: any) => void)[]>(),
    addEventListener(type: string, fn: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); },
    dispatch(type: string, event: any) { for (const fn of this.listeners.get(type) ?? []) fn(event); } };
  defaultView = this.window;
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) { return new FakeElement(tag, this); }
  createElementNS(_ns: string, tag: string) { return new FakeElement(tag, this); }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector); }
}

/** The page around the host: #app with the sidebar head (settings button), the chat and the view layer. */
function page(t: any) {
  const doc = new FakeDoc();
  const saved = ['document', 'CSS', 'getComputedStyle'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.assign(globalThis, { document: doc, CSS: { escape: (s: string) => s }, getComputedStyle: () => ({ visibility: 'visible' }) });
  t.after(() => { for (const [name, value] of saved) { if (value) Object.defineProperty(globalThis, name, value); else delete (globalThis as any)[name]; } });
  const make = (tag: string, parent: FakeElement) => { const el = doc.createElement(tag); parent.append(el); return el; };
  const app = make('div', doc.body);
  const head = make('div', app);
  const settings = make('button', head);
  const composer = make('textarea', make('main', app));
  const layer = make('section', app);
  layer.hidden = true;
  const back = make('button', make('header', layer));
  const heading = make('h1', back.parent!);
  return { doc, app, head, settings, composer, layer, back, heading };
}

/** A view whose calls go to `calls`; `mount` and `unmount` may be replaced. */
function sampleView(id: string, calls: string[], extra: Record<string, unknown> = {}) {
  return { id, title: () => `${id} title`, icon: 'orbit',
    mount: (el: any, ctx: any) => { calls.push(`${id}.mount`); sampleView.last = { el, ctx }; },
    unmount: () => { calls.push(`${id}.unmount`); }, ...extra };
}
sampleView.last = {} as { el?: any, ctx?: any };

test('view slot: the shape is checked before anything of the module is added', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const good = sampleView('good', []);
  const shapes: Record<string, unknown> = {
    'no-unmount': { view: { ...sampleView('no-unmount', []), unmount: undefined } },
    'extra-key': { view: { ...sampleView('extra-key', []), html: '<b>x</b>' } },
    'wrong-id': { view: sampleView('starmap', []) },
    'bad-icon': { view: { ...sampleView('bad-icon', []), icon: '<svg onload="x()"></svg>' } },
    'unknown-icon': { view: { ...sampleView('unknown-icon', []), icon: 'rocket' } },
    'empty-title': { view: { ...sampleView('empty-title', []), title: ' ' } },
    'number-title': { view: { ...sampleView('number-title', []), title: 7 } },
    'promise-view': { composer: () => 'c', view: Promise.resolve(good) },
    good: { view: good },
  };
  const ids = Object.keys(shapes);
  const disposed: string[] = [];
  const slots = await loadPluginSlots({ frontend: [], trustedFrontend: ids, plugins: ids.map((id) => ({ id })) }, { api: async () => ({}) }, noOfficial,
    async (id: string) => ({ register(host: any) { host.onDispose(() => disposed.push(id)); return shapes[id]; } }), hasIcon);
  assert.deepEqual(slots.trusted, ['good']);
  assert.deepEqual(slots.view.map((v: any) => [v.pluginId, v.icon, v.trusted, v.title()]), [['good', 'orbit', true, 'good title']]);
  assert.deepEqual(slots.composer, [], 'a refused module adds no other slot either');
  assert.deepEqual(disposed.sort(), ids.filter((id) => id !== 'good').sort(), 'each refused module is released as a whole');
  const reasons = warnings.mock.calls.map((call) => String(call.arguments[1])).join('\n');
  for (const text of ['view.unmount must be a function', 'view.html is not part of the slot', "view.id must be the plugin's id (wrong-id)",
    'view.icon must name an icon of the page', 'view.title must be a non-empty string or a function', 'view must be an object (not a promise)']) {
    assert.ok(reasons.includes(text), text);
  }

  // Official modules are checked the same way: a view with another plugin's id refuses the module, nothing of it is added.
  const official = await loadPluginSlots({ frontend: ['own', 'other'], plugins: [{ id: 'own' }, { id: 'other' }] }, {},
    async (id: string) => ({ register: () => ({ message: { render: () => 'm' }, view: sampleView(id === 'other' ? 'own' : id, []) }) }), undefined, hasIcon);
  assert.deepEqual(official.view.map((v: any) => [v.pluginId, v.trusted]), [['own', false]]);
  assert.deepEqual(official.message.map((s: any) => s.pluginId), ['own']);
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === 'plugin UI failed to load: other'));
});

test('view host: entries, open, switch, Esc, close and a failed mount each unmount once and give the chat back', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const calls: string[] = [];
  let title = 'Alpha';
  const views: Record<string, any> = {
    alpha: sampleView('alpha', calls, { title: () => title }),
    beta: sampleView('beta', calls, { title: 'Beta' }),
    broken: sampleView('broken', calls, { mount: () => { calls.push('broken.mount'); throw new Error('fixture mount failed'); } }),
  };
  const ids = Object.keys(views);
  const slots = await loadPluginSlots({ frontend: ids, plugins: ids.map((id) => ({ id })) }, {},
    async (id: string) => ({ register: () => ({ view: views[id] }) }), undefined, hasIcon);
  const { doc, app, head, settings, composer, layer, back, heading } = page(t);
  const opened: string[] = [];
  const host = createViewHost({ doc, app, layer, heading, back, before: settings, api: async (...args: unknown[]) => args,
    clusterId: () => 'c1', openChat: (id: string) => opened.push(id), theme: () => 'dark', onChange: () => calls.push('changed') });
  host.setViews(slots.view);
  const buttons = head.children.slice(0, 3);
  assert.equal(head.children.at(-1), settings, 'entries go before the settings button');
  assert.deepEqual(buttons.map((b) => [b.getAttribute('aria-label'), b.title, b.getAttribute('data-plugin-slot')]),
    [['Alpha', 'Alpha', 'alpha'], ['Beta', 'Beta', 'beta'], ['broken title', 'broken title', 'broken']]);
  assert.equal(buttons[0].descendants().find((n) => n.localName === 'use')?.getAttribute('href'), '#i-orbit');

  composer.focus();
  buttons[0].dispatch('click', {});
  const first = sampleView.last;
  assert.deepEqual(calls, ['alpha.mount', 'changed']);
  assert.equal(layer.hidden, false);
  assert.ok(app.classList.contains('view-open'));
  assert.equal(heading.textContent, 'Alpha');
  assert.equal(first.el.parent, layer, 'a fresh container in the layer');
  assert.equal(first.el.getAttribute('data-plugin-slot'), 'alpha');
  assert.equal(composer.isConnected, true, 'the chat stays');
  assert.equal(doc.activeElement, back, 'focus moves into the view');
  assert.equal(first.ctx.clusterId, 'c1');
  assert.equal(first.ctx.theme, 'dark');
  assert.ok(Object.isFrozen(first.ctx));
  const [method, path, body, options] = await first.ctx.api('GET', '/api/x', undefined, 'extra');
  assert.deepEqual([method, path, body], ['GET', '/api/x', undefined]);
  assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted, "a read is bound to this opening's signal");
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');

  // Event frames reach the open view's listeners, each frame parsed once into a copy of its own.
  const seen: any[] = [];
  const stop = first.ctx.onEvent((event: any) => seen.push(event));
  first.ctx.onEvent(() => { throw new Error('fixture listener failed'); });
  host.emit('{"type":"message","seq":1}');
  stop();
  host.emit('{"type":"message","seq":2}');
  assert.deepEqual(seen, [{ type: 'message', seq: 1 }]);

  // The title follows the language: a function is read again.
  title = 'Alpha (en)';
  host.relabel();
  assert.equal(buttons[0].getAttribute('aria-label'), 'Alpha (en)');
  assert.equal(heading.textContent, 'Alpha (en)');

  // Switching: the open view unmounts once, the layer stays.
  calls.length = 0;
  buttons[1].dispatch('click', {});
  const second = sampleView.last;
  assert.deepEqual(calls, ['alpha.unmount', 'beta.mount', 'changed']);
  assert.equal(first.el.parent, null);
  first.ctx.close();
  first.ctx.openChat('c2');
  await assert.rejects(first.ctx.api('GET', '/x'), /closed/);
  assert.deepEqual(calls, ['alpha.unmount', 'beta.mount', 'changed'], "an earlier opening's ctx does nothing");
  assert.equal(layer.hidden, false);

  // Esc: not while composing, not when the view used it, otherwise it closes; focus goes back to the chat.
  calls.length = 0;
  const esc = (target: FakeElement, extra = {}) => target.dispatch('keydown', { key: 'Escape', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra });
  esc(second.el, { isComposing: true });
  esc(second.el, { defaultPrevented: true });
  esc(settings);   // an Esc that belongs to the sidebar
  assert.deepEqual(calls, []);
  esc(doc.body);
  assert.deepEqual(calls, ['beta.unmount', 'changed']);
  assert.equal(layer.hidden, true);
  assert.ok(!app.classList.contains('view-open'));
  assert.equal(doc.activeElement, composer, 'focus returns to where it was before the first view opened');
  second.ctx.close();
  assert.deepEqual(calls, ['beta.unmount', 'changed'], 'closing twice unmounts once');

  // The back button and ctx.openChat close as well.
  calls.length = 0;
  buttons[0].dispatch('click', {});
  back.dispatch('click', {});
  buttons[0].dispatch('click', {});
  sampleView.last.ctx.openChat('c2');
  assert.deepEqual(calls, ['alpha.mount', 'changed', 'alpha.unmount', 'changed', 'alpha.mount', 'changed', 'alpha.unmount', 'changed']);
  assert.deepEqual(opened, ['c2']);

  // A throwing mount: logged, unmounted once, closed; the page goes on.
  calls.length = 0;
  buttons[2].dispatch('click', {});
  assert.deepEqual(calls, ['broken.mount', 'broken.unmount', 'changed', 'changed']);
  assert.equal(layer.hidden, true);
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === 'plugin UI failed in broken.view.mount'));
  assert.ok(warnings.mock.calls.some((call) => call.arguments[0] === 'plugin UI failed in alpha.view.onEvent'));
  assert.equal(host.hasTypedInput(), false);
});

test('view host: leaving a view that holds typed input asks first; no keeps it, yes leaves the way the user asked', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const calls: string[] = [];
  const views: Record<string, any> = { alpha: sampleView('alpha', calls), beta: sampleView('beta', calls) };
  const ids = Object.keys(views);
  const slots = await loadPluginSlots({ frontend: ids, plugins: ids.map((id) => ({ id })) }, {},
    async (id: string) => ({ register: () => ({ view: views[id] }) }), undefined, hasIcon);
  const { doc, app, head, settings, layer, back, heading } = page(t);
  const answers: PromiseWithResolvers<boolean>[] = [];
  const opened: string[] = [];
  const host = createViewHost({ doc, app, layer, heading, back, before: settings, api: async () => ({}), clusterId: () => 'c1',
    openChat: (id: string) => { calls.push(`openChat ${id}`); opened.push(id); }, theme: () => 'dark',
    confirmLeave: () => { calls.push('asked'); const answer = Promise.withResolvers<boolean>(); answers.push(answer); return answer.promise; } });
  host.setViews(slots.view);
  const [alphaButton, betaButton] = head.children.slice(0, 2);
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });
  const answer = async (ok: boolean) => { answers.at(-1)!.resolve(ok); await settle(); };
  const esc = (target: FakeElement) => target.dispatch('keydown', { key: 'Escape', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  /** The user types into the open view (a draft in one of its windows). */
  const type = (el: FakeElement) => {
    const control = doc.createElement('textarea');
    control.type = 'textarea';
    el.append(control);
    el.dispatch('focusin', { isTrusted: true, target: control });
    control.value = 'unsent draft';
    el.dispatch('input', { isTrusted: true, target: control });
    return control;
  };

  // Nothing typed: the back button leaves at once, nothing is asked.
  alphaButton.dispatch('click', {});
  back.dispatch('click', {});
  assert.deepEqual(calls, ['alpha.mount', 'alpha.unmount']);

  alphaButton.dispatch('click', {});
  const { el, ctx } = sampleView.last;
  const control = type(el);
  assert.equal(host.hasTypedInput(), true);
  calls.length = 0;
  // Each way out asks; "no" leaves the view, its container and the draft where they are.
  back.dispatch('click', {});
  back.dispatch('click', {});   // one question at a time
  await answer(false);
  esc(doc.body);
  await answer(false);
  alphaButton.dispatch('click', {});   // its own entry button
  await answer(false);
  betaButton.dispatch('click', {});   // switching to another view
  await answer(false);
  ctx.openChat('c2');
  await answer(false);
  assert.deepEqual(calls, ['asked', 'asked', 'asked', 'asked', 'asked']);
  assert.equal(layer.hidden, false);
  assert.equal(el.parent, layer);
  assert.equal(control.value, 'unsent draft');
  assert.deepEqual(opened, []);

  // "Yes" to ctx.openChat: the view closes, then the chat opens.
  calls.length = 0;
  ctx.openChat('c2');
  await answer(true);
  assert.deepEqual(calls, ['asked', 'alpha.unmount', 'openChat c2']);
  assert.equal(layer.hidden, true);

  // "Yes" to switching: the other view mounts in its place.
  calls.length = 0;
  alphaButton.dispatch('click', {});
  type(sampleView.last.el);
  betaButton.dispatch('click', {});
  await answer(true);
  assert.deepEqual(calls, ['alpha.mount', 'asked', 'alpha.unmount', 'beta.mount']);

  // An answer that comes after the view ended some other way changes nothing.
  calls.length = 0;
  type(sampleView.last.el);
  back.dispatch('click', {});
  sampleView.last.ctx.close();   // the view's own close is its decision: not asked
  alphaButton.dispatch('click', {});
  await answer(true);
  assert.deepEqual(calls, ['asked', 'beta.unmount', 'alpha.mount']);
  assert.equal(layer.hidden, false, 'the view opened since stays open');
});

test('view host: releasing a full-trust plugin keeps the typed input, unmounts once, closes, then runs onDispose', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const calls: string[] = [];
  const { doc, app, settings, composer, layer, back, heading } = page(t);
  let control: FakeElement | null = null;
  let value = '';
  const view = sampleView('gamma', calls, {
    title: 'Gamma',
    mount(el: any, ctx: any) {
      calls.push('gamma.mount');
      sampleView.last = { el, ctx };
      control = doc.createElement('input');
      control.type = 'text';
      Object.defineProperty(control, 'value', { get: () => { if (calls.at(-1) !== 'rescue') calls.push('rescue'); return value; } });
      el.append(control);
    },
    // A view that never finishes unmounting holds nothing up.
    unmount: () => { calls.push('gamma.unmount'); return new Promise(() => {}); },
  });
  const slots = await loadPluginSlots({ frontend: [], trustedFrontend: ['gamma'], plugins: [{ id: 'gamma' }] }, { api: async () => ({}) }, noOfficial,
    async () => ({ register(host: any) { host.onDispose(() => calls.push('dispose')); return { view }; } }), hasIcon);
  const host = createViewHost({ doc, app, layer, heading, back, before: settings, api: async () => 'answer',
    clusterId: () => null, openChat: () => calls.push('openChat'), theme: () => 'light', onChange: () => calls.push('closed') });
  slots.onRelease = () => host.setViews(slots.view);
  slots.closeView = (id: string) => host.release(id);
  host.setViews(slots.view);
  const button = settings.parent!.children[0];
  assert.equal(button.getAttribute('aria-label'), '第三方插件：Gamma', 'a full-trust entry says whose it is');

  composer.focus();
  button.dispatch('click', {});
  const { el, ctx } = sampleView.last;
  assert.equal(ctx.clusterId, null);
  const seen: unknown[] = [];
  ctx.onEvent((event: unknown) => seen.push(event));
  // The user types into the view: the page counts it as unsaved.
  el.dispatch('focusin', { isTrusted: true, target: control });
  value = 'half-written note';
  el.dispatch('input', { isTrusted: true, target: control });
  assert.equal(reloadWouldLose({ editing: host.hasTypedInput() }), true);

  calls.length = 0;
  detachPluginSlots(slots, ['gamma']);
  assert.deepEqual(calls, ['rescue', 'gamma.unmount', 'closed', 'dispose']);
  assert.equal(layer.hidden, true);
  assert.equal(el.parent, null);
  assert.equal(button.parent, null, 'the entry goes');
  assert.equal(doc.activeElement, composer);
  const kept = doc.body.children.find((node) => node.className === 'kept-input');
  assert.ok(kept?.open, 'the typed input is in the host notice');
  assert.match(kept.descendants().find((node) => node.className === 'kept-input-text')!.value, /half-written note/);

  // Its ctx is dead: api refuses, openChat and close do nothing, its listeners were dropped by the host.
  calls.length = 0;
  await assert.rejects(ctx.api('GET', '/x'), /closed/);
  ctx.openChat('c1');
  ctx.close();
  host.emit('{"type":"message"}');
  assert.deepEqual(seen, []);
  assert.deepEqual(calls, []);
  button.dispatch('click', {});
  assert.deepEqual(calls, [], 'a released view never mounts again');
  assert.equal(slots.view.length, 0);
});

test('view slot: a promise-shaped view or title that rejects later is refused without an unhandled rejection', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });
  const later = (what: string) => new Promise((_ok, fail) => { setTimeout(() => fail(new Error(`fixture ${what} rejected`)), 5); });
  const slots = await loadPluginSlots({ frontend: ['late-official', 'late-title'], trustedFrontend: ['late-view'],
    plugins: [{ id: 'late-official' }, { id: 'late-title' }, { id: 'late-view' }] }, { api: async () => ({}) },
    async (id: string) => ({ register: () => (id === 'late-official' ? { view: later('official view') }
      : { view: sampleView(id, [], { title: () => Promise.reject(new Error('fixture title rejected')) }) }) }),
    async () => ({ register: () => ({ view: later('view') }) }), hasIcon);
  assert.deepEqual(slots.trusted, [], 'the full-trust module is still refused');
  assert.deepEqual(slots.view.map((v: any) => [v.pluginId, v.title()]), [['late-title', 'late-title']], 'a promise is not a title: the id stands in');
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.deepEqual(unhandled, []);
  const logged = warnings.mock.calls.map((call) => `${call.arguments[0]} ${call.arguments[1]}`);
  for (const text of ['plugin UI failed in late-view.view Error: fixture view rejected', 'plugin UI failed in late-official.view Error: fixture official view rejected',
    'plugin UI failed in late-title.view.title Error: fixture title rejected']) assert.ok(logged.includes(text), text);
});

test('view host: the covered area is inert, reads end with the opening, focus never goes to a removed or hidden place', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const calls: string[] = [];
  const { doc, app, head, settings, composer, layer, back, heading } = page(t);
  const chat = composer.parent!;
  const banner = doc.createElement('div');   // a host banner: never covered
  const panel = doc.createElement('aside');
  const already = doc.createElement('div');
  already.inert = true;   // inert for its own reasons: stays so
  app.append(banner, panel, already);
  const narrowButton = doc.createElement('button');
  chat.append(narrowButton);
  const offScreen = new Set<FakeElement>();
  // Each request waits for the test; the host's fetch options are recorded.
  const requests: { method: string; options: any; gate: PromiseWithResolvers<unknown> }[] = [];
  const api = (method: string, _path: string, _body: unknown, options: any) => {
    const gate = Promise.withResolvers<unknown>();
    requests.push({ method, options, gate });
    return gate.promise;
  };
  const views: Record<string, any> = { alpha: sampleView('alpha', calls), beta: sampleView('beta', calls) };
  const ids = Object.keys(views);
  const slots = await loadPluginSlots({ frontend: ids, trustedFrontend: ['delta'], plugins: [...ids, 'delta'].map((id) => ({ id })) }, { api: async () => ({}) },
    async (id: string) => ({ register: () => ({ view: views[id] }) }), async () => ({ register: () => ({ view: sampleView('delta', calls) }) }), hasIcon);
  const host = createViewHost({ doc, app, layer, heading, back, before: settings, api, clusterId: () => 'c1', openChat: () => {}, theme: () => 'light',
    covered: () => [chat, panel, already], canFocus: (node: FakeElement) => !offScreen.has(node), fallbackFocus: () => [settings, narrowButton] });
  slots.onRelease = () => host.setViews(slots.view);
  slots.closeView = (id: string) => host.release(id);
  host.setViews(slots.view);
  const [alphaButton, betaButton, deltaButton] = head.children.slice(0, 3);

  // Opening covers the chat and the member panel (inert: out of the focus order and the accessibility tree), not the banner.
  composer.focus();
  alphaButton.dispatch('click', {});
  assert.deepEqual([chat.inert, panel.inert, already.inert, banner.inert], [true, true, true, false]);
  const alpha = sampleView.last.ctx;
  const read = alpha.api('GET', '/api/a');
  const write = alpha.api('POST', '/api/a', { x: 1 });
  assert.equal(requests[1].options, undefined, 'a write is sent as is');
  const readSignal = requests[0].options.signal;

  // Switching keeps the cover; the earlier opening's read is aborted and its late answer never reaches it.
  betaButton.dispatch('click', {});
  assert.equal(readSignal.aborted, true);
  assert.equal(chat.inert, true);
  requests[0].gate.resolve({ late: true });
  await assert.rejects(read, /alpha is closed/);
  requests[1].gate.resolve({ written: true });
  assert.deepEqual(await write, { written: true }, 'a write already sent may have taken effect: its answer is not hidden');

  // Closing: the cover goes (one inert before stays inert), the open read aborts, focus goes back to the composer.
  const beta = sampleView.last.ctx;
  const betaRead = beta.api('get', '/api/b');
  beta.close();
  assert.equal(requests[2].options.signal.aborted, true);
  requests[2].gate.reject(new DOMException('aborted', 'AbortError'));
  await assert.rejects(betaRead, /aborted/);
  assert.deepEqual([chat.inert, panel.inert, already.inert], [false, false, true]);
  assert.equal(doc.activeElement, composer);

  // Opened from an entry button in a narrow screen's drawer, which closed: focus does not go back off screen.
  alphaButton.focus();
  alphaButton.dispatch('click', {});
  offScreen.add(alphaButton).add(settings);
  back.dispatch('click', {});
  assert.equal(doc.activeElement, narrowButton, 'the first fallback on screen');
  offScreen.clear();

  // A released plugin's entry is removed right after its view closes: focus goes to the fallback instead.
  deltaButton.focus();
  deltaButton.dispatch('click', {});
  assert.equal(chat.inert, true);
  const deltaRead = sampleView.last.ctx.api('GET', '/api/d');
  detachPluginSlots(slots, ['delta']);
  assert.equal(requests[3].options.signal.aborted, true, 'a release aborts the open reads too');
  requests[3].gate.resolve({});
  await assert.rejects(deltaRead, /closed/);
  assert.equal(deltaButton.parent, null);
  assert.equal(chat.inert, false);
  assert.equal(doc.activeElement, settings);
});
