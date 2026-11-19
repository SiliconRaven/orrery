// Hidden members (docs/cluster-members.md「隐身」): no delivery of any kind, invisible to the other members, every tool
// refuses, only the user and an entitled coordinator switch it, tasks cannot be given to it, rebind keeps and removal clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { HIDDEN_TOOL_TEXT } from '../src/core/collaboration.ts';
import { HIDDEN_DELIVERY_REASON } from '../src/core/hub.ts';
import { saveCoordinator, coordinatorSnapshot } from '../src/plugins/coordinator/store.ts';
import { idleTaskCandidates } from '../src/plugins/tasks/idle-candidates.ts';
import type { Task } from '../src/core/collaboration-types.ts';
import { freePort, startTestHub, tempDir, waitFor } from './helpers.ts';

type App = Awaited<ReturnType<typeof startTestHub>>;
type Schema = { type?: string; enum?: unknown[]; items?: Schema; minItems?: number; properties?: Record<string, Schema>; required?: string[]; anyOf?: Schema[] };

async function rpc(app: App, session: string, method: string, params: Record<string, unknown>) {
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8'));
  const res = await fetch(`${app.url}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret,
      'x-orrery-session': session, 'x-orrery-harness': 'mock' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await res.json()) as { result: any };
}

async function call(app: App, session: string, name: string, args: Record<string, unknown> = {}) {
  const { result } = await rpc(app, session, 'tools/call', { name, arguments: args });
  const text = result.content[0].text as string;
  return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
}

/** Arguments that pass a tool's input schema, so the call reaches the handler (and its identity check). */
function argsFor(schema: Schema): unknown {
  if (schema.anyOf) return argsFor(schema.anyOf[0]);
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'string') return 'x';
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => argsFor(schema.items ?? { type: 'string' }));
  return Object.fromEntries((schema.required ?? []).map((key) => [key, argsFor(schema.properties![key])]));
}

async function fixture(options: Parameters<typeof startTestHub>[0] = {}) {
  const dir = tempDir();
  const delivered: { sessionId: string; text: string }[] = [];
  const native = createMockNativeAdapter({
    sessions: ['sa', 'sb', 'sc', 's9', 'sx'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null })),
    onDeliver: async (sessionId, text) => { delivered.push({ sessionId, text }); return 'completed'; },
  });
  native.isOnline = () => true;
  const app = await startTestHub({ dir, port: await freePort(), nativeAdapters: { mock: native }, ...options });
  const { cluster, members: [alice, hidey, cleo] } = await app.hub.createCluster('hide', [
    { harness: 'mock', mode: 'native', sessionId: 'sa', name: 'Alice' },
    { harness: 'mock', mode: 'native', sessionId: 'sb', name: 'Hidey' },
    { harness: 'mock', mode: 'native', sessionId: 'sc', name: 'Cleo' },
  ]);
  /** Cleo becomes the enabled coordinator, with or without deliveryControl. */
  const coordinate = (deliveryControl = true, others = true) => {
    const generation = coordinatorSnapshot(app.store, cluster.id).generation + 1;
    saveCoordinator(app.store, cluster.id, { memberId: cleo.id, enabled: true, mode: 'execute', generation,
      permissions: { taskPlanning: others, assignment: others, roleManagement: others, reviewerManagement: others,
        knowledgeCommunication: others, recovery: others, cancelReopen: others, deliveryControl } }, generation);
    return generation;
  };
  const deliveriesOf = (messageId: string) => app.store.withDeliveries([app.store.getMessage(messageId)!])[0].deliveries;
  const count = (sql: string) => (app.store.db.prepare(sql).get() as { n: number }).n;
  return { app, cluster, alice, hidey, cleo, coordinate, deliveriesOf, delivered, count };
}

test('a hidden member gets no delivery of any kind, its queued ones are superseded, and unread restarts when shown', async () => {
  const { app, cluster, alice, hidey, deliveriesOf, delivered, count } = await fixture();
  try {
    app.hub.setPaused(true);
    const before = app.hub.sendFromUser(cluster.id, '@Hidey queued before hiding');
    assert.equal(deliveriesOf(before.id)[0].state, 'queued');
    const shown = app.hub.setMemberHidden(hidey.id, true);
    assert.ok(shown.hiddenAt);
    assert.deepEqual(deliveriesOf(before.id).map((d) => [d.state, d.error]), [['superseded', HIDDEN_DELIVERY_REASON]], 'queued one cancelled, reason kept');
    assert.ok(app.events.some((e) => e.kind === 'member' && (e.payload as { hidden?: boolean }).hidden === true), 'a page event records it');

    const mention = app.hub.sendFromUser(cluster.id, '@Hidey are you there');
    assert.deepEqual(mention.mentions, [hidey.id], 'the user’s @ stays in the record');
    const all = app.hub.sendFromUser(cluster.id, '@all everyone');
    assert.ok(!all.mentions.includes(hidey.id), '@all does not include a hidden member');
    const direct = app.hub.sendFromUser(cluster.id, 'direct', [hidey.id]);
    const fromMember = app.hub.sendFromMember(alice.id, '@Hidey hi');
    assert.deepEqual([fromMember.deliveredTo, fromMember.unresolvedMentions], [[], ['Hidey']]);
    app.hub.postNotice(cluster.id, hidey.id, 'a Hub notice', [], () => {}, 'idle');
    app.hub.writeSystemMessage(cluster.id, [hidey.id], 'a task notice', [], 0, 'task')();
    for (const m of [mention, all, direct]) assert.ok(!deliveriesOf(m.id).some((d) => d.memberId === hidey.id));
    assert.equal(count(`SELECT COUNT(*) AS n FROM deliveries WHERE member_id = '${hidey.id}' AND state != 'superseded'`), 0, 'no delivery of any kind');
    assert.equal(app.store.unreadBreakdown(hidey.id, cluster.id).total, 0, 'nothing counts unread while hidden');
    assert.equal(app.hub.unreadHintFor('mock', 'sb'), '', 'no unread hint goes into its conversation');

    const messagesBefore = count('SELECT COUNT(*) AS n FROM messages');
    app.hub.setMemberHidden(hidey.id, false);
    assert.equal(count('SELECT COUNT(*) AS n FROM messages'), messagesBefore, 'no chat message says it was shown');
    assert.equal(app.store.unreadBreakdown(hidey.id, cluster.id).total, 0, 'what came while hidden is not unread after showing');
    const after = app.hub.sendFromUser(cluster.id, '@Hidey welcome back');
    assert.deepEqual(deliveriesOf(after.id).map((d) => [d.memberId, d.state]), [[hidey.id, 'queued']]);
    app.hub.setPaused(false);
    await waitFor(() => delivered.some((d) => d.sessionId === 'sb'), 'delivery after showing');
    assert.ok(delivered.filter((d) => d.sessionId === 'sb').every((d) => d.text.includes('welcome back') && !d.text.includes('are you there')));
  } finally { await app.close(); }
});

test('other members neither see nor learn of a hidden member; the user and the coordinator see it marked', async () => {
  const { app, cluster, alice, hidey, cleo, coordinate, delivered } = await fixture();
  try {
    const early = await call(app, 'sa', 'send_message', { body: '@Hidey early' });
    assert.deepEqual(early.data.deliveredTo, ['Hidey']);
    await waitFor(() => delivered.some((d) => d.sessionId === 'sb'), 'early delivery');
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'role.create', operationId: 'r', name: 'dev' });
    const role = app.store.collaborationRoles(cluster.id).find((r) => r.name === 'dev')!;
    app.hub.collaboration.command({ kind: 'user' }, cluster.id, { action: 'member.roles', operationId: 'mr', memberId: hidey.id, roleIds: [role.id] });
    app.hub.setMemberHidden(hidey.id, true);

    const agents = await call(app, 'sa', 'list_agents');
    assert.deepEqual(agents.data.map((m: { name: string }) => m.name), ['Alice', 'Cleo']);
    const sent = await call(app, 'sa', 'send_message', { body: '@Hidey are you there' });
    assert.deepEqual([sent.data.deliveredTo, sent.data.unresolvedMentions], [[], ['Hidey']], 'same as a name that matches no member');
    assert.ok(!JSON.stringify(sent.data.warning ?? '').includes('Hidey') && !('mentionHints' in sent.data));
    const nobody = await call(app, 'sa', 'send_message', { body: '@Nobody are you there' });
    assert.deepEqual(Object.keys(sent.data).sort(), Object.keys(nobody.data).sort(), 'no extra field reveals it');
    const to = await call(app, 'sa', 'send_message', { body: 'x', to: ['Hidey'] });
    assert.ok(to.isError && to.text.includes('unknown member name') && !to.text.split('available:')[1].includes('Hidey'));
    const everyone = await call(app, 'sa', 'send_message', { body: '@all hello' });
    assert.ok(!app.store.getMessage(everyone.data.messageId)!.mentions.includes(hidey.id));

    const history = await call(app, 'sa', 'read_messages', { history: true, detail: 'full', limit: 50 });
    const own = history.data.find((m: { id: string }) => m.id === early.data.messageId);
    assert.deepEqual([own.from, own.mentions, own.deliveries], ['Alice', [], []], 'no mention or delivery report shows it');
    const report = await call(app, 'sa', 'get_deliveries', { messageId: early.data.messageId });
    assert.deepEqual(report.data.deliveries, []);
    const probe = await call(app, 'sa', 'read_messages', { history: true, mentions: 'Hidey' });
    const probeNobody = await call(app, 'sa', 'read_messages', { history: true, mentions: 'Nobody' });
    assert.ok(probe.isError);
    assert.equal(probe.text.replace('Hidey', '?'), probeNobody.text.replace('Nobody', '?'), 'a read filter cannot probe for it');
    const tasks = await call(app, 'sa', 'list_tasks', { include: ['roles'] });
    assert.ok(!JSON.stringify(tasks.data).includes(hidey.id), 'not in memberRoles either');

    // The envelope another recipient gets names only the members it may see.
    app.hub.sendFromUser(cluster.id, '@Alice @Hidey both of you');
    const envelope = await waitFor(() => delivered.find((d) => d.sessionId === 'sa' && d.text.includes('both of you')), 'envelope');
    assert.match(envelope.text, /to=@Alice\n/);

    // The coordinator sees it, marked; so does the user's page.
    coordinate();
    const seen = await call(app, 'sc', 'list_agents');
    assert.deepEqual(seen.data.map((m: { name: string; hidden?: boolean }) => [m.name, m.hidden ?? false]), [['Alice', false], ['Hidey', true], ['Cleo', false]]);
    const forCoordinator = await call(app, 'sc', 'get_deliveries', { messageId: early.data.messageId });
    assert.equal(forCoordinator.data.deliveries.length, 1);
    const state = await app.api('GET', '/api/state');
    assert.ok(state.members.find((m: { id: string }) => m.id === hidey.id).hiddenAt);
    assert.equal(cleo.name, 'Cleo');
  } finally { await app.close(); }
});

test('every orrery tool a hidden member calls answers the explanation and executes nothing', async () => {
  const { app, cluster, hidey } = await fixture();
  try {
    const other = await app.hub.createCluster('elsewhere', [{ harness: 'mock', mode: 'native', sessionId: 'sb', name: 'Hidey' }]);
    app.hub.setMemberHidden(hidey.id, true);
    const tools = (await rpc(app, 'sb', 'tools/list', {})).result.tools as { name: string; inputSchema: Schema }[];
    assert.ok(tools.length >= 20, 'the advertised list, so a future tool cannot be forgotten');
    const tables = ['messages', 'deliveries', 'events', 'reads', 'message_acknowledgements'];
    const counts = () => tables.map((t) => (app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const before = counts();
    for (const tool of tools) {
      const result = await call(app, 'sb', tool.name, { ...(argsFor(tool.inputSchema) as object), clusterId: cluster.id });
      assert.equal(result.isError, true, tool.name);
      assert.equal(result.text, HIDDEN_TOOL_TEXT, tool.name);
    }
    assert.deepEqual(counts(), before, 'nothing written');
    assert.ok(!HIDDEN_TOOL_TEXT.includes('Alice') && !HIDDEN_TOOL_TEXT.includes('Cleo'));
    // Its membership elsewhere is not hidden: without a clusterId it acts there.
    const there = await call(app, 'sb', 'list_agents');
    assert.deepEqual(there.data.map((m: { memberId: string }) => m.memberId), [other.members[0].id]);
    // Hidden in every cluster: even without a clusterId the answer is the explanation.
    app.hub.setMemberHidden(other.members[0].id, true);
    assert.equal((await call(app, 'sb', 'read_messages')).text, HIDDEN_TOOL_TEXT);
    assert.throws(() => app.hub.sendFromMember(hidey.id, 'hello'), new RegExp(HIDDEN_TOOL_TEXT));
  } finally { await app.close(); }
});

test('only the user and the coordinator with deliveryControl can hide or show; nobody hides itself; the coordinator is never hidden', async () => {
  const { app, cluster, hidey, cleo, coordinate, count } = await fixture();
  try {
    const status = async (memberId: string, hidden: unknown) => (await fetch(`${app.url}/api/members/${memberId}/hidden`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden }) })).status;
    assert.equal(await status(hidey.id, 'yes'), 400);
    let generation = coordinate(false);
    const denied = await call(app, 'sc', 'set_cluster_paused', { operationId: 'h1', memberId: 'Hidey', hidden: true, generation });
    assert.ok(denied.isError && /deliveryControl/.test(denied.text));
    generation = coordinate(true);
    for (const g of [generation, 0]) {
      const ordinary = await call(app, 'sa', 'set_cluster_paused', { operationId: `h2-${g}`, memberId: 'Hidey', hidden: true, generation: g });
      assert.ok(ordinary.isError && /STALE_POLICY|FORBIDDEN/.test(ordinary.text), `an ordinary member cannot hide anyone: ${ordinary.text}`);
    }
    const alone = await call(app, 'sa', 'set_cluster_paused', { operationId: 'h2-self', memberId: 'Alice', hidden: true, generation });
    assert.ok(alone.isError, 'not even itself');
    assert.equal(app.store.getMember(hidey.id)!.hiddenAt, null);
    const self = await call(app, 'sc', 'set_cluster_paused', { operationId: 'h3', memberId: cleo.id, hidden: true, generation });
    assert.ok(self.isError);
    assert.equal(await status(cleo.id, true), 400, 'the user cannot hide the current coordinator');
    assert.equal(app.store.getMember(cleo.id)!.hiddenAt, null);

    const messages = count('SELECT COUNT(*) AS n FROM messages');
    const ok = await call(app, 'sc', 'set_cluster_paused', { operationId: 'h4', memberId: 'Hidey', hidden: true, generation });
    assert.equal(ok.isError, false, ok.text);
    assert.ok(app.store.getMember(hidey.id)!.hiddenAt);
    assert.equal(count('SELECT COUNT(*) AS n FROM messages'), messages, 'no chat message announces it');
    assert.throws(() => app.hub.collaboration.command({ kind: 'user' }, cluster.id,
      { action: 'coordinator.set', operationId: 'c', memberId: hidey.id, enabled: true, mode: 'execute' }), /hidden/);
    const show = await call(app, 'sc', 'set_cluster_paused', { operationId: 'h5', memberId: hidey.id, hidden: false, generation });
    assert.equal(show.isError, false, show.text);
    assert.equal(app.store.getMember(hidey.id)!.hiddenAt, null);
    assert.equal(await status(hidey.id, true), 200);
    assert.equal(await status(hidey.id, false), 200);
    assert.equal(app.store.getMember(hidey.id)!.hiddenAt, null);
  } finally { await app.close(); }
});

test('tasks: a hidden member cannot be given one (ordinary callers learn nothing), held ones stay, stalled hints say hidden', async () => {
  const { app, cluster, alice, hidey, coordinate } = await fixture({ limits: { stalledMemberMs: 1 } });
  try {
    const user = { kind: 'user' } as const;
    const create = (operationId: string, extra: Record<string, unknown>) => app.hub.collaboration.command(user, cluster.id,
      { action: 'task.create', operationId, title: operationId, scope: 's', acceptance: 'a', ...extra });
    const held = create('held', { memberId: hidey.id }).task!;
    const reviewed = create('reviewed', { memberId: alice.id, reviewer: { kind: 'member', memberId: hidey.id } }).task!;
    app.hub.setMemberHidden(hidey.id, true);
    assert.equal(app.store.tasks!.task(cluster.id, held.id)!.assignedMemberId, hidey.id, 'held tasks are kept');
    assert.equal(app.store.tasks!.task(cluster.id, reviewed.id)!.reviewer.kind, 'member');
    assert.throws(() => create('new', { memberId: hidey.id }), /is hidden/, 'the user is told why');
    assert.throws(() => create('rev', { reviewer: { kind: 'member', memberId: hidey.id } }), /is hidden/);
    const asHidden = await call(app, 'sa', 'create_task', { operationId: 'o1', title: 't', scope: 's', acceptance: 'a', memberId: 'Hidey' });
    const asNobody = await call(app, 'sa', 'create_task', { operationId: 'o2', title: 't', scope: 's', acceptance: 'a', memberId: 'Nobody' });
    assert.ok(asHidden.isError);
    assert.equal(asHidden.text, asNobody.text, 'the same answer as for no such member');
    const generation = coordinate();
    const asCoordinator = await call(app, 'sc', 'task_action', { operationId: 'o3', action: 'assign', taskId: held.id,
      expectedRevision: app.store.tasks!.task(cluster.id, held.id)!.revision, memberId: hidey.id, generation });
    assert.ok(asCoordinator.isError && /hidden/.test(asCoordinator.text), 'the coordinator is told why');

    await sleep(5);
    const { hints } = await app.api('GET', '/api/stalled');
    const hint = hints.find((h: { memberId: string }) => h.memberId === hidey.id);
    assert.equal(hint?.hidden, true);
    ((app.hub as unknown as { services: Map<string, { checkStalled(id: string): void }> }).services.get('tasks')!).checkStalled(cluster.id);
    const notice = app.store.listMessages(cluster.id, 50).find((m) => m.from === 'system' && m.body.includes('成员长时间没有活动：一位成员'));
    assert.equal(notice, undefined, 'no chat notice about a hidden holder: the page hint and rule 21 notices cover it');

    const task = (id: string, assignedMemberId: string | null): Task => ({ id, status: 'pending', proposalState: 'active', assignedMemberId,
      reviewer: { kind: 'user' }, executeRoleIds: [], reviewRoleIds: [], dependenciesReady: true }) as unknown as Task;
    const candidates = idleTaskCandidates({ tasks: [task('t', null)], memberRoles: [], coordinator: null,
      members: [{ id: 'h', status: 'idle', removedAt: null, harness: 'mock', workerSessionId: 'h', hiddenAt: 'now' },
        { id: 'v', status: 'idle', removedAt: null, harness: 'mock', workerSessionId: 'v', hiddenAt: null }] });
    assert.deepEqual(candidates.execute.map((c) => c.memberId), ['v'], 'idle candidates never include a hidden member');
  } finally { await app.close(); }
});

test('a member has one shape wherever it is built: hiddenAt is always there, null when not hidden', async () => {
  const { app, cluster, alice, hidey } = await fixture();
  try {
    const shape = (m: object) => { const { status: _status, longWaiting: _waiting, ...rest } = m as Record<string, unknown>; return rest; };
    const { members: [fresh] } = await app.cluster('iso', ['Iso']);
    const { members: [added] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 'sx', name: 'Added' }]);
    for (const created of [alice, fresh, added]) {
      assert.equal(created.hiddenAt, null, created.name);
      assert.deepEqual(shape(created), app.store.getMember(created.id), `${created.name}: created equals reloaded`);
    }
    const state = await app.api('GET', '/api/state');
    for (const m of state.members) assert.ok(Object.hasOwn(m, 'hiddenAt'), `/api/state ${m.name}`);
    for (const e of app.events.filter((x) => x.kind === 'member' || x.kind === 'cluster')) {
      const payload = e.payload as { member?: Record<string, unknown>; members?: Record<string, unknown>[] };
      for (const m of [...(payload.member ? [payload.member] : []), ...(payload.members ?? [])]) assert.ok(Object.hasOwn(m, 'hiddenAt'), `event ${e.seq}`);
    }
    const hidden = app.hub.setMemberHidden(hidey.id, true);
    assert.deepEqual(shape(hidden), app.store.getMember(hidey.id));
    const { member: moved } = await app.hub.rebindMember(hidey.id, { harness: 'mock', sessionId: 's9', confirmStopped: true });
    assert.deepEqual(shape(moved), app.store.getMember(hidey.id));
    const removed = app.hub.removeMember(cluster.id, alice.id);
    assert.deepEqual(shape(removed), app.store.getMember(alice.id, { includeRemoved: true }));
  } finally { await app.close(); }
});

test('notices written after hiding name the hidden member to nobody: submit with a hidden reviewer, handoff from a hidden executor', async () => {
  const { app, cluster, alice, hidey, coordinate, delivered } = await fixture({ limits: { stalledMemberMs: 1 } });
  try {
    const user = { kind: 'user' } as const;
    const c = app.hub.collaboration;
    const create = (operationId: string, extra: Record<string, unknown>) => c.command(user, cluster.id,
      { action: 'task.create', operationId, title: operationId, scope: 's', acceptance: 'a', mergeRequired: false, ...extra }).task!;
    const start = (memberId: string, taskId: string) => {
      const task = app.store.tasks!.task(cluster.id, taskId)!;
      c.command({ kind: 'member', memberId }, cluster.id, { action: 'task.start', operationId: `start-${taskId}`, taskId, expectedRevision: task.revision });
      return app.store.tasks!.task(cluster.id, taskId)!;
    };
    const reviewed = create('review-task', { memberId: alice.id, reviewer: { kind: 'member', memberId: hidey.id } });
    const executed = create('exec-task', { memberId: hidey.id });
    const started = start(alice.id, reviewed.id);
    const held = start(hidey.id, executed.id);
    const generation = coordinate();
    await waitFor(async () => app.hub.isRunning() && (await app.messages(cluster.id)).every((m) => m.deliveries.every((d) => d.state !== 'queued' && d.state !== 'running')), 'quiet');
    const before = new Set(app.store.listMessages(cluster.id, 1000).map((m) => m.id));
    const deliveredBefore = delivered.length;
    app.hub.setMemberHidden(hidey.id, true);

    // A hidden reviewer: Alice submits.
    c.command({ kind: 'member', memberId: alice.id }, cluster.id, { action: 'task.submit', operationId: 'submit', taskId: reviewed.id,
      expectedRevision: started.revision, assignmentId: started.currentAssignmentId ?? undefined, summary: 'done' });
    // A hidden executor: the coordinator hands its started task to Alice, confirming the stop (a notice that names the old executor).
    const handoff = await call(app, 'sc', 'task_action', { operationId: 'handoff', action: 'handoff', taskId: executed.id, expectedRevision: held.revision,
      assignmentId: held.currentAssignmentId, memberId: alice.id, reason: 'hidden', generation });
    assert.equal(handoff.isError, false, handoff.text);
    ((app.hub as unknown as { services: Map<string, { checkStalled(id: string): void }> }).services.get('tasks')!).checkStalled(cluster.id);
    await app.hub.rebindMember(hidey.id, { harness: 'mock', sessionId: 's9', confirmStopped: true });

    const fresh = app.store.listMessages(cluster.id, 1000).filter((m) => !before.has(m.id));
    const bodies = fresh.map((m) => m.body).join('\n');
    assert.match(bodies, /等待 一位成员 验收/, 'the submit notice');
    assert.match(bodies, /一位成员 请立即停手/, 'the handoff notice');
    assert.ok(!/成员长时间没有活动：一位成员/.test(bodies), 'no stalled notice about a hidden holder');
    assert.ok(!/换到了新对话/.test(bodies), 'no rebind notice about a hidden member');
    const ordinary = fresh.filter((m) => !m.body.includes('协调规则第 21 条')).map((m) => m.body).join('\n');
    assert.ok(!ordinary.includes('隐身'), `only the coordinator's rule 21 notices say someone is hidden:\n${ordinary}`);
    assert.ok(!bodies.includes('Hidey'), `no new notice names it:\n${bodies}`);

    for (const args of [{ history: false }, { history: true, detail: 'full', limit: 100 }]) {
      const read = await call(app, 'sa', 'read_messages', args);
      const mine = read.data.filter((m: { id: string }) => !before.has(m.id));
      if (args.history) assert.ok(mine.length > 0, 'the new notices are in the history');
      assert.ok(!JSON.stringify(mine).includes('Hidey'), `read_messages ${JSON.stringify(args)}`);
    }
    const envelopes = await waitFor(() => {
      const late = delivered.slice(deliveredBefore).filter((d) => d.sessionId === 'sa');
      return late.some((d) => d.text.includes('请立即停手')) ? late : null;
    }, 'the handoff notice reaches Alice');
    for (const e of envelopes) assert.ok(!e.text.includes('Hidey'), e.text);

    // The coordinator still knows who it is: list_agents and the task records.
    const agents = await call(app, 'sc', 'list_agents');
    assert.ok(agents.data.some((m: { name: string; hidden?: boolean }) => m.name === 'Hidey' && m.hidden));
    const task = await call(app, 'sc', 'get_task', { taskId: reviewed.id });
    assert.equal(task.data.task.reviewer.memberId, hidey.id);
  } finally { await app.close(); }
});

