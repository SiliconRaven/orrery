# 可复现的协作基准

语言：**中文** | [English](evaluation.en.md)

运行 `npm run --silent bench:collaboration`，或直接运行 `node scripts/bench-collaboration.ts`。需要项目现有的 Node 24 和依赖。`--silent` 避免 npm 自己的命令说明混入 JSON。

脚本依次运行三个固定的 mock 场景。每个场景使用独立临时目录、数据库和回环端口，端口避开用户的 4317。复用 `test/helpers.ts` 的测试 Hub、mock worker 和手动释放的等待轮次，Hub 在场景结束时关闭，进程退出时由 helper 清理临时文件。`ORRERY_KEEP_TEST_TEMP=1` 可保留临时现场。

| 场景 | 固定步骤与行为断言 |
|---|---|
| `directed-relay` | 用户通过 HTTP 发给 A，A 通过 MCP 向 B 发 ping，B 通过 MCP 回复 A。检查三条消息的内容和收件人、三次轮次，以及旁观成员没有投递 |
| `paused-batch` | A 的第一轮停在可释放的等待点，开启**全局暂停投递**，写入两条给 A 的消息，释放第一轮。检查两条消息继续排队，恢复后**合并共享同一轮投递**，每条只尝试一次，总计两轮 |
| `task-once` | mock 原生成员通过 MCP 建单、开工和提交，用同一 `operationId` 重复提交。执行者尝试批准自己的结果必须被拒绝，指定验收者通过后检查只有一份提交、一条验收和一条派工 |

标准输出是一个 JSON 对象。`schemaVersion` 为输出格式版本，`passed` 为全部行为断言是否通过，`scenarios` 为各场景的检查项与原始指标。标准错误输出简短的 PASS/FAIL 摘要。行为失败时退出码为 1，成功为 0。

指标中的 `messages` 包含系统通知，`deliveries` 是实际创建的投递数，`turns` 是 mock 适配器收到的轮次调用数，`batches` 是非空投递批次号的去重数量，`maxHop` 是消息的最高跳数。适用场景另外列出 MCP 调用、提交、验收和拒绝次数。随机生成的 ID 只用于验证关联，不写进指标。耗时 `durationMs` 包括测试 Hub 启动、场景执行和关闭，供同一环境下比较，不参与正确性判断。等待操作有超时以报告卡住，超时不是性能合格线。

数据库使用测试 helper 的同步配置，mock 会按固定代码回答。这些结果衡量 Hub 的可重复协作路径与调用开销，不能推导真实模型的任务质量、真实应用的投递可靠性或生产磁盘持久化性能。本脚本不会启动原生应用或调用模型。真实跨 harness 的任务成功率、误操作和成本评测尚未运行。
