// The hop limit setting (docs/hop-limit.md「测试和验收」items 1–9): default, precedence, finite and unlimited values,
// strict input, the other loop guards under unlimited, store failures, request checks and the unchanged MCP tools.
// Temp homes and databases, port 0, mock workers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { REPO_ROOT } from '../src/main.ts';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { defaultScript, type MockScript } from './mock.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import type { HubEvent } from '../src/core/types.ts';
import { fakeCursor, fakeCursorAdapter } from './cursor-fake.ts';
import { bearer, startTestHub, tempDir, TEST_TOKEN, waitFor, type TestHub } from './helpers.ts';

const finite = (value: number) => ({ kind: 'finite', value });
const UNLIMITED = { kind: 'unlimited' };
/** The hop limit's part of GET /api/settings (the per-chain turn limit is test/chain-limit.test.ts's). */
const hopsOf = (s: any) => ({ maxHops: s.maxHops, source: s.source });

// Both members answer every ping with another ping, forever (as in hub.test.ts).
const pingBack: MockScript = async (msg, tools, emit, signal) => {
  const body = msg.body.replace(/^@\S+\s+/, '');
  if (!body.startsWith('ping ')) return defaultScript(msg, tools, emit, signal);
  const r = await tools.send(`@${msg.from} ${body}`, msg.messageId);
  if (r.isError) emit({ type: 'error', message: r.text });
};

/** Raw HTTP so a test controls every header; resolves status and parsed body (or raw text). */
function raw(url: string, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; data: any }>((ok, fail) => {
    const req = request(url + path, { method, headers: { ...bearer(TEST_TOKEN), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data: any = text;
        try { data = JSON.parse(text); } catch { /* not JSON */ }
        ok({ status: res.statusCode!, data });
      });
    });
    req.on('error', fail);
    req.end(body);
  });
}

const patch = (app: TestHub, body: unknown) =>
  raw(app.url, 'PATCH', '/api/settings', { 'content-type': 'application/json' }, typeof body === 'string' ? body : JSON.stringify(body));

const settingsEvents = (events: HubEvent[]) => events.filter((e) => e.kind === 'settings').map((e) => e.payload);
const hopGuards = (events: HubEvent[]) => events.filter((e) => e.kind === 'guard' && (e.payload as any).reason === 'max_hops').map((e) => e.payload as any);
const savedRow = (app: TestHub) => (app.store.db.prepare("SELECT value FROM settings WHERE key = 'max_hops'").get() as any)?.value ?? null;

/**
 * A whole ping-pong chain (up to 20 deliveries) takes 3-4 s alone and longer under the full parallel suite, so the
 * default 5 s wait timed out there. It still waits for the guard itself; only the ceiling is wider.
 */
const CHAIN_TIMEOUT_MS = 30_000;

/** Starts a ping-pong chain and waits until it stops; returns the hops of its messages. */
async function runChain(app: TestHub, clusterId: string, nonce: string): Promise<{ chainId: string; hops: number[] }> {
  const start = await app.api('POST', `/api/clusters/${clusterId}/messages`, { body: `@A relay B ${nonce}` });
  await waitFor(() => app.events.some((e) => e.kind === 'guard' && (e.payload as any).chainId === start.id), `guard on chain ${nonce}`, CHAIN_TIMEOUT_MS);
  await waitFor(() => app.settled(clusterId), `chain ${nonce} settled`, CHAIN_TIMEOUT_MS);
  const msgs = (await app.messages(clusterId)).filter((m) => m.chainId === start.id);
  return { chainId: start.id, hops: msgs.map((m) => m.hop) };
}

const range = (n: number) => Array.from({ length: n + 1 }, (_, i) => i);

