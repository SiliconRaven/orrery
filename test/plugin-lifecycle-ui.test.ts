// The third-party plugin card's lifecycle part (plugins.js, docs/external-plugins.md「生命周期」), in node against a small
// fake DOM: which buttons each state offers, the switches, the restart notes, and the sequencing that keeps an older
// state (an HTTP answer or a stream frame, whichever arrives last) from overwriting a newer one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; on: Record<string, (event?: any) => void>; focused?: boolean;
  setAttribute(k: string, v: string): void; addEventListener(k: string, f: (event?: any) => void): void; append(...c: (El | string)[]): void;
  focus(): void; showModal(): void; remove(): void };
const created: El[] = [];
const body: El[] = [];
(globalThis as any).document = {
  activeElement: null, body: { append: (dialog: El) => body.push(dialog) },
  createElement: (tag: string): El => {
    const el: El = { tag, attrs: {}, kids: [], on: {},
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.on[k] = f; }, append(...c) { this.kids.push(...c); },
      focus() { this.focused = true; }, showModal() {}, remove() {} };
    created.push(el);
    return el;
  },
  createElementNS: (_ns: string, tag: string) => (globalThis as any).document.createElement(tag),
};
const text = (e: El | string): string => (typeof e === 'string' ? e : e.kids.map(text).join(''));
const all = (e: El | string): El[] => (typeof e === 'string' ? [] : [e, ...e.kids.flatMap(all)]);
const plugins = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'plugins.js')).href);

const life = (over: object = {}) => ({ hub: 'run-1', seq: 1, autoRestart: false, devReload: false, autoRestarts: 0, maxAutoRestarts: 3,
  backoffSeconds: [2, 10, 60], windowMinutes: 10, restartAt: null, gaveUp: false, lastFailure: null, shutdownGraceMs: 5000, devReloadError: null, ...over });
const plugin = (over: object = {}) => ({ id: 'p', name: '插件', version: '1.0.0', requires: [], description: '', details: '', iconUrl: null,
  enabled: true, disabledByEnv: false, pendingEnabled: true, origin: 'external', permissions: [], clusterIds: [], commands: [],
  runtime: { state: 'ready', error: null, errorCode: null }, lifecycle: life(), ...over });
const buttons = (e: El) => all(e).filter((x) => x.tag === 'button' && x.attrs['data-plugin-action']).map((x) => x.attrs['data-plugin-action']);

test('sequencing: a newer seq of the same Hub run wins, an older or equal one does not, another run always does', () => {
  const at = (seq: number, hub = 'run-1') => ({ lifecycle: { hub, seq } });
  assert.equal(plugins.newerState(at(3), at(4)), true);
  assert.equal(plugins.newerState(at(4), at(3)), false, 'an older snapshot never overwrites a newer one');
  assert.equal(plugins.newerState(at(4), at(4)), false);
  assert.equal(plugins.newerState(at(9), at(1, 'run-2')), true, 'the Hub restarted: its seq starts again');
  assert.equal(plugins.newerState({}, at(1)), true);
  assert.equal(plugins.newerState(at(1), {}), false, 'no state, nothing to take');

  const list = [plugin({ lifecycle: life({ seq: 5 }) }), plugin({ id: 'q' })];
  const older = { id: 'p', enabled: false, runtime: { state: 'stopped' }, lifecycle: life({ seq: 4 }) };
  assert.equal(plugins.applyStateFrame(list, older), list, 'older: the same array, nothing redrawn');
  assert.equal(plugins.applyStateFrame(list, { ...older, id: 'none', lifecycle: life({ seq: 9 }) }), list, 'unknown plugin');
  const newer = plugins.applyStateFrame(list, { ...older, lifecycle: life({ seq: 6 }) });
  assert.deepEqual([newer[0].runtime.state, newer[0].enabled, newer[0].lifecycle.seq, newer[0].name], ['stopped', false, 6, '插件']);
  assert.equal(newer[1], list[1]);

  // An HTTP answer read before a frame that arrived first: the frame's newer state stays, the rest comes from the answer.
  const answer = [plugin({ description: '新的说明', runtime: { state: 'starting' }, lifecycle: life({ seq: 5 }) })];
  const merged = plugins.mergeInstalled(newer, answer);
  assert.deepEqual([merged[0].runtime.state, merged[0].lifecycle.seq, merged[0].description], ['stopped', 6, '新的说明']);
  const later = plugins.mergeInstalled(newer, [plugin({ runtime: { state: 'ready' }, lifecycle: life({ seq: 7 }) })]);
  assert.equal(later[0].runtime.state, 'ready', 'a newer answer wins');
  // A list from another Hub run (the Hub restarted, the page stayed open) always replaces, whatever the seqs.
  const restarted = plugins.mergeInstalled(newer, [plugin({ runtime: { state: 'starting' }, enabled: true, lifecycle: life({ hub: 'run-2', seq: 1 }) })]);
  assert.deepEqual([restarted[0].runtime.state, restarted[0].lifecycle.hub, restarted[0].enabled], ['starting', 'run-2', true]);
  // A frame from another run than the list's is taken too: it is the live Hub speaking.
  assert.equal(plugins.applyStateFrame(restarted, { id: 'p', enabled: true, runtime: { state: 'ready' }, lifecycle: life({ hub: 'run-3', seq: 1 }) })[0].runtime.state, 'ready');
});

