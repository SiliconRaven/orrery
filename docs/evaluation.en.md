# Reproducible Collaboration Benchmark

Language: [中文](evaluation.md) | **English**

Run `npm run --silent bench:collaboration` (or `node scripts/bench-collaboration.ts`) with Node 24 (`--silent` keeps npm banner text out of JSON stdout).

The script runs three fixed mock scenarios using separate temp directories, SQLite databases, and random loopback ports (never `4317`), reusing `test/helpers.ts` mock workers and manual turn barriers (`ORRERY_KEEP_TEST_TEMP=1` retains temp artifacts):

| Scenario | Fixed Steps & Assertions |
|---|---|
| `directed-relay` | User sends to A over HTTP; A pings B via MCP; B replies to A via MCP. Asserts message text/recipients, 3 turns, and 0 deliveries to bystander C |
| `paused-batch` | Holds A's turn 1 at a barrier, enables **global delivery pause**, posts 2 messages for A, then releases turn 1. Verifies queuing until unpaused, **two deliveries share one turn**, one attempt per message, and 2 total turns |
| `task-once` | Mock native member creates, starts, and submits a task twice with the same `operationId`. Verifies self-approval fails, designated reviewer approval succeeds, and exactly 1 submission/review/assignment exists |

Stdout outputs one JSON object (`schemaVersion`, `passed`, and `scenarios` metrics); stderr logs PASS/FAIL summaries, exiting `0` on pass or `1` on failure.

Metrics track `messages` (including system notices), created `deliveries`, mock `turns`, distinct non-empty `batches`, `maxHop`, and task counts where relevant; `durationMs` is for same-machine comparison only (wait timeouts catch stalls rather than serving as performance SLAs). These runs evaluate Hub scheduling determinism and call overhead only—they never start native apps or live models, and cannot predict real-model quality, host-app reliability, or production disk throughput.
