# 第三方插件（实验性 API v1）

语言：**中文** | [English](external-plugins.en.md)

orrery（`v0.10.0-beta.4` Beta 测试版）可以运行仓库以外的第三方 Hub 插件。第三方插件分两档：

| | 受限插件 | 完全信任插件 |
|---|---|---|
| 代码在哪里跑 | 独立的 Node 子进程，经 `stdin`/`stdout` 行分隔 JSON-RPC 2.0 与 Hub 通信 | 用户在设置页确认后，在 Hub 进程里运行 |
| 能碰的数据 | 只有用户授予的权限、事件类型和群 | Hub 数据库里的全部数据，和 orrery 本身权限相同 |
| 网页 | 沙盒框架（`<iframe sandbox="allow-scripts">`）里自己的页面，外加由 orrery 画的标记 | 可选的同页网页模块，用官方插件的网页插槽 |
| 怎么安装 | 设置页安装，或手动登记 | 只能手动登记（`"trust": "full"`），再在设置页确认 |

> **只运行你信任的代码。** 插件和 Hub 使用同一个操作系统账户。独立进程只做故障隔离，**不是安全沙箱**：下文的授权只约束经 orrery 协议调用的能力，拦不住插件绕开协议直接访问该账户的文件、网络和程序。Hub 不扫描目录、不自动更新插件。本设计致谢 MIT 开源参考实现 `deepseek-harness` `dsh-v0.2.1-rc.2`（Copyright (c) 2026 DeepSeek）。安全承诺见[安全模型](security.md)。

接口处于实验与 Beta 演进期，`apiVersion` 目前为 `1`。新增能力都向后兼容：旧插件和旧配置照常工作，新的通知、方法只发给声明或申请了它们的插件。

## 从设置安装（受限插件）

1. 打开**设置 → 插件**，填写 GitHub 仓库、分支、标签或归档地址，公开 npm 包名（可带 `@版本` 或标签），HTTPS 安装包地址，或选择本地 ZIP/tgz。包里有多个清单时，先选要安装的那个。
2. 检查清单、版本、解析后的来源和依赖。按需勾选权限、事件、工具、界面位置，以及可读、可写的群。准备过程只读取和解包，所有授权项初始为空。
3. 点**确认安装**。Hub 核对审阅过的包并写入受限插件登记；公开 npm 依赖只在确认后安装，禁用 npm 生命周期脚本。退出并重新打开 Orrery 后生效。

单个包下载或上传最多 32 MiB，解包最多 128 MiB、5,000 个条目、单文件 32 MiB；审阅 30 分钟内有效，取消会清理暂存文件。安装器只写受限插件登记，保留已有的完全信任登记。

## 清单预检

登记前可以在仓库根目录检查一个本地清单：

```sh
npm run plugin:inspect -- examples/hub-plugins/message-counter/orrery-plugin.json
npm run --silent plugin:inspect -- --capabilities
```

第一条沿用 Hub 的清单和入口校验，列出依赖、权限申请、订阅和发布的事件、命令、群员工具、网页位置和配置字段；通过时退出码为 0，否则打印原因并以非零退出。它只读清单和入口文件的元数据，不运行插件。第二条输出当前版本支持的能力（JSON）：API 版本、权限、网页位置、命令参数类型、配置字段类型和标记状态。

## 手动登记与授权

受限插件的目录里放一个 `orrery-plugin.json` 清单，由用户登记到 `<ORRERY_HOME>/external-plugins.json`：

```json
{
  "plugins": [
    {
      "manifest": "C:/plugins/my-plugin/orrery-plugin.json",
      "permissions": ["clusters.read", "messages.read", "events.read"],
      "events": ["task.*"],
      "clusterIds": ["<允许读取与收事件的群 ID>"],
      "writeClusterIds": []
    }
  ]
}
```

清单示例：

