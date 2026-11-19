import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createWorkbuddyNativeAdapter } from '../src/adapters/workbuddy/native.ts';
import { Hub } from '../src/core/hub.ts';
import { Store, type NewMember } from '../src/core/store.ts';
import type { Message } from '../src/core/types.ts';
import { ticketFor, waitCommand } from '../src/mcp/workbuddy.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const TIME_MS = 1_795_100_000_000;
const TIME_ISO = new Date(TIME_MS).toISOString();

const line = (value: unknown) => JSON.stringify(value) + '\n';
const lines = (...values: unknown[]) => values.map((v) => JSON.stringify(v) + '\n').join('');
const metaRow = (sessionId = S1) => ({
  type: 'session-meta',
  id: 'meta-1',
  sessionId,
  timestamp: TIME_MS,
  meta: { 'codebuddy.ai/hostKind': 'workbuddy' },
});

function writeWorkbuddySession(wbHome: string, projectName: string, sessionId: string, body: string) {
  const projDir = join(wbHome, 'projects', projectName);
  mkdirSync(projDir, { recursive: true });
  const file = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(file, body);
  return file;
}

function adapterFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-test-workbuddy-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workbuddyHome = join(dir, 'workbuddy-home');
  mkdirSync(join(workbuddyHome, 'projects'), { recursive: true });

  // Place a real workbuddy.db in WAL mode to confirm transcript reading never touches or locks it.
  const db = new DatabaseSync(join(workbuddyHome, 'workbuddy.db'));
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE sessions (id TEXT, cwd TEXT);');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(S1, join(dir, 'alpha'));
  db.close();

  const adapter = createWorkbuddyNativeAdapter({
    workbuddyHome,
    workbuddyRunning: async () => assert.fail('transcript must not probe WorkBuddy.exe'),
  });
  t.after(() => adapter.close?.());
  assert.ok(adapter.transcript);
  return { dir, workbuddyHome, adapter, read: adapter.transcript };
}

test('WorkBuddy excludes subagents, checks session-meta, redacts reasoning, maps isMeta/MCP tools, paginates, and resets', async (t) => {
  const { workbuddyHome, read } = adapterFixture(t);

  // Subagent file under <proj>/<sessionId>/subagents/ must never be read.
  const subDir = join(workbuddyHome, 'projects', 'alpha', S1, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-1.jsonl'), lines(
    metaRow(S1),
    { id: 'sub-m1', type: 'message', role: 'user', timestamp: TIME_MS, content: [{ type: 'input_text', text: 'subagent-secret' }] },
  ));

  const body = lines(
    metaRow(S1),
    { id: 'snap-1', type: 'file-history-snapshot', timestamp: TIME_MS },
    { id: 'title-1', type: 'ai-title', title: 'Hidden title', timestamp: TIME_MS },
    { id: 'credit-1', type: 'credit-usage', credits: 1, timestamp: TIME_MS },
    { id: 'm1', type: 'message', role: 'user', timestamp: TIME_MS + 1000, content: [{ type: 'input_text', text: 'Check parser' }] },
    {
      id: 'm-meta',
      type: 'message',
      role: 'user',
      timestamp: TIME_MS + 2000,
      content: [{ type: 'input_text', text: '<task-notification>background task finished</task-notification>' }],
      providerData: { isMeta: true },
    },
    { id: 'r1', type: 'reasoning', timestamp: TIME_MS + 3000, content: 'summary-secret', rawContent: 'raw-chain-of-thought-secret' },
    { id: 'm2', type: 'message', role: 'assistant', timestamp: TIME_MS + 4000, content: [{ type: 'output_text', text: 'Checking files now.' }] },
    {
      id: 'fc-defer',
      type: 'function_call',
      callId: 'c-defer',
      name: 'DeferExecuteTool',
      arguments: JSON.stringify({ toolName: 'mcp__orrery__list_agents', params: {} }),
      timestamp: TIME_MS + 5000,
    },
    {
      id: 'fr-defer',
      type: 'function_call_result',
      callId: 'c-defer',
      name: 'DeferExecuteTool',
      status: 'completed',
      output: { type: 'text', text: '[{"name":"W1"}]' },
      timestamp: TIME_MS + 6000,
    },
    { id: 'fc-direct', type: 'function_call', callId: 'c-read', name: 'Read', arguments: '{"file_path":"a.ts"}', timestamp: TIME_MS + 7000 },
    { id: 'future', type: 'unknown_event', secret: 'future-secret', timestamp: TIME_MS + 8000 },
  ) + '{"id":"m-half","type":"message","role":"assistant","content":[{"type":"output_text","text":"half';

  const file = writeWorkbuddySession(workbuddyHome, 'alpha', S1, body);
  const tail = await read(S1, { limit: 2 });
  assert.equal(tail.status, 'ok');
  assert.deepEqual(tail.items.map((i) => [i.kind, i.name]), [['tool_call', 'Read'], ['unknown', 'unknown_event']]);
  assert.equal(tail.unknownCount, 1);
  assert.ok(tail.before);
  assert.ok(tail.after);

  const earlier = await read(S1, { cursor: tail.before, direction: 'before', limit: 32 });
  assert.equal(earlier.status, 'ok');
  assert.equal(earlier.hasMore, false);
  assert.deepEqual(earlier.items.map((i) => [i.kind, i.name]), [
    ['user', undefined],
    ['system', 'meta'],
    ['thinking', undefined],
    ['assistant', undefined],
    ['tool_call', 'mcp__orrery__list_agents'],
    ['tool_result', 'DeferExecuteTool'],
  ]);
  assert.equal(earlier.items[0].text, 'Check parser');
  assert.equal(earlier.items[1].text, '<task-notification>background task finished</task-notification>');
  assert.equal(earlier.items[3].text, 'Checking files now.');
  assert.doesNotMatch(JSON.stringify(earlier), /raw-chain-of-thought-secret|summary-secret|subagent-secret/);

  appendFileSync(file, ' written"}]}\n');
  const after = await read(S1, { cursor: tail.after, direction: 'after', limit: 16 });
  assert.equal(after.status, 'ok');
  assert.deepEqual(after.items.map((i) => [i.kind, i.text]), [['assistant', 'half written']]);

  truncateSync(file, Buffer.byteLength(line(metaRow(S1))) + 10);
  assert.equal((await read(S1, { cursor: tail.before, direction: 'before', limit: 8 })).status, 'reset');

  assert.equal((await read(S2, {})).status, 'missing');
  writeWorkbuddySession(workbuddyHome, 'alpha', S2, line({ type: 'other-format', id: 'x' }));
  assert.equal((await read(S2, {})).status, 'unsupported');
});

