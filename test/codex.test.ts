// Codex protocol pieces without a real model: JSON-RPC framing, the approval answers and the model catalog the native
// adapter uses (src/adapters/codex/rpc.ts, protocol.ts). The native adapter itself: test/codex-native.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { decideServerRequest, fetchModels } from '../src/adapters/codex/protocol.ts';
import { RpcPeer } from '../src/adapters/codex/rpc.ts';

const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));

// ---- JSON-RPC framing ----

test('codex rpc: splits lines across chunks, matches responses, answers server requests', async () => {
  const out = new PassThrough();
  const input = new PassThrough();
  const notes: string[] = [];
  const written: string[] = [];
  out.on('data', (d) => written.push(String(d)));
  const peer = new RpcPeer(out, input, {
    onNotification: (m) => notes.push(m),
    onRequest: async (m) => { if (m === 'bad') throw new Error('nope'); return { ok: m }; },
    onClose: () => {},
  });
  const a = peer.request('a', {});
  const b = peer.request('b', {});
  assert.deepEqual(written.map((l) => JSON.parse(l)), [
    { jsonrpc: '2.0', id: 1, method: 'a', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'b', params: {} },
  ]);
  // Responses out of order, one split across chunks, two in one chunk; app-server omits "jsonrpc".
  input.write('{"id":2,"result":"B"}\n{"method":"n1","params":{}}\n{"id":1,');
  input.write('"result":"A"}\n');
  assert.equal(await a, 'A');
  assert.equal(await b, 'B');
  input.write('{"id":7,"method":"ask","params":{}}\n{"id":8,"method":"bad"}\n');
  await tick();
  assert.deepEqual(written.slice(2).map((l) => JSON.parse(l)), [
    { jsonrpc: '2.0', id: 7, result: { ok: 'ask' } },
    { jsonrpc: '2.0', id: 8, error: { code: -32603, message: 'nope' } },
  ]);
  assert.deepEqual(notes, ['n1']);
  const c = peer.request('c', {});
  input.write('{"id":3,"error":{"code":-32600,"message":"thread not found"}}\n');
  await assert.rejects(c, /c failed: thread not found/);
  const ac = new AbortController();
  const aborted = peer.request('slow', {}, ac.signal);
  ac.abort();
  await assert.rejects(aborted, /slow: aborted/);
  input.write('{"id":4,"result":"too late"}\n');   // a late answer to an abandoned request is ignored
  const d = peer.request('d', {});
  input.end();
  await assert.rejects(d, /output ended/);
  await assert.rejects(peer.request('e', {}), /output ended/);
});

test('codex rpc: a failing stdin write closes the peer and rejects what is pending, instead of crashing', async () => {
  const out = new Writable({ write: (_c, _e, cb) => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) });
  let closedWith = '';
  const peer = new RpcPeer(out, new PassThrough(), { onNotification: () => {}, onRequest: async () => ({}), onClose: (r) => { closedWith = r; } });
  await assert.rejects(peer.request('initialize', {}), /input error: write EPIPE/);
  assert.match(closedWith, /EPIPE/);
  await assert.rejects(peer.request('again', {}), /EPIPE/);
});

test('codex rpc: an exception from a handler closes the peer instead of escaping the reader', async () => {
  let closedWith = '';
  const input = new PassThrough();
  const peer = new RpcPeer(new PassThrough(), input, {
    onNotification: () => { throw new Error('bad handler'); },
    onRequest: async () => ({}),
    onClose: (r) => { closedWith = r; },
  });
  const pending = peer.request('x', {});
  assert.doesNotThrow(() => peer.feed('{"method":"n","params":{}}\n'));
  await assert.rejects(pending, /handling an app-server message failed: bad handler/);
  assert.match(closedWith, /bad handler/);
});

// ---- approvals and the model catalog ----

