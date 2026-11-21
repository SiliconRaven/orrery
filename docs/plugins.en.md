# Plugins (`v0.10.0-beta.4`)

Language: [中文](plugins.md) | **English**

> **Beta Notice**: Plugins ship with **v0.10.0-beta.4 (Beta pre-release)**, not a final stable release; MCP tools, events, and slot APIs may change.

The orrery core only handles clusters, members, native chat delivery, message storage, permissions and loop protection; the pause switch and loop limits always stay in the core. Task workflows, coordinator supervision and bookmarks live in official plugins under `src/plugins/`. The repository's top-level `plugins/` folder holds bridges for the native apps and is unrelated to the Hub plugins described here.

Official plugins receive signed updates through a [dedicated release channel](https://github.com/SiliconRaven/orrery/releases/tag/official-plugins-v1). Compatible plugin updates take effect after restarting the Hub. Settings shows the compatibility requirements for plugins that need a newer Hub.

## Three Plugin Tiers

| Tier | Form | Notes |
|---|---|---|
| Official plugins | In-process modules in `src/plugins/<id>/`, sharing the core's database and transactions | This page |
| Full-trust third-party plugins | Registered by the user and confirmed in Settings; then they run inside the Hub like official plugins, use the same Hub-side slots and may bring a same-page web module | [Third-party plugins, "Full-trust plugins"](external-plugins.en.md#full-trust-plugins); table and route prefixes are enforced, `ORRERY_SAFE_MODE=1` skips them all |
| Restricted third-party plugins | A separate Node process, stdio JSON-RPC, per-group grants | [Third-party plugins](external-plugins.en.md); reads, events, restricted posting, message checks, commands, member tools, sandboxed pages and marks |

## Update Official Plugins

orrery 0.10.0-beta.4 can update Star Map, Tasks, Bookmarks, and Coordinator individually. When an update is available, follow these steps.

1. On the collaboration page, open **Settings → Plugins** and select **Check official plugin updates** under Official plugins.
2. Select **Review update** on the plugin card. Check the version and migration details, then select **Confirm update**. The card shows the **version after restart** while the current version continues to run.
3. Return to the collaboration page and select **Quit Orrery** in the sidebar. Confirm and wait for the Hub to stop. Close the desktop window and reopen **orrery** from its shortcut. The update takes effect when the Hub starts. Check the plugin card for the running version.

## Mechanism

An official plugin with `defaultEnabled: false` starts disabled. Startup and the Settings preview use the same precedence: an environment disable, a user disable, a user enable, then the manifest default. Settings stores explicit switches in `disabled` and `enabled` in `plugins.json`. Removing the file restores each plugin's default.

- Official plugins load at Hub startup. They can register database migrations, collaboration actions and queries, MCP tools, web and bridge routes, message fields, background services, lifecycle hooks and event types, and can register **official web slots** on the collaboration page.
- `src/core`, `src/mcp` and `src/web` never import a plugin; only the assembly entry `src/main.ts` imports the registry (enforced by `test/boundaries.test.ts`).
- **Fault isolation**: the core isolates every call into a plugin. If a background service throws while being built, started, swept, closed or notified, a fault is recorded (the Settings card shows "plugin error (phase): reason") and the Hub and other plugins carry on; a plugin whose MCP tools fail to register only loses its own tools; a hook that throws inside a transaction rolls the whole operation back with `PLUGIN_HOOK_FAILED`. Timers the plugin starts itself and hangs (endless loops, synchronous blocking) are outside this isolation.
- **Enabling and disabling**: the Settings "Plugins" section writes `<ORRERY_HOME>/plugins.json`; the startup variable `ORRERY_DISABLED_PLUGINS` (comma-separated plugin IDs) wins over it. Switches only change the next start and take effect after a Hub restart; dependency checks look at the next-start state. A disabled plugin registers no actions, tools, routes or message fields, but its migrations still run, so its tables and data remain.
- Settings groups plugins into "Official" and "Third-party"; each card shows the icon, name, version, description, switch, status and dependencies.

## Official Web Slots

All four official plugins (`tasks`, `bookmarks`, `coordinator`, and `starmap`) follow the official package layout `src/plugins/<id>/{release.json,package/,index.ts}`. Each built-in entry passes the `src/official-plugin-host.ts` contract (`hostApi: 1`) into `package/hub/index.mts` and points `packageSource` at `package/`, so bundled copies and signed updates share `/official-plugin-web/<id>/<digest>/` for web assets/dictionaries and `/api/plugins/<id>/icon` for icons. Full-trust plugins provide a module of the same shape through the manifest's `webEntry` (served by the Hub at `/plugin-web/<id>/` and detached in place by open pages when trust ends); restricted plugins have no same-page code, their pages live in sandboxed frames.

A module exports `register(host)` and returns the slots it uses. `host` provides the `api`, `nameOf`, and `command` callbacks, `i18n` (package dictionary and live helpers `t`, `lt`, `language`, `onLanguageChange`), and shared UI helpers `ui` (`h`, `icon`, `emptyState`, `noticeDialog`, `confirmDialog`, `formDialog`), plus `onDispose(fn)`.

| Slot | Where it goes |
|---|---|
| `message` | `render(message, state)` returns a node under the message; optional `key`, `update`, `capture`, `restore` |
| `composer` | Returns a control placed between the chat composer and the send button |
| `workbench` | Returns the ID, label (accepts live text `lt`), render and load functions of a workbench library tab |
| `settings` | Returns a node placed below the plugin list in Settings |
| `view` | Full-page or fullscreen view `{ id, title, icon, fullscreen?, mount(el, ctx), unmount() }` |
| `panel` | Same-page panel embedded into fullscreen views (such as the Star Map 2.0 HUD Dock and floating windows); see [Embedding Plugins into Star Map](starmap-plugins.en.md) |

If a module or slot callback fails, the page logs the reason to the console and other slots and the page keep working.

## Official Plugins & Dependencies

1. **`tasks` (Tasks & `ship`)**:
   - Provides task creation, three review tiers (member / self / user), dependencies, review batches, global labels, watches, `#number` refs, local Git branch links, stalled hints, handover records and the `ship` merge flow; see [Collaboration & Tasks](collaboration.en.md).
   - **Standalone capable**: Disabling `coordinator` leaves all `tasks` workflows, boards, reviews, and `ship` features fully functional.
2. **`coordinator` (Coordinator Workbench)**:
   - **Depends on `tasks`**: Runs only when `tasks` is enabled; manages 8 configurable delegation switches plus idle-task and quota alerts.
3. **`bookmarks` (Cluster Knowledge Base)**:
   - Lets members (`bookmark_message`, `list_bookmarks`) and users archive tagged chat notes and decisions across long conversations.

4. **`starmap` (Star Map 2.0)** is off by default. When enabled, it adds a prominent Standard / Star Map switcher in the sidebar and opens a fullscreen 3D HUD where Tasks, Coordinator, Bookmarks, and third-party plugins mount as floating panels, member windows support 1-on-1 private DMs, and Luna / Astra / Sol themes style both scene and UI; transcript responses disable caching. See [Embedding Plugins into Star Map](starmap-plugins.en.md).

All three declare their own event types (tasks, bookmarks, coordinator), which third-party plugins can subscribe to with a grant; see [Third-party plugins, "Event subscription and publishing"](external-plugins.en.md#event-subscription-and-publishing).

## Impact of Disabling

- Disabling `tasks` leaves core multi-agent chat, routing, and file sharing active; because `coordinator` depends on `tasks`, `coordinator` is also disabled whenever `tasks` is off.
