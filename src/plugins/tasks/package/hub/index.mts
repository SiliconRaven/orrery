// Tasks: the task lifecycle, ship, task notices and the idle reminders (docs/plugins.md, docs/collaboration.md).
import { moveAssignments, refuseRebinding, resolveTaskRefs, runTaskAction } from './actions.mts';
import { BATCH_ACTIONS, batchQuery, resolveBatchRefs, runBatchAction } from './batches.mts';
import { prepareShipFix, prepareSubmit } from './branch-link.mts';
import { taskEnvelope } from './envelope.mts';
import { taskEventSource } from './events.mts';
import { memberTasks } from './handover.mts';
import { heldBrief } from './hidden.mts';
import { setHost, type TasksHost } from './host.mts';
import { LABEL_ACTIONS, libraryView, runLabelAction, selectDefaultGroups } from './labels.mts';
import { allTasks, resolveTaskRef } from './model.mts';
import { groupPermissionsUseRole, setTaskPermissions } from './permissions.mts';
import { taskDetail, taskRefs, workspace } from './queries.mts';
import { shipRoute, taskRoutes } from './routes.mts';
import { TasksService } from './service.mts';
import {
  collaborationActiveTaskLoads, collaborationLinks, collaborationRecords, collaborationTask, linkCollaborationMessage, linkedClause, MIGRATIONS,
  purgeClusterTasks,
} from './store.mts';
import { taskTools } from './tools.mts';
import type { Hub, Store, Task } from './types.mts';
import { forgetMemberWatches } from './watches.mts';

const ACTIONS = ['task.create', 'task.edit', 'task.assign', 'task.nominate', 'task.claim', 'task.start', 'task.submit', 'task.review', 'task.approve',
  'task.merge', 'task.mark_completed', 'task.mark_merged', 'task.shipped', 'task.ship_failed', 'task.ship_fix', 'task.release', 'task.cancel', 'task.reopen', 'task.handoff', 'task.takeover', 'task.delete',
  'task.attention', 'task.resolve_attention', 'task.summary', 'task.set_git_branch', 'task.watch', 'task.unwatch', 'message.link'];

const entries = <T,>(value: T) => Object.fromEntries(ACTIONS.map((action) => [action, value]));
const labelActions = Object.fromEntries(LABEL_ACTIONS.map((action) => [action, runLabelAction]));
const batchEntries = <T,>(value: T) => Object.fromEntries(BATCH_ACTIONS.map((action) => [action, value]));

export default function createPlugin(h: TasksHost) {
  setHost(h);
  return {
    name: '任务系统',
    description: 'Beta 测试版。任务、依赖、验收和 ship 合并；关闭后群聊和投递照常，任务数据保留。',
    details: `在群里建任务、派给成员、跟踪依赖和进度、验收结果，并用 ship 合并验收通过的分支。

**提供**
- 网页上的“全部任务”和任务工作台，消息上的“关联任务”和 \`#\` 任务引用
- 成员可用的任务工具：建任务、提交、验收、提出和解决待办事项、管理标签
- 任务通知、空闲提示和成员无活动提醒

**关闭后**
群聊、投递、暂停和防循环照常；任务界面、任务工具和任务通知都不再出现。任务数据保留，重新启用后都在。

协调员插件依赖它：要先关闭协调员，才能关闭任务系统。`,
    migrations: MIGRATIONS,
    actions: { ...entries(runTaskAction), ...labelActions, 'tasks.permissions': setTaskPermissions,
      ...batchEntries(runBatchAction) },
    prepare: { 'task.submit': prepareSubmit, 'task.ship_fix': prepareShipFix },
    prepareRequired: ['task.ship_fix'],
    managementActions: ['task.create', 'task.edit', 'task.assign', 'task.nominate', 'task.merge', 'task.cancel', 'task.reopen', 'task.handoff', 'task.takeover',
      'task.attention', 'task.resolve_attention', 'task.summary', 'message.link', 'batch.create', 'batch.add', 'batch.remove', 'batch.cancel', 'batch.merge'],
    refs: { ...entries(resolveTaskRefs), ...batchEntries(resolveBatchRefs) },
    queries: { workspace, task: taskDetail, context: taskDetail, task_refs: taskRefs, batch: batchQuery,
      labels: ({ store, clusterId }: { store: Store; clusterId: string }) => libraryView(store, clusterId, true) as never },
    tools: taskTools,
    routes: taskRoutes,
    bridgeRoutes: [shipRoute],
    messageFields: { taskIds: collaborationLinks },
    envelope: taskEnvelope,
    service: (hub: Hub) => new TasksService(hub),
    memberRebinding: refuseRebinding,
    memberRebound: moveAssignments,
    memberRemoved: forgetMemberWatches,
    clusterCreated: selectDefaultGroups,
    clusterPurging: purgeClusterTasks,
    eventSource: taskEventSource,
    taskView: (store: Store) => ({
      all: (clusterId: string): Task[] => [...allTasks(store, clusterId)],
      groupPermissionsUseRole: (clusterId: string, roleId: string) => groupPermissionsUseRole(store, clusterId, roleId),
      task: (clusterId: string, taskId: string) => collaborationTask(store, clusterId, taskId),
      resolveRef: (clusterId: string, ref: string) => resolveTaskRef(store, clusterId, ref),
      unresolvedQuestions: (taskId: string) => collaborationRecords<{ question: string; resolvedAt: string | null }>(store, taskId, 'attention')
        .filter((attention) => !attention.resolvedAt).map((attention) => attention.question),
      memberTasks: (clusterId: string, memberId: string, limit: number) => memberTasks(store, clusterId, memberId, limit),
      activeLoads: (clusterId: string) => collaborationActiveTaskLoads(store, clusterId),
      links: (messageId: string) => collaborationLinks(store, messageId),
      linkMessage: (messageId: string, taskId: string, linkedBy: string) => linkCollaborationMessage(store, messageId, taskId, linkedBy),
      linkedClause,
      heldBrief: (clusterId: string, memberId: string, hiddenSince: string) => heldBrief(store, clusterId, memberId, hiddenSince),
    }),
  };
}
