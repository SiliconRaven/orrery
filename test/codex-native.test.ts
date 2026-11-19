// Native Codex adapter (docs/native-mode.md, "原生 Codex") against an in-process fake app-server: what it queues, when it
// wakes, how it recognises its turn, timeout and abort clean-up, the process limit, listing and createSession.
// ORRERY_CODEX_LIVE=1 also runs the live check at the end (free: a throwaway CODEX_HOME and a local fake model).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { nativeFactories } from '../src/adapters/index.ts';
import { codexAppIn, codexBinary, createCodexNativeAdapter, initPrompt, wakeUrl, writerLockHeld, type CodexNativeOptions } from '../src/adapters/codex/native.ts';
import { decideServerRequest, type CodexProcess } from '../src/adapters/codex/protocol.ts';
import { RpcPeer } from '../src/adapters/codex/rpc.ts';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { startHub } from '../src/main.ts';
import type { AgentEvent, BridgePort } from '../src/core/types.ts';
import { startTestHub, tempDir, TEST_TOKEN, waitFor } from './helpers.ts';

type Msg = { id?: number; method?: string; params?: any };
type Turn = { id: string; status: string; items: any[]; error: { message: string } | null };

const T1 = '01a18969-e0ab-7530-819d-a00ae897addb';
const T2 = '01a18969-e0ab-7530-819d-a00ae897adde';
const CWD = 'C:\\work\\demo';
const NO_BRIDGE: BridgePort = { isOnline: () => false, push: async () => ({ ok: false, error: 'no bridge' }), waitDone: async () => 'dropped' };
const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));

/** The shared Codex state every short-lived fake app-server sees (like ~/.codex), plus a log of what was asked. */
class FakeCodex {
  readonly sent: (Msg & { proc: number })[] = [];
  readonly queue = new Map<string, { id: string; input: any[]; clientUserMessageId: string }[]>();
  readonly turns = new Map<string, Turn[]>();   // newest first, like thread/turns/list
  threads: any[] = [];
  launches = 0;
  kills = 0;
  alive = 0;
  maxAlive = 0;
  /** Delay before each answer, to make processes overlap. */
  delayMs = 0;
  /** Never answer anything (a hung app-server). */
  mute = false;
  /** For turn/start: the turn completes before the answer arrives. */
  completeBeforeAck = false;
  /** For turn/start: the process exits right after its answer has been read, in the same tick. */
  exitAfterAck = false;
  /** Our answers to server→client requests. */
  readonly replies: Msg[] = [];
  /** What the fake does after answering turn/start (the init turn); default: the turn completes. */
  onTurnStart: (fake: FakeCodex, params: any, turnId: string) => void = (f, p, id) => f.emit('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', error: null } });
  private out: PassThrough | null = null;
  private nextQ = 1;
  private nextServerId = 9000;

  /** Writes a notification (or, with an id, a server request) to the newest process. */
  emit(method: string, params: unknown, id?: number): void {
    this.out?.write(JSON.stringify(id === undefined ? { method, params } : { id, method, params }) + '\n');
  }
  /** The newest process exits on its own (a crash). */
  crashNewest(): void {
    this.exitNewest?.('app-server exited (1)');
  }
  private exitNewest: ((r: string) => void) | null = null;
  request(method: string, params: unknown): number {
    const id = this.nextServerId++;
    this.emit(method, params, id);
    return id;
  }

  launch = (): CodexProcess => {
    const proc = ++this.launches;
    this.alive++;
    this.maxAlive = Math.max(this.maxAlive, this.alive);
    const out = new PassThrough();
    this.out = out;
    let exitCb: ((r: string) => void) | null = null;
    let gone = false;
    const exit = (r: string) => { if (gone) return; gone = true; this.alive--; out.end(); exitCb?.(r); };
    this.exitNewest = exit;
    let buf = '';
    const stdin = new Writable({
      write: (chunk, _e, cb) => {
        buf += String(chunk);
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const m: Msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (m.method === undefined) { this.replies.push(m); continue; }
          this.sent.push({ ...m, proc });
          if (m.id === undefined) continue;
          const reply = () => {
            // The work happens even when nobody is left to read the answer (like a request already sent).
            let line: string;
            try { line = JSON.stringify({ id: m.id, result: this.handle(m) }); } catch (e) { line = JSON.stringify({ id: m.id, error: { code: -1, message: (e as Error).message } }); }
            if (m.method === 'turn/start' && this.exitAfterAck) { out.emit('data', line + '\n'); exit('app-server exited (1)'); return; }
            if (!gone && !this.mute) out.write(line + '\n');
          };
          if (this.delayMs) setTimeout(reply, this.delayMs); else setImmediate(reply);
        }
        cb();
      },
      final: (cb) => { setImmediate(() => exit('app-server exited (0)')); cb(); },   // stdin closed → app-server exits
    });
    return { stdin, stdout: out, kill: () => { this.kills++; exit('killed'); }, onExit: (cb) => { exitCb = cb; } };
  };

  handle(m: Msg): unknown {
    const p = m.params ?? {};
    switch (m.method) {
      case 'initialize': return { userAgent: 'fake', codexHome: 'C:\\fake' };
      case 'thread/list': {
        const page = p.cursor ? Number(p.cursor) : 0;
        const list = this.threads.filter((t) => !p.cwd || t.cwd === p.cwd);
        const data = list.slice(page * p.limit, (page + 1) * p.limit);
        return { data, nextCursor: (page + 1) * p.limit < list.length ? String(page + 1) : null, backwardsCursor: null };
      }
      case 'thread/read': {
        const t = this.threads.find((x) => x.id === p.threadId);
        if (!t) throw new Error(`thread ${p.threadId} not found`);
        return { thread: t };
      }
      case 'thread/start': return { thread: { id: T2, preview: '', model: null, cwd: p.cwd, name: null, updatedAt: 0 }, model: p.model ?? 'gpt-default' };
      case 'thread/name/set': return {};
      case 'turn/start': {
        const id = 'turn-init';
        if (this.completeBeforeAck) this.emit('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', error: null } });
        else setImmediate(() => this.onTurnStart(this, p, id));
        return { turn: { id, status: 'inProgress', error: null } };
      }
      case 'thread/queue/add': {
        const q = { id: `q${this.nextQ++}`, input: p.input, clientUserMessageId: p.clientUserMessageId };
        this.queue.set(p.threadId, [...(this.queue.get(p.threadId) ?? []), q]);
        return { queuedSubmission: q };
      }
      case 'thread/queue/list': return { data: this.queue.get(p.threadId) ?? [], nextCursor: null };
      case 'thread/queue/delete': {
        const list = this.queue.get(p.threadId) ?? [];
        const kept = list.filter((q) => q.id !== p.queuedSubmissionId);
        this.queue.set(p.threadId, kept);
        return { deleted: kept.length !== list.length };
      }
      case 'thread/turns/list': return { data: (this.turns.get(p.threadId) ?? []).slice(0, p.limit), nextCursor: null, backwardsCursor: null };
      default: throw new Error(`fake does not know ${m.method}`);
    }
  }

  /** The desktop app's backend takes the oldest queued message and runs it; returns the new turn. */
  pickUp(threadId: string, status = 'interrupted', reply = 'ok'): Turn {
    const [q, ...rest] = this.queue.get(threadId) ?? [];
    assert.ok(q, 'something is queued');
    this.queue.set(threadId, rest);
    const turn: Turn = { id: `turn-${q.id}`, status, error: null, items: [{ type: 'userMessage', id: 'u', clientId: q.clientUserMessageId, content: q.input }, ...(status === 'completed' ? [{ type: 'agentMessage', id: 'a', text: reply }] : [])] };
    this.addTurn(threadId, turn);
    return turn;
  }
  addTurn(threadId: string, turn: Turn): void {
    this.turns.set(threadId, [turn, ...(this.turns.get(threadId) ?? [])]);
  }
  finish(turn: Turn, reply: string): void {
    turn.status = 'completed';
    turn.items.push({ type: 'agentMessage', id: 'a', text: reply });
  }
  methods(): string[] {
    return this.sent.filter((m) => m.method !== 'initialize' && m.method !== 'initialized').map((m) => m.method!);
  }
  params(method: string): any[] {
    return this.sent.filter((m) => m.method === method).map((m) => m.params);
  }
}

// A failed assertion skips a test's close(); closing everything at the end ends any delivery still polling.
const opened: { close?(): Promise<void> }[] = [];
after(async () => { for (const a of opened) await a.close?.(); });

function setup(opts: Partial<CodexNativeOptions> & { held?: boolean } = {}) {
  const fake = new FakeCodex();
  const woken: string[] = [];
  const adapter = createCodexNativeAdapter({
    launch: fake.launch, pollMs: 5, lockHeld: () => (opts.held ?? true) ? { state: 'held' } : { state: 'unknown', reason: 'test lock is not held' }, openWake: (u) => woken.push(u), appRunning: async () => true, ...opts,
  });
  opened.push(adapter);
  const deliver = (deliveryId: string, text = 'hello', signal = new AbortController().signal, threadId = T1) => {
    const events: AgentEvent[] = [];
    const p = adapter.deliver(threadId, text, { deliveryId, bridge: NO_BRIDGE, onEvent: (e) => events.push(e), signal });
    return { p, events };
  };
  return { fake, woken, adapter, deliver };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !cond(); i++) await tick(2);
  assert.ok(cond(), what);
};

test('codex native: listModels asks the backend (model/list) in its own short-lived app-server', async () => {
  const { fake, adapter } = setup();
  const base = fake.handle.bind(fake);
  fake.handle = (m) => (m.method === 'model/list'
    ? { data: [{ id: 'e', model: 'gpt-a', displayName: 'GPT-A', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] }], nextCursor: null }
    : base(m));
  assert.deepEqual(await adapter.listModels!(), [{ id: 'gpt-a', label: 'GPT-A', efforts: ['low'], isDefault: true }]);
  assert.deepEqual(fake.methods(), ['model/list']);
  await until(() => fake.alive === 0, 'the app-server exited');
});

