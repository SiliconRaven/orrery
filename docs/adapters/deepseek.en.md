# DeepSeek Harness Adapter (Native Mode)

Language: [中文](deepseek.md) | **English**

The DeepSeek Harness (DSH) adapter links desktop DSH sessions into an orrery cluster via the self-contained Cordis bundle `plugins/dsh-orrery/`.

## Mechanism: Bundle Plugin + Shared Bridge Stream

`plugins/dsh-orrery/` is a zero-dependency ESM bundle (`engines.dsh: >=0.2.1-rc.2 <0.3.0-0`) installed and enabled manually by the user inside DSH.

1. **Loopback discovery & shared stream**: On each reconnect, reads `<ORRERY_HOME or ~/.orrery>/hub.json` over an isolated `node:http` agent (bypassing proxy env vars) and opens `GET /bridge/stream?harness=deepseek`.
2. **Turn-end batching (`follows: true`)**:
   - Because DSH runs one turn per queued prompt without merging, the plugin hooks `session/event` before calling `ctx.sessionController.prompt({ requestId: deliveryId, sessionId, mode: 'queue', ... }, signal)`.
   - Once `rpcId === deliveryId` finishes (`turn/end`), the plugin sends `POST /bridge/done` (`completed`, `failed`, or `unknown` on timeout/disconnect). Meanwhile the Hub queues subsequent mentions and merges them into the next batch.
   - Older DSH builds or older plugin copies omitting `follows` fall back to immediate `accepted` semantics.
3. **Prefixed MCP tools**: Registers collaboration tools via `ctx.tools.register` under `mcp__orrery__*` (avoiding collision with DSH's built-in `send_message` and `list_agents`), projecting parameters to DSH's supported JSON Schema subset while relying on Hub validation. Sends `x-orrery-harness: deepseek` and `x-orrery-session` from trusted `exec.agent.id`.
4. **Post-tool unread hints**: Hooks `tools/post-execute` (500ms timeout) to query `/bridge/unread-hint` and prepend one compact `UserMessage` (`source.kind: 'dsh-orrery'`) to `additionalContexts` only when unread counts changed.

## One-Time Install & Reload

See [plugins/dsh-orrery/README.en.md](../../plugins/dsh-orrery/README.en.md) for full steps:

1. In DSH **Plugins → Add plugin**, enter the absolute path to `<orrery>/plugins/dsh-orrery` (or exit DSH and run `dsh plugin --profile desktop add link:<absolute-path>`).
2. Whenever orrery updates, disable and re-enable `dsh-orrery` in DSH (or restart DSH) so the updated bundle reloads. Disabling immediately marks members offline without backfilling missed chat messages.

## Listing, Activity & Tokens

- **Read-only store (`src/adapters/deepseek/store.ts`)**: Reads `<DSH_HOME or ~/.dsh>/storages/session_projcache/sessions/*.json` for workspace path, title, and timestamp, filtering out subagent records.
- **Tokens & quotas**: Subscription quotas are unsupported (API-key metered; keys never touched); per-turn token totals accumulate `assistant/message` usage up to `done`, and whole-session totals come read-only from `tokenUsage` projection caches.

## Security & Verified Use

- **Approval warning**: Delivered prompts execute under your active DSH permission preset (auto-approve profiles run cluster `@mentions` unattended). The plugin never reads `~/.dsh/.credentials.yaml`, alters session settings, or logs bridge secrets.
- **Verified use**: Real-app checks cover incoming messages, MCP replies, busy-turn batching, and staying online after the main window is closed to the tray.
- **Activity observation**: A real-app smoke check covered message exchange, turn completion, and heartbeat display.
- **Token counts**: Per-turn values are reported by the host; detailed cache and multi-tool accounting is separate from the basic delivery checks.
