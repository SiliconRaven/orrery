# dsh-orrery

Language: [中文](README.md) | **English**

DeepSeek Harness (DSH) bundle plugin connecting DSH sessions to the local orrery Hub (Native Mode). Zero third-party dependencies (Node built-ins only); portable as a standalone directory.

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.2` (Beta pre-release); interfaces and config formats may still change.

Installed-app users: use the bundled Node path; see [installer setup](../../docs/desktop.en.md). Plug-ins find the Hub through the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`), so the host no longer needs `ORRERY_HOME`.

## Capabilities & Boundaries

- **Receive & batch deliveries**: Enqueues incoming `@mentions` via `sessionController.prompt` (`queue` mode) and reports `turn/end` outcome plus token usage via `POST /bridge/done` while the Hub batches subsequent pings.
- **Collaboration tools (`mcp__orrery__*`)**: Registers prefixed chat, receipt, task, and bookmark tools (avoiding collision with DSH's built-in `send_message` and `list_agents`).
- **Post-tool unread hints**: Enabled by default; polls `/bridge/unread-hint` (500ms timeout) via `tools/post-execute` and prepends a compact count line (`source.kind: 'dsh-orrery'`) to `additionalContexts` only when unread counts changed. Subagent separation depends on the identity fields supplied by the host.
- **Activity observation**: Reports minimal tool/turn signals for joined conversations, without arguments or message bodies. Real-app checks cover message exchange, turn completion, and heartbeat display.
- **Finding the Hub & signing**: Through `lib/hub-discovery.mjs`, every request reads the account's Hub registry (`ORRERY_REGISTRY`, default `~/.orrery/registry/`) and uses the active Hub or the one pinned by `ORRERY_HUB`; all requests are signed with `x-orrery-sig`, with no `hub.json` and no plaintext key.
- **Zero intrusion**: Loopback-only HTTP; never reads `~/.dsh` credentials, logs secrets, alters approvals/models, or interrupts turns with `steer`.

## Install, Reload & Uninstall

1. In DSH sidebar **Plugins → Add plugin**, enter the absolute path to this directory (e.g. `C:/projects/orrery/plugins/dsh-orrery`), or exit DSH and run:
   ```powershell
   dsh plugin --profile desktop add link:<absolute-path-to-plugin>
   ```
2. Start the orrery Hub (`npm start`). `ORRERY_HOME` does not matter to the plugin; if you customized `ORRERY_REGISTRY` or pin a Hub with `ORRERY_HUB`, give the DSH process the same environment.
3. **Reload on update**: After updating orrery, disable and re-enable `dsh-orrery` in DSH Plugins (or restart DSH); the plugin is path-referenced, so no reinstall is needed.
4. **Disable / uninstall**: Toggle off/remove in Plugins UI, or run `dsh plugin --profile desktop remove dsh-orrery` while DSH is closed. Missed chat messages during downtime are not replayed.

## Risks & Compatibility

- **Approval warning**: Delivered prompts execute under **your active DSH permission preset** (auto-approve profiles run `@mentions` without prompting).
- **Version range**: Requires `engines.dsh: >=0.2.1-rc.2 <0.3.0-0`. Re-verify core flows after DSH updates. Details: [docs/adapters/deepseek.en.md](../../docs/adapters/deepseek.en.md).