test('codex native: deliver queues the text with clientUserMessageId = deliveryId, experimental API on, never resumes or starts a turn', async () => {
  const { fake, adapter, deliver } = setup();
  const { p, events } = deliver('d-1', '[orrery] from=user\nhi');
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  assert.deepEqual(fake.params('thread/queue/add'), [{ threadId: T1, input: [{ type: 'text', text: '[orrery] from=user\nhi', text_elements: [] }], clientUserMessageId: 'd-1' }]);
  assert.ok(fake.params('initialize').every((x) => x.capabilities.experimentalApi === true));
  fake.pickUp(T1, 'completed', 'done');
  assert.equal(await p, 'completed');
  assert.deepEqual(events, [{ type: 'text', text: 'done' }]);
  const forbidden = fake.methods().filter((m) => ['thread/resume', 'turn/start', 'turn/steer', 'thread/start'].includes(m));
  assert.deepEqual(forbidden, []);
  assert.equal(fake.alive, 0, 'every app-server exited');
  assert.equal(fake.kills, 0, 'on its own, after stdin closed: nothing was killed');
  await adapter.close!();
});

test('codex native: the wake link is opened after queueing, whether or not a process holds the thread', async () => {
  for (const held of [true, false]) {
    const { fake, woken, adapter, deliver } = setup({ held });
    const { p } = deliver(`d-${held}`);
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    fake.pickUp(T1, 'completed');
    await p;
    assert.deepEqual(woken, [`codex://threads/wake/${T1}`], `held=${held}`);
    await adapter.close!();
  }
});


test('codex native: only the turn whose user message carries this deliveryId counts', async () => {
  const { fake, adapter, deliver } = setup();
  const { p, events } = deliver('d-mine');
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  // The user typed something in the app and it ran first: a completed turn with another clientId.
  fake.addTurn(T1, { id: 'turn-user', status: 'completed', error: null, items: [{ type: 'userMessage', clientId: 'typed-in-app' }, { type: 'agentMessage', text: 'not yours' }] });
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  await tick(60);   // many polls
  assert.equal(settled, false, 'still waiting for its own turn');
  fake.pickUp(T1, 'completed', 'yours');
  assert.equal(await p, 'completed');
  assert.deepEqual(events, [{ type: 'text', text: 'yours' }]);
  await adapter.close!();
});

test('codex native: a turn that reads "interrupted" counts as running while the app holds the thread and nothing newer exists', async () => {
  const { fake, adapter, deliver } = setup({ held: true });
  const { p, events } = deliver('d-run');
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  const turn = fake.pickUp(T1, 'interrupted');
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  await tick(60);
  assert.equal(settled, false);
  fake.finish(turn, 'finished');
  assert.equal(await p, 'completed');
  assert.deepEqual(events, [{ type: 'text', text: 'finished' }]);
  await adapter.close!();
});

test('codex native: an interrupted turn followed by a newer one, or a failed turn, rejects', async () => {
  {
    const { fake, adapter, deliver } = setup({ lockHeld: () => ({ state: 'unknown', reason: 'ENOENT' }) });
    const { p } = deliver('d-int');
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    fake.pickUp(T1, 'interrupted');
    fake.addTurn(T1, { id: 'later', status: 'interrupted', error: null, items: [{ type: 'userMessage', clientId: 'typed' }] });
    assert.deepEqual(await p, { outcome: 'failed', error: 'codex turn interrupted' });
    await adapter.close!();
  }
  {
    const { fake, adapter, deliver } = setup({ held: true });
    const { p } = deliver('d-fail');
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    fake.pickUp(T1, 'failed').error = { message: 'usage limit' };
    assert.deepEqual(await p, { outcome: 'failed', error: 'codex turn failed: usage limit' });
    await adapter.close!();
  }
});

test('codex native: an interrupted turn with an uncertain lock ends unknown and handoff requires confirmation', async () => {
  const { fake, adapter } = setup({ lockHeld: () => ({ state: 'unknown', reason: 'writer lock check failed (EACCES)' }) });
  fake.threads = [{ id: T1, preview: 'hi', model: 'm', cwd: CWD, name: 'my chat', updatedAt: 0 }];
  const app = await startTestHub({ nativeAdapters: { codex: adapter } });
  try {
    const { cluster, members: [codex, next] } = await app.api('POST', '/api/clusters', { name: 'lock', members: [
      { harness: 'codex', mode: 'native', sessionId: T1, name: 'Codex' }, { harness: 'mock', mode: 'native', name: 'Next', projectPath: '/work' },
    ] });
    const msg = app.hub.sendFromUser(cluster.id, '@Codex work');
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    fake.pickUp(T1, 'interrupted');
    const delivery = await waitFor(() => {
      const d = app.store.withDeliveries([msg])[0].deliveries[0];
      return d.state === 'failed' ? d : null;
    }, 'unknown result');
    assert.equal(delivery.outcome, 'unknown');
    assert.match(delivery.error!, /EACCES.*may still be running/);
    assert.equal(delivery.memberId, codex.id);
    await assert.rejects(app.api('POST', `/api/clusters/${cluster.id}/deliveries/${delivery.id}/handoff`, { targetMemberId: next.id }), /confirmStopped/);
  } finally { await app.close(); }
});

test('codex native: a missing Windows lock file cannot turn interrupted into a confirmed failure', async () => {
  const home = tempDir();
  const { fake, adapter, deliver } = setup({ lockHeld: (threadId) => writerLockHeld(home, threadId, { platform: 'win32' }) });
  try {
    const { p } = deliver('d-missing-lock');
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    fake.pickUp(T1, 'interrupted');
    const result = await p;
    assert.equal(typeof result === 'object' && result.outcome, 'unknown');
    assert.match(typeof result === 'object' ? result.error : '', /ENOENT.*may still be running/);
  } finally { await adapter.close!(); }
});

test('codex native: nobody picks it up in time → taken out of the queue, then reject', async () => {
  const { fake, adapter, deliver } = setup({ pickupTimeoutMs: 30 });
  const { p } = deliver('d-late');
  const late = await p;
  assert.equal(typeof late === 'object' && late.outcome, 'unknown');
  assert.match(typeof late === 'object' ? late.error : '', /nobody picked the message up/);
  assert.deepEqual(fake.queue.get(T1), [], 'no longer queued');
  assert.deepEqual(fake.params('thread/queue/delete'), [{ threadId: T1, queuedSubmissionId: 'q1' }]);
  assert.equal(fake.alive, 0);
  await adapter.close!();
});

// The app runs queued messages only between turns: a turn that runs for hours must not fail what waits behind it.
// These tests wait on the fake's own signals (the message being queued, polls of the turns), never on bare sleeps,
// and a failed assertion still ends the delivery it started.
const busyTurn = (status: string): Turn => ({ id: 'turn-busy', status, error: null, items: [{ type: 'userMessage', id: 'u0', clientId: 'someone-else', content: [] }] });
/** Waits for `n` more polls of the thread's turns and at least `ms` of wall time. */
async function polls(fake: FakeCodex, n: number, ms = 0): Promise<void> {
  const started = Date.now();
  const target = fake.params('thread/turns/list').length + n;
  for (let i = 0; i < 10_000 && (fake.params('thread/turns/list').length < target || Date.now() - started < ms); i++) await tick(2);
  assert.ok(fake.params('thread/turns/list').length >= target, `${n} more polls`);
}
/** Starts a delivery that can be ended from a finally block; `settled` tells whether it has resolved. */
function watched(deliver: ReturnType<typeof setup>['deliver'], id: string) {
  const ac = new AbortController();
  const { p } = deliver(id, 'hello', ac.signal);
  const state = { settled: false };
  const done = p.then((r) => { state.settled = true; return r; });
  return { done, state, end: async () => { if (!state.settled) { ac.abort(); await done.catch(() => {}); } } };
}

test('codex native: polls the first observations at full speed, then halves the process launches for a running turn', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const { fake, adapter, deliver } = setup({ pollMs: 3_000 });
  const settleProcess = async () => {
    await nextTick();
    for (let i = 0; i < 20 && fake.alive; i++) await nextTick();
    assert.equal(fake.alive, 0, 'the fake app-server has exited');
  };
  await nextTick();
  assert.equal(fake.launches, 0, 'idle with no delivery');
  const d = watched(deliver, 'd-long');
  try {
    await settleProcess();
    const running = fake.pickUp(T1, 'inProgress');
    for (let seconds = 3; seconds <= 60; seconds += 3) {
      t.mock.timers.tick(3_000);
      await settleProcess();
      if (seconds === 9) assert.equal(fake.launches, 4, 'one submission and three fast observations');
    }
    assert.equal(fake.launches, 12, 'one submission and eleven observations in the first minute, versus twenty observations at a fixed 3 s');
    fake.finish(running, 'finished');
    t.mock.timers.tick(3_000);
    assert.equal(await d.done, 'completed');
  } finally { await d.end(); await adapter.close!(); }
});

for (const delayMs of [0, 120]) {
  test(`codex native: queued behind a long running turn → the pickup budget is not spent; runs once that turn ends (rpc delay ${delayMs} ms)`, async () => {
    const { fake, adapter, deliver } = setup({ pickupTimeoutMs: 30 });
    fake.delayMs = delayMs;
    const running = busyTurn('interrupted');   // how a running turn reads from another process; the writer lock is held
    fake.addTurn(T1, running);
    const d = watched(deliver, `d-behind-${delayMs}`);
    try {
      await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
      await polls(fake, 5, 150);   // several busy polls, well past pickupTimeoutMs
      assert.equal(d.state.settled, false, 'still waiting behind the running turn');
      assert.deepEqual(fake.params('thread/queue/delete'), [], 'not taken out of the queue');
      fake.finish(running, 'done with the long job');
      fake.pickUp(T1, 'completed', 'and then this');
      assert.equal(await d.done, 'completed');
    } finally { await d.end(); await adapter.close!(); }
  });
}

