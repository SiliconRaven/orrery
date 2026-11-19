# Native Mode Design

Language: [中文](native-mode.md) | **English**

orrery operates strictly in Native Mode (`NativeAdapter`), letting your existing conversations in desktop apps or local CLIs (plus newly created native threads where supported) join a local cluster. A member receives deliveries only while its app is online. The Hub manages routing, batching, loop prevention, and caller authentication without running host model turns itself.

## Core Principles

1. **Touch only explicitly selected or created conversations**: Session enumeration uses read-only access or temp copies; creating a new native session requires explicit `mode: "native"` and a non-empty `projectPath`, while attaching reads `cwd` from the host adapter without modifying unrelated configs.
2. **Never auto-launch user apps**: Closed host apps appear **offline**; missed chat messages remain in history without replay when the app later starts.
3. **Inherit user approval policies**: Native conversations run under your existing host app settings (prompts are not guaranteed for every step).

## Local Discovery & `BridgePort`

The Hub binds `127.0.0.1`, publishes loopback `url` and `secret` in `<ORRERY_HOME>/hub.json`, and manages `<ORRERY_HOME>/secret`. Bridges, plugins, and hooks read these read-only to connect:

| Route | Auth | Purpose |
|---|---|---|
| `GET /bridge/stream?harness=<h>[&session=<id>&version=<v>]` | Bridge secret | SSE delivery stream (per-session for Claude; shared for DSH/Antigravity) emitting `deliver { deliveryId, sessionId, text }` |
| `POST /bridge/ack` | Bridge secret | Acknowledges local enqueue `{ deliveryId, ok, follows?, error? }` |
| `POST /bridge/done` | Bridge secret | Reports final turn outcome `{ deliveryId, harness, sessionId, outcome, error?, usage? }` when `follows: true` |
| `POST /bridge/unread-hint` | Bridge secret | Polled by hooks/plugins for new unread counts across 4 buckets |
| `GET /bridge/<h>-wait` / `POST /bridge/<h>-ack` | HMAC ticket | Background wait route (ZCode / Qoder / WorkBuddy) stream and print ack |
| `POST /bridge/<h>-turn` / `GET /bridge/<h>-park` | Bridge secret | Parked hook route (Cursor) turn lifecycle reports and parked channel |
| `POST /bridge/ship-verify` / `POST /bridge/ship-result` | Signed `body.ticket` | Used by `scripts/ship.ts` to query approved merge targets and report merge/failure results |

## Four MCP Authentication Paths

`/mcp` authenticates native callers strictly via bridge secrets paired with tamper-resistant host context (`src/mcp/server.ts`):

1. **Explicit session headers (Claude / DSH / Cursor / WorkBuddy)**: `x-orrery-bridge: <secret>` + `x-orrery-session: <id>` + `x-orrery-harness: <h>` (missing harness defaults to `claude`).
2. **Native Codex (bridge secret ONLY + `_meta.threadId`)**: Configure Codex HTTP MCP with **`x-orrery-bridge: <secret>` only**—**never pass `x-orrery-session` or `x-orrery-harness`** (sending `x-orrery-harness: codex` without `x-orrery-session` hits `nobody` and is rejected); the Hub reads runtime `_meta.threadId`.
3. **Runtime `_meta` injection (Qoder / ZCode / optional Kimi direct)**: `x-orrery-bridge` + `x-orrery-harness` paired with `_meta["com.qoder/turnContext"].sessionId`, `root_session_id` / `session_id`, or `_meta["kimi/sessionId"]` (Qoder ignores any `x-orrery-session` header).
4. **HMAC-signed argument (Antigravity)**: `x-orrery-bridge` + `x-orrery-harness: antigravity` with `PreToolUse` overwriting `orreryCaller` using local `hub.json` secret.

## Delivery Semantics & Fallback

- **Batching & ambiguity**: Busy members queue new mentions into one envelope upon turn end where supported; disconnects, timeouts, or ambiguous errors mark `outcome: unknown` without auto-retrying.
- **Reply-only fallback**: Stock Kimi Code disables MCP tools and uses `NativeAdapter.replies = true` to post completed main-agent replies back into chat.
