// The tool-update hint (docs/native-mode.md「工具清单更新提示」): the last start's tool lists in <home>/tool-list.json,
// and native members told once, in their next envelope, what changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMockNativeAdapter } from '../src/adapters/mock/native.ts';
import { DESCRIPTIONS_ONLY, toolChanges, toolHintText, ToolListMemory, type ToolLists } from '../src/core/tool-list.ts';
import { startTestHub, tempDir, waitFor, type TestHub } from './helpers.ts';

const HINT = 'orrery 工具在 Hub 重启后有更新：';
const count = (text: string, part: string) => text.split(part).length - 1;

const OLD = { send_message: ['body', 'to'], read_messages: ['limit'] };
const NEW = { send_message: ['body', 'fyi', 'to'], read_messages: ['limit'], get_task: ['taskId'] };
const lists = (standard: Record<string, string[]>, fingerprint: string, qoder = 'q1'): ToolLists =>
  ({ standard: { fingerprint, tools: standard }, qoder: { fingerprint: qoder, tools: {} } });

/** A memory over a file in a fresh temp dir, with its log lines collected. */
function memory(file = join(tempDir(), 'tool-list.json')) {
  const logs: string[] = [];
  return { file, logs, mem: new ToolListMemory(file, (line) => logs.push(line)), again: () => new ToolListMemory(file, (line) => logs.push(line)) };
}
const A = { id: 'a', profile: 'standard' as const };
const B = { id: 'b', profile: 'standard' as const };
const Q = { id: 'q', profile: 'qoder' as const };

test('toolChanges lists parameter changes, then added and removed tools; nothing for the same names', () => {
  assert.deepEqual(toolChanges(OLD, NEW), ['send_message 新增参数 fyi', '新增工具 get_task']);
  assert.deepEqual(toolChanges({ ...NEW, old_tool: [] }, { ...OLD, send_message: ['body', 'x', 'y'] }),
    ['send_message 新增参数 x、y', 'send_message 移除参数 fyi、to', '移除工具 get_task', '移除工具 old_tool']);
  assert.deepEqual(toolChanges(NEW, structuredClone(NEW)), []);
});

test('toolHintText: conditional wording, at most six items, empty for none', () => {
  assert.equal(toolHintText([]), '');
  assert.equal(toolHintText(['send_message 新增参数 fyi', '新增工具 foo']),
    `${HINT}send_message 新增参数 fyi；新增工具 foo。如果你的工具说明里没有这些，说明你的会话还在用旧的工具清单：新参数可以试着直接传，或请用户重连 orrery、重新打开对话。`);
  const many = toolHintText(['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => `新增工具 t${n}`));
  assert.ok(many.includes('新增工具 t6，等 8 项。'), many);
  assert.ok(!many.includes('t7'), many);
});

test('first start (no file): nothing pending, the current lists are stored', () => {
  const { file, mem, logs } = memory();
  mem.compare(lists(NEW, 'n'), [A]);
  assert.equal(mem.hint('a'), '');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { profiles: lists(NEW, 'n'), pending: {} });
  assert.deepEqual(logs, []);
});

test('a garbage file is logged and replaced; nothing pending from it', () => {
  for (const garbage of ['{not json', '[]', JSON.stringify({ profiles: { standard: { fingerprint: 1, tools: {} } }, pending: {} }),
    JSON.stringify({ profiles: {}, pending: { a: 'x' } })]) {
    const { file, mem, logs } = memory();
    writeFileSync(file, garbage);
    mem.compare(lists(NEW, 'n'), [A]);
    assert.equal(mem.hint('a'), '', garbage);
    assert.deepEqual(logs, ['tool list file unreadable, starting over'], garbage);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { profiles: lists(NEW, 'n'), pending: {} }, garbage);
  }
});

test('a changed profile makes its native members pending; the file round-trips; told is persisted', () => {
  const { file, mem, again } = memory();
  mem.compare(lists(OLD, 'o'), [A, B, Q]);
  const second = again();
  second.compare(lists(NEW, 'n'), [A, B, Q]);
  assert.equal(second.hint('a'), toolHintText(['send_message 新增参数 fyi', '新增工具 get_task']));
  assert.equal(second.hint('b'), second.hint('a'));
  assert.equal(second.hint('q'), '', 'qoder profile unchanged');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).pending, { a: ['send_message 新增参数 fyi', '新增工具 get_task'], b: ['send_message 新增参数 fyi', '新增工具 get_task'] });
  second.told('a');
  assert.equal(second.hint('a'), '');
  // Third start, nothing changed: b is still pending, a stays told.
  const third = again();
  assert.equal(third.hint('b'), '', 'nothing before compare');
  third.compare(lists(NEW, 'n'), [A, B, Q]);
  assert.equal(third.hint('a'), '');
  assert.equal(third.hint('b'), toolHintText(['send_message 新增参数 fyi', '新增工具 get_task']));
});

