# orrery sidecar (Antigravity)

Language: [中文](README.md) | **English**

Native Mode integration for Antigravity 2.0 desktop using Node built-in modules only. All setup is manual; orrery never edits Antigravity files.

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.1` (Beta pre-release); interfaces, hooks, and config formats may still change—test in a scratch thread first.

Installed-app users: use the bundled Node path and set `ORRERY_HOME` for the host plugin. See [installer setup](../../docs/desktop.en.md).

> **Terms of Service Warning**: Official Antigravity FAQs state that accessing Antigravity via third-party software, tools, or services **may violate** its Terms of Service and can lead to account suspension or termination. Prompt delivery via `agentapi` falls under this notice; use at your own discretion.

## Components

- **`sidecar.mjs`**: Connects to the local loopback Hub (`hub.json` read-only) once Antigravity injects language-server env vars, runs shell-free `agentapi send-message <conversationId> <text>`, and redacts CSRF tokens before truncating stderr.
- **`hook.mjs`**: `PreToolUse` hook signing `conversationId` with the local `hub.json` secret and overwriting `orreryCaller` on MCP calls while returning `ask` so your existing approval policies apply.
- **`hook-dump.mjs`**: Diagnostic payload inspector for manual troubleshooting only; leave unconfigured during normal use.

## One-Time Manual Install

Prerequisites: Node 24 on PATH, and orrery Hub started at least once (`~/.orrery/secret` present).

1. **Copy sidecar**: Copy this folder to `~/.gemini/config/sidecars/orrery/` (Windows: `%USERPROFILE%\.gemini\config\sidecars\orrery\`):
   ```powershell
   Copy-Item -Recurse <orrery-repo>\plugins\antigravity-orrery "$HOME\.gemini\config\sidecars\orrery"
   ```
2. **Enable sidecar**: Enable `orrery` in the Antigravity UI or merge into `~/.gemini/config/config.json`:
   ```json
   { "sidecars": { "orrery": { "enabled": true } } }
   ```
3. **Add MCP entry**: Merge into `~/.gemini/config/mcp_config.json` (replace `<secret>` from `~/.orrery/secret` and match your Hub port):
   ```json
   {
     "mcpServers": {
       "orrery": {
         "url": "http://127.0.0.1:4317/mcp",
         "headers": { "x-orrery-bridge": "<secret>", "x-orrery-harness": "antigravity" }
       }
     }
   }
   ```
4. **Add `PreToolUse` hook**: Merge into `~/.gemini/config/hooks.json` (on Windows keep the unquoted relative path `./sidecars/orrery/hook.mjs` and match `mcp.*|call_mcp_tool`):
   ```json
   {
     "orrery-caller": {
       "PreToolUse": [
         {
           "matcher": "mcp.*|call_mcp_tool",
           "hooks": [{ "type": "command", "command": "node ./sidecars/orrery/hook.mjs", "timeout": 10 }]
         }
       ]
     }
   }
   ```
5. **Startup order**: Start the Hub before Antigravity. Sidecar reconnects every 5s, whereas Antigravity's MCP client must be refreshed manually in MCP Servers settings (or by restarting Antigravity) if started before the Hub.

## Update, Uninstall & Risks

- **Update / uninstall**: Recopy over `sidecars/orrery/` and restart; uninstall by disabling and removing the sidecar folder plus the `mcp_config.json` and `hooks.json` entries.
- **High-priority prompt delivery**: Delivered messages arrive as high-priority system prompts and immediately trigger a turn under your active approval settings. Details: [docs/adapters/antigravity.en.md](../../docs/adapters/antigravity.en.md).
