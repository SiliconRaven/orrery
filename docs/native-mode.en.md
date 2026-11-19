# Native Mode Design

Language: [中文](native-mode.md) | **English**

orrery operates strictly in Native Mode (`NativeAdapter`), letting your existing conversations in desktop apps or local CLIs (plus newly created native threads where supported) join a local cluster. A member receives deliveries only while its app is online. The Hub manages routing, batching, loop prevention, and caller authentication without running host model turns itself.

## Core Principles

1. **Touch only explicitly selected or created conversations**: Session enumeration uses read-only access or temp copies; creating a new native session requires explicit `mode: "native"` and a non-empty `projectPath`, while attaching reads `cwd` from the host adapter without modifying unrelated configs.
2. **Never auto-launch user apps**: Closed host apps appear **offline**; missed chat messages remain in history without replay when the app later starts.
3. **Inherit user approval policies**: Native conversations run under your existing host app settings (prompts are not guaranteed for every step).

## Local Discovery & `BridgePort`

Daily Hubs in one account use `ORRERY_REGISTRY` (default `~/.orrery/registry`). Version 1 discovery records in `active.json` and `hubs/<hubId>.json` contain `{version, hubId, name, url, pid, home, role, claim, startedAt}`. The Hub ID belongs to a data directory and the claim changes on every start. The shared key is stored separately as `bridge-secret`. Use a separate registry, home, database and port for development or tests.

- Send `x-orrery-sig: v1 <hubId> <claim> <ts> <nonce> <mac>`. The timestamp is decimal Unix milliseconds. The nonce and claim are 16-byte lowercase hex. Use the UTF-8 text of the 64-digit key for HMAC-SHA256. Join these fields with LF and no trailing newline: `orrery-req-v1`, hubId, claim, the actual `127.0.0.1:<port>`, HTTP method, raw path and query, canonical headers, ts, nonce, and the lowercase SHA-256 hex digest of the exact body bytes.
- Write one header per line as lowercase name, colon and value, sorted by ASCII name. Include empty slots for absent `x-orrery-harness` and `x-orrery-session` and any other present `x-orrery-*` header except `x-orrery-sig`. Signed requests omit `x-orrery-bridge`. Duplicate headers, explicit empty identity fields, ambiguous paths, and repeated query keys are rejected.
- Verification precedes identity resolution and state changes. Allowed clock skew is 60 seconds and nonce retention is two minutes. Failure returns 401 with `{error, reason}`, where reason is `claim`, `expired`, `replay`, `mac` or `host`. Signed `GET /bridge/whoami` returns `{hubId, claim, name, role}`. Responses are unsigned.
- Static HTTP MCP configs, where the host sends requests itself and cannot sign, can continue using `x-orrery-bridge` while plaintext compatibility is enabled. The Hub still writes the legacy `<ORRERY_HOME>/hub.json` `{url, secret, pid, hubId}` for older plug-ins; current plug-ins read it only on the explicit legacy fallback. Web API tokens stay separate.
- Version 2 wait tickets scope the signature to the issuing Hub and conversation. `<h>2.<hubId>.<session>.<mac>` signs `orrery-<harness>-wait-v2\n<hubId>\n<session>` with HMAC-SHA256. Call `wait_for_messages` again to replace a v1 ticket or one issued by another Hub.
- A secondary Hub disables native delivery by default. Stop an old delivering Hub before starting the upgraded version, since older versions do not honor the registry.

### Plug-ins: finding the Hub, signing, errors

orrery's own plug-ins (Claude bridge, DeepSeek, Cursor, Qoder, WorkBuddy, Antigravity sidecar and hook, unread-hint hook, wait command) share `plugins/shared/hub-discovery.mjs`; copy-installed plug-ins carry a byte-identical copy in their own folder, and a test checks that the copies match.

