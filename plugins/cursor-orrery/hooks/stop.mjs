// Cursor's stop hook (docs/adapters/cursor.md, "原理"). Reports the end of the turn to the Hub; for a conversation that is
// an orrery member it then parks at the Hub (GET /bridge/cursor-park) until a batch comes, prints it as
// {"followup_message": ...} (Cursor submits that as the next user message), acks it and exits. Otherwise it prints {}.
// Sent to the Hub: conversation_id, generation_id, status, the four token counts and cursor_version, nothing else.
// While parked: the Hub restarting only drops the stream, the hook reconnects every 2 s; it ends by itself shortly
// before Cursor's timeout for it (hooks.json: 86400 s); when its parent process (on Windows the PowerShell that Cursor runs
// hooks in) is gone it exits without printing.
import { answer, findHub, id, post, readInput, stream, warn } from '../lib/hub.mjs';

const started = Date.now();   // `since`: a newer park of the same conversation wins
// Test knobs (orrery's own variables); Cursor never sets them.
const PARK_MS = Number(process.env.ORRERY_CURSOR_PARK_MS) || (86_400 - 60) * 1000;
const PARENT_MS = Number(process.env.ORRERY_CURSOR_PARENT_MS) || 5000;
const RETRY_MS = Number(process.env.ORRERY_CURSOR_RETRY_MS) || 2000;
const STATUSES = new Set(['completed', 'aborted', 'error']);
const VERSION_RE = /^[\w.+-]{1,40}$/;

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Cursor gone: leave quietly, there is nobody to answer.
const parent = setInterval(() => {
  try { process.kill(process.ppid, 0); } catch (e) { if (e?.code === 'ESRCH') process.exit(0); }
}, PARENT_MS);
parent.unref();

async function main() {
  const input = await readInput();
  const sessionId = id(input.conversation_id);
  if (!sessionId) return answer({});
  const report = {
    sessionId, event: 'end', generationId: id(input.generation_id) ?? 'unknown',
    ...(STATUSES.has(input.status) ? { status: input.status } : {}),
    usage: { input: count(input.input_tokens), output: count(input.output_tokens), cacheRead: count(input.cache_read_tokens), cacheWrite: count(input.cache_write_tokens) },
  };
  let hub = await findHub();
  if (!hub) return answer({});
  try {
    const r = await post(hub, '/bridge/cursor-turn', report);
    if (r.status !== 200 || r.body?.park !== true) return answer({});
  } catch {
    return answer({});   // no Hub: do not park
  }
  const version = typeof input.cursor_version === 'string' && VERSION_RE.test(input.cursor_version) ? input.cursor_version : null;
  const path = `/bridge/cursor-park?session=${encodeURIComponent(sessionId)}&since=${started}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
  const deadline = started + PARK_MS;
  while (Date.now() < deadline) {
    if (hub) {
      let got = null;
      const s = stream(hub, path, (event, data) => {
        if (got) return;
        if (event === 'deliver' && typeof data?.deliveryId === 'string' && typeof data?.text === 'string') got = { deliver: data };
        else if (event === 'end') got = { end: true };
        if (got) s.close();
      });
      const left = setTimeout(() => s.close(), Math.max(0, deadline - Date.now()));
      const how = await s.done;
      clearTimeout(left);
      if (got?.deliver) {
        await answer({ followup_message: got.deliver.text });
        try { await post(hub, '/bridge/ack', { deliveryId: got.deliver.deliveryId, ok: true }); } catch { warn('could not confirm a delivery to the Hub'); }
        return;
      }
      if (got?.end || how === 'refused') return answer({});
    }
    // Dropped (the Hub restarted or stopped): try again, maybe a new Hub with a new port or secret.
    await sleep(Math.min(RETRY_MS, Math.max(0, deadline - Date.now())));
    hub = await findHub();
  }
  return answer({});
}

main().then(() => process.exit(0), () => { warn('stop hook failed'); process.stdout.write('{}', () => process.exit(0)); });
