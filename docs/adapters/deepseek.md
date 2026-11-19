# DeepSeek Harness 适配器（原生模式）

语言：**中文** | [English](deepseek.en.md)

DeepSeek Harness（下称 DSH）适配器通过仓库内置的独立 Cordis 插件包 `plugins/dsh-orrery/` 将用户 DSH 桌面端中的会话接入 orrery 集群。

## 工作原理：插件包 + 共用桥连接

`plugins/dsh-orrery/` 是一个零第三方 npm 依赖的 ESM bundle（兼容 `engines.dsh: >=0.2.1-rc.2 <0.3.0-0`），由用户自行安装并在 DSH 插件页启用。

1. **发现与共用长连接**：插件经 `lib/hub-discovery.mjs` 每次请求都读账户的 Hub 登记处（`ORRERY_REGISTRY`，默认 `~/.orrery/registry/`），连活动 Hub 或 `ORRERY_HUB` 钉住的那个，所有请求（含未读提示、轮次结束和活动报告）用 `x-orrery-sig` 签名，不读 `hub.json`（规则见[接入件：找 Hub、签名、报错](../native-mode.md#接入件找-hub签名报错)）。只连 `127.0.0.1`，使用独立 `node:http` agent 避免经过外部环境变量代理，建立共用 SSE 连接 `GET /bridge/stream?harness=deepseek`。
2. **合批等待与轮次终态回报（`follows: true`）**：
   - DSH 自身对队列中的每条 prompt 各开一轮，不会自动合并。因此插件在收到 `deliver` 并调用 `ctx.sessionController.prompt({ requestId: deliveryId, sessionId, mode: 'queue', ... }, signal)` 前，先监听该会话的 `session/event` 流。
   - 当看到对应 `rpcId === deliveryId` 的轮次启动并在随后的 `turn/end` 中捕获结果时，通过 `POST /bridge/done` 上报明确结果（`completed`、`failed` 或断线/超时 `unknown`）。在这之前，Hub 暂存新消息并在本轮结束时合批下发。
   - 若 DSH 版本未暴露 `ctx.on` 事件流或运行旧版插件（回执不带 `follows`），适配器退回到即刻 `accepted` 语义。
3. **工具注册与前缀映射**：插件经 `ctx.tools.register` 注册全部协作工具；因 DSH 原生基础包占用了全局 `send_message` 和 `list_agents` 工具名，插件统一加前缀 `mcp__orrery__*`，并将参数 Schema 投影为 DSH 支持的 JSON Schema 子集（开放映射与上限仍由 Hub 终审校验）。插件从不可伪造的 `exec.agent.id` 读取会话 ID 并附 `x-orrery-harness: deepseek` 与 `x-orrery-session` 头转发 `/mcp`。
4. **工具后置未读提示**：通过 `tools/post-execute` 挂载 500 毫秒超时后台查询 `/bridge/unread-hint`，在有未读变动时向 `additionalContexts` 注入唯一精简统计行（使用生产者来源 `source.kind: 'dsh-orrery'`）；Hub 不可达或无新消息时不改动原工具输出。

## 用户一次性安装与更新

详细步骤与注意事项见 [plugins/dsh-orrery/README.md](../../plugins/dsh-orrery/README.md)：

1. 在 DSH 的 **Plugins → Add plugin** 填写本地仓库 `<orrery>/plugins/dsh-orrery` 的绝对路径并确认启用；或退出应用后运行 `dsh plugin --profile desktop add link:<绝对路径>`。
2. 更新 orrery 后，请在 DSH 插件页停用再重新启用 `dsh-orrery`（或重启 DSH）使新插件代码加载生效（按上一步的路径或 `link:` 安装是路径引用，不用重装；单独拷走再装的要先重新拷一份）。停用期间 Hub 立即显示该会话离线，消息留群不补发。

## 对话枚举、活动与 Token

- **只读列表（`src/adapters/deepseek/store.ts`）**：读取 `<DSH_HOME 或 ~/.dsh>/storages/session_projcache/sessions/*.json` 获取项目目录、标题与更新时间，并过滤子代理会话（基于 `subagent` 投影识别）。
- **Token 与额度**：暂不支持订阅额度（不接触用户 API Key）；插件在等待轮次结束时累计该轮 `assistant/message` 与重试试探用量并在 `done` 中上报，整体会话累计由投影缓存 `tokenUsage` 只读提供。

## 安全与实际使用

- **权限提示**：入队消息遵循用户自己在 DSH 设置的权限预设，自动放行档位下外部 `@` 会直接触发执行。插件绝不读 `~/.dsh/.credentials.yaml`，不改会话设定，不记录接入密钥，也不把密钥原文发给 Hub。
- **使用状态**：真实应用已验证收信、MCP 发言、忙时合批，以及关闭主窗口退居托盘后保持在线。
- **活动观察**：已通过最小真机验收，覆盖真实收发、轮次结束与心跳展示。
- **Token 口径**：逐轮数值来自宿主上报；缓存和多工具的细分核算与基本收发验证分开记录。

## 读原生对话

官方插件和用户确认过的完全信任插件可以经 `Hub.memberTranscript` 按页读取 DeepSeek Harness 群员当前绑定的会话（契约见[架构说明](../architecture.md#读取群员当前绑定的原生对话)）。只读，不写任何文件，不启动应用。

- **读哪个文件**：`<DSH_HOME 或 ~/.dsh>/sessions/<项目文件夹>/<会话 id>/session.v<N>.jsonl.zstd`，只读编号最大的一代；换代后旧游标返回 `reset`。同一个会话 id 出现在两个项目文件夹里时拒绝；第一条记录必须是这个会话自己的头记录。实际文件必须在 `sessions` 文件夹里，链接和硬链接都拒绝。
- **多帧 zstd**：DSH 每次追加写一个 zstd 帧。Node 自带的 zstd 解压遇到多帧输入只解第一帧，帧尾校验和被截断时也会返回数据，所以读取器自己按帧头和块头（RFC 8878）找出完整的帧，没写完的最后一帧等下次再读，每次只把一个完整的帧交给解压器，而且只解压这一页用到的帧。游标记的是帧起点、记录和条目，追加新帧后仍然有效。
- **上限**：压缩文件超过 32 MiB 不读，返回 `archived`；每帧解压输出最多 4 MiB、解码窗口最多 8 MiB，超出或损坏的帧变成一条无法识别的条目；每页最多解压 8 MiB 或 1024 帧（判断头记录时解压的第一帧也算在内），剩余额度不够一帧的上限时停在帧边界，带游标继续，每页至少读一帧；一条记录最长 1 MiB。不是 zstd 帧的数据返回 `unsupported`。
- **归类**：用户消息、思考（只显示占位，不显示推理原文）、回答、工具调用和结果（包括 `run_code` 里发出的子调用）、中断和压缩提示分别归类；DSH 注入给模型的上下文、步骤、后台任务和设置记录不显示；不认识的记录计为无法识别。
- **认出 orrery 投递**：插件投递时把 Hub 的投递 id 作为请求 id，DSH 把它记在这条用户消息上。适配器只把这个请求 id 作为未核实的投递候选交给 Hub；Hub 只在它是真的投给这个成员的批次时，才把这条消息显示为投递，内容取自 Hub 自己的记录。正文从不作为证据，没有请求 id 的记录从不当作投递，所以在应用里亲手打出的信封或直发正文仍是用户输入。剩下能伪造的只有用 DSH 的会话接口以一个已知的真实投递 id 再发一条，显示的也只是本来就投给这个成员的消息正文。群员发言按 `mcp__<服务器>__send_message` 的成功结果里的消息 id 关联，服务器名不固定，Hub 只关联这个成员自己发的消息。
- **已核对**：DeepSeek Harness 0.2.1-rc.2 的会话文件（只看结构）；测试使用运行时压缩的手写合成记录。
