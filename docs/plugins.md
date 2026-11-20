# 插件（`v0.10.0-beta.2`）

语言：**中文** | [English](plugins.en.md)

> **Beta 提示**：插件随 **`v0.10.0-beta.2`（Beta 测试版）** 提供，非正式稳定版，插件工具、事件与界面插槽合同仍可能调整。

orrery 核心只负责集群、成员、原生群聊投递、消息存储、权限和防循环；暂停开关和防循环上限永远留在核心。任务管理、协调员与资料收藏以官方内置插件的形式位于 `src/plugins/`。仓库根目录的 `plugins/` 是给各家原生应用安装的桥，和这里说的 Hub 插件无关。

## 三层插件

| 层 | 形态 | 说明 |
|---|---|---|
| 官方插件 | `src/plugins/<id>/` 里的同进程模块，和核心共用数据库和事务 | 本页 |
| 完全信任的第三方插件 | 用户登记并在设置页确认后，和官方插件一样在 Hub 进程里运行，用同一套 Hub 侧插槽，可以带一个同页网页模块 | [第三方插件「完全信任的插件」](external-plugins.md#完全信任的插件)；表名和路由有前缀要求，`ORRERY_SAFE_MODE=1` 跳过全部 |
| 受限的第三方插件 | 独立 Node 进程，stdio JSON-RPC，按群授权 | [第三方插件](external-plugins.md)；读取、事件、受限发言、发言检查、命令、群员工具、沙盒网页和标记 |

## 插件机制

官方插件的 `defaultEnabled: false` 表示首次启动关闭。Hub 启动和设置页的下次启动状态共用优先级：环境变量强制禁用、用户显式禁用、用户显式启用、清单默认值。设置保存 `plugins.json` 的 `disabled` 和 `enabled`，同一个插件 ID 只留在一边。删除文件会恢复各插件的默认设置。

- 官方插件在 Hub 启动时加载，可注册数据库迁移、协作动作和查询、MCP 工具、Web/Bridge 路由、消息字段、后台服务、生命周期钩子和事件类型，并可向协作网页注册**官方网页插槽**。
- `src/core`、`src/mcp`、`src/web` 不导入任何插件，只有组装入口 `src/main.ts` 导入注册表（`test/boundaries.test.ts` 守住这条）。
- **故障隔离**：核心在调用插件的每一处都做了隔离。后台服务的构造、启动、定时检查、关闭和事件回调抛错只记一条故障（设置页卡片显示“插件出错（环节）：原因”），Hub 和其他插件照常；某个插件的 MCP 工具注册失败只少它这一组工具；事务里的钩子抛错时整个操作回滚并返回 `PLUGIN_HOOK_FAILED`。插件自己开的定时器和卡死（死循环、同步阻塞）不在隔离范围内。
- **启用和禁用**：设置页“插件”一节写 `<ORRERY_HOME>/plugins.json`；启动环境变量 `ORRERY_DISABLED_PLUGINS`（逗号分隔插件 ID）优先级更高。开关只改下次启动，重启 Hub 后生效；依赖校验看下次启动的状态。禁用的插件不注册动作、工具、路由和消息字段，但仍会跑迁移，表和数据都留着。
- 设置页把插件分成“官方插件”和“第三方插件”两组，每个插件一张卡片：图标、名称、版本、说明、开关、状态和依赖。

## 官方网页插槽

四个官方插件（`tasks`、`bookmarks`、`coordinator`、`starmap`）均采用官方包目录结构 `src/plugins/<id>/{release.json,package/,index.ts}`：内置入口通过 `src/official-plugin-host.ts` 的宿主合同（`hostApi: 1`）调用包内 `package/hub/index.mts` 并用 `packageSource` 指向 `package/`，使其网页模块、图标与独立词表在内置与签名更新模式下同走 `/official-plugin-web/<id>/<digest>/` 与 `/api/plugins/<id>/icon`。完全信任插件用清单的 `webEntry` 提供同样形状的模块（Hub 在 `/plugin-web/<id>/` 提供，信任结束时页面就地卸下它）；受限插件没有同页代码，它的网页在沙盒框架里。

模块导出 `register(host)`，返回用到的插槽。`host` 有 `api`、`nameOf`、`command`、`i18n`（包内自带译文及实时切换 `t`、`lt`、`language`、`onLanguageChange`）和页面共用的界面工具 `ui`（`h`、`icon`、`emptyState`、`noticeDialog`、`confirmDialog`、`formDialog`）；`plugin-slots.js` 也提供 `onDispose(fn)`。

| 插槽 | 接在哪里 |
|---|---|
| `message` | `render(message, state)` 返回消息下的节点；可选 `key`、`update`、`capture`、`restore` |
| `composer` | 返回放在群聊输入框和发送按钮之间的控件 |
| `workbench` | 返回工作台资料库页签的 ID、名称（支持 `lt` 实时文本）、渲染和加载函数 |
| `settings` | 返回放在设置的插件列表下方的节点 |
| `view` | 整页视图 `{ id, title, icon, mount(el, ctx), unmount() }` |

模块或插槽回调失败时，网页在控制台记录原因，其他插槽和页面继续运行。

## 官方内置插件与依赖关系

1. **`tasks`（任务与 `ship`）**：
   - 提供任务建单、三档验收（成员独立验收 / 自查 / 用户验收）、依赖关系、验收批次、标签库、关注、`#number` 引用、本地 Git 分支关联、停滞检测、交接与 `ship` 合并流，见[协作与任务流程](collaboration.md)。
   - **可单独使用**：关闭 `coordinator` 时，`tasks` 插件的所有任务看板、提交、验收与 `ship` 能力**依然照常可用**。
2. **`coordinator`（协调员工作台）**：
   - **依赖 `tasks` 插件**：只有在启用 `tasks` 时 `coordinator` 才能运行；提供 8 项可控的协调员委托策略，以及空闲任务与额度耗尽提醒。
3. **`bookmarks`（群资料库）**：
   - 支持群员（`bookmark_message`、`list_bookmarks`）与用户按标签收藏群聊结论或代码片段，供跨轮次查阅。

4. **`starmap`（星图）** 默认关闭。启用后注册经网页认证的已绑定会话读取路由，正文响应禁止缓存。

三个插件都声明了自己的事件类型（任务、收藏、协调员），第三方插件可以按授权订阅，见[第三方插件「事件订阅与发布」](external-plugins.md#事件订阅与发布)。

## 禁用后的已知影响

- 若同时禁用 `tasks`（或所有官方插件），集群保留基础群聊、消息路由与文件收发；由于 `coordinator` 依赖 `tasks`，禁用 `tasks` 时协调员也会一并停用。
