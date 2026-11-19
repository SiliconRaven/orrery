import { t } from "./i18n.js";
// The dependency graph's canvas: wheel zoom, panning, free node dragging and automatic arrangement. Layout preferences
// stay in this browser (localStorage, per cluster) and never reach the Hub. Pure helpers are tested in test/workbench-graph.test.ts.
import { confirmDialog, emptyState, h, icon, lt } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LAYOUT_VERSION = 1;
const MAX_COORDINATE = 1_000_000;
// shortcut: while paging or a filter hides tasks, a deleted task cannot be told from a hidden one, so only this cap bounds
// storage and past it the oldest placements go; raise it if a real cluster ever hand-places this many nodes.
const MAX_STORED_POSITIONS = 1000;
const NODE_WIDTH = 210, COLUMN_GAP = 64, ROW_GAP = 16;
const COMPONENT_GAP_X = 48, COMPONENT_GAP_Y = 36, AREA_GAP = 40;
const GRID_COLUMN_GAP = 20, GRID_ROW_GAP = 16, SECTION_HEADER_HEIGHT = 24, SECTION_HEADER_GAP = 10, SECTION_GAP = 28;
const DEFAULT_NODE_HEIGHT = 96;
const CLOSED_STATUSES = new Set(['completed', 'merged', 'cancelled']);
const STANDALONE_GROUPS = [
  { key: 'working', label: '进行中' },
  { key: 'review', label: '待验收' },
  { key: 'pending', label: '待开工' },
  { key: 'closed', label: '已结束' },
];

export const GRAPH_ZOOM = Object.freeze({ min: 0.25, max: 2, step: 1.2 });
// Readability floor for fit/arrange (~9.1px on 14px titles); larger graphs pan/wheel rather than shrinking to specks.
export const FIT_MIN_ZOOM = 0.65;
const FIT_PADDING = 24;

export const clampGraphZoom = (k) => Math.min(GRAPH_ZOOM.max, Math.max(GRAPH_ZOOM.min, k));

