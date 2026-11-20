import { compareVersions } from './update-check.ts';

export interface OfficialChoice {
  id: string;
  version: string;
  requires: readonly { id: string; minVersion: string; beforeVersion?: string }[];
}

export interface OfficialVariants<T extends OfficialChoice> {
  id: string;
  enabled: boolean;
  original?: T;
  active?: T;
  previous?: T;
  bundled?: T;
}

/**
 * Selects one eligible package per ID in registry order. The caller verifies each package, host compatibility and the
 * current database migration floor before supplying candidates. No files are imported or modified during selection.
 */
export function selectOfficialVersions<T extends OfficialChoice>(variants: readonly OfficialVariants<T>[], pending?: T): T[] | null {
  const positions = new Map(variants.map(({ id }, index) => [id, index]));
  const fits = (choice: T, index: number, group: readonly T[]) =>
    choice.id === variants[index].id && choice.requires.every(({ id, minVersion, beforeVersion }) => {
      const earlier = positions.get(id);
      if (earlier === undefined || earlier >= index) return false;
      if (variants[index].enabled && !variants[earlier].enabled) return false;
      const version = group[earlier].version;
      return compareVersions(version, minVersion) >= 0 && (beforeVersion === undefined || compareVersions(version, beforeVersion) < 0);
    });
  const isCompatible = (group: readonly T[]) => group.length === variants.length && group.every((choice, index) => fits(choice, index, group));

  function firstCompatibleGroup(required?: T): T[] | null {
    const group: T[] = [];
    function choose(index: number): boolean {
      if (index === variants.length) return true;
      const { id, active, previous, bundled } = variants[index];
      const choices = required?.id === id ? [required] : new Set([active, previous, bundled]);
      // Each dependency has an earlier slot, so an incompatible prefix can never form a compatible group.
      for (const choice of choices) {
        if (!choice || !fits(choice, index, group)) continue;
        group.push(choice);
        if (choose(index + 1)) return true;
        group.pop();
      }
      return false;
    }
    return choose(0) ? group : null;
  }

  const originals = variants.flatMap(({ original }) => original ? [original] : []);
  let group = isCompatible(originals) ? originals : firstCompatibleGroup();
  let activatedPending: number | undefined;
  const pendingIndex = pending && positions.get(pending.id);
  if (pending && pendingIndex !== undefined) {
    if (!group) {
      group = firstCompatibleGroup(pending);
      if (group) activatedPending = pendingIndex;
    } else if (compareVersions(pending.version, group[pendingIndex].version) > 0) {
      const proposed = group.with(pendingIndex, pending);
      if (isCompatible(proposed)) {
        group = proposed;
        activatedPending = pendingIndex;
      }
    }
  }
  if (!group) return null;

  for (let index = 0; index < variants.length; index++) {
    const { bundled } = variants[index];
    if (index === activatedPending || !bundled || compareVersions(bundled.version, group[index].version) <= 0) continue;
    const proposed = group.with(index, bundled);
    if (isCompatible(proposed)) group = proposed;
  }
  return group;
}
