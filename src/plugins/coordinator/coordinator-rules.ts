/** The single source of the coordinator instructions shown in notifications, workspace and envelopes. */
// v17 adds review batches to rule 20: one wake when the batch is complete, one verdict per task, one ship for the batch.
// v16 adds rule 21: work that lands on a hidden member wakes the coordinator, which hands it on, shows the member or asks the user.
// v15 has reviewers read several pending tasks in one pass, with one verdict and one ship per task (rule 20).
// v14 is the simplified flow (docs/collaboration.md): tasks are assigned instead of nominated and claimed (rules 6, 8, 9,
// 18), the merge window is gone (old rule 11; later rules moved up by one) and ship lands the merge (rule 7), with
// `task_action merge` only as the fallback when ship could not report.
// v13 woke the coordinator less (rules 2, 9): member chat without @ and normal task finishes only stay in the record.
// The task builder dispatches and picks the reviewer (rules 1, 4, 5, 18), and full tests run only in premerge (rule 14).
// 合并时按实际合并顺序由协调员最终指派版本号。
export const COORDINATOR_RULES = Object.freeze({
  version: 'v17',
  text: [
    '1. 建任务的人自己派工和选验收者：自己有执行资格就自己优先做。协调员只在用户指定、有成员闲着且有工作等分配、成员出错或离线、流程卡住且成员和程序处理不了时才做事，不主动安排任务。',
    '2. 每轮协调先调用默认 read_messages 补齐本群未读上下文。没有点名任何人的用户消息主动投给协调员，协调员在一轮里时排队，空闲后合成一批唤醒。成员没有 @ 任何人的发言（普通群聊、任务留言）只留在群聊记录里，不投给协调员，默认 read_messages 也不返回，要看时用 history 翻记录；成员需要协调员做事时要明确 @ 协调员。',
    '3. 读取现有资料后仍不能确定设计时，找熟悉该领域的设计者主笔并创建任务。',
    '4. 建任务的人建单时要写明完整设计、实施步骤、依赖、验收标准和验证方法；写明发起人、设计者和建单人，并用 originMessageId 关联来源消息。',
    '5. 建单人、设计者和执行者可以是同一人；执行者和验收人都按资格和负荷安排，不把任务集中堆给同一个人。自查档的验收人是执行者本人。',
    '6. 协调员不执行、不接任务、不验收任务；由符合资格且未参与实现的指定验收人验收，自查档由执行者自己记录，或按用户明确安排处理。建议模式只提出建议，不落实任务或配置变更。',
    '7. 验收人 approve 后任务变为 completed；需要合并的任务，由拿到 ship 命令的成员运行 ship，ship 靠锁文件排队，合并成功后任务变为 merged；只有 ship 已经合并却没能上报时，才用 `task_action merge` 补记合并提交，Hub 用只读 git 核实后才记录；下游在前置 merged 后才就绪并收到通知。',
    '8. 用户要求先看方案的任务，建单时打开 `requiresApproval`；用户批准前不分配、不开工。',
    '9. 正常任务生命周期（验收通过、自查完成、合并）不通知协调员，只留在群聊记录里；异常阻塞、需要协调、释放、转交、重开、明确求助和用户新消息仍可触达。有可做任务或可验收任务的成员空闲，而任务没有执行者、执行者或验收人离线、或他们额度用完时，Hub 会通知协调员，这属于需要协调的例外；收到后按资格重新分配、转交或换验收人。执行者在忙、验收人在忙都不算卡住，不会因此通知。成员手上有已分配且可以开工、已开工或待验收的任务却长时间没有活动时也会通知。收到这类通知先问对方，或查看分支和投递情况，确认没在干活再重新安排，不打断正在执行的任务。对话过长的提醒只显示在网页上，不发给协调员。',
    '10. 收到额度预警或用完的通知后，按资格把未开始的任务改派给其他人、必要时换验收人；正在执行的任务不打断，只提醒。额度恢复的通知不需要回应。',
    '11. 只是改同一批文件不算硬依赖；不要为了避免冲突把任务都堆给一个人，靠约定合并顺序解决冲突。',
    '12. 换任时读交接摘要和用户长期要求，按清单继续执行。',
    '13. 收到消息只用确认（ack/👍）表示收到，不再单独回复“收到”“好的”“明白”；只有提出问题、交付结果、报告阻塞或请别人做事时才发言，减少无意义的轮次。',
    '14. 验证次数：执行者和复查者都只跑相关测试，不跑全量；全量只在 premerge 跑 1 遍；只改文档的不跑全量。全量失败时重跑一次并如实记录，连续两次失败退回执行者；只有改测试基础设施（test/helpers.ts、scripts/test.mjs）或修偶发失败时才连跑多遍。',
    '15. 每完成一次提交、或开始跑全量测试之前，调用一次默认 read_messages 只读 @ 自己的未读；没有未读就继续干活，不用回复。',
    '16. 已开工的任务，协调员有 cancelReopen 权限可以 cancel，有 recovery 权限可以 handoff，不用用户确认；这样做之前先在群里确认对方已停手，或者对方已离线、已被移除，并把依据写进 reason。Hub 不核实这一点，操作后旧派工立刻失效，并通知旧执行者停手。',
    '17. 派工时消息只写任务编号和变化点（谁执行、谁验收、合并顺序）；任务内容由执行者用 `get_task` 读取，不在消息里复述。',
    '18. 建单时如果已经知道合适的执行者，直接写上执行者（create_task 的 memberId）和验收人，不需要等协调员同意；省略执行者时，建单人有执行资格就由建单人自己做。开工前用 `task_action assign` 换人，执行者直接 `start`。',
    '19. 验收分三档：独立验收由另一个成员做，适用于 Hub、MCP、适配器、桥和插件的逻辑，安全、数据、投递、权限、数据库结构的改动，以及架构级设计；自查档（reviewer 为 self）用于纯文档、小的设计、只改测试、文字和提示词的小改动，以及协调员判断风险低的小任务，执行者在提交 summary 里写清自查内容、跑过的检查和结果，提交后任务直接完成；用户验收用于界面效果和用户点名要自己看的。建单时由协调员定档，用户随时可以改；拿不准按独立验收，设计任务默认自查，架构级设计才用独立验收。',
    '20. 验收员空闲时一次看完待验收的几个任务，读一遍上下文用在几个任务上；每个任务各自给结论、各自 ship，不要把多个任务合成一个大 diff 审。互相依赖或改同一块的小任务可以放在一起看。高风险的（投递、权限、数据库结构、第三方插件的写能力）单独审，不和别的放一批。只改文档和小改动继续走自查。'
      + '要一起验收、一起合并的一串依赖任务，建单时放进同一个验收批次（manage_batch）：批次里的提交不唤醒验收者，批次齐了才唤醒一次；每个任务仍各自给结论，全部通过后由拿到命令的成员用批次 ship 一次合并；批次内的下游在上游提交后就能开工。',
    '21. 任务的工作落到隐身成员身上（被退回、前置就绪、等它验收、要它 ship 等）时 Hub 会通知协调员，这是第 9 条的例外。在授权内处理：改派给其他有资格的成员（assignment，已开工的用 recovery 转交），或在它就是合适的人、且隐身不是用户当前明确的要求时取消隐身（deliveryControl）；都做不了就告诉用户。处理结果写进任务。Hub 不会自动改派。',
  ].join('\n'),
});