test('the hide confirmation gets every held task: the workspace holder filter finds them past the first page', async () => {
  const { app, cluster, alice, hidey } = await fixture();
  try {
    const user = { kind: 'user' } as const;
    const c = app.hub.collaboration;
    const create = (i: number, extra: Record<string, unknown> = {}) => c.command(user, cluster.id,
      { action: 'task.create', operationId: `t${i}`, title: `t${i}`, scope: 's', acceptance: 'a', mergeRequired: false, ...extra }).task!;
    const first = create(1, { memberId: alice.id, reviewer: { kind: 'member', memberId: hidey.id } });
    c.command({ kind: 'member', memberId: alice.id }, cluster.id, { action: 'task.start', operationId: 's1', taskId: first.id, expectedRevision: first.revision });
    const started = app.store.tasks!.task(cluster.id, first.id)!;
    c.command({ kind: 'member', memberId: alice.id }, cluster.id, { action: 'task.submit', operationId: 'u1', taskId: first.id,
      expectedRevision: started.revision, assignmentId: started.currentAssignmentId ?? undefined, summary: 'done' });
    for (let i = 2; i <= 101; i++) create(i);
    const last = create(102, { memberId: hidey.id });
    const all = await app.api('GET', `/api/clusters/${cluster.id}/workspace?limit=100`);
    assert.ok(all.nextCursor && !all.tasks.some((t: { id: string }) => t.id === last.id), 'the unfiltered first page misses #102');
    const held = await app.api('GET', `/api/clusters/${cluster.id}/workspace?holder=${hidey.id}&limit=100`);
    assert.deepEqual(held.tasks.map((t: { number: number }) => t.number).sort((a: number, b: number) => a - b), [1, 102]);
    assert.equal(held.nextCursor, null);
    const one = await app.api('GET', `/api/clusters/${cluster.id}/workspace?holder=${hidey.id}&limit=1`);
    assert.equal(one.tasks.length, 1);
    assert.ok(one.nextCursor, 'pages like the rest of the workspace, so the page follows the cursor');
  } finally { await app.close(); }
});

