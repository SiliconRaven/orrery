# dsh-orrery

Language: [中文](README.md) | **English**

DeepSeek Harness (DSH) bundle plugin connecting DSH sessions to the local orrery Hub (Native Mode). Zero third-party dependencies (Node built-ins only); portable as a standalone directory.

> **Beta Notice**: Bundled with `orrery v0.10.0-beta.1` (Beta pre-release); interfaces and config formats may still change.

Installed-app users: use the bundled Node path and set `ORRERY_HOME` for the host plugin. See [installer setup](../../docs/desktop.en.md).

## Capabilities & Boundaries

- **Receive & batch deliveries**: Enqueues incoming `@mentions` via `sessionController.prompt` (`queue` mode) and reports `turn/end` outcome plus token usage via `POST /bridge/done` while the Hub batches subsequent pings.
- **Collaboration tools (`mcp__orrery__*`)**: Registers prefixed chat, receipt, task, and bookmark tools (avoiding collision with DSH's built-in `send_message` and `list_agents`).
- **Post-tool unread hints**: Enabled by default; polls `/bridge/unread-hint` (500ms timeout) via `tools/post-execute` and prepends a compact count line (`source.kind: 'dsh-orrery'`) to `additionalContexts` only when unread counts changed. Subagent separation depends on the identity fields supplied by the host.
- **Activity observation**: Reports minimal tool/turn signals for joined conversations, without arguments or message bodies. Real-app checks cover message exchange, turn completion, and heartbeat display.
- **Zero intrusion**: Loopback-only HTTP; never reads `~/.dsh` credentials, logs secrets, alters approvals/models, or interrupts turns with `steer`.

## Install, Reload & Uninstall

1. In DSH sidebar **Plugins → Add plugin**, enter the absolute path to this directory (e.g. `C:/projects/orrery/plugins/dsh-orrery`), or exit DSH and run:
   ```powershell
   dsh plugin --profile desktop add link:<absolute-path-to-plugin>
   ```
2. Start the orrery Hub (`npm start`; keep `ORRERY_HOME` consistent if customized).
3. **Reload on update**: After updating orrery, disable and re-enable `dsh-orrery` in DSH Plugins (or restart DSH).
4. **Disable / uninstall**: Toggle off/remove in Plugins UI, or run `dsh plugin --profile desktop remove dsh-orrery` while DSH is closed. Missed chat messages during downtime are not replayed.

## Risks & Compatibility

- **Approval warning**: Delivered prompts execute under **your active DSH permission preset** (auto-approve profiles run `@mentions` without prompting).
- **Version range**: Requires `engines.dsh: >=0.2.1-rc.2 <0.3.0-0`. Re-verify core flows after DSH updates. Details: [docs/adapters/deepseek.en.md](../../docs/adapters/deepseek.en.md).
