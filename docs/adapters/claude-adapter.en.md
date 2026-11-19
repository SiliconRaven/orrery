# Claude Adapter (Native Mode)

Language: [中文](claude-adapter.md) | **English**

Native Claude members bind to active local Claude Code sessions via the user-configured stdio MCP bridge (`src/bridge/claude-bridge.ts`). An optional [Unread Hint Hook](unread-hook.en.md#claude-code) is also available.

## Mechanism & Inbox Delivery

1. **Read-only listing (`src/adapters/claude/store.ts`)**: Reads workspace `cwd`, title, model, and mtime from local Claude project transcripts without editing files (no Hub-side `createSession`; start a new session in Claude with at least one turn first).
2. **Header separation**: The bridge reads `<ORRERY_HOME or ~/.orrery>/hub.json` read-only and connects over loopback: **`x-orrery-bridge` carries the bridge secret while `x-orrery-session` carries the session ID** (`x-orrery-harness: claude`, defaulted when omitted for legacy compatibility).
3. **Inbox ack semantics**: On `deliver`, the bridge writes the auth line plus `[orrery]` envelope to `CLAUDE_CODE_MESSAGING_SOCKET` (keeping the inbox token out of Hub requests) and posts `POST /bridge/ack`; **ack confirms inbox write only (`accepted`), NOT that Claude started or finished a turn** (native Claude reports no per-turn tokens).
4. **`tools/list_changed` limits**: Emits `notifications/tools/list_changed` only when reconnecting to a new Hub port or recovering after answering `tools/list` offline from cached definitions—not automatically on every mid-session plugin change.
5. **Offline semantics**: Only live sessions host an inbox socket; closed sessions stay offline and missed messages remain in chat without replay (except brief initial Hub-startup grace queues).

## Usage Status, Quotas & Session Tokens

- **Quotas & totals**: Queries `get_usage` on manual refresh or eligible coordinator quota checks (governed by cooldowns and managed policy checks without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), and sums session totals from transcripts + subagents deduplicated by `message.id`.
- **Verified use**: Native Claude Desktop has passed real-app checks covering online discovery, incoming delivery, MCP replies, continued conversation context, and direct messages from the member page.

## Reading the Conversation Record (`transcript`)

When a plugin reads a member's bound native conversation through the Hub (see [Architecture](../architecture.en.md#reading-a-members-bound-native-conversation)), the adapter locates the session's `projects/<folder>/<session ID>.jsonl` and reads older and newly appended records with a byte cursor:

- Claude writes one assistant message across several lines; the parser keeps every content block and gives repeated blocks the same ID. Compaction continuations appear as system records; sidechains and duplicate API records are skipped. Thinking only shows an explicit summary or marker, and unrecognised records show their type or a placeholder.
- When several copies share a name, the session ID at the start of the file is checked and the matching copy wins. Tool results show their native text; non-text content shows a placeholder.
- Inbox deliveries are recognised from native peer metadata (including attachments queued while busy) and their envelopes are verified by the Hub; member posts are hinted by structured tool calls and the success result with the same call ID, and the Hub verifies which message they belong to.
- Known limit: several thinking blocks without id or index in one assistant message are merged into one.

`node --test test/claude-transcript.test.ts` checks these rules with synthetic JSONL in a temporary folder.
