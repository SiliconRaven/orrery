# Member Activity Observation

Language: [中文](activity.md) | **English**

Activity telemetry is separate from delivery status. `GET /api/activity?cluster=<id>` returns `{members:[{memberId,activity}]}` (omitting `cluster` returns all active members; unknown clusters return an error). `list_agents` includes the same `activity` field per member. DeepSeek Harness provides the first telemetry source; other harnesses report `unknown`.

`activity` contains `state` (`unknown`, `observing`, `stale`, `disconnected`), `source`, `lastSeenAt`, `lastActivityAt`, `event`, and `staleAfterMs`. Timestamps are ISO strings or `null`; `event` is `null` or `{kind,phase,toolName?}` where `kind` is `tool` or `turn` and `phase` is `requested`, `started`, `finished`, or `failed`.

Channel connection status, heartbeats, and tool/turn telemetry never guarantee global session busyness or task completion.

The Hub issues internal observation handles usable only for current members with recorded cluster participation (delivery attempt, message send, explicit read, or ack). A native conversation shared across clusters shares one upstream channel while storing independent snapshots per eligible member without backfilling prior history. The plugin filters by Hub-supplied session IDs and emits only type, phase, and short sanitized tool names (1–64 ASCII alphanumerics, `_`, `.`, `-`; others appear as unknown)—never arguments, outputs, bodies, error text, or raw call IDs.

For DeepSeek, plain `tool/call` maps to `requested` (prior to permission checks or cancelled/unexecuted records) and PTC sub-tool `started` marks dispatch. Explicit failure results record `failed` (missing names stay blank). Explicit turn completion records `finished`, while errors/aborts record `failed`; unknown reasons are never inferred as success. Concurrent finishes may follow model order rather than wall-clock end times; model thinking and user wait prompts are not reported.

Each member retains one latest snapshot; ~15s heartbeats refresh `lastSeenAt` without changing `lastActivityAt` or historical events. Over 45s without response transitions to `stale`, closing sets `disconnected`, and missing/restarted sources stay `unknown`. Reconnecting or eligibility changes rotate temporary source IDs, invalidating stale reports; offline gaps are never backfilled, and post-restart historical timestamps never indicate live online observation.
