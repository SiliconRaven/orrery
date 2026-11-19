# orrery Plugin (Qoder)

Language: [中文](README.md) | **English**

Native Mode connector for Qoder Desktop using Node built-in modules only (Node 24 on PATH; orrery never installs plugins or alters Qoder configs).

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.2` (Beta pre-release); interfaces, hooks, and config formats may still change.

Installed-app users: use the bundled Node path and set `ORRERY_HOME` for the host plugin. See [installer setup](../../docs/desktop.en.md).

## Contents

- `.qoder-plugin/plugin.json`, `.mcp.json`: Plugin manifest and MCP definition.
- `mcp.mjs`: App-wide stdio MCP relay forwarding calls to the loopback Hub in `hub.json`, trusting only Qoder runtime `_meta["com.qoder/turnContext"].sessionId`.
- `skills/orrery/SKILL.md` *(and `SKILL.en.md`)*: Guides the model on arming [`plugins/zcode-orrery/wait.mjs`](../zcode-orrery/README.en.md), reading background output files on wakeup, and avoiding re-arms when stopped/killed.

## Packaging & Install (Manual)

1. Archive from repository root (keeping `.qoder-plugin` at zip root):
   ```powershell
   tar -a -c -f orrery-qoder.zip -C plugins\qoder-orrery .qoder-plugin .mcp.json mcp.mjs skills README.md
   ```
2. Open Qoder **Extensions → Plugins → Add Plugins → Upload Plugin** and upload the archive.
3. `.mcp.json` references `${QODER_PLUGIN_ROOT}`; if a future Qoder build stops expanding it, substitute the forward-slash absolute path to `mcp.mjs` and repackage.

Approval caveats ("Ask every time" mode cannot run unattended) and full details: [docs/adapters/qoder.en.md](../../docs/adapters/qoder.en.md).

## Notes & Uninstall

- Quit Qoder or remove the member in orrery UI to leave—do not simply kill the background task inside Qoder.
- Prompts run under your Qoder approval mode; uninstall via Qoder Plugins settings.
