# Cursor Adapter (Native Mode)

Language: [中文](cursor.md) | **English**

Native Cursor members attach directly to open agent conversations inside Cursor desktop (built and verified against Cursor 3.29.9 on Windows).

## Mechanism: Parked Stop Hooks & Placeholder Relay

The user-installed plugin (`plugins/cursor-orrery/`) connects via three lifecycle hooks and a placeholder stdio MCP server using only built-in Node modules and loopback HTTP. Through its bundled `lib/hub-discovery.mjs` it reads the account's Hub registry (`ORRERY_REGISTRY`) on every request, uses the active Hub or the one pinned by `ORRERY_HUB`, and signs every request with `x-orrery-sig`; it does not read `hub.json` or send the key itself (rules in [Plug-ins: finding the Hub, signing, errors](../native-mode.en.md#plug-ins-finding-the-hub-signing-errors)):

1. **Turn-end parking (`stop.mjs` -> `/bridge/cursor-turn` & `/bridge/cursor-park`)**:
   - After each turn finishes, the `stop` hook posts `event: 'end'`, `generationId`, status, and raw token counts to the Hub.
   - If the conversation is an active member, it parks on `GET /bridge/cursor-park`; incoming deliveries return `{"followup_message": "[orrery · 来自 <sender> · #<8-hex-handout>]..."}` so Cursor submits the next turn automatically.
   - Cursor silently discards `followup_message` from older `stop` hooks when newer hooks exist, so the Hub keeps only the latest `since` park and returns `{}` to superseded waiters on every new turn start.
2. **Submission proof (`prompt.mjs` -> `beforeSubmitPrompt`)**:
   - Checks only the first 1,000 characters of the submitted prompt's first line for the 8-hex handout token and reports `event: 'start'` (never sending prompt text).
   - Deliveries are marked confirmed only when this hook observes the matching handout; missing/discarded deliveries become `unknown` and **never auto-retry**.
3. **MCP execution relay (`mcp.mjs` + `postToolUse`)**:
   - `mcp.mjs` responds to `tools/call` with an `orrery-cursor-placeholder` payload.
   - `postToolUse` reads Cursor's tamper-resistant `conversation_id` and `tool_input`, forwards the call to Hub `/mcp` as a signed request with `x-orrery-harness: cursor` and `x-orrery-session`, and swaps the model output via `updated_mcp_tool_output`.
   - Network/timeout errors report explicit uncertainty when a request already reached the Hub, instructing the model to verify with `read_messages` before retrying.
   - After a 401, `mcp.mjs` slows to one retry about every 60 seconds and logs why (usually an outdated plugin copy or a key mismatch); while the Hub is simply not running it still retries every 5 seconds.

## One-Time Manual Install & Uninstall

orrery never installs or edits Cursor settings automatically:

1. Copy [plugins/cursor-orrery/](../../plugins/cursor-orrery/README.en.md) to `~/.cursor/plugins/local/cursor-orrery/`.
2. Ensure `node` is on PATH, reload/restart Cursor, and verify the `orrery` MCP server is enabled.
3. **Optional fallback (optional fallback)**: If your Cursor build skips local plugin folders, merge `hooks/hooks.json` and `mcp.json` manually into `~/.cursor/hooks.json` and `~/.cursor/mcp.json`, replacing `${CURSOR_PLUGIN_ROOT}` with the forward-slash absolute plugin path.
4. **Upgrade**: The plugin is a copy and does not update with orrery. After every orrery update you **must reinstall** it: copy the whole plugin folder again (including `lib/hub-discovery.mjs`) and restart Cursor. An old copy that was not reinstalled still reads `<ORRERY_HOME or ~/.orrery>/hub.json` and sends the plaintext key. The registry-reading, signing plugin is verified by automated tests only so far.
5. **Uninstall**: Delete that plugin directory (or remove the merged entries).

## Listing & Online Presence

- **Read-only discovery**: Reads workspace folders from `%APPDATA%\Cursor\User\workspaceStorage\*\workspace.json` and transcripts from `~/.cursor/projects/<encoded>/agent-transcripts/<id>/<id>.jsonl` (parsing `<user_query>` while skipping `[orrery` envelopes). **Never opens `state.vscdb` databases containing login tokens.** New threads appear after completing at least one turn.
- **Read-only bound transcript reading**: `Hub.memberTranscript` reads bounded pages from `<cursorHome>/projects/*/agent-transcripts/<id>/<id>.jsonl` (rejecting outside paths, hardlinks, and junctions; never opening `state.vscdb`), unwrapping `<timestamp>` and `<user_query>`, redacting `thinking`, and normalizing `CallDynamicTool`. Only first lines matching `[orrery · … · #<8-hex-handout>]` are submitted as unverified Hub delivery candidates (misses stay `user`); since Cursor JSONL omits `tool_result`, tool calls are never guessed as `orrery_post`.
- **Online presence**: True while a `stop` hook is parked, an acknowledged turn is active, or within the 10s post-turn re-park grace window while `Cursor.exe` is running under the current Windows user. Exits cleanly via parent-PID checks when Cursor quits.
- **Multi-turn cap**: Sets `"loop_limit": null` in `hooks.json` so Cursor's default 5-loop limit yields to Hub hop, chain, hourly, and pause limits.

## Privacy Allowlist & Safety

- Hooks run across Cursor conversations under a strict field allowlist: only `conversation_id`, `generation_id`, `status`, four token ints, `cursor_version`, 8-hex handout, and explicit `orrery` MCP calls leave the plugin. **`prompt`, `text`, `user_email`, `transcript_path`, `workspace_roots`, `model`, and attachments are never transmitted or logged.** Non-member sessions return `{}` immediately.
- Delivered batches render as user-authored messages inside Cursor; if Auto-run commands or auto-approve MCP is enabled in Cursor settings, incoming `@mentions` will run unattended.

## Token Accounting

- **Per-turn tokens**: Computed as `input = max(0, input_tokens - cache_read_tokens - cache_write_tokens)` from `stop` hook inputs (matching UI totals in observation, though cache subtraction and multi-call aggregation remain inferred; session totals and quotas are unsupported).
- **Verified use**: Real-app checks include consecutive batches, busy-turn batching, offline/no-replay behavior, and delivery after more than 50 minutes parked. Other plugins sharing the same stop-hook response channel depend on the host's callback handling.
