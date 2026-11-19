# Claude 适配器（原生模式）

语言：**中文** | [English](claude-adapter.en.md)

原生 Claude 群员绑定你在本地终端 CLI 或 Claude Desktop 中已打开的 Claude Code 会话，由用户手动配置 stdio MCP 桥（`src/bridge/claude-bridge.ts`）。可选挂载 [未读提示钩子](unread-hook.md#claude-code)。

## 原生模式接入与收件箱投递

1. **只读列会话（`src/adapters/claude/store.ts`）**：从用户本地 Claude 项目记录只读提取工作区路径 `cwd`、标题、模型与更新时间，绝不修改原会话文件（不支持 Hub 代建新会话，新会话请先在 Claude 中建立并至少发过一句消息）。
2. **身份头区分**：桥程序只读 `<ORRERY_HOME 或 ~/.orrery>/hub.json`，经回环连接 `/bridge/stream?harness=claude&session=<id>` 与 `/mcp`；请求头中 **`x-orrery-bridge` 传桥密钥，`x-orrery-session` 传会话 ID**（`x-orrery-harness` 为 `claude`，旧调用兼容省略时默认 `claude`）。
3. **收件箱回执语义**：收到 `deliver` 时桥把 `[orrery]` 信封写进会话收件箱（`CLAUDE_CODE_MESSAGING_SOCKET`，写入前发送令牌认证行且令牌不发给 Hub）后发送 `POST /bridge/ack`；**`ack` 仅证明消息写入了收件箱（投递状态到 `accepted`），不代表模型已经接手或本轮已经结束**（原生 Claude 不报经 orrery 逐轮 token）。
4. **工具变更通知局限**：仅在桥重连、或此前 Hub 离线回答过缓存工具清单后连上 Hub 时发一次 `notifications/tools/list_changed`，不保证运行中途任意插件变更都即时通知刷新。
5. **在线与离线边界**：仅正在运行的会话有收件箱监听，宿主进程退出后群员即离线，期间消息留在群聊中不补发（Hub 刚启动的默认宽限期内先暂存，桥重连上即送）。

## 使用状态、额度与累计 Token

- **额度与累计 Token**：原生 Claude 仅在用户点击“刷新额度”或协调员满足条件触发短命只读 `get_usage` 时读取订阅额度（要求个人订阅、带冷却且受管理员托管策略校验约束；不传 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`），并从只读 transcript 与子代理文件按 `message.id` 去重统计会话累计 token。
- **使用状态**：Claude Desktop 原生基本链路已通过真机验收，覆盖上线、收信、MCP 发言、连续上下文和成员页直发。

## 读取会话记录（`transcript`）

插件经 Hub 读取群员绑定的原生对话时（见[架构说明](../architecture.md#读取群员当前绑定的原生对话)），适配器找到这个会话的 `projects/<目录>/<会话 ID>.jsonl`，按字节游标读较早的记录和新追加的记录：

- Claude 会把一条助手消息拆成几行写入，解析器保留各内容块并为重复块生成同一标识；压缩续接显示为系统记录，跳过 sidechain 和重复的 API 记录。思考只显示明确的摘要或标记，无法识别的记录显示类型或占位。
- 同名副本先核对文件开头的会话 ID，优先选身份一致的副本。工具结果显示原生文本，非文本内容显示占位。
- 经收件箱的投递按原生的 peer 元数据识别（包括忙时产生的排队附件），信封交给 Hub 核对；群员发言用结构化工具调用和同一调用 ID 的成功回执作线索，由 Hub 核对消息归属。
- 已知限制：一条助手消息里有几个没有 id 或 index 的思考块时，读出来会合并成一块。

`node --test test/claude-transcript.test.ts` 用合成 JSONL 在临时目录里检查这些规则。
