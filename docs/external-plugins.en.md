# Third-Party Plugins (Experimental API v1)

Language: [中文](external-plugins.md) | **English**

orrery (`v0.10.0-beta.2` Beta pre-release) can run third-party Hub plugins that live outside the repository. There are two tiers:

| | Restricted plugin | Full-trust plugin |
|---|---|---|
| Where the code runs | A separate Node child process talking line-delimited JSON-RPC 2.0 over `stdin`/`stdout` | Inside the Hub process, after the user confirms it in Settings |
| Data it can reach | Only the permissions, event types and groups the user granted | Everything in the Hub database; the same power as orrery itself |
| Web UI | Its own page in a sandboxed frame (`<iframe sandbox="allow-scripts">`), plus small marks drawn by orrery | An optional same-page web module using the official web slots |
| Installation | From Settings, or a manual registration | Manual registration only (`"trust": "full"`), then confirmation in Settings |

> **Only run code you trust.** Plugins run under the same OS account as the Hub. A separate process is fault isolation, **not a security sandbox**: the grants below only limit what a plugin can do through the orrery protocol; they cannot stop it from reaching the account's files, network and programs directly. The Hub never scans folders or auto-updates plugins. The design credits the MIT-licensed reference implementation `deepseek-harness` `dsh-v0.2.1-rc.2` (Copyright (c) 2026 DeepSeek). See the [Security Model](security.en.md) for what each tier promises.

The interface is experimental and still evolving during the Beta; `apiVersion` is `1`. Every addition is backward compatible: old plugins and old registrations keep working, and new notifications or methods only reach plugins that declare or request them.

## Installing from Settings (restricted plugins)

1. Open **Settings → Plugins** and enter a GitHub repository, branch, tag or archive URL, a public npm package name (optionally with `@version` or a tag), an HTTPS package URL, or pick a local ZIP/tgz. If the package holds several manifests, choose one first.
2. Review the manifest, version, resolved source and dependencies. Tick the permissions, events, tools, UI positions and readable/writable groups you want to grant. Preparing only reads and unpacks; every grant starts empty.
3. Click **Confirm install**. The Hub checks the reviewed package and writes a restricted registration; public npm dependencies are installed only after confirmation, with npm lifecycle scripts disabled. Exit and reopen Orrery to load it.

Limits: 32 MiB per download or upload; at most 128 MiB unpacked, 5,000 entries and 32 MiB per file; a prepared review stays valid for 30 minutes and cancelling removes the staged files. The installer only writes restricted registrations and keeps existing full-trust entries.

## Manifest preflight

Before registering, check a local manifest from the repository root:

```sh
npm run plugin:inspect -- examples/hub-plugins/message-counter/orrery-plugin.json
npm run --silent plugin:inspect -- --capabilities
```

The first command applies the Hub's manifest and entry checks and lists dependencies, requested permissions, subscribed and published events, commands, member tools, UI positions and configuration fields; it exits 0 on success and non-zero with a reason otherwise. It only reads the manifest and entry metadata and never runs the plugin. The second prints, as JSON, what this version supports: API version, permissions, UI positions, command parameter types, configuration field types and mark states.

## Manual registration and grants

Put an `orrery-plugin.json` manifest in the plugin folder and register it in `<ORRERY_HOME>/external-plugins.json`:

```json
{
  "plugins": [
    {
      "manifest": "C:/plugins/my-plugin/orrery-plugin.json",
      "permissions": ["clusters.read", "messages.read", "events.read"],
      "events": ["task.*"],
      "clusterIds": ["<group IDs it may read and receive events from>"],
      "writeClusterIds": []
    }
  ]
}
```

A manifest:

```json
{
  "id": "message-counter",
  "version": "1.0.0",
  "name": "Message counter",
  "description": "Counts senders over the latest 100 messages of a group.",
  "apiVersion": 1,
  "entry": "main.mjs",
  "permissions": ["clusters.read", "messages.read"],
  "commands": [{ "id": "count", "title": "Count recent messages" }]
}
```