```json
{
  "id": "message-counter",
  "version": "1.0.0",
  "name": "消息计数示例",
  "description": "统计指定群最近最多 100 条消息的发送者分布。",
  "apiVersion": 1,
  "entry": "main.mjs",
  "permissions": ["clusters.read", "messages.read"],
  "commands": [{ "id": "count", "title": "统计最近消息" }]
}
```

- `id` 和命令 ID 为 1～64 个小写字母、数字或 `-`，以字母开头；`entry` 是插件目录内的 `.js`、`.mjs` 或 `.cjs`，解析链接后仍须在目录内。Hub 用自己的 Node 直接启动它，不经过 shell。
- 可选 `requires`（依赖的官方或第三方插件）、`icon`（目录内的 png/webp/ico/svg，最多 256 KiB，只在卡片的 `<img>` 里显示）、`details`（卡片展开后的说明，纯文本或聊天支持的 Markdown 子集，最多 4000 字）、`shutdownGraceMs`（停止时的宽限，100～30000 毫秒，默认 5000）。
- 清单的 `permissions` 是**申请**，登记里的 `permissions` 才是**授予**，必须是申请的子集。省略权限、事件、群、工具或界面位置都等于空列表，**不等于全部**。
- 权限：`clusters.read`（群和成员列表）、`messages.read`（消息列表和单条消息）、`events.read`（订阅事件）、`events.publish`（发布自己的事件）、`messages.send`（发言）、`messages.mention`（发言可唤醒成员）、`messages.gate`（发言检查）、`tools.provide`（给群员提供工具）、`ui.show`（显示网页和标记）。
- `clusterIds` 是读白名单（最多 100 项，无通配符），决定读取、事件、发言检查、工具和网页在哪些群生效；`writeClusterIds` 单独限定可发言的群。新群不会自动获得授权，已删除的群即使还在名单里也不生效。
- 最多 16 个插件，每个最多 32 个命令；配置和清单各不超过 64 KiB。

**故障隔离与登记诊断**：`external-plugins.json` 本身损坏（不是合法 JSON、结构不对、超过 16 个插件）时 Hub 拒绝启动。单个插件的问题（清单读不到、目录被删、入口越界、权限写错、依赖缺失或成环）只跳过这个插件和依赖它的插件，原因写进 Hub 日志，其余照常启动。清单能读到的插件在设置页显示为 `failed`；读不到或 ID 冲突的登记显示为只读的“登记失败”卡片，带登记序号、清单路径和原因。认证后的 `GET /api/plugins` 用 `skippedRegistrations` 返回这些诊断。修改清单、权限或群范围后，在设置页点这个插件的“重启”（或重启 Hub）才生效；新登记的插件要重启 Hub。

## 进程协议

每行一条 JSON-RPC 2.0 消息，请求带非空字符串 `id`；stdout 只用于协议，日志写 stderr（Hub 不记录、不转给网页）。每帧最多 64 KiB，每个插件最多 16 个未完成的 Hub 请求，输出最多每秒 200 帧。插件不继承 Hub 的环境变量和凭据。

Hub → 插件：`initialize`（只带实际授权；插件在结果里可用 `notifications` 申请 `message.check.result`、`writeSettings.changed`、`command.cancel` 三种通知）、`invoke`（命令）、`shutdown`、`message.check`（发言检查）、`tool.call`（群员工具）、`ui.request`（网页请求），以及通知 `event`、`config.changed`。

插件 → Hub（按授权）：

| 方法 | 权限 | 作用 |
|---|---|---|
| `host.clusters.list` | `clusters.read` | 白名单里未删除的群 `{id,name}` |
| `host.members.list` | `clusters.read` | 群里当前成员的 `id,name,harness,status,hidden,roles`（不给会话 ID、工作目录、头像、模型或令牌） |
| `host.messages.list`、`host.messages.get` | `messages.read` | 最近一页消息或单条消息；正文超过 8000 字截断，Hub 合成的系统正文省略（`bodyOmitted`） |
| `host.messages.send` | `messages.send` | 向写入群发言 |
| `host.events.publish` | `events.publish` | 发布自己的事件 |
| `host.ui.push`、`host.ui.chip`、`host.ui.mark` | `ui.show` | 推数据给自己的网页、设标题栏标签文字、设标记 |

