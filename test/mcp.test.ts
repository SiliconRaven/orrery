// Native MCP identity comes from an authenticated bridge and its bound conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nativeHeaders, holdScript, mcpStatus, startTestHub, waitFor } from './helpers.ts';

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
    requestInit: { headers },
  }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as any)[0].text;
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) };
};

test('7: the bridge conversation is the sender; bad credentials get 401; clusters stay separate', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  try {
    const { cluster: c1, members: [a, b] } = await app.cluster('c1', ['A', 'B']);
    const { cluster: c2, members: [x] } = await app.cluster('c2', ['X']);
    await app.api('POST', `/api/clusters/${c1.id}/messages`, { body: '@all hold' });
    await app.api('POST', `/api/clusters/${c2.id}/messages`, { body: '@all hold' });
    await waitFor(() => app.native.delivered.length === 3, 'three deliveries started');
    const headersB = nativeHeaders(app, b.id);
    const headersX = nativeHeaders(app, x.id);

    assert.equal(await mcpStatus(app.url, {}), 401);
    assert.equal(await mcpStatus(app.url, { 'x-orrery-bridge': 'wrong', 'x-orrery-session': 'unknown' }), 401);
    assert.equal(await mcpStatus(app.url, { authorization: 'not-supported' }), 401, 'token without Bearer scheme');
    await assert.rejects(connect(app.url, { 'x-orrery-bridge': 'wrong', 'x-orrery-session': 'unknown' }));

    const clientB = await connect(app.url, headersB);
    const clientX = await connect(app.url, headersX);
    try {
      const agents = await call(clientB, 'list_agents', {});
      assert.deepEqual(agents.data.map((m: any) => [m.name, m.harness, m.model]), [['A', 'mock', 'mock-1'], ['B', 'mock', 'mock-1']]);

      // An extra "from" argument must not change who the sender is.
      const sent = await call(clientB, 'send_message', { body: '@A hi from B', from: a.id });
      assert.deepEqual(sent.data.deliveredTo, ['A']);
      const stored = (await app.messages(c1.id)).find((m) => m.id === sent.data.messageId)!;
      assert.deepEqual([stored.from, stored.mentions, stored.clusterId], [b.id, [a.id], c1.id]);

      // X (cluster 2) sees only its own cluster and cannot reach A.
      assert.deepEqual((await call(clientX, 'list_agents', {})).data.map((m: any) => m.name), ['X']);
      const fromX = await call(clientX, 'send_message', { body: '@A are you there?' });
      assert.deepEqual(fromX.data.deliveredTo, []);
      const xMsgs = await app.messages(c2.id);
      assert.deepEqual([xMsgs.length, xMsgs[1].mentions, xMsgs[1].deliveries], [2, [], []]);
      assert.deepEqual((await call(clientX, 'read_messages', { history: true })).data.map((m: any) => m.body), ['@all hold', '@A are you there?']);
      const crossReply = await call(clientX, 'send_message', { body: 'reply', replyTo: stored.id });
      assert.equal(crossReply.isError, true);

      // read_messages history paging: limit and before.
      await call(clientB, 'send_message', { body: 'second' });
      const page = await call(clientB, 'read_messages', { limit: 1, history: true });
      assert.deepEqual(page.data.map((m: any) => [m.from, m.body]), [['B', 'second']]);
      const older = await call(clientB, 'read_messages', { before: page.data[0].id });
      assert.deepEqual(older.data.map((m: any) => m.body), ['@all hold', '@A hi from B']);

      // An @name that matches no member is reported, and a message that reaches nobody carries a warning.
      const unknown = await call(clientB, 'send_message', { body: '@Ghost are you there?' });
      assert.deepEqual([unknown.data.deliveredTo, unknown.data.unresolvedMentions], [[], ['Ghost']]);
      assert.match(unknown.data.warning, /only stays in the chat record/);
      assert.match(unknown.data.warning, /Available member names: A, B\./);
    } finally {
      await clientB.close();
      await clientX.close();
    }

    hold.release();
    await waitFor(() => app.settled(c1.id), 'settled');
    assert.equal(await mcpStatus(app.url, headersB), 200, 'native identity remains valid while the conversation is bound');
    const ac = new AbortController();
    const sse = await fetch(app.url + '/api/stream', { signal: ac.signal });
    const reader = sse.body!.getReader();
    let streamed = '';
    while (!streamed.includes('"kind":"message"')) streamed += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    const outputs = [
      JSON.stringify(await app.api('GET', '/api/state')),
      JSON.stringify(await app.messages(c1.id)),
      JSON.stringify(await app.api('GET', `/api/members/${a.id}/events`)),
      JSON.stringify(app.store.listEvents(0)),
      streamed,
    ];
    for (const out of outputs) assert.ok(!out.includes(headersB['x-orrery-bridge']), 'bridge secret leaked');
  } finally {
    await app.close();
  }
});
