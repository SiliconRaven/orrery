# 成员活动观察

语言：**中文** | [English](activity.en.md)

活动摘要与消息投递状态分开。`GET /api/activity?cluster=<id>` 返回 `{members:[{memberId,activity}]}`，省略集群参数时返回所有活动成员；不存在的集群返回错误。`list_agents` 在所选集群的每个成员上附带同一份 `activity`。DeepSeek Harness 插件提供第一个采集源；其他成员没有采集源时结果为 `unknown`。

`activity` 包含 `state`（`unknown`、`observing`、`stale`、`disconnected`）、`source`、`lastSeenAt`、`lastActivityAt`、`event` 和 `staleAfterMs`。时间为 ISO 字符串或 `null`；`event` 为 `null` 或 `{kind,phase,toolName?}`。`kind` 为 `tool` 或 `turn`；`phase` 为 `requested`、`started`、`finished` 或 `failed`，工具名可能为空。

观察通道的状态、最近响应和最近工具／轮次事件，都不能证明会话全局忙闲或任务完成。

Hub 提供内部观察句柄，只有当前成员且已有投递尝试、发言、明确读取或主动确认等参与记录时才能写入。一个原生会话属于多个群时共用一条采集通道，摘要按有资格的成员分别保存；新成员参与前不复制旧活动。插件先按 Hub 下发的会话名单过滤，再构造只含类别、阶段和短工具标识的事件；不发送参数、输出、正文、错误文本或原始调用 ID。工具名只接受 1～64 位英文字母、数字、下划线、点和连字符，其他名字显示未知。

DeepSeek 普通 `tool/call` 表示请求（`requested`），它先于权限检查，也可能是取消时补记的未执行调用；PTC 子工具的 `started` 表示进入分派。工具结果有明确失败标志时记 `finished` 或 `failed`，找不到名称时留空。轮次的明确完成记 `finished`，错误或中止记 `failed`；其他未知结束原因不推断结果。并发结果可能按模型顺序记录，时间不一定等于工具实际结束时刻。模型思考和是否等待用户不在本次采集范围。

每位成员最多保留一条最新快照；约每 15 秒的心跳覆写响应时间，不改变活动时间或写入历史事件。超过 45 秒未收到响应为 `stale`，连接关闭为 `disconnected`；无当前来源或重启后为 `unknown`。观察来源在每次连接及资格变化时换一个临时标识，旧上报和旧句柄失效；插件断开或停用后不补报遗漏的事件。重启后旧快照只作带原时间的历史，不能凭旧时间判断当前观察在线。