test('codex native: tells the Hub the delivery is still queued and whether the thread is busy, then that it was picked up', async () => {
  const { fake, adapter } = setup({ pickupTimeoutMs: 60_000, held: false });
  const running = busyTurn('inProgress');
  fake.addTurn(T1, running);
  const states: ({ busy: boolean } | null)[] = [];
  const ac = new AbortController();
  const p = adapter.deliver(T1, 'hello', { deliveryId: 'd-waiting', bridge: NO_BRIDGE, onEvent: () => {}, signal: ac.signal, waiting: (s) => { states.push(s); } });
  try {
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    await polls(fake, 2);
    assert.deepEqual(states.at(-1), { busy: true });
    running.status = 'completed';
    await polls(fake, 2);
    assert.deepEqual(states.at(-1), { busy: false });
    fake.pickUp(T1, 'completed', 'ok');
    assert.equal(await p, 'completed');
    assert.equal(states.at(-1), null);
  } finally { ac.abort(); await p.catch(() => {}); await adapter.close!(); }
});

test('codex native: an inProgress newest turn also keeps the budget, whatever the lock says', async () => {
  const { fake, adapter, deliver } = setup({ pickupTimeoutMs: 30, held: false });
  const running = busyTurn('inProgress');
  fake.addTurn(T1, running);
  const d = watched(deliver, 'd-inprogress');
  try {
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    await polls(fake, 5, 150);
    assert.equal(d.state.settled, false);
    running.status = 'completed';
    fake.pickUp(T1, 'completed', 'ok');
    assert.equal(await d.done, 'completed');
  } finally { await d.end(); await adapter.close!(); }
});

test('codex native: idle time before and after a running turn adds up to the pickup timeout', async () => {
  const { fake, adapter, deliver } = setup({ pickupTimeoutMs: 100 });
  const d = watched(deliver, 'd-budget');
  try {
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    const running = busyTurn('interrupted');
    fake.addTurn(T1, running);   // busy from here: no budget spent
    await polls(fake, 5, 300);
    assert.equal(d.state.settled, false, 'three times the timeout behind the turn, still queued');
    running.status = 'completed';   // idle again (the app would now run it; this one never takes it)
    const late = await d.done;
    assert.match(typeof late === 'object' ? late.error : '', /nobody picked the message up/);
    assert.deepEqual(fake.queue.get(T1), [], 'taken out of the queue');
  } finally { await d.end(); await adapter.close!(); }
});

test('codex native: an interrupted newest turn without a held lock is not running → the pickup timeout applies', async () => {
  const { fake, adapter, deliver } = setup({ pickupTimeoutMs: 30, held: false });
  fake.addTurn(T1, busyTurn('interrupted'));
  const late = await deliver('d-stopped').p;
  assert.match(typeof late === 'object' ? late.error : '', /nobody picked the message up/);
  await adapter.close!();
});

test('codex native: picked up right at the deadline → keeps watching that turn instead of rejecting', async () => {
  const { fake, adapter, deliver } = setup({ pickupTimeoutMs: 30 });
  const orig = fake.handle.bind(fake);
  fake.handle = (m) => {
    // The app takes it between orrery's clean-up reading the queue and deleting from it (only the clean-up deletes).
    if (m.method === 'thread/queue/delete' && (fake.queue.get(T1) ?? []).length) fake.pickUp(T1, 'completed', 'just in time');
    return orig(m);
  };
  const { p, events } = deliver('d-edge');
  assert.equal(await p, 'completed');
  assert.deepEqual(events, [{ type: 'text', text: 'just in time' }]);
  assert.equal(fake.params('thread/queue/delete').length, 1, 'the delete came too late and found nothing');
  await adapter.close!();
});

test('codex native: the message leaves the queue and never runs → reject after the grace period, long before the pickup timeout', async () => {
  const { fake, adapter, deliver } = setup({ pickupTimeoutMs: 2_000, vanishedPolls: 3, vanishedMs: 30 });
  const started = Date.now();
  const { p } = deliver('d-gone');
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  fake.queue.set(T1, []);   // removed in the app, or dropped when an interrupted turn resumed
  assert.deepEqual(await p, { outcome: 'unknown', error: 'the message left the Codex queue and no matching turn was found; it may still run' });
  assert.ok(Date.now() - started < 1_500, 'well before pickupTimeoutMs');
  assert.equal(fake.params('thread/queue/delete').length, 0, 'nothing left to take out');
  assert.equal(fake.alive, 0);
  await adapter.close!();
});

test('codex native: the message leaves the queue and its turn shows up a few polls later (handover) → completes', async () => {
  // Fewer misses than vanishedPolls, and many misses within vanishedMs: neither is enough to fail.
  for (const [vanishedPolls, vanishedMs, gap] of [[3, 0, 2], [3, 10_000, 8]]) {
    const { fake, adapter, deliver } = setup({ vanishedPolls, vanishedMs });
    const { p, events } = deliver(`d-handover-${gap}`);
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    const [q] = fake.queue.get(T1)!;
    const orig = fake.handle.bind(fake);
    let misses = 0;
    fake.handle = (m) => {
      // `gap` polls see it neither queued nor as a turn; the next one sees its turn.
      if (m.method === 'thread/turns/list' && misses++ === gap) fake.queue.set(T1, [q]), fake.pickUp(T1, 'completed', 'handed over');
      return orig(m);
    };
    fake.queue.set(T1, []);
    assert.equal(await p, 'completed', `gap=${gap}`);
    assert.deepEqual(events, [{ type: 'text', text: 'handed over' }]);
    assert.equal(misses, gap + 1);
    await adapter.close!();
  }
});

/** A controllable "is the desktop app running" check: each query samples `up` when it starts and answers when released. */
function appProbe(up: boolean) {
  const probe = { up, calls: 0, held: [] as (() => void)[], hold: false };
  const appRunning = () => {
    probe.calls++;
    const sampled = probe.up;
    if (!probe.hold) return Promise.resolve(sampled);
    return new Promise<boolean>((resolve) => probe.held.push(() => resolve(sampled)));
  };
  const release = () => { for (const r of probe.held.splice(0)) r(); };
  return { probe, appRunning, release };
}

test('codex native: the desktop app not running → offline; a delivery that gets there anyway never wakes, leaves nothing queued, and resolves offline', async () => {
  const { probe, appRunning } = appProbe(false);
  const { fake, woken, adapter, deliver } = setup({ appRunning, appCheckMs: 0, pickupTimeoutMs: 1_000 });   // a regression fails fast
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), false, 'unknown counts as not running');
  await tick(5);
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), false);
  const calls = probe.calls;
  assert.equal(await adapter.confirmOnline!(T1), false, 'what the Hub asks before it gives a delivery up');
  assert.equal(probe.calls, calls + 1, 'a new query, not the cache');
  // E.g. the app closed between the Hub's isOnline and the wake.
  assert.deepEqual(await deliver('d-closed').p, { outcome: 'unknown', error: 'Codex closed after queueing; removal was attempted, but the message may still run' });
  assert.deepEqual(woken, [], 'the wake link would launch the app');
  assert.deepEqual(fake.queue.get(T1), [], 'queue removal was attempted');
  assert.equal(fake.alive, 0);
  // Running again: as before.
  probe.up = true;
  await until(() => adapter.isOnline(T1, NO_BRIDGE), 'online once the app runs');
  const { p } = deliver('d-closed');
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  fake.pickUp(T1, 'completed');
  assert.equal(await p, 'completed');
  assert.deepEqual(woken, [`codex://threads/wake/${T1}`]);
  await adapter.close!();
});

test('codex native: a check that cannot answer is not "not running": it is retried, the last answer stands, and nothing wakes on it', async () => {
  let answers: (boolean | null)[] = [true];
  const appRunning = async () => (answers.length > 1 ? answers.shift()! : answers[0]);
  const { fake, woken, adapter, deliver } = setup({ appRunning, appCheckMs: 0, pickupTimeoutMs: 1_000 });
  assert.equal(await adapter.confirmOnline!(T1), true);
  answers = [null, true];
  assert.equal(await adapter.confirmOnline!(T1), true, 'one timeout is tried again');
  answers = [null];
  await assert.rejects(adapter.confirmOnline!(T1), /process check did not answer/);
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), true, 'the last real answer stands');
  await tick(5);
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), true, 'and keeps standing while the checks fail');
  assert.deepEqual(await deliver('d-unknown').p, { outcome: 'failed', error: 'Could not confirm whether Codex is running: the process check did not answer; the delivery was not queued' });
  assert.equal(fake.launches, 0, 'a failed confirmation cannot start an app-server to queue a message');
  assert.deepEqual(woken, [], 'the wake link needs a confirmed answer: it would launch an app that is not running');
  answers = [false];
  await until(() => !adapter.isOnline(T1, NO_BRIDGE), 'a real "not running" still takes it offline');
  await adapter.close!();
});

test('codex native + Hub: unanswered process checks produce a failed delivery without queuing or waking', async () => {
  const probe: { up: boolean | null } = { up: true };
  const { fake, adapter, woken } = setup({ appRunning: async () => probe.up });
  fake.threads = [{ id: T1, preview: 'hi', model: 'm', cwd: CWD, name: 'my chat', updatedAt: 0 }];
  const store = new Store(':memory:');
  const hub = new Hub({ store, nativeAdapters: { codex: adapter }, limits: { startupGraceMs: 0 } });
  hub.start();
  try {
    const { cluster } = await hub.createCluster('c', [{ harness: 'codex', mode: 'native', sessionId: T1, name: 'X' }]);
    assert.equal(await adapter.confirmOnline!(T1), true);
    probe.up = null;
    const message = hub.sendFromUser(cluster.id, '@X hello');
    const delivery = () => store.withDeliveries([store.getMessage(message.id)!])[0].deliveries[0];
    await until(() => delivery().state === 'failed', 'explicit failure rather than offline');
    assert.equal(delivery().outcome, 'failed');
    assert.match(delivery().error!, /process check did not answer/);
    assert.deepEqual(fake.params('thread/queue/add'), []);
    assert.deepEqual(woken, []);
  } finally { await hub.close(); }
});

test('codex native: an unanswered wake check withdraws a queued message and reports an unknown result', async () => {
  const { fake, adapter, woken, deliver } = setup({ appRunning: async () => null });
  assert.deepEqual(await deliver('d-unknown-at-wake').p, {
    outcome: 'unknown', error: 'Could not confirm whether Codex is running: the process check did not answer; removal was attempted, but the message may still run',
  });
  assert.deepEqual(fake.queue.get(T1), []);
  assert.deepEqual(woken, []);
  await adapter.close!();
});

