import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createClaudeNativeAdapter } from '../src/adapters/claude/native.ts';

const ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const TIME = '2026-11-19T10:00:00.000Z';
const peer = { kind: 'peer', from: 'orrery' };
const row = (content: unknown, fields = {}) => ({ type: 'user', timestamp: TIME, message: { content }, ...fields });
const text = (text: string) => ({ type: 'text', text });
const lines = (...values: unknown[]) => values.map((value) => JSON.stringify(value) + '\n').join('');

function fixture(t: TestContext, ...rows: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-test-claude-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'projects', 'synthetic-project');
  mkdirSync(project, { recursive: true });
  const file = join(project, ID + '.jsonl');
  writeFileSync(file, lines(row('Start', { cwd: project, sessionId: ID, origin: { kind: 'human' } }), ...rows));
  const transcript = createClaudeNativeAdapter({ claudeDir: dir }).transcript!;
  return { transcript, file, dir };
}

test('Claude uses native inbox and attachment origin, never promotes user-typed envelopes', async (t) => {
  const envelope = '[orrery] cluster=Demo clusterId=cluster from=Agent messageId=m1 hop=0 to=Me\nDeliberate text';
  const wrap = (body: string) => `<cross-session-message from="orrery">\n${body}\n</cross-session-message>`;
  const unknownWrap = `Another Claude session sent a message:\n${envelope}\n\nThis came from another Claude session but is not a recognized footer.`;
  const { transcript } = fixture(t,
    row(wrap(envelope), { origin: { kind: 'human' } }),
    row(wrap(envelope), { origin: peer, turnOrigin: 'peer' }),
    row([text(wrap(envelope))], { origin: peer, turnOrigin: 'peer', isMeta: true }),
    row(wrap('Direct input'), { origin: peer, turnOrigin: 'peer', isMeta: true }),
    row(unknownWrap, { origin: peer, turnOrigin: 'peer', isMeta: true }),
    { type: 'attachment', timestamp: TIME, attachment: { type: 'queued_command', origin: peer, prompt: wrap('Queued input'), delivery_id: 'native-id' } },
    { type: 'attachment', timestamp: TIME, attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: wrap(envelope) } },
    row('foreign sidechain replay', { sessionId: OTHER, isSidechain: true }),
  );
  const page = await transcript(ID, { limit: 32 });
  assert.equal(page.status, 'ok');
  assert.deepEqual(page.items.map(({ kind, text, source }) => [kind, text, source]), [
    ['user', 'Start', undefined],
    ['user', wrap(envelope), undefined],
    ['user', wrap(envelope), undefined],
    ['user', envelope, { orrery: true }],
    ['user', 'Direct input', { orrery: true }],
    ['user', unknownWrap, { orrery: true }],
    ['user', 'Queued input', { orrery: true }],
  ]);
  assert.equal(page.items.at(-1)?.timestamp, TIME);
  assert.equal((await transcript(OTHER, {})).status, 'missing');
  assert.equal((await transcript('../' + ID, {})).status, 'missing');
});

test('Claude prefers a confirmed transcript, rejects conflicting copies, and accepts old logs with a cwd', async (t) => {
  const { transcript, file, dir } = fixture(t, row('Confirmed copy'));
  const put = (folder: string, year: number, ...entries: unknown[]) => {
    const project = join(dir, 'projects', folder);
    mkdirSync(project, { recursive: true });
    const duplicate = join(project, ID + '.jsonl');
    writeFileSync(duplicate, lines(...entries));
    const mtime = new Date(Date.UTC(year, 0, 1));
    utimesSync(duplicate, mtime, mtime);
    return duplicate;
  };
  const oldest = new Date('2020-01-01T00:00:00Z');
  utimesSync(file, oldest, oldest);
  const legacy = put('legacy', 2021, row('Legacy copy', { cwd: dir }));
  put('different-session', 2022,
    { sessionId: OTHER, cwd: dir, type: 'user', message: { content: 'x'.repeat(80 * 1024) } },
    row('Different session text without its own ID'),
  );
  put('no-metadata', 2023, row('No ID or workspace'));

  const latest = await transcript(ID, { limit: 1 });
  assert.deepEqual(latest.items.map(({ text }) => text), ['Confirmed copy']);
  const earlier = await transcript(ID, { cursor: latest.before, direction: 'before', limit: 1 });
  assert.deepEqual(earlier.items.map(({ text }) => text), ['Start']);

  rmSync(file);
  assert.equal((await transcript(ID, { cursor: latest.after, direction: 'after' })).status, 'reset');
  assert.deepEqual((await transcript(ID, {})).items.map(({ text }) => text), ['Legacy copy']);
  rmSync(legacy);
  const refused = await transcript(ID, {});
  assert.equal(refused.status, 'refused');
  assert.deepEqual(refused.items, []);
});

