import { TEST_HUB_ID } from './helpers.ts';
// The background-wait core with a harness that is not ZCode (docs/adapters/zcode.md, "共用等待核心"): everything that
// varies comes from its WaitHarness, and the anti-loop and offline rules hold for it. Real Hub routes and the real
// wait.mjs as a child process; nothing here runs a native app or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { basename, join } from 'node:path';
import { copyFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appProcessRunning, createWaitDelivery } from '../src/adapters/shared/wait-native.ts';
import { ZCODE_WAIT, type BridgePort, type Member, type NativeAdapter, type NativeDeliverContext, type WaitHarness } from '../src/core/types.ts';
import { REPO_ROOT } from '../src/main.ts';
import { ARM_LIMIT, metaSession, NOT_MEMBER_TEXT, ticketFor, ticketSession, waitCommand, WAIT_SCRIPT } from '../src/mcp/wait-core.ts';
import { startTestHub, tempDir, waitFor, openSse } from './helpers.ts';

const WAIT = join(REPO_ROOT, 'plugins', 'zcode-orrery', 'wait.mjs');
const waitModule = await import(pathToFileURL(WAIT).href);
const FAKE_META_KEY = 'com.fake/sessionId';
const FAKE: WaitHarness = { harness: 'fakewait', appProcess: 'FakeApp.exe', ancestorProcess: 'FakeAgent.exe', metaKey: FAKE_META_KEY };
const S1 = 'conv-1';
const S2 = 'conv-2';

function fakeAdapter(h: WaitHarness, opts: { appRunning?: () => Promise<boolean | null>; graceMs?: number } = {}): NativeAdapter {
  const delivery = createWaitDelivery(h, { notRearmed: 'not re-armed', rearmGraceMs: opts.graceMs ?? 60_000, pollMs: 10, appRunning: opts.appRunning ?? (async () => true) });
  return {
    harness: h.harness,
    wait: h,
    listProjects: async () => [],
    listSessions: async () => [],
    attachSession: async (id) => ({ id, title: id, model: null, cwd: 'x', updatedAt: null }),
    isOnline: delivery.isOnline,
    deliver: delivery.deliver,
  };
}

async function fakeHub(h: WaitHarness = FAKE, opts: { appRunning?: () => Promise<boolean | null>; graceMs?: number } = {}) {
  const app = await startTestHub({ nativeAdapters: { [h.harness]: fakeAdapter(h, opts) }, limits: { recheckMs: 60_000 } });
  const secret = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  const { cluster, members: [m1] } = await app.api('POST', '/api/clusters', {
    name: 'fk',
    members: [
      { harness: h.harness, mode: 'native', sessionId: S1, name: 'F1' },
      { harness: h.harness, mode: 'native', sessionId: S2, name: 'F2' },
    ],
  });
  const statusOf = async () => ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === m1.id)!.status;
  const say = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
  const deliveries = async () => (await app.messages(cluster.id)).flatMap((m) => m.deliveries.filter((d) => d.memberId === m1.id));
  return Object.assign(app, { secret, cluster, m1, statusOf, say, deliveries });
}

/** A fake wait.mjs on the harness's own route. */
function openWait(url: string, harness: string, ticket: string) {
  return openSse(`${url}/bridge/${harness}-wait`, { 'x-orrery-ticket': ticket });
}

const ack = (url: string, harness: string, ticket: string, deliveryId: string) => fetch(`${url}/bridge/${harness}-ack`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, deliveryId }),
}).then((r) => r.json());

