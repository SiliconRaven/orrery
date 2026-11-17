import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { handleBridge } from '../src/mcp/bridge.ts';
import { tempDir } from './helpers.ts';

test('bridge done validates and returns structured outcomes only to the matching wait, preserving legacy done', async () => {
  const store = new Store(':memory:');
  const hub = new Hub({ store, nativeAdapters: {},  limits: { bridgeAckMs: 20 } });
  const server = createServer((req, res) => { void handleBridge(hub, 'test-secret', req, res); });
  const disconnect = hub.connectBridge('fake', 's1', { send() {}, close() {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const post = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/bridge/done`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-bridge': 'test-secret' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const wait = hub.bridge.waitDone('fake', 's1', 'd1', 1000, new AbortController().signal);
    const base = { deliveryId: 'd1', harness: 'fake', sessionId: 's1' };
    for (const bad of [{ outcome: 'accepted' }, { outcome: null }, { outcome: 'failed', error: 1 }, { error: 'oops' }]) {
      assert.equal((await post({ ...base, ...bad })).status, 400);
    }
    assert.deepEqual(await post({ ...base, sessionId: 'other', outcome: 'completed' }), { status: 200, body: { done: false } });
    assert.deepEqual(await post({ ...base, outcome: 'unknown', error: 'connection lost' }), { status: 200, body: { done: true } });
    assert.deepEqual(await wait, { outcome: 'unknown', error: 'connection lost' });
    const legacy = hub.bridge.waitDone('fake', 's1', 'd2', 1000, new AbortController().signal);
    assert.deepEqual(await post({ ...base, deliveryId: 'd2' }), { status: 200, body: { done: true } });
    assert.equal(await legacy, 'done');
    assert.deepEqual(await hub.bridge.push('fake', 's1', 'd-timeout', 'message'), {
      ok: false, outcome: 'unknown', error: 'bridge did not ack within 20 ms',
    });
  } finally {
    disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await hub.close();
    store.close();
  }
});
