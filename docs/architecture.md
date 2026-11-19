# orrery 架构说明（Native Beta）

语言：**中文** | [English](architecture.en.md)

## 模块划分

代码位于 `src/` 与 `desktop/`，入口由 `package.json` 暴露；仅注册原生模式 `NativeAdapter`（`nativeAdapters`）：

| 模块 | 职责 | 说明 |
|---|---|---|
| `src/main.ts`、`src/launcher.ts` | Hub 进程入口与浏览器启动器 | [启动器](launcher.md) |
| `src/config.ts` | 环境变量与路径解析（端口、数据库、skill 目录、禁用插件） | — |
| `src/core/types.ts` | 核心领域类型与 `NativeAdapter` 接口（含 `system-kinds` 引用） | — |
| `src/core/hub.ts` | `Hub` 核心调度、事件总线、路由/合批、防循环、隐身与桥登记 | — |
| `src/core/store.ts` | SQLite 持久化（`node:sqlite`）、单向增量迁移、消息/投递/设置查询 | — |
| `src/core/handover.ts` | 成员交接包组装（结合任务插件 `src/plugins/tasks/handover.ts`） | [成员管理](cluster-members.md) |
| `src/core/activity.ts` | 成员活动观察状态（心跳、过期、断连） | [活动观察](activity.md) |
| `src/core/files.ts` | 网页上传与原生成员发件箱副本及路径校验 | [文件与 Skill](files.md) |
| `src/core/external-plugin*.ts`、`event-registry.ts` | 受限第三方插件：登记与清单、进程协议、事件通道、发言、命令、群员工具、网页界面与标记、配置 | [第三方插件](external-plugins.md) |
| `src/core/trusted-plugins.ts` | 完全信任插件：加载前按数据判断（安全模式、确认、依赖）、导入、确认与撤销 | [第三方插件](external-plugins.md#完全信任的插件) |
| `src/core/plugin.ts` | `PluginHost`：插件注册表、插槽校验、逐插件迁移与故障隔离 | [插件](plugins.md) |
| `src/core/app-extensions.ts`、`skill-install.ts`、`zip.ts` | 技能与 MCP 页的只读总览，以及把 skill 装进共享文件夹 | [文件与 Skill](files.md) |
| `src/core/usage.ts` | 额度快照与逐轮/对话 token 汇总 | [额度与用量](usage.md) |
| `src/mcp/server.ts` | MCP HTTP 服务与原生调用方身份认证 | [原生模式](native-mode.md) |
| `src/mcp/bridge.ts` | `/bridge/*` SSE 流、回执、轮次结束、等待/停靠及插件桥路由 | [原生模式](native-mode.md) |
| `src/mcp/wait-core.ts`、`hook-park.ts`、`antigravity.ts` | 后台等待票据、Hook 停靠登记与 Antigravity HMAC 签名校验 | 各适配器文档 |
| `src/adapters/` | 各 harness 原生适配器、`shared/` 与测试用 `mock/native.ts` | 各适配器文档 |
| `src/plugins/` | 官方内置插件：`tasks`（含 `ship`）、`coordinator`、`bookmarks` | [官方插件](plugins.md) |
| `src/web/` | 静态网页资源、HTTP API、SSE（`GET /api/stream`）与会话认证 | [协作 API](collaboration-api.md) |
| `desktop/` | 独立 Electron 桌面外壳与 Win32 顶层窗口停靠（无 `src/` 代码依赖） | [桌面外壳](desktop.md) |

Windows 安装版由 `desktop/lib/runtime.mjs` 选择内置 Node、外置 Hub 文件与用户数据目录；升级、卸载时先核对并退出本安装实例的 Hub。见[桌面版说明](desktop.md)。

## 依赖规则

依赖保持单向，由 `test/boundaries.test.ts` 对 `src/` 导入自动校验：

- `src/core/` 不导入 `adapters/`、`mcp/`、`web/`、`main.ts` 或 `launcher.ts`。
- `src/adapters/` 不导入 `core/hub.ts`、`core/store.ts`、`mcp/`、`web/`；只依赖 `core/types.ts`、`adapters/shared/` 与标准库/外部工具。
- `src/mcp/` 不导入 `adapters/`、`web/`、`core/store.ts`；只通过 `Hub` 接口和 `core/types.ts` 协作。
- `src/web/` 只经 `Hub` 和插件命令接口读写，不直接操作适配器或插件内部 SQLite 表结构。
- `src/plugins/` 通过官方插件接口注册工具、事件、定时规则与 Web/Bridge 路由。

## 运行约定与默认路径

- 运行时：**Node.js >= 24.2** 直接运行 `.ts` 文件（无需构建步骤），内置 `node:sqlite`（默认 WAL 日志模式，可通过 `ORRERY_DB_JOURNAL=wal|delete` 调整）。
- 配置优先级：**网页已保存设置 > 启动环境变量 > 默认值**（[防循环与限流](hop-limit.md)）。
- 集群名可含内部空格；成员名须兼容 `@<名字>` 提及（不可含空格与控制字符）。

| 变量 | 说明 | 默认值 |
|---|---|---|
| `ORRERY_HOME` | Hub 数据根目录 | `~/.orrery` |
| `ORRERY_DB` | SQLite 数据库路径 | `<仓库>/.tmp/orrery.db` |
| `ORRERY_PORT` | Hub HTTP 监听端口 | `4317` |
| `ORRERY_SKILLS_DIR` | 协作页 `$` 补全扫描目录 | `~/.agents/skills` |
| `ORRERY_MOCK` | 设为 `1` 时启用演示用的 `mock` 适配器（一个演示项目、两个会自动回一句假话的对话，不调用模型） | 未开启 |
| `ORRERY_MAX_HOPS` | 单链最大跳数（非负整数，`0` 合法，不支持 `unlimited`） | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | 单链最大轮次（非负整数，`0` 合法，不支持 `unlimited`） | `20` |
| `ORRERY_DISABLED_PLUGINS` | 逗号分隔的禁用插件 ID（官方或第三方） | 空 |
| `ORRERY_SAFE_MODE` | 设为 `1` 时跳过所有完全信任插件（`0` 或不设为正常模式，其他值启动报错） | 未开启 |
| `ORRERY_API_TOKEN` | 固定的网页 API 令牌（至少 32 个字符）；不设时首次启动生成并保存在 `<ORRERY_HOME>/api-token` | 自动生成 |

## 原生数据流与成员创建边界

1. **单一原生模式**：适配器通过 `nativeAdapters` 注册。新建对话的成员规格须明确传 `mode: "native"` 和非空的 `projectPath`，接入已有对话时用 `sessionId`。界面不需要切换模式，成员输出不带 `mode`。
2. **新建 vs 接入的目录来源**：
   - **新建原生会话（`createSession`）**：在支持新建的适配器上**必须显式传入 `projectPath`**，不存在默认沙箱目录回退；
   - **接入已有会话（`attach`）**：从对应适配器的只读存储读取该会话原有的 `cwd`。
3. **投递机制与不补发约定**：Hub 通过**桥推送**（Claude 桥、DeepSeek 插件）、**队列唤醒**（Codex 短命进程 + 确认应用运行后打开 `codex://threads/wake/`）以及**后台等待/停靠 Hook**（ZCode、Qoder、WorkBuddy、Cursor）向运行中的宿主应用送达合批信封；应用未运行时成员离线且不自动启动、不补发历史。详见 [原生模式](native-mode.md)。

### Web 认证与 SSE（`GET /api/stream`）

- Web 服务固定监听 `127.0.0.1`。除静态页与用于换取 Cookie 的 `POST /api/session` 外，其余 `/api/*`（含 `GET /api/health`）均要求合法 API Bearer 令牌或会话 Cookie。完整协作、任务与成员 HTTP/MCP 契约见 [协作与任务 API](collaboration-api.md)。
- SSE 端点为 **`GET /api/stream`**，支持 `?since=` 续传；事件类型为 `core/types.ts` 中定义的 14 种 `HubEvent.kind`：`cluster`、`member`、`message`、`delivery`、`read`、`acknowledgement`、`agent`、`guard`、`pause`、`settings`、`usage`、`collaboration`、`unread_hint`、`delivery_dismissed`。
- 同一条流里另有几种带名字、没有 `id` 的帧，只给用户的页面：`plugin-run`（插件命令的进度和结果）、`plugin-state`（第三方插件的运行状态）、`plugin-ui`（插件网页的推送、标签和标记）、`plugin-config`（插件配置变化）。它们不写事件表、续传时不重放，也不转给插件。

## 存储与迁移原则

- `src/core/store.ts` 维护核心表（`clusters`、`members`、`messages`、`deliveries`、`reads`、`message_acknowledgements`、`events`、`settings`、`files`、`message_files`、`turn_usage`、`quota_snapshots`、`activity_snapshots`、`merge_windows`、`plugin_migrations`），启动时执行单向增量迁移（集群分组保存在 `settings` 中，成员隐身字段为 `members.hidden_at`）；可用 `npm run backup` 备份私有数据库。当前 schema 版本为 **v30**（`PRAGMA user_version`）。
- **v30：隔离模式已删除**。原生模式是唯一的群员模式；升级时，数据库里仍在群里的旧隔离群员（如果有，包括回收站里的群）被移出：排队的投递记为取消、运行中的记为失败且结果未知，已安装插件照常执行移出成员的清理，每个受影响的群加一条 `mode_removed` 系统消息说明谁被移出、记录都保留（不投递给任何人）。已有消息、已读、用量和投递记录都保留；群员发出的消息投递失败时，发送者在 Hub 启动后照常收到失败通知。不再是群员的协调员在启动或恢复群时停用。从没有隔离群员的数据库升级时没有可见变化。`members.mode` 列只作历史保留，代码不再读取。
- **升级前备份**：已有数据库在这次启动有待跑的迁移（核心 schema 或任何插件的迁移步骤）时，Hub 在第一次改结构之前自动备份到 `<ORRERY_HOME>/backups/orrery-<时间>-pre-upgrade.db`；只保留最新几个自动备份，这一轮升级还没完整完成时保留最早的那个还原点。`npm run backup` 的手动备份从不自动删除。Hub 不会自动还原备份。
- 官方插件通过 `plugin_migrations` 各自管理扩展表（如 `tasks`、`coordinator` 与 `bookmarks` 的 `collaboration_tasks`、`collaboration_roles`、`collaboration_member_roles`、`collaboration_links`、`collaboration_bookmarks`、`collaboration_policies`、`collaboration_operations`、`collaboration_records`、`task_label_groups`、`task_labels`、`cluster_label_groups`、`task_batches`、`task_watches`、`task_cluster_settings` 等）。完全信任插件的表以 `x_<插件 ID>_` 开头，迁移在越出前缀时回滚。
- 仅在 `POST /api/clusters/:id/purge` 事务内删除已软删除集群关联数据与无主磁盘文件；不支持跨版逆向回退数据库。外部客户端兼容范围与已验证边界见各适配器说明，一次本机测试通过的版本不视作对全部上游更新版本的兼容保证。

## 读取群员当前绑定的原生对话

进程内调用 `Hub.memberTranscript(memberId, request)`，按页读取一个群员当前绑定的原生对话正文。Hub 自己解析成员绑定，再调原生适配器可选的 `transcript` 方法：Claude 读取这个会话的项目 JSONL，Codex 读取对应的当前或归档 rollout，Kimi Code 读取绑定会话的 `agents/main/wire.jsonl`（先核对 `state.json` 身份），ZCode 和 Qoder 在原处只读读取各自的 SQLite 库（共用 SQLite 读取器，不写任何文件），Cursor 读取 `agent-transcripts/<id>/<id>.jsonl`（剥离包装并提交候选投递、不读 `state.vscdb`），WorkBuddy 读取 `projects/<proj>/<sessionId>.jsonl`（核对 `session-meta`、跳过子代理并校验等待命令输出），Antigravity 读取 `brain/<uuid>/.system_generated/logs/transcript_full.jsonl`（缺失回退 `transcript.jsonl`，脱敏 `orreryCaller` 与思考并配对 `SYSTEM_MESSAGE`/`call_mcp_tool`），DeepSeek Harness 见下文说明；其他适配器返回 `unsupported`。格式细节见 [Claude 适配器](adapters/claude-adapter.md)、[Codex 适配器](adapters/codex.md)、[Kimi Code 适配器](adapters/kimi.md)、[ZCode 适配器](adapters/zcode.md#读对话原文)、[Qoder 适配器](adapters/qoder.md#读对话原文)、[Cursor 适配器](adapters/cursor.md#对话枚举与状态判断)、[WorkBuddy 适配器](adapters/workbuddy.md#只读会话存储与对话正文读取)、[Antigravity 适配器](adapters/antigravity.md#配置步骤与只读列表) 和 [DeepSeek 适配器](adapters/deepseek.md#读原生对话)。

- 不带游标时读最后一页；`direction: 'before'` 和返回的 `before` 翻看旧内容，`direction: 'after'` 和 `after` 读取新追加的记录。条目按原文件顺序排列，相同条目 ID 表示更新；不完整的末行要等写完整后才能读到。`items` 为空时 `hasMore` 仍可能表示这个方向还有内容。
- 每页最多 200 条，每段文本最多 16 KiB，截断时带标记。文件被清理、重写或换代时按返回的状态处理；收到 `reset` 时丢弃旧游标重新读。
- 读取按需进行，只在内存里返回结果：不启动应用、不改应用的记录，也不把正文写进 Hub 的数据库、事件或日志。核心没有读正文的网页、MCP 或受限插件接口。权限边界见[安全模型](security.md#已绑定会话的正文)。
- 读取器分块扫描，用文件身份、大小和局部内容核对游标；文件持续增长时，另一个程序同时原地改写采样范围以外的旧内容可能识别不出来。
- 投递候选：Claude 的投递带应用写入的可信标记，Codex 带投递号，这两条规则不变。没有可信标记的应用里，投递出现在等待命令的 `tool_result`、`system` 记录或没有标记的 `user` 记录里，适配器只交出未核实的线索 `source.candidate`：`deliveryId`（确切的投递号）、`envelope`（以 `[orrery] cluster=…` 开头的信封，只看第一行，群必须是该成员所在的群）、`direct`（`{ body, at?, deliveryIdPrefix? }`：正文必须恰好等于一条真正投递给该成员、没有附件的直发消息，多条相同即不匹配；`at` 套用投递时间条件；`deliveryIdPrefix` 至少 8 位十六进制，必须是该投递号的开头）。只处理 `user`、`system`、`tool_result` 三种条目，按 `deliveryId`、`envelope`、`direct` 的顺序取第一个命中的。命中时条目变成 `orrery_delivery`，内容取自 Hub 的消息，保留原条目的 `id`、`timestamp`、`callId`；不命中时原样返回。`source` 不出现在返回结果里。已接受的局限：用户手打的文字若与真实投递给该成员的信封或正文完全相同，会显示成那次投递；显示的内容来自 Hub 里的真实消息，不会出现别的群或别的成员的内容。
- DeepSeek Harness 读取绑定会话最新一代的多帧 zstd 日志：只按帧头找出完整的帧、只解压一页用到的帧，游标在追加后仍然有效，解压有上限，投递只按插件设下的请求 id 认出，没有它的记录从不当作投递。见 [DeepSeek 适配器](adapters/deepseek.md#读原生对话)。

## 界面与应用服务

`shared/i18n` 是网页和桌面共用的纯文本词表。`src/update-check.ts`、`src/plugin-install*.ts` 是进程级服务，由 `main.ts` 经结构化 WebControl 接口注入，核心协作层不引入网络或包管理器依赖。更新偏好与缓存位于 `<home>/updates.json`；插件包保存在 `<home>/plugin-packages`，通过 `external-plugins.json` 登记。归档解析固定使用 `tar 7.5.23` 和 `yauzl 3.4.0`（自动化验证：2026-11-17）。