test('wait core config: the ticket, the command and the _meta key come from the harness config', () => {
  const t = ticketFor(FAKE, 'secret-a', S1, TEST_HUB_ID);
  assert.match(t, /^f2\.[0-9a-f-]{36}\.conv-1\.[0-9a-f]{64}$/);
  assert.equal(ticketSession(FAKE, 'secret-a', t, TEST_HUB_ID), S1);
  assert.equal(ticketSession(FAKE, 'secret-b', t, TEST_HUB_ID), null, 'another secret');
  assert.equal(ticketSession(ZCODE_WAIT, 'secret-a', t, TEST_HUB_ID), null, 'a ticket of one harness is void for another');
  assert.equal(ticketSession(FAKE, 'secret-a', ticketFor(ZCODE_WAIT, 'secret-a', S1, TEST_HUB_ID), TEST_HUB_ID), null);
  const sameLetter: WaitHarness = { ...FAKE, harness: 'fakeother' };
  assert.equal(ticketSession(sameLetter, 'secret-a', t, TEST_HUB_ID), null, 'the same first letter does not make it valid: the signature names the harness');

  const hub = 'http://127.0.0.1:4390';
  assert.equal(waitCommand(FAKE, t, hub), `node "${WAIT_SCRIPT}" ${t} ${hub} fakewait FakeAgent.exe`);
  assert.equal(waitCommand({ ...FAKE, ancestorProcess: null }, t, hub), `node "${WAIT_SCRIPT}" ${t} ${hub} fakewait`);
  assert.equal(waitCommand(ZCODE_WAIT, ticketFor(ZCODE_WAIT, 'secret-a', S1, TEST_HUB_ID), hub), `node "${WAIT_SCRIPT}" ${ticketFor(ZCODE_WAIT, 'secret-a', S1, TEST_HUB_ID)} ${hub}`, 'ZCode: no harness arguments');
  for (const bad of ['Fake App.exe', 'a&calc', 'x"y', '']) assert.throws(() => waitCommand({ ...FAKE, ancestorProcess: bad }, t, hub), bad);
  assert.throws(() => waitCommand({ ...FAKE, harness: 'Fake Wait' }, t, hub));

  assert.equal(metaSession(FAKE_META_KEY, { [FAKE_META_KEY]: S1, session_id: 'other' }), S1, 'the configured key, not ZCode\'s');
  assert.equal(metaSession(FAKE_META_KEY, { session_id: S1 }), undefined);
  assert.equal(metaSession(FAKE_META_KEY, { [FAKE_META_KEY]: 7 }), undefined);
  assert.equal(metaSession(FAKE_META_KEY, undefined), undefined);
  assert.equal(metaSession(undefined, { session_id: S1 }), undefined, 'a harness with no _meta key (WorkBuddy: process environment)');
  assert.equal(ZCODE_WAIT.metaKey, 'session_id');
  assert.equal(ZCODE_WAIT.appProcess, 'ZCode.exe');
});

test('wait core config: the app process name comes from the config (tasklist, read-only)', { skip: process.platform !== 'win32' && 'tasklist' }, async () => {
  // A busy host can time out on the user filter. "Unknown" still has to resolve to the expected answer.
  const known = async (image: string) => {
    for (let i = 0; i < 3; i++) {
      const answer = await appProcessRunning(image);
      if (answer !== null) return answer;
    }
    return null;
  };
  // Use one owned process of a unique name. Querying every node.exe also inspects unrelated user processes.
  const image = `orrery-wait-${process.pid}.exe`;
  const fixture = join(tempDir(), image);
  copyFileSync(join(process.env.SystemRoot!, 'System32', 'sort.exe'), fixture);
  const child = spawn(fixture, [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    await once(child, 'spawn');
    assert.equal(await known(image), true, 'the fixture is running for this user');
  } finally {
    child.stdin.end();   // sort exits at EOF
    await closed;
  }
  assert.equal(await known(image), false, 'the same fixture has exited');
});

test('wait core: a harness without a wait config gets no wait route', async () => {
  const app = await startTestHub();
  try {
    assert.equal(app.hub.waitHarness('mock'), undefined);
    const r = await rawStatus(`${app.url}/bridge/mock-wait`);
    assert.equal(r, 401, 'falls through to the bridge secret check');
  } finally {
    await app.close();
  }
});

function rawStatus(url: string): Promise<number> {
  return new Promise((ok, fail) => {
    const req = request(url, (res) => { res.resume(); ok(res.statusCode!); });
    req.on('error', fail);
    req.end();
  });
}

test('wait core: a new harness on its own route: envelope only (no instruction), acked, busy until re-armed', async () => {
  const app = await fakeHub();
  try {
    const ticket = ticketFor(FAKE, app.secret, S1, app.registry.hubId);
    assert.equal(await openWait(app.url, 'fakewait', ticketFor(ZCODE_WAIT, app.secret, S1, app.registry.hubId)).status, 403, 'a ZCode ticket is void here');
    const first = openWait(app.url, 'fakewait', ticket);
    assert.equal(await first.status, 200);
    await waitFor(async () => (await app.statusOf()) === 'idle', 'online once a wait is connected');
    const m = await app.say('@F1 hello');
    await waitFor(() => first.events.length, 'the delivery');
    const [{ event, data }] = first.events;
    assert.equal(event, 'deliver');
    assert.ok(data.text.includes(`messageId=${m.id}`) && data.text.includes('@F1 hello'));
    for (const instruction of ['再运行', '重新运行', 'run_in_background', 'wait.mjs', ticket]) assert.ok(!data.text.includes(instruction), `no "${instruction}" in the envelope`);
    assert.equal(await app.statusOf(), 'busy');
    assert.deepEqual(await ack(app.url, 'fakewait', ticketFor(FAKE, app.secret, S2, app.registry.hubId), data.deliveryId), { acked: false });
    assert.deepEqual(await ack(app.url, 'fakewait', ticket, data.deliveryId), { acked: true });
    await first.ended;
    const again = openWait(app.url, 'fakewait', ticket);
    await waitFor(async () => (await app.deliveries())[0]?.state === 'done', 're-armed: the batch is over');
    again.close();
  } finally {
    await app.close();
  }
});

test('wait core: a new harness holds a duplicate wait aside, and it takes over after a delivery', async () => {
  const app = await fakeHub();
  try {
    const ticket = ticketFor(FAKE, app.secret, S1, app.registry.hubId);
    const a = openWait(app.url, 'fakewait', ticket);
    await waitFor(async () => (await app.statusOf()) === 'idle', 'online');
    const b = openWait(app.url, 'fakewait', ticket);
    await b.status;
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'fakewait_extra_wait' && e.memberId === app.m1.id), 'the notice under this harness');
    await app.say('@F1 one');
    await waitFor(() => a.events.length, 'delivered to the first wait');
    assert.equal(b.events.length, 0, 'never to the held one');
    await ack(app.url, 'fakewait', ticket, a.events[0].data.deliveryId);
    await waitFor(async () => (await app.deliveries())[0]?.state === 'done', 'the held wait took over: re-armed');
    await app.say('@F1 two');
    await waitFor(() => b.events.length, 'the next delivery on the promoted wait');
    a.close();
    b.close();
  } finally {
    await app.close();
  }
});