test('hop 1: a new database and a migrated v6 database both default to 6; hop 6 passes, hop 7 is rejected', async () => {
  const app = await startTestHub({ mock: { script: pingBack } });
  try {
    const defaults = { maxHops: finite(6), source: 'default', maxTurnsPerChain: finite(20), maxTurnsPerChainSource: 'default',
      stalledMemberMinutes: 30, stalledMemberMinutesSource: 'default', usageAlert: { turnTokens: 20_000_000, conversationTokens: 200_000_000 }, clusterGroups: [] };
    assert.deepEqual(await app.api('GET', '/api/settings'), defaults);
    assert.deepEqual((await app.api('GET', '/api/state')).settings, defaults);
    const { cluster } = await app.cluster('c', ['A', 'B']);
    const chain = await runChain(app, cluster.id, 'n1');
    assert.deepEqual(chain.hops, range(6));
    assert.deepEqual(hopGuards(app.events), [{ reason: 'max_hops', chainId: chain.chainId, hop: 7, maxHops: 6 }]);
  } finally {
    await app.close();
  }

  // A v6 database (no settings table) with history: migrated, history kept, still 6 by default.
  const dir = tempDir();
  const path = join(dir, 'test.db');
  const old = new Store(path);
  old.insertCluster({ id: 'c-old', name: 'old', createdAt: '2026-01-01T00:00:00.000Z', category: '' }, []);
  old.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE IF EXISTS collaboration_records; DROP TABLE IF EXISTS collaboration_links; DROP TABLE collaboration_operations; DROP TABLE collaboration_policies; DROP TABLE collaboration_member_roles; DROP TABLE collaboration_roles; DROP TABLE IF EXISTS collaboration_tasks; DROP INDEX IF EXISTS messages_plugin_rate; ALTER TABLE messages DROP COLUMN kind; ALTER TABLE messages DROP COLUMN collab_event_id; ALTER TABLE clusters DROP COLUMN deleted_at');
  db.exec('ALTER TABLE clusters DROP COLUMN pinned_at; ALTER TABLE clusters DROP COLUMN archived_at; ALTER TABLE clusters DROP COLUMN user_read_message_id');
  db.exec('DROP INDEX messages_client_id; ALTER TABLE messages DROP COLUMN client_message_id; ALTER TABLE messages DROP COLUMN task_stamp_json; ALTER TABLE messages DROP COLUMN fyi; DROP TRIGGER deliveries_state_seq_insert; DROP TRIGGER deliveries_state_seq_update; ALTER TABLE deliveries DROP COLUMN state_seq; ALTER TABLE deliveries DROP COLUMN dismissed_at; ALTER TABLE reads DROP COLUMN seen_at; ALTER TABLE members DROP COLUMN hidden_at; ALTER TABLE members DROP COLUMN unread_after_rowid; ALTER TABLE messages DROP COLUMN system_kind; ALTER TABLE messages DROP COLUMN explicit_mentions_json; ALTER TABLE deliveries DROP COLUMN queue_warned; DROP TABLE message_acknowledgements; DROP TABLE settings; DROP TABLE message_files; DROP TABLE files; ALTER TABLE deliveries DROP COLUMN outcome; ALTER TABLE deliveries DROP COLUMN handoff_message_id; ALTER TABLE deliveries DROP COLUMN reported; ALTER TABLE clusters DROP COLUMN category; PRAGMA user_version = 6');
  db.close();
  const migrated = await startTestHub({ dir });
  try {
    assert.equal((migrated.store.db.prepare('PRAGMA user_version').get() as any).user_version, 30);
    assert.deepEqual(hopsOf(await migrated.api('GET', '/api/settings')), { maxHops: finite(6), source: 'default' });
    assert.deepEqual((await migrated.api('GET', '/api/state')).clusters.map((c: any) => c.id), ['c-old']);
  } finally {
    await migrated.close();
  }
});

// A Windows restart checks the registry, hubs directory, and existing key in separate PowerShell calls, each up to 8 s.
const CLI_START_TIMEOUT_MS = 30_000;

