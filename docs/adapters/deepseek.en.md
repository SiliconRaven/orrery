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

## Reading the Native Conversation

Official plugins and full-trust plugins the user confirmed can read, page by page, the DeepSeek Harness session a member is currently bound to through `Hub.memberTranscript` (contract in the [Architecture](../architecture.en.md#reading-a-members-bound-native-conversation)). Reading is read-only: no file is written and the app is never started.

- **Which file**: `<DSH_HOME or ~/.dsh>/sessions/<project folder>/<session id>/session.v<N>.jsonl.zstd`, newest generation only; after a new generation appears, old cursors return `reset`. A session id found in two project folders is refused, and the first record must be that session's own header. The real file must stay inside the `sessions` folder; links and hard links are refused.
- **Multi-frame zstd**: DSH appends one zstd frame per write. Node's built-in zstd decoder decodes only the first frame of a multi-frame input and still returns data when a frame's trailing checksum is cut off, so the reader finds complete frames itself from the frame and block headers (RFC 8878), leaves a partly written last frame for the next read, hands the decoder exactly one complete frame at a time, and inflates only the frames a page needs. Cursors record the frame start, record and item, so they stay valid when frames are appended.
- **Limits**: compressed files above 32 MiB are not read (`archived`); each frame inflates to at most 4 MiB with a decoder window of at most 8 MiB, and a frame over the limit or corrupt becomes one unrecognized item; a page inflates at most 8 MiB or 1024 frames (the first frame inflated to check the header counts too) and stops at a frame boundary once less than one frame's limit is left, then continues with a cursor; every page reads at least one frame; one record is at most 1 MiB. Data that is not a zstd frame returns `unsupported`.
- **Classification**: user messages, reasoning (a placeholder only, never the reasoning text), answers, tool calls and results (including the sub-calls made inside `run_code`), interruptions and compaction notes are classified; context DSH injects for the model, steps, background jobs and settings records are hidden; unknown records are counted as unrecognized.
- **Recognizing orrery deliveries**: the plugin queues each delivery with the Hub's delivery id as the request id, which DSH stores on that user message. The adapter hands only that request id to the Hub as unverified delivery evidence; the Hub shows the message as a delivery only when the id is a batch it really delivered to this member, with content from its own records. Text is never evidence and a record without a request id is never treated as a delivery, so an envelope or direct message body typed by hand in the app stays user input. What remains spoofable is sending another prompt through DSH's session interface with a known real delivery id, and that only shows the bodies of messages already delivered to this member. Member posts are linked through the message id in a successful `mcp__<server>__send_message` result, with no fixed server name, and only to messages this member sent.
- **Checked against**: DeepSeek Harness 0.2.1-rc.2 session files (structure only); tests use hand-written synthetic records compressed at run time.