test('wait core: a new harness takes at most ARM_LIMIT waits per window; a removed member is told to stop', async () => {
  const app = await fakeHub();
  try {
    const ticket = ticketFor(FAKE, app.secret, S1, app.registry.hubId);
    const waits: ReturnType<typeof openWait>[] = [];
    for (let i = 0; i < ARM_LIMIT; i++) {
      const w = openWait(app.url, 'fakewait', ticket);
      await w.status;
      waits.push(w);
    }
    assert.ok(!app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'fakewait_arm_rate'));
    const over = openWait(app.url, 'fakewait', ticket);
    await over.status;
    await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).reason === 'fakewait_arm_rate' && e.memberId === app.m1.id), 'rate notice');
    for (let i = 0; i < ARM_LIMIT; i++) {
      await app.say(`@F1 m${i}`);
      await waitFor(() => waits[i].events.length, `delivery ${i}`);
      await ack(app.url, 'fakewait', ticket, waits[i].events[0].data.deliveryId);
    }
    await app.say('@F1 last');
    await new Promise((ok) => setTimeout(ok, 100));
    assert.equal(over.events.length, 0, 'an over-limit wait is never used');
    await app.api('DELETE', `/api/clusters/${app.cluster.id}/members/${app.m1.id}`, {});
    await over.ended;
    assert.deepEqual(over.events, [{ event: 'end', data: { text: NOT_MEMBER_TEXT } }]);
  } finally {
    await app.close();
  }
});

test('wait core: the application process gone: a connected wait is offline and gets nothing; deliver reports offline', async () => {
  const app = await fakeHub(FAKE, { appRunning: async () => false });
  try {
    const wait = openWait(app.url, 'fakewait', ticketFor(FAKE, app.secret, S1, app.registry.hubId));
    assert.equal(await wait.status, 200);
    await app.say('@F1 to an orphan');
    await waitFor(async () => (await app.deliveries())[0]?.state === 'offline', 'the delivery ends offline');
    assert.equal(wait.events.length, 0, 'nothing delivered to the orphaned wait');
    assert.equal(await app.statusOf(), 'offline');
    wait.close();
  } finally {
    await app.close();
  }
});

