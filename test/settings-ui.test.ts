// The settings dialog's frame (settings.js), the theme (theme.js, style.css) and the plugin cards (plugins.js), run in
// node against a small fake DOM. docs/plugins.md describes the cards; README the theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { REPO_ROOT } from '../src/main.ts';

const pub = join(REPO_ROOT, 'src', 'web', 'public');
const read = (name: string) => readFileSync(join(pub, name), 'utf8');

type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, (event?: any) => void>; hidden?: boolean;
  setAttribute(k: string, v: string): void; addEventListener(k: string, f: (event?: any) => void): void; append(...c: (El | string)[]): void };
const created: El[] = [];
const fakeDocument = {
  createElement: (tag: string): El => {
    const el: El = {
      tag, attrs: {}, kids: [], on: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, f) { this.on[k] = f; },
      append(...c) { this.kids.push(...c); },
    };
    created.push(el);
    return el;
  },
};
const text = (e: El | string): string => (typeof e === 'string' ? e : e.kids.map(text).join(''));
const all = (e: El | string): El[] => (typeof e === 'string' ? [] : [e, ...e.kids.flatMap(all)]);
const strings = (e: El | string): string[] => (typeof e === 'string' ? [e] : e.kids.flatMap(strings));

(globalThis as any).document = fakeDocument;
const plugins = await import(pathToFileURL(join(pub, 'plugins.js')).href);
const settings = await import(pathToFileURL(join(pub, 'settings.js')).href);

const entry = (over: object) => ({ id: 'x', name: 'X', version: '1.0.0', requires: [], description: '一句话', details: '', iconUrl: null,
  enabled: true, disabledByEnv: false, pendingEnabled: true, ...over });

test('plugin card: state chip, dependencies both ways, icon, details disclosure', () => {
  const tasks = entry({ id: 'tasks', name: '任务系统', iconUrl: '/official-plugins/tasks.svg', details: '**提供**\n- 任务' });
  const coordinator = entry({ id: 'coordinator', name: '协调员', requires: ['tasks'] });
  const installed = [tasks, coordinator];
  assert.deepEqual(plugins.pluginState(tasks), { text: '已启用', tone: 'on' });
  assert.deepEqual(plugins.pluginState({ ...tasks, enabled: false, pendingEnabled: false }), { text: '已停用', tone: 'off' });
  assert.deepEqual(plugins.pluginState({ ...tasks, pendingEnabled: false }), { text: '重启 Hub 后生效：将禁用', tone: 'pending' });
  assert.deepEqual(plugins.pluginState({ ...tasks, enabled: false }), { text: '重启 Hub 后生效：将启用', tone: 'pending' });
  assert.deepEqual(plugins.pluginState({ ...tasks, disabledByEnv: true }), { text: '由环境变量禁用', tone: 'off' });
  assert.deepEqual(plugins.pluginState({ ...tasks, unavailable: true, disabledByEnv: true }), { text: '启动时被跳过', tone: 'bad' });

  const expanded = new Set<string>();
  const card = plugins.pluginRow(tasks, installed, false, () => {}, () => {}, expanded);
  assert.equal(card.tag, 'article');
  assert.match(text(card), /任务系统 1\.0\.0一句话/);
  assert.match(text(card), /已启用/);
  assert.match(text(card), /被依赖：协调员/, 'reverse dependencies are computed from installed');
  assert.doesNotMatch(text(card), /第三方/);
  assert.equal(all(card).find((e) => e.tag === 'img')?.attrs.src, '/official-plugins/tasks.svg');
  assert.match(text(plugins.pluginRow(coordinator, installed, false, () => {})), /依赖：任务系统/);
  assert.equal(all(plugins.pluginRow(coordinator, installed, false, () => {})).some((e) => e.tag === 'img'), false, 'no icon: the default tile');

  const button = all(card).find((e) => e.attrs['data-plugin-details'] === 'tasks')!;
  const panel = all(card).find((e) => e.attrs.id === 'plugin-details-tasks')!;
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(button.attrs['aria-controls'], 'plugin-details-tasks');
  assert.equal(panel.attrs.hidden, '', 'details start closed');
  assert.ok(all(panel).some((e) => e.tag === 'strong' && text(e) === '提供') && all(panel).some((e) => e.tag === 'li'), 'details use the Markdown subset');
  button.on.click();
  assert.equal(button.attrs['aria-expanded'], 'true');
  assert.equal(panel.hidden, false);
  assert.ok(expanded.has('tasks'));
  const redrawn = plugins.pluginRow(tasks, installed, true, () => {}, () => {}, expanded);
  assert.equal(all(redrawn).find((e) => e.attrs['data-plugin-details'] === 'tasks')!.attrs['aria-expanded'], 'true', 'a redraw keeps it open');
  assert.equal(all(redrawn).find((e) => e.attrs.id === 'plugin-details-tasks')!.attrs.hidden, undefined);
  // The switch is the card's first input, and says where its restart note is.
  const sw = all(card).find((e) => e.tag === 'input')!;
  assert.equal(sw.attrs['data-plugin'], 'tasks');
  assert.equal(sw.attrs.role, 'switch');
  assert.equal(sw.attrs['aria-describedby'], 'plugin-restart-note');
  assert.ok(read('index.html').includes('id="plugin-restart-note"'));
});

