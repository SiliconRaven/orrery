# Security Model

Language: [中文](security.md) | **English**

This document defines local security boundaries, explicit non-goals, and severity grading for orrery Native Mode.

## Trust Boundaries

- **Loopback-only networking**: Hub Web and MCP servers bind strictly to `127.0.0.1` with no LAN or public exposure.
- **Credential isolation**:
  - Static UI pages serve without auth, while all `/api/*` endpoints (including `GET /api/health`) and `/api/stream` require an API Bearer token or an `HttpOnly` cookie set via `POST /api/session` (`401` otherwise).
  - Native `/mcp` callers authenticate via `x-orrery-bridge` paired with tamper-resistant host context (native Codex sends **bridge secret only** with zero session/harness headers and relies on `_meta.threadId`; Claude/DSH/WorkBuddy/Cursor pass session headers via bridge/hook; ZCode/Qoder rely on runtime `_meta`; Antigravity requires HMAC-signed `orreryCaller` arguments). The `Authorization` header identifies nobody on `/mcp`.
- **Zero-intrusion policy**:
  - Never installs, enables, or edits user configs, plugins, or credentials of host apps.
  - Only sends deliveries to explicitly attached conversations; session discovery reads files directly or via temporary copies without editing source databases.
- **Never auto-launch host apps**: The Hub, adapters, bridges and plugins never open closed desktop apps. The single exception is the Electron desktop shell: when the user clicks a supported app that is not running in the trusted tab bar's `+` panel, the shell starts it without arguments and without URL protocols (see [Desktop Shell](desktop.en.md)). Closed apps remain offline with no replay queue.
- **Inherits user host permissions**: Native sessions execute under your existing host app approval configuration; prompts are not guaranteed for every step.
- **Kimi token exception**: `~/.kimi-code/server.token` stays in memory and travels over proxy-bypassed loopback requests only after verifying Windows executable (`Kimi Code.exe` / `kimi.exe`) and `netstat` TCP PID ownership; never logged or stored in SQLite.

## Mitigations

1. **Block unauthorized network calls**: Loopback binding and API/bridge credentials prevent remote access; `/api/*` writes must be same-origin JSON.
2. **Prevent cross-session impersonation**: Model-supplied arguments cannot spoof other members.
3. **Hub-enforced hidden state (`hiddenAt`)**: **Not just UI filtering**—the Hub drops deliveries to hidden members, rejects every MCP tool call (even reads return the hidden notice without acting), bars new assignments or `@mentions`, and conceals them from peers (only the user and enabled coordinator see them). Prior messages and tasks remain in storage.
4. **Outbox path-escape checks**: `send_message` `attachments` reject separators, UNC paths, symlinks, and multi-hardlink files, copying verified files without modifying outbox originals.
5. **Purge scope**: `POST /api/clusters/:id/purge` deletes soft-deleted SQLite rows and orphaned blobs within standard SQLite page rules (not physical disk sector wiping). Plugins whose cleanup hook did not run may leave data behind, and the result says so.
6. **Read-only Git**: when the Hub reads Git repositories in members' projects (branch candidates, task branch links, automatic linking on submit, checking ship results) it only uses ref and object reading subcommands (`worktree list`, `rev-parse`, `for-each-ref`, `merge-base --is-ancestor`, `config --get`), never fetches, never changes refs or config; its environment disables lazy fetching in partial clones, every transport protocol, interactive prompts and proxy commands, and timeouts kill git and its children.
7. **The Skills & MCP page reads only what it needs**: from each app's skills and MCP configuration it returns skill names and descriptions, and each MCP server's name, transport and target (program file name, or URL scheme and host); arguments, environment variables, headers and secrets are never read out. Installing a skill only writes the shared skills folder, rejects links, and is available to the user only (see [Files & Skills](files.en.md)).
8. **Third-party plugins have two tiers of promises**, described in the next two sections.

## Bodies of Bound Conversations

