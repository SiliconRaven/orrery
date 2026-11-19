# Cluster Members, Hidden State & Handover

Language: [中文](cluster-members.md) | **English**

## Adding, Rebinding & Hiding Members

Every member is a native conversation. The old isolated mode is gone: when a database upgrades to schema v30, old isolated members still in a group are removed, each affected group gets a system note, and the records are kept (see [Architecture](architecture.en.md#storage--migrations)).

- **Creating and attaching**. Adapters that support creation, such as Codex, require explicit `mode: "native"` and a non-empty `projectPath`. Attach existing conversations by `sessionId`; the adapter reads their `cwd` from the host app. Member responses omit `mode`. One native conversation can join multiple clusters, with renames and avatars saved via `PATCH /api/members/:id`.
- **Rename notices**. Renaming a visible member adds a bilingual system message with the old and new names to the chat and the visible members' unread lists. Future deliveries use the new name in their headers. Keeping the same name, changing only the avatar, and renaming a hidden member produce no chat notice. Member editing is disabled for clusters in the recycle bin.
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