test('plugin card: a third-party plugin shows its mark, process, grants, commands and why its icon is missing', () => {
  const plugin = entry({ id: 'notes', name: '笔记', origin: 'external', permissions: ['messages.read'], clusterIds: ['a', 'b'], events: ['message.created'],
    commands: [{ id: 'count', title: '统计' }], runtime: { state: 'ready', error: null, errorCode: null }, iconError: '图标在插件目录之外。',
    details: 'x'.repeat(10), detailsTruncated: true });
  const card = plugins.pluginRow(plugin, [plugin], false, () => {});
  for (const expected of [/第三方/, /外部进程：ready/, /图标没有显示：图标在插件目录之外。/, /命令：统计（count）/, /订阅的事件：message\.created/,
    /已授权：messages\.read；限定 2 个群。独立进程不是安全沙箱。/, /说明超过 4000 字/]) assert.match(text(card), expected);
  const skipped = { ...plugin, unavailable: true, enabled: false, pendingEnabled: false, runtime: { state: 'failed', error: 'entry missing', errorCode: 'START_FAILED' } };
  const failed = plugins.pluginRow(skipped, [skipped], false, () => {});
  assert.match(text(failed), /启动时被跳过/);
  assert.match(text(failed), /外部进程错误：entry missing \[START_FAILED\]/);
  assert.equal(all(failed).find((e) => e.attrs['data-plugin'] === 'notes')!.attrs.disabled, '');
});

test('plugin card: granted event patterns with their types, the wildcard note, and published types', () => {
  const plugin = entry({ id: 'ci', name: 'CI', origin: 'external', permissions: ['events.read', 'events.publish'], clusterIds: ['a'],
    events: ['task.*', 'member.status', 'bookmark.saved'], runtime: { state: 'ready', error: null, errorCode: null },
    eventGrants: [
      { pattern: 'task.*', wildcard: true, types: [{ type: 'task.approved', owner: 'tasks', description: '验收通过。', fields: 'scope, acceptance, reason' }, { type: 'task.merged', owner: 'tasks', description: '已合并。' }] },
      { pattern: 'member.status', wildcard: false, types: [{ type: 'member.status', owner: 'core', description: '成员状态变化。' }] },
      { pattern: 'bookmark.saved', wildcard: false, types: [] },
    ],
    publishes: [{ type: 'plugin.ci.build.done', description: '构建结束。', fields: 'ok' }],
    eventPublishLimit: { at: '2026-11-17T12:00:00.000Z', perMinute: 60 } });
  const row = plugins.pluginRow(plugin, [plugin], false, () => {});
  const card = text(row);
  for (const expected of [/订阅的事件：task\.\*、member\.status、bookmark\.saved/, /task\.\*（通配符：以后新增的同类事件也会推给它。现在有 2 种）/,
    /task\.approved：验收通过。/, /task\.merged：已合并。/, /member\.status：成员状态变化。/, /bookmark\.saved：现在没有这种事件/,
    /发布的事件（给其他插件订阅）：/, /plugin\.ci\.build\.done：构建结束。（字段：ok）/,
    /task\.approved：验收通过。（字段：scope, acceptance, reason）/]) assert.match(card, expected);
  const limit = row.kids.find((el: El | string) => typeof el !== 'string' && el.attrs.class === 'plugin-error');
  assert.ok(limit, 'the latest rate notice is outside the collapsed details');
  assert.equal(text(limit), '最近事件发布限流：2026-11-17T12:00:00.000Z（每分钟 60 条）');
  const ungranted = text(plugins.pluginRow({ ...plugin, permissions: ['events.read'], events: [], eventGrants: [] }, [plugin], false, () => {}));
  assert.match(ungranted, /没有授予 events\.publish，不能发布/);
  assert.doesNotMatch(ungranted, /订阅的事件/);
  // An older Hub's listing without eventGrants still shows the patterns.
  assert.match(text(plugins.pluginRow({ ...plugin, eventGrants: undefined, publishes: undefined }, [plugin], false, () => {})), /订阅的事件：task\.\*/);
});

