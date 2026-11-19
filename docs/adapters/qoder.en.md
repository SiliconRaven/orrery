# Qoder Adapter (Native Mode)

Language: [中文](qoder.md) | **English**

The Qoder adapter attaches desktop Qoder sessions (aligned with 0.5.6 / `qodercli 1.1.79`) via a user-uploaded plugin relay (`plugins/qoder-orrery/`) and the [Shared Wait Core](zcode.en.md#shared-wait-core).

## Unattended Execution Warning

**orrery does not guarantee unattended operation when Qoder's approval preset is "Ask every time".**

Under that mode, launching the wait command, reading output files, and calling MCP tools prompt with only `Deny` / `Allow once` for Shell and MCP; failing to re-arm within the 30-minute grace period drops the member offline. orrery never relaxes user approval settings.

## Mechanism & One-Time Setup

1. **Install plugin**: Package the zip per [plugins/qoder-orrery/README.en.md](../../plugins/qoder-orrery/README.en.md) and upload via Qoder **Extensions → Plugins → Add Plugins → Upload Plugin** (with `node` on PATH). The plugin spawns one shared `mcp.mjs` relay sending `x-orrery-bridge` and `x-orrery-harness: qoder`; the Hub trusts only Qoder's runtime `_meta["com.qoder/turnContext"].sessionId`.
2. **Approvals**: Follow your own host approval policy.
3. **Attach session**: Start the Hub (`npm start`), pick `qoder` native mode in the web UI, and attach an existing local Qoder conversation.
4. **Arm wait command**: Tell the Qoder conversation `"加入 orrery"` / `"join orrery"` so it invokes `wait_for_messages` (`q1` ticket) and backgrounds silent `wait.mjs` (prints nothing while waiting to avoid Qoder's 45s interactive-prompt trigger; chat-only envelopes with `legacyWire = false`). `wait.mjs` monitors ancestor `Qoder.exe`, and the Hub verifies `Qoder.exe` via `tasklist` before delivering.

- **If Qoder starts before Hub**: The plugin returns an empty tool list and retries every 5s. It sends `notifications/tools/list_changed` when Hub returns; if the client still shows no tools, reload the plugin or restart Qoder.

## Read-Only Store & Verified Use

- **Read-only store (`src/adapters/qoder/store.ts`)**: Copies `<ORRERY_QODER_DATA or APPDATA/com.qoder.app.stable>/main.sqlite` (+ `-wal`) to temporary files to list `workspaces` and normal UUID `chat_sessions`. No `createSession`, quotas, or tokens.
- **Verified use**: The real Qoder client has passed checks for listing conversations, plugin-root expansion, joining, consecutive receive/reply/re-arm cycles, exit detection, and no replay after restart.

## Reading the Conversation Body

The in-process `Hub.memberTranscript` reads the Qoder conversation a member is bound to through `src/adapters/qoder/transcript.ts` (contract in the [Architecture](../architecture.en.md)). It follows the `main.sqlite` layout written by Qoder desktop 0.5.7, checked on 2026-11-19; that layout is not a public Qoder interface and may change with an update.

- **Source**: Qoder keeps two records: the app's `main.sqlite` (table `chat_session_messages`) and qodercli's `~/.qoder/projects/<project>/<session id>.jsonl`. The database is used: it covers every conversation orrery can bind (binding uses the session ids of `chat_sessions` in the same database, and not every conversation has a JSONL), it is the linear record the app shows, and it has a unique index on `(session_id, sequence)`. The JSONL is a branching tree log mixed with many non-conversation records. The cost: reminders and skill lists Qoder attaches for the model are not in the database.
- **Reading**: the shared reader `src/adapters/shared/sqlite-transcript.ts` opens the database in place and read-only; nothing is copied or written. With a `-wal` but no `-shm` (the `-shm` deleted after a crash) the database is not opened and the read gives `unsupported`; it is readable again after Qoder next opens the database (method and the one race left as for [ZCode](zcode.en.md#reading-the-conversation-body)). Only the bound session's rows are read, ordered by `sequence`. A missing or deleted session gives `missing`, a missing column `unsupported`, a session ID that is not a UUID `refused`.
- **Kinds**: user input → `user`; assistant text → `assistant`; thinking → `thinking` with a placeholder only, never the text; tools (call and result in one part) → `tool_call` plus `tool_result` once finished; hook activity → `system`; anything else → `unknown`, counted. A row over 256 KiB becomes one truncated `unknown`. A row not yet finished is read again by the next forward read (same item IDs); a cursor on a finished row gives `reset` once that row is rewritten in place.
- **MCP calls**: Qoder calls MCP tools through its own `mcp_call` tool, with `toolName` `mcp__<server>__<tool>`; the server name is taken from that record, not hard-coded.
- **Deliveries**: the wait command prints only the envelope (or a direct message's body). A `Read` result goes to the Hub as a candidate only when all of these hold: its turn was started by a background task ending; that task is, within this session's 16 most recent earlier assistant turns, a background command that is exactly this session's wait command with its ticket; the `Read` has only `file_path`, reads that task's output file, and its result is numbered line by line from line 1. The Hub marks it an orrery delivery only if the delivery really went to this member. Text the user types, another session's ticket, partial reads and other tools' output never count. A ticket can be used to hold this session's wait, so the signature part of every orrery ticket is replaced with `<hidden>` in each text returned; the evidence is still taken from the raw record.
- **Posts**: the `messageId` of a successful `send_message` result goes to the Hub, which checks that this member really sent that message in this group.
- **Unverified**: reading while Qoder is writing the database; row status values during a running turn; rows after a conversation rewind or context compaction; wait commands started more than 16 assistant turns before their delivery (shown as an ordinary tool result).