/** `node src/main.ts` (what `npm start` runs) with its own temp data and the given ORRERY_MAX_HOPS. */
async function spawnHub(dir: string, maxHops: string) {
  const home = join(dir, 'home');
  const registry = join(dir, 'registry');
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ORRERY_PORT: '0', ORRERY_HOME: home, ORRERY_DB: join(dir, 'h.db'), ORRERY_REGISTRY: registry,
      ORRERY_MAX_HOPS: maxHops, ORRERY_API_TOKEN: TEST_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exitReason: string | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-4096); });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  child.once('error', (error) => { exitReason = `could not spawn test Hub: ${error.message}`; });
  const closed = new Promise<void>((resolve) => child.once('close', (code, signal) => {
    exitReason ??= `test Hub exited with ${signal ? `signal ${signal}` : `code ${code}`} before ready`;
    resolve();
  }));
  try {
    const url = await waitFor(() => {
      if (exitReason) throw new Error(exitReason);
      return /listening on (http:\S+)/.exec(stdout)?.[1];
    }, `test Hub to start within ${CLI_START_TIMEOUT_MS} ms`, CLI_START_TIMEOUT_MS);
    return {
      url,
      async stop() {
        await raw(url, 'POST', '/api/shutdown', { 'content-type': 'application/json' }, '{}');
        await closed;
      },
    };
  } catch (e) {
    const markers = ['home', 'registry/hubs', 'registry/lock', 'registry/active.json', 'home/hub.json']
      .filter((path) => existsSync(join(dir, path)));
    child.kill();
    await closed;
    throw new Error(`${(e as Error).message}\nStartup paths present: ${markers.join(', ') || '(none)'}\n`
      + `stdout: ${stdout.trim() || '(empty)'}\nstderr: ${stderr.trim() || '(empty)'}`, { cause: e });
  }
}

test('hop 2: a CLI startup error reports the exit and stderr', async () => {
  await assert.rejects(spawnHub(tempDir(), 'invalid'), /test Hub exited with code 1 before ready[\s\S]*stderr:[\s\S]*ORRERY_MAX_HOPS/);
});

test('hop 2: ORRERY_MAX_HOPS applies until a value is saved; after a restart with the same variable the saved value wins', async () => {
  const dir = tempDir();
  const first = await spawnHub(dir, '3');
  try {
    assert.deepEqual(hopsOf((await raw(first.url, 'GET', '/api/settings', {})).data), { maxHops: finite(3), source: 'startup' });
    const saved = await raw(first.url, 'PATCH', '/api/settings', { 'content-type': 'application/json' }, JSON.stringify({ maxHops: finite(8) }));
    assert.deepEqual([saved.status, hopsOf(saved.data)], [200, { maxHops: finite(8), source: 'saved' }]);
  } finally {
    await first.stop();
  }
  const second = await spawnHub(dir, '3');
  try {
    assert.deepEqual(hopsOf((await raw(second.url, 'GET', '/api/settings', {})).data), { maxHops: finite(8), source: 'saved' });
    assert.deepEqual(hopsOf((await raw(second.url, 'GET', '/api/state', {})).data.settings), { maxHops: finite(8), source: 'saved' });
  } finally {
    await second.stop();
  }
});

test('hop 3: saving 0 rejects every hop 1; saving 10 lets hop 10 through and rejects hop 11; later messages use the new value', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerChain: 100 }, mock: { script: pingBack } });
  try {
    const { cluster } = await app.cluster('c', ['A', 'B']);
    assert.deepEqual(hopsOf((await patch(app, { maxHops: finite(0) })).data), { maxHops: finite(0), source: 'saved' });
    const zero = await runChain(app, cluster.id, 'z');
    assert.deepEqual(zero.hops, [0]);
    assert.deepEqual(hopGuards(app.events).at(-1), { reason: 'max_hops', chainId: zero.chainId, hop: 1, maxHops: 0 });

    assert.deepEqual(hopsOf((await patch(app, { maxHops: finite(10) })).data), { maxHops: finite(10), source: 'saved' });
    const ten = await runChain(app, cluster.id, 't');
    assert.deepEqual(ten.hops, range(10));
    assert.deepEqual(hopGuards(app.events).at(-1), { reason: 'max_hops', chainId: ten.chainId, hop: 11, maxHops: 10 });
    assert.deepEqual(settingsEvents(app.events), [{ maxHops: finite(0), source: 'saved' }, { maxHops: finite(10), source: 'saved' }]);
  } finally {
    await app.close();
  }
});

