# Codex Adapter (Native Mode)

Language: [中文](codex.md) | **English**

Native Codex members correspond to active `thread` conversations inside ChatGPT/Codex desktop. The Hub performs **queueing, verified wake, and read-only polling**, letting the desktop backend run turns under user permissions. An optional [Unread Hint Hook](unread-hook.en.md#codex) exists (not recommended until subagent identity propagation is live-verified).

## Binary Precedence & Short-Lived Processes

- **Binary priority**: **`ORRERY_CODEX_NATIVE_BIN`** → newest bundled desktop backend **`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`** → **`codex` on `PATH`**.
- **Short-lived process per operation**: Every list, attach, create, `thread/queue/add` (`clientUserMessageId`), and poll runs in its own short-lived `app-server` (`-c features.plugins=false -c features.apps=false`, never modifying `~/.codex` user configs, rules, or hooks), closing stdin **after each operation completes** (killing the process tree after 3s if needed, capped at `maxProcesses = 3` and 60s timeout) so writer locks never block the desktop app.
- **Creating (`createSession`) vs attaching (`attach`)**:
  - Creating a new native thread **requires an explicit `projectPath`** with no sandbox fallback; when explicit model or reasoning effort is chosen, the same short-lived process runs a minimal initialization turn so settings persist before desktop pickup (skipped if neither is chosen).
  - Attaching an existing conversation reads `cwd` directly via read-only `thread/read`.

## MCP Auth, Presence & Delivery

- **Codex MCP auth (dedicated rule)**: Configure Codex HTTP MCP with **`x-orrery-bridge: <secret>` ONLY**—**omit both `x-orrery-session` and `x-orrery-harness`** (passing `x-orrery-harness: codex` without `x-orrery-session` falls into `nobody` and is rejected). The Hub matches `_meta.threadId` strictly on bridge-only requests (`src/mcp/server.ts`).
- **Desktop process check**: Windows `tasklist /APPS /FO CSV /NH` matches `ChatGPT.exe` under `OpenAI.Codex_*` (`appCheckMs` 10s cache; ignores residual `RuntimeBroker.exe` and non-packaged `codex.exe`).
- **Pre-wake live probe**: Before opening `codex://threads/wake/<threadId>`, performs an uncached live probe; if the desktop app closed, attempts queue deletion and resolves `unknown` without launching the app (a brief OS launch race between probe and `start` remains an accepted residual risk).
- **Polling & usage**: Polls every 3s (backing off to 6s after 3 running ticks); time behind another active turn never counts toward the 30m idle pickup timeout. Missing queued items across >= 3 polls and >= 15s resolve `unknown`. Routine quotas and tokens read local `rollout-*.jsonl` (manual refresh calls `account/rateLimits/read`).
- **Verified use**: Existing desktop conversations, messages between Codex and Claude, busy-turn batching, offline handling after exit, and no replay on restart have been exercised in real use.
