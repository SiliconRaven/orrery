// DeepSeek Harness transcript (src/adapters/deepseek/transcript.ts) over hand-written synthetic session logs, compressed
// at run time into appended zstd frames like DSH writes them, and its attribution through Hub.memberTranscript.
import { strict as assert } from 'node:assert';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { constants, zstdCompressSync } from 'node:zlib';
import { createDeepseekNativeAdapter } from '../src/adapters/deepseek/native.ts';
import { Hub } from '../src/core/hub.ts';
import { Store, type NewMember } from '../src/core/store.ts';
import { junction } from './extensions-fixture.ts';

const SESSION = '0f0f0f0f-1111-4222-8333-444444444444';
const PROJECT = '--C-fixture-project--';
let seq = 0;
const at = (n: number) => Date.UTC(2026, 0, 2, 3, 4, 5) + n * 1000;
const rec = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type, seq: ++seq, time: at(seq), data, surfaceOp: 'append', ...extra });
const header = (id = SESSION) => ({ type: 'session', version: 4, id, cwd: 'C:\\fixture', createdAt: at(0), delegationDepth: 0, isSeeded: false });
const user = (kind: string, text: string, more: Record<string, unknown> = {}) =>
  rec('user/message', { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind, ...more } });
const frame = (...records: unknown[]) => zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r) + '\n').join('')),
  { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const envelope = (messageId: string) =>
  `[orrery] cluster=Fixture group clusterId=group from=Sender messageId=${messageId} hop=0 to=all\nsynthetic delivered body`;

/** A synthetic conversation using the record shapes seen in DSH 0.2.1-rc.2 logs. */
function conversation(batchId: string, foreignBatchId: string) {
  seq = 0;
  return [
    frame(header(), user('time-context', 'fixture hidden time context', { form: 'snapshot' })),
    frame(user('user', envelope('m1'), { rpcId: batchId }), rec('turn/start', { turn: 1 }), rec('step/start', { turn: 1, step: 1 })),
    frame(rec('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'reasoning', text: 'synthetic reasoning' }, { type: 'text', text: 'synthetic answer' },
      { type: 'tool-call', id: 'call-1', name: 'run_code', arguments: '{"code":"fixture"}' }] }, stream: [] })),
    frame(rec('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'run_code', arguments: '{"code":"fixture"}' }),
      rec('tool/ptc-dispatch-start', { name: 'mcp__custom-orrery__send_message', subCallId: 'sub-1', parentCallId: 'call-1',
        rootCallId: 'call-1', arguments: { body: 'synthetic post' } })),
    frame(rec('tool/ptc-dispatch', { name: 'mcp__custom-orrery__send_message', subCallId: 'sub-1', parentCallId: 'call-1',
      rootCallId: 'call-1', isError: false, content: [{ type: 'text', text: '{"messageId":"own-post","deliveredTo":[]}' }] })),
    frame(rec('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'tool', toolCallId: 'call-1', isError: false,
      source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'synthetic run output' }] } }, { sourceEventSeqs: [4] }),
    rec('tool/result', { message: { id: 'r1p', role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'fixture pruned copy' }] } },
      { surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 } }),
    rec('turn/end', { turn: 1, reason: { kind: 'completed' } })),
    // DSH's own subagent send_message (no MCP server) and a hand-typed copy of a real envelope.
    frame(rec('tool/call', { callId: 'call-2', name: 'send_message', arguments: '{}' }),
      rec('tool/result', { message: { id: 'r2', role: 'tool', toolCallId: 'call-2', isError: false, content: [{ type: 'text', text: '{"messageId":"own-post"}' }] } }),
      user('user', envelope('m1'), { rpcId: 'fixture-ui-request' }), user('user', envelope('m1')),
      user('user', envelope('m1'), { rpcId: foreignBatchId }), user('user', 'body of d1'), user('user', 'typed by hand'),
      rec('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
      rec('future/record', { anything: 'fixture future payload' })),
  ];
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-dsh-transcript-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dshHome = join(dir, 'dsh');
  const sessionDir = join(dshHome, 'sessions', PROJECT, SESSION);
  await mkdir(sessionDir, { recursive: true });
  const adapter = createDeepseekNativeAdapter({ dshHome });
  assert.ok(adapter.transcript);
  return { dir, dshHome, sessionDir, file: join(sessionDir, 'session.v4.jsonl.zstd'), read: adapter.transcript };
}

