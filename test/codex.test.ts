// JSON-RPC framing shared by the native Codex adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { RpcPeer } from '../src/adapters/codex/rpc.ts';
const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));
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
