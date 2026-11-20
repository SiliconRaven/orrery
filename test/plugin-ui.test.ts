// A third-party plugin's own web UI, Hub side (docs/external-plugins.md「网页界面」): the manifest and grant, the static
// files of its ui/ folder (paths, links, types, sizes, frame ids, the headers of every answer, no login), and the one
// channel (frame request → plugin, plugin push → the right frames only, chips, every refusal, limits, the timeout, and
// revocation when the plugin stops, its UI is switched off or the Hub restarts). The real browser part is
// plugin-ui-browser.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { readExternalPlugins } from '../src/core/external-plugin-config.ts';
import { chipText, UI_LIMITS, uiFramePolicy } from '../src/core/external-plugin-ui.ts';
import { Store } from '../src/core/store.ts';
import { REPO_ROOT } from '../src/main.ts';
import { openSse, rawFetch, startTestHub, tempDir, TEST_TOKEN, waitFor, bearer, type TestHub } from './helpers.ts';

const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'ui-probe');
type Plugin = { id: string; grant?: Record<string, unknown>; manifest?: (m: Record<string, any>) => void };

/** Clusters c1, c2 (both granted by default) and c3 (never); one copy of the fixture per plugin, registered and granted. */
function prepare(dir: string, plugins: Plugin[] = [{ id: 'ui-probe' }]) {
  mkdirSync(join(dir, 'home'), { recursive: true });
  const seed = new Store(join(dir, 'test.db'));
  for (const id of ['c1', 'c2', 'c3']) seed.insertCluster({ id, name: `群 ${id}`, category: '', createdAt: '2026-01-01' }, []);
  seed.close();
  const folders: Record<string, string> = {};
  const entries = plugins.map(({ id, grant, manifest }) => {
    const folder = join(dir, 'plugins', id);
    cpSync(FIXTURE, folder, { recursive: true });
    const m = JSON.parse(readFileSync(join(folder, 'orrery-plugin.json'), 'utf8'));
    m.id = id;
    manifest?.(m);
    writeFileSync(join(folder, 'orrery-plugin.json'), JSON.stringify(m));
    folders[id] = folder;
    return { manifest: join(folder, 'orrery-plugin.json'), permissions: ['ui.show'], ui: ['titlebar', 'workbench'], clusterIds: ['c1', 'c2'], ...grant };
  });
  writeFileSync(join(dir, 'home', 'external-plugins.json'), JSON.stringify({ plugins: entries }));
  return folders;
}

async function hub(plugins?: Plugin[], dir = tempDir()) {
  const folders = prepare(dir, plugins);
  const app = await startTestHub({ dir, pluginLifecycle: { uiTimeoutMs: 600 } });
  await waitFor(async () => (await app.api('GET', '/api/plugins')).installed.filter((p: any) => p.origin === 'external')
    .every((p: any) => p.runtime?.state === 'ready'), 'the plugins to be ready');
  return { app, folders, dir };
}

