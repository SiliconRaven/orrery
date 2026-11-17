import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { coalesceNotices, type NoticeInput, type NoticeTask } from '../src/plugins/tasks/notice-coalesce.ts';
import type { HubEvent, Message } from '../src/core/types.ts';

function notice(id: string, seq: number, taskId: string, action: string,
  payload: Record<string, unknown> = {}, clusterId = 'cluster'): NoticeInput {
  const message: Message = { id, clusterId, from: 'system', kind: 'system', mentions: [], body: `原句 ${id}`,
    replyTo: null, chainId: id, hop: 0, createdAt: `2026-11-08T00:00:${String(seq % 60).padStart(2, '0')}.000Z`, collabEventId: seq };
  const event: HubEvent = { seq, clusterId, memberId: null, kind: 'collaboration', createdAt: message.createdAt,
    payload: { action, taskId, ...payload } };
  return { message, taskIds: [taskId], event };
}

function task(id: string, clusterId = 'cluster'): NoticeTask {
  return { id, clusterId, title: `任务 ${id}`, status: 'working',
    assignedMemberId: 'a', reviewer: { kind: 'member', memberId: 'reviewer' } };
}

test('groups interleaved task notices at first occurrence while retaining each original message and snapshot', () => {
  const a1 = notice('a1', 1, 'a', 'task.create');
  const b1 = notice('b1', 2, 'b', 'task.edit');
  const ordinary = notice('user', 3, 'a', 'task.edit'); ordinary.message.from = 'user';
  const a2 = notice('a2', 4, 'a', 'task.attention');
  const otherCluster = notice('c1', 5, 'a', 'task.edit', {}, 'other');
  const inputs = [a1, b1, ordinary, a2, otherCluster];
  const before = structuredClone(inputs);
  const snapshots = [task('a'), task('a', 'other')];
  const snapshotsBefore = structuredClone(snapshots);
  const result = coalesceNotices(inputs, snapshots);
  assert.deepEqual(result.map((section) => section.kind === 'task' ? `${section.clusterId}/${section.taskId}` : 'message'),
    ['cluster/a', 'cluster/b', 'message', 'other/a']);
  assert.equal(result[0].kind, 'task');
  if (result[0].kind !== 'task') throw new Error('expected task');
  assert.deepEqual(result[0].items.map((item) => [item.notice.message.id, item.notice.message.createdAt, item.notice.message.body]),
    [['a1', a1.message.createdAt, '原句 a1'], ['a2', a2.message.createdAt, '原句 a2']]);
  assert.deepEqual(result[0].task, snapshots[0]);
  assert.equal(result[1].kind === 'task' && result[1].task, null);
  assert.equal(result[3].kind === 'task' && result[3].task, snapshots[1]);
  assert.deepEqual(inputs, before);
  assert.deepEqual(snapshots, snapshotsBefore);
});

test('requires system identity and a matching collaboration event and task link, while allowing multiple links', () => {
  const multi = notice('multi', 1, 'a', 'task.edit'); multi.taskIds = ['unrelated', 'a'];
  const matching = notice('matching', 2, 'a', 'task.create');
  const wrongTask = notice('wrong-task', 3, 'a', 'task.edit'); wrongTask.taskIds = ['other', 'forged'];
  const noEvent = notice('no-event', 4, 'a', 'task.edit'); noEvent.event = null;
  const wrongSeq = notice('wrong-seq', 5, 'a', 'task.edit'); wrongSeq.message.collabEventId = 99;
  const wrongCluster = notice('wrong-cluster', 6, 'a', 'task.edit'); wrongCluster.event!.clusterId = 'other';
  const wrongKind = notice('wrong-kind', 7, 'a', 'task.edit'); wrongKind.event!.kind = 'delivery';
  const wrongSender = notice('wrong-sender', 8, 'a', 'task.edit'); wrongSender.message.from = 'member';
  const wrongMessageKind = notice('wrong-message-kind', 9, 'a', 'task.edit'); wrongMessageKind.message.kind = 'task_comment';
  const wrongAction = notice('wrong-action', 10, 'a', 'message.link');
  const badPayload = notice('bad-payload', 11, 'a', 'task.edit'); badPayload.event!.payload = ['task.edit'];
  const inputs = [multi, matching, wrongTask, noEvent, wrongSeq, wrongCluster, wrongKind, wrongSender,
    wrongMessageKind, wrongAction, badPayload];
  const result = coalesceNotices(inputs);
  assert.equal(result.length, 10);
  assert.equal(result[0].kind, 'task');
  assert.deepEqual(result[0].items.map((item) => item.notice.message.id), ['multi', 'matching']);
  assert.deepEqual(result.slice(1).map((section) => section.items[0].notice.message.id), inputs.slice(2).map((item) => item.message.id));
  assert.ok(result.slice(1).every((section) => section.kind === 'message'));
});

