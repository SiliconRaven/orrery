# orrery Plugin (Qoder)

Language: [中文](README.md) | **English**

Native Mode connector for Qoder Desktop using Node built-in modules only (Node 24 on PATH; orrery never installs plugins or alters Qoder configs).

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.3` (Beta pre-release); interfaces, hooks, and config formats may still change.

Installed-app users: use the bundled Node path; see [installer setup](../../docs/desktop.en.md). Plug-ins find the Hub through the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`), so the host no longer needs `ORRERY_HOME`.

## Contents

- `.qoder-plugin/plugin.json`, `.mcp.json`: Plugin manifest and MCP definition.
- `mcp.mjs`: App-wide stdio MCP relay that finds the active loopback Hub in the account's Hub registry (`ORRERY_REGISTRY`) through the `hub-discovery.mjs` next to it (a byte-identical copy of `plugins/shared/hub-discovery.mjs`) and forwards calls signed with `x-orrery-sig` (covering the body, including `_meta`), with no `hub.json` and no plaintext key, trusting only Qoder runtime `_meta["com.qoder/turnContext"].sessionId`.
- `skills/orrery/SKILL.md` *(and `SKILL.en.md`)*: Guides the model on arming [`plugins/zcode-orrery/wait.mjs`](../zcode-orrery/README.en.md), reading background output files on wakeup, and avoiding re-arms when stopped/killed.

## Packaging & Install (Manual)

1. Archive from repository root (keeping `.qoder-plugin` at zip root):
   ```powershell
   tar -a -c -f orrery-qoder.zip -C plugins\qoder-orrery .qoder-plugin .mcp.json mcp.mjs hub-discovery.mjs skills README.md
   ```
2. Open Qoder **Extensions → Plugins → Add Plugins → Upload Plugin** and upload the archive.
3. `.mcp.json` references `${QODER_PLUGIN_ROOT}`; if a future Qoder build stops expanding it, substitute the forward-slash absolute path to `mcp.mjs` and repackage.
4. **Update**: The plugin is a copy uploaded into Qoder and does not update with orrery. After every orrery update you **must reinstall** it: package the ZIP again, Upload Plugin, then say "join orrery" again in the conversation. An old copy that was not reinstalled still reads `hub.json` and sends the plaintext key. The signing relay is verified by automated tests only so far. `ORRERY_HOME` does not matter to the plugin.

Approval caveats ("Ask every time" mode cannot run unattended) and full details: [docs/adapters/qoder.en.md](../../docs/adapters/qoder.en.md).

## Notes & Uninstall

- Quit Qoder or remove the member in orrery UI to leave—do not simply kill the background task inside Qoder.
- Prompts run under your Qoder approval mode; uninstall via Qoder Plugins settings.
