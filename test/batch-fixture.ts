// A Hub with members a, b, c (executors) and r (reviewer) in cluster k, driven through collaboration commands; shared by
// the review batch tests (test/task-batches.test.ts, test/ship-batch.test.ts).
import type { TestContext } from 'node:test';
import type { CollaborationActor, CollaborationCommand, CollaborationResult, Task, TaskResult } from '../src/core/collaboration-types.ts';
import { Hub } from '../src/core/hub.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { Store } from '../src/core/store.ts';
import { officialPlugins } from '../src/plugins/index.ts';

export const user: CollaborationActor = { kind: 'user' };
const member = (memberId: string): CollaborationActor => ({ kind: 'member', memberId });
export const [a, b, c, r] = ['a', 'b', 'c', 'r'].map(member);

export function batchFixture(t: TestContext, cwd = '/tmp') {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  store.insertCluster({ id: 'k', name: 'k', category: '', createdAt: '2026-01-01' }, ['a', 'b', 'c', 'r'].map((id) => ({
    id, clusterId: 'k', name: `name-${id}`, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd, origin: 'attached' as const, removedAt: null,
  })));
  const hub = new Hub({ store, nativeAdapters: {} });
  t.after(async () => { await hub.close(); store.close(); });
  let serial = 0;
  const send = (actor: CollaborationActor, command: Omit<CollaborationCommand, 'operationId'>, operationId = 'op-' + ++serial) =>
    hub.collaboration.command(actor, 'k', { ...command, operationId }) as CollaborationResult & { batch?: { id: string; number: number } };
  const read = (id: string) => hub.collaboration.query(user, 'k', { kind: 'task', taskId: id }) as TaskResult & { batch?: any; dependencies: any[] };
  const act = (actor: CollaborationActor, task: Pick<Task, 'id'>, command: Partial<CollaborationCommand> & { action: CollaborationCommand['action'] }) =>
    send(actor, { taskId: task.id, expectedRevision: read(task.id).task.revision, ...command });
  const batch = (title = 'chain', reviewer: CollaborationActor = r, by: CollaborationActor = user) =>
    send(by, { action: 'batch.create', title, reviewer }).batch!;
  const create = (title: string, batchId: string | undefined, extra: Partial<CollaborationCommand> = {}, by: CollaborationActor = user) =>
    send(by, { action: 'task.create', title, scope: 's', acceptance: 'x', ...(batchId ? { batchId } : {}), ...extra }).task!;
  const start = (actor: CollaborationActor, task: Pick<Task, 'id'>) => act(actor, task, { action: 'task.start' }).assignment!.id;
  const submit = (actor: CollaborationActor, task: Pick<Task, 'id'>, commitSha: string, extra: Partial<CollaborationCommand> = {}) => {
    const now = read(task.id);
    return act(actor, task, { action: 'task.submit', assignmentId: now.task.currentAssignmentId!, summary: 'done', commitSha, ...extra });
  };
  /** Resubmit a completed result its dependencies voided: through the approved assignment, declaring the new versions. */
  const resubmitApproved = (actor: CollaborationActor, task: Pick<Task, 'id'>, commitSha: string) => {
    const now = read(task.id);
    const assignmentId = now.submissions.find((s) => s.id === now.task.approvedSubmissionId)!.assignmentId!;
    const versions = Object.fromEntries(now.dependencies.map((d: Task) => [d.id, d.latestSubmissionId!]));
    return act(actor, task, { action: 'task.submit', assignmentId, summary: 'rebuilt', commitSha, expectedDependencyVersions: versions });
  };
  const review = (actor: CollaborationActor, task: Pick<Task, 'id'>, verdict: 'approve' | 'reject' = 'approve') =>
    act(actor, task, { action: 'task.review', submissionId: read(task.id).task.latestSubmissionId!, verdict, reason: 'checked' });
  const messages = () => store.listMessages('k', 500);
  /** Who a message woke: the recipients that got a delivery. */
  const woke = (id: string) => store.withDeliveries([store.getMessage(id)!])[0].deliveries.map((d) => d.memberId).sort();
  const completeNotices = () => messages().filter((m) => m.kind === 'system' && /的任务都已提交/.test(m.body));
  const view = (id: string) => (hub.collaboration.query(user, 'k', { kind: 'batch', batchId: id } as never) as unknown as { batch: any }).batch;
  return { store, hub, send, read, act, batch, create, start, submit, resubmitApproved, review, messages, woke, completeNotices, view };
}

/** A chain one → two → three in one batch reviewed by r: a executes one, b two, c three. */
export function chain(t: TestContext, cwd?: string) {
  const f = batchFixture(t, cwd);
  const batch = f.batch();
  const one = f.create('one', batch.id, { memberId: 'a' });
  const two = f.create('two', batch.id, { memberId: 'b', dependencyIds: [one.id] });
  const three = f.create('three', batch.id, { memberId: 'c', dependencyIds: [two.id] });
  return { ...f, batchId: batch.id, one, two, three };
}