/** Tasks for the work-lands-on-a-hidden-member tests: create, start, submit and review through the real actions. */
function taskSteps(app: App, clusterId: string) {
  const c = app.hub.collaboration;
  const user = { kind: 'user' } as const;
  const member = (memberId: string) => ({ kind: 'member', memberId }) as const;
  const now = (taskId: string) => app.store.tasks!.task(clusterId, taskId)!;
  let n = 0;
  return {
    now,
    create: (title: string, extra: Record<string, unknown>) => c.command(user, clusterId,
      { action: 'task.create', operationId: `c-${title}`, title, scope: 's', acceptance: 'a', mergeRequired: false, ...extra }).task!,
    start: (memberId: string, taskId: string) => c.command(member(memberId), clusterId,
      { action: 'task.start', operationId: `s${++n}`, taskId, expectedRevision: now(taskId).revision }),
    submit: (memberId: string, taskId: string) => c.command(member(memberId), clusterId, { action: 'task.submit', operationId: `u${++n}`, taskId,
      expectedRevision: now(taskId).revision, assignmentId: now(taskId).currentAssignmentId ?? undefined, summary: 'done' }),
    review: (actor: { kind: 'user' } | { kind: 'member'; memberId: string }, taskId: string, verdict: 'approve' | 'reject') => c.command(actor, clusterId,
      { action: 'task.review', operationId: `r${++n}`, taskId, expectedRevision: now(taskId).revision, submissionId: now(taskId).latestSubmissionId ?? undefined,
        verdict, reason: verdict === 'reject' ? 'needs more work' : 'fine' }),
    user, member,
  };
}

