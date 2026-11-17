import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertMessageWithEvent, startTestHub, tempDir } from './helpers.ts';
import type { Message } from '../src/core/types.ts';

const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'];

test('tempDir refuses a temp root inside a Git repository, a worktree (.git file) included', () => {
  const saved = TEMP_VARS.map((name) => process.env[name]);
  const outside = tempDir();
  try {
    for (const [repo, makeGit] of [
      ['repo', (path: string) => mkdirSync(path)],
      ['worktree', (path: string) => writeFileSync(path, 'gitdir: elsewhere\n')],
    ] as const) {
      const nested = join(outside, repo, 'tmp');
      mkdirSync(nested, { recursive: true });
      makeGit(join(outside, repo, '.git'));
      for (const name of TEMP_VARS) process.env[name] = nested;
      assert.throws(() => tempDir(), /inside the Git repository .*outside any repository/s);
      assert.deepEqual(readdirSync(nested), [], 'nothing is created before the refusal');
    }
    const clean = join(outside, 'clean');
    mkdirSync(clean);
    for (const name of TEMP_VARS) process.env[name] = clean;
    tempDir();
    assert.equal(readdirSync(clean).length, 1, 'a root outside any repository works');
  } finally {
    TEMP_VARS.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('insertMessageWithEvent makes the message visible to event replay, all or nothing', async () => {
  const app = await startTestHub();
  try {
    const { cluster, members: [a] } = await app.cluster('c', ['A']);
    const message: Message = { id: 'seeded', clusterId: cluster.id, from: 'user', mentions: [a.id], body: 'hello', replyTo: null, chainId: 'seeded', hop: 0, createdAt: new Date().toISOString() };
    const since = app.store.listEvents(0).at(-1)?.seq ?? 0;

    const { deliveries, event } = insertMessageWithEvent(app.store, message, [a.id]);
    assert.deepEqual(deliveries.map((d) => d.memberId), [a.id]);
    const replayed = app.store.listEvents(since);
    assert.deepEqual(replayed.map((e) => e.seq), [event.seq]);
    assert.equal(replayed[0].kind, 'message');
    assert.deepEqual(replayed[0].payload, { message: { ...message, taskIds: [], bookmarks: [] }, deliveries });

    const append = app.store.appendEvent;
    app.store.appendEvent = () => { throw new Error('injected event failure'); };
    try {
      assert.throws(() => insertMessageWithEvent(app.store, { ...message, id: 'lost', chainId: 'lost' }, [a.id]), /injected event failure/);
    } finally { app.store.appendEvent = append; }
    assert.equal(app.store.getMessage('lost'), null, 'the message rolls back with its event');
  } finally { await app.close(); }
});