test('the buttons each state offers', () => {
  const actions = (state: string, over: object = {}) => plugins.lifecycleActions(plugin({ runtime: { state }, ...over }));
  assert.deepEqual(actions('ready'), ['stop', 'restart']);
  assert.deepEqual(actions('starting'), ['stop', 'restart']);
  assert.deepEqual(actions('stopping'), [], 'a stop under way: wait');
  assert.deepEqual(actions('stopped'), ['start']);
  assert.deepEqual(actions('disabled'), ['start']);
  assert.deepEqual(actions('failed'), ['start']);
  assert.deepEqual(actions('failed', { lifecycle: life({ restartAt: '2026-11-17T10:00:00.000Z' }) }), ['start', 'stop'], 'stop cancels the planned restart');
  assert.deepEqual(actions('stopped', { disabledByEnv: true }), [], 'the variable wins');
  assert.deepEqual(actions('failed', { unavailable: true }), [], 'skipped at start-up: a Hub restart');
});

test('the live part: state, error, restart notes, buttons and switches, all as text; clicks call act', () => {
  const calls: unknown[][] = [];
  const act = (...args: unknown[]) => calls.push(args);
  const view = plugins.pluginRuntimeView(plugin(), false, act);
  assert.equal(view.attrs['data-plugin-live'], 'p');
  assert.match(text(view), /外部进程：ready/);
  assert.match(text(view), /停止时最多等 5 秒/);
  assert.deepEqual(buttons(view), ['stop', 'restart']);
  all(view).find((x) => x.attrs['data-plugin-action'] === 'restart')!.on.click();
  const auto = all(view).find((x) => x.attrs['data-plugin-switch'] === 'autoRestart')!;
  assert.equal(auto.attrs.role, 'switch');
  assert.equal(auto.attrs.checked, undefined, 'off by default');
  auto.on.change({ target: { checked: true } });
  const dev = all(view).find((x) => x.attrs['data-plugin-switch'] === 'devReload')!;
  dev.on.change({ target: { checked: true } });
  assert.deepEqual(calls.map(([p, a]) => [(p as any).id, a]), [['p', 'restart'], ['p', { autoRestart: true }], ['p', { devReload: true }]]);
  assert.match(text(view), /开发用：文件改动后自动重启/);

  const evil = '<img src=x onerror=alert(1)>';
  const waiting = plugins.pluginRuntimeView(plugin({ runtime: { state: 'failed', error: evil, errorCode: 'PROCESS_EXITED' },
    lifecycle: life({ autoRestart: true, autoRestarts: 1, restartAt: '2026-11-17T10:00:00.000Z', lastFailure: { at: '2026-11-17T09:59:58.000Z', errorCode: 'PROCESS_EXITED', error: evil } }) }), false, act);
  assert.match(text(waiting), /外部进程错误：<img src=x onerror=alert\(1\)> \[PROCESS_EXITED\]/, 'the error is text');
  assert.match(text(waiting), /将在 .+ 自动重启（10 分钟内第 2 次，最多 3 次）/);
  assert.ok(!all(waiting).some((x) => x.tag === 'img' || x.tag === 'script'));
  assert.equal(all(waiting).find((x) => x.attrs['data-plugin-switch'] === 'autoRestart')!.attrs.checked, '');
  const gaveUp = plugins.pluginRuntimeView(plugin({ runtime: { state: 'failed', error: 'x', errorCode: 'TIMEOUT' }, lifecycle: life({ gaveUp: true }) }), false, act);
  assert.match(text(gaveUp), /10 分钟内已自动重启 3 次仍然出错，不再自动重启/);
  const recovered = plugins.pluginRuntimeView(plugin({ lifecycle: life({ autoRestarts: 2, lastFailure: { at: '2026-11-17T09:59:58.000Z', errorCode: 'CHECK_TIMEOUT', error: 'checks' } }) }), false, act);
  assert.match(text(recovered), /10 分钟内已自动重启 2 次/);
  assert.match(text(recovered), /上次出错：.+ checks \[CHECK_TIMEOUT\]/);
  const watchBroken = plugins.pluginRuntimeView(plugin({ lifecycle: life({ devReload: true, devReloadError: '无法监视插件目录' }) }), false, act);
  assert.match(text(watchBroken), /无法监视插件目录/);
  const total = plugins.pluginRuntimeView(plugin({ runtime: { state: 'failed', error: 'x', errorCode: 'PROCESS_EXITED' },
    lifecycle: life({ autoRestart: true, gaveUp: true, gaveUpReason: 'total', autoRestartsTotal: 10, maxAutoRestartsTotal: 10 }) }), false, act);
  assert.match(text(total), /自动重启已达累计上限：自你上次启动以来已自动重启 10 次/);
  assert.match(text(total), /自动重启累计：已用 10 次，还剩 0 次（共 10 次/);
  const budget = plugins.pluginRuntimeView(plugin({ lifecycle: life({ autoRestart: true, autoRestartsTotal: 3, maxAutoRestartsTotal: 10 }) }), false, act);
  assert.match(text(budget), /已用 3 次，还剩 7 次/);
  const paused = plugins.pluginRuntimeView(plugin({ lifecycle: life({ devReload: true, reloadPaused: true }) }), false, act);
  assert.match(text(paused), /开发重载已暂停：重启过于频繁/);
  const kept = plugins.pluginRuntimeView(plugin({ lifecycle: life({ registrationError: 'bad JSON' }) }), false, act);
  assert.match(text(kept), /重新读取登记失败，插件仍按原来的登记运行：bad JSON/);
  assert.match(text(kept), /外部进程：ready/);

  const busy = plugins.pluginRuntimeView(plugin(), true, act);
  assert.ok(all(busy).filter((x) => x.tag === 'button' || x.tag === 'input').every((x) => x.attrs.disabled === ''), 'everything waits while a request is out');
  const card = plugins.pluginRow(plugin(), [plugin()], false, () => {}, () => {}, new Set(), act);
  assert.ok(all(card).some((x) => x.attrs['data-plugin-live'] === 'p'), 'the card holds the live part');
  assert.ok(all(card).some((x) => x.attrs['data-plugin-state-chip'] === 'p'));
  const official = plugins.pluginRow(plugin({ origin: undefined }), [], false, () => {});
  assert.deepEqual(buttons(official), [], 'official plugins have no lifecycle buttons');
});