test('WorkBuddy rejects invalid IDs, identity conflicts, hardlinks, and junctions, and bounds large reads', async (t) => {
  const { dir, workbuddyHome, read } = adapterFixture(t);
  for (const bad of ['../escape', '.', '..', 'bad id!', 'a/b']) {
    assert.equal((await read(bad, {})).status, 'refused', bad);
  }

  writeWorkbuddySession(workbuddyHome, 'alpha', 'conflict-id', lines(metaRow(S1)));
  assert.equal((await read('conflict-id', {})).status, 'refused');

  const outside = join(dir, 'outside.jsonl');
  writeFileSync(outside, lines(metaRow('hard-id'), { id: 'm1', type: 'message', role: 'user', timestamp: TIME_MS, content: 'outside' }));
  const hardFile = join(workbuddyHome, 'projects', 'alpha', 'hard-id.jsonl');
  linkSync(outside, hardFile);
  assert.equal((await read('hard-id', {})).status, 'refused');

  const targetDir = join(dir, 'external-proj');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'link-id.jsonl'), lines(metaRow('link-id')));
  symlinkSync(targetDir, join(workbuddyHome, 'projects', 'linked-proj'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await read('link-id', {})).status, 'refused');

  // Prefer valid newest session file over another older valid copy; verify bounded reads on > 1 MiB file + > 256 KiB record.
  const older = writeWorkbuddySession(workbuddyHome, 'proj-old', S1, lines(metaRow(S1), { id: 'o1', type: 'message', role: 'user', timestamp: TIME_MS, content: 'old' }));
  utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const filler = line({ id: 'fill', type: 'message', role: 'assistant', timestamp: TIME_MS, content: 'x'.repeat(2048) });
  const oversized = line({ id: 'huge', type: 'message', role: 'assistant', timestamp: TIME_MS, content: 'y'.repeat(270 * 1024) });
  const newer = writeWorkbuddySession(
    workbuddyHome,
    'proj-new',
    S1,
    line(metaRow(S1)) + filler.repeat(700) + oversized + line({ id: 'tail', type: 'message', role: 'user', timestamp: TIME_MS, content: 'Latest WorkBuddy turn' }),
  );
  utimesSync(newer, new Date(1_700_001_000_000), new Date(1_700_001_000_000));

  const page = await read(S1, { limit: 2 });
  assert.equal(page.status, 'ok');
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items.map((i) => [i.kind, i.truncated]), [['unknown', true], ['user', undefined]]);
  assert.equal(page.items[1].text, 'Latest WorkBuddy turn');
  assert.equal(page.unknownCount, 1);
});

