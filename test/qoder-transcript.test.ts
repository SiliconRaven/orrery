// Reading a bound Qoder conversation (src/adapters/qoder/transcript.ts). Every database here is hand-written synthetic
// data shaped like Qoder's main.sqlite (tables chat_sessions and chat_session_messages, JSON parts in payload_json).
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { copyFileSync, linkSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createQoderNativeAdapter } from '../src/adapters/qoder/native.ts';
import { qoderTranscript, waitCommandSession, waitOutput } from '../src/adapters/qoder/transcript.ts';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { QODER_WAIT, type TranscriptItem } from '../src/core/types.ts';
import { ticketFor, waitCommand } from '../src/mcp/wait-core.ts';

const SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const DELETED = '00000000-0000-4000-8000-000000000003';
const SECRET = 'synthetic-bridge-secret';
const at = Date.parse('2026-01-02T12:00:00.000Z');
const startedAt = new Date(at).toISOString();

const commandFor = (session: string) => waitCommand(QODER_WAIT, ticketFor(QODER_WAIT, SECRET, session), 'http://127.0.0.1:4999');
/** What a whole-file Read returns: the printed text, lines numbered from 1. */
const numbered = (text: string) => text.replace(/\n$/, '').split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n');
const outputPath = (task: string) => `C:\\synthetic\\tasks\\${task}.output`;

let parts = 0;
const tool = (name: string, input: object, response?: string, extra: object = {}) =>
  ({ type: 'tool', id: `part_${++parts}`, tool: { id: `call_${parts}`, name, input, startedAt, completedAt: startedAt, status: 'completed',
    parentToolUseId: null, ...(response === undefined ? {} : { response }), ...extra } });
const text = (value: string) => ({ type: 'text', id: `part_${++parts}`, text: value, parentToolUseId: null });
const thinking = () => ({ type: 'thinking', id: `part_${++parts}`, text: 'private chain of thought', startedAt, status: 'completed' });
const hook = (event: string) => ({ type: 'hook', id: `part_${++parts}`, hook: { id: 'h', event, name: 'synthetic-hook.exe', status: 'succeeded', startedAt } });
/** A background shell command with task id `task`. */
const background = (task: string, command: string, inBackground = true) =>
  tool('Bash', { command, description: 'orrery：等群消息', run_in_background: inBackground }, `running in background, ID ${task}, output ${outputPath(task)}`, { taskId: task });
