# Collaboration & Task API Reference

Language: [中文](collaboration-api.md) | **English**

This reference documents the Web HTTP routes, Bridge endpoints, and member MCP tools exposed by `/mcp`. All `/api/*` routes bind to `127.0.0.1` and require auth (except `POST /api/session`, which exchanges the token for a session cookie).

## Web HTTP Endpoints

### Clusters, Members & Core Controls

| Method & Path | Description |
|---|---|
| `GET /api/clusters`, `POST /api/clusters` | List active clusters (`?deleted=true` for trash); create cluster (`{ name, members }`: `mode` defaults to and accepts only `"native"`; new native sessions require explicit `projectPath`, attached ones read `cwd` from host app) |
| `PATCH /api/clusters/:id`, `DELETE /api/clusters/:id` | Update `{ category, name, pinned, archived }` or soft-delete to trash |
| `POST /api/clusters/:id/restore`, `POST /api/clusters/:id/purge` | Restore from trash, or purge permanently with `{ name, trashVersion }` |
| `POST /api/pause` | Global delivery pause toggle (`{ paused: boolean }`) |
| `POST /api/clusters/:id/members`, `DELETE /api/clusters/:cid/members/:mid` | Add or remove cluster members |
| `PATCH /api/members/:id` | Rename member or update avatar (`{ name, avatar }`) |
| `POST /api/members/:id/session`, `GET /api/members/:id/session-history` | Rebind a native member's session or inspect rebind history |
| `POST /api/members/:id/hidden` | User hides or un-hides a member (`{ hidden }`) |
| `GET /api/members/:id/handover` | Generate read-only member handover package |
| `GET/POST/PATCH/DELETE/PUT /api/cluster-groups` | Manage and reorder sidebar cluster groups (`PUT` reorders) |
| `GET /api/usage`, `GET /api/usage/turns`, `POST /api/usage/refresh` | Usage/quota queries; `/api/usage/turns` **requires both `clusterId` and `memberId`** (`limit` 1–100) |
| `GET /api/stream` | Live SSE event stream (`?since=` resume) |

### Collaboration Workspace, Tasks, Labels & Delivery Diagnostics

| Method & Path | Description |
|---|---|
| `GET /api/clusters/:id/workspace` | Reads cluster tasks (`?holder=`, `?sort=`, `?pageOnly=1`), roles, policy, and label selection |
| `POST /api/clusters/:id/collaboration` | Executes full HTTP collaboration commands: `task.*` (`task.create`, `task.assign`, `task.start`, `task.submit`, `task.review`, `task.merge`, `task.release`, `task.cancel`, `task.reopen`, `task.handoff`, `task.takeover`, `task.set_git_branch`), `role.*`, `label.*`, `coordinator.*`, `cluster.pause`, `tasks.settings`, plus **user-only** `task.delete`, `task.mark_completed`, `task.mark_merged`, `task.approve` |
| `GET /api/clusters/:id/tasks/:taskId` | Reads task detail, assignments, submissions, reviews, history, and dependencies (`#number`, UUID, or unique 8+ char prefix) |
| `GET /api/clusters/:id/tasks/:taskId/context` | Reads curated task context, linked files, and events |
| `GET /api/clusters/:id/tasks/:taskId/events/:eventId` | Reads payload and `changes` of a single collaboration event |
| `GET /api/clusters/:id/task-repositories` | Lists Git repositories and branches from cluster members' project folders |
| `GET /api/stalled` | Global read-only hints for stalled members and `hidden_work` across unpaused clusters |
| `GET /api/labels`, `POST /api/labels` | Reads or updates the global label library as the user |
| `GET /api/clusters/:id/task-refs` | Resolves `#<number>` task summaries |
| `GET /api/clusters/:id/collections` | Lists cluster bookmarks |
| `GET /api/clusters/:id/messages/search` | Searches full cluster history (`q`, `sender`, `category`, `from`/`to`, `files`, `limit`, `cursor`) |
| `POST /api/clusters/:id/deliveries/:deliveryId/resend`, `.../handoff` | User retries a failed/offline/unknown delivery or hands off to another conversation |
| `GET /api/clusters/:id/deliveries/:deliveryId/timeline`, `.../messages/:messageId/delivery-timelines` | Inspects per-delivery or per-message timelines |

## Bridge Collaboration Endpoints

- **`POST /bridge/ship-verify` and `POST /bridge/ship-result`**: Called by `scripts/ship.ts` using **signed `body.ticket` auth** (no `x-orrery-bridge` secret; `403` on bad ticket, `409` on state conflict):
  - `ship-verify` `{ ticket }`: Read-only **query** returning `{ taskId, shortId, commitSha, reviewer, round, verdict: "pass" | "self" }` for the approved submission (does not submit check status).
  - `ship-result` `{ ticket, mergeCommit, pushed, retried? }` or `{ ticket, failed: { kind: "conflict" | "checks", detail } }`: Reports merge outcome so Hub verifies Git ancestry read-only and marks `merged` or returns the task to the executor.
