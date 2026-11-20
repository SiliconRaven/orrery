// docs/launcher.md 测试 1、3、5、7 and the launcher's outside-world calls. Every test uses a temp ORRERY_HOME,
// a temp database and a free port other than 4317; the browser, the dialog and PowerShell are injected fakes.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveConfig, type Config } from '../src/config.ts';
import {
  apiTokenOf, createShortcut, DIALOG_SCRIPT, ensureDeps, getHealth, childEnv, hubSpawner, hubUrl, launch, openInBrowser, pageUrl, probe, runPowerShell, SHORTCUT_SCRIPT, showErrorDialog,
  type HealthResult, type LaunchDeps, type PowerShellRunner, type SpawnedHub,
} from '../src/launcher.ts';
import { listenLoopback, REPO_ROOT } from '../src/main.ts';
import { freePort, startTestHub, tempDir, TEST_TOKEN, waitFor, withFreePort } from './helpers.ts';
import type { MockScript } from './mock.ts';

function hubEnv(dir: string, port: number): Record<string, string | undefined> {
  return { ...process.env, ORRERY_PORT: String(port), ORRERY_HOME: join(dir, 'home'), ORRERY_DB: join(dir, 'h.db'),
    ORRERY_REGISTRY: join(dir, 'registry'), ORRERY_API_TOKEN: TEST_TOKEN };
}

/** Real Hub processes and health checks; fake browser and dialog. */
function realDeps(env: Record<string, string | undefined>) {
  const opened: string[] = [];
  const errors: string[] = [];
  const spawned: SpawnedHub[] = [];
  const config = resolveConfig(env);
  const spawn = hubSpawner(env, config);
  const deps: LaunchDeps = {
    config,
    health: (port) => getHealth(port, apiTokenOf(config)),
    spawnHub: (log) => { const c = spawn(log); spawned.push(c); return c; },
    openBrowser: async (url) => { opened.push(url); },
    showError: async (m) => { errors.push(m); },
    sleep: (ms) => sleep(ms),
    now: Date.now,
  };
  return { deps, opened, errors, spawned };
}

// Only the retry wrappers below use this. A parallel test Hub does not say EADDRINUSE: the launcher reports the other
// Hub, a 401, or a start that never answered. Tests that expect those failures do not call portTaken.
const portTaken = (text: string) =>
  /EADDRINUSE|被别的程序占用|另一个数据目录|正在使用端口|不接受本机的 API 令牌|没有启动完|没有回答/.test(text);

