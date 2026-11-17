// Free live check of the Claude quota (not part of `npm test`): `node test/live/claude-usage.ts`.
// Runs the Hub's own native Claude adapter (the registry entry, so the same command, environment and parsing) once
// with the user's own CLI and login: a short-lived `claude -p` answers get_usage with no prompt and no model call.
// Prints only window ids, percentages and the plan's length. Rerun after every Claude Code upgrade (docs/usage.md).
import { nativeFactories } from '../../src/adapters/index.ts';

const snap = await nativeFactories.claude().quota!({ refresh: true });
if (!snap) throw new Error('get_usage answered, but with no window');
console.log(`source ${snap.source}, plan length ${snap.plan?.length ?? 0}`);
for (const w of snap.windows) console.log(`${w.id}: ${w.usedPercent}%, reset known: ${w.resetsAt !== null}`);
