# 订阅额度与 Token 统计

语言：**中文** | [English](usage.en.md)

orrery 在成员卡片与标题栏汇总各原生群员账号的订阅额度与 token 用量，帮助用户和协调员判断成本与窗口余量。

## 各 Harness 数据来源

| Harness | 订阅额度窗口 | 经 orrery 逐轮 Token | 会话累计 Token |
|---|---|---|---|
| **Claude Code** | 有（短命只读 `get_usage`，受冷却限制） | **无**（桥仅回执送入收件箱，不报轮次结束） | 有（只读 transcript 与子代理文件按 `message.id` 去重） |
| **Codex** | 有（本地最新 `rollout-*.jsonl` `rate_limits`；点刷新才跑只读 `account/rateLimits/read`） | 有（对齐 `turn_token_usage`） | 有（扣减缓存命中统计） |
| **Kimi Code** | 有（本机已核验实例 `GET /api/v1/oauth/usage`，5 分钟自动 / 10 秒刷新冷却） | 有（按 `stepId` 去重） | 有（增量只读 `wire.jsonl`） |
| **DeepSeek Harness** | 不支持（按量计费，不碰用户 API Key） | 有（随 `done` 上报） | 有（投影缓存 `tokenUsage`） |
| **Cursor** | 不支持（不读取带登录令牌的 `state.vscdb`） | 有（`stop` Hook 上报，扣减缓存属推断口径） | 不支持 |
| **ZCode** | 不支持 | 不支持（重挂时尚未结束） | 有（只读副本汇总 `turn_usage`） |
| **WorkBuddy / Qoder / Antigravity** | 不支持 | 不支持 | 不支持 |

- **Antigravity 暂不支持的原因**：公开 `agentapi` 不提供额度接口，额度位于内置语言服务器私有 RPC，orrery 不逆向或调用非公开接口。
- **统计口径**：Cursor 的基础计数已与界面对照；Kimi 和 DeepSeek 已有真实逐轮用量上报。缓存、多工具的细分核算与投递是否成功分开解释。

## 存储、告警区分与隐私

- **结构与落盘**：规范化 `TokenTotals`（`input`、`cachedInput`、`cacheWrite`、`output`、`reasoning`）保存在 `turn_usage` 与 `quota_snapshots`（不同模型不直接横向比价）。
- **两类提醒的区别**：
  - **额度预警/耗尽通知协调员**：启用了 `coordinator` 的集群在任一窗口已用 ≥ 90%（预警）或 ≥ 100%（耗尽）时向协调员发群聊系统通知（用完的成员同时不再作为空闲候选）。
  - **对话长度提醒仅在网页展示**：默认单轮阈值 `20,000,000` token、对话累计阈值 `200,000,000` token（`0` 关闭）。超出时**只在网页成员行与成员页显示换对话建议**，**绝不**发群聊消息、不唤醒协调员、不自动限流或自动生成交接。
- **隐私承诺**：只存聚合计数，不收集或打印提示词与密钥。

## HTTP 查询接口

- `GET /api/usage`：返回各账号最近额度快照与成员累计汇总（可选 `?cluster=<id>`）；
- `GET /api/usage/turns`：**必须同时传递 `clusterId` 与 `memberId`**（可选 `limit` 1～100，默认 10），读取经 orrery 的逐轮用量记录；
- `POST /api/usage/refresh`：在防抖冷却允许下手动刷新支持实时探测的账号额度（如 Codex、Kimi、Claude）。
