# Antigravity 适配器（原生模式）

语言：**中文** | [English](antigravity.en.md)

Antigravity 适配器经用户手动安装的本地 **sidecar**、全局 **MCP 条目** 与 **PreToolUse 签名 Hook**（`plugins/antigravity-orrery/`），将 Antigravity 2.0 桌面端中的工作区对话接入 orrery 集群。仅做原生模式；可选模型调用前未读提示见 [未读提示钩子](unread-hook.md#antigravity)。

> **服务条款风险提示**：Antigravity 官方 FAQ 注明，使用第三方软件、工具或服务访问 Antigravity **可能违反**其服务条款并导致账号被暂停或注销。经 sidecar 调用 `agentapi send-message` 往对话投递消息属于此类用法，是否使用由用户自行决定。

## 工作原理

1. **Sidecar 投递（`sidecar.mjs`）**：
   - 仅在 `ANTIGRAVITY_LS_ADDRESS` 与直接可执行 `ANTIGRAVITY_AGENTAPI_EXE` 就绪时运行（避免通过 `cmd.exe` 运行 `.bat` 转义破坏消息正文）。
   - 用文件夹里自带的 `hub-discovery.mjs` 每次重连都重读账户的 Hub 登记处（`ORRERY_REGISTRY`），连活动 Hub 或 `ORRERY_HUB` 钉住的那个，投递流和回执都用 `x-orrery-sig` 签名（回执只发给送来投递的 Hub），建立 `GET /bridge/stream?harness=antigravity&version=<v>`；收到投递后调用无 shell 的 `execFile(ANTIGRAVITY_AGENTAPI_EXE, ['agentapi', 'send-message', <UUID>, <正文>])`（首字符 `-` 时前置 `--`），stderr 先脱敏 CSRF 令牌为 `[redacted]` 再截断。
   - **启动顺序**：先启动 Hub 再打开 Antigravity。Sidecar 断线每 5 秒重连，但 Antigravity 的 MCP 客户端在 Hub 重启或晚启动后不会自动重新加载工具，需在应用 MCP 设置中手动刷新 `orrery` 或重启应用。
2. **PreToolUse 签名认人（`hook.mjs`）**：
   - 因 Antigravity 共用全局 HTTP MCP 连接且不传会话头，`hook.mjs` 在 `PreToolUse` 从标准输入读入可信 `conversationId`，以登记处的共享密钥 K（`<ORRERY_REGISTRY>/bridge-secret`）计算 HMAC-SHA256 覆盖工具参数 `orreryCaller`，且决定恒为 `ask` 保留用户审批。hook 不发 HTTP；读不到 K 时把 `orreryCaller` 覆盖成空值并在 stderr 说明，不回退去读 `hub.json`。
   - `src/mcp/antigravity.ts` 只接受有效签名；同机同用户权限的程序可读取本机配置文件（[安全模型](../security.md)）。换密钥（退出所有 Hub，删掉 `<ORRERY_REGISTRY>/bridge-secret` 和先启动的那个 Hub 的 `<home>/secret` 再启动，并更新 `mcp_config.json`）可令旧签名全部失效。
   - `mcp_config.json` 的 HTTP 条目由 Antigravity 自己发请求、没法签名，`x-orrery-bridge` 写共享密钥 K 的原文（明文兼容，投递设置里可关）。

## 配置步骤与只读列表

- **安装**：见 [plugins/antigravity-orrery/README.md](../../plugins/antigravity-orrery/README.md)（复制至 `~/.gemini/config/sidecars/orrery/`、启用 sidecar、配置 `mcp_config.json` 与 `hooks.json`；日常勿配置诊断用的 `hook-dump.mjs`）。
- **升级**：sidecar 和 hook 是复制安装的副本，更新 orrery 后**必须重装**：重新复制整个文件夹（含 `hub-discovery.mjs`）并重新启用，`mcp_config.json` 里的 `x-orrery-bridge` 一次性换成 K，再重启 Antigravity（见[接入件的升级和回退](../native-mode.md#接入件的升级和回退)）。改为读登记处、签名之后的 sidecar 和 hook 目前只经自动化测试验证。
- **只读枚举（`store.ts`）**：通过 `withCopy` 复制 `~/.gemini/antigravity/conversation_summaries.db`（及 `-wal`）临时副本读取 `nesting_depth = 0`、`killed = 0`、`app_data_dir = 'antigravity'` 且含 `file://` 工作区的 UUID 对话。不支持新建会话、订阅额度或 token 统计。
- **只读读取对话正文**：`Hub.memberTranscript` 优先按页只读 `<geminiHome>/antigravity/brain/<uuid>/.system_generated/logs/transcript_full.jsonl`（首行探测与有界正文同支持至 256 KiB 并容忍首行半写；缺失时回退 `transcript.jsonl`，拒绝越界路径、硬链接与连接点且从不回退绕过；不读 `.pb` 与 `conversations/*.db`），占位脱敏 `thinking` 并统一从 `tool_call`、`tool_result` 与错误消息中脱敏 `orreryCaller` 签名及凭据回显；仅将 `SYSTEM_MESSAGE`（`sender=system`、`MESSAGE_PRIORITY_HIGH`）作为投递候选交由 Hub 核实（`USER_INPUT` 永不晋升），并按位置及 `callId` 跨页配对 `call_mcp_tool`（含 JSON 引号编码）的成功结果对回 `orrery_post`。

## 使用范围

- **单向 `accepted` 投递**：只确认 `agentapi send-message` 接单，不跟踪轮次何时结束；超时、断线或失败回执记为 `unknown`。
- **使用状态**：sidecar、签名 hook、成员识别、消息投递与 MCP 发言已在真实 Antigravity 会话中跑通。