拒绝统一为 `-32000` 错误，部分方法在 `error.data.code` 带稳定短码（`PERMISSION_DENIED`、`INVALID_DATA`、`CLUSTER_NOT_GRANTED`、`NOT_FOUND` 等）。读取不会标已读、确认或触发投递。协议不提供文件路径、附件内容、成员工作目录、原生会话 ID、凭据、数据库或任意 SQL。超时、进程退出、坏帧、超大输出或输出洪泛会把插件标为 `failed` 并结束进程，Hub 和其他插件继续工作。

受限插件无法通过消息接口读取星图成员私聊，也不能用私聊作分页游标、发言来源或标记目标。私聊的消息、投递、回执和防循环事件不会推给受限插件。涉及群聊和私聊的混合回执只列群聊消息。

## 插件发言（`messages.send`）

授予 `messages.send` 并在 `writeClusterIds` 里列出群后，插件可以发言（正文最多 8000 字；`causedBy` 可选，必须是同群已有消息，发言继承它的消息链）。消息署名“插件 <id>”，类型为 `plugin`。默认 `@` 按普通文字处理；要唤醒成员，须同时授予 `messages.mention` 并在**设置 → 插件 → 发言设置**里打开唤醒开关，唤醒仍遵守暂停、在线检查和防循环上限。每个插件在每个群默认每分钟 10 条、每小时 200 条，可调整，设为无限需确认。超限时返回错误并在群里留一条不唤醒任何人的限频提示。

成员读到插件消息时，正文会进入模型上下文，应当作队友的请求处理，仍以用户的授权和应用审批为准。

## 发言检查（`messages.gate`）

用于“裁判”类插件（例如“主持人发言后每人只能回复一次”）。群员的一条消息通过 Hub 自己的检查之后、写入数据库之前，Hub 同时问授权群里每个有此权限、正在运行的插件：

- 请求带发送者、点名和收件人、`fyi`、`replyTo`、附件个数、正文长度；插件同时有 `messages.read` 时才带正文。每次检查有一个 `checkId`。
- 回答 `{allow:true}` 放行，`{allow:false, reason}` 拒绝（原因最多 300 字，写进群里的拒绝记录）。插件不能改写消息。
- **全部放行才放行**。被拒绝的消息不存、不投递，发送者收到 `REFUSED_BY_PLUGIN` 和原因，群里留一条不含正文的系统记录。
- **没有回答就放行（fail-open）**：插件没运行、1.5 秒内没回答、回答格式不对时消息照常发出，并留一条“插件没有完成检查”的记录。单次超时不停插件，连续 3 次超时才停止它（`CHECK_TIMEOUT`）。
- 申请了 `message.check.result` 的插件会收到结果通知（`stored:true` 与 `messageId`，或 `stored:false` 与 `refused_by_other`/`rejected_by_hub`）；订阅了 `message.created` 的被问插件在事件里拿到同一个 `checkId`。
- 不检查用户、系统和插件的消息，以及用户的重发和交接。

## 事件订阅与发布

**订阅（`events.read`）**：核心和官方插件按事件类型推送，插件按授予的模式接收。模式可以是精确类型（`task.approved`）、前缀（`task.*`，包含以后新增的同前缀类型）或 `*`；授予的每个模式都必须被清单申请的模式覆盖。官方插件被禁用时，它的事件类型就不存在。

事件目录（`data` 里以后可能增加字段，不会删除或改名）：

