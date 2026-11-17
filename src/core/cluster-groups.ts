// The sidebar's group list (docs/architecture.md「分组清单」): which groups exist and in what order, saved as one JSON
// array of names in the settings table (key CLUSTER_GROUPS_KEY). A cluster's group is still its own `category`; this
// list only adds the groups that hold no cluster and the order. Pure helpers: the Hub checks names and writes.

/** The settings row that holds the list. */
export const CLUSTER_GROUPS_KEY = 'cluster_groups';
/** At most this many groups. */
export const MAX_GROUPS = 200;

/** The saved row's value → names; a missing row is []. A value that is not a list of distinct non-empty strings is an error. */
export function parseGroups(raw: string | null): string[] {
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { /* reported below */ }
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' || !x) || new Set(value).size !== value.length) {
    throw new Error(`saved setting ${CLUSTER_GROUPS_KEY} is invalid: ${raw.slice(0, 200)}`);
  }
  return value as string[];
}

/**
 * The groups the sidebar shows, in order: the saved list, then group names that clusters use but the list lacks (from
 * before the list existed, or a restored cluster whose group was deleted meanwhile) in Chinese collation order.
 */
export function effectiveGroups(saved: readonly string[], inUse: Iterable<string>): string[] {
  const known = new Set(saved);
  const extra = [...new Set([...inUse].filter((name) => name && !known.has(name)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return [...saved, ...extra];
}

export function createGroup(list: readonly string[], name: string): string[] {
  if (list.includes(name)) throw new Error(`group ${JSON.stringify(name)} already exists`);
  if (list.length >= MAX_GROUPS) throw new Error(`at most ${MAX_GROUPS} groups`);
  return [...list, name];
}

/** Keeps the group's place. Renaming onto another existing group is refused: merging is a move, not a rename. */
export function renameGroup(list: readonly string[], from: string, to: string): string[] {
  if (!list.includes(from)) throw new Error(`unknown group ${JSON.stringify(from)}`);
  if (from !== to && list.includes(to)) throw new Error(`group ${JSON.stringify(to)} already exists`);
  return list.map((name) => name === from ? to : name);
}

export function deleteGroup(list: readonly string[], name: string): string[] {
  if (!list.includes(name)) throw new Error(`unknown group ${JSON.stringify(name)}`);
  return list.filter((x) => x !== name);
}

/** `order` must name exactly the groups in `list`, each once. */
export function reorderGroups(list: readonly string[], order: unknown): string[] {
  if (!Array.isArray(order) || order.length !== list.length || new Set(order).size !== order.length
    || order.some((x) => typeof x !== 'string' || !list.includes(x))) {
    throw new Error('groups must list every existing group exactly once');
  }
  return order as string[];
}
