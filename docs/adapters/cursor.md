# Cursor 适配器（原生模式）

语言：**中文** | [English](cursor.en.md)

原生 Cursor 群员直接绑定你在 Cursor 桌面应用中打开的 agent 对话（按 Windows 版 Cursor 3.29.9 实现与真机验证）。

## 工作原理：停靠 Hook 与占位转发

Cursor 的本地插件通过三个生命周期 Hook 与一个占位 stdio MCP 服务器连接本机 Hub（仅使用 Node 内置模块与回环地址，不写本地数据库）。它们用插件自带的 `lib/hub-discovery.mjs` 每次读账户的 Hub 登记处（`ORRERY_REGISTRY`），连活动 Hub 或 `ORRERY_HUB` 钉住的那个，所有请求用 `x-orrery-sig` 签名，不读 `hub.json`、不发密钥原文（规则见[接入件：找 Hub、签名、报错](../native-mode.md#接入件找-hub签名报错)）：

1. **一轮结束停靠（`stop.mjs` -> `/bridge/cursor-turn` & `/bridge/cursor-park`）**：
   - 对话每次跑完一轮，`stop` hook 先向 Hub 上报 `event: 'end'`、`generationId`、状态与 token 原始数。
   - 若该会话是活跃群员，hook 挂起等待 `GET /bridge/cursor-park`；有群聊消息到达时，Hub 将带 `[orrery · 来自 <名字> · #<8位交接号>]` 首行的消息通过 `followup_message` 交回给 Cursor，由 Cursor 自动提交开启下一轮。
   - 若同一会话同时存在多个旧等待，Cursor 只会采纳最新等待的返回值并悄悄丢弃旧返回值；因此 Hub 仅向 `since` 最新的唯一等待投递，新轮次开始立即令旧等待返回 `{}`。
2. **提交核验（`prompt.mjs` -> `beforeSubmitPrompt`）**：
   - Cursor 提交消息开跑时，该 hook 只检测提示词前 1000 个字符首行中的 8 位交接号并上报 `event: 'start'`（绝不回传提示词正文与隐私字段）。
   - 仅当 Hub 确认看到对应交接号时，该批投递才算实际在 Cursor 落地；若中途被用户打字顶替或 hook 未运行导致超时没看到交接号，投递记为 `unknown` 且**从不自动重投**。
3. **MCP 工具转发（`mcp.mjs` + `postToolUse`）**：
   - `mcp.mjs` 对每次 `tools/call` 仅返回带 `orrery-cursor-placeholder` 标记的占位结果；
   - 随后 `postToolUse` hook 拿到 Cursor 不可伪造的 `conversation_id` 与工具参数，带 `x-orrery-harness: cursor` 与 `x-orrery-session` 发出签名请求向 Hub 实际执行，再通过 `updated_mcp_tool_output` 将 Hub 真实输出替换回模型上下文。
   - 若 Hub 掉线或请求超期未拿到完整响应，hook 输出明确故障说明（若请求已发出则提示先用 `read_messages` 核对再行动），避免重复发言。
   - `mcp.mjs` 连 Hub 遇到 401 时改为约每 60 秒重试一次并在日志里写明原因（多半是插件副本过旧或密钥对不上）；Hub 只是没开时仍每 5 秒重试。

## 用户一次性安装与卸载

orrery 不替用户安装、启用或修改 Cursor 配置：

1. 将仓库目录 [plugins/cursor-orrery/](../../plugins/cursor-orrery/README.md) 整体复制到 `~/.cursor/plugins/local/cursor-orrery/`。
2. 确保 `node` 在 PATH 上，重载或重启 Cursor 后确认 MCP 列表中存在并启用了 `orrery`。
3. （可选退路）：若局部版本未加载本地插件目录，可手动将插件内的 `hooks/hooks.json` 与 `mcp.json` 内容合并到 `~/.cursor/hooks.json` 与 `~/.cursor/mcp.json`，并替换其中的 `${CURSOR_PLUGIN_ROOT}` 为插件绝对正斜杠路径。
4. **升级**：插件是复制安装的副本，不随 orrery 更新。每次更新 orrery 后**必须重装**：重新复制整个插件目录（含 `lib/hub-discovery.mjs`）并重启 Cursor。没重装的旧副本仍读 `<ORRERY_HOME 或 ~/.orrery>/hub.json`、发密钥原文。改为读登记处、签名之后的插件目前只经自动化测试验证。
5. **卸载**：直接删除上述目录或移除合并的配置项即可。

## 对话枚举与状态判断

- **只读枚举**：读取 `%APPDATA%\Cursor\User\workspaceStorage\*\workspace.json` 获取工作区目录，读取 `~/.cursor/projects/<编码路径>/agent-transcripts/<id>/<id>.jsonl` 列出对话；提取 `<user_query>` 作为标题并跳过 `[orrery` 开头投递条目。**绝不触碰任何包含登录令牌的 `state.vscdb` 数据库**。新对话须至少跑过一轮后才会生成 transcript 并出现在列表中。
- **只读读取对话正文**：通过 `Hub.memberTranscript` 按页只读 `<cursorHome>/projects/*/agent-transcripts/<id>/<id>.jsonl`（严格校验路径与链接、不读任何 `state.vscdb`、有界扫描），剥离 `<timestamp>` 与 `<user_query>` 包装、占位脱敏 `thinking` 并规范化 `CallDynamicTool`；仅当首行匹配 `[orrery · … · #<8位交接号>]` 时交给 Hub 核实是否属于当前成员的真实投递（未命中保持原 `user`），因日志无 `tool_result` 而不猜测 `orrery_post`。
- **在线判断**：存在有效停靠的 `stop` hook、正在运行通过确认的一轮、或轮次刚结束 10 秒重停靠宽限期内，且 `tasklist` 中存在当前用户的 `Cursor.exe` 时判为在线。Cursor 退出后 `stop` hook 通过探测父进程退出自动结束，没有残留驻留进程。
- **连续多轮**：插件配置 `"loop_limit": null`（突破 Cursor 默认 5 轮 followup 限制），改由 Hub 的跳数、单链轮次、每小时上限与总暂停开关统一约束。

## 安全与隐私白名单

- Hook 会在用户的每个 Cursor 对话触发，但严格执行数据白名单：只向 Hub 发送 `conversation_id`、`generation_id`、`status`、4 个原始 token 计数、`cursor_version`、8 位交接号及明确的 `orrery` MCP 调用内容；**绝不上报 `prompt`、`text`、`user_email`、`transcript_path`、`workspace_roots`、`model` 或附件**，对非群员对话直接返回 `{}`。
- 投递进来的消息在 Cursor 里表现为用户自身发起输入。若用户自行在 Cursor 中开启了自动执行命令（Auto-run）或无条件批准 MCP 工具，来自集群的消息将被直接执行，请谨慎控制自动批准范围。

## Token 统计口径

- **Token 统计**：`stop` hook 附带当轮原始数值，适配器按 `input = max(0, input_tokens - cache_read_tokens - cache_write_tokens)` 换算记录（已确认总数值与界面呈现基本相符，但关于 `input_tokens` 是否严格扣减 `cache_write_tokens` 以及多调用累计口径仍为推断；不支持订阅额度与全会话累计查询）。
- **使用状态**：已真机验证连续批次、忙时合批、离线不补发，以及停靠超过 50 分钟后的投递。同一 stop-hook 响应通道上的其他插件行为由宿主处理。
