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

- **Codex MCP auth (dedicated rule)**: Configure Codex HTTP MCP with **`x-orrery-bridge: <secret>` ONLY**—**omit both `x-orrery-session` and `x-orrery-harness`** (passing `x-orrery-harness: codex` without `x-orrery-session` falls into `nobody` and is rejected). The Hub matches `_meta.threadId` strictly on bridge-only requests (`src/mcp/server.ts`). Codex sends HTTP itself and cannot sign, so the secret is the registry's shared key K (plaintext compatibility, which can be turned off in delivery settings): Settings → Delivery → Native connections → Show bridge key, or read `<ORRERY_REGISTRY>/bridge-secret`. When upgrading from an older version, replace the value in `config.toml` with K once and restart Codex (see [Upgrading and rolling back plug-ins](../native-mode.en.md#upgrading-and-rolling-back-plug-ins)).
- **Desktop process check**: Windows `tasklist /APPS /FO CSV /NH` matches `ChatGPT.exe` under `OpenAI.Codex_*` (`appCheckMs` 10s cache; ignores residual `RuntimeBroker.exe` and non-packaged `codex.exe`).
- **Pre-wake live probe**: Before opening `codex://threads/wake/<threadId>`, performs an uncached live probe; if the desktop app closed, attempts queue deletion and resolves `unknown` without launching the app (a brief OS launch race between probe and `start` remains an accepted residual risk).
- **Polling & usage**: Polls every 3s (backing off to 6s after 3 running ticks); time behind another active turn never counts toward the 30m idle pickup timeout. Missing queued items across >= 3 polls and >= 15s resolve `unknown`. Routine quotas and tokens read local `rollout-*.jsonl` (manual refresh calls `account/rateLimits/read`).
- **Verified use**: Existing desktop conversations, messages between Codex and Claude, busy-turn batching, offline handling after exit, and no replay on restart have been exercised in real use.

## Paging Through the Conversation Record (`transcript`)

When a plugin reads a member's bound native conversation through the Hub (see [Architecture](../architecture.en.md#reading-a-members-bound-native-conversation)), the adapter finds the rollout for the bound thread UUID in `sessions/` or `archived_sessions/` and checks the thread ID in the first `session_meta`. It only reads local files, so it works while the app is offline.

- `.jsonl.zst` files are decompressed with Node's built-in Zstandard support (at most 16 MiB compressed and 64 MiB decompressed); damaged or oversized files return `archived`, a missing file returns `missing`, and a path or thread ID that does not belong returns `refused`.
- The event format follows `session_meta.history_mode`: newer records read completed items, older ones read standalone display events and skip duplicate copies. Forks and sub-agents only show records that clearly belong to this thread; copied history in the old format without reliable ownership returns `unsupported`. Thinking only shows a public summary or a marker, and unknown records keep a placeholder note.
- A user message's `client_id` and the `messageId` returned by the posting tool are only hints for the Hub to verify.
- Known limit: a first `session_meta` line over 64 KiB makes the read return `unsupported`.

`node --test test/codex-transcript.test.ts` checks paging, appends, archives, ownership and tool results with hand-written mock files; paging has not yet been accepted against a running desktop app. Format reference: [Codex 0.165.0 rollout retention policy](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/rollout/src/policy.rs).