| 类型 | 所有者 | 何时推 |
|---|---|---|
| `message.created` | 核心 | 群里出现一条新消息（群员、用户、系统通知或插件发的）；有 `messages.read` 时带正文 |
| `message.read` | 核心 | 成员读到了消息 |
| `message.acknowledged` | 核心 | 成员用 `ack_messages` 确认了消息 |
| `member.status` | 核心 | 成员状态变化（`idle`、`busy`、`offline`） |
| `member.joined` | 核心 | 群里加入了一名成员 |
| `member.removed` | 核心 | 成员被移出群 |
| `member.updated` | 核心 | 成员改名、隐身或取消隐身 |
| `member.roles` | 核心 | 成员的角色被修改 |
| `role.changed` | 核心 | 角色被新建、改说明、删除或补齐默认角色 |
| `cluster.updated` | 核心 | 群改名、改分组、置顶、归档、用户已读位置前进，或从回收站恢复 |
| `cluster.paused` | 核心 | 群被暂停或恢复投递 |
| `hub.paused` | 核心（全局） | 用户打开或关闭“暂停全部投递” |
| `delivery.updated` | 核心 | 一条投递的状态变化（不含错误文字） |
| `guard.triggered` | 核心 | 防循环或限速上限被触发 |
| `task.created` | 任务插件 | 新建了任务 |
| `task.submitted` | 任务插件 | 执行者提交了结果 |
| `task.approved` | 任务插件 | 验收通过（自查档在提交时就通过） |
| `task.rejected` | 任务插件 | 验收退回 |
| `task.merged` | 任务插件 | 记录为已合并（批次合并逐任务推送） |
| `task.changed` | 任务插件 | 任务的其他变化（派工、开始、改字段、取消、重开、交接、批次变化等），`action` 写明是哪一种 |
| `task.deleted` | 任务插件 | 任务被删除 |
| `bookmark.saved` | 收藏插件 | 成员收藏了消息或改了收藏标签 |
| `bookmark.removed` | 收藏插件 | 成员取消了收藏 |
| `coordinator.changed` | 协调员插件 | 协调员被设置、更换、停用，或长期要求被修改（事件里没有要求的文字） |

不推的 Hub 事件：成员的原始输出流、Hub 全局设置、账户额度、页面提示，以及群的新建和删除。第三方插件自己发布的类型（`plugin.<id>.<name>`）见下面的“发布”。

事件带完整内容（按字段白名单复制），授予任务事件就等于让插件读到任务的标题、范围、验收标准、意见和提交号。消息正文另需 `messages.read`。事件在事务提交后推送，每个插件一个最多 256 条的队列，满了丢最旧的并在下一条里报告 `dropped`；卡住的插件只丢自己的事件，不拖慢 Hub。事件不补发历史，插件也收不到自己发出的消息事件。

**发布（`events.publish`）**：清单用 `publishes` 声明类型（`name`、`description`、可选 `fields`，最多 32 个），完整类型名固定为 `plugin.<插件 ID>.<name>`。`host.events.publish {type, clusterId?, data}`：带群的事件只能发到授予的读或写群，省略群是全局事件；`data` 最多 16 KiB，Hub 不解释、不保存。每个插件每分钟最多 60 个。发布不产生消息、不唤醒成员，不转给网页和官方插件。订阅者应把 `data` 当不可信输入。

## 命令

清单 `commands` 里每个命令可声明 `description`、带类型的 `params`（`text`、`number`、`duration`、`boolean`、`member`、`enum`，最多 16 个）、`clusterScoped`（默认 `true`）和 `longRunning`。

