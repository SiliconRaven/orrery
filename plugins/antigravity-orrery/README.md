# orrery sidecar（Antigravity）

语言：**中文** | [English](README.en.md)

Antigravity 2.0 桌面应用的原生模式接入件。本目录只依赖 Node 内置模块，所有配置由用户手动完成，orrery 不修改 Antigravity 自身配置。

> **Beta 版本提示**：本接入件随 `orrery v0.10.0-beta.2`（Beta 测试版）提供，接口、钩子与配置格式仍可能变化，请先用测试对话试用。

安装版用户请使用内置 Node 路径，并为宿主插件设置 `ORRERY_HOME`，见[安装版接入说明](../../docs/desktop.md)。

> **服务条款风险提示**：Antigravity 官方 FAQ 注明，使用第三方软件、工具或服务访问 Antigravity **可能违反**其服务条款并导致账号受限或注销。通过 `agentapi` 从外部投递消息属于此类用法，是否使用由用户自行决定。

## 组件职责

- **`sidecar.mjs`**：由 Antigravity 启动并注入语言服务器地址与环境后只读读取 `hub.json` 连接本机 Hub；收到投递时调用不经 shell 的 `agentapi send-message <对话 id> <消息>` 发送并上报状态，stderr 里的令牌在截取前自动替换为 `[redacted]`。
- **`hook.mjs`**：配置为 `PreToolUse` Hook，在模型调用 orrery MCP 工具时根据本机 `hub.json` 密钥对 `conversationId` 计算 HMAC 签名并强制覆盖 `orreryCaller` 参数，同时恒返回 `ask` 保留用户原有审批策略。
- **`hook-dump.mjs`**：仅用于手动排障查看 hook 传入键名结构，平时请勿启用。

## 一次性手动安装

前提：PATH 中有 Node 24，且已至少启动过一次 orrery Hub 生成 `~/.orrery/secret`。

1. **复制 Sidecar 目录**：将本文件夹复制为 `~/.gemini/config/sidecars/orrery/`（Windows：`%USERPROFILE%\.gemini\config\sidecars\orrery\`）。
   ```powershell
   Copy-Item -Recurse <orrery 仓库>\plugins\antigravity-orrery "$HOME\.gemini\config\sidecars\orrery"
   ```
2. **启用 Sidecar**：在 Antigravity 管理页启用 `orrery`，或合并以下片段到 `~/.gemini/config/config.json`：
   ```json
   { "sidecars": { "orrery": { "enabled": true } } }
   ```
3. **配置 MCP**：向 `~/.gemini/config/mcp_config.json` 的 `mcpServers` 添加 `orrery`（密钥取自 `~/.orrery/secret`，端口默认 `4317`）：
   ```json
   {
     "mcpServers": {
       "orrery": {
         "url": "http://127.0.0.1:4317/mcp",
         "headers": { "x-orrery-bridge": "<密钥>", "x-orrery-harness": "antigravity" }
       }
     }
   }
   ```
4. **配置 PreToolUse Hook**：合并到 `~/.gemini/config/hooks.json`（注意 Windows 下必须写相对 `~/.gemini/config/` 的路径且**不要加引号**，`matcher` 同时覆盖 `mcp.*` 与 `call_mcp_tool`）：
   ```json
   {
     "orrery-caller": {
       "PreToolUse": [
         {
           "matcher": "mcp.*|call_mcp_tool",
           "hooks": [{ "type": "command", "command": "node ./sidecars/orrery/hook.mjs", "timeout": 10 }]
         }
       ]
     }
   }
   ```
5. **重启并注意启动顺序**：先启动 orrery Hub 再打开 Antigravity。若 Hub 晚启动或中途重启，sidecar 会自动重连，但 Antigravity MCP 客户端不会自动刷新工具，须在 MCP Servers 设置里手动刷新 `orrery` 或重启应用。

## 更新、卸载与风险提示

- **更新与卸载**：更新 orrery 后重新覆盖 `sidecars/orrery/` 并重启 Antigravity；卸载时停用并删除该目录及 `mcp_config.json`、`hooks.json` 中的 `orrery` 条目即可。
- **高优先级触发**：投递进来的消息在 Antigravity 中显示为高优先级系统消息并立刻触发一轮执行；请确认当前审批规则可接受外部点名。详见 [docs/adapters/antigravity.md](../../docs/adapters/antigravity.md)。