test('hop 4: every malformed value is a 400 that changes neither the database nor memory', async () => {
  const app = await startTestHub();
  try {
    assert.equal((await patch(app, { maxHops: finite(4) })).status, 200);
    const bad: unknown[] = [
      { maxHops: finite(-1) }, { maxHops: finite(1.5) }, { maxHops: { kind: 'finite', value: '6' } }, { maxHops: { kind: 'finite', value: '' } },
      { maxHops: { kind: 'finite', value: null } }, { maxHops: { kind: 'finite', value: 'NaN' } }, { maxHops: { kind: 'finite' } },
      { maxHops: finite(2 ** 53) }, { maxHops: { kind: 'finite', value: 6, extra: 1 } }, { maxHops: finite(6), extra: 1 },
      { maxHops: finite(6), confirmUnlimited: true }, { maxHops: UNLIMITED }, { maxHops: UNLIMITED, confirmUnlimited: false },
      { maxHops: UNLIMITED, confirmUnlimited: 'true' }, { maxHops: UNLIMITED, confirmUnlimited: 1 }, { maxHops: UNLIMITED, confirmUnlimited: null },
      { maxHops: { kind: 'unlimited', value: 0 }, confirmUnlimited: true }, { maxHops: UNLIMITED, confirmUnlimited: true, extra: 1 },
      { maxHops: null }, { maxHops: 6 }, { maxHops: '6' }, { maxHops: '' }, { maxHops: 'unlimited' }, { maxHops: { kind: 'infinite' } },
      { maxHops: [] }, {}, { confirmUnlimited: true }, '[]', '6', 'null', '"x"', 'not json',
    ];
    for (const body of bad) {
      const res = await patch(app, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    // Values JSON cannot carry, straight at the Hub.
    for (const input of [finite(NaN), finite(Infinity), finite(-Infinity), null, undefined, 4, Infinity]) {
      assert.throws(() => app.hub.setLimit('maxHops', input), /maxHops must be/, String(input));
    }
    for (const confirmUnlimited of [undefined, false, 'true', 1]) {
      assert.throws(() => app.hub.setLimit('maxHops', UNLIMITED, { confirmUnlimited }), /confirmUnlimited: true/);
    }
    assert.deepEqual(app.hub.getLimit('maxHops'), { limit: finite(4), source: 'saved' });
    assert.deepEqual(hopsOf(await app.api('GET', '/api/settings')), { maxHops: finite(4), source: 'saved' });
    assert.equal(savedRow(app), '{"kind":"finite","value":4}');
    assert.equal(settingsEvents(app.events).length, 1);
  } finally {
    await app.close();
  }
});

test('hop 5: unlimited (confirmed) lets chains past hop 7 with hops still counted; it survives a restart; back to 6 rejects hop 7 again', async () => {
  const limits = { maxTurnsPerChain: 12 };
  const app = await startTestHub({ limits, mock: { script: pingBack } });
  let clusterId = '';
  try {
    const res = await patch(app, { maxHops: UNLIMITED, confirmUnlimited: true });
    assert.deepEqual([res.status, hopsOf(res.data)], [200, { maxHops: UNLIMITED, source: 'saved' }]);
    assert.deepEqual(settingsEvents(app.events), [{ maxHops: UNLIMITED, source: 'saved' }]);
    assert.equal(savedRow(app), '{"kind":"unlimited"}');
    const { cluster } = await app.cluster('c', ['A', 'B']);
    clusterId = cluster.id;
    // The chain runs until the chain turn limit (12 turns) stops it, not the hop limit.
    const chain = await runChain(app, cluster.id, 'u');
    assert.deepEqual(chain.hops, range(12), 'hop is computed and stored as always');
    assert.deepEqual(hopGuards(app.events), []);
    const guard = app.events.find((e) => e.kind === 'guard')!.payload as any;
    assert.deepEqual([guard.reason, guard.chainId], ['max_turns_per_chain', chain.chainId]);
    const last = (await app.messages(cluster.id)).at(-1)!;
    assert.deepEqual([last.hop, last.deliveries[0].state, last.deliveries[0].error], [12, 'failed', '链轮次超限']);
  } finally {
    await app.close();
  }

  const again = await startTestHub({ dir: app.dir, limits, mock: { script: pingBack } });
  try {
    assert.deepEqual(hopsOf(await again.api('GET', '/api/settings')), { maxHops: UNLIMITED, source: 'saved' });
    assert.deepEqual(hopsOf((await patch(again, { maxHops: finite(6) })).data), { maxHops: finite(6), source: 'saved' });
    const chain = await runChain(again, clusterId, 's');
    assert.deepEqual(chain.hops, range(6));
    assert.deepEqual(hopGuards(again.events), [{ reason: 'max_hops', chainId: chain.chainId, hop: 7, maxHops: 6 }]);
    assert.equal(typeof hopGuards(again.events)[0].maxHops, 'number');
  } finally {
    await again.close();
  }
});

test('hop 6: under unlimited the hourly limit and pause still hold', async () => {
  const app = await startTestHub({ limits: { maxTurnsPerHour: 2, recheckMs: 30 } });
  try {
    assert.equal((await patch(app, { maxHops: UNLIMITED, confirmUnlimited: true })).status, 200);
    const { cluster } = await app.cluster('c', ['A']);
    // Pause: nothing starts while paused.
    await app.api('POST', '/api/pause', { paused: true });
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hello 1' });
    await sleep(150);
    assert.deepEqual((await app.messages(cluster.id)).map((m) => m.deliveries[0].state), ['queued']);
    assert.ok(!app.events.some((e) => e.kind === 'delivery' && (e.payload as any).delivery.state === 'running'));
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => app.settled(cluster.id), 'delivered after resume');
    // Hourly limit (2): the third turn waits with a guard event.
    for (const n of [2, 3]) await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: `@A hello ${n}` });
    await sleep(300);
    assert.deepEqual((await app.messages(cluster.id)).map((m) => m.deliveries[0].state), ['done', 'done', 'queued']);
    assert.deepEqual(app.events.filter((e) => e.kind === 'guard').map((e) => (e.payload as any).reason), ['max_turns_per_hour']);
  } finally {
    await app.close();
  }
});

