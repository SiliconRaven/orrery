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
