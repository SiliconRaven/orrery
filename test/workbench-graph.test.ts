import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/main.ts';

const graph = await import(pathToFileURL(join(REPO_ROOT, 'src/web/public/workbench-graph.js')).href);

const screenOf = (view: any, world: any) => ({ x: world.x * view.k + view.x, y: world.y * view.k + view.y });
const worldOf = (view: any, screen: any) => ({ x: (screen.x - view.x) / view.k, y: (screen.y - view.y) / view.k });

test('zooming keeps the world point under the pointer fixed', () => {
  const view = { x: 40, y: -25, k: 0.8 };
  const pointer = { x: 310, y: 177 };
  const world = worldOf(view, pointer);
  for (const k of [0.5, 1, 1.7]) {
    const next = graph.zoomGraphAt(view, k, pointer);
    assert.equal(next.k, k);
    const seen = screenOf(next, world);
    assert.ok(Math.abs(seen.x - pointer.x) < 1e-9 && Math.abs(seen.y - pointer.y) < 1e-9, `moved at zoom ${k}`);
  }
});

test('zoom is clamped, and a clamped zoom still keeps the pointer fixed', () => {
  assert.equal(graph.clampGraphZoom(0.001), graph.GRAPH_ZOOM.min);
  assert.equal(graph.clampGraphZoom(99), graph.GRAPH_ZOOM.max);
  const view = { x: 10, y: 20, k: 1 };
  const pointer = { x: 100, y: 200 };
  const world = worldOf(view, pointer);
  const next = graph.zoomGraphAt(view, 99, pointer);
  assert.equal(next.k, graph.GRAPH_ZOOM.max);
  assert.deepEqual(screenOf(next, world), pointer);
});

test('a small movement is a click, a larger one a drag', () => {
  assert.equal(graph.isGraphDrag(0, 0), false);
  assert.equal(graph.isGraphDrag(2, 2), false);
  assert.equal(graph.isGraphDrag(3, 3), true);
  assert.equal(graph.isGraphDrag(0, -4), true);
  assert.equal(graph.isGraphDrag(5, 0, 8), false, 'touch uses a wider threshold');
});

test('corrupt or non-numeric storage falls back to an empty layout', () => {
  for (const raw of [null, '', 'not json', '[]', 'null', '42', '{"version":1}', '{"version":1,"positions":[]}', '{"version":1,"positions":null}',
    '{"version":2,"positions":{"a":{"x":1,"y":2}}}', '{"positions":{"a":{"x":1,"y":2}}}']) {
    assert.equal(graph.parseGraphLayout(raw).size, 0, String(raw));
  }
});

test('one bad entry only loses that node', () => {
  const raw = JSON.stringify({ version: 1, positions: { good: { x: 1.5, y: -2 }, text: { x: '1', y: 2 }, missing: { x: 1 }, nil: null, huge: { x: 1e12, y: 0 } } });
  const parsed = graph.parseGraphLayout(raw);
  assert.deepEqual([...parsed], [['good', { x: 1.5, y: -2 }]]);
  assert.equal(graph.parseGraphLayout('{"version":1,"positions":{"inf":{"x":1e999,"y":0}}}').size, 0, 'JSON overflow parses to Infinity');
});

test('stored layouts round-trip, and storage stays bounded with the most recent kept', () => {
  const positions = new Map([['a', { x: 1, y: 2 }], ['b', { x: 3, y: 4 }]]);
  assert.deepEqual([...graph.parseGraphLayout(graph.serializeGraphLayout(positions))], [...positions]);
  const many = new Map(Array.from({ length: 1200 }, (_, i) => [`t${i}`, { x: i, y: i }]));
  const kept = graph.parseGraphLayout(graph.serializeGraphLayout(many));
  assert.equal(kept.size, 1000);
  assert.ok(kept.has('t1199') && !kept.has('t0'));
});

test('positions of tasks that no longer exist are dropped', () => {
  const positions = new Map([['live', { x: 1, y: 1 }], ['stale', { x: 2, y: 2 }]]);
  assert.deepEqual([...graph.pruneGraphLayout(positions, new Set(['live', 'other']))], [['live', { x: 1, y: 1 }]]);
});

