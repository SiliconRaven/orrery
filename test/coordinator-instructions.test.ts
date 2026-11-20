import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hub } from '../src/core/hub.ts';
import { Store } from '../src/core/store.ts';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { startTestHub, tempDir, waitFor } from './helpers.ts';
import { COORDINATOR_RULES } from '../src/plugins/coordinator/coordinator-rules.ts';
import { collaborationLinks } from '../src/plugins/tasks/store.ts';
import { PluginHost } from '../src/core/plugin.ts';
import { officialPlugins } from '../src/plugins/index.ts';

type Actor = { kind: 'user' } | { kind: 'member'; memberId: string };

function fixture() {
  const store = new Store(':memory:', new PluginHost(officialPlugins));
  const member = (id: string) => ({ id, clusterId: 'c', name: id, avatar: null, harness: 'mock', model: null, effort: null,
    workerSessionId: 'session-' + id, cwd: '/tmp', origin: 'attached' as const, removedAt: null });
  store.insertCluster({ id: 'c', name: 'c', category: '', createdAt: '2026-01-01' }, [member('a'), member('b')]);
  const hub = new Hub({ store, nativeAdapters: {} });
  let serial = 0;
  const send = (actor: Actor, command: Record<string, unknown>) =>
    hub.collaboration.command(actor as never, 'c', { operationId: `instr-${++serial}`, ...command } as never) as any;
  const user: Actor = { kind: 'user' };
  const as = (id: string): Actor => ({ kind: 'member', memberId: id });
  return { store, hub, send, user, as };
}

test('coordinator rules v18 follow the ship flow and builder dispatch, and cover ship failure recovery, batched review and reject-takeover', () => {
  assert.equal(COORDINATOR_RULES.version, 'v18');
  assert.match(COORDINATOR_RULES.text, /ship 失败时保持已完成状态并只记未读（infoOnly）.*task_action ship_fix.*manage_batch attribute_failure/);
  assert.match(COORDINATOR_RULES.text, /验收批次（manage_batch）.*批次齐了才唤醒一次.*各自给结论.*批次 ship 一次合并.*上游提交后就能开工.*manage_batch add.*verdict: "reject", takeover: true/);
  assert.match(COORDINATOR_RULES.text, /落到隐身成员身上.*第 9 条的例外.*改派给其他有资格的成员.*取消隐身.*告诉用户.*Hub 不会自动改派/);
  assert.match(COORDINATOR_RULES.text, /建任务的人自己派工和选验收者：自己有执行资格就自己优先做/);
  assert.match(COORDINATOR_RULES.text, /协调员只在用户指定、有成员闲着且有工作等分配、成员出错或离线、流程卡住且成员和程序处理不了时才做事/);
  assert.match(COORDINATOR_RULES.text, /没有点名任何人的用户消息主动投给协调员/);
  assert.match(COORDINATOR_RULES.text, /成员没有 @ 任何人的发言（普通群聊、任务留言）只留在群聊记录里/);
  assert.match(COORDINATOR_RULES.text, /正常任务生命周期（验收通过、自查完成、合并）不通知协调员/);
  assert.match(COORDINATOR_RULES.text, /执行者在忙、验收人在忙都不算卡住/);
  assert.match(COORDINATOR_RULES.text, /成员手上有已分配且可以开工、已开工或待验收的任务却长时间没有活动时也会通知/);
  assert.match(COORDINATOR_RULES.text, /先问对方，或查看分支和投递情况，确认没在干活再重新安排/);
  assert.match(COORDINATOR_RULES.text, /派工时消息只写任务编号和变化点（谁执行、谁验收、合并顺序）；任务内容由执行者用 `get_task` 读取，不在消息里复述/);
  assert.match(COORDINATOR_RULES.text, /建单时如果已经知道合适的执行者，直接写上执行者.*和验收人，不需要等协调员同意/);
  assert.match(COORDINATOR_RULES.text, /先在群里确认对方已停手，或者对方已离线、已被移除/);
  assert.doesNotMatch(COORDINATOR_RULES.text, /merge\.claim|合并窗口/);
  assert.match(COORDINATOR_RULES.text, /运行 ship.*`task_action merge` 补记合并提交/);
  assert.match(COORDINATOR_RULES.text, /下游在前置 merged 后才就绪/);
  assert.match(COORDINATOR_RULES.text, /建单时打开 `requiresApproval`；用户批准前不分配、不开工/);
  assert.match(COORDINATOR_RULES.text, /收到消息只用确认（ack/);
  assert.match(COORDINATOR_RULES.text, /执行者和复查者都只跑相关测试，不跑全量；全量只在 premerge 跑 1 遍/);
  assert.match(COORDINATOR_RULES.text, /只改文档的不跑全量/);
  assert.match(COORDINATOR_RULES.text, /每完成一次提交、或开始跑全量测试之前，调用一次默认 read_messages/);
  assert.match(COORDINATOR_RULES.text, /验收分三档.*独立验收.*自查档（reviewer 为 self）.*用户验收/);
  assert.match(COORDINATOR_RULES.text, /建单时由协调员定档，用户随时可以改.*拿不准按独立验收.*设计任务默认自查.*架构级设计才用独立验收/);
  assert.match(COORDINATOR_RULES.text, /一次看完待验收的几个任务.*每个任务各自给结论、各自 ship.*高风险的.*单独审/);
});

