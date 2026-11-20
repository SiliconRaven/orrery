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

Under Roles and coordination → Task permissions, the user can choose group roles for creating, executing, and reviewing tasks. An empty list allows all members. Otherwise a member needs any one group role and all roles required by the task itself. Changes apply to new assignments, starts, and member reviews. Work already started can still be submitted. Self review uses execution eligibility. A member selected by the user still needs the relevant roles.

An enabled coordinator follows the group create-role list by default. The user can explicitly enable the role bypass under the existing Task planning permission. Task planning is still required, and Suggest mode continues to create suggestions only.

Deleting a role referenced by group task permissions returns `ROLE_IN_USE`. First remove the role from Task permissions. Saved permissions remain protected while the Tasks plugin is disabled.

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
- **Assignment & Revision Tiers**: Active members may omit `assignmentId` on `start`, unambiguous first-assignment `submit` (`working`/`review`), and their own `release`/`handoff` (resolved to their active assignment and verified by actor identity); after the same member is reassigned on a task, `submit` requires at least the current `assignmentId` or `expectedRevision`. `start`, active `submit` (still guarded by an arrival snapshot against concurrent async submits), `review` (locked by `submissionId`), and `watch`/`unwatch` may omit `expectedRevision` (strictly validated when supplied). Mutating definitions/ownership, closing/reopening, attentions, batch membership, and resubmitting invalidated `completed` results still require `expectedRevision` (and the original `assignmentId` for completed resubmissions).

Omitting `reviewer` when creating a task defaults to user review.

## Takeover, Reject-with-Takeover & Reopen

- **Reviewer takeover (`takeover`)**: Available only on member-reviewed tasks (from `review` or submitted rework `working` for the designated member reviewer, or `pending`/`working`/`review` for the user; offline reviewers allowed). Hands execution specifically to **that member reviewer** and always binds **self-review owned by the taker through merge** (per-cluster settings are retired; explicit non-`self` options or passing the self-reviewed task via `handoff`/`assign` are refused). Product-code changes after takeover emit an `infoOnly` diff notice to the original executor.
- **Atomic reject + takeover**: While in `review`, the member reviewer or user can call `task_action review` with `verdict: "reject", takeover: true` to record the rejection and take over into `working` in one transaction without waking the previous executor.
- Finished, cancelled, or failed-ship unmerged tasks can return to `pending` via `reopen` (reopening a batched task leaves the batch and clears `batch.shipFailure`; reopening from a failed ship automatically reassigns and wakes the prior approved executor when still eligible, or leaves the task unassigned with the reason and reassignment instructions in chat when unavailable).

## Linking Tasks to Local Git Branches

A task can be linked to a local Git repository and branch to locate the work; reviews and `ship` still rely on the commit SHAs they record.

