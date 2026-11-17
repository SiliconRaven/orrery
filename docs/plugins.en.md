# Built-in Official Plugins (`src/plugins/`, `v0.10.0-beta.1`)

Language: [中文](plugins.md) | **English**

> **Beta Notice**: Official plugins ship with **v0.10.0-beta.1 (Beta pre-release)**, not a final stable release; MCP tools, events, and slot APIs may change.

The Hub core handles clusters, members, native chat routing, and storage, while task workflows, coordinator supervision, and bookmarks live in official plugins under `src/plugins/`.

## Mechanism & UI Slots

- Built-in plugins load at Hub startup, registering MCP tools, event listeners, schedules, HTTP/Bridge routes, and **official UI slots** in the web page.
- Enable or disable plugins in Settings UI (saved to `<ORRERY_HOME>/plugins.json`) or via `ORRERY_DISABLED_PLUGINS` (comma-separated plugin IDs); toggles usually require a Hub restart to take effect cleanly.
- Third-party external plugins ([External Plugins](external-plugins.en.md)) run out-of-process and never inject UI slots or browser scripts.

## Three Official Plugins & Dependencies

1. **`tasks` (Tasks & `ship`)**:
   - Provides task creation, three review tiers (member / self / user), dependencies, global labels, watches, `#number` refs, stalled hints, handover records, and `ship` merge routes.
   - **Standalone capable**: Disabling `coordinator` leaves all `tasks` workflows, boards, reviews, and `ship` features fully functional.
2. **`coordinator` (Coordinator Workbench)**:
   - **Depends on `tasks`**: Runs only when `tasks` is enabled; manages 8 configurable delegation switches plus idle-task and quota alerts.
3. **`bookmarks` (Cluster Knowledge Base)**:
   - Lets members (`bookmark_message`, `list_bookmarks`) and users archive tagged chat notes and decisions across long conversations.

## Impact of Disabling

- Disabling `tasks` leaves core multi-agent chat, routing, and file sharing active; because `coordinator` depends on `tasks`, `coordinator` is also disabled whenever `tasks` is off.
