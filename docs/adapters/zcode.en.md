# ZCode Adapter (Native Mode)

Language: [中文](zcode.md) | **English**

The ZCode adapter integrates conversations inside ZCode Desktop (aligned with 3.17.2 / agent CLI 0.17.1) via user-configured MCP and the background wait command (`wait.mjs`). See [Unread Hint Hook](unread-hook.en.md#zcode) for optional post-tool hints.

## Mechanism: Shared Wait Core & Background Command

ZCode wakes an active or idle conversation whenever a Bash command started with `run_in_background: true` exits, feeding its output file to the model:

1. **Deterministic signed command**: Calling `wait_for_messages` validates runtime `_meta` in `src/mcp/wait-core.ts` and returns:
   `node "<orrery>/plugins/zcode-orrery/wait.mjs" z1.<sessionId>.<HMAC> http://127.0.0.1:<port>`
   Embedding the Hub's exact loopback URL prevents multi-Hub mixups and keeps the command identical across restarts so per-command approval persists.
2. **Wait & wake cycle**: The model starts the command in background and ends its turn (member becomes idle online). When mentions arrive, the Hub sends the `[orrery]` envelope to `wait.mjs`, which prints it to stdout, acks `/bridge/zcode-ack`, and exits `0`.
3. **Re-arm & loop guards**: After acknowledging and replying, the model re-runs the same background command. The Hub limits arming to **10 times per 10 minutes per conversation**, applies a 30-minute re-arm grace window after delivery, and parks duplicate wait commands without killing the active wait.

### Shared Wait Core

ZCode, Qoder, and WorkBuddy share `wait-core.ts` / `wait-native.ts` parameterized by `WaitHarness` (`z1`/`q1`/`w1` ticket prefixes, `appProcess`, and `_meta` key):

- Newer integrations (Qoder, WorkBuddy) set `legacyWire = false`: envelopes carry chat content **without** "re-run the command" instructions (preventing host safety filter blocks), keeping wait output silent and documenting re-arm steps in tool schemas and `SKILL.md`.

## One-Time Manual Setup

orrery never edits `~/.zcode` configs. Full steps are in [plugins/zcode-orrery/README.en.md](../../plugins/zcode-orrery/README.en.md):

1. In ZCode **Settings → MCP → User** (`~/.zcode/cli/config.json`), add the HTTP server pointing to loopback `http://127.0.0.1:4317/mcp` with `x-orrery-bridge: <~/.orrery/secret>` and `x-orrery-harness: zcode` (Node 24 on PATH).
2. *(Optional)* Copy [`plugins/zcode-orrery/skill/SKILL.md`](../../plugins/zcode-orrery/skill/SKILL.en.md) (or [`SKILL.en.md`](../../plugins/zcode-orrery/skill/SKILL.en.md)) to `~/.zcode/skills/orrery/SKILL.md`.
3. Say `"加入 orrery"` / `"join orrery"` in a local workspace session; approve only that exact wait command if prompted (never enable blanket auto-approve).
4. **Leaving**: Quit ZCode or remove the member in the orrery UI (the Hub prints a one-time stop notice and exits `wait.mjs`). Manually killing the background task in ZCode often causes the model to re-arm immediately.

## Identity, Read-Only Store & Orphan Guards

- **Identity**: Reads host-injected `_meta` (`root_session_id ?? session_id`), rejecting `wait_for_messages` from remote workspaces (`workspace_identity` non-empty) or subagents.
- **Listing & tokens (`src/adapters/zcode/store.ts`)**: Copies `<ZCODE_HOME or ~/.zcode>/v2/tasks-index.sqlite` and `cli/db/db.sqlite` to temp files for read-only queries, supporting session-total `turn_usage` (no live per-turn totals or quotas).
- **Two-layer orphan protection**: To catch lingering Bash/`wait.mjs` children after ZCode exits, `wait.mjs` polls its first non-shell Windows ancestor PID every 5s and exits silently when gone, while the Hub checks `tasklist` (`ZCode.exe`, cached 10s + checked pre-delivery) before sending.

## Delivery Evidence & Limits

- **Delivery granularity**: Confirms up to envelope printout and re-arm (`accepted`), not full turn completion or per-turn token usage.