const read = (path: string, response: string, input: object = {}) => tool('Read', { file_path: path, ...input }, response);
const mcpCall = (toolName: string, response: string, status = 'completed') =>
  tool('mcp_call', { toolName, arguments: { clusterId: 'group', body: 'x' } }, response, { status });

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'orrery-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'main.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE chat_sessions(session_id TEXT PRIMARY KEY, session_kind TEXT NOT NULL DEFAULT 'standard', title TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0, deleted_at TIMESTAMP);
    CREATE TABLE chat_session_messages(session_id TEXT NOT NULL, message_id TEXT NOT NULL, turn_id TEXT, sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      role TEXT, subtype TEXT, PRIMARY KEY(session_id, message_id));
    CREATE UNIQUE INDEX chat_session_messages_sequence ON chat_session_messages(session_id, sequence);
    CREATE INDEX chat_session_messages_role_sequence ON chat_session_messages(session_id, role, sequence);`);
  db.prepare('INSERT INTO chat_sessions(session_id) VALUES (?), (?), (?)').run(SESSION, OTHER, DELETED);
  db.prepare('UPDATE chat_sessions SET deleted_at = 1 WHERE session_id = ?').run(DELETED);
  db.close();
  const write = (fn: (w: DatabaseSync) => void) => { const w = new DatabaseSync(file); try { fn(w); } finally { w.close(); } };
  const sequences = new Map<string, number>();
  /** One row; returns its message id. */
  const row = (role: string, rowParts: object[], o: { status?: string; task?: string; session?: string } = {}) => {
    const session = o.session ?? SESSION;
    const sequence = (sequences.get(session) ?? 0) + 1;
    sequences.set(session, sequence);
    const id = `msg-${session.slice(-4)}-${sequence}`;
    const payload = { parts: rowParts, ...(o.task ? { backgroundTaskId: o.task, responseKind: 'background-summary' } : {}) };
    write(w => w.prepare('INSERT INTO chat_session_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(session, id, `turn-${sequence}`,
      sequence, JSON.stringify(payload), o.status ?? 'completed', 'sdk-projection', at + sequence, at + sequence, role, role === 'system' ? 'hook_activity' : null));
    return id;
  };
  const update = (id: string, rowParts: object[], status: string) =>
    write(w => w.prepare('UPDATE chat_session_messages SET payload_json = ?, status = ? WHERE message_id = ?').run(JSON.stringify({ parts: rowParts }), status, id));
  const page = (request = {}, session = SESSION) => qoderTranscript(home, session, request);
  return { home, file, row, update, write, page };
}

const shape = (items: TranscriptItem[]) => items.map(i => [i.kind, i.name ?? null, i.text ?? null]);

test('a bound session reads as a normalised conversation, and a turn still running is read again when it ends', async t => {
  const { row, update, page } = await fixture(t);
  row('user', [text('typed by the user')]);
  row('system', [hook('SessionStart')]);
  row('assistant', [thinking(), text('visible answer'), tool('Bash', { command: 'synthetic' }, 'synthetic output'), hook('Stop'), { type: 'future-part-type', id: 'p' }]);
  const runningPart = tool('Bash', { command: 'slow' }, undefined, { status: 'running' });
  const running = row('assistant', [runningPart], { status: 'streaming' });
  row('user', [text('other session text')], { session: OTHER });

  const latest = await page();
  assert.equal(latest.status, 'ok');
  assert.deepEqual(shape(latest.items), [
    ['user', null, 'typed by the user'],
    ['system', 'SessionStart', 'synthetic-hook.exe · succeeded'],
    ['thinking', null, null],
    ['assistant', null, 'visible answer'],
    ['tool_call', 'Bash', '{"command":"synthetic"}'],
    ['tool_result', 'Bash', 'synthetic output'],
    ['system', 'Stop', 'synthetic-hook.exe · succeeded'],
    ['unknown', null, '无法识别的 Qoder 记录'],
    ['tool_call', 'Bash', '{"command":"slow"}'],
  ]);
  assert.equal(latest.unknownCount, 1);
  assert.equal(latest.items[0]!.timestamp, new Date(at + 1).toISOString());
  assert.equal(latest.items[2]!.timestamp, startedAt);
  assert.equal(latest.hasMore, false);
  assert.ok(latest.items.every(i => !JSON.stringify(i).includes('private chain of thought')));

  const older = await page({ limit: 3 });
  assert.deepEqual(older.items.map(i => i.kind), ['system', 'unknown', 'tool_call']);
  const previous = await page({ limit: 3, cursor: older.before });
  assert.deepEqual(previous.items.map(i => i.kind), ['assistant', 'tool_call', 'tool_result']);
  assert.deepEqual((await page({ direction: 'after', cursor: previous.after })).items, older.items);

  update(running, [{ ...runningPart, tool: { ...runningPart.tool, status: 'completed', response: 'finally' } }, text('done')], 'completed');
  const next = await page({ direction: 'after', cursor: latest.after });
  assert.deepEqual(shape(next.items), [['tool_call', 'Bash', '{"command":"slow"}'], ['tool_result', 'Bash', 'finally'], ['assistant', null, 'done']]);
  assert.equal(next.items[0]!.id, latest.items.at(-1)!.id);
  assert.deepEqual((await page({ direction: 'after', cursor: next.after })).items, []);
});

test('missing data, missing or deleted session, unknown schema, bad session ids and linked files give a status', async t => {
  const { home, file, row, page, write } = await fixture(t);
  row('user', [text('hello')]);
  assert.equal((await qoderTranscript(join(home, 'absent'), SESSION, {})).status, 'missing');
  assert.equal((await page({}, '00000000-0000-4000-8000-00000000000f')).status, 'missing');
  assert.equal((await page({}, DELETED)).status, 'missing');
  for (const id of ['', '../escape', 'a/b', 'not-a-uuid', `${SESSION}/..`, `${SESSION} `]) assert.equal((await page({}, id)).status, 'refused');
  linkSync(file, join(home, 'second-name.sqlite'));
  assert.equal((await page()).status, 'refused');
  await rm(join(home, 'second-name.sqlite'));
  assert.equal((await page()).status, 'ok');
  write(w => w.exec('ALTER TABLE chat_session_messages RENAME COLUMN payload_json TO payload'));
  assert.equal((await page()).status, 'unsupported');
});

test('only this session\'s wait output, read whole in the turn its task started, carries delivery evidence', async t => {
  const { row, page } = await fixture(t);
  const envelope = '[orrery] cluster=Group clusterId=group from=Someone messageId=m1 hop=0 to=all\nsynthetic body\nsecond line';
  const own = commandFor(SESSION);
  row('user', [text(envelope)]);
  // c1 envelope, c2 direct, then the look-alikes.
  row('assistant', [background('t1', own)]);
  row('assistant', [read(outputPath('t1'), numbered(envelope))], { task: 't1' });
  row('assistant', [background('t2', own)]);
  row('assistant', [read(outputPath('t2'), numbered('a direct message\nwith two lines'))], { task: 't2' });
  row('assistant', [background('t3', commandFor(OTHER))]);                     // another session's wait command
  row('assistant', [read(outputPath('t3'), numbered(envelope))], { task: 't3' });
  row('assistant', [background('t4', own, false)]);                            // not in the background
  row('assistant', [read(outputPath('t4'), numbered(envelope))], { task: 't4' });
  row('assistant', [background('t5', `${own} extra`)]);                        // not exactly the command
  row('assistant', [read(outputPath('t5'), numbered(envelope))], { task: 't5' });
  row('assistant', [background('t6', own)]);
  row('assistant', [read(outputPath('t6'), numbered(envelope), { offset: 1 }),   // part of the file
    read(outputPath('t1'), numbered(envelope)),                                 // another task's file
    read(outputPath('t6'), numbered(envelope).split('\n').slice(1).join('\n')),  // not numbered from 1
    tool('Grep', { file_path: outputPath('t6') }, numbered(envelope))], { task: 't6' });
  row('assistant', [read(outputPath('t6'), numbered(envelope))]);                // not the turn the task started
  row('assistant', [background('t7', own)]);                                   // started too many turns before
  for (let i = 0; i < 16; i++) row('assistant', [text(`turn ${i}`)]);
  row('assistant', [read(outputPath('t7'), numbered(envelope))], { task: 't7' });
  row('assistant', [background('t8', own)]);                                   // the window still reaches it
  for (let i = 0; i < 15; i++) row('assistant', [text(`turn ${i}`)]);
  row('assistant', [read(outputPath('t8'), numbered(envelope))], { task: 't8' });

  const { items } = await page();
  const candidate = (item: TranscriptItem) => item.source?.candidate;
  assert.deepEqual([items[0]!.kind, items[0]!.source], ['user', undefined]);
  assert.deepEqual(items.filter(i => i.kind === 'tool_result' && i.name !== 'Bash').map(candidate), [
    { envelope },
    { direct: { body: 'a direct message\nwith two lines', at: startedAt } },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { envelope },
  ]);
  assert.equal(waitOutput(numbered(envelope).replace('\t', ' ')), undefined);
});

test('wait tickets are masked in every returned text, while the raw command still gives evidence', async t => {
  const { row, page } = await fixture(t);
  const envelope = '[orrery] cluster=Group clusterId=group from=Someone messageId=m1 hop=0 to=all\nsynthetic body';
  const own = commandFor(SESSION);
  row('assistant', [background('t1', own), text(`echoed ${own}`)]);
  row('assistant', [read(outputPath('t1'), numbered(envelope))], { task: 't1' });
  const { items } = await page();
  assert.equal(items.length, 5);
  for (const item of items) assert.ok(!/[0-9a-f]{64}/.test(item.text ?? ''), item.text);
  assert.ok(items[0]!.text!.includes(`q1.${SESSION}.<hidden> http://127.0.0.1:4999 qoder Qoder.exe`));
  assert.deepEqual(items.at(-1)!.source?.candidate, { envelope });
});