test('Hub attributes WorkBuddy TaskOutput/wait deliveries and direct/deferred MCP send_message posts without writes', async (t) => {
  const { dir, workbuddyHome, adapter } = adapterFixture(t);
  const dbDir = mkdtempSync(join(tmpdir(), 'orrery-test-workbuddy-db-'));
  const store = new Store(join(dbDir, 'orrery-test.db'));
  const group = 'cluster-1';
  const other = 'cluster-2';
  const member = (id: string, clusterId: string, workerSessionId: string): NewMember => ({
    id, name: id, clusterId, harness: 'workbuddy', workerSessionId, avatar: null, cwd: dir,
    model: null, effort: null, origin: 'attached', removedAt: null,
  });
  store.insertCluster({ id: group, name: 'Cluster One', category: '', createdAt: TIME_ISO }, [
    member('wb-reader', group, S1),
    member('wb-peer', group, '33333333-3333-4333-8333-333333333333'),
  ]);
  store.insertCluster({ id: other, name: 'Other Cluster', category: '', createdAt: TIME_ISO }, [
    member('wb-foreign', other, S2),
  ]);
  const hub = new Hub({ store, avatarPresets: [], nativeAdapters: { workbuddy: adapter } });
  t.after(async () => {
    await hub.close();
    store.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  const insert = (id: string, body: string, clusterId = group, from = 'user', to = 'wb-reader', direct = false, kind?: Message['kind']) => {
    const [d] = store.insertMessage({ id, clusterId, from, body, kind, mentions: [to], replyTo: null, chainId: id, hop: 0, createdAt: TIME_ISO }, [to], direct);
    return d;
  };
  const deliver = (d: ReturnType<typeof insert>, batchId = d.id) => {
    const running = store.startDelivery(d.id, batchId);
    store.appendEvent(group, d.memberId, 'delivery', { delivery: { ...running, updatedAt: TIME_ISO } });
    store.setDeliveryState(d.id, 'done', null, 'accepted');
  };

  const dBatch = insert('m-wb-batch', 'WorkBuddy batch body', group, 'wb-peer', 'wb-reader');
  deliver(dBatch, dBatch.id);

  const dDirectTask = insert('m-wb-direct-task', 'Direct via TaskOutput', group, 'user', 'wb-reader', true);
  deliver(dDirectTask, dDirectTask.id);

  const dDirectShell = insert('m-wb-direct-shell', 'Direct via Bash wait', group, 'user', 'wb-reader', true);
  deliver(dDirectShell, dDirectShell.id);

  insert('own-direct-mcp', 'Posted via direct MCP', group, 'wb-reader', 'wb-peer');
  insert('own-deferred-mcp', 'Posted via DeferExecuteTool', group, 'wb-reader', 'wb-peer');
  insert('other-post', 'Posted by peer', group, 'wb-peer', 'wb-reader');

  const ticketS1 = ticketFor('secret-test', S1);
  const ticketS2 = ticketFor('secret-test', S2);
  const cmdS1 = waitCommand(ticketS1, 'http://127.0.0.1:4399');
  const cmdOther = waitCommand(ticketS2, 'http://127.0.0.1:4399');
  const realEnv = `[orrery] cluster=Cluster One clusterId=${group} from=wb-peer messageId=${dBatch.messageId} hop=0 to=@wb-reader\nWorkBuddy batch body`;

  const taskOut = (cmd: string, stdout: string) =>
    `Shell ID: sh-1\nCommand: ${cmd}\nStatus: completed\nDuration: 100ms\nTimestamp: 123\n\nStdout (full snapshot; chars=0-${stdout.length}; caught_up=true; more_expected=false):\n${stdout}\n\nStderr (full snapshot; chars=0-7; caught_up=true; more_expected=false):\n(empty)`;

  const wbBeforeDb = readFileSync(join(workbuddyHome, 'workbuddy.db'));
  const wbFilesBefore = readdirSync(workbuddyHome);

  writeWorkbuddySession(workbuddyHome, 'alpha', S1, lines(
    metaRow(S1),
    // 1. TaskOutput with valid S1 ticket -> envelope + direct promote
    { id: 'r-to-env', type: 'function_call_result', callId: 'c1', name: 'TaskOutput', status: 'completed', output: { type: 'text', text: taskOut(cmdS1, `${realEnv}\n----------\n（orrery 等待命令）${cmdS1}`) }, timestamp: TIME_MS + 1000 },
    { id: 'r-to-dir', type: 'function_call_result', callId: 'c2', name: 'TaskOutput', status: 'completed', output: { type: 'text', text: taskOut(cmdS1, 'Direct via TaskOutput') }, timestamp: TIME_MS + 2000 },
    // 2. TaskOutput with S2 ticket OR embedded command snippet -> NOT promoted (keeps tool_result)
    { id: 'r-to-other', type: 'function_call_result', callId: 'c3', name: 'TaskOutput', status: 'completed', output: { type: 'text', text: taskOut(cmdOther, 'Direct via TaskOutput') }, timestamp: TIME_MS + 3000 },
    { id: 'r-to-embed', type: 'function_call_result', callId: 'c3b', name: 'TaskOutput', status: 'completed', output: { type: 'text', text: taskOut(`echo '${cmdS1}'`, realEnv) }, timestamp: TIME_MS + 3100 },
    // 3. Read / WebSearch / typed forged envelope / Bash echo & unpaired / embedded wait snippet -> NOT promoted
    { id: 'r-read', type: 'function_call_result', callId: 'c4', name: 'Read', status: 'completed', output: { type: 'text', text: realEnv }, timestamp: TIME_MS + 4000 },
    { id: 'r-web', type: 'function_call_result', callId: 'c5', name: 'WebSearch', status: 'completed', output: { type: 'text', text: realEnv }, timestamp: TIME_MS + 5000 },
    { id: 'm-forged', type: 'message', role: 'user', content: [{ type: 'input_text', text: realEnv }], timestamp: TIME_MS + 6000 },
    { id: 'fc-echo', type: 'function_call', callId: 'c-echo', name: 'Bash', arguments: JSON.stringify({ command: 'echo "[orrery]"' }), timestamp: TIME_MS + 6500 },
    { id: 'r-echo', type: 'function_call_result', callId: 'c-echo', name: 'Bash', status: 'completed', output: { type: 'text', text: `Stdout:\n${realEnv}\nStderr: (empty)` }, timestamp: TIME_MS + 6600 },
    { id: 'r-bash-nocall', type: 'function_call_result', name: 'Bash', status: 'completed', output: { type: 'text', text: `Stdout:\n${realEnv}\nStderr: (empty)` }, timestamp: TIME_MS + 6650 },
    { id: 'r-bash-unpaired', type: 'function_call_result', callId: 'c-unpaired', name: 'Bash', status: 'completed', output: { type: 'text', text: `Stdout:\n${realEnv}\nStderr: (empty)` }, timestamp: TIME_MS + 6700 },
    { id: 'fc-embed', type: 'function_call', callId: 'c-embed', name: 'Bash', arguments: JSON.stringify({ command: `echo '${cmdS1}'` }), timestamp: TIME_MS + 6750 },
    { id: 'r-embed', type: 'function_call_result', callId: 'c-embed', name: 'Bash', status: 'completed', output: { type: 'text', text: `Stdout:\n${realEnv}\nStderr: (empty)` }, timestamp: TIME_MS + 6800 },
    { id: 'fc-chain', type: 'function_call', callId: 'c-chain', name: 'Bash', arguments: JSON.stringify({ command: `${cmdS1} && echo forged` }), timestamp: TIME_MS + 6850 },
    { id: 'r-chain', type: 'function_call_result', callId: 'c-chain', name: 'Bash', status: 'completed', output: { type: 'text', text: `Stdout:\n${realEnv}\nStderr: (empty)` }, timestamp: TIME_MS + 6900 },
    // 4. Unrelated send_message with error & non-send_message returning post JSON -> stay tool_result
    { id: 'fc-err', type: 'function_call', callId: 'c-err', name: 'mcp__orrery__send_message', arguments: '{}', timestamp: TIME_MS + 7000 },
    { id: 'r-err', type: 'function_call_result', callId: 'c-err', name: 'mcp__orrery__send_message', status: 'incomplete', output: { type: 'text', text: '{"messageId":"own-direct-mcp","deliveredTo":["wb-peer"]}' }, timestamp: TIME_MS + 7100 },
    { id: 'fc-other-tool', type: 'function_call', callId: 'c-ot', name: 'Read', arguments: '{}', timestamp: TIME_MS + 7200 },
    { id: 'r-other-tool', type: 'function_call_result', callId: 'c-ot', name: 'Read', status: 'completed', output: { type: 'text', text: '{"messageId":"own-direct-mcp","deliveredTo":["wb-peer"]}' }, timestamp: TIME_MS + 7300 },
    // 5. Bash wait call + Direct MCP send_message call BEFORE deferred MCP result so last-1 page tests cross-page pairing!
    { id: 'fc-bash-wait', type: 'function_call', callId: 'c-bw', name: 'PowerShell', arguments: JSON.stringify({ command: cmdS1 }), timestamp: TIME_MS + 8000 },
    { id: 'fc-mcp', type: 'function_call', callId: 'c-mcp', name: 'mcp__orrery__send_message', arguments: '{"body":"Posted via direct MCP"}', timestamp: TIME_MS + 8100 },
    { id: 'fc-defer', type: 'function_call', callId: 'c-def', name: 'DeferExecuteTool', arguments: JSON.stringify({ toolName: 'mcp__orrery__send_message', params: { body: 'Posted via DeferExecuteTool' } }), timestamp: TIME_MS + 8200 },
    { id: 'r-bash-wait', type: 'function_call_result', callId: 'c-bw', name: 'PowerShell', status: 'completed', output: { type: 'text', text: 'Stdout:\nDirect via Bash wait\nStderr: (empty)' }, timestamp: TIME_MS + 8300 },
    { id: 'r-mcp', type: 'function_call_result', callId: 'c-mcp', name: 'mcp__orrery__send_message', status: 'completed', output: { type: 'text', text: '{"messageId":"own-direct-mcp","deliveredTo":["wb-peer"]}' }, timestamp: TIME_MS + 8400 },
    { id: 'r-defer', type: 'function_call_result', callId: 'c-def', name: 'DeferExecuteTool', status: 'completed', output: { type: 'text', text: '{"messageId":"own-deferred-mcp","deliveredTo":["wb-peer"]}' }, timestamp: TIME_MS + 8500 },
  ));

  const eventsBefore = store.lastEventSeq();

  // Check cross-page pairing when tail limit = 3 excludes the matching function_calls.
  const tail3 = await hub.memberTranscript('wb-reader', { limit: 3 });
  assert.equal(tail3.status, 'ok');
  assert.deepEqual(tail3.items.map((i) => [i.kind, i.messageId]), [
    ['orrery_delivery', undefined],
    ['orrery_post', 'own-direct-mcp'],
    ['orrery_post', 'own-deferred-mcp'],
  ]);
  assert.deepEqual(tail3.items[0].parts, [{ messageId: dDirectShell.messageId, from: 'user', kind: 'chat', body: 'Direct via Bash wait' }]);

  const full = await hub.memberTranscript('wb-reader', { limit: 32 });
  assert.equal(full.status, 'ok');
  assert.deepEqual(full.items.map((i) => [i.kind, i.messageId]), [
    ['orrery_delivery', undefined],
    ['orrery_delivery', undefined],
    ['tool_result', undefined],
    ['tool_result', undefined],
    ['tool_result', undefined],
    ['tool_result', undefined],
    ['user', undefined],
    ['tool_call', undefined],
    ['tool_result', undefined],
    ['tool_result', undefined],
    ['tool_result', undefined],
    ['tool_call', undefined],
    ['tool_result', undefined],
    ['tool_call', undefined],
    ['tool_result', undefined],
    ['tool_call', undefined],
    ['tool_result', undefined],
    ['tool_call', undefined],
    ['tool_result', undefined],
    ['tool_call', undefined],
    ['tool_call', undefined],
    ['tool_call', undefined],
    ['orrery_delivery', undefined],
    ['orrery_post', 'own-direct-mcp'],
    ['orrery_post', 'own-deferred-mcp'],
  ]);
  assert.deepEqual(full.items[0].parts, [{ messageId: dBatch.messageId, from: 'wb-peer', kind: 'chat', body: 'WorkBuddy batch body' }]);
  assert.deepEqual(full.items[1].parts, [{ messageId: dDirectTask.messageId, from: 'user', kind: 'chat', body: 'Direct via TaskOutput' }]);
  const fullJson = JSON.stringify(full);
  assert.ok(!fullJson.includes(ticketS1), 'session S1 wait ticket must be redacted');
  assert.ok(!fullJson.includes(ticketS2), 'session S2 wait ticket must be redacted');
  assert.ok(full.items.every((i) => !('source' in i)));
  assert.equal(store.lastEventSeq(), eventsBefore);
  assert.deepEqual(readFileSync(join(workbuddyHome, 'workbuddy.db')), wbBeforeDb);
  assert.deepEqual(readdirSync(workbuddyHome), wbFilesBefore);
});
