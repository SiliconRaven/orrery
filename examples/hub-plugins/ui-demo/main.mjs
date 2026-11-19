// Standalone: copy this whole directory anywhere. No Orrery source imports or npm dependencies.
// One counter per cluster, kept in memory. The page (ui/) asks for it and adds one with `ui.request`; after each change
// the plugin pushes the new value to every open frame of that cluster (`host.ui.push`), shows it on its title bar
// chip (`host.ui.chip`) and, where `marks` is granted, puts small marks (`host.ui.mark`) on the first three members,
// the latest message and the task it last heard of (task events). Whatever is not granted is refused and skipped.
import { createInterface } from 'node:readline';

const pending = new Map();
const counts = new Map();
const lastMessage = new Map();   // cluster → the message this plugin marked last (cleared when a newer one is marked)
const lastTask = new Map();      // cluster → the task id of the latest task event
let serial = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const call = (method, params) => new Promise((resolve, reject) => {
  const id = `plugin-${++serial}`;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('host timeout')); }, 3000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});

/**
 * The count as marks: a mark per target, one line of text and a state, and a tip shown when the user hovers or focuses
 * it. Orrery draws them; the plugin gives data only. Each call is checked on its own (a refusal skips that mark).
 */
async function showMarks(clusterId, count) {
  const tip = `界面示例插件：本群计数 ${count}`;
  const mark = (target, targetId, text, state) => call('host.ui.mark', { clusterId, target, targetId, text, state, tip }).catch(() => {});
  try {
    const { members } = await call('host.members.list', { clusterId });
    for (const member of members.slice(0, 3)) await mark('member', member.id, `计数 ${count}`, 'info');
  } catch { /* clusters.read not granted */ }
  try {
    const { messages } = await call('host.messages.list', { clusterId, limit: 1 });
    const latest = messages.at(-1)?.id;
    const before = lastMessage.get(clusterId);
    if (before && before !== latest) await call('host.ui.mark', { clusterId, target: 'message', targetId: before, text: null }).catch(() => {});
    if (latest) {
      lastMessage.set(clusterId, latest);
      await mark('message', latest, `第 ${count} 次`, count % 5 === 0 ? 'done' : 'running');
    }
  } catch { /* messages.read not granted */ }
  const task = lastTask.get(clusterId);
  if (task) await mark('task', task, `计数 ${count}`, 'done');
}

async function handle(message) {
  if (!message.method) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.data?.code ?? 'host request denied'));
    else request.resolve(message.result);
    return;
  }
  if (message.method === 'initialize') {
    if (message.params.apiVersion !== 1) throw new Error('unsupported API');
    send({ id: message.id, result: { apiVersion: 1 } });
  } else if (message.method === 'ui.request') {
    // The Hub says which cluster and position the frame is in; the page cannot claim another.
    const { clusterId, data } = message.params;
    if (data?.action === 'get') {
      send({ id: message.id, result: { count: counts.get(clusterId) ?? 0 } });
    } else if (data?.action === 'add') {
      const count = (counts.get(clusterId) ?? 0) + 1;
      counts.set(clusterId, count);
      send({ id: message.id, result: { count } });
      // Every frame of this cluster (both positions, every open page) gets the new value. A refused push (a rate limit,
      // say) changes nothing for the request already answered.
      call('host.ui.push', { clusterId, data: { count } })
        .then(() => call('host.ui.chip', { clusterId, text: `计数 ${count}`, state: count % 5 === 0 ? 'done' : 'running' }))
        .catch(() => {})
        .then(() => showMarks(clusterId, count));
    } else {
      send({ id: message.id, error: { code: -32000, message: 'unknown action' } });
    }
  } else if (message.method === 'event') {
    // A notification (no id, no answer): remember the latest task of each cluster to mark it on the next change.
    const { type, clusterId, data } = message.params ?? {};
    if (typeof data?.taskId !== 'string' || !clusterId) return;
    if (type === 'task.deleted') { if (lastTask.get(clusterId) === data.taskId) lastTask.delete(clusterId); } else lastTask.set(clusterId, data.taskId);
  } else if (message.method === 'shutdown') {
    send({ id: message.id, result: {} });
    process.stdin.destroy();
  } else throw new Error('unknown method');
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 1; process.stdin.destroy(); return; }
  void handle(message).catch(() => { if (message.id) send({ id: message.id, error: { code: -32000, message: 'failed' } }); });
});
process.stdin.on('end', () => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('host closed')); }
  pending.clear();
});
