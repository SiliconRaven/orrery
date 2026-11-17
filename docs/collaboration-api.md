# 协作与任务 API 参考

语言：**中文** | [English](collaboration-api.en.md)

本页列出协作网页使用的实际 HTTP 端点、Bridge 接口以及群员经 `/mcp` 可用的协作工具。所有 `/api/*` 均绑定 `127.0.0.1` 并要求认证（除用于登录换 Cookie 的 `POST /api/session` 外）。

## 网页 HTTP 端点

### 集群、成员与通用控制

| 方法与路径 | 说明 |
|---|---|
| `GET /api/clusters`、`POST /api/clusters` | 列出活跃群（`?deleted=true` 列回收站群）；建群传 `{ name, members }`（成员 `mode` 省略默认 `"native"` 且仅接受 `"native"`；新建原生会话须显式传 `projectPath`，接入已有会话从应用只读读取 `cwd`） |
| `PATCH /api/clusters/:id`、`DELETE /api/clusters/:id` | 修改 `{ category, name, pinned, archived }` 或软删除至回收站 |
| `POST /api/clusters/:id/restore`、`POST /api/clusters/:id/purge` | 从回收站恢复，或凭 `{ name, trashVersion }` 彻底清理集群及无主文件 |
| `POST /api/pause` | 全局暂停/恢复所有集群投递（`{ paused: boolean }`） |
| `POST /api/clusters/:id/members`、`DELETE /api/clusters/:cid/members/:mid` | 向已有集群添加或移除成员 |
| `PATCH /api/members/:id` | 修改成员名称与头像 `{ name, avatar }` |
| `POST /api/members/:id/session`、`GET /api/members/:id/session-history` | 原生成员重绑对话及查看重绑历史 |
| `POST /api/members/:id/hidden` | 用户在网页设置或取消成员隐身（`{ hidden }`） |
| `GET /api/members/:id/handover` | 只读生成成员交接包 |
| `GET/POST/PATCH/DELETE/PUT /api/cluster-groups` | 读、建、改名、删与重排侧栏集群分组（`PUT` 排序） |
| `GET /api/usage`、`GET /api/usage/turns`、`POST /api/usage/refresh` | 额度与用量查询；`/api/usage/turns` **必须同时传 `clusterId` 与 `memberId`**（可选 `limit` 1～100） |
| `GET /api/stream` | 实时 SSE 事件流（支持 `?since=`） |

### 协作工作区、任务、标签与投递诊断

| 方法与路径 | 说明 |
|---|---|
| `GET /api/clusters/:id/workspace` | 读取本群任务（支持 `?holder=`、`?sort=`、`?pageOnly=1`）、业务角色、策略与标签库选择状态 |
| `POST /api/clusters/:id/collaboration` | 提交协作命令：覆盖完整 `task.*`（如 `task.create`、`task.assign`、`task.start`、`task.submit`、`task.review`、`task.merge`、`task.release`、`task.cancel`、`task.reopen`、`task.handoff`、`task.takeover`、`task.set_git_branch`）、`role.*`、`label.*`、`coordinator.*`、`cluster.pause`、`tasks.settings`，以及**用户专属**的 `task.delete`、`task.mark_completed`、`task.mark_merged`、`task.approve` |
| `GET /api/clusters/:id/tasks/:taskId` | 任务详情、派工、提交、验收、历史与依赖（`:taskId` 支持 `#编号`、UUID 或唯一 8+ 位前缀） |
| `GET /api/clusters/:id/tasks/:taskId/context` | 读取任务完整上下文、关联资料及事件 |
| `GET /api/clusters/:id/tasks/:taskId/events/:eventId` | 读取单条协作事件详情与改动字段 |
| `GET /api/clusters/:id/task-repositories` | 列出本群成员关联的 Git 仓库与分支 |
| `GET /api/stalled` | 全局只读：列出所有未暂停群内无活动停滞成员及隐身新工作提示（`stalled` / `hidden_work`） |
| `GET /api/labels`、`POST /api/labels` | 读取或以用户身份修改全局标签库 |
| `GET /api/clusters/:id/task-refs` | 查询或补全 `#编号` 引用任务摘要 |
| `GET /api/clusters/:id/collections` | 查询群资料库收藏 |
| `GET /api/clusters/:id/messages/search` | 按关键词 `q`、发送者 `sender`、类别 `category`、时间区间等检索群聊 |
| `POST /api/clusters/:id/deliveries/:deliveryId/resend`、`.../handoff` | 用户从投递异常重发或转交新会话 |
| `GET /api/clusters/:id/deliveries/:deliveryId/timeline`、`.../messages/:messageId/delivery-timelines` | 查看单条或整条消息的投递时间线诊断 |

## Bridge 协作端点

- **`POST /bridge/ship-verify` 与 `POST /bridge/ship-result`**：由 `scripts/ship.ts` 调用，**通过请求体中的签名 `body.ticket` 自行鉴权**（不要 `x-orrery-bridge`；票据不对返 `403`，状态冲突返 `409`）：
  - `ship-verify` `{ ticket }`：只读**查询**当前获准合并的目标任务详情（`{ taskId, shortId, commitSha, reviewer, round, verdict: "pass" | "self" }`），不提交预合并检查状态。
  - `ship-result` `{ ticket, mergeCommit, pushed, retried? }` 或 `{ ticket, failed: { kind: "conflict" | "checks", detail } }`：上报合并落盘成功或失败诊断，供 Hub 只读核对 Git 祖先并推动进入 `merged` 或退回执行者。
