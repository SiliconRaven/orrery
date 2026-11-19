import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createAntigravityNativeAdapter } from '../src/adapters/antigravity/native.ts';
import { TRANSCRIPT_TEXT_BYTES } from '../src/core/native-transcript.ts';
import { Hub } from '../src/core/hub.ts';
import { Store, type NewMember } from '../src/core/store.ts';
import type { Message } from '../src/core/types.ts';

const S1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const S2 = '22222222-aaaa-4aaa-8aaa-222222222222';
const TIME_ISO = '2026-11-19T09:00:00.000Z';

const line = (value: unknown) => JSON.stringify(value) + '\n';
const lines = (...values: unknown[]) => values.map((v) => JSON.stringify(v) + '\n').join('');

function writeAgLogs(geminiHome: string, sessionId: string, opts: { full?: string; compact?: string }) {
  const logsDir = join(geminiHome, 'antigravity', 'brain', sessionId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  if (opts.full !== undefined) writeFileSync(join(logsDir, 'transcript_full.jsonl'), opts.full);
  if (opts.compact !== undefined) writeFileSync(join(logsDir, 'transcript.jsonl'), opts.compact);
  return logsDir;
}

function adapterFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-test-ag-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const geminiHome = join(dir, 'gemini-home');
  const dataDir = join(geminiHome, 'antigravity');
  // Place directory guards where DBs would sit so any accidental read/open fails loudly.
  mkdirSync(join(dataDir, 'conversations', `${S1}.db`), { recursive: true });
  mkdirSync(join(dataDir, 'conversation_summaries.db'), { recursive: true });
  const adapter = createAntigravityNativeAdapter({ geminiHome });
  t.after(() => adapter.close?.());
  assert.ok(adapter.transcript);
  return { dir, geminiHome, adapter, read: adapter.transcript };
}