/** An app check whose answers the test gives one by one, in the order it chooses. */
function manualProbe() {
  const asked: ((up: boolean | null) => void)[] = [];
  return { asked, appRunning: () => new Promise<boolean | null>((resolve) => asked.push(resolve)) };
}

test('codex native: a retry counts as a newer query, so "not running" from it beats an older "running"', async () => {
  const { asked, appRunning } = manualProbe();
  const { adapter } = setup({ appRunning, appCheckMs: 60_000 });
  const first = adapter.confirmOnline!(T1);
  await Promise.resolve();  // starts sampling before the next confirmation arrives
  const beforeTheWake = adapter.confirmOnline!(T1);
  asked[0](null);
  await tick();
  assert.equal(asked.length, 3, 'the first query was retried');
  asked[2](false);   // the retry started after the second query and sees the app gone
  assert.equal(await first, false);
  asked[1](true);    // the second query sampled the app earlier
  assert.equal(await beforeTheWake, false, 'that older "running" must not open the wake link');
  await adapter.close!();
});

test('codex native: a query with no answer does not stop an older real answer from reaching the cache', async () => {
  const { asked, appRunning } = manualProbe();
  const { adapter } = setup({ appRunning, appCheckMs: 60_000 });
  const start = adapter.confirmOnline!(T1);
  await Promise.resolve();
  asked[0](true);
  await start;
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), true);
  const older = adapter.confirmOnline!(T1);
  await Promise.resolve();
  const newer = adapter.confirmOnline!(T1);
  await Promise.resolve();
  asked[2](null);
  await tick();
  asked[3](null);
  await assert.rejects(newer, /process check did not answer/);
  asked[1](false);
  assert.equal(await older, false);
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), false, 'the real "not running" still lands');
  await adapter.close!();
});

test('codex native: concurrent confirmations share only a probe that has not started sampling', async () => {
  const { asked, appRunning } = manualProbe();
  const { adapter } = setup({ appRunning });
  adapter.isOnline(T1, NO_BRIDGE);   // stale status read in the same burst
  const sameBurst = [adapter.confirmOnline!(T1), adapter.confirmOnline!(T2)];
  await Promise.resolve();
  assert.equal(asked.length, 1, 'three requests, one process');
  const later = adapter.confirmOnline!(T1);
  await Promise.resolve();
  assert.equal(asked.length, 2, 'the later request gets a new process');
  asked[0](false);
  asked[1](true);
  assert.deepEqual(await Promise.all(sameBurst), [false, false]);
  assert.equal(await later, true);
  await adapter.close!();
});

test('codex native + Hub: a cold or stale "not running" never drops a message; confirmOnline asks afresh first', async () => {
  const store = new Store(':memory:');
  /** A Hub (no start-up grace) over a new adapter, so its "is the app running" cache is cold. */
  const open = (appRunning: () => Promise<boolean>) => {
    const s = setup({ appRunning, appCheckMs: 60_000 });
    s.fake.threads = [{ id: T1, preview: 'hi', model: 'm', cwd: CWD, name: 'my chat', updatedAt: 0 }];
    const hub = new Hub({ store, nativeAdapters: { codex: s.adapter }, limits: { startupGraceMs: 0 } });
    hub.start();
    return { ...s, hub };
  };
  const stateOf = (messageId: string) => store.withDeliveries([store.getMessage(messageId)!])[0].deliveries[0].state;
  const first = open(async () => true);
  const { cluster } = await first.hub.createCluster('c', [{ harness: 'codex', mode: 'native', sessionId: T1, name: 'X' }]);
  await first.hub.close();

  // Right after a restart, with the app running: the cache is not known yet, isOnline says false.
  const { probe, appRunning } = appProbe(true);
  let h = open(appRunning);
  try {
    assert.equal(h.adapter.isOnline(T1, h.hub.bridge), false, 'the cache is cold');
    const m = h.hub.sendFromUser(cluster.id, '@X hello');
    await until(() => (h.fake.queue.get(T1) ?? []).length === 1, 'queued in Codex');
    h.fake.pickUp(T1, 'completed');
    await until(() => stateOf(m.id) === 'done', 'delivered');
    assert.deepEqual(h.woken, [`codex://threads/wake/${T1}`]);
  } finally {
    await h.hub.close();
  }

  // The cache sampled "not running" before the user opened the app: stale, and confirmOnline catches it as well.
  const stale = appProbe(false);
  h = open(stale.appRunning);
  try {
    h.adapter.isOnline(T1, h.hub.bridge);
    await until(() => stale.probe.calls === 1, 'sampled');
    await tick(5);
    stale.probe.up = true;
    assert.equal(h.adapter.isOnline(T1, h.hub.bridge), false, 'the cache is stale');
    const m = h.hub.sendFromUser(cluster.id, '@X again');
    await until(() => (h.fake.queue.get(T1) ?? []).length === 1, 'queued in Codex');
    h.fake.pickUp(T1, 'completed');
    await until(() => stateOf(m.id) === 'done', 'delivered');
    assert.equal(stale.probe.calls, 3, 'the cache, then confirmOnline, then the check before the wake');
  } finally {
    await h.hub.close();
  }
  assert.ok(probe.calls >= 2);
});

test('codex native + Hub: a cache that says running decides nothing; a stale "not running" decides only older deliveries (review P1, P2)', async () => {
  const { probe, appRunning, release } = appProbe(true);
  const { fake, woken, adapter } = setup({ appRunning, appCheckMs: 60_000 });
  fake.threads = [{ id: T1, preview: 'hi', model: 'm', cwd: CWD, name: 'my chat', updatedAt: 0 }];
  const store = new Store(':memory:');
  const hub = new Hub({ store, nativeAdapters: { codex: adapter }, limits: { startupGraceMs: 0 } });
  hub.start();
  const stateOf = (messageId: string) => store.withDeliveries([store.getMessage(messageId)!])[0].deliveries[0].state;
  try {
    const { cluster } = await hub.createCluster('c', [{ harness: 'codex', mode: 'native', sessionId: T1, name: 'X' }]);
    await until(() => adapter.isOnline(T1, hub.bridge), 'the cache says running');

    // P1: the app closes, the cache still says running; a message posted while paused ends offline at once, and
    // nothing reaches Codex after the app is open again and the Hub unpaused.
    probe.up = false;
    hub.setPaused(true);
    const closed = hub.sendFromUser(cluster.id, '@X while closed');
    await until(() => stateOf(closed.id) === 'offline', 'offline, decided by a fresh check');
    probe.up = true;
    hub.setPaused(false);
    await tick(30);
    assert.equal(fake.params('thread/queue/add').length, 0, 'nothing reached Codex');
    assert.deepEqual(woken, []);

    // P2: the check for "two" samples "not running" and answers late; meanwhile a newer query says running and
    // "three" is posted. The late answer drops "two" only; "three" gets its own check and is delivered.
    probe.up = false;
    probe.hold = true;
    const two = hub.sendFromUser(cluster.id, '@X two');
    await until(() => probe.held.length === 1, 'check for two asked');
    probe.up = true;
    const newer = adapter.confirmOnline!(T1);
    await until(() => probe.held.length === 2, 'newer query asked');
    probe.held.splice(1, 1)[0]();
    assert.equal(await newer, true);
    assert.equal(adapter.isOnline(T1, hub.bridge), true, 'the cache says running');
    const three = hub.sendFromUser(cluster.id, '@X three');
    probe.held.splice(0, 1)[0]();   // the stale "not running"
    await until(() => stateOf(two.id) === 'offline', 'two dropped');
    assert.equal(stateOf(three.id), 'queued');
    await until(() => probe.held.length === 1, 'three gets a check of its own');
    probe.hold = false;
    release();
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'three queued in Codex');
    fake.pickUp(T1, 'completed');
    await until(() => stateOf(three.id) === 'done', 'three delivered');
    assert.equal(fake.params('thread/queue/add').length, 1, 'only three reached Codex');
  } finally {
    probe.hold = false;
    release();   // Hub.close waits for checks in flight
    await hub.close();
  }
});

test('codex native: a query already under way when the app closes is not what the wake relies on', async () => {
  const { probe, appRunning, release } = appProbe(true);
  const { fake, woken, adapter, deliver } = setup({ appRunning, appCheckMs: 0, pickupTimeoutMs: 1_000 });
  probe.hold = true;
  adapter.isOnline(T1, NO_BRIDGE);   // starts a query; it samples the app while it still runs
  await Promise.resolve();
  assert.equal(probe.calls, 1);
  probe.up = false;                  // the user closes the app
  const { p } = deliver('d-race');
  await until(() => fake.params('thread/queue/add').length === 1 && fake.alive === 0, 'queued');
  await tick(20);                    // whatever check comes before the wake has been asked by now
  release();                         // the old query answers "running" (sampled before the close)
  await tick(20);
  release();
  assert.deepEqual(await p, { outcome: 'unknown', error: 'Codex closed after queueing; removal was attempted, but the message may still run' });
  assert.deepEqual(woken, [], 'no wake on the strength of the old answer');
  assert.deepEqual(fake.queue.get(T1), [], 'taken back out of the queue');
  assert.equal(probe.calls, 2, 'a new query of its own before the wake');
  await adapter.close!();
});

test('codex native: an older "running" that settles after a newer "not running" drives no wake', async () => {
  const { probe, appRunning, release } = appProbe(true);
  const { fake, woken, adapter, deliver } = setup({ appRunning, pickupTimeoutMs: 1_000 });   // a regression fails fast
  probe.hold = true;
  const a = deliver('d-a');
  await until(() => probe.calls === 1, 'check A asked (app up)');
  probe.up = false;
  const b = deliver('d-b');
  await until(() => probe.calls === 2, 'check B asked (app down)');
  probe.held.pop()!();               // B settles first: not running
  assert.deepEqual(await b.p, { outcome: 'unknown', error: 'Codex closed after queueing; removal was attempted, but the message may still run' });
  release();                         // then A: running, sampled before B
  assert.deepEqual(await a.p, { outcome: 'unknown', error: 'Codex closed after queueing; removal was attempted, but the message may still run' });
  assert.deepEqual(woken, [], 'A must not wake on its stale answer');
  assert.deepEqual(fake.queue.get(T1), [], 'both taken back out of the queue');
  await adapter.close!();
});

