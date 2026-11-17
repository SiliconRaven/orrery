# Collaboration & Task Workflow

Language: [中文](collaboration.md) | **English**

Collaboration runs across three built-in official plugins: `tasks` (`src/plugins/tasks/`), `coordinator` (`src/plugins/coordinator/`), and `bookmarks` (`src/plugins/bookmarks/`). See [Collaboration API](collaboration-api.en.md) for HTTP and MCP schemas.

## Member Roles & Authority

Cluster operations obey role-based policies while keeping the user in final control:

| Role | Scope |
|---|---|
| `coordinator` | At most 1 active coordinator per cluster; plans work, assigns tasks, tunes review settings, and monitors stalls. Cannot act as executor and independent reviewer on the same task. |
| Regular member | Accepts or receives assignments, performs work, submits results, and reviews peers' tasks. |
| `user` | Top-level authority; creates, reassigns, approves proposals, approves/rejects work, or marks tasks completed/merged manually. |

Business roles carry a name and description (`list_tasks` exposes them) and restrict task execution or review eligibility when bound. New clusters initialize three default roles without auto-assigning members.

## Task Lifecycle & Three Review Tiers

Each task gets a sequential per-cluster `#<number>` ID and moves through core statuses (`pending`, `working`, `review`, `completed`, `merged`, `cancelled`):

```text
pending -> working -> review -> completed -> merged
             ^          |
             +-- reject-+

release -> pending
cancel  -> cancelled
reopen  -> pending
```

> Note: User proposal approval (`requiresApproval` / `proposalState`), raised blocker flags (`attention`), and watches (`watch`) are independent state orthogonal to task `status`.

Tasks use one of three `reviewer` configurations:

1. **Member review (`reviewer: { kind: "member", memberId }`, independent)**: Reviewer must never have been an executor or contributor on that task. `submit` (with `summary` and a 7–40 hex `commitSha` when `mergeRequired: true`) enters `review` and wakes the reviewer; once approved (`approve`), the **reviewer** runs `ship` if merging is required, or the task becomes `completed` directly.
2. **Self-review (`reviewer: { kind: "self" }`)**: For docs-only edits, small low-risk changes, or design tasks. On `submit`, the Hub writes a `self: true` approval record and completes the task immediately (if `mergeRequired: true`, the **executor** runs `ship`). Tasks already in `review` cannot switch to self-review.
3. **User review (`reviewer: { kind: "user" }`)**: For UI/visual verification or explicit user sign-off. `submit` stops at `review` for web approval; after approval, the **executor** runs `ship` if merging is required.

- **Dependencies**: Tasks declare upstream links via `dependencyIds`; downstream tasks may start only after all upstream completions are valid and `mergeRequired` predecessors are `merged`.

Omitting `reviewer` when creating a task defaults to user review.

## Takeover (`takeover`) & Reopen

- **Reviewer takeover (`takeover`)**: Available only on tasks configured with a member reviewer (while `pending`, `working`, or `review`; does not require the reviewer to be online). Hands execution specifically to **that existing member reviewer**—never to arbitrary online members. If the follow-up reviewer is omitted, it defaults to `{ kind: "user" }` (`{ kind: "self" }` requires either user execution or the cluster's `takeoverSelfReview` setting).
- Finished or cancelled tasks can return to `pending` via `reopen`.

## Message Routing, Unread Tracking & Notice Batching

| Action | Marked Unread For | Woken For Execution | Notes |
|---|---|---|---|
| Member `@mention` | Mentioned members (`mention`) | Mentioned members (unless `fyi: true`) | Standard targeted ping |
| Member `@all` | All cluster members (`broadcast` if not also `@named`) | **ONLY members explicitly `@named` in the same body** | Pure `@all` wakes nobody |
| Member `fyi: true` | Mentioned members | None, **except** an active sender of `replyTo` who is explicitly `@named` in the body **IS still woken** (`fyiOverridden`) | Never use `fyi` when answering a question |
| Member message without `@` | Nobody (not even coordinator) | None | Logged in history (`history: true`) |
| User message without `@` | All members (`user` bucket) | Per cluster routing | Routed to active coordinator fallback if enabled |
| Direct `to: [names]` | Specified recipients | Specified recipients | Body `@` treated as plain text |
| Receipt (`ack_messages`) | Visible via `history: true` | None | Acknowledgment (`👍`) writes no system chat message |

- **Batching**: System task notices buffer over `noticeWindowMs` (2s) separately from chat (`messageWindowMs` = 10s), capped at `32` notices per batch and `maxNoticeBatchesPerHour = 300` per member.
- **Unread hints**: Successful MCP calls and optional [Unread Hint Hook](adapters/unread-hook.en.md) scripts report changed unread counts across four buckets (`mention`, `user`, `broadcast`, `task_notice`).

## Hidden Members, Labels, Watches & Handover

- **Hidden members (`hiddenAt`)**: **Not merely UI hiding**—the Hub blocks inbound deliveries, rejects all MCP tool calls (including reads) with a hidden notice without acting, prevents new assignments or mentions, and hides the member from peers (visible only to the user and an active coordinator). Existing chat history and open task data remain stored.
- **Global label library & watches**: Colored labels (`task_label_groups` / `task_labels`) span clusters; `watch` / `unwatch` wakes subscribers once when watched tasks terminate.
- **Coordinator & handover**: Supports 8 delegated coordinator toggles, stalled/quota checks, and `GET /api/members/:id/handover` summary exports.
- **Trash & purge**: Soft-deleted clusters move to Trash (`restore` preserves history); `purge` permanently deletes cluster rows and orphaned disk files inside a transaction.
