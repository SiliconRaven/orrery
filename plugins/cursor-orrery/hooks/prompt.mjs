// Cursor's beforeSubmitPrompt hook (docs/adapters/cursor.md, "送达确认"). Reports the start of every turn to the Hub:
// the Hub ends the conversation's older parked stop hooks, and an orrery delivery is confirmed by the 8-hex hand-over id
// on the prompt's first line. Only that id leaves this hook, never the prompt. Always lets the prompt through.
import { answer, findHub, id, post, readInput } from '../lib/hub.mjs';

const HANDOUT = /^\[orrery\b[^\]\r\n]*· #([0-9a-f]{8})\]/;

async function main() {
  const input = await readInput();
  const sessionId = id(input.conversation_id);
  const hub = sessionId ? findHub() : null;
  if (hub) {
    const first = typeof input.prompt === 'string' ? input.prompt.slice(0, 1000).split(/\r?\n/, 1)[0] : '';
    const handout = HANDOUT.exec(first)?.[1];
    const report = { sessionId, event: 'start', generationId: id(input.generation_id) ?? 'unknown', ...(handout ? { handout } : {}) };
    try { await post(hub, '/bridge/cursor-turn', report, { timeoutMs: 3000 }); } catch { /* no Hub: nothing to tell */ }
  }
  await answer({ continue: true });
}

main().then(() => process.exit(0), () => process.stdout.write(JSON.stringify({ continue: true }), () => process.exit(0)));