test('codex native: exactly one new query right before each wake, never the cached answer', async () => {
  const { probe, appRunning } = appProbe(true);
  const { fake, woken, adapter, deliver } = setup({ appRunning, appCheckMs: 60_000 });
  adapter.isOnline(T1, NO_BRIDGE);
  await until(() => adapter.isOnline(T1, NO_BRIDGE), 'cached: running');
  assert.equal(probe.calls, 1);
  for (const [i, id] of ['d-w1', 'd-w2'].entries()) {
    const { p } = deliver(id);
    await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
    fake.pickUp(T1, 'completed');
    assert.equal(await p, 'completed');
    assert.equal(probe.calls, 2 + i, 'one query per wake, although the cache is fresh');
    assert.equal(woken.length, 1 + i);
  }
  await adapter.close!();
});

test('codex native: no timer polls the app; concurrent isOnline calls share a cache timed from completion', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { probe, appRunning, release } = appProbe(true);
  const adapter = createCodexNativeAdapter({ launch: new FakeCodex().launch, appRunning, appCheckMs: 200 });
  opened.push(adapter);
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.equal(probe.calls, 0, 'nothing runs until someone asks');
  probe.hold = true;
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), false, 'the first call starts a query; unknown counts as not running');
  adapter.isOnline(T1, NO_BRIDGE);
  adapter.isOnline(T1, NO_BRIDGE);
  await Promise.resolve();
  assert.equal(probe.calls, 1, 'concurrent callers share one query');
  t.mock.timers.tick(1_000);   // the check itself is slower than the cache duration
  release();
  await tick();   // the answer lands (through the query time limit's race)
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), true);
  await Promise.resolve();
  assert.equal(probe.calls, 1, 'the slow result has not already expired');
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.equal(probe.calls, 1, 'still nothing between calls');
  adapter.isOnline(T1, NO_BRIDGE);
  await Promise.resolve();
  assert.equal(probe.calls, 2, 'stale after appCheckMs: refreshed on the next call');
  release();
  await adapter.close!();
});

test('codex native: by default isOnline shows the app opening or closing within 10 s of the last answer plus one query', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { probe, appRunning } = appProbe(true);
  const adapter = createCodexNativeAdapter({ launch: new FakeCodex().launch, appRunning });   // default appCheckMs
  opened.push(adapter);
  adapter.isOnline(T1, NO_BRIDGE);
  await tick();
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), true);
  probe.up = false;            // the user quits the app
  t.mock.timers.tick(9_999);
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), true, 'a positive at most 10 s old may still be shown');
  await tick();
  assert.equal(probe.calls, 1, 'no query before the answer is 10 s old');
  t.mock.timers.tick(1);
  adapter.isOnline(T1, NO_BRIDGE);
  await tick();
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), false, 'online → offline once 10 s have passed and one query answered');
  probe.up = true;             // the user opens it again
  t.mock.timers.tick(10_000);
  adapter.isOnline(T1, NO_BRIDGE);
  await tick();
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), true, 'offline → online within the same bound');
  assert.equal(probe.calls, 3);
  await adapter.close!();
});

test('codex native: a hung or throwing check counts as unanswered, never as an answer, and the next call asks again', async () => {
  let mode: 'hang' | 'throw' | 'up' = 'hang';
  let calls = 0;
  const appRunning = (): Promise<boolean | null> => {
    calls++;
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'throw') throw new Error('tasklist could not start');
    return Promise.resolve(true);
  };
  const { adapter, woken, deliver, fake } = setup({ appRunning, appCheckMs: 0, appQueryTimeoutMs: 20 });
  await assert.rejects(adapter.confirmOnline!(T1), /process check did not answer/, 'both tries hung: unknown, not offline');
  assert.equal(calls, 2, 'the hung try was given up and tried once more');
  assert.equal(adapter.isOnline(T1, NO_BRIDGE), false, 'nothing confirmed it runs');
  mode = 'throw';
  await assert.rejects(adapter.confirmOnline!(T1), /process check did not answer/, 'a throw is no answer either');
  assert.deepEqual(await deliver('d-hung').p, { outcome: 'failed', error: 'Could not confirm whether Codex is running: the process check did not answer; the delivery was not queued' });
  assert.equal(fake.launches, 0);
  assert.deepEqual(woken, []);
  mode = 'up';
  const before = calls;
  await until(() => adapter.isOnline(T1, NO_BRIDGE), 'a later call asks again and sees the app');
  assert.ok(calls > before, 'the failed checks did not stop new ones');
  assert.equal(await adapter.confirmOnline!(T1), true);
  await adapter.close!();
});

test('codex native: the default check looks for the app executable of the app package in tasklist /APPS output', () => {
  const row = (image: string, pkg: string) => `"${image}","100","10.000 K","${pkg}"\r\n`;
  const CODEX = 'OpenAI.Codex_1.2.3.0_x64__abcdefghijklm';
  const calc = row('Calculator.exe (App)', 'Microsoft.WindowsCalculator_1.0.0.0_x64__8wekyb3d8bbwe');
  assert.equal(codexAppIn(calc + row('ChatGPT.exe (App)', CODEX)), true);
  assert.equal(codexAppIn(calc + row('chatgpt.EXE (App)', CODEX)), true, 'image name matched case-insensitively');
  // Real case: after the app was quit, a RuntimeBroker.exe of its package lingered ~30 s; counting it relaunched the app.
  assert.equal(codexAppIn(calc + row('RuntimeBroker.exe (runtimebroker07f4358a809ac99a64a67c1)', CODEX)), false);
  assert.equal(codexAppIn(row('crashpad_handler.exe (App)', CODEX)), false);
  assert.equal(codexAppIn(row('NotChatGPT.exe (App)', CODEX)), false);
  assert.equal(codexAppIn(calc), false);
  assert.equal(codexAppIn(row('ChatGPT.exe (App)', 'OpenAI.ChatGPT-Desktop_1.0.0.0_x64__abcdefghijklm')), false);
  assert.equal(codexAppIn(''), false);
  assert.equal(codexAppIn('INFO: No tasks are running which match the specified criteria.\r\n'), false);
});

test('codex native: abort while queued → taken out of the queue, then reject', async () => {
  const { fake, adapter, deliver } = setup();
  const ac = new AbortController();
  const { p } = deliver('d-abort', 'hi', ac.signal);
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  ac.abort();
  assert.deepEqual(await p, { outcome: 'unknown', error: 'delivery aborted' });
  assert.deepEqual(fake.queue.get(T1), []);
  assert.equal(fake.params('thread/queue/delete').length, 1);
  await adapter.close!();
});

test('codex native: abort in the middle of queue/add still cleans the queue up', async () => {
  const { fake, adapter, deliver } = setup();
  fake.delayMs = 20;
  const ac = new AbortController();
  const { p } = deliver('d-mid', 'hi', ac.signal);
  await until(() => fake.params('thread/queue/add').length === 1, 'queue/add sent');
  ac.abort();   // before its answer arrives; the fake still adds it
  assert.deepEqual(await p, { outcome: 'unknown', error: 'delivery aborted' });
  await tick(50);
  assert.equal(fake.params('thread/queue/delete').length, 1, 'the late add was found and deleted');
  assert.deepEqual(fake.queue.get(T1) ?? [], []);
  await adapter.close!();
});

test('codex native: a retried delivery (Hub restart) does not queue twice', async () => {
  {
    const { fake, woken, adapter, deliver } = setup();
    fake.delayMs = 40;
    fake.queue.set(T1, [{ id: 'q-old', input: [], clientUserMessageId: 'd-again' }]);
    const { p } = deliver('d-again');
    await until(() => woken.length === 1, 'retried queued delivery woke the thread');
    assert.equal(fake.params('thread/queue/add').length, 0, 'already queued');
    fake.pickUp(T1, 'completed');
    assert.equal(await p, 'completed');
    assert.deepEqual(woken, [`codex://threads/wake/${T1}`], 'still waiting in the queue: woken again');
    await adapter.close!();
  }
  {
    const { fake, woken, adapter, deliver } = setup({ held: false });
    fake.addTurn(T1, { id: 'ran', status: 'completed', error: null, items: [{ type: 'userMessage', clientId: 'd-ran' }, { type: 'agentMessage', text: 'earlier' }] });
    const { p, events } = deliver('d-ran');
    assert.equal(await p, 'completed');
    assert.equal(fake.params('thread/queue/add').length, 0, 'already ran');
    assert.deepEqual(woken, [], 'nothing to wake for');
    assert.deepEqual(events, [{ type: 'text', text: 'earlier' }]);
    await adapter.close!();
  }
});

test('codex native: at most maxProcesses app-servers run at once', async () => {
  const { fake, adapter, deliver } = setup({ maxProcesses: 2 });
  fake.delayMs = 5;
  const runs = Array.from({ length: 6 }, (_, i) => deliver(`d-${i}`));
  await until(() => (fake.queue.get(T1) ?? []).length === 6, 'all queued');
  for (let i = 0; i < 6; i++) fake.pickUp(T1, 'completed', `r${i}`);
  assert.deepEqual(await Promise.all(runs.map((r) => r.p)), Array(6).fill('completed'));
  assert.ok(fake.launches >= 12, 'one process per operation');
  assert.equal(fake.maxAlive, 2);
  assert.equal(fake.alive, 0);
  await adapter.close!();
});

test('codex native: listSessions follows every thread/list page; listProjects groups by cwd', async () => {
  const { fake, adapter } = setup();
  fake.threads = Array.from({ length: 250 }, (_, i) => ({ id: `t${i}`, preview: `p${i}`, model: 'm', cwd: i % 2 ? 'C:\\a' : 'C:\\b', name: null, updatedAt: 1_700_000_000 + i }));
  const sessions = await adapter.listSessions('C:\\a');
  assert.equal(sessions.length, 125);
  assert.deepEqual(fake.params('thread/list').map((x) => [x.cwd, x.cursor, x.limit]), [['C:\\a', null, 100], ['C:\\a', '1', 100]]);
  const projects = await adapter.listProjects();
  assert.deepEqual(projects.map((x) => x.path).sort(), ['C:\\a', 'C:\\b']);
  assert.equal(fake.params('thread/list').length, 5, 'three more pages for the projects');
  assert.equal(fake.alive, 0);
  await adapter.close!();
});