- **`POST /bridge/unread-hint`**: Polled with `x-orrery-bridge` and `{ harness, session }`; returns `{ hint }` categorized into 4 buckets (`mention`, `user`, `broadcast`, `task_notice` with `fyi`/`offline`/`failed_or_unknown`/`blocked` notes) when unread items remain and their breakdown has changed since the last hint, else `{}`.

## Member MCP Tools (21 Standard / 22 Wait Route)

`standard` members see **21** tools; background-wait routes (ZCode / Qoder / WorkBuddy) also expose `wait_for_messages`, for **22** total. Collaboration command tools require `operationId`; chat uses `clientMessageId`, and acknowledgements use message IDs. Mutating an existing task requires `expectedRevision` from `get_task` (except `watch` / `unwatch`); coordinator actions require `generation` from `list_tasks.coordinator.generation`.

### Chat, Receipts & Wait (6 / 7 Tools)

| Tool | Parameters & Behavior |
|---|---|
| `list_agents` | Lists cluster members, presence, roles, and task load |
| `send_message` | Posts chat messages: `body` parses `@name`, `@all` (wakes only explicitly `@named` members), and `#number`; `to: string[]` delivers directly and treats body `@` as plain text; `replyTo`; `taskIds`; `attachments` (bare file names copied into member outbox, max 10, 20 MB each); `clientMessageId`; `fyi: true` logs unread without waking (forbidden when answering a question; explicitly `@named` active `replyTo` senders are still woken and listed in `fyiOverridden`) |
| `read_messages` | Defaults to relevant **unread** messages since join; set `history: true` for chat history; filters `before`, `since`, `until`, `q`, `sender`, `mentions`, `category` (`mention`/`user`/`broadcast`/`task_notice`/`receipt_warning`/`warning`), `detail` (`summary`/`full`) |
| `skip_unread` | Marks relevant unread up to `before`, `until`, or matching `category` skipped (no ack written) |
| `get_deliveries` | Queries delivery states for `messageId`: `status` (`queued`, `running`, `done`, `failed`, `offline`, `superseded`, `blocked`) and `outcome` (`accepted`, `completed`, `failed`, `unknown`, `null`) |
| `ack_messages` | Writes read acknowledgements (`👍`) for 1–100 `messageIds` without extra chat messages |
| `wait_for_messages` | Wait-route only: issues the signed local wait command for this conversation |

### Tasks, Labels, Roles & Bookmarks (15 Tools)

| Tool | Parameters & Behavior |
|---|---|
| `create_task` | Creates a task: `title`, `scope`, `acceptance`, `reviewer` (`{ kind: "user" | "self" }` or `{ kind: "member", memberId }`), `priority`, `mergeRequired`, `requiresApproval`, `dependencyIds`, `executeRoleIds`, `reviewRoleIds`, `memberId`, `labels`, `fileIds`, `operationId` |
| `list_tasks` | Filters cluster tasks (returns `coordinator.generation`) |
| `get_task` | Reads full task metadata, assignments, submissions, reviews, `watchers`, `gitBranch`, and `ship` guidance |
| `get_task_context` | Aggregates related tasks and approved upstream context |
| `task_action` | Short actions: `edit`, `assign`, `start`, `submit` (**requires `assignmentId` and `summary`**, plus `commitSha` when `mergeRequired`), `review` (**requires `submissionId`, `verdict: "approve" | "reject"`, and `reason`**), `merge`, `release`, `cancel`, `reopen`, `handoff`, `takeover`, `nominate`, `claim`, `set_git_branch`, `watch`, `unwatch`. Does NOT accept `block`, `unblock`, `mark_completed`, or `mark_merged` (the latter two are HTTP `task.*` commands only) |
| `set_task_summary` | Updates structured delivery summary |
| `raise_attention` / `resolve_attention` | Raises or clears blocker/question notices |
| `link_message_tasks` | Links chat messages to task IDs |
| `list_labels` / `manage_labels` | Reads or manages the global label library and groups |
| `manage_roles` | (Coordinator + `generation`) Creates/edits/deletes business roles or assigns `roleIds` |
| `set_cluster_paused` | (Coordinator + `generation`) Toggles cluster pause (`paused`) or hides/unhides members (`memberId`, `hidden`) |
| `list_bookmarks` / `bookmark_message` | Lists or saves messages to cluster bookmarks |

When dependency versions change or an invalidated completion is resubmitted, review the upstream outputs with `get_task_context`. Supply `submit.expectedDependencyVersions` as a map from each dependency task ID to its current `approvedSubmissionId`; otherwise the command returns `DEPENDENCIES_CHANGED`.
