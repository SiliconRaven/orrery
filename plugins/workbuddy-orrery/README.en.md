# orrery Connector (WorkBuddy)

Language: [中文](README.md) | **English**

Native Mode connector for WorkBuddy Desktop providing a stdio MCP bridge and optional skill (uses the MCP SDK installed via root `npm ci`). orrery never installs, trusts, or edits WorkBuddy configs:

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.2` (Beta pre-release); interfaces and config formats may still change.

Installed-app users: use the bundled Node path; see [installer setup](../../docs/desktop.en.md). Plug-ins find the Hub through the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`), so the host no longer needs `ORRERY_HOME`.

- `bridge.mjs`: Per-session stdio MCP bridge spawned by WorkBuddy. Checks `CODEBUDDY_SESSION_ID` first and otherwise inspects its direct `WorkBuddy.exe` parent command line (`--session-id`, requires direct `node` execution without `cmd` wrappers) so models cannot spoof session IDs. It then finds the active loopback Hub in the account's Hub registry (`ORRERY_REGISTRY`) through `plugins/shared/hub-discovery.mjs` and forwards requests signed with `x-orrery-sig` (session header and body included), with no `hub.json` and no plaintext key; the bridge is path-referenced, so after updating orrery restart this MCP connection in WorkBuddy. Deliveries use the shared background wait script; see [docs/adapters/workbuddy.en.md](../../docs/adapters/workbuddy.en.md).
- `skill/SKILL.md` *(or `SKILL.en.md`, optional)*: Copy to WorkBuddy's skills directory to support `"加入 orrery"` / `"join orrery"` / `$orrery`.

## Manual Setup

1. Start the orrery Hub (`npm start`) before opening WorkBuddy conversations.
2. Add a stdio MCP connector in WorkBuddy (Node 24 on PATH):
   - Command: `node`
   - Args: `<orrery-dir>/plugins/workbuddy-orrery/bridge.mjs`
   Explicitly mark it **Trusted** in WorkBuddy connector settings (exact menu paths and post-fix live run await verification).
3. Say `"加入 orrery"` / `"join orrery"` in the conversation; if prompted on the wait command, approve only that exact verbatim command (**never** switch to full access).

## Notes & Removal

- WorkBuddy's default sandbox preset may run tools without per-action prompts; verify you accept cluster `@mentions` running under that preset.
- Idle conversation workers recycle after ~15 minutes (turning members offline). Remove/untrust the connector and restart WorkBuddy to uninstall.