test('a bound DSH session reads as a normalised conversation and pages across appended frames', async (t) => {
  const { file, read } = await fixture(t);
  await writeFile(file, Buffer.concat(conversation('batch-1', 'batch-x')));
  const page = await read(SESSION, {});
  assert.equal(page.status, 'ok');
  assert.deepEqual(page.items.map((i) => i.kind), ['user', 'thinking', 'assistant', 'tool_call', 'tool_call', 'tool_result',
    'tool_result', 'tool_call', 'tool_result', 'user', 'user', 'user', 'user', 'user', 'system', 'unknown']);
  assert.equal(page.unknownCount, 1);
  assert.deepEqual(page.items[0]!.source, { candidate: { deliveryId: 'batch-1' } });
  assert.equal(page.items[0]!.timestamp, new Date(at(2)).toISOString());
  // Reasoning is a placeholder only: its text is never returned.
  assert.deepEqual([page.items[1]!.text, page.items[2]!.text], [undefined, 'synthetic answer']);
  assert.ok(!JSON.stringify(page).includes('synthetic reasoning'));
  assert.deepEqual(page.items[4]!.source, { toolCallId: 'sub-1', toolServer: 'custom-orrery', toolName: 'send_message' });
  assert.deepEqual(page.items[5]!.source, { toolCallId: 'sub-1', toolServer: 'custom-orrery', toolName: 'send_message', postMessageId: 'own-post' });
  assert.equal(page.items[6]!.text, 'synthetic run output');
  assert.deepEqual(page.items[7]!.source, { toolCallId: 'call-2', toolName: 'send_message' });
  // The request id is the only evidence offered; a record without one offers nothing, whatever its text.
  assert.deepEqual(page.items[9]!.source, { candidate: { deliveryId: 'fixture-ui-request' } });
  assert.equal(page.items[10]!.source, undefined);
  assert.equal(page.items[12]!.source, undefined);
  assert.equal(page.items[14]!.text, '轮次已中断');
  assert.doesNotMatch(JSON.stringify(page), /hidden time context|pruned copy|future payload/);

  const tail = await read(SESSION, { limit: 2 });
  assert.deepEqual(tail.items.map((i) => i.kind), ['system', 'unknown']);
  const older = await read(SESSION, { limit: 3, cursor: tail.before });
  assert.deepEqual(older.items.map((i) => i.kind), ['user', 'user', 'user']);
  seq = 100;
  await appendFile(file, frame(rec('assistant/message', { message: { content: [{ type: 'text', text: 'appended answer' }] } })));
  const newer = await read(SESSION, { direction: 'after', cursor: tail.after });
  assert.deepEqual(newer.items.map((i) => i.text), ['appended answer']);
  assert.equal(newer.hasMore, false);

  // A newer generation is read instead; cursors of the old one reset.
  await writeFile(join(file, '..', 'session.v5.jsonl.zstd'), Buffer.concat([frame(header()), frame(user('user', 'next generation'))]));
  assert.equal((await read(SESSION, { direction: 'after', cursor: newer.after })).status, 'reset');
  assert.deepEqual((await read(SESSION, {})).items.map((i) => i.text), ['next generation']);
});

test('only the bound session id is read: arbitrary ids, other headers, duplicates and links are refused', async (t) => {
  const { dir, dshHome, file, read } = await fixture(t);
  assert.equal((await read(SESSION, {})).status, 'missing');
  await writeFile(file, frame(header('another-session'), user('user', 'foreign')));
  assert.equal((await read(SESSION, {})).status, 'refused');
  for (const id of ['../x', `${PROJECT}/${SESSION}`, '..', '', 'a\\b', 'x'.repeat(201)]) assert.equal((await read(id, {})).status, 'refused');
  await writeFile(file, frame(header(), user('user', 'mine')));
  assert.equal((await read(SESSION, {})).status, 'ok');
  assert.equal((await read('0f0f0f0f-0000-4000-8000-000000000000', {})).status, 'missing');
  await writeFile(file, frame(user('user', 'no header')));
  assert.equal((await read(SESSION, {})).status, 'unsupported');
  await writeFile(file, frame(header(), user('user', 'mine')));

  const second = join(dshHome, 'sessions', '--C-other--', SESSION);
  await mkdir(second, { recursive: true });
  await writeFile(join(second, 'session.v4.jsonl.zstd'), frame(header(), user('user', 'copy')));
  assert.equal((await read(SESSION, {})).status, 'refused');
  await rm(join(dshHome, 'sessions', '--C-other--'), { recursive: true });

  // A project folder that is a junction to a session outside the DSH sessions folder.
  const outside = join(dir, 'outside');
  const other = '0f0f0f0f-2222-4222-8222-222222222222';
  await mkdir(join(outside, other), { recursive: true });
  await writeFile(join(outside, other, 'session.v4.jsonl.zstd'), frame(header(other), user('user', 'outside')));
  if (!junction(outside, join(dshHome, 'sessions', '--C-linked--'))) return t.skip('the OS refused to create a junction');
  assert.equal((await read(other, {})).status, 'refused');
});

