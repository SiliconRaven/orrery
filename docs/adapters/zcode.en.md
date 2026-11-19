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

## Reading the Conversation Body

The in-process `Hub.memberTranscript` reads the ZCode conversation a member is bound to through `src/adapters/zcode/transcript.ts` (contract in the [Architecture](../architecture.en.md#reading-a-members-bound-native-conversation)). It follows the table layout of ZCode desktop 3.18.2 (CLI 0.17.1), checked on 2026-11-19; that layout is not a public ZCode interface and may change with an update.

- **Source**: tables `message` (one row per message, JSON in `data`) and `part` (the message's parts) of `<ZCODE_HOME or ~/.zcode>/cli/db/db.sqlite`, opened in place and read-only by the shared reader `src/adapters/shared/sqlite-transcript.ts`; the database is never copied. A page scans at most 1000 row keys and then reads rows one by one. Only rows of the bound session are read. A missing or deleted session gives `missing`, a missing table or column `unsupported`, a malformed session id `refused`.
- **Kinds**: text the user typed → `user`; context ZCode adds for the model (reminders, background task notices and the like, marked synthetic / model-only) → `system`; assistant text → `assistant`; reasoning → `thinking` with a placeholder only, never the reasoning text; tools → `tool_call` plus `tool_result` once completed or failed; a model switch → `system`; `step-start` and `step-finish` are hidden; anything else → `unknown`, counted. A row over 256 KiB becomes one truncated `unknown`. A tool still running or text still being written is read again by the next forward read (same item ID); a cursor on a finished row gives `reset` once that row is rewritten in place.
- **Deliveries**: the wait command prints a delivery into the background command's output file and the member reads that file with `Read`. Only a `Read` result numbered line by line from line 1, whose first line is `wait.mjs`'s opening line and whose closing re-arm note carries the ticket of **this** session, hands its envelope (or, for a direct message without an envelope, its body) to the Hub as a candidate; the Hub marks it an orrery delivery only if that delivery really went to this member. Text the user types is a user message, not a tool result, so it never counts as a delivery even if it looks like an envelope; other tools' output and partial `Read`s do not count either. A ticket can be used to hold this session's wait, so the signature part of every orrery ticket is replaced with `<hidden>` in each text returned; the evidence is still taken from the raw record.
- **Posts**: the server and tool names ZCode records for an MCP call (`state.metadata.display`) decide whether it is `send_message`, so no server name is hard-coded; the `messageId` of a successful result goes to the Hub, which checks that this member really sent that message in this group.
- **No file is written**: measured on synthetic WAL databases (SQLite 3.53 bundled with Node 24, writer in another process): a plain read-only open creates `-wal`/`-shm` when they are absent and rewrites read marks in `-shm` on every read while a writer is open. So the reader uses `mode=ro&readonly_shm=1` when a `-wal` exists and `immutable=1` when not, then checks that the file did not change and no `-wal` appeared, otherwise it reads again under the same checks. With a `-wal` but no `-shm` (the `-shm` deleted after a crash), a `readonly_shm` open would create an empty `-shm` and an `immutable` one would miss the commits in the WAL, so the database is not opened and the read gives `unsupported`: the database is waiting for ZCode to recover its write-ahead log and is readable again after ZCode next opens it. One race is left: if ZCode closes the database cleanly, deleting `-wal` and `-shm`, in the instant between the check and the open, SQLite creates both again, empty; no way was found to open a WAL database read-only without that risk, and ZCode uses the empty files as usual on its next open. The database and its `-wal`/`-shm` must be plain files under the ZCode folder; links and hard links are refused.
- **Limits**: a partial or truncated `Read`, or reading the output with `cat` or `TaskOutput`, shows the delivery as an ordinary tool result; a row with an empty `message.sequence` makes the whole session `unsupported`.

## Delivery Evidence & Limits

- **Delivery granularity**: Confirms up to envelope printout and re-arm (`accepted`), not full turn completion or per-turn token usage.
