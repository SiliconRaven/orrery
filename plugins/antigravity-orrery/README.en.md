# orrery sidecar (Antigravity)

Language: [中文](README.md) | **English**

Native Mode integration for Antigravity 2.0 desktop using Node built-in modules only. All setup is manual; orrery never edits Antigravity files.

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.2` (Beta pre-release); interfaces, hooks, and config formats may still change—test in a scratch thread first.

Installed-app users: use the bundled Node path; see [installer setup](../../docs/desktop.en.md). Plug-ins find the Hub through the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`), so the host no longer needs `ORRERY_HOME`.

> **Terms of Service Warning**: Official Antigravity FAQs state that accessing Antigravity via third-party software, tools, or services **may violate** its Terms of Service and can lead to account suspension or termination. Prompt delivery via `agentapi` falls under this notice; use at your own discretion.

## Components

- **`sidecar.mjs`**: Once Antigravity injects language-server env vars, uses the `hub-discovery.mjs` next to it to read the account's Hub registry and connect to the active loopback Hub (`ORRERY_HUB` can pin one), signing requests with `x-orrery-sig` instead of sending the key, runs shell-free `agentapi send-message <conversationId> <text>`, and redacts CSRF tokens before truncating stderr.
- **`hook.mjs`**: `PreToolUse` hook signing `conversationId` with the registry's shared key K (`bridge-secret`) and overwriting `orreryCaller` (with an empty value if K is unreadable; it never falls back to `hub.json`) on MCP calls while returning `ask` so your existing approval policies apply.
- **`hub-discovery.mjs`**: Byte-identical copy of `plugins/shared/hub-discovery.mjs` that finds the Hub, signs and reads the shared key.
- **`hook-dump.mjs`**: Diagnostic payload inspector for manual troubleshooting only; leave unconfigured during normal use.

## One-Time Manual Install

Prerequisites: Node 24 on PATH, and orrery Hub started at least once so the shared key K exists in the account's Hub registry (`~/.orrery/registry/bridge-secret`). `ORRERY_HOME` does not matter to the sidecar or hook; if the registry is not in the default place, or you pin a Hub with `ORRERY_HUB`, the Antigravity process needs the same environment variable.

1. **Copy sidecar**: Copy this folder to `~/.gemini/config/sidecars/orrery/` (Windows: `%USERPROFILE%\.gemini\config\sidecars\orrery\`):
   ```powershell
   Copy-Item -Recurse <orrery-repo>\plugins\antigravity-orrery "$HOME\.gemini\config\sidecars\orrery"
   ```
2. **Enable sidecar**: Enable `orrery` in the Antigravity UI or merge into `~/.gemini/config/config.json`:
   ```json
   { "sidecars": { "orrery": { "enabled": true } } }
   ```
3. **Add MCP entry**: Merge into `~/.gemini/config/mcp_config.json` (match your Hub port; `<secret>` is the shared key K from orrery Settings → Delivery → Native connections → Show bridge key, or `~/.orrery/registry/bridge-secret`. Antigravity sends this HTTP request itself and cannot sign, so this is plaintext compatibility, which stops working if you turn it off in delivery settings):
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

- **Update / uninstall**: The sidecar and hook are copies and do not update with orrery. After updating orrery you **must reinstall**: copy the whole folder over `sidecars/orrery/` again (including `hub-discovery.mjs`), re-enable it and restart; when upgrading from a `hub.json` version, also replace the `x-orrery-bridge` value in `mcp_config.json` with K once. An old copy that was not reinstalled still reads `hub.json` and sends the plaintext key. The registry-reading, signing version is verified by automated tests only so far. Uninstall by disabling and removing the sidecar folder plus the `mcp_config.json` and `hooks.json` entries.
- **High-priority prompt delivery**: Delivered messages arrive as high-priority system prompts and immediately trigger a turn under your active approval settings. Details: [docs/adapters/antigravity.en.md](../../docs/adapters/antigravity.en.md).
