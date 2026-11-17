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
| `src/core/external-plugins*.ts` | External plugin loading, JSON-RPC, filtered event stream, and write controls | [External Plugins](external-plugins.en.md) |
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
| `ORRERY_MOCK` | Set to `1` to enable native in-memory `mock` adapter | Off |
| `ORRERY_MAX_HOPS` | Max chain hops (non-negative integer only, `0` allowed; no `unlimited`) | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | Max turns per chain (non-negative integer only, `0` allowed; no `unlimited`) | `20` |
| `ORRERY_DISABLED_PLUGINS` | Comma-separated built-in plugin IDs to disable | Empty |

## Native Data Flow & Member Creation Boundaries

1. **Native Mode only**: `StartOptions`/`HubOptions` accept `nativeAdapters` only; `Member.mode` retains the single value `'native'` (omitting it on member creation defaults to `'native'`; any other value is rejected, and the UI shows no mode switch).
2. **Creating vs attaching directory rules**:
   - **New native session (`createSession`)**: Requires an **explicit `projectPath`** on supporting harnesses—there is no sandbox fallback directory;
   - **Attaching an existing session (`attach`)**: Reads the conversation's `cwd` from the host adapter store.
3. **Delivery mechanisms & offline rules**: Batched envelopes reach running host apps via **bridge streams** (Claude bridge, DeepSeek plugin), **queue + verified wake** (Codex short-lived CLI + `codex://threads/wake/`), or **background wait / parked hooks** (ZCode, Qoder, WorkBuddy, Cursor); closed apps remain offline without auto-launching or replaying missed messages. See [Native Mode](native-mode.en.md).

### Web Auth & SSE (`GET /api/stream`)

- Web endpoints bind exclusively to `127.0.0.1`. Aside from static files and `POST /api/session` (which exchanges the token for an `HttpOnly` cookie), every `/api/*` route—including `GET /api/health`—requires a valid API Bearer token or session cookie. Full endpoints live in [Collaboration API](collaboration-api.en.md).
- Live SSE updates stream on **`GET /api/stream`** (supporting `?since=`), emitting the 14 `HubEvent.kind` types from `src/core/types.ts`: `cluster`, `member`, `message`, `delivery`, `read`, `acknowledgement`, `agent`, `guard`, `pause`, `settings`, `usage`, `collaboration`, `unread_hint`, and `delivery_dismissed`.

## Storage & Migrations

- `src/core/store.ts` manages core tables (`clusters`, `members`, `messages`, `deliveries`, `reads`, `message_acknowledgements`, `events`, `settings`, `files`, `message_files`, `turn_usage`, `quota_snapshots`, `activity_snapshots`, `merge_windows`, `plugin_migrations`) via forward-only incremental migrations (cluster groups sit in `settings`, hidden flags in `members.hidden_at`; run `npm run backup` for local backups).
- Built-in plugins manage their own tables tracked in `plugin_migrations` (`collaboration_tasks`, `collaboration_roles`, `collaboration_member_roles`, `collaboration_links`, `collaboration_bookmarks`, `collaboration_policies`, `collaboration_operations`, `collaboration_records`, `task_label_groups`, `task_labels`, `cluster_label_groups`, etc.).
- `POST /api/clusters/:id/purge` removes soft-deleted cluster rows and orphaned files inside a transaction; downgrading databases is unsupported. Checked baseline versions in individual adapter docs are not compatibility guarantees across untested upstream releases.