- **在群里运行**：在授权群（读或写）的输入框开头输入 `/`，从菜单选择命令；有参数时在输入框上方打开表单。命令本身不发到群聊，Enter 只在选中了菜单项或打出完整命令名时运行，其余情况照常当普通消息发送。插件收到 `invoke {command, arguments, context:{clusterId, by:"user", at, runId}}`，参数已由 Hub 检查。
- **长命令**：`longRunning: true` 的命令可以回答 `{accepted:true}`，再用通知 `command.progress {runId,text,fraction?}` 和 `command.done {runId,ok,text?,data?}` 报告进度和结果；用户可以取消（插件申请了 `command.cancel` 时会收到通知）。一次运行最长 30 分钟，每个插件同时最多 4 个，运行只在 Hub 内存里。
- 进度显示在群标题栏的小标签上，结果作为页面提示只给用户看。运行不写群聊、不唤醒成员、不占防循环额度。
- 只有用户（API 令牌）能运行命令：`GET /api/clusters/:id/plugin-commands`、`POST /api/clusters/:id/plugin-commands/run`、`POST /api/clusters/:id/plugin-runs/:runId/cancel`。原有的 `POST /api/plugins/:id/invoke` 不带 `context`、不检查参数。

## 群员工具（`tools.provide`）

插件可以给授权群的群员提供工具。清单 `tools` 声明 `name`、`description`（最多 300 字）和 `inputSchema`（受限的 JSON Schema 子集：顶层对象，属性为 `string`、`number`、`integer`、`boolean` 或这些类型的数组，不支持 `$ref`、`pattern`、嵌套对象等）；登记里的 `tools` 按名字逐个授予，最多 8 个。

- 群员看到的名字是 `p_<插件 ID>_<name>`，说明前带 `(third-party plugin <id>)`。每个工具都会进入群员的工具清单、每次模型调用都占 token，只授予需要的工具。
- Hub 只凭桥给的会话认出调用者，按声明检查参数后发 `tool.call {tool, arguments, context:{clusterId, member, at, callId}}`；插件回答 `{text?, data?}`（最多 16 KiB）。插件回答之后 Hub 再认一次调用者，期间被移出、隐身或换绑的不交回结果（`CALLER_CHANGED`）。
- 上限：10 秒超时（只结束这一次调用）、每个成员每分钟 30 次、每个插件每分钟 120 次、同时 4 个。
- 每次调用（包括被拒绝的）都在群里留一条只有元数据的系统记录：谁、哪个工具、结果码、用时、参数和结果的字节数；**不含参数和结果的内容**。
- 只有在列工具清单时就能认出对话的群员能拿到插件工具：目前是原生 Claude（经 orrery 桥，插件变化时桥发 `list_changed`）和 WorkBuddy（要等应用重新列清单）。Codex、Kimi、ZCode、Qoder、Antigravity、Cursor 和 DeepSeek Harness 暂时拿不到。

## 网页界面与标记（`ui.show`）

清单 `ui.positions` 声明位置，登记的 `ui` 逐个授予：

- `titlebar`：群聊标题栏里的一个标签，点开是面板（高度 `panelHeight`，200～480 像素，默认 320）；
- `workbench`：任务工作台里以插件命名的一个标签页；
- `starmap`：星图 2.0 的插件面板，须单独授权，原有授权不会自动包含它；完整接入步骤见[把插件嵌入星图](starmap-plugins.md)；
- `marks`：在消息、成员和任务上由 orrery 画的小标记，插件只给数据。

**网页**只从插件目录的 `ui/` 提供，入口固定 `ui/index.html`；只认 `.html`、`.css`、`.js`、`.json`、`.svg`、`.png`、`.jpg`、`.webp`、`.woff2`，单个文件最多 1 MiB，整个 `ui/` 最多 200 个文件、4 MiB；路径逐段校验，不跟随链接或联接。页面每次打开界面时由 Hub 生成一个不可猜的界面 ID，地址 `/plugin-ui/<界面 ID>/index.html`，界面关闭、插件停止或重启、授权收回、Hub 重启后立即失效。