test('codex native: createSession with a model or effort runs one init turn in the same process, with them and the fixed text', async () => {
  const { fake, adapter } = setup();
  assert.deepEqual(await adapter.createSession!({ cwd: CWD, title: 'orrery: demo', model: 'gpt-x', effort: 'high', memberName: 'X' }), { sessionId: T2, model: 'gpt-x' });
  assert.deepEqual(fake.params('thread/start'), [{ cwd: CWD, model: 'gpt-x', config: { model_reasoning_effort: 'high' } }], 'no sandbox or approval override');
  assert.deepEqual(fake.params('thread/name/set'), [{ threadId: T2, name: 'orrery: demo' }]);
  assert.deepEqual(fake.params('turn/start'), [{
    threadId: T2, input: [{ type: 'text', text: '你是 orrery 集群「demo」的群员「X」。只回复 ok。', text_elements: [] }], model: 'gpt-x', effort: 'high',
  }]);
  assert.equal(initPrompt('demo', 'X'), '你是 orrery 集群「demo」的群员「X」。只回复 ok。');
  assert.deepEqual(fake.methods(), ['thread/start', 'thread/name/set', 'turn/start']);
  assert.equal(new Set(fake.sent.map((m) => m.proc)).size, 1, 'one process for all of it');
  assert.equal(fake.alive, 0, 'and it exited afterwards');

  // Only the effort chosen: the init turn carries just that.
  await adapter.createSession!({ cwd: CWD, title: 'orrery: demo', effort: 'low', memberName: 'Y' });
  const second = fake.params('turn/start')[1];
  assert.equal(second.effort, 'low');
  assert.ok(!('model' in second));
  await adapter.close!();
});

test('codex native: createSession without model and effort runs no turn', async () => {
  const { fake, adapter } = setup();
  await adapter.createSession!({ cwd: CWD, title: 'plain', memberName: 'Z' });
  assert.deepEqual(fake.params('thread/start'), [{ cwd: CWD }], 'the user\'s own defaults');
  assert.deepEqual(fake.methods(), ['thread/start', 'thread/name/set'], 'no turn');
  assert.equal(fake.alive, 0, 'the process that created it is gone, so it holds no writer lock');
  await adapter.close!();
});

test('codex native: an init turn that fails, is interrupted, never finishes or loses its process makes createSession reject', async () => {
  const cases: [string, (f: FakeCodex, p: any, id: string) => void, RegExp][] = [
    ['failed', (f, p, id) => f.emit('turn/completed', { threadId: p.threadId, turn: { id, status: 'failed', error: { message: 'model not found' } } }), /init turn of the new Codex thread ended failed: model not found/],
    ['interrupted', (f, p, id) => f.emit('turn/completed', { threadId: p.threadId, turn: { id, status: 'interrupted', error: null } }), /ended interrupted/],
    ['never', () => {}, /did not finish within 0 s/],
    ['crash', (f) => f.crashNewest(), /did not finish: /],
    ['another turn completes', (f, p) => f.emit('turn/completed', { threadId: p.threadId, turn: { id: 'other', status: 'completed', error: null } }), /did not finish within/],
  ];
  for (const [name, onTurnStart, expected] of cases) {
    const { fake, adapter } = setup({ initTimeoutMs: 50 });
    fake.onTurnStart = onTurnStart;
    await assert.rejects(adapter.createSession!({ cwd: CWD, title: 'orrery: demo', model: 'gpt-x', memberName: 'X' }), expected, name);
    assert.equal(fake.alive, 0, `${name}: the process is gone`);
    await adapter.close!();
  }
});

test('codex native: an init turn/completed that arrives before the turn/start answer still counts', async () => {
  const { fake, adapter } = setup({ initTimeoutMs: 2_000 });
  fake.completeBeforeAck = true;
  const t0 = Date.now();
  assert.deepEqual(await adapter.createSession!({ cwd: CWD, title: 'orrery: demo', model: 'gpt-x', memberName: 'X' }), { sessionId: T2, model: 'gpt-x' });
  assert.ok(Date.now() - t0 < 1_000, 'no wait for the timeout');
  await adapter.close!();
});

test('codex native: a process that exits right after answering turn/start fails createSession at once, not as a timeout', async () => {
  const { fake, adapter } = setup({ initTimeoutMs: 2_000 });
  fake.exitAfterAck = true;
  const t0 = Date.now();
  await assert.rejects(adapter.createSession!({ cwd: CWD, title: 'orrery: demo', model: 'gpt-x', memberName: 'X' }), /did not finish: app-server exited \(1\)/);
  assert.ok(Date.now() - t0 < 1_000, 'no wait for the timeout');
  await adapter.close!();
});

test('codex native: every approval or prompt during the init turn is declined', async () => {
  const { fake, adapter } = setup();
  const asked: number[] = [];
  fake.onTurnStart = (f, p, id) => {
    asked.push(
      f.request('item/commandExecution/requestApproval', { threadId: p.threadId, turnId: id, command: 'rm -rf /' }),
      f.request('item/fileChange/requestApproval', { threadId: p.threadId, turnId: id }),
      f.request('mcpServer/elicitation/request', { threadId: p.threadId, serverName: 'orrery', message: 'allow send_message?' }),
      f.request('item/permissions/requestApproval', { threadId: p.threadId, turnId: id }),
    );
    setTimeout(() => f.emit('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', error: null } }), 20);
  };
  await adapter.createSession!({ cwd: CWD, title: 'orrery: demo', model: 'gpt-x', memberName: 'X' });
  const byId = new Map(fake.replies.map((r) => [r.id, r]));
  assert.deepEqual(asked.map((id) => (byId.get(id) as any)?.result), [
    { decision: 'decline' }, { decision: 'decline' }, { action: 'decline', content: null, _meta: null }, { permissions: {}, scope: 'turn' },
  ], 'even an orrery tool prompt');
  await adapter.close!();
});

test('codex native: attach reads the thread; ids that are not UUIDs never reach a process or the wake link', async () => {
  const { fake, adapter, deliver } = setup();
  fake.threads = [{ id: T1, preview: 'hi', model: 'm', cwd: CWD, name: 'my chat', updatedAt: 0 }];
  assert.equal((await adapter.attachSession(T1)).title, 'my chat');
  const bad = `${T1}" & calc & "`;
  await assert.rejects(adapter.attachSession(bad), /not a Codex thread id/);
  await assert.rejects(deliver('d', 'x', undefined, bad).p, /not a Codex thread id/);
  assert.throws(() => wakeUrl(bad), /not a Codex thread id/);
  assert.equal(wakeUrl(T1), `codex://threads/wake/${T1}`);
  assert.equal(fake.launches, 1, 'only the good attach started a process');
  await until(() => adapter.isOnline(T1, NO_BRIDGE), 'online while the app runs');
  await adapter.close!();
});

test('codex native: writer lock errors, unsupported platforms and readable files never prove the turn stopped', () => {
  const home = tempDir();
  assert.deepEqual(writerLockHeld(home, T1, { platform: 'win32' }), { state: 'unknown', reason: 'writer lock check failed (ENOENT)' });
  mkdirSync(join(home, 'thread-writer-locks'));
  writeFileSync(join(home, 'thread-writer-locks', `${T1}.lock`), '');
  assert.deepEqual(writerLockHeld(home, T1, { platform: 'win32' }), { state: 'unknown', reason: 'cannot verify that this writer lock belongs to the desktop app' });
  const error = (code: string) => () => { throw Object.assign(new Error('probe failed'), { code }); };
  assert.deepEqual(writerLockHeld(home, T1, { platform: 'win32', read: error('EACCES') }), { state: 'unknown', reason: 'writer lock check failed (EACCES)' });
  assert.deepEqual(writerLockHeld(home, T1, { platform: 'win32', read: error('EBUSY') }), { state: 'held' });
  assert.deepEqual(writerLockHeld(home, T1, { platform: 'linux', read: error('EBUSY') }), { state: 'unknown', reason: 'writer lock checks are not supported on this platform' });
});

test('codex native: binary is the newest desktop codex.exe, else codex on PATH; the env override wins', () => {
  const dir = tempDir();
  const bin = join(dir, 'OpenAI', 'Codex', 'bin');
  for (const [h, age] of [['old', 1000], ['new', 10], ['empty', 0]] as const) {
    mkdirSync(join(bin, h), { recursive: true });
    if (h === 'empty') continue;
    writeFileSync(join(bin, h, 'codex.exe'), '');
    const t = new Date(Date.now() - age * 1000);
    utimesSync(join(bin, h, 'codex.exe'), t, t);
  }
  assert.equal(codexBinary({ LOCALAPPDATA: dir }), join(bin, 'new', 'codex.exe'));
  assert.equal(codexBinary({ LOCALAPPDATA: join(dir, 'none') }), 'codex');
  assert.equal(codexBinary({}), 'codex');
  assert.equal(codexBinary({ LOCALAPPDATA: dir, ORRERY_CODEX_NATIVE_BIN: 'C:\\x\\codex.exe' }), 'C:\\x\\codex.exe');
});

test('codex native: registered, with createSession', () => {
  const a = nativeFactories.codex();
  assert.equal(a.harness, 'codex');
  assert.equal(typeof a.createSession, 'function');
});

// ---- live check against the desktop app's own codex binary (opt-in, free) ----
// A throwaway CODEX_HOME whose model is a local fake Responses endpoint, a real Hub, and a second app-server that plays
// the desktop app: it holds the thread (writer lock) and runs whatever lands in its queue. The user's ~/.codex is never
// read or written; nothing is billed.

const LIVE = !process.env.ORRERY_CODEX_LIVE;