- **Which Hub**: every request re-reads the registry and uses the active Hub in `active.json`. `ORRERY_HUB=<hubId or name>` pins one Hub (by hubId the record's own hubId must match; by name only the single record stored under its own hubId counts); if the pinned record is missing, invalid or its process has exited, the plug-in stops and never falls back to the active Hub.
- **Signing**: requests carry `x-orrery-sig` and no `x-orrery-bridge`; the key never goes over the wire. On 401 `reason: claim` (the Hub restarted), the plug-in re-signs and retries once, only if the registry still lists the same hubId and address with a new claim. Only `http://127.0.0.1:<port>` addresses are accepted, without proxies or redirects.
- **Legacy fallback is explicit only**: only with `ORRERY_LEGACY_HUB=<old Hub home>` set, and no running active Hub in the registry, does a plug-in read that home's `hub.json` and send `x-orrery-bridge` the old way. `ORRERY_HOME` no longer matters to plug-ins.
- **Errors** (the messages are in Chinese): when the plug-in stops on its own the text starts with "接入件没有发送请求：" ("the plug-in sent no request: …", for example no active Hub, no valid record for the `ORRERY_HUB` value, key unreadable); a refusal reads "Hub「<name>」拒收：<reason>"; a request sent without a complete answer reads "连不上 Hub「<name>」…" ("cannot reach Hub …"). A failed tool call then says what happened: not sent (safe to retry), refused (it did not run), or sent but the answer was cut off (unknown: check with `read_messages` or `get_task` before retrying a call that posts or changes tasks).
- The Cursor MCP helper slows to one retry about every 60 seconds after a 401 and logs why; the Antigravity hook signs `orreryCaller` with the shared key from `<ORRERY_REGISTRY>/bridge-secret` and never falls back to `hub.json`; the Qoder relay signature covers the body (including `_meta`); the wait command uses the URL and v2 ticket in its command, and only an old command without a URL looks up the address in the registry; the unread-hint hook signs and stays silent on failure.

### Upgrading and rolling back plug-ins

Quit the old Hub before starting the new one. The first upgraded Hub turns its home's old key into the shared key K; every other Hub rewrites its `<home>/secret` to K.

| Install type | Upgrade | Roll back to an older orrery |
|---|---|---|
| Path-referenced: Claude bridge, DeepSeek plug-in, WorkBuddy bridge, unread-hint hook, wait command | Updated with orrery; restart the orrery connection in the host (a DeepSeek plug-in copied elsewhere before installing must be copied again first) | Rolled back with orrery; set `ORRERY_LEGACY_HUB` when a current plug-in must reach an old Hub |
| Copy-installed: Cursor plug-in, Qoder plug-in (ZIP), Antigravity sidecar and hook | **Must reinstall**: copy or package and upload again, then restart the host (in Qoder, also say "join orrery" again) | Reinstall the old copy |
| Static HTTP: Codex `config.toml`, ZCode and Antigravity MCP configs, Kimi Code's optional direct `mcp.json` | Once, replace the `x-orrery-bridge` value with K (Settings → Delivery → Native connections → Show bridge key, or read `<ORRERY_REGISTRY>/bridge-secret`), then restart the host | No change: `<home>/secret` is already K |
| Wait commands (ZCode, WorkBuddy, Qoder) | Old commands report a void ticket; the member calls `wait_for_messages` again | Same |

An old copy that was not reinstalled still reads `<ORRERY_HOME or ~/.orrery>/hub.json` and sends the plaintext key; it keeps working when the home is right, and reinstalling fixes it. Kimi Code delivery uses Kimi's own local server token and is unaffected. These new paths are verified by automated tests only so far.

The loopback bridge endpoints include ("signature or bridge key" means `x-orrery-sig`, or plaintext-compatible `x-orrery-bridge: <shared key>`):

| Route | Auth | Purpose |
|---|---|---|
| `GET /bridge/stream?harness=<h>[&session=<id>&version=<v>]` | Signature or bridge key | SSE delivery stream (per-session for Claude; shared for DSH/Antigravity) emitting `deliver { deliveryId, sessionId, text }` |
| `POST /bridge/ack` | Signature or bridge key | Acknowledges local enqueue `{ deliveryId, ok, follows?, error? }` |
| `POST /bridge/done` | Signature or bridge key | Reports final turn outcome `{ deliveryId, harness, sessionId, outcome, error?, usage? }` when `follows: true` |
| `POST /bridge/unread-hint` | Signature or bridge key | Polled by hooks/plugins for new unread counts across 4 buckets |
| `GET /bridge/<h>-wait` / `POST /bridge/<h>-ack` | HMAC ticket | Background wait route (ZCode / Qoder / WorkBuddy) stream and print ack |
| `POST /bridge/<h>-turn` / `GET /bridge/<h>-park` | Signature or bridge key | Parked hook route (Cursor) turn lifecycle reports and parked channel |
| `POST /bridge/ship-verify` / `POST /bridge/ship-result` | Signed `body.ticket` | Used by `scripts/ship.ts` to query approved merge targets and report merge/failure results |

## Four MCP Authentication Paths

`/mcp` first verifies an `x-orrery-sig` signature or plaintext-compatible `x-orrery-bridge`, then identifies native callers from tamper-resistant host context (`src/mcp/server.ts`). The `x-orrery-bridge` entries below are static configs where the host sends requests itself; orrery's own plug-ins sign instead, with the same identity rules:

1. **Explicit session headers (Claude / DSH / Cursor / WorkBuddy)**: signed requests with `x-orrery-session: <id>` + `x-orrery-harness: <h>`, both covered by the signature (missing harness defaults to `claude`).
2. **Native Codex (bridge secret ONLY + `_meta.threadId`)**: Configure Codex HTTP MCP with **`x-orrery-bridge: <secret>` only**—**never pass `x-orrery-session` or `x-orrery-harness`** (sending `x-orrery-harness: codex` without `x-orrery-session` hits `nobody` and is rejected); the Hub reads runtime `_meta.threadId`.
3. **Runtime `_meta` injection (Qoder / ZCode / optional Kimi direct)**: a signed request from the Qoder relay, or `x-orrery-bridge` from the ZCode and Kimi static configs, each with `x-orrery-harness`, paired with `_meta["com.qoder/turnContext"].sessionId`, `root_session_id` / `session_id`, or `_meta["kimi/sessionId"]` (Qoder ignores any `x-orrery-session` header).
4. **HMAC-signed argument (Antigravity)**: `x-orrery-bridge` + `x-orrery-harness: antigravity` with `PreToolUse` overwriting `orreryCaller`, signed with the shared key in `<ORRERY_REGISTRY>/bridge-secret`.

## Delivery Semantics & Fallback

- **Batching & ambiguity**: Busy members queue new mentions into one envelope upon turn end where supported; disconnects, timeouts, or ambiguous errors mark `outcome: unknown` without auto-retrying.
- **Reply-only fallback**: Stock Kimi Code disables MCP tools and uses `NativeAdapter.replies = true` to post completed main-agent replies back into chat.