框架是 `<iframe sandbox="allow-scripts">`，来源不透明：读不到 cookie、令牌、协作页和存储，调不到 Hub 接口；CSP 只允许从自己的地址前缀加载脚本、样式、图片和字体，禁止 `fetch`、XHR、WebSocket 外连和导航。框架只能经 `postMessage` 与页面通信（`orrery.ready`、`orrery.request` → `orrery.init`、`orrery.theme`、`orrery.language`、`orrery.response`、`orrery.push`；界面语言切换时页面不重新加载，只发 `orrery.language`），页面经认证的接口把请求交给 Hub，Hub 发 `ui.request` 给这个插件的进程（10 秒超时，最多 16 KiB）。orrery 在框外画插件名和“第三方插件”标记，插件去不掉。

- `host.ui.push {clusterId, position?, data}`：推给自己在这个群打开着的界面；
- `host.ui.chip {clusterId, text, state?}`：标题栏标签文字（最多 24 字）和状态点（`running`、`done`、`failed`）；
- `host.ui.mark {clusterId, target, targetId, text, state?, tip?}`：`target` 为 `message`、`member` 或 `task`，文字最多 16 字、说明最多 80 字，状态 `running`、`done`、`failed`、`info`；`text: null` 清除。每个插件在每个目标上一个标记，每群最多 200 个；标记只在内存里，插件停止、群进回收站或 Hub 重启后消失。
- 推送、标签和标记合计每个插件每分钟 120 次。设置页卡片上的“显示网页界面”总开关可以随时移除这个插件的界面和标记。

已知边界：插件进程本身不受限，框架隔离保护的是用户的登录、协作页本身和身份冒充，不防插件把数据发出去；WebRTC 不归 CSP 管，是否被挡住尚未验证。

## 插件配置

清单可以用 `config` 数组（最多 32 项）声明普通偏好：每项有 `name`、`label`、`scope`（`global` 或 `cluster`）、`type`（`text`、`number`、`duration`、`boolean`、`enum`、`member`、`path`、`list`），可选 `description`、`default`、`required`。用户在**设置 → 插件**卡片的“配置”或群聊菜单的“插件配置”里编辑，每个字段标明值的来源，可以“恢复默认”或“清除设置”；数据库只保存显式覆盖，没有覆盖的字段跟随清单默认值。

插件在 `initialize.params.config` 收到当前值（`global`、`clusterDefaults`、按群的 `clusters`），保存后收到 `config.changed {clusterId, revision, values}`，可用 `config.errors` 通知报告字段级问题。配置值和插件报告的原因不写入群聊、事件或日志，随 `npm run backup` 一起备份。密码、令牌等凭据不是支持的字段类型。

## 生命周期

已登记的受限插件可以在设置页卡片上单独**启动、停止、重启**，不用重启 Hub（启动和重启会重新读取登记和清单；读到的登记无效时运行中的插件不停）。卡片还有两个开关：

- **出错后自动重启**（默认关）：10 分钟内最多 3 次（等 2、10、60 秒），累计最多 10 次，之后放弃并写明原因；每次自动重启在插件的群里留一条记录。
- **开发用：文件改动后自动重启**（默认关）：源文件（`.js`、`.mjs`、`.json` 等，不含 `node_modules/`、`data/`）改动约 0.5 秒后重启，有频率和总数上限。

停止时先发 `shutdown`，最多等 `shutdownGraceMs`；Hub 关闭时每个插件最多等 10 秒。状态（`disabled`、`starting`、`ready`、`stopping`、`failed`、`stopped`）经事件流实时更新。只有用户能操作：`POST /api/plugins/:id/start`、`/stop`、`/restart`，`PATCH /api/plugins/:id/lifecycle`。启用开关（`PUT /api/plugins/:id`）只改下次启动；`ORRERY_DISABLED_PLUGINS` 同样适用于第三方插件 ID。

## 完全信任的插件

完全信任插件在 Hub 进程里运行，用官方插件那一套 Hub 侧插槽，能读写 Hub 数据库的全部数据；它出错可能让 Hub 停止工作，防循环上限和“用户能看到每个成员收到了什么”这些保护管不到它。只安装你信任作者的此类插件。示例：[群便签示例](../examples/hub-plugins/trusted-demo/README.md)。

