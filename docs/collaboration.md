# 协作与任务流程

语言：**中文** | [English](collaboration.en.md)

协作能力由 `tasks`（`src/plugins/tasks/`）、`coordinator`（`src/plugins/coordinator/`）与 `bookmarks`（`src/plugins/bookmarks/`）三个内置官方插件协同提供。接口字段见 [协作与任务 API](collaboration-api.md)。

## 成员角色与权限

集群内的任务操作受角色约束，用户始终拥有最终控制权：

| 角色 | 说明 |
|---|---|
| `coordinator`（协调员） | 每个群最多启用 1 位协调员，负责统筹、指派、调整验收配置及跟进停滞任务；不得自审代码，也不可兼任同一任务的执行与独立验收工作。 |
| 普通成员 | 领取或被指派任务、推进执行并提交验收；可充当另一位成员任务的独立验收者。 |
| `user`（用户） | 最高裁决者，可直接创建、改派、审批方案、直接通过/退回，或手动标记任务完成/合并。 |

业务角色带名称和说明描述（新建群默认附带“设计者、验收者、执行者”），可按角色限制任务执行或验收资格。

## 任务状态与三档验收

每个任务按群内自增序号 `#<number>`（如 `#1`）标识，主要状态如下（`pending`、`working`、`review`、`completed`、`merged`、`cancelled`）：

```text
pending -> working -> review -> completed -> merged
             ^          |
             +-- reject-+

release -> pending
cancel  -> cancelled
reopen  -> pending
```

> 注：用户方案审批（`requiresApproval` / `proposalState`）、求助阻塞信号（`attention`）以及关注（`watch`）均独立于任务 `status` 状态保存，不混成任务状态。

验收分为三档（建单时由 `reviewer` 指定，省略时默认为用户验收；用户可随时调整）：

1. **成员独立验收（`reviewer: { kind: "member", memberId }`）**：验收者必须不是该任务任何有效派工或提交的参与执行者。执行者提交（`submit`）带摘要（需要合并时须带 7～40 位十六进制 `commitSha`）后进入 `review` 并唤醒验收者；验收通过（`approve`）后若 `mergeRequired: true` 由**验收者**运行 `ship` 合入目标分支并完成 `merged`，无需合并则直接 `completed`。
2. **自查（`reviewer: { kind: "self" }`）**：适用于纯文档、小范围改动、低风险测试或常规设计任务。执行者在 `submit` 的 `summary` 写明检查命令与结果，Hub 在同一事务写入一条标明 `self: true` 的通过记录并直接将任务推进至 `completed`（若 `mergeRequired: true`，则由**执行者**运行 `ship` 完成合并）。任务进入 `review` 后不得再改回自查。
3. **用户验收（`reviewer: { kind: "user" }`）**：适用于界面效果确认或需人工亲自把关的改动。`submit` 后停在 `review` 等用户在界面审批；通过后若需要合并则由**执行者**运行 `ship`（或经网页提交手动标记）。

- **依赖关系**：任务通过 `dependencyIds` 声明前置依赖；所有前置结果有效且 `mergeRequired: true` 的前置均已 `merged` 后，下游任务方可执行。

## 接管（`takeover`）与重开

- **验收者接手（`takeover`）**：仅针对当前处于成员验收档且存在明确成员验收者的任务（在待开工、执行中或待验收状态均可发起，不要求原验收者在线），把执行权移交**给那位原成员验收者**本人（而**不是**改派给任意在线成员）。接管后后续验收人若省略则默认转为 `{ kind: "user" }`（仅在用户发起接管或本群已开启 `takeoverSelfReview` 设置时可指定 `{ kind: "self" }`，否则须指定未参与该任务的其他成员）。
- 若已结束或已取消的任务需要重新处理，可通过 `reopen` 恢复执行流转。

## 消息分级、未读与通知合批

Hub 按发送者与 `@` 形式分别决定谁计入未读、谁被唤醒执行：

| 发送动作 | 谁计入未读 | 谁被唤醒执行 | 说明 |
|---|---|---|---|
| 群员发群聊 `@成员` | 被点名者（`mention`） | 被点名者（除非 `fyi: true`） | 标准点名协作 |
| 群员发群聊 `@all` | 全体在群成员（未显式点名者记 `broadcast`） | **仅正文中显式 `@名字` 点到的成员** | 纯 `@all` 不唤醒任何成员 |
| 群员带 `fyi: true` 发言 | 被点名者 | 一般不唤醒；**例外**：若设了 `replyTo` 且原提问者仍是正文显式点到的活跃成员，则该提问者**仍被唤醒**（结果返回 `fyiOverridden`） | 回答别人问题时禁止设 `fyi: true` |
| 群员发群聊无 `@` | 不计入他人未读（协调员也不计） | 不唤醒 | 仅留群聊历史，可用 `history: true` 查看 |
| 用户未 `@` 发言 | 全群在群成员（`user` 类别） | 按群内路由规则投递 | 无 `@` 时若启用协调员会兜底转协调员 |
| 成员页/MCP 带 `to` 指定发送 | 指定收件人 | 指定收件人 | 忽略正文中 `@` 解析 |
| 已读回执（`ack_messages`） | 原发送者读取历史可见 | 不唤醒、不写系统消息 | 回执（👍）即收到，不为确认单独水聊 |

- **通知合批**：任务进度等系统通知采用 `noticeWindowMs`（2 秒）合批，与常规聊天 `messageWindowMs`（10 秒）错峰；单批上限 `32` 条，每成员每小时通知批数上限 `maxNoticeBatchesPerHour = 300`。
- **工具后未读提示**：合法 MCP 调用末尾及可选 [未读提示钩子](adapters/unread-hook.md) 会按 4 个桶（`mention`、`user`、`broadcast`、`task_notice`）在未读分项计数有变化时展示计数提示。

## 隐身、标签、关注与交接

- **成员隐身（`hiddenAt`）**：隐身**不只是前端隐藏**——Hub 会阻断所有发给隐身成员的消息投递、所有 MCP 工具调用（含读消息）一律只返回提示而不执行任何动作、不可接收新派工或被 `@` 点名，且除用户与启用中的协调员外其他成员不可见；原有消息历史与既有任务仍保留在库中。
- **全局标签库与关注**：跨群维护彩色标签组（`task_label_groups` / `task_labels`）；成员通过 `watch` / `unwatch` 关注关联任务并在结束时收到单条系统提醒。
- **协调员委托权限与交接**：支持配置协调员的 8 项管理开关及空闲/额度告警；成员下线换会话可通过 `GET /api/members/:id/handover` 导出结构化交接摘要。
- **回收站与彻底清理**：删除的集群进回收站，支持 `restore`；`purge` 在事务内彻底删除关联记录及无主文件。