Beyond conversation lists, titles and usage, official plugins and user-confirmed full-trust plugins can call an in-process Hub method to read the body of the Claude or Codex conversation a member is currently bound to ([Architecture](architecture.en.md#reading-a-members-bound-native-conversation)). The caller only gives a member ID; the Hub takes the app and session from its own member records and checks the binding before and after the asynchronous read, so results for an old binding are withheld once the member is removed, rebound or its group goes to the trash. Adapters check the files actually read against the app's data folder.

Each call reads one page and returns it in memory only. The core has no web, MCP or restricted-plugin interface for bodies and never writes them to the database, events or logs. When an orrery delivery or member post is recognised, the Hub verifies the link against the current member, its group and its own message records; without evidence the native item is kept as is and no message ID is guessed. Thinking content only shows the summary or placeholder the app itself makes visible.

In apps without a trusted marker (deliveries show up in a wait command's result, a `system` record or an unmarked user record), the adapter only hands over unverified delivery candidates (a delivery ID, an envelope or a direct body; rules in the [Architecture](architecture.en.md#reading-a-members-bound-native-conversation)). The Hub shows the item as a delivery only when its own delivery records prove that message was really delivered to this member in this member's group; otherwise the item is kept as is. Accepted limit: in these apps, text the user types that is identical to an envelope or body really delivered to that member is shown as that delivery; what is shown comes from the real Hub message, so nothing from another group or member can appear.

- **Kimi Code**: Reads only the bound session's `agents/main/wire.jsonl` confined inside `sessions/` (after verifying the session ID in `state.json` and rejecting symlinks/hardlinks), never reading `server.token` or contacting the local service; thinking blocks emit placeholders without raw text.
- **DeepSeek Harness**: Session logs are multi-frame zstd: inflation happens frame by frame and is capped (compressed files above 32 MiB are not read; 4 MiB of output and an 8 MiB decoder window per frame; 8 MiB or 1024 frames per page) against decompression bombs. A delivery is recognised only by the request id the plugin sets: the Hub accepts it only when it is a batch really delivered to this member. Text is never evidence and a record without a request id is never treated as a delivery, so an envelope or direct body typed by hand stays user input. What remains spoofable is sending another prompt through DSH's session interface with a known real delivery id, and that only shows the bodies of messages already delivered to this member. See the [DeepSeek adapter](adapters/deepseek.en.md#reading-the-native-conversation).
- **ZCode**: Keeps the body in its own SQLite database, which is opened in place and read-only: it is not copied and no file is written (method, measurements and the one race left are on the [ZCode adapter](adapters/zcode.en.md#reading-the-conversation-body) page). The database and its `-wal`/`-shm` must be plain files under the ZCode folder; links and hard links are refused; only the bound session's rows are queried. Delivery evidence comes only from a `Read` result that is the whole wait command output carrying this session's ticket; text the user types never counts, even if it looks like an envelope.
- **Qoder**: Keeps the body in the app's own SQLite database, opened in place and read-only by the same reader as ZCode: it is not copied and no file is written (a `-wal` without its `-shm` is not opened and gives `unsupported`; the one race left is as for ZCode). The database and its `-wal`/`-shm` must be plain files under the Qoder data folder; links and hard links are refused; the session ID must be a UUID and only the bound session's rows are queried. Delivery evidence comes from one kind of `Read` result only: the background task this turn was waiting on is this session's own wait command, byte for byte with this session's ticket, and the `Read` returns that task's whole output file. Text the user types, another session's ticket and other tools' output never count (see the [Qoder adapter](adapters/qoder.en.md#reading-the-conversation-body)).
- **Cursor**: Reads only the bound session's `agent-transcripts/<id>/<id>.jsonl` confined under `<cursorHome>/projects` (rejecting invalid IDs, links, and hardlinks) and never opens any `state.vscdb`; only lines starting with the 8-hex handout marker are checked as unverified Hub delivery candidates (misses remain `user`), `thinking` is redacted, and `orrery_post` is never guessed without `tool_result`.
- **WorkBuddy**: Reads only `<workbuddyHome>/projects/<proj>/<sessionId>.jsonl` (skipping `subagents/`, checking `session-meta.sessionId`, rejecting links and hardlinks, never touching `workbuddy.db`); `reasoning` emits redacted placeholders; delivery candidates come only from `TaskOutput` or wait-command shell results carrying this session's wait ticket, while direct and `DeferExecuteTool` `send_message` calls pair by `callId` to verify `orrery_post`.
- **Antigravity**: Reads only `transcript_full.jsonl` under `<geminiHome>/antigravity/brain/<uuid>/.system_generated/logs/` (falling back to `transcript.jsonl` only when absent; links and hardlinks fail closed without fallback; never reads `.pb` or `conversations/*.db`); `thinking` is redacted and `orreryCaller` HMAC signatures are stripped/redacted from `tool_call` text; only `SYSTEM_MESSAGE` (`sender=system`, `MESSAGE_PRIORITY_HIGH`) submits delivery candidates (`USER_INPUT` never promotes), while successful `call_mcp_tool` results verify `orrery_post` by positional `callId`.

## Restricted Third-Party Plugins

Restricted plugins ([Third-party plugins](external-plugins.en.md)) run as separate OS processes and talk to the Hub over stdio. Permissions, event grants, `clusterIds`, `writeClusterIds`, tool grants and UI position grants only limit what they can do **through the orrery protocol**:

- **Reads and events**: only within granted groups and types; granting an event type grants reading its content (for example task titles, scope, review comments and commit SHAs), and wildcards include types added later. Message bodies additionally need `messages.read`. Event queues are bounded, so a stuck plugin only loses its own events.
- **Posting**: needs `messages.send` and a separate write list; waking members also needs `messages.mention` plus a user switch, and obeys pause, loop limits and rate limits. Plugin posts are signed `plugin:<id>`; members should treat the text as a teammate's request.
- **Message checks**: can only refuse a member's message, never rewrite it; every refusal leaves a record in the group; no answer means allow (fail-open) with a record, so a broken plugin cannot silence a group.
- **Commands**: only the user can run them; runs never write to the chat or wake members.
- **Member tools**: the caller is identified only from the bridge's session, arguments are checked against the declaration, and the caller is identified again after the answer; every call leaves a metadata-only record (no argument or result contents). Answers enter the member's context and should be treated as untrusted tool output.
- **Pages and marks**: pages run in `<iframe sandbox="allow-scripts">` with an opaque origin; they cannot read cookies, tokens, the collaboration page or storage, cannot call Hub APIs, and can only talk to their own plugin process through the page. Files come only from the plugin's `ui/`, and the frame ID in the address stops working when the UI closes, the plugin stops or the Hub restarts. Marks are drawn by orrery as dashed chips with a fixed third-party plugin icon; the plugin only supplies text. Known limits: frame isolation does not stop the plugin process from sending data out, and whether WebRTC is blocked has not been verified.

**A separate process is not a security sandbox.** Plugins run under the same OS account and can bypass the protocol to reach that account's files, network and programs (Hub files included). Run trusted code only.

## Full-Trust Third-Party Plugins

Full-trust plugins ([Third-party plugins, "Full-trust plugins"](external-plugins.en.md#full-trust-plugins)) run inside the Hub process after the user confirms them, with the same power as orrery itself.

**What this tier guarantees** (violations are P1):

- **No code runs before confirmation**: registering only adds a card in Settings; before confirmation, after revocation and with `ORRERY_SAFE_MODE=1`, the Hub neither imports the entry nor runs its migrations.
- **Only the user can confirm, and confirmation binds the entry file's real path**: the confirm endpoint needs the API token and same-origin JSON; the plugin protocol, MCP tools and sandboxed frames cannot write it. A moved entry needs a new confirmation.
- **Diagnosable load failures only skip that plugin**: a failed import, an import plus default export that does not finish within 10 seconds (asynchronous hangs), conflicting slots, routes outside `/api/x/<id>/`, migrations outside the `x_<id>_` prefix, or a failed pre-upgrade backup only skip that plugin and its dependents, and the Hub starts normally. Synchronous blocking is not covered; see "what it does not guarantee" below.
- **Pages load only the web modules allowed this time**: only modules listed in `trustedFrontend` are imported, and files are served only from the plugin's own `webEntry` folder, never HTML or the Hub entry.
- **Open pages detach the plugin in place when trust ends**: its slots are no longer called, its elements are removed and its `onDispose` is called; the page never reloads by itself and never loses unsent input.
- **Purging a group never pretends to be complete**: if a plugin's cleanup hook did not run, the result says its tables may still hold data for that group.

**What it does not guarantee** (the responsibility of whoever installs the plugin): the plugin can read and write any data in the database, bypass loop limits, pause and delivery records, and start programs itself; "the user can see what every member received" does not hold for it. Its own timers and unhandled promise rejections can make the Hub exit, and an endless loop freezes the Hub. Until the page is refreshed its web module code stays in page memory. Its tables remain after uninstalling; the automatic pre-upgrade backup can be used to roll back, but the Hub never restores it automatically.

## Non-Goals

- **Malicious local software running as your OS user**: Processes able to read `~/.orrery/secret`, `api-token`, `hub.json`, or overwrite plugin files or `plugins.json`, share OS user privileges and sit outside scope.
- **User-enabled auto-run presets in host apps**: Cluster `@mentions` execute automatically if you configure auto-approve inside your host app.
- **Plugins the user installs**: restricted plugin processes and full-trust plugin code run as described above; harm they do within "what it does not guarantee" is not an orrery defect.
- **Vendor ToS & cloud policies**: External ToS compliance (such as Antigravity notices) remains the user's responsibility.

## Severity Grading

- **P1 (Blocker)**: Exploitable security flaws, caller impersonation, unauthorized app launches, or data loss/corruption. Must be fixed before landing.
- **P2 (Major)**: Significant correctness, contract, or stability bugs without direct security or data-loss impact.
- **P3 (Hardening)**: Defense-in-depth improvements or theoretical edges outside the threat model.
