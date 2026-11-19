import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
const { setLanguage } = await import(new URL('../shared/i18n/index.js', import.meta.url).href);
const { mountUpdates } = await import(new URL('../src/web/public/updates.js', import.meta.url).href);
const { default: english } = await import(new URL('../shared/i18n/en-updates.js', import.meta.url).href);

class Element {
  tag: string; kids: (Element | string)[] = []; attrs: Record<string, string> = {};
  on: Record<string, (event?: unknown) => unknown> = {}; hidden = false; disabled = false; checked = false; value = ''; focused = false; selected = false;
  constructor(tag: string) { this.tag = tag; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(name: string, fn: (event?: unknown) => unknown) { this.on[name] = fn; }
  append(...kids: (Element | string)[]) { this.kids.push(...kids); }
  replaceChildren(...kids: (Element | string)[]) { this.kids = kids; }
  set textContent(value: string) { this.kids = [value]; }
  get textContent(): string { return this.kids.map((kid) => typeof kid === 'string' ? kid : kid.textContent).join(''); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  all(): Element[] { return [this, ...this.kids.flatMap((kid) => typeof kid === 'string' ? [] : kid.all())]; }
}
const available = { currentVersion: '0.10.0-beta.1', channel: 'beta', autoCheck: true, status: 'available', latestVersion: '0.10.0-beta.2',
  releaseUrl: 'https://github.com/SiliconRaven/orrery/releases/tag/v0.10.0-beta.2', checkedAt: 1_800_000_000_000, error: null };
function replaceGlobal(t: any, name: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
}
function dom(t: any) {
  replaceGlobal(t, 'document', { createElement: (tag: string) => new Element(tag) });
  let poll = () => {}; let cleared = false;
  t.mock.method(globalThis, 'setInterval', (fn: () => void, delay: number) => { assert.equal(delay, 60_000); poll = fn; return 42; });
  t.mock.method(globalThis, 'clearInterval', (id: number) => { assert.equal(id, 42); cleared = true; });
  setLanguage('en');
  t.after(() => setLanguage('zh'));
  const root = new Element('main');
  return { root, poll: () => poll(), cleared: () => cleared,
    find: (label: string) => root.all().find((el) => el.attrs['aria-label'] === label)
      ?? root.all().find((el) => el.tag === 'button' && el.textContent === label)! };
}

test('updates panel polls cached GET only, checks explicitly and saves the auto-check switch', async (t) => {
  const ui = dom(t); const calls: unknown[][] = []; let state = { ...available };
  const dispose = mountUpdates(ui.root, { api: async (...args: any[]) => {
    calls.push(args);
    if (args[0] === 'PATCH') state = { ...state, ...args[2] };
    return state;
  } });
  await setImmediate();
  assert.equal(ui.root.all().some((el) => el.tag === 'a'), false, 'release address never becomes navigation');
  assert.match(ui.root.textContent, /0\.10\.0-beta\.2/);
  assert.doesNotMatch(ui.root.textContent, /[\u4e00-\u9fff]/, 'all UI text is translated');
  ui.poll(); await setImmediate();
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [['GET', '/api/updates'], ['GET', '/api/updates']]);
  await ui.find('Check now').on.click();
  const auto = ui.find('Check for updates automatically'); auto.checked = false;
  await auto.on.change();
  assert.deepEqual(calls.at(-2)?.slice(0, 2), ['POST', '/api/updates/check']);
  assert.deepEqual(calls.at(-1), ['PATCH', '/api/updates', { autoCheck: false }]);
  assert.equal(auto.checked, false);
  dispose(); assert.equal(ui.cleared(), true);
});

test('clipboard rejection selects the plain URL and shows the keyboard copy instruction', async (t) => {
  const ui = dom(t);
  replaceGlobal(t, 'navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
  const dispose = mountUpdates(ui.root, { api: async () => available });
  await setImmediate();
  await ui.find('Copy release page link').on.click();
  const input = ui.find('Release page address');
  assert.equal(input.value, available.releaseUrl);
  assert.ok(input.focused && input.selected);
  assert.match(ui.root.textContent, /Press Ctrl\+C/);
  dispose();
});

test('disposal cancels polling and ignores a late status response', async (t) => {
  const ui = dom(t); let complete!: (value: unknown) => void; let calls = 0;
  const dispose = mountUpdates(ui.root, { api: () => { calls++; return new Promise((resolve) => { complete = resolve; }); } });
  const before = ui.root.textContent;
  dispose(); complete(available); await setImmediate(); ui.poll();
  assert.equal(ui.cleared(), true);
  assert.equal(ui.root.textContent, before, 'late results cannot change a disposed panel');
  assert.equal(calls, 1);
});

test('static error messages hide raw failures and a failed initial read can be retried', async (t) => {
  const ui = dom(t); let fails = true;
  const dispose = mountUpdates(ui.root, { api: async () => {
    if (fails) throw new Error('<raw service error>');
    return { ...available, status: 'error', error: 'rate-limited' };
  } });
  await setImmediate();
  assert.match(ui.root.textContent, /Could not read update status/);
  assert.doesNotMatch(ui.root.textContent, /raw service error/);
  assert.equal(ui.find('Check now').disabled, false);
  fails = false; await ui.find('Check now').on.click();
  assert.match(ui.root.textContent, /GitHub’s request limit/);
  dispose();
  const source = readFileSync(new URL('../src/web/public/updates.js', import.meta.url), 'utf8');
  for (const [, msgid] of source.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(english, msgid), msgid);
});
