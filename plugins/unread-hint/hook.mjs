// A standalone hook: it reads only the caller input and the local Hub discovery file.
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

async function ask(url, secret, session) {
  const agent = new Agent({ keepAlive: false });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      agent.destroy();
      resolve(value);
    };
    // Use the literal loopback address even when discovery says localhost.
    const req = request({ hostname: '127.0.0.1', port: url.port, path: '/bridge/unread-hint', method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'x-orrery-bridge': secret } }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { res.resume(); finish(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', () => finish(null));
      res.on('end', () => {
        try {
          const hint = JSON.parse(body)?.hint;
          finish(typeof hint === 'string' && hint && !/[\r\n]/.test(hint) ? hint : null);
        } catch { finish(null); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(null); }, 500);
    req.on('error', () => finish(null));
    req.end(JSON.stringify({ harness, session }));
  });
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
  const home = process.env.ORRERY_HOME || join(homedir(), '.orrery');
  const discovery = JSON.parse(await readFile(join(home, 'hub.json'), 'utf8'));
  if (typeof discovery?.url !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(discovery.url)
    || typeof discovery.secret !== 'string' || !discovery.secret) return;
  const url = new URL(discovery.url);
  const hint = await ask(url, discovery.secret, session);
  if (hint) { process.stdout.write(JSON.stringify(profile.output(hint))); wroteHint = true; }
}

try { await main(); } catch { /* Missing, invalid, or unavailable Hub is a silent no-op. */ }
if (harness === 'antigravity' && !wroteHint) process.stdout.write('{}');
