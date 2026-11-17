# Cluster Members, Hidden State & Handover

Language: [中文](cluster-members.md) | **English**

## Adding, Rebinding & Hiding Members

Every member attaches in **Native Mode (`mode: "native"`)** (omitting `mode` defaults to `"native"`, other values are rejected, and the UI omits mode switching):

- **Creating vs attaching**: Supporting adapters (e.g. Codex) can create a new native session given an explicit **`projectPath`**; attaching an existing conversation reads `cwd` from the host adapter store. One native conversation can join multiple clusters, with renames and avatars saved via `PATCH /api/members/:id`.
- **Avatars**: **No built-in character preset illustrations are bundled**; users may upload custom avatars or fall back to each app's identification icon and member mark.
- **Session rebind (`POST /api/members/:id/session`)**: Moves a member to another session on the same harness (`confirmStopped` required if a prior delivery may still be active).
- **Hidden members (`POST /api/members/:id/hidden`)**: Unlike visual hiding, **the Hub enforces hidden boundaries in both scheduling and `/mcp`**: hidden members receive no deliveries, every MCP tool call (reads included) returns the hidden notice without acting, new assignments/mentions are barred, and peers cannot see them (only the user and an active coordinator can). Existing messages and tasks stay preserved.

## Handover Packages (`GET /api/members/:id/handover`)

Builds a read-only summary strictly from Hub records (no model calls, no unread-queue scraping, no reading host app files):

- **Recent user `requests`**: Up to 5 newest user message excerpts in the cluster;
- **Attached & recent `tasks`**: Status, member role, latest submission `summary`, `commitSha`/`mergedCommitSha`, latest `review`, and unresolved attention `questions`; **`branch` and `commands` are always `null`** (Hub stores neither Git branches run inside tasks nor shell command logs, so operators supplement them manually if needed);
- **Recent `deliveries`**: Recent failed, offline, or unknown deliveries with message excerpts.

## Card Presence & Activity Caveats

- **Native `busy` / `idle` indicators**: Reflect **Hub delivery channel state only**—never proof of whether the host app's model is actually idle on the user's machine.
- **Activity observation (`GET /api/activity`)**: Only harnesses providing an observation source (currently DeepSeek Harness `dsh-orrery` only) emit tool/turn telemetry; all others report `unknown` ([Activity Observation](activity.en.md)).
- **Usage display**: Shows per-turn tokens, session totals, and subscription quotas strictly where supported read-only ([Usage & Quotas](usage.en.md)).
