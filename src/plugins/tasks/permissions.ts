// Cluster-wide role gates. Task-specific role checks remain in the lifecycle and still require every listed role.
import type { TaskPermissions } from '../../core/collaboration-types.ts';
import type { PluginActionContext } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import { fail, memberName, missingRoleNames } from './model.ts';

const roleLists = ['createRoleIds', 'executeRoleIds', 'reviewRoleIds'] as const;
type RoleList = typeof roleLists[number];
const settingName: Record<RoleList, string> = {
  createRoleIds: 'create tasks', executeRoleIds: 'execute tasks', reviewRoleIds: 'review tasks',
};

export function taskPermissions(store: Store, clusterId: string): TaskPermissions {
  const row = store.db.prepare('SELECT data_json FROM task_cluster_permissions WHERE cluster_id = ?').get(clusterId);
  return row ? JSON.parse(String(row.data_json)) as TaskPermissions
    : { createRoleIds: [], executeRoleIds: [], reviewRoleIds: [] };
}

export function groupPermissionsUseRole(store: Store, clusterId: string, roleId: string): boolean {
  const permissions = taskPermissions(store, clusterId);
  return roleLists.some((field) => permissions[field].includes(roleId));
}

/** Any one role satisfies a cluster gate. An empty list allows everyone. */
export function allowsTaskRoles(store: Store, clusterId: string, memberId: string, roleIds: readonly string[]): boolean {
  if (!roleIds.length) return true;
  const held = store.collaborationMemberRoles(clusterId).find((member) => member.memberId === memberId)?.roleIds ?? [];
  return roleIds.some((id) => held.includes(id));
}

export function requireTaskPermission(store: Store, clusterId: string, memberId: string, field: RoleList,
  permissions = taskPermissions(store, clusterId)): void {
  const roles = permissions[field];
  if (!allowsTaskRoles(store, clusterId, memberId, roles)) {
    const names = missingRoleNames(store, clusterId, memberId, roles).join(', ');
    fail('ROLE_REQUIRED', `${memberName(store, memberId)} cannot ${settingName[field]} under group task permissions (${field}); requires one of: ${names}`);
  }
}

export function setTaskPermissions(ctx: PluginActionContext): Record<string, unknown> {
  const { store, actor, clusterId, command, collaboration } = ctx;
  if (actor.kind !== 'user') return fail('FORBIDDEN', 'only the user can change group task permissions, on the page');
  const input = command.taskPermissions;
  if (!input || typeof input !== 'object' || roleLists.some((field) => !Array.isArray(input[field]))
    || Object.keys(input).some((field) => !roleLists.some((allowed) => allowed === field))) {
    return fail('INVALID_REQUEST', 'taskPermissions requires createRoleIds, executeRoleIds and reviewRoleIds');
  }
  const permissions: TaskPermissions = {
    createRoleIds: collaboration.roleIds(clusterId, input.createRoleIds, 'createRoleIds'),
    executeRoleIds: collaboration.roleIds(clusterId, input.executeRoleIds, 'executeRoleIds'),
    reviewRoleIds: collaboration.roleIds(clusterId, input.reviewRoleIds, 'reviewRoleIds'),
  };
  store.db.prepare(`INSERT INTO task_cluster_permissions (cluster_id, data_json) VALUES (?, ?)
    ON CONFLICT(cluster_id) DO UPDATE SET data_json = excluded.data_json`).run(clusterId, JSON.stringify(permissions));
  ctx.outcome.payload = () => ({ action: command.action, taskPermissions: permissions });
  ctx.outcome.afterEvent = (event) => ctx.notice(event, { systemKind: 'settings', recipients: [], retain: true,
    body: `用户更新了本群的「任务权限」，事件 ${event.seq}。` });
  return { taskPermissions: permissions };
}