test('stored positions override the automatic layout; new tasks get the automatic one', () => {
  const auto = new Map([['a', { x: 0, y: 0 }], ['new', { x: 274, y: 0 }]]);
  const merged = graph.mergeGraphPositions(auto, new Map([['a', { x: 9, y: 8 }], ['gone', { x: 7, y: 7 }]]));
  assert.deepEqual([...merged], [['a', { x: 9, y: 8 }], ['new', { x: 274, y: 0 }]]);
});

test('fit shows every node inside the viewport when readable, keeps FIT_MIN_ZOOM floor when huge, and never enlarges past 100%', () => {
  const size = { width: 600, height: 400 };
  const medium = [{ x: -100, y: 100, width: 210, height: 90 }, { x: 400, y: 380, width: 210, height: 90 }];
  const view = graph.fitGraphView(medium, size);
  assert.ok(view.k >= graph.FIT_MIN_ZOOM && view.k < 1);
  for (const rect of medium) {
    const a = screenOf(view, rect);
    const b = screenOf(view, { x: rect.x + rect.width, y: rect.y + rect.height });
    assert.ok(a.x >= 0 && a.y >= 0 && b.x <= size.width && b.y <= size.height, JSON.stringify([a, b]));
  }
  const huge = [{ x: -500, y: 100, width: 210, height: 90 }, { x: 900, y: 1000, width: 210, height: 90 }];
  const floorView = graph.fitGraphView(huge, size);
  assert.equal(floorView.k, graph.FIT_MIN_ZOOM);
  const topLeft = screenOf(floorView, huge[0]);
  assert.deepEqual(topLeft, { x: 24, y: 24 }, 'overflowing axes anchor cleanly with padding at top-left');
  assert.equal(graph.fitGraphView([{ x: 0, y: 0, width: 210, height: 90 }], size).k, 1);
  assert.equal(graph.fitGraphView([], size), null);
  assert.equal(graph.fitGraphView(medium, { width: 0, height: 0 }), null, 'an unmeasured viewport keeps the default view');
});

test('focus reveals an off-screen node and leaves a visible one alone', () => {
  const view = { x: 0, y: 0, k: 1 };
  const size = { width: 600, height: 400 };
  assert.equal(graph.revealGraphRect(view, { x: 10, y: 10, width: 210, height: 90 }, size), view);
  const rect = { x: 2000, y: 1500, width: 210, height: 90 };
  const next = graph.revealGraphRect(view, rect, size);
  const centre = screenOf(next, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  assert.deepEqual(centre, { x: 300, y: 200 });
});

test('edges run from the right middle of the source to the left middle of the target', () => {
  const path = graph.graphEdgePath({ x: 0, y: 0, width: 210, height: 100 }, { x: 400, y: 200, width: 210, height: 60 });
  assert.ok(path.startsWith('M 210 50 '), path);
  assert.ok(path.endsWith(', 400 230'), path);
});

const assertNoOverlaps = (rects: { id: string; x: number; y: number; width: number; height: number }[]) => {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlaps, false, `${a.id} (${a.x},${a.y}) overlaps ${b.id} (${b.x},${b.y})`);
    }
  }
};

