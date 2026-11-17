// Native Cursor without Cursor (docs/adapters/cursor.md, "测试计划"): the Hub's park registry and turn reports
// (src/mcp/hook-park.ts), the adapter's delivery state machine (src/adapters/cursor/native.ts) driven by fake hooks
// speaking the HTTP protocol, and the read-only conversation list over a fake transcript folder. Nothing here runs
// Cursor, reads its data or calls a model; the plugin's real hook scripts are in cursor-plugin.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCursorNativeAdapter, cursorTokens, handoutOf, NOT_CONFIRMED } from '../src/adapters/cursor/native.ts';
import { createCursorStore, projectKey, userText } from '../src/adapters/cursor/store.ts';
import { nativeFactories } from '../src/adapters/index.ts';
import { marker } from '../src/adapters/shared/marker.ts';
import type { Member, TurnReport } from '../src/core/types.ts';
import { REPO_ROOT } from '../src/main.ts';
import { turnReport } from '../src/mcp/hook-park.ts';
import { startTestHub, tempDir, waitFor, openSse } from './helpers.ts';

const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const OUTSIDER = 'cccccccc-3333-4333-8333-333333333333';

type Times = { confirmMs?: number; turnMs?: number; reparkMs?: number; pollMs?: number };

/** A fake ~/.cursor with a transcript for each id (so the members can be attached). */
function fakeCursorHome(ids: string[]): string {
  const fake = tempDir();
  for (const id of ids) {
    const dir = join(fake, 'projects', 'c-work-alpha', 'agent-transcripts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ role: 'user', message: { content: `conversation ${id.slice(0, 4)}` } })}\n`);
  }
  return fake;
}

async function cHub(opts: { running?: () => Promise<boolean | null>; times?: Times; limits?: Record<string, number>; dir?: string } = {}) {
  const fake = fakeCursorHome([S1, S2]);
  const adapter = createCursorNativeAdapter({ cursorHome: fake, cursorData: fake, cursorRunning: opts.running ?? (async () => true),
    times: { confirmMs: 2000, turnMs: 5000, reparkMs: 300, pollMs: 10, ...opts.times } });
  const reports: TurnReport[] = [];
  const turn = adapter.turnHooks.turn;
  adapter.turnHooks.turn = (r) => { reports.push(r); turn(r); };
  const app = await startTestHub({ ...(opts.dir ? { dir: opts.dir } : {}), nativeAdapters: { cursor: adapter }, limits: { recheckMs: 60_000, bridgeAckMs: 1000, ...opts.limits } });
  const secret = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  const { cluster, members: [c1, c2] } = await app.api('POST', '/api/clusters', {
    name: 'cc',
    members: [
      { harness: 'cursor', mode: 'native', sessionId: S1, name: 'C1' },
      { harness: 'cursor', mode: 'native', sessionId: S2, name: 'C2' },
      { projectPath: tempDir(), harness: 'mock', name: 'A' },
    ],
  });
  const statusOf = async (id = c1.id) => ((await app.api('GET', '/api/state')).members as Member[]).find((m) => m.id === id)!.status;
  const say = (body: string) => app.api('POST', `/api/clusters/${cluster.id}/messages`, { body });
  const deliveries = async (id = c1.id) => (await app.messages(cluster.id)).flatMap((m) => m.deliveries.filter((d) => d.memberId === id));
  return Object.assign(app, { secret, cluster, c1, c2, reports, adapter, statusOf, say, deliveries });
}
type CHub = Awaited<ReturnType<typeof cHub>>;

/** POST /bridge/cursor-turn as a hook would. */
async function report(app: { url: string; secret: string }, body: unknown, secret: string | null = app.secret) {
  const res = await fetch(`${app.url}/bridge/cursor-turn`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-orrery-bridge': secret }) }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const start = (app: CHub, generationId: string, handout?: string, sessionId = S1) => report(app, { sessionId, event: 'start', generationId, ...(handout ? { handout } : {}) });
const end = (app: CHub, generationId: string, extra: Record<string, unknown> = {}, sessionId = S1) => report(app, { sessionId, event: 'end', generationId, status: 'completed', ...extra });

/** A fake parked stop hook: GET /bridge/cursor-park. */
function park(app: { url: string; secret: string }, session = S1, since = Date.now(), secret: string | null = app.secret) {
  const url = `${app.url}/bridge/cursor-park?session=${encodeURIComponent(session)}&since=${since}&version=3.29.9`;
  return openSse(url, secret === null ? {} : { 'x-orrery-bridge': secret });
}
const ack = (app: CHub, deliveryId: string) => fetch(`${app.url}/bridge/ack`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-bridge': app.secret }, body: JSON.stringify({ deliveryId, ok: true }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** A park that is registered (the member shows online). */
async function parked(app: CHub, session = S1, since = Date.now()) {
  const p = park(app, session, since);
  assert.equal(await p.status, 200);
  await waitFor(() => app.hub.bridge.isOnline('cursor', session), 'parked');
  return p;
}

/** Runs one delivery to its confirmation as Cursor would: take it, ack, start the turn with the hand-over id. */
async function takeAndStart(app: CHub, p: ReturnType<typeof park>, generationId: string) {
  await waitFor(() => p.events.find((e) => e.event === 'deliver'), 'a deliver event');
  const { deliveryId, text } = p.events.find((e) => e.event === 'deliver')!.data;
  await ack(app, deliveryId);
  const handout = /· #([0-9a-f]{8})\]$/.exec(text.split('\n')[0])![1];
  await start(app, generationId, handout);
  return { deliveryId, text, handout };
}

test('cursor turn reports: secret required, validated field by field, unknown fields dropped, park only for members', async () => {
  const app = await cHub();
  try {
    assert.equal((await report(app, { sessionId: S1, event: 'start', generationId: 'g' }, null)).status, 401);
    assert.equal((await report(app, { sessionId: S1, event: 'start', generationId: 'g' }, 'wrong')).status, 401);
    const p = park(app, S1, Date.now(), null);
    assert.equal(await p.status, 401);
    for (const bad of [
      {}, { sessionId: S1, event: 'start' }, { sessionId: S1, event: 'begin', generationId: 'g' }, { sessionId: 'x'.repeat(201), event: 'start', generationId: 'g' },
      { sessionId: S1, event: 'start', generationId: 'g', handout: 'ABCDEF12' }, { sessionId: S1, event: 'start', generationId: 'g', handout: '1234567' },
      { sessionId: S1, event: 'start', generationId: 'g', status: 'completed' }, { sessionId: S1, event: 'end', generationId: 'g', status: 'done' },
      { sessionId: S1, event: 'end', generationId: 'g', handout: '12345678' }, { sessionId: S1, event: 'end', generationId: 'g', usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { sessionId: S1, event: 'end', generationId: 'g', usage: { input: 1, output: 0, cacheRead: 0 } }, { sessionId: S1, event: 'end', generationId: 'g', usage: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]) assert.equal((await report(app, bad)).status, 400, JSON.stringify(bad));
    assert.equal(app.reports.length, 0, 'nothing invalid reached the adapter');

    const ok = await report(app, { sessionId: S1, event: 'end', generationId: 'g1', status: 'completed', prompt: 'secret text', user_email: 'a@b.c',
      usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 0, extra: 9 } });
    assert.deepEqual(ok, { status: 200, body: { park: true } });
    assert.deepEqual(app.reports, [{ sessionId: S1, event: 'end', generationId: 'g1', status: 'completed', usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 0 } }]);
    assert.deepEqual((await report(app, { sessionId: OUTSIDER, event: 'start', generationId: 'g2', handout: '0123abcd' })).body, { park: false }, 'not a member');
    assert.equal(app.reports.length, 2, 'a non-member report still reaches the adapter');
    assert.deepEqual(turnReport({ sessionId: 's', event: 'start', generationId: 'g', text: 'x' }), { sessionId: 's', event: 'start', generationId: 'g' });
  } finally {
    await app.close();
  }
});

test('cursor parks: a non-member ends at once; a newer park replaces the older; a stale since is refused; a turn start ends them all', async () => {
  const app = await cHub();
  try {
    const outsider = park(app, OUTSIDER);
    assert.equal(await outsider.status, 200);
    await outsider.ended;
    assert.deepEqual(outsider.events, [{ event: 'end', data: { reason: 'not-member' } }]);

    const t0 = Date.now();
    const older = await parked(app, S1, t0);
    assert.equal(await app.statusOf(), 'idle', 'online through the park');
    const newer = park(app, S1, t0 + 10);
    await older.ended;
    assert.deepEqual(older.events, [{ event: 'end', data: { reason: 'superseded' } }]);
    assert.equal(await newer.status, 200);
    const stale = park(app, S1, t0 + 5);
    await stale.ended;
    assert.deepEqual(stale.events, [{ event: 'end', data: { reason: 'superseded' } }], 'older than the registered park');
    assert.ok(app.hub.bridge.isOnline('cursor', S1), 'the newer park stays');

    await start(app, 'g-user');
    await newer.ended;
    assert.deepEqual(newer.events, [{ event: 'end', data: { reason: 'superseded' } }], 'a turn start ends the park');
    const beforeStart = park(app, S1, t0 - 1);
    await beforeStart.ended;
    assert.deepEqual(beforeStart.events, [{ event: 'end', data: { reason: 'superseded' } }], 'a hook that started before the turn started');
    assert.equal(await app.statusOf(), 'idle', 'still online while the user\'s turn runs');

    const harnessCheck = await fetch(`${app.url}/bridge/qoder-park?session=${S1}&since=1`, { headers: { 'x-orrery-bridge': app.secret } });
    assert.equal(harnessCheck.status, 404, 'no park route for a harness without turn hooks');
    assert.equal((await fetch(`${app.url}/bridge/mock-turn`, { method: 'POST', headers: { 'x-orrery-bridge': app.secret }, body: '{}' })).status, 404);
    for (const file of ['src/mcp/hook-park.ts', 'src/mcp/bridge.ts']) {
      assert.doesNotMatch(readFileSync(join(REPO_ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, ''), /['"`]cursor['"`]/, `${file} has no branch by name`);
    }
  } finally {
    await app.close();
  }
});

test('cursor delivery: newest park only, hand-over id on the first line, confirmed by the start report, completed with the turn tokens', async () => {
  const app = await cHub();
  try {
    const t0 = Date.now();
    const older = await parked(app, S1, t0);
    const newer = await parked(app, S1, t0 + 10);
    await older.ended;
    await app.say('@C1 hello cursor');
    await waitFor(() => newer.events.length, 'delivered');
    assert.equal(older.events.filter((e) => e.event === 'deliver').length, 0, 'never to the older park');
    await newer.ended;
    assert.equal(app.hub.bridge.isOnline('cursor', S1), false, 'a park carries one delivery');
    const { deliveryId, text, handout } = await takeAndStart(app, newer, 'g1');
    assert.equal(handout, handoutOf(deliveryId));
    assert.equal(text.split('\n')[0], marker(['user'], handout));
    assert.match(text, /hello cursor/);
    assert.equal(await app.statusOf(), 'busy');
    const next = await parked(app, S1);   // the hook of the turn's end parks right after reporting it
    await end(app, 'g1', { usage: { input: 18491, output: 300, cacheRead: 18304, cacheWrite: 0 } });
    await waitFor(async () => (await app.deliveries()).every((d) => d.state === 'done'), 'done');
    assert.deepEqual((await app.deliveries()).map((d) => d.outcome), ['completed']);
    assert.deepEqual(app.store.turnUsage([app.c1.id]).get(app.c1.id), { totals: { input: 187, cachedInput: 18304, cacheWrite: 0, output: 300, reasoning: 0 }, turns: 1 });
    assert.equal(await app.statusOf(), 'idle');
    next.close();
  } finally {
    await app.close();
  }
});

test('cursor delivery: queued behind the user\'s own turn, then batched into one envelope on the next park', async () => {
  const app = await cHub();
  try {
    await start(app, 'g-user');
    assert.equal(await app.statusOf(), 'idle', 'a running turn counts as online');
    await app.say('@C1 first');
    await sleep(100);
    await app.say('@C1 second');
    await sleep(100);
    assert.deepEqual((await app.deliveries()).map((d) => d.state).sort(), ['queued', 'running'].sort(), 'one batch waits behind the turn, the next message queues');
    await end(app, 'g-user');
    const p = park(app);   // taken at once: the batch was waiting for it
    const { text } = await takeAndStart(app, p, 'g2');
    assert.match(text, /first/);
    // The second message arrived while the first batch waited: it waits for the next park.
    const p2 = park(app);
    await sleep(100);
    assert.equal(p2.events.length, 0, 'not before the turn ends');
    await end(app, 'g2');
    await waitFor(() => p2.events.length, 'the next batch');
    assert.match(p2.events[0].data.text, /second/);
    p2.close();
  } finally {
    await app.close();
  }
});

test('cursor delivery: messages that arrive during a delivered turn go together on the next park', async () => {
  const app = await cHub();
  try {
    const p = await parked(app);
    await app.say('@C1 one');
    await takeAndStart(app, p, 'g1');
    await app.say('@C1 two');
    await app.say('@C1 three');
    const next = await parked(app);
    await end(app, 'g1');
    await waitFor(() => next.events.length, 'the batch');
    assert.match(next.events[0].data.text, /two[\s\S]*three/, 'one envelope');
    next.close();
  } finally {
    await app.close();
  }
});

test('cursor delivery: no confirmation is unknown and never handed out again; a missing ack is unknown', async () => {
  const app = await cHub({ times: { confirmMs: 300 } });
  try {
    const p = await parked(app);
    await app.say('@C1 dropped by Cursor');
    await waitFor(() => p.events.length, 'handed out');
    await ack(app, p.events[0].data.deliveryId);   // the hook printed it, Cursor never submitted it
    await waitFor(async () => (await app.deliveries()).every((d) => d.state !== 'running' && d.state !== 'queued'), 'settled');
    const [d] = await app.deliveries();
    assert.equal(d.outcome, 'unknown');
    assert.equal(d.error, NOT_CONFIRMED);
    const again = await parked(app);
    await sleep(300);
    assert.deepEqual(again.events, [], 'not handed out again');
    again.close();

    await waitFor(async () => !app.hub.bridge.isOnline('cursor', S1), 'park gone');
    const p2 = await parked(app);
    await app.say('@C2 nothing');   // another member: irrelevant
    await app.say('@C1 never acked');
    await waitFor(() => p2.events.length, 'handed out');
    await waitFor(async () => (await app.deliveries()).length === 2 && (await app.deliveries()).every((x) => x.state !== 'running' && x.state !== 'queued'), 'settled', 4000);
    assert.equal((await app.deliveries())[1].outcome, 'unknown');
  } finally {
    await app.close();
  }
});

test('cursor delivery: an aborted or failing turn fails; a turn without an end is unknown', async () => {
  const app = await cHub({ times: { turnMs: 400 } });
  try {
    for (const [status, error] of [['aborted', /被停止/], ['error', /出错/]] as const) {
      const p = await parked(app);
      await app.say(`@C1 ${status}`);
      await takeAndStart(app, p, `g-${status}`);
      await end(app, `g-${status}`, { status });
      await waitFor(async () => (await app.deliveries()).at(-1)!.state === 'failed', status);
      assert.match((await app.deliveries()).at(-1)!.error!, error);
      await waitFor(async () => !app.hub.bridge.isOnline('cursor', S1) && (await app.statusOf()) !== 'busy', 'free');
    }
    const p = await parked(app);
    await app.say('@C1 no end');
    await takeAndStart(app, p, 'g-lost');
    await waitFor(async () => !['running', 'queued'].includes((await app.deliveries()).at(-1)!.state), 'settled', 4000);
    assert.equal((await app.deliveries()).at(-1)!.outcome, 'unknown');
  } finally {
    await app.close();
  }
});

test('cursor delivery: offline when Cursor is not running, or when no park follows the user\'s turn; nothing is handed out', async () => {
  let running: boolean | null = false;
  const app = await cHub({ running: async () => running });
  try {
    const p = await parked(app);
    await app.say('@C1 cursor closed');
    await waitFor(async () => (await app.deliveries())[0]?.state === 'offline', 'offline');
    assert.deepEqual(p.events, [], 'nothing handed out');
    p.close();
    running = null;   // unknown counts as running
    await start(app, 'g-user');
    await app.say('@C1 after the turn');
    await sleep(100);
    await end(app, 'g-user');   // and no stop hook parks (the hook is disabled)
    await waitFor(async () => (await app.deliveries())[1]?.state === 'offline', 'offline after the turn', 3000);
  } finally {
    await app.close();
  }
});

test('cursor: a removed member\'s park ends not-member; the pause switch and the hourly turn limit hold deliveries', async () => {
  const app = await cHub({ limits: { maxTurnsPerHour: 1 } });
  try {
    await app.api('POST', '/api/pause', { paused: true });
    const p = await parked(app);
    await app.say('@C1 while paused');
    await sleep(200);
    assert.deepEqual(p.events, [], 'paused: nothing handed out');
    assert.deepEqual((await app.deliveries()).map((d) => d.state), ['queued']);
    await app.api('POST', '/api/pause', { paused: false });
    await takeAndStart(app, p, 'g1');
    const next = await parked(app);
    await end(app, 'g1');
    await waitFor(async () => (await app.deliveries())[0].state === 'done', 'done');
    await app.say('@C1 over the hourly limit');
    await sleep(300);
    assert.deepEqual(next.events, [], 'the per-worker hourly limit holds it');
    assert.equal((await app.deliveries())[1].state, 'queued');

    const p2 = park(app, S2);
    await waitFor(() => app.hub.bridge.isOnline('cursor', S2), 'C2 parked');
    await app.api('DELETE', `/api/clusters/${app.cluster.id}/members/${app.c2.id}`);
    await p2.ended;
    assert.deepEqual(p2.events, [{ event: 'end', data: { reason: 'not-member' } }]);
    next.close();
  } finally {
    await app.close();
  }
});

test('cursor: queued deliveries stay queued while the user types and while the stop hook re-parks', async () => {
  const app = await cHub({ times: { reparkMs: 400 } });
  try {
    const p = await parked(app);
    await app.api('POST', '/api/pause', { paused: true });
    await app.say('@C1 queued while paused');
    await start(app, 'g-user');   // the user types: the park ends, the turn keeps the member online
    await p.ended;
    await app.say('@C1 a second one');   // schedules the member while it has no park
    await sleep(100);
    assert.deepEqual((await app.deliveries()).map((d) => d.state), ['queued', 'queued']);
    await end(app, 'g-user');
    await app.say('@C1 a third one');    // in the gap between the end report and the next park
    await sleep(100);
    assert.deepEqual((await app.deliveries()).map((d) => d.state), ['queued', 'queued', 'queued']);
    const next = park(app);
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => next.events.length, 'one batch on the next park');
    assert.match(next.events[0].data.text, /queued while paused[\s\S]*second one[\s\S]*third one/);
    next.close();
  } finally {
    await app.close();
  }
});

for (const status of ['completed', 'aborted', 'error'] as const) {
  test(`cursor: a late ${status} end of an older turn leaves the running turn alone; a held message is not marked offline`, async () => {
    const app = await cHub({ times: { reparkMs: 200 } });
    try {
      const p = await parked(app);
      await app.api('POST', '/api/pause', { paused: true });
      await app.say('@C1 held by the pause');
      await start(app, 'g-old');
      await p.ended;
      await start(app, 'g-current');   // the old turn's end has not come yet
      await end(app, 'g-old', { status });   // it comes late, while g-current runs
      await sleep(400);   // past the re-park window
      assert.equal(await app.statusOf(), 'idle', 'still online: g-current runs');
      await app.api('POST', '/api/pause', { paused: false });
      await sleep(200);
      assert.notEqual((await app.deliveries())[0].state, 'offline', 'waits behind g-current instead');
      await end(app, 'g-current');
      const next = park(app);
      await waitFor(() => next.events.length, 'delivered on the next park');
      assert.match(next.events[0].data.text, /held by the pause/);
      next.close();
    } finally {
      await app.close();
    }
  });
}

test('cursor: the Hub closing drops a park without an end event', async () => {
  const app = await cHub();
  const p = await parked(app);
  await app.close();
  await p.ended;
  assert.deepEqual(p.events, []);
});

test('cursor tokens, hand-over ids and the marker', () => {
  assert.deepEqual(cursorTokens({ input: 100, output: 7, cacheRead: 80, cacheWrite: 30 }), { input: 0, cachedInput: 80, cacheWrite: 30, output: 7, reasoning: 0 });
  assert.equal(handoutOf('1A2B3C4D-0000-4000-8000-000000000000'), '1a2b3c4d');
  assert.equal(marker(['A', 'B'], '1a2b3c4d'), '[orrery · 来自 A、B · #1a2b3c4d]');
  assert.equal(marker(['A']), '[orrery · 来自 A]', 'Kimi\'s marker is unchanged');
  assert.equal(marker(undefined), '[orrery]');
  assert.ok(nativeFactories.cursor, 'registered');
  const src = readFileSync(join(REPO_ROOT, 'src', 'adapters', 'cursor', 'native.ts'), 'utf8') + readFileSync(join(REPO_ROOT, 'src', 'adapters', 'cursor', 'store.ts'), 'utf8');
  assert.doesNotMatch(src, /cursor:\/\//, 'never opens a cursor:// link');
  assert.doesNotMatch(src, /\b(spawn|exec|execFile)\(/, 'never starts a program (tasklist is in the shared helper)');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /state\.vscdb/, 'never names a state.vscdb outside comments');
});

test('cursor conversations: projects from workspace.json, conversations from transcripts, titles from the first user message', async () => {
  const home = tempDir();
  const data = tempDir();
  const alpha = join(home, 'work', 'Alpha Project');
  const ws = (name: string, json: unknown) => {
    mkdirSync(join(data, 'User', 'workspaceStorage', name), { recursive: true });
    writeFileSync(join(data, 'User', 'workspaceStorage', name, 'workspace.json'), typeof json === 'string' ? json : JSON.stringify(json));
  };
  ws('w1', { folder: pathToFileURL(alpha).href });
  ws('w2', { workspace: 'file:///c%3A/x.code-workspace' });
  ws('w3', { folder: 'vscode-remote://ssh-remote+host/home/x' });
  ws('w4', '{ not json');
  // A state.vscdb that must never be opened: a folder by that name makes any read of it fail loudly.
  mkdirSync(join(data, 'User', 'globalStorage', 'state.vscdb'), { recursive: true });
  mkdirSync(join(data, 'User', 'workspaceStorage', 'w1', 'state.vscdb'), { recursive: true });
  const transcripts = join(home, 'projects', projectKey(alpha).replace(/^./, (c) => c.toUpperCase()), 'agent-transcripts');
  const conv = (id: string, lines: string[], mtime: number) => {
    mkdirSync(join(transcripts, id), { recursive: true });
    writeFileSync(join(transcripts, id, `${id}.jsonl`), lines.join('\n'));
    utimesSync(join(transcripts, id, `${id}.jsonl`), mtime, mtime);
  };
  conv(S1, ['{bad line', JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nFix the   parser please</user_query>' }] } }), JSON.stringify({ role: 'assistant', message: { content: 'ok' } })], 1_700_000_100);
  conv(S2, [JSON.stringify({ role: 'user', message: { content: '[orrery · 来自 A · #12345678]\nhello' } }), JSON.stringify({ role: 'user', content: 'x'.repeat(100) })], 1_700_000_200);
  conv(OUTSIDER, [JSON.stringify({ role: 'assistant', text: 'only an answer' })], 1_700_000_000);
  mkdirSync(join(transcripts, 'no-file-yet'), { recursive: true });
  mkdirSync(join(transcripts, 'bad id!'), { recursive: true });

  const store = createCursorStore(home, data);
  assert.deepEqual((await store.listProjects()).map((p) => [p.path, p.label]), [[alpha, 'Alpha Project']]);
  const sessions = await store.listSessions(alpha);
  assert.deepEqual(sessions.map((s) => [s.id, s.title]), [[S2, 'x'.repeat(60)], [S1, 'Fix the parser please'], [OUTSIDER, '（无标题）']]);
  assert.equal(sessions[0].cwd, alpha);
  assert.deepEqual(await store.listSessions(join(home, 'elsewhere')), []);
  assert.equal((await store.get(S1))?.cwd, alpha);
  assert.equal(await store.get('no-file-yet'), null, 'no transcript yet: not listed');
  assert.equal(await store.get('../escape'), null);
  assert.equal(userText(JSON.stringify({ type: 'user', text: ' hi ' })), 'hi');

  const adapter = createCursorNativeAdapter({ cursorHome: home, cursorData: data, cursorRunning: async () => true });
  assert.equal((await adapter.attachSession(S1)).title, 'Fix the parser please');
  await assert.rejects(adapter.attachSession('dddddddd-0000-4000-8000-000000000000'), /not found/);
  assert.equal(adapter.createSession, undefined, 'new conversations are made in Cursor');
});

test('cursor conversations: finding an early title closes the transcript stream', async (t) => {
  const home = fakeCursorHome([S1]);
  const project = 'C:\\work\\alpha';
  const file = join(home, 'projects', projectKey(project), 'agent-transcripts', S1, `${S1}.jsonl`);
  const first = JSON.stringify({ role: 'user', content: 'the title' });
  const tail = JSON.stringify({ role: 'assistant', content: 'x'.repeat(4096) });
  writeFileSync(file, `${first}\n${`${tail}\n`.repeat(256)}`);
  const open = t.mock.method(fs, 'createReadStream');
  syncBuiltinESMExports();
  try {
    const [session] = await createCursorStore(home, home).listSessions(project);
    assert.equal(session?.title, 'the title');
    assert.equal(open.mock.calls.length, 1);
    assert.equal(open.mock.calls[0].result?.destroyed, true);
  } finally {
    open.mock.restore();
    syncBuiltinESMExports();
    for (const { result: input } of open.mock.calls) {
      if (input && !input.closed) await new Promise<void>((resolve) => input.once('close', resolve).destroy());
    }
  }
});

test('cursor titles: the real transcript line shape takes the user query, not the timestamp', async () => {
  const home = tempDir();
  const data = tempDir();
  const alpha = join(home, 'work', 'Beta');
  mkdirSync(join(data, 'User', 'workspaceStorage', 'w1'), { recursive: true });
  writeFileSync(join(data, 'User', 'workspaceStorage', 'w1', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(alpha).href }));
  const transcripts = join(home, 'projects', projectKey(alpha), 'agent-transcripts');
  const user = (text: string) => JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
  const answer = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '你好。需要我帮你做什么？' }] } });
  const ended = JSON.stringify({ type: 'turn_ended', status: 'success' });
  const conv = (id: string, lines: string[], mtime: number) => {
    mkdirSync(join(transcripts, id), { recursive: true });
    writeFileSync(join(transcripts, id, `${id}.jsonl`), lines.join('\n'));
    utimesSync(join(transcripts, id, `${id}.jsonl`), mtime, mtime);
  };
  const stamp = '<timestamp>Sunday, Nov 15, 2026, 4:42 PM (UTC+1)</timestamp>\n';
  conv(S1, [user(`${stamp}<user_query>\n你好\n</user_query>`), answer, ended], 1_700_000_300);
  conv(S2, [user(`${stamp}<user_query>\n[orrery · 来自 A · #1a2b3c4d]\nhello\n</user_query>`), answer, ended, user(`${stamp}<user_query>\n修一下  解析器\n</user_query>`), answer, ended], 1_700_000_200);
  conv(OUTSIDER, [user(`${stamp}just text after a timestamp`)], 1_700_000_100);

  const sessions = await createCursorStore(home, data).listSessions(alpha);
  assert.deepEqual(sessions.map((s) => [s.id, s.title]), [[S1, '你好'], [S2, '修一下 解析器'], [OUTSIDER, 'just text after a timestamp']]);
});