test('a second change adds to the older pending changes; unknown ids are pruned; description-only changes', () => {
  const { file, mem, again } = memory();
  mem.compare(lists(OLD, 'o'), [A, B]);
  again().compare(lists(NEW, 'n'), [A, B]);
  // Fourth state: get_task gains a parameter; b has left the cluster.
  const changed = { ...NEW, get_task: ['taskId', 'verbose'] };
  const third = again();
  third.compare(lists(changed, 'n2'), [A]);
  assert.equal(third.hint('a'), toolHintText(['send_message 新增参数 fyi', '新增工具 get_task', 'get_task 新增参数 verbose']));
  assert.equal(third.hint('b'), '');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).pending), ['a']);
  // Same names and parameters, another fingerprint: only the descriptions changed.
  const fourth = again();
  fourth.compare(lists(changed, 'n3'), [A, B]);
  assert.equal(fourth.hint('b'), toolHintText([DESCRIPTIONS_ONLY]));
  assert.ok(fourth.hint('a').includes(`get_task 新增参数 verbose；${DESCRIPTIONS_ONLY}`));
});

test('a file that cannot be written is logged and never throws; told still holds in memory', () => {
  const { mem, logs } = memory(join(tempDir(), 'missing-dir', 'tool-list.json'));
  mem.compare(lists(NEW, 'n'), [A]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^tool list file not saved: /);
  const dir = tempDir();
  const ok = memory(join(dir, 'tool-list.json'));
  ok.mem.compare(lists(OLD, 'o'), [A]);
  ok.again().compare(lists(NEW, 'n'), [A]);   // pending in the file
  const m = ok.again();
  m.compare(lists(NEW, 'n'), [A]);
  assert.ok(m.hint('a'));
  // Break the file path from under it: told() cannot save but forgets the member in memory.
  (m as unknown as { file: string }).file = join(dir, 'gone', 'tool-list.json');
  m.told('a');
  assert.equal(m.hint('a'), '');
  assert.match(ok.logs.at(-1)!, /^tool list file not saved: /);
});

// ---- Hub level: a real Hub restarted over the same home, with the stored list made older by hand. ----

/** Mock A (s1) and C (s2, fails while state.failC), and "antigravity" G (g1, another profile). Returns the started Hub. */
async function startWith(dir: string, state: { failC: boolean }) {
  const sessions = ['s1', 's2', 'g1'].map((id) => ({ id, title: id, model: null, cwd: dir, updatedAt: null }));
  const native = createMockNativeAdapter({
    sessions,
    onDeliver: async (sessionId) => {
      if (sessionId === 's2' && state.failC) { state.failC = false; throw new Error('C failed once'); }
      return 'completed';
    },
  });
  const antigravity = createMockNativeAdapter({ harness: 'antigravity', sessions });
  const app = await startTestHub({ dir, nativeAdapters: { mock: native, antigravity } });
  return { app, native, antigravity };
}

const toolFile = (app: TestHub) => join(app.home, 'tool-list.json');
const readFile = (app: TestHub) => JSON.parse(readFileSync(toolFile(app), 'utf8'));