test('work that lands on a hidden member: a rejection back to it shows on the page at once and wakes an entitled coordinator', async () => {
  const { app, cluster, alice, hidey, cleo, coordinate, count } = await fixture();
  try {
    const t = taskSteps(app, cluster.id);
    const task = t.create('rejected-task', { memberId: hidey.id, reviewer: { kind: 'member', memberId: alice.id } });
    t.start(hidey.id, task.id);
    t.submit(hidey.id, task.id);
    coordinate();
    app.hub.setMemberHidden(hidey.id, true);
    const coordinatorBefore = count(`SELECT COUNT(*) AS n FROM deliveries WHERE member_id = '${cleo.id}'`);
    const hiddenBefore = count(`SELECT COUNT(*) AS n FROM deliveries WHERE member_id = '${hidey.id}'`);
    const rejected = t.review(t.member(alice.id), task.id, 'reject');
    assert.equal(rejected.review?.verdict, 'reject', 'the reviewer’s own result is as usual');
    assert.equal(count(`SELECT COUNT(*) AS n FROM deliveries WHERE member_id = '${hidey.id}'`), hiddenBefore, 'no delivery to the hidden executor');

    const { hints } = await app.api('GET', '/api/stalled');
    const hint = hints.find((h: { kind: string; memberId: string }) => h.kind === 'hidden_work' && h.memberId === hidey.id);
    assert.deepEqual(hint?.tasks.map((x: { id: string; waiting: string }) => [x.id, x.waiting]), [[task.id, 'rejected']], 'the page hint, at once');
    const told = app.store.listMessages(cluster.id, 100).filter((m) => m.from === 'system' && m.mentions.includes(cleo.id) && m.body.includes('是一位隐身成员，收不到通知'));
    assert.equal(told.length, 1, 'one coordinator wake-up');
    assert.match(told[0].body, /被退回，但执行者是一位隐身成员/);
    assert.equal(told[0].systemKind, 'hidden_work', 'a problem-level warning');
    assert.ok(!told[0].body.includes('Hidey'), 'every member can read it: no name');
    assert.equal(count(`SELECT COUNT(*) AS n FROM deliveries WHERE member_id = '${cleo.id}'`), coordinatorBefore + 1, 'a delivery to the coordinator');
    assert.ok(app.events.some((e) => e.kind === 'guard' && e.memberId === hidey.id && (e.payload as { reason: string }).reason === 'hidden_work'), 'a line on its member page');

    // Handed to another member: the hint goes.
    const { members: [dora] } = await app.hub.addMembers(cluster.id, [{ harness: 'mock', mode: 'native', sessionId: 'sx', name: 'Dora' }]);
    app.hub.collaboration.command(t.user, cluster.id, { action: 'task.handoff', operationId: 'h', taskId: task.id, expectedRevision: t.now(task.id).revision,
      assignmentId: t.now(task.id).currentAssignmentId ?? undefined, memberId: dora.id, reason: 'executor hidden', confirmStopped: true });
    assert.ok(!(await app.api('GET', '/api/stalled')).hints.some((h: { kind: string }) => h.kind === 'hidden_work'), 'gone after reassigning');
  } finally { await app.close(); }
});