- `id` and command IDs are 1-64 lowercase letters, digits or `-`, starting with a letter. `entry` is a `.js`, `.mjs` or `.cjs` inside the plugin folder, also after resolving links. The Hub starts it with its own Node, without a shell.
- Optional: `requires` (official or third-party plugins it depends on), `icon` (a png/webp/ico/svg inside the folder, up to 256 KiB, only shown in an `<img>` on the card), `details` (card text, plain text or the chat Markdown subset, up to 4000 characters), `shutdownGraceMs` (stop grace, 100-30000 ms, default 5000).
- The manifest's `permissions` is a **request**; the registration's `permissions` is the **grant** and must be a subset. Omitting permissions, events, groups, tools or UI positions means an empty list, **not everything**.
- Permissions: `clusters.read` (group and member lists), `messages.read` (message pages and single messages), `events.read` (subscribe), `events.publish` (publish own events), `messages.send` (post), `messages.mention` (posts may wake members), `messages.gate` (message checks), `tools.provide` (member tools), `ui.show` (web UI and marks).
- `clusterIds` is the read allow-list (up to 100 entries, no wildcards) and decides where reads, events, message checks, tools and the web UI apply; `writeClusterIds` separately lists where the plugin may post. New groups are never granted automatically, and deleted groups stop working even if still listed.
- At most 16 plugins and 32 commands each; registration and manifest are each limited to 64 KiB.

**Fault isolation and registration diagnostics**: a broken `external-plugins.json` (invalid JSON, wrong shape, more than 16 plugins) still stops the Hub from starting. A problem with one plugin (unreadable manifest, deleted folder, entry outside the folder, wrong permissions, missing or circular dependency) only skips that plugin and plugins depending on it; the reason goes to the Hub log and everything else starts. Plugins with a readable manifest show as `failed` in Settings; unreadable or conflicting registrations show as read-only "registration failed" cards with the entry number, manifest path and reason. The authenticated `GET /api/plugins` returns them as `skippedRegistrations`. Changes to a manifest, permissions or groups take effect after **Restart** on the plugin card (or a Hub restart); a newly registered plugin needs a Hub restart.

## Process protocol

One JSON-RPC 2.0 message per line; requests carry a non-empty string `id`. stdout is for the protocol only; logs go to stderr (the Hub neither stores nor forwards them). Frames are at most 64 KiB, at most 16 Hub requests per plugin may be pending, and output is limited to 200 frames per second. Plugins do not inherit the Hub's environment variables or credentials.

Hub → plugin: `initialize` (actual grants only; the plugin may request the `message.check.result`, `writeSettings.changed` and `command.cancel` notifications through `notifications` in its result), `invoke` (commands), `shutdown`, `message.check` (message checks), `tool.call` (member tools), `ui.request` (web UI requests), plus the notifications `event` and `config.changed`.

Plugin → Hub (by grant):

| Method | Permission | Purpose |
|---|---|---|
| `host.clusters.list` | `clusters.read` | Non-deleted allow-listed groups `{id,name}` |
| `host.members.list` | `clusters.read` | Current members' `id,name,harness,status,hidden,roles` (no session IDs, working directories, avatars, models or tokens) |
| `host.messages.list`, `host.messages.get` | `messages.read` | A recent page or one message; bodies over 8000 characters are truncated, Hub-generated system bodies are omitted (`bodyOmitted`) |
| `host.messages.send` | `messages.send` | Post to a write group |
| `host.events.publish` | `events.publish` | Publish an own event |
| `host.ui.push`, `host.ui.chip`, `host.ui.mark` | `ui.show` | Push data to its own pages, set the title-bar chip text, set a mark |

Refusals are a uniform `-32000` error; some methods add a stable short code in `error.data.code` (`PERMISSION_DENIED`, `INVALID_DATA`, `CLUSTER_NOT_GRANTED`, `NOT_FOUND`, ...). Reading never marks messages read, acknowledges them or triggers delivery. The protocol never exposes file paths, attachment contents, member working directories, native session IDs, credentials, the database or arbitrary SQL. Timeouts, process exit, bad frames, oversized output or output floods mark the plugin `failed` and end its process; the Hub and other plugins keep running.

## Posting (`messages.send`)