- **Manual link**: in the task details the user picks a repository (candidates come from the group members' project folders, several worktrees of one repository are listed once, and an absolute path to a repository, worktree or subfolder also works) and a local branch (a valid name that does not exist yet is fine too); the current executor can register a branch with `task_action set_git_branch`. `null` clears it. The task history keeps every before and after value.
- **Automatic link on submit**: when the executor submits through MCP `task_action submit` with a `commitSha`, the Hub uses read-only git to find the local branch (`refs/heads/`) whose tip is exactly that commit: in the linked repository if the task has one, otherwise in the executor's own project folder. If exactly one branch matches it is linked and marked "automatic"; a manual link is always kept (with a warning when the branch does not contain the commit); an automatic link that no longer applies is cleared. `gitBranch` in the submit result says what happened (`linked`, `kept`, `cleared`, `not_linked`) and why, for example `no_branch`, `several_branches` or `timeout`.
- The lookup has a total time limit (1.5 seconds) and a concurrency cap; any failure leaves the submission untouched and simply links nothing. Setting a branch by hand turns an automatic link into a manual one; after clearing, the next submission links automatically again.
- The local repository path written into the task is visible to the group's members, as with manual links.

## Review Batches

A review batch is a set of tasks that one reviewer (the user or a member) reviews **together once all are submitted** and merges **together once all pass**. It suits a chain of dependent tasks: the reviewer is not woken again and again and checks do not run many times. Batches are numbered like `B3`; tasks outside batches behave as before.

- **Creating and joining**: the user, a member or a coordinator with the right delegation can create a batch (`manage_batch create`); the reviewer cannot be self-review, the enabled coordinator or a hidden member. A task joins with `batchId` at creation or with `manage_batch add` before work starts by the user, coordinator, or the **batch creator** (cross-creator joining is allowed; however, non-user members get `403 FORBIDDEN` when adding `reviewer: user` tasks into a member-reviewed batch or adding `requiresApproval: true` tasks, and `proposed` tasks fail with `APPROVAL_REQUIRED`); only tasks that need merging and are not self-reviewed can join, and the batch reviewer becomes the task's reviewer. Once the batch has its first review, no task can join. A task can leave before it starts or after it is cancelled (also via batch creator); cancelling the batch returns its tasks to the normal flow with submissions and records intact.
- **Submitting and "complete"**: tasks in a batch go to review on submit, but a member reviewer only gets them unread and is not woken. When every non-cancelled task is submitted (or approved with a still-valid result), the action that completes the batch sends the reviewer **one** wake-up listing every task and reviewed commit. Before that, a member reviewer gets `BATCH_INCOMPLETE` with what is missing; the user can review at any time. Each task still gets its own verdict, and a rejection only returns that task.
- **Dependencies inside a batch**: an upstream task in the same batch counts as ready once it has a valid submission, so the downstream task can start on top of the upstream branch; dependencies in `get_task` carry `batchBase` (the upstream commit and linked branch). When the upstream resubmits, downstream submissions under review expire and approved results become invalid; downstream executors resubmit, declaring the new version in `expectedDependencyVersions`. If an upstream task applies a forward `ship_fix`, downstream tasks in the same uncancelled batch remain `completionValid: true` across both `completed` and `merged` states when citing `originSubmissionId`; explicit `task.reopen` or `manage_batch cancel` breaks that lineage immediately. Dependencies outside the batch still wait for the upstream merge.
- **Merging together & failure recovery**: tasks in a batch cannot ship one by one. Once all pass, `get_batch` (and the result of the last approval or `ship_fix`) gives the runner a batch ship command: the member reviewer runs it if it approved every task, otherwise the executor of the last task in dependency order. The script merges the reviewed commits in dependency order in a temporary worktree, creates **one** merge commit (one `Reviewed-by` line per task), runs the checks once and fast-forwards the target branch only if they pass; the Hub verifies the result and records every task as merged at once. On a conflict or checks failure the target branch is left alone and **all tasks stay `completed`** with structured `shipFailure` metadata and `infoOnly` notices: conflicts isolate the conflicting task for `ship_fix`; checks failures can be rerun verbatim, or the independent batch reviewer may run a one-shot `manage_batch attribute_failure` to unlock targeted `task_action ship_fix` (keeping tasks in the batch and refreshing the `b1.` ticket), or recover via `task_action reopen` / `manage_batch cancel`.
- **Web page**: in the tasks tab each batch is its own group with progress, the reviewer and "Batch details"; the new-task form offers a batch when one can be joined.

## ship and Release

After a review passes, a member runs `scripts/ship.ts` with their own permissions to merge the reviewed commit into the target branch (the repository's `git config orrery.shipBranch`, `main` when unset); the Hub never writes to git. The command comes from the approving `task_action review` result, `task_action ship_fix`, or `get_task` (who runs it follows the three review tiers above). It carries a ticket signed by the Hub; the script takes a lock, runs `merge --no-ff` in a temporary worktree, runs the checks declared in the repository's `.premerge/checks.json` (skipped for docs-only changes, retried once on failure; before rerunning, attempt-1 `.tmp/test-logs/*.log` and `.tmp/*-shots/` screenshots are snapshotted, and if checks fail twice, both attempts are preserved under `attempt-1/` and `attempt-2/` in `.tmp/ship-failures/` before removing the temporary worktree, rotating to the newest 10 runs, redacting tokens/secrets/tickets, logging the full path only to local stderr, and attaching a failed-test summary plus relative/redacted paths to the shared failure detail), fast-forwards the target branch only if they pass, and pushes automatically only when the target is `main`. On a conflict or failed checks the target branch is left alone, **the task stays `completed` with its `approvedSubmissionId` intact** and records structured `shipFailure` (`conflictFiles`, `failedCheck`) plus `infoOnly` unread notices: the runner may rerun verbatim, or an authorized independent member reviewer / bound self-review executor can call `task_action ship_fix` (verified fail-closed with `git merge-base --is-ancestor` and appending `, ship fix` to `Reviewed-by`; forbidden for user-reviewed/user-approved tasks and HTTP `{ kind: "user" }` callers), or recover via `task_action reopen`. The Hub verifies the result with read-only git before recording the merge.

`node scripts/ship.ts --release --user-approved …` merges the ship target branch into `main` (a release) under the same lock and checks, without the Hub; run it only when the user explicitly asks for a release.

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
