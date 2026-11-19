// Tasks: the task lifecycle, ship, task notices and the idle reminders (docs/plugins.md, docs/collaboration.md).
import type { CollaborationCommand, Task } from '../../core/collaboration-types.ts';
import type { OfficialPlugin, PluginRefContext } from '../../core/plugin.ts';
import type { Store } from '../../core/store.ts';
import { moveAssignments, refuseRebinding, resolveTaskRefs, runTaskAction } from './actions.ts';
import { BATCH_ACTIONS, batchQuery, resolveBatchRefs, runBatchAction } from './batches.ts';
import { prepareSubmit } from './branch-link.ts';
import { taskEnvelope } from './envelope.ts';
import { taskEventSource } from './events.ts';
import { memberTasks } from './handover.ts';
import { heldBrief } from './hidden.ts';
import { LABEL_ACTIONS, libraryView, runLabelAction, selectDefaultGroups } from './labels.ts';
import { allTasks, resolveTaskRef } from './model.ts';
import { taskDetail, taskRefs, workspace } from './queries.ts';
import { shipRoute, taskRoutes } from './routes.ts';
import { TasksService } from './service.ts';
import {
  collaborationActiveTaskLoads, collaborationLinks, collaborationRecords, collaborationTask, linkCollaborationMessage, linkedClause, MIGRATIONS,
  purgeClusterTasks,
} from './store.ts';
import { runSettingsAction } from './takeover.ts';
import { taskTools } from './tools.ts';
import { forgetMemberWatches } from './watches.ts';

const ACTIONS = ['task.create', 'task.edit', 'task.assign', 'task.nominate', 'task.claim', 'task.start', 'task.submit', 'task.review', 'task.approve',
  'task.merge', 'task.mark_completed', 'task.mark_merged', 'task.shipped', 'task.ship_failed', 'task.release', 'task.cancel', 'task.reopen', 'task.handoff', 'task.takeover', 'task.delete',
  'task.attention', 'task.resolve_attention', 'task.summary', 'task.set_git_branch', 'task.watch', 'task.unwatch', 'message.link'];

const entries = <T>(value: T) => Object.fromEntries(ACTIONS.map((action) => [action, value]));
const labelActions = Object.fromEntries(LABEL_ACTIONS.map((action) => [action, runLabelAction]));
const batchEntries = <T>(value: T) => Object.fromEntries(BATCH_ACTIONS.map((action) => [action, value]));

export const tasks: OfficialPlugin = {
  id: 'tasks',
  version: '0.10.0-beta.2',
  name: '任务系统',
  description: 'Beta 测试版。任务、依赖、验收和 ship 合并；关闭后群聊和投递照常，任务数据保留。',
  icon: 'tasks.svg',
  details: `在群里建任务、派给成员、跟踪依赖和进度、验收结果，并用 ship 合并验收通过的分支。

**提供**
- 网页上的“全部任务”和任务工作台，消息上的“关联任务”和 \`#\` 任务引用
- 成员可用的任务工具：建任务、提交、验收、提出和解决待办事项、管理标签
- 任务通知、空闲提示和成员无活动提醒

**关闭后**
群聊、投递、暂停和防循环照常；任务界面、任务工具和任务通知都不再出现。任务数据保留，重新启用后都在。

协调员插件依赖它：要先关闭协调员，才能关闭任务系统。`,
  migrations: MIGRATIONS,
  actions: { ...entries(runTaskAction), ...labelActions, 'tasks.settings': runSettingsAction, ...batchEntries(runBatchAction) },
  prepare: { 'task.submit': prepareSubmit },
  managementActions: ['task.create', 'task.edit', 'task.assign', 'task.nominate', 'task.merge', 'task.cancel', 'task.reopen', 'task.handoff', 'task.takeover',
    'task.attention', 'task.resolve_attention', 'task.summary', 'message.link', 'batch.create', 'batch.add', 'batch.remove', 'batch.cancel', 'batch.merge'],
  refs: { ...entries<(ctx: PluginRefContext) => CollaborationCommand>(resolveTaskRefs), ...batchEntries(resolveBatchRefs) },
  queries: { workspace, task: taskDetail, context: taskDetail, task_refs: taskRefs, batch: batchQuery,
    labels: ({ store, clusterId }) => libraryView(store, clusterId, true) as never },
  tools: taskTools,
  routes: taskRoutes,
  bridgeRoutes: [shipRoute],
  messageFields: { taskIds: collaborationLinks },
  envelope: taskEnvelope,
  service: (hub) => new TasksService(hub),
  memberRebinding: refuseRebinding,
  memberRebound: moveAssignments,
  memberRemoved: forgetMemberWatches,
  clusterCreated: selectDefaultGroups,
  clusterPurging: purgeClusterTasks,
  eventSource: taskEventSource,
  taskView: (store: Store) => ({
    all: (clusterId): Task[] => [...allTasks(store, clusterId)],
    task: (clusterId, taskId) => collaborationTask(store, clusterId, taskId),
    resolveRef: (clusterId, ref) => resolveTaskRef(store, clusterId, ref),
    unresolvedQuestions: (taskId) => collaborationRecords<{ question: string; resolvedAt: string | null }>(store, taskId, 'attention')
      .filter((attention) => !attention.resolvedAt).map((attention) => attention.question),
    memberTasks: (clusterId, memberId, limit) => memberTasks(store, clusterId, memberId, limit),
    activeLoads: (clusterId) => collaborationActiveTaskLoads(store, clusterId),
    links: (messageId) => collaborationLinks(store, messageId),
    linkMessage: (messageId, taskId, linkedBy) => linkCollaborationMessage(store, messageId, taskId, linkedBy),
    linkedClause,
    heldBrief: (clusterId, memberId, hiddenSince) => heldBrief(store, clusterId, memberId, hiddenSince),
  }),
};
