import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { createCodexNativeAdapter } from '../src/adapters/codex/native.ts';
import { TRANSCRIPT_ZSTD_INPUT_BYTES, TRANSCRIPT_ZSTD_OUTPUT_BYTES } from '../src/adapters/shared/transcript.ts';

const session = '019abcde-1111-7777-8888-111111111111';
const parent = '019abcde-1111-7777-8888-222222222222';
const timestamp = '2026-01-02T03:04:05.123Z';
const filename = (id: string) => `rollout-2026-01-02T03-04-05-${id}.jsonl`;
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
const meta = (options: Record<string, unknown> = {}) => row('session_meta', { id: session, history_mode: 'paginated', ...options });
const event = (type: string, additional: Record<string, unknown> = {}) => row('event_msg', { type, ...additional });
const completed = (type: string, props: Record<string, unknown>, thread_id = session) => event('item_completed', { thread_id, item: { type, ...props } });
const message = (text: string) => completed('AgentMessage', { content: [{ type: 'Text', text }] });
const jsonl = (...rows: string[]) => rows.join('\n') + '\n';

async function setup(t: TestContext, id = session) {
  const root = await mkdtemp(join(tmpdir(), 'orrery-codex-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'sessions', '2026', '01', '02', filename(id));
  const archive = join(root, 'archived_sessions', filename(id));
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(archive));
  const adapter = createCodexNativeAdapter({
    codexHome: root,
    launch: () => assert.fail('a transcript does not launch an app-server'),
    appRunning: () => assert.fail('a transcript does not check desktop process state'),
    openWake: () => assert.fail('a transcript does not open a wake link'),
  });
  t.after(() => adapter.close?.());
  assert.ok(adapter.transcript);
  return { root, file, archive, read: adapter.transcript };
}

test('Codex paginates its own completed items without response duplicates or hidden fields', async (t) => {
  const { root, file, read } = await setup(t);
  const unbound = join(dirname(file), filename(parent));
  await writeFile(unbound, jsonl(meta({ id: parent }), completed('AgentMessage', { content: [{ type: 'Text', text: 'other thread' }] }, parent)));
  const before = jsonl(meta(), completed('UserMessage', { client_id: 'fixture-delivery', content: [{ type: 'text', text: 'delivery' }] }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate' }] }),
    completed('UserMessage', { client_id: 'manual-1', content: [{ type: 'text', text: '[orrery] simulated envelope' }, { type: 'image', image: 'fixture-inline-image' }] }),
    completed('Reasoning', { summary_text: ['visible summary'], raw_content: ['fixture-private-1'], encrypted_content: 'fixture-private-2' }),
    completed('Reasoning', { raw_content: ['fixture-private-3'] }),
    completed('FutureReasoning', { secret: 'fixture-private-4' }),
    '{"fixture-private-5":',
    completed('McpToolCall', { id: 'call-1', server: 'orrery-test', tool: 'send_message', arguments: { body: 'hi' },
      result: { content: [{ type: 'text', text: '{"messageId":"fixture-post"}' }, { type: 'text', text: '1 unread' }] } }),
    message('done'));
  await writeFile(file, before + '{"type":"partial"');
  const tail = await read(session, { limit: 1 });
  assert.equal(tail.status, 'ok');
  assert.deepEqual(tail.items.map((item) => item.text), ['done']);
  assert.equal(tail.hasMore, true);
  assert.ok(tail.before);
  assert.ok(tail.after);
  const older = await read(session, { cursor: tail.before });
  assert.deepEqual(older.items.map((item) => item.kind), ['user', 'user', 'thinking', 'thinking', 'unknown', 'unknown', 'tool_call', 'tool_result']);
  assert.equal(older.unknownCount, 2);
  assert.deepEqual(older.items[0].source, { deliveryId: 'fixture-delivery' });
  assert.deepEqual(older.items[1].source, { deliveryId: 'manual-1' });
  assert.equal(older.items[1].text, '[orrery] simulated envelope');
  assert.equal(older.items[2].text, 'visible summary');
  assert.equal(older.items[3].text, undefined);
  assert.equal(older.items[6].callId, older.items[7].callId);
  assert.deepEqual(older.items[7].source, { toolCallId: 'call-1', toolName: 'send_message', toolServer: 'orrery-test', postMessageId: 'fixture-post' });
  assert.doesNotMatch(JSON.stringify(older), /other thread|duplicate|fixture-private-|fixture-inline-image/);
  await appendFile(file, '}\n' + jsonl(message('new')));
  const newer = await read(session, { direction: 'after', cursor: tail.after });
  assert.equal(newer.status, 'ok');
  assert.deepEqual(newer.items.map((item) => item.kind), ['unknown', 'assistant']);
  assert.equal(newer.items[1].text, 'new');
  assert.equal(await readFile(unbound, 'utf8'), jsonl(meta({ id: parent }), completed('AgentMessage', { content: [{ type: 'Text', text: 'other thread' }] }, parent)));
  await rename(file, join(root, 'unused.jsonl'));
  assert.equal((await read(session, {})).status, 'missing');
});

test('Codex treats legacy events as canonical and only uses successful tool results for post hints', async (t) => {
  const { file, read } = await setup(t);
  await writeFile(file, jsonl(meta({ history_mode: undefined }),
    event('user_message', { message: 'legacy input', client_id: 'fixture-legacy-delivery' }),
    event('agent_message', { message: 'legacy answer' }),
    event('agent_reasoning_raw_content', { text: 'fixture-private-legacy' }),
    message('mirror'),
    event('mcp_tool_call_end', { call_id: 'legacy-1', invocation: { server: 'test-orrery', tool: 'send_message' }, result: {
      Ok: { isError: true, content: [{ type: 'text', text: '{"messageId":"fixture-failed-post"}' }] },
    } })));
  const page = await read(session, {});
  assert.equal(page.status, 'ok');
  assert.deepEqual(page.items.map((item) => item.kind), ['user', 'assistant', 'tool_call', 'tool_result']);
  assert.equal(page.items[1].text, 'legacy answer');
  assert.equal(page.items[0].source?.deliveryId, 'fixture-legacy-delivery');
  assert.equal(page.items[3].source?.postMessageId, undefined);
  assert.doesNotMatch(JSON.stringify(page), /fixture-private-legacy|mirror/);
});

test('Codex only exposes owned rows in forked and subagent rollouts', async (t) => {
  const { file, read } = await setup(t);
  for (const lineage of [{ forked_from_id: parent }, { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } }]) {
    await writeFile(file, jsonl(meta(lineage), meta({ id: parent }), event('task_started'),
      completed('UserMessage', { client_id: 'foreign-delivery', content: [{ type: 'text', text: 'parent copy' }] }, parent),
      event('item_completed', { item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'no owner' }] } }),
      row('inter_agent_communication_metadata', { trigger_turn: true }), message('child answer')));
    const page = await read(session, {});
    assert.equal(page.status, 'ok');
    assert.deepEqual(page.items.map((item) => item.text), ['child answer']);
  }
  await writeFile(file, jsonl(meta({ history_mode: undefined }), meta({ id: parent }), event('user_message', { message: 'parent copy' })));
  assert.equal((await read(session, {})).status, 'unsupported');
  await writeFile(file, jsonl(meta({ id: parent }), message('other thread')));
  assert.equal((await read(session, {})).status, 'refused');
  await assert.rejects(read('../not-a-thread', {}), /not a Codex thread id/);
});