test('the Hub links DSH deliveries only by its real delivery ids to this member and links member posts', async (t) => {
  const { file, dshHome, sessionDir } = await fixture(t);
  const store = new Store(':memory:');
  const member = (id: string, harness: string, workerSessionId: string): NewMember => ({ id, name: id, clusterId: 'group', harness,
    workerSessionId, avatar: null, cwd: process.cwd(), model: null, effort: null, origin: 'attached', removedAt: null });
  store.insertCluster({ id: 'group', name: 'Fixture group', category: '', createdAt: new Date(at(0)).toISOString() },
    [member('ds', 'deepseek', SESSION), member('sender', 'claude', 'sender'), member('peer', 'deepseek', 'peer-session')]);
  const hub = new Hub({ store, avatarPresets: [], nativeAdapters: { deepseek: createDeepseekNativeAdapter({ dshHome }) } });
  t.after(async () => { await hub.close(); store.close(); });
  const send = (id: string, from: string, to: string | null, direct = false) => store.insertMessage({ id, clusterId: 'group', from,
    body: `body of ${id}`, mentions: to ? [to] : [], replyTo: null, chainId: id, hop: 0, createdAt: new Date(at(1)).toISOString() },
    to ? [to] : [], direct);
  const delivered = (id: string, to: string, direct = false) => {
    const [d] = send(id, direct ? 'user' : 'sender', to, direct);
    const running = store.startDelivery(d!.id, d!.id);
    store.appendEvent('group', to, 'delivery', { delivery: { ...running, updatedAt: new Date(at(1)).toISOString() } });
    store.setDeliveryState(d!.id, 'done', null, 'completed');
    return d!.id;
  };
  const batch = delivered('m1', 'ds');
  const foreign = delivered('m2', 'peer');
  delivered('d1', 'ds', true);
  send('own-post', 'ds', null);
  await writeFile(file, Buffer.concat(conversation(batch, foreign)));

  const changes = () => (store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const before = { changes: changes(), seq: store.lastEventSeq(), bytes: await readFile(file), mtime: (await stat(file)).mtimeMs,
    files: await readdir(sessionDir) };
  const events: unknown[] = [];
  const unsubscribe = hub.subscribe((e) => events.push(e));
  const logged: unknown[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, level, (...args: unknown[]) => logged.push(args));
  const page = await hub.memberTranscript('ds');
  unsubscribe();
  t.mock.restoreAll();

  assert.equal(page.status, 'ok');
  const users = page.items.filter((i) => i.kind === 'user' || i.kind === 'orrery_delivery');
  assert.deepEqual(users.map((i) => i.kind), ['orrery_delivery', 'user', 'user', 'user', 'user', 'user']);
  assert.deepEqual(users[0]!.parts?.map((p) => [p.messageId, p.from, p.body]), [['m1', 'sender', 'body of m1']]);
  // A typed copy of a real envelope stays user text: with DSH's own request id, with another member's delivery id,
  // or with no request id at all. So does the exact body of a real direct message to this member.
  assert.ok(users.slice(1, 4).every((i) => i.text === envelope('m1') && !i.parts));
  assert.equal(users[4]!.text, 'body of d1');
  assert.equal(users[5]!.text, 'typed by hand');
  assert.deepEqual(page.items.filter((i) => i.kind === 'orrery_post').map((i) => i.messageId), ['own-post']);
  assert.equal(page.items.filter((i) => i.kind === 'tool_result').length, 2, 'the subagent send_message result is not a post');
  assert.ok(page.items.every((i) => !i.source));

  assert.equal(changes(), before.changes);
  assert.equal(store.lastEventSeq(), before.seq);
  assert.deepEqual(events, []);
  assert.deepEqual(logged, []);
  assert.deepEqual(await readFile(file), before.bytes);
  assert.equal((await stat(file)).mtimeMs, before.mtime);
  assert.deepEqual(await readdir(sessionDir), before.files);
});
