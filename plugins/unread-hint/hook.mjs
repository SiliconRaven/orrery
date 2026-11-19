// A standalone hook: it reads only the caller input and, through ./hub-discovery.mjs (a byte-identical copy of orrery's
// plugins/shared/hub-discovery.mjs), the account's Hub registry. The request is signed (x-orrery-sig), never carrying
// the key; a missing or invalid registry record means no request. Every failure is silent.
import { hubFetch } from './hub-discovery.mjs';

const profiles = {
  claude: { session: 'session_id', subagents: true, output: (hint) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint } }) },
  codex: { session: 'session_id', subagents: true, output: (hint) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint } }) },
  antigravity: { session: 'conversationId', output: (hint) => ({ injectSteps: [{ ephemeralMessage: hint }] }) },
  zcode: { session: 'session_id', output: (hint) => ({ additionalContext: hint }) },
};
const harness = process.argv[2];
const profile = Object.hasOwn(profiles, harness) ? profiles[harness] : null;
let wroteHint = false;
process.stdout.on('error', () => {}); // A closed output pipe must never make a hook fail.

async function ask(session) {
  // 500 ms for the whole exchange: a slow Hub must not hold up the tool result. Silent: no stderr even for the
  // explicit legacy fallback, because some hosts show a hook's stderr to the user.
  const { status, text } = await hubFetch('POST', '/bridge/unread-hint', { timeoutMs: 500, log: () => {},
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness, session }) });
  if (status < 200 || status >= 300) return null;
  const hint = JSON.parse(text)?.hint;
  return typeof hint === 'string' && hint && !/[\r\n]/.test(hint) ? hint : null;
}

async function main() {
  if (!profile) return;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (profile.subagents && input.agent_id !== undefined && input.agent_id !== null) return;
  const session = input[profile.session];
  if (typeof session !== 'string' || !session) return;
  const hint = await ask(session);
  if (hint) { process.stdout.write(JSON.stringify(profile.output(hint))); wroteHint = true; }
}

try { await main(); } catch { /* No registry record, a refusal or an unavailable Hub is a silent no-op. */ }
if (harness === 'antigravity' && !wroteHint) process.stdout.write('{}');
// The module's shared HTTP agent may keep a socket open after a timeout: leave once the answer is written.
process.stdout.write('', () => process.exit(0));
