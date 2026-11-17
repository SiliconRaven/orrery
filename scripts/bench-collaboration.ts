#!/usr/bin/env node
// Fixed mock scenarios over the real Hub HTTP/MCP endpoints. See docs/evaluation.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaborationResult, TaskResult } from '../src/core/collaboration-types.ts';
import { holdScript, startTestHub, waitFor, type TestHub } from '../test/helpers.ts';

type Outcome = { clusterId: string; checks: string[]; metrics?: Record<string, number> };
type ScenarioResult = { name: string; passed: boolean; durationMs: number; checks?: string[];
  metrics?: Record<string, number>; error?: string };

async function scenario(name: string, run: (app: TestHub) => Promise<Outcome>, options: Parameters<typeof startTestHub>[0] = {}): Promise<ScenarioResult> {
  const start = performance.now();
  let app: TestHub | undefined;
  let result: Omit<ScenarioResult, 'durationMs'>;
  try {
    app = await startTestHub({ ...options, port: 0 });
    const { clusterId, checks, metrics } = await run(app);
    await waitFor(() => app!.settled(clusterId), name + ' finished');
    const messages = await app.messages(clusterId);
    const deliveries = messages.flatMap((message) => message.deliveries);
    assert.ok(deliveries.every((delivery) => delivery.state === 'done'), 'every scheduled delivery completed');
    const measured = {
      messages: messages.length,
      deliveries: deliveries.length,
      turns: app.native.delivered.length,
      batches: new Set(deliveries.map((delivery) => delivery.batchId).filter(Boolean)).size,
      maxHop: Math.max(0, ...messages.map((message) => Number(message.hop))),
      ...metrics,
    };
    result = { name, passed: true, checks, metrics: measured };
  } catch (error) {
    result = { name, passed: false,
      error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { await app?.close(); } catch (error) {
      result = { name, passed: false, error: `Hub cleanup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ...result, durationMs: performance.now() - start };
}

async function directedRelay(app: TestHub): Promise<Outcome> {
  const { cluster, members: [a, b, observer] } = await app.cluster('directed-relay', ['A', 'B', 'Observer']);
  await app.api('POST', `/api/clusters/${cluster.id}/messages`, { body: '@A relay B roundtrip' });
  await waitFor(async () => (await app.messages(cluster.id)).length === 3 && await app.settled(cluster.id), 'relay roundtrip');
  const rows = await app.messages(cluster.id);
  assert.deepEqual(rows.map((message) => message.body), ['@A relay B roundtrip', '@B ping roundtrip', '@A pong roundtrip']);
  assert.deepEqual(rows.map((message) => message.deliveries.map((delivery) => delivery.memberId)), [[a.id], [b.id], [a.id]]);
  assert.ok(rows.every((message) => !message.deliveries.some((delivery) => delivery.memberId === observer.id)));
  assert.equal(app.native.delivered.length, 3, 'one turn per step');
  const calls = app.events.filter((event) => event.kind === 'agent'
    && (event.payload as { event: { type: string; phase?: string } }).event.type === 'tool'
    && (event.payload as { event: { phase?: string } }).event.phase === 'start');
  assert.equal(calls.length, 2, 'the relay and reply use the real MCP send_message tool');
  return { clusterId: cluster.id, checks: ['directed recipients', 'roundtrip bodies', 'observer receives no delivery', 'two MCP sends'],
    metrics: { mcpCalls: calls.length } };
}

async function pausedBatch(app: TestHub, release: () => void): Promise<Outcome> {
  const { cluster } = await app.cluster('paused-batch', ['A']);
  const path = `/api/clusters/${cluster.id}/messages`;
  const first = await app.api('POST', path, { body: '@A hold' });
  await waitFor(async () => (await app.messages(cluster.id))[0]?.deliveries[0]?.state === 'running', 'held turn starts');
  app.hub.setPaused(true);
  await app.api('POST', path, { body: '@A first queued' });
  await app.api('POST', path, { body: '@A second queued' });
  release();
  await waitFor(async () => (await app.messages(cluster.id)).find((message) => message.id === first.id)?.deliveries[0]?.state === 'done', 'held turn ends');
  const held = await app.messages(cluster.id);
  assert.deepEqual(held.slice(1).map((message) => message.deliveries[0].state), ['queued', 'queued']);
  assert.equal(app.native.delivered.length, 1, 'paused queued deliveries start no turn');
  app.hub.setPaused(false);
  await waitFor(() => app.settled(cluster.id), 'queued batch resumes');
  const rows = await app.messages(cluster.id);
  const batchIds = rows.slice(1).map((message) => message.deliveries[0].batchId);
  assert.ok(batchIds[0] && batchIds[0] === batchIds[1], 'the two queued deliveries share one batch');
  assert.equal(app.native.delivered.length, 2, 'one held turn and one batch turn');
  assert.deepEqual(rows.map((message) => message.deliveries[0].attempts), [1, 1, 1], 'each delivery is attempted once');
  return { clusterId: cluster.id, checks: ['pause holds queued work', 'resume completes it', 'two queued messages share a turn', 'one attempt per delivery'] };
}

async function taskOnce(app: TestHub): Promise<Outcome> {
  const { cluster, members: [worker, reviewer] } = await app.api('POST', '/api/clusters', {
    name: 'task-once', members: [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'Worker' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'Reviewer' },
    ],
  });
  // This is the disposable test Hub's bridge credential, never the user's Hub or an application token.
  const { secret } = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')) as { secret: string };
  let mcpCalls = 0;
  const call = async (session: string, name: string, args: Record<string, unknown>) => {
    mcpCalls++;
    const response = await fetch(app.url + '/mcp', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'x-orrery-bridge': secret, 'x-orrery-harness': 'mock', 'x-orrery-session': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: mcpCalls, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200, 'MCP transport accepted the request');
    const { result } = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
    return { isError: result.isError === true, text: result.content[0].text };
  };
  const act = async (session: string, name: string, args: Record<string, unknown>): Promise<CollaborationResult> => {
    const result = await call(session, name, { clusterId: cluster.id, ...args });
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text) as CollaborationResult;
  };
  const created = await act('s1', 'create_task', { operationId: 'create', title: 'review one result', scope: 'fixed mock result',
    acceptance: 'one submission and one independent review', reviewer: { kind: 'member', memberId: reviewer.id }, mergeRequired: false });
  assert.equal(created.task!.assignedMemberId, worker.id);
  const started = await act('s1', 'task_action', { action: 'start', operationId: 'start', taskId: created.task!.id, expectedRevision: created.task!.revision });
  const submission = { action: 'submit', operationId: 'submit-once', taskId: created.task!.id, expectedRevision: started.task!.revision,
    assignmentId: started.assignment!.id, summary: 'the fixed mock result' };
  const first = await act('s1', 'task_action', submission);
  const replay = await act('s1', 'task_action', submission);
  assert.equal(replay.submission!.id, first.submission!.id, 'retry returns the same submission');
  assert.equal(replay.eventId, first.eventId, 'retry returns the same event');
  const ownReview = await call('s1', 'task_action', { action: 'review', operationId: 'wrong-reviewer', clusterId: cluster.id,
    taskId: first.task!.id, expectedRevision: first.task!.revision, submissionId: first.submission!.id, verdict: 'approve', reason: 'own result' });
  assert.equal(ownReview.isError, true);
  assert.match(ownReview.text, /FORBIDDEN/, 'the executor cannot approve its own result');
  const detailPath = `/api/clusters/${cluster.id}/tasks/${first.task!.id}`;
  const pending = await app.api('GET', detailPath) as TaskResult;
  assert.equal(pending.task.status, 'review');
  assert.equal(pending.reviews.length, 0, 'the refused review leaves no review record');
  const approved = await act('s2', 'task_action', { action: 'review', operationId: 'review', taskId: first.task!.id,
    expectedRevision: first.task!.revision, submissionId: first.submission!.id, verdict: 'approve', reason: 'fixed result checked' });
  assert.equal(approved.task!.status, 'completed');
  const detail = await app.api('GET', detailPath) as TaskResult;
  assert.equal(detail.submissions.length, 1);
  assert.equal(detail.reviews.length, 1);
  assert.equal(detail.assignments.length, 1);
  return { clusterId: cluster.id, checks: ['submission retry is idempotent', 'executor review is rejected without a record', 'independent review completes once'],
    metrics: { mcpCalls, submissions: detail.submissions.length, reviews: detail.reviews.length, rejectedCalls: 1 } };
}

const held = holdScript();
const results = [
  await scenario('directed-relay', directedRelay),
  await scenario('paused-batch', (app) => pausedBatch(app, held.release), { mock: { script: held.script } }),
  await scenario('task-once', taskOnce),
];
const passed = results.every((result) => result.passed);
process.stdout.write(JSON.stringify({ schemaVersion: 1, mode: 'mock', node: process.version, passed, scenarios: results }, null, 2) + '\n');
for (const result of results) process.stderr.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.durationMs.toFixed(1)} ms)${result.error ? ': ' + result.error : ''}\n`);
process.exitCode = passed ? 0 : 1;