test('hop 6: under unlimited an offline member\'s message ends offline and is never sent later', async () => {
  const dir = tempDir();
  const native = createMockNativeAdapter({ sessions: [{ id: 's1', title: 's1', model: null, cwd: dir, updatedAt: null }] });
  let online = false;
  native.isOnline = () => online;
  const store = new Store(':memory:');
  const hub = new Hub({ store, nativeAdapters: { mock: native }, limits: { startupGraceMs: 0 } });
  try {
    hub.start();
    hub.setLimit('maxHops', UNLIMITED, { confirmUnlimited: true });
    const { cluster, members: [a] } = await hub.createCluster('c', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const m = hub.sendFromUser(cluster.id, '@A hi');
    const delivery = () => store.withDeliveries([store.getMessage(m.id)!])[0].deliveries[0];
    assert.deepEqual([delivery().memberId, delivery().state], [a.id, 'offline']);
    online = true;
    hub.connectBridge('mock', 's1', { send: (e) => setImmediate(() => hub.ackBridge(e.deliveryId, true)), close: () => {} });
    await sleep(30);
    assert.equal(native.delivered.length, 0, 'not sent once the member is back');
    assert.equal(delivery().state, 'offline');
  } finally {
    await hub.close();
    store.close();
  }
});

test('hop 6: switching to unlimited rewrites no history, leaves queued deliveries as they were and retries no rejected message', async () => {
  const app = await startTestHub({ limits: { maxHops: 1 }, mock: { script: pingBack } });
  try {
    const { cluster } = await app.cluster('c', ['A', 'B']);
    const old = await runChain(app, cluster.id, 'old');
    assert.deepEqual(old.hops, [0, 1], 'hop 2 was rejected');
    await app.api('POST', '/api/pause', { paused: true });
    const queued = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hello' });
    const rows = () => app.store.db.prepare('SELECT m.id, m.chain_id, m.hop, d.id AS d, d.state, d.attempts, d.updated_at FROM messages m LEFT JOIN deliveries d ON d.message_id = m.id ORDER BY m.rowid, d.rowid').all().map((r) => ({ ...r }));
    const before = rows();

    assert.equal((await patch(app, { maxHops: UNLIMITED, confirmUnlimited: true })).status, 200);
    await sleep(100);
    assert.deepEqual(rows(), before, 'no message or delivery was rewritten, and the rejected hop 2 was not retried');
    await app.api('POST', '/api/pause', { paused: false });
    await waitFor(() => app.settled(cluster.id), 'the queued delivery runs as arranged');
    const after = await app.messages(cluster.id);
    assert.deepEqual(after.filter((m) => m.chainId === old.chainId).map((m) => m.hop), [0, 1], 'the old chain did not continue');
    const q = after.find((m) => m.id === queued.id)!;
    assert.deepEqual([q.deliveries.length, q.deliveries[0].id, q.deliveries[0].state], [1, before.find((r) => r.id === queued.id)!.d, 'done']);
    assert.equal(after.length, before.length, 'nothing replayed');
  } finally {
    await app.close();
  }
});

test('hop 7: a failing store write leaves memory, GET and the database unchanged, and sends no event', async () => {
  const app = await startTestHub();
  try {
    assert.equal((await patch(app, { maxHops: finite(5) })).status, 200);
    const eventsBefore = app.store.listEvents(0).length;
    const { setLimit, appendEvent } = app.store;

    app.store.setLimit = () => { throw new Error('disk full'); };
    const failed = await patch(app, { maxHops: finite(9) });
    assert.notEqual(failed.status, 200);
    assert.match(failed.data.error, /disk full/);
    assert.throws(() => app.hub.setLimit('maxHops', UNLIMITED, { confirmUnlimited: true }), /disk full/);
    app.store.setLimit = setLimit;

    // The event write failing rolls the setting back too.
    app.store.appendEvent = function (this: Store, ...args: Parameters<Store['appendEvent']>) {
      if (args[2] === 'settings') throw new Error('events full');
      return appendEvent.apply(this, args);
    };
    assert.notEqual((await patch(app, { maxHops: finite(9) })).status, 200);
    app.store.appendEvent = appendEvent;

    assert.deepEqual(app.hub.getLimit('maxHops'), { limit: finite(5), source: 'saved' });
    assert.deepEqual(hopsOf(await app.api('GET', '/api/settings')), { maxHops: finite(5), source: 'saved' });
    assert.equal(savedRow(app), '{"kind":"finite","value":5}');
    assert.equal(app.store.listEvents(0).length, eventsBefore);
    assert.equal(settingsEvents(app.events).length, 1);
  } finally {
    await app.close();
  }
});

test('hop 7: a malformed saved value stops the Hub from starting, naming the setting', async () => {
  const dir = tempDir();
  const store = new Store(join(dir, 'test.db'));
  store.db.prepare("INSERT INTO settings (key, value) VALUES ('max_hops', ?)").run('{"kind":"finite","value":-3}');
  store.close();
  await assert.rejects(startTestHub({ dir }), /saved setting max_hops is invalid/);
  // Nor does a start-up value that is no safe integer become one.
  const mem = new Store(':memory:');
  try {
    assert.throws(() => new Hub({ store: mem, nativeAdapters: {}, limits: { maxHops: 2 ** 53 } }), /ORRERY_MAX_HOPS/);
  } finally {
    mem.close();
  }
});

test('hop 8: cross-site Origin, wrong Host, non-JSON and form PATCHes are refused and change nothing', async () => {
  const app = await startTestHub();
  try {
    const host = `127.0.0.1:${new URL(app.url).port}`;
    const body = JSON.stringify({ maxHops: UNLIMITED, confirmUnlimited: true });
    const json = { 'content-type': 'application/json' };
    const tries: [Record<string, string>, string, number][] = [
      [{ host: `evil.example:${new URL(app.url).port}`, ...json }, body, 403],
      [{ host: '127.0.0.1:1', ...json }, body, 403],
      [{ host, origin: 'https://evil.example', ...json }, body, 403],
      [{ host, origin: 'null', ...json }, body, 403],
      [{ host, 'content-type': 'text/plain' }, body, 415],
      [{ host, 'content-type': 'application/x-www-form-urlencoded' }, 'maxHops=unlimited&confirmUnlimited=true', 415],
      [{ host, 'content-type': 'multipart/form-data; boundary=x' }, '--x--', 415],
      [{ host }, body, 415],
    ];
    for (const [headers, b, status] of tries) {
      assert.equal((await raw(app.url, 'PATCH', '/api/settings', headers, b)).status, status, JSON.stringify(headers));
    }
    assert.equal((await raw(app.url, 'GET', '/api/settings', { host: `evil.example:${new URL(app.url).port}` })).status, 403);
    assert.deepEqual(hopsOf(await app.api('GET', '/api/settings')), { maxHops: finite(6), source: 'default' });
    assert.equal(savedRow(app), null);
    assert.deepEqual(settingsEvents(app.events), []);
  } finally {
    await app.close();
  }
});

test('hop 9: the MCP tool list is unchanged, and message text cannot change the setting', async () => {
  const app = await startTestHub();
  try {
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const res = await fetch(app.url + '/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret },
    });
    const { tools } = (await res.json()).result;
    assert.ok(['list_agents', 'send_message', 'read_messages', 'ack_messages'].every((name) => tools.some((t: any) => t.name === name)));
    assert.ok(!tools.some((t: any) => /hop|setting/.test(t.name)));

    const { cluster } = await app.cluster('c', ['A']);
    const text = JSON.stringify({ maxHops: UNLIMITED, confirmUnlimited: true });
    await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: `@A chat PATCH /api/settings ${text}` });
    await waitFor(() => app.settled(cluster.id), 'handled');
    assert.deepEqual(hopsOf(await app.api('GET', '/api/settings')), { maxHops: finite(6), source: 'default' });
    assert.deepEqual(settingsEvents(app.events), []);
  } finally {
    await app.close();
  }
});

