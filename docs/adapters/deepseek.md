# DeepSeek Harness 适配器（原生模式）

语言：**中文** | [English](deepseek.en.md)

DeepSeek Harness（下称 DSH）适配器通过仓库内置的独立 Cordis 插件包 `plugins/dsh-orrery/` 将用户 DSH 桌面端中的会话接入 orrery 集群。

## 工作原理：插件包 + 共用桥连接

`plugins/dsh-orrery/` 是一个零第三方 npm 依赖的 ESM bundle（兼容 `engines.dsh: >=0.2.1-rc.2 <0.3.0-0`），由用户自行安装并在 DSH 插件页启用。

1. **发现与共用长连接**：插件每次重连读取 `<ORRERY_HOME 或 ~/.orrery>/hub.json`（只连回环地址，使用独立 `node:http` agent 避免经过外部环境变量代理），建立共用 SSE 连接 `GET /bridge/stream?harness=deepseek`。
2. **合批等待与轮次终态回报（`follows: true`）**：
   - DSH 自身对队列中的每条 prompt 各开一轮，不会自动合并。因此插件在收到 `deliver` 并调用 `ctx.sessionController.prompt({ requestId: deliveryId, sessionId, mode: 'queue', ... }, signal)` 前，先监听该会话的 `session/event` 流。
   - 当看到对应 `rpcId === deliveryId` 的轮次启动并在随后的 `turn/end` 中捕获结果时，通过 `POST /bridge/done` 上报明确结果（`completed`、`failed` 或断线/超时 `unknown`）。在这之前，Hub 暂存新消息并在本轮结束时合批下发。
   - 若 DSH 版本未暴露 `ctx.on` 事件流或运行旧版插件（回执不带 `follows`），适配器退回到即刻 `accepted` 语义。
3. **工具注册与前缀映射**：插件经 `ctx.tools.register` 注册全部协作工具；因 DSH 原生基础包占用了全局 `send_message` 和 `list_agents` 工具名，插件统一加前缀 `mcp__orrery__*`，并将参数 Schema 投影为 DSH 支持的 JSON Schema 子集（开放映射与上限仍由 Hub 终审校验）。插件从不可伪造的 `exec.agent.id` 读取会话 ID 并附 `x-orrery-harness: deepseek` 与 `x-orrery-session` 头转发 `/mcp`。
4. **工具后置未读提示**：通过 `tools/post-execute` 挂载 500 毫秒超时后台查询 `/bridge/unread-hint`，在有未读变动时向 `additionalContexts` 注入唯一精简统计行（使用生产者来源 `source.kind: 'dsh-orrery'`）；Hub 不可达或无新消息时不改动原工具输出。

## 用户一次性安装与更新

详细步骤与注意事项见 [plugins/dsh-orrery/README.md](../../plugins/dsh-orrery/README.md)：

1. 在 DSH 的 **Plugins → Add plugin** 填写本地仓库 `<orrery>/plugins/dsh-orrery` 的绝对路径并确认启用；或退出应用后运行 `dsh plugin --profile desktop add link:<绝对路径>`。
2. 更新 orrery 后，请在 DSH 插件页停用再重新启用 `dsh-orrery`（或重启 DSH）使新插件代码加载生效。停用期间 Hub 立即显示该会话离线，消息留群不补发。

## 对话枚举、活动与 Token

- **只读列表（`src/adapters/deepseek/store.ts`）**：读取 `<DSH_HOME 或 ~/.dsh>/storages/session_projcache/sessions/*.json` 获取项目目录、标题与更新时间，并过滤子代理会话（基于 `subagent` 投影识别）。
- **Token 与额度**：暂不支持订阅额度（不接触用户 API Key）；插件在等待轮次结束时累计该轮 `assistant/message` 与重试试探用量并在 `done` 中上报，整体会话累计由投影缓存 `tokenUsage` 只读提供。

## 安全与实际使用

- **权限提示**：入队消息遵循用户自己在 DSH 设置的权限预设，自动放行档位下外部 `@` 会直接触发执行。插件绝不读 `~/.dsh/.credentials.yaml`，不改会话设定，不记录桥密钥。
- **使用状态**：真实应用已验证收信、MCP 发言、忙时合批，以及关闭主窗口退居托盘后保持在线。
- **活动观察**：已通过最小真机验收，覆盖真实收发、轮次结束与心跳展示。
- **Token 口径**：逐轮数值来自宿主上报；缓存和多工具的细分核算与基本收发验证分开记录。
