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
| `src/core/external-plugins*.ts` | 外部插件加载、JSON-RPC、事件流与写限制控制 | [外部插件](external-plugins.md) |
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
| `ORRERY_MOCK` | 设为 `1` 时启用原生态内存 `mock` 适配器 | 未开启 |
| `ORRERY_MAX_HOPS` | 单链最大跳数（非负整数，`0` 合法，不支持 `unlimited`） | `6` |
| `ORRERY_MAX_TURNS_PER_CHAIN` | 单链最大轮次（非负整数，`0` 合法，不支持 `unlimited`） | `20` |
| `ORRERY_DISABLED_PLUGINS` | 逗号分隔的禁用官方插件 ID | 空 |

## 原生数据流与成员创建边界

1. **单一原生模式**：`StartOptions`/`HubOptions` 只接收 `nativeAdapters`；`Member.mode` 仅保留单值 `'native'`（创建成员时省略即默认 `'native'`，传其他值一律拒绝，前端不再提供模式切换开关）。
2. **新建 vs 接入的目录来源**：
   - **新建原生会话（`createSession`）**：在支持新建的适配器上**必须显式传入 `projectPath`**，不存在默认沙箱目录回退；
   - **接入已有会话（`attach`）**：从对应适配器的只读存储读取该会话原有的 `cwd`。
3. **投递机制与不补发约定**：Hub 通过**桥推送**（Claude 桥、DeepSeek 插件）、**队列唤醒**（Codex 短命进程 + 确认应用运行后打开 `codex://threads/wake/`）以及**后台等待/停靠 Hook**（ZCode、Qoder、WorkBuddy、Cursor）向运行中的宿主应用送达合批信封；应用未运行时成员离线且不自动启动、不补发历史。详见 [原生模式](native-mode.md)。

### Web 认证与 SSE（`GET /api/stream`）

- Web 服务固定监听 `127.0.0.1`。除静态页与用于换取 Cookie 的 `POST /api/session` 外，其余 `/api/*`（含 `GET /api/health`）均要求合法 API Bearer 令牌或会话 Cookie。完整协作、任务与成员 HTTP/MCP 契约见 [协作与任务 API](collaboration-api.md)。
- SSE 端点为 **`GET /api/stream`**，支持 `?since=` 续传；事件类型为 `core/types.ts` 中定义的 14 种 `HubEvent.kind`：`cluster`、`member`、`message`、`delivery`、`read`、`acknowledgement`、`agent`、`guard`、`pause`、`settings`、`usage`、`collaboration`、`unread_hint`、`delivery_dismissed`。

## 存储与迁移原则

- `src/core/store.ts` 维护核心表（`clusters`、`members`、`messages`、`deliveries`、`reads`、`message_acknowledgements`、`events`、`settings`、`files`、`message_files`、`turn_usage`、`quota_snapshots`、`activity_snapshots`、`merge_windows`、`plugin_migrations`），启动时执行单向增量迁移（集群分组保存在 `settings` 中，成员隐身字段为 `members.hidden_at`）；可用 `npm run backup` 备份私有数据库。
- 官方插件通过 `plugin_migrations` 各自管理扩展表（如 `tasks`、`coordinator` 与 `bookmarks` 的 `collaboration_tasks`、`collaboration_roles`、`collaboration_member_roles`、`collaboration_links`、`collaboration_bookmarks`、`collaboration_policies`、`collaboration_operations`、`collaboration_records`、`task_label_groups`、`task_labels`、`cluster_label_groups` 等）。
- 仅在 `POST /api/clusters/:id/purge` 事务内删除已软删除集群关联数据与无主磁盘文件；不支持跨版逆向回退数据库。外部客户端兼容范围与已验证边界见各适配器说明，一次本机测试通过的版本不视作对全部上游更新版本的兼容保证。
