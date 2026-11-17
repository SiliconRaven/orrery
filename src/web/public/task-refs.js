// Task references in chat messages (docs/collaboration.md「消息里引用任务」): `#<number>` or legacy `#<full task id>`.
// The Hub never parses them; the page turns them into links once it knows the task exists in this cluster.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** `#` starts a word (same rule as `$skill`); a longer word after the ref (`#12a`, `#12-x`, `#<id>a`) is not a reference. */
export const TASK_REF = new RegExp(`(?<![A-Za-z0-9_#])#(${UUID}|[1-9][0-9]*)(?![A-Za-z0-9_-])`, 'g');

const isTaskRefToken = (ref) => ref.includes('-') || (/^[1-9][0-9]{0,14}$/.test(ref) && Number.isSafeInteger(Number(ref)));

/** The distinct task refs (`<number>` or `<full UUID>`) in a body, in order. Quotes and code are not excluded: this only decides what to look up. */
export function taskRefIds(body) {
  if (typeof body !== 'string' || !body.includes('#')) return [];
  return [...new Set([...body.matchAll(TASK_REF)].map((m) => m[1]).filter(isTaskRefToken))];
}

/**
 * The [start, end) ranges of `text` that are code or quoted: the same rule as the Hub's parseMentions, so a `#` is
 * plain text exactly where an `@` is. A closer with none left ahead stops being searched for, so a long run of
 * unmatched openers stays linear.
 */
export function quotedRanges(text) {
  const ranges = [];
  const closing = { '"': '"', "'": "'", '“': '”', '‘': '’' };
  const exhausted = new Set();
  for (let i = 0; i < text.length;) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      const stop = end < 0 ? text.length : end + 3;
      ranges.push([i, stop]); i = stop; continue;
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      const stop = end < 0 ? text.length : end + 1;
      ranges.push([i, stop]); i = stop; continue;
    }
    const close = closing[text[i]];
    if (close && !exhausted.has(close)) {
      const sameLine = close === '"' || close === "'";   // these two end at a newline; a backslash escapes in them
      let cursor = i + 1;
      while (cursor < text.length && text[cursor] !== close) {
        if (sameLine) {
          if (text[cursor] === '\\' && cursor + 1 < text.length) { cursor += 2; continue; }
          if (text[cursor] === '\n') break;
        }
        cursor++;
      }
      if (cursor < text.length && text[cursor] === close) { ranges.push([i, cursor + 1]); i = cursor + 1; continue; }
      if (cursor >= text.length) exhausted.add(close);
    }
    i++;
  }
  return ranges;
}

export const inRanges = (ranges, at) => ranges.some(([start, end]) => at >= start && at < end);

/** Whether a picker query matches: part of the title, `#number` digits, or the start of the id (hyphens optional). `query` is lowercase. */
export function taskRefMatches(candidate, query) {
  if (!query) return true;
  if (candidate.title.toLowerCase().includes(query)) return true;
  if (candidate.number != null && String(candidate.number).startsWith(query)) return true;
  const hex = query.replace(/-/g, '');
  const id = String(candidate.id ?? candidate.name ?? '').toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]+$/.test(hex) && id.startsWith(hex);
}

const MAX_CACHED_PER_CLUSTER = 5000;

/**
 * The page's one lookup of referenced tasks: `load(clusterId, ids)` → [{ id, title }] for those that exist there.
 * track() is called while rendering and never fetches by itself: ids it has not seen are queued, a timer sends them
 * in bounded batches, one request at a time, and onChange() fires only when something a link shows has changed.
 * A failed lookup counts as "no such task" (plain text) until the next collaboration event marks it stale.
 */