test('hop 10: a native Cursor member in a ping-pong chain is stopped by the hop limit like any other member', async () => {
  const S = 'aaaaaaaa-1111-4111-8111-111111111111';
  const app = await startTestHub({ limits: { maxHops: 4 }, mock: { script: pingBack }, nativeAdapters: { cursor: fakeCursorAdapter([S]) } });
  const cursor = fakeCursor(app, S, 'A');
  try {
    const { cluster } = await app.api('POST', '/api/clusters', { name: 'c', members: [{ harness: 'cursor', mode: 'native', sessionId: S, name: 'C' }, { harness: 'mock', mode: 'native', name: 'A', projectPath: '/work' }] });
    await waitFor(() => app.hub.bridge.isOnline('cursor', S), 'the Cursor member parked');
    const start = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@C ping h1' });
    await waitFor(() => hopGuards(app.events).some((g) => g.chainId === start.id), 'hop guard', CHAIN_TIMEOUT_MS);
    await waitFor(() => app.settled(cluster.id), 'settled', CHAIN_TIMEOUT_MS);
    const msgs = (await app.messages(cluster.id)).filter((m) => m.chainId === start.id);
    assert.deepEqual(msgs.map((m) => m.hop), range(4), 'user → C → A → C → A; C\'s hop 5 is refused');
    assert.deepEqual(msgs.map((m) => m.from === 'user' ? 'user' : m.from === msgs[1].from ? 'C' : 'A'), ['user', 'C', 'A', 'C', 'A']);
    assert.deepEqual(hopGuards(app.events), [{ reason: 'max_hops', chainId: start.id, hop: 5, maxHops: 4 }]);
    assert.ok(msgs.flatMap((m) => m.deliveries).every((d: any) => d.state === 'done'), 'every Cursor and mock delivery completed');
  } finally {
    await cursor.stop();
    await app.close();
  }
});