test('marks changed or cleared nominations only with a later real event for the same task', () => {
  const inputs = [
    notice('first-a', 1, 'a', 'task.nominate', { memberId: 'a' }),
    notice('other', 2, 'b', 'task.nominate', { memberId: 'b' }),
    notice('same-a', 3, 'a', 'task.nominate', { memberId: 'a' }),
    notice('suggestion', 4, 'a', 'task.nominate', { memberId: 'fake', suggested: true }),
    notice('attention', 5, 'a', 'task.attention'),
    notice('new-b', 6, 'a', 'task.nominate', { memberId: 'b' }),
    notice('clear', 7, 'a', 'task.nominate'),
  ];
  const result = coalesceNotices(inputs);
  assert.equal(result[0].kind, 'task');
  const byId = new Map(result[0].items.map((item) => [item.notice.message.id, item.supersededBy]));
  assert.deepEqual(byId.get('first-a'), { messageId: 'new-b', eventId: 6, reason: 'nomination_changed' });
  assert.deepEqual(byId.get('same-a'), { messageId: 'new-b', eventId: 6, reason: 'nomination_changed' });
  assert.deepEqual(byId.get('new-b'), { messageId: 'clear', eventId: 7, reason: 'nomination_changed' });
  assert.equal(byId.get('clear'), undefined);
  assert.equal(byId.get('attention'), undefined);
  assert.equal(byId.get('suggestion'), undefined);
  assert.equal(result[1].items[0].supersededBy, undefined);
});

test('marks proven status changes without treating creation, edits, attention or unknown review outcomes as obsolete', () => {
  const inputs = [
    notice('create', 1, 'a', 'task.create'), notice('claim', 2, 'a', 'task.claim'),
    notice('attention', 3, 'a', 'task.attention'), notice('start', 4, 'a', 'task.start'),
    notice('edit', 5, 'a', 'task.edit'), notice('submit', 6, 'a', 'task.submit'),
    notice('unclear', 7, 'a', 'task.review'), notice('reject', 8, 'a', 'task.review', { verdict: 'reject' }),
    notice('resubmit', 9, 'a', 'task.submit'), notice('approve', 10, 'a', 'task.review', { verdict: 'approve' }),
    notice('merge', 11, 'a', 'task.merge'), notice('reopen', 12, 'a', 'task.reopen'),
  ];
  const result = coalesceNotices(inputs);
  const byId = new Map(result[0].items.map((item) => [item.notice.message.id, item.supersededBy]));
  for (const [from, to, eventId] of [['claim', 'start', 4], ['start', 'submit', 6], ['submit', 'reject', 8],
    ['reject', 'resubmit', 9], ['resubmit', 'approve', 10], ['approve', 'merge', 11], ['merge', 'reopen', 12]] as const) {
    assert.deepEqual(byId.get(from), { messageId: to, eventId, reason: 'status_changed' });
  }
  for (const id of ['create', 'attention', 'edit', 'unclear', 'reopen']) assert.equal(byId.get(id), undefined);
});

test('uses event sequence as proof without changing delivery order or treating equal sequences as later', () => {
  const later = notice('later', 10, 'a', 'task.nominate', { memberId: 'b' });
  const earlier = notice('earlier', 5, 'a', 'task.nominate', { memberId: 'a' });
  const duplicate = notice('duplicate', 10, 'a', 'task.nominate', { memberId: 'c' });
  const result = coalesceNotices([later, earlier]);
  assert.deepEqual(result[0].items.map((item) => item.notice.message.id), ['later', 'earlier']);
  assert.equal(result[0].items[0].supersededBy, undefined);
  assert.deepEqual(result[0].items[1].supersededBy, { messageId: 'later', eventId: 10, reason: 'nomination_changed' });
  const ambiguous = coalesceNotices([earlier, later, duplicate]);
  assert.ok(ambiguous[0].items.every((item) => !item.supersededBy));
});

test('retains all IDs and ordering for a long batch without mutating frozen input', () => {
  const inputs = Array.from({ length: 20000 }, (_, index) => {
    const item = notice(`m${index}`, index + 1, `task${index % 10}`, 'task.nominate', { memberId: index % 20 ? 'a' : 'b' });
    Object.freeze(item.message); Object.freeze(item.taskIds); Object.freeze(item.event!.payload); Object.freeze(item.event); return Object.freeze(item);
  });
  Object.freeze(inputs);
  const result = coalesceNotices(inputs);
  assert.equal(result.length, 10);
  const ids = result.flatMap((section) => section.items.map((item) => item.notice.message.id));
  assert.equal(ids.length, inputs.length);
  assert.equal(new Set(ids).size, inputs.length);
  assert.deepEqual(result[0].items.slice(0, 3).map((item) => item.notice.message.id), ['m0', 'm10', 'm20']);
});

test('a reviewer takeover changes the executor of a pending task, or the status of a started one', () => {
  const pending = coalesceNotices([notice('assign', 1, 'a', 'task.assign', { memberId: 'b' }),
    notice('takeover', 2, 'a', 'task.takeover', { takeover: { previousStatus: 'pending', toMemberId: 'c' } })]);
  assert.deepEqual(pending[0].kind === 'task' && pending[0].items[0].supersededBy, { messageId: 'takeover', eventId: 2, reason: 'nomination_changed' });
  const started = coalesceNotices([notice('submit', 1, 'a', 'task.submit'),
    notice('takeover', 2, 'a', 'task.takeover', { takeover: { previousStatus: 'review', toMemberId: 'c' } })]);
  assert.equal(started[0].kind === 'task' && started[0].items[0].supersededBy?.messageId, 'takeover');
});
