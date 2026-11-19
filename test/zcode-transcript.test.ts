import { TEST_HUB_ID } from './helpers.ts';
// Reading a bound ZCode conversation (src/adapters/zcode/transcript.ts). Every database here is hand-written synthetic
// data shaped like ZCode's cli/db/db.sqlite (tables session, message, part with JSON in `data`).
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createZcodeNativeAdapter } from '../src/adapters/zcode/native.ts';
import { WAIT_STARTED, waitOutput, zcodeTranscript } from '../src/adapters/zcode/transcript.ts';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { ZCODE_WAIT, type TranscriptItem } from '../src/core/types.ts';
import { tail, ticketFor, waitCommand, WAIT_SCRIPT } from '../src/mcp/wait-core.ts';

const SESSION = 'sess_synthetic0001';
const OTHER = 'sess_synthetic0002';
const SECRET = 'synthetic-bridge-secret';
const at = Date.parse('2026-01-02T12:00:00.000Z');

/** What the member sees when it Reads the wait command's output file: numbered lines of exactly what wait.mjs printed. */
function readOfWaitOutput(text: string, session = SESSION): string {
  const printed = `${WAIT_STARTED}\n${text}${tail(waitCommand(ZCODE_WAIT, ticketFor(ZCODE_WAIT, SECRET, session, TEST_HUB_ID), 'http://127.0.0.1:4999'))}`;
  return printed.replace(/\n$/, '').split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n');
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, '.zcode');
  await mkdir(join(home, 'cli', 'db'), { recursive: true });
  const file = join(home, 'cli', 'db', 'db.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', time_deleted INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER);
    CREATE INDEX message_session_sequence_idx ON message(session_id, sequence, time_created, id);
    CREATE INDEX part_message_sequence_idx ON part(message_id, sequence, time_created, id);`);
  db.prepare('INSERT INTO session(id) VALUES (?), (?), (?)').run(SESSION, OTHER, 'sess_deleted');
  db.exec("UPDATE session SET time_deleted = 1 WHERE id = 'sess_deleted'");
  db.close();
  let messages = 0;
  const write = (fn: (w: DatabaseSync) => void) => { const w = new DatabaseSync(file); try { fn(w); } finally { w.close(); } };
  /** One message with its parts; returns the part ids. */
  const message = (role: 'user' | 'assistant', parts: object[], extra: object = {}, session = SESSION) => {
    const id = `msg_synthetic${String(++messages).padStart(4, '0')}`;
    const ids = parts.map((_, i) => `part_${id.slice(4)}_${i}`);
    write(w => {
      w.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run(id, session, at + messages, at + messages,
        JSON.stringify({ role, time: { created: at + messages }, ...extra }), messages);
      parts.forEach((part, i) => w.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)').run(ids[i]!, id, session,
        at + messages, at + messages, JSON.stringify(part), i));
    });
    return ids;
  };
  const updatePart = (id: string, part: object) => write(w => w.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(part), id));
  const page = (request = {}, session = SESSION) => zcodeTranscript(home, session, request);
  return { dir, home, file, message, updatePart, write, page };
}

const time = { start: at, end: at + 1 };
const tool = (name: string, callID: string, state: object, display?: object) =>
  ({ type: 'tool', tool: name, callID, state: { time, metadata: display ? { display } : {}, ...state } });
const mcp = (server: string, name: string) => ({ kind: 'mcp_tool', serverName: server, toolName: name, description: '' });
const shape = (items: TranscriptItem[]) => items.map(i => [i.kind, i.name ?? null, i.text ?? null]);

test('a bound session reads as a normalised conversation, and a running tool is read again when it completes', async t => {
  const { message, page, updatePart } = await fixture(t);
  message('user', [{ type: 'text', text: 'typed by the user', time }]);
  message('user', [{ type: 'text', text: 'reminder for the model', synthetic: true, metadata: { source: 'todo_reminder', visibility: 'model-only' }, time }],
    { synthetic: true, source: 'todo_reminder' });
  const [, , , , , timeline] = message('assistant', [
    { type: 'step-start' },
    { type: 'reasoning', text: 'private chain of thought', time },
    { type: 'text', text: 'visible answer', time },
    tool('Bash', 'call_1', { status: 'completed', input: { command: 'synthetic' }, output: 'synthetic output' }),
    { type: 'step-finish', reason: 'tool-calls' },
    { type: 'timeline', timelineType: 'model_change', display: 'model changed', time },
    { type: 'future-part-type' },
  ]);
  const [, running] = message('assistant', [{ type: 'step-start' }, tool('Bash', 'call_2', { status: 'running', input: { command: 'slow' } })]);
  message('user', [{ type: 'text', text: 'other session text', time }], {}, OTHER);

  const latest = await page();
  assert.equal(latest.status, 'ok');
  assert.deepEqual(shape(latest.items), [
    ['user', null, 'typed by the user'],
    ['system', 'todo_reminder', 'reminder for the model'],
    ['thinking', null, null],
    ['assistant', null, 'visible answer'],
    ['tool_call', 'Bash', '{"command":"synthetic"}'],
    ['tool_result', 'Bash', 'synthetic output'],
    ['system', 'model_change', 'model changed'],
    ['unknown', null, '无法识别的 ZCode 记录'],
    ['tool_call', 'Bash', '{"command":"slow"}'],
  ]);
  assert.equal(latest.unknownCount, 1);
  assert.ok(timeline);
  assert.equal(latest.items[0]!.timestamp, new Date(at).toISOString());
  assert.equal(latest.hasMore, false);

  const older = await page({ limit: 3 });
  assert.deepEqual(shape(older.items).map(([kind]) => kind), ['system', 'unknown', 'tool_call']);
  const previous = await page({ limit: 3, cursor: older.before });
  assert.deepEqual(previous.items.map(i => i.kind), ['assistant', 'tool_call', 'tool_result']);
  assert.deepEqual((await page({ direction: 'after', cursor: previous.after })).items, older.items);

  updatePart(running!, tool('Bash', 'call_2', { status: 'completed', input: { command: 'slow' }, output: 'finally' }));
  const update = await page({ direction: 'after', cursor: latest.after });
  assert.deepEqual(shape(update.items), [['tool_call', 'Bash', '{"command":"slow"}'], ['tool_result', 'Bash', 'finally']]);
  assert.equal(update.items[0]!.id, latest.items.at(-1)!.id);
  assert.deepEqual((await page({ direction: 'after', cursor: update.after })).items, []);
});

test('missing database, missing or deleted session, unknown schema and bad session ids give a status', async t => {
  const { home, file, page, write, message } = await fixture(t);
  message('user', [{ type: 'text', text: 'hello', time }]);
  assert.equal((await zcodeTranscript(join(home, 'absent'), SESSION, {})).status, 'missing');
  assert.equal((await page({}, 'sess_unknown')).status, 'missing');
  assert.equal((await page({}, 'sess_deleted')).status, 'missing');
  for (const id of ['', '../escape', 'a/b', 'x'.repeat(200), 'sess id']) assert.equal((await page({}, id)).status, 'refused');
  write(w => w.exec('ALTER TABLE part RENAME COLUMN sequence TO position'));
  assert.equal((await page()).status, 'unsupported');
  assert.ok(file);
});

test('only a Read of this session\'s wait output carries delivery evidence; typed envelopes and look-alikes do not', async t => {
  const { message, page } = await fixture(t);
  const envelope = '[orrery] cluster=Group clusterId=group from=Someone messageId=m1 hop=0 to=all\nsynthetic body\nsecond line';
  const read = (callID: string, output: string, name = 'Read', status = 'completed') =>
    tool(name, callID, { status, input: { file_path: 'synthetic.output' }, output });
  message('user', [{ type: 'text', text: readOfWaitOutput(envelope).replace(/^\d+\t/gm, ''), time }]);
  message('user', [{ type: 'text', text: envelope, time }]);
  message('assistant', [
    read('c1', readOfWaitOutput(envelope)),
    read('c2', readOfWaitOutput('a direct message\nwith two lines')),
    read('c3', readOfWaitOutput(envelope, OTHER)),
    read('c4', readOfWaitOutput(envelope), 'Bash'),
    read('c5', readOfWaitOutput(envelope).split('\n').slice(1).map((l, i) => l.replace(/^\d+/, String(i + 1))).join('\n')),
    read('c6', readOfWaitOutput(envelope).replace(`2\t${envelope.split('\n')[0]}`, '2\t[orrery] cluster=Group')),
    read('c7', readOfWaitOutput(envelope).split('\n').slice(2).join('\n')),
  ]);
  const { items } = await page();
  const candidate = (item: TranscriptItem) => (item.source as { candidate?: unknown } | undefined)?.candidate;
  assert.deepEqual(items.slice(0, 2).map(i => [i.kind, i.source]), [['user', undefined], ['user', undefined]]);
  const results = items.filter(i => i.kind === 'tool_result');
  assert.deepEqual(results.map(candidate), [
    { envelope },
    { direct: { body: 'a direct message\nwith two lines', at: new Date(at).toISOString() } },
    undefined, undefined, undefined, { envelope: '[orrery] cluster=Group\nsynthetic body\nsecond line' }, undefined,
  ]);
  assert.equal(waitOutput(readOfWaitOutput(envelope).replace('\t', ' '), SESSION), undefined);
});

test('wait tickets are masked in every returned text, while the raw wait output still gives evidence', async t => {
  const { message, page } = await fixture(t);
  const command = waitCommand(ZCODE_WAIT, ticketFor(ZCODE_WAIT, SECRET, SESSION, TEST_HUB_ID), 'http://127.0.0.1:4999');
  const envelope = '[orrery] cluster=Group clusterId=group from=Someone messageId=m1 hop=0 to=all\nsynthetic body';
  message('assistant', [
    tool('Bash', 'w1', { status: 'completed', input: { command, run_in_background: true }, output: `started ${command}` }),
    tool('Read', 'r1', { status: 'completed', input: { file_path: 'synthetic.output' }, output: readOfWaitOutput(envelope) }),
    tool('Read', 'r2', { status: 'completed', input: { file_path: 'synthetic.output' }, output: readOfWaitOutput(envelope, OTHER) }),
    { type: 'text', text: `echoed ${command}`, time },
  ]);
  const { items } = await page();
  assert.equal(items.length, 7);
  for (const item of items) assert.ok(!/[0-9a-f]{64}/.test(item.text ?? ''), item.text);
  assert.ok(items[0]!.text!.includes(`z2.${TEST_HUB_ID}.${SESSION}.<hidden> http://127.0.0.1:4999`));
  assert.deepEqual(items.filter(i => i.kind === 'tool_result').map(i => (i.source as { candidate?: unknown }).candidate),
    [undefined, { envelope }, undefined]);
});

