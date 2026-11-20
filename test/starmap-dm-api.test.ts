import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Message } from '../src/core/types.ts';
import { bearer, memberHeaders, rawFetch, startTestHub, TEST_TOKEN } from './helpers.ts';

const ids = (messages: { id: string }[]) => messages.map((message) => message.id);

test('the authenticated API keeps private messages in their member window and scopes every history cursor', async (t) => {
  const app = await startTestHub();
  t.after(() => app.close());
  const { cluster, members: [recipient, peer] } = await app.cluster('private API', ['recipient', 'peer']);
  const { members: [foreign] } = await app.cluster('elsewhere', ['foreign']);
  app.hub.setPaused(true);
  const path = `/api/clusters/${cluster.id}/messages`;
  const send = (value: object) => app.api('POST', path, value) as Promise<Message>;
  const scope = `privateWith=${recipient.id}`;
  const pub = await send({ body: 'public' });
  const dm = await send({ body: 'private needle', to: [recipient.id], private: true });
  const dm2 = await send({ body: 'private follow-up', to: [recipient.id], private: true });
  const otherDm = await send({ body: 'private for peer', to: [peer.id], private: true });
  const tail = await send({ body: 'tail' });
  assert.equal(dm.privateTo, recipient.id);
  assert.equal(dm.privateBindingGen, recipient.bindingGen);
  const history = await app.api('GET', `${path}?${scope}`);
  assert.deepEqual(ids(history), [dm.id, dm2.id]);
  assert.equal(history[0].deliveries[0].memberId, recipient.id);
  assert.equal(history[0].privateBindingGen, recipient.bindingGen);
  assert.deepEqual(ids(await app.api('GET', `${path}?${scope}&limit=1`)), [dm2.id]);
  assert.deepEqual(ids(await app.api('GET', `${path}?${scope}&before=${dm2.id}`)), [dm.id]);
  assert.deepEqual(ids(await app.api('GET', `${path}?${scope}&after=${dm.id}`)), [dm2.id]);
  assert.deepEqual(await app.api('GET', `${path}?${scope}&before=${otherDm.id}`), []);
  assert.deepEqual(await app.api('GET', `${path}?${scope}&after=${pub.id}`), []);
  assert.deepEqual(ids(await app.api('GET', `${path}?after=${pub.id}`)), [tail.id]);
  assert.deepEqual(await app.api('GET', `${path}?before=${dm.id}`), []);
  assert.deepEqual(await app.api('GET', `${path}/search?q=needle`).then((answer) => answer.items), []);
  assert.ok((await app.messages(cluster.id)).every((message) => message.privateTo === undefined));
  assert.ok(app.events.some((event) => event.kind === 'message' && (event.payload as { message: Message }).message.id === dm.id
    && (event.payload as { message: Message }).message.privateTo === recipient.id));

  for (const invalid of [
    { private: false }, { private: null }, { private: 'true' }, { to: [] }, { to: [recipient.id, peer.id] },
    { to: [foreign.id] }, { attachments: ['attachment'] }, { taskIds: ['task'] }, { handover: true },
  ]) {
    await assert.rejects(send({ body: 'invalid', to: [recipient.id], private: true, ...invalid }), /→ 400/);
  }
  for (const invalid of [`${scope}&around=${dm.id}`, `${scope}&q=needle`, `${scope}&${scope}`]) {
    await assert.rejects(app.api('GET', `${path}?${invalid}`), /→ 400/);
  }
  await assert.rejects(app.api('GET', `${path}/search?${scope}`), /→ 400/);
  for (const missing of [`?privateWith=${foreign.id}`, `?around=${dm.id}`, `/${dm.id}`]) {
    await assert.rejects(app.api('GET', path + missing), /→ 404/);
  }
  const response = await rawFetch(app.url + path + '?' + scope, { headers: bearer(TEST_TOKEN) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await rawFetch(app.url + path + '?' + scope)).status, 401);
  app.hub.removeMember(cluster.id, recipient.id);
  assert.deepEqual(ids(await app.api('GET', `${path}?${scope}`)), [dm.id, dm2.id]);
  await assert.rejects(send({ body: 'removed', to: [recipient.id], private: true }), /→ 400/);
});