test('createPluginSettings: the buttons and switches call their routes; a slow answer never undoes a newer frame', async () => {
  const cardsOf = (e: El | string): El[] => typeof e === 'string' ? [] : e.tag === 'article' ? [e] : e.kids.flatMap(cardsOf);
  let rows: El[] = [];
  const list = { replaceChildren: (...groups: El[]) => { rows = groups.flatMap(cardsOf); }, querySelector: () => undefined };
  const calls: unknown[][] = [];
  let answer: () => Promise<unknown> = async () => ({ installed: [plugin({ lifecycle: life({ seq: 1 }) })] });
  const settings = plugins.createPluginSettings(async (...args: unknown[]) => { calls.push(args); return answer(); }, list);
  // A frame before the first list arrives is kept, and wins over the older list read by the frame rule.
  settings.applyState({ id: 'p', enabled: true, runtime: { state: 'starting', error: null, errorCode: null }, lifecycle: life({ seq: 0 }) });
  settings.applyState({ id: 'p', enabled: true, runtime: { state: 'stopped', error: null, errorCode: null }, lifecycle: life({ seq: 2 }) });
  settings.applyState({ id: 'p', enabled: true, runtime: { state: 'starting', error: null, errorCode: null }, lifecycle: life({ seq: 1 }) });
  await settings.load();
  assert.match(text(rows[0]), /外部进程：stopped/, 'the newest early frame (seq 2) over the list (seq 1)');
  answer = async () => ({ installed: [plugin({ lifecycle: life({ seq: 1, hub: 'run-0' }) })] });
  await settings.load();   // another run's list replaces; the early frame was used once and forgotten
  assert.match(text(rows[0]), /外部进程：ready/);
  answer = async () => ({ installed: [plugin({ lifecycle: life({ seq: 1 }) })] });
  await settings.load();
  assert.match(text(rows[0]), /外部进程：ready/);

  // The user stops it; while the request is out a frame says "stopping" (seq 3) and then "stopped" (seq 4); the
  // answer, read between them (seq 3), arrives last and must not undo "stopped".
  let release: () => void = () => {};
  answer = () => new Promise((ok) => { release = () => ok({ installed: [plugin({ runtime: { state: 'stopping' }, lifecycle: life({ seq: 3 }) })] }); });
  const stop = all(rows[0]).find((x) => x.attrs['data-plugin-action'] === 'stop')!;
  const stopping = stop.on.click();
  assert.equal(all(rows[0]).find((x) => x.attrs['data-plugin-action'] === 'stop')!.attrs.disabled, '', 'busy while the request is out');
  settings.applyState({ id: 'p', enabled: false, runtime: { state: 'stopping', error: null, errorCode: null }, lifecycle: life({ seq: 3 }) });
  settings.applyState({ id: 'p', enabled: false, runtime: { state: 'stopped', error: null, errorCode: null }, lifecycle: life({ seq: 4 }) });
  release();
  await stopping;
  assert.deepEqual(calls.at(-1), ['POST', '/api/plugins/p/stop', {}]);
  assert.match(text(rows[0]), /外部进程：stopped/, 'the newer frame stays');
  assert.deepEqual(buttons(rows[0]), ['start']);

  answer = async () => ({ installed: [plugin({ lifecycle: life({ seq: 6, autoRestart: true }) })] });
  await all(rows[0]).find((x) => x.attrs['data-plugin-switch'] === 'autoRestart')!.on.change({ target: { checked: true } });
  assert.deepEqual(calls.at(-1), ['PATCH', '/api/plugins/p/lifecycle', { autoRestart: true }]);
  await all(rows[0]).find((x) => x.attrs['data-plugin-action'] === 'stop')!.on.click();
  assert.deepEqual(calls.at(-1), ['POST', '/api/plugins/p/stop', {}]);

  // A refused start shows the Hub's sentence in a page dialog and draws the last good state again.
  answer = async () => { throw new Error('它依赖的插件没有在运行：base。先启动它们。'); };
  const before = text(rows[0]);
  const refused = all(rows[0]).find((x) => x.attrs['data-plugin-action'] === 'restart')!.on.click();
  await new Promise((ok) => setImmediate(ok));
  assert.match(text(body.at(-1)!), /重启插件失败.*依赖的插件没有在运行/);
  (body.at(-1) as any).returnValue = '';
  body.at(-1)!.on.close();
  await refused;
  assert.equal(text(rows[0]), before);
});

test('a frame buffered from an earlier Hub run never overrides the new run\'s first list', async () => {
  const cardsOf = (e: El | string): El[] => typeof e === 'string' ? [] : e.tag === 'article' ? [e] : e.kids.flatMap(cardsOf);
  let rows: El[] = [];
  const list = { replaceChildren: (...groups: El[]) => { rows = groups.flatMap(cardsOf); }, querySelector: () => undefined };
  const settings = plugins.createPluginSettings(async () => ({ installed: [plugin({ lifecycle: life({ hub: 'run-2', seq: 1 }) })] }), list);
  // The old run's closing frames arrive while the settings were never opened (nothing listed yet).
  settings.applyState({ id: 'p', enabled: false, runtime: { state: 'stopped', error: null, errorCode: null }, lifecycle: life({ hub: 'run-1', seq: 99 }) });
  await settings.load();
  assert.match(text(rows[0]), /外部进程：ready/, 'the old run\'s buffered frame is dropped');
  // The buffer was emptied: a later list of the same run is not changed by it either.
  await settings.load();
  assert.match(text(rows[0]), /外部进程：ready/);
});
