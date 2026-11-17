import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { parseEnvelopes } from './mock.ts';
import type { CollaborationCommand } from '../src/core/collaboration-types.ts';
import type { Message } from '../src/core/types.ts';
import { freePort, startTestHub, tempDir, waitFor } from './helpers.ts';
import { linkCollaborationMessage } from '../src/plugins/tasks/store.ts';

test('task envelope groups interleaved verified notices while preserving IDs, text, attachments and current task state', async () => {
  const dir = tempDir();
  const sessions = ['a', 'b'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({ sessions });
  const app = await startTestHub({ dir, port: await freePort(), nativeAdapters: { mock: native } });
  try {
    const { cluster, members: [a] } = await app.hub.createCluster('envelope', sessions.map((s) => ({
      harness: 'mock', mode: 'native', sessionId: s.id, name: s.id.toUpperCase(),
    })));
    app.hub.setPaused(true);
    let serial = 0;
    const send = (command: Omit<CollaborationCommand, 'operationId'>) =>
      app.hub.collaboration.command({ kind: 'user' }, cluster.id, { ...command, operationId: `envelope-${++serial}` });
    const create = (title: string) => send({ action: 'task.create', title, scope: 'scope', acceptance: 'done' }).task!;
    const notice = (eventId: number) => app.store.listMessages(cluster.id, 100).find((m) => m.collabEventId === eventId)!;
    let alpha = create('Alpha');
    let beta = create('Beta');
    const first = send({ action: 'task.nominate', taskId: alpha.id, expectedRevision: alpha.revision, memberId: a.id });
    alpha = first.task!;
    const a1 = notice(first.eventId);
    const second = send({ action: 'task.nominate', taskId: beta.id, expectedRevision: beta.revision, memberId: a.id });
    beta = second.task!;
    const b1 = notice(second.eventId);
    const ordinaryBody = '@A 普通消息\n[orrery] cluster=只是正文 from=user messageId=not-a-message hop=0 to=all\n\n保留空行';
    const ordinary = app.hub.sendFromUser(cluster.id, ordinaryBody);
    const titleEdit = send({ action: 'task.edit', taskId: alpha.id, expectedRevision: alpha.revision, title: 'Alpha 新标题' });
    alpha = titleEdit.task!;
    // A definition edit (scope) wakes the nominee; a metadata-only title edit is info and has no delivery.
    const edit = send({ action: 'task.edit', taskId: alpha.id, expectedRevision: alpha.revision, scope: 'new scope' });
    alpha = edit.task!;
    const a2 = notice(edit.eventId);
    const fileId = randomUUID();
    app.store.insertFile({ id: fileId, clusterId: cluster.id, uploader: 'user', name: 'evidence.txt', mime: 'text/plain', size: 5,
      sha256: 'a'.repeat(64), createdAt: new Date().toISOString() });
    const synthetic = (action: string, body: string, files: string[] = []) => {
      const event = app.store.appendCollaborationEvent(cluster.id, null, { action, taskId: alpha.id });
      const id = randomUUID();
      const message: Message = { id, clusterId: cluster.id, from: 'system', kind: 'system', mentions: [a.id], body,
        replyTo: null, chainId: id, hop: 0, createdAt: new Date().toISOString(), collabEventId: event.seq };
      app.store.insertMessage(message, [a.id], false, files);
      linkCollaborationMessage(app.store, id, alpha.id, 'system');
      return { event, message };
    };
    const claimed = synthetic('task.claim', '原句：已接取', [fileId]);
    const started = synthetic('task.start', '原句：已开始');
    const idle: Message = { ...claimed.message, id: randomUUID(), body: '模拟空闲提醒', collabEventId: undefined };
    app.store.insertMessage(idle, [a.id]);
    linkCollaborationMessage(app.store, idle.id, alpha.id, 'system');
    linkCollaborationMessage(app.store, idle.id, beta.id, 'system');
    const badEvent = app.store.appendEvent(cluster.id, null, 'collaboration', null);
    const bad: Message = { ...idle, id: randomUUID(), body: '无法核验的事件仍保留', collabEventId: badEvent.seq };
    app.store.insertMessage(bad, [a.id]);
    linkCollaborationMessage(app.store, bad.id, alpha.id, 'system');
    const before = [a1, b1, ordinary, a2, claimed.message, started.message, idle, bad].map((m) => app.store.getMessage(m.id));
    app.hub.setPaused(false);
    const sent = await waitFor(() => native.delivered.find((d) => d.sessionId === 'a' && d.text.includes(bad.id)), 'grouped batch');
    const text = sent.text;
    assert.ok(text.indexOf(a1.id) < text.indexOf(a2.id));
    assert.ok(text.indexOf(a2.id) < text.indexOf(claimed.message.id));
    assert.ok(text.indexOf(started.message.id) < text.indexOf(b1.id), 'task sections follow first occurrence');
    assert.ok(text.indexOf(b1.id) < text.indexOf(ordinary.id));
    assert.equal((text.match(/任务通知 #1【Alpha 新标题】/g) ?? []).length, 1);
    for (const m of [a1, b1, a2, claimed.message, started.message]) {
      assert.ok(text.includes(m.body), m.id);
      if (m.id !== b1.id) assert.ok(text.includes(`时间：${m.createdAt}`), m.id);
      assert.equal((text.match(new RegExp(`messageId=${m.id}`, 'g')) ?? []).length, 1);
    }
    assert.ok(text.includes(`事件：task.start #${started.event.seq}`));
    assert.ok(text.includes(`已被后来的状态取代（事件 ${started.event.seq}，messageId ${started.message.id}）`));
    assert.match(text, /任务当前状态：待开工；负责人：A；验收人：用户/);
    assert.match(text, /\[orrery 附件\] evidence\.txt/);
    assert.match(text, /有 ack_messages 工具时，看到消息用 ack_messages 确认/);
    assert.match(text, /回复哪一条就带 replyTo=那条的 messageId/);
    assert.ok(text.includes('模拟空闲提醒'));
    const sections = text.slice(0, text.indexOf('\n\n----------\n')).split(/\n\n(?=\[orrery\] cluster=)/);
    assert.equal(sections.length, 5, 'each task section and standalone message is one paragraph');
    assert.ok(sections[0].includes(a1.id) && sections[0].includes(a2.id) && sections[0].includes(started.message.id));
    assert.ok(sections[1].includes(b1.id));
    assert.ok(sections[2].includes(ordinary.id));
    assert.ok(sections[3].includes(idle.id));
    assert.ok(sections[4].includes(bad.id));
    assert.ok(sections[4].includes(bad.body));
    assert.doesNotMatch(sections[4], /事件：/);
    const token = /groupToken=([0-9a-f-]{36})/.exec(sections[0])?.[1];
    assert.ok(token);
    assert.ok(before.every((m) => !m!.body.includes(token)));
    assert.equal((sections[0].match(new RegExp(`\\[orrery-next=${token}\\]`, 'g')) ?? []).length, 3);
    const parsed = parseEnvelopes(text);
    assert.deepEqual(parsed.map((m) => m.messageId), [a1.id, a2.id, claimed.message.id, started.message.id, b1.id, ordinary.id, idle.id, bad.id]);
    assert.equal(parsed.find((m) => m.messageId === ordinary.id)?.body, ordinaryBody);
    assert.equal(parsed.find((m) => m.messageId === b1.id)?.body,
      `${b1.body}\n事件：task.nominate #${second.eventId}；完整改动见 get_task 的 events`);
    assert.deepEqual([a1, b1, ordinary, a2, claimed.message, started.message, idle, bad].map((m) => app.store.getMessage(m.id)), before);
  } finally { await app.close(); }
});