test('plugin card: hostile manifest text stays text, and only Hub icon addresses ever load', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const plugin = entry({ id: 'evil', name: evil, description: evil, origin: 'external', permissions: [], clusterIds: [],
    commands: [{ id: 'c', title: evil }], runtime: { state: 'ready' }, iconError: evil,
    events: ['*'], eventGrants: [{ pattern: '*', wildcard: true, types: [{ type: 'plugin.other.x', owner: 'other', description: evil, fields: evil }] }],
    publishes: [{ type: 'plugin.evil.x', description: evil, fields: evil }],
    details: `${evil}\n\n[click](javascript:alert(1)) [site](https://example.invalid/x) <a href="https://example.invalid">a</a>\n\n![img](https://example.invalid/i.png)\n\n| <b>h</b> |\n|---|\n| ${evil} |` });
  for (const iconUrl of [null, 'javascript:alert(1)', 'https://example.invalid/x.png', '//example.invalid/x.png', 'data:image/svg+xml,<svg onload=alert(1)>',
    '/api/plugins/evil/icon?x=1', '/official-plugins/../app.js', '/api/plugins/evil/icon']) {
    created.length = 0;
    const card = plugins.pluginRow({ ...plugin, iconUrl }, [plugin], false, () => {});
    const tags = new Set(created.map((e) => e.tag));
    for (const bad of ['script', 'a', 'iframe', 'object', 'embed', 'style', 'link']) assert.ok(!tags.has(bad), `no <${bad}> (${iconUrl})`);
    const images = created.filter((e) => e.tag === 'img');
    assert.deepEqual(images.map((e) => e.attrs.src), iconUrl === '/api/plugins/evil/icon' ? [iconUrl] : [], `icon ${iconUrl}`);
    for (const el of created) {
      // Attribute values go through setAttribute (never parsed as markup); what matters is that none runs or loads anything.
      for (const name of Object.keys(el.attrs)) assert.ok(!/^(on|href$|srcset$|style$|formaction$)/i.test(name), `no ${name} attribute`);
    }
    // The hostile strings are all there, as plain text.
    assert.ok(strings(card).some((s) => s.includes('<script>alert(1)</script>')));
    assert.ok(strings(card).includes(`（字段：${evil}）`), 'subscribed field descriptions are literal text nodes');
    assert.match(text(card), /click（javascript:alert\(1\)）|\[click\]\(javascript:alert\(1\)\)/);
    assert.match(text(card), /site（https:\/\/example\.invalid\/x）/, 'a link is shown as text with its address');
  }
});

test('settings tabs: arrow keys, Home and End wrap through the sections', () => {
  const tabs = ['a', 'b', 'c'];
  assert.equal(settings.nextTab(tabs, 'a', 'ArrowDown'), 'b');
  assert.equal(settings.nextTab(tabs, 'c', 'ArrowRight'), 'a');
  assert.equal(settings.nextTab(tabs, 'a', 'ArrowUp'), 'c');
  assert.equal(settings.nextTab(tabs, 'b', 'ArrowLeft'), 'a');
  assert.equal(settings.nextTab(tabs, 'b', 'Home'), 'a');
  assert.equal(settings.nextTab(tabs, 'a', 'End'), 'c');
  assert.equal(settings.nextTab(tabs, 'a', 'Enter'), null);
});

