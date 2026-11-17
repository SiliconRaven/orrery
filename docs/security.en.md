# Security Model

Language: [中文](security.md) | **English**

This document defines local security boundaries, explicit non-goals, and severity grading for orrery Native Mode.

## Trust Boundaries

- **Loopback-only networking**: Hub Web and MCP servers bind strictly to `127.0.0.1` with no LAN or public exposure.
- **Credential isolation**:
  - Static UI pages serve without auth, while all `/api/*` endpoints (including `GET /api/health`) and `/api/stream` require an API Bearer token or an `HttpOnly` cookie set via `POST /api/session` (`401` otherwise).
  - Native `/mcp` callers authenticate via `x-orrery-bridge` paired with tamper-resistant host context (native Codex sends **bridge secret only** with zero session/harness headers and relies on `_meta.threadId`; Claude/DSH/WorkBuddy/Cursor pass session headers via bridge/hook; ZCode/Qoder rely on runtime `_meta`; Antigravity requires HMAC-signed `orreryCaller` arguments).
- **Zero-intrusion policy**:
  - Never installs, enables, or edits user configs, plugins, or credentials of host apps.
  - Only sends deliveries to explicitly attached conversations; session discovery reads files directly or via temporary copies without editing source databases.
- **Never auto-launch host apps**: Adapters, bridges, and plugins never open closed desktop apps (only an explicit user click in the trusted Electron shell's `+` strip may launch allowlisted apps). Closed apps remain offline with no replay queue.
- **Inherits user host permissions**: Native sessions execute under your existing host app approval configuration; prompts are not guaranteed for every step.
- **Kimi token exception**: `~/.kimi-code/server.token` stays in memory and travels over proxy-bypassed loopback requests only after verifying Windows executable (`Kimi Code.exe` / `kimi.exe`) and `netstat` TCP PID ownership; never logged or stored in SQLite.

## Mitigations

1. **Block unauthorized network calls**: Loopback binding and API/bridge credentials prevent remote access.
2. **Prevent cross-session impersonation**: Model-supplied arguments cannot spoof other members.
3. **Hub-enforced hidden state (`hiddenAt`)**: **Not just UI filtering**—the Hub drops deliveries to hidden members, rejects every MCP tool call (even reads return the hidden notice without acting), bars new assignments or `@mentions`, and conceals them from peers (only the user and enabled coordinator see them). Prior messages and tasks remain in storage.
4. **Outbox path-escape checks**: `send_message` `attachments` reject separators, UNC paths, symlinks, and multi-hardlink files, copying verified files without modifying outbox originals.
5. **Purge scope**: `POST /api/clusters/:id/purge` deletes soft-deleted SQLite rows and orphaned blobs within standard SQLite page rules (not physical disk sector wiping).
6. **External plugins are not OS sandboxes**: Plugins ([External Plugins](external-plugins.en.md)) run as separate OS processes; `permissions`, `clusterIds`, `writeClusterIds`, and `mentionEnabled` constrain Hub protocol capabilities only. Run trusted code only.

## Non-Goals

- **Malicious local software running as your OS user**: Processes able to read `~/.orrery/secret`, `api-token`, `hub.json`, or overwrite local files share OS user privileges and sit outside scope.
- **User-enabled auto-run presets in host apps**: Cluster `@mentions` execute automatically if you configure auto-approve inside your host app.
- **Vendor ToS & cloud policies**: External ToS compliance (such as Antigravity notices) remains the user's responsibility.

## Severity Grading

- **P1 (Blocker)**: Exploitable security flaws, caller impersonation, unauthorized app launches, or data loss/corruption. Must be fixed before landing.
- **P2 (Major)**: Significant correctness, contract, or stability bugs without direct security or data-loss impact.
- **P3 (Hardening)**: Defense-in-depth improvements or theoretical edges outside the threat model.
