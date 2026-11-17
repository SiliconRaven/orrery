import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';

/** Shared defaults for a new cluster and the user's explicit repair command. */
export const DEFAULT_ROLES = [
  { name: '设计者', description: '根据需求写清完整设计和实施计划并创建任务，记录发起人、设计者、建单人、来源、依赖、验收标准和验证方法；可以兼任执行者。' },
  { name: '验收者', description: '按验收条件检查结果，通过或退回并说明理由；不验收自己执行的任务。' },
  { name: '执行者', description: '按设计实施分配到的任务并自测，提交结果和验证证据。' },
] as const;

/** Call within the surrounding transaction; existing nonempty descriptions and all other roles are kept. */
export function ensureDefaultRoles(store: Store, clusterId: string): void {
  const byName = new Map(store.collaborationRoles(clusterId).map((role) => [role.name, role]));
  for (const role of DEFAULT_ROLES) {
    const existing = byName.get(role.name);
    if (!existing) store.saveCollaborationRole({ id: randomUUID(), clusterId, ...role });
    else if (!existing.description.trim()) store.setCollaborationRoleDescription(existing.id, role.description);
  }
}