/** Start one real Hub on a reserved port, and try another port when that one was taken. */
async function bootHub(makeEnv: (port: number) => Record<string, string | undefined>) {
  return withFreePort(async (port) => {
    const env = makeEnv(port);
    const started = realDeps(env);
    const code = await launch(started.deps);
    if (code !== 0 && portTaken(started.errors.join('\n'))) throw Object.assign(new Error(started.errors.join('\n')), { code: 'EADDRINUSE' });
    assert.equal(code, 0, started.errors.join('\n'));
    return { port, env, started };
  });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Stops a test Hub the way the web page does; kills it only if that fails. Takes the child, not a PID: Windows gives a
 * dead PID to a new process within seconds, so a stale number could shut down or kill something this test never started.
 */
async function stopHub(port: number, hub: SpawnedHub, token = TEST_TOKEN): Promise<void> {
  if (hub.pid === undefined || hub.exited()) return;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  await fetch(`${hubUrl(port)}/api/shutdown`, { method: 'POST', headers, body: '{}' }).catch(() => {});
  try { await waitFor(() => hub.exited(), 'test hub to exit', 10_000); } catch { process.kill(hub.pid); }
}

const orrery = (c: Config, pid: number, state = 'running', over: Partial<{ home: string; db: string }> = {}): HealthResult =>
  ({ kind: 'answer', status: 200, body: { app: 'orrery', pid, state, home: c.home, db: c.dbPath, ...over } });

/** A config under a temp home; the fake health checks below never touch the network. */
function fakeConfig(): Config {
  const dir = tempDir();
  const config = resolveConfig({ ORRERY_HOME: join(dir, 'home'), ORRERY_DB: join(dir, 'h.db'), ORRERY_PORT: '45999' });
  mkdirSync(config.home, { recursive: true });
  return config;
}
const writeHubJson = (c: Config, data: unknown) => writeFileSync(join(c.home, 'hub.json'), typeof data === 'string' ? data : JSON.stringify(data));

/** Launch deps with a fake clock and fakes for everything; `over` replaces some. */
function fakeDeps(config: Config, over: Partial<LaunchDeps> = {}) {
  let t = 0;
  const opened: string[] = [];
  const errors: string[] = [];
  const sleeps: number[] = [];
  const spawns: string[] = [];
  const deps: LaunchDeps = {
    config,
    health: async () => ({ kind: 'refused' }),
    spawnHub: (log) => { spawns.push(log); return { pid: 1, exited: () => true }; },
    openBrowser: async (url) => { opened.push(url); },
    showError: async (m) => { errors.push(m); },
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
    ...over,
  };
  return { deps, opened, errors, sleeps, spawns };
}

test('launcher 1: probe says "none" for every kind of missing, stale or foreign Hub', async () => {
  const c = fakeConfig();
  const url = hubUrl(c.port);
  let calls = 0;
  const answer = (r: HealthResult) => async () => { calls++; return r; };
  assert.deepEqual(await probe(c, answer(orrery(c, 7))), { kind: 'none' }, 'no hub.json');
  assert.equal(calls, 0, 'no hub.json, no request');
  writeHubJson(c, '{ not json');
  assert.deepEqual(await probe(c, answer(orrery(c, 7))), { kind: 'none' }, 'corrupt');
  for (const bad of [`http://localhost:${c.port}`, 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:01', `http://10.0.0.1:${c.port}`, `${url}/`, 42]) {
    writeHubJson(c, { url: bad, pid: 7 });
    assert.deepEqual(await probe(c, answer(orrery(c, 7))), { kind: 'none' }, String(bad));
  }
  writeHubJson(c, { url, pid: 7 });
  const nones: [string, HealthResult][] = [
    ['pid differs (stale hub.json)', orrery(c, 8)],
    ['process gone', { kind: 'refused' }],
    ['not orrery', { kind: 'answer', status: 200, body: { app: 'something', pid: 7, state: 'running', home: c.home, db: c.dbPath } }],
    ['not JSON', { kind: 'answer', status: 200, body: undefined }],
  ];
  for (const [what, r] of nones) assert.deepEqual(await probe(c, answer(r)), { kind: 'none' }, what);
  // hub.json names a Hub but nothing definite came back: not "gone".
  const unknowns: [string, HealthResult][] = [
    ['timeout', { kind: 'silent' }],
    ['503 while starting', { kind: 'answer', status: 503, body: { error: 'hub is starting' } }],
    ['500', { kind: 'answer', status: 500, body: undefined }],
    ['unknown state', orrery(c, 7, 'weird')],
  ];
  for (const [what, r] of unknowns) assert.deepEqual(await probe(c, answer(r)), { kind: 'unknown', url }, what);
  assert.deepEqual(await probe(c, answer(orrery(c, 7))), { kind: 'running', url, pid: 7 });
  assert.deepEqual(await probe(c, answer(orrery(c, 7, 'stopping'))), { kind: 'stopping', url, pid: 7 });
  assert.equal((await probe(c, answer(orrery(c, 7, 'running', { home: join(c.home, 'x') })))).kind, 'other-data');
  assert.equal((await probe(c, answer(orrery(c, 7, 'running', { db: c.dbPath + '2' })))).kind, 'other-data');
  if (process.platform === 'win32') {
    assert.equal((await probe(c, answer(orrery(c, 7, 'running', { db: c.dbPath.toUpperCase(), home: c.home.toLowerCase() })))).kind, 'running',
      'paths compare without case on Windows');
  }
});

test('launcher 1: a same-data Hub on another port (hub.json names it) is opened; nothing is spawned', async () => {
  const app = await startTestHub();
  const q = Number(new URL(app.url).port);
  try {
    let p = await freePort();
    while (p === q) p = await freePort();
    const config = resolveConfig({ ORRERY_HOME: app.home, ORRERY_DB: join(app.dir, 'test.db'), ORRERY_PORT: String(p), ORRERY_API_TOKEN: TEST_TOKEN });
    const asked: number[] = [];
    const f = fakeDeps(config, { health: (port) => { asked.push(port); return getHealth(port, TEST_TOKEN); }, sleep: (ms) => sleep(ms), now: Date.now });
    assert.equal(await launch(f.deps), 0, f.errors.join('\n'));
    assert.deepEqual(f.opened, [`${app.url}/#token=${TEST_TOKEN}`]);
    assert.deepEqual(f.spawns, [], 'no second Hub on the same data');
    assert.deepEqual(asked, [q]);
  } finally { await app.close(); }
});

test('launcher 1: another data directory fails without starting a Hub', async () => {
  const c = fakeConfig();
  writeHubJson(c, { url: hubUrl(c.port), pid: 7 });
  const f = fakeDeps(c, { health: async () => orrery(c, 7, 'running', { db: join(c.home, 'other.db') }) });
  assert.equal(await launch(f.deps), 1);
  assert.deepEqual(f.spawns, []);
  assert.deepEqual(f.opened, []);
  assert.match(f.errors[0], /已有一个 orrery Hub 在端口 45999 上运行，但用的是另一个数据目录/);
  assert.match(f.errors[0], /hub\.log/);
});

test('launcher 1: getHealth tells a closed port from a silent one (2 s timeout)', async () => {
  let health: HealthResult = { kind: 'silent' };
  for (let i = 0; i < 5 && health.kind !== 'refused'; i++) health = await getHealth(await freePort());
  assert.deepEqual(health, { kind: 'refused' });
  const sockets: Socket[] = [];
  const silent = createNetServer((s) => { sockets.push(s); });
  await listenLoopback(silent, 0);
  try {
    const start = Date.now();
    assert.deepEqual(await getHealth((silent.address() as { port: number }).port), { kind: 'silent' });
    assert.ok(Date.now() - start < 3000);
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((ok) => silent.close(() => ok()));
  }
});

test('launcher 3: starts one Hub and opens it; a second run reuses it; two launchers at once end with one Hub', async () => {
  const dir = tempDir();
  const { port, env, started: a } = await bootHub((port) => hubEnv(dir, port));
  const url = pageUrl(hubUrl(port), TEST_TOKEN);
  const all: SpawnedHub[] = [];
  try {
    all.push(...a.spawned);
    assert.deepEqual(a.opened, [url]);
    assert.equal(a.spawned.length, 1);
    const pid = a.spawned[0].pid;
    assert.equal(JSON.parse(readFileSync(join(dir, 'home', 'hub.json'), 'utf8')).pid, pid);
    assert.ok(existsSync(join(dir, 'home', 'hub.log')));

    const b = realDeps(env);
    assert.equal(await launch(b.deps), 0, b.errors.join('\n'));
    assert.deepEqual(b.opened, [url]);
    assert.equal(b.spawned.length, 0, 'no second Hub');

    await stopHub(port, a.spawned[0]);
    const c = realDeps(env);
    const d = realDeps(env);
    const codes = await Promise.all([launch(c.deps), launch(d.deps)]);
    all.push(...c.spawned, ...d.spawned);
    assert.deepEqual(codes, [0, 0], [...c.errors, ...d.errors].join('\n'));
    assert.deepEqual([c.opened, d.opened], [[url], [url]]);
    const candidates = [...c.spawned, ...d.spawned];
    // A losing child can briefly still be running after its launcher returns.
    await waitFor(() => candidates.filter((s) => !s.exited()).length === 1, 'one test Hub to remain', 10_000);
    const live = candidates.filter((s) => !s.exited());
    assert.equal(live.length, 1, 'one Hub left running');
    const health = await getHealth(port, TEST_TOKEN);
    assert.equal(health.kind === 'answer' && (health.body as { pid: number }).pid, live[0].pid);
  } finally {
    for (const s of all) await stopHub(port, s);
  }
});

test('launcher 5: a port held by another program is reported; the holder keeps running and no data is written', async () => {
  for (const kind of ['answers', 'silent'] as const) {
    const dir = tempDir();
    const sockets: Socket[] = [];
    const holder: Server = kind === 'answers'
      ? createHttpServer((_req, res) => res.end('hello')) as unknown as Server
      : createNetServer((s) => { sockets.push(s); });
    await listenLoopback(holder, 0);
    const port = (holder.address() as { port: number }).port;
    const r = realDeps(hubEnv(dir, port));
    if (kind === 'silent') {
      // A port that never answers is waited for until the start deadline (it might be a Hub still starting). Shortened
      // here: health gives up after 100 ms and, once the launcher's own Hub has exited, every wait counts as 2 s on the
      // launcher's clock. Before that the clock is real, so a slow Hub start under load does not use up the deadline.
      let skew = 0;
      r.deps.health = (p) => getHealth(p, TEST_TOKEN, 100);
      r.deps.now = () => Date.now() + skew;
      r.deps.sleep = async (ms) => { if (r.spawned[0]?.exited()) skew += 2000; await sleep(ms); };
    }
    try {
      assert.equal(await launch(r.deps), 1, kind);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0], kind === 'answers' ? new RegExp(`端口 ${port} 被别的程序占用`) : new RegExp(`端口 ${port} 上的程序 20 秒内没有回答`), kind);
      assert.deepEqual(r.opened, []);
      assert.ok(holder.listening, 'the holder is still running');
      assert.equal(r.spawned.length, 1);
      assert.equal(existsSync(join(dir, 'h.db')), false, 'no database created');
      assert.equal(existsSync(join(dir, 'home', 'secret')), false, 'no secret written');
      assert.equal(existsSync(join(dir, 'home', 'hub.json')), false, 'no hub.json written');
      assert.match(readFileSync(join(dir, 'home', 'hub.log'), 'utf8'), /EADDRINUSE/);
    } finally {
      sockets.forEach((s) => s.destroy());
      (holder as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((ok) => holder.close(() => ok()));
    }
  }
});

test('launcher 7: launching while the Hub is exiting waits for it, then starts a new one', async () => {
  const dir = tempDir();
  const { port, env, started: a } = await bootHub((port) => hubEnv(dir, port));
  const all: SpawnedHub[] = [];
  try {
    all.push(...a.spawned);
    const old = a.spawned[0];
    const first = old.pid!;
    const res = await fetch(`${hubUrl(port)}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 202);
    const b = realDeps(env);
    assert.equal(await launch(b.deps), 0, b.errors.join('\n'));
    all.push(...b.spawned);
    assert.deepEqual(b.opened, [pageUrl(hubUrl(port), TEST_TOKEN)]);
    const health = await getHealth(port, TEST_TOKEN);
    const pid = health.kind === 'answer' ? (health.body as { pid: number }).pid : 0;
    assert.notEqual(pid, first, 'a new Hub');
    // Its own exit event, not process.kill(pid, 0): by now Windows may have given that PID to another process.
    await waitFor(() => old.exited(), 'the old one to be gone', 10_000);
  } finally {
    for (const s of all) await stopHub(port, s);
  }
});

test('launcher 7: a stopping Hub is waited for without starting anything; once it is gone a Hub is started', async () => {
  const c = fakeConfig();
  writeHubJson(c, { url: hubUrl(c.port + 1), pid: 100 });   // on another port, as after ORRERY_PORT=... npm start
  let polls = 0;
  let n = 0;
  let current: HealthResult = orrery(c, 100, 'stopping');
  const f = fakeDeps(c, {
    health: async () => {
      if (++polls === 4) rmSync(join(c.home, 'hub.json'));   // it finished closing: hub.json goes last
      return current;
    },
    spawnHub: () => {
      n++;
      assert.equal(existsSync(join(c.home, 'hub.json')), false, 'not started while the old Hub is still there');
      writeHubJson(c, { url: hubUrl(c.port), pid: 102 });
      current = orrery(c, 102);
      return { pid: 102, exited: () => false };
    },
  });
  assert.equal(await launch(f.deps), 0, f.errors.join(' | '));
  assert.equal(n, 1);
  assert.deepEqual(f.sleeps, [200, 200, 200, 200], 'polled every 200 ms while it was stopping');
  assert.deepEqual(f.opened, [hubUrl(c.port)]);
});

test('launcher 7: a Hub still stopping after 20 s is reported; nothing is started or ended', async () => {
  const c = fakeConfig();
  writeHubJson(c, { url: hubUrl(c.port), pid: 100 });
  const f = fakeDeps(c, { health: async () => orrery(c, 100, 'stopping') });
  assert.equal(await launch(f.deps), 1);
  assert.deepEqual(f.spawns, []);
  assert.match(f.errors[0], /一个 orrery Hub 正在退出，20 秒内没有退完，请稍后再试/);
});

test('launcher 3: a Hub that lost the port to one still starting (503 "hub is starting") waits for that one, starts no other', async () => {
  const starting: HealthResult = { kind: 'answer', status: 503, body: { error: 'hub is starting' } };
  for (const ready of [true, false]) {
    const c = fakeConfig();
    let asked = 0;
    const f = fakeDeps(c, {
      // The other launcher's Hub took the port first and is registering: a few 503s, then (if ready) running.
      health: async () => (++asked <= 3 || !ready ? starting : orrery(c, 202)),
      spawnHub: (log) => { f.spawns.push(log); return { pid: 201, exited: () => true }; },   // EADDRINUSE
    });
    const code = await launch(f.deps);
    assert.equal(f.spawns.length, 1, 'no second Hub started next to the starting one');
    if (ready) {
      assert.equal(code, 0, f.errors.join(' | '));
      assert.deepEqual(f.opened, [hubUrl(c.port)]);
    } else {
      assert.equal(code, 1);
      assert.match(f.errors[0], /没有启动完/);
      assert.doesNotMatch(f.errors[0], /别的程序占用/);
    }
  }
});

test('launcher 3: a port that gives no answer after the Hub lost it is waited for: silent → 503 → 200, silent → 200, silent until the deadline', async () => {
  const starting: HealthResult = { kind: 'answer', status: 503, body: { error: 'hub is starting' } };
  const silent: HealthResult = { kind: 'silent' };
  const cases: { name: string; answers: (c: Config) => HealthResult[] }[] = [
    { name: 'silent → 503 → 200', answers: (c) => [silent, silent, starting, starting, orrery(c, 302)] },
    { name: 'silent → 200', answers: (c) => [silent, silent, silent, orrery(c, 302)] },
    { name: 'silent until the deadline', answers: () => [silent] },
  ];
  for (const { name, answers } of cases) {
    const c = fakeConfig();
    const list = answers(c);
    let asked = 0;
    const f = fakeDeps(c, {
      health: async () => list[Math.min(asked++, list.length - 1)],   // the last answer repeats
      spawnHub: (log) => { f.spawns.push(log); return { pid: 301, exited: () => true }; },   // EADDRINUSE
    });
    const code = await launch(f.deps);
    assert.equal(f.spawns.length, 1, `${name}: no second Hub started`);
    if (name === 'silent until the deadline') {
      assert.equal(code, 1, name);
      assert.match(f.errors[0], /秒内没有回答/, name);
      assert.doesNotMatch(f.errors[0], /别的程序占用/, name);
    } else {
      assert.equal(code, 0, `${name}: ${f.errors.join(' | ')}`);
      assert.deepEqual(f.opened, [hubUrl(c.port)], name);
    }
  }
  // A 200 from another data directory after the wait is still refused as other data.
  const c = fakeConfig();
  let n = 0;
  const other = fakeDeps(c, {
    health: async () => (n++ < 2 ? silent : orrery(c, 303, 'running', { home: 'C:\elsewhere' })),
    spawnHub: () => ({ pid: 304, exited: () => true }),
  });
  assert.equal(await launch(other.deps), 1);
  assert.match(other.errors[0], /另一个数据目录/);
});

test('launcher 7: a started Hub that meets a stopping one on the configured port waits for it, then starts again', async () => {
  const c = fakeConfig();
  let current: HealthResult = { kind: 'refused' };
  let n = 0;
  const f = fakeDeps(c, {
    health: async () => current,
    spawnHub: () => {
      n++;
      if (n === 1) {   // EADDRINUSE: a stopping Hub (no longer in hub.json) holds the port
        current = orrery(c, 100, 'stopping');
        return { pid: 101, exited: () => true };
      }
      writeHubJson(c, { url: hubUrl(c.port), pid: 102 });
      current = orrery(c, 102);
      return { pid: 102, exited: () => false };
    },
  });
  assert.equal(await launch(f.deps), 0, f.errors.join(' | '));
  assert.equal(n, 2);
  assert.deepEqual(f.opened, [hubUrl(c.port)]);
});

test('launcher 7: a hub.json whose Hub never answers (no answer, or 503) blocks starting; reported after 20 s', async () => {
  for (const r of [{ kind: 'silent' }, { kind: 'answer', status: 503, body: { error: 'hub is starting' } }] as HealthResult[]) {
    const c = fakeConfig();
    writeHubJson(c, { url: hubUrl(c.port + 1), pid: 100 });
    const f = fakeDeps(c, { health: async () => r });
    assert.equal(await launch(f.deps), 1, r.kind);
    assert.deepEqual(f.spawns, [], 'nothing started');
    assert.ok(f.sleeps.length > 0 && f.sleeps.every((ms) => ms === 200), 'polled every 200 ms');
    assert.ok(f.errors[0].includes(`hub.json 指向的 ${hubUrl(c.port + 1)} 没有回答，无法确认上一个 orrery Hub 是否已经退出。启动器没有启动新的 Hub。`
      + `如果确定它已经不在了，删掉 ${join(c.home, 'hub.json')} 后再试。`), f.errors[0]);
  }
});

test('launcher 7: once the unconfirmed Hub answers definitely (gone), a Hub is started', async () => {
  const c = fakeConfig();
  writeHubJson(c, { url: hubUrl(c.port), pid: 100 });
  let calls = 0;
  let current: HealthResult = { kind: 'silent' };
  const f = fakeDeps(c, {
    health: async () => { if (++calls === 3) current = { kind: 'refused' }; return current; },
    spawnHub: () => {
      assert.equal(current.kind, 'refused', 'only after a definite answer');
      writeHubJson(c, { url: hubUrl(c.port), pid: 102 });
      current = orrery(c, 102);
      return { pid: 102, exited: () => false };
    },
  });
  assert.equal(await launch(f.deps), 0, f.errors.join(' | '));
  assert.deepEqual(f.opened, [hubUrl(c.port)]);
});

test('launcher: a Hub that exits with a free port fails with the log tail; missing modules suggest npm ci; logs rotate', async () => {
  const c = fakeConfig();
  const log = join(c.home, 'hub.log');
  writeFileSync(log, 'last run\n');
  const f = fakeDeps(c, {
    spawnHub: (file) => {
      appendFileSync(file, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk'\n");
      return { pid: 5, exited: () => true };
    },
  });
  assert.equal(await launch(f.deps), 1);
  assert.equal(readFileSync(log + '.1', 'utf8'), 'last run\n', 'the previous log is kept once');
  assert.match(f.errors[0], /orrery Hub 启动失败/);
  assert.match(f.errors[0], /npm ci/);
  assert.match(f.errors[0], /ERR_MODULE_NOT_FOUND/);
  assert.ok(f.errors[0].includes(log));
  assert.ok(f.errors[0].includes(REPO_ROOT));
  assert.deepEqual(f.opened, []);
});

test('launcher: a Hub that never becomes ready fails after 20 s; port 0 is refused', async () => {
  const c = fakeConfig();
  const f = fakeDeps(c, { spawnHub: () => ({ pid: 5, exited: () => false }) });
  assert.equal(await launch(f.deps), 1);
  assert.match(f.errors[0], /20 秒内就绪/);
  assert.deepEqual(f.opened, []);

  const zero = fakeDeps({ ...c, port: 0 });
  assert.equal(await launch(zero.deps), 1);
  assert.match(zero.errors[0], /ORRERY_PORT 为 0/);
  assert.deepEqual(zero.spawns, []);
});

/** A PowerShell runner that records calls instead of running anything. */
function fakeRunner(stdout = '') {
  const calls: { script: string; vars: Record<string, string> }[] = [];
  const run: PowerShellRunner = async (script, vars) => { calls.push({ script, vars }); return { code: 0, stdout }; };
  return { run, calls };
}

test('launcher: the browser opens only the local Hub address, passed to PowerShell in an environment variable', async () => {
  const r = fakeRunner();
  for (const bad of ['codex://threads/wake/x', 'http://localhost:4317', 'http://127.0.0.1:1/?k=v', 'https://example.com',
    'http://127.0.0.1:1/#token=a b', 'http://127.0.0.1:1/#token=', 'http://127.0.0.1:1/#x=1', 'http://127.0.0.1:1/x#token=abc']) {
    await assert.rejects(openInBrowser(bad, r.run, 'win32'), /refusing to open/, bad);
  }
  assert.equal(r.calls.length, 0);
  await openInBrowser('http://127.0.0.1:45999', r.run, 'win32');
  const page = pageUrl('http://127.0.0.1:45999', TEST_TOKEN);
  assert.equal(page, `http://127.0.0.1:45999/#token=${TEST_TOKEN}`);
  await openInBrowser(page, r.run, 'win32');
  assert.deepEqual(r.calls.map((c) => c.vars.ORRERY_LAUNCHER_URL), ['http://127.0.0.1:45999', page]);
  assert.equal(r.calls[0].script, 'Start-Process -FilePath $env:ORRERY_LAUNCHER_URL');
});

test('launcher: the API token comes from ORRERY_API_TOKEN, else <home>/api-token; a Hub that refuses it is not ours to reuse', async () => {
  const c = fakeConfig();
  assert.equal(apiTokenOf(c), undefined, 'no file yet');
  writeFileSync(join(c.home, 'api-token'), 'short\n');
  assert.equal(apiTokenOf(c), undefined, 'an unusable file');
  const fileToken = 'f'.repeat(43);
  writeFileSync(join(c.home, 'api-token'), `${fileToken}\n`);
  assert.equal(apiTokenOf(c), fileToken);
  assert.equal(apiTokenOf({ ...c, apiToken: TEST_TOKEN }), TEST_TOKEN, 'the environment wins');

  writeHubJson(c, { url: hubUrl(c.port), pid: 7 });
  const ok = fakeDeps(c, { health: async () => orrery(c, 7) });
  assert.equal(await launch(ok.deps), 0);
  assert.deepEqual(ok.opened, [`${hubUrl(c.port)}/#token=${fileToken}`]);

  const refused: HealthResult = { kind: 'answer', status: 401, body: { error: 'unauthorized' } };
  assert.deepEqual(await probe(c, async () => refused), { kind: 'unauthorized', url: hubUrl(c.port) });
  const f = fakeDeps(c, { health: async () => refused });
  assert.equal(await launch(f.deps), 1);
  assert.deepEqual([f.opened, f.spawns, f.sleeps], [[], [], []], 'fails at once: no browser, no second Hub, no waiting');
  assert.match(f.errors[0], /不接受本机的 API 令牌/);
  assert.ok(!f.errors[0].includes(fileToken), 'the message never shows the token');
});

test('launcher: the error dialog text goes through an environment variable, not the script', async () => {
  const r = fakeRunner();
  const message = "端口被占用 '; Remove-Item x; '";
  await showErrorDialog(message, r.run, 'win32');
  assert.deepEqual(r.calls, [{ script: DIALOG_SCRIPT, vars: { ORRERY_LAUNCHER_MESSAGE: message } }]);
  assert.ok(!DIALOG_SCRIPT.includes('Remove-Item'));
  const none = fakeRunner();
  await showErrorDialog('x', none.run, 'linux');
  assert.equal(none.calls.length, 0);
});

/**
 * createShortcut prints its result with console.log. In a test file stdout is node:test's report channel, and the
 * Node 24 test runner misreads text that reaches it in the same read as a report message when the text's third byte
 * is 0x80 or more, as in most Chinese text: "Unable to deserialize cloned data", the whole file fails. Keep it off stdout.
 */
function captureLog(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.join(' ')); });
  return lines;
}

