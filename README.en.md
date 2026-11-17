# orrery (`v0.10.0-beta.1` Beta)

Language: [中文](README.md) | **English**

> **Beta Notice**: This release is **v0.10.0-beta.1 (Beta pre-release)**, not a final stable release. Interfaces, protocols, and plugin configurations may change.

orrery is a Windows-first local multi-agent collaboration desktop and Hub (Native Mode only). It connects active conversations already running in your AI coding apps (plus newly created native sessions where supported) inside shared group chats and task boards, with all traffic logged locally.

## Windows Installer

The Windows x64 installer includes Node and the runtime dependencies. It installs Orrery Beta and its own shortcuts; Node on `PATH` is not required. Data lives under `%APPDATA%/Orrery Beta/hub` and is retained during upgrades and uninstall.

The Beta installer is unsigned. Windows may show an unknown-publisher warning; use the checksum provided with the download.

## Run from Source

Requirements: Windows 10/11 (primary platform) and **Node.js >= 24.2**.

```powershell
git clone https://github.com/SiliconRaven/orrery.git orrery
cd orrery
npm ci
npm run open
```

- `npm run open` reuses a matching Hub for the same data directory or starts one in the background, then opens the collaboration UI (`npm start` runs in foreground; `npm run shortcut` creates a desktop shortcut).
- Open the UI through `npm run open`, the desktop shortcut, or the desktop shell to sign in with the token. APIs accept a Bearer token or a session cookie; see the [Security Model](docs/security.en.md).

### Optional: Desktop Shell

`desktop/` provides an optional Electron wrapper (also `v0.10.0-beta.1` Beta) that docks and switches running top-level host windows without embedding third-party UIs:

```powershell
npm ci --prefix desktop
npm start --prefix desktop
```

See [Desktop Shell](docs/desktop.en.md).

## Supported Native Harnesses

Every member attaches in **Native Mode (`NativeAdapter`)** to a conversation inside its host app, inheriting your existing app permissions (prompts are not guaranteed on every action). Closed apps appear offline without auto-launch or replay on restart:

| Harness | Integration | Guide |
|---|---|---|
| Claude Code | Session inbox bridge `claude-bridge` | [Claude Adapter](docs/adapters/claude-adapter.en.md) |
| Codex | Short-lived `app-server` queue wake (attach or create native threads) | [Codex Adapter](docs/adapters/codex.en.md) |
| Cursor | User plugin (`stop` / `beforeSubmitPrompt` / `postToolUse`) | [Cursor Adapter](docs/adapters/cursor.en.md) |
| DeepSeek Harness | Cordis bundle `dsh-orrery` | [DSH Adapter](docs/adapters/deepseek.en.md) |
| Kimi Code | Local instance REST + `subscribe_v2` WebSocket | [Kimi Adapter](docs/adapters/kimi.en.md) |
| ZCode | `_meta` + background wait command `wait.mjs` | [ZCode Adapter](docs/adapters/zcode.en.md) |
| Qoder | Plugin MCP relay + background wait command | [Qoder Adapter](docs/adapters/qoder.en.md) |
| WorkBuddy | Parent-process MCP bridge + background wait command | [WorkBuddy Adapter](docs/adapters/workbuddy.en.md) |
| Antigravity | Sidecar + signed Hook (includes ToS notice) | [Antigravity Adapter](docs/adapters/antigravity.en.md) |

> **Security Note**: Deliveries run under your own host app permissions. Cluster names may include spaces, while member names reject spaces and control characters. See [Security Model](docs/security.en.md).

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ORRERY_PORT` | Hub HTTP listening port | `4317` |
| `ORRERY_HOME` | Data root (`hub.json`, `secret`, `api-token`, `hub.log`) | `~/.orrery` |
| `ORRERY_DB` | SQLite database file path | `<repo>/.tmp/orrery.db` |
| `ORRERY_SKILLS_DIR` | Local skills folder scanned for `$` completion | `~/.agents/skills` |
| `ORRERY_MOCK` | Set to `1` to enable native in-memory `mock` adapter (tests/benchmarks) | Off |
| `ORRERY_MAX_HOPS` | Max hops per chain (non-negative integer only, `0` allowed; no `unlimited`) | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | Max turns per chain (non-negative integer only, `0` allowed; no `unlimited`) | `20` |

## Common Commands

```powershell
npm test                                 # Run automated tests (separate test ports & temp dirs, never 4317)
npm run check:health                     # Knip check for unused files, deps, and cycles (no tests, not a CVE audit)
npm run check:exports                    # Check unused export/type candidates only (no file checks, no tests)
npm run --silent bench:collaboration     # Run reproducible mock collaboration benchmark (not live-model scores)
npm run clean:temp                       # Clean leftover test temporary artifacts
npm run backup                           # Back up local private Hub SQLite database
```

## Documentation Index

- **Architecture & Design**: [Architecture](docs/architecture.en.md) · [Native Mode](docs/native-mode.en.md) · [Loop Limits](docs/hop-limit.en.md) · [Security Model](docs/security.en.md)
- **Collaboration & Tasks**: [Collaboration & Tasks](docs/collaboration.en.md) · [Collaboration API](docs/collaboration-api.en.md) · [Members & Handover](docs/cluster-members.en.md) · [Built-in Plugins](docs/plugins.en.md)
- **Operations & Extensions**: [Desktop Shell](docs/desktop.en.md) · [Launcher](docs/launcher.en.md) · [Files & Skills](docs/files.en.md) · [Usage & Quotas](docs/usage.en.md) · [Activity Observation](docs/activity.en.md) · [External Plugins](docs/external-plugins.en.md) · [Unread Hint Hook](docs/adapters/unread-hook.en.md)
- **Maintenance & Notices**: [Code Health](docs/code-health.en.md) · [Collaboration Benchmark](docs/evaluation.en.md) · [Third-Party Notices](docs/third-party.en.md)

## License

Source code in this repository is licensed under the **MIT License** (`orrery contributors`; see the root `LICENSE` file for the English legal text). Third-party application icons and dependencies retain their own rights and licenses; see [Third-Party Notices](docs/third-party.en.md). The original project SVG icon is included under MIT.
