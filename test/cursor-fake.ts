// A fake Cursor for loop-guard tests (hop-limit.test.ts, chain-limit.test.ts): a native Cursor member whose "hooks" speak
// the real HTTP protocol of docs/adapters/cursor.md (park, ack, turn start with the hand-over id, turn end), and whose
// "model" answers every `ping <x>` it is handed with `@<to> ping <x>` through the Hub's /mcp, as the postToolUse hook
// would. No Cursor, no files of Cursor's, no model.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCursorNativeAdapter } from '../src/adapters/cursor/native.ts';
import { tempDir } from './helpers.ts';

/** A Cursor adapter over a fake ~/.cursor holding a transcript for each session id (so they can be attached). */
export function fakeCursorAdapter(sessionIds: string[]) {
  const home = tempDir();
  for (const id of sessionIds) {
    const dir = join(home, 'projects', 'c-work', 'agent-transcripts', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ role: 'user', message: { content: 'hi' } })}\n`);
  }
  return createCursorNativeAdapter({ cursorHome: home, cursorData: home, cursorRunning: async () => true, times: { reparkMs: 300, pollMs: 10 } });
}

/** One park: resolves with the batch, or null when the Hub ended or dropped the park. close() hangs up. */
function parkOnce(url: string, secret: string, session: string) {
  let req!: ReturnType<typeof request>;
  const done = new Promise<{ deliveryId: string; text: string } | null>((ok) => {
    req = request(`${url}/bridge/cursor-park?session=${session}&since=${Date.now()}`, { headers: { 'x-orrery-bridge': secret } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        const m = /event: deliver\ndata: (.*)\n\n/.exec(buf);
        if (m) ok(JSON.parse(m[1]));
        else if (buf.includes('event: end')) ok(null);
      });
      res.on('close', () => ok(null));
    });
    req.on('error', () => ok(null));
    req.end();
  });
  return { done, close: () => req.destroy() };
}

const post = (url: string, secret: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(url + path, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-orrery-bridge': secret, ...headers },
}).then((r) => r.json());

/** Runs the fake Cursor conversation `session` against the Hub in `home`; it answers pings to `answerTo`. */
export function fakeCursor(app: { url: string; home: string }, session: string, answerTo: string) {
  const secret = JSON.parse(readFileSync(join(app.home, 'hub.json'), 'utf8')).secret as string;
  let stopped = false;
  let current: ReturnType<typeof parkOnce> | null = null;
  let turns = 0;
  const loop = (async () => {
    while (!stopped) {
      current = parkOnce(app.url, secret, session);
      const batch = await current.done;
      if (stopped) break;
      if (!batch) { await sleep(20); continue; }
      await post(app.url, secret, '/bridge/ack', { deliveryId: batch.deliveryId, ok: true });
      const generationId = `g${++turns}`;
      const handout = /· #([0-9a-f]{8})\]$/.exec(batch.text.split('\n')[0])?.[1];
      await post(app.url, secret, '/bridge/cursor-turn', { sessionId: session, event: 'start', generationId, ...(handout ? { handout } : {}) });
      const ping = /\bping (\S+)/.exec(batch.text);
      if (ping) {
        await post(app.url, secret, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body: `@${answerTo} ping ${ping[1]}` } } },
          { 'x-orrery-session': session, 'x-orrery-harness': 'cursor' });
      }
      await post(app.url, secret, '/bridge/cursor-turn', { sessionId: session, event: 'end', generationId, status: 'completed' });
    }
  })();
  return { stop: async () => { stopped = true; current?.close(); await loop; } };
}