test('launcher: --create-shortcut writes orrery.lnk via WScript.Shell with paths in environment variables (fake runner)', async (t) => {
  const printed = captureLog(t);
  const r = fakeRunner('created|C:\\Users\\someone\\Desktop\\orrery.lnk\r\n');
  assert.equal(await createShortcut(r.run, 'win32'), 0);
  assert.match(printed[0], /已在桌面创建快捷方式：C:\\Users\\someone\\Desktop\\orrery\.lnk$/);
  assert.equal(r.calls.length, 1);
  const { script, vars } = r.calls[0];
  assert.equal(script, SHORTCUT_SCRIPT);
  assert.deepEqual(vars, {
    ORRERY_SHORTCUT_TARGET: process.execPath,
    ORRERY_SHORTCUT_ARGUMENTS: `"${join(REPO_ROOT, 'src', 'launcher.ts')}"`,
    ORRERY_SHORTCUT_DIR: REPO_ROOT,
    ORRERY_SHORTCUT_ICON: join(REPO_ROOT, 'desktop', 'assets', 'orrery-icon.ico'),
  });
  for (const v of Object.values(vars)) assert.ok(!script.includes(v.replaceAll('"', '')), 'paths are not in the script');
  assert.match(script, /GetFolderPath\('Desktop'\)/);
  assert.match(script, /'orrery\.lnk'/);
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /WindowStyle = 7/);
  assert.doesNotMatch(script, /ExecutionPolicy|RunAs|HKCU|HKLM|Startup/i);

  const other = fakeRunner();
  assert.equal(await createShortcut(other.run, 'linux'), 1);
  assert.equal(other.calls.length, 0, 'Windows only');
  assert.match(printed.at(-1)!, /只支持 Windows/);
});