test('Claude handles split messages and native replay without exposing thinking data', async (t) => {
  const assistant = (content: unknown, fields = {}) => ({
    type: 'assistant', message: { id: 'msg-1', content }, timestamp: TIME, ...fields,
  });
  const { transcript, file } = fixture(t,
    assistant([text('First block')], { apiBlockIndex: 0 }),
    assistant([{ type: 'thinking', thinking: 'private chain', signature: 'private signature' }], { apiBlockIndex: 1 }),
    assistant([{ type: 'redacted_thinking', data: 'opaque reasoning' }], { apiBlockIndex: 2 }),
    assistant([{ type: 'thinking_summary', summary: 'Public summary', signature: 'private signature' }], { apiBlockIndex: 3 }),
    assistant([text('First block'), text('Second block')], { apiBlockIndices: [0, 4] }),
    assistant([text('sidechain replay')], { isSidechain: true }),
    { type: 'api-request-blob', data: 'replayed request' },
    row('This session is being continued from an earlier context.', { isCompactSummary: true, isMeta: true }),
    { type: 'system', subtype: 'compact_boundary', timestamp: TIME },
    { type: 'future-type', data: 'unrecognized secret' },
  );
  appendFileSync(file, '{"type":"assistant","message":{"thinking":"malformed secret"}\n');
  appendFileSync(file, '{"type":"user","message":{"content":"still wr');
  const page = await transcript(ID, { limit: 32 });
  assert.deepEqual(page.items.filter(({ kind }) => kind === 'assistant').map(({ text }) => text),
    ['First block', 'Second block']);
  assert.deepEqual(page.items.filter(({ kind }) => kind === 'thinking').map(({ text }) => text),
    [undefined, undefined, 'Public summary']);
  assert.deepEqual(page.items.filter(({ kind }) => kind === 'system').map(({ name }) => name),
    ['compact_summary', 'compact_boundary']);
  assert.equal(page.unknownCount, 2);
  assert.doesNotMatch(JSON.stringify(page), /private|opaque|secret|sidechain replay|replayed request|still wr/);
  appendFileSync(file, 'iting"}}\n');
  const fresh = await transcript(ID, { direction: 'after', cursor: page.after });
  assert.deepEqual(fresh.items.map(({ text }) => text), ['still writing']);
});

test('Claude links a successful MCP result to its earlier exact tool call across pages', async (t) => {
  const call = (id: string, name: string) => ({
    type: 'assistant', timestamp: TIME, message: { id: 'msg-' + id, content: [
      { type: 'tool_use', id, name, input: { body: 'hello' } },
    ] },
  });
  const response = (id: string, error = false) => row([{
    type: 'tool_result', tool_use_id: id, is_error: error,
    content: [text('{"messageId":"message-1","deliveredTo":[]}'), text('No unread messages')],
  }]);
  const { transcript } = fixture(t,
    call('bash-call', 'Bash'), response('bash-call'),
    call('failed-call', 'mcp__orrery-test__send_message'), response('failed-call', true),
    call('send-call', 'mcp__orrery-test__send_message'), response('send-call'),
  );
  const latest = await transcript(ID, { limit: 1 });
  assert.equal(latest.items[0]?.callId, 'send-call');
  assert.deepEqual(latest.items[0]?.source, {
    toolCallId: 'send-call', toolServer: 'orrery-test', toolName: 'send_message', postMessageId: 'message-1',
  });
  const back = await transcript(ID, { cursor: latest.before, direction: 'before', limit: 8 });
  assert.deepEqual(back.items.filter(({ kind }) => kind === 'tool_result').map(({ source }) => source), [
    { toolCallId: 'bash-call' }, { toolCallId: 'failed-call' },
  ]);
  const send = back.items.at(-1);
  assert.equal(send?.name, 'mcp__orrery-test__send_message');
  assert.equal(send?.callId, latest.items[0]?.callId);
});

test('Claude displays only native text in tool results and leaves opaque payloads out', async (t) => {
  const image = { type: 'image', source: { type: 'base64', data: 'hidden-image-data' } };
  const { transcript } = fixture(t, row([
    { type: 'tool_result', tool_use_id: 'future', content: { text: 'hidden-unrecognized-text', signature: 'hidden-signature' } },
    { type: 'tool_result', tool_use_id: 'object', content: image },
    { type: 'tool_result', tool_use_id: 'array', content: [image] },
    { type: 'tool_result', tool_use_id: 'mixed', content: [text('Visible result'), image] },
    { type: 'tool_result', tool_use_id: 'string', content: 'Visible string' },
  ]));
  const page = await transcript(ID, {});
  assert.deepEqual(page.items.filter(({ kind }) => kind === 'tool_result').map(({ text }) => text), [
    '[Non-text tool output]', '[Non-text tool output]', '[Non-text tool output]', 'Visible result', 'Visible string',
  ]);
  assert.doesNotMatch(JSON.stringify(page), /hidden-/);
});
