// For the real-device check only (docs/adapters/antigravity.md, "真机实验" 7): a PreToolUse hook that records the
// shape of what Antigravity sends, not its content. It appends one line per call to hook-payloads.jsonl next to this
// file: the tool name, plus every key of the payload with only the type of its value (strings as their length; a
// string holding a JSON object as that object's shape). Message bodies, the user's last input, ids and signatures are
// never written. It answers {"decision":"ask"}, so it changes nothing about the call. Remove it from hooks.json after
// the check. Node built-ins only.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The value with every leaf replaced by its type; strings become "string(<length>)". */
export function shape(v, depth = 0) {
  if (depth > 8) return 'deep';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  if (typeof v === 'string') {
    if (v.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(v);
        if (typeof parsed === 'object' && parsed !== null) return { jsonString: shape(parsed, depth + 1) };
      } catch { /* plain text */ }
    }
    return `string(${v.length})`;
  }
  return v === null ? 'null' : typeof v;
}

/** One line for a raw stdin payload: the tool name (needed to set the matcher) and the payload's shape. */
export function record(input) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return { unparsable: `string(${input.length})` };
  }
  const name = payload?.toolCall?.name;
  return { toolName: typeof name === 'string' ? name.slice(0, 100) : null, shape: shape(payload) };
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hook-payloads.jsonl'), `${JSON.stringify(record(input))}\n`);
  process.stdout.write('{"decision":"ask"}');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