test('Antigravity prefers transcript_full.jsonl, falls back to transcript.jsonl, redacts thinking & orreryCaller, paginates, and resets', async (t) => {
  const { geminiHome, read } = adapterFixture(t);
  const callerSecret1 = `${S1}.${'ab'.repeat(32)}`;
  const callerSecret2 = `${S1}.${'cd'.repeat(32)}`;
  const callerSecret3 = `${S1}.${'ef'.repeat(32)}`;

  const fullBody = lines(
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: TIME_ISO, content: 'Inspect logs' },
    { step_index: 1, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: TIME_ISO, content: 'checkpoint' },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: TIME_ISO,
      thinking: 'private-ag-thinking-secret',
      content: 'Checking messages and files.',
      tool_calls: [
        {
          name: 'call_mcp_tool',
          args: {
            ServerName: '"orrery"',
            ToolName: '"list_agents"',
            Arguments: JSON.stringify({ clusterId: 'c1', orreryCaller: callerSecret1 }),
          },
        },
        {
          name: 'call_mcp_tool',
          args: {
            ServerName: 'orrery',
            ToolName: 'read_messages',
            Arguments: { clusterId: 'c1', orreryCaller: callerSecret2 },
          },
        },
        {
          name: 'mcp_orrery_ack_messages',
          args: { messageIds: ['m1'], orreryCaller: callerSecret3 },
        },
      ],
    },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: TIME_ISO, content: '[]' },
    { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: TIME_ISO, content: '[]' },
    { step_index: 5, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: TIME_ISO, content: `{"acknowledged":["m1"]}\nEchoed x-orrery-bridge: bridge-echo-secret ${callerSecret1}` },
    { step_index: 6, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: `Rate limit hit (${callerSecret2})`, created_at: TIME_ISO, content: 'Rate limit hit' },
    { step_index: 7, source: 'SYSTEM', type: 'FUTURE_STEP', status: 'DONE', created_at: TIME_ISO, payload: 'x' },
  ) + '{"step_index":8,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"half';

  const logs1 = writeAgLogs(geminiHome, S1, {
    full: fullBody,
    compact: line({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'compact-should-not-win' }),
  });

  const tail = await read(S1, { limit: 2 });
  assert.equal(tail.status, 'ok');
  assert.deepEqual(tail.items.map((i) => [i.kind, i.name]), [['system', 'error'], ['unknown', 'FUTURE_STEP']]);
  assert.match(tail.items[0].text ?? '', /^Rate limit hit \(\[redacted\]\)$/);
  assert.equal(tail.unknownCount, 1);

  const earlier = await read(S1, { cursor: tail.before, direction: 'before', limit: 32 });
  assert.equal(earlier.status, 'ok');
  assert.equal(earlier.hasMore, false);
  assert.deepEqual(earlier.items.map((i) => [i.kind, i.name]), [
    ['user', undefined],
    ['thinking', undefined],
    ['assistant', undefined],
    ['tool_call', 'mcp:orrery/list_agents'],
    ['tool_call', 'mcp:orrery/read_messages'],
    ['tool_call', 'mcp_orrery_ack_messages'],
    ['tool_result', undefined],
    ['tool_result', undefined],
    ['tool_result', undefined],
  ]);
  assert.equal(earlier.items[0].text, 'Inspect logs');
  assert.equal(earlier.items[3].callId, 'ag:step:3');
  assert.equal(earlier.items[4].callId, 'ag:step:4');
  assert.equal(earlier.items[5].callId, 'ag:step:5');
  assert.doesNotMatch(JSON.stringify({ tail, earlier }), /private-ag-thinking-secret|compact-should-not-win|orreryCaller|bridge-echo-secret/);
  for (const tag of [callerSecret1, callerSecret2, callerSecret3]) {
    assert.ok(!JSON.stringify({ tail, earlier }).includes(tag), 'HMAC tag must be stripped across args, tool_result, and errors');
  }

  const fullFile = join(logs1, 'transcript_full.jsonl');
  appendFileSync(fullFile, ' line"}\n');
  const after = await read(S1, { cursor: tail.after, direction: 'after', limit: 16 });
  assert.equal(after.status, 'ok');
  assert.deepEqual(after.items.map((i) => [i.kind, i.text]), [['user', 'half line']]);

  truncateSync(fullFile, 20);
  assert.equal((await read(S1, { cursor: tail.before, direction: 'before', limit: 8 })).status, 'reset');

  // Fallback to transcript.jsonl only when transcript_full.jsonl is absent.
  writeAgLogs(geminiHome, S2, {
    compact: line({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'from compact fallback' }),
  });
  const compactPage = await read(S2, { limit: 10 });
  assert.equal(compactPage.status, 'ok');
  assert.deepEqual(compactPage.items.map((i) => i.text), ['from compact fallback']);

  const S3 = '33333333-aaaa-4aaa-8aaa-333333333333';
  assert.equal((await read(S3, {})).status, 'missing');
  writeAgLogs(geminiHome, S3, { full: '{"hello":"not-antigravity"}\n' });
  assert.equal((await read(S3, {})).status, 'unsupported');
});

