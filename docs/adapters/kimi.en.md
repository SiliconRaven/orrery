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
   - On custom builds supporting `sendSessionId: true`, manually adding `x-orrery-bridge` + `x-orrery-harness: kimi` in `mcp.json` (**never hardcode `x-orrery-session`**) enables Hub session auth via `_meta["kimi/sessionId"]` without duplicate turn replies.

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