test('launcher: PowerShell is always run with -NoProfile -NonInteractive -Command', () => {
  const src = readFileSync(join(REPO_ROOT, 'src', 'launcher.ts'), 'utf8');
  const spawns = [...src.matchAll(/spawn\('powershell\.exe', (\[[^\]]*\])/g)].map((m) => m[1]);
  assert.deepEqual(spawns, ["['-NoProfile', '-NonInteractive', '-Command', script]"]);
});

test('launcher: the shortcut script writes a working orrery.lnk (Windows; a temp folder stands in for the Desktop)', { skip: process.platform !== 'win32' }, async (t) => {
  const printed = captureLog(t);
  const dir = join(tempDir(), 'fake desktop');
  mkdirSync(dir);
  const desktop = "[Environment]::GetFolderPath('Desktop')";
  assert.ok(SHORTCUT_SCRIPT.includes(desktop));
  // Same script with only the Desktop folder swapped; the real runner, so the PowerShell invocation is the real one.
  const run: PowerShellRunner = (script, vars) => runPowerShell(script.replace(desktop, '$env:ORRERY_TEST_DESKTOP'), { ...vars, ORRERY_TEST_DESKTOP: dir });
  assert.equal(await createShortcut(run, 'win32'), 0);
  assert.equal(await createShortcut(run, 'win32'), 0, 'an existing shortcut is replaced');
  assert.match(printed.find((l) => l.startsWith('已覆盖'))!, /orrery\.lnk$/, 'an existing shortcut is replaced');
  const read = await runPowerShell(
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $env:ORRERY_TEST_DESKTOP 'orrery.lnk')); [Console]::OutputEncoding = [Text.Encoding]::UTF8; $s.TargetPath; $s.Arguments; $s.WorkingDirectory; $s.WindowStyle; $s.IconLocation",
    { ORRERY_TEST_DESKTOP: dir });
  assert.deepEqual(read.stdout.trim().split(/\r?\n/), [process.execPath, `"${join(REPO_ROOT, 'src', 'launcher.ts')}"`, REPO_ROOT, '7', `${join(REPO_ROOT, 'desktop', 'assets', 'orrery-icon.ico')},0`]);
});