test('a cursor on a finished part resets when ZCode rewrites that part in place', async t => {
  const { message, page, updatePart, write } = await fixture(t);
  const [done] = message('assistant', [tool('Bash', 'c1', { status: 'completed', input: { command: 'x' }, output: 'first output' })]);
  const latest = await page();
  // The message's own data changes as the turn goes on: that alone is no rewrite of the part.
  write(w => w.exec("UPDATE message SET data = json_set(data, '$.time.completed', 1)"));
  assert.equal((await page({ direction: 'after', cursor: latest.after })).status, 'ok');
  updatePart(done!, tool('Bash', 'c1', { status: 'completed', input: { command: 'x' }, output: 'replaced output' }));
  assert.equal((await page({ direction: 'after', cursor: latest.after })).status, 'reset');
});

test('a successful MCP send_message result carries its messageId with the recorded server name, others do not', async t => {
  const { message, page } = await fixture(t);
  const sent = '{"messageId":"own-post","deliveredTo":["peer"]}';
  message('assistant', [
    tool('mcp__custom-orrery__send_message', 's1', { status: 'completed', input: { body: 'x' }, output: sent }, mcp('custom-orrery', 'send_message')),
    tool('mcp__a__b__send_message', 's2', { status: 'completed', output: `${sent}\n\nunread hint` }, mcp('a__b', 'send_message')),
    tool('mcp__orrery__send_message', 's3', { status: 'error', error: 'refused', output: sent }, mcp('orrery', 'send_message')),
    tool('mcp__orrery__read_messages', 's4', { status: 'completed', output: sent }, mcp('orrery', 'read_messages')),
    tool('Bash', 's5', { status: 'completed', output: sent }),
  ]);
  const results = (await page()).items.filter(i => i.kind === 'tool_result');
  assert.deepEqual(results.map(i => [i.source?.toolServer, i.source?.toolName, i.source?.postMessageId]), [
    ['custom-orrery', 'send_message', 'own-post'], ['a__b', 'send_message', 'own-post'],
    ['orrery', 'send_message', undefined], ['orrery', 'read_messages', undefined], [undefined, 'Bash', undefined],
  ]);
  assert.equal(results[2]!.text, 'refused');
});