test('a -wal without its -shm is not opened: unsupported, and no file is created or changed', async t => {
  const { home, file, row } = await fixture(t);
  row('user', [text('hello')]);
  // What a crashed Qoder leaves once its -shm is gone: main.sqlite and a -wal holding a commit, no -shm.
  const crashed = await mkdtemp(join(tmpdir(), 'orrery-test-'));
  t.after(() => rm(crashed, { recursive: true, force: true }));
  const w = new DatabaseSync(file);
  try {
    w.exec('PRAGMA wal_autocheckpoint=0');
    w.prepare("UPDATE chat_sessions SET title = 'only in the wal' WHERE session_id = ?").run(SESSION);
    copyFileSync(file, join(crashed, 'main.sqlite'));
    copyFileSync(`${file}-wal`, join(crashed, 'main.sqlite-wal'));
  } finally { w.close(); }
  const files = fingerprint(crashed);
  assert.deepEqual(Object.keys(files).sort(), ['main.sqlite', 'main.sqlite-wal']);
  const result = await qoderTranscript(crashed, SESSION, {});
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(fingerprint(crashed), files);
  assert.equal((await qoderTranscript(home, SESSION, {})).status, 'ok');
});

test('a cursor on a finished row resets when Qoder rewrites that row in place', async t => {
  const { row, update, page } = await fixture(t);
  const done = row('assistant', [text('first answer')]);
  const latest = await page();
  assert.equal((await page({ direction: 'after', cursor: latest.after })).status, 'ok');
  update(done, [text('replaced answer')], 'completed');
  assert.equal((await page({ direction: 'after', cursor: latest.after })).status, 'reset');
});