export function createTaskRefs({ load, onChange, batch = 100, delay = 60 }) {
  const clusters = new Map();   // clusterId -> { tasks: Map(id -> task | null), stale, queued, loading }
  let timer = null;
  let busy = false;
  const entry = (clusterId) => {
    if (!clusters.has(clusterId)) clusters.set(clusterId, { tasks: new Map(), stale: new Set(), queued: new Set(), loading: new Set() });
    return clusters.get(clusterId);
  };
  const schedule = () => { if (timer === null && !busy) timer = setTimeout(flush, delay); };
  async function flush() {
    timer = null;
    const next = [...clusters].find(([, c]) => c.queued.size);
    if (!next) return;
    const [clusterId, c] = next;
    const ids = [...c.queued].slice(0, batch);
    for (const id of ids) { c.queued.delete(id); c.stale.delete(id); c.loading.add(id); }
    busy = true;
    let tasks = null;
    try { tasks = await load(clusterId, ids); } catch { tasks = null; }
    busy = false;
    const found = new Map();
    for (const t of tasks ?? []) {
      found.set(t.id, t);
      if (t.number != null) found.set(String(t.number), t);
    }
    const remember = (key, task) => {
      c.tasks.set(key, task);
      if (c.tasks.size > MAX_CACHED_PER_CLUSTER) c.tasks.delete(c.tasks.keys().next().value);
    };
    let changed = false;
    for (const id of ids) {
      c.loading.delete(id);
      const task = found.get(id) ?? null;
      const prev = c.tasks.get(id);
      if (prev?.title !== task?.title || prev?.number !== task?.number) changed = true;   // unknown → missing is plain text either way
      remember(id, task);
      if (task) {
        remember(task.id, task);
        if (task.number != null) remember(String(task.number), task);
      }
    }
    if (changed) onChange();
    if ([...clusters.values()].some((other) => other.queued.size)) schedule();
  }
  return {
    /** { id, number?, title, status? }, null when there is no such task here, undefined when not known yet (shown as plain text too). */
    get: (clusterId, id) => clusters.get(clusterId)?.tasks.get(id),
    /** Queues what must be looked up; returns a key that changes whenever a link for these refs would look different. */
    track(clusterId, ids) {
      if (!ids.length) return '';
      const c = entry(clusterId);
      let added = false;
      for (const id of ids) {
        if (c.queued.has(id) || !(c.stale.has(id) || (!c.tasks.has(id) && !c.loading.has(id)))) continue;
        c.queued.add(id);
        added = true;
      }
      if (added) schedule();
      return ids.map((id) => { const t = c.tasks.get(id); return t ? `${t.number ?? ''}:${t.title}` : ''; }).join('\n');
    },
    /** A task in this cluster may have changed: known ids are looked up again the next time a message shows them. */
    changed(clusterId) {
      const c = clusters.get(clusterId);
      if (c) c.stale = new Set(c.tasks.keys());
    },
  };
}

/** Status words, the same as the task workbench's status chips (workbench.js STATUS). */
const TASK_STATUS = { pending: '待开工', accepted: '待开工', working: '进行中', review: '待验收', completed: '已完成', merged: '已合并', cancelled: '已取消' };

/**
 * A # picker row's status chip: its words and the workbench chip classes that colour it (workbench.css `.wb-status-*`).
 * No status (an old Hub): null, the row shows none. An unknown status shows as it is, uncoloured.
 */
export function taskStatusChip(status) {
  if (!status) return null;
  const known = Object.hasOwn(TASK_STATUS, status);
  return { label: known ? TASK_STATUS[status] : String(status), className: `wb-status wb-status-${status === 'accepted' ? 'pending' : known ? status : 'unknown'}` };
}

/**
 * The # picker's source: `load(clusterId, query)` → [{ id, number?, title, status? }] from the Hub, at most 20, never the whole task list.
 * The Hub orders them (an exact #number first, then unfinished before finished, most recently updated first); the
 * picker keeps that order.
 * Returns what is known now and asks once per cluster + query; onChange() fires when the answer arrives (late answers
 * to an older query are dropped). reset() makes the next call ask again.
 */
export function createTaskCandidates({ load, onChange }) {
  let current = { key: null, clusterId: null, items: [] };
  const source = (clusterId, query) => {
    if (!clusterId) return [];
    const key = JSON.stringify([clusterId, query]);
    if (key === current.key) return current.items;
    const mine = { key, clusterId, items: current.clusterId === clusterId ? current.items : [] };
    current = mine;
    const done = (items) => {
      mine.items = items;
      if (mine === current) onChange();
    };
    load(clusterId, query).then(
      (tasks) => done(tasks.map((t) => ({ name: t.number != null ? String(t.number) : t.id, ...(t.number != null ? { id: t.id, number: t.number } : {}), title: t.title,
        ...(t.status ? { status: t.status } : {}) }))),
      () => done([]),
    );
    return mine.items;
  };
  source.reset = () => { current.key = null; };
  return source;
}