const fingerprint = (dir: string) => Object.fromEntries(readdirSync(dir).map((name) => {
  const path = join(dir, name);
  return [name, `${statSync(path).size}:${statSync(path).mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`];
}));

test('through the Hub: the bound session only, posts linked, and no file, Hub row, event or log is written', async t => {
  const { home, message } = await fixture(t);
  message('user', [{ type: 'text', text: 'other member conversation', time }], {}, OTHER);
  message('assistant', [tool('mcp__orrery__send_message', 's1', { status: 'completed', output: '{"messageId":"own-post","deliveredTo":[]}' }, mcp('orrery', 'send_message'))]);
  const store = new Store(':memory:');
  const adapter = createZcodeNativeAdapter({ zcodeHome: home, zcodeRunning: async () => true });
  const hub = new Hub({ store, avatarPresets: [], nativeAdapters: { zcode: adapter } });
  t.after(async () => { await hub.close(); store.close(); });
  store.insertCluster({ id: 'group', name: 'Group', category: '', createdAt: new Date(at).toISOString() }, [
    { id: 'member', name: 'member', clusterId: 'group', harness: 'zcode', workerSessionId: SESSION, avatar: null, cwd: process.cwd(),
      model: null, effort: null, origin: 'attached', removedAt: null },
  ]);
  store.insertMessage({ id: 'own-post', clusterId: 'group', from: 'member', body: 'post', mentions: [], replyTo: null,
    chainId: 'own-post', hop: 0, createdAt: new Date(at).toISOString() }, [], false);
  const folder = join(home, 'cli', 'db');
  const files = fingerprint(folder);
  const events = store.lastEventSeq();
  const logged: unknown[] = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, name, (...args: unknown[]) => logged.push(args));
  const result = await hub.memberTranscript('member');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items.map(i => [i.kind, i.messageId]), [['tool_call', undefined], ['orrery_post', 'own-post']]);
  assert.ok(result.items.every(i => !i.source && !i.text?.includes('other member')));
  assert.deepEqual(fingerprint(folder), files);
  assert.equal(store.lastEventSeq(), events);
  assert.deepEqual(logged, []);
});