test('work that lands on a hidden member: a new submission for a hidden reviewer and a dependency ready for a hidden executor; coordinators without permission and no coordinator get nothing', async () => {
  const { app, cluster, alice, hidey, cleo, coordinate } = await fixture();
  try {
    const t = taskSteps(app, cluster.id);
    const reviewed = t.create('review-me', { memberId: alice.id, reviewer: { kind: 'member', memberId: hidey.id } });
    const first = t.create('first', { memberId: alice.id });
    const later = t.create('later', { memberId: hidey.id, dependencyIds: [first.id] });
    t.start(alice.id, reviewed.id);
    t.start(alice.id, first.id);
    coordinate(false, false);   // enabled, but nothing it could do about it
    app.hub.setMemberHidden(hidey.id, true);
    t.submit(alice.id, reviewed.id);
    t.submit(alice.id, first.id);
    t.review(t.user, first.id, 'approve');   // completes `first`: `later` becomes ready for its hidden executor

    const { hints } = await app.api('GET', '/api/stalled');
    const hint = hints.find((h: { kind: string; memberId: string }) => h.kind === 'hidden_work' && h.memberId === hidey.id);
    assert.deepEqual(new Map(hint?.tasks.map((x: { id: string; waiting: string }) => [x.id, x.waiting])), new Map([[reviewed.id, 'review'], [later.id, 'ready']]));
    const coordinatorNotices = () => app.store.listMessages(cluster.id, 200).filter((m) => m.from === 'system' && m.mentions.includes(cleo.id) && m.body.includes('是一位隐身成员，收不到通知'));
    assert.equal(coordinatorNotices().length, 0, 'a coordinator without any of the permissions only leaves it to the user');
    // Showing it again ends the hint.
    app.hub.setMemberHidden(hidey.id, false);
    assert.ok(!(await app.api('GET', '/api/stalled')).hints.some((h: { kind: string }) => h.kind === 'hidden_work'), 'gone after showing');
  } finally { await app.close(); }
});

