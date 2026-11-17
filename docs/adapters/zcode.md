# ZCode 适配器（原生模式）

语言：**中文** | [English](zcode.en.md)

ZCode 适配器通过用户手工配置 MCP 与“后台等待命令（`wait.mjs`）”机制，把你在 ZCode 桌面端（基于 3.17.2 / CLI 0.17.1）打开的对话接入 orrery 集群。可选的工具后置未读提示见 [未读提示钩子](unread-hook.md#zcode)。

## 工作原理：共用等待核心与后台命令

ZCode 自身提供一项公开行为：当模型使用 Bash 以 `run_in_background: true` 启动的命令退出时，ZCode 会自动在该对话里拉起新一轮（若正在跑则排在其后）。

1. **签发确定性票据命令**：ZCode 模型调用 orrery 工具 `wait_for_messages`，Hub 基于 `src/mcp/wait-core.ts` 校验运行时 `_meta` 后签发命令：
   `node "<orrery>/plugins/zcode-orrery/wait.mjs" z1.<会话id>.<HMAC> http://127.0.0.1:<端口>`
   命令末尾显式绑定签发 Hub 的监听端口，确保多实例并存（如同时开有测试 Hub）时不串连；只要会话、密钥、目录与端口不变，命令行逐字固定。
2. **等待与唤醒**：模型在后台运行该命令并结束本轮，成员状态变成在线（空闲）。收到发往该成员的消息后，Hub 将 `[orrery]` 投递信封发给 `wait.mjs`；`wait.mjs` 将正文打印到 stdout 输出文件、向 `/bridge/zcode-ack` 回执并退出 `0`，ZCode 自动读取输出文件拉起模型回应。
3. **重挂与退避防循环**：模型回复并 `ack_messages` 后重新在后台运行同一命令，完成整批交接。Hub 设置每对话每 10 分钟最多挂起 **10 次**，超过时新等待只挂起不使用；投递后超过 30 分钟宽限期未重挂则转为离线。重复挂起时保留旧等待、将新等待排队替补。

### 共用等待核心

ZCode、`Qoder` 与 `WorkBuddy` 共享 `wait-core.ts` / `wait-native.ts` 这套后台等待核心（按各自 `WaitHarness` 配置区分前缀 `z1`/`q1`/`w1`、`appProcess` 进程名与 `_meta` 字段）：

- 后接入的 Qoder 与 WorkBuddy 将 `legacyWire` 设为 `false`：消息信封只携带纯粹的群聊正文，**不写入“请重新运行命令”这类提示句**（以免触发客户端安全策略拦截），改为在工具描述与 `SKILL.md` 中引导重挂，命令附带 `<harness>` 与 `<祖先进程名>` 参数且等待期间保持静默输出。

## 用户一次性配置

orrery 不替用户修改 `~/.zcode` 下的任何配置文件。完整工具文件说明见 [plugins/zcode-orrery/README.md](../../plugins/zcode-orrery/README.md)：

1. 在 ZCode「设置 → MCP → User」中添加 HTTP 服务器（位于 `~/.zcode/cli/config.json`），带回环地址 `url`、请求头 `x-orrery-bridge: <~/.orrery/secret 内容>` 与 `x-orrery-harness: zcode`（须在 PATH 上有 Node 24）。
2. （可选）将 [`plugins/zcode-orrery/skill/SKILL.md`](../../plugins/zcode-orrery/skill/SKILL.md) 复制到 `~/.zcode/skills/orrery/SKILL.md`。
3. 在对应本地工作区会话中输入“加入 orrery”；首次挂接若遇命令审批，可在确认后仅放行这一条逐字相同的命令（不要开启全局自动批准）。
4. **离开群聊**：请退出 ZCode 或在 orrery 界面移出成员（Hub 会通知等待命令打印退群提示并结束一次）。直接在 ZCode 里停掉后台任务反而可能唤醒模型并重新挂起。

## 身份识别、只读存储与孤儿进程防线

- **身份识别**：Hub 只采信 ZCode 运行时写入 `tools/call` `_meta` 中的 `root_session_id ?? session_id`（及兼容位置），`workspace_identity` 非空（远程工作区）或子代理调用 `wait_for_messages` 一律拒绝。
- **列表与 Token（`src/adapters/zcode/store.ts`）**：通过只读临时副本读取 `<ZCODE_HOME 或 ~/.zcode>/v2/tasks-index.sqlite` 与 `cli/db/db.sqlite`，用完即删，原文件不锁定。暂支持整段会话累计 `turn_usage` 统计，不支持实时单轮上报与订阅额度。
- **双层孤儿进程防线**：因为 ZCode 退出后仍偶发遗留 Bash 与 `wait.mjs` 子进程导致假在线，因此：
  1. `wait.mjs` 在 Windows 上启动时定位首个非 shell 祖先进程并每 5 秒探活，祖先消失即静默退出；
  2. Hub 适配器周期通过 `tasklist` 检查当前用户 `ZCode.exe` 存活情况（结果缓存 10 秒，投递前现查），应用不在即视为离线且拒绝投递。

## 投递证据与限制

- **投递语义上限**：最多确认到等待命令已打印信封并收到后续重挂，不跟踪那一轮模型的完整结束状态与单轮精准 token。