test('standing instructions: users and execute-mode coordinators manage them; others are refused', () => {
  const { store, hub, send, user, as } = fixture();
  try {
    send(user, { action: 'coordinator.set', memberId: 'a', enabled: true, mode: 'execute' });
    let policy = (hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator;
    assert.deepEqual(policy.standingInstructions, [], 'old/missing data reads as an empty list');
    const added = send(user, { action: 'coordinator.instruction.add', instructionText: '验收统一给 kimi' });
    policy = (hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator;
    assert.equal(policy.standingInstructions.length, 1);
    const id = policy.standingInstructions[0].id;
    assert.equal(policy.standingInstructions[0].text, '验收统一给 kimi');
    assert.equal(added.coordinator.standingInstructions.length, 1);
    // The execute-mode coordinator may add with the current generation (knowledgeCommunication is on by default).
    const generation = policy.generation;
    const byCoordinator = send(as('a'), { action: 'coordinator.instruction.add', instructionText: '成员待命时先问协调员', generation });
    assert.equal(byCoordinator.suggestion, undefined);
    assert.equal(byCoordinator.coordinator.standingInstructions.length, 2);
    // Edit and remove keep the same ids.
    send(user, { action: 'coordinator.instruction.edit', instructionId: id, instructionText: '验收统一给 kimi（含任务 E）' });
    policy = (hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator;
    assert.equal(policy.standingInstructions.find((item: any) => item.id === id).text, '验收统一给 kimi（含任务 E）');
    send(user, { action: 'coordinator.instruction.remove', instructionId: id });
    policy = (hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator;
    assert.equal(policy.standingInstructions.length, 1);
    // Ordinary members and suggest mode cannot change them.
    assert.throws(() => send(as('b'), { action: 'coordinator.instruction.add', instructionText: 'by member' }),
      (error: any) => error.code === 'FORBIDDEN');
    send(user, { action: 'coordinator.set', memberId: 'a', enabled: true, mode: 'suggest' });
    const policyNow = (hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator;
    const suggestion = send(as('a'), { action: 'coordinator.instruction.add', instructionText: 'suggested', generation: policyNow.generation });
    assert.ok(suggestion.suggestion, 'suggest mode returns a suggestion instead of writing');
    assert.equal((hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator.standingInstructions.length, 1);
    // Length and count limits.
    assert.throws(() => send(user, { action: 'coordinator.instruction.add', instructionText: 'x'.repeat(501) }),
      (error: any) => error.code === 'INVALID_REQUEST' && /500/.test(error.message));
    send(user, { action: 'coordinator.set', memberId: 'a', enabled: true, mode: 'execute' });
    const before = (hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator.standingInstructions.length;
    for (let i = before; i < 50; i++) send(user, { action: 'coordinator.instruction.add', instructionText: `rule ${i}` });
    assert.equal((hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator.standingInstructions.length, 50);
    assert.throws(() => send(user, { action: 'coordinator.instruction.add', instructionText: 'one too many' }),
      (error: any) => error.code === 'INVALID_REQUEST' && /at most 50/.test(error.message));
  } finally { store.close(); }
});

test('the coordinator envelope mentions the standing-instruction list', async () => {
  const dir = tempDir();
  const sessions = ['s1', 's2'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ harness: 'claude', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { claude: native } });
  try {
    const { cluster } = await app.hub.createCluster('instructions', [
      { harness: 'claude', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'claude', mode: 'native', sessionId: 's2', name: 'B' },
    ]);
    const [a] = app.hub.listMembers(cluster.id);
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { operationId: 'i1', action: 'coordinator.set',
      memberId: a.id, enabled: true, mode: 'execute' } as never);
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { operationId: 'i2', action: 'coordinator.instruction.add',
      instructionText: '成员待命时先问协调员' } as never);
    app.hub.sendFromUser(cluster.id, '@A hello');
    const envelope = await waitFor(() => native.delivered.find((item) => item.text.includes('@A hello')), 'coordinator envelope');
    assert.match(envelope.text, /用户长期要求见 list_tasks 的 coordinator\.standingInstructions（1 条）/);
  } finally { await app.close(); }
});

test('coordinator change hands over with a summary, notice and skipped unread', () => {
  const { store, hub, send, user, as } = fixture();
  try {
    send(user, { action: 'coordinator.set', memberId: 'a', enabled: true, mode: 'execute' });
    send(user, { action: 'coordinator.instruction.add', instructionText: '验收统一给 kimi' });
    const task = send(user, { action: 'task.create', title: '交接任务', scope: 's', acceptance: 'a', reviewer: as('a') }).task;
    send(user, { action: 'task.attention', taskId: task.id, expectedRevision: task.revision,
      kind: 'question', question: '需要用户决定', targetMemberId: 'b' });
    // Old coordinator's last speech and an unread message for the next coordinator.
    store.insertMessage({ id: randomUUID(), clusterId: 'c', from: 'a', mentions: [], body: '前任最后的话',
      replyTo: null, chainId: randomUUID(), hop: 0, createdAt: new Date(Date.now() - 1000).toISOString() }, []);
    hub.sendFromUser('c', '@B 接任前的未读');
    const oldGeneration = (hub.collaboration.query(user, 'c', { kind: 'workspace' }) as any).coordinator.generation;
    send(user, { action: 'coordinator.set', memberId: 'b', enabled: true, mode: 'execute' });
    const messages = store.listMessages('c', 100);
    const summary = messages.find((message) => message.from === 'system' && message.mentions.includes('b') && message.body.includes('新协调员'));
    assert.ok(summary, 'new coordinator gets a handover summary');
    assert.match(summary!.body, /验收统一给 kimi/);
    assert.match(summary!.body, /需要用户决定/);
    assert.match(summary!.body, /待开工：/);
    assert.match(summary!.body, /群暂停：否/);
    assert.match(summary!.body, /前任最后一条发言时间：/);
    assert.ok(collaborationLinks(store, summary!.id).length >= 1);
    const notice = messages.find((message) => message.from === 'system' && message.mentions.includes('a') && message.body.includes('卸任'));
    assert.ok(notice, 'old coordinator gets a notice');
    assert.match(notice!.body, new RegExp(`现任是 b，代次 ${oldGeneration + 1}`));
    // The new coordinator's default unread no longer includes pre-handover messages, but does include the summary.
    const unread = hub.readMessages('b').map((message) => message.body);
    assert.ok(!unread.some((body) => body.includes('接任前的未读')), 'pre-handover unread is skipped');
    assert.ok(unread.some((body) => body.includes('新协调员')), 'the summary itself is unread');
    // Messages sent after the handover must still be unread (the skip range ends at the handover moment).
    hub.sendFromUser('c', '@B 接任后的用户消息');
    const afterHandover = hub.readMessages('b').map((message) => message.body);
    assert.ok(afterHandover.some((body) => body.includes('接任后的用户消息')), 'post-handover messages are not skipped');
    // Old generation still gets STALE_POLICY, now naming the current generation.
    assert.throws(() => send(as('a'), { action: 'role.create', name: 'late', generation: oldGeneration }),
      (error: any) => error.code === 'STALE_POLICY' && new RegExp(`current generation ${oldGeneration + 1}`).test(error.message));
    // Changing only the mode does not produce another summary or notice (the normal coordinator.set notice is separate).
    const handoverCount = () => store.listMessages('c', 100).filter((message) => message.kind === 'system'
      && (message.body.includes('新协调员') || message.body.includes('卸任'))).length;
    const before = handoverCount();
    send(user, { action: 'coordinator.set', memberId: 'b', enabled: true, mode: 'suggest' });
    assert.equal(handoverCount(), before, 'mode-only change sends no handover messages');
  } finally { store.close(); }
});

test('a fixed clock at the handover millisecond still keeps its summary unread', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_760_000_000_000 });
  const { store, hub, send, user } = fixture();
  try {
    send(user, { action: 'coordinator.set', memberId: 'a', enabled: true, mode: 'execute' });
    const id = randomUUID();
    store.insertMessage({ id, clusterId: 'c', from: 'a', mentions: [], body: '接任前的未读', replyTo: null,
      chainId: id, hop: 0, createdAt: new Date().toISOString() }, ['b']);
    send(user, { action: 'coordinator.set', memberId: 'b', enabled: true, mode: 'execute' });
    const unread = hub.readMessages('b').map((message) => message.body);
    assert.ok(unread.some((body) => body.includes('新协调员')), 'the summary written in the same millisecond stays unread');
    assert.ok(!unread.some((body) => body.includes('接任前的未读')), 'the pre-handover unread is skipped');
  } finally {
    t.mock.timers.reset();
    store.close();
  }
});