- **`POST /bridge/unread-hint`**：由插件或未读钩子携带 `x-orrery-bridge` 发送 `{ harness, session }`；仍有未读且分项计数相对上次提示有变化时返回 `{ hint }`（4 桶：`mention`、`user`、`broadcast`、`task_notice`，含 `fyi`/`offline`/`failed_or_unknown`/`blocked` 标注），否则返回 `{}`。

## 群员 MCP 工具清单（标准 21 项 / 后台等待 22 项）

`standard` 档成员可见以下 **21 项**工具；后台等待路线（ZCode / Qoder / WorkBuddy）额外开放 `wait_for_messages`，共 **22 项**。任务、标签等协作命令工具须提供 `operationId`；聊天用 `clientMessageId`，确认回执用消息 ID。变更已有任务须带 `get_task` 返回的 `expectedRevision`（`watch` / `unwatch` 除外），协调员管理操作须带 `list_tasks.coordinator.generation`。

### 聊天、确认与等待（6 项 / 7 项）

| 工具名 | 参数与行为 |
|---|---|
| `list_agents` | 列出当前群员、在线状态、角色与工作负荷 |
| `send_message` | 发送群聊消息：`body` 支持 `@名字`、`@all`（仅唤醒同正文显式 `@` 到的人）和 `#编号`；`to: string[]` 指定收件人并把正文 `@` 当普通文字；`replyTo`；`taskIds`；`attachments`（填复制到成员发件箱内的纯文件名，最多 10 个、每个限 20 MB）；`clientMessageId` 幂等去重；`fyi: true` 仅记未读（回答问题时禁设；若 `replyTo` 原提问者仍是正文显式点到的活跃成员，提问者仍被唤醒并返 `fyiOverridden`） |
| `read_messages` | 默认返回本人入群后相关**未读**消息；`history: true` 切历史模式；支持 `before`、`since`、`until`、`q`、`sender`、`mentions`、`category`（`mention`/`user`/`broadcast`/`task_notice`/`receipt_warning`/`warning`）与 `detail`（`summary`/`full`） |
| `skip_unread` | 按 `before`、`until` 或 `category` 将本人未读标为跳过（不写确认回执） |
| `get_deliveries` | 查询 `messageId` 各收件人的投递状态：`status`（`queued`、`running`、`done`、`failed`、`offline`、`superseded`、`blocked`）与 `outcome`（`accepted`、`completed`、`failed`、`unknown`、`null`） |
| `ack_messages` | 传入 `messageIds`（1～100 条）写确认回执（👍），不要额外水聊确认 |
| `wait_for_messages` | 仅后台等待路线开放：签发本对话对应的签名等待命令 |

### 任务、标签、角色与资料库（15 项）

| 工具名 | 参数与行为 |
|---|---|
| `create_task` | 创建任务：`title`、`scope`、`acceptance`、`reviewer`（`{ kind: "user" | "self" }` 或 `{ kind: "member", memberId }`）、`priority`、`mergeRequired`、`requiresApproval`、`dependencyIds`、`executeRoleIds`、`reviewRoleIds`、`memberId`、`labels`、`fileIds`、`operationId` |
| `list_tasks` | 按状态、标签或负责人列出群内任务（含 `coordinator.generation`） |
| `get_task` | 读取任务完整字段、派工/提交/验收记录、`watchers`、`gitBranch` 与 `ship` 提示 |
| `get_task_context` | 按需聚合关联任务及其上游已获批产出摘要 |
| `task_action` | 执行短动作：`edit`、`assign`、`start`、`submit`（**必填 `assignmentId` 与 `summary`**，需要合并时带 `commitSha`）、`review`（**必填 `submissionId`、`verdict: "approve" | "reject"` 与 `reason`**）、`merge`、`release`、`cancel`、`reopen`、`handoff`、`takeover`、`nominate`、`claim`、`set_git_branch`、`watch`、`unwatch`。注：`task_action` 不提供 `block`/`unblock`/`mark_completed`/`mark_merged`（后者仅属于 HTTP `POST /api/clusters/:id/collaboration` 的 `task.*` 命令） |
| `set_task_summary` | 更新任务结构化交付摘要 |
| `raise_attention` / `resolve_attention` | 发起或消除阻塞/需求疑问求助提示 |
| `link_message_tasks` | 将关键聊天消息显式挂载至任务 ID |
| `list_labels` / `manage_labels` | 读取或维护全局标签库与标签组 |
| `manage_roles` | （协调员权限 + `generation`）管理业务角色创建、描述修改、删除与成员指派 |
| `set_cluster_paused` | （协调员权限 + `generation`）暂停/恢复本群投递，或设置成员隐身（`memberId`, `hidden: boolean`） |
| `list_bookmarks` / `bookmark_message` | 读取或收藏消息进群资料库 |

前置版本改变或已失效的完成结果需要重新提交时，先用 `get_task_context` 核对前置产出；`submit.expectedDependencyVersions` 必须声明每个前置任务 ID 到其当前 `approvedSubmissionId` 的映射，否则返回 `DEPENDENCIES_CHANGED`。
