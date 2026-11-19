// Test fixture, not shipped: a third-party plugin with its own web UI (docs/external-plugins.md「网页界面」). It answers
// `ui.request` by `data.action`: echo (default), fail, sleep (data.ms), failLater (an error after data.ms), big (a 20 KiB
// answer); every request is kept.
// Test probes are commands only the HTTP route runs: `requests` returns what the plugin was sent, `raw` makes one Hub
// call ({method, params}) and returns its result or refusal code (host.ui.push, host.ui.chip, host.ui.mark).
import { createInterface } from 'node:readline';

// The protocol allows at most 200 output frames in a one-second window (the Hub's own fixed windows). Every frame's send
// time is logged here, and a Hub call (bursts, one or several in a row, or many `raw` invokes) waits while 150 frames
// went out in the last 1.1 s. That holds for any 1.1 s stretch, so for every Hub window however the two clocks line up;
// the extra 0.1 s and the 50 spare frames cover transport jitter and the answers to calls already in flight.
const SLIDE_MS = 1100;
const sentAt = [];
const send = (m) => { sentAt.push(Date.now()); process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`); };
const requests = [];
const waiting = new Map();
let serial = 0;

async function hostCall(method, params) {
  for (;;) {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] >= SLIDE_MS) sentAt.shift();
    if (sentAt.length < 150) break;
    await new Promise((resolve) => setTimeout(resolve, sentAt[0] + SLIDE_MS - now));
  }
  const id = `probe-${++serial}`;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) {
    const done = waiting.get(m.id);
    waiting.delete(m.id);
    done?.(m.error ? { error: m.error.data?.code ?? 'ERROR' } : { result: m.result });
    return;
  }
  if (m.method === 'initialize') return send({ id: m.id, result: { apiVersion: 1 } });
  if (m.method === 'shutdown') return send({ id: m.id, result: {} });
  if (m.method === 'invoke' && m.params.command === 'requests') return send({ id: m.id, result: { requests } });
  if (m.method === 'invoke' && m.params.command === 'raw') {
    const { method, params } = m.params.arguments;
    return void hostCall(method, params).then((answer) => send({ id: m.id, result: answer }));
  }
  // The same call up to `times` times in a row (or one call per entry of `paramsList`), stopping at the first refusal:
  // one invoke instead of one per call, so a test of a per-minute budget stays far below the protocol's 200 output frames
  // a second (two frames per invoke); hostCall paces long runs.
  if (m.method === 'invoke' && m.params.command === 'burst') {
    const { method, params, times, paramsList } = m.params.arguments;
    const total = Array.isArray(paramsList) ? paramsList.length : times;
    return void (async () => {
      let sent = 0;
      for (; sent < total; sent++) {
        const answer = await hostCall(method, Array.isArray(paramsList) ? paramsList[sent] : params);
        if (answer.error) return send({ id: m.id, result: { sent, error: answer.error } });
      }
      send({ id: m.id, result: { sent } });
    })();
  }
  if (m.method === 'ui.request') {
    requests.push(m.params);
    const data = m.params.data ?? {};
    switch (data.action) {
      case 'fail': return send({ id: m.id, error: { code: -32000, message: 'probe\u0007 failure\nsecond line' } });
      case 'sleep': return setTimeout(() => send({ id: m.id, result: { slept: data.ms } }), data.ms);
      case 'failLater': return setTimeout(() => send({ id: m.id, error: { code: -32000, message: 'late probe failure' } }), data.ms);
      case 'big': return send({ id: m.id, result: { text: 'x'.repeat(20_000) } });
      default: return send({ id: m.id, result: { echo: data, position: m.params.position, clusterId: m.params.clusterId } });
    }
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
});