With `messages.send` granted and the group listed in `writeClusterIds`, a plugin can post (bodies up to 8000 characters; optional `causedBy` must be an existing message in the same group, and the post continues its chain). Posts are signed "plugin <id>" with message kind `plugin`. By default `@` is plain text; to wake members, also grant `messages.mention` and turn on wake-ups under **Settings → Plugins → Posting settings**. Wake-ups still obey pause, online checks and loop limits. The default limit is 10 posts per minute and 200 per hour per group, adjustable; unlimited needs confirmation. Over the limit the call fails and the group gets a rate notice that wakes nobody.

When a member reads a plugin's message the text enters the model context; treat it as a teammate's request and keep following the user's grants and app approvals.

## Message checks (`messages.gate`)

For "referee" plugins (for example "after the host speaks, everyone may reply once"). After a member's message passes the Hub's own checks and before it is stored, the Hub asks every running plugin with this grant in that group, in parallel:

- The request carries the sender, mentions and recipients, `fyi`, `replyTo`, the attachment count and the body length; the body only if the plugin also has `messages.read`. Each check has a `checkId`.
- Answer `{allow:true}` to allow or `{allow:false, reason}` to refuse (reason up to 300 characters, written into the group's refusal record). Plugins cannot rewrite messages.
- **Everyone must allow.** A refused message is not stored or delivered; the sender gets `REFUSED_BY_PLUGIN` and the reason; the group gets a system record without the body.
- **No answer means allow (fail-open)**: if the plugin is not running, does not answer within 1.5 seconds or answers in a bad shape, the message goes out and a "plugin did not finish its check" record is kept. One timeout does not stop the plugin; three in a row stop it (`CHECK_TIMEOUT`).
- Plugins that requested `message.check.result` get the outcome (`stored:true` with `messageId`, or `stored:false` with `refused_by_other`/`rejected_by_hub`); asked plugins subscribed to `message.created` see the same `checkId` in the event.
- Messages from the user, the system and plugins, and the user's resends and handoffs, are not checked.

## Event subscription and publishing

**Subscribing (`events.read`)**: the core and official plugins publish by event type; a plugin receives what its granted patterns match. A pattern is an exact type (`task.approved`), a prefix (`task.*`, which includes types added later with that prefix) or `*`; each granted pattern must be covered by a requested one. When an official plugin is disabled, its event types do not exist.

Event catalogue (fields may be added to `data` later, never removed or renamed):

| Type | Owner | When |
|---|---|---|
| `message.created` | Core | A new message appears in the group (from a member, the user, a system notice or a plugin); carries the body with `messages.read` |
| `message.read` | Core | A member read messages |
| `message.acknowledged` | Core | A member acknowledged messages with `ack_messages` |
| `member.status` | Core | A member's status changed (`idle`, `busy`, `offline`) |
| `member.joined` | Core | A member joined the group |
| `member.removed` | Core | A member was removed from the group |
| `member.updated` | Core | A member was renamed, hidden or shown again |
| `member.roles` | Core | A member's roles changed |
| `role.changed` | Core | A role was created, redescribed, deleted, or the default roles were restored |
| `cluster.updated` | Core | The group was renamed, regrouped, pinned, archived, the user's read position moved, or it was restored from the trash |
| `cluster.paused` | Core | Delivery in the group was paused or resumed |
| `hub.paused` | Core (global) | The user switched "pause all delivery" on or off |
| `delivery.updated` | Core | A delivery's state changed (no error text) |
| `guard.triggered` | Core | A loop or rate limit was hit |
| `task.created` | Tasks plugin | A task was created |
| `task.submitted` | Tasks plugin | The executor submitted a result |
| `task.approved` | Tasks plugin | The review passed (self-review tasks pass on submit) |
| `task.rejected` | Tasks plugin | The review rejected the result |
| `task.merged` | Tasks plugin | The task was recorded as merged (batch merges push one per task) |
| `task.changed` | Tasks plugin | Any other change (assignment, start, edits, cancel, reopen, handoff, batch changes...), with `action` naming it |
| `task.deleted` | Tasks plugin | A task was deleted |
| `bookmark.saved` | Bookmarks plugin | A member bookmarked a message or changed its labels |
| `bookmark.removed` | Bookmarks plugin | A member removed a bookmark |
| `coordinator.changed` | Coordinator plugin | The coordinator was set, replaced or disabled, or the standing instructions changed (their text is not in the event) |

Hub events that are never pushed: members' raw output streams, global Hub settings, account quotas, page hints, and group creation and deletion. Types third-party plugins publish themselves (`plugin.<id>.<name>`) are covered under "Publishing" below.

Events carry full content (copied field by field from an allow-list): granting task events lets the plugin read task titles, scope, acceptance criteria, review comments and commit SHAs. Message bodies additionally need `messages.read`. Events are pushed after the transaction commits, through a per-plugin queue of up to 256 events; when it is full the oldest is dropped and the next event reports `dropped`. A stuck plugin only loses its own events and never slows the Hub. There is no history replay, and a plugin never receives events for its own posts.

**Publishing (`events.publish`)**: declare types in the manifest's `publishes` (`name`, `description`, optional `fields`; up to 32). The full type name is always `plugin.<plugin id>.<name>`. `host.events.publish {type, clusterId?, data}`: an event with a group may only target a granted read or write group; without a group it is global. `data` is up to 16 KiB and is neither interpreted nor stored. At most 60 publishes per plugin per minute. Publishing creates no messages, wakes nobody and is not forwarded to the web page or official plugins. Subscribers must treat `data` as untrusted input.

## Commands

Each entry in the manifest's `commands` may declare a `description`, typed `params` (`text`, `number`, `duration`, `boolean`, `member`, `enum`; up to 16), `clusterScoped` (default `true`) and `longRunning`.

- **Running in a group**: type `/` at the start of the composer in a granted (read or write) group and pick a command; a form opens above the composer when it has parameters. The command itself is never posted. Enter only runs a command when a menu item is selected or the full command name is typed; otherwise the text is sent as a normal message. The plugin receives `invoke {command, arguments, context:{clusterId, by:"user", at, runId}}` with arguments already checked by the Hub.
- **Long-running commands**: commands with `longRunning: true` may answer `{accepted:true}` and then report with the notifications `command.progress {runId,text,fraction?}` and `command.done {runId,ok,text?,data?}`; the user can cancel (plugins that requested `command.cancel` are notified). A run lasts at most 30 minutes, at most 4 per plugin at once, and lives only in Hub memory.
- Progress shows as a small chip in the group title bar; the result is a page notice for the user only. Runs never write to the chat, wake members or use loop budget.
- Only the user (API token) can run commands: `GET /api/clusters/:id/plugin-commands`, `POST /api/clusters/:id/plugin-commands/run`, `POST /api/clusters/:id/plugin-runs/:runId/cancel`. The older `POST /api/plugins/:id/invoke` has no `context` and no argument checks.

## Member tools (`tools.provide`)

A plugin can give tools to members of its granted groups. The manifest's `tools` declares `name`, `description` (up to 300 characters) and `inputSchema` (a restricted JSON Schema subset: a top-level object whose properties are `string`, `number`, `integer`, `boolean` or arrays of those; no `$ref`, `pattern`, nested objects and so on). The registration's `tools` grants them by name, up to 8.

- Members see the name `p_<plugin id>_<name>` and a description prefixed with `(third-party plugin <id>)`. Every tool sits in the members' tool list and costs tokens on every model call, so grant only what is needed.
- The Hub identifies the caller only from the session its bridge reports, checks arguments against the declaration and sends `tool.call {tool, arguments, context:{clusterId, member, at, callId}}`; the plugin answers `{text?, data?}` (up to 16 KiB). After the answer the Hub identifies the caller again; if they were removed, hidden or rebound meanwhile, the result is withheld (`CALLER_CHANGED`).
- Limits: 10-second timeout (ends only that call), 30 calls per member per minute, 120 per plugin per minute, 4 at once.
- Every call, refused ones included, leaves a metadata-only system record in the group: who, which tool, result code, duration, byte counts of arguments and result; **never their contents**.
- Only members whose conversation can be identified when the tool list is fetched get plugin tools: today native Claude (through the orrery bridge, which sends `list_changed` when a plugin changes) and WorkBuddy (after the app lists tools again). Codex, Kimi, ZCode, Qoder, Antigravity, Cursor and DeepSeek Harness do not get them yet.

## Web UI and marks (`ui.show`)

The manifest's `ui.positions` declares positions; the registration's `ui` grants them one by one:

- `titlebar`: a chip in the group title bar that opens a panel (height `panelHeight`, 200-480 px, default 320);
- `workbench`: a tab named after the plugin in the task workbench;
- `marks`: small marks on messages, members and tasks, drawn by orrery from the plugin's data.

**Pages** are served only from the plugin folder's `ui/`, entry fixed at `ui/index.html`; only `.html`, `.css`, `.js`, `.json`, `.svg`, `.png`, `.jpg`, `.webp`, `.woff2`, at most 1 MiB per file and 200 files / 4 MiB for all of `ui/`; paths are checked segment by segment and links or junctions are never followed. Each time the page opens a UI, the Hub creates an unguessable frame ID; the address `/plugin-ui/<frame ID>/index.html` stops working when the UI closes, the plugin stops or restarts, grants are revoked or the Hub restarts.

The frame is `<iframe sandbox="allow-scripts">` with an opaque origin: it cannot read cookies, tokens, the collaboration page or storage, and cannot call Hub APIs. Its CSP only allows scripts, styles, images and fonts from its own address prefix and blocks `fetch`, XHR, WebSocket connections and navigation. It talks to the page only through `postMessage` (`orrery.ready`, `orrery.request` → `orrery.init`, `orrery.theme`, `orrery.language`, `orrery.response`, `orrery.push`; a change of interface language does not reload the page, it only sends `orrery.language`); the page passes requests to the Hub over the authenticated API, and the Hub sends `ui.request` to that plugin's process (10-second timeout, up to 16 KiB). orrery draws the plugin name and a "third-party plugin" label around the frame; the plugin cannot remove them.

- `host.ui.push {clusterId, position?, data}`: push to its own open pages in that group;
- `host.ui.chip {clusterId, text, state?}`: title-bar chip text (up to 24 characters) and status dot (`running`, `done`, `failed`);
- `host.ui.mark {clusterId, target, targetId, text, state?, tip?}`: `target` is `message`, `member` or `task`; text up to 16 characters, tip up to 80, state `running`, `done`, `failed` or `info`; `text: null` clears it. One mark per plugin per target, up to 200 per group; marks live in memory only and disappear when the plugin stops, the group goes to the trash or the Hub restarts.
- Pushes, chips and marks share 120 calls per plugin per minute. The "Show web UI" switch on the plugin card removes its pages and marks at any time.

Known limits: the plugin process itself is unrestricted. Frame isolation protects the user's login, the collaboration page and identity spoofing; it does not stop a plugin from sending data out. WebRTC is not governed by CSP, and whether it is blocked has not been verified.

## Plugin configuration

A manifest may declare ordinary preferences in a `config` array (up to 32 fields): `name`, `label`, `scope` (`global` or `cluster`), `type` (`text`, `number`, `duration`, `boolean`, `enum`, `member`, `path`, `list`), and optional `description`, `default`, `required`. Users edit them from **Configure** on the plugin card or **Plugin settings** in the group menu; each field shows where its value comes from and can be reset to the default or cleared. Only explicit overrides are stored, so fields without one follow the manifest default.

The plugin gets current values in `initialize.params.config` (`global`, `clusterDefaults`, per-group `clusters`), receives `config.changed {clusterId, revision, values}` after a save, and can report field problems with the `config.errors` notification. Values and plugin-reported reasons never go into the chat, events or logs, and are included in `npm run backup`. Passwords, tokens and other credentials are not a supported field type.

## Lifecycle

Registered restricted plugins can be **started, stopped and restarted** individually from their card without restarting the Hub (start and restart re-read the registration and manifest; if the new registration is invalid, a running plugin keeps running). Each card also has two switches:

- **Restart after errors** (off by default): at most 3 times in 10 minutes (after 2, 10 and 60 seconds) and 10 in total, then it gives up and says why; each automatic restart leaves a record in the plugin's groups.
- **Development: restart on file changes** (off by default): about 0.5 seconds after a source file (`.js`, `.mjs`, `.json` and similar, not under `node_modules/` or `data/`) changes, with rate and total limits.

Stopping sends `shutdown` and waits up to `shutdownGraceMs`; when the Hub closes, each plugin gets at most 10 seconds. States (`disabled`, `starting`, `ready`, `stopping`, `failed`, `stopped`) update live over the event stream. Only the user can act: `POST /api/plugins/:id/start`, `/stop`, `/restart`, and `PATCH /api/plugins/:id/lifecycle`. The enable switch (`PUT /api/plugins/:id`) only changes the next start; `ORRERY_DISABLED_PLUGINS` also applies to third-party plugin IDs.

## Full-trust plugins

A full-trust plugin runs inside the Hub process, uses the same Hub-side slots as official plugins and can read and write everything in the Hub database. A fault can stop the Hub, and protections such as loop limits and "the user can see what every member received" do not cover it. Only install full-trust plugins from authors you trust. Example: [group notes example](../examples/hub-plugins/trusted-demo/README.en.md).

### Registration and confirmation

The user registers it by hand in `external-plugins.json`, with only the `manifest` and `trust` fields:

```json
{ "plugins": [{ "manifest": "C:/plugins/trusted-demo/orrery-plugin.json", "trust": "full" }] }
```

Manifest fields: `id`, `version`, `name`, `description`, `details`, `requires` (official or other full-trust plugins only), `icon`, plus `hostApi` (slot interface version, currently `1`), `hubEntry` (the Hub entry, a `.js`/`.mjs` inside the plugin folder) and optional `webEntry` (the web module, a `.js` inside a subfolder that must not contain the Hub entry).

Registering only adds a card marked "Full trust" in Settings. The user clicks "Confirm trust…"; the dialog explains its power, the cost of a fault and the real path of the entry file this confirmation binds to. The confirmation is stored in `<ORRERY_HOME>/plugins.json`. If the entry path changes (the manifest points elsewhere, the folder moves or is replaced by a link) it must be confirmed again; changed file contents at the same path do not require reconfirmation.

| State | What runs |
|---|---|
| Not confirmed or revoked | Nothing: the entry is not imported and no migration runs |
| Confirmed, switched off | Only migrations and the two cleanup hooks (member removal, group purge) |
| Confirmed, switched on | Everything |

Confirming, revoking and switching **take effect after a Hub restart**; there is no hot loading.

### Loading and available slots

The Hub first decides from data alone whether a plugin may load (safe mode, confirmation and path, dependencies) and imports only those that pass. The entry's default export is a function that receives `{ hostApi, z }` and returns an object shaped like an official plugin. Available slots: `actions`, `prepare`, `prepareRequired`, `queries`, `refs`, `managementActions`, `tools` (names must not start with `p_`), `routes`, `messageFields`, `service`, lifecycle hooks, `eventSource`, `migrations`. The single-provider task view, coordinator view, envelope and `bridgeRoutes` are not open. Only the slot shapes (`hostApi` 1) are a stable promise; internal `Store` and `Hub` methods may change between versions.

Load problems the Hub can diagnose only skip that plugin and its dependents, and the Hub and other plugins start normally: a failed import, an import plus default export that does not finish within 10 seconds (a top-level `await` or a promise that never settles), a wrong default export, conflicting or unavailable slots, routes outside the prefix, migrations that cross the prefix, or a failed pre-upgrade backup. The card shows the reason (and whether its code already ran); a timed-out module may stay half-loaded in the process, and the Hub stops using it. **This isolation does not cover synchronous blocking**: a plugin that loops or blocks synchronously, while importing or later, freezes the whole Hub (there is no watchdog), and its own timers and unhandled promise rejections can make the Hub exit. Start in safe mode in that case (see below).

- **Routes** must live under `/api/x/<id>/` and need a login like every `/api/*`.
- **Database**: tables, indexes, triggers and views start with `x_<id with - replaced by _>_` (for example `x_trusted_demo_`). Each migration step runs in its own transaction and the Hub compares the schema before and after; anything outside the prefix rolls back and skips the plugin. This checks structure, not data. The check needs Node 24.10.0 or later; on older Node a full-trust plugin with pending migrations is skipped. Tables stay after uninstalling; to remove them, stop the Hub, drop the tables and delete the plugin's rows from `plugin_migrations`.
- **Pre-upgrade backup**: when the database has pending migrations (core or any plugin), the Hub backs it up to `<ORRERY_HOME>/backups/` (file name with `-pre-upgrade`) before the first schema change; see [Architecture](architecture.en.md#storage--migrations). If a full-trust plugin needs an upgrade and the backup fails, only those plugins are skipped.
- **Purging a group**: when a plugin has migration records but was not loaded this time, its cleanup hook did not run; the result says "these plugins' tables may still hold data for this group", and a blocking foreign key returns 409 `PLUGIN_DATA`.

### Web module (`webEntry`)

The Hub serves the `webEntry` folder read-only at `/plugin-web/<id>/` (scripts, styles, JSON, images and fonts only, no HTML, at most 1 MiB per file, no links followed, never the Hub entry). Only plugins confirmed, loaded and switched on in this Hub start appear in `trustedFrontend` of `GET /api/plugins`, and the page imports only those (each within 5 seconds). A module exports `register(host)` and returns the slots it uses among `message`, `composer`, `workbench` and `settings` (see [Official Plugins](plugins.en.md#official-web-slots)); `host` offers `ui`, `api`, `nameOf`, `command` and `onDispose(fn)`.

**When trust ends**: after revoking, switching off or safe mode plus a Hub restart, open pages detach the plugin in place: its slots are no longer called, the elements it added through slots are removed, its dialogs close (text the user typed there moves into a read-only notice of the page itself, ready to copy), and each `onDispose` it registered is called once. A banner says "fully takes effect after a page refresh"; the page never reloads itself and leaves unsent input alone; it reloads only when the user clicks "Reload". Until then the module code is still in page memory: its own timers, listeners and changes made outside the slots can only be cleaned up by its own `onDispose`, so reload the page to stop it completely.

### Safe mode

Starting the Hub with `ORRERY_SAFE_MODE=1` skips every full-trust plugin before import (`0` or unset is normal mode; any other value fails the start). Cards say "Safe mode: not loaded this time" and the collaboration page shows a banner. Use it when a plugin breaks the Hub: revoke trust or switch it off in Settings, then restart without the variable.

### Interfaces

| Interface | Description |
|---|---|
| `GET /api/plugins` | Full-trust rows have `origin: "trusted"` and `trust: { state, entry, confirmed, error, tablePrefix, routePrefix, … }` (`state` is `loaded`, `unconfirmed`, `path-changed`, `safe-mode` or `failed`), plus `safeMode`, `trustedFrontend` and this start's `instance` |
| `PUT /api/plugins/:id/trust` | `{ "trusted": true, "entry": "<entry path shown on the card>" }` confirms, `{ "trusted": false }` revokes; 409 `ENTRY_CHANGED` when the path differs from what the Hub resolves now. User API token only |
| `PUT /api/plugins/:id` | Enable switch, effective at the next start |
| `GET /plugin-web/<id>/<path>` | Web module files, read-only |

## Examples

- [Message counter](../examples/hub-plugins/message-counter/README.en.md): reads and commands.
- [Review reminder](../examples/hub-plugins/review-reminder/README.en.md): event subscription and restricted posting.
- [UI demo](../examples/hub-plugins/ui-demo/README.en.md): title-bar and workbench pages, and marks.
- [Group notes](../examples/hub-plugins/trusted-demo/README.en.md): a full-trust plugin with a table, a route, a member tool and a web module.

## Current limits

- No OS sandbox, process-tree supervision, signed marketplace, automatic upgrades or in-process hot reload ("development reload" restarts the process after a file change). Plugins must reap any child processes they start.
- Newly registered plugins and any full-trust change need a Hub restart.
- Plugin tools currently reach only native Claude and WorkBuddy members.