test('launcher: a browser that cannot be opened is an error (PowerShell code 1 or no code); the Hub is left running', async () => {
  for (const code of [1, null]) {
    const run: PowerShellRunner = async () => ({ code, stdout: '' });
    await assert.rejects(openInBrowser('http://127.0.0.1:45999', run, 'win32'), /browser/, String(code));
  }
  const c = fakeConfig();
  writeHubJson(c, { url: hubUrl(c.port), pid: 7 });
  const f = fakeDeps(c, { health: async () => orrery(c, 7), openBrowser: async () => { throw new Error('no browser'); } });
  assert.equal(await launch(f.deps), 1);
  assert.deepEqual(f.spawns, []);
  assert.match(f.errors[0], /orrery Hub 已在运行，但打不开默认浏览器。请手动在浏览器里打开 http:\/\/127\.0\.0\.1:45999。/);
});

test('launcher: relative ORRERY_HOME / ORRERY_DB from another directory reach the Hub as the same absolute paths', async () => {
  await withFreePort(async (port) => {
  const base = join(tempDir(), 'caller dir');
  mkdirSync(base, { recursive: true });
  const env = { ...process.env, ORRERY_PORT: String(port), ORRERY_HOME: 'home', ORRERY_DB: join('data', 'h.db') };
  const before = process.cwd();
  let r: ReturnType<typeof realDeps> | undefined;
  try {
    process.chdir(base);
    r = realDeps(env);
    assert.equal(r.deps.config.home, join(base, 'home'));
    const child = childEnv(env, r.deps.config);
    assert.deepEqual([child.ORRERY_HOME, child.ORRERY_DB, child.ORRERY_PORT],
      [join(base, 'home'), join(base, 'data', 'h.db'), String(port)]);
    assert.equal(child.PATH ?? child.Path, process.env.PATH ?? process.env.Path, 'the rest is inherited');
    const code = await launch(r.deps);
    if (code !== 0 && portTaken(r.errors.join('\n'))) throw Object.assign(new Error(r.errors.join('\n')), { code: 'EADDRINUSE' });
    assert.equal(code, 0, r.errors.join('\n'));
    const token = readFileSync(join(base, 'home', 'api-token'), 'utf8').trim();   // no ORRERY_API_TOKEN here: the Hub made one
    assert.deepEqual(r.opened, [pageUrl(hubUrl(port), token)]);
    assert.ok(existsSync(join(base, 'home', 'hub.json')));
    assert.ok(existsSync(join(base, 'data', 'h.db')));
    assert.equal(existsSync(join(REPO_ROOT, 'home')), false, 'nothing resolved against the repository');
  } finally {
    process.chdir(before);
    const token = r ? apiTokenOf(r.deps.config) : undefined;   // config paths are absolute: safe after chdir
    for (const s of r?.spawned ?? []) await stopHub(port, s, token);
  }
  });
});