test('wait core: the adapter asks the configured app check before a push; unknown counts as running', async () => {
  let answer: boolean | null = false;
  const delivery = createWaitDelivery(FAKE, { notRearmed: 'x', pollMs: 10, appRunning: async () => answer });
  const pushed: string[] = [];
  const asked: string[] = [];
  const bridge: BridgePort = {
    isOnline: (h) => (asked.push(h), true),
    push: async (_h, _s, id) => (pushed.push(id), { ok: true }),
    waitDone: async () => 'dropped',
  };
  const ctx = { deliveryId: 'd1', bridge, onEvent: () => {}, signal: new AbortController().signal } as NativeDeliverContext;
  assert.equal(await delivery.deliver(S1, 'text', ctx), 'offline');
  assert.deepEqual(pushed, [], 'nothing pushed while the app is gone');
  assert.ok(asked.every((h) => h === 'fakewait'), 'the bridge is asked about this harness only');
  answer = null;
  assert.equal(await delivery.deliver(S1, 'text', { ...ctx, deliveryId: 'd2' }), 'accepted');
  assert.deepEqual(pushed, ['d2']);
});

test('wait.mjs: a named ancestor is matched by name, past programs that are not shells', () => {
  const table = [
    { pid: 10, ppid: 1, name: 'FakeApp.exe' },
    { pid: 20, ppid: 10, name: 'helper.exe' },
    { pid: 30, ppid: 20, name: 'bash.exe' },
  ];
  assert.equal(waitModule.anchorOf(table, 30, 'FakeApp.exe'), 10);
  assert.equal(waitModule.anchorOf(table, 30, 'fakeapp.EXE'), 10, 'case-insensitive');
  assert.equal(waitModule.anchorOf(table, 30), 20, 'without a name: the first that is not a shell');
  assert.equal(waitModule.anchorOf(table, 30, 'nope.exe'), null, 'not in the chain');
});

function runWait(...args: string[]) {
  const child = spawn(process.execPath, [WAIT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
  child.stderr.resume();
  const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
  return { child, exited, out: () => out };
}

test('wait.mjs: a new harness\'s command uses its route, prints only the envelope, acks and exits; bad arguments stop before any connection', async () => {
  const app = await fakeHub();
  let wait: ReturnType<typeof runWait> | undefined;
  try {
    const ticket = ticketFor(FAKE, app.secret, S1, app.registry.hubId);
    wait = runWait(ticket, app.url, 'fakewait', 'FakeAgent.exe');
    await waitFor(async () => (await app.statusOf()) === 'idle', 'wait.mjs connected', 10_000);
    assert.equal(wait.out(), '', 'a named harness prints nothing while it waits');
    const m = await app.say('@F1 via the real command');
    assert.equal(await wait.exited, 0);
    const printed = wait.out();
    assert.ok(printed.includes(`messageId=${m.id}`) && printed.includes('@F1 via the real command'));
    assert.ok(!printed.includes('再运行') && !printed.includes(ticket), 'no instruction after the envelope');
    await waitFor(async () => (await app.statusOf()) === 'busy', 'in the re-arm grace');

    for (const args of [
      [ticket, app.url, 'zcode'],                         // the ticket is not this harness's
      [ticket, app.url, 'Bad Harness'],
      [ticket, app.url, 'fakewait', 'a&calc'],
      [ticket, app.url, 'fakewait', 'FakeAgent.exe', 'extra'],
    ]) {
      const bad = runWait(...args);
      assert.equal(await bad.exited, 0);
      assert.equal(bad.out(), waitModule.BAD_TICKET, args.join(' '));
    }
  } finally {
    wait?.child.kill();
    await app.close();
  }
});

test('wait.mjs: with a named ancestor it exits when that process is gone, and the member goes offline', { skip: process.platform !== 'win32' && 'Windows process table' }, async () => {
  const named: WaitHarness = { ...FAKE, ancestorProcess: basename(process.execPath) };
  const app = await fakeHub(named);
  let anchor: ReturnType<typeof spawn> | undefined;
  try {
    const command = waitCommand(named, ticketFor(named, app.secret, S1, app.registry.hubId), app.url);
    // Like an app: a program starts a shell that runs the wait. Killing the program leaves the shell alive.
    anchor = spawn(process.execPath, ['-e', `require('node:child_process').spawn(${JSON.stringify(command)}, { shell: true, stdio: 'ignore' }); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    await waitFor(async () => (await app.statusOf()) === 'idle', 'wait.mjs connected', 15_000);
    await new Promise((ok) => setTimeout(ok, 4000));   // let it read the process table
    anchor.kill();
    await waitFor(async () => (await app.statusOf()) === 'offline', 'wait.mjs gone after its ancestor', 20_000);
    await app.say('@F1 nobody home');
    await waitFor(async () => (await app.deliveries())[0]?.state === 'offline', 'nothing delivered');
  } finally {
    anchor?.kill();
    await app.close();
  }
});
