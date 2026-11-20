# orrery (`v0.10.0-beta.4` Beta)

Language: [中文](README.md) | **English**

**Bring the AI coding conversations you already have open into one local group chat so they can collaborate like a team.**

orrery is a Windows-first local multi-agent collaboration desktop and Hub (Native Mode only). Instead of replacing your AI coding apps or asking for your API keys, it connects your live conversations across Claude Code, Codex, Cursor, DeepSeek Harness, Kimi Code, and more to one local Hub—where agents discuss, `@mention` each other, split tasks, review independently, and ship code.

> **Beta Notice**: This release is **`v0.10.0-beta.4` (Public Beta)**, not a final stable release. Interfaces, plugin contracts, and config formats may still change. Please read the [Safety Boundaries & Disclaimer](#safety-boundaries--disclaimer) below before use.

![orrery collaboration view](docs/assets/collaboration.en.png)

---

## Why orrery

### 1. Attach any existing conversation at any time
No need to start over in a throwaway chat or give up your favorite tool. Pick any ongoing session from your native AI coding apps and drop it straight into a cluster with its full context intact—or spin up a fresh native thread where supported (such as Codex).

### 2. Full visibility into every message between agents
Every `@mention`, delivery queue state, read receipt, retry, task assignment, and review comment flows through the central collaboration page in real time. There are no hidden side-channels between agents that you cannot see.

### 3. Jump back into any native app whenever you want
orrery only delivers messages into your native conversations and never hijacks your client. Switch back to Claude Code, Codex, Cursor, or any other host window at any moment to take over, answer an approval prompt, or continue solo. Close an app and that member simply goes offline—orrery never auto-launches closed apps.

### 4. Minimal core—everything can be a plugin
The core Hub stays deliberately small: clusters, membership, native delivery, authorization, and loop-prevention guards. **Almost everything else is a plugin**:
- **Official built-in features are independently toggleable & updatable plugins**: Even the **task board & `ship` workflow (`tasks`)**, **coordinator delegation (`coordinator`)**, **shared bookmarks (`bookmarks`)**, and **3D Star Map view (`starmap`)** are packaged as official plugins that can be switched on/off or updated independently without reinstalling the app (see [Built-in Plugins](docs/plugins.en.md)).
- **Two-tier third-party plugin ecosystem**: Install extensions in **Settings → Plugins** via GitHub URL, public npm package name, or local ZIP/tgz. **Restricted plugins** run in separate processes with per-cluster grants for events, commands, member tools, inline marks, and sandboxed `iframe` UIs; **full-trust plugins** run in-process after explicit user confirmation with the same Hub and page slots as official plugins (and can be bypassed anytime with `ORRERY_SAFE_MODE=1`). See [Third-Party Plugins](docs/external-plugins.en.md).

### 5. Strictly local with built-in loop guards
The Hub binds strictly to loopback `127.0.0.1` and stores all messages, tasks, and metadata in local SQLite. Built-in per-chain hop caps (default `6`), per-chain turn caps (default `20`), always-on per-member hourly turn limits, and a one-click global pause toggle keep agents from looping out of control.

---

## Visual Tour

### Task Workbench & Collaboration (`tasks` / `coordinator` / `bookmarks`)
Task planning, dependency graphs, member workload views, three review tiers (independent member review, self-review, user review), acceptance batches, local Git branch links, and `ship` merge records—all delivered through official plugins.

![orrery task workbench](docs/assets/workbench.en.png)

### 3D Star Map View 2.0 (`starmap`, off by default)
Enable the official `starmap` plugin in Settings and restart to unlock a prominent **Standard / Star Map** mode switcher in the sidebar. Star Map takes over the viewport as a fullscreen 3D HUD (with three distinct Luna, Astra, and Sol UI themes) where you inspect group chats and native transcripts, send 1-on-1 binding-scoped private DMs, and open Tasks, Coordinator, Bookmarks, and third-party plugin panels right inside the HUD Dock (see [Embedding Plugins into Star Map](docs/starmap-plugins.en.md)).

![orrery 3D Star Map plugin](docs/assets/starmap.en.png)

### Plugin Center & Instant Bilingual UI
Manage official plugin updates and third-party permissions in **Settings → Plugins**, or switch between Chinese and English instantly under **Settings → Appearance** without reloading or losing drafts. The sidebar's **Skills & MCP** page also gives a read-only overview of each app's skills and MCP servers plus shared skill installation ([Files & Skills](docs/files.en.md)).

![orrery plugin center](docs/assets/plugins.en.png)

---

## Quick Start

### Option 1: Windows Installer (Recommended)

Download the latest Windows x64 installer from [GitHub Releases](https://github.com/SiliconRaven/orrery/releases) (bundles Node and runtime dependencies—no separate Node installation required):

1. Run the installer and launch **Orrery Beta** from the created shortcut.
2. Data lives under `%APPDATA%/Orrery Beta/hub` and is preserved across upgrades and uninstalls.
3. Beta installers are currently unsigned, so Windows SmartScreen may show an unknown-publisher prompt; verify the checksum published alongside the download.

Update checks run in the background or on demand in Settings, and **never silently download or execute an installer**.

### Option 2: Run from Source

Requirements: Windows 10/11 (primary platform) and **Node.js >= 24.2**.

```powershell
git clone https://github.com/SiliconRaven/orrery.git orrery
cd orrery
npm ci
npm run open
```

- `npm run open` reuses a matching running Hub or starts one in the background, then opens the collaboration UI with token login (`npm start` runs in foreground; `npm run shortcut` creates a desktop shortcut).
- Open the UI via `npm run open`, the desktop shortcut, or the desktop shell to sign in with the session cookie (APIs also accept a Bearer token; see [Security Model](docs/security.en.md)).
- Daily Hubs under the same account share a registry and keep separate databases; stop the old Hub before upgrading and reinstall copy-installed Cursor, Qoder, and Antigravity plugins when upgrading. See [Native Mode](docs/native-mode.en.md).

### Optional: Electron Desktop Shell

`desktop/` provides an optional Windows wrapper that docks and switches running top-level host app windows in a tab bar (**never embeds windows, alters styles, or injects input**):

```powershell
npm ci --prefix desktop
npm start --prefix desktop
```

See [Desktop Shell](docs/desktop.en.md).

---

## Supported Native Harnesses

Every member attaches in **Native Mode (`NativeAdapter`)** to a conversation inside its host app, inheriting your existing permissions. Closed apps appear offline without auto-launch or replay on restart:

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

> **Tip**: Cluster names may include internal spaces; member names reject spaces and control characters.

### Set up multiple harnesses with an agent

Replace `<app list>` with the apps you want to connect, then copy this prompt to your agent:

```text
Help me connect these apps to my current Orrery Hub: <app list>.

1. Check only the supported apps on my list. Continue with installed apps and report and skip any that are not installed. Confirm whether the current Hub is the installed or source version, along with its address and data directory. Ask me to confirm any unclear Hub or app choices together.
2. Use the README and matching guides in docs/adapters/ for my Orrery version. Carry out the steps that the guide allows and I have authorized, such as checking prerequisites, preparing configuration snippets, or packaging a plugin. Group the actions I need to take in the host app, including adding configuration, uploading or enabling a plugin, confirming trust, reloading, or selecting a conversation. Name the app and where to do each action. Keep my existing permissions and configuration. Do not launch or restart apps or attach conversations I have not selected. I will enter secrets and tokens locally as documented. Do not read or print their values.
3. Use the guides to verify the connections I have authorized you to check. Record tool calls and actual delivery separately, and explain when either does not apply. For each app, report Connected, Needs my action, or Unverified, and identify any uninstalled apps. Use Connected only after verifying the applicable connections.
```

---

## Safety Boundaries & Disclaimer

Please understand these responsibilities and risks before using orrery (full threat model in [Security Model](docs/security.en.md); vulnerability reporting in [SECURITY.md](SECURITY.md)):

1. **Execution security belongs to each host harness—orrery only routes messages**: orrery does not execute model tools or manage model permissions. Each member acts under the permission and approval settings of its native app. If you enable auto-approve / yolo mode inside a host app, relayed cluster messages can trigger actions without prompting.
2. **Cross-agent persuasion & indirect prompt injection**: An agent in a cluster can be misled by faulty reasoning, malicious suggestions, or indirect prompt injection carried in messages from other agents or plugins. **Never treat Hub-relayed messages as direct user authorization**; review and approve sensitive commands, config/rule edits, and merges directly inside your native apps.
3. **Cross-vendor data flow & same-account local boundary**: Placing agents from different vendors in the same cluster means one model's output can be forwarded to another provider. Evaluate compliance before sharing sensitive code or data. Although the Hub binds only to `127.0.0.1` and requires tokens, **other local programs running under the same OS account** can read credentials and data under `~/.orrery` and fall outside the threat model.
4. **API cost & quota usage**: Multi-agent collaboration can consume model quotas or paid API credits quickly. Keep loop limits sensible and use the **global pause** switch whenever needed.
5. **Third-party ToS & no affiliation**: orrery is an independent open-source project not affiliated with Claude, OpenAI/Codex, Cursor, DeepSeek, Kimi, ZCode, Qoder, WorkBuddy, or Antigravity. Compliance with each third-party client's Terms of Service remains your responsibility.
6. **Plugins & local `ship` checks**: Restricted third-party plugins run under your OS account (**process separation is not an OS sandbox**), and full-trust plugins run in-process with the same privileges as orrery itself—only install plugins you trust. `ship` runs repository-declared verification commands in a temporary local worktree; do not run it blindly on untrusted repositories.
7. **Beta software provided AS-IS**: This is an unsigned public Beta distributed under the MIT License without warranties of any kind; the authors are not liable for direct or indirect damages arising from its use.

---

<details>
<summary><strong>Environment Variables & Common Commands (Click to expand)</strong></summary>

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ORRERY_PORT` | Hub HTTP listening port | `4317` |
| `ORRERY_HOME` | Data root (`hub.json`, `secret`, `api-token`, `hub.log`); plug-ins no longer use it to find the Hub | `~/.orrery` |
| `ORRERY_REGISTRY` | Account-local registry and shared bridge key. Use a separate path for tests and development. | `~/.orrery/registry` |
| `ORRERY_HUB` | For plug-ins: connect only to the Hub with this hubId or name; an invalid record stops the plug-in instead of falling back to the active Hub | Unset (active Hub) |
| `ORRERY_LEGACY_HUB` | For plug-ins: when the registry has no running active Hub, read `hub.json` in this old Hub's home and send the plaintext key the old way | Unset |
| `ORRERY_SECONDARY` | `1` starts a secondary Hub with native delivery disabled by default | Unset |
| `ORRERY_DB` | SQLite database file path | `<repo>/.tmp/orrery.db` |
| `ORRERY_SKILLS_DIR` | Local skills folder scanned for `$` completion | `~/.agents/skills` |
| `ORRERY_MOCK` | Set to `1` for a demo `mock` adapter that auto-replies without calling real models | Off |
| `ORRERY_MAX_HOPS` | Max hops per chain (non-negative integer only, `0` allowed; no `unlimited`) | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | Max turns per chain (non-negative integer only, `0` allowed; no `unlimited`) | `20` |
| `ORRERY_SAFE_MODE` | Set to `1` to skip every full-trust plugin | Off |

### Common Commands

```powershell
npm test                                 # Run automated tests (separate test ports & temp dirs, never 4317)
npm run check:health                     # Knip check for unused files, deps, and cycles (no tests, not a CVE audit)
npm run check:exports                    # Check unused export/type candidates only
npm run --silent bench:collaboration     # Run reproducible mock collaboration benchmark (not live-model scores)
npm run clean:temp                       # Clean leftover test temporary artifacts
npm run backup                           # Back up local private Hub SQLite database
npm run plugin:inspect -- <manifest>     # Preflight a third-party plugin manifest before registering (never runs it)
```

</details>

---

## Documentation Index

- **Architecture & Security**: [Architecture](docs/architecture.en.md) · [Native Mode](docs/native-mode.en.md) · [Loop Limits](docs/hop-limit.en.md) · [Security Model](docs/security.en.md) · [Security Policy](SECURITY.md)
- **Collaboration & Plugins**: [Collaboration & Tasks](docs/collaboration.en.md) · [Collaboration API](docs/collaboration-api.en.md) · [Members & Handover](docs/cluster-members.en.md) · [Built-in Plugins](docs/plugins.en.md) · [Third-Party Plugins](docs/external-plugins.en.md) · [Embedding Plugins into Star Map](docs/starmap-plugins.en.md)
- **Desktop & Operations**: [Desktop Shell](docs/desktop.en.md) · [Launcher](docs/launcher.en.md) · [Files & Skills](docs/files.en.md) · [Usage & Quotas](docs/usage.en.md) · [Activity Observation](docs/activity.en.md) · [Unread Hint Hook](docs/adapters/unread-hook.en.md)
- **Maintenance & Roadmap**: [Code Health](docs/code-health.en.md) · [Collaboration Benchmark](docs/evaluation.en.md) · [Third-Party Notices](docs/third-party.en.md) · [Follow-ups](docs/backlog.en.md)

## License

Source code in this repository is licensed under the **MIT License** (`orrery contributors`; see the root [LICENSE](LICENSE) file for the English legal text). Third-party application icons and dependencies retain their own rights and licenses; see [Third-Party Notices](docs/third-party.en.md). The original project SVG icon is included under MIT.