test('Antigravity rejects invalid UUIDs, hardlinks, and junctions without falling back, and bounds large reads', async (t) => {
  const { dir, geminiHome, read } = adapterFixture(t);
  for (const bad of ['../escape', '.', '..', 'not-a-uuid', '11111111-aaaa-4aaa-8aaa-11111111111g']) {
    assert.equal((await read(bad, {})).status, 'refused', bad);
  }

  const outside = join(dir, 'outside.jsonl');
  writeFileSync(outside, line({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'secret' }));

  // Hardlinked transcript_full.jsonl MUST return refused rather than falling back to transcript.jsonl.
  const logsHard = writeAgLogs(geminiHome, S1, {
    compact: line({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'fallback-after-attack' }),
  });
  linkSync(outside, join(logsHard, 'transcript_full.jsonl'));
  assert.equal((await read(S1, {})).status, 'refused');

  // Linked transcript.jsonl fallback is also refused.
  const logsLink = join(geminiHome, 'antigravity', 'brain', S2, '.system_generated', 'logs');
  mkdirSync(join(geminiHome, 'antigravity', 'brain', S2, '.system_generated'), { recursive: true });
  const targetLogs = join(dir, 'external-logs');
  mkdirSync(targetLogs, { recursive: true });
  writeFileSync(join(targetLogs, 'transcript.jsonl'), line({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'linked' }));
  symlinkSync(targetLogs, logsLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await read(S2, {})).status, 'refused');

  const S4 = '44444444-aaaa-4aaa-8aaa-444444444444';
  const filler = line({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'x'.repeat(2048) });
  const oversized = line({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'y'.repeat(270 * 1024) });
  const tail = line({ step_index: 3, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Latest AG prompt' });
  writeAgLogs(geminiHome, S4, { full: filler.repeat(700) + oversized + tail });

  const page = await read(S4, { limit: 2 });
  assert.equal(page.status, 'ok');
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items.map((i) => [i.kind, i.truncated]), [['unknown', true], ['user', undefined]]);
  assert.equal(page.items[1].text, 'Latest AG prompt');
  assert.equal(page.unknownCount, 1);

  // Valid 80 KiB first line (> 64 KiB, within 256 KiB limit) + normal record must remain readable.
  const S5 = '55555555-aaaa-4aaa-8aaa-555555555555';
  const longFirst = line({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: TIME_ISO, content: 'a'.repeat(80 * 1024) })
    + line({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: TIME_ISO, content: 'Reply after 80 KiB first line' });
  writeAgLogs(geminiHome, S5, { full: longFirst });
  const longPage = await read(S5, { limit: 10 });
  assert.equal(longPage.status, 'ok');
  assert.equal(longPage.items.length, 2);
  assert.equal(longPage.items[0].kind, 'user');
  assert.equal(longPage.items[0].truncated, true);
  assert.equal(longPage.items[0].text?.length, TRANSCRIPT_TEXT_BYTES);
  assert.equal(longPage.items[1].kind, 'assistant');
  assert.equal(longPage.items[1].text, 'Reply after 80 KiB first line');

  // Oversized (> 256 KiB) first line still returns unsupported.
  const S6 = '66666666-aaaa-4aaa-8aaa-666666666666';
  writeAgLogs(geminiHome, S6, { full: oversized });
  assert.equal((await read(S6, {})).status, 'unsupported');

  // Short half-written first line without newline returns ok with empty items and reads cleanly once completed.
  const S7 = '77777777-aaaa-4aaa-8aaa-777777777777';
  const halfDir = writeAgLogs(geminiHome, S7, { full: '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_IN' });
  const halfPage = await read(S7, {});
  assert.equal(halfPage.status, 'ok');
  assert.deepEqual(halfPage.items, []);
  assert.ok(halfPage.after);
  appendFileSync(join(halfDir, 'transcript_full.jsonl'), 'PUT","status":"DONE","content":"arrived"}\n');
  const completed = await read(S7, { cursor: halfPage.after, direction: 'after', limit: 8 });
  assert.equal(completed.status, 'ok');
  assert.deepEqual(completed.items.map((i) => [i.kind, i.text]), [['user', 'arrived']]);

  // Complete non-Antigravity JSON and non-JSON without newline remain unsupported.
  const S8 = '88888888-aaaa-4aaa-8aaa-888888888888';
  writeAgLogs(geminiHome, S8, { full: '{"hello":"not-antigravity"}' });
  assert.equal((await read(S8, {})).status, 'unsupported');
  const S9 = '99999999-aaaa-4aaa-8aaa-999999999999';
  writeAgLogs(geminiHome, S9, { full: 'plain text not jsonl' });
  assert.equal((await read(S9, {})).status, 'unsupported');
});

