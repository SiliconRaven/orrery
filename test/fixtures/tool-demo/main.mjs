// Test fixture, not shipped: a third-party plugin that provides two tools to members (docs/external-plugins.md「群员工具」).
// `echo` answers at once with its arguments; `slow` (and any other tool) answers after `ms` milliseconds without
// blocking, so the plugin keeps answering message checks meanwhile (it is also a gate: a message containing "forbidden"
// is refused). The test probes are commands only the HTTP route runs: `mode` sets how `echo` behaves and how long a
// check waits, `calls` returns what the plugin was sent and the events it got, `hold` answers after `ms` milliseconds.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const calls = [];
const events = [];
let checks = 0;
let mode = 'normal';
let checkDelay = 0;   // how long a message check waits before it answers (set with `mode`)

function echo(id, args) {
  switch (mode) {
    case 'error': return send({ id, error: { code: -32000, message: 'lookup\u0007 service is down\nplease retry' } });
    case 'malformed': return send({ id, result: 42 });
    case 'big': return send({ id, result: { text: 'x'.repeat(20_000) } });
    case 'hang': return undefined;
    case 'crash': return process.exit(3);
    case 'data': return send({ id, result: { data: { echoed: args.text, n: 1 } } });
    case 'control': return send({ id, result: { text: `bell\u0007 and\u001b[31m escape\nsecond line` } });
    default: {
      const text = Array.from({ length: args.times ?? 1 }, () => args.text).join(' ');
      return send({ id, result: { text: args.loud ? text.toUpperCase() : text, data: { length: text.length } } });
    }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'event') { events.push(m.params); return; }
  if (m.method === 'initialize') return send({ id: m.id, result: { apiVersion: 1 } });
  if (m.method === 'shutdown') return send({ id: m.id, result: {} });
  if (m.method === 'invoke' && m.params.command === 'mode') {
    mode = m.params.arguments?.mode ?? 'normal';
    checkDelay = m.params.arguments?.checkDelay ?? 0;
    return send({ id: m.id, result: { mode } });
  }
  if (m.method === 'invoke' && m.params.command === 'calls') return send({ id: m.id, result: { calls, checks, events } });
  if (m.method === 'invoke' && m.params.command === 'hold') {
    return setTimeout(() => send({ id: m.id, result: { held: true } }), m.params.arguments?.ms ?? 0);
  }
  if (m.method === 'message.check') {
    checks++;
    const refuse = String(m.params.body ?? '').includes('forbidden');
    return setTimeout(() => send({ id: m.id, result: refuse ? { allow: false, reason: 'no forbidden words' } : { allow: true } }), checkDelay);
  }
  if (m.method === 'tool.call') {
    calls.push(m.params);
    const { tool, arguments: args } = m.params;
    if (tool !== 'echo') return setTimeout(() => send({ id: m.id, result: { text: `waited ${args.ms} ms${args.note ? ` ${args.note}` : ''}` } }), args.ms);
    return echo(m.id, args);
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
});
