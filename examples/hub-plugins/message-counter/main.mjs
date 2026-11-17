// Standalone: copy this whole directory anywhere. No Orrery source imports or npm dependencies.
import { createInterface } from 'node:readline';

const pending = new Map();
let serial = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const call = (method, params) => new Promise((resolve, reject) => {
  const id = `plugin-${++serial}`;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('host timeout')); }, 3000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});

async function handle(message) {
  if (!message.method) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error('host request denied'));
    else request.resolve(message.result);
    return;
  }
  if (message.method === 'initialize') {
    if (message.params.apiVersion !== 1) throw new Error('unsupported API');
    send({ id: message.id, result: { apiVersion: 1 } });
  } else if (message.method === 'invoke' && message.params.command === 'count') {
    const clusterId = message.params.arguments.clusterId;
    const { clusters } = await call('host.clusters.list', {});
    if (!clusters.some((cluster) => cluster.id === clusterId)) throw new Error('cluster not granted');
    const { messages, truncated } = await call('host.messages.list', { clusterId, limit: 100 });
    const counts = new Map();
    for (const message of messages) counts.set(message.from, (counts.get(message.from) ?? 0) + 1);
    send({ id: message.id, result: { clusterId, recentMessageCount: messages.length, limit: 100,
      senders: [...counts].map(([senderId, count]) => ({ senderId, count })), ...(truncated ? { truncated: true } : {}) } });
  } else if (message.method === 'shutdown') {
    send({ id: message.id, result: {} });
    process.stdin.destroy();
  } else throw new Error('unknown method');
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 1; process.stdin.destroy(); return; }
  void handle(message).catch(() => send({ id: message.id, error: { code: -32000, message: 'command failed' } }));
});
process.stdin.on('end', () => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('host closed')); }
  pending.clear();
});
