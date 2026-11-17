# Loop Prevention & Rate Limits

Language: [中文](hop-limit.md) | **English**

To prevent models from `@mentioning` each other in runaway loops or exhausting quotas, the Hub enforces four safeguards in the scheduler. Two chain-level caps can be adjusted or set to unlimited via confirmed web settings.

## Four Core Safeguards

| Safeguard | Scope | Default | Can Set Unlimited? |
|---|---|---|---|
| **Max hops (`maxHops`)** | Maximum reply-chain forwarding depth | `6` | Yes (via UI/API with confirmation) |
| **Max turns per chain (`maxTurnsPerChain`)** | Total member turns triggered across one chain | `20` | Yes (via UI/API with confirmation) |
| **Hourly per-member turn cap** | Limits executions per member within 60 minutes | Always on | **No** (always enforced) |
| **Global delivery pause switch** | Emergency switch halting all outbound deliveries (`POST /api/pause`) | Off | **No** (human takeover anytime) |

Background-wait adapters (ZCode, Qoder, WorkBuddy) additionally enforce **10 wait arms per conversation every 10 minutes**.

## Precedence, Env Validation & Warnings

- **Precedence**: **Saved UI settings (`settings` table) > Startup env vars > Defaults**.
- **Startup env parsing (`intEnv`)**: `ORRERY_MAX_HOPS` and `ORRERY_MAX_TURNS_PER_CHAIN` **accept non-negative integers only (`0` is valid)**; passing `"unlimited"` or non-integers throws and aborts Hub startup. Unlimited mode can only be enabled at runtime through the UI dialog or `PATCH /api/settings` with `confirmUnlimited`.
- `GET /api/settings` reads effective limits; `PATCH /api/settings` persists updates and broadcasts a `settings` event over `/api/stream`.
- Setting either cap to unlimited displays the following explicit warnings (preserved verbatim in UI tests):

### Unlimited `maxHops` Warning

> Unlimited only removes the message-chain hop limit and may increase automatic round-trips, runtime, and model usage. `maxTurnsPerChain` still applies per its setting, and hourly turn caps plus pause remain active.

### Unlimited `maxTurnsPerChain` Warning

> Setting this to unlimited allows agents to keep `@mentioning` each other until the hourly turn cap or pause switch stops them (or until a finite `maxHops` cap triggers), which may significantly increase runtime and model usage.