test('the wait command recognised is exactly the one wait_for_messages gives a Qoder member', () => {
  assert.equal(waitCommandSession(commandFor(SESSION)), SESSION);
  assert.equal(waitCommandSession(commandFor(SESSION).replace(' qoder Qoder.exe', '')), undefined);
  assert.equal(waitCommandSession(`${commandFor(SESSION)}\n`), undefined);
  assert.equal(waitCommandSession(commandFor(SESSION).replace('q1.', 'z1.')), undefined);
});

test('a successful send_message through mcp_call carries its messageId with the recorded server name, others do not', async t => {
  const { row, page } = await fixture(t);
  const sent = '{"messageId":"own-post","deliveredTo":["peer"]}';
  row('assistant', [
    mcpCall('mcp__custom-orrery__send_message', sent),
    mcpCall('mcp__a__b__send_message', `${sent}\n\nunread hint`),
    mcpCall('mcp__orrery__send_message', 'refused', 'failed'),
    mcpCall('mcp__orrery__read_messages', sent),
    tool('Bash', { command: 'echo' }, sent),
    tool('mcp__orrery__send_message', { body: 'x' }, sent),
  ]);
  const results = (await page()).items.filter(i => i.kind === 'tool_result');
  assert.deepEqual(results.map(i => [i.name, i.source?.toolServer, i.source?.toolName, i.source?.postMessageId]), [
    ['mcp__custom-orrery__send_message', 'custom-orrery', 'send_message', 'own-post'],
    ['mcp__a__b__send_message', 'a__b', 'send_message', 'own-post'],
    ['mcp__orrery__send_message', 'orrery', 'send_message', undefined],
    ['mcp__orrery__read_messages', 'orrery', 'read_messages', undefined],
    ['Bash', undefined, 'Bash', undefined],
    ['mcp__orrery__send_message', 'orrery', 'send_message', 'own-post'],
  ]);
  const calls = (await page()).items.filter(i => i.kind === 'tool_call');
  assert.equal(calls[0]!.text, '{"clusterId":"group","body":"x"}');
});

const fingerprint = (dir: string) => Object.fromEntries(readdirSync(dir).map((name) => {
  const path = join(dir, name);
  return [name, `${statSync(path).size}:${statSync(path).mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`];
}));

function hubWith(t: TestContext, home: string) {
  const store = new Store(':memory:');
  const hub = new Hub({ store, avatarPresets: [], nativeAdapters: { qoder: createQoderNativeAdapter({ qoderData: home, qoderRunning: async () => true }) } });
  t.after(async () => { await hub.close(); store.close(); });
  const member = (id: string, clusterId: string, session: string) => ({ id, name: id, clusterId, harness: 'qoder', workerSessionId: session,
    avatar: null, cwd: process.cwd(), model: null, effort: null, origin: 'attached' as const, removedAt: null });
  return { store, hub, member };
}