/** The view at zoom `k` (clamped) that leaves the world point under `point` exactly where it is on screen. */
export function zoomGraphAt(view, k, point) {
  const next = clampGraphZoom(k);
  const ratio = next / view.k;
  return { k: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** Pointer travel of at least `threshold` px is a drag; anything less is still a click. */
export const isGraphDrag = (dx, dy, threshold = 4) => Math.hypot(dx, dy) >= threshold;

/** localStorage key of the hand-placed node positions of one cluster. */
export const graphLayoutStorageKey = (clusterId) => `orrery.workbench.graphLayout.${clusterId}`;

/** localStorage key of whether closed standalone tasks are hidden in one cluster's dependency graph. */
export const graphHideClosedStorageKey = (clusterId) => `orrery.workbench.graphHideClosed.${clusterId}`;

export const parseGraphHideClosed = (raw) => raw === '1' || raw === 'true';

/**
 * Hides closed tasks (completed/merged/cancelled) unless another visible open task depends on them (directly or
 * transitively along loaded dependency edges, so a kept closed node never gains a spurious "unloaded" placeholder).
 */
export function filterGraphTasks(tasks, hideClosed) {
  if (!hideClosed) return tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const keep = new Set();
  const stack = [];
  for (const task of tasks) {
    if (!CLOSED_STATUSES.has(task.status)) { keep.add(task.id); stack.push(task); }
  }
  while (stack.length) {
    const current = stack.pop();
    for (const depId of current.dependencyIds ?? []) {
      const dep = byId.get(depId);
      if (dep && !keep.has(dep.id)) { keep.add(dep.id); stack.push(dep); }
    }
  }
  return tasks.filter((task) => keep.has(task.id));
}

const validPoint = (point) => [point?.x, point?.y].every((value) => typeof value === 'number' && Math.abs(value) <= MAX_COORDINATE);

/** Stored positions as a Map. Corrupt storage is an empty layout; one bad entry only loses that node. */
export function parseGraphLayout(raw) {
  try {
    const stored = JSON.parse(raw);
    if (stored?.version !== LAYOUT_VERSION || !stored.positions || typeof stored.positions !== 'object' || Array.isArray(stored.positions)) return new Map();
    return new Map(Object.entries(stored.positions).filter(([, point]) => validPoint(point)).map(([id, point]) => [id, { x: point.x, y: point.y }]));
  } catch {
    return new Map();
  }
}

/** The JSON to store; insertion order is recency, so the cap drops the placements touched longest ago. */
export const serializeGraphLayout = (positions) => JSON.stringify({ version: LAYOUT_VERSION,
  positions: Object.fromEntries([...positions].slice(-MAX_STORED_POSITIONS)) });

/** Only the positions of nodes that still exist. Call it only with a complete task list. */
export const pruneGraphLayout = (positions, liveIds) => new Map([...positions].filter(([id]) => liveIds.has(id)));

const compareGraphNodes = (a, b) => {
  const an = a.task?.number ?? Number.MAX_SAFE_INTEGER;
  const bn = b.task?.number ?? Number.MAX_SAFE_INTEGER;
  if (an !== bn) return an - bn;
  const ac = a.task?.createdAt ?? '';
  const bc = b.task?.createdAt ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const standaloneGroupKey = (task) => {
  if (!task) return 'pending';
  if (CLOSED_STATUSES.has(task.status)) return 'closed';
  return task.status === 'working' || task.status === 'review' ? task.status : 'pending';
};

/** Lays out one connected dependency component with predecessors left, dependents right, ordered by predecessor y. */
function layoutComponent(compNodes, compEdges, heightOf) {
  const byId = new Map(compNodes.map((node) => [node.id, node]));
  const directed = compEdges.filter((edge) => edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to));
  const predsOf = new Map(compNodes.map((node) => [node.id, []]));
  for (const edge of directed) predsOf.get(edge.to).push(edge.from);

  const remaining = new Set([...compNodes].sort(compareGraphNodes).map((node) => node.id));
  const rawLayers = [];
  while (remaining.size) {
    const layerIds = [...remaining].filter((id) => predsOf.get(id).every((predId) => !remaining.has(predId)));
    if (!layerIds.length) { rawLayers.push([...remaining]); break; }
    rawLayers.push(layerIds);
    for (const id of layerIds) remaining.delete(id);
  }

  const positions = new Map();
  const midY = new Map();
  let maxBottom = 0;
  rawLayers.forEach((layerIds, column) => {
    const ordered = layerIds.map((id) => byId.get(id)).sort((a, b) => {
      if (column > 0) {
        const score = (id) => {
          const placed = predsOf.get(id).map((predId) => midY.get(predId)).filter((y) => y !== undefined);
          return placed.length ? placed.reduce((sum, y) => sum + y, 0) / placed.length : Number.MAX_SAFE_INTEGER;
        };
        const diff = score(a.id) - score(b.id);
        if (Math.abs(diff) > 1e-6) return diff;
      }
      return compareGraphNodes(a, b);
    });
    let y = 0;
    for (const node of ordered) {
      const h = heightOf(node.id);
      positions.set(node.id, { x: column * (NODE_WIDTH + COLUMN_GAP), y });
      midY.set(node.id, y + h / 2);
      maxBottom = Math.max(maxBottom, y + h);
      y += h + ROW_GAP;
    }
  });
  const width = rawLayers.length * NODE_WIDTH + Math.max(0, rawLayers.length - 1) * COLUMN_GAP;
  return { positions, width, height: maxBottom, nodeCount: compNodes.length, edgeCount: directed.length, firstNode: [...compNodes].sort(compareGraphNodes)[0] };
}

function packComponents(components, wrapWidth) {
  const placements = [];
  let x = 0, y = 0, rowH = 0, width = 0, height = 0;
  for (const comp of components) {
    if (x > 0 && x + comp.width > wrapWidth) {
      y += rowH + COMPONENT_GAP_Y;
      x = 0;
      rowH = 0;
    }
    placements.push({ comp, x, y });
    width = Math.max(width, x + comp.width);
    height = Math.max(height, y + comp.height);
    x += comp.width + COMPONENT_GAP_X;
    rowH = Math.max(rowH, comp.height);
  }
  return { placements, width, height };
}

function layoutStandaloneGrid(buckets, cols, heightOf) {
  const items = [];
  const sections = [];
  let y = 0, width = 0;
  for (const group of STANDALONE_GROUPS) {
    const groupNodes = buckets.get(group.key);
    if (!groupNodes.length) continue;
    const usedCols = Math.min(cols, groupNodes.length);
    const headerW = usedCols * NODE_WIDTH + Math.max(0, usedCols - 1) * GRID_COLUMN_GAP;
    width = Math.max(width, headerW);
    sections.push({ key: group.key, label: t('{label}（{count}）', { label: t(group.label), count: groupNodes.length }), x: 0, y, width: headerW, height: SECTION_HEADER_HEIGHT });
    y += SECTION_HEADER_HEIGHT + SECTION_HEADER_GAP;
    for (let i = 0; i < groupNodes.length; i += cols) {
      const row = groupNodes.slice(i, i + cols);
      let rowH = 0;
      row.forEach((node, column) => {
        items.push({ id: node.id, x: column * (NODE_WIDTH + GRID_COLUMN_GAP), y });
        rowH = Math.max(rowH, heightOf(node.id));
      });
      y += rowH + GRID_ROW_GAP;
    }
    y += SECTION_GAP - GRID_ROW_GAP;
  }
  return { items, sections, width, height: sections.length ? y - SECTION_GAP : 0 };
}

function candidateComponentPacks(components, availW) {
  if (!components.length) return [{ placements: [], width: 0, height: 0 }];
  const maxW = Math.max(...components.map((comp) => comp.width));
  const totalW = components.reduce((sum, comp) => sum + comp.width, 0) + Math.max(0, components.length - 1) * COMPONENT_GAP_X;
  const widths = new Set([maxW, totalW, Math.max(maxW, availW)]);
  for (let rows = 1; rows <= components.length; rows++) widths.add(Math.max(maxW, Math.ceil(totalW / rows)));
  let running = 0;
  for (const comp of components) {
    running += (running ? COMPONENT_GAP_X : 0) + comp.width;
    widths.add(Math.max(maxW, running));
  }
  const seen = new Set();
  const packs = [];
  for (const wrapW of [...widths].sort((a, b) => a - b)) {
    const pack = packComponents(components, wrapW);
    const key = `${pack.width}x${pack.height}`;
    if (!seen.has(key)) { seen.add(key); packs.push(pack); }
  }
  return packs;
}

/**
 * Deterministic layout separating connected dependency groups (largest first) from dependency-free tasks
 * (status-grouped multi-column grid). Picks wrapping, grid columns, and stacked vs. side-by-side placement so
 * the overall aspect ratio hugs the canvas and automatic fit zoom stays as large as possible.
 */
export function arrangeGraphLayout({ nodes, layers, edges = [], heightOf = () => DEFAULT_NODE_HEIGHT, viewportWidth = 960, viewportHeight = 440 }) {
  const flatNodes = [...new Map((nodes ?? layers?.flat() ?? []).map((node) => [node.id, node])).values()];
  if (!flatNodes.length) return { positions: new Map(), sections: [] };
  const byId = new Map(flatNodes.map((node) => [node.id, node]));
  const adj = new Map(flatNodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to)) continue;
    adj.get(edge.from).add(edge.to);
    adj.get(edge.to).add(edge.from);
  }

  const seen = new Set();
  const components = [];
  const standalone = [];
  for (const node of [...flatNodes].sort(compareGraphNodes)) {
    if (seen.has(node.id)) continue;
    if (adj.get(node.id).size === 0) { seen.add(node.id); standalone.push(node); continue; }
    const compIds = new Set();
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length) {
      const cur = queue.shift();
      compIds.add(cur);
      for (const next of adj.get(cur)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    const compNodes = [...compIds].map((id) => byId.get(id));
    const compEdges = edges.filter((edge) => compIds.has(edge.from) && compIds.has(edge.to));
    components.push(layoutComponent(compNodes, compEdges, heightOf));
  }

  components.sort((a, b) => (b.nodeCount - a.nodeCount) || (b.edgeCount - a.edgeCount) || compareGraphNodes(a.firstNode, b.firstNode));

  const vpW = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 960;
  const vpH = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 440;
  const availW = Math.max(NODE_WIDTH, vpW - 2 * FIT_PADDING);
  const availH = Math.max(DEFAULT_NODE_HEIGHT, vpH - 2 * FIT_PADDING);
  const targetAspect = availW / availH;

  const buckets = new Map(STANDALONE_GROUPS.map((group) => [group.key, []]));
  for (const node of standalone) buckets.get(standaloneGroupKey(node.task)).push(node);
  for (const list of buckets.values()) list.sort(compareGraphNodes);

  const compPacks = candidateComponentPacks(components, availW);
  const maxGridCols = Math.max(1, ...STANDALONE_GROUPS.map((group) => buckets.get(group.key).length));
  const gridPacks = standalone.length
    ? Array.from({ length: maxGridCols }, (_, index) => layoutStandaloneGrid(buckets, index + 1, heightOf))
    : [{ items: [], sections: [], width: 0, height: 0 }];

  const modes = components.length && standalone.length ? ['stack', 'side'] : ['stack'];
  let best = null;
  for (const compPack of compPacks) {
    for (const gridPack of gridPacks) {
      for (const mode of modes) {
        const dxGrid = mode === 'side' ? compPack.width + AREA_GAP : 0;
        const dyGrid = mode === 'stack' && components.length ? compPack.height + AREA_GAP : 0;
        const totalW = mode === 'side' ? compPack.width + AREA_GAP + gridPack.width : Math.max(compPack.width, gridPack.width);
        const totalH = mode === 'side' ? Math.max(compPack.height, gridPack.height)
          : standalone.length ? dyGrid + gridPack.height : compPack.height;
        const fitScale = Math.min(1, availW / totalW, availH / totalH);
        const aspectDiff = Math.abs(Math.log((totalW / totalH) / targetAspect));
        const area = totalW * totalH;
        const better = !best
          || fitScale > best.fitScale + 0.01
          || (Math.abs(fitScale - best.fitScale) <= 0.01 && (
            aspectDiff < best.aspectDiff - 1e-6
            || (Math.abs(aspectDiff - best.aspectDiff) <= 1e-6 && area < best.area - 1e-6)));
        if (better) best = { compPack, gridPack, dxGrid, dyGrid, fitScale, aspectDiff, area };
      }
    }
  }

  const positions = new Map();
  for (const { comp, x, y } of best.compPack.placements) {
    for (const [id, point] of comp.positions) positions.set(id, { x: x + point.x, y: y + point.y });
  }
  const sections = best.gridPack.sections.map((sec) => ({ ...sec, x: best.dxGrid + sec.x, y: best.dyGrid + sec.y }));
  for (const item of best.gridPack.items) positions.set(item.id, { x: best.dxGrid + item.x, y: best.dyGrid + item.y });
  return { positions, sections };
}

const rectsOverlap = (ax, ay, aw, ah, rect) => ax < rect.x + rect.width && ax + aw > rect.x && ay < rect.y + rect.height && ay + ah > rect.y;

/**
 * Every node of the automatic layout, at its stored position when it has one. When node `sizes` are provided, any
 * unstored/new node whose automatic slot collides with an already placed node shifts down cleanly so nothing overlaps.
 */
export function mergeGraphPositions(auto, stored, sizes = null) {
  if (!sizes) return new Map([...auto].map(([id, point]) => [id, stored.get(id) ?? point]));
  const result = new Map();
  const placed = [];
  const sizeOf = (id) => sizes.get(id) ?? { width: NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
  for (const [id] of auto) {
    const manual = stored.get(id);
    if (!manual) continue;
    const size = sizeOf(id);
    result.set(id, manual);
    placed.push({ x: manual.x, y: manual.y, width: size.width, height: size.height });
  }
  for (const [id, point] of auto) {
    if (stored.has(id)) continue;
    const size = sizeOf(id);
    let y = point.y;
    for (;;) {
      const hit = placed.filter((rect) => rectsOverlap(point.x, y, size.width, size.height, rect));
      if (!hit.length) break;
      y = Math.max(...hit.map((rect) => rect.y + rect.height)) + ROW_GAP;
    }
    result.set(id, { x: point.x, y });
    placed.push({ x: point.x, y, width: size.width, height: size.height });
  }
  return result;
}

/**
 * The view showing all `rects` centred in `size`, capped between `minZoom` (readable floor) and 100%.
 * When `minZoom` prevents fitting the whole graph at once, overflowing axes anchor at `padding` from top-left for panning.
 */
export function fitGraphView(rects, size, padding = FIT_PADDING, minZoom = FIT_MIN_ZOOM) {
  if (!rects.length || !(size.width > 0) || !(size.height > 0)) return null;
  const left = Math.min(...rects.map((rect) => rect.x)), top = Math.min(...rects.map((rect) => rect.y));
  const width = Math.max(...rects.map((rect) => rect.x + rect.width)) - left;
  const height = Math.max(...rects.map((rect) => rect.y + rect.height)) - top;
  const raw = Math.min(1, (size.width - 2 * padding) / width, (size.height - 2 * padding) / height);
  const k = clampGraphZoom(Math.max(minZoom, raw));
  return {
    k,
    x: width * k <= size.width ? (size.width - width * k) / 2 - left * k : padding - left * k,
    y: height * k <= size.height ? (size.height - height * k) / 2 - top * k : padding - top * k,
  };
}

/** The view that brings `rect` on screen for a keyboard user: unchanged if it is fully visible, otherwise centred on it. */
export function revealGraphRect(view, rect, size) {
  const x = rect.x * view.k + view.x, y = rect.y * view.k + view.y;
  if (x >= 0 && y >= 0 && x + rect.width * view.k <= size.width && y + rect.height * view.k <= size.height) return view;
  return { k: view.k, x: size.width / 2 - (rect.x + rect.width / 2) * view.k, y: size.height / 2 - (rect.y + rect.height / 2) * view.k };
}

/** A curve from the right middle of one node to the left middle of the next; it loops when the target sits to the left. */
export function graphEdgePath(from, to) {
  const x1 = from.x + from.width, y1 = from.y + from.height / 2;
  const x2 = to.x, y2 = to.y + to.height / 2;
  const bend = Math.max(32, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

const readLocal = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeLocal = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode: this page's memory still has it */ } };
const removeLocal = (key) => { try { localStorage.removeItem(key); } catch { /* private mode: nothing was stored */ } };

function edgeLayer() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'workbench-edges');
  svg.setAttribute('aria-hidden', 'true');
  const marker = document.createElementNS(SVG_NS, 'marker');
  for (const [key, value] of Object.entries({ id: 'wb-graph-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '4', markerHeight: '4', orient: 'auto' })) marker.setAttribute(key, value);
  const tip = document.createElementNS(SVG_NS, 'path');
  tip.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
  marker.append(tip);
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.append(marker);
  svg.append(defs);
  return svg;
}

/**
 * The canvas outlives every rebuild of its DOM: zoom, pan, hideClosed and manual positions stay here, per cluster.
 * `rerender` redraws the workbench; while busy() the workbench defers that redraw, because replacing the nodes would
 * end a drag or interrupt the arrange confirmation dialog.
 */
export function createGraphCanvas({ onOpen, rerender, settled }) {
  const clusters = new Map();
  let gesture = null;
  let confirming = false;

  const stateOf = (clusterId) => {
    if (!clusters.has(clusterId)) {
      clusters.set(clusterId, {
        positions: parseGraphLayout(readLocal(graphLayoutStorageKey(clusterId))),
        view: null,
        hideClosed: parseGraphHideClosed(readLocal(graphHideClosedStorageKey(clusterId))),
        pendingFit: false,
      });
    }
    return clusters.get(clusterId);
  };

  /** Builds the canvas for this render. `layers` holds { id, task?, element }; `complete` says nothing is hidden. */
  function canvas({ clusterId, layers, edges, complete, emptyNote = '' }) {
    gesture = null;   // only reached with no live gesture: a stale one ended with a dialog closed mid-drag
    const state = stateOf(clusterId);
    const storageKey = graphLayoutStorageKey(clusterId);
    const focusedId = document.activeElement?.dataset?.graphId;
    const flatNodes = layers.flat();
    const elements = new Map(flatNodes.map(({ id, element }) => { element.dataset.graphId = id; return [id, element]; }));
    if (complete) {
      const live = pruneGraphLayout(state.positions, new Set(elements.keys()));
      if (live.size !== state.positions.size) { state.positions = live; writeLocal(storageKey, serializeGraphLayout(live)); }
    }

    const svg = edgeLayer();
    const lines = edges.map((edge) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', 'wb-edge');
      path.setAttribute('marker-end', 'url(#wb-graph-arrow)');
      svg.append(path);
      return { ...edge, path };
    });
    const sectionLayer = h('div', { class: 'workbench-graph-sections', 'aria-hidden': 'true' });
    const world = h('div', { class: 'workbench-graph-world' }, svg, sectionLayer, [...elements.values()]);
    const emptyEl = emptyNote && !elements.size ? emptyState(emptyNote) : null;
    const viewport = h('div', { class: 'workbench-graph', role: 'group', 'aria-label': t("任务依赖图") }, world, emptyEl);
    const rects = new Map();   // id -> { x, y, width, height } in world units
    let sectionRects = [];
    let restoringFocus = false;

    const viewOf = () => state.view ?? { x: 16, y: 16, k: 1 };   // readable at 100% first; 适应窗口 shows it all
    const sizeOf = () => ({ width: viewport.clientWidth, height: viewport.clientHeight });
    const setView = (next) => { state.view = next; world.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.k})`; };
    const place = (id) => { const { x, y } = rects.get(id); const el = elements.get(id); el.style.left = `${x}px`; el.style.top = `${y}px`; };
    const drawEdges = (touching = null) => {
      for (const line of lines) {
        const from = rects.get(line.from), to = rects.get(line.to);
        if (from && to && (touching === null || touching === line.from || touching === line.to)) line.path.setAttribute('d', graphEdgePath(from, to));
      }
    };
    const fit = () => { const next = fitGraphView([...rects.values(), ...sectionRects], sizeOf()); if (next) setView(next); };
    const zoomBy = (factor) => {
      const { width, height } = sizeOf();
      setView(zoomGraphAt(viewOf(), viewOf().k * factor, { x: width / 2, y: height / 2 }));
    };
    const arrange = async () => {
      confirming = true;
      let ok = false;
      try {
        ok = await confirmDialog({
          title: lt("自动整理依赖图？"),
          message: lt("这会清除你在这个群里手动拖动过的位置，并按依赖和状态重新排布全部任务。"),
          confirmText: lt("自动整理"),
          danger: state.positions.size > 0,
        });
      } finally {
        confirming = false;
      }
      if (!ok) { settled(); return; }
      state.positions = new Map();
      state.pendingFit = true;
      removeLocal(storageKey);
      rerender();
    };

    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const box = viewport.getBoundingClientRect();
      const pixels = event.deltaY * (event.deltaMode ? 16 : 1);   // Firefox reports lines
      setView(zoomGraphAt(viewOf(), viewOf().k * Math.exp(-pixels * 0.0015),
        { x: event.clientX - box.left - viewport.clientLeft, y: event.clientY - box.top - viewport.clientTop }));
    }, { passive: false });

    viewport.addEventListener('pointerdown', (event) => {
      if (gesture || event.button !== 0 || !elements.size) return;
      const element = event.target.closest('[data-graph-id]');
      (element ?? viewport).setPointerCapture(event.pointerId);
      gesture = { pointerId: event.pointerId, element, id: element?.dataset.graphId ?? null, startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY, moved: false };
    });
    viewport.addEventListener('pointermove', (event) => {
      if (event.pointerId !== gesture?.pointerId) return;
      if (!gesture.moved) {
        if (!isGraphDrag(event.clientX - gesture.startX, event.clientY - gesture.startY, event.pointerType === 'touch' ? 8 : 4)) return;
        gesture.moved = true;
        (gesture.element ?? viewport).classList.add('wb-graph-grabbing');
      }
      const dx = event.clientX - gesture.lastX, dy = event.clientY - gesture.lastY;
      gesture.lastX = event.clientX; gesture.lastY = event.clientY;
      if (gesture.id === null) { const view = viewOf(); setView({ ...view, x: view.x + dx, y: view.y + dy }); return; }
      const rect = rects.get(gesture.id);
      rect.x += dx / viewOf().k; rect.y += dy / viewOf().k;
      place(gesture.id);
      drawEdges(gesture.id);
    });
    const finish = (event) => {
      if (event.pointerId !== gesture?.pointerId) return;
      const { id, element, moved } = gesture;
      gesture = null;
      (element ?? viewport).classList.remove('wb-graph-grabbing');
      if (moved && id !== null) {
        const { x, y } = rects.get(id);
        state.positions.delete(id);   // re-inserting makes it the most recent for the storage cap
        state.positions.set(id, { x, y });
        writeLocal(storageKey, serializeGraphLayout(state.positions));
      }
      if (event.type === 'pointerup' && !moved && element?.matches('button')) onOpen(id);
      else settled();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(type, finish);
    // Pointers open a task on pointerup above, whose redraw would otherwise race the click; keyboard clicks have detail 0.
    viewport.addEventListener('click', (event) => { if (event.detail > 0) event.stopPropagation(); }, true);
    viewport.addEventListener('focusin', (event) => {
      if (restoringFocus || !event.target.matches(':focus-visible')) return;
      const rect = rects.get(event.target.dataset.graphId);
      if (rect) setView(revealGraphRect(viewOf(), rect, sizeOf()));
    });

    // Runs before the first paint of this DOM. Measure here: nodes have no size until they are connected.
    requestAnimationFrame(() => {
      if (!viewport.isConnected) return;
      const sizes = new Map([...elements].map(([id, element]) => [id, { width: element.offsetWidth, height: element.offsetHeight }]));
      const viewSize = sizeOf();
      const arranged = arrangeGraphLayout({ nodes: flatNodes, edges, heightOf: (id) => sizes.get(id).height, viewportWidth: viewSize.width, viewportHeight: viewSize.height });
      sectionRects = arranged.sections.map(({ x, y, width, height }) => ({ x, y, width, height }));
      sectionLayer.replaceChildren(...arranged.sections.map((sec) => {
        const el = h('div', { class: `workbench-graph-section sec-${sec.key}` }, sec.label);
        el.style.left = `${sec.x}px`;
        el.style.top = `${sec.y}px`;
        el.style.width = `${sec.width}px`;
        return el;
      }));
      for (const [id, point] of mergeGraphPositions(arranged.positions, state.positions, sizes)) {
        rects.set(id, { ...point, ...sizes.get(id) });
        place(id);
      }
      drawEdges();
      if (state.pendingFit) { state.pendingFit = false; fit(); }
      else setView(viewOf());
      restoringFocus = true;
      elements.get(focusedId)?.focus({ preventScroll: true });
      restoringFocus = false;
    });

    const tool = (label, onclick, title) => h('button', { type: 'button', class: 'small', onclick, 'aria-label': title ?? label, title }, label);
    const toggle = h('label', { class: 'workbench-graph-toggle' },
      h('input', {
        type: 'checkbox',
        checked: state.hideClosed,
        onchange: (event) => {
          state.hideClosed = Boolean(event.target.checked);
          writeLocal(graphHideClosedStorageKey(clusterId), state.hideClosed ? '1' : '0');
          rerender();
        },
      }),
      t("隐藏已结束"));
    return h('div', { class: 'workbench-graph-wrap' },
      h('div', { class: 'workbench-graph-tools', role: 'toolbar', 'aria-label': t("依赖图视图") },
        toggle,
        tool(icon('plus', 'ico-sm'), () => zoomBy(GRAPH_ZOOM.step), t("放大")), tool(icon('minus', 'ico-sm'), () => zoomBy(1 / GRAPH_ZOOM.step), t("缩小")),
        tool(t("适应窗口"), fit), tool(t("自动整理"), arrange)),
      viewport);
  }

  return {
    canvas,
    busy: () => gesture !== null || confirming,
    isHideClosed: (clusterId) => stateOf(clusterId).hideClosed,
    filterTasks: filterGraphTasks,
  };
}
