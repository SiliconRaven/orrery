# Quotas & Token Usage

Language: [中文](usage.md) | **English**

orrery tracks per-member token usage and subscription quota windows in the web UI so users and enabled coordinators can monitor native session headroom.

## Data Sources per Harness

| Harness | Subscription Quota | Per-Turn Tokens | Session Total Tokens |
|---|---|---|---|
| **Claude Code** | Yes (`get_usage`, cooldown-guarded) | **No** (bridge confirms inbox write only, not turn end) | Yes (read-only transcripts deduplicated by `message.id`) |
| **Codex** | Yes (local `rollout-*.jsonl`; manual refresh runs read-only `account/rateLimits/read`) | Yes (`turn_token_usage`) | Yes (cached input subtracted) |
| **Kimi Code** | Yes (`GET /api/v1/oauth/usage` on verified local instance, 5m auto / 10s manual) | Yes (`stepId` deduplicated) | Yes (`wire.jsonl` incremental tail) |
| **DeepSeek Harness** | Unsupported (API metered; keys untouched) | Yes (reported on `done`) | Yes (`tokenUsage` cache projection) |
| **Cursor** | Unsupported (never reads `state.vscdb` login tokens) | Yes (`stop` hook report; cache subtraction inferred) | Unsupported |
| **ZCode** | Unsupported | Unsupported (turn still active on re-arm) | Yes (`turn_usage` read-only copy sum) |
| **WorkBuddy / Qoder / Antigravity** | Unsupported | Unsupported | Unsupported |

- **Why Antigravity is unsupported**: Public `agentapi` exposes no quota command; internal language-server RPCs are never called.
- **Accounting scope**: Cursor's basic counts have been checked against its UI. Kimi and DeepSeek report real per-turn usage; detailed cache and multi-tool accounting should be interpreted separately from delivery status.

## Storage, Alert Rules & Privacy

- **Persistence**: Normalized `TokenTotals` (`input`, `cachedInput`, `cacheWrite`, `output`, `reasoning`) persist in `turn_usage` and `quota_snapshots`.
- **Two distinct alert behaviors**:
  - **Quota low/exhausted notifies coordinators**: When `coordinator` is enabled and a window hits >= 90% or >= 100%, the Hub posts a coordinator notice (exhausted members are excluded from idle-work candidates).
  - **Dialogue-length alerts are UI-only**: Default thresholds are `20,000,000` per turn and `200,000,000` total (`0` disables). Exceeding them displays a suggestion strictly **on the web UI member row and member page**—never posts chat messages, wakes the coordinator, triggers handover, or auto-throttles.
- **Privacy**: Stores numeric counts only; never captures prompts or credentials.

## HTTP API

- `GET /api/usage`: Latest quota snapshots and per-member totals (optional `?cluster=<id>`).
- `GET /api/usage/turns`: **Requires both `clusterId` and `memberId`** (optional `limit` 1–100, default 10) for per-turn usage rows.
- `POST /api/usage/refresh`: Triggers cooldown-guarded live quota refresh on supporting harnesses (Codex, Kimi, Claude).