test('through the Hub: the bound session only, posts linked, and no file, Hub row, event or log is written', async t => {
  const { home, row } = await fixture(t);
  row('user', [text('other member conversation')], { session: OTHER });
  row('assistant', [mcpCall('mcp__orrery__send_message', '{"messageId":"own-post","deliveredTo":[]}')]);
  const { store, hub, member } = hubWith(t, home);
  store.insertCluster({ id: 'group', name: 'Group', category: '', createdAt: startedAt }, [member('member', 'group', SESSION)]);
  store.insertMessage({ id: 'own-post', clusterId: 'group', from: 'member', body: 'post', mentions: [], replyTo: null,
    chainId: 'own-post', hop: 0, createdAt: startedAt }, [], false);
  const files = fingerprint(home);
  const events = store.lastEventSeq();
  const logged: unknown[] = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, name, (...args: unknown[]) => logged.push(args));
  const result = await hub.memberTranscript('member');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items.map(i => [i.kind, i.messageId]), [['tool_call', undefined], ['orrery_post', 'own-post']]);
  assert.ok(result.items.every(i => !i.source && !i.text?.includes('other member')));
  assert.deepEqual(fingerprint(home), files);
  assert.equal(store.lastEventSeq(), events);
  assert.deepEqual(logged, []);
});

test('through the Hub: wait output links to deliveries really made to this member; typed and foreign envelopes stay as they are', async t => {
  const { home, row } = await fixture(t);
  const { store, hub, member } = hubWith(t, home);
  store.insertCluster({ id: 'group', name: 'Group', category: '', createdAt: startedAt }, [member('member', 'group', SESSION), member('sender', 'group', OTHER)]);
  store.insertCluster({ id: 'other', name: 'Other', category: '', createdAt: startedAt }, [member('stranger', 'other', '00000000-0000-4000-8000-000000000009')]);
  const deliver = (id: string, body: string, to: string, clusterId = 'group', direct = false) => {
    const [d] = store.insertMessage({ id, clusterId, from: 'sender', body, mentions: [to], replyTo: null, chainId: id, hop: 0,
      createdAt: startedAt }, [to], direct);
    const running = store.startDelivery(d!.id, d!.id);
    store.appendEvent(clusterId, to, 'delivery', { delivery: { ...running, updatedAt: startedAt } });
    store.setDeliveryState(d!.id, 'done', null, 'accepted');
  };
  deliver('m1', 'body of m1', 'member');
  deliver('m2', 'body of m2', 'stranger', 'other');
  deliver('d1', 'a direct message', 'member', 'group', true);
  const envelope = (id: string, cluster = 'Group clusterId=group') => `[orrery] cluster=${cluster} from=sender messageId=${id} hop=0 to=all\nrendered body`;
  const delivery = (task: string, output: string, command = commandFor(SESSION)) => {
    row('assistant', [background(task, command)]);
    row('assistant', [read(outputPath(task), numbered(output))], { task });
  };
  row('user', [text(envelope('m1'))]);
  delivery('t1', envelope('m1'));
  delivery('t2', envelope('m2', 'Other clusterId=other'));
  delivery('t3', 'a direct message');
  delivery('t4', envelope('m1'), commandFor(OTHER));
  const items = (await hub.memberTranscript('member')).items;
  const pair = [['tool_call', null], ['tool_result', null]];
  assert.deepEqual(items.map(i => [i.kind, i.parts?.map(p => [p.messageId, p.from, p.body]) ?? null]), [
    ['user', null],
    ...pair, ['tool_call', null], ['orrery_delivery', [['m1', 'sender', 'body of m1']]],
    ...pair, ...pair,
    ...pair, ['tool_call', null], ['orrery_delivery', [['d1', 'sender', 'a direct message']]],
    ...pair, ...pair,
  ]);
  assert.equal(items[0]!.text, envelope('m1'));
  assert.ok(items.every(i => !i.source));
});