test('through the Hub: wait output links to deliveries really made to this member; typed and foreign envelopes stay as they are', async t => {
  const { home, message } = await fixture(t);
  const store = new Store(':memory:');
  const hub = new Hub({ store, avatarPresets: [], nativeAdapters: { zcode: createZcodeNativeAdapter({ zcodeHome: home, zcodeRunning: async () => true }) } });
  t.after(async () => { await hub.close(); store.close(); });
  const created = new Date(at).toISOString();
  const member = (id: string, clusterId: string, session: string) => ({ id, name: id, clusterId, harness: 'zcode', workerSessionId: session,
    avatar: null, cwd: process.cwd(), model: null, effort: null, origin: 'attached' as const, removedAt: null });
  store.insertCluster({ id: 'group', name: 'Group', category: '', createdAt: created }, [member('member', 'group', SESSION), member('sender', 'group', 'sess_sender')]);
  store.insertCluster({ id: 'other', name: 'Other', category: '', createdAt: created }, [member('stranger', 'other', OTHER)]);
  const deliver = (id: string, body: string, to: string, clusterId = 'group', direct = false) => {
    const [d] = store.insertMessage({ id, clusterId, from: 'sender', body, mentions: [to], replyTo: null, chainId: id, hop: 0,
      createdAt: created }, [to], direct);
    const running = store.startDelivery(d!.id, d!.id);
    store.appendEvent(clusterId, to, 'delivery', { delivery: { ...running, updatedAt: created } });
    store.setDeliveryState(d!.id, 'done', null, 'accepted');
  };
  deliver('m1', 'body of m1', 'member');
  deliver('m2', 'body of m2', 'stranger', 'other');
  deliver('d1', 'a direct message', 'member', 'group', true);
  const envelope = (id: string, cluster = 'Group clusterId=group') => `[orrery] ${`cluster=${cluster}`} from=sender messageId=${id} hop=0 to=all\nrendered body`;
  const read = (callID: string, output: string) => tool('Read', callID, { status: 'completed', input: { file_path: 'synthetic.output' }, output });
  message('user', [{ type: 'text', text: envelope('m1'), time }]);
  message('assistant', [
    read('c1', readOfWaitOutput(envelope('m1'))),
    read('c2', readOfWaitOutput(envelope('m2', 'Other clusterId=other'))),
    read('c3', readOfWaitOutput('a direct message')),
    read('c4', readOfWaitOutput(envelope('m1'), OTHER)),
  ]);
  const items = (await hub.memberTranscript('member')).items;
  assert.deepEqual(items.map(i => [i.kind, i.parts?.map(p => [p.messageId, p.from, p.body]) ?? null]), [
    ['user', null],
    ['tool_call', null], ['orrery_delivery', [['m1', 'sender', 'body of m1']]],
    ['tool_call', null], ['tool_result', null],
    ['tool_call', null], ['orrery_delivery', [['d1', 'sender', 'a direct message']]],
    ['tool_call', null], ['tool_result', null],
  ]);
  assert.equal(items[0]!.text, envelope('m1'));
  assert.ok(items.every(i => !i.source));
});

test('WAIT_STARTED is the first line wait.mjs prints', async () => {
  const wait = await import(pathToFileURL(WAIT_SCRIPT).href) as { STARTED: string };
  assert.equal(`${WAIT_STARTED}\n`, wait.STARTED);
});
