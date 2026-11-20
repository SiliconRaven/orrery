# Security Policy

Language: **English** | [中文](#安全策略中文摘要)

## Supported Versions

orrery is currently in public **Beta (`v0.10.0-beta.3`)**. Security fixes are applied to the current Beta line (`>= 0.10.0-beta.3`).

| Version | Supported |
|---|---|
| `>= 0.10.0-beta.3` | Yes |
| `< 0.10.0-beta.3` | No |

## Reporting a Vulnerability

Please **do not** disclose exploitable security vulnerabilities, proof-of-concept payloads, or credentials in public GitHub issues, pull requests, or discussions.

- If **GitHub Private Vulnerability Reporting** is enabled on this repository, please submit your report through the repository's **Security → Advisories → Report a vulnerability** page.
- If private vulnerability reporting is not enabled yet, open a minimal issue titled `[Security] Request private reporting channel` with **no** exploit details, reproduction steps, or sensitive data so maintainers can arrange a private channel.

When reporting privately, please include:

1. Affected version or commit, OS, and which component is involved (Hub, MCP endpoint, adapter/bridge, web UI, desktop shell, or plugin tier).
2. Minimal reproduction steps and expected vs. actual security boundary behavior.
3. Impact assessment and any suggested mitigation.

## Scope & Threat Model Summary

Full details live in [Security Model (`docs/security.en.md`)](docs/security.en.md) and [安全模型 (`docs/security.md`)](docs/security.md).

### In Scope

- **Network & auth bypasses**: exposing the loopback-only Hub beyond `127.0.0.1`, bypassing `/api/*` Bearer/cookie authentication, bypassing `Host`/`Origin` CSRF checks, or spoofing another member on `/mcp` or `/bridge/*`.
- **Unauthorized native app launches**: the Hub, adapters, bridges, or plugins launching a closed native app (only an explicit user click inside the trusted Electron desktop shell `+` panel may start a supported app).
- **Path traversal & data leaks**: escaping outbox attachment boundaries, reading secrets via Skills/MCP discovery, leaking credentials into logs/events/API responses, or executing repo-configured hooks/transports during Hub read-only Git checks.
- **Web UI injection & exfiltration**: XSS or unsafe link/image execution in Markdown rendering, file upload/download MIME sniffing, or breaking `<iframe sandbox="allow-scripts">` isolation for restricted third-party plugin UIs.
- **Plugin tier boundary bypasses**: executing full-trust plugin code before explicit user confirmation, bypassing official plugin package signature verification, or bypassing restricted plugin protocol grants.
- **Review & collaboration-switch integrity bypasses**: allowing a member to downgrade a task's review tier, or bypassing Hub-enforced hidden-member delivery/tool blocks (such as a hidden member still receiving new deliveries or executing MCP tools).

### Out of Scope (Non-Goals)

- **Same-OS-user local malware**: programs running under the same OS user account can already read `~/.orrery` (`api-token`, `registry/bridge-secret`, SQLite database) and modify local files.
- **Host-app permissions & auto-approve presets**: orrery only routes messages into conversations inside your native apps; execution safety and tool approval are enforced by each host harness.
- **Cross-agent persuasion / indirect prompt injection**: an agent may be misled by messages relayed from another agent or plugin and attempt unwanted actions under your host-app permissions. Always review approvals inside your native app and treat Hub-relayed messages as peer input rather than direct user authorization.
- **Malicious third-party plugins installed by the user**: restricted plugins run as separate processes under your OS account (process separation is not an OS sandbox), and full-trust plugins run in-process with the same privileges as orrery itself.
- **Third-party vendor Terms of Service & cloud behavior**: data sent to external model providers and compliance with each host app's ToS are outside orrery's control.

---

## 安全策略（中文摘要）

- **当前支持版本**：仅维护 **`>= v0.10.0-beta.3`** 的当前 Beta 版本线，低于 `0.10.0-beta.3` 的早期测试版不再支持。
- **私下报告漏洞**：请勿在公开 Issue、PR 或讨论区发布可利用细节、PoC 或凭据。若本仓库已开启 GitHub **Private Vulnerability Reporting**（Security → Advisories → Report a vulnerability），请直接通过该入口提交；若尚未开启，请先开一条不含任何漏洞细节的简短 Issue（标题如 `[Security] Request private reporting channel`）向维护者索取私密联系渠道。
- **受理范围**：回环与 `/api/*`、`/mcp`、`/bridge/*` 鉴权/跨站绕过；越权自动拉起未运行的原生应用；发件箱/Skill/只读 Git 路径逃逸或密钥泄露；协作页 Markdown XSS/自动外传；受限插件沙盒或完全信任插件确认边界绕过；官方插件签名校验绕过；成员私自降低任务验收档位，或隐身成员仍能收到新投递/执行 MCP 工具等协作约束失效。
- **不在范围内**：同操作系统账户下的本地恶意程序（已能直接读取本机 `~/.orrery` 凭据）；用户在原生应用中自行开启的自动批准/高权限配置；跨 Agent 误导与间接提示注入（安全审批由各原生 Harness 负责）；用户自行安装的恶意第三方插件；以及第三方应用服务条款与云端服务行为。完整威胁模型见 [安全模型](docs/security.md)。
