// Acceptance criteria 1 (create cluster) and 2 (duplicate attach, all-or-nothing) from docs/architecture.md.
// Existing conversations attach; new native conversations require an explicit project path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startHub, REPO_ROOT } from '../src/main.ts';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import type { Member } from '../src/core/types.ts';
import { MOCK_MODELS } from '../src/adapters/mock/native.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { fixtureNativeMock, startTestHub, tempDir, TEST_TOKEN } from './helpers.ts';

test('1: attach / project-only / empty specs, default names with suffixes, all persisted', async () => {
  const app = await startTestHub();
  const p1 = join(app.dir, 'project-1');
  const p2 = join(app.dir, 'project-2');
  let created!: { cluster: any; members: Member[] };
  try {
    assert.deepEqual(await app.api('GET', '/api/harnesses'), ['mock']);
    assert.deepEqual((await app.api('GET', '/api/harnesses/mock/projects')).map((p: any) => p.path), [p1, p2]);

    created = await app.api('POST', '/api/clusters', {
      name: 'c1',
      members: [
        { harness: 'mock', mode: 'native', sessionId: 's1' },
        { harness: 'mock', mode: 'native', sessionId: 's2' },
        { harness: 'mock', projectPath: p2 },
        { harness: 'mock', projectPath: p1 },
      ],
    });
    const [a1, a2, proj, empty] = created.members;
    assert.deepEqual([a1.origin, a1.workerSessionId, a1.cwd, a1.mode], ['attached', 's1', p1, 'native']);
    assert.deepEqual([proj.mode, empty.mode], ['native', 'native'], 'mode defaults to native');
    assert.deepEqual([a2.origin, a2.workerSessionId], ['attached', 's2']);
    assert.deepEqual([proj.origin, proj.cwd], ['created', p2]);
    assert.deepEqual([empty.origin, empty.cwd], ['created', p1]);
    assert.deepEqual(app.native.created.map((x) => x.title), ['orrery: c1', 'orrery: c1']);
    assert.deepEqual(created.members.map((m) => m.name), ['mock-1', 'mock-1-2', 'mock-1-3', 'mock-1-4']);
    assert.ok(created.members.every((m) => m.clusterId === created.cluster.id && m.model === 'mock-1'));

    const sessions = await app.api('GET', `/api/harnesses/mock/sessions?mode=native&project=${encodeURIComponent(p1)}`);
    assert.deepEqual(sessions.map((s: any) => [s.id, s.memberId, s.online]), [['s1', a1.id, true], ['s2', a2.id, true], [empty.workerSessionId, empty.id, true]]);
    assert.deepEqual(await app.api('GET', '/api/harness-modes'), [{ harness: 'mock', native: true, nativeCreate: true }]);
  } finally {
    await app.close();
  }

  const again = await startHub({ dbPath: join(app.dir, 'test.db'), port: 0,  home: join(app.dir, 'home'),
    nativeAdapters: { mock: fixtureNativeMock(app.dir) }, apiToken: TEST_TOKEN });
  try {
    const state = await (await fetch(again.url + '/api/state')).json();
    assert.deepEqual(state.clusters, [{ ...created.cluster, lastMessageAt: created.cluster.createdAt, paused: false, unread: 0 }]);
    const strip = ({ status, ...m }: Member) => m;
    assert.deepEqual(state.members.map(strip), created.members.map(strip));
  } finally {
    await again.close();
  }
});

test('models: GET /api/harnesses/:harness/models per mode; [] without listModels; bad harness or mode is a 400', async () => {
  const app = await startTestHub({ nativeAdapters: { mock: createMockNativeAdapter({ kind: 'bridge' }) } });
  try {
    assert.deepEqual(await app.api('GET', '/api/harnesses/mock/models'), []);

    assert.deepEqual(await app.api('GET', '/api/harnesses/mock/models?mode=native'), [], 'the bridge kind (like Claude native) lists none');
    for (const path of ['/api/harnesses/nope/models']) {
      const res = await fetch(app.url + path);
      assert.equal(res.status, 400, path);
      assert.match((await res.json()).error, /unknown harness|invalid mode/);
    }
  } finally {
    await app.close();
  }
  const queue = await startTestHub();
  try {
    assert.deepEqual(await queue.api('GET', '/api/harnesses/mock/models?mode=native'), MOCK_MODELS);
  } finally {
    await queue.close();
  }
});