async function liveNative(scenario: 'held' | 'wake', create: { model?: string; effort?: string } = {}) {
  const bin = codexBinary();
  const root = join(tmpdir(), 'orrery-sandbox', `codex-native-${process.pid}-${Date.now()}`);
  const home = join(root, 'home');
  const work = join(root, 'work');
  for (const d of [home, work]) mkdirSync(d, { recursive: true });
  const cleanup: (() => Promise<void> | void)[] = [async () => {
    for (let i = 0; ; i++) {
      try { rmSync(root, { recursive: true, force: true }); return; } catch (e) { if (i >= 40) throw e; }
      await tick(250);
    }
  }];
  const spawnCodex = () => spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
  const stop = (c: ReturnType<typeof spawn>) => new Promise<void>((ok) => {
    if (c.exitCode !== null || c.pid === undefined) { ok(); return; }
    c.once('exit', () => ok());
    spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    setTimeout(ok, 5_000).unref();
  });
  try {
    // The fake model answers each turn by calling orrery's send_message from code mode, then says "done"; the init
    // turn of createSession just gets "ok". Every request's model and effort is recorded.
    let n = 0;
    const requests: { model: string; effort: string | null; init: boolean }[] = [];
    const model = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      if (!raw) { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw);
      const last = body.input.at(-1);
      n++;
      const followUp = last?.type === 'custom_tool_call_output';
      const userText = (body.input.filter((i: any) => i.type === 'message' && i.role === 'user').at(-1)?.content ?? []).map((c: any) => c.text ?? '').join('');
      const init = userText.includes('只回复 ok');
      requests.push({ model: body.model, effort: body.reasoning?.effort ?? null, init });
      const js = 'let r; try { r = await tools.mcp__orrery__send_message({ body: "hello from codex" }); } catch (e) { r = "ERR " + String(e); }\n'
        + 'text(typeof r === "string" ? r : JSON.stringify(r));';
      const item = init ? { type: 'message', role: 'assistant', id: `msg_${n}`, status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
        : followUp
        ? { type: 'message', role: 'assistant', id: `msg_${n}`, status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
        : { type: 'custom_tool_call', id: `ctc_${n}`, call_id: `call_${n}`, name: 'exec', input: js, status: 'completed' };
      const ev = [
        { type: 'response.created', response: { id: `r${n}` } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `r${n}`, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
    cleanup.push(() => new Promise<void>((ok) => { model.close(() => ok()); model.closeAllConnections(); }));
    await new Promise<void>((ok) => model.listen(0, '127.0.0.1', ok));

    // The desktop app: an app-server that loads the thread (taking its writer lock) and runs its queue.
    // Server requests are answered like a user who approves orrery's tools and declines everything else.
    let desktop: { child: ReturnType<typeof spawn>; rpc: RpcPeer } | null = null;
    const startDesktop = async (threadId: string) => {
      const child = spawnCodex();
      cleanup.push(() => stop(child));
      const rpc = new RpcPeer(child.stdin!, child.stdout!, {
        onNotification: () => {},
        onRequest: async (m, p: any) => (m === 'mcpServer/elicitation/request' && p?.serverName === 'orrery'
          ? { action: 'accept', content: {}, _meta: null } : decideServerRequest(m, p).result),
        onClose: () => {},
      });
      child.once('exit', () => rpc.close('exited'));
      await rpc.request('initialize', { clientInfo: { name: 'fake-desktop', title: null, version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.notify('initialized');
      await rpc.request('thread/resume', { threadId });
      desktop = { child, rpc };
    };

    const woken: string[] = [];
    let wakeDone: Promise<void> | null = null;
    const adapter = createCodexNativeAdapter({
      codexHome: home,
      pollMs: 500,
      appRunning: async () => true,   // the second app-server plays the desktop app
      launch: () => {
        const child = spawn(bin, ['-c', 'features.plugins=false', '-c', 'features.apps=false', 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
        return {
          stdin: child.stdin, stdout: child.stdout, kill: () => void child.kill(),
          onExit: (cb) => {
            child.once('error', (e) => cb(`app-server failed to start: ${e.message}`));
            child.once('exit', (code, sig) => cb(`app-server exited (${sig ?? code})`));
          },
        };
      },
      // Plays the app's link handler: load the thread in "its" backend. When "the app" has it loaded already, its
      // backend runs the queue on its own; nothing more to do here.
      openWake: (url) => { woken.push(url); if (!desktop && !wakeDone) wakeDone = startDesktop(url.split('/').pop()!); },
    });
    const app = await startHub({ dbPath: join(root, 'hub.db'), port: 0, home: join(root, 'hub'), registryDir: join(root, 'registry'),
      nativeAdapters: { codex: adapter }, apiToken: TEST_TOKEN });
    cleanup.push(() => app.close());
    const { secret } = JSON.parse(readFileSync(join(root, 'hub', 'hub.json'), 'utf8'));
    const q = JSON.stringify;   // a JSON string literal is a valid TOML basic string
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\nmodel_provider = "fake"\n[features]\nplugins = false\napps = false\n'
      + `[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${(model.address() as any).port}/v1"\nwire_api = "responses"\n`
      // What README tells the user to add to their own config.
      + `[mcp_servers.orrery]\nurl = ${q(`${app.url}/mcp`)}\nhttp_headers = { "x-orrery-bridge" = ${q(secret)} }\n`);

    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(app.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data: any = await res.json();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
      return data;
    };
    // The Hub creates the member's thread itself (createSession: thread/start + name, no turn).
    const { cluster, members: [x] } = await api('POST', '/api/clusters', {
      name: 'live', members: [{ harness: 'codex', mode: 'native', name: 'X', projectPath: work, ...create }],
    });
    const threadId: string = x.workerSessionId;
    const lockAfterCreate = writerLockHeld(home, threadId);
    const createRequests = requests.length;
    let lockWhileHeld: ReturnType<typeof writerLockHeld> | null = null;
    if (scenario === 'held') {
      await startDesktop(threadId);
      lockWhileHeld = writerLockHeld(home, threadId);
    }
    const sent = await api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@X please say hello' });
    const msgId: string = sent.id;
    const t0 = Date.now();
    let msgs: any[] = [];
    for (let i = 0; i < 400; i++) {
      msgs = await api('GET', `/api/clusters/${cluster.id}/messages`);
      const d = msgs.find((m) => m.id === msgId)?.deliveries[0];
      if (d && ['done', 'failed', 'offline'].includes(d.state)) break;
      await tick(250);
    }
    const seconds = (Date.now() - t0) / 1000;
    if (wakeDone) await wakeDone;
    const turns: any = desktop ? await (desktop as any).rpc.request('thread/turns/list', { threadId, limit: 5 }) : { data: [] };
    const events = await api('GET', `/api/members/${x.id}/events`);
    return {
      requests, createRequests,
      threadId, deliveryId: msgs.find((m) => m.id === msgId)?.deliveries[0]?.id, seconds, woken, lockAfterCreate, lockWhileHeld,
      delivery: msgs.find((m) => m.id === msgId)?.deliveries[0],
      fromX: msgs.filter((m) => m.from === x.id).map((m) => m.body),
      clientIds: turns.data.flatMap((t: any) => t.items.filter((i: any) => i.type === 'userMessage').map((i: any) => [i.clientId, t.status])),
      texts: events.filter((e: any) => e.kind === 'agent').map((e: any) => e.payload.event),
      userAgent: spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    };
  } finally {
    for (const c of cleanup.reverse()) await c();
  }
}

test('codex native live: model/list of the backend lists models with their efforts (throwaway CODEX_HOME, no model call)', { skip: LIVE, timeout: 60_000 }, async (t) => {
  const home = join(tmpdir(), 'orrery-sandbox', `codex-models-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const bin = codexBinary();
  const adapter = createCodexNativeAdapter({
    codexHome: home,
    launch: () => {
      const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
      return {
        stdin: child.stdin, stdout: child.stdout, kill: () => void child.kill(),
        onExit: (cb) => { child.once('error', (e) => cb(e.message)); child.once('exit', (code) => cb(`exited (${code})`)); },
      };
    },
  });
  try {
    const models = await adapter.listModels!();
    t.diagnostic(models.map((m) => `${m.id}${m.isDefault ? '*' : ''} [${m.efforts.join(',')}]`).join('; '));
    assert.ok(models.length > 0, 'some models');
    assert.ok(models.every((m) => typeof m.id === 'string' && m.id && Array.isArray(m.efforts) && m.efforts.every((e) => typeof e === 'string')));
    assert.ok(models.filter((m) => m.isDefault).length <= 1);
  } finally {
    await adapter.close!();
    for (let i = 0; ; i++) {
      try { rmSync(home, { recursive: true, force: true }); break; } catch (e) { if (i >= 40) throw e; await tick(250); }
    }
  }
});

test('codex native live: the app holds the thread → queued, run by the app, completed, and send_message is attributed by _meta.threadId', { skip: LIVE, timeout: 180_000 }, async (t) => {
  const r = await liveNative('held');
  t.diagnostic(`${r.userAgent}; delivered in ${r.seconds}s; clientIds ${JSON.stringify(r.clientIds)}`);
  assert.equal(r.lockAfterCreate.state, 'unknown', 'a readable or missing lock does not identify the desktop home');
  assert.equal(r.createRequests, 0, 'nothing chosen: no init turn');
  assert.deepEqual([...new Set(r.requests.map((x) => `${x.init} ${x.model}/${x.effort}`))], ['false gpt-6-astra/low'], 'the home default runs the queued turn');
  assert.deepEqual(r.lockWhileHeld, { state: 'held' }, 'a loaded thread reads as locked (EBUSY)');
  assert.equal(r.delivery.state, 'done', JSON.stringify(r.delivery));
  assert.deepEqual(r.woken, [`codex://threads/wake/${r.threadId}`], 'woken although the app holds the thread');
  assert.deepEqual(r.clientIds, [[r.deliveryId, 'completed']], 'the app ran exactly our queued message, tagged with the delivery id');
  assert.deepEqual(r.fromX, ['hello from codex'], 'the Hub knew which member called send_message');
  assert.deepEqual(r.texts, [{ type: 'text', text: 'done' }]);
});

test('codex native live: nobody holds the thread → the wake link loads it, then the same as above', { skip: LIVE, timeout: 180_000 }, async (t) => {
  const r = await liveNative('wake');
  t.diagnostic(`${r.userAgent}; delivered in ${r.seconds}s`);
  assert.deepEqual(r.woken, [`codex://threads/wake/${r.threadId}`]);
  assert.equal(r.delivery.state, 'done', JSON.stringify(r.delivery));
  assert.deepEqual(r.clientIds, [[r.deliveryId, 'completed']]);
  assert.deepEqual(r.fromX, ['hello from codex']);
});

test('codex native: a failure before the app took the message also takes it out of the queue', async () => {
  const { fake, adapter, deliver } = setup();
  const orig = fake.handle.bind(fake);
  fake.handle = (m) => {
    if (m.method === 'thread/turns/list' && fake.params('thread/queue/add').length) throw new Error('disk on fire');
    return orig(m);
  };
  const broken = await deliver('d-broken').p;
  assert.equal(typeof broken === 'object' && broken.outcome, 'unknown');
  assert.match(typeof broken === 'object' ? broken.error : '', /disk on fire/);
  assert.deepEqual(fake.queue.get(T1), [], 'a delivery the Hub marks failed never runs later');
  await adapter.close!();
});

test('codex native: an app-server that ignores the closed stdin is killed', async () => {
  const fake = new FakeCodex();
  const adapter = createCodexNativeAdapter({
    launch: () => {
      const p = fake.launch();
      return { ...p, stdin: new Writable({ write: (c, e, cb) => p.stdin.write(c, e, cb) }) };   // end() never reaches it
    },
  });
  fake.threads = [{ id: T1, preview: '', model: 'm', cwd: CWD, name: 'x', updatedAt: 0 }];
  await adapter.attachSession(T1);
  assert.equal(fake.kills, 1);
  assert.equal(fake.alive, 0);
  await adapter.close!();
});

// ---- review round 1 (P2) ----

test('codex native: dedup reads the queue first, so an item picked up between the two reads is not queued again', async () => {
  const { fake, adapter, deliver } = setup();
  fake.queue.set(T1, [{ id: 'q-old', input: [], clientUserMessageId: 'd-race' }]);
  const orig = fake.handle.bind(fake);
  let first = true;
  fake.handle = (m) => {
    const r = orig(m);
    // The app takes the item right after orrery's first read of the thread, whichever read that is.
    if (first && (m.method === 'thread/turns/list' || m.method === 'thread/queue/list')) { first = false; fake.pickUp(T1, 'completed', 'once'); }
    return r;
  };
  const { p } = deliver('d-race');
  assert.equal(await p, 'completed');
  assert.equal(fake.params('thread/queue/add').length, 0, 'not queued a second time');
  await adapter.close!();
});

test('codex native: an abort that lands while the process starts still ends the operation (no hang)', async () => {
  const fake = new FakeCodex();
  fake.mute = true;   // a hung app-server: only the abort can end the wait
  const ac = new AbortController();
  const adapter = createCodexNativeAdapter({
    launch: () => { const p = fake.launch(); ac.abort(); return p; },
    lockHeld: () => ({ state: 'held' }), openWake: () => {}, opTimeoutMs: 200, exitWaitMs: 20,
  });
  opened.push(adapter);
  const p = adapter.deliver(T1, 'x', { deliveryId: 'd-abort-race', bridge: NO_BRIDGE, onEvent: () => {}, signal: ac.signal });
  const outcome = await Promise.race([p.then(() => 'resolved', (e: Error) => e.message), tick(2_000).then(() => 'hung')]);
  assert.match(outcome, /^delivery aborted/);
  await adapter.close!();
});

test('codex native: an aborted signal never starts a process', async () => {
  const fake = new FakeCodex();
  const ac = new AbortController();
  ac.abort();
  const adapter = createCodexNativeAdapter({ launch: fake.launch, lockHeld: () => ({ state: 'held' }), openWake: () => {}, exitWaitMs: 20 });
  await assert.rejects(adapter.deliver(T1, 'x', { deliveryId: 'd', bridge: NO_BRIDGE, onEvent: () => {}, signal: ac.signal }), /aborted/);
  // Only the clean-up (no signal) may have started one.
  assert.ok(fake.sent.every((m) => m.method !== 'thread/queue/add'));
  await adapter.close!();
});

test('codex native: the slot is freed only after the process has exited, so maxProcesses=1 means one alive', async () => {
  const fake = new FakeCodex();
  fake.threads = [{ id: T1, preview: '', model: 'm', cwd: CWD, name: 'x', updatedAt: 0 }];
  const adapter = createCodexNativeAdapter({
    maxProcesses: 1, exitWaitMs: 50,
    launch: () => {
      const p = fake.launch();
      // Ignores the closed stdin, and takes a while to die after a kill.
      return { ...p, stdin: new Writable({ write: (c, e, cb) => p.stdin.write(c, e, cb) }), kill: () => { setTimeout(() => p.kill(), 10); } };
    },
  });
  opened.push(adapter);
  await Promise.all([adapter.attachSession(T1), adapter.attachSession(T1), adapter.attachSession(T1)]);
  assert.equal(fake.launches, 3);
  assert.equal(fake.maxAlive, 1);
  await adapter.close!();
});

test('codex native: when taking the message back out of the queue fails too, the rejection says it may still run', async () => {
  const { fake, adapter, deliver } = setup();
  const orig = fake.handle.bind(fake);
  fake.handle = (m) => {
    if (m.method === 'thread/turns/list' && fake.params('thread/queue/add').length) throw new Error('disk on fire');
    if (m.method === 'thread/queue/delete') throw new Error('queue locked');
    return orig(m);
  };
  const stuck = await deliver('d-stuck').p;
  assert.equal(typeof stuck === 'object' && stuck.outcome, 'unknown');
  assert.match(typeof stuck === 'object' ? stuck.error : '', /disk on fire; taking it out of the Codex queue failed, so it may still run: .*queue locked/);
  await adapter.close!();
});

test('codex native live: a model and effort chosen at creation are what the queued turn in the app runs with (init turn)', { skip: LIVE, timeout: 180_000 }, async (t) => {
  const r = await liveNative('held', { model: 'gpt-6.1-sol', effort: 'high' });
  t.diagnostic(`requests: ${JSON.stringify(r.requests)}`);
  assert.equal(r.lockAfterCreate.state, 'unknown', 'a readable or missing lock does not identify the desktop home');
  assert.ok(r.createRequests >= 1 && r.requests.slice(0, r.createRequests).every((x) => x.init), 'createSession ran the init turn');
  assert.deepEqual(r.texts.length, 1);
  const queued = r.requests.slice(r.createRequests);
  assert.ok(queued.length >= 1 && queued.every((x) => !x.init));
  assert.deepEqual([...new Set(r.requests.map((x) => `${x.model}/${x.effort}`))], ['gpt-6.1-sol/high'], 'never the home default gpt-6-astra/low');
  assert.equal(r.delivery.state, 'done', JSON.stringify(r.delivery));
  assert.deepEqual(r.fromX, ['hello from codex']);
});


test('codex native usage: a completed turn reports its tokens from the rollout (waiting while it lags); quota from rollouts or app-server', async () => {
  const home = join(tempDir(), 'codex-home');
  const day = join(home, 'sessions', '2026', '11', '03');
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-11-03T12-00-00-${T1}.jsonl`);
  writeFileSync(rollout, JSON.stringify({ timestamp: '2026-11-03T12:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 20, window_minutes: 10080, resets_at: 1793802577 }, secondary: null } } }) + '\n');
  const { fake, adapter } = setup({ codexHome: home, usageRetryMs: 20, usageTries: 50 });
  const used: unknown[] = [];
  const p = adapter.deliver(T1, 'hi', { deliveryId: 'd-u', bridge: NO_BRIDGE, onEvent: () => {}, signal: new AbortController().signal, usage: (t) => used.push(t) });
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  const turn = fake.pickUp(T1, 'completed');
  // The rollout line arrives a little after the turn shows as completed.
  setTimeout(() => appendFileSync(rollout, JSON.stringify({ type: 'token_usage_record', payload: { turn_id: turn.id,
    turn_token_usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 10 } } }) + '\n'), 100);
  assert.equal(await p, 'completed');
  assert.deepEqual(used, [{ input: 200, cachedInput: 800, cacheWrite: 0, output: 30, reasoning: 10 }]);

  assert.deepEqual((await adapter.quota!({ refresh: false }))!.windows.map((w) => [w.label, w.usedPercent]), [['每周', 20]]);
  const before = fake.launches;
  const base = fake.handle.bind(fake);
  fake.handle = (m) => (m.method === 'account/rateLimits/read'
    ? { rateLimits: { limitId: 'codex', primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1793700000 }, secondary: null, planType: 'plus' } }
    : base(m));
  const fresh = (await adapter.quota!({ refresh: true }))!;
  assert.deepEqual([fresh.source, fresh.plan, fresh.windows.map((w) => [w.id, w.label, w.usedPercent])], ['app-server', 'plus', [['primary', '5 小时', 33]]]);
  assert.equal(fake.launches, before + 1, 'one short-lived app-server');
  assert.deepEqual(fake.methods().slice(-1), ['account/rateLimits/read']);
  await until(() => fake.alive === 0, 'the app-server exited');
  await adapter.close!();
});

test('codex native usage: a failed turn still reports the tokens its rollout records (review usage r1, P2-1)', async () => {
  const home = join(tempDir(), 'codex-home');
  const day = join(home, 'sessions', '2026', '11', '05');
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-11-05T12-00-00-${T1}.jsonl`);
  writeFileSync(rollout, '');
  const { fake, adapter } = setup({ codexHome: home, usageRetryMs: 20, usageTries: 50 });
  const used: unknown[] = [];
  const p = adapter.deliver(T1, 'hi', { deliveryId: 'd-f', bridge: NO_BRIDGE, onEvent: () => {}, signal: new AbortController().signal, usage: (t) => used.push(t) });
  await until(() => (fake.queue.get(T1) ?? []).length === 1, 'queued');
  const turn = fake.pickUp(T1, 'failed');
  appendFileSync(rollout, JSON.stringify({ type: 'token_usage_record', payload: { turn_id: turn.id,
    turn_token_usage: { input_tokens: 123, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } } }) + '\n');
  const failed = await p;
  assert.equal(typeof failed === 'object' && failed.outcome, 'failed');
  assert.match(typeof failed === 'object' ? failed.error : '', /codex turn failed/);
  assert.deepEqual(used, [{ input: 103, cachedInput: 20, cacheWrite: 0, output: 7, reasoning: 0 }]);
  await adapter.close!();
});
