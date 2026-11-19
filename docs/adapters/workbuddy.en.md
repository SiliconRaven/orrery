# WorkBuddy Adapter (Native Mode)

Language: [中文](workbuddy.md) | **English**

> **Session identity**: The bridge needs a trustworthy session ID from the running WorkBuddy process. If tools are missing, confirm that the connector is trusted and reconnect it in the current conversation.

WorkBuddy pairs a per-session stdio MCP bridge (`plugins/workbuddy-orrery/bridge.mjs`) with the [Shared Wait Core](zcode.en.md#shared-wait-core) background wait command, without modifying WorkBuddy settings.

## Mechanism

1. **Per-session stdio bridge (`bridge.mjs`)**:
   - Because WorkBuddy channel notifications do not start turns and `CODEBUDDY_SESSION_ID` is not passed to MCP subprocesses, the bridge checks `CODEBUDDY_SESSION_ID` first and otherwise performs one read-only Windows parent-process lookup before answering `initialize`: requiring exact `WorkBuddy.exe` executable identity and consistent `--session-id` CLI flags (do not wrap `node` inside `cmd`).
   - If no valid session ID is resolved, the bridge returns an empty tool list and sends zero requests to the Hub.
   - **Startup order**: Start the Hub (`npm start`) before opening WorkBuddy conversations; restarting conversations refreshes failed `tools/list` caches.
2. **Silent wait & clean envelopes**:
   - Runs `wait.mjs` with `w1` HMAC tickets and chat-only envelopes (`legacyWire = false`) so WorkBuddy's built-in "AI safety guard" does not block re-arm guidance.
   - WorkBuddy recycles idle conversation workers after ~15 minutes, marking members offline without replaying missed messages.

## Manual Setup & Permissions

See [plugins/workbuddy-orrery/README.en.md](../../plugins/workbuddy-orrery/README.en.md):

1. Add a trusted stdio MCP connector in WorkBuddy (`command: node`, `args: ["<orrery>/plugins/workbuddy-orrery/bridge.mjs"]`).
2. *(Optional)* Copy `plugins/workbuddy-orrery/skill/SKILL.md` (or `SKILL.en.md`) into WorkBuddy's skills directory and say `"加入 orrery"` / `"join orrery"`.
3. **Permission warning**: WorkBuddy's default sandbox preset may run operations without per-command prompts; approve only the exact `wait.mjs` line if asked, and never enable "allow full access".

## Read-Only Session Store & Transcript Reading

- **Store**: Queries temp copies of `<WORKBUDDY_CONFIG_DIR or ~/.workbuddy>/workbuddy.db` (+ `-wal`), filtering local non-playground/non-automation sessions. No `createSession`, quotas, or tokens.
- **Read-only bound transcript reading**: `Hub.memberTranscript` reads bounded pages from `<workbuddyHome>/projects/<proj>/<sessionId>.jsonl` (verifying `session-meta.sessionId`, skipping `subagents/`, rejecting outside paths, hardlinks, and junctions, without touching `workbuddy.db`). It redacts `reasoning` and session wait tickets before display, maps `isMeta` to `system`, normalizes both direct MCP and `DeferExecuteTool` calls with cross-page pairing, and submits Hub candidates only for `TaskOutput` or explicitly paired Shell wait-command results whose full command matches this session's `wait.mjs` command (unpaired results, embedded command snippets, and misses remain unchanged).
- Session identity is supplied by the host. Reconnect MCP if a reset, rewind, or new conversation changes the identity.
