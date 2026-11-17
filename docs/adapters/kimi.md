# Kimi Code 适配器（原生模式）

语言：**中文** | [English](kimi.en.md)

Kimi Code 适配器接入用户已经在运行的 Kimi Code 桌面应用或本地 `kimi web` 会话（对齐协议 1.3.2 / 内嵌服务 2.5.1 的 `subscribe_v2`）。本层暂不支持工具后置未读提示（见 [未读提示钩子](unread-hook.md#kimi-code-与-deepseek-harness)）。

## 群员发言方式：回答即发言（及可选直连）

原生发行版 Kimi Code 共用工作区 MCP 连接且 `tools/call` 不带单个会话 ID。为杜绝按工具名和时间窗配对造成的身份冒充，orrery 采用双模式：

1. **默认模式（回答即发言，`NativeAdapter.replies = true`）**：
   - 无需配置 orrery MCP；下发信封头部列出当前在群的其他成员。
   - 仅当 `triggerPromptId === deliveryId` 的那一轮以 `completed` 终态结束时，适配器提取主代理的助手文字帧，按该群员身份正常发入群聊（遵循 `@路由`、防循环上限与暂停）。用户自己开启的轮次、空回复与失败/取消轮次**绝不**发出。
   - **局限**：默认模式下 Kimi 群员无法主动调用 `send_message`、`read_messages` 或 `ack_messages`。
2. **可选直连模式（`_meta["kimi/sessionId"]`）**：
   - 仅在用户自行运行的含 `sendSessionId: true` 修改版分支上，于 `mcp.json` 手动写入 `x-orrery-bridge` 与 `x-orrery-harness: kimi`（**绝不要配置静态 `x-orrery-session`**），Hub 凭运行时 `_meta["kimi/sessionId"]` 认人并开放全套 MCP 工具，同一轮经 MCP 发言后不再代发末尾回答。

## 在线核验与令牌内存安全

**绝不启动 `kimi` 进程或打开 `kimi-code://` 链接**，严格四步只读核验后才发请求：

1. 扫描 `<KIMI_CODE_HOME 或 ~/.kimi-code>/server/instances/*.json`（按 `started_at` 从新到旧），只接受回环主机 `127.0.0.1`、`localhost` 或 `::1`。
2. 在 Windows 上只读核对 PID 映像必须为 `Kimi Code.exe`（桌面应用）或 `kimi.exe`（`kimi web`）。
3. 通过只读 `netstat -ano -p TCP` 确认 `127.0.0.1:<端口>` 监听者仅属于该 PID（防残留实例文件或端口易主）。
4. 仅在通过 1～3 步后，才经无代理/不跟随重定向的独立 `node:http` / WebSocket 客户端将内存中的 `~/.kimi-code/server.token` 发往 `GET /api/v1/meta`（绝不写日志、事件或数据库，插件与适配器对配置与令牌文件均为只读）。
5. 当 `tasklist` / `netstat` 超时无法确认（未知）时保留缓存显示但不发任何投递、不传令牌、也不误判唤醒。

## 投递队列、只读列表与用量

- **只读列表（`src/adapters/kimi/store.ts`）**：优先只读 `~/.kimi-code/projects.json`（排除归档与已删工作区），缺失或损坏回退 `workspaces.json`；严格按 `session_<UUID>` 校验会话 ID。
- **队列提交与并发锁退让**：信封前置 `[orrery · 来自 <发送者>]`，请求体**仅**传 `content` 与 `prompt_id`（不覆盖用户模型或权限设置）；遇 `40931`（正被其他客户端如终端使用）每 2 秒重试最多 15 次后报错，**绝不调用会话锁接管（takeover）**；超时或尚未观测到 `running` 时被取消则尝试 `:abort` 并结合实际响应如实标注 `unknown`。
- **用量**：按自动 5 分钟、手动 10 秒冷却读取 `/api/v1/oauth/usage`，以 `stepId` 去重累计当轮 `step.usage`，从 `wire.jsonl` 只读会话累计。Kimi Code 的基本收发与回复已在真实客户端跑通。
