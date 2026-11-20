# orrery Plugin (Cursor)

Language: [中文](README.md) | **English**

Native Mode connector for Cursor Desktop using Node built-in modules only (Node 24 on PATH; orrery never installs or edits Cursor configs).

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.3` (Beta pre-release); interfaces, hooks, and config formats may still change.

Installed-app users: use the bundled Node path; see [installer setup](../../docs/desktop.en.md). Plug-ins find the Hub through the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`), so the host no longer needs `ORRERY_HOME`.

## Components

- `.cursor-plugin/plugin.json`: Plugin manifest.
- `hooks/hooks.json` and three hooks:
  - `hooks/stop.mjs` (`stop`): Reports turn completion and parks on Hub; incoming messages return via `followup_message` (`timeout: 86400`, `loop_limit: null` governed by Hub loop limits).
  - `hooks/prompt.mjs` (`beforeSubmitPrompt`): Reads only the 8-hex handout token in the prompt's first line to prove delivery without sending prompt text.
  - `hooks/tool.mjs` (`postToolUse`): Intercepts placeholder-tagged `orrery` MCP outputs, executes the real call on Hub `/mcp` using Cursor's `conversation_id`, and returns the genuine tool result.
- `mcp.json`, `mcp.mjs`, `tools.json`: Placeholder stdio MCP server (falls back to bundled `tools.json` when Hub is down).
- `lib/hub.mjs` and `lib/hub-discovery.mjs` (a byte-identical copy of `plugins/shared/hub-discovery.mjs`): On every request reads the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`), uses the active Hub or the one pinned by `ORRERY_HUB`, connects only to `127.0.0.1`, and signs with `x-orrery-sig`; it never reads `hub.json`, sends the key itself, uses proxy-enabled `fetch` or writes secrets to logs. After a 401, `mcp.mjs` slows to one retry about every 60 seconds and logs why.

## Manual Install & Uninstall

1. Copy this directory to `~/.cursor/plugins/local/cursor-orrery/`.
2. Reload or restart Cursor and confirm the `orrery` MCP server is enabled.
3. **Optional fallback**: If local plugin folders are skipped, merge `hooks/hooks.json` and `mcp.json` into `~/.cursor/hooks.json` and `~/.cursor/mcp.json`, replacing `${CURSOR_PLUGIN_ROOT}` with the forward-slash absolute path.
4. **Update**: The plugin is a copy and does not update with orrery. After every orrery update you **must reinstall** it: copy the whole directory again (including `lib/hub-discovery.mjs`) and restart Cursor. An old copy that was not reinstalled still reads `hub.json` and sends the plaintext key. The registry-reading, signing version is verified by automated tests only so far.
5. **Uninstall**: Delete `~/.cursor/plugins/local/cursor-orrery/` (or remove the manually merged entries).

## Notes

- Hooks execute on every Cursor conversation, immediately returning `{}` for non-members while enforcing strict field privacy (`prompt`, `text`, email, workspace/transcript paths never leave your machine).
- Delivered messages appear as user-authored messages prefixed with `[orrery · 来自 ... · #handout]`. **If Auto-run commands or MCP auto-approve is enabled in Cursor, cluster mentions will execute without manual confirmation.** Details: [docs/adapters/cursor.en.md](../../docs/adapters/cursor.en.md).
