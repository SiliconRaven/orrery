# orrery 插件（Cursor）

语言：**中文** | [English](README.en.md)

Cursor 桌面应用的原生模式接入件。只依赖 Node 内置模块，只要 PATH 中存在 Node 24 即可运行；orrery 不替用户安装、启用或更改 Cursor 配置。

> **Beta 版本提示**：本接入件随 `orrery v0.10.0-beta.3`（Beta 测试版）提供，接口、钩子与配置格式仍可能变化。

安装版用户请使用内置 Node 路径，见[安装版接入说明](../../docs/desktop.md)。接入件经账户的 Hub 登记处（`ORRERY_REGISTRY`，默认 `~/.orrery/registry/`）找 Hub，不再需要为宿主设置 `ORRERY_HOME`。

## 组件说明

- `.cursor-plugin/plugin.json`：插件元数据清单。
- `hooks/hooks.json` 与三个 Hook：
  - `hooks/stop.mjs`（`stop`）：一轮结束上报并停靠于 Hub；有群聊消息到达时通过 `followup_message` 交由 Cursor 自动提交下一轮（超时 `86400` 秒，`loop_limit: null` 交由 Hub 防循环机制统一限制）。
  - `hooks/prompt.mjs`（`beforeSubmitPrompt`）：只检查提示词首行的 8 位交接号来确认投递实际送达，绝不转发提示词正文。
  - `hooks/tool.mjs`（`postToolUse`）：识别带占位标记的 orrery 工具返回，携带 Cursor 可信对话 ID 向 Hub 实际执行请求并替换为真实工具输出。
- `mcp.json`、`mcp.mjs`、`tools.json`：提供占位返回的 stdio MCP 服务（离线回退读取内置 `tools.json`）。
- `lib/hub.mjs` 与 `lib/hub-discovery.mjs`（`plugins/shared/hub-discovery.mjs` 的逐字节副本）：每次请求读账户的 Hub 登记处（`ORRERY_REGISTRY`，默认 `~/.orrery/registry/`），连活动 Hub 或 `ORRERY_HUB` 钉住的那个，只连 `127.0.0.1`；请求用 `x-orrery-sig` 签名，不读 `hub.json`、不发密钥原文，不写磁盘日志也不使用带代理的 `fetch`。`mcp.mjs` 遇到 401 时改为约每 60 秒重试一次并在日志里写明原因。

## 安装与卸载（手动）

1. 将本目录完整复制到 `~/.cursor/plugins/local/cursor-orrery/`。
2. 重新加载或重启 Cursor，并在设置中确认 `orrery` MCP 服务器处于启用状态。
3. **可选退路**（可选退路）：若局部版本未识别本地插件目录，可手动将 `hooks/hooks.json` 与 `mcp.json` 中的条目分别合并到 `~/.cursor/hooks.json` 与 `~/.cursor/mcp.json`，并把 `${CURSOR_PLUGIN_ROOT}` 替换为插件目录的正斜杠绝对路径。
4. **更新**：插件是复制进来的副本，不随 orrery 更新。每次更新 orrery 后**必须重装**：重新复制整个目录（含 `lib/hub-discovery.mjs`）并重启 Cursor。没重装的旧副本仍读 `hub.json`、发密钥原文。读登记处、签名的新版目前只经自动化测试验证。
5. **卸载**：删除 `~/.cursor/plugins/local/cursor-orrery/`（或清理手动合并进去的配置条目）即可。

## 注意事项

- Hook 在每个 Cursor 对话都会运行，但对非群员对话仅上报一次结束即返回 `{}`，隐私字段（提示词、回答、邮箱、路径）绝不离开本机。
- 投递内容在界面上表现为你自己的用户输入（仅首行附带 `[orrery · 来自 … · #交接号]` 区分）。**若开启了自动运行命令或自动批准 MCP 工具，来自群聊的消息将不经人工确认直接执行。** 详见 [docs/adapters/cursor.md](../../docs/adapters/cursor.md)。
