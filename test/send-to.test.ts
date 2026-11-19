// Member-page sends addressed by member id (`to` on POST /api/clusters/:id/messages, docs/collaboration-api.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/main.ts';
import { startTestHub } from './helpers.ts';

test('7: `to` delivers to exactly those members, ignores @names in the body, and rejects bad ids atomically', async () => {
  const app = await startTestHub();
  try {
    await app.api('POST', '/api/pause', { paused: true });   // only who gets a delivery matters here
    const { cluster, members: [a, b] } = await app.cluster('c', ['A', 'B']);
    const { members: [x] } = await app.cluster('other', ['X']);
    const path = `/api/clusters/${cluster.id}/messages`;

    const msg = await app.api('POST', path, { body: '@A @all hi', to: [b.id] });
    assert.deepEqual([msg.mentions, msg.body], [[b.id], '@A @all hi'], 'body kept as typed, not parsed');
    // The recipient B is renamed and A takes its old name: `to` still reaches B, and only B.
    await app.api('PATCH', `/api/members/${b.id}`, { name: 'Bee' });
    await app.api('PATCH', `/api/members/${a.id}`, { name: 'B' });
    await app.api('POST', path, { body: '@B old name', to: [b.id] });
    await app.api('POST', path, { body: 'both', to: [a.id, b.id] });
    const msgs = await app.messages(cluster.id);
    assert.deepEqual(msgs.map((m) => [m.systemKind, m.deliveries.map((d) => d.memberId)]), [
      [undefined, [b.id]], ['member_renamed', []], ['member_renamed', []], [undefined, [b.id]], [undefined, [a.id, b.id]],
    ]);

    const rejected = async (to: unknown) => {
      const res = await fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x', to }) });
      return res.status;
    };
    for (const to of [[x.id], [b.id, x.id], ['nobody'], [], [b.id, b.id], [1], [b.id, null], b.id, null, {}]) {
      assert.equal(await rejected(to), 400, JSON.stringify(to));
    }
    assert.equal((await app.messages(cluster.id)).length, msgs.length, 'no message stored for a rejected send');
    assert.deepEqual(await app.messages((await app.api('GET', '/api/state')).clusters[1].id), [], 'X got nothing');
    const all = app.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number };
    assert.equal(all.n, 4, 'no delivery created by a rejected send');
  } finally {
    await app.close();
  }
});

test('7: without `to` a user message is still routed by its @mentions', async () => {
  const app = await startTestHub();
  try {
    await app.api('POST', '/api/pause', { paused: true });
    const { cluster, members: [a] } = await app.cluster('c', ['A', 'B']);
    const msg = await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A hi' });
    assert.deepEqual(msg.mentions, [a.id]);
  } finally {
    await app.close();
  }
});

test('8: the member page sends with `to: [member id]` and does not prefix @name', () => {
  const app = readFileSync(join(REPO_ROOT, 'src', 'web', 'public', 'app.js'), 'utf8');
  const submit = /direct\.form\.addEventListener\('submit'[\s\S]*?\n\}\);/.exec(app)?.[0] ?? '';
  assert.match(submit, /send\(direct, m\.clusterId, \(text\) => \(\{ body: text, to: \[m\.id\] \}\)\)/);
  assert.doesNotMatch(submit, /@\$\{/, 'no @name added to the text');
  // send() posts the payload as given, plus the target's uploaded attachments (docs/files.md); never a changed body.
  assert.match(app, /await api\('POST', `\/api\/clusters\/\$\{encodeURIComponent\(clusterId\)\}\/messages`, \{\s*\.\.\.payload\(text\), \.\.\.\(ready\.length \? \{ attachments: ready\.map\(\(u\) => u\.id\) \} : \{\}\),\s*\}\)/,
    'send() posts the payload as given, plus attachments');
});
