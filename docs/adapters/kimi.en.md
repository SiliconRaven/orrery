# Kimi Code Adapter (Native Mode)

Language: [中文](kimi.md) | **English**

The Kimi Code adapter attaches running Kimi Code desktop or local `kimi web` sessions (protocol 1.3.2 / service 2.5.1 `subscribe_v2`). Post-tool unread hints are unsupported here (see [Unread Hint Hook](unread-hook.en.md#kimi-code-and-deepseek-harness)).

## Member Replies: Reply-to-Chat (and Optional Direct MCP)

Stock Kimi Code shares workspace MCP connections without session IDs on `tools/call`. To avoid timing-based session impersonation:

1. **Default mode (`NativeAdapter.replies = true`)**:
   - Requires no orrery MCP setup; envelopes list active cluster peers in the header.
   - Only when the turn with `triggerPromptId === deliveryId` finishes as `completed` does the Hub forward the main agent's assistant text frames via `sendFromMember` (enforcing `@routing`, loop limits, and pause). User-started turns, empty outputs, and failed/cancelled turns are **never** posted.
   - **Limitation**: Default Kimi members cannot invoke `send_message`, `read_messages`, or `ack_messages`.
2. **Optional direct MCP (`_meta["kimi/sessionId"]`)**:
   - On custom builds supporting `sendSessionId: true`, manually adding `x-orrery-bridge: <shared key K>` (Kimi Code sends HTTP itself and cannot sign, so this is plaintext compatibility; get K from Settings → Delivery → Native connections → Show bridge key or `<ORRERY_REGISTRY>/bridge-secret`, and replace the old value with K once when upgrading) + `x-orrery-harness: kimi` in `mcp.json` (**never hardcode `x-orrery-session`**) enables Hub session auth via `_meta["kimi/sessionId"]` without duplicate turn replies.

## Presence Verification & Token Safety

**Never launches `kimi` or opens `kimi-code://` links**—token-bearing requests only follow read-only verification:

1. Reads `<KIMI_CODE_HOME or ~/.kimi-code>/server/instances/*.json` newest-first, accepting only `127.0.0.1`, `localhost`, or `::1`.
2. Verifies on Windows that the PID image is `Kimi Code.exe` (desktop) or `kimi.exe` (`kimi web`).
3. Runs read-only `netstat -ano -p TCP` confirming `127.0.0.1:<port>` listeners belong strictly to that PID.
4. Only then sends memory-held `~/.kimi-code/server.token` via a proxy-bypassed, redirect-disabled `node:http` / WebSocket client to `GET /api/v1/meta` (token files are strictly read-only and never logged or persisted to SQLite).
5. Unknown check outcomes (timeout on `tasklist`/`netstat`) preserve display state without sending tokens, deliveries, or wakeups.

## Delivery, Read-Only Listings & Usage

- **Read-only store**: Reads `~/.kimi-code/projects.json` first (falling back to `workspaces.json`), validating `session_<UUID>` IDs.
- **Queue & lock respect**: Prepends `[orrery · 来自 <sender>]` with **only** `content` and `prompt_id` (no model/permission overrides); backs off on `40931` up to 15x2s without calling lock takeover; attempts `:abort` on pre-`running` timeout/cancel and reports `unknown`.
- **Usage**: Reads `/api/v1/oauth/usage` with a 5-minute automatic / 10-second manual cooldown, deduplicates per-turn `step.usage` by `stepId`, and reads session totals from `wire.jsonl`. Basic delivery and replies have run in the real Kimi Code client.

## Reading the Conversation Record (`transcript`)

When a plugin reads a member's bound native conversation through the Hub (see [Architecture](../architecture.en.md#reading-a-members-bound-native-conversation)), the adapter locates the bound session's `agents/main/wire.jsonl` inside `sessions/` (verifying the session ID in `state.json` first and rejecting symlinks/hardlinks), and pages backward or reads newly appended records by byte cursor without reading `server.token` or contacting the local service:

- Only the main agent's canonical loop stream (`turn.prompt`, user-initiated `turn.steer`, `context.append_loop_event`, and turn interruption/error rows) is read, skipping subagent logs and redundant mirror rows. Thinking parts yield placeholders without raw reasoning text, non-text tool payloads show placeholders, and unrecognised rows degrade to `unknown` and increment `unknownCount`.
- Deliveries are attributed via `promptId` against Hub delivery batches; in optional direct MCP mode, paired successful `send_message` tool calls and results (including across page boundaries) resolve to `orrery_post`. Replies in the default reply-to-chat mode carry no Hub message ID in `wire.jsonl` and stay as `assistant`.
- Checked structure baseline: aligned to Kimi Code 1.3.4 (`wire.jsonl` `protocol_version: "1.5"`) with synthetic fixtures (`node --test test/kimi-transcript.test.ts`).