test('2: a native session can join different clusters, but duplicates and bad specs are rejected atomically', async () => {
  const app = await startTestHub();
  try {
    const first = await app.api('POST', '/api/clusters', { name: 'c1', members: [{ harness: 'mock', mode: 'native', sessionId: 's1' }] });
    const create = (name: string, members: unknown[]) =>
      fetch(app.url + '/api/clusters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, members }) });

    const otherCluster = await create('c2', [{ harness: 'mock', mode: 'native', sessionId: 's1' }]);
    assert.equal(otherCluster.status, 201);
    const second = await otherCluster.json();
    assert.notEqual(second.members[0].id, first.members[0].id);
    assert.equal(second.members[0].workerSessionId, 's1');
    const duplicate = await fetch(`${app.url}/api/clusters/${first.cluster.id}/members`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ members: [{ harness: 'mock', mode: 'native', sessionId: 's1' }] }),
    });
    assert.equal(duplicate.status, 400);
    assert.match((await duplicate.json()).error, /already a member/);
    const twiceInOne = await create('c3', [{ harness: 'mock', mode: 'native', sessionId: 's2' }, { harness: 'mock', mode: 'native', sessionId: 's2' }]);
    assert.equal(twiceInOne.status, 400);
    const oneBad = await create('c4', [{ projectPath: tempDir(), harness: 'mock' }, { harness: 'mock', mode: 'native', sessionId: 'nope' }]);
    assert.equal(oneBad.status, 400);
    assert.match((await oneBad.json()).error, /not found/);
    const badHarness = await create('c5', [{ projectPath: tempDir(), harness: 'mock' }, { projectPath: tempDir(), harness: 'nope' }]);
    assert.equal(badHarness.status, 400);

    const attachWithModel = await create('c8', [{ harness: 'mock', mode: 'native', sessionId: 's2', model: 'm' }]);
    assert.equal(attachWithModel.status, 400);
    const badMode = await create('c9', [{ projectPath: tempDir(), harness: 'mock', mode: 'both' }]);
    assert.equal(badMode.status, 400);
    // Line breaks of any kind would split the envelope header line.
    for (const sep of ['\n', '\r', '\t', ' ', ' ']) {
      const res = await create(`team${sep}night`, [{ projectPath: tempDir(), harness: 'mock' }]);
      assert.equal(res.status, 400, `cluster name with U+${sep.charCodeAt(0).toString(16).padStart(4, '0')}`);
      assert.match((await res.json()).error, /control characters/);
    }

    const state = await app.api('GET', '/api/state');
    assert.deepEqual(state.clusters.map((c: any) => c.name), ['c1', 'c2'], 'bad batches created no clusters');
    assert.deepEqual(state.members.map((m: Member) => [m.clusterId, m.workerSessionId]),
      [[first.cluster.id, 's1'], [second.cluster.id, 's1']], 'bad batches created no members');
    // s2 was never stored, so it can still join.
    await app.api('POST', '/api/clusters', { name: 'c6', members: [{ harness: 'mock', mode: 'native', sessionId: 's2' }] });
  } finally {
    await app.close();
  }
});

test('1b: a default name made from an odd model name is sanitized, falling back to the harness name', async () => {
  for (const [model, expected] of [['vendor/model x', ['vendor-model-x', 'vendor-model-x-2']], ['/ /', ['mock', 'mock-2']]] as const) {
    const app = await startTestHub({ mock: { model } });
    try {
      const { members } = await app.api('POST', '/api/clusters', { name: 'c', members: [{ projectPath: tempDir(), harness: 'mock' }, { projectPath: tempDir(), harness: 'mock' }] });
      assert.deepEqual(members.map((m: Member) => [m.name, m.model]), expected.map((n) => [n, model]));
    } finally {
      await app.close();
    }
  }
});

test('the /api/state cluster listing carries lastMessageAt: newest message time, else the creation time', async () => {
  const app = await startTestHub();
  try {
    const quiet = await app.cluster('quiet', ['A']);
    const busy = await app.cluster('busy', ['B']);
    const byId = (s: any) => Object.fromEntries(s.clusters.map((c: any) => [c.id, c]));
    assert.equal(byId(await app.api('GET', '/api/state'))[quiet.cluster.id].lastMessageAt, quiet.cluster.createdAt,
      'a cluster without messages uses its creation time');
    const msg = await app.api('POST', `/api/clusters/${busy.cluster.id}/messages`, { body: 'hello' });
    const state = await app.api('GET', '/api/state');
    assert.equal(byId(state)[busy.cluster.id].lastMessageAt, msg.createdAt, 'the newest message time');
    assert.equal(byId(state)[busy.cluster.id].createdAt, busy.cluster.createdAt, 'createdAt stays the creation time');
    assert.equal(byId(state)[quiet.cluster.id].lastMessageAt, quiet.cluster.createdAt, 'another cluster is unaffected');
    assert.deepEqual(state.clusters.map((c: any) => c.id), [quiet.cluster.id, busy.cluster.id],
      'the API keeps creation order; the page sorts by lastMessageAt');
  } finally {
    await app.close();
  }
});

test('cluster category: PATCH /api/clusters/:id sets a trimmed sidebar group, validates it, and emits a cluster event', async () => {
  const app = await startTestHub();
  try {
    const { cluster } = await app.cluster('grouped', ['a']);
    assert.equal(cluster.category, '', 'a new cluster is ungrouped');
    const seq = app.events.length;
    const { cluster: set } = await app.api('PATCH', `/api/clusters/${cluster.id}`, { category: '  前端 ' });
    assert.equal(set.category, '前端');
    const ev = app.events.slice(seq).find((e) => e.kind === 'cluster') as any;
    assert.deepEqual([ev.payload.cluster.id, ev.payload.cluster.category, ev.payload.members], [cluster.id, '前端', []]);
    const state = await app.api('GET', '/api/state');
    assert.equal(state.clusters.find((c: any) => c.id === cluster.id).category, '前端');
    assert.ok(state.clusters[0].lastMessageAt, 'listings still carry lastMessageAt');

    const bad = [{ category: 'x'.repeat(41) }, { category: 'a\nb' }, { category: 3 }, {}, { category: 'ok', color: 'red' }, []];
    for (const body of bad) await assert.rejects(app.api('PATCH', `/api/clusters/${cluster.id}`, body), /400/, JSON.stringify(body));
    await assert.doesNotReject(app.api('PATCH', `/api/clusters/${cluster.id}`, { category: `  ${'字'.repeat(40)}  ` }), '40 characters after trimming');
    await assert.rejects(app.api('PATCH', '/api/clusters/nope', { category: 'x' }), /400.*unknown cluster/);
    const { cluster: cleared } = await app.api('PATCH', `/api/clusters/${cluster.id}`, { category: '' });
    assert.equal(cleared.category, '');
    assert.equal(app.hub.store.getCluster(cluster.id)!.name, 'grouped', 'only the category changes');
  } finally {
    await app.close();
  }
});