test('work that lands on a hidden member: a rolled-back operation tells nobody, and its retry tells the coordinator once', async () => {
  const { app, cluster, hidey, cleo, coordinate } = await fixture();
  try {
    const t = taskSteps(app, cluster.id);
    const task = t.create('asked', { memberId: hidey.id });
    coordinate();
    app.hub.setMemberHidden(hidey.id, true);
    const told = () => app.store.listMessages(cluster.id, 200).filter((m) => m.mentions.includes(cleo.id) && m.body.includes('是一位隐身成员，收不到通知')).length;
    const facts = () => app.store.hiddenWork(hidey.id, app.store.getMember(hidey.id)!.hiddenAt!).length;
    const ask = (operationId: string, expectedRevision: number) => app.hub.collaboration.command(t.user, cluster.id, { action: 'task.attention', operationId,
      taskId: task.id, expectedRevision, kind: 'question', question: operationId, targetMemberId: hidey.id });
    ask('a1', t.now(task.id).revision);
    assert.deepEqual([told(), facts()], [1, 1]);
    const revision = t.now(task.id).revision;
    // The coordinator's notice cannot be written: the whole operation rolls back.
    app.store.db.exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON messages WHEN NEW.body LIKE '%协调规则第 21 条%' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    assert.throws(() => ask('a2', revision), /injected/);
    assert.deepEqual([t.now(task.id).revision, told(), facts()], [revision, 1, 1], 'nothing of it stayed');
    app.store.db.exec('DROP TRIGGER fail_notice');
    ask('a2', revision);
    assert.deepEqual([told(), facts()], [2, 2], 'the retry tells the coordinator once');
  } finally { await app.close(); }
});