### 登记与确认

用户在 `external-plugins.json` 里手动登记，只写 `manifest` 和 `trust` 两个字段：

```json
{ "plugins": [{ "manifest": "C:/plugins/trusted-demo/orrery-plugin.json", "trust": "full" }] }
```

清单字段：`id`、`version`、`name`、`description`、`details`、`requires`（只能是官方或其他完全信任插件）、`icon`，以及 `hostApi`（插槽接口版本，现在是 `1`）、`hubEntry`（Hub 入口，插件目录内的 `.js`/`.mjs`）和可选的 `webEntry`（网页模块，插件目录某个子文件夹里的 `.js`，这个文件夹不能装着 Hub 入口）。

登记只让设置页多一张标着“完全信任”的卡片。用户点“确认信任…”，对话框说明它的权限、出错的代价和这次确认绑定的入口文件真实路径；确认写进 `<ORRERY_HOME>/plugins.json`。入口路径变了（清单改指别处、目录移动或被链接替换）就要重新确认；同一路径上的文件内容改动不要求重新确认。

| 状态 | 运行什么 |
|---|---|
| 未确认或已撤销 | 什么都不运行：不导入入口，不跑迁移 |
| 已确认，启用开关关着 | 只跑迁移和两个清理钩子（移出成员、永久删除群） |
| 已确认，开关开着 | 全部 |

确认、撤销和开关都在**重启 Hub 后生效**，没有热加载。

### 加载与能用的插槽

Hub 先只看数据决定能否加载（安全模式、确认和路径、依赖），只导入通过的。入口的默认导出是一个函数，收到 `{ hostApi, z }`，返回和官方插件同样形状的对象。可用插槽：`actions`、`prepare`、`prepareRequired`、`queries`、`refs`、`managementActions`、`tools`（名字不能以 `p_` 开头）、`routes`、`messageFields`、`service`、生命周期钩子、`eventSource`、`migrations`。单一提供者的任务视图、协调员视图、信封和 `bridgeRoutes` 不开放。只有插槽形状（`hostApi` 1）承诺稳定，`Store`、`Hub` 的内部方法可能随版本变化。

能诊断出来的加载问题只跳过这个插件和依赖它的插件，Hub 和其他插件照常启动：导入失败、导入和默认导出合计 10 秒内没完成（顶层 `await` 或返回的 promise 一直不结束）、默认导出不对、插槽冲突或不开放、路由不在前缀下、迁移越界或升级前备份失败。原因显示在卡片上（注明代码是否已经运行过）；超时的模块可能半加载地留在进程里，Hub 不再用它。**这项隔离管不到同步阻塞**：插件在导入时或运行中死循环、同步卡住，会卡住整个 Hub（没有看门狗）；它自己的定时器和未处理的 promise 拒绝也可能让 Hub 退出。这时用安全模式启动（见下文）。

