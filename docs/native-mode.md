# 原生模式设计（Native Mode）

语言：**中文** | [English](native-mode.en.md)

orrery 仅运行原生模式（`NativeAdapter`），让用户在桌面应用或本地 CLI 中已有的对话（或受支持应用的新建原生会话）直接加入群聊。群员所在的应用在线时才会收到投递。Hub 负责路由、合批、防循环计数与身份核验，不代跑模型轮次。

## 核心原则

1. **只接入或新建用户明确指定的原生会话**：列表枚举只读（或临时副本）；`new` 新建原生会话须显式指定 `mode: "native"` 和非空的 `projectPath`，`attach` 接入已有会话从应用只读存储读取 `cwd`，绝不改动未接入会话或宿主配置。
2. **绝不主动打开用户的原生应用**：宿主应用未运行时成员显示**离线**，期间消息仅留在群聊记录中，应用重新打开后**不自动补发**。
3. **继承用户自身应用权限**：原生对话沿用你在目标应用中的审批预设（不保证每一步都弹窗）。

## 本地发现与桥协议（`BridgePort`）

Hub 绑定 `127.0.0.1` 并在 `<ORRERY_HOME>/hub.json` 只读发布连接地址（`url`）与桥密钥（`secret`），同时维护 `<ORRERY_HOME>/secret`。各桥脚本、插件与钩子读取该配置后经回环直连与 Hub 通信：

| 路径 | 认证方式 | 用途 |
|---|---|---|
| `GET /bridge/stream?harness=<h>[&session=<id>&version=<v>]` | 桥密钥 | SSE 下行投递流，支持按会话（Claude）或按 harness 共用连接（DSH、Antigravity）；发送 `deliver { deliveryId, sessionId, text }` |
| `POST /bridge/ack` | 桥密钥 | 回执本地接收 `{ deliveryId, ok, follows?, error? }` |
| `POST /bridge/done` | 桥密钥 | 携带 `follows: true` 时在模型轮次结束后回报 `{ deliveryId, harness, sessionId, outcome, error?, usage? }` |
| `POST /bridge/unread-hint` | 桥密钥 | 钩子或插件查询自上次询问以来新增未读，返回 4 桶分类计数行 |
| `GET /bridge/<h>-wait` / `POST /bridge/<h>-ack` | 签名票据 | 后台等待路线（ZCode / Qoder / WorkBuddy）的 SSE 等待与回执 |
| `POST /bridge/<h>-turn` / `GET /bridge/<h>-park` | 桥密钥 | 停靠 Hook 路线（Cursor）的轮次报告与停靠待命流 |
| `POST /bridge/ship-verify` / `POST /bridge/ship-result` | 签名 `body.ticket` | `scripts/ship.ts` 查验获批提交与上报合入/检查失败结果 |

## 四类 MCP 身份认证路线

`/mcp` 严格依据桥密钥与宿主写入的不可伪造上下文识别成员（`src/mcp/server.ts`）：

1. **显式会话头（Claude / DSH / Cursor / WorkBuddy）**：请求头带 `x-orrery-bridge: <secret>` + `x-orrery-session: <id>` + `x-orrery-harness: <h>`（省略 harness 头时默认按 `claude`）。
2. **原生 Codex（仅桥密钥 + `_meta.threadId`）**：Codex 配置 HTTP MCP 时**只传 `x-orrery-bridge: <secret>`**，**绝不传 `x-orrery-session` 或 `x-orrery-harness`**（若传了 `x-orrery-harness: codex` 而无 `x-orrery-session` 会落入无身份 `nobody` 分支被拒绝）；Hub 从运行期 `_meta.threadId` 识别成员。
3. **运行期 `_meta` 注入（Qoder / ZCode / 可选直连 Kimi）**：携带 `x-orrery-bridge` 与对应 `x-orrery-harness`，分别读取不可伪造的 `_meta["com.qoder/turnContext"].sessionId`、`root_session_id` / `session_id` 或 `_meta["kimi/sessionId"]`（其中 Qoder 在检查阶段即优先锁定仅从 `_meta` 识别）。
4. **HMAC 签名参数（Antigravity）**：携带 `x-orrery-bridge` 与 `x-orrery-harness: antigravity`，由 `PreToolUse` Hook 用本地 `hub.json` 密钥覆盖签名参数 `orreryCaller`。

## 投递语义与答复回退

- **忙时合批与终态语义**：支持 `follows` 或轮次结束观察的适配器会在忙时留存新消息并在本轮结束合批下发；遇到断线、超时或模糊错误时标记 `outcome: unknown`，不自动重投（防重复执行）。
- **无工具时的答复即发言**：默认版 Kimi Code 不使用 MCP 认人工具，而是启用 `NativeAdapter.replies = true` 将对应轮次的完整助手文本回答通过常规发言路径发回群聊。