test('codex: approvals — every request orrery answers is declined, an orrery tool prompt too', () => {
  for (const serverName of ['orrery', 'other-server']) {
    const prompt = decideServerRequest('mcpServer/elicitation/request', { serverName, mode: 'form', message: 'Allow run?' });
    assert.equal((prompt.result as any).action, 'decline');
    assert.match(prompt.declined, new RegExp(serverName));
  }
  assert.deepEqual(decideServerRequest('item/commandExecution/requestApproval', { command: 'rm -rf x' }).result, { decision: 'decline' });
  assert.deepEqual(decideServerRequest('item/fileChange/requestApproval', {}).result, { decision: 'decline' });
  assert.deepEqual(decideServerRequest('item/permissions/requestApproval', {}).result, { permissions: {}, scope: 'turn' });
  assert.deepEqual(decideServerRequest('item/tool/requestUserInput', {}).result, { answers: {} });
  assert.deepEqual(decideServerRequest('item/tool/call', { tool: 'x' }).result, { contentItems: [], success: false });
  assert.deepEqual((decideServerRequest('execCommandApproval', { command: ['rm'] }).result as any).decision.denied.rejection, 'declined by orrery');
  for (const m of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval']) {
    assert.ok(decideServerRequest(m, {}).declined, m);
  }
  assert.throws(() => decideServerRequest('account/chatgptAuthTokens/refresh', {}), /does not handle/);
});

/** One v2/Model entry as model/list sends it. */
const catalogEntry = (model: string, displayName: string, efforts: string[], isDefault = false) => ({
  id: `${model}-entry`, model, displayName, description: '', hidden: false, isDefault, defaultReasoningEffort: efforts[0] ?? 'medium',
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
});

/** A model/list peer answering from `pages` by cursor, recording what it was asked. */
function catalog(pages: Record<string, unknown>) {
  const asked: unknown[] = [];
  const rpc = { request: async (method: string, params: { cursor: string | null }) => {
    assert.equal(method, 'model/list');
    asked.push(params);
    return pages[params.cursor ?? ''];
  } } as unknown as RpcPeer;
  return { rpc, asked };
}

test('codex: fetchModels pages through model/list, keeps one entry per model name with its efforts and the default', async () => {
  const { rpc, asked } = catalog({
    '': { data: [catalogEntry('gpt-a', 'GPT-A', ['low', 'high'], true), catalogEntry('gpt-b', 'GPT-B', [])], nextCursor: 'p2' },
    p2: { data: [catalogEntry('gpt-a', 'GPT-A again', ['low']), catalogEntry('gpt-c', 'GPT-C', ['medium'])], nextCursor: null },
  });
  assert.deepEqual(await fetchModels(rpc), [
    { id: 'gpt-a', label: 'GPT-A', efforts: ['low', 'high'], isDefault: true },
    { id: 'gpt-b', label: 'GPT-B', efforts: [] },
    { id: 'gpt-c', label: 'GPT-C', efforts: ['medium'] },
  ]);
  assert.deepEqual(asked, [{ cursor: null }, { cursor: 'p2' }]);
});

test('codex: fetchModels skips entries without a model name and drops efforts that are not strings', async () => {
  const { rpc } = catalog({ '': {
    data: [
      { ...catalogEntry('x', 'No name', ['low']), model: undefined },
      { ...catalogEntry('x', 'Empty', ['low']), model: '' },
      { ...catalogEntry('x', 'Number', ['low']), model: 42 },
      null,
      { ...catalogEntry('gpt-a', 'GPT-A', []), supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 7 }, null, {}] },
      { ...catalogEntry('gpt-b', '', []), supportedReasoningEfforts: 'high', isDefault: 'yes' },
    ],
    nextCursor: null,
  } });
  assert.deepEqual(await fetchModels(rpc), [
    { id: 'gpt-a', label: 'GPT-A', efforts: ['low'] },
    { id: 'gpt-b', efforts: [] },
  ]);
});