test('arrangeGraphLayout separates connected components (largest first) and minimizes crossings without overlaps', () => {
  const nodes = [
    // Small component (2 nodes)
    { id: 's1', task: { id: 's1', number: 1, status: 'pending' } },
    { id: 's2', task: { id: 's2', number: 2, status: 'working' } },
    // Larger component (4 nodes): r1 (#3) -> c2 (#6), r2 (#4) -> c1 (#5) -> c1 should sit below c2 to avoid crossing
    { id: 'r1', task: { id: 'r1', number: 3, status: 'completed' } },
    { id: 'r2', task: { id: 'r2', number: 4, status: 'working' } },
    { id: 'c1', task: { id: 'c1', number: 5, status: 'pending' } },
    { id: 'c2', task: { id: 'c2', number: 6, status: 'review' } },
    // Component with unloaded predecessor
    { id: 'missing-pred', task: null },
    { id: 'u1', task: { id: 'u1', number: 7, status: 'pending' } },
  ];
  const edges = [
    { from: 's1', to: 's2' },
    { from: 'r1', to: 'c2' },
    { from: 'r1', to: 'c1' },
    { from: 'r2', to: 'c1' },
    { from: 'missing-pred', to: 'u1' },
  ];
  const heights: Record<string, number> = { s1: 80, s2: 110, r1: 90, r2: 100, c1: 75, c2: 95, 'missing-pred': 70, u1: 105 };
  const arranged = graph.arrangeGraphLayout({ nodes, edges, heightOf: (id: string) => heights[id], viewportWidth: 1000 });
  const pos = arranged.positions;
  assert.equal(arranged.sections.length, 0);

  // Larger 4-node component is placed before the 2-node components (top-left at 0,0)
  assert.equal(pos.get('r1').x, 0);
  assert.ok(pos.get('c2').x > pos.get('r1').x, 'dependent sits to the right of predecessor');
  // Crossing minimization: r1 is above r2, so c2 (child of r1) sits above c1 (child of r2)
  assert.ok(pos.get('r1').y < pos.get('r2').y);
  assert.ok(pos.get('c2').y < pos.get('c1').y, 'layer 1 reorders by predecessor y to avoid crossing');
  // Unloaded predecessor stays paired in a dependency component
  assert.ok(pos.get('u1').x > pos.get('missing-pred').x);

  // Zero overlap across all nodes
  assertNoOverlaps([...pos].map(([id, p]) => ({ id, x: p.x, y: p.y, width: 210, height: heights[id] })));
});

test('arrangeGraphLayout puts standalone tasks in status-grouped multi-column grids adapting to viewportWidth', () => {
  const nodes = [
    { id: 'dep-a', task: { id: 'dep-a', number: 1, status: 'completed' } },
    { id: 'dep-b', task: { id: 'dep-b', number: 2, status: 'working' } },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, task: { id: `w${i}`, number: 10 + i, status: 'working' } })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `r${i}`, task: { id: `r${i}`, number: 20 + i, status: 'review' } })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, task: { id: `p${i}`, number: 30 + i, status: 'pending' } })),
    { id: 'c0', task: { id: 'c0', number: 40, status: 'merged' } },
    { id: 'c1', task: { id: 'c1', number: 41, status: 'cancelled' } },
  ];
  const edges = [{ from: 'dep-a', to: 'dep-b' }];
  const heightOf = (id: string) => (id.startsWith('w') ? 105 : 88);

  const wide = graph.arrangeGraphLayout({ nodes, edges, heightOf, viewportWidth: 1000, viewportHeight: 440 });
  // Sections appear in order: working -> review -> pending -> closed
  assert.deepEqual(wide.sections.map((s: any) => s.key), ['working', 'review', 'pending', 'closed']);
  assert.match(wide.sections[0].label, /^进行中（6）/);
  const wideWorkingXs = new Set(Array.from({ length: 6 }, (_, i) => wide.positions.get(`w${i}`).x));
  assert.ok(wideWorkingXs.size >= 4, `wide landscape canvas arranges working tasks across >=4 columns (got ${wideWorkingXs.size})`);
  assertNoOverlaps([
    ...[...wide.positions].map(([id, p]) => ({ id, x: p.x, y: p.y, width: 210, height: heightOf(id) })),
    ...wide.sections.map((s: any) => ({ id: `sec-${s.key}`, x: s.x, y: s.y, width: s.width, height: s.height })),
  ]);

  const narrow = graph.arrangeGraphLayout({ nodes, edges, heightOf, viewportWidth: 340, viewportHeight: 500 });
  const narrowWorkingXs = new Set(Array.from({ length: 6 }, (_, i) => narrow.positions.get(`w${i}`).x));
  assert.ok(narrowWorkingXs.size <= wideWorkingXs.size && narrowWorkingXs.size <= 3, 'portrait narrow canvas uses fewer columns');
  assertNoOverlaps([
    ...[...narrow.positions].map(([id, p]) => ({ id, x: p.x, y: p.y, width: 210, height: heightOf(id) })),
    ...narrow.sections.map((s: any) => ({ id: `sec-${s.key}`, x: s.x, y: s.y, width: s.width, height: s.height })),
  ]);
});

