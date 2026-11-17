// Standalone example: copy the directory. Only Node built-ins are needed.
import { createInterface } from 'node:readline';

const REMINDER_DELAY_MS = 5 * 60_000;
const TASK_EVENTS = new Set(['task.submitted', 'task.approved', 'task.rejected', 'task.merged']);
const reminders = new Map();
const input = createInterface({ input: process.stdin });
let writableClusters = new Set();
let serial = 0;

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

function clearReminders() {
  for (const timer of reminders.values()) clearTimeout(timer);
  reminders.clear();
}

function handleEvent({ type, data, dropped } = {}) {
  // The loss counter cannot name the affected group or task.
  if (dropped > 0) clearReminders();
  if (!TASK_EVENTS.has(type) || !writableClusters.has(data?.clusterId) || typeof data.taskId !== 'string') return;

  const { clusterId, taskId, status } = data;
  const key = JSON.stringify([clusterId, taskId]);
  clearTimeout(reminders.get(key));
  reminders.delete(key);
  if (type !== 'task.submitted' || status !== 'review') return;

  const title = typeof data.title === 'string' ? data.title.replace(/\s+/g, ' ').trim() : '';
  const label = title ? `任务「${title}」` : '任务';
  reminders.set(key, setTimeout(() => {
    reminders.delete(key);
    send({ id: `reminder-${++serial}`, method: 'host.messages.send', params: {
      clusterId, body: `${label}提交后仍未收到验收结果。可在任务工作台查看 #${taskId}。`,
    } });
  }, REMINDER_DELAY_MS));
}

input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch {
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  if (message.method === 'initialize' && message.params?.apiVersion === 1) {
    if (message.params.permissions?.includes('messages.send')) writableClusters = new Set(message.params.writeClusterIds ?? []);
    send({ id: message.id, result: { apiVersion: 1 } });
  } else if (message.method === 'event') {
    handleEvent(message.params);
  } else if (message.method === 'shutdown') {
    clearReminders();
    send({ id: message.id, result: {} });
    process.stdin.destroy();
  } else if (message.method && typeof message.id === 'string') {
    send({ id: message.id, error: { code: -32601, message: 'method not supported' } });
  } else if (message.error && typeof message.id === 'string' && message.id.startsWith('reminder-')) {
    // A rejected send is final. Never retry a reminder whose result could be unknown.
    process.stderr.write('Orrery declined a review reminder.\n');
  }
});
input.on('close', clearReminders);
