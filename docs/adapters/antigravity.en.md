# Antigravity Adapter (Native Mode)

Language: [中文](antigravity.md) | **English**

The Antigravity adapter attaches open workspace conversations in Antigravity 2.0 desktop via a user-installed **sidecar**, global **MCP entry**, and **`PreToolUse` signing hook** (`plugins/antigravity-orrery/`). Native Mode only; optional pre-invocation hints live in [Unread Hint Hook](unread-hook.en.md#antigravity).

> **Terms of Service Warning**: Official Antigravity FAQs state that accessing Antigravity through third-party software, tools, or services **may violate** its Terms of Service and lead to account suspension or termination. Sending prompts via `agentapi send-message` from a sidecar falls into this category; use at your own discretion.

## Mechanism

1. **Sidecar delivery (`sidecar.mjs`)**:
   - Exits unless `ANTIGRAVITY_LS_ADDRESS` and direct `ANTIGRAVITY_AGENTAPI_EXE` are provided (never wraps `.bat` through `cmd.exe`).
   - Reads `<ORRERY_HOME or ~/.orrery>/hub.json` read-only, streams `GET /bridge/stream?harness=antigravity&version=<v>`, invokes `execFile(ANTIGRAVITY_AGENTAPI_EXE, ['agentapi', 'send-message', <UUID>, <text>])` (prepending `--` when `<text>` starts with `-`), and redacts CSRF tokens to `[redacted]` before truncating stderr.
   - **Startup order**: Start the Hub before Antigravity. Sidecar reconnects every 5s, whereas Antigravity's MCP client does not auto-reload tools after a Hub restart unless refreshed manually in MCP settings or by restarting Antigravity.
2. **Signed `PreToolUse` auth (`hook.mjs`)**:
   - Because Antigravity shares one global HTTP MCP connection without session headers, `hook.mjs` signs stdin `conversationId` using `hub.json`'s secret, overwrites `orreryCaller`, and returns `ask` to honor user approvals.
   - `src/mcp/antigravity.ts` rejects missing or invalid signatures. Same-user local processes can still read local secret/config files ([Security Model](../security.en.md)); rotating `~/.orrery/secret` invalidates prior signatures.

## Manual Setup & Read-Only Store

- **Setup**: Follow [plugins/antigravity-orrery/README.en.md](../../plugins/antigravity-orrery/README.en.md) (copy to `~/.gemini/config/sidecars/orrery/`, enable sidecar, update `mcp_config.json` and `hooks.json`; leave diagnostic `hook-dump.mjs` unconfigured in normal use).
- **Store (`store.ts`)**: Copies `~/.gemini/antigravity/conversation_summaries.db` (+ `-wal`) via `withCopy` to list non-killed top-level `antigravity` UUID threads with local `file://` workspaces. No `createSession`, quotas, or tokens.
- **Read-only bound transcript reading**: `Hub.memberTranscript` reads bounded pages from `<geminiHome>/antigravity/brain/<uuid>/.system_generated/logs/transcript_full.jsonl` (with bounded 256 KiB first-line probing and tolerance for half-written first lines, falling back to `transcript.jsonl` only when absent, rejecting hardlinks/junctions without fallback and never reading `.pb` or `conversations/*.db`). It redacts `thinking`, strips `orreryCaller` signatures and echoed credentials uniformly from `tool_call`, `tool_result`, and error text, checks only `SYSTEM_MESSAGE` (`sender=system`, `MESSAGE_PRIORITY_HIGH`) as Hub delivery candidates (`USER_INPUT` never promotes), and pairs `call_mcp_tool` (including JSON-quoted server/tool names) with `GENERIC` results by positional `callId` across pages.

## Limits & Verified Use

- **One-way `accepted` deliveries**: `agentapi send-message` confirms submission acceptance only, not model turn completion; timeouts or disconnects report `unknown`.
- **Verified use**: The sidecar, signed hook, member identification, message delivery, and MCP replies have run in real Antigravity sessions.