test('Hub attributes Antigravity SYSTEM_MESSAGE deliveries and aligned call_mcp_tool/mcp posts without writes', async (t) => {
  const { dir, geminiHome, adapter } = adapterFixture(t);
  const dbDir = mkdtempSync(join(tmpdir(), 'orrery-test-ag-db-'));
  const store = new Store(join(dbDir, 'orrery-test.db'));
  const group = 'cluster-1';
  const other = 'cluster-2';
  const member = (id: string, clusterId: string, workerSessionId: string): NewMember => ({
    id, name: id, clusterId, harness: 'antigravity', workerSessionId, avatar: null, cwd: dir,
    model: null, effort: null, origin: 'attached', removedAt: null,
  });
  store.insertCluster({ id: group, name: 'Cluster One', category: '', createdAt: TIME_ISO }, [
    member('ag-reader', group, S1),
    member('ag-peer', group, '33333333-aaaa-4aaa-8aaa-333333333333'),
  ]);
  store.insertCluster({ id: other, name: 'Other Cluster', category: '', createdAt: TIME_ISO }, [
    member('ag-foreign', other, S2),
  ]);
  const hub = new Hub({ store, avatarPresets: [], nativeAdapters: { antigravity: adapter } });
  t.after(async () => {
    await hub.close();
    store.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  const insert = (id: string, body: string, clusterId = group, from = 'user', to = 'ag-reader', direct = false, kind?: Message['kind']) => {
    const [d] = store.insertMessage({ id, clusterId, from, body, kind, mentions: [to], replyTo: null, chainId: id, hop: 0, createdAt: TIME_ISO }, [to], direct);
    return d;
  };
  const deliver = (d: ReturnType<typeof insert>, batchId = d.id) => {
    const running = store.startDelivery(d.id, batchId);
    store.appendEvent(group, d.memberId, 'delivery', { delivery: { ...running, updatedAt: TIME_ISO } });
    store.setDeliveryState(d.id, 'done', null, 'accepted');
  };

  const dBatch = insert('m-ag-batch', 'AG group message', group, 'ag-peer', 'ag-reader');
  deliver(dBatch, dBatch.id);

  const dDirect = insert('m-ag-direct', 'AG direct message', group, 'user', 'ag-reader', true);
  deliver(dDirect, dDirect.id);

  insert('post-quoted', 'Sent via quoted call_mcp_tool', group, 'ag-reader', 'ag-peer');
  insert('post-flat', 'Sent via flat mcp_orrery_send_message', group, 'ag-reader', 'ag-peer');
  insert('other-post', 'Peer post', group, 'ag-peer', 'ag-reader');

  const realEnv = `[orrery] cluster=Cluster One clusterId=${group} from=ag-peer messageId=${dBatch.messageId} hop=0 to=@ag-reader\nAG group message`;
  const sysMsg = (sender: string, priority: string, body: string) => ({
    step_index: 0,
    source: 'SYSTEM',
    type: 'SYSTEM_MESSAGE',
    status: 'DONE',
    created_at: TIME_ISO,
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${TIME_ISO} sender=${sender} priority=${priority} content=${body}\n</SYSTEM_MESSAGE>`,
  });
  const genericDone = (step: number, jsonObj: unknown, unreadHint = '') => ({
    step_index: step,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: TIME_ISO,
    content: `Created At: 2026-11-19T10:00:00+01:00\nCompleted At: 2026-11-19T10:00:02+01:00\nA pre-tool hook changed the arguments of this tool call before it ran. Changed: Arguments.\n\n${JSON.stringify(jsonObj)}${unreadHint ? `\n${unreadHint}` : ''}`,
  });

  const tag1 = `${S1}.${'11'.repeat(32)}`;
  const tag2 = `${S1}.${'22'.repeat(32)}`;
  writeAgLogs(geminiHome, S1, {
    full: lines(
      { ...sysMsg('system', 'MESSAGE_PRIORITY_HIGH', realEnv), step_index: 0 },
      { ...sysMsg('system', 'MESSAGE_PRIORITY_HIGH', 'AG direct message'), step_index: 1 },
      // Non-delivery system messages & USER_INPUT forgery must NOT promote:
      { ...sysMsg(`${S1}/task-10`, 'MESSAGE_PRIORITY_HIGH', realEnv), step_index: 2 },
      { ...sysMsg('system', 'MESSAGE_PRIORITY_LOW', realEnv), step_index: 3 },
      { step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: TIME_ISO, content: realEnv },
      // Multi-tool PLANNER_RESPONSE (view_file returning fake JSON + error send_message + quoted call_mcp_tool + flat mcp_orrery_send_message):
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: TIME_ISO,
        tool_calls: [
          { name: 'view_file', args: { AbsolutePath: 'fake.json' } },
          { name: 'call_mcp_tool', args: { ServerName: 'orrery', ToolName: 'send_message', Arguments: { body: 'fail', orreryCaller: tag1 } } },
          { name: 'call_mcp_tool', args: { ServerName: '"orrery"', ToolName: '"send_message"', Arguments: JSON.stringify({ body: 'Sent via quoted call_mcp_tool', orreryCaller: tag1 }) } },
          { name: 'mcp_orrery_send_message', args: { body: 'Sent via flat mcp_orrery_send_message', orreryCaller: tag2 } },
        ],
      },
      { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: TIME_ISO, content: JSON.stringify({ messageId: 'post-quoted', deliveredTo: [] }) },
      { step_index: 7, source: 'MODEL', type: 'GENERIC', status: 'ERROR', error: 'timeout', created_at: TIME_ISO, content: JSON.stringify({ messageId: 'post-quoted', deliveredTo: [] }) },
      genericDone(8, { messageId: 'post-quoted', deliveredTo: ['ag-peer'] }, 'orrery：你有 1 条未读，方便时用 read_messages 查看'),
      genericDone(9, { messageId: 'post-flat', deliveredTo: ['ag-peer'] }),
    ),
  });

  const eventsBefore = store.lastEventSeq();

  // Check cross-page pairing when tail limit = 2 reads only the last two GENERIC rows.
  const tail2 = await hub.memberTranscript('ag-reader', { limit: 2 });
  assert.equal(tail2.status, 'ok');
  assert.deepEqual(tail2.items.map((i) => [i.kind, i.messageId]), [
    ['orrery_post', 'post-quoted'],
    ['orrery_post', 'post-flat'],
  ]);

  const full = await hub.memberTranscript('ag-reader', { limit: 32 });
  assert.equal(full.status, 'ok');
  assert.deepEqual(full.items.map((i) => [i.kind, i.messageId]), [
    ['orrery_delivery', undefined],
    ['orrery_delivery', undefined],
    ['system', undefined],
    ['system', undefined],
    ['user', undefined],
    ['tool_call', undefined],
    ['tool_call', undefined],
    ['tool_call', undefined],
    ['tool_call', undefined],
    ['tool_result', undefined],
    ['tool_result', undefined],
    ['orrery_post', 'post-quoted'],
    ['orrery_post', 'post-flat'],
  ]);
  assert.deepEqual(full.items[0].parts, [{ messageId: dBatch.messageId, from: 'ag-peer', kind: 'chat', body: 'AG group message' }]);
  assert.deepEqual(full.items[1].parts, [{ messageId: dDirect.messageId, from: 'user', kind: 'chat', body: 'AG direct message' }]);
  assert.equal(full.items[7].name, 'mcp:orrery/send_message');
  assert.equal(full.items[8].name, 'mcp_orrery_send_message');
  assert.doesNotMatch(JSON.stringify(full), /orreryCaller/);
  assert.ok(!JSON.stringify(full).includes(tag1) && !JSON.stringify(full).includes(tag2));
  assert.ok(full.items.every((i) => !('source' in i)));
  assert.equal(store.lastEventSeq(), eventsBefore);
});