test('launcher 7: a same-data Hub still closing on another port is waited for; no second Hub until its close() resolves', async () => withFreePort(async (p) => {
  const dir = tempDir();
  const gate = Promise.withResolvers<void>();
  let entered = false;
  let aborted = false;
  // A worker that takes a while to clean up after the abort.
  const script: MockScript = async (_msg, _tools, _emit, signal) => {
    entered = true;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await gate.promise;
  };
  const a = await startTestHub({ dir, mock: { script } });
  const q = Number(new URL(a.url).port);
  const env = { ...hubEnv(dir, p), ORRERY_DB: join(dir, 'test.db') };
  const r = realDeps(env);
  const spawnedAt: number[] = [];
  const spawnHub = r.deps.spawnHub;
  r.deps.spawnHub = (log) => { spawnedAt.push(Date.now()); return spawnHub(log); };
  let closedAt = 0;
  try {
    if (p === q) throw Object.assign(new Error('the running Hub was given the reserved port'), { code: 'EADDRINUSE' });
    const { cluster } = await a.cluster('c', ['A']);
    a.hub.sendFromUser(cluster.id, '@A hold');
    const id: string = await waitFor(() => entered && (a.store.db.prepare("SELECT id FROM deliveries WHERE state = 'running'").get() as { id: string } | undefined)?.id, 'A running') as string;
    const delivery = () => a.store.db.prepare('SELECT state, attempts FROM deliveries WHERE id = ?').get(id) as { state: string; attempts: number };
    const closing = a.close().then(() => { closedAt = Date.now(); });
    await waitFor(() => aborted, 'the turn to be aborted');
    const launching = launch(r.deps);
    await sleep(1500);
    assert.deepEqual(spawnedAt, [], 'no second Hub while A is closing');
    assert.deepEqual({ ...delivery() }, { state: 'running', attempts: 1 }, 'not redone while A is closing');
    gate.resolve();
    await closing;
    const launchResult = await launching;
    if (launchResult !== 0 && portTaken(r.errors.join(' | '))) throw Object.assign(new Error(r.errors.join(' | ')), { code: 'EADDRINUSE' });
    assert.equal(launchResult, 0, r.errors.join(' | '));
    assert.equal(spawnedAt.length, 1);
    assert.ok(spawnedAt[0] >= closedAt, 'B starts only after A has closed');
    assert.deepEqual(r.opened, [pageUrl(hubUrl(p), TEST_TOKEN)]);
  } finally {
    gate.resolve();
    await a.close();
    for (const s of r.spawned) await stopHub(p, s);
  }
}));

