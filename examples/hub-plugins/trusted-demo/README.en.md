# Full-Trust Example: Group Notes

Language: [中文](README.md) | **English**

A minimal full-trust plugin (bundled with `orrery v0.10.0-beta.2` Beta pre-release; APIs may change). It has the same power as orrery itself and runs inside the Hub process; see [Third-party plugins, "Full-trust plugins"](../../../docs/external-plugins.en.md#full-trust-plugins). The folder can be copied outside the repository; it imports no orrery source, needs no npm dependencies and calls no model or network.

It has:

- its own icon `icon.svg` (set in the manifest's `icon`, shown on the card even before confirmation);
- its own table `x_trusted_demo_notes` (migration step 1, with the `x_trusted_demo_` prefix);
- a "便签" (Notes) button next to the composer (web module `web/index.js`, `composer` slot) to view and add this group's notes; shortcut Alt+Shift+N, whose key listener it removes through `host.onDispose` when it is detached;
- its own API: `GET /api/x/trusted-demo/clusters/<group ID>/notes` reads the group's notes, `POST` to the same address with `{"body":"…"}` adds one. Like every `/api/*` it needs a login: open the address in the browser that already has the collaboration page open, or send `Authorization: Bearer <API token>` from a program;
- a member tool `trusted_demo_note` that lets a member leave a note;
- a `clusterPurging` hook that deletes the group's notes when the group is purged.

The web module only uses what `register(host)` provides (`host.ui`, `api`, `onDispose`) and never imports page files by relative path. Table, route, action and tool names are all derived from the manifest `id` (`-` becomes `_`), so a copy with a different `id` is another plugin that can run alongside.

## Install

1. In `external-plugins.json` under an `ORRERY_HOME` of your choice, register the absolute path of `orrery-plugin.json` with full trust:

   ```json
   { "plugins": [{ "manifest": "<absolute path>/trusted-demo/orrery-plugin.json", "trust": "full" }] }
   ```

2. Restart the Hub, open Settings → Plugins, click "Confirm trust…" on the card "完全信任示例：群便签" (full-trust example: group notes), read the explanation and the entry file path, and confirm.
3. Restart the Hub again and refresh the page. The card now says enabled, the "便签" button appears next to the composer, and members whose app supports plugin tools see `trusted_demo_note`.

Revoking trust and the enable switch take effect after a Hub restart. Pages that are already open then remove the "便签" button at once, stop calling it and show "fully takes effect after a page refresh"; they never reload by themselves. If the notes dialog was open, the text typed into it moves into a read-only notice of the page itself, ready to copy; copy what you need before closing the notice or refreshing.

The table stays in the database after uninstalling. To remove it, stop the Hub and run `DROP TABLE x_trusted_demo_notes;` and `DELETE FROM plugin_migrations WHERE plugin_id = 'trusted-demo';` with an sqlite tool.

Only install full-trust plugins from authors you trust: they can read and write all data in the Hub database.
