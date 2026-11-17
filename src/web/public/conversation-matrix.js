// The "全部对话" matrix (docs/architecture.md「全部对话」): conversations × clusters, as data. Pure: no DOM, no fetches,
// so a later view (a star map, say) can draw the same model.
import { harnessApp, sidebarSections, UNGROUPED } from './ui.js';

export { harnessApp };   // its home moved to ui.js (avatars use it too); importers of this module keep working

/**
 * Which physical conversation a membership is. A native conversation is one row however many clusters it is in: the
 * same app (harness) and the same session id (the Hub never shares one native session between two harnesses). A
 * member with no session id yet is its own row.
 */
export function conversationKey(member) {
  return member.workerSessionId
    ? JSON.stringify(['native', member.harness, member.workerSessionId])
    : JSON.stringify(['member', member.id]);
}

const STATUS_RANK = { busy: 2, idle: 1, offline: 0 };

/**
 * members, clusters, the Hub's group list and coordinators (clusterId → coordinator member id) → the matrix:
 * - columns: clusters in the sidebar's order (置顶, then the groups in the Hub's order, then 已归档), under column
 *   groups named as in the sidebar; archived clusters only with `showArchived` (`hiddenArchived` counts them);
 *   each with its active member count and how many are online;
 * - rowGroups: rows by app (harness), A–Z; inside a group
 *   busy first, then online, then offline, then by label;
 * - rows: one per conversation (conversationKey): its names in its clusters, status (busy if any membership is busy,
 *   online if any is), latest activity, and cells by cluster id ({ memberId, name, status, coordinator }); a row
 *   whose clusters are all hidden is left out.
 * `statusOf(member)` → 'busy' | 'idle' | 'offline'; `activityAt(member)` → an ISO time or null. Removed members and
 * members of clusters not in `clusters` are ignored.
 */
export function conversationMatrix({ members, clusters, groups = [], coordinators = {}, statusOf, activityAt = () => null, showArchived = false }) {
  const sections = sidebarSections(clusters, groups);
  const columnGroups = [
    ...(sections.pinned.length ? [{ name: '置顶', clusters: sections.pinned }] : []),
    ...sections.groups.filter((g) => g.clusters.length).map((g) => ({ name: g.name || UNGROUPED, clusters: g.clusters })),
    ...(showArchived && sections.archived.length ? [{ name: '已归档', clusters: sections.archived }] : []),
  ];
  const shown = new Map(columnGroups.flatMap((g) => g.clusters.map((c) => [c.id, c])));
  const active = members.filter((m) => !m.removedAt && clusters.some((c) => c.id === m.clusterId));
  const status = new Map(active.map((m) => [m.id, statusOf(m)]));
  const column = (c, group) => {
    const ms = active.filter((m) => m.clusterId === c.id);
    // A hidden member is not counted online; it is counted on its own (docs/cluster-members.md「隐身」).
    return { id: c.id, name: c.name, group, archived: Boolean(c.archivedAt), memberCount: ms.length,
      onlineCount: ms.filter((m) => !m.hiddenAt && status.get(m.id) !== 'offline').length,
      ...(ms.some((m) => m.hiddenAt) ? { hiddenCount: ms.filter((m) => m.hiddenAt).length } : {}) };
  };
  const grouped = columnGroups.map((g) => ({ name: g.name, columns: g.clusters.map((c) => column(c, g.name)) }));
  const columns = grouped.flatMap((g) => g.columns);

  const byKey = new Map();
  for (const m of active) {
    if (!shown.has(m.clusterId)) continue;
    const key = conversationKey(m);
    if (!byKey.has(key)) {
      byKey.set(key, { key, harness: m.harness, mode: 'native', sessionId: m.workerSessionId || null, cwd: m.cwd || null,
        names: [], status: 'offline', lastActivityAt: null, cells: {} });
    }
    const row = byKey.get(key);
    const s = status.get(m.id);
    row.cells[m.clusterId] = { memberId: m.id, clusterId: m.clusterId, name: m.name, status: s, coordinator: coordinators[m.clusterId] === m.id,
      ...(m.hiddenAt ? { hidden: true } : {}) };
    if (!row.names.includes(m.name)) row.names.push(m.name);
    if (STATUS_RANK[s] > STATUS_RANK[row.status]) row.status = s;
    const at = activityAt(m);
    if (at && Number.isFinite(Date.parse(at)) && (!row.lastActivityAt || Date.parse(at) > Date.parse(row.lastActivityAt))) row.lastActivityAt = at;
  }
  const order = (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.names.join('/').localeCompare(b.names.join('/'), 'zh-CN') || a.key.localeCompare(b.key);
  const rows = [...byKey.values()].map((r) => ({ ...r, label: r.names.join(' / ') }));
  const harnesses = [...new Set(rows.map((r) => r.harness))].sort((a, b) => a.localeCompare(b));
  const rowGroups = harnesses.map((harness) => ({ key: `native:${harness}`, harness, mode: 'native', label: harnessApp(harness).name, icon: harnessApp(harness).icon,
    rows: rows.filter((r) => r.harness === harness).sort(order) }));
  return { columnGroups: grouped, columns, rowGroups,
    rowCount: rows.length, hiddenArchived: showArchived ? 0 : sections.archived.length };
}

/**
 * Puts `content` into the host's scroll box, keeping the box and both scroll positions across redraws: a live update
 * (a status, a member, a cluster) must not jump a scrolled matrix back to its corner. The box is made by `makeBox`
 * only when the host does not hold one yet (first draw, or after the list or an empty state was shown). A shorter
 * table is clamped by the browser.
 */
export function mountKeepingScroll(host, makeBox, content) {
  const old = host.childElementCount === 1 ? host.firstElementChild : null;
  const box = old?.classList?.contains('matrix-scroll') ? old : makeBox();
  if (box !== old) host.replaceChildren(box);
  const { scrollLeft, scrollTop } = box;
  box.replaceChildren(content);
  box.scrollLeft = scrollLeft;
  box.scrollTop = scrollTop;
  return box;
}

/** localStorage key of the 全部对话 view: 'list' (default) or 'matrix'. */
export const CONVERSATIONS_VIEW_KEY = 'orrery.conversationsView';
/** The stored view; anything else is the list. */
export const viewFromStored = (value) => value === 'matrix' ? 'matrix' : 'list';
/** Short words for a cell's status, so it never rests on colour alone. */
export const STATUS_WORD = { busy: '忙', idle: '在线', offline: '离线' };