test('launcher 7: a health check that gets no answer while the old Hub is closing does not count as gone', async () => withFreePort(async (p) => {
  const dir = tempDir();
  const gate = Promise.withResolvers<void>();
  let entered = false;
  let aborted = false;
  // A worker that takes a while to clean up after the abort.
  const script: MockScript = async (_msg, _tools, _emit, signal) => {
    entered = true;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await gate.promise;
  };
  const a = await startTestHub({ dir, mock: { script } });
  const q = Number(new URL(a.url).port);
  const env = { ...hubEnv(dir, p), ORRERY_DB: join(dir, 'test.db') };
  const r = realDeps(env);
  // stopping → no answer (injected) → stopping again: the silent check must not open the way for a second Hub.
  const seen: string[] = [];
  let qChecks = 0;
  r.deps.health = async (port) => {
    if (port === q && ++qChecks === 2) { seen.push('silent'); return { kind: 'silent' }; }
    const h = await getHealth(port, TEST_TOKEN);
    if (port === q) seen.push(h.kind === 'answer' ? (h.body as { state: string }).state : h.kind);
    return h;
  };
  const spawnedAt: number[] = [];
  const spawnHub = r.deps.spawnHub;
  r.deps.spawnHub = (log) => { spawnedAt.push(Date.now()); return spawnHub(log); };
  let closedAt = 0;
  try {
    if (p === q) throw Object.assign(new Error('the running Hub was given the reserved port'), { code: 'EADDRINUSE' });
    const { cluster } = await a.cluster('c', ['A']);
    a.hub.sendFromUser(cluster.id, '@A hold');
    const id: string = await waitFor(() => entered && (a.store.db.prepare("SELECT id FROM deliveries WHERE state = 'running'").get() as { id: string } | undefined)?.id, 'A running') as string;
    const delivery = () => a.store.db.prepare('SELECT state, attempts FROM deliveries WHERE id = ?').get(id) as { state: string; attempts: number };
    const closing = a.close().then(() => { closedAt = Date.now(); });
    await waitFor(() => aborted, 'the turn to be aborted');
    const launching = launch(r.deps);
    await sleep(1500);
    assert.deepEqual(seen.slice(0, 3), ['stopping', 'silent', 'stopping']);
    assert.deepEqual(spawnedAt, [], 'no second Hub while A is closing');
    assert.deepEqual({ ...delivery() }, { state: 'running', attempts: 1 }, 'not redone while A is closing');
    gate.resolve();
    await closing;
    const launchResult = await launching;
    if (launchResult !== 0 && portTaken(r.errors.join(' | '))) throw Object.assign(new Error(r.errors.join(' | ')), { code: 'EADDRINUSE' });
    assert.equal(launchResult, 0, r.errors.join(' | '));
    assert.equal(spawnedAt.length, 1);
    assert.ok(spawnedAt[0] >= closedAt, 'B starts only after A has closed');
    assert.deepEqual(r.opened, [pageUrl(hubUrl(p), TEST_TOKEN)]);
  } finally {
    gate.resolve();
    await a.close();
    for (const s of r.spawned) await stopHub(p, s);
  }
}));

