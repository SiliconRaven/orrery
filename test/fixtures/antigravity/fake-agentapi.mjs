// Stand-in for Antigravity's agentapi in test/antigravity-native.test.ts: run as `node fake-agentapi.mjs agentapi …`.
// Appends its arguments as one JSON line to $FAKE_AGENTAPI_LOG. A text containing "please fail" fails with exit code 3
// and a stderr line that includes $ANTIGRAVITY_CSRF_TOKEN, so the test can check the sidecar scrubs it. With
// "straddle" in it, the token sits across the point where the sidecar cuts stderr to its last 500 characters.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AGENTAPI_LOG, JSON.stringify(args) + '\n');
if (String(args.at(-1)).includes('please fail')) {
  const token = process.env.ANTIGRAVITY_CSRF_TOKEN;
  process.stderr.write(String(args.at(-1)).includes('straddle')
    ? `${'A'.repeat(1000)}${token}${'B'.repeat(505 - token.length)}`
    : `conversation busy (csrf ${token})\n`);
  process.exit(3);
}
process.stdout.write('{"ok":true}\n');
