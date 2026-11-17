// The page side of the stalled-member hint (src/web/public/stalled.js): wording, dismissal and its reset. Runs in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

// A browser module without types: a computed specifier keeps tsc from looking for declarations.
const stalled = await import(pathToFileURL(join(REPO_ROOT, 'src', 'web', 'public', 'stalled.js')).href);

const hint = (extra: Record<string, unknown> = {}) => ({
  clusterId: 'c1', memberId: 'm1', memberName: 'B', harness: 'codex', offline: false,
  tasks: [{ id: 't2', number: 7, title: '写文档', status: 'working' }, { id: 't1', number: null, title: '审', status: 'review' }],
  lastActivityAt: null, lastActivitySource: null, lastTaskChangeAt: '2026-11-15T01:00:00.000Z', since: '2026-11-15T01:00:00.000Z',
  thresholdMinutes: 30, ...extra,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

test('the hint says who, which tasks, that there is no evidence, offline, and keeps the caveat', () => {
  const lines = stalled.stalledLines(hint({ offline: true }));
  assert.match(lines[0], /B（codex）手上有任务，超过 30 分钟没有活动/);
  assert.match(lines[1], /没有活动证据/);
  assert.match(lines[2], /当前离线/);
  const seen = stalled.stalledLines(hint({ lastActivityAt: '2026-11-15T02:00:00.000Z', lastActivitySource: '工具调用' }));
  assert.match(seen[1], /Hub 看到的最近活动：.*（来源：工具调用）/);
  assert.equal(seen.length, 2, 'online: no offline line');
  assert.match(stalled.STALLED_CAVEAT, /不代表对方已经停工/);
  assert.match(stalled.STALLED_CAVEAT, /有些应用在一轮中间不报告活动/);
  assert.equal(stalled.stalledSummary([hint({ offline: true })]), 'B（离线）：#7 写文档（进行中）、审（待验收）');
});

test('a dismissal hides the same member with the same tasks until the clock restarts', () => {
  const first = hint();
  let dismissed = stalled.withDismissed({}, first);
  assert.deepEqual(stalled.visibleStalled([first], dismissed), [], 'dismissed');
  const reordered = hint({ tasks: [...first.tasks].reverse() });
  assert.deepEqual(stalled.visibleStalled([reordered], dismissed), [], 'the same set in another order stays dismissed');
  const later = hint({ since: '2026-11-15T03:00:00.000Z', lastActivityAt: '2026-11-15T03:00:00.000Z', lastActivitySource: '发言' });
  assert.equal(stalled.visibleStalled([later], dismissed).length, 1, 'new activity restarted the clock');
  const fewer = hint({ tasks: first.tasks.slice(0, 1) });
  assert.equal(stalled.visibleStalled([fewer], dismissed).length, 1, 'another task set is shown');
  const other = hint({ memberId: 'm2', memberName: 'C' });
  assert.equal(stalled.visibleStalled([first, other], dismissed).length, 1, 'only that member is hidden');
  dismissed = stalled.withDismissed(dismissed, later);
  assert.deepEqual(Object.keys(dismissed), ['m1'], 'one entry per member');
});

const twoHints = () => [hint(), hint({ memberId: 'm2', memberName: 'C' })];

test('a localStorage property that throws on read does not stop the watch: dismissals stay in memory', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.equal(stalled.browserStorage(), null);
    assert.deepEqual(stalled.readDismissed(), {});
    const hints = twoHints();
    const watch = stalled.createStalledWatch({ api: async () => ({ hints }), onChange: () => {}, everyMs: 3_600_000 });
    await watch.load();
    assert.equal(watch.visible().length, 2);
    watch.dismiss(hints[0]);
    assert.deepEqual(watch.visible().map((h: { memberId: string }) => h.memberId), ['m2'], 'held in this page');
    watch.dismiss(hints[1]);
    assert.deepEqual(watch.visible(), []);
  } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('two dismissals in a row both hold when storage cannot be written', async () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const hints = twoHints();
  const watch = stalled.createStalledWatch({ api: async () => ({ hints }), onChange: () => {}, storage, everyMs: 3_600_000 });
  await watch.load();
  watch.dismiss(hints[0]);
  assert.deepEqual(watch.visible().map((h: { memberId: string }) => h.memberId), ['m2']);
  watch.dismiss(hints[1]);
  assert.deepEqual(watch.visible(), [], 'the first dismissal is not undone by the second');
});

test('the watch reads /api/stalled, announces changes, and remembers a dismissal across page loads', async () => {
  const storage = memoryStorage();
  let answer: unknown[] = [hint(), hint({ clusterId: 'c2', memberId: 'm2', memberName: 'C', tasks: [{ id: 't9', number: 9, title: '九', status: 'pending' }] })];
  const calls: string[] = [];
  let changes = 0;
  const api = async (method: string, url: string) => { calls.push(`${method} ${url}`); return { hints: answer }; };
  const watch = stalled.createStalledWatch({ api, onChange: () => { changes++; }, storage, everyMs: 3_600_000 });
  watch.changed();   // before the first load: nothing is read
  await watch.load();
  assert.deepEqual(calls, ['GET /api/stalled']);
  assert.equal(changes, 1);
  assert.equal(watch.visible().length, 2);
  assert.deepEqual(watch.forCluster('c2').map((h: { memberId: string }) => h.memberId), ['m2']);
  assert.deepEqual([...watch.taskMap('c1').keys()].sort(), ['t1', 't2']);
  await watch.load();
  assert.equal(changes, 1, 'the same answer announces nothing');

  watch.dismiss(answer[0]);
  assert.equal(changes, 2);
  assert.deepEqual(watch.visible().map((h: { memberId: string }) => h.memberId), ['m2']);
  assert.equal(watch.taskMap('c1').size, 0, 'the task marks go with the hint');

  // A new page (or a Hub restart) reads the same dismissal back.
  const again = stalled.createStalledWatch({ api, onChange: () => {}, storage, everyMs: 3_600_000 });
  await again.load();
  assert.deepEqual(again.visible().map((h: { memberId: string }) => h.memberId), ['m2']);

  // The task moved or the member worked: the Hub stops listing it, and the page drops it.
  answer = [];
  await watch.load();
  assert.deepEqual(watch.visible(), []);
  assert.equal(changes, 3);
});