test('private references cannot choose a second MCP group or become shared collaboration evidence', async (t) => {
  const app = await startTestHub();
  t.after(() => app.close());
  const { cluster, members: [recipient, observer] } = await app.cluster('private MCP', ['recipient', 'observer']);
  await app.api('POST', '/api/clusters', { name: 'second group', members: [{
    harness: 'mock', mode: 'native', name: 'observer-elsewhere', sessionId: observer.workerSessionId,
  }] });
  app.hub.setPaused(true);
  const path = `/api/clusters/${cluster.id}`;
  const dm: Message = await app.api('POST', path + '/messages', { body: 'one-to-one', to: [recipient.id], private: true });

  async function connect(id: string) {
    const client = new Client({ name: 'private-messages-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(app.url + '/mcp'), {
      requestInit: { headers: memberHeaders(app, id) },
    }));
    return client;
  }
  const reader = await connect(recipient.id);
  const outsider = await connect(observer.id);
  try {
    const result = await reader.callTool({ name: 'read_messages', arguments: { history: true } });
    assert.notEqual(result.isError, true);
    const records = JSON.parse((result.content as { text: string }[])[0].text);
    assert.equal(records.find((record: { id: string }) => record.id === dm.id)?.private, true);
    const readBefore = (before: string) => outsider.callTool({ name: 'read_messages', arguments: { history: true, before } });
    const foreignResult = await readBefore(dm.id);
    assert.equal(foreignResult.isError, true);
    assert.deepEqual(foreignResult, await readBefore(randomUUID()));
    const command = (value: object) => app.api('POST', path + '/collaboration', { ...value, operationId: randomUUID() });
    const { task } = await command({ action: 'task.create', title: 'shared task', scope: 'test', acceptance: 'done' });
    for (const action of [
      { action: 'bookmark.set', messageId: dm.id },
      { action: 'task.create', title: 'leak evidence', originMessageId: dm.id },
      { action: 'task.create', title: 'leak by prefix', originMessageId: dm.id.slice(0, 8) },
      { action: 'task.summary', taskId: task.id, expectedRevision: task.revision,
        summary: 'summary', sourceMessageIds: [dm.id], throughEventId: 0 },
      { action: 'message.link', messageId: dm.id, taskIds: [task.id] },
    ]) {
      await assert.rejects(command(action), /unknown (source )?message/);
    }
    await assert.rejects(command({ action: 'task.submit', taskId: task.id, expectedRevision: task.revision,
      evidenceMessageIds: [dm.id], summary: 'shared evidence' }), /unknown evidence message/);
  } finally {
    await outsider.close();
    await reader.close();
  }
});

test('private DM expectedBindingGen blocks silent reroute after member rebind', async (t) => {
  const app = await startTestHub();
  t.after(() => app.close());
  const { cluster, members: [recipient] } = await app.cluster('dm rebind guard', ['recipient']);
  app.hub.setPaused(true);
  const path = `/api/clusters/${cluster.id}/messages`;

  // Matching expectedBindingGen succeeds on bindingGen 1.
  const first: Message = await app.api('POST', path, {
    body: 'for binding 1', to: [recipient.id], private: true, expectedBindingGen: 1,
  });
  assert.equal(first.privateBindingGen, 1);

  // Invalid expectedBindingGen values and non-private expectedBindingGen are rejected.
  const headers = { 'content-type': 'application/json', ...bearer(TEST_TOKEN) };
  const badNonPrivate = await rawFetch(app.url + path, {
    method: 'POST', headers,
    body: JSON.stringify({ body: 'public', expectedBindingGen: 1 }),
  });
  assert.equal(badNonPrivate.status, 400);
  const badZero = await rawFetch(app.url + path, {
    method: 'POST', headers,
    body: JSON.stringify({ body: 'zero', to: [recipient.id], private: true, expectedBindingGen: 0 }),
  });
  assert.equal(badZero.status, 400);

  // Rebind recipient to a new session (bindingGen -> 2).
  await app.api('POST', `/api/members/${recipient.id}/session`, { harness: 'mock', sessionId: 's2', confirmStopped: true });
  const beforeCount = (await app.api('GET', `${path}?privateWith=${recipient.id}`)).length;

  // Stale expectedBindingGen: 1 is rejected with BINDING_CHANGED before any DB write or delivery enqueue.
  const staleRes = await rawFetch(app.url + path, {
    method: 'POST', headers,
    body: JSON.stringify({ body: 'must not reach session 2', to: [recipient.id], private: true, expectedBindingGen: 1 }),
  });
  assert.equal(staleRes.status, 400);
  const staleErr = await staleRes.json();
  assert.equal(staleErr.code, 'BINDING_CHANGED');
  assert.equal((await app.api('GET', `${path}?privateWith=${recipient.id}`)).length, beforeCount, 'rejected DM must not be stored');

  // After user explicitly confirms the new session (expectedBindingGen: 2), send succeeds.
  const second: Message = await app.api('POST', path, {
    body: 'confirmed for binding 2', to: [recipient.id], private: true, expectedBindingGen: 2,
  });
  assert.equal(second.privateBindingGen, 2);
});