test('work that lands on a hidden member: coordinator notices queue through global and cluster pauses', async () => {
  for (const pause of ['global', 'cluster']) {
    const { app, cluster, hidey, cleo, coordinate, delivered } = await fixture();
    try {
      const t = taskSteps(app, cluster.id);
      const task = t.create(`paused-${pause}`, { memberId: hidey.id });
      coordinate();
      app.hub.setMemberHidden(hidey.id, true);
      const setPaused = (paused: boolean) => pause === 'global' ? app.hub.setPaused(paused)
        : app.hub.collaboration.command(t.user, cluster.id, { action: 'cluster.pause', operationId: `${pause}-${paused}`, paused });
      setPaused(true);
      app.hub.collaboration.command(t.user, cluster.id, { action: 'task.attention', operationId: 'paused-question',
        taskId: task.id, expectedRevision: t.now(task.id).revision, kind: 'question', question: 'needs handling', targetMemberId: hidey.id });
      const notices = app.store.listMessages(cluster.id, 100).filter((message) =>
        message.mentions.includes(cleo.id) && message.body.includes('是一位隐身成员，收不到通知'));
      assert.equal(notices.length, 1, pause);
      assert.equal(app.store.withDeliveries(notices)[0].deliveries[0].state, 'queued', pause);
      const hints = (await app.api('GET', '/api/stalled')).hints;
      assert.ok(hints.some((hint: { kind: string; memberId: string }) => hint.kind === 'hidden_work' && hint.memberId === hidey.id));
      setPaused(false);
      await waitFor(() => delivered.some((item) => item.sessionId === 'sc' && item.text.includes('是一位隐身成员，收不到通知')), 'coordinator notice after resume');
    } finally { await app.close(); }
  }
});

test('work that lands on a hidden member: a dismissed hint comes back for a new item of the same kind on the same task', async () => {
  const stalled = await import(new URL('../src/web/public/stalled.js', import.meta.url).href);
  const { app, cluster, hidey } = await fixture();
  try {
    const t = taskSteps(app, cluster.id);
    const task = t.create('asked-twice', { memberId: hidey.id });
    app.hub.setMemberHidden(hidey.id, true);
    const ask = (question: string) => app.hub.collaboration.command(t.user, cluster.id, { action: 'task.attention', operationId: question,
      taskId: task.id, expectedRevision: t.now(task.id).revision, kind: 'question', question, targetMemberId: hidey.id });
    const work = async () => (await app.api('GET', '/api/stalled')).hints.filter((h: { kind: string }) => h.kind === 'hidden_work');
    ask('first question');
    const [first] = await work();
    assert.equal(first.tasks[0].waiting, 'attention');
    const dismissed = stalled.withDismissed({}, first);
    assert.equal(stalled.visibleStalled(await work(), dismissed).length, 0, 'dismissed');
    ask('a different question');
    assert.equal(stalled.visibleStalled(await work(), dismissed).length, 1, 'a new item brings it back');
  } finally { await app.close(); }
});

test('work that lands on a hidden member: named questions show until resolved and are included in the return brief', async () => {
  const { app, cluster, alice, hidey } = await fixture();
  try {
    const t = taskSteps(app, cluster.id);
    const task = t.create('another-members-task', { memberId: alice.id });
    app.hub.setMemberHidden(hidey.id, true);
    const ask = (question: string) => app.hub.collaboration.command(t.user, cluster.id, {
      action: 'task.attention', operationId: question, taskId: task.id, expectedRevision: t.now(task.id).revision,
      kind: 'question', question, targetMemberId: hidey.id,
    });
    const resolve = (attentionId: string) => app.hub.collaboration.command(t.user, cluster.id, {
      action: 'task.resolve_attention', operationId: `resolve-${attentionId}`, taskId: task.id,
      expectedRevision: t.now(task.id).revision, attentionId, resolution: 'handled',
    });
    const hint = async () => (await app.api('GET', '/api/stalled')).hints.find((item: { kind: string; memberId: string }) =>
      item.kind === 'hidden_work' && item.memberId === hidey.id);
    const first = ask('first named question');
    assert.deepEqual((await hint()).tasks.map((item: { id: string; waiting: string; role: string }) =>
      [item.id, item.waiting, item.role]), [[task.id, 'attention', 'named']]);
    const second = ask('second named question');
    resolve(first.attention!.id);
    assert.equal((await hint()).tasks[0].id, task.id, 'the other question is still open');
    resolve(second.attention!.id);
    assert.equal(await hint(), undefined, 'all questions resolved');

    ask('question pending on return');
    const before = new Set(app.store.listMessages(cluster.id, 100).map((message) => message.id));
    app.hub.setMemberHidden(hidey.id, false);
    const fresh = app.store.listMessages(cluster.id, 100).filter((message) => !before.has(message.id));
    assert.equal(fresh.length, 1);
    assert.match(fresh[0].body, /等你处理的事项（用 get_task_context 查看）：/);
    assert.ok(fresh[0].body.includes(task.title));
    assert.ok(!fresh[0].body.includes('question pending on return'), 'only task status, not a replay of the question');
    assert.deepEqual(fresh[0].mentions, [hidey.id]);
    assert.equal(await hint(), undefined, 'shown again');
  } finally { await app.close(); }
});