/** A GET with the path sent exactly as written (fetch would normalise `..`), and the given headers. */
function raw(url: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function call(app: TestHub, method: string, path: string, body?: unknown) {
  const res = await fetch(app.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() as any };
}
const open = (app: TestHub, clusterId: string, pluginId = 'ui-probe', position = 'titlebar') =>
  call(app, 'POST', `/api/clusters/${clusterId}/plugin-ui/frames`, { pluginId, position });
const ask = (app: TestHub, frameId: string, data: unknown) => call(app, 'POST', `/api/plugin-ui/frames/${frameId}/request`, { data });
const hostCall = async (app: TestHub, method: string, params: unknown, plugin = 'ui-probe') =>
  (await app.api('POST', `/api/plugins/${plugin}/invoke`, { command: 'raw', arguments: { method, params } })).result;
const received = async (app: TestHub, plugin = 'ui-probe') =>
  (await app.api('POST', `/api/plugins/${plugin}/invoke`, { command: 'requests', arguments: {} })).result.requests;

/** The policy, nosniff and no-referrer on an answer from /plugin-ui/. */
function framed(res: { headers: IncomingHttpHeaders }, url: string, frameId: string) {
  const host = new URL(url).host;
  assert.equal(res.headers['content-security-policy'], uiFramePolicy(`http://${host}/plugin-ui/${frameId}/`));
  assert.match(String(res.headers['content-security-policy']), /^sandbox allow-scripts; default-src 'none'; script-src http:\/\/127\.0\.0\.1:\d+\/plugin-ui\//);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
}

test('ui manifest and grant: declared positions only, ui.show needed on both sides, panel height bounded', () => {
  const write = (plugins: Plugin[]) => { const dir = tempDir(); prepare(dir, plugins); return readExternalPlugins(join(dir, 'home')); };
  const ok = write([{ id: 'ui-probe' }]);
  assert.deepEqual(ok.installations[0].ui, ['titlebar', 'workbench']);
  assert.deepEqual(ok.installations[0].manifest.ui, { positions: ['titlebar', 'workbench'], panelHeight: 260 });
  const skipped = (plugins: Plugin[], pattern: RegExp) => {
    const result = write(plugins);
    assert.equal(result.installations.length, 0);
    assert.match(result.failures[0].error, pattern);
  };
  skipped([{ id: 'ui-probe', manifest: (m) => { m.permissions = []; } }], /ui needs the ui.show permission/);
  skipped([{ id: 'ui-probe', manifest: (m) => { m.ui.panelHeight = 600; } }], /panelHeight/);
  skipped([{ id: 'ui-probe', manifest: (m) => { m.ui.positions = ['sidebar']; } }], /positions/);
  skipped([{ id: 'ui-probe', manifest: (m) => { m.ui.extra = 1; } }], /invalid ui declaration/);
  skipped([{ id: 'ui-probe', manifest: (m) => { m.ui.positions = ['titlebar']; } }], /ui grant was not declared/);
  skipped([{ id: 'ui-probe', grant: { permissions: [] } }], /granted ui positions need the ui.show permission/);
  // Granted without positions, or positions omitted: no UI anywhere (omitted means none, never all).
  assert.deepEqual(write([{ id: 'ui-probe', grant: { ui: undefined } }]).installations[0].ui, []);
});

test('ui frames: starmap has its own grant and uses the same sandbox, channel and revocation', async () => {
  const manifest = (m: Record<string, any>) => { m.ui.positions = ['titlebar', 'workbench', 'starmap']; };
  const { app } = await hub([
    { id: 'ui-star', manifest, grant: { ui: ['starmap'] } },
    { id: 'ui-declared', manifest },
  ]);
  const sse = openSse(`${app.url}/api/stream`, bearer(TEST_TOKEN));
  try {
    await sse.status;
    const items = (await app.api('GET', '/api/clusters/c1/plugin-ui')).items;
    assert.deepEqual(items.map((item: any) => [item.pluginId, item.positions]),
      [['ui-star', ['starmap']], ['ui-declared', ['titlebar', 'workbench']]]);
    for (const [cluster, id] of [['c1', 'ui-declared'], ['c3', 'ui-star']]) {
      const denied = await open(app, cluster, id, 'starmap');
      assert.equal(denied.status, 409);
      assert.equal(denied.data.code, 'NOT_GRANTED');
    }
    const opened = await open(app, 'c1', 'ui-star', 'starmap');
    assert.equal(opened.status, 200);
    const { frameId, url, position } = opened.data;
    assert.equal(position, 'starmap');
    const asset = await raw(app.url, url);
    assert.equal(asset.status, 200);
    framed(asset, app.url, frameId);
    assert.deepEqual((await ask(app, frameId, { probe: true })).data.result, { echo: { probe: true }, position: 'starmap', clusterId: 'c1' });
    assert.deepEqual(await hostCall(app, 'host.ui.push', { clusterId: 'c1', position: 'starmap', data: 'probe' }, 'ui-star'),
      { result: { delivered: 1 } });

    await app.api('PATCH', '/api/plugins/ui-star/lifecycle', { ui: false });
    const revoked = await waitFor(() => sse.events.find((e) => e.event === 'plugin-ui' && e.data.kind === 'revoked'), 'starmap frame revocation');
    assert.deepEqual(revoked.data, { kind: 'revoked', pluginId: 'ui-star', frameIds: [frameId], reason: 'UI_OFF' });
    assert.equal((await raw(app.url, url)).status, 404);
    assert.equal((await ask(app, frameId, {})).data.code, 'FRAME_CLOSED');
  } finally { sse.close(); await app.close(); }
});

test('ui files: served from ui/ only, every answer carries the frame policy, no login is looked at, ids die with the frame', async () => {
  const { app, folders } = await hub();
  try {
    const folder = folders['ui-probe'];
    const opened = await open(app, 'c1');
    assert.equal(opened.status, 200);
    const { frameId, url } = opened.data;
    assert.match(frameId, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(url, `/plugin-ui/${frameId}/index.html`);
    assert.equal(opened.data.panelHeight, 260);
    const base = `/plugin-ui/${frameId}/`;

    // The entry and its parts, each with its fixed type; every answer framed. No cookie or token is needed or used.
    for (const [file, type] of [['index.html', 'text/html; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'],
      ['probe.js', 'text/javascript; charset=utf-8'], ['mod.js', 'text/javascript; charset=utf-8'], ['dot.png', 'image/png']]) {
      const res = await raw(app.url, base + file);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers['content-type'], type, file);
      framed(res, app.url, frameId);
    }
    // A cookie or token makes no difference, a missing one neither; an opaque origin's CORS request is answered.
    const index = (await raw(app.url, `${base}index.html`)).body;
    const variants: Record<string, string>[] = [{ cookie: `orrery_${new URL(app.url).port}=${TEST_TOKEN}` }, bearer(TEST_TOKEN), { cookie: 'orrery_1=wrong' }, { origin: 'null' }];
    for (const headers of variants) {
      const res = await raw(app.url, `${base}index.html`, headers);
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.equal(res.body, index);
      framed(res, app.url, frameId);
    }
    assert.equal((await raw(app.url, `${base}mod.js`, { origin: 'null' })).headers['access-control-allow-origin'], 'null', 'only an opaque origin may read it');
    assert.equal((await raw(app.url, `${base}index.html`, { host: 'evil.example:80' })).status, 403, 'the Host check stays');
    assert.equal((await raw(app.url, `${base}index.html`, { origin: 'http://evil.example' })).status, 403, 'only Origin: null is let past');
    // The checks look at the parsed path, as the routing does: `..` cannot carry a request past the Origin check.
    assert.equal((await raw(app.url, '/plugin-ui/../api/state', { origin: 'http://evil.example', ...bearer(TEST_TOKEN) })).status, 403);
    assert.equal((await raw(app.url, '/plugin-ui/../api/state', { origin: 'null', ...bearer(TEST_TOKEN) })).status, 403);

    // Outside ui/, odd paths, other types, hidden files, too large: 404, and still framed.
    writeFileSync(join(folder, 'ui', 'notes.txt'), 'text');
    writeFileSync(join(folder, 'ui', '.hidden.js'), '1');
    writeFileSync(join(folder, 'ui', 'big.js'), Buffer.alloc(UI_LIMITS.maxFileBytes + 1, 32));
    writeFileSync(join(folder, 'secret.js'), 'outside');
    mkdirSync(join(folder, 'ui', 'sub'));
    writeFileSync(join(folder, 'ui', 'sub', 'ok.js'), '1');
    assert.equal((await raw(app.url, `${base}sub/ok.js`)).status, 200, 'a sub-folder is fine');
    // `..` that stays inside the prefix is resolved as a browser would (URL parsing), and stays inside ui/.
    assert.equal((await raw(app.url, `${base}sub/../index.html`)).body, index);
    for (const path of ['../orrery-plugin.json', '..%2forrery-plugin.json', '%2e%2e/secret.js', '%2e%2e%2fsecret.js', '..%5csecret.js',
      'sub%5c..%5c..%5csecret.js', 'C:%5cWindows%5cwin.ini', '%2fetc%2fpasswd', 'index.html%00', 'index.html.', 'index.html::$DATA',
      'notes.txt', '.hidden.js', 'big.js', 'main.mjs', '', 'sub/', 'con.js', 'INDEX~1.HTM', 'index.html%3fx=1', 'sub/../../secret.js']) {
      const res = await raw(app.url, base + path);
      assert.equal(res.status, 404, path);
      assert.match(String(res.headers['content-security-policy']), /^sandbox allow-scripts; default-src 'none'; script-src http:\/\/127\.0\.0\.1:\d+\/plugin-ui\//, path);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', path);
    }

    // Links are never followed: a junction (a folder link anyone may make on Windows) and, where allowed, a file link.
    mkdirSync(join(folder, 'outside'));
    writeFileSync(join(folder, 'outside', 'x.js'), 'outside');
    symlinkSync(join(folder, 'outside'), join(folder, 'ui', 'linked'), 'junction');
    assert.equal((await raw(app.url, `${base}linked/x.js`)).status, 404, 'through a junction');
    let fileLink = true;
    try { symlinkSync(join(folder, 'secret.js'), join(folder, 'ui', 'link.js'), 'file'); } catch { fileLink = false; }
    if (fileLink) assert.equal((await raw(app.url, `${base}link.js`)).status, 404, 'a file link');

    // Wrong, closed and revoked ids: 404, framed.
    for (const path of ['/plugin-ui/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/index.html', '/plugin-ui/x/index.html', '/plugin-ui/', `/plugin-ui/${frameId}`]) {
      const res = await raw(app.url, path);
      assert.equal(res.status, 404, path);
      assert.match(String(res.headers['content-security-policy']), /^sandbox allow-scripts; default-src 'none';/);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
    assert.equal((await call(app, 'DELETE', `/api/plugin-ui/frames/${frameId}`, {})).status, 200);
    assert.equal((await raw(app.url, `${base}index.html`)).status, 404, 'closed');
    const again = (await open(app, 'c1')).data.frameId;
    await app.api('POST', '/api/plugins/ui-probe/stop', {});
    assert.equal((await raw(app.url, `/plugin-ui/${again}/index.html`)).status, 404, 'revoked when the plugin stopped');
    await app.api('POST', '/api/plugins/ui-probe/start', {});
    const fresh = (await open(app, 'c1')).data.frameId;
    assert.notEqual(fresh, again);
    assert.equal((await raw(app.url, `/plugin-ui/${fresh}/index.html`)).status, 200, 'a new id after the restart');

    // The whole folder is checked when a frame opens: too many bytes, or no entry.
    rmSync(join(folder, 'ui', 'big.js'));
    for (let i = 0; i < 5; i++) writeFileSync(join(folder, 'ui', `part${i}.js`), Buffer.alloc(UI_LIMITS.maxFileBytes - 1, 32));
    const tooBig = await open(app, 'c1');
    assert.equal(tooBig.status, 409);
    assert.equal(tooBig.data.code, 'FILES_INVALID');
    for (let i = 0; i < 5; i++) rmSync(join(folder, 'ui', `part${i}.js`));
    rmSync(join(folder, 'ui', 'index.html'));
    const missing = await open(app, 'c1');
    assert.equal(missing.status, 409);
    assert.equal(missing.data.code, 'FILES_MISSING');
  } finally {
    await app.close();
  }
});

test('ui files: ui/ itself as a junction is refused', async () => {
  const { app, folders } = await hub();
  try {
    const folder = folders['ui-probe'];
    cpSync(join(folder, 'ui'), join(folder, 'real-ui'), { recursive: true });
    rmSync(join(folder, 'ui'), { recursive: true });
    symlinkSync(join(folder, 'real-ui'), join(folder, 'ui'), 'junction');
    const refused = await open(app, 'c1');
    assert.equal(refused.data.code, 'FILES_MISSING');
  } finally {
    await app.close();
  }
});

test('ui frames: who may open one, in the documented order; the list says what each cluster offers', async () => {
  const { app } = await hub([{ id: 'ui-probe' }, { id: 'ui-bar', grant: { ui: ['titlebar'] } }, { id: 'ui-none', grant: { permissions: [], ui: [] } }]);
  try {
    const items = (await app.api('GET', '/api/clusters/c1/plugin-ui')).items;
    assert.deepEqual(items.map((i: any) => [i.pluginId, i.positions, i.running, i.on, i.chip]),
      [['ui-probe', ['titlebar', 'workbench'], true, true, null], ['ui-bar', ['titlebar'], true, true, null]], 'ui-none is granted no UI');
    assert.deepEqual((await app.api('GET', '/api/clusters/c3/plugin-ui')).items, [], 'c3 is in no read whitelist');
    assert.equal((await call(app, 'GET', '/api/clusters/nope/plugin-ui')).status, 404);
    // The settings card's view of it.
    const row = (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'ui-bar');
    assert.deepEqual(row.ui, { positions: ['titlebar', 'workbench'], granted: ['titlebar'], panelHeight: 260 });
    assert.equal(row.lifecycle.ui, true);

    const refused = async (result: Promise<{ status: number; data: any }>, status: number, code: string) => {
      const { status: s, data } = await result;
      assert.equal(s, status, code);
      assert.equal(data.code, code);
    };
    await refused(call(app, 'POST', '/api/clusters/c1/plugin-ui/frames', { pluginId: 'ui-probe', position: 'sidebar' }), 400, 'INVALID_REQUEST');
    await refused(call(app, 'POST', '/api/clusters/c1/plugin-ui/frames', { pluginId: 'ui-probe', position: 'titlebar', clusterId: 'c2' }), 400, 'INVALID_REQUEST');
    await refused(open(app, 'c1', 'nobody'), 404, 'UNKNOWN_PLUGIN');
    await refused(open(app, 'c3'), 409, 'NOT_GRANTED');
    await refused(open(app, 'gone'), 409, 'NOT_GRANTED');
    await refused(open(app, 'c1', 'ui-bar', 'workbench'), 409, 'NOT_GRANTED');
    await refused(open(app, 'c1', 'ui-none'), 409, 'NOT_GRANTED');
    // Only the user's token opens frames.
    const anonymous = await rawFetch(`${app.url}/api/clusters/c1/plugin-ui/frames`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'ui-probe', position: 'titlebar' }) });
    assert.equal(anonymous.status, 401);

    // Turned off: refused, open frames revoked at once, the switch saved.
    const frame = (await open(app, 'c1')).data.frameId;
    const sse = openSse(`${app.url}/api/stream`, bearer(TEST_TOKEN));
    await sse.status;
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: '旧标签' }), { result: { shown: true } });
    await waitFor(() => sse.events.some((e) => e.event === 'plugin-ui' && e.data.kind === 'chip'), 'the chip frame');
    await app.api('PATCH', '/api/plugins/ui-probe/lifecycle', { ui: false });
    await waitFor(() => sse.events.find((e) => e.event === 'plugin-ui' && e.data.kind === 'revoked' && e.data.frameIds.includes(frame)), 'the revocation');
    assert.equal(sse.events.find((e) => e.event === 'plugin-ui' && e.data.kind === 'revoked')!.data.reason, 'UI_OFF');
    assert.equal((await raw(app.url, `/plugin-ui/${frame}/index.html`)).status, 404);
    await refused(ask(app, frame, {}), 410, 'FRAME_CLOSED');
    await refused(open(app, 'c1'), 409, 'UI_OFF');
    assert.deepEqual(JSON.parse(readFileSync(join(app.dir, 'home', 'plugins.json'), 'utf8')).uiOff, ['ui-probe']);
    assert.equal((await app.api('GET', '/api/clusters/c1/plugin-ui')).items[0].on, false);
    // A chip set while it is off is shown nowhere and not kept; the one from before was forgotten when it was turned off.
    const chipFrames = () => sse.events.filter((e) => e.event === 'plugin-ui' && e.data.kind === 'chip').length;
    const chipsBefore = chipFrames();
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: '关着时' }), { result: { shown: false } });
    await app.api('PATCH', '/api/plugins/ui-probe/lifecycle', { ui: true });
    assert.equal((await app.api('GET', '/api/clusters/c1/plugin-ui')).items[0].chip, null, 'no chip came back');
    assert.equal(chipFrames(), chipsBefore, 'no chip frame while it was off');
    assert.equal((await open(app, 'c1')).status, 200);

    // Stopped: refused; the list says it is not running.
    await app.api('POST', '/api/plugins/ui-bar/stop', {});
    await refused(open(app, 'c1', 'ui-bar'), 409, 'PLUGIN_NOT_RUNNING');
    assert.equal((await app.api('GET', '/api/clusters/c1/plugin-ui')).items.find((i: any) => i.pluginId === 'ui-bar').running, false);
    sse.close();

    // Too many frames of one plugin: the oldest is closed.
    const ids = [];
    for (let i = 0; i < UI_LIMITS.maxFramesPerPlugin + 1; i++) ids.push((await open(app, 'c1')).data.frameId);
    assert.equal((await raw(app.url, `/plugin-ui/${ids[0]}/index.html`)).status, 404, 'the oldest was evicted');
    assert.equal((await raw(app.url, `/plugin-ui/${ids.at(-1)}/index.html`)).status, 200);
  } finally {
    await app.close();
  }
});

