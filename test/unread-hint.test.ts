import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Store } from '../src/core/store.ts';
import type { Cluster, Member, Message } from '../src/core/types.ts';
import { nativeHeaders, holdScript, insertMessageWithEvent, startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

test('every tool result carries a changed unread hint, except read_messages and ack_messages', async () => {
  const hold = holdScript();
  const app = await startTestHub({ dir: tempDir(), mock: { script: hold.script } });
  let client: Client | undefined;
  try {
    const { cluster, members: [member] } = await app.cluster('hint', ['A']);
    app.hub.sendFromUser(cluster.id, '@A hold');
    client = new Client({ name: 'unread-hint-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), { requestInit: { headers: nativeHeaders(app, member.id) } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client!.callTool({ name, arguments: args });
      return (result.content as { type: string; text: string }[]).map((block) => block.text);
    };
    app.hub.sendFromUser(cluster.id, '@A hello');
    const first = await call('list_agents', {});
    assert.equal(first.length, 2, 'the hint is an extra content block');
    assert.equal(first[1], 'orrery：未读 2：点名你 2，方便时用 read_messages 查看');
    const second = await call('list_agents', {});
    assert.equal(second.length, 1, 'the same count is not repeated');
    const read = await call('read_messages', {});
    assert.equal(read.length, 1, 'read_messages adds no hint');
    const messageId = JSON.parse(read[0]).messages?.[0]?.id;
    const ack = await call('ack_messages', { messageIds: messageId ? [messageId] : [] }).catch(() => null);
    if (ack) assert.equal(ack.length, 1, 'ack_messages adds no hint');
    app.hub.sendFromUser(cluster.id, '@A again');
    const third = await call('list_tasks', {});
    assert.equal(third.length, 2);
    assert.match(third[1], /未读 1：点名你 1/);
  } finally {
    hold.release();
    await client?.close();
    await app.close();
  }
});

/** A Hub with `sessions` as native members of one cluster each (mock native 'queue' kind, so a message goes straight to done). */
async function withBound(fn: (ctx: {
  app: TestHub; cluster: Cluster; member: Member;
  hint: (session?: string, harness?: string) => Promise<{ status: number; body: any }>;
}) => Promise<void>): Promise<void> {
  const app = await startTestHub();
  try {
    const { cluster, members: [member] } = await app.hub.createCluster('hint-native', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
    const hint = async (session = 's1', harness = 'mock') => {
      const r = await fetch(`${app.url}/bridge/unread-hint`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-bridge': secret }, body: JSON.stringify({ harness, session }),
      });
      return { status: r.status, body: await r.json() };
    };
    await fn({ app, cluster, member, hint });
  } finally {
    await app.close();
  }
}

const message = (clusterId: string, from: string, to: string, body: string): Message =>
  ({ id: randomUUID(), clusterId, from, mentions: [to], body, replyTo: null, chainId: randomUUID(), hop: 0, createdAt: new Date().toISOString() });

/** Puts `n` unread messages from the user in front of the member without delivering them. */
const unread = ({ app, cluster, member }: { app: TestHub; cluster: Cluster; member: Member }, n: number, from = 'user') => {
  for (let i = 0; i < n; i++) {
    insertMessageWithEvent(app.store, message(cluster.id, from, member.id, `secret body ${i}`));
  }
};
const hintEvents = (app: TestHub) => app.events.filter((e) => e.kind === 'unread_hint');

test('POST /bridge/unread-hint: only a bound conversation gets content, and one line of numbers', async () => {
  await withBound(async (ctx) => {
    const { app, member, hint } = ctx;
    unread(ctx, 2);
    assert.deepEqual(await hint('stranger'), { status: 200, body: {} }, 'a conversation that never joined');
    assert.deepEqual(await hint('s1', 'codex'), { status: 200, body: {} }, 'the same id under another harness');
    assert.deepEqual(hintEvents(app), [], 'nobody was told, nothing recorded');

    const wrongKey = await fetch(`${app.url}/bridge/unread-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-bridge': 'wrong' }, body: JSON.stringify({ harness: 'mock', session: 's1' }),
    });
    assert.equal(wrongKey.status, 401);
    assert.deepEqual(await wrongKey.json(), { error: 'unauthorized' });
    assert.equal((await hint('')).status, 400);

    const got = await hint();
    assert.deepEqual(got, { status: 200, body: { hint: 'orrery：未读 2：点名你 2，方便时用 read_messages 查看' } });
    assert.doesNotMatch(got.body.hint, /\n|secret body/);
    assert.ok(!got.body.hint.includes(member.id));
    assert.deepEqual(hintEvents(app).map((e) => [e.memberId, e.payload]), [[member.id, { count: 2 }]], 'the event has only member and count');
  });
});

test('unread hint: an unchanged count is not repeated, any change is, and reaching 0 clears the record', async () => {
  await withBound(async (ctx) => {
    const { app, cluster, member, hint } = ctx;
    unread(ctx, 1);
    assert.match((await hint()).body.hint, /未读 1：点名你 1/);
    assert.deepEqual((await hint()).body, {}, 'same count');
    unread(ctx, 1, 'other-member');
    assert.match((await hint()).body.hint, /未读 2：点名你 2/, 'a mention from a member updates the count');
    assert.deepEqual((await hint()).body, {});
    app.store.markRead(member.id, app.store.unreadIds(member.id, cluster.id), 'read_messages');
    assert.deepEqual((await hint()).body, {}, 'nothing unread');
    unread(ctx, 2);
    assert.match((await hint()).body.hint, /未读 2：点名你 2/, 'the same count as before 0 is a new change');
    assert.equal(hintEvents(app).length, 3, 'one event per hint returned');
  });
});

test('unread hint: tool results and the per-tool path share the record, so one change gives one hint', async () => {
  await withBound(async (ctx) => {
    const { app, member, hint } = ctx;
    unread(ctx, 1);
    assert.match(app.hub.unreadHint([member]), /未读 1：点名你 1/, 'the tool-result path goes first');
    assert.deepEqual((await hint()).body, {}, 'the hook path sees no change');
    unread(ctx, 1);
    assert.match((await hint()).body.hint, /未读 2：点名你 2/, 'the hook path goes first');
    assert.equal(app.hub.unreadHint([member]), '', 'the tool-result path sees no change');
    assert.equal(hintEvents(app).length, 2);
  });
});

test('unread hint: a global or cluster pause gives no hint and does not advance the record', async () => {
  await withBound(async (ctx) => {
    const { app, cluster, hint } = ctx;
    unread(ctx, 1);
    app.hub.setPaused(true);
    assert.deepEqual((await hint()).body, {}, 'global pause');
    app.hub.setPaused(false);
    const pause = (paused: boolean, operationId: string) => app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'cluster.pause', operationId, paused });
    pause(true, 'p1');
    assert.deepEqual((await hint()).body, {}, 'cluster pause');
    assert.equal(app.hub.unreadHint([ctx.member]), '', 'the tool-result path pauses too');
    assert.deepEqual(hintEvents(app), []);
    pause(false, 'r1');
    assert.match((await hint()).body.hint, /未读 1：点名你 1/, 'the change is still unhinted after the pause');
  });
});

test('unread hint: a conversation in two clusters gets one line and each member page its own count; a paused one is left out', async () => {
  const app = await startTestHub();
  try {
    const one = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const two = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    unread({ app, cluster: one.cluster, member: one.members[0] }, 2);
    unread({ app, cluster: two.cluster, member: two.members[0] }, 1);
    app.hub.collaboration.command({ kind: 'user' }, two.cluster.id, { action: 'cluster.pause', operationId: 'p', paused: true });
    assert.equal(app.hub.unreadHintFor('mock', 's1'), 'orrery：未读 2：点名你 2，方便时用 read_messages 查看');
    app.hub.collaboration.command({ kind: 'user' }, two.cluster.id, { action: 'cluster.pause', operationId: 'r', paused: false });
    assert.equal(app.hub.unreadHintFor('mock', 's1'), 'orrery：未读 3：点名你 3，方便时用 read_messages 查看，分布在 2 个群');
    assert.equal(app.hub.unreadHintFor('mock', 's1'), '');
    assert.deepEqual(hintEvents(app).map((e) => [e.memberId, e.payload]), [
      [one.members[0].id, { count: 2 }], [one.members[0].id, { count: 2 }], [two.members[0].id, { count: 1 }],
    ]);
  } finally {
    await app.close();
  }
});

test('unread hint: it creates no deliveries or turns and writes only its own event', async () => {
  await withBound(async (ctx) => {
    const { app, cluster, hint } = ctx;
    unread(ctx, 2);
    const delivered = app.native.delivered.length;
    const deliveries = () => app.store.listEvents(0).filter((e) => e.kind === 'delivery').length;
    const before = deliveries();
    const eventsBefore = app.events.length;
    assert.ok((await hint()).body.hint);
    await sleep(50);
    assert.equal(app.native.delivered.length, delivered);
    assert.equal(app.native.delivered.length, 0);
    assert.equal(deliveries(), before);
    assert.deepEqual(await app.api('GET', `/api/clusters/${cluster.id}/messages`).then((all: any[]) => all.flatMap((m) => m.deliveries)), []);
    assert.deepEqual(app.events.slice(eventsBefore).map((e) => e.kind), ['unread_hint']);
  });
});

test('unread hint: when the event cannot be saved there is no hint, and the next call gets both', async () => {
  await withBound(async (ctx) => {
    const { app, member, hint } = ctx;
    unread(ctx, 1);
    const appendEvent = app.store.appendEvent;
    app.store.appendEvent = function (this: Store, ...args: Parameters<Store['appendEvent']>) {
      if (args[2] === 'unread_hint') throw new Error('disk full');
      return appendEvent.apply(this, args);
    };
    assert.deepEqual(await hint(), { status: 200, body: {} }, 'the hook path');
    assert.equal(app.hub.unreadHint([member]), '', 'the tool-result path does not throw, so the tool still succeeds');
    app.store.appendEvent = appendEvent;
    assert.match((await hint()).body.hint, /未读 1：点名你 1/, 'the count was not consumed');
    assert.deepEqual(app.store.listEvents(0).filter((e) => e.kind === 'unread_hint').map((e) => [e.memberId, e.payload]), [[member.id, { count: 1 }]]);
  });
});

test('unread hint: a listener that throws costs neither the other records nor the other listeners', async () => {
  const app = await startTestHub();
  try {
    const one = await app.hub.createCluster('one', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    const two = await app.hub.createCluster('two', [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }]);
    unread({ app, cluster: one.cluster, member: one.members[0] }, 1);
    unread({ app, cluster: two.cluster, member: two.members[0] }, 1);
    app.hub.subscribe((e) => { if (e.kind === 'unread_hint') throw new Error('listener failed'); });
    const heard: unknown[] = [];
    app.hub.subscribe((e) => { if (e.kind === 'unread_hint') heard.push(e.memberId); });
    assert.equal(app.hub.unreadHintFor('mock', 's1'), 'orrery：未读 2：点名你 2，方便时用 read_messages 查看，分布在 2 个群');
    const both = [one.members[0].id, two.members[0].id];
    assert.deepEqual(app.store.listEvents(0).filter((e) => e.kind === 'unread_hint').map((e) => e.memberId), both, 'both records are saved');
    assert.deepEqual(heard, both, 'the listener after the failing one hears both');
    assert.equal(app.hub.unreadHintFor('mock', 's1'), '', 'the hint was given once');
  } finally {
    await app.close();
  }
});