/** theme.js in a fresh context: what it puts on <html> for a stored value, and what set() stores. */
function themeContext(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }) {
  const attrs = new Map<string, string>();
  const listeners: ((e: { key: string | null }) => void)[] = [];
  const context: any = {
    localStorage: storage,
    document: { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k),
      getAttribute: (k: string) => attrs.get(k) ?? null } },
    addEventListener: (type: string, fn: any) => { if (type === 'storage') listeners.push(fn); },
  };
  context.globalThis = context;
  runInNewContext(read('theme.js'), context);
  return { theme: () => attrs.get('data-theme') ?? null, api: context.orreryTheme, fire: (key: string | null) => listeners.forEach((fn) => fn({ key })) };
}
const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
};

test('theme: a stored light or dark wins; anything else, or storage that throws, follows the system', () => {
  assert.equal(themeContext(memory({ 'orrery.theme': 'dark' })).theme(), 'dark');
  assert.equal(themeContext(memory({ 'orrery.theme': 'light' })).theme(), 'light');
  assert.equal(themeContext(memory({ 'orrery.theme': 'orrery' })).theme(), 'orrery');
  for (const value of ['system', 'DARK', 'Orrery', 'blue', '']) assert.equal(themeContext(memory({ 'orrery.theme': value })).theme(), null, value);
  assert.equal(themeContext(memory()).theme(), null);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  const blocked = themeContext(broken);
  assert.equal(blocked.theme(), null);
  assert.equal(blocked.api.stored(), 'system');
  assert.equal(blocked.api.set('dark'), 'dark', 'a blocked store still switches this page');
  assert.equal(blocked.theme(), 'dark');

  const store = memory();
  const page = themeContext(store);
  assert.equal(page.api.set('light'), 'light');
  assert.equal(store.data.get('orrery.theme'), 'light');
  assert.equal(page.theme(), 'light');
  assert.equal(page.api.set('orrery'), 'orrery');
  assert.equal(store.data.get('orrery.theme'), 'orrery');
  assert.equal(page.theme(), 'orrery');
  assert.equal(page.api.current(), 'orrery');
  assert.equal(page.api.set('nonsense'), 'system');
  assert.equal(store.data.has('orrery.theme'), false, 'following the system stores nothing');
  assert.equal(page.theme(), null);
  // Another tab chose dark: the storage event brings this page along.
  store.data.set('orrery.theme', 'dark');
  page.fire('orrery.theme');
  assert.equal(page.theme(), 'dark');
  page.fire('something.else');
  store.data.clear();
  page.fire(null);
  assert.equal(page.theme(), null, 'cleared storage: back to the system');
});

test('theme: when storage refuses the write, the dialog still shows the theme this page applied', () => {
  const refusing = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('quota'); } };
  const page = themeContext(refusing);
  const radios = ['system', 'light', 'dark'].map((value) => ({ value, checked: false, on: {} as Record<string, () => void>,
    addEventListener(type: string, fn: () => void) { this.on[type] = fn; } }));
  const tab = { id: 'settings-tab-appearance', tabIndex: 0, getAttribute: () => 'panel', setAttribute() {}, addEventListener() {}, focus() {} };
  const dialog = {
    querySelectorAll: (selector: string) => (selector === '[role="tab"]' ? [tab] : radios),
    querySelector: (selector: string) => ['#ui-language', '#language-note'].includes(selector) ? null : (selector === '#panel' ? { hidden: true } : { scrollTop: 0, setAttribute() {} }),
  };
  const frame = settings.initSettings(dialog, page.api);
  assert.equal(radios.find((r) => r.checked)?.value, 'system');
  const dark = radios[2];
  dark.checked = true;
  dark.on.change();
  assert.equal(page.theme(), 'dark', 'the page switched');
  assert.equal(page.api.stored(), 'system', 'storage kept nothing');
  for (const r of radios) r.checked = false;
  frame.opened();   // the dialog is opened again
  assert.equal(radios.find((r) => r.checked)?.value, 'dark', 'the control shows what is applied, not what storage holds');
  assert.equal(page.api.current(), 'dark');
});

