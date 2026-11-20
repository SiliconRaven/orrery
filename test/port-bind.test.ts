import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { bindAvoidingUserPort, listenLoopback } from '../src/main.ts';

test('port 0 retries the user port and an explicit port is bound once', async () => {
  const binds: number[] = [];
  let released = 0;
  const drawn = [4317, 4317, 18080];
  const got = await bindAvoidingUserPort(0, async (port) => {
    binds.push(port);
    return drawn.shift()!;
  }, async () => { released++; });
  assert.equal(got, 18080);
  assert.deepEqual(binds, [0, 0, 0]);
  assert.equal(released, 2);

  const explicit = await bindAvoidingUserPort(4317, async (port) => port + 1, async () => { throw new Error('released an explicit port'); });
  assert.equal(explicit, 4318);

  await assert.rejects(
    bindAvoidingUserPort(0, async () => 4317, async () => {}, 4317, 2),
    /port 4317 2 times/,
  );
});

test('listenLoopback on port 0 is not 4317, and an occupied explicit port fails once', async () => {
  const held = createServer();
  const port = await listenLoopback(held, 0);
  assert.notEqual(port, 4317);
  assert.equal((held.address() as AddressInfo).port, port);
  const other = createServer();
  await assert.rejects(listenLoopback(other, port), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE');
  await new Promise<void>((ok) => held.close(() => ok()));
});
