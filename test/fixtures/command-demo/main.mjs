// A test plugin for user-run commands (docs/external-plugins.md「命令」): a quick command with every parameter type, a
// long-running one that reports progress and its end, and a probe (`debug`, not offered in clusters) the tests drive.
// Not shipped. An optional options.json beside it: {"optIn": false} leaves command.cancel unrequested.
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const options = existsSync(new URL('./options.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('./options.json', import.meta.url), 'utf8')) : {};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const seen = { invokes: [], cancels: [], unknown: [] };
const runs = new Map();   // runId -> { mode, timers }
const pending = new Map();
let serial = 0;

function startSession(runId, args) {
  const run = { mode: args.mode, timers: [] };
  runs.set(runId, run);
  const later = (ms, fn) => run.timers.push(setTimeout(fn, ms));
  if (args.mode === 'silent' || args.mode === 'ignore-cancel') return;
  if (args.mode === 'exit') return later(30, () => process.exit(3));
  for (let i = 1; i <= args.ticks; i++) later(i * args.tickMs, () => send({ method: 'command.progress', params: { runId, text: `第 ${i} 步`, fraction: i / (args.ticks + 1) } }));
  later((args.ticks + 1) * args.tickMs, () => {
    runs.delete(runId);
    if (args.mode === 'fail') return send({ method: 'command.done', params: { runId, ok: false, text: '环节出错了' } });
    send({ method: 'command.done', params: { runId, ok: true, text: `环节结束，共 ${args.ticks} 步`, data: { ticks: args.ticks } } });
    if (args.mode === 'after-done') {
      send({ method: 'command.progress', params: { runId, text: '迟到的进度' } });
      send({ method: 'command.done', params: { runId, ok: false, text: '迟到的结束' } });
    }
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.method) {   // an answer to the probe's host call
    const id = pending.get(m.id);
    pending.delete(m.id);
    return send({ id, result: m });
  }
  if (m.method === 'initialize') return send({ id: m.id, result: { apiVersion: 1, ...(options.optIn === false ? {} : { notifications: ['command.cancel'] }) } });
  if (m.method === 'shutdown') return send({ id: m.id, result: {} });
  if (m.method === 'command.cancel') {
    seen.cancels.push(m.params);
    const run = runs.get(m.params.runId);
    if (run && run.mode !== 'ignore-cancel') {
      run.timers.forEach(clearTimeout);
      runs.delete(m.params.runId);
      send({ method: 'command.done', params: { runId: m.params.runId, ok: false, text: '已按要求停止' } });
    }
    return;
  }
  if (!m.id) return seen.unknown.push(m.method);
  if (m.method !== 'invoke') return send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  const { command, arguments: args, context } = m.params;
  seen.invokes.push(m.params);
  if (command === 'greet') {
    const word = args.mood === 'happy' ? '你好呀' : '你好';
    return send({ id: m.id, result: { text: `${word}，${args.name}`.repeat(args.times) + (args.loud ? '！' : ''), echo: { arguments: args, context } } });
  }
  if (command === 'session') {
    if (args.mode === 'same-chunk') {   // the answer and a newer progress in one write: the progress must win
      process.stdout.write([{ id: m.id, result: { accepted: true, text: 'A' } }, { method: 'command.progress', params: { runId: context.runId, text: 'B' } }]
        .map((x) => JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n').join(''));
      runs.set(context.runId, { mode: 'silent', timers: [] });
      return;
    }
    send({ id: m.id, result: { accepted: true, text: '已开始' } });
    return startSession(context.runId, args);
  }
  // An old command (not longRunning) whose ordinary result happens to say accepted: it is still its final result.
  if (command === 'count') return send({ id: m.id, result: { old: true, accepted: true, arguments: args, hasContext: context !== undefined } });
  if (command === 'debug') {
    if (args.action === 'seen') return send({ id: m.id, result: seen });
    if (args.action === 'notify') { send({ method: args.method, params: args.params }); return send({ id: m.id, result: {} }); }
    if (args.action === 'host') {
      const id = `p-${++serial}`;
      pending.set(id, m.id);
      return send({ id, method: args.method, params: args.params });
    }
  }
  send({ id: m.id, error: { code: -32000, message: 'unknown command' } });
});