- **路由**必须在 `/api/x/<id>/` 下，和别的 `/api/*` 一样要登录。
- **数据库**：表、索引、触发器和视图都以 `x_<id 里的 - 换成 _>_` 开头（例如 `x_trusted_demo_`）。每一步迁移在自己的事务里跑，Hub 前后比较结构：越出前缀就回滚并跳过插件。这只检查结构、不检查数据。这项检查需要 Node 24.10.0 以上；更早的 Node 上有待跑迁移的完全信任插件会被跳过。卸载后表留在数据库里，需要时停掉 Hub 手动删除，并删除 `plugin_migrations` 里这个插件的记录。
- **升级前备份**：数据库有待跑的迁移（核心或任何插件）时，Hub 在第一次改结构之前自动备份到 `<ORRERY_HOME>/backups/`（文件名带 `-pre-upgrade`），见[架构说明](architecture.md#存储与迁移原则)。完全信任插件要升级而备份失败时，只跳过这些插件。
- **永久删除群**：有迁移记录、这次却没加载的插件，它的清理钩子没有运行；结果会写明“这些插件的数据表里可能还留着这个群的数据”，外键阻止删除时返回 409 `PLUGIN_DATA`。

### 网页模块（`webEntry`）

`webEntry` 所在的文件夹由 Hub 在 `/plugin-web/<id>/` 只读提供（只给脚本、样式、JSON、图片和字体，不给 HTML，单个文件最多 1 MiB，不跟随链接，永远不给 Hub 入口）。只有这次启动确认过、加载了、开关开着的插件出现在 `GET /api/plugins` 的 `trustedFrontend` 里，页面只导入这些模块（每个 5 秒内要导入完）。模块导出 `register(host)`，返回 `message`、`composer`、`workbench`、`settings`、`view`、`panel` 六个插槽中用到的那些（见[官方插件](plugins.md#官方网页插槽)与[把插件嵌入星图](starmap-plugins.md)）；`host` 提供 `ui`、`api`、`nameOf`、`command` 和 `onDispose(fn)`。

**撤销信任时**：撤销、关掉开关或安全模式并重启 Hub 后，已经打开的页面会就地卸下这个插件：不再调用它的插槽，移除它经插槽加入的元素，关掉它打开的对话框（用户在里面打的字转进页面自己的只读提示，可复制），调用一次它登记的 `onDispose`。页面顶部显示“刷新页面后彻底生效”，页面不会自己刷新，也不碰没发出的输入；用户点“重新加载”才刷新。刷新之前，插件的模块代码仍在页面内存里，它自己开的定时器、监听器和绕开插槽的改动只能靠它自己的 `onDispose` 清理，所以要彻底停掉它就重新加载页面。

### 安全模式

用 `ORRERY_SAFE_MODE=1` 启动 Hub 时，所有完全信任插件在导入之前就被跳过（`0` 或不设为正常模式，其他值启动报错）。卡片显示“安全模式：这次没有加载”，协作页顶部显示提示。插件把 Hub 弄坏时用它启动，在设置页撤销信任或关掉开关，再去掉这个变量重启。

### 接口

| 接口 | 说明 |
|---|---|
| `GET /api/plugins` | 完全信任插件的行带 `origin: "trusted"` 和 `trust: { state, entry, confirmed, error, tablePrefix, routePrefix, … }`（`state` 为 `loaded`、`unconfirmed`、`path-changed`、`safe-mode`、`failed`），另有 `safeMode`、`trustedFrontend` 和本次启动的 `instance` |
| `PUT /api/plugins/:id/trust` | `{ "trusted": true, "entry": "<卡片显示的入口路径>" }` 确认，`{ "trusted": false }` 撤销；路径和 Hub 此刻解析的不一致时 409 `ENTRY_CHANGED`。只能用用户的 API 令牌 |
| `PUT /api/plugins/:id` | 启用开关，下次启动生效 |
| `GET /plugin-web/<id>/<路径>` | 网页模块的文件，只读 |

## 示例

- [消息计数示例](../examples/hub-plugins/message-counter/README.md)：读取和命令。
- [验收提醒示例](../examples/hub-plugins/review-reminder/README.md)：事件订阅和受限发言。
- [界面示例](../examples/hub-plugins/ui-demo/README.md)：标题栏、工作台、星图 2.0 沙盒面板和标记。
- [群便签示例](../examples/hub-plugins/trusted-demo/README.md)：完全信任插件，带数据表、路由、群员工具和同页网页模块（含星图 `panel` 面板）。

## 当前限制

- 不提供操作系统沙箱、进程树托管、签名市场、自动升级或进程内热加载（“开发用重新加载”是在文件改动后重启进程）。插件自己启动的后代进程须自己回收。
- 新登记的插件和完全信任插件的变化都要重启 Hub。
- 插件工具目前只有原生 Claude 和 WorkBuddy 群员能拿到。
