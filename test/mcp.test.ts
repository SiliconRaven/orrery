// Identity comes from the conversation a bridge names with the bridge secret; a missing or wrong secret and any
// bearer token are rejected, clusters are kept apart, and the secret never leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bearer, holdScript, hubSecret, mcpStatus, memberHeaders, startTestHub, turnsOf, waitFor } from './helpers.ts';

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as any)[0].text;
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) };
};

test('7: the sender is the conversation the bridge names; a bad secret or a bearer token gets 401; clusters stay apart; the secret never leaks', async () => {
  const hold = holdScript();
  const app = await startTestHub({ mock: { script: hold.script } });
  try {
    const { cluster: c1, members: [a, b] } = await app.cluster('c1', ['A', 'B']);
    const { cluster: c2, members: [x] } = await app.cluster('c2', ['X']);
    await app.api('POST', `/api/clusters/${c1.id}/messages`, { body: '@all hold' });
    await app.api('POST', `/api/clusters/${c2.id}/messages`, { body: '@all hold' });
    await waitFor(() => [a, b, x].every((m) => turnsOf(app, m.id) === 1), 'three held turns');
    const secret = hubSecret(app.home);
    const headersB = memberHeaders(app, b.id);

    assert.equal(await mcpStatus(app.url, {}), 401);
    assert.equal(await mcpStatus(app.url, bearer('wrong')), 401);
    assert.equal(await mcpStatus(app.url, bearer(secret)), 401, 'a bearer token names nobody, even the secret');
    assert.equal(await mcpStatus(app.url, { ...headersB, 'x-orrery-bridge': 'wrong' }), 401, 'a wrong secret');
    await assert.rejects(connect(app.url, { authorization: 'Bearer not-a-token' }));

    const clientB = await connect(app.url, headersB);
    const clientX = await connect(app.url, memberHeaders(app, x.id));
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
    for (const out of outputs) assert.ok(!out.includes(secret), 'secret leaked');
  } finally {
    await app.close();
  }
});

test('a tool call whose headers arrive while the conversation is a member but whose body arrives after its removal writes nothing', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a, b] } = await app.cluster('c', ['A', 'B']);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body: '@B late' } } });
    let answer = '';
    const status = Promise.withResolvers<number>();
    const req = request(app.url + '/mcp', {
      method: 'POST',
      headers: { ...memberHeaders(app, a.id), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.on('data', (c) => { answer += c; });
      res.on('end', () => status.resolve(res.statusCode!));
    });
    req.on('error', status.reject);
    req.flushHeaders();   // the headers now, while A is a member; the body is held back
    await sleep(200);     // the Hub has checked the headers by now
    await app.api('DELETE', `/api/clusters/${cluster.id}/members/${a.id}`, {});
    req.end(body);        // the tool call arrives after A was moved out
    assert.equal(await status.promise, 200);
    const result = JSON.parse(/^data: (.*)$/m.exec(answer)?.[1] ?? answer).result;
    assert.equal(result.isError, true, result.content[0].text);
    assert.deepEqual(await app.messages(cluster.id), [], 'nothing written');
    assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE member_id = ?').get(b.id) as any).n, 0, 'B got no delivery');
  } finally {
    await app.close();
  }
});