test('launcher --ensure: the address is written instead of opening a browser, the error instead of a dialog', async () => {
  const c = fakeConfig();
  writeHubJson(c, { url: hubUrl(c.port), pid: 7 });
  const lines: string[] = [];
  const write = async (line: string) => { lines.push(line); };
  const ok = fakeDeps(c, { health: async () => orrery(c, 7) });
  assert.equal(await launch(ensureDeps(ok.deps, write)), 0);
  assert.deepEqual(lines, [JSON.stringify({ url: hubUrl(c.port) })]);
  assert.deepEqual([ok.opened, ok.errors, ok.spawns], [[], [], []], 'no browser, no dialog, no second Hub');

  lines.length = 0;
  const bad = fakeDeps(c, { health: async () => orrery(c, 7, 'running', { db: join(c.home, 'other.db') }) });
  assert.equal(await launch(ensureDeps(bad.deps, write)), 1);
  assert.equal(lines.length, 1);
  assert.match(JSON.parse(lines[0]).error, /另一个数据目录[\s\S]*hub\.log/);
  assert.deepEqual([bad.opened, bad.errors, bad.spawns], [[], [], []]);
});

/** Runs `node src/launcher.ts <args>` as the desktop shell does and collects its output. */
function runLauncher(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'src', 'launcher.ts'), ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
    child.once('close', (code) => done({ code, stdout }));
  });
}

test('launcher --ensure (real processes): starts a Hub and prints its address; a second run reuses it; failures are one JSON line', async () => {
  await withFreePort(async (port) => {
  const dir = tempDir();
  // No ORRERY_API_TOKEN: the Hub makes <home>/api-token and the launcher reads it from there.
  const env = { ...hubEnv(dir, port), ORRERY_API_TOKEN: undefined };
  let pid: number | undefined;
  let token: string | undefined;
  try {
    const first = await runLauncher(['--ensure'], env);
    if (first.code !== 0 && portTaken(first.stdout)) throw Object.assign(new Error(first.stdout), { code: 'EADDRINUSE' });
    token = readFileSync(join(dir, 'home', 'api-token'), 'utf8').trim();
    assert.notEqual(token, TEST_TOKEN);
    const line = `${JSON.stringify({ url: `${hubUrl(port)}/#token=${token}` })}\n`;
    assert.deepEqual(first, { code: 0, stdout: line });
    const h = await getHealth(port, token);
    pid = h.kind === 'answer' ? (h.body as { pid: number }).pid : undefined;
    assert.ok(pid, 'a Hub is running');
    assert.equal(JSON.parse(readFileSync(join(dir, 'home', 'hub.json'), 'utf8')).pid, pid);
    assert.deepEqual(await getHealth(port), { kind: 'answer', status: 401, body: { error: 'unauthorized' } }, 'health needs the token too');

    const second = await runLauncher(['--ensure'], env);
    assert.deepEqual(second, { code: 0, stdout: line });
    const again = await getHealth(port, token);
    assert.equal(again.kind === 'answer' && (again.body as { pid: number }).pid, pid, 'the same Hub, no second one');
  } finally {
    // shortcut: the Hub is the launcher child's child, so there is no handle and this one check is by PID; /api/health named that PID just now.
    const hubPid = pid;
    await stopHub(port, { pid: hubPid, exited: () => hubPid === undefined || !alive(hubPid) }, token);
  }
  const zero = await runLauncher(['--ensure'], { ...env, ORRERY_PORT: '0' });
  assert.equal(zero.code, 1);
  assert.equal(zero.stdout.split('\n').filter(Boolean).length, 1);
  assert.match(JSON.parse(zero.stdout).error, /ORRERY_PORT 为 0/);
  });
});