test('Codex reads only bounded archive contents and can page from a compressed rollout', async (t) => {
  const { file, archive, read } = await setup(t);
  const text = jsonl(meta(), message('first'), message('last'));
  await writeFile(archive, text);
  assert.deepEqual((await read(session, {})).items.map((item) => item.text), ['first', 'last']);
  await rm(archive);
  const compressed = zstdCompressSync(text);
  await writeFile(archive + '.zst', compressed);
  const tail = await read(session, { limit: 1 });
  assert.equal(tail.status, 'ok');
  assert.deepEqual(tail.items.map((item) => item.text), ['last']);
  assert.ok(tail.before);
  assert.deepEqual((await read(session, { cursor: tail.before })).items.map((item) => item.text), ['first']);
  assert.deepEqual(await readFile(archive + '.zst'), compressed);
  await rename(archive + '.zst', file + '.zst');
  assert.equal((await read(session, {})).status, 'ok');
  await truncate(file + '.zst', TRANSCRIPT_ZSTD_INPUT_BYTES + 1);
  assert.equal((await read(session, {})).status, 'archived');
  await writeFile(file + '.zst', 'bad frame');
  assert.equal((await read(session, {})).status, 'archived');
  await writeFile(file + '.zst', zstdCompressSync(Buffer.alloc(TRANSCRIPT_ZSTD_OUTPUT_BYTES + 1)));
  assert.equal((await read(session, {})).status, 'archived');
});