test('arrangeGraphLayout is deterministic and isolates unrelated regions when standalone tasks are added', () => {
  const baseNodes = [
    { id: 'd1', task: { id: 'd1', number: 1, status: 'pending' } },
    { id: 'd2', task: { id: 'd2', number: 2, status: 'pending' } },
    { id: 'w1', task: { id: 'w1', number: 3, status: 'working' } },
    { id: 'p1', task: { id: 'p1', number: 4, status: 'pending' } },
  ];
  const edges = [{ from: 'd1', to: 'd2' }];
  const a = graph.arrangeGraphLayout({ nodes: baseNodes, edges, heightOf: () => 90, viewportWidth: 1000 });
  const b = graph.arrangeGraphLayout({ nodes: [...baseNodes].reverse(), edges, heightOf: () => 90, viewportWidth: 1000 });
  assert.deepEqual([...a.positions], [...b.positions], 'input order does not affect arranged coordinates');

  const withExtraPending = graph.arrangeGraphLayout({
    nodes: [...baseNodes, { id: 'p2', task: { id: 'p2', number: 5, status: 'pending' } }],
    edges, heightOf: () => 90, viewportWidth: 1000,
  });
  for (const id of ['d1', 'd2', 'w1', 'p1']) {
    assert.deepEqual(withExtraPending.positions.get(id), a.positions.get(id), `${id} stayed untouched`);
  }
});

test('mergeGraphPositions keeps manual positions intact and shifts colliding new tasks clear', () => {
  const auto = new Map([['a', { x: 0, y: 0 }], ['new', { x: 0, y: 0 }]]);
  const stored = new Map([['a', { x: 0, y: 0 }]]);
  const sizes = new Map([['a', { width: 210, height: 100 }], ['new', { width: 210, height: 80 }]]);
  const merged = graph.mergeGraphPositions(auto, stored, sizes);
  assert.deepEqual(merged.get('a'), { x: 0, y: 0 }, 'manual placement is kept');
  assert.deepEqual(merged.get('new'), { x: 0, y: 116 }, 'new task clears manual node without overlap');
});

test('hideClosed storage parsing and filterGraphTasks keep closed predecessors of open tasks', () => {
  assert.equal(graph.graphHideClosedStorageKey('c1'), 'orrery.workbench.graphHideClosed.c1');
  assert.equal(graph.parseGraphHideClosed(null), false);
  assert.equal(graph.parseGraphHideClosed('0'), false);
  assert.equal(graph.parseGraphHideClosed('1'), true);
  assert.equal(graph.parseGraphHideClosed('true'), true);

  const tasks = [
    { id: 'c-root', status: 'completed', dependencyIds: [] },
    { id: 'c-mid', status: 'merged', dependencyIds: ['c-root'] },
    { id: 'open', status: 'working', dependencyIds: ['c-mid'] },
    { id: 'c-standalone', status: 'cancelled', dependencyIds: [] },
    { id: 'c-after-open', status: 'completed', dependencyIds: ['open'] },
  ];
  assert.equal(graph.filterGraphTasks(tasks, false).length, 5);
  assert.deepEqual(
    graph.filterGraphTasks(tasks, true).map((t: any) => t.id),
    ['c-root', 'c-mid', 'open'],
  );
});