test('work that lands on a hidden member: the coordinator is told once per task state, and a replay tells nothing', async () => {
  const { app, cluster, hidey, cleo, coordinate } = await fixture();
  try {
    const t = taskSteps(app, cluster.id);
    const task = t.create('asked', { memberId: hidey.id });
    coordinate();
    app.hub.setMemberHidden(hidey.id, true);
    const revisions: number[] = [];
    for (const n of [1, 2]) {
      app.hub.collaboration.command(t.user, cluster.id, { action: 'task.attention', operationId: `a${n}`, taskId: task.id,
        expectedRevision: t.now(task.id).revision, kind: 'question', question: `q${n}`, targetMemberId: hidey.id });
      revisions.push(t.now(task.id).revision);
    }
    const told = app.store.listMessages(cluster.id, 100).filter((m) => m.mentions.includes(cleo.id) && m.body.includes('是一位隐身成员，收不到通知'));
    assert.equal(told.length, new Set(revisions).size, 'one per task state');
    // Replaying the same operation writes no new event and no new notice.
    app.hub.collaboration.command(t.user, cluster.id, { action: 'task.attention', operationId: 'a2', taskId: task.id,
      expectedRevision: revisions[0], kind: 'question', question: 'q2', targetMemberId: hidey.id });
    assert.equal(app.store.listMessages(cluster.id, 100).filter((m) => m.mentions.includes(cleo.id) && m.body.includes('是一位隐身成员，收不到通知')).length, told.length);
  } finally { await app.close(); }
});

test('shown again: one task-status wake-up with what it holds (rejected while hidden marked); nothing held, no notice', async () => {
  const { app, cluster, alice, hidey, cleo, delivered } = await fixture();
  try {
    const t = taskSteps(app, cluster.id);
    const rejected = t.create('come-back', { memberId: hidey.id, reviewer: { kind: 'member', memberId: alice.id } });
    const toReview = t.create('to-review', { memberId: alice.id, reviewer: { kind: 'member', memberId: hidey.id } });
    const ready = t.create('ready-one', { memberId: hidey.id });
    t.start(hidey.id, rejected.id);
    t.submit(hidey.id, rejected.id);
    t.start(alice.id, toReview.id);
    app.hub.setMemberHidden(hidey.id, true);
    t.review(t.member(alice.id), rejected.id, 'reject');
    t.submit(alice.id, toReview.id);
    app.hub.sendFromUser(cluster.id, '@Hidey while hidden');
    const before = new Set(app.store.listMessages(cluster.id, 500).map((m) => m.id));
    app.hub.setMemberHidden(hidey.id, false);
    const fresh = app.store.listMessages(cluster.id, 500).filter((m) => !before.has(m.id));
    assert.equal(fresh.length, 1, 'exactly one new message');
    const brief = fresh[0];
    assert.deepEqual(brief.mentions, [hidey.id]);
    assert.match(brief.body, /正在做：\n- 任务 #1【come-back】.*隐身期间被退回/);
    assert.match(brief.body, /已分配、可以开工：\n- 任务 #3【ready-one】/);
    assert.match(brief.body, /等你验收：\n- 任务 #2【to-review】/);
    assert.ok(!brief.body.includes('Alice') && !brief.body.includes('Cleo') && !brief.body.includes('needs more work'), 'names nobody, copies no review text');
    assert.equal(app.store.unreadBreakdown(hidey.id, cluster.id).total, 1, 'it is the only unread: the hidden period is not replayed');
    await waitFor(() => delivered.some((d) => d.sessionId === 'sb' && d.text.includes('你已取消隐身')), 'the brief is delivered');
    assert.ok(!delivered.some((d) => d.sessionId === 'sb' && d.text.includes('while hidden')));

    // Nothing held: no notice.
    app.hub.setMemberHidden(cleo.id, true);
    const quiet = new Set(app.store.listMessages(cluster.id, 500).map((m) => m.id));
    app.hub.setMemberHidden(cleo.id, false);
    assert.equal(app.store.listMessages(cluster.id, 500).filter((m) => !quiet.has(m.id)).length, 0);
  } finally { await app.close(); }
});

test('rebind keeps the hidden state, removal clears it, and a hidden new conversation gets no delivery', async () => {
  const { app, cluster, hidey, delivered } = await fixture();
  try {
    app.hub.setMemberHidden(hidey.id, true);
    const { member } = await app.hub.rebindMember(hidey.id, { harness: 'mock', sessionId: 's9', confirmStopped: true });
    assert.ok(member.hiddenAt, 'rebind keeps it');
    assert.equal(app.hub.removeMember(cluster.id, hidey.id).hiddenAt, null, 'removal clears it');

    const { cluster: iso, members: [created] } = await app.cluster('iso', ['Iso']);
    app.hub.setMemberHidden(created.id, true);
    const msg = await app.api('POST', `/api/clusters/${iso.id}/messages`, { body: '@Iso hi' });
    await sleep(50);
    assert.deepEqual((await app.messages(iso.id)).find((m) => m.id === msg.id)!.deliveries, []);
    assert.equal(delivered.filter((d) => d.sessionId === created.workerSessionId).length, 0, 'no turn');
  } finally { await app.close(); }
});
