# orrery Architecture (Native Beta)

Language: [中文](architecture.md) | **English**

## Module Layout

Code resides under `src/` and `desktop/`, with entry points defined in `package.json`; only Native Mode `NativeAdapter` implementations (`nativeAdapters`) are registered:

| Module | Responsibility | Reference |
|---|---|---|
| `src/main.ts`, `src/launcher.ts` | Hub process entry and authenticated browser launcher | [Launcher](launcher.en.md) |
| `src/config.ts` | Environment and path resolution (port, DB, skills dir, disabled plugins) | — |
| `src/core/types.ts` | Core domain types and `NativeAdapter` contracts (imports `system-kinds`) | — |
| `src/core/hub.ts` | `Hub`: scheduler, event bus, routing/batching, loop caps, hidden state, bridge registry | — |
| `src/core/store.ts` | SQLite persistence (`node:sqlite`), forward-only migrations, messages/deliveries/settings | — |
| `src/core/handover.ts` | Handover package builder (paired with `src/plugins/tasks/handover.ts`) | [Members & Handover](cluster-members.en.md) |
| `src/core/activity.ts` | Per-member activity telemetry state (`observing`, `stale`, `disconnected`, `unknown`) | [Activity Observation](activity.en.md) |
| `src/core/files.ts` | Web uploads, native member outbox imports, and path-safety checks | [Files & Skills](files.en.md) |
| `src/core/external-plugin*.ts`, `event-registry.ts` | Restricted third-party plugins: registration and manifests, process protocol, event channel, posting, commands, member tools, web UI and marks, configuration | [Third-Party Plugins](external-plugins.en.md) |
| `src/core/trusted-plugins.ts` | Full-trust plugins: data-only load decisions (safe mode, confirmation, dependencies), import, confirm and revoke | [Third-Party Plugins](external-plugins.en.md#full-trust-plugins) |
| `src/core/plugin.ts` | `PluginHost`: plugin registry, slot validation, per-plugin migrations and fault isolation | [Plugins](plugins.en.md) |
| `src/core/app-extensions.ts`, `skill-install.ts`, `zip.ts` | The read-only Skills & MCP overview and installing skills into the shared folder | [Files & Skills](files.en.md) |
| `src/core/usage.ts` | Quota snapshot cache and per-turn / session token aggregation | [Usage & Quotas](usage.en.md) |
| `src/mcp/server.ts` | MCP HTTP server and native caller authentication | [Native Mode](native-mode.en.md) |
| `src/mcp/bridge.ts` | `/bridge/*` SSE streams, acks, turn outcomes, wait/park and plugin bridge routes | [Native Mode](native-mode.en.md) |
| `src/mcp/wait-core.ts`, `hook-park.ts`, `antigravity.ts` | Background wait tickets, parked hook registry, and Antigravity HMAC verification | Adapter guides |
| `src/adapters/` | Native harness adapters, `shared/` helpers, and test-only `mock/native.ts` | Adapter guides |
| `src/plugins/` | Official built-in plugins: `tasks` (includes `ship`), `coordinator`, `bookmarks` | [Built-in Plugins](plugins.en.md) |
| `src/web/` | Static assets, HTTP API, SSE (`GET /api/stream`), and session auth | [Collaboration API](collaboration-api.en.md) |
| `desktop/` | Standalone Electron wrapper & Win32 docking (zero `src/` imports) | [Desktop Shell](desktop.en.md) |

The Windows installer uses `desktop/lib/runtime.mjs` to select the bundled Node, external Hub files, and a writable user-data directory. Upgrade and uninstall authenticate the owning Hub before stopping it. See [Desktop Shell](desktop.en.md).

## Dependency Rules

One-way dependencies across `src/` are verified on every import by `test/boundaries.test.ts`:

- `src/core/` never imports `adapters/`, `mcp/`, `web/`, `main.ts`, or `launcher.ts`.
- `src/adapters/` never imports `core/hub.ts`, `core/store.ts`, `mcp/`, or `web/`.
- `src/mcp/` never imports `adapters/`, `web/`, or `core/store.ts`, interacting only via `Hub` and `core/types.ts`.
- `src/web/` reads and writes only through `Hub` and plugin commands without touching adapter internals or plugin SQLite schemas directly.
- `src/plugins/` registers tools, events, schedules, and web/bridge routes via the official plugin host interface.

## Conventions & Default Paths

- Runtime: **Node.js >= 24.2** executes `.ts` directly with built-in `node:sqlite` (default `WAL` journal mode; configurable via `ORRERY_DB_JOURNAL=wal|delete`).
- Setting precedence: **Saved web settings > Startup env vars > Defaults** ([Loop Limits](hop-limit.en.md)).
- Cluster names may contain internal spaces; member names forbid spaces and control characters so `@<name>` parses unambiguously.

| Variable | Description | Default |
|---|---|---|
| `ORRERY_HOME` | Data root (`hub.json`, `secret`, `api-token`, `hub.log`) | `~/.orrery` |
| `ORRERY_DB` | SQLite database file path | `<repo>/.tmp/orrery.db` |
| `ORRERY_PORT` | Hub HTTP listening port | `4317` |
| `ORRERY_SKILLS_DIR` | Local skills folder listed for `$` completion | `~/.agents/skills` |
| `ORRERY_MOCK` | Set to `1` for the demo `mock` adapter (one demo project, two conversations that answer with an obviously fake line, no model calls) | Off |
| `ORRERY_MAX_HOPS` | Max chain hops (non-negative integer only, `0` allowed; no `unlimited`) | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | Max turns per chain (non-negative integer only, `0` allowed; no `unlimited`) | `20` |
| `ORRERY_DISABLED_PLUGINS` | Comma-separated plugin IDs to disable (official or third-party) | Empty |
| `ORRERY_SAFE_MODE` | Set to `1` to skip every full-trust plugin (`0` or unset is normal; any other value fails the start) | Off |
| `ORRERY_API_TOKEN` | A fixed web API token (at least 32 characters); without it the first start generates one and keeps it in `<ORRERY_HOME>/api-token` | Generated |

## Native Data Flow & Member Creation Boundaries

1. **Native Mode only**. Register adapters through `nativeAdapters`. New conversations require explicit `mode: "native"` and a non-empty `projectPath`. Attach existing conversations by `sessionId`. The UI has no mode switch and member responses omit `mode`.
2. **Creating vs attaching directory rules**:
   - **New native session (`createSession`)**: Requires an **explicit `projectPath`** on supporting harnesses—there is no sandbox fallback directory;
   - **Attaching an existing session (`attach`)**: Reads the conversation's `cwd` from the host adapter store.
3. **Delivery mechanisms & offline rules**: Batched envelopes reach running host apps via **bridge streams** (Claude bridge, DeepSeek plugin), **queue + verified wake** (Codex short-lived CLI + `codex://threads/wake/`), or **background wait / parked hooks** (ZCode, Qoder, WorkBuddy, Cursor); closed apps remain offline without auto-launching or replaying missed messages. See [Native Mode](native-mode.en.md).

### Web Auth & SSE (`GET /api/stream`)

- Web endpoints bind exclusively to `127.0.0.1`. Aside from static files and `POST /api/session` (which exchanges the token for an `HttpOnly` cookie), every `/api/*` route—including `GET /api/health`—requires a valid API Bearer token or session cookie. Full endpoints live in [Collaboration API](collaboration-api.en.md).
- Live SSE updates stream on **`GET /api/stream`** (supporting `?since=`), emitting the 14 `HubEvent.kind` types from `src/core/types.ts`: `cluster`, `member`, `message`, `delivery`, `read`, `acknowledgement`, `agent`, `guard`, `pause`, `settings`, `usage`, `collaboration`, `unread_hint`, and `delivery_dismissed`.
- The same stream also carries a few named frames without an `id`, for the user's page only: `plugin-run` (plugin command progress and results), `plugin-state` (third-party plugin run state), `plugin-ui` (plugin page pushes, chips and marks) and `plugin-config` (plugin configuration changes). They are not stored in the event table, not replayed on resume and never forwarded to plugins.

## Storage & Migrations

- `src/core/store.ts` manages core tables (`clusters`, `members`, `messages`, `deliveries`, `reads`, `message_acknowledgements`, `events`, `settings`, `files`, `message_files`, `turn_usage`, `quota_snapshots`, `activity_snapshots`, `merge_windows`, `plugin_migrations`) via forward-only incremental migrations (cluster groups sit in `settings`, hidden flags in `members.hidden_at`; run `npm run backup` for local backups). The current schema version is **v30** (`PRAGMA user_version`).
- **v30: isolated mode is gone**. Native mode is the only member mode. On upgrade, any old isolated members still in a group (trashed groups included) are removed: queued deliveries are cancelled, running ones are marked failed with an unknown outcome, installed plugins run their usual member-removal cleanup, and each affected group gets one `mode_removed` system message saying who was removed and that the records are kept (delivered to nobody). Existing messages, reads, usage and delivery records stay; members whose messages failed to deliver get the usual failure notice after the Hub starts. A coordinator that is no longer a member is disabled at start or when its group is restored. Databases without isolated members see no visible change. The `members.mode` column is kept for history only and never read.
- **Pre-upgrade backup**: when an existing database has pending migrations at this start (core schema or any plugin's steps), the Hub backs it up to `<ORRERY_HOME>/backups/orrery-<time>-pre-upgrade.db` before the first schema change; only the newest few automatic backups are kept, and the earliest restore point is kept while an upgrade round has not fully completed. Manual backups from `npm run backup` are never deleted automatically. The Hub never restores a backup by itself.
- Built-in plugins manage their own tables tracked in `plugin_migrations` (`collaboration_tasks`, `collaboration_roles`, `collaboration_member_roles`, `collaboration_links`, `collaboration_bookmarks`, `collaboration_policies`, `collaboration_operations`, `collaboration_records`, `task_label_groups`, `task_labels`, `cluster_label_groups`, `task_batches`, `task_watches`, `task_cluster_settings`, etc.). Full-trust plugin tables start with `x_<plugin id>_`, and migrations that leave the prefix are rolled back.
- `POST /api/clusters/:id/purge` removes soft-deleted cluster rows and orphaned files inside a transaction; downgrading databases is unsupported. Checked baseline versions in individual adapter docs are not compatibility guarantees across untested upstream releases.

## Reading a Member's Bound Native Conversation

In-process plugins (official plugins and full-trust plugins the user confirmed) can call `Hub.memberTranscript(memberId, request)` to read, page by page, the body of the native conversation a member is currently bound to. The Hub resolves the binding itself and calls the native adapter's optional `transcript` method: Claude reads the session's project JSONL, Codex reads the matching current or archived rollout, Kimi Code reads the bound session's `agents/main/wire.jsonl` (after checking identity in `state.json`), ZCode and Qoder read their SQLite stores in place and read-only (shared SQLite reader, no file written), Cursor reads `agent-transcripts/<id>/<id>.jsonl` (unwrapping wrappers and submitting delivery candidates without opening `state.vscdb`), WorkBuddy reads `projects/<proj>/<sessionId>.jsonl` (verifying `session-meta`, skipping `subagents/`, and checking wait command results), Antigravity reads `brain/<uuid>/.system_generated/logs/transcript_full.jsonl` (falling back to `transcript.jsonl` only when absent, redacting thinking/`orreryCaller`, submitting only `SYSTEM_MESSAGE` candidates, and pairing `call_mcp_tool` results by step index), DeepSeek Harness is described below, and other adapters return `unsupported`. Format details are in the [Claude adapter](adapters/claude-adapter.en.md), [Codex adapter](adapters/codex.en.md), [Kimi Code adapter](adapters/kimi.en.md), [ZCode adapter](adapters/zcode.en.md#reading-the-conversation-body), [Qoder adapter](adapters/qoder.en.md#reading-the-conversation-body), [Cursor adapter](adapters/cursor.en.md#listing--online-presence), [WorkBuddy adapter](adapters/workbuddy.en.md#read-only-session-store--transcript-reading), [Antigravity adapter](adapters/antigravity.en.md#manual-setup--read-only-store), and [DeepSeek adapter](adapters/deepseek.en.md#reading-the-native-conversation) pages.

- Without a cursor it reads the last page; `direction: 'before'` with the returned `before` pages back, `direction: 'after'` with `after` reads newly appended records. Items keep the file's order, and the same item ID means an update; an incomplete last line shows up once it is complete. `hasMore` may say more is available in that direction even when `items` is empty.
- At most 200 items per page and 16 KiB per text, with a marker when truncated. When the file is cleaned up, rewritten or replaced, the returned status says so; on `reset`, drop the old cursor and read again.
- Reading happens on demand and results stay in memory: no app is started, the app's records are never changed, and the body is never written to the Hub's database, events or logs. The core has no web, MCP or restricted-plugin interface for reading bodies. See the [Security Model](security.en.md#bodies-of-bound-conversations) for the boundaries.
- The reader scans in chunks and checks cursors against the file's identity, size and sampled content; if another program rewrites old content outside the sampled range in place while the file keeps growing, that may go unnoticed.
- Delivery candidates: Claude deliveries carry a trusted marker written by the app and Codex carries a delivery ID; those rules are unchanged. In apps without a trusted marker, deliveries show up in a wait command's `tool_result`, a `system` record or an unmarked `user` record, so the adapter only hands over unverified evidence in `source.candidate`: `deliveryId` (an exact delivery ID), `envelope` (an envelope starting with `[orrery] cluster=…`; only the first line counts and its group must be the member's group) or `direct` (`{ body, at?, deliveryIdPrefix? }`: the body must equal exactly one direct message without attachments really delivered to this member, several equal ones mean no match; `at` applies the delivery time condition; `deliveryIdPrefix` must be at least 8 hex characters and match the start of that delivery's ID). Only `user`, `system` and `tool_result` items are considered, and the first hit in the order `deliveryId`, `envelope`, `direct` wins. On a hit the item becomes `orrery_delivery` with its content taken from the Hub's messages, keeping the original `id`, `timestamp` and `callId`; on a miss it is returned unchanged. `source` never appears in the result. Accepted limit: text the user types that is identical to an envelope or body really delivered to that member is shown as that delivery; what is shown comes from the real Hub message, so nothing from another group or member can appear.
- DeepSeek Harness reads the bound session's newest multi-frame zstd log: complete frames are found from their headers, only the frames a page needs are inflated, cursors stay valid when frames are appended, inflation is capped, and deliveries are recognised only by the request id the plugin sets, and a record without it is never treated as a delivery. See the [DeepSeek adapter](adapters/deepseek.en.md#reading-the-native-conversation).

## Interface and App Services

`shared/i18n` is a pure text catalog shared by Web and desktop views. `src/update-check.ts` and `src/plugin-install*.ts` are process-level services injected by `main.ts` through structural WebControl interfaces; core collaboration does not acquire network or package-manager dependencies. Update preferences/cache live in `<home>/updates.json`; managed plugin packages live in `<home>/plugin-packages`, registered through `external-plugins.json`. Archives use pinned `tar 7.5.23` and `yauzl 3.4.0` (automated validation: 2026-11-17).