test('arrangeGraphLayout matches canvas aspect ratio across landscape/portrait sizes and keeps FIT_MIN_ZOOM readable floor', () => {
  const layoutAspect = (arranged: any) => {
    const rects = [
      ...[...arranged.positions].map(([id, p]) => ({ id, x: p.x, y: p.y, width: 210, height: 100 })),
      ...arranged.sections.map((s: any) => ({ id: `sec-${s.key}`, x: s.x, y: s.y, width: s.width, height: s.height })),
    ];
    assertNoOverlaps(rects);
    const minX = Math.min(...rects.map((r) => r.x)), maxX = Math.max(...rects.map((r) => r.x + r.width));
    const minY = Math.min(...rects.map((r) => r.y)), maxY = Math.max(...rects.map((r) => r.y + r.height));
    return { rects, aspect: (maxX - minX) / (maxY - minY), width: maxX - minX, height: maxY - minY };
  };

  // 32 mostly-standalone cluster on wide landscape (1000x400) vs portrait (340x500)
  const nodes32 = [
    { id: 'c1', task: { id: 'c1', number: 1, status: 'completed' } },
    { id: 'c2', task: { id: 'c2', number: 2, status: 'working' } },
    { id: 'c3', task: { id: 'c3', number: 3, status: 'pending' } },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, task: { id: `w${i}`, number: 4 + i, status: 'working' } })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, task: { id: `r${i}`, number: 10 + i, status: 'review' } })),
    ...Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, task: { id: `p${i}`, number: 15 + i, status: 'pending' } })),
    ...Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, task: { id: `d${i}`, number: 26 + i, status: 'completed' } })),
  ];
  const edges32 = [{ from: 'c1', to: 'c2' }, { from: 'c2', to: 'c3' }];

  const wide32 = layoutAspect(graph.arrangeGraphLayout({ nodes: nodes32, edges: edges32, heightOf: () => 100, viewportWidth: 1000, viewportHeight: 400 }));
  assert.ok(wide32.aspect >= 1.5 && wide32.aspect <= 3.8, `expected wide layout aspect ~2.5, got ${wide32.aspect.toFixed(2)}`);
  const wideFit = graph.fitGraphView(wide32.rects, { width: 1000, height: 400 });
  assert.equal(wideFit.k, graph.FIT_MIN_ZOOM, '32-task wide view stays at readable FIT_MIN_ZOOM instead of shrinking to tiny text');

  const tall32 = layoutAspect(graph.arrangeGraphLayout({ nodes: nodes32, edges: edges32, heightOf: () => 100, viewportWidth: 340, viewportHeight: 500 }));
  assert.ok(tall32.aspect >= 0.35 && tall32.aspect <= 1.25, `expected portrait layout aspect ~0.68, got ${tall32.aspect.toFixed(2)}`);

  // Multi-chain cluster places chains + standalone side-by-side when it matches a wide canvas better
  const nodesChains = [
    { id: 'a1', task: { id: 'a1', number: 1, status: 'completed' } }, { id: 'a2', task: { id: 'a2', number: 2, status: 'working' } },
    { id: 'a3', task: { id: 'a3', number: 3, status: 'review' } }, { id: 'a4', task: { id: 'a4', number: 4, status: 'pending' } },
    { id: 'b1', task: { id: 'b1', number: 5, status: 'completed' } }, { id: 'b2', task: { id: 'b2', number: 6, status: 'working' } },
    { id: 'b3', task: { id: 'b3', number: 7, status: 'pending' } },
    { id: 'c1', task: { id: 'c1', number: 8, status: 'working' } }, { id: 'c2', task: { id: 'c2', number: 9, status: 'pending' } },
    { id: 's1', task: { id: 's1', number: 10, status: 'working' } },
    { id: 's2', task: { id: 's2', number: 11, status: 'pending' } },
    { id: 's3', task: { id: 's3', number: 12, status: 'completed' } },
  ];
  const edgesChains = [
    { from: 'a1', to: 'a2' }, { from: 'a1', to: 'a3' }, { from: 'a2', to: 'a4' }, { from: 'a3', to: 'a4' },
    { from: 'b1', to: 'b2' }, { from: 'b1', to: 'b3' }, { from: 'c1', to: 'c2' },
  ];
  const arrangedChains = graph.arrangeGraphLayout({ nodes: nodesChains, edges: edgesChains, heightOf: () => 100, viewportWidth: 1000, viewportHeight: 400 });
  const chainsInfo = layoutAspect(arrangedChains);
  assert.ok(arrangedChains.positions.get('s1').x > arrangedChains.positions.get('a4').x, 'wide canvas places standalone beside chains');
  assert.ok(chainsInfo.aspect >= 1.5 && chainsInfo.aspect <= 3.8, `expected chain layout aspect ~2.5, got ${chainsInfo.aspect.toFixed(2)}`);
});
