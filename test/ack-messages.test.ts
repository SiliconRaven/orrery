import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { holdScript, memberHeaders, startTestHub, turnsOf, waitFor } from './helpers.ts';

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'ack-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as any)[0].text;
  return { error: result.isError === true, data: result.isError ? null : JSON.parse(text) };
}

test('explicit acknowledgement: MCP identity, atomic batches, receipts, history and SSE', async () => {
  const holds: ReturnType<typeof holdScript>[] = [];
  const release = () => holds.forEach((hold) => hold.release());
  const app = await startTestHub({ mock: { script: (msg, ...args) => {
    const hold = holdScript();
    holds.push(hold);
    return hold.script(msg, ...args);
  } } });
  try {
    const { cluster, members: [a, b] } = await app.cluster('one', ['A', 'B']);
    const { cluster: other, members: [x] } = await app.cluster('other', ['X']);
    const running = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@all hold' });
    await app.api('POST', `/api/clusters/${other.id}/messages`, { body: '@X hold' });
    const cross = await app.api('POST', `/api/clusters/${other.id}/messages`, { body: 'other' });
    await waitFor(() => [a, b, x].every((m) => turnsOf(app, m.id) === 1), 'held turns');
    const token = (id: string) => memberHeaders(app, id);
    const ca = await connect(app.url, token(a.id));
    const cb = await connect(app.url, token(b.id));
    const cx = await connect(app.url, token(x.id));
    try {
      const own = (await call(ca, 'send_message', { body: 'a normal 👍 in the body' })).data.messageId;
      const note = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'record only' });
      assert.deepEqual((await app.messages(cluster.id)).find((m) => m.id === own)!.acknowledgements, []);
      await call(cb, 'read_messages', { history: true });
      const before = app.store.listEvents(0).length;
      const result = await call(cb, 'ack_messages', { messageIds: [own, running.id] });
      assert.deepEqual(result.data, { acknowledged: [own, running.id] });
      assert.deepEqual((await call(cb, 'ack_messages', { messageIds: [own, running.id] })).data, result.data);
      const acknowledgements = app.store.db.prepare('SELECT * FROM message_acknowledgements ORDER BY message_id').all();
      assert.equal(acknowledgements.length, 2);
      assert.equal(app.events.filter((e) => e.kind === 'acknowledgement').length, 1);
      assert.equal((app.store.db.prepare('SELECT via FROM reads WHERE member_id = ? AND message_id = ?').get(b.id, own) as any).via, 'read_messages');
      assert.equal((await app.messages(cluster.id)).find((m) => m.id === running.id)!.deliveries.find((d) => d.memberId === b.id)!.state, 'running');
      assert.deepEqual((await app.messages(cluster.id)).find((m) => m.id === own)!.acknowledgements.map((x: any) => x.memberId), [b.id]);
      const aHistory = (await call(ca, 'read_messages', { history: true })).data;
      assert.deepEqual(aHistory.find((m: any) => m.id === own).acknowledgements.map((x: any) => x.member), ['B']);
      const bHistory = (await call(cb, 'read_messages', { history: true })).data;
      assert.deepEqual(bHistory.find((m: any) => m.id === own).acknowledgements.map((x: any) => x.member), ['B']);
      assert.deepEqual(bHistory.find((m: any) => m.id === note.id).acknowledgements, []);
      assert.equal('deliveries' in bHistory.find((m: any) => m.id === own), false);
      assert.equal(bHistory.some((m: any) => m.id === cross.id), false);
      const xHistory = (await call(cx, 'read_messages', { history: true })).data;
      assert.equal(xHistory.some((m: any) => m.id === own || m.id === running.id), false);
      assert.ok(xHistory.every((m: any) => Array.isArray(m.acknowledgements)));

      for (const messageIds of [[], [own, own], [note.id, cross.id], [note.id, 'missing'], [note.id, own, own], Array(101).fill('x')]) {
        assert.equal((await call(cb, 'ack_messages', { messageIds })).error, true);
      }
      assert.equal((await call(ca, 'ack_messages', { messageIds: [note.id, own] })).error, true, 'own message rejects entire batch');
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM message_acknowledgements').get()!.n, 2);

      const unread = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@B unread' });
      assert.equal((await call(ca, 'ack_messages', { messageIds: [unread.id] })).error, false);
      const bUnread = (await call(cb, 'read_messages', {})).data;
      assert.deepEqual(bUnread.find((m: any) => m.id === unread.id).acknowledgements.map((a: any) => a.member), ['A']);
      assert.equal('deliveries' in bUnread.find((m: any) => m.id === unread.id), false);

      // A failure recording the event rolls back the acknowledgement and its new read.
      const fresh = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: 'fresh' });
      const append = app.store.appendEvent;
      app.store.appendEvent = (...args) => {
        if (args[2] === 'acknowledgement') throw new Error('injected event failure');
        return append.apply(app.store, args);
      };
      try { assert.equal((await call(cb, 'ack_messages', { messageIds: [fresh.id] })).error, true); }
      finally { app.store.appendEvent = append; }
      assert.deepEqual(app.store.acknowledgementsOf(fresh.id), []);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM reads WHERE member_id = ? AND message_id = ?').get(b.id, fresh.id)!.n, 0);
      assert.equal((await call(cb, 'ack_messages', { messageIds: [fresh.id] })).error, false);
      assert.equal((app.store.db.prepare('SELECT via FROM reads WHERE member_id = ? AND message_id = ?').get(b.id, fresh.id) as any).via, 'ack_messages');

      const controller = new AbortController();
      const response = await fetch(`${app.url}/api/stream?since=${before}`, { signal: controller.signal });
      const reader = response.body!.getReader();
      let stream = '';
      while (!stream.includes('"kind":"acknowledgement"')) stream += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      assert.match(stream, /"acknowledgements":/);

      const batch = Array.from({ length: 100 }, (_, i) => app.hub.sendFromUser(cluster.id, `batch ${i}`).id);
      assert.deepEqual((await call(cb, 'ack_messages', { messageIds: batch })).data, { acknowledged: batch }, 'the maximum valid batch works');
      app.hub.updateMember(b.id, { name: 'Bee' });
      app.hub.removeMember(cluster.id, b.id);
      const afterRemoval = (await call(ca, 'read_messages', { history: true, before: batch[0] })).data;
      assert.deepEqual(afterRemoval.find((m: any) => m.id === own).acknowledgements.map((x: any) => x.member), ['Bee']);
      assert.equal((await call(cb, 'read_messages', {})).error, true, 'a removed member loses its identity');
    } finally {
      await ca.close();
      await cb.close();
      await cx.close();
    }
    release();
    await waitFor(() => app.settled(cluster.id), 'held deliveries settle');
    const late = await connect(app.url, token(b.id));
    try { assert.equal((await call(late, 'ack_messages', { messageIds: [running.id] })).error, true, 'a removed identity cannot act'); }
    finally { await late.close(); }
  } finally {
    release();
    await app.close();
  }
});