test('ui channel: a request reaches only its own plugin, as the frame id says; every refusal and limit', async () => {
  const { app } = await hub([{ id: 'ui-probe' }, { id: 'ui-other' }]);
  try {
    const frame = (await open(app, 'c1', 'ui-probe', 'workbench')).data.frameId;
    const answer = await ask(app, frame, { action: 'echo', clusterId: 'c2', pluginId: 'ui-other', position: 'titlebar' });
    assert.equal(answer.status, 200);
    // The plugin, cluster and position come from the frame id; what the data says is only data.
    assert.deepEqual(answer.data.result, { echo: { action: 'echo', clusterId: 'c2', pluginId: 'ui-other', position: 'titlebar' }, position: 'workbench', clusterId: 'c1' });
    const [got] = await received(app);
    assert.deepEqual(Object.keys(got).sort(), ['clusterId', 'context', 'data', 'position']);
    assert.equal(got.clusterId, 'c1');
    assert.equal(got.position, 'workbench');
    assert.deepEqual(Object.keys(got.context).sort(), ['at', 'requestId']);
    assert.deepEqual(await received(app, 'ui-other'), [], 'the other plugin heard nothing');

    const refused = async (result: Promise<{ status: number; data: any }>, status: number, code: string, message?: RegExp) => {
      const { status: s, data } = await result;
      assert.equal(s, status, `${code}: ${JSON.stringify(data)}`);
      assert.equal(data.code, code);
      if (message) assert.match(data.error, message);
    };
    // The body may carry `data` only: a frame cannot name another cluster, plugin or frame.
    await refused(call(app, 'POST', `/api/plugin-ui/frames/${frame}/request`, { data: {}, clusterId: 'c2' }), 400, 'INVALID_REQUEST');
    await refused(call(app, 'POST', `/api/plugin-ui/frames/${frame}/request`, [1]), 400, 'INVALID_REQUEST');
    await refused(ask(app, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {}), 410, 'FRAME_CLOSED');
    await refused(ask(app, frame, { pad: 'x'.repeat(UI_LIMITS.maxDataBytes) }), 413, 'TOO_LARGE');
    await refused(ask(app, frame, { action: 'big' }), 413, 'TOO_LARGE', /回答超过/);
    // The plugin's own error: one cleaned line.
    await refused(ask(app, frame, { action: 'fail' }), 409, 'UI_FAILED', /^插件报告失败：probe failure second line$/);
    // A timeout ends that request only; the plugin keeps running and answers the next one.
    await refused(ask(app, frame, { action: 'sleep', ms: 1500 }), 504, 'UI_TIMEOUT');
    assert.equal((await ask(app, frame, { action: 'echo' })).status, 200, 'still running');
    // Only the user's token reaches the channel.
    const anonymous = await rawFetch(`${app.url}/api/plugin-ui/frames/${frame}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"data":{}}' });
    assert.equal(anonymous.status, 401);

    // At most 4 in flight per plugin.
    const slow = Array.from({ length: UI_LIMITS.inFlightPerPlugin }, () => ask(app, frame, { action: 'sleep', ms: 400 }));
    await waitFor(async () => (await received(app)).filter((r: any) => r.data.action === 'sleep').length >= 1 + UI_LIMITS.inFlightPerPlugin, 'the slow requests');
    await refused(ask(app, frame, {}), 429, 'BUSY');
    await Promise.all(slow);
    // At most 120 a minute per plugin (sent ones count, refused ones do not).
    let sent = (await received(app)).length;
    while (sent < UI_LIMITS.requestsPerPluginPerMinute) {
      assert.equal((await ask(app, frame, {})).status, 200);
      sent++;
    }
    await refused(ask(app, frame, {}), 429, 'RATE_LIMITED');
    assert.equal((await ask(app, (await open(app, 'c1', 'ui-other')).data.frameId, {})).status, 200, 'another plugin has its own budget');

    // Closed while the plugin worked: the answer is dropped.
    const short = (await open(app, 'c2', 'ui-other')).data.frameId;
    const late = ask(app, short, { action: 'sleep', ms: 300 });
    await new Promise((r) => setTimeout(r, 100));
    await call(app, 'DELETE', `/api/plugin-ui/frames/${short}`, {});
    await refused(late, 410, 'FRAME_CLOSED');
  } finally {
    await app.close();
  }
});

test('ui pushes and chips: only the plugin\'s own frames in that cluster (and position); refusals; revocation on stop', async () => {
  const { app } = await hub([{ id: 'ui-probe' }, { id: 'ui-other' }, { id: 'ui-bar', grant: { ui: ['workbench'] } }]);
  const sse = openSse(`${app.url}/api/stream`, bearer(TEST_TOKEN));
  try {
    await sse.status;
    const bar = (await open(app, 'c1', 'ui-probe', 'titlebar')).data.frameId;
    const bench = (await open(app, 'c1', 'ui-probe', 'workbench')).data.frameId;
    const elsewhere = (await open(app, 'c2', 'ui-probe', 'titlebar')).data.frameId;
    const other = (await open(app, 'c1', 'ui-other', 'titlebar')).data.frameId;
    const pushes = () => sse.events.filter((e) => e.event === 'plugin-ui' && e.data.kind === 'push');
    const push = async (params: unknown, plugin = 'ui-probe') => hostCall(app, 'host.ui.push', params, plugin);

    assert.deepEqual(await push({ clusterId: 'c1', data: { n: 1 } }), { result: { delivered: 2 } });
    await waitFor(() => pushes().length === 1, 'the push');
    assert.deepEqual(pushes()[0].data, { kind: 'push', pluginId: 'ui-probe', frameIds: [bar, bench], data: { n: 1 } });
    assert.deepEqual(await push({ clusterId: 'c1', position: 'workbench', data: 2 }), { result: { delivered: 1 } });
    await waitFor(() => pushes().length === 2, 'the second push');
    assert.deepEqual(pushes()[1].data.frameIds, [bench]);
    assert.deepEqual(await push({ clusterId: 'c2', data: null }), { result: { delivered: 1 } });
    await waitFor(() => pushes().length === 3, 'the third push');
    assert.deepEqual(pushes()[2].data.frameIds, [elsewhere]);
    assert.ok(pushes().every((e) => !e.data.frameIds.includes(other)), 'never to another plugin\'s frame');
    assert.deepEqual(await push({ clusterId: 'c1', data: 'x' }, 'ui-other'), { result: { delivered: 1 } });
    await waitFor(() => pushes().length === 4, 'the other plugin\'s push');
    assert.deepEqual(pushes()[3].data.frameIds, [other]);

    // Refusals, with their codes; none is delivered.
    assert.deepEqual(await push({ clusterId: 'c3', data: 1 }), { error: 'CLUSTER_NOT_GRANTED' });
    assert.deepEqual(await push({ clusterId: 'c1' }), { error: 'INVALID_DATA' });
    assert.deepEqual(await push({ clusterId: 'c1', data: 1, frameId: bar }), { error: 'INVALID_DATA' });
    assert.deepEqual(await push({ clusterId: 'c1', position: 'sidebar', data: 1 }), { error: 'INVALID_DATA' });
    assert.deepEqual(await push({ clusterId: 'c1', data: 'x'.repeat(UI_LIMITS.maxDataBytes) }), { error: 'TOO_LARGE' });
    assert.deepEqual(await push([1]), { error: 'INVALID_DATA' });
    assert.deepEqual(await push({ clusterId: 'c1', position: 'titlebar', data: 1 }, 'ui-bar'), { error: 'POSITION_NOT_GRANTED' });
    assert.equal(pushes().length, 4);

    // Chips: one line, at most 24 characters, a known state or none; titlebar only.
    const chips = () => sse.events.filter((e) => e.event === 'plugin-ui' && e.data.kind === 'chip');
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: '  构建\n中 ', state: 'running' }), { result: { shown: true } });
    await waitFor(() => chips().length === 1, 'the chip');
    assert.deepEqual(chips()[0].data, { kind: 'chip', pluginId: 'ui-probe', clusterId: 'c1', chip: { text: '构建 中', state: 'running' } });
    assert.deepEqual((await app.api('GET', '/api/clusters/c1/plugin-ui')).items.find((i: any) => i.pluginId === 'ui-probe').chip, { text: '构建 中', state: 'running' });
    // Longer text is cut to its first 24 characters, the state kept.
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: '构建'.repeat(20), state: 'done' }), { result: { shown: true } });
    await waitFor(() => chips().length === 2, 'the cut chip');
    assert.deepEqual(chips()[1].data.chip, { text: '构建'.repeat(12), state: 'done' });
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: '\u0007\n ' }), { error: 'INVALID_DATA' }, 'nothing left');
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: 42 }), { error: 'INVALID_DATA' });
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: 'ok', state: 'blinking' }), { error: 'INVALID_DATA' });
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: 'ok' }, 'ui-bar'), { error: 'POSITION_NOT_GRANTED' });
    assert.deepEqual(await hostCall(app, 'host.ui.chip', { clusterId: 'c1', text: null }), { result: { shown: true } }, 'null: back to the name');

    // Stopped: its frames are revoked (their ids die), its chips are forgotten, the other plugin's frame stays.
    await app.api('POST', '/api/plugins/ui-probe/stop', {});
    const revoked = await waitFor(() => sse.events.find((e) => e.event === 'plugin-ui' && e.data.kind === 'revoked'), 'the revocation');
    assert.deepEqual(revoked.data, { kind: 'revoked', pluginId: 'ui-probe', frameIds: [bar, bench, elsewhere], reason: 'PLUGIN_NOT_RUNNING' });
    assert.equal((await raw(app.url, `/plugin-ui/${other}/index.html`)).status, 200);
    await app.api('POST', '/api/plugins/ui-probe/start', {});
    assert.equal((await app.api('GET', '/api/clusters/c1/plugin-ui')).items.find((i: any) => i.pluginId === 'ui-probe').chip, null);
    assert.deepEqual(await push({ clusterId: 'c1', data: 1 }), { result: { delivered: 0 } }, 'the restarted instance has no frames yet');

    // At most 120 pushes and chips a minute per plugin. Pushed by the plugin in one burst (one invoke): one push per
    // invoke would cost the plugin two protocol frames each, and a fast loop could pass the protocol's 200 frames a second.
    // Before this point it used 3 pushes and 3 chips before the restart and 1 push after it (the budget outlives the restart).
    const burst = (await app.api('POST', '/api/plugins/ui-probe/invoke', { command: 'burst',
      arguments: { method: 'host.ui.push', params: { clusterId: 'c1', data: 0 }, times: UI_LIMITS.pushesPerPluginPerMinute } })).result;
    assert.equal(burst.error, 'RATE_LIMITED');
    // 113 when all 7 are inside the last minute; a very slow machine may have let some of them age out.
    assert.ok(burst.sent >= UI_LIMITS.pushesPerPluginPerMinute - 7 && burst.sent < UI_LIMITS.pushesPerPluginPerMinute, `${burst.sent} pushes before the limit`);
  } finally {
    sse.close();
    await app.close();
  }
});

test('ui frames: an answer reaches the page only through a frame still valid; a trashed cluster ends its frames at once', async () => {
  const { app } = await hub();
  const sse = openSse(`${app.url}/api/stream`, bearer(TEST_TOKEN));
  const revokedIds = () => sse.events.filter((e) => e.event === 'plugin-ui' && e.data.kind === 'revoked').flatMap((e) => e.data.frameIds);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await sse.status;
    const kept = (await open(app, 'c1')).data.frameId;

    // In flight when the cluster goes to the recycle bin: a result and an error alike end as the frame's refusal.
    const success = (await open(app, 'c2')).data.frameId;
    const failure = (await open(app, 'c2', 'ui-probe', 'workbench')).data.frameId;
    const late = [ask(app, success, { action: 'sleep', ms: 400 }), ask(app, failure, { action: 'failLater', ms: 400 })];
    await waitFor(async () => (await received(app)).length === 2, 'both requests at the plugin');
    await app.api('DELETE', '/api/clusters/c2', {});
    // Revoked at once, before anyone touches the frames again.
    await waitFor(() => revokedIds().includes(success) && revokedIds().includes(failure), 'both revoked at the trash');
    for (const answer of await Promise.all(late)) {
      assert.equal(answer.status, 410);
      assert.equal(answer.data.code, 'FRAME_CLOSED');
      assert.doesNotMatch(JSON.stringify(answer.data), /slept|late probe failure/, 'neither the result nor the plugin\'s error text');
    }
    assert.equal((await raw(app.url, `/plugin-ui/${success}/index.html`)).status, 404);
    assert.ok(!revokedIds().includes(kept), 'the frame in another cluster stays');
    assert.equal((await raw(app.url, `/plugin-ui/${kept}/index.html`)).status, 200);

    // Restored: the old ids stay dead, a new frame works.
    await app.api('POST', '/api/clusters/c2/restore', {});
    assert.equal((await ask(app, success, {})).data.code, 'FRAME_CLOSED');
    const fresh = (await open(app, 'c2')).data.frameId;
    assert.equal((await ask(app, fresh, { action: 'echo' })).status, 200);

    // A late error after the page closed the frame: the refusal, not the plugin's text.
    const closing = ask(app, fresh, { action: 'failLater', ms: 300 });
    await pause(100);
    await call(app, 'DELETE', `/api/plugin-ui/frames/${fresh}`, {});
    const closed = await closing;
    assert.equal(closed.data.code, 'FRAME_CLOSED');
    assert.doesNotMatch(JSON.stringify(closed.data), /late probe failure/);

    // A late error after the switch was turned off: the same.
    const switched = ask(app, kept, { action: 'failLater', ms: 300 });
    await pause(100);
    await app.api('PATCH', '/api/plugins/ui-probe/lifecycle', { ui: false });
    const off = await switched;
    assert.equal(off.data.code, 'FRAME_CLOSED');
    assert.doesNotMatch(JSON.stringify(off.data), /late probe failure/);
  } finally {
    sse.close();
    await app.close();
  }
});

test('ui files: a rebuilt ui/ is served only once the whole folder passes again, to open and new frames alike', async () => {
  const { app, folders } = await hub();
  try {
    const ui = join(folders['ui-probe'], 'ui');
    // Opened with one file over the per-file cap: it counts, it is not served.
    writeFileSync(join(ui, 'theme.css'), Buffer.alloc(UI_LIMITS.maxFileBytes + 1, 32));
    const before = (await open(app, 'c1')).data.frameId;
    const get = (frameId: string, file: string) => raw(app.url, `/plugin-ui/${frameId}/${file}`);
    const status = async (file: string) => (await get(before, file)).status;
    assert.equal(await status('style.css'), 200);
    assert.equal(await status('theme.css'), 404, 'over the per-file cap');

    // Every case below is asked by the frame opened above, with no new frame opened in between (a new frame would refresh
    // the plugin's listing and hide what the open frame sees). The current file is compared with the listing first,
    // then the caps apply.
    // (a) shrunk under the cap: served at once.
    writeFileSync(join(ui, 'theme.css'), 'body{margin:0}  ');
    const shrunk = await get(before, 'theme.css');
    assert.equal(shrunk.status, 200, 'the shrunk file, to the frame that saw it oversized');
    assert.equal(shrunk.body, 'body{margin:0}  ');
    // (b) grown past the per-file cap: refused; the rest of the folder (its total still within the cap) is still served.
    writeFileSync(join(ui, 'theme.css'), Buffer.alloc(UI_LIMITS.maxFileBytes + 1, 32));
    assert.equal(await status('theme.css'), 404, 'grown past the cap');
    for (const file of ['index.html', 'style.css', 'probe.js']) assert.equal(await status(file), 200, `${file} still served`);
    rmSync(join(ui, 'theme.css'));
    // (c) deleted: 404; created again: served, with its new content.
    rmSync(join(ui, 'mod.js'));
    assert.equal(await status('mod.js'), 404, 'deleted');
    writeFileSync(join(ui, 'mod.js'), 'globalThis.probeModule = "again";');
    assert.equal((await get(before, 'mod.js')).body, 'globalThis.probeModule = "again";', 'created again');
    // (d) the folder over its total cap: nothing new is served and, once that check failed, nothing of it; back under: served.
    for (let i = 0; i < 5; i++) writeFileSync(join(ui, `bulk-${i}.js`), Buffer.alloc(UI_LIMITS.maxFileBytes - 1, 32));
    assert.equal(await status('bulk-0.js'), 404, 'a new file in an oversized folder');
    assert.equal(await status('index.html'), 404, 'nothing of a folder that failed its check');
    for (let i = 0; i < 5; i++) rmSync(join(ui, `bulk-${i}.js`));
    assert.equal(await status('index.html'), 200, 'back under the total');
    // (e) a file of a type never served, and a junction, added: never served, the rest still is; removed: no change.
    writeFileSync(join(ui, 'notes.txt'), 'text');
    mkdirSync(join(folders['ui-probe'], 'elsewhere'));
    writeFileSync(join(folders['ui-probe'], 'elsewhere', 'x.js'), 'outside');
    symlinkSync(join(folders['ui-probe'], 'elsewhere'), join(ui, 'linked'), 'junction');
    assert.equal(await status('notes.txt'), 404);
    assert.equal(await status('linked/x.js'), 404);
    writeFileSync(join(ui, 'fresh.js'), '1');   // a new file: the whole folder is checked again, with both entries in it
    assert.equal(await status('fresh.js'), 200);
    assert.equal(await status('style.css'), 200);
    rmSync(join(ui, 'notes.txt'));
    rmSync(join(ui, 'linked'));   // the junction only, not what it points to
    assert.equal(await status('linked/x.js'), 404);
    for (const file of ['index.html', 'style.css', 'fresh.js']) assert.equal(await status(file), 200, `${file} after the removal`);

    // A normal rebuild within the caps: a rewritten file and a new one, the same for the open frame and a new one.
    writeFileSync(join(ui, 'style.css'), 'body { color: rgb(4, 5, 6); } /* rebuilt */');
    writeFileSync(join(ui, 'chunk-2.js'), 'globalThis.chunk = 2;');
    const after = (await open(app, 'c1')).data.frameId;
    for (const frameId of [before, after]) {
      const style = await get(frameId, 'style.css');
      assert.equal(style.status, 200);
      assert.match(style.body, /rgb\(4, 5, 6\)/);
      assert.equal((await get(frameId, 'chunk-2.js')).body, 'globalThis.chunk = 2;');
    }

    // A rebuild past the caps: nothing new or changed is served, to the open frame either.
    for (let i = 0; i < 5; i++) writeFileSync(join(ui, `heavy-${i}.js`), Buffer.alloc(UI_LIMITS.maxFileBytes - 1, 32));
    writeFileSync(join(ui, 'style.css'), 'body { color: rgb(7, 8, 9); } /* past the caps */');
    for (const frameId of [before, after]) {
      assert.equal((await get(frameId, 'style.css')).status, 404, 'a changed file');
      assert.equal((await get(frameId, 'heavy-0.js')).status, 404, 'a new file');
    }
    assert.equal((await open(app, 'c1')).data.code, 'FILES_INVALID');
    assert.equal((await get(before, 'index.html')).status, 404, 'once the folder failed, nothing of it');

    // Back within the caps: served again.
    for (let i = 0; i < 5; i++) rmSync(join(ui, `heavy-${i}.js`));
    const style = await get(before, 'style.css');
    assert.equal(style.status, 200);
    assert.match(style.body, /rgb\(7, 8, 9\)/);
  } finally {
    await app.close();
  }
});

test('chip text: cut to its first 24 characters by code point, never splitting an emoji; nothing left or not a string: none', () => {
  const zh24 = '一二三四五六七八九十'.repeat(3).slice(0, 24);
  assert.equal([...zh24].length, 24);
  assert.equal(chipText(zh24), zh24);
  assert.equal(chipText(`${zh24}多`), zh24);
  assert.equal(chipText('构建进度'.repeat(10)), '构建进度'.repeat(6));
  const emoji = chipText('😀'.repeat(30))!;
  assert.equal([...emoji].length, 24);
  assert.equal(emoji, '😀'.repeat(24));
  assert.ok(emoji.isWellFormed(), 'no lone surrogate');
  const mixed = chipText(`${'计'.repeat(23)}😀尾巴`)!;
  assert.equal(mixed, `${'计'.repeat(23)}😀`);
  assert.equal(chipText('a\u0007b\nc‮d'), 'a b c d', 'control, line and format characters become spaces');
  assert.equal(chipText('  \n\t '), null);
  assert.equal(chipText(42), null);
  assert.equal(chipText(null), null);
});

test('ui frames: a Hub restart ends every frame id', async () => {
  const dir = tempDir();
  const first = await hub(undefined, dir);
  const frameId = (await open(first.app, 'c1')).data.frameId;
  assert.equal((await raw(first.app.url, `/plugin-ui/${frameId}/index.html`)).status, 200);
  await first.app.close();
  const app = await startTestHub({ dir });
  try {
    await waitFor(async () => (await app.api('GET', '/api/plugins')).installed.find((p: any) => p.id === 'ui-probe')?.runtime?.state === 'ready', 'ready');
    assert.equal((await raw(app.url, `/plugin-ui/${frameId}/index.html`)).status, 404);
    assert.equal((await ask(app, frameId, {})).data.code, 'FRAME_CLOSED');
  } finally {
    await app.close();
  }
});

test('the collaboration page may frame only the plugin UI path', async () => {
  const { app } = await hub();
  try {
    for (const path of ['/', '/index.html']) {
      const res = await raw(app.url, path);
      assert.equal(res.headers['content-security-policy'], `frame-src http://${new URL(app.url).host}/plugin-ui/`, path);
    }
    assert.equal((await raw(app.url, '/app.js')).headers['content-security-policy'], undefined, 'scripts are not documents');
  } finally {
    await app.close();
  }
});