test('Hub: a pending native member is told once, again after a failed run, never in a direct message', async () => {
  const dir = tempDir();
  const state = { failC: false };
  let { app, native, antigravity } = await startWith(dir, state);
  let clusterId: string;
  let members: { id: string; name: string }[];
  try {
    // First start: no file before, so nobody is pending.
    await waitFor(() => existsSync(toolFile(app)), 'first comparison');
    ({ cluster: { id: clusterId }, members } = await app.api('POST', '/api/clusters', { name: 'tools', members: [
      { harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' },
      { harness: 'mock', mode: 'native', sessionId: 's2', name: 'C' },
      { harness: 'antigravity', mode: 'native', sessionId: 'g1', name: 'G' },
    ] }));
    await app.api('POST', `/api/clusters/${clusterId}/messages`, { body: '@all first' });
    await waitFor(() => app.settled(clusterId), 'first settled');
    for (const text of [...native.delivered, ...antigravity.delivered].map((d) => d.text)) assert.ok(!text.includes(HINT), text);
  } finally { await app.close(); }

  // Make the stored standard list older: send_message without fyi.
  const stored = JSON.parse(readFileSync(join(dir, 'home', 'tool-list.json'), 'utf8'));
  assert.deepEqual(stored.pending, {});
  stored.profiles.standard.fingerprint = 'sha256:old';
  stored.profiles.standard.tools.send_message = stored.profiles.standard.tools.send_message.filter((p: string) => p !== 'fyi');
  writeFileSync(join(dir, 'home', 'tool-list.json'), JSON.stringify(stored));

  ({ app, native, antigravity } = await startWith(dir, state));
  try {
    await waitFor(() => readFile(app).profiles.standard.fingerprint !== 'sha256:old', 'second comparison');
    const [a, c] = members!;
    assert.deepEqual(Object.keys(readFile(app).pending).sort(), [a.id, c.id].sort(), 'standard-profile members only');
    const send = async (body: string, to?: string[]) => {
      await app.api('POST', `/api/clusters/${clusterId}/messages`, { body, ...(to ? { to } : {}) });
      await waitFor(() => app.settled(clusterId), `settled after ${body}`);
    };
    const to = (session: string) => native.delivered.filter((d) => d.sessionId === session).map((d) => d.text);
    const line = 'send_message 新增参数 fyi。如果你的工具说明里没有这些';

    // A direct message carries no envelope and does not clear the hint.
    await send('direct one', [a.id]);
    assert.equal(to('s1').length, 1);
    assert.ok(!to('s1')[0].includes(HINT), to('s1')[0]);
    assert.ok(readFile(app).pending[a.id]);

    // C's run fails: the hint stays and comes again.
    state.failC = true;
    await send('@all second');
    assert.equal(count(to('s1')[1], HINT), 1, to('s1')[1]);
    assert.ok(to('s1')[1].includes(line), to('s1')[1]);
    assert.equal(count(to('s2')[0], HINT), 1, to('s2')[0]);
    assert.ok(!antigravity.delivered.at(-1)!.text.includes(HINT), 'another profile, unchanged');
    assert.deepEqual(Object.keys(readFile(app).pending), [c.id], 'A told after its done run; C not after its failed one');

    await send('@all third');
    assert.ok(!to('s1')[2].includes(HINT), 'told once');
    assert.equal(count(to('s2')[1], HINT), 1, 'again after the failed run');
    assert.deepEqual(readFile(app).pending, {});

    await send('@all fourth');
    assert.ok(!to('s2')[2].includes(HINT));
  } finally { await app.close(); }
});

test('Hub: members are taken at start-up; one added or removed while the lists are computed is not pending', async () => {
  const dir = tempDir();
  const state = { failC: false };
  let { app, native } = await startWith(dir, state);
  let clusterId: string;
  let a: { id: string };
  let gone: { id: string };
  try {
    await waitFor(() => existsSync(toolFile(app)), 'first comparison');
    ({ cluster: { id: clusterId }, members: [a, gone] } = await app.api('POST', '/api/clusters', { name: 'late',
      members: [{ harness: 'mock', mode: 'native', sessionId: 's1', name: 'A' }, { harness: 'mock', mode: 'native', sessionId: 'g1', name: 'Gone' }] }));
  } finally { await app.close(); }
  const file = join(dir, 'home', 'tool-list.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.profiles.standard.fingerprint = 'sha256:old';
  writeFileSync(file, JSON.stringify(stored));

  // Hold every tools/list until a member has been added after the start.
  const gate = Promise.withResolvers<void>();
  const listTools = Client.prototype.listTools;
  Client.prototype.listTools = async function (this: Client, ...args: Parameters<Client['listTools']>) {
    await gate.promise;
    return listTools.apply(this, args);
  };
  try {
    ({ app, native } = await startWith(dir, state));
    const { members: [late] } = await app.api('POST', `/api/clusters/${clusterId!}/members`,
      { members: [{ harness: 'mock', mode: 'native', sessionId: 's2', name: 'Late' }] });
    await app.api('DELETE', `/api/clusters/${clusterId!}/members/${gone!.id}`);
    gate.resolve();
    await waitFor(() => readFile(app).profiles.standard.fingerprint !== 'sha256:old', 'comparison after release');
    assert.deepEqual(Object.keys(readFile(app).pending), [a!.id], 'only a member that existed at start-up and still does');
    await app.api('POST', `/api/clusters/${clusterId!}/messages`, { body: '@all after' });
    await waitFor(() => app.settled(clusterId), 'settled');
    const to = (session: string) => native.delivered.filter((d) => d.sessionId === session).map((d) => d.text);
    assert.equal(count(to('s1')[0], HINT), 1, to('s1')[0]);
    assert.ok(!to('s2')[0].includes(HINT), to('s2')[0]);
    assert.ok(late.id);
  } finally {
    Client.prototype.listTools = listTools;
    gate.resolve();
    await app.close();
  }
});
