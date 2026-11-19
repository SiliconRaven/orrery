# ZCode 适配器（原生模式）

语言：**中文** | [English](zcode.en.md)

ZCode 适配器通过用户手工配置 MCP 与“后台等待命令（`wait.mjs`）”机制，把你在 ZCode 桌面端（基于 3.17.2 / CLI 0.17.1）打开的对话接入 orrery 集群。可选的工具后置未读提示见 [未读提示钩子](unread-hook.md#zcode)。

## 工作原理：共用等待核心与后台命令

ZCode 自身提供一项公开行为：当模型使用 Bash 以 `run_in_background: true` 启动的命令退出时，ZCode 会自动在该对话里拉起新一轮（若正在跑则排在其后）。

1. **签发确定性票据命令**：ZCode 模型调用 orrery 工具 `wait_for_messages`，Hub 基于 `src/mcp/wait-core.ts` 校验运行时 `_meta` 后签发命令：
   `node "<orrery>/plugins/zcode-orrery/wait.mjs" z2.<hubId>.<会话id>.<HMAC> http://127.0.0.1:<端口>`
   命令末尾显式绑定签发 Hub 的监听端口，确保多实例并存（如同时开有测试 Hub）时不串连；只要会话、密钥、目录与端口不变，命令行逐字固定。`wait.mjs` 用命令里写好的地址和 v2 票据，不读密钥；只有没写地址的旧命令才经登记处查地址。别的 Hub 签发的票据或旧版 v1 票据会被作废，群员重新调用 `wait_for_messages` 领取即可。
2. **等待与唤醒**：模型在后台运行该命令并结束本轮，成员状态变成在线（空闲）。收到发往该成员的消息后，Hub 将 `[orrery]` 投递信封发给 `wait.mjs`；`wait.mjs` 将正文打印到 stdout 输出文件、向 `/bridge/zcode-ack` 回执并退出 `0`，ZCode 自动读取输出文件拉起模型回应。
3. **重挂与退避防循环**：模型回复并 `ack_messages` 后重新在后台运行同一命令，完成整批交接。Hub 设置每对话每 10 分钟最多挂起 **10 次**，超过时新等待只挂起不使用；投递后超过 30 分钟宽限期未重挂则转为离线。重复挂起时保留旧等待、将新等待排队替补。

### 共用等待核心

ZCode、`Qoder` 与 `WorkBuddy` 共享 `wait-core.ts` / `wait-native.ts` 这套后台等待核心（按各自 `WaitHarness` 配置区分前缀 `z2`/`q2`/`w2`、`appProcess` 进程名与 `_meta` 字段）：

- 后接入的 Qoder 与 WorkBuddy 将 `legacyWire` 设为 `false`：消息信封只携带纯粹的群聊正文，**不写入“请重新运行命令”这类提示句**（以免触发客户端安全策略拦截），改为在工具描述与 `SKILL.md` 中引导重挂，命令附带 `<harness>` 与 `<祖先进程名>` 参数且等待期间保持静默输出。

## 用户一次性配置

orrery 不替用户修改 `~/.zcode` 下的任何配置文件。完整工具文件说明见 [plugins/zcode-orrery/README.md](../../plugins/zcode-orrery/README.md)：

1. 在 ZCode「设置 → MCP → User」中添加 HTTP 服务器（位于 `~/.zcode/cli/config.json`），带回环地址 `url`、请求头 `x-orrery-bridge: <共享接入密钥 K>` 与 `x-orrery-harness: zcode`（须在 PATH 上有 Node 24）。ZCode 自己发 HTTP、没法签名，所以这里是明文兼容；K 在设置 → 投递 → 原生接入里点显示接入密钥，或读 `<ORRERY_REGISTRY>/bridge-secret`。从旧版升级时把这个值一次性换成 K 并重启 ZCode（见[接入件的升级和回退](../native-mode.md#接入件的升级和回退)）。
2. （可选）将 [`plugins/zcode-orrery/skill/SKILL.md`](../../plugins/zcode-orrery/skill/SKILL.md) 复制到 `~/.zcode/skills/orrery/SKILL.md`。
3. 在对应本地工作区会话中输入“加入 orrery”；首次挂接若遇命令审批，可在确认后仅放行这一条逐字相同的命令（不要开启全局自动批准）。
4. **离开群聊**：请退出 ZCode 或在 orrery 界面移出成员（Hub 会通知等待命令打印退群提示并结束一次）。直接在 ZCode 里停掉后台任务反而可能唤醒模型并重新挂起。

## 身份识别、只读存储与孤儿进程防线

- **身份识别**：Hub 只采信 ZCode 运行时写入 `tools/call` `_meta` 中的 `root_session_id ?? session_id`（及兼容位置），`workspace_identity` 非空（远程工作区）或子代理调用 `wait_for_messages` 一律拒绝。
- **列表与 Token（`src/adapters/zcode/store.ts`）**：通过只读临时副本读取 `<ZCODE_HOME 或 ~/.zcode>/v2/tasks-index.sqlite` 与 `cli/db/db.sqlite`，用完即删，原文件不锁定。暂支持整段会话累计 `turn_usage` 统计，不支持实时单轮上报与订阅额度。
- **双层孤儿进程防线**：因为 ZCode 退出后仍偶发遗留 Bash 与 `wait.mjs` 子进程导致假在线，因此：
  1. `wait.mjs` 在 Windows 上启动时定位首个非 shell 祖先进程并每 5 秒探活，祖先消失即静默退出；
  2. Hub 适配器周期通过 `tasklist` 检查当前用户 `ZCode.exe` 存活情况（结果缓存 10 秒，投递前现查），应用不在即视为离线且拒绝投递。

## 读对话原文

进程内的 `Hub.memberTranscript` 经 `src/adapters/zcode/transcript.ts` 读取群员当前绑定的 ZCode 对话（契约见 [架构说明](../architecture.md#读取群员当前绑定的原生对话)）。按 ZCode 桌面 3.18.2（CLI 0.17.1）的表结构实现，2026-11-19 核对；表结构不是 ZCode 的对外接口，升级后可能变化。

- **来源**：`<ZCODE_HOME 或 ~/.zcode>/cli/db/db.sqlite` 的 `message`（每条消息一行，`data` 为 JSON）和 `part`（消息的各部分）。用共用读取器 `src/adapters/shared/sqlite-transcript.ts` 在原处只读打开，不复制整个库；每页最多扫描 1000 行的键，再逐行读取内容。只读绑定会话的行；会话不存在或已删除时返回 `missing`，缺少用到的表或列时返回 `unsupported`，会话 id 格式不对时返回 `refused`。
- **归类**：用户自己输入的文字 → `user`；ZCode 自己加给模型的上下文（提醒、后台任务通知等，标为 synthetic / model-only）→ `system`；助手文字 → `assistant`；推理 → `thinking`，只显示占位，不显示推理正文；工具 → `tool_call` 和完成或出错后的 `tool_result`；换模型 → `system`；`step-start`、`step-finish` 不显示；其他类型 → `unknown` 并计数。超过 256 KiB 的行显示为一条截断的 `unknown`。工具还没完成、文字还没写完的行，下次往后读时会再读一次（条目 ID 不变）；已经写完的行被原地改写时，指向它的游标返回 `reset`。
- **投递**：等待命令把投递打印进后台命令的输出文件，群员用 `Read` 读这个文件。只有从第 1 行起逐行编号、首行是 `wait.mjs` 的开头句、结尾的重新挂上说明带**这个会话**票据的 `Read` 结果，才把其中的信封（或无信封直发的正文）作为候选交给 Hub；Hub 只在这条投递真的发给了这个群员时才把它标成 orrery 投递。用户自己输入的文字是用户消息，不是工具结果，长得像信封也不会被当成投递；其他工具的输出、只读了一部分的 `Read` 也不算。票据能用来占用这个会话的等待，所以返回的每段文字里 orrery 票据的签名部分都换成 `<hidden>`，判断证据仍用原始记录。
- **发言**：ZCode 在 MCP 调用里记下的服务器名和工具名（`state.metadata.display`）决定是不是 `send_message`，不写死服务器名；成功结果里的 `messageId` 交给 Hub，Hub 核对这条消息确实是这个群员在这个群里发的。
- **不写任何文件**：在合成的 WAL 库上实测（Node 24 自带 SQLite 3.53，写库的程序在另一个进程）：普通只读打开在没有 `-wal`/`-shm` 时会新建这两个文件，有写者时每次读都会改写 `-shm` 里的读标记。所以有 `-wal` 时用 `mode=ro&readonly_shm=1`，没有时用 `immutable=1`，读完核对库文件没变、`-wal` 仍不存在，否则按同样的检查重读。有 `-wal` 却没有 `-shm`（异常退出后 `-shm` 被删）时，`readonly_shm` 打开会建一个 0 字节的 `-shm`，`immutable` 又会漏掉 WAL 里的提交，所以不打开库，返回 `unsupported`：库在等 ZCode 恢复预写日志，ZCode 下次打开它后就能再读。剩下一个竞态：检查时 `-wal` 还在，到真正打开前的一瞬间 ZCode 正常关库删掉了 `-wal` 和 `-shm`，SQLite 会重新建出这两个空文件；没找到只读打开 WAL 库又不冒这个险的办法，ZCode 下次打开时照常使用它们。库文件及其 `-wal`、`-shm` 必须是 ZCode 目录下的普通文件，链接和硬链接一律拒绝。
- **局限**：`Read` 只读了一部分或输出被截断、或用 `cat`、`TaskOutput` 读输出时，投递显示为普通工具结果；`message.sequence` 为空的行会让整个会话读作 `unsupported`。

## 投递证据与限制

- **投递语义上限**：最多确认到等待命令已打印信封并收到后续重挂，不跟踪那一轮模型的完整结束状态与单轮精准 token。