test('theme: an explicit choice decides color-scheme; no stylesheet or script reads the system scheme on its own', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<script src="\/theme\.js"><\/script>\s*<link rel="stylesheet" href="\/style\.css">/, 'theme.js runs before the styles, not deferred');
  assert.doesNotMatch(html, /<script>(?!<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
  const style = read('style.css');
  assert.match(style, /:root \{\s*color-scheme: light dark;/);
  assert.match(style, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(style, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  // 星仪 is a dark palette; following the system never picks it (no attribute: light-dark() decides light or dark).
  assert.match(style, /:root\[data-theme="orrery"\] \{\s*color-scheme: dark;/);
  for (const file of readdirSync(pub).filter((f) => f.endsWith('.css'))) {
    const css = read(file);
    // Themed colours use light-dark(); a prefers-color-scheme block would ignore the user's choice unless it is
    // guarded and mirrored by a data-theme rule.
    const blocks = css.match(/@media[^{]*prefers-color-scheme:\s*dark[^{]*\{/g) ?? [];
    if (blocks.length) {
      assert.match(css, /:root:not\(\[data-theme="light"\]\)/, `${file}: dark media blocks must be guarded`);
      assert.match(css, /\[data-theme="dark"\]/, `${file}: dark media blocks need a data-theme counterpart`);
    }
    if (file !== 'style.css') {
      assert.doesNotMatch(css, /color-scheme\s*:/, `${file}: only :root sets color-scheme, so no element falls back to the system scheme`);
    }
  }
  for (const file of readdirSync(pub).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(read(file), /prefers-color-scheme/, `${file} must not read the system scheme directly`);
  }
  // The choice is in the dialog as three real radios.
  const dialog = html.slice(html.indexOf('<dialog id="settings-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="settings-dialog"')));
  assert.deepEqual([...dialog.matchAll(/<input type="radio" name="theme" value="(\w+)">/g)].map((m) => m[1]), ['system', 'light', 'dark', 'orrery']);
});

test('settings dialog: every element app.js looks up by id still exists, the settings ones inside the dialog', () => {
  const html = read('index.html');
  const app = read('app.js');
  const ids = [...new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `#${id} (used by app.js) is in index.html`);
  const dialog = html.slice(html.indexOf('<dialog id="settings-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="settings-dialog"')));
  // LIMIT_FORMS and NOTIFY_FORMS reach their parts through a template; the others are literal.
  const templated = [...['hop', 'chain'].flatMap((p) => ['', '-label', '-source', '-form', '-value', '-unlimited', '-save', '-error'].map((s) => p + s)),
    ...['', '-label', '-source', '-form', '-value', '-save', '-error'].map((s) => 'stalled' + s)];
  assert.match(app, /\{ setting: 'maxHops', id: 'hop', stale: true \}/);
  assert.match(app, /\{ setting: 'stalledMemberMinutes', id: 'stalled', stale: true \}/);
  for (const id of [...templated, 'limits', 'notifications', 'usage-alert-form', 'usage-alert-turn', 'usage-alert-conversation', 'usage-alert-save',
    'usage-alert-error', 'plugin-list', 'settings-pause', 'settings-close', 'settings-title']) {
    assert.ok(dialog.includes(`id="${id}"`), `#${id} is in the settings dialog`);
  }
  // Each tab names a panel that exists, and only the first panel starts visible.
  const tabs = [...dialog.matchAll(/role="tab" aria-controls="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['settings-panel-appearance', 'settings-panel-limits', 'settings-panel-alerts', 'settings-panel-plugins', 'settings-panel-delivery']);
  for (const panel of tabs) assert.match(dialog, new RegExp(`<section id="${panel}" [^>]*role="tabpanel"`));
  assert.match(app, /const settingsFrame = initSettings\(settingsDialog, undefined, \{ beforeLanguageChange: confirmLanguageReload \}\);/);
});
